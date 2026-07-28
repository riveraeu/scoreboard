// Maker V1 tape backfill — reconstructs historical quote segments + fills straight from Kalshi,
// for days that predate the live quoting cron (which started 2026-07-19).
//
// ── Why this exists ──
// The V1 arm gate is `dayClustered.loCI > 0` (api/lib/maker-stats.js): the DAY is the independent
// unit, because V1 sells favorites across a whole slate, so one day's PnL is essentially one bet on
// whether favorites underperformed. At the 2026-07-28 reading — mean +1.55¢/contract, day-clustered
// se 2.18 on 9 days — clearing the gate needs se ≤ 0.79, i.e. ~69 days. Waiting for that is two
// months. Fills are not the constraint (14,974 of them); DAYS are.
//
// Kalshi serves enough history to replay those days instead of waiting for them:
//   • GET /series/{s}/markets/{t}/candlesticks?period_interval=1 → yes_bid/yes_ask OHLC per minute,
//     retained for at least 8 weeks (verified 2026-07-28 on a 2026-06-02 market).
//   • GET /markets/trades?ticker&min_ts&max_ts&cursor → the same public tape the live path replays.
//   • GET /markets?series_ticker&min_close_ts&max_close_ts → the day's market universe.
// The engine spec has been frozen since 2026-07-19, so replaying it over earlier days is an
// out-of-sample-in-time test, not a refit.
//
// ── What is reused, deliberately ──
// Eligibility is `computeMakerQuote` and fill detection is `replayFills`, both imported from
// maker.js untouched. This module contributes ONLY the two things that genuinely differ in a batch
// replay: turning sparse candlesticks into a poll-cadence sample series, and turning that series
// into segments. If it reimplemented quoting or filling, the two paths would drift and the
// live-vs-backfill fidelity comparison — the entire basis for trusting backfilled days — would be
// measuring the drift instead of the data.
//
// ── The NO side ──
// Candlesticks carry only yes_bid/yes_ask. Kalshi's book is unified and YES-terms, so
//   no_bid = 100 − yes_ask     no_ask = 100 − yes_bid
// Verified exactly across live markets 2026-07-28. NOTE this is NOT the synthesis CLAUDE.md warns
// about ("use no_ask_dollars, not 1 − yes_ask_dollars"): that warning is against `100 − yes_ASK`,
// which lands on the bid side and understates the NO ask by the whole spread. Taking the NO ask off
// the YES BID is the correct identity, and it is what computeMakerQuote already assumes when it
// derives one `spread = yesAsk − yesBid` for both sides. The overlap validation re-checks it against
// stored live `book_no_ask` values rather than trusting the reasoning.
//
// ── Scope: MLB prop series only (phase 1) ──
// These five encode HHMM in their event ticker, so `gameTime` — which computeMakerQuote's pre-game
// gate requires — comes from the ticker itself. That matters: `shadow_plays.kalshi_ticker` only
// exists from 2026-07-23, so any backfill that needed a shadow row to supply gameTime would reach
// back exactly zero useful days. Series carrying a date but no HHMM (WNBA props, tennis, UFC,
// NBASL) and series with no parseable date at all (golf, NASCAR) are out of scope rather than
// guessed at. None of the five is in MAKER_FEE_SERIES.
//
// Failure-closed, like the rest of the maker engine: this is an admin-triggered batch path and can
// never run inside the snapshot cron or the resolver.

import { computeMakerQuote, replayFills, ensureMakerTables, MAKER_FEE_SERIES } from "./maker.js";
import { MAKER_BAND, MAKER_SIZE } from "./config.js";
import { SERIES_CONFIG } from "./series-config.js";
import { kalshiTickerDate, kalshiTickerGameTime } from "./kalshi-ticker.js";
import { neonQuery } from "./neon.js";
import { pLimit } from "./utils.js";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// The five MLB prop series (see the scope note above). Everything here is checked against
// SERIES_CONFIG at module load so a rename upstream fails loudly instead of silently backfilling
// nothing.
export const BACKFILL_SERIES = ["KXMLBKS", "KXMLBHRR", "KXMLBHIT", "KXMLBTB", "KXMLBOUTS"];
for (const s of BACKFILL_SERIES) {
  if (!SERIES_CONFIG[s]) throw new Error(`maker-backfill: ${s} missing from SERIES_CONFIG`);
  if (MAKER_FEE_SERIES.has(s)) throw new Error(`maker-backfill: ${s} carries maker fees`);
}

