// node --test api/lib/maker-prereg.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PREREG_CELLS, evaluatePrereg } from "./maker-prereg.js";

// The registry mirrors committed docs/MAKER_*_PREREG.md files whose thresholds are FIXED before the
// forward window opens — moving one post-hoc voids the pre-registration. This structural contract
// stands whether the registry is empty or full, and re-enforces the shape the moment a cell is added:
// every live entry must carry the fields the report + PreregTracker render and a real committed
// PREREG doc. A NEW cell re-adds its own exact-value pin here (per the "new id + new doc" rule) —
// this test never needs editing to add one.
test("every PREREG_CELLS entry carries its render-critical + doc fields", () => {
  for (const spec of PREREG_CELLS) {
    for (const f of ["id", "sport", "category", "band", "doc", "label", "forwardStart", "checkpoint", "criteria"])
      assert.ok(spec[f] != null, `${spec.id || "entry"} missing ${f}`);
    assert.match(spec.doc, /^docs\/MAKER_.*_PREREG\.md$/, `${spec.id} doc must be a committed PREREG file`);
    for (const k of ["ciLoAbove", "meanFloorC", "positiveDayFrac", "sideWonBelow", "minDays", "minFills"])
      assert.equal(typeof spec.criteria[k], "number", `${spec.id} criteria.${k} must be a number`);
  }
});

// KILLED cells must stay killed. The KILL rule is "a failed forward test is the answer" — the cell is
// not re-sliced, not widened, not given another two weeks, and a new test on the same market is a NEW
// id + a NEW doc. Re-adding one of these ids would silently resurrect a pre-registration whose bar was
// already failed on real forward data, which is precisely the re-opening the doctrine forbids.
// `f5total-5054` killed 2026-08-03 (day 3/8, mechanism inverted); `hrr-7074` killed 2026-08-11
// (day 6/8, sideWon 0.801 vs the < 0.60 bar — mechanism inverted the same way).
test("killed cells are never re-added to PREREG_CELLS", () => {
  for (const dead of ["f5total-5054", "hrr-7074"]) {
    assert.equal(PREREG_CELLS.find((s) => s.id === dead), undefined,
      `${dead} was KILLED on forward data — a new test is a new id + a new doc, never a re-open`);
  }
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

// Exact-value pin for totalruns-1519 (the "new id + new doc re-adds its own pin" rule). Fixed by
// docs/MAKER_TOTALRUNS_PREREG.md before the 2026-08-10 forward window — a diff here is a tripwire.
test("totalruns-1519 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "totalruns-1519");
  assert.ok(spec, "totalruns-1519 must be present");
  assert.equal(spec.doc, "docs/MAKER_TOTALRUNS_PREREG.md");
  assert.equal(spec.sport, "mlb");
  assert.equal(spec.category, "totalRuns");
  assert.equal(spec.band, "15-19");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-23");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.13, minDays: 8, minFills: 50,
  });
});

// Exact-value pins for wnbatp-2024/2529/3034 (the "new id + new doc re-adds its own pin" rule).
// Fixed by docs/MAKER_WNBA_TP_PREREG.md before the 2026-08-10 forward window — a diff here is a tripwire.
test("wnbatp-2024 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "wnbatp-2024");
  assert.ok(spec, "wnbatp-2024 must be present");
  assert.equal(spec.doc, "docs/MAKER_WNBA_TP_PREREG.md");
  assert.equal(spec.sport, "wnba");
  assert.equal(spec.category, "totalPoints");
  assert.equal(spec.band, "20-24");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.15, minDays: 8, minFills: 50,
  });
});

test("wnbatp-2529 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "wnbatp-2529");
  assert.ok(spec, "wnbatp-2529 must be present");
  assert.equal(spec.doc, "docs/MAKER_WNBA_TP_PREREG.md");
  assert.equal(spec.sport, "wnba");
  assert.equal(spec.category, "totalPoints");
  assert.equal(spec.band, "25-29");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.15, minDays: 8, minFills: 50,
  });
});

test("wnbatp-3034 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "wnbatp-3034");
  assert.ok(spec, "wnbatp-3034 must be present");
  assert.equal(spec.doc, "docs/MAKER_WNBA_TP_PREREG.md");
  assert.equal(spec.sport, "wnba");
  assert.equal(spec.category, "totalPoints");
  assert.equal(spec.band, "30-34");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.22, minDays: 8, minFills: 50,
  });
});

