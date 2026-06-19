// node --test src/lib/constants.test.js
// Tests for passesCategoryGate — the shadow-calibration UI gate. Band edges here mirror
// the gate table in CLAUDE.md ("Category gate"); when a band is promoted/retuned, update
// BOTH passesCategoryGate and these boundary cases in the same commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { passesCategoryGate } from "./constants.js";

// The gate is EMPTY as of 2026-06-19 — all four formerly-live categories were paused/demoted after
// formula-clean validation (mlb|strikeouts demoted, wnba|points/rebounds/spread paused; see
// category-gate.js + memory project-live-gate-validation-2026-06-19). So there is currently no
// observable PASS. When a category re-earns the gate via tune:gate, re-add its band-boundary case
// here (lo inclusive / hi exclusive) in the SAME commit that re-adds the gate line.
const cases = [
  // { key: "mlb|strikeouts", p: { sport: "mlb", stat: "strikeouts" }, lo: 80, hi: 85 },
];

for (const { key, p, lo, hi } of cases) {
  test(`passesCategoryGate: ${key} band [${lo}, ${hi})`, () => {
    assert.equal(passesCategoryGate({ ...p, truePct: lo }), true, `${lo} should pass (inclusive lower)`);
    assert.equal(passesCategoryGate({ ...p, truePct: hi - 0.1 }), true, `${hi - 0.1} should pass`);
    assert.equal(passesCategoryGate({ ...p, truePct: lo - 0.1 }), false, `${lo - 0.1} should fail`);
    assert.equal(passesCategoryGate({ ...p, truePct: hi }), false, `${hi} should fail (exclusive upper)`);
  });
}

test("passesCategoryGate: stat||gameType key resolution (gameType is the fallback when stat absent)", () => {
  // With the gate empty there is no observable PASS, but key resolution is still verifiable: stat and
  // gameType build the SAME key, so both resolve to the same (paused) entry → identical result.
  // Re-add a precedence-PASS case (stat wins over gameType) when a gate returns.
  assert.equal(
    passesCategoryGate({ sport: "mlb", stat: "strikeouts", truePct: 82 }),
    passesCategoryGate({ sport: "mlb", gameType: "strikeouts", truePct: 82 }),
  );
});

test("passesCategoryGate: gate is EMPTY 2026-06-19 (every former category fails everywhere)", () => {
  // mlb|strikeouts demoted; wnba|points/rebounds/spread paused. Re-enable a category only after
  // tune:gate confirms a coherent +ROI band at n≥50 + non-negative Brier — changing these assertions
  // must accompany re-adding the gate line in category-gate.js.
  const former = [
    { sport: "mlb", stat: "strikeouts" },
    { sport: "wnba", stat: "points" },
    { sport: "wnba", stat: "rebounds" },
    { sport: "wnba", gameType: "spread" },
  ];
  for (const p of former) {
    for (const tp of [62, 72, 75, 78, 82, 90]) {
      assert.equal(passesCategoryGate({ ...p, truePct: tp }), false,
        `${p.sport}|${p.stat || p.gameType} ${tp} should fail (gate empty)`);
    }
  }
});

test("passesCategoryGate: unlisted categories always fail", () => {
  assert.equal(passesCategoryGate({ sport: "nba", stat: "points", truePct: 75 }), false);
  assert.equal(passesCategoryGate({ sport: "mlb", gameType: "total", truePct: 85 }), false);
  assert.equal(passesCategoryGate({ sport: "mlb", stat: "hrr", truePct: 85 }), false);
});

test("passesCategoryGate: missing truePct treated as 0 (fails)", () => {
  assert.equal(passesCategoryGate({ sport: "mlb", stat: "strikeouts" }), false);
});
