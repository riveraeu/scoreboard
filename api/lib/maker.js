// Shadow maker engine — V1: simulated maker quotes, tape-replayed fills, settlement PnL.
//
// Thesis (pooled market-calibration scan 2026-07-19, n=44.5k): Kalshi's vig sits on the
// FAVORITE ask — 2-8¢ above realized frequency at 80-97¢, monotone in price — while longshot
// asks are ~fair. A maker selling the favorite side 1¢ inside the prevailing ask captures that
// richness, and maker fees are ZERO on every configured series except the four major *GAME
// series (fee_type sweep 2026-07-19). The unknown is adverse selection: fills arrive
// disproportionately when the quote is wrong. V1 measures exactly that with no capital:
//   • QUOTE (kalshi-snapshot cron, every 2 min, books already in hand): for each eligible
//     market, record a quote segment — sell {yes|no} at (prevailing ask − MAKER_INSIDE_C),
//     size MAKER_SIZE. Segments open/close as price or eligibility changes (maker_quotes).
//   • FILL (nightly resolver): replay the public trade tape — a taker trade on our side at
//     a price ≥ our ask while a segment was open would have hit us first (we quote strictly
//     inside the book, so price priority is ours). Fills cap at MAKER_SIZE (maker_fills).
//   • GRADE (2026-07-24 rewrite): look up each ticker's own settlement directly from Kalshi's
//     public /markets endpoint (kalshi-settlement.js) — no shadow_plays join, no ESPN dependency.
//     pnl_cents = fill_ask − 100·(sold side won).
// Measurement bias, stated: the 2-min quote lag means stale quotes get hit when price moves
// against them → shadow PnL UNDER-states a live engine with pull-on-news (conservative for
// the arm decision). Queue priority is ours by construction; self-effect on taker behavior is
// the one unmeasurable optimism.
// ARM CRITERION (V2, real orders): fill PnL CI-lo > 0 at n ≥ 200 fills. Forward-only,
// human-applied, like the category gate.
//
// Failure-closed: every exported IO entry point catches internally or is wrapped by its
// caller; a maker failure must never break the snapshot cron or the resolver.

import { capturableSpread, MAKER_BAND, MAKER_INSIDE_C, MAKER_SIZE } from "./config.js";
import { shadowId } from "./shadow-id.js";
import { neonQuery, neonExec } from "./neon.js";
import { fetchKalshiSettlements, resolveTickerSideViaKalshi } from "./kalshi-settlement.js";

// The only configured series with maker fees (fee_type "quadratic_with_maker_fees",
// verified 2026-07-19 across all 691 series). Everything else is plain "quadratic" = zero
// maker fee. Static by design — re-verify with the series API if Kalshi announces fee changes.
export const MAKER_FEE_SERIES = new Set(["KXMLBGAME", "KXNBAGAME", "KXNHLGAME", "KXWNBAGAME"]);

const _c = (dollars, cents) => {
  if (dollars != null) { const v = Math.round(parseFloat(dollars) * 100); return Number.isFinite(v) ? v : null; }
  return typeof cents === "number" ? cents : null;
};

// Pure eligibility + quote computation for one Kalshi market object + its staging row.
// `band` defaults to MAKER_BAND (V1 shadow); maker-live.js passes MAKER_V2_BAND to reuse the
// exact same eligibility logic for the narrower real-order scope instead of forking it.
// Returns { side, ask, yesAsk, yesBid, noAsk, noBid, spread } or null.
export function computeMakerQuote(m, stagingRow, nowMs, band = MAKER_BAND) {
  const yesAsk = _c(m?.yes_ask_dollars, m?.yes_ask), yesBid = _c(m?.yes_bid_dollars, m?.yes_bid);
  const noAsk = _c(m?.no_ask_dollars, m?.no_ask), noBid = _c(m?.no_bid_dollars, m?.no_bid);
  // Real two-sided book only: all four quotes present (0 = absent quote, not a price).
  if (!yesAsk || !yesBid || !noAsk || !noBid) return null;
  // ≥98 on either side = the stale-ask regime (priced off `last`) — skip the market entirely.
  if (yesAsk >= 98 || noAsk >= 98) return null;
  // Unified book: both sides share one spread when both asks exist.
  const spread = yesAsk - yesBid;
  if (!capturableSpread(spread)) return null;
  // Pre-game with a KNOWN future start — no in-play quoting, no unknown-start quoting.
  const gt = stagingRow?.gameTime ? Date.parse(stagingRow.gameTime) : NaN;
  if (!(gt > nowMs)) return null;
  // Favorite side in band (both sides ≥80 is impossible on a real book — sum ≤ 100+spread).
  let side = null, ask = null;
  if (yesAsk >= band[0] && yesAsk <= band[1]) { side = "yes"; ask = yesAsk - MAKER_INSIDE_C; }
  else if (noAsk >= band[0] && noAsk <= band[1]) { side = "no"; ask = noAsk - MAKER_INSIDE_C; }
  if (!side) return null;
  return { side, ask, yesAsk, yesBid, noAsk, noBid, spread };
}

