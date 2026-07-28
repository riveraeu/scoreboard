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

export const LEAD_BUCKETS = ["0-1h", "1-3h", "3-6h", "6-12h", "12h+"];
const NEAR = new Set(["0-1h", "1-3h"]);
const FAR = new Set(["6-12h", "12h+"]);

// Seller edge in cents/contract from contract-weighted sums. pnl = ask − 100·won, so the
// contract-weighted mean is (Σ ask·c − 100·Σ won·c) / Σ c.
const edgeOf = (sumAskC, sumWonC, contracts) =>
  contracts > 0 ? (Number(sumAskC) - 100 * Number(sumWonC)) / Number(contracts) : null;

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/**
 * Roll (day, band, bucket) groups up per BUCKET, pooled across days and bands.
 * @param rows [{ day, band, bucket, contracts, sum_ask_ctr, sum_won_ctr, fills }]
 * @returns [{ bucket, fills, contracts, avgAsk, sideWonRate, edgeCents }] in LEAD_BUCKETS order
 */
export function leadTimeBuckets(rows) {
  const acc = new Map(LEAD_BUCKETS.map((b) => [b, { fills: 0, c: 0, ask: 0, won: 0 }]));
  for (const r of rows || []) {
    const a = acc.get(r.bucket);
    if (!a) continue;
    a.fills += Number(r.fills || 0);
    a.c += Number(r.contracts || 0);
    a.ask += Number(r.sum_ask_ctr || 0);
    a.won += Number(r.sum_won_ctr || 0);
  }
  return LEAD_BUCKETS.map((bucket) => {
    const a = acc.get(bucket);
    return {
      bucket, fills: a.fills, contracts: r2(a.c),
      avgAsk: a.c > 0 ? r2(a.ask / a.c) : null,
      sideWonRate: a.c > 0 ? r2((a.won / a.c) * 100) / 100 : null,
      edgeCents: r2(edgeOf(a.ask, a.won, a.c)),
    };
  });
}

/**
 * Spearman rank correlation between bucket ORDER (increasing lead time) and bucket edge. Buckets
 * with no data drop out and ranks are assigned over what remains. Null below 3 usable points.
 */
export function spearmanEdgeVsLead(buckets) {
  const pts = (buckets || []).map((b, i) => ({ i, e: b.edgeCents })).filter((p) => p.e != null);
  const n = pts.length;
  if (n < 3) return null;
  const sorted = [...pts].sort((a, b) => a.e - b.e);
  const rank = new Map();
  for (let i = 0; i < sorted.length;) {  // average ranks across ties
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].e === sorted[i].e) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank.set(sorted[k].i, avg);
    i = j + 1;
  }
  // Lead order is already ascending over the surviving points, so its ranks are their positions.
  const xs = pts.map((_, idx) => idx + 1);
  const ys = pts.map((p) => rank.get(p.i));
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? r2(num / Math.sqrt(dx * dy)) : null;
}

/**
 * Mix-adjusted near−far difference PER DAY.
 *
 * The mix adjustment is the whole reason this is not a two-line query: seller edge swings ±7¢
 * across price bands, so an unadjusted near-vs-far comparison measures the price mix of the two
 * windows as much as the windows themselves. That Simpson's-paradox shape has bitten this board
 * three times. The difference is therefore computed WITHIN band and re-weighted onto one pooled
 * contract distribution; bands where a day lacks either arm contribute nothing to that day.
 *
 * @returns { days: [{ day, diffCents, bands, contracts }], weights }
 */
