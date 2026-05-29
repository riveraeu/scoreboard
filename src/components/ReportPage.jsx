import React from 'react';
import { SPORT_KEY, TEAM_DB } from '../lib/constants.js';
import Tip from './Tip.jsx';

const _teamShort = (abbr, sport) => {
  if (!abbr) return abbr;
  const entry = TEAM_DB.find(t => t.abbr === abbr && t.sport === sport) || TEAM_DB.find(t => t.abbr === abbr);
  return entry?.short ?? abbr;
};

// Sport + play-type catalog. Each entry maps a single dropdown selection to:
//   - tabId      → calibration / Model Reference content key
//   - statKeys   → MarketReport rows whose `m.stat` belong to this play type
// NBA "Props" rolls four stat keys (pts/reb/ast/3p) into one Model entry, mirroring
// TAB_CAT's merged calibration bucket. Totals/teamTotals split over/under at render
// time inside the Market tab — they're still one selection here.
const PLAY_TYPES = {
  mlb: [
    { id: "mlb-k",        label: "Strikeouts",        statKeys: ["strikeouts"] },
    { id: "mlb-hrr",      label: "H+R+RBI",           statKeys: ["hrr"] },
    { id: "mlb-gt",       label: "Game Total",        statKeys: ["totalRuns"] },
    { id: "mlb-tt",       label: "Team Total",        statKeys: ["teamRuns"] },
    { id: "mlb-ml",       label: "Moneyline",         statKeys: ["ml"] },
    { id: "mlb-spread",   label: "Spread",            statKeys: ["spread"] },
    { id: "mlb-f5total",  label: "F5 Total",          statKeys: ["f5total"] },
    { id: "mlb-f5spread", label: "F5 Spread",         statKeys: ["f5spread"] },
    { id: "mlb-f5ml",     label: "F5 ML (3-way)",     statKeys: ["f5ml"] },
  ],
  nba: [
    { id: "nba",          label: "Props (Pts/Reb/Ast/3P)", statKeys: ["points", "rebounds", "assists", "threePointers"] },
    { id: "nba-gt",       label: "Game Total",        statKeys: ["totalPoints"] },
    { id: "nba-tt",       label: "Team Total",        statKeys: ["teamPoints"] },
    { id: "nba-ml",       label: "Moneyline",         statKeys: ["ml"] },
    { id: "nba-spread",   label: "Spread",            statKeys: ["spread"] },
    { id: "nba-1htotal",  label: "1H Total",          statKeys: ["h1total"] },
    { id: "nba-1hspread", label: "1H Spread",         statKeys: ["h1spread"] },
    { id: "nba-1hml",     label: "1H ML (3-way)",     statKeys: ["h1ml"] },
    { id: "nba-2htotal",  label: "2H Total",          statKeys: ["h2total"] },
    { id: "nba-2hspread", label: "2H Spread",         statKeys: ["h2spread"] },
    { id: "nba-2hml",     label: "2H ML (3-way)",     statKeys: ["h2ml"] },
  ],
  wnba: [
    { id: "wnba-ml",       label: "Moneyline",        statKeys: ["ml"] },
    { id: "wnba-spread",   label: "Spread",           statKeys: ["spread"] },
    { id: "wnba-1htotal",  label: "1H Total",         statKeys: ["h1total"] },
    { id: "wnba-1hspread", label: "1H Spread",        statKeys: ["h1spread"] },
    { id: "wnba-1hml",     label: "1H ML (3-way)",    statKeys: ["h1ml"] },
    { id: "wnba-2htotal",  label: "2H Total",         statKeys: ["h2total"] },
    { id: "wnba-2hspread", label: "2H Spread",        statKeys: ["h2spread"] },
    { id: "wnba-2hml",     label: "2H ML (3-way)",    statKeys: ["h2ml"] },
  ],
  nhl: [
    { id: "nhl",         label: "Points (Player)",    statKeys: ["points"] },
    { id: "nhl-gt",      label: "Game Total",         statKeys: ["totalGoals"] },
    { id: "nhl-ml",      label: "Moneyline",          statKeys: ["ml"] },
    { id: "nhl-spread",  label: "Spread",             statKeys: ["spread"] },
  ],
};
const SPORTS = ["mlb", "nba", "wnba", "nhl"];

function _findPlayType(sport, id) {
  return PLAY_TYPES[sport].find(p => p.id === id) || PLAY_TYPES[sport][0];
}

function buildSimTooltip(m) {
  const isTeamTotal = m.gameType === "teamTotal";
  const isKPlay  = m.finalSimScore != null && m.totalSimScore == null && !isTeamTotal;
  const isHRR    = m.hitterFinalSimScore != null && m.finalSimScore == null && !isTeamTotal;
  const isNBA    = m.nbaSimScore != null && m.totalSimScore == null && !isTeamTotal;
  const isWNBA   = m.wnbaSimScore != null && m.totalSimScore == null && !isTeamTotal;
  const isNHL    = m.nhlSimScore != null && m.totalSimScore == null && !isTeamTotal;

  if (isKPlay) {
    return [
      `CSW%/K%: ${m.kpctPts??1}/2`,
      `Lineup K%: ${m.lkpPts??1}/2`,
      `Hit Rate %: ${m.kHitRatePts??1}/2`,
      `H2H Hand: ${m.kH2HHandPts??1}/2`,
      `O/U: ${m.totalPts??1}/2`,
    ].join('\n');
  }
  if (isHRR) {
    return [
      `OPS: ${m.hitterOpsPts??1}/2`,
      `WHIP: ${m.hitterWhipPts??1}/2`,
      `Season HR: ${m.hitterSeasonHitRatePts??1}/2`,
      `H2H HR: ${m.hitterH2HHitRatePts??1}/2`,
      `O/U: ${m.hitterTotalPts??1}/2`,
    ].join('\n');
  }
  if (isNBA) {
    const dvpPts = m.dvpRatio >= 1.05 ? 2 : m.dvpRatio >= 1.02 ? 1 : 0;
    const ouPts5 = m.nbaTotalPts ?? 1;
    let c1Label, c1Pts;
    if (m.stat === 'rebounds') {
      const v = m.nbaOpportunity;
      c1Pts = v == null ? 1 : v >= 30 ? 2 : v >= 25 ? 1 : 0;
      c1Label = `AvgMin ${v != null ? v.toFixed(0) + 'm' : '—'}`;
    } else {
      const u = m.nbaUsage;
      c1Pts = u == null ? 1 : u >= 28 ? 2 : u >= 22 ? 1 : 0;
      c1Label = `USG% ${u != null ? u.toFixed(1) + '%' : '—'}`;
    }
    return [
      `${c1Label}: ${c1Pts}/2`,
      `DVP: ${dvpPts}/2`,
      `Season HR: ${m.nbaSeasonHitRatePts??1}/2`,
      `Tier HR: ${m.nbaSoftHitRatePts??1}/2`,
      `Game Total: ${ouPts5}/2`,
    ].join('\n');
  }
  if (isWNBA) {
    const dvpPts = m.dvpRatio >= 1.05 ? 2 : m.dvpRatio >= 1.02 ? 1 : 0;
    const ouPts5 = m.wnbaTotalPts ?? 1;
    let c1Label, c1Pts;
    if (m.stat === 'rebounds') {
      const v = m.wnbaOpportunity;
      c1Pts = v == null ? 1 : v >= 27 ? 2 : v >= 22 ? 1 : 0;
      c1Label = `AvgMin ${v != null ? v.toFixed(0) + 'm' : '—'}`;
    } else {
      const u = m.wnbaUsage;
      c1Pts = u == null ? 1 : u >= 27 ? 2 : u >= 22 ? 1 : 0;
      c1Label = `USG% ${u != null ? u.toFixed(1) + '%' : '—'}`;
    }
    return [
      `${c1Label}: ${c1Pts}/2`,
      `DVP: ${dvpPts}/2`,
      `Season HR: ${m.wnbaSeasonHitRatePts??1}/2`,
      `Tier HR: ${m.wnbaSoftHitRatePts??1}/2`,
      `Game Total: ${ouPts5}/2`,
    ].join('\n');
  }
  if (isNHL) {
    const toi = m.nhlOpportunity;
    const toiPts = toi >= 18 ? 2 : toi >= 15 ? 1 : toi != null ? 0 : 1;
    const gaaRank = m.posDvpRank;
    const gaaPts = gaaRank == null ? 1 : gaaRank <= 10 ? 2 : gaaRank <= 15 ? 1 : 0;
    const nhlTotal = m.nhlGameTotal;
    const nhlTotalPts = nhlTotal == null ? 1 : nhlTotal >= 7 ? 2 : nhlTotal >= 5.5 ? 1 : 0;
    return [
      `TOI ${toi?.toFixed(1) ?? '—'}m: ${toiPts}/2`,
      `GAA rank: ${gaaPts}/2`,
      `Season HR: ${m.nhlSeasonHitRatePts??1}/2`,
      `DVP HR: ${m.nhlDvpHitRatePts??1}/2`,
      `O/U ${nhlTotal ?? '—'}: ${nhlTotalPts}/2`,
    ].join('\n');
  }
  if (isTeamTotal) {
    const isU = m.direction === "under";
    const h2hPts = isU
      ? (m.h2hHitRate == null ? 1 : m.h2hHitRate <= 30 ? 2 : m.h2hHitRate <= 50 ? 1 : 0)
      : (m.h2hHitRatePts ?? 1);
    if (m.sport === "mlb") {
      const ssnPts = isU
        ? (m.ttSeasonHitRate == null ? 1 : m.ttSeasonHitRate <= 20 ? 2 : m.ttSeasonHitRate <= 40 ? 1 : 0)
        : (m.ttSeasonHitRatePts ?? 1);
      const whipPts = isU
        ? (m.oppWHIP == null ? 1 : m.oppWHIP <= 1.10 ? 2 : m.oppWHIP <= 1.25 ? 1 : 0)
        : (m.ttWhipPts ?? 1);
      const l10Pts = isU
        ? (m.teamL10RPG == null ? 1 : m.teamL10RPG <= 3.5 ? 2 : m.teamL10RPG <= 4.5 ? 1 : 0)
        : (m.ttL10Pts ?? 1);
      const ou = m.gameOuLine;
      const ouPts = ou == null ? 1 : isU ? (ou < 7.5 ? 2 : ou < 9.5 ? 1 : 0) : (ou >= 9.5 ? 2 : ou >= 7.5 ? 1 : 0);
      return [
        `${isU ? "[Under SimScore]\n" : ""}Ssn HR% (${m.ttSeasonHitRate != null ? m.ttSeasonHitRate + '%' : '—'}): ${ssnPts}/2`,
        `${m.oppTeam} WHIP (${m.oppWHIP != null ? m.oppWHIP.toFixed(2) : '—'}): ${whipPts}/2`,
        `${m.scoringTeam} L10 RPG (${m.teamL10RPG != null ? m.teamL10RPG.toFixed(1) : '—'}): ${l10Pts}/2`,
        `H2H HR% (${m.h2hHitRate != null ? m.h2hHitRate + '%' : '—'}${m.h2hGames ? ' · ' + m.h2hGames + 'g' : ''}): ${h2hPts}/2`,
        `O/U (${ou ?? '—'}): ${ouPts}/2`,
      ].join('\n');
    }
    if (m.sport === "nba") {
      const rtgPts = v => v == null ? 1 : isU ? (v < 113 ? 2 : v < 118 ? 1 : 0) : (v >= 118 ? 2 : v >= 113 ? 1 : 0);
      const ou = m.gameOuLine;
      const ouPts = ou == null ? 1 : isU ? (ou < 215 ? 2 : ou < 225 ? 1 : 0) : (ou >= 225 ? 2 : ou >= 215 ? 1 : 0);
      const ssnHR = m.ttNbaSeasonHitRate;
      const ssnPts = m.ttNbaSeasonHitRatePts ?? (ssnHR == null ? 1 : isU ? (ssnHR <= 20 ? 2 : ssnHR <= 40 ? 1 : 0) : (ssnHR >= 80 ? 2 : ssnHR >= 60 ? 1 : 0));
      return [
        `${isU ? "[Under SimScore]\n" : ""}${m.scoringTeam} OffRtg (${m.teamOffRtg != null ? m.teamOffRtg.toFixed(1) : '—'}): ${rtgPts(m.teamOffRtg)}/2`,
        `${m.oppTeam} DefRtg (${m.oppDefRtg != null ? m.oppDefRtg.toFixed(1) : '—'}): ${rtgPts(m.oppDefRtg)}/2`,
        `Ssn HR% (${ssnHR != null ? ssnHR + '%' : '—'}): ${ssnPts}/2`,
        `H2H HR% (${m.h2hHitRate != null ? m.h2hHitRate + '%' : '—'}${m.h2hGames ? ' · ' + m.h2hGames + 'g' : ''}): ${h2hPts}/2`,
        `O/U (${ou ?? '—'}): ${ouPts}/2`,
      ].join('\n');
    }
    return null;
  }
  if (m.totalSimScore != null) {
    if (m.sport === "mlb") {
      const hW = m.homeWHIP, aW = m.awayWHIP, ou = m.gameOuLine;
      const cRPG = m.combinedRPG, h2hTR = m.h2hTotalHitRate;
      const isU = m.direction === "under";
      const whipPts = v => v == null ? 1 : isU ? (v <= 1.10 ? 2 : v <= 1.25 ? 1 : 0) : (v > 1.35 ? 2 : v > 1.20 ? 1 : 0);
      const cRPGPts = cRPG == null ? 1 : isU ? (cRPG < 8.5 ? 2 : cRPG <= 10.5 ? 1 : 0) : (cRPG >= 10.5 ? 2 : cRPG >= 8.5 ? 1 : 0);
      const h2hPts = h2hTR == null ? 1 : isU ? (h2hTR <= 20 ? 2 : h2hTR <= 40 ? 1 : 0) : (h2hTR >= 80 ? 2 : h2hTR >= 60 ? 1 : 0);
      const ouPts = ou == null ? 1 : isU ? (ou < 7.5 ? 2 : ou < 9.5 ? 1 : 0) : (ou >= 9.5 ? 2 : ou >= 7.5 ? 1 : 0);
      return [
        `${isU ? "[Under SimScore]\n" : ""}Comb road RPG (${cRPG != null ? cRPG.toFixed(1) : '—'}): ${cRPGPts}/2`,
        `${m.homeTeam} WHIP (${hW != null ? hW.toFixed(2) : '—'}): ${whipPts(hW)}/2`,
        `${m.awayTeam} WHIP (${aW != null ? aW.toFixed(2) : '—'}): ${whipPts(aW)}/2`,
        `H2H HR% (${h2hTR != null ? h2hTR + '%' : '—'}${m.h2hTotalGames ? ' · ' + m.h2hTotalGames + 'g' : ''}): ${h2hPts}/2`,
        `O/U (${ou ?? '—'}): ${ouPts}/2`,
      ].join('\n');
    }
    if (m.sport === "nba") {
      const cOR = m.combOffRtg, cDR = m.combDefRtg, ou = m.gameOuLine;
      const hp = m.homePace, ap = m.awayPace, lgP = m.leagueAvgPace, pp = m.projPace;
      const isU = m.direction === "under";
      const rtgPts = v => v == null ? 1 : isU ? (v < 113 ? 2 : v < 118 ? 1 : 0) : (v >= 118 ? 2 : v >= 113 ? 1 : 0);
      const ouPts = v => v == null ? 1 : isU ? (v < 215 ? 2 : v < 225 ? 1 : 0) : (v >= 225 ? 2 : v >= 215 ? 1 : 0);
      const pacePts = (hp == null || ap == null || lgP == null) ? 1
        : isU ? ((hp < lgP - 2 && ap < lgP - 2) ? 2 : (hp < lgP || ap < lgP) ? 1 : 0)
        : ((hp > lgP + 2 && ap > lgP + 2) ? 2 : (hp > lgP || ap > lgP) ? 1 : 0);
      const gtH2H = m.nbaGtH2HRate;
      const gtH2HPts = gtH2H == null ? 1 : isU ? (gtH2H <= 30 ? 2 : gtH2H <= 50 ? 1 : 0) : (gtH2H >= 80 ? 2 : gtH2H >= 60 ? 1 : 0);
      return [
        `${isU ? "[Under SimScore]\n" : ""}Pace (proj ${pp ?? '—'}): ${pacePts}/2`,
        `Comb OffRtg (${cOR != null ? cOR.toFixed(1) : '—'}): ${rtgPts(cOR)}/2`,
        `Comb DefRtg (${cDR != null ? cDR.toFixed(1) : '—'}): ${rtgPts(cDR)}/2`,
        `H2H HR% (${gtH2H != null ? gtH2H + '%' : '—'}): ${gtH2HPts}/2`,
        `O/U (${ou ?? '—'}): ${ouPts(ou)}/2`,
      ].join('\n');
    }
    if (m.sport === "nhl") {
      const hGPG = m.homeGPG, aGPG = m.awayGPG, hGAA = m.homeGAA, aGAA = m.awayGAA, ou = m.gameOuLine;
      const isU = m.direction === "under";
      const gpgPts = v => v == null ? 1 : isU ? (v < 3.0 ? 2 : v < 3.5 ? 1 : 0) : (v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0);
      const gaaPts = v => v == null ? 1 : isU ? (v < 3.0 ? 2 : v < 3.5 ? 1 : 0) : (v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0);
      const ouPts = v => v == null ? 1 : isU ? (v < 5.5 ? 2 : v < 7 ? 1 : 0) : (v >= 7 ? 2 : v >= 5.5 ? 1 : 0);
      return [
        `${isU ? "[Under SimScore]\n" : ""}${m.homeTeam} GPG (${hGPG ?? '—'}): ${gpgPts(hGPG)}/2`,
        `${m.awayTeam} GPG (${aGPG ?? '—'}): ${gpgPts(aGPG)}/2`,
        `${m.homeTeam} GAA (${hGAA ?? '—'}): ${gaaPts(hGAA)}/2`,
        `${m.awayTeam} GAA (${aGAA ?? '—'}): ${gaaPts(aGAA)}/2`,
        `O/U (${ou ?? '—'}): ${ouPts(ou)}/2`,
      ].join('\n');
    }
    if (m.sport === "wnba") {
      const cOR = m.combOffRtg, cDR = m.combDefRtg, ou = m.gameOuLine;
      const hp = m.homePace, ap = m.awayPace, lgP = m.leagueAvgPace, pp = m.projPace;
      const isU = m.direction === "under";
      const rtgPts = v => v == null ? 1 : isU ? (v < 93 ? 2 : v < 98 ? 1 : 0) : (v >= 98 ? 2 : v >= 93 ? 1 : 0);
      const ouPts = v => v == null ? 1 : isU ? (v < 158 ? 2 : v < 168 ? 1 : 0) : (v >= 168 ? 2 : v >= 158 ? 1 : 0);
      const pacePts = (hp == null || ap == null || lgP == null) ? 1
        : isU ? ((hp < lgP - 1 && ap < lgP - 1) ? 2 : (hp < lgP || ap < lgP) ? 1 : 0)
        : ((hp > lgP + 1 && ap > lgP + 1) ? 2 : (hp > lgP || ap > lgP) ? 1 : 0);
      const gtH2H = m.wnbaGtH2HRate;
      const gtH2HPts = gtH2H == null ? 1 : isU ? (gtH2H <= 30 ? 2 : gtH2H <= 50 ? 1 : 0) : (gtH2H >= 80 ? 2 : gtH2H >= 60 ? 1 : 0);
      return [
        `${isU ? "[Under SimScore]\n" : ""}Pace (proj ${pp ?? '—'}): ${pacePts}/2`,
        `Comb OffRtg (${cOR != null ? cOR.toFixed(1) : '—'}): ${rtgPts(cOR)}/2`,
        `Comb DefRtg (${cDR != null ? cDR.toFixed(1) : '—'}): ${rtgPts(cDR)}/2`,
        `H2H HR% (${gtH2H != null ? gtH2H + '%' : '—'}): ${gtH2HPts}/2`,
        `O/U (${ou ?? '—'}): ${ouPts(ou)}/2`,
      ].join('\n');
    }
  }
  return null;
}

