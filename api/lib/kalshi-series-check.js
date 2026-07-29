// api/lib/kalshi-series-check.js
// Shared "does this series have a real book" fetch — extracted 2026-07-23 from the
// kalshi-series-scan enrichment logic so both the scan (bulk, minimal shape) and the standing
// admin diagnostic `/api/kalshi-check` (single-ticker, full detail) share one fetch+retry path
// instead of drifting. Series vetting is a recurring task in this codebase (this is the Nth
// triage session); worth a shared, reusable helper rather than a one-off.

import { CAPTURE_MAX_SPREAD } from "./config.js";

// ── SERIES SCREEN (2026-07-28) — replaces the `window_fit` triage hint ────────────────────────
// `window_fit` asked "does any market quote inside [67,91]¢" — the TAKER bet window, from a
// strategy closed 2026-07-28 (docs/REENTRY.md), and a known false-positive generator on longshot
// NO quotes (it is why the NASCAR/LoL vetting was deferred). It ranked the triage queue by a
// broken proxy for something we no longer do.
//
// The replacement answers REENTRY.md's condition #1 instead — "a new market class with real
// books" — whose criteria are already numeric: real two-sided books within CAPTURE_MAX_SPREAD,
// overround ≈ 1, enough volume. All of it comes off markets the scan ALREADY fetches, so the
// screen costs zero extra Kalshi calls.
//
// **Spread is the discriminator, not volume.** Established twice over in this codebase: real
// rungs are frequently 0-volume, while a dead book betrays itself by a wide/one-sided quote
// (the totalBases 94¢ artifact, the segment-overround artifact). So the auto-dismiss gates below
// key off spread and two-sidedness; volume is carried as context only.
const MIN_JUDGE = 5;        // fewer live markets than this → not enough evidence to call it dead
const MIN_REAL_BOOKS = 5;   // real two-sided books needed to call a series REAL_BOOK

// Verdicts. Only EMPTY_SHELL and DEAD_BOOK are auto-actioned (dismiss — the stop direction);
// THIN is the deliberate "not enough evidence" bucket that stays in the human queue rather than
// being forced into a call it hasn't earned.
export const SCREEN_AUTO_DISMISS = ["EMPTY_SHELL", "DEAD_BOOK"];

const _median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Pure — takes the markets array, returns the screen. Exported for direct testing: this function
// decides what gets auto-dismissed, so a wrong answer silently hides a real market class.
export function screenMarkets(markets) {
  const n = (markets || []).length;
  const base = { live_market_count: n, real_book_count: 0, real_book_frac: null,
    median_spread_c: null, overround: null, volume_total: 0 };
  if (!n) return { ...base, screen: "EMPTY_SHELL" };

  let realBooks = 0, volumeTotal = 0;
  const spreads = [];
  const askByEvent = new Map();   // event_ticker → { sum of yes asks, market count }
  for (const m of markets) {
    const ya = parseFloat(m.yes_ask_dollars), yb = parseFloat(m.yes_bid_dollars);
    const na = parseFloat(m.no_ask_dollars), nb = parseFloat(m.no_bid_dollars);
    volumeTotal += parseFloat(m.volume_fp) || 0;
    if (ya > 0 && yb > 0 && na > 0 && nb > 0) {
      realBooks++;
      // Kalshi's book is unified — when both asks exist both sides share one spread — so gate on
      // the tighter side, the same min() the tonight.js total/spread branches already use.
      spreads.push(Math.min(Math.round((ya - yb) * 100), Math.round((na - nb) * 100)));
    }
    if (ya > 0) {
      const ev = m.event_ticker || m.ticker;
      const cur = askByEvent.get(ev) || { sum: 0, count: 0 };
      askByEvent.set(ev, { sum: cur.sum + ya, count: cur.count + 1 });
    }
  }

  // Overround (avgMarket × sides ≈ 1 for a real book) is computed ONLY over 2- and 3-market
  // events — i.e. shapes that are plausibly mutually exclusive and exhaustive, like 2-way ML or
  // 3-way 1X2. An alt-line ladder puts ~10 non-exclusive strikes under one event, whose asks sum
  // to ~3.5 by construction; scoring that as overround 3.5 would read "dead" on a perfectly real
  // totals market. Reported as a diagnostic, NEVER gated on, for exactly that reason.
  const exclusive = [...askByEvent.values()].filter(e => e.count === 2 || e.count === 3);
  const overround = exclusive.length ? _median(exclusive.map(e => e.sum)) : null;

  const medianSpread = _median(spreads);
  const out = {
    live_market_count: n,
    real_book_count: realBooks,
    real_book_frac: parseFloat((realBooks / n).toFixed(3)),
    median_spread_c: medianSpread,
    overround: overround != null ? parseFloat(overround.toFixed(3)) : null,
    volume_total: parseFloat(volumeTotal.toFixed(2)),
  };

  // DEAD needs enough markets to be sure: every quoted market one-sided (a lone quote is not a
  // price), or a median spread beyond the same CAPTURE_MAX_SPREAD gate the capture path enforces.
  if (n >= MIN_JUDGE && (realBooks === 0 || medianSpread > CAPTURE_MAX_SPREAD)) {
    return { ...out, screen: "DEAD_BOOK" };
  }
  if (realBooks >= MIN_REAL_BOOKS && medianSpread <= CAPTURE_MAX_SPREAD) {
    return { ...out, screen: "REAL_BOOK" };
  }
  return { ...out, screen: "THIN" };
}

