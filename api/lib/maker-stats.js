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
// ── Quoted-outcome roll-up + within-band adverse selection (2026-07-26) ───────────────────────
// Extracted from handlers/shadow.js because this diagnostic has now been wrong twice, in two
// different ways, and both times it was inline SQL+JS with no test:
//   1. (pre-2026-07-22) a hand-duplicated CASE-WHEN that drifted from gradeMakerFills.
//   2. (fixed 2026-07-26) a last-quote-only population sitting 2.1c higher in price than actual
//      quoting activity, compared as raw win RATES across mismatched price distributions — which
//      made the metric invert (filled edge above quoted, backwards for a resting maker).
// Pure functions over plain rows; the caller does the settlement resolution and passes `sideWon`.

// Seller edge in cents/contract. pnl = ask − 100·side_won, so edge = avgAsk − 100·sideWonRate.
// Positive = the sold side wins LESS often than its price implies = the seller is paid.
const sellerEdge = (sumAsk, segments, wonSegments) =>
  segments > 0 ? (sumAsk / segments) - 100 * (wonSegments / segments) : null;

/**
 * Roll (band, ticker, side) quote groups up per band, weighting by SEGMENT count so the quoted
 * population matches the price distribution actually rested at.
 * @param rows [{ band, ticker, segments, sumAsk, sideWon }] — `sideWon` null (unsettled/void) drops
 *             the row entirely, same "not resolvable this pass" rule as grading.
 */
export function quotedOutcomesByBand(rows) {
  const byBand = new Map();
  const tickers = new Set();
  let seg = 0, ask = 0, won = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r?.sideWon !== true && r?.sideWon !== false) continue;
    const s = Number(r.segments || 0), a = Number(r.sumAsk || 0);
    if (!(s > 0)) continue;
    const b = byBand.get(r.band) || { segments: 0, sumAsk: 0, wonSegments: 0, tickers: new Set() };
    b.segments += s; b.sumAsk += a; if (r.sideWon) b.wonSegments += s;
    b.tickers.add(r.ticker);
    byBand.set(r.band, b);
    tickers.add(r.ticker);
    seg += s; ask += a; if (r.sideWon) won += s;
  }
  return {
    n: seg, tickers: tickers.size, basis: "segments",
    sideWonRate: seg > 0 ? round4(won / seg) : null,
    avgAsk: seg > 0 ? round1(ask / seg) : null,
    edgeCents: seg > 0 ? round2(sellerEdge(ask, seg, won)) : null,
    byBand: [...byBand.entries()].sort((a2, b2) => a2[0].localeCompare(b2[0])).map(([band, b]) => ({
      band, segments: b.segments, tickers: b.tickers.size,
      avgAsk: round1(b.sumAsk / b.segments),
      sideWonRate: round4(b.wonSegments / b.segments),
      edgeCents: round2(sellerEdge(b.sumAsk, b.segments, b.wonSegments)),
    })),
  };
}

/**
 * Compare quoted vs filled edge WITHIN band, then collapse to one mix-free number.
 * The headline re-weights the FILLED band edges onto the QUOTED segment distribution, which is what
 * strips the price-mix difference (fills concentrate low on the ladder, quotes spread across it).
 * `gapCents` > 0 = fills do worse than quotes at the same price = genuine adverse selection.
 * @param quotedByBand   `quotedOutcomesByBand(...).byBand`
 * @param filledBands    [{ band, avgPnl, graded }] — band `avgPnl` IS the filled seller edge
 *                       (AVG(ask − 100·won)), so the two sides are directly comparable.
 * @param filledEdgeRawCents  the unadjusted headline, carried through for contrast
 */