// Pure fill replay for ONE ticker: segments (its quote history) × that day's trade tape.
// A fill = a taker trade on our sold side at a price ≥ our ask inside the segment window.
// `trades` rows: { trade_id, created_time, taker_side, yes_price_c, no_price_c, count }.
// Contracts cap at sizeCap per segment; trades consume in time order.
export function replayFills(segments, trades, sizeCap = MAKER_SIZE) {
  const fills = [];
  const sorted = [...trades].sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
  for (const s of segments) {
    const from = Date.parse(s.valid_from), to = s.valid_to ? Date.parse(s.valid_to) : Infinity;
    const ask = Number(s.quote_ask);
    let remaining = sizeCap;
    for (const t of sorted) {
      if (remaining <= 0) break;
      const ts = Date.parse(t.created_time);
      if (!(ts >= from && ts < to)) continue;
      if (t.taker_side !== s.quote_side) continue;
      const px = s.quote_side === "yes" ? t.yes_price_c : t.no_price_c;
      if (px == null || px < ask) continue;
      const take = Math.min(remaining, Number(t.count) || 0);
      if (take <= 0) continue;
      fills.push({ quote_id: s.id, ticker: s.ticker, trade_id: t.trade_id,
        traded_at: t.created_time, contracts: take, fill_ask: ask });
      remaining -= take;
    }
  }
  return fills;
}

let _ddlDone = false;
export async function ensureMakerTables(env) {
  if (_ddlDone) return;
  await neonExec(`
    CREATE TABLE IF NOT EXISTS maker_quotes (
      id SERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      series TEXT,
      sport TEXT,
      category TEXT,
      game_date TEXT,
      game_time TIMESTAMPTZ,
      shadow_row_id TEXT,
      row_direction TEXT,
      quote_side TEXT NOT NULL,
      quote_ask INT NOT NULL,
      size INT NOT NULL,
      book_yes_ask INT, book_yes_bid INT, book_no_ask INT, book_no_bid INT,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_to TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS maker_quotes_open_idx ON maker_quotes (ticker) WHERE valid_to IS NULL;
    CREATE INDEX IF NOT EXISTS maker_quotes_day_idx ON maker_quotes (game_date);
    -- Where a segment came from: 'live' (the 2-min quoting cron) or 'backfill'/'validate' (the
    -- 2026-07-28 tape replay, api/lib/maker-backfill.js). Defaulted so every pre-existing row is
    -- correctly labelled 'live' without a data migration. The board must never mix two sources for
    -- one day — the backfill endpoint refuses a day that already holds live segments.
    ALTER TABLE maker_quotes ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live';
    CREATE INDEX IF NOT EXISTS maker_quotes_day_src_idx ON maker_quotes (game_date, source);
    CREATE TABLE IF NOT EXISTS maker_fills (
      id SERIAL PRIMARY KEY,
      quote_id INT NOT NULL,
      ticker TEXT,
      trade_id TEXT NOT NULL,
      traded_at TIMESTAMPTZ,
      contracts NUMERIC,
      fill_ask INT,
      side_won BOOLEAN,
      pnl_cents NUMERIC,
      graded_at TIMESTAMPTZ,
      UNIQUE (quote_id, trade_id)
    )
  `, env);
  _ddlDone = true;
}

