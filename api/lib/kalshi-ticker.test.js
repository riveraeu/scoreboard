import test from "node:test";
import assert from "node:assert";
import { kalshiTickerDate } from "./kalshi-ticker.js";

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
