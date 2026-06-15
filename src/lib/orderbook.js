// Live single-ticker orderbook fetch + fill walk for the order modals. The cached snapshot
// `_depth` is top-3-only and is often absent for fresh 0-volume markets, so the server-reported
// slippage (kalshiPct vs rawKalshiPct) reads a false 0. To decide whether OUR suggested size
// actually fills cleanly, we fetch the FULL live book and walk it for the real contract count.
import { WORKER } from './constants.js';

// ¢ over top-of-book that we treat as a clean fill (no warning, stays checked).
export const SLIP_OK_CENTS = 2;
// ¢ over top-of-book that escalates to a soft "fill may slip" warning.
export const SLIP_WARN_CENTS = 3;

// Fetch the live orderbook for one ticker. Returns { ok, levels:{n,y}, yesAsk, noAsk, spread,
// volume } or { ok:false }. Never throws — callers fall back to the cached heuristic on !ok.
export async function fetchOrderbook(ticker) {
  if (!ticker) return { ok: false };
  try {
    const r = await fetch(`${WORKER}/kalshi-orderbook?ticker=${encodeURIComponent(ticker)}`);
    const data = await r.json().catch(() => ({ ok: false }));
    if (!r.ok || !data?.ok) return { ok: false };
    return data;
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
