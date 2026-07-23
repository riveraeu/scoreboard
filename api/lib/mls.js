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

import { CANONICAL_TO_ESPN } from "./teams.js";
import { makeSoccerModelFreeSource } from "./soccer-modelfree.js";

// ESPN scoreboard abbr → canonical MLS abbr (DC→DCU, LA→LAG, RBNY→NYRB). Identity when unmapped.
const _ESPN_TO_CANON = Object.fromEntries(
  Object.entries(CANONICAL_TO_ESPN.mls || {}).map(([canon, espn]) => [espn, canon])
);
export const mlsCanonTeam = (abbr) => _ESPN_TO_CANON[abbr] || abbr;

const _src = makeSoccerModelFreeSource({ espnSlug: "usa.1", canonTeam: mlsCanonTeam, cacheKeyPrefix: "mls" });

export const parseMlsEvents = _src.parseEvents;
export const fetchMlsSchedule = _src.fetchSchedule;
export const getMlsSchedule = _src.getSchedule;
export const fetchMlsResults = _src.fetchResults;
