// node --test api/lib/polymarket-capture.test.js
// Tests for the Polymarket capture-all + resolver pure layer (no HTTP): ticker parsing (admits the
// F5 segment family, rejects props/futures), top-of-book (own ask/bid/spread, null on one-sided),
// candidate building (registry-driven categories, drops in-play + non-liquid + non-binary), and UMA
// grading (resolved→winner token, pending, void on non-binary settlement).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCaptureTicker, topOfBook, buildCaptureCandidates, gradePolyMarket,
} from "./polymarket-capture.js";
import { POLY_MARKETS, POLY_SERIES } from "./polymarket.js";
import { KALSHI_VENUE_CATEGORY_PREFIXES, venueCategoryFromKalshiTicker } from "./handlers/shadow/report.js";

test("parseCaptureTicker: base game + F5 parse; props/futures reject", () => {
  assert.deepEqual(parseCaptureTicker("mlb-lad-chc-2026-08-04"),
    { sport: "mlb", awayPoly: "lad", homePoly: "chc", dateStr: "2026-08-04", segment: null });
  assert.deepEqual(parseCaptureTicker("mlb-lad-chc-2026-08-04-first-five-winner"),
    { sport: "mlb", awayPoly: "lad", homePoly: "chc", dateStr: "2026-08-04", segment: "f5" });
  assert.equal(parseCaptureTicker("mlb-bos-col-2026-06-24-player-props"), null);
  assert.equal(parseCaptureTicker("new-mlb-cba-by-dec-1"), null);
  // A sport absent from POLY_MARKETS must not parse — the regex is derived from the registry, so
  // this is the tripwire that adding a league is a one-row change and not a two-place one. kbo is
  // still unbuilt as of this test (nfl was, until Phase 2 2026-08-14 — see the positive case below).
  assert.equal(parseCaptureTicker("kbo-lg-doosan-2026-08-15"), null);
  assert.deepEqual(parseCaptureTicker("nfl-car-buf-2026-08-15"),
    { sport: "nfl", awayPoly: "car", homePoly: "buf", dateStr: "2026-08-15", segment: null });
});

test("POLY_MARKETS: derived POLY_SERIES matches, and every category has a Kalshi vig counterpart", () => {
  // POLY_SERIES is derived, not hand-written — the observatory + scan baseline read this shape.
  assert.deepEqual(POLY_SERIES,
    Object.fromEntries(Object.entries(POLY_MARKETS).map(([s, c]) => [s, c.series])));
  assert.equal(POLY_SERIES.mlb, "3");

  // Both halves of the venue-vig pair must name the same categories, or a Δ is silently always
  // empty — which reads as "no divergence" rather than "not built".
  const polyCats = new Set(Object.values(POLY_MARKETS).flatMap((c) => Object.values(c.categories)));
  for (const cat of polyCats) {
    assert.ok(KALSHI_VENUE_CATEGORY_PREFIXES[cat],
      `Poly category ${cat} has no Kalshi prefix — the Δ would never populate`);
  }
});

test("venueCategoryFromKalshiTicker: F5 threshold families never steal the F5-winner prefix", () => {
  assert.equal(venueCategoryFromKalshiTicker("KXMLBF5-26AUG13LADCHC"), "f5");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBF5TOTAL-26AUG13LADCHC-5.5"), "f5total");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBF5SPREAD-26AUG13LADCHC-1.5"), "f5spread");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBSPREAD-26AUG13LADCHC-1.5"), "spread");
  // full-game total must not absorb the team-total series
  assert.equal(venueCategoryFromKalshiTicker("KXMLBTOTAL-26AUG13LADCHC-8.5"), "total");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBTEAMTOTAL-26AUG13LADCHC-LAD4.5"), null);
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

test("buildCaptureCandidates: spread keeps its line and is team-sided; F5 threshold families captured", () => {
  const nowMs = Date.parse("2026-08-13T18:00:00Z");
  const future = "2026-08-13 23:40:00+00";
  const mkt = (sportsMarketType, line, outcomes, id) => ({
    sportsMarketType, line, gameStartTime: future, bestBid: 0.4, bestAsk: 0.6,
    outcomes: JSON.stringify(outcomes), outcomePrices: '["0.45","0.55"]',
    clobTokenIds: `["${id}a","${id}b"]`, id,
  });
  // All three live under the BARE game ticker (verified live 2026-08-13), not a suffixed one. TB is
  // away, NYY home — per the moneyline market, which is the only reliably away-first ordering.
  const ev = {
    ticker: "mlb-tb-nyy-2026-08-13",
    markets: [
      mkt("moneyline", null, ["Tampa Bay Rays", "New York Yankees"], 300),
      mkt("spreads", -1.5, ["Tampa Bay Rays", "New York Yankees"], 301),
      // SAME event, SAME line, FLIPPED order — this is real (both "TB -1.5" and "NYY -1.5" are
      // listed as separate markets), and it is why side must never be read off the index.
      mkt("spreads", -1.5, ["New York Yankees", "Tampa Bay Rays"], 302),
      mkt("baseball_team_first_five_total", 2.5, ["Over", "Under"], 303),
      mkt("baseball_team_first_five_spread", -0.5, ["New York Yankees", "Tampa Bay Rays"], 304),
    ],
  };
  const cands = buildCaptureCandidates(ev, nowMs);
  assert.equal(cands.length, 10);

  // Both spread markets must place the Yankees on 'home', despite opposite outcome ordering.
  const nyy = cands.filter((c) => c.category === "spread" && c.outcome === "New York Yankees");
  assert.equal(nyy.length, 2);
  assert.ok(nyy.every((c) => c.side === "home"), "spread side must come from the name, not the index");
  const tb = cands.filter((c) => c.category === "spread" && c.outcome === "Tampa Bay Rays");
  assert.ok(tb.every((c) => c.side === "away"));

  // The line is stated from outcome[0]'s perspective, so each row carries its OWN side's line:
  // market 301 is "TB -1.5" → TB -1.5 / NYY +1.5; market 302 is "NYY -1.5" → NYY -1.5 / TB +1.5.
  const m301 = cands.filter((c) => c.market_id === "301");
  assert.equal(m301.find((c) => c.side === "away").line, -1.5);
  assert.equal(m301.find((c) => c.side === "home").line, 1.5);
  const m302 = cands.filter((c) => c.market_id === "302");
  assert.equal(m302.find((c) => c.side === "home").line, -1.5);
  assert.equal(m302.find((c) => c.side === "away").line, 1.5);

  // Totals are Over/Under and share ONE line across both sides — never negated.
  const f5t = cands.filter((c) => c.category === "f5total");
  assert.deepEqual(f5t.map((c) => c.line), [2.5, 2.5]);
  assert.deepEqual(f5t.map((c) => c.side).sort(), ["over", "under"]);

  const f5s = cands.filter((c) => c.category === "f5spread");
  assert.equal(f5s.find((c) => c.side === "home").line, -0.5);
  assert.equal(f5s.find((c) => c.side === "away").line, 0.5);
});

