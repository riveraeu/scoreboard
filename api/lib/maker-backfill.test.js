import { test } from "node:test";
import assert from "node:assert";
import { buildSamples, segmentsFromSamples, SAMPLE_STEP_MIN } from "./maker-backfill.js";
import { kalshiTickerGameTime, kalshiTickerDate } from "./kalshi-ticker.js";
import { MAKER_INSIDE_C, MAKER_SIZE } from "./config.js";

const GAME = Date.parse("2026-07-27T23:45:00Z");
const ROW = { gameTime: new Date(GAME).toISOString() };
const minutes = (n) => n * 60_000;

// One candlestick as Kalshi returns it: `end_period_ts` in SECONDS, prices as dollar strings.
const candle = (tsMs, yesBid, yesAsk) => ({
  end_period_ts: tsMs / 1000,
  yes_bid: { close_dollars: (yesBid / 100).toFixed(4) },
  yes_ask: { close_dollars: (yesAsk / 100).toFixed(4) },
});

// ── buildSamples ─────────────────────────────────────────────────────────────────────────────

test("derives the NO side off the YES BID, not the YES ask", () => {
  // The trap CLAUDE.md flags: 100 − yes_ask lands on the bid side and understates the NO ask by
  // the whole spread. Verified against live Kalshi books 2026-07-28.
  const [s] = buildSamples([candle(GAME - minutes(60), 84, 88)], { untilMs: GAME - minutes(60) });
  assert.equal(s.market.yes_ask, 88);
  assert.equal(s.market.yes_bid, 84);
  assert.equal(s.market.no_ask, 16); // 100 − 84
  assert.equal(s.market.no_bid, 12); // 100 − 88
});

test("carries the last close forward across candle gaps", () => {
  // Kalshi emits a candle only for periods with activity. A gap means "unchanged", not "no book".
  const samples = buildSamples([
    candle(GAME - minutes(30), 84, 88),
    candle(GAME - minutes(10), 86, 90),
  ], { untilMs: GAME - minutes(10) });
  assert.equal(samples.length, 11); // 30..10 before game, every 2 min, inclusive
  assert.equal(samples[0].market.yes_ask, 88);
  assert.equal(samples[5].market.yes_ask, 88);  // still inside the gap
  assert.equal(samples[10].market.yes_ask, 90); // the second candle has landed
});

test("samples on the live cron's 2-minute cadence", () => {
  const samples = buildSamples([candle(GAME - minutes(20), 84, 88)], { untilMs: GAME });
  assert.equal(SAMPLE_STEP_MIN, 2);
  for (let i = 1; i < samples.length; i++) {
    assert.equal(samples[i].tsMs - samples[i - 1].tsMs, minutes(2));
  }
});

test("extends the grid to game time so the pre-game gate is what closes the last segment", () => {
  const samples = buildSamples([candle(GAME - minutes(60), 84, 88)], { untilMs: GAME });
  assert.equal(samples[samples.length - 1].tsMs, GAME);
});

test("empty candles → no samples", () => {
  assert.deepEqual(buildSamples([], { untilMs: GAME }), []);
  assert.deepEqual(buildSamples(null, { untilMs: GAME }), []);
});

test("a 0 close is an absent quote and is passed through, not carried over", () => {
  // computeMakerQuote rejects a market with any side missing — same reason it rejects a live book
  // with an empty side. Inventing a price here would manufacture segments that never existed.
  const [s] = buildSamples([candle(GAME - minutes(30), 0, 88)], { untilMs: GAME - minutes(30) });
  assert.equal(s.market.yes_bid, 0);
  assert.equal(s.market.no_ask, 0);
});

// ── segmentsFromSamples ──────────────────────────────────────────────────────────────────────

test("one unchanged book → one segment quoted 1c inside the ask", () => {
  const samples = buildSamples([candle(GAME - minutes(30), 84, 88)], { untilMs: GAME - minutes(20) });
  const segs = segmentsFromSamples(samples, ROW);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].side, "yes");
  assert.equal(segs[0].ask, 88 - MAKER_INSIDE_C);
  assert.equal(segs[0].bookNoAsk, 16);
  assert.ok(segs[0].validTo, "every segment must close — an open segment would look live");
});

test("a price move opens a new segment and closes the old one at the same instant", () => {
  const samples = buildSamples([
    candle(GAME - minutes(30), 84, 88),
    candle(GAME - minutes(20), 86, 90),
  ], { untilMs: GAME - minutes(20) });
  const segs = segmentsFromSamples(samples, ROW);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].ask, 87);
  assert.equal(segs[1].ask, 89);
  assert.equal(segs[0].validTo, segs[1].validFrom, "no gap and no overlap between segments");
});

