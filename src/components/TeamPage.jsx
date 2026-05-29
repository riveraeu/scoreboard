import React from 'react';
import { WORKER } from '../lib/constants.js';
import { useIsMobile } from '../lib/hooks.js';
import TotalsBarChart from './TotalsBarChart.jsx';

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
      .reduce((a, p) => Math.max(a, p.edge ?? 0), -Infinity);
    if (mx > bestEdge) { bestEdge = mx; best = pt.key; }
  }
  return best;
}

// ── Component ─────────────────────────────────────────────────────────────────
function TeamPage({ abbr, sport, teamPageData, tonightPlays, tonightLoading, allTonightPlays, onBack, navigateToTeam, navigateToPlayer, trackedPlays, trackPlay, untrackPlay }) {
  const [glSort, setGlSort] = React.useState({ col:'date', dir:'desc' });
  const isMobile = useIsMobile(768);

  const { loading, error, data } = teamPageData || {};
  const sportLabel = { mlb:'MLB', nba:'NBA', nhl:'NHL' }[sport] || sport.toUpperCase();
  const logoUrl = `https://a.espncdn.com/i/teamlogos/${sport}/500/${abbr.toLowerCase()}.png`;

  const _allPlays = allTonightPlays || tonightPlays || [];

  // Build per-tab total maps
  const _allMaps = {};
  for (const pt of PLAY_TYPES) {
    _allMaps[pt.key] = buildTotalMapFn(_allPlays, abbr, sport, pt.gameType, pt.isUnder);
  }

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
  const activePlay = _activeVals
    .sort((a,b) => (b.edge||0)-(a.edge||0))[0] ?? null;

  // Original tonightPlay kept for game log color-coding and header fallback
  const tonightTotals = _allPlays.filter(p =>
    p.gameType === 'total' && p.sport === sport &&
    (p.homeTeam?.toUpperCase() === abbr || p.awayTeam?.toUpperCase() === abbr)
  );
  const _tMinDate = tonightTotals.reduce((min, p) => (p.gameDate||'') < min ? (p.gameDate||'') : min, tonightTotals[0]?.gameDate||'');
  const tonightPlay = tonightTotals.filter(p => p.gameDate === _tMinDate).sort((a,b) => (b.edge||0)-(a.edge||0))[0] ?? null;

  // Fetch ALL alt-line Kalshi prices for this matchup (game total + team total) — fills tabs
  // outside the universal [67, 91] gate that /api/tonight skips. One fetch per gameType per
  // page load. Cached server-side 5min. altKalshi[playType] = { thresholds: { N: {pct, ...} } }.
  const [altKalshi, setAltKalshi] = React.useState({ total: {}, teamTotal: {} });
  React.useEffect(() => {
    if (!tonightPlay || !tonightPlay.homeTeam || !tonightPlay.awayTeam) return;
    const { homeTeam, awayTeam } = tonightPlay;
    const params = `sport=${sport}&awayTeam=${awayTeam}&homeTeam=${homeTeam}`;
    const fetches = [
      fetch(`${WORKER}/kalshi-totals?${params}&gameType=total`).then(r => r.ok ? r.json() : { thresholds: {} }).catch(() => ({ thresholds: {} })),
    ];
    // Team total: only for sports where the series exists (MLB/NBA). Always scope to abbr.
    if (sport === 'mlb' || sport === 'nba') {
      fetches.push(
        fetch(`${WORKER}/kalshi-totals?${params}&gameType=teamTotal&scoringTeam=${abbr}`).then(r => r.ok ? r.json() : { thresholds: {} }).catch(() => ({ thresholds: {} }))
      );
    }
    Promise.all(fetches).then(([gt, tt]) => {
      setAltKalshi({ total: gt?.thresholds || {}, teamTotal: tt?.thresholds || {} });
    });
  }, [abbr, sport, tonightPlay?.homeTeam, tonightPlay?.awayTeam, tonightPlay?.gameDate]);

  function handleTabChange(newType) {
    setPlayType(newType);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('playType', newType);
      history.replaceState(null, '', url.toString());
    } catch {}
  }

  // Show loading when EITHER the team data fetch is in-flight OR the global tonightPlays fetch
  // hasn't completed (direct URL access lands here before /api/tonight returns; without this
  // gate the threshold tabs and lambda panel render empty even though data is en route).
  if (loading || (tonightLoading && !tonightPlays)) return (
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


        {/* Totals bar chart — passes tab state + alt-line Kalshi prices for tabs outside [67,91].
            allMatchupPlays = ALL plays of the active gameType for this matchup (any direction)
            so the Lambda Inputs panel can find a play with lambda data even when the
            active-direction map is empty (e.g. Game Under with no qualifying UNDER plays). */}
        <TotalsBarChart gameLog={gameLog} sport={sport}
          tonightTotalMap={activeTotalMap} tonightPlay={activePlay}
          extraAltMap={_activeType.startsWith('team_') ? altKalshi.teamTotal : altKalshi.total}
          allMatchupPlays={(_allPlays || []).filter(p =>
            p.sport === sport && p.gameType === (_activeType.startsWith('team_') ? 'teamTotal' : 'total') &&
            (_activeType.startsWith('team_')
              ? p.scoringTeam?.toUpperCase() === abbr
              : (p.homeTeam?.toUpperCase() === abbr || p.awayTeam?.toUpperCase() === abbr))
          )}
          trackedPlays={trackedPlays} onTrack={trackPlay} onUntrack={untrackPlay}
          playType={_activeType} onPlayTypeChange={handleTabChange}/>

        {/* Lineup (left) + Game Log (right) — side by side on desktop, stacked on mobile */}
        {(() => {
          const SPORT_KEY_MAP = { mlb:'baseball/mlb', nba:'basketball/nba', nhl:'hockey/nhl' };
          const sportKey = SPORT_KEY_MAP[sport] || sport;

          const renderLineupRow = ({ key, posLabel, posStyle, imgSrc, name, playerId, subLabel, subStyle, rowStyle }) => {
            const playerObj = { id: playerId, name, sportKey };
            return (
              <div key={key} style={{...rowStyle, display:'flex', alignItems:'center', gap:10, cursor: navigateToPlayer ? 'pointer' : 'default'}}
                onClick={() => navigateToPlayer && navigateToPlayer(playerObj, null)}>
                <span style={{...posStyle,flexShrink:0}}>{posLabel}</span>
                <img src={imgSrc} alt={name} style={{width:32,height:32,borderRadius:8,objectFit:'cover',objectPosition:'top',background:'#21262d',flexShrink:0}}
                  onError={e=>e.target.style.visibility='hidden'}/>
                <span style={{color:'#c9d1d9',fontSize:13,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name}</span>
                {subLabel && <span style={subStyle}>{subLabel}</span>}
                {navigateToPlayer && <span style={{color:'#484f58',fontSize:11,flexShrink:0}}>›</span>}
              </div>
            );
          };

          const lineupCol = lineup.length > 0 ? (
            <div>
              <div style={{color:'#484f58',fontSize:10,marginBottom:6}}>Starting Lineup</div>
              {!lineupConfirmed && (
                <div style={{color:'#e3b341',fontSize:11,marginBottom:10,padding:'5px 10px',
                  background:'rgba(227,179,65,0.08)',borderRadius:6,border:'1px solid rgba(227,179,65,0.2)'}}>
                  Depth chart order — today's lineup not yet confirmed
                </div>
              )}
              {sport === 'nba' && (
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {lineup.map(p => renderLineupRow({
                    key: p.position,
                    posLabel: p.position,
                    posStyle: {color:'#58a6ff',fontSize:11,fontWeight:700,width:32},
                    imgSrc: `https://a.espncdn.com/i/headshots/nba/players/full/${p.playerId}.png`,
                    name: p.name,
                    playerId: p.playerId,
                    subLabel: null,
                    subStyle: {},
                    rowStyle: {background:'#0d1117',border:'1px solid #21262d',borderRadius:8,padding:'8px 12px'},
                  }))}
                </div>
              )}
              {sport === 'mlb' && (
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {lineup.filter(p => !p.isProbable).map((p, i) => renderLineupRow({
                    key: p.spot ?? p.playerId ?? i,
                    posLabel: p.spot,
                    posStyle: {color:'#58a6ff',fontSize:11,fontWeight:700,width:24,textAlign:'right'},
                    imgSrc: `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${p.playerId}/headshot/67/current`,
                    name: p.name,
                    playerId: p.playerId,
                    subLabel: p.position,
                    subStyle: {color:'#484f58',fontSize:11},
                    rowStyle: {background:'#0d1117',border:'1px solid #21262d',borderRadius:8,padding:'8px 12px'},
                  }))}
                  {lineup.filter(p => p.isProbable).map(p => renderLineupRow({
                    key: 'sp',
                    posLabel: 'SP',
                    posStyle: {color:'#58a6ff',fontSize:11,fontWeight:700,width:24,textAlign:'right'},
                    imgSrc: `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${p.playerId}/headshot/67/current`,
                    name: p.name,
                    playerId: p.playerId,
                    subLabel: 'probable',
                    subStyle: {color:'#484f58',fontSize:10},
                    rowStyle: {background:'rgba(88,166,255,0.06)',border:'1px solid rgba(88,166,255,0.2)',borderRadius:8,padding:'8px 12px'},
                  }))}
                </div>
              )}
            </div>
          ) : null;

          const gameLogCol = (
            <div style={{overflowX:'auto'}}>
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
          );

          // No lineup data (NHL, WNBA, or when the lineup endpoint returned empty) → game log full width
          if (!lineupCol) {
            return <div style={{marginTop:22}}>{gameLogCol}</div>;
          }
          return (
            <div style={{marginTop:22,display:'grid',gap:16,
              gridTemplateColumns: isMobile ? '1fr' : 'minmax(0,1fr) minmax(0,1.6fr)'}}>
              {lineupCol}
              {gameLogCol}
            </div>
          );
        })()}

      </div>
    </div>
  );
}

const STAT_CONFIGS = {
  'basketball/nba': {
    points:   { label: 'Points',   thresholds: [10,15,20,25,30,35,40],    unit: 'PTS' },
    rebounds: { label: 'Rebounds', thresholds: [2,4,6,8,10,12,14,16],     unit: 'REB' },
    assists:  { label: 'Assists',  thresholds: [2,3,4,5,6,7,8,9,10],      unit: 'AST' },
    threePointers: { label: '3-Pointers', thresholds: [1,2,3,4,5,6,7], unit: '3PM' },
  },
  'basketball/wnba': {
    points:   { label: 'Points',   thresholds: [10,15,20,25,30],          unit: 'PTS' },
    rebounds: { label: 'Rebounds', thresholds: [2,4,6,8,10,12],           unit: 'REB' },
    assists:  { label: 'Assists',  thresholds: [2,3,4,5,6,7,8],           unit: 'AST' },
    threePointers: { label: '3-Pointers', thresholds: [1,2,3,4,5],        unit: '3PM' },
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
