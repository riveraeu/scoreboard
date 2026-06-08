import React from 'react';
import { SPORT_KEY, TEAM_DB, passesCategoryGate } from '../lib/constants.js';
import Tip from './Tip.jsx';

const _teamShort = (abbr, sport) => {
  if (!abbr) return abbr;
  const entry = TEAM_DB.find(t => t.abbr === abbr && t.sport === sport) || TEAM_DB.find(t => t.abbr === abbr);
  return entry?.short ?? abbr;
};

// Sport + play-type catalog. Each entry maps a single dropdown selection to:
//   - tabId      → calibration category key (drives the Results tab's bucket lookup)
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
    { id: "wnba",          label: "Props (Pts/Reb/Ast/3P)", statKeys: ["points", "rebounds", "assists", "threePointers"] },
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
  // freshness: kalshiStale = hard drop (-4 → dc=6); lowVolume = warning (-2)
  kalshiStale: "freshness", lowVolume: "freshness",
  // lineup: bench-only warnings (-2)
  nbaBench: "lineup", wnbaBench: "lineup",
  // availability: playerOut = hard drop (-10); questionable + heavy team injury = warnings
  playerOut: "availability", playerQuestionable: "availability",
  nbaHomeHeavyInjury: "availability", nbaAwayHeavyInjury: "availability",
  wnbaHomeHeavyInjury: "availability", wnbaAwayHeavyInjury: "availability",
  // distance: threshold distance + model/market divergence warnings (-1 to -2)
  modestlyFromLine: "distance", farFromLine: "distance",
  seasonRateDivergent: "distance", spreadModelMarketDivergent: "distance",
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
  "wnba":    ["wnba|points","wnba|rebounds","wnba|assists","wnba|threePointers"],
  "wnba-ml": ["wnba|ml"],
  "wnba-spread": ["wnba|spread"],
  "nhl-ml":  ["nhl|ml"],
  "nhl-spread": ["nhl|spread"],
};

// Used by CalibModule for the calibration-card chrome.
const _CARD_STYLE = { background:"#161b22", border:"1px solid #30363d", borderRadius:10, padding:"14px 18px", marginBottom:12 };

function mergeBuckets(arrays) {
  const LABELS = ["70-75","75-80","80-85","85-90","90-95","95+"];
  const PREDICTED = [72.5, 77.5, 82.5, 87.5, 92.5, 97.5];
  return LABELS.map((label, i) => {
    let wins = 0, n = 0, kalshiWtSum = 0, kalshiWtN = 0;
    for (const arr of arrays) {
      const b = arr.find(x => x.bucket === label);
      if (!b) continue;
      wins += Math.round((b.actual ?? 0) / 100 * b.n);
      n += b.n;
      if (b.avgKalshiPct != null) { kalshiWtSum += b.avgKalshiPct * b.n; kalshiWtN += b.n; }
    }
    const actual = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
    const avgKalshiPct = kalshiWtN > 0 ? parseFloat((kalshiWtSum / kalshiWtN).toFixed(1)) : null;
    const roi = actual != null && avgKalshiPct != null ? parseFloat((actual / 100 - avgKalshiPct / 100).toFixed(4)) : null;
    return { bucket: label, predicted: PREDICTED[i], actual, n, delta: actual != null ? parseFloat((actual - PREDICTED[i]).toFixed(1)) : null, avgKalshiPct, roi };
  });
}
const deltaColor = d => d == null ? "#8b949e" : d >= 3 ? "#3fb950" : d <= -3 ? "#f78166" : "#e3b341";
const barW = pct => pct != null ? `${Math.min(100, pct)}%` : "0%";
const thCalib = { padding:"5px 10px", color:"#6e7681", fontSize:11, fontWeight:600, textAlign:"left", borderBottom:"1px solid #21262d", whiteSpace:"nowrap" };
const tdCalib = { padding:"5px 10px", fontSize:11, borderBottom:"1px solid #161b22" };