// Exact-value pins for wnbasp-1014/1519/2024 (the "new id + new doc re-adds its own pin" rule).
// Fixed by docs/MAKER_WNBA_SP_PREREG.md before the 2026-08-10 forward window — a diff here is a tripwire.
test("wnbasp-1014 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "wnbasp-1014");
  assert.ok(spec, "wnbasp-1014 must be present");
  assert.equal(spec.doc, "docs/MAKER_WNBA_SP_PREREG.md");
  assert.equal(spec.sport, "wnba");
  assert.equal(spec.category, "spread");
  assert.equal(spec.band, "10-14");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.08, minDays: 8, minFills: 50,
  });
});

test("wnbasp-1519 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "wnbasp-1519");
  assert.ok(spec, "wnbasp-1519 must be present");
  assert.equal(spec.doc, "docs/MAKER_WNBA_SP_PREREG.md");
  assert.equal(spec.sport, "wnba");
  assert.equal(spec.category, "spread");
  assert.equal(spec.band, "15-19");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.12, minDays: 8, minFills: 50,
  });
});

test("wnbasp-2024 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "wnbasp-2024");
  assert.ok(spec, "wnbasp-2024 must be present");
  assert.equal(spec.doc, "docs/MAKER_WNBA_SP_PREREG.md");
  assert.equal(spec.sport, "wnba");
  assert.equal(spec.category, "spread");
  assert.equal(spec.band, "20-24");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.12, minDays: 8, minFills: 50,
  });
});

// Exact-value pins for mlbsp-2529/3539 (the "new id + new doc re-adds its own pin" rule).
// Fixed by docs/MAKER_MLB_SP_PREREG.md before the 2026-08-10 forward window — a diff here is a tripwire.
test("mlbsp-2529 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "mlbsp-2529");
  assert.ok(spec, "mlbsp-2529 must be present");
  assert.equal(spec.doc, "docs/MAKER_MLB_SP_PREREG.md");
  assert.equal(spec.sport, "mlb");
  assert.equal(spec.category, "spread");
  assert.equal(spec.band, "25-29");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.22, minDays: 8, minFills: 50,
  });
});

test("mlbsp-3539 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "mlbsp-3539");
  assert.ok(spec, "mlbsp-3539 must be present");
  assert.equal(spec.doc, "docs/MAKER_MLB_SP_PREREG.md");
  assert.equal(spec.sport, "mlb");
  assert.equal(spec.category, "spread");
  assert.equal(spec.band, "35-39");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.30, minDays: 8, minFills: 50,
  });
});

// Exact-value pin for mlbf5t-2529 (the "new id + new doc re-adds its own pin" rule).
// Fixed by docs/MAKER_MLB_F5T_PREREG.md before the 2026-08-10 forward window — a diff here is a tripwire.
test("mlbf5t-2529 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "mlbf5t-2529");
  assert.ok(spec, "mlbf5t-2529 must be present");
  assert.equal(spec.doc, "docs/MAKER_MLB_F5T_PREREG.md");
  assert.equal(spec.sport, "mlb");
  assert.equal(spec.category, "f5total");
  assert.equal(spec.band, "25-29");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.22, minDays: 8, minFills: 50,
  });
});

// Exact-value pins for wnba3p-6064, wnbatp-1519, mlbf5sp-2529 (2026-08-10 tripwire registrations).
// Fixed by their respective docs/MAKER_*_PREREG.md before the 2026-08-10 forward window.
test("wnba3p-6064 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "wnba3p-6064");
  assert.ok(spec, "wnba3p-6064 must be present");
  assert.equal(spec.doc, "docs/MAKER_WNBA_3P_PREREG.md");
  assert.equal(spec.sport, "wnba");
  assert.equal(spec.category, "threePointers");
  assert.equal(spec.band, "60-64");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.40, minDays: 8, minFills: 50,
  });
});

test("wnbatp-1519 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "wnbatp-1519");
  assert.ok(spec, "wnbatp-1519 must be present");
  assert.equal(spec.doc, "docs/MAKER_WNBA_TP1519_PREREG.md");
  assert.equal(spec.sport, "wnba");
  assert.equal(spec.category, "totalPoints");
  assert.equal(spec.band, "15-19");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.05, minDays: 8, minFills: 50,
  });
});

test("mlbf5sp-2529 pins the pre-registered criteria fixed on 2026-08-10", () => {
  const spec = PREREG_CELLS.find((s) => s.id === "mlbf5sp-2529");
  assert.ok(spec, "mlbf5sp-2529 must be present");
  assert.equal(spec.doc, "docs/MAKER_MLB_F5SP_PREREG.md");
  assert.equal(spec.sport, "mlb");
  assert.equal(spec.category, "f5spread");
  assert.equal(spec.band, "25-29");
  assert.equal(spec.forwardStart, "2026-08-10");
  assert.equal(spec.checkpoint, "2026-08-24");
  assert.deepEqual(spec.criteria, {
    ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.22, minDays: 8, minFills: 50,
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
