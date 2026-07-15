// node --test api/lib/lmb.test.js
// LMB Phase-1 pure logic: run-rate λ pair, schedule parsing (incl. the split-doubleheader
// guard), and the KXLMBGAME ticker shape through parseGameTeams (date + 4-digit time + 3+3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { lmbLambdas, parseLmbSchedule } from "./lmb.js";
import { parseGameTeams } from "./tonight/parse-teams.js";

const RATES = {
  TDT: { rsPg: 5.0, raPg: 3.465, games: 71 }, // Toros-ish
  DIA: { rsPg: 6.2, raPg: 4.8, games: 70 },
  TDQ: { rsPg: 4.4, raPg: 4.1, games: 69 },
};

test("lmbLambdas blends pick offense with opponent defense", () => {
  const lam = lmbLambdas(RATES, "DIA", "TDQ");
  assert.equal(lam.lamPick, (6.2 + 4.1) / 2);
  assert.equal(lam.lamOpp, (4.4 + 4.8) / 2);
});

test("lmbLambdas is failure-closed on a missing team", () => {
  assert.equal(lmbLambdas(RATES, "DIA", "XXX"), null);
  assert.equal(lmbLambdas(null, "DIA", "TDQ"), null);
});

const _game = (homeId, awayId, hs, as, detail = "Final", abstract = "Final") => ({
  status: { abstractGameState: abstract, detailedState: detail },
  teams: {
    home: { team: { id: homeId }, score: hs },
    away: { team: { id: awayId }, score: as },
  },
});

test("parseLmbSchedule keys finals by sorted pair and picks the winner", () => {
  // 532=DIA, 569=TDQ, 5010=TDT
  const out = parseLmbSchedule([_game(569, 532, 3, 7)], "2026-07-15");
  const g = out["DIA|TDQ"];
  assert.ok(g);
  assert.equal(g.winner, "DIA");
  assert.equal(g.home, "TDQ");
  assert.equal(g.homeScore, 3);
});

test("parseLmbSchedule skips non-final, non-LMB, and postponed games", () => {
  const out = parseLmbSchedule([
    _game(569, 532, 2, 1, "In Progress", "Live"),   // not final
    _game(569, 532, 0, 0, "Postponed", "Final"),    // terminal but not played
    _game(1885, 1892, 5, 4),                        // KC Monarchs vs Lincoln — sportId-23 non-LMB
  ], "2026-07-15");
  assert.deepEqual(out, {});
});

test("parseLmbSchedule doubleheader guard: split DH unresolvable, sweep resolves", () => {
  const split = parseLmbSchedule([
    _game(569, 532, 3, 7), // DIA wins G1
    _game(532, 569, 1, 4), // TDQ wins G2 — conflicting winners
  ], "2026-07-15");
  assert.equal(split["DIA|TDQ"], undefined);
  const sweep = parseLmbSchedule([
    _game(569, 532, 3, 7), // DIA wins G1
    _game(532, 569, 6, 2), // DIA wins G2
  ], "2026-07-15");
  assert.equal(sweep["DIA|TDQ"]?.winner, "DIA");
});

test("parseGameTeams handles the KXLMBGAME event segment (date + time + 3+3)", () => {
  assert.deepEqual(parseGameTeams("KXLMBGAME-26JUL152030DIATDQ", "lmb"), ["DIA", "TDQ"]);
  assert.deepEqual(parseGameTeams("KXLMBGAME-26JUL182145CALADM", "lmb"), ["CAL", "ADM"]);
  assert.deepEqual(parseGameTeams("KXLMBGAME-26JUL182100TDTDOR", "lmb"), ["TDT", "DOR"]);
});
