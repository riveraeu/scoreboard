// node --test api/lib/maker-prereg.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PREREG_CELLS, evaluatePrereg } from "./maker-prereg.js";

// The registry mirrors committed docs/MAKER_*_PREREG.md files whose thresholds are FIXED before the
// forward window opens — moving one post-hoc voids the pre-registration. These assertions are the
// tripwire against a silent drift of exactly that kind. If a threshold legitimately changes, it's a
// NEW pre-registration (new doc, new id), not an edit here.
test("f5total-5054 pre-registration criteria are pinned to the committed doc", () => {
  const spec = PREREG_CELLS.find((c) => c.id === "f5total-5054");
  assert.ok(spec, "f5total-5054 must exist");
  assert.equal(spec.sport, "mlb");
  assert.equal(spec.category, "f5total");
  assert.equal(spec.band, "50-54");
  assert.equal(spec.forwardStart, "2026-07-30");
  assert.equal(spec.checkpoint, "2026-08-13");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60,
    sideWonBelow: 0.45, minDays: 8, minFills: 50,
  });
});

const SPEC = PREREG_CELLS.find((c) => c.id === "f5total-5054");

// A result that satisfies every GREEN criterion, used as the base for the negative cases below.
const PASSING = { days: 10, fills: 120, mean: 8, ciLo: 2, positiveDays: 7, sideWon: 0.40 };

test("below the sample floor → COLLECTING, regardless of how good the numbers look", () => {
  const r = evaluatePrereg(SPEC, { days: 3, fills: 20, mean: 20, ciLo: 10, positiveDays: 3, sideWon: 0.30 }, "2026-08-02");
  assert.equal(r.verdict, "COLLECTING");
  assert.equal(r.sampleMet, false);
  assert.equal(r.pastCheckpoint, false);
  // Every OTHER criterion passes — only the sample check fails.
  assert.equal(r.checks.find((c) => c.key === "sample").met, false);
  assert.equal(r.checks.filter((c) => c.met).length, 4);
});

test("sample met, all criteria met, before checkpoint → ON_TRACK (provisional, not PASS)", () => {
  const r = evaluatePrereg(SPEC, PASSING, "2026-08-05");
  assert.equal(r.allMet, true);
  assert.equal(r.sampleMet, true);
  assert.equal(r.pastCheckpoint, false);
  assert.equal(r.verdict, "ON_TRACK");
  assert.equal(r.metCount, 5);
});

test("sample met, a criterion failing, before checkpoint → FAILING", () => {
  // Mechanism absent: sold side wins 0.50 (>= 0.45 floor) even though PnL is positive.
  const r = evaluatePrereg(SPEC, { ...PASSING, sideWon: 0.50 }, "2026-08-05");
  assert.equal(r.allMet, false);
  assert.equal(r.verdict, "FAILING");
  assert.equal(r.checks.find((c) => c.key === "sideWon").met, false);
});

test("at/after checkpoint, all criteria met → PASS", () => {
  const r = evaluatePrereg(SPEC, PASSING, "2026-08-13");
  assert.equal(r.pastCheckpoint, true);
  assert.equal(r.verdict, "PASS");
});

test("at/after checkpoint, any criterion failing → KILL (even with the sample floor met)", () => {
  // Mean +3 sits below the +5 floor — positive but not worth capital. KILL, not a soft pass.
  const r = evaluatePrereg(SPEC, { ...PASSING, mean: 3 }, "2026-08-20");
  assert.equal(r.pastCheckpoint, true);
  assert.equal(r.allMet, false);
  assert.equal(r.verdict, "KILL");
  assert.equal(r.checks.find((c) => c.key === "mean").met, false);
});

test("CI-lo exactly 0 does NOT clear the bar (strict >)", () => {
  const r = evaluatePrereg(SPEC, { ...PASSING, ciLo: 0 }, "2026-08-05");
  assert.equal(r.checks.find((c) => c.key === "ciLo").met, false);
});

test("posDays uses the 60% fraction, not a raw count", () => {
  // 6/10 = 0.60 exactly → meets (>=). 5/10 → fails.
  assert.equal(evaluatePrereg(SPEC, { ...PASSING, days: 10, positiveDays: 6 }, "2026-08-05")
    .checks.find((c) => c.key === "posDays").met, true);
  assert.equal(evaluatePrereg(SPEC, { ...PASSING, days: 10, positiveDays: 5 }, "2026-08-05")
    .checks.find((c) => c.key === "posDays").met, false);
});

test("empty/null forward result is handled without throwing → COLLECTING", () => {
  const r = evaluatePrereg(SPEC, { days: 0, fills: 0, mean: null, ciLo: null, positiveDays: 0, sideWon: null }, "2026-08-01");
  assert.equal(r.verdict, "COLLECTING");
  assert.equal(r.metCount, 0);
});