test("buildCaptureCandidates: no moneyline market → name-sided rows keep the verbatim name", () => {
  const nowMs = Date.parse("2026-08-13T18:00:00Z");
  const ev = {
    ticker: "mlb-tb-nyy-2026-08-13",
    markets: [{ sportsMarketType: "spreads", line: -1.5, gameStartTime: "2026-08-13 23:40:00+00",
      bestBid: 0.4, bestAsk: 0.6, outcomes: '["Tampa Bay Rays","New York Yankees"]',
      outcomePrices: '["0.45","0.55"]', clobTokenIds: '["s1","s2"]', id: 501 }],
  };
  // Without the away-first reference an away/home claim would be a coin flip, so it is not made.
  assert.deepEqual(buildCaptureCandidates(ev, nowMs).map((c) => c.side),
    ["tampa bay rays", "new york yankees"]);
});

test("buildCaptureCandidates: a market type absent from the league's registry row is skipped", () => {
  const nowMs = Date.parse("2026-08-13T18:00:00Z");
  const ev = {
    ticker: "mlb-tb-nyy-2026-08-13",
    markets: [{ sportsMarketType: "nrfi", gameStartTime: "2026-08-13 23:40:00+00",
      bestBid: 0.4, bestAsk: 0.6, outcomes: '["Yes","No"]', outcomePrices: '["0.45","0.55"]',
      clobTokenIds: '["n1","n2"]', id: 401 }],
  };
  assert.equal(buildCaptureCandidates(ev, nowMs).length, 0);
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
      { sportsMarketType: "spreads", line: -1.5, gameStartTime: future, bestBid: 0.4, bestAsk: 0.6,
        outcomes: '["A","B"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["x","y"]', id: 113 },
      // untraded placeholder (bestAsk ≥ .98) → non-liquid, skipped
      { sportsMarketType: "moneyline", gameStartTime: future, bestBid: 0.01, bestAsk: 0.99,
        outcomes: '["A","B"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["p","q"]', id: 114 },
    ],
  };
  const cands = buildCaptureCandidates(gameEv, nowMs);
  // 2 ml + 2 total + 2 spread = 6 sides
  assert.equal(cands.length, 6);
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

test("buildCaptureCandidates: nfl ml+totals only, away-first, LAR/WSH aliases resolve", () => {
  const nowMs = Date.parse("2026-08-14T12:00:00Z");
  const future = "2026-08-15 17:00:00+00";
  const mkt = (sportsMarketType, line, outcomes, id) => ({
    sportsMarketType, line, gameStartTime: future, bestBid: 0.4, bestAsk: 0.6,
    outcomes: JSON.stringify(outcomes), outcomePrices: '["0.45","0.55"]',
    clobTokenIds: `["${id}a","${id}b"]`, id,
  });
  const ev = {
    // Poly's own team abbrs — "la" for the Rams and "was" for Washington, both aliased in teams.js.
    ticker: "nfl-la-was-2026-08-15",
    markets: [
      mkt("moneyline", null, ["Rams", "Commanders"], 900),
      mkt("totals", 44.5, ["Over", "Under"], 901),
      // spreads/team_totals are out of scope (no Kalshi NFL book) — must be skipped, not captured.
      mkt("spreads", -2.5, ["LAR", "WAS"], 902),
      mkt("team_totals", 21.5, ["Over", "Under"], 903),
    ],
  };
  const cands = buildCaptureCandidates(ev, nowMs);
  assert.deepEqual(cands.map((c) => c.category).sort(), ["ml", "ml", "total", "total"]);
  const ml = cands.filter((c) => c.category === "ml");
  assert.equal(ml.find((c) => c.side === "away").outcome, "Rams");
  assert.equal(ml[0].game, "LAR@WSH");
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