export function adverseSelectionWithinBand({ quotedByBand, filledBands, filledEdgeRawCents = null } = {}) {
  const filledEdge = new Map((Array.isArray(filledBands) ? filledBands : [])
    .filter(r => r?.avgPnl != null && Number(r.graded || 0) > 0)
    .map(r => [r.band, Number(r.avgPnl)]));

  let mixW = 0, mixEdge = 0, qEdge = 0;
  const byBand = (Array.isArray(quotedByBand) ? quotedByBand : []).map(q => {
    const fe = filledEdge.has(q.band) ? filledEdge.get(q.band) : null;
    // Only bands present on BOTH sides can be compared, or reweighted onto each other.
    if (fe != null) { mixW += q.segments; mixEdge += q.segments * fe; qEdge += q.segments * q.edgeCents; }
    return { band: q.band, quotedEdgeCents: q.edgeCents, filledEdgeCents: fe,
      gapCents: fe != null ? round2(q.edgeCents - fe) : null };
  });

  const mixAdj = mixW > 0 ? mixEdge / mixW : null;
  const quotedMatched = mixW > 0 ? qEdge / mixW : null;
  return {
    basis: "within-band, quoted population = all segments, weighted by segments",
    quotedEdgeCents: round2(quotedMatched),
    filledEdgeRawCents,
    filledEdgeMixAdjustedCents: round2(mixAdj),
    gapCents: (quotedMatched != null && mixAdj != null) ? round2(quotedMatched - mixAdj) : null,
    byBand,
  };
}

function round1(x) { return Number.isFinite(x) ? parseFloat(x.toFixed(1)) : null; }
function round4(x) { return Number.isFinite(x) ? parseFloat(x.toFixed(4)) : null; }

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

// ── Lead-time hypothesis (2026-07-28) ────────────────────────────────────────────────────────
// Pre-registered in docs/MAKER_LEADTIME_PREREG.md BEFORE this code existed. H1: a resting maker
// quote is adversely selected in proportion to its time at risk, so seller edge should DECLINE as
// lead time (game_time − traded_at) increases. Decision rule fixed in advance: day-clustered CI on
// the mix-adjusted near−far difference entirely above zero, AND positive sign in ≥7 of 9 days, AND
// Spearman ρ ≤ −0.5 across the five buckets. Any one failing kills it.
//
// Pure and tested by design, for the same reason `quotedOutcomesByBand` was extracted: this class
// of diagnostic has been wrong twice on this board while it was untested inline SQL+JS, and a
// pre-registered test whose estimator is unverified is worth nothing.

// ── Early-exit counterfactual (2026-07-28) ───────────────────────────────────────────────────
// "Would selling the position back before settlement, while it is in profit, have helped?"
//
// The position: V1 sells side S at A, so it is SHORT S. Closing early means BUYING S back as a
// taker, paying the prevailing ask. P&L on a close at time t is therefore `A − ask_t(S)` — which
// already has the cost of crossing the spread baked in, since ask_t(S) is what you actually pay.
// The excursion passed in here is `A − min_t ask_t(S)`: the best exit the price path ever offered.
//
// Why a threshold rule and not "exit at the max": you cannot see the max in advance. A take-profit
// rule exits the FIRST time the mark reaches +X, so the realized P&L is exactly +X, never the peak.
// Crediting the peak is the standard way this kind of backtest lies to itself.
//
// The prior this is testing against: a prediction-market price is a martingale, so by optional
// stopping NO path-based exit rule changes the expectation — it only reshapes the distribution into
// "win small often, lose big occasionally". A high win rate here is expected and means nothing. The
// number that matters is contract-weighted P&L per contract versus holding.
/**
 * @param fills [{ pnlCents, contracts, excursionCents }] — excursionCents null when the path was
 *              never observed again after the fill (no later segment), which counts as "held".
 * @param thresholds exit triggers in cents
 */
