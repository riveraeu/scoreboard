import React from 'react';
import { SERIES_CONFIG } from '../../api/lib/series-config.js';
import { CATEGORY_BET_WINDOWS } from '../../api/lib/config.js';
// Dated diagnose/window HOLD maps — shared with the shadow-report daily brief so the brief and
// the Do-this banner agree on what's already been diagnosed and parked.
import { INPUT_SEARCH_EXHAUSTED, WINDOW_SEARCH_EXHAUSTED, stillExhausted as _stillExhausted } from '../../api/lib/model-holds.js';

// A build-roadmap entry counts as SHIPPED once any of its Kalshi tickers exists in
// SERIES_CONFIG — which we ALWAYS edit when a market ships. Deriving "shipped" from that
// single source of truth (instead of a hand-maintained flag) is what keeps the "Do this
// today" banner from advertising a market we already built: it self-advances the moment a
// new series lands in the config. (Phase-2/placeholder tickers absent from the config —
// e.g. KXEPLTOTAL, KXUFCROUNDS — correctly read as not-yet-shipped.)
const _isShippedRoadmapEntry = (s) => !!s?.markets?.some(m => SERIES_CONFIG[m.ticker]);

// --- Report page (daily model briefing) -----------------------------------------
// Leads with DO THIS (a single top-priority action across the whole page, picked by a
// fall-through ladder: data health → model changes → validate ripe shadow models → build next
// market → vet shortlisted → triage detected markets → Polymarket),
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
// Accuracy (Layer-1) verdict styling — Brier vs market, no price.
const _ACC = {
  CALIBRATED:     ["calibrated",     C.green, "rgba(63,185,80,0.10)"],
  PROMISING:      ["promising",      C.green, "rgba(63,185,80,0.10)"],   // beats price, calibration still thin
  UNDERCONFIDENT: ["underconfident", C.amber, "transparent"],
  OVERCONFIDENT:  ["overconfident",  C.red,   "transparent"],
  MARKET_SHARPER: ["market sharper", C.red,   "rgba(248,81,73,0.08)"],   // terminal: market out-predicts, trend flat/falling
  BUILDING:       ["building",       C.dim,   "transparent"],
};
function AccBadge({ v }) {
  const [label, color] = _ACC[v] || [v, C.dim];
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
// Learning trend — is Brier skill still rising as data accrues (still learning), or flat (saturated)?
// recent-half minus early-half paired skill. Arrow + value; dim until each half clears n≥100.
const _LEARN_FLAT = 0.003; // |trend| below this reads "flat" (saturated)
function LearnCell({ learning }) {
  if (!learning || learning.skillTrend == null) return <span style={{ color:C.dim, fontSize:10 }}>—</span>;
  const { skillTrend: t, reliable, betaStar } = learning;
  const arrow = t > _LEARN_FLAT ? "↗" : t < -_LEARN_FLAT ? "↘" : "→";
  const color = !reliable ? C.dim : t > _LEARN_FLAT ? C.green : t < -_LEARN_FLAT ? C.red : C.gray;
  const meaning = t > _LEARN_FLAT ? "still learning — skill rising as data accrues"
    : t < -_LEARN_FLAT ? "degrading — skill falling (check for a formula regression)"
    : "saturated — reweighting tapped out; flat+below-price ⇒ needs a new input";
  return <span title={`learning trend (recent-half − early-half Brier skill) = ${t>=0?"+":""}${t}. ${meaning}.${betaStar!=null?` Suggested L2 step β*=${betaStar} (move truePct by β*·gap).`:""}${reliable?"":" · each half n<100, not yet trusted"} Fine-grained curve: npm run tune:learncurve`}
    style={{ color, fontSize:11, fontWeight:600, cursor:"help" }}>{arrow}{reliable ? ` ${t>=0?"+":""}${t.toFixed(3)}` : ""}</span>;
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

// ── LAYER 1 — Model ACCURACY board: is the model accurate? (calibration vs reality) ──
// Verdict scored on truePct calibration (model% vs actual hit%). NO price, NO ROI. The "vs Market"
// column (Brier skill) is the secondary price comparison + the bridge to the betting board.
function AccuracyBoard({ board }) {
  const [expanded, setExpanded] = React.useState({});
  const [showAccruing, setShowAccruing] = React.useState(false);
  if (!board?.length) return null;
  const honestyN = r => (r.calibBands || []).reduce((s, b) => s + (b.n || 0), 0);

  // Sort by N desc; split off the n<50 thin pile (not yet judgeable) behind a toggle so the table
  // shows only categories with enough data to act on. Off-season sports (NBA/NHL in summer) fall
  // into the thin pile automatically as their n drops — no season hardcoding, self-heals on return.
  // Gated/live categories always stay in the main view regardless of n.
  const byN = (a, b) => b.n - a.n;
  const gated = board.filter(r => r.gated).sort(byN);
  const actionable = board.filter(r => !r.gated && r.n >= 50).sort(byN);
  const accruing = board.filter(r => !r.gated && r.n < 50).sort(byN);

  const Row = ({ r }) => {
    const open = expanded[r.key];
    return (
      <>
        <tr onClick={() => setExpanded(e => ({ ...e, [r.key]: !e[r.key] }))}
            style={{ cursor:"pointer", background:_ACC[r.verdict]?.[2] || "transparent" }}>
          <td style={{ ...tdB, textAlign:"left", color:C.text, fontWeight:600 }}>
            <span style={{ color:C.dim, marginRight:4 }}>{open ? "▾" : "▸"}</span>{r.key}
            {r.gated && <span title="Currently bet — in the live truePct gate" style={{ color:C.green, fontSize:9, fontWeight:700, marginLeft:6, whiteSpace:"nowrap" }}>● live</span>}
          </td>
          <td style={tdB}><AccBadge v={r.verdict} /></td>
          <td style={tdB}><HonestyCell calib={r.calib} /></td>
          <td style={{ ...tdB, color:C.gray, fontSize:10 }}>{r.modelBrier ?? "—"}</td>
          <td style={tdB}><SkillCell skill={r.skill} skillN={r.n} modelBrier={r.modelBrier} marketBrier={r.marketBrier} /></td>
          <td style={tdB}><LearnCell learning={r.learning} /></td>
          <td style={{ ...tdB, color:r.n>=100?C.text:r.n>=50?C.gray:C.dim }}>{r.n}</td>
        </tr>
        {open && (
          <tr><td colSpan={7} style={{ padding:"0 8px 6px 22px", background:"#0d1117" }}>
            {(() => {
              // MARKET_SHARPER's server action is "Diagnose then stop" (run tune:residual once).
              // Collapse it to a true stop once the L0 search is exhausted (diagnostic already ran
              // empty) — un-collapses automatically if a formula reset re-accrues clean data.
              const exhausted = r.verdict === "MARKET_SHARPER" && _stillExhausted(INPUT_SEARCH_EXHAUSTED, r.key, r.formulaCutoff);
              const act = exhausted ? "Stop — search exhausted" : r.honest?.action;
              const why = exhausted
                ? "market sharper AND the L0 input search is exhausted (no addable in-data dimension; historical pre-filters failed) — park it, redirect effort to a less-efficient market"
                : r.honest?.why;
              if (!act || !why) return null;
              return (
                <div style={{ color: exhausted ? C.dim : (_TONE[r.honest?.tone]||C.gray), fontSize:11, margin:"4px 0" }}>
                  ▶ <b>{act}</b>: <span style={{ color:C.text }}>{why}</span>
                </div>
              );
            })()}
            {r.skill != null && (
              <div style={{ color:C.dim, fontSize:10, margin:"2px 0 4px" }}>
                Brier skill <b style={{ color: (r.n>=100) ? (r.skill>0?C.green:r.skill<-0.005?C.red:C.gray) : C.dim }}>{r.skill>=0?"+":""}{r.skill.toFixed(3)}</b>
                {" "}— model {r.modelBrier ?? "—"} vs market {r.marketBrier ?? "—"} (n={r.n}){r.skillLoCI!=null?` · CI lo ${r.skillLoCI>=0?"+":""}${r.skillLoCI}`:""} · {r.skill>0?"model sharper than the price":"market sharper than the model"}{r.n<100?" · n<100, not yet trusted":""}
              </div>
            )}
            <div style={{ color:C.dim, fontSize:9, fontWeight:700, margin:"4px 0 1px" }}>HONESTY · model% vs actual (Δ&lt;0 = overconfident) · <span style={{ color:C.gray, fontWeight:400 }}>{honestyN(r)} resolved plays, no edge/dc gate</span> · <span style={{ color:C.green }}>green = currently-bet slice</span></div>
            <CalibBandsTable bands={r.calibBands} />
          </td></tr>
        )}
      </>
    );
  };

  return (
    <div style={{ marginBottom:10 }}>
      <div style={sectionTitle}>
        Is the model accurate? · verdict from truePct calibration (model% vs actual hit%) — no price, no ROI · "vs Market" is the secondary price comparison + the bridge to betting
      </div>
      <table style={tableStyle}>
        <thead><tr>{["Category","Verdict","Honesty","Model Brier","vs Market","Learning","N"].map(h => {
          const tip = h==="vs Market" ? "Brier skill = market-Brier − model-Brier over all resolved plays. >0 (green) = model sharper than the price (this is what makes a category bettable); <0 (red) = market is the sharper estimator. Dim until n≥100. Not part of the accuracy verdict."
            : h==="Verdict" ? "Calibration vs reality: Calibrated (model% matches actual within noise) · Overconfident / Underconfident (proven miscalibration → Recalibrate if the model beats the price, Improve inputs only if the market is TRUSTABLY sharper at n≥100, else Accruing while model-vs-market is undecided) · Building (not enough resolved plays to judge)."
            : h==="Model Brier" ? "Mean squared error of the model's probability vs the actual outcome — pure accuracy, no price. Lower = better."
            : h==="Learning" ? "Is the model still learning? Recent-half minus early-half Brier skill (current-formula window). ↗ green = skill rising as data accrues (keep accruing). → flat = saturated (reweighting tapped out). Dim until each half n≥100. Fine-grained curve + β* step size: npm run tune:learncurve."
            : undefined;
          return <th key={h} style={{ ...thB, cursor:tip?"help":undefined }} title={tip}>{h}</th>;
        })}</tr></thead>
        <tbody>
          {gated.map(r => <Row key={r.key} r={r} />)}
          {actionable.map(r => <Row key={r.key} r={r} />)}
          {accruing.length > 0 && !showAccruing && (
            <tr><td colSpan={7} style={{ ...tdB, textAlign:"left", color:C.dim, cursor:"pointer" }} onClick={() => setShowAccruing(true)}>
              ▸ {accruing.length} more thin (n &lt; 50, off-season + low data) — show
            </td></tr>
          )}
          {showAccruing && accruing.map(r => <Row key={r.key} r={r} />)}
        </tbody>
      </table>
      <div style={{ color:C.dim, fontSize:10, marginTop:5, lineHeight:1.55 }}>
        <b style={{ color:C.green }}>Calibrated</b> = model% matches actual outcomes within noise ·
        <b style={{ color:C.red }}> Overconfident</b> / <b style={{ color:C.amber }}>Underconfident</b> = proven miscalibration → <b style={{ color:C.amber }}>Recalibrate</b> (L2 de-shrink) when the model beats the price, <b style={{ color:C.amber }}>Improve inputs</b> (L0 new input — run tune:residual) only when the market is trustably sharper (n≥100), else <b style={{ color:C.dim }}>Accruing</b> while undecided ·
        <b style={{ color:C.dim }}> Building</b> = not enough resolved plays to judge calibration yet ·
        <b style={{ color:C.green }}> Promising</b> = beats the price already (skill&gt;0, n≥100) but calibration still thin → accrue toward eligibility ·
        <b style={{ color:C.red }}> Market sharper</b> = market out-predicts the model (skill&lt;0, n≥100) and the trend isn't recovering → <b style={{ color:C.red }}>Diagnose then stop</b> (run tune:residual ONCE for a sub-slice / L0, then park if empty). <b style={{ color:C.green }}>vs Market</b> &gt; 0 = the model also beats the price (→ bettable). Click a row for its calibration bands + Brier breakdown.
      </div>
    </div>
  );
}

// ── LAYER 2 — BETTING board: what to bet (price/ROI), gated by Layer-1 eligibility ──
// Only bettable rows appear: eligible models (model beats the price) + any currently-gated/live
// category (shown regardless so a "Pull from gate" signal stays visible). Ineligible, ungated
// categories are dropped entirely — when nothing qualifies the board renders an empty state, so a
// tempting ROI on a model the market already beats never tempts from here. (The accuracy board
// above is where every category, bettable or not, is judged.)
function BettingBoard({ board }) {
  const [expanded, setExpanded] = React.useState({});
  const [showBuilding, setShowBuilding] = React.useState(false);
  if (!board?.length) return null;

  const byN = (a, b) => b.n - a.n;
  const live = board.filter(r => r.gated).sort(byN);
  const rest = board.filter(r => !r.gated && r.eligible).sort(byN);
  const actionable = rest.filter(r => r.n >= 20);
  const building = rest.filter(r => r.n < 20);
  const isEmpty = live.length === 0 && rest.length === 0;

  const Row = ({ r }) => {
    const w = r.discoveredWindow;
    const open = expanded[r.key];
    const profitN = (r.priceBands || []).reduce((s, b) => s + (b.n || 0), 0);
    return (
      <>
        <tr onClick={() => setExpanded(e => ({ ...e, [r.key]: !e[r.key] }))}
            style={{ cursor:"pointer", opacity:r.eligible?1:0.5, background:_BOARD[r.verdict]?.[2] || "transparent" }}>
          <td style={{ ...tdB, textAlign:"left", color:C.text, fontWeight:600 }}>
            <span style={{ color:C.dim, marginRight:4 }}>{open ? "▾" : "▸"}</span>{r.key}
            {r.gated && <span title="Currently bet — in the live truePct gate" style={{ color:C.green, fontSize:9, fontWeight:700, marginLeft:6, whiteSpace:"nowrap" }}>● live</span>}
          </td>
          <td style={tdB}><DoThisBadge d={r.doThis} /></td>
          <td style={tdB}><BoardBadge v={r.verdict} /></td>
          <td style={{ ...tdB, color:C.gray }}>{w ? `${w.lo}–${w.hi}¢` : "—"}</td>
          <td style={{ ...tdB, color:_roiColorFrac(w?.roi), fontWeight:600 }}>{w ? _pct1(w.roi) : "—"}</td>
          <td style={{ ...tdB, color:r.n>=50?C.text:r.n>=30?C.gray:C.dim }}>{r.n}</td>
          <td style={{ ...tdB, color:r.eligible?C.green:C.dim, fontSize:9, fontWeight:700 }} title={r.eligible?"Model beats the price — bettable":"Model doesn't beat the price — unbettable"}>{r.eligible?"eligible":"—"}</td>
        </tr>
        {open && (
          <tr><td colSpan={7} style={{ padding:"0 8px 6px 22px", background:"#0d1117" }}>
            {r.doThis?.why && (
              <div style={{ color:_TONE[r.doThis.tone]||C.gray, fontSize:11, margin:"4px 0" }}>
                ▶ <b>{r.doThis.action}</b>: <span style={{ color:C.text }}>{r.doThis.why}</span>
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
          </td></tr>
        )}
      </>
    );
  };

  if (isEmpty) {
    return (
      <div style={{ marginBottom:10 }}>
        <div style={sectionTitle}>
          What to bet · only models that beat the price appear here · current window 67–91¢
        </div>
        <div style={{ color:C.dim, fontSize:12, padding:"14px 8px", textAlign:"center", border:`1px dashed ${C.border}`, borderRadius:6 }}>
          No bettable models — no category currently beats the price (see the accuracy board above). Nothing to bet.
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom:10 }}>
      <div style={sectionTitle}>
        What to bet · only models that beat the price appear here · current window 67–91¢
      </div>
      <table style={tableStyle}>
        <thead><tr>{["Category","Do this","Window status","Window","ROI","N","Eligible"].map(h => {
          const tip = h==="N" ? "Bettable plays (edge≥3, dc≥7) across the full price range — no 67–91 / truePct gate."
            : h==="Eligible" ? "Does the model beat the price (Layer-1 Brier skill CI lo > 0)? Only eligible categories are bettable; ineligible rows are greyed."
            : undefined;
          return <th key={h} style={{ ...thB, cursor:tip?"help":undefined }} title={tip}>{h}</th>;
        })}</tr></thead>
        <tbody>
          {live.map(r => <Row key={r.key} r={r} />)}
          {actionable.map(r => <Row key={r.key} r={r} />)}
          {building.length > 0 && !showBuilding && (
            <tr><td colSpan={7} style={{ ...tdB, textAlign:"left", color:C.dim, cursor:"pointer" }} onClick={() => setShowBuilding(true)}>
              ▸ {building.length} more thin (n &lt; 20 bettable) — show
            </td></tr>
          )}
          {showBuilding && building.map(r => <Row key={r.key} r={r} />)}
        </tbody>
      </table>
      <div style={{ color:C.dim, fontSize:10, marginTop:5, lineHeight:1.55 }}>
        <b style={{ color:C.green }}>Add to gate</b> = eligible + validated window, start betting ·
        <b style={{ color:C.red }}> Pull from gate</b> = gated but window went negative ·
        <b style={{ color:C.blue }}> Look deeper</b> = beats the price but the window still loses (selection/sizing puzzle). Ineligible models (the market beats them) are hidden — see the accuracy board. Click a row for its price-band breakdown.
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
    knob: "two-board split: ACCURACY (Brier vs market, Layer 1) gates BETTING (price/ROI, Layer 2) — eligible = model provably beats the price",
    markets: [
      { t: "infra", badge: "LIVE", ticker: "Two-board split", title: "Accuracy board (does the model beat the price?) gates the betting board (what to bet) — separates model quality from bet selection" },
      { t: "infra", badge: "LIVE", ticker: "Skill column", title: "Brier skill on the accuracy board — does the model beat the price? (market-Brier − model-Brier)" },
      { t: "infra", badge: "LIVE", ticker: "tune:residual", title: "Phase 2 CLI — slice residuals by stored dims (features JSONB), ranked by gradient + per-bucket Brier skill (npm run tune:residual). Exercised against its first LIVE miss 2026-06-24 (mlb|totalBases): n=140 too thin to rank any dimension, no L0 candidate — re-run at n≥200." },
      { t: "infra", badge: "LIVE", ticker: "Recalibrate vs Improve-inputs fork", title: "_accuracyAction forks miscalibrated categories on Brier skill into 3 states (2026-06-24 → split 2026-06-25): model sharper by sign → Recalibrate (L2; thin +skill tagged provisional, banner-gated to n≥200), market TRUSTABLY sharper (skill<0 @ n≥100) → Improve inputs (L0 new input — the only state that nags), else Accruing. Fixed both mlb|totalBases/hits (told to find a new input when a reweight is the fix) AND model-sharper-but-thin cats like wnba|threePointers (skill +0.045/n=33 mislabeled 'needs a NEW input')." },
      { t: "infra", badge: "LIVE", ticker: "Exogenous feature stamp", title: "Standardized x* namespace in extractFeatures (xVolume/xSpread/xLineMove/xLineupConfirmed/xRestDays/xWindOutMph/xTempF) so EVERY category — not just props — carries the raw market-independent dims a mispricing signal lives in; MLB run markets now log game-time weather; tune:residual ranks native+f:x* first (--all-features for intermediates). Shipped 2026-06-26, forward-only." },
      { t: "infra", badge: "TODO ~2026-07-10", ticker: "re-open exhausted run markets", title: "Once x* dims have accrued (~2wk), DROP the run-market keys (mlb|totalRuns etc.) from INPUT_SEARCH_EXHAUSTED so the banner re-fires Improve inputs → run tune:residual against the NEW liquidity (xVolume/xSpread) hypothesis. Premature today — x* has zero rows, the nag would slice empty data. Liquidity is the fresh part; weather→runs was already rejected (project-weather-runs-study)." },
      { t: "infra", badge: "LIVE", ticker: "capture-window de-blinding", title: "tune:residual on mlb|totalBases (n=255) + hits (n=185), 2026-06-29: the bettable edge lives ABOVE the [67,91] cap — but [67,91] was ALSO the shadow-CAPTURE gate, so calibration was blind to its own edge band (max logged price was exactly 91). Fix (844de25): split config into the bet window [67,91] (qualified flag, unchanged) vs a wider CAPTURE_GATE 55 / CAP 97 logging band, applied at the tonight.js collection pre-filters + every phase-1 shadow module. Dropped the per-category BET-window idea — a hand-set [80,95] just trades one assumption for another. Forward-only; live-verified 55–97 capture, bet rows still gate [67,91]. [[project-percategory-price-window]]" },
      { t: "infra", badge: "TODO ~data-gated", ticker: "derive bet selection from calibration", title: "Once the wider capture data accrues (~2wk) AND a category becomes skill-eligible: replace the two hand-set bet assumptions with data-derived selection — (1) bet window = bettingBoard.discoveredWindow, not [67,91]; (2) demote the fixed edge gate (EDGE_GATE 3/5) to a per-category data-derived selector subordinate to skill. edgeBucketRoi (2026-06-29) shows ROI flat-negative across EVERY edge band → edge doesn't predict ROI (it's endogenous, real only where Brier skill>0). Make bettingBoard.eligible (skillLoCI>0 & n≥100) the PRIMARY live gate — today it only drives display; the live path still runs passesCategoryGate + the fixed edge gate. Untestable until a category beats the market → forward-only, NOT a today action. [[project-edge-gate-subordinate-to-skill]]" },
      { t: "infra", badge: "LATER", ticker: "residual board column", title: "Surface the slice on /model — upgrade Look deeper → Reweight (L2) / Add input: ⟨dim⟩ (L0); gated until a category has a live surviving miss" },
    ],
  },
  {
    // Soccer Phase 1 (World Cup) SHIPPED 2026-06-21 — shadow-only, one Elo-derived Dixon–Coles
    // Poisson matrix per game feeds all 5 families (1X2/total/teamTotal/spread/BTTS). Kept on the
    // roadmap so the club-league Phase-2 extension stays visible; it's auto-detected as shipped
    // (KXWCGAME is in SERIES_CONFIG) → the banner skips it and advances to the next unbuilt market.
    sport: "Soccer", rank: 1,
    note: "Phase 1 (World Cup) shipped — shadow-only. One Elo goal-rate → score matrix covers totals + team totals + spread + 1X2 + BTTS.",
    knob: "national-team Elo → goal supremacy → DC-Poisson matrix (μ=2.7, C=160, ρ=−0.13); Phase 2 = attack/defence ratings + host bump + club leagues",
    markets: [
      { t: "single", badge: "LIVE", ticker: "KXWCGAME", title: "World Cup — 1X2 / total / team total / spread / BTTS (all 5 live in shadow)" },
      { t: "single", badge: "LIVE", ticker: "KXWCADVANCE", title: "World Cup knockout \"to advance\" — Elo matrix + ET/penalties draw allocation (live in shadow)" },
      { t: "alt", badge: "LATER", ticker: "KXEPLTOTAL", title: "Club leagues (EPL / La Liga / Serie A / Bundesliga / MLS / UCL) — Phase 2, offseason now; needs club Elo" },
    ],
  },
  {
    // Fighting Phase 1 (UFC rounds O/U) SHIPPED 2026-06-21 — shadow-only. Pure fight-duration
    // model: one weight-class finish-rate → constant per-round hazard → "ends before round N" CDF,
    // independent of who wins (sidesteps the thin MMA rating data). Auto-detected as shipped
    // (KXUFCROUNDS is in SERIES_CONFIG) → the banner advances to the next unbuilt market.
    sport: "Fighting", rank: 2,
    note: "Phase 1 (UFC rounds O/U) shipped — shadow-only. Winner deferred (no independent fighter rating; sportsbook odds would launder the market); method-of-victory doesn't exist on Kalshi.",
    knob: "weight-class finish rate → per-round hazard → fight-duration CDF; Phase 2 = per-round hazard vector + fighter durability, then winner off a real fighter Elo",
    markets: [
      { t: "alt", badge: "LIVE", ticker: "KXUFCROUNDS", title: "UFC rounds O/U — \"ends before round N\" (live in shadow)" },
      { t: "single", badge: "LATER", ticker: "KXUFCFIGHT", title: "UFC Fight winner — Phase 1b, needs a fighter Elo" },
      { t: "single", badge: "LATER", ticker: "KXBOXINGFIGHT", title: "Boxing Fight winner — Phase 2" },
    ],
  },
  {
    // Golf Phase 1 (PGA single-round head-to-head) SHIPPED 2026-06-21 — shadow-only. OWGR rating
    // → one-round score differential (field-independent, like tennis). Auto-detected as shipped
    // (KXPGAH2H is in SERIES_CONFIG) → the banner advances to the next unbuilt market.
    sport: "Golf", rank: 3,
    note: "Phase 1 (PGA H2H) shipped — shadow-only. OWGR rating → one-round score differential. Coverage is thin (single-round variance keeps most matchups <67%). Phase 2 = field sim → make-cut + cut-line (the alt-line families).",
    knob: "OWGR avg-points → strokes-vs-field skill → Normal one-round differential (scale 1.7, σ 2.8); Phase 2 = strokes-gained rating + 36-hole field simulation",
    markets: [
      { t: "single", badge: "LIVE", ticker: "KXPGAH2H", title: "PGA single-round head-to-head (live in shadow)" },
      { t: "single", badge: "LATER", ticker: "KXPGAMAKECUT", title: "PGA make-cut — Phase 2, needs field sim" },
      { t: "alt", badge: "LATER", ticker: "KXPGACUTLINE", title: "PGA cut line (alt) — Phase 2, falls out of the field sim" },
      { t: "single", badge: "LATER", ticker: "KXPGAWIN", title: "Outright winner — sub-window longshot" },
    ],
  },
  {
    // NASCAR Phase 1 (Cup H2H + Top-10) SHIPPED 2026-06-22 — shadow-only. Recent-form finishing-
    // position model (μ = last-10-race avg finish, σ=9). Auto-detected as shipped (KXNASCARH2H is in
    // SERIES_CONFIG) → the banner skips it and advances to the next unbuilt market.
    sport: "NASCAR", rank: 4,
    note: "Phase 1 (Cup H2H + Top-10) shipped — shadow-only. Cup-only by construction (the rating index is built from the Cup schedule, so Truck/Xfinity-only drivers drop out).",
    knob: "μ = mean finish over last 10 Cup races (min 3 starts), league σ=9; pBeats Φ((μB−μA)/√2σ) + pTopN Φ((10.5−μ)/σ); Phase 2 = per-track/qualifying/manufacturer + recency weighting",
    markets: [
      { t: "single", badge: "LIVE", ticker: "KXNASCARH2H", title: "NASCAR Cup driver head-to-head (live in shadow)" },
      { t: "single", badge: "LIVE", ticker: "KXNASCARTOP10", title: "NASCAR Cup Top-10 finish (live in shadow)" },
    ],
  },
  {
    // MLB Pitcher Outs-Recorded SHIPPED 2026-06-23 — shadow-only. Normal workload model (μ = avgBF ×
    // out-rate, σ 0.90-scaled from the outs-tail accuracy backtest). Auto-detected as shipped
    // (KXMLBOUTS is in SERIES_CONFIG) → the banner skips it and advances to the next unbuilt market.
    sport: "MLB Outs", rank: 5,
    note: "Pitcher outs-recorded O/U shipped — shadow-only. Smoother target than the K tail (manager-leash-dominated); σ calibrated against 2257 historical starts (the feared early-hook left tail was disproven).",
    knob: "μ = avgBF × outRate (outRate = 1−(BAA+.06)), σ = 0.90 × max(stdBF × outRate, 3.5); Phase 2 = pitcher-specific OBP (vs the league walk constant) + opp/park, and pitcher coverage (spot-starter no_pitcher_data drops)",
    markets: [
      { t: "alt", badge: "LIVE", ticker: "KXMLBOUTS", title: "Pitcher outs recorded O/U — alt-line ladder per starter (live in shadow)" },
    ],
  },
  {
    // Polymarket platform expansion. Phase 1a (cross-venue ML price observatory) SHIPPED 2026-06-23;
    // kill-gate CLOSED 2026-07-04 → Phase 1b trading KILLED (no executable cross-venue edge).
    // infra:true so the "build next" prompt never picks it. The observatory stays live: zero
    // marginal cost, feeds the client Poly reference price on ML cards, and its daily medians
    // would surface a future regime change (e.g. US volume migrating to QCX decoupling prices).
    sport: "Polymarket", rank: 9, infra: true,
    note: "Kill-gate CLOSED 2026-07-04: on post-date-fix data (7/01→) exec.fracEdgeGe3c = 0 — Poly mid sits ~0.5¢ below Kalshi but the walkable ask lands at/above Kalshi every time (mid gap not buyable; meanSigned exec +1¢). 11 days / 402 matched sides: mid median |Δ| 0.5¢ every single day, clean-window fracGe5c = 0. Phase 1b trading + QCX pursuit + totals (1a.1) KILLED; observatory stays as reference feed. Don't re-open unless daily medians move.",
    knob: "Gamma public API → normalize game ML → match our Kalshi rows → CLOB book-walk for executable VWAP; exec.fracEdgeGe3c (% of bettable sides still ≥3¢ cheaper to BUY after slippage) was the go/no-go — it read 0",
    markets: [
      { t: "infra", badge: "LIVE", ticker: "ML observatory", title: "Cross-venue moneyline deltas — mid + book-walked executable VWAP → /api/polymarket-deltas. Kept post-kill as the client Poly reference price + regime-change tripwire (venues track within ~0.5¢; the 14d exec 0.289 was pre-7/01 date-fuzz artifact, rolls clean ~7/09)." },
      { t: "infra", badge: "KILLED", ticker: "Phase 1b trading", title: "KILLED 2026-07-04 at the designed kill-gate: zero surviving post-slippage edge on clean data (exec.fracEdgeGe3c = 0, n=9; mid population n=402 shows no ≥3¢ gaps to walk). Cheap-kill doctrine outcome — observatory built to answer exactly this." },
    ],
  },
];

// ---- GATE DIGEST: one line above the board — what (if anything) to change today ----
// Digests the board's per-category `doThis.action`: counts only the three CHANGE actions
// (add / pull / tune) and ignores steady-state ones (keep betting / build / stay out), so
// the common "nothing moved" day reads as a single reassuring line.
function GateDigest({ board }) {
  if (!board?.length) return null;
  const act = a => board.filter(e => e.doThis?.action === a);
  const promotes = act("Add to gate"), pulls = act("Pull from gate"), looks = act("Look deeper");
  const liveCount = board.filter(e => e.gated).length;
  const names = arr => arr.map(e => `${e.sport} ${e.category}`).join(", ");
  const b = (txt, color) => <b style={{ color }}>{txt}</b>;

  let body;
  if (liveCount === 0 && !promotes.length) {
    // Empty-gate posture (2026-06-19): all categories failed formula-clean validation and were
    // pulled. Document the deliberate full-stop rather than reading "keep betting 0 categories".
    body = <><b style={{ color:C.red }}>Gate is empty — sitting out.</b> No category currently beats the market on formula-clean data (Brier + in-gate ROI). Re-enable one only when it clears {b("n≥50 + band coherence + non-negative Brier", C.amber)}.</>;
  } else if (!promotes.length && !pulls.length && !looks.length) {
    body = <>No changes today — keep betting the {b(liveCount, C.green)} live categor{liveCount === 1 ? "y" : "ies"}.</>;
  } else {
    const parts = [];
    if (promotes.length) parts.push(<>add {b(names(promotes), C.green)}</>);
    if (pulls.length)    parts.push(<>pull {b(names(pulls), C.red)}</>);
    if (looks.length)    parts.push(<>investigate {b(names(looks), C.blue)}</>);
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
// PRIMARY "do this"; the queued rest is no longer shown in the banner (still in the copy text).
// Tiers: (1) data health — bad data poisons everything below, so an ACTIONABLE warning (catastrophic
// resolution, or the same coverage/CLV failure ≥2 days running = live pipeline bug) trumps all;
// (2) betting changes pending on the board (gate promote/demote/investigate); (2.2) accuracy changes
// (Recalibrate / Improve inputs / Diagnose, with ripeness + exhaustion suppression); (2.5) validate
// ripe shadow models — ungated + eligible + n≥50 + STRENGTHENING, the build→gate half of the funnel
// (run tune:gate + Brier); (3) build a NEXT-flagged roadmap market (an explicit "this first"
// override); (3.15) derive a per-category bet window (harvest of already-accrued data — ranks above
// authoring new markets); (3.2) build the next merely-unshipped roadmap market; (3.25) vet
// shortlisted markets (promoted detections, mid-funnel); (3.5) triage detected new markets (the
// funnel's first step); (3.6) sportsbook kill-gate GAP build; (4) SCHEDULED_CHECKPOINTS — dated
// follow-ups (Polymarket 1b, x* re-open, …) that surface on their date and persist until handled;
// (4.6) sportsbook observatory floor; (5) quiet-day floor naming the next upcoming checkpoint.
// Candidates are pushed per-tier then SORTED by tier (push order ≠ priority order since 3.2).
// Betting-board (Layer 2) actions that count as a "model change pending".
const _BET_ACTIONS = {
  "Add to gate":    { tone:"green", verb:"Promote" },
  "Pull from gate": { tone:"red",   verb:"Pull from gate" },
  "Look deeper":    { tone:"blue",  verb:"Investigate" },
};
// Accuracy-board (Layer 1) actions that warrant a model-improvement session.
const _ACC_ACTIONS = {
  "Improve inputs":     { tone:"amber", verb:"Improve inputs for" },     // OVER/UNDER + market sharper → L0 new input
  "Recalibrate":        { tone:"amber", verb:"Recalibrate" },            // model beats price but miscalibrated → L2 de-shrink
  "Diagnose then stop": { tone:"red",   verb:"Diagnose (tune:residual)" }, // MARKET_SHARPER → one-time sub-slice/L0 check, then park
};
// A Recalibrate task isn't safe to act on until the formula-grade bar (n≥200): below it the
// calibration curve is noisy and often non-monotonic (e.g. 2026-06-24 mlb|totalBases under at
// 60-65 but OVER at 75-90 — a uniform de-shrink would worsen the high bands), so a reweight would
// chase a single thin band. Below RECAL_MIN_N the row stays on the accuracy board but is held OUT
// of the daily Do This banner so it doesn't nag an un-ripe task; it resurfaces at n≥200.
const RECAL_MIN_N = 200;
// n≥200 is necessary but NOT sufficient: a category can clear it yet still have a MOVING Brier-skill
// trend (reliable |learning.skillTrend| > _LEARN_FLAT) — rising as data accrues (still learning) OR
// falling (decaying toward a market tie, the wnba|points signature). EITHER direction means the
// calibration gap (and the β* de-shrink step) isn't settled, so locking an L2 reweight now chases a
// moving target. An un-flat-trend Recalibrate is therefore ALSO held off the banner (the board row +
// its ↗/↘ Learning arrow keep showing it); it resurfaces only once the trend flattens (converged).
// (2026-06-28: mlb|totalBases n=251 but skillTrend +0.163 — STILL LEARNING; tune:learncurve says keep
// accruing, not lock the step. mlb|hits is the same shape. See [[project-totalbases-recalibrate-hold]].)
// ---- SCHEDULED CHECKPOINTS: dated follow-ups the ladder must not forget --------------
// Every "come back in ~2 weeks" wait lives HERE (one list, one tier), not in code comments or
// roadmap badges — a comment TODO never fires. Each entry surfaces as a tier-4 banner candidate
// once todayPT >= date and keeps surfacing until handled; REMOVE (or re-date, if the window is
// extended) its entry when the check is done. The quiet-day floor (tier 5) names the NEXT
// upcoming entry so a calm day still shows when the ladder wakes up next.
const SCHEDULED_CHECKPOINTS = [
  // (Polymarket 1b kill-gate checkpoint REMOVED 2026-07-04 — reviewed 3 days early on unambiguous
  // clean data: exec.fracEdgeGe3c = 0 post-date-fix, Phase 1b KILLED. [[project-polymarket-phase1a]])
  // x* exogenous dims (xVolume/xSpread, shipped 2026-06-26) have ~2wk of rows by here: DROP the
  // run-market keys (mlb|totalRuns/teamRuns/f5total/f5spread/spread/ml) from INPUT_SEARCH_EXHAUSTED
  // → the Improve-inputs nag re-fires → run tune:residual against the fresh liquidity hypothesis.
  // Premature before then (x* too thin). [[project-exogenous-feature-stamp]]
  { date: "2026-07-10", tone: "blue", label: "Re-open exhausted run markets (x* sweep)", short: "x* residual sweep",
    why: "xVolume/xSpread dims now have ~2wk of rows — drop the run-market keys from INPUT_SEARCH_EXHAUSTED and run tune:residual against the liquidity hypothesis (the fresh, previously-unsliceable dimension)" },
  // KXLMBGAME (Mexican League ML) dismissed 2026-07-01 on dead Kalshi liquidity (model side was
  // green) — re-check whether yes_ask/volume populated. [[project-lmbgame-vet]]
  { date: "2026-07-15", tone: "gray", label: "Re-check KXLMBGAME liquidity", short: "KXLMBGAME recheck",
    why: "Dismissed 7/01 for dead Kalshi books (0 vol/OI, no MM) with the model side green — if yes_ask now populates, un-dismiss and ship the Pythag-λ model" },
];
// INPUT_SEARCH_EXHAUSTED + _stillExhausted moved to api/lib/model-holds.js (2026-07-01, imported
// above) — shared with the shadow-report daily brief so both surfaces agree on parked diagnostics.

// Per-category bet-window derivation nudge (tier 3.15). WINDOW_RECOMMEND_N = enough settled bets to
// trust a tune:window read (mirrors the CLI's --min-n default + MODEL_IMPROVEMENT.md's window-grade
// floor). WINDOW_SEARCH_EXHAUSTED = categories already run to a TERMINAL no-go (the discovered window
// doesn't hold out-of-sample), so the banner stops nagging — mirrors INPUT_SEARCH_EXHAUSTED, including
// the auto-UN-suppress: a FORMULA_CUTOFF newer than the exhaustion date re-accrues the category clean
// and re-opens the search (via _stillExhausted). A NON-terminal no-go (OOS split merely too thin) does
// NOT belong here — give it a dated SCHEDULED_CHECKPOINTS entry to re-run once OOS n accrues instead
// of either nagging daily or being forgotten.
const WINDOW_RECOMMEND_N = 200;
// WINDOW_SEARCH_EXHAUSTED also lives in api/lib/model-holds.js now (imported above).
function _doThisCandidates(d) {
  const out = [];
  // 1 — data health, but ONLY when actionable. `dataHealth.actionable` (server) is true only for
  // partial resolution (re-runnable). Coverage under-log + CLV dips are about a now-closed yesterday
  // and unrecoverable — they stay in the ⚠ caution strip (DataHealth) but must NOT claim the day's
  // primary to-do (else the banner nags "Fix data health" for something with no fix). On a quiet
  // healthy day this falls through to the real next action.
  const warns = d?.dataHealth?.warnings || [];
  if (warns.length && d?.dataHealth?.actionable) {
    out.push({ tier:1, tone:"red", label:"Fix data health", why: warns.join(" · "), short:"Fix data health" });
  }
  // 2 — betting changes pending on the betting board (promote / demote / investigate).
  // "Look deeper" is the Phase-2 residual-slicer nag (eligible-but-window-loses). It's only
  // actionable once a coherent price window has been DISCOVERED to slice against — with
  // discoveredWindow=null the category is still accruing (the wider [55,97] capture data
  // hasn't filled the band yet), so an immediate slice has nothing to bite on and the to-do
  // is unfixable today. Hold it out of the daily banner until a window exists (the board row +
  // its "Look deeper" verdict still show). Promote/Pull are live gate changes — never window-gated.
  const changes = (d?.bettingBoard || []).filter(e =>
    _BET_ACTIONS[e?.doThis?.action] &&
    !(e.doThis.action === "Look deeper" && e.discoveredWindow == null));
  if (changes.length) {
    const byAction = {};
    for (const e of changes) (byAction[e.doThis.action] ||= []).push(`${e.sport} ${e.category}`);
    const parts = Object.entries(byAction).map(([a, names]) => `${_BET_ACTIONS[a].verb} ${names.join(", ")}`);
    const lead = changes[0];
    out.push({ tier:2, tone:_BET_ACTIONS[lead.doThis.action].tone,
      label: parts.join("; "),
      why: lead.doThis.why || "betting change pending on the board",
      short:`${changes.length} betting change${changes.length>1?"s":""}` });
  }
  // 2.2 — model ACCURACY changes: proven-miscalibrated categories. The fix forks on Brier skill
  // (set server-side in honest.action): "Recalibrate" (model beats the price → L2 de-shrink, NOT a
  // new input) vs "Improve inputs" (market out-predicts → L0 new input, run tune:residual). Below a
  // live gate change, above ripe-validate. INPUT_SEARCH_EXHAUSTED suppresses ONLY the new-input nag
  // (a dead-end L0 search); a Recalibrate task is suppressed only while UN-RIPE — below RECAL_MIN_N
  // (n<200) or its Brier-skill trend is still MOVING (reliable |skillTrend| > _LEARN_FLAT, rising OR
  // falling) — since its de-shrink step isn't settled yet.
  const accChanges = (d?.accuracyBoard || []).filter(e =>
    _ACC_ACTIONS[e?.honest?.action] &&
    // Both the L0-input nag ("Improve inputs") and the MARKET_SHARPER one-time diagnostic
    // ("Diagnose then stop") point at tune:residual; suppress either once the L0 search is exhausted
    // — until a FORMULA_CUTOFF newer than the exhaustion date re-accrues the category clean.
    !((e.honest.action === "Improve inputs" || e.honest.action === "Diagnose then stop")
        && _stillExhausted(INPUT_SEARCH_EXHAUSTED, e.key || `${e.sport}|${e.category}`, e.formulaCutoff)) &&
    !(e.honest.action === "Recalibrate" && (
      (e.n || 0) < RECAL_MIN_N ||
      (e.learning?.reliable && Math.abs(e.learning.skillTrend) > _LEARN_FLAT))));
  if (accChanges.length) {
    const byAction = {};
    for (const e of accChanges) (byAction[e.honest.action] ||= []).push(`${e.sport} ${e.category}`);
    const parts = Object.entries(byAction).map(([a, names]) =>
      `${_ACC_ACTIONS[a].verb} ${names.slice(0,3).join(", ")}${names.length>3?` +${names.length-3}`:""}`);
    const lead = accChanges[0]; // accuracyBoard is skill-desc, so the sharpest miss leads
    out.push({ tier:2.2, tone:_ACC_ACTIONS[lead.honest.action].tone,
      label: parts.join("; "),
      why: lead.honest?.why || "model calibration needs attention — see the accuracy board",
      short: `Accuracy ${accChanges.length}` });
  }
  // 2.5 — validate ripe shadow models: ungated categories with enough settled bets (n≥50) that are
  // trending positive but not yet gate-clean (verdict STRENGTHENING) — go run the manual tune:gate
  // + ?brier=1 to decide on gating. This is the build→gate half of the funnel: upstream of building
  // a NEW market, downstream of an actual board change (a clean PROMOTE already surfaces in tier 2).
  // `eligible` is required: the two-board hard gate refuses an ineligible category no matter what
  // tune:gate says, so nagging a validation run for one is wasted work — it stays a board row only.
  const ripe = (d?.bettingBoard || []).filter(e =>
    !e.gated && e.eligible === true && e.verdict === "STRENGTHENING" && e.checklist?.nOk && !_BET_ACTIONS[e?.doThis?.action]);
  if (ripe.length) {
    const names = ripe.map(e => `${e.sport}|${e.category}`);
    out.push({ tier:2.5, tone:"blue",
      label: `Validate ${names.slice(0,3).join(", ")}${names.length>3?` +${names.length-3}`:""}`,
      why: "n≥50 and trending +ROI but not yet gate-clean — run tune:gate + ?brier=1 to decide on gating",
      short: `Validate ${ripe.length}` });
  }
  // 3 / 3.2 — build the next market on the roadmap (lowest rank wins; for the infra row, name its
  // NEXT item). Skip an infra/shipped row whose work is all done or data-gated (no NEXT badge) so the
  // quiet-day action falls through to the next thing actually buildable now. Priority forks on the
  // NEXT badge: an explicitly-flagged NEXT build is tier 3 (above the tier-3.15 window harvest — a
  // deliberate "this first" override), but a merely-unshipped roadmap entry is tier 3.2 (below it) —
  // harvesting already-accrued data beats authoring a NEW market unless the roadmap says otherwise.
  const next = [...MODEL_NEXT]
    .sort((a,b) => a.rank - b.rank)
    .find(s => (!s.infra && !_isShippedRoadmapEntry(s)) || s.markets?.some(m => m.badge === "NEXT"));
  if (next) {
    const nextItem = next.markets?.find(m => m.badge === "NEXT");
    const label = next.infra && nextItem ? `Build ${nextItem.ticker}` : `Build ${next.sport}`;
    out.push({ tier: nextItem ? 3 : 3.2, tone:"blue", label, why: nextItem?.title || next.note, short: label });
  }
  // 3.15 — derive a per-category bet window: an ungated category has accrued enough settled bets
  // (n≥WINDOW_RECOMMEND_N) AND provably beats the price (eligible = Brier skill CI-lo>0 @ n≥100) AND
  // shows +ROI OUTSIDE the current [67,91] window (over/sub-window) — i.e. its edge may live in a band
  // the global window misses (the mlb|totalBases-above-91¢ case capture de-blinding was built for).
  // Harvest of already-accrued data (near-term ROI, one script + a one-line config edit) → above
  // build/vet/triage of NEW markets, below the roadmap's flagged NEXT build. WINDOW_SEARCH_EXHAUSTED
  // suppresses categories already run to a terminal NO-GO, mirroring INPUT_SEARCH_EXHAUSTED.
  // Gate on the ACCURACY-board n (the Brier population tune:window actually reads), NOT the betting
  // board's own `n` — the latter is the narrow edge≥5 bettable histogram (~10) and would never clear
  // 200, while the tool operates on the full dc-qualified resolved set (~235). Join by key.
  // A key already in CATEGORY_BET_WINDOWS is DONE — its window was derived and applied, and since the
  // board's sub/over-window splits keep measuring against the GLOBAL [67,91] (not the override), the
  // trigger condition would otherwise hold forever. Same self-advancing source-of-truth pattern as
  // tier 3's SERIES_CONFIG shipped-detection: finishing the task silences the nag, no manual list edit.
  const _accN = Object.fromEntries((d?.accuracyBoard || []).map(a => [a.key, a.n || 0]));
  const winnable = (d?.bettingBoard || []).filter(e =>
    !e.gated && e.eligible === true && (_accN[e.key] || 0) >= WINDOW_RECOMMEND_N &&
    ((e.overWindow?.roi > 0) || (e.subWindow?.roi > 0)) &&
    !CATEGORY_BET_WINDOWS[e.key] &&
    !_stillExhausted(WINDOW_SEARCH_EXHAUSTED, e.key, e.formulaCutoff));
  if (winnable.length) {
    const names = winnable.map(e => e.key);
    out.push({ tier:3.15, tone:"green",
      label: `Derive bet window: ${names.slice(0,3).join(", ")}${names.length>3?` +${names.length-3}`:""}`,
      why: `n≥${WINDOW_RECOMMEND_N}, model beats the price, and +ROI sits OUTSIDE [67,91] — run \`npm run tune:window -- --category ${names[0]}\` to derive + OOS/Brier-validate a window, then set CATEGORY_BET_WINDOWS.`,
      short: `Derive window ${winnable.length}` });
  }
  // 3.25 — vet shortlisted markets (promoted detections, mid-funnel). Below build-next (a vetted
  // roadmap market is further along), above triage (raw detections). Confirm data on both ends +
  // the first knob, then author the roadmap entry. Drop any ticker already live in SERIES_CONFIG
  // (shipped) — same filter the ModelNext "Shortlisted" card uses (line ~350) — so the banner
  // self-advances the instant a market ships, without waiting for the scan's adopt reconcile + the
  // next report regen to flip its DB status.
  const shortlisted = (d?.shortlistedMarkets || []).filter(m => !SERIES_CONFIG[m.ticker]);
  if (shortlisted.length) {
    const titles = shortlisted.slice(0, 3).map(m => m.title || m.sampleSubtitle || m.ticker).join(", ");
    out.push({ tier:3.25, tone:"blue",
      label: `Vet ${shortlisted.length} shortlisted market${shortlisted.length > 1 ? "s" : ""}`,
      why: `${titles}${shortlisted.length > 3 ? " …" : ""} — confirm data on both ends + the first knob, then author the roadmap entry`,
      short: `Vet ${shortlisted.length} shortlisted` });
  }
  // 3.5 — triage detected new markets (kalshi-series-scan → `newMarkets`, already in the payload;
  // the funnel's first step). Below "build next" (a vetted roadmap market outranks raw detections)
  // but above the Polymarket floor, so an un-triaged queue becomes the quiet-day prompt instead of
  // jumping straight to platform expansion.
  const nm = (d?.newMarkets || []).filter(m => !SERIES_CONFIG[m.ticker]);
  if (nm.length) {
    const titles = nm.slice(0, 3).map(m => m.title || m.sampleSubtitle || m.ticker).join(", ");
    out.push({ tier:3.5, tone:"blue",
      label: `Triage ${nm.length} detected market${nm.length > 1 ? "s" : ""}`,
      why: `${titles}${nm.length > 3 ? " …" : ""} — dismiss noise, promote real candidates`,
      short: `Triage ${nm.length} detected` });
  }
  // 3.6 — sportsbook cross-venue kill-gate: a CONFIRMED systematic Kalshi-lags-the-book gap is an
  // actionable build (the Phase-1b correction-latency logger). Live verdict from the report's
  // sportsbookValidation (in-window bettable band). Only GAP is actionable here; TIGHT/ACCRUING sit
  // at the floor below so the banner still reflects the accruing observatory on a quiet day.
  const sbv = d?.sportsbookValidation;
  if (sbv?.verdict === "GAP") {
    out.push({ tier:3.6, tone:"green",
      label:"Build sportsbook correction-latency logger",
      why:`Kalshi is cheap vs the sharp book ≥3¢ on ${Math.round((sbv.fracBuyEdge3||0)*100)}% of traded sides (n=${sbv.n}/${sbv.days}d) — persistent buy edges. Build the intraday delta logger to measure how long they last before correcting (Phase 1b).`,
      short:"Sportsbook gap → build logger" });
  }
  // 4 — scheduled checkpoints (dated follow-ups; primary only when nothing above is actionable).
  // Each SCHEDULED_CHECKPOINTS entry stays quiet until its date, then surfaces daily until its
  // entry is removed/re-dated — so a "come back in two weeks" wait neither nags early nor gets
  // forgotten. Multiple due checkpoints surface oldest-first.
  const todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  for (const cp of [...SCHEDULED_CHECKPOINTS].sort((a, b) => a.date.localeCompare(b.date))) {
    if (todayPT < cp.date) continue;
    out.push({ tier:4, tone: cp.tone || "gray", label: cp.label,
      why: `${cp.why} (checkpoint due ${cp.date} — remove or re-date its SCHEDULED_CHECKPOINTS entry once handled)`,
      short: cp.short || cp.label });
  }
  // 4.6 — sportsbook cross-venue floor (below Polymarket, above the quiet-day floor): when nothing
  // above is actionable, surface the LIVE kill-gate status so the banner reflects the accruing
  // observatory instead of a blank "all clear". TIGHT = the likely no-edge outcome → redirect cue.
  if (sbv && (sbv.verdict === "ACCRUING" || sbv.verdict === "TIGHT")) {
    if (sbv.verdict === "ACCRUING") {
      out.push({ tier:4.6, tone:"gray", label:"Sportsbook divergence accruing",
        why:`Cross-venue observatory live — Kalshi-vs-sharp-book ML deltas logging (n=${sbv.n}/${sbv.days}d in-window${sbv.medianAbs!=null?`, median ${sbv.medianAbs}¢`:""}). Re-read /api/sportsbook-deltas once n≥30 over ≥3 days to call the kill-gate.`,
        short:"Sportsbook accruing" });
    } else {
      out.push({ tier:4.6, tone:"gray", label:"Sportsbook: Kalshi tracks the book",
        why:`Cross-venue kill-gate read: only ${Math.round((sbv.fracBuyEdge3||0)*100)}% of traded sides are ≥3¢ cheap vs the sharp book (median |Δ| ${sbv.medianAbs}¢, n=${sbv.n}/${sbv.days}d) — no systematic liquid-ML lag edge. Spend effort on thin/new markets + the totalBases conversion, not liquid timing.`,
        short:"Sportsbook tracks tight" });
    }
  }
  // 5 — quiet-day floor: nothing above is actionable and no checkpoint is due yet. Show a calm
  // "caught up" state naming the NEXT upcoming checkpoint instead of an empty/absent banner.
  if (!out.length) {
    const upcoming = [...SCHEDULED_CHECKPOINTS].filter(c => c.date > todayPT).sort((a, b) => a.date.localeCompare(b.date))[0];
    out.push({ tier:5, tone:"gray", label:"Nothing to act on today",
      why:`Gate empty, models accruing, no new markets to triage.${upcoming ? ` Next scheduled checkpoint: ${upcoming.short || upcoming.label} ~${upcoming.date}.` : ""}`, short:"All clear" });
  }
  // Push order ≠ priority order anymore (tier 3.2 is pushed before 3.15) — sort by tier; ties keep
  // insertion order (stable sort), so multiple due checkpoints stay oldest-first.
  return out.sort((a, b) => a.tier - b.tier);
}
// Cross-venue kill-gate readout — the live sportsbook-reference validation (does Kalshi lag the
// de-vigged sharp book?). Mirrors the report's sportsbookValidation verdict; null until the feed
// is activated (THE_ODDS_API_KEY) + the table has rows.
function CrossVenueValidation({ sbv }) {
  if (!sbv) return null;
  const map = {
    GAP:      ["Kalshi LAGS the sharp book → build the correction-latency logger", C.green],
    TIGHT:    ["Kalshi tracks the sharp book — no liquid lag edge", C.gray],
    ACCRUING: ["accruing — not enough to call the kill-gate yet", C.dim],
  };
  const [label, color] = map[sbv.verdict] || [sbv.verdict, C.dim];
  return (
    <div style={{ marginTop:10, fontSize:11 }}>
      <span style={{ color:C.dim, fontWeight:700, fontSize:9, letterSpacing:0.4 }}>CROSS-VENUE · SPORTSBOOK REFERENCE </span>
      <span style={{ color, fontWeight:600 }}>{label}</span>
      <span style={{ color:C.gray }}>
        {" · "}n={sbv.n}/{sbv.days}d
        {sbv.medianAbs!=null ? ` · median |Δ| ${sbv.medianAbs}¢` : ""}
        {sbv.fracBuyEdge3!=null ? ` · ${Math.round(sbv.fracBuyEdge3*100)}% of sides ≥3¢ cheap vs book` : ""}
      </span>
    </div>
  );
}
function DoThisBanner({ d }) {
  const [copied, setCopied] = React.useState(false);
  if (!d || d.notYet || d.error) return null;
  const cands = _doThisCandidates(d);
  if (!cands.length) return null;
  const [primary, ...rest] = cands;
  const color = _TONE[primary.tone] || C.blue;
  // Plain-text digest for pasting straight into a chat session as the next prompt.
  const copyText = [
    `Do this today: ${primary.label}`,
    primary.why,
    rest.length ? `Then: ${rest.map(r => r.short).join(" · ")}` : null,
  ].filter(Boolean).join("\n");
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked (insecure context / denied) — no-op */ }
  };
  return (
    <div style={{ background:`${color}14`, border:`1px solid ${color}66`, borderRadius:8, padding:"10px 14px", marginBottom:14 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:5 }}>
        <span style={{ color:C.gray, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:0.5 }}>Do this today</span>
        <button onClick={onCopy} title={copied ? "Copied" : "Copy as next-prompt input"} aria-label="Copy as next-prompt input" style={{
          cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
          color: copied ? C.green : color, background:"transparent",
          border:`1px solid ${copied ? C.green : color}66`, borderRadius:4, padding:"3px",
        }}>
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          )}
        </button>
      </div>
      <div style={{ color, fontSize:15, fontWeight:700 }}>▶ {primary.label}</div>
      {primary.why && <div style={{ color:C.text, fontSize:12, marginTop:3, lineHeight:1.4 }}>{primary.why}</div>}
    </div>
  );
}

// ---- DAILY BRIEF: server-generated prose summary of model state + pricing findings ----
// Deterministic sentences templated server-side from the same numbers the boards render (see
// _buildDailyBrief in api/lib/handlers/shadow.js) — the readable replacement for scanning the
// accuracy grid. `changes` is null when yesterday's report wasn't in KV (first run / late regen).
function DailyBrief({ brief }) {
  if (!brief) return null;
  const Block = ({ title, items }) => !items?.length ? null : (
    <div style={{ marginTop:8 }}>
      <div style={{ color:C.dim, fontSize:9, fontWeight:700, letterSpacing:0.4, textTransform:"uppercase", marginBottom:2 }}>{title}</div>
      {items.map((s, i) => <div key={i} style={{ color:C.text, fontSize:12, lineHeight:1.55 }}>• {s}</div>)}
    </div>
  );
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 14px", marginBottom:10 }}>
      <div style={{ color:C.text, fontSize:13, fontWeight:600, lineHeight:1.5 }}>{brief.headline}</div>
      <Block title="Model state" items={brief.model} />
      <Block title="Pricing · cross-venue" items={brief.pricing} />
      <Block title="Changed since yesterday" items={brief.changes} />
    </div>
  );
}

