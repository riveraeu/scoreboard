// api/lib/ligamx.js
// Liga MX (Mexico's top soccer division) — model-free maker candidate (KXLIGAMXGAME, adopted
// 2026-07-23, 5th model-free league, same playbook as mls.js/brasileirao.js/nwsl.js/chnsl.js).
// See project_maker_modelfree_clubsoccer_2026_07_23 memory: the maker strategy captures
// Kalshi's own favorite-ask mispricing directly, so this module carries NO probability model
// at all. It exists purely to supply two things the maker engine and resolver actually need:
//   1. A real gameTime per matchup — Kalshi's own market timestamps are NOT reliable kickoff
//      proxies on far-out listings.
//   2. Result resolution off the same ESPN scoreboard, including ties (soccer allows draws).
//
// Data source — ESPN Liga MX scoreboard (no auth, market-independent):
//   site.api.espn.com/apis/site/v2/sports/soccer/mex.1/scoreboard
//
// Thin wrapper over the shared ESPN-fetch engine in soccer-modelfree.js — see mls.js's header
// comment for why.
//
// Team-mapping gotcha (verified live 2026-07-23 via the ESPN mex.1 scoreboard, NOT guessed):
// Kalshi's own abbr "ATL" is Atlas, which would collide with ESPN's OWN "ATL" abbr — a
// DIFFERENT club, Atlante (id 226). Kalshi separately lists Atlante as "ALA". The espnScore
// mapping in teams.js sends Kalshi ATL→ESPN ATS (Atlas's real ESPN abbr) and Kalshi ALA→ESPN
// ATL (Atlante's ESPN abbr) — get this backwards and Atlas's games silently resolve as
// Atlante's, the same collision class found in chnsl.js's Shenzhen/Shanghai Shenhua mapping.

import { CANONICAL_TO_ESPN } from "./teams.js";
import { makeSoccerModelFreeSource } from "./soccer-modelfree.js";

// ESPN scoreboard abbr → canonical Liga MX abbr. Identity when unmapped.
const _ESPN_TO_CANON = Object.fromEntries(
  Object.entries(CANONICAL_TO_ESPN.ligamx || {}).map(([canon, espn]) => [espn, canon])
);
export const ligamxCanonTeam = (abbr) => _ESPN_TO_CANON[abbr] || abbr;

const _src = makeSoccerModelFreeSource({ espnSlug: "mex.1", canonTeam: ligamxCanonTeam, cacheKeyPrefix: "ligamx" });

export const parseLigaMxEvents = _src.parseEvents;
export const fetchLigaMxSchedule = _src.fetchSchedule;
export const getLigaMxSchedule = _src.getSchedule;
export const fetchLigaMxResults = _src.fetchResults;
