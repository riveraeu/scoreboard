// node --test src/lib/qualify.test.js
// Tests for the shared client qualification core + pick identity (src/lib/qualify.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { qualifiesForDisplay, trackIdFor } from "./qualify.js";

// A play that passes everything: in-gate category (mlb|strikeouts 80–90), dc, edge.
const base = { sport: "mlb", stat: "strikeouts", truePct: 85, dcQualified: true, edge: 6 };

test("qualifiesForDisplay: requires dcQualified, edge >= 5, and category gate", () => {
  assert.equal(qualifiesForDisplay({ ...base }), true);
  assert.equal(qualifiesForDisplay({ ...base, dcQualified: false }), false);
  assert.equal(qualifiesForDisplay({ ...base, dcQualified: undefined }), false);
  assert.equal(qualifiesForDisplay({ ...base, edge: 4.9 }), false);
  assert.equal(qualifiesForDisplay({ ...base, edge: 5 }), true);
  assert.equal(qualifiesForDisplay({ ...base, edge: undefined }), false);
  // Out-of-gate category (nba|points is unlisted) fails even with dc + edge.
  assert.equal(qualifiesForDisplay({ ...base, sport: "nba", stat: "points" }), false);
  // In-gate category but truePct outside its band fails.
  assert.equal(qualifiesForDisplay({ ...base, truePct: 95 }), false);
});

test("qualifiesForDisplay: alt-line-demoted plays pass only via the category gate", () => {
  // Demoted + passes gate → falls through to dc/edge/gate and qualifies (the dedup winner
  // presumably failed the gate — see CLAUDE.md spread dedup × category gate interaction).
  assert.equal(qualifiesForDisplay({ ...base, _altLineDemoted: true }), true);
  // Demoted + fails gate → excluded immediately.
  assert.equal(qualifiesForDisplay({ ...base, _altLineDemoted: true, truePct: 95 }), false);
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