export function exitCounterfactual({ fills, thresholds = [1, 2, 3, 5, 8, 12] } = {}) {
  const rows = (fills || []).filter((f) => Number(f.contracts) > 0 && f.pnlCents != null);
  const totalC = rows.reduce((s, f) => s + Number(f.contracts), 0);
  if (!totalC) return { fills: 0, contracts: 0, holdPnlPerContract: null, byThreshold: [], excursion: null };

  const hold = rows.reduce((s, f) => s + Number(f.pnlCents) * Number(f.contracts), 0) / totalC;

  const exc = rows.map((f) => f.excursionCents).filter((v) => v != null).map(Number).sort((a, b) => a - b);
  const pct = (p) => (exc.length ? exc[Math.min(exc.length - 1, Math.floor((p / 100) * exc.length))] : null);
  const observed = exc.length;

  const byThreshold = thresholds.map((t) => {
    let pnl = 0, exited = 0, exitedC = 0;
    for (const f of rows) {
      const c = Number(f.contracts);
      const e = f.excursionCents == null ? null : Number(f.excursionCents);
      if (e != null && e >= t) { pnl += t * c; exited++; exitedC += c; }
      else pnl += Number(f.pnlCents) * c;
    }
    return {
      thresholdCents: t,
      exitedFills: exited,
      exitedPctOfContracts: r2((exitedC / totalC) * 100),
      pnlPerContract: r2(pnl / totalC),
      deltaVsHold: r2(pnl / totalC - hold),
    };
  });

  return {
    fills: rows.length,
    contracts: r2(totalC),
    holdPnlPerContract: r2(hold),
    excursion: {
      observedFills: observed,
      unobservedFills: rows.length - observed,
      everProfitablePct: observed ? r2((exc.filter((v) => v > 0).length / observed) * 100) : null,
      p25: pct(25), median: pct(50), p75: pct(75), p90: pct(90), max: exc.length ? exc[exc.length - 1] : null,
    },
    byThreshold,
  };
}


const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);


// ── Ladder-calibrated anomaly detection (2026-08-11) ──────────────────────────────────────────
// Replaces the heatmap's original anomaly flag, whose null hypothesis was "the band's PRICE equals
// its realized outcome frequency" (`tail = (1-p)^fills < 0.001` at the band midpoint). That null is
// exactly what the band-ladder artifact falsifies — every book's realized sideWon is a monotone
// function of price that sits well away from the diagonal — so the old test fired on the ENDS of
// steep ladders and nowhere else. On 2026-08-11 all six flagged cells sat within 0.07 of their own
// ladder while sitting 0.12-0.28 from their price: six for six false positives.
//
// Worse, it could not see the bug it was named for. It only evaluated cells whose sideWon was
// EXACTLY 0 or 1, but a wrong-side fill does not pin an outcome — it INVERTS one, grading a 15-19c
// cell at ~0.85 where ~0.07 belongs. That is a gross departure from the ladder and the old test
// never looked at it. Detecting inversions, not extremes, is the point of this rewrite.
//
// The null here is the category's OWN monotone price->outcome curve, so "extreme because the ladder
// is extreme" is no longer anomalous while "out of ladder order" is. See docs/MAKER_LADDER_ARTIFACT.md.

export const LADDER_BAR = {
  minFills: 20,        // cell must have this many fills to be TESTED, and to be trusted as a REFERENCE
  minDays: 3,          // ... and enough days for a clustered interval (mirrors dayClusteredPnl)
  minTickers: 5,       // ... and this many distinct GAMES (see below)
  minBands: 4,         // category needs this many reference-quality bands to have a ladder at all
  minResidual: 0.15,   // practical floor: a significant but trivial departure is not an integrity signal
  maxSpanC: 11,        // widest price gap the reference may be interpolated across (see below)
  maxEndGapC: 6,       // ... and at a ladder END, the widest gap to its single inward rung
};

