// api/lib/handlers/shadow/report.js
// GET /api/shadow-report — Shadow maker board: category × band heatmap + diagnostic branches.
//
// What was removed (2026-07-30): the morning brief, model accuracy board, betting board,
// polymarket/sportsbook validation, dataHealth, topPicks, categories, topBands, clv, perGameRoi.
// None of those were consumed by the frontend after the MakerBoardPage strip (2026-07-29).
// Response shape: { reportDate, generatedAt, since, makerBoard, preregistrations, dataFreshness,
// discovery, uiHealth, robustCandidates, durationMs }. `makerBoard` is the only field the UI reads;
// `preregistrations`, `dataFreshness`, `discovery`, `uiHealth`, and `robustCandidates` are consumed by
// the (non-UI) morning report that pulls this endpoint — dataFreshness asserts the heatmap is current
// through last night, discovery is the series-scan vet queue, uiHealth asserts the landing page's
// rendered payload is present + complete (a "current" dataFreshness with an empty/degenerate
// categoryBands still renders a BLANK board — only uiHealth catches that), and robustCandidates is the
// heatmap-robustness TRIPWIRE (expected NONE; a hit prompts a mechanism-first pre-registration, never
// a bet — see computeRobustCandidates).
//
// Diagnostic branches still live (all return before the report cache and accept ADMIN_KEY):
//   ?makerQueueCheck=1       V1-vs-V2 fill agreement (queue-priority calibration)
//   ?makerCell=sport|cat|band  drill into one heatmap cell by day
//   ?makerTapeProbe=YYYY-MM-DD  is V1's tape page actually covering the day?
//   ?makerFillForensic=YYYY-MM-DD  why did V1 miss a real V2 fill?
//   ?makerSideAudit=YYYY-MM-DD  establish taker_side ↔ quote_side from ground truth
//   ?makerBookAudit=sport|cat  per-SIDE book width behind the fills (YES-only gate blind spot)
//   ?makerExitCheck=1        early-exit counterfactual (pre-game only)
//   ?makerLeadTime=1         pre-registered lead-time test
//   ?makerDay=YYYY-MM-DD     single-day V1 attribution (bySport/byBand/byCategoryBand)

import { neonQuery } from "../../neon.js";
import { errorResponse, jsonResponse } from "../../utils.js";
import { CAPTURE_MAX_SPREAD } from "../../config.js";
import { verifyJWT } from "../../auth-utils.js";
import { isArmed as isMakerV2Armed } from "../../maker-live.js";
import { fetchKalshiSettlements, resolveTickerSideViaKalshi } from "../../kalshi-settlement.js";
import { PREREG_CELLS, evaluatePrereg } from "../../maker-prereg.js";
import { QUOTEPASS_KEY_PREFIX } from "../../maker.js";
import { weightedPnlSumsSql, weightedPnlFromRow, dayClusteredPnl, quotedOutcomesByBand,
  adverseSelectionWithinBand, exitCounterfactual, ladderAnomalies } from "../../maker-stats.js";

// Maker ask-price band buckets, as a SQL CASE over any ask column. ONE definition (2026-07-26) —
// previously copy-pasted per query, and the quoted-vs-filled comparison is only meaningful if both
// sides bucket identically, so a third copy was the wrong way to add one. `col` is a trusted
// identifier from call sites in this file, never user input.
// EVERY maker board query filters `source = 'live'` (2026-07-28). `maker_quotes` also holds
// replayed segments (api/lib/maker-backfill.js); the board's day-clustered CI is the arm gate —
// letting an unvalidated replay leak into it would arm real money on reconstructed data.
// 5¢ buckets across the FULL price range. Extended below 55 on 2026-07-29 when the V1 paper
// engine began quoting the underdog side too (MAKER_FULL_BAND).
const _makerBandCase = (col) => `CASE
  WHEN ${col} < 5 THEN '0-4' WHEN ${col} < 10 THEN '5-9'
  WHEN ${col} < 15 THEN '10-14' WHEN ${col} < 20 THEN '15-19'
  WHEN ${col} < 25 THEN '20-24' WHEN ${col} < 30 THEN '25-29'
  WHEN ${col} < 35 THEN '30-34' WHEN ${col} < 40 THEN '35-39'
  WHEN ${col} < 45 THEN '40-44' WHEN ${col} < 50 THEN '45-49'
  WHEN ${col} < 55 THEN '50-54' WHEN ${col} < 60 THEN '55-59'
  WHEN ${col} < 65 THEN '60-64' WHEN ${col} < 70 THEN '65-69'
  WHEN ${col} < 75 THEN '70-74' WHEN ${col} < 80 THEN '75-79'
  WHEN ${col} < 85 THEN '80-84' WHEN ${col} < 90 THEN '85-89' ELSE '90-96' END`;

// ── Cross-venue vig (Kalshi vs Polymarket) ────────────────────────────────────────────────────
// The category×band favorite-ask VIG (avg captured ask − realized win rate, in ¢), computed
// identically on BOTH venues from capture + resolution alone — no fills, no model. The substrate for
// the [ Kalshi | Polymarket | Δ ] heatmap toggle. A DIVERGENCE MONITOR, not a ranking: expected ≈0
// (the 2026-07-04 Poly kill found ML median |Δ|~0.5¢), and a lit Δ cell is a prompt to pre-register
// a mechanism, never a bet (feedback_no_insample_target_picker_ui). This is VIG, distinct from the
// maker-PnL the categoryBands heatmap shows.
//
// Kalshi category is derived from the market's OWN series prefix (kalshi_ticker) so it maps onto the
// Poly-side category names one-for-one: ml = game winner, total = full-game total, spread = full-game
// spread, f5 = first-five winner, f5total/f5spread = the F5 threshold families. `startsWith(PREFIX +
// "-")` isolates KXMLBF5- (f5 winner) from KXMLBF5TOTAL-/KXMLBF5SPREAD-, and KXMLBTOTAL- (total) from
// KXMLBTEAMTOTAL-; no prefix here is a prefix of another under that guard, so iteration order carries
// no meaning. A wrong/absent series name fails safe (empty cell).
//
// THIS MAP IS THE KALSHI HALF OF A PAIR — the Poly half is each league's `categories` in
// polymarket.js `POLY_MARKETS`. A category present in one and not the other still captures, but its
// Δ is always empty, which reads as "no divergence" rather than "not built". Add both or neither.
// Deliberately NOT derived from SERIES_CONFIG: its `stat` values are per-sport idiosyncratic
// (`totalRuns`, `teamRuns`) and KXMLBGAME/KXMLBF5 have no SERIES_CONFIG row at all, so deriving it
// would be a chokepoint on paper and a silent-drift generator in practice.
export const KALSHI_VENUE_CATEGORY_PREFIXES = {
  ml:       ["KXMLBGAME", "KXWNBAGAME", "KXNBAGAME", "KXNHLGAME", "KXNFLGAME", "KXKBOGAME"],
  total:    ["KXMLBTOTAL", "KXWNBATOTAL", "KXNBATOTAL", "KXNHLTOTAL", "KXNFLTOTAL"],
  spread:   ["KXMLBSPREAD", "KXWNBASPREAD", "KXNBASPREAD", "KXNHLSPREAD"],
  f5:       ["KXMLBF5"],
  f5total:  ["KXMLBF5TOTAL"],
  f5spread: ["KXMLBF5SPREAD"],
};
export function venueCategoryFromKalshiTicker(ticker) {
  const t = String(ticker || "");
  for (const [cat, prefixes] of Object.entries(KALSHI_VENUE_CATEGORY_PREFIXES)) {
    if (prefixes.some((p) => t.startsWith(`${p}-`))) return cat;
  }
  return null;
}
const _VENUE_VIG_BAR = { minN: 50, minDays: 3 };
// SQL fragments built from the SAME prefix map so the SQL classifier and the JS one can't drift.
const _kalshiCatCaseSql = `CASE ${Object.entries(KALSHI_VENUE_CATEGORY_PREFIXES)
  .map(([cat, pre]) => `WHEN ${pre.map((p) => `kalshi_ticker LIKE '${p}-%'`).join(" OR ")} THEN '${cat}'`)
  .join(" ")} ELSE NULL END`;
const _kalshiTickerFilterSql = Object.values(KALSHI_VENUE_CATEGORY_PREFIXES).flat()
  .map((p) => `kalshi_ticker LIKE '${p}-%'`).join(" OR ");
// Poly's own category column is one of the same keys — derived so a new venue-vig category can't
// drift out of sync the way 'spread'/'f5total'/'f5spread' did on 2026-08-13 (added to the prefix map
// and the Kalshi-side classifier, but the Poly-side query's hand-written IN-list was never updated).
const _venueVigCategoriesSql = Object.keys(KALSHI_VENUE_CATEGORY_PREFIXES).map((c) => `'${c}'`).join(", ");

// Pure: assemble the venueVig cells from the two aggregation result sets. Each row: {sport, category,
// band, n, days, avg_ask, win_pct}. vig = avg_ask − win_pct (¢). deltaVig = kalshiVig − polyVig, only
// where BOTH venues have the cell. `reliable` = both sides clear the sample bar (the UI greys the
// rest, so thin cells can't read as precise).
export function computeVenueVig(kalshiRows, polyRows, bar = _VENUE_VIG_BAR) {
  const cells = new Map();
  const _side = (r) => {
    const avgAsk = r.avg_ask != null ? Number(r.avg_ask) : null;
    const winPct = r.win_pct != null ? Number(r.win_pct) : null;
    return { n: Number(r.n || 0), days: Number(r.days || 0), avgAsk, winPct,
      vig: (avgAsk != null && winPct != null) ? parseFloat((avgAsk - winPct).toFixed(1)) : null };
  };
  const _get = (r) => {
    const key = `${r.sport}|${r.category}|${r.band}`;
    let c = cells.get(key);
    if (!c) { c = { sport: r.sport, category: r.category, band: r.band, kalshi: null, poly: null }; cells.set(key, c); }
    return c;
  };
  for (const r of (kalshiRows || [])) _get(r).kalshi = _side(r);
  for (const r of (polyRows || [])) _get(r).poly = _side(r);
  const _sum = (rows) => (rows || []).reduce((a, r) => a + Number(r.n || 0), 0);
  return {
    bar,
    cells: [...cells.values()].map((c) => {
      const k = c.kalshi, p = c.poly;
      const bothVig = k?.vig != null && p?.vig != null;
      const reliable = !!(k && p && k.n >= bar.minN && p.n >= bar.minN && k.days >= bar.minDays && p.days >= bar.minDays);
      return { ...c, deltaVig: bothVig ? parseFloat((k.vig - p.vig).toFixed(1)) : null, reliable };
    }),
    venuesPresent: { kalshi: _sum(kalshiRows), poly: _sum(polyRows) },
    note: "Divergence monitor, NOT a ranking. Δ = Kalshi vig − Poly vig per category×band (vig = avg captured ask − realized win rate, ¢). Expected ≈0 (the 2026-07-04 Poly kill found ML median |Δ|~0.5¢). A lit Δ cell is a prompt to pre-register a mechanism, never a bet.",
  };
}

