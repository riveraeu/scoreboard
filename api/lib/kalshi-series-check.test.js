import test from "node:test";
import assert from "node:assert/strict";
import { screenMarkets, SCREEN_AUTO_DISMISS } from "./kalshi-series-check.js";
import { CAPTURE_MAX_SPREAD } from "./config.js";

// screenMarkets decides what the scan auto-dismisses without a human, so a wrong answer silently
// hides a real market class. Field shapes here are copied from a live Kalshi response
// (dollar fields are STRINGS, volume is `volume_fp`) — the parse is half of what's under test.
const mkt = (ev, yesAsk, yesBid, noAsk, noBid, vol = "0") => ({
  ticker: `${ev}-A`, event_ticker: ev,
  yes_ask_dollars: yesAsk, yes_bid_dollars: yesBid,
  no_ask_dollars: noAsk, no_bid_dollars: noBid, volume_fp: vol,
});
// A real, tight two-sided book: 5¢ spread on both sides of a unified book.
const real = (ev, vol = "7.73") => mkt(ev, "0.6300", "0.5800", "0.4200", "0.3700", vol);
// A lone one-sided quote — the totalBases-94¢ artifact shape: no bid on either side.
const oneSided = (ev) => mkt(ev, "0.9400", "0", "0.0600", "0");
const many = (n, f) => Array.from({ length: n }, (_, i) => f(`EV${i}`));

test("EMPTY_SHELL on a series with no live markets", () => {
  const s = screenMarkets([]);
  assert.equal(s.screen, "EMPTY_SHELL");
  assert.equal(s.live_market_count, 0);
});

test("REAL_BOOK on tight two-sided books", () => {
  const s = screenMarkets(many(6, real));
  assert.equal(s.screen, "REAL_BOOK");
  assert.equal(s.real_book_count, 6);
  assert.equal(s.median_spread_c, 5);
  assert.equal(s.real_book_frac, 1);
  assert.ok(s.volume_total > 0);
});

test("DEAD_BOOK when no market has a two-sided book", () => {
  const s = screenMarkets(many(6, oneSided));
  assert.equal(s.screen, "DEAD_BOOK");
  assert.equal(s.real_book_count, 0);
});

test("DEAD_BOOK when the median spread exceeds CAPTURE_MAX_SPREAD", () => {
  // 20¢ on both sides — quoted, two-sided, and still not a price.
  const wide = (ev) => mkt(ev, "0.6000", "0.4000", "0.6000", "0.4000");
  const s = screenMarkets(many(6, wide));
  assert.equal(s.screen, "DEAD_BOOK");
  assert.ok(s.median_spread_c > CAPTURE_MAX_SPREAD);
});

test("a book exactly at CAPTURE_MAX_SPREAD is NOT dead (gate is inclusive, matching capturableSpread)", () => {
  const atGate = (ev) => mkt(ev, "0.6000", "0.4500", "0.5500", "0.4000"); // 15¢ both sides
  const s = screenMarkets(many(6, atGate));
  assert.equal(s.median_spread_c, CAPTURE_MAX_SPREAD);
  assert.equal(s.screen, "REAL_BOOK");
});

test("THIN, not DEAD, below the evidence floor — too few markets to call it", () => {
  // 3 one-sided markets would be DEAD at n>=5; under the floor it must stay in the human queue.
  const s = screenMarkets(many(3, oneSided));
  assert.equal(s.screen, "THIN");
  assert.ok(!SCREEN_AUTO_DISMISS.includes(s.screen), "THIN must never be auto-dismissed");
});

test("THIN when real books exist but too few to promote", () => {
  const s = screenMarkets([...many(2, real), ...many(2, oneSided)]);
  assert.equal(s.screen, "THIN");
});

test("overround is measured on 2-way events and reads ~1 on a real book", () => {
  // Two markets per event, asks summing to 1 + spread — the live MLB ML shape.
  const ms = [];
  for (let i = 0; i < 6; i++) {
    ms.push(mkt(`EV${i}`, "0.6300", "0.5800", "0.4200", "0.3700"));
    ms.push(mkt(`EV${i}`, "0.4200", "0.3700", "0.6300", "0.5800"));
  }
  const s = screenMarkets(ms);
  assert.ok(Math.abs(s.overround - 1.05) < 1e-6, `expected ~1.05, got ${s.overround}`);
  assert.equal(s.screen, "REAL_BOOK");
});

test("an alt-line ladder is NOT scored as overround — and stays REAL_BOOK", () => {
  // 8 non-exclusive strikes under ONE event. Summing their asks would read ~5.0 and look 'dead';
  // the screen must skip events that aren't 2- or 3-way, and must not gate on overround at all.
  const ladder = Array.from({ length: 8 }, (_, i) => mkt("EV_LADDER", "0.6300", "0.5800", "0.4200", "0.3700"));
  const s = screenMarkets(ladder);
  assert.equal(s.overround, null, "8-market event must not be treated as exclusive");
  assert.equal(s.screen, "REAL_BOOK");
});

test("SCREEN_AUTO_DISMISS covers only the two unambiguous dead verdicts", () => {
  assert.deepEqual([...SCREEN_AUTO_DISMISS].sort(), ["DEAD_BOOK", "EMPTY_SHELL"]);
});
