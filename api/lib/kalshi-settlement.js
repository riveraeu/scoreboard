// api/lib/kalshi-settlement.js
// Kalshi-settlement-based shadow_plays grading — DRY-RUN ONLY as of 2026-07-23 (see
// project_kalshi_settlement_grading_2026_07_23 memory). Every Kalshi market carries its own
// `result` ("yes"/"no", or "scalar" for a void/postponement) once settled — this lets grading
// skip the whole zoo of per-sport ESPN/statsapi resolvers (team-name matching, date-window
// fuzzing) in favor of one universal lookup by the row's own kalshi_ticker. Not yet authoritative
// — see handlers/shadow.js's dry-run comparison pass.

const KALSHI_MARKETS = "https://api.elections.kalshi.com/trade-api/v2/markets";
const TICKER_BATCH_SIZE = 200; // comfortably under the empirically-confirmed-OK ~300 batch size

// Which yes/no side of the row's OWN kalshi_ticker counts as a win for this row. Computed once
// at shadow-snapshot write time (chokepoint: handlers/shadow.js row-mapping) from fields already
// present on the in-memory play object — never re-touches the 13 emit modules.
//   - kalshiSide already set explicitly (game-totals.js/ml-spread.js/props.js, incl. the tricky
//     spread case, where it's the only reliable signal — spread rows don't store a plain
//     direction) → use it directly.
//   - direction "over"/"under" (soccer.js/fight.js/mlb-outs.js, which don't set kalshiSide) →
//     "under" means we captured the NO price, "over" the YES price.
//   - direction null (every one-ticker-per-outcome family: ml/game/advance/h2h/top10/tennis/
//     nba-summer/lmb/soccer's game family/club-soccer-ml) → the captured ticker IS the outcome
//     we picked, so "yes" is trivially correct.
export function deriveKalshiSide({ kalshiSide, direction } = {}) {
  if (kalshiSide === "yes" || kalshiSide === "no") return kalshiSide;
  if (direction === "under") return "no";
  if (direction === "over") return "yes";
  return "yes";
}

// Did the row's bet win, given Kalshi's raw settlement result for its own ticker? Returns null
// (don't grade) when the market isn't settled cleanly yes/no yet — either still open, or a
// genuine void (result: "scalar", seen across every family checked: MLB props/outs, tennis
// retirements, golf withdrawals, LMB/MLS postponements — mechanism varies by family, e.g. PGA
// voids at exactly 0.50 while MLB props void at the last traded price, but it never means a real
// win/loss either way).
export function wonFromKalshiResult(result, side) {
  if (result !== "yes" && result !== "no") return null;
  return result === side;
}

// Batch-fetch settlement status for a list of tickers. Sequential chunks (not parallel) —
// Kalshi rate-limits wide parallel bursts (same caution as kalshi-flow.js). Returns
// Map(ticker -> { status, result }). Failure-closed: a failed chunk just leaves those tickers
// absent from the map (caller treats missing as "not resolvable this pass").
export async function fetchKalshiSettlements(tickers) {
  const out = new Map();
  const unique = [...new Set((tickers || []).filter(Boolean))];
  for (let i = 0; i < unique.length; i += TICKER_BATCH_SIZE) {
    const chunk = unique.slice(i, i + TICKER_BATCH_SIZE);
    try {
      const res = await fetch(`${KALSHI_MARKETS}?tickers=${chunk.join(",")}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const m of (data?.markets || [])) {
        if (m?.ticker) out.set(m.ticker, { status: m.status, result: m.result });
      }
    } catch { /* this chunk's tickers stay absent — failure-closed */ }
  }
  return out;
}

// Pure: given a specific ticker + which side ("yes"/"no") we care about, what would Kalshi's
// settlement say? Returns null when not resolvable this pass (not finalized yet, or void).
// Shared by resolveRowViaKalshi (shadow_plays taker rows, which carry kalshi_ticker/kalshi_side)
// and maker.js's V1 grading (maker_quotes/maker_fills rows, which use ticker/quote_side directly
// and have no shadow_plays row to read from — see project_maker_v1_settlement_grading memory).
export function resolveTickerSideViaKalshi(ticker, side, settlements) {
  if (!ticker) return null;
  const m = settlements.get(ticker);
  if (!m || m.status !== "finalized") return null;
  return wonFromKalshiResult(m.result, side);
}

// Pure: given a row (with kalshi_ticker/kalshi_side already on it) and the settlements map,
// what WOULD Kalshi-based grading conclude? Returns null when not resolvable this pass (not yet
// settled, or void) — same meaning as wonFromKalshiResult's null.
export function resolveRowViaKalshi(row, settlements) {
  return resolveTickerSideViaKalshi(row?.kalshi_ticker, row?.kalshi_side, settlements);
}
