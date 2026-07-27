// Kalshi ticker parsing — the ONE place that turns a ticker into its game date.
//
// Every Kalshi sports ticker carries the event's date in its second dash-segment as YYMONDD,
// optionally followed by an HHMM start time and the team/player codes:
//   KXMLBTOTAL-26JUL261410HOUCWS-14  → 2026-07-26 (14:10 ET)
//   KXATPMATCH-26JUN14HIJGIR         → 2026-06-14
//
// This is the ET game date, which is what shadow_plays.game_date means. It is authoritative:
// the ticker is issued by the venue and never drifts, unlike a snapshot-time fallback.
//
// NOTE (2026-07-27): tonight.js still has ~20 inline copies of this parse, one per league parse
// branch. They all work and are deliberately left alone here — migrating them is a separate
// refactor. New code should import this.

const KALSHI_MONTHS = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/**
 * Extract the ET game date from a Kalshi ticker or event_ticker.
 * @param {string} ticker e.g. "KXMLBTOTAL-26JUL261410HOUCWS-14"
 * @returns {string|null} "YYYY-MM-DD", or null when the ticker carries no parseable date.
 */
export function kalshiTickerDate(ticker) {
  const seg = String(ticker || "").split("-")[1] || "";
  const m = /^(\d{2})([A-Za-z]{3})(\d{2})/.exec(seg);
  if (!m) return null;
  const mo = KALSHI_MONTHS[m[2].toUpperCase()];
  if (!mo) return null;
  const day = parseInt(m[3], 10);
  if (!(day >= 1 && day <= 31)) return null; // guard against a code segment masquerading as a date
  return `20${m[1]}-${mo}-${m[3]}`;
}
