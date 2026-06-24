// node --test api/lib/polymarket.test.js
// Tests for the Phase-1a Polymarket cross-venue observatory. Pins the pure layer (no HTTP):
// game-ticker parsing (rejects props/first-five/futures suffixes), Poly→canonical abbr mapping
// (oak→ATH, gsv→GS, identity, unknown→null), event normalization (live moneyline/totals kept,
// untraded 0.5/0.5 placeholders + unknown teams dropped), and the delta emit (signed cents,
// UTC/PT ±1-day matching, summary medians).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGameTicker, normPolyTeam, normalizeEvent } from "./polymarket.js";
import { emitPolymarketDeltas } from "./tonight/polymarket-deltas.js";

test("parseGameTicker: main game ticker parses; suffixed/non-game reject", () => {
  assert.deepEqual(parseGameTicker("mlb-mil-stl-2026-05-05"),
    { sport: "mlb", awayPoly: "mil", homePoly: "stl", dateStr: "2026-05-05" });
  assert.equal(parseGameTicker("mlb-bos-col-2026-06-24-player-props"), null);
  assert.equal(parseGameTicker("mlb-atl-cws-2026-06-11-first-five-winner"), null);
  assert.equal(parseGameTicker("new-mlb-cba-by-dec-1"), null);
});

test("normPolyTeam: alias overrides, identity, unknown→null", () => {
  assert.equal(normPolyTeam("mlb", "oak"), "ATH");  // Poly still uses oak; we canonicalize ATH
  assert.equal(normPolyTeam("mlb", "nyy"), "NYY");  // identity
  assert.equal(normPolyTeam("wnba", "gsv"), "GS");
  assert.equal(normPolyTeam("wnba", "las"), "LV");
  assert.equal(normPolyTeam("wnba", "nyl"), "NY");
  assert.equal(normPolyTeam("mlb", "zzz"), null);
});

const _liveMkt = (extra) => ({ closed: false, active: true, bestBid: 0.45, bestAsk: 0.55, ...extra });

test("normalizeEvent: live moneyline + totals normalize, teams canonicalized", () => {
  const ev = {
    ticker: "mlb-mil-stl-2026-05-05",
    markets: [
      _liveMkt({ sportsMarketType: "moneyline", outcomes: '["Milwaukee Brewers","St. Louis Cardinals"]', outcomePrices: '["0.575","0.425"]', line: null }),
      _liveMkt({ sportsMarketType: "totals", line: 7.5, outcomes: '["Over","Under"]', outcomePrices: '["0.5495","0.4505"]' }),
      _liveMkt({ sportsMarketType: "spreads", line: -1.5, outcomes: '["Milwaukee Brewers","St. Louis Cardinals"]', outcomePrices: '["0.295","0.705"]' }),
    ],
  };
  const g = normalizeEvent(ev);
  assert.equal(g.sport, "mlb");
  assert.equal(g.away, "MIL");
  assert.equal(g.home, "STL");
  assert.equal(g.gameDate, "2026-05-05");
  assert.deepEqual(g.ml, { away: 0.575, home: 0.425 });
  assert.equal(g.totals.length, 1);
  assert.deepEqual(g.totals[0], { line: 7.5, over: 0.5495, under: 0.4505 });
});

test("normalizeEvent: untraded placeholder (no live moneyline) → null", () => {
  const ev = {
    ticker: "mlb-min-hou-2026-06-29",
    markets: [{ sportsMarketType: "moneyline", closed: false, active: true, bestBid: 0.02, bestAsk: 0.98, outcomes: '["Minnesota Twins","Houston Astros"]', outcomePrices: '["0.5","0.5"]' }],
  };
  assert.equal(normalizeEvent(ev), null);
});

test("normalizeEvent: unknown team → null (no false match)", () => {
  const ev = { ticker: "mlb-xxx-yyy-2026-05-05", markets: [_liveMkt({ sportsMarketType: "moneyline", outcomes: '["A","B"]', outcomePrices: '["0.6","0.4"]' })] };
  assert.equal(normalizeEvent(ev), null);
});

test("emitPolymarketDeltas: signed cents, ml + totals, ±1-day match, summary", () => {
  const polyGames = [{
    sport: "mlb", away: "MIL", home: "STL", gameDate: "2026-05-06", // Poly UTC = our PT + 1
    ml: { away: 0.60, home: 0.40 },
    totals: [{ line: 7.5, over: 0.55, under: 0.45 }],
  }];
  // Our Kalshi rows are keyed on the PT gameDate (2026-05-05).
  const plays = [
    { gameType: "ml", stat: "ml", sport: "mlb", awayTeam: "MIL", homeTeam: "STL", side: "away", kalshiPct: 57.5, truePct: 59, gameDate: "2026-05-05" },
  ];
  const dropped = [
    { gameType: "ml", stat: "ml", sport: "mlb", awayTeam: "MIL", homeTeam: "STL", side: "home", kalshiPct: 42.5, truePct: 41, gameDate: "2026-05-05" },
    { gameType: "total", stat: "totalRuns", sport: "mlb", awayTeam: "MIL", homeTeam: "STL", threshold: 7.5, direction: "over", kalshiPct: 54.9, truePct: 56, gameDate: "2026-05-05" },
    { gameType: "total", stat: "totalRuns", sport: "mlb", awayTeam: "MIL", homeTeam: "STL", threshold: 7.5, direction: "under", kalshiPct: 54.9, noKalshiPct: 45.1, gameDate: "2026-05-05" },
  ];
  const deltas = [];
  const summary = emitPolymarketDeltas({ polyGames, plays, dropped, deltas });

  const mlAway = deltas.find((d) => d.market === "ml" && d.side === "away");
  assert.equal(mlAway.polyPct, 60);
  assert.equal(mlAway.kalshiPct, 57.5);
  assert.equal(mlAway.deltaCents, 2.5);
  assert.equal(mlAway.modelTruePct, 59);
  assert.equal(mlAway.gameDate, "2026-05-05"); // matched on the −1-day candidate

  const overRow = deltas.find((d) => d.market === "total" && d.side === "over");
  assert.ok(Math.abs(overRow.deltaCents - 0.1) < 1e-9, `over delta 55−54.9, got ${overRow.deltaCents}`);
  const underRow = deltas.find((d) => d.market === "total" && d.side === "under");
  assert.ok(Math.abs(underRow.deltaCents - (-0.1)) < 1e-9, `under delta 45−45.1, got ${underRow.deltaCents}`);

  assert.equal(summary.n, 4);
  assert.equal(summary.matchedGames, 1);
  assert.equal(summary.byMarket.ml.n, 2);
  assert.equal(summary.byMarket.total.n, 2);
  assert.equal(summary.bySport.mlb, 4);
});

test("emitPolymarketDeltas: no Kalshi match → no rows", () => {
  const deltas = [];
  const s = emitPolymarketDeltas({
    polyGames: [{ sport: "mlb", away: "MIL", home: "STL", gameDate: "2026-05-06", ml: { away: 0.6, home: 0.4 }, totals: [] }],
    plays: [], dropped: [], deltas,
  });
  assert.equal(deltas.length, 0);
  assert.equal(s.matchedGames, 0);
});
