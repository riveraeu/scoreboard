// node --test api/lib/maker-stats.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { contractWeightedPnl, weightedPnlSumsSql, weightedPnlFromRow, dayClusteredPnl, quotedOutcomesByBand, adverseSelectionWithinBand, isotonicFit, ladderAnomalies, LADDER_BAR } from "./maker-stats.js";

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

// ── quotedOutcomesByBand / adverseSelectionWithinBand (2026-07-26) ────────────────────────────
// This diagnostic has been wrong twice while it lived untested inside handlers/shadow.js: once a
// duplicated CASE-WHEN that drifted from grading, once a last-quote-only population that made the
// metric INVERT (filled edge above quoted — backwards for a resting maker). These pin the contract.

test("quotedOutcomesByBand: weights by SEGMENTS, not by row", () => {
  // Two groups in one band: 90 segments won, 10 lost. Row-weighting would give 50%.
  const got = quotedOutcomesByBand([
    { band: "70-74", ticker: "A", segments: 90, sumAsk: 90 * 72, sideWon: true },
    { band: "70-74", ticker: "B", segments: 10, sumAsk: 10 * 72, sideWon: false },
  ]);
  assert.equal(got.n, 100);
  assert.equal(got.sideWonRate, 0.9, "segment-weighted, not row-weighted");
  assert.equal(got.avgAsk, 72);
  assert.equal(got.edgeCents, -18); // 72 - 100*0.9
});

test("quotedOutcomesByBand: unresolved rows (sideWon null) drop out entirely", () => {
  const got = quotedOutcomesByBand([
    { band: "80-84", ticker: "A", segments: 50, sumAsk: 50 * 82, sideWon: true },
    { band: "80-84", ticker: "B", segments: 999, sumAsk: 999 * 82, sideWon: null },
    { band: "80-84", ticker: "C", segments: 50, sumAsk: 50 * 82, sideWon: false },
  ]);
  assert.equal(got.n, 100, "the null row contributes no segments");
  assert.equal(got.tickers, 2);
  assert.equal(got.sideWonRate, 0.5);
});

test("quotedOutcomesByBand: a ticker spanning bands is counted in each, deduped overall", () => {
  const got = quotedOutcomesByBand([
    { band: "70-74", ticker: "A", segments: 10, sumAsk: 10 * 72, sideWon: true },
    { band: "75-79", ticker: "A", segments: 10, sumAsk: 10 * 77, sideWon: true },
  ]);
  assert.equal(got.tickers, 1, "same market, deduped at top level");
  assert.equal(got.byBand.length, 2);
  assert.equal(got.byBand[0].band, "70-74");
  assert.equal(got.byBand[1].band, "75-79");
  assert.deepEqual(got.byBand.map(b => b.tickers), [1, 1]);
});

test("quotedOutcomesByBand: null-safe on empty / malformed input", () => {
  for (const input of [[], null, undefined]) {
    const got = quotedOutcomesByBand(input);
    assert.equal(got.n, 0);
    assert.equal(got.sideWonRate, null);
    assert.equal(got.edgeCents, null);
    assert.deepEqual(got.byBand, []);
  }
  assert.equal(quotedOutcomesByBand([{ band: "x", ticker: "A", segments: 0, sumAsk: 0, sideWon: true }]).n, 0);
});

test("adverseSelectionWithinBand: mix adjustment strips a pure composition difference", () => {
  // Same per-band edges on both sides => the TRUE gap is zero, but the raw filled average differs
  // from the quoted one purely because fills concentrate in the cheap band. Mix adjustment must
  // return exactly 0 — this is the confound that made the old metric invert.
  const quotedByBand = [
    { band: "55-59", segments: 1000, edgeCents: 4 },
    { band: "85-89", segments: 1000, edgeCents: -2 },
  ];
  const filledBands = [
    { band: "55-59", avgPnl: 4, graded: 900 },   // fills pile into the cheap band...
    { band: "85-89", avgPnl: -2, graded: 100 },  // ...but per-band edges are IDENTICAL to quoted
  ];
  const got = adverseSelectionWithinBand({ quotedByBand, filledBands, filledEdgeRawCents: 3.4 });
  assert.equal(got.quotedEdgeCents, 1);              // (4 - 2) / 2
  assert.equal(got.filledEdgeMixAdjustedCents, 1);   // reweighted onto quoted distribution
  assert.equal(got.gapCents, 0, "no gap once mix is removed");
  assert.equal(got.filledEdgeRawCents, 3.4, "raw headline carried through for contrast");
});

