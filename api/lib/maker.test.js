import { test } from "node:test";
import assert from "node:assert";
import { computeMakerQuote, replayFills, MAKER_FEE_SERIES } from "./maker.js";
import { MAKER_BAND, MAKER_INSIDE_C, MAKER_SIZE } from "./config.js";

const NOW = Date.parse("2026-07-19T18:00:00Z");
const futureRow = { gameTime: "2026-07-19T23:00:00Z" };
const pastRow = { gameTime: "2026-07-19T17:00:00Z" };

// A real two-sided book with the YES side a rich favorite.
const favYes = { yes_ask_dollars: "0.88", yes_bid_dollars: "0.84", no_ask_dollars: "0.16", no_bid_dollars: "0.12" };

test("quotes 1c inside a favorite YES ask in band", () => {
  const q = computeMakerQuote(favYes, futureRow, NOW);
  assert.ok(q);
  assert.equal(q.side, "yes");
  assert.equal(q.ask, 88 - MAKER_INSIDE_C);
  assert.equal(q.spread, 4);
});

test("quotes the NO side when NO is the in-band favorite", () => {
  const m = { yes_ask_dollars: "0.16", yes_bid_dollars: "0.12", no_ask_dollars: "0.88", no_bid_dollars: "0.84" };
  const q = computeMakerQuote(m, futureRow, NOW);
  assert.equal(q.side, "no");
  assert.equal(q.ask, 87);
});

test("rejects: no in-band favorite (coin flip)", () => {
  const m = { yes_ask_dollars: "0.52", yes_bid_dollars: "0.48", no_ask_dollars: "0.52", no_bid_dollars: "0.48" };
  assert.equal(computeMakerQuote(m, futureRow, NOW), null);
});

test("rejects: stale-ask regime (either side >= 98)", () => {
  const m = { yes_ask_dollars: "0.98", yes_bid_dollars: "0.94", no_ask_dollars: "0.06", no_bid_dollars: "0.02" };
  assert.equal(computeMakerQuote(m, futureRow, NOW), null);
});

test("rejects: wide/dead book (spread > CAPTURE_MAX_SPREAD)", () => {
  const m = { yes_ask_dollars: "0.88", yes_bid_dollars: "0.70", no_ask_dollars: "0.30", no_bid_dollars: "0.12" };
  assert.equal(computeMakerQuote(m, futureRow, NOW), null);
});

test("rejects: one-sided book (missing quote = 0)", () => {
  const m = { yes_ask_dollars: "0.88", yes_bid_dollars: "0", no_ask_dollars: "0.16", no_bid_dollars: "0.12" };
  assert.equal(computeMakerQuote(m, futureRow, NOW), null);
});

test("rejects: in-play or unknown game time", () => {
  assert.equal(computeMakerQuote(favYes, pastRow, NOW), null);
  assert.equal(computeMakerQuote(favYes, {}, NOW), null);
  assert.equal(computeMakerQuote(favYes, { gameTime: null }, NOW), null);
});

test("band edges: MAKER_BAND[0] quotes, MAKER_BAND[1] quotes, one below/above do not", () => {
  const mk = (ask) => ({
    yes_ask_dollars: (ask / 100).toFixed(2), yes_bid_dollars: ((ask - 4) / 100).toFixed(2),
    no_ask_dollars: ((100 - ask + 4) / 100).toFixed(2), no_bid_dollars: ((100 - ask) / 100).toFixed(2),
  });
  assert.equal(computeMakerQuote(mk(MAKER_BAND[0]), futureRow, NOW)?.side, "yes");
  assert.equal(computeMakerQuote(mk(MAKER_BAND[1]), futureRow, NOW)?.side, "yes");
  assert.equal(computeMakerQuote(mk(MAKER_BAND[0] - 1), futureRow, NOW), null);
  assert.equal(computeMakerQuote(mk(MAKER_BAND[1] + 1), futureRow, NOW), null);
});

test("maker-fee series set is exactly the four majors", () => {
  assert.deepEqual([...MAKER_FEE_SERIES].sort(),
    ["KXMLBGAME", "KXNBAGAME", "KXNHLGAME", "KXWNBAGAME"]);
});

