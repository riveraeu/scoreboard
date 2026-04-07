var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var ALLOWED_ORIGIN = "*";
function makeCache(env) {
  if (env?.CACHE) return env.CACHE;
  if (env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) {
    const url = env.UPSTASH_REDIS_REST_URL;
    const auth = `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`;
    const cmd = /* @__PURE__ */ __name((...args) => fetch(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(args)
    }).then((r) => r.json()).catch(() => ({ result: null })), "cmd");
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
var JWT_SECRET_DEFAULT = "scoreboard-jwt-2026-x7k9m2p4";
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
    const JWT_SECRET = env?.JWT_SECRET || JWT_SECRET_DEFAULT;
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
        const token = await makeJWT({ userId, email, exp: Date.now() + 30 * 24 * 60 * 60 * 1e3 }, JWT_SECRET);
        return jsonResponse({ token, userId, email });
      } else if (path === "auth/login" && method === "POST") {
        const { email, password } = await request.json();
        const userStr = await CACHE2.get(`user:${email.toLowerCase()}`);
        if (!userStr) return errorResponse("Invalid credentials", 401);
        const user = JSON.parse(userStr);
        const hash = await pbkdf2Hash(password, user.salt);
        if (hash !== user.passwordHash) return errorResponse("Invalid credentials", 401);
        const token = await makeJWT({ userId: user.id, email: user.email, exp: Date.now() + 30 * 24 * 60 * 60 * 1e3 }, JWT_SECRET);
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
          try {
            const ar = await fetch(`${ESPN_CORE}/${sportSlug}/leagues/${leagueSlug}/athletes/${athleteId}`, {
              headers: { "User-Agent": "Mozilla/5.0" }
            });
            if (ar.ok) {
              const ad = await ar.json();
              const ref = ad.team?.["$ref"] || "";
              const m = ref.match(/\/teams\/(\d+)/);
              if (m) teamId = m[1];
            }
          } catch {
          }
          const rawSubtitle = a.subtitle || "";
          const firstWord = rawSubtitle.split(/[\s·\-]+/)[0].toUpperCase();
          const teamAbbr = /^[A-Z]{2,4}$/.test(firstWord) ? firstWord : rawSubtitle;
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
        const currentYear = (/* @__PURE__ */ new Date()).getFullYear();
        const isPastSeason = year && parseInt(year) < currentYear;
        return jsonResponse({ labels, events: allEvents, totalGames: allEvents.length }, isPastSeason ? 86400 : 14400);
      } else if (path === "dvp/rebuild-pos") {
        const stage = params.get("stage") || "2";
        if (stage === "1") {
          ctx.waitUntil(buildNbaDvpStage1(CACHE2));
          return jsonResponse({ ok: true, message: "Stage 1 (teams+rosters) queued. Check /dvp/debug-players in ~30s." });
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
        const tableResult = await buildAllNbaDvpTables(null);
        if (!tableResult) return errorResponse("Failed to build DVP table", 500);
        const serialized = JSON.stringify(tableResult);
        const upUrl = env.UPSTASH_REDIS_REST_URL;
        const upAuth = `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`;
        const writeResp = await fetch(upUrl, { method: "POST", headers: { Authorization: upAuth, "Content-Type": "application/json" }, body: JSON.stringify(["SET", "dvp:nba:all-positions", serialized, "EX", 86400]) }).then((r) => r.json()).catch((e) => ({ err: String(e) }));
        const readResp = await fetch(upUrl, { method: "POST", headers: { Authorization: upAuth, "Content-Type": "application/json" }, body: JSON.stringify(["GET", "dvp:nba:all-positions"]) }).then((r) => r.json()).catch((e) => ({ err: String(e) }));
        const positions = Object.keys(tableResult).filter((k) => k !== "builtAt");
        return jsonResponse({ ok: true, positions, builtAt: tableResult.builtAt, payloadBytes: serialized.length, writeResp, readResultLen: readResp.result?.length ?? null, testRead });
      } else if (path === "dvp") {
        const sport = params.get("sport") || "basketball/nba";
        const athleteId = params.get("athleteId");
        const [sportSlug, leagueSlug] = sport.split("/");
        let position = params.get("position") || null;
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
            const d = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
            const [pitchRes, batRes, sbRes, mlbSched] = await Promise.all([
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=pitching", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=batting", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${d.replace(/-/g, "")}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${d}&hydrate=lineups,probablePitcher`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
            ]);
            const probables2 = {};
            for (const event of sbRes.events || []) {
              for (const comp of event.competitions || []) {
                const gameAbbrs = (comp.competitors || []).map((c) => c.team?.abbreviation).filter(Boolean);
                for (const competitor of comp.competitors || []) {
                  const abbr = competitor.team?.abbreviation;
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
            const gameOdds = parseGameOdds(sbRes.events);
            const [lineupResult, pitcherResult] = await Promise.all([buildLineupKPct(mlbSched), buildPitcherKPct(mlbSched)]);
            const { lineupKPct: lineupKPct2, lineupBatterKPcts: lineupBatterKPcts2, lineupKPctVR, lineupKPctVL, gameHomeTeams: gameHomeTeams2, projectedLineupTeams: projectedLineupTeams2 } = lineupResult;
            const { pitcherKPct: pitcherKPct2, pitcherKBBPct: pitcherKBBPct2, pitcherHand } = pitcherResult;
            mlbByteam = { pitching: pitchRes, batting: batRes, probables: probables2, lineupKPct: lineupKPct2, lineupBatterKPcts: lineupBatterKPcts2, lineupKPctVR, lineupKPctVL, gameHomeTeams: gameHomeTeams2, pitcherKPct: pitcherKPct2, pitcherKBBPct: pitcherKBBPct2, pitcherHand, projectedLineupTeams: projectedLineupTeams2, gameOdds };
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
          const pKPct = pitcherKPct[playerTeam] ?? null;
          const batterKPcts = lineupBatterKPcts[tonightOpp] ?? [];
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
          const _dvpPkpMeets = pKPct != null && pKPct > 25;
          const _dvpPitcherHand = mlbByteam.pitcherHand?.[playerTeam] ?? null;
          const _dvpLkpVR = mlbByteam.lineupKPctVR?.[tonightOpp] ?? null;
          const _dvpLkpVL = mlbByteam.lineupKPctVL?.[tonightOpp] ?? null;
          const _dvpLkpAll = lineupKPct[tonightOpp] ?? null;
          const _dvpLkp = _dvpPitcherHand === "R" ? _dvpLkpVR ?? _dvpLkpAll : _dvpPitcherHand === "L" ? _dvpLkpVL ?? _dvpLkpAll : _dvpLkpAll;
          const _dvpLkpMeets = _dvpLkp != null && _dvpLkp > 23;
          const _dvpGameLineMeets = _dvpGameOdds?.total != null && _dvpGameOdds?.moneyline != null && _dvpGameOdds.total < 8.5 && _dvpGameOdds.moneyline < -125;
          const _dvpIsStrong = [_dvpPkpMeets, _dvpLkpMeets, _dvpGameLineMeets].filter(Boolean).length >= 2;
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
              pitcherKBBPct: pitcherKBBPct[playerTeam] ?? null,
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
            } : null
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
          nhl: { goals: "KXNHLGLS", assists: "KXNHLAST", points: "KXNHLPTS" },
          mlb: { hits: "KXMLBHITS", homeRuns: "KXMLBHR", hrr: "KXMLBHRR", strikeouts: "KXMLBKS", totalBases: "KXMLBTB" }
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
          return sport === "mlb" ? `gl:mlb242526v2|${key}` : `gl:${key}`;
        };
        __name(parseGameTeams, "parseGameTeams");
        __name(nhlSoftTeams, "nhlSoftTeams");
        __name(mlbSoftTeams, "mlbSoftTeams");
        __name(glCacheKey, "glCacheKey");
        const isDebugMode = params.get("debug") === "1";
        const isBustCache = params.get("bust") === "1";
        if (!isDebugMode && !isBustCache && CACHE2) {
          const todayCacheKey = `tonight:plays:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
          const cached = await CACHE2.get(todayCacheKey, "json").catch(() => null);
          if (cached) return jsonResponse(cached, true);
        }
        if (params.get("mock") === "true") {
          return jsonResponse({ plays: [
            { playerName: "Shai Gilgeous-Alexander", playerId: "4278073", sport: "nba", playerTeam: "OKC", position: "PG", opponent: "DAL", oppRank: 2, oppMetricValue: 119.8, oppMetricLabel: "PPG allowed", oppMetricUnit: "PPG", stat: "points", threshold: 30, kalshiPct: 74, americanOdds: -163, seasonPct: 78.4, softPct: 84.2, softGames: 11, truePct: 81.3, edge: 7.3, gameDate: "2026-04-07" },
            { playerName: "Nikola Jokic", playerId: "3112335", sport: "nba", playerTeam: "DEN", position: "C", opponent: "MEM", oppRank: 5, oppMetricValue: 46.1, oppMetricLabel: "REB allowed/game", oppMetricUnit: "REB", stat: "rebounds", threshold: 10, kalshiPct: 72, americanOdds: -138, seasonPct: 74.5, softPct: 77.3, softGames: 8, truePct: 75.9, edge: 3.9, gameDate: "2026-04-07" },
            { playerName: "Connor McDavid", playerId: "3895074", sport: "nhl", playerTeam: "EDM", position: "C", opponent: "VGK", oppRank: 3, oppMetricValue: 3.4, oppMetricLabel: "Goals against/game", oppMetricUnit: "GAA", stat: "goals", threshold: 1, kalshiPct: 73, americanOdds: -122, seasonPct: 72.1, softPct: 74.5, softGames: 8, truePct: 73.3, edge: 0.3, gameDate: "2026-04-07" },
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
              gameDate: "2026-04-07"
            },
            { playerName: "Shohei Ohtani", playerId: "39949", sport: "mlb", playerTeam: "LAD", position: "DH", opponent: "SD", oppRank: 4, oppMetricValue: 4.21, oppMetricLabel: "ERA allowed", oppMetricUnit: "ERA", stat: "hits", threshold: 1, kalshiPct: 75, americanOdds: -300, seasonPct: 73.8, softPct: 75.2, softGames: 10, truePct: 74.5, edge: -0.5, gameDate: "2026-04-07" }
          ], mock: true }, true);
        }
        const SERIES_CONFIG = {
          KXNBAPTS: { sport: "nba", league: "nba", stat: "points", col: "PTS" },
          KXNBAREB: { sport: "nba", league: "nba", stat: "rebounds", col: "REB" },
          KXNBAAST: { sport: "nba", league: "nba", stat: "assists", col: "AST" },
          KXNBA3PT: { sport: "nba", league: "nba", stat: "threePointers", col: "3PT" },
          KXNHLGLS: { sport: "nhl", league: "nhl", stat: "goals", col: "G" },
          KXNHLAST: { sport: "nhl", league: "nhl", stat: "assists", col: "A" },
          KXNHLPTS: { sport: "nhl", league: "nhl", stat: "points", col: "PTS" },
          KXMLBHITS: { sport: "mlb", league: "mlb", stat: "hits", col: "H" },
          KXMLBHR: { sport: "mlb", league: "mlb", stat: "homeRuns", col: "HR" },
          KXMLBHRR: { sport: "mlb", league: "mlb", stat: "hrr", col: "HRR" },
          KXMLBKS: { sport: "mlb", league: "mlb", stat: "strikeouts", col: "K" },
          KXMLBTB: { sport: "mlb", league: "mlb", stat: "totalBases", col: "TB" },
          KXNFLPAYDS: { sport: "nfl", league: "nfl", stat: "passingYards", col: "YDS" },
          KXNFLRUYDS: { sport: "nfl", league: "nfl", stat: "rushingYards", col: "YDS" },
          KXNFLREYDS: { sport: "nfl", league: "nfl", stat: "receivingYards", col: "YDS" },
          KXNFLTDS: { sport: "nfl", league: "nfl", stat: "touchdowns", col: "TD" }
        };
        const TEAM_NORM = {
          nba: { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX" },
          nhl: { NJ: "NJD", TB: "TBL", LA: "LAK", SJ: "SJS", VGK: "VGK" },
          mlb: { KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", CHW: "CWS", AZ: "ARI", KC: "KC", SD: "SD", SF: "SF", TB: "TB" },
          nfl: { LA: "LAR" }
        };
        const normTeam = /* @__PURE__ */ __name((sport, a) => TEAM_NORM[sport]?.[a] || a, "normTeam");
        const seriesTickers = Object.keys(SERIES_CONFIG);
        async function fetchKalshiSeries(ticker) {
          const freshKey = `kalshi:fresh:${ticker}`;
          const staleKey = `kalshi:stale:${ticker}`;
          if (CACHE2) {
            const cached = await CACHE2.get(freshKey, "json");
            if (cached) return { data: cached, fromCache: true };
          }
          const fetchOne = /* @__PURE__ */ __name(() => fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ticker}&limit=1000&status=open`, {
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
            cf: { cacheEverything: false }
          }).then((r) => r.ok ? r.json() : null).catch(() => null), "fetchOne");
          const fresh = await fetchOne();
          if (fresh && (fresh.markets || []).length > 0) {
            if (CACHE2) {
              await CACHE2.put(freshKey, JSON.stringify(fresh), { expirationTtl: 900 });
              await CACHE2.put(staleKey, JSON.stringify(fresh));
            }
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
        const globalSeen = /* @__PURE__ */ new Set();
        for (let i = 0; i < seriesTickers.length; i++) {
          const ticker = seriesTickers[i];
          const { sport, stat, col } = SERIES_CONFIG[ticker];
          for (const m of kalshiResults[i].markets || []) {
            const strike = parseFloat(m.floor_strike);
            if (isNaN(strike)) continue;
            const threshold = Math.round(strike + 0.5);
            const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
            const last = parseFloat(m.last_price_dollars) || 0;
            const volume = parseInt(m.volume) || 0;
            const price = yesAsk > 0 ? yesAsk : last;
            const pct = Math.round(price * 100);
            if (pct < 70) continue;
            if (pct > 97) continue;
            if (last === 0 && volume === 0) continue;
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
              else kalshiPlayerTeam = normTeam(sport, seg3.slice(0, 3));
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
            qualifyingMarkets.push({ playerName, playerNameDisplay, sport, stat, col, threshold, kalshiPct: pct, americanOdds, kalshiVolume: volume, gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate });
          }
        }
        if (qualifyingMarkets.length === 0) {
          return jsonResponse({ plays: [], note: "no qualifying kalshi markets (implied pct >= 70)" });
        }
        const sportsNeeded = new Set(qualifyingMarkets.map((m) => m.sport));
        const sportByteam = {};
        const NHL_ABBR_MAP = { 1: "NJD", 2: "NYI", 3: "NYR", 4: "PHI", 5: "PIT", 6: "BOS", 7: "BUF", 8: "MTL", 9: "OTT", 10: "TOR", 12: "CAR", 13: "FLA", 14: "TBL", 15: "WSH", 16: "CHI", 17: "DET", 18: "NSH", 19: "STL", 20: "CGY", 21: "COL", 22: "EDM", 23: "VAN", 24: "ANA", 25: "DAL", 26: "LAK", 28: "SJS", 29: "CBJ", 30: "MIN", 52: "WPG", 53: "UTA", 54: "VGK", 55: "SEA" };
        if (CACHE2) {
          await Promise.all([...sportsNeeded].map(async (sport) => {
            const cached = await CACHE2.get(`byteam:${sport}`, "json").catch(() => null);
            if (cached) sportByteam[sport] = cached;
          }));
        }
        const sportsNeedingFetch = new Set([...sportsNeeded].filter((s) => !sportByteam[s]));
        if (sportsNeedingFetch.size > 0) {
          await Promise.all([
            sportsNeedingFetch.has("nba") && fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=defensive", {
              headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
            }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then(async (d) => {
              sportByteam.nba = d.teams || [];
              if (CACHE2) await CACHE2.put("byteam:nba", JSON.stringify(sportByteam.nba), { expirationTtl: 21600 });
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
                const d = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
                return fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${d.replace(/-/g, "")}`, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
              })(),
              (() => {
                const d = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
                return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${d}&hydrate=lineups,probablePitcher`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
              })()
            ]).then(async ([pitchData, batData, sbData, mlbSched]) => {
              const probables = {};
              for (const event of sbData.events || []) {
                for (const comp of event.competitions || []) {
                  const gameAbbrs = (comp.competitors || []).map((c) => c.team?.abbreviation).filter(Boolean);
                  for (const competitor of comp.competitors || []) {
                    const abbr = competitor.team?.abbreviation;
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
              const gameOdds = parseGameOdds(sbData.events);
              const [lineupResult, pitcherResult] = await Promise.all([buildLineupKPct(mlbSched), buildPitcherKPct(mlbSched)]);
              const { lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, gameHomeTeams, projectedLineupTeams } = lineupResult;
              const { pitcherKPct, pitcherKBBPct, pitcherHand } = pitcherResult;
              sportByteam.mlb = { pitching: pitchData, batting: batData, probables, lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, gameHomeTeams, pitcherKPct, pitcherKBBPct, pitcherHand, projectedLineupTeams, gameOdds };
              if (CACHE2) await CACHE2.put("byteam:mlb", JSON.stringify(sportByteam.mlb), { expirationTtl: 600 });
            }),
            sportsNeedingFetch.has("nfl") && fetch("https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byteam?region=us&lang=en&isqualified=true&page=1&limit=32&category=passing", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then(async (d) => {
              sportByteam.nfl = d.teams || [];
              if (CACHE2) await CACHE2.put("byteam:nfl", JSON.stringify(sportByteam.nfl), { expirationTtl: 1800 });
            })
          ].filter(Boolean));
        }
        const STAT_SOFT = {};
        if (sportByteam.nba) {
          for (const st of ["points", "rebounds", "assists", "threePointers"]) {
            STAT_SOFT[`nba|${st}`] = { softTeams: new Set(buildSoftTeamAbbrs(sportByteam.nba, st)), rankMap: buildTeamRankMap(sportByteam.nba, st) };
          }
        }
        if (sportByteam.nhl) {
          const { ga } = sportByteam.nhl;
          for (const st of ["goals", "assists", "points"]) {
            STAT_SOFT[`nhl|${st}`] = nhlSoftTeams(ga, "goalsAgainstPerGame", "Goals against/game", "GAA");
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
          for (const st of ["hits", "homeRuns", "hrr", "totalBases"]) {
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
        const preFilteredMarkets = qualifyingMarkets.filter((m) => {
          const softData = STAT_SOFT[`${m.sport}|${m.stat}`];
          if (!softData) return false;
          if (m.sport === "mlb") {
            if (!m.gameTeam1 || !m.gameTeam2) return false;
            if (m.stat === "strikeouts") {
              return true;
            }
            const playerTeam2 = m.kalshiPlayerTeam;
            if (!playerTeam2) return true;
            const opp2 = m.gameTeam1 === playerTeam2 ? m.gameTeam2 : m.gameTeam2 === playerTeam2 ? m.gameTeam1 : null;
            if (!opp2) return false;
            const pitcherEra = sportByteam.mlb?.probables?.[opp2]?.era;
            if (pitcherEra != null && !isNaN(pitcherEra)) return pitcherEra >= 4;
            return STAT_SOFT[`mlb|${m.stat}`]?.softTeams.has(opp2) ?? false;
          }
          if (m.sport === "nhl") return true;
          const playerTeam = m.kalshiPlayerTeam;
          if (!playerTeam || !m.gameTeam1 || !m.gameTeam2) return true;
          const opp = m.gameTeam1 === playerTeam ? m.gameTeam2 : m.gameTeam2 === playerTeam ? m.gameTeam1 : null;
          if (!opp) return false;
          return softData.softTeams.has(opp);
        });
        const uniquePlayerKeys = [...new Map(preFilteredMarkets.map((m) => [`${m.sport}|${m.playerName}`, m])).keys()];
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
        const MAX_PINFO_FETCHES = 10;
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
        if (CACHE2) {
          for (const key of keysForGamelog) {
            const cached = await CACHE2.get(glCacheKey(key), "json");
            if (cached) playerGamelogs[key] = cached;
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
            const reg = (d.seasonTypes || []).find((st) => st.displayName?.toLowerCase().includes("regular")) || d.seasonTypes?.[0];
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
              const events = [
                ...(gl26?.events || []).map((ev) => ({ ...ev, season: 2026 })),
                ...(gl25?.events || []).map((ev) => ({ ...ev, season: 2025 })),
                ...(gl24?.events || []).map((ev) => ({ ...ev, season: 2024 }))
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
        for (let i = 0; i < keysNeedingGamelog.length; i++) {
          await fetchGamelog(keysNeedingGamelog[i]);
          if (i < keysNeedingGamelog.length - 1) await new Promise((r) => setTimeout(r, 350));
        }
        const pitcherGamelogs = {};
        if (sportByteam.mlb?.probables) {
          const pitcherEntriesToLoad = Object.entries(sportByteam.mlb.probables).filter(([, { name, id }]) => name && id);
          await Promise.all(pitcherEntriesToLoad.map(async ([teamAbbr, { name }]) => {
            const pitcherKey = `mlb|${name}`;
            const cached = CACHE2 ? await CACHE2.get(glCacheKey(pitcherKey), "json").catch(() => null) : null;
            if (cached) pitcherGamelogs[teamAbbr] = { name, gl: cached };
          }));
          const uncachedPitchers = pitcherEntriesToLoad.filter(([teamAbbr]) => !pitcherGamelogs[teamAbbr]);
          for (let i = 0; i < uncachedPitchers.length; i++) {
            const [teamAbbr, { name, id }] = uncachedPitchers[i];
            const pitcherKey = `mlb|${name}`;
            await fetchGamelog(pitcherKey, id);
            const gl = playerGamelogs[pitcherKey] || null;
            if (gl) pitcherGamelogs[teamAbbr] = { name, gl };
            if (i < uncachedPitchers.length - 1) await new Promise((r) => setTimeout(r, 350));
          }
        }
        const leagueAvgCache = {};
        for (const key of ["nba|points", "nba|rebounds", "nba|assists", "nba|threePointers", "nhl|goals", "nhl|assists", "nhl|points"]) {
          const sd = STAT_SOFT[key];
          if (!sd) continue;
          const vals = Object.values(sd.rankMap).map((r) => r.value).filter((v) => v > 0);
          if (vals.length >= 15) leagueAvgCache[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        const [allPositionsDvp, nbaPlayerPositions] = await Promise.all([
          CACHE2 ? CACHE2.get("dvp:nba:all-positions", "json").catch(() => null) : null,
          CACHE2 ? CACHE2.get("dvp:nba:player-positions", "json").catch(() => null) : null
        ]);
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
        const calibMap = {};
        if (CACHE2) {
          const calibKeys = [...new Set(preFilteredMarkets.map((m) => `${m.sport}:${m.stat}`))];
          await Promise.all(calibKeys.map(async (k) => {
            const d = await CACHE2.get(`calib:${k}`, "json").catch(() => null);
            if (d && d.n >= 15) calibMap[k] = d;
          }));
        }
        const playerColCache = {};
        for (const { playerName, sport, col } of preFilteredMarkets) {
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
        for (const { playerName, playerNameDisplay, sport, stat, col, threshold, kalshiPct, americanOdds, kalshiVolume, gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate } of preFilteredMarkets) {
          const key = `${sport}|${playerName}`;
          const info = playerInfoMap[key];
          const gl = playerGamelogs[key];
          if (!info || !gl) {
            if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct, reason: !info ? "no_espn_info" : "no_gamelog", gameTeam1, gameTeam2, kalshiPlayerTeam });
            continue;
          }
          const softData = STAT_SOFT[`${sport}|${stat}`];
          if (!softData) {
            if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct, reason: "no_soft_data" });
            continue;
          }
          const { softTeams, rankMap } = softData;
          const playerTeam = kalshiPlayerTeam || info.teamAbbr;
          let tonightOpp = null;
          if (gameTeam1 && gameTeam2) {
            if (gameTeam1 === playerTeam) tonightOpp = gameTeam2;
            else if (gameTeam2 === playerTeam) tonightOpp = gameTeam1;
          }
          if (!tonightOpp) {
            if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct, reason: "no_opp", playerTeam, gameTeam1, gameTeam2 });
            continue;
          }
          const nbaPos = sport === "nba" ? info.position ? NBA_POS_MAP[info.position] || null : nbaPlayerPositions?.[info.id] || null : null;
          const nbaDvpSoftTeams = sport === "nba" && nbaPos && allPositionsDvp?.[nbaPos]?.softTeams?.[stat] ? new Set(allPositionsDvp[nbaPos].softTeams[stat]) : null;
          const nbaEffectiveSoftTeams = nbaDvpSoftTeams || (sport === "nba" ? softTeams : null);
          if (sport === "nba") {
            if (!nbaEffectiveSoftTeams?.has(tonightOpp)) {
              if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct, reason: "opp_not_soft", opponent: tonightOpp, dvpBased: !!nbaDvpSoftTeams });
              continue;
            }
          } else if (sport !== "mlb" && sport !== "nhl" && !softTeams.has(tonightOpp)) {
            if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct, reason: "opp_not_soft", opponent: tonightOpp });
            continue;
          }
          const colCached = playerColCache[`${sport}|${playerName}|${col}`];
          if (!colCached) {
            if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct, reason: "col_not_found", col, headers: gl.ul });
            continue;
          }
          const { getStat, allVals } = colCached;
          if (allVals.length === 0) {
            if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct, reason: "no_gamelog_vals" });
            continue;
          }
          const seasonPct = allVals.filter((v) => v >= threshold).length / allVals.length * 100;
          const hasSeasonTags = sport === "mlb" && gl.events.length > 0 && gl.events[0].season !== void 0;
          const vals26 = hasSeasonTags ? gl.events.filter((ev) => ev.season === 2026).map(getStat).filter((v) => !isNaN(v)) : [];
          const vals25 = hasSeasonTags ? gl.events.filter((ev) => ev.season === 2025).map(getStat).filter((v) => !isNaN(v)) : [];
          const pct26 = vals26.length >= 1 ? vals26.filter((v) => v >= threshold).length / vals26.length * 100 : null;
          const pct25 = vals25.length >= 1 ? vals25.filter((v) => v >= threshold).length / vals25.length * 100 : null;
          const blendVals = [...vals25, ...vals26];
          const blendedPct = blendVals.length >= 1 ? blendVals.filter((v) => v >= threshold).length / blendVals.length * 100 : null;
          let isStrongMatchup = false, pkpMeets = false, lkpMeets = false, gameLineMeets = false;
          let _pitcherHand = null;
          if (sport === "mlb" && stat === "strikeouts") {
            _pitcherHand = sportByteam.mlb?.pitcherHand?.[playerTeam] ?? null;
            const _pkp = sportByteam.mlb?.pitcherKPct?.[playerTeam] ?? null;
            const _lkpVR = sportByteam.mlb?.lineupKPctVR?.[tonightOpp] ?? null;
            const _lkpVL = sportByteam.mlb?.lineupKPctVL?.[tonightOpp] ?? null;
            const _lkpAll = sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null;
            const _lkp = _pitcherHand === "R" ? _lkpVR ?? _lkpAll : _pitcherHand === "L" ? _lkpVL ?? _lkpAll : _lkpAll;
            const _go = sportByteam.mlb?.gameOdds?.[playerTeam] ?? null;
            pkpMeets = _pkp != null && _pkp > 25;
            lkpMeets = _lkp != null && _lkp > 23;
            gameLineMeets = _go?.total != null && _go?.moneyline != null && _go.total < 8.5 && _go.moneyline < -125;
            isStrongMatchup = [pkpMeets, lkpMeets, gameLineMeets].filter(Boolean).length >= 2;
          }
          let softVals, softLabel, softUnit;
          if (sport === "mlb" && stat === "strikeouts") {
            if (isStrongMatchup) {
              const allLineupKPct = sportByteam.mlb?.lineupKPct || {};
              const highKOppAbbrs = new Set(Object.entries(allLineupKPct).filter(([, k]) => k > 23).map(([a]) => a));
              softVals = gl.events.filter((ev) => highKOppAbbrs.has(ev.oppAbbr)).map(getStat).filter((v) => !isNaN(v));
              softLabel = `vs high-K lineups (strong matchup games)`;
            } else {
              softVals = gl.events.filter((ev) => ev.oppAbbr === tonightOpp).map(getStat).filter((v) => !isNaN(v));
              const lkpVal = sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null;
              const lkpStr = lkpVal !== null ? ` | lineup K% ${lkpVal}%` : "";
              softLabel = `vs ${tonightOpp} batters${lkpStr}`;
            }
            softUnit = "%";
          } else if (sport === "mlb") {
            const pitcherEntry = pitcherGamelogs[tonightOpp];
            const pitcherGl = pitcherEntry?.gl;
            const pitcherName = pitcherEntry?.name || null;
            let pitcherIsSoft = false;
            if (pitcherGl) {
              const hIdx = pitcherGl.ul.indexOf("H");
              if (hIdx !== -1) {
                const allH = pitcherGl.events.map((ev) => parseFloat(ev.stats[hIdx]) || 0).filter((v) => !isNaN(v));
                const avgHSeason = allH.length > 0 ? allH.reduce((a, b) => a + b, 0) / allH.length : 4.5;
                const vsTeamH = pitcherGl.events.filter((ev) => ev.oppAbbr === playerTeam).map((ev) => parseFloat(ev.stats[hIdx]) || 0).filter((v) => !isNaN(v));
                const avgHVsTeam = vsTeamH.length > 0 ? vsTeamH.reduce((a, b) => a + b, 0) / vsTeamH.length : null;
                pitcherIsSoft = avgHVsTeam !== null ? avgHVsTeam >= avgHSeason : avgHSeason >= 4.5;
              }
            } else {
              const era = sportByteam.mlb?.probables?.[tonightOpp]?.era;
              pitcherIsSoft = era != null && !isNaN(era) ? era >= 4 : softTeams.has(tonightOpp);
            }
            if (!pitcherIsSoft) {
              if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct, reason: "pitcher_not_soft", opponent: tonightOpp, pitcher: pitcherName });
              continue;
            }
            softVals = gl.events.filter((ev) => ev.oppAbbr === tonightOpp).map(getStat).filter((v) => !isNaN(v));
            softLabel = pitcherName ? `vs ${pitcherName}` : `vs ${tonightOpp}`;
            softUnit = "%";
            if (softVals.length < 1) softVals = [];
          } else {
            const effectiveSoftSet = sport === "nba" ? nbaEffectiveSoftTeams || softTeams : softTeams;
            softVals = gl.events.filter((ev) => effectiveSoftSet.has(ev.oppAbbr)).map(getStat).filter((v) => !isNaN(v));
            softLabel = null;
            softUnit = null;
          }
          if (sport === "mlb" && stat === "strikeouts") {
            if (!isStrongMatchup) {
              if (isDebug) dropped.push({
                playerName,
                sport,
                stat,
                threshold,
                kalshiPct,
                reason: "not_strong_matchup",
                pkpMeets,
                lkpMeets,
                gameLineMeets,
                pitcherKPct: sportByteam.mlb?.pitcherKPct?.[playerTeam] ?? null,
                lineupKPct: sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null,
                gameOdds: sportByteam.mlb?.gameOdds?.[playerTeam] ?? null
              });
              continue;
            }
          }
          const MIN_H2H = 3;
          const softPct = softVals.length >= MIN_H2H ? softVals.filter((v) => v >= threshold).length / softVals.length * 100 : null;
          const lineupKPctOut = (() => {
            if (sport !== "mlb" || stat !== "strikeouts") return null;
            const vr = sportByteam.mlb?.lineupKPctVR?.[tonightOpp] ?? null;
            const vl = sportByteam.mlb?.lineupKPctVL?.[tonightOpp] ?? null;
            const all = sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null;
            return _pitcherHand === "R" ? vr ?? all : _pitcherHand === "L" ? vl ?? all : all;
          })();
          const lineupKPctProjected = sport === "mlb" && stat === "strikeouts" && lineupKPctOut !== null ? (sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp) : false;
          const pitcherKPctOut = sport === "mlb" && stat === "strikeouts" ? sportByteam.mlb?.pitcherKPct?.[playerTeam] ?? null : null;
          const pitcherKBBPctOut = sport === "mlb" && stat === "strikeouts" ? sportByteam.mlb?.pitcherKBBPct?.[playerTeam] ?? null : null;
          let log5AvgOut = null, expectedKsOut = null, parkFactorOut = null, log5PctOut = null;
          if (sport === "mlb" && stat === "strikeouts" && pitcherKPctOut !== null) {
            const batterKPcts = sportByteam.mlb?.lineupBatterKPcts?.[tonightOpp] ?? [];
            if (batterKPcts.length >= 3) {
              const homeTeam = sportByteam.mlb?.gameHomeTeams?.[playerTeam] || tonightOpp;
              parkFactorOut = PARK_KFACTOR[homeTeam] ?? 1;
              const scores = batterKPcts.map((b) => log5K(pitcherKPctOut, b * 100));
              log5AvgOut = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length * 100).toFixed(1));
              const adjustedLog5 = log5AvgOut * parkFactorOut;
              expectedKsOut = parseFloat((adjustedLog5 / 100 * 26).toFixed(1));
              log5PctOut = parseFloat(log5HitRate(adjustedLog5, threshold).toFixed(1));
            }
          }
          let recentAvgOut = null, dvpFactorOut = null, projectedStatOut = null;
          let posDvpRankOut = null, posDvpValueOut = null, posGroupOut = null, oppDvpRatioOut = null;
          if (sport === "nba" || sport === "nhl") {
            const recentVals = gl.events.slice(0, 10).map(getStat).filter((v) => !isNaN(v));
            recentAvgOut = recentVals.length >= 5 ? parseFloat((recentVals.reduce((a, b) => a + b, 0) / recentVals.length).toFixed(2)) : null;
            if (recentAvgOut !== null && rankMap[tonightOpp]?.value != null) {
              const leagueAvg = leagueAvgCache[`${sport}|${stat}`] ?? null;
              if (leagueAvg) {
                dvpFactorOut = parseFloat((rankMap[tonightOpp].value / leagueAvg).toFixed(3));
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
          let homePctOut = null, awayPctOut = null;
          if (sport === "mlb" && stat !== "strikeouts") {
            const homeVals = gl.events.filter((ev) => ev.isHome === true).map(getStat).filter((v) => !isNaN(v));
            const awayVals = gl.events.filter((ev) => ev.isHome === false).map(getStat).filter((v) => !isNaN(v));
            if (homeVals.length >= 5) homePctOut = parseFloat((homeVals.filter((v) => v >= threshold).length / homeVals.length * 100).toFixed(1));
            if (awayVals.length >= 5) awayPctOut = parseFloat((awayVals.filter((v) => v >= threshold).length / awayVals.length * 100).toFixed(1));
          }
          const isHomeGame = sport === "mlb" ? sportByteam.mlb?.gameHomeTeams?.[playerTeam] === playerTeam : sport === "nba" ? sportByteam.nba?.gameHomeTeams?.[playerTeam] === playerTeam : null;
          const splitPct = sport === "mlb" && stat !== "strikeouts" ? isHomeGame === true ? homePctOut : isHomeGame === false ? awayPctOut : null : null;
          const yesterday = /* @__PURE__ */ new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = yesterday.toISOString().slice(0, 10);
          const isB2B = sport === "nba" && gl.events.length > 0 && (gl.events[0]?.date || "").startsWith(yesterdayStr);
          let recentPctOut = null;
          if (sport === "mlb" && stat !== "strikeouts") {
            const recentVals = gl.events.slice(0, 15).map(getStat).filter((v) => !isNaN(v));
            if (recentVals.length >= 5) {
              recentPctOut = parseFloat((recentVals.filter((v) => v >= threshold).length / recentVals.length * 100).toFixed(1));
            }
          }
          let parkFactorHitterOut = null;
          if (sport === "mlb" && stat !== "strikeouts") {
            const homeTeam = sportByteam.mlb?.gameHomeTeams?.[playerTeam] || tonightOpp;
            const factorTable = stat === "homeRuns" ? PARK_HRFACTOR : PARK_HITFACTOR;
            parkFactorHitterOut = factorTable[homeTeam] ?? null;
          }
          const rawTruePct = (() => {
            if (sport === "mlb" && stat === "strikeouts") {
              const parts = [blendedPct ?? seasonPct, ...softPct !== null ? [softPct] : []];
              return parts.reduce((a, b) => a + b, 0) / parts.length;
            }
            if (sport === "mlb" && hasSeasonTags) {
              const basePct = blendedPct ?? seasonPct;
              const parkAdj = parkFactorHitterOut !== null && stat !== "strikeouts" ? Math.min(99, basePct * parkFactorHitterOut) : null;
              if (softPct !== null) {
                const parts2 = [basePct, softPct];
                if (parkAdj !== null) parts2.push(parkAdj);
                if (recentPctOut !== null) parts2.push(recentPctOut);
                if (splitPct !== null) parts2.push(splitPct);
                return Math.min(99, parts2.reduce((a, b) => a + b, 0) / parts2.length);
              }
              const era = sportByteam.mlb?.probables?.[tonightOpp]?.era ?? null;
              const eraAdj = stat !== "strikeouts" && era !== null && !isNaN(era) && era > 4.2 ? Math.min(99, basePct * Math.min(1.25, era / 4.2)) : null;
              const parts = [basePct];
              if (eraAdj !== null) parts.push(eraAdj);
              if (parkAdj !== null) parts.push(parkAdj);
              if (recentPctOut !== null) parts.push(recentPctOut);
              if (splitPct !== null) parts.push(splitPct);
              return Math.min(99, parts.reduce((a, b) => a + b, 0) / parts.length);
            }
            if (sport === "nhl" && dvpFactorOut !== null) {
              const dvpAdjustedPct = Math.min(99, seasonPct * dvpFactorOut);
              const parts = [seasonPct, dvpAdjustedPct, ...softPct !== null ? [softPct] : []];
              let result = parts.reduce((a, b) => a + b, 0) / parts.length;
              if (isB2B) result = Math.max(0, result - 4);
              return result;
            }
            let base = softPct !== null ? (seasonPct + softPct) / 2 : seasonPct;
            if (isB2B) base = Math.max(0, base - 4);
            return base;
          })();
          const calib = calibMap[`${sport}:${stat}`] ?? null;
          const calibFactor = calib ? parseFloat(Math.max(0.8, Math.min(1.2, calib.wins / calib.n / (calib.sumTruePct / calib.n / 100))).toFixed(3)) : null;
          let truePct = calibFactor !== null ? parseFloat(Math.min(99, rawTruePct * calibFactor).toFixed(1)) : rawTruePct;
          const lowVolume = kalshiVolume < 20;
          const edge = truePct - kalshiPct;
          if (kalshiPct < 70 || edge < 3) {
            if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct, truePct: parseFloat(truePct.toFixed(1)), rawTruePct: parseFloat(rawTruePct.toFixed(1)), calibFactor, edge: parseFloat(edge.toFixed(1)), reason: edge < 3 ? "edge_too_low" : "kalshi_pct_too_low", opponent: tonightOpp });
            continue;
          }
          const mlbH2H = sport === "mlb" && softVals.length >= 1;
          plays.push({
            playerName: playerNameDisplay || playerName,
            playerId: info.id,
            sport,
            playerTeam,
            position: info.position || null,
            opponent: tonightOpp,
            oppRank: mlbH2H ? null : posDvpRankOut ?? rankMap[tonightOpp]?.rank ?? null,
            oppMetricValue: mlbH2H ? parseFloat((softPct ?? seasonPct).toFixed(1)) : posDvpValueOut ?? rankMap[tonightOpp]?.value ?? null,
            oppMetricLabel: mlbH2H ? `${softLabel} (${softVals.length}g)` : rankMap[tonightOpp]?.label || null,
            oppMetricUnit: mlbH2H ? softUnit || "%" : rankMap[tonightOpp]?.unit ?? null,
            posGroup: posGroupOut,
            posDvpRank: posDvpRankOut,
            posDvpValue: posDvpValueOut,
            lineupKPct: lineupKPctOut,
            lineupKPctProjected,
            pitcherKPct: pitcherKPctOut,
            pitcherKBBPct: pitcherKBBPctOut,
            log5Avg: log5AvgOut,
            log5Pct: log5PctOut,
            expectedKs: expectedKsOut,
            stat,
            threshold,
            kalshiPct,
            americanOdds,
            seasonPct: parseFloat((blendedPct ?? seasonPct).toFixed(1)),
            seasonGames: allVals.length,
            blendGames: blendVals.length,
            pct25: pct25 !== null ? parseFloat(pct25.toFixed(1)) : null,
            pct25Games: vals25.length,
            pct26: pct26 !== null ? parseFloat(pct26.toFixed(1)) : null,
            pct26Games: vals26.length,
            softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
            softGames: softVals.length,
            isHardMatchup: sport === "nba" && oppDvpRatioOut !== null ? oppDvpRatioOut <= 0.95 : false,
            isStrongMatchup: sport === "mlb" && stat === "strikeouts" ? isStrongMatchup : void 0,
            pkpMeets: sport === "mlb" && stat === "strikeouts" ? pkpMeets : void 0,
            lkpMeets: sport === "mlb" && stat === "strikeouts" ? lkpMeets : void 0,
            gameLineMeets: sport === "mlb" && stat === "strikeouts" ? gameLineMeets : void 0,
            gameTotal: sport === "mlb" && stat === "strikeouts" ? sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null : void 0,
            gameMoneyline: sport === "mlb" && stat === "strikeouts" ? sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null : void 0,
            pitcherHand: sport === "mlb" && stat === "strikeouts" ? _pitcherHand ?? null : void 0,
            recentAvg: recentAvgOut,
            recentPct: recentPctOut,
            homePct: homePctOut,
            awayPct: awayPctOut,
            isHomeGame,
            splitPct,
            isB2B,
            dvpFactor: dvpFactorOut,
            projectedStat: projectedStatOut,
            parkFactor: parkFactorHitterOut ?? parkFactorOut,
            truePct: parseFloat(truePct.toFixed(1)),
            rawTruePct: parseFloat(rawTruePct.toFixed(1)),
            calibFactor,
            calibN: calib?.n ?? null,
            kalshiVolume,
            lowVolume,
            edge: parseFloat(edge.toFixed(1)),
            kelly: kellyFraction(truePct, americanOdds),
            ev: evPerUnit(truePct, americanOdds),
            historicalHitRate: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
            historicalGames: softVals.length,
            gameDate
          });
        }
        const bestMap = {};
        for (const play of plays) {
          const key = `${play.playerName}|${play.sport}|${play.stat}`;
          if (!bestMap[key] || play.kalshiPct > bestMap[key].kalshiPct) bestMap[key] = play;
        }
        plays.splice(0, plays.length, ...Object.values(bestMap));
        plays.sort((a, b) => b.edge - a.edge);
        if (isDebug) {
          return jsonResponse({ plays, dropped, gamelogErrors, pInfoErrors, preFilteredCount: preFilteredMarkets.length, qualifyingCount: qualifyingMarkets.length, uniquePlayersSearched: uniquePlayerKeys.length, playersWithInfo: Object.keys(playerInfoMap).length, playersWithGamelog: Object.keys(playerGamelogs).length, infoCacheHits: uniquePlayerKeys.length - keysNeedingInfo.length, gamelogCacheHits: keysForGamelog.length - keysNeedingGamelog.length }, true);
        }
        const playsResult = { plays, qualifyingCount: qualifyingMarkets.length, preFilteredCount: preFilteredMarkets.length };
        const sportsInPlays = new Set(plays.map((p) => p.sport));
        if (CACHE2 && sportsInPlays.size >= 2) {
          const todayCacheKey = `tonight:plays:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
          await CACHE2.put(todayCacheKey, JSON.stringify(playsResult), { expirationTtl: 3600 }).catch(() => {
          });
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
      } else if (path === "feedback" && method === "POST") {
        if (!CACHE2) return jsonResponse({ ok: false, error: "no cache" });
        const body = await request.json().catch(() => ({}));
        const { sport, stat, truePct: tp, result } = body;
        if (!sport || !stat || result !== "won" && result !== "lost") return errorResponse("Bad request", 400);
        const calibKey = `calib:${sport}:${stat}`;
        const cur = await CACHE2.get(calibKey, "json").catch(() => null) || { n: 0, wins: 0, sumTruePct: 0 };
        cur.n++;
        if (result === "won") cur.wins++;
        cur.sumTruePct += parseFloat(tp) || 0;
        await CACHE2.put(calibKey, JSON.stringify(cur), { expirationTtl: 31536e3 });
        const winRate = parseFloat((cur.wins / cur.n * 100).toFixed(1));
        const avgPredicted = parseFloat((cur.sumTruePct / cur.n).toFixed(1));
        const corrFactor = cur.n >= 15 ? parseFloat(Math.max(0.8, Math.min(1.2, cur.wins / cur.n / (cur.sumTruePct / cur.n / 100))).toFixed(3)) : null;
        return jsonResponse({ ok: true, sport, stat, n: cur.n, winRate, avgPredicted, corrFactor });
      } else if (path === "calibration") {
        if (!CACHE2) return jsonResponse({ calib: {} });
        const pairs = [
          "nba:points",
          "nba:rebounds",
          "nba:assists",
          "nba:threePointers",
          "nhl:goals",
          "nhl:assists",
          "nhl:points",
          "mlb:hits",
          "mlb:homeRuns",
          "mlb:hrr",
          "mlb:strikeouts",
          "mlb:totalBases",
          "nfl:passingYards",
          "nfl:rushingYards",
          "nfl:receivingYards",
          "nfl:touchdowns"
        ];
        const vals = await Promise.all(pairs.map((k) => CACHE2.get(`calib:${k}`, "json").catch(() => null)));
        const calib = {};
        pairs.forEach((k, i) => {
          if (!vals[i]) return;
          const d = vals[i];
          calib[k] = {
            n: d.n,
            winRate: parseFloat((d.wins / d.n * 100).toFixed(1)),
            avgPredicted: parseFloat((d.sumTruePct / d.n).toFixed(1)),
            corrFactor: d.n >= 15 ? parseFloat(Math.max(0.8, Math.min(1.2, d.wins / d.n / (d.sumTruePct / d.n / 100))).toFixed(3)) : null
          };
        });
        return jsonResponse({ calib }, 21600);
      } else if (path === "leagues") {
        return jsonResponse({ leagues: VALID_SPORTS });
      } else {
        return errorResponse("Unknown route: " + path, 404);
      }
    } catch (e) {
      return errorResponse(e.message, 500);
    }
  }
};
var PARK_KFACTOR = {
  SEA: 1.02,
  NYM: 1.01,
  STL: 1.01,
  ARI: 1.01,
  TB: 1.01,
  MIL: 1.01,
  SF: 1.01,
  HOU: 1,
  BOS: 1,
  NYY: 1,
  ATL: 1,
  MIN: 1,
  DET: 1,
  CWS: 1,
  LAD: 1,
  MIA: 1,
  PIT: 1,
  CLE: 1,
  OAK: 1,
  KC: 1,
  BAL: 0.99,
  CHC: 0.99,
  SD: 0.99,
  PHI: 0.99,
  WSH: 0.99,
  LAA: 0.99,
  TEX: 0.99,
  CIN: 0.99,
  ATH: 0.99,
  COL: 0.98
};
var PARK_HITFACTOR = {
  COL: 1.14,
  CIN: 1.08,
  BOS: 1.07,
  MIL: 1.06,
  TEX: 1.05,
  NYY: 1.03,
  PHI: 1.03,
  KC: 1.02,
  BAL: 1.01,
  ARI: 1.01,
  ATL: 1,
  CHC: 1,
  WSH: 1,
  MIA: 0.99,
  STL: 0.99,
  MIN: 0.98,
  HOU: 0.98,
  CLE: 0.97,
  LAD: 0.97,
  DET: 0.97,
  NYM: 0.96,
  PIT: 0.96,
  CWS: 0.96,
  TB: 0.96,
  LAA: 0.95,
  ATH: 0.95,
  TOR: 0.95,
  SD: 0.94,
  SF: 0.94,
  SEA: 0.93
};
var PARK_HRFACTOR = {
  COL: 1.35,
  CIN: 1.2,
  PHI: 1.15,
  BOS: 1.12,
  MIL: 1.1,
  TEX: 1.08,
  NYY: 1.07,
  BAL: 1.05,
  KC: 1.04,
  ATL: 1.03,
  CHC: 1.02,
  WSH: 1.01,
  ARI: 1,
  STL: 0.99,
  MIN: 0.98,
  HOU: 0.97,
  MIA: 0.97,
  LAD: 0.96,
  CLE: 0.95,
  DET: 0.95,
  NYM: 0.94,
  PIT: 0.93,
  CWS: 0.93,
  TB: 0.92,
  LAA: 0.91,
  ATH: 0.91,
  TOR: 0.91,
  SD: 0.89,
  SF: 0.89,
  SEA: 0.87
};
function log5K(pitcherKPct, batterKPct, leagueKPct = 22.2) {
  const p = pitcherKPct / 100, b = batterKPct / 100, l = leagueKPct / 100;
  const num = p * b / l;
  return num / (num + (1 - p) * (1 - b) / (1 - l));
}
__name(log5K, "log5K");
function poissonCDF(k, lambda) {
  let sum = 0, term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) {
    sum += term;
    term *= lambda / (i + 1);
  }
  return Math.min(1, sum);
}
__name(poissonCDF, "poissonCDF");
function log5HitRate(log5Avg, threshold, avgBF = 26) {
  const lambda = log5Avg / 100 * avgBF;
  return (1 - poissonCDF(threshold - 1, lambda)) * 100;
}
__name(log5HitRate, "log5HitRate");
function decimalOdds(americanOdds) {
  return americanOdds >= 0 ? americanOdds / 100 + 1 : 100 / Math.abs(americanOdds) + 1;
}
__name(decimalOdds, "decimalOdds");
function kellyFraction(truePct, americanOdds) {
  const p = truePct / 100;
  const b = decimalOdds(americanOdds) - 1;
  return Math.max(0, parseFloat(((p * b - (1 - p)) / b).toFixed(4)));
}
__name(kellyFraction, "kellyFraction");
function evPerUnit(truePct, americanOdds) {
  const p = truePct / 100;
  const b = decimalOdds(americanOdds) - 1;
  return parseFloat((p * b - (1 - p)).toFixed(4));
}
__name(evPerUnit, "evPerUnit");
var MLB_ID_TO_ABBR = {
  108: "LAA",
  109: "ARI",
  110: "BAL",
  111: "BOS",
  112: "CHC",
  113: "CIN",
  114: "CLE",
  115: "COL",
  116: "DET",
  117: "HOU",
  118: "KC",
  119: "LAD",
  120: "WSH",
  121: "NYM",
  133: "ATH",
  134: "PIT",
  135: "SD",
  136: "SEA",
  137: "SF",
  138: "STL",
  139: "TB",
  140: "TEX",
  141: "TOR",
  142: "MIN",
  143: "PHI",
  144: "ATL",
  145: "CWS",
  146: "MIA",
  147: "NYY",
  158: "MIL"
};
async function buildLineupKPct(mlbSched) {
  try {
    const teamLineups = {};
    const projectedLineupTeams = /* @__PURE__ */ new Set();
    const gameHomeTeams = {};
    const teamsInTodayGames = {};
    for (const date of mlbSched.dates || []) {
      for (const game of date.games || []) {
        const homeTeamId = game.teams?.home?.team?.id;
        const awayTeamId = game.teams?.away?.team?.id;
        const homeAbbr = MLB_ID_TO_ABBR[homeTeamId] || game.teams?.home?.team?.abbreviation;
        const awayAbbr = MLB_ID_TO_ABBR[awayTeamId] || game.teams?.away?.team?.abbreviation;
        const homePlayers = game.lineups?.homePlayers || [];
        const awayPlayers = game.lineups?.awayPlayers || [];
        if (homeAbbr) teamsInTodayGames[homeAbbr] = homeTeamId;
        if (awayAbbr) teamsInTodayGames[awayAbbr] = awayTeamId;
        if (homeAbbr && homePlayers.length > 0)
          teamLineups[homeAbbr] = homePlayers.map((p) => p.id).filter(Boolean);
        if (awayAbbr && awayPlayers.length > 0)
          teamLineups[awayAbbr] = awayPlayers.map((p) => p.id).filter(Boolean);
        if (homeAbbr && awayAbbr) {
          gameHomeTeams[homeAbbr] = homeAbbr;
          gameHomeTeams[awayAbbr] = homeAbbr;
        }
      }
    }
    const teamsNeedingProjection = Object.keys(teamsInTodayGames).filter((abbr) => !teamLineups[abbr]);
    if (teamsNeedingProjection.length > 0) {
      const today = /* @__PURE__ */ new Date();
      const end = new Date(today.getTime() - 864e5).toISOString().slice(0, 10);
      const start = new Date(today.getTime() - 7 * 864e5).toISOString().slice(0, 10);
      const recentSched = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=lineups`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      ).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
      const recentLineups = {};
      for (const date of [...recentSched.dates || []].reverse()) {
        for (const game of date.games || []) {
          const hAbbr = MLB_ID_TO_ABBR[game.teams?.home?.team?.id] || game.teams?.home?.team?.abbreviation;
          const aAbbr = MLB_ID_TO_ABBR[game.teams?.away?.team?.id] || game.teams?.away?.team?.abbreviation;
          const hIds = (game.lineups?.homePlayers || []).map((p) => p.id).filter(Boolean);
          const aIds = (game.lineups?.awayPlayers || []).map((p) => p.id).filter(Boolean);
          if (hAbbr && !recentLineups[hAbbr] && hIds.length > 0) recentLineups[hAbbr] = hIds;
          if (aAbbr && !recentLineups[aAbbr] && aIds.length > 0) recentLineups[aAbbr] = aIds;
        }
        if (teamsNeedingProjection.every((abbr) => recentLineups[abbr])) break;
      }
      for (const abbr of teamsNeedingProjection) {
        if (recentLineups[abbr]) {
          teamLineups[abbr] = recentLineups[abbr];
          projectedLineupTeams.add(abbr);
        }
      }
    }
    const allIds = [...new Set(Object.values(teamLineups).flat())];
    if (allIds.length === 0) return { lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {}, gameHomeTeams, projectedLineupTeams: [] };
    const idStr = allIds.join(",");
    const [res25, res26, resSplitVR, resSplitVL] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2025,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2026,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2026,sitCodes=vr,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2026,sitCodes=vl,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
    ]);
    const playerStats = {};
    for (const person of [...res25.people || [], ...res26.people || []]) {
      const pid = person.id;
      if (!pid) continue;
      const split = person.stats?.[0]?.splits?.[0]?.stat;
      if (!split) continue;
      if (!playerStats[pid]) playerStats[pid] = { so: 0, pa: 0 };
      playerStats[pid].so += split.strikeOuts || 0;
      playerStats[pid].pa += split.plateAppearances || 0;
    }
    const playerSplits = {};
    for (const [code, res] of [["vr", resSplitVR], ["vl", resSplitVL]]) {
      for (const person of res.people || []) {
        const pid = person.id;
        if (!pid) continue;
        const splits = person.stats?.[0]?.splits || [];
        const s = splits.find((x) => x.split?.code === code) || splits[0];
        if (!s?.stat) continue;
        if (!playerSplits[pid]) playerSplits[pid] = {};
        playerSplits[pid][code] = { so: s.stat.strikeOuts || 0, pa: s.stat.plateAppearances || 0 };
      }
    }
    const lineupKPct = {}, lineupBatterKPcts = {}, lineupKPctVR = {}, lineupKPctVL = {};
    for (const [abbr, ids] of Object.entries(teamLineups)) {
      const soTotal = ids.reduce((s, id) => s + (playerStats[id]?.so || 0), 0);
      const paTotal = ids.reduce((s, id) => s + (playerStats[id]?.pa || 0), 0);
      if (paTotal > 0) lineupKPct[abbr] = parseFloat((soTotal / paTotal * 100).toFixed(1));
      const batterKPcts = ids.filter((id) => (playerStats[id]?.pa || 0) >= 50).map((id) => playerStats[id].so / playerStats[id].pa);
      if (batterKPcts.length >= 3) lineupBatterKPcts[abbr] = batterKPcts;
      for (const [code, out] of [["vr", lineupKPctVR], ["vl", lineupKPctVL]]) {
        const so = ids.reduce((s, id) => s + (playerSplits[id]?.[code]?.so || 0), 0);
        const pa = ids.reduce((s, id) => s + (playerSplits[id]?.[code]?.pa || 0), 0);
        if (pa >= 100) out[abbr] = parseFloat((so / pa * 100).toFixed(1));
      }
    }
    return { lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, gameHomeTeams, projectedLineupTeams: [...projectedLineupTeams] };
  } catch {
    return { lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {}, gameHomeTeams: {}, projectedLineupTeams: [] };
  }
}
__name(buildLineupKPct, "buildLineupKPct");
async function buildPitcherKPct(mlbSched) {
  try {
    const pitcherByTeam = {};
    const pitcherHand = {};
    for (const date of mlbSched.dates || []) {
      for (const game of date.games || []) {
        const homeAbbr = MLB_ID_TO_ABBR[game.teams?.home?.team?.id] || game.teams?.home?.team?.abbreviation;
        const awayAbbr = MLB_ID_TO_ABBR[game.teams?.away?.team?.id] || game.teams?.away?.team?.abbreviation;
        const homeId = game.teams?.home?.probablePitcher?.id;
        const awayId = game.teams?.away?.probablePitcher?.id;
        const homeHand = game.teams?.home?.probablePitcher?.pitchHand?.code || null;
        const awayHand = game.teams?.away?.probablePitcher?.pitchHand?.code || null;
        if (homeAbbr && homeId) {
          pitcherByTeam[homeAbbr] = homeId;
          pitcherHand[homeAbbr] = homeHand;
        }
        if (awayAbbr && awayId) {
          pitcherByTeam[awayAbbr] = awayId;
          pitcherHand[awayAbbr] = awayHand;
        }
      }
    }
    const allIds = [...new Set(Object.values(pitcherByTeam))];
    if (allIds.length === 0) return { pitcherKPct: {}, pitcherKBBPct: {} };
    const idStr = allIds.join(",");
    const [res25, res26] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=season,season=2025,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=season,season=2026,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
    ]);
    const pitcherStats = {};
    for (const person of [...res25.people || [], ...res26.people || []]) {
      const pid = person.id;
      if (!pid) continue;
      const split = person.stats?.[0]?.splits?.[0]?.stat;
      if (!split) continue;
      if (!pitcherStats[pid]) pitcherStats[pid] = { so: 0, bf: 0, bb: 0 };
      pitcherStats[pid].so += split.strikeOuts || 0;
      pitcherStats[pid].bf += split.battersFaced || 0;
      pitcherStats[pid].bb += split.baseOnBalls || 0;
    }
    const pitcherKPct = {}, pitcherKBBPct = {};
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      const s = pitcherStats[id];
      if (s && s.bf >= 50) {
        pitcherKPct[abbr] = parseFloat((s.so / s.bf * 100).toFixed(1));
        pitcherKBBPct[abbr] = parseFloat(((s.so - s.bb) / s.bf * 100).toFixed(1));
      }
    }
    return { pitcherKPct, pitcherKBBPct, pitcherHand };
  } catch {
    return { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {} };
  }
}
__name(buildPitcherKPct, "buildPitcherKPct");
async function warmPlayerInfoCache(cache) {
  if (!cache) return;
  const SERIES = ["KXNBAPTS", "KXNBAREB", "KXNBAAST", "KXNBA3PT", "KXNHLGLS", "KXNHLAST", "KXNHLPTS", "KXMLBHITS", "KXMLBHR", "KXMLBHRR", "KXMLBKS", "KXMLBTB"];
  const SERIES_SPORT = { KXNBAPTS: "nba", KXNBAREB: "nba", KXNBAAST: "nba", KXNBA3PT: "nba", KXNHLGLS: "nhl", KXNHLAST: "nhl", KXNHLPTS: "nhl", KXMLBHITS: "mlb", KXMLBHR: "mlb", KXMLBHRR: "mlb", KXMLBKS: "mlb", KXMLBTB: "mlb" };
  const hdrs = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://www.espn.com/", "Accept": "application/json" };
  const playerKeys = /* @__PURE__ */ new Set();
  for (const ticker of SERIES) {
    try {
      const url = `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ticker}&limit=1000&status=open`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
      if (!r.ok) continue;
      const data = await r.json();
      const sport = SERIES_SPORT[ticker];
      for (const m of data.markets || []) {
        const raw = m.event_title || m.title || "";
        let name = raw.replace(/\s*:\s*\d.*$/, "").replace(/\s+(Points?|Rebounds?|Assists?|3-Pointers?|Goals?|Shots on Goal|Hits?|Home Runs?|Strikeouts?|Total Bases?)\b.*/i, "").replace(/\s+Over\s+\d.*$/i, "").replace(/\s*\(.*\)\s*$/, "").trim();
        if (!name || name.length < 4) continue;
        name = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        playerKeys.add(`${sport}|${name}`);
      }
      await new Promise((res) => setTimeout(res, 200));
    } catch {
    }
  }
  for (const key of playerKeys) {
    try {
      const existing = await cache.get(`pinfo:${key}`, "json");
      if (existing?.id && existing.position !== null) continue;
      if (existing?.id && !key.startsWith("nba|")) continue;
      const [sport, ...parts] = key.split("|");
      const playerName = parts.join("|");
      const r = await fetch(`https://site.web.api.espn.com/apis/search/v2?query=${encodeURIComponent(playerName)}&lang=en&region=us&limit=5&type=player`, { headers: hdrs });
      if (!r.ok) {
        await new Promise((res) => setTimeout(res, 300));
        continue;
      }
      const d = await r.json();
      const players = (d.results?.find((x) => x.type === "player")?.contents || []).filter((p2) => p2.defaultLeagueSlug === sport);
      if (!players.length) continue;
      const p = players[0];
      const id = p.uid?.split("~a:")?.[1];
      if (!id) continue;
      const posMatch = (p.description || p.subtitle || "").match(/\b(QB|RB|WR|TE|PG|SG|SF|PF|Center|Forward|Guard|C|G|F|SP|RP|OF|1B|2B|3B|SS|LW|RW|D)\b/i);
      const rawPos = posMatch ? posMatch[1].toUpperCase() : null;
      const POS_NORM = { CENTER: "C", FORWARD: "F", GUARD: "G" };
      await cache.put(`pinfo:${key}`, JSON.stringify({ id, teamAbbr: "", position: rawPos ? POS_NORM[rawPos] || rawPos : null }), { expirationTtl: 604800 });
      await new Promise((res) => setTimeout(res, 200));
    } catch {
    }
  }
}
__name(warmPlayerInfoCache, "warmPlayerInfoCache");
var _ROSTER_POS_MAP = {
  // Only map unambiguous ESPN roster position abbreviations to 5-pos DvP keys.
  // "G" and "F" are omitted — ESPN uses these generically and we can't distinguish
  // PG from SG or SF from PF, so we skip them rather than guess wrong.
  "C": "C",
  "C/PF": "C",
  "PF/C": "C",
  "PF": "PF",
  "PF/SF": "PF",
  "SF": "SF",
  "SF/PF": "SF",
  "SF/SG": "SF",
  "SG": "SG",
  "SG/SF": "SG",
  "SG/PG": "SG",
  "PG": "PG",
  "PG/SG": "PG"
};
async function buildNbaDvpStage1(cache) {
  try {
    const hdrs = { "User-Agent": "Mozilla/5.0" };
    const teamsRes = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=32", { headers: hdrs });
    if (!teamsRes.ok) {
      console.log("[dvp-s1] teams fetch failed:", teamsRes.status);
      return null;
    }
    const teamsData = await teamsRes.json();
    const nbaTeams = (teamsData.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team);
    if (!nbaTeams.length) {
      console.log("[dvp-s1] no teams");
      return null;
    }
    const rosterResults = await Promise.all(
      nbaTeams.map(
        (t) => fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${t.id}/roster`, { headers: hdrs }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
      )
    );
    const posMap = {};
    const selectedByPos = { PG: [], SG: [], SF: [], PF: [], C: [] };
    for (let i = 0; i < nbaTeams.length; i++) {
      const athletes = rosterResults[i]?.athletes || [];
      const byPos = { PG: [], SG: [], SF: [], PF: [], C: [] };
      for (const athlete of athletes) {
        const pos = _ROSTER_POS_MAP[athlete.position?.abbreviation || ""];
        if (!pos || !athlete.id) continue;
        posMap[String(athlete.id)] = pos;
        if (byPos[pos].length < 2) byPos[pos].push(String(athlete.id));
      }
      for (const pos of Object.keys(selectedByPos)) selectedByPos[pos].push(...byPos[pos]);
    }
    const payload = { ...selectedByPos, builtAt: (/* @__PURE__ */ new Date()).toISOString() };
    if (cache) {
      await cache.put("dvp:nba:selected-players", JSON.stringify(payload), { expirationTtl: 9e4 }).catch(() => {
      });
      await cache.put("dvp:nba:player-positions", JSON.stringify(posMap), { expirationTtl: 86400 }).catch(() => {
      });
    }
    const posCounts = Object.entries(selectedByPos).map(([p, ids]) => `${p}:${ids.length}`).join(" ");
    console.log(`[dvp-s1] done \u2014 ${posCounts} posMap:${Object.keys(posMap).length}`);
    return payload;
  } catch (e) {
    console.log("[dvp-s1] error:", String(e));
    return null;
  }
}
__name(buildNbaDvpStage1, "buildNbaDvpStage1");
var _GL_TEAM_NORM = {
  "GS": "GSW",
  "SA": "SAS",
  "NY": "NYK",
  "NJ": "BKN",
  "NO": "NOP",
  "PHO": "PHX",
  "UTAH": "UTA"
};
async function _fetchAndAggregateDvp(playerIds) {
  const hdrs = { "User-Agent": "Mozilla/5.0" };
  const glUrl = /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog?season=2026`, "glUrl");
  const results = await Promise.all(
    playerIds.map(
      (id) => fetch(glUrl(id), { headers: hdrs }).then((r) => r.ok ? r.json() : null).catch(() => null)
    )
  );
  const teamDvp = {};
  const totalRaw = { pts: 0, reb: 0, ast: 0, tpm: 0, n: 0 };
  for (const d of results) {
    if (!d) continue;
    const ul = (d.labels || []).map((l) => (l || "").toUpperCase());
    const ptsIdx = ul.indexOf("PTS");
    const rebIdx = ul.indexOf("REB");
    const astIdx = ul.indexOf("AST");
    const tpmIdx = ul.indexOf("3PT");
    if (ptsIdx < 0) continue;
    const reg = (d.seasonTypes || []).find((st) => st.displayName?.toLowerCase().includes("regular")) || d.seasonTypes?.[0];
    const seenIds = /* @__PURE__ */ new Set();
    const allEvents = [];
    for (const cat of reg?.categories || []) {
      for (const ev of cat.events || []) {
        if (seenIds.has(ev.eventId)) continue;
        const meta = d.events?.[ev.eventId];
        if (!meta || meta.opponent?.isAllStar) continue;
        seenIds.add(ev.eventId);
        allEvents.push({ meta, stats: ev.stats || [] });
      }
    }
    if (allEvents.length < 35) continue;
    const sumPts = allEvents.reduce((s, e) => s + (parseFloat(e.stats[ptsIdx]) || 0), 0);
    if (sumPts / allEvents.length < 7) continue;
    const pAvg = {
      pts: sumPts / allEvents.length,
      reb: rebIdx >= 0 ? allEvents.reduce((s, e) => s + (parseFloat(e.stats[rebIdx]) || 0), 0) / allEvents.length : 1,
      ast: astIdx >= 0 ? allEvents.reduce((s, e) => s + (parseFloat(e.stats[astIdx]) || 0), 0) / allEvents.length : 1,
      tpm: tpmIdx >= 0 ? allEvents.reduce((s, e) => s + (parseInt(String(e.stats[tpmIdx]).split("-")[0]) || 0), 0) / allEvents.length : 1
    };
    if (pAvg.reb < 0.5) pAvg.reb = 0.5;
    if (pAvg.ast < 0.5) pAvg.ast = 0.5;
    if (pAvg.tpm < 0.1) pAvg.tpm = 0.1;
    for (const { meta, stats } of allEvents) {
      const rawOpp = meta.opponent?.abbreviation || "";
      if (!rawOpp) continue;
      const opp = _GL_TEAM_NORM[rawOpp] || rawOpp;
      const pts = parseFloat(stats[ptsIdx]) || 0;
      const reb = rebIdx >= 0 ? parseFloat(stats[rebIdx]) || 0 : 0;
      const ast = astIdx >= 0 ? parseFloat(stats[astIdx]) || 0 : 0;
      const tpm = tpmIdx >= 0 ? parseInt(String(stats[tpmIdx]).split("-")[0]) || 0 : 0;
      if (pts === 0 && reb === 0 && ast === 0) continue;
      if (!teamDvp[opp]) teamDvp[opp] = { pts: [], reb: [], ast: [], tpm: [] };
      teamDvp[opp].pts.push(pts / pAvg.pts);
      teamDvp[opp].reb.push(reb / pAvg.reb);
      teamDvp[opp].ast.push(ast / pAvg.ast);
      teamDvp[opp].tpm.push(tpm / pAvg.tpm);
      totalRaw.pts += pts;
      totalRaw.reb += reb;
      totalRaw.ast += ast;
      totalRaw.tpm += tpm;
      totalRaw.n++;
    }
  }
  const leagueAvg = totalRaw.n > 0 ? { pts: totalRaw.pts / totalRaw.n, reb: totalRaw.reb / totalRaw.n, ast: totalRaw.ast / totalRaw.n, tpm: totalRaw.tpm / totalRaw.n } : { pts: 10, reb: 5, ast: 3, tpm: 1 };
  return { teamDvp, leagueAvg };
}
__name(_fetchAndAggregateDvp, "_fetchAndAggregateDvp");
function _buildPosRankings({ teamDvp, leagueAvg }) {
  const STAT_KEYS = { points: "pts", rebounds: "reb", assists: "ast", threePointers: "tpm" };
  const rankings = {};
  for (const [stat, key] of Object.entries(STAT_KEYS)) {
    const la = leagueAvg[key] || 1;
    const teamRanks = [];
    for (const [abbr, data] of Object.entries(teamDvp)) {
      const vals = data[key] || [];
      if (vals.length < 5) continue;
      const avgRatio = vals.reduce((a, b) => a + b, 0) / vals.length;
      teamRanks.push({ abbr, avgPts: parseFloat((avgRatio * la).toFixed(2)), ratio: parseFloat(avgRatio.toFixed(3)), gp: vals.length });
    }
    teamRanks.sort((a, b) => b.ratio - a.ratio);
    teamRanks.forEach((t, i) => t.rank = i + 1);
    rankings[stat] = teamRanks;
  }
  const softTeams = Object.fromEntries(
    Object.entries(rankings).map(([stat, ranked]) => {
      const soft = ranked.filter((t) => t.ratio >= 1.05).map((t) => t.abbr);
      return [stat, soft.length >= 5 ? soft : ranked.slice(0, 5).map((t) => t.abbr)];
    })
  );
  return { rankings, softTeams };
}
__name(_buildPosRankings, "_buildPosRankings");
async function buildNbaDvpFromBettingPros(cache) {
  try {
    let buildBpRankings = function(teamVals) {
      const rankings = {};
      for (const stat of Object.keys(BP_STAT_MAP)) {
        const allVals = Object.values(teamVals).map((v) => v[stat]).filter((v) => v != null && !isNaN(v));
        if (!allVals.length) continue;
        const leagueAvg = allVals.reduce((a, b) => a + b, 0) / allVals.length;
        const teamRanks = [];
        for (const [abbr, vals] of Object.entries(teamVals)) {
          const v = vals[stat];
          if (v == null || isNaN(v)) continue;
          const ratio = leagueAvg > 0 ? v / leagueAvg : 1;
          teamRanks.push({ abbr, avgPts: parseFloat(v.toFixed(2)), ratio: parseFloat(ratio.toFixed(3)), gp: avgGamesPlayed });
        }
        teamRanks.sort((a, b) => b.ratio - a.ratio);
        teamRanks.forEach((t, idx) => t.rank = idx + 1);
        rankings[stat] = teamRanks;
      }
      const softTeams = Object.fromEntries(
        Object.entries(rankings).map(([stat, ranked]) => {
          const soft = ranked.filter((t) => t.ratio >= 1.05).map((t) => t.abbr);
          return [stat, soft.length >= 5 ? soft : ranked.slice(0, 5).map((t) => t.abbr)];
        })
      );
      return { rankings, softTeams };
    };
    __name(buildBpRankings, "buildBpRankings");
    const hdrs = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    };
    const res = await fetch("https://www.bettingpros.com/nba/defense-vs-position/", { headers: hdrs });
    if (!res.ok) {
      console.log("[dvp-bp] fetch failed:", res.status);
      return null;
    }
    const html = await res.text();
    const varIdx = html.indexOf("bpDefenseVsPositionStats");
    if (varIdx < 0) {
      console.log("[dvp-bp] bpDefenseVsPositionStats not found in HTML");
      return null;
    }
    const snippet = html.slice(varIdx, varIdx + 300);
    const gpMatch = snippet.match(/avgGamesPlayed\s*:\s*(\d+)/);
    const avgGamesPlayed = gpMatch ? parseInt(gpMatch[1]) : 82;
    const tsIdx = html.indexOf("teamStats:", varIdx);
    if (tsIdx < 0) {
      console.log("[dvp-bp] teamStats not found");
      return null;
    }
    const tsStart = html.indexOf("{", tsIdx);
    if (tsStart < 0) {
      console.log("[dvp-bp] teamStats brace not found");
      return null;
    }
    let depth = 0, i = tsStart;
    for (; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") {
        if (--depth === 0) break;
      }
    }
    let teamStats;
    try {
      teamStats = JSON.parse(html.slice(tsStart, i + 1));
    } catch (e) {
      console.log("[dvp-bp] JSON parse failed:", String(e));
      return null;
    }
    if (!teamStats || !Object.keys(teamStats).length) {
      console.log("[dvp-bp] no teamStats in response");
      return null;
    }
    const _BP_TEAM_NORM = { WAS: "WSH", NOR: "NOP", UTH: "UTA", PHO: "PHX", SA: "SAS", GS: "GSW", NY: "NYK", NO: "NOP" };
    const normalizeTeam = /* @__PURE__ */ __name((abbr) => _BP_TEAM_NORM[abbr] || abbr, "normalizeTeam");
    const BP_STAT_MAP = { points: "points", rebounds: "rebounds", assists: "assists", threePointers: "three_points_made" };
    const BP_POSITIONS = ["PG", "SG", "SF", "PF", "C"];
    const posData = {};
    for (const pos of BP_POSITIONS) posData[pos] = {};
    for (const [rawAbbr, positions] of Object.entries(teamStats)) {
      const teamAbbr = normalizeTeam(rawAbbr);
      for (const pos of BP_POSITIONS) {
        const pd = positions[pos];
        if (!pd) continue;
        const vals = {};
        for (const [ourKey, bpKey] of Object.entries(BP_STAT_MAP)) {
          const v = parseFloat(pd[bpKey]);
          if (!isNaN(v)) vals[ourKey] = v;
        }
        if (Object.keys(vals).length) posData[pos][teamAbbr] = vals;
      }
    }
    const finalResult = {
      builtAt: (/* @__PURE__ */ new Date()).toISOString(),
      source: "bettingpros",
      PG: buildBpRankings(posData.PG),
      SG: buildBpRankings(posData.SG),
      SF: buildBpRankings(posData.SF),
      PF: buildBpRankings(posData.PF),
      C: buildBpRankings(posData.C)
    };
    if (cache) await cache.put("dvp:nba:all-positions", JSON.stringify(finalResult), { expirationTtl: 86400 }).catch(() => {
    });
    console.log(`[dvp-bp] done \u2014 ${BP_POSITIONS.map((p) => `${p}:${Object.keys(posData[p]).length}`).join(" ")} teams`);
    return finalResult;
  } catch (e) {
    console.log("[dvp-bp] error:", String(e));
    return null;
  }
}
__name(buildNbaDvpFromBettingPros, "buildNbaDvpFromBettingPros");
async function buildNbaDvpStage3FG(cache) {
  try {
    const [selected, cPartial] = await Promise.all([
      cache ? cache.get("dvp:nba:selected-players", "json").catch(() => null) : null,
      cache ? cache.get("dvp:nba:c-partial", "json").catch(() => null) : null
    ]);
    if (!selected?.F?.length) {
      console.log("[dvp-s3] no selected players \u2014 run stage 1 first");
      return null;
    }
    const fIds = selected.F.slice(0, 25);
    const gIds = selected.G.slice(0, 20);
    const [fAgg, gAgg] = await Promise.all([
      _fetchAndAggregateDvp(fIds),
      _fetchAndAggregateDvp(gIds)
    ]);
    const finalResult = {
      builtAt: (/* @__PURE__ */ new Date()).toISOString(),
      C: cPartial || { rankings: {}, softTeams: {}, _debug: { error: "stage2 not run" } },
      F: _buildPosRankings(fAgg),
      G: _buildPosRankings(gAgg)
    };
    finalResult.F._debug = { players: fIds.length, teams: Object.keys(fAgg.teamDvp).length, leagueAvg: fAgg.leagueAvg };
    finalResult.G._debug = { players: gIds.length, teams: Object.keys(gAgg.teamDvp).length, leagueAvg: gAgg.leagueAvg };
    if (cache) await cache.put("dvp:nba:all-positions", JSON.stringify(finalResult), { expirationTtl: 86400 }).catch(() => {
    });
    console.log(`[dvp-s3] done \u2014 F teams: ${Object.keys(teamDvpF).length}, G teams: ${Object.keys(teamDvpG).length}`);
    return finalResult;
  } catch (e) {
    console.log("[dvp-s3] error:", String(e));
    return null;
  }
}
__name(buildNbaDvpStage3FG, "buildNbaDvpStage3FG");
var SOFT_TEAM_METRIC = {
  points: { hint: "opponent offensive", idx: 0, label: "PPG allowed", unit: "PPG" },
  rebounds: { hint: "opponent general", idx: 1, label: "REB allowed/game", unit: "REB" },
  assists: { hint: "opponent offensive", idx: 13, label: "AST allowed/game", unit: "AST" },
  threePointers: { hint: "opponent offensive", idx: 8, label: "3PM allowed/game", unit: "3PM" }
};
function parseGameOdds(events) {
  const gameOdds = {};
  for (const event of events || []) {
    for (const comp of event.competitions || []) {
      const odds = (comp.odds || [])[0];
      if (!odds) continue;
      const total = odds.overUnder != null ? parseFloat(odds.overUnder) : null;
      const homeMLRaw = odds.moneyline?.home?.close?.odds ?? odds.homeTeamOdds?.moneyLine ?? null;
      const awayMLRaw = odds.moneyline?.away?.close?.odds ?? odds.awayTeamOdds?.moneyLine ?? null;
      const homeML = homeMLRaw != null ? parseInt(homeMLRaw) : null;
      const awayML = awayMLRaw != null ? parseInt(awayMLRaw) : null;
      for (const competitor of comp.competitors || []) {
        const abbr = competitor.team?.abbreviation;
        if (!abbr) continue;
        const ml = competitor.homeAway === "home" ? homeML : awayML;
        gameOdds[abbr] = { total, moneyline: ml };
      }
    }
  }
  return gameOdds;
}
__name(parseGameOdds, "parseGameOdds");
function buildSoftTeamAbbrs(teams, stat = "points", n = 10) {
  try {
    const { hint, idx } = SOFT_TEAM_METRIC[stat] || SOFT_TEAM_METRIC.points;
    const getCatVal = /* @__PURE__ */ __name((team) => {
      const cat = (team.categories || []).find((c) => c.displayName?.toLowerCase().includes(hint));
      return parseFloat(cat?.values?.[idx] ?? 0);
    }, "getCatVal");
    return [...teams].sort((a, b) => getCatVal(b) - getCatVal(a)).slice(0, n).map((t) => t.team?.abbreviation).filter(Boolean);
  } catch {
    return [];
  }
}
__name(buildSoftTeamAbbrs, "buildSoftTeamAbbrs");
function buildHardTeamAbbrs(teams, stat = "points") {
  try {
    const { hint, idx } = SOFT_TEAM_METRIC[stat] || SOFT_TEAM_METRIC.points;
    const getCatVal = /* @__PURE__ */ __name((team) => {
      const cat = (team.categories || []).find((c) => c.displayName?.toLowerCase().includes(hint));
      return parseFloat(cat?.values?.[idx] ?? 0);
    }, "getCatVal");
    const vals = teams.map(getCatVal).filter((v) => v > 0);
    if (!vals.length) return [];
    const leagueAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return teams.filter((t) => getCatVal(t) / leagueAvg <= 0.95).map((t) => t.team?.abbreviation).filter(Boolean);
  } catch {
    return [];
  }
}
__name(buildHardTeamAbbrs, "buildHardTeamAbbrs");
function buildTeamRankMap(teams, stat = "points") {
  const { hint, idx, label, unit } = SOFT_TEAM_METRIC[stat] || SOFT_TEAM_METRIC.points;
  const getCatVal = /* @__PURE__ */ __name((team) => {
    const cat = (team.categories || []).find((c) => c.displayName?.toLowerCase().includes(hint));
    return parseFloat(cat?.values?.[idx] ?? 0);
  }, "getCatVal");
  const map = {};
  [...teams].sort((a, b) => getCatVal(b) - getCatVal(a)).forEach((t, i) => {
    const abbr = t.team?.abbreviation;
    if (abbr) map[abbr] = { rank: i + 1, value: parseFloat(getCatVal(t).toFixed(1)), label, unit };
  });
  return map;
}
__name(buildTeamRankMap, "buildTeamRankMap");
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
__name(corsHeaders, "corsHeaders");
function jsonResponse(data, opts = false) {
  const headers = { "Content-Type": "application/json", ...corsHeaders() };
  if (opts === true) headers["Cache-Control"] = "no-store";
  else if (typeof opts === "number" && opts > 0) headers["Cache-Control"] = `public, max-age=${opts}`;
  return new Response(JSON.stringify(data), { headers });
}
__name(jsonResponse, "jsonResponse");
function errorResponse(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
__name(errorResponse, "errorResponse");

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const env = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  const ctx = { waitUntil: (p) => { try { p.catch?.(() => {}); } catch {} } };
  return worker_default.fetch(request, env, ctx);
}
