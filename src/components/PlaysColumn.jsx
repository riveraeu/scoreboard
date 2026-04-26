import React from 'react';
import { STAT_LABEL } from '../lib/constants.js';
import { ordinal } from '../lib/utils.js';
import { tierColor } from '../lib/colors.js';

function PlaysColumn({ tonightPlays, allTonightPlays, tonightLoading, tonightMeta, sportFilter, setSportFilter, statFilter, setStatFilter, trackedPlays, trackPlay, untrackPlay, navigateToPlay, navigateToTeam, navigateToModel, calcOdds, expandedPlays, setExpandedPlays, fetchReport, bustLoading, bustCache, showPlaysInfo, setShowPlaysInfo, testMode, setTestMode }) {
  return (
        <div>
          <div style={{display:"flex",alignItems:"center",marginBottom:14}}>
            <div style={{color:"#c9d1d9",fontSize:15,fontWeight:700}}>
              {(() => {
                const _nowD = new Date(); const _dow = _nowD.getDay(); const _daysToMon = (_dow + 6) % 7;
                const _monday = new Date(_nowD - _daysToMon * 86400000);
                const _weekLabel = _monday.toLocaleDateString("en-US", { month:"short", day:"numeric" });
                const dates = [...new Set((tonightPlays || []).map(p => p.gameDate).filter(Boolean))].sort();
                return dates.length === 0
                  ? "Plays"
                  : <><span style={{color:"#484f58",fontWeight:400,fontSize:13}}>Plays — </span>{"Week of " + _weekLabel}</>;
              })()}
              <span style={{position:"relative",marginLeft:6}}>
                <span onClick={() => setShowPlaysInfo(o => !o)}
                  style={{cursor:"pointer",color:showPlaysInfo?"#58a6ff":"#484f58",fontSize:13,lineHeight:1,userSelect:"none"}}>ⓘ</span>
                {showPlaysInfo && (
                  <div style={{position:"absolute",top:20,left:0,zIndex:99,width:300,background:"#161b22",border:"1px solid #30363d",borderRadius:8,padding:"10px 12px",fontSize:11,color:"#c9d1d9",lineHeight:1.6,boxShadow:"0 4px 16px rgba(0,0,0,0.5)"}}>
                    <div style={{fontWeight:700,marginBottom:6,color:"#fff"}}>Play qualification criteria</div>
                    <div style={{marginBottom:3}}><span style={{color:"#58a6ff"}}>Implied prob</span> ≥ 70% (Kalshi market price)</div>
                    <div style={{marginBottom:3}}><span style={{color:"#3fb950"}}>Edge</span> ≥ 5% (True% minus implied)</div>
                    <div style={{marginBottom:3}}><span style={{color:"#e3b341"}}>SimScore</span> ≥ 8 / 10 (model confidence gate)</div>
                  </div>
                )}
              </span>
              <span style={{color:"#484f58",fontSize:11,marginLeft:8,userSelect:"none"}}>Reports:</span>
              {["mlb","nba","nhl"].map(s => (
                <span key={s} onClick={() => fetchReport(s)}
                  style={{cursor:"pointer",color:"#484f58",fontSize:11,marginLeft:5,
                    textDecoration:"underline",textDecorationStyle:"dotted",userSelect:"none"}}>
                  {s.toUpperCase()}
                </span>
              ))}
            </div>
            <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
              <div style={{width:1,height:14,background:"#30363d",margin:"0 2px"}} />
              <button onClick={navigateToModel}
                style={{fontSize:10,padding:"2px 8px",borderRadius:6,cursor:"pointer",
                  border:"1px solid #30363d",background:"transparent",
                  color:"#484f58", fontWeight:600}}>
                model
              </button>
              <button onClick={() => setTestMode(m => !m)}
                style={{fontSize:10,padding:"2px 8px",borderRadius:6,cursor:"pointer",
                  border:`1px solid ${testMode?"#e3b341":"#30363d"}`,
                  background: testMode?"rgba(227,179,65,0.12)":"transparent",
                  color: testMode?"#e3b341":"#484f58", fontWeight:600}}>
                {testMode ? "⚗ mock" : "mock"}
              </button>
              <button onClick={bustCache} disabled={bustLoading}
                style={{fontSize:10,padding:"2px 8px",borderRadius:6,cursor:bustLoading?"default":"pointer",
                  border:"1px solid #30363d",background:"transparent",
                  color: bustLoading?"#30363d":"#484f58", fontWeight:600}}>
                {bustLoading ? "busting…" : "bust"}
              </button>
              <a href="#my-picks" className="picks-fab"
                onClick={e => { e.preventDefault(); const el = document.getElementById("my-picks"); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 16, behavior:"smooth" }); }}
                style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:6,
                  border:"1px solid #30363d",color:"#8b949e",textDecoration:"none",lineHeight:"20px",cursor:"pointer"}}>
                My Picks ↓
              </a>
            </div>
          </div>
          {/* ROI Summary panel */}
          {!tonightLoading && (tonightPlays || []).length > 0 && (() => {
            const isStrongMatchup = play => {
              if (play.sport === "mlb" && play.stat === "strikeouts") return false;
              if (play.sport === "mlb") return play.softPct != null;
              if (play.sport === "nba") return play.oppRank != null && play.oppRank <= 5 && (play.projectedStat == null || play.projectedStat >= play.threshold * 0.95);
              if (play.sport === "nhl") return play.oppRank != null && play.oppRank <= 5;
              return play.oppRank != null && play.oppRank <= 5;
            };
            const visiblePlays = (tonightPlays || []).filter(p => {
              if (sportFilter.length > 0 && !sportFilter.includes(p.sport)) return false;
              if (statFilter.length > 0 && !statFilter.includes(p.stat)) return false;
              return true;
            });
            if (visiblePlays.length === 0) return null;
            return null; // ROI panel removed
          })()}
          {tonightLoading ? (
            <div style={{color:"#8b949e",textAlign:"center",padding:52,fontSize:13}}>
              Loading plays…
            </div>
          ) : (() => {
            const isStrongMatchup = play => {
              if (play.sport === "mlb" && play.stat === "strikeouts") return false;
              if (play.sport === "mlb") return play.softPct != null;
              if (play.sport === "nba") return play.oppRank != null && play.oppRank <= 5 && (play.projectedStat == null || play.projectedStat >= play.threshold * 0.95);
              // NHL: projectedStat is per-game rate (e.g. 0.6 goals/game), not comparable to threshold (1)
              if (play.sport === "nhl") return play.oppRank != null && play.oppRank <= 5;
              return play.oppRank != null && play.oppRank <= 5;
            };
            const impliedProb = odds => {
              if (odds == null) return null;
              if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100) * 100;
              if (odds > 0) return 100 / (odds + 100) * 100;
              return null;
            };
            const trackedGameKeys = new Set(
              trackedPlays
                .filter(p => p.id?.startsWith("total|"))
                .map(p => { const pts = p.id.split("|"); return pts.length >= 6 ? `${pts[1]}|${pts[2]}|${pts[3]}|${pts[5]}` : null; })
                .filter(Boolean)
            );
            const untrackedPlays = (tonightPlays || []).filter(play => {
              const trackId = play.gameType === "teamTotal"
                ? `teamtotal|${play.sport}|${play.scoringTeam}|${play.oppTeam}|${play.threshold}|${play.gameDate || ""}`
                : play.gameType === "total"
                ? `total|${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
                : `${play.sport || "nba"}|${play.playerName}|${play.stat}|${play.threshold}|${play.gameDate || ""}`;
              if (trackedPlays.some(p => p.id === trackId)) return false;
              if (play.gameType === "total" && trackedGameKeys.has(`${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.gameDate || ""}`)) return false;
              if (sportFilter.length > 0 && !sportFilter.includes(play.sport)) return false;
              if (statFilter.length > 0 && !statFilter.includes(play.stat)) return false;
              return true;
            });
            if (untrackedPlays.length === 0) return (
              <div style={{color:"#484f58",textAlign:"center",padding:52,fontSize:13,lineHeight:1.6}}>
                {tonightPlays?.length > 0
                  ? "All plays added to My Picks."
                  : (() => {
                      const qc = tonightMeta?.qualifyingCount ?? 0;
                      const pf = tonightMeta?.preFilteredCount ?? 0;
                      const filtered = qc - pf;
                      if (qc === 0) return "No Kalshi markets found — check back later when tomorrow's markets open.";
                      if (filtered > 0 && pf === 0) return <>
                        <div>{qc} markets found — all filtered: tonight's opponents don't meet the soft matchup threshold.</div>
                        <div style={{fontSize:11,marginTop:6,color:"#30363d"}}>NBA: vs bottom-10 defense · MLB hitters: team favored + 10 AB vs pitcher + BA ≥.270 · MLB pitchers: lineup K-rate ≥22%</div>
                      </>;
                      if (filtered > 0) return <>
                        <div>{qc} markets found · {filtered} filtered by matchup · {pf - (tonightPlays?.length ?? 0)} filtered by edge.</div>
                        <div style={{fontSize:11,marginTop:6,color:"#30363d"}}>NBA: vs bottom-10 defense · MLB hitters: team favored + 10 AB vs pitcher + BA ≥.270 · MLB pitchers: lineup K-rate ≥22%</div>
                      </>;
                      return "No qualifying plays found.";
                    })()
                }
              </div>
            );
            // Group plays by gameDate, sort dates ascending
            const localDate = n => { const d = new Date(Date.now() + n*86400000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
            const today = localDate(0);
            const tomorrow = localDate(1);
            const grouped = {};
            untrackedPlays.forEach(play => {
              const d = play.gameDate || today;
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

            return sortedDates.map(date => (
              <div key={date}>
                {/* Date header */}
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,marginTop: date === sortedDates[0] ? 0 : 20}}>
                  <div style={{color: date === today ? "#e3b341" : "#c9d1d9", fontSize:13, fontWeight:700}}>
                    {dateLabel(date)}
                  </div>
                  <div style={{flex:1,height:1,background:"#21262d"}}/>
                  <div style={{color:"#484f58",fontSize:11}}>{grouped[date].length} play{grouped[date].length !== 1 ? "s" : ""}</div>
                </div>

                {[...grouped[date]].sort((a, b) => {
                  const ta = a.gameTime || "9999";
                  const tb = b.gameTime || "9999";
                  return ta < tb ? -1 : ta > tb ? 1 : b.edge - a.edge;
                }).map((play) => {
              const playKey = play.gameType === "teamTotal"
                ? `teamtotal-${play.sport}-${play.scoringTeam}-${play.oppTeam}-${play.threshold}`
                : play.gameType === "total"
                ? `total-${play.sport}-${play.homeTeam}-${play.awayTeam}-${play.threshold}${play.direction === "under" ? "-under" : ""}`
                : `${play.playerName}-${play.stat}-${play.threshold}`;
              const oddsStr = play.americanOdds >= 0 ? `+${play.americanOdds}` : `${play.americanOdds}`;
              const isExpanded = expandedPlays.has(playKey);
              const trackId = play.gameType === "teamTotal"
                ? `teamtotal|${play.sport}|${play.scoringTeam}|${play.oppTeam}|${play.threshold}|${play.gameDate || ""}`
                : play.gameType === "total"
                ? `total|${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
                : `${play.sport || "nba"}|${play.playerName}|${play.stat}|${play.threshold}|${play.gameDate || ""}`;
              const isTracked = trackedPlays.some(p => p.id === trackId);
              const headshotUrl = play.playerId ? `https://a.espncdn.com/i/headshots/${play.sport || "nba"}/players/full/${play.playerId}.png` : null;

              // ── Team total play card ────────────────────────────────────────────────────────────
              if (play.gameType === "teamTotal") {
                const tLabel = { teamRuns:"Runs", teamPoints:"Pts" }[play.stat] || play.stat;
                const lineVal = (play.threshold - 0.5).toFixed(1);
                const tColor = tierColor(play.truePct);
                const tTrueOdds = play.truePct >= 100 ? -99999 : (play.truePct >= 50 ? Math.round(-(play.truePct/(100-play.truePct))*100) : Math.round((100-play.truePct)/play.truePct*100));
                const tTrueOddsStr = tTrueOdds > 0 ? `+${tTrueOdds}` : `${tTrueOdds}`;
                const logoUrl = abbr => `https://a.espncdn.com/i/teamlogos/${play.sport}/500/${abbr.toLowerCase()}.png`;
                const sc = play.teamTotalSimScore;
                const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                return (
                  <div key={playKey}
                    style={{background:"#161b22",border:`1px solid ${isTracked?"#3fb950":"#30363d"}`,borderRadius:12,
                      padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                    onMouseEnter={e => { if (!isTracked) e.currentTarget.style.borderColor="#58a6ff"; }}
                    onMouseLeave={e => { if (!isTracked) e.currentTarget.style.borderColor="#30363d"; }}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                          <img src={logoUrl(play.scoringTeam)} alt={play.scoringTeam}
                            onClick={e=>{e.stopPropagation();navigateToTeam(play.scoringTeam,play.sport);}}
                            style={{width:44,height:44,objectFit:"contain",background:"#21262d",borderRadius:6,padding:2,flexShrink:0,cursor:"pointer"}}
                            onError={e=>e.target.style.display="none"}/>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.scoringTeam,play.sport);}}
                            style={{color:"#c9d1d9",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.scoringTeam}</span>
                          <span style={{color:"#484f58",fontSize:11}}>vs</span>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.oppTeam,play.sport);}}
                            style={{color:"#8b949e",fontSize:12,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.oppTeam}</span>
                        </div>
                        <div style={{color:"#8b949e",fontSize:11,marginTop:3,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                          {play.gameTime && (() => { const _d = new Date(play.gameTime); const ptFmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"}); const tPT = ptFmt.format(new Date()), rPT = ptFmt.format(new Date(Date.now()+86400000)); const gd = play.gameDate || ptFmt.format(_d); const dl = gd===tPT?"Today":gd===rPT?"Tomorrow":new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric"}).format(_d); const tp = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"2-digit",hour12:true}).format(_d); return <span>{dl} · {tp} PT</span>; })()}
                        </div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                        <span style={{background:"rgba(88,166,255,0.12)",border:"1px solid #58a6ff",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#58a6ff",fontWeight:700,whiteSpace:"nowrap"}}>
                          Over {lineVal} {tLabel}
                        </span>
                        <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                          +{play.edge}%
                        </span>
                        <button onClick={e => { e.stopPropagation(); if (isTracked) { untrackPlay(trackId); return; } const calcV = calcOdds.trim(); const overrideOdds = (calcV && calcV !== "-" && calcV !== "+" && !isNaN(parseInt(calcV))) ? parseInt(calcV) : null; trackPlay(overrideOdds ? { ...play, americanOdds: overrideOdds } : play); }}
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
                    {/* Explanation prose */}
                    <div style={{marginTop:4}}>
                      {play.sport === "mlb" && (() => {
                        const eraColor = v => v == null ? "#8b949e" : v > 4.5 ? "#3fb950" : v > 3.5 ? "#e3b341" : "#f78166";
                        const rpgColor = v => v == null ? "#8b949e" : v > 5.0 ? "#3fb950" : v > 4.0 ? "#e3b341" : "#8b949e";
                        const ouColor = play.gameOuLine == null ? "#8b949e" : play.gameOuLine >= 9.5 ? "#3fb950" : play.gameOuLine >= 7.5 ? "#e3b341" : "#f78166";
                        const rpgDesc = play.teamRPG == null ? null : play.teamRPG > 5.0 ? "above-average offense" : play.teamRPG > 4.0 ? "solid offense" : "below-average offense";
                        const eraDesc = play.oppERA == null ? null : play.oppERA > 4.5 ? "a hittable arm" : play.oppERA > 3.5 ? "an average starter" : "a tough matchup";
                        const ouDesc = play.gameOuLine == null ? null : play.gameOuLine >= 9.5 ? "a high-scoring game" : play.gameOuLine >= 7.5 ? "an average total" : "a pitcher's duel";
                        const etColor = play.teamExpected == null ? "#8b949e" : play.teamExpected >= play.threshold + 1.5 ? "#3fb950" : play.teamExpected >= play.threshold - 0.5 ? "#e3b341" : "#8b949e";
                        const _rpgPts = play.teamRPG == null ? 1 : play.teamRPG > 5.0 ? 2 : play.teamRPG > 4.0 ? 1 : 0;
                        const _eraPts = play.oppERA == null ? 1 : play.oppERA > 4.5 ? 2 : play.oppERA > 3.5 ? 1 : 0;
                        const _parkPts = play.parkFactor == null ? 1 : play.parkFactor > 1.05 ? 2 : play.parkFactor > 1.00 ? 1 : 0;
                        const _h2hPts = play.h2hHitRatePts ?? 1;
                        const _ouPts = play.gameOuLine == null ? 1 : play.gameOuLine >= 9.5 ? 2 : play.gameOuLine >= 7.5 ? 1 : 0;
                        const scTitle = [`RPG (${play.teamRPG?.toFixed(1) ?? "—"}): ${_rpgPts}/2`,`Opp ERA (${play.oppERA?.toFixed(2) ?? "—"}): ${_eraPts}/2`,`H2H HR% (${play.h2hHitRate?.toFixed(0) ?? "—"}%): ${_h2hPts}/2`,`Park (${play.parkFactor != null ? (play.parkFactor > 1 ? "+" : "") + ((play.parkFactor-1)*100).toFixed(0) + "%" : "—"}): ${_parkPts}/2`,`O/U (${play.gameOuLine ?? "—"}): ${_ouPts}/2`].join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> averages{play.teamRPG != null ? <> <span style={{color:rpgColor(play.teamRPG),fontWeight:600}}>{play.teamRPG.toFixed(1)}</span> runs/game</> : " — RPG"}{rpgDesc ? <> — <span style={{color:"#484f58"}}>{rpgDesc}</span></> : null}.{" "}
                            Facing a <span style={{color:"#c9d1d9"}}>{play.oppTeam}</span> starter with{play.oppERA != null ? <> <span style={{color:eraColor(play.oppERA),fontWeight:600}}>{play.oppERA.toFixed(2)} ERA</span></> : " — ERA"}{eraDesc ? <> — <span style={{color:"#484f58"}}>{eraDesc}</span></> : null}.
                            {play.h2hHitRate != null ? <>{" "}<span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> <span style={{color:"#484f58"}}>has scored {lineVal}+ runs in</span> <span style={{color: play.h2hHitRate >= 80 ? "#3fb950" : play.h2hHitRate >= 60 ? "#e3b341" : "#f78166",fontWeight:600}}>{play.h2hHitRate.toFixed(0)}%</span> <span style={{color:"#484f58"}}>of their last {play.h2hGames}g H2H meetings.</span></> : null}
                            {Math.abs((play.parkFactor ?? 1) - 1) > 0.01 ? <>{" "}<span style={{color:"#484f58"}}>Park factor</span> <span style={{color:"#8b949e"}}>{play.parkFactor > 1 ? "+" : ""}{((play.parkFactor - 1)*100).toFixed(0)}%</span>.</> : null}
                            {play.gameOuLine != null && <>{" "}<span style={{color:"#484f58"}}>Game total</span> <span style={{color:ouColor,fontWeight:600}}>{play.gameOuLine}</span>{ouDesc ? <> — <span style={{color:"#484f58"}}>{ouDesc}</span></> : null}.</>}
                            {play.teamExpected != null && <>{" "}<span style={{color:"#484f58"}}>Model projects</span> <span style={{color:etColor,fontWeight:600}}>{play.teamExpected}</span> <span style={{color:"#484f58"}}>expected runs vs the {lineVal} line.</span></>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"help"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                      {play.sport === "nba" && (() => {
                        const offColor = v => v == null ? "#8b949e" : v >= 118 ? "#f78166" : v >= 113 ? "#e3b341" : "#8b949e";
                        const defColor = v => v == null ? "#8b949e" : v >= 118 ? "#3fb950" : v >= 113 ? "#e3b341" : "#f78166";
                        const offDesc = play.teamOff == null ? null : play.teamOff >= 118 ? "an elite offense" : play.teamOff >= 113 ? "an above-average offense" : "an average offense";
                        const defDesc = play.oppDef == null ? null : play.oppDef >= 118 ? "one of the weakest defenses in the league" : play.oppDef >= 113 ? "a below-average defense" : "a solid defense";
                        const ouDesc2 = play.gameOuLine == null ? null : play.gameOuLine >= 235 ? "a fast-paced game" : play.gameOuLine >= 225 ? "an above-average total" : "a low-total game";
                        const paceAdj = (play.teamPace != null && play.leagueAvgPace != null) ? parseFloat((play.teamPace - play.leagueAvgPace).toFixed(1)) : null;
                        const etColor = play.teamExpected == null ? "#8b949e" : play.teamExpected >= play.threshold + 5 ? "#3fb950" : play.teamExpected >= play.threshold - 5 ? "#e3b341" : "#8b949e";
                        const _offPts = play.teamOff == null ? 1 : play.teamOff >= 118 ? 2 : play.teamOff >= 113 ? 1 : 0;
                        const _defPts = play.oppDef == null ? 1 : play.oppDef >= 118 ? 2 : play.oppDef >= 113 ? 1 : 0;
                        const _ouPts2 = play.gameOuLine == null ? 1 : play.gameOuLine >= 235 ? 2 : play.gameOuLine >= 225 ? 1 : 0;
                        const _pacePts = (play.teamPace == null || play.leagueAvgPace == null) ? 1 : play.teamPace > play.leagueAvgPace + 2 ? 2 : play.teamPace > play.leagueAvgPace - 2 ? 1 : 0;
                        const _h2hPts2 = play.h2hHitRatePts ?? 1;
                        const scTitle = [`Off PPG (${play.teamOff?.toFixed(0) ?? "—"}): ${_offPts}/2`,`Opp Def PPG (${play.oppDef?.toFixed(0) ?? "—"}): ${_defPts}/2`,`O/U (${play.gameOuLine ?? "—"}): ${_ouPts2}/2`,`Pace (${play.teamPace?.toFixed(1) ?? "—"}): ${_pacePts}/2`,`H2H HR% (${play.h2hHitRate?.toFixed(0) ?? "—"}%): ${_h2hPts2}/2`].join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> averages{play.teamOff != null ? <> <span style={{color:offColor(play.teamOff),fontWeight:600}}>{play.teamOff.toFixed(0)} PPG</span></> : " —"}{offDesc ? <> — <span style={{color:"#484f58"}}>{offDesc}</span></> : null}.{" "}
                            The <span style={{color:"#c9d1d9"}}>{play.oppTeam}</span> defense allows{play.oppDef != null ? <> <span style={{color:defColor(play.oppDef),fontWeight:600}}>{play.oppDef.toFixed(0)} PPG</span></> : " —"}{defDesc ? <> — <span style={{color:"#484f58"}}>{defDesc}</span></> : null}.
                            {play.h2hHitRate != null ? <>{" "}<span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> <span style={{color:"#484f58"}}>has scored {lineVal}+ pts in</span> <span style={{color: play.h2hHitRate >= 80 ? "#3fb950" : play.h2hHitRate >= 60 ? "#e3b341" : "#f78166",fontWeight:600}}>{play.h2hHitRate.toFixed(0)}%</span> <span style={{color:"#484f58"}}>of their last {play.h2hGames}g H2H meetings.</span></> : null}
                            {paceAdj != null && <>{" "}<span style={{color:"#484f58"}}>Team pace</span> <span style={{color:paceAdj > 2 ? "#3fb950" : paceAdj > -2 ? "#e3b341" : "#8b949e"}}>{paceAdj > 0 ? "+" : ""}{paceAdj}</span> <span style={{color:"#484f58"}}>vs league avg.</span></>}
                            {play.gameOuLine != null && <>{" "}<span style={{color:"#484f58"}}>Game total</span> <span style={{color:play.gameOuLine >= 235 ? "#3fb950" : play.gameOuLine >= 225 ? "#e3b341" : "#8b949e",fontWeight:600}}>{play.gameOuLine}</span>{ouDesc2 ? <> — <span style={{color:"#484f58"}}>{ouDesc2}</span></> : null}.</>}
                            {play.teamExpected != null && <>{" "}<span style={{color:"#484f58"}}>Model projects</span> <span style={{color:etColor,fontWeight:600}}>{play.teamExpected}</span> <span style={{color:"#484f58"}}>pts vs the {lineVal} line.</span></>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"help"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              }
              // ── End team total play card ────────────────────────────────────────────────────────

              // ── Game total play card ────────────────────────────────────────────────────────────
              if (play.gameType === "total") {
                const isUnder = play.direction === "under";
                const displayTruePct = isUnder ? play.noTruePct : play.truePct;
                const displayKalshiPct = isUnder ? play.noKalshiPct : play.kalshiPct;
                const tColor = tierColor(displayTruePct);
                const logoUrl = abbr => `https://a.espncdn.com/i/teamlogos/${play.sport}/500/${abbr.toLowerCase()}.png`;
                const tLabel = { totalRuns:"Runs", totalPoints:"Pts", totalGoals:"Goals" }[play.stat] || play.stat;
                const lineVal = (play.threshold - 0.5).toFixed(1);
                const tTrueOdds = displayTruePct >= 100 ? -99999 : (displayTruePct >= 50 ? Math.round(-(displayTruePct/(100-displayTruePct))*100) : Math.round((100-displayTruePct)/displayTruePct*100));
                const tTrueOddsStr = tTrueOdds > 0 ? `+${tTrueOdds}` : `${tTrueOdds}`;
                return (
                  <div key={playKey}
                    style={{background:"#161b22",border:`1px solid ${isTracked?"#3fb950":"#30363d"}`,borderRadius:12,
                      padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                    onMouseEnter={e => { if (!isTracked) e.currentTarget.style.borderColor="#58a6ff"; }}
                    onMouseLeave={e => { if (!isTracked) e.currentTarget.style.borderColor="#30363d"; }}>
                    {/* Header */}
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      {/* Matchup info */}
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                          <img src={logoUrl(play.awayTeam)} alt={play.awayTeam} onClick={e=>{e.stopPropagation();navigateToTeam(play.awayTeam,play.sport);}}
                            style={{width:44,height:44,objectFit:"contain",background:"#21262d",borderRadius:6,padding:2,flexShrink:0,cursor:"pointer"}}
                            onError={e=>e.target.style.display="none"}/>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.awayTeam,play.sport);}}
                            style={{color:"#c9d1d9",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.awayTeam}</span>
                          <span style={{color:"#484f58",fontSize:11}}>@</span>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.homeTeam,play.sport);}}
                            style={{color:"#c9d1d9",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.homeTeam}</span>
                          <img src={logoUrl(play.homeTeam)} alt={play.homeTeam} onClick={e=>{e.stopPropagation();navigateToTeam(play.homeTeam,play.sport);}}
                            style={{width:44,height:44,objectFit:"contain",background:"#21262d",borderRadius:6,padding:2,flexShrink:0,cursor:"pointer"}}
                            onError={e=>e.target.style.display="none"}/>
                        </div>
                        <div style={{color:"#8b949e",fontSize:11,marginTop:3,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                          {play.gameTime && (() => { const _d = new Date(play.gameTime); const ptFmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"}); const tPT = ptFmt.format(new Date()), rPT = ptFmt.format(new Date(Date.now()+86400000)); const gd = play.gameDate || ptFmt.format(_d); const dl = gd===tPT?"Today":gd===rPT?"Tomorrow":new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric"}).format(_d); const tp = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"2-digit",hour12:true}).format(_d); return <span>{dl} · {tp} PT</span>; })()}
                          {play.lowVolume && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(231,179,49,0.12)",border:"1px solid #e3b341",color:"#e3b341"}}>Low Vol</span>}
                          {play.thinMarket && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(247,129,102,0.10)",border:"1px solid #f78166",color:"#f78166"}}>Wide Spread</span>}
                          {play.lineMove != null && Math.abs(play.lineMove) >= 3 && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:play.lineMove > 0 ? "rgba(63,185,80,0.10)" : "rgba(247,129,102,0.10)",border:`1px solid ${play.lineMove > 0 ? "#3fb950" : "#f78166"}`,color:play.lineMove > 0 ? "#3fb950" : "#f78166"}}>{play.lineMove > 0 ? "▲" : "▼"} {Math.abs(play.lineMove)}c</span>}
                        </div>
                      </div>
                      {/* Threshold badge + edge badge + star button */}
                      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                        <span style={{background:isUnder?"rgba(247,129,102,0.12)":"rgba(88,166,255,0.12)",border:`1px solid ${isUnder?"#f78166":"#58a6ff"}`,
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:isUnder?"#f78166":"#58a6ff",fontWeight:700,whiteSpace:"nowrap"}}>
                          {isUnder ? "Under" : "Over"} {lineVal} {tLabel}
                        </span>
                        <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                          +{play.edge}%
                        </span>
                        <button onClick={e => { e.stopPropagation(); isTracked ? untrackPlay(trackId) : trackPlay(play); }}
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
                    {/* Rich text explanation */}
                    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:4}}>
                      {/* MLB Total */}
                      {play.sport === "mlb" && (() => {
                        const sc = play.totalSimScore;
                        const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                        const hERA = play.homeERA ?? null, aERA = play.awayERA ?? null;
                        const hRPG = play.homeRPG ?? null, aRPG = play.awayRPG ?? null;
                        const pf = play.parkFactor ?? 1;
                        const et = play.expectedTotal ?? null;
                        const eraColor = isUnder
                          ? (v => v == null ? "#8b949e" : v <= 3.5 ? "#3fb950" : v <= 4.5 ? "#e3b341" : "#f78166")
                          : (v => v == null ? "#8b949e" : v > 4.5 ? "#3fb950" : v > 3.5 ? "#e3b341" : "#f78166");
                        const rpgColor = isUnder
                          ? (v => v == null ? "#8b949e" : v <= 4.0 ? "#3fb950" : v <= 5.0 ? "#e3b341" : "#8b949e")
                          : (v => v == null ? "#8b949e" : v > 5.0 ? "#3fb950" : v > 4.0 ? "#e3b341" : "#8b949e");
                        const etColor = isUnder
                          ? (et == null ? "#8b949e" : et < play.threshold - 0.5 ? "#3fb950" : et < play.threshold + 0.5 ? "#e3b341" : "#8b949e")
                          : (et == null ? "#8b949e" : et >= play.threshold + 0.5 ? "#3fb950" : et >= play.threshold - 0.5 ? "#e3b341" : "#8b949e");
                        const gameOuLine = play.gameOuLine ?? null;
                        const mlbOuPts = play.mlbOuPts ?? 1;
                        const ouColor = isUnder
                          ? (gameOuLine == null ? "#8b949e" : gameOuLine < 7.5 ? "#3fb950" : gameOuLine < 9.5 ? "#e3b341" : "#f78166")
                          : (gameOuLine == null ? "#8b949e" : gameOuLine >= 9.5 ? "#3fb950" : gameOuLine >= 7.5 ? "#e3b341" : "#f78166");
                        const ouDesc = isUnder
                          ? (gameOuLine == null ? null : gameOuLine < 7.5 ? "a low total, supports the under" : gameOuLine < 9.5 ? "an average total" : "a high total — market expects heavy scoring")
                          : (gameOuLine == null ? null : gameOuLine >= 9.5 ? "a high-scoring game, supports the over" : gameOuLine >= 7.5 ? "an average total" : "a low total — market doesn't expect high scoring");
                        const scTitle = [isUnder?"[Under SimScore]":"",`${play.homeTeam} ERA (${hERA != null ? hERA.toFixed(2) : "—"}): ${hERA != null ? (hERA > 4.5 ? 2 : hERA > 3.5 ? 1 : 0) : 1}/2`,`${play.awayTeam} ERA (${aERA != null ? aERA.toFixed(2) : "—"}): ${aERA != null ? (aERA > 4.5 ? 2 : aERA > 3.5 ? 1 : 0) : 1}/2`,`${play.homeTeam} RPG (${hRPG != null ? hRPG.toFixed(1) : "—"}): ${hRPG != null ? (hRPG > 5.0 ? 2 : hRPG > 4.0 ? 1 : 0) : 1}/2`,`${play.awayTeam} RPG (${aRPG != null ? aRPG.toFixed(1) : "—"}): ${aRPG != null ? (aRPG > 5.0 ? 2 : aRPG > 4.0 ? 1 : 0) : 1}/2`,`O/U (${gameOuLine != null ? gameOuLine : "—"}): ${mlbOuPts}/2`].filter(Boolean).join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span>'s starter has{aERA != null ? <> a <span style={{color:eraColor(aERA),fontWeight:600}}>{aERA.toFixed(2)} ERA</span></> : " — ERA"}, facing a <span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> offense averaging{hRPG != null ? <> <span style={{color:rpgColor(hRPG),fontWeight:600}}>{hRPG.toFixed(1)}</span> runs/game</> : " — RPG"}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.homeTeam}</span>'s starter posts{hERA != null ? <> a <span style={{color:eraColor(hERA),fontWeight:600}}>{hERA.toFixed(2)} ERA</span></> : " — ERA"} against a <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> offense at{aRPG != null ? <> <span style={{color:rpgColor(aRPG),fontWeight:600}}>{aRPG.toFixed(1)}</span> RPG</> : " — RPG"}.
                            {Math.abs(pf - 1) > 0.01 && <>{" "}Tonight's park {pf > 1 ? "inflates run scoring" : "suppresses run scoring"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}%</span>).</>}
                            {gameOuLine != null && <>{" "}Game total <span style={{color:ouColor,fontWeight:600}}>{gameOuLine}</span><span style={{color:"#8b949e"}}> — {ouDesc}.</span></>}
                            {et != null && <>{" "}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined runs {isUnder ? "— under the" : "vs the"} <span style={{color:"#c9d1d9"}}>{lineVal}</span> threshold.</>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"default"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                      {/* NBA Total */}
                      {play.sport === "nba" && (() => {
                        const sc = play.totalSimScore;
                        const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                        const hOff = play.homeOff ?? null, aOff = play.awayOff ?? null;
                        const hDef = play.homeDef ?? null, aDef = play.awayDef ?? null;
                        const hPace = play.homePace ?? null, aPace = play.awayPace ?? null;
                        const lgPace = play.leagueAvgPace ?? null;
                        const et = play.expectedTotal ?? null;
                        const paceAdj = (hPace != null && aPace != null && lgPace != null) ? parseFloat(((hPace + aPace) / 2 - lgPace).toFixed(1)) : null;
                        const offColor = isUnder
                          ? (v => v == null ? "#8b949e" : v < 113 ? "#3fb950" : v < 118 ? "#e3b341" : "#f78166")
                          : (v => v == null ? "#8b949e" : v >= 118 ? "#f78166" : v >= 113 ? "#e3b341" : "#8b949e");
                        const defColor = isUnder
                          ? (v => v == null ? "#8b949e" : v < 113 ? "#3fb950" : v < 118 ? "#e3b341" : "#f78166")
                          : (v => v == null ? "#8b949e" : v >= 118 ? "#3fb950" : v >= 113 ? "#e3b341" : "#f78166");
                        const paceColor = isUnder
                          ? (paceAdj == null ? "#8b949e" : paceAdj < -2 ? "#3fb950" : paceAdj < 0 ? "#e3b341" : "#8b949e")
                          : (paceAdj == null ? "#8b949e" : paceAdj > 0 ? "#3fb950" : paceAdj > -2 ? "#e3b341" : "#8b949e");
                        const etColor = isUnder
                          ? (et == null ? "#8b949e" : et < play.threshold - 2 ? "#3fb950" : et < play.threshold + 2 ? "#e3b341" : "#8b949e")
                          : (et == null ? "#8b949e" : et >= play.threshold + 2 ? "#3fb950" : et >= play.threshold - 2 ? "#e3b341" : "#8b949e");
                        const nbaOuLinePC = play.gameOuLine ?? null; const nbaOuPtsPC = nbaOuLinePC == null ? 1 : nbaOuLinePC >= 235 ? 2 : nbaOuLinePC >= 225 ? 1 : 0;
                        const scTitle = [isUnder?"[Under SimScore]":"",`${play.homeTeam} off PPG (${hOff != null ? hOff.toFixed(0) : "—"}): ${hOff != null ? (hOff >= 118 ? 2 : hOff >= 113 ? 1 : 0) : 1}/2`,`${play.awayTeam} off PPG (${aOff != null ? aOff.toFixed(0) : "—"}): ${aOff != null ? (aOff >= 118 ? 2 : aOff >= 113 ? 1 : 0) : 1}/2`,`${play.homeTeam} def allowed (${hDef != null ? hDef.toFixed(0) : "—"}): ${hDef != null ? (hDef >= 118 ? 2 : hDef >= 113 ? 1 : 0) : 1}/2`,`${play.awayTeam} def allowed (${aDef != null ? aDef.toFixed(0) : "—"}): ${aDef != null ? (aDef >= 118 ? 2 : aDef >= 113 ? 1 : 0) : 1}/2`,`O/U (${nbaOuLinePC ?? "—"}): ${nbaOuPtsPC}/2`].filter(Boolean).join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> averages{aOff != null ? <> <span style={{color:offColor(aOff),fontWeight:600}}>{aOff.toFixed(0)} PPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> defense allowing{hDef != null ? <> <span style={{color:defColor(hDef),fontWeight:600}}>{hDef.toFixed(0)} PPG</span></> : " —"}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> averages{hOff != null ? <> <span style={{color:offColor(hOff),fontWeight:600}}>{hOff.toFixed(0)} PPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> defense allowing{aDef != null ? <> <span style={{color:defColor(aDef),fontWeight:600}}>{aDef.toFixed(0)} PPG</span></> : " —"}.
                            {paceAdj != null && <>{" "}Game pace is <span style={{color:paceColor,fontWeight:600}}>{paceAdj > 0 ? "+" : ""}{paceAdj}</span> vs league avg{isUnder ? (paceAdj < -2 ? " — slower game, supports under" : " — near average") : (paceAdj > 0 ? " — more possessions, more scoring" : paceAdj > -2 ? " — near league average" : " — slower game, fewer possessions")}.</>}
                            {et != null && <>{" "}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined pts {isUnder ? "— under the" : "vs the"} <span style={{color:"#c9d1d9"}}>{lineVal}</span> threshold.</>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"default"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                      {/* NHL Total */}
                      {play.sport === "nhl" && (() => {
                        const sc = play.totalSimScore;
                        const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                        const hGPG = play.homeGPG ?? null, aGPG = play.awayGPG ?? null;
                        const hGAA = play.homeGAA ?? null, aGAA = play.awayGAA ?? null;
                        const et = play.expectedTotal ?? null;
                        const gpgColor = isUnder
                          ? (v => v == null ? "#8b949e" : v < 3.0 ? "#3fb950" : v < 3.5 ? "#e3b341" : "#8b949e")
                          : (v => v == null ? "#8b949e" : v >= 3.5 ? "#3fb950" : v >= 3.0 ? "#e3b341" : "#8b949e");
                        const gaaColor = isUnder
                          ? (v => v == null ? "#8b949e" : v < 3.0 ? "#3fb950" : v < 3.5 ? "#e3b341" : "#8b949e")
                          : (v => v == null ? "#8b949e" : v >= 3.5 ? "#3fb950" : v >= 3.0 ? "#e3b341" : "#8b949e");
                        const etColor = isUnder
                          ? (et == null ? "#8b949e" : et < play.threshold - 0.5 ? "#3fb950" : et < play.threshold + 0.5 ? "#e3b341" : "#8b949e")
                          : (et == null ? "#8b949e" : et >= play.threshold + 0.5 ? "#3fb950" : et >= play.threshold - 0.5 ? "#e3b341" : "#8b949e");
                        const _gpgPts = v => v == null ? 1 : v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0;
                        const _gaaPts = v => v == null ? 1 : v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0;
                        const nhlOuLinePC = play.gameOuLine ?? null; const nhlOuPtsPC = nhlOuLinePC == null ? 1 : nhlOuLinePC >= 7 ? 2 : nhlOuLinePC >= 5.5 ? 1 : 0;
                        const scTitle = [isUnder?"[Under SimScore]":"",`${play.homeTeam} GPG (${hGPG ?? "—"}): ${_gpgPts(hGPG)}/2`,`${play.awayTeam} GPG (${aGPG ?? "—"}): ${_gpgPts(aGPG)}/2`,`${play.homeTeam} GAA (${hGAA ?? "—"}): ${_gaaPts(hGAA)}/2`,`${play.awayTeam} GAA (${aGAA ?? "—"}): ${_gaaPts(aGAA)}/2`,`O/U (${nhlOuLinePC ?? "—"}): ${nhlOuPtsPC}/2`].filter(Boolean).join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> averages{aGPG != null ? <> <span style={{color:gpgColor(aGPG),fontWeight:600}}>{aGPG.toFixed(1)} GPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> defense with{hGAA != null ? <> <span style={{color:gaaColor(hGAA),fontWeight:600}}>{hGAA.toFixed(2)} GAA</span></> : " — GAA"}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> averages{hGPG != null ? <> <span style={{color:gpgColor(hGPG),fontWeight:600}}>{hGPG.toFixed(1)} GPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> defense allowing{aGAA != null ? <> <span style={{color:gaaColor(aGAA),fontWeight:600}}>{aGAA.toFixed(2)} GAA</span></> : " — GAA"}.
                            {et != null && <>{" "}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined goals {isUnder ? "— under the" : "vs the"} <span style={{color:"#c9d1d9"}}>{lineVal}</span> threshold.</>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"default"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                    </div>
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
                    {/* Headshot */}
                    {headshotUrl && (
                      <img src={headshotUrl} alt={play.playerName}
                        style={{width:44,height:44,borderRadius:"50%",objectFit:"cover",objectPosition:"top",
                          background:"#21262d",flexShrink:0,border:"1px solid #30363d"}}
                        onError={e => { e.target.style.display="none"; }}/>
                    )}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <div style={{color:"#fff",fontSize:14,fontWeight:700}}>{play.playerName}</div>
                      </div>
                      <div style={{color:"#8b949e",fontSize:11,marginTop:2,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                        <span>{play.playerTeam} vs {play.opponent}{play.position ? ` · ${play.position}` : ""}</span>
                        {play.gameTime && (
                          <span style={{color:"#6e7681"}}>·</span>
                        )}
                        {play.gameTime && (() => { const _d = new Date(play.gameTime); const ptFmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"}); const tPT = ptFmt.format(new Date()), rPT = ptFmt.format(new Date(Date.now()+86400000)); const gd = play.gameDate || ptFmt.format(_d); const dl = gd===tPT?"Today":gd===rPT?"Tomorrow":new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric"}).format(_d); const tp = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"2-digit",hour12:true}).format(_d); return <span style={{color:"#8b949e"}}>{dl} · {tp} PT</span>; })()}
                        {play.lineupConfirmed === true && (
                          <span title="Official lineup posted" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(63,185,80,0.12)",border:"1px solid #3fb950",color:"#3fb950"}}>✓ Lineup</span>
                        )}
                        {play.lineupConfirmed === false && !(play.gameTime && Date.now() >= new Date(play.gameTime).getTime() - 30*60*1000) && (
                          <span title="Projected lineup — not yet official" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(139,148,158,0.12)",border:"1px solid #484f58",color:"#8b949e"}}>Proj. Lineup</span>
                        )}
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
                      <span style={{background:"rgba(88,166,255,0.12)",border:"1px solid #58a6ff",
                        borderRadius:6,padding:"2px 8px",fontSize:12,color:"#58a6ff",fontWeight:700,whiteSpace:"nowrap"}}>
                        {play.threshold}+ {STAT_LABEL[play.stat] || play.stat}
                      </span>
                      <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                        borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                        +{play.edge}%
                      </span>
                      <button onClick={e => { e.stopPropagation(); if (isTracked) { untrackPlay(trackId); return; } const calcV = calcOdds.trim(); const overrideOdds = (calcV && calcV !== "-" && calcV !== "+" && !isNaN(parseInt(calcV))) ? parseInt(calcV) : null; const finalOdds = overrideOdds ?? play.americanOdds; const newKalshiPct = overrideOdds != null ? (overrideOdds < 0 ? Math.abs(overrideOdds)/(Math.abs(overrideOdds)+100)*100 : 100/(overrideOdds+100)*100) : play.kalshiPct; const newEdge = play.truePct != null ? parseFloat((play.truePct - newKalshiPct).toFixed(1)) : play.edge; trackPlay({ ...play, americanOdds: finalOdds, kalshiPct: parseFloat(newKalshiPct.toFixed(1)), edge: newEdge }); }}
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
                  {play.sport !== "mlb" && play.sport !== "nba" && play.sport !== "nhl" && <div style={{borderTop:"1px solid #21262d",paddingTop:8}}>
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
                  {/* Matchup explanations — always visible */}
                  <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:play.sport==="mlb"?0:8}}>
                        {/* ── MLB Strikeouts ── */}
                        {play.stat === "strikeouts" && play.sport === "mlb" && (() => {
                          const csw = play.pitcherCSWPct ?? null;
                          const pkp = csw ?? play.pitcherKPct;
                          const pkpLabel = csw != null ? "CSW%" : "K%";
                          const kbb = play.pitcherKBBPct ?? null;
                          const ap = play.pitcherAvgPitches ?? null;
                          const recK = play.pitcherRecentKPct ?? null;
                          const seaK = play.pitcherSeasonKPct ?? null;
                          const lkp = play.lineupKPct;
                          const pf = play.parkFactor;
                          const isProjected = play.lineupKPctProjected === true;
                          const gameTotal = play.gameTotal ?? null;
                          const gameML = play.gameMoneyline ?? null;
                          const handLabel = play.pitcherHand === "R" ? " vs RHP" : play.pitcherHand === "L" ? " vs LHP" : "";
                          const _sc = play.finalSimScore ?? play.simScore ?? null;
                          const first = play.playerName.split(" ")[0];
                          const oppName = MLB_TEAM[play.opponent] || play.opponent;
                          const pkpColor = pkp == null ? "#8b949e" : (csw != null ? (pkp >= 30 ? "#3fb950" : pkp > 26 ? "#e3b341" : "#f78166") : (pkp >= 27 ? "#3fb950" : pkp >= 24 ? "#e3b341" : "#f78166"));
                          const kbbColor = kbb == null ? "#8b949e" : kbb > 18 ? "#3fb950" : kbb > 12 ? "#e3b341" : "#f78166";
                          const apColor = ap == null ? "#8b949e" : ap > 85 ? "#3fb950" : ap > 75 ? "#e3b341" : "#f78166";
                          const lkpColor = lkp == null ? "#8b949e" : lkp > 24 ? "#3fb950" : lkp > 20 ? "#e3b341" : "#f78166";
                          const totalColor = t => t == null ? "#8b949e" : t <= 7.5 ? "#3fb950" : t < 10.5 ? "#e3b341" : "#f78166";
                          const mlColor = ml => ml == null ? "#8b949e" : ml <= -121 ? "#3fb950" : ml <= 120 ? "#e3b341" : "#f78166";
                          const pkpQual = pkp == null ? "" : csw != null ? (pkp >= 30 ? "elite" : pkp > 26 ? "above-average" : "below-average") : (pkp > 24 ? "above-average" : "below-average");
                          const apDesc = ap == null ? null : ap > 85 ? "expect him to work deep into the game" : ap > 75 ? "typically goes 5–6 innings" : null;
                          const lkpDesc = lkp == null ? null : lkp > 24 ? "a high-strikeout lineup — works in his favor" : lkp > 20 ? "below-average strikeout tendency" : "elite contact lineup — a tougher test";
                          const scColor = _sc == null ? "#8b949e" : _sc >= 8 ? "#3fb950" : _sc >= 5 ? "#e3b341" : "#8b949e";
                          const scTitle = _sc != null ? [`CSW%/K%: ${play.kpctPts ?? 1}/2`,`K-BB%: ${play.kbbPts ?? 1}/2`,`Lineup K%: ${play.lkpPts ?? 1}/2`,`Hit Rate: ${play.blendedHitRatePts ?? 1}/2`,`O/U: ${play.totalPts ?? 1}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first} has {pkpQual ? <>{pkpQual} </> : ""}swing-and-miss stuff
                                {pkp != null && <> — <span style={{color:pkpColor,fontWeight:600}}>{pkp}%</span> {pkpLabel}</>}
                                {kbb != null && <>, <span style={{color:kbbColor,fontWeight:600}}>{kbb.toFixed(1)}%</span> K-BB% <span style={{color:"#8b949e"}}>(strikeouts vs walks)</span></>}
                                {ap != null && <>, averaging <span style={{color:apColor,fontWeight:600}}>{Math.round(ap)}</span> pitches/start{apDesc ? <span style={{color:"#8b949e"}}> — {apDesc}</span> : ""}</>}.
                                {lkp != null && <>{" "}The {oppName} lineup strikes out at <span style={{color:lkpColor,fontWeight:600}}>{lkp}%</span>{handLabel}{isProjected ? <span style={{color:"#484f58",fontSize:10}}> (est.)</span> : ""} — <span style={{color:"#8b949e"}}>{lkpDesc}</span>.</>}
                                {pf != null && Math.abs(pf - 1.0) >= 0.01 && <>{" "}Tonight's venue {pf > 1 ? "is strikeout-friendly" : "suppresses strikeouts"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}%</span>).</>}
                                {(recK != null || gameTotal != null) && <>{" "}{recK != null && <><span style={{color:play.kTrendPts===2?"#3fb950":play.kTrendPts===0?"#f78166":"#e3b341",fontWeight:600}}>{recK.toFixed(1)}%</span><span style={{color:"#8b949e"}}> recent K%{play.kTrendPts===2?" ↑":play.kTrendPts===0?" ↓":""}{seaK!=null?` (${seaK.toFixed(1)}% season)`:""}</span>{gameTotal != null ? <span style={{color:"#8b949e"}}>, </span> : <span style={{color:"#8b949e"}}>.</span>}</>}{gameTotal != null && <><span style={{color:"#8b949e"}}>game total </span><span style={{color:totalColor(gameTotal),fontWeight:600}}>{gameTotal}</span><span style={{color:"#8b949e"}}>{gameTotal <= 8.5 ? " — a low-scoring slate, favorable for strikeouts" : gameTotal <= 10.5 ? " — an average total" : " — a high-scoring total, tougher for Ks"}.</span></>}</>}
                                {_sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{_sc}/10 {_sc>=8?"Alpha":"Mid"}</span></>}
                              </div>
                            </div>
                          );
                        })()}
                        {/* ── MLB Hitters (hits/hrr) — always show ── */}
                        {play.sport === "mlb" && play.stat !== "strikeouts" && (() => {
                          const baVal = play.hitterBa ? `.${Math.round(play.hitterBa * 1000).toString().padStart(3,"0")}` : null;
                          const baTier = play.hitterBaTier;
                          const baTierLabel = baTier === "elite" ? "elite" : baTier === "good" ? "good" : baTier === "avg" ? "average" : null;
                          const baColor = baTier === "elite" ? "#58a6ff" : baTier === "good" ? "#3fb950" : "#8b949e";
                          const lineupSpot = play.hitterLineupSpot;
                          const spotColor = lineupSpot == null ? "#8b949e" : lineupSpot <= 3 ? "#3fb950" : lineupSpot <= 4 ? "#e3b341" : "#8b949e";
                          const pitcherName = play.hitterPitcherName;
                          const ab = play.hitterAbVsPitcher;
                          const whip = play.pitcherWHIP;
                          const fip = play.pitcherFIP;
                          const era = play.hitterPitcherEra ?? play.pitcherEra ?? null;
                          const pf = play.parkFactor ?? play.hitterParkKF;
                          const seasonG = play.pct26 != null ? play.pct26Games : (play.blendGames || play.seasonGames);
                          const seasonWindow = play.pct26 != null ? "this season" : "2025-26";
                          const statFull = STAT_FULL[play.stat] || play.stat;
                          const sc = play.hitterFinalSimScore ?? play.hitterSimScore ?? null;
                          const first = play.playerName.split(" ")[0];
                          const whipColor = whip == null ? "#8b949e" : whip > 1.35 ? "#3fb950" : whip > 1.20 ? "#e3b341" : "#f78166";
                          const fipColor = fip == null ? "#8b949e" : fip > 4.5 ? "#3fb950" : fip > 3.5 ? "#e3b341" : "#8b949e";
                          const scColor = sc != null ? (sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e") : "#8b949e";
                          const seasonColor = play.seasonPct >= 75 ? "#3fb950" : play.seasonPct >= 60 ? "#c9d1d9" : "#f78166";
                          const spotDesc = lineupSpot == null ? null : lineupSpot <= 3 ? "top of the order — guaranteed at-bats every game" : lineupSpot <= 4 ? "heart of the order — plenty of at-bats" : null;
                          const whipDesc = whip == null ? null : whip > 1.35 ? "a lot of baserunners" : whip > 1.20 ? "some traffic on base" : null;
                          const fipDesc = fip == null ? null : fip > 4.5 ? "hittable pitcher" : fip > 3.5 ? "average pitcher" : null;
                          const mk = (meets, label) => meets != null ? <span key={label} style={{color:meets?"#3fb950":"#f78166",fontSize:9,whiteSpace:"nowrap"}}>{meets?"✓":"✗"}{label}</span> : null;
                          const hitterGameTotal = play.hitterGameTotal ?? null;
                          const hitterTotalColor = t => t == null ? "#8b949e" : t >= 9.5 ? "#3fb950" : t >= 7.5 ? "#e3b341" : "#f78166";
                          const barrelPct = play.hitterBarrelPct ?? null;
                          const barrelColor = barrelPct == null ? "#8b949e" : barrelPct >= 14 ? "#3fb950" : barrelPct >= 10 ? "#e3b341" : barrelPct >= 7 ? "#8b949e" : "#f78166";
                          const platoonPts = play.hitterPlatoonPts ?? null;
                          const pitcherHand = play.oppPitcherHand ?? null;
                          const scTitle = sc != null ? [`Quality: ${play.hitterBatterQualityPts ?? 1}/2`,`WHIP: ${play.hitterWhipPts ?? 1}/2`,`Season HR: ${play.hitterSeasonHitRatePts ?? 1}/2`,`H2H HR: ${play.hitterH2HHitRatePts ?? 1}/2`,`O/U: ${play.hitterTotalPts ?? 1}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first}{lineupSpot != null && <>, batting <span style={{color:spotColor,fontWeight:600}}>#{lineupSpot}</span>{spotDesc ? <span style={{color:"#8b949e"}}> — {spotDesc}</span> : ""}</>}.
                                {(pitcherName || whip != null) && (
                                  <> Facing{pitcherName ? <> <span style={{color:"#c9d1d9",fontWeight:600}}>{pitcherName}</span>{ab ? <span style={{color:"#484f58",fontSize:10}}> ({ab} career AB)</span> : ""}</> : " the opposing starter"}{whip != null ? <> — WHIP <span style={{color:whipColor,fontWeight:600}}>{whip.toFixed(2)}</span>{whipDesc ? <span style={{color:"#8b949e"}}> ({whipDesc})</span> : ""}</> : ""}.</>
                                )}
                                {" "}{first} has gone {play.threshold}+ {statFull} in <span style={{color:seasonColor,fontWeight:600}}>{play.seasonPct}%</span> of games {seasonWindow}{seasonG ? <span style={{color:"#484f58",fontSize:10}}> ({seasonG}g)</span> : ""}
                                {play.softPct != null ? <>, and <span style={{color:"#3fb950",fontWeight:600}}>{play.softPct}%</span> {play.hitterSoftLabel ?? "against weak pitching matchups"}{play.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.softGames}g)</span> : ""}</> : ""}.
                                {play.oppRank && play.softPct === null && (() => {
                                  const _opp2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{play.opponent}</span>;
                                  const _rank2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{ordinal(play.oppRank)}-worst</span>;
                                  const _metricStr2 = play.oppMetricValue ? ` (${play.oppMetricValue} ${play.oppMetricUnit || ""})` : "";
                                  const _ctx2 = {"mlb|hits":"one of the easiest pitching matchups in the league — their staff has a high ERA this season","mlb|hrr":"one of the easiest pitching matchups in the league — their staff allows hits, runs, and RBIs at a high rate"}[`${play.sport}|${play.stat}`] || "one of the weakest defenses for this stat";
                                  return <>{" "}{_opp2} ranks {_rank2} in {play.oppMetricLabel || "this stat"}{_metricStr2} this season — {_ctx2}.{<>{" "}No head-to-head history yet{play.pct25 != null && play.pct25Games >= 5 ? <> — was at <span style={{color:"#c9d1d9"}}>{play.pct25}%</span> in {play.pct25Games} games in 2025</> : ""}.</>}</>;
                                })()}
                                {pf != null && Math.abs(pf - 1.0) >= 0.03 && <>{" "}Tonight's venue is {pf > 1 ? "hitter-friendly" : "pitcher-friendly"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}% park factor</span>).</>}
                                {hitterGameTotal != null && <>{" "}<span style={{color:"#8b949e"}}>Game total </span><span style={{color:hitterTotalColor(hitterGameTotal),fontWeight:600}}>{hitterGameTotal}</span><span style={{color:"#8b949e"}}>{hitterGameTotal >= 9.5 ? " — a high-scoring game, favorable for hitting" : hitterGameTotal >= 7.5 ? " — an average total" : " — a low-scoring game, tougher for hitters"}.</span></>}
                                {barrelPct != null && <>{" "}<span style={{color:"#8b949e"}}>Barrel rate </span><span style={{color:barrelColor,fontWeight:600}}>{barrelPct.toFixed(1)}%</span><span style={{color:"#484f58"}}>{barrelPct >= 14 ? " — elite hard contact" : barrelPct >= 10 ? " — strong contact quality" : barrelPct >= 7 ? " — average contact" : " — below-average contact"}.</span></>}
                                {platoonPts === 2 && pitcherHand && (() => { const splitBA = play.hitterSplitBA; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#3fb950",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon edge.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon edge vs {handStr}.</span></>; })()}
                                {platoonPts === 0 && pitcherHand && (() => { const splitBA = play.hitterSplitBA; const seasonBA = play.hitterBa; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#f78166",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon disadvantage{seasonBA != null ? <> (<span style={{color:"#c9d1d9"}}>.{Math.round(seasonBA*1000).toString().padStart(3,"0")}</span> season)</> : ""}.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon disadvantage vs {handStr}.</span></>; })()}
                                {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                              </div>
                            </div>
                          );
                        })()}
                        {/* ── NBA — always show ── */}
                        {play.sport === "nba" && (() => {
                          const statName = { points:"points", rebounds:"rebounds", assists:"assists", threePointers:"3-pointers" }[play.stat] || play.stat;
                          const posName = {PG:"point guard",SG:"shooting guard",SF:"small forward",PF:"power forward",C:"center"}[play.posGroup] ?? null;
                          const hasPosDvp = play.posDvpRank != null;
                          const displayRank = hasPosDvp ? play.posDvpRank : play.oppRank;
                          const displayValue = hasPosDvp ? play.posDvpValue : play.oppMetricValue;
                          const sc = play.nbaSimScore;
                          const first = play.playerName.split(" ")[0];
                          const scColor = sc != null ? (sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e") : "#8b949e";
                          const rankColor = play.isHardMatchup ? "#f78166" : (displayRank != null && displayRank <= 10) ? "#3fb950" : (displayRank != null && displayRank <= 15) ? "#e3b341" : play.softPct !== null ? "#3fb950" : "#c9d1d9";
                          const seasonColor = play.seasonPct == null ? "#c9d1d9" : play.seasonPct >= 75 ? "#3fb950" : play.seasonPct >= 60 ? "#c9d1d9" : "#f78166";
                          const minColor = play.nbaOpportunity == null ? "#8b949e" : play.nbaOpportunity >= 30 ? "#3fb950" : play.nbaOpportunity >= 25 ? "#e3b341" : "#f78166";
                          const paceColor = play.nbaPaceAdj == null ? "#8b949e" : play.nbaPaceAdj > 0 ? "#3fb950" : play.nbaPaceAdj > -2 ? "#e3b341" : "#f78166";
                          const minDesc = play.nbaOpportunity == null ? null : play.nbaOpportunity >= 33 ? "a featured starter with a big role" : play.nbaOpportunity >= 30 ? "a key starter" : play.nbaOpportunity >= 25 ? "solid rotation player" : "limited role";
                          const paceDesc = play.nbaPaceAdj == null ? null : play.nbaPaceAdj > 2 ? "a fast game — more possessions, more opportunities to score" : play.nbaPaceAdj > 0 ? "slightly above-average pace" : play.nbaPaceAdj > -2 ? "slightly slower pace" : "a slow game — fewer scoring opportunities";
                          const rankDesc = displayRank == null ? null : displayRank <= 3 ? "one of the worst defenses in the league" : displayRank <= 8 ? "a weak defense" : displayRank <= 15 ? "a soft matchup" : null;
                          const _usgPts = play.stat === "rebounds"
                            ? (play.nbaOpportunity == null ? 1 : play.nbaOpportunity >= 30 ? 2 : play.nbaOpportunity >= 25 ? 1 : 0)
                            : (play.nbaUsage == null ? 1 : play.nbaUsage >= 28 ? 2 : play.nbaUsage >= 22 ? 1 : 0);
                          const _c1Label = play.stat === "rebounds"
                            ? `AvgMin: ${play.nbaOpportunity != null ? play.nbaOpportunity.toFixed(0)+"m → "+_usgPts : "—"}/2`
                            : `USG%: ${play.nbaUsage != null ? play.nbaUsage.toFixed(1)+"% → "+_usgPts : "—"}/2`;
                          const _dvpPtsPC = play.posDvpRank != null ? (play.posDvpRank <= 10 ? 2 : play.posDvpRank <= 15 ? 1 : 0) : 1;
                          const _nbaSeasonHRPtsPC = play.nbaSeasonHitRatePts ?? (play.seasonPct >= 90 ? 2 : play.seasonPct >= 80 ? 1 : 0);
                          const _nbaSoftHRPtsPC = play.nbaSoftHitRatePts ?? (play.softPct == null ? 1 : play.softPct >= 90 ? 2 : play.softPct >= 80 ? 1 : 0);
                          const _paceGoodPC = play.nbaPaceAdj != null && play.nbaPaceAdj > 0;
                          const _totalGoodPC = play.nbaGameTotal != null && play.nbaGameTotal >= 225;
                          const _comboPtsPC = (_paceGoodPC && _totalGoodPC) ? 2 : (_paceGoodPC || _totalGoodPC) ? 1 : 0;
                          const scTitle = sc != null ? [_c1Label,`DVP: ${_dvpPtsPC}/2`,`Season HR: ${_nbaSeasonHRPtsPC}/2`,`Soft HR: ${_nbaSoftHRPtsPC}/2`,`Pace+Total: ${_comboPtsPC}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first} hits this line in <span style={{color:seasonColor,fontWeight:600}}>{play.seasonPct}%</span> of games{play.seasonGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.seasonGames}g)</span> : ""}
                                {play.nbaOpportunity != null ? <>, averaging <span style={{color:minColor,fontWeight:600}}>{play.nbaOpportunity.toFixed(0)} minutes</span> a night{minDesc ? <span style={{color:"#484f58"}}> — {minDesc}</span> : ""}</> : ""}
                                {play.stat === "assists" && play.nbaAvgAst != null ? <> (<span style={{color:play.nbaAvgAst>=7?"#3fb950":play.nbaAvgAst>=5?"#e3b341":"#f78166",fontWeight:600}}>{play.nbaAvgAst.toFixed(1)} APG</span>)</> : play.stat === "rebounds" && play.nbaAvgReb != null ? <> (<span style={{color:play.nbaAvgReb>=9?"#3fb950":play.nbaAvgReb>=7?"#e3b341":"#f78166",fontWeight:600}}>{play.nbaAvgReb.toFixed(1)} RPG</span>)</> : play.nbaUsage != null ? <> (<span style={{color:play.nbaUsage>=28?"#3fb950":play.nbaUsage>=22?"#e3b341":"#f78166",fontWeight:600}}>{play.nbaUsage.toFixed(0)}% USG</span>)</> : ""}.
                                {displayRank != null && <>{" "}{play.opponent} has {rankDesc || `the ${ordinal(displayRank)}-worst defense`} in {statName} allowed{posName ? ` to ${posName}s` : ""}{displayValue != null ? <> — giving up <span style={{color:rankColor,fontWeight:600}}>{displayValue} per game</span></> : <>, ranked <span style={{color:rankColor,fontWeight:700}}>{ordinal(displayRank)}</span></>}.</>}
                                {play.softPct != null && <>{" "}{first} hits this in <span style={{color:play.softPct>=70?"#3fb950":play.softPct>=60?"#e3b341":"#f78166",fontWeight:600}}>{play.softPct}%</span> of games against soft defenses{play.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.softGames}g)</span> : ""}.</>}
                                {play.nbaPaceAdj != null && <>{" "}Game pace is <span style={{color:paceColor,fontWeight:600}}>{play.nbaPaceAdj > 0 ? "+" : ""}{play.nbaPaceAdj}</span> possessions above average — {paceDesc}.</>}
                                {play.nbaGameTotal != null && <>{" "}Game total <span style={{color:play.nbaTotalPts>=3?"#3fb950":play.nbaTotalPts>=2?"#e3b341":play.nbaTotalPts>=1?"#8b949e":"#f78166",fontWeight:600}}>{play.nbaGameTotal}</span><span style={{color:"#8b949e"}}>{play.nbaGameTotal>=235?" — a high-scoring slate":play.nbaGameTotal>=225?" — above-average scoring":play.nbaGameTotal>=215?" — an average total":" — a low-scoring slate"}.</span></>}
                                {play.nbaBlowoutAdj != null && play.nbaBlowoutAdj < 0.99 && <>{" "}<span style={{color:"#f78166",fontWeight:600}}>Blowout risk</span> — large spread reduces model mean by {Math.round((1-play.nbaBlowoutAdj)*100)}%.</>}
                                {play.isB2B != null && <>{" "}{play.isB2B ? <><span style={{color:"#f78166",fontWeight:600}}>Back-to-back</span> — model applies a scoring reduction.</> : <>Fully rested tonight.</>}</>}
                                {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                              </div>
                            </div>
                          );
                        })()}
                        {/* ── NHL — always show ── */}
                        {play.sport === "nhl" && (() => {
                          const statName = "points";
                          const sc = play.nhlSimScore;
                          const first = play.playerName.split(" ")[0];
                          const scColor = sc != null ? (sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e") : "#8b949e";
                          const seasonColor = play.seasonPct >= 75 ? "#3fb950" : play.seasonPct >= 60 ? "#c9d1d9" : "#f78166";
                          const toiColor = play.nhlOpportunity == null ? "#8b949e" : play.nhlOpportunity >= 18 ? "#3fb950" : play.nhlOpportunity >= 15 ? "#e3b341" : "#f78166";
                          const saColor = play.nhlShotsAdj == null ? "#8b949e" : (play.nhlSaRank != null && play.nhlSaRank <= 10) ? "#3fb950" : play.nhlShotsAdj > 0 ? "#e3b341" : "#f78166";
                          const rankColor = play.oppRank != null && play.oppRank <= 5 ? "#3fb950" : "#e3b341";
                          const toiDesc = play.nhlOpportunity == null ? null : play.nhlOpportunity >= 21 ? "a top-line role" : play.nhlOpportunity >= 18 ? "a key contributor" : play.nhlOpportunity >= 15 ? "solid ice time" : "limited role";
                          const rankDesc = play.oppRank == null ? null : play.oppRank <= 3 ? "one of the worst defenses in the league" : play.oppRank <= 8 ? "a weak defense" : play.oppRank <= 15 ? "a soft matchup" : null;
                          const saDesc = play.nhlShotsAdj == null ? null : play.nhlShotsAdj > 2 ? "generating high shot volume — more scoring chances" : play.nhlShotsAdj > 0 ? "above-average shot volume" : play.nhlShotsAdj > -2 ? "slightly below average" : "low shot volume allowed";
                          const _nhlToiPtsPC = play.nhlOpportunity != null && play.nhlOpportunity >= 18 ? 2 : play.nhlOpportunity != null && play.nhlOpportunity >= 15 ? 1 : 0;
                          const _nhlGaaPtsPC = play.oppRank != null ? (play.oppRank <= 10 ? 2 : play.oppRank <= 15 ? 1 : 0) : 1;
                          const _nhlTotalPtsPC = play.nhlGameTotal == null ? 1 : play.nhlGameTotal >= 7 ? 2 : play.nhlGameTotal >= 5.5 ? 1 : 0;
                          const _nhlSeasonHRPtsPC = play.nhlSeasonHitRatePts ?? (play.seasonPct == null ? 1 : play.seasonPct >= 90 ? 2 : play.seasonPct >= 80 ? 1 : 0);
                          const _nhlDvpHRPtsPC = play.nhlDvpHitRatePts ?? 1;
                          const scTitle = sc != null ? [`TOI ${play.nhlOpportunity != null ? play.nhlOpportunity.toFixed(0) + "m" : "—"}: ${_nhlToiPtsPC}/2`, `GAA rank: ${_nhlGaaPtsPC}/2`, `Season HR: ${_nhlSeasonHRPtsPC}/2`, `DVP HR: ${_nhlDvpHRPtsPC}/2`, `O/U ${play.nhlGameTotal ?? "—"}: ${_nhlTotalPtsPC}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first} hits this line in <span style={{color:seasonColor,fontWeight:600}}>{play.seasonPct}%</span> of games{play.seasonGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.seasonGames}g)</span> : ""}
                                {play.nhlOpportunity != null ? <>, averaging <span style={{color:toiColor,fontWeight:600}}>{play.nhlOpportunity.toFixed(0)} min</span> of ice time{toiDesc ? <span style={{color:"#484f58"}}> — {toiDesc}</span> : ""}</> : ""}.
                                {play.oppRank != null && <>{" "}{play.opponent} has {rankDesc || `the ${ordinal(play.oppRank)}-worst defense`} in {statName} allowed — ranked <span style={{color:rankColor,fontWeight:700}}>{ordinal(play.oppRank)}</span> in goals against.</>}
                                {play.nhlShotsAdj != null && <>{" "}They allow <span style={{color:saColor,fontWeight:600}}>{play.nhlShotsAdj > 0 ? "+" : ""}{play.nhlShotsAdj}</span> shots/game above average — {saDesc}.</>}
                                {play.softPct != null && <>{" "}{first} hits this in <span style={{color:"#3fb950",fontWeight:600}}>{play.softPct}%</span> vs weak defenses{play.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.softGames}g)</span> : ""}.</>}
                                {play.isB2B != null && <>{" "}{play.isB2B ? <><span style={{color:"#f78166",fontWeight:600}}>Back-to-back</span> — model applies a fatigue reduction.</> : <>Fully rested tonight.</>}</>}
                                {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                              </div>
                            </div>
                          );
                        })()}
                        {/* ── NHL / NFL (team ranking) ── */}
                        {play.oppRank && play.stat !== "strikeouts" && play.sport !== "nba" && play.sport !== "nhl" && play.sport !== "mlb" && (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.5}}>
                            {(() => {
                              const first = play.playerName.split(" ")[0];
                              const opp = <span style={{color:"#c9d1d9",fontWeight:600}}>{play.opponent}</span>;
                              const metricStr = play.oppMetricValue ? ` (${play.oppMetricValue} ${play.oppMetricUnit || ""})` : "";
                              const rank = <span style={{color:"#f78166",fontWeight:700}}>{ordinal(play.oppRank)}-worst</span>;
                              const hitRate = <span style={{color:"#3fb950",fontWeight:600}}>{play.softPct}%</span>;
                              const games = play.softGames ? ` (${play.softGames} games)` : "";
                              const proj = play.projectedStat;
                              const recent = play.recentAvg;
                              const dvp = play.dvpFactor;

                              // NFL / MLB (non-strikeout with oppRank)
                              const context = {
                                "mlb|hits":           "one of the easiest pitching matchups in the league — their staff has a high ERA this season",
                                "mlb|hrr":            "one of the easiest pitching matchups in the league — their staff allows hits, runs, and RBIs at a high rate",
                                "mlb|totalBases":     "one of the easiest pitching matchups in the league — their staff allows lots of base hits",
                                "nfl|passingYards":   "one of the softest defenses against the pass — they allow the most passing yards per game",
                                "nfl|rushingYards":   "one of the softest defenses against the run — they allow the most rushing yards per game",
                                "nfl|receivingYards": "one of the softest defenses in coverage — they allow the most receiving yards per game",
                                "nfl|touchdowns":     "one of the softest defenses in the red zone — they allow the most passing yards and TDs per game",
                              }[`${play.sport}|${play.stat}`] || "one of the weakest defenses for this stat";
                              {
                                const pf = play.parkFactor;
                                const parkNote = pf != null && Math.abs(pf - 1.0) >= 0.03
                                  ? <> Tonight's venue {pf > 1 ? "boosts" : "suppresses"} hit production ({pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}% park factor).</>
                                  : null;
                                const noH2h = play.softPct === null
                                  ? <>
                                      {" "}No head-to-head history vs {opp} yet —{" "}
                                      {first} has hit {play.threshold}+ {STAT_FULL[play.stat] || play.stat} in <span style={{color:"#3fb950",fontWeight:600}}>{play.seasonPct}%</span> of his {play.pct26 != null ? play.pct26Games : (play.blendGames || play.seasonGames)} games {play.pct26 != null ? "this season" : "in 2025-26"}.
                                      {play.pct25 != null && play.pct25Games >= 5 && <> He was at {play.pct25}% in {play.pct25Games} games in 2025.</>}
                                      {parkNote}
                                    </>
                                  : <> {first} has hit {play.threshold}+ {STAT_FULL[play.stat] || play.stat} in {hitRate} of games vs weak matchups{games}.{parkNote}</>;
                                return <>{opp} ranks {rank} in {play.oppMetricLabel || "this stat"}{metricStr} this season — {context}.{noH2h}</>;
                              }
                            })()}
                          </div>
                        )}
                  </div>
                </div>
              );
            })}
            </div>
          ));
        })()}
        </div>
  );
}

export default PlaysColumn;
