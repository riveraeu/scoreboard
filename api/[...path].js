import { ALLOWED_ORIGIN, corsHeaders, jsonResponse, errorResponse, parseGameOdds, parseGameScores, buildSoftTeamAbbrs, buildHardTeamAbbrs, buildTeamRankMap } from "./lib/utils.js";
import { PARK_KFACTOR, PARK_HITFACTOR, PARK_RUNFACTOR, UMPIRE_KFACTOR, log5K, poissonCDF, log5HitRate, simulateKsDist, kDistPct, simulateKs, buildNbaStatDist, nbaDistPct, simulateHits, simulateMLBTotalDist, simulateNBATotalDist, simulateNHLTotalDist, totalDistPct, simulateTeamTotalDist, simulateTeamPtsDist, decimalOdds, kellyFraction, evPerUnit } from "./lib/simulate.js";
import { buildLineupKPct, buildBarrelPct, buildPitcherKPct, MLB_ID_TO_ABBR } from "./lib/mlb.js";
import { warmPlayerInfoCache, buildNbaDvpStage1, buildNbaDvpFromBettingPros, buildNbaDepthChartPos, buildNbaPaceData, buildNbaPlayerPosFromSleeper, buildNbaDvpStage3FG, buildNbaUsageRate, buildNbaInjuryReport } from "./lib/nba.js";

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
function makeCache(env) {
  if (env?.CACHE) return env.CACHE;
  if (env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) {
    const url = env.UPSTASH_REDIS_REST_URL;
    const auth = `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`;
    const cmd = /* @__PURE__ */ __name((...args) => fetch(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(args)
    }).then((r) => r.json()).then((body) => {
      if (body?.error) console.error("[upstash]", args[0], body.error);
      return body;
    }).catch(() => ({ result: null })), "cmd");
    return {
      async get(key, type) {
        const { result } = await cmd("GET", key);
        if (result == null) return null;
        if (type === "json") {
          try {
            return JSON.parse(result);
          } catch {
            return null;
          }
        }
        return result;
      },
      async put(key, value, opts = {}) {
        const v = typeof value === "string" ? value : JSON.stringify(value);
        const args = ["SET", key, v];
        if (opts.expirationTtl) args.push("EX", opts.expirationTtl);
        await cmd(...args);
      },
      async delete(key) {
        await cmd("DEL", key);
      }
    };
  }
  try { return CACHE || null; } catch { return null; }
}
__name(makeCache, "makeCache");
var normName = /* @__PURE__ */ __name((s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(), "normName");
var ESPN_BASE = "https://site.web.api.espn.com/apis";
var ESPN_CORE = "https://sports.core.api.espn.com/v2/sports";
var VALID_SPORTS = [
  "basketball/nba",
  "football/nfl",
  "baseball/mlb",
  "hockey/nhl",
  "basketball/mens-college-basketball",
  "football/college-football"
];
async function pbkdf2Hash(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 1e5, hash: "SHA-256" }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
__name(pbkdf2Hash, "pbkdf2Hash");
async function makeJWT(payload, secret) {
  const enc = new TextEncoder();
  const h = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=+$/, "");
  const b = btoa(JSON.stringify(payload)).replace(/=+$/, "");
  const msg = `${h}.${b}`;
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${msg}.${sigB64}`;
}
__name(makeJWT, "makeJWT");
async function verifyJWT(token, secret) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const enc = new TextEncoder();
    const msg = `${parts[0]}.${parts[1]}`;
    const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", k, sig, enc.encode(msg));
    if (!valid) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
__name(verifyJWT, "verifyJWT");
var worker_default = {
  // Daily crons (DvP build — KV reads are free, so state passes between stages via KV):
  //   17:00 UTC (9am PST):  Stage 1 — fetch teams+rosters (31 req), cache posMap to KV; warm player info
  //   20:00 UTC (12pm PST): Stage 2 — fetch BettingPros DvP page (1 req) → all positions cached
  //   23:00 UTC (3pm PST):  Stage 3 — retry Stage 2 if failed; gamelog fallback if BP blocked
  //   01:00 UTC (5pm PST):  Stage 4 — final refresh; retry BettingPros or gamelog fallback
  async scheduled(event, env, ctx) {
    const cache = makeCache(env);
    const hour = new Date(event.scheduledTime).getUTCHours();
    const clearPlayCache = /* @__PURE__ */ __name(async () => {
      const todayKey = `tonight:plays:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
      await Promise.all([
        cache.delete(todayKey).catch(() => {
        }),
        cache.delete("byteam:mlb").catch(() => {
        })
      ]);
      await warmPlayerInfoCache(cache);
    }, "clearPlayCache");
    if (hour === 17) {
      ctx.waitUntil(Promise.all([buildNbaDvpStage1(cache), warmPlayerInfoCache(cache)]).then(clearPlayCache));
    } else if (hour === 20) {
      ctx.waitUntil(buildNbaDvpFromBettingPros(cache).then(clearPlayCache));
    } else if (hour === 23) {
      ctx.waitUntil(buildNbaDvpFromBettingPros(cache).then((r) => r || buildNbaDvpStage3FG(cache)).then(clearPlayCache));
    } else if (hour === 1) {
      ctx.waitUntil(buildNbaDvpFromBettingPros(cache).then((r) => r || buildNbaDvpStage3FG(cache)).then(clearPlayCache));
    }
  },
  async fetch(request, env, ctx) {
    const CACHE2 = makeCache(env);
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    const path = url.pathname.replace(/^\/api\//, "").replace(/^\//, "");
    const params = url.searchParams;
    const method = request.method;
    const JWT_SECRET = env?.JWT_SECRET;
    try {
      if (path === "auth/register" && method === "POST") {
        const { email, password } = await request.json();
        if (!email || !password) return errorResponse("Email and password required", 400);
        if (password.length < 8) return errorResponse("Password must be at least 8 characters", 400);
        const emailKey = `user:${email.toLowerCase()}`;
        if (await CACHE2.get(emailKey)) return errorResponse("Account already exists", 409);
        const userId = crypto.randomUUID();
        const salt = crypto.randomUUID();
        const passwordHash = await pbkdf2Hash(password, salt);
        await CACHE2.put(emailKey, JSON.stringify({ id: userId, email, passwordHash, salt }));
        const token = await makeJWT({ userId, email, exp: Date.now() + 365 * 24 * 60 * 60 * 1e3 }, JWT_SECRET);
        return jsonResponse({ token, userId, email });
      } else if (path === "keepalive") {
        if (CACHE2) await CACHE2.put("keepalive", new Date().toISOString(), { expirationTtl: 172800 });
        return jsonResponse({ ok: true, ts: new Date().toISOString() });
      } else if (path === "auth/debug-redis" && method === "GET") {
        const debugAdminKey = (request.headers.get("Authorization") || "").replace("Bearer ", "");
        if (debugAdminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
        const upUrl = env?.UPSTASH_REDIS_REST_URL;
        const upToken = env?.UPSTASH_REDIS_REST_TOKEN;
        if (!upUrl) return errorResponse("UPSTASH_REDIS_REST_URL not set", 500);
        const upAuth = `Bearer ${upToken}`;
        const testKey = "debug:redis:test";
        const testVal = `ok-${Date.now()}`;
        let setRaw = null, getRaw = null, setStatus = null, getStatus = null;
        try {
          const setRes = await fetch(upUrl, { method: "POST", headers: { Authorization: upAuth, "Content-Type": "application/json" }, body: JSON.stringify(["SET", testKey, testVal, "EX", 60]) });
          setStatus = setRes.status;
          setRaw = await setRes.json();
        } catch (e) { setRaw = { fetchError: String(e) }; }
        try {
          const getRes = await fetch(upUrl, { method: "POST", headers: { Authorization: upAuth, "Content-Type": "application/json" }, body: JSON.stringify(["GET", testKey]) });
          getStatus = getRes.status;
          getRaw = await getRes.json();
        } catch (e) { getRaw = { fetchError: String(e) }; }
        return jsonResponse({ setStatus, setRaw, getStatus, getRaw, expectedVal: testVal, match: getRaw?.result === testVal });
      } else if (path === "auth/list-users" && method === "GET") {
        const listAdminKey = (request.headers.get("Authorization") || "").replace("Bearer ", "");
        if (listAdminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
        const upUrl = env?.UPSTASH_REDIS_REST_URL;
        const upAuth = `Bearer ${env?.UPSTASH_REDIS_REST_TOKEN}`;
        if (!upUrl) return errorResponse("No Redis URL", 500);
        const r = await fetch(upUrl, { method: "POST", headers: { Authorization: upAuth, "Content-Type": "application/json" }, body: JSON.stringify(["KEYS", "user:*"]) });
        const { result } = await r.json();
        return jsonResponse({ users: result || [] });
      } else if (path === "auth/calibration" && method === "GET") {
        const calibToken = (request.headers.get("Authorization") || "").replace("Bearer ", "");
        const calibPayload = calibToken ? await verifyJWT(calibToken, JWT_SECRET) : null;
        const calibAdminKey = params.get("adminKey");
        if (!calibPayload && calibAdminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
        const upUrl = env?.UPSTASH_REDIS_REST_URL;
        const upAuth = `Bearer ${env?.UPSTASH_REDIS_REST_TOKEN}`;
        if (!upUrl) return errorResponse("No Redis URL", 500);
        // Scan all picks keys
        const keysRes = await fetch(upUrl, { method: "POST", headers: { Authorization: upAuth, "Content-Type": "application/json" }, body: JSON.stringify(["KEYS", "picks:*"]) });
        const { result: picksKeys } = await keysRes.json();
        if (!picksKeys || picksKeys.length === 0) return jsonResponse({ totalPicks: 0, finalizedPicks: 0, overall: [], byCategory: {} });
        // Fetch all picks records in parallel
        const allPicks = [];
        await Promise.all((picksKeys || []).map(async key => {
          const data = await CACHE2.get(key, "json").catch(() => null);
          (data?.picks || []).forEach(p => allPicks.push(p));
        }));
        const finalized = allPicks.filter(p => p.result === "won" || p.result === "lost");
        // Group by truePct bucket
        const _buckets = [
          { label: "70-75", min: 70, max: 75 },
          { label: "75-80", min: 75, max: 80 },
          { label: "80-85", min: 80, max: 85 },
          { label: "85-90", min: 85, max: 90 },
          { label: "90-95", min: 90, max: 95 },
          { label: "95+",   min: 95, max: 101 },
        ];
        const overall = _buckets.map(b => {
          const inBucket = finalized.filter(p => (p.truePct ?? 0) >= b.min && (p.truePct ?? 0) < b.max);
          const wins = inBucket.filter(p => p.result === "won").length;
          return {
            bucket: b.label,
            predicted: (b.min + Math.min(b.max, 100)) / 2,
            actual: inBucket.length > 0 ? parseFloat((wins / inBucket.length * 100).toFixed(1)) : null,
            n: inBucket.length,
            delta: inBucket.length > 0 ? parseFloat((wins / inBucket.length * 100 - (b.min + Math.min(b.max, 100)) / 2).toFixed(1)) : null,
          };
        });
        // By sport|stat category
        const _cats = {};
        for (const p of finalized) {
          const cat = `${p.sport || "?"}|${p.stat || "?"}`;
          if (!_cats[cat]) _cats[cat] = { wins: 0, n: 0 };
          _cats[cat].n++;
          if (p.result === "won") _cats[cat].wins++;
        }
        const byCategory = Object.fromEntries(
          Object.entries(_cats).map(([cat, d]) => [cat, {
            hitRate: parseFloat((d.wins / d.n * 100).toFixed(1)),
            n: d.n,
          }])
        );
        // MLB strikeout-specific breakdowns for model calibration
        const ksFinalized = finalized.filter(p => p.sport === "mlb" && p.stat === "strikeouts");
        const _bySimScore = {};
        for (const p of ksFinalized) {
          const sc = p.finalSimScore ?? p.simScore;
          if (sc == null) continue;
          const key = String(sc);
          if (!_bySimScore[key]) _bySimScore[key] = { wins: 0, n: 0 };
          _bySimScore[key].n++;
          if (p.result === "won") _bySimScore[key].wins++;
        }
        const bySimScore = Object.fromEntries(
          Object.entries(_bySimScore).sort((a, b) => Number(a[0]) - Number(b[0])).map(([sc, d]) => [sc, {
            hitRate: parseFloat((d.wins / d.n * 100).toFixed(1)), n: d.n,
          }])
        );
        const _byKpctPts = {};
        for (const p of ksFinalized) {
          const key = String(p.kpctPts ?? "null");
          if (!_byKpctPts[key]) _byKpctPts[key] = { wins: 0, n: 0 };
          _byKpctPts[key].n++;
          if (p.result === "won") _byKpctPts[key].wins++;
        }
        const byKpctPts = Object.fromEntries(
          Object.entries(_byKpctPts).map(([k, d]) => [k, {
            hitRate: parseFloat((d.wins / d.n * 100).toFixed(1)), n: d.n,
          }])
        );
        const _byKTrendPts = {};
        for (const p of ksFinalized) {
          const key = String(p.kTrendPts ?? "null");
          if (!_byKTrendPts[key]) _byKTrendPts[key] = { wins: 0, n: 0 };
          _byKTrendPts[key].n++;
          if (p.result === "won") _byKTrendPts[key].wins++;
        }
        const byKTrendPts = Object.fromEntries(
          Object.entries(_byKTrendPts).map(([k, d]) => [k, {
            hitRate: parseFloat((d.wins / d.n * 100).toFixed(1)), n: d.n,
          }])
        );
        const _byStdBF = {};
        for (const p of ksFinalized) {
          const bf = p.stdBF ?? 0;
          const key = bf === 0 ? "none" : bf <= 2.5 ? "low" : "high";
          if (!_byStdBF[key]) _byStdBF[key] = { wins: 0, n: 0 };
          _byStdBF[key].n++;
          if (p.result === "won") _byStdBF[key].wins++;
        }
        const byStdBF = Object.fromEntries(
          Object.entries(_byStdBF).map(([k, d]) => [k, {
            hitRate: parseFloat((d.wins / d.n * 100).toFixed(1)), n: d.n,
          }])
        );
        // Per-category truePct bucket breakdown (same 6 buckets as overall, filtered per sport|stat)
        const _byCatDetail = {};
        for (const p of finalized) {
          const cat = `${p.sport || "?"}|${p.stat || "?"}`;
          const b = _buckets.find(bk => (p.truePct ?? 0) >= bk.min && (p.truePct ?? 0) < bk.max);
          if (!b) continue;
          if (!_byCatDetail[cat]) _byCatDetail[cat] = {};
          if (!_byCatDetail[cat][b.label]) _byCatDetail[cat][b.label] = { wins: 0, n: 0 };
          _byCatDetail[cat][b.label].n++;
          if (p.result === "won") _byCatDetail[cat][b.label].wins++;
        }
        const byCategoryDetail = Object.fromEntries(
          Object.entries(_byCatDetail).map(([cat, buckets]) => [cat,
            _buckets.map(b => {
              const d = buckets[b.label] || { wins: 0, n: 0 };
              const predicted = (b.min + Math.min(b.max, 100)) / 2;
              const actual = d.n > 0 ? parseFloat((d.wins / d.n * 100).toFixed(1)) : null;
              return { bucket: b.label, predicted, actual, n: d.n, delta: actual != null ? parseFloat((actual - predicted).toFixed(1)) : null };
            })
          ])
        );
        return jsonResponse({ totalPicks: allPicks.length, finalizedPicks: finalized.length, overall, byCategory, byCategoryDetail, kStrikeouts: { bySimScore, byKpctPts, byKTrendPts, byStdBF, n: ksFinalized.length } });
      } else if (path === "auth/reset" && method === "POST") {
        const { email, newPassword, adminKey } = await request.json();
        if (adminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
        if (!email || !newPassword) return errorResponse("Email and newPassword required", 400);
        const emailKey = `user:${email.toLowerCase()}`;
        const userStr = await CACHE2.get(emailKey);
        if (!userStr) return errorResponse("Account not found", 404);
        const user = JSON.parse(userStr);
        const newSalt = crypto.randomUUID();
        const newHash = await pbkdf2Hash(newPassword, newSalt);
        await CACHE2.put(emailKey, JSON.stringify({ ...user, passwordHash: newHash, salt: newSalt }));
        return jsonResponse({ ok: true });
      } else if (path === "auth/login" && method === "POST") {
        const { email, password } = await request.json();
        const userStr = await CACHE2.get(`user:${email.toLowerCase()}`);
        if (!userStr) return errorResponse("Invalid credentials", 401);
        const user = JSON.parse(userStr);
        const hash = await pbkdf2Hash(password, user.salt);
        if (hash !== user.passwordHash) return errorResponse("Invalid credentials", 401);
        const token = await makeJWT({ userId: user.id, email: user.email, exp: Date.now() + 365 * 24 * 60 * 60 * 1e3 }, JWT_SECRET);
        return jsonResponse({ token, userId: user.id, email: user.email });
      } else if (path === "user/picks" && method === "GET") {
        const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
        const payload = await verifyJWT(token, JWT_SECRET);
        if (!payload) return errorResponse("Unauthorized", 401);
        const data = await CACHE2.get(`picks:${payload.userId}`, "json");
        return jsonResponse(data || { picks: [], bankroll: 1e3 });
      } else if (path === "user/picks" && method === "POST") {
        const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
        const payload = await verifyJWT(token, JWT_SECRET);
        if (!payload) return errorResponse("Unauthorized", 401);
        const body = await request.json();
        await CACHE2.put(`picks:${payload.userId}`, JSON.stringify({ picks: body.picks || [], bankroll: body.bankroll || 1e3 }));
        return jsonResponse({ ok: true });
      } else if (path === "headshot") {
        const hsId = params.get("id");
        const hsLeague = params.get("sport") || "nba";
        const imgUrl = `https://a.espncdn.com/i/headshots/${hsLeague}/players/full/${hsId}.png`;
        const imgRes = await fetch(imgUrl, { headers: { "Referer": "https://www.espn.com/" } });
        if (!imgRes.ok) return errorResponse("Image not found", 404);
        const blob = await imgRes.arrayBuffer();
        return new Response(blob, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN
          }
        });
      } else if (path === "debug-search") {
        const q = params.get("q") || "eric lauer";
        const sport = params.get("sport") || "mlb";
        const hdrs = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://www.espn.com/", "Accept": "application/json" };
        try {
          const r = await fetch(`${ESPN_BASE}/search/v2?query=${encodeURIComponent(q)}&lang=en&region=us&limit=5&type=player`, { headers: hdrs });
          const text = await r.text();
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
          }
          const players = (parsed?.results?.find((x) => x.type === "player")?.contents || []).filter((p) => p.defaultLeagueSlug === sport);
          return jsonResponse({ status: r.status, ok: r.ok, sport, rawLength: text.length, preview: text.slice(0, 500), playersFound: players.length, firstPlayer: players[0] || null });
        } catch (e) {
          return jsonResponse({ error: String(e) });
        }
      } else if (path === "warm-cache") {
        ctx.waitUntil(warmPlayerInfoCache(CACHE2 ? makeCache(env) : null));
        return jsonResponse({ ok: true, message: "warmPlayerInfoCache started in background" });
      } else if (path === "athletes") {
        const q = params.get("q") || "";
        const SUPPORTED = [
          { sport: "basketball", league: "nba" },
          { sport: "football", league: "nfl" },
          { sport: "baseball", league: "mlb" },
          { sport: "hockey", league: "nhl" }
        ];
        const searchUrl = `${ESPN_BASE}/search/v2?query=${encodeURIComponent(q)}&lang=en&region=us&limit=20&type=player`;
        const res = await fetch(searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
        });
        if (!res.ok) return errorResponse(`ESPN returned ${res.status}`, res.status);
        const data = await res.json();
        const contents = (data.results?.find((r) => r.type === "player")?.contents || []).filter((a) => SUPPORTED.some((s) => s.sport === a.sport && s.league === a.defaultLeagueSlug)).slice(0, 10);
        const items = await Promise.all(contents.map(async (a) => {
          const athleteId = a.uid?.split("~a:")?.[1] || a.id;
          const sportSlug = a.sport;
          const leagueSlug = a.defaultLeagueSlug;
          let teamId = "";
          let teamAbbr = "";
          try {
            const ar = await fetch(`${ESPN_CORE}/${sportSlug}/leagues/${leagueSlug}/athletes/${athleteId}`, {
              headers: { "User-Agent": "Mozilla/5.0" }
            });
            if (ar.ok) {
              const ad = await ar.json();
              const ref = ad.team?.["$ref"] || "";
              const m = ref.match(/\/teams\/(\d+)/);
              if (m) teamId = m[1];
              if (ref) {
                const tr = await fetch(ref, { headers: { "User-Agent": "Mozilla/5.0" } });
                if (tr.ok) { const td = await tr.json(); if (td.abbreviation) teamAbbr = td.abbreviation; }
              }
            }
          } catch {
          }
          if (!teamAbbr) {
            const rawSubtitle = a.subtitle || "";
            const firstWord = rawSubtitle.split(/[\s·\-]+/)[0].toUpperCase();
            teamAbbr = /^[A-Z]{2,4}$/.test(firstWord) ? firstWord : rawSubtitle;
          }
          return {
            id: athleteId,
            name: a.displayName,
            team: teamAbbr,
            teamId,
            league: leagueSlug,
            sportKey: `${sportSlug}/${leagueSlug}`
          };
        }));
        return jsonResponse({ items: items.filter((a) => a.id && a.name) });
      } else if (path === "gamelog") {
        const sport = params.get("sport") || "basketball/nba";
        const athleteId = params.get("athleteId");
        if (!athleteId) return errorResponse("athleteId required");
        const leagueSlug = sport.split("/")[1];
        const year = params.get("season") || params.get("year") || "";
        const currentYear = (/* @__PURE__ */ new Date()).getFullYear();
        const isPastSeason = year && parseInt(year) < currentYear;
        // MLB: use ESPN JSON API directly (same source as tonight endpoint) for full game history
        if (sport === "baseball/mlb") {
          const mlbApiUrl = `https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${athleteId}/gamelog${year ? `?season=${year}` : ""}`;
          const mlbRes = await fetch(mlbApiUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "application/json",
              "Accept-Language": "en-US,en;q=0.9",
              "Referer": "https://www.espn.com/",
              "Origin": "https://www.espn.com"
            }
          });
          if (!mlbRes.ok) return errorResponse(`ESPN MLB API returned ${mlbRes.status}`, mlbRes.status);
          const d = await mlbRes.json();
          const labels = d.labels || [];
          const reg = (d.seasonTypes || []).find((st) => { const dn = (st.displayName || "").toLowerCase(); return dn.includes("regular") && !dn.includes("play"); }) || (d.seasonTypes || []).find((st) => st.displayName?.toLowerCase().includes("regular")) || d.seasonTypes?.[0];
          const seenIds = /* @__PURE__ */ new Set();
          const allEvents = [];
          for (const cat of reg?.categories || []) {
            for (const ev of cat.events || []) {
              if (seenIds.has(ev.eventId)) continue;
              const meta = d.events?.[ev.eventId];
              if (!meta || meta.opponent?.isAllStar) continue;
              seenIds.add(ev.eventId);
              allEvents.push({
                eventId: ev.eventId,
                stats: ev.stats || [],
                date: meta.date || (meta.gameDate ? meta.gameDate.slice(0, 10) : null),
                oppAbbr: meta.opponent?.abbreviation || null,
                isHome: meta.atVs != null ? meta.atVs !== "@" : null
              });
            }
          }
          return jsonResponse({ labels, events: allEvents, totalGames: allEvents.length }, isPastSeason ? 86400 : 14400);
        }
        // Use ESPN JSON API (same as MLB) — HTML scraping blocked by WAF
        const sportPath = { "basketball/nba": "basketball/nba", "hockey/nhl": "hockey/nhl", "football/nfl": "football/nfl" }[sport] || `${sport.split("/")[0]}/${leagueSlug}`;
        const jsonApiUrl = `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/athletes/${athleteId}/gamelog${year ? `?season=${year}` : ""}`;
        const jsonRes = await fetch(jsonApiUrl, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": "https://www.espn.com/" }
        });
        if (!jsonRes.ok) return errorResponse(`ESPN API returned ${jsonRes.status}`, jsonRes.status);
        const d = await jsonRes.json();
        const labels = d.labels || [];
        const reg = (d.seasonTypes || []).find(st => { const dn = (st.displayName || "").toLowerCase(); return dn.includes("regular") && !dn.includes("play"); }) || (d.seasonTypes || []).find(st => st.displayName?.toLowerCase().includes("regular")) || d.seasonTypes?.[0];
        const seenIds = new Set();
        const allEvents = [];
        for (const cat of reg?.categories || []) {
          for (const ev of cat.events || []) {
            if (seenIds.has(ev.eventId)) continue;
            const meta = d.events?.[ev.eventId];
            if (!meta || meta.opponent?.isAllStar) continue;
            seenIds.add(ev.eventId);
            allEvents.push({
              eventId: ev.eventId,
              stats: ev.stats || [],
              date: meta.gameDate ? meta.gameDate.slice(0, 10) : (meta.date || null),
              oppAbbr: meta.opponent?.abbreviation || null,
              isHome: meta.atVs != null ? meta.atVs !== "@" : null,
            });
          }
        }
        return jsonResponse({ labels, events: allEvents, totalGames: allEvents.length }, isPastSeason ? 86400 : 14400);
      } else if (path === "dvp/rebuild-pos") {
        const stage = params.get("stage") || "2";
        if (stage === "1") {
          ctx.waitUntil(Promise.all([buildNbaDvpStage1(CACHE2), buildNbaDepthChartPos(CACHE2)]));
          return jsonResponse({ ok: true, message: "Stage 1 (teams+rosters + depth charts) queued. Check /dvp/debug-players in ~30s." });
        } else if (stage === "dc") {
          const dcResult = await buildNbaDepthChartPos(CACHE2);
          return jsonResponse({ ok: true, message: "Depth chart pos rebuild complete.", count: dcResult ? Object.keys(dcResult).length : 0 });
        } else if (stage === "2") {
          ctx.waitUntil(buildNbaDvpFromBettingPros(CACHE2));
          return jsonResponse({ ok: true, message: "Stage 2 (BettingPros DvP) queued. Check /dvp/debug in ~30s." });
        } else if (stage === "3") {
          ctx.waitUntil(buildNbaDvpFromBettingPros(CACHE2).then((r) => r || buildNbaDvpStage3FG(CACHE2)));
          return jsonResponse({ ok: true, message: "Stage 3 (BP retry + gamelog fallback) queued. Check /dvp/debug in ~30s." });
        }
        return errorResponse("Invalid stage. Use ?stage=1, ?stage=2, or ?stage=3", 400);
      } else if (path === "dvp/debug-players") {
        const sel = await CACHE2.get("dvp:nba:selected-players", "json").catch(() => null);
        if (!sel) return jsonResponse({ error: "no stage-1 data cached yet" });
        const counts = {};
        for (const pos of ["PG", "SG", "SF", "PF", "C"]) counts[pos] = sel[pos]?.length ?? 0;
        return jsonResponse({ builtAt: sel.builtAt, ...counts });
      } else if (path === "dvp/test-bp") {
        const result = await buildNbaDvpFromBettingPros(null);
        if (!result) return jsonResponse({ error: "BettingPros fetch failed \u2014 check worker logs" });
        const summary = {};
        for (const pos of ["PG", "SG", "SF", "PF", "C"]) {
          summary[pos] = {
            ptsSoftTeams: result[pos]?.softTeams?.points || [],
            rebSoftTeams: result[pos]?.softTeams?.rebounds || []
          };
        }
        return jsonResponse({ builtAt: result.builtAt, source: result.source, summary });
      } else if (path === "dvp/debug-dc") {
        const dcPos = await CACHE2.get("dvp:nba:depth-chart-pos", "json").catch(() => null);
        if (!dcPos) return jsonResponse({ error: "no depth chart cache" });
        const counts = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 };
        for (const v of Object.values(dcPos)) if (counts[v] != null) counts[v]++;
        const query = params.get("id");
        const entry = query ? { id: query, pos: dcPos[query] || "not found" } : null;
        return jsonResponse({ total: Object.keys(dcPos).length, counts, ...(entry ? { lookup: entry } : {}) });
      } else if (path === "dvp/debug") {
        const pos = (params.get("pos") || "C").toUpperCase();
        const stat = params.get("stat") || "rebounds";
        const team = (params.get("team") || "ATL").toUpperCase();
        const all = await CACHE2.get("dvp:nba:all-positions", "json").catch(() => null);
        if (!all) return jsonResponse({ error: "no dvp data cached" });
        const rankings = all[pos]?.rankings?.[stat] || [];
        const teamEntry = rankings.find((t) => t.abbr === team);
        const softTeams = all[pos]?.softTeams?.[stat] || [];
        return jsonResponse({
          pos,
          stat,
          team,
          builtAt: all.builtAt,
          source: all.source,
          totalTeams: rankings.length,
          softTeams,
          entry: teamEntry || null,
          top10: rankings.slice(0, 10).map((t) => ({ rank: t.rank, abbr: t.abbr, avg: t.avgPts, ratio: t.ratio, gp: t.gp }))
        });
      } else if (path === "dvp/gamelog") {
        const id = params.get("id");
        if (!id) return errorResponse("id required", 400);
        const gl = await fetchNbaGamelog(id);
        if (!gl) return jsonResponse({ error: "fetch failed or no data", id });
        const atlGames = gl.filter((e) => e.oppAbbr === "ATL" || e.oppAbbr === "ATL ");
        return jsonResponse({ id, total: gl.length, atlGames, first5: gl.slice(0, 5) });
      } else if (path === "dvp/test-boxscore") {
        const gameIds = ["401810997", "401810995", "401810993"];
        const POS_MAP = { "Center": "C", "Forward-Center": "C", "Center-Forward": "C", "Forward": "F", "Guard-Forward": "F", "Guard": "G", "Forward-Guard": "G" };
        const teamDvp = {};
        const teamAbbrs = {};
        for (const gameId of gameIds) {
          try {
            const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!r.ok) continue;
            const game = await r.json();
            const comps = game.header?.competitions?.[0]?.competitors || [];
            if (comps.length !== 2) continue;
            for (const c of comps) teamAbbrs[String(c.team?.id)] = c.team?.abbreviation || "";
            const teamIds = comps.map((c) => String(c.team?.id));
            for (const teamData of game.boxscore?.players || []) {
              const offTeamId = String(teamData.team?.id || "");
              const defTeamId = teamIds.find((id) => id !== offTeamId);
              if (!defTeamId) continue;
              const stats = teamData.statistics?.[0];
              if (!stats) continue;
              const labels = (stats.labels || []).map((l) => l.toUpperCase());
              const ptsIdx = labels.indexOf("PTS"), rebIdx = labels.indexOf("REB");
              const posTotals = {};
              for (const athlete of stats.athletes || []) {
                const athleteStats = athlete.stats || [];
                if (!athleteStats.length) continue;
                const pos = POS_MAP[athlete.athlete?.position?.displayName || ""];
                if (!pos) continue;
                if (!posTotals[pos]) posTotals[pos] = { pts: 0, reb: 0 };
                posTotals[pos].pts += parseFloat(athleteStats[ptsIdx]) || 0;
                posTotals[pos].reb += parseFloat(athleteStats[rebIdx]) || 0;
              }
              if (!teamDvp[defTeamId]) teamDvp[defTeamId] = { abbr: teamAbbrs[defTeamId] };
              for (const [pos, t] of Object.entries(posTotals)) {
                if (!teamDvp[defTeamId][pos]) teamDvp[defTeamId][pos] = [];
                teamDvp[defTeamId][pos].push(t);
              }
            }
          } catch {
          }
        }
        return jsonResponse({ teamDvp, teamAbbrs });
      } else if (path === "dvp/rebuild") {
        let testWriteErr = null;
        try {
          await CACHE2.put("dvp:write-test", "ok", { expirationTtl: 60 });
        } catch (e) {
          testWriteErr = String(e);
        }
        const testRead = await CACHE2.get("dvp:write-test").catch((e) => `READ_ERR:${e}`);
        const tableResult = await buildNbaDvpFromBettingPros(CACHE2);
        if (!tableResult) return errorResponse("BettingPros fetch failed — check logs", 500);
        const serialized = JSON.stringify(tableResult);
        const positions = Object.keys(tableResult).filter((k) => k !== "builtAt" && k !== "source");
        return jsonResponse({ ok: true, positions, builtAt: tableResult.builtAt, source: tableResult.source, payloadBytes: serialized.length, testWriteErr, testRead });
      } else if (path === "dvp") {
        const sport = params.get("sport") || "basketball/nba";
        const athleteId = params.get("athleteId");
        const [sportSlug, leagueSlug] = sport.split("/");
        let position = params.get("position") || null;
        if (!position && athleteId && sport === "basketball/nba") {
          const dcPos = CACHE2 ? await CACHE2.get("dvp:nba:depth-chart-pos", "json").catch(() => null) : null;
          if (dcPos) position = dcPos[String(athleteId)] || null;
        }
        if (!position && athleteId) {
          try {
            const ar = await fetch(`${ESPN_CORE}/${sportSlug}/leagues/${leagueSlug}/athletes/${athleteId}`, {
              headers: { "User-Agent": "Mozilla/5.0" }
            });
            if (ar.ok) {
              const ad = await ar.json();
              position = ad.position?.abbreviation || null;
            }
          } catch {
          }
        }
        const ESPN_HEADERS = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.espn.com/"
        };
        if (sport === "basketball/nba") {
          let nbaByteam = CACHE2 ? await CACHE2.get("byteam:nba", "json").catch(() => null) : null;
          if (!nbaByteam || nbaByteam.length === 0) {
            const r = await fetch(
              "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=defensive&seasontype=2",
              { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }
            ).catch(() => null);
            if (r?.ok) {
              const d = await r.json();
              nbaByteam = d.teams || [];
              if (CACHE2 && nbaByteam.length > 0) CACHE2.put("byteam:nba", JSON.stringify(nbaByteam), { expirationTtl: 21600 }).catch(() => {
              });
            }
          }
          if (nbaByteam && nbaByteam.length > 0) {
            const STATS = ["points", "rebounds", "assists", "threePointers"];
            const softTeams = Object.fromEntries(STATS.map((s) => [s, buildSoftTeamAbbrs(nbaByteam, s)]));
            const hardTeams = Object.fromEntries(STATS.map((s) => [s, buildHardTeamAbbrs(nbaByteam, s)]));
            const rankMaps = Object.fromEntries(STATS.map((s) => [s, buildTeamRankMap(nbaByteam, s)]));
            const teams = Object.entries(rankMaps.points).map(([abbr, { rank, value }]) => ({ abbr, rank, avgPts: value })).sort((a, b) => a.rank - b.rank);
            return jsonResponse({ position, metric: "pts", teams, softTeams, hardTeams, rankMaps, source: "byteam" }, 21600);
          }
          return errorResponse("NBA byteam data unavailable", 500);
        } else if (sport === "football/nfl") {
          const NFL_POS_CAT = {
            QB: { catName: "Opponent Passing", valIdx: 8, metric: "oppPassingYardsPerGame" },
            RB: { catName: "Opponent Rushing", valIdx: 1, metric: "oppRushingYardsPerGame" },
            HB: { catName: "Opponent Rushing", valIdx: 1, metric: "oppRushingYardsPerGame" },
            FB: { catName: "Opponent Rushing", valIdx: 1, metric: "oppRushingYardsPerGame" },
            WR: { catName: "Opponent Receiving", valIdx: 3, metric: "oppReceivingYardsPerGame" },
            TE: { catName: "Opponent Receiving", valIdx: 3, metric: "oppReceivingYardsPerGame" }
          };
          const posKey = position || "QB";
          const { catName, valIdx, metric } = NFL_POS_CAT[posKey] || NFL_POS_CAT.QB;
          const byteamUrl = `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byteam?region=us&lang=en&isqualified=true&page=1&limit=32&category=passing`;
          let teams = [];
          try {
            const r = await fetch(byteamUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (r.ok) {
              const data = await r.json();
              const rawTeams = data.teams || [];
              teams = rawTeams.map((t) => {
                const abbr = t.team?.abbreviation || "";
                const id = String(t.team?.id || "");
                let val = null;
                let gp = 0;
                for (const cat of t.categories || []) {
                  if (cat.displayName === catName) val = cat.values?.[valIdx] ?? null;
                  if (cat.displayName === "Own General") gp = cat.values?.[0] ?? 0;
                }
                return { id, abbr, val, gp };
              }).filter((t) => t.abbr && t.val !== null && t.gp >= 4).sort((a, b) => b.val - a.val).map((t, i) => ({ id: t.id, abbr: t.abbr, avgPts: parseFloat(t.val.toFixed(2)), gp: t.gp, rank: i + 1 }));
            }
          } catch {
          }
          return jsonResponse({ position: posKey, metric, teams }, 21600);
        } else if (sport === "hockey/nhl") {
          const NHL_ABBR = {
            1: "NJD",
            2: "NYI",
            3: "NYR",
            4: "PHI",
            5: "PIT",
            6: "BOS",
            7: "BUF",
            8: "MTL",
            9: "OTT",
            10: "TOR",
            12: "CAR",
            13: "FLA",
            14: "TBL",
            15: "WSH",
            16: "CHI",
            17: "DET",
            18: "NSH",
            19: "STL",
            20: "CGY",
            21: "COL",
            22: "EDM",
            23: "VAN",
            24: "ANA",
            25: "DAL",
            26: "LA",
            28: "SJ",
            29: "CBJ",
            30: "MIN",
            52: "WPG",
            53: "UTA",
            54: "VGK",
            55: "SEA"
          };
          const isGoalie = position === "G";
          const sortStat = isGoalie ? "shotsForPerGame" : "shotsAgainstPerGame";
          let teams = [];
          try {
            const nhlUrl = `https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=${sortStat}&start=0&limit=50&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2`;
            const r = await fetch(nhlUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
            if (r.ok) {
              const data = await r.json();
              teams = [...data.data || []].sort((a, b) => b[sortStat] - a[sortStat]).map((t, i) => ({
                id: String(t.teamId),
                abbr: NHL_ABBR[t.teamId] || "",
                avgPts: parseFloat((t[sortStat] || 0).toFixed(2)),
                gp: t.gamesPlayed || 0,
                rank: i + 1
              })).filter((t) => t.abbr);
            }
          } catch {
          }
          return jsonResponse({ position, metric: sortStat, teams }, 21600);
        } else if (sport === "baseball/mlb") {
          const playerTeam = params.get("team") || null;
          let mlbByteam = CACHE2 ? await CACHE2.get("byteam:mlb", "json").catch(() => null) : null;
          if (!mlbByteam) {
            const _hd0 = new Date(Date.now() - 7 * 3600 * 1000); const _hd1 = new Date(_hd0); _hd1.setDate(_hd1.getDate() + 1);
            const _hfmt = (d) => d.toISOString().slice(0, 10);
            const _hfmtE = (d) => _hfmt(d).replace(/-/g, "");
            const [pitchRes, batRes, sbRes, mlbSched] = await Promise.all([
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=pitching", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=batting", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_hfmtE(_hd0)}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((sb0) => {
                const evts = sb0.events || [];
                if (evts.length === 0 || evts.every((ev) => ev.status?.type?.state === "post")) {
                  return fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_hfmtE(_hd1)}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
                }
                return sb0;
              }),
              fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_hfmt(_hd0)}&hydrate=lineups,probablePitcher`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((s0) => {
                const allFinal = (s0.dates || []).flatMap((d) => d.games || []).every((g) => g.status?.abstractGameState === "Final");
                if ((s0.dates || []).length === 0 || allFinal) {
                  return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_hfmt(_hd1)}&hydrate=lineups,probablePitcher`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
                }
                return s0;
              })
            ]);
            const _mlbNorm2 = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
            const normMlbAbbr2 = (a) => _mlbNorm2[a] || a;
            const probables2 = {};
            for (const event of sbRes.events || []) {
              for (const comp of event.competitions || []) {
                const gameAbbrs = (comp.competitors || []).map((c) => normMlbAbbr2(c.team?.abbreviation)).filter(Boolean);
                for (const competitor of comp.competitors || []) {
                  const abbr = normMlbAbbr2(competitor.team?.abbreviation);
                  const probable = (competitor.probables || [])[0];
                  if (!abbr || !probable) continue;
                  const stats = probable.statistics || [];
                  const eraStat = stats.find((s) => s.abbreviation === "ERA");
                  const era = eraStat ? parseFloat(eraStat.displayValue) : null;
                  const name = probable.athlete?.displayName || probable.athlete?.fullName || null;
                  const id = probable.athlete?.id || null;
                  const opp = gameAbbrs.find((a) => a !== abbr) || null;
                  probables2[abbr] = { name, era, id, opp };
                }
              }
            }
            const gameOddsRaw2 = parseGameOdds(sbRes.events);
            const gameOdds = Object.fromEntries(Object.entries(gameOddsRaw2).map(([k, v]) => [normMlbAbbr2(k), v]));
            const [lineupResult, pitcherResult] = await Promise.all([buildLineupKPct(mlbSched), buildPitcherKPct(mlbSched)]);
            const { lineupKPct: lineupKPct2, lineupBatterKPcts: lineupBatterKPcts2, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered: lineupBatterKPctsOrdered2, lineupBatterKPctsVROrdered: lineupBatterKPctsVROrdered2, lineupBatterKPctsVLOrdered: lineupBatterKPctsVLOrdered2, lineupSpotByName: lineupSpotByName2, gameHomeTeams: gameHomeTeams2, projectedLineupTeams: projectedLineupTeams2 } = lineupResult;
            const { pitcherKPct: pitcherKPct2, pitcherKBBPct: pitcherKBBPct2, pitcherHand, pitcherEra: pitcherEraByTeam2, pitcherCSWPct: pitcherCSWPct2, pitcherAvgPitches: pitcherAvgPitches2, pitcherGS26: pitcherGS262, pitcherHasAnchor: pitcherHasAnchor2 } = pitcherResult;
            mlbByteam = { pitching: pitchRes, batting: batRes, probables: probables2, lineupKPct: lineupKPct2, lineupBatterKPcts: lineupBatterKPcts2, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered: lineupBatterKPctsOrdered2, lineupBatterKPctsVROrdered: lineupBatterKPctsVROrdered2, lineupBatterKPctsVLOrdered: lineupBatterKPctsVLOrdered2, lineupSpotByName: lineupSpotByName2, gameHomeTeams: gameHomeTeams2, pitcherKPct: pitcherKPct2, pitcherKBBPct: pitcherKBBPct2, pitcherCSWPct: pitcherCSWPct2, pitcherAvgPitches: pitcherAvgPitches2, pitcherGS26: pitcherGS262, pitcherHasAnchor: pitcherHasAnchor2, pitcherHand, pitcherEra: pitcherEraByTeam2, projectedLineupTeams: projectedLineupTeams2, gameOdds };
            if (CACHE2) await CACHE2.put("byteam:mlb", JSON.stringify(mlbByteam), { expirationTtl: 600 });
          }
          const probables = mlbByteam.probables || {};
          const playerEntry = playerTeam ? probables[playerTeam] : null;
          const tonightOpp = playerEntry?.opp || null;
          const oppEntry = tonightOpp ? probables[tonightOpp] : null;
          const lineupKPct = mlbByteam.lineupKPct || {};
          const lineupBatterKPcts = mlbByteam.lineupBatterKPcts || {};
          const pitcherKPct = mlbByteam.pitcherKPct || {};
          const pitcherKBBPct = mlbByteam.pitcherKBBPct || {};
          const gameHomeTeams = mlbByteam.gameHomeTeams || {};
          // Prefer team|opp matchup key to handle doubleheaders; fall back to team key
          const _ptDvp = (m) => (tonightOpp ? (m?.[`${playerTeam}|${tonightOpp}`] ?? null) : null) ?? m?.[playerTeam] ?? null;
          const pKPct = _ptDvp(pitcherKPct);
          const _dvpPitcherHandEarly = _ptDvp(mlbByteam.pitcherHand);
          const ordAllDvp = mlbByteam.lineupBatterKPctsOrdered?.[tonightOpp] ?? null;
          const ordVRDvp = mlbByteam.lineupBatterKPctsVROrdered?.[tonightOpp] ?? null;
          const ordVLDvp = mlbByteam.lineupBatterKPctsVLOrdered?.[tonightOpp] ?? null;
          const orderedKPctsDvp = _dvpPitcherHandEarly === "R" ? (ordVRDvp ?? ordAllDvp) : _dvpPitcherHandEarly === "L" ? (ordVLDvp ?? ordAllDvp) : ordAllDvp;
          const batterKPcts = orderedKPctsDvp ?? (lineupBatterKPcts[tonightOpp] ?? []);
          let log5Avg = null, expectedKs = null, parkFactor = null;
          if (pKPct !== null && batterKPcts.length >= 3) {
            const homeTeam = gameHomeTeams[playerTeam] || tonightOpp;
            parkFactor = PARK_KFACTOR[homeTeam] ?? 1;
            const scores = batterKPcts.map((b) => log5K(pKPct, b * 100));
            log5Avg = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length * 100).toFixed(1));
            expectedKs = parseFloat((log5Avg / 100 * 27 * parkFactor).toFixed(1));
          }
          const projectedLineupTeams = mlbByteam.projectedLineupTeams || [];
          const _dvpGameOdds = mlbByteam.gameOdds?.[playerTeam] ?? null;
          const _dvpPkpMeets = pKPct != null ? pKPct > 25 : null;
          const _dvpPitcherHand = _ptDvp(mlbByteam.pitcherHand);
          const _dvpLkpVR = mlbByteam.lineupKPctVR?.[tonightOpp] ?? null;
          const _dvpLkpVL = mlbByteam.lineupKPctVL?.[tonightOpp] ?? null;
          const _dvpLkpAll = lineupKPct[tonightOpp] ?? null;
          const _dvpLkp = _dvpPitcherHand === "R" ? _dvpLkpVR ?? _dvpLkpAll : _dvpPitcherHand === "L" ? _dvpLkpVL ?? _dvpLkpAll : _dvpLkpAll;
          const _dvpLkpMeets = _dvpLkp != null ? _dvpLkp > 23 : null;
          const _dvpGameLineMeets = _dvpGameOdds?.total != null && _dvpGameOdds?.moneyline != null ? _dvpGameOdds.total < 8.5 && _dvpGameOdds.moneyline <= -140 : null;
          const _dvpStrongTrue = [_dvpPkpMeets, _dvpLkpMeets, _dvpGameLineMeets].filter(v => v === true).length;
          const _dvpStrongKnown = [_dvpPkpMeets, _dvpLkpMeets, _dvpGameLineMeets].filter(v => v !== null).length;
          const _dvpIsStrong = _dvpStrongKnown >= 2 ? _dvpStrongTrue >= 2 : _dvpStrongTrue >= 1;
          return jsonResponse({
            position,
            metric: "h2h",
            teams: [],
            h2h: tonightOpp ? {
              opp: tonightOpp,
              pitcherName: oppEntry?.name || null,
              pitcherEra: oppEntry?.era ?? null,
              lineupKPct: _dvpLkp,
              lineupKPctProjected: projectedLineupTeams.includes(tonightOpp),
              pitcherKPct: pKPct,
              pitcherKBBPct: _ptDvp(pitcherKBBPct),
              log5Avg,
              expectedKs,
              parkFactor,
              pitcherHand: _dvpPitcherHand,
              isStrongMatchup: _dvpIsStrong,
              pkpMeets: _dvpPkpMeets,
              lkpMeets: _dvpLkpMeets,
              gameLineMeets: _dvpGameLineMeets,
              gameTotal: _dvpGameOdds?.total ?? null,
              gameMoneyline: _dvpGameOdds?.moneyline ?? null
            } : null,
            // Iterate all 30 teams from overall K%, use VR/VL as primary with overall as fallback
            // (matching the tonight endpoint logic — avoids excluding teams that lack hand-specific data)
            allLineupKPct: _dvpPitcherHand === "R"
              ? Object.fromEntries(Object.entries(lineupKPct).map(([t, v]) => [t, mlbByteam.lineupKPctVR?.[t] ?? v]).filter(([, v]) => v != null))
              : _dvpPitcherHand === "L"
              ? Object.fromEntries(Object.entries(lineupKPct).map(([t, v]) => [t, mlbByteam.lineupKPctVL?.[t] ?? v]).filter(([, v]) => v != null))
              : lineupKPct
          }, 600);
        } else {
          return jsonResponse({ position, teams: [] }, 21600);
        }
      } else if (path === "kalshi") {
        const playerName = params.get("playerName") || "";
        const stat = params.get("stat") || "points";
        const sportParam = params.get("sport") || "nba";
        const SERIES = {
          nba: { points: "KXNBAPTS", rebounds: "KXNBAREB", assists: "KXNBAAST", threePointers: "KXNBA3PT" },
          nhl: { points: "KXNHLPTS" },
          mlb: { hits: "KXMLBHITS", hrr: "KXMLBHRR", strikeouts: "KXMLBKS" }
        };
        const series = SERIES[sportParam]?.[stat];
        if (!series || !playerName) return jsonResponse({ markets: [] });
        const url2 = `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&limit=1000&status=open`;
        const res = await fetch(url2, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
          cf: { cacheEverything: false }
        });
        if (!res.ok) return jsonResponse({ markets: [] });
        const data = await res.json();
        const nameLower = normName(playerName);
        const matching = (data.markets || []).filter(
          (m) => normName(m.event_title || m.title || "").includes(nameLower)
        );
        const seen = /* @__PURE__ */ new Set();
        const markets = [];
        for (const m of matching) {
          const strike = parseFloat(m.floor_strike);
          if (isNaN(strike)) continue;
          const threshold = Math.round(strike + 0.5);
          if (seen.has(threshold)) continue;
          seen.add(threshold);
          const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
          const last = parseFloat(m.last_price_dollars) || 0;
          const price = yesAsk > 0 ? yesAsk : last;
          const pct = Math.round(price * 100);
          if (pct <= 0 || pct > 97) continue;
          const americanOdds = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
          markets.push({ threshold, pct, americanOdds });
        }
        return jsonResponse({ markets }, 900);
      } else if (path === "tonight") {
        let parseGameTeams = function(eventTicker, sport) {
          const seg = (eventTicker || "").split("-")[1] || "";
          let rest = seg.slice(7);
          if (/^\d{4}[A-Z]/.test(rest)) rest = rest.slice(4);
          if (rest.length < 4) return [null, null];
          const has2charPrefix = TEAM_NORM[sport]?.[rest.slice(0, 2)] !== void 0;
          if (rest.length >= 6 && !has2charPrefix) return [normTeam(sport, rest.slice(0, 3)), normTeam(sport, rest.slice(3, 6))];
          if (rest.length >= 5 && has2charPrefix) return [normTeam(sport, rest.slice(0, 2)), normTeam(sport, rest.slice(2, 5))];
          if (rest.length >= 5) return [normTeam(sport, rest.slice(0, 3)), normTeam(sport, rest.slice(3, 5))];
          if (rest.length >= 4 && has2charPrefix) return [normTeam(sport, rest.slice(0, 2)), normTeam(sport, rest.slice(2, 4))];
          if (rest.length >= 6) return [normTeam(sport, rest.slice(0, 3)), normTeam(sport, rest.slice(3, 6))];
          return [null, null];
        }, nhlSoftTeams = function(arr, sortKey, label, unit, n = 10) {
          const sorted = [...arr].sort((a, b) => b[sortKey] - a[sortKey]);
          const softTeams = /* @__PURE__ */ new Set();
          const rankMap = {};
          sorted.forEach((t, i) => {
            const abbr = NHL_ABBR_MAP[t.teamId];
            if (!abbr) return;
            rankMap[abbr] = { rank: i + 1, value: parseFloat((t[sortKey] || 0).toFixed(2)), label, unit };
            if (i < n) softTeams.add(abbr);
          });
          return { softTeams, rankMap };
        }, mlbSoftTeams = function(data, isPitcherStat, n = 10) {
          const topCats = data?.categories || [];
          const catName = isPitcherStat ? "batting" : "pitching";
          const keyword = isPitcherStat ? "strikeout" : "era";
          const label = isPitcherStat ? "lineup Ks" : "ERA";
          const unit = isPitcherStat ? "" : "ERA";
          const topCat = topCats.find((c) => c.name === catName);
          const statIdx = (topCat?.names || []).findIndex((nm) => nm.toLowerCase().includes(keyword));
          if (statIdx === -1) return { softTeams: /* @__PURE__ */ new Set(), rankMap: {} };
          const sorted = [...data?.teams || []].map((team) => {
            const teamCat = (team.categories || []).find((c) => c.name === catName);
            const val = parseFloat(teamCat?.values?.[statIdx] ?? 0);
            return { abbr: team.team?.abbreviation || "", val };
          }).filter((t) => t.abbr).sort((a, b) => b.val - a.val);
          const softTeams = new Set(sorted.slice(0, n).map((t) => t.abbr));
          const rankMap = {};
          sorted.forEach((t, i) => {
            rankMap[t.abbr] = { rank: i + 1, value: parseFloat(t.val.toFixed(2)), label, unit };
          });
          return { softTeams, rankMap };
        }, glCacheKey = function(key) {
          const [sport] = key.split("|");
          return sport === "mlb" ? `gl:mlb242526v2|${key}` : `gl:v2|${key}`;
        };
        __name(parseGameTeams, "parseGameTeams");
        __name(nhlSoftTeams, "nhlSoftTeams");
        __name(mlbSoftTeams, "mlbSoftTeams");
        __name(glCacheKey, "glCacheKey");
        const isDebugMode = params.get("debug") === "1";
        const isBustCache = params.get("bust") === "1";
        const reportSportFilter = params.get("sport") || null;
        if (params.get("mock") === "true") {
          return jsonResponse({ plays: [
            { playerName: "Shai Gilgeous-Alexander", playerId: "4278073", sport: "nba", playerTeam: "OKC", position: "PG", posGroup: "PG", opponent: "DAL", oppRank: 2, oppMetricValue: 119.8, oppMetricLabel: "PPG allowed", oppMetricUnit: "PPG", stat: "points", threshold: 30, kalshiPct: 74, americanOdds: -163, seasonPct: 78.4, softPct: 84.2, softGames: 11, truePct: 81.3, edge: 7.3, gameDate: "2026-04-08", gameTime: "2026-04-09T00:30:00Z" },
            { playerName: "Nikola Jokic", playerId: "3112335", sport: "nba", playerTeam: "DEN", position: "C", posGroup: "C", opponent: "MEM", oppRank: 5, oppMetricValue: 46.1, oppMetricLabel: "REB allowed/game", oppMetricUnit: "REB", stat: "rebounds", threshold: 10, kalshiPct: 72, americanOdds: -138, seasonPct: 74.5, softPct: 77.3, softGames: 8, truePct: 75.9, edge: 3.9, gameDate: "2026-04-08", gameTime: "2026-04-09T02:00:00Z", playerStatus: "questionable" },
            { playerName: "Connor McDavid", playerId: "3895074", sport: "nhl", playerTeam: "EDM", position: "C", opponent: "VGK", oppRank: 3, oppMetricValue: 3.4, oppMetricLabel: "Goals against/game", oppMetricUnit: "GAA", stat: "goals", threshold: 1, kalshiPct: 73, americanOdds: -122, seasonPct: 72.1, softPct: 74.5, softGames: 8, truePct: 73.3, edge: 0.3, gameDate: "2026-04-08", gameTime: "2026-04-09T02:00:00Z" },
            {
              playerName: "Dylan Cease",
              playerId: "34943",
              sport: "mlb",
              playerTeam: "SD",
              position: "SP",
              opponent: "CLE",
              oppRank: null,
              oppMetricValue: null,
              oppMetricLabel: "vs high-K lineups",
              oppMetricUnit: "%",
              stat: "strikeouts",
              threshold: 6,
              kalshiPct: 71,
              americanOdds: -245,
              seasonPct: 74,
              softPct: 80,
              softGames: 10,
              truePct: 77,
              edge: 6,
              lineupKPct: 27.3,
              pitcherKPct: 26.5,
              pitcherKBBPct: 18.2,
              log5Avg: 31.6,
              log5Pct: 96.1,
              expectedKs: 8.5,
              parkFactor: 1,
              isStrongMatchup: true,
              pkpMeets: true,
              lkpMeets: true,
              gameLineMeets: true,
              gameTotal: 7.5,
              gameMoneyline: -145,
              pitcherHand: "R",
              gameDate: "2026-04-08",
              gameTime: "2026-04-08T20:10:00Z",
              lineupConfirmed: true
            },
            { playerName: "Shohei Ohtani", playerId: "39949", sport: "mlb", playerTeam: "LAD", position: "DH", opponent: "SD", oppRank: 4, oppMetricValue: 4.85, oppMetricLabel: "ERA allowed", oppMetricUnit: "ERA", stat: "hits", threshold: 1, kalshiPct: 72, americanOdds: -300, seasonPct: 73.8, softPct: 76.4, truePct: 76.1, edge: 4.1, hitterBa: 0.291, hitterBaTier: "good", hitterMoneyline: -175, gameDate: "2026-04-08", gameTime: "2026-04-09T02:10:00Z", lineupConfirmed: false }
          ], mock: true }, true);
        }
        const SERIES_CONFIG = {
          KXNBAPTS: { sport: "nba", league: "nba", stat: "points", col: "PTS" },
          KXNBAREB: { sport: "nba", league: "nba", stat: "rebounds", col: "REB" },
          KXNBAAST: { sport: "nba", league: "nba", stat: "assists", col: "AST" },
          KXNBA3PT: { sport: "nba", league: "nba", stat: "threePointers", col: "3PT" },
          KXNHLPTS: { sport: "nhl", league: "nhl", stat: "points", col: "PTS" },
          KXMLBHITS: { sport: "mlb", league: "mlb", stat: "hits", col: "H" },
          KXMLBKS: { sport: "mlb", league: "mlb", stat: "strikeouts", col: "K" },
          KXMLBHRR: { sport: "mlb", league: "mlb", stat: "hrr", col: "HRR" },
          KXNFLPAYDS: { sport: "nfl", league: "nfl", stat: "passingYards", col: "YDS" },
          KXNFLRUYDS: { sport: "nfl", league: "nfl", stat: "rushingYards", col: "YDS" },
          KXNFLREYDS: { sport: "nfl", league: "nfl", stat: "receivingYards", col: "YDS" },
          KXNFLTDS: { sport: "nfl", league: "nfl", stat: "touchdowns", col: "TD" },
          // Game totals — both over and under plays surfaced per market
          KXMLBTOTAL: { sport: "mlb", league: "mlb", stat: "totalRuns",   col: "R",   gameType: "total" },
          KXNBATOTAL: { sport: "nba", league: "nba", stat: "totalPoints", col: "PTS", gameType: "total" },
          KXNHLTOTAL: { sport: "nhl", league: "nhl", stat: "totalGoals",  col: "G",   gameType: "total" },
          KXNFLTOTAL: { sport: "nfl", league: "nfl", stat: "totalPoints", col: "PTS", gameType: "total" },
          // Team totals — single team's score vs opposing defense
          KXMLBTEAMTOTAL: { sport: "mlb", league: "mlb", stat: "teamRuns",   col: "R",   gameType: "teamTotal" },
          KXNBATEAMTOTAL: { sport: "nba", league: "nba", stat: "teamPoints", col: "PTS", gameType: "teamTotal" },
        };
        const TEAM_NORM = {
          nba: { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX", WPH: "PHX", KAT: "ATL" },
          nhl: { NJ: "NJD", TB: "TBL", LA: "LAK", SJ: "SJS", VGK: "VGK" },
          mlb: { KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", CHW: "CWS", AZ: "ARI", KC: "KC", SD: "SD", SF: "SF", TB: "TB", OAK: "ATH", WSN: "WSH", WAS: "WSH" },
          nfl: { LA: "LAR" }
        };
        const normTeam = /* @__PURE__ */ __name((sport, a) => TEAM_NORM[sport]?.[a] || a, "normTeam");
        // Domed MLB stadiums — weather factor does not apply
        const _MLB_DOMED = new Set(["TB", "TOR", "HOU", "MIA", "SEA", "ARI", "TEX", "MIL"]);
        // Parse wind direction from ESPN displayValue: "Out to LF" → positive, "In from CF" → negative, crosswind → 0
        const _parseWind = (dv) => {
          if (!dv) return { windSpeed: null, windOutMph: null };
          const v = dv.toLowerCase();
          const m = v.match(/(\d+(?:\.\d+)?)\s*mph/);
          const spd = m ? parseFloat(m[1]) : null;
          if (spd == null) return { windSpeed: null, windOutMph: null };
          if (spd === 0) return { windSpeed: 0, windOutMph: 0 };
          const isOut = v.includes(" out to ") || v.includes(" out ") || v.endsWith(" out");
          const isIn = v.includes(" in from ") || v.includes(" in to ") || (v.includes(" in ") && !isOut);
          return { windSpeed: spd, windOutMph: isOut ? spd : isIn ? -spd : 0 };
        };
        const _extractMlbWeather = (events, byGame, nt) => {
          for (const ev of events) {
            const comps = ev.competitions?.[0];
            const weather = comps?.weather;
            if (!weather) continue;
            const homeC = (comps?.competitors ?? []).find(c => c.homeAway === "home");
            const awayC = (comps?.competitors ?? []).find(c => c.homeAway === "away");
            if (!homeC || !awayC) continue;
            const homeA = nt("mlb", homeC.team?.abbreviation ?? "");
            const awayA = nt("mlb", awayC.team?.abbreviation ?? "");
            if (!homeA || !awayA) continue;
            const { windSpeed, windOutMph } = _parseWind(weather.displayValue ?? "");
            byGame[`${homeA}|${awayA}`] = { temp: weather.temperature ?? null, condition: weather.displayValue ?? null, windSpeed, windOutMph };
          }
        };
        const seriesTickers = Object.keys(SERIES_CONFIG);
        // Bundle cache: stores all series in one Redis key (90s TTL) to avoid hammering Kalshi
        const KALSHI_BUNDLE_KEY = `kalshi:bundle:${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
        async function fetchKalshiSeries(ticker) {
          const staleKey = `kalshi:stale:${ticker}`;
          const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ticker}&limit=1000&status=open`, {
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
            cf: { cacheEverything: false }
          }).catch(() => null);
          if (r?.status === 429) {
            // Rate limited — fall through to stale immediately, no retry
            if (CACHE2) {
              const stale = await CACHE2.get(staleKey, "json").catch(() => null);
              if (stale) return { data: stale, stale: true, rateLimited: true };
            }
            return { data: { markets: [] }, rateLimited: true };
          }
          const fresh = r?.ok ? await r.json().catch(() => null) : null;
          if (fresh && (fresh.markets || []).length > 0) {
            if (CACHE2) await CACHE2.put(staleKey, JSON.stringify(fresh)).catch(() => {});
            return { data: fresh };
          }
          if (CACHE2) {
            const stale = await CACHE2.get(staleKey, "json").catch(() => null);
            if (stale) return { data: stale, stale: true };
          }
          return { data: { markets: [] }, failed: true };
        }
        __name(fetchKalshiSeries, "fetchKalshiSeries");
        // Check bundle cache before making any Kalshi calls
        let kalshiResults;
        const bundleCached = !isBustCache && CACHE2 ? await CACHE2.get(KALSHI_BUNDLE_KEY, "json").catch(() => null) : null;
        if (bundleCached) {
          kalshiResults = seriesTickers.map(t => bundleCached[t] || { markets: [] });
        } else {
          // Fetch all series in parallel — bundle cache (90s) absorbs rate limiting between requests
          const fetchResults = await Promise.all(seriesTickers.map(fetchKalshiSeries));
          const resultMap = {};
          for (let i = 0; i < seriesTickers.length; i++) resultMap[seriesTickers[i]] = fetchResults[i].data;
          kalshiResults = seriesTickers.map(t => resultMap[t] || { markets: [] });
          // Cache bundle if we got real data
          if (CACHE2 && kalshiResults.some(d => (d.markets || []).length > 0)) {
            await CACHE2.put(KALSHI_BUNDLE_KEY, JSON.stringify(resultMap), { expirationTtl: 600 }).catch(() => {});
          }
        }
        const qualifyingMarkets = [];
        const totalMarkets = []; // game total markets (pct 70–97); under plays computed from same markets
        const teamTotalMarkets = []; // single-team score markets (KXMLBTEAMTOTAL, KXNBATEAMTOTAL)
        const globalSeen = /* @__PURE__ */ new Set();
        for (let i = 0; i < seriesTickers.length; i++) {
          const ticker = seriesTickers[i];
          const cfg = SERIES_CONFIG[ticker];
          const { sport, stat, col } = cfg;
          for (const m of kalshiResults[i].markets || []) {
            const strike = parseFloat(m.floor_strike);
            if (isNaN(strike)) continue;
            const threshold = Math.round(strike + 0.5);
            const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
            const last = parseFloat(m.last_price_dollars) || 0;
            const volume = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
            const yesBidEarly = parseFloat(m.yes_bid_dollars) || 0;
            // Stale ask: market maker maxed ask at 99¢ with no bid — use last traded price instead
            const price = (yesAsk >= 0.98 && yesBidEarly === 0 && last > 0) ? last : (yesAsk > 0 ? yesAsk : last);
            const pct = Math.round(price * 100);
            if (price === 0) continue;

            // ── Game total branch (wider pct filter; team-based, not player-based) ──
            if (cfg.gameType === "total") {
              if (pct < 70 || pct > 97) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              const dedupeKey = `total|${sport}|${gameTeam1}|${gameTeam2}|${threshold}`;
              if (globalSeen.has(dedupeKey)) continue;
              globalSeen.add(dedupeKey);
              const _toAO = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              const _tDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _tGameDate = null;
              if (_tDateSeg.length >= 7) {
                const _KMON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _tYr = "20" + _tDateSeg.slice(0, 2);
                const _tMo = _KMON[_tDateSeg.slice(2, 5).toUpperCase()];
                const _tDy = _tDateSeg.slice(5, 7);
                if (_tMo) _tGameDate = `${_tYr}-${_tMo}-${_tDy}`;
              }
              const _tYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _tSpread = yesAsk > 0 && _tYesBid > 0 ? Math.round((yesAsk - _tYesBid) * 100) : null;
              totalMarkets.push({ gameType: "total", sport, stat, col, threshold, kalshiPct: pct, americanOdds: _toAO, kalshiVolume: volume, gameTeam1, gameTeam2, gameDate: _tGameDate, kalshiSpread: _tSpread, _ticker: m.ticker, _yesAsk: yesAsk, _yesBid: _tYesBid });
              continue;
            }

            // ── Team total branch (single team's score vs opposing defense) ──
            if (cfg.gameType === "teamTotal") {
              if (pct < 70 || pct > 97) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              // Extract scoring team from ticker suffix (e.g. "LAD8" → "LAD", "PHI97" → "PHI")
              const _ttSuffix = (m.ticker || "").split("-").pop() || "";
              const _ttMatch = _ttSuffix.match(/^([A-Z]+)/);
              if (!_ttMatch) continue;
              const scoringTeam = normTeam(sport, _ttMatch[1]);
              const dedupeKey = `teamtotal|${sport}|${scoringTeam}|${gameTeam1}|${gameTeam2}|${threshold}`;
              if (globalSeen.has(dedupeKey)) continue;
              globalSeen.add(dedupeKey);
              const _ttAO = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              const _ttDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _ttGameDate = null;
              if (_ttDateSeg.length >= 7) {
                const _KMON2 = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _ttYr = "20" + _ttDateSeg.slice(0, 2);
                const _ttMo = _KMON2[_ttDateSeg.slice(2, 5).toUpperCase()];
                const _ttDy = _ttDateSeg.slice(5, 7);
                if (_ttMo) _ttGameDate = `${_ttYr}-${_ttMo}-${_ttDy}`;
              }
              const _ttYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _ttSpread = yesAsk > 0 && _ttYesBid > 0 ? Math.round((yesAsk - _ttYesBid) * 100) : null;
              teamTotalMarkets.push({ gameType: "teamTotal", sport, stat, col, threshold, kalshiPct: pct, americanOdds: _ttAO, kalshiVolume: volume, gameTeam1, gameTeam2, scoringTeam, gameDate: _ttGameDate, kalshiSpread: _ttSpread, _ticker: m.ticker, _yesAsk: yesAsk });
              continue;
            }

            if (pct < 70) continue;
            if (pct > 97) continue;
            const raw = m.event_title || m.title || "";
            let playerName = raw.replace(/\s*:\s*\d.*$/, "").replace(/\s+(Points?|Rebounds?|Assists?|3-Pointers?|Three Pointers?|Made Threes?|Goals?|Shots on Goal|Hits?|Home Runs?|RBIs?|Strikeouts?|Total Bases?|Passing Yards?|Rushing Yards?|Receiving Yards?|Touchdowns?)\b.*/i, "").replace(/\s+Over\s+\d.*$/i, "").replace(/\s+Under\s+\d.*$/i, "").replace(/\s*\(.*\)\s*$/, "").replace(/\s*-\s*$/, "").trim();
            if (!playerName || playerName.length < 4) continue;
            const playerNameDisplay = playerName;
            playerName = normName(playerName);
            const dedupeKey = `${sport}|${playerName}|${stat}|${threshold}`;
            if (globalSeen.has(dedupeKey)) continue;
            globalSeen.add(dedupeKey);
            const americanOdds = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
            const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
            const tickerSegs = (m.ticker || "").split("-");
            let kalshiPlayerTeam = null;
            if (tickerSegs.length >= 3) {
              const seg3 = tickerSegs[2];
              if (gameTeam1 && seg3.startsWith(gameTeam1)) kalshiPlayerTeam = gameTeam1;
              else if (gameTeam2 && seg3.startsWith(gameTeam2)) kalshiPlayerTeam = gameTeam2;
              else {
                // Kalshi sometimes appends player initial to a 2-char team prefix (e.g. "SJM" for SJS + Macklin Celebrini)
                const norm2 = normTeam(sport, seg3.slice(0, 2));
                if (norm2 && (norm2 === gameTeam1 || norm2 === gameTeam2)) kalshiPlayerTeam = norm2;
                else kalshiPlayerTeam = normTeam(sport, seg3.slice(0, 3));
              }
            }
            const dateSeg = (m.event_ticker || "").split("-")[1] || "";
            let gameDate = null;
            if (dateSeg.length >= 7) {
              const KMON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
              const yr = "20" + dateSeg.slice(0, 2);
              const mo = KMON[dateSeg.slice(2, 5).toUpperCase()];
              const dy = dateSeg.slice(5, 7);
              if (mo) gameDate = `${yr}-${mo}-${dy}`;
            }
            const yesBid = parseFloat(m.yes_bid_dollars) || 0;
            const yesAskSize = parseFloat(m.yes_ask_size_fp) || 0;
            const kalshiSpread = yesAsk > 0 && yesBid > 0 ? Math.round((yesAsk - yesBid) * 100) : null;
            qualifyingMarkets.push({ playerName, playerNameDisplay, sport, stat, col, threshold, kalshiPct: pct, americanOdds, kalshiVolume: volume, gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate, kalshiSpread, _ticker: m.ticker, _yesAsk: yesAsk, _yesBid: yesBid, _yesAskSize: yesAskSize });
          }
        }
        if (qualifyingMarkets.length === 0 && totalMarkets.length === 0) {
          return jsonResponse({ plays: [], note: "no qualifying kalshi markets (implied pct >= 60)" });
        }
        // Derive implied NBA game O/U line from Kalshi KXNBATOTAL markets.
        // Uses ALL pcts (no 70-97 filter) to find the 50% YES crossing per game.
        // Falls back into nbaGameOdds for teams ESPN doesn't include in today's scoreboard odds.
        const kalshiNbaOuMap = {};
        {
          const _kxnbaIdx = seriesTickers.indexOf("KXNBATOTAL");
          if (_kxnbaIdx >= 0) {
            const _ouByGame = {};
            for (const m of kalshiResults[_kxnbaIdx].markets || []) {
              const _strike = parseFloat(m.floor_strike);
              if (isNaN(_strike)) continue;
              const _thr = Math.round(_strike + 0.5);
              const _ask = parseFloat(m.yes_ask_dollars) || 0;
              const _last = parseFloat(m.last_price_dollars) || 0;
              const _bid = parseFloat(m.yes_bid_dollars) || 0;
              const _price = (_ask >= 0.98 && _bid === 0 && _last > 0) ? _last : (_ask > 0 ? _ask : _last);
              const _pct = Math.round(_price * 100);
              if (_pct <= 0 || _pct >= 100) continue;
              const [_t1, _t2] = parseGameTeams(m.event_ticker, "nba");
              if (!_t1 || !_t2) continue;
              const _gk = `${_t1}|${_t2}`;
              if (!_ouByGame[_gk]) _ouByGame[_gk] = [];
              _ouByGame[_gk].push({ threshold: _thr, pct: _pct });
            }
            for (const [_gk, _mks] of Object.entries(_ouByGame)) {
              _mks.sort((a, b) => a.threshold - b.threshold);
              // Highest threshold where YES >= 50% → that threshold - 0.5 is implied O/U line
              let _ouLine = null;
              for (const _mk of _mks) { if (_mk.pct >= 50) _ouLine = _mk.threshold - 0.5; }
              if (_ouLine != null) {
                const [_t1, _t2] = _gk.split("|");
                kalshiNbaOuMap[_t1] = _ouLine;
                kalshiNbaOuMap[_t2] = _ouLine;
              }
            }
          }
        }
        // Blended fill price: walk the orderbook for unit-sized positions so kalshiPct reflects
        // true cost, not just top-of-book ask. 1 unit = $100 at risk; tiers: 70-83% = 1u, 83-93% = 3u, 93%+ = 5u.
        const UNIT_DOLLARS = 50; // 1 unit = 1% of $5k bankroll
        const getContracts = (pct, ask) => ask > 0 ? Math.ceil(UNIT_DOLLARS * (pct >= 93 ? 5 : pct >= 83 ? 3 : 1) / ask) : 0;
        const thinMarkets = qualifyingMarkets.filter((m) => m._ticker && getContracts(m.kalshiPct, m._yesAsk) > m._yesAskSize);
        const obMap = {};
        if (thinMarkets.length > 0) {
          const obFetches = await Promise.all(thinMarkets.map((m) =>
            fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${m._ticker}/orderbook`, {
              headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
            }).then((r) => (r.ok && r.status !== 429) ? r.json() : null).catch(() => null)
          ));
          for (let i = 0; i < thinMarkets.length; i++) {
            if (obFetches[i]?.orderbook_fp) obMap[thinMarkets[i]._ticker] = obFetches[i].orderbook_fp;
          }
        }
        for (const m of qualifyingMarkets) {
          const contracts = getContracts(m.kalshiPct, m._yesAsk);
          if (contracts <= 0 || m._yesAskSize >= contracts) continue;
          const book = obMap[m._ticker];
          if (!book) continue;
          // no_dollars are NO bids sorted ascending; YES ask at level = 1 - no_price
          // Walk highest no_price first (= lowest YES ask first) to fill the position
          const levels = (book.no_dollars || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]).sort((a, b) => b[0] - a[0]);
          let filled = 0, totalCost = 0;
          for (const [noPrice, qty] of levels) {
            if (filled >= contracts) break;
            const yesAsk = 1 - noPrice;
            if (yesAsk >= 1) continue;
            const take = Math.min(qty, contracts - filled);
            totalCost += take * yesAsk;
            filled += take;
          }
          if (filled === 0) continue;
          if (filled < contracts && levels.length > 0) {
            // Book exhausted; extend at worst quoted price
            totalCost += (contracts - filled) * Math.min(0.99, 1 - levels[levels.length - 1][0]);
          }
          const blendedPct = Math.round((totalCost / contracts) * 100);
          if (blendedPct > m.kalshiPct && blendedPct <= 97) {
            m.kalshiPct = blendedPct;
            m.americanOdds = blendedPct >= 50 ? Math.round(-(blendedPct / (100 - blendedPct)) * 100) : Math.round((100 - blendedPct) / blendedPct * 100);
          }
        }
        // E1: Line movement tracking — record opening price the first time we see each ticker.
        // lineMove = current yesAsk (after blend) - openYesAsk (first seen today).
        // KV key: lineOpen:{ticker}:{gameDate} → openYesAsk (cents, 0-100)
        if (CACHE2) {
          const _allTrackedMarkets = [...qualifyingMarkets, ...totalMarkets];
          await Promise.all(_allTrackedMarkets.map(async m => {
            if (!m._ticker || !m.gameDate) return;
            const _lmKey = `lineOpen:${m._ticker}:${m.gameDate}`;
            try {
              const _existing = await CACHE2.get(_lmKey);
              if (_existing != null) {
                const _openAsk = parseFloat(_existing);
                if (!isNaN(_openAsk)) m.lineMove = parseFloat((m.kalshiPct - _openAsk).toFixed(1));
              } else {
                // First time — write opening price; TTL = 48h (covers game day + settlement)
                await CACHE2.put(_lmKey, String(m.kalshiPct), { expirationTtl: 172800 });
                m.lineMove = 0;
              }
            } catch {}
          }));
        }
        // E2: Market depth flags — thinMarket and marketConfidence
        for (const m of [...qualifyingMarkets, ...totalMarkets, ...teamTotalMarkets]) {
          m.thinMarket = m.kalshiSpread != null && m.kalshiSpread > 8;
          m.marketConfidence = m.kalshiVolume >= 100 ? "deep" : m.kalshiVolume >= 50 ? "moderate" : "thin";
        }
        const sportsNeeded = new Set([...qualifyingMarkets.map((m) => m.sport), ...totalMarkets.map((m) => m.sport)]);
        const sportByteam = {};
        const NHL_ABBR_MAP = { 1: "NJD", 2: "NYI", 3: "NYR", 4: "PHI", 5: "PIT", 6: "BOS", 7: "BUF", 8: "MTL", 9: "OTT", 10: "TOR", 12: "CAR", 13: "FLA", 14: "TBL", 15: "WSH", 16: "CHI", 17: "DET", 18: "NSH", 19: "STL", 20: "CGY", 21: "COL", 22: "EDM", 23: "VAN", 24: "ANA", 25: "DAL", 26: "LAK", 28: "SJS", 29: "CBJ", 30: "MIN", 52: "WPG", 54: "VGK", 55: "SEA", 68: "UTA" };
        if (CACHE2) {
          await Promise.all([...sportsNeeded].map(async (sport) => {
            // When busting, skip the cache read for MLB so fresh computation is forced.
            // Deleting + reading in the same request is unreliable due to KV eventual consistency.
            if (isBustCache && (sport === "mlb" || sport === "nhl" || sport === "nba")) return;
            const cached = await CACHE2.get(`byteam:${sport}`, "json").catch(() => null);
            if (cached) sportByteam[sport] = cached;
          }));
        }
        const sportsNeedingFetch = new Set([...sportsNeeded].filter((s) => !sportByteam[s]));
        if (sportsNeedingFetch.size > 0) {
          await Promise.all([
            sportsNeedingFetch.has("nba") && Promise.all([
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=defensive&seasontype=2", {
                headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
              }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=scoring&seasontype=2", {
                headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
              }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              (() => { const _nd = new Date(); const _ns = _nd.toISOString().slice(0,10).replace(/-/g,''); return fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_ns}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})); })()
            ]).then(async ([d, scoringData, sbData]) => {
              sportByteam.nba = d.teams || [];
              sportByteam.nbaScoring = scoringData.teams || [];
              sportByteam.nbaGameOdds = parseGameOdds(sbData.events || []);
              sportByteam.nbaGameScores = parseGameScores(sbData.events || [], a => normTeam("nba", a));
              if (CACHE2) {
                await CACHE2.put("byteam:nba", JSON.stringify(sportByteam.nba), { expirationTtl: 21600 });
                await CACHE2.put("byteam:nba:scoring", JSON.stringify(sportByteam.nbaScoring), { expirationTtl: 21600 });
              }
            }),
            sportsNeedingFetch.has("nhl") && Promise.all([
              fetch("https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=goalsAgainstPerGame&start=0&limit=50&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch("https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=shotsAgainstPerGame&start=0&limit=50&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
            ]).then(async ([gaData, saData]) => {
              sportByteam.nhl = { ga: gaData.data || [], sa: saData.data || [] };
              if (CACHE2) await CACHE2.put("byteam:nhl", JSON.stringify(sportByteam.nhl), { expirationTtl: 21600 });
            }),
            sportsNeedingFetch.has("mlb") && Promise.all([
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=pitching", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=batting", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch("https://statsapi.mlb.com/api/v1/teams/stats?season=2026&group=batting&gameType=R&sportId=1&sitCodes=A", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              (() => {
                const _td0 = new Date(Date.now() - 7 * 3600 * 1000); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
                const _tfmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
                return fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_tfmt(_td0)}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((sb0) => {
                  const evts = sb0.events || [];
                  if (evts.length === 0 || evts.every((ev) => ev.status?.type?.state === "post")) {
                    return fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_tfmt(_td1)}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
                  }
                  return sb0;
                });
              })(),
              (() => {
                const _td0 = new Date(Date.now() - 7 * 3600 * 1000); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
                const _tfmt2 = (d) => d.toISOString().slice(0, 10);
                return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td0)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((s0) => {
                  const allFinal = (s0.dates || []).flatMap((d) => d.games || []).every((g) => g.status?.abstractGameState === "Final");
                  if ((s0.dates || []).length === 0 || allFinal) {
                    return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td1)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
                  }
                  return s0;
                });
              })()
            ]).then(async ([pitchData, batData, roadBatData, sbData, mlbSched]) => {
              // ESPN uses different abbreviations than Kalshi for some MLB teams
              const MLB_ESPN_NORM = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
              const normMlbAbbr = (a) => MLB_ESPN_NORM[a] || a;
              const probables = {};
              for (const event of sbData.events || []) {
                for (const comp of event.competitions || []) {
                  const gameAbbrs = (comp.competitors || []).map((c) => normMlbAbbr(c.team?.abbreviation)).filter(Boolean);
                  for (const competitor of comp.competitors || []) {
                    const abbr = normMlbAbbr(competitor.team?.abbreviation);
                    const probable = (competitor.probables || [])[0];
                    if (!abbr || !probable) continue;
                    const stats = probable.statistics || [];
                    const eraStat = stats.find((s) => s.abbreviation === "ERA");
                    const era = eraStat ? parseFloat(eraStat.displayValue) : null;
                    const whipStat = stats.find((s) => s.abbreviation === "WHIP");
                    const whip = whipStat ? parseFloat(whipStat.displayValue) : null;
                    const name = probable.athlete?.displayName || probable.athlete?.fullName || null;
                    const id = probable.athlete?.id || null;
                    const opp = gameAbbrs.find((a) => a !== abbr) || null;
                    probables[abbr] = { name, era, whip, id, opp };
                  }
                }
              }
              const gameOddsRaw = parseGameOdds(sbData.events);
              const gameOdds = Object.fromEntries(Object.entries(gameOddsRaw).map(([k, v]) => [normMlbAbbr(k), v]));
              // Game scores for matchup cards (includes finished games with no active Kalshi markets)
              const gameScores = {};
              const _ptFmtGs = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
              for (const event of sbData.events || []) {
                const comp = event.competitions?.[0];
                if (!comp) continue;
                const homeComp = (comp.competitors || []).find(c => c.homeAway === "home");
                const awayComp = (comp.competitors || []).find(c => c.homeAway === "away");
                if (!homeComp || !awayComp) continue;
                const hA = normMlbAbbr(homeComp.team?.abbreviation), awA = normMlbAbbr(awayComp.team?.abbreviation);
                if (!hA || !awA) continue;
                gameScores[hA] = {
                  homeTeam: hA, awayTeam: awA,
                  state: comp.status?.type?.state ?? "pre",
                  detail: comp.status?.type?.shortDetail || comp.status?.type?.detail || "",
                  homeScore: parseInt(homeComp.score ?? 0) || 0,
                  awayScore: parseInt(awayComp.score ?? 0) || 0,
                  gameDate: event.date ? _ptFmtGs.format(new Date(event.date)) : null,
                  gameTime: event.date || null,
                };
              }
              const [lineupResult, pitcherResult] = await Promise.all([buildLineupKPct(mlbSched), buildPitcherKPct(mlbSched)]);
              const { lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered, lineupSpotByName, gameHomeTeams, projectedLineupTeams, batterSplitBA, hitterOpsMap, batterHandByName, batterHRRSplits } = lineupResult;
              const { pitcherKPct, pitcherKBBPct, pitcherCSWPct, pitcherAvgPitches, pitcherAvgBF, pitcherStdBF, pitcherGS26, pitcherHasAnchor, pitcherHand, pitcherEra: pitcherEraByTeam, pitcherWHIP: pitcherWHIPByTeam, pitcherStatsByName, pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC, umpireByGame, pitcherInfoByTeam, pitcherH2HStarts } = pitcherResult;
              // barrelPctMap is NOT stored in byteam:mlb — it lives in mlb:barrelPct with its own 6h TTL.
              // This prevents a bust (which deletes byteam:mlb) from baking an empty barrelPctMap
              // into the cache when Baseball Savant is slow.
              // Road RPG (away-only batting) — strips home park bias before applying parkRF in lambda
              const roadRPGMap = {};
              for (const split of (roadBatData?.stats?.[0]?.splits || [])) {
                const _ra = MLB_ESPN_NORM[split.team?.abbreviation] || split.team?.abbreviation;
                if (!_ra) continue;
                const gp = split.stat?.gamesPlayed ?? 0;
                const runs = split.stat?.runs ?? 0;
                if (gp > 0 && runs > 0) roadRPGMap[_ra] = parseFloat((runs / gp).toFixed(2));
              }
              // Team platoon ratio (BA-proxy: vsLHP_BA / overallBA, vsRHP_BA / overallBA)
              // Derived from individual batter splits in batterSplitBA — no extra fetch needed.
              // MLB Stats API /teams/stats does not support pitcher handedness sitCodes (only A/H).
              const _bsNormKey = (n) => n ? n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
              const teamPlatoonRPGMap = {};
              for (const [abbr, spotMap] of Object.entries(lineupResult.lineupSpotByName || {})) {
                let hL = 0, abL = 0, hR = 0, abR = 0;
                for (const name of Object.keys(spotMap)) {
                  const splits = batterSplitBA[_bsNormKey(name)];
                  if (!splits) continue;
                  const aL = splits.vsLPA ?? 0, aR = splits.vsRPA ?? 0;
                  if (splits.vsL != null && aL >= 10) { hL += splits.vsL * aL; abL += aL; }
                  if (splits.vsR != null && aR >= 10) { hR += splits.vsR * aR; abR += aR; }
                }
                const totalAB = abL + abR;
                if (totalAB < 80) continue; // need reasonable lineup sample
                const overallBA = (hL + hR) / totalAB;
                if (overallBA === 0) continue;
                teamPlatoonRPGMap[abbr] = {
                  vl: abL >= 25 ? parseFloat(((hL / abL) / overallBA).toFixed(3)) : 1.0,
                  vr: abR >= 25 ? parseFloat(((hR / abR) / overallBA).toFixed(3)) : 1.0,
                };
              }
              // Team ERA (starter + bullpen combined) — used for 60/40 bullpen proxy in total lambda
              const teamERAMap = {};
              const _ptCat = (pitchData?.categories || []).find(c => c.name === "pitching");
              const _eraIdx = (_ptCat?.names || []).findIndex(n => n === "ERA" || n === "era");
              if (_eraIdx !== -1) {
                for (const team of (pitchData?.teams || [])) {
                  const _ta = MLB_ESPN_NORM[team.team?.abbreviation] || team.team?.abbreviation;
                  if (!_ta) continue;
                  const tc = (team.categories || []).find(c => c.name === "pitching");
                  const era = parseFloat(tc?.values?.[_eraIdx] ?? NaN);
                  if (!isNaN(era) && era > 0) teamERAMap[_ta] = era;
                }
              }
              // staticTeamHandMajority: majority batting hand per team using natural side (S=0.5R+0.5L).
              // Used to filter pitcher's historical starts by opposing lineup handedness composition.
              // Switch hitters counted as neutral (0.5/0.5) here since we don't know each historical pitcher hand;
              // tonight's matchup uses the full per-pitcher adjustment in the K play loop.
              const staticTeamHandMajority = {};
              for (const [abbr, spotMap] of Object.entries(lineupSpotByName || {})) {
                let rCount = 0, lCount = 0;
                for (const name of Object.keys(spotMap)) {
                  const hand = batterHandByName[_bsNormKey(name)];
                  if (hand === 'R') rCount++;
                  else if (hand === 'L') lCount++;
                  else if (hand === 'S') { rCount += 0.5; lCount += 0.5; } // switch = neutral
                }
                if (rCount + lCount > 0) staticTeamHandMajority[abbr] = rCount >= lCount ? 'R' : 'L';
              }
              sportByteam.mlb = { pitching: pitchData, batting: batData, probables, lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered, lineupSpotByName, gameHomeTeams, pitcherKPct, pitcherKBBPct, pitcherCSWPct, pitcherAvgPitches, pitcherAvgBF, pitcherStdBF, pitcherGS26, pitcherHasAnchor, pitcherHand, pitcherEra: pitcherEraByTeam, pitcherWHIPByTeam, projectedLineupTeams, gameOdds, pitcherStatsByName, batterSplitBA, hitterOpsMap, batterHandByName, batterHRRSplits, pitcherH2HStarts, staticTeamHandMajority, pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC, umpireByGame, pitcherInfoByTeam, roadRPGMap, teamERAMap, teamPlatoonRPGMap, gameScores };
              // Use short TTL (60s) if key data is missing — lineup/probables not confirmed yet.
              // Prevents partial data from baking into cache for the full 600s.
              const _mlbDataReady = Object.keys(lineupSpotByName || {}).length > 0 && Object.keys(pitcherAvgPitches || {}).length > 0;
              if (CACHE2) await CACHE2.put("byteam:mlb", JSON.stringify(sportByteam.mlb), { expirationTtl: _mlbDataReady ? 600 : 60 });
            }),
            sportsNeedingFetch.has("nfl") && fetch("https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byteam?region=us&lang=en&isqualified=true&page=1&limit=32&category=passing", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then(async (d) => {
              sportByteam.nfl = d.teams || [];
              if (CACHE2) await CACHE2.put("byteam:nfl", JSON.stringify(sportByteam.nfl), { expirationTtl: 1800 });
            })
          ].filter(Boolean));
        }
        // NBA scoring (offensive PPG) — load from KV cache or fetch fresh when nba byteam was served from cache
        if (sportsNeeded.has("nba") && !sportByteam.nbaScoring) {
          if (CACHE2 && !isBustCache) sportByteam.nbaScoring = await CACHE2.get("byteam:nba:scoring", "json").catch(() => null);
          if (!sportByteam.nbaScoring) {
            sportByteam.nbaScoring = await fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=scoring&seasontype=2", {
              headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
            }).then(r => r.ok ? r.json() : {}).then(d => d.teams || []).catch(() => []);
            if (CACHE2 && Array.isArray(sportByteam.nbaScoring) && sportByteam.nbaScoring.length > 0) {
              await CACHE2.put("byteam:nba:scoring", JSON.stringify(sportByteam.nbaScoring), { expirationTtl: 21600 }).catch(() => {});
            }
          }
        }
        // Fetch game start times + NBA player availability for tonight's games
        const todayDateStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
        let [gameTimes, nbaPlayerStatus, _cachedWeather] = await Promise.all([
          CACHE2 && !isBustCache ? CACHE2.get(`gameTimes:v2:${todayDateStr}`, "json").catch(() => null) : null,
          CACHE2 ? CACHE2.get(`nbaStatus:${todayDateStr}`, "json").catch(() => null) : null,
          CACHE2 && !isBustCache ? CACHE2.get(`weather:mlb:${todayDateStr}`, "json").catch(() => null) : null,
        ]);
        const weatherByGame = _cachedWeather ? { ..._cachedWeather } : {}; // keyed "homeAbbr|awayAbbr" → {temp, condition}
        const needGameTimes = !gameTimes;
        const needNbaStatus = !nbaPlayerStatus && sportsNeeded.has("nba");
        if (needGameTimes || needNbaStatus) {
          gameTimes = gameTimes || {};
          nbaPlayerStatus = nbaPlayerStatus || {};
          const SPORT_SB_PATH = { nba: "basketball/nba", nhl: "hockey/nhl", mlb: "baseball/mlb" };
          const sportsToFetch = needGameTimes ? [...sportsNeeded].filter(s => SPORT_SB_PATH[s]) : (needNbaStatus ? ["nba"] : []);
          const yesterdayDateStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, "");
          const tomorrowDateStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10).replace(/-/g, "");
          const sbResults = await Promise.all(sportsToFetch.map(async s => {
            try {
              const H2 = { "User-Agent": "Mozilla/5.0" };
              const base = `https://site.api.espn.com/apis/site/v2/sports/${SPORT_SB_PATH[s]}/scoreboard`;
              const [r1, r2, r3] = await Promise.all([
                fetch(`${base}?dates=${yesterdayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${todayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${tomorrowDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
              ]);
              return { sport: s, events: [...(r1.events || []), ...(r2.events || []), ...(r3.events || [])] };
            } catch { return { sport: s, events: [] }; }
          }));
          if (needGameTimes) {
            const _ptDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
            for (const { sport, events } of sbResults) {
              for (const ev of events) {
                const abbrs = (ev.competitions?.[0]?.competitors || []).map(c => c.team?.abbreviation).filter(Boolean);
                if (ev.date && abbrs.length === 2) {
                  const ptDate = _ptDateFmt.format(new Date(ev.date));
                  for (const abbr of abbrs) {
                    const key = `${sport}:${normTeam(sport, abbr)}`;
                    const _existDt = gameTimes[`${key}:${ptDate}`];
                    if (!_existDt || ev.date > _existDt) gameTimes[`${key}:${ptDate}`] = ev.date; // latest UTC time wins
                    if (!gameTimes[key]) gameTimes[key] = ev.date; // bare fallback (first seen wins)
                  }
                }
              }
            }
            if (CACHE2 && Object.keys(gameTimes).length > 0) await CACHE2.put(`gameTimes:v2:${todayDateStr}`, JSON.stringify(gameTimes), { expirationTtl: 600 }).catch(() => {});
            // Extract MLB weather from already-fetched scoreboard events (no extra request)
            const _mlbSbResult = sbResults.find(r => r.sport === "mlb");
            _extractMlbWeather(_mlbSbResult?.events ?? [], weatherByGame, normTeam);
            if (CACHE2 && Object.keys(weatherByGame).length > 0) await CACHE2.put(`weather:mlb:${todayDateStr}`, JSON.stringify(weatherByGame), { expirationTtl: 600 }).catch(() => {});
            // Extract NHL game odds + scores from already-fetched ESPN events (no extra request)
            const _nhlSbResult = sbResults.find(r => r.sport === "nhl");
            if (_nhlSbResult?.events.length > 0) {
              const _raw = parseGameOdds(_nhlSbResult.events);
              sportByteam.nhlGameOdds = Object.fromEntries(Object.entries(_raw).map(([k, v]) => [normTeam("nhl", k), v]));
              sportByteam.nhlGameScores = parseGameScores(_nhlSbResult.events, a => normTeam("nhl", a));
            }
            // Extract NBA game scores from already-fetched ESPN events
            const _nbaSbResult = sbResults.find(r => r.sport === "nba");
            if (_nbaSbResult?.events.length > 0 && !sportByteam.nbaGameScores) {
              sportByteam.nbaGameScores = parseGameScores(_nbaSbResult.events, a => normTeam("nba", a));
            }
          }
          if (needNbaStatus) {
            const nbaEvents = sbResults.find(r => r.sport === "nba")?.events || [];
            await Promise.all(nbaEvents.map(async ev => {
              try {
                const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${ev.id}`, { headers: { "User-Agent": "Mozilla/5.0" } });
                if (!r.ok) return;
                const d = await r.json();
                for (const teamInj of d.injuries || []) {
                  for (const inj of teamInj.injuries || []) {
                    const aid = inj.athlete?.id;
                    if (aid) nbaPlayerStatus[String(aid)] = (inj.status || "Out").toLowerCase();
                  }
                }
              } catch {}
            }));
            if (CACHE2) await CACHE2.put(`nbaStatus:${todayDateStr}`, JSON.stringify(nbaPlayerStatus), { expirationTtl: 600 }).catch(() => {});
          }
        }
        nbaPlayerStatus = nbaPlayerStatus || {};
        // Refresh MLB weather independently if cache was empty (gameTimes may have been cached)
        if (sportsNeeded.has("mlb") && Object.keys(weatherByGame).length === 0 && !isBustCache) {
          try {
            const _wRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${todayDateStr}`, { headers: { "User-Agent": "Mozilla/5.0" } }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
            _extractMlbWeather(_wRes.events || [], weatherByGame, normTeam);
            if (CACHE2 && Object.keys(weatherByGame).length > 0) await CACHE2.put(`weather:mlb:${todayDateStr}`, JSON.stringify(weatherByGame), { expirationTtl: 600 }).catch(() => {});
          } catch {}
        }
        // Fetch NHL game odds + scores if nhl byteam was loaded from cache (scoreboard not fetched above)
        if (sportsNeeded.has("nhl") && !sportByteam.nhlGameOdds) {
          const _nd3 = new Date(); const _ns3 = _nd3.toISOString().slice(0,10).replace(/-/g,'');
          const _nhlFbSb = await fetch(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${_ns3}`, {
            headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
          }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
          const _nhlFbEvents = _nhlFbSb.events || [];
          sportByteam.nhlGameOdds = Object.fromEntries(Object.entries(parseGameOdds(_nhlFbEvents)).map(([k, v]) => [normTeam("nhl", k), v]));
          if (!sportByteam.nhlGameScores) sportByteam.nhlGameScores = parseGameScores(_nhlFbEvents, a => normTeam("nhl", a));
        }
        // Fetch NBA game odds + scores if nba byteam was loaded from cache (scoreboard not fetched above)
        if (sportsNeeded.has("nba") && !sportByteam.nbaGameOdds) {
          const _nd2 = new Date(); const _ns2 = _nd2.toISOString().slice(0,10).replace(/-/g,'');
          const _nbaFbSb = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_ns2}`, {
            headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
          }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
          const _nbaFbEvents = _nbaFbSb.events || [];
          sportByteam.nbaGameOdds = parseGameOdds(_nbaFbEvents);
          if (!sportByteam.nbaGameScores) sportByteam.nbaGameScores = parseGameScores(_nbaFbEvents, a => normTeam("nba", a));
        }
        // Fill in missing NBA game O/U totals from Kalshi (ESPN omits odds for live/imminent games)
        if (Object.keys(kalshiNbaOuMap).length > 0) {
          if (!sportByteam.nbaGameOdds) sportByteam.nbaGameOdds = {};
          for (const [_team, _ouLine] of Object.entries(kalshiNbaOuMap)) {
            if (!sportByteam.nbaGameOdds[_team]) sportByteam.nbaGameOdds[_team] = {};
            if (sportByteam.nbaGameOdds[_team].total == null) sportByteam.nbaGameOdds[_team].total = _ouLine;
          }
        }
        const STAT_SOFT = {};
        if (sportByteam.nba) {
          for (const st of ["points", "rebounds", "assists", "threePointers"]) {
            STAT_SOFT[`nba|${st}`] = { softTeams: new Set(buildSoftTeamAbbrs(sportByteam.nba, st)), rankMap: buildTeamRankMap(sportByteam.nba, st) };
          }
          // Normalize short ESPN codes (GS→GSW, SA→SAS, etc.) so game-total lookups find the right key
          const _nbaAbbrs = TEAM_NORM.nba;
          for (const st of ["points", "rebounds", "assists", "threePointers"]) {
            const ss = STAT_SOFT[`nba|${st}`];
            if (!ss) continue;
            for (const [raw, val] of Object.entries(ss.rankMap)) {
              const norm = _nbaAbbrs[raw];
              if (norm && !ss.rankMap[norm]) ss.rankMap[norm] = val;
            }
            for (const raw of [...ss.softTeams]) {
              const norm = _nbaAbbrs[raw];
              if (norm) ss.softTeams.add(norm);
            }
          }
        }
        let nhlSaRankMap = {}, nhlLeagueAvgSa = null;
        if (sportByteam.nhl) {
          const { ga, sa } = sportByteam.nhl;
          STAT_SOFT["nhl|points"] = nhlSoftTeams(ga, "goalsAgainstPerGame", "Goals against/game", "GAA");
          if (sa?.length) {
            const _nhlSa = nhlSoftTeams(sa, "shotsAgainstPerGame", "Shots against/game", "SA");
            nhlSaRankMap = _nhlSa.rankMap;
            const _saVals = Object.values(nhlSaRankMap).map(r => r.value).filter(v => v > 0);
            if (_saVals.length >= 15) nhlLeagueAvgSa = parseFloat((_saVals.reduce((a, b) => a + b, 0) / _saVals.length).toFixed(2));
          }
        }
        if (sportByteam.mlb) {
          const { pitching, batting, probables = {} } = sportByteam.mlb;
          const LEAGUE_AVG_ERA = 4;
          const teamFallback = mlbSoftTeams(pitching, false);
          const pitcherEntries = Object.entries(probables).filter(([, p]) => p.era !== null && !isNaN(p.era)).sort(([, a], [, b]) => b.era - a.era);
          const hitterSoftTeams = /* @__PURE__ */ new Set();
          const hitterRankMap = { ...teamFallback.rankMap };
          pitcherEntries.forEach(([abbr, { name, era }], i) => {
            if (era > LEAGUE_AVG_ERA) hitterSoftTeams.add(abbr);
            hitterRankMap[abbr] = { rank: i + 1, value: era, label: `${name || abbr} ERA`, unit: "ERA" };
          });
          for (const abbr of teamFallback.softTeams) {
            if (!probables[abbr]) hitterSoftTeams.add(abbr);
          }
          for (const st of ["hits", "hrr"]) {
            STAT_SOFT[`mlb|${st}`] = { softTeams: hitterSoftTeams, rankMap: hitterRankMap };
          }
          STAT_SOFT["mlb|strikeouts"] = mlbSoftTeams(batting, true);
        }
        if (sportByteam.nfl) {
          const NFL_STAT_METRIC = {
            passingYards: { hint: "opponent passing", idx: 8, label: "Pass yds allowed", unit: "PAYDS" },
            rushingYards: { hint: "opponent rushing", idx: 1, label: "Rush yds allowed", unit: "RUYDS" },
            receivingYards: { hint: "opponent receiving", idx: 3, label: "Rec yds allowed", unit: "REYDS" },
            touchdowns: { hint: "opponent passing", idx: 8, label: "Pass yds allowed", unit: "PAYDS" }
          };
          for (const [st, { hint, idx, label, unit }] of Object.entries(NFL_STAT_METRIC)) {
            const sorted = [...sportByteam.nfl].map((t) => {
              const cat = (t.categories || []).find((c) => c.displayName?.toLowerCase().includes(hint));
              return { abbr: t.team?.abbreviation || "", val: parseFloat(cat?.values?.[idx] ?? 0) };
            }).filter((t) => t.abbr).sort((a, b) => b.val - a.val);
            const softTeams = new Set(sorted.slice(0, 10).map((t) => t.abbr));
            const rankMap = {};
            sorted.forEach((t, i) => {
              rankMap[t.abbr] = { rank: i + 1, value: parseFloat(t.val.toFixed(1)), label, unit };
            });
            STAT_SOFT[`nfl|${st}`] = { softTeams, rankMap };
          }
        }
        // Read all secondary caches in parallel, then fire any cold fallbacks in parallel too.
        let [allPositionsDvp, nbaDepthChartPos, _cachedBarrel, _cachedPace] = await Promise.all([
          CACHE2 ? CACHE2.get("dvp:nba:all-positions", "json").catch(() => null) : null,
          CACHE2 ? CACHE2.get("dvp:nba:depth-chart-pos", "json").catch(() => null) : null,
          (sportsNeeded.has("mlb") && CACHE2) ? CACHE2.get("mlb:barrelPct", "json").catch(() => null) : null,
          (sportsNeeded.has("nba") && CACHE2 && !isBustCache) ? CACHE2.get("nba:pace:2526", "json").catch(() => null) : null
        ]);
        // Fire cold fallbacks in parallel
        [allPositionsDvp, nbaDepthChartPos, _cachedBarrel, _cachedPace] = await Promise.all([
          (!allPositionsDvp && CACHE2) ? buildNbaDvpFromBettingPros(CACHE2).catch(() => null) : allPositionsDvp,
          (!nbaDepthChartPos && CACHE2) ? buildNbaDepthChartPos(CACHE2).catch(() => null) : nbaDepthChartPos,
          (!_cachedBarrel && sportsNeeded.has("mlb")) ? buildBarrelPct().then(async m => { if (CACHE2 && Object.keys(m).length > 0) await CACHE2.put("mlb:barrelPct", JSON.stringify(m), { expirationTtl: 21600 }).catch(() => {}); return m; }).catch(() => null) : _cachedBarrel,
          (!_cachedPace && sportsNeeded.has("nba")) ? buildNbaPaceData(CACHE2).catch(() => null) : _cachedPace
        ]);
        if (sportByteam.mlb && _cachedBarrel) sportByteam.mlb.barrelPctMap = _cachedBarrel;
        const nbaPaceData = _cachedPace;
        const preFilteredMarkets = [];
        const preDropped = [];
        for (const m of qualifyingMarkets) {
          const softData = STAT_SOFT[`${m.sport}|${m.stat}`];
          if (!softData) { preDropped.push({ ...m, reason: "no_soft_data" }); continue; }
          if (m.sport === "mlb") {
            if (!m.gameTeam1 || !m.gameTeam2) { preDropped.push({ ...m, reason: "no_opp" }); continue; }
            if (m.stat === "strikeouts") {
              const _gs26 = sportByteam.mlb?.pitcherGS26?.[m.kalshiPlayerTeam] ?? null;
              const _hasAnchor = sportByteam.mlb?.pitcherHasAnchor?.[m.kalshiPlayerTeam] ?? null;
              // No 2025 anchor (TJ return, pure reliever, etc.): require 8 GS in 2026.
              // Treat null 2026 data as 0 — if the API can't confirm starts, don't trust the model.
              // Has valid 2025 anchor (gs25≥5, bf25≥100): pass through regardless of gs26 — the anchor IS the reliability signal.
              if (_hasAnchor !== true) {
                if ((_gs26 ?? 0) < 8) { preDropped.push({ ...m, reason: "insufficient_starts", gs26: _gs26 ?? 0, hasAnchor: _hasAnchor }); continue; }
              }
              preFilteredMarkets.push(m); continue;
            }
            const playerTeam2 = m.kalshiPlayerTeam;
            if (!playerTeam2) { preDropped.push({ ...m, reason: "no_opp" }); continue; }
            const opp2 = m.gameTeam1 === playerTeam2 ? m.gameTeam2 : m.gameTeam2 === playerTeam2 ? m.gameTeam1 : null;
            if (!opp2) { preDropped.push({ ...m, reason: "no_opp" }); continue; }
            preFilteredMarkets.push(m);
            continue;
          }
          if (m.sport === "nhl") { preFilteredMarkets.push(m); continue; }
          // NBA (and others) — no soft-matchup gate; all markets enter the main loop
          const playerTeam = m.kalshiPlayerTeam;
          if (!playerTeam || !m.gameTeam1 || !m.gameTeam2) { preFilteredMarkets.push(m); continue; }
          const opp = m.gameTeam1 === playerTeam ? m.gameTeam2 : m.gameTeam2 === playerTeam ? m.gameTeam1 : null;
          if (!opp) { preDropped.push({ ...m, reason: "no_opp" }); continue; }
          preFilteredMarkets.push(m);
        }
        // In debug mode, process ALL qualifying markets so every player gets a gamelog fetch and full stats
        const loopMarkets = isDebugMode ? qualifyingMarkets : preFilteredMarkets;
        const uniquePlayerKeys = [...new Map(loopMarkets.map((m) => [`${m.sport}|${m.playerName}`, m])).keys()];
        const playerInfoMap = {};
        const keysNeedingInfo = [];
        if (CACHE2) {
          // Parallel cache reads — serial await per-key was seconds of dead time for large slates
          const pinfoVals = await Promise.all(uniquePlayerKeys.map(k => CACHE2.get(`pinfo:${k}`, "json").catch(() => null)));
          for (let i = 0; i < uniquePlayerKeys.length; i++) {
            const key = uniquePlayerKeys[i], cached = pinfoVals[i];
            if (cached) {
              playerInfoMap[key] = cached;
              if ((cached.position === null || cached.position === "G" || cached.position === "F") && key.startsWith("nba|")) keysNeedingInfo.push(key);
            } else {
              keysNeedingInfo.push(key);
            }
          }
        } else {
          keysNeedingInfo.push(...uniquePlayerKeys);
        }
        const ESPN_SEARCH_HEADERS = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.espn.com/",
          "Accept": "application/json"
        };
        const MAX_PINFO_FETCHES = 150;
        const pInfoErrors = [];
        // Parallel ESPN player-info fetches (pinfo cached 7 days so this is rare on warm caches)
        await Promise.all(keysNeedingInfo.slice(0, MAX_PINFO_FETCHES).map(async key => {
          const [sport, ...nameParts] = key.split("|");
          const playerName = nameParts.join("|");
          try {
            const r = await fetch(
              `${ESPN_BASE}/search/v2?query=${encodeURIComponent(playerName)}&lang=en&region=us&limit=5&type=player`,
              { headers: ESPN_SEARCH_HEADERS, signal: AbortSignal.timeout(5000) }
            );
            if (!r.ok) { pInfoErrors.push({ key, reason: `http_${r.status}` }); return; }
            const d = await r.json();
            const allContents = d.results?.find((x) => x.type === "player")?.contents || [];
            const players = allContents.filter((p2) => p2.defaultLeagueSlug === sport);
            if (!players.length) { pInfoErrors.push({ key, reason: "no_league_match", sport, found: allContents.map((c) => c.defaultLeagueSlug) }); return; }
            const p = players[0];
            const id = p.uid?.split("~a:")?.[1];
            if (!id) { pInfoErrors.push({ key, reason: "no_id", uid: p.uid }); return; }
            const posMatch = (p.description || p.subtitle || "").match(/\b(QB|RB|WR|TE|K|P|PG|SG|SF|PF|Center|Forward|Guard|C|G|F|SP|RP|OF|1B|2B|3B|SS|LW|RW|D)\b/i);
            const rawPos = posMatch ? posMatch[1].toUpperCase() : null;
            const POS_NORMALIZE = { CENTER: "C", GUARD: null, FORWARD: null };
            const info = { id, teamAbbr: "", position: rawPos ? rawPos in POS_NORMALIZE ? POS_NORMALIZE[rawPos] : rawPos === "G" || rawPos === "F" ? null : rawPos : null };
            playerInfoMap[key] = info;
            if (CACHE2) CACHE2.put(`pinfo:${key}`, JSON.stringify(info), { expirationTtl: 604800 }).catch(() => {});
          } catch (e) {
            pInfoErrors.push({ key, reason: "exception", error: String(e) });
          }
        }));
        const isDebug = isDebugMode || params.get("debug") === "true";
        const GAMELOG_API = {
          nba: /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog?season=2026`, "nba"),
          nfl: /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}/gamelog?season=2025`, "nfl"),
          nhl: /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes/${id}/gamelog?season=2026`, "nhl"),
          mlb: /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${id}/gamelog?season=2026`, "mlb")
        };
        const playerGamelogs = {};
        const keysForGamelog = uniquePlayerKeys.filter((k) => playerInfoMap[k]?.id);
        const gamelogErrors = [];
        const keysNeedingGamelog = [];
        const _mlbAbbrNorm = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
        const _normGlOpp = (gl) => gl && gl.events ? { ...gl, events: gl.events.map((ev) => ev.oppAbbr && _mlbAbbrNorm[ev.oppAbbr] ? { ...ev, oppAbbr: _mlbAbbrNorm[ev.oppAbbr] } : ev) } : gl;
        // Two-way players (e.g. Ohtani) need &category=pitching for strikeout markets
        const _pitchPlayerKeys = new Set(loopMarkets.filter(m => m.stat === "strikeouts" && m.sport === "mlb").map(m => `mlb|${m.playerName}`));
        const _pitchGlCacheKey = (k) => glCacheKey(k).replace("242526v2", "242526pv1");
        if (CACHE2) {
          // Parallel cache lookups — serial await per-key was ~100ms × N players = seconds of dead time
          const cachedVals = await Promise.all(keysForGamelog.map(k => CACHE2.get(_pitchPlayerKeys.has(k) ? _pitchGlCacheKey(k) : glCacheKey(k), "json").catch(() => null)));
          for (let i = 0; i < keysForGamelog.length; i++) {
            if (cachedVals[i]) playerGamelogs[keysForGamelog[i]] = keysForGamelog[i].startsWith("mlb|") ? _normGlOpp(cachedVals[i]) : cachedVals[i];
            else keysNeedingGamelog.push(keysForGamelog[i]);
          }
        } else {
          keysNeedingGamelog.push(...keysForGamelog);
        }
        const ESPN_HEADERS = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.espn.com/",
          "Origin": "https://www.espn.com"
        };
        async function parseEspnGamelog(url2, debugKey) {
          try {
            const r = await fetch(url2, { headers: ESPN_HEADERS, signal: AbortSignal.timeout(6000) });
            if (!r.ok) {
              if (isDebug) gamelogErrors.push({ key: debugKey, status: r.status, url: url2 });
              return null;
            }
            const d = await r.json();
            const ul = (d.labels || []).map((l) => (l || "").toUpperCase());
            const reg = (d.seasonTypes || []).find((st) => { const dn = (st.displayName || "").toLowerCase(); return dn.includes("regular") && !dn.includes("play"); }) || (d.seasonTypes || []).find((st) => st.displayName?.toLowerCase().includes("regular")) || (d.seasonTypes?.length === 1 ? d.seasonTypes[0] : null);
            const events = [];
            const seenIds = /* @__PURE__ */ new Set();
            for (const cat of reg?.categories || []) {
              for (const ev of cat.events || []) {
                if (seenIds.has(ev.eventId)) continue;
                const meta = d.events?.[ev.eventId];
                if (!meta || meta.opponent?.isAllStar) continue;
                seenIds.add(ev.eventId);
                events.push({ stats: ev.stats || [], oppAbbr: meta.opponent?.abbreviation || "" });
              }
            }
            return events.length ? { ul, events } : null;
          } catch (e) {
            if (isDebug) gamelogErrors.push({ key: debugKey, err: String(e) });
            return null;
          }
        }
        __name(parseEspnGamelog, "parseEspnGamelog");
        async function fetchGamelog(key, overrideId = null, forcePitching = false) {
          const [sport] = key.split("|");
          const info = playerInfoMap[key];
          const athleteId = overrideId || info?.id;
          if (!athleteId) return;
          if (sport === "mlb") {
            const catSuffix = forcePitching ? "&category=pitching" : "";
            const pSfx = forcePitching ? "p" : "";
            const baseUrl = `https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${athleteId}/gamelog`;
            const key24 = `gl:mlb2024${pSfx}|${key}`;
            const key25 = `gl:mlb2025${pSfx}|${key}`;
            const key26 = `gl:mlb2026${pSfx}|${key}`;
            let [gl24, gl25] = CACHE2 ? await Promise.all([
              CACHE2.get(key24, "json").catch(() => null),
              CACHE2.get(key25, "json").catch(() => null)
            ]) : [null, null];
            const fetchSeasons = [2026];
            if (!gl25) fetchSeasons.push(2025);
            if (!gl24) fetchSeasons.push(2024);
            const results = await Promise.all(fetchSeasons.map((yr) => parseEspnGamelog(`${baseUrl}?season=${yr}${catSuffix}`, key)));
            const seasonResults = Object.fromEntries(fetchSeasons.map((yr, i) => [yr, results[i]]));
            const gl26 = seasonResults[2026] || null;
            if (!gl25) {
              gl25 = seasonResults[2025] || null;
              if (gl25 && CACHE2) await CACHE2.put(key25, JSON.stringify(gl25), { expirationTtl: 86400 });
            }
            if (!gl24) {
              gl24 = seasonResults[2024] || null;
              if (gl24 && CACHE2) await CACHE2.put(key24, JSON.stringify(gl24), { expirationTtl: 86400 });
            }
            if (gl26 && CACHE2) await CACHE2.put(key26, JSON.stringify(gl26), { expirationTtl: 21600 });
            const anyGl = gl26 || gl25 || gl24;
            if (anyGl) {
              const ul = anyGl.ul;
              const _mlbNorm = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
              const normOpp = (o) => _mlbNorm[o] || o;
              const events = [
                ...(gl26?.events || []).map((ev) => ({ ...ev, season: 2026, oppAbbr: normOpp(ev.oppAbbr) })),
                ...(gl25?.events || []).map((ev) => ({ ...ev, season: 2025, oppAbbr: normOpp(ev.oppAbbr) })),
                ...(gl24?.events || []).map((ev) => ({ ...ev, season: 2024, oppAbbr: normOpp(ev.oppAbbr) }))
              ];
              playerGamelogs[key] = { ul, events };
              const combinedKey = forcePitching ? _pitchGlCacheKey(key) : glCacheKey(key);
              if (CACHE2) await CACHE2.put(combinedKey, JSON.stringify({ ul, events }), { expirationTtl: 21600 });
            }
          } else {
            const glUrl = GAMELOG_API[sport]?.(athleteId);
            if (!glUrl) return;
            const gl = await parseEspnGamelog(glUrl, key);
            if (gl) {
              playerGamelogs[key] = gl;
              if (CACHE2) await CACHE2.put(glCacheKey(key), JSON.stringify(gl), { expirationTtl: 21600 });
            }
          }
        }
        __name(fetchGamelog, "fetchGamelog");
        // Fetch all uncached gamelogs in parallel — batching with delays was adding ~26s for 60 players
        const GL_BATCH = 5; // kept for pitcher loop below
        await Promise.all(keysNeedingGamelog.map((k) => fetchGamelog(k, null, _pitchPlayerKeys.has(k))));
        const pitcherGamelogs = {};
        // Merge probables (ESPN source) with pitcherInfoByTeam (MLB Stats API source).
        // pitcherInfoByTeam is more reliable for early-day requests before ESPN announces probables.
        const _allPitcherEntries = new Map();
        for (const [abbr, info] of Object.entries(sportByteam.mlb?.pitcherInfoByTeam || {})) {
          if (info?.name && info?.id) _allPitcherEntries.set(abbr, { name: info.name, id: info.id });
        }
        // ESPN probables take precedence (override MLB API entry with ESPN name/id if available)
        for (const [abbr, info] of Object.entries(sportByteam.mlb?.probables || {})) {
          if (info?.name && info?.id) _allPitcherEntries.set(abbr, { name: info.name, id: info.id });
        }
        const pitcherEntriesToLoad = [..._allPitcherEntries.entries()];
        if (pitcherEntriesToLoad.length > 0) {
          await Promise.all(pitcherEntriesToLoad.map(async ([teamAbbr, { name }]) => {
            const pitcherKey = `mlb|${name}`;
            const cached = CACHE2 ? await CACHE2.get(_pitchGlCacheKey(pitcherKey), "json").catch(() => null) : null;
            if (cached) pitcherGamelogs[teamAbbr] = { name, gl: _normGlOpp(cached) };
          }));
          const uncachedPitchers = pitcherEntriesToLoad.filter(([teamAbbr]) => !pitcherGamelogs[teamAbbr]);
          await Promise.all(uncachedPitchers.map(async ([teamAbbr, { name, id }]) => {
            const pitcherKey = `mlb|${name}`;
            await fetchGamelog(pitcherKey, id, true);
            const gl = playerGamelogs[pitcherKey] || null;
            if (gl) pitcherGamelogs[teamAbbr] = { name, gl };
          }));
        }
        const leagueAvgCache = {};
        for (const key of ["nba|points", "nba|rebounds", "nba|assists", "nba|threePointers", "nhl|points"]) {
          const sd = STAT_SOFT[key];
          if (!sd) continue;
          const vals = Object.values(sd.rankMap).map((r) => r.value).filter((v) => v > 0);
          if (vals.length >= 15) leagueAvgCache[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        // ── Game total: team stat maps (RPG, GPG, PPG) ──────────────────────────────────────────
        const mlbRPGMap = {};
        if (sportByteam.mlb?.batting) {
          const _bt = sportByteam.mlb.batting;
          const _btTop = (_bt.categories || []).find(c => c.name === "batting");
          const _gIdx = (_btTop?.names || []).findIndex(n => n === "G" || n === "GP" || n === "gamesPlayed");
          const _rIdx = (_btTop?.names || []).findIndex(n => n === "R" || n === "runs");
          const _MLB2 = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
          if (_gIdx !== -1 && _rIdx !== -1) {
            for (const team of (_bt.teams || [])) {
              const abbr = _MLB2[team.team?.abbreviation] || team.team?.abbreviation;
              if (!abbr) continue;
              const tc = (team.categories || []).find(c => c.name === "batting");
              const gp = parseFloat(tc?.values?.[_gIdx] ?? 0);
              const runs = parseFloat(tc?.values?.[_rIdx] ?? 0);
              if (gp > 0 && runs > 0) mlbRPGMap[abbr] = parseFloat((runs / gp).toFixed(2));
            }
          }
        }
        const mlbLeagueAvgRPG = (() => { const vals = Object.values(mlbRPGMap).filter(v => v > 0); return vals.length >= 15 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : 4.5; })();
        // Road RPG and team ERA maps (for park-clean lambdas and 60/40 bullpen proxy)
        const mlbRoadRPGMap = sportByteam.mlb?.roadRPGMap || {};
        const mlbTeamERAMap = sportByteam.mlb?.teamERAMap || {};
        const nhlGPGMap = {};
        const nhlGAAMap = {};
        if (sportByteam.nhl) {
          for (const team of (sportByteam.nhl.ga || [])) {
            const abbr = NHL_ABBR_MAP[team.teamId];
            if (!abbr) continue;
            if (team.goalsForPerGame != null) nhlGPGMap[abbr] = parseFloat(team.goalsForPerGame.toFixed(2));
            if (team.goalsAgainstPerGame != null) nhlGAAMap[abbr] = parseFloat(team.goalsAgainstPerGame.toFixed(2));
          }
        }
        const nhlLeagueAvgGAA = leagueAvgCache["nhl|points"] ?? 3.0;
        const nhlLeagueAvgGPG = (() => { const vals = Object.values(nhlGPGMap).filter(v => v > 0); return vals.length >= 15 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : 2.9; })();
        const nbaOffPPGMap = {};
        if (Array.isArray(sportByteam.nbaScoring)) {
          const _NBA2 = { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX" };
          for (const team of sportByteam.nbaScoring) {
            const rawAbbr = team.team?.abbreviation || "";
            const abbr = _NBA2[rawAbbr] || rawAbbr;
            if (!abbr) continue;
            const offCat = (team.categories || []).find(c => { const dn = (c.displayName || c.name || "").toLowerCase(); return dn.includes("offensive") || dn.includes("scoring"); });
            const ppg = parseFloat(offCat?.values?.[0] ?? 0);
            if (ppg > 0) nbaOffPPGMap[abbr] = parseFloat(ppg.toFixed(1));
          }
        }
        const nbaLeagueAvgOffPPG = (() => { const vals = Object.values(nbaOffPPGMap).filter(v => v > 0); return vals.length >= 15 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : 113.0; })();
        // C1: NBA usage rate map (espnId → { usg, source })
        const nbaUsageMap = {};
        // C2: NBA injury report (teamAbbr → [{name, status}])
        let nbaInjuryMap = new Map();
        if (sportsNeeded.has("nba")) {
          const _nbaPlayerIds = [...new Set(
            Object.entries(playerInfoMap)
              .filter(([k]) => k.startsWith("nba|"))
              .map(([, v]) => v?.id)
              .filter(Boolean)
          )];
          const [_usgResult, _injResult] = await Promise.all([
            _nbaPlayerIds.length > 0 ? buildNbaUsageRate(_nbaPlayerIds, CACHE2) : Promise.resolve({}),
            buildNbaInjuryReport(CACHE2)
          ]);
          Object.assign(nbaUsageMap, _usgResult);
          nbaInjuryMap = _injResult;
        }
        const NBA_POS_MAP = {
          PG: "PG",
          "PG/SG": "PG",
          SG: "SG",
          "SG/PG": "SG",
          "SG/SF": "SG",
          SF: "SF",
          "SF/PF": "SF",
          "SF/SG": "SF",
          PF: "PF",
          "PF/SF": "PF",
          "G/F": "PF",
          C: "C",
          "C/PF": "C",
          "PF/C": "C"
          // "G" and "F" are omitted — ambiguous, fall through to roster-based position map
        };
        const playerColCache = {};
        for (const { playerName, sport, col } of loopMarkets) {
          const cacheKey = `${sport}|${playerName}|${col}`;
          if (playerColCache[cacheKey] !== void 0) continue;
          const gl = playerGamelogs[`${sport}|${playerName}`];
          if (!gl) {
            playerColCache[cacheKey] = null;
            continue;
          }
          const colIdx = gl.ul.indexOf(col);
          let getStat, allVals;
          if (colIdx === -1 && col === "TB" && sport === "mlb") {
            const hIdx = gl.ul.indexOf("H"), dIdx = gl.ul.indexOf("2B"), tIdx = gl.ul.indexOf("3B"), hrIdx = gl.ul.indexOf("HR");
            if (hIdx === -1 || dIdx === -1 || tIdx === -1 || hrIdx === -1) {
              playerColCache[cacheKey] = null;
              continue;
            }
            getStat = /* @__PURE__ */ __name((ev) => (parseFloat(ev.stats[hIdx]) || 0) + (parseFloat(ev.stats[dIdx]) || 0) + 2 * (parseFloat(ev.stats[tIdx]) || 0) + 3 * (parseFloat(ev.stats[hrIdx]) || 0), "getStat");
          } else if (colIdx === -1 && col === "HRR" && sport === "mlb") {
            const hIdx = gl.ul.indexOf("H"), rIdx = gl.ul.indexOf("R"), rbiIdx = gl.ul.indexOf("RBI");
            if (hIdx === -1 || rIdx === -1 || rbiIdx === -1) {
              playerColCache[cacheKey] = null;
              continue;
            }
            getStat = /* @__PURE__ */ __name((ev) => (parseFloat(ev.stats[hIdx]) || 0) + (parseFloat(ev.stats[rIdx]) || 0) + (parseFloat(ev.stats[rbiIdx]) || 0), "getStat");
          } else if (colIdx === -1) {
            playerColCache[cacheKey] = null;
            continue;
          } else {
            getStat = /* @__PURE__ */ __name((ev) => parseFloat(ev.stats[colIdx]), "getStat");
          }
          allVals = gl.events.map(getStat).filter((v) => !isNaN(v));
          playerColCache[cacheKey] = { getStat, allVals };
        }
        const plays = [];
        const dropped = [];
        const nbaDropped = [];
        // Tomorrow's ISO date string for gameTime fallback lookup (Kalshi sometimes uses today's date
        // in event tickers for tomorrow's games, so we need to try tomorrow's key when today's misses).
        const _tomorrowISOStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        // Cache pitcher K-count distributions keyed by playerTeam so all thresholds for the same
        // pitcher share one simulation run — guarantees P(K>=4) >= P(K>=5) by construction.
        const pitcherKDistCache = {};
        // Cache NBA stat distributions keyed by playerId|stat so all thresholds share one sim run.
        const nbaPlayerDistCache = {};
        // Cache NHL stat distributions keyed by playerId|stat — same monotonicity guarantee as NBA.
        const nhlPlayerDistCache = {};
        for (const { playerName, playerNameDisplay, sport, stat, col, threshold, kalshiPct, americanOdds, kalshiVolume, kalshiSpread, gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate, lineMove, thinMarket, marketConfidence } of loopMarkets) {
          const key = `${sport}|${playerName}`;
          const info = playerInfoMap[key];
          const gl = playerGamelogs[key];
          if (!info || !gl) {
            if (isDebug) dropped.push({ playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, reason: !info ? "no_espn_info" : "no_gamelog", gameTeam1, gameTeam2, kalshiPlayerTeam });
            continue;
          }
          const softData = STAT_SOFT[`${sport}|${stat}`];
          if (!softData) {
            if (isDebug) dropped.push({ playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, reason: "no_soft_data" });
            continue;
          }
          const { softTeams, rankMap } = softData;
          let playerTeam = kalshiPlayerTeam || info.teamAbbr;
          // For MLB strikeouts: validate team against ESPN probable pitcher name and correct if inverted
          if (sport === "mlb" && stat === "strikeouts" && playerTeam) {
            const probs = sportByteam.mlb?.probables || {};
            const probEntry = probs[playerTeam];
            if (probEntry && normName(probEntry.name || "") !== normName(playerName)) {
              const otherTeam = playerTeam === gameTeam1 ? gameTeam2 : (playerTeam === gameTeam2 ? gameTeam1 : null);
              if (otherTeam && probs[otherTeam] && normName(probs[otherTeam].name || "") === normName(playerName)) {
                playerTeam = otherTeam;
              } else if (info.teamAbbr && (info.teamAbbr === gameTeam1 || info.teamAbbr === gameTeam2)) {
                playerTeam = info.teamAbbr;
              }
            }
          }
          let tonightOpp = null;
          if (gameTeam1 && gameTeam2) {
            if (gameTeam1 === playerTeam) tonightOpp = gameTeam2;
            else if (gameTeam2 === playerTeam) tonightOpp = gameTeam1;
          }
          if (!tonightOpp) {
            if (isDebug) dropped.push({ playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, reason: "no_opp", playerTeam, gameTeam1, gameTeam2 });
            continue;
          }
          // For MLB strikeouts, the player IS the pitcher — name-based lookup is immune to all
          // doubleheader overwrite scenarios (same or different opponent; matchup keys can still
          // collide when both games are vs the same team). Falls back to matchup key, then team key.
          const _ps = sport === "mlb" && stat === "strikeouts"
            ? (sportByteam.mlb?.pitcherStatsByName?.[playerName] ?? null) : null;
          // _pt(map, field): try name-based (_ps.field) first, then team|opp key, then team key
          const _pt = (m, f) => (f != null && _ps?.[f] !== undefined ? _ps[f] : null) ?? (m?.[`${playerTeam}|${tonightOpp}`] ?? null) ?? m?.[playerTeam] ?? null;
          // Base fields included on every drop in this loop
          const _dropBase = { playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, playerTeam };
          // Manual position overrides for known depth-chart misclassifications
          const NBA_POS_OVERRIDES = { "4871144": "C" }; // Alperen Sengun listed as PF in depth chart
          const nbaPos = sport === "nba" ? (NBA_POS_OVERRIDES[String(info.id)] || nbaDepthChartPos?.[String(info.id)] || (info.position ? NBA_POS_MAP[info.position] || null : null)) : null;
          const nbaDvpSoftTeams = sport === "nba" && nbaPos && allPositionsDvp?.[nbaPos]?.softTeams?.[stat] ? new Set(allPositionsDvp[nbaPos].softTeams[stat]) : null;
          const nbaEffectiveSoftTeams = nbaDvpSoftTeams || (sport === "nba" ? softTeams : null);
          if (sport === "nfl" && !softTeams.has(tonightOpp)) {
            if (isDebug) dropped.push({ ..._dropBase, reason: "opp_not_soft", opponent: tonightOpp });
            continue;
          }
          const colCached = playerColCache[`${sport}|${playerName}|${col}`];
          if (!colCached) {
            if (isDebug) dropped.push({ ..._dropBase, reason: "col_not_found", col, headers: gl.ul });
            continue;
          }
          const { getStat, allVals } = colCached;
          if (allVals.length === 0) {
            if (isDebug) dropped.push({ ..._dropBase, reason: "no_gamelog_vals" });
            continue;
          }
          const seasonPct = allVals.filter((v) => v >= threshold).length / allVals.length * 100;
          const hasSeasonTags = sport === "mlb" && gl.events.length > 0 && gl.events[0].season !== void 0;
          const vals26 = hasSeasonTags ? gl.events.filter((ev) => ev.season === 2026).map(getStat).filter((v) => !isNaN(v)) : [];
          const vals25 = hasSeasonTags ? gl.events.filter((ev) => ev.season === 2025).map(getStat).filter((v) => !isNaN(v)) : [];
          // For pitchers, compute total batters faced in 2026 using TBF column, fallback to IP*3.3, fallback to game count*20
          const _tbfIdx = gl.ul.indexOf("TBF");
          const _ipIdx2 = gl.ul.indexOf("IP");
          const _events26 = hasSeasonTags ? gl.events.filter((ev) => ev.season === 2026) : [];
          const _bf26 = sport === "mlb" && stat === "strikeouts"
            ? _tbfIdx !== -1
              ? _events26.reduce((s, ev) => s + (parseFloat(ev.stats[_tbfIdx]) || 0), 0)
              : _ipIdx2 !== -1
              ? _events26.reduce((s, ev) => { const ip = parseFloat(ev.stats[_ipIdx2]) || 0; return s + Math.floor(ip) * 3 + Math.round((ip % 1) * 10); }, 0)
              : vals26.length * 20
            : null;
          const _thresh26 = _bf26 !== null ? _bf26 >= 15 : vals26.length >= 3;
          // Compute pitcher ERA from game log (strikeouts only: player IS the pitcher)
          let _pitcherEraFromGl = null;
          if (sport === "mlb" && stat === "strikeouts" && _ipIdx2 !== -1) {
            const _erIdx = gl.ul.indexOf("ER");
            if (_erIdx !== -1) {
              const _calcEra = (evs) => {
                const tER = evs.reduce((s, ev) => s + (parseFloat(ev.stats[_erIdx]) || 0), 0);
                const tIP = evs.reduce((s, ev) => { const ip = parseFloat(ev.stats[_ipIdx2]) || 0; return s + Math.floor(ip) + (ip % 1) * 10 / 3; }, 0);
                return tIP >= 3 ? parseFloat((tER * 9 / tIP).toFixed(2)) : null;
              };
              _pitcherEraFromGl = _calcEra(_events26) ?? _calcEra(gl.events);
            }
          }
          const pct26 = _thresh26 ? vals26.filter((v) => v >= threshold).length / vals26.length * 100 : null;
          const pct25 = vals25.length >= 5 ? vals25.filter((v) => v >= threshold).length / vals25.length * 100 : null;
          const blendVals = [...vals25, ...vals26];
          const blendedPct = blendVals.length >= 5 ? blendVals.filter((v) => v >= threshold).length / blendVals.length * 100 : null;
          // Prefer 2026 season rate; fall back to blended 25+26; fall back to all-career
          const primaryPct = pct26 ?? blendedPct ?? seasonPct;
          let simScore = null, kpctMeets = null, kpctPts = null, kbbMeets = null, kbbPts = null, lkpMeets = null, lkpPts = null, pitchesPts = null, parkMeets = null, mlPts = null, totalPts = null, kTrendPts = null, kHitRatePts = null, kH2HHandPts = null, _blendedHR = null;
          let _kH2HHandRate = null, _kH2HHandStarts = 0, _kH2HHandMaj = null;
          let _recentKPct = null, _seasonKPct = null;
          let _pitcherHand = null;
          let _avgP = null; // hoisted so all strikeout output sites can use it
          let _avgBF = null; // empirical avg batters faced per start — replaces _avgP / 3.85 when available
          let _umpireName = null;    // E3a: home plate umpire
          let _umpireKFactor = 1.0;  // factor relative to league avg (>1 = high-K zone)
          let _expectedBF = 24;      // E3b: expected batters faced from avg pitch count
          let _earlyExitProb = 0;    // blowout hook: P(pitcher pulled before BF 16) per trial
          let _stdBF = 0;            // std dev of BF per start — widens trialPA distribution in MC
          if (sport === "mlb" && stat === "strikeouts") {
            _pitcherHand = _pt(sportByteam.mlb?.pitcherHand, "hand");
            const _csw = _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct");
            // Gamelog fallback: if schedule-based lookup returns null (e.g. MLB schedule switched to
            // tomorrow and today's pitcher isn't in pitcherByTeam), compute from the player's own
            // ESPN gamelog — immune to schedule confusion since the gamelog IS the player's own data.
            _seasonKPct = _pt(sportByteam.mlb?.pitcherKPct, "kPct") ??
              (_bf26 != null && _bf26 >= 15 ? parseFloat((vals26.reduce((s, v) => s + v, 0) / _bf26 * 100).toFixed(1)) : null);
            // A1: Recent form — blend last 5 starts K% (0.6 weight) with season K% (0.4 weight).
            // Requires 3+ recent starts and 30+ BF to apply; falls back to season K% alone.
            // pitcherRecentKPct is a flat map {team: number}, not nested — use direct access
            const _recKey = `${playerTeam}|${tonightOpp}`;
            _recentKPct = sportByteam.mlb?.pitcherRecentKPct?.[_recKey] ?? sportByteam.mlb?.pitcherRecentKPct?.[playerTeam] ?? null;
            const _pkp = (_recentKPct != null && _seasonKPct != null)
              ? parseFloat((_recentKPct * 0.6 + _seasonKPct * 0.4).toFixed(1))
              : _seasonKPct;
            const _kbb = (() => {
              const v = _pt(sportByteam.mlb?.pitcherKBBPct, "kbbPct");
              if (v != null) return v;
              const _bbi = gl.ul.indexOf("BB");
              if (_bf26 == null || _bf26 < 15 || _bbi === -1) return null;
              const _evs26 = hasSeasonTags ? gl.events.filter(ev => ev.season === 2026) : gl.events;
              const _bb26 = _evs26.reduce((s, e) => s + (parseFloat(e.stats[_bbi]) || 0), 0);
              return parseFloat((vals26.reduce((s, v) => s + v, 0) / _bf26 * 100 - _bb26 / _bf26 * 100).toFixed(1));
            })();
            _avgP = (() => {
              // 1. Name-based (pitcherStatsByName — immune to schedule errors when pitcher is in probables)
              if (_ps?.avgPitches !== undefined) return _ps.avgPitches;
              // 2. ESPN gamelog starts-only (player-specific: uses this player's own gamelog data,
              //    immune to stale/wrong probables that might have another pitcher under the team key).
              //    IP >= 3 is a reliable proxy for starts (starters go 3+ IP; relievers rarely do).
              // ESPN MLB pitcher gamelog uses "P" for pitches; other contexts may use "PC". Try both.
              const _pci = gl.ul.indexOf("PC") !== -1 ? gl.ul.indexOf("PC") : gl.ul.indexOf("P");
              if (_pci !== -1) {
                const _ipIdx = gl.ul.indexOf("IP");
                const _evs26 = hasSeasonTags ? gl.events.filter(ev => ev.season === 2026) : gl.events;
                const _startEvs = _ipIdx !== -1 ? _evs26.filter(e => parseFloat(e.stats[_ipIdx]) >= 3) : _evs26;
                const _pv = _startEvs.map(e => parseFloat(e.stats[_pci])).filter(v => !isNaN(v) && v > 0);
                if (_pv.length >= 1) return parseFloat((_pv.reduce((a, b) => a + b, 0) / _pv.length).toFixed(1));
              }
              // 3. Team key fallback — last resort; may return a different pitcher's value if the
              //    schedule has a stale/wrong probable for this team (e.g. cache built before starter confirmed).
              return _pt(sportByteam.mlb?.pitcherAvgPitches, "avgPitches");
            })();
            // E3a: Umpire K% adjustment — look up home plate ump for this game
            const _gameHome = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? null;
            const _umpKey = _gameHome
              ? (_gameHome === playerTeam ? `${playerTeam}|${tonightOpp}` : `${tonightOpp}|${playerTeam}`)
              : null;
            _umpireName = _umpKey ? (sportByteam.mlb?.umpireByGame?.[_umpKey] ?? null) : null;
            const _normUmpName = n => n ? n.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : n;
            _umpireKFactor = _umpireName ? (UMPIRE_KFACTOR[_normUmpName(_umpireName)] ?? 1.0) : 1.0;
            // E3b: Expected BF — use empirical avgBF when available; fall back to avgP / 3.85 league constant
            _avgBF = (() => {
              if (_ps?.avgBF !== undefined) return _ps.avgBF;
              return _pt(sportByteam.mlb?.pitcherAvgBF, "avgBF");
            })();
            _expectedBF = _avgBF != null
              ? Math.min(27, Math.max(15, Math.round(_avgBF)))
              : (_avgP != null ? Math.min(27, Math.max(15, Math.round(_avgP / 3.85))) : 24);
            const _lkpVR = sportByteam.mlb?.lineupKPctVR?.[tonightOpp] ?? null;
            const _lkpVL = sportByteam.mlb?.lineupKPctVL?.[tonightOpp] ?? null;
            const _lkpAll = sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null;
            const _lkp = _pitcherHand === "R" ? _lkpVR ?? _lkpAll : _pitcherHand === "L" ? _lkpVL ?? _lkpAll : _lkpAll;
            const _homeTeamK = sportByteam.mlb?.gameHomeTeams?.[playerTeam] || tonightOpp;
            const _parkKF = PARK_KFACTOR[_homeTeamK] ?? 1;
            // null = data unavailable (abstains); only known-true metrics contribute points
            // When gs26 < 4, skip raw CSW% (unreliable small sample) and use only regressed K%
            const _gs26 = _pt(sportByteam.mlb?.pitcherGS26, "gs26");
            // Re-check insufficient_starts gate here — pre-filter is bypassed in debug mode (?debug=1)
            const _hasAnchorMain = _pt(sportByteam.mlb?.pitcherHasAnchor, "hasAnchor");
            if (_hasAnchorMain !== true && (_gs26 ?? 0) < 8) {
              if (isDebug) dropped.push({ ..._dropBase, reason: "insufficient_starts", gs26: _gs26 ?? 0, hasAnchor: _hasAnchorMain });
              continue;
            }
            const _useCsw = _csw != null; // use CSW% whenever available; K% only when CSW% is null
            // CSW%/K% tiered (max 2pts): ≥30% CSW or >27% K → 2pts; 26-30% CSW or 24-27% K → 1pt; below → 0pts; null → 1pt abstain
            if (_useCsw) {
              kpctPts = _csw >= 30 ? 2 : _csw > 26 ? 1 : 0;
            } else if (_pkp != null) {
              kpctPts = _pkp > 27 ? 2 : _pkp > 24 ? 1 : 0;
            } else {
              kpctPts = 1; // null → abstain
            }
            kpctMeets = kpctPts > 0;
            // kbbPts tiered: >18% → 2pts, >12% → 1pt, ≤12% → 0pts; null → 1pt (abstain)
            kbbPts = _kbb == null ? 1 : _kbb > 18 ? 2 : _kbb > 12 ? 1 : 0;
            kbbMeets = kbbPts > 0;
            // lkpPts tiered (max 2pts): >24% → 2pts, >22% → 1pt, ≤22% → 0pts; null → 1pt (abstain)
            lkpPts = _lkp == null ? 1 : _lkp > 24 ? 2 : _lkp > 22 ? 1 : 0;
            lkpMeets = lkpPts > 0;
            // pitchesPts/kTrendPts still computed for output fields — no longer in simScore
            pitchesPts = _avgP == null ? 1 : _avgP > 85 ? 2 : _avgP > 75 ? 1 : 0;
            parkMeets = _parkKF > 1.0;
            const _teamML = sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null;
            mlPts = _teamML == null ? 1 : _teamML <= -121 ? 2 : _teamML <= 120 ? 1 : 0;
            // Blowout hook: heavy underdogs have elevated P(early hook) in MC trials.
            // +150→8%, +200→12%, +250+→18%. Null ML (no line yet) = no adjustment.
            _earlyExitProb = _teamML == null ? 0 : _teamML >= 250 ? 0.18 : _teamML >= 200 ? 0.12 : _teamML >= 150 ? 0.08 : 0;
            // stdBF: std dev of BF per start from gamelog — same priority chain as _avgBF.
            // Requires ≥3 NP≥30 starts in mlb.js; 0 when insufficient data → deterministic totalPA.
            _stdBF = _ps?.stdBF || _pt(sportByteam.mlb?.pitcherStdBF, "stdBF") || 0;
            // O/U total (low total = pitcher-friendly): ≤7.5 → 2pts, <10.5 → 1pt, ≥10.5 → 0pts; null → 1pt
            const _gameTotal = sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null;
            totalPts = _gameTotal == null ? 1 : _gameTotal <= 7.5 ? 2 : _gameTotal < 10.5 ? 1 : 0;
            // kTrendPts still computed for output/display — no longer in simScore
            const _kTrendRatio = (_recentKPct != null && _seasonKPct != null && _seasonKPct > 0)
              ? _recentKPct / _seasonKPct : null;
            kTrendPts = _kTrendRatio == null ? 1 : _kTrendRatio >= 1.10 ? 2 : _kTrendRatio >= 0.90 ? 1 : 0;
            // Hit Rate %: 2026 observed starts + 2025 implied (trust-weighted). ≥90%→2, ≥80%→1, <80%→0, null→1
            const _hitRate26 = vals26.length >= 3 ? vals26.filter(v => v >= threshold).length / vals26.length * 100 : null;
            const _hitRate25 = vals25.length >= 5 ? vals25.filter(v => v >= threshold).length / vals25.length * 100 : null;
            const _trust26 = Math.min(1.0, vals26.length / 15);
            _blendedHR = (_hitRate26 != null && _hitRate25 != null)
              ? _trust26 * _hitRate26 + (1 - _trust26) * _hitRate25
              : (_hitRate26 ?? _hitRate25);
            kHitRatePts = _blendedHR == null ? 1 : _blendedHR >= 90 ? 2 : _blendedHR >= 80 ? 1 : 0;
            // kH2HHandPts: pitcher K hit rate vs opponents whose lineup hand majority matches tonight's
            // Tonight's majority = full switch-hitter adjustment (S vs RHP → L, S vs LHP → R)
            const _bnByName = sportByteam.mlb?.batterHandByName || {};
            const _bnNorm = n => n ? n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() : "";
            const _staticHand = sportByteam.mlb?.staticTeamHandMajority || {};
            const _oppSpotMap = sportByteam.mlb?.lineupSpotByName?.[tonightOpp] ?? null;
            let _tonightOppHandMaj = null;
            if (_oppSpotMap) {
              let _rCnt = 0, _lCnt = 0;
              for (const bName of Object.keys(_oppSpotMap)) {
                const bHand = _bnByName[_bnNorm(bName)] ?? null;
                if (bHand === 'R' || (bHand === 'S' && _pitcherHand === 'L')) _rCnt++;
                else if (bHand === 'L' || (bHand === 'S' && _pitcherHand === 'R')) _lCnt++;
              }
              if (_rCnt + _lCnt > 0) _tonightOppHandMaj = _rCnt >= _lCnt ? 'R' : 'L';
            }
            if (!_tonightOppHandMaj) _tonightOppHandMaj = _staticHand[tonightOpp] ?? null;
            const _h2hPitcherStarts = (sportByteam.mlb?.pitcherH2HStarts || {})[playerTeam] ?? [];
            const _h2hHandStarts = _tonightOppHandMaj
              ? _h2hPitcherStarts.filter(s => s.oppAbbr && (_staticHand[s.oppAbbr] ?? null) === _tonightOppHandMaj)
              : _h2hPitcherStarts;
            const _h2hHandHitRate = _h2hHandStarts.length >= 5
              ? _h2hHandStarts.filter(s => s.strikeouts >= threshold).length / _h2hHandStarts.length * 100
              : null;
            kH2HHandPts = _h2hHandHitRate == null ? 1 : _h2hHandHitRate >= 80 ? 2 : _h2hHandHitRate >= 65 ? 1 : 0;
            // Store actual rate + start count for prose display (hoisted to outer scope)
            _kH2HHandRate = _h2hHandHitRate != null ? parseFloat(_h2hHandHitRate.toFixed(1)) : null;
            _kH2HHandStarts = _h2hHandStarts.length;
            _kH2HHandMaj = _tonightOppHandMaj;
            // SimScore (max 10): CSW%/K%→0-2, lineup K%→0-2, hit rate→0-2, H2H hand→0-2, O/U→0-2
            simScore = kpctPts + lkpPts + kHitRatePts + kH2HHandPts + totalPts;
          }
          let softVals, softLabel, softUnit, _hrrUsingTeamFallback = false;
          if (sport === "mlb" && stat === "strikeouts") {
            const allLineupKPctAll = sportByteam.mlb?.lineupKPct || {};
            const allLineupKPctVR = sportByteam.mlb?.lineupKPctVR || {};
            const allLineupKPctVL = sportByteam.mlb?.lineupKPctVL || {};
            // Use hand-adjusted K rates for bucketing (fall back to overall if missing)
            const handLineupKPct = _pitcherHand === "R"
              ? Object.fromEntries(Object.keys(allLineupKPctAll).map(t => [t, allLineupKPctVR[t] ?? allLineupKPctAll[t]]))
              : _pitcherHand === "L"
              ? Object.fromEntries(Object.keys(allLineupKPctAll).map(t => [t, allLineupKPctVL[t] ?? allLineupKPctAll[t]]))
              : allLineupKPctAll;
            const tonightLkp = handLineupKPct[tonightOpp] ?? null;
            // Bucket tonight's opponent K rate: low (<20%), avg (20–24%), high (>=24%)
            const lkpBucket = tonightLkp == null ? null : tonightLkp >= 24 ? "high" : tonightLkp >= 20 ? "avg" : "low";
            const similarKAbbrs = new Set(
              Object.entries(handLineupKPct)
                .filter(([, k]) => lkpBucket === "high" ? k >= 24 : lkpBucket === "avg" ? (k >= 20 && k < 24) : lkpBucket === "low" ? k < 20 : true)
                .map(([a]) => a)
            );
            const _kFilter = (ev) => similarKAbbrs.size > 0 ? similarKAbbrs.has(ev.oppAbbr) : true;
            const _kVals26 = hasSeasonTags ? gl.events.filter((ev) => ev.season === 2026 && _kFilter(ev)).map(getStat).filter((v) => !isNaN(v)) : [];
            const _kVals25 = hasSeasonTags ? gl.events.filter((ev) => ev.season === 2025 && _kFilter(ev)).map(getStat).filter((v) => !isNaN(v)) : [];
            // Compute BF for filtered 2026 events; prefer 2026 if 15+ BF, else add 2025
            const _kBF26 = _tbfIdx !== -1
              ? gl.events.filter((ev) => ev.season === 2026 && _kFilter(ev)).reduce((s, ev) => s + (parseFloat(ev.stats[_tbfIdx]) || 0), 0)
              : _ipIdx2 !== -1
              ? gl.events.filter((ev) => ev.season === 2026 && _kFilter(ev)).reduce((s, ev) => { const ip = parseFloat(ev.stats[_ipIdx2]) || 0; return s + Math.floor(ip) * 3 + Math.round((ip % 1) * 10); }, 0)
              : _kVals26.length * 20;
            const _kValsAll = gl.events.filter(_kFilter).map(getStat).filter((v) => !isNaN(v));
            const _kVals2526 = [..._kVals25, ..._kVals26];
            // allVals = all career starts (pre-computed in playerColCache); use as final fallback
            softVals = (_kBF26 >= 15 && _kVals26.length >= 3) ? _kVals26 : _kVals2526.length >= 3 ? _kVals2526 : _kValsAll.length >= 3 ? _kValsAll : allVals;
            const _handSuffix = _pitcherHand === "R" ? " vs RHP" : _pitcherHand === "L" ? " vs LHP" : "";
            softLabel = lkpBucket === "high" ? `high-K lineups${_handSuffix}` : lkpBucket === "avg" ? `avg-K lineups${_handSuffix}` : lkpBucket === "low" ? `low-K lineups${_handSuffix}` : "career";
            softUnit = "%";
          } else if (sport === "mlb") {
            const pitcherName = pitcherGamelogs[tonightOpp]?.name || null;
            const _pitcherGl = pitcherGamelogs[tonightOpp]?.gl || null;
            const _pitcherDates = _pitcherGl ? new Set(_pitcherGl.events.filter((ev) => ev.oppAbbr === playerTeam).map((ev) => ev.date)) : null;
            const _pitcherVals = (_pitcherDates && _pitcherDates.size > 0)
              ? gl.events.filter((ev) => _pitcherDates.has(ev.date) && ev.oppAbbr === tonightOpp).map(getStat).filter((v) => !isNaN(v))
              : [];
            if (_pitcherVals.length >= 10) {
              // Enough pitcher-specific H2H games (10+ ≈ 30+ PAs; signal is mature)
              softVals = _pitcherVals;
              softLabel = pitcherName ? `vs ${pitcherName}` : `vs ${tonightOpp}`;
            } else {
              // Sparse pitcher H2H (<12 games) → platoon-adjusted fallback (primary path for ~90% of matchups)
              // Flag set so HRR block overrides softPct with platoon-adjusted rate
              softVals = gl.events.filter((ev) => (ev.season === 2025 || ev.season === 2026) && ev.oppAbbr === tonightOpp).map(getStat).filter((v) => !isNaN(v));
              softLabel = `vs ${tonightOpp}`;
              _hrrUsingTeamFallback = true;
            }
            softUnit = "%";
          } else {
            let effectiveSoftSet;
            if (sport === "nba") {
              // DVP-tier matching: bucket opp's rank (1-10 soft / 11-20 neutral / 21-30 hard)
              // and collect all teams in the same tier, giving tier-appropriate context
              const _oppTierRank = rankMap[tonightOpp]?.rank ?? null;
              if (_oppTierRank != null) {
                const _oppTier = _oppTierRank <= 10 ? "soft" : _oppTierRank <= 20 ? "neutral" : "hard";
                effectiveSoftSet = new Set(Object.entries(rankMap)
                  .filter(([, v]) => _oppTier === "soft" ? v.rank <= 10 : _oppTier === "neutral" ? v.rank > 10 && v.rank <= 20 : v.rank > 20)
                  .map(([k]) => k));
              } else {
                effectiveSoftSet = nbaEffectiveSoftTeams || softTeams;
              }
            } else {
              effectiveSoftSet = softTeams;
            }
            softVals = gl.events.filter((ev) => effectiveSoftSet.has(ev.oppAbbr)).map(getStat).filter((v) => !isNaN(v));
            softLabel = null;
            softUnit = null;
          }
          const MIN_H2H = 10;
          // Hoist for both binomial softPct and BA gate below
          const abIdxH = (sport === "mlb" && stat !== "strikeouts") ? gl.ul.indexOf("AB") : -1;
          const blendEventsH = (sport === "mlb" && hasSeasonTags)
            ? gl.events.filter((ev) => ev.season === 2025 || ev.season === 2026)
            : gl.events;
          // Per-game hit rate: % of career games vs tonight's pitcher (or team fallback) where threshold was hit
          // For strikeouts, allow 1+ game (thin samples still shown with "(Xg)" indicator)
          const minSoft = sport === "mlb" && stat === "strikeouts" ? 1 : MIN_H2H;
          let softPct = softVals.length >= minSoft ? softVals.filter((v) => v >= threshold).length / softVals.length * 100 : null;
          const lineupKPctOut = (() => {
            if (sport !== "mlb" || stat !== "strikeouts") return null;
            const vr = sportByteam.mlb?.lineupKPctVR?.[tonightOpp] ?? null;
            const vl = sportByteam.mlb?.lineupKPctVL?.[tonightOpp] ?? null;
            const all = sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null;
            return _pitcherHand === "R" ? vr ?? all : _pitcherHand === "L" ? vl ?? all : all;
          })();
          const lineupKPctProjected = sport === "mlb" && stat === "strikeouts" && lineupKPctOut !== null ? (sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp) : false;
          const pitcherKPctOut = sport === "mlb" && stat === "strikeouts"
            ? (_pt(sportByteam.mlb?.pitcherKPct, "kPct") ?? (_bf26 != null && _bf26 >= 15 ? parseFloat((vals26.reduce((s, v) => s + v, 0) / _bf26 * 100).toFixed(1)) : null))
            : null;
          const pitcherKBBPctOut = sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherKBBPct, "kbbPct") : null;
          let log5AvgOut = null, expectedKsOut = null, parkFactorOut = null, log5PctOut = null, simPctOut = null;
          if (sport === "mlb" && stat === "strikeouts" && pitcherKPctOut !== null) {
            const homeTeam = sportByteam.mlb?.gameHomeTeams?.[playerTeam] || tonightOpp;
            parkFactorOut = PARK_KFACTOR[homeTeam] ?? 1;
            // Prefer ordered per-batter arrays (enables simulation); fall back to unordered
            const ordAll = sportByteam.mlb?.lineupBatterKPctsOrdered?.[tonightOpp] ?? null;
            const ordVR = sportByteam.mlb?.lineupBatterKPctsVROrdered?.[tonightOpp] ?? null;
            const ordVL = sportByteam.mlb?.lineupBatterKPctsVLOrdered?.[tonightOpp] ?? null;
            // When per-batter data is unavailable (lineup not confirmed), synthesize a 9-batter uniform
            // lineup from the hand-adjusted team K% — lets the simulation run and cache the distribution.
            const _lkpForSynth = _pitcherHand === "R" ? (sportByteam.mlb?.lineupKPctVR?.[tonightOpp] ?? sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null) : _pitcherHand === "L" ? (sportByteam.mlb?.lineupKPctVL?.[tonightOpp] ?? sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null) : (sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null);
            const _synthOrd = _lkpForSynth != null ? Array(9).fill(_lkpForSynth / 100) : null;
            const orderedKPcts = (_pitcherHand === "R" ? (ordVR ?? ordAll) : _pitcherHand === "L" ? (ordVL ?? ordAll) : ordAll) ?? _synthOrd;
            const batterKPcts = orderedKPcts ?? (sportByteam.mlb?.lineupBatterKPcts?.[tonightOpp] ?? []);
            if (batterKPcts.length >= 3) {
              const scores = batterKPcts.map((b) => log5K(pitcherKPctOut, b * 100));
              log5AvgOut = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length * 100).toFixed(1));
              const adjustedLog5 = log5AvgOut * parkFactorOut;
              expectedKsOut = parseFloat((adjustedLog5 / 100 * 26).toFixed(1));
              if (orderedKPcts && orderedKPcts.length >= 8) {
                // Use cached distribution for this pitcher so all thresholds share the same sim run
                const _distKey = `${playerTeam}|${_pitcherHand ?? ""}`;
                if (!pitcherKDistCache[_distKey]) {
                  const _nSim = simScore !== null && simScore >= 8 ? 10000 : 5000;
                  const _pitcherKPctAdj = Math.min(40, pitcherKPctOut * _umpireKFactor);
                  pitcherKDistCache[_distKey] = simulateKsDist(orderedKPcts, _pitcherKPctAdj, parkFactorOut, _nSim, _expectedBF, _earlyExitProb, _stdBF);
                }
                simPctOut = kDistPct(pitcherKDistCache[_distKey], threshold);
              } else {
                log5PctOut = parseFloat(log5HitRate(adjustedLog5, threshold).toFixed(1));
              }
            }
          }
          // simScore gate moved here so simPctOut is available for qualified:false push
          let recentAvgOut = null, dvpFactorOut = null, teamDefFactorOut = null, projectedStatOut = null;
          let posDvpRankOut = null, posDvpValueOut = null, posGroupOut = null, oppDvpRatioOut = null;
          if (sport === "nba" || sport === "nhl") {
            const recentVals = gl.events.slice(0, 10).map(getStat).filter((v) => !isNaN(v));
            recentAvgOut = recentVals.length >= 5 ? parseFloat((recentVals.reduce((a, b) => a + b, 0) / recentVals.length).toFixed(2)) : null;
            if (recentAvgOut !== null && rankMap[tonightOpp]?.value != null) {
              const leagueAvg = leagueAvgCache[`${sport}|${stat}`] ?? null;
              if (leagueAvg) {
                dvpFactorOut = parseFloat((rankMap[tonightOpp].value / leagueAvg).toFixed(3));
                teamDefFactorOut = dvpFactorOut; // general team defense (not position-adjusted)
                const adjustedFactor = sport === "nhl" ? dvpFactorOut * 1.06 : dvpFactorOut;
                projectedStatOut = parseFloat((recentAvgOut * adjustedFactor).toFixed(2));
              }
            }
            if (sport === "nba" && allPositionsDvp && nbaPos) {
              if (allPositionsDvp[nbaPos]?.rankings?.[stat]) {
                const ranked = allPositionsDvp[nbaPos].rankings[stat];
                const entry = ranked.find((t) => t.abbr === tonightOpp);
                if (entry) {
                  posGroupOut = nbaPos;
                  posDvpRankOut = entry.rank;
                  posDvpValueOut = parseFloat(entry.avgPts.toFixed(1));
                  oppDvpRatioOut = entry.ratio ?? null;
                  if (recentAvgOut !== null) {
                    const posVals = ranked.map((t) => t.avgPts).filter((v) => v > 0);
                    if (posVals.length >= 15) {
                      const posLeagueAvg = posVals.reduce((a, b) => a + b, 0) / posVals.length;
                      dvpFactorOut = parseFloat((entry.avgPts / posLeagueAvg).toFixed(3));
                      projectedStatOut = parseFloat((recentAvgOut * dvpFactorOut).toFixed(2));
                    }
                  }
                }
              }
            }
          }
          const isHomeGame = sport === "mlb" ? sportByteam.mlb?.gameHomeTeams?.[playerTeam] === playerTeam : sport === "nba" ? sportByteam.nba?.gameHomeTeams?.[playerTeam] === playerTeam : null;
          const yesterday = /* @__PURE__ */ new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = yesterday.toISOString().slice(0, 10);
          const isB2B = (sport === "nba" || sport === "nhl") && gl.events.length > 0 && (gl.events[0]?.date || "").startsWith(yesterdayStr);
          // Provisional truePct for MLB hitter debug drops (computed before gates so all drops can include it)
          let _hlSeasonPct = null, _hlSoftPct = null, _hlTruePct = null, _hlEdge = null;
          if (sport === "mlb" && stat !== "strikeouts" && hasSeasonTags) {
            _hlSeasonPct = parseFloat((primaryPct).toFixed(1));
            _hlSoftPct = softPct !== null ? parseFloat(softPct.toFixed(1)) : null;
            const _hlRaw = _hlSoftPct !== null ? (_hlSeasonPct + _hlSoftPct) / 2 : _hlSeasonPct;
            const _hlHomeTeam = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? tonightOpp;
            const _hlPf = PARK_HITFACTOR?.[_hlHomeTeam] ?? 1;
            _hlTruePct = parseFloat(Math.min(99, _hlRaw * _hlPf).toFixed(1));
            _hlEdge = parseFloat((_hlTruePct - kalshiPct).toFixed(1));
          }
          let hitterBa = null, hitterBaTier = null, hitterAbVsPitcher = 0;
          let hitterSimScore = null, hitterFinalSimScore = null, hitterSimPctOut = null;
          let hitterLineupSpot = null, hitterWhipMeets = null, hitterFipMeets = null, hitterParkMeets = null;
          let pitcherWHIP = null, pitcherFIP = null, pitcherBAA = null;
          let hitterParkKF = null, hitterMoneyline = null, hitterBarrelPct = null;
          let hitterBarrelPts = null, hitterTotalPts = null, hitterGameTotal = null, hitterPlatoonPts = null, hitterOppPitcherHand = null, hitterSplitBA = null, hitterWhipPts = null;
          let hitterOpsPts = null, hitterSeasonHitRatePts = null, hitterH2HHitRatePts = null;
          let hitterPlatoonRatio = null, hitterH2HSource = null;
          let _hitterOps = null; // hoisted — declared in HRR block, referenced in drops/plays outside
          if (sport === "mlb" && stat !== "strikeouts") {
            const hitterML = sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null;
            const hIdx2 = gl.ul.indexOf("H");
            // Compute season BA from blended '25+'26 events (reuse hoisted abIdxH / blendEventsH)
            if (abIdxH !== -1 && hIdx2 !== -1) {
              const totalAB = blendEventsH.reduce((s, ev) => s + (parseFloat(ev.stats[abIdxH]) || 0), 0);
              const totalH = blendEventsH.reduce((s, ev) => s + (parseFloat(ev.stats[hIdx2]) || 0), 0);
              if (totalAB >= 20) {
                hitterBa = parseFloat((totalH / totalAB).toFixed(3));
                hitterBaTier = hitterBa >= 0.300 ? "elite" : hitterBa >= 0.270 ? "good" : hitterBa >= 0.240 ? "avg" : "below";
              }
              const _hAbPitcherGl = pitcherGamelogs[tonightOpp]?.gl || null;
              const _hAbPitcherDates = _hAbPitcherGl ? new Set(_hAbPitcherGl.events.filter((ev) => ev.oppAbbr === playerTeam).map((ev) => ev.date)) : null;
              hitterAbVsPitcher = ((_hAbPitcherDates && _hAbPitcherDates.size > 0)
                ? gl.events.filter((ev) => _hAbPitcherDates.has(ev.date) && ev.oppAbbr === tonightOpp)
                : gl.events.filter((ev) => (ev.season === 2025 || ev.season === 2026) && ev.oppAbbr === tonightOpp)
              ).reduce((s, ev) => s + (parseFloat(ev.stats[abIdxH]) || 0), 0);
            }
            // Lineup spot via name-based lookup (MLB API lineup hydration includes fullName)
            const _spotMap = sportByteam.mlb?.lineupSpotByName?.[playerTeam] ?? null;
            const _brlNorm = n => n ? n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
            if (_spotMap) {
              hitterLineupSpot = _spotMap[_brlNorm(playerName)] ?? _spotMap[_brlNorm(playerNameDisplay)] ?? null;
            }
            // Barrel% from Baseball Savant (keyed by normalized "first last")
            const _brlMap = sportByteam.mlb?.barrelPctMap ?? null;
            if (_brlMap) {
              const _brl = _brlMap[_brlNorm(playerName)] ?? _brlMap[_brlNorm(playerNameDisplay)] ?? null;
              if (_brl != null) hitterBarrelPct = _brl;
            }
            // Pitcher WHIP, FIP, BAA from game log
            const _pgGl = pitcherGamelogs[tonightOpp]?.gl ?? null;
            if (_pgGl) {
              const _glH = _pgGl.ul.indexOf("H");
              const _glBB = _pgGl.ul.indexOf("BB");
              const _glIP = _pgGl.ul.indexOf("IP");
              const _glK = _pgGl.ul.indexOf("K");
              const _glHR = _pgGl.ul.indexOf("HR");
              const _glTBF = _pgGl.ul.indexOf("TBF");
              const _pgEvts = (() => {
                const blend = _pgGl.events.filter(ev => ev.season === 2025 || ev.season === 2026);
                return blend.length >= 3 ? blend : _pgGl.events;
              })();
              const _ipToDecimal = ip => Math.floor(ip) + (ip % 1) * 10 / 3;
              const totalIP = _glIP !== -1 ? _pgEvts.reduce((s, ev) => s + _ipToDecimal(parseFloat(ev.stats[_glIP]) || 0), 0) : 0;
              if (totalIP >= 5) {
                const _pgH = _glH !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glH]) || 0), 0) : 0;
                const _pgBB = _glBB !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glBB]) || 0), 0) : 0;
                const _pgK = _glK !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glK]) || 0), 0) : 0;
                const _pgHR = _glHR !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glHR]) || 0), 0) : 0;
                const _pgTBF = _glTBF !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glTBF]) || 0), 0) : totalIP * 4.33;
                pitcherWHIP = parseFloat(((_pgH + _pgBB) / totalIP).toFixed(2));
                if (_glK !== -1 && _glHR !== -1) pitcherFIP = parseFloat(((13 * _pgHR + 3 * _pgBB - 2 * _pgK) / totalIP + 3.2).toFixed(2));
                if (_pgTBF >= 10) pitcherBAA = parseFloat((_pgH / _pgTBF).toFixed(3));
              }
            }
            // Sim-Score components
            const _hlHomeTeam2 = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? tonightOpp;
            const _hlParkKF2 = PARK_HITFACTOR?.[_hlHomeTeam2] ?? 1;
            const _hlEra = sportByteam.mlb?.probables?.[tonightOpp]?.era ?? sportByteam.mlb?.pitcherEra?.[tonightOpp] ?? null;
            hitterWhipMeets = pitcherWHIP != null ? pitcherWHIP > 1.35 : null;
            // WHIP tiered (max 2pts): >1.35→2pts, >1.20→1pt, ≤1.20→0pts, null→1pt abstain
            hitterWhipPts = pitcherWHIP == null ? 1 : pitcherWHIP > 1.35 ? 2 : pitcherWHIP > 1.20 ? 1 : 0;
            hitterFipMeets = (pitcherFIP != null && _hlEra != null) ? pitcherFIP > _hlEra : null;
            hitterParkMeets = _hlParkKF2 > 1.0;
            hitterParkKF = _hlParkKF2;
            hitterMoneyline = hitterML;
            // B1: Platoon advantage — pitcher hand vs batter hand
            // Opposing pitcher hand (keyed by pitching team)
            const _oppPitcherHand = (sportByteam.mlb?.pitcherHand?.[`${tonightOpp}|${playerTeam}`] ?? sportByteam.mlb?.pitcherHand?.[tonightOpp]) || null;
            hitterOppPitcherHand = _oppPitcherHand;
            // Batter split BA from buildLineupKPct (vsR/vsL, needs 30+ AB)
            const _bsMap = sportByteam.mlb?.batterSplitBA || {};
            const _bsKey = _brlNorm(playerName);
            const _bsEntry = _bsMap[_bsKey] ?? _bsMap[_brlNorm(playerNameDisplay)] ?? null;
            const _splitBA = _oppPitcherHand === "R" ? (_bsEntry?.vsR ?? null) : _oppPitcherHand === "L" ? (_bsEntry?.vsL ?? null) : null;
            const _splitBAPA = _oppPitcherHand === "R" ? (_bsEntry?.vsRPA ?? 0) : _oppPitcherHand === "L" ? (_bsEntry?.vsLPA ?? 0) : 0;
            hitterSplitBA = _splitBA;
            // Platoon ratio kept for output/display only — not used in SimScore
            hitterPlatoonPts = 1; // abstain default
            hitterPlatoonRatio = null;
            if (_splitBA != null && hitterBa != null) {
              hitterPlatoonRatio = parseFloat((_splitBA / hitterBa).toFixed(3));
              hitterPlatoonPts = hitterPlatoonRatio >= 1.10 ? 2 : hitterPlatoonRatio >= 1.00 ? 1 : 0;
            }
            // B2: Batter recent form — last 10 2026 games rolling BA.
            let hitterEffectiveBA = hitterBa;
            if (abIdxH !== -1 && hIdx2 !== -1) {
              const _evs26_recent = hasSeasonTags ? gl.events.filter(ev => ev.season === 2026).slice(0, 10) : gl.events.slice(0, 10);
              const _recentAB = _evs26_recent.reduce((s, ev) => s + (parseFloat(ev.stats[abIdxH]) || 0), 0);
              const _recentH  = _evs26_recent.reduce((s, ev) => s + (parseFloat(ev.stats[hIdx2]) || 0), 0);
              if (_recentAB >= 20 && hitterBa != null) {
                const _recentBA = _recentH / _recentAB;
                hitterEffectiveBA = parseFloat((_recentBA * 0.3 + hitterBa * 0.7).toFixed(3));
              }
            }
            // Barrel% still computed for output/display (not SimScore)
            hitterBarrelPts = hitterBarrelPct == null ? 1 : hitterBarrelPct >= 14 ? 3 : hitterBarrelPct >= 10 ? 2 : hitterBarrelPct >= 7 ? 1 : 0;
            // O/U total tier: ≥9.5→2pts, ≥7.5→1pt, <7.5→0pts, null→1pt
            hitterGameTotal = sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null;
            hitterTotalPts = hitterGameTotal == null ? 1 : hitterGameTotal >= 9.5 ? 2 : hitterGameTotal >= 7.5 ? 1 : 0;
            // OPS (2026 season): ≥.850→2pts, ≥.720→1pt, <.720→0pts, null→1pt abstain
            const _opsMap = sportByteam.mlb?.hitterOpsMap || {};
            const _opsNorm = n => n ? n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() : "";
            _hitterOps = _opsMap[_opsNorm(playerName)] ?? _opsMap[_opsNorm(playerNameDisplay)] ?? null;
            hitterOpsPts = _hitterOps == null ? 1 : _hitterOps >= 0.850 ? 2 : _hitterOps >= 0.720 ? 1 : 0;
            // Blended season hit rate (2026 trust-weighted + 2025): ≥90%→2, ≥80%→1, <80%→0, null→1
            const _hrrHR26 = vals26.length >= 3 ? vals26.filter(v => v >= threshold).length / vals26.length * 100 : null;
            const _hrrHR25 = vals25.length >= 5 ? vals25.filter(v => v >= threshold).length / vals25.length * 100 : null;
            const _hrrTrust26 = Math.min(1.0, vals26.length / 30);
            const _hrrBlendedSeasonHR = (_hrrHR26 != null && _hrrHR25 != null)
              ? _hrrTrust26 * _hrrHR26 + (1 - _hrrTrust26) * _hrrHR25
              : (_hrrHR26 ?? _hrrHR25);
            hitterSeasonHitRatePts = _hrrBlendedSeasonHR == null ? 1 : _hrrBlendedSeasonHR >= 80 ? 2 : _hrrBlendedSeasonHR >= 70 ? 1 : 0;
            // H2H hit rate: ≥10 games vs specific pitcher → BvP; else cross-reference all loaded pitcher gamelogs by handedness
            const _h2hPitcherDates = pitcherGamelogs[tonightOpp]?.gl
              ? new Set(pitcherGamelogs[tonightOpp].gl.events.filter(ev => ev.oppAbbr === playerTeam).map(ev => ev.date))
              : null;
            const _h2hVals = (_h2hPitcherDates && _h2hPitcherDates.size > 0)
              ? gl.events.filter(ev => _h2hPitcherDates.has(ev.date) && ev.oppAbbr === tonightOpp).map(getStat).filter(v => !isNaN(v))
              : [];
            const _h2hHitRate = _h2hVals.length >= 10 ? _h2hVals.filter(v => v >= threshold).length / _h2hVals.length * 100 : null;
            // Handedness fallback: vsR/vsL HRR splits from MLB Stats API (Poisson approx: 1 - e^(-lambda))
            // Covers all 2025+2026 games vs same-hand pitchers — far broader than pitcherGamelogs cross-reference
            let _h2hHandRate = null;
            if (_h2hHitRate == null && _oppPitcherHand) {
              const _hrrSplitMap = sportByteam.mlb?.batterHRRSplits || {};
              const _hrrEntry = _hrrSplitMap[_bsKey] ?? _hrrSplitMap[_brlNorm(playerNameDisplay)] ?? null;
              const _hrrHandKey = _oppPitcherHand === "R" ? "vsR" : "vsL";
              const _hrrSplit = _hrrEntry?.[_hrrHandKey] ?? null;
              if (_hrrSplit && _hrrSplit.g >= 10) {
                const _lambda = _hrrSplit.hrr / _hrrSplit.g;
                _h2hHandRate = parseFloat(((1 - Math.exp(-_lambda)) * 100).toFixed(1));
                softPct = _h2hHandRate;
                softLabel = _oppPitcherHand === "R" ? "vs RHP" : "vs LHP";
              }
            }
            const _effectiveHitRate = _h2hHitRate ?? _h2hHandRate;
            hitterH2HHitRatePts = _effectiveHitRate == null ? 1
              : _effectiveHitRate >= 80 ? 2
              : _effectiveHitRate >= 70 ? 1
              : 0;
            hitterH2HSource = _h2hHitRate != null ? 'bvp' : _h2hHandRate != null ? 'hand' : 'abstain';
            // Refresh _hlSoftPct/_hlTruePct/_hlEdge with post-Poisson live softPct (was captured stale before this block)
            _hlSoftPct = softPct !== null ? parseFloat(softPct.toFixed(1)) : null;
            if (_hlSeasonPct !== null) {
              const _hlRawPost = _hlSoftPct !== null ? (_hlSeasonPct + _hlSoftPct) / 2 : _hlSeasonPct;
              const _hlHomePost = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? tonightOpp;
              const _hlPfPost = PARK_HITFACTOR?.[_hlHomePost] ?? 1;
              _hlTruePct = parseFloat(Math.min(99, _hlRawPost * _hlPfPost).toFixed(1));
              _hlEdge = parseFloat((_hlTruePct - kalshiPct).toFixed(1));
            }
            // SimScore (max 10): OPS→0-2, WHIP→0-2, season hit rate→0-2, H2H hit rate→0-2, O/U→0-2
            hitterSimScore = (hitterOpsPts ?? 1)
              + (hitterWhipPts ?? 0)
              + hitterSeasonHitRatePts
              + hitterH2HHitRatePts
              + hitterTotalPts;
            const _hlPitcherName = sportByteam.mlb?.probables?.[tonightOpp]?.name ?? null;
            const _hlML = hitterML;
            const _hlCommon = { opponent: tonightOpp, pitcherName: _hlPitcherName, seasonPct: _hlSeasonPct, softPct: _hlSoftPct, truePct: _hlTruePct, edge: _hlEdge, pitcherEra: _hlEra, moneyline: _hlML, hitterBa, hitterBaTier, abVsTeam: hitterAbVsPitcher, hitterLineupSpot, pitcherWHIP, pitcherFIP, hitterSimScore, hitterParkKF, hitterMoneyline, hitterBarrelPct, hitterBarrelPts, hitterTotalPts, hitterGameTotal, hitterPlatoonPts, hitterPlatoonRatio, hitterH2HSource, hitterSoftLabel: softLabel ?? void 0, hitterOps: _hitterOps, hitterOpsPts, hitterSeasonHitRatePts, hitterH2HHitRatePts, oppPitcherHand: _oppPitcherHand, hitterSplitBA: _splitBA, hitterWhipPts };
            // Stage 1: lineup spot 5-9 discard
            if (hitterLineupSpot !== null && hitterLineupSpot >= 6) {
              if (isDebug) dropped.push({ ..._dropBase, reason: "low_lineup_spot", hitterLineupSpot, ..._hlCommon });
              continue;
            }
            // Stage 2: sim-score gate
            if (hitterSimScore < 5) {
              if (isDebug) dropped.push({ ..._dropBase, reason: "low_confidence", hitterSimScore, ..._hlCommon });
              continue;
            }
            // Monte Carlo simulation for hits stat when effectiveBA and pitcherBAA available (B2 feeds this)
            if (stat === "hits" && hitterEffectiveBA != null && pitcherBAA != null) {
              const _nSimH = hitterSimScore >= 8 ? 10000 : 1000;
              hitterSimPctOut = simulateHits(hitterEffectiveBA, pitcherBAA, _hlParkKF2, threshold, _nSimH);
            }
          }
          // NBA: pre-edge SimScore + Monte Carlo simulation (runs before rawTruePct)
          let nbaSimPctOut = null, nbaPreSimScore = null, nbaPaceAdj = null, nbaOpportunity = null, nbaTotalPts = null, nbaGameTotal = null;
          let nbaBlowoutAdj = null, nbaSplitAdj = null, nbaMiscAdj = 1.0, nba3pMPG = null;
          if (sport === "nba") {
            let _sc = 0;
            // Pace: computed for display/simulation; no longer scored separately (combined with total below)
            if (nbaPaceData) {
              const _tp = nbaPaceData.teamPace?.[playerTeam] ?? null;
              const _op = nbaPaceData.teamPace?.[tonightOpp] ?? null;
              if (_tp !== null && _op !== null) {
                nbaPaceAdj = parseFloat(((_tp + _op) / 2 - (nbaPaceData.leagueAvgPace ?? 100)).toFixed(1));
              }
            }
            // AvgMin computed for display
            const _minIdx = gl.ul.indexOf("MIN");
            if (_minIdx !== -1) {
              const _minVals = gl.events.slice(0, 10).map(ev => parseFloat(ev.stats[_minIdx])).filter(v => !isNaN(v) && v > 0);
              if (_minVals.length >= 3) {
                nbaOpportunity = parseFloat((_minVals.reduce((a, b) => a + b, 0) / _minVals.length).toFixed(1));
              }
            }
            const _usgEntry = nbaUsageMap[String(info.id)] ?? null;
            const _usg = _usgEntry?.usg ?? null;
            const _avgAst = _usgEntry?.avgAst ?? null;
            const _avgReb = _usgEntry?.avgReb ?? null;
            // 1. C1: stat-appropriate opportunity signal (max 2pts, rescaled)
            // points/assists/threePointers: USG% ≥28→2, ≥22→1, else 0, null→1 abstain
            // rebounds: avgMin ≥30→2, ≥25→1, else 0, null→1 abstain
            if (stat === "threePointers") {
              const _3pIdx = gl.ul.indexOf("3P");
              if (_3pIdx !== -1) {
                const _3pVals = gl.events.slice(0, 10).map(ev => parseFloat(ev.stats[_3pIdx])).filter(v => !isNaN(v) && v >= 0);
                if (_3pVals.length >= 3) nba3pMPG = parseFloat((_3pVals.reduce((a, b) => a + b, 0) / _3pVals.length).toFixed(2));
              }
              _sc += _usg == null ? 1 : _usg >= 28 ? 2 : _usg >= 22 ? 1 : 0;
            } else if (stat === "rebounds") {
              _sc += nbaOpportunity == null ? 1 : nbaOpportunity >= 30 ? 2 : nbaOpportunity >= 25 ? 1 : 0;
            } else {
              _sc += _usg == null ? 1 : _usg >= 28 ? 2 : _usg >= 22 ? 1 : 0;
            }
            // 2. DVP — position-adjusted ratio tiers: ≥1.05→2pts, ≥1.02→1pt, else→0pts (unchanged)
            const _dvpPts = oppDvpRatioOut == null ? 0 : oppDvpRatioOut >= 1.05 ? 2 : oppDvpRatioOut >= 1.02 ? 1 : 0;
            _sc += _dvpPts;
            // 3. Season hit rate (primaryPct = blended 2026/2025/career): ≥90%→2, ≥80%→1, <80%→0
            const _nbaSeasonHRPts = primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0;
            _sc += _nbaSeasonHRPts;
            // 4. DVP-tier hit rate (vs teams in same DVP tier as tonight's opp): ≥90%→2, ≥80%→1, <80%→0, null→1 abstain
            const _nbaSoftHRPts = softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0;
            _sc += _nbaSoftHRPts;
            // 5. O/U line: ≥215 → 2pts; null → 1pt abstain; <215 → 0pts
            nbaGameTotal = (sportByteam.nbaGameOdds ?? {})[playerTeam]?.total ?? null;
            nbaTotalPts = nbaGameTotal === null ? 1 : nbaGameTotal >= 215 ? 2 : 0;
            _sc += nbaTotalPts;
            nbaPreSimScore = _sc;
            // C3: Blowout risk — downward adj when spread implies likely blowout (|spread|>10)
            const _nbaSpread = (sportByteam.nbaGameOdds ?? {})[playerTeam]?.spread ?? null;
            if (_nbaSpread != null) {
              const _absSpread = Math.abs(_nbaSpread);
              nbaBlowoutAdj = _absSpread > 10 ? Math.max(0.85, 1 - (_absSpread - 10) * 0.007) : 1.0;
            }
            // C4: Home/away splits — blend location-specific avg with overall avg (0.7/0.3)
            const _isHomeGame2 = sportByteam.nba?.gameHomeTeams?.[playerTeam] === playerTeam;
            const _nbaGameValsAll = gl.events.map(getStat).filter(v => !isNaN(v) && v >= 0);
            if (_nbaGameValsAll.length >= 10) {
              const _locVals = gl.events.filter(ev => (ev.isHome === _isHomeGame2)).map(getStat).filter(v => !isNaN(v) && v >= 0);
              if (_locVals.length >= 5) {
                const _overallMean = _nbaGameValsAll.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, _nbaGameValsAll.length);
                const _locMean = _locVals.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, _locVals.length);
                const _splitMean = _locMean * 0.7 + _overallMean * 0.3;
                nbaSplitAdj = _overallMean > 0 ? parseFloat((_splitMean / _overallMean).toFixed(3)) : null;
              }
            }
            // Combine miscAdj: C2 (injury boost) × C3 (blowout) × C4 (split)
            // C2: if teammates are out, apply boost (1.08 per out player, capped at 1.15)
            const _injuredTeammates = nbaInjuryMap.get(playerTeam) || [];
            const _injBoost = _injuredTeammates.length > 0 ? Math.min(1.15, 1 + _injuredTeammates.length * 0.08) : 1.0;
            nbaMiscAdj = _injBoost * (nbaBlowoutAdj ?? 1.0) * (nbaSplitAdj ?? 1.0);
            // Shared distribution per player+stat — all thresholds query the same run.
            // miscAdj key component ensures we don't reuse a stale dist if adjustments differ.
            const _nbaDistKey = `${info.id}|${stat}`;
            if (!nbaPlayerDistCache[_nbaDistKey]) {
              const _nSim = _sc >= 8 ? 10000 : _sc >= 5 ? 5000 : 2000;
              nbaPlayerDistCache[_nbaDistKey] = buildNbaStatDist(_nbaGameValsAll, teamDefFactorOut, nbaPaceAdj, isB2B, _nSim, nbaMiscAdj);
            }
            nbaSimPctOut = nbaDistPct(nbaPlayerDistCache[_nbaDistKey], threshold);
          }
          // NHL: pre-edge SimScore + Monte Carlo simulation (same normal-distribution approach as NBA)
          let nhlSimPctOut = null, nhlPreSimScore = null, nhlShotsAdj = null, nhlOpportunity = null, nhlSaRank = null, nhlTeamGPG = null;
          let nhlGameTotal = null, nhlSeasonHitRatePts = null, nhlDvpHitRatePts = null;
          if (sport === "nhl") {
            let _sc = 0;
            // SA rank still computed for display/output
            if (nhlLeagueAvgSa !== null && nhlSaRankMap[tonightOpp]?.value != null) {
              nhlShotsAdj = parseFloat((nhlSaRankMap[tonightOpp].value - nhlLeagueAvgSa).toFixed(1));
              nhlSaRank = nhlSaRankMap[tonightOpp]?.rank ?? null;
            }
            // 1. Ice time (TOI, max 2pts): ≥18 min → 2pts, ≥15 min → 1pt, else 0pts, null → 0pts
            const _toiIdx = gl.ul.findIndex(h => h === "TOI" || h === "timeOnIce");
            if (_toiIdx !== -1) {
              const _toiVals = gl.events.slice(0, 10).map(ev => {
                const s = ev.stats[_toiIdx];
                if (s == null) return NaN;
                const str = String(s);
                if (str.includes(':')) { const [m2, sec] = str.split(':'); return parseInt(m2, 10) + parseInt(sec, 10) / 60; }
                return parseFloat(str);
              }).filter(v => !isNaN(v) && v > 0);
              if (_toiVals.length >= 3) {
                nhlOpportunity = parseFloat((_toiVals.reduce((a, b) => a + b, 0) / _toiVals.length).toFixed(1));
                if (nhlOpportunity >= 18) _sc += 2;
                else if (nhlOpportunity >= 15) _sc += 1;
              }
            }
            // 2. Opponent GAA rank (max 2pts): ≤10→2, ≤15→1, else 0
            const _gaaRank = rankMap[tonightOpp]?.rank ?? null;
            if (_gaaRank !== null) _sc += _gaaRank <= 10 ? 2 : _gaaRank <= 15 ? 1 : 0;
            // 3. Season hit rate (all career games): ≥90%→2, ≥80%→1, <80%→0
            nhlSeasonHitRatePts = seasonPct >= 90 ? 2 : seasonPct >= 80 ? 1 : 0;
            _sc += nhlSeasonHitRatePts;
            // 4. DVP hit rate (games vs teams with GAA > league avg): ≥90%→2, ≥80%→1, <80%→0, null→1 abstain
            const _nhlDvpVals = gl.events
              .filter(ev => { const gaa = nhlGAAMap[ev.oppAbbr] ?? null; return gaa !== null && gaa > (nhlLeagueAvgGAA ?? 0); })
              .map(getStat).filter(v => !isNaN(v) && v >= 0);
            const _nhlDvpHR = _nhlDvpVals.length >= 3 ? _nhlDvpVals.filter(v => v >= threshold).length / _nhlDvpVals.length * 100 : null;
            nhlDvpHitRatePts = _nhlDvpHR == null ? 1 : _nhlDvpHR >= 90 ? 2 : _nhlDvpHR >= 80 ? 1 : 0;
            _sc += nhlDvpHitRatePts;
            // 5. Game total (replaces B2B): ≥7→2, ≥5.5→1, <5.5→0, null→1 abstain
            nhlGameTotal = sportByteam.nhlGameOdds?.[playerTeam]?.total ?? sportByteam.nhlGameOdds?.[tonightOpp]?.total ?? null;
            const _nhlTotalPts = nhlGameTotal == null ? 1 : nhlGameTotal >= 7 ? 2 : nhlGameTotal >= 5.5 ? 1 : 0;
            _sc += _nhlTotalPts;
            // Team GPG still computed for output/display
            const _teamGPG = nhlGPGMap[playerTeam] ?? null;
            nhlTeamGPG = _teamGPG;
            nhlPreSimScore = _sc;
            // D3: TOI trend — compare recent 3 games TOI vs season avg (last 10).
            // If trending up (>5% more), boost mean; if trending down (>5% less), reduce.
            let nhlToiTrendAdj = 1.0;
            if (_toiIdx !== -1 && nhlOpportunity != null) {
              const _parseTOI = s => {
                if (s == null) return NaN;
                const str = String(s);
                if (str.includes(':')) { const [m2, sec] = str.split(':'); return parseInt(m2, 10) + parseInt(sec, 10) / 60; }
                return parseFloat(str);
              };
              const _recent3TOI = gl.events.slice(0, 3).map(ev => _parseTOI(ev.stats[_toiIdx])).filter(v => !isNaN(v) && v > 0);
              if (_recent3TOI.length >= 2) {
                const _recentAvgTOI = _recent3TOI.reduce((a, b) => a + b, 0) / _recent3TOI.length;
                const _toiRatio = _recentAvgTOI / nhlOpportunity;
                // +/- 5% band: above → boost up to +8%; below → cut up to -8%
                nhlToiTrendAdj = _toiRatio > 1.05 ? Math.min(1.08, _toiRatio) : _toiRatio < 0.95 ? Math.max(0.92, _toiRatio) : 1.0;
              }
            }
            // Shared distribution per player+stat — all thresholds query the same sim run
            const _nhlDistKey = `${info.id}|${stat}`;
            if (!nhlPlayerDistCache[_nhlDistKey]) {
              const _nhlGameVals = gl.events.map(getStat).filter(v => !isNaN(v) && v >= 0);
              const _nSim = _sc >= 8 ? 10000 : _sc >= 5 ? 5000 : 2000;
              nhlPlayerDistCache[_nhlDistKey] = buildNbaStatDist(_nhlGameVals, teamDefFactorOut, nhlShotsAdj, isB2B, _nSim, nhlToiTrendAdj);
            }
            nhlSimPctOut = nbaDistPct(nhlPlayerDistCache[_nhlDistKey], threshold);
          }
          const rawTruePct = (() => {
            if (sport === "mlb" && stat === "strikeouts") {
              // Simulation is the primary model when lineup data is available
              if (simPctOut !== null) return simPctOut;
              // Fallback: average of season rate + soft matchup rate
              const parts = [primaryPct, ...softPct !== null ? [softPct] : []];
              return parts.reduce((a, b) => a + b, 0) / parts.length;
            }
            if (sport === "mlb" && hasSeasonTags) {
              if (hitterSimPctOut !== null) return hitterSimPctOut;
              const basePct = primaryPct;
              const rawMlbPct = softPct !== null ? (basePct + softPct) / 2 : basePct;
              const homeTeam = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? tonightOpp;
              const parkFactor = PARK_HITFACTOR[homeTeam] ?? 1;
              const _p = Math.max(0.01, Math.min(0.99, rawMlbPct / 100));
              const _logOddsAdj = Math.log(_p / (1 - _p)) + Math.log(parkFactor);
              return Math.min(99.9, parseFloat((100 / (1 + Math.exp(-_logOddsAdj))).toFixed(1)));
            }
            if (sport === "nba") {
              // Monte Carlo simulation is primary model; fall back to season/soft blend
              if (nbaSimPctOut !== null) return nbaSimPctOut;
              let base = softPct !== null ? (seasonPct + softPct) / 2 : seasonPct;
              if (isB2B) base = Math.max(0, base - 4);
              return base;
            }
            if (sport === "nhl") {
              // Monte Carlo simulation is primary model; fall back to dvp-adjusted average
              if (nhlSimPctOut !== null) return nhlSimPctOut;
              if (dvpFactorOut !== null) {
                const dvpAdjustedPct = Math.min(99, seasonPct * dvpFactorOut);
                const _nhlParts = [seasonPct, dvpAdjustedPct, ...softPct !== null ? [softPct] : []];
                let result = _nhlParts.reduce((a, b) => a + b, 0) / _nhlParts.length;
                if (isB2B) result = Math.max(0, result - 4);
                return result;
              }
            }
            let base = softPct !== null ? (seasonPct + softPct) / 2 : seasonPct;
            if (isB2B) base = Math.max(0, base - 4);
            return base;
          })();
          let truePct = rawTruePct;
          // A2: Pitcher rest/fatigue — apply downward multiplier when pitcher is on short rest
          // or threw a high pitch count. Uses daysSinceLastStart + lastStartPC from mlb.js.
          // fatigueAdj ∈ [0.92, 1.0]: high-PC short-rest starts get ~0.92; normal rest = 1.0.
          if (sport === "mlb" && stat === "strikeouts") {
            const _lastDate = _pt(sportByteam.mlb?.pitcherLastStartDate, "lastStartDate");
            const _lastPC   = _pt(sportByteam.mlb?.pitcherLastStartPC,   "lastStartPC");
            if (_lastDate) {
              const _daysDiff = Math.round((Date.now() - new Date(_lastDate).getTime()) / 86400000);
              // Short rest = 3 or fewer days between starts (typical = 4-5 days)
              const _isShortRest = _daysDiff <= 3;
              // High pitch count last start = depleted arm (95+ pitches is taxing at short rest)
              const _highPC = _lastPC != null && _lastPC >= 95;
              if (_isShortRest && _highPC) {
                truePct = Math.max(0, truePct * 0.92);
              } else if (_isShortRest) {
                truePct = Math.max(0, truePct * 0.96);
              }
            }
          }
          const lowVolume = kalshiVolume < 50;
          const rawEdge = truePct - kalshiPct;
          const spreadAdj = kalshiSpread != null ? kalshiSpread / 2 : 0;
          // kalshiPct is already the fill price (yes_ask or blended orderbook); no additional
          // spread deduction needed — spreading the edge by half-spread double-penalizes.
          const edge = rawEdge;
          // finalSimScore = simScore (total/ML already baked in; edge gates separately)
          const finalSimScore = (sport === "mlb" && stat === "strikeouts" && simScore !== null)
            ? simScore
            : null;
          // HRR/hits: edge is a gate only (≥3% required), not part of simScore — max 14 like strikeouts
          hitterFinalSimScore = (sport === "mlb" && stat !== "strikeouts" && hitterSimScore !== null)
            ? hitterSimScore
            : null;
          // NBA SimScore — edge is a gate only (≥3% required), not part of simScore — max 14 like strikeouts
          let nbaSimScore = null;
          if (sport === "nba" && nbaPreSimScore !== null) {
            nbaSimScore = nbaPreSimScore;
          }
          // NHL SimScore — edge is a gate only (not scored), same pattern as NBA/MLB
          let nhlSimScore = null;
          if (sport === "nhl" && nhlPreSimScore !== null) {
            nhlSimScore = nhlPreSimScore;
          }
          if (kalshiPct < 70 || edge < 5) {
            const _dropObj = {
              ..._dropBase,
              truePct: parseFloat(truePct.toFixed(1)), rawTruePct: parseFloat(rawTruePct.toFixed(1)),
              edge: parseFloat(edge.toFixed(1)),
              reason: edge < 5 ? "edge_too_low" : "kalshi_pct_too_low",
              opponent: tonightOpp, seasonPct: parseFloat((primaryPct).toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              posDvpRank: posDvpRankOut, dvpRatio: oppDvpRatioOut, posGroup: posGroupOut,
              ...(sport === "mlb" && stat === "strikeouts" ? {
                simScore, finalSimScore,
                parkFactor: parkFactorOut,
                gameMoneyline: sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null,
                gameTotal: sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null,
                pitcherCSWPct: _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct"),
                pitcherKBBPct: _pt(sportByteam.mlb?.pitcherKBBPct, "kbbPct"),
                pitcherRecentKPct: _recentKPct, pitcherSeasonKPct: _seasonKPct,
                lineupKPct: lineupKPctOut, pitcherAvgPitches: _avgP,
                expectedBF: _expectedBF !== 24 ? _expectedBF : null,
                kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts, kHitRatePts, kH2HHandPts, kH2HHandRate: _kH2HHandRate, kH2HHandStarts: _kH2HHandStarts, kH2HHandMaj: _kH2HHandMaj, blendedHitRate: _blendedHR != null ? parseFloat(_blendedHR.toFixed(1)) : null,
              } : {}),
              ...(sport === "mlb" && stat !== "strikeouts" ? {
                hitterSimScore, hitterFinalSimScore,
                hitterLineupSpot, pitcherWHIP, pitcherFIP, hitterParkKF, hitterMoneyline, hitterBarrelPct,
                hitterBarrelPts, hitterTotalPts, hitterGameTotal, hitterPlatoonPts,
                hitterPlatoonRatio: hitterPlatoonRatio ?? undefined,
                hitterH2HSource: hitterH2HSource ?? undefined,
                hitterOps: _hitterOps ?? undefined, hitterOpsPts, hitterSeasonHitRatePts, hitterH2HHitRatePts,
                hitterBa: hitterBa !== null ? hitterBa : undefined,
                hitterBaTier: hitterBaTier ?? undefined,
                hitterWhipPts, hitterSplitBA,
                oppPitcherHand: hitterOppPitcherHand ?? undefined,
                hitterSoftLabel: softLabel ?? undefined,
                softGames: softVals.length,
                hitterPitcherName: sportByteam.mlb?.probables?.[tonightOpp]?.name ?? sportByteam.mlb?.pitcherInfoByTeam?.[tonightOpp]?.name ?? pitcherGamelogs[tonightOpp]?.name ?? null,
                hitterPitcherEra: sportByteam.mlb?.probables?.[tonightOpp]?.era ?? sportByteam.mlb?.pitcherEra?.[tonightOpp] ?? null,
              } : {}),
              ...(sport === "nba" ? {
                nbaSimScore, nbaPreSimScore, nbaSimPct: nbaSimPctOut, nbaPaceAdj, nbaOpportunity, isB2B,
                nbaGameTotal, nbaTotalPts, nba3pMPG, nbaBlowoutAdj, nbaSplitAdj,
                nbaSeasonHitRatePts: primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0,
                nbaSoftHitRatePts: softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0,
                posDvpValue: posDvpValueOut,
                nbaUsage: nbaUsageMap[String(info.id)]?.usg ?? null,
                nbaAvgAst: nbaUsageMap[String(info.id)]?.avgAst ?? null,
                nbaAvgReb: nbaUsageMap[String(info.id)]?.avgReb ?? null,
              } : {}),
              ...(sport === "nhl" ? { nhlSimScore, nhlPreSimScore, nhlSimPct: nhlSimPctOut, nhlShotsAdj, nhlOpportunity, nhlTeamGPG, nhlSaRank, nhlGameTotal, nhlSeasonHitRatePts, nhlDvpHitRatePts, isB2B } : {}),
            };
            if (isDebug) dropped.push(_dropObj);
            // For all player prop sports: include in plays with qualified:false so player card
            // explanation renders even when the play fails edge or other gates.
            const _qualFalseBase = {
              ..._dropObj,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: !(sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp),
              playerStatus: null,
            };
            if (sport === "mlb" || sport === "nba" || sport === "nhl") plays.push(_qualFalseBase);
            continue;
          }
          // Threshold sanity gate: reject plays where the threshold far exceeds expected Ks.
          // Even with good edge, a threshold 3+ above the model mean is a high-variance long shot.
          // Only applies when expectedKsOut is available (lineup confirmed); skipped when null.
          if (sport === "mlb" && stat === "strikeouts" && expectedKsOut != null && threshold > Math.ceil(expectedKsOut) + 2) {
            const _kTruePct = parseFloat((simPctOut ?? (softPct !== null ? (primaryPct + softPct) / 2 : primaryPct)).toFixed(1));
            const _dropThresh = {
              ..._dropBase,
              reason: "threshold_too_high",
              simScore, finalSimScore, expectedKs: expectedKsOut, threshold,
              opponent: tonightOpp,
              kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, lkpPts, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts, kHitRatePts, kH2HHandPts, kH2HHandRate: _kH2HHandRate, kH2HHandStarts: _kH2HHandStarts, kH2HHandMaj: _kH2HHandMaj, blendedHitRate: _blendedHR != null ? parseFloat(_blendedHR.toFixed(1)) : null,
              seasonPct: parseFloat(primaryPct.toFixed(1)), softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: _kTruePct, edge: parseFloat((_kTruePct - kalshiPct).toFixed(1)),
              pitcherKPct: pitcherKPctOut, pitcherAvgPitches: _avgP,
              expectedBF: _expectedBF !== 24 ? _expectedBF : null,
              pitcherHand: _pitcherHand ?? null, simPct: simPctOut,
            };
            if (isDebug) dropped.push(_dropThresh);
            plays.push({
              ..._dropThresh,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: _kTruePct,
              log5Pct: simPctOut ?? log5PctOut, simPct: simPctOut,
              spreadAdj: kalshiSpread != null ? parseFloat((kalshiSpread / 2).toFixed(1)) : 0,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: !(sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp),
              playerStatus: null,
            });
            continue;
          }
          // Strikeout finalSimScore gate: must reach >= 11 (Alpha tier) to qualify as a play.
          // Scores 7-10 show in report but marked qualified:false so player card still shows truePct.
          if (sport === "mlb" && stat === "strikeouts" && finalSimScore !== null && finalSimScore < 8) {
            const _dropLowScore = {
              ..._dropBase,
              reason: "low_confidence",
              simScore, finalSimScore,
              opponent: tonightOpp,
              kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, lkpPts, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts, kHitRatePts, kH2HHandPts, kH2HHandRate: _kH2HHandRate, kH2HHandStarts: _kH2HHandStarts, kH2HHandMaj: _kH2HHandMaj, blendedHitRate: _blendedHR != null ? parseFloat(_blendedHR.toFixed(1)) : null,
              seasonPct: parseFloat(primaryPct.toFixed(1)), softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              pitcherCSWPct: _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct"),
              pitcherKPct: pitcherKPctOut, pitcherKBBPct: pitcherKBBPctOut, pitcherRecentKPct: _recentKPct, pitcherSeasonKPct: _seasonKPct,
              pitcherAvgPitches: _avgP,
              expectedBF: _expectedBF !== 24 ? _expectedBF : null,
              lineupKPct: lineupKPctOut,
              pitcherEra: _pitcherEraFromGl ?? _pt(sportByteam.mlb?.pitcherEra, "era") ?? null,
              pitcherHand: _pitcherHand ?? null, simPct: simPctOut,
              parkFactor: parkFactorOut ?? 1,
              gameMoneyline: sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null,
              gameTotal: sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null,
            };
            if (isDebug) dropped.push(_dropLowScore);
            plays.push({
              ..._dropLowScore,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut, simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: !(sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp),
              playerStatus: null,
            });
            continue;
          }
          // NBA SimScore gate: must reach >= 11 (Alpha tier) to qualify as a play
          if (sport === "nba" && nbaSimScore !== null && nbaSimScore < 8) {
            const _nbaLowScoreDrop = {
              ..._dropBase,
              reason: "low_confidence",
              nbaSimScore, nbaPreSimScore,
              opponent: tonightOpp,
              seasonPct: parseFloat(primaryPct.toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              nbaSimPct: nbaSimPctOut, nbaPaceAdj, nbaOpportunity, isB2B,
              nbaGameTotal, nbaTotalPts, nba3pMPG, nbaBlowoutAdj, nbaSplitAdj,
              nbaSeasonHitRatePts: primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0,
              nbaSoftHitRatePts: softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0,
              posDvpRank: posDvpRankOut, posDvpValue: posDvpValueOut, dvpRatio: oppDvpRatioOut, posGroup: posGroupOut,
              nbaUsage: nbaUsageMap[String(info.id)]?.usg ?? null,
              nbaAvgAst: nbaUsageMap[String(info.id)]?.avgAst ?? null,
              nbaAvgReb: nbaUsageMap[String(info.id)]?.avgReb ?? null,
            };
            if (isDebug) dropped.push(_nbaLowScoreDrop);
            plays.push({
              ..._nbaLowScoreDrop,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              playerStatus: null,
            });
            continue;
          }
          // NHL SimScore gate: must reach >= 11 (Alpha tier) to qualify as a play
          if (sport === "nhl" && nhlSimScore !== null && nhlSimScore < 8) {
            const _nhlLowScoreDrop = {
              ..._dropBase,
              reason: "low_confidence",
              nhlSimScore, nhlPreSimScore,
              opponent: tonightOpp,
              seasonPct: parseFloat(primaryPct.toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              nhlSimPct: nhlSimPctOut, nhlShotsAdj, nhlOpportunity, nhlTeamGPG, nhlSaRank, isB2B,
              nhlGameTotal, nhlSeasonHitRatePts, nhlDvpHitRatePts,
              posDvpRank: posDvpRankOut, dvpRatio: oppDvpRatioOut, posGroup: posGroupOut,
            };
            if (isDebug) dropped.push(_nhlLowScoreDrop);
            plays.push({
              ..._nhlLowScoreDrop,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              playerStatus: null,
            });
            continue;
          }
          // HRR SimScore gate: must reach >= 11 (Alpha tier) to qualify as a play
          if (sport === "mlb" && stat !== "strikeouts" && hitterFinalSimScore !== null && hitterFinalSimScore < 8) {
            const _hitterLowScoreDrop = {
              ..._dropBase,
              reason: "low_confidence",
              hitterSimScore, hitterFinalSimScore,
              opponent: tonightOpp,
              seasonPct: parseFloat(primaryPct.toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              softGames: softVals.length,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              hitterLineupSpot, pitcherWHIP, pitcherFIP, hitterBarrelPct,
              hitterBarrelPts, hitterTotalPts, hitterGameTotal, hitterPlatoonPts,
              hitterPlatoonRatio: hitterPlatoonRatio ?? undefined,
              hitterH2HSource: hitterH2HSource ?? undefined,
              hitterOps: _hitterOps ?? undefined, hitterOpsPts, hitterSeasonHitRatePts, hitterH2HHitRatePts,
              hitterBa: hitterBa !== null ? hitterBa : undefined,
              hitterBaTier: hitterBaTier ?? undefined,
              hitterWhipPts, hitterSplitBA,
              oppPitcherHand: hitterOppPitcherHand ?? undefined,
              hitterSoftLabel: softLabel ?? undefined,
              hitterPitcherName: sportByteam.mlb?.probables?.[tonightOpp]?.name ?? sportByteam.mlb?.pitcherInfoByTeam?.[tonightOpp]?.name ?? pitcherGamelogs[tonightOpp]?.name ?? null,
              hitterPitcherEra: sportByteam.mlb?.probables?.[tonightOpp]?.era ?? sportByteam.mlb?.pitcherEra?.[tonightOpp] ?? null,
            };
            if (isDebug) dropped.push(_hitterLowScoreDrop);
            plays.push({
              ..._hitterLowScoreDrop,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: !(sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp),
              playerStatus: null,
            });
            continue;
          }
          const mlbH2H = sport === "mlb" && softPct !== null;
          plays.push({
            playerName: playerNameDisplay || playerName,
            playerId: info.id,
            sport,
            playerTeam,
            position: info.position || null,
            opponent: tonightOpp,
            oppRank: mlbH2H ? null : posDvpRankOut ?? rankMap[tonightOpp]?.rank ?? null,
            oppMetricValue: mlbH2H ? parseFloat(softPct.toFixed(1)) : posDvpValueOut ?? rankMap[tonightOpp]?.value ?? null,
            oppMetricLabel: mlbH2H ? `${softLabel} (${softVals.length}g)` : rankMap[tonightOpp]?.label || null,
            oppMetricUnit: mlbH2H ? "%" : rankMap[tonightOpp]?.unit ?? null,
            posGroup: posGroupOut,
            posDvpRank: posDvpRankOut,
            posDvpValue: posDvpValueOut,
            dvpRatio: oppDvpRatioOut,
            lineupKPct: lineupKPctOut,
            lineupKPctProjected,
            pitcherKPct: pitcherKPctOut,
            pitcherKBBPct: pitcherKBBPctOut,
            log5Avg: log5AvgOut,
            log5Pct: simPctOut ?? log5PctOut,
            expectedKs: expectedKsOut,
            simPct: simPctOut,
            stat,
            threshold,
            kalshiPct,
            americanOdds,
            seasonPct: parseFloat((primaryPct).toFixed(1)),
            seasonGames: allVals.length,
            blendGames: blendVals.length,
            pct25: pct25 !== null ? parseFloat(pct25.toFixed(1)) : null,
            pct25Games: vals25.length,
            pct26: pct26 !== null ? parseFloat(pct26.toFixed(1)) : null,
            pct26Games: vals26.length,
            softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
            softGames: softVals.length,
            isHardMatchup: sport === "nba" && oppDvpRatioOut !== null ? oppDvpRatioOut <= 0.95 : false,
            simScore: sport === "mlb" && stat === "strikeouts" ? simScore : void 0,
            finalSimScore: sport === "mlb" && stat === "strikeouts" ? finalSimScore : void 0,
            kpctMeets: sport === "mlb" && stat === "strikeouts" ? kpctMeets : void 0,
            kbbMeets: sport === "mlb" && stat === "strikeouts" ? kbbMeets : void 0,
            lkpMeets: sport === "mlb" && stat === "strikeouts" ? lkpMeets : void 0,
            pitchesPts: sport === "mlb" && stat === "strikeouts" ? pitchesPts : void 0,
            parkMeets: sport === "mlb" && stat === "strikeouts" ? parkMeets : void 0,
            mlPts: sport === "mlb" && stat === "strikeouts" ? mlPts : void 0,
            totalPts: sport === "mlb" && stat === "strikeouts" ? totalPts : void 0,
            kpctPts: sport === "mlb" && stat === "strikeouts" ? kpctPts : void 0,
            lkpPts: sport === "mlb" && stat === "strikeouts" ? lkpPts : void 0,
            kTrendPts: sport === "mlb" && stat === "strikeouts" ? kTrendPts : void 0,
            kHitRatePts: sport === "mlb" && stat === "strikeouts" ? kHitRatePts : void 0,
            kH2HHandPts: sport === "mlb" && stat === "strikeouts" ? kH2HHandPts : void 0,
            kH2HHandRate: sport === "mlb" && stat === "strikeouts" ? _kH2HHandRate : void 0,
            kH2HHandStarts: sport === "mlb" && stat === "strikeouts" ? _kH2HHandStarts : void 0,
            kH2HHandMaj: sport === "mlb" && stat === "strikeouts" ? _kH2HHandMaj : void 0,
            blendedHitRate: sport === "mlb" && stat === "strikeouts" ? (_blendedHR != null ? parseFloat(_blendedHR.toFixed(1)) : null) : void 0,
            pitcherGS26: sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherGS26, "gs26") : void 0,
            pitcherHasAnchor: sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherHasAnchor, "hasAnchor") : void 0,
            hitterSimScore: sport === "mlb" && stat !== "strikeouts" ? hitterSimScore : void 0,
            hitterFinalSimScore: sport === "mlb" && stat !== "strikeouts" ? hitterFinalSimScore : void 0,
            hitterLineupSpot: sport === "mlb" && stat !== "strikeouts" ? hitterLineupSpot : void 0,
            hitterWhipMeets: sport === "mlb" && stat !== "strikeouts" ? hitterWhipMeets : void 0,
            hitterWhipPts: sport === "mlb" && stat !== "strikeouts" ? hitterWhipPts : void 0,
            hitterFipMeets: sport === "mlb" && stat !== "strikeouts" ? hitterFipMeets : void 0,
            hitterPlatoonPts: sport === "mlb" && stat !== "strikeouts" ? hitterPlatoonPts : void 0,
            hitterPlatoonRatio: sport === "mlb" && stat !== "strikeouts" ? (hitterPlatoonRatio ?? void 0) : void 0,
            hitterH2HSource: sport === "mlb" && stat !== "strikeouts" ? (hitterH2HSource ?? void 0) : void 0,
            hitterOps: sport === "mlb" && stat !== "strikeouts" ? (_hitterOps ?? void 0) : void 0,
            hitterOpsPts: sport === "mlb" && stat !== "strikeouts" ? hitterOpsPts : void 0,
            hitterSeasonHitRatePts: sport === "mlb" && stat !== "strikeouts" ? hitterSeasonHitRatePts : void 0,
            hitterH2HHitRatePts: sport === "mlb" && stat !== "strikeouts" ? hitterH2HHitRatePts : void 0,
            hitterSplitBA: sport === "mlb" && stat !== "strikeouts" ? hitterSplitBA : void 0,
            oppPitcherHand: sport === "mlb" && stat !== "strikeouts" ? hitterOppPitcherHand : void 0,
            hitterParkMeets: sport === "mlb" && stat !== "strikeouts" ? hitterParkMeets : void 0,
            pitcherWHIP: sport === "mlb" && stat !== "strikeouts" ? pitcherWHIP : void 0,
            pitcherFIP: sport === "mlb" && stat !== "strikeouts" ? pitcherFIP : void 0,
            hitterSimPct: sport === "mlb" && stat !== "strikeouts" ? hitterSimPctOut : void 0,
            hitterParkKF: sport === "mlb" && stat !== "strikeouts" ? hitterParkKF : void 0,
            hitterMoneyline: sport === "mlb" && stat !== "strikeouts" ? hitterMoneyline : void 0,
            hitterBarrelPct: sport === "mlb" && stat !== "strikeouts" ? hitterBarrelPct : void 0,
            hitterBarrelPts: sport === "mlb" && stat !== "strikeouts" ? hitterBarrelPts : void 0,
            hitterTotalPts: sport === "mlb" && stat !== "strikeouts" ? hitterTotalPts : void 0,
            hitterGameTotal: sport === "mlb" && stat !== "strikeouts" ? hitterGameTotal : void 0,
            pitcherAvgPitches: sport === "mlb" && stat === "strikeouts" ? _avgP : void 0,
            umpireName: sport === "mlb" && stat === "strikeouts" ? _umpireName : void 0,
            umpireKFactor: sport === "mlb" && stat === "strikeouts" && _umpireKFactor !== 1.0 ? _umpireKFactor : void 0,
            expectedBF: sport === "mlb" && stat === "strikeouts" && _expectedBF !== 24 ? _expectedBF : void 0,
            earlyExitProb: sport === "mlb" && stat === "strikeouts" && _earlyExitProb > 0 ? _earlyExitProb : void 0,
            stdBF: sport === "mlb" && stat === "strikeouts" && _stdBF > 0 ? _stdBF : void 0,
            gameTotal: sport === "mlb" && stat === "strikeouts" ? sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null : void 0,
            gameMoneyline: sport === "mlb" && stat === "strikeouts" ? sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null : void 0,
            pitcherCSWPct: sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct") : void 0,
            pitcherRecentKPct: sport === "mlb" && stat === "strikeouts" ? _recentKPct : void 0,
            pitcherSeasonKPct: sport === "mlb" && stat === "strikeouts" ? _seasonKPct : void 0,
            pitcherHand: sport === "mlb" && stat === "strikeouts" ? _pitcherHand ?? null : void 0,
            pitcherEra: sport === "mlb" && stat === "strikeouts" ? (_pitcherEraFromGl ?? _pt(sportByteam.mlb?.pitcherEra, "era") ?? null) : void 0,
            recentAvg: recentAvgOut,
            hitterBa: hitterBa !== null ? hitterBa : void 0,
            hitterBaTier: hitterBaTier ?? void 0,
            hitterAbVsPitcher: sport === "mlb" && stat !== "strikeouts" ? hitterAbVsPitcher : void 0,
            hitterPitcherName: sport === "mlb" && stat !== "strikeouts" ? (sportByteam.mlb?.probables?.[tonightOpp]?.name ?? sportByteam.mlb?.pitcherInfoByTeam?.[tonightOpp]?.name ?? pitcherGamelogs[tonightOpp]?.name ?? null) : void 0,
            hitterSoftLabel: sport === "mlb" && stat !== "strikeouts" ? softLabel : void 0,
            hitterPitcherEra: sport === "mlb" && stat !== "strikeouts" ? (sportByteam.mlb?.probables?.[tonightOpp]?.era ?? sportByteam.mlb?.pitcherEra?.[tonightOpp] ?? null) : void 0,
            nbaSimScore: sport === "nba" ? nbaSimScore : void 0,
            nbaPreSimScore: sport === "nba" ? nbaPreSimScore : void 0,
            nbaSimPct: sport === "nba" ? nbaSimPctOut : void 0,
            nbaPaceAdj: sport === "nba" ? nbaPaceAdj : void 0,
            nbaOpportunity: sport === "nba" ? nbaOpportunity : void 0,
            nbaTotalPts: sport === "nba" ? nbaTotalPts : void 0,
            nbaSeasonHitRatePts: sport === "nba" ? (primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0) : void 0,
            nbaSoftHitRatePts: sport === "nba" ? (softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0) : void 0,
            nbaGameTotal: sport === "nba" ? nbaGameTotal : void 0,
            nbaUsage: sport === "nba" ? ((nbaUsageMap[String(info.id)]?.usg) ?? null) : void 0,
            nbaAvgAst: sport === "nba" ? ((nbaUsageMap[String(info.id)]?.avgAst) ?? null) : void 0,
            nbaAvgReb: sport === "nba" ? ((nbaUsageMap[String(info.id)]?.avgReb) ?? null) : void 0,
            nba3pMPG: sport === "nba" && stat === "threePointers" ? nba3pMPG : void 0,
            nbaBlowoutAdj: sport === "nba" ? nbaBlowoutAdj : void 0,
            nbaSplitAdj: sport === "nba" ? nbaSplitAdj : void 0,
            nhlSimScore: sport === "nhl" ? nhlSimScore : void 0,
            nhlPreSimScore: sport === "nhl" ? nhlPreSimScore : void 0,
            nhlSimPct: sport === "nhl" ? nhlSimPctOut : void 0,
            nhlShotsAdj: sport === "nhl" ? nhlShotsAdj : void 0,
            nhlSaRank: sport === "nhl" ? nhlSaRank : void 0,
            nhlOpportunity: sport === "nhl" ? nhlOpportunity : void 0,
            nhlTeamGPG: sport === "nhl" ? nhlTeamGPG : void 0,
            nhlGameTotal: sport === "nhl" ? nhlGameTotal : void 0,
            nhlSeasonHitRatePts: sport === "nhl" ? nhlSeasonHitRatePts : void 0,
            nhlDvpHitRatePts: sport === "nhl" ? nhlDvpHitRatePts : void 0,
            isHomeGame,
            isB2B,
            dvpFactor: dvpFactorOut,
            projectedStat: projectedStatOut,
            parkFactor: parkFactorOut,
            truePct: parseFloat(truePct.toFixed(1)),
            rawTruePct: parseFloat(rawTruePct.toFixed(1)),

            kalshiVolume,
            kalshiSpread,
            lowVolume,
            rawEdge: parseFloat(rawEdge.toFixed(1)),
            spreadAdj: spreadAdj > 0 ? parseFloat(spreadAdj.toFixed(1)) : 0,
            edge: parseFloat(edge.toFixed(1)),
            kelly: kellyFraction(truePct, americanOdds),
            ev: evPerUnit(truePct, americanOdds),
            historicalHitRate: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
            historicalGames: softVals.length,
            hitterMoneyline: sport === "mlb" && stat !== "strikeouts" ? sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null : void 0,
            gameDate,
            gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
            lineupConfirmed: sport === "mlb" ? !(
              stat === "strikeouts"
                ? (sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp)
                : (sportByteam.mlb?.projectedLineupTeams || []).includes(playerTeam)
            ) : null,
            playerStatus: sport === "nba" ? (nbaPlayerStatus[String(info.id)] || null) : null,
            lineMove: lineMove ?? null,
            thinMarket: thinMarket ?? false,
            marketConfidence: marketConfidence ?? "thin"
          });
        }
        // Save all MLB strikeout plays before dedup so we can re-add non-winning thresholds as
        // qualified:false afterward — player card needs all thresholds in allTonightPlays.
        const _preDedupSkPlays = {};
        for (const play of plays) {
          if (play.sport === "mlb" && play.stat === "strikeouts") {
            const k = `${play.playerTeam}|${play.gameDate}`;
            (_preDedupSkPlays[k] = _preDedupSkPlays[k] || []).push(play);
          }
        }
        const bestMap = {};
        for (const play of plays) {
          // qualified:false plays exist for the player card (all thresholds needed) — keep per-threshold.
          // qualified:true/null plays are deduped to one per player+stat for the plays card display.
          const key = play.qualified === false
            ? `${play.playerName}|${play.sport}|${play.stat}|${play.threshold}`
            : `${play.playerName}|${play.sport}|${play.stat}`;
          const prev = bestMap[key];
          // For deduped (qualified:true) plays, keep the highest edge — best market value.
          // For per-threshold (qualified:false) plays, there is no competing prev.
          const isBetter = !prev || play.edge > prev.edge;
          if (isBetter) bestMap[key] = play;
        }
        plays.splice(0, plays.length, ...Object.values(bestMap));
        plays.sort((a, b) => {
          const ta = a.gameTime || "9999";
          const tb = b.gameTime || "9999";
          return ta < tb ? -1 : ta > tb ? 1 : b.edge - a.edge;
        });
        // Filter out plays from old dates (Kalshi sometimes keeps settled markets open).
        // Use yesterday as cutoff (not today) to handle UTC/local timezone differences
        // for late games: a TEX game at 9:40pm ET = 1:40am UTC next day, so today() on the
        // server would be April 14 while the game date is still April 13.
        const cutoffStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        plays.splice(0, plays.length, ...plays.filter(p => !p.gameDate || p.gameDate >= cutoffStr));
        // Re-add non-winning MLB strikeout thresholds as qualified:false so allTonightPlays has all
        // thresholds and the player card can show distinct simulation-based truePct per threshold.
        {
          const _existingSkKeys = new Set(plays.filter(p => p.sport === "mlb" && p.stat === "strikeouts").map(p => `${p.playerTeam}|${p.gameDate}|${p.threshold}`));
          const _extraSkPlays = [];
          for (const p of plays) {
            if (p.sport !== "mlb" || p.stat !== "strikeouts" || p.qualified === false) continue;
            const k = `${p.playerTeam}|${p.gameDate}`;
            const _hand = sportByteam.mlb?.pitcherHand?.[`${p.playerTeam}|${p.opponent ?? ""}`] ?? sportByteam.mlb?.pitcherHand?.[p.playerTeam] ?? "";
            const _dist = pitcherKDistCache[`${p.playerTeam}|${_hand}`];
            for (const other of (_preDedupSkPlays[k] || [])) {
              if (_existingSkKeys.has(`${other.playerTeam}|${other.gameDate}|${other.threshold}`)) continue;
              const _truePct = _dist ? kDistPct(_dist, other.threshold) : other.truePct;
              _extraSkPlays.push({ ...other, qualified: false, truePct: _truePct ?? other.truePct, simPct: _truePct ?? other.simPct, edge: _truePct != null ? parseFloat((_truePct - other.kalshiPct).toFixed(1)) : other.edge });
              _existingSkKeys.add(`${other.playerTeam}|${other.gameDate}|${other.threshold}`);
            }
          }
          plays.push(..._extraSkPlays);
        }
        // Enforce monotonicity: for MLB strikeout props on the same pitcher, lower threshold must have >= truePct.
        // If the simulation distribution is still in the pitcherKDistCache, re-derive all thresholds from it
        // so each threshold gets a distinct, correct value (e.g. 3+≈99.5%, 4+≈99.0%, 5+=98.1%).
        // Without this, qualified:false plays at lower thresholds use the fallback formula, which can be
        // lower than the simulation truePct of a qualifying higher threshold.
        {
          const _skGroups = {};
          for (const p of plays) {
            if (p.sport === "mlb" && p.stat === "strikeouts") {
              const key = `${p.playerTeam}|${p.gameDate}`;
              (_skGroups[key] = _skGroups[key] || []).push(p);
            }
          }
          for (const group of Object.values(_skGroups)) {
            group.sort((a, b) => a.threshold - b.threshold);
            const _pTeam = group[0].playerTeam;
            const _hand = sportByteam.mlb?.pitcherHand?.[`${_pTeam}|${group[0]?.opponent ?? ""}`] ?? sportByteam.mlb?.pitcherHand?.[_pTeam] ?? "";
            const _dist = pitcherKDistCache[`${_pTeam}|${_hand}`];
            if (_dist) {
              // Re-derive all thresholds from the shared distribution — guarantees distinct monotonic values.
              for (const play of group) {
                const _recomp = kDistPct(_dist, play.threshold);
                if (_recomp != null) {
                  play.truePct = _recomp;
                  play.simPct = _recomp;
                  play.edge = parseFloat((_recomp - play.kalshiPct).toFixed(1));
                }
              }
            } else {
              // Fallback: copy-up sweep (lower threshold gets at least the value of the next higher)
              for (let i = group.length - 2; i >= 0; i--) {
                if (group[i].truePct < group[i + 1].truePct) {
                  group[i].truePct = group[i + 1].truePct;
                  group[i].rawTruePct = group[i + 1].rawTruePct;
                  group[i].edge = parseFloat((group[i].truePct - group[i].kalshiPct - (group[i].spreadAdj ?? 0)).toFixed(1));
                }
              }
            }
          }
        }
        // ── Game Total plays ─────────────────────────────────────────────────────────────────────
        // Schedule event parser (shared by game total H2H and team total H2H pre-fetches)
        const _parseSchedEvts = d => (d.events ?? [])
          .filter(ev => ev.competitions?.[0]?.status?.type?.completed)
          .map(ev => ({ comps: (ev.competitions[0].competitors ?? []).map(c => ({ abbr: (c.team?.abbreviation ?? '').toUpperCase(), score: parseFloat(c.score?.value ?? c.score ?? 0) })) }));
        const totalDistCache = {};
        const totalPlays = [];
        {
          const _MLB_ERA = 4.20;
          // Pre-fetch home team schedules for MLB + NBA game total H2H hit rate
          const _gtScheduleMap = {};
          { const _gtHTs = new Set(); for (const tm of totalMarkets) { if (tm.sport === "mlb") { let ht = tm.gameTeam1; if (sportByteam.mlb?.gameHomeTeams?.[tm.gameTeam2]) ht = tm.gameTeam2; _gtHTs.add(`mlb:${ht}`); } else if (tm.sport === "nba") { _gtHTs.add(`nba:${tm.gameTeam1}`); } } await Promise.all([..._gtHTs].map(async spHt => { const [sp, ht] = spHt.split(':'); const league = sp === 'mlb' ? 'baseball/mlb' : 'basketball/nba'; const ck = `teamschedule:v2:${sp}:${ht.toLowerCase()}`; let ev = isBustCache ? null : await CACHE2?.get(ck, "json").catch(() => null); if (!ev) { try { const base = `https://site.api.espn.com/apis/site/v2/sports/${league}/teams/${ht.toLowerCase()}/schedule`; const r25 = await fetch(`${base}?season=2025`, { signal: AbortSignal.timeout(3000) }); const e25 = r25.ok ? _parseSchedEvts(await r25.json()) : []; const r26 = await fetch(base, { signal: AbortSignal.timeout(3000) }); const e26 = r26.ok ? _parseSchedEvts(await r26.json()) : []; ev = [...e25, ...e26]; if (ev.length && CACHE2) await CACHE2.put(ck, JSON.stringify(ev), { expirationTtl: 3600 }).catch(() => {}); } catch(e) {} } if (ev) _gtScheduleMap[spHt] = ev; })); }
          const _gtH2HRate = (ht, at, thr) => { const evts = _gtScheduleMap[`mlb:${ht}`] ?? _gtScheduleMap[ht] ?? []; const h2h = evts.filter(ev => ev.comps.some(c => c.abbr === at)).slice(-10); if (h2h.length < 3) return null; const hits = h2h.filter(ev => ev.comps.reduce((s, c) => s + (c.score || 0), 0) >= thr).length; return { rate: Math.round(hits / h2h.length * 100), games: h2h.length }; };
          const _nbaGtH2HRate = (ht, at, thr) => { const evts = _gtScheduleMap[`nba:${ht}`] ?? []; const h2h = evts.filter(ev => ev.comps.some(c => normTeam("nba", c.abbr) === at)).slice(-10); if (h2h.length < 3) return null; const hits = h2h.filter(ev => ev.comps.reduce((s, c) => s + (c.score || 0), 0) >= thr).length; return { rate: Math.round(hits / h2h.length * 100), games: h2h.length }; };
          for (const tm of totalMarkets) {
            const { sport, stat, threshold, kalshiPct, americanOdds, gameTeam1, gameTeam2, gameDate, kalshiSpread, kalshiVolume } = tm;
            if (gameDate && gameDate < cutoffStr) continue;
            const spreadAdj = kalshiSpread != null ? parseFloat((kalshiSpread / 2).toFixed(1)) : 0;
            const lowVolume = kalshiVolume != null && kalshiVolume < 50;
            let truePct = null, homeTeam = gameTeam1, awayTeam = gameTeam2, totalSimScore = 0, _simData = {};
            if (sport === "mlb") {
              if (sportByteam.mlb?.gameHomeTeams?.[gameTeam2]) { homeTeam = gameTeam2; awayTeam = gameTeam1; }
              // Road RPG strips home-park bias from the lambda numerator (fallback to overall RPG)
              const homeRPG = mlbRoadRPGMap[homeTeam] ?? mlbRPGMap[homeTeam] ?? null;
              const awayRPG = mlbRoadRPGMap[awayTeam] ?? mlbRPGMap[awayTeam] ?? null;
              const homeERA = sportByteam.mlb?.probables?.[homeTeam]?.era ?? null;
              const awayERA = sportByteam.mlb?.probables?.[awayTeam]?.era ?? null;
              const homeWHIP = sportByteam.mlb?.pitcherWHIPByTeam?.[homeTeam] ?? null;
              const awayWHIP = sportByteam.mlb?.pitcherWHIPByTeam?.[awayTeam] ?? null;
              const homeTeamERA = mlbTeamERAMap[homeTeam] ?? null;
              const awayTeamERA = mlbTeamERAMap[awayTeam] ?? null;
              const parkRF = PARK_RUNFACTOR[homeTeam] ?? 1;
              const gameOuLine = sportByteam.mlb?.gameOdds?.[homeTeam]?.total ?? sportByteam.mlb?.gameOdds?.[awayTeam]?.total ?? null;
              const _mlbOuPts = gameOuLine == null ? 1 : gameOuLine >= 9.5 ? 2 : gameOuLine >= 7.5 ? 1 : 0;
              // 60/40 starter/team-ERA blend — away staff vs home offense, home staff vs away offense
              const _awayMult = awayERA != null && awayTeamERA != null ? 0.6*(awayERA/_MLB_ERA)+0.4*(awayTeamERA/_MLB_ERA) : awayERA != null ? awayERA/_MLB_ERA : awayTeamERA != null ? awayTeamERA/_MLB_ERA : 1;
              const _homeMult = homeERA != null && homeTeamERA != null ? 0.6*(homeERA/_MLB_ERA)+0.4*(homeTeamERA/_MLB_ERA) : homeERA != null ? homeERA/_MLB_ERA : homeTeamERA != null ? homeTeamERA/_MLB_ERA : 1;
              // Platoon adjustment: ratio of team's RPG vs opposing starter's hand to overall RPG
              // Park effects cancel in the ratio (same mix of home/away games in numerator & denominator)
              const _platoonMap = sportByteam.mlb?.teamPlatoonRPGMap ?? {};
              const _homeStarterHand = sportByteam.mlb?.pitcherHand?.[homeTeam] ?? null;
              const _awayStarterHand = sportByteam.mlb?.pitcherHand?.[awayTeam] ?? null;
              const _homePlatCode = _awayStarterHand === 'L' ? 'vl' : _awayStarterHand === 'R' ? 'vr' : null;
              const _awayPlatCode = _homeStarterHand === 'L' ? 'vl' : _homeStarterHand === 'R' ? 'vr' : null;
              const _homePlatFactor = (_homePlatCode && _platoonMap[homeTeam]?.[_homePlatCode])
                ? _platoonMap[homeTeam][_homePlatCode] : 1.0;
              const _awayPlatFactor = (_awayPlatCode && _platoonMap[awayTeam]?.[_awayPlatCode])
                ? _platoonMap[awayTeam][_awayPlatCode] : 1.0;
              // Weather factor: wind out → more scoring, wind in → fewer runs; skip domed parks
              const _wKey = `${homeTeam}|${awayTeam}`;
              const _wData = weatherByGame[_wKey] ?? null;
              const _weatherFactor = (_wData?.windOutMph != null && !_MLB_DOMED.has(homeTeam))
                ? parseFloat((Math.max(0.85, Math.min(1.15, 1 + _wData.windOutMph * 0.013 + ((_wData.temp ?? 72) - 72) * 0.001))).toFixed(3))
                : 1.0;
              // Umpire run factor (1/kFactor): loose-zone ump → more scoring; applied directly to lambdas
              const _umpKeyT = `${homeTeam}|${awayTeam}`;
              const _umpNameT = sportByteam.mlb?.umpireByGame?.[_umpKeyT] ?? null;
              const _normUT = n => n?.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
              const _umpKFT = _umpNameT ? (UMPIRE_KFACTOR[_normUT(_umpNameT)] ?? 1.0) : 1.0;
              const _umpRunFactor = parseFloat((1 / _umpKFT).toFixed(3));
              const _hLam = homeRPG != null ? parseFloat((Math.max(1, Math.min(12, homeRPG * _awayMult * parkRF * _homePlatFactor * _weatherFactor * _umpRunFactor))).toFixed(1)) : null;
              const _aLam = awayRPG != null ? parseFloat((Math.max(1, Math.min(12, awayRPG * _homeMult * parkRF * _awayPlatFactor * _weatherFactor * _umpRunFactor))).toFixed(1)) : null;
              // H2H combined hit rate: how often (homeScore+awayScore) >= threshold in last 10 H2H meetings
              const _gtH2H = _gtH2HRate(homeTeam, awayTeam, threshold);
              const h2hTotalHitRate = _gtH2H?.rate ?? null;
              const h2hTotalGames = _gtH2H?.games ?? null;
              const _h2hTotalPts = h2hTotalHitRate == null ? 1 : h2hTotalHitRate >= 80 ? 2 : h2hTotalHitRate >= 60 ? 1 : 0;
              const _combinedRPG = homeRPG != null && awayRPG != null ? parseFloat((homeRPG + awayRPG).toFixed(2)) : null;
              const _combinedRPGPts = _combinedRPG == null ? 1 : _combinedRPG >= 10.5 ? 2 : _combinedRPG >= 9.0 ? 1 : 0;
              _simData = { homeRPG, awayRPG, homeERA, awayERA, homeWHIP, awayWHIP, parkFactor: parkRF, homeExpected: _hLam, awayExpected: _aLam, expectedTotal: (_hLam != null && _aLam != null) ? parseFloat((_hLam + _aLam).toFixed(1)) : null, gameOuLine, mlbOuPts: _mlbOuPts, combinedRPG: _combinedRPG, umpireRunFactor: _umpNameT != null ? _umpRunFactor : null, umpireName: _umpNameT, h2hTotalHitRate, h2hTotalGames, homeStarterHand: _homeStarterHand, awayStarterHand: _awayStarterHand, ...(_homePlatFactor !== 1.0 && { homePlatoonFactor: _homePlatFactor }), ...(_awayPlatFactor !== 1.0 && { awayPlatoonFactor: _awayPlatFactor }), ...(_weatherFactor !== 1.0 && { weatherFactor: _weatherFactor, windOutMph: _wData?.windOutMph }) };
              if (_hLam != null && _aLam != null) {
                const _dk = `mlb|${homeTeam}|${awayTeam}`;
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateMLBTotalDist(_hLam, _aLam, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
              }
              // MLB SimScore (max 10): homeWHIP→0-2, awayWHIP→0-2, combinedRPG→0-2, H2H→0-2, O/U→0-2
              totalSimScore += homeWHIP == null ? 1 : homeWHIP > 1.35 ? 2 : homeWHIP > 1.20 ? 1 : 0;
              totalSimScore += awayWHIP == null ? 1 : awayWHIP > 1.35 ? 2 : awayWHIP > 1.20 ? 1 : 0;
              totalSimScore += _combinedRPGPts;
              totalSimScore += _h2hTotalPts;
              totalSimScore += _mlbOuPts;
            } else if (sport === "nba") {
              const _hp = nbaPaceData?.teamPace?.[homeTeam] ?? null, _ap = nbaPaceData?.teamPace?.[awayTeam] ?? null;
              const _lgPace = nbaPaceData?.leagueAvgPace ?? null;
              const _nbaOuLine = sportByteam.nbaGameOdds?.[homeTeam]?.total ?? sportByteam.nbaGameOdds?.[awayTeam]?.total ?? null;
              // Possession-based projection — eliminates pace double-count from raw PPG
              // OffRtg = avgPoints / pace * 100 (derived in buildNbaPaceData from ESPN stats)
              // DefRtg = defPPGAllowed / pace * 100 (derived inline from existing nbaDefRank data)
              const _hOffRtg = nbaPaceData?.teamOffRtg?.[homeTeam] ?? null;
              const _aOffRtg = nbaPaceData?.teamOffRtg?.[awayTeam] ?? null;
              const _lgOffRtg = nbaPaceData?.leagueAvgOffRtg ?? 113.0;
              const nbaDefRank = STAT_SOFT["nba|points"]?.rankMap ?? {};
              const nbaAvgDef = leagueAvgCache["nba|points"] ?? nbaLeagueAvgOffPPG;
              // DefRtg: PPG allowed / pace * 100 — eliminates pace from defense metric too
              const _hDefRtg = (nbaDefRank[homeTeam]?.value != null && _hp != null && _hp > 0) ? parseFloat((nbaDefRank[homeTeam].value / _hp * 100).toFixed(1)) : null;
              const _aDefRtg = (nbaDefRank[awayTeam]?.value != null && _ap != null && _ap > 0) ? parseFloat((nbaDefRank[awayTeam].value / _ap * 100).toFixed(1)) : null;
              let _homeExpRaw = null, _awayExpRaw = null, _projPace = null;
              if (_hOffRtg != null && _aDefRtg != null && _aOffRtg != null && _hDefRtg != null && _hp != null && _ap != null && _lgPace != null && _lgPace > 0) {
                // Geometric-mean pace: correctly handles extreme pace matchups without simple averaging
                _projPace = parseFloat(((_hp * _ap) / _lgPace).toFixed(1));
                _homeExpRaw = (_hOffRtg * _aDefRtg / (_lgOffRtg * _lgOffRtg)) * _projPace;
                _awayExpRaw = (_aOffRtg * _hDefRtg / (_lgOffRtg * _lgOffRtg)) * _projPace;
              } else {
                // Fallback: old PPG-based formula when pace data unavailable
                const homeOff = nbaOffPPGMap[homeTeam] ?? null, awayOff = nbaOffPPGMap[awayTeam] ?? null;
                const homeDef = nbaDefRank[homeTeam]?.value ?? null, awayDef = nbaDefRank[awayTeam]?.value ?? null;
                _homeExpRaw = homeOff != null ? homeOff * (awayDef != null && nbaAvgDef ? awayDef / nbaAvgDef : 1) : null;
                _awayExpRaw = awayOff != null ? awayOff * (homeDef != null && nbaAvgDef ? homeDef / nbaAvgDef : 1) : null;
              }
              // Keep injuries in simData for reference (not scored)
              const _NBAshort = { GSW:"GS", SAS:"SA", NYK:"NY", NOP:"NO", PHX:"PHO" };
              const _homeOut = (nbaInjuryMap.get(homeTeam) || nbaInjuryMap.get(_NBAshort[homeTeam]) || []).length;
              const _awayOut = (nbaInjuryMap.get(awayTeam) || nbaInjuryMap.get(_NBAshort[awayTeam]) || []).length;
              // H2H combined hit rate: combined score >= threshold in last 10 H2H meetings
              const _nbaGtH2H = _nbaGtH2HRate(homeTeam, awayTeam, threshold);
              const nbaGtH2HRate = _nbaGtH2H?.rate ?? null;
              const nbaGtH2HGames = _nbaGtH2H?.games ?? null;
              // Combined OffRtg and DefRtg averages
              const _combOffRtg = (_hOffRtg != null && _aOffRtg != null) ? parseFloat(((_hOffRtg + _aOffRtg) / 2).toFixed(1)) : (_hOffRtg ?? _aOffRtg);
              const _combDefRtg = (_hDefRtg != null && _aDefRtg != null) ? parseFloat(((_hDefRtg + _aDefRtg) / 2).toFixed(1)) : (_hDefRtg ?? _aDefRtg);
              _simData = { homeOffRtg: _hOffRtg, awayOffRtg: _aOffRtg, homeDefRtg: _hDefRtg, awayDefRtg: _aDefRtg, combOffRtg: _combOffRtg, combDefRtg: _combDefRtg, homePace: _hp, awayPace: _ap, leagueAvgPace: _lgPace, projPace: _projPace, gameOuLine: _nbaOuLine, homeOut: _homeOut, awayOut: _awayOut, nbaGtH2HRate, nbaGtH2HGames, homeExpected: _homeExpRaw != null ? parseFloat(_homeExpRaw.toFixed(1)) : null, awayExpected: _awayExpRaw != null ? parseFloat(_awayExpRaw.toFixed(1)) : null, expectedTotal: (_homeExpRaw != null && _awayExpRaw != null) ? parseFloat((_homeExpRaw + _awayExpRaw).toFixed(1)) : null };
              if (_homeExpRaw != null && _awayExpRaw != null) {
                const _dk = `nba|${homeTeam}|${awayTeam}`;
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNBATotalDist(_homeExpRaw, _awayExpRaw, 11, 11, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
              }
              // NBA SimScore (max 10): combOffRtg→0-2, combDefRtg→0-2, pace→0-2, H2H HR%→0-2, O/U→0-2
              const _pacePts = (_hp == null || _ap == null || _lgPace == null) ? 1 : (_hp > _lgPace + 2 && _ap > _lgPace + 2) ? 2 : (_hp > _lgPace || _ap > _lgPace) ? 1 : 0;
              totalSimScore += _combOffRtg == null ? 1 : _combOffRtg >= 118 ? 2 : _combOffRtg >= 113 ? 1 : 0;
              totalSimScore += _combDefRtg == null ? 1 : _combDefRtg >= 118 ? 2 : _combDefRtg >= 113 ? 1 : 0;
              totalSimScore += _pacePts;
              totalSimScore += nbaGtH2HRate == null ? 1 : nbaGtH2HRate >= 80 ? 2 : nbaGtH2HRate >= 60 ? 1 : 0;
              if (_nbaOuLine != null) totalSimScore += _nbaOuLine >= 225 ? 2 : _nbaOuLine >= 215 ? 1 : 0;
              else totalSimScore += 1; // null → abstain
            } else if (sport === "nhl") {
              const homeGPG = nhlGPGMap[homeTeam] ?? null, awayGPG = nhlGPGMap[awayTeam] ?? null;
              const homeGAA = nhlGAAMap[homeTeam] ?? null, awayGAA = nhlGAAMap[awayTeam] ?? null;
              const _nhlOuLine = sportByteam.nhlGameOdds?.[homeTeam]?.total ?? sportByteam.nhlGameOdds?.[awayTeam]?.total ?? null;
              const _hGLRaw = homeGPG != null ? Math.max(0.5, Math.min(8, homeGPG * (awayGAA != null ? awayGAA / nhlLeagueAvgGAA : 1))) : null;
              const _aGLRaw = awayGPG != null ? Math.max(0.5, Math.min(8, awayGPG * (homeGAA != null ? homeGAA / nhlLeagueAvgGAA : 1))) : null;
              _simData = { homeGPG, awayGPG, homeGAA, awayGAA, gameOuLine: _nhlOuLine, homeExpected: _hGLRaw != null ? parseFloat(_hGLRaw.toFixed(2)) : null, awayExpected: _aGLRaw != null ? parseFloat(_aGLRaw.toFixed(2)) : null, expectedTotal: (_hGLRaw != null && _aGLRaw != null) ? parseFloat((_hGLRaw + _aGLRaw).toFixed(1)) : null };
              if (_hGLRaw != null && _aGLRaw != null) {
                const _dk = `nhl|${homeTeam}|${awayTeam}`;
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNHLTotalDist(_hGLRaw, _aGLRaw, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
              }
              // NHL SimScore (max 10): homeGPG→0-2, awayGPG→0-2, homeGAA→0-2, awayGAA→0-2, O/U→0-2
              totalSimScore += homeGPG == null ? 1 : homeGPG >= 3.5 ? 2 : homeGPG >= 3.0 ? 1 : 0;
              totalSimScore += awayGPG == null ? 1 : awayGPG >= 3.5 ? 2 : awayGPG >= 3.0 ? 1 : 0;
              totalSimScore += homeGAA == null ? 1 : homeGAA >= 3.5 ? 2 : homeGAA >= 3.0 ? 1 : 0;
              totalSimScore += awayGAA == null ? 1 : awayGAA >= 3.5 ? 2 : awayGAA >= 3.0 ? 1 : 0;
              if (_nhlOuLine != null) totalSimScore += _nhlOuLine >= 7 ? 2 : _nhlOuLine >= 5.5 ? 1 : 0;
              else totalSimScore += 1; // null → abstain
            }
            // ── UNDER SimScore (inverted tiers — low values favor under) ──
            let underSimScore = 0;
            if (sport === "mlb") {
              const { homeWHIP: _hW, awayWHIP: _aW, combinedRPG: _cRPG, gameOuLine, h2hTotalHitRate: _h2hTR } = _simData;
              underSimScore += _hW == null ? 1 : _hW <= 1.10 ? 2 : _hW <= 1.25 ? 1 : 0;
              underSimScore += _aW == null ? 1 : _aW <= 1.10 ? 2 : _aW <= 1.25 ? 1 : 0;
              underSimScore += _cRPG == null ? 1 : _cRPG <= 8.5 ? 2 : _cRPG <= 10.0 ? 1 : 0;
              underSimScore += _h2hTR == null ? 1 : _h2hTR <= 20 ? 2 : _h2hTR <= 40 ? 1 : 0;
              underSimScore += gameOuLine == null ? 1 : gameOuLine < 7.5 ? 2 : gameOuLine < 9.5 ? 1 : 0;
            } else if (sport === "nba") {
              // UNDER SimScore: inverted — weak offenses, strong defenses, slow pace, no H2H history of scoring, low O/U
              const { combOffRtg, combDefRtg, homePace, awayPace, leagueAvgPace, gameOuLine, nbaGtH2HRate: _nbaH2H } = _simData;
              underSimScore += combOffRtg == null ? 1 : combOffRtg < 113 ? 2 : combOffRtg < 118 ? 1 : 0;
              underSimScore += combDefRtg == null ? 1 : combDefRtg < 113 ? 2 : combDefRtg < 118 ? 1 : 0;
              const _uPacePts = (homePace == null || awayPace == null || leagueAvgPace == null) ? 1 : (homePace < leagueAvgPace - 2 && awayPace < leagueAvgPace - 2) ? 2 : (homePace < leagueAvgPace || awayPace < leagueAvgPace) ? 1 : 0;
              underSimScore += _uPacePts;
              underSimScore += _nbaH2H == null ? 1 : _nbaH2H <= 30 ? 2 : _nbaH2H <= 50 ? 1 : 0;
              underSimScore += gameOuLine == null ? 1 : gameOuLine < 215 ? 2 : gameOuLine < 225 ? 1 : 0;
            } else if (sport === "nhl") {
              const { homeGPG, awayGPG, homeGAA, awayGAA, gameOuLine } = _simData;
              underSimScore += homeGPG == null ? 1 : homeGPG < 3.0 ? 2 : homeGPG < 3.5 ? 1 : 0;
              underSimScore += awayGPG == null ? 1 : awayGPG < 3.0 ? 2 : awayGPG < 3.5 ? 1 : 0;
              underSimScore += homeGAA == null ? 1 : homeGAA < 3.0 ? 2 : homeGAA < 3.5 ? 1 : 0;
              underSimScore += awayGAA == null ? 1 : awayGAA < 3.0 ? 2 : awayGAA < 3.5 ? 1 : 0;
              underSimScore += gameOuLine == null ? 1 : gameOuLine < 5.5 ? 2 : gameOuLine < 7 ? 1 : 0;
            }
            if (truePct == null) {
              if (isDebug) dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, totalSimScore, underSimScore, reason: "no_simulation_data", ..._simData });
              continue;
            }
            const rawEdge = kalshiPct != null ? parseFloat((truePct - kalshiPct).toFixed(1)) : null;
            const overEdge = rawEdge ?? 0;
            const noTruePct = parseFloat((100 - truePct).toFixed(1));
            const noKalshiPct = 100 - kalshiPct;
            const underEdge = parseFloat((noTruePct - noKalshiPct).toFixed(1));
            const noKalshiAO = noKalshiPct >= 50 ? Math.round(-(noKalshiPct/(100-noKalshiPct))*100) : Math.round((100-noKalshiPct)/noKalshiPct*100);
            const _gameTime = gameTimes[`${sport}:${homeTeam}:${gameDate}`] ?? gameTimes[`${sport}:${awayTeam}:${gameDate}`] ?? gameTimes[`${sport}:${homeTeam}`] ?? gameTimes[`${sport}:${awayTeam}`] ?? null;
            // OVER play
            if (overEdge >= 5) {
              totalPlays.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), rawEdge, edge: overEdge, totalSimScore, qualified: totalSimScore >= 8, kelly: kellyFraction(truePct, americanOdds), ev: evPerUnit(truePct, americanOdds), kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _gameTime, ..._simData });
            } else if (isDebug) {
              dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), rawEdge, edge: overEdge, totalSimScore, reason: "edge_too_low", ..._simData });
            }
            // UNDER play — mirror the OVER filter: require noKalshiPct >= 70 (YES <= 30)
            // so we only bet UNDERs the market also considers likely (same gate as OVERs)
            if (underEdge >= 5 && noKalshiPct >= 70) {
              totalPlays.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "under", kalshiPct, noKalshiPct, americanOdds: noKalshiAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, rawEdge, edge: underEdge, totalSimScore: underSimScore, qualified: underSimScore >= 8, kelly: kellyFraction(noTruePct, noKalshiAO), ev: evPerUnit(noTruePct, noKalshiAO), kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _gameTime, ..._simData });
            } else if (isDebug && underEdge >= 3) {
              dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "under", kalshiPct, noKalshiPct, americanOdds: noKalshiAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, rawEdge, edge: underEdge, totalSimScore: underSimScore, reason: noKalshiPct < 70 ? "under_no_price_too_low" : "edge_too_low", ..._simData });
            }
          }
        }
        {
          // Step 1: per-game dedup for game totals — qualified (simScore≥8) beats non-qualified; ties broken by edge
          const _totalBestMap = {};
          for (const tp of totalPlays) {
            const key = `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}`;
            const tpQ = tp.totalSimScore >= 8;
            const prev = _totalBestMap[key];
            const prevQ = prev && (prev.totalSimScore >= 8);
            if (!prev || (!prevQ && tpQ) || (prevQ === tpQ && tp.edge > prev.edge)) _totalBestMap[key] = tp;
          }
          const _bestTotalIds = new Set(Object.values(_totalBestMap).map(tp => `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}|${tp.threshold}|${tp.direction}`));
          // NOTE: team total cross-dedup applied after teamTotalPlays loop below
          for (const tp of totalPlays) {
            const isBest = _bestTotalIds.has(`${tp.sport}|${tp.homeTeam}|${tp.awayTeam}|${tp.threshold}|${tp.direction}`);
            plays.push(isBest ? tp : { ...tp, qualified: false });
          }
        }
        // ── Team Total plays (KXMLBTEAMTOTAL, KXNBATEAMTOTAL) ─────────────────────────────────────
        {
          const _MLB_ERA = 4.20;
          const teamTotalDistCache = {};
          const teamTotalPlays = [];
          // Pre-fetch ESPN team schedules for H2H hit rate computation (current + prior season, sequential fetches)
          const _ttScheduleMap = {};
          const _ttTeams = new Set(teamTotalMarkets.map(tm => `${tm.sport}:${tm.scoringTeam}`));
          await Promise.all([..._ttTeams].map(async key => {
            const [sp, abbr] = key.split(':');
            const cacheKey = `teamschedule:v2:${sp}:${abbr}`;
            let events = isBustCache ? null : await CACHE2?.get(cacheKey, "json").catch(() => null);
            if (!events) {
              try {
                const league = sp === 'mlb' ? 'baseball/mlb' : 'basketball/nba';
                const base = `https://site.api.espn.com/apis/site/v2/sports/${league}/teams/${abbr.toLowerCase()}/schedule`;
                const r25 = await fetch(`${base}?season=2025`, { signal: AbortSignal.timeout(3000) });
                const ev25 = r25.ok ? _parseSchedEvts(await r25.json()) : [];
                const r26 = await fetch(base, { signal: AbortSignal.timeout(3000) });
                const ev26 = r26.ok ? _parseSchedEvts(await r26.json()) : [];
                events = [...ev25, ...ev26];
                if (events.length && CACHE2) await CACHE2.put(cacheKey, JSON.stringify(events), { expirationTtl: 3600 }).catch(() => {});
              } catch(e) {}
            }
            if (events) _ttScheduleMap[key] = events;
          }));
          const _ttH2HRate = (sport, scoringTeam, oppTeam, threshold) => {
            const events = _ttScheduleMap[`${sport}:${scoringTeam}`] ?? [];
            const h2h = events.filter(ev => ev.comps.some(c => normTeam(sport, c.abbr) === oppTeam)).slice(-10);
            if (h2h.length < 3) return null;
            const hits = h2h.filter(ev => { const mine = ev.comps.find(c => normTeam(sport, c.abbr) === scoringTeam); return mine && mine.score >= threshold; });
            return { rate: Math.round(hits.length / h2h.length * 100), games: h2h.length };
          };
          for (const tm of teamTotalMarkets) {
            const { sport, stat, threshold, kalshiPct, americanOdds, gameTeam1, gameTeam2, scoringTeam, gameDate, kalshiSpread, kalshiVolume } = tm;
            if (gameDate && gameDate < cutoffStr) continue;
            const lowVolume = kalshiVolume != null && kalshiVolume < 50;
            // Determine home/away (same correction logic as game total loop)
            let homeTeam = gameTeam1, awayTeam = gameTeam2;
            if (sport === "mlb" && sportByteam.mlb?.gameHomeTeams?.[gameTeam2]) { homeTeam = gameTeam2; awayTeam = gameTeam1; }
            const isHome = scoringTeam === homeTeam;
            const oppTeam = isHome ? awayTeam : homeTeam;
            let truePct = null, teamTotalSimScore = 0;
            if (sport === "mlb") {
              const teamRPG = mlbRoadRPGMap[scoringTeam] ?? mlbRPGMap[scoringTeam] ?? null;
              const oppRPG = mlbRoadRPGMap[oppTeam] ?? mlbRPGMap[oppTeam] ?? null;
              const oppERA = sportByteam.mlb?.probables?.[oppTeam]?.era ?? null;
              const oppTeamERA = mlbTeamERAMap[oppTeam] ?? null;
              const parkRF = PARK_RUNFACTOR[homeTeam] ?? 1;
              const gameOuLine = sportByteam.mlb?.gameOdds?.[homeTeam]?.total ?? sportByteam.mlb?.gameOdds?.[awayTeam]?.total ?? null;
              const _oppMult = oppERA != null && oppTeamERA != null ? 0.6*(oppERA/_MLB_ERA)+0.4*(oppTeamERA/_MLB_ERA) : oppERA != null ? oppERA/_MLB_ERA : oppTeamERA != null ? oppTeamERA/_MLB_ERA : 1;
              const _ttPlatoonMap = sportByteam.mlb?.teamPlatoonRPGMap ?? {};
              const _ttOppStarterHand = sportByteam.mlb?.pitcherHand?.[oppTeam] ?? null;
              const _ttPlatCode = _ttOppStarterHand === 'L' ? 'vl' : _ttOppStarterHand === 'R' ? 'vr' : null;
              const _ttPlatFactor = (_ttPlatCode && _ttPlatoonMap[scoringTeam]?.[_ttPlatCode])
                ? _ttPlatoonMap[scoringTeam][_ttPlatCode] : 1.0;
              const _ttWData = weatherByGame[`${homeTeam}|${awayTeam}`] ?? null;
              const _ttWeatherFactor = (_ttWData?.windOutMph != null && !_MLB_DOMED.has(homeTeam))
                ? parseFloat((Math.max(0.85, Math.min(1.15, 1 + _ttWData.windOutMph * 0.013 + ((_ttWData.temp ?? 72) - 72) * 0.001))).toFixed(3))
                : 1.0;
              // Umpire run factor (independent env signal — loose zone → more scoring); applied to lambda
              const _ttUmpKey = `${homeTeam}|${awayTeam}`;
              const _ttUmpName = sportByteam.mlb?.umpireByGame?.[_ttUmpKey] ?? null;
              const _normTTUmp = n => n?.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
              const _ttUmpKF = _ttUmpName ? (UMPIRE_KFACTOR[_normTTUmp(_ttUmpName)] ?? 1.0) : 1.0;
              const _ttUmpRunFactor = parseFloat((1 / _ttUmpKF).toFixed(3));
              const ttUmpirePts = _ttUmpName == null ? 1 : _ttUmpRunFactor >= 1.05 ? 2 : _ttUmpRunFactor >= 0.97 ? 1 : 0;
              const _lam = teamRPG != null ? parseFloat((Math.max(0.5, Math.min(12, teamRPG * _oppMult * parkRF * _ttPlatFactor * _ttWeatherFactor * _ttUmpRunFactor))).toFixed(2)) : null;
              if (_lam != null) {
                const _dk = `mlb|team|${scoringTeam}|${oppTeam}`;
                if (!teamTotalDistCache[_dk]) teamTotalDistCache[_dk] = simulateTeamTotalDist(_lam, 10000);
                truePct = totalDistPct(teamTotalDistCache[_dk], threshold);
              }
              // Starter WHIP (independent quality signal — traffic indicator beyond ERA)
              const oppWHIP = sportByteam.mlb?.pitcherWHIPByTeam?.[oppTeam] ?? null;
              const ttWhipPts = oppWHIP == null ? 1 : oppWHIP > 1.35 ? 2 : oppWHIP > 1.20 ? 1 : 0;
              // L10 RPG — computed from already-fetched team schedule (same cache as H2H)
              const _ttSched = _ttScheduleMap[`mlb:${scoringTeam}`] || [];
              const _ttLast10 = _ttSched.slice(-10);
              const _ttRunVals = _ttLast10.map(ev => ev.comps?.find(c => c.abbr === scoringTeam)?.score ?? null).filter(v => v !== null && !isNaN(v));
              const teamL10RPG = _ttRunVals.length >= 5 ? parseFloat((_ttRunVals.reduce((a, b) => a + b, 0) / _ttRunVals.length).toFixed(2)) : null;
              const ttL10Pts = teamL10RPG == null ? 1 : teamL10RPG > 5.0 ? 2 : teamL10RPG > 4.0 ? 1 : 0;
              // Season hit rate: scoring team's rate of scoring >= threshold across all completed season games
              const _ttSeasonHits = _ttSched.filter(ev => { const mine = ev.comps.find(c => c.abbr === scoringTeam); return mine && mine.score >= threshold; });
              const ttSeasonHitRate = _ttSched.length >= 5 ? Math.round(_ttSeasonHits.length / _ttSched.length * 100) : null;
              const ttSeasonHitRatePts = ttSeasonHitRate == null ? 1 : ttSeasonHitRate >= 80 ? 2 : ttSeasonHitRate >= 60 ? 1 : 0;
              // Blend Poisson model with season hit rate to correct systematic overestimation at low thresholds
              // Poisson averages ~12pts above actual hit rate; season rate is the ground truth measurement
              const _ttModelTruePct = truePct;
              if (truePct != null && ttSeasonHitRate != null) {
                truePct = parseFloat((0.5 * truePct + 0.5 * ttSeasonHitRate).toFixed(1));
              }
              const _h2h = _ttH2HRate("mlb", scoringTeam, oppTeam, threshold);
              const h2hHitRate = _h2h?.rate ?? null;
              const h2hGames = _h2h?.games ?? null;
              const h2hHitRatePts = h2hHitRate == null ? 1 : h2hHitRate >= 80 ? 2 : h2hHitRate >= 60 ? 1 : 0;
              teamTotalSimScore += ttSeasonHitRatePts;
              teamTotalSimScore += ttWhipPts;
              teamTotalSimScore += ttL10Pts;
              teamTotalSimScore += h2hHitRatePts;
              teamTotalSimScore += gameOuLine == null ? 1 : gameOuLine >= 9.5 ? 2 : gameOuLine >= 7.5 ? 1 : 0;
              if (truePct == null) { if (isDebug) dropped.push({ gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, teamTotalSimScore, teamRPG, oppERA, oppWHIP, oppRPG, parkFactor: parkRF, gameOuLine, h2hHitRate, h2hGames, h2hHitRatePts, teamL10RPG, ttL10Pts, ttWhipPts, ttUmpirePts, ttSeasonHitRate, ttSeasonHitRatePts, umpireName: _ttUmpName, reason: "no_simulation_data" }); continue; }
              const _ttGameTime = gameTimes[`${sport}:${homeTeam}:${gameDate}`] ?? gameTimes[`${sport}:${awayTeam}:${gameDate}`] ?? gameTimes[`${sport}:${homeTeam}`] ?? gameTimes[`${sport}:${awayTeam}`] ?? null;
              const _ttBaseFields = { gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), ...(_ttModelTruePct != null && _ttModelTruePct !== truePct && { modelTruePct: parseFloat(_ttModelTruePct.toFixed(1)) }), kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _ttGameTime, teamRPG, oppERA, oppWHIP, oppRPG, parkFactor: parkRF, gameOuLine, teamExpected: _lam != null ? parseFloat(_lam.toFixed(1)) : null, h2hHitRate, h2hGames, h2hHitRatePts, teamL10RPG, ttL10Pts, ttWhipPts, ttUmpirePts, umpireRunFactor: _ttUmpRunFactor, ...(_ttUmpName && { umpireName: _ttUmpName }), ttSeasonHitRate, ttSeasonHitRatePts, oppStarterHand: _ttOppStarterHand, ...(_ttPlatFactor !== 1.0 && { platoonFactor: _ttPlatFactor }) };
              const rawEdge = parseFloat((truePct - kalshiPct).toFixed(1));
              const edge = rawEdge;
              if (edge >= 5) {
                teamTotalPlays.push({ ..._ttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, qualified: teamTotalSimScore >= 8, kelly: kellyFraction(truePct, americanOdds), ev: evPerUnit(truePct, americanOdds) });
              } else if (isDebug) {
                dropped.push({ ..._ttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, reason: "edge_too_low" });
              }
              // UNDER play
              const _ttNoTruePct = parseFloat((100 - truePct).toFixed(1));
              const _ttNoKalshiPct = 100 - kalshiPct;
              const _ttUnderEdge = parseFloat((_ttNoTruePct - _ttNoKalshiPct).toFixed(1));
              const _ttNoKalshiAO = _ttNoKalshiPct >= 50 ? Math.round(-(_ttNoKalshiPct/(100-_ttNoKalshiPct))*100) : Math.round((100-_ttNoKalshiPct)/_ttNoKalshiPct*100);
              let _ttUnderSimScore = 0;
              _ttUnderSimScore += ttSeasonHitRate == null ? 1 : ttSeasonHitRate <= 20 ? 2 : ttSeasonHitRate <= 40 ? 1 : 0;
              _ttUnderSimScore += oppWHIP == null ? 1 : oppWHIP <= 1.10 ? 2 : oppWHIP <= 1.25 ? 1 : 0;
              _ttUnderSimScore += teamL10RPG == null ? 1 : teamL10RPG <= 3.5 ? 2 : teamL10RPG <= 4.5 ? 1 : 0;
              _ttUnderSimScore += h2hHitRate == null ? 1 : h2hHitRate <= 30 ? 2 : h2hHitRate <= 50 ? 1 : 0;
              _ttUnderSimScore += gameOuLine == null ? 1 : gameOuLine < 7.5 ? 2 : gameOuLine < 9.5 ? 1 : 0;
              if (_ttUnderEdge >= 5 && _ttNoKalshiPct >= 70) {
                teamTotalPlays.push({ ..._ttBaseFields, direction: "under", noTruePct: _ttNoTruePct, noKalshiPct: _ttNoKalshiPct, americanOdds: _ttNoKalshiAO, edge: _ttUnderEdge, rawEdge: _ttUnderEdge, teamTotalSimScore: _ttUnderSimScore, qualified: _ttUnderSimScore >= 8, kelly: kellyFraction(_ttNoTruePct, _ttNoKalshiAO), ev: evPerUnit(_ttNoTruePct, _ttNoKalshiAO) });
              } else if (isDebug) {
                dropped.push({ ..._ttBaseFields, direction: "under", noTruePct: _ttNoTruePct, noKalshiPct: _ttNoKalshiPct, edge: _ttUnderEdge, teamTotalSimScore: _ttUnderSimScore, reason: _ttNoKalshiPct < 70 ? "under_no_price_too_low" : "edge_too_low" });
              }
            } else if (sport === "nba") {
              const nbaDefRank = STAT_SOFT["nba|points"]?.rankMap ?? {};
              const nbaAvgDef = leagueAvgCache["nba|points"] ?? nbaLeagueAvgOffPPG;
              const _nbaOuLine = sportByteam.nbaGameOdds?.[homeTeam]?.total ?? sportByteam.nbaGameOdds?.[awayTeam]?.total ?? null;
              const _gameSpread = sportByteam.nbaGameOdds?.[homeTeam]?.spread ?? sportByteam.nbaGameOdds?.[awayTeam]?.spread ?? null;
              // OffRtg (pace-adjusted) from nbaPaceData; DefRtg computed from PPG-allowed / pace
              const teamOffRtg = nbaPaceData?.teamOffRtg?.[scoringTeam] ?? null;
              const _oppPaceNba = nbaPaceData?.teamPace?.[oppTeam] ?? null;
              const oppDefPPGNba = nbaDefRank[oppTeam]?.value ?? null;
              const oppDefRtg = (oppDefPPGNba != null && _oppPaceNba != null && _oppPaceNba > 0) ? parseFloat((oppDefPPGNba / _oppPaceNba * 100).toFixed(1)) : null;
              // Simulation: OffRtg-based projection when available, fall back to PPG
              const _teamPaceNba = nbaPaceData?.teamPace?.[scoringTeam] ?? null;
              const _lgPaceNba = nbaPaceData?.leagueAvgPace ?? null;
              const _lgOffRtgNba = nbaPaceData?.leagueAvgOffRtg ?? 113.0;
              let _teamExpected = null;
              if (teamOffRtg != null && oppDefRtg != null && _teamPaceNba != null && _oppPaceNba != null && _lgPaceNba != null && _lgPaceNba > 0) {
                const _projPaceNba = (_teamPaceNba * _oppPaceNba) / _lgPaceNba;
                _teamExpected = (teamOffRtg * oppDefRtg / (_lgOffRtgNba * _lgOffRtgNba)) * _projPaceNba;
              } else {
                const teamOff = nbaOffPPGMap[scoringTeam] ?? null;
                const oppDef = nbaDefRank[oppTeam]?.value ?? null;
                if (teamOff != null) _teamExpected = teamOff * (oppDef != null && nbaAvgDef ? oppDef / nbaAvgDef : 1);
              }
              if (_teamExpected != null) {
                const _dk = `nba|team|${scoringTeam}|${oppTeam}`;
                if (!teamTotalDistCache[_dk]) teamTotalDistCache[_dk] = simulateTeamPtsDist(_teamExpected, 11, 10000);
                truePct = totalDistPct(teamTotalDistCache[_dk], threshold);
              }
              // Season HR%: scoring team's rate of scoring >= threshold this season
              const _ttNbaSched = _ttScheduleMap[`nba:${scoringTeam}`] || [];
              const _ttNbaSeasonHits = _ttNbaSched.filter(ev => { const mine = ev.comps.find(c => normTeam("nba", c.abbr) === scoringTeam); return mine && mine.score >= threshold; });
              const ttNbaSeasonHitRate = _ttNbaSched.length >= 5 ? Math.round(_ttNbaSeasonHits.length / _ttNbaSched.length * 100) : null;
              const ttNbaSeasonHitRatePts = ttNbaSeasonHitRate == null ? 1 : ttNbaSeasonHitRate >= 80 ? 2 : ttNbaSeasonHitRate >= 60 ? 1 : 0;
              const _h2h = _ttH2HRate("nba", scoringTeam, oppTeam, threshold);
              const h2hHitRate = _h2h?.rate ?? null;
              const h2hGames = _h2h?.games ?? null;
              const h2hHitRatePts = h2hHitRate == null ? 1 : h2hHitRate >= 80 ? 2 : h2hHitRate >= 60 ? 1 : 0;
              // SimScore (max 10): OffRtg→0-2, oppDefRtg→0-2, Season HR%→0-2, H2H HR%→0-2, O/U→0-2
              teamTotalSimScore += teamOffRtg == null ? 1 : teamOffRtg >= 118 ? 2 : teamOffRtg >= 113 ? 1 : 0;
              teamTotalSimScore += oppDefRtg == null ? 1 : oppDefRtg >= 118 ? 2 : oppDefRtg >= 113 ? 1 : 0;
              teamTotalSimScore += ttNbaSeasonHitRatePts;
              teamTotalSimScore += h2hHitRatePts;
              teamTotalSimScore += _nbaOuLine == null ? 1 : _nbaOuLine >= 225 ? 2 : _nbaOuLine >= 215 ? 1 : 0;
              if (truePct == null) { if (isDebug) dropped.push({ gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, teamTotalSimScore, teamOffRtg, oppDefRtg, gameOuLine: _nbaOuLine, h2hHitRate, h2hGames, h2hHitRatePts, ttNbaSeasonHitRate, ttNbaSeasonHitRatePts, reason: "no_simulation_data" }); continue; }
              const _nttGameTime = gameTimes[`${sport}:${homeTeam}:${gameDate}`] ?? gameTimes[`${sport}:${awayTeam}:${gameDate}`] ?? gameTimes[`${sport}:${homeTeam}`] ?? gameTimes[`${sport}:${awayTeam}`] ?? null;
              const _nttBaseFields = { gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _nttGameTime, teamOffRtg, oppDefRtg, teamExpected: _teamExpected != null ? parseFloat(_teamExpected.toFixed(1)) : null, gameOuLine: _nbaOuLine, gameSpread: _gameSpread, h2hHitRate, h2hGames, h2hHitRatePts, ttNbaSeasonHitRate, ttNbaSeasonHitRatePts };
              const rawEdge = parseFloat((truePct - kalshiPct).toFixed(1));
              const edge = rawEdge;
              if (edge >= 5) {
                teamTotalPlays.push({ ..._nttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, qualified: teamTotalSimScore >= 8, kelly: kellyFraction(truePct, americanOdds), ev: evPerUnit(truePct, americanOdds) });
              } else if (isDebug) {
                dropped.push({ ..._nttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, reason: "edge_too_low" });
              }
              // UNDER play
              const _nttNoTruePct = parseFloat((100 - truePct).toFixed(1));
              const _nttNoKalshiPct = 100 - kalshiPct;
              const _nttUnderEdge = parseFloat((_nttNoTruePct - _nttNoKalshiPct).toFixed(1));
              const _nttNoKalshiAO = _nttNoKalshiPct >= 50 ? Math.round(-(_nttNoKalshiPct/(100-_nttNoKalshiPct))*100) : Math.round((100-_nttNoKalshiPct)/_nttNoKalshiPct*100);
              let _nttUnderSimScore = 0;
              _nttUnderSimScore += teamOffRtg == null ? 1 : teamOffRtg < 113 ? 2 : teamOffRtg < 118 ? 1 : 0;
              _nttUnderSimScore += oppDefRtg == null ? 1 : oppDefRtg < 113 ? 2 : oppDefRtg < 118 ? 1 : 0;
              _nttUnderSimScore += ttNbaSeasonHitRate == null ? 1 : ttNbaSeasonHitRate <= 20 ? 2 : ttNbaSeasonHitRate <= 40 ? 1 : 0;
              _nttUnderSimScore += h2hHitRate == null ? 1 : h2hHitRate <= 30 ? 2 : h2hHitRate <= 50 ? 1 : 0;
              _nttUnderSimScore += _nbaOuLine == null ? 1 : _nbaOuLine < 215 ? 2 : _nbaOuLine < 225 ? 1 : 0;
              if (_nttUnderEdge >= 5 && _nttNoKalshiPct >= 70) {
                teamTotalPlays.push({ ..._nttBaseFields, direction: "under", noTruePct: _nttNoTruePct, noKalshiPct: _nttNoKalshiPct, americanOdds: _nttNoKalshiAO, edge: _nttUnderEdge, rawEdge: _nttUnderEdge, teamTotalSimScore: _nttUnderSimScore, qualified: _nttUnderSimScore >= 8, kelly: kellyFraction(_nttNoTruePct, _nttNoKalshiAO), ev: evPerUnit(_nttNoTruePct, _nttNoKalshiAO) });
              } else if (isDebug) {
                dropped.push({ ..._nttBaseFields, direction: "under", noTruePct: _nttNoTruePct, noKalshiPct: _nttNoKalshiPct, edge: _nttUnderEdge, teamTotalSimScore: _nttUnderSimScore, reason: _nttNoKalshiPct < 70 ? "under_no_price_too_low" : "edge_too_low" });
              }
            }
          }
          // Dedup: one play per scoringTeam+oppTeam+direction (qualified plays win over non-qualified; edge breaks ties within same tier)
          const _ttBestMap = {};
          for (const tp of teamTotalPlays) {
            const key = `${tp.sport}|${tp.scoringTeam}|${tp.oppTeam}|${tp.direction}`;
            const prev = _ttBestMap[key];
            const tpQ = tp.qualified !== false;
            const prevQ = prev && prev.qualified !== false;
            if (!prev || (!prevQ && tpQ) || (prevQ === tpQ && tp.edge > prev.edge)) _ttBestMap[key] = tp;
          }
          const _ttBestIds = new Set(Object.values(_ttBestMap).map(tp => `${tp.sport}|${tp.scoringTeam}|${tp.oppTeam}|${tp.threshold}|${tp.direction}`));
          // Cross-type dedup: one qualified play per game across game totals AND team totals
          // Qualified (simScore≥8) always beats non-qualified; ties broken by edge
          const _crossBestMap = {};
          for (const tp of [...Object.values(_ttBestMap)]) {
            const key = `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}`;
            const tpQ = tp.teamTotalSimScore >= 8;
            const prev = _crossBestMap[key];
            const prevQ = prev && (prev.teamTotalSimScore != null ? prev.teamTotalSimScore >= 8 : prev.totalSimScore >= 8);
            if (!prev || (!prevQ && tpQ) || (prevQ === tpQ && tp.edge > prev.edge)) _crossBestMap[key] = tp;
          }
          // Compare team total winners against any qualified game total for the same game
          for (const [key, gameTp] of Object.entries(_crossBestMap)) {
            const existingGameTotal = plays.find(p => p.gameType === "total" && p.sport === gameTp.sport && p.homeTeam === gameTp.homeTeam && p.awayTeam === gameTp.awayTeam && p.qualified !== false);
            if (existingGameTotal) {
              const gtQ = existingGameTotal.totalSimScore >= 8;
              const ttQ = gameTp.teamTotalSimScore >= 8;
              // Game total wins if: team total isn't qualified, OR both qualified and game total has higher/equal edge
              if (!ttQ || (gtQ && existingGameTotal.edge >= gameTp.edge)) _crossBestMap[key] = existingGameTotal;
            }
          }
          for (const tp of teamTotalPlays) {
            const isTypeBest = _ttBestIds.has(`${tp.sport}|${tp.scoringTeam}|${tp.oppTeam}|${tp.threshold}|${tp.direction}`);
            const crossWinner = _crossBestMap[`${tp.sport}|${tp.homeTeam}|${tp.awayTeam}`];
            const isCrossWinner = crossWinner?.gameType === "teamTotal" && crossWinner?.scoringTeam === tp.scoringTeam && crossWinner?.threshold === tp.threshold && crossWinner?.direction === tp.direction;
            plays.push(isTypeBest && isCrossWinner ? tp : { ...tp, qualified: false });
          }
          // Retroactively mark game totals as non-qualified when a team total won cross-dedup for the same game
          for (let i = 0; i < plays.length; i++) {
            const p = plays[i];
            if (p.gameType !== "total" || p.qualified === false) continue;
            const crossWinner = _crossBestMap[`${p.sport}|${p.homeTeam}|${p.awayTeam}`];
            if (crossWinner?.gameType === "teamTotal") plays[i] = { ...p, qualified: false };
          }
        }
        if (isDebug) {
          const nbaGlLabels = Object.fromEntries(Object.entries(playerGamelogs).filter(([k]) => k.startsWith("nba|")).map(([k, gl]) => [k, gl?.ul ?? null]));
          const nbaGlSample = Object.fromEntries(Object.entries(playerGamelogs).filter(([k]) => k.startsWith("nba|")).map(([k, gl]) => [k, gl?.events?.slice(0, 3).map(ev => ({ stats: ev.stats?.slice(0, 3), statsLen: ev.stats?.length })) ?? null]));
          const sf = reportSportFilter;
          const debugPlays = sf ? plays.filter(m => m.sport === sf) : plays;
          const debugDropped = sf ? dropped.filter(m => m.sport === sf) : dropped;
          const debugPreDropped = sf ? preDropped.filter(m => m.sport === sf) : preDropped;
          return jsonResponse({ plays: debugPlays, dropped: debugDropped, preDropped: debugPreDropped, gamelogErrors, pInfoErrors, qualifyingCount: qualifyingMarkets.length, totalMarketsCount: totalMarkets.length, preFilteredCount: preFilteredMarkets.length, uniquePlayersSearched: uniquePlayerKeys.length, playersWithInfo: Object.keys(playerInfoMap).length, playersWithGamelog: Object.keys(playerGamelogs).length, lineupKPct: sportByteam.mlb?.lineupKPct ?? null, lineupKPctVR: sportByteam.mlb?.lineupKPctVR ?? null, pitcherKPctCache: sportByteam.mlb?.pitcherKPct ?? null, pitcherAvgPitchesCache: sportByteam.mlb?.pitcherAvgPitches ?? null, nbaGlLabels, nbaGlSample }, true);
        }
        // Build mlbMeta: pitchers, ML odds, umpires, weather — keyed by team abbr or "home|away"
        const _mlbPitchers = {};
        for (const [abbr, p] of Object.entries(sportByteam.mlb?.probables ?? {})) {
          if (p?.name) _mlbPitchers[abbr] = { name: p.name, era: p.era ?? null };
        }
        for (const [abbr, p] of Object.entries(sportByteam.mlb?.pitcherInfoByTeam ?? {})) {
          if (!_mlbPitchers[abbr] && p?.name) _mlbPitchers[abbr] = { name: p.name, era: null };
        }
        const _mlbGameOdds = {};
        for (const [abbr, odds] of Object.entries(sportByteam.mlb?.gameOdds ?? {})) {
          _mlbGameOdds[abbr] = { ml: odds.moneyline ?? null, total: odds.total ?? null, spread: odds.spread ?? null };
        }
        const mlbMeta = { pitchers: _mlbPitchers, gameOdds: _mlbGameOdds, umpires: sportByteam.mlb?.umpireByGame ?? {}, weather: weatherByGame, projectedLineupTeams: sportByteam.mlb?.projectedLineupTeams ?? [], teamsWithLineup: Object.keys(sportByteam.mlb?.lineupSpotByName ?? {}), homeTeams: sportByteam.mlb?.gameHomeTeams ?? {}, gameScores: sportByteam.mlb?.gameScores ?? {} };
        // Build mlbMetaTomorrow: tomorrow's probables + umpires (no lineup/weather data available yet)
        let mlbMetaTomorrow = { pitchers: {}, gameOdds: {}, umpires: {}, weather: {}, projectedLineupTeams: [], teamsWithLineup: [], homeTeams: {}, gameScores: {} };
        try {
          const _tmrPT = new Date(Date.now() - 7 * 3600 * 1000 + 86400 * 1000);
          const _tmrDateStr = _tmrPT.toISOString().slice(0, 10);
          const _tmrCacheKey = `mlbSchedTomorrow:${_tmrDateStr}`;
          const _tmrCached = CACHE2 && !isBustCache ? await CACHE2.get(_tmrCacheKey, 'json').catch(() => null) : null;
          const _tmrSched = _tmrCached ?? await fetch(
            `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tmrDateStr}&hydrate=probablePitcher,officials`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          ).then(r => r.ok ? r.json() : {}).catch(() => ({}));
          if (!_tmrCached && CACHE2) CACHE2.put(_tmrCacheKey, JSON.stringify(_tmrSched), { expirationTtl: 600 }).catch(() => {});
          const _tmrPitchers = {}, _tmrUmpires = {}, _tmrHomeTeams = {};
          for (const _td of _tmrSched.dates || []) {
            for (const _tg of _td.games || []) {
              const _tHome = MLB_ID_TO_ABBR[_tg.teams?.home?.team?.id] || _tg.teams?.home?.team?.abbreviation;
              const _tAway = MLB_ID_TO_ABBR[_tg.teams?.away?.team?.id] || _tg.teams?.away?.team?.abbreviation;
              const _tHomeName = _tg.teams?.home?.probablePitcher?.fullName;
              const _tAwayName = _tg.teams?.away?.probablePitcher?.fullName;
              if (_tHome && _tHomeName) _tmrPitchers[_tHome] = { name: _tHomeName, era: null };
              if (_tAway && _tAwayName) _tmrPitchers[_tAway] = { name: _tAwayName, era: null };
              const _tHp = (_tg.officials || []).find(o => o.officialType === 'Home Plate');
              if (_tHp?.official?.fullName && _tHome && _tAway) _tmrUmpires[`${_tHome}|${_tAway}`] = _tHp.official.fullName;
              if (_tHome) _tmrHomeTeams[_tHome] = _tHome;
            }
          }
          mlbMetaTomorrow = { pitchers: _tmrPitchers, gameOdds: {}, umpires: _tmrUmpires, weather: {}, projectedLineupTeams: [], teamsWithLineup: [], homeTeams: _tmrHomeTeams, gameScores: {} };
        } catch { /* leave empty */ }
        // NBA meta: normalized game odds + injury report for matchup cards
        const _nbaOddsNorm = { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX", WPH: "PHX" };
        const _nbaGameOdds = {};
        for (const [abbr, odds] of Object.entries(sportByteam.nbaGameOdds ?? {})) {
          const key = _nbaOddsNorm[abbr] || abbr;
          _nbaGameOdds[key] = { ml: odds.moneyline ?? null, total: odds.total ?? null, spread: odds.spread ?? null };
        }
        const _nbaInjuries = {};
        for (const [abbr, players] of (nbaInjuryMap || new Map()).entries()) {
          const key = _nbaOddsNorm[abbr] || abbr;
          _nbaInjuries[key] = players;
          _nbaInjuries[abbr] = players; // keep original key too for fallback
        }
        const nbaMeta = { gameOdds: _nbaGameOdds, injuries: _nbaInjuries, gameScores: sportByteam.nbaGameScores ?? {} };
        const _nhlGameOdds = {};
        for (const [abbr, odds] of Object.entries(sportByteam.nhlGameOdds ?? {})) {
          _nhlGameOdds[abbr] = { ml: odds.moneyline ?? null, total: odds.total ?? null, spread: odds.spread ?? null };
        }
        const nhlMeta = { gameScores: sportByteam.nhlGameScores ?? {}, gameOdds: _nhlGameOdds };
        const playsResult = { plays, nbaDropped, mlbMeta, mlbMetaTomorrow, nbaMeta, nhlMeta, qualifyingCount: qualifyingMarkets.length, totalMarketsCount: totalMarkets.length, preFilteredCount: preFilteredMarkets.length };
        const sportsInPlays = new Set(plays.map((p) => p.sport));
        if (CACHE2 && sportsInPlays.size >= 2) {
          const summary = {
            date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
            count: plays.length,
            sports: plays.reduce((acc, p) => {
              acc[p.sport] = (acc[p.sport] || 0) + 1;
              return acc;
            }, {}),
            avgEdge: plays.length ? parseFloat((plays.reduce((s, p) => s + (p.edge || 0), 0) / plays.length).toFixed(1)) : 0,
            avgTruePct: plays.length ? parseFloat((plays.reduce((s, p) => s + (p.truePct || 0), 0) / plays.length).toFixed(1)) : 0
          };
          await CACHE2.put(`plays:daily:${summary.date}`, JSON.stringify(summary), { expirationTtl: 7776e3 }).catch(() => {
          });
        }
        return jsonResponse(playsResult, true);
      } else if (path === "live") {
        // Live in-game player stats for pick card tracking
        // ?games=mlb:LAD:SD,nba:GSW:LAL (sport:team1:team2, either home/away order)
        const gamesParam = (params.get("games") || "").trim();
        if (!gamesParam) return jsonResponse({});
        const ptDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
        const ptDateStr = ptDate.replace(/-/g, "");
        const SPORT_PATHS = { mlb: "baseball/mlb", nba: "basketball/nba", nhl: "hockey/nhl" };

        const gameTuples = gamesParam.split(",").map(g => {
          const [sport, ...teams] = g.split(":");
          return { sport, key: g, teams: teams.map(t => t.toUpperCase()) };
        }).filter(g => SPORT_PATHS[g.sport] && g.teams.length >= 2);

        // Group by sport so we fetch each scoreboard once
        const bySport = {};
        for (const t of gameTuples) {
          if (!bySport[t.sport]) bySport[t.sport] = [];
          bySport[t.sport].push(t);
        }

        const liveResult = {};

        await Promise.all(Object.entries(bySport).map(async ([sport, tuples]) => {
          const sportPath = SPORT_PATHS[sport];

          // Check caches first, collect which games still need a scoreboard fetch
          const uncached = [];
          for (const tuple of tuples) {
            const cacheKey = `live:${sport}:${tuple.teams.slice().sort().join(":")}:${ptDate}`;
            const cached = CACHE2 ? await CACHE2.get(cacheKey, "json").catch(() => null) : null;
            if (cached) { liveResult[tuple.key] = cached; }
            else uncached.push({ ...tuple, cacheKey });
          }
          if (!uncached.length) return;

          // Fetch scoreboard to find ESPN event IDs
          let sbEvents = [];
          try {
            const sbRes = await fetch(
              `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/scoreboard?dates=${ptDateStr}`,
              { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
            );
            if (sbRes.ok) sbEvents = (await sbRes.json()).events || [];
          } catch { /* scoreboard unavailable — return pre for all */ }

          await Promise.all(uncached.map(async ({ key, teams, cacheKey }) => {
            const [t1, t2] = teams;

            // Find matching event
            const event = sbEvents.find(ev => {
              const abbrs = (ev.competitions?.[0]?.competitors || [])
                .map(c => c.team?.abbreviation?.toUpperCase());
              return abbrs.includes(t1) && abbrs.includes(t2);
            });

            if (!event) { liveResult[key] = { state: "unknown" }; return; }

            const comp = event.competitions?.[0];
            const state = comp?.status?.type?.state ?? "pre";
            const detail = comp?.status?.type?.shortDetail || comp?.status?.type?.detail || "";

            if (state === "pre") {
              liveResult[key] = { state: "pre", detail };
              return;
            }

            // Fetch boxscore summary
            let players = {};
            try {
              const sumRes = await fetch(
                `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/summary?event=${event.id}`,
                { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
              );
              if (sumRes.ok) {
                const sum = await sumRes.json();

                if (sport === "mlb") {
                  // MLB: boxscore.players[] (same key as NBA) has hitting/pitching statistics sections
                  for (const teamData of sum.boxscore?.players || []) {
                    for (const statsSection of teamData.statistics || []) {
                      const labels = (statsSection.labels || []).map(l => l.toUpperCase());
                      const hasPitching = labels.includes("IP"); // IP is pitching-only; K appears in batting too
                      const hasBatting = labels.includes("RBI") || labels.includes("AB");
                      const kIdx = labels.indexOf("K");
                      const ipIdx = labels.indexOf("IP");
                      const hIdx = labels.indexOf("H");
                      const rIdx = labels.indexOf("R");
                      const rbiIdx = labels.indexOf("RBI");

                      for (const ath of statsSection.athletes || []) {
                        const name = ath.athlete?.fullName || ath.athlete?.displayName;
                        if (!name) continue;
                        const s = ath.stats || [];
                        if (hasPitching && kIdx !== -1) {
                          players[name] = {
                            strikeouts: parseInt(s[kIdx]) || 0,
                            ip: s[ipIdx] ?? "0.0",
                          };
                        } else if (hasBatting && hIdx !== -1) {
                          const h = parseInt(s[hIdx]) || 0;
                          const r = parseInt(s[rIdx]) || 0;
                          const rbi = parseInt(s[rbiIdx]) || 0;
                          players[name] = { hits: h, runs: r, rbi, hrr: h + r + rbi };
                        }
                      }
                    }
                  }
                } else if (sport === "nba") {
                  // NBA: all players in boxscore.players[team].statistics[0]
                  for (const teamData of sum.boxscore?.players || []) {
                    const stats = teamData.statistics?.[0];
                    if (!stats) continue;
                    const labels = (stats.labels || []).map(l => l.toUpperCase());
                    const ptsIdx = labels.indexOf("PTS");
                    const rebIdx = labels.indexOf("REB");
                    const astIdx = labels.indexOf("AST");
                    const fg3Idx = ["3PM","3FG","3PT"].reduce((found, k) => found !== -1 ? found : labels.indexOf(k), -1);
                    for (const ath of stats.athletes || []) {
                      const name = ath.athlete?.fullName || ath.athlete?.displayName;
                      if (!name) continue;
                      const s = ath.stats || [];
                      if (!s.length) continue;
                      players[name] = {
                        points:        parseInt(s[ptsIdx]) || 0,
                        rebounds:      parseInt(s[rebIdx]) || 0,
                        assists:       parseInt(s[astIdx]) || 0,
                        threePointers: fg3Idx !== -1 ? (parseInt(s[fg3Idx]) || 0) : 0,
                      };
                    }
                  }
                } else if (sport === "nhl") {
                  // NHL: players split across multiple statistics[] sections (forwards, defensemen)
                  // Each section has the same label set; G=goals, A=assists, TOI=time on ice
                  for (const teamData of sum.boxscore?.players || []) {
                    for (const stats of teamData.statistics || []) {
                      const labels = (stats.labels || []).map(l => l.toUpperCase());
                      const gIdx   = labels.indexOf("G");
                      if (gIdx === -1) continue; // skip sections without skater stats
                      const aIdx   = labels.indexOf("A");
                      const ptsIdx = labels.indexOf("PTS");
                      const toiIdx = labels.indexOf("TOI");
                      for (const ath of stats.athletes || []) {
                        const name = ath.athlete?.fullName || ath.athlete?.displayName;
                        if (!name) continue;
                        const s = ath.stats || [];
                        if (!s.length) continue;
                        const goals      = parseInt(s[gIdx]) || 0;
                        const assistsNhl = aIdx !== -1 ? (parseInt(s[aIdx]) || 0) : 0;
                        players[name] = {
                          goals, assistsNhl,
                          points: ptsIdx !== -1 ? (parseInt(s[ptsIdx]) || 0) : goals + assistsNhl,
                          toi: toiIdx !== -1 ? (s[toiIdx] ?? "0:00") : "0:00",
                        };
                      }
                    }
                  }
                }
              }
            } catch { /* boxscore unavailable */ }

            const gameData = { state, detail, players };
            liveResult[key] = gameData;
            if (CACHE2) {
              const ttl = state === "post" ? 300 : 60;
              await CACHE2.put(cacheKey, JSON.stringify(gameData), { expirationTtl: ttl }).catch(() => {});
            }
          }));
        }));

        return jsonResponse(liveResult);

      } else if (path === "plays/history") {
        if (!CACHE2) return jsonResponse({ history: [] });
        const today = /* @__PURE__ */ new Date();
        const dates = [];
        for (let i = 0; i < 60; i++) {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          dates.push(d.toISOString().slice(0, 10));
        }
        const results = await Promise.all(dates.map(
          (d) => CACHE2.get(`plays:daily:${d}`, "json").catch(() => null)
        ));
        const history = results.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
        return jsonResponse({ history }, 300);
      } else if (path === "leagues") {
        return jsonResponse({ leagues: VALID_SPORTS });
      } else if (path === "team") {
        const abbr = (params.get("abbr") || "").toUpperCase();
        const sport = params.get("sport"); // "mlb" | "nba" | "nhl"
        if (!abbr || !["mlb","nba","nhl"].includes(sport)) return errorResponse("abbr and sport (mlb|nba|nhl) required", 400);
        const bust = params.get("bust") === "1";
        const today = new Date().toISOString().slice(0, 10);
        const cacheKey = `team:v3:${sport}:${abbr}:${today}`;
        if (CACHE2 && !bust) {
          const cached = await CACHE2.get(cacheKey, "json").catch(() => null);
          if (cached) return jsonResponse(cached);
        }
        const sportLeague = { mlb:"baseball/mlb", nba:"basketball/nba", nhl:"hockey/nhl" }[sport];
        const abbrLower = abbr.toLowerCase();
        const H = { "User-Agent":"Mozilla/5.0" };
        // 1. ESPN team schedule → game log + record
        let gameLog = [], teamName = abbr, wins = 0, losses = 0, nextGame = null, lastGameId = null;
        try {
          const schedRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportLeague}/teams/${abbrLower}/schedule?season=2026&seasontype=2`, { headers: H });
          if (schedRes.ok) {
            const sched = await schedRes.json();
            teamName = sched.team?.displayName || sched.team?.name || abbr;
            // Record from summary string e.g. "10-5"
            const recSummary = sched.team?.recordSummary || sched.team?.record?.items?.[0]?.summary;
            if (recSummary) { const p = recSummary.split("-"); wins = parseInt(p[0]) || 0; losses = parseInt(p[1]) || 0; }
            for (const event of sched.events || []) {
              const comp = event.competitions?.[0];
              if (!comp?.status?.type?.completed) {
                // Capture next upcoming or in-progress game — must be today or future
                const evDateStr = (event.date || "").slice(0, 10);
                const todayUtc = new Date().toISOString().slice(0, 10);
                if (!nextGame && evDateStr >= todayUtc) {
                  const homeComp = comp.competitors?.find(c => c.homeAway === "home");
                  const awayComp = comp.competitors?.find(c => c.homeAway === "away");
                  if (homeComp && awayComp) {
                    const hAbbr = (homeComp.team?.abbreviation || "").toUpperCase();
                    const isHome = hAbbr === abbr;
                    const oppComp = isHome ? awayComp : homeComp;
                    nextGame = { date: evDateStr, isHome, opp: (oppComp.team?.abbreviation || "").toUpperCase(), gameTime: event.date };
                  }
                }
                continue;
              }
              const homeComp = comp.competitors?.find(c => c.homeAway === "home");
              const awayComp = comp.competitors?.find(c => c.homeAway === "away");
              if (!homeComp || !awayComp) continue;
              const homeAbbr = (homeComp.team?.abbreviation || "").toUpperCase();
              const teamIsHome = homeAbbr === abbr;
              const teamComp = teamIsHome ? homeComp : awayComp;
              const oppComp  = teamIsHome ? awayComp  : homeComp;
              const teamScore = parseFloat(teamComp.score?.value ?? teamComp.score?.displayValue ?? teamComp.score) || 0;
              const oppScore  = parseFloat(oppComp.score?.value  ?? oppComp.score?.displayValue  ?? oppComp.score)  || 0;
              const winner = teamComp.winner === true;
              const loser  = oppComp.winner  === true;
              if (!winner && !loser) continue; // tie / no result
              const result = winner ? "W" : "L";
              const opp  = (teamIsHome ? (awayComp.team?.abbreviation || "").toUpperCase() : (homeComp.team?.abbreviation || "").toUpperCase()) || "?";
              const date = (event.date || "").slice(0, 10);
              if (!date) continue;
              lastGameId = event.id; // track most recent completed game for lineup
              gameLog.push({ date, isHome: teamIsHome, opp, teamScore, oppScore, total: teamScore + oppScore, result });
            }
          }
        } catch(e) {}
        gameLog.sort((a, b) => b.date.localeCompare(a.date));
        const avgTotal = gameLog.length > 0
          ? parseFloat((gameLog.reduce((s, g) => s + g.total, 0) / gameLog.length).toFixed(1))
          : null;
        // 2. Lineup
        let lineup = [], lineupConfirmed = false;
        if (sport === "nba") {
          const _nbaEspnNorm = { NY:"NYK", GS:"GSW", SA:"SAS", NO:"NOP", PHO:"PHX" };
          const _normNba = a => _nbaEspnNorm[a?.toUpperCase()] || a?.toUpperCase() || "";

          // Helper: extract starters from a game summary event ID
          async function _getStartersFromGame(gameId) {
            const sumRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`, { headers: H });
            if (!sumRes.ok) return [];
            const sum = await sumRes.json();
            for (const tp of sum.boxscore?.players || []) {
              if (_normNba(tp.team?.abbreviation) !== abbr) continue;
              return (tp.statistics?.[0]?.athletes || [])
                .filter(a => a.starter)
                .map(a => ({ position: a.athlete?.position?.abbreviation || "?", name: a.athlete?.displayName || "Unknown", playerId: String(a.athlete?.id || "") }));
            }
            return [];
          }

          // 1. Today's scoreboard — game in progress or about to start
          try {
            const sbRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard`, { headers: H });
            if (sbRes.ok) {
              const sb = await sbRes.json();
              for (const ev of sb.events || []) {
                if (ev.competitions?.[0]?.competitors?.some(c => _normNba(c.team?.abbreviation) === abbr)) {
                  const starters = await _getStartersFromGame(ev.id);
                  if (starters.length > 0) { lineup = starters; lineupConfirmed = true; }
                  break;
                }
              }
            }
          } catch(e) {}

          // 2. Most recent completed game boxscore — reliable expected starters (playoffs)
          // Always prefer playoff schedule (seasontype=3) over regular season lastGameId
          if (lineup.length === 0) {
            let _lastGameId = null;
            try {
              const pSched = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${abbrLower}/schedule?season=2026&seasontype=3`, { headers: H });
              if (pSched.ok) {
                const ps = await pSched.json();
                for (const ev of ps.events || []) {
                  if (ev.competitions?.[0]?.status?.type?.completed) _lastGameId = ev.id;
                }
              }
            } catch(e) {}
            // Fall back to regular season lastGameId if no playoff games found
            if (!_lastGameId) _lastGameId = lastGameId;
            if (_lastGameId) {
              try {
                const starters = await _getStartersFromGame(_lastGameId);
                if (starters.length > 0) { lineup = starters; lineupConfirmed = false; }
              } catch(e) {}
            }
          }

          // 3. Roster fallback — one player per position group
          if (lineup.length === 0) {
            try {
              const rosRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${abbrLower}/roster`, { headers: H });
              if (rosRes.ok) {
                const ros = await rosRes.json();
                const seen = new Set();
                for (const a of ros.athletes || []) {
                  const pos = a.position?.abbreviation;
                  if (!pos || seen.has(pos)) continue;
                  seen.add(pos);
                  lineup.push({ position: pos, name: a.displayName || "Unknown", playerId: String(a.id || "") });
                  if (lineup.length >= 8) break;
                }
              }
            } catch(e) {}
          }
        } else if (sport === "mlb") {
          const MLB_ABR_TO_ID = { ARI:109,ATL:144,BAL:110,BOS:111,CHC:112,CWS:145,CIN:113,CLE:114,COL:115,DET:116,HOU:117,KC:118,LAA:108,LAD:119,MIA:146,MIL:158,MIN:142,NYM:121,NYY:147,OAK:133,PHI:143,PIT:134,SD:135,SEA:136,SF:137,STL:138,TB:139,TEX:140,TOR:141,WSH:120 };
          const mlbId = MLB_ABR_TO_ID[abbr];
          if (mlbId) {
            try {
              const ptDate = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
              const sRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?date=${ptDate}&hydrate=lineups,probables&sportId=1&teamId=${mlbId}`, { headers: H });
              if (sRes.ok) {
                const sd = await sRes.json();
                const game = sd.dates?.[0]?.games?.[0];
                if (game) {
                  const isHome = game.teams?.home?.team?.id === mlbId;
                  const lp = isHome ? (game.lineups?.homePlayers || []) : (game.lineups?.awayPlayers || []);
                  if (lp.length > 0) {
                    lineupConfirmed = true;
                    lineup = lp.map((p, i) => ({ spot: i + 1, name: p.fullName || "Unknown", position: p.primaryPosition?.abbreviation || "?", playerId: String(p.id || "") }));
                  }
                  const probable = (isHome ? game.teams?.home : game.teams?.away)?.probablePitcher;
                  if (probable) lineup.push({ spot: null, name: probable.fullName || "Unknown", position: "SP", playerId: String(probable.id || ""), isProbable: true });
                }
              }
            } catch(e) {}
          }
          // Roster fallback — show active position players when lineup not yet submitted
          if (lineup.length === 0 && mlbId) {
            try {
              const rosRes = await fetch(`https://statsapi.mlb.com/api/v1/teams/${mlbId}/roster?season=2026&rosterType=active`, { headers: H });
              if (rosRes.ok) {
                const ros = await rosRes.json();
                (ros.roster || [])
                  .filter(r => r.position?.type !== "Pitcher" && r.position?.abbreviation !== "TWP")
                  .slice(0, 12)
                  .forEach(r => lineup.push({ spot: null, name: r.person?.fullName || "Unknown", position: r.position?.abbreviation || "?", playerId: String(r.person?.id || "") }));
              }
            } catch(e) {}
          }
        }
        const teamResult = { teamAbbr: abbr, teamName, sport, record: `${wins}-${losses}`, wins, losses, gameLog, seasonStats: { avgTotal, gamesPlayed: gameLog.length }, lineup, lineupConfirmed, nextGame };
        if (CACHE2) await CACHE2.put(cacheKey, JSON.stringify(teamResult), { expirationTtl: 3600 }).catch(() => {});
        return jsonResponse(teamResult);
      } else {
        return errorResponse("Unknown route: " + path, 404);
      }
    } catch (e) {
      return errorResponse(e.message, 500);
    }
  }
};

export const config = { runtime: 'edge' }; // redeploy 2

export default async function handler(request) {
  const env = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_KEY: process.env.ADMIN_KEY,
  };
  const ctx = { waitUntil: (p) => { try { p.catch?.(() => {}); } catch {} } };
  return worker_default.fetch(request, env, ctx);
}
