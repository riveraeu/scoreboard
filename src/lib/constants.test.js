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
  // wnba|points PAUSED 2026-06-19 (mis-placed gate; see category-gate.js) — no band case while paused.
  { key: "wnba|rebounds", p: { sport: "wnba", stat: "rebounds" }, lo: 70, hi: 85 },
  // wnba|spread PAUSED 2026-06-19 (overconfident/losing; see category-gate.js) — no band case while paused.
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
  // No stat → gameType supplies the key. Use a live gate (wnba|rebounds) so a pass is observable.
  assert.equal(passesCategoryGate({ sport: "wnba", gameType: "rebounds", truePct: 75 }), true);
  // stat present wins over gameType: stat=assists (not gated) beats gameType=rebounds (gated) → fails.
  assert.equal(passesCategoryGate({ sport: "wnba", stat: "assists", gameType: "rebounds", truePct: 75 }), false);
  // and stat=rebounds (gated) wins over gameType=spread (paused) → passes.
  assert.equal(passesCategoryGate({ sport: "wnba", stat: "rebounds", gameType: "spread", truePct: 75 }), true);
});

test("passesCategoryGate: wnba|points and wnba|spread are PAUSED 2026-06-19 (fail everywhere)", () => {
  // Re-enable only after tune:gate confirms a coherent +ROI band at n≥50. Changing these assertions
  // should be a deliberate act that accompanies re-adding the gate line in category-gate.js.
  for (const tp of [72, 75, 78, 82, 90]) {
    assert.equal(passesCategoryGate({ sport: "wnba", stat: "points", truePct: tp }), false, `points ${tp} should fail while paused`);
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
