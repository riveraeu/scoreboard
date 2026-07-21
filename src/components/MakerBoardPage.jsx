import React from 'react';
import { WORKER } from '../lib/constants.js';
import { SCHEDULED_CHECKPOINTS } from '../lib/scheduledCheckpoints.js';

// New primary landing page (2026-07-21) — promoted from ReportPage.jsx's MakerProgress module
// when taker picks (LineupsPage) were demoted to a secondary /picks route. See
// project_taker_ui_demotion_2026_07_21 memory for the reasoning (category gate empty since
// 7/18, taker edge structurally negative venue-wide per the 7/19 pooled calibration scan, while
// maker V2 has a concrete verified result in the 80-84 band with real capital now armed).
//
// C/sectionHead are duplicated from ReportPage.jsx rather than imported — this page is meant to
// load eagerly (it's the new default view) while ReportPage.jsx stays React.lazy, so importing
// from it would pull its whole bundle into the eager path.
const C = { green:"#3fb950", amber:"#e3b341", red:"#f78166", blue:"#58a6ff", gray:"#8b949e", dim:"#484f58", text:"#c9d1d9", bg:"#0d1117", card:"#161b22", border:"#21262d" };
const sectionHead = { color:C.blue, fontSize:11, fontWeight:700, margin:"14px 0 8px", borderTop:`1px solid ${C.border}`, paddingTop:12, textTransform:"uppercase", letterSpacing:0.4 };

