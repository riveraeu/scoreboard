// Shadow maker V2 — REAL resting orders on the one sub-band the 7/21 ARM review found a real,
// non-borderline edge in (mlb-style favorite-ask quoting, [80,84]¢ — see MAKER_V2_BAND in
// config.js). Mirrors maker.js's shape (quote pass in the snapshot cron, reconcile pass in the
// nightly resolver) but places real orders via kalshi-order-client.js instead of simulating.
//
// FAIL-CLOSED KILL SWITCH: nothing places unless BOTH env.MAKER_V2_ARMED === "true" AND the KV
// flag `maker:v2:armed` are true. Either being false stops everything — see isArmed()/setArmed().
// No auto-scaling: MAKER_V2_SIZE and the caps below only change on an explicit human edit.
//
// ORDER LIFECYCLE (no aggressive per-tick churn): each resting order self-expires via
// `expiration_time` (MAKER_V2_EXPIRATION_SEC past placement) — Kalshi cancels it automatically
// with no further call. Every quote pass (kalshi-snapshot cron, ~2min cadence) first polls real
// fills (15min lookback) so a filled order flips to 'executed' within one tick instead of
// waiting for the nightly reconcile; then, for anything still resting:
//   - price/eligibility UNCHANGED and not nearing expiry → no-op (order keeps resting).
//   - nearing expiry (same price) → place a fresh replacement; let the old one lapse on its own
//     (no cancel call needed — Kalshi already will).
//   - price CHANGED → explicit cancel of the old order, THEN place the new one (never both
//     resting on the same ticker at once — avoids doubled exposure).
//   - no longer eligible → no cancel call (Kalshi's own expiration_time handles that), but once
//     past expires_at, mark it locally 'expired' same-tick so STATUS doesn't sit stale.
//   - newly eligible → place a new order, subject to MAKER_V2_MAX_CONCURRENT and
//     MAKER_V2_SAME_GAME_CAP (correlation guard, mirrors Place All's SAME_GAME_CAP concept).
//
// Failure-closed throughout: every exported IO entry point catches internally — a V2 failure
// must never break the snapshot cron or the resolver (same contract as maker.js V1).

import { MAKER_V2_BAND, MAKER_V2_SIZE, MAKER_V2_MAX_CONCURRENT, MAKER_V2_SAME_GAME_CAP,
  MAKER_V2_EXPIRATION_SEC } from "./config.js";
import { computeMakerQuote, MAKER_FEE_SERIES } from "./maker.js";
import { shadowId } from "./shadow-id.js";
import { neonQuery, neonExec } from "./neon.js";
import { placeKalshiOrder, cancelKalshiOrder, fetchKalshiFills, fetchKalshiSettlements } from "./kalshi-order-client.js";

const ARMED_KV_KEY = "maker:v2:armed";

// ── SHELVED 2026-07-28 — third gate, and the one that actually holds ──────────────────────────
// The maker measurement program concluded that there is no demonstrated fillable edge. Six
// hypotheses, six dissolutions: ARM-MET 7/21 (grading bugs), "edge only in 80-84" (post-fix bands
// alternate sign), adverse selection ~1.4¢ (→ +0.51¢, band-incoherent, and it inverted), the
// aggregate fill CI (day-clustering widened it back across zero), 7/24's +8.05¢ (a tape replay of
// the same markets gives −0.01¢), and the pre-registered lead-time test (rejected on all three
// criteria — docs/MAKER_LEADTIME_PREREG.md). The one thing that HAS replicated every time is the
// vig on the QUOTE (+1.5-1.6¢ across 100k+ segments); it has never been shown to survive to a fill.
//
// Why this is a code constant rather than an env/KV change: `MAKER_V2_ARMED` was still "true" in
// production from the 7/21 arming, so the entire shelving rested on one KV flag that a single POST
// to /api/maker-v2-arm would flip back. A shelved system should not be one request from live. Here
// the decision is in git, reviewable, and un-shelving is a deliberate one-line revert with the
// verdict in front of whoever does it.
//
// The env+KV mechanism below is deliberately left intact so that revert is genuinely one line.
const SHELVED = true;

