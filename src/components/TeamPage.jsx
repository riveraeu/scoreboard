import React from 'react';
import { SPORT_KEY, STAT_LABEL } from '../lib/constants.js';
import { tierColor } from '../lib/colors.js';
import TotalsBarChart from './TotalsBarChart.jsx';
import SimBadge from './SimBadge.jsx';

// ── Play-type tab definitions ─────────────────────────────────────────────────
const PLAY_TYPES = [
  { key: 'game_over',  label: 'Game Over',  gameType: 'total',     isUnder: false },
  { key: 'game_under', label: 'Game Under', gameType: 'total',     isUnder: true  },
  { key: 'team_over',  label: 'Team Over',  gameType: 'teamTotal', isUnder: false },
  { key: 'team_under', label: 'Team Under', gameType: 'teamTotal', isUnder: true  },
];

function buildTotalMapFn(allPlays, abbr, sport, gameType, isUnder) {
  return Object.fromEntries(
    (allPlays || [])
      .filter(p =>
        p.sport === sport &&
        p.gameType === gameType &&
        (isUnder ? p.direction === 'under' : p.direction !== 'under') &&
        (gameType === 'total'
          ? (p.homeTeam?.toUpperCase() === abbr || p.awayTeam?.toUpperCase() === abbr)
          : p.scoringTeam?.toUpperCase() === abbr)
      )
      .map(p => [p.threshold, p])
  );
}

function pickBestTabFn(allPlays, abbr, sport) {
  let best = 'game_over', bestEdge = -Infinity;
  for (const pt of PLAY_TYPES) {
    if (pt.gameType === 'teamTotal' && sport === 'nhl') continue;
    const m = buildTotalMapFn(allPlays, abbr, sport, pt.gameType, pt.isUnder);
    const mx = Object.values(m)
      .filter(p => p.qualified !== false)
      .reduce((a, p) => Math.max(a, p.edge ?? 0), -Infinity);
    if (mx > bestEdge) { bestEdge = mx; best = pt.key; }
  }
  return best;
}

// Resolve the SimScore field from any play object
function getPlayScore(play) {
  return play.finalSimScore ?? play.hitterFinalSimScore ?? play.nbaSimScore
    ?? play.nhlSimScore ?? play.teamTotalSimScore ?? play.totalSimScore ?? null;
}

