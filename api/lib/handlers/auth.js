// /api/auth/* + /api/user/picks handlers. Single dispatcher that returns a Response when
// the path matches, or null when it doesn't (caller falls through to other handlers).
//
// Context shape: { path, method, request, params, env, CACHE2, JWT_SECRET }.
//
// /api/user/picks (GET/POST) lives here because it's the only authenticated user-data route
// and shares the verifyJWT dependency. POST accepts both legacy {picks, bankroll} (full
// overwrite, kept for cached old clients) and delta {upserts, deletes, bankroll}.
//
// /api/auth/calibration is here too — needs verifyJWT and shares the user-data scoping.

import { errorResponse, jsonResponse, cookieResponse, selfOrigin } from "../utils.js";
import { pbkdf2Hash, makeJWT, verifyJWT } from "../auth-utils.js";
import { neonQuery } from "../neon.js";

// Cookie name used for session persistence.
const SESSION_COOKIE = "sb_token";
// Max-Age = 1 year in seconds.
const SESSION_TTL = 365 * 24 * 60 * 60;

// Build the Set-Cookie header value for the session token.
// localhost is treated as a secure origin by modern browsers, so Secure is safe in dev.
function _cookieHeader(token, maxAge = SESSION_TTL) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// Extract JWT from the session cookie first, then fall back to Authorization: Bearer.
// Fallback lets admin curl scripts keep using -H "Authorization: Bearer <token>".
function _extractToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
  if (m?.[1]) return m[1];
  const bearer = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  return bearer || null;
}

