import React from 'react';
import { STAT_LABEL, STAT_FULL, MLB_TEAM } from '../lib/constants.js';
import { ordinal, logoUrl } from '../lib/utils.js';
import { tierColor } from '../lib/colors.js';
import SimBadge from './SimBadge.jsx';

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
              const playKey = play.gameType === "teamTotal"
                ? `teamtotal-${play.sport}-${play.scoringTeam}-${play.oppTeam}-${play.threshold}${play.direction === "under" ? "-under" : ""}`
                : play.gameType === "total"
                ? `total-${play.sport}-${play.homeTeam}-${play.awayTeam}-${play.threshold}${play.direction === "under" ? "-under" : ""}`
                : `${play.playerName}-${play.stat}-${play.threshold}`;
              const oddsStr = play.americanOdds >= 0 ? `+${play.americanOdds}` : `${play.americanOdds}`;
              const isExpanded = expandedPlays.has(playKey);
              const trackId = play.gameType === "teamTotal"
                ? `teamtotal|${play.sport}|${play.scoringTeam}|${play.oppTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
                : play.gameType === "total"
                ? `total|${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
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
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                          <img src={logoUrl(play.sport, play.scoringTeam)} alt={play.scoringTeam}
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
                        <span style={{background:isUnder?"rgba(247,129,102,0.12)":"rgba(88,166,255,0.12)",border:`1px solid ${isUnder?"#f78166":"#58a6ff"}`,
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:isUnder?"#f78166":"#58a6ff",fontWeight:700,whiteSpace:"nowrap"}}>
                          {isUnder ? "Under" : "Over"} {lineVal} {tLabel}
                        </span>
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
                    {/* Explanation prose */}
                    <div style={{marginTop:4}}>
                      {play.sport === "mlb" && (() => {
                        const _ssnPts = isUnder ? (play.ttSeasonHitRate == null ? 1 : play.ttSeasonHitRate <= 20 ? 2 : play.ttSeasonHitRate <= 40 ? 1 : 0) : (play.ttSeasonHitRatePts ?? 1);
                        const _whipPts = play.ttWhipPts ?? 1;
                        const _l10Pts = play.ttL10Pts ?? 1;
                        const _h2hPts = play.h2hHitRatePts ?? 1;
                        const _ouPts = play.gameOuLine == null ? 1 : isUnder ? (play.gameOuLine < 7.5 ? 2 : play.gameOuLine < 9.5 ? 1 : 0) : (play.gameOuLine >= 9.5 ? 2 : play.gameOuLine >= 7.5 ? 1 : 0);
                        const ssnRate = play.ttSeasonHitRate ?? null;
                        const ssnColor = _ssnPts === 2 ? "#3fb950" : _ssnPts === 1 ? "#e3b341" : "#f78166";
                        const ssnDesc = ssnRate == null ? null : isUnder ? (ssnRate <= 20 ? "rarely scores this many" : ssnRate <= 40 ? "sometimes scores here" : "hits this mark often — under risk") : (ssnRate >= 80 ? "hits this mark consistently" : ssnRate >= 60 ? "reaches this most games" : "below threshold often");
                        const whipColor = play.oppWHIP == null ? "#8b949e" : isUnder ? (play.oppWHIP <= 1.10 ? "#3fb950" : play.oppWHIP <= 1.25 ? "#e3b341" : "#f78166") : (play.oppWHIP > 1.35 ? "#3fb950" : play.oppWHIP > 1.20 ? "#e3b341" : "#f78166");
                        const whipDesc = play.oppWHIP == null ? null : isUnder ? (play.oppWHIP <= 1.10 ? "elite control" : play.oppWHIP <= 1.25 ? "solid control" : "a lot of baserunners — under risk") : (play.oppWHIP > 1.35 ? "a lot of baserunners" : play.oppWHIP > 1.20 ? "some traffic on base" : "tough matchup");
                        const l10Color = _l10Pts === 2 ? "#3fb950" : _l10Pts === 1 ? "#e3b341" : "#8b949e";
                        const l10Desc = play.teamL10RPG == null ? null : isUnder ? (play.teamL10RPG <= 3.5 ? "cold offense recently" : play.teamL10RPG <= 4.5 ? "moderate recent offense" : "active lineup recently — under risk") : (play.teamL10RPG > 5.0 ? "hot offense recently" : play.teamL10RPG > 4.0 ? "solid recent production" : "below-average recent offense");
                        const ouColor = play.gameOuLine == null ? "#8b949e" : isUnder ? (play.gameOuLine < 7.5 ? "#3fb950" : play.gameOuLine < 9.5 ? "#e3b341" : "#f78166") : (play.gameOuLine >= 9.5 ? "#3fb950" : play.gameOuLine >= 7.5 ? "#e3b341" : "#f78166");
                        const ouDesc = play.gameOuLine == null ? null : isUnder ? (play.gameOuLine < 7.5 ? "a low total" : play.gameOuLine < 9.5 ? "an average total" : "a high total — under risk") : (play.gameOuLine >= 9.5 ? "a high-scoring game" : play.gameOuLine >= 7.5 ? "an average total" : "a pitcher's duel");
                        const etColor = play.teamExpected == null ? "#8b949e" : isUnder ? (play.teamExpected <= play.threshold - 1.5 ? "#3fb950" : play.teamExpected <= play.threshold + 0.5 ? "#e3b341" : "#8b949e") : (play.teamExpected >= play.threshold + 1.5 ? "#3fb950" : play.teamExpected >= play.threshold - 0.5 ? "#e3b341" : "#8b949e");
                        const h2hColor = play.h2hHitRate == null ? "#8b949e" : isUnder ? (play.h2hHitRate <= 30 ? "#3fb950" : play.h2hHitRate <= 50 ? "#e3b341" : "#f78166") : (play.h2hHitRate >= 80 ? "#3fb950" : play.h2hHitRate >= 60 ? "#e3b341" : "#f78166");
                        const scTitle = [isUnder?"[Under SimScore]":null,`Ssn HR% (${ssnRate != null ? ssnRate.toFixed(0)+"%" : "—"}): ${_ssnPts}/2`,`Opp WHIP (${play.oppWHIP?.toFixed(2) ?? "—"}): ${_whipPts}/2`,`L10 RPG (${play.teamL10RPG?.toFixed(1) ?? "—"}): ${_l10Pts}/2`,`H2H HR% (${play.h2hHitRate?.toFixed(0) ?? "—"}%): ${_h2hPts}/2`,`O/U (${play.gameOuLine ?? "—"}): ${_ouPts}/2`].filter(Boolean).join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            {ssnRate != null && <><span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span>{" "}<span style={{color:"#8b949e"}}>{isUnder ? `has stayed under ${lineVal} in` : `has scored ${lineVal}+ in`}</span>{" "}<span style={{color:ssnColor,fontWeight:600}}>{isUnder ? (100 - ssnRate).toFixed(0) : ssnRate.toFixed(0)}%</span>{" "}<span style={{color:"#8b949e"}}>of games this season{ssnDesc ? ` — ${ssnDesc}` : ""}.</span>{" "}</>}
                            <span style={{color:"#8b949e"}}>Facing a</span>{" "}<span style={{color:"#c9d1d9"}}>{play.oppTeam}</span>{" "}<span style={{color:"#8b949e"}}>starter</span>{play.oppWHIP != null ? <>{" "}<span style={{color:"#8b949e"}}>with</span>{" "}<span style={{color:whipColor,fontWeight:600}}>{play.oppWHIP.toFixed(2)} WHIP</span>{whipDesc ? <span style={{color:"#8b949e"}}>{" — "}{whipDesc}</span> : ""}</> : ""}.{" "}
                            {play.teamL10RPG != null && <><span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span>{" "}<span style={{color:"#8b949e"}}>averages</span>{" "}<span style={{color:l10Color,fontWeight:600}}>{play.teamL10RPG.toFixed(1)}</span>{" "}<span style={{color:"#8b949e"}}>runs/game over their last 10 games{l10Desc ? ` — ${l10Desc}` : ""}.</span>{" "}</>}
                            {play.h2hHitRate != null && <><span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span>{" "}<span style={{color:"#8b949e"}}>{isUnder ? `has stayed under ${lineVal} in` : `has scored ${lineVal}+ in`}</span>{" "}<span style={{color:h2hColor,fontWeight:600}}>{isUnder ? (100 - play.h2hHitRate).toFixed(0) : play.h2hHitRate.toFixed(0)}%</span>{" "}<span style={{color:"#8b949e"}}>of last {play.h2hGames}g H2H meetings.</span>{" "}</>}
                            {play.gameOuLine != null && <><span style={{color:"#8b949e"}}>Game total</span>{" "}<span style={{color:ouColor,fontWeight:600}}>{play.gameOuLine}</span>{ouDesc ? <span style={{color:"#8b949e"}}>{" — "}{ouDesc}</span> : ""}.</>}
                            {play.teamExpected != null && <>{" "}<span style={{color:"#8b949e"}}>Model projects</span>{" "}<span style={{color:etColor,fontWeight:600}}>{play.teamExpected}</span>{" "}<span style={{color:"#8b949e"}}>{isUnder ? `expected runs — under the ${lineVal} line.` : `expected runs vs the ${lineVal} line.`}</span></>}
                            {" "}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
                          </div>
                        );
                      })()}
                      {play.sport === "nba" && (() => {
                        const rtgColor = v => v == null ? "#8b949e" : isUnder ? (v < 113 ? "#3fb950" : v < 118 ? "#e3b341" : "#f78166") : (v >= 118 ? "#3fb950" : v >= 113 ? "#e3b341" : "#f78166");
                        const offRtg = play.teamOffRtg ?? null, defRtg = play.oppDefRtg ?? null;
                        const offDesc = offRtg == null ? null : isUnder ? (offRtg < 113 ? "a low-scoring offense" : offRtg < 118 ? "a moderate offense" : "a high-scoring offense — under risk") : (offRtg >= 118 ? "an elite offense" : offRtg >= 113 ? "an above-average offense" : "an average offense");
                        const defDesc = defRtg == null ? null : isUnder ? (defRtg < 113 ? "an elite defense" : defRtg < 118 ? "a solid defense" : "a weak defense — under risk") : (defRtg >= 118 ? "one of the weakest defenses in the league" : defRtg >= 113 ? "a below-average defense" : "a solid defense");
                        const ssnHR = play.ttNbaSeasonHitRate ?? null;
                        const ssnColor = ssnHR == null ? "#8b949e" : isUnder ? (ssnHR <= 20 ? "#3fb950" : ssnHR <= 40 ? "#e3b341" : "#f78166") : (ssnHR >= 80 ? "#3fb950" : ssnHR >= 60 ? "#e3b341" : "#f78166");
                        const ouDesc2 = play.gameOuLine == null ? null : isUnder ? (play.gameOuLine < 215 ? "a low-total game" : play.gameOuLine < 225 ? "a moderate total" : "a high-total game — under risk") : (play.gameOuLine >= 225 ? "a fast-paced game" : play.gameOuLine >= 215 ? "an above-average total" : "a low-total game");
                        const etColor = play.teamExpected == null ? "#8b949e" : isUnder ? (play.teamExpected <= play.threshold - 5 ? "#3fb950" : play.teamExpected <= play.threshold + 5 ? "#e3b341" : "#8b949e") : (play.teamExpected >= play.threshold + 5 ? "#3fb950" : play.teamExpected >= play.threshold - 5 ? "#e3b341" : "#8b949e");
                        const h2hColor = play.h2hHitRate == null ? "#8b949e" : isUnder ? (play.h2hHitRate <= 30 ? "#3fb950" : play.h2hHitRate <= 50 ? "#e3b341" : "#f78166") : (play.h2hHitRate >= 80 ? "#3fb950" : play.h2hHitRate >= 60 ? "#e3b341" : "#f78166");
                        const _offPts = offRtg == null ? 1 : isUnder ? (offRtg < 113 ? 2 : offRtg < 118 ? 1 : 0) : (offRtg >= 118 ? 2 : offRtg >= 113 ? 1 : 0);
                        const _defPts = defRtg == null ? 1 : isUnder ? (defRtg < 113 ? 2 : defRtg < 118 ? 1 : 0) : (defRtg >= 118 ? 2 : defRtg >= 113 ? 1 : 0);
                        const _ssnPts = play.ttNbaSeasonHitRatePts ?? (ssnHR == null ? 1 : isUnder ? (ssnHR <= 20 ? 2 : ssnHR <= 40 ? 1 : 0) : (ssnHR >= 80 ? 2 : ssnHR >= 60 ? 1 : 0));
                        const _h2hPts2 = play.h2hHitRatePts ?? 1;
                        const _ouPts2 = isUnder ? (play.gameOuLine == null ? 1 : play.gameOuLine < 215 ? 2 : play.gameOuLine < 225 ? 1 : 0) : (play.gameOuLine == null ? 1 : play.gameOuLine >= 225 ? 2 : play.gameOuLine >= 215 ? 1 : 0);
                        const scTitle = [`${isUnder?"[Under SimScore]\n":""}OffRtg (${offRtg?.toFixed(1) ?? "—"}): ${_offPts}/2`,`Opp DefRtg (${defRtg?.toFixed(1) ?? "—"}): ${_defPts}/2`,`Ssn HR% (${ssnHR != null ? ssnHR + "%" : "—"}): ${_ssnPts}/2`,`H2H HR% (${play.h2hHitRate?.toFixed(0) ?? "—"}%): ${_h2hPts2}/2`,`O/U (${play.gameOuLine ?? "—"}): ${_ouPts2}/2`].join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> offensive rating{offRtg != null ? <> <span style={{color:rtgColor(offRtg),fontWeight:600}}>{offRtg.toFixed(1)}</span></> : " —"}{offDesc ? <> — <span style={{color:"#8b949e"}}>{offDesc}</span></> : null}.{" "}
                            The <span style={{color:"#c9d1d9"}}>{play.oppTeam}</span> defensive rating{defRtg != null ? <> <span style={{color:rtgColor(defRtg),fontWeight:600}}>{defRtg.toFixed(1)}</span></> : " —"}{defDesc ? <> — <span style={{color:"#8b949e"}}>{defDesc}</span></> : null}.
                            {ssnHR != null && <>{" "}<span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span>{" "}<span style={{color:"#8b949e"}}>{isUnder ? `has stayed under ${lineVal} in` : `has hit ${lineVal}+ in`}</span>{" "}<span style={{color:ssnColor,fontWeight:600}}>{ssnHR}%</span>{" "}<span style={{color:"#8b949e"}}>of games this season.</span></>}
                            {play.h2hHitRate != null ? <>{" "}<span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> <span style={{color:"#8b949e"}}>{isUnder ? `has stayed under ${lineVal} pts in` : `has scored ${lineVal}+ pts in`}</span> <span style={{color:h2hColor,fontWeight:600}}>{isUnder ? (100 - play.h2hHitRate).toFixed(0) : play.h2hHitRate.toFixed(0)}%</span> <span style={{color:"#8b949e"}}>of their last {play.h2hGames}g H2H meetings.</span></> : null}
                            {play.gameOuLine != null && <>{" "}<span style={{color:"#8b949e"}}>Game total</span> <span style={{color:isUnder ? (play.gameOuLine < 215 ? "#3fb950" : play.gameOuLine < 225 ? "#e3b341" : "#f78166") : (play.gameOuLine >= 225 ? "#3fb950" : play.gameOuLine >= 215 ? "#e3b341" : "#8b949e"),fontWeight:600}}>{play.gameOuLine}</span>{ouDesc2 ? <> — <span style={{color:"#8b949e"}}>{ouDesc2}</span></> : null}.</>}
                            {play.teamExpected != null && <>{" "}<span style={{color:"#8b949e"}}>Model projects</span> <span style={{color:etColor,fontWeight:600}}>{play.teamExpected}</span> <span style={{color:"#8b949e"}}>{isUnder ? `pts — under the ${lineVal} line.` : `pts vs the ${lineVal} line.`}</span></>}
                            {" "}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
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
                const tLabel = { totalRuns:"Runs", totalPoints:"Pts", totalGoals:"Goals" }[play.stat] || play.stat;
                const lineVal = (play.threshold - 0.5).toFixed(1);
                const tTrueOdds = displayTruePct >= 100 ? -99999 : (displayTruePct >= 50 ? Math.round(-(displayTruePct/(100-displayTruePct))*100) : Math.round((100-displayTruePct)/displayTruePct*100));
                const tTrueOddsStr = tTrueOdds > 0 ? `+${tTrueOdds}` : `${tTrueOdds}`;
                return (
                  <div key={playKey}
                    style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,
                      padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                    onMouseEnter={e => e.currentTarget.style.borderColor="#58a6ff"}
                    onMouseLeave={e => e.currentTarget.style.borderColor="#30363d"}>
                    {/* Header */}
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      {/* Matchup info */}
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                          <img src={logoUrl(play.sport, play.awayTeam)} alt={play.awayTeam} onClick={e=>{e.stopPropagation();navigateToTeam(play.awayTeam,play.sport);}}
                            style={{width:44,height:44,objectFit:"contain",background:"#21262d",borderRadius:6,padding:2,flexShrink:0,cursor:"pointer"}}
                            onError={e=>e.target.style.display="none"}/>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.awayTeam,play.sport);}}
                            style={{color:"#c9d1d9",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.awayTeam}</span>
                          <span style={{color:"#484f58",fontSize:11}}>@</span>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.homeTeam,play.sport);}}
                            style={{color:"#c9d1d9",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.homeTeam}</span>
                          <img src={logoUrl(play.sport, play.homeTeam)} alt={play.homeTeam} onClick={e=>{e.stopPropagation();navigateToTeam(play.homeTeam,play.sport);}}
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
                        const combinedRPG = play.combinedRPG ?? null;
                        const hWHIP = play.homeWHIP ?? null, aWHIP = play.awayWHIP ?? null;
                        const h2hTR = play.h2hTotalHitRate ?? null, h2hTRGames = play.h2hTotalGames ?? null;
                        const whipColor = v => v == null ? "#8b949e" : isUnder ? (v <= 1.10 ? "#3fb950" : v <= 1.25 ? "#e3b341" : "#f78166") : (v > 1.35 ? "#3fb950" : v > 1.20 ? "#e3b341" : "#f78166");
                        const whipDesc = (v, under) => v == null ? null : under ? (v <= 1.10 ? "stingy control" : v <= 1.25 ? "solid control" : "gives up baserunners") : (v > 1.35 ? "hittable" : v > 1.20 ? "some traffic" : null);
                        const _cRPGPts = combinedRPG == null ? 1 : combinedRPG >= 10.5 ? 2 : combinedRPG >= 9.0 ? 1 : 0;
                        const _hWHIPPts = hWHIP == null ? 1 : hWHIP > 1.35 ? 2 : hWHIP > 1.20 ? 1 : 0;
                        const _aWHIPPts = aWHIP == null ? 1 : aWHIP > 1.35 ? 2 : aWHIP > 1.20 ? 1 : 0;
                        const _h2hTRPts = h2hTR == null ? 1 : h2hTR >= 80 ? 2 : h2hTR >= 60 ? 1 : 0;
                        const scTitle = [isUnder?"[Under SimScore]":null,`${play.homeTeam} WHIP (${hWHIP != null ? hWHIP.toFixed(2) : "—"}): ${_hWHIPPts}/2`,`${play.awayTeam} WHIP (${aWHIP != null ? aWHIP.toFixed(2) : "—"}): ${_aWHIPPts}/2`,`Comb road RPG (${combinedRPG != null ? combinedRPG.toFixed(1) : "—"}): ${_cRPGPts}/2`,`H2H HR% (${h2hTR != null ? h2hTR+"%" : "—"}): ${_h2hTRPts}/2`,`O/U (${gameOuLine != null ? gameOuLine : "—"}): ${mlbOuPts}/2`].filter(Boolean).join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.homeTeam}</span>{" "}<span style={{color:"#8b949e"}}>starter has</span>{hWHIP != null ? <>{" "}<span style={{color:whipColor(hWHIP),fontWeight:600}}>{hWHIP.toFixed(2)} WHIP</span>{whipDesc(hWHIP,isUnder) ? <span style={{color:"#8b949e"}}>{" — "}{whipDesc(hWHIP,isUnder)}</span> : ""}</> : <>{" — WHIP"}</>}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.awayTeam}</span>{" "}<span style={{color:"#8b949e"}}>starter has</span>{aWHIP != null ? <>{" "}<span style={{color:whipColor(aWHIP),fontWeight:600}}>{aWHIP.toFixed(2)} WHIP</span>{whipDesc(aWHIP,isUnder) ? <span style={{color:"#8b949e"}}>{" — "}{whipDesc(aWHIP,isUnder)}</span> : ""}</> : <>{" — WHIP"}</>}.
                            {combinedRPG != null && <>{" "}<span style={{color:"#8b949e"}}>Combined road scoring:</span>{" "}<span style={{color:isUnder?(combinedRPG<=8.5?"#3fb950":combinedRPG<=10.0?"#e3b341":"#f78166"):(combinedRPG>=10.5?"#3fb950":combinedRPG>=9.0?"#e3b341":"#f78166"),fontWeight:600}}>{combinedRPG.toFixed(1)} runs/game</span><span style={{color:"#8b949e"}}>{isUnder?(combinedRPG<=8.5?" — low combined offense":combinedRPG<=10.0?" — moderate scoring":" — high combined offense"):(combinedRPG>=10.5?" — high combined offense":combinedRPG>=9.0?" — above-average scoring":" — below-average offense")}.</span></>}
                            {h2hTR != null && <>{" "}<span style={{color:"#8b949e"}}>Combined totals {isUnder?"stayed under":"hit"}</span>{" "}<span style={{color:isUnder?((100-h2hTR)>=80?"#3fb950":(100-h2hTR)>=60?"#e3b341":"#f78166"):(h2hTR>=80?"#3fb950":h2hTR>=60?"#e3b341":"#f78166"),fontWeight:600}}>{isUnder?(100-h2hTR).toFixed(0):h2hTR.toFixed(0)}%</span>{" "}<span style={{color:"#8b949e"}}>of last {h2hTRGames}g H2H meetings.</span></>}
                            {gameOuLine != null && <>{" "}<span style={{color:"#8b949e"}}>Game total</span>{" "}<span style={{color:ouColor,fontWeight:600}}>{gameOuLine}</span>{ouDesc ? <span style={{color:"#8b949e"}}>{" — "}{ouDesc}.</span> : "."}</>}
                            {Math.abs(pf - 1) > 0.01 && <>{" "}<span style={{color:"#8b949e"}}>Tonight's park {pf > 1 ? "inflates run scoring" : "suppresses run scoring"} (</span><span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}%</span><span style={{color:"#8b949e"}}>).</span></>}
                            {et != null && <>{" "}<span style={{color:"#8b949e"}}>Model projects</span>{" "}<span style={{color:etColor,fontWeight:600}}>{et}</span>{" "}<span style={{color:"#8b949e"}}>{isUnder?`combined runs — under the ${lineVal} threshold.`:`combined runs vs the ${lineVal} threshold.`}</span></>}
                            {" "}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
                          </div>
                        );
                      })()}
                      {/* NBA Total */}
                      {play.sport === "nba" && (() => {
                        const sc = play.totalSimScore;
                        const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                        const combOffRtg = play.combOffRtg ?? null, combDefRtg = play.combDefRtg ?? null;
                        const hPace = play.homePace ?? null, aPace = play.awayPace ?? null;
                        const lgPace = play.leagueAvgPace ?? null;
                        const projPace = play.projPace ?? null;
                        const nbaGtH2HRate = play.nbaGtH2HRate ?? null;
                        const et = play.expectedTotal ?? null;
                        const paceAdj = projPace != null && lgPace != null ? parseFloat((projPace - lgPace).toFixed(1)) : (hPace != null && aPace != null && lgPace != null ? parseFloat(((hPace + aPace) / 2 - lgPace).toFixed(1)) : null);
                        const rtgColor = isUnder
                          ? (v => v == null ? "#8b949e" : v < 113 ? "#3fb950" : v < 118 ? "#e3b341" : "#8b949e")
                          : (v => v == null ? "#8b949e" : v >= 118 ? "#3fb950" : v >= 113 ? "#e3b341" : "#8b949e");
                        const paceColor = isUnder
                          ? (paceAdj == null ? "#8b949e" : paceAdj < -2 ? "#3fb950" : paceAdj < 0 ? "#e3b341" : "#8b949e")
                          : (paceAdj == null ? "#8b949e" : paceAdj > 0 ? "#3fb950" : paceAdj > -2 ? "#e3b341" : "#8b949e");
                        const h2hColor = nbaGtH2HRate == null ? "#8b949e" : isUnder ? (nbaGtH2HRate <= 30 ? "#3fb950" : nbaGtH2HRate <= 50 ? "#e3b341" : "#f78166") : (nbaGtH2HRate >= 80 ? "#3fb950" : nbaGtH2HRate >= 60 ? "#e3b341" : "#f78166");
                        const etColor = isUnder
                          ? (et == null ? "#8b949e" : et < play.threshold - 2 ? "#3fb950" : et < play.threshold + 2 ? "#e3b341" : "#8b949e")
                          : (et == null ? "#8b949e" : et >= play.threshold + 2 ? "#3fb950" : et >= play.threshold - 2 ? "#e3b341" : "#8b949e");
                        const nbaOuLinePC = play.gameOuLine ?? null;
                        const nbaOuPtsPC = nbaOuLinePC == null ? 1 : nbaOuLinePC >= 225 ? 2 : nbaOuLinePC >= 215 ? 1 : 0;
                        const _pacePts = (hPace == null || aPace == null || lgPace == null) ? 1 : (hPace > lgPace + 2 && aPace > lgPace + 2) ? 2 : (hPace > lgPace || aPace > lgPace) ? 1 : 0;
                        const _gtH2HPts = nbaGtH2HRate == null ? 1 : nbaGtH2HRate >= 80 ? 2 : nbaGtH2HRate >= 60 ? 1 : 0;
                        const _cOffPts = combOffRtg == null ? 1 : combOffRtg >= 118 ? 2 : combOffRtg >= 113 ? 1 : 0;
                        const _cDefPts = combDefRtg == null ? 1 : combDefRtg >= 118 ? 2 : combDefRtg >= 113 ? 1 : 0;
                        const scTitle = [isUnder?"[Under SimScore]":"",`Pace (${projPace ?? "—"}): ${_pacePts}/2`,`Comb OffRtg (${combOffRtg != null ? combOffRtg.toFixed(1) : "—"}): ${_cOffPts}/2`,`Comb DefRtg (${combDefRtg != null ? combDefRtg.toFixed(1) : "—"}): ${_cDefPts}/2`,`H2H HR% (${nbaGtH2HRate != null ? nbaGtH2HRate + "%" : "—"}): ${_gtH2HPts}/2`,`O/U (${nbaOuLinePC ?? "—"}): ${nbaOuPtsPC}/2`].filter(Boolean).join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            {paceAdj != null ? <><span style={{color:"#8b949e"}}>Projected game pace</span>{" "}<span style={{color:paceColor,fontWeight:600}}>{paceAdj > 0 ? "+" : ""}{paceAdj}</span>{" "}<span style={{color:"#8b949e"}}>vs league avg{isUnder?(paceAdj<-2?" — slow game, fewer possessions":" — near average"):(paceAdj>0?" — fast game, more possessions":paceAdj>-2?" — near league average":" — slow game, fewer possessions")}.</span></> : <span style={{color:"#8b949e"}}>Pace unavailable.</span>}
                            {combOffRtg != null && <>{" "}<span style={{color:"#8b949e"}}>Combined offensive rating</span>{" "}<span style={{color:rtgColor(combOffRtg),fontWeight:600}}>{combOffRtg.toFixed(1)}</span>{isUnder?(combOffRtg<113?<span style={{color:"#8b949e"}}> — low-scoring offenses</span>:combOffRtg<118?<span style={{color:"#8b949e"}}> — moderate offenses</span>:<span style={{color:"#8b949e"}}> — high-powered offenses</span>):(combOffRtg>=118?<span style={{color:"#8b949e"}}> — elite combined offense</span>:combOffRtg>=113?<span style={{color:"#8b949e"}}> — above-average</span>:null)}.</>}
                            {combDefRtg != null && <>{" "}<span style={{color:"#8b949e"}}>Combined defensive rating</span>{" "}<span style={{color:rtgColor(combDefRtg),fontWeight:600}}>{combDefRtg.toFixed(1)}</span>{isUnder?(combDefRtg<113?<span style={{color:"#8b949e"}}> — tight defenses</span>:combDefRtg<118?<span style={{color:"#8b949e"}}> — moderate defenses</span>:<span style={{color:"#8b949e"}}> — weak defenses</span>):(combDefRtg>=118?<span style={{color:"#8b949e"}}> — weak combined defense</span>:combDefRtg>=113?<span style={{color:"#8b949e"}}> — below-average defense</span>:null)}.</>}
                            {nbaGtH2HRate != null && <>{" "}<span style={{color:"#8b949e"}}>Combined totals {isUnder?"stayed under":"hit"}</span>{" "}<span style={{color:h2hColor,fontWeight:600}}>{isUnder?(100-nbaGtH2HRate).toFixed(0):nbaGtH2HRate.toFixed(0)}%</span>{" "}<span style={{color:"#8b949e"}}>of recent H2H meetings.</span></>}
                            {nbaOuLinePC != null && <>{" "}<span style={{color:"#8b949e"}}>Game total</span>{" "}<span style={{color:isUnder?(nbaOuLinePC<225?"#3fb950":nbaOuLinePC<235?"#e3b341":"#f78166"):(nbaOuLinePC>=235?"#3fb950":nbaOuLinePC>=225?"#e3b341":"#8b949e"),fontWeight:600}}>{nbaOuLinePC}</span>{" "}<span style={{color:"#8b949e"}}>{isUnder?(nbaOuLinePC<225?"— a low-total game.":nbaOuLinePC<235?"— an average total.":"— a high-total game."):(nbaOuLinePC>=235?"— a fast-paced game.":nbaOuLinePC>=225?"— above-average scoring.":"— a low-total game.")}</span></>}
                            {et != null && <>{" "}<span style={{color:"#8b949e"}}>Model projects</span>{" "}<span style={{color:etColor,fontWeight:600}}>{et}</span>{" "}<span style={{color:"#8b949e"}}>{isUnder?`combined pts — under the ${lineVal} threshold.`:`combined pts vs the ${lineVal} threshold.`}</span></>}
                            {" "}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
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
                            <span style={{color:"#c9d1d9"}}>{play.homeTeam}</span>{" "}<span style={{color:"#8b949e"}}>averages</span>{hGPG != null ? <>{" "}<span style={{color:gpgColor(hGPG),fontWeight:600}}>{hGPG.toFixed(1)} GPG</span>{!isUnder&&hGPG>=3.5?<span style={{color:"#8b949e"}}> — high-scoring offense</span>:!isUnder&&hGPG>=3.0?<span style={{color:"#8b949e"}}> — above-average scoring</span>:isUnder&&hGPG<3.0?<span style={{color:"#8b949e"}}> — low-scoring offense</span>:""}</> : <>{" —"}</>}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.awayTeam}</span>{" "}<span style={{color:"#8b949e"}}>averages</span>{aGPG != null ? <>{" "}<span style={{color:gpgColor(aGPG),fontWeight:600}}>{aGPG.toFixed(1)} GPG</span>{!isUnder&&aGPG>=3.5?<span style={{color:"#8b949e"}}> — high-scoring offense</span>:!isUnder&&aGPG>=3.0?<span style={{color:"#8b949e"}}> — above-average scoring</span>:isUnder&&aGPG<3.0?<span style={{color:"#8b949e"}}> — low-scoring offense</span>:""}</> : <>{" —"}</>}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.homeTeam}</span>{" "}<span style={{color:"#8b949e"}}>defense allows</span>{hGAA != null ? <>{" "}<span style={{color:gaaColor(hGAA),fontWeight:600}}>{hGAA.toFixed(2)} GAA</span>{!isUnder&&hGAA>=3.5?<span style={{color:"#8b949e"}}> — weak defense</span>:!isUnder&&hGAA>=3.0?<span style={{color:"#8b949e"}}> — below-average defense</span>:isUnder&&hGAA<3.0?<span style={{color:"#8b949e"}}> — stingy defense</span>:""}</> : <>{" —"}</>}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.awayTeam}</span>{" "}<span style={{color:"#8b949e"}}>defense allows</span>{aGAA != null ? <>{" "}<span style={{color:gaaColor(aGAA),fontWeight:600}}>{aGAA.toFixed(2)} GAA</span>{!isUnder&&aGAA>=3.5?<span style={{color:"#8b949e"}}> — weak defense</span>:!isUnder&&aGAA>=3.0?<span style={{color:"#8b949e"}}> — below-average defense</span>:isUnder&&aGAA<3.0?<span style={{color:"#8b949e"}}> — stingy defense</span>:""}</> : <>{" —"}</>}.
                            {nhlOuLinePC != null && <>{" "}<span style={{color:"#8b949e"}}>Game total</span>{" "}<span style={{color:isUnder?(nhlOuLinePC<5.5?"#3fb950":nhlOuLinePC<7?"#e3b341":"#f78166"):(nhlOuLinePC>=7?"#3fb950":nhlOuLinePC>=5.5?"#e3b341":"#8b949e"),fontWeight:600}}>{nhlOuLinePC}</span>{" "}<span style={{color:"#8b949e"}}>{isUnder?(nhlOuLinePC<5.5?"— a low-total game.":nhlOuLinePC<7?"— an average total.":"— a high-scoring game."):(nhlOuLinePC>=7?"— a high-scoring game.":nhlOuLinePC>=5.5?"— an average total.":"— a low-total game.")}</span></>}
                            {et != null && <>{" "}<span style={{color:"#8b949e"}}>Model projects</span>{" "}<span style={{color:etColor,fontWeight:600}}>{et}</span>{" "}<span style={{color:"#8b949e"}}>{isUnder?`combined goals — under the ${lineVal} threshold.`:`combined goals vs the ${lineVal} threshold.`}</span></>}
                            {" "}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} />
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
                          const blendedHitRate = play.blendedHitRate ?? null;
                          const kHitRatePts = play.kHitRatePts ?? null;
                          const hitRateColor = kHitRatePts === 2 ? "#3fb950" : kHitRatePts === 1 ? "#e3b341" : kHitRatePts === 0 ? "#f78166" : "#8b949e";
                          const h2hHandRate = play.kH2HHandRate ?? null;
                          const h2hHandPts = play.kH2HHandPts ?? null;
                          const h2hHandMaj = play.kH2HHandMaj ?? null;
                          const h2hHandStarts = play.kH2HHandStarts ?? null;
                          const h2hHandColor = h2hHandPts === 2 ? "#3fb950" : h2hHandPts === 1 ? "#e3b341" : h2hHandPts === 0 ? "#f78166" : "#8b949e";
                          const scTitle = _sc != null ? [`CSW%/K%: ${play.kpctPts ?? 1}/2`,`Lineup K%: ${play.lkpPts ?? 1}/2`,`Hit Rate %: ${play.kHitRatePts ?? 1}/2`,`H2H Hand: ${play.kH2HHandPts ?? 1}/2`,`O/U: ${play.totalPts ?? 1}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first} has {pkpQual ? <>{pkpQual} </> : ""}swing-and-miss stuff{pkp != null && <> — <span style={{color:pkpColor,fontWeight:600}}>{pkp}% {pkpLabel}</span></>}{recK != null && <>{", "}<span style={{color:play.kTrendPts===2?"#3fb950":play.kTrendPts===0?"#f78166":"#e3b341",fontWeight:600}}>{recK.toFixed(1)}%</span>{" "}<span style={{color:"#8b949e"}}>recent{play.kTrendPts===2?" ↑":play.kTrendPts===0?" ↓":""}</span>{seaK!=null&&<span style={{color:"#484f58",fontSize:10}}> ({seaK.toFixed(1)}% season)</span>}</>}{ap != null && <>{", "}<span style={{color:"#8b949e"}}>avg {Math.round(ap)} pitches/start</span></>}.
                                {lkp != null && <>{" "}The <span style={{color:"#c9d1d9"}}>{oppName}</span> lineup strikes out at <span style={{color:lkpColor,fontWeight:600}}>{lkp}%</span>{handLabel}{isProjected ? <span style={{color:"#484f58",fontSize:10}}> (est.)</span> : ""}<span style={{color:"#8b949e"}}>{lkpDesc ? ` — ${lkpDesc}` : ""}.</span></>}
                                {blendedHitRate != null && <>{" "}<span style={{color:"#8b949e"}}>Hit rate at this line:</span>{" "}<span style={{color:hitRateColor,fontWeight:600}}>{blendedHitRate.toFixed(0)}%</span>{" "}<span style={{color:"#8b949e"}}>{kHitRatePts===2?"— consistently reaches this mark.":kHitRatePts===1?"— reaches this mark often.":"— struggles to reach this mark."}</span></>}
                                {h2hHandRate != null && <>{" "}<span style={{color:"#8b949e"}}>{h2hHandMaj?`vs ${h2hHandMaj}-heavy lineups:`:"Hand H2H:"}</span>{" "}<span style={{color:h2hHandColor,fontWeight:600}}>{h2hHandRate.toFixed(0)}% hit rate</span>{h2hHandStarts!=null&&<span style={{color:"#484f58",fontSize:10}}> ({h2hHandStarts} starts)</span>}{" "}<span style={{color:"#8b949e"}}>{h2hHandPts===2?"— strong vs this lineup type.":h2hHandPts===1?"— solid vs this lineup type.":"— struggles vs this lineup type."}</span></>}
                                {gameTotal != null && <>{" "}<span style={{color:"#8b949e"}}>Game total</span>{" "}<span style={{color:totalColor(gameTotal),fontWeight:600}}>{gameTotal}</span>{" "}<span style={{color:"#8b949e"}}>{gameTotal<=7.5?"— a low-scoring slate, favorable for strikeouts.":gameTotal<10.5?"— an average total.":"— a high-scoring total, tougher for Ks."}</span></>}
                                {pf != null && Math.abs(pf - 1.0) >= 0.01 && <>{" "}<span style={{color:"#8b949e"}}>Park factor: {pf > 1 ? "strikeout-friendly" : "suppresses Ks"} (</span><span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}%</span><span style={{color:"#8b949e"}}>).</span></>}
                                {_sc != null && <>{" "}<SimBadge sc={_sc} scTitle={scTitle} scColor={scColor} /></>}
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
                          const hitterOps = play.hitterOps ?? null;
                          const hitterOpsPts = play.hitterOpsPts ?? null;
                          const opsColor = hitterOpsPts === 2 ? "#3fb950" : hitterOpsPts === 1 ? "#e3b341" : hitterOpsPts === 0 ? "#f78166" : "#8b949e";
                          const opsDesc = hitterOpsPts === 2 ? "elite hitter" : hitterOpsPts === 1 ? "above-average producer" : hitterOpsPts === 0 ? "below-average OPS" : null;
                          const platoonPts = play.hitterPlatoonPts ?? null;
                          const pitcherHand = play.oppPitcherHand ?? null;
                          const isPlatoonFallback = play.hitterSoftLabel === "vs RHP" || play.hitterSoftLabel === "vs LHP";
                          const softRateColor = (play.hitterH2HSource === 'bvp' || play.hitterH2HSource === 'hand') && play.softPct != null
                            ? play.softPct >= 80 ? "#3fb950" : play.softPct >= 70 ? "#e3b341" : "#f78166"
                            : "#3fb950";
                          const scTitle = sc != null ? [`OPS: ${play.hitterOpsPts ?? 1}/2`,`WHIP: ${play.hitterWhipPts ?? 1}/2`,`Season HR: ${play.hitterSeasonHitRatePts ?? 1}/2`,`H2H HR: ${play.hitterH2HHitRatePts ?? 1}/2`,`O/U: ${play.hitterTotalPts ?? 1}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first}{lineupSpot != null && <>, batting <span style={{color:spotColor,fontWeight:600}}>#{lineupSpot}</span>{spotDesc ? <span style={{color:"#8b949e"}}> — {spotDesc}</span> : ""}</>}.{hitterOps != null && <>{" "}<span style={{color:"#8b949e"}}>OPS </span><span style={{color:opsColor,fontWeight:600}}>{hitterOps.toFixed(3)}</span>{opsDesc ? <span style={{color:"#8b949e"}}> — {opsDesc}</span> : ""}</>}
                                {(pitcherName || whip != null) && (
                                  <> Facing{pitcherName ? <> <span style={{color:"#c9d1d9",fontWeight:600}}>{pitcherName}</span>{ab ? <span style={{color:"#484f58",fontSize:10}}> ({ab} career AB)</span> : ""}</> : " the opposing starter"}{whip != null ? <> — WHIP <span style={{color:whipColor,fontWeight:600}}>{whip.toFixed(2)}</span>{whipDesc ? <span style={{color:"#8b949e"}}> ({whipDesc})</span> : ""}</> : ""}.</>
                                )}
                                {" "}{first} has gone {play.threshold}+ {statFull} in <span style={{color:seasonColor,fontWeight:600}}>{play.seasonPct}%</span> of games {seasonWindow}{seasonG ? <span style={{color:"#484f58",fontSize:10}}> ({seasonG}g)</span> : ""}.
                                {play.softPct != null && <>{" "}<span style={{color:softRateColor,fontWeight:600}}>{play.softPct}%</span>{" "}<span style={{color:"#8b949e"}}>{play.hitterSoftLabel ?? "against weak pitching matchups"}</span><span style={{color:"#484f58",fontSize:10}}>{isPlatoonFallback && play.hitterSplitBA != null ? ` (hits .${Math.round(play.hitterSplitBA*1000).toString().padStart(3,"0")} vs ${pitcherHand === "R" ? "RHP" : "LHP"})` : !isPlatoonFallback && play.softGames ? ` (${play.softGames}g)` : ""}</span><span style={{color:"#8b949e"}}>.</span></>}
                                {play.oppRank && play.softPct === null && (() => {
                                  const _opp2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{play.opponent}</span>;
                                  const _rank2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{ordinal(play.oppRank)}-worst</span>;
                                  const _metricStr2 = play.oppMetricValue ? ` (${play.oppMetricValue} ${play.oppMetricUnit || ""})` : "";
                                  const _ctx2 = {"mlb|hits":"one of the easiest pitching matchups in the league — their staff has a high ERA this season","mlb|hrr":"one of the easiest pitching matchups in the league — their staff allows hits, runs, and RBIs at a high rate"}[`${play.sport}|${play.stat}`] || "one of the weakest defenses for this stat";
                                  return <>{" "}{_opp2} ranks {_rank2} in {play.oppMetricLabel || "this stat"}{_metricStr2} this season — {_ctx2}.{<>{" "}No head-to-head history yet{play.pct25 != null && play.pct25Games >= 5 ? <> — was at <span style={{color:"#c9d1d9"}}>{play.pct25}%</span> in {play.pct25Games} games in 2025</> : ""}.</>}</>;
                                })()}
                                {pf != null && Math.abs(pf - 1.0) >= 0.03 && <>{" "}Tonight's venue is {pf > 1 ? "hitter-friendly" : "pitcher-friendly"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}% park factor</span>).</>}
                                {hitterGameTotal != null && <>{" "}<span style={{color:"#8b949e"}}>Game total </span><span style={{color:hitterTotalColor(hitterGameTotal),fontWeight:600}}>{hitterGameTotal}</span><span style={{color:"#8b949e"}}>{hitterGameTotal >= 9.5 ? " — a high-scoring game, favorable for hitting" : hitterGameTotal >= 7.5 ? " — an average total" : " — a low-scoring game, tougher for hitters"}.</span></>}
                                {!isPlatoonFallback && platoonPts === 2 && pitcherHand && (() => { const splitBA = play.hitterSplitBA; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#3fb950",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon edge.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon edge vs {handStr}.</span></>; })()}
                                {!isPlatoonFallback && platoonPts === 0 && pitcherHand && (() => { const splitBA = play.hitterSplitBA; const seasonBA = play.hitterBa; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#f78166",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon disadvantage{seasonBA != null ? <> (<span style={{color:"#c9d1d9"}}>.{Math.round(seasonBA*1000).toString().padStart(3,"0")}</span> season)</> : ""}.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon disadvantage vs {handStr}.</span></>; })()}
                                {sc != null && <>{" "}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} /></>}
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
                          const scTitle = sc != null ? [_c1Label,`DVP: ${_dvpPtsPC}/2`,`Season HR: ${_nbaSeasonHRPtsPC}/2`,`Tier HR: ${_nbaSoftHRPtsPC}/2`,`Pace+Total: ${_comboPtsPC}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {play.nbaOpportunity != null ? <>{first} averages <span style={{color:minColor,fontWeight:600}}>{play.nbaOpportunity.toFixed(0)} minutes</span> a night{minDesc ? <span style={{color:"#8b949e"}}> — {minDesc}</span> : ""}{play.stat === "assists" && play.nbaAvgAst != null ? <> (<span style={{color:play.nbaAvgAst>=7?"#3fb950":play.nbaAvgAst>=5?"#e3b341":"#f78166",fontWeight:600}}>{play.nbaAvgAst.toFixed(1)} APG</span>)</> : play.stat === "rebounds" && play.nbaAvgReb != null ? <> (<span style={{color:play.nbaAvgReb>=9?"#3fb950":play.nbaAvgReb>=7?"#e3b341":"#f78166",fontWeight:600}}>{play.nbaAvgReb.toFixed(1)} RPG</span>)</> : play.nbaUsage != null ? <> (<span style={{color:play.nbaUsage>=28?"#3fb950":play.nbaUsage>=22?"#e3b341":"#f78166",fontWeight:600}}>{play.nbaUsage.toFixed(0)}% USG</span>)</> : ""}.</> : null}
                                {" "}{first} hits this line in <span style={{color:seasonColor,fontWeight:600}}>{play.seasonPct}%</span> of games{play.seasonGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.seasonGames}g)</span> : ""}.
                                {displayRank != null && <>{" "}{play.opponent} has {rankDesc || `the ${ordinal(displayRank)}-worst defense`} in {statName} allowed{posName ? ` to ${posName}s` : ""}{displayValue != null ? <> — giving up <span style={{color:rankColor,fontWeight:600}}>{displayValue} per game</span></> : <>, ranked <span style={{color:rankColor,fontWeight:700}}>{ordinal(displayRank)}</span></>}.</>}
                                {play.softPct != null && <>{" "}{first} hits this in <span style={{color:play.softPct>=70?"#3fb950":play.softPct>=60?"#e3b341":"#f78166",fontWeight:600}}>{play.softPct}%</span> of games vs same-tier defenses{play.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.softGames}g)</span> : ""}.</>}
                                {play.nbaPaceAdj != null && <>{" "}Game pace is <span style={{color:paceColor,fontWeight:600}}>{play.nbaPaceAdj > 0 ? "+" : ""}{play.nbaPaceAdj}</span> possessions above average — {paceDesc}.</>}
                                {play.nbaGameTotal != null && <>{" "}Game total <span style={{color:play.nbaTotalPts>=3?"#3fb950":play.nbaTotalPts>=2?"#e3b341":play.nbaTotalPts>=1?"#8b949e":"#f78166",fontWeight:600}}>{play.nbaGameTotal}</span><span style={{color:"#8b949e"}}>{play.nbaGameTotal>=235?" — a high-scoring slate":play.nbaGameTotal>=225?" — above-average scoring":play.nbaGameTotal>=215?" — an average total":" — a low-scoring slate"}.</span></>}
                                {play.nbaBlowoutAdj != null && play.nbaBlowoutAdj < 0.99 && <>{" "}<span style={{color:"#f78166",fontWeight:600}}>Blowout risk</span> — large spread reduces model mean by {Math.round((1-play.nbaBlowoutAdj)*100)}%.</>}
                                {play.isB2B != null && <>{" "}{play.isB2B ? <><span style={{color:"#f78166",fontWeight:600}}>Back-to-back</span> — model applies a scoring reduction.</> : <>Fully rested tonight.</>}</>}
                                {sc != null && <>{" "}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} /></>}
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
                                {play.nhlOpportunity != null ? <>{first} averages <span style={{color:toiColor,fontWeight:600}}>{play.nhlOpportunity.toFixed(0)} min</span> of ice time{toiDesc ? <span style={{color:"#8b949e"}}> — {toiDesc}</span> : ""}.</> : null}
                                {" "}{first} hits this line in <span style={{color:seasonColor,fontWeight:600}}>{play.seasonPct}%</span> of games{play.seasonGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.seasonGames}g)</span> : ""}.
                                {play.oppRank != null && <>{" "}<span style={{color:"#c9d1d9"}}>{play.opponent}</span>{" "}<span style={{color:"#8b949e"}}>{rankDesc ? `has ${rankDesc} in goals against` : `ranks ${ordinal(play.oppRank)} in goals against`} — ranked</span>{" "}<span style={{color:rankColor,fontWeight:700}}>{ordinal(play.oppRank)}</span><span style={{color:"#8b949e"}}>.</span></>}
                                {play.softPct != null && <>{" "}{first} hits this in <span style={{color:play.softPct>=90?"#3fb950":play.softPct>=80?"#e3b341":"#f78166",fontWeight:600}}>{play.softPct}%</span>{" "}<span style={{color:"#8b949e"}}>vs weak defenses</span>{play.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.softGames}g)</span> : ""}<span style={{color:"#8b949e"}}>.</span></>}
                                {play.nhlGameTotal != null && <>{" "}<span style={{color:"#8b949e"}}>Game total</span>{" "}<span style={{color:_nhlTotalPtsPC===2?"#3fb950":_nhlTotalPtsPC===1?"#e3b341":"#8b949e",fontWeight:600}}>{play.nhlGameTotal}</span>{" "}<span style={{color:"#8b949e"}}>{play.nhlGameTotal>=7?"— a high-scoring game.":play.nhlGameTotal>=5.5?"— an average total.":"— a low-total game."}</span></>}
                                {play.isB2B != null && <>{" "}{play.isB2B ? <><span style={{color:"#f78166",fontWeight:600}}>Back-to-back</span><span style={{color:"#8b949e"}}> — model applies a fatigue reduction.</span></> : <><span style={{color:"#8b949e"}}>Fully rested tonight.</span></>}</>}
                                {sc != null && <>{" "}<SimBadge sc={sc} scTitle={scTitle} scColor={scColor} /></>}
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