// All gates must be true — fail-closed on any being unset/false.
export async function isArmed(env, cache) {
  if (SHELVED) return false;
  if (env?.MAKER_V2_ARMED !== "true") return false;
  if (!cache) return false;
  const kv = await cache.get(ARMED_KV_KEY, "json").catch(() => null);
  return kv?.armed === true;
}
export async function setArmed(cache, armed) {
  await cache.put(ARMED_KV_KEY, { armed: !!armed, at: new Date().toISOString() });
}

// computeMakerQuote (shared with V1) returns "sell `side` at `askCents`" — the validated
// favorite-fade strategy (maker.js: "A maker SELLING the favorite side... captures that
// richness"). Kalshi has no sell-to-open order type (V2's own comment in handlers/kalshi.js:
// "bid = buy YES, ask = sell YES — and selling YES you don't hold IS the NO buy"), so
// placeKalshiOrder is buy-only. This expresses the sell as a buy of the complementary contract
// at the complementary price — settlement-equivalent (sell yes@P === buy no@(100-P)). Only the
// real order call goes through this; q.side/q.ask stay the sold side/price everywhere else
// (DB storage, grading, cancel/reprice diffing).
export const sellAsBuy = (side, askCents) => ({ side: side === "yes" ? "no" : "yes", price: 100 - askCents });

// Same-game correlation key (sport|date|sorted-team-pair) — order-independent so ticker home/
// away order (which CLAUDE.md notes never matches ESPN) can't split one game into two buckets.
export const gameKeyFor = (row) =>
  [row?.sport || "", row?.gameDate || "", [row?.homeTeam, row?.awayTeam].filter(Boolean).sort().join("-")].join("|");
const _gameKey = gameKeyFor;

let _ddlDone = false;
export async function ensureMakerLiveTables(env) {
  if (_ddlDone) return;
  await neonExec(`
    CREATE TABLE IF NOT EXISTS maker_orders_v2 (
      id SERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      kalshi_order_id TEXT,
      client_order_id TEXT,
      series TEXT,
      sport TEXT,
      category TEXT,
      game_date TEXT,
      game_key TEXT,
      shadow_row_id TEXT,
      row_direction TEXT,
      side TEXT NOT NULL,
      price INT NOT NULL,
      size INT NOT NULL,
      filled_count INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'resting',
      side_won BOOLEAN,
      pnl_cents NUMERIC,
      graded_at TIMESTAMPTZ,
      placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS maker_orders_v2_resting_idx ON maker_orders_v2 (ticker) WHERE status = 'resting';
    CREATE INDEX IF NOT EXISTS maker_orders_v2_day_idx ON maker_orders_v2 (game_date)
  `, env);
  _ddlDone = true;
}

// Pure eligibility computation — shared by the quote pass below AND the read-only
// /api/maker-v2-board endpoint (so "what's eligible" has exactly one definition; the endpoint
// re-derives it live from the same KV sources rather than trusting a stale cron-tick snapshot).
// Returns a Map: ticker → { q, row, series }.
export function computeWantedMakerQuotes({ snapResults, staging, nowMs = Date.now() }) {
  const idx = new Map();
  for (const p of [...(staging?.plays || []), ...(staging?.dropped || [])]) {
    const t = p.kalshiTicker ?? p._ticker;
    if (!t) continue;
    const prev = idx.get(t);
    if (!prev || (prev.direction === "under" && p.direction !== "under")) idx.set(t, p);
  }

  const want = new Map(); // ticker → { q, row, series }
  for (const [series, data] of Object.entries(snapResults || {})) {
    if (MAKER_FEE_SERIES.has(series)) continue;
    for (const m of (data?.markets || [])) {
      const row = idx.get(m?.ticker);
      if (!row) continue;
      const q = computeMakerQuote(m, row, nowMs, MAKER_V2_BAND);
      if (q) want.set(m.ticker, { q, row, series });
    }
  }
  return want;
}