test("adverseSelectionWithinBand: genuine within-band selection survives the adjustment", () => {
  const got = adverseSelectionWithinBand({
    quotedByBand: [{ band: "55-59", segments: 1000, edgeCents: 4 }, { band: "85-89", segments: 1000, edgeCents: 0 }],
    filledBands: [{ band: "55-59", avgPnl: 1, graded: 500 }, { band: "85-89", avgPnl: -3, graded: 500 }],
  });
  assert.equal(got.quotedEdgeCents, 2);
  assert.equal(got.filledEdgeMixAdjustedCents, -1);
  assert.equal(got.gapCents, 3, "fills give up 3c/contract at equal prices");
  assert.deepEqual(got.byBand.map(b => b.gapCents), [3, 3]);
});

test("adverseSelectionWithinBand: bands missing on either side are excluded from the headline", () => {
  const got = adverseSelectionWithinBand({
    quotedByBand: [
      { band: "55-59", segments: 1000, edgeCents: 4 },
      { band: "90-96", segments: 9000, edgeCents: -50 }, // quoted only — never filled
    ],
    filledBands: [
      { band: "55-59", avgPnl: 1, graded: 500 },
      { band: "60-64", avgPnl: 99, graded: 500 },        // filled only — never quoted
    ],
  });
  // Only 55-59 is comparable; the huge quoted-only band must not drag the headline.
  assert.equal(got.quotedEdgeCents, 4);
  assert.equal(got.filledEdgeMixAdjustedCents, 1);
  assert.equal(got.gapCents, 3);
  assert.equal(got.byBand.find(b => b.band === "90-96").gapCents, null);
  assert.equal(got.byBand.find(b => b.band === "90-96").filledEdgeCents, null);
});

test("adverseSelectionWithinBand: an ungraded band (graded=0) is treated as absent", () => {
  const got = adverseSelectionWithinBand({
    quotedByBand: [{ band: "55-59", segments: 100, edgeCents: 4 }],
    filledBands: [{ band: "55-59", avgPnl: 12, graded: 0 }],
  });
  assert.equal(got.gapCents, null, "no graded fills means nothing to compare");
  assert.equal(got.byBand[0].filledEdgeCents, null);
});

test("adverseSelectionWithinBand: null-safe on empty input", () => {
  const got = adverseSelectionWithinBand({});
  assert.equal(got.quotedEdgeCents, null);
  assert.equal(got.gapCents, null);
  assert.deepEqual(got.byBand, []);
});

test("the two compose to reproduce the live 2026-07-26 production numbers", () => {
  // Real band ladder off /api/shadow-report. Guards the whole pipeline against a silent regression
  // in either function: quoted +1.53c, filled mix-adjusted +1.01c, gap +0.51c, 5 of 8 bands negative.
  // RESOLVED segments off quotedOutcomes.byBand — deliberately NOT the bands-query `segments`
  // (86,865), which include tickers Kalshi hasn't settled yet. Weighting by the wrong one shifts
  // the headline by 0.01c, which is exactly the kind of quiet drift this test exists to catch.
  const segs = { "55-59":13427, "60-64":11202, "65-69":9036, "70-74":8914,
                 "75-79":10909, "80-84":9756, "85-89":10297, "90-96":8290 };
  const quotedEdge = { "55-59":3.05, "60-64":1.51, "65-69":-4.98, "70-74":-0.56,
                       "75-79":7.05, "80-84":1.57, "85-89":-0.28, "90-96":3.34 };
  const filled = { "55-59":4.34, "60-64":3.76, "65-69":-6.07, "70-74":2.06,
                   "75-79":-1.56, "80-84":3.44, "85-89":-0.32, "90-96":0.68 };

  const got = adverseSelectionWithinBand({
    quotedByBand: Object.keys(segs).map(b => ({ band: b, segments: segs[b], edgeCents: quotedEdge[b] })),
    filledBands: Object.keys(filled).map(b => ({ band: b, avgPnl: filled[b], graded: 100 })),
    filledEdgeRawCents: 1.38,
  });

  assert.equal(got.quotedEdgeCents, 1.53);
  assert.equal(got.filledEdgeMixAdjustedCents, 1.01);
  assert.equal(got.gapCents, 0.51);
  assert.equal(got.byBand.filter(b => b.gapCents < 0).length, 4, "4 of 8 bands: fills BETTER than quotes");
  assert.equal(got.byBand.find(b => b.band === "75-79").gapCents, 8.61, "the one band carrying the aggregate");
});

