// api/lib/handlers/shadow/snapshot.js
// /api/shadow-snapshot — the cron that logs ALL model predictions to Neon for unbiased shadow
// calibration (plus the maker backfill/detect admin paths). Extracted verbatim from
// handlers/shadow.js during the handler split (zero behavior change). exogenousSignals and
// mergeCoverage are exported for the unit tests that import them via handlers/shadow.js.

import { neonQuery, neonBatchUpsert, neonBatchResolve, neonExec } from "../../neon.js";
import { fetchTradeFlow } from "../../kalshi-flow.js";
import { errorResponse, jsonResponse, selfOrigin } from "../../utils.js";
import { detectAndGradeMakerFills, gradeMakerFills } from "../../maker.js";
import { backfillMakerDay, listDayMarkets, compareSourcesForDay, dayHasLiveSegments } from "../../maker-backfill.js";
import { shadowId } from "../../shadow-id.js";
import { deriveKalshiSide, fetchKalshiSettlementsWithMeta, classifyRowViaKalshi } from "../../kalshi-settlement.js";
import { kalshiTickerDate } from "../../kalshi-ticker.js";
import { capturePolymarketPlays } from "../../polymarket-capture.js";
import {
  SHADOW_TABLE, COLUMNS, CREATE_TABLE_SQL, ADD_MODEL_FREE_COLS_SQL, ADD_KALSHI_SETTLEMENT_COLS_SQL,
  CREATE_POLY_DELTAS_SQL, ADD_POLY_EXEC_COLS_SQL, CREATE_SB_DELTAS_SQL, CREATE_POLY_PLAYS_SQL,
  POLY_DELTAS_TABLE, POLY_DELTAS_COLUMNS, SB_DELTAS_TABLE, SB_DELTAS_COLUMNS, _resolveRow,
} from "./common.js";

// Stable deterministic ID for a play — unique per player/teams + stat/line + date.
// fallbackDate (the PT snapshot date) scopes plays whose gameDate is null: without it,
// date-less ids collide across days — a next-day Kalshi pre-listing logged yesterday
// permanently blocked today's row via ON CONFLICT DO NOTHING, and a rematch weeks later
// with the same threshold could never log at all (found via 17 noData rows, 2026-06-11).
// Same-day re-snapshots (8:05am vs 3:05pm) still dedup since fallbackDate is equal.
// (Definition lives in api/lib/shadow-id.js — see import above.)

// group_id links all threshold variants for the same player/matchup on the same game.
// Same fallbackDate scoping as shadowId — date-less group_ids would merge different
// days' alt-line groups in the DB-side analyses (intraGroupCorr, threshold_rank ROI).
// Team rows key stat-first to mirror the analyses' COALESCE(stat, game_type): gameType-first
// merged the whole ML family (ml/f3ml/f5ml/f7ml all carry gameType "ml") into ONE rank group,
// making threshold_rank=1 a cross-category lottery — f5ml's rank-1 population starved when
// f3/f7 capture started 2026-07-01. Historical rows were re-ranked under this key on
// 2026-07-13 (?rerankgroups=1 backfill below), so stored ranks are uniform stat-first.
function groupId(p, fallbackDate = "") {
  if (p.playerName) {
    return `pp|${p.sport}|${p.playerId || p.playerName}|${p.gameDate || fallbackDate || ""}`;
  }
  return `tm|${p.sport}|${p.stat || p.gameType}|${p.homeTeam}|${p.awayTeam}|${p.gameDate || fallbackDate || ""}`;
}

// Annotate each play with its group_id + group_size (alt-line grouping — still structurally
// meaningful for intra-group analyses). threshold_rank and is_best_edge are the EDGE-RANKING
// columns; with the model teardown (2026-08-04) every row is model-free (truePct/edge null), so
// ranking is meaningless and would be misleading — both go NULL. Mutates the plays in-place.
function annotateGroups(plays, fallbackDate = "") {
  const groups = new Map();
  for (const p of plays) {
    const gid = groupId(p, fallbackDate);
    p._gid = gid;
    p._rank = null;         // edge ranking dropped (model-free)
    p._isBestEdge = null;   // edge ranking dropped (model-free)
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(p);
  }
  for (const [, group] of groups) {
    for (const p of group) p._groupSize = group.length;
  }
}

// Extract only the feature fields useful for future meta-model training.
// Excludes fields already stored in dedicated columns.
const DEDICATED = new Set([
  "sport", "stat", "gameType", "playerName", "playerId", "homeTeam", "awayTeam",
  "scoringTeam", "pickTeam", "pickLine", "threshold", "direction",
  "truePct", "kalshiPct", "noKalshiPct", "edge", "dataConfidence", "dcQualified",
  "gameDate", "gameTime", "modelVersion", "seasonType",
]);

// Standardized exogenous-signal namespace. The catch-all below logs whatever each emit
// path happened to hang on the play (rich for props, sparse for game/new-sport markets),
// so coverage is by-accident and naming drifts (props "lineupConfirmed" vs game markets
// "lineupsConfirmed" — same signal, two keys, never aggregated). This folds the raw,
// EXOGENOUS dimensions a market-mispricing signal is most likely to live in onto ONE
// uniform x* set, present across EVERY category. tune:residual ranks these first (they're
// market-independent, so slicing model-residual on them isn't circular, unlike the model
// intermediates the catch-all also logs). Pure capture — no formula consumes it.
export function exogenousSignals(p) { // exported for unit tests only
  const x = {};
  const set = (k, v) => { if (v != null) x[k] = v; };
  set("xVolume", p.kalshiVolume);   // Kalshi traded/resting volume — liquidity proxy
  set("xSpread", p.kalshiSpread);   // yes/no spread (¢) — thinness proxy
  set("xLineMove", p.lineMove);     // price drift since open — latency signal (props today)
  const lc = p.lineupConfirmed ?? p.lineupsConfirmed; // unify the two historical keys
  if (lc != null) x.xLineupConfirmed = lc;
  set("xRestDays", p.pitcherDaysRest); // MLB pitcher days rest
  set("xWindOutMph", p.windOutMph);    // signed out-to-CF wind (MLB, when hydrated)
  set("xTempF", p.tempF);
  // Kalshi taker-flow features (xFlow*) — stamped as p._flow by the snapshot handler
  // from the public trade tape (kalshi-flow.js). Underscore-prefixed so the catch-all
  // below never double-logs it; folding here keeps xFlow* inside the uniform x* set.
  if (p._flow) for (const [k, v] of Object.entries(p._flow)) set(k, v);
  return x;
}