// Pure: assemble the morning-report Polymarket TRACKING block from (a) a polymarket_plays aggregate
// row, (b) the most-recent-capture per-sport breakdown, and (c) the already-computed venueVig. This
// is the daily data-HEALTH readout for the Poly capture instrument — is capture accruing, is
// resolution keeping up, and a compact divergence summary. `vig.topDivergences` is a MONITOR, never
// a bet list (same doctrine as the heatmap read). NOT read by the frontend; for the morning report.
export function computePolymarketTracking({ agg = {}, recentBySport = [], venueVig = null } = {}) {
  const vv = venueVig || { cells: [], venuesPresent: { kalshi: 0, poly: 0 } };
  const bothCells = (vv.cells || []).filter((c) => c.kalshi && c.poly);
  const topDivergences = bothCells
    .filter((c) => c.deltaVig != null)
    .sort((x, y) => Math.abs(y.deltaVig) - Math.abs(x.deltaVig))
    .slice(0, 5)
    .map((c) => ({ cell: `${c.sport}|${c.category}|${c.band}`, deltaVig: c.deltaVig,
      kalshiVig: c.kalshi.vig, polyVig: c.poly.vig, reliable: c.reliable }));
  return {
    capture: {
      total: Number(agg.total || 0),
      captureDays: Number(agg.capture_days || 0),
      lastCapture: agg.last_capture || null,
      lastCaptureRows: (recentBySport || []).reduce((s, r) => s + Number(r.n || 0), 0),
      recentBySport: (recentBySport || []).map((r) => ({ sport: r.sport, n: Number(r.n || 0), graded: Number(r.graded || 0) })),
    },
    resolution: {
      graded: Number(agg.graded || 0),
      voided: Number(agg.voided || 0),
      pending: Number(agg.pending || 0),
    },
    vig: {
      venuesPresent: vv.venuesPresent,
      bothVenueCells: bothCells.length,
      reliableCells: bothCells.filter((c) => c.reliable).length,
      topDivergences,
    },
    note: "Capture+resolve health for the Polymarket cross-venue instrument. `vig.topDivergences` is a DIVERGENCE MONITOR (expected ≈0), never a bet list — a persistent lit cell is a prompt to pre-register a mechanism. Empty vig cells while both venues accrue is the normal early state.",
  };
}

// Per-day graded-fill aggregation for ONE category × band cell, optionally restricted to a forward
// window (`since` → game_date >= since). One definition shared by the ?makerCell drill-down and the
// pre-registration tracker, so both bucket bands identically (`_makerBandCase`) and a forward
// evaluation matches its own ?makerCell&since= readout by construction. `sport`/`category`/`band`
// are bound params; `since` is bound too when present.
function _cellPerDaySince(env, sport, category, band, since) {
  const sinceSql = since ? " AND q.game_date >= $4" : "";
  const args = since ? [sport, category, band, since] : [sport, category, band];
  return neonQuery(
    `SELECT q.game_date AS day, COUNT(*)::int AS fills,
       COALESCE(SUM(f.contracts),0)::numeric AS contracts,
       COALESCE(SUM(f.pnl_cents*f.contracts),0)::numeric AS pnl_total,
       COALESCE(SUM((f.side_won)::int::numeric*f.contracts),0)::numeric AS won_contracts,
       ROUND(AVG(f.fill_ask),1) AS avg_ask
     FROM maker_fills f JOIN maker_quotes q ON q.id=f.quote_id
     WHERE q.source='live' AND f.graded_at IS NOT NULL
       AND q.sport=$1 AND COALESCE(q.category,q.sport)=$2 AND ${_makerBandCase("f.fill_ask")}=$3${sinceSql}
     GROUP BY 1 ORDER BY 1`, args, env, { write: true });
}

const REPORT_CACHE_KEY_PREFIX = "shadow:report:";
const REPORT_TTL = 60 * 60 * 25; // 25 hours

function _extractReportToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
  if (m?.[1]) return m[1];
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
}

// Mirrors CategoryBandHeatmap's maxRows default (src/components/MakerBoardPage.jsx) — kept here only
// to report rowsShown/rowsHidden; if the component's default changes, update this too (the numbers
// are advisory, not a gate, so drift is cosmetic).
const _HEATMAP_MAX_ROWS = 40;

// Pure UI-health check over the already-assembled report payload. Validates the two fields the
// landing page renders against the exact keys the components read:
//   CategoryBandHeatmap  → makerBoard.categoryBands[].{sport,category,band,contracts,perContract}
//     (render-critical: a missing one draws a blank or NaN square; reliable/anomaly/fills/… are
//      tooltip/style-only and degrade gracefully, so they are counted, not gated)
//   PreregTracker        → preregistrations[].{id,verdict,checkpoint,forwardStart,label,checks[]}
function computeUiHealth(makerBoard, preregistrations) {
  const warnings = [];

  const mbPresent = !!makerBoard;
  const cells = Array.isArray(makerBoard?.categoryBands) ? makerBoard.categoryBands : [];
  const CELL_RENDER_FIELDS = ["sport", "category", "band", "contracts", "perContract"];
  const cellsMissingRenderField = cells.filter(c => CELL_RENDER_FIELDS.some(f => c?.[f] == null)).length;
  const rows = new Set(cells.map(c => `${c?.sport}|${c?.category}`)).size;
  const reliableCells = cells.filter(c => c?.reliable).length;
  const anomalyCells = cells.filter(c => c?.anomaly).length;
  const heatmapRendered = mbPresent && cells.length > 0;

  if (!mbPresent) warnings.push("makerBoard is null — board shows the 'not in this report yet' fallback");
  else if (!cells.length) warnings.push("categoryBands is empty — heatmap shows the 'appears with first graded fills' placeholder");
  if (cellsMissingRenderField > 0)
    warnings.push(`${cellsMissingRenderField} heatmap cell(s) missing a render-critical field (${CELL_RENDER_FIELDS.join("/")}) — would render blank/NaN`);

  const pregs = Array.isArray(preregistrations) ? preregistrations : [];
  const PREREG_RENDER_FIELDS = ["id", "verdict", "checkpoint", "forwardStart", "label"];
  const preregMalformed = pregs.filter(p =>
    PREREG_RENDER_FIELDS.some(f => p?.[f] == null) || !Array.isArray(p?.checks)).length;
  if (preregMalformed > 0)
    warnings.push(`${preregMalformed} prereg card(s) missing a render field — PreregTracker row breaks`);

  return {
    ok: heatmapRendered && cellsMissingRenderField === 0 && preregMalformed === 0,
    heatmap: {
      rendered: heatmapRendered,
      cells: cells.length,
      rows,
      rowsShown: Math.min(rows, _HEATMAP_MAX_ROWS),
      rowsHidden: Math.max(0, rows - _HEATMAP_MAX_ROWS),
      reliableCells,
      anomalyCells,
      cellsMissingRenderField,
    },
    preregTracker: { rendered: pregs.length > 0, cards: pregs.length, malformed: preregMalformed },
    warnings,
  };
}

// ── Robust-candidate tripwire (morning-report only; NOT read by the frontend) ──────────────────────
// The category × band heatmap is a map of noise: 555 cells, ~1/40 clear a 95% CI by chance with zero
// real edge, so its bright cells are (mostly) selection artifacts. Eyeballing the greenest and
// "advancing" it is the in-sample target-picker the REENTRY doctrine has gone 0-for-6 on. This is the
// disciplined inverse: a strict structural bar that a cell must cross before it is even a PRE-
// REGISTRATION candidate — the day-clustered CI already excludes zero (`reliable`), plus the sample
// depth + spread the f5total pre-registration itself required: >= 8 days, >= 50 fills, and no single
// slate carrying it (top-day share <= 0.35). It is a TRIPWIRE, not a shortlist: the expected output is
// NONE (which is the honest state of the board), and a hit is a prompt to sit down and design a
// mechanism-first pre-registration (a new docs/MAKER_*_PREREG.md), NEVER a cell to bet or rank.
// Robustness is necessary, not sufficient — f5total was clean in-sample and still inverted forward.
//
// The idle state is NOT zero (corrected 2026-08-11). "Expected output NONE" was true at ship because
// n was small, not because a hit means edge: the day-clustered CI narrows as days accumulate, so ANY
// cell with a nonzero *structural* offset eventually crosses ciLo > 0. On a price-monotone book that
// is most of the board — 2026-08-11 read 23 lit positive and 26 lit NEGATIVE out of 210 eligible,
// against a ~10.5-per-arm noise floor, with 22/23 of the positives below 50c and 26/26 of the
// negatives at 50c+ (docs/MAKER_LADDER_ARTIFACT.md). So the payload carries the DENOMINATOR
// (`eligible`), the noise floor, and BOTH arms: the signal worth waking up for is an ASYMMETRY
// between the arms, never `count` on its own.
const ROBUST_BAR = { minDays: 8, minFills: 50, maxTopDayShare: 0.35 };
// The one-sided rate `reliable` is built at — i.e. the share of pure-noise cells expected to clear
// the interval on EACH arm. Multiplied by `eligible` this is the tripwire's own null.
const ROBUST_ONE_SIDED_RATE = 0.05;

const _robustCell = (c) => ({ cell: `${c.sport}|${c.category}|${c.band}`, sport: c.sport,
  category: c.category, band: c.band, fills: c.fills, days: c.days, perContract: c.perContract,
  ciLo: c.ciLo, ciHi: c.ciHi, topDayShare: c.topDayShare });
// Sorted by cell NAME, never by perContract: a perContract-descending array is a ranked shortlist
// whatever the note says, and the doctrine that rejected a "best-green" heatmap shade rejects this
// for the same reason. Ordering must carry no information about which cell looks best.
const _byCell = (a, b) => a.cell.localeCompare(b.cell);