// Quote pass — runs inside the kalshi-snapshot cron with the just-fetched books in hand
// (zero extra Kalshi calls). Diffs desired quotes against open segments: unchanged → keep,
// changed/ineligible → close (valid_to), new → insert. Idempotent per cycle.
export async function updateMakerQuotes({ snapResults, staging, snapshotDate, env, nowMs = Date.now() }) {
  await ensureMakerTables(env);

  // Staging index: market ticker → play row (prefer the over/yes-framed row when a
  // total-style market logged both sides under one ticker).
  const idx = new Map();
  for (const p of [...(staging?.plays || []), ...(staging?.dropped || [])]) {
    const t = p.kalshiTicker ?? p._ticker;
    if (!t) continue;
    const prev = idx.get(t);
    if (!prev || (prev.direction === "under" && p.direction !== "under")) idx.set(t, p);
  }

  // Desired quotes this cycle.
  const want = new Map(); // ticker → { q, row, series }
  for (const [series, data] of Object.entries(snapResults || {})) {
    if (MAKER_FEE_SERIES.has(series)) continue;
    for (const m of (data?.markets || [])) {
      const row = idx.get(m?.ticker);
      if (!row) continue;
      const q = computeMakerQuote(m, row, nowMs);
      if (q) want.set(m.ticker, { q, row, series });
    }
  }

  // Diff against open segments.
  const open = await neonQuery(
    `SELECT id, ticker, quote_side, quote_ask FROM maker_quotes WHERE valid_to IS NULL`,
    [], env, { write: true });
  const keep = new Set();
  const toClose = [];
  for (const o of open) {
    const w = want.get(o.ticker);
    if (w && w.q.side === o.quote_side && w.q.ask === Number(o.quote_ask)) keep.add(o.ticker);
    else toClose.push(Number(o.id));
  }
  const toOpen = [...want.entries()].filter(([t]) => !keep.has(t));

  if (toClose.length) {
    await neonQuery(`UPDATE maker_quotes SET valid_to = NOW() WHERE id = ANY($1::int[])`,
      [toClose], env, { write: true });
  }
  if (toOpen.length) {
    const cols = ["ticker", "series", "sport", "category", "game_date", "game_time",
      "shadow_row_id", "row_direction", "quote_side", "quote_ask", "size",
      "book_yes_ask", "book_yes_bid", "book_no_ask", "book_no_bid"];
    const values = [];
    const tuples = toOpen.map(([ticker, { q, row, series }], i) => {
      values.push(ticker, series, row.sport ?? null, row.stat ?? row.gameType ?? null,
        row.gameDate ?? snapshotDate ?? null, row.gameTime ?? null,
        shadowId(row, snapshotDate), row.direction ?? null,
        q.side, q.ask, MAKER_SIZE, q.yesAsk, q.yesBid, q.noAsk, q.noBid);
      const base = i * cols.length;
      return `(${cols.map((_, j) => `$${base + j + 1}`).join(", ")})`;
    });
    await neonQuery(
      `INSERT INTO maker_quotes (${cols.join(", ")}) VALUES ${tuples.join(", ")}`,
      values, env, { write: true });
  }
  return { eligible: want.size, opened: toOpen.length, closed: toClose.length, kept: keep.size };
}

// ── Tape replay DISABLED 2026-07-28 ──────────────────────────────────────────────────────────
// V2 is shelved (no demonstrated fillable edge — see maker-live.js's SHELVED note and
// docs/MAKER_LEADTIME_PREREG.md), so nightly fill detection has no consumer. It was the expensive
// half of the maker engine: one Kalshi trades fetch per quoted ticker (~600/night) plus the fill
// inserts, against a question that is now answered.
//
// QUOTING deliberately keeps running. It costs nothing extra — the snapshot cron already has the
// books in hand — and the quote-side vig is the one maker finding that has replicated every single
// time (+1.5-1.6¢ across 100k+ segments), so `maker_quotes` remains a live measurement of the one
// real effect. `quotedOutcomes`/`adverseSelection` read segments and settlements, not fills.
//
// GRADING deliberately keeps running too. 622 fills were ungraded when this was switched off, and
// stopping mid-flight would leave the historical book permanently half-finished — precisely the
// state that makes a future revisit untrustworthy. `gradeMakerFills` early-returns on an empty
// candidate set, so once the backlog drains this costs one cheap Neon query a night and nothing
// more. Self-limiting, no follow-up chore required.
const TAPE_REPLAY_ENABLED = false;