// Quote pass — runs in the kalshi-snapshot cron tail, right after V1's updateMakerQuotes, with
// the same just-fetched books + staging index (zero extra Kalshi reads for eligibility).
export async function updateLiveMakerOrders({ snapResults, staging, snapshotDate, env, cache, nowMs = Date.now() }) {
  if (!(await isArmed(env, cache))) return { skipped: "disarmed" };
  await ensureMakerLiveTables(env);

  const want = computeWantedMakerQuotes({ snapResults, staging, nowMs });

  const resting = await neonQuery(
    `SELECT * FROM maker_orders_v2 WHERE status = 'resting'`, [], env, { write: true });
  const restingByTicker = new Map(resting.map(r => [r.ticker, r]));

  // Poll real fills every tick, not just in the nightly reconcile — previously a resting order
  // that filled between ticks stayed 'resting' in the DB for up to ~10 hours (until the next
  // shadow-resolver run), which read as a stuck STATUS column even though Refresh was genuinely
  // re-querying Neon. 15min lookback tolerates a few missed ticks without re-scanning the day.
  const executedIds = new Set();
  if (resting.length) {
    const fillsRes = await fetchKalshiFills({ minTs: Math.floor((nowMs - 15 * 60_000) / 1000) }, env)
      .catch(e => ({ ok: false, error: String(e?.message || e) }));
    if (fillsRes.ok && fillsRes.fills.length) {
      const byOrderId = new Map(resting.filter(r => r.kalshi_order_id).map(r => [r.kalshi_order_id, r]));
      for (const f of fillsRes.fills) {
        const r = byOrderId.get(f.order_id);
        if (!r) continue;
        const filledCount = Math.round(parseFloat(f.count ?? f.count_fp ?? "0")) || 0;
        if (!filledCount) continue;
        await neonQuery(
          `UPDATE maker_orders_v2 SET filled_count = $2, status = 'executed' WHERE id = $1`,
          [r.id, filledCount], env, { write: true });
        executedIds.add(r.id);
        restingByTicker.delete(r.ticker);
      }
    }
  }

  const RENEW_WINDOW_MS = 30_000; // renew if within 30s of expiry
  const toCancel = [];   // rows needing an explicit cancel (price changed)
  const toExpireLocally = []; // rows we stop tracking as resting without a cancel call (lapsed/no-longer-desired)
  const toPlace = [];    // tickers to place a fresh order for

  for (const [ticker, r] of restingByTicker) {
    const w = want.get(ticker);
    const expiresAt = r.expires_at ? Date.parse(r.expires_at) : 0;
    if (!w) {
      // No longer desired (game started, price left the band, etc). Kalshi already auto-cancels
      // this order at its own expires_at via `expiration_time` — nothing to cancel on our end —
      // but once that's passed, mark it locally too so STATUS reflects reality within one tick
      // instead of sitting 'resting' until the nightly reconcile's belt-and-suspenders sweep.
      if (expiresAt && nowMs >= expiresAt) toExpireLocally.push(r);
      continue;
    }
    if (w.q.side !== r.side || w.q.ask !== Number(r.price)) {
      toCancel.push(r);
      toPlace.push({ ticker, ...w });
    } else if (nowMs >= expiresAt - RENEW_WINDOW_MS) {
      toExpireLocally.push(r);
      toPlace.push({ ticker, ...w });
    }
  }
  for (const [ticker, w] of want) {
    if (!restingByTicker.has(ticker)) toPlace.push({ ticker, ...w });
  }

  // Cancels first (frees slots + avoids double-resting on a reprice). reducedBy tells us how
  // many contracts actually came off the resting order — if it's less than the row's own size,
  // the gap filled between our last check and this cancel call, so it's 'executed' with that
  // partial fill recorded, not silently 'canceled' as if nothing happened. A FAILED cancel must
  // NOT be marked canceled — the order may still be genuinely resting on Kalshi's side, so
  // marking it gone here would let us place a second order on the same ticker (the exact
  // double-exposure this cancel-before-reprice design exists to prevent). Instead we leave its
  // status alone and skip placing its replacement this cycle — retried next tick, with the
  // self-expiring safety net as the ultimate backstop.
  let canceledCount = 0;
  const failedCancelTickers = new Set();
  for (const r of toCancel) {
    const res = await cancelKalshiOrder({ orderId: r.kalshi_order_id }, env).catch(e => ({ ok: false, error: String(e?.message || e) }));
    if (res.ok) {
      const filledGap = Math.max(0, Number(r.size) - (res.reducedBy || 0));
      if (filledGap > 0) {
        await neonQuery(
          `UPDATE maker_orders_v2 SET status = 'executed', filled_count = $2 WHERE id = $1`,
          [r.id, filledGap], env, { write: true });
      } else {
        await neonQuery(
          `UPDATE maker_orders_v2 SET status = 'canceled', canceled_at = NOW() WHERE id = $1`,
          [r.id], env, { write: true });
      }
      canceledCount++;
    } else {
      console.error(`[maker-live] cancel ${r.ticker} (order ${r.kalshi_order_id}) failed: ${res.error} — leaving status as 'resting', skipping replacement this cycle`);
      failedCancelTickers.add(r.ticker);
    }
  }
  if (toExpireLocally.length) {
    await neonQuery(
      `UPDATE maker_orders_v2 SET status = 'expired' WHERE id = ANY($1::int[])`,
      [toExpireLocally.map(r => Number(r.id))], env, { write: true });
  }
  const toPlaceFiltered = toPlace.filter(({ ticker }) => !failedCancelTickers.has(ticker));

  // Cap bookkeeping — start from what will still be resting after the cancels/expiries/fills above.
  // A row whose cancel FAILED stays counted as resting (it may genuinely still be).
  const stillResting = resting.filter(r =>
    !executedIds.has(r.id)
    && !(toCancel.some(c => c.id === r.id) && !failedCancelTickers.has(r.ticker))
    && !toExpireLocally.some(c => c.id === r.id));
  let globalCount = stillResting.length;
  const gameCounts = new Map();
  for (const r of stillResting) {
    const gk = r.game_key || "";
    gameCounts.set(gk, (gameCounts.get(gk) || 0) + 1);
  }

  let opened = 0, capped = 0, errors = 0;
  for (const { ticker, q, row, series } of toPlaceFiltered) {
    const gk = _gameKey(row);
    const gameCount = gameCounts.get(gk) || 0;
    if (globalCount >= MAKER_V2_MAX_CONCURRENT || gameCount >= MAKER_V2_SAME_GAME_CAP) { capped++; continue; }
    const expirationTime = Math.floor(nowMs / 1000) + MAKER_V2_EXPIRATION_SEC;
    const buyOrder = sellAsBuy(q.side, q.ask);
    const res = await placeKalshiOrder(
      { ticker, side: buyOrder.side, price: buyOrder.price, count: MAKER_V2_SIZE, expirationTime }, env
    ).catch(e => ({ ok: false, error: String(e?.message || e) }));
    if (!res.ok) { errors++; console.error(`[maker-live] place ${ticker} failed: ${res.error}`); continue; }
    const filled = res.fillCount || 0;
    const status = res.remainingCount === 0 && filled > 0 ? "executed" : "resting";
    await neonQuery(
      `INSERT INTO maker_orders_v2
        (ticker, kalshi_order_id, client_order_id, series, sport, category, game_date, game_key,
         shadow_row_id, row_direction, side, price, size, filled_count, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, to_timestamp($16))`,
      [ticker, res.orderId, res.clientOrderId, series, row.sport ?? null, row.stat ?? row.gameType ?? null,
       row.gameDate ?? snapshotDate ?? null, gk, shadowId(row, snapshotDate), row.direction ?? null,
       q.side, q.ask, MAKER_V2_SIZE, filled, status, expirationTime],
      env, { write: true });
    opened++;
    globalCount++;
    gameCounts.set(gk, gameCount + 1);
  }

  return { eligible: want.size, canceled: canceledCount, failedCancels: failedCancelTickers.size,
    expiredLocally: toExpireLocally.length, opened, capped, errors };
}