function computeRobustCandidates(makerBoard) {
  const cells = Array.isArray(makerBoard?.categoryBands) ? makerBoard.categoryBands : [];
  // Eligible = the SAMPLE bar alone (no sign test), which is the denominator `count` has to be read
  // against. Applying the CI rate to every cell on the board overstates the floor, because most
  // cells can't clear days/fills/top-day-share in the first place.
  const eligible = cells.filter(c => c
    && (c.days || 0) >= ROBUST_BAR.minDays
    && (c.fills || 0) >= ROBUST_BAR.minFills
    && c.topDayShare != null && c.topDayShare <= ROBUST_BAR.maxTopDayShare
    && c.ciLo != null);
  // `reliable` already encodes day-clustered ciLo > 0 && days >= 3 — the positive arm. The negative
  // arm is its mirror (ciHi < 0) and is reported ALONGSIDE rather than dropped: it is the only way to
  // tell "this book has an edge" from "this book has a slope", and dropping it is what let a
  // one-armed count read as 23 surprises when the board was near-symmetric.
  const candidates = eligible.filter(c => c.reliable === true).map(_robustCell).sort(_byCell);
  const negatives = eligible.filter(c => c.ciHi != null && c.ciHi < 0).map(_robustCell).sort(_byCell);
  const noiseFloor = parseFloat((eligible.length * ROBUST_ONE_SIDED_RATE).toFixed(1));
  const asym = `${candidates.length} positive vs ${negatives.length} negative of ${eligible.length} eligible (noise floor ~${noiseFloor}/arm)`;
  return {
    bar: ROBUST_BAR,
    eligible: eligible.length,
    noiseFloor,
    count: candidates.length,
    negativeCount: negatives.length,
    candidates,
    negatives,
    // The note travels with the payload so the morning report can never restate it as "top picks".
    note: eligible.length === 0
      ? "no cell has cleared the sample bar yet — nothing to pre-register"
      : candidates.length === 0
        ? `no cell lit on the positive arm — ${asym}; nothing to pre-register`
        : `NOT a bet list — a candidate is only ever a prompt for a mechanism-first pre-registration (new docs/MAKER_*_PREREG.md); robustness ≠ edge (f5total was clean in-sample and failed forward). `
          + `The idle state is NOT zero: ${asym}. Read the ASYMMETRY between the arms, never count alone — `
          + `a price-monotone book lights one arm by construction (docs/MAKER_LADDER_ARTIFACT.md).`,
  };
}

