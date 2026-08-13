import { test } from "node:test";
import assert from "node:assert";
import { computeMakerQuote, replayFills, MAKER_FEE_SERIES,
  quotePassTelemetryCommands, QUOTEPASS_KEY_PREFIX, QUOTEPASS_TTL_S } from "./maker.js";
import { MAKER_BAND, MAKER_FULL_BAND, MAKER_INSIDE_C, MAKER_SIZE } from "./config.js";

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

// ── bothSides / full-range quoting (2026-07-29) ──────────────────────────────────────────────
test("bothSides=true returns BOTH the favorite and the underdog side across MAKER_FULL_BAND", () => {
  // favYes: yes 88 (favorite), no 16 (underdog). Under the favorite band only yes qualified;
  // full-range both-sides must now also quote the underdog no@15.
  const qs = computeMakerQuote(favYes, futureRow, NOW, MAKER_FULL_BAND, true);
  assert.ok(Array.isArray(qs));
  assert.equal(qs.length, 2);
  const yes = qs.find(q => q.side === "yes"), no = qs.find(q => q.side === "no");
  assert.equal(yes.ask, 88 - MAKER_INSIDE_C);
  assert.equal(no.ask, 16 - MAKER_INSIDE_C);
});

test("bothSides quotes a coin-flip market (both sides in full band) — the old floor rejected it", () => {
  const m = { yes_ask_dollars: "0.52", yes_bid_dollars: "0.48", no_ask_dollars: "0.52", no_bid_dollars: "0.48" };
  const qs = computeMakerQuote(m, futureRow, NOW, MAKER_FULL_BAND, true);
  assert.equal(qs.length, 2);
  // ...and the single-side default still rejects it (neither side in the [55,97] favorite band).
  assert.equal(computeMakerQuote(m, futureRow, NOW), null);
});

test("bothSides never quotes 0¢/negative on a very low underdog ask", () => {
  // yes 1 (would quote 0 → dropped), no 96 (favorite, quotes 95).
  const m = { yes_ask_dollars: "0.01", yes_bid_dollars: "0.01", no_ask_dollars: "0.96", no_bid_dollars: "0.94" };
  const qs = computeMakerQuote(m, futureRow, NOW, MAKER_FULL_BAND, true);
  assert.deepEqual(qs.map(q => q.side), ["no"]);
  assert.equal(qs[0].ask, 95);
});

test("bothSides still honors the shared gates (stale-ask, spread, pre-game) with []", () => {
  const stale = { yes_ask_dollars: "0.99", yes_bid_dollars: "0.90", no_ask_dollars: "0.05", no_bid_dollars: "0.01" };
  assert.deepEqual(computeMakerQuote(stale, futureRow, NOW, MAKER_FULL_BAND, true), []);
  assert.deepEqual(computeMakerQuote(favYes, pastRow, NOW, MAKER_FULL_BAND, true), []);
});

test("single-side default is unchanged — returns the favorite, never an array", () => {
  const q = computeMakerQuote(favYes, futureRow, NOW);
  assert.ok(!Array.isArray(q));
  assert.equal(q.side, "yes");
});

// ── Quote-pass telemetry ─────────────────────────────────────────────────────────────────────
// This is a tripwire for an outage that left no evidence (2026-08-12). A silently-wrong command
// shape would reproduce exactly that failure, so the shape is pinned rather than trusted.
const AT = "2026-08-13T14:00:00.000Z";
const KEY = `${QUOTEPASS_KEY_PREFIX}2026-08-13`;
const cmdFor = (cmds, verb, field) =>
  cmds.find(c => c[0] === verb && (field === undefined || c[2] === field));

