import test from "node:test";
import assert from "node:assert";
import { kalshiTickerDate, kalshiTickerGameTime } from "./kalshi-ticker.js";

test("kalshiTickerDate — real tickers across sports", () => {
  // The three markets whose null game_date caused the 2026-07-27 cross-day mis-grade.
  assert.equal(kalshiTickerDate("KXMLBTOTAL-26JUL261410HOUCWS-14"), "2026-07-26");
  assert.equal(kalshiTickerDate("KXMLBTOTAL-26JUL261335CHCPIT-13"), "2026-07-26");
  assert.equal(kalshiTickerDate("KXMLBTOTAL-26JUL261335AZWSH-15"), "2026-07-26");
  // teamTotal, and a ticker with no HHMM segment.
  assert.equal(kalshiTickerDate("KXMLBTEAMTOTAL-26JUL242215LAASF-SF8"), "2026-07-24");
  assert.equal(kalshiTickerDate("KXATPMATCH-26JUN14HIJGIR"), "2026-06-14");
});

test("kalshiTickerDate — accepts an event_ticker as well as a market ticker", () => {
  assert.equal(kalshiTickerDate("KXMLBTOTAL-26JUL271945CHCSTL"), "2026-07-27");
  assert.equal(kalshiTickerDate("KXMLBTOTAL-26JUL271945CHCSTL-9"), "2026-07-27");
});

test("kalshiTickerDate — every month parses", () => {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  months.forEach((mon, i) => {
    assert.equal(kalshiTickerDate(`KXTEST-26${mon}05ABCDEF`), `2026-${String(i + 1).padStart(2, "0")}-05`);
  });
});

test("kalshiTickerGameTime — KXLMBGAME, pinned against statsapi", () => {
  // lmb-ml.js falls back to the ticker when statsapi's sportId=23 slate omits a game Kalshi has
  // already listed. These three are the 2026-08-11 LMB slate; the first was cross-checked against
  // statsapi's own gameDate for that matchup and agreed to the minute (4/4 across the day's games
  // that both sources carried). 3-char team codes, no player suffix — a shape not otherwise pinned.
  assert.equal(kalshiTickerGameTime("KXLMBGAME-26AUG112145CALADM-CAL"), "2026-08-12T01:45:00.000Z");
  assert.equal(kalshiTickerGameTime("KXLMBGAME-26AUG112130SDMCDJ-SDM"), "2026-08-12T01:30:00.000Z");
  assert.equal(kalshiTickerGameTime("KXLMBGAME-26AUG112100PDCPDP-PDP"), "2026-08-12T01:00:00.000Z");
  // The emit path passes an event_ticker (no side suffix); it must parse identically.
  assert.equal(kalshiTickerGameTime("KXLMBGAME-26AUG112130SDMCDJ"), "2026-08-12T01:30:00.000Z");
});

test("kalshiTickerGameTime — ET offset resolves per date, never a constant", () => {
  // EDT (−4) vs EST (−5): a constant offset would be an hour wrong for half the year.
  assert.equal(kalshiTickerGameTime("KXMLBKS-26JUL271945CHCSTL-X"), "2026-07-27T23:45:00.000Z");
  assert.equal(kalshiTickerGameTime("KXTEST-26JAN151945ABCDEF"), "2026-01-16T00:45:00.000Z");
});

test("kalshiTickerGameTime — null for a date-only ticker rather than a guessed midnight", () => {
  assert.equal(kalshiTickerGameTime("KXWNBAPTS-26JUL28NYLA"), null);
  assert.equal(kalshiTickerGameTime("KXATPMATCH-26JUN14HIJGIR"), null);
  assert.equal(kalshiTickerGameTime("KXMLBTOTAL-HOUCWS"), null); // no date at all
  assert.equal(kalshiTickerGameTime("KXTEST-26JUL052599ABC"), null); // impossible HHMM
});

test("kalshiTickerDate — returns null rather than guessing", () => {
  // Failure-closed: a bad parse must not produce a date the resolver would grade against.
  assert.equal(kalshiTickerDate(null), null);
  assert.equal(kalshiTickerDate(""), null);
  assert.equal(kalshiTickerDate("KXMLBTOTAL"), null);              // no second segment
  assert.equal(kalshiTickerDate("KXMLBTOTAL-HOUCWS"), null);        // segment isn't a date
  assert.equal(kalshiTickerDate("KXMLBTOTAL-26XXX26HOUCWS"), null); // unknown month
  assert.equal(kalshiTickerDate("KXMLBTOTAL-26JUL99HOUCWS"), null); // impossible day
  assert.equal(kalshiTickerDate("KXMLBTOTAL-26JUL00HOUCWS"), null);
});
