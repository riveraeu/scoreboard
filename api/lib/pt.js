// Shared PT (Pacific Time) date utilities. Hoisted out of api/[...path].js so handler
// modules can reuse the same formatter without re-instantiating per request.

export const PT_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });

// Given a "YYYY-MM-DD" PT date, return the prior day in the same format. Returns null on
// invalid input. Used by B2B detection to pivot off the game's date, not today's date.
export const ptDateMinusOne = (ymd) => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
};
