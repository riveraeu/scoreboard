import React from 'react';

// Shadow Maker landing page. Rewritten 2026-08-13 to surface the FULL /api/shadow-report payload,
// not just the heatmap — every top-level report field now has a home here, in the same priority
// order the daily-report workflow already uses (robust candidates -> preregistrations -> discovery
// -> polymarket coverage parity), plus a data-freshness banner up top and a report-meta/uiHealth
// footer at the bottom. Table/stat-tile visual language borrowed from the published
// "Kalshi Market Coverage" artifact, reworked into this file's existing dark palette (C below) — no
// new theme system, no new files (this component stays self-contained/inline-styled).
//
// Sections intentionally NOT rendered: makerBoard.fills/live/adverseSelection/crossChecks (the V1/V2
// fill-PnL instruments) — dropped from the daily readout 2026-08-03 (feedback_morning_report_omit_
// maker_instruments): those run continuously but are un-arm-able and produce nothing actionable, so
// they're noise here too. robustCandidates IS shown (per explicit request), but framed as a tripwire
// — never a ranked/sorted target list (feedback_no_insample_target_picker_ui).

const C = { green:"#3fb950", amber:"#e3b341", red:"#f78166", blue:"#58a6ff", gray:"#8b949e", dim:"#484f58", text:"#c9d1d9", bg:"#0d1117", card:"#161b22", border:"#21262d" };

// Color doctrine: NO categorical series palette — magnitude via one channel (alpha), green/red only
// on SIGNED values (the +/− prefix is the non-color channel).
function _centsColor(v) { return v == null ? C.dim : v > 0 ? C.green : v < 0 ? C.red : C.gray; }

// Color encodes RELIABILITY, not magnitude. Coloring the biggest mean brightest is best-of-N
// selection with a paint job — it aims the eye at whichever of ~100 noisy cells caught the
// luckiest slate. So a cell whose day-clustered CI straddles zero (i.e. not distinguishable from
// noise — which is currently every cell) is heavily MUTED regardless of how big its number is;
// only a cell whose interval actually clears zero gets saturated. A big number in a pale cell is
// the tell: that is noise, not a target.
function _cellBg(v, scale, reliable) {
  if (v == null) return "transparent";
  const base = Math.min(0.85, 0.12 + Math.abs(v) / scale * 0.6);
  const a = reliable ? base : base * 0.28;   // unreliable → dim, on purpose
  return v > 0 ? `rgba(63,185,80,${a})` : v < 0 ? `rgba(247,129,102,${a})` : C.card;
}

// 5¢ price buckets across the full range. Below 55 populates only once the paper engine quotes the
// underdog side (MAKER_FULL_BAND, 2026-07-29) and those fills grade — so the low columns fill in
// over the following days, not immediately.
const _BANDS = ["0-4", "5-9", "10-14", "15-19", "20-24", "25-29", "30-34", "35-39", "40-44",
  "45-49", "50-54", "55-59", "60-64", "65-69", "70-74", "75-79", "80-84", "85-89", "90-96"];

// ---- PRE-REGISTERED FORWARD TESTS — heatmap cell markers only --------------------------------
// Cells with a pre-registered forward test are underlined in the heatmap below (colored bottom
// inset shadow). Verdict color: blue=collecting, green=on-track/pass, amber=failing, red=kill.
// Criteria were fixed BEFORE the forward window opened — see api/lib/maker-prereg.js + each
// docs/MAKER_*_PREREG.md. Not a bet. Checkpoint = calendar date when terminal verdict fires.
const _PREREG_COLOR = { COLLECTING: C.blue, ON_TRACK: C.green, FAILING: C.amber, PASS: C.green, KILL: C.red };

// ---- shared report-section primitives ---------------------------------------------------------
function _SectionLabel({ children }) {
  return <div style={{ color:C.dim, fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4, marginBottom:6 }}>{children}</div>;
}

function _StatTile({ label, value, color }) {
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:"7px 10px", display:"flex", flexDirection:"column", gap:2, minWidth:88 }}>
      <span style={{ fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace", fontSize:16, fontWeight:600, color: color || C.text, fontVariantNumeric:"tabular-nums" }}>{value ?? "—"}</span>
      <span style={{ fontSize:9, letterSpacing:0.5, textTransform:"uppercase", color:C.dim }}>{label}</span>
    </div>
  );
}

function _StatRow({ children }) {
  return <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:10 }}>{children}</div>;
}