// ── Two thinness guards added 2026-08-11, after the first version flagged mlb|f5spread 40-64 ──
//
// `maxSpanC`. The reference is read between the nearest qualifying rung on each side. When the bands
// in between are excluded for thinness that span can be long — for f5spread|55-59 the neighbours were
// 40-44 and 60-64, a 20c gap straddling the steepest part of the ladder, because 45-49 (n=5) and
// 50-54 (n=16) were correctly dropped. Interpolating across that is an extrapolation wearing an
// interpolation's clothes, and it produced a fitted 0.49 that flagged a cell sitting at 0.846.
//
// `maxEndGapC` closes the hole `maxSpanC` did not cover. At a ladder end there is only one rung, so
// no bracket exists and the span check was skipped entirely — the fitted value became that rung's
// level AT ANY DISTANCE. On the 2026-08-11 board that put `argprem|spread|5-9` (a 7c band) against
// the 75-79 rung 70c away for a −0.91 "residual", and `mlb|f7ml|10-14` against 40-44, 30c away.
// Both were pure artifacts of the missing guard. 6 is the widest gap between ADJACENT rung mids
// (5 everywhere, 6 for 87->93), so this is the same "no missing rungs" rule applied to one side.
//
// `maxSpanC` is 11, not 10, because the band ladder is not uniform: bands are 5c wide except the top
// one (90-96, 7c), so the widest bracket between two ADJACENT rungs is 82->93 = 11. Setting it to 10
// would make 85-89 permanently unreferencable and, under the self-consistency rule below, cascade
// down the top of every ladder. The number comes from `_makerBandCase`'s fixed layout, not from any
// outcome — "no missing rungs" is the actual rule it encodes.
//
// `minTickers`. Fill count is a poor measure of a cell's real sample: f5spread|55-59 had 132 fills
// over 17 days, but 14 of those days landed at sideWon EXACTLY 0 or 1 — each was a single game, one
// Bernoulli draw, not 50 independent contracts. A clean band (70-74) had 1 such day in 20. The
// obvious guard — count non-degenerate days — is WRONG, and the data says so: at the ladder ends
// degenerate days are legitimate and common (85-89 runs 10/21, 90-96 runs 10/13, both correctly
// calibrated), so that rule would silence exactly the extreme cells this detector exists to watch.
// Distinct GAMES is the same signal without the price dependence, so that is what is gated on.

// Weighted isotonic regression (pool-adjacent-violators). Returns the monotone non-decreasing fit of
// `y` on `x`-order that minimises weighted squared error — the maximum-likelihood ladder given only
// the assumption we actually believe (outcome frequency rises with price). Points must be pre-sorted
// by x. Pure, no allocation beyond the block list.
export function isotonicFit(points) {
  const pts = Array.isArray(points) ? points : [];
  if (!pts.length) return [];
  // Each block holds a pooled level; violations are merged backwards until the sequence is monotone.
  const blocks = [];
  for (const p of pts) {
    const w = Number(p.w) > 0 ? Number(p.w) : 0;
    if (!(w > 0)) continue;
    let blk = { sumW: w, sumWY: w * Number(p.y), n: 1 };
    while (blocks.length && (blocks[blocks.length - 1].sumWY / blocks[blocks.length - 1].sumW) > (blk.sumWY / blk.sumW)) {
      const prev = blocks.pop();
      blk = { sumW: prev.sumW + blk.sumW, sumWY: prev.sumWY + blk.sumWY, n: prev.n + blk.n };
    }
    blocks.push(blk);
  }
  const out = [];
  for (const b of blocks) { const lvl = b.sumWY / b.sumW; for (let i = 0; i < b.n; i++) out.push(lvl); }
  return out;
}

// Day-clustered interval for a cell's contract-weighted sideWon. Same unit and same clustering as
// dayClusteredPnl: contracts inside a fill share one outcome, and fills inside a day resolve off a
// few correlated games, so the DAY is the independent observation.
function dayClusteredRate({ days, z = Z_95 } = {}) {
  const rows = (Array.isArray(days) ? days : []).filter(d => Number(d?.contracts) > 0);
  const m = rows.length;
  const C = rows.reduce((s, d) => s + Number(d.contracts), 0);
  if (m < 1 || !(C > 0)) return { days: m, mean: null, loCI: null, hiCI: null };
  const mean = rows.reduce((s, d) => s + Number(d.won || 0), 0) / C;
  if (m < 2) return { days: m, mean, loCI: null, hiCI: null };
  let ss = 0;
  for (const d of rows) {
    const resid = Number(d.won || 0) - mean * Number(d.contracts);
    ss += resid * resid;
  }
  const se = ss > 0 ? Math.sqrt((m / (m - 1)) * ss / (C * C)) : 0;
  return { days: m, mean, se, loCI: mean - z * se, hiCI: mean + z * se };
}

