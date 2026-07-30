// api/lib/handlers/shadow.js
// Router for the /api/shadow-* family. Each route handler lives in its own module under ./shadow/
// (split out of this file 2026-07-29 for maintainability — zero behavior change). This file wires
// them into handleShadowRoutes (tried in order, first non-null response wins) and holds the tiny
// routine-note endpoint inline. resolveOpenMakerPositions (kalshi.js cron) and exogenousSignals /
// mergeCoverage (unit tests) are re-exported so their importers keep resolving them from here.

import { errorResponse, jsonResponse } from "../utils.js";
import { verifyJWT } from "../auth-utils.js";
import { handleShadowReport } from "./shadow/report.js";
import { handleShadowPregameSnap } from "./shadow/pregame-snap.js";
import { handlePolymarketScan, handlePolymarketDeltas, handleSportsbookDeltas } from "./shadow/deltas.js";
import { handleShadowResolver, handleKalshiDryrunCheck } from "./shadow/resolver.js";
import { handleShadowSnapshot } from "./shadow/snapshot.js";
export { resolveOpenMakerPositions } from "./shadow/resolver.js";
export { exogenousSignals, mergeCoverage } from "./shadow/snapshot.js";

// ── /api/routine-note ───────────────────────────────────────────────────────
// A tiny KV scratchpad so cloud routines (claude.ai code triggers) can hand their
// summary back to a dev box that CANNOT reach Kalshi/Neon directly but CAN reach
// this production API. WRITE is gated by a dedicated low-privilege ROUTINE_NOTE_TOKEN
// (so a routine's prompt config never carries ADMIN_KEY); READ is gated by ADMIN_KEY/JWT.
// Stores `routine:note:{slug}` = {text, writtenAt} for 14d.
async function handleRoutineNote({ path, request, env, cache }) {
  if (path !== "routine-note") return null;
  if (!cache) return errorResponse("No KV", 500);
  const method = (request.method || "GET").toUpperCase();
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const NOTE_TTL = 14 * 24 * 3600;

  if (method === "POST") {
    if (!env?.ROUTINE_NOTE_TOKEN || bearer !== env.ROUTINE_NOTE_TOKEN) return errorResponse("Forbidden", 403);
    let body;
    try { body = await request.json(); } catch { return errorResponse("Bad JSON", 400); }
    const slug = String(body?.slug || "").trim().replace(/[^\w.-]/g, "").slice(0, 80);
    const text = typeof body?.text === "string" ? body.text.slice(0, 100_000) : null;
    if (!slug || text == null) return errorResponse("slug + text required", 400);
    const writtenAt = new Date().toISOString();
    await cache.put(`routine:note:${slug}`, { text, writtenAt }, { expirationTtl: NOTE_TTL });
    return jsonResponse({ ok: true, slug, writtenAt, bytes: text.length });
  }

  // GET — read one note (ADMIN_KEY/JWT).
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;
  let isUser = false;
  if (!isAdmin && env?.JWT_SECRET) {
    try { isUser = !!(await verifyJWT(bearer, env.JWT_SECRET)); } catch { isUser = false; }
  }
  if (!isAdmin && !isUser) return errorResponse("Forbidden", 403);
  const slug = String(new URL(request.url).searchParams.get("slug") || "").trim().replace(/[^\w.-]/g, "");
  if (!slug) return errorResponse("slug required", 400);
  const note = await cache.get(`routine:note:${slug}`, "json").catch(() => null);
  if (!note) return jsonResponse({ ok: true, slug, found: false, text: null });
  return jsonResponse({ ok: true, slug, found: true, ...note });
}

export async function handleShadowRoutes({ path, request, env, cache }) {
  const polyScanResp = await handlePolymarketScan({ path, request, env });
  if (polyScanResp) return polyScanResp;

  const polyDeltaResp = await handlePolymarketDeltas({ path, request, env });
  if (polyDeltaResp) return polyDeltaResp;

  const sbDeltaResp = await handleSportsbookDeltas({ path, request, env });
  if (sbDeltaResp) return sbDeltaResp;

  const noteResp = await handleRoutineNote({ path, request, env, cache });
  if (noteResp) return noteResp;

  const reportResp = await handleShadowReport({ path, request, env, cache });
  if (reportResp) return reportResp;

  const shadowResolverResp = await handleShadowResolver({ path, request, env, cache });
  if (shadowResolverResp) return shadowResolverResp;

  const kalshiDryrunResp = await handleKalshiDryrunCheck({ path, request, env });
  if (kalshiDryrunResp) return kalshiDryrunResp;

  const pregameResp = await handleShadowPregameSnap({ path, request, env, cache });
  if (pregameResp) return pregameResp;

  return await handleShadowSnapshot({ path, request, env, cache });
}
