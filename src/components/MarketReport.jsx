import React from 'react';
import { SPORT_KEY } from '../lib/constants.js';

function buildSimTooltip(m) {
  const isTeamTotal = m.gameType === "teamTotal";
  const isKPlay  = m.finalSimScore != null && m.totalSimScore == null && !isTeamTotal;
  const isHRR    = m.hitterFinalSimScore != null && m.finalSimScore == null && !isTeamTotal;
  const isNBA    = m.nbaSimScore != null && m.totalSimScore == null && !isTeamTotal;
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
      const whipPts = v => v == null ? 1 : v > 1.35 ? 2 : v > 1.20 ? 1 : 0;
      const cRPGPts = cRPG == null ? 1 : cRPG >= 10.5 ? 2 : cRPG >= 9.0 ? 1 : 0;
      const h2hPts = h2hTR == null ? 1 : h2hTR >= 80 ? 2 : h2hTR >= 60 ? 1 : 0;
      return [
        `Comb road RPG (${cRPG != null ? cRPG.toFixed(1) : '—'}): ${cRPGPts}/2`,
        `${m.homeTeam} WHIP (${hW != null ? hW.toFixed(2) : '—'}): ${whipPts(hW)}/2`,
        `${m.awayTeam} WHIP (${aW != null ? aW.toFixed(2) : '—'}): ${whipPts(aW)}/2`,
        `H2H HR% (${h2hTR != null ? h2hTR + '%' : '—'}${m.h2hTotalGames ? ' · ' + m.h2hTotalGames + 'g' : ''}): ${h2hPts}/2`,
        `O/U (${ou ?? '—'}): ${ou != null ? (ou >= 9.5 ? 2 : ou >= 7.5 ? 1 : 0) : 1}/2`,
      ].join('\n');
    }
    if (m.sport === "nba") {
      const cOR = m.combOffRtg, cDR = m.combDefRtg, ou = m.gameOuLine;
      const hp = m.homePace, ap = m.awayPace, lgP = m.leagueAvgPace, pp = m.projPace;
      const rtgPts = v => v == null ? 1 : v >= 118 ? 2 : v >= 113 ? 1 : 0;
      const ouPts = v => v == null ? 1 : v >= 225 ? 2 : v >= 215 ? 1 : 0;
      const pacePts = (hp == null || ap == null || lgP == null) ? 1
        : (hp > lgP + 2 && ap > lgP + 2) ? 2
        : (hp > lgP || ap > lgP) ? 1 : 0;
      const gtH2H = m.nbaGtH2HRate;
      const gtH2HPts = gtH2H == null ? 1 : gtH2H >= 80 ? 2 : gtH2H >= 60 ? 1 : 0;
      return [
        `Pace (proj ${pp ?? '—'}): ${pacePts}/2`,
        `Comb OffRtg (${cOR != null ? cOR.toFixed(1) : '—'}): ${rtgPts(cOR)}/2`,
        `Comb DefRtg (${cDR != null ? cDR.toFixed(1) : '—'}): ${rtgPts(cDR)}/2`,
        `H2H HR% (${gtH2H != null ? gtH2H + '%' : '—'}): ${gtH2HPts}/2`,
        `O/U (${ou ?? '—'}): ${ouPts(ou)}/2`,
      ].join('\n');
    }
    if (m.sport === "nhl") {
      const hGPG = m.homeGPG, aGPG = m.awayGPG, hGAA = m.homeGAA, aGAA = m.awayGAA, ou = m.gameOuLine;
      const gpgPts = v => v == null ? 1 : v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0;
      const gaaPts = v => v == null ? 1 : v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0;
      const ouPts = v => v == null ? 1 : v >= 7 ? 2 : v >= 5.5 ? 1 : 0;
      return [
        `${m.homeTeam} GPG (${hGPG ?? '—'}): ${gpgPts(hGPG)}/2`,
        `${m.awayTeam} GPG (${aGPG ?? '—'}): ${gpgPts(aGPG)}/2`,
        `${m.homeTeam} GAA (${hGAA ?? '—'}): ${gaaPts(hGAA)}/2`,
        `${m.awayTeam} GAA (${aGAA ?? '—'}): ${gaaPts(aGAA)}/2`,
        `O/U (${ou ?? '—'}): ${ouPts(ou)}/2`,
      ].join('\n');
    }
  }
  return null;
}

