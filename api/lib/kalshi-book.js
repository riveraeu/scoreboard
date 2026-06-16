// Shared Kalshi live-orderbook fetch + fill walk. Server-side single source of truth so the
// kalshi-orderbook route handler, the order-modal frontend (src/lib/orderbook.js re-exports the
// pure pieces), and the push-notify cron all measure fill the same way.
//
// Why this exists: a market with 0 *traded* volume can still have a deep two-sided *resting*
// book. Cached `kalshiVolume`/`_depth` can't see that (top-3-only, often absent on fresh 0-vol
// markets), so the only honest read of "does our size actually fill" is to walk the FULL live book.

// ¢ over top-of-book that we treat as a clean fill (no warning, stays checked).
export const SLIP_OK_CENTS = 2;
// ¢ over top-of-book that escalates to a soft "fill may slip" warning.
export const SLIP_WARN_CENTS = 3;

// Fetch the FULL live book for one ticker directly from Kalshi (no self-HTTP round-trip).
// Returns { ok, ticker, levels:{n,y}, yesAsk, noAsk, spread, volume } or { ok:false }.
// `levels.n` = NO-side resting bids, `levels.y` = YES-side resting bids, integer cents,
// descending by price. Never throws — callers fall back to their cached verdict on !ok.
export async function fetchKalshiOrderbook(ticker) {
  if (!ticker) return { ok: false };
  const _levels = (rows) => (Array.isArray(rows) ? rows : [])
    .map(([p, q]) => [Math.round(parseFloat(p) * 100), Math.round(parseFloat(q))])
    .filter(([c, q]) => c > 0 && c < 100 && q > 0)
    .sort((a, b) => b[0] - a[0]);   // highest bid first
  try {
    const [obRes, mRes] = await Promise.all([
      fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      }),
      fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      }),
    ]);
    if (!obRes.ok) return { ok: false };
    const ob = (await obRes.json())?.orderbook_fp || {};
    const n = _levels(ob.no_dollars);
    const y = _levels(ob.yes_dollars);
    let yesAsk = null, noAsk = null, spread = null, volume = null;
    if (mRes.ok) {
      const m = (await mRes.json())?.market || {};
      const ya = parseFloat(m.yes_ask_dollars), yb = parseFloat(m.yes_bid_dollars);
      const na = parseFloat(m.no_ask_dollars);
      if (!isNaN(ya)) yesAsk = Math.round(ya * 100);
      if (!isNaN(na)) noAsk = Math.round(na * 100);
      if (!isNaN(ya) && !isNaN(yb)) spread = Math.round((ya - yb) * 100);
      volume = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
    }
    // Derive asks from the book if the market fetch didn't supply them (ask = 100 - best opp bid).
    if (yesAsk == null && n.length) yesAsk = 100 - n[0][0];
    if (noAsk == null && y.length) noAsk = 100 - y[0][0];
    return { ok: true, ticker, yesAsk, noAsk, spread, volume, levels: { n, y } };
  } catch {
    return { ok: false };
  }
}

// Walk the resting book to fill `count` of `side` ("yes"|"no"). To BUY YES you lift NO bids
// (yes_ask = 100 - no_bid); to BUY NO you lift YES bids. Returns:
//   { vwapCents, filledCount, exhausted, slipCents }  — or null when no usable depth.
// `topAskCents` is the current top-of-book ask for the side bought (best level), used to measure
// slippage; when omitted we derive it from the cheapest book level.
export function walkFill({ levels, side, count, topAskCents = null }) {
  if (!levels || !(count > 0)) return null;
  const oppBids = side === 'no' ? levels.y : levels.n;
  if (!Array.isArray(oppBids) || oppBids.length === 0) return null;
  const sorted = oppBids
    .map(([c, q]) => [Number(c), Number(q)])
    .filter(([c, q]) => c > 0 && c < 100 && q > 0)
    .sort((a, b) => b[0] - a[0]); // highest bid first = cheapest ask first
  if (sorted.length === 0) return null;
  const bestAsk = 100 - sorted[0][0];
  const top = topAskCents ?? bestAsk;
  let filled = 0, costCents = 0;
  for (const [bidCents, qty] of sorted) {
    if (filled >= count) break;
    const take = Math.min(qty, count - filled);
    costCents += take * (100 - bidCents);
    filled += take;
  }
  if (filled === 0) return null;
  const exhausted = filled < count;
  const vwapCents = Math.round(costCents / filled);
  return { vwapCents, filledCount: filled, exhausted, slipCents: Math.max(0, vwapCents - top) };
}