async function handleShadowReport({ path, request, env, cache }) {
  if (path !== "shadow-report") return null;

  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isCron  = env?.CRON_SECRET && bearer === env.CRON_SECRET;
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;

  let isUser = false;
  if (!isCron && !isAdmin && env?.JWT_SECRET) {
    const token = _extractReportToken(request);
    const payload = token ? await verifyJWT(token, env.JWT_SECRET) : null;
    isUser = !!payload;
  }

  if (!isCron && !isAdmin && !isUser) return errorResponse("Forbidden", 403);
  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("No Neon connection", 500);

  // ── ?makerTapeProbe=YYYY-MM-DD — is V1's single tape page actually covering the day? ──────────
  if (new URL(request.url).searchParams.get("makerTapeProbe")) {
    const dayPT = new URL(request.url).searchParams.get("makerTapeProbe");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPT)) return errorResponse("makerTapeProbe must be YYYY-MM-DD", 400);
    try {
      const picks = await neonQuery(
        `SELECT o.ticker, MIN(o.placed_at) AS first_order, MAX(COALESCE(o.canceled_at, o.expires_at)) AS last_order,
                SUM(o.filled_count)::int AS filled
           FROM maker_orders_v2 o
          WHERE o.game_date = $1 AND o.filled_count > 0
          GROUP BY o.ticker ORDER BY filled DESC LIMIT 8`, [dayPT], env, { write: true });
      const minTs = Math.floor((Date.parse(`${dayPT}T00:00:00-07:00`) - 6 * 3600_000) / 1000);
      const out = [];
      for (const p of picks) {
        try {
          const r = await fetch(
            `https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${encodeURIComponent(p.ticker)}&limit=1000&min_ts=${minTs}`,
            { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
          if (!r.ok) { out.push({ ticker: p.ticker, error: `HTTP ${r.status}` }); continue; }
          const j = await r.json();
          const tr = j?.trades || [];
          const times = tr.map(t => t.created_time).filter(Boolean).sort();
          out.push({
            ticker: p.ticker, v2Filled: p.filled,
            orderWindow: { from: p.first_order, to: p.last_order },
            trades: tr.length,
            hitLimit: tr.length >= 1000,
            hasCursor: !!j?.cursor,
            firstTrade: times[0] || null,
            lastTrade: times[times.length - 1] || null,
            windowCoveredByPage: times.length
              ? Date.parse(times[0]) <= Date.parse(p.first_order) : null,
          });
        } catch (e) { out.push({ ticker: p.ticker, error: String(e?.message || e) }); }
      }
      const covered = out.filter(o => o.windowCoveredByPage === true).length;
      const truncated = out.filter(o => o.windowCoveredByPage === false).length;
      return jsonResponse({ ok: true, day: dayPT, probed: out.length,
        windowCovered: covered, windowTruncated: truncated,
        hitLimit: out.filter(o => o.hitLimit).length, tickers: out });
    } catch (e) { return errorResponse(`makerTapeProbe failed: ${e?.message}`, 500); }
  }

  // ── ?makerFillForensic=YYYY-MM-DD — why did V1 miss a real V2 fill? ──────────────────────────
  if (new URL(request.url).searchParams.get("makerFillForensic")) {
    const dayPT = new URL(request.url).searchParams.get("makerFillForensic");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPT)) return errorResponse("makerFillForensic must be YYYY-MM-DD", 400);
    try {
      const cases = await neonQuery(
        `SELECT o.id, o.ticker, o.side, o.price, o.size, o.filled_count,
                o.placed_at, COALESCE(o.canceled_at, o.expires_at) AS ended_at
           FROM maker_orders_v2 o
          WHERE o.game_date = $1 AND o.filled_count > 0
            AND NOT EXISTS (
              SELECT 1 FROM maker_quotes q
                JOIN maker_fills f ON f.quote_id = q.id
               WHERE q.ticker = o.ticker AND q.source = 'live' AND q.quote_side = o.side
                 AND f.traded_at >= o.placed_at
                 AND f.traded_at <  COALESCE(o.canceled_at, o.expires_at, NOW()))
          ORDER BY o.filled_count DESC LIMIT 3`, [dayPT], env, { write: true });
      if (!cases.length) return jsonResponse({ ok: true, day: dayPT, cases: [], note: "no V2-filled/V1-missed orders that day" });

      const minTs = Math.floor((Date.parse(`${dayPT}T00:00:00-07:00`) - 6 * 3600_000) / 1000);
      const out = [];
      for (const c of cases) {
        const segs = await neonQuery(
          `SELECT id, quote_side, quote_ask, size, valid_from, valid_to
             FROM maker_quotes
            WHERE ticker = $1 AND source = 'live' AND quote_side = $2
              AND valid_from < $4 AND COALESCE(valid_to, NOW()) > $3
            ORDER BY valid_from`, [c.ticker, c.side, c.placed_at, c.ended_at], env, { write: true });
        let trades = [];
        try {
          const r = await fetch(
            `https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${encodeURIComponent(c.ticker)}&limit=1000&min_ts=${minTs}`,
            { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
          if (r.ok) trades = (await r.json())?.trades || [];
        } catch {}
        const from = Date.parse(c.placed_at), to = Date.parse(c.ended_at);
        const windowTrades = trades.filter(t => {
          const ts = Date.parse(t.created_time);
          return ts >= from && ts < to;
        });
        const reasons = { outsideWindow: 0, sideMismatch: 0, priceBelowAsk: 0, noPrice: 0, matched: 0 };
        for (const seg of segs) {
          const sfrom = Date.parse(seg.valid_from), sto = seg.valid_to ? Date.parse(seg.valid_to) : Infinity;
          for (const t of windowTrades) {
            const ts = Date.parse(t.created_time);
            if (ts < sfrom || ts >= sto) { reasons.outsideWindow++; continue; }
            if (t.taker_side === seg.quote_side) { reasons.sideMismatch++; continue; }
            const px = seg.quote_side === "yes"
              ? (t.yes_price_dollars != null ? Math.round(parseFloat(t.yes_price_dollars) * 100) : null)
              : (t.no_price_dollars  != null ? Math.round(parseFloat(t.no_price_dollars)  * 100) : null);
            if (px == null) { reasons.noPrice++; continue; }
            if (px < Number(seg.quote_ask)) { reasons.priceBelowAsk++; continue; }
            reasons.matched++;
          }
        }
        out.push({ ticker: c.ticker, side: c.side, price: c.price, v2Filled: c.filled_count,
          v1Segments: segs.length, windowTrades: windowTrades.length, reasons });
      }
      return jsonResponse({ ok: true, day: dayPT, cases: out });
    } catch (e) { return errorResponse(`makerFillForensic failed: ${e?.message}`, 500); }
  }

  // ── ?makerSideAudit=YYYY-MM-DD — establish taker_side ↔ quote_side from ground truth ──────────
  if (new URL(request.url).searchParams.get("makerSideAudit")) {
    const dayPT = new URL(request.url).searchParams.get("makerSideAudit");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPT)) return errorResponse("makerSideAudit must be YYYY-MM-DD", 400);
    try {
      const [segBySide, fillBySide, orders] = await Promise.all([
        neonQuery(`SELECT quote_side, COUNT(*)::int AS n FROM maker_quotes
          WHERE game_date = $1 AND source = 'live' GROUP BY quote_side`, [dayPT], env, { write: true }),
        neonQuery(`SELECT q.quote_side, COUNT(*)::int AS n, SUM(f.contracts)::numeric AS contracts
          FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
          WHERE q.game_date = $1 AND q.source = 'live' GROUP BY q.quote_side`, [dayPT], env, { write: true }),
        neonQuery(`SELECT o.ticker, o.side, o.price, o.placed_at,
                COALESCE(o.canceled_at, o.expires_at) AS ended_at
           FROM maker_orders_v2 o
          WHERE o.game_date = $1 AND o.filled_count > 0
          ORDER BY ticker LIMIT 120`, [dayPT], env, { write: true }),
      ]);
      const minTs = Math.floor((Date.parse(`${dayPT}T00:00:00-07:00`) - 6 * 3600_000) / 1000);
      const tapeCache = new Map();
      const getTape = async (ticker) => {
        if (tapeCache.has(ticker)) return tapeCache.get(ticker);
        let tr = [];
        try {
          const r = await fetch(
            `https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=1000&min_ts=${minTs}`,
            { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
          if (r.ok) tr = (await r.json())?.trades || [];
        } catch {}
        tapeCache.set(ticker, tr);
        return tr;
      };
      const map = {};
      let matchedOrders = 0, unmatchedOrders = 0;
      const samples = [];
      for (const o of orders) {
        const tape = await getTape(o.ticker);
        const from = Date.parse(o.placed_at), to = Date.parse(o.ended_at);
        const hit = tape.filter(t => {
          const ts = Date.parse(t.created_time);
          if (!(ts >= from && ts < to)) return false;
          const px = o.side === "yes"
            ? (t.yes_price_dollars != null ? Math.round(parseFloat(t.yes_price_dollars) * 100) : null)
            : (t.no_price_dollars  != null ? Math.round(parseFloat(t.no_price_dollars)  * 100) : null);
          return px === Number(o.price);
        });
        if (!hit.length) { unmatchedOrders++; continue; }
        matchedOrders++;
        for (const t of hit) {
          const k = `${o.side}->${t.taker_side}`;
          map[k] = (map[k] || 0) + 1;
          if (samples.length < 8) samples.push({ ticker: o.ticker, quoteSide: o.side,
            takerSide: t.taker_side, price: o.price, count: t.count_fp ?? t.count, at: t.created_time });
        }
      }
      const same = Object.entries(map).filter(([k]) => k.split("->")[0] === k.split("->")[1])
        .reduce((a, [, v]) => a + v, 0);
      const opposite = Object.entries(map).filter(([k]) => k.split("->")[0] !== k.split("->")[1])
        .reduce((a, [, v]) => a + v, 0);
      return jsonResponse({
        ok: true, day: dayPT,
        existingPopulation: {
          segmentsBySide: Object.fromEntries(segBySide.map(r => [r.quote_side, r.n])),
          fillsBySide: Object.fromEntries(fillBySide.map(r => [r.quote_side, { fills: r.n, contracts: Number(r.contracts) }])),
        },
        groundTruth: {
          ordersExamined: orders.length, matchedOrders, unmatchedOrders,
          mapping: map, takerSideSameAsQuoteSide: same, takerSideOppositeQuoteSide: opposite,
          verdict: (same + opposite) < 20 ? "TOO FEW — need more matched orders"
                 : opposite / (same + opposite) >= 0.95 ? "REQUIRE taker_side !== quote_side"
                 : same / (same + opposite) >= 0.95 ? "REQUIRE taker_side === quote_side"
                 : "MIXED — do not flip; investigate before changing replayFills",
          samples,
        },
      });
    } catch (e) { return errorResponse(`makerSideAudit failed: ${e?.message}`, 500); }
  }

  // ── ?makerBookAudit=sport|category — per-SIDE book width behind the fills ────────────────────
  // Built 2026-08-11 to settle whether the mlb|f5spread 40-64 anomaly is an artifact price.
  // `computeMakerQuote` gates eligibility on `yesAsk - yesBid` alone ("Unified book: both sides
  // share one spread") and then quotes the NO side off the independently-read `no_ask_dollars`. That
  // identity holds for maker-backfill.js's reconstructed candlestick books (no_ask = 100 - yes_bid by
  // construction) but NOT for the live API, where the two books are independent and 3-7c apart —
  // CLAUDE.md's standing gotcha. So a market with a tight YES book and a wide NO book passes the gate
  // and gets quoted on the NO side at a price nothing is resting behind.
  //
  // `maker_quotes` already persists the whole book (book_yes_ask/bid, book_no_ask/bid, maker.js:239),
  // so this needs no new capture — just the read nobody had written. Read-only, ADMIN.
  if (new URL(request.url).searchParams.get("makerBookAudit")) {
    const spec = new URL(request.url).searchParams.get("makerBookAudit");
    const [sport, category] = String(spec).split("|");
    if (!sport || !category) return errorResponse("makerBookAudit must be sport|category", 400);
    try {
      const rows = await neonQuery(
        `SELECT ${_makerBandCase("f.fill_ask")} AS band, q.quote_side,
                COUNT(*)::int AS fills,
                COALESCE(SUM(f.contracts),0)::numeric AS contracts,
                ROUND(AVG(f.fill_ask),1) AS avg_fill_ask,
                ROUND(AVG(q.book_yes_ask - q.book_yes_bid),2) AS avg_yes_spread,
                ROUND(AVG(q.book_no_ask  - q.book_no_bid ),2) AS avg_no_spread,
                -- The gate's blind spot, counted directly: NO book wider than the cap while the YES
                -- book (the only one actually tested) is inside it.
                COUNT(*) FILTER (WHERE (q.book_no_ask - q.book_no_bid) > $3
                                   AND (q.book_yes_ask - q.book_yes_bid) <= $3)::int AS no_wide_yes_tight,
                -- Complementarity: if the two books really were one unified book, yes_ask + no_ask
                -- would sit at ~100 + spread. A large excess means they are quoting different things.
                ROUND(AVG(q.book_yes_ask + q.book_no_ask), 1) AS avg_ask_sum,
                COALESCE(SUM((f.side_won)::int::numeric*f.contracts),0)::numeric AS won_contracts,
                COALESCE(SUM(f.pnl_cents*f.contracts),0)::numeric AS pnl_total
           FROM maker_fills f JOIN maker_quotes q ON q.id=f.quote_id
          WHERE q.source='live' AND f.graded_at IS NOT NULL
            AND q.sport=$1 AND COALESCE(q.category,q.sport)=$2
            AND q.book_no_ask IS NOT NULL AND q.book_no_bid IS NOT NULL
          GROUP BY 1,2 ORDER BY 1,2`,
        [sport, category, CAPTURE_MAX_SPREAD], env, { write: true });
      const cells = rows.map(r => {
        const ct = Number(r.contracts) || 0;
        return { band: r.band, side: r.quote_side, fills: r.fills, contracts: Number(ct.toFixed(1)),
          avgFillAsk: Number(r.avg_fill_ask), avgYesSpread: Number(r.avg_yes_spread),
          avgNoSpread: Number(r.avg_no_spread), avgAskSum: Number(r.avg_ask_sum),
          noWideYesTight: r.no_wide_yes_tight,
          sideWon: ct ? parseFloat((Number(r.won_contracts) / ct).toFixed(4)) : null,
          perContract: ct ? parseFloat((Number(r.pnl_total) / ct).toFixed(2)) : null };
      });
      const tot = cells.reduce((a, c) => a + c.fills, 0);
      const gapped = cells.reduce((a, c) => a + c.noWideYesTight, 0);
      return jsonResponse({
        ok: true, cell: spec, maxSpreadC: CAPTURE_MAX_SPREAD, fills: tot,
        // The headline: fills the CURRENT gate admitted that a per-side gate would have refused.
        fillsThroughGateBlindSpot: gapped,
        pctThroughBlindSpot: tot ? parseFloat(((gapped / tot) * 100).toFixed(1)) : null,
        cells,
        note: "avgNoSpread >> avgYesSpread on the anomalous bands means the NO ask quoted there had "
          + "nothing resting behind it — an artifact price, not a mispricing. `noWideYesTight` counts "
          + "fills the YES-only gate admitted. Read-only; changes nothing.",
      });
    } catch (e) { return errorResponse(`makerBookAudit failed: ${e?.message}`, 500); }
  }

  // ── ?makerExitCheck=1 — early-exit counterfactual (pre-game only) ────────────────────────────
  if (new URL(request.url).searchParams.get("makerExitCheck") === "1") {
    try {
      const rows = await neonQuery(`
        WITH f AS (
          SELECT mf.id, mf.contracts, mf.pnl_cents, mf.fill_ask, mf.traded_at,
                 q.ticker, q.game_date, q.quote_side,
                 (q.book_yes_ask - q.book_yes_bid) AS entry_spread
            FROM maker_fills mf
            JOIN maker_quotes q ON q.id = mf.quote_id
           WHERE q.source = 'live' AND mf.graded_at IS NOT NULL AND mf.traded_at IS NOT NULL
        )
        SELECT f.id, f.contracts, f.pnl_cents, f.fill_ask, f.entry_spread,
               MIN(CASE WHEN f.quote_side = 'yes' THEN q2.book_yes_ask ELSE q2.book_no_ask END)
                 AS min_ask_after
          FROM f
          LEFT JOIN maker_quotes q2
            ON q2.ticker = f.ticker AND q2.game_date = f.game_date
           AND q2.source = 'live' AND q2.valid_from > f.traded_at
         GROUP BY f.id, f.contracts, f.pnl_cents, f.fill_ask, f.entry_spread`,
        [], env, { write: true });

      const fills = rows.map((r) => ({
        pnlCents: r.pnl_cents == null ? null : Number(r.pnl_cents),
        contracts: Number(r.contracts),
        excursionCents: r.min_ask_after == null ? null : Number(r.fill_ask) - Number(r.min_ask_after),
      }));
      const result = exitCounterfactual({ fills });

      const spreads = rows.map((r) => (r.entry_spread == null ? null : Number(r.entry_spread)))
        .filter((v) => v != null).sort((a, b) => a - b);
      const sp = (p) => (spreads.length ? spreads[Math.floor((p / 100) * spreads.length)] : null);

      console.log(`[shadow-report] makerExitCheck hold=${result.holdPnlPerContract} `
        + `bestDelta=${Math.max(...result.byThreshold.map((t) => t.deltaVsHold ?? -99))}`);
      return jsonResponse({
        ok: true,
        scope: "PRE-GAME exits only — quoting stops at first pitch, so in-play paths are invisible",
        entrySpreadCents: { p25: sp(25), median: sp(50), p75: sp(75), p90: sp(90), n: spreads.length },
        ...result,
      });
    } catch (e) { return errorResponse(`makerExitCheck failed: ${e?.message}`, 500); }
  }

  // ── ?makerCell=sport|category|band — drill into ONE heatmap cell ──────────────────────────────
  // The heatmap tooltip gives a cell's summary; this answers whether the edge is spread across
  // days or concentrated in one. Per day: fills/contracts/sideWon/¢/contract + top tickers.
  // &since=YYYY-MM-DD restricts to game_date >= since — pass the pre-registration's forward-start
  // date to evaluate the out-of-sample leg (see docs/MAKER_F5TOTAL_PREREG.md).
  if (new URL(request.url).searchParams.get("makerCell")) {
    const _mcQs = new URL(request.url).searchParams;
    const spec = _mcQs.get("makerCell");
    const [sport, category, band] = spec.split("|");
    if (!sport || !category || !band) return errorResponse("makerCell must be sport|category|band", 400);
    const _mcSince = /^\d{4}-\d{2}-\d{2}$/.test(_mcQs.get("since") || "") ? _mcQs.get("since") : null;
    try {
      const _bandCase = _makerBandCase("f.fill_ask");
      const _sinceSql = _mcSince ? ` AND q.game_date >= $4` : "";
      const _args = _mcSince ? [sport, category, band, _mcSince] : [sport, category, band];
      const perDay = await _cellPerDaySince(env, sport, category, band, _mcSince);
      const topTickers = await neonQuery(
        `SELECT q.ticker, q.quote_side AS side, COUNT(*)::int AS fills,
           COALESCE(SUM(f.contracts),0)::numeric AS contracts,
           ROUND(COALESCE(SUM(f.pnl_cents*f.contracts),0) / NULLIF(SUM(f.contracts),0), 1) AS pnl_per_ct,
           ROUND(AVG((f.side_won)::int::numeric),2) AS side_won
         FROM maker_fills f JOIN maker_quotes q ON q.id=f.quote_id
         WHERE q.source='live' AND f.graded_at IS NOT NULL
           AND q.sport=$1 AND COALESCE(q.category,q.sport)=$2 AND ${_bandCase}=$3${_sinceSql}
         GROUP BY q.ticker, q.quote_side ORDER BY contracts DESC LIMIT 15`, _args, env, { write: true });
      const days = perDay.map(r => ({
        day: String(r.day).slice(0, 10), fills: Number(r.fills),
        contracts: parseFloat(Number(r.contracts).toFixed(1)),
        perContract: Number(r.contracts) ? parseFloat((Number(r.pnl_total) / Number(r.contracts)).toFixed(2)) : null,
        sideWon: Number(r.contracts) ? parseFloat((Number(r.won_contracts) / Number(r.contracts)).toFixed(3)) : null,
        avgAsk: r.avg_ask != null ? Number(r.avg_ask) : null,
      }));
      const dc = dayClusteredPnl({ days: perDay.map(r => ({ pnl: Number(r.pnl_total), contracts: Number(r.contracts) })) });
      return jsonResponse({
        ok: true, cell: { sport, category, band }, since: _mcSince,
        totals: {
          fills: days.reduce((a, d) => a + d.fills, 0),
          contracts: parseFloat(days.reduce((a, d) => a + d.contracts, 0).toFixed(1)),
          days: days.length,
          perContract: dc?.mean ?? null, ciLo: dc?.loCI ?? null, ciHi: dc?.hiCI ?? null,
          positiveDays: days.filter(d => (d.perContract ?? 0) > 0).length,
        },
        byDay: days,
        topTickers: topTickers.map(r => ({ ticker: r.ticker, side: r.side, fills: Number(r.fills),
          contracts: parseFloat(Number(r.contracts).toFixed(1)),
          perContract: r.pnl_per_ct != null ? Number(r.pnl_per_ct) : null,
          sideWon: r.side_won != null ? Number(r.side_won) : null })),
      });
    } catch (e) { return errorResponse(`makerCell failed: ${e?.message}`, 500); }
  }

  // ── ?makerDay=YYYY-MM-DD — single-day V1 maker attribution ───────────────────────────────────
  // Returns before the report cache read — avoids triggering a full 40s+ regen to answer a
  // one-day question, and can't perturb the 6am cron's cache key.
  const makerDay = new URL(request.url).searchParams.get("makerDay");
  if (makerDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(makerDay)) {
      return errorResponse("Invalid makerDay — expected YYYY-MM-DD", 400);
    }
    try {
      const _dayAgg = (extraSelect, groupBy, orderBy, limit) => `
        SELECT ${extraSelect}
          COALESCE(SUM(f.pnl_cents * f.contracts), 0)::numeric AS pnl_total,
          COALESCE(SUM(f.contracts), 0)::numeric AS contracts,
          COUNT(*) FILTER (WHERE f.graded_at IS NOT NULL)::int AS graded,
          COALESCE(SUM(f.contracts) FILTER (WHERE f.graded_at IS NOT NULL), 0)::numeric AS contracts_graded,
          COALESCE(SUM(f.fill_ask * f.contracts), 0)::numeric AS sum_fill_ask,
          COALESCE(SUM((f.side_won)::int::numeric * f.contracts), 0)::numeric AS sum_side_won
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.game_date = $1 AND q.source = 'live' AND f.graded_at IS NOT NULL
        ${groupBy} ${orderBy} ${limit}`;

      const [mdTotals, mdSport, mdBand, mdTickers, mdCatBand] = await Promise.all([
        neonQuery(_dayAgg("", "", "", ""), [makerDay], env, { write: true }),
        neonQuery(_dayAgg("COALESCE(q.sport,'?') AS sport,", "GROUP BY 1", "ORDER BY 1", ""), [makerDay], env, { write: true }),
        neonQuery(_dayAgg(`${_makerBandCase("f.fill_ask")} AS band,`, "GROUP BY 1", "ORDER BY 1", ""), [makerDay], env, { write: true }),
        neonQuery(`SELECT q.ticker, q.quote_side AS side, COUNT(*)::int AS fills,
            COALESCE(SUM(f.contracts), 0)::numeric AS contracts,
            COALESCE(SUM(f.pnl_cents * f.contracts), 0)::numeric AS pnl_total
          FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
          WHERE q.game_date = $1 AND q.source = 'live' AND f.graded_at IS NOT NULL
          GROUP BY q.ticker, q.quote_side
          ORDER BY contracts DESC LIMIT 20`, [makerDay], env, { write: true }),
        neonQuery(`SELECT COALESCE(q.sport,'?') AS sport, COALESCE(q.category, q.sport, '?') AS category,
            ${_makerBandCase("f.fill_ask")} AS band,
            COUNT(*)::int AS fills,
            COALESCE(SUM(f.contracts), 0)::numeric AS contracts,
            COALESCE(SUM(f.pnl_cents * f.contracts), 0)::numeric AS pnl_total,
            COALESCE(SUM((f.side_won)::int::numeric * f.contracts), 0)::numeric AS won_contracts
          FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
          WHERE q.game_date = $1 AND q.source = 'live' AND f.graded_at IS NOT NULL
          GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [makerDay], env, { write: true }),
      ]);

      const _agg = (row) => {
        const c = Number(row?.contracts_graded || row?.contracts || 0);
        const p = Number(row?.pnl_total || 0);
        const ask = Number(row?.sum_fill_ask || 0);
        const won = Number(row?.sum_side_won || 0);
        return {
          contracts: parseFloat(c.toFixed(1)),
          pnlTotal: parseFloat(p.toFixed(1)),
          perContract: c ? parseFloat((p / c).toFixed(2)) : null,
          weightedAsk: c ? parseFloat((ask / c).toFixed(2)) : null,
          weightedSideWon: c ? parseFloat((won / c).toFixed(4)) : null,
        };
      };

      return jsonResponse({
        ok: true, day: makerDay,
        totals: _agg(mdTotals?.[0]),
        bySport: (mdSport || []).map(r => ({ sport: r.sport, ..._agg(r) })),
        byBand: (mdBand || []).map(r => ({ band: r.band, ..._agg(r) })),
        topTickers: (mdTickers || []).map(r => ({
          ticker: r.ticker, side: r.side, fills: Number(r.fills),
          contracts: parseFloat(Number(r.contracts).toFixed(1)),
          perContract: Number(r.contracts) ? parseFloat((Number(r.pnl_total) / Number(r.contracts)).toFixed(2)) : null,
        })),
        byCategoryBand: (mdCatBand || []).map(r => ({
          sport: r.sport, category: r.category, band: r.band,
          fills: Number(r.fills),
          contracts: parseFloat(Number(r.contracts).toFixed(1)),
          perContract: Number(r.contracts) ? parseFloat((Number(r.pnl_total) / Number(r.contracts)).toFixed(2)) : null,
          sideWon: Number(r.contracts) ? parseFloat((Number(r.won_contracts) / Number(r.contracts)).toFixed(4)) : null,
        })),
      });
    } catch (e) {
      console.error(`[shadow-report] makerDay ${makerDay} failed:`, e?.message);
      return errorResponse("maker day query failed", 500);
    }
  }

  const reportDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const cacheKey = `${REPORT_CACHE_KEY_PREFIX}${reportDate}`;
  const bust = new URL(request.url).searchParams.get("bust") === "1";

  // Serve cached report for non-cron reads (cron always regenerates).
  if (!isCron && !bust) {
    const cached = cache ? await cache.get(cacheKey, "json").catch(() => null) : null;
    if (cached) return jsonResponse(cached);
    const ptHour = Number(new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false,
    })) % 24;
    if (cache && ptHour >= 6) {
      const lockKey = `shadow:report:lock:${reportDate}`;
      const locked = await cache.get(lockKey).catch(() => null);
      if (locked) return jsonResponse({ notYet: true, reportDate, regenerating: true });
      cache.put(lockKey, "1", { expirationTtl: 60 }).catch(() => {});
    } else {
      return jsonResponse({ notYet: true, reportDate });
    }
  }

  const t0 = Date.now();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  // ── Maker board (V1 paper engine + V2 live) ───────────────────────────────────────────────────
  // The main report payload. Only the category × band heatmap (`categoryBands`) is consumed by the
  // frontend; the rest (fills/daily/bands/quotedOutcomes) remains for admin diagnostic use.
  let makerBoard = null;
  try {
    const [[mq], [mf], _qoRows, _mDaily, _mBands, _mCatBandDay, _mCellTickers] = await Promise.all([
      neonQuery(`
        SELECT COUNT(*)::int AS segments, COUNT(DISTINCT ticker)::int AS tickers,
          COUNT(DISTINCT game_date)::int AS days, ROUND(AVG(quote_ask), 1) AS avg_ask
        FROM maker_quotes WHERE game_date >= $1 AND source = 'live'`, [since], env, { write: true }),
      neonQuery(`
        SELECT COUNT(*)::int AS fills, COALESCE(SUM(f.contracts), 0) AS contracts,
          COUNT(*) FILTER (WHERE f.graded_at IS NOT NULL)::int AS graded,
          ROUND(AVG(f.pnl_cents) FILTER (WHERE f.graded_at IS NOT NULL), 2) AS avg_pnl,
          ROUND(STDDEV_SAMP(f.pnl_cents) FILTER (WHERE f.graded_at IS NOT NULL), 2) AS sd_pnl,
          ROUND(AVG((f.side_won)::int::numeric) FILTER (WHERE f.graded_at IS NOT NULL), 4) AS side_won_rate,
          ROUND(AVG(f.fill_ask), 1) AS avg_fill_ask,
          ${weightedPnlSumsSql({ pnlCol: "f.pnl_cents", contractsCol: "f.contracts", filter: "f.graded_at IS NOT NULL" })}
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.game_date >= $1 AND q.source = 'live'`, [since], env, { write: true }),
      // Quoted-outcome counterfactual, aggregated per (band, ticker, side). Every segment counts,
      // bucketed by its own band, so quoted-vs-filled is a within-band comparison (2026-07-26).
      neonQuery(`
        SELECT ${_makerBandCase("quote_ask")} AS band, ticker, quote_side,
          COUNT(*)::int AS segments, COALESCE(SUM(quote_ask), 0)::numeric AS sum_ask
        FROM maker_quotes WHERE game_date >= $1 AND source = 'live'
        GROUP BY 1, ticker, quote_side`, [since], env, { write: true }),
      // Daily fill series — feeds the day-clustered CI.
      neonQuery(`
        SELECT q.game_date AS day, COUNT(*)::int AS fills,
          COALESCE(SUM(f.contracts), 0) AS contracts,
          COALESCE(SUM(f.contracts) FILTER (WHERE f.graded_at IS NOT NULL), 0) AS contracts_graded,
          COUNT(*) FILTER (WHERE f.graded_at IS NOT NULL)::int AS graded,
          COALESCE(SUM(f.pnl_cents * f.contracts) FILTER (WHERE f.graded_at IS NOT NULL), 0) AS pnl_total
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.game_date >= $1 AND q.source = 'live'
        GROUP BY q.game_date ORDER BY q.game_date`, [since], env, { write: true }),
      // Per-ask-band quote/fill economics.
      neonQuery(`
        WITH qb AS (
          SELECT ${_makerBandCase("quote_ask")} AS band,
            COUNT(*)::int AS segments
          FROM maker_quotes WHERE game_date >= $1 AND source = 'live' GROUP BY 1),
        fb AS (
          SELECT ${_makerBandCase("f.fill_ask")} AS band,
            COUNT(*)::int AS fills,
            COUNT(*) FILTER (WHERE f.graded_at IS NOT NULL)::int AS graded,
            ROUND(AVG(f.pnl_cents) FILTER (WHERE f.graded_at IS NOT NULL), 2) AS avg_pnl,
            ROUND(AVG((f.side_won)::int::numeric) FILTER (WHERE f.graded_at IS NOT NULL), 4) AS filled_side_won
          FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
          WHERE q.game_date >= $1 AND q.source = 'live' GROUP BY 1)
        SELECT COALESCE(qb.band, fb.band) AS band, COALESCE(qb.segments, 0) AS segments,
          COALESCE(fb.fills, 0) AS fills, COALESCE(fb.graded, 0) AS graded,
          fb.avg_pnl, fb.filled_side_won
        FROM qb FULL OUTER JOIN fb ON fb.band = qb.band ORDER BY 1`, [since], env, { write: true }),
      // Category × band × day — the diagnostic grain that LOCALIZES anomalies band/total pooling
      // hides (the wrong-side-fill bug was visible as ligamx|teamTotal at +52¢ inside band 55-64).
      // Day is carried so the frontend can flag cells whose whole result came from one slate.
      neonQuery(`
        SELECT COALESCE(q.sport,'?') AS sport, COALESCE(q.category, q.sport, '?') AS category,
          ${_makerBandCase("f.fill_ask")} AS band, q.game_date AS day,
          COUNT(*)::int AS fills,
          COALESCE(SUM(f.contracts), 0)::numeric AS contracts,
          COALESCE(SUM(f.pnl_cents * f.contracts), 0)::numeric AS pnl_total,
          COALESCE(SUM((f.side_won)::int::numeric * f.contracts), 0)::numeric AS won_contracts,
          ROUND(AVG(f.fill_ask), 1) AS avg_fill_ask
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.game_date >= $1 AND q.source = 'live' AND f.graded_at IS NOT NULL
        GROUP BY 1, 2, 3, 4`, [since], env, { write: true }),
      // Distinct GAMES per cell — the effective sample the anomaly detector gates on. Cannot be
      // derived from the per-day rollup above: COUNT(DISTINCT ticker) there is per DAY, and summing
      // it double-counts any ticker quoted across two days.
      neonQuery(`
        SELECT COALESCE(q.sport,'?') AS sport, COALESCE(q.category, q.sport, '?') AS category,
          ${_makerBandCase("f.fill_ask")} AS band, COUNT(DISTINCT q.ticker)::int AS tickers
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.game_date >= $1 AND q.source = 'live' AND f.graded_at IS NOT NULL
        GROUP BY 1, 2, 3`, [since], env, { write: true }),
    ]);

    const graded = Number(mf?.graded || 0);
    const avgPnl = mf?.avg_pnl != null ? Number(mf.avg_pnl) : null;
    const sd = mf?.sd_pnl != null ? Number(mf.sd_pnl) : null;
    // FILL-LEVEL CI — superseded 2026-07-26, renamed 2026-07-28. Treats every fill as independent;
    // fills sharing a day share one slate, so this understates the spread ~5x. Emitted as
    // `pnlLoCI_fillLevel_SUPERSEDED` so it can't be grabbed by autocomplete.
    const _fillLevelPnlLoCI = avgPnl != null && sd != null && graded > 1
      ? parseFloat((avgPnl - 1.96 * sd / Math.sqrt(graded)).toFixed(2)) : null;
    const weightedV1 = weightedPnlFromRow(mf);
    const _v1Daily = (_mDaily || []).map(r => ({
      day: String(r.day).slice(0, 10), fills: Number(r.fills || 0),
      contracts: Number(r.contracts || 0), graded: Number(r.graded || 0),
      contractsGraded: Number(r.contracts_graded || 0),
      pnlTotal: parseFloat(Number(r.pnl_total || 0).toFixed(1)),
    }));
    // Day-clustered CI — the honest interval. Fills sharing a day share game outcomes; the real
    // sample size is days, not fills. Read this before any arm decision.
    const dayClusteredV1 = dayClusteredPnl({
      days: _v1Daily.map(d => ({ pnl: d.pnlTotal, contracts: d.contractsGraded })),
    });

    const _qoTickers = [...new Set(_qoRows.map(r => r.ticker))];
    const _qoSettlements = _qoTickers.length ? await fetchKalshiSettlements(_qoTickers) : new Map();
    const qo = quotedOutcomesByBand(_qoRows.map(r => ({
      band: r.band, ticker: r.ticker, segments: r.segments, sumAsk: r.sum_ask,
      sideWon: resolveTickerSideViaKalshi(r.ticker, r.quote_side, _qoSettlements),
    })));
    const adverseSelection = adverseSelectionWithinBand({
      quotedByBand: qo.byBand,
      filledBands: (_mBands || []).map(r => ({ band: r.band, avgPnl: r.avg_pnl, graded: r.graded })),
      filledEdgeRawCents: avgPnl,
    });

    // Category × band rollup: contract-weighted ¢/ct, side-won, per-cell day-clustered CI, and two
    // integrity signals — top-day concentration (>50% = one slate, not an edge) and anomaly flag
    // (outcome pinned against price, the wrong-side-fill signature). `reliable` = CI clears zero;
    // the heatmap mutes unreliable cells so brightness encodes reliability, not magnitude.
    const _cbCells = new Map();
    for (const r of (_mCatBandDay || [])) {
      const key = `${r.sport}|${r.category}|${r.band}`;
      let cell = _cbCells.get(key);
      if (!cell) { cell = { sport: r.sport, category: r.category, band: r.band,
        fills: 0, contracts: 0, pnl: 0, won: 0, byDay: new Map() }; _cbCells.set(key, cell); }
      const c = Number(r.contracts || 0), p = Number(r.pnl_total || 0), w = Number(r.won_contracts || 0);
      cell.fills += Number(r.fills || 0); cell.contracts += c; cell.pnl += p; cell.won += w;
      const _d = String(r.day).slice(0, 10);
      const dcur = cell.byDay.get(_d) || { pnl: 0, contracts: 0, won: 0 };
      dcur.pnl += p; dcur.contracts += c; dcur.won += w; cell.byDay.set(_d, dcur);
    }
    const _tickerCount = new Map((_mCellTickers || [])
      .map(r => [`${r.sport}|${r.category}|${r.band}`, Number(r.tickers) || 0]));
    const _bandMid = (band) => { const [lo, hi] = String(band).split("-").map(Number);
      return Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : NaN; };
    const _cbBase = [..._cbCells.values()].map(cell => {
      const perContract = cell.contracts ? cell.pnl / cell.contracts : null;
      const sideWon = cell.contracts ? cell.won / cell.contracts : null;
      const dayVals = [...cell.byDay.values()];
      const absTot = dayVals.reduce((a, v) => a + Math.abs(v.pnl), 0);
      const topDayShare = absTot ? Math.max(...dayVals.map(v => Math.abs(v.pnl))) / absTot : null;
      // Per-cell day-clustered CI. `reliable` requires >=3 days for the interval to be estimable.
      const _dc = dayClusteredPnl({ days: dayVals });
      const ciLo = _dc?.loCI ?? null, ciHi = _dc?.hiCI ?? null;
      const reliable = ciLo != null && ciLo > 0 && cell.byDay.size >= 3;
      return { sport: cell.sport, category: cell.category, band: cell.band,
        fills: cell.fills, contracts: parseFloat(cell.contracts.toFixed(1)),
        perContract: perContract != null ? parseFloat(perContract.toFixed(2)) : null,
        sideWon: sideWon != null ? parseFloat(sideWon.toFixed(4)) : null,
        days: cell.byDay.size, ciLo, ciHi, reliable,
        tickers: _tickerCount.get(`${cell.sport}|${cell.category}|${cell.band}`) ?? null,
        topDayShare: topDayShare != null ? parseFloat(topDayShare.toFixed(2)) : null,
        _mid: _bandMid(cell.band), _byDay: dayVals };
    });
    // Anomaly needs the whole LADDER, not one cell, so it runs as a second pass grouped by
    // sport|category (api/lib/maker-stats.js `ladderAnomalies`). The old inline test asked whether a
    // cell's outcome was pinned against its PRICE — the exact null the band-ladder artifact falsifies,
    // which made it fire on the ends of steep ladders (6/6 false positives on 2026-08-11) while being
    // structurally unable to see an INVERTED cell, the actual wrong-side-fill signature.
    const _byCat = new Map();
    for (const c of _cbBase) {
      const k = `${c.sport}|${c.category}`;
      if (!_byCat.has(k)) _byCat.set(k, []);
      _byCat.get(k).push({ band: c.band, mid: c._mid, fills: c.fills, contracts: c.contracts,
        tickers: c.tickers, sideWon: c.sideWon, byDay: c._byDay });
    }
    const _anom = new Map();
    for (const [k, cells] of _byCat) {
      try { for (const [band, v] of ladderAnomalies(cells)) _anom.set(`${k}|${band}`, v); }
      catch { /* failure-closed: an unscored ladder leaves its cells unflagged, never throws */ }
    }
    const _categoryBands = _cbBase.map(c => {
      const a = _anom.get(`${c.sport}|${c.category}|${c.band}`);
      const { _mid, _byDay, ...rest } = c;
      return { ...rest, anomaly: a?.anomaly === true, anomalyReason: a?.anomalyReason ?? null,
        ladderFitted: a?.fitted ?? null, ladderResidual: a?.residual ?? null };
    }).sort((a, b) => b.contracts - a.contracts);

    makerBoard = {
      quotes: { segments: Number(mq?.segments || 0), tickers: Number(mq?.tickers || 0),
        days: Number(mq?.days || 0), avgAsk: mq?.avg_ask != null ? Number(mq.avg_ask) : null },
      fills: { n: Number(mf?.fills || 0), contracts: Number(mf?.contracts || 0), graded,
        avgPnlCents: avgPnl, pnlLoCI_fillLevel_SUPERSEDED: _fillLevelPnlLoCI,
        sideWonRate: mf?.side_won_rate != null ? Number(mf.side_won_rate) : null,
        avgFillAsk: mf?.avg_fill_ask != null ? Number(mf.avg_fill_ask) : null,
        weighted: weightedV1,
        dayClustered: dayClusteredV1 },
      quotedOutcomes: qo,
      adverseSelection,
      armCriterion: {
        minFills: 200, need: "pnlLoCI_fillLevel_SUPERSEDED > 0 (historical, NOT sufficient)",
        minDays: 14, needClustered: "dayClustered.loCI > 0",
        met: graded >= 200
          && (dayClusteredV1?.days || 0) >= 14
          && dayClusteredV1?.loCI != null && dayClusteredV1.loCI > 0,
      },
      armed: false,
      daily: _v1Daily,
      bands: (_mBands || []).map(r => ({
        band: r.band, segments: Number(r.segments || 0), fills: Number(r.fills || 0),
        graded: Number(r.graded || 0),
        avgPnl: r.avg_pnl != null ? Number(r.avg_pnl) : null,
        filledSideWon: r.filled_side_won != null ? Number(r.filled_side_won) : null,
      })),
      categoryBands: _categoryBands,
    };
  } catch (e) { console.error("[shadow-report] maker board skipped:", e?.message); }

  // V2 live board — separate try/catch so a missing maker_orders_v2 table doesn't take down V1.
  if (makerBoard) {
    makerBoard.live = { orders: 0, resting: 0, executed: 0, graded: 0, avgPnlCents: null,
      pnlLoCI_fillLevel_SUPERSEDED: null,
      weighted: weightedPnlFromRow(null), armed: false, daily: [] };
    try {
      const [[lo], armedNow, _mLiveDaily] = await Promise.all([
        neonQuery(`
          SELECT COUNT(*)::int AS orders,
            COUNT(*) FILTER (WHERE status = 'resting')::int AS resting,
            COUNT(*) FILTER (WHERE status = 'executed')::int AS executed,
            COUNT(*) FILTER (WHERE graded_at IS NOT NULL)::int AS graded,
            ROUND(AVG(pnl_cents) FILTER (WHERE graded_at IS NOT NULL), 2) AS avg_pnl,
            ROUND(STDDEV_SAMP(pnl_cents) FILTER (WHERE graded_at IS NOT NULL), 2) AS sd_pnl,
            ${weightedPnlSumsSql({ pnlCol: "pnl_cents", contractsCol: "size", filter: "graded_at IS NOT NULL" })}
          FROM maker_orders_v2 WHERE game_date >= $1`, [since], env, { write: true }),
        isMakerV2Armed(env, cache).catch(() => false),
        neonQuery(`
          SELECT game_date AS day, COUNT(*)::int AS fills,
            COALESCE(SUM(size), 0) AS contracts,
            COALESCE(SUM(size) FILTER (WHERE graded_at IS NOT NULL), 0) AS contracts_graded,
            COUNT(*) FILTER (WHERE graded_at IS NOT NULL)::int AS graded,
            COALESCE(SUM(pnl_cents * size) FILTER (WHERE graded_at IS NOT NULL), 0) AS pnl_total
          FROM maker_orders_v2 WHERE game_date >= $1 AND status = 'executed'
          GROUP BY game_date ORDER BY game_date`, [since], env, { write: true }),
      ]);
      const gradedV2 = Number(lo?.graded || 0);
      const avgPnlV2 = lo?.avg_pnl != null ? Number(lo.avg_pnl) : null;
      const sdV2 = lo?.sd_pnl != null ? Number(lo.sd_pnl) : null;
      const _fillLevelPnlLoCIV2 = avgPnlV2 != null && sdV2 != null && gradedV2 > 1
        ? parseFloat((avgPnlV2 - 1.96 * sdV2 / Math.sqrt(gradedV2)).toFixed(2)) : null;
      const _v2Daily = (_mLiveDaily || []).map(r => ({
        day: String(r.day).slice(0, 10), fills: Number(r.fills || 0),
        contracts: Number(r.contracts || 0), graded: Number(r.graded || 0),
        contractsGraded: Number(r.contracts_graded || 0),
        pnlTotal: parseFloat(Number(r.pnl_total || 0).toFixed(1)),
      }));
      const _v2DayClustered = dayClusteredPnl({
        days: _v2Daily.map(d => ({ pnl: d.pnlTotal, contracts: d.contractsGraded })),
      });
      makerBoard.live = {
        orders: Number(lo?.orders || 0), resting: Number(lo?.resting || 0),
        executed: Number(lo?.executed || 0), graded: gradedV2,
        avgPnlCents: avgPnlV2, pnlLoCI_fillLevel_SUPERSEDED: _fillLevelPnlLoCIV2, armed: !!armedNow,
        weighted: weightedPnlFromRow(lo),
        dayClustered: _v2DayClustered,
        daily: _v2Daily,
      };
    } catch (e) { console.error("[shadow-report] maker live board skipped (likely never armed):", e?.message); }

    // V1 vs V2 cross-check: two independent measurements of the same [80,84] band. A persistent
    // gap here is an instrument bug, not two populations — the wrong-side fill bug was visible as
    // this exact disagreement for days before it was identified.
    const _band8084 = (makerBoard.bands || []).find(b => b.band === "80-84");
    const _v1_8084 = _band8084?.avgPnl ?? null;
    const _v2Mean = makerBoard.live?.weighted?.mean ?? null;
    makerBoard.crossChecks = [{
      key: "v1v2",
      label: "V1 paper vs V2 real · same [80,84] band",
      a: { name: "V1 sim", cents: _v1_8084 },
      b: { name: "V2 real", cents: _v2Mean },
      deltaCents: (_v1_8084 != null && _v2Mean != null) ? parseFloat((_v1_8084 - _v2Mean).toFixed(2)) : null,
      flagCents: 3,
      flag: (_v1_8084 != null && _v2Mean != null) && Math.abs(_v1_8084 - _v2Mean) >= 3,
      note: "should agree on the shared band; a gap is an instrument bug, not two populations",
    }];
  }

  // ── Pre-registered forward tests ────────────────────────────────────────────────────────────
  // The only doctrine-sanctioned "when will we know" surface: a calendar checkpoint on a cell whose
  // bar was fixed before its forward window opened (see maker-prereg.js). Evaluated over the forward
  // window (game_date >= forwardStart) with the SAME day-clustered interval the heatmap uses, so the
  // result matches ?makerCell=<cell>&since=<forwardStart>. Separate try/catch — a prereg failure must
  // not take down the report. One grouped query per registered cell (a handful at most).
  let preregistrations = [];
  try {
    preregistrations = await Promise.all(PREREG_CELLS.map(async (spec) => {
      const perDay = await _cellPerDaySince(env, spec.sport, spec.category, spec.band, spec.forwardStart);
      const dayRows = perDay.map(r => ({ pnl: Number(r.pnl_total), contracts: Number(r.contracts) }));
      const dc = dayClusteredPnl({ days: dayRows });
      const totContracts = dayRows.reduce((a, d) => a + d.contracts, 0);
      const totWon = perDay.reduce((a, r) => a + Number(r.won_contracts), 0);
      const totFills = perDay.reduce((a, r) => a + Number(r.fills), 0);
      const positiveDays = perDay.filter(r => Number(r.contracts) && Number(r.pnl_total) / Number(r.contracts) > 0).length;
      const result = {
        days: perDay.length, fills: totFills, contracts: parseFloat(totContracts.toFixed(1)),
        mean: dc?.mean ?? null, ciLo: dc?.loCI ?? null, ciHi: dc?.hiCI ?? null,
        positiveDays, sideWon: totContracts ? parseFloat((totWon / totContracts).toFixed(4)) : null,
      };
      const evaluated = evaluatePrereg(spec, result, reportDate);
      return { id: spec.id, label: spec.label, sport: spec.sport, category: spec.category,
        band: spec.band, doc: spec.doc, hypothesis: spec.hypothesis,
        forwardStart: spec.forwardStart, checkpoint: spec.checkpoint, result, ...evaluated };
    }));
  } catch (e) { console.error("[shadow-report] preregistrations skipped:", e?.message); }

  // ── Data freshness — is the heatmap current through last night? ─────────────────────────────
  // The morning report asserts the maker board reflects last night's resolved games. Grading
  // (nightly tape replay → gradeMakerFills) can stall on Kalshi rate limits and only grades at the
  // END of the ticker walk, so "fills detected but not graded" is a real failure mode — this is its
  // tripwire, and it distinguishes that case from "nothing ran at all".
  let dataFreshness = null;
  try {
    const expectedThrough = new Date(Date.parse(`${reportDate}T00:00:00Z`) - 86400000)
      .toISOString().slice(0, 10); // yesterday, PT
    const [[mf], [sp]] = await Promise.all([
      neonQuery(`
        SELECT MAX(q.game_date) FILTER (WHERE f.graded_at IS NOT NULL) AS latest_graded,
               MAX(q.game_date) AS latest_fill,
               COUNT(*) FILTER (WHERE f.graded_at IS NULL)::int AS ungraded
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.source = 'live'`, [], env, { write: true }),
      neonQuery(`SELECT MAX(snapshot_date) AS latest_resolved FROM shadow_plays WHERE won IS NOT NULL`,
        [], env, { write: true }),
    ]);
    const _d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
    const latestGraded = _d(mf?.latest_graded), latestFill = _d(mf?.latest_fill);
    const current = latestGraded != null && latestGraded >= expectedThrough;
    const daysBehind = latestGraded
      ? Math.round((Date.parse(`${expectedThrough}T00:00:00Z`) - Date.parse(`${latestGraded}T00:00:00Z`)) / 86400000)
      : null;
    // Quote-pass telemetry for the day in question (api/lib/maker.js). Read BEFORE composing
    // `diagnosis`, because without it the no-fills branch has to name three possible causes it
    // cannot distinguish — which is exactly how 2026-08-12 stayed unexplained. Absent (key expired,
    // or a cache with no hgetall) → the old wording, which is still the honest answer then.
    const qp = cache?.hgetall
      ? await cache.hgetall(`${QUOTEPASS_KEY_PREFIX}${expectedThrough}`).catch(() => null)
      : null;
    const _n = (v) => (v == null ? null : Number(v));
    const quotePass = qp ? {
      cycles: _n(qp.cycles) || 0, ran: _n(qp.ran) || 0,
      skippedNoStaging: _n(qp.skippedNoStaging) || 0, skippedNoSnaps: _n(qp.skippedNoSnaps) || 0,
      errors: _n(qp.errors) || 0,
      avgEligible: _n(qp.ran) > 0 ? Math.round((_n(qp.sumEligible) || 0) / _n(qp.ran)) : null,
      sumOpened: _n(qp.sumOpened) || 0, sumClosed: _n(qp.sumClosed) || 0,
      lastAt: qp.lastAt ?? null, lastOutcome: qp.lastOutcome ?? null,
      lastStagingPlays: _n(qp.lastStagingPlays), lastStagingTickers: _n(qp.lastStagingTickers),
      lastError: qp.lastError ?? null,
    } : null;

    let diagnosis = current ? "current"
      : (latestFill != null && latestFill >= expectedThrough)
        ? "fills detected but NOT graded — grading stalled (Kalshi rate-limit; tape walk didn't reach end)"
        : "no fills for last night — tape replay or quoting did not run";
    // Name the actual branch when the telemetry can. Ordered most-specific first; each string
    // points at ONE subsystem, so it can be acted on without re-deriving the cause by hand.
    if (!current && quotePass && latestFill != null && latestFill < expectedThrough) {
      if (quotePass.cycles === 0) {
        diagnosis = "no quote-pass cycles ran — the kalshi-snapshot cron did not fire";
      } else if (quotePass.skippedNoStaging >= quotePass.cycles * 0.5) {
        diagnosis = `quoting skipped ${quotePass.skippedNoStaging}/${quotePass.cycles} cycles for missing shadow:staging — the tonight cron did not write it`;
      } else if (quotePass.skippedNoSnaps >= quotePass.cycles * 0.5) {
        diagnosis = `quoting skipped ${quotePass.skippedNoSnaps}/${quotePass.cycles} cycles for empty snaps — every Kalshi series fetch failed`;
      } else if (quotePass.errors >= quotePass.cycles * 0.5) {
        diagnosis = `quote pass threw on ${quotePass.errors}/${quotePass.cycles} cycles — last: ${quotePass.lastError || "unknown"}`;
      } else if (quotePass.ran > 0 && quotePass.avgEligible === 0) {
        diagnosis = `quote pass ran ${quotePass.ran} cycles but nothing was ever eligible — staging carried ${quotePass.lastStagingTickers ?? "?"} tickers`;
      } else if (quotePass.ran > 0) {
        diagnosis = `quote pass ran ${quotePass.ran}/${quotePass.cycles} cycles at avg ${quotePass.avgEligible} eligible — quoting worked; the tape replay found no fills`;
      }
    }
    dataFreshness = {
      expectedThrough, latestGradedMakerDay: latestGraded, latestMakerFillDay: latestFill,
      ungradedFills: Number(mf?.ungraded || 0), latestResolvedShadowDay: _d(sp?.latest_resolved),
      makerTableCurrent: current, daysBehind, diagnosis, quotePass,
    };
  } catch (e) { console.error("[shadow-report] dataFreshness skipped:", e?.message); }

  // ── Discovery — series-scan pipeline state + candidates to VET ──────────────────────────────
  // The morning report's forward-looking section. The nightly series scan runs 15 min before this
  // report (crons 12:45 vs 13:00 UTC), so the state is same-morning fresh. Framed as candidates to
  // VET, never build: the liquidity screen proves a real BOOK, not that a series is buildable — the
  // GAME-suffix-vs-futures split, the ESPN slug, and the team-abbr cross-check are human vetting the
  // screen can't do (the KXUCLGAME deferral is the cautionary case).
  let discovery = null;
  try {
    const [counts, toVet, [act]] = await Promise.all([
      neonQuery(`SELECT status, COUNT(*)::int AS n FROM kalshi_series_seen GROUP BY status`, [], env, { write: true }),
      neonQuery(`
        SELECT ticker, title, live_market_count, screen, median_spread_c, overround,
               real_book_count, first_seen
        FROM kalshi_series_seen
        WHERE status IN ('new','shortlisted') AND screen = 'REAL_BOOK'
        ORDER BY real_book_count DESC NULLS LAST, live_market_count DESC NULLS LAST
        LIMIT 25`, [], env, { write: true }),
      neonQuery(`SELECT COUNT(*)::int AS n FROM kalshi_series_seen
                 WHERE dismissed_by = 'screen' AND screened_at = $1`, [reportDate], env, { write: true }),
    ]);
    // The bare-prefix trap: a per-game market carries a game/segment token; a bare league/tournament
    // prefix is a season outright (futures), NOT a buildable per-game category.
    const _perGame = (t) => /(GAME|MATCH|SPREAD|TOTAL|BTTS|MONEYLINE|\dH|\dQ|WINNER)/.test(t || "");
    discovery = {
      venue: "kalshi", // every kalshi_series_seen row is a Kalshi KX* series — the scan is Kalshi-only
      counts: Object.fromEntries(counts.map(r => [r.status, r.n])),
      autoDismissedToday: Number(act?.n || 0),
      toVet: toVet.map(r => ({
        ticker: r.ticker, title: r.title,
        markets: r.live_market_count != null ? Number(r.live_market_count) : null,
        realBooks: r.real_book_count != null ? Number(r.real_book_count) : null,
        medianSpreadC: r.median_spread_c != null ? Number(r.median_spread_c) : null,
        overround: r.overround != null ? Number(r.overround) : null,
        firstSeen: r.first_seen ? new Date(r.first_seen).toISOString().slice(0, 10) : null,
        perGame: _perGame(r.ticker), // false ⇒ likely season futures, not a per-game category
      })),
      polymarket: null, // filled below (own try/catch — a missing poly table must not blank this list)
      note: "venue=kalshi (Kalshi KX* series scan). screen=REAL_BOOK ⇒ real book, NOT buildable — vet GAME-suffix (perGame:false = futures), ESPN slug, team abbrs before building. Cross-venue Poly presence is league-level only (see .polymarket) — Gamma slugs (argcopa, bel1) share no key with Kalshi tickers, so a per-candidate poly flag is manual.",
    };
    // Polymarket discovery lane — a SEPARATE surface (polymarket_sports_seen), per-LEAGUE not
    // per-market-family, so it can't be joined to the Kalshi candidates per-row. Own try/catch: a
    // missing/empty poly table (scan never ran) must not blank the Kalshi discovery above.
    try {
      const [polyCounts, polyToVet] = await Promise.all([
        neonQuery(`SELECT status, COUNT(*)::int AS n FROM polymarket_sports_seen GROUP BY status`, [], env, { write: true }),
        neonQuery(`
          SELECT sport, market_types, sample_event, live_event_count, first_seen
          FROM polymarket_sports_seen
          WHERE status IN ('new','shortlisted')
          ORDER BY live_event_count DESC NULLS LAST
          LIMIT 25`, [], env, { write: true }),
      ]);
      discovery.polymarket = {
        counts: Object.fromEntries(polyCounts.map(r => [r.status, r.n])),
        toVet: polyToVet.map(r => ({
          sport: r.sport,
          marketTypes: r.market_types || null,
          sampleEvent: r.sample_event || null,
          liveEvents: r.live_event_count != null ? Number(r.live_event_count) : null,
          firstSeen: r.first_seen ? new Date(r.first_seen).toISOString().slice(0, 10) : null,
        })),
        note: "Polymarket discovery is per-LEAGUE (Gamma sport slug), not per-market-family; marketTypes lists the families live per league. Active cross-venue CAPTURE is mlb/nba/nhl/wnba only. A Kalshi candidate whose league ALSO appears here with the matching family extends cross-venue vig coverage (venueVig).",
      };
    } catch (e) { console.error("[shadow-report] poly discovery skipped:", e?.message); }
  } catch (e) { console.error("[shadow-report] discovery skipped:", e?.message); }

  // ── Cross-venue vig (Kalshi vs Polymarket) — the [Kalshi|Poly|Δ] heatmap toggle's data ───────
  // Own try/catch, failure-closed. Kalshi vig from graded model-free shadow_plays (works day one);
  // Poly vig from graded polymarket_plays (fills in as rows resolve, ~1 day after capture). Both use
  // the graded SIDE's own ask + whether that side won, bucketed by _makerBandCase so the two align.
  let venueVig = null;
  try {
    const [_kVig, _pVig] = await Promise.all([
      neonQuery(`
        SELECT sport, category, ${_makerBandCase("ask")} AS band,
          COUNT(*)::int AS n, COUNT(DISTINCT game_date)::int AS days,
          ROUND(AVG(ask), 1) AS avg_ask, ROUND(AVG((won)::int::numeric) * 100, 1) AS win_pct
        FROM (
          SELECT sport, game_date, won,
            (CASE WHEN kalshi_side = 'no' THEN no_kalshi_pct ELSE kalshi_pct END) AS ask,
            (${_kalshiCatCaseSql}) AS category
          FROM shadow_plays
          WHERE won IS NOT NULL AND model_free = TRUE AND kalshi_ticker IS NOT NULL
            AND game_date >= $1 AND (${_kalshiTickerFilterSql})
        ) s
        WHERE ask IS NOT NULL AND category IS NOT NULL
        GROUP BY sport, category, ${_makerBandCase("ask")}`, [since], env, { write: true }),
      neonQuery(`
        SELECT sport, category, ${_makerBandCase("ask_c")} AS band,
          COUNT(*)::int AS n, COUNT(DISTINCT game_date)::int AS days,
          ROUND(AVG(ask_c), 1) AS avg_ask, ROUND(AVG((won)::int::numeric) * 100, 1) AS win_pct
        FROM polymarket_plays
        WHERE won IS NOT NULL AND ask_c IS NOT NULL AND category IN (${_venueVigCategoriesSql})
          AND COALESCE(game_date, snapshot_date::varchar) >= $1
        GROUP BY sport, category, ${_makerBandCase("ask_c")}`, [since], env, { write: true }),
    ]);
    venueVig = computeVenueVig(_kVig, _pVig);
  } catch (e) { console.error("[shadow-report] venueVig skipped:", e?.message); }

  // ── Polymarket tracking — capture+resolve health for the morning report (not read by the UI) ──
  // Own try/catch, failure-closed. Two cheap aggregates over polymarket_plays + the venueVig summary.
  let polymarketTracking = null;
  try {
    const [_agg, _recent] = await Promise.all([
      neonQuery(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE won IS NOT NULL)::int AS graded,
        COUNT(*) FILTER (WHERE resolved AND won IS NULL)::int AS voided,
        COUNT(*) FILTER (WHERE NOT resolved)::int AS pending,
        COUNT(DISTINCT snapshot_date)::int AS capture_days,
        MAX(snapshot_date)::text AS last_capture
        FROM polymarket_plays`, [], env, { write: true }),
      neonQuery(`SELECT sport, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE won IS NOT NULL)::int AS graded
        FROM polymarket_plays WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM polymarket_plays)
        GROUP BY 1 ORDER BY 2 DESC`, [], env, { write: true }),
    ]);
    polymarketTracking = computePolymarketTracking({ agg: _agg[0] || {}, recentBySport: _recent, venueVig });
  } catch (e) { console.error("[shadow-report] polymarketTracking skipped:", e?.message); }

  // ── UI health — the landing page's rendered payload is present + complete ────────────────────
  // MakerBoardPage draws exactly two things: PreregTracker(preregistrations) and
  // CategoryBandHeatmap(makerBoard.categoryBands). This asserts BOTH against the fields those
  // components actually read. dataFreshness answers "is the data current?"; this answers "will the
  // page render?" — orthogonal, because an on-time report can still ship an empty/degenerate
  // categoryBands (blank board) or a cell missing a render field (blank/NaN square). Pure, computed
  // from the in-memory payload above, so it can never disagree with what ships. Failure-closed by
  // construction — every guard handles null.
  const uiHealth = computeUiHealth(makerBoard, preregistrations);

  // Robust-candidate tripwire (morning report only) — a strict structural bar over categoryBands,
  // expected NONE. A hit is a prompt for a mechanism-first pre-registration, never a bet. Pure,
  // computed from the in-memory payload so it can't disagree with the heatmap that shipped.
  const robustCandidates = computeRobustCandidates(makerBoard);

  const report = { reportDate, generatedAt: new Date().toISOString(), since, makerBoard,
    preregistrations, dataFreshness, discovery, uiHealth, robustCandidates, venueVig, polymarketTracking, durationMs: Date.now() - t0 };

  if (cache) cache.put(cacheKey, JSON.stringify(report), { expirationTtl: REPORT_TTL }).catch(() => {});
  return jsonResponse(report);
}

export { handleShadowReport, computeRobustCandidates, ROBUST_BAR, ROBUST_ONE_SIDED_RATE };
