// node --test api/lib/nascar.test.js
// Tests for the Phase-1 NASCAR Cup model (api/lib/nascar.js). Pins: the H2H probability (sums to 1,
// symmetric for equal drivers, favors the lower-expected-finish driver, order-complement), the
// Top-10 probability (monotone in μ, continuity-corrected), name normalization, and the driver-
// index build from already-fetched finishing orders (avg-finish aggregation, min-races drop,
// last-name ambiguity).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pBeats, pTopN, normNascarName, aggregateFinishes, buildDriverIndexFrom, lookupDriver,
  NASCAR_FINISH_SIGMA, NASCAR_MIN_RACES,
} from "./nascar.js";

test("pBeats: equal drivers → 50/50, and P(A)+P(B)=1 (no tie band)", () => {
  assert.ok(Math.abs(pBeats(10, 10) - 0.5) < 1e-9, "equal expected finishes must be 50/50");
  const ab = pBeats(8, 14), ba = pBeats(14, 8);
  assert.ok(Math.abs(ab + ba - 1) < 1e-9, "no ties → complements sum to 1");
});

test("pBeats: the lower-expected-finish (better) driver is favored", () => {
  const p = pBeats(8, 14); // A finishes ~8th avg, B ~14th → A favored
  assert.ok(p > 0.5 && p < 0.8, `single-race edge should be modest, got ${p}`);
  assert.ok(pBeats(5, 25) > p, "a bigger gap pushes higher");
});

test("pTopN: monotone decreasing in expected finish, continuity-corrected at the boundary", () => {
  assert.ok(pTopN(5, 10) > pTopN(12, 10), "a better driver is likelier to finish top-10");
  // A driver whose expected finish is exactly the boundary +0.5 sits at 50%.
  assert.ok(Math.abs(pTopN(10.5, 10) - 0.5) < 1e-9, "μ = 10.5 → P(top10) = 0.5 (10.5 continuity)");
  assert.ok(pTopN(2, 10) > 0.8, "a front-runner clears the top-10 window comfortably");
});

test("sigma is a positive league-wide knob", () => {
  assert.ok(NASCAR_FINISH_SIGMA > 0);
});

test("aggregateFinishes collects per-driver finishing positions across races", () => {
  const agg = aggregateFinishes([
    [{ id: "1", order: 3 }, { id: "2", order: 8 }],
    [{ id: "1", order: 5 }, { id: "2", order: 1 }],
    [{ id: "1", order: 1 }],
  ]);
  assert.deepEqual(agg.get("1"), [3, 5, 1]);
  assert.deepEqual(agg.get("2"), [8, 1]);
});

test("buildDriverIndexFrom: avg finish, min-races drop, full + last-name lookup", () => {
  const agg = new Map([
    ["1", [2, 4, 6]],   // avg 4.0, 3 races → kept
    ["2", [10, 20]],    // 2 races < MIN_RACES → dropped
    ["3", [1, 1, 1, 1]],// avg 1.0
  ]);
  const idx = buildDriverIndexFrom(agg, { "1": "Denny Hamlin", "2": "Part Timer", "3": "Kyle Larson" });
  assert.equal(NASCAR_MIN_RACES, 3);
  assert.equal(lookupDriver(idx, "Denny Hamlin").avgFinish, 4.0);
  assert.equal(lookupDriver(idx, "hamlin").id, "1");            // last-name fallback
  assert.equal(lookupDriver(idx, "Part Timer"), null);          // under min races → unrated
  // Better avg finish → favored head-to-head.
  assert.ok(pBeats(lookupDriver(idx, "Kyle Larson").avgFinish, lookupDriver(idx, "Denny Hamlin").avgFinish) > 0.5);
});

test("buildDriverIndexFrom marks colliding last names AMBIG (forces full name)", () => {
  const agg = new Map([["1", [3, 3, 3]], ["2", [9, 9, 9]]]);
  const idx = buildDriverIndexFrom(agg, { "1": "Kyle Busch", "2": "Kurt Busch" });
  assert.equal(lookupDriver(idx, "Busch"), null);               // ambiguous → abstain
  assert.equal(lookupDriver(idx, "Kyle Busch").id, "1");        // full name resolves
});

test("normNascarName strips diacritics + punctuation", () => {
  assert.equal(normNascarName("Daniel Suárez"), "daniel suarez");
  assert.equal(normNascarName("A.J. Allmendinger"), "a j allmendinger");
});

// Resolution rule: H2H pick wins iff its finishing order is strictly lower (no ties — positions are
// unique); Top-10 wins iff order ≤ 10. Mirror the resolver comparisons.
test("resolution: H2H strictly-lower order wins; Top-10 is ≤ 10", () => {
  const beats = (pick, opp) => pick < opp;
  assert.equal(beats(3, 11), true);
  assert.equal(beats(11, 3), false);
  const top10 = (order) => order <= 10;
  assert.equal(top10(10), true);
  assert.equal(top10(11), false);
});
