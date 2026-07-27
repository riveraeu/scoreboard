// api/lib/maker-stats.js
// Contract-weighted maker PnL with a correct confidence interval. Pure — takes plain sufficient
// statistics (six sums, computed in SQL) so the estimator is unit-testable without a DB.
//
// ── Why this exists (2026-07-25) ──
// The maker boards' original headline was `AVG(pnl_cents)` — an UNWEIGHTED per-fill mean, which
// counts a 1-contract fill and a 500-contract fill equally. Capital earns the contract-weighted
// number, so that's what an arm decision on real money should be reading. Both are reported now;
// the unweighted one is kept because it's what the historical `armCriterion` was written against.
//
// ── The trap this deliberately avoids ──
// The obvious way to weight by contracts is to treat each CONTRACT as an observation. That is
// wrong and dangerously so: all contracts inside one fill share a single market outcome, so they
// are perfectly correlated, not independent. Doing it that way inflates the effective sample by
// the mean fill size (~6.6× on V1's book as of 2026-07-25) and shrinks the CI by ~sqrt(6.6) ≈ 2.6×
// — enough to make a flat book look like it cleared `pnlLoCI > 0` and arm real money on noise.
//
// The FILL is the independent unit. The contract-weighted mean is therefore a ratio estimator
//     R = Σ(cᵢ·pᵢ) / Σ(cᵢ)
// over n fills, whose variance comes from the standard Taylor-linearization (delta method):
//     Var(R) ≈ (n/(n−1)) · Σ[cᵢ(pᵢ−R)]² / (Σcᵢ)²
// Expanding the inner sum lets the caller pass simple sums and never ship raw rows:
//     Σ[cᵢ(pᵢ−R)]² = Σcᵢ²pᵢ² − 2R·Σcᵢ²pᵢ + R²·Σcᵢ²
// Sanity check that this is the right formula: with every cᵢ = 1 it reduces exactly to s²/n, the
// ordinary standard error of the mean (pinned in maker-stats.test.js).

const Z_95 = 1.959963985;

/**
 * @param n         number of graded FILLS (the independent unit — not contracts)
 * @param sumC      Σ contracts
 * @param sumCP     Σ contracts·pnl_cents
 * @param sumC2     Σ contracts²
 * @param sumC2P    Σ contracts²·pnl_cents
 * @param sumC2P2   Σ contracts²·pnl_cents²
 * @param z         critical value (default two-sided 95%)
 * @returns { n, contracts, mean, se, loCI, hiCI } — all null-safe; mean/se/CI are null when
 *          undefined (no fills, zero contracts, or n<2 so there's no variance to estimate).
 */
export function contractWeightedPnl({ n, sumC, sumCP, sumC2, sumC2P, sumC2P2, z = Z_95 } = {}) {
  const N = Number(n || 0);
  const C = Number(sumC || 0);
  const empty = { n: N, contracts: C, mean: null, se: null, loCI: null, hiCI: null };
  if (N < 1 || !(C > 0)) return empty;

  const mean = Number(sumCP || 0) / C;
  if (N < 2) return { ...empty, mean: round2(mean) };

  // Σ[cᵢ(pᵢ−R)]², expanded so only plain sums cross the SQL boundary.
  let ss = Number(sumC2P2 || 0) - 2 * mean * Number(sumC2P || 0) + mean * mean * Number(sumC2 || 0);
  // Floating-point cancellation can push a true-zero spread slightly negative (identical pnl on
  // every fill). Clamp rather than emit NaN from sqrt.
  if (!(ss > 0)) ss = 0;

  const variance = (N / (N - 1)) * ss / (C * C);
  const se = Math.sqrt(variance);
  return {
    n: N,
    contracts: C,
    mean: round2(mean),
    se: round2(se),
    loCI: round2(mean - z * se),
    hiCI: round2(mean + z * se),
  };
}

function round2(x) {
  return Number.isFinite(x) ? parseFloat(x.toFixed(2)) : null;
}