export async function handleAuthRoutes(ctx) {
  const { path, method, request, params, env, CACHE2, JWT_SECRET } = ctx;

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
    return cookieResponse({ userId, email }, _cookieHeader(token));
  }

  if (path === "auth/logout" && method === "POST") {
    return cookieResponse({ ok: true }, _cookieHeader("", 0));
  }

  if (path === "auth/login" && method === "POST") {
    const { email, password } = await request.json();
    const emailKey = email?.toLowerCase();
    if (!emailKey || !password) return errorResponse("Email and password required", 400);

    const failKey = `login_fail:${emailKey}`;
    const attempts = parseInt(await CACHE2.get(failKey) || "0", 10);
    if (attempts >= 5) return errorResponse("Too many login attempts. Try again in 5 minutes.", 429);

    const userStr = await CACHE2.get(`user:${emailKey}`);
    if (!userStr) {
      await CACHE2.incrWithTtl(failKey, 300);
      return errorResponse("Invalid credentials", 401);
    }
    const user = JSON.parse(userStr);
    const hash = await pbkdf2Hash(password, user.salt);
    if (hash !== user.passwordHash) {
      await CACHE2.incrWithTtl(failKey, 300);
      return errorResponse("Invalid credentials", 401);
    }
    await CACHE2.delete(failKey);
    const token = await makeJWT({ userId: user.id, email: user.email, exp: Date.now() + 365 * 24 * 60 * 60 * 1e3 }, JWT_SECRET);
    return cookieResponse({ userId: user.id, email: user.email }, _cookieHeader(token));
  }

  if (path === "auth/reset" && method === "POST") {
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
  }

  if (path === "auth/list-users" && method === "GET") {
    const listAdminKey = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    if (listAdminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
    const upUrl = env?.UPSTASH_REDIS_REST_URL;
    const upAuth = `Bearer ${env?.UPSTASH_REDIS_REST_TOKEN}`;
    if (!upUrl) return errorResponse("No Redis URL", 500);
    const r = await fetch(upUrl, { method: "POST", headers: { Authorization: upAuth, "Content-Type": "application/json" }, body: JSON.stringify(["KEYS", "user:*"]) });
    const { result } = await r.json();
    return jsonResponse({ users: result || [] });
  }

  if (path === "auth/debug-redis" && method === "GET") {
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
  }

  if (path === "auth/clear-kalshi-stale" && method === "POST") {
    // Force-evict a per-ticker stale entry so the next /api/tonight cold path tries Kalshi
    // fresh. Used when stale data has drifted past tolerance and rate-limiting prevents
    // a successful refresh from landing organically. Validates ticker format to prevent
    // arbitrary key deletion.
    const clearAdminKey = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!env?.ADMIN_KEY) return errorResponse("ADMIN_KEY not set", 500);
    if (clearAdminKey !== env.ADMIN_KEY) return errorResponse("Forbidden", 403);
    const ticker = (params.get("ticker") || "").toUpperCase();
    if (!/^KX[A-Z0-9]+$/.test(ticker)) return errorResponse("Invalid ticker (expected KX...)", 400);
    if (!CACHE2) return errorResponse("Cache unavailable", 500);
    const key = `kalshi:stale:${ticker}`;
    await CACHE2.delete(key);
    return jsonResponse({ ok: true, deleted: key });
  }

  if (path === "user/picks" && method === "GET") {
    const payload = await verifyJWT(_extractToken(request), JWT_SECRET);
    if (!payload) return errorResponse("Unauthorized", 401);
    const data = await CACHE2.get(`picks:${payload.userId}`, "json");
    return jsonResponse(data || { picks: [], bankroll: 1e3 });
  }

  if (path === "user/picks" && method === "POST") {
    const payload = await verifyJWT(_extractToken(request), JWT_SECRET);
    if (!payload) return errorResponse("Unauthorized", 401);
    const body = await request.json();
    // Two body shapes accepted:
    //   Legacy:  { picks: [...all], bankroll }                  — full overwrite
    //   Delta:   { upserts: [pick,...], deletes: [id,...], bankroll }  — incremental
    // Legacy is retained so any cached old-JS client during a deploy still works.
    if (Array.isArray(body.picks)) {
      await CACHE2.put(`picks:${payload.userId}`, JSON.stringify({
        picks: body.picks,
        bankroll: body.bankroll != null ? body.bankroll : 1e3,
      }));
      return jsonResponse({ ok: true, count: body.picks.length });
    }
    const existing = (await CACHE2.get(`picks:${payload.userId}`, "json")) || { picks: [], bankroll: 1e3 };
    const upserts = (Array.isArray(body.upserts) ? body.upserts : []).filter(p => p && p.id);
    const deletes = new Set(Array.isArray(body.deletes) ? body.deletes : []);
    const upsertMap = new Map(upserts.map(p => [p.id, p]));
    const kept = (existing.picks || []).filter(p => !deletes.has(p.id) && !upsertMap.has(p.id));
    const picks = [...kept, ...upserts];
    const bankroll = body.bankroll != null ? body.bankroll : (existing.bankroll != null ? existing.bankroll : 1e3);
    await CACHE2.put(`picks:${payload.userId}`, JSON.stringify({ picks, bankroll }));
    return jsonResponse({ ok: true, count: picks.length });
  }

  if (path === "auth/calibration" && method === "GET") {
    const calibPayload = await verifyJWT(_extractToken(request), JWT_SECRET);
    const calibAdminKey = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!calibPayload && calibAdminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
    const upUrl = env?.UPSTASH_REDIS_REST_URL;
    const upAuth = `Bearer ${env?.UPSTASH_REDIS_REST_TOKEN}`;
    if (!upUrl) return errorResponse("No Redis URL", 500);
    // Optional filter: ?modelVersion=v1|v2|all (default "all"). Picks tracked before the
    // version toggle landed have no `modelVersion` field and are treated as v1 for grouping.
    const _calibModelFilter = (params.get("modelVersion") || "all").toLowerCase();
    const _normModelV = (p) => p.modelVersion === "v2" ? "v2" : "v1";
    // Optional filter: ?seasonType=2|3|all (default "all"). 2=regular season, 3=postseason
    // (ESPN convention). Picks tracked before 2026-05-26 have no `seasonType` field and
    // are bucketed as "unknown". Stamped server-side from gameScores at emission time.
    const _calibSeasonFilter = (params.get("seasonType") || "all").toLowerCase();
    const _normSeasonT = (p) => p.seasonType === 3 ? "postseason" : p.seasonType === 2 ? "rs" : "unknown";
    const keysRes = await fetch(upUrl, { method: "POST", headers: { Authorization: upAuth, "Content-Type": "application/json" }, body: JSON.stringify(["KEYS", "picks:*"]) });
    const { result: picksKeys } = await keysRes.json();
    if (!picksKeys || picksKeys.length === 0) return jsonResponse({ totalPicks: 0, finalizedPicks: 0, overall: [], byCategory: {}, byModelVersion: { v1: { n: 0, finalized: 0 }, v2: { n: 0, finalized: 0 } }, bySeasonType: { rs: { n: 0, finalized: 0 }, postseason: { n: 0, finalized: 0 }, unknown: { n: 0, finalized: 0 } } });
    const _allPicksRaw = [];
    await Promise.all((picksKeys || []).map(async key => {
      const data = await CACHE2.get(key, "json").catch(() => null);
      (data?.picks || []).forEach(p => _allPicksRaw.push(p));
    }));
    const byModelVersion = { v1: { n: 0, finalized: 0, wins: 0 }, v2: { n: 0, finalized: 0, wins: 0 } };
    for (const p of _allPicksRaw) {
      const mv = _normModelV(p);
      byModelVersion[mv].n++;
      if (p.result === "won" || p.result === "lost") byModelVersion[mv].finalized++;
      if (p.result === "won") byModelVersion[mv].wins++;
    }
    for (const mv of ["v1", "v2"]) {
      const d = byModelVersion[mv];
      d.hitRate = d.finalized > 0 ? parseFloat((d.wins / d.finalized * 100).toFixed(1)) : null;
    }
    const bySeasonType = { rs: { n: 0, finalized: 0, wins: 0 }, postseason: { n: 0, finalized: 0, wins: 0 }, unknown: { n: 0, finalized: 0, wins: 0 } };
    for (const p of _allPicksRaw) {
      const st = _normSeasonT(p);
      bySeasonType[st].n++;
      if (p.result === "won" || p.result === "lost") bySeasonType[st].finalized++;
      if (p.result === "won") bySeasonType[st].wins++;
    }
    for (const st of ["rs", "postseason", "unknown"]) {
      const d = bySeasonType[st];
      d.hitRate = d.finalized > 0 ? parseFloat((d.wins / d.finalized * 100).toFixed(1)) : null;
    }
    const _picksAfterModel = _calibModelFilter === "all"
      ? _allPicksRaw
      : _allPicksRaw.filter(p => _normModelV(p) === (_calibModelFilter === "v2" ? "v2" : "v1"));
    const allPicks = _calibSeasonFilter === "all"
      ? _picksAfterModel
      : _picksAfterModel.filter(p => _normSeasonT(p) === (_calibSeasonFilter === "3" || _calibSeasonFilter === "postseason" ? "postseason" : _calibSeasonFilter === "2" || _calibSeasonFilter === "rs" ? "rs" : "unknown"));
    const finalized = allPicks.filter(p => p.result === "won" || p.result === "lost");
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
      const kalshiArr = inBucket.map(p => p.kalshiPct).filter(v => typeof v === "number");
      const avgKalshiPct = kalshiArr.length > 0 ? parseFloat((kalshiArr.reduce((s, v) => s + v, 0) / kalshiArr.length).toFixed(1)) : null;
      const actual = inBucket.length > 0 ? parseFloat((wins / inBucket.length * 100).toFixed(1)) : null;
      const roi = actual != null && avgKalshiPct != null ? parseFloat((actual / 100 - avgKalshiPct / 100).toFixed(4)) : null;
      return {
        bucket: b.label,
        predicted: (b.min + Math.min(b.max, 100)) / 2,
        actual,
        n: inBucket.length,
        delta: actual != null ? parseFloat((actual - (b.min + Math.min(b.max, 100)) / 2).toFixed(1)) : null,
        ...(avgKalshiPct != null ? { avgKalshiPct, roi } : {}),
      };
    });
    const _cats = {};
    for (const p of finalized) {
      const cat = `${p.sport || "?"}|${p.stat || "?"}`;
      if (!_cats[cat]) _cats[cat] = { wins: 0, n: 0, kalshiSum: 0, kalshiN: 0 };
      _cats[cat].n++;
      if (p.result === "won") _cats[cat].wins++;
      if (typeof p.kalshiPct === "number") { _cats[cat].kalshiSum += p.kalshiPct; _cats[cat].kalshiN++; }
    }
    const byCategory = Object.fromEntries(
      Object.entries(_cats).map(([cat, d]) => {
        const hitRate = parseFloat((d.wins / d.n * 100).toFixed(1));
        const avgKalshiPct = d.kalshiN > 0 ? parseFloat((d.kalshiSum / d.kalshiN).toFixed(1)) : null;
        const roi = avgKalshiPct != null ? parseFloat((hitRate / 100 - avgKalshiPct / 100).toFixed(4)) : null;
        return [cat, { hitRate, n: d.n, ...(avgKalshiPct != null ? { avgKalshiPct, roi } : {}) }];
      })
    );
    const ksFinalized = finalized.filter(p => p.sport === "mlb" && p.stat === "strikeouts");
    const _ratesOf = (groups) => Object.fromEntries(
      Object.entries(groups).map(([k, d]) => [k, { hitRate: parseFloat((d.wins / d.n * 100).toFixed(1)), n: d.n }])
    );
    const _bySimScore = {}, _byKpctPts = {}, _byKTrendPts = {}, _byStdBF = {};
    for (const p of ksFinalized) {
      const sc = p.finalSimScore ?? p.simScore;
      if (sc != null) {
        const key = String(sc);
        if (!_bySimScore[key]) _bySimScore[key] = { wins: 0, n: 0 };
        _bySimScore[key].n++;
        if (p.result === "won") _bySimScore[key].wins++;
      }
      const kpctKey = String(p.kpctPts ?? "null");
      if (!_byKpctPts[kpctKey]) _byKpctPts[kpctKey] = { wins: 0, n: 0 };
      _byKpctPts[kpctKey].n++;
      if (p.result === "won") _byKpctPts[kpctKey].wins++;
      const ktKey = String(p.kTrendPts ?? "null");
      if (!_byKTrendPts[ktKey]) _byKTrendPts[ktKey] = { wins: 0, n: 0 };
      _byKTrendPts[ktKey].n++;
      if (p.result === "won") _byKTrendPts[ktKey].wins++;
      const bf = p.stdBF ?? 0;
      const bfKey = bf === 0 ? "none" : bf <= 2.5 ? "low" : "high";
      if (!_byStdBF[bfKey]) _byStdBF[bfKey] = { wins: 0, n: 0 };
      _byStdBF[bfKey].n++;
      if (p.result === "won") _byStdBF[bfKey].wins++;
    }
    const bySimScore = Object.fromEntries(
      Object.entries(_bySimScore).sort((a, b) => Number(a[0]) - Number(b[0])).map(([sc, d]) => [sc, { hitRate: parseFloat((d.wins / d.n * 100).toFixed(1)), n: d.n }])
    );
    const byKpctPts = _ratesOf(_byKpctPts);
    const byKTrendPts = _ratesOf(_byKTrendPts);
    const byStdBF = _ratesOf(_byStdBF);
    const _byCatDetail = {};
    for (const p of finalized) {
      const cat = `${p.sport || "?"}|${p.stat || "?"}`;
      const b = _buckets.find(bk => (p.truePct ?? 0) >= bk.min && (p.truePct ?? 0) < bk.max);
      if (!b) continue;
      if (!_byCatDetail[cat]) _byCatDetail[cat] = {};
      if (!_byCatDetail[cat][b.label]) _byCatDetail[cat][b.label] = { wins: 0, n: 0, kalshiSum: 0, kalshiN: 0 };
      _byCatDetail[cat][b.label].n++;
      if (p.result === "won") _byCatDetail[cat][b.label].wins++;
      if (typeof p.kalshiPct === "number") { _byCatDetail[cat][b.label].kalshiSum += p.kalshiPct; _byCatDetail[cat][b.label].kalshiN++; }
    }
    const byCategoryDetail = Object.fromEntries(
      Object.entries(_byCatDetail).map(([cat, buckets]) => [cat,
        _buckets.map(b => {
          const d = buckets[b.label] || { wins: 0, n: 0, kalshiSum: 0, kalshiN: 0 };
          const predicted = (b.min + Math.min(b.max, 100)) / 2;
          const actual = d.n > 0 ? parseFloat((d.wins / d.n * 100).toFixed(1)) : null;
          const avgKalshiPct = d.kalshiN > 0 ? parseFloat((d.kalshiSum / d.kalshiN).toFixed(1)) : null;
          const roi = actual != null && avgKalshiPct != null ? parseFloat((actual / 100 - avgKalshiPct / 100).toFixed(4)) : null;
          return { bucket: b.label, predicted, actual, n: d.n, delta: actual != null ? parseFloat((actual - predicted).toFixed(1)) : null, ...(avgKalshiPct != null ? { avgKalshiPct, roi } : {}) };
        })
      ])
    );

    // Optional ?slice=byDcPenalty — audit of how dataConfidence penalty composition
    // correlates with hit rate. Specifically: is the clean-data filter's noSoftGames
    // whitelist (dc=9 with that penalty alone) calibrated, or is it leaking weak plays?
    let _sliceExtras = null;
    if (params.get("slice") === "byDcPenalty") {
      // Clean-data filter shipped 2026-05-19 00:00 PT. Pre-cutoff picks matching the
      // whitelist pattern existed but were never *exposed* as qualified plays — they came
      // from MarketReport / manual entry, so they're a noisier signal than post-cutoff
      // picks the user took because the filter recommended them.
      const _filterCutoff = Date.UTC(2026, 4, 19, 7, 0, 0);
      const _patternKey = (p) => {
        const keys = Object.keys(p.dcPenalties || {}).sort();
        return keys.length === 0 ? "clean" : keys.join("+");
      };
      const _byDcPattern = {};
      for (const p of finalized) {
        const key = _patternKey(p);
        if (!_byDcPattern[key]) _byDcPattern[key] = { wins: 0, n: 0, edgeSum: 0, edgeN: 0 };
        _byDcPattern[key].n++;
        if (p.result === "won") _byDcPattern[key].wins++;
        if (typeof p.edge === "number") {
          _byDcPattern[key].edgeSum += p.edge;
          _byDcPattern[key].edgeN++;
        }
      }
      const byDcPattern = Object.fromEntries(
        Object.entries(_byDcPattern)
          .sort(([, a], [, b]) => b.n - a.n)
          .map(([k, d]) => [k, {
            n: d.n,
            wins: d.wins,
            hitRate: parseFloat((d.wins / d.n * 100).toFixed(1)),
            avgEdge: d.edgeN > 0 ? parseFloat((d.edgeSum / d.edgeN).toFixed(2)) : null,
          }])
      );
      const _isWhitelisted = (p) => {
        if (p.dataConfidence !== 9) return false;
        const keys = Object.keys(p.dcPenalties || {});
        return keys.length === 1 && keys[0] === "noSoftGames";
      };
      const _isDc10 = (p) => p.dataConfidence === 10;
      const _bucketize = (picks) => _buckets.map(b => {
        const inB = picks.filter(p => (p.truePct ?? 0) >= b.min && (p.truePct ?? 0) < b.max);
        const wins = inB.filter(p => p.result === "won").length;
        const predicted = (b.min + Math.min(b.max, 100)) / 2;
        const actual = inB.length > 0 ? parseFloat((wins / inB.length * 100).toFixed(1)) : null;
        return { bucket: b.label, predicted, actual, n: inB.length, delta: actual != null ? parseFloat((actual - predicted).toFixed(1)) : null };
      });
      const _summarize = (picks) => {
        const wins = picks.filter(p => p.result === "won").length;
        return {
          n: picks.length,
          wins,
          hitRate: picks.length > 0 ? parseFloat((wins / picks.length * 100).toFixed(1)) : null,
          buckets: _bucketize(picks),
        };
      };
      const whitelistedAll = finalized.filter(_isWhitelisted);
      const whitelistedPost = whitelistedAll.filter(p => (p.trackedAt ?? 0) >= _filterCutoff);
      const dc10All = finalized.filter(_isDc10);
      const dc10Post = dc10All.filter(p => (p.trackedAt ?? 0) >= _filterCutoff);
      _sliceExtras = {
        byDcPattern,
        whitelisted: { all: _summarize(whitelistedAll), postFilterShipped: _summarize(whitelistedPost) },
        dc10Baseline: { all: _summarize(dc10All), postFilterShipped: _summarize(dc10Post) },
        filterShippedAt: "2026-05-19T07:00:00Z",
      };
    }

    // Optional ?slice=tailTotals — audit of how distance-from-line correlates with
    // actual hit rate on game/team totals. Question being answered: is the
    // clamp+seasonRateDivergent regime throwing away real edge at tail thresholds,
    // or are tail plays already correctly downweighted?
    let _tailSlice = null;
    if (params.get("slice") === "tailTotals") {
      // Threshold-distance buckets per sport — mirror the dc.js _GT_IMPLIED_CAP / threshold-
      // distance check. [modestCutoff, farCutoff]: dist >= modestCutoff is "modest", dist >=
      // farCutoff is "far". Plays with dist < modestCutoff are "central" (the clean band).
      const _DIST_BUCKETS = {
        total:     { mlb: [3, 5],  nba: [10, 20], wnba: [10, 20], nhl: [2, 3] },
        teamTotal: { mlb: [2, 3],  nba: [5, 10],  wnba: [5, 10],  nhl: [1, 2] },
      };
      // Blend cap shipped 2026-05-17; pre-cutoff totals don't carry the seasonRateDivergent
      // penalty consistently. Limit the slice to post-cutoff to keep penalty composition
      // comparable across plays.
      const _blendCapShipped = Date.UTC(2026, 4, 17, 7, 0, 0);
      const totalsAll = finalized.filter(p =>
        (p.gameType === "total" || p.gameType === "teamTotal") &&
        (p.trackedAt ?? 0) >= _blendCapShipped
      );
      const _bucketFor = (p) => {
        const cuts = _DIST_BUCKETS[p.gameType]?.[p.sport];
        if (!cuts) return null;
        if (p.gameOuLine == null || p.threshold == null) return "noLine";
        const halfLine = p.gameType === "teamTotal" ? p.gameOuLine / 2 : p.gameOuLine;
        const dist = Math.abs(p.threshold - halfLine);
        if (dist < cuts[0]) return "central";
        if (dist < cuts[1]) return "modest";
        return "far";
      };
      // Aggregate: per (sport, gameType, bucket), wins/n + mean predicted truePct + mean edge
      // + % of picks with seasonRateDivergent firing + % with any distance penalty firing.
      const _byBucket = {};
      for (const p of totalsAll) {
        const b = _bucketFor(p);
        if (!b) continue;
        const k = `${p.sport}|${p.gameType}|${b}`;
        if (!_byBucket[k]) _byBucket[k] = {
          n: 0, wins: 0, predSum: 0, edgeSum: 0, divergentN: 0, distPenN: 0,
        };
        const d = _byBucket[k];
        d.n++;
        if (p.result === "won") d.wins++;
        if (typeof p.truePct === "number") d.predSum += p.truePct;
        if (typeof p.edge === "number") d.edgeSum += p.edge;
        const pens = p.dcPenalties || {};
        if (pens.seasonRateDivergent != null) d.divergentN++;
        if (pens.farFromLine != null || pens.modestlyFromLine != null) d.distPenN++;
      }
      const byBucket = Object.fromEntries(
        Object.entries(_byBucket).map(([k, d]) => [k, {
          n: d.n,
          wins: d.wins,
          actualHitRate: d.n > 0 ? parseFloat((d.wins / d.n * 100).toFixed(1)) : null,
          predictedTruePct: d.n > 0 ? parseFloat((d.predSum / d.n).toFixed(1)) : null,
          delta: d.n > 0 ? parseFloat((d.wins / d.n * 100 - d.predSum / d.n).toFixed(1)) : null,
          avgEdge: d.n > 0 ? parseFloat((d.edgeSum / d.n).toFixed(2)) : null,
          divergentPct: d.n > 0 ? parseFloat((d.divergentN / d.n * 100).toFixed(0)) : null,
          distPenPct: d.n > 0 ? parseFloat((d.distPenN / d.n * 100).toFixed(0)) : null,
        }])
      );
      // Penalty-composition cross-cut: hit rate of tail totals WITH the divergent penalty
      // vs WITHOUT, regardless of bucket. Tells us whether the penalty itself correlates
      // with actual underperformance.
      const _withDivergent = totalsAll.filter(p => (p.dcPenalties || {}).seasonRateDivergent != null);
      const _withoutDivergent = totalsAll.filter(p => (p.dcPenalties || {}).seasonRateDivergent == null);
      const _summarizeTotals = (arr) => {
        const wins = arr.filter(p => p.result === "won").length;
        const predSum = arr.reduce((s, p) => s + (typeof p.truePct === "number" ? p.truePct : 0), 0);
        const predN = arr.filter(p => typeof p.truePct === "number").length;
        return {
          n: arr.length,
          wins,
          actualHitRate: arr.length > 0 ? parseFloat((wins / arr.length * 100).toFixed(1)) : null,
          predictedTruePct: predN > 0 ? parseFloat((predSum / predN).toFixed(1)) : null,
          delta: arr.length > 0 && predN > 0 ? parseFloat((wins / arr.length * 100 - predSum / predN).toFixed(1)) : null,
        };
      };
      _tailSlice = {
        byBucket,
        withSeasonRateDivergent: _summarizeTotals(_withDivergent),
        withoutSeasonRateDivergent: _summarizeTotals(_withoutDivergent),
        sampleStartDate: "2026-05-17T07:00:00Z",
        bucketCutoffs: _DIST_BUCKETS,
      };
    }

    return jsonResponse({ totalPicks: allPicks.length, finalizedPicks: finalized.length, overall, byCategory, byCategoryDetail, byModelVersion, bySeasonType, modelFilter: _calibModelFilter, seasonFilter: _calibSeasonFilter, kStrikeouts: { bySimScore, byKpctPts, byKTrendPts, byStdBF, n: ksFinalized.length }, ...(_sliceExtras ? { dcPenaltySlice: _sliceExtras } : {}), ...(_tailSlice ? { tailTotalsSlice: _tailSlice } : {}) });
  }

  // ── Shadow calibration — unbiased full-distribution stats from Neon shadow_plays ──────────
  // GET /api/auth/shadow-calibration
  // Auth: bearer JWT or Authorization: Bearer <ADMIN_KEY>
  // Returns overall/byCategory/byCategoryDetail calibration across ALL model predictions
  // (no edge gate, no dc gate) so categories can be promoted to passesCategoryGate()
  // when ROI > 0 at 90% CI with n ≥ 200.
  if (path === "auth/shadow-calibration" && method === "GET") {
    const scPayload = await verifyJWT(_extractToken(request), JWT_SECRET);
    const scAdminKey = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!scPayload && scAdminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
    if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL && !env?.DATABASE_URL_UNPOOLED) {
      return errorResponse("No Neon connection configured", 500);
    }

    // Build dynamic WHERE clauses — safe parameterized approach.
    const whereParts = ["resolved = TRUE", "won IS NOT NULL"];
    const qp = [];
    const _p = (val) => { qp.push(val); return `$${qp.length}`; };

    // Default window: last 30 days (avoids pre-model-change data swamping results).
    const sinceDefault = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const since = params.get("since") || sinceDefault;
    whereParts.push(`snapshot_date >= ${_p(since)}`);

    if (params.get("dcQualified") === "true") whereParts.push("dc_qualified = TRUE");
    const _minDcStr = params.get("minDc");
    if (_minDcStr) {
      const _minDc = parseInt(_minDcStr, 10);
      if (!isNaN(_minDc)) whereParts.push(`dc >= ${_p(_minDc)}`);
    }
    if (params.get("sport")) whereParts.push(`sport = ${_p(params.get("sport"))}`);
    if (params.get("category")) whereParts.push(`COALESCE(stat, game_type) = ${_p(params.get("category"))}`);
    if (params.get("thresholdRank") === "1") whereParts.push("threshold_rank = 1");
    // Optional bet-set filters — isolate the plays we'd ACTUALLY bet (edge gate + Kalshi
    // price window), so a query can measure precise in-gate ROI rather than the diluted
    // all-plays band. bet price is no_kalshi_pct for UNDERs, kalshi_pct for OVERs.
    const _minEdgeStr = params.get("minEdge");
    if (_minEdgeStr && !isNaN(parseFloat(_minEdgeStr))) whereParts.push(`edge >= ${_p(parseFloat(_minEdgeStr))}`);
    const _pMin = params.get("priceMin"), _pMax = params.get("priceMax");
    if (_pMin && !isNaN(parseFloat(_pMin))) whereParts.push(`(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END) >= ${_p(parseFloat(_pMin))}`);
    if (_pMax && !isNaN(parseFloat(_pMax))) whereParts.push(`(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END) <= ${_p(parseFloat(_pMax))}`);
    const _stStr = params.get("seasonType");
    if (_stStr) {
      const _st = parseInt(_stStr, 10);
      if (!isNaN(_st)) whereParts.push(`season_type = ${_p(_st)}`);
    }
    // Liquidity slice: kalshiVolume lives in the features JSONB (not a dedicated column).
    // Rows lacking the key are excluded by the numeric comparison — intended (unknown liquidity).
    // Lets the Brier head-to-head test "does the model beat the THIN markets?" (where stale
    // prices live) vs the liquid ones (which are razor-sharp). Used with ?brier=1.
    const _volMaxStr = params.get("volumeMax"), _volMinStr = params.get("volumeMin");
    if (_volMaxStr && !isNaN(parseFloat(_volMaxStr))) whereParts.push(`(features->>'kalshiVolume')::numeric <= ${_p(parseFloat(_volMaxStr))}`);
    if (_volMinStr && !isNaN(parseFloat(_volMinStr))) whereParts.push(`(features->>'kalshiVolume')::numeric >= ${_p(parseFloat(_volMinStr))}`);
    const bestThreshold = params.get("bestThreshold") === "true";

    const whereClause = whereParts.join(" AND ");

    // bet_side_pct (bsp): P(bet wins) from model's perspective.
    // model_true_pct is stored BET-SIDE on a 0–100 scale (shadow.js:1571 stores noTruePct /
    // 100−truePct for UNDERs), so it already equals P(bet wins) — use it directly, no flip.
    // (Pre-2026-06-19 this applied `1 - model_true_pct` to UNDERs, which on the 0–100 column
    // went negative and dumped every UNDER row into the 0-5 band — silently dropping them from
    // the bands via the bsp≥55 filter. Over-only categories were unaffected.)
    // bet_pct: the market price paid for the bet (no_kalshi_pct for UNDERs, kalshi_pct for OVERs).
    // ROI per $1 wagered = hitRate/100 - avg(bet_pct).
    // bestThreshold=true: keep only the highest-bsp row per (sport, category, group_id) — one
    // prediction per game/player, representing what the bet selection logic would actually pick.
    const shadowCalibSql = `
WITH base AS (
  SELECT
    sport,
    COALESCE(stat, game_type) AS category,
    group_id,
    model_true_pct AS bsp, -- stored bet-side (0–100); = P(bet wins), no under-flip needed
    (won)::int AS w,
    CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END AS bet_pct,
    edge
  FROM shadow_plays
  WHERE ${whereClause}
),
${bestThreshold ? `
best AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY sport, category, group_id ORDER BY bsp DESC) AS _rn,
    COUNT(*) OVER (PARTITION BY sport, category, group_id) AS _gs
  FROM base
),
source AS (SELECT sport, category, bsp, w, bet_pct, edge, _gs AS group_size FROM best WHERE _rn = 1),
` : `source AS (SELECT sport, category, bsp, w, bet_pct, edge, 1 AS group_size FROM base),`}
banded AS (
  SELECT *,
    CASE
      WHEN bsp >= 95 THEN '95+'
      WHEN bsp >= 90 THEN '90-95'
      WHEN bsp >= 85 THEN '85-90'
      WHEN bsp >= 80 THEN '80-85'
      WHEN bsp >= 75 THEN '75-80'
      WHEN bsp >= 70 THEN '70-75'
      WHEN bsp >= 65 THEN '65-70'
      WHEN bsp >= 60 THEN '60-65'
      WHEN bsp >= 55 THEN '55-60'
      WHEN bsp >= 50 THEN '50-55'
      WHEN bsp >= 45 THEN '45-50'
      WHEN bsp >= 40 THEN '40-45'
      WHEN bsp >= 35 THEN '35-40'
      WHEN bsp >= 30 THEN '30-35'
      WHEN bsp >= 25 THEN '25-30'
      WHEN bsp >= 20 THEN '20-25'
      WHEN bsp >= 15 THEN '15-20'
      WHEN bsp >= 10 THEN '10-15'
      WHEN bsp >= 5  THEN '5-10'
      ELSE '0-5'
    END AS band
  FROM source
),
overall_band AS (
  SELECT 'band'::text AS type, NULL::text AS sport, NULL::text AS category, band,
    COUNT(*) AS n, SUM(w) AS wins, AVG(bet_pct) AS avg_bet_pct, AVG(edge) AS avg_edge,
    SUM(group_size) AS n_raw, ROUND(AVG(group_size), 1) AS avg_group_size
  FROM banded GROUP BY band
),
by_cat AS (
  SELECT 'cat'::text AS type, sport, category, NULL::text AS band,
    COUNT(*) AS n, SUM(w) AS wins, AVG(bet_pct) AS avg_bet_pct, AVG(edge) AS avg_edge,
    SUM(group_size) AS n_raw, ROUND(AVG(group_size), 1) AS avg_group_size
  FROM banded GROUP BY sport, category
),
by_cat_band AS (
  SELECT 'cat_band'::text AS type, sport, category, band,
    COUNT(*) AS n, SUM(w) AS wins, AVG(bet_pct) AS avg_bet_pct, AVG(edge) AS avg_edge,
    SUM(group_size) AS n_raw, ROUND(AVG(group_size), 1) AS avg_group_size
  FROM banded GROUP BY sport, category, band
)
SELECT * FROM overall_band
UNION ALL SELECT * FROM by_cat
UNION ALL SELECT * FROM by_cat_band`;

    let scRows;
    try {
      scRows = await neonQuery(shadowCalibSql, qp, env);
    } catch (e) {
      return errorResponse(`Neon query failed: ${e.message}`, 500);
    }

    const _SC_BANDS = [
      { label: "0-5",   min: 0,  max: 5   },
      { label: "5-10",  min: 5,  max: 10  },
      { label: "10-15", min: 10, max: 15  },
      { label: "15-20", min: 15, max: 20  },
      { label: "20-25", min: 20, max: 25  },
      { label: "25-30", min: 25, max: 30  },
      { label: "30-35", min: 30, max: 35  },
      { label: "35-40", min: 35, max: 40  },
      { label: "40-45", min: 40, max: 45  },
      { label: "45-50", min: 45, max: 50  },
      { label: "50-55", min: 50, max: 55  },
      { label: "55-60", min: 55, max: 60  },
      { label: "60-65", min: 60, max: 65  },
      { label: "65-70", min: 65, max: 70  },
      { label: "70-75", min: 70, max: 75  },
      { label: "75-80", min: 75, max: 80  },
      { label: "80-85", min: 80, max: 85  },
      { label: "85-90", min: 85, max: 90  },
      { label: "90-95", min: 90, max: 95  },
      { label: "95+",   min: 95, max: 101 },
    ];
    const _scBandMid = Object.fromEntries(
      _SC_BANDS.map(b => [b.label, parseFloat(((b.min + Math.min(b.max, 100)) / 2).toFixed(1))])
    );

    function _scCell(row) {
      const n = Number(row.n ?? 0);
      const wins = Number(row.wins ?? 0);
      // kalshi_pct is stored 0–100 (e.g. 70); divide by 100 to get fraction before ROI math.
      const avgBetPct = row.avg_bet_pct != null ? parseFloat((Number(row.avg_bet_pct) / 100).toFixed(4)) : null;
      const avgEdge = row.avg_edge != null ? parseFloat(Number(row.avg_edge).toFixed(2)) : null;
      const actual = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
      const predicted = row.band ? (_scBandMid[row.band] ?? null) : null;
      const delta = actual != null && predicted != null ? parseFloat((actual - predicted).toFixed(1)) : null;
      const roi = actual != null && avgBetPct != null ? parseFloat((actual / 100 - avgBetPct).toFixed(4)) : null;
      const nRaw = row.n_raw != null ? Number(row.n_raw) : n;
      const avgGroupSize = row.avg_group_size != null ? parseFloat(Number(row.avg_group_size).toFixed(1)) : null;
      return { n, wins, actual, predicted, delta, roi, avgEdge, avgBetPct, nRaw, avgGroupSize };
    }

    const _scOverallMap = {};
    const _scCatMap = {};
    const _scCatBandMap = {};
    let scTotalN = 0;

    for (const row of scRows) {
      if (row.type === "band") {
        _scOverallMap[row.band] = row;
      } else if (row.type === "cat") {
        const key = `${row.sport}|${row.category}`;
        _scCatMap[key] = row;
        scTotalN += Number(row.n ?? 0);
      } else if (row.type === "cat_band") {
        const key = `${row.sport}|${row.category}`;
        if (!_scCatBandMap[key]) _scCatBandMap[key] = {};
        _scCatBandMap[key][row.band] = row;
      }
    }

    const _emptyBand = (b) => ({ band: b.label, predicted: _scBandMid[b.label], actual: null, delta: null, n: 0, roi: null, avgEdge: null });

    const scOverall = _SC_BANDS.map(b => {
      const row = _scOverallMap[b.label];
      if (!row) return _emptyBand(b);
      const c = _scCell({ ...row, band: b.label });
      return { band: b.label, predicted: c.predicted, actual: c.actual, delta: c.delta, n: c.n, roi: c.roi, avgEdge: c.avgEdge };
    });

    const scByCategory = Object.fromEntries(
      Object.entries(_scCatMap).map(([key, row]) => {
        const c = _scCell(row);
        return [key, { n: c.n, hitRate: c.actual, roi: c.roi, avgEdge: c.avgEdge, nRaw: c.nRaw, avgGroupSize: c.avgGroupSize }];
      })
    );

    const scByCategoryDetail = Object.fromEntries(
      Object.entries(_scCatBandMap).map(([key, bandRows]) => [key,
        _SC_BANDS.map(b => {
          const row = bandRows[b.label];
          if (!row) return _emptyBand(b);
          const c = _scCell({ ...row, band: b.label });
          return { band: b.label, predicted: c.predicted, actual: c.actual, delta: c.delta, n: c.n, roi: c.roi, avgEdge: c.avgEdge };
        })
      ])
    );

    // ── Proper-score head-to-head: model-Brier vs market-Brier per category ──────────────
    // The recalibration decision (docs/MODEL_IMPROVEMENT.md): a calibration miss only warrants
    // a formula change if the MODEL beats the MARKET on a proper score (else de-shrinking just
    // bets more into a market that wins — the totalRuns trap). `skill = marketBrier - modelBrier`:
    // POSITIVE = model is sharper than the market (real edge — de-shrink legit); NEGATIVE = market
    // wins (don't tune). Both probs on 0–1. model_true_pct is stored BET-SIDE (write at
    // shadow.js:1571) so it predicts `won` directly (no under-flip); market bet price is
    // no_kalshi_pct for unders / kalshi_pct for overs. avg_* fields are scale self-checks
    // (should be ~0.x, not ~xx). Gated behind ?brier=1; reuses the same whereClause + params.
    let brier = null;
    if (params.get("brier") === "1") {
      const brierSql = `
SELECT sport, COALESCE(stat, game_type) AS category,
  COUNT(*) AS n,
  AVG(POWER(model_true_pct/100.0 - (won)::int, 2)) AS model_brier,
  AVG(POWER((CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 - (won)::int, 2)) AS market_brier,
  AVG(model_true_pct)/100.0 AS avg_model,
  AVG(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 AS avg_market,
  AVG((won)::int) AS avg_won
FROM shadow_plays
WHERE ${whereClause}
GROUP BY sport, COALESCE(stat, game_type)
ORDER BY COUNT(*) DESC`;
      try {
        const brierRows = await neonQuery(brierSql, qp, env);
        brier = Object.fromEntries(brierRows.map(r => {
          const mb = r.model_brier != null ? parseFloat(Number(r.model_brier).toFixed(4)) : null;
          const kb = r.market_brier != null ? parseFloat(Number(r.market_brier).toFixed(4)) : null;
          return [`${r.sport}|${r.category}`, {
            n: Number(r.n ?? 0),
            modelBrier: mb,
            marketBrier: kb,
            skill: mb != null && kb != null ? parseFloat((kb - mb).toFixed(4)) : null, // >0 model sharper
            avgModel: r.avg_model != null ? parseFloat(Number(r.avg_model).toFixed(3)) : null,
            avgMarket: r.avg_market != null ? parseFloat(Number(r.avg_market).toFixed(3)) : null,
            avgWon: r.avg_won != null ? parseFloat(Number(r.avg_won).toFixed(3)) : null,
          }];
        }));
      } catch (e) {
        brier = { error: e.message };
      }
    }

    return jsonResponse({
      n: scTotalN,
      filters: {
        since,
        dcQualified: params.get("dcQualified") === "true",
        minDc: _minDcStr ? parseInt(_minDcStr, 10) : null,
        sport: params.get("sport") || null,
        thresholdRank: params.get("thresholdRank") === "1" ? 1 : null,
        bestThreshold: bestThreshold || null,
        seasonType: _stStr ? parseInt(_stStr, 10) : null,
        volumeMax: _volMaxStr ? parseFloat(_volMaxStr) : null,
        volumeMin: _volMinStr ? parseFloat(_volMinStr) : null,
      },
      overall: scOverall,
      byCategory: scByCategory,
      byCategoryDetail: scByCategoryDetail,
      ...(brier !== null ? { brier } : {}),
    });
  }

  if (path === "auth/shadow-stats" && method === "GET") {
    const ak = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!env?.ADMIN_KEY) return errorResponse("ADMIN_KEY not set", 500);
    if (ak !== env.ADMIN_KEY) return errorResponse("Forbidden", 403);

    // Optional: ?trigger=1 runs the shadow-snapshot cron inline before returning stats.
    let triggerResult = null;
    if (params.get("trigger") === "1" && env?.CRON_SECRET) {
      const origin = selfOrigin(request);
      try {
        const tr = await fetch(`${origin}/api/shadow-snapshot`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${env.CRON_SECRET}` },
        });
        triggerResult = await tr.json().catch(() => ({ status: tr.status }));
      } catch (e) {
        triggerResult = { error: String(e) };
      }
    }

    // Optional: ?resolvetrigger=1 runs the shadow-resolver cron inline.
    let resolveResult = null;
    if (params.get("resolvetrigger") === "1" && env?.CRON_SECRET) {
      const origin = selfOrigin(request);
      // Forward the resolver's maintenance params (tennis regrade backfill) so admin-triggered
      // runs work without CRON_SECRET (sensitive — not pullable via `vercel env pull`).
      const fwd = new URLSearchParams();
      for (const k of ["regradetennis", "dry"]) if (params.get(k)) fwd.set(k, params.get(k));
      try {
        const tr = await fetch(`${origin}/api/shadow-resolver${fwd.size ? `?${fwd}` : ""}`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${env.CRON_SECRET}` },
        });
        resolveResult = await tr.json().catch(() => ({ status: tr.status }));
      } catch (e) {
        resolveResult = { error: String(e) };
      }
    }

    let tables;
    try {
      tables = await neonQuery("SELECT tablename FROM pg_tables WHERE schemaname='public'", [], env);
    } catch (e) {
      return errorResponse(`Neon query failed: ${e.message}`, 500);
    }
    const hasShadow = tables.some(r => r.tablename === "shadow_plays");
    if (!hasShadow) return jsonResponse({
      ...(triggerResult !== null ? { trigger: triggerResult } : {}),
      ...(resolveResult !== null ? { resolve: resolveResult } : {}),
      tables: tables.map(r => r.tablename),
      shadow_plays: null,
    });

    const [totals, byDate, byCategory, dcDist, unresolvedByCategory] = await Promise.all([
      neonQuery("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE dc_qualified) as qualified, COUNT(*) FILTER (WHERE resolved) as resolved FROM shadow_plays", [], env),
      neonQuery("SELECT snapshot_date, COUNT(*) as n FROM shadow_plays GROUP BY 1 ORDER BY 1 DESC LIMIT 7", [], env),
      neonQuery("SELECT sport, COALESCE(stat, game_type, '?') as category, COUNT(*) as n, COUNT(*) FILTER (WHERE dc_qualified) as qualified FROM shadow_plays GROUP BY 1, 2 ORDER BY n DESC LIMIT 20", [], env),
      neonQuery("SELECT dc, COUNT(*) as n FROM shadow_plays GROUP BY 1 ORDER BY 1 DESC NULLS LAST", [], env),
      neonQuery("SELECT sport, COALESCE(stat, game_type, '?') as category, snapshot_date::date as snapshot_date, COUNT(*) as n FROM shadow_plays WHERE NOT resolved GROUP BY 1, 2, 3 ORDER BY snapshot_date DESC, n DESC LIMIT 30", [], env),
    ]);

    // Optional: ?unresolvedrows=1 — raw key fields of unresolved rows the resolver
    // would select (prior days only, mirrors its COALESCE filter). Debug aid for
    // diagnosing noData rows without direct DB access.
    let unresolvedRows = null;
    if (params.get("unresolvedrows") === "1") {
      const todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      unresolvedRows = await neonQuery(
        `SELECT id, sport, stat, game_type, direction, threshold, home_team, away_team,
                scoring_team, pick_team, game_date, game_time, snapshot_date, features
         FROM shadow_plays
         WHERE resolved = FALSE
           AND COALESCE(game_date, snapshot_date::varchar) < $1
         ORDER BY snapshot_date DESC, id
         LIMIT 30`,
        [todayPT], env
      ).catch((e) => [{ error: String(e?.message || e) }]);
    }

    return jsonResponse({
      ...(triggerResult !== null ? { trigger: triggerResult } : {}),
      ...(resolveResult !== null ? { resolve: resolveResult } : {}),
      tables: tables.map(r => r.tablename),
      shadow_plays: {
        total: Number(totals[0]?.total ?? 0),
        qualified: Number(totals[0]?.qualified ?? 0),
        resolved: Number(totals[0]?.resolved ?? 0),
        byDate,
        byCategory,
        dcDist,
        unresolvedByCategory,
        ...(unresolvedRows !== null ? { unresolvedRows } : {}),
      },
    });
  }

  // ── Shadow correlation analysis ────────────────────────────────────────────────────────────
  // GET /api/auth/shadow-analysis
  // Auth: Authorization: Bearer $ADMIN_KEY
  // Four analyses: threshold-rank ROI, intra-group unanimity, same-game pairwise phi, concentration.
  if (path === "auth/shadow-analysis" && method === "GET") {
    const saPayload = await verifyJWT(_extractToken(request), JWT_SECRET);
    const saAdminKey = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!saPayload && saAdminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
    if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL && !env?.DATABASE_URL_UNPOOLED) {
      return errorResponse("No Neon connection configured", 500);
    }

    const sinceDefault = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const since = params.get("since") || sinceDefault;

    // Repeat-fill diagnostic (2026-07-21): the maker engines (V1 sim + V2 real) re-quote a ticker
    // every cycle as long as it stays eligible, with no cap on CUMULATIVE fills on one ticker
    // within a session (MAKER_V2_SAME_GAME_CAP only bounds concurrently-resting orders). Ordering
    // V1's graded maker_fills by traded_at within (ticker, game_date) and bucketing by visit
    // number answers whether repeat fills on the same market carry the same edge as the first, or
    // decay/reverse (adverse selection as the market's information state moves).
    if (params.get("makerStacking")) {
      let seqRows, topStacks;
      try {
        seqRows = await neonQuery(`
          WITH f AS (
            SELECT mf.id, mf.pnl_cents, mf.side_won,
                   ROW_NUMBER() OVER (PARTITION BY mf.ticker, q.game_date ORDER BY mf.traded_at) AS seq
            FROM maker_fills mf JOIN maker_quotes q ON q.id = mf.quote_id
            WHERE mf.graded_at IS NOT NULL
          )
          SELECT CASE WHEN seq = 1 THEN '1st' WHEN seq = 2 THEN '2nd' WHEN seq = 3 THEN '3rd' ELSE '4th+' END AS bucket,
                 MIN(seq) AS seq_min, COUNT(*) AS n,
                 ROUND(AVG(pnl_cents)::numeric, 2) AS avg_pnl_cents,
                 ROUND(AVG(CASE WHEN side_won THEN 1.0 ELSE 0.0 END)::numeric, 4) AS win_rate
          FROM f GROUP BY bucket ORDER BY seq_min`, [], env);
        topStacks = await neonQuery(`
          SELECT q.ticker, q.game_date, q.sport, q.category, COUNT(*) AS n_fills,
                 ROUND(AVG(mf.pnl_cents)::numeric, 2) AS avg_pnl, SUM(mf.pnl_cents) AS total_pnl_cents
          FROM maker_fills mf JOIN maker_quotes q ON q.id = mf.quote_id
          WHERE mf.graded_at IS NOT NULL
          GROUP BY q.ticker, q.game_date, q.sport, q.category
          HAVING COUNT(*) >= 3
          ORDER BY n_fills DESC LIMIT 20`, [], env);
      } catch (e) { return errorResponse(`Neon query failed: ${e.message}`, 500); }
      return jsonResponse({
        note: "bucket = visit number of a graded fill on the same (ticker, game_date); n_fills>=3 tickers are the stacking cases",
        bySequence: (seqRows || []).map(r => ({ bucket: r.bucket, n: Number(r.n),
          avgPnlCents: r.avg_pnl_cents != null ? Number(r.avg_pnl_cents) : null,
          winRate: r.win_rate != null ? Number(r.win_rate) : null })),
        topStackedTickers: (topStacks || []).map(r => ({ ticker: r.ticker,
          gameDate: new Date(r.game_date).toISOString().slice(0, 10), sport: r.sport, category: r.category,
          nFills: Number(r.n_fills), avgPnlCents: Number(r.avg_pnl), totalPnlCents: Number(r.total_pnl_cents) })),
      });
    }

    // CLV-capture rate per snapshot_date (the cohort pregame-snap actually targets — see
    // shadow.js dataHealth). Diagnostic for "is ~30% daily capture chronic or a dip?" — if it's
    // flat across days the warn threshold (not the pipeline) is what's miscalibrated.
    if (params.get("clvCaptureHistory")) {
      let chRows;
      try {
        chRows = await neonQuery(`
          SELECT snapshot_date,
                 COUNT(*) AS eligible,
                 SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS captured
          FROM shadow_plays
          WHERE snapshot_date >= $1
          GROUP BY snapshot_date
          ORDER BY snapshot_date DESC`, [since], env);
      } catch (e) { return errorResponse(`Neon query failed: ${e.message}`, 500); }
      const days = (chRows || []).map(r => {
        const eligible = Number(r.eligible ?? 0);
        const captured = Number(r.captured ?? 0);
        return {
          date: new Date(r.snapshot_date).toISOString().slice(0, 10),
          eligible, captured,
          pct: eligible > 0 ? parseFloat((captured / eligible * 100).toFixed(1)) : null,
        };
      });
      const totElig = days.reduce((a, d) => a + d.eligible, 0);
      const totCap = days.reduce((a, d) => a + d.captured, 0);
      return jsonResponse({
        since, nDays: days.length,
        overallPct: totElig > 0 ? parseFloat((totCap / totElig * 100).toFixed(1)) : null,
        days,
      });
    }

    // CLV-capture forensics for ONE snapshot_date (?clvDay=YYYY-MM-DD). price_pre_at is set to
    // NOW() on each stamp, so its hour distribution shows WHICH of the 3 daily pregame-snap runs
    // (17:00 / 22:10 / 03:00 UTC) actually fired + how much each captured — a day with stamps in
    // only 1 bucket means 2 runs failed. The per-sport eligible/captured split shows WHICH
    // categories miss (late-listed shadow markets vs a whole-run failure).
    if (params.get("clvDay")) {
      const cd = params.get("clvDay");
      let byHour, bySport, tot;
      try {
        [byHour, bySport, tot] = await Promise.all([
          neonQuery(`
            SELECT to_char(date_trunc('hour', price_pre_at AT TIME ZONE 'UTC'), 'HH24') AS hr_utc,
                   COUNT(*) AS captured
            FROM shadow_plays WHERE snapshot_date = $1 AND price_pre_at IS NOT NULL
            GROUP BY 1 ORDER BY 1`, [cd], env),
          neonQuery(`
            SELECT sport,
                   COUNT(*) AS eligible,
                   SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS captured
            FROM shadow_plays WHERE snapshot_date = $1
            GROUP BY sport ORDER BY eligible DESC`, [cd], env),
          neonQuery(`
            SELECT COUNT(*) AS eligible,
                   SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS captured,
                   MIN(price_pre_at) AS first_stamp, MAX(price_pre_at) AS last_stamp
            FROM shadow_plays WHERE snapshot_date = $1`, [cd], env),
        ]);
      } catch (e) { return errorResponse(`Neon query failed: ${e.message}`, 500); }
      const t = tot?.[0] || {};
      const elig = Number(t.eligible ?? 0), cap = Number(t.captured ?? 0);
      return jsonResponse({
        day: cd,
        eligible: elig, captured: cap,
        pct: elig > 0 ? parseFloat((cap / elig * 100).toFixed(1)) : null,
        firstStamp: t.first_stamp ? new Date(t.first_stamp).toISOString() : null,
        lastStamp: t.last_stamp ? new Date(t.last_stamp).toISOString() : null,
        byHourUtc: (byHour || []).map(r => ({ hourUtc: r.hr_utc, captured: Number(r.captured) })),
        bySport: (bySport || []).map(r => {
          const e = Number(r.eligible), c = Number(r.captured ?? 0);
          return { sport: r.sport, eligible: e, captured: c, pct: e > 0 ? parseFloat((c / e * 100).toFixed(1)) : null };
        }),
      });
    }

    // Residual-by-dimension raw-row export (Phase 2 model triage). When ?residual=<sport|stat>
    // is set, return the raw resolved rows for ONE category (formula-floored via the caller's
    // `since`) so scripts/tune/residual-by-dimension.js can compute per-play residuals and slice
    // by every stored dimension (native cols + features JSONB) in JS — the dimension set varies
    // per category, so the flexible bucketing lives in the CLI, not SQL. Honesty population by
    // default: dc_qualified + threshold_rank=1. Knobs: dcQualified=0, thresholdRank=any|<n>,
    // priceMin/priceMax (bet-side).
    if (params.get("residual")) {
      const rCat = params.get("residual");
      const [rSport, rStat] = rCat.split("|");
      if (!rSport || !rStat) return errorResponse("residual requires category as 'sport|stat'", 400);
      const rDcQual = params.get("dcQualified") !== "0";
      const rRankRaw = params.get("thresholdRank"); // default '1'; 'any' to disable
      const rPriceMin = parseFloat(params.get("priceMin"));
      const rPriceMax = parseFloat(params.get("priceMax"));
      const betPctExpr = "CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END";

      const rWhere = [
        "resolved AND won IS NOT NULL",
        "snapshot_date >= $1",
        "sport = $2",
        "COALESCE(stat, game_type) = $3",
      ];
      const rParams = [since, rSport, rStat];
      if (rDcQual) rWhere.push("dc_qualified");
      const rankVal = rRankRaw == null ? 1 : (rRankRaw === "any" ? null : parseInt(rRankRaw, 10));
      if (rankVal != null && Number.isFinite(rankVal)) {
        rParams.push(rankVal);
        rWhere.push(`threshold_rank = $${rParams.length}`);
      }
      if (Number.isFinite(rPriceMin)) { rParams.push(rPriceMin); rWhere.push(`(${betPctExpr}) >= $${rParams.length}`); }
      if (Number.isFinite(rPriceMax)) { rParams.push(rPriceMax); rWhere.push(`(${betPctExpr}) <= $${rParams.length}`); }

      const rSql = `
        SELECT model_true_pct, won, direction, kalshi_pct, no_kalshi_pct, edge, threshold,
               home_team, away_team, pick_team, scoring_team, game_date, snapshot_date, features
        FROM shadow_plays
        WHERE ${rWhere.join(" AND ")}
        ORDER BY snapshot_date`;
      let rRows;
      try { rRows = await neonQuery(rSql, rParams, env); }
      catch (e) { return errorResponse(`Neon query failed: ${e.message}`, 500); }
      const rOut = (rRows || []).map(r => ({
        ...r,
        features: typeof r.features === "string"
          ? (() => { try { return JSON.parse(r.features); } catch { return null; } })()
          : (r.features || null),
      }));
      return jsonResponse({ category: rCat, since, n: rOut.length, rows: rOut });
    }

    // capRoi knobs: capGate=0 drops the category gate (broaden to the dc+edge universe across
    // all categories for sample size); capEdge sets the edge floor (default 5 = client gate).
    const capGate = params.get("capGate") !== "0";
    const capEdge = Number.isFinite(parseFloat(params.get("capEdge"))) ? parseFloat(params.get("capEdge")) : 5;
    // capWindow=1: instead of the category gate, restrict to the Kalshi qualification window
    // (bet-side price 67–91) — the representative bettable universe, excluding ~50/50 noise.
    const capWindow = params.get("capWindow") === "1";

    // Q1: ROI and calibration by threshold_rank.
    // threshold_rank=1 is closest to 50% (most informative) for a given group.
    const q1 = neonQuery(`
      SELECT
        COALESCE(threshold_rank::text, 'null') AS threshold_rank,
        COUNT(*) AS n,
        SUM(won::int) AS wins,
        ROUND(AVG(CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END) / 100.0, 4) AS avg_bet_price,
        ROUND(SUM(won::int)::numeric / COUNT(*) * 100, 1) AS hit_rate_pct,
        ROUND(SUM(won::int)::numeric / COUNT(*) - AVG(CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END) / 100.0, 4) AS roi
      FROM shadow_plays
      WHERE resolved AND won IS NOT NULL AND snapshot_date >= $1
      GROUP BY threshold_rank
      ORDER BY threshold_rank NULLS LAST
    `, [since], env);

    // Q2: Intra-group unanimity — within alt-line groups (group_size > 1), what % of groups
    // resolved unanimously (all thresholds won or all lost)? High unanimity = correlated bets.
    const q2 = neonQuery(`
      WITH group_outcomes AS (
        SELECT
          group_id,
          sport,
          COALESCE(stat, game_type) AS category,
          COUNT(*) AS n,
          SUM(won::int) AS wins
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND snapshot_date >= $1 AND group_size > 1
        GROUP BY group_id, sport, COALESCE(stat, game_type)
        HAVING COUNT(*) > 1
      )
      SELECT
        sport,
        category,
        COUNT(*) AS n_groups,
        SUM(n) AS n_plays,
        ROUND(AVG(n), 1) AS avg_group_size,
        COUNT(*) FILTER (WHERE wins = n) AS all_win,
        COUNT(*) FILTER (WHERE wins = 0) AS all_lose,
        ROUND((COUNT(*) FILTER (WHERE wins = n) + COUNT(*) FILTER (WHERE wins = 0))::numeric / COUNT(*) * 100, 1) AS pct_unanimous
      FROM group_outcomes
      GROUP BY sport, category
      ORDER BY n_groups DESC
    `, [since], env);

    // Q3: Same-game pairwise phi correlation — for every pair of (category|direction) that
    // appear in the same game, compute phi = (P(AB) − P(A)P(B)) / sqrt(P(A)(1-P(A))P(B)(1-P(B))).
    // Uses threshold_rank = 1 only to avoid double-counting multi-threshold groups.
    // HAVING n >= 10 filters noise. Ordered by |phi| descending.
    const q3 = neonQuery(`
      WITH game_plays AS (
        SELECT
          sport || '|' || COALESCE(home_team, '') || '|' || COALESCE(away_team, '') || '|' || COALESCE(game_date, snapshot_date::text) AS game_key,
          sport,
          COALESCE(stat, game_type) || '|' || COALESCE(direction, '') AS cat_dir,
          won::int AS w
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL
          AND snapshot_date >= $1
          AND threshold_rank = 1
          AND home_team IS NOT NULL AND away_team IS NOT NULL
      ),
      pairs AS (
        SELECT
          a.sport,
          a.cat_dir AS cat_a,
          b.cat_dir AS cat_b,
          COUNT(*) AS n,
          SUM(a.w) AS wins_a,
          SUM(b.w) AS wins_b,
          SUM(a.w * b.w) AS joint_wins
        FROM game_plays a
        JOIN game_plays b ON b.game_key = a.game_key AND b.cat_dir > a.cat_dir
        GROUP BY a.sport, a.cat_dir, b.cat_dir
        HAVING COUNT(*) >= 10
      )
      SELECT
        sport, cat_a, cat_b,
        n,
        ROUND(wins_a::numeric / n * 100, 1) AS hit_a,
        ROUND(wins_b::numeric / n * 100, 1) AS hit_b,
        ROUND(joint_wins::numeric / n * 100, 1) AS joint_hit,
        ROUND(
          (joint_wins::numeric/n - (wins_a::numeric/n) * (wins_b::numeric/n)) /
          NULLIF(SQRT(
            (wins_a::numeric/n * (1 - wins_a::numeric/n)) *
            (wins_b::numeric/n * (1 - wins_b::numeric/n))
          ), 0)
        , 3) AS phi
      FROM pairs
      ORDER BY ABS(
        (joint_wins::numeric/n - (wins_a::numeric/n) * (wins_b::numeric/n)) /
        NULLIF(SQRT(
          (wins_a::numeric/n * (1 - wins_a::numeric/n)) *
          (wins_b::numeric/n * (1 - wins_b::numeric/n))
        ), 0)
      ) DESC NULLS LAST
      LIMIT 30
    `, [since], env);

    // Q4: Concentration distribution — for games with ≥1 play, how many plays per game?
    // Hit rate by concentration bucket tells us whether same-game plays co-move.
    const q4 = neonQuery(`
      WITH game_counts AS (
        SELECT
          sport || '|' || COALESCE(home_team, '') || '|' || COALESCE(away_team, '') || '|' || COALESCE(game_date, snapshot_date::text) AS game_key,
          COUNT(*) AS n_plays,
          SUM(won::int) AS wins
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL
          AND snapshot_date >= $1
          AND threshold_rank = 1
          AND home_team IS NOT NULL AND away_team IS NOT NULL
        GROUP BY game_key
      )
      SELECT
        n_plays,
        COUNT(*) AS n_games,
        SUM(n_plays) AS total_plays,
        SUM(wins) AS total_wins,
        ROUND(SUM(wins)::numeric / SUM(n_plays) * 100, 1) AS hit_rate_pct
      FROM game_counts
      GROUP BY n_plays
      ORDER BY n_plays
    `, [since], env);

    // Q5: CLV (closing line value) — per-category avg line movement between 3pm snapshot
    // and 7pm pre-game stamp. Positive clv_pct = market moved toward model prediction.
    // Only includes rows with price_pre_at populated (post-pregame-snap cron).
    const q5 = neonQuery(`
      SELECT
        sport,
        COALESCE(stat, game_type) AS category,
        COUNT(*) AS n,
        ROUND(AVG(
          CASE WHEN direction = 'under'
            THEN (kalshi_no_price_pre  - kalshi_no_price)  * 100
            ELSE (kalshi_yes_price_pre - kalshi_yes_price) * 100
          END
        ), 2) AS avg_clv_pct,
        ROUND(AVG(
          CASE WHEN direction = 'under'
            THEN (model_true_pct / 100.0 - 1 + kalshi_no_price_pre)  * -100
            ELSE (model_true_pct / 100.0   - kalshi_yes_price_pre)   * 100
          END
        ), 2) AS avg_edge_at_close,
        ROUND(AVG(
          CASE WHEN direction = 'under'
            THEN (model_true_pct / 100.0 - 1 + kalshi_no_price)  * -100
            ELSE (model_true_pct / 100.0   - kalshi_yes_price)   * 100
          END
        ), 2) AS avg_edge_at_snap,
        ROUND(AVG(won::int) * 100, 1) AS hit_rate_pct
      FROM shadow_plays
      WHERE resolved AND won IS NOT NULL
        AND snapshot_date >= $1
        AND threshold_rank = 1
        AND kalshi_yes_price_pre IS NOT NULL
      GROUP BY sport, COALESCE(stat, game_type)
      HAVING COUNT(*) >= 5
      ORDER BY n DESC
    `, [since], env);

    // Q6: Daily volume vs ROI — group resolved plays by snapshot_date, then bucket by
    // plays-per-day to reveal whether high-volume days help or hurt realised ROI.
    // threshold_rank=1 deduplicates alt-line groups so each player/game counts once.
    const q6 = neonQuery(`
      WITH daily AS (
        SELECT
          snapshot_date,
          COUNT(*) AS n_plays,
          SUM(won::int) AS wins,
          AVG(CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END) / 100.0 AS avg_price
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND snapshot_date >= $1 AND threshold_rank = 1
        GROUP BY snapshot_date
      )
      SELECT
        CASE
          WHEN n_plays <= 2  THEN '1-2'
          WHEN n_plays <= 4  THEN '3-4'
          WHEN n_plays <= 6  THEN '5-6'
          WHEN n_plays <= 9  THEN '7-9'
          ELSE '10+'
        END AS picks_bucket,
        CASE
          WHEN n_plays <= 2  THEN 1
          WHEN n_plays <= 4  THEN 2
          WHEN n_plays <= 6  THEN 3
          WHEN n_plays <= 9  THEN 4
          ELSE 5
        END AS bucket_order,
        COUNT(*) AS n_days,
        SUM(n_plays) AS total_plays,
        ROUND(AVG(n_plays), 1) AS avg_plays,
        ROUND(SUM(wins)::numeric / SUM(n_plays) * 100, 1) AS hit_rate_pct,
        ROUND(AVG(avg_price) * 100, 1) AS avg_price_pct,
        ROUND((SUM(wins)::numeric / SUM(n_plays)) - AVG(avg_price), 4) AS roi
      FROM daily
      GROUP BY picks_bucket, bucket_order
      ORDER BY bucket_order
    `, [since], env);

    // Q7: Same-game cap ROI — among the *gated bet set* (dc_qualified, edge≥5, passes the
    // category-gate truePct bands), group picks by a prop-aware + order-normalised game key
    // (props store team identity in home_team/away_team as playerTeam|opponent, games as the
    // actual home|away — LEAST/GREATEST sorts both into one key so a prop and the spread/total
    // of the same game collide), dedup alt-lines via threshold_rank=1, rank within each game by
    // edge DESC, and report ROI per within-game rank. multi=false (rnk 0) is the solo-game
    // baseline; multi=true rows reveal whether the 2nd/3rd-best-edge pick in a game adds or
    // destroys ROI. Cumulative cap ROI is derived in JS from these disjoint rank buckets.
    const q7 = neonQuery(`
      WITH gated AS (
        SELECT
          edge,
          won::int AS w,
          CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END AS bet_pct,
          sport || '|' || LEAST(home_team, away_team) || '|' || GREATEST(home_team, away_team)
            || '|' || COALESCE(game_date, snapshot_date::text) AS game_key
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND dc_qualified AND edge >= ${capEdge}
          AND threshold_rank = 1
          AND home_team IS NOT NULL AND away_team IS NOT NULL
          AND snapshot_date >= $1
          ${capWindow ? `AND (CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END) BETWEEN 67 AND 91` : ``}
          ${(capGate && !capWindow) ? `AND (
               (sport = 'mlb'  AND stat = 'strikeouts' AND model_true_pct >= 80 AND model_true_pct < 85)
            OR (sport = 'wnba' AND stat = 'points'      AND model_true_pct >= 70 AND model_true_pct < 80)
            OR (sport = 'wnba' AND stat = 'rebounds'    AND model_true_pct >= 70 AND model_true_pct < 85)
            OR (sport = 'wnba' AND game_type = 'spread'
                  AND (CASE WHEN direction = 'under' THEN 100 - model_true_pct ELSE model_true_pct END) >= 65
                  AND (CASE WHEN direction = 'under' THEN 100 - model_true_pct ELSE model_true_pct END) <  85)
          )` : ``}
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY game_key ORDER BY edge DESC, bet_pct ASC) AS rnk,
          COUNT(*)     OVER (PARTITION BY game_key) AS game_n
        FROM gated
      )
      SELECT
        (game_n > 1) AS multi,
        CASE WHEN game_n > 1 THEN rnk ELSE 0 END AS rnk,
        COUNT(*) AS n,
        ROUND(100.0 * AVG(w), 1) AS hit_rate,
        ROUND(AVG(bet_pct), 1) AS avg_price,
        ROUND(100.0 * AVG(w) - AVG(bet_pct), 2) AS roi_pct
      FROM ranked
      GROUP BY 1, 2
      ORDER BY 1, 2
    `, [since], env);

    // Q8: ROI by EDGE band — does higher model edge actually predict higher realised ROI,
    // and where does it cross zero? Over the bettable universe (dc_qualified, threshold_rank=1,
    // bet-side price inside the 67–91 qualification window, all categories for sample size),
    // bucket by edge incl. negative bands so the full gradient shows. This is the rigorous
    // answer to "should we bet every qualified pick": if ROI stays positive down to the edge
    // gate, volume is fine and there's no daily cap; if it crosses zero ABOVE the gate, the
    // gate is too loose — a calibration cutoff, NOT a daily-count limit. (capWindow/capGate
    // knobs ignored here — Q8 fixes its own representative universe so the gradient is stable.)
    const q8 = neonQuery(`
      WITH bettable AS (
        SELECT edge, won::int AS w,
          CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END AS bet_pct
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND dc_qualified AND threshold_rank = 1
          AND snapshot_date >= $1
          AND (CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END) BETWEEN 67 AND 91
      )
      SELECT
        CASE
          WHEN edge < 0  THEN '<0'   WHEN edge < 3  THEN '0-3'   WHEN edge < 5  THEN '3-5'
          WHEN edge < 7  THEN '5-7'  WHEN edge < 10 THEN '7-10'  WHEN edge < 15 THEN '10-15'
          WHEN edge < 20 THEN '15-20' ELSE '20+'
        END AS edge_band,
        CASE
          WHEN edge < 0 THEN 0 WHEN edge < 3 THEN 1 WHEN edge < 5 THEN 2 WHEN edge < 7 THEN 3
          WHEN edge < 10 THEN 4 WHEN edge < 15 THEN 5 WHEN edge < 20 THEN 6 ELSE 7
        END AS band_order,
        COUNT(*) AS n,
        ROUND(100.0 * AVG(w), 1) AS hit_rate_pct,
        ROUND(AVG(bet_pct), 1) AS avg_price_pct,
        ROUND(100.0 * AVG(w) - AVG(bet_pct), 2) AS roi_pct
      FROM bettable
      GROUP BY edge_band, band_order
      ORDER BY band_order
    `, [since], env);

    let [thresholdRankRoi, intraGroupCorr, sameGamePairs, concentration, clvAnalysis, dailyVolumeRoi, capRoi, edgeBucketRoiRaw] = await Promise.all([q1, q2, q3, q4, q5, q6, q7, q8]).catch(e => {
      return [{ error: e.message }];
    });

    if (thresholdRankRoi?.error) return errorResponse(`Neon query failed: ${thresholdRankRoi.error}`, 500);

    // Attach a 95% CI on each edge band's ROI (normal approx on the hit rate) — a band's ROI
    // is only trustworthy when its CI clears 0, the read we need to find where edge stops paying.
    const edgeBucketRoi = Array.isArray(edgeBucketRoiRaw) ? edgeBucketRoiRaw.map(r => {
      const n = Number(r.n || 0);
      const hit = Number(r.hit_rate_pct || 0) / 100;
      const roi = r.roi_pct != null ? Number(r.roi_pct) : null;
      const se = n > 0 ? Math.sqrt(hit * (1 - hit) / n) * 100 : null;
      return {
        ...r, n,
        roiLoCI: (roi != null && se != null) ? parseFloat((roi - 1.96 * se).toFixed(2)) : null,
        roiHiCI: (roi != null && se != null) ? parseFloat((roi + 1.96 * se).toFixed(2)) : null,
      };
    }) : edgeBucketRoiRaw;

    return jsonResponse({ since, thresholdRankRoi, intraGroupCorr, sameGamePairs, concentration, clvAnalysis, dailyVolumeRoi, capRoi, edgeBucketRoi });
  }

  return null;
}