// Fill detection + grading — runs in the nightly resolver. When enabled, replays the public trade
// tape for every ticker quoted on `dayPT` and inserts fills idempotently (UNIQUE quote_id+trade_id).
// Always grades ALL ungraded fills whose ticker has settled. Single tape page per ticker
// (limit 1000 — these markets trade well under that in a day; same call the flow stamp uses).
export async function detectAndGradeMakerFills({ env, dayPT }) {
  await ensureMakerTables(env);

  if (!TAPE_REPLAY_ENABLED) {
    const graded = await gradeMakerFills({ env });
    return { tickers: 0, newFills: 0, graded, tapeFails: 0, rateLimited: false,
      skipped: "tape_replay_disabled" };
  }
  // source='live' only: backfilled segments (api/lib/maker-backfill.js) replay their own tape in
  // their own batch pass, and re-replaying them here would double the work every night for the
  // overlap days without changing a row (fills are UNIQUE on quote_id+trade_id).
  const segs = await neonQuery(
    `SELECT id, ticker, quote_side, quote_ask, valid_from, valid_to
     FROM maker_quotes WHERE game_date = $1 AND source = 'live'`,
    [dayPT], env, { write: true });

  const byTicker = new Map();
  for (const s of segs) {
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, []);
    byTicker.get(s.ticker).push(s);
  }

  const fills = [];
  let tapeFails = 0, rateLimited = false;
  const minTs = Math.floor((Date.parse(`${dayPT}T00:00:00-07:00`) - 6 * 3600_000) / 1000);
  const tickers = [...byTicker.keys()];
  const BATCH = 4, DELAY = 250;
  for (let off = 0; off < tickers.length && !rateLimited; off += BATCH) {
    const batch = tickers.slice(off, off + BATCH);
    await Promise.all(batch.map(async (ticker) => {
      try {
        const r = await fetch(
          `https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=1000&min_ts=${minTs}`,
          { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
        if (r.status === 429) { rateLimited = true; return; }
        if (!r.ok) { tapeFails++; return; }
        const j = await r.json();
        const trades = (j?.trades || []).map(t => ({
          trade_id: t.trade_id, created_time: t.created_time, taker_side: t.taker_side,
          yes_price_c: t.yes_price_dollars != null ? Math.round(parseFloat(t.yes_price_dollars) * 100) : null,
          no_price_c: t.no_price_dollars != null ? Math.round(parseFloat(t.no_price_dollars) * 100) : null,
          count: parseFloat(t.count_fp ?? "0"), // count_fp is a decimal STRING
        }));
        fills.push(...replayFills(byTicker.get(ticker), trades));
      } catch { tapeFails++; }
    }));
    if (off + BATCH < tickers.length) await new Promise(res => setTimeout(res, DELAY));
  }

  if (fills.length) {
    const values = [];
    const tuples = fills.map((f, i) => {
      values.push(f.quote_id, f.ticker, f.trade_id, f.traded_at, f.contracts, f.fill_ask);
      const b = i * 6;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    await neonQuery(
      `INSERT INTO maker_fills (quote_id, ticker, trade_id, traded_at, contracts, fill_ask)
       VALUES ${tuples.join(", ")} ON CONFLICT (quote_id, trade_id) DO NOTHING`,
      values, env, { write: true });
  }

  const gradedCount = await gradeMakerFills({ env });

  return { tickers: tickers.length, newFills: fills.length, graded: gradedCount,
    tapeFails, rateLimited };
}

// Grades everything ungraded directly off Kalshi's own public settlement for the ticker (2026-07-
// 24 rewrite, same move V2 made 2026-07-22 — see project_maker_v1_settlement_grading memory).
// V1 never holds a real position, so it can't use the authenticated /portfolio/settlements
// endpoint V2 reads; it uses the public /markets endpoint instead (kalshi-settlement.js), which
// works for any ticker regardless of whether we ever traded it. This needs only `ticker` +
// `quote_side` — both native to maker_quotes — so grading no longer joins shadow_plays at all,
// which removes two known bug classes at the root: the shadowId team-total collision and the
// spread pickTeam/marginTeam sign mismatch (both were only reachable via that join).
// Split from detectAndGradeMakerFills so a formula fix can be re-applied to ALREADY-INSERTED
// maker_fills rows (clear graded_at back to NULL, then call this) without re-replaying the tape.
export async function gradeMakerFills({ env }) {
  await ensureMakerTables(env);
  const candidates = await neonQuery(
    `SELECT q.id AS quote_id, q.ticker, q.quote_side
     FROM maker_quotes q
     WHERE EXISTS (SELECT 1 FROM maker_fills mf2 WHERE mf2.quote_id = q.id AND mf2.graded_at IS NULL)`,
    [], env, { write: true }
  );
  if (!candidates.length) return 0;

  // Fail-closed: if settlements can't be fetched, skip grading entirely this pass — retried
  // next tick via the same `graded_at IS NULL` gate, rather than guess.
  const tickers = [...new Set(candidates.map(c => c.ticker))];
  const settlements = await fetchKalshiSettlements(tickers);

  const toGrade = [];
  for (const c of candidates) {
    const sideWon = resolveTickerSideViaKalshi(c.ticker, c.quote_side, settlements);
    if (sideWon === null) continue; // not finalized yet, or a void/scalar result — retry next pass
    toGrade.push({ quoteId: c.quote_id, sideWon });
  }
  if (!toGrade.length) return 0;

  let gradedCount = 0;
  const chunkSize = 100;
  for (let i = 0; i < toGrade.length; i += chunkSize) {
    const chunk = toGrade.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, ri) => `($${ri * 2 + 1}::int, $${ri * 2 + 2}::boolean)`).join(", ");
    const values = chunk.flatMap(c => [c.quoteId, c.sideWon]);
    const graded = await neonQuery(
      `UPDATE maker_fills mf SET
         side_won = v.side_won,
         pnl_cents = mf.fill_ask - CASE WHEN v.side_won THEN 100 ELSE 0 END,
         graded_at = NOW()
       FROM (VALUES ${placeholders}) AS v(quote_id, side_won)
       WHERE mf.quote_id = v.quote_id AND mf.graded_at IS NULL
       RETURNING mf.id`,
      values, env, { write: true });
    gradedCount += graded.length;
  }

  return gradedCount;
}
