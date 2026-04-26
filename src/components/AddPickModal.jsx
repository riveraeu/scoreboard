import React from 'react';

function useDebounce(val, ms) {
  const [dv, setDv] = React.useState(val);
  React.useEffect(() => {
    const t = setTimeout(() => setDv(val), ms);
    return () => clearTimeout(t);
  }, [val, ms]);
  return dv;
}


function AddPickModal({ onClose, onAdd, initialOdds = "-110" }) {
  const SPORT_STATS = {
    nba: ["points","rebounds","assists","threePointers"],
    mlb: ["hits","hrr","strikeouts"],
    nfl: ["passingYards","rushingYards","receivingYards","receptions","completions","attempts"],
    nhl: ["points"],
  };
  const STAT_LABELS = {
    points:"Points", rebounds:"Rebounds", assists:"Assists", threePointers:"3-Pointers",
    hits:"Hits", hrr:"H+R+RBI", strikeouts:"Strikeouts",
    passingYards:"Pass Yards", rushingYards:"Rush Yards", receivingYards:"Rec Yards",
    receptions:"Receptions", completions:"Completions", attempts:"Attempts",
    shotsOnGoal:"Shots on Goal", saves:"Saves",
  };
  const suggestUnits = (odds) => { const o = parseInt(odds) || 0; return o <= -900 ? 5 : o <= -400 ? 4 : o <= -200 ? 3 : o <= -110 ? 2 : 1; };
  const [form, setForm] = React.useState({ playerName:"", sport:"nba", stat:"points", threshold:"", americanOdds:initialOdds, truePct:"", units: String(suggestUnits(initialOdds)), gameDate: new Date().toISOString().slice(0,10) });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Reset stat when sport changes
  React.useEffect(() => {
    set("stat", SPORT_STATS[form.sport][0]);
  }, [form.sport]);

  function handleSubmit(e) {
    e.preventDefault();
    const threshold = parseFloat(form.threshold);
    const americanOdds = parseInt(form.americanOdds);
    if (!form.playerName.trim() || isNaN(threshold) || isNaN(americanOdds)) return;
    const sportFull = { nba:"basketball/nba", mlb:"baseball/mlb", nfl:"football/nfl", nhl:"hockey/nhl" }[form.sport];
    const truePctVal = parseFloat(form.truePct);
    const kalshiPct = americanOdds < 0
      ? Math.abs(americanOdds) / (Math.abs(americanOdds) + 100) * 100
      : 100 / (americanOdds + 100) * 100;
    onAdd({
      playerName: form.playerName.trim(),
      sport: form.sport,
      sportKey: sportFull,
      stat: form.stat,
      threshold,
      americanOdds,
      kalshiPct: parseFloat(kalshiPct.toFixed(1)),
      truePct: !isNaN(truePctVal) ? truePctVal : null,
      edge: !isNaN(truePctVal) ? parseFloat((truePctVal - kalshiPct).toFixed(1)) : null,
      units: parseFloat(form.units) || 1,
      gameDate: form.gameDate || new Date().toISOString().slice(0,10),
    });
    onClose();
  }

  const inp = { background:"#0d1117", border:"1px solid #30363d", borderRadius:6, color:"#c9d1d9",
    fontSize:13, padding:"7px 10px", width:"100%", outline:"none" };
  const lbl = { color:"#8b949e", fontSize:11, marginBottom:4, display:"block" };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,padding:24,width:"100%",maxWidth:380}}>
        <div style={{display:"flex",alignItems:"center",marginBottom:20}}>
          <span style={{color:"#fff",fontSize:16,fontWeight:700,flex:1}}>Add Pick</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#484f58",fontSize:18,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{display:"grid",gap:14}}>
            <div>
              <label style={lbl}>Player Name</label>
              <input style={inp} placeholder="e.g. Nikola Jokic" value={form.playerName}
                onChange={e => set("playerName", e.target.value)} autoFocus />
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div>
                <label style={lbl}>Sport</label>
                <select style={inp} value={form.sport} onChange={e => set("sport", e.target.value)}>
                  <option value="nba">NBA</option>
                  <option value="mlb">MLB</option>
                  <option value="nfl">NFL</option>
                  <option value="nhl">NHL</option>
                </select>
              </div>
              <div>
                <label style={lbl}>Stat</label>
                <select style={inp} value={form.stat} onChange={e => set("stat", e.target.value)}>
                  {SPORT_STATS[form.sport].map(s => (
                    <option key={s} value={s}>{STAT_LABELS[s] || s}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div>
                <label style={lbl}>Line (Over)</label>
                <input style={inp} type="number" placeholder="20.5" step="0.5" value={form.threshold}
                  onChange={e => set("threshold", e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Odds</label>
                <input style={inp} type="number" placeholder="-110" value={form.americanOdds}
                  onChange={e => { set("americanOdds", e.target.value); setForm(f => ({ ...f, americanOdds: e.target.value, units: String(suggestUnits(e.target.value)) })); }} />
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
              <div>
                <label style={lbl}>True Probability %</label>
                <input style={inp} type="number" placeholder="75" min="0" max="100" step="0.1" value={form.truePct}
                  onChange={e => set("truePct", e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Units %</label>
                <input style={inp} type="number" placeholder="1" min="0" max="100" step="0.5" value={form.units}
                  onChange={e => set("units", e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Game Date</label>
                <input style={inp} type="date" value={form.gameDate}
                  onChange={e => set("gameDate", e.target.value)} />
              </div>
            </div>
          </div>
          <button type="submit" style={{marginTop:20,width:"100%",padding:"10px",borderRadius:8,
            background:"#238636",border:"none",color:"#fff",fontSize:14,fontWeight:600,cursor:"pointer"}}>
            Add Pick
          </button>
        </form>
      </div>
    </div>
  );
}

// Column definitions for per-game gamelog table in player card.
// Each col: { key, label, tooltip, align? }  align defaults to "right"; only "left"/"center" need specifying.
// key maps to perGame row fields (or 'rest' for computed rest-days).
// ─── Model Explanation Page ────────────────────────────────────────────────

export { useDebounce };
export default AddPickModal;