test("quotePassTelemetryCommands: a healthy cycle increments ran + the sums", () => {
  const cmds = quotePassTelemetryCommands("2026-08-13",
    { eligible: 5486, opened: 120, closed: 98, kept: 5366, stagingPlays: 4181, stagingTickers: 2898 }, AT);
  assert.deepEqual(cmdFor(cmds, "HINCRBY", "cycles"), ["HINCRBY", KEY, "cycles", 1]);
  assert.deepEqual(cmdFor(cmds, "HINCRBY", "ran"), ["HINCRBY", KEY, "ran", 1]);
  assert.deepEqual(cmdFor(cmds, "HINCRBY", "sumEligible"), ["HINCRBY", KEY, "sumEligible", 5486]);
  assert.deepEqual(cmdFor(cmds, "HINCRBY", "sumOpened"), ["HINCRBY", KEY, "sumOpened", 120]);
  assert.deepEqual(cmdFor(cmds, "HINCRBY", "sumClosed"), ["HINCRBY", KEY, "sumClosed", 98]);
  // No skip/error counter may be touched on a healthy cycle.
  for (const f of ["skippedNoStaging", "skippedNoSnaps", "errors"]) {
    assert.equal(cmdFor(cmds, "HINCRBY", f), undefined, `${f} must not increment`);
  }
  const hset = cmdFor(cmds, "HSET");
  assert.equal(hset[hset.indexOf("lastOutcome") + 1], "ran");
  assert.equal(hset[hset.indexOf("lastEligible") + 1], "5486");
  assert.equal(hset[hset.indexOf("lastStagingTickers") + 1], "2898");
  // TTL must outlive the overnight window the 6am report reads.
  assert.deepEqual(cmds.at(-1), ["EXPIRE", KEY, QUOTEPASS_TTL_S]);
  assert.ok(QUOTEPASS_TTL_S >= 86400, "TTL must survive at least one night");
});

test("quotePassTelemetryCommands: each skip branch increments its OWN counter, never ran", () => {
  for (const [skipped, field] of [["no_staging", "skippedNoStaging"], ["no_snaps", "skippedNoSnaps"]]) {
    const cmds = quotePassTelemetryCommands("2026-08-13", { skipped }, AT);
    assert.deepEqual(cmdFor(cmds, "HINCRBY", field), ["HINCRBY", KEY, field, 1]);
    assert.deepEqual(cmdFor(cmds, "HINCRBY", "cycles"), ["HINCRBY", KEY, "cycles", 1]);
    assert.equal(cmdFor(cmds, "HINCRBY", "ran"), undefined, "a skipped cycle never counts as ran");
    assert.equal(cmdFor(cmds, "HINCRBY", "sumEligible"), undefined);
    const hset = cmdFor(cmds, "HSET");
    assert.equal(hset[hset.indexOf("lastOutcome") + 1], skipped);
  }
});

test("quotePassTelemetryCommands: an error cycle records the message", () => {
  const cmds = quotePassTelemetryCommands("2026-08-13", { error: "boom" }, AT);
  assert.deepEqual(cmdFor(cmds, "HINCRBY", "errors"), ["HINCRBY", KEY, "errors", 1]);
  assert.equal(cmdFor(cmds, "HINCRBY", "ran"), undefined);
  const hset = cmdFor(cmds, "HSET");
  assert.equal(hset[hset.indexOf("lastOutcome") + 1], "error");
  assert.equal(hset[hset.indexOf("lastError") + 1], "boom");
});

test("quotePassTelemetryCommands: counters are HINCRBY, never a read-modify-write GET/SET", () => {
  // The whole point of the hash is that overlapping cycles can't clobber each other.
  const cmds = quotePassTelemetryCommands("2026-08-13", { eligible: 1, opened: 0, closed: 0, kept: 1 }, AT);
  const verbs = new Set(cmds.map(c => c[0]));
  assert.ok(!verbs.has("GET") && !verbs.has("SET"), "no read-modify-write on the counter key");
  assert.deepEqual([...verbs].sort(), ["EXPIRE", "HINCRBY", "HSET"]);
});

test("quotePassTelemetryCommands: absent fields are omitted, not stringified to 'null'", () => {
  const cmds = quotePassTelemetryCommands("2026-08-13", { skipped: "no_staging" }, AT);
  const hset = cmdFor(cmds, "HSET");
  assert.ok(!hset.includes("null") && !hset.includes("undefined"));
  assert.equal(hset.indexOf("lastStagingTickers"), -1);
});
