import React from 'react';
import { TOTAL_THRESHOLDS } from '../lib/constants.js';
import { tierColor } from '../lib/colors.js';

function TotalsBarChart({ gameLog, sport, tonightTotalMap, tonightPlay, trackedPlays, onTrack, onUntrack }) {
  const thresholds = TOTAL_THRESHOLDS[sport] || [5,6,7,8,9,10];
  const completed = (gameLog || []).filter(g => g.result);

  const data = thresholds.map(t => {
    const count = completed.filter(g => g.total >= t).length;
    const pct = completed.length > 0 ? (count / completed.length) * 100 : 0;
    return { t, count, pct };
  });

  return (
    <div>
      {data.map(({ t, count, pct }) => {
        const tp = tonightTotalMap?.[t] ?? null;
        const lineLabel = `O${(t - 0.5).toFixed(1)}`;

        const kalshiPct = tp?.kalshiPct ?? null;
        const modelPct = tp?.truePct ?? null;
        const edge = tp?.edge ?? null;
        const edgeColor = edge == null ? "#484f58" : edge >= 3 ? "#3fb950" : edge >= 0 ? "#e3b341" : "#f78166";

        const trackId = tp ? `total|${tp.sport}|${tp.homeTeam}|${tp.awayTeam}|${t}|${tp.gameDate || ""}` : null;
        const _tAnchor = tp ?? tonightPlay;
        const _localToday = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
        const _existingTotalPick = _tAnchor ? (trackedPlays || []).find(p => {
          const [pt,ps,ph,pa,pth,pd] = p.id.split("|");
          return pt==="total" && ps===_tAnchor.sport && ph===_tAnchor.homeTeam && pa===_tAnchor.awayTeam && String(pth)===String(t) && (!pd || pd >= _localToday);
        }) : null;
        const isTracked = !!_existingTotalPick || !!(trackId && (trackedPlays || []).some(p => p.id === trackId));
        const _untrackId = _existingTotalPick?.id ?? trackId;
        const canTrack = tp != null && (tp.kalshiPct ?? 0) >= 70 && edge != null && edge >= 3;
        const trackBtn = canTrack ? (
          <button
            onClick={() => isTracked ? onUntrack(_untrackId) : onTrack({ ...tp, threshold: t })}
            title={isTracked ? "Remove pick" : "Add to My Picks"}
            style={{background:isTracked?"rgba(63,185,80,0.15)":"transparent",
              border:`1px solid ${isTracked?"#3fb950":"#30363d"}`,
              borderRadius:6,padding:"1px 6px",cursor:"pointer",
              color:isTracked?"#3fb950":"#484f58",fontSize:13,lineHeight:1,flexShrink:0}}>
            {isTracked ? "★" : "☆"}
          </button>
        ) : null;

        // Primary bar: model% when tonight data available, else hist%
        const hasTonightData = modelPct != null;
        const primaryPct = hasTonightData ? modelPct : pct;
        const barColor = tierColor(primaryPct);
        const labelColor = tp ? "#c9d1d9" : "#8b949e";

        return (
          <div key={t} style={{display:"flex",gap:10,marginBottom:14,alignItems:"flex-start"}}>
            <div style={{color:labelColor,fontSize:13,width:40,textAlign:"right",
              flexShrink:0,paddingTop:2,fontWeight:400}}>
              {lineLabel}
            </div>
            <div style={{flex:1,display:"flex",flexDirection:"column",gap:5}}>
              {/* Primary bar (model when available, else hist) */}
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{flex:1,background:"#21262d",borderRadius:5,height:18,overflow:"hidden"}}>
                  <div style={{width:`${primaryPct}%`,background:barColor,height:"100%",borderRadius:5,
                    transition:"width 0.5s ease",minWidth:primaryPct>0?4:0}}/>
                </div>
                <div style={{color:barColor,fontSize:13,fontWeight:700,width:42,textAlign:"right",flexShrink:0}}>
                  {primaryPct.toFixed(1)}%
                </div>
                <div style={{flexShrink:0,width:110,display:"flex",alignItems:"center",gap:4}}>
                  <span style={{color:"#484f58",fontSize:10,flex:1}}>{count}/{completed.length}g</span>
                  {hasTonightData && edge != null && (
                    <span style={{display:"flex",alignItems:"center",gap:3}}>
                      <span style={{background:edgeColor+"22",border:`1px solid ${edgeColor}`,borderRadius:4,
                        padding:"1px 5px",fontSize:10,fontWeight:700,color:edgeColor,whiteSpace:"nowrap"}}>
                        {edge >= 0 ? "+" : ""}{edge}%
                      </span>
                    </span>
                  )}
                  {trackBtn}
                </div>
              </div>
              {/* Kalshi price bar */}
              {kalshiPct != null && (() => {
                const kOdds = kalshiPct >= 50 ? Math.round(-(kalshiPct/(100-kalshiPct))*100) : Math.round((100-kalshiPct)/kalshiPct*100);
                const kOddsStr = kOdds > 0 ? `+${kOdds}` : `${kOdds}`;
                return (
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{flex:1,background:"#21262d",borderRadius:4,height:11,overflow:"hidden"}}>
                      <div style={{width:`${kalshiPct}%`,background:"#6e40c9",height:"100%",borderRadius:4,
                        transition:"width 0.5s ease",minWidth:kalshiPct>0?2:0}}/>
                    </div>
                    <div style={{color:"#6e40c9",fontSize:11,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>
                      {kalshiPct}%
                    </div>
                    <div style={{color:"#6e40c9",fontSize:10,width:110,flexShrink:0,paddingLeft:2}}>
                      {`(${kOddsStr})`}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        );
      })}
    </div>
  );
}


export default TotalsBarChart;
