// Unit tests for the sharp-book vs Kalshi delta emitter — sign, liquidity gate, doubleheader skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emitSportsbookDeltas } from "./sportsbook-deltas.js";

const mlRow = (side, pct, vol, extra = {}) => ({
  gameType: "ml", stat: "ml", sport: "mlb", awayTeam: "BOS", homeTeam: "NYY",
  side, kalshiPct: pct, kalshiVolume: vol, gameDate: "2026-06-30", truePct: pct, ...extra,
});

test("emits signed deltas for traded sides (bookFair − kalshi)", () => {
  const plays = [mlRow("home", 60, 500), mlRow("away", 40, 500)];
  const bookGames = [{ sport: "mlb", away: "BOS", home: "NYY", gameDate: "2026-06-30", ml: { home: 0.66, away: 0.34 }, book: "pinnacle" }];
  const deltas = [];
  const s = emitSportsbookDeltas({ bookGames, plays, deltas });
  assert.equal(s.n, 2);
  assert.equal(s.illiquidSkipped, 0);
  const home = deltas.find(d => d.side === "home");
  assert.equal(home.deltaCents, 6);   // 66 − 60 → Kalshi cheap on home = edge to buy
  assert.equal(deltas.find(d => d.side === "away").deltaCents, -6);
});

test("liquidity gate skips untraded (vol=0) Kalshi sides", () => {
  const plays = [mlRow("home", 60, 0), mlRow("away", 40, 0)];
  const bookGames = [{ sport: "mlb", away: "BOS", home: "NYY", gameDate: "2026-06-30", ml: { home: 0.66, away: 0.34 }, book: "pinnacle" }];
  const deltas = [];
  const s = emitSportsbookDeltas({ bookGames, plays, deltas });
  assert.equal(s.n, 0);
  assert.equal(s.illiquidSkipped, 2);
});

test("prefers the most-traded row when a side has several (no false ambiguity within 2¢)", () => {
  // Two home rows: stale vol=0 @40 and traded vol=300 @42 (≤2¢ apart → not a DH conflict).
  const plays = [mlRow("home", 40, 0), mlRow("home", 42, 300), mlRow("away", 58, 300)];
  const bookGames = [{ sport: "mlb", away: "BOS", home: "NYY", gameDate: "2026-06-30", ml: { home: 0.50, away: 0.50 }, book: "pinnacle" }];
  const deltas = [];
  emitSportsbookDeltas({ bookGames, plays, deltas });
  assert.equal(deltas.find(d => d.side === "home").kalshiPct, 42); // the traded line, not the stale 40
});

test("exact PT-date match only — tonight's book game must NOT match tomorrow's Kalshi market", () => {
  // Same-series next-day Kalshi listing (7/01) with tonight's (6/30) book odds. The old ±1-day
  // fuzz matched these and logged a fake 30¢ delta (2026-07-01 tail audit); now: no match at all.
  const plays = [mlRow("home", 62, 500, { gameDate: "2026-07-01" }), mlRow("away", 39, 500, { gameDate: "2026-07-01" })];
  const bookGames = [{ sport: "mlb", away: "BOS", home: "NYY", gameDate: "2026-06-30", ml: { home: 0.935, away: 0.065 }, book: "pinnacle" }];
  const deltas = [];
  const s = emitSportsbookDeltas({ bookGames, plays, deltas });
  assert.equal(s.n, 0);
  assert.equal(deltas.length, 0);
});

test("skips doubleheaders (conflicting same-side prices >2¢)", () => {
  const plays = [mlRow("home", 62, 500), mlRow("home", 52, 500), mlRow("away", 39, 500), mlRow("away", 36, 500)];
  const bookGames = [{ sport: "mlb", away: "BOS", home: "NYY", gameDate: "2026-06-30", ml: { home: 0.935, away: 0.065 }, book: "pinnacle" }];
  const deltas = [];
  const s = emitSportsbookDeltas({ bookGames, plays, deltas });
  assert.equal(s.n, 0); // ambiguous key → whole game skipped, no fake 30¢ delta
});
