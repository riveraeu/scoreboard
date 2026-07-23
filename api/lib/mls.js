// api/lib/mls.js
// MLS (Major League Soccer) — model-free maker candidate (KXMLSGAME, adopted 2026-07-23).
// See project_maker_modelfree_clubsoccer_2026_07_23 memory: the maker strategy captures
// Kalshi's own favorite-ask mispricing directly, so this module carries NO probability model
// at all. It exists purely to supply two things the maker engine and resolver actually need:
//   1. A real gameTime per matchup — Kalshi's own market timestamps (close_time,
//      expiration_time) are NOT reliable kickoff proxies on far-out listings (found
//      2026-07-23: every other Phase-1 shadow-only module hardcodes gameTime:null and is
//      therefore silently never maker-quotable, since computeMakerQuote's pre-game gate
//      requires a real future timestamp). This module fetches the real kickoff from ESPN.
//   2. Result resolution off the same ESPN scoreboard, including ties (soccer allows draws,
//      unlike the binary nba-summer/lmb game-winner markets).
//
// Data source — ESPN MLS scoreboard (no auth, market-independent):
//   site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard?dates=YYYYMMDD-YYYYMMDD

import { CANONICAL_TO_ESPN } from "./teams.js";

const MLS_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard";

// ESPN scoreboard abbr → canonical MLS abbr (DC→DCU, LA→LAG, RBNY→NYRB). Identity when unmapped.
const _ESPN_TO_CANON = Object.fromEntries(
  Object.entries(CANONICAL_TO_ESPN.mls || {}).map(([canon, espn]) => [espn, canon])
);
export const mlsCanonTeam = (abbr) => _ESPN_TO_CANON[abbr] || abbr;

const _ptDate = (iso) => {
  try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
  catch { return null; }
};

async function _mlsScoreboard(datesParam) {
  try {
    const res = await fetch(`${MLS_SCOREBOARD}?dates=${datesParam}&limit=100`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return (await res.json())?.events || [];
  } catch { return []; }
}

// Every event on the scoreboard (played or not) → [{ date (PT), gameTime (ISO kickoff), home,
// away, homeScore, awayScore, completed }] canonical abbrs. Pure given events; exported for
// tests. Unlike nba-summer/lmb's parse, ties are kept (soccer allows draws) and incomplete
// games are kept too (the emit path needs an upcoming kickoff time, not just finished ones).
export function parseMlsEvents(events) {
  const out = [];
  for (const ev of (events || [])) {
    const comp = ev?.competitions?.[0];
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    const hAbbr = mlsCanonTeam(home?.team?.abbreviation || "");
    const aAbbr = mlsCanonTeam(away?.team?.abbreviation || "");
    if (!hAbbr || !aAbbr) continue;
    const completed = !!comp?.status?.type?.completed;
    const hs = Number(home?.score), as = Number(away?.score);
    out.push({
      date: _ptDate(ev.date), gameTime: ev.date || null,
      home: hAbbr, away: aAbbr,
      homeScore: completed && hs >= 0 ? hs : null,
      awayScore: completed && as >= 0 ? as : null,
      completed,
    });
  }
  return out;
}

// Games (any status) on a PT date (dateStr YYYYMMDD), keyed by sorted canonical pair "A|B"
// (Kalshi ticker order ≠ ESPN home/away). Fetches a 2-day UTC window so evening kickoffs that
// roll past midnight UTC still land on their PT date. Same 2-day-window idiom as nba-summer's
// fetchSlResults / lmb's fetchLmbResults.
export async function fetchMlsSchedule(dateStr) {
  if (!dateStr || dateStr.length !== 8) return {};
  const target = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  const next = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8) + 1));
  const nextYmd = `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, "0")}${String(next.getUTCDate()).padStart(2, "0")}`;
  const games = parseMlsEvents(await _mlsScoreboard(`${dateStr}-${nextYmd}`));
  const out = {};
  for (const g of games) {
    if (g.date !== target) continue;
    out[[g.home, g.away].sort().join("|")] = g;
  }
  return out;
}

// Fetch + KV-cache one date's schedule (30min TTL — game times are set well in advance and
// essentially never change, but this keeps a live-day's emit passes from re-fetching on every
// tonight.js invocation). Used by the emit path (api/lib/tonight/club-soccer-ml.js) for a real
// gameTime; the resolver below re-fetches directly (uncached — resolution runs a few times a
// night, not worth the KV round-trip).
export async function getMlsSchedule({ dateStr, cache, isBustCache } = {}) {
  if (!dateStr) return {};
  const key = `mls:schedule:${dateStr}`;
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const schedule = await fetchMlsSchedule(dateStr);
  if (cache && schedule) {
    try { await cache.put(key, JSON.stringify(schedule), { expirationTtl: 1800 }); } catch {}
  }
  return schedule;
}

// ── Resolution ──────────────────────────────────────────────────────────────
// Completed games only, same sorted-pair key. Ties resolve with homeScore === awayScore —
// the shadow.js resolution block grades pick_team === "TIE" rows off that, mirroring WC
// soccer's 1X2 grading (see handlers/shadow.js's soccerRows block).
export async function fetchMlsResults(dateStr) {
  const all = await fetchMlsSchedule(dateStr);
  const out = {};
  for (const [k, g] of Object.entries(all)) if (g.completed) out[k] = g;
  return out;
}
