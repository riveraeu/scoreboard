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


// Full WNBA byteam hydration — same pattern as buildNbaByteam, with the 2025-season URLs.
import { parseGameOdds as _pgo, parseGameScores as _pgs, parseTopPlayers as _ptp } from "./utils.js";

export async function buildWnbaByteam(cache, normTeamFn) {
  const [d, scoringData, sbData] = await Promise.all([
    fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=20&category=defensive&seasontype=2&season=2025", {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
    }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=20&category=scoring&seasontype=2&season=2025", {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
    }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    (() => {
      const _wd0 = new Date(Date.now() - 7 * 3600 * 1000); const _wd1 = new Date(_wd0); _wd1.setDate(_wd1.getDate() + 1);
      const _wfmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
      const _h = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
      return Promise.all([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${_wfmt(_wd0)}`, { headers: _h }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${_wfmt(_wd1)}`, { headers: _h }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      ]).then(([sb0, sb1]) => ({ events: sb0.events || [], eventsAll: [...(sb0.events || []), ...(sb1.events || [])] }));
    })()
  ]);
  const wnba = d.teams || [];
  const wnbaScoring = scoringData.teams || [];
  const out = {
    wnba, wnbaScoring,
    wnbaGameOdds: _pgo(sbData.events || []),
    wnbaGameScores: _pgs(sbData.eventsAll || sbData.events || [], a => normTeamFn("wnba", a)),
    wnbaTopPlayers: _ptp(sbData.eventsAll || sbData.events || [], a => normTeamFn("wnba", a), "wnba"),
  };
  if (cache) {
    await cache.put("byteam:wnba", JSON.stringify(wnba), { expirationTtl: 21600 });
    await cache.put("byteam:wnba:scoring", JSON.stringify(wnbaScoring), { expirationTtl: 21600 });
  }
  return out;
}
