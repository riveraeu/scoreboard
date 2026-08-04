// Unit tests for the MLB pitcher outs-recorded model-free maker capture (KXMLBOUTS).
import { test } from "node:test";
import assert from "node:assert";
import { emitMlbOutsPlays } from "./mlb-outs.js";

const homeTeams = { NYM: "NYM" }; // gameHomeTeams: NYM is home

test("emitMlbOutsPlays: emits favorite OVER side, model-free (truePct/edge null, qualified false)", () => {
  const outsPlays = [];
  emitMlbOutsPlays({
    outsMarkets: [{
      player: "Kodai Senga", threshold: 15, gameTeam1: "CHC", gameTeam2: "NYM",
      pitcherTeam: "NYM", yesPct: 72, noPct: 30, yesAO: -257, noAO: 233,
      kalshiVolume: 50, gameDate: "2026-06-23", _ticker: "KXMLBOUTS-26JUN23-SENGA-15",
    }],
    outsPlays, cutoffStr: "2026-06-22",
    sportByteam: { mlb: { gameHomeTeams: homeTeams } },
  });
  assert.strictEqual(outsPlays.length, 1);
  const pl = outsPlays[0];
  assert.strictEqual(pl.stat, "outs");
  assert.strictEqual(pl.direction, "over");
  assert.strictEqual(pl.kalshiPct, 72);
  assert.strictEqual(pl.homeTeam, "NYM"); // swapped from ticker order via gameHomeTeams
  assert.strictEqual(pl.awayTeam, "CHC");
  assert.strictEqual(pl.truePct, null);
  assert.strictEqual(pl.edge, null);
  assert.strictEqual(pl.qualified, false);
  assert.strictEqual(pl.modelFree, true);
  assert.strictEqual(pl.kalshiTicker, "KXMLBOUTS-26JUN23-SENGA-15");
});

test("emitMlbOutsPlays: under favorite → direction under, uses NO price", () => {
  const outsPlays = [];
  emitMlbOutsPlays({
    outsMarkets: [{
      player: "Some Pitcher", threshold: 21, gameTeam1: "SD", gameTeam2: "LAD",
      pitcherTeam: "LAD", yesPct: 18, noPct: 80, yesAO: 455, noAO: -400,
      kalshiVolume: 10, gameDate: "2026-06-23",
    }],
    outsPlays, cutoffStr: "2026-06-22",
    sportByteam: { mlb: {} },
  });
  assert.strictEqual(outsPlays.length, 1);
  assert.strictEqual(outsPlays[0].direction, "under");
  assert.strictEqual(outsPlays[0].kalshiPct, 80);
});

test("emitMlbOutsPlays: captures without any pitcher data (model-free — no more no_pitcher_data drop)", () => {
  const outsPlays = [];
  emitMlbOutsPlays({
    outsMarkets: [{
      player: "Unknown Guy", threshold: 15, gameTeam1: "NYY", gameTeam2: "BOS",
      pitcherTeam: "NYY", yesPct: 75, noPct: 27, gameDate: "2026-06-23",
    }],
    outsPlays, cutoffStr: "2026-06-22",
    sportByteam: { mlb: {} },
  });
  assert.strictEqual(outsPlays.length, 1); // no pitcher stats needed anymore
  assert.strictEqual(outsPlays[0].truePct, null);
});

test("emitMlbOutsPlays: real gameTime from the pitcher's team, with home/away fallback", () => {
  const mk = (gameTimes) => {
    const outsPlays = [];
    emitMlbOutsPlays({
      outsMarkets: [{
        player: "Kodai Senga", threshold: 15, gameTeam1: "CHC", gameTeam2: "NYM",
        pitcherTeam: "NYM", yesPct: 72, noPct: 30, gameDate: "2026-06-23",
      }],
      outsPlays, cutoffStr: "2026-06-22",
      sportByteam: { mlb: { gameHomeTeams: homeTeams } }, gameTimes,
    });
    return outsPlays[0].gameTime;
  };
  assert.strictEqual(mk({ "mlb:NYM:2026-06-23": "2026-06-23T23:10:00Z" }), "2026-06-23T23:10:00Z");
  assert.strictEqual(mk({ "mlb:CHC:2026-06-23": "2026-06-23T23:10:00Z" }), "2026-06-23T23:10:00Z"); // away fallback
  assert.strictEqual(mk({}), null);
});

test("emitMlbOutsPlays: wide CAPTURE band logs the full curve — a 55/47 mid-market IS captured", () => {
  const outsPlays = [];
  emitMlbOutsPlays({
    outsMarkets: [{ player: "Mid Market", threshold: 17, gameTeam1: "NYY", gameTeam2: "BOS", yesPct: 55, noPct: 47, gameDate: "2026-06-23" }],
    outsPlays, cutoffStr: "2026-06-22", sportByteam: { mlb: {} },
  });
  assert.strictEqual(outsPlays.length, 1);
  assert.strictEqual(outsPlays[0].direction, "over"); // 55 ≥ 47
});

test("emitMlbOutsPlays: skips a no-book market (both sides outside [CAPTURE_GATE, CAPTURE_CAP])", () => {
  const outsPlays = [];
  emitMlbOutsPlays({
    outsMarkets: [{ player: "No Book", threshold: 17, gameTeam1: "NYY", gameTeam2: "BOS", yesPct: 0, noPct: 0, gameDate: "2026-06-23" }],
    outsPlays, cutoffStr: "2026-06-22", sportByteam: { mlb: {} },
  });
  assert.strictEqual(outsPlays.length, 0);
});
