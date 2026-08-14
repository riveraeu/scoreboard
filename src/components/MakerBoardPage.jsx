import React from 'react';

// Shadow Maker landing page. Rewritten 2026-08-14 at user request ("too long, make it read like the
// CLI daily-report output") — replaces the 2026-08-13 full-mirror rewrite (which rendered every
// report field as its own stat-tile grid + bordered table, including two large category×band grids
// and 50+ row robust-candidate tables). This version renders the SAME report fields, in the SAME
// priority order (project_model_report_workflow), as a terse monospace text digest: a handful of
// summary lines per section, not a dump of every row. Doctrine is preserved, not relaxed — see the
// per-section comments below for which lists may be ranked (robustCandidates arms, the report's own
// polymarketTracking.topDivergences) and which may only report AGGREGATES, never a ranked cell list
// (category economics, in place of the removed heatmap grids — feedback_no_insample_target_picker_ui).
//
// Sections intentionally NOT rendered: makerBoard.fills/live/adverseSelection/crossChecks (the V1/V2
// fill-PnL instruments) — dropped from the daily readout 2026-08-03 (feedback_morning_report_omit_
// maker_instruments): those run continuously but are un-arm-able and produce nothing actionable.

const C = { green:"#3fb950", amber:"#e3b341", red:"#f78166", blue:"#58a6ff", gray:"#8b949e", dim:"#484f58", text:"#c9d1d9", bg:"#0d1117", card:"#161b22", border:"#21262d" };
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
const _PREREG_COLOR = { COLLECTING: C.blue, ON_TRACK: C.green, FAILING: C.amber, PASS: C.green, KILL: C.red };
const _VERDICT_ORDER = ["KILL", "FAILING", "ON_TRACK", "PASS", "COLLECTING"];

const _sign = (v) => (v > 0 ? "+" : "");
const _c = (v, dp = 0) => (v == null ? "—" : `${_sign(v)}${dp ? v.toFixed(dp) : Math.round(v)}¢`);

function _Head({ children }) {
  return <div style={{ color:C.gray, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:0.6, marginTop:16, marginBottom:5 }}>{children}</div>;
}

// One report line — a label + freeform children, dash-prefixed like a CLI bullet. `dim` mutes
// secondary/context lines (e.g. "+12 more") so the eye lands on the headline numbers first.
function _L({ dim, children }) {
  return <div style={{ fontSize:12, lineHeight:1.7, color: dim ? C.gray : C.text }}>{children}</div>;
}

function _more(n) {
  return n > 0 ? <span style={{ color:C.dim }}> · +{n} more</span> : null;
}

// ---- FRESHNESS -----------------------------------------------------------------------------------
function _freshnessLine(df) {
  if (!df) return null;
  const ok = df.makerTableCurrent;
  return (
    <_L key="fresh">
      <span style={{ color: ok ? C.green : C.amber }}>●</span>{" "}
      {ok ? `Maker table current through ${df.expectedThrough}.` : `${df.daysBehind}d behind (expected through ${df.expectedThrough}) — ${df.diagnosis}`}
      <span style={{ color:C.dim }}>
        {" · "}graded {df.latestGradedMakerDay} · fills {df.latestMakerFillDay} · ungraded {df.ungradedFills}
        {df.quotePass != null ? ` · quotePass ${typeof df.quotePass === "object" ? JSON.stringify(df.quotePass) : df.quotePass}` : ""}
      </span>
    </_L>
  );
}