const DC_PENALTY_GROUP = {
  kalshiStale: "freshness", lowVolume: "freshness", wideSpread: "freshness",
  mlbLineupNotConfirmed: "lineup", mlbLineupUnknown: "lineup",
  nbaLineupNotPosted: "lineup", nbaBench: "lineup", noLineupData: "lineup",
  playerOut: "availability", playerQuestionable: "availability",
  noStdBF: "sample", highStdBF: "sample",
  tinyBvPSample: "sample", smallBvPSample: "sample", modestBvPSample: "sample",
  tinySoftSample: "sample", smallSoftSample: "sample", noSoftGames: "sample",
  noSeasonSample: "sample", tinySeasonSample: "sample", smallSeasonSample: "sample",
  noH2HSample: "sample", tinyH2HSample: "sample", smallH2HSample: "sample",
  noOppLineupKPct: "oppData", oppLineupProjected: "oppData",
  noBvPSource: "oppData", handednessOnly: "oppData",
  noOppMetric: "oppData", noDvpRatio: "oppData", noDvpRatioStructural: "oppData",
  noOppRank: "oppData", noGameOuLine: "oppData",
  noOppWhipSource: "oppData", oppWhipTeamFallback: "oppData", noOppDefRtg: "oppData",
  noHomeWhipSource: "oppData", homeWhipTeamFallback: "oppData",
  noAwayWhipSource: "oppData", awayWhipTeamFallback: "oppData",
  modestlyFromLine: "distance", farFromLine: "distance",
};
function dcGroupTotal(m, group) {
  const pens = m.dcPenalties || {};
  let total = 0;
  let labels = [];
  for (const [k, v] of Object.entries(pens)) {
    if (DC_PENALTY_GROUP[k] === group) { total += v; labels.push(`${k} ${v}`); }
  }
  return { total, labels };
}

// Tab → calibration category key(s). Multi-cat entries (e.g. nba) merge buckets.
const TAB_CAT = {
  "mlb-k":   ["mlb|strikeouts"],
  "mlb-hrr": ["mlb|hrr"],
  "nba":     ["nba|points","nba|rebounds","nba|assists","nba|threePointers"],
  "nhl":     ["nhl|points"],
  "mlb-gt":  ["mlb|totalRuns"],
  "nba-gt":  ["nba|totalPoints"],
  "nhl-gt":  ["nhl|totalGoals"],
  "mlb-tt":  ["mlb|teamRuns"],
  "nba-tt":  ["nba|teamPoints"],
  "mlb-ml":  ["mlb|ml"],
  "mlb-spread": ["mlb|spread"],
  "mlb-f5total":  ["mlb|f5total"],
  "mlb-f5spread": ["mlb|f5spread"],
  "mlb-f5ml":     ["mlb|f5ml"],
  "nba-1htotal":  ["nba|h1total"],
  "nba-1hspread": ["nba|h1spread"],
  "nba-1hml":     ["nba|h1ml"],
  "nba-2htotal":  ["nba|h2total"],
  "nba-2hspread": ["nba|h2spread"],
  "nba-2hml":     ["nba|h2ml"],
  "wnba-1htotal":  ["wnba|h1total"],
  "wnba-1hspread": ["wnba|h1spread"],
  "wnba-1hml":     ["wnba|h1ml"],
  "wnba-2htotal":  ["wnba|h2total"],
  "wnba-2hspread": ["wnba|h2spread"],
  "wnba-2hml":     ["wnba|h2ml"],
  "nba-ml":  ["nba|ml"],
  "nba-spread": ["nba|spread"],
  "wnba-ml": ["wnba|ml"],
  "wnba-spread": ["wnba|spread"],
  "nhl-ml":  ["nhl|ml"],
  "nhl-spread": ["nhl|spread"],
};

// Module-scope shared style + atoms (lifted from old ModelPage so `content` can be
// declared inline inside the render with no closure capture).
const s = {
  card: { background:"#161b22", border:"1px solid #30363d", borderRadius:10, padding:"14px 18px", marginBottom:12 },
  h2:   { color:"#c9d1d9", fontSize:14, fontWeight:700, marginBottom:3 },
  sub:  { color:"#8b949e", fontSize:11, marginBottom:10 },
  h3:   { color:"#58a6ff", fontSize:12, fontWeight:700, marginTop:10, marginBottom:5 },
  p:    { color:"#c9d1d9", fontSize:12, lineHeight:1.65, marginBottom:8 },
  dim:  { color:"#484f58" },
  mono: { fontFamily:"monospace", background:"rgba(88,166,255,0.08)", borderRadius:4, padding:"1px 5px", fontSize:11 },
  green:{ color:"#3fb950" },
  yellow:{ color:"#e3b341" },
  red:  { color:"#f78166" },
  blue: { color:"#58a6ff" },
};
const Section = ({ title, children }) => (
  <div style={s.card}>
    <div style={s.h2}>{title}</div>
    {children}
  </div>
);
const Formula = ({ children }) => (
  <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:8,padding:"10px 14px",
    fontFamily:"monospace",fontSize:12,color:"#c9d1d9",lineHeight:1.8,marginBottom:10,whiteSpace:"pre-wrap"}}>
    {children}
  </div>
);
const InputRow = ({ name, color="#c9d1d9", why, tooltip }) => (
  <div style={{display:"flex",gap:10,marginBottom:5,alignItems:"flex-start"}}>
    <div style={{minWidth:190,flexShrink:0,color:color,fontSize:11,fontWeight:600,paddingTop:1}}>
      {name}{tooltip && <span title={tooltip} style={{marginLeft:4,color:"#484f58",fontWeight:400,cursor:"help"}}>ⓘ</span>}
    </div>
    <div style={{color:"#8b949e",fontSize:11,lineHeight:1.55}}>{why}</div>
  </div>
);
const ScoreRow = ({ pts, name, tiers, why }) => (
  <div style={{display:"flex",gap:10,marginBottom:6,alignItems:"flex-start"}}>
    <div style={{minWidth:30,flexShrink:0,color:"#e3b341",fontSize:11,fontWeight:700,paddingTop:1}}>{pts}</div>
    <div style={{flex:1}}>
      <div style={{color:"#c9d1d9",fontSize:11,fontWeight:600,marginBottom:2}}>{name}</div>
      <div style={{color:"#8b949e",fontSize:10,marginBottom:2}}>{tiers}</div>
      <div style={{color:"#484f58",fontSize:10,lineHeight:1.5}}>{why}</div>
    </div>
  </div>
);

function mergeBuckets(arrays) {
  const LABELS = ["70-75","75-80","80-85","85-90","90-95","95+"];
  const PREDICTED = [72.5, 77.5, 82.5, 87.5, 92.5, 97.5];
  return LABELS.map((label, i) => {
    let wins = 0, n = 0;
    for (const arr of arrays) {
      const b = arr.find(x => x.bucket === label);
      if (b) { wins += Math.round((b.actual ?? 0) / 100 * b.n); n += b.n; }
    }
    const actual = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
    return { bucket: label, predicted: PREDICTED[i], actual, n, delta: actual != null ? parseFloat((actual - PREDICTED[i]).toFixed(1)) : null };
  });
}
const deltaColor = d => d == null ? "#8b949e" : d >= 3 ? "#3fb950" : d <= -3 ? "#f78166" : "#e3b341";
const barW = pct => pct != null ? `${Math.min(100, pct)}%` : "0%";
const thCalib = { padding:"5px 10px", color:"#6e7681", fontSize:11, fontWeight:600, textAlign:"left", borderBottom:"1px solid #21262d", whiteSpace:"nowrap" };
const tdCalib = { padding:"5px 10px", fontSize:11, borderBottom:"1px solid #161b22" };