// ---- STAT TILE -------------------------------------------------------------------
function Tile({ label, value, color, sub }) {
  return (
    <div style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px", minWidth:0 }}>
      <div style={{ color, fontSize:22, fontWeight:700, lineHeight:1, fontVariantNumeric:"tabular-nums" }}>{value}</div>
      <div style={{ color:C.dim, fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4, marginTop:3 }}>{label}</div>
      {sub && <div style={{ color:C.dim, fontSize:9, marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{sub}</div>}
    </div>
  );
}

// ---- MAKER PROGRESS: the shadow (V1) strategy progress module (2026-07-19) ------------------
// Replaces the legacy accuracy/betting board table. The strategy question changed from
// "which model beats the market?" (answered 7/19: none — taker edge is structurally
// negative venue-wide) to "is the maker margin surviving adverse selection, and how close
// are we to arming?" Forms follow the data's job: arm progress = stat tile + meter;
// margin trajectory = single-hue cumulative line; band economics = single-hue bar ladder.
// Color doctrine: NO categorical series palette — one hue (C.blue) for magnitude marks;
// green/red appear only on SIGNED values (the +/− prefix is the non-color channel).
function ArmTile({ mb }) {
  const f = mb?.fills || {};
  const min = mb?.armCriterion?.minFills ?? 200;
  const graded = f.graded || 0;
  const pct = Math.min(100, graded / min * 100);
  const [color, phase] = graded < 10 || f.pnlLoCI == null ? [C.dim, "accruing"]
    : f.pnlLoCI > 0 ? [C.green, "on track"]
    : (f.avgPnlCents ?? 0) > 0 ? [C.amber, "CI straddles 0"]
    : [C.red, "negative"];
  const armed = graded >= min && (f.pnlLoCI ?? -1) > 0;
  return (
    <div style={{ flex:"1.6 1 0", background:C.card, border:`1px solid ${armed ? C.green : C.border}`, borderRadius:6, padding:"8px 10px", minWidth:150 }}>
      <div style={{ color, fontSize:22, fontWeight:700, lineHeight:1, fontVariantNumeric:"tabular-nums" }}>
        {f.avgPnlCents != null ? `${f.avgPnlCents > 0 ? "+" : ""}${f.avgPnlCents}¢` : "—"}
        <span style={{ fontSize:11, fontWeight:400, color:C.gray, marginLeft:6 }}>
          {f.avgPnlCents != null
            ? `/contract${f.pnlLoCI != null ? ` · CI-lo ${f.pnlLoCI > 0 ? "+" : ""}${f.pnlLoCI}` : ""}`
            : "awaiting first graded fills"}
        </span>
      </div>
      <div style={{ color: armed ? C.green : C.dim, fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4, margin:"4px 0 5px" }}>
        {armed ? "ARM CRITERION MET (V1 aggregate)" : `maker pnl · ${phase} · ${graded}/${min} graded fills`}
      </div>
      <div style={{ height:4, background:C.border, borderRadius:2, overflow:"hidden" }} title={`${graded}/${min} graded fills toward the arm decision`}>
        <div style={{ width:`${pct}%`, height:"100%", background:color }} />
      </div>
    </div>
  );
}

// Cumulative graded paper PnL by day. Single series → one hue, no legend; the section
// title names it. Zero baseline; per-point tooltip; the current value is the one direct label.
function EquityCurve({ daily }) {
  const pts = [];
  let cum = 0;
  for (const d of daily || []) {
    if (!(d.graded > 0) && !pts.length) continue; // skip leading no-fill days
    cum += d.pnlTotal || 0;
    pts.push({ day: d.day, cum: parseFloat(cum.toFixed(1)) });
  }
  if (pts.length < 2) {
    return <div style={{ color:C.dim, fontSize:10, padding:"10px 0" }}>
      Paper equity curve appears once graded fills span two days{pts.length === 1 ? ` — day 1: ${pts[0].cum > 0 ? "+" : ""}${pts[0].cum}¢` : ""}.
    </div>;
  }
  const W = 560, H = 90, P = 8;
  const xs = i => P + i * (W - 2 * P) / (pts.length - 1);
  const vals = pts.map(p => p.cum);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const ys = v => hi === lo ? H / 2 : P + (hi - v) * (H - 2 * P) / (hi - lo);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.cum).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", maxWidth:560, display:"block" }} role="img" aria-label="Cumulative paper maker PnL by day">
      <line x1={P} x2={W - P} y1={ys(0)} y2={ys(0)} stroke={C.border} strokeWidth="1" />
      <path d={path} fill="none" stroke={C.blue} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={p.day} cx={xs(i)} cy={ys(p.cum)} r="3.5" fill={C.blue} stroke={C.bg} strokeWidth="2">
          <title>{`${p.day}: ${p.cum > 0 ? "+" : ""}${p.cum}¢ cumulative`}</title>
        </circle>
      ))}
      <text x={Math.min(xs(pts.length - 1), W - P - 4)} y={Math.max(12, ys(last.cum) - 8)}
        textAnchor="end" fill={C.text} fontSize="11" fontWeight="700">
        {last.cum > 0 ? "+" : ""}{last.cum}¢
      </text>
    </svg>
  );
}