// Emulate the live quoting cadence: the kalshi-snapshot cron polls every 2 minutes.
export const SAMPLE_STEP_MIN = 2;
// How far before game time to start sampling. The live path only quotes markets present in shadow
// staging, which covers roughly yesterday…D+2; 24h is a deliberate, documented cut that keeps the
// sample grid bounded when a market opened days early with one lonely quote.
export const BACKFILL_LOOKBACK_MS = 24 * 3600_000;

const FETCH_TIMEOUT_MS = 10_000;
const FETCH_CONCURRENCY = 6;   // ≈ the live tape path's 4-per-250ms, without fixed sleeps
// The live path (detectAndGradeMakerFills) reads ONE 1000-trade page per ticker; this paginates.
// A deliberate, documented difference: a pre-game prop window carries single-digit trades in
// practice (6 on the 2026-07-27 market this was verified against), so the two agree everywhere it
// matters, and where they don't, the paginated read is the correct one. The overlap validation
// quantifies the gap rather than assuming it away.
const TRADE_PAGE_LIMIT = 1000;
const MAX_TRADE_PAGES = 10;
const INSERT_CHUNK = 400;

const _cents = (dollars) => {
  if (dollars == null) return 0;
  const v = Math.round(parseFloat(dollars) * 100);
  return Number.isFinite(v) ? v : 0;
};

// ── Pure: candlesticks → poll-cadence samples ────────────────────────────────────────────────
/**
 * Kalshi emits a candle only for periods with activity, so gaps mean "nothing changed", not "no
 * book" — the last close is carried forward across them. That carry-forward is the single biggest
 * fidelity assumption in this module, which is why phase 1 validates against live days before any
 * backfilled day is read.
 *
 * Carrying forward across a gap cannot invent a fill: a trade IS activity and would have produced
 * its own candle, so a gap is provably trade-free. It affects segment duration only.
 *
 * @param candles  raw `candlesticks` array (end_period_ts seconds; yes_bid/yes_ask close_dollars)
 * @param opts.untilMs  extend the grid to here (game time) — the live cron kept polling until the
 *                      pre-game gate closed, so the grid should too
 * @returns [{ tsMs, market }] where `market` is the cents-shaped object computeMakerQuote reads
 */
