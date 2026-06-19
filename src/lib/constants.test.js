// node --test src/lib/constants.test.js
// Tests for passesCategoryGate — the shadow-calibration UI gate. Band edges here mirror
// the gate table in CLAUDE.md ("Category gate"); when a band is promoted/retuned, update
// BOTH passesCategoryGate and these boundary cases in the same commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { passesCategoryGate } from "./constants.js";

const cases = [
  // [sport, statOrGameType-as-stat?, lo, hi]  — bands are [lo, hi)
  { key: "mlb|strikeouts", p: { sport: "mlb", stat: "strikeouts" }, lo: 80, hi: 85 }, // capped 90→85 2026-06-17
  // PAUSED 2026-06-19 (see category-gate.js): wnba|points (mis-placed), wnba|rebounds (mis-placed/weak),
  // wnba|spread (overconfident/losing) — no band cases while paused. mlb|strikeouts is the only live gate.
];

for (const { key, p, lo, hi } of cases) {
  test(`passesCategoryGate: ${key} band [${lo}, ${hi})`, () => {
    assert.equal(passesCategoryGate({ ...p, truePct: lo }), true, `${lo} should pass (inclusive lower)`);
    assert.equal(passesCategoryGate({ ...p, truePct: hi - 0.1 }), true, `${hi - 0.1} should pass`);
    assert.equal(passesCategoryGate({ ...p, truePct: lo - 0.1 }), false, `${lo - 0.1} should fail`);
    assert.equal(passesCategoryGate({ ...p, truePct: hi }), false, `${hi} should fail (exclusive upper)`);
  });
}

test("passesCategoryGate: stat takes precedence over gameType; gameType is the fallback", () => {
  // No stat → gameType supplies the key. mlb|strikeouts is the only live gate, so use it.
  assert.equal(passesCategoryGate({ sport: "mlb", gameType: "strikeouts", truePct: 82 }), true);
  // stat present wins over gameType: stat=hits (not gated) beats gameType=strikeouts (gated) → fails.
  assert.equal(passesCategoryGate({ sport: "mlb", stat: "hits", gameType: "strikeouts", truePct: 82 }), false);
  // and stat=strikeouts (gated) wins over gameType=spread → passes.
  assert.equal(passesCategoryGate({ sport: "mlb", stat: "strikeouts", gameType: "spread", truePct: 82 }), true);
});

test("passesCategoryGate: all wnba gates PAUSED 2026-06-19 (points/rebounds/spread fail everywhere)", () => {
  // Re-enable only after tune:gate confirms a coherent +ROI band at n≥50. Changing these assertions
  // should be a deliberate act that accompanies re-adding the gate line in category-gate.js.
  for (const tp of [72, 75, 78, 82, 90]) {
    assert.equal(passesCategoryGate({ sport: "wnba", stat: "points", truePct: tp }), false, `points ${tp} should fail while paused`);
    assert.equal(passesCategoryGate({ sport: "wnba", stat: "rebounds", truePct: tp }), false, `rebounds ${tp} should fail while paused`);
    assert.equal(passesCategoryGate({ sport: "wnba", gameType: "spread", truePct: tp }), false, `spread ${tp} should fail while paused`);
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
