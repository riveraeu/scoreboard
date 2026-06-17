import React from 'react';

// --- Report page (daily model briefing) -----------------------------------------
// Four priority-ordered sections: TODAY (what to bet) · MODEL BOARD (the price-band
// validation ladder — the single gate-decision surface) · DISCIPLINE (our tracked
// betting, operational only) · OPS (collapsed supporting tables).
//
// The MODEL BOARD slices BETTABLE plays by market price (where ROI actually lives —
// ROI = hitRate − price) and runs a promotion ladder: PROMOTE only when n≥50 AND the
// ROI 95%-CI lower bound clears 0 AND the window is coherent (both price-halves
// non-negative). Everything else is STRENGTHENING (positive, not yet validated),
// BUILDING (accruing), or NEGATIVE (stay out). truePct calibration is a SEPARATE
// model-honesty check, not a competing profitability axis (calibration ≠ profit).

const C = { green:"#3fb950", amber:"#e3b341", red:"#f78166", blue:"#58a6ff", gray:"#8b949e", dim:"#484f58", text:"#c9d1d9", bg:"#0d1117", card:"#161b22", border:"#21262d" };

const _roiFromFrac = f => f == null ? "—" : `${f >= 0 ? "+" : ""}${(f * 100).toFixed(1)}%`;
const _roiFromPct  = p => p == null ? "—" : `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
const _roiColorFrac = f => f == null ? C.gray : f >= 0.02 ? C.green : f <= -0.02 ? C.red : C.amber;
const _roiColorPct  = p => p == null ? C.gray : p >= 2 ? C.green : p <= -2 ? C.red : C.amber;
const _pct1 = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

const thB = { padding:"4px 8px", fontSize:10, fontWeight:700, color:C.gray, textAlign:"center", borderBottom:`1px solid ${C.border}`, background:C.bg };
const tdB = { padding:"4px 8px", fontSize:11, textAlign:"center", borderBottom:"1px solid #161b22" };
const tableStyle = { width:"100%", borderCollapse:"collapse", background:C.bg, borderRadius:8, overflow:"hidden", border:`1px solid ${C.border}` };
const sectionTitle = { color:C.gray, fontSize:11, fontWeight:600, marginBottom:4, marginTop:4 };
const sectionHead = { color:C.blue, fontSize:11, fontWeight:700, margin:"14px 0 8px", borderTop:`1px solid ${C.border}`, paddingTop:12, textTransform:"uppercase", letterSpacing:0.4 };

// ---- Model board verdict styling --------------------------------------------------
const _BOARD = {
  PROMOTE:       ["PROMOTE",       C.green, "rgba(63,185,80,0.10)"],
  STRENGTHENING: ["strengthening", C.blue,  "transparent"],
  DEMOTE:        ["DEMOTE",        C.red,   "rgba(247,129,102,0.10)"],
  HOLD:          ["hold",          C.gray,  "transparent"],
  NEGATIVE:      ["negative",      C.dim,   "transparent"],
  BUILDING:      ["building",      C.dim,   "transparent"],
};
function BoardBadge({ v }) {
  const [label, color] = _BOARD[v] || [v, C.dim];
  return <span style={{ color, fontSize:9, fontWeight:700, border:`1px solid ${color}55`, borderRadius:4, padding:"0 5px", whiteSpace:"nowrap" }}>{label}</span>;
}
// Tiny pass/fail chips for the promotion checklist (n / CI / coherence).
function Check({ ok, label }) {
  if (ok == null) return null;
  return <span style={{ color: ok ? C.green : C.dim, fontSize:9, fontWeight:700, marginRight:5 }}>{ok ? "✓" : "✗"}{label}</span>;
}

// Calibration (truePct→actual) verdict badge — the model-honesty check, NOT the bet decision.
const _CALIB = { gate_ready:["gate-ready",C.green], building:["building",C.amber], actionable:["actionable",C.green], needs_n200:["need n≥200",C.dim], within_noise:["within noise",C.dim], too_few:["too few",C.dim] };
function CalibBadge({ v }) {
  if (!v) return null;
  const [label, color] = _CALIB[v] || [v, C.dim];
  return <span style={{ color, fontSize:9, fontWeight:700, border:`1px solid ${color}55`, borderRadius:4, padding:"0 4px", whiteSpace:"nowrap" }}>{label}</span>;
}

// ---- Data health gate -------------------------------------------------------------
function DataHealth({ dh }) {
  if (!dh) return null;
  const warn = dh.warnings?.length > 0;
  const res = dh.resolution || {};
  const clv = dh.clvCapture || {};
  return (
    <div style={{ background: warn ? "rgba(247,129,102,0.08)" : "rgba(63,185,80,0.06)", border:`1px solid ${warn ? "#f7816644" : "#3fb95033"}`, borderRadius:6, padding:"6px 10px", marginBottom:12 }}>
      <div style={{ color: warn ? C.red : C.green, fontSize:11, fontWeight:700, marginBottom: warn ? 3 : 0 }}>
        {warn ? "⚠ Data health — interpret with caution" : "✓ Data healthy"}
        <span style={{ color:C.dim, fontWeight:400, marginLeft:8 }}>
          yesterday {res.resolved ?? 0}/{res.total ?? 0} resolved · CLV {clv.pct ?? 0}%{dh.coverageWarning ? " · slate under-logged" : ""}
        </span>
      </div>
      {warn && dh.warnings.map((w, i) => <div key={i} style={{ color:C.text, fontSize:11 }}>• {w}</div>)}
    </div>
  );
}

// ---- TODAY: what to bet -----------------------------------------------------------
function TodaySection({ d }) {
  const picks = d.topPicks || [];
  return (
    <div style={{ marginBottom:6 }}>
      <div style={{ color:C.green, fontSize:13, fontWeight:700, marginBottom:8 }}>Today — plays to bet <span style={{ color:C.dim, fontSize:10, fontWeight:400 }}>· passed gate · sorted by edge</span></div>
      {picks.length === 0 ? (
        <div style={{ color:C.dim, fontSize:12, padding:"8px 0" }}>No picks pass the gate today{d.reportDate ? ` (${d.reportDate})` : ""}. If it's before ~9am PT, the morning snapshot may not have run yet — Refresh later.</div>
      ) : (
        <table style={tableStyle}>
          <thead><tr>{["Pick","Dir","Model%","Market%","Edge","Game"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
          <tbody>
            {picks.map((p, i) => {
              const edge = p.edge ?? 0;
              const edgeC = edge >= 10 ? C.green : edge >= 7 ? C.amber : C.text;
              const label = p.playerName
                ? `${p.playerName} ${p.threshold != null ? `O${p.threshold}` : ""} ${p.category}`
                : `${p.pickTeam ?? p.homeTeam} ${p.direction === "under" ? "U" : "O"}${p.pickLine ?? p.threshold ?? ""} ${p.category}`;
              const gameLabel = p.homeTeam && p.awayTeam ? `${p.awayTeam}@${p.homeTeam}` : (p.homeTeam ?? "");
              const gameTime = p.gameTime ? new Date(p.gameTime).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"}) : "—";
              return (
                <tr key={i}>
                  <td style={{ ...tdB, color:C.text, textAlign:"left", fontWeight:600 }}>{label}</td>
                  <td style={{ ...tdB, color:p.direction==="under"?"#79c0ff":C.green }}>{p.direction ?? "—"}</td>
                  <td style={{ ...tdB, color:C.text }}>{p.modelTruePct != null ? `${p.modelTruePct}%` : "—"}</td>
                  <td style={{ ...tdB, color:C.gray }}>{p.marketPct != null ? `${p.marketPct}%` : "—"}</td>
                  <td style={{ ...tdB, color:edgeC, fontWeight:700 }}>{edge >= 0 ? `+${edge.toFixed(1)}` : edge.toFixed(1)}%</td>
                  <td style={{ ...tdB, color:C.dim }}>{gameLabel} {gameTime}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- Price-band curve (expanded under a board row) --------------------------------
function PriceBands({ bands, window }) {
  if (!bands?.length) return <div style={{ color:C.dim, fontSize:10, padding:"4px 0" }}>No bettable plays binned yet.</div>;
  const [lo, hi] = window || [67, 91];
  return (
    <table style={{ ...tableStyle, margin:"4px 0 8px" }}>
      <thead><tr>{["Price band","N","Hit%","ROI",""].map(h => <th key={h} style={{ ...thB, fontSize:9 }}>{h}</th>)}</tr></thead>
      <tbody>
        {bands.map((b, i) => {
          const inWin = b.lo >= lo && b.hi <= hi + 0.001;
          const overlapsWin = b.hi > lo && b.lo < hi;
          return (
            <tr key={i} style={{ background: inWin ? "rgba(88,166,255,0.06)" : "transparent" }}>
              <td style={{ ...tdB, color:C.text, textAlign:"left", fontSize:10 }}>{b.lo}–{b.hi}¢</td>
              <td style={{ ...tdB, color:b.n>=15?C.text:C.dim, fontSize:10 }}>{b.n}</td>
              <td style={{ ...tdB, color:C.gray, fontSize:10 }}>{b.hitRate}%</td>
              <td style={{ ...tdB, color:_roiColorFrac(b.roi), fontWeight:600, fontSize:10 }}>{_pct1(b.roi)}</td>
              <td style={{ ...tdB, color:C.dim, fontSize:9 }}>{inWin ? "in 67–91" : overlapsWin ? "" : "outside"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---- MODEL BOARD: the price-band validation ladder --------------------------------
const _ORDER = { PROMOTE:0, DEMOTE:1, STRENGTHENING:2, HOLD:3, NEGATIVE:4, BUILDING:5 };
function ModelBoard({ board, topBands }) {
  const [expanded, setExpanded] = React.useState({});
  const [showBuilding, setShowBuilding] = React.useState(false);
  if (!board?.length) return null;

  const sorted = [...board].sort((a, b) => (_ORDER[a.verdict] ?? 9) - (_ORDER[b.verdict] ?? 9) || b.n - a.n);
  const actionable = sorted.filter(r => r.verdict !== "BUILDING");
  const building = sorted.filter(r => r.verdict === "BUILDING");

  const Row = ({ r }) => {
    const w = r.discoveredWindow;
    const open = expanded[r.key];
    return (
      <>
        <tr onClick={() => setExpanded(e => ({ ...e, [r.key]: !e[r.key] }))}
            style={{ cursor:"pointer", background:_BOARD[r.verdict]?.[2] || "transparent" }}>
          <td style={{ ...tdB, textAlign:"left", color:C.text, fontWeight:600 }}>
            <span style={{ color:C.dim, marginRight:4 }}>{open ? "▾" : "▸"}</span>{r.key}
          </td>
          <td style={tdB}><BoardBadge v={r.verdict} /></td>
          <td style={{ ...tdB, color:C.gray }}>{w ? `${w.lo}–${w.hi}¢` : "—"}</td>
          <td style={{ ...tdB, color:_roiColorFrac(w?.roi), fontWeight:600 }}>{w ? _pct1(w.roi) : "—"}</td>
          <td style={{ ...tdB, color:C.dim, fontSize:10 }}>{w && w.roiLoCI != null ? `[${(w.roiLoCI*100).toFixed(0)},${(w.roiHiCI*100).toFixed(0)}]` : "—"}</td>
          <td style={{ ...tdB, color:r.n>=50?C.text:r.n>=30?C.gray:C.dim }}>{r.n}</td>
          <td style={{ ...tdB, whiteSpace:"nowrap" }}>
            {r.checklist ? <><Check ok={r.checklist.nOk} label="n" /><Check ok={r.checklist.ciOk} label="CI" /><Check ok={r.checklist.coherentOk} label="coh" /></> : <span style={{ color:C.dim, fontSize:9 }}>—</span>}
          </td>
        </tr>
        {open && (
          <tr><td colSpan={7} style={{ padding:"0 8px 4px 22px", background:"#0d1117" }}>
            {r.hint && <div style={{ color:r.verdict==="PROMOTE"?C.green:C.gray, fontSize:11, margin:"4px 0" }}>{r.action ? `▶ ${r.action} · ` : ""}{r.hint}</div>}
            <PriceBands bands={r.priceBands} window={r.currentWindow} />
          </td></tr>
        )}
      </>
    );
  };

  return (
    <div style={{ marginBottom:10 }}>
      <div style={sectionTitle}>
        Profitable price window per category · bettable plays (edge≥3) by market price · current betting window 67–91¢
      </div>
      <table style={tableStyle}>
        <thead><tr>{["Category","Verdict","Window","ROI","95% CI","N","Ready?"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
        <tbody>
          {actionable.map(r => <Row key={r.key} r={r} />)}
          {building.length > 0 && !showBuilding && (
            <tr><td colSpan={7} style={{ ...tdB, textAlign:"left", color:C.dim, cursor:"pointer" }} onClick={() => setShowBuilding(true)}>
              ▸ {building.length} more building (n &lt; 20 bettable) — show
            </td></tr>
          )}
          {showBuilding && building.map(r => <Row key={r.key} r={r} />)}
        </tbody>
      </table>
      <div style={{ color:C.dim, fontSize:9.5, marginTop:3 }}>
        PROMOTE requires all three: <b style={{ color:C.gray }}>n≥50</b>, ROI 95%-CI lower bound <b style={{ color:C.gray }}>&gt; 0</b>, and <b style={{ color:C.gray }}>coherent</b> window (both price-halves non-negative). Click a row for its price-band curve.
      </div>

      {/* Calibration (model honesty) — secondary, NOT the bet decision */}
      {topBands?.length > 0 && (
        <div style={{ marginTop:12 }}>
          <div style={sectionTitle}>Model calibration check · truePct → actual · Δ&lt;0 = overconfident <span style={{ color:C.dim }}>(honesty check, not profitability)</span></div>
          <table style={tableStyle}>
            <thead><tr>{["Category","Band","N","Pred%","Actual%","Δ"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
            <tbody>
              {topBands.slice(0, 10).map((b, i) => {
                const delta = b.delta ?? 0;
                const deltaC = delta <= -5 ? C.red : delta >= 5 ? C.green : C.amber;
                return (
                  <tr key={i}>
                    <td style={{ ...tdB, color:C.text, textAlign:"left" }}>{b.sport}|{b.category}</td>
                    <td style={{ ...tdB, color:C.gray }}>{b.band}%</td>
                    <td style={{ ...tdB, color:b.n>=200?C.text:b.n>=50?C.gray:C.dim }}>{b.n}</td>
                    <td style={{ ...tdB, color:C.gray }}>{b.predicted != null ? `${b.predicted}%` : "—"}</td>
                    <td style={{ ...tdB, color:b.actual>=70?C.green:b.actual>=60?C.amber:C.red }}>{b.actual != null ? `${b.actual}%` : "—"}</td>
                    <td style={{ ...tdB, color:deltaC, fontWeight:600 }}>{delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)}{b.coherent ? "▴" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- DISCIPLINE: our tracked betting (operational only) ---------------------------
function DisciplineSection({ d }) {
  const yr = d.yesterdayRecap;
  const df = d.disciplineFlags;
  const rows = [];
  if (df) {
    for (const f of (df.flaggedBandBets || [])) rows.push({ tone:C.red, kind:"Flagged band", text:`${f.label} — ${f.sport}|${f.category} ${f.band}% (Δ${f.delta}, n=${f.n})` });
    for (const f of (df.concentration || [])) rows.push({ tone:C.amber, kind:"Over cap", text:`${f.label} — ${f.sport}|${f.category}, #${f.rank} of ${f.gameN} in its game` });
    for (const f of (df.negativeClv || [])) rows.push({ tone:C.amber, kind:"Neg CLV", text:`${f.label} — ${f.sport}|${f.category}, ${f.clvCents}¢` });
  }
  return (
    <div>
      <div style={sectionHead}>Discipline · our tracked picks <span style={{ color:C.dim, fontWeight:400, textTransform:"none" }}>· operational, not a model correction</span></div>
      {yr && yr.n > 0 ? (
        <div style={{ color:C.text, fontSize:12, marginBottom:8 }}>
          Yesterday: <b>{yr.wins}-{yr.losses}</b>{yr.pushes ? ` (${yr.pushes}P)` : ""}{yr.pending ? `, ${yr.pending} pending` : ""}, ROI <span style={{ color:_roiColorFrac(yr.roi), fontWeight:700 }}>{_roiFromFrac(yr.roi)}</span> on ${yr.staked?.toFixed(0) ?? 0} staked.
        </div>
      ) : <div style={{ color:C.dim, fontSize:12, marginBottom:8 }}>No tracked picks settled yesterday.</div>}

      {rows.length === 0 ? (
        <div style={{ color:C.green, fontSize:12 }}>No discipline issues{df?.nLosses ? ` across ${df.nLosses} loss(es)` : ""} — losses look like variance.</div>
      ) : (
        <table style={tableStyle}>
          <thead><tr>{["Issue","Pick"].map(h => <th key={h} style={{ ...thB, textAlign:"left" }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ ...tdB, textAlign:"left", color:r.tone, fontWeight:700, whiteSpace:"nowrap" }}>{r.kind}</td>
                <td style={{ ...tdB, textAlign:"left", color:C.text }}>{r.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {df?.clvMatched != null && (
        <div style={{ color:C.dim, fontSize:9.5, marginTop:3 }}>CLV checked on {df.clvMatched} of {df.nLosses} losses (worst {df.clvWorst ?? "—"}¢).</div>
      )}
    </div>
  );
}

// ---- OPS: collapsed supporting tables ---------------------------------------------
function OpsSection({ d }) {
  const [open, setOpen] = React.useState(false);
  const cap = d.optimalPerGameCap ?? 2;
  return (
    <div>
      <div style={sectionHead} onClick={() => setOpen(o => !o)} role="button">
        <span style={{ cursor:"pointer" }}>{open ? "▾" : "▸"} Ops · volume, CLV, new markets</span>
      </div>
      {open && (
        <div>
          {/* Picks per game */}
          {d.perGameRoi?.length > 0 && (
            <div style={{ marginBottom:10 }}>
              <div style={sectionTitle}>Picks per game · cap = <span style={{ color:C.green, fontWeight:700 }}>{cap}</span></div>
              <table style={tableStyle}>
                <thead><tr>{["Within-game rank","N","Hit%","Avg price","ROI"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
                <tbody>
                  {d.perGameRoi.map((r, i) => {
                    const isCap = r.multi && r.rnk === cap, overCap = r.multi && r.rnk > cap;
                    const label = !r.multi ? "solo game" : `#${r.rnk} in game`;
                    return (
                      <tr key={i} style={{ background:isCap?"rgba(63,185,80,0.08)":overCap?"rgba(247,129,102,0.06)":"transparent" }}>
                        <td style={{ ...tdB, color:isCap?C.green:overCap?C.red:C.text, textAlign:"left", fontWeight:isCap?700:400 }}>{label}{isCap?" ← cap":""}</td>
                        <td style={{ ...tdB, color:r.n>=10?C.text:C.dim }}>{r.n}</td>
                        <td style={{ ...tdB, color:r.hitRate>=70?C.green:r.hitRate>=60?C.amber:C.red }}>{r.hitRate != null ? `${r.hitRate}%` : "—"}</td>
                        <td style={{ ...tdB, color:C.gray }}>{r.avgPrice != null ? `${r.avgPrice}¢` : "—"}</td>
                        <td style={{ ...tdB, color:_roiColorPct(r.roiPct), fontWeight:600 }}>{_roiFromPct(r.roiPct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* Picks per day */}
          {d.dailyVolumeRoi?.length > 0 && (
            <div style={{ marginBottom:10 }}>
              <div style={sectionTitle}>Picks per day{d.optimalDailyPicks ? <> · optimal <span style={{ color:C.green, fontWeight:700 }}>{d.optimalDailyPicks.bucket}</span> ({d.optimalDailyPicks.confidence})</> : null}</div>
              <table style={tableStyle}>
                <thead><tr>{["Picks/day","Days","Hit%","Avg price","ROI"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
                <tbody>
                  {d.dailyVolumeRoi.map((r, i) => {
                    const isBest = d.optimalDailyPicks && r.picksBucket === d.optimalDailyPicks.bucket;
                    return (
                      <tr key={i} style={{ background:isBest?"rgba(63,185,80,0.08)":"transparent" }}>
                        <td style={{ ...tdB, color:isBest?C.green:C.text, textAlign:"left", fontWeight:isBest?700:400 }}>{r.picksBucket}</td>
                        <td style={{ ...tdB, color:r.nDays>=10?C.text:r.nDays>=3?C.gray:C.dim }}>{r.nDays}</td>
                        <td style={{ ...tdB, color:r.hitRatePct>=70?C.green:r.hitRatePct>=60?C.amber:C.red }}>{r.hitRatePct}%</td>
                        <td style={{ ...tdB, color:C.gray }}>{r.avgPricePct}¢</td>
                        <td style={{ ...tdB, color:_roiColorFrac(r.roi), fontWeight:600 }}>{_roiFromFrac(r.roi)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* CLV */}
          {d.clv?.length > 0 && (
            <div style={{ marginBottom:10 }}>
              <div style={sectionTitle}>CLV / line movement · 3pm → 7pm PT · + = market confirmed model</div>
              <table style={tableStyle}>
                <thead><tr>{["Category","N","CLV","Hit%"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
                <tbody>
                  {d.clv.map((r, i) => {
                    const clvV = r.avgClvPct ?? 0;
                    const clvC = clvV >= 1 ? C.green : clvV <= -1 ? C.red : C.amber;
                    return (
                      <tr key={i}>
                        <td style={{ ...tdB, color:C.text, textAlign:"left" }}>{r.sport}|{r.category}</td>
                        <td style={tdB}>{r.n}</td>
                        <td style={{ ...tdB, color:clvC, fontWeight:600 }}>{clvV >= 0 ? `+${clvV.toFixed(1)}` : clvV.toFixed(1)}¢</td>
                        <td style={{ ...tdB, color:(r.hitRatePct??0)>=70?C.green:(r.hitRatePct??0)>=60?C.amber:C.red, fontWeight:600 }}>{r.hitRatePct != null ? `${r.hitRatePct}%` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* New markets */}
          {d.newMarkets?.length > 0 && (
            <div style={{ marginTop:8 }}>
              <div style={sectionTitle}>New Kalshi markets (not yet consumed) · {d.newMarkets.length}</div>
              <div style={{ color:C.gray, fontSize:11 }}>{d.newMarkets.slice(0, 10).map(m => m.ticker).join(", ")}{d.newMarkets.length > 10 ? "…" : ""}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MorningBriefing({ shadowReportData, shadowReportLoading, fetchShadowReport, isLoggedIn }) {
  if (!isLoggedIn) return null;
  const d = shadowReportData;
  const noReport = !d || d.notYet || d.error;

  if (shadowReportLoading) return <div style={{ color:C.dim, fontSize:12, padding:12 }}>Generating report…</div>;
  if (noReport) {
    return (
      <div style={{ padding:12, display:"flex", gap:10, alignItems:"center" }}>
        <span style={{ color:C.dim, fontSize:12 }}>
          {d?.error ? `Error: ${d.error}` : "Report not yet generated — cron runs at 9:30am PT. Click Refresh to generate now."}
        </span>
        <button onClick={() => fetchShadowReport(true)} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"2px 8px", cursor:"pointer" }}>Refresh</button>
      </div>
    );
  }

  return (
    <div>
      {/* Title row */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
        <span style={{ color:C.blue, fontSize:13, fontWeight:700 }}>Model Report</span>
        {d.reportDate && <span style={{ color:C.dim, fontSize:11 }}>{d.reportDate}</span>}
        {d.generatedAt && <span style={{ color:C.dim, fontSize:10 }}>· generated {new Date(d.generatedAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"})} PT</span>}
        <button onClick={() => fetchShadowReport(true)} style={{ marginLeft:"auto", background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:10, padding:"2px 8px", cursor:"pointer" }}>↻ Refresh</button>
      </div>

      <DataHealth dh={d.dataHealth} />
      <TodaySection d={d} />

      <div style={sectionHead}>Model board · the gate decision</div>
      <ModelBoard board={d.modelBoard} topBands={d.topBands} />

      <DisciplineSection d={d} />
      <OpsSection d={d} />
    </div>
  );
}

// --- ReportPage --------------------------------------------------------------------
function ReportPage({ onBack, shadowReportData, shadowReportLoading, fetchShadowReport, isLoggedIn }) {
  React.useEffect(() => {
    if (isLoggedIn && !shadowReportData && !shadowReportLoading) fetchShadowReport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  return (
    <div style={{ maxWidth:1280, margin:"0 auto", padding:"16px 16px" }}>
      <div style={{ display:"flex", alignItems:"center", marginBottom:14, gap:12 }}>
        <button onClick={onBack} style={{ background:"transparent", border:`1px solid #30363d`, borderRadius:6, color:C.gray, fontSize:12, padding:"4px 10px", cursor:"pointer" }}>← Back</button>
        <div style={{ color:C.text, fontSize:17, fontWeight:700 }}>Report</div>
        <div style={{ color:C.dim, fontSize:11, marginLeft:"auto" }}>Daily model report</div>
      </div>

      {isLoggedIn ? (
        <MorningBriefing shadowReportData={shadowReportData} shadowReportLoading={shadowReportLoading} fetchShadowReport={fetchShadowReport} isLoggedIn={isLoggedIn} />
      ) : (
        <div style={{ color:C.gray, textAlign:"center", padding:40, fontSize:13 }}>Log in to view the model report.</div>
      )}
    </div>
  );
}

export default ReportPage;