export function buildSamples(candles, { untilMs = null, stepMin = SAMPLE_STEP_MIN } = {}) {
  const pts = (candles || [])
    .map((c) => ({
      tsMs: Number(c?.end_period_ts) * 1000,
      yesAsk: _cents(c?.yes_ask?.close_dollars),
      yesBid: _cents(c?.yes_bid?.close_dollars),
    }))
    .filter((p) => Number.isFinite(p.tsMs) && p.tsMs > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
  if (!pts.length) return [];

  const stepMs = stepMin * 60_000;
  const start = pts[0].tsMs;
  const end = Math.max(pts[pts.length - 1].tsMs, untilMs ?? 0);
  if (!(end >= start)) return [];

  const samples = [];
  let i = 0, last = null;
  for (let ts = start; ts <= end; ts += stepMs) {
    while (i < pts.length && pts[i].tsMs <= ts) last = pts[i++];
    if (!last) continue;
    // 0 = absent quote, not a price — passed through as-is so computeMakerQuote rejects it for the
    // same reason it rejects a live market with an empty side.
    const yesAsk = last.yesAsk, yesBid = last.yesBid;
    samples.push({
      tsMs: ts,
      market: {
        yes_ask: yesAsk, yes_bid: yesBid,
        no_ask: yesBid ? 100 - yesBid : 0,
        no_bid: yesAsk ? 100 - yesAsk : 0,
      },
    });
  }
  return samples;
}

// ── Pure: samples → quote segments ───────────────────────────────────────────────────────────
/**
 * Mirrors what `updateMakerQuotes` does incrementally in the live cron: a segment stays open while
 * (side, ask) is unchanged, and closes the moment either changes or the market stops being
 * eligible. Batch-shaped only because the whole day is known up front.
 *
 * @param samples     from buildSamples
 * @param stagingRow  { gameTime } — the one field computeMakerQuote reads off a staging row
 * @returns [{ side, ask, validFrom, validTo, bookYesAsk, bookYesBid, bookNoAsk, bookNoBid }]
 */
export function segmentsFromSamples(samples, stagingRow, band = MAKER_BAND) {
  const out = [];
  let cur = null;
  const close = (tsMs) => { if (cur) { cur.validTo = new Date(tsMs).toISOString(); out.push(cur); cur = null; } };

  for (const s of samples) {
    const q = computeMakerQuote(s.market, stagingRow, s.tsMs, band);
    if (!q) { close(s.tsMs); continue; }
    if (cur && cur.side === q.side && cur.ask === q.ask) continue;
    close(s.tsMs);
    cur = {
      side: q.side, ask: q.ask,
      validFrom: new Date(s.tsMs).toISOString(), validTo: null,
      bookYesAsk: q.yesAsk, bookYesBid: q.yesBid, bookNoAsk: q.noAsk, bookNoBid: q.noBid,
    };
  }
  // A segment still open at the end of the grid ran to game time. Extending it by one more poll
  // interval is right in general, but it MUST be clamped to game time: the 2-minute grid rarely
  // lands exactly on first pitch, so the unclamped tail overshoots by up to a poll — and a trade in
  // that overshoot is an in-play trade, which would manufacture a fill V1 never makes. Caught by
  // replaying a real 2026-07-27 market, where the tail ran to 23:46 on a 23:45 game.
  if (cur) {
    const gt = stagingRow?.gameTime ? Date.parse(stagingRow.gameTime) : NaN;
    const tail = samples[samples.length - 1].tsMs + SAMPLE_STEP_MIN * 60_000;
    close(Number.isFinite(gt) ? Math.min(tail, gt) : tail);
  }
  return out;
}

// ── IO ───────────────────────────────────────────────────────────────────────────────────────
async function kalshiJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 429) { const e = new Error("rate_limited"); e.rateLimited = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Every market in the backfill series that belongs to game date `dayPT`. The close-time window is
 * intentionally loose (games run past midnight ET) and then narrowed by the ticker's own date
 * segment, which is authoritative for WHICH game a market is about — same rule the resolver's date
 * ladder and `?backfillgamedate=1` use.
 */
export async function listDayMarkets(dayPT) {
  // Deliberately offset-agnostic: a generous UTC-anchored window, narrowed by the ticker date
  // below. Anchoring it on an assumed ET offset would be a latent DST bug for no benefit, since
  // the ticker filter — not the window — is what decides which markets belong to the day.
  const dayStart = Date.parse(`${dayPT}T00:00:00Z`) / 1000 - 12 * 3600;
  const windowEnd = dayStart + 64 * 3600;
  const out = [];
  for (const series of BACKFILL_SERIES) {
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const url = `${KALSHI_BASE}/markets?series_ticker=${series}&limit=1000`
        + `&min_close_ts=${Math.floor(dayStart)}&max_close_ts=${Math.floor(windowEnd)}`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const j = await kalshiJson(url);
      const markets = j?.markets || [];
      for (const m of markets) {
        if (!m?.ticker) continue;
        if (kalshiTickerDate(m.ticker) !== dayPT) continue;
        out.push({ ticker: m.ticker, series });
      }
      cursor = j?.cursor || "";
      if (!cursor || !markets.length) break;
    }
  }
  // Deterministic order so `offset` slices are stable across invocations.
  out.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  return out;
}

async function fetchCandles(series, ticker, startSec, endSec) {
  const url = `${KALSHI_BASE}/series/${series}/markets/${encodeURIComponent(ticker)}/candlesticks`
    + `?start_ts=${startSec}&end_ts=${endSec}&period_interval=1`;
  const j = await kalshiJson(url);
  return j?.candlesticks || [];
}