test("leaving the band closes the segment and opens nothing", () => {
  const samples = buildSamples([
    candle(GAME - minutes(30), 84, 88),
    candle(GAME - minutes(20), 48, 52), // coin flip — no in-band favorite
  ], { untilMs: GAME - minutes(20) });
  const segs = segmentsFromSamples(samples, ROW);
  assert.equal(segs.length, 1);
  assert.equal(Date.parse(segs[0].validTo), GAME - minutes(20));
});

test("nothing is quoted at or after game time", () => {
  // The pre-game gate is the whole reason gameTime has to come from the ticker. A segment running
  // past first pitch would be quoting in-play, which V1 has never done and never measured.
  const samples = buildSamples([candle(GAME - minutes(10), 84, 88)], { untilMs: GAME + minutes(30) });
  const segs = segmentsFromSamples(samples, ROW);
  assert.ok(segs.length >= 1);
  for (const s of segs) assert.ok(Date.parse(s.validTo) <= GAME, `${s.validTo} is past game time`);
});

test("a segment still open at the end of the grid is clamped to game time", () => {
  // The 2-min grid rarely lands on first pitch, so the last segment's tail overshoots unless it is
  // clamped — and a trade inside that overshoot is an IN-PLAY trade. Found replaying a real
  // 2026-07-27 market whose tail ran to 23:46 on a 23:45 game.
  const start = GAME - minutes(21); // 21 is odd, so the grid steps past GAME, never onto it
  const segs = segmentsFromSamples(buildSamples([candle(start, 84, 88)], { untilMs: GAME }), ROW);
  assert.equal(segs.length, 1);
  assert.equal(Date.parse(segs[0].validTo), GAME);
});

test("a wide book is rejected for the same reason the live path rejects it", () => {
  const samples = buildSamples([candle(GAME - minutes(30), 70, 88)], { untilMs: GAME - minutes(20) });
  assert.deepEqual(segmentsFromSamples(samples, ROW), []);
});

test("segments feed replayFills unchanged", () => {
  // The DB round-trip renames these to quote_side/quote_ask/valid_from/valid_to; this pins that the
  // pure shape carries every field that mapping needs.
  const [s] = segmentsFromSamples(
    buildSamples([candle(GAME - minutes(30), 84, 88)], { untilMs: GAME - minutes(20) }), ROW);
  for (const k of ["side", "ask", "validFrom", "validTo", "bookYesAsk", "bookYesBid", "bookNoAsk", "bookNoBid"]) {
    assert.ok(s[k] != null, `segment is missing ${k}`);
  }
  assert.ok(MAKER_SIZE > 0);
});

// ── kalshiTickerGameTime ─────────────────────────────────────────────────────────────────────

test("reads HHMM off an MLB prop ticker as ET", () => {
  // 19:45 ET on 2026-07-27 is EDT (UTC−4) → 23:45Z.
  assert.equal(
    kalshiTickerGameTime("KXMLBKS-26JUL271945CHCSTL-STLMLIBERATORE32-8"),
    "2026-07-27T23:45:00.000Z");
});

test("resolves the ET offset per date, not as a constant −4", () => {
  // 2026-03-08 is the US spring-forward. A fixed offset would put one of these an hour wrong.
  assert.equal(kalshiTickerGameTime("KXMLBKS-26MAR071310AAABBB-X"), "2026-03-07T18:10:00.000Z"); // EST −5
  assert.equal(kalshiTickerGameTime("KXMLBKS-26MAR091310AAABBB-X"), "2026-03-09T17:10:00.000Z"); // EDT −4
});

test("date-only tickers carry no game time", () => {
  // WNBA props, tennis, UFC, NBASL — out of backfill scope rather than guessed at.
  assert.equal(kalshiTickerGameTime("KXWNBAPTS-26JUL28NYLA"), null);
  assert.equal(kalshiTickerGameTime("KXATPMATCH-26JUN14HIJGIR"), null);
  assert.equal(kalshiTickerDate("KXWNBAPTS-26JUL28NYLA"), "2026-07-28", "date still parses");
});

test("rejects an out-of-range or over-long digit run rather than truncating it", () => {
  assert.equal(kalshiTickerGameTime("KXMLBKS-26JUL272599AAABBB-X"), null); // 25:99
  assert.equal(kalshiTickerGameTime("KXMLBKS-26JUL2719455AAABBB-X"), null); // 5 digits, not HHMM
  assert.equal(kalshiTickerGameTime("KXPGAH2H-MO26R4JKOIEGRI"), null);
  assert.equal(kalshiTickerGameTime(null), null);
});

test("midnight ET parses as the same calendar day", () => {
  // en-US hour12:false renders midnight as hour "24"; unnormalized that becomes a day-off error.
  assert.equal(kalshiTickerGameTime("KXMLBKS-26JUL270000AAABBB-X"), "2026-07-27T04:00:00.000Z");
});
