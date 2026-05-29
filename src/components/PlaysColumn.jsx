import React from 'react';
import { STAT_LABEL, STAT_FULL, MLB_TEAM } from '../lib/constants.js';
import { ordinal, logoUrl } from '../lib/utils.js';
import { tierColor } from '../lib/colors.js';
import { buildLambdaInputs } from '../lib/lambdaInputs.js';
import SimBadge from './SimBadge.jsx';
import InputList from './InputList.jsx';

// Display label for a segmented play's pill badge ("F5" / "1H" / "2H"). Returns null for
// non-segmented (full-game) picks so the pill renders only when meaningful.
const segmentPillLabel = (segment) => {
  if (segment === "f5") return "F5";
  if (segment === "1h") return "1H";
  if (segment === "2h") return "2H";
  return null;
};

function PlaysColumn({ tonightPlays, allTonightPlays, tonightLoading, sportFilter = [], statFilter = [], trackedPlays, trackPlay, untrackPlay, navigateToPlay, navigateToTeam, expandedPlays, setExpandedPlays, hideHeader, gridColumns }) {
  const cols = gridColumns || 1;
  return (
        <div>
          {tonightLoading ? (
            <div style={{color:"#8b949e",textAlign:"center",padding:52,fontSize:13}}>
              Loading plays…
            </div>
          ) : (() => {
            const untrackedPlays = (tonightPlays || []).filter(play => {
              if (sportFilter.length > 0 && !sportFilter.includes(play.sport)) return false;
              if (statFilter.length > 0 && !statFilter.includes(play.stat)) return false;
              return true;
            });
            if (untrackedPlays.length === 0) return (
              <div style={{color:"#484f58",textAlign:"center",padding:52,fontSize:13}}>
                No qualifying plays found.
              </div>
            );
            // Group plays by gameDate, sort dates ascending
            const ptDate = n => new Date(Date.now() + n*86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            const today = ptDate(0);
            const tomorrow = ptDate(1);
            const _ptFmtPl = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });
            const grouped = {};
            untrackedPlays.forEach(play => {
              const d = play.gameTime ? _ptFmtPl.format(new Date(play.gameTime)) : (play.gameDate || today);
              if (!grouped[d]) grouped[d] = [];
              grouped[d].push(play);
            });
            const sortedDates = Object.keys(grouped).sort();

            function dateLabel(d) {
              if (d === today) return "Today";
              if (d === tomorrow) return "Tomorrow";
              const [yr, mo, dy] = d.split("-").map(Number);
              return new Date(yr, mo-1, dy).toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" });
            }

            const _dateGroups = sortedDates.map(date => (
              <div key={date} style={cols > 1 ? {display:'contents'} : {}}>
                {/* Date header — hidden when embedded in LineupsPage and there's only one date group */}
                {(!hideHeader || sortedDates.length > 1) && (
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,marginTop: date === sortedDates[0] ? 0 : 20, ...(cols > 1 && {gridColumn:'1 / -1'})}}>
                    <div style={{color: date === today ? "#e3b341" : "#c9d1d9", fontSize:13, fontWeight:700}}>
                      {dateLabel(date)}
                    </div>
                    <div style={{flex:1,height:1,background:"#21262d"}}/>
                    <div style={{color:"#484f58",fontSize:11}}>{grouped[date].length} play{grouped[date].length !== 1 ? "s" : ""}</div>
                  </div>
                )}

                {[...grouped[date]].sort((a, b) => {
                  const ta = a.gameTime || "9999";
                  const tb = b.gameTime || "9999";
                  return ta < tb ? -1 : ta > tb ? 1 : b.edge - a.edge;
                }).map((play) => {
              const segSuffix = play.segment && play.segment !== "full" ? `-${play.segment}` : "";
              const playKey = play.gameType === "teamTotal"
                ? `teamtotal-${play.sport}-${play.scoringTeam}-${play.oppTeam}-${play.threshold}${play.direction === "under" ? "-under" : ""}`
                : play.gameType === "total"
                ? `total-${play.sport}${segSuffix}-${play.homeTeam}-${play.awayTeam}-${play.threshold}${play.direction === "under" ? "-under" : ""}`
                : play.gameType === "ml"
                ? `ml-${play.sport}${segSuffix}-${play.pickTeam}-${play.homeTeam}-${play.awayTeam}`
                : play.gameType === "spread"
                ? `spread-${play.sport}${segSuffix}-${play.pickTeam}-${play.homeTeam}-${play.awayTeam}-${play.pickLine}`
                : `${play.playerName}-${play.stat}-${play.threshold}`;
              const oddsStr = play.americanOdds >= 0 ? `+${play.americanOdds}` : `${play.americanOdds}`;
              const isExpanded = expandedPlays.has(playKey);
              const segIdSuffix = play.segment && play.segment !== "full" ? `|${play.segment}` : "";
              const trackId = play.gameType === "teamTotal"
                ? `teamtotal|${play.sport}|${play.scoringTeam}|${play.oppTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
                : play.gameType === "total"
                ? `total|${play.sport}${segIdSuffix}|${play.homeTeam}|${play.awayTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
                : play.gameType === "ml"
                ? `ml|${play.sport}${segIdSuffix}|${play.pickTeam}|${play.homeTeam}|${play.awayTeam}|${play.gameDate || ""}`
                : play.gameType === "spread"
                ? `spread|${play.sport}${segIdSuffix}|${play.pickTeam}|${play.homeTeam}|${play.awayTeam}|${play.pickLine}|${play.gameDate || ""}`
                : `${play.sport || "nba"}|${play.playerName}|${play.stat}|${play.threshold}|${play.gameDate || ""}`;
              const isTracked = trackedPlays.some(p => p.id === trackId);
              const headshotUrl = play.playerId ? `https://a.espncdn.com/i/headshots/${play.sport || "nba"}/players/full/${play.playerId}.png` : null;

              // ── Team total play card ────────────────────────────────────────────────────────────
              if (play.gameType === "teamTotal") {
                const isUnder = play.direction === "under";
                const tLabel = { teamRuns:"Runs", teamPoints:"Pts" }[play.stat] || play.stat;
                const lineVal = (play.threshold - 0.5).toFixed(1);
                const displayTruePct = isUnder ? play.noTruePct : play.truePct;
                const displayKalshiPct = isUnder ? play.noKalshiPct : play.kalshiPct;
                const tColor = tierColor(displayTruePct);
                const tTrueOdds = displayTruePct >= 100 ? -99999 : (displayTruePct >= 50 ? Math.round(-(displayTruePct/(100-displayTruePct))*100) : Math.round((100-displayTruePct)/displayTruePct*100));
                const tTrueOddsStr = tTrueOdds > 0 ? `+${tTrueOdds}` : `${tTrueOdds}`;
                const sc = play.teamTotalSimScore;
                const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                return (
                  <div key={playKey}
                    style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,
                      padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                    onMouseEnter={e => e.currentTarget.style.borderColor="#58a6ff"}
                    onMouseLeave={e => e.currentTarget.style.borderColor="#30363d"}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      <img src={`https://a.espncdn.com/i/teamlogos/${play.sport}/500/${(play.scoringTeam||"").toLowerCase()}.png`} alt={play.scoringTeam}
                        style={{width:22,height:22,objectFit:"contain",flexShrink:0}}
                        onError={e=>{e.target.style.visibility="hidden";}} />
                      {/* Bet headline: "TOR Under 5.5 Runs" — team + direction + line + stat in one
                          read. Matchup + time live on the MatchupCard above. */}
                      <span onClick={e=>{e.stopPropagation();navigateToTeam(play.scoringTeam,play.sport);}}
                        style={{flex:1,minWidth:0,fontSize:14,fontWeight:700,cursor:"pointer",lineHeight:1.3,color:"#c9d1d9"}}>
                        {play.scoringTeam} {isUnder ? "Under" : "Over"} {lineVal} {tLabel}
                      </span>
                      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                        <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                          +{play.edge}%
                        </span>
                        <button onClick={e => { e.stopPropagation(); if (isTracked) { untrackPlay(trackId); return; } trackPlay(play, e); }}
                          title={isTracked ? "Remove from My Picks" : "Add to My Picks"}
                          style={{background: isTracked ? "rgba(227,179,65,0.15)" : "transparent",
                            border: `1px solid ${isTracked ? "#e3b341" : "#30363d"}`,
                            borderRadius:6, padding:"2px 7px", cursor:"pointer",
                            color: isTracked ? "#e3b341" : "#484f58", fontSize:14, lineHeight:1}}>
                          {isTracked ? "★" : "☆"}
                        </button>
                      </div>
                    </div>
                    {/* Model probability bar */}
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:14,overflow:"hidden"}}>
                        <div style={{width:`${displayTruePct}%`,background:tColor,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:displayTruePct>0?3:0}}/>
                      </div>
                      <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                        <span style={{color:tColor,fontSize:12,fontWeight:700}}>{displayTruePct}%</span>
                        <span style={{color:tColor,fontSize:10}}>({tTrueOddsStr})</span>
                      </div>
                    </div>
                    {/* Kalshi price bar */}
                    {displayKalshiPct != null && (() => {
                      const kPct = displayKalshiPct;
                      const kOdds = kPct >= 50 ? Math.round(-(kPct/(100-kPct))*100) : Math.round((100-kPct)/kPct*100);
                      const kOddsStr = kOdds > 0 ? `+${kOdds}` : `${kOdds}`;
                      return (
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                          <div style={{flex:1,background:"#21262d",borderRadius:4,height:10,overflow:"hidden"}}>
                            <div style={{width:`${kPct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:kPct>0?3:0}}/>
                          </div>
                          <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                            <span style={{color:"#6e40c9",fontSize:12,fontWeight:600}}>{kPct}%</span>
                            <span style={{color:"#6e40c9",fontSize:10}}>({kOddsStr})</span>
                          </div>
                        </div>
                      );
                    })()}
                    <InputList inputs={buildLambdaInputs(play)} />
                  </div>
                );
              }
              // ── End team total play card ────────────────────────────────────────────────────────

              // ── Moneyline play card ────────────────────────────────────────────────────────────
              if (play.gameType === "ml") {
                const tColor = tierColor(play.truePct);
                const tTrueOdds = play.truePct >= 100 ? -99999 : (play.truePct >= 50 ? Math.round(-(play.truePct/(100-play.truePct))*100) : Math.round((100-play.truePct)/play.truePct*100));
                const tTrueOddsStr = tTrueOdds > 0 ? `+${tTrueOdds}` : `${tTrueOdds}`;
                const isTie = play.side === "tie";
                const _segPill = segmentPillLabel(play.segment);
                const mlLabel = _segPill ? `${_segPill} ML` : "ML";
                return (
                  <div key={playKey}
                    style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,
                      padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                    onMouseEnter={e => e.currentTarget.style.borderColor="#58a6ff"}
                    onMouseLeave={e => e.currentTarget.style.borderColor="#30363d"}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      {isTie ? (
                        <div style={{width:22,height:22,flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1}}>
                          <img src={`https://a.espncdn.com/i/teamlogos/${play.sport}/500/${(play.awayTeam||"").toLowerCase()}.png`} alt={play.awayTeam}
                            style={{width:11,height:11,objectFit:"contain"}}
                            onError={e=>{e.target.style.visibility="hidden";}} />
                          <img src={`https://a.espncdn.com/i/teamlogos/${play.sport}/500/${(play.homeTeam||"").toLowerCase()}.png`} alt={play.homeTeam}
                            style={{width:11,height:11,objectFit:"contain"}}
                            onError={e=>{e.target.style.visibility="hidden";}} />
                        </div>
                      ) : (
                        <img src={`https://a.espncdn.com/i/teamlogos/${play.sport}/500/${(play.pickTeam||"").toLowerCase()}.png`} alt={play.pickTeam}
                          style={{width:22,height:22,objectFit:"contain",flexShrink:0}}
                          onError={e=>{e.target.style.visibility="hidden";}} />
                      )}
                      <span onClick={e=>{e.stopPropagation(); if (!isTie) navigateToTeam(play.pickTeam,play.sport);}}
                        style={{flex:1,minWidth:0,fontSize:14,fontWeight:700,cursor:isTie?"default":"pointer",lineHeight:1.3,color:"#c9d1d9",display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        {isTie
                          ? <span>Tie {mlLabel} <span style={{color:"#484f58",fontWeight:400}}>({play.awayTeam} @ {play.homeTeam})</span></span>
                          : <span>{play.pickTeam} {mlLabel} <span style={{color:"#484f58",fontWeight:400}}>({play.side === "home" ? "vs" : "@"} {play.oppTeam})</span></span>}
                      </span>
                      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                        <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                          +{play.edge}%
                        </span>
                        <button onClick={e => { e.stopPropagation(); if (isTracked) { untrackPlay(trackId); return; } trackPlay(play, e); }}
                          title={isTracked ? "Remove from My Picks" : "Add to My Picks"}
                          style={{background: isTracked ? "rgba(227,179,65,0.15)" : "transparent",
                            border: `1px solid ${isTracked ? "#e3b341" : "#30363d"}`,
                            borderRadius:6, padding:"2px 7px", cursor:"pointer",
                            color: isTracked ? "#e3b341" : "#484f58", fontSize:14, lineHeight:1}}>
                          {isTracked ? "★" : "☆"}
                        </button>
                      </div>
                    </div>
                    {/* Model win% bar */}
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:14,overflow:"hidden"}}>
                        <div style={{width:`${play.truePct}%`,background:tColor,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:play.truePct>0?3:0}}/>
                      </div>
                      <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                        <span style={{color:tColor,fontSize:12,fontWeight:700}}>{play.truePct}%</span>
                        <span style={{color:tColor,fontSize:10}}>({tTrueOddsStr})</span>
                      </div>
                    </div>
                    {/* Kalshi price bar */}
                    {play.kalshiPct != null && (() => {
                      const kPct = play.kalshiPct;
                      const kOdds = kPct >= 50 ? Math.round(-(kPct/(100-kPct))*100) : Math.round((100-kPct)/kPct*100);
                      const kOddsStr = kOdds > 0 ? `+${kOdds}` : `${kOdds}`;
                      return (
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                          <div style={{flex:1,background:"#21262d",borderRadius:4,height:10,overflow:"hidden"}}>
                            <div style={{width:`${kPct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:kPct>0?3:0}}/>
                          </div>
                          <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                            <span style={{color:"#6e40c9",fontSize:12,fontWeight:600}}>{kPct}%</span>
                            <span style={{color:"#6e40c9",fontSize:10}}>({kOddsStr})</span>
                          </div>
                        </div>
                      );
                    })()}
                    <InputList inputs={buildLambdaInputs(play)} />
                  </div>
                );
              }
              // ── End ML play card ────────────────────────────────────────────────────────────────

              // ── Spread play card ────────────────────────────────────────────────────────────────
              if (play.gameType === "spread") {
                const tColor = tierColor(play.truePct);
                const tTrueOdds = play.truePct >= 100 ? -99999 : (play.truePct >= 50 ? Math.round(-(play.truePct/(100-play.truePct))*100) : Math.round((100-play.truePct)/play.truePct*100));
                const tTrueOddsStr = tTrueOdds > 0 ? `+${tTrueOdds}` : `${tTrueOdds}`;
                const pickLineStr = play.pickLine > 0 ? `+${play.pickLine}` : `${play.pickLine}`;
                return (
                  <div key={playKey}
                    style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,
                      padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                    onMouseEnter={e => e.currentTarget.style.borderColor="#58a6ff"}
                    onMouseLeave={e => e.currentTarget.style.borderColor="#30363d"}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      <img src={`https://a.espncdn.com/i/teamlogos/${play.sport}/500/${(play.pickTeam||"").toLowerCase()}.png`} alt={play.pickTeam}
                        style={{width:22,height:22,objectFit:"contain",flexShrink:0}}
                        onError={e=>{e.target.style.visibility="hidden";}} />
                      <span onClick={e=>{e.stopPropagation();navigateToTeam(play.pickTeam,play.sport);}}
                        style={{flex:1,minWidth:0,fontSize:14,fontWeight:700,cursor:"pointer",lineHeight:1.3,color:"#c9d1d9",display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <span>{play.pickTeam} {pickLineStr} <span style={{color:"#484f58",fontWeight:400}}>({play.side === "home" ? "vs" : "@"} {play.oppTeam})</span></span>
                      </span>
                      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                        <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                          +{play.edge}%
                        </span>
                        <button onClick={e => { e.stopPropagation(); if (isTracked) { untrackPlay(trackId); return; } trackPlay(play, e); }}
                          title={isTracked ? "Remove from My Picks" : "Add to My Picks"}
                          style={{background: isTracked ? "rgba(227,179,65,0.15)" : "transparent",
                            border: `1px solid ${isTracked ? "#e3b341" : "#30363d"}`,
                            borderRadius:6, padding:"2px 7px", cursor:"pointer",
                            color: isTracked ? "#e3b341" : "#484f58", fontSize:14, lineHeight:1}}>
                          {isTracked ? "★" : "☆"}
                        </button>
                      </div>
                    </div>
                    {/* Model cover% bar */}
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:14,overflow:"hidden"}}>
                        <div style={{width:`${play.truePct}%`,background:tColor,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:play.truePct>0?3:0}}/>
                      </div>
                      <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                        <span style={{color:tColor,fontSize:12,fontWeight:700}}>{play.truePct}%</span>
                        <span style={{color:tColor,fontSize:10}}>({tTrueOddsStr})</span>
                      </div>
                    </div>
                    {/* Kalshi price bar */}
                    {play.kalshiPct != null && (() => {
                      const kPct = play.kalshiPct;
                      const kOdds = kPct >= 50 ? Math.round(-(kPct/(100-kPct))*100) : Math.round((100-kPct)/kPct*100);
                      const kOddsStr = kOdds > 0 ? `+${kOdds}` : `${kOdds}`;
                      return (
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                          <div style={{flex:1,background:"#21262d",borderRadius:4,height:10,overflow:"hidden"}}>
                            <div style={{width:`${kPct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:kPct>0?3:0}}/>
                          </div>
                          <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                            <span style={{color:"#6e40c9",fontSize:12,fontWeight:600}}>{kPct}%</span>
                            <span style={{color:"#6e40c9",fontSize:10}}>({kOddsStr})</span>
                          </div>
                        </div>
                      );
                    })()}
                    <InputList inputs={buildLambdaInputs(play)} />
                  </div>
                );
              }
              // ── End spread play card ────────────────────────────────────────────────────────────

              // ── Game total play card ────────────────────────────────────────────────────────────
              if (play.gameType === "total") {
                const isUnder = play.direction === "under";
                const displayTruePct = isUnder ? play.noTruePct : play.truePct;
                const displayKalshiPct = isUnder ? play.noKalshiPct : play.kalshiPct;
                const tColor = tierColor(displayTruePct);
                const tLabel = { totalRuns:"Runs", totalPoints:"Pts", totalGoals:"Goals", f5total:"Runs (F5)", h1total:"Pts (1H)", h2total:"Pts (2H)" }[play.stat] || play.stat;
                const lineVal = (play.threshold - 0.5).toFixed(1);
                const tTrueOdds = displayTruePct >= 100 ? -99999 : (displayTruePct >= 50 ? Math.round(-(displayTruePct/(100-displayTruePct))*100) : Math.round((100-displayTruePct)/displayTruePct*100));
                const tTrueOddsStr = tTrueOdds > 0 ? `+${tTrueOdds}` : `${tTrueOdds}`;
                return (
                  <div key={playKey}
                    style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,
                      padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                    onMouseEnter={e => e.currentTarget.style.borderColor="#58a6ff"}
                    onMouseLeave={e => e.currentTarget.style.borderColor="#30363d"}>
                    {/* Header — bet headline + edge + star. Matchup logos + time live on the MatchupCard above. */}
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      <div style={{width:22,height:22,flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1}}>
                        <img src={`https://a.espncdn.com/i/teamlogos/${play.sport}/500/${(play.awayTeam||"").toLowerCase()}.png`} alt={play.awayTeam}
                          style={{width:11,height:11,objectFit:"contain"}}
                          onError={e=>{e.target.style.visibility="hidden";}} />
                        <img src={`https://a.espncdn.com/i/teamlogos/${play.sport}/500/${(play.homeTeam||"").toLowerCase()}.png`} alt={play.homeTeam}
                          style={{width:11,height:11,objectFit:"contain"}}
                          onError={e=>{e.target.style.visibility="hidden";}} />
                      </div>
                      <span style={{flex:1,minWidth:0,fontSize:14,fontWeight:700,lineHeight:1.3,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",color:"#c9d1d9"}}>
                        <span>{play.awayTeam} @ {play.homeTeam} {isUnder ? "Under" : "Over"} {lineVal} {tLabel}</span>
                        {play.lowVolume && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(231,179,49,0.12)",border:"1px solid #e3b341",color:"#e3b341"}}>Low Vol</span>}
                        {play.thinMarket && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(247,129,102,0.10)",border:"1px solid #f78166",color:"#f78166"}}>Wide Spread</span>}
                        {play.lineMove != null && Math.abs(play.lineMove) >= 3 && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:play.lineMove > 0 ? "rgba(63,185,80,0.10)" : "rgba(247,129,102,0.10)",border:`1px solid ${play.lineMove > 0 ? "#3fb950" : "#f78166"}`,color:play.lineMove > 0 ? "#3fb950" : "#f78166"}}>{play.lineMove > 0 ? "▲" : "▼"} {Math.abs(play.lineMove)}c</span>}
                      </span>
                      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                        <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                          +{play.edge}%
                        </span>
                        <button onClick={e => { e.stopPropagation(); isTracked ? untrackPlay(trackId) : trackPlay(play, e); }}
                          title={isTracked ? "Remove from My Picks" : "Add to My Picks"}
                          style={{background: isTracked ? "rgba(227,179,65,0.15)" : "transparent",
                            border: `1px solid ${isTracked ? "#e3b341" : "#30363d"}`,
                            borderRadius:6, padding:"2px 7px", cursor:"pointer",
                            color: isTracked ? "#e3b341" : "#484f58", fontSize:14, lineHeight:1}}>
                          {isTracked ? "★" : "☆"}
                        </button>
                      </div>
                    </div>
                    {/* True% bar */}
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:14,overflow:"hidden"}}>
                        <div style={{width:`${displayTruePct}%`,background:tColor,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:displayTruePct>0?3:0}}/>
                      </div>
                      <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                        <span style={{color:tColor,fontSize:12,fontWeight:700}}>{displayTruePct}%</span>
                        <span style={{color:tColor,fontSize:10}}>({tTrueOddsStr})</span>
                      </div>
                    </div>
                    {/* Kalshi price bar */}
                    {displayKalshiPct != null && (() => {
                      const kPct = displayKalshiPct;
                      const kOdds = kPct >= 50 ? Math.round(-(kPct/(100-kPct))*100) : Math.round((100-kPct)/kPct*100);
                      const kOddsStr = kOdds > 0 ? `+${kOdds}` : `${kOdds}`;
                      return (
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                          <div style={{flex:1,background:"#21262d",borderRadius:4,height:10,overflow:"hidden"}}>
                            <div style={{width:`${kPct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:kPct>0?3:0}}/>
                          </div>
                          <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                            <span style={{color:"#6e40c9",fontSize:12,fontWeight:600}}>{kPct}%</span>
                            <span style={{color:"#6e40c9",fontSize:10}}>({kOddsStr})</span>
                          </div>
                        </div>
                      );
                    })()}
                    <InputList inputs={buildLambdaInputs(play)} />
                  </div>
                );
              }
              // ── End total play card ─────────────────────────────────────────────────────────────
              return (
                <div key={playKey}
                  style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,
                    padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                  onMouseEnter={e => e.currentTarget.style.borderColor = "#58a6ff"}
                  onMouseLeave={e => e.currentTarget.style.borderColor = "#30363d"}>
                  {/* Header row — click navigates to player card */}
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,cursor:"pointer"}}
                    onClick={() => navigateToPlay(play)}>
                    {headshotUrl ? (
                      <img src={headshotUrl} alt={play.playerName}
                        style={{width:22,height:22,borderRadius:"50%",objectFit:"cover",objectPosition:"top center",background:"#0d1117",flexShrink:0}}
                        onError={e=>{e.target.style.visibility="hidden";}} />
                    ) : (
                      <div style={{width:22,height:22,borderRadius:"50%",background:"#21262d",flexShrink:0}} />
                    )}
                    <div style={{flex:1,minWidth:0}}>
                      {/* Player name + threshold + stat inline as the bet headline.
                          Matchup + time live on the MatchupCard above. */}
                      <div style={{display:"flex",alignItems:"baseline",gap:6,flexWrap:"wrap"}}>
                        <span style={{color:"#fff",fontSize:14,fontWeight:700}}>{play.playerName}</span>
                        <span style={{color:"#c9d1d9",fontSize:13,fontWeight:700,whiteSpace:"nowrap"}}>
                          {play.threshold}+ {STAT_LABEL[play.stat] || play.stat}
                        </span>
                      </div>
                      <div style={{color:"#8b949e",fontSize:11,marginTop:2,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                        {play.position && <span>{play.position}</span>}
                        {play.playerStatus === "out" && (
                          <span title="Listed as Out" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(248,113,113,0.15)",border:"1px solid #f87171",color:"#f87171"}}>Out</span>
                        )}
                        {play.playerStatus === "doubtful" && (
                          <span title="Listed as Doubtful" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(251,146,60,0.15)",border:"1px solid #fb923c",color:"#fb923c"}}>Doubtful</span>
                        )}
                        {play.playerStatus === "questionable" && (
                          <span title="Listed as Questionable" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(234,179,8,0.15)",border:"1px solid #eab308",color:"#eab308"}}>Questionable</span>
                        )}
                        {play.isB2B && (
                          <span title="Back-to-back: played yesterday" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(248,113,113,0.15)",border:"1px solid #f87171",color:"#f87171"}}>B2B</span>
                        )}
                      </div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                      <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                        borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                        +{play.edge}%
                      </span>
                      <button onClick={e => { e.stopPropagation(); if (isTracked) { untrackPlay(trackId); return; } trackPlay(play, e); }}
                        title={isTracked ? "Remove from My Picks" : "Add to My Picks"}
                        style={{background: isTracked ? "rgba(227,179,65,0.15)" : "transparent",
                          border: `1px solid ${isTracked ? "#e3b341" : "#30363d"}`,
                          borderRadius:6, padding:"2px 7px", cursor:"pointer",
                          color: isTracked ? "#e3b341" : "#484f58", fontSize:14, lineHeight:1}}>
                        {isTracked ? "★" : "☆"}
                      </button>
                    </div>
                  </div>
                  {/* True probability bar */}
                  {(() => { const tc = tierColor(play.truePct); const tp = play.truePct; const trueOdds = tp != null ? (tp >= 100 ? -99999 : (tp >= 50 ? Math.round(-(tp/(100-tp))*100) : Math.round((100-tp)/tp*100))) : null; const trueOddsStr = trueOdds != null ? (trueOdds > 0 ? `+${trueOdds}` : `${trueOdds}`) : null; return (
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                    <div style={{flex:1,background:"#21262d",borderRadius:4,height:14,overflow:"hidden"}}>
                      <div style={{width:`${tp}%`,background:tc,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:tp>0?3:0}}/>
                    </div>
                    <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                      <span style={{color:tc,fontSize:12,fontWeight:700}}>{tp}%</span>
                      {trueOddsStr && <span style={{color:tc,fontSize:10}}>({trueOddsStr})</span>}
                    </div>
                  </div>
                  ); })()}
                  {/* Odds bar */}
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                    <div style={{flex:1,background:"#21262d",borderRadius:4,height:10,overflow:"hidden"}}>
                      <div style={{width:`${play.kalshiPct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:play.kalshiPct>0?3:0}}/>
                    </div>
                    <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                      <span style={{color:"#6e40c9",fontSize:12,fontWeight:600}}>{play.kalshiPct}%</span>
                      <span style={{color:"#6e40c9",fontSize:10}}>({oddsStr})</span>
                    </div>
                  </div>
                  {/* Breakdown — NFL only (not NBA, not MLB, not NHL which has its own card) */}
                  {play.sport !== "mlb" && play.sport !== "nba" && play.sport !== "wnba" && play.sport !== "nhl" && <div style={{borderTop:"1px solid #21262d",paddingTop:8}}>
                    <button onClick={e => { e.stopPropagation(); setExpandedPlays(s => { const n = new Set(s); n.has(playKey) ? n.delete(playKey) : n.add(playKey); return n; }); }}
                      style={{background:"none",border:"none",color:"#484f58",fontSize:11,cursor:"pointer",padding:0,display:"flex",alignItems:"center",gap:4}}>
                      {isExpanded ? "▲ hide breakdown" : "▼ show breakdown"}
                    </button>
                    {isExpanded && (
                      <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:8}}>
                        <div style={{display:"flex",flexDirection:"column",gap:6}}>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <div style={{width:110,color:"#8b949e",fontSize:10,flexShrink:0,lineHeight:1.35}}>
                                {`Season rate${play.seasonGames ? ` (${play.seasonGames}g)` : ""}`}
                              </div>
                              <div style={{flex:1,background:"#21262d",borderRadius:3,height:8,overflow:"hidden"}}>
                                <div style={{width:`${play.seasonPct}%`,background:tierColor(play.seasonPct),height:"100%",borderRadius:3}}/>
                              </div>
                              <div style={{color:tierColor(play.seasonPct),fontSize:11,fontWeight:600,width:38,textAlign:"right",flexShrink:0}}>{play.seasonPct}%</div>
                            </div>
                            {play.softPct !== null && (
                              <div style={{display:"flex",alignItems:"center",gap:8}}>
                                <div style={{width:110,color:"#8b949e",fontSize:10,flexShrink:0,lineHeight:1.35}}>
                                  {play.oppRank === null ? (play.oppMetricLabel || "").replace(/\s*\(\d+g\)\s*$/, "") : "vs weak matchup"}
                                  {play.softGames ? ` (${play.softGames}g)` : ""}
                                </div>
                                <div style={{flex:1,background:"#21262d",borderRadius:3,height:8,overflow:"hidden"}}>
                                  <div style={{width:`${play.softPct}%`,background:tierColor(play.softPct),height:"100%",borderRadius:3}}/>
                                </div>
                                <div style={{color:tierColor(play.softPct),fontSize:11,fontWeight:600,width:38,textAlign:"right",flexShrink:0}}>{play.softPct}%</div>
                              </div>
                            )}
                        </div>
                      </div>
                    )}
                  </div>}
                  <InputList inputs={buildLambdaInputs(play)} />
                </div>
              );
            })}
            </div>
          ));
            return cols > 1 ? (
              <div style={{display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:12, alignItems:'start'}}>
                {_dateGroups}
              </div>
            ) : _dateGroups;
        })()}
        </div>
  );
}

export default PlaysColumn;
