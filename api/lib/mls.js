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
//   site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard
//
// Thin wrapper (2026-07-23) over the shared ESPN-fetch engine in soccer-modelfree.js — the 4th
// model-free league (Chinese Super League) would have made this the 4th near-identical copy of
// the fetch/parse/schedule/resolve logic. All exported names unchanged so tonight.js/shadow.js
// imports don't need to change.
//
// COLLAPSED TO A SHIM 2026-07-28: the ESPN slug and the team mapping now live in the one
// `MODEL_FREE_LEAGUES` registry (api/lib/model-free-leagues.js) that six identical copies of this
// file used to each restate. This file remains only to keep its existing export NAMES stable —
// `club-soccer-threshold.js`, `handlers/shadow.js` and `teams.test.js` import them directly — so
// the generalization changed no call site outside the ML emit path.

import { leagueSource } from "./model-free-leagues.js";

const _src = leagueSource("mls");

export const mlsCanonTeam = _src.canonTeam;
export const getMlsSchedule = _src.getSchedule;