// ---- ROBUST CANDIDATES ----------------------------------------------------------------------------
// report.robustCandidates — cells clearing the structural bar. Ranking WITHIN each arm by magnitude
// is doctrine-approved for this specific field (project_landing_page_full_report_2026_08_13) because
// the bar itself, not the sort, is what qualifies a cell — unlike the raw heatmap below, which must
// never be ranked. Shows only the top 5 per arm; full set is in the raw report.
function RobustCandidates({ data }) {
  if (!data) return null;
  const { bar, eligible, noiseFloor, count, negativeCount, candidates = [], negatives = [], note } = data;
  const pos = [...candidates].sort((a, b) => b.perContract - a.perContract);
  const neg = [...negatives].sort((a, b) => a.perContract - b.perContract);
  const fmt = (r) => `${r.cell} ${_c(r.perContract)} (${r.fills}f/${r.days}d)`;
  return (
    <>
      <_Head>Robust candidates — structural tripwire</_Head>
      <_L>
        <b style={{ color:C.red }}>TRIPWIRE, not a bet list.</b> {note}
      </_L>
      <_L dim>bar: ≥{bar?.minFills}f · ≥{bar?.minDays}d · top-day ≤{Math.round((bar?.maxTopDayShare ?? 0) * 100)}% · {eligible} eligible · noise floor ~{noiseFloor}¢/arm</_L>
      <_L>
        <span style={{ color:C.green }}>{count} positive</span>
        {pos.length > 0 && <>: {pos.slice(0, 5).map(fmt).join(", ")}</>}
        {_more(pos.length - 5)}
      </_L>
      <_L>
        <span style={{ color:C.red }}>{negativeCount} negative</span>
        {neg.length > 0 && <>: {neg.slice(0, 5).map(fmt).join(", ")}</>}
        {_more(neg.length - 5)}
      </_L>
    </>
  );
}

// ---- PREREGISTRATIONS ------------------------------------------------------------------------------
function Preregistrations({ list }) {
  if (!list?.length) return null;
  const cnt = {};
  for (const p of list) cnt[p.verdict] = (cnt[p.verdict] || 0) + 1;
  const sorted = [...list].sort((a, b) => _VERDICT_ORDER.indexOf(a.verdict) - _VERDICT_ORDER.indexOf(b.verdict));
  return (
    <>
      <_Head>Preregistrations — forward tests, criteria fixed before the window opened</_Head>
      <_L dim>
        {list.length} live{" · "}
        {_VERDICT_ORDER.filter(v => cnt[v]).map((v, i, arr) => (
          <span key={v}>
            <span style={{ color:_PREREG_COLOR[v] }}>{cnt[v]} {v.toLowerCase().replace("_", " ")}</span>
            {i < arr.length - 1 ? " · " : ""}
          </span>
        ))}
      </_L>
      {sorted.map(p => (
        <_L key={p.id}>
          <span style={{ color:_PREREG_COLOR[p.verdict] }}>{p.verdict}</span> {p.label}
          <span style={{ color:C.dim }}> — {p.result?.days ?? 0}d/{p.result?.fills ?? 0}f · {p.metCount}/{p.totalCount} checks · checkpoint {p.checkpoint}</span>
        </_L>
      ))}
    </>
  );
}

// ---- DISCOVERY --------------------------------------------------------------------------------------
function Discovery({ discovery }) {
  if (!discovery) return null;
  const k = discovery.counts || {};
  const p = discovery.polymarket?.counts || {};
  const kVet = discovery.toVet || [];
  const pVet = discovery.polymarket?.toVet || [];
  return (
    <>
      <_Head>Discovery — series-vet queue</_Head>
      <_L>
        Kalshi: {k.adopted ?? 0} adopted · {k.shortlisted ?? 0} shortlisted · {k.baseline ?? 0} baseline · {k.new ?? 0} new · {k.dismissed ?? 0} dismissed
        <span style={{ color:C.dim }}> · {discovery.autoDismissedToday ?? 0} auto-dismissed today</span>
      </_L>
      {kVet.length > 0 && (
        <_L dim>to vet ({kVet.length}): {kVet.slice(0, 8).map(r => r.ticker).join(", ")}{_more(kVet.length - 8)}</_L>
      )}
      <_L>
        Polymarket: {p.adopted ?? 0} adopted · {p.baseline ?? 0} baseline · {p.new ?? 0} new · {p.dismissed ?? 0} dismissed
      </_L>
      {pVet.length > 0 && (
        <_L dim>to vet ({pVet.length}): {pVet.slice(0, 8).map(r => r.sport).join(", ")}{_more(pVet.length - 8)}</_L>
      )}
    </>
  );
}

