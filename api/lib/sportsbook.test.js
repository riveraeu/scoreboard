// Unit tests for the sharp-book reference feed (pure functions only — no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  devigTwoWay, normSportsbookTeam, normalizeOddsEvent, fetchSportsbookGames,
} from "./sportsbook.js";

test("devigTwoWay removes vig and sums to 1", () => {
  // Symmetric juiced line (1.91/1.91 ≈ -110/-110) → 50/50 after de-vig.
  const sym = devigTwoWay(1.91, 1.91);
  assert.ok(Math.abs(sym.a - 0.5) < 1e-9 && Math.abs(sym.b - 0.5) < 1e-9);
  // Asymmetric favorite — fair probs sum to 1, favorite > dog.
  const f = devigTwoWay(1.5, 2.6);
  assert.ok(Math.abs(f.a + f.b - 1) < 1e-9);
  assert.ok(f.a > f.b); // 1.5 (lower odds) is the favorite
  assert.equal(devigTwoWay(0, 2), null);   // unusable price
  assert.equal(devigTwoWay(1.0, 2), null); // even-money-or-worse decimal=1 rejected
});

test("normSportsbookTeam maps full names → canonical, unknown → null", () => {
  assert.equal(normSportsbookTeam("mlb", "New York Yankees"), "NYY");
  assert.equal(normSportsbookTeam("mlb", "  st. louis cardinals  "), "STL");
  assert.equal(normSportsbookTeam("mlb", "Oakland Athletics"), "ATH");
  assert.equal(normSportsbookTeam("wnba", "Golden State Valkyries"), "GS");
  assert.equal(normSportsbookTeam("wnba", "Las Vegas Aces"), "LV");
  assert.equal(normSportsbookTeam("mlb", "Nowhere Nobodies"), null);
  assert.equal(normSportsbookTeam("nba", "Boston Celtics"), null); // NBA map TODO → null
});

test("normalizeOddsEvent de-vigs a Pinnacle h2h event to canonical sides", () => {
  const ev = {
    home_team: "New York Yankees", away_team: "Boston Red Sox",
    commence_time: "2026-06-30T23:05:00Z",
    bookmakers: [{ key: "pinnacle", markets: [{ key: "h2h", outcomes: [
      { name: "New York Yankees", price: 1.65 },
      { name: "Boston Red Sox", price: 2.40 },
    ] }] }],
  };
  const g = normalizeOddsEvent("mlb", ev);
  assert.equal(g.sport, "mlb");
  assert.equal(g.home, "NYY");
  assert.equal(g.away, "BOS");
  assert.equal(g.gameDate, "2026-06-30");
  assert.equal(g.book, "pinnacle");
  assert.ok(Math.abs(g.ml.home + g.ml.away - 1) < 1e-9);
  assert.ok(g.ml.home > g.ml.away); // Yankees favored (1.65 < 2.40)
});

test("normalizeOddsEvent rejects unknown teams / missing h2h", () => {
  assert.equal(normalizeOddsEvent("mlb", {
    home_team: "Nowhere Nobodies", away_team: "Boston Red Sox", commence_time: "2026-06-30T23:05:00Z",
    bookmakers: [{ key: "pinnacle", markets: [{ key: "h2h", outcomes: [{ name: "x", price: 2 }, { name: "y", price: 2 }] }] }],
  }), null);
  assert.equal(normalizeOddsEvent("mlb", {
    home_team: "New York Yankees", away_team: "Boston Red Sox", commence_time: "2026-06-30T23:05:00Z",
    bookmakers: [{ key: "pinnacle", markets: [{ key: "totals", outcomes: [] }] }], // no h2h
  }), null);
});

test("fetchSportsbookGames is a clean no-op without an API key", async () => {
  const games = await fetchSportsbookGames({ apiKey: null, sports: ["mlb"] });
  assert.deepEqual(games, []);
});
