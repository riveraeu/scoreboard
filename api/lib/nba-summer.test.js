// node --test api/lib/nba-summer.test.js
// Tests for the Phase-1 NBA Summer League model (api/lib/nba-summer.js). Pins: the Elo win
// probability (symmetric, complementary, monotone in rating gap), the within-tournament Elo
// build (parity start, K-sized updates, chronological ordering), the parity-default lookup
// (no no_rating drop path), and ESPN event parsing (completed-only, ESPN→canonical abbrs,
// winner/loser derivation, sorted-pair stability for the resolver).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slWinProb, buildSlEloFrom, lookupSlElo, parseSlEvents, slCanonTeam,
  SL_ELO_BASE, SL_ELO_K,
} from "./nba-summer.js";

test("slWinProb: equal ratings → 50/50, complements sum to 1, monotone in gap", () => {
  assert.ok(Math.abs(slWinProb(1500, 1500) - 0.5) < 1e-9);
  const ab = slWinProb(1560, 1440), ba = slWinProb(1440, 1560);
  assert.ok(Math.abs(ab + ba - 1) < 1e-9, "binary market → complements sum to 1");
  assert.ok(ab > 0.5, "higher rating is favored");
  assert.ok(slWinProb(1700, 1300) > ab, "a bigger gap pushes higher");
});

test("buildSlEloFrom: parity start, winner gains K/2 on an even matchup, games counted", () => {
  const r = buildSlEloFrom([{ winner: "MEM", loser: "DAL" }]);
  assert.ok(Math.abs(r.MEM.rating - (SL_ELO_BASE + SL_ELO_K / 2)) < 0.11, "even-matchup win moves K·(1−0.5)");
  assert.ok(Math.abs(r.MEM.rating + r.DAL.rating - 2 * SL_ELO_BASE) < 0.21, "Elo is zero-sum");
  assert.equal(r.MEM.games, 1);
  assert.equal(r.DAL.games, 1);
});

test("buildSlEloFrom: a repeat win over the same team moves less (expected win rises)", () => {
  const r = buildSlEloFrom([
    { winner: "MEM", loser: "DAL" },
    { winner: "MEM", loser: "DAL" },
  ]);
  const firstGain = SL_ELO_K / 2;
  const secondGain = r.MEM.rating - SL_ELO_BASE - firstGain;
  assert.ok(secondGain > 0 && secondGain < firstGain, "diminishing gains as the favorite is expected to win");
});

test("lookupSlElo: unplayed teams default to the parity base (no no_rating drop path)", () => {
  const r = buildSlEloFrom([{ winner: "MEM", loser: "DAL" }]);
  assert.deepEqual(lookupSlElo(r, "POR"), { rating: SL_ELO_BASE, games: 0 });
  assert.deepEqual(lookupSlElo(null, "POR"), { rating: SL_ELO_BASE, games: 0 });
});

test("slCanonTeam: ESPN scoreboard abbrs map to canonical (NO→NOP), identity otherwise", () => {
  assert.equal(slCanonTeam("NO"), "NOP");
  assert.equal(slCanonTeam("MEM"), "MEM");
});

const _ev = (over) => ({
  date: "2026-07-11T20:00Z",
  competitions: [{
    status: { type: { completed: true } },
    competitors: [
      { homeAway: "home", team: { abbreviation: "ORL" }, score: "93" },
      { homeAway: "away", team: { abbreviation: "MIA" }, score: "88" },
    ],
    ...over,
  }],
});

test("parseSlEvents: derives winner/loser from a completed event, skips in-progress", () => {
  const done = parseSlEvents([_ev()]);
  assert.equal(done.length, 1);
  assert.equal(done[0].winner, "ORL");
  assert.equal(done[0].loser, "MIA");
  assert.equal(done[0].date, "2026-07-11"); // PT date of a 20:00Z start
  const live = parseSlEvents([_ev({ status: { type: { completed: false } } })]);
  assert.equal(live.length, 0, "in-progress games never grade");
});

test("parseSlEvents: canonicalizes ESPN abbrs so resolver pair keys match play rows", () => {
  const g = parseSlEvents([_ev({
    competitors: [
      { homeAway: "home", team: { abbreviation: "NO" }, score: "90" },
      { homeAway: "away", team: { abbreviation: "PHX" }, score: "85" },
    ],
  })])[0];
  assert.equal(g.home, "NOP");
  assert.equal([g.home, g.away].sort().join("|"), "NOP|PHX");
});