function MarketReport({ onClose, fetchReport, reportDataBySport, reportSport, setReportSport, reportLoadingSport, reportSort, setReportSort, navigateToPlayer, navigateToTeam }) {
        const reportData = reportDataBySport[reportSport] || null;
        const reportLoading = reportLoadingSport === reportSport;
  return (
        <div style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.88)",overflow:"auto",padding:"20px 16px"}}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
          <div style={{maxWidth:1280,margin:"0 auto",background:"#161b22",borderRadius:12,border:"1px solid #30363d",minHeight:200}}>
            {/* Header */}
            <div style={{display:"flex",alignItems:"center",padding:"14px 20px",borderBottom:"1px solid #30363d"}}>
              <div style={{color:"#c9d1d9",fontWeight:700,fontSize:15}}>Market Report</div>
              {reportData && !reportLoading && (
                <div style={{marginLeft:12,fontSize:11,color:"#8b949e"}}>
                  {(reportData.plays||[]).length} plays · {(reportData.dropped||[]).length} filtered
                </div>
              )}
              <button onClick={() => onClose()}
                style={{marginLeft:"auto",background:"none",border:"none",color:"#8b949e",fontSize:20,cursor:"pointer",lineHeight:1,padding:"0 2px"}}>✕</button>
            </div>
            {/* Sport tabs */}
            <div style={{display:"flex",gap:2,padding:"10px 20px 0",borderBottom:"1px solid #21262d"}}>
              {["mlb","nba","nhl"].map(s => (
                <button key={s} onClick={() => { setReportSport(s); if (!reportDataBySport[s]) fetchReport(s); }} style={{
                  padding:"5px 14px",borderRadius:"6px 6px 0 0",border:"none",cursor:"pointer",fontSize:12,
                  background: reportSport===s ? "#0d1117" : "transparent",
                  color: reportSport===s ? "#c9d1d9" : "#484f58",
                  fontWeight: reportSport===s ? 700 : 400}}>
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
            {/* Body */}
            <div style={{padding:"16px 20px"}}>
              {/* Market report */}
              {reportLoading && <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>Loading market data…</div>}
              {reportData?.error && <div style={{color:"#f78166",textAlign:"center",padding:40,fontSize:13}}>Error: {reportData.error}</div>}
              {!reportData && !reportLoading && <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>No data loaded.</div>}
              {reportData && !reportLoading && (() => {
                const REASON = {
                  edge_too_low: "Edge < 5%",
                  kalshi_pct_too_low: "Implied < 70%",
                  opp_not_soft: "Soft matchup not met",
                  low_confidence: "Sim-Score < 7",
                  team_not_favored: "Team not favored",
                  pitcher_era_too_low: "ERA < 4.0",
                  no_h2h_data: "No career AB vs team",
                  insufficient_ab_vs_pitcher: "< 10 AB vs pitcher",
                  low_batting_avg: "BA < .270",
                  no_opp: "Team not resolved",
                  no_espn_info: "No player data",
                  no_gamelog: "No game log",
                  no_soft_data: "No stat data",
                };
                const STAT_NAME = { points:"Points",rebounds:"Rebounds",assists:"Assists",threePointers:"3-Pointers",goals:"Goals",hits:"Hits",hrr:"H+R+RBI",strikeouts:"Strikeouts",totalRuns:"Totals",totalPoints:"Totals",totalGoals:"Totals",teamRuns:"Team Runs",teamPoints:"Team Points" };
                // Intentionally distinct from SPORT_BADGE_COLOR — report uses higher-contrast hues for section headers
                const REPORT_SPORT_COL = { mlb:"#4ade80", nba:"#f97316", nhl:"#60a5fa" };
                const SPORT_ORD = { mlb:0, nba:1, nhl:2, nfl:3 };

                const plays = (reportData.plays || []).map(p => ({ ...p, qualified: p.qualified !== false }));
                const dropped = (reportData.dropped || []).map(p => ({ ...p, qualified: false }));
                const filtered = [...plays, ...dropped];

                // Group by sport+stat
                const groups = {};
                for (const m of filtered) {
                  const key = `${m.sport}|${m.stat}`;
                  if (!groups[key]) groups[key] = { sport: m.sport, stat: m.stat, items: [] };
                  groups[key].items.push(m);
                }
                const STAT_ORD = { strikeouts:0, hrr:1, hits:2, totalRuns:3, teamRuns:4, points:0, rebounds:1, assists:2, threePointers:3, teamPoints:4, totalPoints:5, totalGoals:1 };
                const sortedGroups = Object.values(groups).sort((a, b) => {
                  const sd = (SPORT_ORD[a.sport]??9) - (SPORT_ORD[b.sport]??9);
                  return sd !== 0 ? sd : (STAT_ORD[a.stat]??99) - (STAT_ORD[b.stat]??99);
                });

                if (sortedGroups.length === 0) return <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>No markets.</div>;

                const CRITERIA_SUMMARIES = {
                  "mlb|hrr":       { note: "True% = logit-park adjusted blended rate \u00b7 Sim-Score \u2265 8 (OPS\u21920-2, WHIP\u21920-2, Ssn HR%\u21920-2, H2H HR%\u21920-2, O/U\u21920-2) = max 10; edge gates separately", gates: ["Lineup spot 1\u20135", "Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "mlb|hits":      { note: "True% = Monte Carlo simulation (batterBA \u00d7 pitcherBAA log5) \u00b7 park-adjusted \u00b7 Sim-Score \u2265 8 (OPS\u21920-2, WHIP\u21920-2, Ssn HR%\u21920-2, H2H HR%\u21920-2, O/U\u21920-2) = max 10; edge gates separately", gates: ["Lineup spot 1\u20135", "Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "mlb|strikeouts":{ note: "True% = Monte Carlo simulation (pitcher K% \u00d7 lineup K% log5) \u00b7 regressed to mean \u00b7 park-adjusted \u00b7 Sim-Score \u2265 8 (CSW%/K%\u21920-2, Lineup K%\u21920-2, Hit Rate %\u21920-2, H2H Hand\u21920-2, O/U\u21920-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "nba|points":    { note: "True% = Monte Carlo simulation \u00b7 B2B \u00d70.93 \u00b7 Sim-Score: C1 USG%(0-2) + DVP(0-2) + Ssn HR%(0-2) + Tier HR%(0-2) + Game Total(0-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "nba|rebounds":  { note: "True% = Monte Carlo simulation \u00b7 B2B \u00d70.93 \u00b7 Sim-Score: C1 AvgMin(0-2) + DVP(0-2) + Ssn HR%(0-2) + Tier HR%(0-2) + Game Total(0-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "nba|assists":   { note: "True% = Monte Carlo simulation \u00b7 B2B \u00d70.93 \u00b7 Sim-Score: C1 USG%(0-2) + DVP(0-2) + Ssn HR%(0-2) + Tier HR%(0-2) + Game Total(0-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "nba|threePointers": { note: "True% = Monte Carlo simulation \u00b7 B2B \u00d70.93 \u00b7 Sim-Score: C1 USG%(0-2) + DVP(0-2) + Ssn HR%(0-2) + Tier HR%(0-2) + Game Total(0-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                };

                return sortedGroups.map(({ sport, stat, items }) => {
                  // Dedupe by playerName|threshold (or homeTeam|awayTeam|threshold for totals), prefer qualified
                  const dedupeMap = {};
                  for (const m of items) {
                    const k = m.gameType === "teamTotal"
                      ? `${m.scoringTeam}|${m.oppTeam}|${m.threshold}${m.direction === "under" ? "|under" : ""}`
                      : m.gameType === "total"
                      ? `${m.homeTeam}|${m.awayTeam}|${m.threshold}${m.direction === "under" ? "|under" : ""}`
                      : `${m.playerName}|${m.threshold}`;
                    if (!dedupeMap[k] || (!dedupeMap[k].qualified && m.qualified)) dedupeMap[k] = m;
                  }
                  const _sortCfg = reportSort[`${sport}|${stat}`];
                  const rows = Object.values(dedupeMap).sort((a, b) => {
                    if (_sortCfg) {
                      const _sv = m => { switch(_sortCfg.col) {
                        case "player": return m.playerName ?? `${m.awayTeam}${m.homeTeam}` ?? "";
                        case "line": return m.threshold ?? 0;
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
                        case "dvp": return m.posDvpRank ?? 99;
                        case "sim": return m.teamTotalSimScore ?? m.totalSimScore ?? m.finalSimScore ?? m.hitterFinalSimScore ?? m.nbaSimScore ?? 0;
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
                        case "ktrend": return m.kTrendPts ?? 0;
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
                        case "ttUmpire": return m.ttUmpirePts ?? 0;
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
                        case "nbaTotInj": return -((m.homeOut ?? 0) + (m.awayOut ?? 0)); // fewer injuries = better for over = sort desc
                        default: return 0;
                      }};
                      const va = _sv(a), vb = _sv(b);
                      const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
                      return _sortCfg.dir === "desc" ? -cmp : cmp;
                    }
                    if ((a.qualified !== false) !== (b.qualified !== false)) return (a.qualified !== false) ? -1 : 1;
                    const sa = a.totalSimScore ?? a.finalSimScore ?? a.hitterFinalSimScore ?? a.nbaSimScore ?? a.nhlSimScore ?? a.simScore ?? a.hitterSimScore ?? 0;
                    const sb = b.totalSimScore ?? b.finalSimScore ?? b.hitterFinalSimScore ?? b.nbaSimScore ?? b.nhlSimScore ?? b.simScore ?? b.hitterSimScore ?? 0;
                    if (sb !== sa) return sb - sa;
                    return (b.edge || b.kalshiPct || 0) - (a.edge || a.kalshiPct || 0);
                  }).filter(r => stat !== "hrr" || r.threshold === 1);
                  const qualCount = rows.filter(r => r.qualified).length;

                  const cs = CRITERIA_SUMMARIES[`${sport}|${stat}`];
                  return (
                    <div key={`${sport}|${stat}`} style={{marginBottom:18}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,paddingBottom:5,borderBottom:"1px solid #21262d",flexWrap:"wrap"}}>
                        <span style={{color:REPORT_SPORT_COL[sport]||"#8b949e",fontWeight:700,fontSize:11}}>{sport.toUpperCase()}</span>
                        <span style={{color:"#8b949e",fontSize:12,marginRight:2}}>{STAT_NAME[stat]||stat}</span>
                        <span style={{color:"#484f58",fontSize:11,marginLeft:"auto"}}>{rows.length} markets · <span style={{color:"#3fb950"}}>{qualCount}</span> play{qualCount!==1?"s":""}</span>
                      </div>
                      {(() => {
                        // Sport+stat specific extra columns
                        const XCOLS = {
                          "mlb|hrr":        [{k:"sim",l:"Score"},{k:"ops",l:"OPS"},{k:"whip",l:"WHIP"},{k:"hSsnHR",l:"Ssn HR%"},{k:"hH2HHR",l:"H2H HR%"},{k:"mlbOu",l:"O/U"}],
                          "mlb|hits":       [{k:"sim",l:"Score"},{k:"ops",l:"OPS"},{k:"whip",l:"WHIP"},{k:"hSsnHR",l:"Ssn HR%"},{k:"hH2HHR",l:"H2H HR%"},{k:"mlbOu",l:"O/U"}],
                          "mlb|strikeouts": [{k:"sim",l:"Score"},{k:"csw",l:"CSW%"},{k:"lkp",l:"Lineup K%"},{k:"kHitRate",l:"Hit Rate %"},{k:"kH2HHand",l:"H2H Hand"},{k:"ou",l:"O/U"}],
                          "nba|points":     [{k:"sim",l:"Score"},{k:"nbaC1",l:"Usage"},{k:"dvp",l:"DVP"},{k:"nbaSeasonHR",l:"Ssn HR%"},{k:"nbaSoftHR",l:"Tier HR%"},{k:"nbaPaceTotal",l:"Game Total"}],
                          "nba|rebounds":   [{k:"sim",l:"Score"},{k:"nbaC1",l:"AvgMin"},{k:"dvp",l:"DVP"},{k:"nbaSeasonHR",l:"Ssn HR%"},{k:"nbaSoftHR",l:"Tier HR%"},{k:"nbaPaceTotal",l:"Game Total"}],
                          "nba|assists":    [{k:"sim",l:"Score"},{k:"nbaC1",l:"Usage"},{k:"dvp",l:"DVP"},{k:"nbaSeasonHR",l:"Ssn HR%"},{k:"nbaSoftHR",l:"Tier HR%"},{k:"nbaPaceTotal",l:"Game Total"}],
                          "nba|threePointers":[{k:"sim",l:"Score"},{k:"nbaC1",l:"Usage"},{k:"dvp",l:"DVP"},{k:"nbaSeasonHR",l:"Ssn HR%"},{k:"nbaSoftHR",l:"Tier HR%"},{k:"nbaPaceTotal",l:"Game Total"}],
                          "nhl|points": [{k:"sim",l:"Score"},{k:"nhltoi",l:"AvgTOI"},{k:"nhlgaa",l:"GAA Rank"},{k:"nhlSeasonHR",l:"Ssn HR%"},{k:"nhlDvpHR",l:"DVP HR%"},{k:"nhlGameTotalOu",l:"O/U"}],
                          "mlb|totalRuns":    [{k:"sim",l:"Score"},{k:"combinedRPG",l:"Comb RPG"},{k:"homeWhip",l:"H WHIP"},{k:"awayWhip",l:"A WHIP"},{k:"gtH2HHR",l:"H2H HR%"},{k:"mlbOu",l:"O/U"}],
                          "nba|totalPoints":  [{k:"sim",l:"Score"},{k:"nbaTotPace",l:"Pace"},{k:"nbaCombOff",l:"Comb OffRtg"},{k:"nbaCombDef",l:"Comb DefRtg"},{k:"nbaGtH2H",l:"H2H HR%"},{k:"totalOu",l:"O/U"}],
                          "nhl|totalGoals":   [{k:"sim",l:"Score"},{k:"homeGPG",l:"H GPG"},{k:"awayGPG",l:"A GPG"},{k:"homeGAA",l:"H GAA"},{k:"awayGAA",l:"A GAA"},{k:"totalOu",l:"O/U"}],
                          "mlb|teamRuns":     [{k:"sim",l:"Score"},{k:"ttSeasonHR",l:"Ssn HR%"},{k:"ttWhip",l:"WHIP"},{k:"ttL10RPG",l:"L10 RPG"},{k:"ttH2HHR",l:"H2H HR%"},{k:"ttOu",l:"O/U"},{k:"ttOpp",l:"Opp"}],
                          "nba|teamPoints":   [{k:"sim",l:"Score"},{k:"ttNbaOff",l:"OffRtg"},{k:"ttNbaDef",l:"DefRtg"},{k:"ttNbaSsnHR",l:"Ssn HR%"},{k:"ttH2HHR",l:"H2H HR%"},{k:"ttOu",l:"O/U"},{k:"ttOpp",l:"Opp"}],
                        };
                        const xcols = XCOLS[`${sport}|${stat}`] || [];
                        const DASH = <span style={{color:"#21262d"}}>—</span>;
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
                          if (k==="ktrend") { const v = m.pitcherRecentKPct; const pts = m.kTrendPts; return C(v != null ? v.toFixed(1)+"%" : null, pts === 2 ? "#3fb950" : pts === 1 ? "#e3b341" : "#f78166"); }
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
                          if (k==="mlbOu") { const v = m.gameOuLine ?? m.hitterGameTotal; return v != null ? <span style={{color:v>=9.5?"#3fb950":v>=7.5?"#e3b341":"#f78166"}}>{v}</span> : DASH; }
                          if (k==="dvp") { const r = m.posDvpRank; return C(r != null ? `#${r}${m.posGroup?" "+m.posGroup:""}` : null, r<=10?"#3fb950":r<=20?"#e3b341":"#f78166"); }
                          if (k==="sim") { const sc = m.teamTotalSimScore ?? m.totalSimScore ?? m.finalSimScore ?? m.hitterFinalSimScore ?? m.nbaSimScore ?? m.nhlSimScore ?? m.simScore ?? m.hitterSimScore; const tip = buildSimTooltip(m); return sc != null ? <span title={tip??undefined} style={{color:sc>=8?"#3fb950":sc>=6?"#e3b341":"#8b949e",fontWeight:600,cursor:tip?"help":"default"}}>{sc}/10</span> : DASH; }
                          if (k==="env") { const pf = m.parkFactor ?? m.hitterParkKF; if (pf == null) return DASH; const pct = Math.round((pf-1)*100); const disp = (pct>=0?"+":"")+pct+"%"; return <span style={{color:pf>1.02?"#3fb950":pf<0.98?"#f78166":"#8b949e"}}>{disp}</span>; }
                          if (k==="brrl") { const b = m.hitterBarrelPct; return b != null ? <span style={{color:b>=14?"#3fb950":b>=10?"#e3b341":b>=7?"#8b949e":"#f78166"}}>{b.toFixed(1)+"%"}</span> : DASH; }
                          if (k==="nbapace") { const p = m.nbaPaceAdj; return p != null ? <span style={{color:p>0?"#3fb950":p>-2?"#e3b341":"#8b949e"}}>{p>0?"+":""}{p.toFixed(1)}</span> : DASH; }
                          if (k==="nbaopp")  { const o = m.nbaOpportunity; return o != null ? <span style={{color:o>=30?"#3fb950":o>=25?"#e3b341":"#f78166"}}>{o.toFixed(0)}m</span> : DASH; }
                          if (k==="nba_b2b") { if (m.isB2B == null) return DASH; return <span style={{color:m.isB2B?"#f78166":"#3fb950"}}>{m.isB2B?"B2B":"Rested"}</span>; }
                          if (k==="nbaC1") { const isReb = m.stat==="rebounds"; const v = isReb ? m.nbaOpportunity : m.nbaUsage; if (v == null) return DASH; const color = isReb ? (v>=30?"#3fb950":v>=25?"#e3b341":"#f78166") : (v>=28?"#3fb950":v>=22?"#e3b341":"#f78166"); return <span style={{color}}>{isReb ? v.toFixed(0)+"m" : v.toFixed(1)+"%"}</span>; }
                          if (k==="nbaOu")   { const v = m.nbaGameTotal; return v != null ? <span style={{color:v>=225?"#3fb950":v>=215?"#e3b341":"#8b949e"}}>{v}</span> : DASH; }
                          if (k==="nbaSeasonHR") { const v = m.seasonPct; const pts = m.nbaSeasonHitRatePts ?? (v==null?1:v>=90?2:v>=80?1:0); const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return v!=null ? <span style={{color}}>{v.toFixed(0)}%</span> : DASH; }
                          if (k==="nbaSoftHR") { const v = m.softPct; if (v==null) return DASH; const pts = m.nbaSoftHitRatePts ?? (v>=90?2:v>=80?1:0); const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
                          if (k==="nbaPaceTotal") { const pts = m.nbaTotalPts ?? 1; const ou = m.nbaGameTotal; const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#8b949e"; return ou != null ? <span style={{color,fontWeight:600}}>{ou}</span> : DASH; }
                          if (k==="nba_spread") { const adj = m.nbaBlowoutAdj; if (adj == null) return DASH; const color = adj===1.0?"#3fb950":adj>0.92?"#e3b341":"#f78166"; const sp = m.nbaBlowoutAdj!=null && adj<1.0 ? Math.round((1-adj)/0.007+10) : null; return <span style={{color}}>{adj===1.0?"Tight":sp!=null?`-${sp}`:"—"}</span>; }
                          if (k==="nhlgaa") { const r = m.oppRank; return C(r != null ? `#${r}` : null, r<=10?"#3fb950":r<=15?"#e3b341":"#f78166"); }
                          if (k==="nhlsa")  { const v = m.nhlShotsAdj; const r = m.nhlSaRank; return v != null ? <span style={{color:(r!=null&&r<=10)?"#3fb950":v>0?"#e3b341":"#f78166"}}>{v>0?"+":""}{v.toFixed(1)}</span> : DASH; }
                          if (k==="nhltoi") { const t = m.nhlOpportunity; return t != null ? <span style={{color:t>=18?"#3fb950":t>=15?"#e3b341":"#f78166"}}>{t.toFixed(1)}m</span> : DASH; }
                          if (k==="nhl_b2b") { if (m.isB2B == null) return DASH; return <span style={{color:m.isB2B?"#f78166":"#3fb950"}}>{m.isB2B?"B2B":"Rested"}</span>; }
                          if (k==="nhlSeasonHR") { const v=m.seasonPct; if (v==null) return DASH; const pts=m.nhlSeasonHitRatePts??(v>=90?2:v>=80?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
                          if (k==="nhlDvpHR") { const v=m.softPct; if (v==null) return DASH; const pts=m.nhlDvpHitRatePts??(v>=90?2:v>=80?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
                          if (k==="nhlGameTotalOu") { const v=m.nhlGameTotal; if (v==null) return DASH; const color=v>=7?"#3fb950":v>=5.5?"#e3b341":"#f78166"; return <span style={{color,fontWeight:600}}>O{v}</span>; }
                          // Total PPG columns
                          if (k==="combinedRPG") { const v = m.combinedRPG; return v != null ? <span style={{color:v>=10.5?"#3fb950":v>=9.0?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
                          if (k==="homeWhip"||k==="awayWhip") { const v = m[k==="homeWhip"?"homeWHIP":"awayWHIP"]; return v!=null ? <span style={{color:v>1.35?"#3fb950":v>1.20?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(2)}</span> : DASH; }
                          if (k==="gtH2HHR") { const v=m.h2hTotalHitRate; const g=m.h2hTotalGames; if (v==null) return DASH; const color=v>=80?"#3fb950":v>=60?"#e3b341":"#f78166"; return <span style={{color}} title={g!=null?`${g} H2H games`:undefined}>{v}%</span>; }
                          if (k==="umpire") { const v = m.umpireRunFactor; if (v==null) return DASH; return <span style={{color:v>=1.05?"#3fb950":v>=0.97?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(3)}</span>; }
                          if (k==="homeRPG"||k==="awayRPG") { const v = m[k]; return v != null ? <span style={{color:v>=5.0?"#3fb950":v>=4.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
                          if (k==="homeERA"||k==="awayERA") { const v = m[k]; return v != null ? <span style={{color:v>=4.5?"#3fb950":v>=3.5?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(2)}</span> : DASH; }
                          if (k==="homeOffRtg"||k==="awayOffRtg") { const v = m[k]; return v != null ? <span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
                          if (k==="homeDefRtg"||k==="awayDefRtg") { const v = m[k]; return v != null ? <span style={{color:v>=118?"#f78166":v>=113?"#e3b341":"#3fb950",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
                          if (k==="nbaTotPace") { const pa = m.projPace != null && m.leagueAvgPace != null ? parseFloat((m.projPace - m.leagueAvgPace).toFixed(1)) : null; if (pa == null) return DASH; const _pp = (m.homePace == null||m.awayPace==null||m.leagueAvgPace==null)?1:(m.homePace>m.leagueAvgPace+2&&m.awayPace>m.leagueAvgPace+2)?2:(m.homePace>m.leagueAvgPace||m.awayPace>m.leagueAvgPace)?1:0; return <span style={{color:_pp===2?"#3fb950":_pp===1?"#e3b341":"#f78166",fontWeight:600}}>{(pa>0?"+":"")+pa}</span>; }
                          if (k==="nbaTotInj") { const tot=(m.homeOut??0)+(m.awayOut??0); const _ip=tot===0?2:tot<=2?1:0; const disp=tot===0?"0 out":`${tot} out`; return <span style={{color:_ip===2?"#3fb950":_ip===1?"#e3b341":"#f78166"}}>{disp}</span>; }
                          if (k==="nbaCombOff") { const v=m.combOffRtg; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
                          if (k==="nbaCombDef") { const v=m.combDefRtg; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
                          if (k==="nbaGtH2H") { const v=m.nbaGtH2HRate; if(v==null) return DASH; const color=v>=80?"#3fb950":v>=60?"#e3b341":"#f78166"; return <span style={{color}}>{v}%</span>; }
                          if (k==="ttNbaOff") { const v=m.teamOffRtg; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
                          if (k==="ttNbaDef") { const v=m.oppDefRtg; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
                          if (k==="ttNbaSsnHR") { const v=m.ttNbaSeasonHitRate; if(v==null) return DASH; const pts=m.ttNbaSeasonHitRatePts??(v>=80?2:v>=60?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color,fontWeight:600}}>{v}%</span>; }
                          if (k==="totalOu") { const v = m.sport==="nba" ? (m.gameOuLine ?? m.threshold) : m.threshold; if (v == null) return DASH; const line = m.sport==="nba" ? v.toFixed(1) : (v-0.5).toFixed(1); const color = m.sport==="nba" ? (v>=225?"#3fb950":v>=215?"#e3b341":"#8b949e") : m.sport==="nhl" ? (v>=6?"#3fb950":v>=5?"#e3b341":"#f78166") : "#8b949e"; return <span style={{color,fontWeight:600}}>O{line}</span>; }
                          if (k==="homeGPG"||k==="awayGPG"||k==="homeGAA"||k==="awayGAA") { const v = m[k]; return v != null ? <span style={{color:v>=3.5?"#3fb950":v>=3.0?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
                          // HRR new SimScore columns
                          if (k==="ops") { const v=m.hitterOps; const pts=m.hitterOpsPts; if (v==null) return DASH; const color=pts===2?"#3fb950":pts===1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(3)}</span>; }
                          if (k==="hQuality") { const pts=m.hitterBatterQualityPts; const sp=m.hitterLineupSpot; const brrl=m.hitterBarrelPct; if (pts==null) return DASH; const color=pts===2?"#3fb950":pts===1?"#e3b341":"#f78166"; const disp=sp!=null?`#${sp}${brrl!=null?' '+brrl.toFixed(0)+'%':''}`:brrl!=null?brrl.toFixed(1)+'%':`${pts}/2`; return <span style={{color}}>{disp}</span>; }
                          if (k==="hSsnHR") { const v=m.seasonPct; if (v==null) return DASH; const pts=m.hitterSeasonHitRatePts ?? (v>=80?2:v>=70?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(1)+"%"}</span>; }
                          if (k==="hH2HHR") { const v=m.softPct; if (v==null) return DASH; const pts=m.hitterH2HHitRatePts ?? (v>=80?2:v>=70?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(1)+"%"}</span>; }
                          // Team total columns
                          if (k==="ttOpp") { return m.oppTeam ? <span onClick={() => { onClose(); navigateToTeam(m.oppTeam, m.sport); }} style={{color:"#8b949e",cursor:"pointer"}}>{m.oppTeam}</span> : DASH; }
                          if (k==="ttH2HHR") { const v=m.h2hHitRate; const g=m.h2hGames; if (v==null) return DASH; const color=v>=80?"#3fb950":v>=60?"#e3b341":"#f78166"; return <span style={{color}} title={g!=null?`${g} H2H games`:undefined}>{v}%</span>; }
                          if (k==="ttTeamRPG") { const v=m.teamRPG; return v!=null?<span style={{color:v>5.0?"#3fb950":v>4.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
                          if (k==="ttOppERA") { const v=m.oppERA; return v!=null?<span style={{color:v>4.5?"#3fb950":v>3.5?"#e3b341":"#8b949e",fontWeight:600}}>{parseFloat(v).toFixed(2)}</span>:DASH; }
                          if (k==="ttOppRPG") { const v=m.oppRPG; return v!=null?<span style={{color:v>5.0?"#3fb950":v>4.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
                          if (k==="ttPark") { const pf=m.parkFactor; if(pf==null) return DASH; const pct=Math.round((pf-1)*100); return <span style={{color:pf>1.05?"#3fb950":pf>1.00?"#e3b341":"#8b949e"}}>{(pct>=0?"+":"")+pct+"%"}</span>; }
                          if (k==="ttUmpire") { const pts=m.ttUmpirePts; const rf=m.umpireRunFactor ?? (m.ttUmpirePts!=null ? null : null); const name=m.umpireName; if (pts==null) return DASH; const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#8b949e"; return <span style={{color}} title={name||undefined}>{pts}/2</span>; }
                          if (k==="ttSeasonHR") { const v=m.ttSeasonHitRate; if (v==null) return DASH; const pts=m.ttSeasonHitRatePts??(v>=80?2:v>=60?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color,fontWeight:600}}>{v}%</span>; }
                          if (k==="ttWhip") { const v=m.oppWHIP; if (v==null) return DASH; const color=v>1.35?"#3fb950":v>1.20?"#e3b341":"#f78166"; return <span style={{color,fontWeight:600}}>{v.toFixed(2)}</span>; }
                          if (k==="ttL10RPG") { const v=m.teamL10RPG; if (v==null) return DASH; const color=v>5.0?"#3fb950":v>4.0?"#e3b341":"#f78166"; return <span style={{color,fontWeight:600}}>{v.toFixed(1)}</span>; }
                          if (k==="ttOu") { const v=m.gameOuLine; if(v==null) return DASH; const color=m.sport==="nba"?(v>=225?"#3fb950":v>=215?"#e3b341":"#8b949e"):(v>=9.5?"#3fb950":v>=7.5?"#e3b341":"#f78166"); return <span style={{color,fontWeight:600}}>{v}</span>; }
                          if (k==="ttTeamOff") { const v=m.teamOff; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(0)}</span>:DASH; }
                          if (k==="ttOppDef") { const v=m.oppDef; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#f78166",fontWeight:600}}>{v.toFixed(0)}</span>:DASH; }
                          if (k==="ttPace") { const pace=m.teamPace,lg=m.leagueAvgPace; if(pace==null||lg==null) return DASH; const d=parseFloat((pace-lg).toFixed(1)); return <span style={{color:d>2?"#3fb950":d>-2?"#e3b341":"#f78166"}}>{d>0?"+":""}{d}</span>; }
                          if (k==="ttSpread") { const sp=m.gameSpread; if(sp==null) return DASH; const abs=Math.abs(sp); return <span style={{color:abs<=5?"#3fb950":abs<=10?"#e3b341":"#f78166"}}>{sp>0?"+":""}{sp.toFixed(1)}</span>; }
                          return DASH;
                        };
                        const RESULT_LABELS = {
                          edge_too_low:"edge low", kalshi_pct_too_low:"<70%",
                          opp_not_soft:"not soft", low_confidence:"low score",
                          team_not_favored:"ML ✗", pitcher_era_too_low:"ERA ✗",
                          no_h2h_data:"no h2h", insufficient_ab_vs_pitcher:"AB ✗",
                          low_batting_avg:"BA ✗", no_opp:"no team",
                          no_espn_info:"no info", no_gamelog:"no log",
                          no_soft_data:"no data", col_not_found:"no col", no_gamelog_vals:"no vals",
                          low_lineup_spot:"spot 5-9", no_simulation_data:"no data",
                        };
                        const _sk = `${sport}|${stat}`;
                        const _sc = reportSort[_sk];
                        const COL_TIPS = {
                          player:"Player name", line:"Prop line threshold",
                          true:"Model True% (Monte Carlo simulation)",
                          kalshi:"Kalshi market price", edge:"Model edge over Kalshi market",
                          opp:"Tonight's opponent / starting pitcher",
                          sim:"Sim-Score (max 10 — 8+ = Alpha tier); hover for component breakdown",
                          env:"Park factor: green = pitcher/hitter-friendly stadium",
                          ml:"Team moneyline (your team's odds)", ou:"Game total (over/under line)",
                          csw:"Called Strike + Whiff% — pitch quality indicator (>30% = green)",
                          kbb:"K% − BB% — command indicator (>15% = green)",
                          lkp:"Opposing lineup K-rate vs this pitcher hand (>24% = green, >22% = yellow, ≤22% = red)",
                          kH2HHand:"Pitcher K hit rate at threshold vs opponents with same lineup hand majority as tonight — ≥80% green (2pts), ≥65% yellow (1pt), <65% red (0pts); null (<5 starts) = 1pt abstain",
                          pps:"Pitcher avg pitches per start (>85 means deeper into games)",
                          spot:"Batting order position (1–3 = green, 4 = yellow, 5+ filtered)",
                          whip:"Pitcher WHIP (H+BB)/IP — >1.35 favors hitter",
                          plat:"Batter split BA vs pitcher hand — green=platoon edge (≥+15%), red=disadvantage",
                          brrl:"Barrel% hard-contact rate (Statcast)",
                          season:"Season hit rate %", h2h:"Hit rate vs soft-DVP opponents",
                          nbapace:"Avg game pace vs league avg (positive = faster pace = more possessions)",
                          nbaC1:"C1 opportunity: USG% for pts/ast/3pt (≥28% green, ≥22% yellow); AvgMin for rebounds (≥30m green, ≥25m yellow)",
                          nbaOu:"Game total (O/U line — ≥225 green, ≥215 yellow, else gray)",
                          nbaSeasonHR:"Season hit rate at this threshold (blended 2026/2025) — ≥90% green, ≥80% yellow, <80% red",
                          nbaSoftHR:"Tier HR% — hit rate vs teams in the same DVP tier as tonight's opponent (soft 1-10, neutral 11-20, hard 21-30) — ≥90% green, ≥80% yellow, <80% red; null = dash (1pt abstain in SimScore)",
                          nbaPaceTotal:"O/U game total line — ≥215 = green (2pts), null = yellow (1pt abstain), <215 = gray (0pts). Pace applied to simulation mean but not scored separately.",
                          nba_spread:"Game spread tightness — tight game (≤10) = full minutes, no garbage time",
                          dvp:"Defense vs Position rank (lower = softer matchup)",
                          nhlgaa:"Opponent GAA rank — ≤10 green (2pts), ≤15 yellow (1pt), >15 red (0pts)",
                          nhlsa:"Shots against adj vs league avg (positive = more shots allowed = more opportunities)",
                          nhltoi:"Player avg ice time last 10 games — ≥18m green (2pts), ≥15m yellow (1pt), <15m red (0pts)",
                          nhl_b2b:"Rest status (B2B = back-to-back game, red; Rested = green)",
                          nhlSeasonHR:"Career season hit rate at threshold — ≥90% green (2pts), ≥80% yellow (1pt), <80% red (0pts)",
                          nhlDvpHR:"Hit rate vs teams with GAA above league avg (≥3 games req) — ≥90% green, ≥80% yellow; null = 1pt abstain",
                          nhlGameTotalOu:"Game O/U line — ≥7 green (2pts), ≥5.5 yellow (1pt), <5.5 red (0pts)",
                          combinedRPG:"Combined road RPG (both teams, away-only stats) — strips home park bias; green ≥10.5 (2pts), yellow ≥9.0 (1pt)",
                          umpire:"Umpire run factor (1/K-factor): loose zone = more walks/scoring; green ≥1.05, yellow ≥0.97, red <0.97. Now applied directly to simulation lambdas.",
                          homeWhip:"Home starter WHIP — baserunner traffic indicator. >1.35 green (2pts, favors over), >1.20 yellow (1pt), ≤1.20 gray (0pts); null = 1pt abstain",
                          awayWhip:"Away starter WHIP — baserunner traffic indicator. >1.35 green (2pts), >1.20 yellow (1pt), ≤1.20 gray (0pts); null = 1pt abstain",
                          gtH2HHR:"H2H combined total hit rate — how often (home+away) combined runs ≥ threshold in last 10 H2H meetings. ≥80% green (2pts), ≥60% yellow (1pt), <60% red (0pts); null = 1pt abstain",
                          homeRPG:"Home team runs per game — higher = more scoring (green ≥5.0, yellow ≥4.0)",
                          awayRPG:"Away team runs per game — higher = more scoring (green ≥5.0, yellow ≥4.0)",
                          homeERA:"Home starter ERA — higher = more hittable pitcher (green ≥4.5, yellow ≥3.5). No longer a SimScore component (replaced by WHIP).",
                          awayERA:"Away starter ERA — higher = more hittable pitcher (green ≥4.5, yellow ≥3.5). No longer a SimScore component (replaced by WHIP).",
                          homeOffRtg:"Home team offensive rating (pts per 100 possessions) — ≥118 green (elite offense), ≥113 yellow, <113 gray",
                          awayOffRtg:"Away team offensive rating (pts per 100 possessions) — ≥118 green, ≥113 yellow, <113 gray",
                          homeDefRtg:"Home team defensive rating (pts allowed per 100 possessions) — lower is better defense; shown for reference",
                          awayDefRtg:"Away team defensive rating (pts allowed per 100 possessions) — lower is better defense; shown for reference",
                          nbaTotPace:"Projected game pace (geometric mean of both teams) vs league avg — positive = faster game = more possessions (green both teams fast, yellow one fast)",
                          nbaTotInj:"Combined players out (home + away) — 0 out = full rosters = max scoring potential (green); 3+ out = depleted lineups (red)",
                          totalOu:"ESPN game O/U line (NBA: green ≥225, yellow ≥215; NHL: green ≥6, yellow ≥5)",
                          homeGPG:"Home team goals per game — higher = better for over (green ≥3.5, yellow ≥3.0)",
                          awayGPG:"Away team goals per game — higher = better for over (green ≥3.5, yellow ≥3.0)",
                          homeGAA:"Home team goals against average — higher = worse defense = good for over (green ≥3.5, yellow ≥3.0)",
                          awayGAA:"Away team goals against average — higher = worse defense = good for over (green ≥3.5, yellow ≥3.0)",
                          kHitRate:"Hit Rate % — blended hit rate at K threshold (trust-weighted 2026/2025) — ≥90% = 2pts green, ≥80% = 1pt yellow, <80% = 0pts red",
                          ops:"2026 season OPS — ≥.850 = 2pts green, ≥.720 = 1pt yellow, <.720 = 0pts red; null = 1pt abstain",
                          hQuality:"Batter quality composite — lineup spot 1–3 + barrel% ≥10%; both = green, one = yellow, neither = red. Shows #spot + barrel%.",
                          hSsnHR:"Season HRR hit rate (2026/2025 blended) — ≥80% = 2pts green, ≥70% = 1pt yellow, <70% = 0pts red",
                          hH2HHR:"BvP: batter's HRR hit rate vs tonight's pitcher (≥10 games). Fallback: Poisson approx from MLB Stats API vsRHP/vsLHP splits (2025+2026 combined, ≥10 games vs that hand). ≥80% = 2pts green, ≥70% = 1pt yellow, <70% = 0pts red; null = 1pt abstain",
                          ttOpp:"Opponent team — click to navigate to team page",
                          ttH2HHR:"H2H hit rate — scoring team scored ≥ threshold in last 10 games vs this opponent — ≥80% green (2pts), ≥60% yellow (1pt), <60% red (0pts); null (<3 H2H games) = 1pt abstain",
                          ttTeamRPG:"Scoring team runs per game (regular season) — higher = better for team runs over (green >5.0, yellow >4.0)",
                          ttOppERA:"Opponent starter ERA — higher = more hittable pitcher = better for over (green >4.5, yellow >3.5)",
                          ttOppRPG:"Opponent runs per game — higher = game environment favors scoring (green >5.0, yellow >4.0)",
                          ttPark:"Park run factor — green = hitter-friendly (>+5% green, >0% yellow)",
                          ttUmpire:"Umpire run factor (1/K-factor) — now applied directly to the simulation lambda; no longer a SimScore component.",
                          ttSeasonHR:"Season HR% — scoring team's rate of scoring ≥ threshold across all completed season games. ≥80% green (2pts), ≥60% yellow (1pt), <60% red (0pts); null = 1pt abstain",
                          ttWhip:"Opponent starter WHIP — measures actual baserunner traffic beyond ERA. green >1.35 (2pts), yellow >1.20 (1pt), ≤1.20 = lockdown (0pts); null = 1pt abstain",
                          ttL10RPG:"Scoring team RPG over last 10 games — momentum signal. green >5.0 (2pts), yellow >4.0 (1pt), ≤4.0 = cold (0pts); null = 1pt abstain",
                          ttOu:"Game O/U line — MLB: green ≥9.5, yellow ≥7.5; NBA: green ≥225, yellow ≥215",
                          nbaCombOff:"Combined avg offensive rating (home+away pts/100poss) — ≥118 green (2pts), ≥113 yellow (1pt), <113 red (0pts); null = 1pt abstain",
                          nbaCombDef:"Combined avg defensive rating (home+away pts allowed/100poss) — higher = weaker combined defense = good for over. ≥118 green (2pts), ≥113 yellow (1pt), <113 red (0pts)",
                          nbaGtH2H:"H2H hit rate — how often combined score ≥ threshold in last 10 H2H meetings. ≥80% green (2pts), ≥60% yellow (1pt), <60% red (0pts); null (<3 H2H) = 1pt abstain",
                          ttNbaOff:"Scoring team offensive rating (pts per 100 possessions) — ≥118 green (2pts, elite), ≥113 yellow (1pt), <113 red (0pts)",
                          ttNbaDef:"Opponent defensive rating (pts allowed per 100 possessions) — higher = worse defense = good for over. ≥118 green (2pts), ≥113 yellow (1pt), <113 red (0pts)",
                          ttNbaSsnHR:"Season HR% — scoring team's rate of scoring ≥ threshold across all completed season games. ≥80% green (2pts), ≥60% yellow (1pt), <60% red (0pts); null = 1pt abstain",
                          ttTeamOff:"Team offensive PPG (regular season) — higher = better for team points over (green ≥118, yellow ≥113)",
                          ttOppDef:"Opponent defensive PPG allowed — higher = worse defense = easier scoring (green ≥118, yellow ≥113)",
                          ttPace:"Team pace vs league average — positive = faster pace = more possessions = more scoring opportunities",
                          ttSpread:"Game spread — tight game (≤5) = full minutes competitive play (green ≤5, yellow ≤10, red >10)",
                        };
                        const _hdr = (col, label, extraStyle={}, textAlign="right") => {
                          const active = _sc?.col === col;
                          const onClick = () => setReportSort(prev => {
                            const cur = prev[_sk];
                            const dir = cur?.col === col && cur.dir === "desc" ? "asc" : "desc";
                            return {...prev, [_sk]: {col, dir}};
                          });
                          return <div title={COL_TIPS[col]} style={{flex:1,color:active?"#c9d1d9":"#484f58",fontSize:10,textAlign,cursor:"pointer",userSelect:"none",...extraStyle}} onClick={onClick}>
                            {label}{active ? (_sc.dir === "desc" ? "↓" : "↑") : ""}
                          </div>;
                        };
                        const _oppFlex = (sport === "nba" || (sport === "mlb" && stat === "strikeouts")) ? 1 : 2;
                        return <React.Fragment>
                          <div style={{overflowX:"auto"}}>
                          <div style={{minWidth:680}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,padding:"3px 12px 4px",marginBottom:2}}>
                            {_hdr("player", stat.startsWith("team") ? "Team" : stat.startsWith("total") ? "Matchup" : "Player", {flex:2,minWidth:0}, "left")}
                            {_hdr("line","Line")}
                            {_hdr("true","True%")}
                            {_hdr("kalshi","Kalshi")}
                            {_hdr("edge","Edge")}
                            {xcols.map(c => <React.Fragment key={c.k}>{_hdr(c.k,c.l)}</React.Fragment>)}
                            {!stat.startsWith("total") && !stat.startsWith("team") && _hdr("opp","Opp",{flex:_oppFlex})}
                          </div>
                          <div style={{background:"#0d1117",borderRadius:8,overflow:"hidden"}}>
                            {rows.map((m, i) => {
                              const truePct = m.truePct ?? null;
                              const edge = m.edge ?? null;
                              const _mlbRowScore = sport === "mlb" ? (m.finalSimScore ?? m.hitterFinalSimScore ?? null) : null;
                              const _highScore = _mlbRowScore != null && _mlbRowScore > 7;
                              const resultCell = (() => {
                                if (m.qualified) {
                                  if (stat === "strikeouts" && m.finalSimScore != null) {
                                    const sc = m.finalSimScore;
                                    const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                                    return <span style={{background:"rgba(63,185,80,0.15)",borderRadius:4,padding:"1px 6px",display:"inline-flex",gap:4,alignItems:"center"}}>
                                      <span style={{color:scColor,fontWeight:700,fontSize:10}}>{sc}/10</span>
                                      <span style={{color:sc>=8?"#3fb950":"#e3b341",fontSize:9}}>{sc>=8?"Alpha":"Mid"}</span>
                                    </span>;
                                  }
                                  if (stat !== "strikeouts" && m.hitterFinalSimScore != null) {
                                    const sc = m.hitterFinalSimScore;
                                    const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                                    const tier = sc >= 8 ? "Alpha" : "Mid";
                                    return <span style={{background:"rgba(63,185,80,0.15)",borderRadius:4,padding:"1px 6px",display:"inline-flex",gap:4,alignItems:"center"}}>
                                      <span style={{color:scColor,fontWeight:700,fontSize:10}}>{sc}/10</span>
                                      <span style={{color:sc>=8?"#3fb950":"#e3b341",fontSize:9}}>{tier}</span>
                                    </span>;
                                  }
                                  if (sport === "nba" && m.nbaSimScore != null) {
                                    const sc = m.nbaSimScore;
                                    const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                                    const tier = sc >= 8 ? "Alpha" : sc >= 5 ? "Mid" : "Low";
                                    return <span style={{background:"rgba(63,185,80,0.15)",borderRadius:4,padding:"1px 6px",display:"inline-flex",gap:4,alignItems:"center"}}>
                                      <span style={{color:scColor,fontWeight:700,fontSize:10}}>{sc}/10</span>
                                      <span style={{color:scColor,fontSize:9}}>{tier}</span>
                                    </span>;
                                  }
                                  return <span style={{background:"rgba(63,185,80,0.15)",color:"#3fb950",borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:700}}>PLAY</span>;
                                }
                                if (m.reason === "low_confidence" && (m.simScore ?? m.hitterSimScore) != null) {
                                  return <span style={{fontSize:10,color:"#484f58"}}>{(m.simScore ?? m.hitterSimScore)}/10</span>;
                                }
                                return <span style={{fontSize:10,color:"#484f58"}}>{RESULT_LABELS[m.reason] ?? m.reason ?? ""}</span>;
                              })();
                              const isTotal = m.gameType === "total";
                              const isTeamTotal = m.gameType === "teamTotal";
                              const _nameWhite = (isTotal || isTeamTotal) ? m.qualified : sport === "mlb" ? (_highScore && m.qualified !== false) : m.qualified;
                              const _rowKey = isTeamTotal ? `${m.scoringTeam}|${m.oppTeam}|${m.threshold}${m.direction==="under"?"|under":""}|${i}` : isTotal ? `${m.homeTeam}|${m.awayTeam}|${m.threshold}|${i}` : `${m.playerName}|${m.threshold}|${i}`;
                              return (
                                <div key={_rowKey} style={{
                                  display:"flex",alignItems:"center",gap:6,padding:"6px 12px",
                                  borderTop: i>0?"1px solid #161b22":"none"}}>
                                  <div style={{flex:2,minWidth:0,fontSize:12,fontWeight:_nameWhite?600:400,display:"flex",alignItems:"baseline",gap:3}}>
                                    {isTeamTotal
                                      ? <span onClick={() => { onClose(); navigateToTeam(m.scoringTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{m.scoringTeam}</span>
                                      : isTotal
                                      ? <><span onClick={() => { onClose(); navigateToTeam(m.awayTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{m.awayTeam}</span>
                                          <span style={{color:"#484f58"}}> @ </span>
                                          <span onClick={() => { onClose(); navigateToTeam(m.homeTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{m.homeTeam}</span></>
                                      : <><span onClick={() => { onClose(); navigateToPlayer({ id: m.playerId, name: m.playerName, sportKey: SPORT_KEY[m.sport] }, m.stat); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",textTransform:"capitalize",cursor:"pointer"}}>{m.playerNameDisplay||m.playerName}</span>
                                         {(m.playerTeam||m.kalshiPlayerTeam)&&<span style={{color:"#484f58",fontWeight:400,flexShrink:0,fontSize:10}}>({m.playerTeam||m.kalshiPlayerTeam})</span>}</>
                                    }
                                  </div>
                                  <div style={{flex:1,color:"#8b949e",fontSize:11,textAlign:"right"}}>
                                    {(isTotal || isTeamTotal) ? `${m.direction === "under" ? "U" : "O"}${(m.threshold - 0.5).toFixed(1)}` : `${m.threshold}+`}
                                  </div>
                                  {(() => { const _tp = m.direction === "under" ? (m.noTruePct ?? null) : (m.truePct ?? null); return <div style={{flex:1,fontSize:11,textAlign:"right",color:_tp!=null?"#e3b341":"#21262d",fontWeight:_tp!=null?600:400}}>{_tp!=null?`${_tp}%`:"—"}</div>; })()}
                                  {(() => { const _kp = m.direction === "under" ? (m.noKalshiPct ?? null) : (m.kalshiPct ?? null); return <div style={{flex:1,fontSize:11,textAlign:"right"}}><span style={{color:_kp != null ? "#c9d1d9" : "#484f58"}}>{_kp != null ? `${_kp}%` : "—"}</span></div>; })()}
                                  <div style={{flex:1,fontSize:11,textAlign:"right",color:edge!=null&&edge>=5?"#3fb950":edge!=null&&edge<0?"#f78166":"#8b949e"}}>{edge!=null?(edge>=0?`+${edge.toFixed(1)}`:`${edge.toFixed(1)}`)+"%" :"—"}</div>
                                  {xcols.map(c => <div key={c.k} style={{flex:1,fontSize:11,textAlign:"right"}}>{xcell(m,c.k)}</div>)}
                                  {!isTotal && !isTeamTotal && <div style={{flex:_oppFlex,fontSize:10,textAlign:"right",whiteSpace:"nowrap"}}>
                                    {(() => { const pn = m.pitcherName || m.hitterPitcherName; const parts = pn ? pn.trim().split(" ") : []; const shortPn = parts.length >= 2 ? `${parts[0][0]}. ${parts.slice(1).join(" ")}` : pn; return m.sport==="mlb" && m.stat!=="strikeouts" && pn
                                      ? <><span style={{color:"#8b949e"}}>{shortPn}</span> <span style={{color:"#484f58"}}>({m.opponent})</span></>
                                      : <span style={{color:"#484f58"}}>{m.opponent||""}</span>; })()}
                                  </div>}
                                </div>
                              );
                            })}
                          </div>
                          </div>
                          </div>
                        </React.Fragment>;
                      })()}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
  );
}

export default MarketReport;
