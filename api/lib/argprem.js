// api/lib/argprem.js
// Argentina Liga Profesional de Fútbol ("Argentina Premier Division" on Kalshi) — model-free
// maker candidate (KXARGPREMDIVGAME/SPREAD/TOTAL/BTTS, adopted 2026-07-24). Found via the
// 2141-row kalshi_series_seen baseline backlog sweep (project_baseline_backlog_2026_07_24
// memory), not the earlier two-track doctrine batch. Same "no probability model" playbook as
// mls.js/ligamx.js/etc.
//
// Data source — ESPN Argentina Liga Profesional scoreboard (no auth, market-independent):
//   site.api.espn.com/apis/site/v2/sports/soccer/arg.1/scoreboard
//
// Team-mapping gotchas (verified live 2026-07-24, NOT guessed):
//   1. Kalshi's "CAT" is Talleres Córdoba, colliding with ESPN's OWN "CAT" (Atlético Tucumán,
//      a different club) — same class as CHNSL's "SHE"/LigaMX's "ATL". Kalshi's code for
//      Tucumán is "TUC", mapped to ESPN's real "CAT" in the registry.
//   2. ESPN's OWN /teams endpoint reuses abbreviation "RIV" for TWO different clubs — River
//      Plate and Independiente Rivadavia (Kalshi correctly distinguishes them as "RIV"/"IRM").
//      A flat espnScore entry can't represent "two canonical codes share one ESPN abbr", so this
//      is resolved here via the team displayName soccer-modelfree.js threads through as
//      canonTeam's 2nd arg (added 2026-07-24 specifically for this case): "RIV" + a displayName
//      containing "Rivadavia" → canonical "IRM", everything else "RIV" → canonical "RIV".

import { CANONICAL_TO_ESPN } from "./teams.js";
import { makeSoccerModelFreeSource } from "./soccer-modelfree.js";

// ESPN scoreboard abbr → canonical Argentina Liga Profesional abbr. Identity when unmapped.
const _ESPN_TO_CANON = Object.fromEntries(
  Object.entries(CANONICAL_TO_ESPN.argprem || {}).map(([canon, espn]) => [espn, canon])
);
export const argPremCanonTeam = (abbr, displayName) => {
  if (abbr === "RIV") return (displayName || "").includes("Rivadavia") ? "IRM" : "RIV";
  return _ESPN_TO_CANON[abbr] || abbr;
};

const _src = makeSoccerModelFreeSource({ espnSlug: "arg.1", canonTeam: argPremCanonTeam, cacheKeyPrefix: "argprem" });

export const parseArgPremEvents = _src.parseEvents;
export const fetchArgPremSchedule = _src.fetchSchedule;
export const getArgPremSchedule = _src.getSchedule;
export const fetchArgPremResults = _src.fetchResults;
