// Live single-ticker orderbook fetch + fill walk for the order modals. The cached snapshot
// `_depth` is top-3-only and is often absent for fresh 0-volume markets, so the server-reported
// slippage (kalshiPct vs rawKalshiPct) reads a false 0. To decide whether OUR suggested size
// actually fills cleanly, we fetch the FULL live book and walk it for the real contract count.
import { WORKER } from './constants.js';
// walkFill + slip thresholds live in api/lib/kalshi-book.js so the push-notify cron and the
// kalshi-orderbook route walk the book identically — re-exported so frontend imports are unchanged.
import { walkFill, SLIP_OK_CENTS, SLIP_WARN_CENTS } from '../../api/lib/kalshi-book.js';
export { walkFill, SLIP_OK_CENTS, SLIP_WARN_CENTS };

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
