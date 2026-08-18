// api/lib/handlers/shadow/pregame-snap.js
// GET /api/shadow-pregame-snap — stamps current Kalshi prices onto today's shadow_plays rows for
// CLV / line-movement tracking. Extracted verbatim from handlers/shadow.js during the handler split
// (zero behavior change).

import { neonQuery, neonBatchPrePriceUpdate, neonExec } from "../../neon.js";
import { errorResponse, jsonResponse, selfOrigin } from "../../utils.js";
import { shadowId } from "../../shadow-id.js";
import { ADD_PRE_PRICE_COLS_SQL } from "./common.js";

// ── Shadow Pre-game Price Snap ────────────────────────────────────────────────
// Crons: 0 17, 10 22, 0 3 * * * — each trails a /api/tonight cron by 5–10 min.
// Reads today's plays (with current Kalshi prices) from the shadow:staging KV key
// written by tonight, and stamps them onto today's shadow_plays rows, enabling
// CLV / line-movement analysis in shadow-analysis. Staging older than 15 min is
// rejected (CLV prices must reflect now); falls back to an HTTP fetch of
// /api/tonight, which risks the 60s wall on cold rebuilds (the 2026-06-10 failure
// mode that motivated the KV-first read). `?dry=1` skips the DB write — safe
// verification without stamping mid-game prices as "pregame".

const PREGAME_STAGING_MAX_AGE_MS = 15 * 60_000;

// Per-run breadcrumb so an intermittent CLV-capture dip is root-cause-visible without log
// archaeology (the 2026-06-28 Mode-A failure: the 10am run got a degraded staging priceMap and
// captured 63 vs the ~1000 a healthy run gets — but we couldn't see WHY a day later). Appends
// {ranAt, source, stagingAgeMs, priceMapSize, unstampedRows, captured} to shadow:pregame:{date};
// a run with priceMapSize≪unstampedRows = degraded staging, a low captured with full priceMap =
// late-listing/already-settled markets. Read back via GET ?runs=1[&date=]. Best-effort.
const _PREGAME_BREADCRUMB_TTL = 30 * 3600;
async function _recordPregameRun(cache, date, rec) {
  if (!cache) return;
  const key = `shadow:pregame:${date}`;
  try {
    const prev = await cache.get(key, "json").catch(() => null);
    const list = Array.isArray(prev) ? prev : [];
    list.push(rec);
    await cache.put(key, JSON.stringify(list.slice(-12)), { expirationTtl: _PREGAME_BREADCRUMB_TTL });
  } catch { /* breadcrumb is best-effort — never block a capture on it */ }
}

