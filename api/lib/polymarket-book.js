// api/lib/polymarket-book.js — Polymarket CLOB order-book walk (Phase 1b prep, 2026-06-23).
//
// The Poly-shaped parallel to kalshi-book.js's walkFill. Turns the observatory's mid-price deltas
// into EXECUTABLE deltas: a 3¢ mid gap that evaporates to 0.5¢ after slippage was never real edge.
// Read-only — used to sharpen the kill-gate, and a Phase-1b building block regardless of verdict.
//
// CLOB `/book?token_id=` returns { bids, asks } of { price:"0.xx", size:"shares" } (strings, 0–1).
// Arrays aren't reliably sorted, so we sort. To BUY an outcome you pay the ASKs cheapest-first; the
// VWAP of sweeping `targetShares` is the executable cost. 1 share settles at $1, so notional ≈
// shares × price. Prices reported as cents (×100) to match the rest of the codebase.

const CLOB = "https://clob.polymarket.com";

export const POLY_SLIP_OK_CENTS = 2;
export const POLY_SLIP_WARN_CENTS = 3;

export async function fetchPolyOrderbook(tokenId) {
  try {
    const res = await fetch(`${CLOB}/book?token_id=${tokenId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const b = await res.json();
    return { bids: b.bids || [], asks: b.asks || [] };
  } catch { return null; }
}

// Walk the ASK side to BUY `targetShares` of a Polymarket outcome token. Pure / testable. Returns
// { vwapPct, filledShares, exhausted, slipCents } or null when the book can't price the order.
// `bestAskCents` is an optional top-of-book reference for the slip measure (defaults to the book's
// own best ask).
export function walkPolyFill({ asks, targetShares, bestAskCents = null }) {
  if (!Array.isArray(asks) || !(targetShares > 0)) return null;
  const sorted = asks
    .map((a) => [Number(a.price), Number(a.size)])
    .filter(([p, s]) => p > 0 && p < 1 && s > 0)
    .sort((a, b) => a[0] - b[0]); // cheapest ask first
  if (!sorted.length) return null;
  const bestAsk = +(sorted[0][0] * 100).toFixed(1);
  const top = bestAskCents ?? bestAsk;
  let filled = 0, costCents = 0;
  for (const [price, size] of sorted) {
    if (filled >= targetShares) break;
    const take = Math.min(size, targetShares - filled);
    costCents += take * price * 100;
    filled += take;
  }
  if (filled === 0) return null;
  const exhausted = filled < targetShares;
  const vwapPct = +(costCents / filled).toFixed(1);
  return { vwapPct, filledShares: +filled.toFixed(2), exhausted, slipCents: +Math.max(0, vwapPct - top).toFixed(1) };
}

// Enrich the in-window delta rows with the EXECUTABLE Poly buy price. For each delta whose Kalshi
// or Poly price is in the bettable band [67,91] (the favorites we'd actually trade), walk the Poly
// book for that side's token at a `refUsd` notional and attach { polyVwapPct, polySlipCents,
// execDeltaCents } (execDeltaCents = polyVwapPct − kalshiPct; negative = Poly still cheaper to BUY
// AFTER slippage = surviving edge). Bounded (maxWalks), parallel, failure-closed — leaves the row's
// mid-price delta untouched on any book failure. `tokensByGame` maps `${sport}|${game}` → mlTokens.
export async function enrichDeltasWithExec({ deltas, tokensByGame, refUsd = 30, maxWalks = 24 }) {
  const inBand = (p) => p != null && p >= 67 && p <= 91;
  const targets = (deltas || [])
    .filter((d) => d.market === "ml" && (inBand(d.kalshiPct) || inBand(d.polyPct)) && d.polyPct > 0)
    .slice(0, maxWalks);
  await Promise.all(targets.map(async (d) => {
    const tok = tokensByGame[`${d.sport}|${d.game}`]?.[d.side];
    if (!tok) return;
    const book = await fetchPolyOrderbook(tok);
    if (!book) return;
    const targetShares = refUsd / (d.polyPct / 100); // ≈ notional / price
    const fill = walkPolyFill({ asks: book.asks, targetShares, bestAskCents: d.polyPct });
    if (!fill) return;
    d.polyVwapPct = fill.vwapPct;
    d.polySlipCents = fill.slipCents;
    d.polyExhausted = fill.exhausted;
    d.execDeltaCents = +(fill.vwapPct - d.kalshiPct).toFixed(1);
  }));
}
