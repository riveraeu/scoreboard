// api/lib/handlers/shadow/report.js
// GET /api/shadow-report — Shadow maker board: category × band heatmap + diagnostic branches.
//
// What was removed (2026-07-30): the morning brief, model accuracy board, betting board,
// polymarket/sportsbook validation, dataHealth, topPicks, categories, topBands, clv, perGameRoi.
// None of those were consumed by the frontend after the MakerBoardPage strip (2026-07-29).
// Response shape: { reportDate, generatedAt, since, makerBoard, preregistrations, dataFreshness,
// discovery, uiHealth, durationMs }. `makerBoard` is the only field the UI reads; `preregistrations`,
// `dataFreshness`, `discovery`, and `uiHealth` are consumed by the (non-UI) morning report that pulls
// this endpoint — dataFreshness asserts the heatmap is current through last night, discovery is the
// series-scan vet queue, uiHealth asserts the landing page's rendered payload is present + complete
// (a "current" dataFreshness with an empty/degenerate categoryBands still renders a BLANK board —
// only uiHealth catches that).
//
// Diagnostic branches still live (all return before the report cache and accept ADMIN_KEY):
//   ?makerQueueCheck=1       V1-vs-V2 fill agreement (queue-priority calibration)
//   ?makerCell=sport|cat|band  drill into one heatmap cell by day
//   ?makerTapeProbe=YYYY-MM-DD  is V1's tape page actually covering the day?
//   ?makerFillForensic=YYYY-MM-DD  why did V1 miss a real V2 fill?
//   ?makerSideAudit=YYYY-MM-DD  establish taker_side ↔ quote_side from ground truth
//   ?makerExitCheck=1        early-exit counterfactual (pre-game only)
//   ?makerLeadTime=1         pre-registered lead-time test
//   ?makerDay=YYYY-MM-DD     single-day V1 attribution (bySport/byBand/byCategoryBand)