// One retry on failure — Kalshi rate-limits a wide parallel burst (a 42-wide Promise.all 429'd
// most requests during the original scan build), so a single backoff recovers transient
// rate-limits even for a lone request. Returns the raw markets array, or null on failure.
export async function fetchSeriesMarkets(ticker, { limit = 100, status = "open" } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ticker}&limit=${limit}&status=${status}`, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) { if (attempt === 0) { await new Promise(res => setTimeout(res, 500)); continue; } return null; }
      return (await r.json())?.markets || [];
    } catch { if (attempt === 0) { await new Promise(res => setTimeout(res, 500)); continue; } return null; }
  }
  return null;
}

// Minimal shape for the bulk scan enrichment (one sample market + the screen).
// `window_fit` is no longer computed — the column stays on the table (additive doctrine; historical
// rows keep their values) but goes null from here on. See the screen block above for why.
export async function enrichSeries(ticker) {
  const markets = await fetchSeriesMarkets(ticker);
  if (markets == null) return null;
  const m0 = markets[0];
  return {
    sample_market: m0?.ticker ?? null,
    sample_subtitle: m0?.subtitle ?? m0?.yes_sub_title ?? m0?.title ?? null,
    ...screenMarkets(markets),
  };
}

// Series-level metadata (category/tags/frequency/title) — a DIFFERENT Kalshi endpoint than
// fetchSeriesMarkets (which lists that series' individual markets). Added 2026-07-23 to diagnose
// the kalshi-series-scan discovery blind spot: 14 real, liquid leagues (Premier League, La Liga,
// etc.) never surfaced in kalshi_series_seen because the scan only diffs the `category=Sports`
// series catalog — this lets us check what category/tags Kalshi actually assigns a series that
// we already know is real (found via checkSeriesLiquidity) but that the catalog diff missed.
export async function fetchSeriesMeta(ticker) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/series/${ticker}`, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) { if (attempt === 0) { await new Promise(res => setTimeout(res, 500)); continue; } return null; }
      const data = await r.json();
      const s = data?.series;
      if (!s) return null;
      return {
        ticker: s.ticker ?? null, title: s.title ?? null, category: s.category ?? null,
        tags: s.tags ?? null, frequency: s.frequency ?? null,
      };
    } catch { if (attempt === 0) { await new Promise(res => setTimeout(res, 500)); continue; } return null; }
  }
  return null;
}

// Full-detail single-series check for manual vetting — real bid/ask/volume per market (not just
// a count), so a human/agent can judge liquidity quality, not just presence. Used by
// /api/kalshi-check. Returns null on total fetch failure (series doesn't exist or Kalshi
// unreachable) — never throws.
export async function checkSeriesLiquidity(ticker, { sampleSize = 20, limit = 100 } = {}) {
  const markets = await fetchSeriesMarkets(ticker, { limit });
  if (markets == null) return null;
  const sample = markets.slice(0, sampleSize).map(m => ({
    ticker: m.ticker,
    subtitle: m.subtitle ?? m.yes_sub_title ?? m.title ?? null,
    yesAsk: m.yes_ask_dollars != null ? parseFloat(m.yes_ask_dollars) : null,
    yesBid: m.yes_bid_dollars != null ? parseFloat(m.yes_bid_dollars) : null,
    noAsk: m.no_ask_dollars != null ? parseFloat(m.no_ask_dollars) : null,
    noBid: m.no_bid_dollars != null ? parseFloat(m.no_bid_dollars) : null,
    volume: m.volume_fp != null ? parseFloat(m.volume_fp) : null,
    closeTime: m.close_time ?? null,
  }));
  // Same screen the bulk scan runs, so the manual diagnostic and the automated triage can never
  // disagree about whether a series has a real book — one function, two callers.
  const screen = screenMarkets(markets);
  return {
    ticker, liveMarketCount: markets.length, withRealBook: screen.real_book_count,
    screen: screen.screen, medianSpreadC: screen.median_spread_c,
    realBookFrac: screen.real_book_frac, overround: screen.overround,
    volumeTotal: screen.volume_total,
    sample,
  };
}
