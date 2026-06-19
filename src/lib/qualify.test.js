// node --test src/lib/qualify.test.js
// Tests for the shared client qualification core + pick identity (src/lib/qualify.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { qualifiesForDisplay, trackIdFor } from "./qualify.js";

// Discover a currently-gated (category, truePct) + an out-of-band truePct for the same category,
// so the positive-path assertions survive gate changes. The gate is EMPTY as of 2026-06-19 (all
// categories paused/demoted — see category-gate.js); when empty there's no observable PASS, so
// those assertions are skipped. They auto-restore once any category is re-gated.
import { passesCategoryGate } from "./constants.js";
function findGated() {
  const cands = [
    { sport: "mlb", stat: "strikeouts" }, { sport: "wnba", stat: "points" },
    { sport: "wnba", stat: "rebounds" }, { sport: "wnba", gameType: "spread" },
  ];
  for (const c of cands) {
    let inBand = null, outBand = null;
    for (let tp = 50; tp < 100; tp++) {
      if (passesCategoryGate({ ...c, truePct: tp })) { if (inBand == null) inBand = tp; }
      else if (outBand == null) outBand = tp;
    }
    if (inBand != null) return { ...c, truePct: inBand, outBand: outBand ?? 50 };
  }
  return null;
}
const gated = findGated();
const skipNoGate = gated ? false : "category gate is empty (2026-06-19) — no live category to pass";

// Negative paths don't need a live gate — always run.
test("qualifiesForDisplay: negative paths (dc, edge, unlisted category, empty gate)", () => {
  const p = { sport: "mlb", stat: "strikeouts", truePct: 82, dcQualified: true, edge: 6 };
  assert.equal(qualifiesForDisplay({ ...p, dcQualified: false }), false);
  assert.equal(qualifiesForDisplay({ ...p, dcQualified: undefined }), false);
  assert.equal(qualifiesForDisplay({ ...p, edge: 4.9 }), false);
  assert.equal(qualifiesForDisplay({ ...p, edge: undefined }), false);
  // Unlisted category fails even with dc + edge.
  assert.equal(qualifiesForDisplay({ ...p, sport: "nba", stat: "points" }), false);
});

test("qualifiesForDisplay: requires dcQualified, edge >= 5, and category gate", { skip: skipNoGate }, () => {
  const base = { ...gated, dcQualified: true, edge: 6 };
  assert.equal(qualifiesForDisplay({ ...base }), true);
  assert.equal(qualifiesForDisplay({ ...base, dcQualified: false }), false);
  assert.equal(qualifiesForDisplay({ ...base, edge: 4.9 }), false);
  assert.equal(qualifiesForDisplay({ ...base, edge: 5 }), true);
  // In-gate category but truePct outside its band fails.
  assert.equal(qualifiesForDisplay({ ...base, truePct: gated.outBand }), false);
});

test("qualifiesForDisplay: alt-line-demoted plays pass only via the category gate", { skip: skipNoGate }, () => {
  const base = { ...gated, dcQualified: true, edge: 6 };
  // Demoted + passes gate → falls through to dc/edge/gate and qualifies (the dedup winner
  // presumably failed the gate — see CLAUDE.md spread dedup × category gate interaction).
  assert.equal(qualifiesForDisplay({ ...base, _altLineDemoted: true }), true);
  // Demoted + fails gate → excluded immediately.
  assert.equal(qualifiesForDisplay({ ...base, _altLineDemoted: true, truePct: gated.outBand }), false);
  assert.equal(qualifiesForDisplay({ ...base, _altLineDemoted: true, sport: "nba", stat: "points" }), false);
});

test("trackIdFor: shape stability per play type", () => {
  const gd = "2026-06-11";
  assert.equal(
    trackIdFor({ gameType: "total", sport: "mlb", homeTeam: "NYY", awayTeam: "BOS", threshold: 8.5, gameDate: gd }),
    "total|mlb|NYY|BOS|8.5|2026-06-11"
  );
  assert.equal(
    trackIdFor({ gameType: "total", sport: "mlb", segment: "f5", homeTeam: "NYY", awayTeam: "BOS", threshold: 4.5, gameDate: gd, direction: "under" }),
    "total|mlb|f5|NYY|BOS|4.5|2026-06-11|under"
  );
  assert.equal(
    trackIdFor({ gameType: "teamTotal", sport: "mlb", scoringTeam: "NYY", oppTeam: "BOS", threshold: 4.5, gameDate: gd }),
    "teamtotal|mlb|NYY|BOS|4.5|2026-06-11"
  );
  assert.equal(
    trackIdFor({ gameType: "ml", sport: "nba", pickTeam: "BOS", homeTeam: "BOS", awayTeam: "NYK", gameDate: gd }),
    "ml|nba|BOS|BOS|NYK|2026-06-11"
  );
  assert.equal(
    trackIdFor({ gameType: "spread", sport: "wnba", pickTeam: "MIN", homeTeam: "LV", awayTeam: "MIN", pickLine: 3.5, gameDate: gd }),
    "spread|wnba|MIN|LV|MIN|3.5|2026-06-11"
  );
  // Player prop (no gameType); sport defaults to nba; segment "full" adds no qualifier.
  assert.equal(
    trackIdFor({ playerName: "Gerrit Cole", sport: "mlb", stat: "strikeouts", threshold: 6, gameDate: gd, segment: "full" }),
    "mlb|Gerrit Cole|strikeouts|6|2026-06-11"
  );
  assert.equal(
    trackIdFor({ playerName: "X", stat: "points", threshold: 20 }),
    "nba|X|points|20|"
  );
});
