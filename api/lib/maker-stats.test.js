// node --test api/lib/maker-stats.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { contractWeightedPnl, weightedPnlSumsSql, weightedPnlFromRow, dayClusteredPnl } from "./maker-stats.js";

// Build the six sums from explicit [contracts, pnl] fills, so each test states its data plainly
// instead of hand-computing sums.
function sums(fills) {
  let sumC = 0, sumCP = 0, sumC2 = 0, sumC2P = 0, sumC2P2 = 0;
  for (const [c, p] of fills) {
    sumC += c; sumCP += c * p; sumC2 += c * c; sumC2P += c * c * p; sumC2P2 += c * c * p * p;
  }
  return { n: fills.length, sumC, sumCP, sumC2, sumC2P, sumC2P2 };
}

// Reference implementations, deliberately written the naive/direct way so they can disagree with
// the algebraically-expanded production formula if it's wrong.
const refMean = (f) => f.reduce((s, [c, p]) => s + c * p, 0) / f.reduce((s, [c]) => s + c, 0);
function refSe(f) {
  const R = refMean(f), n = f.length, C = f.reduce((s, [c]) => s + c, 0);
  const ss = f.reduce((s, [c, p]) => s + (c * (p - R)) ** 2, 0);
  return Math.sqrt((n / (n - 1)) * ss / (C * C));
}

test("equal weights reduce EXACTLY to the ordinary mean and SE of the mean", () => {
  // The load-bearing sanity check on the algebra: with every c=1 the ratio estimator must collapse
  // to s²/n, the textbook SE. If the expansion is wrong, this is what catches it.
  const pnl = [10, -20, 30, -5, 12, -40, 7];
  const f = pnl.map(p => [1, p]);
  const got = contractWeightedPnl(sums(f));

  const mean = pnl.reduce((a, b) => a + b, 0) / pnl.length;
  const s2 = pnl.reduce((a, p) => a + (p - mean) ** 2, 0) / (pnl.length - 1);
  const se = Math.sqrt(s2 / pnl.length);

  assert.equal(got.mean, parseFloat(mean.toFixed(2)));
  assert.equal(got.se, parseFloat(se.toFixed(2)));
});

test("weighted mean matches a direct ratio computation", () => {
  const f = [[10, 5], [1, -80], [100, 2], [3, 40]];
  const got = contractWeightedPnl(sums(f));
  assert.equal(got.mean, parseFloat(refMean(f).toFixed(2)));
  assert.equal(got.contracts, 114);
  assert.equal(got.n, 4, "n is FILLS, not contracts");
});

test("weighted SE matches the direct (unexpanded) delta-method computation", () => {
  const f = [[10, 5], [1, -80], [100, 2], [3, 40], [25, -13], [7, 60]];
  const got = contractWeightedPnl(sums(f));
  assert.equal(got.se, parseFloat(refSe(f).toFixed(2)));
});

test("CI is symmetric around the mean at ~1.96 SE", () => {
  const f = [[10, 5], [4, -30], [7, 22], [2, 9]];
  const got = contractWeightedPnl(sums(f));
  // Bounds are derived from FULL-precision mean/se and rounded once at the end, so they can differ
  // by up to a cent from a re-derivation off the already-rounded fields. Tolerance, not equality.
  const z = 1.959963985;
  assert.ok(Math.abs(got.loCI - (got.mean - z * got.se)) <= 0.02, `loCI ${got.loCI}`);
  assert.ok(Math.abs(got.hiCI - (got.mean + z * got.se)) <= 0.02, `hiCI ${got.hiCI}`);
  // Symmetry itself is exact in full precision, so the midpoint must land on the mean.
  assert.ok(Math.abs((got.loCI + got.hiCI) / 2 - got.mean) <= 0.01);
  assert.ok(got.loCI < got.mean && got.mean < got.hiCI);
});

test("THE TRAP: treating each contract as an observation would understate the CI", () => {
  // 200 fills of 10 contracts each. Contracts inside a fill share one outcome, so the honest n is
  // 200, not 2000. The wrong model divides by sqrt(2000) and reports a CI sqrt(10)x too narrow.
  const f = Array.from({ length: 200 }, (_, i) => [10, i % 2 ? 40 : -40]);
  const got = contractWeightedPnl(sums(f));

  // Honest SE treats the 200 fills as the units.
  const perFill = f.map(([, p]) => p);
  const m = perFill.reduce((a, b) => a + b, 0) / 200;
  const s = Math.sqrt(perFill.reduce((a, p) => a + (p - m) ** 2, 0) / 199);
  const honestSe = s / Math.sqrt(200);
  assert.equal(got.se, parseFloat(honestSe.toFixed(2)));

  // The contract-as-observation SE would be sqrt(10) smaller. Assert we are NOT that.
  const inflatedSe = s / Math.sqrt(2000);
  assert.ok(got.se > inflatedSe * 3, "SE must reflect 200 independent fills, not 2000 contracts");
});