// Coverage KV merge: within a day the distinct-game count is monotonic in the same sense
// as the resolution count — a later run seeing FEWER games means staging decayed (games
// started/settled out, next-day pre-listings dominate), not that capture un-happened. So
// per-sport games/scheduled max-merge over the union of sports, and the warning recomputes
// from the merged numbers. Keeps a manual evening snapshot run (deploy verification) from
// clobbering the healthy cron stamp — the 2026-07-06 false "slate under-logged" banner.
export function mergeCoverage(prev, curr) { // exported for unit tests only
  const merged = {};
  for (const src of [prev, curr]) {
    for (const [sp, c] of Object.entries(src || {})) {
      const m = merged[sp] ??= { games: 0, scheduled: 0 };
      m.games = Math.max(m.games, Number(c?.games) || 0);
      m.scheduled = Math.max(m.scheduled, Number(c?.scheduled) || 0);
    }
  }
  const warning = Object.values(merged).some(c => c.scheduled > 0 && c.games / c.scheduled < 0.8);
  return { coverage: merged, coverageWarning: warning };
}

function extractFeatures(p) {
  const features = { ...exogenousSignals(p) };
  for (const [k, v] of Object.entries(p)) {
    if (!DEDICATED.has(k) && !k.startsWith("_") && v !== undefined && v !== null) {
      features[k] = v;
    }
  }
  return Object.keys(features).length > 0 ? JSON.stringify(features) : null;
}

