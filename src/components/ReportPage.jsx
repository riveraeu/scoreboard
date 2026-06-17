import React from 'react';

// --- Report page (daily model briefing) -----------------------------------------
// Renders /api/shadow-report as a decision-grade briefing: a data-health gate, a
// synthesized summary + Actions list, then the supporting model-signal tables and
// our betting-discipline flags. Model corrections come from the ALL-picks shadow set
// (formula-windowed, significance-gated); discipline flags are tracked-pick-only and
// operational (never fed back as a calibration correction).

const C = { green:"#3fb950", amber:"#e3b341", red:"#f78166", blue:"#58a6ff", gray:"#8b949e", dim:"#484f58", text:"#c9d1d9", bg:"#0d1117", card:"#161b22", border:"#21262d" };

const _roiFromFrac = f => f == null ? "—" : `${f >= 0 ? "+" : ""}${(f * 100).toFixed(1)}%`;
const _roiFromPct  = p => p == null ? "—" : `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
const _roiColorFrac = f => f == null ? C.gray : f >= 0.02 ? C.green : f <= -0.02 ? C.red : C.amber;
const _roiColorPct  = p => p == null ? C.gray : p >= 2 ? C.green : p <= -2 ? C.red : C.amber;

const _VERDICT = {
  gate_ready:   ["gate-ready", C.green],
  building:     ["building",   C.amber],
  actionable:   ["actionable", C.green],
  needs_n200:   ["need n≥200", C.dim],
  within_noise: ["within noise", C.dim],
  too_few:      ["too few",    C.dim],
};
function VerdictBadge({ v }) {
  if (!v) return null;
  const [label, color] = _VERDICT[v] || [v, C.dim];
  return <span style={{ color, fontSize:9, fontWeight:700, border:`1px solid ${color}55`, borderRadius:4, padding:"0 4px", whiteSpace:"nowrap" }}>{label}</span>;
}

// Synthesize the prose summary + Actions from the report payload. Model actions only fire
// when they clear the significance bar; discipline actions are flagged anecdotal.
function buildBriefing(d, cap) {
  const summary = [];
  const yr = d.yesterdayRecap;
  if (yr && yr.n > 0) {
    summary.push(`Yesterday: ${yr.wins}-${yr.losses}${yr.pushes ? ` (${yr.pushes}P)` : ""}${yr.pending ? `, ${yr.pending} pending` : ""}, ROI ${_roiFromFrac(yr.roi)} on $${yr.staked?.toFixed(0) ?? 0} staked.`);
  } else {
    summary.push("No tracked picks settled yesterday.");
  }

  const model = [];
  const cats = d.categories || [];
  // Promote candidates: gate-ready, positive ROI, not already gated.
  for (const c of cats) {
    if (c.status === "building" && c.verdict === "gate_ready" && (c.roi ?? 0) > 0) {
      model.push({ tone: "good", text: `Promote candidate: ${c.key} — n=${c.n}, ROI ${_roiFromFrac(c.roi)}, clears the gate-sample bar.` });
    }
  }
  // Watch/demote: losing categories.
  for (const c of cats) {
    if (c.status === "losing") model.push({ tone: "bad", text: `Watch/demote: ${c.key} — n=${c.n}, ROI ${_roiFromFrac(c.roi)}.` });
  }
  // Recently-changed formulas: hold until the clean sample grows.
  for (const c of cats) {
    if (c.windowTrimmed && c.verdict !== "gate_ready") {
      model.push({ tone: "info", text: `Hold ${c.key}: formula changed ${c.formulaCutoff} — only ${c.daysInWindow}d clean (n=${c.n}), too soon to judge.` });
    }
  }
  // Overconfident bands that clear the formula/coherence bar.
  for (const b of (d.topBands || [])) {
    if ((b.delta ?? 0) <= -5 && (b.verdict === "actionable" || b.coherent)) {
      model.push({ tone: "bad", text: `Overconfident: ${b.sport}|${b.category} ${b.band}% band ran ${b.actual}% vs ${b.predicted}% predicted (Δ${b.delta}) at n=${b.n}${b.coherent ? ", coherent run" : ""} — tighten/cap.` });
    }
  }
  if (d.optimalPerGameCap != null) model.push({ tone: "info", text: `Cap at ${d.optimalPerGameCap} pick(s)/game — the next-ranked same-game pick turns ROI negative.` });
  if (d.optimalDailyPicks) {
    const o = d.optimalDailyPicks;
    model.push({ tone: "info", text: `Bet ~${o.bucket} picks/day (ROI ${_roiFromFrac(o.roi)}, ${o.confidence} conf)${o.stopAt ? `; ROI turns negative at ${o.stopAt}/day` : ""}.` });
  }
  if (model.length === 0) model.push({ tone: "info", text: "No model changes clear the significance bar yet." });

  const disc = [];
  const df = d.disciplineFlags;
  if (df) {
    if (df.flaggedBandBets?.length) {
      const names = df.flaggedBandBets.map(f => `${f.label} (${f.category} ${f.band}, Δ${f.delta})`).join("; ");
      disc.push({ tone: "bad", text: `Bet ${df.flaggedBandBets.length} pick(s) in flagged-overconfident bands: ${names}. The gate should have stopped these.` });
    }
    if (df.concentration?.length) {
      const names = df.concentration.map(f => `${f.label} (#${f.rank} of ${f.gameN})`).join("; ");
      disc.push({ tone: "warn", text: `${df.concentration.length} losing pick(s) over the ${cap}/game cap: ${names}. Honor the cap.` });
    }
    if (df.negativeClv?.length) {
      const names = df.negativeClv.map(f => `${f.label} (${f.clvCents}¢)`).join("; ");
      disc.push({ tone: "warn", text: `${df.negativeClv.length} entry(ies) had negative CLV: ${names}. Market moved against us — check timing/fills.` });
    }
    if (disc.length === 0 && df.nLosses > 0) {
      disc.push({ tone: "good", text: `No discipline issues across ${df.nLosses} loss(es) — they look like normal variance.` });
    }
  }
  return { summary: summary.join(" "), model, disc };
}