// ── Ladder-calibrated anomaly detection (2026-08-11) ──────────────────────────────────────────
// The flag this replaces asked whether a cell's outcome was pinned against its own PRICE. That is
// the null the band-ladder artifact falsifies, so it fired on the ends of steep ladders and could
// not see an INVERTED cell at all — the actual wrong-side-fill signature. These tests pin both
// halves of the fix: real ladder ends must go quiet, and a real inversion must fire.
// See docs/MAKER_LADDER_ARTIFACT.md.

// Build a cell whose per-day rows reproduce a target sideWon with no day-to-day variance unless asked.
const ladderCell = (band, mid, sideWon, { fills = 60, days = 6, spread = 0 } = {}) => ({
  band, mid, fills, contracts: fills * 7,
  sideWon,
  byDay: Array.from({ length: days }, (_, i) => {
    const c = (fills * 7) / days;
    const rate = Math.min(1, Math.max(0, sideWon + (i % 2 ? spread : -spread)));
    return { contracts: c, won: c * rate };
  }),
});

test("isotonicFit: pools adjacent violators into a weighted mean, leaves monotone input alone", () => {
  assert.deepEqual(isotonicFit([{ y: 1, w: 1 }, { y: 2, w: 1 }, { y: 3, w: 1 }]), [1, 2, 3]);
  // 3 then 1 violates; both pool to their weighted mean 2.
  assert.deepEqual(isotonicFit([{ y: 3, w: 1 }, { y: 1, w: 1 }]), [2, 2]);
  // Weights matter: a heavy low point drags the pooled level toward itself.
  const [a] = isotonicFit([{ y: 10, w: 1 }, { y: 0, w: 9 }]);
  assert.equal(a, 1, "(1*10 + 9*0) / 10");
  assert.deepEqual(isotonicFit([]), []);
});

test("a real steep ladder END is NOT anomalous (the 6/6 false positives this replaces)", () => {
  // wnba|totalPoints as it actually stood on 2026-08-11: sideWon 0 at 15-19 is the smooth
  // continuation of 0 at 10-14 and 0.041 at 20-24, and sideWon 1 at 80-84 continues 0.935/0.928.
  const cells = [
    ladderCell("10-14", 12, 0), ladderCell("15-19", 17, 0), ladderCell("20-24", 22, 0.041),
    ladderCell("25-29", 27, 0.038), ladderCell("30-34", 32, 0.105), ladderCell("35-39", 37, 0.229),
    ladderCell("55-59", 57, 0.697), ladderCell("70-74", 72, 0.935), ladderCell("75-79", 77, 0.928),
    ladderCell("80-84", 82, 1),
  ];
  const r = ladderAnomalies(cells);
  assert.equal(r.get("15-19").anomaly, false, "bottom rung at sideWon 0 — extreme, but in ladder order");
  assert.equal(r.get("80-84").anomaly, false, "top rung at sideWon 1 — same");
  assert.equal([...r.values()].filter(v => v.anomaly).length, 0, "a clean ladder flags nothing");
});