test("a big fill moves the weighted mean away from the unweighted one", () => {
  // Unweighted mean is positive; the one huge losing fill makes the weighted mean negative. This
  // is the entire reason the metric was added.
  const f = [[1, 10], [1, 10], [1, 10], [500, -5]];
  const got = contractWeightedPnl(sums(f));
  const unweighted = (10 + 10 + 10 - 5) / 4;
  assert.ok(unweighted > 0, "unweighted reads positive");
  assert.ok(got.mean < 0, `weighted must read negative, got ${got.mean}`);
});

test("identical pnl on every fill → zero SE, not NaN (float-cancellation clamp)", () => {
  const f = [[3, 7], [11, 7], [2, 7]];
  const got = contractWeightedPnl(sums(f));
  assert.equal(got.mean, 7);
  assert.equal(got.se, 0);
  assert.equal(got.loCI, 7);
});

test("degenerate inputs are null-safe, never NaN", () => {
  for (const bad of [undefined, {}, { n: 0, sumC: 0 }, { n: 5, sumC: 0, sumCP: 100 }]) {
    const got = contractWeightedPnl(bad);
    assert.equal(got.mean, null);
    assert.equal(got.se, null);
    assert.equal(got.loCI, null);
  }
});

test("n=1 yields a mean but no CI (nothing to estimate variance from)", () => {
  const got = contractWeightedPnl(sums([[10, 42]]));
  assert.equal(got.mean, 42);
  assert.equal(got.se, null);
  assert.equal(got.loCI, null);
});

test("fractional contracts work (Kalshi contracts are decimal)", () => {
  const f = [[2.5, 12], [0.5, -60], [7.25, 3]];
  const got = contractWeightedPnl(sums(f));
  assert.equal(got.mean, parseFloat(refMean(f).toFixed(2)));
  assert.equal(got.se, parseFloat(refSe(f).toFixed(2)));
});

test("weightedPnlSumsSql emits the six aliases weightedPnlFromRow reads", () => {
  const sql = weightedPnlSumsSql({ pnlCol: "f.pnl_cents", contractsCol: "f.contracts", filter: "f.graded_at IS NOT NULL" });
  for (const alias of ["w_n", "w_sum_c", "w_sum_cp", "w_sum_c2", "w_sum_c2p", "w_sum_c2p2"]) {
    assert.ok(sql.includes(`AS ${alias}`), `missing ${alias}`);
  }
  assert.ok(sql.includes("FILTER (WHERE f.graded_at IS NOT NULL)"));
});

test("weightedPnlSumsSql omits FILTER when no filter is given", () => {
  const sql = weightedPnlSumsSql({ pnlCol: "pnl_cents", contractsCol: "contracts" });
  assert.ok(!sql.includes("FILTER"));
});

test("weightedPnlFromRow maps DB column names (incl. numeric-as-string) correctly", () => {
  const f = [[10, 5], [1, -80], [100, 2]];
  const s = sums(f);
  // Neon returns NUMERIC as strings — the mapper must survive that.
  const row = {
    w_n: s.n, w_sum_c: String(s.sumC), w_sum_cp: String(s.sumCP),
    w_sum_c2: String(s.sumC2), w_sum_c2p: String(s.sumC2P), w_sum_c2p2: String(s.sumC2P2),
  };
  assert.deepEqual(weightedPnlFromRow(row), contractWeightedPnl(s));
});

// ── dayClusteredPnl (2026-07-26) ──────────────────────────────────────────────────────────────
// Correlation ACROSS fills sharing a day, one level up from the within-fill correlation
// contractWeightedPnl handles. V1 sells favorites, so a day is essentially one bet on whether
// favorites underperformed — the day is the independent unit, not the fill.

