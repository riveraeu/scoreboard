// api/lib/nascar-schedule.js
// NASCAR (Cup) green-flag-time helper, extracted from nascar.js (2026-08-04) so it survives the
// model teardown. The recent-form finishing-position model was deleted; nascar|h2h / nascar|top10
// are now model-free maker capture, but the emit path still needs a real gameTime for
// computeMakerQuote's pre-game gate. Pure ESPN-core fetch/parse — no model math.
//
// Data source — ESPN core API (no auth): the season type-2 event list gives the full ~40-race Cup
// schedule (event id prefix = YYYYMMDD), and the per-event resource carries the green-flag time.

const CORE = "https://sports.core.api.espn.com/v2/sports/racing/leagues/nascar-premier";

async function _getJson(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

const _eventIdFromRef = (ref) => (String(ref || "").match(/\/events\/(\d+)/) || [])[1] || null;
const _dateDiffDays = (a, b) => {
  const d = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((d(a) - d(b)) / 86400000);
};

// Season schedule → [{ id, date:YYYYMMDD }]. Date parsed from the event id (no per-event fetch).
async function _seasonEvents(year) {
  const json = await _getJson(`${CORE}/seasons/${year}/types/2/events?limit=60`);
  return (json?.items || [])
    .map((it) => { const id = _eventIdFromRef(it?.$ref); return id ? { id, date: id.slice(0, 8) } : null; })
    .filter(Boolean);
}

async function _eventDate(eventId) {
  const json = await _getJson(`${CORE}/events/${eventId}`);
  return json?.date || null;
}

// The green-flag ISO time for the Cup race nearest dateStr (YYYYMMDD) within ±1 day (a night race
// rolls the close_time UTC date one day past the ESPN event date).
export async function fetchRaceGameTime(dateStr) {
  if (!dateStr || dateStr.length !== 8) return null;
  const events = await _seasonEvents(dateStr.slice(0, 4));
  if (!events.length) return null;
  let best = null, bestDiff = 2;
  for (const e of events) {
    const diff = Math.abs(_dateDiffDays(e.date, dateStr));
    if (diff <= 1 && diff < bestDiff) { best = e; bestDiff = diff; }
  }
  return best ? _eventDate(best.id) : null;
}

// Fetch + KV-cache one date's race green-flag time (6h TTL — schedules are set well in advance).
export async function getRaceGameTime(dateStr, { cache, isBustCache } = {}) {
  if (!dateStr) return null;
  const key = `nascar:gametime:${dateStr}`;
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const gameTime = await fetchRaceGameTime(dateStr);
  if (cache && gameTime) {
    try { await cache.put(key, JSON.stringify(gameTime), { expirationTtl: 21600 }); } catch {}
  }
  return gameTime;
}
