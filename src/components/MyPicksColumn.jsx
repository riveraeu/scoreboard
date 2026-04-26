import React from 'react';
import { SPORT_BADGE_COLOR, STAT_LABEL } from '../lib/constants.js';
import DayBar from './DayBar.jsx';
import AddPickModal from './AddPickModal.jsx';

function MyPicksColumn({ trackedPlays, setTrackedPlays, untrackPlay, navigateToTeam, navigateToPlay, calcOdds, setCalcOdds, bankroll, setBankroll, setPickUnits, chartGroupBy, setChartGroupBy, openPickWeeks, setOpenPickWeeks, openPickDays, setOpenPickDays, editPickId, setEditPickId, setPlayResult, setShowAddPick, oddsToProfit }) {
  return (
        <div id="my-picks">
        {/* Implied Probability Calculator */}
        {(() => {
          const raw = calcOdds.trim();
          const n = parseInt(raw, 10);
          let implied = null;
          if (!isNaN(n) && raw !== "" && raw !== "-" && raw !== "+") {
            if (n < 0) implied = Math.abs(n) / (Math.abs(n) + 100) * 100;
            else if (n > 0) implied = 100 / (n + 100) * 100;
          }
          const color = implied === null ? "#8b949e" : implied >= 70 ? "#3fb950" : implied >= 50 ? "#e3b341" : "#f78166";
          return (
            <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:10,
              padding:"12px 16px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:16}}>
              <span style={{color:"#8b949e",fontSize:12,whiteSpace:"nowrap"}}>Implied probability</span>
              <div style={{display:"flex",alignItems:"center",background:"#0d1117",border:"1px solid #30363d",
                borderRadius:7,overflow:"hidden",flex:"0 0 auto"}}>
                <input type="text" inputMode="numeric" placeholder="-110" value={calcOdds}
                  onChange={e => {
                    let v = e.target.value;
                    // Auto-prepend "-" if user types a bare number (no sign)
                    if (v.length > 0 && v[0] !== "-" && v[0] !== "+") v = "-" + v;
                    setCalcOdds(v);
                  }}
                  style={{background:"transparent",border:"none",outline:"none",color:"#c9d1d9",
                    fontSize:14,width:80,padding:"7px 10px",textAlign:"center"}}/>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
                {implied !== null && (
                  <div style={{flex:1,background:"#21262d",borderRadius:5,height:14,overflow:"hidden",minWidth:60}}>
                    <div style={{width:`${implied}%`,background:color,height:"100%",borderRadius:5,transition:"width 0.3s ease"}}/>
                  </div>
                )}
                <span style={{color,fontSize:18,fontWeight:700,minWidth:60,textAlign:"right"}}>
                  {implied !== null ? `${implied.toFixed(1)}%` : "—"}
                </span>
              </div>
            </div>
          );
        })()}
        {(() => {
        if (trackedPlays.length === 0) return null;
        const settled = trackedPlays.filter(p => p.result && p.result !== "dnp");
        const wons = settled.filter(p => p.result === "won").length;

        // P&L calculations (only won/lost picks, DNP excluded)
        let totalStaked = 0, totalPL = 0;
        settled.forEach(p => {
          const stake = p.units != null ? p.units : Math.abs(p.americanOdds || 0) / 10;
          totalStaked += stake;
          if (p.result === "won") totalPL += stake * oddsToProfit(p.americanOdds);
          else totalPL -= stake;
        });
        const roi = totalStaked > 0 ? (totalPL / totalStaked) * 100 : null;
        const plColor = totalPL > 0 ? "#3fb950" : totalPL < 0 ? "#f78166" : "#8b949e";
        const fmt = n => (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2);
        // Average odds across settled picks (average decimal odds → back to American)
        const oddsSettled = settled.filter(p => p.americanOdds != null);
        const avgDecOdds = oddsSettled.length > 0
          ? oddsSettled.reduce((s, p) => s + (p.americanOdds >= 0 ? p.americanOdds/100+1 : 100/Math.abs(p.americanOdds)+1), 0) / oddsSettled.length
          : null;
        const avgAmerican = avgDecOdds != null
          ? avgDecOdds >= 2 ? Math.round((avgDecOdds-1)*100) : Math.round(-100/(avgDecOdds-1))
          : null;
        const avgOddsStr = avgAmerican != null ? (avgAmerican >= 0 ? `+${avgAmerican}` : `${avgAmerican}`) : null;

        return (
          <div>
            {/* Header row */}
            <div style={{display:"flex",alignItems:"center",marginBottom:12,gap:8,flexWrap:"wrap"}}>
              <div style={{color:"#c9d1d9",fontSize:15,fontWeight:700}}>My Picks</div>
              <span style={{background:"#21262d",borderRadius:10,padding:"1px 8px",fontSize:11,color:"#8b949e"}}>
                {trackedPlays.length}
              </span>
              {(() => {
                const activeCount = trackedPlays.filter(p => !p.result).length;
                const finishedCount = trackedPlays.filter(p => p.result && p.result !== "dnp").length;
                return (
                  <span style={{fontSize:11,color:"#484f58"}}>
                    <span style={{color:"#3fb950"}}>{activeCount} active</span>
                    {" · "}
                    <span style={{color:"#8b949e"}}>{finishedCount} finished</span>
                  </span>
                );
              })()}
              <button onClick={() => setShowAddPick(true)}
                style={{fontSize:11,padding:"2px 10px",borderRadius:6,cursor:"pointer",
                  border:"1px solid #238636",background:"rgba(35,134,54,0.15)",color:"#3fb950",fontWeight:600}}>
                + Add
              </button>
              {/* Bankroll input */}
              <div style={{display:"flex",alignItems:"center",gap:6,marginLeft:"auto"}}>
                <span style={{color:"#484f58",fontSize:11}}>Bankroll</span>
                <div style={{display:"flex",alignItems:"center",background:"#0d1117",border:"1px solid #30363d",borderRadius:6,overflow:"hidden"}}>
                  <span style={{color:"#8b949e",fontSize:12,padding:"2px 6px 2px 8px"}}>$</span>
                  <input type="number" min="1" value={bankroll}
                    onChange={e => setBankroll(e.target.value)}
                    style={{background:"transparent",border:"none",outline:"none",color:"#c9d1d9",
                      fontSize:12,width:70,padding:"3px 6px 3px 0"}}/>
                </div>
              </div>
            </div>

            {/* P&L Summary */}
            {settled.length > 0 && (
              <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:10,padding:"12px 16px",marginBottom:12}}>
                <div style={{display:"flex",gap:20,flexWrap:"wrap",alignItems:"flex-start"}}>
                  <div>
                    <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Record</div>
                    <div style={{fontSize:13,fontWeight:700}}>
                      <span style={{color:"#3fb950"}}>{wons}W</span>
                      <span style={{color:"#484f58"}}> – </span>
                      <span style={{color:"#f78166"}}>{settled.length - wons}L</span>
                      <span style={{color:"#8b949e",fontSize:11,fontWeight:400,marginLeft:5}}>
                        ({((wons / settled.length) * 100).toFixed(0)}%)
                      </span>
                    </div>
                  </div>
                  <div>
                    <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Net P&L</div>
                    <div style={{color:plColor,fontSize:13,fontWeight:700}}>{fmt(totalPL)}</div>
                  </div>
                  {roi !== null && (
                    <div>
                      <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>ROI</div>
                      <div style={{color:plColor,fontSize:13,fontWeight:700}}>
                        {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                      </div>
                    </div>
                  )}
                  {avgOddsStr && (
                    <div>
                      <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Avg odds</div>
                      <div style={{color:"#c9d1d9",fontSize:13,fontWeight:700}}>{avgOddsStr}</div>
                    </div>
                  )}
                  <div style={{marginLeft:"auto"}}>
                    <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Group by</div>
                    <select value={chartGroupBy} onChange={e => setChartGroupBy(e.target.value)}
                      style={{background:"#0d1117",border:"1px solid #30363d",borderRadius:4,color:"#8b949e",fontSize:11,padding:"2px 6px",cursor:"pointer",outline:"none"}}>
                      <option value="day">Day</option>
                      <option value="week">Week</option>
                      <option value="month">Month</option>
                      <option value="year">Year</option>
                    </select>
                  </div>
                </div>
                {/* P&L bar chart */}
                {(() => {
                  const playsWithPL = [...trackedPlays]
                    .filter(p => p.result && p.result !== "dnp")
                    .sort((a, b) => (a.gameDate || "").localeCompare(b.gameDate || "") || a.trackedAt - b.trackedAt)
                    .map(p => {
                      const s = p.units != null ? p.units : Math.abs(p.americanOdds || 0) / 10;
                      const pl = p.result === "won" ? s * oddsToProfit(p.americanOdds) : -s;
                      const dateKey = p.gameDate || new Date(p.trackedAt).toISOString().slice(0,10);
                      const barLabel = p.gameType === "total"
                        ? `${p.awayTeam}@${p.homeTeam} O${(p.threshold-0.5).toFixed(1)}`
                        : `${p.playerName} ${p.threshold}+ ${p.stat?.toUpperCase?.() || ""}`.trim();
                      return { pl, dateKey, barLabel };
                    });
                  if (!playsWithPL.length) return null;
                  // Bucket key + label per groupBy
                  const toBucket = (dateKey) => {
                    const [yr, mo, dy] = dateKey.split("-").map(Number);
                    if (chartGroupBy === "month") return { key: `${yr}-${String(mo).padStart(2,"0")}`, label: new Date(yr, mo-1, 1).toLocaleDateString("en-US", { month:"short", year:"2-digit" }) };
                    if (chartGroupBy === "year")  return { key: `${yr}`, label: `${yr}` };
                    if (chartGroupBy === "week") {
                      const d = new Date(yr, mo-1, dy);
                      const dow = d.getDay(); // 0=Sun
                      const mon = new Date(d); mon.setDate(d.getDate() - ((dow + 6) % 7));
                      const wKey = mon.toISOString().slice(0,10);
                      const wLabel = mon.toLocaleDateString("en-US", { month:"short", day:"numeric" });
                      return { key: wKey, label: wLabel };
                    }
                    // day (default)
                    return { key: dateKey, label: new Date(yr, mo-1, dy).toLocaleDateString("en-US", { month:"short", day:"numeric" }) };
                  };
                  const bucketMap = {};
                  playsWithPL.forEach(p => {
                    const { key, label } = toBucket(p.dateKey);
                    if (!bucketMap[key]) bucketMap[key] = { key, label, pl: 0, wins: 0, losses: 0, plays: [] };
                    bucketMap[key].pl += p.pl;
                    if (p.pl > 0) bucketMap[key].wins += p.pl;
                    else if (p.pl < 0) bucketMap[key].losses += Math.abs(p.pl);
                    bucketMap[key].plays.push(p);
                  });
                  const days = Object.values(bucketMap).sort((a,b) => a.key.localeCompare(b.key));
                  const maxAbs = Math.max(...days.map(d => Math.max(d.wins, d.losses)), 0.01);
                  const HALF = 60;
                  const yMax = maxAbs;
                  const yTicks = [yMax, yMax/2, 0, -yMax/2, -yMax];
                  return (
                    <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #21262d"}}>
                      <div style={{display:"flex",gap:4}}>
                        {/* Y-axis labels */}
                        <div style={{display:"flex",flexDirection:"column",justifyContent:"space-between",height:HALF*2+20,paddingBottom:20,flexShrink:0}}>
                          {yTicks.map((v,i) => (
                            <div key={i} style={{color:"#484f58",fontSize:9,textAlign:"right",lineHeight:1}}>
                              {v >= 0 ? "+" : ""}${Math.abs(v).toFixed(v === 0 ? 0 : 1)}
                            </div>
                          ))}
                        </div>
                        {/* Bars + x-axis */}
                        <div style={{flex:1,display:"flex",flexDirection:"column"}}>
                          <div style={{position:"relative",height:HALF*2,display:"flex",gap:3,alignItems:"stretch"}}>
                            <div style={{position:"absolute",left:0,right:0,top:HALF,height:1,background:"#30363d",zIndex:1}}/>
                            {days.map((day, i) => (
                              <DayBar key={i} day={day} HALF={HALF} maxAbs={maxAbs} />
                            ))}
                          </div>
                          {/* X-axis labels */}
                          <div style={{display:"flex",gap:3,marginTop:3}}>
                            {days.map((day, i) => (
                              <div key={i} style={{flex:1,textAlign:"center",color:"#484f58",fontSize:8,lineHeight:1.2,overflow:"hidden"}}>
                                {day.label}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}


            {/* Pick cards — grouped by week → day, collapsible */}
            {(() => {
              const toWeekKey = dk => {
                const [yr, mo, dy] = dk.split("-").map(Number);
                const d = new Date(yr, mo-1, dy);
                const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
                return mon.toLocaleDateString("en-CA");
              };
              const sorted = [...trackedPlays].sort((a, b) => {
                const aDate = a.gameDate || new Date(a.trackedAt).toISOString().slice(0,10);
                const bDate = b.gameDate || new Date(b.trackedAt).toISOString().slice(0,10);
                if (bDate !== aDate) return bDate < aDate ? -1 : 1;
                const aOpen = !a.result, bOpen = !b.result;
                if (aOpen !== bOpen) return aOpen ? -1 : 1;
                return b.trackedAt - a.trackedAt;
              });
              // Group by week → day
              const weekOrder = []; const weekMap = {};
              sorted.forEach(pick => {
                const dk = pick.gameDate || new Date(pick.trackedAt).toISOString().slice(0,10);
                const wk = toWeekKey(dk);
                if (!weekMap[wk]) { weekMap[wk] = { wk, dayOrder: [], dayMap: {} }; weekOrder.push(weekMap[wk]); }
                const w = weekMap[wk];
                if (!w.dayMap[dk]) { w.dayMap[dk] = { dk, picks: [] }; w.dayOrder.push(w.dayMap[dk]); }
                w.dayMap[dk].picks.push(pick);
              });
              const todayKey = new Date().toLocaleDateString("en-CA");
              const yesterdayKey = (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toLocaleDateString("en-CA"); })();
              const toggleDay = dk => setOpenPickDays(prev => { const n = new Set(prev); n.has(dk) ? n.delete(dk) : n.add(dk); return n; });
              const toggleWeek = wk => setOpenPickWeeks(prev => { const n = new Set(prev); n.has(wk) ? n.delete(wk) : n.add(wk); return n; });
              const calcPL = picks => {
                const settled = picks.filter(p => p.result && p.result !== "dnp");
                if (!settled.length) return null;
                return settled.reduce((sum, p) => {
                  const s = p.units != null ? p.units : Math.abs(p.americanOdds || 0) / 10;
                  return sum + (p.result === "won" ? s * oddsToProfit(p.americanOdds) : -s);
                }, 0);
              };
              return weekOrder.map(({ wk, dayOrder }) => {
                const weekOpen = openPickWeeks.has(wk);
                const [wyr, wmo, wdy] = wk.split("-").map(Number);
                const weekLabel = "Week of " + new Date(wyr, wmo-1, wdy).toLocaleDateString("en-US", { month:"short", day:"numeric" });
                const allWeekPicks = dayOrder.flatMap(d => d.picks);
                const weekPL = calcPL(allWeekPicks);
                const weekActive = allWeekPicks.filter(p => !p.result).length;
                const weekPLColor = weekPL > 0 ? "#3fb950" : weekPL < 0 ? "#f78166" : "#8b949e";
                return (
                  <div key={wk} style={{marginBottom:8}}>
                    {/* Week header */}
                    <div onClick={() => toggleWeek(wk)}
                      style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",
                        background:"#161b22",border:"1px solid #30363d",borderRadius:weekOpen ? "8px 8px 0 0" : 8,
                        cursor:"pointer",userSelect:"none"}}>
                      <span style={{color:"#8b949e",fontSize:11,display:"inline-block",
                        transition:"transform 0.15s",transform:weekOpen?"rotate(90deg)":"rotate(0deg)"}}>▸</span>
                      <span style={{color:"#e6edf3",fontSize:12,fontWeight:700}}>{weekLabel}</span>
                      <span style={{background:"#21262d",borderRadius:8,padding:"0px 6px",fontSize:10,color:"#8b949e"}}>
                        {allWeekPicks.length}
                      </span>
                      {weekActive > 0 && <span style={{fontSize:10,color:"#3fb950"}}>{weekActive} active</span>}
                      {weekPL !== null && (
                        <span style={{marginLeft:"auto",fontSize:12,fontWeight:700,color:weekPLColor}}>
                          {weekPL >= 0 ? "+" : ""}${Math.abs(weekPL).toFixed(2)}
                        </span>
                      )}
                    </div>
                    {/* Day groups inside this week */}
                    {weekOpen && (
                      <div style={{border:"1px solid #30363d",borderTop:"none",borderRadius:"0 0 8px 8px",padding:"6px 6px 2px 6px"}}>
                        {dayOrder.map(({ dk, picks: dayPicks }) => {
                          const dayOpen = openPickDays.has(dk);
                          const [yr, mo, dy] = dk.split("-").map(Number);
                          const dayLabel = dk === todayKey ? "Today" : dk === yesterdayKey ? "Yesterday"
                            : new Date(yr, mo-1, dy).toLocaleDateString("en-US", { month:"short", day:"numeric" });
                          const dayPL = calcPL(dayPicks);
                          const dayPLColor = dayPL > 0 ? "#3fb950" : dayPL < 0 ? "#f78166" : "#8b949e";
                          const dayActive = dayPicks.filter(p => !p.result).length;
                          return (
                            <div key={dk} style={{marginBottom:4}}>
                              {/* Day header */}
                              <div onClick={() => toggleDay(dk)}
                                style={{display:"flex",alignItems:"center",gap:8,padding:"5px 10px",
                                  background:"#0d1117",border:"1px solid #21262d",borderRadius:dayOpen ? "6px 6px 0 0" : 6,
                                  cursor:"pointer",userSelect:"none"}}>
                                <span style={{color:"#484f58",fontSize:10,display:"inline-block",
                                  transition:"transform 0.15s",transform:dayOpen?"rotate(90deg)":"rotate(0deg)"}}>▸</span>
                                <span style={{color:"#c9d1d9",fontSize:11,fontWeight:600}}>{dayLabel}</span>
                                <span style={{background:"#21262d",borderRadius:8,padding:"0px 5px",fontSize:10,color:"#8b949e"}}>
                                  {dayPicks.length}
                                </span>
                                {dayActive > 0 && <span style={{fontSize:10,color:"#3fb950"}}>{dayActive} active</span>}
                                {dayPL !== null && (
                                  <span style={{marginLeft:"auto",fontSize:11,fontWeight:700,color:dayPLColor}}>
                                    {dayPL >= 0 ? "+" : ""}${Math.abs(dayPL).toFixed(2)}
                                  </span>
                                )}
                              </div>
                              {/* Pick cards */}
                              {dayOpen && (
                                <div style={{border:"1px solid #21262d",borderTop:"none",borderRadius:"0 0 6px 6px",padding:"5px 5px 1px 5px"}}>
                                  {dayPicks.map(pick => {
              const oddsStr = pick.americanOdds >= 0 ? `+${pick.americanOdds}` : `${pick.americanOdds}`;
              const resultColor = pick.result === "won" ? "#3fb950" : pick.result === "lost" ? "#f78166" : pick.result === "dnp" ? "#8b949e" : null;
              const units = pick.units != null ? pick.units : Math.abs(pick.americanOdds || 0) / 10;
              const stake = units;
              let pickPL = null;
              if (pick.result === "won") pickPL = stake * oddsToProfit(pick.americanOdds);
              else if (pick.result === "lost") pickPL = -stake;
              // DNP = void, pickPL stays null
              const pickPLColor = pickPL > 0 ? "#3fb950" : pickPL < 0 ? "#f78166" : "#8b949e";
              return (
                <div key={pick.id} style={{background:"#161b22",
                  border:`1px solid ${resultColor ? resultColor + "44" : "#30363d"}`,
                  borderRadius:8, padding:"7px 10px", marginBottom:5,
                  display:"flex", gap:9, alignItems:"center"}}>
                  {/* Photo / Logo */}
                  {pick.gameType === "teamTotal" ? (
                    <div style={{width:36,height:36,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:"#21262d",borderRadius:18}}>
                      <img src={`https://a.espncdn.com/i/teamlogos/${pick.sport}/500/${(pick.scoringTeam||"").toLowerCase()}.png`}
                        style={{width:28,height:28,objectFit:"contain"}} onError={e=>e.target.style.opacity="0"} />
                    </div>
                  ) : pick.gameType === "total" ? (
                    <div style={{width:36,height:36,flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1}}>
                      <img src={`https://a.espncdn.com/i/teamlogos/${pick.sport}/500/${(pick.awayTeam||"").toLowerCase()}.png`}
                        style={{width:19,height:19,objectFit:"contain"}} onError={e=>e.target.style.opacity="0"} />
                      <img src={`https://a.espncdn.com/i/teamlogos/${pick.sport}/500/${(pick.homeTeam||"").toLowerCase()}.png`}
                        style={{width:19,height:19,objectFit:"contain"}} onError={e=>e.target.style.opacity="0"} />
                    </div>
                  ) : (
                    <div style={{width:36,height:36,flexShrink:0,borderRadius:18,background:"#21262d",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {pick.playerId ? (
                        <img src={`https://a.espncdn.com/i/headshots/${pick.sport}/players/full/${pick.playerId}.png`}
                          style={{width:36,height:36,objectFit:"cover",objectPosition:"top center"}}
                          onError={e=>{e.target.style.display="none";}} />
                      ) : (
                        <span style={{color:"#484f58",fontSize:14,fontWeight:700}}>{(pick.playerName||"?").charAt(0)}</span>
                      )}
                    </div>
                  )}
                  {/* Content */}
                  <div style={{flex:1,minWidth:0}}>
                    {/* Row 1: name + badges + (settled: result+P&L+undo) + edit/remove */}
                    <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                      {pick.gameType === "teamTotal" ? (
                        <span style={{color:"#fff",fontSize:12,fontWeight:700,flexShrink:1,minWidth:0}}>
                          <span onClick={()=>navigateToTeam(pick.scoringTeam,pick.sport)} style={{cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{pick.scoringTeam}</span>
                          <span style={{color:"#484f58",fontWeight:400}}> vs {pick.oppTeam}</span>
                        </span>
                      ) : pick.gameType === "total" ? (
                        <span style={{color:"#fff",fontSize:12,fontWeight:700,flexShrink:1,minWidth:0}}>
                          <span onClick={()=>navigateToTeam(pick.awayTeam,pick.sport)} style={{cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{pick.awayTeam}</span>
                          {" @ "}
                          <span onClick={()=>navigateToTeam(pick.homeTeam,pick.sport)} style={{cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{pick.homeTeam}</span>
                        </span>
                      ) : (
                        <span onClick={() => navigateToPlay(pick)}
                          style={{color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#30363d",textUnderlineOffset:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:140,flexShrink:1}}>
                          {pick.playerName}
                        </span>
                      )}
                      {pick.sport && (
                        <span style={{border:`1px solid ${SPORT_BADGE_COLOR[pick.sport]||"#8b949e"}`,
                          borderRadius:4,padding:"0px 4px",fontSize:9,color:SPORT_BADGE_COLOR[pick.sport]||"#8b949e",fontWeight:600,textTransform:"uppercase",flexShrink:0}}>
                          {pick.sport}
                        </span>
                      )}
                      {pick.edge != null && (
                        <span style={{background:"rgba(63,185,80,0.12)",border:"1px solid #3fb950",borderRadius:4,
                          padding:"0px 5px",fontSize:10,color:"#3fb950",fontWeight:700,flexShrink:0}}>
                          +{pick.edge}%
                        </span>
                      )}
                      {pick.result && (
                        <span style={{fontSize:10,fontWeight:700,color:resultColor,textTransform:"uppercase",letterSpacing:0.3,flexShrink:0}}>
                          {pick.result === "won" ? "✓ Won" : pick.result === "lost" ? "✗ Lost" : "— DNP"}
                        </span>
                      )}
                      {pickPL !== null && (
                        <span style={{fontSize:10,fontWeight:700,color:pickPLColor,flexShrink:0}}>
                          {fmt(pickPL)}
                        </span>
                      )}
                      <div style={{flex:1}} />
                      {pick.result && (
                        <button onClick={() => setPlayResult(pick.id, null)}
                          style={{background:"transparent",border:"1px solid #30363d",borderRadius:5,
                            padding:"2px 6px",fontSize:11,color:"#484f58",cursor:"pointer",flexShrink:0}}>
                          ↺
                        </button>
                      )}
                      <button onClick={() => setEditPickId(id => id === pick.id ? null : pick.id)} title="Edit"
                        style={{background: editPickId === pick.id ? "rgba(88,166,255,0.12)" : "transparent",
                          border:`1px solid ${editPickId === pick.id ? "#58a6ff" : "#30363d"}`,borderRadius:5,
                          padding:"2px 6px",fontSize:10,color: editPickId === pick.id ? "#58a6ff" : "#484f58",cursor:"pointer",flexShrink:0}}>
                        ✎
                      </button>
                      <button onClick={() => untrackPlay(pick.id)} title="Remove"
                        style={{background:"transparent",border:"1px solid #30363d",borderRadius:5,
                          padding:"2px 6px",fontSize:11,color:"#484f58",cursor:"pointer",flexShrink:0}}>
                        ×
                      </button>
                    </div>
                    {/* Row 2: subtitle + stake + (active: icon buttons / settled: win profit) */}
                    <div style={{display:"flex",alignItems:"center",gap:0}}>
                      <div style={{flex:1,minWidth:0,display:"flex",alignItems:"center",flexWrap:"wrap",lineHeight:1.4}}>
                        {pick.gameType !== "total" && pick.gameType !== "teamTotal" && (
                          <span style={{color:"#8b949e",fontSize:10}}>
                            {pick.playerTeam} vs {pick.opponent}
                            <span style={{color:"#484f58",margin:"0 3px"}}>·</span>
                          </span>
                        )}
                        <span style={{color:"#58a6ff",fontWeight:600,fontSize:10}}>
                          {pick.gameType === "teamTotal"
                            ? `Over ${(pick.threshold-0.5).toFixed(1)} ${({teamRuns:"Runs",teamPoints:"Pts"})[pick.stat]||pick.stat}`
                            : pick.gameType === "total"
                            ? `${pick.direction === "under" ? "Under" : "Over"} ${(pick.threshold-0.5).toFixed(1)} ${({totalRuns:"Runs",totalPoints:"Pts",totalGoals:"Goals"})[pick.stat]||pick.stat}`
                            : `${pick.threshold}+ ${STAT_LABEL[pick.stat] || pick.stat}`}
                        </span>
                        <span style={{color:"#484f58",fontSize:10,margin:"0 3px"}}>·</span>
                        <span style={{color:"#a855f7",fontSize:10}}>{oddsStr}</span>
                        <span style={{color:"#484f58",fontSize:10,margin:"0 3px"}}>·</span>
                        <span style={{color:"#e3b341",fontSize:10}}>{pick.direction === "under" ? (pick.noTruePct ?? pick.truePct) : pick.truePct}% true</span>
                        <span style={{color:"#484f58",fontSize:10,margin:"0 3px"}}>·</span>
                        <span style={{color:"#484f58",fontSize:10}}>$</span>
                        <input type="number" min="0" step="0.1" value={units}
                          onChange={e => setPickUnits(pick.id, e.target.value)}
                          style={{background:"transparent",border:"none",outline:"none",color:"#c9d1d9",
                            fontSize:10,width:46,padding:"0 2px",textAlign:"left"}}/>
                      </div>
                      {!pick.result && (
                        <div style={{display:"flex",gap:4,flexShrink:0,marginLeft:6}}>
                          {[["won","rgba(63,185,80,0.12)","#3fb950","✓","Won"],["lost","rgba(247,129,102,0.12)","#f78166","✗","Lost"],["dnp","rgba(139,148,158,0.12)","#484f58","–","DNP"]].map(([res,bg,bdr,icon,lbl]) => (
                            <button key={res} onClick={() => setPlayResult(pick.id, res)} title={lbl}
                              style={{background:bg,border:`1px solid ${bdr}`,borderRadius:5,
                                padding:"2px 6px",fontSize:10,fontWeight:700,
                                color:res==="dnp"?"#8b949e":bdr,cursor:"pointer",flexShrink:0}}>
                              {icon}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Edit mode: full inline form */}
                    {editPickId === pick.id && (() => {
                      const SPORT_STATS_EDIT = {
                        nba:["points","rebounds","assists","threePointers"],
                        mlb:["hits","hrr","strikeouts"],
                        nfl:["passingYards","rushingYards","receivingYards","receptions"],
                        nhl:["points"],
                      };
                      const ei = { background:"#0d1117", border:"1px solid #30363d", borderRadius:5, color:"#c9d1d9", fontSize:12, padding:"4px 7px", outline:"none", width:"100%" };
                      return (
                        <div style={{marginTop:8,padding:10,background:"#0d1117",borderRadius:7,border:"1px solid #30363d"}}>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Stat</div>
                              <select style={ei} value={pick.stat}
                                onChange={e => setTrackedPlays(prev => prev.map(p => p.id === pick.id ? {...p, stat: e.target.value} : p))}>
                                {(SPORT_STATS_EDIT[pick.sport] || []).map(s => <option key={s} value={s}>{STAT_LABEL[s] || s}</option>)}
                              </select>
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Stake ($)</div>
                              <input style={ei} type="number" min="0" step="0.1" defaultValue={units}
                                onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setPickUnits(pick.id, v); }} />
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Line</div>
                              <input style={ei} type="number" step="0.5" defaultValue={pick.threshold}
                                onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setTrackedPlays(prev => prev.map(p => p.id === pick.id ? {...p, threshold: v} : p)); }} />
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Odds</div>
                              <input style={ei} type="number" defaultValue={pick.americanOdds}
                                onBlur={e => { const v = parseInt(e.target.value); if (!isNaN(v)) setTrackedPlays(prev => prev.map(p => p.id === pick.id ? {...p, americanOdds: v, kalshiPct: parseFloat((v < 0 ? Math.abs(v)/(Math.abs(v)+100)*100 : 100/(v+100)*100).toFixed(1))} : p)); }} />
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>True Prob %</div>
                              <input style={ei} type="number" min="0" max="100" step="0.1" defaultValue={pick.truePct ?? ""}
                                onBlur={e => { const v = parseFloat(e.target.value); setTrackedPlays(prev => prev.map(p => { if (p.id !== pick.id) return p; const kp = p.kalshiPct ?? p.americanOdds < 0 ? Math.abs(p.americanOdds)/(Math.abs(p.americanOdds)+100)*100 : 100/(p.americanOdds+100)*100; return {...p, truePct: isNaN(v) ? null : v, edge: isNaN(v) ? null : parseFloat((v - kp).toFixed(1))}; })); }} />
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Game Date</div>
                              <input style={ei} type="date" defaultValue={pick.gameDate || ""}
                                onBlur={e => { const v = e.target.value; setTrackedPlays(prev => prev.map(p => p.id === pick.id ? {...p, gameDate: v || null} : p)); }} />
                            </div>
                          </div>
                          <button onClick={() => setEditPickId(null)}
                            style={{width:"100%",padding:"4px",borderRadius:5,background:"rgba(88,166,255,0.12)",border:"1px solid #58a6ff",color:"#58a6ff",fontSize:11,fontWeight:600,cursor:"pointer"}}>
                            done
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                </div>
                                  );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              });
            })()}

          </div>
        );
      })()}
        </div>
  );
}

export default MyPicksColumn;
