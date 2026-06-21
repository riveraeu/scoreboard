import React from 'react';

// --- Report page (daily model briefing) -----------------------------------------
// Leads with DO THIS (a single top-priority action across the whole page, picked by a
// fall-through ladder: data health → model changes → build next market → Polymarket),
// then the priority-ordered sections: DATA HEALTH (qualifier banner) · OPS (a four-line
// daily playbook + collapsed supporting tables) · MODEL BOARD (the price-band validation
// ladder — the single gate-decision surface, led by a one-line GATE digest).
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
// Tiny pass/fail chips for the promotion checklist (enough bets / real edge / broad).
function Check({ ok, label, title }) {
  if (ok == null) return null;
  return <span title={title} style={{ color: ok ? C.green : C.dim, fontSize:9, fontWeight:700, marginRight:5, cursor:"help" }}>{ok ? "✓" : "✗"}{label}</span>;
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

// ---- MODEL BOARD: one row per model — profit + honesty fused into a "Do this" action ----
const _TONE = { green:C.green, gray:C.gray, red:C.red, blue:C.blue, amber:C.amber, dim:C.dim };
function DoThisBadge({ d }) {
  if (!d) return <span style={{ color:C.dim }}>—</span>;
  const color = _TONE[d.tone] || C.dim;
  return <span style={{ color, fontSize:10, fontWeight:700, border:`1px solid ${color}55`, borderRadius:4, padding:"1px 6px", whiteSpace:"nowrap" }}>{d.action}</span>;
}
// Honesty headline — is the model's % right? over/under-confident, honest, or too-few-to-judge.
function HonestyCell({ calib }) {
  if (!calib || calib.status === "insufficient") return <span style={{ color:C.dim, fontSize:10 }}>too few</span>;
  if (calib.status === "honest") return <span style={{ color:C.gray, fontSize:10 }}>honest</span>;
  const over = calib.direction === "over";
  const d = calib.delta;
  return <span title={`${calib.band}% band, n=${calib.n}`} style={{ color:over?C.red:C.amber, fontSize:10, fontWeight:600, cursor:"help" }}>
    {d >= 0 ? `+${d}` : d} {over ? "overconf" : "underconf"}
  </span>;
}
// Skill = market-Brier − model-Brier. >0 = the model's probabilities beat the price (headroom);
// <0 = the market is the sharper estimator (no headroom — the totalRuns/HRR trap). Dim until n≥100.
function SkillCell({ skill, skillN, modelBrier, marketBrier }) {
  if (skill == null) return <span style={{ color:C.dim, fontSize:10 }}>—</span>;
  const ready = (skillN || 0) >= 100;
  const color = !ready ? C.dim : skill > 0 ? C.green : skill < -0.005 ? C.red : C.gray;
  return <span title={`model-Brier ${modelBrier ?? "—"} vs market-Brier ${marketBrier ?? "—"} (n=${skillN}). >0 = model sharper than the price.${ready ? "" : " · n<100, not yet trusted"}`}
    style={{ color, fontSize:10, fontWeight:600, cursor:"help" }}>{skill >= 0 ? "+" : ""}{skill.toFixed(3)}</span>;
}
// Per-category calibration bands (model% vs actual) — shown in the expanded detail.
function CalibBandsTable({ bands }) {
  if (!bands?.length) return <div style={{ color:C.dim, fontSize:10, padding:"2px 0" }}>Not enough resolved plays yet — a truePct band needs ≥5 to score honesty.</div>;
  return (
    <table style={{ ...tableStyle, margin:"4px 0 8px" }}>
      <thead><tr>{["truePct band","N","Model%","Actual%","Δ",""].map(h => <th key={h} style={{ ...thB, fontSize:9 }}>{h}</th>)}</tr></thead>
      <tbody>
        {bands.map((b, i) => {
          const delta = b.delta ?? 0;
          const deltaC = delta <= -5 ? C.red : delta >= 5 ? C.green : C.amber;
          return (
            <tr key={i} style={{ background: b.active ? "rgba(63,185,80,0.08)" : "transparent" }}>
              <td style={{ ...tdB, color:C.text, textAlign:"left", fontSize:10 }}>{b.band}%</td>
              <td style={{ ...tdB, color:b.n>=200?C.text:b.n>=50?C.gray:C.dim, fontSize:10 }}>{b.n}</td>
              <td style={{ ...tdB, color:C.gray, fontSize:10 }}>{b.predicted != null ? `${b.predicted}%` : "—"}</td>
              <td style={{ ...tdB, color:C.gray, fontSize:10 }}>{b.actual != null ? `${b.actual}%` : "—"}</td>
              <td style={{ ...tdB, color:deltaC, fontWeight:600, fontSize:10 }}>{delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)}{b.coherent ? "▴" : ""}</td>
              <td style={{ ...tdB, color:b.active?C.green:C.dim, fontSize:9, fontWeight:b.active?700:400 }}>{b.active ? "● betting" : ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ModelBoard({ board }) {
  const [expanded, setExpanded] = React.useState({});
  const [showBuilding, setShowBuilding] = React.useState(false);
  if (!board?.length) return null;

  // Live (gated) categories pin to the top — they're what we're actually betting — then by N.
  // Everything else sorts by N too; thin non-live rows (n<20) collapse behind a toggle.
  const byN = (a, b) => b.n - a.n;
  const live = board.filter(r => r.gated).sort(byN);
  const rest = board.filter(r => !r.gated).sort(byN);
  const actionable = rest.filter(r => r.n >= 20);
  const building = rest.filter(r => r.n < 20);

  const Row = ({ r }) => {
    const w = r.discoveredWindow;
    const open = expanded[r.key];
    // Two different populations: PROFIT = bettable plays (= row N); HONESTY = all resolved plays
    // (no edge/dc gate), so its bands sum higher. Label both counts so the mismatch reads as intent.
    const profitN = (r.priceBands || []).reduce((s, b) => s + (b.n || 0), 0);
    const honestyN = (r.calibBands || []).reduce((s, b) => s + (b.n || 0), 0);
    return (
      <>
        <tr onClick={() => setExpanded(e => ({ ...e, [r.key]: !e[r.key] }))}
            style={{ cursor:"pointer", background:_BOARD[r.verdict]?.[2] || "transparent" }}>
          <td style={{ ...tdB, textAlign:"left", color:C.text, fontWeight:600 }}>
            <span style={{ color:C.dim, marginRight:4 }}>{open ? "▾" : "▸"}</span>{r.key}
            {r.gated && <span title="Currently bet — in the live truePct gate" style={{ color:C.green, fontSize:9, fontWeight:700, marginLeft:6, whiteSpace:"nowrap" }}>● live</span>}
          </td>
          <td style={tdB}><DoThisBadge d={r.doThis} /></td>
          <td style={tdB}><BoardBadge v={r.verdict} /></td>
          <td style={{ ...tdB, color:C.gray }}>{w ? `${w.lo}–${w.hi}¢` : "—"}</td>
          <td style={{ ...tdB, color:_roiColorFrac(w?.roi), fontWeight:600 }}>{w ? _pct1(w.roi) : "—"}</td>
          <td style={{ ...tdB, color:r.n>=50?C.text:r.n>=30?C.gray:C.dim }}>{r.n}</td>
          <td style={tdB}><SkillCell skill={r.skill} skillN={r.skillN} modelBrier={r.modelBrier} marketBrier={r.marketBrier} /></td>
          <td style={tdB}><HonestyCell calib={r.calib} /></td>
        </tr>
        {open && (
          <tr><td colSpan={8} style={{ padding:"0 8px 6px 22px", background:"#0d1117" }}>
            {r.doThis?.why && (
              <div style={{ color:_TONE[r.doThis.tone]||C.gray, fontSize:11, margin:"4px 0" }}>
                ▶ <b>{r.doThis.action}</b>: <span style={{ color:C.text }}>{r.doThis.why}</span>
              </div>
            )}
            {r.skill != null && (
              <div style={{ color:C.dim, fontSize:10, margin:"2px 0 4px" }}>
                Brier skill <b style={{ color: (r.skillN>=100) ? (r.skill>0?C.green:r.skill<-0.005?C.red:C.gray) : C.dim }}>{r.skill>=0?"+":""}{r.skill.toFixed(3)}</b>
                {" "}— model {r.modelBrier ?? "—"} vs market {r.marketBrier ?? "—"} (n={r.skillN}) · {r.skill>0?"model sharper than the price":"market sharper than the model"}{r.skillN<100?" · n<100, not yet trusted":""}
              </div>
            )}
            {r.checklist && (
              <div style={{ margin:"2px 0 6px", whiteSpace:"nowrap" }}>
                <Check ok={r.checklist.nOk} label="bets" title="Enough settled bets (n ≥ 50)" />
                <Check ok={r.checklist.ciOk} label="real" title="Edge is real, not small-sample luck — profitable even in the cautious 95%-confidence case" />
                <Check ok={r.checklist.coherentOk} label="broad" title="Profitable across the whole price range, not one lucky slice" />
                {w && w.roiLoCI != null && <span style={{ color:C.dim, fontSize:9, marginLeft:6 }}>ROI range [{(w.roiLoCI*100).toFixed(0)},{(w.roiHiCI*100).toFixed(0)}]</span>}
              </div>
            )}
            <div style={{ color:C.dim, fontSize:9, fontWeight:700, margin:"4px 0 1px" }}>PROFIT · full price range, no window/truePct gate · <span style={{ color:C.gray, fontWeight:400 }}>{profitN} plays where the model sees value (edge≥3; dc≥7 drops stale-price / player-out) — this is the row's N</span></div>
            <PriceBands bands={r.priceBands} window={r.currentWindow} />
            <div style={{ color:C.dim, fontSize:9, fontWeight:700, margin:"4px 0 1px" }}>HONESTY · model% vs actual (Δ&lt;0 = overconfident) · <span style={{ color:C.gray, fontWeight:400 }}>{honestyN} resolved plays, no edge/dc gate — sums above the row N by design</span> · <span style={{ color:C.green }}>green = currently-bet slice</span></div>
            <CalibBandsTable bands={r.calibBands} />
          </td></tr>
        )}
      </>
    );
  };

  return (
    <div style={{ marginBottom:10 }}>
      <div style={sectionTitle}>
        One row per model · "Do this" fuses profit (where the money is) + honesty (is the model% right) · current betting window 67–91¢
      </div>
      <table style={tableStyle}>
        <thead><tr>{["Category","Do this","Bet status","Window","ROI","N","Skill","Honesty"].map(h => {
          const tip = h==="N" ? "Plays where the model sees value (edge≥3, dc≥7) across the full price range — no 67–91 / truePct gate. The expanded HONESTY table uses a broader all-resolved population, so its band counts sum higher."
            : h==="Skill" ? "Brier head-to-head: market-Brier − model-Brier over all resolved plays. >0 (green) = model sharper than the price (headroom to bet); <0 (red) = market is the sharper estimator (no headroom — don't tune). Dim until n≥100."
            : undefined;
          return <th key={h} style={{ ...thB, cursor:tip?"help":undefined }} title={tip}>{h}</th>;
        })}</tr></thead>
        <tbody>
          {live.map(r => <Row key={r.key} r={r} />)}
          {actionable.map(r => <Row key={r.key} r={r} />)}
          {building.length > 0 && !showBuilding && (
            <tr><td colSpan={8} style={{ ...tdB, textAlign:"left", color:C.dim, cursor:"pointer" }} onClick={() => setShowBuilding(true)}>
              ▸ {building.length} more thin (n &lt; 20 bettable) — show
            </td></tr>
          )}
          {showBuilding && building.map(r => <Row key={r.key} r={r} />)}
        </tbody>
      </table>
      <div style={{ color:C.dim, fontSize:10, marginTop:5, lineHeight:1.55 }}>
        <b style={{ color:C.text }}>Do this</b> fuses three reads — is there a profitable price window (PROFIT), is the model% honest (HONESTY), and does the model beat the price (<b style={{ color:C.text }}>Skill</b>):
        <b style={{ color:C.green }}> Add to gate</b> = validated, start betting ·
        <b style={{ color:C.amber }}>Tune down</b> = overconfident <i>and</i> has headroom (skill≥0) — trim it ·
        <b style={{ color:C.gray }}>Stay out</b> = market is the sharper estimator (skill&lt;0) — no headroom, don't tune ·
        <b style={{ color:C.blue }}>Look deeper</b> = negative but cause unclear — needs residual analysis ·
        <b style={{ color:C.blue }}>Build</b> = positive, just needs more bets.
        <span style={{ display:"block", marginTop:2 }}><b style={{ color:C.text }}>Skill</b> = market-Brier − model-Brier (&gt;0 model sharper, dim until n≥100). Click a row for its price-band (profit) + calibration (honesty) + Brier breakdown.</span>
      </div>
    </div>
  );
}

// ---- MODEL NEXT: curated build roadmap, alt-line-first -----------------------------
// Static editorial roadmap (NOT report data) — the markets we plan to model next, in
// priority order. Alt-line markets (totals / spreads / rounds: multiple thresholds +
// two-sided yes/no pricing) rank ABOVE single-line markets (1X2 result, outrights, H2H)
// because more lines = more chances to find edge than a one-shot ML — and one per-team
// rate estimate feeds totals, team totals, spread AND result off a shared joint sim
// (the MLB pipeline pattern). Each sport names its "first knob": the single input the
// v1 (shadow-only) model ships with, per the minimum-viable-input doctrine in
// docs/MODEL_IMPROVEMENT.md. Frontend constant → edit here, deploys instantly.
const MODEL_NEXT = [
  {
    sport: "Model triage", rank: 0, infra: true,
    note: "Infra, not a market — sharpen the diagnosis before widening the surface: make /model say which fix each losing category needs, so chat sessions go straight to the right move.",
    knob: "market-Brier skill per category → forks the NEGATIVE verdict (Stay out vs Tune down vs Look deeper)",
    markets: [
      { t: "infra", badge: "LIVE", ticker: "Skill column", title: "Brier skill on the board — does the model beat the price? (market-Brier − model-Brier)" },
      { t: "infra", badge: "LIVE", ticker: "tune:residual", title: "Phase 2 CLI — slice residuals by stored dims (features JSONB), ranked by gradient + per-bucket Brier skill (npm run tune:residual)" },
      { t: "infra", badge: "LATER", ticker: "residual board column", title: "Surface the slice on /model — upgrade Look deeper → Reweight (L2) / Add input: ⟨dim⟩ (L0); gated until a category has a live surviving miss" },
    ],
  },
  {
    sport: "Soccer", rank: 1,
    note: "Richest alt-line surface; one goal-rate estimate covers totals + team totals + spread + 1X2.",
    knob: "team goal rate (attack/defense, home/away, form-shrunk) → bivariate-Poisson joint",
    markets: [
      { t: "alt", ticker: "KXEPLTOTAL", title: "Total Goals — EPL / La Liga / Serie A / Bundesliga / Ligue 1 / MLS / UCL" },
      { t: "alt", ticker: "KXEPLSPREAD", title: "Spread (Asian handicap) — all majors" },
      { t: "alt", ticker: "KXEPLTEAMTOTAL", title: "Team Total" },
      { t: "alt", ticker: "KXEPL1HTOTAL", title: "1st-Half Total / Spread" },
      { t: "single", ticker: "KXEPLGAME", title: "Game result (1X2)" },
      { t: "single", ticker: "KXEPLBTTS", title: "Both Teams To Score" },
    ],
  },
  {
    sport: "Fighting", rank: 2,
    note: "One clean alt-line market (rounds O/U); winner/method are single-line.",
    knob: "weight-class base finish rate → fight-duration dist (rounds); fighter rating diff → winner",
    markets: [
      { t: "alt", ticker: "KXUFCROUNDS", title: "UFC Total Rounds (+ KXBOXINGROUNDS)" },
      { t: "single", ticker: "KXUFCFIGHT", title: "UFC Fight winner" },
      { t: "single", ticker: "KXUFCMOV", title: "UFC Method of Victory" },
      { t: "single", ticker: "KXUFCDISTANCE", title: "UFC To Go The Distance" },
      { t: "single", ticker: "KXBOXINGFIGHT", title: "Boxing Fight winner" },
    ],
  },
  {
    sport: "Golf", rank: 3,
    note: "Thinnest on alt lines — mostly single-threshold outrights / H2H, so ranked last.",
    knob: "strokes-gained per-player scoring mean + variance; field size for outrights",
    markets: [
      { t: "alt", ticker: "KXPGACUTLINE", title: "PGA Cut Line (what number)" },
      { t: "alt", ticker: "KXPGAWINMARGIN", title: "PGA Win Margin" },
      { t: "single", ticker: "KXPGAH2H", title: "PGA Head-to-Head (+ KXLIVH2H)" },
      { t: "single", ticker: "KXPGAMAKECUT", title: "PGA To Make Cut (+ DP World Tour)" },
      { t: "single", ticker: "KXPGAWIN", title: "Golfer To Win (outright)" },
    ],
  },
];

function ModelNext() {
  const [open, setOpen] = React.useState(true);
  return (
    <div style={{ marginBottom:12, border:`1px solid ${C.border}`, borderRadius:8, background:C.card, padding:"10px 12px" }}>
      <div onClick={() => setOpen(o => !o)} style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", flexWrap:"wrap" }}>
        <span style={{ color:C.blue, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4 }}>Model next · build roadmap</span>
        <span style={{ color:C.dim, fontSize:10 }}>alt-line markets first — more thresholds + yes/no = more chances at edge than a single-line ML</span>
        <span style={{ marginLeft:"auto", color:C.gray, fontSize:11 }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ marginTop:10 }}>
          {MODEL_NEXT.map(s => (
            <div key={s.sport} style={{ marginBottom:12 }}>
              <div style={{ display:"flex", alignItems:"baseline", gap:6, flexWrap:"wrap" }}>
                <span style={{ color:C.text, fontSize:12.5, fontWeight:700 }}>{s.rank} · {s.sport}</span>
                <span style={{ color:C.gray, fontSize:11 }}>{s.note}</span>
              </div>
              <div style={{ color:C.dim, fontSize:10.5, margin:"3px 0 5px" }}>First knob: <span style={{ color:C.gray }}>{s.knob}</span></div>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                {s.markets.map(m => {
                  const green = m.t === "alt" || m.badge === "LIVE";
                  const label = m.badge ?? (m.t === "alt" ? "ALT" : "1-LINE");
                  return (
                  <div key={m.ticker} style={{ display:"flex", alignItems:"center", gap:7, fontSize:11 }}>
                    <span style={{
                      fontSize:8.5, fontWeight:700, padding:"1px 5px", borderRadius:3, letterSpacing:0.3,
                      color: green ? C.green : C.dim,
                      background: green ? "rgba(63,185,80,0.12)" : "transparent",
                      border: `1px solid ${green ? "rgba(63,185,80,0.30)" : C.border}`,
                      minWidth:42, textAlign:"center", flexShrink:0,
                    }}>{label}</span>
                    <span style={{ color:C.text }}>{m.title}</span>
                    <span style={{ color:C.dim, fontSize:9.5, fontFamily:"monospace" }}>{m.ticker}</span>
                  </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- OPS SUMMARY: one plain-language sentence per operating question ---------------
// Four scannable lines from the report payload: picks per game, picks per day, when to
// bet (CLV sign = is the early price better than close?), and new Kalshi markets to
// scout. CLV is the only timing signal we have (a single 3pm→7pm window), so +CLV ⇒ the
// line drifts our way ⇒ bet early; −CLV ⇒ no rush.
function OpsSummary({ d }) {
  const cap = d.optimalPerGameCap ?? 2;
  const clv = (d.clv || []).filter(r => r.avgClvPct != null && r.n >= 5);
  const early = clv.filter(r => r.avgClvPct >= 1).sort((a, b) => b.avgClvPct - a.avgClvPct).slice(0, 3);
  const late  = clv.filter(r => r.avgClvPct <= -1).sort((a, b) => a.avgClvPct - b.avgClvPct).slice(0, 2);
  const nm = d.newMarkets || [];
  const b = (txt, color = C.green) => <b style={{ color }}>{txt}</b>;
  const names = arr => arr.map(r => `${r.sport} ${r.category}`).join(", ");

  const gameLine = <>Bet at most {b(cap)} pick{cap === 1 ? "" : "s"} from any one game.</>;

  // Each qualified pick is independently +EV, so volume only adds expected profit and
  // diversifies variance — there is no count at which betting more lowers per-bet ROI.
  // The only real ceiling is total simultaneous bankroll exposure (⅛-Kelly per pick).
  const dayLine = <>Bet {b("every qualified pick", C.green)} — each is independently +EV, so more only helps; the one real ceiling is total bankroll exposure (⅛-Kelly per pick).</>;

  let timeLine;
  if (early.length) {
    timeLine = <>Bet {b(names(early), C.green)} early at lineup-confirm — the line drifts our way by close (+{early[0].avgClvPct.toFixed(1)}¢){late.length ? <>; {b(names(late), C.amber)} can wait until nearer tip-off</> : null}.</>;
  } else if (late.length) {
    timeLine = <>No early-fill edge — {b(names(late), C.amber)} prices improve nearer tip-off, so there's no rush.</>;
  } else {
    timeLine = <>Timing is a wash so far, so bet whenever the lineup confirms.</>;
  }

  const nmName = m => m.title || m.sampleSubtitle || m.ticker;
  const nmLine = nm.length
    ? <>Scout {b(nm.length, C.blue)} new Kalshi market{nm.length === 1 ? "" : "s"}: {nm.slice(0, 6).map(nmName).join(", ")}{nm.length > 6 ? "…" : ""}.</>
    : <>No new Kalshi markets to scout.</>;

  const li = (label, body) => (
    <div style={{ display:"flex", gap:8, marginBottom:4 }}>
      <span style={{ color:C.gray, fontSize:10.5, fontWeight:700, minWidth:84, flexShrink:0, textTransform:"uppercase", letterSpacing:0.3, paddingTop:1 }}>{label}</span>
      <span style={{ color:C.text, fontSize:12.5, lineHeight:1.45 }}>{body}</span>
    </div>
  );

  return (
    <div style={{ marginBottom:8 }}>
      {li("Per game", gameLine)}
      {li("Per day", dayLine)}
      {li("When", timeLine)}
      {li("New mkts", nmLine)}
    </div>
  );
}

// ---- OPS: one-line playbook + collapsed supporting tables --------------------------
function OpsSection({ d }) {
  const [open, setOpen] = React.useState(false);
  const cap = d.optimalPerGameCap ?? 2;
  return (
    <div>
      <div style={sectionHead}>Ops · daily playbook</div>
      <OpsSummary d={d} />
      <div onClick={() => setOpen(o => !o)} role="button" style={{ cursor:"pointer", color:C.dim, fontSize:10.5, marginBottom:8 }}>
        {open ? "▾ hide" : "▸ show"} detail tables (picks/game, picks/day, CLV, new markets)
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
          {/* New markets — actual Kalshi titles, ticker as dim secondary */}
          {d.newMarkets?.length > 0 && (
            <div style={{ marginTop:8 }}>
              <div style={sectionTitle}>New Kalshi markets (not yet consumed) · {d.newMarkets.length}</div>
              <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                {d.newMarkets.slice(0, 12).map(m => (
                  <div key={m.ticker} style={{ fontSize:11, display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ color:C.text }}>{m.title || m.sampleSubtitle || m.ticker}</span>
                    <span style={{ color:C.dim, fontSize:9.5, fontFamily:"monospace" }}>{m.ticker}</span>
                    {m.firstSeen && <span style={{ color:C.dim, fontSize:9.5 }}>· {m.firstSeen}</span>}
                  </div>
                ))}
                {d.newMarkets.length > 12 && <div style={{ color:C.dim, fontSize:10 }}>+{d.newMarkets.length - 12} more…</div>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- GATE DIGEST: one line above the board — what (if anything) to change today ----
// Digests the board's per-category `doThis.action`: counts only the three CHANGE actions
// (add / pull / tune) and ignores steady-state ones (keep betting / build / stay out), so
// the common "nothing moved" day reads as a single reassuring line.
function GateDigest({ board }) {
  if (!board?.length) return null;
  const act = a => board.filter(e => e.doThis?.action === a);
  const promotes = act("Add to gate"), pulls = act("Pull from gate"), tunes = act("Tune down");
  const liveCount = board.filter(e => e.gated).length;
  const names = arr => arr.map(e => `${e.sport} ${e.category}`).join(", ");
  const b = (txt, color) => <b style={{ color }}>{txt}</b>;

  let body;
  if (liveCount === 0 && !promotes.length) {
    // Empty-gate posture (2026-06-19): all categories failed formula-clean validation and were
    // pulled. Document the deliberate full-stop rather than reading "keep betting 0 categories".
    body = <><b style={{ color:C.red }}>Gate is empty — sitting out.</b> No category currently beats the market on formula-clean data (Brier + in-gate ROI). Re-enable one only when it clears {b("n≥50 + band coherence + non-negative Brier", C.amber)}.</>;
  } else if (!promotes.length && !pulls.length && !tunes.length) {
    body = <>No changes today — keep betting the {b(liveCount, C.green)} live categor{liveCount === 1 ? "y" : "ies"}.</>;
  } else {
    const parts = [];
    if (promotes.length) parts.push(<>add {b(names(promotes), C.green)}</>);
    if (pulls.length)    parts.push(<>pull {b(names(pulls), C.red)}</>);
    if (tunes.length)    parts.push(<>tune down {b(names(tunes), C.amber)}</>);
    body = <>Act today: {parts.map((p, i) => <React.Fragment key={i}>{i ? "; " : ""}{p}</React.Fragment>)}.</>;
  }

  return (
    <div style={{ display:"flex", gap:8, marginBottom:8 }}>
      <span style={{ color:C.gray, fontSize:10.5, fontWeight:700, minWidth:40, flexShrink:0, textTransform:"uppercase", letterSpacing:0.3, paddingTop:1 }}>Gate</span>
      <span style={{ color:C.text, fontSize:12.5, lineHeight:1.45 }}>{body}</span>
    </div>
  );
}

// ---- DO THIS: the single top-priority action for the morning, across the whole page ----
// A fall-through priority ladder — pick the first tier that has something actionable as the
// PRIMARY "do this", render the rest as a dimmed queued "then →" ladder so the next moves are
// visible at a glance. Tiers: (1) data health — bad data poisons everything below, so a cron /
// coverage / resolution / CLV warning trumps all; (2) model changes pending on the board (gate
// promote/demote, tune-down, or an input/residual investigation); (3) build the next market on
// the MODEL_NEXT roadmap; (4) expand the platform (Polymarket). 3 and 4 are always "available",
// so on a quiet, healthy day the primary becomes "build next market" with Polymarket queued.
const _CHANGE_ACTIONS = {
  "Add to gate":    { tone:"green", verb:"Promote" },
  "Pull from gate": { tone:"red",   verb:"Pull from gate" },
  "Tune down":      { tone:"amber", verb:"Tune down" },
  "Look deeper":    { tone:"blue",  verb:"Investigate" },
};
function _doThisCandidates(d) {
  const out = [];
  // 1 — data health (cron failures / under-logged slate / partial resolution / low CLV capture).
  const warns = d?.dataHealth?.warnings || [];
  if (warns.length) {
    out.push({ tier:1, tone:"red", label:"Fix data health", why: warns.join(" · "), short:"Fix data health" });
  }
  // 2 — model changes pending on the board (promotion / demotion / tuning / input investigation).
  const changes = (d?.modelBoard || []).filter(e => _CHANGE_ACTIONS[e?.doThis?.action]);
  if (changes.length) {
    const byAction = {};
    for (const e of changes) (byAction[e.doThis.action] ||= []).push(`${e.sport} ${e.category}`);
    const parts = Object.entries(byAction).map(([a, names]) => `${_CHANGE_ACTIONS[a].verb} ${names.join(", ")}`);
    const lead = changes[0];
    out.push({ tier:2, tone:_CHANGE_ACTIONS[lead.doThis.action].tone,
      label: parts.join("; "),
      why: lead.doThis.why || "model change pending on the board",
      short:`${changes.length} model change${changes.length>1?"s":""}` });
  }
  // 3 — build the next market on the roadmap (lowest rank wins; for the infra row, name its NEXT
  // item). Skip an infra row whose work is all shipped or data-gated (no NEXT badge) so the
  // quiet-day action falls through to the next thing actually buildable now.
  const next = [...MODEL_NEXT]
    .sort((a,b) => a.rank - b.rank)
    .find(s => !s.infra || s.markets?.some(m => m.badge === "NEXT"));
  if (next) {
    const nextItem = next.markets?.find(m => m.badge === "NEXT");
    const label = next.infra && nextItem ? `Build ${nextItem.ticker}` : `Build ${next.sport}`;
    out.push({ tier:3, tone:"blue", label, why: nextItem?.title || next.note, short: label });
  }
  // 4 — expand to a new platform (strategic backlog floor; primary only when nothing above is actionable).
  out.push({ tier:4, tone:"gray", label:"Expand to Polymarket",
    why:"new platform (US, no-crypto) — widen the surface beyond Kalshi", short:"Polymarket" });
  return out;
}
function DoThisBanner({ d }) {
  if (!d || d.notYet || d.error) return null;
  const cands = _doThisCandidates(d);
  if (!cands.length) return null;
  const [primary, ...rest] = cands;
  const color = _TONE[primary.tone] || C.blue;
  return (
    <div style={{ background:`${color}14`, border:`1px solid ${color}66`, borderRadius:8, padding:"10px 14px", marginBottom:14 }}>
      <div style={{ color:C.gray, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:0.5, marginBottom:5 }}>Do this today</div>
      <div style={{ color, fontSize:15, fontWeight:700 }}>▶ {primary.label}</div>
      {primary.why && <div style={{ color:C.text, fontSize:12, marginTop:3, lineHeight:1.4 }}>{primary.why}</div>}
      {rest.length > 0 && (
        <div style={{ color:C.dim, fontSize:11, marginTop:6 }}>then → {rest.map(r => r.short).join(" · ")}</div>
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
          {d?.error ? `Error: ${d.error}` : "Report not yet generated — cron runs at 6am PT. Click Refresh to generate now."}
        </span>
        <button onClick={() => fetchShadowReport(true)} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"2px 8px", cursor:"pointer" }}>Refresh</button>
      </div>
    );
  }

  return (
    <div>
      <DoThisBanner d={d} />

      {/* Title row */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
        <span style={{ color:C.blue, fontSize:13, fontWeight:700 }}>Model Report</span>
        {d.reportDate && <span style={{ color:C.dim, fontSize:11 }}>{d.reportDate}</span>}
        {d.generatedAt && <span style={{ color:C.dim, fontSize:10 }}>· generated {new Date(d.generatedAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"})} PT</span>}
        <button onClick={() => fetchShadowReport(true)} style={{ marginLeft:"auto", background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:10, padding:"2px 8px", cursor:"pointer" }}>↻ Refresh</button>
      </div>

      <DataHealth dh={d.dataHealth} />

      <ModelNext />

      <OpsSection d={d} />

      <div style={sectionHead}>Model board · the gate decision</div>
      <GateDigest board={d.modelBoard} />
      <ModelBoard board={d.modelBoard} />
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
