// api/lib/lmb-schedule.js
// LMB (Liga Mexicana de Béisbol) schedule/gameTime helper, extracted from lmb.js (2026-08-04) so it
// survives the model teardown. The run-rate λ model was deleted; lmb|ml is now model-free maker
// capture, but the emit path still needs a real gameTime for computeMakerQuote's pre-game gate.
// Pure MLB-statsapi fetch/parse — no model math. Keyed by statsapi team id via LMB_ID_TO_ABBR so
// statsapi↔Kalshi name drift never matters.

import { LMB_ID_TO_ABBR } from "./teams.js";

export const LMB_SPORT_ID = 23; // statsapi independent-league sport bucket (LMB ids filtered below)
const STATSAPI = "https://statsapi.mlb.com/api/v1";

// statsapi schedule (any status) → { "A|B" sorted pair : { date, home, away, gameTime } }.
// Doubleheader simplification: first game found for a pair wins — good enough for a pre-game
// eligibility gate, not exact precision.
export function parseLmbScheduleAny(games, target) {
  const out = {};
  for (const g of games || []) {
    const homeId = g?.teams?.home?.team?.id, awayId = g?.teams?.away?.team?.id;
    const home = LMB_ID_TO_ABBR[homeId], away = LMB_ID_TO_ABBR[awayId];
    if (!home || !away) continue; // sportId 23 carries other independent leagues — LMB ids only
    const key = [home, away].sort().join("|");
    if (out[key]) continue; // doubleheader: first game's time stands
    out[key] = { date: target, home, away, gameTime: g?.gameDate || null };
  }
  return out;
}

export async function fetchLmbSchedule(dateStr) {
  if (!dateStr || dateStr.length !== 8) return {};
  const target = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  try {
    const res = await fetch(`${STATSAPI}/schedule?sportId=${LMB_SPORT_ID}&date=${target}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const games = (data?.dates || []).flatMap(d => d?.games || []);
    return parseLmbScheduleAny(games, target);
  } catch { return {}; }
}

// Fetch + KV-cache one date's schedule (30min TTL).
export async function getLmbSchedule({ dateStr, cache, isBustCache } = {}) {
  if (!dateStr) return {};
  const key = `lmb:schedule:${dateStr}`;
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const schedule = await fetchLmbSchedule(dateStr);
  if (cache && schedule) {
    try { await cache.put(key, JSON.stringify(schedule), { expirationTtl: 1800 }); } catch {}
  }
  return schedule;
}