function MorningBriefing({ shadowReportData, shadowReportLoading, fetchShadowReport, isLoggedIn }) {
  // Accuracy grid is drill-down now (calibration bands for tune:residual work) — collapsed by
  // default behind a toggle whenever the brief exists. Hook must sit above the early returns.
  const [showAccuracy, setShowAccuracy] = React.useState(false);
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
      <DataHealth dh={d.dataHealth} />

      <DoThisBanner d={d} />

      {d.brief ? (
        <>
          <div style={sectionHead}>Daily brief · model state + pricing findings</div>
          <DailyBrief brief={d.brief} />
          <div onClick={() => setShowAccuracy(v => !v)}
               style={{ color:C.dim, fontSize:11, cursor:"pointer", margin:"0 0 10px", userSelect:"none" }}>
            {showAccuracy ? "▾" : "▸"} Accuracy board — full grid (calibration bands, Brier detail)
          </div>
          {showAccuracy && <AccuracyBoard board={d.accuracyBoard} />}
        </>
      ) : (
        // Stale report without `brief` (pre-deploy KV) — fall back to the full grid until regen.
        <>
          <div style={sectionHead}>Model accuracy · do the models beat the price?</div>
          <AccuracyBoard board={d.accuracyBoard} />
        </>
      )}

      <div style={sectionHead}>Betting board · what to bet</div>
      <GateDigest board={d.bettingBoard} />
      <BettingBoard board={d.bettingBoard} />

      {/* Raw cross-venue readout only when the brief (which covers both venues) is absent. */}
      {!d.brief && <CrossVenueValidation sbv={d.sportsbookValidation} />}
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
        <div style={{ color:C.text, fontSize:17, fontWeight:700 }}>Model Report</div>
        {shadowReportData?.reportDate && <span style={{ color:C.dim, fontSize:11 }}>{shadowReportData.reportDate}</span>}
        {shadowReportData?.generatedAt && <span style={{ color:C.dim, fontSize:10 }}>· generated {new Date(shadowReportData.generatedAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"})} PT</span>}
        {isLoggedIn && shadowReportData && !shadowReportData.notYet && !shadowReportData.error && (
          <button onClick={() => fetchShadowReport(true)} style={{ marginLeft:"auto", background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:10, padding:"2px 8px", cursor:"pointer" }}>↻ Refresh</button>
        )}
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