function CalibModule({ tabId, calibData, calibLoading, fetchCalib, authToken }) {
  const cats = TAB_CAT[tabId] || [];
  const isKTab = tabId === "mlb-k";

  if (!authToken) return (
    <div style={{...s.card, marginTop:8}}>
      <div style={{color:"#484f58", fontSize:12}}>Log in to see calibration data for this model.</div>
    </div>
  );
  if (calibLoading) return (
    <div style={{...s.card, marginTop:8}}>
      <div style={{color:"#8b949e", fontSize:12}}>Loading calibration data…</div>
    </div>
  );
  if (!calibData || calibData.error) return (
    <div style={{...s.card, marginTop:8}}>
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between"}}>
        <div style={{color:"#484f58", fontSize:12}}>{calibData?.error ? `Error: ${calibData.error}` : "Calibration data not yet loaded."}</div>
        <button onClick={fetchCalib} style={{fontSize:11,padding:"3px 10px",borderRadius:6,cursor:"pointer",border:"1px solid #30363d",background:"transparent",color:"#8b949e"}}>Load</button>
      </div>
    </div>
  );

  const { byCategoryDetail, kStrikeouts } = calibData;
  const catArrays = cats.map(c => byCategoryDetail?.[c]).filter(Boolean);
  const bucketRows = catArrays.length > 0 ? mergeBuckets(catArrays) : [];
  const catTotals = cats.reduce((acc, c) => {
    const d = calibData.byCategory?.[c];
    if (d) { acc.n += d.n; acc.wins += Math.round(d.hitRate / 100 * d.n); }
    return acc;
  }, { n: 0, wins: 0 });
  const catHitRate = catTotals.n > 0 ? (catTotals.wins / catTotals.n * 100).toFixed(1) : null;
  const hasData = catTotals.n > 0;

  return (
    <div style={{...s.card, marginTop:8}}>
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:hasData?12:0}}>
        <div style={{display:"flex", alignItems:"center", gap:10}}>
          <span style={{color:"#c9d1d9", fontSize:13, fontWeight:700}}>Calibration</span>
          {hasData && <span style={{background:"#21262d", color:"#8b949e", fontSize:11, borderRadius:10, padding:"1px 8px"}}>{catTotals.n} picks</span>}
          {hasData && catHitRate && (
            <span style={{color: parseFloat(catHitRate)>=70?"#3fb950":parseFloat(catHitRate)>=60?"#e3b341":"#f78166", fontSize:12, fontWeight:600}}>{catHitRate}% hit rate</span>
          )}
        </div>
        <button onClick={fetchCalib} style={{fontSize:11,padding:"3px 10px",borderRadius:6,cursor:"pointer",border:"1px solid #30363d",background:"transparent",color:"#8b949e"}}>↻</button>
      </div>

      {!hasData ? (
        <div style={{color:"#484f58", fontSize:12}}>No finalized picks yet for this category.</div>
      ) : (
        <>
          <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d",marginBottom:isKTab?14:0}}>
            <thead><tr>{["Bucket","N","Predicted","Actual","Delta",""].map(h=><th key={h} style={thCalib}>{h}</th>)}</tr></thead>
            <tbody>
              {bucketRows.map(b => (
                <tr key={b.bucket}>
                  <td style={tdCalib}><span style={{color:"#c9d1d9"}}>{b.bucket}%</span></td>
                  <td style={{...tdCalib, color:b.n<5?"#484f58":b.n<10?"#6e7681":"#c9d1d9"}}>{b.n||"—"}</td>
                  <td style={{...tdCalib, color:"#8b949e"}}>{b.predicted.toFixed(1)}%</td>
                  <td style={{...tdCalib, color:b.actual==null?"#484f58":b.actual>=70?"#3fb950":b.actual>=60?"#e3b341":"#f78166"}}>{b.actual!=null?`${b.actual}%`:"—"}</td>
                  <td style={{...tdCalib, color:deltaColor(b.delta)}}>{b.delta!=null?(b.delta>=0?`+${b.delta}`:b.delta):"—"}</td>
                  <td style={{...tdCalib, width:120}}>
                    {b.actual!=null&&(
                      <div style={{position:"relative",height:7,background:"#21262d",borderRadius:4,overflow:"hidden"}}>
                        <div style={{position:"absolute",left:0,top:0,height:"100%",width:barW(b.actual),background:b.actual>=70?"#3fb950":b.actual>=60?"#e3b341":"#f78166",borderRadius:4}}/>
                        <div style={{position:"absolute",left:`${b.predicted}%`,top:0,height:"100%",width:2,background:"#58a6ff",opacity:0.8}}/>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {isKTab && kStrikeouts && kStrikeouts.n > 0 && (
            <div style={{display:"flex", gap:10, flexWrap:"wrap"}}>
              {[
                { title:"By SimScore", data:kStrikeouts.bySimScore, keyLabel:"Score" },
                { title:"By K% Tier", data:kStrikeouts.byKpctPts, keyLabel:"Pts" },
                { title:"By K-Trend", data:kStrikeouts.byKTrendPts, keyLabel:"Pts" },
                ...(kStrikeouts.byStdBF ? [{ title:"By stdBF", data:kStrikeouts.byStdBF, keyLabel:"BF Var", keyColor: k => k==="low"?"#3fb950":k==="high"?"#f78166":"#8b949e" }] : []),
              ].map(({title,data,keyLabel,keyColor}) => (
                <div key={title} style={{flex:"1 1 130px",background:"#0d1117",border:"1px solid #21262d",borderRadius:8,overflow:"hidden"}}>
                  <div style={{color:"#8b949e",fontSize:11,fontWeight:600,padding:"5px 10px",borderBottom:"1px solid #21262d"}}>{title}</div>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr>
                      <th style={{...thCalib,padding:"4px 8px"}}>{keyLabel}</th>
                      <th style={{...thCalib,padding:"4px 8px"}}>N</th>
                      <th style={{...thCalib,padding:"4px 8px"}}>Hit%</th>
                    </tr></thead>
                    <tbody>
                      {Object.entries(data).map(([k,d])=>(
                        <tr key={k}>
                          <td style={{...tdCalib,padding:"4px 8px",color:keyColor?keyColor(k):"#c9d1d9"}}>{k}</td>
                          <td style={{...tdCalib,padding:"4px 8px",color:d.n<5?"#6e7681":"#c9d1d9"}}>{d.n}</td>
                          <td style={{...tdCalib,padding:"4px 8px",color:d.hitRate>=70?"#3fb950":d.hitRate>=60?"#e3b341":"#f78166",fontWeight:600}}>{d.hitRate}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- MarketReport row rendering ----------------------------------------------------
// Renders a single (sport, stat[, direction]) group as a header + sortable table.
// Lifted intact from the old MarketReport.jsx — the helper closures, xcell switch,
// COL_TIPS/RESULT_LABELS, and sort/dedup pipeline are unchanged.

const REPORT_SPORT_COL = { mlb:"#4ade80", nba:"#f97316", wnba:"#fbbf24", nhl:"#60a5fa" };
const STAT_NAME = { points:"Points",rebounds:"Rebounds",assists:"Assists",threePointers:"3-Pointers",goals:"Goals",hits:"Hits",hrr:"H+R+RBI",strikeouts:"Strikeouts",totalRuns:"Game Totals",totalPoints:"Totals",totalGoals:"Totals",teamRuns:"Team Runs",teamPoints:"Team Points",ml:"Moneyline",spread:"Spread",f5total:"F5 Total",f5spread:"F5 Spread",f5ml:"F5 ML",h1total:"1H Total",h1spread:"1H Spread",h1ml:"1H ML",h2total:"2H Total",h2spread:"2H Spread",h2ml:"2H ML" };

function MarketGroupSection({ group, reportSort, setReportSort, navigateToPlayer, navigateToTeam, onClose }) {
  const { sport, stat, direction, items } = group;
  const _isTotalsType = (stat === "totalRuns" || stat === "totalPoints" || stat === "totalGoals" || stat === "teamRuns" || stat === "teamPoints");

  // Dedupe by playerName|threshold (or homeTeam|awayTeam|threshold for totals), prefer qualified
  const dedupeMap = {};
  for (const m of items) {
    const k = m.gameType === "teamTotal"
      ? `${m.scoringTeam}|${m.oppTeam}|${m.threshold}${m.direction === "under" ? "|under" : ""}`
      : m.gameType === "total"
      ? `${m.homeTeam}|${m.awayTeam}|${m.threshold}${m.direction === "under" ? "|under" : ""}`
      : m.gameType === "ml"
      ? `${m.pickTeam}|${m.oppTeam}`
      : m.gameType === "spread"
      ? `${m.pickTeam}|${m.oppTeam}|${m.pickLine}`
      : `${m.playerName}|${m.threshold}`;
    if (!dedupeMap[k] || (!dedupeMap[k].qualified && m.qualified)) dedupeMap[k] = m;
  }
  const _groupKey = direction ? `${sport}|${stat}|${direction}` : `${sport}|${stat}`;
  const _sortCfg = reportSort[`${sport}|${stat}`];
  const rows = Object.values(dedupeMap).sort((a, b) => {
    if (_sortCfg) {
      const _sv = m => { switch(_sortCfg.col) {
        case "player": return m.playerName ?? `${m.awayTeam}${m.homeTeam}` ?? "";
        case "line": return m.gameType === "spread" ? (m.pickLine ?? 0) : (m.threshold ?? 0);
        case "true": return m.truePct ?? 0;
        case "kalshi": return m.kalshiPct ?? 0;
        case "edge": return m.edge ?? 0;
        case "opp": return m.opponent ?? "";
        case "season": return m.seasonPct ?? 0;
        case "h2h": return m.softPct ?? 0;
        case "era": return m.hitterPitcherEra ?? m.pitcherEra ?? 999;
        case "ba": return m.hitterBa ?? 0;
        case "ml": return m.hitterMoneyline ?? m.gameMoneyline ?? 0;
        case "ab": return m.hitterAbVsPitcher ?? 0;
        case "csw": return m.pitcherCSWPct ?? m.pitcherKPct ?? 0;
        case "pkp": return m.pitcherKPct ?? 0;
        case "kbb": return m.pitcherKBBPct ?? 0;
        case "kH2HHand": return m.kH2HHandRate ?? -1;
        case "pps": return m.pitcherAvgPitches ?? 0;
        case "lkp": return m.lineupKPct ?? 0;
        case "spot": return m.hitterLineupSpot ?? 99;
        case "whip": return m.pitcherWHIP ?? 0;
        case "plat": return m.hitterSplitBA ?? 0;
        case "fip": return m.pitcherFIP ?? 0;
        case "ou": return m.gameTotal ?? 0;
        case "dvp": return m.posDvpRank ?? m.oppRank ?? 99;
        case "sim": return (direction === "under" ? (m.underSimScore ?? m.teamTotalSimScore ?? m.totalSimScore) : (m.teamTotalSimScore ?? m.totalSimScore)) ?? m.finalSimScore ?? m.hitterFinalSimScore ?? m.nbaSimScore ?? 0;
        case "dc": return m.dataConfidence ?? 0;
        case "dcMkt": return dcGroupTotal(m, "freshness").total;
        case "dcLineup": return dcGroupTotal(m, "lineup").total;
        case "dcAvail": return dcGroupTotal(m, "availability").total;
        case "dcSample": return dcGroupTotal(m, "sample").total;
        case "dcOppData": return dcGroupTotal(m, "oppData").total;
        case "dcDist": return dcGroupTotal(m, "distance").total;
        case "env": return m.parkFactor ?? m.hitterParkKF ?? 1;
        case "brrl": return m.hitterBarrelPct ?? 0;
        case "nbapace": return m.nbaPaceAdj ?? -99;
        case "nbaopp": return m.nbaOpportunity ?? 0;
        case "nba_b2b": return m.isB2B ? 0 : 1;
        case "nbaC1": return m.stat==="rebounds" ? (m.nbaOpportunity??0) : (m.nbaUsage??0);
        case "nbaOu": return m.nbaGameTotal ?? 0;
        case "nbaSeasonHR": return m.seasonPct ?? -1;
        case "nbaSoftHR": return m.softPct ?? -1;
        case "nbaPaceTotal": return m.nbaTotalPts ?? 1;
        case "nba_spread": return m.nbaBlowoutAdj ?? 0;
        case "mlbOu": return m.gameOuLine ?? m.hitterGameTotal ?? 0;
        case "kHitRate": return m.blendedHitRate ?? 0;
        case "ops": return m.hitterOps ?? 0;
        case "hQuality": return m.hitterBatterQualityPts ?? 0;
        case "hSsnHR": return m.seasonPct ?? 0;
        case "hH2HHR": return m.softPct ?? 0;
        case "ttH2HHR": return m.h2hHitRate ?? 0;
        case "ttTeamRPG": return m.teamRPG ?? 0;
        case "ttOppERA": return m.oppERA ?? 999;
        case "ttOppRPG": return m.oppRPG ?? 0;
        case "ttPark": return m.parkFactor ?? 1;
        case "ttWhip": return m.oppWHIP ?? 999;
        case "ttL10RPG": return m.teamL10RPG ?? 0;
        case "ttOu": return m.gameOuLine ?? 0;
        case "ttTeamOff": return m.teamOff ?? 0;
        case "ttOppDef": return m.oppDef ?? 0;
        case "ttPace": return (m.teamPace??0) - (m.leagueAvgPace??0);
        case "ttSpread": return Math.abs(m.gameSpread ?? 99);
        case "nhlSeasonHR": return m.seasonPct ?? 0;
        case "nhlDvpHR": return m.softPct ?? 0;
        case "nhlGameTotalOu": return m.nhlGameTotal ?? 0;
        case "nbaCombOff": return m.combOffRtg ?? 0;
        case "nbaCombDef": return m.combDefRtg ?? 0;
        case "nbaGtH2H": return m.nbaGtH2HRate ?? -1;
        case "ttNbaOff": return m.teamOffRtg ?? 0;
        case "ttNbaDef": return m.oppDefRtg ?? 0;
        case "ttNbaSsnHR": return m.ttNbaSeasonHitRate ?? -1;
        case "combinedRPG": case "umpire":
        case "homeRPG": case "awayRPG": case "homeERA": case "awayERA":
        case "homeOffRtg": case "awayOffRtg": case "homeDefRtg": case "awayDefRtg":
        case "homeGPG": case "awayGPG": case "homeGAA": case "awayGAA": return m[_sortCfg.col] ?? 0;
        case "nbaTotPace": return m.projPace != null && m.leagueAvgPace != null ? m.projPace - m.leagueAvgPace : 0;
        case "nbaTotInj": return -((m.homeOut ?? 0) + (m.awayOut ?? 0));
        default: return 0;
      }};
      const va = _sv(a), vb = _sv(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return _sortCfg.dir === "desc" ? -cmp : cmp;
    }
    const dca = a.dataConfidence ?? 0;
    const dcb = b.dataConfidence ?? 0;
    if (dcb !== dca) return dcb - dca;
    return (b.edge || b.kalshiPct || 0) - (a.edge || a.kalshiPct || 0);
  }).filter(r => stat !== "hrr" || r.threshold === 1);
  const qualCount = rows.filter(r => r.qualified).length;

  const _dirLabel = direction === "over" ? " — Over" : direction === "under" ? " — Under" : "";

  const xcols = [
    {k:"dc", l:"DC"},
    {k:"dcMkt", l:"Mkt"},
    {k:"dcLineup", l:"Lineup"},
    {k:"dcAvail", l:"Avail"},
    {k:"dcSample", l:"Sample"},
    {k:"dcOppData", l:"Opp"},
    ..._isTotalsType ? [{k:"dcDist", l:"Dist"}] : [],
  ];
  const DASH = <span style={{color:"#21262d"}}>—</span>;
  const _GROUP_NAME = { freshness: "Market quality", lineup: "Lineup", availability: "Availability", sample: "Sample size", oppData: "Opp data", distance: "Threshold distance" };
  const _dcCell = (m, group) => {
    if (m.dataConfidence == null) return DASH;
    const { total, labels } = dcGroupTotal(m, group);
    if (total === 0) return <Tip tip={`${_GROUP_NAME[group]}: no penalty`} style={{color:"#3fb950", cursor:"pointer"}}>✓</Tip>;
    const tip = `${_GROUP_NAME[group]}:\n` + labels.join('\n');
    return <Tip tip={tip} style={{color: total <= -3 ? "#f78166" : total <= -1 ? "#e3b341" : "#3fb950", cursor: "pointer"}}>{total}</Tip>;
  };
  const xcell = (m, k) => {
    const C = (v, col) => v != null ? <span style={{color:col}}>{v}</span> : DASH;
    const era = m.hitterPitcherEra ?? m.pitcherEra ?? m.era;
    const ml  = m.hitterMoneyline ?? m.gameMoneyline ?? m.moneyline ?? m.gameOdds?.moneyline;
    const ab  = m.hitterAbVsPitcher ?? m.abVsTeam;
    const pkp = m.pitcherKPct;
    const lkp = m.lineupKPct;
    const ou  = m.gameTotal ?? m.gameOdds?.total;
    const fML = v => v > 0 ? `+${v}` : `${v}`;
    if (k==="season") { const v = m.seasonPct; return C(v != null ? v.toFixed(1)+"%" : null, v >= 60 ? "#3fb950" : v >= 50 ? "#e3b341" : "#f78166"); }
    if (k==="h2h") { const v = m.softPct; return v != null ? <span style={{color:v>=60?"#3fb950":v>=50?"#e3b341":"#f78166"}}>{v.toFixed(1)+"%"}</span> : DASH; }
    if (k==="era") { const eraColor = stat === "strikeouts" ? (era < 3.5 ? "#3fb950" : era < 4.5 ? "#8b949e" : "#f78166") : (era >= 4.0 ? "#8b949e" : "#f78166"); return C(era != null ? parseFloat(era).toFixed(2) : null, eraColor); }
    if (k==="ml")  return C(ml  != null ? fML(ml) : null, ml <= -121 ? "#3fb950" : ml <= 120 ? "#e3b341" : "#f78166");
    if (k==="kHitRate") { const v=m.blendedHitRate; const pts=m.kHitRatePts; return v!=null ? <span style={{color:pts===2?"#3fb950":pts===1?"#e3b341":"#f78166"}}>{v.toFixed(1)+"%"}</span> : DASH; }
    if (k==="kH2HHand") { const v=m.kH2HHandRate; const pts=m.kH2HHandPts; const n=m.kH2HHandStarts; const maj=m.kH2HHandMaj; if (v==null||n<5) return <span style={{color:"#484f58"}}>{n>0?`(${n})`:"—"}</span>; return <span title={maj?`vs ${maj==="R"?"right":"left"}-heavy lineups (${n} starts)`:undefined} style={{color:pts===2?"#3fb950":pts===1?"#e3b341":"#f78166"}}>{v.toFixed(1)+"%"}</span>; }
    if (k==="ab")  return C(ab  != null ? String(ab) : null, ab >= 10 ? "#8b949e" : "#f78166");
    if (k==="csw") { const csw = m.pitcherCSWPct ?? m.pitcherKPct; const isReal = m.pitcherCSWPct != null; return C(csw != null ? csw.toFixed(1)+"%" : null, isReal ? (csw >= 30 ? "#3fb950" : csw > 26 ? "#e3b341" : "#f78166") : (csw >= 27 ? "#3fb950" : csw >= 24 ? "#e3b341" : "#f78166")); }
    if (k==="pkp") return C(pkp != null ? pkp.toFixed(1)+"%" : null, pkp > 24 ? "#3fb950" : pkp > 20 ? "#e3b341" : "#f78166");
    if (k==="kbb") { const kbb = m.pitcherKBBPct; return C(kbb != null ? kbb.toFixed(1)+"%" : null, kbb > 18 ? "#3fb950" : kbb > 12 ? "#e3b341" : "#f78166"); }
    if (k==="pps") { const pps = m.pitcherAvgPitches; return C(pps != null ? pps.toFixed(0) : null, pps > 85 ? "#3fb950" : pps > 75 ? "#e3b341" : "#f78166"); }
    if (k==="lkp") return C(lkp != null ? lkp.toFixed(1)+"%" : null, lkp > 24 ? "#3fb950" : lkp > 22 ? "#e3b341" : "#f78166");
    if (k==="spot") { const sp = m.hitterLineupSpot; return C(sp != null ? `#${sp}` : null, sp <= 3 ? "#3fb950" : sp <= 4 ? "#e3b341" : "#f78166"); }
    if (k==="whip") { const w = m.pitcherWHIP; return C(w != null ? w.toFixed(2) : null, w > 1.35 ? "#3fb950" : w > 1.20 ? "#e3b341" : "#f78166"); }
    if (k==="plat") { const s = m.hitterSplitBA; const pts = m.hitterPlatoonPts; if (s == null) return DASH; const ba = "."+Math.round(s*1000).toString().padStart(3,"0"); return <span style={{color:pts===2?"#3fb950":pts===0?"#f78166":"#e3b341"}}>{ba}</span>; }
    if (k==="ou")  return C(ou  != null ? ou : null, ou <= 7.5 ? "#3fb950" : ou < 10.5 ? "#e3b341" : "#f78166");
    if (k==="mlbOu") { const v = m.gameOuLine ?? m.hitterGameTotal; if (v == null) return DASH; const isU=m.direction==="under"; const color=isU?(v<7.5?"#3fb950":v<9.5?"#e3b341":"#f78166"):(v>=9.5?"#3fb950":v>=7.5?"#e3b341":"#f78166"); return <span style={{color}}>{v}</span>; }
    if (k==="dvp") { const r = m.posDvpRank ?? m.oppRank; const ratio = m.dvpRatio; const dvpColor = ratio == null ? "#f78166" : ratio >= 1.05 ? "#3fb950" : ratio >= 1.02 ? "#e3b341" : "#f78166"; return C(r != null ? `#${r}${m.posGroup?" "+m.posGroup:""}` : null, dvpColor); }
    if (k==="sim") { const sc = m.teamTotalSimScore ?? m.totalSimScore ?? m.finalSimScore ?? m.hitterFinalSimScore ?? m.nbaSimScore ?? m.wnbaSimScore ?? m.nhlSimScore ?? m.simScore ?? m.hitterSimScore; const tip = buildSimTooltip(m); return sc != null ? <Tip tip={tip} style={{color:sc>=8?"#3fb950":sc>=5?"#e3b341":"#f78166",fontWeight:600,cursor:tip?"pointer":"default"}}>{sc}/10</Tip> : DASH; }
    if (k==="dc") {
      const dc = m.dataConfidence;
      if (dc == null) return DASH;
      const gate = m.dcGate ?? 9;
      const pens = Object.entries(m.dcPenalties || {});
      const tip = pens.length === 0 ? `DC ${dc}/10 (clean, gate ≥ ${gate})` : `DC ${dc}/10 (gate ≥ ${gate})\n` + pens.map(([k, v]) => `${k} ${v}`).join('\n');
      const color = dc >= gate ? "#3fb950" : dc >= gate - 2 ? "#e3b341" : "#f78166";
      return <Tip tip={tip} style={{color, fontWeight: 600, cursor: "pointer"}}>{dc}/10</Tip>;
    }
    if (k==="dcMkt") return _dcCell(m, "freshness");
    if (k==="dcLineup") return _dcCell(m, "lineup");
    if (k==="dcAvail") return _dcCell(m, "availability");
    if (k==="dcSample") return _dcCell(m, "sample");
    if (k==="dcOppData") return _dcCell(m, "oppData");
    if (k==="dcDist") return _dcCell(m, "distance");
    if (k==="env") { const pf = m.parkFactor ?? m.hitterParkKF; if (pf == null) return DASH; const pct = Math.round((pf-1)*100); const disp = (pct>=0?"+":"")+pct+"%"; return <span style={{color:pf>1.02?"#3fb950":pf<0.98?"#f78166":"#8b949e"}}>{disp}</span>; }
    if (k==="brrl") { const b = m.hitterBarrelPct; return b != null ? <span style={{color:b>=14?"#3fb950":b>=10?"#e3b341":b>=7?"#8b949e":"#f78166"}}>{b.toFixed(1)+"%"}</span> : DASH; }
    if (k==="nbapace") { const p = m.nbaPaceAdj; return p != null ? <span style={{color:p>0?"#3fb950":p>-2?"#e3b341":"#8b949e"}}>{p>0?"+":""}{p.toFixed(1)}</span> : DASH; }
    if (k==="nbaopp")  { const o = m.nbaOpportunity; return o != null ? <span style={{color:o>=30?"#3fb950":o>=25?"#e3b341":"#f78166"}}>{o.toFixed(0)}m</span> : DASH; }
    if (k==="nba_b2b") { if (m.isB2B == null) return DASH; return <span style={{color:m.isB2B?"#f78166":"#3fb950"}}>{m.isB2B?"B2B":"Rested"}</span>; }
    if (k==="nbaC1") { const isReb = m.stat==="rebounds"; const v = isReb ? m.nbaOpportunity : m.nbaUsage; if (v == null) return DASH; const color = isReb ? (v>=30?"#3fb950":v>=25?"#e3b341":"#f78166") : (v>=28?"#3fb950":v>=22?"#e3b341":"#f78166"); return <span style={{color}}>{isReb ? v.toFixed(0)+"m" : v.toFixed(1)+"%"}</span>; }
    if (k==="nbaOu")   { const v = m.nbaGameTotal; return v != null ? <span style={{color:v>=225?"#3fb950":v>=215?"#e3b341":"#f78166"}}>{v}</span> : DASH; }
    if (k==="nbaSeasonHR") { const v = m.seasonPct; const pts = m.nbaSeasonHitRatePts ?? (v==null?1:v>=90?2:v>=80?1:0); const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return v!=null ? <span style={{color}}>{v.toFixed(0)}%</span> : DASH; }
    if (k==="nbaSoftHR") { const v = m.softPct; if (v==null) return DASH; const pts = m.nbaSoftHitRatePts ?? (v>=90?2:v>=80?1:0); const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
    if (k==="nbaPaceTotal") { const pts = m.nbaTotalPts ?? 1; const ou = m.nbaGameTotal; const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return ou != null ? <span style={{color,fontWeight:600}}>{ou}</span> : DASH; }
    if (k==="wnbaC1") { const isReb = m.stat==="rebounds"; const v = isReb ? m.wnbaOpportunity : m.wnbaUsage; if (v == null) return DASH; const color = isReb ? (v>=27?"#3fb950":v>=22?"#e3b341":"#f78166") : (v>=27?"#3fb950":v>=22?"#e3b341":"#f78166"); return <span style={{color}}>{isReb ? v.toFixed(0)+"m" : v.toFixed(1)+"%"}</span>; }
    if (k==="wnbaSeasonHR") { const v = m.seasonPct; const pts = m.wnbaSeasonHitRatePts ?? (v==null?1:v>=90?2:v>=80?1:0); const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return v!=null ? <span style={{color}}>{v.toFixed(0)}%</span> : DASH; }
    if (k==="wnbaSoftHR") { const v = m.softPct; if (v==null) return DASH; const pts = m.wnbaSoftHitRatePts ?? (v>=90?2:v>=80?1:0); const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
    if (k==="wnbaPaceTotal") { const pts = m.wnbaTotalPts ?? 1; const ou = m.wnbaGameTotal; const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return ou != null ? <span style={{color,fontWeight:600}}>{ou}</span> : DASH; }
    if (k==="wnbaTotPace") { const pa = m.projPace != null && m.leagueAvgPace != null ? parseFloat((m.projPace - m.leagueAvgPace).toFixed(1)) : null; if (pa == null) return DASH; const isU=m.direction==="under"; const _pp = (m.homePace==null||m.awayPace==null||m.leagueAvgPace==null)?1:isU?((m.homePace<m.leagueAvgPace-1&&m.awayPace<m.leagueAvgPace-1)?2:(m.homePace<m.leagueAvgPace||m.awayPace<m.leagueAvgPace)?1:0):((m.homePace>m.leagueAvgPace+1&&m.awayPace>m.leagueAvgPace+1)?2:(m.homePace>m.leagueAvgPace||m.awayPace>m.leagueAvgPace)?1:0); return <span style={{color:_pp===2?"#3fb950":_pp===1?"#e3b341":"#f78166",fontWeight:600}}>{(pa>0?"+":"")+pa}</span>; }
    if (k==="wnbaCombOff") { const v=m.combOffRtg; if(v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<93?"#3fb950":v<98?"#e3b341":"#f78166"):(v>=98?"#3fb950":v>=93?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
    if (k==="wnbaCombDef") { const v=m.combDefRtg; if(v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<93?"#3fb950":v<98?"#e3b341":"#f78166"):(v>=98?"#3fb950":v>=93?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
    if (k==="wnbaGtH2H") { const v=m.wnbaGtH2HRate; if(v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<=30?"#3fb950":v<=50?"#e3b341":"#f78166"):(v>=80?"#3fb950":v>=60?"#e3b341":"#f78166"); return <span style={{color}}>{v}%</span>; }
    if (k==="nba_spread") { const adj = m.nbaBlowoutAdj; if (adj == null) return DASH; const color = adj===1.0?"#3fb950":adj>0.92?"#e3b341":"#f78166"; const sp = m.nbaBlowoutAdj!=null && adj<1.0 ? Math.round((1-adj)/0.007+10) : null; return <span style={{color}}>{adj===1.0?"Tight":sp!=null?`-${sp}`:"—"}</span>; }
    if (k==="nhlgaa") { const r = m.gaaRank; return C(r != null ? `#${r}` : null, r<=10?"#3fb950":r<=15?"#e3b341":"#f78166"); }
    if (k==="nhlsa")  { const v = m.nhlShotsAdj; const r = m.nhlSaRank; return v != null ? <span style={{color:(r!=null&&r<=10)?"#3fb950":v>0?"#e3b341":"#f78166"}}>{v>0?"+":""}{v.toFixed(1)}</span> : DASH; }
    if (k==="nhltoi") { const t = m.nhlOpportunity; return t != null ? <span style={{color:t>=18?"#3fb950":t>=15?"#e3b341":"#f78166"}}>{t.toFixed(1)}m</span> : DASH; }
    if (k==="nhl_b2b") { if (m.isB2B == null) return DASH; return <span style={{color:m.isB2B?"#f78166":"#3fb950"}}>{m.isB2B?"B2B":"Rested"}</span>; }
    if (k==="nhlSeasonHR") { const v=m.seasonPct; if (v==null) return DASH; const pts=m.nhlSeasonHitRatePts??(v>=90?2:v>=80?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
    if (k==="nhlDvpHR") { const v=m.softPct; if (v==null) return DASH; const pts=m.nhlDvpHitRatePts??(v>=90?2:v>=80?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
    if (k==="nhlGameTotalOu") { const v=m.nhlGameTotal; if (v==null) return DASH; const color=v>=7?"#3fb950":v>=5.5?"#e3b341":"#f78166"; return <span style={{color,fontWeight:600}}>O{v}</span>; }
    if (k==="combinedRPG") { const v = m.combinedRPG; if (v == null) return DASH; const isU=m.direction==="under"; const color=isU?(v<8.5?"#3fb950":v<=10.5?"#e3b341":"#f78166"):(v>=10.5?"#3fb950":v>=8.5?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
    if (k==="homeWhip"||k==="awayWhip") { const v = m[k==="homeWhip"?"homeWHIP":"awayWHIP"]; if(v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<=1.10?"#3fb950":v<=1.25?"#e3b341":"#f78166"):(v>1.35?"#3fb950":v>1.20?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(2)}</span>; }
    if (k==="gtH2HHR") { const v=m.h2hTotalHitRate; const g=m.h2hTotalGames; if (v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<=20?"#3fb950":v<=40?"#e3b341":"#f78166"):(v>=80?"#3fb950":v>=60?"#e3b341":"#f78166"); return <span style={{color}} title={g!=null?`${g} H2H games`:undefined}>{v}%</span>; }
    if (k==="umpire") { const v = m.umpireRunFactor; if (v==null) return DASH; return <span style={{color:v>=1.05?"#3fb950":v>=0.97?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(3)}</span>; }
    if (k==="homeRPG"||k==="awayRPG") { const v = m[k]; return v != null ? <span style={{color:v>=5.0?"#3fb950":v>=4.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
    if (k==="homeERA"||k==="awayERA") { const v = m[k]; return v != null ? <span style={{color:v>=4.5?"#3fb950":v>=3.5?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(2)}</span> : DASH; }
    if (k==="homeOffRtg"||k==="awayOffRtg") { const v = m[k]; return v != null ? <span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
    if (k==="homeDefRtg"||k==="awayDefRtg") { const v = m[k]; return v != null ? <span style={{color:v>=118?"#f78166":v>=113?"#e3b341":"#3fb950",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
    if (k==="nbaTotPace") { const pa = m.projPace != null && m.leagueAvgPace != null ? parseFloat((m.projPace - m.leagueAvgPace).toFixed(1)) : null; if (pa == null) return DASH; const isU=m.direction==="under"; const _pp = (m.homePace==null||m.awayPace==null||m.leagueAvgPace==null)?1:isU?((m.homePace<m.leagueAvgPace-2&&m.awayPace<m.leagueAvgPace-2)?2:(m.homePace<m.leagueAvgPace||m.awayPace<m.leagueAvgPace)?1:0):((m.homePace>m.leagueAvgPace+2&&m.awayPace>m.leagueAvgPace+2)?2:(m.homePace>m.leagueAvgPace||m.awayPace>m.leagueAvgPace)?1:0); return <span style={{color:_pp===2?"#3fb950":_pp===1?"#e3b341":"#f78166",fontWeight:600}}>{(pa>0?"+":"")+pa}</span>; }
    if (k==="nbaTotInj") { const tot=(m.homeOut??0)+(m.awayOut??0); const _ip=tot===0?2:tot<=2?1:0; const disp=tot===0?"0 out":`${tot} out`; return <span style={{color:_ip===2?"#3fb950":_ip===1?"#e3b341":"#f78166"}}>{disp}</span>; }
    if (k==="nbaCombOff") { const v=m.combOffRtg; if(v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<113?"#3fb950":v<118?"#e3b341":"#f78166"):(v>=118?"#3fb950":v>=113?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
    if (k==="nbaCombDef") { const v=m.combDefRtg; if(v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<113?"#3fb950":v<118?"#e3b341":"#f78166"):(v>=118?"#3fb950":v>=113?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
    if (k==="nbaGtH2H") { const v=m.nbaGtH2HRate; if(v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<=30?"#3fb950":v<=50?"#e3b341":"#f78166"):(v>=80?"#3fb950":v>=60?"#e3b341":"#f78166"); return <span style={{color}}>{v}%</span>; }
    if (k==="ttNbaOff") { const v=m.teamOffRtg; if(v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<113?"#3fb950":v<118?"#e3b341":"#f78166"):(v>=118?"#3fb950":v>=113?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
    if (k==="ttNbaDef") { const v=m.oppDefRtg; if(v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<113?"#3fb950":v<118?"#e3b341":"#f78166"):(v>=118?"#3fb950":v>=113?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
    if (k==="ttNbaSsnHR") { const v=m.ttNbaSeasonHitRate; if(v==null) return DASH; const isU=m.direction==="under"; const pts=m.ttNbaSeasonHitRatePts??(isU?(v<=20?2:v<=40?1:0):(v>=80?2:v>=60?1:0)); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color,fontWeight:600}}>{v}%</span>; }
    if (k==="totalOu") { const v = m.sport==="nba" ? (m.gameOuLine ?? m.threshold) : m.threshold; if (v == null) return DASH; const line = m.sport==="nba" ? v.toFixed(1) : (v-0.5).toFixed(1); const isU=m.direction==="under"; const color = m.sport==="nba" ? (isU?(v<215?"#3fb950":v<225?"#e3b341":"#f78166"):(v>=225?"#3fb950":v>=215?"#e3b341":"#f78166")) : m.sport==="nhl" ? (isU?(v<5.5?"#3fb950":v<7?"#e3b341":"#f78166"):(v>=6?"#3fb950":v>=5?"#e3b341":"#f78166")) : "#8b949e"; return <span style={{color,fontWeight:600}}>O{line}</span>; }
    if (k==="homeGPG"||k==="awayGPG"||k==="homeGAA"||k==="awayGAA") { const v = m[k]; if (v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<3.0?"#3fb950":v<3.5?"#e3b341":"#f78166"):(v>=3.5?"#3fb950":v>=3.0?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
    if (k==="ops") { const v=m.hitterOps; const pts=m.hitterOpsPts; if (v==null) return DASH; const color=pts===2?"#3fb950":pts===1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(3)}</span>; }
    if (k==="hQuality") { const pts=m.hitterBatterQualityPts; const sp=m.hitterLineupSpot; const brrl=m.hitterBarrelPct; if (pts==null) return DASH; const color=pts===2?"#3fb950":pts===1?"#e3b341":"#f78166"; const disp=sp!=null?`#${sp}${brrl!=null?' '+brrl.toFixed(0)+'%':''}`:brrl!=null?brrl.toFixed(1)+'%':`${pts}/2`; return <span style={{color}}>{disp}</span>; }
    if (k==="hSsnHR") { const v=m.seasonPct; if (v==null) return DASH; const pts=m.hitterSeasonHitRatePts ?? (v>=80?2:v>=70?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(1)+"%"}</span>; }
    if (k==="hH2HHR") { const v=m.softPct; if (v==null) return DASH; const pts=m.hitterH2HHitRatePts ?? (v>=80?2:v>=70?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(1)+"%"}</span>; }
    if (k==="ttOpp") { return m.oppTeam ? <span onClick={() => { onClose && onClose(); navigateToTeam(m.oppTeam, m.sport); }} style={{color:"#8b949e",cursor:"pointer"}}>{_teamShort(m.oppTeam, m.sport)}</span> : DASH; }
    if (k==="ttH2HHR") { const v=m.h2hHitRate; const g=m.h2hGames; if (v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<=30?"#3fb950":v<=50?"#e3b341":"#f78166"):(v>=80?"#3fb950":v>=60?"#e3b341":"#f78166"); return <span style={{color}} title={g!=null?`${g} H2H games`:undefined}>{v}%</span>; }
    if (k==="ttTeamRPG") { const v=m.teamRPG; return v!=null?<span style={{color:v>5.0?"#3fb950":v>4.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
    if (k==="ttOppERA") { const v=m.oppERA; return v!=null?<span style={{color:v>4.5?"#3fb950":v>3.5?"#e3b341":"#8b949e",fontWeight:600}}>{parseFloat(v).toFixed(2)}</span>:DASH; }
    if (k==="ttOppRPG") { const v=m.oppRPG; return v!=null?<span style={{color:v>5.0?"#3fb950":v>4.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
    if (k==="ttPark") { const pf=m.parkFactor; if(pf==null) return DASH; const pct=Math.round((pf-1)*100); return <span style={{color:pf>1.05?"#3fb950":pf>1.00?"#e3b341":"#8b949e"}}>{(pct>=0?"+":"")+pct+"%"}</span>; }
    if (k==="ttSeasonHR") { const v=m.ttSeasonHitRate; if (v==null) return DASH; const isU=m.direction==="under"; const pts=m.ttSeasonHitRatePts??(isU?(v<=20?2:v<=40?1:0):(v>=80?2:v>=60?1:0)); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color,fontWeight:600}}>{v}%</span>; }
    if (k==="ttWhip") { const v=m.oppWHIP; if (v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<=1.10?"#3fb950":v<=1.25?"#e3b341":"#f78166"):(v>1.35?"#3fb950":v>1.20?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(2)}</span>; }
    if (k==="ttL10RPG") { const v=m.teamL10RPG; if (v==null) return DASH; const isU=m.direction==="under"; const color=isU?(v<=3.5?"#3fb950":v<=4.5?"#e3b341":"#f78166"):(v>5.0?"#3fb950":v>4.0?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
    if (k==="ttOu") { const v=m.gameOuLine; if(v==null) return DASH; const isU=m.direction==="under"; const color=m.sport==="nba"?(isU?(v<215?"#3fb950":v<225?"#e3b341":"#f78166"):(v>=225?"#3fb950":v>=215?"#e3b341":"#f78166")):(isU?(v<7.5?"#3fb950":v<9.5?"#e3b341":"#f78166"):(v>=9.5?"#3fb950":v>=7.5?"#e3b341":"#f78166")); return <span style={{color,fontWeight:600}}>{v}</span>; }
    if (k==="ttTeamOff") { const v=m.teamOff; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(0)}</span>:DASH; }
    if (k==="ttOppDef") { const v=m.oppDef; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(0)}</span>:DASH; }
    if (k==="ttPace") { const pace=m.teamPace,lg=m.leagueAvgPace; if(pace==null||lg==null) return DASH; const d=parseFloat((pace-lg).toFixed(1)); return <span style={{color:d>2?"#3fb950":d>-2?"#e3b341":"#f78166"}}>{d>0?"+":""}{d}</span>; }
    if (k==="ttSpread") { const sp=m.gameSpread; if(sp==null) return DASH; const abs=Math.abs(sp); return <span style={{color:abs<=5?"#3fb950":abs<=10?"#e3b341":"#f78166"}}>{sp>0?"+":""}{sp.toFixed(1)}</span>; }
    return DASH;
  };
  const RESULT_LABELS = {
    edge_too_low:"edge low", kalshi_pct_too_low:"<67%", kalshi_pct_too_high:">91%",
    opp_not_soft:"not soft", low_confidence:"low score",
    team_not_favored:"ML ✗", pitcher_era_too_low:"ERA ✗",
    no_h2h_data:"no h2h", insufficient_ab_vs_pitcher:"AB ✗",
    low_batting_avg:"BA ✗", no_opp:"no team",
    no_espn_info:"no info", no_gamelog:"no log",
    no_soft_data:"no data", col_not_found:"no col", no_gamelog_vals:"no vals",
    low_lineup_spot:"spot 5-9", no_simulation_data:"no data",
  };
  const _sk = _groupKey;
  const _sc = reportSort[_sk];
  const COL_TIPS = {
    player:"Player name", line:"Prop line threshold",
    true:"Model True% (Monte Carlo simulation)",
    kalshi:"Kalshi market price", edge:"Model edge over Kalshi market",
    opp:"Tonight's opponent / starting pitcher",
    sim:"Sim-Score (max 10 — 8+ = Alpha tier); hover for component breakdown",
    dc: "dataConfidence (0–10) — input-data trust score. Starts at 10, subtracts penalties. A play counts as Qualified (here and on the home page) only at dc=10 (clean inputs). Hover the cell for the penalty breakdown.",
    dcMkt: "Market quality — Kalshi staleness / liquidity. ✓ = no penalty.",
    dcLineup: "Lineup / starter confirmation. ✓ = confirmed or unknown.",
    dcAvail: "Player availability (player props only). ✓ = no concerns.",
    dcSample: "Sample size of underlying data. ✓ = strong sample.",
    dcOppData: "Opponent data quality. ✓ = clean.",
    dcDist: "Threshold distance from O/U line. Totals & teamTotals only. ✓ = at-or-near line.",
  };
  const _hdr = (col, label, extraStyle={}, textAlign="right") => {
    const active = _sc?.col === col;
    const onClick = () => setReportSort(prev => {
      const cur = prev[_sk];
      const dir = cur?.col === col && cur.dir === "desc" ? "asc" : "desc";
      return {...prev, [_sk]: {col, dir}};
    });
    const _colTip = COL_TIPS[col];
    return <div title={_colTip} style={{flex:1,color:active?"#c9d1d9":"#484f58",fontSize:10,textAlign,cursor:"pointer",userSelect:"none",...extraStyle}} onClick={onClick}>
      {label}{active ? (_sc.dir === "desc" ? "↓" : "↑") : ""}
      {_colTip && <Tip tip={_colTip} stopPropagation style={{marginLeft:3,fontSize:9,color:"#484f58",cursor:"pointer"}}>ⓘ</Tip>}
    </div>;
  };
  const _oppFlex = 1;
  return (
    <div style={{marginBottom:18}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,paddingBottom:5,borderBottom:"1px solid #21262d",flexWrap:"wrap"}}>
        <span style={{color:REPORT_SPORT_COL[sport]||"#8b949e",fontWeight:700,fontSize:11}}>{sport.toUpperCase()}</span>
        <span style={{color:"#8b949e",fontSize:12,marginRight:2}}>{STAT_NAME[stat]||stat}{_dirLabel}</span>
        <span style={{color:"#484f58",fontSize:11,marginLeft:"auto"}}>{rows.length} markets · <span style={{color:"#3fb950"}}>{qualCount}</span> play{qualCount!==1?"s":""}</span>
      </div>
      <div style={{overflowX:"auto"}}>
      <div style={{minWidth:680}}>
      <div style={{display:"flex",alignItems:"center",gap:6,padding:"3px 12px 4px",marginBottom:2}}>
        {_hdr("player", stat.startsWith("team") ? "Team" : stat.startsWith("total") ? "Matchup" : "Player", {flex:2,minWidth:0}, "left")}
        {_hdr("line","Line")}
        {_hdr("true","True%")}
        {_hdr("kalshi","Kalshi")}
        {_hdr("edge","Edge")}
        {xcols.map(c => <React.Fragment key={c.k}>{_hdr(c.k,c.l,c.flex?{flex:c.flex}:{})}</React.Fragment>)}
        {!stat.startsWith("total") && !stat.startsWith("team") && _hdr("opp","Opp",{flex:_oppFlex})}
      </div>
      <div style={{background:"#0d1117",borderRadius:8,overflow:"hidden"}}>
        {rows.map((m, i) => {
          const truePct = m.truePct ?? null;
          const edge = m.edge ?? null;
          const _mlbRowScore = sport === "mlb" ? (m.finalSimScore ?? m.hitterFinalSimScore ?? null) : null;
          const _highScore = _mlbRowScore != null && _mlbRowScore > 7;
          const isTotal = m.gameType === "total";
          const isTeamTotal = m.gameType === "teamTotal";
          const isMl = m.gameType === "ml";
          const isSpread = m.gameType === "spread";
          const _nameWhite = (isTotal || isTeamTotal || isMl || isSpread) ? m.qualified : sport === "mlb" ? (_highScore && m.qualified) : m.qualified;
          const _rowKey = isTeamTotal ? `${m.scoringTeam}|${m.oppTeam}|${m.threshold}${m.direction==="under"?"|under":""}|${i}` : isTotal ? `${m.homeTeam}|${m.awayTeam}|${m.threshold}|${i}` : isMl ? `${m.pickTeam}|${m.oppTeam}|${i}` : isSpread ? `${m.pickTeam}|${m.oppTeam}|${m.pickLine}|${i}` : `${m.playerName}|${m.threshold}|${i}`;
          return (
            <div key={_rowKey} style={{
              display:"flex",alignItems:"center",gap:6,padding:"6px 12px",
              borderTop: i>0?"1px solid #161b22":"none"}}>
              <div style={{flex:2,minWidth:0,fontSize:12,fontWeight:_nameWhite?600:400,display:"flex",alignItems:"baseline",gap:3}}>
                {isTeamTotal
                  ? <span onClick={() => { navigateToTeam(m.scoringTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{_teamShort(m.scoringTeam, m.sport)}</span>
                  : isTotal
                  ? <><span onClick={() => { navigateToTeam(m.awayTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{_teamShort(m.awayTeam, m.sport)}</span>
                      <span style={{color:"#484f58"}}> @ </span>
                      <span onClick={() => { navigateToTeam(m.homeTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{_teamShort(m.homeTeam, m.sport)}</span></>
                  : isMl || isSpread
                  ? <><span onClick={() => { navigateToTeam(m.pickTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{_teamShort(m.pickTeam, m.sport)}</span>
                      <span style={{color:"#484f58"}}> {m.side === "home" ? "vs" : "@"} </span>
                      <span onClick={() => { navigateToTeam(m.oppTeam, m.sport); }} style={{color:"#484f58",whiteSpace:"nowrap",cursor:"pointer"}}>{_teamShort(m.oppTeam, m.sport)}</span></>
                  : <><span onClick={() => { navigateToPlayer({ id: m.playerId, name: m.playerName, sportKey: SPORT_KEY[m.sport] }, m.stat); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",textTransform:"capitalize",cursor:"pointer"}}>{m.playerNameDisplay||m.playerName}</span>
                     {(m.playerTeam||m.kalshiPlayerTeam)&&<span style={{color:"#484f58",fontWeight:400,flexShrink:0,fontSize:10}}>({m.playerTeam||m.kalshiPlayerTeam})</span>}</>
                }
              </div>
              <div style={{flex:1,color:"#8b949e",fontSize:11,textAlign:"right"}}>
                {isSpread ? (m.pickLine > 0 ? `+${m.pickLine}` : `${m.pickLine}`) : isMl ? "ML" : (isTotal || isTeamTotal) ? `${m.direction === "under" ? "U" : "O"}${(m.threshold - 0.5).toFixed(1)}` : `${m.threshold}+`}
              </div>
              {(() => { const _tp = m.direction === "under" ? (m.noTruePct ?? null) : (m.truePct ?? null); return <div style={{flex:1,fontSize:11,textAlign:"right",color:_tp!=null?"#e3b341":"#21262d",fontWeight:_tp!=null?600:400}}>{_tp!=null?`${_tp}%`:"—"}</div>; })()}
              {(() => { const _kp = m.direction === "under" ? (m.noKalshiPct ?? null) : (m.kalshiPct ?? null); return <div style={{flex:1,fontSize:11,textAlign:"right"}}><span style={{color:_kp != null ? "#c9d1d9" : "#484f58"}}>{_kp != null ? `${_kp}%` : "—"}</span></div>; })()}
              <div style={{flex:1,fontSize:11,textAlign:"right",color:edge!=null&&edge>=3?"#3fb950":edge!=null&&edge<0?"#f78166":"#8b949e"}}>{edge!=null?(edge>=0?`+${edge.toFixed(1)}`:`${edge.toFixed(1)}`)+"%" :"—"}</div>
              {xcols.map(c => <div key={c.k} style={{flex:c.flex??1,fontSize:11,textAlign:"right"}}>{xcell(m,c.k)}</div>)}
              {!isTotal && !isTeamTotal && !isMl && !isSpread && <div style={{flex:_oppFlex,fontSize:10,textAlign:"right",whiteSpace:"nowrap"}}>
                {(() => { const pn = m.pitcherName || m.hitterPitcherName; const parts = pn ? pn.trim().split(" ") : []; const shortPn = parts.length >= 2 ? `${parts[0][0]}. ${parts.slice(1).join(" ")}` : pn; return m.sport==="mlb" && m.stat!=="strikeouts" && pn
                  ? <><span style={{color:"#8b949e"}}>{shortPn}</span> <span style={{color:"#484f58"}}>({m.opponent})</span></>
                  : <span onClick={() => { if (m.opponent) { navigateToTeam(m.opponent, m.sport); } }} style={{color:"#484f58",cursor:m.opponent?"pointer":"default"}}>{_teamShort(m.opponent, m.sport)||m.opponent||""}</span>; })()}
              </div>}
            </div>
          );
        })}
      </div>
      </div>
      </div>
    </div>
  );
}

// --- Model Reference content -------------------------------------------------------
// Keyed by tab id. Tabs with no entry just render CalibModule (calibration-only).

const MODEL_CONTENT = {
  "mlb-k": (
    <>
      <Section title="MLB Strikeouts — True% Model">
        <div style={s.sub}>Computes P(strikeouts ≥ threshold) via Monte Carlo simulation (5k–10k trials based on SimScore)</div>

        <div style={s.h3}>Core Formula</div>
        <Formula>{`For each simulated trial:
  trialPA ~ Normal(avgBF, stdBF)          ← per-trial BF variance, clamped [10,27]
  [blowout hook: ~8–18% chance → trialPA = rand[10,15] based on team ML odds]
  For each batter in trialPA:
    if batter# ≥ 19: pitcherK% × 0.88    ← TTO decay (3rd time through order)
    P(K) = log5(pitcherK%, batterK%)      ← matchup-specific probability
  total Ks = sum of K outcomes across trialPA batters
truePct = fraction of trials where total ≥ threshold`}</Formula>

        <div style={s.h3}>Model Inputs</div>
        <InputRow name="Pitcher K%" tooltip="regressed toward 2025 anchor" color="#3fb950"
          why="Core signal. Regressed toward 2025 season anchor (or 22.2% league avg) weighted by 2026 batters faced ÷ 200. Prevents small-sample overfit — a pitcher with 2 starts isn't trusted at face value." />
        <InputRow name="A1 — Recent form" tooltip="last 5 starts" color="#3fb950"
          why="Effective K% = 60% recent + 40% season when ≥3 starts and 30+ total BF. Captures momentum: a pitcher in a 3-start hot streak is more predictive for tonight than their full-season average." />
        <InputRow name="A2 — Rest / fatigue" color="#e3b341"
          why="≤3 days rest → K% ×0.96. ≤3 days AND last start ≥95 pitches → ×0.92. Short rest after heavy workload produces measurable decline in swing-and-miss rate." />
        <InputRow name="Batter K%" tooltip="lineup composite, hand-adjusted vs starter" color="#3fb950"
          why="Strikeouts require both pitcher and batter. A lineup full of high-K batters amplifies the pitcher. Adjusted for LHP/RHP split since platoon splits are large (batters K more vs same-hand pitchers)." />
        <InputRow name="E3b — Expected BF" tooltip="empirical avgBF from pitcher gamelog" color="#e3b341"
          why="Pitcher-specific average batters faced per start, computed from their MLB gamelog (NP≥30 starts only). High-walk or deep-count pitchers face fewer batters than average — this directly lowers the K ceiling. Falls back to avgPitches ÷ 3.85 when gamelog data is absent." />
        <InputRow name="stdBF variance" color="#8b949e"
          why="Each trial samples trialPA from Normal(avgBF, stdBF) rather than using a fixed number. stdBF is the empirical standard deviation of BF across the pitcher's qualified starts (≥3 required). Reflects real pitch-count variability: some nights a pitcher goes 7 deep, others they're pulled after 4. Uses scoped Box-Muller to avoid cross-request state." />
        <InputRow name="TTO decay" tooltip="applied inside simulation at BF ≥ 19" color="#8b949e"
          why="The 3rd time through the order, batters K at ~12% lower rates league-wide as they adjust to the pitcher's tendencies. Applied inside each trial at BF ≥ 19 as ×0.88. Effect: −0.15 to −0.25 projected Ks for workhorses (avgBF ≥ 22); negligible for pitch-limited starters." />
        <InputRow name="Blowout hook" tooltip="earlyExitProb derived from ML odds" color="#8b949e"
          why="When a pitcher's team is a large underdog (+150 or worse), there's a meaningful chance they get pulled early if the game gets out of hand. ML odds map to early-exit probability: +150→8%, +200→12%, +250+→18%. Each trial independently rolls whether the pitcher is clipped at 10–15 BF." />
        <InputRow name="E3a — Umpire K-factor" color="#e3b341"
          why="Known in advance. Plate umpires vary ~10–15% in strikeout rate (range 0.89–1.12×). Applied directly to pitcherK% before simulation. Unknown umpires → 1.0 (no adjustment)." />
        <InputRow name="Park K-factor" color="#8b949e"
          why="Applied inside simulation. Colorado's thin air reduces spin effectiveness; other parks have structural effects. Built from FanGraphs multi-year SO park factors." />
      </Section>

      <Section title="MLB Strikeouts — SimScore (max 10)">
        <div style={s.sub}>5 components × 2 pts each. Gate: finalSimScore ≥ 8 to qualify as a play.</div>
        <ScoreRow pts="0–2" name="CSW% / K% tier"
          tiers="CSW% ≥30% → 2pts · CSW% >26% → 1pt · ≤26% → 0pts (fallback: K% >27%→2, >24%→1)"
          why="Called Strikes + Whiffs is a better single-start predictor than K% alone because it captures command quality and swing generation. K% can be inflated by opponent quality; CSW is pitcher-intrinsic." />
        <ScoreRow pts="0–2" name="K-BB% (command)"
          tiers=">18% → 2pts · >12% → 1pt · ≤12% → 0pts"
          why="Pitchers who also walk batters have higher variance outcomes. High K-BB means dominant command — strikeouts without the wildness that cuts into BF and pitch count." />
        <ScoreRow pts="0–2" name="Lineup oK% (opponent K-rate)"
          tiers=">24% → 2pts · >22% → 1pt · ≤22% → 0pts"
          why="Facing a high-K lineup increases the probability of each K event. Hand-adjusted (vs RHP or LHP batters). This is the opportunity signal — even the best pitcher needs hitters who swing and miss." />
        <ScoreRow pts="0–2" name="Blended Hit Rate"
          tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts"
          why="Trust-weighted blend of 2026 observed hit rate at this threshold and 2025 computed rate. The pitcher's own historical rate is the strongest calibration signal — if they've hit this K total in 90% of starts, the model's simulation is well-supported." />
        <ScoreRow pts="0–2" name="Game O/U line"
          tiers="≤7.5 → 2pts · &lt;10.5 → 1pt · ≥10.5 → 0pts"
          why="Low totals signal pitcher-dominant conditions. The betting market incorporates weather, ballpark, and other factors we may not have. A consensus O/U ≤7.5 is independent confirmation of a pitchers' duel." />
      </Section>
    </>
  ),
  "mlb-hrr": (
    <>
      <Section title="MLB H+R+RBI — True% Model">
        <div style={s.sub}>Blended formula — no Monte Carlo. Averages two rate components, then applies park adjustment via log-odds transform.</div>

        <div style={s.h3}>Core Formula</div>
        <Formula>{`rawMlbPct = (primaryPct + softPct) / 2

// Park factor via log-odds (prevents exceeding 100% at elite rates in hitter parks)
logOddsAdj = logit(rawMlbPct ÷ 100) + ln(parkFactor)
truePct = sigmoid(logOddsAdj) × 100

primaryPct = player's 2026 HRR 1+ rate
  (blended with 2025 season if trust26 < 1.0, where trust26 = min(1, games26 ÷ 30))

softPct = HRR 1+ rate vs tonight's pitcher (H2H gamelog, requires ≥5 games)
  OR platoon-adjusted rate if H2H < 5 games:
       softPct = primaryPct × (splitBA_vsHand ÷ seasonBA)
       (softLabel updates to "vs RHP" or "vs LHP")
  OR team-level rate vs opponent if splitBA/seasonBA unavailable

parkFactor = PARK_HITFACTOR[homeTeam]`}</Formula>

        <div style={s.h3}>Model Inputs</div>
        <InputRow name="2026 HRR rate" tooltip="primaryPct — blended 2026/2025 hit rate" color="#3fb950"
          why="Base rate: how often does this player record at least 1 H+R+RBI in a game this season. Trust-weighted against 2025 so early-season small samples don't wildly over- or under-predict." />
        <InputRow name="H2H vs pitcher" tooltip="softPct — hit rate in direct matchup history (≥12 games)" color="#3fb950"
          why="Head-to-head matchup history vs tonight's exact pitcher. Requires ≥5 gamelog dates. When ≥12 H2H games exist, this also drives 2pts in the Matchup Rate SimScore component." />
        <InputRow name="Platoon-adjusted fallback" tooltip="softPct when H2H < 12 games — uses batter vsL/vsR BA split" color="#e3b341"
          why="When pitcher H2H < 5 games (~90% of matchups), falls back to primaryPct × (batter's BA vs pitcher's hand ÷ season BA). Captures the directional platoon split without needing a large H2H sample." />
        <InputRow name="B2 — Recent form" tooltip="last 10 games — 0.3/0.7 blend with season rate when ≥20 AB" color="#e3b341"
          why="hitterEffectiveBA = 0.3 × recentBA + 0.7 × seasonBA when ≥20 AB in last 10 games, fed into simulateHits. Weight is 0.3/0.7 (reduced from 0.6/0.4) — 40 PAs is deep in BABIP noise; this still catches real slumps without letting a bad week hijack a season baseline." />
        <InputRow name="Park factor" tooltip="PARK_HITFACTOR — applied via log-odds to prevent >100% distortion" color="#8b949e"
          why="Applied via log-odds transform (not direct multiply) so the combined rate can't exceed 100% even for elite batters at Coors Field." />
      </Section>

      <Section title="MLB H+R+RBI — SimScore (max 10)">
        <div style={s.sub}>5 components × 2 pts each. Gate: hitterFinalSimScore ≥ 8 to qualify.</div>
        <ScoreRow pts="0–2" name="Batter Quality (spot + barrel%)"
          tiers="Spot ≤5 + barrel% ≥10% → 2pts · either → 1pt · neither → 0pts"
          why="Lineup spots 1–5 capture both PA equity (top of order) and RBI equity (cleanup/5-hole sluggers). Barrel% ≥10% means hard contact quality. Combined, they measure both opportunity and execution." />
        <ScoreRow pts="0–2" name="Pitcher WHIP"
          tiers=">1.35 → 2pts · >1.20 → 1pt · ≤1.20 → 0pts"
          why="WHIP directly measures baserunner creation rate. A pitcher with WHIP >1.35 allows 35%+ more baserunners than a perfect game. More baserunners = more scoring chances = more HRR opportunities." />
        <ScoreRow pts="0–2" name="Season Hit Rate"
          tiers="≥80% → 2pts · ≥70% → 1pt · &lt;70% → 0pts"
          why="The player's own historical HRR 1+ rate at this threshold, blended 2026/2025. The most direct calibration signal — if a player records HRR in 80%+ of games, the model's output should be in that range." />
        <ScoreRow pts="0–2" name="Matchup Rate"
          tiers="BvP path (≥12 H2H games): ≥80% → 2pts · ≥70% → 1pt · else → 0pts · 8–11 games caps at 1pt · Platoon path (&lt;12 games): advantage ≥1.08 → 2pts · neutral ≥0.95 → 1pt · disadvantage → 0pts"
          why="Platoon-adjusted rate is the primary signal for ~90% of matchups. BvP (≥12 H2H games, ~35+ PAs) is a mature enough sample to override the platoon path. Below 12 games, the platoon advantage/disadvantage (batter's split BA vs pitcher's hand relative to season BA) is used instead." />
        <ScoreRow pts="0–2" name="Game O/U line"
          tiers="≥9.5 → 2pts · ≥7.5 → 1pt · &lt;7.5 → 0pts"
          why="High-scoring game environments increase HRR probability — more runs scored means more R/RBI available. A game with O/U ≥9.5 has consensus expectations of a high-scoring affair." />
      </Section>
    </>
  ),
  "nba": (
    <>
      <Section title="NBA Player Props — True% Model">
        <div style={s.sub}>Normal distribution Monte Carlo (nSim scales 2k–10k based on pre-edge SimScore)</div>

        <div style={s.h3}>Core Formula</div>
        <Formula>{`Build distribution: buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim, miscAdj)

adjustedMean = recentMean × dvpFactor × (1 + paceAdj×0.002) × b2bMult × miscAdj

where:
  recentMean = average of last 10 games (recency)
  fullSeasonStd = standard deviation from full season (stability)
  dvpFactor = leagueAvg / oppDefensiveValue (position-adjusted)
  paceAdj = (oppPace - leagueAvgPace) → more possessions = higher stat
  b2bMult = 0.93 if back-to-back, else 1.0
  miscAdj = C2 × C3 × C4 combined scalar`}</Formula>

        <div style={s.h3}>Model Inputs</div>
        <InputRow name="Last 10 game values" tooltip="mean used for recency; full-season std used for stability" color="#3fb950"
          why="Recency-weighted mean: a player's last 10 games reflect current role, health, and form better than a season average that includes early-season lineup changes or pre-injury games." />
        <InputRow name="Full season std deviation" color="#3fb950"
          why="Variance is a player trait more stable than mean. Using full season prevents one outlier game from inflating the distribution width." />
        <InputRow name="DVP" tooltip="Defense vs Position — opponent's rate of allowing this stat to this position" color="#3fb950"
          why="Position-adjusted opponent defense. A PG scoring 25 PPG vs a team that allows 28 PPG to PGs (vs 24 league avg) gets a ~17% boost. The most important external factor." />
        <InputRow name="Pace adjustment" color="#e3b341"
          why="More possessions = more opportunities. A 5-possession pace advantage translates to ~1% mean boost. Applied continuously, not binary." />
        <InputRow name="C2 — Injury boost" color="#e3b341"
          why="×1.08 per key teammate Out (capped 1.15×). Missing teammates create a usage vacuum — the remaining players absorb extra shot attempts, assists, and minutes." />
        <InputRow name="C3 — Blowout risk" color="#e3b341"
          why="max(0.85, 1 − (|spread|−10)×0.007) when |spread|>10. Garbage time = reduced minutes for starters. A 15-point spread reduces expected output ~3.5%." />
        <InputRow name="C4 — Home/Away split" color="#e3b341"
          why="0.7 × homeMean + 0.3 × awayMean (or inverse for road games), vs overall mean. Many players have systematic home/away splits that persist over seasons." />
        <InputRow name="B2B" tooltip="back-to-back — mean ×0.93 when player played yesterday" color="#8b949e"
          why="×0.93 across the board. Statistically proven ~7% per-game decline on the second night of back-to-backs. Applied to mean before simulation." />
      </Section>

      <Section title="NBA Props — SimScore (max 10)">
        <div style={s.sub}>5 components × 2 pts each. Gate: nbaSimScore ≥ 8.</div>
        <ScoreRow pts="0–2" name="C1 — Opportunity signal"
          tiers="USG% ≥28% → 2pts · ≥22% → 1pt · &lt;22% → 0pts (pts/ast/3pt) | AvgMin ≥30 → 2pts · ≥25 → 1pt (reb)"
          why="Different stats need different opportunity proxies. Usage rate drives points/assists/3-pointers — a player can't rack up stats without the ball. Minutes drives rebounds — floor time is the primary rebounding opportunity." />
        <ScoreRow pts="0–2" name="DVP ratio (pos-adjusted)"
          tiers="ratio ≥1.05 → 2pts · ratio ≥1.02 → 1pt · else 0pts"
          why="Quantifies how much worse the opponent's defense is vs league average at this position. A ratio of 1.10 means the opponent allows 10% more of this stat than average — a meaningful, reproducible edge." />
        <ScoreRow pts="0–2" name="Season Hit Rate"
          tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts"
          why="Player's blended 2026/2025 rate at this threshold. The base rate calibration — if a player hits 25+ points in 90% of games, the model's 87% truePct needs to be at least in that ballpark." />
        <ScoreRow pts="0–2" name="Soft Matchup Hit Rate"
          tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts · null → 1pt abstain"
          why="Hit rate specifically against bottom-tier defenses (similar to tonight's opponent). More comparable to the actual matchup than the overall rate. Null when no soft-team games in sample." />
        <ScoreRow pts="0–2" name="Pace + Game Total"
          tiers="Both favorable (pace>0 AND total ≥225) → 2pts · one → 1pt · neither → 0pts"
          why="Pace and game total are independent corroborating signals. A fast-paced game with a high market O/U means both teams are expected to score — two separate sources of evidence vs one." />
      </Section>
    </>
  ),
  "nhl": (
    <>
      <Section title="NHL Points — True% Model">
        <div style={s.sub}>Normal distribution Monte Carlo (same engine as NBA, adapted for hockey)</div>

        <div style={s.h3}>Core Formula</div>
        <Formula>{`adjustedMean = recentMean × teamDefFactor × toiTrendAdj × b2bMult

where:
  recentMean = average points per game (recent games)
  teamDefFactor = oppGAA / leagueAvgGAA  (higher GAA = softer defense = boost)
  toiTrendAdj = clamp(recent3TOI / last10TOI, 0.92, 1.08)
    applied only when ratio >1.05 (boost) or <0.95 (penalty)
  b2bMult = 0.93 if back-to-back`}</Formula>

        <div style={s.h3}>Model Inputs</div>
        <InputRow name="Per-game point values (mean)" color="#3fb950"
          why="Points (G+A) per game from recent gamelog. NHL scoring is sparse — 0 or 1 is typical — so the distribution is a normal approximation over historical rates." />
        <InputRow name="Opponent GAA" tooltip="goals-against average — higher = weaker defense = more expected scoring" color="#3fb950"
          why="GAA is the primary defensive quality signal in hockey. A goalie/team with GAA 3.5 allows 40% more goals than one at 2.5 — directly translating to more scoring opportunities and higher assist generation." />
        <InputRow name="D3 — TOI trend" color="#e3b341"
          why="Ice time is the primary opportunity driver in hockey. A player whose last 3 games averaged 21 min vs their 10-game avg of 18 min is getting more deployment — that trend is predictive. Declining TOI is a strong negative signal the stats alone won't capture." />
        <InputRow name="B2B" tooltip="back-to-back — mean ×0.93 when player played yesterday" color="#8b949e"
          why="Same logic as NBA. ×0.93 for second-night games. NHL schedule has frequent back-to-backs that produce real fatigue effects." />
      </Section>

      <Section title="NHL Points — SimScore (max 10)">
        <div style={s.sub}>5 components × 2 pts each. Gate: nhlSimScore ≥ 8.</div>
        <ScoreRow pts="0–2" name="Avg TOI (ice time)"
          tiers="≥18 min → 2pts · ≥15 min → 1pt · &lt;15 min → 0pts"
          why="Ice time is the direct opportunity signal in hockey. 18+ minutes means the player is a top-pair/top-line contributor with consistent deployment. Under 15 means limited role — even a great matchup won't help much." />
        <ScoreRow pts="0–2" name="Opponent GAA rank"
          tiers="≤10th worst → 2pts · ≤15th worst → 1pt · else 0pts"
          why="Ranking captures relative weakness vs absolute numbers. A bottom-10 goaltending situation is actionable; middle-of-pack defenses provide little edge." />
        <ScoreRow pts="0–2" name="Season Hit Rate"
          tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts"
          why="Player's career hit rate at this threshold across all games. The base-rate calibration for the simulation output." />
        <ScoreRow pts="0–2" name="DVP Hit Rate (vs soft defenses)"
          tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts · &lt;3 games → 1pt abstain"
          why="Rate specifically in games vs teams with GAA above league average (similar to tonight). Direct analogue to the actual matchup conditions." />
        <ScoreRow pts="0–2" name="Game O/U line"
          tiers="≥7 → 2pts · ≥5.5 → 1pt · &lt;5.5 → 0pts"
          why="Market consensus on game scoring. A high O/U line means more expected goals, which means more scoring chances and more assist opportunities for all players on both teams." />
      </Section>
    </>
  ),
  "mlb-gt": (
    <>
      <Section title="MLB Game Total — True% Model">
        <div style={s.sub}>Poisson Monte Carlo (10,000 trials). Models each team's run-scoring independently.</div>

        <div style={s.h3}>Core Formula</div>
        <Formula>{`// Road RPG strips home-park bias — parkRF applies cleanly
// 60/40 blend: 60% tonight's starter ERA, 40% season team ERA (bullpen proxy)
awayMult = 0.6×(awayERA÷4.20) + 0.4×(awayTeamERA÷4.20)
homeMult = 0.6×(homeERA÷4.20) + 0.4×(homeTeamERA÷4.20)

// platoonFactor = (lineup BA vs opposing starter's hand) / (lineup overall BA)
homeLambda = clamp(homeRoadRPG × awayMult × parkRF × homePlatoonFactor, 1, 12)
awayLambda = clamp(awayRoadRPG × homeMult × parkRF × awayPlatoonFactor, 1, 12)

Each trial: homeRuns ~ Poisson(homeLambda), awayRuns ~ Poisson(awayLambda)
truePct = fraction of trials where homeRuns + awayRuns ≥ threshold`}</Formula>

        <div style={s.h3}>Model Inputs</div>
        <InputRow name="Road RPG" tooltip="away-only runs per game — strips home-park inflation" color="#3fb950"
          why="Offensive baseline using only road games — eliminates home park inflation before parkRF is applied. A team at Coors averages 5.8 RPG overall but 4.9 on the road; using road RPG lets parkRF do its job cleanly without double-counting." />
        <InputRow name="Starter ERA + Team ERA" tooltip="60/40 blend — starter governs ~5.5 IP, team ERA proxies bullpen" color="#3fb950"
          why="Tonight's starter governs 60% of innings (~5.5 IP). The team's season ERA governs 40% (bullpen). Using a blend prevents an ace from dragging a shaky pen's expected runs to zero — and regresses a spot-starter's tiny 3-start ERA toward team reality." />
        <InputRow name="Platoon factor" tooltip="lineup composite BA vs starter's hand ÷ overall BA" color="#3fb950"
          why="A dimensionless ratio: (lineup composite BA vs LHP or RHP) / (lineup overall BA), aggregated across tonight's confirmed lineup. A left-heavy lineup facing a tough LHP gets a factor below 1.0; a right-dominant lineup facing a RHP gets a slight boost. Park effects cancel in the ratio. Falls back to 1.0 when starter hand is unknown or lineup sample is too small." />
        <InputRow name="Park run factor" tooltip="PARK_RUNFACTOR — applied to road RPG; symmetric since both teams play same park" color="#e3b341"
          why="Applied cleanly to road RPG numerator. Coors Field +15%; Petco Park −10%. Both teams play the same park, so the factor is symmetric." />
        <InputRow name="Market O/U line" color="#8b949e"
          why="Used in SimScore as a corroborating signal. The market incorporates weather, wind, and lineup factors not in our model." />
      </Section>

      <Section title="MLB Game Total — SimScore (max 10)">
        <div style={s.sub}>5 components × 2 pts each. Gate: totalSimScore ≥ 8 (OVER). Inverted for UNDER.</div>
        <ScoreRow pts="0–2" name="Home ERA"
          tiers=">4.5 → 2pts · >3.5 → 1pt · ≤3.5 → 0pts"
          why="High ERA = hittable pitcher = more expected runs. Kept as an independent component because it directly sets the ERA-multiplier inside the lambda formula." />
        <ScoreRow pts="0–2" name="Away ERA"
          tiers=">4.5 → 2pts · >3.5 → 1pt · ≤3.5 → 0pts"
          why="Same as home ERA — each starter contributes independently to the scoring environment." />
        <ScoreRow pts="0–2" name="Combined road RPG"
          tiers="≥10.5 → 2pts · ≥9.0 → 1pt · &lt;9.0 → 0pts"
          why="Sum of both teams' road RPG. Consolidates two separate RPG signals into one — confirms both offenses are genuinely high-scoring on neutral turf before parkRF is applied." />
        <ScoreRow pts="0–2" name="Umpire run factor"
          tiers="≥1.05 → 2pts · ≥0.97 → 1pt · &lt;0.97 → 0pts"
          why="Derived from UMPIRE_KFACTOR (1 / kFactor). A loose-zone umpire (low K-factor) generates more walks and hitter-friendly counts, correlating with higher run-scoring. Fully independent of team stats — the first true external validator in the SimScore." />
        <ScoreRow pts="0–2" name="Market O/U line"
          tiers="≥9.5 → 2pts · ≥7.5 → 1pt · &lt;7.5 → 0pts"
          why="Independent corroboration from the betting market. When both the model and the market are bullish on scoring, confidence is higher." />
      </Section>
    </>
  ),
  "nba-gt": (
    <>
      <Section title="NBA Game Total — True% Model">
        <div style={s.sub}>Normal distribution Monte Carlo. Possession-based projection separates scoring efficiency from game tempo.</div>

        <div style={s.h3}>Core Formula</div>
        <Formula>{`// Derived ratings (ESPN has no offensiveRating/defensiveRating stat)
OffRtg  = avgPoints / paceFactor × 100       ← from ESPN team stats
DefRtg  = defPPGAllowed / paceFactor × 100   ← from ESPN team stats + nbaDefRank

projPace = (homePace × awayPace) / leagueAvgPace   ← geometric mean

homeExpected = (homeOffRtg × awayDefRtg / leagueAvgOffRtg²) × projPace
awayExpected = (awayOffRtg × homeDefRtg / leagueAvgOffRtg²) × projPace
expectedTotal = homeExpected + awayExpected

Distribution: Normal(expectedTotal, std=11 per team)
truePct = P(total ≥ threshold)`}</Formula>

        <div style={s.h3}>Model Inputs</div>
        <InputRow name="Offensive Rating (OffRtg)" tooltip="Derived: avgPoints / pace × 100 — efficiency-only, pace-neutral" color="#3fb950"
          why="Raw PPG conflates pace and efficiency, double-counting tempo when two fast teams meet. OffRtg isolates how well a team scores per possession, independent of how many possessions they get. Derived from ESPN avgPoints ÷ paceFactor since ESPN has no direct offensiveRating stat." />
        <InputRow name="Defensive Rating (DefRtg)" tooltip="Derived: defPPGAllowed / pace × 100 — higher = worse defense" color="#3fb950"
          why="Symmetric to OffRtg. A high DefRtg (e.g. 118) means the defense leaks points per possession, boosting the opponent's expected output for this matchup. Derived from ESPN defensive PPG allowed ÷ pace." />
        <InputRow name="Projected pace (geometric mean)" tooltip="(homePace × awayPace) / leagueAvgPace — possessions per game" color="#3fb950"
          why="Pace controls volume: two fast teams playing each other produce more possessions than their individual pace numbers suggest. The geometric mean correctly captures this compounding effect (vs simple average which underestimates extremes)." />
        <InputRow name="League avg offensive rating" color="#8b949e"
          why="Normalization denominator. Squaring it (leagueAvgOffRtg²) balances the fact that both OffRtg and DefRtg are in the numerator, keeping the expected value centered at league-average total when both teams are average." />
      </Section>

      <Section title="NBA Game Total — SimScore (max 10)">
        <div style={s.sub}>5 independent validators × 2 pts each. Gate: totalSimScore ≥ 8. Inverted for UNDER.</div>
        <ScoreRow pts="0–2" name="Combined pace"
          tiers="Both > lgAvg+2 → 2pts · One > lgAvg → 1pt · else 0pts · null → 1pt abstain"
          why="Validates the volume assumption: fast-paced teams have more possessions and thus more scoring opportunities. If neither team plays fast, the projection needs pace-neutral offense to justify the threshold — a harder bar." />
        <ScoreRow pts="0–2" name="Home team OffRtg"
          tiers="≥118 → 2pts · ≥113 → 1pt · <113 → 0pts · null → 1pt abstain"
          why="Elite offenses (top-5) reliably push totals over mid-range thresholds. The 118/113 tiers match league percentile breaks for the top ~25% and top ~50% of offenses." />
        <ScoreRow pts="0–2" name="Away team OffRtg"
          tiers="≥118 → 2pts · ≥113 → 1pt · <113 → 0pts · null → 1pt abstain"
          why="Same logic applied to the road team. Both offenses must be productive to sustain high totals — one elite offense against a stingy defense can still produce a low game." />
        <ScoreRow pts="0–2" name="Combined injuries (both teams)"
          tiers="0 out → 2pts · 1–2 out → 1pt · 3+ out → 0pts · null → 1pt abstain"
          why="Season OffRtg/DefRtg assumes the full roster is playing. Stars sitting out (load management, rest, injury) directly depress scoring without appearing in the ratings. UNDER inverted: 3+ out → 2pts." />
        <ScoreRow pts="0–2" name="Market O/U line"
          tiers="≥235 → 2pts · ≥225 → 1pt · <225 → 0pts · null → 1pt abstain"
          why="The sharpest independent validator available. Vegas sets lines after seeing the same OffRtg, DefRtg, pace, and injury data — agreement between the model and the market is meaningful confirmation that the environment supports the threshold." />
      </Section>
    </>
  ),
  "nhl-gt": (
    <>
      <Section title="NHL Game Total — True% Model">
        <div style={s.sub}>Poisson Monte Carlo. Each team's goals modeled as independent Poisson processes.</div>

        <div style={s.h3}>Core Formula</div>
        <Formula>{`homeLambda = clamp(homeGPG × (awayGAA / leagueAvgGAA), 0.5, 8)
awayLambda = clamp(awayGPG × (homeGAA / leagueAvgGAA), 0.5, 8)

Each trial: homeGoals ~ Poisson(homeLambda), awayGoals ~ Poisson(awayLambda)
truePct = fraction of trials where homeGoals + awayGoals ≥ threshold`}</Formula>

        <div style={s.h3}>Model Inputs</div>
        <InputRow name="Team GPG" tooltip="goals per game — season scoring rate per team" color="#3fb950"
          why="Offensive baseline. How many goals does this team score against an average goalie?" />
        <InputRow name="Opponent GAA" tooltip="goals-against average — higher = weaker defense = more expected scoring" color="#3fb950"
          why="Defensive quality. A GAA of 3.5 means the goalie/defense allows 40% more goals than a 2.5 GAA team — a large effect on expected scoring." />
        <InputRow name="League avg GAA" color="#8b949e"
          why="Normalization. Dividing opponent GAA by league avg converts it to a relative defensive quality factor (1.0 = average, >1.0 = above average = more goals expected)." />
      </Section>

      <Section title="NHL Game Total — SimScore (max 10)">
        <div style={s.sub}>5 components × 2 pts each. Gate: totalSimScore ≥ 8. Inverted for UNDER.</div>
        <ScoreRow pts="0–2" name="Home GPG"
          tiers="≥3.5 → 2pts · ≥3.0 → 1pt · &lt;3.0 → 0pts"
          why="High-scoring team increases expected total. Two independent GPG inputs because both teams contribute." />
        <ScoreRow pts="0–2" name="Away GPG"
          tiers="≥3.5 → 2pts · ≥3.0 → 1pt · &lt;3.0 → 0pts"
          why="Same — away team offense contributes independently." />
        <ScoreRow pts="0–2" name="Home GAA"
          tiers="≥3.5 → 2pts · ≥3.0 → 1pt · &lt;3.0 → 0pts"
          why="Bad goaltending/defense (high GAA) means more goals allowed — good for overs." />
        <ScoreRow pts="0–2" name="Away GAA"
          tiers="≥3.5 → 2pts · ≥3.0 → 1pt · &lt;3.0 → 0pts"
          why="Same — away goaltending quality affects home team's expected goal count." />
        <ScoreRow pts="0–2" name="Market O/U line"
          tiers="≥7 → 2pts · ≥5.5 → 1pt · &lt;5.5 → 0pts"
          why="Independent market signal. NHL lines near 7 reflect expectations of two aggressive offenses or poor goaltending. Lines below 5.5 signal a likely defensive, low-scoring game." />
      </Section>
    </>
  ),
  "mlb-tt": (
    <>
      <Section title="MLB Team Total — True% Model">
        <div style={s.sub}>Poisson Monte Carlo for a single team's run-scoring. Same engine as game totals, one team only.</div>

        <div style={s.h3}>Core Formula</div>
        <Formula>{`// platoonFactor = (lineup BA vs opp starter's hand) / (lineup overall BA)
lambda = clamp(teamRPG × (oppERA ÷ 4.20) × parkRF × platoonFactor, 0.5, 12)

Each trial: teamRuns ~ Poisson(lambda)
truePct = fraction of trials where teamRuns ≥ threshold`}</Formula>

        <div style={s.h3}>Model Inputs</div>
        <InputRow name="Scoring team RPG" color="#3fb950"
          why="Baseline offensive production. How many runs does this team score per game against average pitching?" />
        <InputRow name="Opponent starter ERA" color="#3fb950"
          why="Tonight's pitcher quality for the opponent. A 5.5 ERA pitcher allows 31% more runs than the 4.20 league average." />
        <InputRow name="Platoon factor" tooltip="lineup composite BA vs starter's hand ÷ overall BA" color="#3fb950"
          why="Same as game total — (lineup composite BA vs starter's hand) / (lineup overall BA). Captures the scoring team's platoon advantage or disadvantage against tonight's starter." />
        <InputRow name="Park run factor" color="#e3b341"
          why="Same as game total. Both teams play in the same park, so a hitter-friendly environment boosts the scoring team's expected runs." />
      </Section>

      <Section title="MLB Team Total — SimScore (max 10)">
        <div style={s.sub}>5 components × 2 pts each. Gate: teamTotalSimScore ≥ 8.</div>
        <ScoreRow pts="0–2" name="Umpire run factor"
          tiers="≥1.05 → 2pts · ≥0.97 → 1pt · &lt;0.97 → 0pts · unknown → 1pt abstain"
          why="Home plate umpires have measurable, persistent tendencies for run-scoring environments. A factor ≥1.05 means the umpire's strike zone historically produces 5%+ more runs than average — a meaningful environmental edge independent of team or pitcher quality." />
        <ScoreRow pts="0–2" name="Opponent WHIP"
          tiers="&gt;1.35 → 2pts · &gt;1.20 → 1pt · ≤1.20 → 0pts · null → 1pt abstain"
          why="WHIP captures both hits and walks — total baserunner traffic — which is more directly tied to run-scoring than ERA alone. A pitcher with WHIP >1.35 is putting runners on base at a rate that consistently translates to runs." />
        <ScoreRow pts="0–2" name="Team L10 RPG"
          tiers="&gt;5.0 → 2pts · &gt;4.0 → 1pt · ≤4.0 → 0pts · null → 1pt abstain"
          why="The team's run-scoring rate over the last 10 games. Recent form is a better predictor than season RPG because it captures current lineup health, hot/cold streaks, and recent scheduling effects." />
        <ScoreRow pts="0–2" name="H2H Hit Rate"
          tiers="≥80% → 2pts · ≥60% → 1pt · &lt;60% → 0pts · &lt;3 H2H games → 1pt abstain"
          why="How often has this team scored ≥ threshold in their last 10 head-to-head games vs this opponent? Captures matchup-specific tendencies (ballpark familiarity, historical lineup matchups) not fully reflected in ERA/WHIP averages." />
        <ScoreRow pts="0–2" name="Game O/U line"
          tiers="≥9.5 → 2pts · ≥7.5 → 1pt · &lt;7.5 → 0pts"
          why="Market consensus on total game scoring. A high game O/U means both teams' run environments are favorable — independent confirmation that run conditions are elevated." />
      </Section>
    </>
  ),
  "nba-tt": (
    <>
      <Section title="NBA Team Total — True% Model">
        <div style={s.sub}>Normal distribution Monte Carlo for a single team's point total.</div>

        <div style={s.h3}>Core Formula</div>
        <Formula>{`mean = teamOffPPG × (oppDefPPG / leagueAvgDef)
std = 11 (fixed per-team standard deviation)

Distribution: Normal(mean, std)
truePct = P(teamPoints ≥ threshold)`}</Formula>

        <div style={s.h3}>Model Inputs</div>
        <InputRow name="Team offensive PPG" color="#3fb950"
          why="Baseline scoring rate. Uses regular season stats to avoid playoff sample distortion." />
        <InputRow name="Opponent defensive PPG allowed" color="#3fb950"
          why="A team allowing 120 PPG vs league avg 114 means a ~5% boost to the scoring team's expected points." />
        <InputRow name="League avg defensive PPG" color="#8b949e"
          why="Normalization — converts opponent defense into a relative quality factor." />
      </Section>

      <Section title="NBA Team Total — SimScore (max 10)">
        <div style={s.sub}>5 components × 2 pts each. Gate: teamTotalSimScore ≥ 8.</div>
        <ScoreRow pts="0–2" name="Team off PPG"
          tiers="≥118 → 2pts · ≥113 → 1pt · else 0pts"
          why="High-scoring offense increases the expected team point total. Teams averaging 118+ are elite scorers who regularly approach or exceed typical thresholds." />
        <ScoreRow pts="0–2" name="Opponent def PPG allowed"
          tiers="≥118 → 2pts · ≥113 → 1pt · else 0pts"
          why="Bad defense (allows lots of points) creates a more permissive scoring environment for the scoring team. A team giving up 120+ PPG is the ideal opponent for an over bet." />
        <ScoreRow pts="0–2" name="Game O/U line"
          tiers="≥235 → 2pts · ≥225 → 1pt · else 0pts"
          why="Market consensus. A high game total implies a fast pace and/or poor defenses on both sides — corroborating the team total model." />
        <ScoreRow pts="0–2" name="Team pace vs league avg"
          tiers=">lgPace+2 → 2pts · >lgPace−2 → 1pt · else 0pts"
          why="Pace determines possessions, and possessions determine scoring opportunities. A team running 5 possessions faster per game than average has meaningfully more chances to score." />
        <ScoreRow pts="0–2" name="H2H Hit Rate"
          tiers="≥80% → 2pts · ≥60% → 1pt · &lt;60% → 0pts · &lt;3 H2H games → 1pt abstain"
          why="How often has this team scored ≥ threshold in their last 10 games vs this opponent? Captures historical scoring tendencies in this specific matchup." />
      </Section>
    </>
  ),
};

// --- ReportPage --------------------------------------------------------------------

function ReportPage({
  onBack,
  // Market Report data
  reportSort, setReportSort,
  reportDataBySport,
  reportLoadingSport,
  reportSport, setReportSport,
  fetchReport,
  // Calibration data
  calibData, calibLoading, fetchCalib, authToken,
  // Shared nav
  navigateToPlayer, navigateToTeam,
  // Entry hints from useRouting
  initialTab,
  initialSport,
}) {
  // Inputs `reportSport` / `setReportSport` are still owned by useReportData so the
  // homepage report-button entry can pre-seed before navigation. They mirror the
  // dropdown's "sport" selection 1:1.
  const startSport = initialSport && PLAY_TYPES[initialSport] ? initialSport : (reportSport || "mlb");
  React.useEffect(() => {
    if (initialSport && initialSport !== reportSport) setReportSport(initialSport);
  // One-shot — only honor `initialSport` on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [tab, setTab] = React.useState(initialTab === "market" ? "market" : "model");
  const [playTypeId, setPlayTypeId] = React.useState(PLAY_TYPES[startSport][0].id);

  // When sport changes via dropdown, reset play type to the first valid for that sport.
  const onSportChange = (sp) => {
    setReportSport(sp);
    setPlayTypeId(PLAY_TYPES[sp][0].id);
  };

  const sport = reportSport && PLAY_TYPES[reportSport] ? reportSport : startSport;
  const playType = _findPlayType(sport, playTypeId);

  // Auto-fetch logic
  React.useEffect(() => {
    if (tab === "market" && !reportDataBySport[sport] && reportLoadingSport !== sport) {
      fetchReport(sport);
    }
  }, [tab, sport, reportDataBySport, reportLoadingSport, fetchReport]);
  React.useEffect(() => {
    if (tab === "model" && authToken && !calibData && !calibLoading) fetchCalib();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, authToken]);

  const reportData = reportDataBySport[sport] || null;
  const reportLoading = reportLoadingSport === sport;

  // Build filtered + grouped market data for the visible play type
  const marketGroups = React.useMemo(() => {
    if (!reportData || reportData.error) return [];
    const _isQ = (p) => p.dcQualified === true && (p.edge ?? 0) >= 5 && (p.dataConfidence ?? 0) === 10;
    const plays = (reportData.plays || []).map(p => ({ ...p, qualified: _isQ(p) }));
    const dropped = (reportData.dropped || []).map(p => ({ ...p, qualified: false }));
    const filtered = [...plays, ...dropped].filter(m => m.sport === sport && playType.statKeys.includes(m.stat));
    const groups = {};
    for (const m of filtered) {
      const isTotType = m.gameType === "total" || m.gameType === "teamTotal";
      const dir = isTotType ? (m.direction ?? "over") : null;
      const key = dir ? `${m.sport}|${m.stat}|${dir}` : `${m.sport}|${m.stat}`;
      if (!groups[key]) groups[key] = { sport: m.sport, stat: m.stat, direction: dir, items: [] };
      groups[key].items.push(m);
    }
    const STAT_ORD = { strikeouts:0, hrr:1, hits:2, totalRuns:3, teamRuns:4, points:0, rebounds:1, assists:2, threePointers:3, teamPoints:4, totalPoints:5, totalGoals:1 };
    return Object.values(groups).sort((a, b) => {
      const stOrd = (STAT_ORD[a.stat]??99) - (STAT_ORD[b.stat]??99);
      if (stOrd !== 0) return stOrd;
      const dirOrd = v => v === "over" ? 0 : v === "under" ? 1 : -1;
      return dirOrd(a.direction) - dirOrd(b.direction);
    });
  }, [reportData, sport, playType]);

  return (
    <div style={{maxWidth:1280,margin:"0 auto",padding:"16px 16px"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",marginBottom:14,gap:12}}>
        <button onClick={onBack}
          style={{background:"transparent",border:"1px solid #30363d",borderRadius:6,
            color:"#8b949e",fontSize:12,padding:"4px 10px",cursor:"pointer"}}>
          ← Back
        </button>
        <div>
          <div style={{color:"#c9d1d9",fontSize:17,fontWeight:700}}>Report</div>
          <div style={{color:"#484f58",fontSize:11,marginTop:2}}>Market Report + Model Reference, per sport and play type</div>
        </div>
      </div>

      {/* Sport + play-type dropdowns */}
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:10}}>
        <div style={{display:"flex",flexDirection:"column",gap:3}}>
          <label style={{color:"#484f58",fontSize:10,fontWeight:600}}>SPORT</label>
          <select value={sport} onChange={e => onSportChange(e.target.value)}
            style={{background:"#0d1117",color:"#c9d1d9",border:"1px solid #30363d",borderRadius:6,fontSize:12,padding:"5px 8px",cursor:"pointer",minWidth:110}}>
            {SPORTS.map(sp => <option key={sp} value={sp}>{sp.toUpperCase()}</option>)}
          </select>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:3,flex:1,minWidth:200}}>
          <label style={{color:"#484f58",fontSize:10,fontWeight:600}}>PLAY TYPE</label>
          <select value={playTypeId} onChange={e => setPlayTypeId(e.target.value)}
            style={{background:"#0d1117",color:"#c9d1d9",border:"1px solid #30363d",borderRadius:6,fontSize:12,padding:"5px 8px",cursor:"pointer",width:"100%"}}>
            {PLAY_TYPES[sport].map(pt => <option key={pt.id} value={pt.id}>{pt.label}</option>)}
          </select>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{display:"flex",gap:4,marginBottom:14,borderBottom:"1px solid #21262d"}}>
        {[
          { id:"market", label:"Market Report" },
          { id:"model",  label:"Model Reference" },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{padding:"6px 14px",borderRadius:"6px 6px 0 0",border:"none",cursor:"pointer",fontSize:12,
              background: tab===t.id ? "#161b22" : "transparent",
              color: tab===t.id ? "#c9d1d9" : "#484f58",
              fontWeight: tab===t.id ? 700 : 400,
              borderBottom: tab===t.id ? "1px solid #161b22" : "1px solid transparent",
              marginBottom:-1}}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "market" && (
        <div>
          {reportLoading && <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>Loading market data…</div>}
          {reportData?.error && <div style={{color:"#f78166",textAlign:"center",padding:40,fontSize:13}}>Error: {reportData.error}</div>}
          {!reportData && !reportLoading && <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>No data loaded.</div>}
          {reportData && !reportLoading && marketGroups.length === 0 && (
            <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>No markets for {sport.toUpperCase()} {playType.label}.</div>
          )}
          {reportData && !reportLoading && marketGroups.map(g => (
            <MarketGroupSection key={g.direction ? `${g.sport}|${g.stat}|${g.direction}` : `${g.sport}|${g.stat}`}
              group={g}
              reportSort={reportSort}
              setReportSort={setReportSort}
              navigateToPlayer={navigateToPlayer}
              navigateToTeam={navigateToTeam}
            />
          ))}
        </div>
      )}

      {tab === "model" && (
        <div>
          {/* Qualification summary */}
          <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:10,padding:"10px 14px",marginBottom:12,
            display:"flex",gap:24,flexWrap:"wrap"}}>
            <div>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>MARKET GATE</div>
              <div style={{color:"#58a6ff",fontSize:12,fontWeight:600}}>Kalshi implied ≥ 70%</div>
              <div style={{color:"#484f58",fontSize:10}}>Only markets the book prices likely</div>
            </div>
            <div>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>EDGE GATE</div>
              <div style={{color:"#3fb950",fontSize:12,fontWeight:600}}>True% − Kalshi% ≥ 5%</div>
              <div style={{color:"#484f58",fontSize:10}}>Model must disagree meaningfully</div>
            </div>
            <div>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>DATA CONFIDENCE</div>
              <div style={{color:"#e3b341",fontSize:12,fontWeight:600}}>dc = 10 / 10</div>
              <div style={{color:"#484f58",fontSize:10}}>Clean inputs — all three must pass</div>
            </div>
            <div style={{borderLeft:"1px solid #21262d",paddingLeft:24}}>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>EDGE CALC</div>
              <div style={{color:"#c9d1d9",fontSize:11}}>edge = truePct − kalshiPct</div>
              <div style={{color:"#484f58",fontSize:10}}>Kalshi price = YES ask (fill price); no spread deduction</div>
            </div>
          </div>

          {MODEL_CONTENT[playType.id]}
          <CalibModule tabId={playType.id} calibData={calibData} calibLoading={calibLoading} fetchCalib={fetchCalib} authToken={authToken} />
        </div>
      )}
    </div>
  );
}

export default ReportPage;