// PnL grading — date-agnostic (grades ANY executed+ungraded position the instant its
// shadow_plays row resolves, whatever day it's dated). Split out so it can run standalone on
// the 2min cron tick (via resolveOpenMakerPositions, api/lib/handlers/shadow.js — that pass
// resolves TODAY's already-finished games, which the main shadow-resolver won't touch until
// T+1) as well as inside the nightly reconcileLiveMakerFills below. One source of truth either
// way — settlement math is `pnl_cents = price − 100·side_won`, same formula V1 uses.
// Grades open V2 positions directly off Kalshi's own settlements feed (2026-07-22 rewrite,
// simplified same day after an intermediate version re-derived cost from our own stored price —
// see git history). Net pnl per ticker = revenue − cost − fee, ALL taken directly from Kalshi's
// own settlement record (kalshi-order-client.js's fetchKalshiSettlements) — zero dependency on
// our own stored `side`/`price` being correct, which is deliberate: an earlier version used
// `100−price` as the cost basis (reconstructed from our own row) and a CASE-WHEN sign formula
// for side_won, and a from-scratch audit against this same settlements feed found that sign
// formula disagreed with Kalshi's real result on several spread/team-total markets — real
// dollars, not rounding. Kalshi's own cost/revenue numbers already encode the correct economics
// for whatever side we actually hold, so there is no sign logic left to get wrong for the PnL
// number itself; `side_won` is kept only as an informational label. shadow_plays resolution
// (resolveOpenMakerPositions) still runs for the broader calibration pipeline; V2's own PnL no
// longer depends on it or on any ESPN-derived outcome at all.
export async function gradeResolvedMakerPositions({ env }) {
  await ensureMakerLiveTables(env);

  const candidates = await neonQuery(
    `SELECT id, ticker, side FROM maker_orders_v2
     WHERE status = 'executed' AND graded_at IS NULL`,
    [], env, { write: true });
  if (!candidates.length) return { graded: 0, held: 0 };

  // Fail-closed: if settlements can't be fetched, skip grading entirely this pass — retried
  // next tick — rather than guess. 4-day lookback comfortably covers same-day placement.
  const minTs = Math.floor((Date.now() - 4 * 86400_000) / 1000);
  const settlementsRes = await fetchKalshiSettlements({ minTs }, env);
  if (!settlementsRes.ok) return { graded: 0, held: candidates.length, error: settlementsRes.error };

  const byTicker = new Map(settlementsRes.settlements.map(s => [s.ticker, s]));
  const byTickerCandidates = new Map();
  for (const c of candidates) {
    if (!byTicker.has(c.ticker)) continue;
    if (!byTickerCandidates.has(c.ticker)) byTickerCandidates.set(c.ticker, []);
    byTickerCandidates.get(c.ticker).push(c);
  }
  if (!byTickerCandidates.size) return { graded: 0, held: candidates.length };

  const toGrade = [];
  for (const [ticker, rows] of byTickerCandidates) {
    const settlement = byTicker.get(ticker);
    // Divide by Kalshi's OWN contract count (not our tracked filled_count sum) — removes any
    // dependency on our own tracking matching reality for the denominator too, not just cost.
    if (!settlement.contracts) continue;
    const netTotalCents = settlement.revenueCents - settlement.costCents - (settlement.feeCents || 0);
    const netPerContract = Math.round(netTotalCents / settlement.contracts);
    for (const r of rows) {
      toGrade.push({ oid: r.id, sideWon: settlement.marketResult === r.side, pnlCents: netPerContract });
    }
  }
  if (!toGrade.length) return { graded: 0, held: candidates.length };

  let gradedCount = 0;
  const chunkSize = 100;
  for (let i = 0; i < toGrade.length; i += chunkSize) {
    const chunk = toGrade.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, ri) => `($${ri * 3 + 1}::int, $${ri * 3 + 2}::boolean, $${ri * 3 + 3}::int)`).join(", ");
    const values = chunk.flatMap(c => [c.oid, c.sideWon, c.pnlCents]);
    const graded = await neonQuery(
      `UPDATE maker_orders_v2 mo SET
         side_won = v.side_won,
         pnl_cents = v.pnl_cents,
         graded_at = NOW()
       FROM (VALUES ${placeholders}) AS v(oid, side_won, pnl_cents)
       WHERE mo.id = v.oid AND mo.graded_at IS NULL
       RETURNING mo.id`,
      values, env, { write: true });
    gradedCount += graded.length;
  }
  return { graded: gradedCount, held: candidates.length - gradedCount };
}

