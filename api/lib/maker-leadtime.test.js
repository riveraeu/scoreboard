import { test } from "node:test";
import assert from "node:assert";
import { leadTimeBuckets, spearmanEdgeVsLead, mixAdjustedNearFarByDay, dayLevelDiffCI, leadTimeVerdict, LEAD_BUCKETS } from "/Users/erivera/scoreboard/api/lib/maker-stats.js";

// contracts c at ask a with w winning contracts -> edge = a - 100*(w/c)
const row = (day, band, bucket, c, ask, wonC, fills = 1) =>
  ({ day, band, bucket, contracts: c, sum_ask_ctr: ask * c, sum_won_ctr: wonC, fills });

test("leadTimeBuckets computes seller edge as ask - 100*wonRate", () => {
  const b = leadTimeBuckets([row("d1", "80-84", "0-1h", 100, 80, 70)]);
  const near = b.find(x => x.bucket === "0-1h");
  assert.equal(near.avgAsk, 80);
  assert.equal(near.sideWonRate, 0.7);
  assert.equal(near.edgeCents, 10); // 80 - 70
});

test("leadTimeBuckets returns every bucket in lead order, empties included", () => {
  const b = leadTimeBuckets([row("d1", "80-84", "3-6h", 10, 75, 7)]);
  assert.deepEqual(b.map(x => x.bucket), LEAD_BUCKETS);
  assert.equal(b[0].edgeCents, null);
});

test("spearman is -1 for edge falling monotonically with lead time", () => {
  const buckets = [{ edgeCents: 10 }, { edgeCents: 8 }, { edgeCents: 5 }, { edgeCents: 2 }, { edgeCents: -3 }];
  assert.equal(spearmanEdgeVsLead(buckets), -1);
});

test("spearman is +1 when edge RISES with lead time (H1 backwards)", () => {
  const buckets = [{ edgeCents: -3 }, { edgeCents: 2 }, { edgeCents: 5 }, { edgeCents: 8 }, { edgeCents: 10 }];
  assert.equal(spearmanEdgeVsLead(buckets), 1);
});

test("mix adjustment neutralizes a pure price-mix confound", () => {
  // Within EVERY band, near and far have identical edge -> true difference is 0. But near is
  // concentrated in a rich band and far in a poor one, so an unadjusted comparison would show a
  // large fake gap. This is the exact Simpson's shape that has bitten this board three times.
  const rows = [
    row("d1", "90-96", "0-1h", 100, 92, 82),  // edge +10
    row("d1", "90-96", "6-12h", 10, 92, 8.2), // edge +10  (same)
    row("d1", "60-64", "0-1h", 10, 62, 6.7),  // edge -5
    row("d1", "60-64", "6-12h", 100, 62, 67), // edge -5   (same)
  ];
  const { days } = mixAdjustedNearFarByDay(rows);
  assert.equal(days.length, 1);
  assert.equal(days[0].diffCents, 0, "mix-adjusted difference must be exactly 0");
});

test("mix adjustment recovers a real within-band difference", () => {
  const rows = [
    row("d1", "80-84", "0-1h", 100, 82, 78),   // edge +4
    row("d1", "80-84", "6-12h", 100, 82, 84),  // edge -2  -> diff +6
  ];
  assert.equal(mixAdjustedNearFarByDay(rows).days[0].diffCents, 6);
});

test("a day contributes nothing unless a band has BOTH arms", () => {
  const rows = [
    row("d1", "80-84", "0-1h", 50, 82, 40),
    row("d2", "80-84", "0-1h", 50, 82, 40),
    row("d2", "80-84", "6-12h", 50, 82, 45),
  ];
  const { days } = mixAdjustedNearFarByDay(rows);
  assert.deepEqual(days.map(d => d.day), ["d2"]);
});

test("3-6h is a buffer: it enters neither arm", () => {
  const rows = [
    row("d1", "80-84", "3-6h", 999, 82, 500),
    row("d1", "80-84", "0-1h", 100, 82, 78),
    row("d1", "80-84", "6-12h", 100, 82, 84),
  ];
  assert.equal(mixAdjustedNearFarByDay(rows).days[0].diffCents, 6); // unchanged by the 3-6h row
});

