import React from 'react';
import { SPORT_KEY, STAT_LABEL } from '../lib/constants.js';
import { tierColor } from '../lib/colors.js';
import TotalsBarChart from './TotalsBarChart.jsx';

function TeamPage({ abbr, sport, teamPageData, tonightPlays, allTonightPlays, onBack, navigateToTeam, navigateToPlayer, trackedPlays, trackPlay, untrackPlay }) {
  const [glSort, setGlSort] = React.useState({ col:"date", dir:"desc" });

  const { loading, error, data } = teamPageData || {};
  const sportLabel = { mlb:"MLB", nba:"NBA", nhl:"NHL" }[sport] || sport.toUpperCase();
  const logoUrl = `https://a.espncdn.com/i/teamlogos/${sport}/500/${abbr.toLowerCase()}.png`;

  // All total plays for this team across all thresholds (from unfiltered allTonightPlays)
  const tonightTotals = (allTonightPlays || tonightPlays || []).filter(p =>
    p.gameType === "total" && p.sport === sport &&
    (p.homeTeam?.toUpperCase() === abbr || p.awayTeam?.toUpperCase() === abbr)
  );
  const tonightTotalMap = Object.fromEntries(tonightTotals.map(p => [p.threshold, p]));
  // Best play: earliest gameDate first, then highest edge among qualified
  const _tq = tonightTotals.filter(p => p.qualified !== false);
  const _tPool = _tq.length > 0 ? _tq : tonightTotals;
  const _tMinDate = _tPool.reduce((min, p) => (p.gameDate||"") < min ? (p.gameDate||"") : min, _tPool[0]?.gameDate||"");
  const tonightPlay = _tPool.filter(p => p.gameDate === _tMinDate).sort((a,b) => (b.edge||0) - (a.edge||0))[0] ?? null;

  if (loading) return (
    <div style={{textAlign:"center",padding:52,color:"#8b949e",fontSize:13}}>Loading {abbr} data…</div>
  );
  if (error) return (
    <div style={{textAlign:"center",padding:40,color:"#f78166",fontSize:13}}>Error: {error}</div>
  );
  if (!data) return null;

  const { teamName, record, wins, losses, gameLog, seasonStats, lineup, lineupConfirmed, nextGame } = data;

  // Game log sort
  const sortedGL = [...(gameLog || [])].sort((a, b) => {
    const { col, dir } = glSort;
    let va = a[col], vb = b[col];
    if (col === "isHome") { va = a.isHome ? 0 : 1; vb = b.isHome ? 0 : 1; }
    if (col === "result") { va = a.result || ""; vb = b.result || ""; }
    const cmp = typeof va === "string" ? va.localeCompare(vb) : (va ?? 0) - (vb ?? 0);
    return dir === "desc" ? -cmp : cmp;
  });

  const glCols = [
    { key:"date",    label:"Date",  align:"left"   },
    { key:"isHome",  label:"H/A",   align:"center" },
    { key:"opp",     label:"Opp",   align:"left"   },
    { key:"teamScore",label:"Us",                   },
    { key:"oppScore", label:"Opp",                  },
    { key:"total",   label:"Total",                 },
    { key:"result",  label:"W/L",                   },
  ];

  const thStyle = (col) => {
    const active = glSort.col === col;
    return {
      padding:"3px 8px", fontSize:10, textAlign: glCols.find(c=>c.key===col)?.align||"right",
      color: active ? "#c9d1d9" : "#484f58", cursor:"pointer", userSelect:"none",
      background:"#0d1117", position:"sticky", top:0,
    };
  };
  const toggleSort = col => setGlSort(prev =>
    prev.col === col ? { col, dir: prev.dir === "desc" ? "asc" : "desc" } : { col, dir: "desc" }
  );

  return (
    <div style={{marginBottom:20}}>
      <button onClick={onBack}
        style={{background:"none",border:"none",color:"#8b949e",fontSize:13,cursor:"pointer",
          padding:"0 0 12px 0",display:"flex",alignItems:"center",gap:4}}>
        ← Back
      </button>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
        <img src={logoUrl} alt={abbr}
          onError={e => e.target.style.visibility="hidden"}
          style={{width:52,height:52,objectFit:"contain",background:"#161b22",borderRadius:8,padding:4,flexShrink:0}}/>
        <div>
          <h1 style={{color:"#fff",margin:0,fontSize:19,fontWeight:700}}>{teamName}</h1>
          <div style={{color:"#8b949e",fontSize:12}}>{sportLabel} 2025-26{record ? ` · ${record}` : ""}</div>
          {(nextGame?.gameTime || tonightPlay?.gameTime) && (() => {
            const src = nextGame?.gameTime ? nextGame : tonightPlay;
            const d = new Date(src.gameTime);
            const ptFmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"});
            const gamePT = ptFmt.format(d), todayPT = ptFmt.format(new Date()), tmrwPT = ptFmt.format(new Date(Date.now()+86400000));
            const dayLabel = gamePT === todayPT ? "Today" : gamePT === tmrwPT ? "Tomorrow" : new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric"}).format(d);
            const timePart = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"2-digit",hour12:true}).format(d);
            return <div style={{color:"#6e7681",fontSize:11,marginTop:2}}>{dayLabel} · {timePart} PT</div>;
          })()}
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          {[["W",wins],["L",losses],["Avg",seasonStats.avgTotal ?? "—"]].map(([l,v]) => (
            <div key={l} style={{background:"#161b22",border:"1px solid #30363d",borderRadius:8,padding:"7px 11px",textAlign:"center"}}>
              <div style={{color:"#58a6ff",fontSize:15,fontWeight:700}}>{v}</div>
              <div style={{color:"#8b949e",fontSize:10}}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Content card */}
      <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,padding:"20px 22px"}}>

        {/* Tonight's game explanation */}
        {tonightPlay && (() => {
          const tp = tonightPlay;
          const _isHome = tp.homeTeam?.toUpperCase() === abbr;
          const _opp = _isHome ? tp.awayTeam : tp.homeTeam;
          const matchupHeader = (
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
              <img src={`https://a.espncdn.com/i/teamlogos/${sport}/500/${(_opp||"").toLowerCase()}.png`}
                style={{width:18,height:18,objectFit:"contain"}} onError={e=>e.target.style.display="none"}/>
              <span style={{color:"#c9d1d9",fontSize:12,fontWeight:600}}>
                {_isHome ? `${_opp} @ ${abbr}` : `${abbr} @ ${_opp}`}
              </span>
            </div>
          );
          if (tp.sport === "mlb") {
            const sc = tp.totalSimScore;
            const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
            const hERA = tp.homeERA ?? null, aERA = tp.awayERA ?? null;
            const hRPG = tp.homeRPG ?? null, aRPG = tp.awayRPG ?? null;
            const pf = tp.parkFactor ?? 1;
            const et = tp.expectedTotal ?? null;
            const eraColor = v => v == null ? "#8b949e" : v > 4.5 ? "#3fb950" : v > 3.5 ? "#e3b341" : "#f78166";
            const rpgColor = v => v == null ? "#8b949e" : v > 5.0 ? "#3fb950" : v > 4.0 ? "#e3b341" : "#8b949e";
            const etColor = et == null ? "#8b949e" : et >= tp.threshold + 0.5 ? "#3fb950" : et >= tp.threshold - 0.5 ? "#e3b341" : "#8b949e";
            const hERAPts = hERA != null ? (hERA > 4.5 ? 3 : hERA > 3.5 ? 2 : 1) : 0;
            const aERAPts = aERA != null ? (aERA > 4.5 ? 3 : aERA > 3.5 ? 2 : 1) : 0;
            const hRPGPts = hRPG != null ? (hRPG > 5.0 ? 2 : hRPG > 4.0 ? 1 : 0) : 0;
            const aRPGPts = aRPG != null ? (aRPG > 5.0 ? 2 : aRPG > 4.0 ? 1 : 0) : 0;
            const gameOuLine = tp.gameOuLine ?? null;
            const mlbOuPts = tp.mlbOuPts ?? 1;
            const ouColor = gameOuLine == null ? "#8b949e" : gameOuLine >= 9.5 ? "#3fb950" : gameOuLine >= 7.5 ? "#e3b341" : "#f78166";
            const ouDesc = gameOuLine == null ? null : gameOuLine >= 9.5 ? "a high-scoring game, supports the over" : gameOuLine >= 7.5 ? "an average total" : "a low total — market doesn't expect high scoring";
            const scTitle = [`${tp.homeTeam} ERA (${hERA != null ? hERA.toFixed(2) : "—"}): ${hERA != null ? (hERA > 4.5 ? 2 : hERA > 3.5 ? 1 : 0) : 1}/2`,`${tp.awayTeam} ERA (${aERA != null ? aERA.toFixed(2) : "—"}): ${aERA != null ? (aERA > 4.5 ? 2 : aERA > 3.5 ? 1 : 0) : 1}/2`,`${tp.homeTeam} RPG (${hRPG != null ? hRPG.toFixed(1) : "—"}): ${hRPG != null ? (hRPG > 5.0 ? 2 : hRPG > 4.0 ? 1 : 0) : 1}/2`,`${tp.awayTeam} RPG (${aRPG != null ? aRPG.toFixed(1) : "—"}): ${aRPG != null ? (aRPG > 5.0 ? 2 : aRPG > 4.0 ? 1 : 0) : 1}/2`,`O/U (${gameOuLine != null ? gameOuLine : "—"}): ${mlbOuPts}/2`].join("\n");
            return (
              <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65,marginBottom:14}}>
                {matchupHeader}
                <span style={{color:"#c9d1d9"}}>{tp.awayTeam}</span>'s starter has{aERA != null ? <> a <span style={{color:eraColor(aERA),fontWeight:600}}>{aERA.toFixed(2)} ERA</span></> : " — ERA"}, facing a <span style={{color:"#c9d1d9"}}>{tp.homeTeam}</span> offense averaging{hRPG != null ? <> <span style={{color:rpgColor(hRPG),fontWeight:600}}>{hRPG.toFixed(1)}</span> runs/game</> : " — RPG"}.
                {" "}<span style={{color:"#c9d1d9"}}>{tp.homeTeam}</span>'s starter posts{hERA != null ? <> a <span style={{color:eraColor(hERA),fontWeight:600}}>{hERA.toFixed(2)} ERA</span></> : " — ERA"} against a <span style={{color:"#c9d1d9"}}>{tp.awayTeam}</span> offense at{aRPG != null ? <> <span style={{color:rpgColor(aRPG),fontWeight:600}}>{aRPG.toFixed(1)}</span> RPG</> : " — RPG"}.
                {Math.abs(pf - 1) > 0.01 && <>{" "}Tonight's park {pf > 1 ? "inflates run scoring" : "suppresses run scoring"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}%</span>).</>}
                {gameOuLine != null && <>{" "}Game total <span style={{color:ouColor,fontWeight:600}}>{gameOuLine}</span><span style={{color:"#8b949e"}}> — {ouDesc}.</span></>}
                {et != null && <>{" "}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined runs.</>}
                {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"default"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
              </div>
            );
          }
          if (tp.sport === "nba") {
            const sc = tp.totalSimScore;
            const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
            const hOff = tp.homeOff ?? null, aOff = tp.awayOff ?? null;
            const hDef = tp.homeDef ?? null, aDef = tp.awayDef ?? null;
            const hPace = tp.homePace ?? null, aPace = tp.awayPace ?? null;
            const lgPace = tp.leagueAvgPace ?? null;
            const et = tp.expectedTotal ?? null;
            const paceAdj = (hPace != null && aPace != null && lgPace != null) ? parseFloat(((hPace + aPace) / 2 - lgPace).toFixed(1)) : null;
            const offColor = v => v == null ? "#8b949e" : v >= 118 ? "#f78166" : v >= 113 ? "#e3b341" : "#8b949e";
            const defColor = v => v == null ? "#8b949e" : v >= 118 ? "#3fb950" : v >= 113 ? "#e3b341" : "#f78166";
            const paceColor = paceAdj == null ? "#8b949e" : paceAdj > 0 ? "#3fb950" : paceAdj > -2 ? "#e3b341" : "#8b949e";
            const etColor = et == null ? "#8b949e" : et >= tp.threshold + 2 ? "#3fb950" : et >= tp.threshold - 2 ? "#e3b341" : "#8b949e";
            const nbaOuLine = tp.gameOuLine ?? null; const nbaOuPts = nbaOuLine == null ? 1 : nbaOuLine >= 235 ? 2 : nbaOuLine >= 225 ? 1 : 0;
            const scTitle = [`${tp.homeTeam} off PPG (${hOff != null ? hOff.toFixed(0) : "—"}): ${hOff != null ? (hOff >= 118 ? 2 : hOff >= 113 ? 1 : 0) : 1}/2`,`${tp.awayTeam} off PPG (${aOff != null ? aOff.toFixed(0) : "—"}): ${aOff != null ? (aOff >= 118 ? 2 : aOff >= 113 ? 1 : 0) : 1}/2`,`${tp.homeTeam} def allowed (${hDef != null ? hDef.toFixed(0) : "—"}): ${hDef != null ? (hDef >= 118 ? 2 : hDef >= 113 ? 1 : 0) : 1}/2`,`${tp.awayTeam} def allowed (${aDef != null ? aDef.toFixed(0) : "—"}): ${aDef != null ? (aDef >= 118 ? 2 : aDef >= 113 ? 1 : 0) : 1}/2`,`O/U (${nbaOuLine ?? "—"}): ${nbaOuPts}/2`].join("\n");
            return (
              <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65,marginBottom:14}}>
                {matchupHeader}
                <span style={{color:"#c9d1d9"}}>{tp.awayTeam}</span> averages{aOff != null ? <> <span style={{color:offColor(aOff),fontWeight:600}}>{aOff.toFixed(0)} PPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{tp.homeTeam}</span> defense allowing{hDef != null ? <> <span style={{color:defColor(hDef),fontWeight:600}}>{hDef.toFixed(0)} PPG</span></> : " —"}.
                {" "}<span style={{color:"#c9d1d9"}}>{tp.homeTeam}</span> averages{hOff != null ? <> <span style={{color:offColor(hOff),fontWeight:600}}>{hOff.toFixed(0)} PPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{tp.awayTeam}</span> defense allowing{aDef != null ? <> <span style={{color:defColor(aDef),fontWeight:600}}>{aDef.toFixed(0)} PPG</span></> : " —"}.
                {paceAdj != null && <>{" "}Game pace is <span style={{color:paceColor,fontWeight:600}}>{paceAdj > 0 ? "+" : ""}{paceAdj}</span> vs league avg{paceAdj > 0 ? " — more possessions, more scoring" : paceAdj > -2 ? " — near league average" : " — slower game, fewer possessions"}.</>}
                {et != null && <>{" "}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined pts.</>}
                {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"default"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
              </div>
            );
          }
          if (tp.sport === "nhl") {
            const sc = tp.totalSimScore;
            const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
            const hGPG = tp.homeGPG ?? null, aGPG = tp.awayGPG ?? null;
            const hGAA = tp.homeGAA ?? null, aGAA = tp.awayGAA ?? null;
            const et = tp.expectedTotal ?? null;
            const gpgColor = v => v == null ? "#8b949e" : v >= 3.5 ? "#3fb950" : v >= 3.0 ? "#e3b341" : "#8b949e";
            const gaaColor = v => v == null ? "#8b949e" : v >= 3.5 ? "#3fb950" : v >= 3.0 ? "#e3b341" : "#8b949e";
            const etColor = et == null ? "#8b949e" : et >= tp.threshold + 0.5 ? "#3fb950" : et >= tp.threshold - 0.5 ? "#e3b341" : "#8b949e";
            const _gpgPts = v => v == null ? 1 : v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0;
            const _gaaPts = v => v == null ? 1 : v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0;
            const nhlOuLine = tp.gameOuLine ?? null; const nhlOuPts = nhlOuLine == null ? 1 : nhlOuLine >= 7 ? 2 : nhlOuLine >= 5.5 ? 1 : 0;
            const scTitle = [`${tp.homeTeam} GPG (${hGPG ?? "—"}): ${_gpgPts(hGPG)}/2`,`${tp.awayTeam} GPG (${aGPG ?? "—"}): ${_gpgPts(aGPG)}/2`,`${tp.homeTeam} GAA (${hGAA ?? "—"}): ${_gaaPts(hGAA)}/2`,`${tp.awayTeam} GAA (${aGAA ?? "—"}): ${_gaaPts(aGAA)}/2`,`O/U (${nhlOuLine ?? "—"}): ${nhlOuPts}/2`].join("\n");
            return (
              <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65,marginBottom:14}}>
                {matchupHeader}
                <span style={{color:"#c9d1d9"}}>{tp.awayTeam}</span> averages{aGPG != null ? <> <span style={{color:gpgColor(aGPG),fontWeight:600}}>{aGPG.toFixed(1)} GPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{tp.homeTeam}</span> defense with{hGAA != null ? <> <span style={{color:gaaColor(hGAA),fontWeight:600}}>{hGAA.toFixed(2)} GAA</span></> : " — GAA"}.
                {" "}<span style={{color:"#c9d1d9"}}>{tp.homeTeam}</span> averages{hGPG != null ? <> <span style={{color:gpgColor(hGPG),fontWeight:600}}>{hGPG.toFixed(1)} GPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{tp.awayTeam}</span> defense allowing{aGAA != null ? <> <span style={{color:gaaColor(aGAA),fontWeight:600}}>{aGAA.toFixed(2)} GAA</span></> : " — GAA"}.
                {et != null && <>{" "}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined goals.</>}
                {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"default"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
              </div>
            );
          }
          return null;
        })()}

        {/* Totals bar chart */}
        <TotalsBarChart gameLog={gameLog} sport={sport}
          tonightTotalMap={tonightTotalMap} tonightPlay={tonightPlay}
          trackedPlays={trackedPlays} onTrack={trackPlay} onUntrack={untrackPlay}/>

        {/* Lineup — shown above game log when available */}
        {lineup.length > 0 && (() => {
          // Build a map of playerName → qualifying plays for inline play cards
          const allPlays = allTonightPlays || tonightPlays || [];
          const playerPlaysMap = {};
          allPlays.forEach(pl => {
            if (pl.gameType === "total") return;
            const key = pl.playerName;
            if (!playerPlaysMap[key]) playerPlaysMap[key] = [];
            playerPlaysMap[key].push(pl);
          });

          // Render a compact inline play card row
          const MiniPlayCard = ({ play }) => {
            const tc = tierColor(play.truePct);
            const tp = play.truePct;
            const trueOdds = tp != null ? (tp >= 100 ? -99999 : tp >= 50 ? Math.round(-(tp/(100-tp))*100) : Math.round((100-tp)/tp*100)) : null;
            const trueOddsStr = trueOdds != null ? (trueOdds > 0 ? `+${trueOdds}` : `${trueOdds}`) : null;
            const kp = play.kalshiPct;
            const kOdds = play.americanOdds;
            const kOddsStr = kOdds != null ? (kOdds > 0 ? `+${kOdds}` : `${kOdds}`) : null;
            const isQual = play.qualified !== false;
            return (
              <div style={{marginTop:6,background:"#161b22",border:`1px solid ${isQual?"#30363d":"#21262d"}`,borderRadius:8,padding:"8px 10px"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                  <span style={{background:"rgba(88,166,255,0.12)",border:"1px solid #58a6ff",
                    borderRadius:5,padding:"1px 7px",fontSize:11,color:"#58a6ff",fontWeight:700,whiteSpace:"nowrap"}}>
                    {play.threshold}+ {STAT_LABEL[play.stat] || play.stat}
                  </span>
                  {isQual && play.edge != null && (
                    <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                      borderRadius:5,padding:"1px 7px",fontSize:11,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                      +{play.edge}%
                    </span>
                  )}
                  {!isQual && <span style={{fontSize:10,color:"#484f58"}}>unqualified</span>}
                </div>
                {/* True% bar */}
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                  <div style={{flex:1,background:"#21262d",borderRadius:3,height:10,overflow:"hidden"}}>
                    <div style={{width:`${tp}%`,background:tc,height:"100%",borderRadius:3,minWidth:tp>0?2:0}}/>
                  </div>
                  <div style={{width:80,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:3}}>
                    <span style={{color:tc,fontSize:11,fontWeight:700}}>{tp}%</span>
                    {trueOddsStr && <span style={{color:tc,fontSize:10}}>({trueOddsStr})</span>}
                  </div>
                </div>
                {/* Kalshi bar */}
                {kp != null && (
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{flex:1,background:"#21262d",borderRadius:3,height:8,overflow:"hidden"}}>
                      <div style={{width:`${kp}%`,background:"#6e40c9",height:"100%",borderRadius:3,minWidth:kp>0?2:0}}/>
                    </div>
                    <div style={{width:80,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:3}}>
                      <span style={{color:"#6e40c9",fontSize:11,fontWeight:600}}>{kp}%</span>
                      {kOddsStr && <span style={{color:"#6e40c9",fontSize:10}}>({kOddsStr})</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          };

          const renderLineupRow = ({ key, posLabel, posStyle, imgSrc, name, subLabel, subStyle, rowStyle, isProb }) => {
            const plays = playerPlaysMap[name] || [];
            // Sort: qualified first, then by threshold ascending
            const sortedPlays = [...plays].sort((a,b) => {
              if ((a.qualified !== false) !== (b.qualified !== false)) return (a.qualified !== false) ? -1 : 1;
              return (a.threshold||0) - (b.threshold||0);
            });
            const hasPlays = sortedPlays.length > 0;
            const refPlay = sortedPlays[0];
            const sportKey = sport === "mlb" ? "baseball/mlb" : sport === "nba" ? "basketball/nba" : "hockey/nhl";
            const SPORT_KEY_MAP = { mlb:"baseball/mlb", nba:"basketball/nba", nhl:"hockey/nhl" };
            const playerObj = refPlay
              ? { id: refPlay.playerId, name, team: refPlay.playerTeam, sportKey: SPORT_KEY_MAP[refPlay.sport] || sportKey,
                  opponent: refPlay.opponent, oppRank: refPlay.oppRank, oppMetricValue: refPlay.oppMetricValue,
                  oppMetricLabel: refPlay.oppMetricLabel, oppMetricUnit: refPlay.oppMetricUnit,
                  playSport: refPlay.sport, playThreshold: refPlay.threshold, playStat: refPlay.stat }
              : { name, sportKey };
            return (
              <div key={key} style={{...rowStyle, flexDirection:"column", alignItems:"stretch", cursor: navigateToPlayer ? "pointer" : "default"}}
                onClick={() => navigateToPlayer && navigateToPlayer(playerObj, refPlay?.stat || null)}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{...posStyle,flexShrink:0}}>{posLabel}</span>
                  <img src={imgSrc} alt={name} style={{width:32,height:32,borderRadius:8,objectFit:"cover",objectPosition:"top",background:"#21262d",flexShrink:0}}
                    onError={e=>e.target.style.visibility="hidden"}/>
                  <span style={{color:"#c9d1d9",fontSize:13,flex:1,fontWeight: hasPlays ? 600 : 400}}>{name}</span>
                  {subLabel && <span style={subStyle}>{subLabel}</span>}
                  {navigateToPlayer && <span style={{color:"#484f58",fontSize:11,flexShrink:0}}>›</span>}
                </div>
                {sortedPlays.map((pl, i) => (
                  <div key={i} onClick={e => e.stopPropagation()}>
                    <MiniPlayCard play={pl}/>
                  </div>
                ))}
              </div>
            );
          };

          return (
            <div style={{marginTop:22}}>
              {!lineupConfirmed && (
                <div style={{color:"#e3b341",fontSize:11,marginBottom:10,padding:"5px 10px",
                  background:"rgba(227,179,65,0.08)",borderRadius:6,border:"1px solid rgba(227,179,65,0.2)"}}>
                  Depth chart order — today's lineup not yet confirmed
                </div>
              )}
              {sport === "nba" && (
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  {lineup.map(p => renderLineupRow({
                    key: p.position,
                    posLabel: p.position,
                    posStyle: {color:"#58a6ff",fontSize:11,fontWeight:700,width:32},
                    imgSrc: `https://a.espncdn.com/i/headshots/nba/players/full/${p.playerId}.png`,
                    name: p.name,
                    subLabel: null,
                    subStyle: {},
                    rowStyle: {display:"flex",background:"#0d1117",border:"1px solid #21262d",borderRadius:8,padding:"8px 12px"},
                  }))}
                </div>
              )}
              {sport === "mlb" && (
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  {lineup.filter(p => !p.isProbable).map((p, i) => renderLineupRow({
                    key: p.spot ?? p.playerId ?? i,
                    posLabel: p.spot,
                    posStyle: {color:"#58a6ff",fontSize:11,fontWeight:700,width:24,textAlign:"right"},
                    imgSrc: `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${p.playerId}/headshot/67/current`,
                    name: p.name,
                    subLabel: p.position,
                    subStyle: {color:"#484f58",fontSize:11},
                    rowStyle: {display:"flex",background:"#0d1117",border:"1px solid #21262d",borderRadius:8,padding:"8px 12px"},
                  }))}
                  {lineup.filter(p => p.isProbable).map(p => renderLineupRow({
                    key: "sp",
                    posLabel: "SP",
                    posStyle: {color:"#58a6ff",fontSize:11,fontWeight:700,width:24,textAlign:"right"},
                    imgSrc: `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${p.playerId}/headshot/67/current`,
                    name: p.name,
                    subLabel: "probable",
                    subStyle: {color:"#484f58",fontSize:10},
                    rowStyle: {display:"flex",marginTop:6,background:"rgba(88,166,255,0.06)",border:"1px solid rgba(88,166,255,0.2)",borderRadius:8,padding:"8px 12px"},
                    isProb: true,
                  }))}
                </div>
              )}
            </div>
          );
        })()}

        {/* Game log table */}
        <div style={{marginTop:22,overflowX:"auto"}}>
          <div style={{color:"#484f58",fontSize:10,marginBottom:6}}>Game Log — 2025-26</div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr>
                {glCols.map(c => (
                  <th key={c.key} onClick={() => toggleSort(c.key)} style={thStyle(c.key)}>
                    {c.label}{glSort.col===c.key?(glSort.dir==="desc"?"↓":"↑"):""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedGL.map((g, i) => {
                const isW = g.result === "W";
                return (
                  <tr key={`${g.date}-${i}`} style={{
                    borderTop:"1px solid #21262d",
                    background: i%2===0?"#0d1117":"transparent"}}>
                    <td style={{padding:"5px 8px",color:"#8b949e",textAlign:"left"}}>{g.date ? g.date.slice(5) : "—"}</td>
                    <td style={{padding:"5px 8px",color:"#484f58",textAlign:"center"}}>{g.isHome ? "" : "@"}</td>
                    <td style={{padding:"5px 8px",color:"#c9d1d9",textAlign:"left"}}>
                      <button onClick={() => navigateToTeam(g.opp, sport)}
                        style={{background:"none",border:"none",color:"#c9d1d9",cursor:"pointer",padding:0,fontSize:12,textDecoration:"underline",textDecorationColor:"#484f58"}}>
                        {g.opp}
                      </button>
                    </td>
                    <td style={{padding:"5px 8px",textAlign:"right",color:"#c9d1d9",fontWeight:600}}>{g.teamScore}</td>
                    <td style={{padding:"5px 8px",textAlign:"right",color:"#8b949e"}}>{g.oppScore}</td>
                    <td style={{padding:"5px 8px",textAlign:"right",color:
                      tonightPlay && g.total >= tonightPlay.threshold ? "#3fb950" :
                      tonightPlay && g.total < tonightPlay.threshold ? "#f78166" : "#c9d1d9",
                      fontWeight:600}}>{g.total}</td>
                    <td style={{padding:"5px 8px",textAlign:"right",color:isW?"#3fb950":"#f78166",fontWeight:700}}>
                      {g.result || "—"}
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
  "basketball/nba": {
    points:   { label: "Points",   thresholds: [10,15,20,25,30,35,40],    unit: "PTS" },
    rebounds: { label: "Rebounds", thresholds: [4,6,8,10,12,14,16],       unit: "REB" },
    assists:  { label: "Assists",  thresholds: [2,3,4,5,6,7,8,9,10],      unit: "AST" },
    threePointers: { label: "3-Pointers", thresholds: [1,2,3,4,5,6,7], unit: "3PM" },
  },
  "football/nfl": {
    passingYards:   { label: "Pass Yds",    thresholds: [150,200,250,300,350,400], unit: "YDS" },
    completions:    { label: "Completions", thresholds: [10,15,20,25,30,35],       unit: "CMP" },
    attempts:       { label: "Attempts",    thresholds: [20,25,30,35,40,45],       unit: "ATT" },
    rushingYards:   { label: "Rush Yds",    thresholds: [25,50,75,100,125,150],    unit: "YDS" },
    receivingYards: { label: "Rec Yds",     thresholds: [25,50,75,100,125,150],    unit: "YDS" },
    receptions:     { label: "Receptions",  thresholds: [2,3,4,5,6,7,8],          unit: "REC" },
  },
  "baseball/mlb": {
    hrr:        { label: "H+R+RBI",     thresholds: [1,2,3,4,5,6],       unit: "HRR"},
    strikeouts: { label: "Strikeouts",  thresholds: [3,4,5,6,7,8,9,10], unit: "K"  },
  },
  "hockey/nhl": {
    shotsOnGoal: { label: "Shots on Goal", thresholds: [2,3,4,5,6,7,8],     unit: "SOG" },
    points:      { label: "Points",        thresholds: [1,2,3,4],            unit: "PTS" },
    saves:       { label: "Saves",         thresholds: [20,25,30,35,40,45],  unit: "SV"  },
  },
};



export { STAT_CONFIGS };
export default TeamPage;