async function fetchTrades(ticker, startSec, endSec) {
  const trades = [];
  let cursor = "";
  for (let page = 0; page < MAX_TRADE_PAGES; page++) {
    const url = `${KALSHI_BASE}/markets/trades?ticker=${encodeURIComponent(ticker)}`
      + `&limit=${TRADE_PAGE_LIMIT}&min_ts=${startSec}&max_ts=${endSec}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const j = await kalshiJson(url);
    const batch = j?.trades || [];
    for (const t of batch) {
      trades.push({
        trade_id: t.trade_id,
        created_time: t.created_time,
        taker_side: t.taker_side,
        yes_price_c: t.yes_price_dollars != null ? Math.round(parseFloat(t.yes_price_dollars) * 100) : null,
        no_price_c: t.no_price_dollars != null ? Math.round(parseFloat(t.no_price_dollars) * 100) : null,
        count: parseFloat(t.count_fp ?? "0"), // count_fp is a decimal STRING
      });
    }
    cursor = j?.cursor || "";
    if (!cursor || !batch.length) break;
  }
  return trades;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────────────────────
/**
 * Backfill ONE day, one `offset`-sliced chunk of its tickers.
 *
 * Resumable by design: 2,610 MLB prop markets closed on 2026-07-27, and at ~2 fetches each that is
 * more than fits in one 300s invocation. The caller drives `offset` forward using `nextOffset`.
 *
 * Idempotent PER CHUNK — every ticker in the chunk has its existing (day, source) rows deleted
 * before insert — so a re-run, a partial run, or an out-of-order run all converge. Chunk-scoped
 * rather than day-scoped precisely so resuming at offset N never wipes offsets 0…N−1.
 *
 * `source` tags the rows: 'backfill' for real history, 'validate' for the overlap comparison
 * against live days (which must never be mixed into the board). Guarded: a day that already holds
 * live segments cannot be written as 'backfill'.
 */
export async function backfillMakerDay({
  env, dayPT, tickers, offset = 0, limit = 400, source = "backfill",
  band = MAKER_BAND, restrictTo = null, deadlineMs = null,
}) {
  await ensureMakerTables(env);
  const slice = tickers.slice(offset, offset + limit);
  const stats = {
    day: dayPT, source, offset, examined: slice.length,
    quoted: 0, segments: 0, fills: 0, noCandles: 0, noGameTime: 0,
    fetchFails: 0, rateLimited: false, stoppedEarly: false,
  };
  if (!slice.length) return { ...stats, nextOffset: null };

  const lim = pLimit(FETCH_CONCURRENCY);
  const perTicker = new Map(); // ticker → { series, gameTimeIso, segments[] }

  // Pass 1 — candlesticks → segments, for every ticker in the slice.
  await Promise.all(slice.map(({ ticker, series }) => lim(async () => {
    if (stats.rateLimited) return;
    if (deadlineMs && Date.now() > deadlineMs) { stats.stoppedEarly = true; return; }
    if (restrictTo && !restrictTo.has(ticker)) return;
    const gameTimeIso = kalshiTickerGameTime(ticker);
    if (!gameTimeIso) { stats.noGameTime++; return; }
    const gameMs = Date.parse(gameTimeIso);
    const startSec = Math.floor((gameMs - BACKFILL_LOOKBACK_MS) / 1000);
    const endSec = Math.ceil(gameMs / 1000);
    try {
      const candles = await fetchCandles(series, ticker, startSec, endSec);
      if (!candles.length) { stats.noCandles++; return; }
      const samples = buildSamples(candles, { untilMs: gameMs });
      const segments = segmentsFromSamples(samples, { gameTime: gameTimeIso }, band);
      if (segments.length) perTicker.set(ticker, { series, gameTimeIso, segments });
    } catch (e) {
      if (e?.rateLimited) stats.rateLimited = true; else stats.fetchFails++;
    }
  })));

  stats.quoted = perTicker.size;
  stats.segments = [...perTicker.values()].reduce((n, v) => n + v.segments.length, 0);

  // Clear this chunk's prior rows before writing, so the whole pass is a replace.
  const chunkTickers = slice.map((s) => s.ticker);
  await deleteBackfillRows({ env, dayPT, source, tickers: chunkTickers });
  if (!perTicker.size) return { ...stats, nextOffset: offset + slice.length < tickers.length ? offset + slice.length : null };

  // Insert segments, reading back the ids replayFills needs to key its fills on.
  const quoteIds = await insertSegments({ env, dayPT, source, perTicker });

  // Pass 2 — trade tape, only for tickers that actually rested a quote.
  const fills = [];
  if (!stats.rateLimited) {
    await Promise.all([...perTicker.entries()].map(([ticker, v]) => lim(async () => {
      if (stats.rateLimited) return;
      if (deadlineMs && Date.now() > deadlineMs) { stats.stoppedEarly = true; return; }
      const segs = quoteIds.get(ticker) || [];
      if (!segs.length) return;
      const startSec = Math.floor(Date.parse(segs[0].valid_from) / 1000);
      const endSec = Math.ceil(Date.parse(v.gameTimeIso) / 1000);
      try {
        const trades = await fetchTrades(ticker, startSec, endSec);
        fills.push(...replayFills(segs, trades, MAKER_SIZE));
      } catch (e) {
        if (e?.rateLimited) stats.rateLimited = true; else stats.fetchFails++;
      }
    })));
  }

  if (fills.length) await insertFills({ env, fills });
  stats.fills = fills.length;

  const next = offset + slice.length;
  return { ...stats, nextOffset: next < tickers.length ? next : null };
}

async function deleteBackfillRows({ env, dayPT, source, tickers }) {
  if (!tickers.length) return;
  for (let i = 0; i < tickers.length; i += INSERT_CHUNK) {
    const chunk = tickers.slice(i, i + INSERT_CHUNK);
    await neonQuery(
      `DELETE FROM maker_fills WHERE quote_id IN (
         SELECT id FROM maker_quotes
          WHERE game_date = $1 AND source = $2 AND ticker = ANY($3::text[]))`,
      [dayPT, source, chunk], env, { write: true });
    await neonQuery(
      `DELETE FROM maker_quotes
        WHERE game_date = $1 AND source = $2 AND ticker = ANY($3::text[])`,
      [dayPT, source, chunk], env, { write: true });
  }
}

// Inserts segments and returns ticker → [{ id, ticker, quote_side, quote_ask, valid_from, valid_to }],
// the exact row shape replayFills expects (it reads the same fields the live path selects).
async function insertSegments({ env, dayPT, source, perTicker }) {
  const rows = [];
  for (const [ticker, v] of perTicker) {
    const cfg = SERIES_CONFIG[v.series] || {};
    for (const s of v.segments) {
      rows.push([
        ticker, v.series, cfg.sport ?? null, cfg.stat ?? null, dayPT, v.gameTimeIso,
        // shadow_row_id stays NULL: there is no shadow_plays row behind a backfilled segment, and
        // grading has not joined shadow_plays since the 2026-07-24 rewrite, so nothing needs it.
        null, null, s.side, s.ask, MAKER_SIZE,
        s.bookYesAsk, s.bookYesBid, s.bookNoAsk, s.bookNoBid,
        s.validFrom, s.validTo, source,
      ]);
    }
  }
  const cols = ["ticker", "series", "sport", "category", "game_date", "game_time",
    "shadow_row_id", "row_direction", "quote_side", "quote_ask", "size",
    "book_yes_ask", "book_yes_bid", "book_no_ask", "book_no_bid",
    "valid_from", "valid_to", "source"];
  const byTicker = new Map();
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const values = chunk.flat();
    const tuples = chunk.map((_, ri) => {
      const base = ri * cols.length;
      return `(${cols.map((__, cj) => `$${base + cj + 1}`).join(", ")})`;
    });
    const inserted = await neonQuery(
      `INSERT INTO maker_quotes (${cols.join(", ")}) VALUES ${tuples.join(", ")}
       RETURNING id, ticker, quote_side, quote_ask, valid_from, valid_to`,
      values, env, { write: true });
    for (const r of inserted) {
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
      byTicker.get(r.ticker).push(r);
    }
  }
  for (const list of byTicker.values()) {
    list.sort((a, b) => Date.parse(a.valid_from) - Date.parse(b.valid_from));
  }
  return byTicker;
}

async function insertFills({ env, fills }) {
  for (let i = 0; i < fills.length; i += INSERT_CHUNK) {
    const chunk = fills.slice(i, i + INSERT_CHUNK);
    const values = [];
    const tuples = chunk.map((f, ri) => {
      values.push(f.quote_id, f.ticker, f.trade_id, f.traded_at, f.contracts, f.fill_ask);
      const b = ri * 6;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    await neonQuery(
      `INSERT INTO maker_fills (quote_id, ticker, trade_id, traded_at, contracts, fill_ask)
       VALUES ${tuples.join(", ")} ON CONFLICT (quote_id, trade_id) DO NOTHING`,
      values, env, { write: true });
  }
}

/**
 * Live-vs-backfill comparison for one overlap day. This is the gate on the whole approach: if a
 * replayed 2026-07-24 does not reproduce the live day's PnL, nothing downstream is trustworthy.
 * `bookNoAskMismatches` is the direct check on the NO-side complement identity — it must be 0.
 */
export async function compareSourcesForDay({ env, dayPT, source = "validate" }) {
  // Both sides MUST be scoped to the tickers the replay actually covers. The live cron quotes every
  // configured series while the backfill is MLB props only, so an unscoped day-level comparison
  // would put ~5× the segments on the live side and read as a catastrophic mismatch that is really
  // just the two populations being different. Same avgAsk-mix discipline the maker board has now
  // needed three times.
  const scope = `q.game_date = $1 AND q.ticker IN (
    SELECT ticker FROM maker_quotes WHERE game_date = $1 AND source = $2)`;

  const [agg] = await neonQuery(
    `SELECT
       COUNT(*) FILTER (WHERE q.source = 'live')      AS live_segments,
       COUNT(*) FILTER (WHERE q.source = $2)          AS bf_segments,
       COUNT(DISTINCT q.ticker) FILTER (WHERE q.source = 'live') AS live_tickers,
       COUNT(DISTINCT q.ticker) FILTER (WHERE q.source = $2)     AS bf_tickers,
       AVG(q.quote_ask) FILTER (WHERE q.source = 'live')  AS live_avg_ask,
       AVG(q.quote_ask) FILTER (WHERE q.source = $2)      AS bf_avg_ask
     FROM maker_quotes q WHERE ${scope}`,
    [dayPT, source], env, { write: true });

  const [fillAgg] = await neonQuery(
    `SELECT
       COUNT(*) FILTER (WHERE q.source = 'live') AS live_fills,
       COUNT(*) FILTER (WHERE q.source = $2)     AS bf_fills,
       SUM(f.contracts) FILTER (WHERE q.source = 'live') AS live_contracts,
       SUM(f.contracts) FILTER (WHERE q.source = $2)     AS bf_contracts,
       SUM(f.pnl_cents * f.contracts) FILTER (WHERE q.source = 'live' AND f.graded_at IS NOT NULL) AS live_pnl,
       SUM(f.pnl_cents * f.contracts) FILTER (WHERE q.source = $2 AND f.graded_at IS NOT NULL)     AS bf_pnl,
       SUM(f.contracts) FILTER (WHERE q.source = 'live' AND f.graded_at IS NOT NULL) AS live_graded_contracts,
       SUM(f.contracts) FILTER (WHERE q.source = $2 AND f.graded_at IS NOT NULL)     AS bf_graded_contracts
     FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
     WHERE ${scope}`,
    [dayPT, source], env, { write: true });

  // The complement identity, checked against what the live cron actually stored. Joined on the
  // book's YES side so only genuinely comparable observations are compared.
  const [noAsk] = await neonQuery(
    `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE l.book_no_ask <> b.book_no_ask) AS mismatches
       FROM maker_quotes l
       JOIN maker_quotes b
         ON b.ticker = l.ticker AND b.game_date = l.game_date AND b.source = $2
        AND b.book_yes_ask = l.book_yes_ask AND b.book_yes_bid = l.book_yes_bid
      WHERE l.game_date = $1 AND l.source = 'live'`,
    [dayPT, source], env, { write: true });

  const num = (v) => (v == null ? null : Number(v));
  const perContract = (pnl, c) => (c > 0 ? Math.round((Number(pnl) / Number(c)) * 100) / 100 : null);
  return {
    day: dayPT,
    segments: { live: num(agg?.live_segments), backfill: num(agg?.bf_segments) },
    tickers: { live: num(agg?.live_tickers), backfill: num(agg?.bf_tickers) },
    avgAsk: {
      live: agg?.live_avg_ask == null ? null : Math.round(Number(agg.live_avg_ask) * 100) / 100,
      backfill: agg?.bf_avg_ask == null ? null : Math.round(Number(agg.bf_avg_ask) * 100) / 100,
    },
    fills: { live: num(fillAgg?.live_fills), backfill: num(fillAgg?.bf_fills) },
    contracts: { live: num(fillAgg?.live_contracts), backfill: num(fillAgg?.bf_contracts) },
    pnlPerContract: {
      live: perContract(fillAgg?.live_pnl, fillAgg?.live_graded_contracts),
      backfill: perContract(fillAgg?.bf_pnl, fillAgg?.bf_graded_contracts),
    },
    bookNoAskCompared: num(noAsk?.n),
    bookNoAskMismatches: num(noAsk?.mismatches),
  };
}

/** Live segments exist for this day → refuse to write 'backfill' rows into it. */
export async function dayHasLiveSegments({ env, dayPT }) {
  const [r] = await neonQuery(
    `SELECT COUNT(*) AS n FROM maker_quotes WHERE game_date = $1 AND source = 'live'`,
    [dayPT], env, { write: true });
  return Number(r?.n || 0) > 0;
}