import { neonQuery } from "../../neon.js";
import { errorResponse, jsonResponse } from "../../utils.js";
import { verifyJWT } from "../../auth-utils.js";
import { isArmed as isMakerV2Armed } from "../../maker-live.js";
import { fetchKalshiSettlements, resolveTickerSideViaKalshi } from "../../kalshi-settlement.js";
import { PREREG_CELLS, evaluatePrereg } from "../../maker-prereg.js";
import { weightedPnlSumsSql, weightedPnlFromRow, dayClusteredPnl, quotedOutcomesByBand,
  adverseSelectionWithinBand, leadTimeBuckets, spearmanEdgeVsLead, mixAdjustedNearFarByDay,
  dayLevelDiffCI, leadTimeVerdict, exitCounterfactual } from "../../maker-stats.js";

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

  // ── ?makerQueueCheck=1 — V1-vs-V2 fill agreement, the queue-priority calibration ──────────────
  // V1 is a COUNTERFACTUAL simulator: it never places an order, then asserts a fill whenever a
  // taker traded at `px >= our ask` inside a segment window (`replayFills`). That assertion rests
  // on "we quote 1¢ inside, so price priority is ours" — true at the instant of quoting, and
  // unverifiable afterwards, because V1 records only top-of-book and samples every 2 minutes. A
  // competitor can improve, absorb the flow and revert between ticks, and V1 would still credit us.
  //
  // V2's 3 live days are the only ground truth that exists: real resting orders, same engine, same
  // eligibility logic (`computeMakerQuote` with MAKER_V2_BAND). Joining them gives a 2x2 —
  // per V2 order, did V1 predict a fill over the same ticker/side/window?
  //
  //   both filled           → V1 agrees with reality
  //   V2 filled, V1 did not → V1 is CONSERVATIVE (under-counts fills)
  //   V1 filled, V2 did not → V1 is OPTIMISTIC — the queue-priority assumption failing
  //   neither               → agrees
  if (new URL(request.url).searchParams.get("makerQueueCheck") === "1") {
    try {
      const rows = await neonQuery(`
        SELECT o.id, o.ticker, o.side, o.price, o.size, o.filled_count, o.status, o.game_date,
               COUNT(q.id)::int                          AS v1_segments,
               COALESCE(MAX(q.quote_ask), 0)::int        AS v1_ask,
               COALESCE(SUM(fq.c), 0)::numeric           AS v1_contracts
          FROM maker_orders_v2 o
          LEFT JOIN maker_quotes q
            ON q.ticker = o.ticker
           AND q.source = 'live'
           AND q.quote_side = o.side
           AND q.valid_from < COALESCE(o.canceled_at, o.expires_at, NOW())
           AND COALESCE(q.valid_to, NOW()) > o.placed_at
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(f.contracts), 0) AS c
              FROM maker_fills f
             WHERE f.quote_id = q.id
               AND f.traded_at >= o.placed_at
               AND f.traded_at <  COALESCE(o.canceled_at, o.expires_at, NOW())
          ) fq ON TRUE
         GROUP BY o.id, o.ticker, o.side, o.price, o.size, o.filled_count, o.status, o.game_date`,
        [], env, { write: true });

      const cell = { bothFilled: 0, v2Only: 0, v1Only: 0, neither: 0 };
      let noSegment = 0, priceMatch = 0, priceRows = 0, sumPriceDiff = 0;
      const byDay = new Map();
      const v1OnlySamples = [];
      for (const r of rows) {
        const v2f = Number(r.filled_count) > 0;
        const v1f = Number(r.v1_contracts) > 0;
        if (!r.v1_segments) noSegment++;
        const k = v2f && v1f ? "bothFilled" : v2f ? "v2Only" : v1f ? "v1Only" : "neither";
        cell[k]++;
        if (k === "v1Only" && v1OnlySamples.length < 10) {
          v1OnlySamples.push({ ticker: r.ticker, side: r.side, v2Price: r.price,
            v1Ask: r.v1_ask, v1Contracts: Number(r.v1_contracts), segments: r.v1_segments });
        }
        const day = String(r.game_date).slice(0, 10);
        const d = byDay.get(day) || { bothFilled: 0, v2Only: 0, v1Only: 0, neither: 0 };
        d[k]++; byDay.set(day, d);
        if (r.v1_ask && r.price) {
          priceRows++;
          sumPriceDiff += Math.abs(Number(r.v1_ask) - Number(r.price));
          if (Number(r.v1_ask) === Number(r.price)) priceMatch++;
        }
      }
      const n = rows.length;
      return jsonResponse({
        ok: true,
        n, noSegment,
        cell,
        rates: n ? {
          bothFilled: +(cell.bothFilled / n * 100).toFixed(1),
          v2Only: +(cell.v2Only / n * 100).toFixed(1),
          v1Only: +(cell.v1Only / n * 100).toFixed(1),
          neither: +(cell.neither / n * 100).toFixed(1),
        } : null,
        priceAgreement: priceRows
          ? { exact: priceMatch, rows: priceRows, exactPct: +(priceMatch / priceRows * 100).toFixed(1),
              meanAbsDiffC: +(sumPriceDiff / priceRows).toFixed(2) }
          : null,
        byDay: [...byDay.entries()].sort().map(([day, v]) => ({ day, ...v })),
        v1OnlySamples,
      });
    } catch (e) { return errorResponse(`makerQueueCheck failed: ${e?.message}`, 500); }
  }

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

  // ── ?makerLeadTime=1 — the pre-registered lead-time test ──────────────────────────────────────
  // Decision rule fixed in docs/MAKER_LEADTIME_PREREG.md BEFORE this code was written.
  // source='live' only: replayed segments are excluded.
  if (new URL(request.url).searchParams.get("makerLeadTime") === "1") {
    try {
      const rows = await neonQuery(`
        SELECT q.game_date AS day,
               ${_makerBandCase("f.fill_ask")} AS band,
               CASE
                 WHEN lead_h < 1  THEN '0-1h'
                 WHEN lead_h < 3  THEN '1-3h'
                 WHEN lead_h < 6  THEN '3-6h'
                 WHEN lead_h < 12 THEN '6-12h'
                 ELSE '12h+' END AS bucket,
               COUNT(*)::int AS fills,
               COALESCE(SUM(f.contracts), 0) AS contracts,
               COALESCE(SUM(f.fill_ask * f.contracts), 0) AS sum_ask_ctr,
               COALESCE(SUM((f.side_won)::int::numeric * f.contracts), 0) AS sum_won_ctr
          FROM maker_fills f
          JOIN maker_quotes q ON q.id = f.quote_id
          CROSS JOIN LATERAL (
            SELECT EXTRACT(EPOCH FROM (q.game_time - f.traded_at)) / 3600 AS lead_h) l
         WHERE q.source = 'live'
           AND f.graded_at IS NOT NULL
           AND q.game_time IS NOT NULL
           AND f.traded_at IS NOT NULL
           AND lead_h >= 0
         GROUP BY 1, 2, 3`, [], env, { write: true });

      const buckets = leadTimeBuckets(rows);
      const spearman = spearmanEdgeVsLead(buckets);
      const { days, weights } = mixAdjustedNearFarByDay(rows);
      const ci = dayLevelDiffCI(days);
      const verdict = leadTimeVerdict({ ci, days, spearman });

      const armEdge = (pred) => {
        let c = 0, ask = 0, won = 0;
        for (const r of rows) {
          if (!pred(r.bucket)) continue;
          c += Number(r.contracts); ask += Number(r.sum_ask_ctr); won += Number(r.sum_won_ctr);
        }
        return c > 0 ? Math.round(((ask - 100 * won) / c) * 100) / 100 : null;
      };
      const near = armEdge((b) => b === "0-1h" || b === "1-3h");
      const far = armEdge((b) => b === "6-12h" || b === "12h+");

      console.log(`[shadow-report] makerLeadTime verdict=${verdict.verdict} ci=[${ci.loCI},${ci.hiCI}] `
        + `rho=${spearman} signs=${verdict.signPositive}/${verdict.totalDays}`);
      return jsonResponse({
        ok: true,
        preregistration: "docs/MAKER_LEADTIME_PREREG.md",
        buckets,
        spearman,
        dailyDiff: days,
        bandWeights: weights,
        dayClusteredDiff: ci,
        unadjusted: { nearEdgeCents: near, farEdgeCents: far, diffCents: near != null && far != null ? Math.round((near - far) * 100) / 100 : null },
        verdict,
      });
    } catch (e) { return errorResponse(`makerLeadTime failed: ${e?.message}`, 500); }
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
    const [[mq], [mf], _qoRows, _mDaily, _mBands, _mCatBandDay] = await Promise.all([
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
      const dcur = cell.byDay.get(_d) || { pnl: 0, contracts: 0 };
      dcur.pnl += p; dcur.contracts += c; cell.byDay.set(_d, dcur);
    }
    const _categoryBands = [..._cbCells.values()].map(cell => {
      const perContract = cell.contracts ? cell.pnl / cell.contracts : null;
      const sideWon = cell.contracts ? cell.won / cell.contracts : null;
      const dayVals = [...cell.byDay.values()];
      const absTot = dayVals.reduce((a, v) => a + Math.abs(v.pnl), 0);
      const topDayShare = absTot ? Math.max(...dayVals.map(v => Math.abs(v.pnl))) / absTot : null;
      // Per-cell day-clustered CI. `reliable` requires >=3 days for the interval to be estimable.
      const _dc = dayClusteredPnl({ days: dayVals });
      const ciLo = _dc?.loCI ?? null, ciHi = _dc?.hiCI ?? null;
      const reliable = ciLo != null && ciLo > 0 && cell.byDay.size >= 3;
      // Anomaly flag: outcome pinned against price at P < 0.1%. The wrong-side-fill signature is
      // sideWon === 0 at a price implying it usually should win (or sideWon === 1 at a low price).
      let anomaly = false;
      if (cell.fills >= 20 && (sideWon === 0 || sideWon === 1)) {
        const [_lo, _hi] = cell.band.split("-").map(Number);
        const p = (_lo + _hi) / 2 / 100;
        const tail = sideWon === 1 ? Math.pow(p, cell.fills) : Math.pow(1 - p, cell.fills);
        anomaly = tail < 0.001;
      }
      return { sport: cell.sport, category: cell.category, band: cell.band,
        fills: cell.fills, contracts: parseFloat(cell.contracts.toFixed(1)),
        perContract: perContract != null ? parseFloat(perContract.toFixed(2)) : null,
        sideWon: sideWon != null ? parseFloat(sideWon.toFixed(4)) : null,
        days: cell.byDay.size, ciLo, ciHi, reliable,
        topDayShare: topDayShare != null ? parseFloat(topDayShare.toFixed(2)) : null,
        anomaly };
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
    const diagnosis = current ? "current"
      : (latestFill != null && latestFill >= expectedThrough)
        ? "fills detected but NOT graded — grading stalled (Kalshi rate-limit; tape walk didn't reach end)"
        : "no fills for last night — tape replay or quoting did not run";
    dataFreshness = {
      expectedThrough, latestGradedMakerDay: latestGraded, latestMakerFillDay: latestFill,
      ungradedFills: Number(mf?.ungraded || 0), latestResolvedShadowDay: _d(sp?.latest_resolved),
      makerTableCurrent: current, daysBehind, diagnosis,
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
      note: "screen=REAL_BOOK ⇒ real book, NOT buildable — vet GAME-suffix (perGame:false = futures), ESPN slug, team abbrs before building",
    };
  } catch (e) { console.error("[shadow-report] discovery skipped:", e?.message); }

  // ── UI health — the landing page's rendered payload is present + complete ────────────────────
  // MakerBoardPage draws exactly two things: PreregTracker(preregistrations) and
  // CategoryBandHeatmap(makerBoard.categoryBands). This asserts BOTH against the fields those
  // components actually read. dataFreshness answers "is the data current?"; this answers "will the
  // page render?" — orthogonal, because an on-time report can still ship an empty/degenerate
  // categoryBands (blank board) or a cell missing a render field (blank/NaN square). Pure, computed
  // from the in-memory payload above, so it can never disagree with what ships. Failure-closed by
  // construction — every guard handles null.
  const uiHealth = computeUiHealth(makerBoard, preregistrations);

  const report = { reportDate, generatedAt: new Date().toISOString(), since, makerBoard,
    preregistrations, dataFreshness, discovery, uiHealth, durationMs: Date.now() - t0 };

  if (cache) cache.put(cacheKey, JSON.stringify(report), { expirationTtl: REPORT_TTL }).catch(() => {});
  return jsonResponse(report);
}

export { handleShadowReport };