// ── replayFills ──
const seg = (over = {}) => ({
  id: 1, ticker: "T", quote_side: "yes", quote_ask: 87,
  valid_from: "2026-07-19T18:00:00Z", valid_to: "2026-07-19T20:00:00Z", ...over,
});
// `taker_side` is the OPPOSITE of the side we quote — see the evidence block in maker.js's
// replayFills (makerSideAudit 2026-07-22: 136/137 real V2 fills opposite, symmetric across
// sides). These two tests previously asserted the inverted convention, which is exactly why
// they never caught the bug: the test encoded the same wrong theory as the code. A test that
// restates the implementation's assumption cannot falsify it — this pair is now pinned to
// measured behaviour instead.
const tr = (over = {}) => ({
  trade_id: "t1", created_time: "2026-07-19T19:00:00Z", taker_side: "no",
  yes_price_c: 88, no_price_c: 12, count: 5, ...over,
});

test("fill: taker on the OPPOSITE side crosses at/above our ask inside the window", () => {
  const fills = replayFills([seg()], [tr()]);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].fill_ask, 87);
  assert.equal(fills[0].contracts, 5);
});

test("no fill: taker price below our ask", () => {
  assert.equal(replayFills([seg()], [tr({ yes_price_c: 86 })]).length, 0);
});

test("no fill: taker on the SAME side as our quote (did not hit us)", () => {
  assert.equal(replayFills([seg()], [tr({ taker_side: "yes" })]).length, 0);
});

test("fill side convention holds for a NO-side quote too (not a YES-only rule)", () => {
  const fills = replayFills(
    [seg({ quote_side: "no", quote_ask: 82 })],
    [tr({ taker_side: "yes", no_price_c: 82, yes_price_c: 18 })]);
  assert.equal(fills.length, 1, "quote_side no is filled by taker_side yes");
  assert.equal(fills[0].fill_ask, 82);
});

test("no fill: trade outside the segment window", () => {
  assert.equal(replayFills([seg()], [tr({ created_time: "2026-07-19T21:00:00Z" })]).length, 0);
  assert.equal(replayFills([seg()], [tr({ created_time: "2026-07-19T17:59:59Z" })]).length, 0);
});

test("open segment (valid_to null) fills until tape ends", () => {
  const fills = replayFills([seg({ valid_to: null })], [tr({ created_time: "2026-07-19T23:00:00Z" })]);
  assert.equal(fills.length, 1);
});

test("size cap: contracts stop at MAKER_SIZE across trades, time-ordered", () => {
  const trades = [
    tr({ trade_id: "b", created_time: "2026-07-19T19:10:00Z", count: 8 }),
    tr({ trade_id: "a", created_time: "2026-07-19T19:05:00Z", count: 7 }),
  ];
  const fills = replayFills([seg()], trades);
  assert.equal(fills.length, 2);
  // time order: "a" (7) first, then "b" capped at MAKER_SIZE − 7
  assert.equal(fills[0].trade_id, "a");
  assert.equal(fills[0].contracts, 7);
  assert.equal(fills[1].trade_id, "b");
  assert.equal(fills[1].contracts, MAKER_SIZE - 7);
});

test("NO-side segment prices off no_price, and fills against YES-taker trades", () => {
  // Two separate assertions bundled here, and the side half was inverted before 2026-07-29:
  // the PRICE we compare comes from our own side (no_price for a NO quote), while the TAKER
  // is on the opposite side. Getting the price half right is what made the old convention
  // look plausible.
  const s = seg({ quote_side: "no", quote_ask: 85 });
  const fills = replayFills([s], [tr({ taker_side: "yes", no_price_c: 86, yes_price_c: 14 })]);
  assert.equal(fills.length, 1, "opposite-side taker at/above our ask fills us");
  assert.equal(replayFills([s], [tr({ taker_side: "yes", no_price_c: 84, yes_price_c: 16 })]).length, 0,
    "below our ask is still no fill");
  assert.equal(replayFills([s], [tr({ taker_side: "no", no_price_c: 86 })]).length, 0,
    "same-side taker did not hit our resting offer");
});

test("fractional count_fp contracts pass through", () => {
  const fills = replayFills([seg()], [tr({ count: 2.5 })]);
  assert.equal(fills[0].contracts, 2.5);
});
