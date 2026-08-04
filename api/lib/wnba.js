// WNBA data fetchers. The per-stat model builders (pace / usage / injury / DVP) were deleted
// with the model teardown (2026-08-04); only buildWnbaByteam (scoreboard infra: scores/odds/
// top-players) + the registry re-exports remain.
//
// Exported:
//   buildWnbaByteam      — scoreboard hydration (wnbaGameScores/GameOdds/TopPlayers)
//   WNBA_TEAM_IDS        — canonical abbr → ESPN team id
//   WNBA_ESPN_TO_CANON   — ESPN-returned abbr → canonical (e.g. CONNECTICU→CONN)

// WNBA_TEAM_IDS / WNBA_ESPN_TO_CANON / WNBA_CANON_TO_ESPN are derived from the team
// registry (api/lib/teams.js) since 2026-06-11 and re-exported here for the historical
// import path. These are the ESPN *stats/injuries* endpoint forms (CONNECTICU, DALLAS,
// WAS, LAS) — NOT the /api/live scoreboard map (CANONICAL_TO_ESPN, also registry-derived).
// ESPN's /teams list endpoint is broken for WNBA, so the IDs are pinned in the registry.
import { WNBA_TEAM_IDS, WNBA_ESPN_TO_CANON, WNBA_CANON_TO_ESPN } from "./teams.js";
export { WNBA_TEAM_IDS, WNBA_ESPN_TO_CANON, WNBA_CANON_TO_ESPN };


// WNBA byteam hydration — now just the today+tomorrow scoreboard → wnbaGameScores (home/away).
// The defensive/scoring team-stat fetches + wnbaGameOdds/wnbaTopPlayers fed the deleted model +
// the deleted wnbaMeta block, so they're gone (model teardown, 2026-08-04).
import { parseGameScores as _pgs } from "./utils.js";

export async function buildWnbaByteam(cache, normTeamFn) {
  const _wd0 = new Date(Date.now() - 7 * 3600 * 1000); const _wd1 = new Date(_wd0); _wd1.setDate(_wd1.getDate() + 1);
  const _wfmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
  const _h = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
  const [sb0, sb1] = await Promise.all([
    fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${_wfmt(_wd0)}`, { headers: _h }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${_wfmt(_wd1)}`, { headers: _h }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  const eventsAll = [...(sb0.events || []), ...(sb1.events || [])];
  return { wnbaGameScores: _pgs(eventsAll, a => normTeamFn("wnba", a)) };
}
