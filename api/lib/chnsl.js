// api/lib/chnsl.js
// Chinese Super League — model-free maker candidate (KXCHNSLGAME, adopted 2026-07-23, 4th
// model-free league, same playbook as mls.js/brasileirao.js/nwsl.js). See
// project_maker_modelfree_clubsoccer_2026_07_23 memory: the maker strategy captures Kalshi's
// own favorite-ask mispricing directly, so this module carries NO probability model at all. It
// exists purely to supply two things the maker engine and resolver actually need:
//   1. A real gameTime per matchup — Kalshi's own market timestamps are NOT reliable kickoff
//      proxies on far-out listings.
//   2. Result resolution off the same ESPN scoreboard, including ties (soccer allows draws).
//
// Data source — ESPN Chinese Super League scoreboard (no auth, market-independent):
//   site.api.espn.com/apis/site/v2/sports/soccer/chn.1/scoreboard
//
// Thin wrapper over the shared ESPN-fetch engine in soccer-modelfree.js — see mls.js's header
// comment for why. This is the first league built directly onto the shared engine (MLS/
// Brasileirão/NWSL were refactored onto it in the same session).
//
// Team-mapping gotcha (verified live 2026-07-23, NOT guessed): Kalshi's own abbr "SHE" is
// Shenzhen Peng City, which would collide with ESPN's OWN "SHE" abbr — a DIFFERENT club,
// Shanghai Shenhua (team id 977). Kalshi disambiguates its three Shanghai/Shenzhen-area clubs
// as SHE (Shenzhen Peng City) / SHS (Shanghai Shenhua) / SHP (Shanghai Port) — none of which
// match ESPN's own SHE/SIPG scheme. The espnScore mapping below sends Kalshi SHE→ESPN SHX
// (Shenzhen's actual ESPN abbr) and Kalshi SHS→ESPN SHE (Shanghai Shenhua's ESPN abbr) — get
// this backwards and Shenzhen's games would silently resolve as Shanghai Shenhua's.
//
// COLLAPSED TO A SHIM 2026-07-28: the ESPN slug and the team mapping now live in the one
// `MODEL_FREE_LEAGUES` registry (api/lib/model-free-leagues.js) that six identical copies of this
// file used to each restate. This file remains only to keep its existing export NAMES stable —
// `club-soccer-threshold.js`, `handlers/shadow.js` and `teams.test.js` import them directly — so
// the generalization changed no call site outside the ML emit path.

import { leagueSource } from "./model-free-leagues.js";

const _src = leagueSource("chnsl");

export const chnslCanonTeam = _src.canonTeam;
export const parseChnslEvents = _src.parseEvents;
export const fetchChnslSchedule = _src.fetchSchedule;
export const getChnslSchedule = _src.getSchedule;
export const fetchChnslResults = _src.fetchResults;
