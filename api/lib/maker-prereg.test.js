// node --test api/lib/maker-prereg.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PREREG_CELLS, evaluatePrereg } from "./maker-prereg.js";

// The registry mirrors committed docs/MAKER_*_PREREG.md files whose thresholds are FIXED before the
// forward window opens — moving one post-hoc voids the pre-registration. It is currently EMPTY
// (f5total-5054 killed 2026-08-03). This structural contract stands whether the registry is empty or
// not, and re-enforces the shape the moment a cell is added: every live entry must carry the fields
// the report + PreregTracker render and a real committed PREREG doc. A NEW cell re-adds its own
// exact-value pin here (per the "new id + new doc" rule) — this test never needs editing to add one.
test("every PREREG_CELLS entry carries its render-critical + doc fields", () => {
  for (const spec of PREREG_CELLS) {
    for (const f of ["id", "sport", "category", "band", "doc", "label", "forwardStart", "checkpoint", "criteria"])
      assert.ok(spec[f] != null, `${spec.id || "entry"} missing ${f}`);
    assert.match(spec.doc, /^docs\/MAKER_.*_PREREG\.md$/, `${spec.id} doc must be a committed PREREG file`);
    for (const k of ["ciLoAbove", "meanFloorC", "positiveDayFrac", "sideWonBelow", "minDays", "minFills"])
      assert.equal(typeof spec.criteria[k], "number", `${spec.id} criteria.${k} must be a number`);
  }
});

// Exact-value pin for the live cell (the "new id + new doc re-adds its own pin" rule). These numbers
// are FIXED by docs/MAKER_HRR_PREREG.md before its 2026-08-05 forward window opened — moving any of
// them post-hoc voids the pre-registration, so a diff here is a tripwire, not a routine edit.
test("hrr-7074 pins the pre-registered criteria fixed on 2026-08-05", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "hrr-7074");
  assert.ok(spec, "hrr-7074 must be present");
  assert.equal(spec.doc, "docs/MAKER_HRR_PREREG.md");
  assert.equal(spec.sport, "mlb");
  assert.equal(spec.category, "hrr");
  assert.equal(spec.band, "70-74");
  assert.equal(spec.forwardStart, "2026-08-05");
  assert.equal(spec.checkpoint, "2026-08-19");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.60, minDays: 8, minFills: 50,
  });
});

// Exact-value pin for ks-1519 (the "new id + new doc re-adds its own pin" rule). Fixed by
// docs/MAKER_KS_PREREG.md before the 2026-08-06 forward window — a diff here is a tripwire.
test("ks-1519 pins the pre-registered criteria fixed on 2026-08-06", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "ks-1519");
  assert.ok(spec, "ks-1519 must be present");
  assert.equal(spec.doc, "docs/MAKER_KS_PREREG.md");
  assert.equal(spec.sport, "mlb");
  assert.equal(spec.category, "strikeouts");
  assert.equal(spec.band, "15-19");
  assert.equal(spec.forwardStart, "2026-08-06");
  assert.equal(spec.checkpoint, "2026-08-20");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.14, minDays: 8, minFills: 50,
  });
});

// evaluatePrereg is pure; exercise it against a synthetic spec so these tests stand independent of
// what is (or isn't) in PREREG_CELLS. checkpoint mirrors the killed f5total cell's so the dated
// PASS/KILL cases below read naturally.
const SPEC = {
  id: "synthetic", checkpoint: "2026-08-13",
  criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.45, minDays: 8, minFills: 50 },
};

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