// Reconcile pass — nightly, right after V1's detectAndGradeMakerFills. Catches real fills that
// happened between cron ticks (the common case for a resting order), marks lapsed rows past
// their expires_at that the quote pass didn't already clean up (belt-and-suspenders if a cron
// cycle was skipped/delayed), and grades PnL once the underlying shadow_plays row resolves.
export async function reconcileLiveMakerFills({ env, dayPT }) {
  await ensureMakerLiveTables(env);

  // Belt-and-suspenders: anything still 'resting' well past its expiry either filled (caught
  // below via the fills poll) or lapsed — flip to 'expired' here so it stops counting toward caps.
  await neonQuery(
    `UPDATE maker_orders_v2 SET status = 'expired'
     WHERE status = 'resting' AND expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '10 minutes'`,
    [], env, { write: true });

  const minTs = Math.floor((Date.parse(`${dayPT}T00:00:00-07:00`) - 6 * 3600_000) / 1000);
  const fillsRes = await fetchKalshiFills({ minTs }, env);
  let matched = 0;
  if (fillsRes.ok && fillsRes.fills.length) {
    const tracked = await neonQuery(
      `SELECT id, kalshi_order_id, size FROM maker_orders_v2
       WHERE game_date = $1 AND status IN ('resting', 'expired') AND kalshi_order_id IS NOT NULL`,
      [dayPT], env, { write: true });
    const byOrderId = new Map(tracked.map(t => [t.kalshi_order_id, t]));
    for (const f of fillsRes.fills) {
      const t = byOrderId.get(f.order_id);
      if (!t) continue;
      const filledCount = Math.round(parseFloat(f.count ?? f.count_fp ?? "0")) || 0;
      if (!filledCount) continue;
      await neonQuery(
        `UPDATE maker_orders_v2 SET filled_count = $2, status = 'executed' WHERE id = $1`,
        [t.id, filledCount], env, { write: true });
      matched++;
    }
  }

  const { graded } = await gradeResolvedMakerPositions({ env });

  return { fillsFetched: fillsRes.ok ? fillsRes.fills.length : 0, fillsMatched: matched,
    fillsError: fillsRes.ok ? null : fillsRes.error, graded };
}

