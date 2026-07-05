import { waitUntil } from "@vercel/functions";
import { ALLOWED_ORIGIN, corsHeaders, jsonResponse, errorResponse } from "./lib/utils.js";
import { warmPlayerInfoCache } from "./lib/nba.js";
import { handleAuthRoutes } from "./lib/handlers/auth.js";
import { handlePlayerRoutes } from "./lib/handlers/player.js";
import { handleSportsRoutes } from "./lib/handlers/sports.js";
import { handleDvpRoutes } from "./lib/handlers/dvp.js";
import { handleKalshiRoutes } from "./lib/handlers/kalshi.js";
import { handleTonightRoute } from "./lib/handlers/tonight.js";
import { handleShadowRoutes } from "./lib/handlers/shadow.js";
import { handlePushRoutes } from "./lib/handlers/push.js";
import { gzipToString, gunzipFromString, GZ_PREFIX } from "./lib/kv-compress.js";

// Transparently gzip any KV value larger than this so a single SET never approaches Upstash's
// 10MB request cap. Small values (the vast majority) are stored raw — compression only kicks in
// for the few consolidated blobs (shadow:staging, byteam:*, big kalshi:stale:*). Reads
// auto-detect the gz: marker and decompress, so callers are unaffected. See api/lib/kv-compress.js.
const KV_COMPRESS_THRESHOLD = 256 * 1024;

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
    }).then(async (r) => {
      // Surface failures instead of swallowing them. A >10MB request (e.g. an oversized SET)
      // comes back as a non-OK status with a non-JSON body, which the old `.then(r=>r.json())`
      // path turned into a silent {result:null} — that hid byteam:mlb's 413 for weeks.
      if (!r.ok) { console.error("[upstash] HTTP", r.status, args[0]); return { result: null, error: `HTTP ${r.status}` }; }
      const body = await r.json().catch(() => null);
      if (body?.error) console.error("[upstash]", args[0], body.error);
      return body ?? { result: null };
    }).catch((e) => { console.error("[upstash] fetch failed", args[0], String(e?.message || e), String(e?.cause?.code || e?.cause?.message || e?.cause || "")); return { result: null }; }), "cmd");
    return {
      async get(key, type) {
        const { result } = await cmd("GET", key);
        if (result == null) return null;
        let s = result;
        if (typeof s === "string" && s.startsWith(GZ_PREFIX)) {
          try { s = await gunzipFromString(s); } catch { return null; }
        }
        if (type === "json") {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        }
        return s;
      },
      // Batched read: one MGET per chunk instead of N parallel GETs. The per-player cache
      // reads in the tonight pipeline (100+ keys) each opened their own Upstash connection,
      // feeding the FD-exhaustion cascade (see pLimit in lib/utils.js). Chunked at 20 keys
      // so a batch of large raw values (gamelogs run 50-200KB) can't approach the 10MB cap.
      // Never throws: failed chunks yield nulls, matching the .catch(() => null) callers used.
      async getMany(keys, type) {
        const out = new Array(keys.length).fill(null);
        const CHUNK = 20;
        const chunks = [];
        for (let i = 0; i < keys.length; i += CHUNK) chunks.push(i);
        await Promise.all(chunks.map(async (start) => {
          const slice = keys.slice(start, start + CHUNK);
          const { result } = await cmd("MGET", ...slice);
          if (!Array.isArray(result)) return;
          for (let j = 0; j < slice.length; j++) {
            let s = result[j];
            if (s == null) continue;
            if (typeof s === "string" && s.startsWith(GZ_PREFIX)) {
              try { s = await gunzipFromString(s); } catch { continue; }
            }
            if (type === "json") {
              try { out[start + j] = JSON.parse(s); } catch { /* leave null */ }
            } else {
              out[start + j] = s;
            }
          }
        }));
        return out;
      },
      async put(key, value, opts = {}) {
        let v = typeof value === "string" ? value : JSON.stringify(value);
        if (v.length > KV_COMPRESS_THRESHOLD) {
          try { v = await gzipToString(v); }
          catch (e) { console.error("[upstash] compress failed, storing raw:", key, String(e?.message || e)); }
        }
        const args = ["SET", key, v];
        if (opts.expirationTtl) args.push("EX", opts.expirationTtl);
        await cmd(...args);
      },
      async delete(key) {
        await cmd("DEL", key);
      },
      // Atomically increment a counter and set its TTL on the first increment.
      // On subsequent increments, check TTL and heal any key that survived without one
      // (e.g. a prior INCR completed but EXPIRE timed out), preventing permanent lockout.
      async incrWithTtl(key, ttlSec) {
        const { result: count } = await cmd("INCR", key);
        if (count === 1) {
          await cmd("EXPIRE", key, ttlSec);
        } else {
          const { result: ttl } = await cmd("TTL", key);
          if (ttl < 0) await cmd("EXPIRE", key, ttlSec);
        }
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
// NOTE: a Cloudflare-Workers-style `scheduled()` DvP staging handler lived here until
// 2026-06-11 — it was dead code on Vercel (only the default-export fetch handler runs;
// no vercel.json cron targeted it). NBA DvP is covered by the lazy build in
// handlers/tonight.js, on-demand byteam builds in /api/dvp, and the manual
// /api/dvp/rebuild-pos?stage=N endpoints. Before NBA season (Oct), consider adding real
// vercel.json crons hitting /api/dvp/rebuild-pos to pre-warm instead of relying on lazy build.
var worker_default = {
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
      const _shadowResp = await handleShadowRoutes({ path, request, env, cache: CACHE2 });
      if (_shadowResp) return _shadowResp;
      const _pushResp = await handlePushRoutes({ path, method, request, env, CACHE2, JWT_SECRET });
      if (_pushResp) return _pushResp;
      return errorResponse("Unknown route: " + path, 404);
    } catch (e) {
      return errorResponse(e.message, 500);
    }
  }
};

