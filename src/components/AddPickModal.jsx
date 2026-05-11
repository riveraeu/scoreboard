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


// Sports that have Kalshi game-total series + sports that have team-total series.
// Mirrors SERIES_CONFIG in api/[...path].js. WNBA has no team totals on Kalshi today.
const TOTAL_SPORTS = ["nba", "wnba", "mlb", "nhl", "nfl"];
const TEAM_TOTAL_SPORTS = ["nba", "mlb"];
const TOTAL_STAT = { mlb: "totalRuns", nba: "totalPoints", wnba: "totalPoints", nhl: "totalGoals", nfl: "totalPoints" };
const TEAM_TOTAL_STAT = { mlb: "teamRuns", nba: "teamPoints" };

function AddPickModal({ onClose, onAdd, initialOdds = "-110" }) {
  const SPORT_STATS = {
    nba: ["points","rebounds","assists","threePointers"],
    wnba: ["points","rebounds","assists","threePointers"],
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
  const SPORT_LABELS = { nba: "NBA", wnba: "WNBA", mlb: "MLB", nhl: "NHL", nfl: "NFL" };
  const suggestUnits = (odds) => { const o = parseInt(odds) || 0; return o <= -900 ? 5 : o <= -400 ? 4 : o <= -200 ? 3 : o <= -110 ? 2 : 1; };

  // pickType: "player" | "total" | "teamTotal"
  const [pickType, setPickType] = React.useState("player");
  const [form, setForm] = React.useState({
    playerName: "", sport: "nba", stat: "points",
    homeTeam: "", awayTeam: "", scoringTeam: "", oppTeam: "",
    threshold: "", americanOdds: initialOdds, truePct: "",
    units: String(suggestUnits(initialOdds)),
    gameDate: new Date().toISOString().slice(0, 10),
    direction: "over"
  });
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
    if (pickType !== "player") { setSuggestions([]); setShowDrop(false); return; }
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
  }, [debouncedName, selectedAthlete, form.playerName, pickType]);

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

  // When pickType changes, reset sport to one that's valid for the new mode
  React.useEffect(() => {
    if (pickType === "teamTotal" && !TEAM_TOTAL_SPORTS.includes(form.sport)) {
      set("sport", "nba");
    } else if (pickType === "total" && !TOTAL_SPORTS.includes(form.sport)) {
      set("sport", "nba");
    }
  }, [pickType]);

  // Reset stat when sport changes (player props only)
  React.useEffect(() => {
    if (pickType === "player") set("stat", SPORT_STATS[form.sport][0]);
  }, [form.sport, pickType]);

  function handleSubmit(e) {
    e.preventDefault();
    const americanOdds = parseInt(form.americanOdds);
    if (isNaN(americanOdds)) return;
    const truePctVal = parseFloat(form.truePct);
    const sportFull = { nba:"basketball/nba", wnba:"basketball/wnba", mlb:"baseball/mlb", nfl:"football/nfl", nhl:"hockey/nhl" }[form.sport];
    const isUnder = form.direction === "under";

    // Same kalshiPct/noKalshiPct + edge math used for player props — user's odds are for
    // the side they're betting; implied probability of that side = market price for that
    // side; truePct entry is "chance the bet hits" so edge math works for both directions.
    const impliedSide = americanOdds < 0
      ? Math.abs(americanOdds) / (Math.abs(americanOdds) + 100) * 100
      : 100 / (americanOdds + 100) * 100;
    const kalshiPctOver = parseFloat((isUnder ? 100 - impliedSide : impliedSide).toFixed(1));
    const noKalshiPctVal = parseFloat((isUnder ? impliedSide : 100 - impliedSide).toFixed(1));
    const truePctOver = !isNaN(truePctVal) ? parseFloat((isUnder ? 100 - truePctVal : truePctVal).toFixed(1)) : null;
    const noTruePctVal = !isNaN(truePctVal) ? parseFloat((isUnder ? truePctVal : 100 - truePctVal).toFixed(1)) : null;
    const edgeVal = !isNaN(truePctVal) ? parseFloat((truePctVal - impliedSide).toFixed(1)) : null;
    const common = {
      sport: form.sport, sportKey: sportFull,
      americanOdds,
      kalshiPct: kalshiPctOver,
      truePct: truePctOver,
      ...(isUnder && { direction: "under", noTruePct: noTruePctVal, noKalshiPct: noKalshiPctVal }),
      edge: edgeVal,
      units: parseFloat(form.units) || 1,
      gameDate: form.gameDate || new Date().toISOString().slice(0, 10),
    };

    if (pickType === "player") {
      const threshold = parseFloat(form.threshold);
      if (!form.playerName.trim() || isNaN(threshold)) return;
      onAdd({
        playerName: form.playerName.trim(),
        ...(selectedAthlete?.id ? { playerId: String(selectedAthlete.id) } : {}),
        ...(selectedAthlete?.team ? { playerTeam: selectedAthlete.team } : {}),
        stat: form.stat,
        threshold,
        ...common,
      });
    } else if (pickType === "total") {
      // Line input is the half-integer (e.g. 7.5); threshold is the ceiling (8) — matches
      // API convention (Math.round(strike + 0.5)) and buildLiveProgress display logic
      // ((threshold - 0.5).toFixed(1)).
      const line = parseFloat(form.threshold);
      if (isNaN(line)) return;
      const threshold = Math.round(line + 0.5);
      const homeTeam = form.homeTeam.trim().toUpperCase();
      const awayTeam = form.awayTeam.trim().toUpperCase();
      if (!homeTeam || !awayTeam) return;
      onAdd({
        gameType: "total",
        homeTeam, awayTeam,
        stat: TOTAL_STAT[form.sport],
        threshold,
        ...common,
      });
    } else if (pickType === "teamTotal") {
      const line = parseFloat(form.threshold);
      if (isNaN(line)) return;
      const threshold = Math.round(line + 0.5);
      const scoringTeam = form.scoringTeam.trim().toUpperCase();
      const oppTeam = form.oppTeam.trim().toUpperCase();
      if (!scoringTeam || !oppTeam) return;
      onAdd({
        gameType: "teamTotal",
        scoringTeam, oppTeam,
        stat: TEAM_TOTAL_STAT[form.sport],
        threshold,
        ...common,
      });
    }
    onClose();
  }

  const inp = { background:"#0d1117", border:"1px solid #30363d", borderRadius:6, color:"#c9d1d9",
    fontSize:13, padding:"7px 10px", width:"100%", outline:"none" };
  const lbl = { color:"#8b949e", fontSize:11, marginBottom:4, display:"block" };

  const sportOptions = pickType === "teamTotal" ? TEAM_TOTAL_SPORTS
    : pickType === "total" ? TOTAL_SPORTS
    : ["nba", "wnba", "mlb", "nfl", "nhl"];

  // Pick type toggle — mirrors the direction (Over/Under) styling
  const typeBtn = (v, label) => {
    const active = pickType === v;
    return (
      <button key={v} type="button" onClick={() => setPickType(v)}
        style={{flex:1,padding:"7px 0",borderRadius:6,fontSize:12,fontWeight:600,cursor:"pointer",
          background: active ? "rgba(88,166,255,0.15)" : "#0d1117",
          border: `1px solid ${active ? "#58a6ff" : "#30363d"}`,
          color: active ? "#58a6ff" : "#8b949e"}}>
        {label}
      </button>
    );
  };

  // "Line" label and placeholder differ by pick type — for player props the input IS the threshold
  // directly (20.5 → stored as 20.5). For totals the user enters the half-integer line shown on the
  // sportsbook (7.5) and we round up to threshold on submit (8) — matches API convention.
  const linePlaceholder = pickType === "player" ? "20.5"
    : pickType === "total" ? (form.sport === "mlb" ? "8.5" : form.sport === "nhl" ? "6.5" : form.sport === "wnba" ? "165.5" : "225.5")
    : (form.sport === "mlb" ? "4.5" : "115.5");

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
            {/* Pick type toggle */}
            <div>
              <label style={lbl}>Pick Type</label>
              <div style={{display:"flex",gap:6}}>
                {typeBtn("player", "Player")}
                {typeBtn("total", "Game Total")}
                {typeBtn("teamTotal", "Team Total")}
              </div>
            </div>

            {/* Player-only fields */}
            {pickType === "player" && (
              <>
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
                      {sportOptions.map(s => <option key={s} value={s}>{SPORT_LABELS[s]}</option>)}
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
              </>
            )}

            {/* Game-total fields */}
            {pickType === "total" && (
              <>
                <div>
                  <label style={lbl}>Sport</label>
                  <select style={inp} value={form.sport} onChange={e => set("sport", e.target.value)} autoFocus>
                    {sportOptions.map(s => <option key={s} value={s}>{SPORT_LABELS[s]}</option>)}
                  </select>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <div>
                    <label style={lbl}>Home Team</label>
                    <input style={inp} placeholder="LAD" value={form.homeTeam}
                      onChange={e => set("homeTeam", e.target.value.toUpperCase())} />
                  </div>
                  <div>
                    <label style={lbl}>Away Team</label>
                    <input style={inp} placeholder="SD" value={form.awayTeam}
                      onChange={e => set("awayTeam", e.target.value.toUpperCase())} />
                  </div>
                </div>
                <div style={{fontSize:10,color:"#484f58",marginTop:-8,marginBottom:-4}}>
                  Use canonical abbrs — e.g. LAD, OKC, GS, LV, CONN. Home team is the bottom team on the sportsbook ticket.
                </div>
              </>
            )}

            {/* Team-total fields */}
            {pickType === "teamTotal" && (
              <>
                <div>
                  <label style={lbl}>Sport</label>
                  <select style={inp} value={form.sport} onChange={e => set("sport", e.target.value)} autoFocus>
                    {sportOptions.map(s => <option key={s} value={s}>{SPORT_LABELS[s]}</option>)}
                  </select>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <div>
                    <label style={lbl}>Scoring Team</label>
                    <input style={inp} placeholder="LAD" value={form.scoringTeam}
                      onChange={e => set("scoringTeam", e.target.value.toUpperCase())} />
                  </div>
                  <div>
                    <label style={lbl}>Opponent</label>
                    <input style={inp} placeholder="SD" value={form.oppTeam}
                      onChange={e => set("oppTeam", e.target.value.toUpperCase())} />
                  </div>
                </div>
                <div style={{fontSize:10,color:"#484f58",marginTop:-8,marginBottom:-4}}>
                  Scoring team is the side whose runs/points you're betting.
                </div>
              </>
            )}

            {/* Common: direction */}
            <div>
              <label style={lbl}>Direction</label>
              <div style={{display:"flex",gap:6}}>
                {[["over","Over"],["under","Under"]].map(([v,l]) => (
                  <button key={v} type="button" onClick={() => set("direction", v)}
                    style={{flex:1,padding:"7px 0",borderRadius:6,fontSize:12,fontWeight:600,cursor:"pointer",
                      background: form.direction === v ? (v === "under" ? "rgba(247,129,102,0.15)" : "rgba(88,166,255,0.15)") : "#0d1117",
                      border: `1px solid ${form.direction === v ? (v === "under" ? "#f78166" : "#58a6ff") : "#30363d"}`,
                      color: form.direction === v ? (v === "under" ? "#f78166" : "#58a6ff") : "#8b949e"}}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            {/* Common: line + odds */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div>
                <label style={lbl}>Line</label>
                <input style={inp} type="number" placeholder={linePlaceholder} step="0.5" value={form.threshold}
                  onChange={e => set("threshold", e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Odds ({form.direction === "under" ? "Under" : "Over"} side)</label>
                <input style={inp} type="number" placeholder="-110" value={form.americanOdds}
                  onChange={e => { setForm(f => ({ ...f, americanOdds: e.target.value, units: String(suggestUnits(e.target.value)) })); }} />
              </div>
            </div>

            {/* Common: true%, units, date */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
              <div>
                <label style={lbl}>True % (chance bet hits)</label>
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