async function handleShadowPregameSnap({ path, request, env, cache }) {
  if (path !== "shadow-pregame-snap") return null;

  const cronAuth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isAdmin = env?.ADMIN_KEY && cronAuth === env.ADMIN_KEY;
  const isCron  = env?.CRON_SECRET && cronAuth === env.CRON_SECRET;
  if (!isAdmin && !isCron) return errorResponse("Forbidden", 403);

  const _params = new URL(request.url).searchParams;
  const snapshotDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  // Read-only breadcrumb inspector — which runs fired today + how each did.
  if (_params.get("runs") === "1") {
    const rd = _params.get("date") || snapshotDate;
    const runs = cache ? await cache.get(`shadow:pregame:${rd}`, "json").catch(() => null) : null;
    return jsonResponse({ date: rd, runs: Array.isArray(runs) ? runs : [] });
  }

  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const t0 = Date.now();
  const isDry = _params.get("dry") === "1";

  const _preSchemaKey = "shadow:pregame-schema:v1";
  const _preSchemaOk = cache ? await cache.get(_preSchemaKey).catch(() => null) : null;
  if (!_preSchemaOk) {
    await neonExec(ADD_PRE_PRICE_COLS_SQL, env);
    if (cache) cache.put(_preSchemaKey, "1", { expirationTtl: 86400 * 30 }).catch(() => {});
  }

  // KV staging first — written on every tonight recompute from ≤10-min-old Kalshi snaps (was
  // ≤2-min before the 2026-08-17 cron widening), so fresh staging carries current prices.
  // Staleness gate matters here (unlike shadow-snapshot): CLV prices stamped now must reflect
  // now, not whenever tonight last ran.
  let rawPlays = null;
  let source = "kv-staging";
  let stagingAgeMs = null;
  if (cache) {
    const _staged = await cache.get(`shadow:staging:${snapshotDate}`, "json").catch(() => null);
    if (_staged?.plays && _staged.writtenAt) {
      stagingAgeMs = Date.now() - _staged.writtenAt;
      if (stagingAgeMs <= PREGAME_STAGING_MAX_AGE_MS) {
        rawPlays = [..._staged.plays, ...(_staged.dropped || [])];
        console.log(`[shadow-pregame-snap] KV staging hit plays=${_staged.plays.length} dropped=${_staged.dropped?.length ?? 0} ageMs=${stagingAgeMs}`);
      } else {
        console.log(`[shadow-pregame-snap] KV staging stale ageMs=${stagingAgeMs} — falling back to HTTP fetch`);
      }
    }
  }

  if (!rawPlays) {
    source = "http";
    const origin = selfOrigin(request);
    let tonightResp;
    try {
      tonightResp = await fetch(`${origin}/api/tonight`, {
        headers: { "x-shadow-internal": "1" },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (fetchErr) {
      console.error(`[shadow-pregame-snap] tonight fetch failed: ${fetchErr?.message} ${Date.now() - t0}ms`);
      return errorResponse(`tonight fetch timed out — re-run manually: ${fetchErr?.message}`, 504);
    }
    if (!tonightResp.ok) return errorResponse(`tonight fetch failed: ${tonightResp.status}`, 502);
    const tonight = await tonightResp.json();
    rawPlays = [...(tonight.plays || []), ...(tonight.dropped || [])];
  }

  // Build priceMap: shadowId(play) → { yes, no } using same deterministic ID as snapshot.
  const priceMap = new Map();
  for (const p of rawPlays) {
    if (p.kalshiPct == null && p.noKalshiPct == null) continue;
    priceMap.set(shadowId(p, snapshotDate), {
      yes: p.kalshiPct  != null ? p.kalshiPct  / 100 : null,
      no:  p.noKalshiPct != null ? p.noKalshiPct / 100 : null,
    });
  }

  if (priceMap.size === 0) {
    if (!isDry) await _recordPregameRun(cache, snapshotDate, {
      ranAt: new Date().toISOString(), source, stagingAgeMs, priceMapSize: 0, unstampedRows: null, captured: 0,
    });
    return jsonResponse({ ok: true, dry: isDry, source, stagingAgeMs, priceMapSize: 0, updated: 0, skipped: 0, durationMs: Date.now() - t0 });
  }

  // Fetch today's rows that haven't been stamped yet.
  // write:true — read-after-write of rows the snapshot cron inserted earlier today; the
  // unpooled replica can return 0 rows on cold wake (03:00 UTC run is ~4.4h after the last
  // Neon touch). Errors are logged, not swallowed — a silent [] here means CLV quietly
  // vanishes for the day.
  const rows = await neonQuery(
    `SELECT id FROM shadow_plays WHERE snapshot_date = $1 AND price_pre_at IS NULL`,
    [snapshotDate], env, { write: true }
  ).catch((e) => {
    console.error(`[shadow-pregame-snap] rows SELECT failed: ${e?.message}`);
    return [];
  });
  console.log(`[shadow-pregame-snap] unstamped rows=${rows.length} priceMap=${priceMap.size}`);

  let skipped = 0;
  const updates = [];
  for (const row of rows) {
    const prices = priceMap.get(row.id);
    if (!prices) { skipped++; continue; }
    updates.push({ id: row.id, yes: prices.yes, no: prices.no });
  }

  if (isDry) {
    return jsonResponse({
      ok: true,
      dry: true,
      snapshotDate,
      source,
      stagingAgeMs,
      priceMapSize: priceMap.size,
      unstampedRows: rows.length,
      wouldUpdate: updates.length,
      skipped,
      durationMs: Date.now() - t0,
    });
  }

  await neonBatchPrePriceUpdate(updates, env);

  await _recordPregameRun(cache, snapshotDate, {
    ranAt: new Date().toISOString(), source, stagingAgeMs,
    priceMapSize: priceMap.size, unstampedRows: rows.length, captured: updates.length,
  });

  return jsonResponse({
    ok: true,
    snapshotDate,
    source,
    stagingAgeMs,
    priceMapSize: priceMap.size,
    unstampedRows: rows.length,
    updated: updates.length,
    skipped,
    durationMs: Date.now() - t0,
  });
}

export { handleShadowPregameSnap };