// Generic report-table renderer — used by robustCandidates, discovery (kalshi + poly), and the
// polymarket divergence list, so column shape lives at each call site, not four hand-rolled tables.
function _Table({ columns, rows, keyFn }) {
  if (!rows?.length) return null;
  return (
    <div style={{ overflowX:"auto", border:`1px solid ${C.border}`, borderRadius:6, marginBottom:8 }}>
      <table style={{ borderCollapse:"collapse", width:"100%", fontSize:10 }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} style={{ textAlign: col.align || "left", padding:"6px 8px", color:C.dim, fontWeight:700, fontSize:9, textTransform:"uppercase", letterSpacing:0.4, borderBottom:`1px solid ${C.border}`, background:C.bg, whiteSpace:"nowrap" }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={keyFn ? keyFn(r) : i}>
              {columns.map(col => (
                <td key={col.key} style={{ padding:"6px 8px", borderBottom:`1px solid ${C.border}`, color: col.dim ? C.gray : C.text, textAlign: col.align || "left", whiteSpace:"nowrap", fontVariantNumeric:"tabular-nums" }}>
                  {col.render ? col.render(r) : (r[col.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- DATA FRESHNESS BANNER --------------------------------------------------------------------
// report.dataFreshness — pipeline-currency health (distinct from uiHealth, which is a render
// self-check). Silent-ish when current; surfaces the diagnosis string when the maker table has
// fallen behind (the same symptom class as the 8/12-13 quote-pass deadlock).
function DataFreshnessBanner({ df }) {
  if (!df) return null;
  const ok = df.makerTableCurrent;
  const dot = ok ? C.green : C.amber;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", marginBottom:14, background:C.card, border:`1px solid ${ok ? C.border : C.amber}`, borderRadius:6, fontSize:10, flexWrap:"wrap" }}>
      <span style={{ width:7, height:7, borderRadius:"50%", background:dot, flexShrink:0 }} />
      <span style={{ color:C.text }}>
        {ok
          ? `Maker table current through ${df.expectedThrough}.`
          : `Maker table ${df.daysBehind}d behind (expected through ${df.expectedThrough}) — ${df.diagnosis}`}
      </span>
      <span style={{ marginLeft:"auto", color:C.dim, fontFamily:"ui-monospace,monospace", fontSize:9 }}>
        graded {df.latestGradedMakerDay} · fills {df.latestMakerFillDay} · ungraded {df.ungradedFills} · resolved {df.latestResolvedShadowDay}
        {df.quotePass != null ? ` · quotePass ${typeof df.quotePass === "object" ? JSON.stringify(df.quotePass) : df.quotePass}` : ""}
      </span>
    </div>
  );
}

// ---- ROBUST CANDIDATES TRIPWIRE ----------------------------------------------------------------
// report.robustCandidates — cells clearing the structural bar (fills/days/top-day-share). NEVER a
// ranked target list (feedback_no_insample_target_picker_ui) — a hit is a prompt to pre-register a
// NAMED mechanism + pass the netting screen, nothing here is bettable on its own. Read the ASYMMETRY
// between the positive/negative arms, not the count alone (a price-monotone ladder book lights one
// arm by construction — docs/MAKER_LADDER_ARTIFACT.md).
const _candCols = [
  { key:"cell", label:"Cell" },
  { key:"fills", label:"Fills", align:"right" },
  { key:"days", label:"Days", align:"right" },
  { key:"perContract", label:"¢/ct", align:"right", render: r => `${r.perContract > 0 ? "+" : ""}${r.perContract}` },
  { key:"ci", label:"Day-clustered CI", align:"right", render: r => `${r.ciLo > 0 ? "+" : ""}${r.ciLo}…${r.ciHi > 0 ? "+" : ""}${r.ciHi}` },
  { key:"topDayShare", label:"Top day", align:"right", render: r => `${Math.round((r.topDayShare ?? 0) * 100)}%` },
];

function RobustCandidatesTripwire({ data }) {
  if (!data) return null;
  const { bar, eligible, noiseFloor, count, negativeCount, candidates = [], negatives = [], note } = data;
  const pos = [...candidates].sort((a, b) => b.perContract - a.perContract);
  const neg = [...negatives].sort((a, b) => a.perContract - b.perContract);
  return (
    <div>
      <div style={{ padding:"8px 10px", marginBottom:8, background:C.card, border:`1px solid ${C.red}`, borderRadius:6, fontSize:10, color:C.text, lineHeight:1.5 }}>
        <b style={{ color:C.red }}>TRIPWIRE — not a bet list.</b> {note}
      </div>
      <div style={{ fontSize:9, color:C.dim, marginBottom:8 }}>
        bar: ≥{bar?.minFills} fills · ≥{bar?.minDays}d · top-day share ≤{Math.round((bar?.maxTopDayShare ?? 0) * 100)}% · {eligible} eligible cells · noise floor ~{noiseFloor}¢/arm
      </div>
      <_StatRow>
        <_StatTile label="Positive arm" value={count} color={C.green} />
        <_StatTile label="Negative arm" value={negativeCount} color={C.red} />
      </_StatRow>
      {pos.length > 0 && (
        <>
          <div style={{ fontSize:9, color:C.gray, marginBottom:4 }}>Positive arm ({pos.length})</div>
          <_Table columns={_candCols} rows={pos} keyFn={r => r.cell} />
        </>
      )}
      {neg.length > 0 && (
        <>
          <div style={{ fontSize:9, color:C.gray, marginBottom:4 }}>Negative arm ({neg.length})</div>
          <_Table columns={_candCols} rows={neg} keyFn={r => r.cell} />
        </>
      )}
    </div>
  );
}

// ---- DISCOVERY / MARKET OVERVIEW ---------------------------------------------------------------
// report.discovery — Kalshi series-vet queue + report.discovery.polymarket — per-league Poly vet
// queue. Counts + toVet tables straight from the report; no hand-authored verdicts (the report
// doesn't compute a "build this" call, so this section shows what was screened, not a
// recommendation — see docs/MAKER_LADDER_ARTIFACT.md-adjacent series-vet doctrine: a REAL_BOOK
// screen proves liquidity, never buildability).
const _kalshiVetCols = [
  { key:"ticker", label:"Ticker" },
  { key:"title", label:"What" },
  { key:"markets", label:"Live", align:"right" },
  { key:"realBooks", label:"Real", align:"right" },
  { key:"medianSpreadC", label:"Spread", align:"right", render: r => r.medianSpreadC != null ? `${r.medianSpreadC}¢` : "—" },
  { key:"overround", label:"Overround", align:"right", render: r => r.overround ?? "—" },
  { key:"firstSeen", label:"First seen" },
  { key:"perGame", label:"Type", render: r => (
      <span style={{ fontSize:9, fontWeight:700, letterSpacing:0.4, textTransform:"uppercase", padding:"2px 6px", borderRadius:3, background: r.perGame ? "rgba(88,166,255,0.15)" : "rgba(139,148,158,0.15)", color: r.perGame ? C.blue : C.gray }}>
        {r.perGame ? "per-game" : "futures"}
      </span>
    ) },
];
const _polyVetCols = [
  { key:"sport", label:"League" },
  { key:"marketTypes", label:"Market types", render: r => r.marketTypes || "—" },
  { key:"sampleEvent", label:"Sample event", render: r => r.sampleEvent || "—" },
  { key:"liveEvents", label:"Live", align:"right" },
  { key:"firstSeen", label:"First seen" },
];

function DiscoveryOverview({ discovery }) {
  if (!discovery) return null;
  const k = discovery.counts || {};
  const p = discovery.polymarket?.counts || {};
  return (
    <div>
      <div style={{ fontSize:9, color:C.gray, marginBottom:4 }}>Kalshi ({discovery.venue || "kalshi"})</div>
      <_StatRow>
        <_StatTile label="Adopted" value={k.adopted} color={C.green} />
        <_StatTile label="Shortlisted" value={k.shortlisted} color={C.blue} />
        <_StatTile label="Baseline" value={k.baseline} />
        <_StatTile label="New" value={k.new} color={C.amber} />
        <_StatTile label="Dismissed" value={k.dismissed} color={C.dim} />
        <_StatTile label="Auto-dismissed today" value={discovery.autoDismissedToday} />
      </_StatRow>
      {discovery.toVet?.length > 0 && (
        <>
          <div style={{ fontSize:9, color:C.dim, marginBottom:4 }}>To vet — real books not yet built, screened this pass</div>
          <_Table columns={_kalshiVetCols} rows={discovery.toVet} keyFn={r => r.ticker} />
        </>
      )}
      {discovery.note && <div style={{ fontSize:9, color:C.dim, marginBottom:14, lineHeight:1.5 }}>{discovery.note}</div>}

      <div style={{ fontSize:9, color:C.gray, marginBottom:4 }}>Polymarket</div>
      <_StatRow>
        <_StatTile label="Adopted" value={p.adopted} color={C.green} />
        <_StatTile label="Baseline" value={p.baseline} />
        <_StatTile label="New" value={p.new} color={C.amber} />
        <_StatTile label="Dismissed" value={p.dismissed} color={C.dim} />
      </_StatRow>
      {discovery.polymarket?.toVet?.length > 0 && (
        <>
          <div style={{ fontSize:9, color:C.dim, marginBottom:4 }}>To vet — leagues for cross-venue capture extension</div>
          <_Table columns={_polyVetCols} rows={discovery.polymarket.toVet} keyFn={r => r.sport} />
        </>
      )}
      {discovery.polymarket?.note && <div style={{ fontSize:9, color:C.dim, lineHeight:1.5 }}>{discovery.polymarket.note}</div>}
    </div>
  );
}

// ---- POLYMARKET TRACKING HEALTH ----------------------------------------------------------------
// report.polymarketTracking — capture accrual + resolution health + the cross-venue vig divergence
// summary for the Poly instrument. A data-health + divergence MONITOR (same doctrine as the venue-vig
// heatmap below) — topDivergences is never a bet list.
const _divCols = [
  { key:"cell", label:"Cell" },
  { key:"deltaVig", label:"Δ (K−P)", align:"right", render: r => `${r.deltaVig > 0 ? "+" : ""}${r.deltaVig}` },
  { key:"kalshiVig", label:"Kalshi", align:"right" },
  { key:"polyVig", label:"Poly", align:"right" },
  { key:"reliable", label:"Sample", render: r => r.reliable ? "clears bar" : "thin" },
];

function PolymarketTrackingHealth({ data }) {
  if (!data) return null;
  const { capture, resolution, vig, note } = data;
  return (
    <div>
      <_StatRow>
        <_StatTile label="Captured (total)" value={capture?.total} />
        <_StatTile label="Capture days" value={capture?.captureDays} />
        <_StatTile label="Last capture" value={capture?.lastCapture} />
        <_StatTile label="Last capture rows" value={capture?.lastCaptureRows} color={capture?.lastCaptureRows ? C.green : C.red} />
        <_StatTile label="Graded" value={resolution?.graded} color={C.green} />
        <_StatTile label="Pending" value={resolution?.pending} color={C.amber} />
        <_StatTile label="Voided" value={resolution?.voided} />
      </_StatRow>
      {capture?.recentBySport?.length > 0 && (
        <div style={{ fontSize:9, color:C.dim, marginBottom:10 }}>
          {capture.recentBySport.map(s => `${s.sport} n=${s.n} graded=${s.graded}`).join(" · ")}
        </div>
      )}
      <div style={{ fontSize:9, color:C.dim, marginBottom:8 }}>
        both-venue cells {vig?.bothVenueCells ?? 0} · reliable {vig?.reliableCells ?? 0} · kalshi rows {vig?.venuesPresent?.kalshi ?? 0} · poly rows {vig?.venuesPresent?.poly ?? 0}
      </div>
      {vig?.topDivergences?.length > 0 && (
        <>
          <div style={{ fontSize:9, color:C.gray, marginBottom:4 }}>Top divergences (monitor only)</div>
          <_Table columns={_divCols} rows={vig.topDivergences} keyFn={r => r.cell} />
        </>
      )}
      {note && <div style={{ fontSize:9, color:C.dim, lineHeight:1.5 }}>{note}</div>}
    </div>
  );
}

// ---- CATEGORY × BAND HEATMAP -----------------------------------------------------------------
// Category rows × band columns, cell = ¢/contract (graded). The grain that LOCALISES what band- or
// total-level pooling hides (the 55-64 "edge" that was really one category at an impossible +52¢).
// Two marks a pooled view can't carry: a red ring on an ANOMALY (outcome pinned against the price —
// the wrong-side-fill signature) and an amber dot when >50% of a cell's PnL came from ONE day (the
// selection tell). Rows sorted by volume.
function CategoryBandHeatmap({ cells, maxRows = 40, preregs = [] }) {
  // "sport|category|band" → prereg entry; used to mark cells with a colored bottom underline.
  const preregMap = React.useMemo(() => {
    const m = new Map();
    for (const p of preregs) m.set(`${p.sport}|${p.category}|${p.band}`, p);
    return m;
  }, [preregs]);

  const rows = React.useMemo(() => {
    const cs = cells || [];
    if (!cs.length) return [];
    const byCat = new Map();
    for (const c of cs) {
      const k = `${c.sport}|${c.category}`;
      let row = byCat.get(k);
      if (!row) { row = { key: k, sport: c.sport, category: c.category, label: `${c.sport} ${c.category}`, contracts: 0, pnl: 0, cells: {} }; byCat.set(k, row); }
      row.cells[c.band] = c;
      row.contracts += c.contracts;
      row.pnl += (c.perContract ?? 0) * c.contracts;
    }
    return [...byCat.values()].sort((a, b) => b.contracts - a.contracts);
  }, [cells]);
  if (!rows.length) return <div style={{ color:C.dim, fontSize:10, padding:"6px 0" }}>Category economics appear with the first graded fills.</div>;
  const scale = Math.max(4, ...rows.flatMap(r => Object.values(r.cells).map(c => Math.abs(c.perContract ?? 0))));
  const shown = rows.slice(0, maxRows);
  const colW = 46;
  const total = (cells || []).length;
  const reliableN = (cells || []).filter(c => c.reliable).length;
  return (
    <div style={{ overflowX:"auto" }}>
      {/* Headline that answers "is any single cell bettable?" before the eye starts hunting the
          brightest number. When 0 cells clear zero (the current, honest state), it says so. */}
      <div style={{ fontSize:10, marginBottom:5, color: reliableN ? C.amber : C.dim }}>
        {reliableN
          ? `${reliableN} of ${total} cells clear zero (day-clustered) — still selection among ${total}; confirm forward before treating any as a target.`
          : `0 of ${total} cells clear zero (day-clustered) — no single cell is distinguishable from noise. This view is for spotting anomalies and where PnL sits, not for picking bets.`}
      </div>
      <div style={{ minWidth: 150 + _BANDS.length * colW }}>
        {/* header: band price columns */}
        <div style={{ display:"flex", fontSize:9, color:C.dim, fontWeight:700, marginBottom:2 }}>
          <span style={{ width:150 }} />
          {_BANDS.map(b => <span key={b} style={{ width:colW, textAlign:"center" }}>{b}</span>)}
          <span style={{ width:56, textAlign:"right" }}>¢/ct</span>
        </div>
        {shown.map(r => {
          const rowPer = r.contracts ? r.pnl / r.contracts : null;
          return (
            <div key={r.key} style={{ display:"flex", alignItems:"stretch", marginBottom:2, fontSize:10 }}>
              <span style={{ width:150, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", alignSelf:"center" }}>{r.label}</span>
              {_BANDS.map(b => {
                const preKey = `${r.sport}|${r.category}|${b}`;
                const pre = preregMap.get(preKey);
                const preColor = pre ? (_PREREG_COLOR[pre.verdict] ?? C.blue) : null;
                const preShadow = pre ? `inset 0 -3px 0 ${preColor}` : undefined;
                const c = r.cells[b];
                if (!c) return (
                  <span key={b} style={{ width:colW, height:22, border:`1px solid ${C.border}`, boxSizing:"border-box", marginRight:1,
                    ...(preShadow && { boxShadow: preShadow }) }} />
                );
                const ciTxt = c.ciLo != null ? `${c.ciLo > 0 ? "+" : ""}${c.ciLo}…${c.ciHi > 0 ? "+" : ""}${c.ciHi}` : "n/a";
                // Cells show a ROUNDED integer, not the 2-decimal mean — 479 precise numbers is the
                // wall; full precision + fills/days/one-day%/CI all live in the tooltip. The day-count
                // and one-day dot that used to ride reliable cells were dropped: they were soft
                // target-flags (they only appeared on the cells that clear zero), and this view is an
                // anomaly/PnL-distribution map, not a target picker. Unreliable numbers are pushed
                // further back (opacity) so the grid reads as a quiet field where structure + the
                // anomaly ring are what the eye lands on — not "here is your bet".
                const cellTxt = c.perContract != null ? `${c.perContract > 0 ? "+" : ""}${Math.round(c.perContract)}` : "";
                const preInfo = pre ? ` · ★ pre-reg: ${pre.label} · ${pre.verdict} · checkpoint ${pre.checkpoint}` : "";
                return (
                  <span key={b} title={`${r.label} ${b}¢: ${c.perContract > 0 ? "+" : ""}${c.perContract}¢/ct · ${c.fills} fills · sideWon ${c.sideWon} · ${c.days}d · day-clustered CI ${ciTxt} (${c.reliable ? "clears 0" : "straddles 0 — not distinguishable from noise"}) · top day ${Math.round((c.topDayShare ?? 0) * 100)}% of |PnL|${c.anomaly && c.anomalyReason ? ` · ANOMALY: ${c.anomalyReason}` : ""}${preInfo}`}
                    style={{ position:"relative", width:colW, height:22, marginRight:1, boxSizing:"border-box",
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontVariantNumeric:"tabular-nums", color: c.reliable ? C.text : C.gray,
                      opacity: c.reliable ? 1 : 0.5,
                      background:_cellBg(c.perContract, scale, c.reliable),
                      border: c.anomaly ? `1.5px solid ${C.red}` : `1px solid ${C.border}`,
                      ...(preShadow && { boxShadow: preShadow }) }}>
                    {cellTxt}
                  </span>
                );
              })}
              <span style={{ width:56, textAlign:"right", alignSelf:"center", fontWeight:700, fontVariantNumeric:"tabular-nums", color:_centsColor(rowPer && parseFloat(rowPer.toFixed(2))) }}>
                {rowPer != null ? `${rowPer > 0 ? "+" : ""}${rowPer.toFixed(1)}` : "—"}
              </span>
            </div>
          );
        })}
        <div style={{ color:C.dim, fontSize:9, marginTop:5, lineHeight:1.5 }}>
          ¢/contract (rounded), graded fills · <b>brightness = reliability</b> (day-clustered CI clear of zero), NOT size — a big number in a pale cell is noise · <span style={{ color:C.red }}>▢</span> anomaly: out of ladder order (realized outcome departs from this category’s own price→outcome curve — the wrong-side-fill signature; being extreme is NOT anomalous) · <span style={{ color:C.blue }}>▬</span> underline = pre-registered forward test (blue=collecting, green=on-track, amber=failing, red=kill) · hover any cell for detail
          {rows.length > shown.length ? ` · +${rows.length - shown.length} lower-volume categories hidden` : ""}
        </div>
      </div>
    </div>
  );
}

// ---- CROSS-VENUE VIG (Kalshi vs Polymarket) --------------------------------------------------
// One merged grid over the SAME category × band cells — each populated cell stacks Kalshi vig over
// Poly vig (favorite-ask VIG = avg captured ask − realized win rate, ¢), a quantity computable on
// both venues from capture+resolution alone (reads `venueVig` from the report). NOT the maker-PnL
// grid above; it is a DIVERGENCE MONITOR. The cell COLOR is the Δ (Kalshi − Poly): expected ≈0 (the
// 2026-07-04 Poly kill found ML median |Δ|~0.5¢), so a lit cell is the divergence itself — a prompt
// to pre-register a mechanism, never a bet. Kalshi is live day one off graded shadow_plays; Poly
// rows resolve ~1 day after capture, so the bottom line reads "—" and cells stay uncolored (Δ=null)
// until Poly accrues. `c.reliable` = both venues clear the sample bar → full brightness; else dim.
const _vfmt = v => v == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v)}`;

function VenueVigHeatmap({ venueVig }) {
  const bar = venueVig?.bar || { minN: 50, minDays: 3 };
  const cells = venueVig?.cells || [];
  const rows = React.useMemo(() => {
    const byCat = new Map();
    for (const c of cells) {
      const k = `${c.sport}|${c.category}`;
      let row = byCat.get(k);
      if (!row) { row = { key: k, label: `${c.sport} ${c.category}`, n: 0, cells: {} }; byCat.set(k, row); }
      row.cells[c.band] = c;
      row.n += (c.kalshi?.n || 0) + (c.poly?.n || 0);
    }
    return [...byCat.values()].sort((a, b) => b.n - a.n);
  }, [cells]);

  const polyEmpty = (venueVig?.venuesPresent?.poly || 0) === 0;
  const scale = Math.max(2, ...cells.map(c => Math.abs(c.deltaVig ?? 0)));
  const colW = 46;

  return (
    <div>
      <div style={{ display:"flex", alignItems:"baseline", gap:6, marginBottom:6, fontSize:9, color:C.dim }}>
        <span>each cell — <b style={{ color:C.text }}>K</b> = Kalshi vig ¢ (top), <b style={{ color:C.text }}>P</b> = Poly vig ¢ (bottom); color = Δ (K−P), green = Kalshi richer / Poly cheaper</span>
      </div>
      {!cells.length ? (
        <div style={{ color:C.dim, fontSize:10, padding:"6px 0" }}>Cross-venue vig appears once graded capture rows accrue.</div>
      ) : (
        <div style={{ overflowX:"auto" }}>
          <div style={{ minWidth: 150 + _BANDS.length * colW }}>
            {polyEmpty && (
              <div style={{ color:C.dim, fontSize:9, marginBottom:4 }}>
                Polymarket rows resolve ~1 day after capture — the P line reads “—” and cells stay uncolored until Poly accrues. Kalshi vig is live now.
              </div>
            )}
            <div style={{ display:"flex", fontSize:9, color:C.dim, fontWeight:700, marginBottom:2 }}>
              <span style={{ width:150 }} />
              {_BANDS.map(b => <span key={b} style={{ width:colW, textAlign:"center" }}>{b}</span>)}
            </div>
            {rows.map(r => (
              <div key={r.key} style={{ display:"flex", alignItems:"stretch", marginBottom:2, fontSize:10 }}>
                <span style={{ width:150, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", alignSelf:"center" }}>{r.label}</span>
                {_BANDS.map(b => {
                  const c = r.cells[b];
                  const k = c?.kalshi, p = c?.poly;
                  // A cell is populated once EITHER venue has a vig (Kalshi is day-one).
                  if (!c || (k?.vig == null && p?.vig == null)) return <span key={b} style={{ width:colW, height:30, border:`1px solid ${C.border}`, boxSizing:"border-box", marginRight:1 }} />;
                  const tip = `${r.label} ${b}¢\n` +
                    `Kalshi: ${k?.vig != null ? `vig ${k.vig}¢ (ask ${k.avgAsk} − win ${k.winPct}%) · n=${k.n} · ${k.days}d` : "—"}\n` +
                    `Poly:   ${p?.vig != null ? `vig ${p.vig}¢ (ask ${p.avgAsk} − win ${p.winPct}%) · n=${p.n} · ${p.days}d` : "—"}\n` +
                    `Δ (K−P): ${c.deltaVig != null ? `${c.deltaVig > 0 ? "+" : ""}${c.deltaVig}¢` : "n/a (needs both)"} · ${c.reliable ? "both clear sample bar" : "thin — below bar, greyed"}`;
                  return (
                    <span key={b} title={tip} style={{ width:colW, height:30, marginRight:1, boxSizing:"border-box",
                      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", lineHeight:1.15,
                      fontVariantNumeric:"tabular-nums", opacity: c.reliable ? 1 : 0.5,
                      background:_cellBg(c.deltaVig, scale, c.reliable), border:`1px solid ${C.border}` }}>
                      <span style={{ fontSize:9, color: k?.vig != null ? C.text : C.dim }}><span style={{ color:C.dim }}>K</span>{_vfmt(k?.vig)}</span>
                      <span style={{ fontSize:9, color: p?.vig != null ? C.text : C.dim }}><span style={{ color:C.dim }}>P</span>{_vfmt(p?.vig)}</span>
                    </span>
                  );
                })}
              </div>
            ))}
            <div style={{ color:C.dim, fontSize:9, marginTop:5, lineHeight:1.5 }}>
              Divergence monitor, <b>not a ranking</b> — expected ≈0 (the 7/04 Poly kill found ML median |Δ|~0.5¢). A lit (colored) cell is a prompt to <b>pre-register a mechanism, never a bet</b> · color = Δ (K−P); brightness = reliability (both venues ≥{bar.minN} rows, ≥{bar.minDays}d); thin cells greyed · hover for both venues + Δ
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- REPORT FOOTER ------------------------------------------------------------------------------
// report.reportDate/generatedAt/since/durationMs (run metadata) + report.uiHealth (a render
// self-check the report computes for this exact page — cell/row counts, prereg card count, any
// render warnings). Low-key by design: this is a diagnostic strip, not board content.
function ReportFooter({ report }) {
  if (!report) return null;
  const ui = report.uiHealth;
  return (
    <div style={{ display:"flex", flexWrap:"wrap", gap:12, marginTop:24, paddingTop:10, borderTop:`1px solid ${C.border}`, fontSize:9, color:C.dim, fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace" }}>
      <span>report {report.reportDate}</span>
      <span>generated {report.generatedAt}</span>
      <span>since {report.since}</span>
      {report.durationMs != null && <span>{(report.durationMs / 1000).toFixed(1)}s</span>}
      {ui && (
        <span style={{ color: ui.ok && !ui.warnings?.length ? C.dim : C.amber }}>
          uiHealth {ui.ok ? "ok" : "warn"} · heatmap {ui.heatmap?.cells}c/{ui.heatmap?.rows}r (shown {ui.heatmap?.rowsShown}, reliable {ui.heatmap?.reliableCells}, anomaly {ui.heatmap?.anomalyCells}) · prereg cards {ui.preregTracker?.cards}
          {ui.warnings?.length ? ` · ${ui.warnings.join("; ")}` : ""}
        </span>
      )}
    </div>
  );
}

// Landing page — now a full render of the daily /api/shadow-report run, in the same priority order
// the report workflow itself uses: robust candidates -> preregistrations -> heatmap -> discovery ->
// polymarket coverage parity -> venue-vig -> report meta. The read-only Kalshi balance + committed-
// maker-capital chip (relocated here 2026-07-30 from the removed taker picks drawer) rides in the
// header when logged in; `kalshiBalance`/`makerCommitted` come from /api/kalshi-balance.
export default function MakerBoardPage({ shadowReportData, shadowReportLoading, fetchShadowReport,
  isLoggedIn, kalshiBalance, makerCommitted = 0, onLoginClick, onLogout }) {
  React.useEffect(() => {
    if (isLoggedIn && !shadowReportData && !shadowReportLoading) fetchShadowReport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  const mb = shadowReportData?.makerBoard;
  const _money = (n) => n.toLocaleString("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 });
  return (
    <div style={{ maxWidth:1280, margin:"0 auto", padding:"16px 16px" }}>
      <div style={{ display:"flex", alignItems:"center", marginBottom:14, gap:12 }}>
        <h1 style={{ color:"#fff", fontSize:18, fontWeight:700, margin:0, flex:1 }}>Shadow Maker</h1>
        {/* Read-only funded-account chips: Kalshi cash + capital tied up in resting maker V2
            orders (shown only when nonzero, so the common disarmed case stays uncluttered). */}
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
        <>
          <DataFreshnessBanner df={shadowReportData?.dataFreshness} />

          {shadowReportData?.robustCandidates && (
            <>
              <_SectionLabel>Robust candidates — structural tripwire over the heatmap</_SectionLabel>
              <div style={{ marginBottom:22 }}><RobustCandidatesTripwire data={shadowReportData.robustCandidates} /></div>
            </>
          )}

          {(() => {
            const list = shadowReportData?.preregistrations || [];
            if (!list.length) return null;
            const cnt = {};
            for (const p of list) cnt[p.verdict] = (cnt[p.verdict] || 0) + 1;
            const order = ['KILL','FAILING','ON_TRACK','PASS','COLLECTING'];
            const parts = order.filter(v => cnt[v]);
            return (
              <div style={{ fontSize:9, color:C.dim, marginBottom:10 }}>
                <span style={{ fontWeight:700, textTransform:"uppercase", letterSpacing:0.4 }}>Pre-reg</span>
                {" · "}{list.length} cells underlined in heatmap{" · "}
                {parts.map((v, i) => (
                  <span key={v}>
                    <span style={{ color: _PREREG_COLOR[v] }}>{cnt[v]} {v.toLowerCase().replace('_', ' ')}</span>
                    {i < parts.length - 1 && " · "}
                  </span>
                ))}
                {" · "}criteria fixed before window opened, never a bet
              </div>
            );
          })()}
          <_SectionLabel>Category × band · ¢/contract (graded) — where PnL actually comes from</_SectionLabel>
          {mb ? <CategoryBandHeatmap cells={mb.categoryBands} preregs={shadowReportData?.preregistrations} />
              : <div style={{ color:C.dim, fontSize:12, padding:12 }}>Maker board not in this report yet — Refresh regenerates it.</div>}

          {shadowReportData?.discovery && (
            <>
              <div style={{ margin:"22px 0 6px" }}><_SectionLabel>Discovery — Kalshi + Polymarket series-vet queue</_SectionLabel></div>
              <DiscoveryOverview discovery={shadowReportData.discovery} />
            </>
          )}

          {shadowReportData?.polymarketTracking && (
            <>
              <div style={{ margin:"22px 0 6px" }}><_SectionLabel>Polymarket coverage — capture + resolution health</_SectionLabel></div>
              <PolymarketTrackingHealth data={shadowReportData.polymarketTracking} />
            </>
          )}

          {/* Cross-venue vig — Kalshi vs Polymarket, same category × band grid, VIG (not PnL). */}
          <div style={{ margin:"22px 0 6px" }}>
            <_SectionLabel>Cross-venue vig · Kalshi vs Polymarket — do the two venues price the same category × band differently?</_SectionLabel>
          </div>
          <VenueVigHeatmap venueVig={shadowReportData?.venueVig} />

          <ReportFooter report={shadowReportData} />
        </>
      )}
    </div>
  );
}