// Score one category's ladder. `cells` = every band in ONE sport|category, each
// `{band, mid, fills, contracts, sideWon, byDay:[{contracts, won}]}`. Returns a Map band -> {anomaly,
// anomalyReason, fitted, residual}. Failure-closed: a ladder too sparse to calibrate against yields
// no flags at all rather than falling back to the price null this replaces.
export function ladderAnomalies(cells, bar = LADDER_BAR) {
  const out = new Map();
  const all = (Array.isArray(cells) ? cells : []).filter(c => c && Number.isFinite(c.mid) && c.sideWon != null)
    .slice().sort((a, b) => a.mid - b.mid);
  for (const c of all) out.set(c.band, { anomaly: false, anomalyReason: null, fitted: null, residual: null });

  // ── A reference must itself be judgeable (2026-08-11, the third instance of one error) ────────
  // `refs` used to filter on minFills alone, so a cell the detector REFUSES to test was still
  // trusted to calibrate its neighbours. That is what produced the last surviving flag on the
  // 2026-08-11 board: mlb|f5spread|60-64 was measured against a fitted 0.75 that came from pooling
  // 55-59 (0.846) — a band with 5.3 fills per game against a clean band's 1.3-2.4, and 14 of its 17
  // days at a single game, which maxSpanC already declined to test. Removing that one band from the
  // ladder does not merely clear 60-64; it makes it untestable, which is the honest answer for a
  // rung with nothing calibratable either side of it.
  //
  // ONE refinement pass, deliberately not iterated to a fixed point: every removal widens the spans
  // around it, so iterating cascades and empties ladders that hold a perfectly good contiguous run
  // (on f5spread it would walk the whole sub-50 half away, band by band).
  const refs0 = all.filter(c => (c.fills || 0) >= bar.minFills
    && (c.tickers == null || c.tickers >= bar.minTickers));
  const _bracketOk = (c, list) => {
    let iA = list.findIndex(r => r.mid > c.mid);
    if (iA < 0) iA = list.length;
    const below = iA > 0 ? list[iA - 1] : null, above = iA < list.length ? list[iA] : null;
    if (!below && !above) return false;
    if (below && above) return (above.mid - below.mid) <= bar.maxSpanC;
    // Ladder end: nothing outward to violate, but the ONE inward rung still has to be near enough
    // to say anything about this cell.
    return Math.abs((below || above).mid - c.mid) <= bar.maxEndGapC;
  };
  if (refs0.length < bar.minBands) return out;  // no ladder to calibrate against

  // Category-level check FIRST. A side-flip in one emit module inverts every band together, which
  // leaves each cell close to a (flattened) fit and so is invisible to the per-cell residual. A
  // ladder whose realized outcome rate FALLS as price rises is itself the integrity signal.
  // Deliberately scored against refs0, NOT the self-consistent set below: a wholesale inversion
  // makes the rungs stop bracketing each other, so gating this on bracket-consistency would disarm
  // it on precisely the case it exists to catch.
  const lo = refs0.slice(0, Math.ceil(refs0.length / 2)), hi = refs0.slice(Math.floor(refs0.length / 2));
  const wMean = (xs) => { let w = 0, s = 0; for (const c of xs) { const cw = Number(c.contracts) || 0; w += cw; s += cw * c.sideWon; } return w > 0 ? s / w : null; };
  const loM = wMean(lo), hiM = wMean(hi);
  if (loM != null && hiM != null && hiM < loM - bar.minResidual) {
    for (const c of all) out.set(c.band, { anomaly: true, fitted: null, residual: null,
      anomalyReason: `ladder inverted: sideWon falls ${r2(loM)}→${r2(hiM)} as price rises` });
    return out;
  }

  const refs = refs0.filter(r => _bracketOk(r, refs0.filter(x => x.band !== r.band)));
  if (refs.length < bar.minBands) return out;   // nothing left that can calibrate anything

  for (const c of all) {
    if ((c.fills || 0) < bar.minFills) continue;
    if (c.tickers != null && c.tickers < bar.minTickers) continue;
    const dc = dayClusteredRate({ days: c.byDay });
    if ((dc.days || 0) < bar.minDays || dc.mean == null) continue;
    // Leave-one-out: the cell under test must not contribute to the reference it is judged against,
    // or it drags the fit toward itself and a real inversion partly hides its own evidence.
    const loo = refs.filter(r => r.band !== c.band);
    if (loo.length < bar.minBands - 1) continue;
    const fitAll = isotonicFit(loo.map(r => ({ y: r.sideWon, w: Number(r.contracts) || 1 })));
    // The fit is defined on the LOO ladder; read it at the neighbouring rung on each side and
    // interpolate BY PRICE DISTANCE. Averaging the two levels instead would misread an uneven ladder
    // — bands are not equally spaced (90-96 is 7c wide) and a category can skip rungs entirely, so a
    // cell sitting just above a gap would be compared against a midpoint it is nowhere near.
    // At an END there is no outward rung, so the nearest fitted level is used — which is why an end
    // can only flag by inverting INWARD, never by being extreme.
    let iAbove = loo.findIndex(r => r.mid > c.mid);
    if (iAbove < 0) iAbove = loo.length;
    const seOf = (r) => { const d = dayClusteredRate({ days: r.byDay }); return Number.isFinite(d.se) ? d.se : null; };
    const below = iAbove > 0 ? { y: fitAll[iAbove - 1], x: loo[iAbove - 1].mid, se: seOf(loo[iAbove - 1]) } : null;
    const above = iAbove < loo.length ? { y: fitAll[iAbove], x: loo[iAbove].mid, se: seOf(loo[iAbove]) } : null;
    let fitted = null, seFit = null;
    // Too far apart to interpolate between: the curve between them is unobserved, so any value read
    // off the straight line is invented. Skip rather than test against a fabricated reference.
    if (below && above && (above.x - below.x) > bar.maxSpanC) continue;
    if (below && above) {
      const span = above.x - below.x;
      const t = span > 0 ? (c.mid - below.x) / span : 0.5;
      fitted = below.y + t * (above.y - below.y);
      // The REFERENCE is an estimate too. Testing against it as though it were known exactly was the
      // first version's error: it treated a noisy neighbouring rung as ground truth and so flagged
      // ordinary mid-ladder roughness (27 cells on the 2026-08-11 board, where the ring should be
      // near-empty). Interpolation weights carry through to the variance.
      seFit = Math.sqrt(((1 - t) * (below.se ?? 0)) ** 2 + (t * (above.se ?? 0)) ** 2);
    } else {
      const e = below || above;
      if (!e || Math.abs(e.x - c.mid) > bar.maxEndGapC) continue;  // nearest rung too far to inform
      fitted = e.y; seFit = e.se ?? 0;
    }
    if (fitted == null) continue;
    const residual = dc.mean - fitted;
    // Significant against the COMBINED uncertainty of cell and reference, AND materially large.
    const seTot = Math.sqrt((Number.isFinite(dc.se) ? dc.se : 0) ** 2 + (seFit || 0) ** 2);
    const sig = seTot > 0 ? Math.abs(residual) > Z_95 * seTot : Math.abs(residual) >= bar.minResidual;
    const anomaly = sig && Math.abs(residual) >= bar.minResidual;
    out.set(c.band, { anomaly, fitted: r2(fitted), residual: r2(residual),
      anomalyReason: anomaly
        ? `sideWon ${r2(dc.mean)} vs ladder-fitted ${r2(fitted)} (${residual > 0 ? "+" : ""}${r2(residual)}) — out of ladder order`
        : null });
  }
  return out;
}