// Node runtime (Fluid Compute) since 2026-06-11 — was `runtime: 'edge'`, maxDuration 60.
// All handler code is Web-API style (fetch/Request/Response/crypto.subtle/btoa — Node 20
// globals). maxDuration is set in vercel.json (`functions` block). The 60s Edge wall
// behind the shadow-snapshot/pregame KV-staging workarounds is gone; staging stays
// because it's faster anyway.
//
// IMPORTANT: Vercel invokes plain api/ Node functions with the CLASSIC signature
// (IncomingMessage, ServerResponse) — req.url is path-only, so the worker's
// `new URL(request.url)` throws Invalid URL without adaptation. The first migration
// attempt assumed web-handler auto-detection and 500'd every route
// (FUNCTION_INVOCATION_FAILED, rolled back 2026-06-11). This adapter bridges
// Node req/res ↔ the Web Request/Response the worker expects, and keeps a
// pass-through branch in case the platform ever sends a web Request.
function _envFromProcess() {
  return {
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
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    ROUTINE_NOTE_TOKEN: process.env.ROUTINE_NOTE_TOKEN, // routine-note scratchpad write gate (handlers/shadow.js)
    THE_ODDS_API_KEY: process.env.THE_ODDS_API_KEY,     // sharp-book reference feed (api/lib/sportsbook.js)
  };
}

export default async function handler(req, res) {
  const env = _envFromProcess();
  // Real waitUntil (was a fire-and-forget shim on Edge): background work queued via
  // runtimeCtx.waitUntil (DvP rebuilds, cache warms) now survives the response.
  const ctx = {
    waitUntil: (p) => {
      try { waitUntil(Promise.resolve(p).catch(() => {})); }
      catch { try { p.catch?.(() => {}); } catch {} }
    },
  };

  // Web Request pass-through (Edge-style invocation): Headers object has .get().
  if (typeof req?.headers?.get === "function") {
    return worker_default.fetch(req, env, ctx);
  }

  // Classic Node invocation — adapt IncomingMessage → web Request.
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const url = `${proto}://${host}${req.url}`;
  const method = req.method || "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) { for (const vv of v) headers.append(k, vv); }
    else if (v != null) headers.set(k, String(v));
  }
  let body;
  if (method !== "GET" && method !== "HEAD") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (chunks.length) body = Buffer.concat(chunks);
  }
  const request = new Request(url, { method, headers, body });

  const resp = await worker_default.fetch(request, env, ctx);

  // Web Response → Node res. All routes return buffered JSON (no streaming).
  res.statusCode = resp.status;
  resp.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await resp.arrayBuffer()));
}