// Per-ask-band ladder: bar length = fills (magnitude, single hue); margin is a signed,
// colored figure per row (small fixed row count → direct labels are correct here).
function BandLadder({ bands }) {
  const bs = (bands || []).filter(b => b.segments || b.fills);
  if (!bs.length) return <div style={{ color:C.dim, fontSize:10, padding:"6px 0" }}>Band economics appear with the first quotes.</div>;
  const max = Math.max(1, ...bs.map(b => b.fills));
  return (
    <div style={{ marginTop:4, maxWidth:560 }}>
      {bs.map(b => (
        <div key={b.band} style={{ display:"flex", alignItems:"center", gap:8, margin:"3px 0", fontSize:10 }}
          title={`${b.band}¢ ask band: ${b.segments} quote segments, ${b.fills} fills (${b.graded} graded)${b.avgPnl != null ? `, ${b.avgPnl > 0 ? "+" : ""}${b.avgPnl}¢/contract` : ""}`}>
          <span style={{ color:C.gray, width:42, fontVariantNumeric:"tabular-nums" }}>{b.band}¢</span>
          {/* Empty track must be quieter than a real bar — hairline outline until fills exist,
              so a zero-fill band can never be misread as a full one. */}
          <div style={{ flex:1, height:10, background: b.fills ? C.card : "transparent",
            border:`1px solid ${C.border}`, borderRadius:3, overflow:"hidden", boxSizing:"border-box" }}>
            <div style={{ width:`${Math.max(b.fills / max * 100, b.fills ? 3 : 0)}%`, height:"100%", background:C.blue, borderRadius:2 }} />
          </div>
          <span style={{ color:C.dim, width:118, whiteSpace:"nowrap" }}>{b.segments} quotes · {b.fills} fills</span>
          <span style={{ width:66, textAlign:"right", fontWeight:700, fontVariantNumeric:"tabular-nums",
            color: b.avgPnl == null ? C.dim : b.avgPnl > 0 ? C.green : C.red }}>
            {b.avgPnl != null ? `${b.avgPnl > 0 ? "+" : ""}${b.avgPnl}¢/ct` : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function MakerProgress({ mb }) {
  const todayPT = new Date().toLocaleDateString("en-CA", { timeZone:"America/Los_Angeles" });
  const nextCp = [...SCHEDULED_CHECKPOINTS].filter(c => c.date > todayPT).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!mb) {
    return <div style={{ color:C.dim, fontSize:11, padding:8 }}>Maker board not in this report yet — Refresh regenerates it.</div>;
  }
  const f = mb.fills || {}, q = mb.quotes || {}, qo = mb.quotedOutcomes || {};
  const fillRate = q.segments ? Math.round((f.n || 0) / q.segments * 1000) / 10 : null;
  const advSel = f.sideWonRate != null && qo.sideWonRate != null
    ? Math.round((f.sideWonRate - qo.sideWonRate) * 1000) / 10 : null;
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ ...sectionHead, borderTop:"none", paddingTop:0, marginTop:8 }}>Shadow maker V1 · simulated favorite-ask quoting</div>
      <div style={{ display:"flex", gap:8, marginBottom:10, flexWrap:"wrap" }}>
        <ArmTile mb={mb} />
        <Tile label="fill rate" value={fillRate != null ? `${fillRate}%` : "—"} color={C.text}
          sub={`${f.n ?? 0} fills / ${q.segments ?? 0} quotes · ${q.tickers ?? 0} mkts · avg ask ${q.avgAsk ?? "—"}¢`} />
        <Tile label="adverse selection" value={advSel != null ? `${advSel > 0 ? "+" : ""}${advSel}pp` : "—"}
          color={advSel == null ? C.dim : advSel >= 5 ? C.red : C.green} sub="filled vs quoted side-won" />
        <Tile label="next clock" value={nextCp ? new Date(nextCp.date + "T12:00:00").toLocaleDateString("en-US", { month:"short", day:"numeric" }) : "none"}
          color={C.dim} sub={nextCp?.short} />
      </div>
      <div style={{ color:C.dim, fontSize:9, fontWeight:700, margin:"6px 0 2px" }}>PAPER EQUITY · CUMULATIVE GRADED PNL</div>
      <EquityCurve daily={mb.daily} />
      <div style={{ color:C.dim, fontSize:9, fontWeight:700, margin:"10px 0 2px" }}>BAND LADDER · WHERE FILLS + MARGIN CONCENTRATE (V2 TARGETING)</div>
      <BandLadder bands={mb.bands} />
    </div>
  );
}

// ---- MAKER LIVE ORDERS: V2 real-order monitoring (2026-07-21) ----------------------
// A monitoring table, not a picks list — each row is something the automated engine already
// did, not a decision for the user to make. Resting orders sort first (most actionable to
// glance at), then recent executed/graded, then canceled/expired. Status badge color: resting
// = blue (in progress), executed = signed by sideWon once graded (green=lost/we keep premium,
// red=won/we pay out — see maker-live.js's PnL formula), canceled/expired = dim (inert).
function statusColor(o) {
  if (o.status === "resting") return C.blue;
  if (o.status === "executed") {
    if (o.gradedAt == null) return C.gray; // filled, not yet resolved
    return o.sideWon ? C.red : C.green; // sold side WON = we pay out (red); LOST = we keep premium (green)
  }
  return C.dim; // canceled / expired
}

function MakerLiveOrders({ orders }) {
  if (!orders?.length) {
    return <div style={{ color:C.dim, fontSize:10, padding:"6px 0" }}>No live orders yet — appears once V2 is armed and a quote fills or rests.</div>;
  }
  const shown = orders.slice(0, 100);
  return (
    <div style={{ maxWidth:720 }}>
      <div style={{ display:"flex", gap:8, fontSize:9, color:C.dim, fontWeight:700, textTransform:"uppercase", padding:"0 2px", marginBottom:2 }}>
        <span style={{ width:70 }}>Sport</span>
        <span style={{ flex:1 }}>Ticker</span>
        <span style={{ width:36 }}>Side</span>
        <span style={{ width:40, textAlign:"right" }}>Price</span>
        <span style={{ width:32, textAlign:"right" }}>Size</span>
        <span style={{ width:80 }}>Status</span>
        <span style={{ width:56, textAlign:"right" }}>PnL</span>
      </div>
      <div style={{ maxHeight:280, overflowY:"auto" }}>
        {shown.map((o, i) => (
          <div key={`${o.ticker}-${o.placedAt}-${i}`} style={{ display:"flex", gap:8, alignItems:"center", fontSize:10, padding:"3px 2px",
            borderTop:`1px solid ${C.border}` }} title={o.ticker}>
            <span style={{ width:70, color:C.gray, textTransform:"uppercase" }}>{o.sport || "—"}</span>
            <span style={{ flex:1, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {o.category || o.series || o.ticker}
            </span>
            <span style={{ width:36, color:C.gray, textTransform:"uppercase" }}>{o.side}</span>
            <span style={{ width:40, textAlign:"right", color:C.text, fontVariantNumeric:"tabular-nums" }}>{o.price}¢</span>
            <span style={{ width:32, textAlign:"right", color:C.text, fontVariantNumeric:"tabular-nums" }}>{o.size}</span>
            <span style={{ width:80, color:statusColor(o), fontWeight:700, textTransform:"uppercase", fontSize:9 }}>{o.status}</span>
            <span style={{ width:56, textAlign:"right", fontWeight:700, fontVariantNumeric:"tabular-nums",
              color: o.pnlCents == null ? C.dim : o.pnlCents > 0 ? C.green : C.red }}>
              {o.pnlCents != null ? `${o.pnlCents > 0 ? "+" : ""}${o.pnlCents}¢` : "—"}
            </span>
          </div>
        ))}
      </div>
      {orders.length > shown.length && (
        <div style={{ color:C.dim, fontSize:9, marginTop:4 }}>+{orders.length - shown.length} more (today+yesterday)</div>
      )}
    </div>
  );
}

// ---- MAKER UTILIZATION: eligible-vs-resting per sport (2026-07-21) -----------------
// Reuses BandLadder's bar-row visual pattern. Surfaces cap pressure — e.g. 73 eligible vs a
// 20-slot MAKER_V2_MAX_CONCURRENT cap means most eligible tickers never get a resting order,
// which is useful context for whether the cap should move, not just an FYI.
function MakerUtilization({ eligibleBySport, orders, caps }) {
  const restingBySport = {};
  for (const o of orders || []) {
    if (o.status !== "resting") continue;
    const s = o.sport || "unknown";
    restingBySport[s] = (restingBySport[s] || 0) + 1;
  }
  const sports = Object.keys(eligibleBySport || {}).sort((a, b) => (eligibleBySport[b] || 0) - (eligibleBySport[a] || 0));
  if (!sports.length) {
    return <div style={{ color:C.dim, fontSize:10, padding:"6px 0" }}>No eligible tickers right now.</div>;
  }
  const totalEligible = sports.reduce((s, k) => s + (eligibleBySport[k] || 0), 0);
  const totalResting = Object.values(restingBySport).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...sports.map(s => eligibleBySport[s] || 0));
  return (
    <div style={{ maxWidth:560 }}>
      <div style={{ color:C.dim, fontSize:10, marginBottom:6 }}>
        {totalResting}/{totalEligible} eligible currently resting · cap {caps?.maxConcurrent ?? "—"} concurrent, {caps?.sameGameCap ?? "—"}/game
        {totalEligible > (caps?.maxConcurrent ?? Infinity) && (
          <span style={{ color:C.amber, fontWeight:700 }}> · cap-bound tonight</span>
        )}
      </div>
      {sports.map(s => {
        const eligible = eligibleBySport[s] || 0;
        const resting = restingBySport[s] || 0;
        return (
          <div key={s} style={{ display:"flex", alignItems:"center", gap:8, margin:"3px 0", fontSize:10 }}
            title={`${s}: ${eligible} eligible, ${resting} currently resting`}>
            <span style={{ color:C.gray, width:70, textTransform:"uppercase" }}>{s}</span>
            <div style={{ flex:1, height:10, background:C.card, border:`1px solid ${C.border}`, borderRadius:3, overflow:"hidden", boxSizing:"border-box", position:"relative" }}>
              <div style={{ width:`${eligible / max * 100}%`, height:"100%", background:C.border }} />
              <div style={{ width:`${resting / max * 100}%`, height:"100%", background:C.blue, position:"absolute", top:0, left:0 }} />
            </div>
            <span style={{ color:C.dim, width:100, whiteSpace:"nowrap", textAlign:"right" }}>{resting}/{eligible} resting</span>
          </div>
        );
      })}
    </div>
  );
}

export function useMakerBoardData() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const fetchBoard = React.useCallback(() => {
    setLoading(true);
    return fetch(`${WORKER}/maker-v2-board`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData(prev => prev))
      .finally(() => setLoading(false));
  }, []);
  React.useEffect(() => { fetchBoard(); }, [fetchBoard]);
  return { boardData: data, boardLoading: loading, fetchBoard };
}

// ---- MAKER BOARD PAGE (the new default landing page, 2026-07-21) ------------------
export default function MakerBoardPage({ shadowReportData, shadowReportLoading, fetchShadowReport,
  isLoggedIn, navigateToPicks, navigateToModel }) {
  const { boardData, boardLoading, fetchBoard } = useMakerBoardData();

  React.useEffect(() => {
    if (isLoggedIn && !shadowReportData && !shadowReportLoading) fetchShadowReport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  return (
    <div style={{ maxWidth:1280, margin:"0 auto", padding:"16px 16px" }}>
      <div style={{ display:"flex", alignItems:"center", marginBottom:14, gap:12 }}>
        <h1 style={{ color:"#fff", fontSize:18, fontWeight:700, margin:0, flex:1 }}>Shadow Maker</h1>
        <button onClick={fetchBoard} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"4px 10px", cursor:"pointer" }}>
          {boardLoading ? "Refreshing…" : "Refresh"}
        </button>
        <button onClick={navigateToModel} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"4px 10px", cursor:"pointer" }}>
          Model →
        </button>
        <button onClick={navigateToPicks} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"4px 10px", cursor:"pointer" }}>
          Picks →
        </button>
      </div>

      {!isLoggedIn ? (
        <div style={{ color:C.dim, fontSize:12, padding:12 }}>Log in to see the shadow maker board.</div>
      ) : (
        <>
          {shadowReportLoading && !shadowReportData ? (
            <div style={{ color:C.dim, fontSize:12, padding:12 }}>Generating report…</div>
          ) : (
            <MakerProgress mb={shadowReportData?.makerBoard} />
          )}

          <div style={sectionHead}>Live orders (V2 · real capital) {boardData?.armed
            ? <span style={{ color:C.green }}>· ARMED</span>
            : <span style={{ color:C.dim }}>· disarmed</span>}
          </div>
          <MakerLiveOrders orders={boardData?.orders} />

          <div style={sectionHead}>Utilization by sport</div>
          <MakerUtilization eligibleBySport={boardData?.eligibleBySport} orders={boardData?.orders} caps={boardData?.caps} />
        </>
      )}
    </div>
  );
}
