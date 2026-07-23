// api/lib/nwsl.js
// NWSL (National Women's Soccer League) — model-free maker candidate (KXNWSLGAME, adopted
// 2026-07-23, 3rd model-free league, same playbook as mls.js/brasileirao.js). See
// project_maker_modelfree_clubsoccer_2026_07_23 memory: the maker strategy captures Kalshi's
// own favorite-ask mispricing directly, so this module carries NO probability model at all. It
// exists purely to supply two things the maker engine and resolver actually need:
//   1. A real gameTime per matchup — Kalshi's own market timestamps are NOT reliable kickoff
//      proxies on far-out listings.
//   2. Result resolution off the same ESPN scoreboard, including ties (soccer allows draws).
//
// Data source — ESPN NWSL scoreboard (no auth, market-independent):
//   site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard
//
// Thin wrapper (2026-07-23) over the shared ESPN-fetch engine in soccer-modelfree.js — see
// mls.js's header comment for why. All exported names unchanged.

import { CANONICAL_TO_ESPN } from "./teams.js";
import { makeSoccerModelFreeSource } from "./soccer-modelfree.js";

// ESPN scoreboard abbr → canonical NWSL abbr (WAS→WSP, SD→SAN, SEA→REI, UTA→URO, NC→NCC,
// POR→PTH, GFC→GOT, ORL→OPR, HOU→HDA). Identity when unmapped.
const _ESPN_TO_CANON = Object.fromEntries(
  Object.entries(CANONICAL_TO_ESPN.nwsl || {}).map(([canon, espn]) => [espn, canon])
);
export const nwslCanonTeam = (abbr) => _ESPN_TO_CANON[abbr] || abbr;

const _src = makeSoccerModelFreeSource({ espnSlug: "usa.nwsl", canonTeam: nwslCanonTeam, cacheKeyPrefix: "nwsl" });

export const parseNwslEvents = _src.parseEvents;
export const fetchNwslSchedule = _src.fetchSchedule;
export const getNwslSchedule = _src.getSchedule;
export const fetchNwslResults = _src.fetchResults;