// Build per-component SimScore tooltip string (mirrors MarketReport xcell sim logic)
function buildSimTip(play) {
  const sport = play.sport;
  const stat  = play.stat;
  // MLB strikeouts
  if (play.finalSimScore != null && play.totalSimScore == null && play.teamTotalSimScore == null) {
    return [`CSW%/K%: ${play.kpctPts??1}/2`, `Lineup K%: ${play.lkpPts??1}/2`, `Hit Rate %: ${play.kHitRatePts??1}/2`, `H2H Hand: ${play.kH2HHandPts??1}/2`, `O/U: ${play.totalPts??1}/2`].join('\n');
  }
  // MLB HRR
  if (play.hitterFinalSimScore != null) {
    return [`OPS: ${play.hitterOpsPts??1}/2`, `WHIP: ${play.hitterWhipPts??1}/2`, `Season HR: ${play.hitterSeasonHitRatePts??1}/2`, `H2H HR: ${play.hitterH2HHitRatePts??1}/2`, `O/U: ${play.hitterTotalPts??1}/2`].join('\n');
  }
  // NBA player props
  if (play.nbaSimScore != null && play.totalSimScore == null && play.teamTotalSimScore == null) {
    const dvpPts = (play.dvpRatio??0)>=1.05?2:(play.dvpRatio??0)>=1.02?1:0;
    const c1Pts  = stat==='rebounds'
      ? (play.nbaOpportunity==null?1:play.nbaOpportunity>=30?2:play.nbaOpportunity>=25?1:0)
      : (play.nbaUsage==null?1:play.nbaUsage>=28?2:play.nbaUsage>=22?1:0);
    return [`C1: ${c1Pts}/2`, `DVP: ${dvpPts}/2`, `Season HR: ${play.nbaSeasonHitRatePts??1}/2`, `Tier HR: ${play.nbaSoftHitRatePts??1}/2`, `O/U: ${play.nbaTotalPts??1}/2`].join('\n');
  }
  // NHL player props
  if (play.nhlSimScore != null && play.totalSimScore == null) {
    const toiPts  = play.nhlOpportunity>=18?2:play.nhlOpportunity>=15?1:play.nhlOpportunity!=null?0:1;
    const gaaPts  = play.posDvpRank==null?1:play.posDvpRank<=10?2:play.posDvpRank<=15?1:0;
    const ouPts   = play.nhlGameTotal==null?1:play.nhlGameTotal>=7?2:play.nhlGameTotal>=5.5?1:0;
    return [`TOI: ${toiPts}/2`, `GAA rank: ${gaaPts}/2`, `Season HR: ${play.nhlSeasonHitRatePts??1}/2`, `DVP HR: ${play.nhlDvpHitRatePts??1}/2`, `O/U: ${ouPts}/2`].join('\n');
  }
  // Game totals
  if (play.totalSimScore != null) {
    if (sport === 'mlb') {
      const w = v => v==null?1:v>1.35?2:v>1.20?1:0;
      const cR = play.combinedRPG, h2h = play.h2hTotalHitRate, ou = play.gameOuLine;
      return [`H WHIP: ${w(play.homeWHIP)}/2`, `A WHIP: ${w(play.awayWHIP)}/2`, `Comb RPG: ${cR==null?1:cR>=10.5?2:cR>=9.0?1:0}/2`, `H2H HR%: ${h2h==null?1:h2h>=80?2:h2h>=60?1:0}/2`, `O/U: ${ou==null?1:ou>=9.5?2:ou>=7.5?1:0}/2`].join('\n');
    }
    if (sport === 'nba') {
      const rtgPts = v => v==null?1:v>=118?2:v>=113?1:0;
      const hp=play.homePace, ap=play.awayPace, lgP=play.leagueAvgPace;
      const pacePts = (hp==null||ap==null||lgP==null)?1:(hp>lgP+2&&ap>lgP+2)?2:(hp>lgP||ap>lgP)?1:0;
      const gtH2H = play.nbaGtH2HRate;
      const gtH2HPts = gtH2H==null?1:gtH2H>=80?2:gtH2H>=60?1:0;
      const ou = play.gameOuLine;
      return [`Pace: ${pacePts}/2`, `Comb OffRtg: ${rtgPts(play.combOffRtg)}/2`, `Comb DefRtg: ${rtgPts(play.combDefRtg)}/2`, `H2H HR% (${gtH2H??'—'}): ${gtH2HPts}/2`, `O/U: ${ou==null?1:ou>=225?2:ou>=215?1:0}/2`].join('\n');
    }
    if (sport === 'nhl') {
      const g = v => v==null?1:v>=3.5?2:v>=3.0?1:0;
      const ou = play.gameOuLine;
      return [`H GPG: ${g(play.homeGPG)}/2`, `A GPG: ${g(play.awayGPG)}/2`, `H GAA: ${g(play.homeGAA)}/2`, `A GAA: ${g(play.awayGAA)}/2`, `O/U: ${ou==null?1:ou>=7?2:ou>=5.5?1:0}/2`].join('\n');
    }
  }
  // Team totals
  if (play.teamTotalSimScore != null) {
    const isU = play.direction === 'under';
    if (sport === 'mlb') {
      const ssnPts  = isU?(play.ttSeasonHitRate==null?1:play.ttSeasonHitRate<=20?2:play.ttSeasonHitRate<=40?1:0):(play.ttSeasonHitRatePts??1);
      const whipPts = isU?(play.oppWHIP==null?1:play.oppWHIP<=1.10?2:play.oppWHIP<=1.25?1:0):(play.ttWhipPts??1);
      const l10Pts  = isU?(play.teamL10RPG==null?1:play.teamL10RPG<=3.5?2:play.teamL10RPG<=4.5?1:0):(play.ttL10Pts??1);
      const h2hPts  = isU?(play.h2hHitRate==null?1:play.h2hHitRate<=30?2:play.h2hHitRate<=50?1:0):(play.h2hHitRatePts??1);
      const ou = play.gameOuLine;
      return [`Ssn HR%: ${ssnPts}/2`, `WHIP: ${whipPts}/2`, `L10 RPG: ${l10Pts}/2`, `H2H HR%: ${h2hPts}/2`, `O/U: ${ou==null?1:isU?(ou<7.5?2:ou<9.5?1:0):(ou>=9.5?2:ou>=7.5?1:0)}/2`].join('\n');
    }
    if (sport === 'nba') {
      const rtgPts = v => v==null?1:isU?(v<113?2:v<118?1:0):(v>=118?2:v>=113?1:0);
      const ou = play.gameOuLine;
      const ouPts = ou==null?1:isU?(ou<215?2:ou<225?1:0):(ou>=225?2:ou>=215?1:0);
      const ssnHR = play.ttNbaSeasonHitRate;
      const ssnPts = play.ttNbaSeasonHitRatePts ?? (ssnHR==null?1:isU?(ssnHR<=20?2:ssnHR<=40?1:0):(ssnHR>=80?2:ssnHR>=60?1:0));
      const h2hPts = isU?(play.h2hHitRate==null?1:play.h2hHitRate<=30?2:play.h2hHitRate<=50?1:0):(play.h2hHitRatePts??1);
      return [`OffRtg: ${rtgPts(play.teamOffRtg)}/2`, `DefRtg: ${rtgPts(play.oppDefRtg)}/2`, `Ssn HR%: ${ssnPts}/2`, `H2H HR%: ${h2hPts}/2`, `O/U: ${ouPts}/2`].join('\n');
    }
  }
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────
function TeamPage({ abbr, sport, teamPageData, tonightPlays, allTonightPlays, onBack, navigateToTeam, navigateToPlayer, trackedPlays, trackPlay, untrackPlay }) {
  const [glSort, setGlSort] = React.useState({ col:'date', dir:'desc' });

  const { loading, error, data } = teamPageData || {};
  const sportLabel = { mlb:'MLB', nba:'NBA', nhl:'NHL' }[sport] || sport.toUpperCase();
  const logoUrl = `https://a.espncdn.com/i/teamlogos/${sport}/500/${abbr.toLowerCase()}.png`;

  const _allPlays = allTonightPlays || tonightPlays || [];

  // Build per-tab total maps
  const _allMaps = {};
  for (const pt of PLAY_TYPES) {
    _allMaps[pt.key] = buildTotalMapFn(_allPlays, abbr, sport, pt.gameType, pt.isUnder);
  }

  // Available tabs (have at least one play)
  const availableTabs = PLAY_TYPES
    .filter(pt => !(pt.gameType === 'teamTotal' && sport === 'nhl'))
    .filter(pt => Object.keys(_allMaps[pt.key]).length > 0)
    .map(pt => pt.key);

  // Play type state — initialized from URL param or best available tab
  const [playType, setPlayType] = React.useState(() => {
    const urlParam = (() => { try { return new URLSearchParams(window.location.search).get('playType'); } catch { return null; } })();
    if (urlParam && PLAY_TYPES.some(pt => pt.key === urlParam)) return urlParam;
    return pickBestTabFn(_allPlays, abbr, sport);
  });

  const _activeType = playType || 'game_over';
  const activeTotalMap = _allMaps[_activeType] || {};
  const isUnder = _activeType.includes('under');

  // Best play for active tab (used in explanation)
  const _activeVals = Object.values(activeTotalMap);
  const _activeQual = _activeVals.filter(p => p.qualified !== false);
  const activePlay = (_activeQual.length > 0 ? _activeQual : _activeVals)
    .sort((a,b) => (b.edge||0)-(a.edge||0))[0] ?? null;

  // Original tonightPlay kept for game log color-coding and header fallback
  const tonightTotals = _allPlays.filter(p =>
    p.gameType === 'total' && p.sport === sport &&
    (p.homeTeam?.toUpperCase() === abbr || p.awayTeam?.toUpperCase() === abbr)
  );
  const _tq = tonightTotals.filter(p => p.qualified !== false);
  const _tPool = _tq.length > 0 ? _tq : tonightTotals;
  const _tMinDate = _tPool.reduce((min, p) => (p.gameDate||'') < min ? (p.gameDate||'') : min, _tPool[0]?.gameDate||'');
  const tonightPlay = _tPool.filter(p => p.gameDate === _tMinDate).sort((a,b) => (b.edge||0)-(a.edge||0))[0] ?? null;

  function handleTabChange(newType) {
    setPlayType(newType);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('playType', newType);
      history.replaceState(null, '', url.toString());
    } catch {}
  }

  if (loading) return (
    <div style={{textAlign:'center',padding:52,color:'#8b949e',fontSize:13}}>Loading {abbr} data…</div>
  );
  if (error) return (
    <div style={{textAlign:'center',padding:40,color:'#f78166',fontSize:13}}>Error: {error}</div>
  );
  if (!data) return null;

  const { teamName, record, wins, losses, gameLog, seasonStats, lineup, lineupConfirmed, nextGame } = data;

  // Game log sort
  const sortedGL = [...(gameLog || [])].sort((a, b) => {
    const { col, dir } = glSort;
    let va = a[col], vb = b[col];
    if (col === 'isHome') { va = a.isHome ? 0 : 1; vb = b.isHome ? 0 : 1; }
    if (col === 'result') { va = a.result || ''; vb = b.result || ''; }
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : (va ?? 0) - (vb ?? 0);
    return dir === 'desc' ? -cmp : cmp;
  });

  const glCols = [
    { key:'date',     label:'Date',  align:'left'   },
    { key:'isHome',   label:'H/A',   align:'center' },
    { key:'opp',      label:'Opp',   align:'left'   },
    { key:'teamScore',label:'Us'                    },
    { key:'oppScore', label:'Opp'                   },
    { key:'total',    label:'Total'                 },
    { key:'result',   label:'W/L'                   },
  ];

  const thStyle = col => {
    const active = glSort.col === col;
    return {
      padding:'3px 8px', fontSize:10, textAlign: glCols.find(c=>c.key===col)?.align||'right',
      color: active ? '#c9d1d9' : '#484f58', cursor:'pointer', userSelect:'none',
      background:'#0d1117', position:'sticky', top:0,
    };
  };
  const toggleSort = col => setGlSort(prev =>
    prev.col === col ? { col, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: 'desc' }
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{marginBottom:20}}>
      <button onClick={onBack}
        style={{background:'none',border:'none',color:'#8b949e',fontSize:13,cursor:'pointer',
          padding:'0 0 12px 0',display:'flex',alignItems:'center',gap:4}}>
        ← Back
      </button>

      {/* Header */}
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:16}}>
        <img src={logoUrl} alt={abbr}
          onError={e => e.target.style.visibility='hidden'}
          style={{width:52,height:52,objectFit:'contain',background:'#161b22',borderRadius:8,padding:4,flexShrink:0}}/>
        <div>
          <h1 style={{color:'#fff',margin:0,fontSize:19,fontWeight:700}}>{teamName}</h1>
          <div style={{color:'#8b949e',fontSize:12}}>{sportLabel} 2025-26{record ? ` · ${record}` : ''}</div>
          {(nextGame?.gameTime || tonightPlay?.gameTime) && (() => {
            const src = nextGame?.gameTime ? nextGame : tonightPlay;
            const d = new Date(src.gameTime);
            const ptFmt = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles'});
            const gamePT = ptFmt.format(d), todayPT = ptFmt.format(new Date()), tmrwPT = ptFmt.format(new Date(Date.now()+86400000));
            const dayLabel = gamePT === todayPT ? 'Today' : gamePT === tmrwPT ? 'Tomorrow' : new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric'}).format(d);
            const timePart = new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit',hour12:true}).format(d);
            return <div style={{color:'#6e7681',fontSize:11,marginTop:2}}>{dayLabel} · {timePart} PT</div>;
          })()}
        </div>
        <div style={{marginLeft:'auto',display:'flex',gap:8}}>
          {[['W',wins],['L',losses],['Avg',seasonStats.avgTotal ?? '—']].map(([l,v]) => (
            <div key={l} style={{background:'#161b22',border:'1px solid #30363d',borderRadius:8,padding:'7px 11px',textAlign:'center'}}>
              <div style={{color:'#58a6ff',fontSize:15,fontWeight:700}}>{v}</div>
              <div style={{color:'#8b949e',fontSize:10}}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Content card */}
      <div style={{background:'#161b22',border:'1px solid #30363d',borderRadius:12,padding:'20px 22px'}}>

        {/* Tonight's game explanation — keyed to active play type */}
        {activePlay && (() => {
          const tp = activePlay;
          const _isTeamTotal = tp.gameType === 'teamTotal';
          const _isHome = _isTeamTotal
            ? false
            : tp.homeTeam?.toUpperCase() === abbr;
          const _opp = _isTeamTotal
            ? tp.oppTeam
            : (_isHome ? tp.awayTeam : tp.homeTeam);

          const matchupHeader = (
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}>
              <img src={`https://a.espncdn.com/i/teamlogos/${sport}/500/${(_opp||'').toLowerCase()}.png`}
                style={{width:18,height:18,objectFit:'contain'}} onError={e=>e.target.style.display='none'}/>
              <span style={{color:'#c9d1d9',fontSize:12,fontWeight:600}}>
                {_isTeamTotal
                  ? `${abbr} vs ${_opp}`
                  : (_isHome ? `${_opp} @ ${abbr}` : `${abbr} @ ${_opp}`)}
              </span>
              {_isTeamTotal && (
                <span style={{fontSize:10,color:isUnder?'#f78166':'#58a6ff',fontWeight:600,marginLeft:2}}>
                  {isUnder ? '↓ Team Under' : '↑ Team Over'}
                </span>
              )}
            </div>
          );

          // ── MLB game total ──────────────────────────────────────────────
          if (tp.sport === 'mlb' && !_isTeamTotal) {
            const sc = tp.totalSimScore;
            const scColor = sc >= 8 ? '#3fb950' : sc >= 5 ? '#e3b341' : '#8b949e';
            const hERA = tp.homeERA ?? null, aERA = tp.awayERA ?? null;
            const hRPG = tp.homeRPG ?? null, aRPG = tp.awayRPG ?? null;
            const pf = tp.parkFactor ?? 1;
            const et = tp.expectedTotal ?? null;
            // Colors invert for under: low ERA = green (good pitcher = fewer runs)
            const eraColor = v => v == null ? '#8b949e' : isUnder
              ? (v < 3.5 ? '#3fb950' : v < 4.5 ? '#e3b341' : '#8b949e')
              : (v > 4.5 ? '#3fb950' : v > 3.5 ? '#e3b341' : '#f78166');
            const rpgColor = v => v == null ? '#8b949e' : isUnder
              ? (v < 4.0 ? '#3fb950' : v < 5.0 ? '#e3b341' : '#8b949e')
              : (v > 5.0 ? '#3fb950' : v > 4.0 ? '#e3b341' : '#8b949e');
            const gameOuLine = tp.gameOuLine ?? null;
            const mlbOuPts = tp.mlbOuPts ?? 1;
            const ouColor = gameOuLine == null ? '#8b949e' : isUnder
              ? (gameOuLine < 7.5 ? '#3fb950' : gameOuLine < 9.5 ? '#e3b341' : '#8b949e')
              : (gameOuLine >= 9.5 ? '#3fb950' : gameOuLine >= 7.5 ? '#e3b341' : '#f78166');
            const etColor = et == null ? '#8b949e' : isUnder
              ? (et <= tp.threshold - 0.5 ? '#3fb950' : et <= tp.threshold + 0.5 ? '#e3b341' : '#8b949e')
              : (et >= tp.threshold + 0.5 ? '#3fb950' : et >= tp.threshold - 0.5 ? '#e3b341' : '#8b949e');
            const scTitle = buildSimTip(tp);
            return (
              <div style={{background:'#0d1117',border:'1px solid #21262d',borderRadius:8,padding:'8px 10px',fontSize:11,color:'#8b949e',lineHeight:1.65,marginBottom:14}}>
                {matchupHeader}
                <span style={{color:'#c9d1d9'}}>{tp.awayTeam}</span>'s starter has{aERA != null ? <> a <span style={{color:eraColor(aERA),fontWeight:600}}>{aERA.toFixed(2)} ERA</span></> : ' — ERA'}, facing a <span style={{color:'#c9d1d9'}}>{tp.homeTeam}</span> offense averaging{hRPG != null ? <> <span style={{color:rpgColor(hRPG),fontWeight:600}}>{hRPG.toFixed(1)}</span> runs/game</> : ' — RPG'}.
                {' '}<span style={{color:'#c9d1d9'}}>{tp.homeTeam}</span>'s starter posts{hERA != null ? <> a <span style={{color:eraColor(hERA),fontWeight:600}}>{hERA.toFixed(2)} ERA</span></> : ' — ERA'} against a <span style={{color:'#c9d1d9'}}>{tp.awayTeam}</span> offense at{aRPG != null ? <> <span style={{color:rpgColor(aRPG),fontWeight:600}}>{aRPG.toFixed(1)}</span> RPG</> : ' — RPG'}.
                {Math.abs(pf - 1) > 0.01 && <>{' '}Tonight's park {pf > 1 ? 'inflates run scoring' : 'suppresses run scoring'} (<span style={{color:'#8b949e'}}>{pf > 1 ? '+' : ''}{((pf-1)*100).toFixed(0)}%</span>).</>}
                {gameOuLine != null && <>{' '}Game total <span style={{color:ouColor,fontWeight:600}}>{gameOuLine}</span>.</>}
                {et != null && <>{' '}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined runs.</>}
                {' '}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
              </div>
            );
          }

          // ── NBA game total ──────────────────────────────────────────────
          if (tp.sport === 'nba' && !_isTeamTotal) {
            const sc = tp.totalSimScore;
            const scColor = sc >= 8 ? '#3fb950' : sc >= 5 ? '#e3b341' : '#8b949e';
            const hOff = tp.homeOff ?? null, aOff = tp.awayOff ?? null;
            const hPace = tp.homePace ?? null, aPace = tp.awayPace ?? null;
            const lgPace = tp.leagueAvgPace ?? null;
            const et = tp.expectedTotal ?? null;
            const paceAdj = (hPace != null && aPace != null && lgPace != null) ? parseFloat(((hPace + aPace) / 2 - lgPace).toFixed(1)) : null;
            const offColor = v => v == null ? '#8b949e' : isUnder
              ? (v < 113 ? '#3fb950' : v < 118 ? '#e3b341' : '#8b949e')
              : (v >= 118 ? '#f78166' : v >= 113 ? '#e3b341' : '#8b949e');
            const paceColor = paceAdj == null ? '#8b949e' : isUnder
              ? (paceAdj < -2 ? '#3fb950' : paceAdj < 0 ? '#e3b341' : '#8b949e')
              : (paceAdj > 0 ? '#3fb950' : paceAdj > -2 ? '#e3b341' : '#8b949e');
            const nbaOuLine = tp.gameOuLine ?? null;
            const etColor = et == null ? '#8b949e' : isUnder
              ? (et <= tp.threshold - 2 ? '#3fb950' : et <= tp.threshold + 2 ? '#e3b341' : '#8b949e')
              : (et >= tp.threshold + 2 ? '#3fb950' : et >= tp.threshold - 2 ? '#e3b341' : '#8b949e');
            const scTitle = buildSimTip(tp);
            return (
              <div style={{background:'#0d1117',border:'1px solid #21262d',borderRadius:8,padding:'8px 10px',fontSize:11,color:'#8b949e',lineHeight:1.65,marginBottom:14}}>
                {matchupHeader}
                <span style={{color:'#c9d1d9'}}>{tp.awayTeam}</span> averages{aOff != null ? <> <span style={{color:offColor(aOff),fontWeight:600}}>{aOff.toFixed(0)} PPG</span></> : ' —'} offense.
                {' '}<span style={{color:'#c9d1d9'}}>{tp.homeTeam}</span> averages{hOff != null ? <> <span style={{color:offColor(hOff),fontWeight:600}}>{hOff.toFixed(0)} PPG</span></> : ' —'} offense.
                {paceAdj != null && <>{' '}Game pace is <span style={{color:paceColor,fontWeight:600}}>{paceAdj > 0 ? '+' : ''}{paceAdj}</span> vs league avg.</>}
                {et != null && <>{' '}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined pts.</>}
                {nbaOuLine != null && <>{' '}O/U line: <span style={{color:'#8b949e',fontWeight:600}}>{nbaOuLine}</span>.</>}
                {' '}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
              </div>
            );
          }

          // ── NHL game total ──────────────────────────────────────────────
          if (tp.sport === 'nhl' && !_isTeamTotal) {
            const sc = tp.totalSimScore;
            const scColor = sc >= 8 ? '#3fb950' : sc >= 5 ? '#e3b341' : '#8b949e';
            const hGPG = tp.homeGPG ?? null, aGPG = tp.awayGPG ?? null;
            const hGAA = tp.homeGAA ?? null, aGAA = tp.awayGAA ?? null;
            const et = tp.expectedTotal ?? null;
            const gpgColor = v => v == null ? '#8b949e' : v >= 3.5 ? '#3fb950' : v >= 3.0 ? '#e3b341' : '#8b949e';
            const gaaColor = v => v == null ? '#8b949e' : v >= 3.5 ? '#3fb950' : v >= 3.0 ? '#e3b341' : '#8b949e';
            const etColor = et == null ? '#8b949e' : et >= tp.threshold + 0.5 ? '#3fb950' : et >= tp.threshold - 0.5 ? '#e3b341' : '#8b949e';
            const nhlOuLine = tp.gameOuLine ?? null;
            const scTitle = buildSimTip(tp);
            return (
              <div style={{background:'#0d1117',border:'1px solid #21262d',borderRadius:8,padding:'8px 10px',fontSize:11,color:'#8b949e',lineHeight:1.65,marginBottom:14}}>
                {matchupHeader}
                <span style={{color:'#c9d1d9'}}>{tp.awayTeam}</span> averages{aGPG != null ? <> <span style={{color:gpgColor(aGPG),fontWeight:600}}>{aGPG.toFixed(1)} GPG</span></> : ' —'} facing a <span style={{color:'#c9d1d9'}}>{tp.homeTeam}</span> defense with{hGAA != null ? <> <span style={{color:gaaColor(hGAA),fontWeight:600}}>{hGAA.toFixed(2)} GAA</span></> : ' — GAA'}.
                {' '}<span style={{color:'#c9d1d9'}}>{tp.homeTeam}</span> averages{hGPG != null ? <> <span style={{color:gpgColor(hGPG),fontWeight:600}}>{hGPG.toFixed(1)} GPG</span></> : ' —'} facing a <span style={{color:'#c9d1d9'}}>{tp.awayTeam}</span> defense allowing{aGAA != null ? <> <span style={{color:gaaColor(aGAA),fontWeight:600}}>{aGAA.toFixed(2)} GAA</span></> : ' — GAA'}.
                {et != null && <>{' '}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined goals.</>}
                {nhlOuLine != null && <>{' '}O/U line: <span style={{color:'#8b949e',fontWeight:600}}>{nhlOuLine}</span>.</>}
                {' '}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
              </div>
            );
          }

          // ── MLB team total ──────────────────────────────────────────────
          if (tp.sport === 'mlb' && _isTeamTotal) {
            const sc = tp.teamTotalSimScore;
            const scColor = sc >= 8 ? '#3fb950' : sc >= 5 ? '#e3b341' : '#8b949e';
            const rpg = tp.teamL10RPG ?? tp.teamRPG ?? null;
            const whip = tp.oppWHIP ?? null;
            const h2h = tp.h2hHitRate ?? null;
            const ou = tp.gameOuLine ?? null;
            const rpgColor = v => v == null ? '#8b949e' : isUnder
              ? (v < 4.0 ? '#3fb950' : v < 5.0 ? '#e3b341' : '#8b949e')
              : (v > 5.0 ? '#3fb950' : v > 4.0 ? '#e3b341' : '#8b949e');
            const whipColor = v => v == null ? '#8b949e' : isUnder
              ? (v < 1.10 ? '#3fb950' : v < 1.25 ? '#e3b341' : '#8b949e')
              : (v > 1.35 ? '#3fb950' : v > 1.20 ? '#e3b341' : '#8b949e');
            const h2hColor = v => v == null ? '#8b949e' : isUnder
              ? (v <= 30 ? '#3fb950' : v <= 50 ? '#e3b341' : '#f78166')
              : (v >= 80 ? '#3fb950' : v >= 60 ? '#e3b341' : '#f78166');
            const scTitle = buildSimTip(tp);
            return (
              <div style={{background:'#0d1117',border:'1px solid #21262d',borderRadius:8,padding:'8px 10px',fontSize:11,color:'#8b949e',lineHeight:1.65,marginBottom:14}}>
                {matchupHeader}
                <span style={{color:'#c9d1d9'}}>{abbr}</span> averaging{rpg != null ? <> <span style={{color:rpgColor(rpg),fontWeight:600}}>{rpg.toFixed(1)}</span> runs/game (last 10)</> : ' — RPG'}.
                {whip != null && <>{' '}<span style={{color:'#c9d1d9'}}>{_opp}</span> starter WHIP: <span style={{color:whipColor(whip),fontWeight:600}}>{whip.toFixed(2)}</span>.</>}
                {h2h != null && <>{' '}H2H hit rate: <span style={{color:h2hColor(h2h),fontWeight:600}}>{h2h}%</span>.</>}
                {ou != null && <>{' '}O/U line: <span style={{color:'#8b949e',fontWeight:600}}>{ou}</span>.</>}
                {' '}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
              </div>
            );
          }

          // ── NBA team total ──────────────────────────────────────────────
          if (tp.sport === 'nba' && _isTeamTotal) {
            const sc = tp.teamTotalSimScore;
            const scColor = sc >= 8 ? '#3fb950' : sc >= 5 ? '#e3b341' : '#8b949e';
            const teamOff = tp.teamOff ?? null, oppDef = tp.oppDef ?? null;
            const ou = tp.gameOuLine ?? null;
            const offColor = v => v == null ? '#8b949e' : isUnder
              ? (v < 113 ? '#3fb950' : v < 118 ? '#e3b341' : '#8b949e')
              : (v >= 118 ? '#3fb950' : v >= 113 ? '#e3b341' : '#8b949e');
            const defColor = v => v == null ? '#8b949e' : isUnder
              ? (v < 113 ? '#3fb950' : v < 118 ? '#e3b341' : '#8b949e')
              : (v >= 118 ? '#3fb950' : v >= 113 ? '#e3b341' : '#8b949e');
            const scTitle = buildSimTip(tp);
            return (
              <div style={{background:'#0d1117',border:'1px solid #21262d',borderRadius:8,padding:'8px 10px',fontSize:11,color:'#8b949e',lineHeight:1.65,marginBottom:14}}>
                {matchupHeader}
                <span style={{color:'#c9d1d9'}}>{abbr}</span> averages{teamOff != null ? <> <span style={{color:offColor(teamOff),fontWeight:600}}>{teamOff.toFixed(0)} PPG</span></> : ' — PPG'} offense.
                {oppDef != null && <>{' '}<span style={{color:'#c9d1d9'}}>{_opp}</span> allows <span style={{color:defColor(oppDef),fontWeight:600}}>{oppDef.toFixed(0)} PPG</span>.</>}
                {ou != null && <>{' '}O/U line: <span style={{color:'#8b949e',fontWeight:600}}>{ou}</span>.</>}
                {' '}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
              </div>
            );
          }
          return null;
        })()}

        {/* Totals bar chart — passes tab state */}
        <TotalsBarChart gameLog={gameLog} sport={sport}
          tonightTotalMap={activeTotalMap} tonightPlay={activePlay}
          trackedPlays={trackedPlays} onTrack={trackPlay} onUntrack={untrackPlay}
          playType={_activeType} onPlayTypeChange={handleTabChange} availableTabs={availableTabs}/>

        {/* Lineup — shown above game log when available */}
        {lineup.length > 0 && (() => {
          const allPlays = allTonightPlays || tonightPlays || [];
          const playerPlaysMap = {};
          allPlays.forEach(pl => {
            if (pl.gameType === 'total') return;
            const key = pl.playerName;
            if (!playerPlaysMap[key]) playerPlaysMap[key] = [];
            playerPlaysMap[key].push(pl);
          });

          // Compact inline play card with SimScore badge
          const MiniPlayCard = ({ play }) => {
            const tc = tierColor(play.truePct);
            const tp = play.truePct;
            const trueOdds = tp != null ? (tp >= 100 ? -99999 : tp >= 50 ? Math.round(-(tp/(100-tp))*100) : Math.round((100-tp)/tp*100)) : null;
            const trueOddsStr = trueOdds != null ? (trueOdds > 0 ? `+${trueOdds}` : `${trueOdds}`) : null;
            const kp = play.kalshiPct;
            const kOdds = play.americanOdds;
            const kOddsStr = kOdds != null ? (kOdds > 0 ? `+${kOdds}` : `${kOdds}`) : null;
            const isQual = play.qualified !== false;
            const score = getPlayScore(play);
            const scoreColor = score == null ? '#484f58' : score >= 8 ? '#3fb950' : score >= 5 ? '#e3b341' : '#8b949e';
            const simTip = score != null ? buildSimTip(play) : null;
            return (
              <div style={{marginTop:6,background:'#161b22',border:`1px solid ${isQual?'#30363d':'#21262d'}`,borderRadius:8,padding:'8px 10px'}}>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6,flexWrap:'wrap'}}>
                  <span style={{background:'rgba(88,166,255,0.12)',border:'1px solid #58a6ff',
                    borderRadius:5,padding:'1px 7px',fontSize:11,color:'#58a6ff',fontWeight:700,whiteSpace:'nowrap'}}>
                    {play.threshold}+ {STAT_LABEL[play.stat] || play.stat}
                  </span>
                  {isQual && play.edge != null && (
                    <span style={{background:'rgba(63,185,80,0.13)',border:'1px solid #3fb950',
                      borderRadius:5,padding:'1px 7px',fontSize:11,color:'#3fb950',fontWeight:700,whiteSpace:'nowrap'}}>
                      +{play.edge}%
                    </span>
                  )}
                  {!isQual && <span style={{fontSize:10,color:'#484f58'}}>unqualified</span>}
                  {score != null && (
                    <SimBadge sc={score} scTitle={simTip} scColor={scoreColor}
                      style={{marginLeft:'auto'}}
                      customStyle={{background:`${scoreColor}18`,border:`1px solid ${scoreColor}`,whiteSpace:'nowrap'}}
                      onClick={e => e.stopPropagation()} />
                  )}
                </div>
                {/* True% bar */}
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                  <div style={{flex:1,background:'#21262d',borderRadius:3,height:10,overflow:'hidden'}}>
                    <div style={{width:`${tp}%`,background:tc,height:'100%',borderRadius:3,minWidth:tp>0?2:0}}/>
                  </div>
                  <div style={{width:80,flexShrink:0,display:'flex',justifyContent:'flex-end',alignItems:'baseline',gap:3}}>
                    <span style={{color:tc,fontSize:11,fontWeight:700}}>{tp}%</span>
                    {trueOddsStr && <span style={{color:tc,fontSize:10}}>({trueOddsStr})</span>}
                  </div>
                </div>
                {/* Kalshi bar */}
                {kp != null && (
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <div style={{flex:1,background:'#21262d',borderRadius:3,height:8,overflow:'hidden'}}>
                      <div style={{width:`${kp}%`,background:'#6e40c9',height:'100%',borderRadius:3,minWidth:kp>0?2:0}}/>
                    </div>
                    <div style={{width:80,flexShrink:0,display:'flex',justifyContent:'flex-end',alignItems:'baseline',gap:3}}>
                      <span style={{color:'#6e40c9',fontSize:11,fontWeight:600}}>{kp}%</span>
                      {kOddsStr && <span style={{color:'#6e40c9',fontSize:10}}>({kOddsStr})</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          };

          const renderLineupRow = ({ key, posLabel, posStyle, imgSrc, name, subLabel, subStyle, rowStyle }) => {
            const plays = playerPlaysMap[name] || [];
            const sortedPlays = [...plays].sort((a,b) => {
              if ((a.qualified !== false) !== (b.qualified !== false)) return (a.qualified !== false) ? -1 : 1;
              return (a.threshold||0) - (b.threshold||0);
            });
            const hasPlays = sortedPlays.length > 0;
            const refPlay = sortedPlays[0];
            const SPORT_KEY_MAP = { mlb:'baseball/mlb', nba:'basketball/nba', nhl:'hockey/nhl' };
            const sportKey = SPORT_KEY_MAP[sport] || sport;
            const playerObj = refPlay
              ? { id: refPlay.playerId, name, team: refPlay.playerTeam, sportKey: SPORT_KEY_MAP[refPlay.sport] || sportKey,
                  opponent: refPlay.opponent, oppRank: refPlay.oppRank, oppMetricValue: refPlay.oppMetricValue,
                  oppMetricLabel: refPlay.oppMetricLabel, oppMetricUnit: refPlay.oppMetricUnit,
                  playSport: refPlay.sport, playThreshold: refPlay.threshold, playStat: refPlay.stat }
              : { name, sportKey };
            return (
              <div key={key} style={{...rowStyle, flexDirection:'column', alignItems:'stretch', cursor: navigateToPlayer ? 'pointer' : 'default'}}
                onClick={() => navigateToPlayer && navigateToPlayer(playerObj, refPlay?.stat || null)}>
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <span style={{...posStyle,flexShrink:0}}>{posLabel}</span>
                  <img src={imgSrc} alt={name} style={{width:32,height:32,borderRadius:8,objectFit:'cover',objectPosition:'top',background:'#21262d',flexShrink:0}}
                    onError={e=>e.target.style.visibility='hidden'}/>
                  <span style={{color:'#c9d1d9',fontSize:13,flex:1,fontWeight: hasPlays ? 600 : 400,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name}</span>
                  {subLabel && <span style={subStyle}>{subLabel}</span>}
                  {navigateToPlayer && <span style={{color:'#484f58',fontSize:11,flexShrink:0}}>›</span>}
                </div>
                {sortedPlays.map((pl, i) => (
                  <div key={i} onClick={e => e.stopPropagation()}>
                    <MiniPlayCard play={pl}/>
                  </div>
                ))}
              </div>
            );
          };

          // 2-column grid on desktop, 1-column on mobile
          const isMobile = typeof window !== 'undefined' && window.innerWidth <= 480;

          return (
            <div style={{marginTop:22}}>
              {!lineupConfirmed && (
                <div style={{color:'#e3b341',fontSize:11,marginBottom:10,padding:'5px 10px',
                  background:'rgba(227,179,65,0.08)',borderRadius:6,border:'1px solid rgba(227,179,65,0.2)'}}>
                  Depth chart order — today's lineup not yet confirmed
                </div>
              )}
              {sport === 'nba' && (
                <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'repeat(2,1fr)',gap:8}}>
                  {lineup.map(p => renderLineupRow({
                    key: p.position,
                    posLabel: p.position,
                    posStyle: {color:'#58a6ff',fontSize:11,fontWeight:700,width:32},
                    imgSrc: `https://a.espncdn.com/i/headshots/nba/players/full/${p.playerId}.png`,
                    name: p.name,
                    subLabel: null,
                    subStyle: {},
                    rowStyle: {display:'flex',background:'#0d1117',border:'1px solid #21262d',borderRadius:8,padding:'8px 12px'},
                  }))}
                </div>
              )}
              {sport === 'mlb' && (
                <div style={{display:'flex',flexDirection:'column',gap:3}}>
                  <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'repeat(2,1fr)',gap:8}}>
                    {lineup.filter(p => !p.isProbable).map((p, i) => renderLineupRow({
                      key: p.spot ?? p.playerId ?? i,
                      posLabel: p.spot,
                      posStyle: {color:'#58a6ff',fontSize:11,fontWeight:700,width:24,textAlign:'right'},
                      imgSrc: `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${p.playerId}/headshot/67/current`,
                      name: p.name,
                      subLabel: p.position,
                      subStyle: {color:'#484f58',fontSize:11},
                      rowStyle: {display:'flex',background:'#0d1117',border:'1px solid #21262d',borderRadius:8,padding:'8px 12px'},
                    }))}
                  </div>
                  {lineup.filter(p => p.isProbable).map(p => renderLineupRow({
                    key: 'sp',
                    posLabel: 'SP',
                    posStyle: {color:'#58a6ff',fontSize:11,fontWeight:700,width:24,textAlign:'right'},
                    imgSrc: `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${p.playerId}/headshot/67/current`,
                    name: p.name,
                    subLabel: 'probable',
                    subStyle: {color:'#484f58',fontSize:10},
                    rowStyle: {display:'flex',marginTop:6,background:'rgba(88,166,255,0.06)',border:'1px solid rgba(88,166,255,0.2)',borderRadius:8,padding:'8px 12px'},
                  }))}
                </div>
              )}
            </div>
          );
        })()}

        {/* Game log table */}
        <div style={{marginTop:22,overflowX:'auto'}}>
          <div style={{color:'#484f58',fontSize:10,marginBottom:6}}>Game Log — 2025-26</div>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead>
              <tr>
                {glCols.map(c => (
                  <th key={c.key} onClick={() => toggleSort(c.key)} style={thStyle(c.key)}>
                    {c.label}{glSort.col===c.key?(glSort.dir==='desc'?'↓':'↑'):''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedGL.map((g, i) => {
                const isW = g.result === 'W';
                return (
                  <tr key={`${g.date}-${i}`} style={{
                    borderTop:'1px solid #21262d',
                    background: i%2===0?'#0d1117':'transparent'}}>
                    <td style={{padding:'5px 8px',color:'#8b949e',textAlign:'left'}}>{g.date ? g.date.slice(5) : '—'}</td>
                    <td style={{padding:'5px 8px',color:'#484f58',textAlign:'center'}}>{g.isHome ? '' : '@'}</td>
                    <td style={{padding:'5px 8px',color:'#c9d1d9',textAlign:'left'}}>
                      <button onClick={() => navigateToTeam(g.opp, sport)}
                        style={{background:'none',border:'none',color:'#c9d1d9',cursor:'pointer',padding:0,fontSize:12,textDecoration:'underline',textDecorationColor:'#484f58'}}>
                        {g.opp}
                      </button>
                    </td>
                    <td style={{padding:'5px 8px',textAlign:'right',color:'#c9d1d9',fontWeight:600}}>{g.teamScore}</td>
                    <td style={{padding:'5px 8px',textAlign:'right',color:'#8b949e'}}>{g.oppScore}</td>
                    <td style={{padding:'5px 8px',textAlign:'right',color:
                      tonightPlay && g.total >= tonightPlay.threshold ? '#3fb950' :
                      tonightPlay && g.total < tonightPlay.threshold ? '#f78166' : '#c9d1d9',
                      fontWeight:600}}>{g.total}</td>
                    <td style={{padding:'5px 8px',textAlign:'right',color:isW?'#3fb950':'#f78166',fontWeight:700}}>
                      {g.result || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}

const STAT_CONFIGS = {
  'basketball/nba': {
    points:   { label: 'Points',   thresholds: [10,15,20,25,30,35,40],    unit: 'PTS' },
    rebounds: { label: 'Rebounds', thresholds: [4,6,8,10,12,14,16],       unit: 'REB' },
    assists:  { label: 'Assists',  thresholds: [2,3,4,5,6,7,8,9,10],      unit: 'AST' },
    threePointers: { label: '3-Pointers', thresholds: [1,2,3,4,5,6,7], unit: '3PM' },
  },
  'football/nfl': {
    passingYards:   { label: 'Pass Yds',    thresholds: [150,200,250,300,350,400], unit: 'YDS' },
    completions:    { label: 'Completions', thresholds: [10,15,20,25,30,35],       unit: 'CMP' },
    attempts:       { label: 'Attempts',    thresholds: [20,25,30,35,40,45],       unit: 'ATT' },
    rushingYards:   { label: 'Rush Yds',    thresholds: [25,50,75,100,125,150],    unit: 'YDS' },
    receivingYards: { label: 'Rec Yds',     thresholds: [25,50,75,100,125,150],    unit: 'YDS' },
    receptions:     { label: 'Receptions',  thresholds: [2,3,4,5,6,7,8],          unit: 'REC' },
  },
  'baseball/mlb': {
    hrr:        { label: 'H+R+RBI',     thresholds: [1,2,3,4,5,6],       unit: 'HRR'},
    strikeouts: { label: 'Strikeouts',  thresholds: [3,4,5,6,7,8,9,10], unit: 'K'  },
  },
  'hockey/nhl': {
    shotsOnGoal: { label: 'Shots on Goal', thresholds: [2,3,4,5,6,7,8],     unit: 'SOG' },
    points:      { label: 'Points',        thresholds: [1,2,3,4],            unit: 'PTS' },
    saves:       { label: 'Saves',         thresholds: [20,25,30,35,40,45],  unit: 'SV'  },
  },
};

export { STAT_CONFIGS };
export default TeamPage;
