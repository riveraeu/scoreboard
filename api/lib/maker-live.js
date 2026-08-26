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

import { MAKER_V2_LIVE_CELLS, MAKER_V2_MAX_CONCURRENT, MAKER_V2_SAME_GAME_CAP,
  MAKER_V2_EXPIRATION_SEC, MAKER_V2_GLOBAL_CAP_CENTS } from "./config.js";
import { computeMakerQuote, MAKER_FEE_SERIES } from "./maker.js";
import { shadowId } from "./shadow-id.js";
import { neonQuery, neonExec } from "./neon.js";
import { placeKalshiOrder, cancelKalshiOrder, fetchKalshiFills, fetchKalshiSettlements } from "./kalshi-order-client.js";

const ARMED_KV_KEY = "maker:v2:armed";

// ── SHELVED 2026-07-28 → UN-SHELVED 2026-08-24, scoped ONLY to the sub-50 trial ────────────────
// The ORIGINAL maker measurement program (selling the favorite ask in MAKER_V2_BAND [80,84])
// concluded there is no demonstrated fillable edge. Six hypotheses, six dissolutions: ARM-MET
// 7/21 (grading bugs), "edge only in 80-84" (post-fix bands alternate sign), adverse selection
// ~1.4¢ (→ +0.51¢, band-incoherent, and it inverted), the aggregate fill CI (day-clustering
// widened it back across zero), 7/24's +8.05¢ (a tape replay of the same markets gives −0.01¢),
// and the pre-registered lead-time test (rejected on all three criteria —
// docs/MAKER_LEADTIME_PREREG.md). **That verdict is not reversed and MAKER_V2_BAND is not what
// this un-shelving arms** — computeWantedMakerQuotes no longer even reads MAKER_V2_BAND; real
// orders now target ONLY MAKER_V2_LIVE_CELLS (config.js), a different, later hypothesis (one-
// sided sub-50 quoting on wnba|points + mlb|f5total|10-14) with its own immutable doc,
// docs/MAKER_V2_SUBFIFTY_TRIAL.md, and its own per-group $30 cap / $15 stop-loss.
//
// Why this was a code constant rather than an env/KV change while shelved: `MAKER_V2_ARMED` was
// still "true" in production from the 7/21 arming, so the entire shelving rested on one KV flag
// that a single POST to /api/maker-v2-arm would flip back. A shelved system should not be one
// request from live — the decision needed to be in git, reviewable, so un-shelving is this
// deliberate one-line revert (plus the tripwire test below, updated in the same commit) rather
// than a silent env/KV toggle.
//
// Exported so the board endpoint (and through it the UI) reports the shelved state from THIS
// constant rather than restating it in a second place. The landing page renders the fact next to
// the arm status; a hardcoded frontend copy would keep claiming SHELVED through this revert.
export const MAKER_V2_SHELVED = false;
const SHELVED = MAKER_V2_SHELVED;

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
    CREATE INDEX IF NOT EXISTS maker_orders_v2_day_idx ON maker_orders_v2 (game_date);
    ALTER TABLE maker_orders_v2 ADD COLUMN IF NOT EXISTS live_group TEXT;
    CREATE INDEX IF NOT EXISTS maker_orders_v2_group_idx ON maker_orders_v2 (live_group)
  `, env);
  _ddlDone = true;
}

// Which MAKER_V2_LIVE_CELLS entry (if any) a staging row belongs to — sport + category, same
// category expression maker.js's updateMakerQuotes uses for the maker_quotes.category column
// (`row.stat ?? row.gameType`), so a row's group assignment here can never drift from how the
// SAME row would be bucketed by the report's category bands.
export function matchLiveCell(row, cells = MAKER_V2_LIVE_CELLS) {
  const category = row?.stat ?? row?.gameType ?? null;
  return cells.find(c => c.sport === row?.sport && c.category === category) || null;
}

// Pure aggregation over already-fetched maker_orders_v2 rows — split out from the DB query so the
// arithmetic is unit-testable without Neon. `exposureCents(group)`: REAL cost basis (in cents) of
// everything not yet graded (resting or executed) — this is what "$ at risk right now" means, and
// it frees up the moment a position grades. `price`/`side` on the row are the SOLD side/price
// (kept that way for grading/diffing, see sellAsBuy() below) — the real order Kalshi executes is
// the complementary BUY at (100 − price), so that's the real dollar cost per contract, not `price`
// itself. Using `price` directly understated real exposure by up to ~9x on the cheap sold sides
// this trial targets (sell @10¢ ⇒ real cost 90¢/contract) and let real capital run to ~9x the
// intended per-group cap before this was caught 2026-08-24 — see kalshi-balance's
// `makerCommittedCents` (api/lib/handlers/kalshi.js), which already used the correct `100 − price`
// basis and was the tell. `realizedCents(group)`: sum of pnl_cents × filled_count over graded
// rows — the stop-loss input.
// Both scoped to the group's own `resumeFrom` (cells config) via `game_date >= resumeFrom` — a
// group whose ledger was reset (see MAKER_V2_WNBA_POINTS_RESUME) must not keep summing rows from
// before the reset, or the reset would be a no-op.
function _resumeFrom(group, cells) {
  return cells.find(c => c.group === group)?.resumeFrom || "";
}
export function groupExposureCents(rows, group, cells = MAKER_V2_LIVE_CELLS) {
  const resumeFrom = _resumeFrom(group, cells);
  return rows
    .filter(r => r.live_group === group && r.status !== "canceled" && r.status !== "expired" && !r.graded_at
      && (r.game_date || "") >= resumeFrom)
    .reduce((sum, r) => sum + (100 - Number(r.price)) * (Number(r.filled_count) || Number(r.size)), 0);
}
export function groupRealizedCents(rows, group, cells = MAKER_V2_LIVE_CELLS) {
  const resumeFrom = _resumeFrom(group, cells);
  return rows
    .filter(r => r.live_group === group && r.graded_at && (r.game_date || "") >= resumeFrom)
    .reduce((sum, r) => sum + Number(r.pnl_cents || 0) * (Number(r.filled_count) || 0), 0);
}
// Portfolio-level exposure, independent of groupExposureCents' per-group logic (deliberately not
// sharing code — the exposure-cap bug showed per-group math itself can be wrong, so this is a
// plain second check, not a call-through that would inherit the same bug). Gated against
// MAKER_V2_GLOBAL_CAP_CENTS at placement time only, same as a per-group cap — it does not halt or
// cancel existing positions.
export function totalExposureCents(rows, cells = MAKER_V2_LIVE_CELLS) {
  const groups = [...new Set(cells.map(c => c.group))];
  return groups.reduce((sum, g) => sum + groupExposureCents(rows, g, cells), 0);
}

// Reconciles a real order's tracked filled_count against a freshly-summed fill window (2026-08-26
// fix — see the FIX comments at both call sites for the incident this closes). Never regresses
// below what was already recorded (a partial-window read must not erase a real earlier fill) and
// never exceeds the order's own size (a late/duplicate fill event must not overcount past 100%).
export function reconciledFilledCount(existingFilledCount, size, windowSum) {
  return Math.min(Number(size), Math.max(Number(existingFilledCount) || 0, Number(windowSum) || 0));
}
// A group is halted once its realized PnL breaches its own stop-loss — halted groups place no new
// orders and have any currently-resting orders actively canceled (see updateLiveMakerOrders).
export function haltedGroups(rows, cells = MAKER_V2_LIVE_CELLS) {
  const groups = [...new Set(cells.map(c => c.group))];
  const halted = new Set();
  for (const g of groups) {
    const cell = cells.find(c => c.group === g);
    if (groupRealizedCents(rows, g, cells) <= cell.stopLossCents) halted.add(g);
  }
  return halted;
}

// Pure eligibility computation — shared by the quote pass below AND the read-only
// /api/maker-v2-board endpoint (so "what's eligible" has exactly one definition; the endpoint
// re-derives it live from the same KV sources rather than trusting a stale cron-tick snapshot).
// Returns a Map: ticker → { q, row, series, cell }.
//
// Per-cell, not a single global band (contrast with the pre-2026-08-24 version of this function,
// which applied one MAKER_V2_BAND to every series): each market is matched against
// MAKER_V2_LIVE_CELLS by sport+category (matchLiveCell), and ONLY that cell's own band is checked
// — a row belonging to no live cell is never eligible, regardless of its price. `bothSides:true`
// on computeMakerQuote because a live cell's band is the sub-50 (longshot) side by design, not
// necessarily the higher-ask favorite that the single-side branch would pick.
export function computeWantedMakerQuotes({ snapResults, staging, nowMs = Date.now(), cells = MAKER_V2_LIVE_CELLS }) {
  const idx = new Map();
  for (const p of [...(staging?.plays || []), ...(staging?.dropped || [])]) {
    const t = p.kalshiTicker ?? p._ticker;
    if (!t) continue;
    const prev = idx.get(t);
    if (!prev || (prev.direction === "under" && p.direction !== "under")) idx.set(t, p);
  }

  const want = new Map(); // ticker → { q, row, series, cell }
  for (const [series, data] of Object.entries(snapResults || {})) {
    if (MAKER_FEE_SERIES.has(series)) continue;
    for (const m of (data?.markets || [])) {
      const row = idx.get(m?.ticker);
      if (!row) continue;
      const cell = matchLiveCell(row, cells);
      if (!cell) continue;
      const sides = computeMakerQuote(m, row, nowMs, cell.band, true);
      if (!sides?.length) continue;
      // A narrow 5¢ band practically never has both YES and NO in it at once (their asks sum to
      // ~100+spread); if it somehow did, take the first — not worth extra machinery for a 2-week,
      // $30-per-group trial to handle an edge case that would need a second resting order per
      // ticker, which the DB schema here (one row per ticker in restingByTicker) doesn't support.
      want.set(m.ticker, { q: sides[0], row, series, cell });
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

  // Whole table, not just resting — group exposure/stop-loss need graded rows too, and this
  // table only ever holds this trial's own orders (a few hundred rows over 2 weeks at this
  // sizing), so one full read per tick is cheap.
  const allOrders = await neonQuery(`SELECT * FROM maker_orders_v2`, [], env, { write: true });
  const resting = allOrders.filter(r => r.status === "resting");
  const restingByTicker = new Map(resting.map(r => [r.ticker, r]));
  const halted = haltedGroups(allOrders);

  // Poll real fills every tick, not just in the nightly reconcile — previously a resting order
  // that filled between ticks stayed 'resting' in the DB for up to ~10 hours (until the next
  // shadow-resolver run), which read as a stuck STATUS column even though Refresh was genuinely
  // re-querying Neon. 15min lookback tolerates a few missed ticks without re-scanning the day.
  //
  // FIX 2026-08-26 (found via a Kalshi-app screenshot vs /api/maker-v2-board cross-check, same
  // detection method as the 8/24 exposure-cap bug): candidates used to be built from `resting`
  // ONLY, and each matching fill event OVERWROTE filled_count with just that one event's own
  // count. A single Kalshi order that fills in more than one piece (confirmed live: a 25-count
  // order filled 4.12 then 20.88 four minutes apart, same order_id) got its FIRST partial fill
  // recorded, was immediately flipped to 'executed' and dropped out of `resting`, and every
  // SUBSEQUENT fill on that same still-partially-open order was silently never applied — real
  // exposure was understated (this one order: tracked 4/25 filled, real 25/25, ~$16 missing from
  // `groupExposureCents`, enough to push wnba-points ~29% over its $30 cap without the cap check
  // ever seeing it). Fix: candidates are any not-yet-fully-filled, non-canceled order regardless
  // of current status (an 'executed' row can still be short of its real total), and filled_count
  // is recomputed as the SUM of every matching fill event in this window, floored at whatever was
  // already recorded (never regress on a partial-window read) — not a single event's own count.
  const executedIds = new Set();
  const fillCandidates = allOrders.filter(r =>
    r.kalshi_order_id && r.status !== "canceled" && Number(r.filled_count) < Number(r.size));
  if (fillCandidates.length) {
    const fillsRes = await fetchKalshiFills({ minTs: Math.floor((nowMs - 15 * 60_000) / 1000) }, env)
      .catch(e => ({ ok: false, error: String(e?.message || e) }));
    if (fillsRes.ok && fillsRes.fills.length) {
      const byOrderId = new Map(fillCandidates.map(r => [r.kalshi_order_id, r]));
      const sumByOrderId = new Map();
      for (const f of fillsRes.fills) {
        if (!byOrderId.has(f.order_id)) continue;
        const count = Math.round(parseFloat(f.count ?? f.count_fp ?? "0")) || 0;
        sumByOrderId.set(f.order_id, (sumByOrderId.get(f.order_id) || 0) + count);
      }
      for (const [orderId, windowSum] of sumByOrderId) {
        const r = byOrderId.get(orderId);
        const newFilledCount = reconciledFilledCount(r.filled_count, r.size, windowSum);
        if (newFilledCount <= (Number(r.filled_count) || 0)) continue;
        await neonQuery(
          `UPDATE maker_orders_v2 SET filled_count = $2, status = 'executed' WHERE id = $1`,
          [r.id, newFilledCount], env, { write: true });
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
    if (r.live_group && halted.has(r.live_group)) {
      // Stop-loss breached for this group — cancel unconditionally, never place a replacement,
      // regardless of what `want` says (the group is done for this trial until a human re-arms
      // it). No `toExpireLocally` fallback here on purpose: waiting out expires_at could take up
      // to MAKER_V2_EXPIRATION_SEC longer than an explicit cancel needs to.
      toCancel.push(r);
      continue;
    }
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
    if (!restingByTicker.has(ticker) && !halted.has(w.cell.group)) toPlace.push({ ticker, ...w });
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

  // Group exposure starts from what's already outstanding (pre-existing resting/executed-
  // ungraded rows for that group) and accumulates as this tick places new orders, so the cap is
  // enforced against the true running total, not just this tick's placements.
  const groupExposure = new Map();
  const exposureFor = (group) => {
    if (!groupExposure.has(group)) groupExposure.set(group, groupExposureCents(allOrders, group));
    return groupExposure.get(group);
  };
  // Running portfolio total, seeded once and accumulated alongside groupExposure as this tick
  // places new orders — same running-total shape as the per-group cap, just summed across groups.
  let totalExposureRunning = totalExposureCents(allOrders);

  let opened = 0, capped = 0, errors = 0;
  for (const { ticker, q, row, series, cell } of toPlaceFiltered) {
    const gk = _gameKey(row);
    const gameCount = gameCounts.get(gk) || 0;
    if (globalCount >= MAKER_V2_MAX_CONCURRENT || gameCount >= MAKER_V2_SAME_GAME_CAP) { capped++; continue; }
    const costCents = cell.sizeContracts * (100 - q.ask); // real cost of the complementary buy sellAsBuy() places
    if (exposureFor(cell.group) + costCents > cell.capCents) { capped++; continue; }
    if (totalExposureRunning + costCents > MAKER_V2_GLOBAL_CAP_CENTS) { capped++; continue; }
    const expirationTime = Math.floor(nowMs / 1000) + MAKER_V2_EXPIRATION_SEC;
    const buyOrder = sellAsBuy(q.side, q.ask);
    const res = await placeKalshiOrder(
      { ticker, side: buyOrder.side, price: buyOrder.price, count: cell.sizeContracts, expirationTime }, env
    ).catch(e => ({ ok: false, error: String(e?.message || e) }));
    if (!res.ok) { errors++; console.error(`[maker-live] place ${ticker} failed: ${res.error}`); continue; }
    const filled = res.fillCount || 0;
    const status = res.remainingCount === 0 && filled > 0 ? "executed" : "resting";
    await neonQuery(
      `INSERT INTO maker_orders_v2
        (ticker, kalshi_order_id, client_order_id, series, sport, category, game_date, game_key,
         shadow_row_id, row_direction, side, price, size, filled_count, status, expires_at, live_group)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, to_timestamp($16), $17)`,
      [ticker, res.orderId, res.clientOrderId, series, row.sport ?? null, row.stat ?? row.gameType ?? null,
       row.gameDate ?? snapshotDate ?? null, gk, shadowId(row, snapshotDate), row.direction ?? null,
       q.side, q.ask, cell.sizeContracts, filled, status, expirationTime, cell.group],
      env, { write: true });
    opened++;
    globalCount++;
    gameCounts.set(gk, gameCount + 1);
    groupExposure.set(cell.group, exposureFor(cell.group) + costCents);
    totalExposureRunning += costCents;
  }

  return { eligible: want.size, canceled: canceledCount, failedCancels: failedCancelTickers.size,
    expiredLocally: toExpireLocally.length, opened, capped, errors, halted: [...halted] };
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
    // FIX 2026-08-26 (see updateLiveMakerOrders' matching fix for the full writeup) — 'executed'
    // rows must stay candidates too (an executed row can still be short of its real total from a
    // multi-piece fill the quote pass already missed once), and a matching order's filled_count
    // is recomputed as the SUM of every matching fill event this pass sees, floored at whatever
    // was already recorded, never a single event's own count.
    const tracked = await neonQuery(
      `SELECT id, kalshi_order_id, size, filled_count FROM maker_orders_v2
       WHERE game_date = $1 AND status != 'canceled' AND kalshi_order_id IS NOT NULL
         AND filled_count < size`,
      [dayPT], env, { write: true });
    const byOrderId = new Map(tracked.map(t => [t.kalshi_order_id, t]));
    const sumByOrderId = new Map();
    for (const f of fillsRes.fills) {
      if (!byOrderId.has(f.order_id)) continue;
      const count = Math.round(parseFloat(f.count ?? f.count_fp ?? "0")) || 0;
      sumByOrderId.set(f.order_id, (sumByOrderId.get(f.order_id) || 0) + count);
    }
    for (const [orderId, windowSum] of sumByOrderId) {
      const t = byOrderId.get(orderId);
      const filledCount = reconciledFilledCount(t.filled_count, t.size, windowSum);
      if (filledCount <= (Number(t.filled_count) || 0)) continue;
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