test("an INVERTED cell fires — the wrong-side-fill signature the old test could not see", () => {
  // Identical ladder, except 15-19 grades at 0.85 instead of ~0. sideWon is neither 0 nor 1, so the
  // old `sideWon === 0 || sideWon === 1` gate would never even evaluate it.
  const cells = [
    ladderCell("10-14", 12, 0), ladderCell("15-19", 17, 0.85), ladderCell("20-24", 22, 0.041),
    ladderCell("25-29", 27, 0.038), ladderCell("30-34", 32, 0.105), ladderCell("35-39", 37, 0.229),
    ladderCell("55-59", 57, 0.697), ladderCell("80-84", 82, 1),
  ];
  const r = ladderAnomalies(cells);
  assert.equal(r.get("15-19").anomaly, true);
  assert.match(r.get("15-19").anomalyReason, /out of ladder order/);
  assert.ok(r.get("15-19").residual > 0.5, "residual carries the size of the departure");
});

test("a wholesale category side-flip is caught at the LADDER level, not per cell", () => {
  // Every band inverted together: each cell still sits close to the (flattened) fit, so per-cell
  // residuals stay small. This is the likeliest real bug shape — one emit module keying the wrong side.
  const cells = [
    ladderCell("15-19", 17, 0.95), ladderCell("30-34", 32, 0.80),
    ladderCell("60-64", 62, 0.20), ladderCell("80-84", 82, 0.05),
  ];
  const r = ladderAnomalies(cells);
  assert.ok([...r.values()].every(v => v.anomaly === true), "the whole category is flagged");
  assert.match(r.get("15-19").anomalyReason, /ladder inverted/);
});

test("failure-closed: too sparse to calibrate flags nothing (never falls back to the price null)", () => {
  assert.equal([...ladderAnomalies([ladderCell("15-19", 17, 0), ladderCell("80-84", 82, 1)]).values()]
    .filter(v => v.anomaly).length, 0, "2 bands is not a ladder");
  // Thin cells cannot serve as references, so a ladder of them is still not calibratable.
  const thin = [ladderCell("10-14", 12, 0, { fills: 3 }), ladderCell("20-24", 22, 0.1, { fills: 4 }),
    ladderCell("30-34", 32, 0.3, { fills: 2 }), ladderCell("40-44", 42, 0.5, { fills: 3 }),
    ladderCell("50-54", 52, 0.9, { fills: 1 })];
  assert.equal([...ladderAnomalies(thin).values()].filter(v => v.anomaly).length, 0);
  for (const bad of [null, undefined, [], "x"]) assert.equal(ladderAnomalies(bad).size, 0);
});

test("a departure must be BOTH significant and materially large", () => {
  const cells = [
    ladderCell("10-14", 12, 0.10), ladderCell("20-24", 22, 0.20), ladderCell("30-34", 32, 0.30),
    ladderCell("40-44", 42, 0.40), ladderCell("50-54", 52, 0.50),
  ];
  // 0.34 where ~0.30 is fitted: zero day-variance makes it "significant", but it is below the
  // 0.15 practical floor, so it must not flag.
  const near = cells.map(c => c.band === "30-34" ? ladderCell("30-34", 32, 0.34) : c);
  assert.equal(ladderAnomalies(near).get("30-34").anomaly, false);
  // Same cell moved well clear of the floor does flag.
  const far = cells.map(c => c.band === "30-34" ? ladderCell("30-34", 32, 0.75) : c);
  assert.equal(ladderAnomalies(far).get("30-34").anomaly, true);
});

test("a cell below the fills/days bar is never tested (and never used as a reference)", () => {
  const cells = [
    ladderCell("10-14", 12, 0.10), ladderCell("20-24", 22, 0.20), ladderCell("30-34", 32, 0.30),
    ladderCell("40-44", 42, 0.40), ladderCell("50-54", 52, 0.50),
    ladderCell("60-64", 62, 0.02, { fills: 8 }),   // wildly out of order, but only 8 fills
    ladderCell("70-74", 72, 0.02, { days: 2 }),    // enough fills, too few days for an interval
  ];
  const r = ladderAnomalies(cells);
  assert.equal(r.get("60-64").anomaly, false, "under minFills — not tested");
  assert.equal(r.get("70-74").anomaly, false, "under minDays — no clustered interval");
  assert.equal(r.get("30-34").anomaly, false, "and neither one polluted the reference ladder");
});