export function mixAdjustedNearFarByDay(rows) {
  // Pooled band weights over rows that can participate at all.
  const bandPool = new Map();
  for (const r of rows || []) {
    if (!NEAR.has(r.bucket) && !FAR.has(r.bucket)) continue;
    bandPool.set(r.band, (bandPool.get(r.band) || 0) + Number(r.contracts || 0));
  }

  const byDayBand = new Map(); // (day, band) -> { near, far }
  for (const r of rows || []) {
    const arm = NEAR.has(r.bucket) ? "near" : FAR.has(r.bucket) ? "far" : null;
    if (!arm) continue;
    const key = `${r.day} ${r.band}`;
    if (!byDayBand.has(key)) byDayBand.set(key, { day: r.day, band: r.band, near: null, far: null });
    const slot = byDayBand.get(key);
    if (!slot[arm]) slot[arm] = { c: 0, ask: 0, won: 0 };
    slot[arm].c += Number(r.contracts || 0);
    slot[arm].ask += Number(r.sum_ask_ctr || 0);
    slot[arm].won += Number(r.sum_won_ctr || 0);
  }

  const perDay = new Map();
  for (const slot of byDayBand.values()) {
    if (!slot.near || !slot.far || !(slot.near.c > 0) || !(slot.far.c > 0)) continue;
    const w = bandPool.get(slot.band) || 0;
    if (!(w > 0)) continue;
    const d = edgeOf(slot.near.ask, slot.near.won, slot.near.c)
            - edgeOf(slot.far.ask, slot.far.won, slot.far.c);
    if (!perDay.has(slot.day)) perDay.set(slot.day, { wsum: 0, acc: 0, bands: 0, contracts: 0 });
    const p = perDay.get(slot.day);
    p.wsum += w;
    p.acc += w * d;
    p.bands += 1;
    p.contracts += slot.near.c + slot.far.c;
  }

  const days = [...perDay.entries()]
    .filter(([, p]) => p.wsum > 0)
    .map(([day, p]) => ({ day, diffCents: r2(p.acc / p.wsum), bands: p.bands, contracts: r2(p.contracts) }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  return { days, weights: Object.fromEntries([...bandPool].map(([b, c]) => [b, r2(c)])) };
}

/**
 * Day-level mean and 95% CI over the per-day differences. The DAY is the unit for the same reason
 * it is in `armCriterion`: fills inside a day resolve off one correlated slate, so treating fills
 * as independent would shrink this interval by the same ~4.5x that produced a false ARM-MET
 * reading on 2026-07-26.
 */
export function dayLevelDiffCI(days, z = Z_95) {
  const xs = (days || []).map((d) => d.diffCents).filter((v) => v != null && Number.isFinite(v));
  const m = xs.length;
  if (m < 2) return { days: m, mean: m === 1 ? r2(xs[0]) : null, se: null, loCI: null, hiCI: null };
  const mean = xs.reduce((s, v) => s + v, 0) / m;
  const varr = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (m - 1);
  const se = Math.sqrt(varr / m);
  return { days: m, mean: r2(mean), se: r2(se), loCI: r2(mean - z * se), hiCI: r2(mean + z * se) };
}

/**
 * Apply the pre-registered decision rule. Deliberately mechanical, thresholds inline, so the
 * verdict cannot drift from docs/MAKER_LEADTIME_PREREG.md by reinterpretation after the fact.
 */
export function leadTimeVerdict({ ci, days, spearman } = {}) {
  const list = days || [];
  const signPositive = list.filter((d) => d.diffCents > 0).length;
  const primary = ci?.loCI != null && ci.loCI > 0;
  const coherence = signPositive >= 7;
  const monotonic = spearman != null && spearman <= -0.5;
  const inconclusive = list.length < 6;
  return {
    primary, coherence, monotonic, inconclusive,
    signPositive, totalDays: list.length,
    criteria: {
      primary: "dayClustered CI on mix-adjusted (near - far) entirely > 0",
      coherence: "positive daily sign in >= 7 of 9 days",
      monotonic: "Spearman rho(edge vs lead order) <= -0.5",
    },
    verdict: inconclusive ? "INCONCLUSIVE"
      : (primary && coherence && monotonic) ? "H1 SUPPORTED" : "H1 REJECTED",
  };
}
