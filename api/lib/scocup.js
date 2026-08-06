// api/lib/scocup.js
// Scottish League Cup — model-free maker candidate (KXSCOCUPSPREAD/KXSCOCUPTOTAL, adopted
// 2026-07-23). See project_scocup_spread_total_2026_07_23 memory: same "no probability model"
// doctrine as mls.js/brasileirao.js/nwsl.js/chnsl.js/ligamx.js, but a THRESHOLD market shape
// (spread/total), not 3-way ML — the first Phase-1 maker module of that shape.
//
// Data source — ESPN Scottish League Cup scoreboard (no auth, market-independent):
//   site.api.espn.com/apis/site/v2/sports/soccer/sco.cis/scoreboard
//
// TICKER-NAME TRAP (verified live 2026-07-23, NOT guessed): despite the "SCOCUP" ticker prefix,
// these markets are the Scottish LEAGUE Cup (ESPN slug sco.cis), NOT the Scottish Cup proper
// (sco.tennents, the FA-Cup equivalent) — the latter is dormant in July (next round starts
// ~September) and returns zero events for these tickers' dates. Confirmed by cross-referencing
// all 16 live event dates/teams: sco.tennents matched 0, sco.cis matched 16/16.
//
// Canonical team form = ESPN's OWN sco.cis abbr (not Kalshi's — see the scocup registry
// comment in teams.js for why: Kalshi reuses "DUN" for two different clubs across events).
// canonTeam is therefore the identity function; tonight/scocup.js resolves Kalshi-side team
// identity from each market's subtitle text via SCOCUP_NAME_TO_ESPN, never from the abbr.
//
// Thin wrapper over the shared ESPN-fetch engine in soccer-modelfree.js — see mls.js's header
// comment for why.

import { makeSoccerModelFreeSource } from "./soccer-modelfree.js";

const _src = makeSoccerModelFreeSource({ espnSlug: "sco.cis", canonTeam: (abbr) => abbr, cacheKeyPrefix: "scocup" });

export const getScoCupSchedule = _src.getSchedule;
