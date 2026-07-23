// api/lib/kalshi-series-check.js
// Shared "does this series have a real book" fetch — extracted 2026-07-23 from the
// kalshi-series-scan enrichment logic so both the scan (bulk, minimal shape) and the standing
// admin diagnostic `/api/kalshi-check` (single-ticker, full detail) share one fetch+retry path
// instead of drifting. Series vetting is a recurring task in this codebase (this is the Nth
// triage session); worth a shared, reusable helper rather than a one-off.

const _WIN_LO = 0.67, _WIN_HI = 0.91;

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

// Minimal shape for the bulk scan enrichment (one sample market + count + window-fit hint).
export async function enrichSeries(ticker) {
  const markets = await fetchSeriesMarkets(ticker);
  if (markets == null) return null;
  let windowFit = false;
  for (const m of markets) {
    const ya = parseFloat(m.yes_ask_dollars), na = parseFloat(m.no_ask_dollars);
    if ((ya >= _WIN_LO && ya <= _WIN_HI) || (na >= _WIN_LO && na <= _WIN_HI)) { windowFit = true; break; }
  }
  const m0 = markets[0];
  return {
    sample_market: m0?.ticker ?? null,
    sample_subtitle: m0?.subtitle ?? m0?.yes_sub_title ?? m0?.title ?? null,
    live_market_count: markets.length,
    window_fit: windowFit,
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
export async function checkSeriesLiquidity(ticker, { sampleSize = 20 } = {}) {
  const markets = await fetchSeriesMarkets(ticker);
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
  let windowFit = false, withRealBook = 0;
  for (const m of markets) {
    const ya = parseFloat(m.yes_ask_dollars), yb = parseFloat(m.yes_bid_dollars);
    const na = parseFloat(m.no_ask_dollars), nb = parseFloat(m.no_bid_dollars);
    if ((ya >= _WIN_LO && ya <= _WIN_HI) || (na >= _WIN_LO && na <= _WIN_HI)) windowFit = true;
    if (ya > 0 && yb > 0 && na > 0 && nb > 0) withRealBook++; // real two-sided book, not a 0-quote shell
  }
  return {
    ticker, liveMarketCount: markets.length, withRealBook, windowFit,
    sample,
  };
}
