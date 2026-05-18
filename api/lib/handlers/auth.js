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

import { errorResponse, jsonResponse } from "../utils.js";
import { pbkdf2Hash, makeJWT, verifyJWT } from "../auth-utils.js";

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
    return jsonResponse({ token, userId, email });
  }

  if (path === "auth/login" && method === "POST") {
    const { email, password } = await request.json();
    const userStr = await CACHE2.get(`user:${email.toLowerCase()}`);
    if (!userStr) return errorResponse("Invalid credentials", 401);
    const user = JSON.parse(userStr);
    const hash = await pbkdf2Hash(password, user.salt);
    if (hash !== user.passwordHash) return errorResponse("Invalid credentials", 401);
    const token = await makeJWT({ userId: user.id, email: user.email, exp: Date.now() + 365 * 24 * 60 * 60 * 1e3 }, JWT_SECRET);
    return jsonResponse({ token, userId: user.id, email: user.email });
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
    const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    const payload = await verifyJWT(token, JWT_SECRET);
    if (!payload) return errorResponse("Unauthorized", 401);
    const data = await CACHE2.get(`picks:${payload.userId}`, "json");
    return jsonResponse(data || { picks: [], bankroll: 1e3 });
  }

  if (path === "user/picks" && method === "POST") {
    const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    const payload = await verifyJWT(token, JWT_SECRET);
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
    const calibToken = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    const calibPayload = calibToken ? await verifyJWT(calibToken, JWT_SECRET) : null;
    const calibAdminKey = params.get("adminKey");
    if (!calibPayload && calibAdminKey !== env?.ADMIN_KEY) return errorResponse("Forbidden", 403);
    const upUrl = env?.UPSTASH_REDIS_REST_URL;
    const upAuth = `Bearer ${env?.UPSTASH_REDIS_REST_TOKEN}`;
    if (!upUrl) return errorResponse("No Redis URL", 500);
    // Optional filter: ?modelVersion=v1|v2|all (default "all"). Picks tracked before the
    // version toggle landed have no `modelVersion` field and are treated as v1 for grouping.
    const _calibModelFilter = (params.get("modelVersion") || "all").toLowerCase();
    const _normModelV = (p) => p.modelVersion === "v2" ? "v2" : "v1";
    const keysRes = await fetch(upUrl, { method: "POST", headers: { Authorization: upAuth, "Content-Type": "application/json" }, body: JSON.stringify(["KEYS", "picks:*"]) });
    const { result: picksKeys } = await keysRes.json();
    if (!picksKeys || picksKeys.length === 0) return jsonResponse({ totalPicks: 0, finalizedPicks: 0, overall: [], byCategory: {}, byModelVersion: { v1: { n: 0, finalized: 0 }, v2: { n: 0, finalized: 0 } } });
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
    const allPicks = _calibModelFilter === "all"
      ? _allPicksRaw
      : _allPicksRaw.filter(p => _normModelV(p) === (_calibModelFilter === "v2" ? "v2" : "v1"));
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
      return {
        bucket: b.label,
        predicted: (b.min + Math.min(b.max, 100)) / 2,
        actual: inBucket.length > 0 ? parseFloat((wins / inBucket.length * 100).toFixed(1)) : null,
        n: inBucket.length,
        delta: inBucket.length > 0 ? parseFloat((wins / inBucket.length * 100 - (b.min + Math.min(b.max, 100)) / 2).toFixed(1)) : null,
      };
    });
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
    return jsonResponse({ totalPicks: allPicks.length, finalizedPicks: finalized.length, overall, byCategory, byCategoryDetail, byModelVersion, modelFilter: _calibModelFilter, kStrikeouts: { bySimScore, byKpctPts, byKTrendPts, byStdBF, n: ksFinalized.length } });
  }

  return null;
}