function CalibModule({ tabId, calibData, calibLoading, fetchCalib, isLoggedIn }) {
  const cats = TAB_CAT[tabId] || [];
  const isKTab = tabId === "mlb-k";

  if (!isLoggedIn) return (
    <div style={{..._CARD_STYLE, marginTop:8}}>
      <div style={{color:"#484f58", fontSize:12}}>Log in to see calibration data for this model.</div>
    </div>
  );
  if (calibLoading) return (
    <div style={{..._CARD_STYLE, marginTop:8}}>
      <div style={{color:"#8b949e", fontSize:12}}>Loading calibration data…</div>
    </div>
  );
  if (!calibData || calibData.error) return (
    <div style={{..._CARD_STYLE, marginTop:8}}>
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
    if (d) {
      acc.n += d.n;
      acc.wins += Math.round(d.hitRate / 100 * d.n);
      if (d.avgKalshiPct != null) { acc.kalshiWtSum += d.avgKalshiPct * d.n; acc.kalshiWtN += d.n; }
    }
    return acc;
  }, { n: 0, wins: 0, kalshiWtSum: 0, kalshiWtN: 0 });
  const catHitRate = catTotals.n > 0 ? (catTotals.wins / catTotals.n * 100).toFixed(1) : null;
  const catAvgKalshi = catTotals.kalshiWtN > 0 ? catTotals.kalshiWtSum / catTotals.kalshiWtN : null;
  const catRoi = catHitRate != null && catAvgKalshi != null ? parseFloat(catHitRate) / 100 - catAvgKalshi / 100 : null;
  const hasData = catTotals.n > 0;

  return (
    <div style={{..._CARD_STYLE, marginTop:8}}>
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:hasData?12:0}}>
        <div style={{display:"flex", alignItems:"center", gap:10}}>
          <span style={{color:"#c9d1d9", fontSize:13, fontWeight:700}}>Calibration</span>
          {hasData && <span style={{background:"#21262d", color:"#8b949e", fontSize:11, borderRadius:10, padding:"1px 8px"}}>{catTotals.n} picks</span>}
          {hasData && catHitRate && (
            <span style={{color: parseFloat(catHitRate)>=70?"#3fb950":parseFloat(catHitRate)>=60?"#e3b341":"#f78166", fontSize:12, fontWeight:600}}>{catHitRate}% hit rate</span>
          )}
          {hasData && catRoi != null && (
            <span style={{color:_roiColor(catRoi), fontSize:12, fontWeight:600}}>ROI {_roiFmt(catRoi)}</span>
          )}
        </div>
        <button onClick={fetchCalib} style={{fontSize:11,padding:"3px 10px",borderRadius:6,cursor:"pointer",border:"1px solid #30363d",background:"transparent",color:"#8b949e"}}>↻</button>
      </div>

      {!hasData ? (
        <div style={{color:"#484f58", fontSize:12}}>No finalized picks yet for this category.</div>
      ) : (
        <>
          <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d",marginBottom:isKTab?14:0}}>
            <thead><tr>{["Bucket","N","Predicted","Actual","Delta","ROI",""].map(h=><th key={h} style={thCalib}>{h}</th>)}</tr></thead>
            <tbody>
              {bucketRows.map(b => (
                <tr key={b.bucket}>
                  <td style={tdCalib}><span style={{color:"#c9d1d9"}}>{b.bucket}%</span></td>
                  <td style={{...tdCalib, color:b.n<5?"#484f58":b.n<10?"#6e7681":"#c9d1d9"}}>{b.n||"—"}</td>
                  <td style={{...tdCalib, color:"#8b949e"}}>{b.predicted.toFixed(1)}%</td>
                  <td style={{...tdCalib, color:b.actual==null?"#484f58":b.actual>=70?"#3fb950":b.actual>=60?"#e3b341":"#f78166"}}>{b.actual!=null?`${b.actual}%`:"—"}</td>
                  <td style={{...tdCalib, color:deltaColor(b.delta)}}>{b.delta!=null?(b.delta>=0?`+${b.delta}`:b.delta):"—"}</td>
                  <td style={{...tdCalib, color:_roiColor(b.roi), fontWeight:b.roi!=null?600:400}}>{_roiFmt(b.roi)}</td>
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

  const _isGameType = stat === "spread" || stat === "ml" || _isTotalsType;
  const xcols = [
    {k:"dc", l:"DC"},
    {k:"dcMkt", l:"Mkt"},
    ...(!_isGameType ? [{k:"dcLineup", l:"Lineup"}, {k:"dcAvail", l:"Avail"}] : []),
    ...(_isTotalsType ? [{k:"dcDist", l:"Dist"}] : []),
  ];
  const DASH = <span style={{color:"#21262d"}}>—</span>;
  const _GROUP_NAME = { freshness: "Market quality", lineup: "Lineup", availability: "Availability", distance: "Model/market divergence" };
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
      const pens = Object.entries(m.dcPenalties || {});
      const tip = pens.length === 0 ? `DC ${dc}/10 (no penalties)` : `DC ${dc}/10\n` + pens.map(([k, v]) => `${k} ${v}`).join('\n');
      const color = dc >= 9 ? "#3fb950" : dc >= 7 ? "#8b949e" : "#f78166";
      return <Tip tip={tip} style={{color, fontWeight: 600, cursor: "pointer"}}>{dc}/10</Tip>;
    }
    if (k==="dcMkt") return _dcCell(m, "freshness");
    if (k==="dcLineup") return _dcCell(m, "lineup");
    if (k==="dcAvail") return _dcCell(m, "availability");
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
    dc: "dataConfidence (0–10) — display signal only, not a gate. Starts at 10; penalties like farFromLine, seasonRateDivergent, lowVolume etc. reduce the score for informational purposes. Hover for the penalty breakdown.",
    dcMkt: "Market quality — kalshiStale (hard drop, −4) or lowVolume (warning, −2). ✓ = no penalty.",
    dcLineup: "Bench penalty — nbaBench / wnbaBench (−2). ✓ = starter or unconfirmed.",
    dcAvail: "Availability — playerOut (hard drop, −10), playerQuestionable (−2), heavy team injury (−1). ✓ = no concerns.",
    dcDist: "Model/market divergence — farFromLine (−2), modestlyFromLine (−1), seasonRateDivergent (−2), spreadModelMarketDivergent (−1). Totals & spreads. ✓ = aligned.",
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
        {_hdr("gate","Gate")}
        {!stat.startsWith("total") && !stat.startsWith("team") && stat !== "spread" && stat !== "ml" && _hdr("opp","Opp",{flex:_oppFlex})}
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
              <div style={{flex:1,fontSize:10,textAlign:"right"}}>
                {m.qualified ? null : (() => {
                  const reasons = [];
                  if (!m.dcQualified) reasons.push(<span key="dc" style={{color:"#f78166"}}>dc</span>);
                  if ((m.edge ?? 0) < 5) reasons.push(<span key="edge" style={{color:"#e3b341"}}>edge</span>);
                  if (!passesCategoryGate(m)) reasons.push(<span key="cat" style={{color:"#8b949e"}}>cat</span>);
                  // Server dropped before client gates (e.g. kalshi_out_of_window) — show raw reason
                  if (reasons.length === 0 && m.reason) reasons.push(<span key="svr" style={{color:"#484f58"}}>{m.reason.replace(/_/g," ")}</span>);
                  return reasons.length === 0 ? <span style={{color:"#484f58"}}>?</span> : reasons.reduce((acc, r, i) => i === 0 ? [r] : [...acc, <span key={`s${i}`} style={{color:"#30363d"}}> · </span>, r], []);
                })()}
              </div>
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

// --- ShadowCalibModule ------------------------------------------------------------
// Renders unbiased calibration from Neon shadow_plays (all model predictions,
// no edge/dc gate). Used to decide when a category is ready for passesCategoryGate().

const ACTIVE_CATS = new Set(['mlb|strikeouts', 'wnba|points', 'wnba|rebounds']); // mirrors passesCategoryGate()
const _roiColor = r => r == null ? "#8b949e" : r >= 0.02 ? "#3fb950" : r <= -0.02 ? "#f78166" : "#e3b341";
const _roiFmt = r => r == null ? "—" : `${r >= 0 ? "+" : ""}${(r * 100).toFixed(1)}%`;

const _SC_BANDS = ["0-5","5-10","10-15","15-20","20-25","25-30","30-35","35-40","40-45","45-50","50-55","55-60","60-65","65-70","70-75","75-80","80-85","85-90","90-95","95+"];
const _scBandMid = {"0-5":2.5,"5-10":7.5,"10-15":12.5,"15-20":17.5,"20-25":22.5,"25-30":27.5,"30-35":32.5,"35-40":37.5,"40-45":42.5,"45-50":47.5,"50-55":52.5,"55-60":57.5,"60-65":62.5,"65-70":67.5,"70-75":72.5,"75-80":77.5,"80-85":82.5,"85-90":87.5,"90-95":92.5,"95+":97.5};

function _sinceDate(key) {
  const now = new Date();
  if (key === '60d') { const d = new Date(now - 60*24*60*60*1000); return d.toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'}); }
  if (key === 'all') return '2026-06-01'; // shadow logging started
  // 30d default
  const d = new Date(now - 30*24*60*60*1000);
  return d.toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
}

function _catStatus(key, d) {
  if (ACTIVE_CATS.has(key)) return { label: 'Active', color: '#3fb950' };
  if ((d.n ?? 0) >= 50 && (d.roi ?? -1) > 0) return { label: 'Building', color: '#e3b341' };
  if ((d.n ?? 0) >= 30 && (d.roi ?? 0) <= 0) return { label: 'Losing', color: '#f78166' };
  return { label: 'Too few', color: '#484f58' };
}

function ShadowCalibModule({ sport, statKeys, shadowCalibData, shadowCalibLoading, fetchShadowCalib, shadowAnalysisData, fetchShadowAnalysis, isLoggedIn }) {
  const [sinceKey, setSinceKey] = React.useState('30d');
  const [selectedCat, setSelectedCat] = React.useState(null);
  const [showCorr, setShowCorr] = React.useState(false);

  React.useEffect(() => {
    if (isLoggedIn) fetchShadowCalib(_sinceDate(sinceKey));
  // Re-fetch when the window changes. fetchShadowCalib is stable (useCallback []).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceKey, isLoggedIn]);

  // Auto-open the first (highest-n) category whenever data or the active filter changes.
  React.useEffect(() => {
    if (!shadowCalibData?.byCategory) return;
    const firstKey = Object.entries(shadowCalibData.byCategory)
      .filter(([key]) => {
        if (sport && !key.startsWith(sport + '|')) return false;
        if (statKeys?.length && !statKeys.includes(key.split('|')[1])) return false;
        return true;
      })
      .sort(([, a], [, b]) => (b.n ?? 0) - (a.n ?? 0))[0]?.[0] ?? null;
    setSelectedCat(firstKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadowCalibData, sport, statKeys]);

  if (!isLoggedIn) return (
    <div style={{..._CARD_STYLE}}>
      <div style={{color:"#484f58",fontSize:12}}>Log in to see shadow calibration data.</div>
    </div>
  );

  if (shadowCalibLoading) return (
    <div style={{..._CARD_STYLE}}>
      <div style={{color:"#8b949e",fontSize:12}}>Loading shadow calibration…</div>
    </div>
  );

  const sinceButtons = (
    <div style={{display:"flex",gap:4}}>
      {['30d','60d','all'].map(k => (
        <button key={k} onClick={() => setSinceKey(k)}
          style={{fontSize:11,padding:"2px 8px",borderRadius:5,cursor:"pointer",border:"1px solid #30363d",
            background: sinceKey===k ? "#21262d" : "transparent",
            color: sinceKey===k ? "#c9d1d9" : "#484f58", fontWeight: sinceKey===k ? 700 : 400}}>
          {k}
        </button>
      ))}
    </div>
  );

  if (!shadowCalibData || shadowCalibData.error) return (
    <div style={{..._CARD_STYLE}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <span style={{color:"#c9d1d9",fontSize:13,fontWeight:700}}>Shadow Calibration</span>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {sinceButtons}
          <button onClick={() => fetchShadowCalib(_sinceDate(sinceKey))}
            style={{fontSize:11,padding:"3px 10px",borderRadius:6,cursor:"pointer",border:"1px solid #30363d",background:"transparent",color:"#8b949e"}}>↻</button>
        </div>
      </div>
      <div style={{color:"#484f58",fontSize:12}}>{shadowCalibData?.error ? `Error: ${shadowCalibData.error}` : "Shadow calibration not yet loaded."}</div>
    </div>
  );

  // Filter categories by selected sport + play type
  const allCats = Object.entries(shadowCalibData.byCategory || {})
    .filter(([key]) => {
      if (sport && !key.startsWith(sport + '|')) return false;
      if (statKeys?.length) {
        const stat = key.split('|')[1];
        if (!statKeys.includes(stat)) return false;
      }
      return true;
    })
    .sort(([, a], [, b]) => (b.n ?? 0) - (a.n ?? 0));

  const detailBands = selectedCat
    ? (shadowCalibData.byCategoryDetail?.[selectedCat] || [])
    : [];

  return (
    <div style={{..._CARD_STYLE}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{color:"#c9d1d9",fontSize:13,fontWeight:700}}>Shadow Calibration</span>
          <span style={{background:"#21262d",color:"#6e7681",fontSize:10,borderRadius:10,padding:"1px 8px"}}>
            unbiased · best-threshold · n={shadowCalibData.n ?? 0}
          </span>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {sinceButtons}
          <button onClick={() => fetchShadowCalib(_sinceDate(sinceKey))}
            style={{fontSize:11,padding:"3px 10px",borderRadius:6,cursor:"pointer",border:"1px solid #30363d",background:"transparent",color:"#8b949e"}}>↻</button>
        </div>
      </div>

      {/* Category summary table */}
      {allCats.length === 0 ? (
        <div style={{color:"#484f58",fontSize:12}}>No resolved shadow plays for {sport?.toUpperCase() ?? "any sport"} yet.</div>
      ) : (
        <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d",marginBottom:selectedCat?12:0}}>
          <thead>
            <tr>{["Category","N","Hit%","ROI","Status",""].map(h => <th key={h} style={thCalib}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {allCats.map(([key, d]) => {
              const status = _catStatus(key, d);
              const isSelected = selectedCat === key;
              return (
                <tr key={key}
                  onClick={() => setSelectedCat(isSelected ? null : key)}
                  style={{cursor:"pointer", background: isSelected ? "#161b22" : "transparent"}}>
                  <td style={{...tdCalib,color:"#c9d1d9",fontWeight:isSelected?700:400}}>{key}</td>
                  <td style={{...tdCalib,color:(d.n??0)<10?"#484f58":(d.n??0)<30?"#6e7681":"#c9d1d9"}}>
                    {d.n??0}{d.nRaw != null && d.nRaw > (d.n ?? 0) ? <span style={{color:"#484f58",fontSize:9}}>/{d.nRaw}</span> : null}
                  </td>
                  <td style={{...tdCalib,color:(d.hitRate??0)>=70?"#3fb950":(d.hitRate??0)>=60?"#e3b341":"#f78166",fontWeight:600}}>
                    {d.hitRate!=null?`${d.hitRate}%`:"—"}
                  </td>
                  <td style={{...tdCalib,color:_roiColor(d.roi),fontWeight:600}}>{_roiFmt(d.roi)}</td>
                  <td style={{...tdCalib}}><span style={{color:status.color,fontSize:10,fontWeight:600}}>{status.label}</span></td>
                  <td style={{...tdCalib,color:"#484f58",fontSize:10}}>{isSelected?"▲":"▼"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Correlation analysis — expandable, lazy-loaded */}
      {isLoggedIn && (
        <div style={{marginTop:10}}>
          <button
            onClick={() => { if (!showCorr && !shadowAnalysisData) fetchShadowAnalysis?.(); setShowCorr(v => !v); }}
            style={{fontSize:11,padding:"2px 9px",borderRadius:5,cursor:"pointer",border:"1px solid #30363d",background:"transparent",color:"#484f58"}}>
            {showCorr ? '▲' : '▼'} Correlation analysis
          </button>
          {showCorr && (() => {
            const pairs = (shadowAnalysisData?.sameGamePairs || []).filter(p => !sport || p.sport === sport);
            const unanim = (shadowAnalysisData?.intraGroupCorr || []).filter(p => !sport || p.sport === sport);
            if (!shadowAnalysisData) return <div style={{color:"#8b949e",fontSize:12,marginTop:8}}>Loading…</div>;
            if (shadowAnalysisData.error) return <div style={{color:"#f78166",fontSize:12,marginTop:8}}>{shadowAnalysisData.error}</div>;
            const hasCorrData = pairs.length > 0 || unanim.length > 0;
            if (!hasCorrData) return <div style={{color:"#484f58",fontSize:12,marginTop:8}}>No correlation data for {sport?.toUpperCase() ?? "any sport"} yet.</div>;
            return (
              <div style={{marginTop:8}}>
                {pairs.length > 0 && (
                  <div style={{marginBottom:8}}>
                    <div style={{color:"#8b949e",fontSize:11,fontWeight:600,marginBottom:4}}>Same-game pair φ (Place All reduces correlated groups to 1 Kelly slot)</div>
                    <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d"}}>
                      <thead><tr>{["Pair","N","φ","Hit A%","Hit B%","Joint%"].map(h=><th key={h} style={thCalib}>{h}</th>)}</tr></thead>
                      <tbody>
                        {pairs.map((p,i) => {
                          const phi = parseFloat(p.phi ?? 0);
                          const pc = phi >= 0.6 ? "#f97316" : phi >= 0.3 ? "#e3b341" : phi <= -0.3 ? "#58a6ff" : "#8b949e";
                          return <tr key={i}>
                            <td style={{...tdCalib,fontSize:10,color:"#c9d1d9"}}>{p.cat_a} × {p.cat_b}</td>
                            <td style={tdCalib}>{p.n}</td>
                            <td style={{...tdCalib,color:pc,fontWeight:600}}>{phi>=0?`+${phi}`:String(phi)}</td>
                            <td style={tdCalib}>{p.hit_a}%</td>
                            <td style={tdCalib}>{p.hit_b}%</td>
                            <td style={tdCalib}>{p.joint_hit}%</td>
                          </tr>;
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {unanim.length > 0 && (
                  <div>
                    <div style={{color:"#8b949e",fontSize:11,fontWeight:600,marginBottom:4}}>Alt-line unanimity (high % = same bet at diff thresholds)</div>
                    <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d"}}>
                      <thead><tr>{["Category","Groups","Plays","Avg size","% unanimous"].map(h=><th key={h} style={thCalib}>{h}</th>)}</tr></thead>
                      <tbody>
                        {unanim.map((u,i) => {
                          const pctU = parseFloat(u.pct_unanimous ?? 0);
                          const uc = pctU >= 80 ? "#f78166" : pctU >= 60 ? "#e3b341" : "#8b949e";
                          return <tr key={i}>
                            <td style={{...tdCalib,color:"#c9d1d9"}}>{u.sport}|{u.category}</td>
                            <td style={tdCalib}>{u.n_groups}</td>
                            <td style={tdCalib}>{u.n_plays}</td>
                            <td style={tdCalib}>{u.avg_group_size}</td>
                            <td style={{...tdCalib,color:uc,fontWeight:600}}>{pctU}%</td>
                          </tr>;
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {(() => {
                  const clv = (shadowAnalysisData?.clvAnalysis || []).filter(r => !sport || r.sport === sport);
                  if (!clv.length) return null;
                  return (
                    <div style={{marginTop:8}}>
                      <div style={{color:"#8b949e",fontSize:11,fontWeight:600,marginBottom:4}}>
                        CLV / line movement (3pm → 7pm PT · + = market confirmed model)
                      </div>
                      <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d"}}>
                        <thead><tr>{["Category","N","CLV","Edge@snap","Edge@close","Hit%"].map(h=><th key={h} style={thCalib}>{h}</th>)}</tr></thead>
                        <tbody>
                          {clv.map((r,i) => {
                            const clvV = parseFloat(r.avg_clv_pct ?? 0);
                            const clvC = clvV >= 1 ? "#3fb950" : clvV <= -1 ? "#f78166" : "#e3b341";
                            const edgeSnap = parseFloat(r.avg_edge_at_snap ?? 0);
                            const edgeClose = parseFloat(r.avg_edge_at_close ?? 0);
                            const edgeDrift = edgeClose - edgeSnap;
                            const driftC = edgeDrift >= 0 ? "#3fb950" : "#f78166";
                            return <tr key={i}>
                              <td style={{...tdCalib,color:"#c9d1d9"}}>{r.sport}|{r.category}</td>
                              <td style={tdCalib}>{r.n}</td>
                              <td style={{...tdCalib,color:clvC,fontWeight:600}}>{clvV>=0?`+${clvV.toFixed(1)}`:clvV.toFixed(1)}%</td>
                              <td style={{...tdCalib,color:edgeSnap>=5?"#3fb950":edgeSnap>=2?"#e3b341":"#f78166"}}>{edgeSnap.toFixed(1)}%</td>
                              <td style={{...tdCalib,color:edgeClose>=5?"#3fb950":edgeClose>=2?"#e3b341":"#f78166"}}>
                                {edgeClose.toFixed(1)}%
                                {Math.abs(edgeDrift)>=0.5&&<span style={{color:driftC,fontSize:9,marginLeft:3}}>{edgeDrift>=0?'+':''}{edgeDrift.toFixed(1)}</span>}
                              </td>
                              <td style={{...tdCalib,color:parseFloat(r.hit_rate_pct??0)>=70?"#3fb950":parseFloat(r.hit_rate_pct??0)>=60?"#e3b341":"#f78166",fontWeight:600}}>{r.hit_rate_pct??'—'}%</td>
                            </tr>;
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </div>
            );
          })()}
        </div>
      )}

      {/* Daily volume vs ROI */}
      {(() => {
        const rows = shadowAnalysisData?.dailyVolumeRoi;
        if (!rows || rows.length === 0) return null;
        return (
          <div style={{marginTop:10}}>
            <div style={{color:"#8b949e",fontSize:11,fontWeight:600,marginBottom:4}}>
              Picks/day vs realised ROI (threshold_rank=1 · {shadowAnalysisData?.since} onward)
            </div>
            <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d"}}>
              <thead>
                <tr>{["Picks/day","Days","Total plays","Avg/day","Hit%","Avg price","ROI"].map(h =>
                  <th key={h} style={thCalib}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const roi = parseFloat(r.roi ?? 0);
                  const hit = parseFloat(r.hit_rate_pct ?? 0);
                  const price = parseFloat(r.avg_price_pct ?? 0);
                  return (
                    <tr key={i}>
                      <td style={{...tdCalib,color:"#c9d1d9",fontWeight:600}}>{r.picks_bucket}</td>
                      <td style={tdCalib}>{r.n_days}</td>
                      <td style={tdCalib}>{r.total_plays}</td>
                      <td style={tdCalib}>{r.avg_plays}</td>
                      <td style={{...tdCalib,color:hit>=70?"#3fb950":hit>=60?"#e3b341":"#f78166",fontWeight:600}}>{hit}%</td>
                      <td style={tdCalib}>{price}%</td>
                      <td style={{...tdCalib,color:_roiColor(roi),fontWeight:700}}>{_roiFmt(roi)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })()}

      {/* Band detail for selected category */}
      {selectedCat && (
        <div>
          {(() => {
            const _catD = shadowCalibData.byCategory?.[selectedCat];
            const _n = _catD?.n ?? 0;
            const _nR = _catD?.nRaw;
            return (
              <div style={{color:"#8b949e",fontSize:11,fontWeight:600,marginBottom:6}}>
                {selectedCat} — band detail ({_n} deduped{_nR != null && _nR > _n ? ` · ${_nR} raw` : ''})
              </div>
            );
          })()}
          <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d"}}>
            <thead>
              <tr>{["Band","N","Predicted","Actual","Δ","ROI",""].map(h => <th key={h} style={thCalib}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {_SC_BANDS.map(band => {
                const b = detailBands.find(r => r.band === band) || { band, predicted: _scBandMid[band], actual: null, delta: null, n: 0, roi: null };
                return (
                  <tr key={band}>
                    <td style={tdCalib}><span style={{color:"#c9d1d9"}}>{band}%</span></td>
                    <td style={{...tdCalib,color:b.n<5?"#484f58":b.n<10?"#6e7681":"#c9d1d9"}}>{b.n||"—"}</td>
                    <td style={{...tdCalib,color:"#8b949e"}}>{b.predicted!=null?`${b.predicted}%`:"—"}</td>
                    <td style={{...tdCalib,color:b.actual==null?"#484f58":b.actual>=70?"#3fb950":b.actual>=60?"#e3b341":"#f78166"}}>
                      {b.actual!=null?`${b.actual}%`:"—"}
                    </td>
                    <td style={{...tdCalib,color:deltaColor(b.delta)}}>{b.delta!=null?(b.delta>=0?`+${b.delta}`:b.delta):"—"}</td>
                    <td style={{...tdCalib,color:_roiColor(b.roi),fontWeight:b.roi!=null?600:400}}>{_roiFmt(b.roi)}</td>
                    <td style={{...tdCalib,width:100}}>
                      {b.actual!=null&&(
                        <div style={{position:"relative",height:7,background:"#21262d",borderRadius:4,overflow:"hidden"}}>
                          <div style={{position:"absolute",left:0,top:0,height:"100%",width:barW(b.actual),background:b.actual>=70?"#3fb950":b.actual>=60?"#e3b341":"#f78166",borderRadius:4}}/>
                          <div style={{position:"absolute",left:`${b.predicted}%`,top:0,height:"100%",width:2,background:"#58a6ff",opacity:0.8}}/>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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
  calibData, calibLoading, fetchCalib, isLoggedIn,
  // Shadow calibration
  shadowCalibData, shadowCalibLoading, fetchShadowCalib,
  // Shadow analysis (correlation + threshold rank)
  shadowAnalysisData, shadowAnalysisLoading, fetchShadowAnalysis,
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
    if (tab === "model" && isLoggedIn && !calibData && !calibLoading) fetchCalib();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isLoggedIn]);
  React.useEffect(() => {
    if (tab === "shadow" && isLoggedIn && !shadowCalibData && !shadowCalibLoading) fetchShadowCalib();
  // ShadowCalibModule also re-fetches on since-window change via its own effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isLoggedIn]);
  React.useEffect(() => {
    if (tab === "shadow" && isLoggedIn && !shadowAnalysisData && !shadowAnalysisLoading) fetchShadowAnalysis();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isLoggedIn]);

  const reportData = reportDataBySport[sport] || null;
  const reportLoading = reportLoadingSport === sport;

  // Build filtered + grouped market data for the visible play type
  const marketGroups = React.useMemo(() => {
    if (!reportData || reportData.error) return [];
    const _isQ = (p) => p.dcQualified === true && (p.edge ?? 0) >= 5 && passesCategoryGate(p);
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
        <div style={{color:"#c9d1d9",fontSize:17,fontWeight:700}}>Research</div>
        <div style={{color:"#484f58",fontSize:11,marginLeft:"auto"}}>Market Report + calibration Results</div>
      </div>

      {/* Sport pills + play-type dropdown */}
      <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
        <div style={{display:"flex",gap:4}}>
          {SPORTS.map(sp => (
            <button key={sp} onClick={() => onSportChange(sp)}
              style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:sport===sp?700:600,cursor:"pointer",
                border:`1px solid ${sport===sp?"#58a6ff":"#30363d"}`,
                background: sport===sp ? "rgba(88,166,255,0.12)" : "transparent",
                color: sport===sp ? "#58a6ff" : "#8b949e"}}>
              {sp.toUpperCase()}
            </button>
          ))}
        </div>
        <select value={playTypeId} onChange={e => setPlayTypeId(e.target.value)}
          style={{background:"#0d1117",color:"#c9d1d9",border:"1px solid #30363d",borderRadius:6,fontSize:12,fontWeight:600,padding:"5px 10px",cursor:"pointer",minWidth:200,maxWidth:280}}>
          {PLAY_TYPES[sport].map(pt => <option key={pt.id} value={pt.id}>{pt.label}</option>)}
        </select>
      </div>

      {/* Tab bar */}
      <div style={{display:"flex",gap:4,marginBottom:14,borderBottom:"1px solid #21262d"}}>
        {[
          { id:"market", label:"Market Report" },
          { id:"model",  label:"Results" },
          { id:"shadow", label:"Shadow" },
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
              <div style={{color:"#58a6ff",fontSize:12,fontWeight:600}}>Kalshi implied 67–91%</div>
              <div style={{color:"#484f58",fontSize:10}}>Only markets the book prices likely</div>
            </div>
            <div>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>EDGE GATE</div>
              <div style={{color:"#3fb950",fontSize:12,fontWeight:600}}>True% − Kalshi% ≥ 5%</div>
              <div style={{color:"#484f58",fontSize:10}}>Model must disagree meaningfully</div>
            </div>
            <div>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>CATEGORY GATE</div>
              <div style={{color:"#e3b341",fontSize:12,fontWeight:600}}>Confirmed ROI category</div>
              <div style={{color:"#484f58",fontSize:10}}>Shadow n≥200 ROI{'>'} 0 to promote</div>
            </div>
            <div style={{borderLeft:"1px solid #21262d",paddingLeft:24}}>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>EDGE CALC</div>
              <div style={{color:"#c9d1d9",fontSize:11}}>edge = truePct − kalshiPct</div>
              <div style={{color:"#484f58",fontSize:10}}>Kalshi price = YES ask (fill price); no spread deduction</div>
            </div>
          </div>

          <CalibModule tabId={playType.id} calibData={calibData} calibLoading={calibLoading} fetchCalib={fetchCalib} isLoggedIn={isLoggedIn} />
        </div>
      )}

      {tab === "shadow" && (
        <div>
          <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:10,padding:"10px 14px",marginBottom:12,
            display:"flex",gap:24,flexWrap:"wrap"}}>
            <div>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>SOURCE</div>
              <div style={{color:"#58a6ff",fontSize:12,fontWeight:600}}>All model predictions</div>
              <div style={{color:"#484f58",fontSize:10}}>No edge gate, no dc gate — unbiased</div>
            </div>
            <div>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>PROMOTE WHEN</div>
              <div style={{color:"#3fb950",fontSize:12,fontWeight:600}}>n ≥ 200 · ROI {'>'} 0</div>
              <div style={{color:"#484f58",fontSize:10}}>90% CI positive → add to passesCategoryGate()</div>
            </div>
            <div>
              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>ROI</div>
              <div style={{color:"#c9d1d9",fontSize:11}}>hitRate / 100 − avg market price</div>
              <div style={{color:"#484f58",fontSize:10}}>Expected profit per $1 wagered at Kalshi price</div>
            </div>
          </div>
          <ShadowCalibModule
            sport={sport}
            statKeys={playType.statKeys}
            shadowCalibData={shadowCalibData}
            shadowCalibLoading={shadowCalibLoading}
            fetchShadowCalib={fetchShadowCalib}
            shadowAnalysisData={shadowAnalysisData}
            fetchShadowAnalysis={fetchShadowAnalysis}
            isLoggedIn={isLoggedIn}
          />
        </div>
      )}
    </div>
  );
}

export default ReportPage;
