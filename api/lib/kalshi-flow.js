// Kalshi public trade-tape flow features (xFlow*) for the shadow x* exogenous namespace.
// Measures WHO is pushing a market's price — aggressive taker-side direction + trade-size
// texture — a candidate mispricing signal for tune:residual, never a model input (flow
// carries no information about game outcomes; its only mechanism is price distortion).
// Consumed by shadow-snapshot: one public trades fetch per distinct ticker at capture
// time, folded into features via exogenousSignals(p._flow). Pure capture — no formula
// reads these. Failure-closed at every level: any error → ticker absent → row unstamped.
import { pLimit } from "./utils.js";

// Sharp-print proxy: share of volume arriving in trades at/above this size. Fixed
// threshold (not percentile) so the feature means the same thing across categories.
const LARGE_TRADE_CONTRACTS = 100;

// Pure feature math, unit-tested. `trades` = Kalshi GET /markets/trades rows.
// Contract count arrives as `count_fp` (a decimal STRING, e.g. "3.00" — live-verified
// 2026-07-05); older `count` kept as fallback. Zero-trade tapes stamp
// {trades:0, contracts:0} — illiquid is real signal (same doctrine as xVolume's
// 0-preservation).
export function computeFlowFeatures(trades) {
  const t = Array.isArray(trades) ? trades : [];
  let contracts = 0, yesContracts = 0, largeContracts = 0;
  for (const tr of t) {
    const c = Number(tr?.count_fp ?? tr?.count) || 0;
    contracts += c;
    if (tr?.taker_side === "yes") yesContracts += c;
    if (c >= LARGE_TRADE_CONTRACTS) largeContracts += c;
  }
  const f = { xFlowTrades: t.length, xFlowContracts: contracts };
  if (contracts > 0) {
    f.xFlowTakerYesPct = parseFloat((yesContracts / contracts * 100).toFixed(1));
    f.xFlowAvgSize = parseFloat((contracts / t.length).toFixed(1));
    f.xFlowLargeShare = parseFloat((largeContracts / contracts * 100).toFixed(1));
  }
  return f;
}

// Fetch the last `sinceHours` of trades for each ticker → Map<ticker, flowFeatures>.
// Single page of 1000 per ticker (no cursor walk): our markets trade well under
// 1000/day, and on the rare liquid-ML overflow the most-recent-1000 share is still a
// valid flow read. First 429 aborts the remainder — return what we have, never retry-storm.
export async function fetchTradeFlow(tickers, { sinceHours = 24, concurrency = 6 } = {}) {
  const out = new Map();
  const list = [...new Set((tickers || []).filter(Boolean))];
  if (!list.length) return out;
  const minTs = Math.floor(Date.now() / 1000) - sinceHours * 3600;
  const limit = pLimit(concurrency);
  let rateLimited = false;
  await Promise.all(list.map(ticker => limit(async () => {
    if (rateLimited) return;
    try {
      const r = await fetch(
        `https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=1000&min_ts=${minTs}`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
      );
      if (r.status === 429) { rateLimited = true; return; }
      if (!r.ok) return;
      const j = await r.json();
      out.set(ticker, computeFlowFeatures(j?.trades));
    } catch { /* failure-closed: no stamp for this ticker */ }
  })));
  return out;
}
