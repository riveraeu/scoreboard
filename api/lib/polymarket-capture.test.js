// node --test api/lib/polymarket-capture.test.js
// Tests for the Polymarket capture-all + resolver pure layer (no HTTP): ticker parsing (admits the
// F5 segment family, rejects props/futures), top-of-book (own ask/bid/spread, null on one-sided),
// candidate building (ml+total+f5, drops in-play + non-liquid + non-binary), and UMA grading
// (resolved→winner token, pending, void on non-binary settlement).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCaptureTicker, topOfBook, buildCaptureCandidates, gradePolyMarket,
} from "./polymarket-capture.js";

test("parseCaptureTicker: base game + F5 parse; props/futures reject", () => {
  assert.deepEqual(parseCaptureTicker("mlb-lad-chc-2026-08-04"),
    { sport: "mlb", awayPoly: "lad", homePoly: "chc", dateStr: "2026-08-04", family: "game" });
  assert.deepEqual(parseCaptureTicker("mlb-lad-chc-2026-08-04-first-five-winner"),
    { sport: "mlb", awayPoly: "lad", homePoly: "chc", dateStr: "2026-08-04", family: "f5" });
  assert.equal(parseCaptureTicker("mlb-bos-col-2026-06-24-player-props"), null);
  assert.equal(parseCaptureTicker("new-mlb-cba-by-dec-1"), null);
});

test("topOfBook: own ask/bid/spread in cents; null when a side is empty", () => {
  const book = {
    asks: [{ price: "0.59", size: "100" }, { price: "0.61", size: "50" }],
    bids: [{ price: "0.57", size: "80" }, { price: "0.55", size: "40" }],
  };
  assert.deepEqual(topOfBook(book), { askC: 59, bidC: 57, spreadC: 2 });
  assert.equal(topOfBook({ asks: [], bids: [{ price: "0.5", size: "1" }] }), null);
  assert.equal(topOfBook({ asks: [{ price: "0.5", size: "1" }], bids: [] }), null);
});

test("buildCaptureCandidates: ml+total+f5 sides; in-play + non-liquid + non-binary dropped", () => {
  const nowMs = Date.parse("2026-08-04T18:00:00Z");
  const future = "2026-08-04 23:40:00+00"; // after nowMs → pre-game, kept
  const past = "2026-08-04 17:00:00+00";   // before nowMs → in-play, dropped

  // base game event: one moneyline + one totals market, both liquid + binary
  const gameEv = {
    ticker: "mlb-lad-chc-2026-08-04",
    markets: [
      { sportsMarketType: "moneyline", gameStartTime: future, bestBid: 0.4, bestAsk: 0.6,
        outcomes: '["Los Angeles Dodgers","Chicago Cubs"]', outcomePrices: '["0.45","0.55"]',
        clobTokenIds: '["tokAway","tokHome"]', id: 111 },
      { sportsMarketType: "totals", line: 8.5, gameStartTime: future, bestBid: 0.48, bestAsk: 0.52,
        outcomes: '["Over","Under"]', outcomePrices: '["0.5","0.5"]',
        clobTokenIds: '["tokOver","tokUnder"]', id: 112 },
      // spread type → out of scope, skipped
      { sportsMarketType: "spreads", line: -1.5, gameStartTime: future, bestBid: 0.4, bestAsk: 0.6,
        outcomes: '["A","B"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["x","y"]', id: 113 },
      // untraded placeholder (bestAsk ≥ .98) → non-liquid, skipped
      { sportsMarketType: "moneyline", gameStartTime: future, bestBid: 0.01, bestAsk: 0.99,
        outcomes: '["A","B"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["p","q"]', id: 114 },
    ],
  };
  const cands = buildCaptureCandidates(gameEv, nowMs);
  // 2 ml + 2 total = 4 sides
  assert.equal(cands.length, 4);
  const ml = cands.filter((c) => c.category === "ml");
  assert.equal(ml.length, 2);
  assert.deepEqual(ml.map((c) => c.side).sort(), ["away", "home"]);
  assert.equal(ml.find((c) => c.side === "away").outcome, "Los Angeles Dodgers");
  assert.equal(ml[0].game, "LAD@CHC");
  const tot = cands.filter((c) => c.category === "total");
  assert.deepEqual(tot.map((c) => c.side).sort(), ["over", "under"]);
  assert.equal(tot[0].line, 8.5);
  assert.equal(tot.find((c) => c.side === "over").gamma_price_c ?? tot[0].gammaPriceC, 50);

  // F5 event
  const f5Ev = {
    ticker: "mlb-lad-chc-2026-08-04-first-five-winner",
    markets: [{ sportsMarketType: "moneyline", gameStartTime: future, bestBid: 0.55, bestAsk: 0.62,
      outcomes: '["Yes","No"]', outcomePrices: '["0.59","0.41"]', clobTokenIds: '["f5y","f5n"]', id: 222 }],
  };
  const f5 = buildCaptureCandidates(f5Ev, nowMs);
  assert.equal(f5.length, 2);
  assert.equal(f5.every((c) => c.category === "f5"), true);
  assert.deepEqual(f5.map((c) => c.side).sort(), ["no", "yes"]);

  // in-play event → dropped entirely
  assert.equal(buildCaptureCandidates({ ...gameEv, markets: gameEv.markets.map((m) => ({ ...m, gameStartTime: past })) }, nowMs).length, 0);
});

test("gradePolyMarket: resolved names winner token; pending; void on non-binary", () => {
  const m = (uma, prices) => ({ umaResolutionStatus: uma, outcomePrices: prices, clobTokenIds: '["tokA","tokB"]' });
  assert.deepEqual(gradePolyMarket(m("resolved", '["1","0"]')), { status: "resolved", winningTokenId: "tokA" });
  assert.deepEqual(gradePolyMarket(m("resolved", '["0","1"]')), { status: "resolved", winningTokenId: "tokB" });
  assert.equal(gradePolyMarket(m("proposed", '["0.5","0.5"]')).status, "pending");
  assert.equal(gradePolyMarket(m(undefined, '["1","0"]')).status, "pending");
  assert.equal(gradePolyMarket(m("resolved", '["0.5","0.5"]')).status, "void"); // scalar/tie
  assert.equal(gradePolyMarket(m("resolved", '["1","1"]')).status, "void");
});
