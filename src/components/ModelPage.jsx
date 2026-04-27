import React from 'react';

function ModelPage({ onBack, calibData, calibLoading, fetchCalib, authToken }) {
  const [tab, setTab] = React.useState("mlb-k");

  // Fetch calibration on first mount when logged in and data not yet loaded
  React.useEffect(() => {
    if (authToken && !calibData && !calibLoading) fetchCalib();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = { // shared style helpers
    card: { background:"#161b22", border:"1px solid #30363d", borderRadius:10, padding:"14px 18px", marginBottom:12 },
    h2:   { color:"#c9d1d9", fontSize:14, fontWeight:700, marginBottom:3 },
    sub:  { color:"#8b949e", fontSize:11, marginBottom:10 },
    h3:   { color:"#58a6ff", fontSize:12, fontWeight:700, marginTop:10, marginBottom:5 },
    p:    { color:"#c9d1d9", fontSize:12, lineHeight:1.65, marginBottom:8 },
    dim:  { color:"#484f58" },
    mono: { fontFamily:"monospace", background:"rgba(88,166,255,0.08)", borderRadius:4, padding:"1px 5px", fontSize:11 },
    green:{ color:"#3fb950" },
    yellow:{ color:"#e3b341" },
    red:  { color:"#f78166" },
    blue: { color:"#58a6ff" },
  };

  const Section = ({ title, children }) => (
    <div style={s.card}>
      <div style={s.h2}>{title}</div>
      {children}
    </div>
  );

  const Formula = ({ children }) => (
    <div style={{background:"#0d1117",border:"1px solid #21262d",borderRadius:8,padding:"10px 14px",
      fontFamily:"monospace",fontSize:12,color:"#c9d1d9",lineHeight:1.8,marginBottom:10,whiteSpace:"pre-wrap"}}>
      {children}
    </div>
  );

  const InputRow = ({ name, color="#c9d1d9", why, tooltip }) => (
    <div style={{display:"flex",gap:10,marginBottom:5,alignItems:"flex-start"}}>
      <div style={{minWidth:190,flexShrink:0,color:color,fontSize:11,fontWeight:600,paddingTop:1}}>
        {name}{tooltip && <span title={tooltip} style={{marginLeft:4,color:"#484f58",fontWeight:400,cursor:"help"}}>ⓘ</span>}
      </div>
      <div style={{color:"#8b949e",fontSize:11,lineHeight:1.55}}>{why}</div>
    </div>
  );

  const ScoreRow = ({ pts, name, tiers, why }) => (
    <div style={{display:"flex",gap:10,marginBottom:6,alignItems:"flex-start"}}>
      <div style={{minWidth:30,flexShrink:0,color:"#e3b341",fontSize:11,fontWeight:700,paddingTop:1}}>{pts}</div>
      <div style={{flex:1}}>
        <div style={{color:"#c9d1d9",fontSize:11,fontWeight:600,marginBottom:2}}>{name}</div>
        <div style={{color:"#8b949e",fontSize:10,marginBottom:2}}>{tiers}</div>
        <div style={{color:"#484f58",fontSize:10,lineHeight:1.5}}>{why}</div>
      </div>
    </div>
  );

  // Tab → calibration category key(s)
  const TAB_CAT = {
    "mlb-k":   ["mlb|strikeouts"],
    "mlb-hrr": ["mlb|hrr"],
    "nba":     ["nba|points","nba|rebounds","nba|assists","nba|threePointers"],
    "nhl":     ["nhl|points"],
    "mlb-gt":  ["mlb|totalRuns"],
    "nba-gt":  ["nba|totalPoints"],
    "nhl-gt":  ["nhl|totalGoals"],
    "mlb-tt":  ["mlb|teamRuns"],
    "nba-tt":  ["nba|teamPoints"],
  };

  const deltaColor = d => d == null ? "#8b949e" : d >= 3 ? "#3fb950" : d <= -3 ? "#f78166" : "#e3b341";
  const barW = pct => pct != null ? `${Math.min(100, pct)}%` : "0%";
  const thCalib = { padding:"5px 10px", color:"#6e7681", fontSize:11, fontWeight:600, textAlign:"left", borderBottom:"1px solid #21262d", whiteSpace:"nowrap" };
  const tdCalib = { padding:"5px 10px", fontSize:11, borderBottom:"1px solid #161b22" };

  // Aggregate multiple bucket arrays (for NBA tabs covering several stats)
  function mergeBuckets(arrays) {
    const LABELS = ["70-75","75-80","80-85","85-90","90-95","95+"];
    const PREDICTED = [72.5, 77.5, 82.5, 87.5, 92.5, 97.5];
    return LABELS.map((label, i) => {
      let wins = 0, n = 0;
      for (const arr of arrays) {
        const b = arr.find(x => x.bucket === label);
        if (b) { wins += Math.round((b.actual ?? 0) / 100 * b.n); n += b.n; }
      }
      const actual = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
      return { bucket: label, predicted: PREDICTED[i], actual, n, delta: actual != null ? parseFloat((actual - PREDICTED[i]).toFixed(1)) : null };
    });
  }

  const CalibModule = ({ tabId }) => {
    const cats = TAB_CAT[tabId] || [];
    const isKTab = tabId === "mlb-k";

    if (!authToken) return (
      <div style={{...s.card, marginTop:8}}>
        <div style={{color:"#484f58", fontSize:12}}>Log in to see calibration data for this model.</div>
      </div>
    );
    if (calibLoading) return (
      <div style={{...s.card, marginTop:8}}>
        <div style={{color:"#8b949e", fontSize:12}}>Loading calibration data…</div>
      </div>
    );
    if (!calibData || calibData.error) return (
      <div style={{...s.card, marginTop:8}}>
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between"}}>
          <div style={{color:"#484f58", fontSize:12}}>{calibData?.error ? `Error: ${calibData.error}` : "Calibration data not yet loaded."}</div>
          <button onClick={fetchCalib} style={{fontSize:11,padding:"3px 10px",borderRadius:6,cursor:"pointer",border:"1px solid #30363d",background:"transparent",color:"#8b949e"}}>Load</button>
        </div>
      </div>
    );

    const { byCategoryDetail, kStrikeouts, finalizedPicks } = calibData;

    // Build bucket rows — merge all cats for this tab
    const catArrays = cats.map(c => byCategoryDetail?.[c]).filter(Boolean);
    const bucketRows = catArrays.length > 0 ? mergeBuckets(catArrays) : [];
    const catTotals = cats.reduce((acc, c) => {
      const d = calibData.byCategory?.[c];
      if (d) { acc.n += d.n; acc.wins += Math.round(d.hitRate / 100 * d.n); }
      return acc;
    }, { n: 0, wins: 0 });
    const catHitRate = catTotals.n > 0 ? (catTotals.wins / catTotals.n * 100).toFixed(1) : null;
    const hasData = catTotals.n > 0;

    return (
      <div style={{...s.card, marginTop:8}}>
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:hasData?12:0}}>
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            <span style={{color:"#c9d1d9", fontSize:13, fontWeight:700}}>Calibration</span>
            {hasData && <span style={{background:"#21262d", color:"#8b949e", fontSize:11, borderRadius:10, padding:"1px 8px"}}>{catTotals.n} picks</span>}
            {hasData && catHitRate && (
              <span style={{color: parseFloat(catHitRate)>=70?"#3fb950":parseFloat(catHitRate)>=60?"#e3b341":"#f78166", fontSize:12, fontWeight:600}}>{catHitRate}% hit rate</span>
            )}
          </div>
          <button onClick={fetchCalib} style={{fontSize:11,padding:"3px 10px",borderRadius:6,cursor:"pointer",border:"1px solid #30363d",background:"transparent",color:"#8b949e"}}>↻</button>
        </div>

        {!hasData ? (
          <div style={{color:"#484f58", fontSize:12}}>No finalized picks yet for this category.</div>
        ) : (
          <>
            {/* truePct bucket table */}
            <table style={{width:"100%",borderCollapse:"collapse",background:"#0d1117",borderRadius:8,overflow:"hidden",border:"1px solid #21262d",marginBottom:isKTab?14:0}}>
              <thead><tr>{["Bucket","N","Predicted","Actual","Delta",""].map(h=><th key={h} style={thCalib}>{h}</th>)}</tr></thead>
              <tbody>
                {bucketRows.map(b => (
                  <tr key={b.bucket}>
                    <td style={tdCalib}><span style={{color:"#c9d1d9"}}>{b.bucket}%</span></td>
                    <td style={{...tdCalib, color:b.n<5?"#484f58":b.n<10?"#6e7681":"#c9d1d9"}}>{b.n||"—"}</td>
                    <td style={{...tdCalib, color:"#8b949e"}}>{b.predicted.toFixed(1)}%</td>
                    <td style={{...tdCalib, color:b.actual==null?"#484f58":b.actual>=70?"#3fb950":b.actual>=60?"#e3b341":"#f78166"}}>{b.actual!=null?`${b.actual}%`:"—"}</td>
                    <td style={{...tdCalib, color:deltaColor(b.delta)}}>{b.delta!=null?(b.delta>=0?`+${b.delta}`:b.delta):"—"}</td>
                    <td style={{...tdCalib, width:120}}>
                      {b.actual!=null&&(
                        <div style={{position:"relative",height:7,background:"#21262d",borderRadius:4,overflow:"hidden"}}>
                          <div style={{position:"absolute",left:0,top:0,height:"100%",width:barW(b.actual),background:b.actual>=70?"#3fb950":b.actual>=60?"#e3b341":"#f78166",borderRadius:4}}/>
                          <div style={{position:"absolute",left:`${b.predicted}%`,top:0,height:"100%",width:2,background:"#58a6ff",opacity:0.8}}/>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* MLB K feature sub-tables */}
            {isKTab && kStrikeouts && kStrikeouts.n > 0 && (
              <div style={{display:"flex", gap:10, flexWrap:"wrap"}}>
                {[
                  { title:"By SimScore", data:kStrikeouts.bySimScore, keyLabel:"Score" },
                  { title:"By K% Tier", data:kStrikeouts.byKpctPts, keyLabel:"Pts" },
                  { title:"By K-Trend", data:kStrikeouts.byKTrendPts, keyLabel:"Pts" },
                  ...(kStrikeouts.byStdBF ? [{ title:"By stdBF", data:kStrikeouts.byStdBF, keyLabel:"BF Var", keyColor: k => k==="low"?"#3fb950":k==="high"?"#f78166":"#8b949e" }] : []),
                ].map(({title,data,keyLabel,keyColor}) => (
                  <div key={title} style={{flex:"1 1 130px",background:"#0d1117",border:"1px solid #21262d",borderRadius:8,overflow:"hidden"}}>
                    <div style={{color:"#8b949e",fontSize:11,fontWeight:600,padding:"5px 10px",borderBottom:"1px solid #21262d"}}>{title}</div>
                    <table style={{width:"100%",borderCollapse:"collapse"}}>
                      <thead><tr>
                        <th style={{...thCalib,padding:"4px 8px"}}>{keyLabel}</th>
                        <th style={{...thCalib,padding:"4px 8px"}}>N</th>
                        <th style={{...thCalib,padding:"4px 8px"}}>Hit%</th>
                      </tr></thead>
                      <tbody>
                        {Object.entries(data).map(([k,d])=>(
                          <tr key={k}>
                            <td style={{...tdCalib,padding:"4px 8px",color:keyColor?keyColor(k):"#c9d1d9"}}>{k}</td>
                            <td style={{...tdCalib,padding:"4px 8px",color:d.n<5?"#6e7681":"#c9d1d9"}}>{d.n}</td>
                            <td style={{...tdCalib,padding:"4px 8px",color:d.hitRate>=70?"#3fb950":d.hitRate>=60?"#e3b341":"#f78166",fontWeight:600}}>{d.hitRate}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const TAB_ROWS = [
    { sport:"MLB", tabs:[
      { id:"mlb-k",   label:"MLB Strikeouts" },
      { id:"mlb-hrr", label:"MLB H+R+RBI" },
      { id:"mlb-gt",  label:"MLB Game Total" },
      { id:"mlb-tt",  label:"MLB Team Total" },
    ]},
    { sport:"NBA", tabs:[
      { id:"nba",    label:"NBA Props" },
      { id:"nba-gt", label:"NBA Game Total" },
      { id:"nba-tt", label:"NBA Team Total" },
    ]},
    { sport:"NHL", tabs:[
      { id:"nhl",    label:"NHL Points" },
      { id:"nhl-gt", label:"NHL Game Total" },
    ]},
  ];
  const TABS = TAB_ROWS.flatMap(r => r.tabs);

  const content = {
    "mlb-k": (
      <>
        <Section title="MLB Strikeouts — True% Model">
          <div style={s.sub}>Computes P(strikeouts ≥ threshold) via Monte Carlo simulation (5k–10k trials based on SimScore)</div>

          <div style={s.h3}>Core Formula</div>
          <Formula>{`For each simulated trial:
  trialPA ~ Normal(avgBF, stdBF)          ← per-trial BF variance, clamped [10,27]
  [blowout hook: ~8–18% chance → trialPA = rand[10,15] based on team ML odds]
  For each batter in trialPA:
    if batter# ≥ 19: pitcherK% × 0.88    ← TTO decay (3rd time through order)
    P(K) = log5(pitcherK%, batterK%)      ← matchup-specific probability
  total Ks = sum of K outcomes across trialPA batters
truePct = fraction of trials where total ≥ threshold`}</Formula>

          <div style={s.h3}>Model Inputs</div>
          <InputRow name="Pitcher K%" tooltip="regressed toward 2025 anchor" color="#3fb950"
            why="Core signal. Regressed toward 2025 season anchor (or 22.2% league avg) weighted by 2026 batters faced ÷ 200. Prevents small-sample overfit — a pitcher with 2 starts isn't trusted at face value." />
          <InputRow name="A1 — Recent form" tooltip="last 5 starts" color="#3fb950"
            why="Effective K% = 60% recent + 40% season when ≥3 starts and 30+ total BF. Captures momentum: a pitcher in a 3-start hot streak is more predictive for tonight than their full-season average." />
          <InputRow name="A2 — Rest / fatigue" color="#e3b341"
            why="≤3 days rest → K% ×0.96. ≤3 days AND last start ≥95 pitches → ×0.92. Short rest after heavy workload produces measurable decline in swing-and-miss rate." />
          <InputRow name="Batter K%" tooltip="lineup composite, hand-adjusted vs starter" color="#3fb950"
            why="Strikeouts require both pitcher and batter. A lineup full of high-K batters amplifies the pitcher. Adjusted for LHP/RHP split since platoon splits are large (batters K more vs same-hand pitchers)." />
          <InputRow name="E3b — Expected BF" tooltip="empirical avgBF from pitcher gamelog" color="#e3b341"
            why="Pitcher-specific average batters faced per start, computed from their MLB gamelog (NP≥30 starts only). High-walk or deep-count pitchers face fewer batters than average — this directly lowers the K ceiling. Falls back to avgPitches ÷ 3.85 when gamelog data is absent." />
          <InputRow name="stdBF variance" color="#8b949e"
            why="Each trial samples trialPA from Normal(avgBF, stdBF) rather than using a fixed number. stdBF is the empirical standard deviation of BF across the pitcher's qualified starts (≥3 required). Reflects real pitch-count variability: some nights a pitcher goes 7 deep, others they're pulled after 4. Uses scoped Box-Muller to avoid cross-request state." />
          <InputRow name="TTO decay" tooltip="applied inside simulation at BF ≥ 19" color="#8b949e"
            why="The 3rd time through the order, batters K at ~12% lower rates league-wide as they adjust to the pitcher's tendencies. Applied inside each trial at BF ≥ 19 as ×0.88. Effect: −0.15 to −0.25 projected Ks for workhorses (avgBF ≥ 22); negligible for pitch-limited starters." />
          <InputRow name="Blowout hook" tooltip="earlyExitProb derived from ML odds" color="#8b949e"
            why="When a pitcher's team is a large underdog (+150 or worse), there's a meaningful chance they get pulled early if the game gets out of hand. ML odds map to early-exit probability: +150→8%, +200→12%, +250+→18%. Each trial independently rolls whether the pitcher is clipped at 10–15 BF." />
          <InputRow name="E3a — Umpire K-factor" color="#e3b341"
            why="Known in advance. Plate umpires vary ~10–15% in strikeout rate (range 0.89–1.12×). Applied directly to pitcherK% before simulation. Unknown umpires → 1.0 (no adjustment)." />
          <InputRow name="Park K-factor" color="#8b949e"
            why="Applied inside simulation. Colorado's thin air reduces spin effectiveness; other parks have structural effects. Built from FanGraphs multi-year SO park factors." />
        </Section>

        <Section title="MLB Strikeouts — SimScore (max 10)">
          <div style={s.sub}>5 components × 2 pts each. Gate: finalSimScore ≥ 8 to qualify as a play.</div>
          <ScoreRow pts="0–2" name="CSW% / K% tier"
            tiers="CSW% ≥30% → 2pts · CSW% >26% → 1pt · ≤26% → 0pts (fallback: K% >27%→2, >24%→1)"
            why="Called Strikes + Whiffs is a better single-start predictor than K% alone because it captures command quality and swing generation. K% can be inflated by opponent quality; CSW is pitcher-intrinsic." />
          <ScoreRow pts="0–2" name="K-BB% (command)"
            tiers=">18% → 2pts · >12% → 1pt · ≤12% → 0pts"
            why="Pitchers who also walk batters have higher variance outcomes. High K-BB means dominant command — strikeouts without the wildness that cuts into BF and pitch count." />
          <ScoreRow pts="0–2" name="Lineup oK% (opponent K-rate)"
            tiers=">24% → 2pts · >22% → 1pt · ≤22% → 0pts"
            why="Facing a high-K lineup increases the probability of each K event. Hand-adjusted (vs RHP or LHP batters). This is the opportunity signal — even the best pitcher needs hitters who swing and miss." />
          <ScoreRow pts="0–2" name="Blended Hit Rate"
            tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts"
            why="Trust-weighted blend of 2026 observed hit rate at this threshold and 2025 computed rate. The pitcher's own historical rate is the strongest calibration signal — if they've hit this K total in 90% of starts, the model's simulation is well-supported." />
          <ScoreRow pts="0–2" name="Game O/U line"
            tiers="≤7.5 → 2pts · &lt;10.5 → 1pt · ≥10.5 → 0pts"
            why="Low totals signal pitcher-dominant conditions. The betting market incorporates weather, ballpark, and other factors we may not have. A consensus O/U ≤7.5 is independent confirmation of a pitchers' duel." />
        </Section>
      </>
    ),
    "mlb-hrr": (
      <>
        <Section title="MLB H+R+RBI — True% Model">
          <div style={s.sub}>Blended formula — no Monte Carlo. Averages two rate components, then applies park adjustment via log-odds transform.</div>

          <div style={s.h3}>Core Formula</div>
          <Formula>{`rawMlbPct = (primaryPct + softPct) / 2

// Park factor via log-odds (prevents exceeding 100% at elite rates in hitter parks)
logOddsAdj = logit(rawMlbPct ÷ 100) + ln(parkFactor)
truePct = sigmoid(logOddsAdj) × 100

primaryPct = player's 2026 HRR 1+ rate
  (blended with 2025 season if trust26 < 1.0, where trust26 = min(1, games26 ÷ 30))

softPct = HRR 1+ rate vs tonight's pitcher (H2H gamelog, requires ≥5 games)
  OR platoon-adjusted rate if H2H < 5 games:
       softPct = primaryPct × (splitBA_vsHand ÷ seasonBA)
       (softLabel updates to "vs RHP" or "vs LHP")
  OR team-level rate vs opponent if splitBA/seasonBA unavailable

parkFactor = PARK_HITFACTOR[homeTeam]`}</Formula>

          <div style={s.h3}>Model Inputs</div>
          <InputRow name="2026 HRR rate" tooltip="primaryPct — blended 2026/2025 hit rate" color="#3fb950"
            why="Base rate: how often does this player record at least 1 H+R+RBI in a game this season. Trust-weighted against 2025 so early-season small samples don't wildly over- or under-predict." />
          <InputRow name="H2H vs pitcher" tooltip="softPct — hit rate in direct matchup history (≥12 games)" color="#3fb950"
            why="Head-to-head matchup history vs tonight's exact pitcher. Requires ≥5 gamelog dates. When ≥12 H2H games exist, this also drives 2pts in the Matchup Rate SimScore component." />
          <InputRow name="Platoon-adjusted fallback" tooltip="softPct when H2H < 12 games — uses batter vsL/vsR BA split" color="#e3b341"
            why="When pitcher H2H < 5 games (~90% of matchups), falls back to primaryPct × (batter's BA vs pitcher's hand ÷ season BA). Captures the directional platoon split without needing a large H2H sample." />
          <InputRow name="B2 — Recent form" tooltip="last 10 games — 0.3/0.7 blend with season rate when ≥20 AB" color="#e3b341"
            why="hitterEffectiveBA = 0.3 × recentBA + 0.7 × seasonBA when ≥20 AB in last 10 games, fed into simulateHits. Weight is 0.3/0.7 (reduced from 0.6/0.4) — 40 PAs is deep in BABIP noise; this still catches real slumps without letting a bad week hijack a season baseline." />
          <InputRow name="Park factor" tooltip="PARK_HITFACTOR — applied via log-odds to prevent >100% distortion" color="#8b949e"
            why="Applied via log-odds transform (not direct multiply) so the combined rate can't exceed 100% even for elite batters at Coors Field." />
        </Section>

        <Section title="MLB H+R+RBI — SimScore (max 10)">
          <div style={s.sub}>5 components × 2 pts each. Gate: hitterFinalSimScore ≥ 8 to qualify.</div>
          <ScoreRow pts="0–2" name="Batter Quality (spot + barrel%)"
            tiers="Spot ≤5 + barrel% ≥10% → 2pts · either → 1pt · neither → 0pts"
            why="Lineup spots 1–5 capture both PA equity (top of order) and RBI equity (cleanup/5-hole sluggers). Barrel% ≥10% means hard contact quality. Combined, they measure both opportunity and execution." />
          <ScoreRow pts="0–2" name="Pitcher WHIP"
            tiers=">1.35 → 2pts · >1.20 → 1pt · ≤1.20 → 0pts"
            why="WHIP directly measures baserunner creation rate. A pitcher with WHIP >1.35 allows 35%+ more baserunners than a perfect game. More baserunners = more scoring chances = more HRR opportunities." />
          <ScoreRow pts="0–2" name="Season Hit Rate"
            tiers="≥80% → 2pts · ≥70% → 1pt · &lt;70% → 0pts"
            why="The player's own historical HRR 1+ rate at this threshold, blended 2026/2025. The most direct calibration signal — if a player records HRR in 80%+ of games, the model's output should be in that range." />
          <ScoreRow pts="0–2" name="Matchup Rate"
            tiers="BvP path (≥12 H2H games): ≥80% → 2pts · ≥70% → 1pt · else → 0pts · 8–11 games caps at 1pt · Platoon path (&lt;12 games): advantage ≥1.08 → 2pts · neutral ≥0.95 → 1pt · disadvantage → 0pts"
            why="Platoon-adjusted rate is the primary signal for ~90% of matchups. BvP (≥12 H2H games, ~35+ PAs) is a mature enough sample to override the platoon path. Below 12 games, the platoon advantage/disadvantage (batter's split BA vs pitcher's hand relative to season BA) is used instead." />
          <ScoreRow pts="0–2" name="Game O/U line"
            tiers="≥9.5 → 2pts · ≥7.5 → 1pt · &lt;7.5 → 0pts"
            why="High-scoring game environments increase HRR probability — more runs scored means more R/RBI available. A game with O/U ≥9.5 has consensus expectations of a high-scoring affair." />
        </Section>
      </>
    ),
    "nba": (
      <>
        <Section title="NBA Player Props — True% Model">
          <div style={s.sub}>Normal distribution Monte Carlo (nSim scales 2k–10k based on pre-edge SimScore)</div>

          <div style={s.h3}>Core Formula</div>
          <Formula>{`Build distribution: buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim, miscAdj)

adjustedMean = recentMean × dvpFactor × (1 + paceAdj×0.002) × b2bMult × miscAdj

where:
  recentMean = average of last 10 games (recency)
  fullSeasonStd = standard deviation from full season (stability)
  dvpFactor = leagueAvg / oppDefensiveValue (position-adjusted)
  paceAdj = (oppPace - leagueAvgPace) → more possessions = higher stat
  b2bMult = 0.93 if back-to-back, else 1.0
  miscAdj = C2 × C3 × C4 combined scalar`}</Formula>

          <div style={s.h3}>Model Inputs</div>
          <InputRow name="Last 10 game values" tooltip="mean used for recency; full-season std used for stability" color="#3fb950"
            why="Recency-weighted mean: a player's last 10 games reflect current role, health, and form better than a season average that includes early-season lineup changes or pre-injury games." />
          <InputRow name="Full season std deviation" color="#3fb950"
            why="Variance is a player trait more stable than mean. Using full season prevents one outlier game from inflating the distribution width." />
          <InputRow name="DVP" tooltip="Defense vs Position — opponent's rate of allowing this stat to this position" color="#3fb950"
            why="Position-adjusted opponent defense. A PG scoring 25 PPG vs a team that allows 28 PPG to PGs (vs 24 league avg) gets a ~17% boost. The most important external factor." />
          <InputRow name="Pace adjustment" color="#e3b341"
            why="More possessions = more opportunities. A 5-possession pace advantage translates to ~1% mean boost. Applied continuously, not binary." />
          <InputRow name="C2 — Injury boost" color="#e3b341"
            why="×1.08 per key teammate Out (capped 1.15×). Missing teammates create a usage vacuum — the remaining players absorb extra shot attempts, assists, and minutes." />
          <InputRow name="C3 — Blowout risk" color="#e3b341"
            why="max(0.85, 1 − (|spread|−10)×0.007) when |spread|>10. Garbage time = reduced minutes for starters. A 15-point spread reduces expected output ~3.5%." />
          <InputRow name="C4 — Home/Away split" color="#e3b341"
            why="0.7 × homeMean + 0.3 × awayMean (or inverse for road games), vs overall mean. Many players have systematic home/away splits that persist over seasons." />
          <InputRow name="B2B" tooltip="back-to-back — mean ×0.93 when player played yesterday" color="#8b949e"
            why="×0.93 across the board. Statistically proven ~7% per-game decline on the second night of back-to-backs. Applied to mean before simulation." />
        </Section>

        <Section title="NBA Props — SimScore (max 10)">
          <div style={s.sub}>5 components × 2 pts each. Gate: nbaSimScore ≥ 8.</div>
          <ScoreRow pts="0–2" name="C1 — Opportunity signal"
            tiers="USG% ≥28% → 2pts · ≥22% → 1pt · &lt;22% → 0pts (pts/ast/3pt) | AvgMin ≥30 → 2pts · ≥25 → 1pt (reb)"
            why="Different stats need different opportunity proxies. Usage rate drives points/assists/3-pointers — a player can't rack up stats without the ball. Minutes drives rebounds — floor time is the primary rebounding opportunity." />
          <ScoreRow pts="0–2" name="DVP ratio (pos-adjusted)"
            tiers="ratio ≥1.05 → 2pts · ratio ≥1.02 → 1pt · else 0pts"
            why="Quantifies how much worse the opponent's defense is vs league average at this position. A ratio of 1.10 means the opponent allows 10% more of this stat than average — a meaningful, reproducible edge." />
          <ScoreRow pts="0–2" name="Season Hit Rate"
            tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts"
            why="Player's blended 2026/2025 rate at this threshold. The base rate calibration — if a player hits 25+ points in 90% of games, the model's 87% truePct needs to be at least in that ballpark." />
          <ScoreRow pts="0–2" name="Soft Matchup Hit Rate"
            tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts · null → 1pt abstain"
            why="Hit rate specifically against bottom-tier defenses (similar to tonight's opponent). More comparable to the actual matchup than the overall rate. Null when no soft-team games in sample." />
          <ScoreRow pts="0–2" name="Pace + Game Total"
            tiers="Both favorable (pace>0 AND total ≥225) → 2pts · one → 1pt · neither → 0pts"
            why="Pace and game total are independent corroborating signals. A fast-paced game with a high market O/U means both teams are expected to score — two separate sources of evidence vs one." />
        </Section>
      </>
    ),
    "nhl": (
      <>
        <Section title="NHL Points — True% Model">
          <div style={s.sub}>Normal distribution Monte Carlo (same engine as NBA, adapted for hockey)</div>

          <div style={s.h3}>Core Formula</div>
          <Formula>{`adjustedMean = recentMean × teamDefFactor × toiTrendAdj × b2bMult

where:
  recentMean = average points per game (recent games)
  teamDefFactor = oppGAA / leagueAvgGAA  (higher GAA = softer defense = boost)
  toiTrendAdj = clamp(recent3TOI / last10TOI, 0.92, 1.08)
    applied only when ratio >1.05 (boost) or <0.95 (penalty)
  b2bMult = 0.93 if back-to-back`}</Formula>

          <div style={s.h3}>Model Inputs</div>
          <InputRow name="Per-game point values (mean)" color="#3fb950"
            why="Points (G+A) per game from recent gamelog. NHL scoring is sparse — 0 or 1 is typical — so the distribution is a normal approximation over historical rates." />
          <InputRow name="Opponent GAA" tooltip="goals-against average — higher = weaker defense = more expected scoring" color="#3fb950"
            why="GAA is the primary defensive quality signal in hockey. A goalie/team with GAA 3.5 allows 40% more goals than one at 2.5 — directly translating to more scoring opportunities and higher assist generation." />
          <InputRow name="D3 — TOI trend" color="#e3b341"
            why="Ice time is the primary opportunity driver in hockey. A player whose last 3 games averaged 21 min vs their 10-game avg of 18 min is getting more deployment — that trend is predictive. Declining TOI is a strong negative signal the stats alone won't capture." />
          <InputRow name="B2B" tooltip="back-to-back — mean ×0.93 when player played yesterday" color="#8b949e"
            why="Same logic as NBA. ×0.93 for second-night games. NHL schedule has frequent back-to-backs that produce real fatigue effects." />
        </Section>

        <Section title="NHL Points — SimScore (max 10)">
          <div style={s.sub}>5 components × 2 pts each. Gate: nhlSimScore ≥ 8.</div>
          <ScoreRow pts="0–2" name="Avg TOI (ice time)"
            tiers="≥18 min → 2pts · ≥15 min → 1pt · &lt;15 min → 0pts"
            why="Ice time is the direct opportunity signal in hockey. 18+ minutes means the player is a top-pair/top-line contributor with consistent deployment. Under 15 means limited role — even a great matchup won't help much." />
          <ScoreRow pts="0–2" name="Opponent GAA rank"
            tiers="≤10th worst → 2pts · ≤15th worst → 1pt · else 0pts"
            why="Ranking captures relative weakness vs absolute numbers. A bottom-10 goaltending situation is actionable; middle-of-pack defenses provide little edge." />
          <ScoreRow pts="0–2" name="Season Hit Rate"
            tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts"
            why="Player's career hit rate at this threshold across all games. The base-rate calibration for the simulation output." />
          <ScoreRow pts="0–2" name="DVP Hit Rate (vs soft defenses)"
            tiers="≥90% → 2pts · ≥80% → 1pt · &lt;80% → 0pts · &lt;3 games → 1pt abstain"
            why="Rate specifically in games vs teams with GAA above league average (similar to tonight). Direct analogue to the actual matchup conditions." />
          <ScoreRow pts="0–2" name="Game O/U line"
            tiers="≥7 → 2pts · ≥5.5 → 1pt · &lt;5.5 → 0pts"
            why="Market consensus on game scoring. A high O/U line means more expected goals, which means more scoring chances and more assist opportunities for all players on both teams." />
        </Section>
      </>
    ),
    "mlb-gt": (
      <>
        <Section title="MLB Game Total — True% Model">
          <div style={s.sub}>Poisson Monte Carlo (10,000 trials). Models each team's run-scoring independently.</div>

          <div style={s.h3}>Core Formula</div>
          <Formula>{`// Road RPG strips home-park bias — parkRF applies cleanly
// 60/40 blend: 60% tonight's starter ERA, 40% season team ERA (bullpen proxy)
awayMult = 0.6×(awayERA÷4.20) + 0.4×(awayTeamERA÷4.20)
homeMult = 0.6×(homeERA÷4.20) + 0.4×(homeTeamERA÷4.20)

// platoonFactor = (lineup BA vs opposing starter's hand) / (lineup overall BA)
// Derived from individual batter vsL/vsR splits — falls back to 1.0 when unknown
homeLambda = clamp(homeRoadRPG × awayMult × parkRF × homePlatoonFactor, 1, 12)
awayLambda = clamp(awayRoadRPG × homeMult × parkRF × awayPlatoonFactor, 1, 12)

Each trial: homeRuns ~ Poisson(homeLambda), awayRuns ~ Poisson(awayLambda)
truePct = fraction of trials where homeRuns + awayRuns ≥ threshold`}</Formula>

          <div style={s.h3}>Model Inputs</div>
          <InputRow name="Road RPG" tooltip="away-only runs per game — strips home-park inflation" color="#3fb950"
            why="Offensive baseline using only road games — eliminates home park inflation before parkRF is applied. A team at Coors averages 5.8 RPG overall but 4.9 on the road; using road RPG lets parkRF do its job cleanly without double-counting." />
          <InputRow name="Starter ERA + Team ERA" tooltip="60/40 blend — starter governs ~5.5 IP, team ERA proxies bullpen" color="#3fb950"
            why="Tonight's starter governs 60% of innings (~5.5 IP). The team's season ERA governs 40% (bullpen). Using a blend prevents an ace from dragging a shaky pen's expected runs to zero — and regresses a spot-starter's tiny 3-start ERA toward team reality." />
          <InputRow name="Platoon factor" tooltip="lineup composite BA vs starter's hand ÷ overall BA" color="#3fb950"
            why="A dimensionless ratio: (lineup composite BA vs LHP or RHP) / (lineup overall BA), aggregated across tonight's confirmed lineup. A left-heavy lineup facing a tough LHP gets a factor below 1.0; a right-dominant lineup facing a RHP gets a slight boost. Park effects cancel in the ratio. Falls back to 1.0 when starter hand is unknown or lineup sample is too small." />
          <InputRow name="Park run factor" tooltip="PARK_RUNFACTOR — applied to road RPG; symmetric since both teams play same park" color="#e3b341"
            why="Applied cleanly to road RPG numerator. Coors Field +15%; Petco Park −10%. Both teams play the same park, so the factor is symmetric." />
          <InputRow name="Market O/U line" color="#8b949e"
            why="Used in SimScore as a corroborating signal. The market incorporates weather, wind, and lineup factors not in our model." />
        </Section>

        <Section title="MLB Game Total — SimScore (max 10)">
          <div style={s.sub}>5 components × 2 pts each. Gate: totalSimScore ≥ 8 (OVER). Inverted for UNDER.</div>
          <ScoreRow pts="0–2" name="Home ERA"
            tiers=">4.5 → 2pts · >3.5 → 1pt · ≤3.5 → 0pts"
            why="High ERA = hittable pitcher = more expected runs. Kept as an independent component because it directly sets the ERA-multiplier inside the lambda formula." />
          <ScoreRow pts="0–2" name="Away ERA"
            tiers=">4.5 → 2pts · >3.5 → 1pt · ≤3.5 → 0pts"
            why="Same as home ERA — each starter contributes independently to the scoring environment." />
          <ScoreRow pts="0–2" name="Combined road RPG"
            tiers="≥10.5 → 2pts · ≥9.0 → 1pt · &lt;9.0 → 0pts"
            why="Sum of both teams' road RPG. Consolidates two separate RPG signals into one — confirms both offenses are genuinely high-scoring on neutral turf before parkRF is applied." />
          <ScoreRow pts="0–2" name="Umpire run factor"
            tiers="≥1.05 → 2pts · ≥0.97 → 1pt · &lt;0.97 → 0pts"
            why="Derived from UMPIRE_KFACTOR (1 / kFactor). A loose-zone umpire (low K-factor) generates more walks and hitter-friendly counts, correlating with higher run-scoring. Fully independent of team stats — the first true external validator in the SimScore." />
          <ScoreRow pts="0–2" name="Market O/U line"
            tiers="≥9.5 → 2pts · ≥7.5 → 1pt · &lt;7.5 → 0pts"
            why="Independent corroboration from the betting market. When both the model and the market are bullish on scoring, confidence is higher." />
        </Section>
      </>
    ),
    "nba-gt": (
      <>
        <Section title="NBA Game Total — True% Model">
          <div style={s.sub}>Normal distribution Monte Carlo. Possession-based projection separates scoring efficiency from game tempo.</div>

          <div style={s.h3}>Core Formula</div>
          <Formula>{`projPace = (homePace × awayPace) / leagueAvgPace   ← geometric mean

homeExpected = (homeOffRtg × awayDefRtg / leagueAvgOffRtg²) × projPace
awayExpected = (awayOffRtg × homeDefRtg / leagueAvgOffRtg²) × projPace
expectedTotal = homeExpected + awayExpected

Distribution: Normal(expectedTotal, std=11 per team)
truePct = P(total ≥ threshold)

All ratings: pts per 100 possessions (regular season, seasontype=2)`}</Formula>

          <div style={s.h3}>Model Inputs</div>
          <InputRow name="Offensive Rating (OffRtg)" tooltip="Points scored per 100 possessions — efficiency-only, pace-neutral" color="#3fb950"
            why="Raw PPG conflates pace and efficiency, double-counting tempo when two fast teams meet. OffRtg isolates how well a team scores per possession, independent of how many possessions they get." />
          <InputRow name="Defensive Rating (DefRtg)" tooltip="Points allowed per 100 possessions — lower = better defense" color="#3fb950"
            why="Symmetric to OffRtg. A high DefRtg (e.g. 118) means the defense leaks points per possession, which the model uses to boost the opponent's expected output for this specific matchup." />
          <InputRow name="Projected pace (geometric mean)" tooltip="(homePace × awayPace) / leagueAvgPace — possessions per game" color="#3fb950"
            why="Pace controls volume: two fast teams playing each other produce more possessions than their individual pace numbers suggest. The geometric mean correctly captures this compounding effect (vs simple average which underestimates extremes)." />
          <InputRow name="League avg offensive rating" color="#8b949e"
            why="Normalization denominator. Squaring it (leagueAvgOffRtg²) balances the fact that both OffRtg and DefRtg are in the numerator, keeping the expected value centered at league-average total when both teams are average." />
        </Section>

        <Section title="NBA Game Total — SimScore (max 10)">
          <div style={s.sub}>5 independent validators × 2 pts each. Gate: totalSimScore ≥ 8. Inverted for UNDER. Pace and injuries are not in the projection formula — they provide structurally independent confirmation.</div>
          <ScoreRow pts="0–2" name="Combined pace"
            tiers="Both > lgAvg+2 → 2pts · One > lgAvg → 1pt · else 0pts · null → 1pt abstain"
            why="Validates the volume assumption: fast-paced teams have more possessions and thus more scoring opportunities. If neither team plays fast, the projection needs pace-neutral offense to justify the threshold — a harder bar." />
          <ScoreRow pts="0–2" name="Home team OffRtg"
            tiers="≥118 → 2pts · ≥113 → 1pt · <113 → 0pts · null → 1pt abstain"
            why="Elite offenses (top-5) reliably push totals over mid-range thresholds. The 118/113 tiers match league percentile breaks for the top ~25% and top ~50% of offenses." />
          <ScoreRow pts="0–2" name="Away team OffRtg"
            tiers="≥118 → 2pts · ≥113 → 1pt · <113 → 0pts · null → 1pt abstain"
            why="Same logic applied to the road team. Both offenses must be productive to sustain high totals — one elite offense against a stingy defense can still produce a low game." />
          <ScoreRow pts="0–2" name="Combined injuries (both teams)"
            tiers="0 out → 2pts · 1–2 out → 1pt · 3+ out → 0pts · null → 1pt abstain"
            why="Season OffRtg/DefRtg assumes the full roster is playing. Stars sitting out (load management, rest, injury) directly depress scoring without appearing in the ratings. This component catches that blind spot. UNDER inverted: 3+ out → 2pts." />
          <ScoreRow pts="0–2" name="Market O/U line"
            tiers="≥235 → 2pts · ≥225 → 1pt · <225 → 0pts · null → 1pt abstain"
            why="The sharpest independent validator available. Vegas sets lines after seeing the same OffRtg, DefRtg, pace, and injury data — agreement between the model and the market is meaningful confirmation that the environment supports the threshold." />
        </Section>
      </>
    ),
    "nhl-gt": (
      <>
        <Section title="NHL Game Total — True% Model">
          <div style={s.sub}>Poisson Monte Carlo. Each team's goals modeled as independent Poisson processes.</div>

          <div style={s.h3}>Core Formula</div>
          <Formula>{`homeLambda = clamp(homeGPG × (awayGAA / leagueAvgGAA), 0.5, 8)
awayLambda = clamp(awayGPG × (homeGAA / leagueAvgGAA), 0.5, 8)

Each trial: homeGoals ~ Poisson(homeLambda), awayGoals ~ Poisson(awayLambda)
truePct = fraction of trials where homeGoals + awayGoals ≥ threshold`}</Formula>

          <div style={s.h3}>Model Inputs</div>
          <InputRow name="Team GPG" tooltip="goals per game — season scoring rate per team" color="#3fb950"
            why="Offensive baseline. How many goals does this team score against an average goalie?" />
          <InputRow name="Opponent GAA" tooltip="goals-against average — higher = weaker defense = more expected scoring" color="#3fb950"
            why="Defensive quality. A GAA of 3.5 means the goalie/defense allows 40% more goals than a 2.5 GAA team — a large effect on expected scoring." />
          <InputRow name="League avg GAA" color="#8b949e"
            why="Normalization. Dividing opponent GAA by league avg converts it to a relative defensive quality factor (1.0 = average, >1.0 = above average = more goals expected)." />
        </Section>

        <Section title="NHL Game Total — SimScore (max 10)">
          <div style={s.sub}>5 components × 2 pts each. Gate: totalSimScore ≥ 8. Inverted for UNDER.</div>
          <ScoreRow pts="0–2" name="Home GPG"
            tiers="≥3.5 → 2pts · ≥3.0 → 1pt · &lt;3.0 → 0pts"
            why="High-scoring team increases expected total. Two independent GPG inputs because both teams contribute." />
          <ScoreRow pts="0–2" name="Away GPG"
            tiers="≥3.5 → 2pts · ≥3.0 → 1pt · &lt;3.0 → 0pts"
            why="Same — away team offense contributes independently." />
          <ScoreRow pts="0–2" name="Home GAA"
            tiers="≥3.5 → 2pts · ≥3.0 → 1pt · &lt;3.0 → 0pts"
            why="Bad goaltending/defense (high GAA) means more goals allowed — good for overs. Both GAA inputs score the same way as GPG." />
          <ScoreRow pts="0–2" name="Away GAA"
            tiers="≥3.5 → 2pts · ≥3.0 → 1pt · &lt;3.0 → 0pts"
            why="Same — away goaltending quality affects home team's expected goal count." />
          <ScoreRow pts="0–2" name="Market O/U line"
            tiers="≥7 → 2pts · ≥5.5 → 1pt · &lt;5.5 → 0pts"
            why="Independent market signal. NHL lines near 7 reflect expectations of two aggressive offenses or poor goaltending. Lines below 5.5 signal a likely defensive, low-scoring game." />
        </Section>
      </>
    ),
    "mlb-tt": (
      <>
        <Section title="MLB Team Total — True% Model">
          <div style={s.sub}>Poisson Monte Carlo for a single team's run-scoring. Same engine as game totals, one team only.</div>

          <div style={s.h3}>Core Formula</div>
          <Formula>{`// platoonFactor = (lineup BA vs opp starter's hand) / (lineup overall BA)
lambda = clamp(teamRPG × (oppERA ÷ 4.20) × parkRF × platoonFactor, 0.5, 12)

Each trial: teamRuns ~ Poisson(lambda)
truePct = fraction of trials where teamRuns ≥ threshold`}</Formula>

          <div style={s.h3}>Model Inputs</div>
          <InputRow name="Scoring team RPG" color="#3fb950"
            why="Baseline offensive production. How many runs does this team score per game against average pitching?" />
          <InputRow name="Opponent starter ERA" color="#3fb950"
            why="Tonight's pitcher quality for the opponent. A 5.5 ERA pitcher allows 31% more runs than the 4.20 league average." />
          <InputRow name="Platoon factor" tooltip="lineup composite BA vs starter's hand ÷ overall BA" color="#3fb950"
            why="Same as game total — (lineup composite BA vs starter's hand) / (lineup overall BA). Captures the scoring team's platoon advantage or disadvantage against tonight's starter. Falls back to 1.0 when hand or lineup data is unavailable." />
          <InputRow name="Park run factor" color="#e3b341"
            why="Same as game total. Both teams play in the same park, so a hitter-friendly environment boosts the scoring team's expected runs. Applied directly to lambda — not a SimScore component." />
        </Section>

        <Section title="MLB Team Total — SimScore (max 10)">
          <div style={s.sub}>5 components × 2 pts each. Gate: teamTotalSimScore ≥ 8.</div>
          <ScoreRow pts="0–2" name="Umpire run factor"
            tiers="≥1.05 → 2pts · ≥0.97 → 1pt · &lt;0.97 → 0pts · unknown → 1pt abstain"
            why="Home plate umpires have measurable, persistent tendencies for run-scoring environments. A factor ≥1.05 means the umpire's strike zone historically produces 5%+ more runs than average — a meaningful environmental edge independent of team or pitcher quality." />
          <ScoreRow pts="0–2" name="Opponent WHIP"
            tiers="&gt;1.35 → 2pts · &gt;1.20 → 1pt · ≤1.20 → 0pts · null → 1pt abstain"
            why="WHIP captures both hits and walks — total baserunner traffic — which is more directly tied to run-scoring than ERA alone. A pitcher with WHIP >1.35 is putting runners on base at a rate that consistently translates to runs." />
          <ScoreRow pts="0–2" name="Team L10 RPG"
            tiers="&gt;5.0 → 2pts · &gt;4.0 → 1pt · ≤4.0 → 0pts · null → 1pt abstain"
            why="The team's run-scoring rate over the last 10 games. Recent form is a better predictor than season RPG because it captures current lineup health, hot/cold streaks, and recent scheduling effects." />
          <ScoreRow pts="0–2" name="H2H Hit Rate"
            tiers="≥80% → 2pts · ≥60% → 1pt · &lt;60% → 0pts · &lt;3 H2H games → 1pt abstain"
            why="How often has this team scored ≥ threshold in their last 10 head-to-head games vs this opponent? Captures matchup-specific tendencies (ballpark familiarity, historical lineup matchups) not fully reflected in ERA/WHIP averages." />
          <ScoreRow pts="0–2" name="Game O/U line"
            tiers="≥9.5 → 2pts · ≥7.5 → 1pt · &lt;7.5 → 0pts"
            why="Market consensus on total game scoring. A high game O/U means both teams' run environments are favorable — independent confirmation that run conditions are elevated." />
        </Section>
      </>
    ),
    "nba-tt": (
      <>
        <Section title="NBA Team Total — True% Model">
          <div style={s.sub}>Normal distribution Monte Carlo for a single team's point total.</div>

          <div style={s.h3}>Core Formula</div>
          <Formula>{`mean = teamOffPPG × (oppDefPPG / leagueAvgDef)
std = 11 (fixed per-team standard deviation)

Distribution: Normal(mean, std)
truePct = P(teamPoints ≥ threshold)`}</Formula>

          <div style={s.h3}>Model Inputs</div>
          <InputRow name="Team offensive PPG" color="#3fb950"
            why="Baseline scoring rate. Uses regular season stats to avoid playoff sample distortion." />
          <InputRow name="Opponent defensive PPG allowed" color="#3fb950"
            why="A team allowing 120 PPG vs league avg 114 means a ~5% boost to the scoring team's expected points." />
          <InputRow name="League avg defensive PPG" color="#8b949e"
            why="Normalization — converts opponent defense into a relative quality factor." />
        </Section>

        <Section title="NBA Team Total — SimScore (max 10)">
          <div style={s.sub}>5 components × 2 pts each. Gate: teamTotalSimScore ≥ 8.</div>
          <ScoreRow pts="0–2" name="Team off PPG"
            tiers="≥118 → 2pts · ≥113 → 1pt · else 0pts"
            why="High-scoring offense increases the expected team point total. Teams averaging 118+ are elite scorers who regularly approach or exceed typical thresholds." />
          <ScoreRow pts="0–2" name="Opponent def PPG allowed"
            tiers="≥118 → 2pts · ≥113 → 1pt · else 0pts"
            why="Bad defense (allows lots of points) creates a more permissive scoring environment for the scoring team. A team giving up 120+ PPG is the ideal opponent for an over bet." />
          <ScoreRow pts="0–2" name="Game O/U line"
            tiers="≥235 → 2pts · ≥225 → 1pt · else 0pts"
            why="Market consensus. A high game total implies a fast pace and/or poor defenses on both sides — corroborating the team total model." />
          <ScoreRow pts="0–2" name="Team pace vs league avg"
            tiers=">lgPace+2 → 2pts · >lgPace−2 → 1pt · else 0pts"
            why="Pace determines possessions, and possessions determine scoring opportunities. A team running 5 possessions faster per game than average has meaningfully more chances to score." />
          <ScoreRow pts="0–2" name="H2H Hit Rate"
            tiers="≥80% → 2pts · ≥60% → 1pt · &lt;60% → 0pts · &lt;3 H2H games → 1pt abstain"
            why="How often has this team scored ≥ threshold in their last 10 games vs this opponent? Captures historical scoring tendencies in this specific matchup." />
        </Section>
      </>
    ),
  };

  return (
    <div style={{maxWidth:900,margin:"0 auto",padding:"16px 16px"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",marginBottom:14,gap:12}}>
        <button onClick={onBack}
          style={{background:"transparent",border:"1px solid #30363d",borderRadius:6,
            color:"#8b949e",fontSize:12,padding:"4px 10px",cursor:"pointer"}}>
          ← Back
        </button>
        <div>
          <div style={{color:"#c9d1d9",fontSize:17,fontWeight:700}}>Model Reference</div>
          <div style={{color:"#484f58",fontSize:11,marginTop:2}}>True% formulas, inputs, and SimScore breakdowns for every play type</div>
        </div>
      </div>

      {/* Qualification summary */}
      <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:10,padding:"10px 14px",marginBottom:12,
        display:"flex",gap:24,flexWrap:"wrap"}}>
        <div>
          <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>MARKET GATE</div>
          <div style={{color:"#58a6ff",fontSize:12,fontWeight:600}}>Kalshi implied ≥ 70%</div>
          <div style={{color:"#484f58",fontSize:10}}>Only markets the book prices likely</div>
        </div>
        <div>
          <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>EDGE GATE</div>
          <div style={{color:"#3fb950",fontSize:12,fontWeight:600}}>True% − Kalshi% ≥ 5%</div>
          <div style={{color:"#484f58",fontSize:10}}>Model must disagree meaningfully</div>
        </div>
        <div>
          <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>SIMSCORE GATE</div>
          <div style={{color:"#e3b341",fontSize:12,fontWeight:600}}>SimScore ≥ 8 / 10</div>
          <div style={{color:"#484f58",fontSize:10}}>Model confidence — all three must pass</div>
        </div>
        <div style={{borderLeft:"1px solid #21262d",paddingLeft:24}}>
          <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>EDGE CALC</div>
          <div style={{color:"#c9d1d9",fontSize:11}}>edge = truePct − kalshiPct</div>
          <div style={{color:"#484f58",fontSize:10}}>Kalshi price = YES ask (fill price); no spread deduction</div>
        </div>
      </div>

      {/* Tab bar — grouped by sport */}
      <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:14}}>
        {TAB_ROWS.map(row => (
          <div key={row.sport} style={{display:"flex",gap:4,flexWrap:"wrap"}}>
            {row.tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{padding:"4px 11px",borderRadius:6,border:`1px solid ${tab===t.id?"#58a6ff":"#30363d"}`,
                  background: tab===t.id ? "rgba(88,166,255,0.1)" : "transparent",
                  color: tab===t.id ? "#58a6ff" : "#8b949e",
                  fontSize:11,fontWeight:tab===t.id?700:400,cursor:"pointer"}}>
                {t.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Page content */}
      {content[tab]}
      <CalibModule tabId={tab} />
    </div>
  );
}


export default ModelPage;
