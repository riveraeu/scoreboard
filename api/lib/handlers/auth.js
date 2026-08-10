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

    let tableSizes = null;
    if (params.get("tablesizes") === "1") {
      tableSizes = await neonQuery(
        `SELECT relname AS table_name,
                pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
                pg_total_relation_size(relid) AS total_bytes,
                pg_size_pretty(pg_relation_size(relid)) AS table_size,
                pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS index_size,
                n_live_tup AS row_count
         FROM pg_stat_user_tables
         ORDER BY total_bytes DESC`,
        [], env
      ).catch(e => [{ error: String(e.message) }]);
      const [dbSize] = await neonQuery(
        "SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size",
        [], env
      ).catch(() => [{}]);
      tableSizes = { tables: tableSizes, db_size: dbSize?.db_size };
    }

    return jsonResponse({
      ...(triggerResult !== null ? { trigger: triggerResult } : {}),
      ...(resolveResult !== null ? { resolve: resolveResult } : {}),
      ...(tableSizes !== null ? { tableSizes } : {}),
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

  return null;
}
