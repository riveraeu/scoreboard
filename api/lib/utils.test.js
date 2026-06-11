// node --test api/lib/utils.test.js
// Tests for parseGameScores key shape — pins the "today + tomorrow merge" and doubleheader
// gotchas (CLAUDE.md "gameScores today + tomorrow merge"). NOTE: api/lib/mlb.js (~line 952)
// carries an inline duplicate of this key shape; if these tests force a key change, the
// mlb.js copy must change in lockstep.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGameScores } from "./utils.js";

function mkEvent({ home, away, date, state = "pre", homeScore = 0, awayScore = 0, seasonType = 2 }) {
  return {
    date,
    season: { type: seasonType },
    competitions: [{
      status: { type: { state, shortDetail: state === "post" ? "Final" : "7:00 PM" } },
      competitors: [
        { homeAway: "home", team: { abbreviation: home }, score: String(homeScore), records: [{ type: "total", summary: "40-25" }] },
        { homeAway: "away", team: { abbreviation: away }, score: String(awayScore), records: [{ name: "overall", summary: "30-35" }] },
      ],
    }],
  };
}

test("parseGameScores: key is homeTeam|ptGameDate|isoEventDate", () => {
  // 2026-06-12T02:00Z = 2026-06-11 7pm PT — gameDate must be the PT calendar day.
  const events = [mkEvent({ home: "BAL", away: "DET", date: "2026-06-12T02:00Z" })];
  const scores = parseGameScores(events);
  const keys = Object.keys(scores);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], "BAL|2026-06-11|2026-06-12T02:00Z");
  assert.equal(scores[keys[0]].gameDate, "2026-06-11");
});

test("parseGameScores: today's Final and tomorrow's game (same home team) get distinct keys", () => {
  // The midnight-UTC wipe gotcha: without gameDate in the key, tomorrow's "pre" entry
  // would overwrite today's "post" entry for the same home team.
  const events = [
    mkEvent({ home: "NYY", away: "BOS", date: "2026-06-11T23:00Z", state: "post", homeScore: 5, awayScore: 3 }),
    mkEvent({ home: "NYY", away: "BOS", date: "2026-06-12T23:00Z", state: "pre" }),
  ];
  const scores = parseGameScores(events);
  assert.equal(Object.keys(scores).length, 2);
  const final = scores["NYY|2026-06-11|2026-06-11T23:00Z"];
  assert.equal(final.state, "post");
  assert.equal(final.homeScore, 5);
  assert.equal(scores["NYY|2026-06-12|2026-06-12T23:00Z"].state, "pre");
});

test("parseGameScores: same-day doubleheader games get distinct keys via event.date", () => {
  const events = [
    mkEvent({ home: "BAL", away: "DET", date: "2026-06-11T17:05Z", state: "post", homeScore: 2, awayScore: 1 }),
    mkEvent({ home: "BAL", away: "DET", date: "2026-06-11T23:35Z", state: "pre" }),
  ];
  const scores = parseGameScores(events);
  assert.equal(Object.keys(scores).length, 2);
});

test("parseGameScores: normFn is applied to both team abbrs", () => {
  const norm = (a) => (a === "CHW" ? "CWS" : a);
  const events = [mkEvent({ home: "CHW", away: "DET", date: "2026-06-11T23:00Z" })];
  const scores = parseGameScores(events, norm);
  const entry = Object.values(scores)[0];
  assert.equal(entry.homeTeam, "CWS");
  assert.ok(Object.keys(scores)[0].startsWith("CWS|"));
});

test("parseGameScores: seasonType and records captured; malformed events skipped", () => {
  const good = mkEvent({ home: "NYY", away: "BOS", date: "2026-06-11T23:00Z", seasonType: 3 });
  const noComp = { date: "2026-06-11T23:00Z", competitions: [] };
  const oneSide = { date: "2026-06-11T23:00Z", competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "NYY" } }] }] };
  const scores = parseGameScores([good, noComp, oneSide]);
  assert.equal(Object.keys(scores).length, 1);
  const entry = Object.values(scores)[0];
  assert.equal(entry.seasonType, 3);
  assert.equal(entry.homeRecord, "40-25");
  assert.equal(entry.awayRecord, "30-35");
});

test("parseGameScores: empty/null input → empty map", () => {
  assert.deepEqual(parseGameScores([]), {});
  assert.deepEqual(parseGameScores(null), {});
});
