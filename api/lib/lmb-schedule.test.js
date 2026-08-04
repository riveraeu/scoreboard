// Unit tests for LMB schedule parsing (model-free survivor of lmb.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLmbScheduleAny } from "./lmb-schedule.js";

// 434→BLE, 442→ODT are real LMB_ID_TO_ABBR entries (teams.js).
const _game = (homeId, awayId, gameTime) => ({
  teams: { home: { team: { id: homeId } }, away: { team: { id: awayId } } },
  gameDate: gameTime,
});

test("parseLmbScheduleAny keys by sorted pair, carries gameTime", () => {
  const out = parseLmbScheduleAny([_game(434, 442, "2026-07-15T23:00:00Z")], "2026-07-15");
  const key = ["BLE", "ODT"].sort().join("|");
  assert.equal(out[key].gameTime, "2026-07-15T23:00:00Z");
  assert.equal(out[key].home, "BLE");
  assert.equal(out[key].away, "ODT");
});

test("parseLmbScheduleAny skips non-LMB team ids (sportId 23 carries other leagues)", () => {
  const out = parseLmbScheduleAny([_game(99999, 442, "2026-07-15T23:00:00Z")], "2026-07-15");
  assert.equal(Object.keys(out).length, 0);
});

test("parseLmbScheduleAny doubleheader: first game's time stands", () => {
  const out = parseLmbScheduleAny([
    _game(434, 442, "2026-07-15T18:00:00Z"),
    _game(442, 434, "2026-07-15T23:00:00Z"),
  ], "2026-07-15");
  const key = ["BLE", "ODT"].sort().join("|");
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out[key].gameTime, "2026-07-15T18:00:00Z");
});
