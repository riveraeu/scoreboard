// api/lib/brasileirao.js
// Brasileirão Série A (Brazil's top soccer division) — model-free maker candidate
// (KXBRASILEIROGAME, adopted 2026-07-23). See project_maker_modelfree_clubsoccer_2026_07_23
// memory: the maker strategy captures Kalshi's own favorite-ask mispricing directly, so this
// module carries NO probability model at all — same playbook as mls.js, one league later. It
// exists purely to supply two things the maker engine and resolver actually need:
//   1. A real gameTime per matchup — Kalshi's own market timestamps are NOT reliable kickoff
//      proxies on far-out listings.
//   2. Result resolution off the same ESPN scoreboard, including ties (soccer allows draws).
//
// Data source — ESPN Brasileirão scoreboard (no auth, market-independent):
//   site.api.espn.com/apis/site/v2/sports/soccer/bra.1/scoreboard
//
// Thin wrapper (2026-07-23) over the shared ESPN-fetch engine in soccer-modelfree.js — see
// mls.js's header comment for why. All exported names unchanged.
//
// COLLAPSED TO A SHIM 2026-07-28: the ESPN slug and the team mapping now live in the one
// `MODEL_FREE_LEAGUES` registry (api/lib/model-free-leagues.js) that six identical copies of this
// file used to each restate. This file remains only to keep its existing export NAMES stable —
// `club-soccer-threshold.js`, `handlers/shadow.js` and `teams.test.js` import them directly — so
// the generalization changed no call site outside the ML emit path.

import { leagueSource } from "./model-free-leagues.js";

const _src = leagueSource("brasileirao");

export const brasileiraoCanonTeam = _src.canonTeam;
export const parseBrasileiraoEvents = _src.parseEvents;
export const fetchBrasileiraoSchedule = _src.fetchSchedule;
export const getBrasileiraoSchedule = _src.getSchedule;
export const fetchBrasileiraoResults = _src.fetchResults;