// Emergency stop — used by /api/maker-v2-kill. Disarms (KV flag) AND cancels every currently
// resting order immediately, rather than waiting out their natural expiration.
export async function emergencyKillLive({ env, cache }) {
  await ensureMakerLiveTables(env);
  await setArmed(cache, false);
  const resting = await neonQuery(
    `SELECT id, kalshi_order_id, size FROM maker_orders_v2 WHERE status = 'resting'`, [], env, { write: true });
  let canceled = 0, errors = 0;
  for (const r of resting) {
    const res = await cancelKalshiOrder({ orderId: r.kalshi_order_id }, env).catch(e => ({ ok: false, error: String(e?.message || e) }));
    if (res.ok) {
      const filledGap = Math.max(0, Number(r.size) - (res.reducedBy || 0));
      if (filledGap > 0) {
        await neonQuery(`UPDATE maker_orders_v2 SET status = 'executed', filled_count = $2 WHERE id = $1`,
          [r.id, filledGap], env, { write: true });
      } else {
        await neonQuery(`UPDATE maker_orders_v2 SET status = 'canceled', canceled_at = NOW() WHERE id = $1`,
          [r.id], env, { write: true });
      }
      canceled++;
    } else {
      // Cancel failed — the order may still genuinely be resting on Kalshi's side, so don't
      // mark it canceled here. It stays 'resting' locally; the disarm itself already stops new
      // placements, and the self-expiring safety net is the backstop for this specific order.
      errors++;
    }
  }
  return { disarmed: true, resting: resting.length, canceled, errors };
}
