// node --test api/lib/soccer-modelfree.test.js
// Pins `nearestByPair`, the tie-break behind the widened gameTime lookup (2026-08-10).
//
// Why this exists: Kalshi's event-ticker date can sit -1 to +2 days off the fixture ESPN actually
// lists, so the schedule lookup searches a window instead of an exact date. That trades one silent
// failure (gameTime:null → row never maker-quotable) for a worse one if the tie-break is wrong —
// attaching a row to the WRONG fixture's kickoff. These cases fix the rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nearestByPair } from "./soccer-modelfree.js";

const g = (date, home, away, gameTime = `${date}T20:00Z`) => ({ date, home, away, gameTime });

test("nearestByPair: keys on the SORTED pair, so ticker order never matters", () => {
  const out = nearestByPair([g("2026-08-10", "JUN", "PER")], "2026-08-10");
  assert.ok(out["JUN|PER"], "sorted key");
  assert.equal(out["JUN|PER"].gameTime, "2026-08-10T20:00Z");
  // Same fixture with ESPN's home/away the other way round must land on the same key.
  const flipped = nearestByPair([g("2026-08-10", "PER", "JUN")], "2026-08-10");
  assert.deepEqual(Object.keys(flipped), ["JUN|PER"]);
});

test("nearestByPair: a fixture off the target date is still found (the whole point)", () => {
  // dimayor PER@JUN — ticker said 08-10, ESPN listed it 08-12.
  const out = nearestByPair([g("2026-08-12", "JUN", "PER")], "2026-08-10");
  assert.equal(out["JUN|PER"].date, "2026-08-12");
});

test("nearestByPair: NEGATIVE offsets count — the window looks backwards too", () => {
  // argprem BAN@RAC — ticker said 08-15, ESPN listed it 08-14. An implementation that only
  // searched forward would leave this one null.
  const out = nearestByPair([g("2026-08-14", "RAC", "BAN")], "2026-08-15");
  assert.equal(out["BAN|RAC"].date, "2026-08-14");
});

test("nearestByPair: when a pair repeats in the window, the NEAREST fixture wins", () => {
  const out = nearestByPair([
    g("2026-08-12", "JUN", "PER", "far"),
    g("2026-08-11", "JUN", "PER", "near"),
  ], "2026-08-10");
  assert.equal(out["JUN|PER"].gameTime, "near");
  // Order of arrival must not change the answer.
  const reversed = nearestByPair([
    g("2026-08-11", "JUN", "PER", "near"),
    g("2026-08-12", "JUN", "PER", "far"),
  ], "2026-08-10");
  assert.equal(reversed["JUN|PER"].gameTime, "near");
});

test("nearestByPair: an exact-date match beats any neighbour", () => {
  const out = nearestByPair([
    g("2026-08-09", "JUN", "PER", "before"),
    g("2026-08-10", "JUN", "PER", "exact"),
    g("2026-08-11", "JUN", "PER", "after"),
  ], "2026-08-10");
  assert.equal(out["JUN|PER"].gameTime, "exact");
});

test("nearestByPair: malformed rows are skipped, never thrown on", () => {
  const out = nearestByPair([
    null, undefined, {}, { date: "2026-08-10" }, { home: "A", away: "B" },
    g("2026-08-10", "JUN", "PER"),
  ], "2026-08-10");
  assert.deepEqual(Object.keys(out), ["JUN|PER"]);
  assert.deepEqual(nearestByPair(null, "2026-08-10"), {});
  assert.deepEqual(nearestByPair([], "2026-08-10"), {});
});
