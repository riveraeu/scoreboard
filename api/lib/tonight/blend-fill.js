// Shared orderbook blended-fill pricing. Extracted 2026-05-31 from the inline prop walk in
// tonight.js so player props AND game/team totals + spreads all price their displayed edge at
// the cost of actually sweeping the book for a unit-sized position — not just top-of-book ask.
//
// Why: a thin/wide market can show a juicier edge than you'll realize after slippage. Props had
// a live orderbook walk; totals/spread/teamTotal only had top-of-book. This unifies them on a
// single cached-depth blend (depth comes from kalshi:snap:{ticker} via the snapshot cron, so
// there is NO live Kalshi fetch on the /api/tonight hot path).
//
// Depth shape stored on each market as `_depth = { n: [[cents,qty],...], y: [[cents,qty],...] }`
// where `n` = NO-side resting bids (no_dollars) and `y` = YES-side resting bids (yes_dollars),
// each already truncated to the top few levels by DESCENDING price. To fill a YES buy you take
// the lowest YES asks first = highest NO bids first (yes_ask = 1 - no_price); symmetric for NO.

// Position sizing tiers — mirror of the units scheme used elsewhere. 1 unit = $50 risk.
// Higher-confidence (higher kalshiPct) lines size up: 70-83% = 1u, 83-93% = 3u, 93%+ = 5u.
const BLEND_UNIT_DOLLARS = 50;
export function blendContractCount(pct, askCents) {
  if (!(askCents > 0)) return 0;
  const units = pct >= 93 ? 5 : pct >= 83 ? 3 : 1;
  return Math.ceil((BLEND_UNIT_DOLLARS * units) / (askCents / 100));
}

// Walk the resting book on the OPPOSITE side to fill `contracts` of the side being bought.
// `side` = "yes" | "no". Returns the blended price in integer cents, or null when no depth is
// available (caller keeps top-of-book). `topAskCents` is the current top-of-book ask for the
// side being bought — used as the first level when the stored depth is the opposing book.
//
// Kalshi books: to BUY YES, you lift NO bids (yes_ask = 100 - no_bid). To BUY NO, you lift YES
// bids (no_ask = 100 - yes_bid). So for a YES buy we walk `_depth.n` (NO bids) high→low; for a
// NO buy we walk `_depth.y` (YES bids) high→low. Each level's effective ask = 100 - bidCents.
export function blendedAskCents(depth, side, contracts) {
  if (!depth || !(contracts > 0)) return null;
  const oppBids = side === "yes" ? depth.n : depth.y;
  if (!Array.isArray(oppBids) || oppBids.length === 0) return null;
  // Highest bid first = cheapest ask first. Stored already descending, but sort defensively.
  const levels = oppBids
    .map(([c, q]) => [Number(c), Number(q)])
    .filter(([c, q]) => c > 0 && c < 100 && q > 0)
    .sort((a, b) => b[0] - a[0]);
  if (levels.length === 0) return null;
  let filled = 0;
  let costCents = 0;
  for (const [bidCents, qty] of levels) {
    if (filled >= contracts) break;
    const askCents = 100 - bidCents;
    const take = Math.min(qty, contracts - filled);
    costCents += take * askCents;
    filled += take;
  }
  if (filled === 0) return null;
  if (filled < contracts) {
    // Book exhausted before the full position — extend the remainder at the worst quoted ask
    // (= the lowest bid level we saw). Clamp ask at 99 so we never imply a free contract.
    const worstAsk = Math.min(99, 100 - levels[levels.length - 1][0]);
    costCents += (contracts - filled) * worstAsk;
  }
  return Math.round(costCents / contracts);
}

// Convenience: given a market's depth, the side being bought, its top-of-book pct, and the
// American-odds converter, return { pct, americanOdds } reflecting the blended fill — or null
// when depth can't improve on (or replace) the top-of-book value. Caller applies only when the
// blended pct is WORSE (higher cost) than top-of-book, matching the prior prop-walk behavior
// (we never optimistically improve a displayed price; we only de-bias it upward for slippage).
export function blendMarketPrice(depth, side, topPct) {
  const contracts = blendContractCount(topPct, topPct); // ask≈pct in cents for sizing
  const blended = blendedAskCents(depth, side, contracts);
  if (blended == null) return null;
  if (blended <= topPct || blended > 97) return null;
  const americanOdds = blended >= 50
    ? Math.round(-(blended / (100 - blended)) * 100)
    : Math.round((100 - blended) / blended * 100);
  return { pct: blended, americanOdds };
}
