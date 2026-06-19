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
  { key: "wnba|spread", p: { sport: "wnba", gameType: "spread" }, lo: 65, hi: 85 },
];

for (const { key, p, lo, hi } of cases) {
  test(`passesCategoryGate: ${key} band [${lo}, ${hi})`, () => {
    assert.equal(passesCategoryGate({ ...p, truePct: lo }), true, `${lo} should pass (inclusive lower)`);
    assert.equal(passesCategoryGate({ ...p, truePct: hi - 0.1 }), true, `${hi - 0.1} should pass`);
    assert.equal(passesCategoryGate({ ...p, truePct: lo - 0.1 }), false, `${lo - 0.1} should fail`);
    assert.equal(passesCategoryGate({ ...p, truePct: hi }), false, `${hi} should fail (exclusive upper)`);
  });
}

test("passesCategoryGate: key falls back to gameType when stat is absent", () => {
  // wnba|spread has no stat — gameType supplies the category key.
  assert.equal(passesCategoryGate({ sport: "wnba", gameType: "spread", truePct: 75 }), true);
  // A stat, when present, takes precedence over gameType: this resolves to wnba|points (PAUSED →
  // false), NOT wnba|spread (which would pass at 75). False here proves stat wins over gameType.
  assert.equal(passesCategoryGate({ sport: "wnba", stat: "points", gameType: "spread", truePct: 75 }), false);
  assert.equal(passesCategoryGate({ sport: "wnba", stat: "assists", gameType: "spread", truePct: 75 }), false);
});

test("passesCategoryGate: wnba|points is PAUSED 2026-06-19 (fails everywhere)", () => {
  // Mis-placed gate — re-enable only after tune:gate confirms the band at n≥50. Changing this
  // assertion should be a deliberate act that accompanies re-adding the gate line.
  for (const tp of [72, 75, 78, 82, 90]) {
    assert.equal(passesCategoryGate({ sport: "wnba", stat: "points", truePct: tp }), false, `points ${tp} should fail while paused`);
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
