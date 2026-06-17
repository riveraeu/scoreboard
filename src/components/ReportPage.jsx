import React from 'react';

// --- MorningBriefing ------------------------------------------------------------
// Cross-sport morning summary: category scoreboard, top opportunity bands, CLV,
// today's top picks, and optimal daily stake recommendation.

function MorningBriefing({ shadowReportData, shadowReportLoading, fetchShadowReport, isLoggedIn }) {
  const [open, setOpen] = React.useState(true);

  if (!isLoggedIn) return null;

  const thB = { padding:"4px 8px", fontSize:10, fontWeight:700, color:"#8b949e", textAlign:"center", borderBottom:"1px solid #21262d", background:"#0d1117" };
  const tdB = { padding:"4px 8px", fontSize:11, textAlign:"center", borderBottom:"1px solid #161b22" };

  const d = shadowReportData;
  const noReport = !d || d.notYet || d.error;

  return (
    <div style={{background:"#161b22",border:"1px solid #21262d",borderRadius:8,marginBottom:10}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",padding:"8px 12px",gap:8,cursor:"pointer"}} onClick={() => setOpen(v => !v)}>
        <span style={{color:"#58a6ff",fontSize:12,fontWeight:700}}>Morning Briefing</span>
        {d?.reportDate && <span style={{color:"#484f58",fontSize:11}}>{d.reportDate}</span>}
        {d?.generatedAt && <span style={{color:"#484f58",fontSize:10}}>· generated {new Date(d.generatedAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"})} PT</span>}
        <div style={{marginLeft:"auto",display:"flex",gap:6}}>
          <button onClick={e => { e.stopPropagation(); fetchShadowReport(true); }}
            style={{background:"transparent",border:"1px solid #30363d",borderRadius:4,color:"#8b949e",fontSize:10,padding:"2px 6px",cursor:"pointer"}}>
            {shadowReportLoading ? "…" : "↻"}
          </button>
          <span style={{color:"#484f58",fontSize:11}}>{open ? "▲" : "▼"}</span>
        </div>
      </div>

      {!open ? null : shadowReportLoading ? (
        <div style={{padding:"12px",color:"#484f58",fontSize:12}}>Generating report…</div>
      ) : noReport ? (
        <div style={{padding:"12px",display:"flex",gap:8,alignItems:"center"}}>
          <span style={{color:"#484f58",fontSize:12}}>
            {d?.error ? `Error: ${d.error}` : "Report not yet generated — cron runs at 9:30am PT. Click ↻ to generate now."}
          </span>
        </div>
      ) : (
        <div style={{padding:"0 12px 12px"}}>

          {/* Today's top picks */}
          {d.topPicks?.length > 0 && (
            <div style={{marginBottom:12}}>
              <div style={{color:"#3fb950",fontSize:11,fontWeight:700,marginBottom:6}}>
                Today's Top Picks ({d.reportDate} · passed category gate · sorted by edge)
              </div>
              <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d"}}>
                <thead><tr>
                  {["Pick","Direction","Model%","Market%","Edge","Game"].map(h => <th key={h} style={thB}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.topPicks.map((p, i) => {
                    const edge = p.edge ?? 0;
                    const edgeC = edge >= 10 ? "#3fb950" : edge >= 7 ? "#e3b341" : "#c9d1d9";
                    const label = p.playerName
                      ? `${p.playerName} ${p.threshold != null ? `O${p.threshold}` : ""} ${p.category}`
                      : `${p.pickTeam ?? p.homeTeam} ${p.direction === "under" ? "U" : "O"}${p.pickLine ?? p.threshold ?? ""} ${p.category}`;
                    const gameLabel = p.homeTeam && p.awayTeam
                      ? `${p.awayTeam}@${p.homeTeam}` : (p.homeTeam ?? "");
                    const gameTime = p.gameTime
                      ? new Date(p.gameTime).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"})
                      : "—";
                    return (
                      <tr key={i}>
                        <td style={{...tdB,color:"#c9d1d9",textAlign:"left",fontWeight:600}}>{label}</td>
                        <td style={{...tdB,color:p.direction==="under"?"#79c0ff":"#3fb950"}}>{p.direction ?? "—"}</td>
                        <td style={{...tdB,color:"#c9d1d9"}}>{p.modelTruePct != null ? `${p.modelTruePct}%` : "—"}</td>
                        <td style={{...tdB,color:"#8b949e"}}>{p.marketPct != null ? `${p.marketPct}%` : "—"}</td>
                        <td style={{...tdB,color:edgeC,fontWeight:700}}>{edge >= 0 ? `+${edge.toFixed(1)}` : edge.toFixed(1)}%</td>
                        <td style={{...tdB,color:"#484f58"}}>{gameLabel} {gameTime}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {d.topPicks?.length === 0 && (
            <div style={{color:"#484f58",fontSize:11,marginBottom:10}}>No picks pass the category gate today.</div>
          )}

          {/* Optimal daily stake */}
          {d.optimalDailyPicks && (
            <div style={{background:"#0d1117",borderRadius:6,padding:"8px 10px",marginBottom:10,display:"flex",alignItems:"center",gap:16,flexWrap:"wrap",border:"1px solid #21262d"}}>
              <div>
                <div style={{color:"#484f58",fontSize:10,fontWeight:600,marginBottom:2}}>OPTIMAL PICKS/DAY</div>
                <div style={{color:"#3fb950",fontSize:18,fontWeight:700}}>{d.optimalDailyPicks.bucket}</div>
                {d.optimalDailyPicks.stopAt && (
                  <div style={{color:"#f78166",fontSize:10}}>stop before {d.optimalDailyPicks.stopAt}/day</div>
                )}
              </div>
              <div>
                <div style={{color:"#484f58",fontSize:10,fontWeight:600,marginBottom:2}}>ROI AT THAT BUCKET</div>
                <div style={{color:d.optimalDailyPicks.roi >= 0 ? "#3fb950" : "#f78166",fontSize:16,fontWeight:700}}>
                  {d.optimalDailyPicks.roi >= 0 ? "+" : ""}{((d.optimalDailyPicks.roi ?? 0) * 100).toFixed(1)}%
                </div>
              </div>
              <div>
                <div style={{color:"#484f58",fontSize:10,fontWeight:600,marginBottom:2}}>SAMPLE</div>
                <div style={{color:"#8b949e",fontSize:12}}>{d.optimalDailyPicks.nDays} days</div>
                <div style={{color:"#484f58",fontSize:10}}>{d.optimalDailyPicks.confidence} confidence</div>
              </div>
              {d.dailyVolumeRoi?.length > 0 && (
                <div style={{marginLeft:"auto"}}>
                  <table style={{borderCollapse:"collapse"}}>
                    <thead><tr>{["Picks/day","Days","Hit%","ROI"].map(h=><th key={h} style={{...thB,padding:"2px 6px"}}>{h}</th>)}</tr></thead>
                    <tbody>
                      {d.dailyVolumeRoi.map((r,i) => {
                        const roi = r.roi ?? 0;
                        const isBest = r.picksBucket === d.optimalDailyPicks.bucket;
                        return (
                          <tr key={i} style={{background:isBest?"rgba(63,185,80,0.08)":"transparent"}}>
                            <td style={{...tdB,padding:"2px 6px",color:isBest?"#3fb950":"#c9d1d9",fontWeight:isBest?700:400}}>{r.picksBucket}</td>
                            <td style={{...tdB,padding:"2px 6px"}}>{r.nDays}</td>
                            <td style={{...tdB,padding:"2px 6px",color:r.hitRatePct>=70?"#3fb950":r.hitRatePct>=60?"#e3b341":"#f78166"}}>{r.hitRatePct}%</td>
                            <td style={{...tdB,padding:"2px 6px",color:roi>=0.02?"#3fb950":roi<=-0.02?"#f78166":"#e3b341",fontWeight:700}}>
                              {roi>=0?"+":""}{(roi*100).toFixed(1)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Category scoreboard */}
          {d.categories?.length > 0 && (
            <div style={{marginBottom:10}}>
              <div style={{color:"#8b949e",fontSize:11,fontWeight:600,marginBottom:4}}>
                Category Scoreboard · last 30d · threshold_rank=1 dedup
              </div>
              <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d"}}>
                <thead><tr>
                  {["Category","N","Hit%","ROI","Avg Edge","Status"].map(h => <th key={h} style={thB}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.categories.map((c, i) => {
                    const roi = c.roi ?? 0;
                    const statusColor = c.status === "active" ? "#3fb950" : c.status === "building" ? "#e3b341" : c.status === "losing" ? "#f78166" : "#484f58";
                    return (
                      <tr key={i}>
                        <td style={{...tdB,color:"#c9d1d9",textAlign:"left",fontWeight:600}}>{c.key}</td>
                        <td style={{...tdB,color:c.n>=100?"#c9d1d9":c.n>=30?"#8b949e":"#484f58"}}>{c.n}</td>
                        <td style={{...tdB,color:c.hitRate>=70?"#3fb950":c.hitRate>=60?"#e3b341":"#f78166"}}>{c.hitRate != null ? `${c.hitRate}%` : "—"}</td>
                        <td style={{...tdB,color:roi>=0.02?"#3fb950":roi<=-0.02?"#f78166":"#e3b341",fontWeight:600}}>
                          {c.roi != null ? `${roi>=0?"+":""}${(roi*100).toFixed(1)}%` : "—"}
                        </td>
                        <td style={{...tdB,color:"#8b949e"}}>{c.avgEdge != null ? `${c.avgEdge >= 0 ? "+" : ""}${c.avgEdge.toFixed(1)}%` : "—"}</td>
                        <td style={{...tdB}}><span style={{color:statusColor,fontSize:10,fontWeight:700}}>{c.status.toUpperCase()}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Top opportunity bands */}
          {d.topBands?.length > 0 && (
            <div style={{marginBottom:10}}>
              <div style={{color:"#8b949e",fontSize:11,fontWeight:600,marginBottom:4}}>
                Top Opportunity Bands · most data + biggest calibration gap
              </div>
              <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d"}}>
                <thead><tr>
                  {["Category","Band","N","Model%","Actual%","Δ","ROI"].map(h => <th key={h} style={thB}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.topBands.map((b, i) => {
                    const delta = b.delta ?? 0;
                    const roi = b.roi ?? 0;
                    const deltaC = delta <= -5 ? "#f78166" : delta >= 5 ? "#3fb950" : "#e3b341";
                    return (
                      <tr key={i}>
                        <td style={{...tdB,color:"#c9d1d9",textAlign:"left"}}>{b.sport}|{b.category}</td>
                        <td style={{...tdB,color:"#8b949e"}}>{b.band}%</td>
                        <td style={{...tdB,color:b.n>=50?"#c9d1d9":b.n>=20?"#8b949e":"#484f58"}}>{b.n}</td>
                        <td style={{...tdB,color:"#8b949e"}}>{b.predicted != null ? `${b.predicted}%` : "—"}</td>
                        <td style={{...tdB,color:b.actual>=70?"#3fb950":b.actual>=60?"#e3b341":"#f78166"}}>{b.actual != null ? `${b.actual}%` : "—"}</td>
                        <td style={{...tdB,color:deltaC,fontWeight:600}}>{delta != null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}` : "—"}</td>
                        <td style={{...tdB,color:roi>=0.02?"#3fb950":roi<=-0.02?"#f78166":"#e3b341",fontWeight:600}}>
                          {b.roi != null ? `${roi>=0?"+":""}${(roi*100).toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* CLV signal */}
          {d.clv?.length > 0 && (
            <div>
              <div style={{color:"#8b949e",fontSize:11,fontWeight:600,marginBottom:4}}>
                CLV / Line Movement · 3pm → 7pm PT · + = market confirmed model
              </div>
              <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d"}}>
                <thead><tr>
                  {["Category","N","CLV","Edge@snap","Edge@close","Hit%"].map(h => <th key={h} style={thB}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.clv.map((r, i) => {
                    const clvV = r.avgClvPct ?? 0;
                    const clvC = clvV >= 1 ? "#3fb950" : clvV <= -1 ? "#f78166" : "#e3b341";
                    const edgeDrift = (r.avgEdgeAtClose ?? 0) - (r.avgEdgeAtSnap ?? 0);
                    return (
                      <tr key={i}>
                        <td style={{...tdB,color:"#c9d1d9",textAlign:"left"}}>{r.sport}|{r.category}</td>
                        <td style={tdB}>{r.n}</td>
                        <td style={{...tdB,color:clvC,fontWeight:600}}>{clvV >= 0 ? `+${clvV.toFixed(1)}` : clvV.toFixed(1)}%</td>
                        <td style={{...tdB,color:(r.avgEdgeAtSnap??0)>=5?"#3fb950":(r.avgEdgeAtSnap??0)>=2?"#e3b341":"#f78166"}}>
                          {r.avgEdgeAtSnap != null ? `${r.avgEdgeAtSnap.toFixed(1)}%` : "—"}
                        </td>
                        <td style={{...tdB,color:(r.avgEdgeAtClose??0)>=5?"#3fb950":(r.avgEdgeAtClose??0)>=2?"#e3b341":"#f78166"}}>
                          {r.avgEdgeAtClose != null ? `${r.avgEdgeAtClose.toFixed(1)}%` : "—"}
                          {Math.abs(edgeDrift)>=0.5&&<span style={{color:edgeDrift>=0?"#3fb950":"#f78166",fontSize:9,marginLeft:3}}>{edgeDrift>=0?"+":""}{edgeDrift.toFixed(1)}</span>}
                        </td>
                        <td style={{...tdB,color:(r.hitRatePct??0)>=70?"#3fb950":(r.hitRatePct??0)>=60?"#e3b341":"#f78166",fontWeight:600}}>
                          {r.hitRatePct != null ? `${r.hitRatePct}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- ReportPage --------------------------------------------------------------------
// Daily model report — wraps MorningBriefing (the /api/shadow-report payload).

function ReportPage({
  onBack,
  shadowReportData, shadowReportLoading, fetchShadowReport,
  isLoggedIn,
}) {
  // Fetch the model report once on mount when authed (briefing data is JWT-scoped).
  React.useEffect(() => {
    if (isLoggedIn && !shadowReportData && !shadowReportLoading) fetchShadowReport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  return (
    <div style={{maxWidth:1280,margin:"0 auto",padding:"16px 16px"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",marginBottom:14,gap:12}}>
        <button onClick={onBack}
          style={{background:"transparent",border:"1px solid #30363d",borderRadius:6,
            color:"#8b949e",fontSize:12,padding:"4px 10px",cursor:"pointer"}}>
          ← Back
        </button>
        <div style={{color:"#c9d1d9",fontSize:17,fontWeight:700}}>Report</div>
        <div style={{color:"#484f58",fontSize:11,marginLeft:"auto"}}>Daily model report</div>
      </div>

      {isLoggedIn ? (
        <MorningBriefing
          shadowReportData={shadowReportData}
          shadowReportLoading={shadowReportLoading}
          fetchShadowReport={fetchShadowReport}
          isLoggedIn={isLoggedIn}
        />
      ) : (
        <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>
          Log in to view the model report.
        </div>
      )}
    </div>
  );
}

export default ReportPage;
