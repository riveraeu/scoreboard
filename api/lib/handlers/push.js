// Web Push routes — background notifications for the installed PWA.
//
//   GET  /api/push/vapid       → public VAPID key (client needs it to subscribe)
//   POST /api/push/subscribe   → store a PushSubscription (user_id from JWT if present)
//   POST /api/push/unsubscribe → drop a subscription by endpoint
//   POST /api/push/notify      → CRON/ADMIN: diff today's actionable plays vs already-notified,
//                                push the new ones to every subscription (prunes dead subs)
//   POST /api/push/test        → ADMIN: send a test push to all subscriptions
//
// Why this exists alongside the foreground notifier (useTonight → new Notification): that only
// fires while the tab/PWA is open. This delivers when the app is CLOSED — the mobile use case.
// On iOS 16.4+ the device must have the site installed to the Home Screen for delivery.
//
// web-push is the only Node-only dependency in the codebase; it's dynamic-imported inside the
// send path (cron/admin only) so cold starts on every other route don't pay for it.

import { errorResponse, jsonResponse } from "../utils.js";
import { verifyJWT } from "../auth-utils.js";
import { neonQuery, neonExec } from "../neon.js";
import { EDGE_GATE_CLIENT } from "../config.js";
import { passesCategoryGate } from "../category-gate.js";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
)`;

// Run the DDL at most once per 30 days (gated by a KV flag) instead of on every request.
async function ensureTable(env, cache) {
  const flagKey = "push:schema:v1";
  const ok = cache ? await cache.get(flagKey).catch(() => null) : null;
  if (ok) return;
  await neonExec(CREATE_TABLE_SQL, env);
  if (cache) cache.put(flagKey, "1", { expirationTtl: 86400 * 30 }).catch(() => {});
}

// Mirrors src/lib/qualify.js qualifiesForDisplay + placeValidation.isMarketUntrusted, so a push
// fires only for plays the user would actually see AND auto-bet (Place All risk gate parity).
function _isMarketUntrusted(p) {
  return p.kalshiVolume === 0 || p.lowVolume === true || p.thinMarket === true;
}
function qualifiesForPush(p) {
  if (p._altLineDemoted === true && !passesCategoryGate(p)) return false;
  if (p.dcQualified !== true || (p.edge ?? 0) < EDGE_GATE_CLIENT) return false;
  if (!passesCategoryGate(p)) return false;
  return !_isMarketUntrusted(p);
}

// Stable per-play key for cross-run dedup — mirrors trackIdFor (src/lib/qualify.js).
function pushKey(p) {
  const gd = p.gameDate || "";
  const seg = p.segment && p.segment !== "full" ? `|${p.segment}` : "";
  if (p.gameType === "teamTotal") return `teamtotal|${p.sport}|${p.scoringTeam}|${p.oppTeam}|${p.threshold}|${gd}${p.direction === "under" ? "|under" : ""}`;
  if (p.gameType === "total") return `total|${p.sport}${seg}|${p.homeTeam}|${p.awayTeam}|${p.threshold}|${gd}${p.direction === "under" ? "|under" : ""}`;
  if (p.gameType === "ml") return `ml|${p.sport}${seg}|${p.pickTeam}|${p.homeTeam}|${p.awayTeam}|${gd}`;
  if (p.gameType === "spread") return `spread|${p.sport}${seg}|${p.pickTeam}|${p.homeTeam}|${p.awayTeam}|${p.pickLine}|${gd}`;
  return `${p.sport || "nba"}|${p.playerName}|${p.stat}|${p.threshold}|${gd}`;
}

// Short human label for a play (notification body).
function playLabel(p) {
  if (p.playerName) {
    const dir = p.direction === "under" ? "U" : "O";
    return `${p.playerName} ${dir}${p.threshold} ${(p.stat || "").toUpperCase()}`;
  }
  if (p.gameType === "ml") return `${p.pickTeam} ML`;
  if (p.gameType === "spread") return `${p.pickTeam} ${p.pickLine > 0 ? "+" : ""}${p.pickLine}`;
  if (p.gameType === "teamTotal") return `${p.scoringTeam} team ${p.direction === "under" ? "U" : "O"}${p.threshold}`;
  if (p.gameType === "total") return `${p.awayTeam}@${p.homeTeam} ${p.direction === "under" ? "U" : "O"}${p.threshold}`;
  return p.sport || "play";
}

// Send one payload to every subscription; prune subs the push service reports as gone (404/410).
async function broadcast(env, payload) {
  const rows = await neonQuery("SELECT endpoint, p256dh, auth FROM push_subscriptions", [], env);
  if (!rows.length) return { sent: 0, pruned: 0, subs: 0 };

  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const body = JSON.stringify(payload);

  let sent = 0, pruned = 0;
  const dead = [];
  await Promise.all(rows.map(async (r) => {
    const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      await webpush.sendNotification(sub, body);
      sent++;
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) { dead.push(r.endpoint); pruned++; }
    }
  }));
  if (dead.length) {
    await neonQuery("DELETE FROM push_subscriptions WHERE endpoint = ANY($1)", [dead], env, { write: true }).catch(() => {});
  }
  return { sent, pruned, subs: rows.length };
}

export async function handlePushRoutes(ctx) {
  const { path, method, request, env, CACHE2, JWT_SECRET } = ctx;
  if (!path.startsWith("push/")) return null;

  // ---- GET /api/push/vapid ----
  if (path === "push/vapid" && method === "GET") {
    if (!env?.VAPID_PUBLIC_KEY) return errorResponse("VAPID not configured", 500);
    return jsonResponse({ publicKey: env.VAPID_PUBLIC_KEY });
  }

  // ---- POST /api/push/subscribe ----
  if (path === "push/subscribe" && method === "POST") {
    if (!env?.NEON_DATABASE_URL && !env?.POSTGRES_URL) return errorResponse("DB not configured", 500);
    const sub = await request.json().catch(() => null);
    const endpoint = sub?.endpoint;
    const p256dh = sub?.keys?.p256dh;
    const auth = sub?.keys?.auth;
    if (!endpoint || !p256dh || !auth) return errorResponse("Invalid subscription", 400);

    // Opportunistic user_id from the session cookie / bearer (anonymous subs allowed).
    let userId = null;
    if (JWT_SECRET) {
      const cookie = request.headers.get("Cookie") || "";
      const m = cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
      const token = m?.[1] || (request.headers.get("Authorization") || "").replace("Bearer ", "") || null;
      if (token) { const claims = await verifyJWT(token, JWT_SECRET).catch(() => null); userId = claims?.userId ?? null; }
    }

    await ensureTable(env, CACHE2);
    await neonQuery(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_id = COALESCE(EXCLUDED.user_id, push_subscriptions.user_id)`,
      [userId, endpoint, p256dh, auth], env, { write: true }
    );
    return jsonResponse({ ok: true });
  }

  // ---- POST /api/push/unsubscribe ----
  if (path === "push/unsubscribe" && method === "POST") {
    const body = await request.json().catch(() => null);
    const endpoint = body?.endpoint;
    if (!endpoint) return errorResponse("endpoint required", 400);
    await neonQuery("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint], env, { write: true }).catch(() => {});
    return jsonResponse({ ok: true });
  }

  // ---- POST /api/push/notify  (cron or admin) ----
  if (path === "push/notify" && method === "POST") {
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    const isCron = env?.CRON_SECRET && bearer === env.CRON_SECRET;
    const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;
    if (!isCron && !isAdmin) return errorResponse("Forbidden", 403);
    if (!env?.VAPID_PRIVATE_KEY) return errorResponse("VAPID not configured", 500);

    const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const staged = CACHE2 ? await CACHE2.get(`shadow:staging:${date}`, "json").catch(() => null) : null;
    if (!staged?.plays) return jsonResponse({ ok: true, reason: "no-staging", date });

    const actionable = staged.plays.filter(qualifiesForPush);

    // Cross-run dedup: a play notifies once per PT day across the 4 trailing crons.
    const notifKey = `push:notified:${date}`;
    const seen = (CACHE2 ? await CACHE2.get(notifKey, "json").catch(() => null) : null) || {};
    const fresh = actionable.filter((p) => !seen[pushKey(p)]);
    if (!fresh.length) return jsonResponse({ ok: true, date, actionable: actionable.length, fresh: 0 });

    let result;
    if (fresh.length > 3) {
      result = await broadcast(env, {
        title: `${fresh.length} new plays`,
        body: `${playLabel(fresh[0])} +${fresh.length - 1} more`,
        url: "/", tag: `daily-${date}`,
      });
    } else {
      // ≤3: individual pushes so each is actionable. Aggregate the send stats.
      const stats = { sent: 0, pruned: 0, subs: 0 };
      for (const p of fresh) {
        const r = await broadcast(env, {
          title: "New play", body: playLabel(p), url: "/", tag: pushKey(p),
        });
        stats.sent += r.sent; stats.pruned += r.pruned; stats.subs = r.subs;
      }
      result = stats;
    }

    for (const p of fresh) seen[pushKey(p)] = 1;
    if (CACHE2) CACHE2.put(notifKey, seen, { expirationTtl: 108000 }).catch(() => {}); // 30h

    return jsonResponse({ ok: true, date, actionable: actionable.length, fresh: fresh.length, ...result });
  }

  // ---- POST /api/push/test  (admin) ----
  if (path === "push/test" && method === "POST") {
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    if (!env?.ADMIN_KEY || bearer !== env.ADMIN_KEY) return errorResponse("Forbidden", 403);
    if (!env?.VAPID_PRIVATE_KEY) return errorResponse("VAPID not configured", 500);
    const result = await broadcast(env, {
      title: "Scoreboard test", body: "Push notifications are working ✅", url: "/", tag: "test",
    });
    return jsonResponse({ ok: true, ...result });
  }

  return null;
}