// ---- CROSS-VENUE (Kalshi vs Polymarket) --------------------------------------------------------------
// Merges polymarketTracking (capture/resolution health + its own vig summary) — the vig summary
// already derives from venueVig server-side (both-venue cell counts + topDivergences), so this is the
// one place that data needs to render; a separate venueVig grid would just restate it.
function CrossVenue({ data }) {
  if (!data) return null;
  const { capture, resolution, vig, note } = data;
  const divs = vig?.topDivergences || [];
  return (
    <>
      <_Head>Cross-venue — Kalshi vs Polymarket, capture + divergence monitor</_Head>
      <_L>
        capture {capture?.total ?? 0} rows over {capture?.captureDays ?? 0}d · last {capture?.lastCapture ?? "—"} ({capture?.lastCaptureRows ?? 0} rows)
        <span style={{ color:C.dim }}> · graded {resolution?.graded ?? 0} · pending {resolution?.pending ?? 0} · voided {resolution?.voided ?? 0}</span>
      </_L>
      {capture?.recentBySport?.length > 0 && (
        <_L dim>{capture.recentBySport.map(s => `${s.sport} n=${s.n} graded=${s.graded}`).join(" · ")}</_L>
      )}
      <_L dim>both-venue cells {vig?.bothVenueCells ?? 0} ({vig?.reliableCells ?? 0} reliable) · kalshi rows {vig?.venuesPresent?.kalshi ?? 0} · poly rows {vig?.venuesPresent?.poly ?? 0}</_L>
      {divs.length > 0 && (
        <_L>
          top divergences (monitor only): {divs.slice(0, 5).map(d => `${d.cell} ${_c(d.deltaVig)} (K${_c(d.kalshiVig)}/P${_c(d.polyVig)})`).join(", ")}
        </_L>
      )}
      {note && <_L dim>{note}</_L>}
    </>
  );
}

// ---- CATEGORY ECONOMICS (replaces the removed category×band + venue-vig grids) ------------------------
// AGGREGATES ONLY — no per-cell ranking. This is the one place feedback_no_insample_target_picker_ui
// binds hardest: the old grid's whole design (color = reliability, never sorted) existed because
// listing "top movers" over ~500 noisy cells IS the in-sample target-picker the doctrine forbids.
// Anomaly-flagged cells are the one exception shown by name — that's a structural (wrong-side-fill)
// flag, not a magnitude ranking.
function CategoryEconomics({ cells }) {
  if (!cells?.length) return <><_Head>Category economics</_Head><_L dim>Appears with the first graded fills.</_L></>;
  const total = cells.length;
  const reliable = cells.filter(c => c.reliable);
  const anomalies = cells.filter(c => c.anomaly);
  const totalContracts = cells.reduce((a, c) => a + (c.contracts || 0), 0);
  return (
    <>
      <_Head>Category economics — where PnL sits, not a target list</_Head>
      <_L>
        {total} cells tracked · <span style={{ color: reliable.length ? C.amber : C.dim }}>{reliable.length} clear zero</span> (day-clustered) · {anomalies.length} anomaly-flagged · {totalContracts.toLocaleString()} contracts graded
      </_L>
      <_L dim>
        {reliable.length ? "still selection among many cells — confirm forward before treating any as a target." : "no cell is distinguishable from noise yet."}
      </_L>
      {anomalies.length > 0 && (
        <_L>
          <span style={{ color:C.red }}>anomalies</span>: {anomalies.slice(0, 8).map(c => `${c.sport} ${c.category} ${c.band}${c.anomalyReason ? ` (${c.anomalyReason})` : ""}`).join(", ")}
          {_more(anomalies.length - 8)}
        </_L>
      )}
    </>
  );
}

