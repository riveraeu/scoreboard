import { ALLOWED_ORIGIN, corsHeaders, jsonResponse, errorResponse, parseGameOdds, buildSoftTeamAbbrs, buildHardTeamAbbrs, buildTeamRankMap } from "./lib/utils.js";
import { PARK_KFACTOR, PARK_HITFACTOR, PARK_RUNFACTOR, UMPIRE_KFACTOR, log5K, poissonCDF, log5HitRate, simulateKsDist, kDistPct, simulateKs, buildNbaStatDist, nbaDistPct, simulateHits, simulateMLBTotalDist, simulateNBATotalDist, simulateNHLTotalDist, totalDistPct, decimalOdds, kellyFraction, evPerUnit } from "./lib/simulate.js";
import { buildLineupKPct, buildBarrelPct, buildPitcherKPct } from "./lib/mlb.js";
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
        if (password.length < 6) return errorResponse("Password must be at least 6 characters", 400);
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
        if (params.get("adminKey") !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
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
        if (params.get("adminKey") !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
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
        return jsonResponse({ totalPicks: allPicks.length, finalizedPicks: finalized.length, overall, byCategory, kStrikeouts: { bySimScore, byKpctPts, byKTrendPts, n: ksFinalized.length } });
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
      } else if (path === "auth/import-kalshi-picks" && method === "POST") {
        const { kalshiToken: providedToken, kalshiSession, adminKey: importAdminKey, userId: importUserId } = await request.json();
        if (importAdminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
        if (!providedToken && !kalshiSession) return errorResponse("kalshiToken or kalshiSession required", 400);
        if (!importUserId) return errorResponse("userId required", 400);
        const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
        const KMON2 = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };
        const IMP_SERIES = {
          KXNBAPTS:{sport:"nba",stat:"points"},KXNBAREB:{sport:"nba",stat:"rebounds"},KXNBAAST:{sport:"nba",stat:"assists"},KXNBA3PT:{sport:"nba",stat:"threePointers"},
          KXNHLPTS:{sport:"nhl",stat:"points"},KXMLBHITS:{sport:"mlb",stat:"hits"},KXMLBKS:{sport:"mlb",stat:"strikeouts"},KXMLBHRR:{sport:"mlb",stat:"hrr"},
          KXMLBTOTAL:{sport:"mlb",stat:"totalRuns",gameType:"total"},KXNBATOTAL:{sport:"nba",stat:"totalPoints",gameType:"total"},KXNHLTOTAL:{sport:"nhl",stat:"totalGoals",gameType:"total"},
        };
        const IMP_TNORM = { nba:{GS:"GSW",SA:"SAS",NY:"NYK",NJ:"BKN",NO:"NOP",PHO:"PHX"}, nhl:{NJ:"NJD",TB:"TBL",LA:"LAK",SJ:"SJS"}, mlb:{KCR:"KC",SFG:"SF",SDP:"SD",TBR:"TB",CHW:"CWS",AZ:"ARI",OAK:"ATH",WSN:"WSH",WAS:"WSH"}, nfl:{LA:"LAR"} };
        const impNT = (sport, a) => IMP_TNORM[sport]?.[a] || a;
        const impTeams = (eventTicker, sport) => {
          const seg = (eventTicker || "").split("-")[1] || "";
          let rest = seg.slice(7);
          if (/^\d{4}[A-Z]/.test(rest)) rest = rest.slice(4);
          if (rest.length < 4) return [null, null];
          const has2 = IMP_TNORM[sport]?.[rest.slice(0,2)] !== undefined;
          if (rest.length >= 6 && !has2) return [impNT(sport,rest.slice(0,3)), impNT(sport,rest.slice(3,6))];
          if (rest.length >= 5 && has2) return [impNT(sport,rest.slice(0,2)), impNT(sport,rest.slice(2,5))];
          if (rest.length >= 5) return [impNT(sport,rest.slice(0,3)), impNT(sport,rest.slice(3,5))];
          return [null, null];
        };
        const kalshiToken = providedToken;
        const kHdrs = kalshiSession
          ? { "Cookie":`session=${kalshiSession}`, "Content-Type":"application/json" }
          : { "Authorization":`Bearer ${kalshiToken}`, "Content-Type":"application/json" };
        // Step 2: Fetch fills (last 5 days)
        const minTs = Math.floor((Date.now() - 5 * 86400000) / 1000);
        let allFills = [], cursor2 = null;
        for (let pg = 0; pg < 10; pg++) {
          const qp2 = new URLSearchParams({ limit:"200", min_ts:String(minTs), ...(cursor2 ? {cursor:cursor2} : {}) });
          const fr = await fetch(`${KALSHI_BASE}/portfolio/fills?${qp2}`, { headers:kHdrs });
          if (!fr.ok) break;
          const fd = await fr.json();
          allFills = allFills.concat(fd.fills || []);
          cursor2 = fd.cursor;
          if (!cursor2 || (fd.fills||[]).length === 0) break;
        }
        // Step 3: Deduplicate by ticker (keep earliest YES fill per ticker = entry price)
        allFills.sort((a,b) => new Date(a.created_time||0) - new Date(b.created_time||0));
        const seenT = new Set(), relevantFills = [];
        for (const fill of allFills) {
          if (fill.side !== "yes") continue;
          const tkr = fill.ticker || "";
          if (seenT.has(tkr)) continue;
          const series = Object.keys(IMP_SERIES).find(s => tkr.startsWith(s + "-"));
          if (!series) continue;
          seenT.add(tkr);
          relevantFills.push({ ...fill, series });
        }
        // Step 4: Fetch market details for player names + settlement
        const mDetails = await Promise.all(relevantFills.map(f =>
          fetch(`${KALSHI_BASE}/markets/${f.ticker}`, { headers:kHdrs }).then(r => r.ok ? r.json() : null).catch(() => null)
        ));
        // Step 5: Build pick objects
        const importedPicks = [];
        for (let i = 0; i < relevantFills.length; i++) {
          const fill = relevantFills[i];
          const mRaw = mDetails[i];
          const market = mRaw?.market || mRaw;
          if (!market) continue;
          const cfg = IMP_SERIES[fill.series];
          const { sport, stat, gameType } = cfg;
          const strike = parseFloat(market.floor_strike);
          if (isNaN(strike)) continue;
          const threshold = Math.round(strike + 0.5);
          const fillPrice = parseFloat(fill.yes_price_dollars) || 0;
          const kalshiPct2 = fillPrice <= 1 ? Math.round(fillPrice * 100) : Math.round(fillPrice); // handle cents or decimal
          if (kalshiPct2 <= 0) continue;
          const americanOdds2 = kalshiPct2 >= 50 ? Math.round(-(kalshiPct2/(100-kalshiPct2))*100) : Math.round((100-kalshiPct2)/kalshiPct2*100);
          const dateSeg2 = (market.event_ticker||"").split("-")[1]||"";
          let gameDate2 = null;
          if (dateSeg2.length >= 7) { const yr2="20"+dateSeg2.slice(0,2), mo2=KMON2[dateSeg2.slice(2,5).toUpperCase()], dy2=dateSeg2.slice(5,7); if (mo2) gameDate2=`${yr2}-${mo2}-${dy2}`; }
          const trackedAt2 = fill.created_time ? new Date(fill.created_time).getTime() : Date.now();
          const mStatus = market.status || "";
          const mResult = market.result;
          const result2 = mStatus === "finalized" ? (mResult === "yes" ? "won" : mResult === "no" ? "lost" : null) : null;
          let pickId, pickBase;
          if (gameType === "total") {
            const [t1, t2] = impTeams(market.event_ticker||"", sport);
            pickId = `total|${sport}|${t1}|${t2}|${threshold}|${gameDate2||""}`;
            pickBase = { gameType:"total", sport, stat, threshold, homeTeam:t1, awayTeam:t2, gameDate:gameDate2 };
          } else {
            const rawTitle = market.event_title || market.title || "";
            const pnDisplay = rawTitle.replace(/\s*:\s*\d.*$/,"").replace(/\s+(Points?|Rebounds?|Assists?|3-Pointers?|Three Pointers?|Made Threes?|Goals?|Shots on Goal|Hits?|Home Runs?|RBIs?|Strikeouts?|Total Bases?|Passing Yards?|Rushing Yards?|Receiving Yards?|Touchdowns?)\b.*/i,"").replace(/\s+Over\s+\d.*$/i,"").replace(/\s+Under\s+\d.*$/i,"").replace(/\s*\(.*\)\s*$/,"").replace(/\s*-\s*$/,"").trim();
            if (!pnDisplay || pnDisplay.length < 4) continue;
            pickId = `${sport}|${pnDisplay}|${stat}|${threshold}|${gameDate2||""}`;
            pickBase = { sport, stat, threshold, playerName:pnDisplay, playerNameDisplay:pnDisplay, gameDate:gameDate2 };
          }
          importedPicks.push({ ...pickBase, id:pickId, kalshiPct:kalshiPct2, americanOdds:americanOdds2, trackedAt:trackedAt2, result:result2, units:1, _importedFrom:"kalshi", _fillTicker:fill.ticker });
        }
        // Step 6: Merge with existing picks (new imports prepend; skip duplicates)
        const existingPicksData = await CACHE2.get(`picks:${importUserId}`, "json").catch(() => null);
        const existingPicks = existingPicksData?.picks || [];
        const existingIds2 = new Set(existingPicks.map(p => p.id));
        const newOnly = importedPicks.filter(p => !existingIds2.has(p.id));
        const merged2 = [...importedPicks, ...existingPicks.filter(p => !importedPicks.find(ip => ip.id === p.id))];
        merged2.sort((a,b) => (b.trackedAt||0) - (a.trackedAt||0));
        await CACHE2.put(`picks:${importUserId}`, JSON.stringify({ picks:merged2, bankroll:existingPicksData?.bankroll||1000 }));
        return jsonResponse({ ok:true, imported:newOnly.length, skippedDuplicates:importedPicks.length-newOnly.length, total:merged2.length, picks:newOnly });
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
        const pageUrl = year ? `https://www.espn.com/${leagueSlug}/player/gamelog/_/id/${athleteId}/year/${year}` : `https://www.espn.com/${leagueSlug}/player/gamelog/_/id/${athleteId}`;
        const pageRes = await fetch(pageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.espn.com/"
          }
        });
        if (!pageRes.ok) return errorResponse(`ESPN page returned ${pageRes.status}`, pageRes.status);
        const html = await pageRes.text();
        const match = html.match(/window\['__espnfitt__'\]\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
        if (!match) return errorResponse("Could not find __espnfitt__ data in page", 500);
        let fitt;
        try {
          fitt = JSON.parse(match[1]);
        } catch (e) {
          return errorResponse("Failed to parse __espnfitt__: " + e.message, 500);
        }
        const gmlog = fitt?.page?.content?.player?.gmlog;
        if (!gmlog) return errorResponse("No gmlog found in page data", 500);
        const labels = (gmlog.labels || []).map((l) => l.data || l);
        const seenIds = /* @__PURE__ */ new Set();
        const allEvents = [];
        const groups = gmlog.groups || [];
        const regularGroup = groups.find((g) => g.name && g.name.toLowerCase().includes("regular")) || groups[0];
        (regularGroup?.tbls || []).forEach((tbl) => {
          if (tbl.type !== "event") return;
          (tbl.events || []).forEach((ev) => {
            if (seenIds.has(ev.id)) return;
            if (!ev.dt && !ev.opp) return;
            if (ev.opp?.allStar || ev.nt && ev.nt.toLowerCase().includes("all-star")) return;
            seenIds.add(ev.id);
            allEvents.push({
              eventId: ev.id,
              stats: ev.stats || [],
              date: ev.dt,
              oppId: ev.opp?.id || null,
              oppAbbr: ev.opp?.abbr || null,
              isHome: ev.opp?.at != null ? !ev.opp.at : null
              // ESPN: opp.at=true means player is away
            });
          });
        });
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
              "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=defensive",
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
            const _hd0 = new Date(); const _hd1 = new Date(_hd0); _hd1.setDate(_hd1.getDate() + 1);
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
          // Game totals — direction always "over" for yes side; under plays invert kalshiPct
          KXMLBTOTAL: { sport: "mlb", league: "mlb", stat: "totalRuns",   col: "R",   gameType: "total" },
          KXNBATOTAL: { sport: "nba", league: "nba", stat: "totalPoints", col: "PTS", gameType: "total" },
          KXNHLTOTAL: { sport: "nhl", league: "nhl", stat: "totalGoals",  col: "G",   gameType: "total" },
          KXNFLTOTAL: { sport: "nfl", league: "nfl", stat: "totalPoints", col: "PTS", gameType: "total" },
        };
        const TEAM_NORM = {
          nba: { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX", WPH: "PHX" },
          nhl: { NJ: "NJD", TB: "TBL", LA: "LAK", SJ: "SJS", VGK: "VGK" },
          mlb: { KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", CHW: "CWS", AZ: "ARI", KC: "KC", SD: "SD", SF: "SF", TB: "TB", OAK: "ATH", WSN: "WSH", WAS: "WSH" },
          nfl: { LA: "LAR" }
        };
        // Polymarket name→abbr: event titles use full names (MLB) or short nicknames (NBA/NHL)
        const POLY_NAME_TO_ABBR = {
          mlb: { "D-backs":"ARI","Diamondbacks":"ARI","Braves":"ATL","Orioles":"BAL","Red Sox":"BOS","Cubs":"CHC","White Sox":"CWS","Reds":"CIN","Guardians":"CLE","Rockies":"COL","Tigers":"DET","Astros":"HOU","Royals":"KC","Angels":"LAA","Dodgers":"LAD","Marlins":"MIA","Brewers":"MIL","Twins":"MIN","Mets":"NYM","Yankees":"NYY","Athletics":"OAK","Phillies":"PHI","Pirates":"PIT","Padres":"SD","Giants":"SF","Mariners":"SEA","Cardinals":"STL","Rays":"TB","Rangers":"TEX","Blue Jays":"TOR","Nationals":"WSH" },
          nba: { "Hawks":"ATL","Celtics":"BOS","Nets":"BKN","Hornets":"CHA","Bulls":"CHI","Cavaliers":"CLE","Mavericks":"DAL","Nuggets":"DEN","Pistons":"DET","Warriors":"GSW","Rockets":"HOU","Pacers":"IND","Clippers":"LAC","Lakers":"LAL","Grizzlies":"MEM","Heat":"MIA","Bucks":"MIL","Timberwolves":"MIN","Pelicans":"NOP","Knicks":"NYK","Thunder":"OKC","Magic":"ORL","76ers":"PHI","Suns":"PHX","Trail Blazers":"POR","Blazers":"POR","Kings":"SAC","Spurs":"SAS","Raptors":"TOR","Jazz":"UTA","Wizards":"WAS" },
          nhl: { "Ducks":"ANA","Coyotes":"ARI","Bruins":"BOS","Sabres":"BUF","Hurricanes":"CAR","Blue Jackets":"CBJ","Flames":"CGY","Blackhawks":"CHI","Avalanche":"COL","Stars":"DAL","Red Wings":"DET","Oilers":"EDM","Panthers":"FLA","Kings":"LAK","Wild":"MIN","Canadiens":"MTL","Devils":"NJD","Predators":"NSH","Islanders":"NYI","Rangers":"NYR","Senators":"OTT","Flyers":"PHI","Penguins":"PIT","Kraken":"SEA","Sharks":"SJS","Blues":"STL","Lightning":"TBL","Maple Leafs":"TOR","Utah":"UTA","Canucks":"VAN","Golden Knights":"VGK","Jets":"WPG","Capitals":"WSH" }
        };
        const POLY_SERIES = { mlb: 3, nba: 10345, nhl: 10346 };
        const normTeam = /* @__PURE__ */ __name((sport, a) => TEAM_NORM[sport]?.[a] || a, "normTeam");
        const seriesTickers = Object.keys(SERIES_CONFIG);
        async function fetchKalshiSeries(ticker) {
          const staleKey = `kalshi:stale:${ticker}`;
          const fetchOne = /* @__PURE__ */ __name(() => fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ticker}&limit=1000&status=open`, {
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
            cf: { cacheEverything: false }
          }).then((r) => r.ok ? r.json() : null).catch(() => null), "fetchOne");
          const fresh = await fetchOne();
          if (fresh && (fresh.markets || []).length > 0) {
            if (CACHE2) await CACHE2.put(staleKey, JSON.stringify(fresh));
            return { data: fresh, fromCache: false };
          }
          if (CACHE2) {
            const stale = await CACHE2.get(staleKey, "json");
            if (stale) return { data: stale, fromCache: true, stale: true };
          }
          return { data: { markets: [] }, fromCache: false, failed: true };
        }
        __name(fetchKalshiSeries, "fetchKalshiSeries");
        const firstPass = await Promise.all(seriesTickers.map(fetchKalshiSeries));
        const kalshiResults = await Promise.all(firstPass.map(async (res, i) => {
          if (!res.failed) return res.data;
          await new Promise((r) => setTimeout(r, 200));
          const retry = await fetchKalshiSeries(seriesTickers[i]);
          return retry.data;
        }));
        const qualifyingMarkets = [];
        const totalMarkets = []; // game total markets (pct 30–97, both over and under surfaced)
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
            const price = yesAsk > 0 ? yesAsk : last;
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
        // Blended fill price: walk the orderbook for unit-sized positions so kalshiPct reflects
        // true cost, not just top-of-book ask. 1 unit = $100 at risk; tiers: 70-83% = 1u, 83-93% = 3u, 93%+ = 5u.
        const UNIT_DOLLARS = 50; // 1 unit = 1% of $5k bankroll
        const getContracts = (pct, ask) => ask > 0 ? Math.ceil(UNIT_DOLLARS * (pct >= 93 ? 5 : pct >= 83 ? 3 : 1) / ask) : 0;
        const thinMarkets = qualifyingMarkets.filter((m) => m._ticker && getContracts(m.kalshiPct, m._yesAsk) > m._yesAskSize);
        const obMap = {};
        if (thinMarkets.length > 0) {
          const obFetches = await Promise.all(thinMarkets.map((m) => fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${m._ticker}/orderbook`, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : null).catch(() => null)));
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
        for (const m of [...qualifyingMarkets, ...totalMarkets]) {
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
            if (isBustCache && (sport === "mlb" || sport === "nhl")) return;
            const cached = await CACHE2.get(`byteam:${sport}`, "json").catch(() => null);
            if (cached) sportByteam[sport] = cached;
          }));
        }
        const sportsNeedingFetch = new Set([...sportsNeeded].filter((s) => !sportByteam[s]));
        if (sportsNeedingFetch.size > 0) {
          await Promise.all([
            sportsNeedingFetch.has("nba") && Promise.all([
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=defensive", {
                headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
              }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=scoring", {
                headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
              }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              (() => { const _nd = new Date(); const _ns = _nd.toISOString().slice(0,10).replace(/-/g,''); return fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_ns}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})); })()
            ]).then(async ([d, scoringData, sbData]) => {
              sportByteam.nba = d.teams || [];
              sportByteam.nbaScoring = scoringData.teams || [];
              sportByteam.nbaGameOdds = parseGameOdds(sbData.events || []);
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
              (() => {
                const _td0 = new Date(); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
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
                const _td0 = new Date(); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
                const _tfmt2 = (d) => d.toISOString().slice(0, 10);
                return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td0)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((s0) => {
                  const allFinal = (s0.dates || []).flatMap((d) => d.games || []).every((g) => g.status?.abstractGameState === "Final");
                  if ((s0.dates || []).length === 0 || allFinal) {
                    return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td1)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
                  }
                  return s0;
                });
              })()
            ]).then(async ([pitchData, batData, sbData, mlbSched]) => {
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
                    const name = probable.athlete?.displayName || probable.athlete?.fullName || null;
                    const id = probable.athlete?.id || null;
                    const opp = gameAbbrs.find((a) => a !== abbr) || null;
                    probables[abbr] = { name, era, id, opp };
                  }
                }
              }
              const gameOddsRaw = parseGameOdds(sbData.events);
              const gameOdds = Object.fromEntries(Object.entries(gameOddsRaw).map(([k, v]) => [normMlbAbbr(k), v]));
              const [lineupResult, pitcherResult] = await Promise.all([buildLineupKPct(mlbSched), buildPitcherKPct(mlbSched)]);
              const { lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered, lineupSpotByName, gameHomeTeams, projectedLineupTeams, batterSplitBA } = lineupResult;
              const { pitcherKPct, pitcherKBBPct, pitcherCSWPct, pitcherAvgPitches, pitcherGS26, pitcherHasAnchor, pitcherHand, pitcherEra: pitcherEraByTeam, pitcherStatsByName, pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC, umpireByGame, pitcherInfoByTeam } = pitcherResult;
              // barrelPctMap is NOT stored in byteam:mlb — it lives in mlb:barrelPct with its own 6h TTL.
              // This prevents a bust (which deletes byteam:mlb) from baking an empty barrelPctMap
              // into the cache when Baseball Savant is slow.
              sportByteam.mlb = { pitching: pitchData, batting: batData, probables, lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered, lineupSpotByName, gameHomeTeams, pitcherKPct, pitcherKBBPct, pitcherCSWPct, pitcherAvgPitches, pitcherGS26, pitcherHasAnchor, pitcherHand, pitcherEra: pitcherEraByTeam, projectedLineupTeams, gameOdds, pitcherStatsByName, batterSplitBA, pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC, umpireByGame, pitcherInfoByTeam };
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
          if (CACHE2) sportByteam.nbaScoring = await CACHE2.get("byteam:nba:scoring", "json").catch(() => null);
          if (!sportByteam.nbaScoring) {
            sportByteam.nbaScoring = await fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=scoring", {
              headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
            }).then(r => r.ok ? r.json() : {}).then(d => d.teams || []).catch(() => []);
            if (CACHE2 && Array.isArray(sportByteam.nbaScoring) && sportByteam.nbaScoring.length > 0) {
              await CACHE2.put("byteam:nba:scoring", JSON.stringify(sportByteam.nbaScoring), { expirationTtl: 21600 }).catch(() => {});
            }
          }
        }
        // Fetch game start times + NBA player availability for tonight's games
        const todayDateStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
        let [gameTimes, nbaPlayerStatus] = await Promise.all([
          CACHE2 && !isBustCache ? CACHE2.get(`gameTimes:v2:${todayDateStr}`, "json").catch(() => null) : null,
          CACHE2 ? CACHE2.get(`nbaStatus:${todayDateStr}`, "json").catch(() => null) : null,
        ]);
        const needGameTimes = !gameTimes;
        const needNbaStatus = !nbaPlayerStatus && sportsNeeded.has("nba");
        if (needGameTimes || needNbaStatus) {
          gameTimes = gameTimes || {};
          nbaPlayerStatus = nbaPlayerStatus || {};
          const SPORT_SB_PATH = { nba: "basketball/nba", nhl: "hockey/nhl", mlb: "baseball/mlb" };
          const sportsToFetch = needGameTimes ? [...sportsNeeded].filter(s => SPORT_SB_PATH[s]) : (needNbaStatus ? ["nba"] : []);
          const yesterdayDateStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, "");
          const sbResults = await Promise.all(sportsToFetch.map(async s => {
            try {
              const H2 = { "User-Agent": "Mozilla/5.0" };
              const base = `https://site.api.espn.com/apis/site/v2/sports/${SPORT_SB_PATH[s]}/scoreboard`;
              const [r1, r2] = await Promise.all([
                fetch(`${base}?dates=${yesterdayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${todayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
              ]);
              return { sport: s, events: [...(r1.events || []), ...(r2.events || [])] };
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
                    gameTimes[`${key}:${ptDate}`] = ev.date;   // date-specific key
                    if (!gameTimes[key]) gameTimes[key] = ev.date; // bare fallback (first seen wins)
                  }
                }
              }
            }
            if (CACHE2 && Object.keys(gameTimes).length > 0) await CACHE2.put(`gameTimes:v2:${todayDateStr}`, JSON.stringify(gameTimes), { expirationTtl: 600 }).catch(() => {});
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
        // Fetch NBA game odds if nba byteam was loaded from cache (scoreboard not fetched above)
        if (sportsNeeded.has("nba") && !sportByteam.nbaGameOdds) {
          const _nd2 = new Date(); const _ns2 = _nd2.toISOString().slice(0,10).replace(/-/g,'');
          sportByteam.nbaGameOdds = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_ns2}`, {
            headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
          }).then(r => r.ok ? r.json() : {}).then(d => parseGameOdds(d.events || [])).catch(() => ({}));
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
          for (const key of uniquePlayerKeys) {
            const cached = await CACHE2.get(`pinfo:${key}`, "json");
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
        for (let i = 0; i < Math.min(keysNeedingInfo.length, MAX_PINFO_FETCHES); i++) {
          const key = keysNeedingInfo[i];
          const [sport, ...nameParts] = key.split("|");
          const playerName = nameParts.join("|");
          try {
            const r = await fetch(
              `${ESPN_BASE}/search/v2?query=${encodeURIComponent(playerName)}&lang=en&region=us&limit=5&type=player`,
              { headers: ESPN_SEARCH_HEADERS }
            );
            if (!r.ok) {
              pInfoErrors.push({ key, reason: `http_${r.status}` });
              if (i < keysNeedingInfo.length - 1) await new Promise((res) => setTimeout(res, 200));
              continue;
            }
            const d = await r.json();
            const allContents = d.results?.find((x) => x.type === "player")?.contents || [];
            const players = allContents.filter((p2) => p2.defaultLeagueSlug === sport);
            if (!players.length) {
              pInfoErrors.push({ key, reason: "no_league_match", sport, found: allContents.map((c) => c.defaultLeagueSlug) });
              if (i < keysNeedingInfo.length - 1) await new Promise((res) => setTimeout(res, 150));
              continue;
            }
            const p = players[0];
            const id = p.uid?.split("~a:")?.[1];
            if (!id) {
              pInfoErrors.push({ key, reason: "no_id", uid: p.uid });
              continue;
            }
            const posMatch = (p.description || p.subtitle || "").match(/\b(QB|RB|WR|TE|K|P|PG|SG|SF|PF|Center|Forward|Guard|C|G|F|SP|RP|OF|1B|2B|3B|SS|LW|RW|D)\b/i);
            const rawPos = posMatch ? posMatch[1].toUpperCase() : null;
            const POS_NORMALIZE = { CENTER: "C", GUARD: null, FORWARD: null };
            const info = { id, teamAbbr: "", position: rawPos ? rawPos in POS_NORMALIZE ? POS_NORMALIZE[rawPos] : rawPos === "G" || rawPos === "F" ? null : rawPos : null };
            playerInfoMap[key] = info;
            if (CACHE2) await CACHE2.put(`pinfo:${key}`, JSON.stringify(info), { expirationTtl: 604800 });
            if (i < keysNeedingInfo.length - 1) await new Promise((res) => setTimeout(res, 150));
          } catch (e) {
            pInfoErrors.push({ key, reason: "exception", error: String(e) });
            if (i < keysNeedingInfo.length - 1) await new Promise((res) => setTimeout(res, 200));
          }
        }
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
        if (CACHE2) {
          for (const key of keysForGamelog) {
            const cached = await CACHE2.get(glCacheKey(key), "json");
            if (cached) playerGamelogs[key] = key.startsWith("mlb|") ? _normGlOpp(cached) : cached;
            else keysNeedingGamelog.push(key);
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
            const r = await fetch(url2, { headers: ESPN_HEADERS });
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
        async function fetchGamelog(key, overrideId = null) {
          const [sport] = key.split("|");
          const info = playerInfoMap[key];
          const athleteId = overrideId || info?.id;
          if (!athleteId) return;
          if (sport === "mlb") {
            const baseUrl = `https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${athleteId}/gamelog`;
            const key24 = `gl:mlb2024|${key}`;
            const key25 = `gl:mlb2025|${key}`;
            const key26 = `gl:mlb2026|${key}`;
            let gl24 = CACHE2 ? await CACHE2.get(key24, "json").catch(() => null) : null;
            let gl25 = CACHE2 ? await CACHE2.get(key25, "json").catch(() => null) : null;
            const fetchSeasons = [2026];
            if (!gl25) fetchSeasons.push(2025);
            if (!gl24) fetchSeasons.push(2024);
            const results = await Promise.all(fetchSeasons.map((yr) => parseEspnGamelog(`${baseUrl}?season=${yr}`, key)));
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
              if (CACHE2) await CACHE2.put(glCacheKey(key), JSON.stringify({ ul, events }), { expirationTtl: 21600 });
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
        // Fetch gamelogs in batches of 5 in parallel; 200ms between batches to avoid ESPN rate-limiting
        const GL_BATCH = 5;
        for (let i = 0; i < keysNeedingGamelog.length; i += GL_BATCH) {
          const batch = keysNeedingGamelog.slice(i, i + GL_BATCH);
          await Promise.all(batch.map((k) => fetchGamelog(k)));
          if (i + GL_BATCH < keysNeedingGamelog.length) await new Promise((r) => setTimeout(r, 200));
        }
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
            const cached = CACHE2 ? await CACHE2.get(glCacheKey(pitcherKey), "json").catch(() => null) : null;
            if (cached) pitcherGamelogs[teamAbbr] = { name, gl: _normGlOpp(cached) };
          }));
          const uncachedPitchers = pitcherEntriesToLoad.filter(([teamAbbr]) => !pitcherGamelogs[teamAbbr]);
          for (let i = 0; i < uncachedPitchers.length; i += GL_BATCH) {
            const batch = uncachedPitchers.slice(i, i + GL_BATCH);
            await Promise.all(batch.map(async ([teamAbbr, { name, id }]) => {
              const pitcherKey = `mlb|${name}`;
              await fetchGamelog(pitcherKey, id);
              const gl = playerGamelogs[pitcherKey] || null;
              if (gl) pitcherGamelogs[teamAbbr] = { name, gl };
            }));
            if (i + GL_BATCH < uncachedPitchers.length) await new Promise((r) => setTimeout(r, 200));
          }
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
            _nbaPlayerIds.length > 0 ? buildNbaUsageRate(_nbaPlayerIds) : Promise.resolve({}),
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
          let simScore = null, kpctMeets = null, kpctPts = null, kbbMeets = null, kbbPts = null, lkpMeets = null, lkpPts = null, pitchesPts = null, parkMeets = null, mlPts = null, totalPts = null, kTrendPts = null;
          let _recentKPct = null, _seasonKPct = null;
          let _pitcherHand = null;
          let _avgP = null; // hoisted so all strikeout output sites can use it
          let _umpireName = null;   // E3a: home plate umpire
          let _umpireKFactor = 1.0; // factor relative to league avg (>1 = high-K zone)
          let _expectedBF = 24;     // E3b: expected batters faced from avg pitch count
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
            // E3b: Expected BF from avg pitch count (3.85 pitches/PA league avg), clamped [15, 27]
            _expectedBF = _avgP != null ? Math.min(27, Math.max(15, Math.round(_avgP / 3.85))) : 24;
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
            // CSW%/K% tiered scoring: >30% CSW or >27% K → 3pts (green); 26-30% CSW or 24-27% K → 2pts (yellow); below → 1pt; null → 1pt (abstain)
            if (_useCsw) {
              kpctPts = _csw > 30 ? 3 : _csw > 26 ? 2 : 1;
            } else if (_pkp != null) {
              kpctPts = _pkp > 27 ? 3 : _pkp > 24 ? 2 : 1;
            } else {
              kpctPts = 1;
            }
            kpctMeets = kpctPts > 0;
            // kbbPts tiered: >18% → 2pts (green), >12% → 1pt (yellow), ≤12% → 0pts (red); null → 1pt (abstain)
            kbbPts = _kbb == null ? 1 : _kbb > 18 ? 2 : _kbb > 12 ? 1 : 0;
            kbbMeets = kbbPts > 0;
            // lkpPts tiered: > 24% → 3pts (green, high K lineup), > 20% → 1pt (yellow), ≤ 20% → 0pts; null → 1pt (abstain)
            lkpPts = _lkp == null ? 1 : _lkp > 24 ? 3 : _lkp > 20 ? 1 : 0;
            lkpMeets = lkpPts > 0;
            // pitchesPts tiered: >85 → 2pts (green), >75 → 1pt (yellow), ≤75 → 0pts; null → 1pt (abstain)
            pitchesPts = _avgP == null ? 1 : _avgP > 85 ? 2 : _avgP > 75 ? 1 : 0;
            parkMeets = _parkKF > 1.0;
            // ML 3-tier: ≤ -121 → 2pts, -120 to +120 → 1pt, > +120 → 0pts; null → 1pt
            // mlPts kept for market report ML column coloring — no longer contributes to simScore
            const _teamML = sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null;
            mlPts = _teamML == null ? 1 : _teamML <= -121 ? 2 : _teamML <= 120 ? 1 : 0;
            // O/U total 3-tier (low total = pitcher-friendly): ≤7.5 → 2pts, ≤8.5 → 1pt, >8.5 → 0pts; null → 1pt
            const _gameTotal = sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null;
            totalPts = _gameTotal == null ? 1 : _gameTotal <= 7.5 ? 2 : _gameTotal <= 10.5 ? 1 : 0;
            // K-trend: recent K% vs season K% — pitchers trending up score higher.
            // Requires A1 recentKPct (last 5 starts, 3+ starts, 30+ BF); null → 1pt abstain.
            // ≥ 1.10 (trending up ≥10%) → 2pts; ≥ 0.90 (stable) → 1pt; < 0.90 (trending down) → 0pts
            const _kTrendRatio = (_recentKPct != null && _seasonKPct != null && _seasonKPct > 0)
              ? _recentKPct / _seasonKPct : null;
            kTrendPts = _kTrendRatio == null ? 1 : _kTrendRatio >= 1.10 ? 2 : _kTrendRatio >= 0.90 ? 1 : 0;
            // Weighted sim-score (max 14): CSW%/K%→0-3, K-BB%→0-2, lineup K%→0-3, avg pitches→0-2, K-trend→0-2, O/U tier→0-2
            simScore = kpctPts
                     + kbbPts
                     + lkpPts
                     + pitchesPts
                     + kTrendPts
                     + totalPts;
          }
          let softVals, softLabel, softUnit;
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
            if (_pitcherDates && _pitcherDates.size > 0) {
              // Pitcher-specific: games where batter's team hosted this pitcher (date + oppAbbr guard prevents
              // false matches when pitcher faced the same team on a day the batter played elsewhere)
              softVals = gl.events.filter((ev) => _pitcherDates.has(ev.date) && ev.oppAbbr === tonightOpp).map(getStat).filter((v) => !isNaN(v));
            } else {
              // Team-level fallback: recent seasons only (2025+2026) to avoid inflating % from a long career at low threshold
              softVals = gl.events.filter((ev) => (ev.season === 2025 || ev.season === 2026) && ev.oppAbbr === tonightOpp).map(getStat).filter((v) => !isNaN(v));
            }
            softLabel = pitcherName ? `vs ${pitcherName}` : `vs ${tonightOpp}`;
            softUnit = "%";
          } else {
            const effectiveSoftSet = sport === "nba" ? nbaEffectiveSoftTeams || softTeams : softTeams;
            softVals = gl.events.filter((ev) => effectiveSoftSet.has(ev.oppAbbr)).map(getStat).filter((v) => !isNaN(v));
            softLabel = null;
            softUnit = null;
          }
          const MIN_H2H = 5;
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
                  const _nSim = simScore !== null && simScore >= 12 ? 10000 : 5000;
                  const _pitcherKPctAdj = Math.min(40, pitcherKPctOut * _umpireKFactor);
                  pitcherKDistCache[_distKey] = simulateKsDist(orderedKPcts, _pitcherKPctAdj, parkFactorOut, _nSim, _expectedBF);
                }
                simPctOut = kDistPct(pitcherKDistCache[_distKey], threshold);
              } else {
                log5PctOut = parseFloat(log5HitRate(adjustedLog5, threshold).toFixed(1));
              }
            }
          }
          // simScore gate moved here so simPctOut is available for qualified:false push
          if (sport === "mlb" && stat === "strikeouts" && simScore < 7) {
            const _kTruePct = parseFloat((simPctOut ?? (softPct !== null ? (primaryPct + softPct) / 2 : primaryPct)).toFixed(1));
            const _dropLowConf = {
              ..._dropBase,
              reason: "low_confidence",
              simScore,
              opponent: tonightOpp,
              kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, lkpPts, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts,
              seasonPct: parseFloat(primaryPct.toFixed(1)), softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: _kTruePct, edge: parseFloat((_kTruePct - kalshiPct - (kalshiSpread != null ? kalshiSpread / 2 : 0)).toFixed(1)),
              pitcherCSWPct: _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct"),
              pitcherKPct: pitcherKPctOut,
              pitcherKBBPct: pitcherKBBPctOut,
              pitcherRecentKPct: _recentKPct, pitcherSeasonKPct: _seasonKPct,
              pitcherAvgPitches: _avgP,
              lineupKPct: lineupKPctOut,
              pitcherEra: _pitcherEraFromGl ?? _pt(sportByteam.mlb?.pitcherEra, "era") ?? null,
              pitcherHand: _pitcherHand ?? null,
              simPct: simPctOut,
              parkFactor: parkFactorOut ?? 1,
              gameMoneyline: sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null,
              gameTotal: sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null,
            };
            if (isDebug) dropped.push(_dropLowConf);
            plays.push({
              ..._dropLowConf,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: _kTruePct,
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj: kalshiSpread != null ? parseFloat((kalshiSpread / 2).toFixed(1)) : 0,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: !(sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp),
              playerStatus: null,
            });
            continue;
          }
          // Hard quality gate: pitcher must have CSW%/K% >= 2pts (26%+ CSW or 24%+ K%).
          // Eliminates red-tier pitchers regardless of other factors; must be a legitimate strikeout threat.
          if (sport === "mlb" && stat === "strikeouts" && kpctPts < 2) {
            const _kTruePct = parseFloat((simPctOut ?? (softPct !== null ? (primaryPct + softPct) / 2 : primaryPct)).toFixed(1));
            const _dropKQ = {
              ..._dropBase,
              reason: "low_pitcher_quality",
              simScore, opponent: tonightOpp,
              kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, lkpPts, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts,
              seasonPct: parseFloat(primaryPct.toFixed(1)), softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: _kTruePct, edge: parseFloat((_kTruePct - kalshiPct).toFixed(1)),
              pitcherCSWPct: _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct"),
              pitcherKPct: pitcherKPctOut, pitcherKBBPct: pitcherKBBPctOut, pitcherRecentKPct: _recentKPct, pitcherSeasonKPct: _seasonKPct,
              pitcherAvgPitches: _avgP, lineupKPct: lineupKPctOut,
              pitcherHand: _pitcherHand ?? null, simPct: simPctOut,
              parkFactor: parkFactorOut ?? 1,
              gameMoneyline: sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null,
              gameTotal: sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null,
            };
            if (isDebug) dropped.push(_dropKQ);
            plays.push({
              ..._dropKQ,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: _kTruePct,
              log5Pct: simPctOut ?? log5PctOut, simPct: simPctOut,
              spreadAdj: kalshiSpread != null ? parseFloat((kalshiSpread / 2).toFixed(1)) : 0,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: !(sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp),
              playerStatus: null,
            });
            continue;
          }
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
            hitterWhipPts = pitcherWHIP == null ? 0 : pitcherWHIP > 1.35 ? 3 : pitcherWHIP > 1.20 ? 1 : 0;
            hitterFipMeets = (pitcherFIP != null && _hlEra != null) ? pitcherFIP > _hlEra : null;
            hitterParkMeets = _hlParkKF2 > 1.0;
            hitterParkKF = _hlParkKF2;
            hitterMoneyline = hitterML;
            const _spotPts = hitterLineupSpot != null ? (hitterLineupSpot <= 3 ? 3 : hitterLineupSpot <= 4 ? 2 : 0) : null;
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
            // Platoon advantage: batter hits better vs this hand (or: batter is opposite hand to pitcher)
            // Simplified: if batter has a valid split BA vs this pitcher's hand, compare vs season BA
            // and award pts for platoon edge. No hand data → abstain (1pt).
            hitterPlatoonPts = 1; // abstain (null data)
            if (_splitBA != null && hitterBa != null) {
              // Platoon advantage when batter's split BA ≥ 10% better than season (e.g. LHB vs RHP)
              const _platoonRatio = _splitBA / hitterBa;
              hitterPlatoonPts = _platoonRatio >= 1.10 ? 2 : _platoonRatio >= 0.95 ? 1 : 0;
            }
            // B2: Batter recent form — last 10 2026 games rolling BA.
            // Blend 0.6 recent + 0.4 season if 20+ AB in recent window; else use season BA alone.
            let hitterEffectiveBA = hitterBa;
            if (abIdxH !== -1 && hIdx2 !== -1) {
              const _evs26_recent = hasSeasonTags ? gl.events.filter(ev => ev.season === 2026).slice(0, 10) : gl.events.slice(0, 10);
              const _recentAB = _evs26_recent.reduce((s, ev) => s + (parseFloat(ev.stats[abIdxH]) || 0), 0);
              const _recentH  = _evs26_recent.reduce((s, ev) => s + (parseFloat(ev.stats[hIdx2]) || 0), 0);
              if (_recentAB >= 20 && hitterBa != null) {
                const _recentBA = _recentH / _recentAB;
                hitterEffectiveBA = parseFloat((_recentBA * 0.6 + hitterBa * 0.4).toFixed(3));
              }
            }
            // Barrel% tier: ≥14%→3pts, ≥10%→2pts, ≥7%→1pt, <7%→0pts, null→1pt (abstain)
            hitterBarrelPts = hitterBarrelPct == null ? 1 : hitterBarrelPct >= 14 ? 3 : hitterBarrelPct >= 10 ? 2 : hitterBarrelPct >= 7 ? 1 : 0;
            // O/U total tier (high total = more run-scoring): ≥9.5→2pts, ≥7.5→1pt, <7.5→0pts, null→1pt
            hitterGameTotal = sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null;
            hitterTotalPts = hitterGameTotal == null ? 1 : hitterGameTotal >= 9.5 ? 2 : hitterGameTotal >= 7.5 ? 1 : 0;
            // Sim-score (max 14, edge gates separately): spot→3/2, WHIP→3/1/0, platoon→0-2, park→1, barrel%→0-3, O/U→0-2
            hitterSimScore = (_spotPts ?? 0)
              + (hitterWhipPts ?? 0)
              + hitterPlatoonPts
              + (hitterParkMeets ? 1 : 0)
              + hitterBarrelPts
              + hitterTotalPts;
            const _hlPitcherName = sportByteam.mlb?.probables?.[tonightOpp]?.name ?? null;
            const _hlML = hitterML;
            const _hlCommon = { opponent: tonightOpp, pitcherName: _hlPitcherName, seasonPct: _hlSeasonPct, softPct: _hlSoftPct, truePct: _hlTruePct, edge: _hlEdge, pitcherEra: _hlEra, moneyline: _hlML, hitterBa, hitterBaTier, abVsTeam: hitterAbVsPitcher, hitterLineupSpot, pitcherWHIP, pitcherFIP, hitterSimScore, hitterParkKF, hitterMoneyline, hitterBarrelPct, hitterBarrelPts, hitterTotalPts, hitterGameTotal, hitterPlatoonPts, oppPitcherHand: _oppPitcherHand, hitterSplitBA: _splitBA, hitterWhipPts };
            // Stage 1: lineup spot 5-9 discard
            if (hitterLineupSpot !== null && hitterLineupSpot >= 5) {
              if (isDebug) dropped.push({ ..._dropBase, reason: "low_lineup_spot", hitterLineupSpot, ..._hlCommon });
              continue;
            }
            // Stage 2: sim-score gate
            if (hitterSimScore < 7) {
              if (isDebug) dropped.push({ ..._dropBase, reason: "low_confidence", hitterSimScore, ..._hlCommon });
              continue;
            }
            // Monte Carlo simulation for hits stat when effectiveBA and pitcherBAA available (B2 feeds this)
            if (stat === "hits" && hitterEffectiveBA != null && pitcherBAA != null) {
              const _nSimH = hitterSimScore >= 11 ? 10000 : 1000;
              hitterSimPctOut = simulateHits(hitterEffectiveBA, pitcherBAA, _hlParkKF2, threshold, _nSimH);
            }
          }
          // NBA: pre-edge SimScore + Monte Carlo simulation (runs before rawTruePct)
          let nbaSimPctOut = null, nbaPreSimScore = null, nbaPaceAdj = null, nbaOpportunity = null, nbaTotalPts = null, nbaGameTotal = null;
          let nbaBlowoutAdj = null, nbaSplitAdj = null, nbaMiscAdj = 1.0, nba3pMPG = null;
          if (sport === "nba") {
            let _sc = 0;
            // 1. Pace — avg game pace above league avg → 3pts
            if (nbaPaceData) {
              const _tp = nbaPaceData.teamPace?.[playerTeam] ?? null;
              const _op = nbaPaceData.teamPace?.[tonightOpp] ?? null;
              if (_tp !== null && _op !== null) {
                nbaPaceAdj = parseFloat(((_tp + _op) / 2 - (nbaPaceData.leagueAvgPace ?? 100)).toFixed(1));
                if (nbaPaceAdj > 0) _sc += 3;
                else if (nbaPaceAdj > -2) _sc += 2;
                else _sc += 1;
              }
            }
            // 2. C1: USG% — replaces avgMin for SimScore. nbaOpportunity still uses avgMin for display.
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
            // C1: stat-appropriate opportunity signal (max 4pts)
            // points: USG% ≥28→4, ≥22→2, else 0, null→2 abstain
            // threePointers: 3PM/game ≥3→4, ≥2→2, else 0, null→2 abstain
            // assists: APG ≥7→4, ≥5→2, else 0, null→2 abstain
            // rebounds: RPG ≥9→4, ≥7→2, else 0, null→2 abstain
            if (stat === "assists") {
              _sc += _avgAst == null ? 2 : _avgAst >= 7 ? 4 : _avgAst >= 5 ? 2 : 0;
            } else if (stat === "rebounds") {
              _sc += _avgReb == null ? 2 : _avgReb >= 9 ? 4 : _avgReb >= 7 ? 2 : 0;
            } else if (stat === "threePointers") {
              const _3pIdx = gl.ul.indexOf("3P");
              if (_3pIdx !== -1) {
                const _3pVals = gl.events.slice(0, 10).map(ev => parseFloat(ev.stats[_3pIdx])).filter(v => !isNaN(v) && v >= 0);
                if (_3pVals.length >= 3) nba3pMPG = parseFloat((_3pVals.reduce((a, b) => a + b, 0) / _3pVals.length).toFixed(2));
              }
              _sc += nba3pMPG == null ? 2 : nba3pMPG >= 3 ? 4 : nba3pMPG >= 2 ? 2 : 0;
            } else {
              _sc += _usg == null ? 2 : _usg >= 28 ? 4 : _usg >= 22 ? 2 : 0;
            }
            // 3. DVP — position-adjusted ratio tiers: ≥1.05→2pts (soft), ≥1.02→1pt (borderline), else→0pts
            const _dvpPts = oppDvpRatioOut == null ? 0 : oppDvpRatioOut >= 1.05 ? 2 : oppDvpRatioOut >= 1.02 ? 1 : 0;
            _sc += _dvpPts;
            // 4. Rest — not B2B → 2pts
            if (!isB2B) _sc += 2;
            // 5. Game total — high total = more possessions/scoring = favorable for counting stats
            // ≥235→3pts, ≥225→2pts, else→1pt (low total still scores 1 — not a disqualifier), null→1pt (abstain)
            nbaGameTotal = (sportByteam.nbaGameOdds ?? {})[playerTeam]?.total ?? null;
            nbaTotalPts = nbaGameTotal == null ? 1 : nbaGameTotal >= 235 ? 3 : nbaGameTotal >= 225 ? 2 : 1;
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
          if (sport === "nhl") {
            let _sc = 0;
            // 1. Shots against — tiered: rank ≤10 → 3pts, above avg but rank >10 → 1pt, else 0
            if (nhlLeagueAvgSa !== null && nhlSaRankMap[tonightOpp]?.value != null) {
              nhlShotsAdj = parseFloat((nhlSaRankMap[tonightOpp].value - nhlLeagueAvgSa).toFixed(1));
              nhlSaRank = nhlSaRankMap[tonightOpp]?.rank ?? null;
              if (nhlSaRank != null && nhlSaRank <= 10) _sc += 3;
              else if (nhlShotsAdj > 0) _sc += 1;
            }
            // 2. Ice time (TOI) — avg ≥18 min → 4pts, ≥15 min → 2pts
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
                if (nhlOpportunity >= 18) _sc += 4;
                else if (nhlOpportunity >= 15) _sc += 2;
              }
            }
            // 3. Opponent GAA rank ≤ 10 → 2pts
            const _gaaRank = rankMap[tonightOpp]?.rank ?? null;
            if (_gaaRank !== null && _gaaRank <= 10) _sc += 2;
            // 4. Not B2B → 2pts
            if (!isB2B) _sc += 2;
            // 5. Player team GPG — ≥3.5→3pts, ≥3.0→2pts, ≥2.5→1pt, null→1pt (abstain)
            const _teamGPG = nhlGPGMap[playerTeam] ?? null;
            nhlTeamGPG = _teamGPG;
            _sc += _teamGPG == null ? 1 : _teamGPG >= 3.5 ? 3 : _teamGPG >= 3.0 ? 2 : _teamGPG >= 2.5 ? 1 : 0;
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
              return Math.min(99, rawMlbPct * parkFactor);
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
                kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts,
              } : {}),
              ...(sport === "mlb" && stat !== "strikeouts" ? {
                hitterSimScore, hitterFinalSimScore,
                hitterLineupSpot, pitcherWHIP, pitcherFIP, hitterParkKF, hitterMoneyline, hitterBarrelPct,
                hitterBarrelPts, hitterTotalPts, hitterGameTotal, hitterPlatoonPts,
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
                posDvpValue: posDvpValueOut,
                nbaUsage: nbaUsageMap[String(info.id)]?.usg ?? null,
                nbaAvgAst: nbaUsageMap[String(info.id)]?.avgAst ?? null,
                nbaAvgReb: nbaUsageMap[String(info.id)]?.avgReb ?? null,
              } : {}),
              ...(sport === "nhl" ? { nhlSimScore, nhlPreSimScore, nhlSimPct: nhlSimPctOut, nhlShotsAdj, nhlOpportunity, nhlTeamGPG, nhlSaRank, isB2B } : {}),
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
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
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
              kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, lkpPts, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts,
              seasonPct: parseFloat(primaryPct.toFixed(1)), softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: _kTruePct, edge: parseFloat((_kTruePct - kalshiPct).toFixed(1)),
              pitcherKPct: pitcherKPctOut, pitcherAvgPitches: _avgP,
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
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: !(sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp),
              playerStatus: null,
            });
            continue;
          }
          // Strikeout finalSimScore gate: must reach >= 12 (Alpha tier) to qualify as a play.
          // Scores 7-11 show in report but marked qualified:false so player card still shows truePct.
          if (sport === "mlb" && stat === "strikeouts" && finalSimScore !== null && finalSimScore < 12) {
            const _dropLowScore = {
              ..._dropBase,
              reason: "low_confidence",
              simScore, finalSimScore,
              opponent: tonightOpp,
              kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, lkpPts, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts,
              seasonPct: parseFloat(primaryPct.toFixed(1)), softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              pitcherCSWPct: _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct"),
              pitcherKPct: pitcherKPctOut, pitcherKBBPct: pitcherKBBPctOut, pitcherRecentKPct: _recentKPct, pitcherSeasonKPct: _seasonKPct,
              pitcherAvgPitches: _avgP,
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
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: !(sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp),
              playerStatus: null,
            });
            continue;
          }
          // NBA SimScore gate: must reach >= 11 (Alpha tier) to qualify as a play
          if (sport === "nba" && nbaSimScore !== null && nbaSimScore < 11) {
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
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              playerStatus: null,
            });
            continue;
          }
          // NHL SimScore gate: must reach >= 11 (Alpha tier) to qualify as a play
          if (sport === "nhl" && nhlSimScore !== null && nhlSimScore < 11) {
            const _nhlLowScoreDrop = {
              ..._dropBase,
              reason: "low_confidence",
              nhlSimScore, nhlPreSimScore,
              opponent: tonightOpp,
              seasonPct: parseFloat(primaryPct.toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              nhlSimPct: nhlSimPctOut, nhlShotsAdj, nhlOpportunity, nhlTeamGPG, nhlSaRank, isB2B,
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
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              playerStatus: null,
            });
            continue;
          }
          // HRR SimScore gate: must reach >= 11 (Alpha tier) to qualify as a play
          if (sport === "mlb" && stat !== "strikeouts" && hitterFinalSimScore !== null && hitterFinalSimScore < 11) {
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
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
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
            pitcherGS26: sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherGS26, "gs26") : void 0,
            pitcherHasAnchor: sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherHasAnchor, "hasAnchor") : void 0,
            hitterSimScore: sport === "mlb" && stat !== "strikeouts" ? hitterSimScore : void 0,
            hitterFinalSimScore: sport === "mlb" && stat !== "strikeouts" ? hitterFinalSimScore : void 0,
            hitterLineupSpot: sport === "mlb" && stat !== "strikeouts" ? hitterLineupSpot : void 0,
            hitterWhipMeets: sport === "mlb" && stat !== "strikeouts" ? hitterWhipMeets : void 0,
            hitterWhipPts: sport === "mlb" && stat !== "strikeouts" ? hitterWhipPts : void 0,
            hitterFipMeets: sport === "mlb" && stat !== "strikeouts" ? hitterFipMeets : void 0,
            hitterPlatoonPts: sport === "mlb" && stat !== "strikeouts" ? hitterPlatoonPts : void 0,
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
            gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
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
        // ── Polymarket price comparison + Poly-only market injection ─────────────────────────────
        // Fetched independently of Kalshi so Poly-only thresholds also enter the play loop.
        let polyPctMap = {};
        {
          const _polyKey = `poly:totals:${todayDateStr}`;
          const _cachedPoly = CACHE2 && !isBustCache ? await CACHE2.get(_polyKey, "json").catch(() => null) : null;
          if (_cachedPoly) {
            polyPctMap = _cachedPoly;
          } else {
            const _resolvePolyTeam = (name, sport) => {
              const map = POLY_NAME_TO_ABBR[sport] || {};
              for (const [key, abbr] of Object.entries(map)) {
                if (name.includes(key)) return abbr;
              }
              return null;
            };
            // Fetch all supported sports regardless of whether Kalshi has markets for them
            await Promise.all(Object.keys(POLY_SERIES).map(async _ps => {
              try {
                const _evResp = await fetch(
                  `https://gamma-api.polymarket.com/events?closed=false&series_id=${POLY_SERIES[_ps]}&limit=50`,
                  { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
                );
                if (!_evResp.ok) return;
                const _events = await _evResp.json();
                for (const _ev of _events) {
                  const _vsParts = (_ev.title || "").split(/ vs\.? /);
                  if (_vsParts.length < 2) continue;
                  const _awayAbbr = _resolvePolyTeam(_vsParts[0].trim(), _ps);
                  const _homeAbbr = _resolvePolyTeam(_vsParts[1].trim(), _ps);
                  if (!_awayAbbr || !_homeAbbr) continue;
                  for (const _pm of (_ev.markets || [])) {
                    const _pq = _pm.question || "";
                    if (!_pq.includes("O/U") || _pq.includes("1H") || _pq.includes("2H")) continue;
                    const _ouM = _pq.match(/O\/U\s+([\d.]+)/);
                    if (!_ouM) continue;
                    const _ouLine = parseFloat(_ouM[1]);
                    const _thresh = Math.round(_ouLine + 0.5);
                    const _outs = Array.isArray(_pm.outcomes) ? _pm.outcomes : JSON.parse(_pm.outcomes || "[]");
                    const _pxs = Array.isArray(_pm.outcomePrices) ? _pm.outcomePrices : JSON.parse(_pm.outcomePrices || "[]");
                    const _oIdx = _outs.findIndex(o => /^over\b/i.test(String(o).trim()));
                    if (_oIdx === -1 || !_pxs[_oIdx]) continue;
                    const _op = parseFloat(_pxs[_oIdx]);
                    if (_op < 0.02 || _op > 0.98) continue; // finalized
                    const polyPct = Math.round(_op * 100);
                    const polyVol = Math.round(parseFloat(_pm.volume || _pm.liquidity || 0));
                    polyPctMap[`${_ps}|${_homeAbbr}|${_awayAbbr}|${_thresh}`] = { polyPct, polyVol };
                    polyPctMap[`${_ps}|${_awayAbbr}|${_homeAbbr}|${_thresh}`] = { polyPct, polyVol };
                  }
                }
              } catch (_) {}
            }));
            if (Object.keys(polyPctMap).length > 0 && CACHE2) {
              await CACHE2.put(_polyKey, JSON.stringify(polyPctMap), { expirationTtl: 300 }).catch(() => {});
            }
          }
          // Inject Poly-only thresholds — those Poly carries that Kalshi doesn't
          const _kalshiKeySet = new Set();
          for (const tm of totalMarkets) {
            _kalshiKeySet.add(`${tm.sport}|${tm.gameTeam1}|${tm.gameTeam2}|${tm.threshold}`);
            _kalshiKeySet.add(`${tm.sport}|${tm.gameTeam2}|${tm.gameTeam1}|${tm.threshold}`);
          }
          const _polyStatMap = { mlb: "totalRuns", nba: "totalPoints", nhl: "totalGoals" };
          const _polyColMap = { mlb: "R", nba: "PTS", nhl: "G" };
          const _polySeenCanon = new Set();
          for (const [key, { polyPct, polyVol }] of Object.entries(polyPctMap)) {
            if (_kalshiKeySet.has(key)) continue;
            const parts = key.split("|");
            if (parts.length !== 4) continue;
            const [sport, t1, t2, threshStr] = parts;
            const threshold = parseInt(threshStr, 10);
            if (!_polyStatMap[sport] || polyPct < 70 || polyPct > 97) continue;
            const _canon = `${sport}|${[t1, t2].sort().join("|")}|${threshold}`;
            if (_polySeenCanon.has(_canon)) continue;
            _polySeenCanon.add(_canon);
            totalMarkets.push({
              gameType: "total", sport, stat: _polyStatMap[sport], col: _polyColMap[sport],
              threshold, kalshiPct: null, americanOdds: null, kalshiVolume: null,
              gameTeam1: t1, gameTeam2: t2, gameDate: todayDateStr,
              kalshiSpread: null, _ticker: null, _yesAsk: null, _yesBid: null, polyOnly: true
            });
          }
        }
        // ── Poly derived prices (Poisson for MLB/NHL, Normal for NBA) ────────────────────────────
        // Fit λ from P(X ≥ n) = p
        const _fitPoisson = (n, p) => {
          let lo = 0.1, hi = 60;
          for (let i = 0; i < 80; i++) {
            const mid = (lo + hi) / 2;
            let cdf = 0, term = Math.exp(-mid);
            for (let k = 0; k < n; k++) { cdf += term; term *= mid / (k + 1); }
            if (1 - cdf > p) hi = mid; else lo = mid;
          }
          return (lo + hi) / 2;
        };
        const _poissonGe = (lam, n) => {
          let cdf = 0, term = Math.exp(-lam);
          for (let k = 0; k < n; k++) { cdf += term; term *= lam / (k + 1); }
          return 1 - cdf;
        };
        // Abramowitz & Stegun normal CDF, error < 7.5e-8
        const _normalCdf = z => {
          const t = 1 / (1 + 0.2316419 * Math.abs(z));
          const d = 0.3989423 * Math.exp(-0.5 * z * z);
          const poly = t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
          return z >= 0 ? 1 - d * poly : d * poly;
        };
        const _NBA_TOTAL_STD = Math.sqrt(2) * 11; // sqrt(σ_home² + σ_away²) where each team σ=11
        const polyDerivedMap = {};
        {
          // Find the anchor (real Poly entry closest to 50%) for each canonical game pair
          const _anchors = {};
          for (const [key, { polyPct }] of Object.entries(polyPctMap)) {
            const parts = key.split("|"); if (parts.length !== 4) continue;
            const [sp, t1, t2] = parts;
            const pairKey = `${sp}|${[t1, t2].sort().join("|")}`;
            if (!_anchors[pairKey] || Math.abs(polyPct - 50) < Math.abs(_anchors[pairKey].polyPct - 50))
              _anchors[pairKey] = { sp, t1, t2, threshold: parseInt(parts[3], 10), polyPct };
          }
          const _set = (sp, t1, t2, t, pDerived) => {
            const v = Math.round(pDerived * 100);
            if (v < 1 || v > 99) return;
            for (const k of [`${sp}|${t1}|${t2}|${t}`, `${sp}|${t2}|${t1}|${t}`])
              if (!polyPctMap[k]) polyDerivedMap[k] = { polyPct: v, polyDerived: true };
          };
          for (const { sp, t1, t2, threshold: at, polyPct: ap } of Object.values(_anchors)) {
            const p = ap / 100;
            if (sp === "mlb" || sp === "nhl") {
              const lam = _fitPoisson(at, p);
              const range = sp === "nhl" ? Array.from({length:11}, (_,i)=>i+2) : Array.from({length:12}, (_,i)=>i+3);
              for (const t of range) if (t !== at) _set(sp, t1, t2, t, _poissonGe(lam, t));
            } else if (sp === "nba") {
              // P(X >= at) = p → fit Normal mean; P(X >= t) for qualifying range
              const σ = _NBA_TOTAL_STD;
              let lo = 150, hi = 310;
              for (let i = 0; i < 80; i++) {
                const mid = (lo + hi) / 2;
                if (_normalCdf((mid - at) / σ) < p) lo = mid; else hi = mid;
              }
              const mu = (lo + hi) / 2;
              for (let t = 190; t <= 245; t++) if (t !== at) _set(sp, t1, t2, t, _normalCdf((mu - t) / σ));
            }
          }
        }
        // ── Game Total plays ─────────────────────────────────────────────────────────────────────
        const totalDistCache = {};
        const totalPlays = [];
        {
          const _MLB_ERA = 4.20;
          for (const tm of totalMarkets) {
            const { sport, stat, threshold, kalshiPct, americanOdds, gameTeam1, gameTeam2, gameDate, kalshiSpread, kalshiVolume } = tm;
            if (gameDate && gameDate < cutoffStr) continue;
            const spreadAdj = kalshiSpread != null ? parseFloat((kalshiSpread / 2).toFixed(1)) : 0;
            const lowVolume = kalshiVolume != null && kalshiVolume < 20;
            let truePct = null, homeTeam = gameTeam1, awayTeam = gameTeam2, totalSimScore = 0, _simData = {};
            if (sport === "mlb") {
              if (sportByteam.mlb?.gameHomeTeams?.[gameTeam2]) { homeTeam = gameTeam2; awayTeam = gameTeam1; }
              const homeRPG = mlbRPGMap[homeTeam] ?? null, awayRPG = mlbRPGMap[awayTeam] ?? null;
              const homeERA = sportByteam.mlb?.probables?.[homeTeam]?.era ?? null, awayERA = sportByteam.mlb?.probables?.[awayTeam]?.era ?? null;
              const parkRF = PARK_RUNFACTOR[homeTeam] ?? 1;
              const gameOuLine = sportByteam.mlb?.gameOdds?.[homeTeam]?.total ?? sportByteam.mlb?.gameOdds?.[awayTeam]?.total ?? null;
              const _mlbOuPts = gameOuLine == null ? 1 : gameOuLine >= 9.5 ? 2 : gameOuLine >= 7.5 ? 1 : 0;
              const _hLam = homeRPG != null ? parseFloat((Math.max(1, Math.min(12, homeRPG * (awayERA != null ? awayERA / _MLB_ERA : 1) * parkRF))).toFixed(1)) : null;
              const _aLam = awayRPG != null ? parseFloat((Math.max(1, Math.min(12, awayRPG * (homeERA != null ? homeERA / _MLB_ERA : 1) * parkRF))).toFixed(1)) : null;
              _simData = { homeRPG, awayRPG, homeERA, awayERA, parkFactor: parkRF, homeExpected: _hLam, awayExpected: _aLam, expectedTotal: (_hLam != null && _aLam != null) ? parseFloat((_hLam + _aLam).toFixed(1)) : null, gameOuLine, mlbOuPts: _mlbOuPts };
              if (_hLam != null && _aLam != null) {
                const _dk = `mlb|${homeTeam}|${awayTeam}`;
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateMLBTotalDist(_hLam, _aLam, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
              }
              if (homeERA != null) totalSimScore += homeERA > 4.5 ? 3 : homeERA > 3.5 ? 2 : 1;
              if (awayERA != null) totalSimScore += awayERA > 4.5 ? 3 : awayERA > 3.5 ? 2 : 1;
              if (homeRPG != null) totalSimScore += homeRPG > 5.0 ? 2 : homeRPG > 4.0 ? 1 : 0;
              if (awayRPG != null) totalSimScore += awayRPG > 5.0 ? 2 : awayRPG > 4.0 ? 1 : 0;
              if (parkRF > 1.01) totalSimScore += 2;
              totalSimScore += _mlbOuPts;
            } else if (sport === "nba") {
              const homeOff = nbaOffPPGMap[homeTeam] ?? null, awayOff = nbaOffPPGMap[awayTeam] ?? null;
              const nbaDefRank = STAT_SOFT["nba|points"]?.rankMap ?? {};
              const nbaAvgDef = leagueAvgCache["nba|points"] ?? nbaLeagueAvgOffPPG;
              const homeDef = nbaDefRank[homeTeam]?.value ?? null, awayDef = nbaDefRank[awayTeam]?.value ?? null;
              const _hp = nbaPaceData?.teamPace?.[homeTeam] ?? null, _ap = nbaPaceData?.teamPace?.[awayTeam] ?? null;
              const _homeExpRaw = homeOff != null ? homeOff * (awayDef != null && nbaAvgDef ? awayDef / nbaAvgDef : 1) : null;
              const _awayExpRaw = awayOff != null ? awayOff * (homeDef != null && nbaAvgDef ? homeDef / nbaAvgDef : 1) : null;
              _simData = { homeOff, awayOff, homeDef, awayDef, homePace: _hp, awayPace: _ap, leagueAvgPace: nbaPaceData?.leagueAvgPace ?? null, homeExpected: _homeExpRaw != null ? parseFloat(_homeExpRaw.toFixed(1)) : null, awayExpected: _awayExpRaw != null ? parseFloat(_awayExpRaw.toFixed(1)) : null, expectedTotal: (_homeExpRaw != null && _awayExpRaw != null) ? parseFloat((_homeExpRaw + _awayExpRaw).toFixed(1)) : null };
              if (_homeExpRaw != null && _awayExpRaw != null) {
                const _dk = `nba|${homeTeam}|${awayTeam}`;
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNBATotalDist(_homeExpRaw, _awayExpRaw, 11, 11, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
              }
              // Off PPG tiered: >=118→3pts (elite), >=113→2pts (above avg), exists→1pt; Def PPG allowed tiered: >=118→2pts (bad def), >=113→1pt, exists→0pts (solid def = fewer pts)
              if (homeOff != null) totalSimScore += homeOff >= 118 ? 3 : homeOff >= 113 ? 2 : 1;
              if (awayOff != null) totalSimScore += awayOff >= 118 ? 3 : awayOff >= 113 ? 2 : 1;
              if (homeDef != null) totalSimScore += homeDef >= 118 ? 2 : homeDef >= 113 ? 1 : 0;
              if (awayDef != null) totalSimScore += awayDef >= 118 ? 2 : awayDef >= 113 ? 1 : 0;
              if (_hp != null && _ap != null) { totalSimScore += 2; if ((_hp + _ap) / 2 > (nbaPaceData?.leagueAvgPace ?? 100)) totalSimScore += 2; }
            } else if (sport === "nhl") {
              const homeGPG = nhlGPGMap[homeTeam] ?? null, awayGPG = nhlGPGMap[awayTeam] ?? null;
              const homeGAA = nhlGAAMap[homeTeam] ?? null, awayGAA = nhlGAAMap[awayTeam] ?? null;
              const _hSA = nhlSaRankMap[homeTeam]?.value ?? null, _aSA = nhlSaRankMap[awayTeam]?.value ?? null;
              const _hGLRaw = homeGPG != null ? Math.max(0.5, Math.min(8, homeGPG * (awayGAA != null ? awayGAA / nhlLeagueAvgGAA : 1))) : null;
              const _aGLRaw = awayGPG != null ? Math.max(0.5, Math.min(8, awayGPG * (homeGAA != null ? homeGAA / nhlLeagueAvgGAA : 1))) : null;
              _simData = { homeGPG, awayGPG, homeGAA, awayGAA, homeSAKnown: _hSA != null, awaySAKnown: _aSA != null, homeExpected: _hGLRaw != null ? parseFloat(_hGLRaw.toFixed(2)) : null, awayExpected: _aGLRaw != null ? parseFloat(_aGLRaw.toFixed(2)) : null, expectedTotal: (_hGLRaw != null && _aGLRaw != null) ? parseFloat((_hGLRaw + _aGLRaw).toFixed(1)) : null };
              if (_hGLRaw != null && _aGLRaw != null) {
                const _dk = `nhl|${homeTeam}|${awayTeam}`;
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNHLTotalDist(_hGLRaw, _aGLRaw, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
              }
              // GPG tiered: ≥3.5→3pts, ≥3.0→2pts, <3.0→1pt, null→0pts (high scoring = good for over)
              totalSimScore += homeGPG != null ? (homeGPG >= 3.5 ? 3 : homeGPG >= 3.0 ? 2 : 1) : 0;
              totalSimScore += awayGPG != null ? (awayGPG >= 3.5 ? 3 : awayGPG >= 3.0 ? 2 : 1) : 0;
              // GAA tiered: ≥3.5→2pts, ≥3.0→1pt, <3.0→0pts, null→0pts (high GAA = bad defense = good for over)
              totalSimScore += homeGAA != null ? (homeGAA >= 3.5 ? 2 : homeGAA >= 3.0 ? 1 : 0) : 0;
              totalSimScore += awayGAA != null ? (awayGAA >= 3.5 ? 2 : awayGAA >= 3.0 ? 1 : 0) : 0;
              if (_hSA != null) totalSimScore += 2; if (_aSA != null) totalSimScore += 2;
            }
            const _polyKey = `${sport}|${homeTeam}|${awayTeam}|${threshold}`;
            const _polyEntry = polyPctMap[_polyKey] ?? polyDerivedMap[_polyKey] ?? null;
            const polyPct = _polyEntry?.polyPct ?? null;
            const polyVol = _polyEntry?.polyVol ?? null;
            const polyDerived = _polyEntry?.polyDerived ?? false;
            // Only real (non-derived) Poly prices affect bestVenue/bestEdge/edge gate
            const _realPolyPct = polyDerived ? null : polyPct;
            if (truePct == null) {
              if (isDebug) dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, totalSimScore, polyPct, polyVol, polyDerived, reason: "no_simulation_data", ..._simData });
              continue;
            }
            const rawEdge = kalshiPct != null ? parseFloat((truePct - kalshiPct).toFixed(1)) : null;
            const bestPct = kalshiPct != null && _realPolyPct != null ? Math.min(kalshiPct, _realPolyPct) : (_realPolyPct ?? kalshiPct);
            const bestVenue = kalshiPct == null ? "polymarket" : (_realPolyPct != null && _realPolyPct < kalshiPct ? "polymarket" : "kalshi");
            const bestEdge = parseFloat((truePct - bestPct).toFixed(1));
            const edge = rawEdge ?? bestEdge;
            const _displayAO = americanOdds ?? (polyPct != null ? (polyPct >= 50 ? Math.round(-(polyPct / (100 - polyPct)) * 100) : Math.round((100 - polyPct) / polyPct * 100)) : null);
            if (bestEdge < 5) {
              if (isDebug) dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, kalshiPct, americanOdds: _displayAO, truePct: parseFloat(truePct.toFixed(1)), rawEdge, spreadAdj: spreadAdj > 0 ? parseFloat(spreadAdj.toFixed(1)) : 0, edge, totalSimScore, polyPct, polyVol, polyDerived, bestVenue, bestEdge, polyOnly: tm.polyOnly ?? false, reason: "edge_too_low", ..._simData });
              continue;
            }
            totalPlays.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "over", kalshiPct, americanOdds: _displayAO, truePct: parseFloat(truePct.toFixed(1)), rawEdge, spreadAdj: spreadAdj > 0 ? parseFloat(spreadAdj.toFixed(1)) : 0, edge, totalSimScore, qualified: totalSimScore >= 11, kelly: kellyFraction(truePct, _displayAO), ev: evPerUnit(truePct, _displayAO), kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: gameTimes[`${sport}:${homeTeam}`] ?? gameTimes[`${sport}:${awayTeam}`] ?? null, polyPct, polyVol, polyDerived, bestVenue, bestEdge, polyOnly: tm.polyOnly ?? false, ..._simData });
          }
        }
        {
          const _totalBestMap = {};
          for (const tp of totalPlays) {
            const key = `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}`;
            if (!_totalBestMap[key] || tp.truePct > _totalBestMap[key].truePct) _totalBestMap[key] = tp;
          }
          const _bestTotalIds = new Set(Object.values(_totalBestMap).map(tp => `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}|${tp.threshold}`));
          for (const tp of totalPlays) {
            const isBest = _bestTotalIds.has(`${tp.sport}|${tp.homeTeam}|${tp.awayTeam}|${tp.threshold}`);
            plays.push(isBest ? tp : { ...tp, qualified: false });
          }
        }
        if (isDebug) {
          const nbaGlLabels = Object.fromEntries(Object.entries(playerGamelogs).filter(([k]) => k.startsWith("nba|")).map(([k, gl]) => [k, gl?.ul ?? null]));
          const nbaGlSample = Object.fromEntries(Object.entries(playerGamelogs).filter(([k]) => k.startsWith("nba|")).map(([k, gl]) => [k, gl?.events?.slice(0, 3).map(ev => ({ stats: ev.stats?.slice(0, 3), statsLen: ev.stats?.length })) ?? null]));
          return jsonResponse({ plays, dropped, preDropped, gamelogErrors, pInfoErrors, qualifyingCount: qualifyingMarkets.length, totalMarketsCount: totalMarkets.length, preFilteredCount: preFilteredMarkets.length, uniquePlayersSearched: uniquePlayerKeys.length, playersWithInfo: Object.keys(playerInfoMap).length, playersWithGamelog: Object.keys(playerGamelogs).length, lineupKPct: sportByteam.mlb?.lineupKPct ?? null, lineupKPctVR: sportByteam.mlb?.lineupKPctVR ?? null, pitcherKPctCache: sportByteam.mlb?.pitcherKPct ?? null, pitcherAvgPitchesCache: sportByteam.mlb?.pitcherAvgPitches ?? null, nbaGlLabels, nbaGlSample }, true);
        }
        const playsResult = { plays, nbaDropped, qualifyingCount: qualifyingMarkets.length, totalMarketsCount: totalMarkets.length, preFilteredCount: preFilteredMarkets.length };
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
        const cacheKey = `team:v2:${sport}:${abbr}:${today}`;
        if (CACHE2 && !bust) {
          const cached = await CACHE2.get(cacheKey, "json").catch(() => null);
          if (cached) return jsonResponse(cached);
        }
        const sportLeague = { mlb:"baseball/mlb", nba:"basketball/nba", nhl:"hockey/nhl" }[sport];
        const abbrLower = abbr.toLowerCase();
        const H = { "User-Agent":"Mozilla/5.0" };
        // 1. ESPN team schedule → game log + record
        let gameLog = [], teamName = abbr, wins = 0, losses = 0, nextGame = null;
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
          // ESPN uses non-standard abbreviations in scoreboard/boxscore (NY=NYK, GS=GSW, etc.)
          const _nbaEspnNorm = { NY:"NYK", GS:"GSW", SA:"SAS", NO:"NOP", PHO:"PHX" };
          const _normNba = a => _nbaEspnNorm[a?.toUpperCase()] || a?.toUpperCase() || "";
          // 1. Depth chart (regular season only)
          try {
            const dcRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${abbrLower}/depthchart`, { headers: H });
            if (dcRes.ok) {
              const dc = await dcRes.json();
              for (const posGroup of dc.positions || []) {
                const pos = posGroup.position?.abbreviation;
                if (!["PG","SG","SF","PF","C"].includes(pos)) continue;
                const s = posGroup.athletes?.[0];
                if (!s) continue;
                lineup.push({ position: pos, name: s.athlete?.displayName || "Unknown", playerId: String(s.athlete?.id || "") });
              }
              lineupConfirmed = lineup.length > 0;
            }
          } catch(e) {}
          // 2. Boxscore starters (playoffs / game day)
          if (lineup.length === 0) {
            try {
              const sbRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard`, { headers: H });
              if (sbRes.ok) {
                const sb = await sbRes.json();
                let gameId = null;
                for (const ev of sb.events || []) {
                  const comps = ev.competitions?.[0]?.competitors || [];
                  if (comps.some(c => _normNba(c.team?.abbreviation) === abbr)) { gameId = ev.id; break; }
                }
                if (gameId) {
                  const sumRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`, { headers: H });
                  if (sumRes.ok) {
                    const sum = await sumRes.json();
                    for (const tp of sum.boxscore?.players || []) {
                      if (_normNba(tp.team?.abbreviation) !== abbr) continue;
                      const athletes = tp.statistics?.[0]?.athletes || [];
                      const starters = athletes.filter(a => a.starter);
                      for (const a of starters) {
                        lineup.push({ position: a.athlete?.position?.abbreviation || "?", name: a.athlete?.displayName || "Unknown", playerId: String(a.athlete?.id || "") });
                      }
                      lineupConfirmed = starters.length > 0;
                      break;
                    }
                  }
                }
              }
            } catch(e) {}
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

export const config = { runtime: 'edge' };

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
