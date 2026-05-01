import React from 'react';
import { STAT_LABEL } from '../lib/constants.js';

function DayBar({ day, HALF, maxAbs }) {
  const [hovered, setHovered] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const ref = React.useRef(null);

  // Pinned (tap-to-show) closes on outside tap.
  React.useEffect(() => {
    if (!pinned) return;
    const close = (e) => {
      if (!ref.current || !ref.current.contains(e.target)) setPinned(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
    };
  }, [pinned]);

  const visible = hovered || pinned;
  const winH = day.wins > 0 ? Math.max(Math.round((day.wins / maxAbs) * HALF), 3) : 0;
  const lossH = day.losses > 0 ? Math.max(Math.round((day.losses / maxAbs) * HALF), 3) : 0;
  return (
    <div ref={ref} style={{flex:1, position:"relative", cursor: day.plays.length > 0 ? "pointer" : "default"}}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => { if (day.plays.length === 0) return; e.stopPropagation(); setPinned(p => !p); }}>
      {winH > 0 && (
        <div style={{
          position:"absolute", left:0, right:0, height:winH,
          top: HALF - winH,
          background: "#3fb950",
          borderRadius: "3px 3px 0 0",
          opacity: visible ? 1 : 0.85, transition:"opacity 0.15s",
        }}/>
      )}
      {lossH > 0 && (
        <div style={{
          position:"absolute", left:0, right:0, height:lossH,
          top: HALF,
          background: "#f78166",
          borderRadius: "0 0 3px 3px",
          opacity: visible ? 1 : 0.85, transition:"opacity 0.15s",
        }}/>
      )}
      {visible && (
        <div style={{
          position:"absolute", bottom: HALF + 8, left:"50%", transform:"translateX(-50%)",
          background:"#1c2128", border:"1px solid #30363d", borderRadius:6,
          padding:"6px 8px", zIndex:100, whiteSpace:"nowrap", pointerEvents:"none",
          fontSize:10, color:"#c9d1d9", minWidth:130,
        }}>
          <div style={{fontWeight:600, marginBottom:4, color:"#8b949e"}}>{day.dateLabel}</div>
          {day.plays.map((p, i) => (
            <div key={i} style={{display:"flex", justifyContent:"space-between", gap:12}}>
              <span>{p.barLabel}</span>
              <span style={{color: p.pl >= 0 ? "#3fb950" : "#f78166", fontWeight:600}}>
                {p.pl >= 0 ? "+" : ""}${p.pl.toFixed(2)}
              </span>
            </div>
          ))}
          {day.plays.length > 1 && (
            <div style={{marginTop:4, paddingTop:4, borderTop:"1px solid #30363d", display:"flex", justifyContent:"space-between"}}>
              <span style={{color:"#484f58"}}>Net</span>
              <span style={{color: day.pl >= 0 ? "#3fb950" : "#f78166", fontWeight:700}}>
                {day.pl >= 0 ? "+" : ""}${day.pl.toFixed(2)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


export default DayBar;