// ── Day-clustered CI (2026-07-26) ─────────────────────────────────────────────────────────────
// `contractWeightedPnl` above fixed correlation WITHIN a fill (all contracts share one outcome).
// This fixes the next level up: correlation ACROSS fills that share a day. V1 sells favorites, so
// a day's PnL is essentially one bet on whether favorites underperformed that day — hundreds of
// fills on a slate resolve off a few dozen correlated game outcomes plus one common factor. Treating
// them as independent is the same error class the contract-weighting trap was, one level out.
//
// It is not a small correction. On V1's book at 2026-07-26 the fill-level CI read [+0.70, +2.81]
// (loCI > 0, i.e. `armCriterion` satisfied) while the day-clustered CI over the same data straddles
// zero — because +$1,865 of the +$1,066 total came from two days (7/24, 7/25) against −$800 across
// the other five. Seven days is the real sample size, not 9,415 fills.
//
// Same ratio estimator as above, with the DAY as the cluster:
//     R = Σ_d Y_d / Σ_d C_d           Y_d = Σ contracts·pnl on day d, C_d = Σ contracts on day d
//     Var(R) ≈ (m/(m−1)) · Σ_d [Y_d − R·C_d]² / (Σ_d C_d)²
// With one 1-contract fill per day this collapses to s²/m exactly, the same sanity property
// contractWeightedPnl has at unit weights (both pinned in maker-stats.test.js).
//
// Days are passed in whole (the daily series is already fetched for the equity curve and is ~7-30
// rows), so no sufficient-statistic expansion is needed here.
/**
 * @param days  [{ pnl, contracts }] per day — `pnl` = Σ(pnl_cents·contracts) over GRADED fills,
 *              `contracts` = Σ contracts over GRADED fills. Days with no graded contracts are
 *              dropped: they carry no information and must not count toward the cluster count.
 * @param z     critical value (default two-sided 95%)
 * @returns { days, contracts, mean, se, loCI, hiCI } — null-safe; CI is null with fewer than 2 days.
 */
export function dayClusteredPnl({ days, z = Z_95 } = {}) {
  const rows = (Array.isArray(days) ? days : []).filter(d => Number(d?.contracts) > 0);
  const m = rows.length;
  const C = rows.reduce((s, d) => s + Number(d.contracts), 0);
  const empty = { days: m, contracts: C, mean: null, se: null, loCI: null, hiCI: null };
  if (m < 1 || !(C > 0)) return empty;

  const mean = rows.reduce((s, d) => s + Number(d.pnl || 0), 0) / C;
  if (m < 2) return { ...empty, mean: round2(mean) };

  let ss = 0;
  for (const d of rows) {
    const resid = Number(d.pnl || 0) - mean * Number(d.contracts);
    ss += resid * resid;
  }
  if (!(ss > 0)) ss = 0; // identical per-day ratios — clamp rather than emit NaN from sqrt

  const se = Math.sqrt((m / (m - 1)) * ss / (C * C));
  return {
    days: m,
    contracts: C,
    mean: round2(mean),
    se: round2(se),
    loCI: round2(mean - z * se),
    hiCI: round2(mean + z * se),
  };
}

// The six sums, as a SQL fragment. Kept here next to the estimator so the column names and the
// consuming field names can't drift apart. `pnlCol`/`contractsCol` are trusted identifiers
// supplied by call sites in this repo, never user input.
export function weightedPnlSumsSql({ pnlCol, contractsCol, filter }) {
  const f = filter ? ` FILTER (WHERE ${filter})` : "";
  const p = `${pnlCol}::numeric`;
  const c = `${contractsCol}::numeric`;
  return `
          COUNT(*)${f}::int AS w_n,
          COALESCE(SUM(${c})${f}, 0) AS w_sum_c,
          COALESCE(SUM(${c} * ${p})${f}, 0) AS w_sum_cp,
          COALESCE(SUM(${c} * ${c})${f}, 0) AS w_sum_c2,
          COALESCE(SUM(${c} * ${c} * ${p})${f}, 0) AS w_sum_c2p,
          COALESCE(SUM(${c} * ${c} * ${p} * ${p})${f}, 0) AS w_sum_c2p2`;
}

// Map a result row's w_* columns into contractWeightedPnl's input shape.
export function weightedPnlFromRow(row) {
  return contractWeightedPnl({
    n: row?.w_n, sumC: row?.w_sum_c, sumCP: row?.w_sum_cp,
    sumC2: row?.w_sum_c2, sumC2P: row?.w_sum_c2p, sumC2P2: row?.w_sum_c2p2,
  });
}