const _TONE = { good:C.green, warn:C.amber, bad:C.red, info:C.gray };
function ActionList({ title, items }) {
  if (!items?.length) return null;
  return (
    <div style={{ marginBottom:10 }}>
      <div style={{ color:C.gray, fontSize:11, fontWeight:700, marginBottom:4 }}>{title}</div>
      <ul style={{ margin:0, paddingLeft:16 }}>
        {items.map((a, i) => (
          <li key={i} style={{ color:C.text, fontSize:12, lineHeight:1.5, marginBottom:2 }}>
            <span style={{ color:_TONE[a.tone] || C.gray, marginRight:5 }}>●</span>{a.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

const thB = { padding:"4px 8px", fontSize:10, fontWeight:700, color:C.gray, textAlign:"center", borderBottom:`1px solid ${C.border}`, background:C.bg };
const tdB = { padding:"4px 8px", fontSize:11, textAlign:"center", borderBottom:"1px solid #161b22" };
const tableStyle = { width:"100%", borderCollapse:"collapse", background:C.bg, borderRadius:8, overflow:"hidden", border:`1px solid ${C.border}` };
const sectionTitle = { color:C.gray, fontSize:11, fontWeight:600, marginBottom:4, marginTop:4 };

function DataHealth({ dh }) {
  if (!dh) return null;
  const warn = dh.warnings?.length > 0;
  const res = dh.resolution || {};
  const clv = dh.clvCapture || {};
  return (
    <div style={{ background: warn ? "rgba(247,129,102,0.08)" : "rgba(63,185,80,0.06)", border:`1px solid ${warn ? "#f7816644" : "#3fb95033"}`, borderRadius:6, padding:"6px 10px", marginBottom:10 }}>
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

  const cap = d.optimalPerGameCap ?? 2;
  const { summary, model, disc } = buildBriefing(d, cap);

  return (
    <div>
      {/* Title row */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
        <span style={{ color:C.blue, fontSize:13, fontWeight:700 }}>Morning Briefing</span>
        {d.reportDate && <span style={{ color:C.dim, fontSize:11 }}>{d.reportDate}</span>}
        {d.generatedAt && <span style={{ color:C.dim, fontSize:10 }}>· generated {new Date(d.generatedAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"})} PT</span>}
        <button onClick={() => fetchShadowReport(true)} style={{ marginLeft:"auto", background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:10, padding:"2px 8px", cursor:"pointer" }}>↻ Refresh</button>
      </div>

      {/* Data health */}
      <DataHealth dh={d.dataHealth} />

      {/* Summary + Actions */}
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 12px", marginBottom:12 }}>
        <div style={{ color:C.text, fontSize:12.5, lineHeight:1.5, marginBottom:10 }}>{summary}</div>
        <ActionList title="MODEL — corrections (all shadow picks, formula-windowed, significance-gated)" items={model} />
        <ActionList title="DISCIPLINE — our betting (tracked picks, operational only)" items={disc} />
      </div>

      {/* Today's top picks */}
      {d.topPicks?.length > 0 && (
        <div style={{ marginBottom:12 }}>
          <div style={{ color:C.green, fontSize:11, fontWeight:700, marginBottom:6 }}>Today's Top Picks · passed category gate · sorted by edge</div>
          <table style={tableStyle}>
            <thead><tr>{["Pick","Dir","Model%","Market%","Edge","Game"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
            <tbody>
              {d.topPicks.map((p, i) => {
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
        </div>
      )}
      {d.topPicks?.length === 0 && <div style={{ color:C.dim, fontSize:11, marginBottom:12 }}>No picks pass the category gate today.</div>}

      {/* ===== MODEL SIGNALS ===== */}
      <div style={{ color:C.blue, fontSize:11, fontWeight:700, margin:"6px 0 6px", borderTop:`1px solid ${C.border}`, paddingTop:10 }}>MODEL SIGNALS · all shadow picks</div>

      {/* Category scoreboard */}
      {d.categories?.length > 0 && (
        <div style={{ marginBottom:10 }}>
          <div style={sectionTitle}>Category scoreboard · current-formula window · threshold_rank=1 dedup</div>
          <table style={tableStyle}>
            <thead><tr>{["Category","Window","N","Hit%","ROI","Status","Verdict"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
            <tbody>
              {d.categories.map((c, i) => {
                const statusColor = c.status === "active" ? C.green : c.status === "building" ? C.amber : c.status === "losing" ? C.red : C.dim;
                return (
                  <tr key={i}>
                    <td style={{ ...tdB, color:C.text, textAlign:"left", fontWeight:600 }}>{c.key}</td>
                    <td style={{ ...tdB, color:c.windowTrimmed?C.amber:C.dim }}>{c.daysInWindow}d{c.windowTrimmed?"*":""}</td>
                    <td style={{ ...tdB, color:c.n>=100?C.text:c.n>=50?C.gray:C.dim }}>{c.n}</td>
                    <td style={{ ...tdB, color:c.hitRate>=70?C.green:c.hitRate>=60?C.amber:C.red }}>{c.hitRate != null ? `${c.hitRate}%` : "—"}</td>
                    <td style={{ ...tdB, color:_roiColorFrac(c.roi), fontWeight:600 }}>{_roiFromFrac(c.roi)}</td>
                    <td style={tdB}><span style={{ color:statusColor, fontSize:10, fontWeight:700 }}>{c.status.toUpperCase()}</span></td>
                    <td style={tdB}><VerdictBadge v={c.verdict} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ color:C.dim, fontSize:9.5, marginTop:3 }}>* window trimmed by a recent formula change — older rows excluded.</div>
        </div>
      )}

      {/* Opportunity / overconfidence bands */}
      {d.topBands?.length > 0 && (
        <div style={{ marginBottom:10 }}>
          <div style={sectionTitle}>Calibration bands · actual vs predicted · Δ&lt;0 = overconfident</div>
          <table style={tableStyle}>
            <thead><tr>{["Category","Band","N","Pred%","Actual%","Δ","Verdict"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
            <tbody>
              {d.topBands.map((b, i) => {
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
                    <td style={tdB}><VerdictBadge v={b.verdict} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ color:C.dim, fontSize:9.5, marginTop:3 }}>▴ = part of a 3+ adjacent-band coherent run (trusted below n≥200).</div>
        </div>
      )}

      {/* Picks-per-game */}
      {d.perGameRoi?.length > 0 && (
        <div style={{ marginBottom:10 }}>
          <div style={sectionTitle}>
            Picks per game · gated bet set · cap = <span style={{ color:C.green, fontWeight:700 }}>{cap}</span> (rank where the next same-game pick turns ROI negative)
          </div>
          <table style={tableStyle}>
            <thead><tr>{["Within-game rank","N","Hit%","Avg price","ROI"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
            <tbody>
              {d.perGameRoi.map((r, i) => {
                const isCap = r.multi && r.rnk === cap;
                const overCap = r.multi && r.rnk > cap;
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

      {/* Picks-per-day */}
      {d.dailyVolumeRoi?.length > 0 && (
        <div style={{ marginBottom:10 }}>
          <div style={sectionTitle}>
            Picks per day · ROI by daily volume{d.optimalDailyPicks ? <> · optimal <span style={{ color:C.green, fontWeight:700 }}>{d.optimalDailyPicks.bucket}</span> ({d.optimalDailyPicks.confidence} conf)</> : null}
          </div>
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
            <thead><tr>{["Category","N","CLV","Edge@snap","Edge@close","Hit%"].map(h => <th key={h} style={thB}>{h}</th>)}</tr></thead>
            <tbody>
              {d.clv.map((r, i) => {
                const clvV = r.avgClvPct ?? 0;
                const clvC = clvV >= 1 ? C.green : clvV <= -1 ? C.red : C.amber;
                return (
                  <tr key={i}>
                    <td style={{ ...tdB, color:C.text, textAlign:"left" }}>{r.sport}|{r.category}</td>
                    <td style={tdB}>{r.n}</td>
                    <td style={{ ...tdB, color:clvC, fontWeight:600 }}>{clvV >= 0 ? `+${clvV.toFixed(1)}` : clvV.toFixed(1)}¢</td>
                    <td style={{ ...tdB, color:(r.avgEdgeAtSnap??0)>=5?C.green:(r.avgEdgeAtSnap??0)>=2?C.amber:C.red }}>{r.avgEdgeAtSnap != null ? `${r.avgEdgeAtSnap.toFixed(1)}%` : "—"}</td>
                    <td style={{ ...tdB, color:(r.avgEdgeAtClose??0)>=5?C.green:(r.avgEdgeAtClose??0)>=2?C.amber:C.red }}>{r.avgEdgeAtClose != null ? `${r.avgEdgeAtClose.toFixed(1)}%` : "—"}</td>
                    <td style={{ ...tdB, color:(r.hitRatePct??0)>=70?C.green:(r.hitRatePct??0)>=60?C.amber:C.red, fontWeight:600 }}>{r.hitRatePct != null ? `${r.hitRatePct}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ===== DISCIPLINE ===== */}
      {d.disciplineFlags && (
        <div>
          <div style={{ color:C.blue, fontSize:11, fontWeight:700, margin:"6px 0 6px", borderTop:`1px solid ${C.border}`, paddingTop:10 }}>
            OUR DISCIPLINE · tracked losing picks · {d.disciplineFlags.nLosses} loss(es) over 30d
            <span style={{ color:C.dim, fontWeight:400 }}> · anecdotal, not a model correction</span>
          </div>
          {(() => {
            const df = d.disciplineFlags;
            const rows = [];
            for (const f of (df.flaggedBandBets || [])) rows.push({ tone:C.red, kind:"Flagged band", text:`${f.label} — ${f.sport}|${f.category} ${f.band}% (Δ${f.delta}, n=${f.n})` });
            for (const f of (df.concentration || [])) rows.push({ tone:C.amber, kind:"Over cap", text:`${f.label} — ${f.sport}|${f.category}, #${f.rank} of ${f.gameN} in its game` });
            for (const f of (df.negativeClv || [])) rows.push({ tone:C.amber, kind:"Neg CLV", text:`${f.label} — ${f.sport}|${f.category}, ${f.clvCents}¢` });
            if (rows.length === 0) return <div style={{ color:C.green, fontSize:12 }}>No discipline issues — losses look like variance.</div>;
            return (
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
            );
          })()}
          {d.disciplineFlags.clvMatched != null && (
            <div style={{ color:C.dim, fontSize:9.5, marginTop:3 }}>
              CLV checked on {d.disciplineFlags.clvMatched} of {d.disciplineFlags.nLosses} losses (best-effort match; worst {d.disciplineFlags.clvWorst ?? "—"}¢).
            </div>
          )}
        </div>
      )}

      {/* New markets */}
      {d.newMarkets?.length > 0 && (
        <div style={{ marginTop:12 }}>
          <div style={sectionTitle}>New Kalshi markets (not yet consumed) · {d.newMarkets.length}</div>
          <div style={{ color:C.gray, fontSize:11 }}>
            {d.newMarkets.slice(0, 8).map(m => m.ticker).join(", ")}{d.newMarkets.length > 8 ? "…" : ""}
          </div>
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
    <div style={{ maxWidth:1280, margin:"0 auto", padding:"16px 16px" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", marginBottom:14, gap:12 }}>
        <button onClick={onBack}
          style={{ background:"transparent", border:`1px solid #30363d`, borderRadius:6, color:C.gray, fontSize:12, padding:"4px 10px", cursor:"pointer" }}>
          ← Back
        </button>
        <div style={{ color:C.text, fontSize:17, fontWeight:700 }}>Report</div>
        <div style={{ color:C.dim, fontSize:11, marginLeft:"auto" }}>Daily model report</div>
      </div>

      {isLoggedIn ? (
        <MorningBriefing
          shadowReportData={shadowReportData}
          shadowReportLoading={shadowReportLoading}
          fetchShadowReport={fetchShadowReport}
          isLoggedIn={isLoggedIn}
        />
      ) : (
        <div style={{ color:C.gray, textAlign:"center", padding:40, fontSize:13 }}>
          Log in to view the model report.
        </div>
      )}
    </div>
  );
}

export default ReportPage;
