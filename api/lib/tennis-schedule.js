// api/lib/tennis-schedule.js
// Tennis (ATP + WTA) name-norm + schedule/gameTime helpers, extracted from tennis.js (2026-08-04)
// so they survive the model teardown. The ESPN-rankings logistic match-winner model was deleted;
// tennis|match is now model-free maker capture, but the emit path still needs a real gameTime for
// computeMakerQuote's pre-game gate and normalized player names to key the schedule pair. Pure
// fetch/parse — no model math.
//
// ESPN tennis "events" are TOURNAMENTS; individual matches live under
// event.groupings[].competitions[]. `?dates=YYYYMMDD` selects which tournaments are live.

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/tennis";

// Normalize a player name for matching: strip diacritics, lowercase, keep only letters/spaces.
export function normTennisName(name) {
  return (name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Every match on the tour's scoreboard for a tournament window (played or not) → keyed by sorted
// normalized player-pair "a|b", { gameTime (ISO) }. Keeps not-yet-played matches since the emit
// path needs an upcoming start time before the result exists.
export async function fetchTennisSchedule(tour, dateStr) {
  let json;
  try {
    const url = `${ESPN_BASE}/${tour}/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    json = await res.json();
  } catch { return {}; }
  const out = {};
  for (const ev of (json?.events || [])) {
    for (const grp of (ev?.groupings || [])) {
      for (const c of (grp?.competitions || [])) {
        const comps = c?.competitors || [];
        const players = comps.map((cm) => normTennisName((cm?.athlete || {}).displayName || "")).filter(Boolean);
        if (players.length !== 2) continue;
        const key = [...players].sort().join("|");
        if (!out[key]) out[key] = { gameTime: c?.date || null };
      }
    }
  }
  return out;
}

// Fetch + KV-cache one (tour, date)'s schedule (30min TTL).
export async function getTennisSchedule(tour, dateStr, { cache, isBustCache } = {}) {
  if (!dateStr) return {};
  const key = `tennis:schedule:${tour}:${dateStr}`;
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const schedule = await fetchTennisSchedule(tour, dateStr);
  if (cache && schedule) {
    try { await cache.put(key, JSON.stringify(schedule), { expirationTtl: 1800 }); } catch {}
  }
  return schedule;
}
