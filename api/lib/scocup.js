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
// SCHEDULE GAP, investigated 2026-08-10 — DO NOT RE-PROBE THE SLUG, it is correct.
// sco.cis returned 80 events across July 2026 (the group stage) and ZERO from 2026-08-01 onward,
// while Kalshi listed a real Round-2 slate for Aug 14-16 (mixed-tier ties like Stenhousemuir v
// Motherwell; the Premiership deliberately skips that weekend). Everything was checked:
//   • Every Scottish slug ESPN publishes — sco.1 / sco.2 / sco.challenge / sco.cis / sco.tennents /
//     sco.tennents_qual — carries none of that round (sco.challenge has one unrelated Challenge Cup
//     tie). Control slugs returned 18-33 events over the same window, so the queries were fine.
//   • ESPN's own season types for sco.cis DO include the knockout rounds
//     (Group Stage → 2026-08-15, "Round 2" 2026-08-15 → 2026-09-12, QF/SF/Final after), but
//     `/seasons/2026/types/14230/events` has count:0 — ESPN simply has not published the fixtures.
// So this is missing upstream DATA, not a wrong slug, and it self-heals once ESPN publishes: the
// scoreboard follows the current season type, which becomes Round 2 on Aug 15.
// The consequence while it lasts is narrow but silent — tonight/scocup.js resolves team identity
// from market SUBTITLES, so rows still emit; only `gameTime` goes null, which quietly makes them
// un-maker-quotable. `gameTimeNullBySport` in /api/tonight?debug=1 is the tripwire for exactly this.
// Deliberately NOT patched with a guessed kickoff: `expected_expiration_time` is post-game
// settlement (~2h after kickoff for soccer), and quoting off a guessed time is how the in-play
// off-by-one gets re-created. Detect, refuse to guess, defer.
//
// Thin wrapper over the shared ESPN-fetch engine in soccer-modelfree.js — see mls.js's header
// comment for why.

import { makeSoccerModelFreeSource } from "./soccer-modelfree.js";

const _src = makeSoccerModelFreeSource({ espnSlug: "sco.cis", canonTeam: (abbr) => abbr, cacheKeyPrefix: "scocup" });

export const getScoCupSchedule = _src.getSchedule;