test("dayClusteredPnl: collapses to the ordinary SE of the mean at one 1-contract fill per day", () => {
  // Same sanity property contractWeightedPnl has at unit weights: with c=1 every day, the ratio
  // estimator's variance must reduce exactly to s^2/m.
  const pnls = [4, -2, 7, 1, -5, 3];
  const days = pnls.map(p => ({ pnl: p, contracts: 1 }));
  const got = dayClusteredPnl({ days });

  const m = pnls.length;
  const mean = pnls.reduce((a, b) => a + b, 0) / m;
  const s2 = pnls.reduce((a, p) => a + (p - mean) ** 2, 0) / (m - 1);
  const se = Math.sqrt(s2 / m);

  assert.equal(got.days, m);
  assert.equal(got.mean, parseFloat(mean.toFixed(2)));
  assert.equal(got.se, parseFloat(se.toFixed(2)));
});

test("dayClusteredPnl: mean is the contract-weighted ratio, identical to the fill-level mean", () => {
  // Clustering must change ONLY the interval, never the point estimate.
  const days = [
    { pnl: 1000, contracts: 500 },   // +2.0c/contract
    { pnl: -300, contracts: 200 },   // -1.5c/contract
    { pnl: 450, contracts: 300 },    // +1.5c/contract
  ];
  const got = dayClusteredPnl({ days });
  assert.equal(got.contracts, 1000);
  assert.equal(got.mean, 1.15); // (1000 - 300 + 450) / 1000
});

test("dayClusteredPnl: a lumpy book straddles zero where the fill-level CI would not", () => {
  // The 2026-07-26 V1 shape: two hugely positive days against five negative ones. This is the
  // whole reason the estimator exists — it must NOT report a positive lower bound here.
  const days = [
    { pnl: 256, contracts: 223.39 },
    { pnl: 8929.6, contracts: 3699.93 },
    { pnl: -10571.6, contracts: 10624.16 },
    { pnl: -58714.1, contracts: 11687.75 },
    { pnl: -19852.2, contracts: 9465.91 },
    { pnl: 100513.8, contracts: 8852.25 },
    { pnl: 85995.1, contracts: 16868.74 },
  ];
  const got = dayClusteredPnl({ days });
  assert.equal(got.days, 7);
  assert.ok(got.mean > 1.5 && got.mean < 2.0, `mean ${got.mean} should match the ~+1.76c headline`);
  assert.ok(got.loCI < 0, `loCI ${got.loCI} must straddle zero on a two-day-driven book`);
  assert.ok(got.hiCI > 0);
  assert.ok(got.se > 2, `se ${got.se} should be far wider than the ~0.54 fill-level se`);
});

test("dayClusteredPnl: days with no graded contracts are dropped, not counted as clusters", () => {
  const withEmpties = dayClusteredPnl({ days: [
    { pnl: 100, contracts: 50 }, { pnl: 0, contracts: 0 },
    { pnl: -40, contracts: 50 }, { pnl: 0, contracts: 0 },
  ] });
  const without = dayClusteredPnl({ days: [{ pnl: 100, contracts: 50 }, { pnl: -40, contracts: 50 }] });
  assert.equal(withEmpties.days, 2, "zero-contract days must not inflate the cluster count");
  assert.deepEqual(withEmpties, without);
});

test("dayClusteredPnl: fewer than 2 days yields a mean but no interval", () => {
  const one = dayClusteredPnl({ days: [{ pnl: 100, contracts: 50 }] });
  assert.equal(one.days, 1);
  assert.equal(one.mean, 2);
  assert.equal(one.se, null);
  assert.equal(one.loCI, null);
  assert.equal(one.hiCI, null);
});

test("dayClusteredPnl: empty / null / all-zero-contract input is null-safe", () => {
  for (const days of [[], null, undefined, [{ pnl: 5, contracts: 0 }]]) {
    const got = dayClusteredPnl({ days });
    assert.equal(got.mean, null);
    assert.equal(got.loCI, null);
    assert.equal(got.hiCI, null);
  }
  assert.equal(dayClusteredPnl().mean, null);
});

test("dayClusteredPnl: identical per-day ratios give zero spread, not NaN", () => {
  const got = dayClusteredPnl({ days: [
    { pnl: 100, contracts: 50 }, { pnl: 200, contracts: 100 }, { pnl: 40, contracts: 20 },
  ] });
  assert.equal(got.mean, 2);
  assert.equal(got.se, 0);
  assert.equal(got.loCI, 2);
  assert.equal(got.hiCI, 2);
});
