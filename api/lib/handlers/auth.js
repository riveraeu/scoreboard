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

import { errorResponse, jsonResponse, cookieResponse } from "../utils.js";
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
    const calibAdminKey = params.get("adminKey");
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
  // Auth: bearer JWT (same as /api/auth/calibration) or ?adminKey=
  // Returns overall/byCategory/byCategoryDetail calibration across ALL model predictions
  // (no edge gate, no dc gate) so categories can be promoted to passesCategoryGate()
  // when ROI > 0 at 90% CI with n ≥ 200.
  if (path === "auth/shadow-calibration" && method === "GET") {
    const scPayload = await verifyJWT(_extractToken(request), JWT_SECRET);
    const scAdminKey = params.get("adminKey");
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
    if (params.get("thresholdRank") === "1") whereParts.push("threshold_rank = 1");
    const _stStr = params.get("seasonType");
    if (_stStr) {
      const _st = parseInt(_stStr, 10);
      if (!isNaN(_st)) whereParts.push(`season_type = ${_p(_st)}`);
    }
    const bestThreshold = params.get("bestThreshold") === "true";

    const whereClause = whereParts.join(" AND ");

    // bet_side_pct (bsp): P(bet wins) from model's perspective.
    // model_true_pct is always OVER-side. For UNDERs: P(under wins) = 1 - model_true_pct.
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
    CASE WHEN direction = 'under' THEN (1 - model_true_pct) ELSE model_true_pct END AS bsp,
    (won)::int AS w,
    CASE WHEN direction = 'under' THEN no_kalshi_pct ELSE kalshi_pct END AS bet_pct,
    edge
  FROM shadow_plays
  WHERE ${whereClause}
),
${bestThreshold ? `
best AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY sport, category, group_id ORDER BY bsp DESC
  ) AS _rn FROM base
),
source AS (SELECT sport, category, bsp, w, bet_pct, edge FROM best WHERE _rn = 1),
` : `source AS (SELECT sport, category, bsp, w, bet_pct, edge FROM base),`}
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
    COUNT(*) AS n, SUM(w) AS wins, AVG(bet_pct) AS avg_bet_pct, AVG(edge) AS avg_edge
  FROM banded GROUP BY band
),
by_cat AS (
  SELECT 'cat'::text AS type, sport, category, NULL::text AS band,
    COUNT(*) AS n, SUM(w) AS wins, AVG(bet_pct) AS avg_bet_pct, AVG(edge) AS avg_edge
  FROM banded GROUP BY sport, category
),
by_cat_band AS (
  SELECT 'cat_band'::text AS type, sport, category, band,
    COUNT(*) AS n, SUM(w) AS wins, AVG(bet_pct) AS avg_bet_pct, AVG(edge) AS avg_edge
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
      return { n, wins, actual, predicted, delta, roi, avgEdge, avgBetPct };
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
        return [key, { n: c.n, hitRate: c.actual, roi: c.roi, avgEdge: c.avgEdge }];
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
      },
      overall: scOverall,
      byCategory: scByCategory,
      byCategoryDetail: scByCategoryDetail,
    });
  }

  if (path === "auth/shadow-stats" && method === "GET") {
    const ak = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!env?.ADMIN_KEY) return errorResponse("ADMIN_KEY not set", 500);
    if (ak !== env.ADMIN_KEY) return errorResponse("Forbidden", 403);

    // Optional: ?trigger=1 runs the shadow-snapshot cron inline before returning stats.
    let triggerResult = null;
    if (params.get("trigger") === "1" && env?.CRON_SECRET) {
      const origin = new URL(request.url).origin;
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
      const origin = new URL(request.url).origin;
      try {
        const tr = await fetch(`${origin}/api/shadow-resolver`, {
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

    const [totals, byDate, byCategory, dcDist] = await Promise.all([
      neonQuery("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE dc_qualified) as qualified, COUNT(*) FILTER (WHERE resolved) as resolved FROM shadow_plays", [], env),
      neonQuery("SELECT snapshot_date, COUNT(*) as n FROM shadow_plays GROUP BY 1 ORDER BY 1 DESC LIMIT 7", [], env),
      neonQuery("SELECT sport, COALESCE(stat, game_type, '?') as category, COUNT(*) as n, COUNT(*) FILTER (WHERE dc_qualified) as qualified FROM shadow_plays GROUP BY 1, 2 ORDER BY n DESC LIMIT 20", [], env),
      neonQuery("SELECT dc, COUNT(*) as n FROM shadow_plays GROUP BY 1 ORDER BY 1 DESC NULLS LAST", [], env),
    ]);

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
      },
    });
  }

  return null;
}
