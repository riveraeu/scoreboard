import React from 'react';
import { WORKER } from '../lib/constants.js';

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
  };
  const suggestUnits = (odds) => { const o = parseInt(odds) || 0; return o <= -900 ? 5 : o <= -400 ? 4 : o <= -200 ? 3 : o <= -110 ? 2 : 1; };
  const [form, setForm] = React.useState({ playerName:"", sport:"nba", stat:"points", threshold:"", americanOdds:initialOdds, truePct:"", units: String(suggestUnits(initialOdds)), gameDate: new Date().toISOString().slice(0,10) });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Player typeahead — same /api/athletes endpoint as the main search.
  // On selection we lock in playerId/playerTeam/sport so the saved pick has the
  // same metadata as one tracked from the play card (live polling, headshot, etc.).
  const [selectedAthlete, setSelectedAthlete] = React.useState(null);
  const [suggestions, setSuggestions] = React.useState([]);
  const [showDrop, setShowDrop] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const debouncedName = useDebounce(form.playerName, 250);

  React.useEffect(() => {
    // Don't search if user just picked one (input value === selected name)
    if (selectedAthlete && selectedAthlete.name === form.playerName) {
      setSuggestions([]); setShowDrop(false); return;
    }
    if (debouncedName.trim().length < 2) { setSuggestions([]); setShowDrop(false); return; }
    setSearching(true);
    fetch(`${WORKER}/athletes?q=${encodeURIComponent(debouncedName)}`)
      .then(r => r.json())
      .then(data => {
        const items = (data.items || []).slice(0, 8);
        setSuggestions(items);
        setShowDrop(items.length > 0);
      })
      .catch(() => setSuggestions([]))
      .finally(() => setSearching(false));
  }, [debouncedName, selectedAthlete, form.playerName]);

  function pickAthlete(a) {
    setSelectedAthlete(a);
    // Auto-set sport from the athlete (avoids mismatch like NBA player tagged MLB)
    setForm(f => ({ ...f, playerName: a.name, sport: a.league || f.sport, stat: SPORT_STATS[a.league || f.sport]?.[0] || f.stat }));
    setShowDrop(false);
    setSuggestions([]);
  }

  function onNameChange(v) {
    set("playerName", v);
    if (selectedAthlete && v !== selectedAthlete.name) setSelectedAthlete(null);
  }

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
      ...(selectedAthlete?.id ? { playerId: String(selectedAthlete.id) } : {}),
      ...(selectedAthlete?.team ? { playerTeam: selectedAthlete.team } : {}),
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
            <div style={{position:"relative"}}>
              <label style={lbl}>
                Player Name
                {selectedAthlete && (
                  <span style={{marginLeft:6,fontSize:9,color:"#3fb950",fontWeight:700}}>
                    ✓ {selectedAthlete.team}/{(selectedAthlete.league||"").toUpperCase()}
                  </span>
                )}
              </label>
              <input style={inp} placeholder="e.g. Nikola Jokic" value={form.playerName}
                onChange={e => onNameChange(e.target.value)}
                onFocus={() => { if (suggestions.length > 0) setShowDrop(true); }}
                onBlur={() => setTimeout(() => setShowDrop(false), 150)}
                autoFocus autoComplete="off" />
              {showDrop && suggestions.length > 0 && (
                <div style={{position:"absolute",top:"100%",left:0,right:0,marginTop:2,
                  background:"#0d1117",border:"1px solid #30363d",borderRadius:6,
                  maxHeight:200,overflowY:"auto",zIndex:10,boxShadow:"0 4px 12px rgba(0,0,0,0.4)"}}>
                  {suggestions.map(a => (
                    <div key={a.id} onMouseDown={e => { e.preventDefault(); pickAthlete(a); }}
                      style={{padding:"7px 10px",fontSize:12,color:"#c9d1d9",cursor:"pointer",
                        display:"flex",alignItems:"center",gap:8,borderBottom:"1px solid #21262d"}}
                      onMouseEnter={e => e.currentTarget.style.background = "#161b22"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <span style={{flex:1}}>{a.name}</span>
                      <span style={{fontSize:10,color:"#8b949e",fontWeight:600}}>{a.team}</span>
                      <span style={{fontSize:9,color:"#484f58",textTransform:"uppercase"}}>{a.league}</span>
                    </div>
                  ))}
                </div>
              )}
              {searching && !showDrop && (
                <div style={{position:"absolute",right:10,top:30,fontSize:10,color:"#484f58"}}>…</div>
              )}
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
