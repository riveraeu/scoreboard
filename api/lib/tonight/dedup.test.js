// node --test api/lib/tonight/dedup.test.js
// Tests for alt-line dedup key semantics + keep/demote pass (api/lib/tonight/dedup.js).
// Pins the gotchas documented in CLAUDE.md "Spread alt-line dedup + category gate interaction".

import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupKey, dedupAltLines } from "./dedup.js";

const D = "2026-06-11";

test("dedupKey: ML plays are excluded (null key)", () => {
  assert.equal(dedupKey({ gameType: "ml", sport: "mlb", pickTeam: "NYY", oppTeam: "BOS", gameDate: D }), null);
});

test("dedupKey: plays with neither gameType nor player identity are excluded", () => {
  assert.equal(dedupKey({ sport: "mlb", gameDate: D }), null);
  assert.equal(dedupKey({ sport: "mlb", playerName: "Cole", gameDate: D }), null); // no stat
});

test("dedupKey: inning-segment (F3/F5/F7) and full-game segments never share a key", () => {
  const base = { gameType: "total", sport: "mlb", homeTeam: "NYY", awayTeam: "BOS", gameDate: D, direction: "over" };
  const full = dedupKey({ ...base });
  const f3 = dedupKey({ ...base, segment: "f3" });
  const f5 = dedupKey({ ...base, segment: "f5" });
  const f7 = dedupKey({ ...base, segment: "f7" });
  // Every segment is distinct from full-game and from each other.
  assert.equal(new Set([full, f3, f5, f7]).size, 4);
  // Absent segment defaults to "full" — explicit "full" must collide with absent.
  assert.equal(full, dedupKey({ ...base, segment: "full" }));
});

test("dedupKey: totals split by direction; teamTotals by scoring team + direction", () => {
  const gt = { gameType: "total", sport: "nba", homeTeam: "BOS", awayTeam: "NYK", gameDate: D };
  assert.notEqual(dedupKey({ ...gt, direction: "over" }), dedupKey({ ...gt, direction: "under" }));
  // direction defaults to 'over'
  assert.equal(dedupKey({ ...gt }), dedupKey({ ...gt, direction: "over" }));
  const tt = { gameType: "teamTotal", sport: "mlb", scoringTeam: "NYY", oppTeam: "BOS", gameDate: D, direction: "over" };
  assert.notEqual(dedupKey(tt), dedupKey({ ...tt, scoringTeam: "BOS", oppTeam: "NYY" }));
});

test("dedupKey: spread — both sides of the same line share a key", () => {
  const a = { gameType: "spread", sport: "wnba", pickTeam: "MIN", oppTeam: "LV", line: 3.5, gameDate: D };
  const b = { gameType: "spread", sport: "wnba", pickTeam: "LV", oppTeam: "MIN", line: 3.5, gameDate: D };
  assert.equal(dedupKey(a), dedupKey(b));
});

test("dedupKey: spread — different alt lines compete independently", () => {
  const a = { gameType: "spread", sport: "wnba", pickTeam: "MIN", oppTeam: "LV", line: 2.5, gameDate: D };
  const b = { gameType: "spread", sport: "wnba", pickTeam: "MIN", oppTeam: "LV", line: 3.5, gameDate: D };
  assert.notEqual(dedupKey(a), dedupKey(b));
});

test("dedupKey: player props group by player × stat across thresholds", () => {
  const p1 = { sport: "mlb", playerName: "Gerrit Cole", stat: "strikeouts", threshold: 6, gameDate: D };
  const p2 = { sport: "mlb", playerName: "Gerrit Cole", stat: "strikeouts", threshold: 7, gameDate: D };
  const p3 = { sport: "mlb", playerName: "Gerrit Cole", stat: "hits", threshold: 1, gameDate: D };
  assert.equal(dedupKey(p1), dedupKey(p2));
  assert.notEqual(dedupKey(p1), dedupKey(p3));
});

test("dedupKey: same matchup on different gameDates never collides (DH / next-day)", () => {
  const a = { gameType: "total", sport: "mlb", homeTeam: "BAL", awayTeam: "DET", gameDate: "2026-06-11", direction: "over" };
  const b = { ...a, gameDate: "2026-06-12" };
  assert.notEqual(dedupKey(a), dedupKey(b));
});

test("dedupAltLines: keeps highest-edge play per group, demotes the rest", () => {
  const mk = (threshold, edge) => ({ sport: "mlb", playerName: "Cole", stat: "strikeouts", threshold, edge, gameDate: D });
  const plays = [mk(6, 5), mk(7, 9), mk(8, 7)];
  const { kept, demoted } = dedupAltLines(plays);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].threshold, 7);
  assert.equal(demoted.length, 2);
  for (const d of demoted) {
    assert.equal(d._altLineDemoted, true);
    assert.equal(d.reason, "altLineDedup");
  }
  // Originals are not mutated — demotion copies.
  assert.equal(plays[0]._altLineDemoted, undefined);
});

test("dedupAltLines: null-key plays (ML) pass through untouched", () => {
  const ml = { gameType: "ml", sport: "nba", pickTeam: "BOS", oppTeam: "NYK", edge: 4, gameDate: D };
  const { kept, demoted } = dedupAltLines([ml, { ...ml, pickTeam: "NYK", oppTeam: "BOS" }]);
  assert.equal(kept.length, 2);
  assert.equal(demoted.length, 0);
});

test("dedupAltLines: spread both-sides — higher-edge side wins", () => {
  const minSide = { gameType: "spread", sport: "wnba", pickTeam: "MIN", oppTeam: "LV", line: 3.5, edge: 6, gameDate: D };
  const lvSide = { gameType: "spread", sport: "wnba", pickTeam: "LV", oppTeam: "MIN", line: 3.5, edge: 8, gameDate: D };
  const { kept, demoted } = dedupAltLines([minSide, lvSide]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].pickTeam, "LV");
  assert.equal(demoted[0].pickTeam, "MIN");
});

test("dedupAltLines: missing edge treated as 0", () => {
  const a = { sport: "mlb", playerName: "Cole", stat: "strikeouts", threshold: 6, gameDate: D }; // no edge
  const b = { sport: "mlb", playerName: "Cole", stat: "strikeouts", threshold: 7, edge: 1, gameDate: D };
  const { kept } = dedupAltLines([a, b]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].threshold, 7);
});