test("dayLevelDiffCI collapses to the textbook sd/sqrt(m)", () => {
  const days = [{ diffCents: 2 }, { diffCents: 4 }, { diffCents: 6 }];
  const ci = dayLevelDiffCI(days);
  assert.equal(ci.mean, 4);
  assert.equal(ci.se, 1.15); // sd=2, se=2/sqrt(3)=1.1547
  assert.equal(ci.days, 3);
});

test("verdict requires ALL THREE criteria — no partial credit", () => {
  const days = Array.from({ length: 9 }, () => ({ diffCents: 1 }));
  const pass = { ci: { loCI: 0.5 }, days, spearman: -0.9 };
  assert.equal(leadTimeVerdict(pass).verdict, "H1 SUPPORTED");
  assert.equal(leadTimeVerdict({ ...pass, ci: { loCI: -0.1 } }).verdict, "H1 REJECTED");
  assert.equal(leadTimeVerdict({ ...pass, spearman: -0.2 }).verdict, "H1 REJECTED");
  const mixedSigns = [...Array(6).fill({ diffCents: 1 }), ...Array(3).fill({ diffCents: -1 })];
  assert.equal(leadTimeVerdict({ ...pass, days: mixedSigns }).verdict, "H1 REJECTED");
});

test("fewer than 6 usable days is INCONCLUSIVE, not a pass", () => {
  const days = Array.from({ length: 5 }, () => ({ diffCents: 1 }));
  assert.equal(leadTimeVerdict({ ci: { loCI: 0.5 }, days, spearman: -0.9 }).verdict, "INCONCLUSIVE");
});

// ── exitCounterfactual (2026-07-28) ──────────────────────────────────────────────────────────
import { exitCounterfactual } from "/Users/erivera/scoreboard/api/lib/maker-stats.js";

test("exit rule credits the THRESHOLD, never the peak excursion", () => {
  // You cannot see the max in advance: a take-profit rule fires the first time the mark hits +X.
  // Crediting the peak is the standard way this backtest lies to itself.
  const fills = [{ pnlCents: -100, contracts: 1, excursionCents: 40 }];
  const r = exitCounterfactual({ fills, thresholds: [5] });
  assert.equal(r.byThreshold[0].pnlPerContract, 5);
});

test("a fill whose path was never observed again is held, not exited", () => {
  const fills = [{ pnlCents: 70, contracts: 1, excursionCents: null }];
  const r = exitCounterfactual({ fills, thresholds: [1] });
  assert.equal(r.byThreshold[0].exitedFills, 0);
  assert.equal(r.byThreshold[0].pnlPerContract, 70);
});

test("exit only fires when the excursion reaches the threshold", () => {
  const fills = [
    { pnlCents: -100, contracts: 1, excursionCents: 2 },  // 2 < 5 -> held, settles at -100
    { pnlCents: 80, contracts: 1, excursionCents: 6 },    // 6 >= 5 -> exits at +5
  ];
  const r = exitCounterfactual({ fills, thresholds: [5] });
  assert.equal(r.byThreshold[0].exitedFills, 1);
  assert.equal(r.byThreshold[0].pnlPerContract, (-100 + 5) / 2);
});

test("everything is contract-weighted, not per-fill", () => {
  const fills = [
    { pnlCents: 0, contracts: 99, excursionCents: null },
    { pnlCents: 100, contracts: 1, excursionCents: null },
  ];
  const r = exitCounterfactual({ fills, thresholds: [1] });
  assert.equal(r.holdPnlPerContract, 1); // 100/100, not the 50 a per-fill mean would give
});

test("a martingale price path yields deltaVsHold ~ 0 -- the null this tests against", () => {
  // Symmetric fake book: half the positions drift favourably then settle to a win, half drift
  // against and settle to a loss. Take-profit should not manufacture edge out of that.
  const fills = [];
  for (let i = 0; i < 500; i++) {
    fills.push({ pnlCents: 74, contracts: 1, excursionCents: 8 });    // won, offered an exit
    fills.push({ pnlCents: -26, contracts: 1, excursionCents: -8 });  // lost, never in profit
  }
  const r = exitCounterfactual({ fills, thresholds: [8] });
  // Holding: (74-26)/2 = +24. Exiting the winners at +8 instead: (8-26)/2 = -9. Take-profit
  // CAPS the winners while leaving the losers untouched -- strictly worse on this shape.
  assert.equal(r.holdPnlPerContract, 24);
  assert.equal(r.byThreshold[0].pnlPerContract, -9);
  assert.ok(r.byThreshold[0].deltaVsHold < 0);
});
