import { ALLOWED_ORIGIN, corsHeaders, jsonResponse, errorResponse } from "./lib/utils.js";
import { warmPlayerInfoCache, buildNbaDvpStage1, buildNbaDvpFromBettingPros, buildNbaDvpStage3FG } from "./lib/nba.js";
import { handleAuthRoutes } from "./lib/handlers/auth.js";
import { handlePlayerRoutes } from "./lib/handlers/player.js";
import { handleSportsRoutes } from "./lib/handlers/sports.js";
import { handleDvpRoutes } from "./lib/handlers/dvp.js";
import { handleKalshiRoutes } from "./lib/handlers/kalshi.js";
import { handleTonightRoute } from "./lib/handlers/tonight.js";
import { handleShadowRoutes } from "./lib/handlers/shadow.js";

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
      },
      // Atomically increment a counter and set its TTL on the first increment.
      // Used for rate limiting (INCR + EXPIRE only fires EXPIRE when count === 1).
      async incrWithTtl(key, ttlSec) {
        const { result: count } = await cmd("INCR", key);
        if (count === 1) await cmd("EXPIRE", key, ttlSec);
        return count ?? 1;
      },
    };
  }
  try { return CACHE || null; } catch { return null; }
}
__name(makeCache, "makeCache");
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
// pbkdf2Hash / makeJWT / verifyJWT live in ./lib/auth-utils.js (used by handlers/auth.js
// and indirectly by handlers/tonight.js for the calibration JWT check).
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
      // Extracted handler modules — each returns a Response on path match or null to fall through.
      const _authResp = await handleAuthRoutes({ path, method, request, params, env, CACHE2, JWT_SECRET });
      if (_authResp) return _authResp;
      const _playerResp = await handlePlayerRoutes({
        path, method, request, params, env, CACHE2, runtimeCtx: ctx,
        warmFn: warmPlayerInfoCache, makeCacheFn: makeCache,
        ESPN_BASE, ESPN_CORE, ALLOWED_ORIGIN, jsonResponse, errorResponse,
      });
      if (_playerResp) return _playerResp;
      const _sportsResp = await handleSportsRoutes({ path, method, params, env, CACHE2, VALID_SPORTS });
      if (_sportsResp) return _sportsResp;
      const _dvpResp = await handleDvpRoutes({ path, params, CACHE2, runtimeCtx: ctx, ESPN_CORE, jsonResponse, errorResponse });
      if (_dvpResp) return _dvpResp;
      const _kalshiResp = await handleKalshiRoutes({ path, request, params, env, CACHE2, method, JWT_SECRET });
      if (_kalshiResp) return _kalshiResp;
      const _tonightResp = await handleTonightRoute({ path, params, request, env, CACHE2, runtimeCtx: ctx });
      if (_tonightResp) return _tonightResp;
      const _shadowResp = await handleShadowRoutes({ path, request, env });
      if (_shadowResp) return _shadowResp;
      return errorResponse("Unknown route: " + path, 404);
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
    CRON_SECRET: process.env.CRON_SECRET,
    KALSHI_API_KEY_ID: process.env.KALSHI_API_KEY_ID,
    KALSHI_PRIVATE_KEY: process.env.KALSHI_PRIVATE_KEY,
    POSTGRES_URL: process.env.POSTGRES_URL,
    NEON_DATABASE_URL: process.env.NEON_DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING,
  };
  const ctx = { waitUntil: (p) => { try { p.catch?.(() => {}); } catch {} } };
  return worker_default.fetch(request, env, ctx);
}