// ---- FOOTER -----------------------------------------------------------------------------------------
function Footer({ report }) {
  if (!report) return null;
  const ui = report.uiHealth;
  return (
    <div style={{ marginTop:20, paddingTop:10, borderTop:`1px solid ${C.border}`, fontSize:10, color:C.dim, fontFamily:MONO }}>
      report {report.reportDate} · generated {report.generatedAt} · since {report.since}
      {report.durationMs != null && ` · ${(report.durationMs / 1000).toFixed(1)}s`}
      {ui && <span style={{ color: ui.ok && !ui.warnings?.length ? C.dim : C.amber }}> · uiHealth {ui.ok ? "ok" : "warn"}{ui.warnings?.length ? ` · ${ui.warnings.join("; ")}` : ""}</span>}
    </div>
  );
}

// Landing page — a terse text digest of the daily /api/shadow-report run, same priority order the
// report workflow itself uses: robust candidates -> preregistrations -> discovery -> cross-venue ->
// category economics -> report meta. The read-only Kalshi balance + committed-maker-capital chip
// rides in the header when logged in; kalshiBalance/makerCommitted come from /api/kalshi-balance.
export default function MakerBoardPage({ shadowReportData, shadowReportLoading, fetchShadowReport,
  isLoggedIn, kalshiBalance, makerCommitted = 0, onLoginClick, onLogout }) {
  React.useEffect(() => {
    if (isLoggedIn && !shadowReportData && !shadowReportLoading) fetchShadowReport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  const mb = shadowReportData?.makerBoard;
  const _money = (n) => n.toLocaleString("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 });
  return (
    <div style={{ maxWidth:900, margin:"0 auto", padding:"16px 16px" }}>
      <div style={{ display:"flex", alignItems:"center", marginBottom:14, gap:12 }}>
        <h1 style={{ color:"#fff", fontSize:18, fontWeight:700, margin:0, flex:1 }}>Shadow Maker</h1>
        {isLoggedIn && kalshiBalance != null && (
          <div title="Kalshi account balance" style={{ display:"flex", alignItems:"center", gap:4, background:C.bg, border:`1px solid ${C.border}`, borderRadius:4, padding:"4px 8px" }}>
            <span style={{ color:C.dim, fontSize:11 }}>Kalshi</span>
            <span style={{ color:C.text, fontSize:12, fontVariantNumeric:"tabular-nums" }}>${_money(kalshiBalance)}</span>
          </div>
        )}
        {isLoggedIn && makerCommitted > 0 && (
          <div title="Capital committed to resting shadow-maker V2 orders" style={{ display:"flex", alignItems:"center", gap:4, background:C.bg, border:`1px solid ${C.border}`, borderRadius:4, padding:"4px 8px" }}>
            <span style={{ color:C.dim, fontSize:11 }}>Maker</span>
            <span style={{ color:C.text, fontSize:12, fontVariantNumeric:"tabular-nums" }}>${_money(makerCommitted)}</span>
          </div>
        )}
        {isLoggedIn && (
          <button onClick={() => fetchShadowReport(true)} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"4px 10px", cursor:"pointer" }}>
            {shadowReportLoading ? "Refreshing…" : "Refresh"}
          </button>
        )}
        <button onClick={() => (isLoggedIn ? onLogout?.() : onLoginClick?.())} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"4px 10px", cursor:"pointer" }}>
          {isLoggedIn ? "Log out" : "Log in"}
        </button>
      </div>

      {!isLoggedIn ? (
        <div style={{ color:C.dim, fontSize:12, padding:12 }}>Log in to see the shadow maker board.</div>
      ) : shadowReportLoading && !shadowReportData ? (
        <div style={{ color:C.dim, fontSize:12, padding:12 }}>Generating report…</div>
      ) : (
        <div style={{ fontFamily:MONO }}>
          {_freshnessLine(shadowReportData?.dataFreshness)}
          <RobustCandidates data={shadowReportData?.robustCandidates} />
          <Preregistrations list={shadowReportData?.preregistrations} />
          <Discovery discovery={shadowReportData?.discovery} />
          <CrossVenue data={shadowReportData?.polymarketTracking} />
          <CategoryEconomics cells={mb?.categoryBands} />
          <Footer report={shadowReportData} />
        </div>
      )}
    </div>
  );
}
