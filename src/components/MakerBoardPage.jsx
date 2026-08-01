import React from 'react';

// Shadow Maker landing page. Stripped to a single element 2026-07-29 (see below): the category ×
// band heatmap is the only thing on it, because it is the one view for understanding where the
// engine's PnL actually comes from and whether any of it is real.
//
// What used to be here and why it's gone: portfolio tiles, the V2 open-positions block, the
// DoThisBanner (data-health + scheduled checkpoints), the cross-check strip (V1↔V2 / model↔market),
// the equity curve, and per-sport utilization. All removed at the user's request to keep one
// focused view. The integrity checks those surfaced are NOT lost — they still run server-side and
// are reachable on demand: /api/shadow-report?makerQueueCheck=1 (V1 vs V2), ?makerSideAudit=,
// /api/kalshi-dryrun-check (grading), and the resolver's own tripwires. The table itself also keeps
// its integrity signals: the anomaly ring (outcome pinned against price) and reliability muting.
// If a bug-catcher or a due-checkpoint surface is wanted back on the page later, restore from git
// history (the components lived in this file through commit c04dda0).

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

// ---- PRE-REGISTERED FORWARD TESTS ------------------------------------------------------------
// The ONE honest "when will we know" surface. A cell picked off the heatmap for being bright is
// best-of-N selection, so a data-extrapolated "ETA to arm" would just put a countdown on noise
// (and re-slice the same days the REENTRY doctrine has gone 0-for-6 on). What CAN resolve a cell is
// a forward test whose bar was fixed before the window opened — a CALENDAR checkpoint, not an ETA.
// Each card reads a `preregistrations[]` entry from the report; the server evaluates the fixed
// criteria over game_date >= forwardStart (see api/lib/maker-prereg.js). Verdict verbs, not colors,
// carry the state — COLLECTING (too early) / ON_TRACK / FAILING (provisional, pre-checkpoint) /
// PASS / KILL (terminal, at checkpoint).
const _VERDICT = {
  COLLECTING: { color: C.blue,  text: "COLLECTING" },
  ON_TRACK:   { color: C.green, text: "ON TRACK" },
  FAILING:    { color: C.amber, text: "FAILING" },
  PASS:       { color: C.green, text: "PASS" },
  KILL:       { color: C.red,   text: "KILL" },
};