// ── /api/shadow-snapshot ──────────────────────────────────────────────────────
async function handleShadowSnapshot({ path, request, env, cache }) {
  if (path !== "shadow-snapshot") return null;

  // Auth: CRON_SECRET (Vercel cron runner) or ADMIN_KEY (manual trigger).
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;
  const isCron  = env?.CRON_SECRET && bearer === env.CRON_SECRET;
  if (!isAdmin && !isCron) return errorResponse("Forbidden", 403);

  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  // ?rerankgroups=1 (ADMIN only) — one-shot backfill: recompute group_id/threshold_rank/
  // group_size/is_best_edge for ALL team rows under the stat-first key (2026-07-13 groupId fix).
  // Legit to backfill because ranks are pure annotation over stored values — no superseded
  // formula output is mixed (unlike FORMULA_CUTOFFS). Player rows (pp| groups) untouched.
  // model_true_pct is bet-side while annotateGroups ranks yes-side truePct, but distance from
  // 50 is symmetric under complement, so the ranks are identical. ?dry=1 = report only.
  if (new URL(request.url).searchParams.get("rerankgroups") === "1") {
    if (!isAdmin) return errorResponse("Forbidden", 403);
    const dry = new URL(request.url).searchParams.get("dry") === "1";
    const partition = `PARTITION BY sport, COALESCE(stat, game_type), home_team, away_team, COALESCE(game_date, snapshot_date::varchar)`;
    const rankedCte = `
      SELECT id, sport, COALESCE(stat, game_type) AS category, threshold_rank AS old_rank,
        'tm|' || sport || '|' || COALESCE(stat, game_type, '') || '|' || COALESCE(home_team,'') || '|' || COALESCE(away_team,'') || '|' || COALESCE(game_date, snapshot_date::varchar, '') AS gid,
        ROW_NUMBER() OVER (${partition} ORDER BY ABS(COALESCE(model_true_pct, 50) - 50), id) AS new_rank,
        (COUNT(*) OVER (${partition}))::int AS gs,
        (ROW_NUMBER() OVER (${partition} ORDER BY COALESCE(edge, 0) DESC, id) = 1) AS best
      FROM ${SHADOW_TABLE}
      WHERE player_name IS NULL`;
    try {
      let summary;
      if (dry) {
        summary = await neonQuery(`
          WITH ranked AS (${rankedCte})
          SELECT sport, category, COUNT(*)::int AS n,
            SUM((old_rank = 1)::int)::int AS rank1_old,
            SUM((new_rank = 1)::int)::int AS rank1_new,
            SUM((old_rank IS DISTINCT FROM new_rank)::int)::int AS changed
          FROM ranked GROUP BY 1, 2 ORDER BY changed DESC`, [], env, { write: true });
      } else {
        summary = await neonQuery(`
          WITH ranked AS (${rankedCte}),
          upd AS (
            UPDATE ${SHADOW_TABLE} sp
            SET group_id = r.gid, threshold_rank = r.new_rank, group_size = r.gs, is_best_edge = r.best
            FROM ranked r
            WHERE sp.id = r.id
              AND (sp.threshold_rank IS DISTINCT FROM r.new_rank OR sp.group_size IS DISTINCT FROM r.gs
                   OR sp.group_id IS DISTINCT FROM r.gid OR sp.is_best_edge IS DISTINCT FROM r.best)
            RETURNING sp.sport, COALESCE(sp.stat, sp.game_type) AS category, (r.new_rank = 1) AS is_rank1
          )
          SELECT sport, category, COUNT(*)::int AS changed, SUM(is_rank1::int)::int AS rank1_after
          FROM upd GROUP BY 1, 2 ORDER BY changed DESC`, [], env, { write: true });
        console.log(`[shadow-snapshot] rerankgroups applied: ${summary.reduce((s, r) => s + r.changed, 0)} rows changed`);
      }
      return jsonResponse({ ok: true, dry, byCategory: summary });
    } catch (e) { return errorResponse(`rerankgroups failed: ${e?.message}`, 500); }
  }

  // ?makerDetectDay=YYYY-MM-DD (ADMIN only) — run V1 fill detection + grading for ONE past day
  // against the live quote segments already in maker_quotes. The nightly resolver only ever calls
  // detectAndGradeMakerFills with yesterday, so a day missed for any reason (the 2026-07-28 hole
  // left by the tape replay being off) had no way back short of flipping a global and waiting.
  //
  // NOT the same tool as ?makerBackfill= below, and the distinction matters: backfill RECONSTRUCTS
  // quote segments for a day that has none, from Kalshi candlesticks, under source='backfill' — and
  // it deliberately 409s on a day that already has live segments, to keep live and replayed days
  // disjoint. This day HAS its live segments (quoting never stopped); only the fills are missing.
  // So it replays the trade tape over the existing source='live' rows, which is precisely what the
  // nightly pass does. Idempotent — fills are UNIQUE on (quote_id, trade_id).
  //
  // Passes force:true so it works regardless of TAPE_REPLAY_ENABLED: the flag governs the nightly
  // cron, not the manual repair tool.
  if (new URL(request.url).searchParams.get("makerDetectDay")) {
    if (!isAdmin) return errorResponse("Forbidden", 403);
    const dayPT = new URL(request.url).searchParams.get("makerDetectDay");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPT)) return errorResponse("makerDetectDay must be YYYY-MM-DD", 400);
    const _todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    // Today's games are still in progress, so its tape is incomplete and its quotes are still being
    // written — a run now would bank a partial day that a later re-run could only add to, never
    // correct. Refuse rather than silently produce a half day.
    if (dayPT >= _todayPT) return errorResponse(`makerDetectDay must be a past PT day (today is ${_todayPT})`, 400);
    try {
      const [{ n: segN } = { n: 0 }] = await neonQuery(
        `SELECT COUNT(*)::int AS n FROM maker_quotes WHERE game_date = $1 AND source = 'live'`,
        [dayPT], env, { write: true });
      // No live segments means nothing was quoted that day — replaying the tape would fetch for
      // every ticker and match none. Say so instead of returning a confusing clean zero.
      if (!segN) return jsonResponse({ ok: true, day: dayPT, liveSegments: 0, skipped: "no_live_segments",
        hint: "quoting did not run that day — ?makerBackfill= reconstructs segments from candlesticks instead" });

      // &offset=N resumes a rate-limited walk; the caller loops on `nextOffset` until it is null,
      // exactly like ?makerBackfill=. Omitted → offset 0.
      const offset = Math.max(0, parseInt(new URL(request.url).searchParams.get("offset") || "0", 10) || 0);
      const res = await detectAndGradeMakerFills({ env, dayPT, force: true, offset });
      console.log(`[shadow-snapshot] makerDetectDay ${dayPT} segs=${segN} off=${offset} tickers=${res.tickers} `
        + `newFills=${res.newFills} graded=${res.graded} tapeFails=${res.tapeFails} rl=${res.rateLimited} next=${res.nextOffset}`);
      return jsonResponse({
        ok: true, day: dayPT, liveSegments: segN, ...res,
        // newFills 0 with tickers > 0 and no tape failures is the signal that Kalshi no longer
        // serves trades that far back — i.e. the day is unrecoverable, not merely quiet.
        tapeExhausted: res.tickers > 0 && res.newFills === 0 && res.tapeFails === 0,
      });
    } catch (e) { return errorResponse(`makerDetectDay failed: ${e?.message}`, 500); }
  }

  // ?makerBackfill=YYYY-MM-DD (ADMIN only) — replay V1 maker quoting over a historical day from
  // Kalshi's own candlestick + trade history (api/lib/maker-backfill.js). Exists because the V1 arm
  // gate is day-clustered and DAYS are the binding constraint: at the 2026-07-28 reading (mean
  // +1.55¢, se 2.18 on 9 days) the CI needs ~69 days to clear zero, i.e. two months of waiting for
  // data Kalshi already serves.
  //
  //   &offset=N     resume point — 2,610 MLB prop markets/day is more than one invocation can walk,
  //                 so the response carries `nextOffset` and the caller loops until it is null.
  //   &validate=1   write source='validate' restricted to tickers the LIVE cron also quoted, and
  //                 return the live-vs-replay comparison. This is the gate on the whole approach:
  //                 a replayed day must reproduce the live day before any backfilled day is read.
  //   &compare=1    just the comparison for a day already validated (no fetching).
  //   &purge=1      drop this day's source='validate' rows once the comparison is banked.
  //
  // Refuses to write source='backfill' into a day that already holds live segments — one day is
  // either live or replayed, never both, or the day-clustered estimator double-counts it.
  if (new URL(request.url).searchParams.get("makerBackfill")) {
    if (!isAdmin) return errorResponse("Forbidden", 403);
    const qs = new URL(request.url).searchParams;
    const dayPT = qs.get("makerBackfill");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPT)) return errorResponse("makerBackfill must be YYYY-MM-DD", 400);
    const validate = qs.get("validate") === "1";
    const source = validate ? "validate" : "backfill";
    try {
      if (qs.get("compare") === "1") {
        return jsonResponse({ ok: true, comparison: await compareSourcesForDay({ env, dayPT, source }) });
      }
      if (qs.get("purge") === "1") {
        await neonQuery(`DELETE FROM maker_fills WHERE quote_id IN (
                           SELECT id FROM maker_quotes WHERE game_date = $1 AND source = 'validate')`,
          [dayPT], env, { write: true });
        const gone = await neonQuery(
          `DELETE FROM maker_quotes WHERE game_date = $1 AND source = 'validate' RETURNING id`,
          [dayPT], env, { write: true });
        return jsonResponse({ ok: true, purged: gone.length, day: dayPT });
      }
      if (!validate && await dayHasLiveSegments({ env, dayPT })) {
        return errorResponse(`${dayPT} already has live maker segments — use &validate=1 to compare instead`, 409);
      }

      // The day's ticker universe is stable, so it is enumerated once and cached for the resume
      // loop rather than re-walked (5 series × pagination) on every chunk.
      const tkKey = `maker:bf:tickers:${dayPT}`;
      let tickers = cache ? await cache.get(tkKey, "json").catch(() => null) : null;
      if (!Array.isArray(tickers) || !tickers.length) {
        tickers = await listDayMarkets(dayPT);
        if (cache) cache.put(tkKey, JSON.stringify(tickers), { expirationTtl: 21600 }).catch(() => {});
      }

      // Validation compares like with like: only tickers the live cron actually quoted.
      let restrictTo = null;
      if (validate) {
        const live = await neonQuery(
          `SELECT DISTINCT ticker FROM maker_quotes WHERE game_date = $1 AND source = 'live'`,
          [dayPT], env, { write: true });
        restrictTo = new Set(live.map((r) => r.ticker));
        if (!restrictTo.size) return errorResponse(`${dayPT} has no live segments to validate against`, 400);
      }

      const offset = Math.max(0, parseInt(qs.get("offset") || "0", 10) || 0);
      const result = await backfillMakerDay({
        env, dayPT, tickers, offset, source, restrictTo,
        limit: Math.min(2000, parseInt(qs.get("limit") || "400", 10) || 400),
        deadlineMs: Date.now() + 200_000,
      });
      // Grade once the day is fully walked, not per chunk: gradeMakerFills scans every ungraded
      // fill in the table, so calling it 7× a day × 52 days would be the same work 7× over.
      const graded = result.nextOffset === null ? await gradeMakerFills({ env }) : 0;
      console.log(`[shadow-snapshot] makerBackfill day=${dayPT} src=${source} off=${offset} `
        + `quoted=${result.quoted} segs=${result.segments} fills=${result.fills} graded=${graded} `
        + `next=${result.nextOffset} rl=${result.rateLimited}`);
      return jsonResponse({
        ok: true, ...result, graded, totalTickers: tickers.length,
        comparison: validate && result.nextOffset === null
          ? await compareSourcesForDay({ env, dayPT, source }) : undefined,
      });
    } catch (e) { return errorResponse(`makerBackfill failed: ${e?.message}`, 500); }
  }

  // ?backfillgamedate=1 (ADMIN only, ?dry=1 to report) — repair for the 2026-07-27 null-game_date
  // bug: game-totals.js's dropped-row push omitted gameDate/gameTime, so 23.5% of shadow_plays
  // landed with a NULL game_date. Those rows fell through the resolver's date ladder to
  // snapshot_date and, for a next-day pre-listing, graded against the SAME matchup played the
  // previous day (MLB series make that routine). Idempotent: re-running changes nothing once clean.
  //
  // Two phases, both keyed off the Kalshi ticker's own date segment (the venue's identifier for
  // the event, so it is authoritative for WHICH game the row is about):
  //   A. REGRADE — rows already graded off a wrong date. Suspect = resolved, game_time also NULL
  //      (so the ladder really did fall through to snapshot_date), and tickerDate != snapshot_date.
  //      Those labels are a wrong GAME, not a wrong reading of the right game, so they are
  //      re-graded from Kalshi settlement. NOTE: this deliberately uses settlement on calibrated
  //      teamRows families, which settlement-reconcile.js normally keeps ESPN-graded — justified
  //      only because the incumbent label is known-wrong, and scoped to exactly those rows.
  //   B. BACKFILL — write game_date = tickerDate for every NULL-game_date row that has a parseable
  //      ticker. Unresolved ones then grade correctly on the next normal pass.
  // Rows without a ticker (pre-2026-07-23) are unrecoverable and left alone.
  if (new URL(request.url).searchParams.get("backfillgamedate") === "1") {
    if (!isAdmin) return errorResponse("Forbidden", 403);
    const dry = new URL(request.url).searchParams.get("dry") === "1";
    try {
      const nullRows = await neonQuery(
        `SELECT id, sport, stat, game_type, kalshi_ticker, kalshi_side, won, game_time,
                snapshot_date, resolved
           FROM ${SHADOW_TABLE}
          WHERE game_date IS NULL AND kalshi_ticker IS NOT NULL`, [], env, { write: true });

      const snapDate = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
      const withDate = [];
      for (const r of nullRows) {
        const td = kalshiTickerDate(r.kalshi_ticker);
        if (td) withDate.push({ ...r, tickerDate: td, snap: snapDate(r.snapshot_date) });
      }
      // Graded off a date the ladder guessed, and the guess disagrees with the ticker.
      const suspects = withDate.filter(r => r.won !== null && !r.game_time && r.tickerDate !== r.snap);

      // Phase A — settlement grades for the suspects.
      let regraded = 0, voided = 0, pending = 0, flipped = 0, fetchMeta = null;
      const flips = [];
      if (suspects.length) {
        const { settlements, meta } = await fetchKalshiSettlementsWithMeta(suspects.map(r => r.kalshi_ticker));
        fetchMeta = meta;
        const regradeUpdates = [];
        for (const r of suspects) {
          const c = classifyRowViaKalshi(r, settlements);
          if (c.state === "pending") { pending++; continue; }
          if (c.state === "void") { voided++; regradeUpdates.push({ id: r.id, won: null }); continue; }
          regraded++;
          if (c.won !== r.won) {
            flipped++;
            if (flips.length < 20) flips.push({ id: r.id, sport: r.sport, stat: r.stat || r.game_type,
              ticker: r.kalshi_ticker, was: r.won, now: c.won, snap: r.snap, tickerDate: r.tickerDate });
          }
          regradeUpdates.push({ id: r.id, won: c.won });
        }
        // Chunked VALUES update — same idiom as neonBatchResolve. A per-row loop here would be
        // ~2k sequential Neon HTTP round-trips and would not finish inside maxDuration.
        if (!dry && regradeUpdates.length) {
          for (let i = 0; i < regradeUpdates.length; i += 100) {
            const chunk = regradeUpdates.slice(i, i + 100);
            await neonQuery(
              `UPDATE ${SHADOW_TABLE} AS t SET won = v.won
                 FROM (VALUES ${chunk.map((_, ri) => `($${ri * 2 + 1}, $${ri * 2 + 2}::boolean)`).join(", ")}) AS v(id, won)
                WHERE t.id = v.id`,
              chunk.flatMap(u => [u.id, u.won]), env, { write: true });
          }
        }
      }

      // Phase B — write the real game_date everywhere it is recoverable. The IS NULL guard keeps
      // this idempotent and stops it from ever overwriting a real (or re-attributed) date.
      let dated = 0;
      if (!dry && withDate.length) {
        for (let i = 0; i < withDate.length; i += 100) {
          const chunk = withDate.slice(i, i + 100);
          await neonQuery(
            `UPDATE ${SHADOW_TABLE} AS t SET game_date = v.gd
               FROM (VALUES ${chunk.map((_, ri) => `($${ri * 2 + 1}, $${ri * 2 + 2}::text)`).join(", ")}) AS v(id, gd)
              WHERE t.id = v.id AND t.game_date IS NULL`,
            chunk.flatMap(r => [r.id, r.tickerDate]), env, { write: true });
          dated += chunk.length;
        }
      } else { dated = withDate.length; }

      console.log(`[shadow-snapshot] backfillgamedate dry=${dry} nullRows=${nullRows.length} datable=${withDate.length} suspects=${suspects.length} regraded=${regraded} flipped=${flipped}`);
      return jsonResponse({
        ok: true, dry,
        nullGameDateWithTicker: nullRows.length,
        datable: withDate.length,
        unparseableTicker: nullRows.length - withDate.length,
        backfilled: dated,
        regrade: { suspects: suspects.length, regraded, flipped, voided, pending, settlementFetch: fetchMeta },
        // Non-zero chunksFailed means some suspects were never looked up — re-run before trusting.
        incomplete: !!(fetchMeta && fetchMeta.chunksFailed > 0),
        flips,
      });
    } catch (e) { return errorResponse(`backfillgamedate failed: ${e?.message}`, 500); }
  }

  // ?makerFillsPurge=1&confirm=DELETE (ADMIN) — clear maker_fills ahead of the 2026-07-29 rebuild.
  // Every row in that table was matched by the INVERTED side condition in replayFills (fixed the
  // same day; see the evidence block there and ?makerSideAudit=). They are trades that never hit
  // our quotes, so this is not a biased subset to patch — the population is wrong and has to be
  // re-derived from the tape.
  //
  // The rows are COPIED to maker_fills_wrongside_20260729 before deletion, not dropped. They cost
  // nothing to keep and they are the only record of what the engine believed for its first ten
  // days — which is what any future audit of the shelving decision would need to read.
  //
  // Requires &confirm=DELETE. Refuses to run twice: if the backup table already holds rows the
  // purge has happened, and a second pass would overwrite the archive with post-rebuild data.
  if (new URL(request.url).searchParams.get("makerFillsPurge") === "1") {
    if (!isAdmin) return errorResponse("Forbidden", 403);
    if (new URL(request.url).searchParams.get("confirm") !== "DELETE") {
      return errorResponse("makerFillsPurge requires &confirm=DELETE", 400);
    }
    try {
      await neonExec(`CREATE TABLE IF NOT EXISTS maker_fills_wrongside_20260729 (LIKE maker_fills INCLUDING ALL)`, env);
      const [{ n: already }] = await neonQuery(`SELECT COUNT(*)::int AS n FROM maker_fills_wrongside_20260729`, [], env, { write: true });
      if (already > 0) {
        return jsonResponse({ ok: false, skipped: "archive_already_populated", archivedRows: already,
          hint: "the purge already ran; re-running would overwrite the archive with post-rebuild rows" });
      }
      const [{ n: before }] = await neonQuery(`SELECT COUNT(*)::int AS n FROM maker_fills`, [], env, { write: true });
      await neonQuery(`INSERT INTO maker_fills_wrongside_20260729 SELECT * FROM maker_fills`, [], env, { write: true });
      const [{ n: archived }] = await neonQuery(`SELECT COUNT(*)::int AS n FROM maker_fills_wrongside_20260729`, [], env, { write: true });
      if (archived !== before) {
        return errorResponse(`archive mismatch (${archived} vs ${before}) — refusing to delete`, 500);
      }
      await neonQuery(`DELETE FROM maker_fills`, [], env, { write: true });
      const [{ n: after }] = await neonQuery(`SELECT COUNT(*)::int AS n FROM maker_fills`, [], env, { write: true });
      // The days that need re-detection: every day with live quote segments.
      const days = await neonQuery(
        `SELECT game_date, COUNT(*)::int AS segments FROM maker_quotes
          WHERE source = 'live' AND game_date IS NOT NULL GROUP BY 1 ORDER BY 1`, [], env, { write: true });
      console.log(`[shadow-snapshot] makerFillsPurge archived=${archived} deleted=${before} remaining=${after}`);
      return jsonResponse({ ok: true, archivedRows: archived, deletedRows: before, remaining: after,
        rebuildDays: days.map(d => ({ day: d.game_date, segments: d.segments })) });
    } catch (e) { return errorResponse(`makerFillsPurge failed: ${e?.message}`, 500); }
  }

  // ?regradepostponed=1 (ADMIN only, ?dry=1 to report, ?days=N window, default 30) — repair for the
  // 2026-07-29 postponed/makeup bug. The forward fix (settlement-reconcile.js + _resolveRow) stops
  // NEW rows from being graded against an unidentifiable event; this re-grades the ones already
  // written. Idempotent — re-running changes nothing once clean.
  //
  // The signature is structural, not "disagrees with settlement". That distinction is the whole
  // design: regrading every calibrated row that merely disagrees would hand settlement authority
  // over the calibrated families wholesale, which settlement-reconcile.js's doctrine forbids and
  // which would quietly convert a repair into a policy change. So the population is:
  //
  //   a matchup (sport + team pair + ticker date) where SOME row was re-attributed FORWARD of its
  //   ticker date → that matchup was postponed → every row for it, on the original date AND the
  //   makeup date, was graded against an event ESPN could not identify.
  //
  // That catches both halves of the CLE@CIN row set in one pass: the makeup-date rows (graded
  // against the wrong game of the doubleheader) and the original-date rows (graded against a
  // POSTPONED 0-0 "final"). The self-join is done in JS because tickerDate is derived, not a column.
  //
  // actual_value is nulled alongside `won` for the whole population — it was read off the wrong
  // physical game, so keeping it would leave a corrupt column behind a corrected label. This
  // matches the forward path, where these rows never enter `updates` and so carry no actualValue.
  if (new URL(request.url).searchParams.get("regradepostponed") === "1") {
    if (!isAdmin) return errorResponse("Forbidden", 403);
    const _qs = new URL(request.url).searchParams;
    const dry = _qs.get("dry") === "1";
    const days = Math.min(365, Math.max(1, parseInt(_qs.get("days") || "30", 10) || 30));
    try {
      const cand = await neonQuery(
        `SELECT id, sport, stat, game_type, kalshi_ticker, kalshi_side, won,
                home_team, away_team, game_date
           FROM ${SHADOW_TABLE}
          WHERE kalshi_ticker IS NOT NULL
            AND game_date IS NOT NULL
            AND resolved = TRUE
            AND game_date >= ($1::date)::text`,
        // `game_date` is TEXT, not DATE (schema line ~98) — comparing it to a date operand
        // fails outright with "operator does not exist: text >= date". Casting the BOUND to text
        // (rather than game_date to date) keeps the comparison lexicographic, which is exact for
        // 'YYYY-MM-DD', and leaves any non-conforming legacy value from throwing the whole query.
        // The bound is computed in JS so the cast has a plain date literal to work on.
        [new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)], env, { write: true });

      const ymd = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
      const rowsWithTd = [];
      for (const r of cand) {
        const td = kalshiTickerDate(r.kalshi_ticker);
        const gd = ymd(r.game_date);
        if (td && gd) rowsWithTd.push({ ...r, tickerDate: td, gameDate: gd });
      }
      // A matchup is keyed by its TICKER date, not its game_date — that is what stays constant
      // across a postponement, and it is what makes the original-date and makeup-date rows for the
      // same postponed game land in the same bucket.
      const matchupKey = (r) => `${r.sport}|${[r.home_team, r.away_team].sort().join("|")}|${r.tickerDate}`;
      const postponedMatchups = new Set();
      for (const r of rowsWithTd) if (r.gameDate > r.tickerDate) postponedMatchups.add(matchupKey(r));
      const affected = rowsWithTd.filter(r => postponedMatchups.has(matchupKey(r)));

      let regraded = 0, voided = 0, pending = 0, flipped = 0, fetchMeta = null;
      const flips = [];
      const updates = [];
      if (affected.length) {
        const { settlements, meta } = await fetchKalshiSettlementsWithMeta(affected.map(r => r.kalshi_ticker));
        fetchMeta = meta;
        for (const r of affected) {
          const c = classifyRowViaKalshi(r, settlements);
          if (c.state === "pending") { pending++; continue; }
          if (c.state === "void") { voided++; updates.push({ id: r.id, won: null }); continue; }
          regraded++;
          if (c.won !== r.won) {
            flipped++;
            if (flips.length < 20) flips.push({ id: r.id, sport: r.sport, stat: r.stat || r.game_type,
              ticker: r.kalshi_ticker, was: r.won, now: c.won, gameDate: r.gameDate, tickerDate: r.tickerDate });
          }
          updates.push({ id: r.id, won: c.won });
        }
        // Chunked VALUES update — same idiom as neonBatchResolve / backfillgamedate above.
        if (!dry && updates.length) {
          for (let i = 0; i < updates.length; i += 100) {
            const chunk = updates.slice(i, i + 100);
            await neonQuery(
              `UPDATE ${SHADOW_TABLE} AS t SET won = v.won, actual_value = NULL
                 FROM (VALUES ${chunk.map((_, ri) => `($${ri * 2 + 1}, $${ri * 2 + 2}::boolean)`).join(", ")}) AS v(id, won)
                WHERE t.id = v.id`,
              chunk.flatMap(u => [u.id, u.won]), env, { write: true });
          }
        }
      }

      console.log(`[shadow-snapshot] regradepostponed dry=${dry} days=${days} scanned=${cand.length} `
        + `postponedMatchups=${postponedMatchups.size} affected=${affected.length} regraded=${regraded} flipped=${flipped} voided=${voided} pending=${pending}`);
      return jsonResponse({
        ok: true, dry, days,
        scanned: cand.length,
        postponedMatchups: postponedMatchups.size,
        affected: affected.length,
        regraded, flipped, voided, pending,
        settlementFetch: fetchMeta,
        // Non-zero chunksFailed means some affected rows were never looked up — re-run before
        // trusting any count here (2026-07-26 414 lesson).
        incomplete: !!(fetchMeta && fetchMeta.chunksFailed > 0),
        flips,
      });
    } catch (e) { return errorResponse(`regradepostponed failed: ${e?.message}`, 500); }
  }

  const snapshotDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const t0 = Date.now();

  try {
    // DDL is skipped after first successful run (flag cached in Upstash for 30 days).
    // Avoids 4 cold-Neon round-trips that push the Edge Function past its timeout.
    const _schemaKey = "shadow:schema:v7";
    const _schemaOk = cache ? await cache.get(_schemaKey).catch(() => null) : null;
    if (!_schemaOk) {
      console.log("[shadow-snapshot] starting neonExec DDL");
      await neonExec(CREATE_TABLE_SQL, env);
      await neonExec(CREATE_POLY_DELTAS_SQL, env);
      await neonExec(ADD_POLY_EXEC_COLS_SQL, env);
      await neonExec(CREATE_SB_DELTAS_SQL, env);
      console.log(`[shadow-snapshot] DDL done ${Date.now() - t0}ms`);
    }
    const _modelFreeSchemaKey = "shadow:schema:modelfree:v1";
    const _modelFreeSchemaOk = cache ? await cache.get(_modelFreeSchemaKey).catch(() => null) : null;
    if (!_modelFreeSchemaOk) {
      await neonExec(ADD_MODEL_FREE_COLS_SQL, env);
      if (cache) cache.put(_modelFreeSchemaKey, "1", { expirationTtl: 86400 * 30 }).catch(() => {});
    }
    const _kalshiSettlementSchemaKey = "shadow:schema:kalshisettlement:v1";
    const _kalshiSettlementSchemaOk = cache ? await cache.get(_kalshiSettlementSchemaKey).catch(() => null) : null;
    if (!_kalshiSettlementSchemaOk) {
      await neonExec(ADD_KALSHI_SETTLEMENT_COLS_SQL, env);
      if (cache) cache.put(_kalshiSettlementSchemaKey, "1", { expirationTtl: 86400 * 30 }).catch(() => {});
    }
    // Own schema key (v7 is already flagged in prod, so its DDL block is skipped on live instances).
    const _polyPlaysSchemaKey = "shadow:schema:polyplays:v1";
    const _polyPlaysSchemaOk = cache ? await cache.get(_polyPlaysSchemaKey).catch(() => null) : null;
    if (!_polyPlaysSchemaOk) {
      await neonExec(CREATE_POLY_PLAYS_SQL, env);
      if (cache) cache.put(_polyPlaysSchemaKey, "1", { expirationTtl: 86400 * 30 }).catch(() => {});
    }

    // Try KV staging written by tonight cron — avoids the 55s re-fetch that hits the 60s wall-clock.
    let rawPlays = null;
    let _qualifiedCount = 0, _droppedCount = 0;
    let _schedule = null; // per-sport ESPN game counts stamped by tonight (coverage check)
    let _polyDeltas = null; // Polymarket cross-venue ML deltas (Phase 1a observatory)
    let _sbDeltas = null;   // Sportsbook-reference ML deltas (Phase 1a observatory)
    if (cache) {
      const _staged = await cache.get(`shadow:staging:${snapshotDate}`, "json").catch(() => null);
      if (_staged?.plays) {
        _qualifiedCount = _staged.plays.length;
        _droppedCount = _staged.dropped?.length ?? 0;
        _schedule = _staged.schedule || null;
        _polyDeltas = _staged.polymarketDeltas || null;
        _sbDeltas = _staged.sportsbookDeltas || null;
        console.log(`[shadow-snapshot] KV staging hit plays=${_qualifiedCount} dropped=${_droppedCount} ${Date.now() - t0}ms`);
        rawPlays = [..._staged.plays, ...(_staged.dropped || [])];
      }
    }
    if (!rawPlays) {
      const origin = selfOrigin(request);
      console.log(`[shadow-snapshot] fetching ${origin}/api/tonight`);
      let tonightResp;
      try {
        tonightResp = await fetch(`${origin}/api/tonight?debug=1`, {
          headers: { "x-shadow-internal": "1" },
          signal: AbortSignal.timeout(55_000),
        });
      } catch (fetchErr) {
        console.error(`[shadow-snapshot] tonight fetch failed: ${fetchErr?.message} ${Date.now() - t0}ms`);
        return errorResponse(`tonight fetch timed out — re-run manually: ${fetchErr?.message}`, 504);
      }
      console.log(`[shadow-snapshot] tonight status=${tonightResp.status} ${Date.now() - t0}ms`);
      if (!tonightResp.ok) return errorResponse(`tonight fetch failed: ${tonightResp.status}`, 502);
      const tonight = await tonightResp.json();
      _qualifiedCount = tonight.plays?.length ?? 0;
      _droppedCount = tonight.dropped?.length ?? 0;
      _polyDeltas = tonight.polymarketDeltas || null;
      _sbDeltas = tonight.sportsbookDeltas || null;
      console.log(`[shadow-snapshot] tonight parsed plays=${_qualifiedCount} dropped=${_droppedCount} ${Date.now() - t0}ms`);
      rawPlays = [...(tonight.plays || []), ...(tonight.dropped || [])];
    }

    // Filter: must have a computed truePct (OR be an explicit model-free maker candidate —
    // see project_maker_modelfree_clubsoccer_2026_07_23 memory), and game must be on today's
    // PT date.
    const plays = rawPlays.filter(p =>
      (p.modelFree === true || (typeof p.truePct === "number" && !isNaN(p.truePct))) &&
      (p.gameDate === snapshotDate || !p.gameDate)
    );

    if (!plays.length) {
      return jsonResponse({ ok: true, snapshotDate, logged: 0, durationMs: Date.now() - t0 });
    }

    annotateGroups(plays, snapshotDate);

    // Taker-flow stamp (xFlow* via p._flow → exogenousSignals): one public trades fetch
    // per distinct ticker. Failure-closed — any error logs and the snapshot proceeds
    // unstamped; this block must never break the shadow_plays write.
    let flowMeta = { tickers: 0, stamped: 0, ms: 0 };
    try {
      const _ft = Date.now();
      const _tickerOf = (p) => p.kalshiTicker ?? p._ticker ?? null;
      const flowTickers = [...new Set(plays.map(_tickerOf).filter(Boolean))];
      const flowMap = await fetchTradeFlow(flowTickers);
      let stamped = 0;
      for (const p of plays) {
        const f = flowMap.get(_tickerOf(p));
        if (f) { p._flow = f; stamped++; }
      }
      flowMeta = { tickers: flowTickers.length, stamped, rateLimited: flowMap.rateLimited === true, ms: Date.now() - _ft };
      console.log(`[shadow-snapshot] flow stamp tickers=${flowMeta.tickers} stamped=${stamped} rateLimited=${flowMeta.rateLimited} ${flowMeta.ms}ms`);
    } catch (e) {
      console.log(`[shadow-snapshot] flow stamp failed: ${e?.message ?? e}`);
    }

    const rows = plays.map(p => ({
      id: shadowId(p, snapshotDate),
      snapshot_date: snapshotDate,
      sport: p.sport || null,
      stat: p.stat || null,
      game_type: p.gameType || null,
      player_name: p.playerName || null,
      player_id: String(p.playerId || ""),
      // Game-type plays have homeTeam/awayTeam; qualified props have playerTeam/opponent;
      // early-dropped props only have gameTeam1/gameTeam2 from the Kalshi ticker.
      // The resolver only needs two team identifiers to find the ESPN game; order doesn't matter.
      home_team: p.homeTeam || p.playerTeam || p.gameTeam1 || null,
      away_team: p.awayTeam || p.opponent   || p.gameTeam2 || null,
      scoring_team: p.scoringTeam || null,
      pick_team: p.pickTeam || null,
      pick_line: p.pickLine ?? null,
      threshold: p.threshold ?? null,
      direction: p.direction || null,
      model_true_pct: p.modelFree ? null
        : (p.direction === "under" ? (p.noTruePct ?? parseFloat((100 - p.truePct).toFixed(1))) : p.truePct),
      model_free: p.modelFree === true,
      kalshi_pct: p.kalshiPct ?? null,
      no_kalshi_pct: p.noKalshiPct ?? null,
      edge: p.edge ?? null,
      dc: p.dataConfidence ?? null,
      dc_qualified: p.dcQualified ?? null,
      game_date: p.gameDate || null,
      // Null game_time when gameDate is unknown (Kalshi ticker null-date issue) for game-type
      // plays — the bare-fallback gameTimes value may point to a different day's game,
      // causing the resolver's /api/live time-prefix match to fail. Without a stored
      // game_time the resolver does a time-agnostic team lookup instead.
      game_time: (p.gameDate || !p.gameType) ? (p.gameTime || null) : null,
      kalshi_ticker: p.kalshiTicker ?? p._ticker ?? null,
      kalshi_side: deriveKalshiSide(p),
      group_id: p._gid,
      group_size: p._groupSize,
      threshold_rank: p._rank,
      is_best_edge: p._isBestEdge ?? null,
      snapshot_model_version: p.modelVersion || "v2",
      season_type: p.seasonType ?? null,
      features: extractFeatures(p),
      kalshi_yes_price: p.kalshiPct != null ? p.kalshiPct / 100 : null,
      kalshi_no_price: p.noKalshiPct != null ? p.noKalshiPct / 100 : null,
    }));

    console.log(`[shadow-snapshot] upserting ${rows.length} rows`);
    await neonBatchUpsert(SHADOW_TABLE, COLUMNS, rows, env);
    console.log(`[shadow-snapshot] upsert done ${Date.now() - t0}ms`);

    // Persist Polymarket cross-venue ML deltas into their own table (own try/catch — a poly
    // failure must never break the shadow_plays snapshot). One row per game-side per day.
    let polymarketLogged = 0;
    if (Array.isArray(_polyDeltas) && _polyDeltas.length) {
      try {
        const _pRows = _polyDeltas
          .filter(d => d && d.sport && d.game && d.side && d.market)
          .map(d => ({
            id: `${snapshotDate}|${d.sport}|${d.game}|${d.market}|${d.side}`,
            snapshot_date: snapshotDate,
            sport: d.sport,
            game: d.game,
            game_date: d.gameDate || null,
            market: d.market,
            side: d.side,
            kalshi_pct: d.kalshiPct ?? null,
            poly_pct: d.polyPct ?? null,
            delta_cents: d.deltaCents ?? null,
            model_true_pct: d.modelTruePct ?? null,
            poly_vwap_pct: d.polyVwapPct ?? null,
            poly_slip_cents: d.polySlipCents ?? null,
            exec_delta_cents: d.execDeltaCents ?? null,
          }));
        // Dedup by id WITHIN the batch — a matchup listed under two Poly ticker-dates collapses to
        // the same id, and ON CONFLICT DO UPDATE errors ("cannot affect row a second time") if one
        // INSERT carries the same conflict key twice. Prefer the row that carries exec (book-walked).
        const _byId = new Map();
        for (const r of _pRows) {
          const prev = _byId.get(r.id);
          if (!prev || (r.exec_delta_cents != null && prev.exec_delta_cents == null)) _byId.set(r.id, r);
        }
        const _pDedup = [..._byId.values()];
        // DO UPDATE (latest snapshot wins) so a later book-walk backfills exec onto an earlier row.
        await neonBatchUpsert(POLY_DELTAS_TABLE, POLY_DELTAS_COLUMNS, _pDedup, env, 100, [
          "kalshi_pct", "poly_pct", "delta_cents", "model_true_pct",
          "poly_vwap_pct", "poly_slip_cents", "exec_delta_cents",
        ]);
        polymarketLogged = _pDedup.length;
        console.log(`[shadow-snapshot] polymarket deltas upserted ${polymarketLogged}`);
      } catch (e) { console.error("[shadow-snapshot] polymarket deltas failed:", e?.message); }
    }

    // Persist sportsbook-reference ML deltas into their own table (own try/catch — a book failure
    // must never break the shadow_plays snapshot). One row per game-side per day.
    let sportsbookLogged = 0;
    if (Array.isArray(_sbDeltas) && _sbDeltas.length) {
      try {
        const _sRows = _sbDeltas
          .filter(d => d && d.sport && d.game && d.side && d.market)
          .map(d => ({
            id: `${snapshotDate}|${d.sport}|${d.game}|${d.market}|${d.side}`,
            snapshot_date: snapshotDate,
            sport: d.sport,
            game: d.game,
            game_date: d.gameDate || null,
            market: d.market,
            side: d.side,
            kalshi_pct: d.kalshiPct ?? null,
            book_fair_pct: d.bookFairPct ?? null,
            delta_cents: d.deltaCents ?? null,
            book: d.book || null,
            model_true_pct: d.modelTruePct ?? null,
          }));
        // Dedup by id within the batch (a matchup under two ticker-dates collapses to one id) before
        // the upsert, mirroring the poly path.
        const _sById = new Map();
        for (const r of _sRows) if (!_sById.has(r.id)) _sById.set(r.id, r);
        const _sDedup = [..._sById.values()];
        await neonBatchUpsert(SB_DELTAS_TABLE, SB_DELTAS_COLUMNS, _sDedup, env, 100, [
          "kalshi_pct", "book_fair_pct", "delta_cents", "book", "model_true_pct",
        ]);
        sportsbookLogged = _sDedup.length;
        console.log(`[shadow-snapshot] sportsbook deltas upserted ${sportsbookLogged}`);
      } catch (e) { console.error("[shadow-snapshot] sportsbook deltas failed:", e?.message); }
    }

    // Polymarket capture-all (2026-08-04) — logs every quoted game-ML/total/F5 side to its own
    // polymarket_plays table (Poly analog of shadow_plays). Own try/catch + its own Gamma+CLOB
    // fetches (independent of the ML-only staging deltas above); a Poly failure must never break
    // the shadow_plays snapshot. Graded later by the resolver's resolvePolymarketPlays pass.
    let polymarketPlaysLogged = 0;
    try {
      const _pc = await capturePolymarketPlays({ env, snapshotDate });
      polymarketPlaysLogged = _pc.logged;
    } catch (e) { console.error("[shadow-snapshot] polymarket capture failed:", e?.message); }

    // Coverage check: distinct games per sport in the logged rows vs the ESPN slate stamped
    // into staging by tonight. Warn-only at <80% — not every ESPN game has Kalshi markets,
    // and doubleheaders collapse to one game on the rows side (sorted-pair keying).
    // Catches whole-game gaps: parse bugs, Kalshi outages, emit-path regressions.
    // Only rows dated to the snapshot day count — null game_date rows are next-day
    // pre-listings or dateless module rows, not evidence today's game was captured.
    let coverage = null;
    let coverageWarning = false;
    if (_schedule) {
      const _gamesBySport = {};
      for (const r of rows) {
        if (!r.sport || !r.home_team || !r.away_team || r.game_date !== snapshotDate) continue;
        const pair = [r.home_team, r.away_team].sort().join(":");
        (_gamesBySport[r.sport] ??= new Set()).add(pair);
      }
      const _runCov = {};
      for (const [sp, scheduled] of Object.entries(_schedule)) {
        _runCov[sp] = { games: _gamesBySport[sp]?.size ?? 0, scheduled };
      }
      // Max-merge with the day's existing stamp (see mergeCoverage) so late/manual runs
      // over decayed staging can only add coverage, never erase it. Read failure → merge
      // with nothing, i.e. today's run stands alone (previous behavior).
      const _prevCov = cache ? await cache.get(`shadow:coverage:${snapshotDate}`, "json").catch(() => null) : null;
      ({ coverage, coverageWarning } = mergeCoverage(_prevCov?.coverage, _runCov));
      const _covStr = Object.entries(coverage).map(([sp, c]) => `${sp}=${c.games}/${c.scheduled}`).join(" ");
      if (coverageWarning) console.warn(`[shadow-snapshot] COVERAGE WARNING ${_covStr}`);
      else console.log(`[shadow-snapshot] coverage ${_covStr}`);
      // Persist for the model report's data-health header (read by date the morning after).
      if (cache) cache.put(`shadow:coverage:${snapshotDate}`, JSON.stringify({ coverage, coverageWarning, at: Date.now() }),
        { expirationTtl: 86400 * 3 }).catch(() => {});
    }

    // Refresh schema flag so next cron run skips DDL (30-day TTL, renewed on each success).
    if (cache) cache.put("shadow:schema:v7", "1", { expirationTtl: 86400 * 30 }).catch(() => {});

    return jsonResponse({
      ok: true,
      snapshotDate,
      logged: rows.length,
      polymarketLogged,
      polymarketPlaysLogged,
      sportsbookLogged,
      qualified: _qualifiedCount,
      dropped: _droppedCount,
      flow: flowMeta,
      coverage,
      coverageWarning,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    console.error("[shadow-snapshot] ERROR:", e?.message, e?.stack);
    return errorResponse(`snapshot failed: ${e?.message}`, 500);
  }
}

export { handleShadowSnapshot };
