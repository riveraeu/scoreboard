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

// ET wall-clock reader, used to resolve the America/New_York UTC offset on a given instant.
// The offset is NOT a constant −4: it is −5 from early November to mid-March, and a game-time
// parse that assumed one or the other would be an hour wrong for half the year — which for the
// maker backfill's pre-game gate is the difference between quoting a market and quoting it in-play.
const _ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

// Minutes ET is offset from UTC at instant `ms` (−240 in EDT, −300 in EST).
function _etOffsetMinutes(ms) {
  const p = {};
  for (const part of _ET_PARTS.formatToParts(new Date(ms))) p[part.type] = part.value;
  // en-US hour12:false renders midnight as "24" — normalize before it becomes a day-off error.
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUtc - ms) / 60000;
}

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

/**
 * Extract the event's START TIME from a Kalshi ticker, for the series that encode one.
 *
 * Some series carry HHMM (ET) right after YYMONDD, others carry only the date:
 *   KXMLBKS-26JUL271945CHCSTL-...  → 2026-07-27T23:45:00.000Z  (19:45 ET)
 *   KXWNBAPTS-26JUL28NYLA          → null  (date only, no time)
 *
 * Added 2026-07-28 for the maker backfill (api/lib/maker-backfill.js), which reconstructs
 * historical quote segments straight from Kalshi and therefore has no shadow_plays row to read
 * `gameTime` from. `computeMakerQuote`'s pre-game gate needs a real start instant, so a series
 * whose ticker carries no HHMM is simply out of backfill scope rather than guessed at.
 *
 * @param {string} ticker e.g. "KXMLBKS-26JUL271945CHCSTL-STLMLIBERATORE32-8"
 * @returns {string|null} ISO-8601 UTC instant, or null when the ticker carries no HHMM.
 */
export function kalshiTickerGameTime(ticker) {
  const ymd = kalshiTickerDate(ticker);
  if (!ymd) return null;
  const seg = String(ticker || "").split("-")[1] || "";
  // (?!\d) so a longer digit run is treated as "not an HHMM" rather than silently truncated.
  const m = /^\d{2}[A-Za-z]{3}\d{2}(\d{2})(\d{2})(?!\d)/.exec(seg);
  if (!m) return null;
  const hh = +m[1], mm = +m[2];
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;

  // Read the wall clock as if it were UTC, then subtract the ET offset AT that instant. The
  // offset lookup needs an instant, and the only one available is the guess itself — so re-read
  // the offset once at the corrected instant, which resolves the case where the guess landed on
  // the far side of a DST transition from the true time.
  const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), hh, mm);
  const off1 = _etOffsetMinutes(guess);
  let ms = guess - off1 * 60000;
  const off2 = _etOffsetMinutes(ms);
  if (off2 !== off1) ms = guess - off2 * 60000;
  return new Date(ms).toISOString();
}