function _daysUntil(checkpoint) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  return Math.round((Date.parse(`${checkpoint}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

function PreregTracker({ preregs }) {
  const list = preregs || [];
  if (!list.length) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ color:C.dim, fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4, marginBottom:6 }}>
        Pre-registered forward tests — the only cell-level "arm target" (criteria fixed before the window opened)
      </div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:10 }}>
        {list.map((p) => {
          const v = _VERDICT[p.verdict] || { color: C.gray, text: p.verdict };
          const daysLeft = _daysUntil(p.checkpoint);
          const r = p.result || {};
          const meanTxt = r.mean != null ? `${r.mean > 0 ? "+" : ""}${r.mean}` : "—";
          const ciTxt = r.ciLo != null ? `${r.ciLo > 0 ? "+" : ""}${r.ciLo}…${r.ciHi > 0 ? "+" : ""}${r.ciHi}` : "n/a";
          return (
            <div key={p.id} title={p.hypothesis} style={{ flex:"1 1 340px", minWidth:300, maxWidth:520,
              background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                <span style={{ color:C.text, fontSize:12, fontWeight:700 }}>{p.label}</span>
                <span style={{ color:C.dim, fontSize:10 }}>forward test</span>
                <span style={{ marginLeft:"auto", color:v.color, fontSize:10, fontWeight:700,
                  border:`1px solid ${v.color}`, borderRadius:4, padding:"1px 6px" }}>{v.text}</span>
              </div>
              <div style={{ color:C.gray, fontSize:10, marginBottom:8, fontVariantNumeric:"tabular-nums" }}>
                OOS since {p.forwardStart} · {r.days ?? 0}d, {r.fills ?? 0} fills ·
                {" "}mean {meanTxt}¢ · CI {ciTxt} ·
                {" "}checkpoint {p.checkpoint} {daysLeft > 0 ? `(${daysLeft}d left)` : daysLeft === 0 ? "(today)" : "(reached)"}
              </div>
              {/* The 5 fixed GREEN criteria, each with its live actual. Cross = not yet met — the
                  whole point is that ALL must hold on the forward window before this is a target. */}
              <div style={{ display:"flex", flexWrap:"wrap", gap:"3px 10px" }}>
                {(p.checks || []).map((c) => (
                  <span key={c.key} style={{ fontSize:9.5, color: c.met ? C.green : C.dim, whiteSpace:"nowrap" }}>
                    <span style={{ fontWeight:700 }}>{c.met ? "✓" : "✗"}</span> {c.label}
                    {c.actual != null && <span style={{ color:C.gray }}> ({c.actual})</span>}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- CATEGORY × BAND HEATMAP -----------------------------------------------------------------
// Category rows × band columns, cell = ¢/contract (graded). The grain that LOCALISES what band- or
// total-level pooling hides (the 55-64 "edge" that was really one category at an impossible +52¢).
// Two marks a pooled view can't carry: a red ring on an ANOMALY (outcome pinned against the price —
// the wrong-side-fill signature) and an amber dot when >50% of a cell's PnL came from ONE day (the
// selection tell). Rows sorted by volume.
function CategoryBandHeatmap({ cells, maxRows = 40 }) {
  const rows = React.useMemo(() => {
    const cs = cells || [];
    if (!cs.length) return [];
    const byCat = new Map();
    for (const c of cs) {
      const k = `${c.sport}|${c.category}`;
      let row = byCat.get(k);
      if (!row) { row = { key: k, label: `${c.sport} ${c.category}`, contracts: 0, pnl: 0, cells: {} }; byCat.set(k, row); }
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
                const c = r.cells[b];
                if (!c) return <span key={b} style={{ width:colW, height:22, border:`1px solid ${C.border}`, boxSizing:"border-box", marginRight:1 }} />;
                const ciTxt = c.ciLo != null ? `${c.ciLo > 0 ? "+" : ""}${c.ciLo}…${c.ciHi > 0 ? "+" : ""}${c.ciHi}` : "n/a";
                // Cells show a ROUNDED integer, not the 2-decimal mean — 479 precise numbers is the
                // wall; full precision + fills/days/one-day%/CI all live in the tooltip. The day-count
                // and one-day dot that used to ride reliable cells were dropped: they were soft
                // target-flags (they only appeared on the cells that clear zero), and this view is an
                // anomaly/PnL-distribution map, not a target picker. Unreliable numbers are pushed
                // further back (opacity) so the grid reads as a quiet field where structure + the
                // anomaly ring are what the eye lands on — not "here is your bet".
                const cellTxt = c.perContract != null ? `${c.perContract > 0 ? "+" : ""}${Math.round(c.perContract)}` : "";
                return (
                  <span key={b} title={`${r.label} ${b}¢: ${c.perContract > 0 ? "+" : ""}${c.perContract}¢/ct · ${c.fills} fills · sideWon ${c.sideWon} · ${c.days}d · day-clustered CI ${ciTxt} (${c.reliable ? "clears 0" : "straddles 0 — not distinguishable from noise"}) · top day ${Math.round((c.topDayShare ?? 0) * 100)}% of |PnL|${c.anomaly ? " · ANOMALY: outcome pinned against price" : ""}`}
                    style={{ position:"relative", width:colW, height:22, marginRight:1, boxSizing:"border-box",
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontVariantNumeric:"tabular-nums", color: c.reliable ? C.text : C.gray,
                      opacity: c.reliable ? 1 : 0.5,
                      background:_cellBg(c.perContract, scale, c.reliable),
                      border: c.anomaly ? `1.5px solid ${C.red}` : `1px solid ${C.border}` }}>
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
          ¢/contract (rounded), graded fills · <b>brightness = reliability</b> (day-clustered CI clear of zero), NOT size — a big number in a pale cell is noise · <span style={{ color:C.red }}>▢</span> anomaly: outcome pinned against price (P&lt;0.1%) · hover any cell for fills, days, one-day concentration + CI
          {rows.length > shown.length ? ` · +${rows.length - shown.length} lower-volume categories hidden` : ""}
        </div>
      </div>
    </div>
  );
}

// Landing page — single element by design (see top-of-file note). The read-only Kalshi balance +
// committed-maker-capital chip (relocated here 2026-07-30 from the removed taker picks drawer)
// rides in the header when logged in; `kalshiBalance`/`makerCommitted` come from /api/kalshi-balance.
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
          <PreregTracker preregs={shadowReportData?.preregistrations} />
          <div style={{ color:C.dim, fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4, marginBottom:6 }}>
            Category × band · ¢/contract (graded) — where PnL actually comes from
          </div>
          {mb ? <CategoryBandHeatmap cells={mb.categoryBands} />
              : <div style={{ color:C.dim, fontSize:12, padding:12 }}>Maker board not in this report yet — Refresh regenerates it.</div>}
        </>
      )}
    </div>
  );
}
