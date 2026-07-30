// api/lib/handlers/shadow/deltas.js
// The Phase-1a observatory read endpoints: /api/polymarket-scan (Gamma league catalog diff),
// /api/polymarket-deltas and /api/sportsbook-deltas (multi-day cross-venue price-divergence
// distributions). Extracted verbatim from handlers/shadow.js during the handler split (zero
// behavior change). The delta TABLES are still written by the tonight cron; these only read.

import { neonQuery, neonExec } from "../../neon.js";
import { errorResponse, jsonResponse } from "../../utils.js";
import { verifyJWT } from "../../auth-utils.js";
import { POLY_SERIES, POLY_DISMISSED_SPORTS, fetchPolySportsCatalog, fetchPolySeriesEvents } from "../../polymarket.js";
import { POLY_DELTAS_TABLE, SB_DELTAS_TABLE } from "./common.js";

// ── /api/polymarket-scan ─────────────────────────────────────────────────────
// Daily cron. Diffs Polymarket's Gamma league catalog (GET /sports, ~300 rows) against the
// leagues the observatory consumes (POLY_SERIES) and records unknown ones in Neon
// (polymarket_sports_seen) — the Polymarket mirror of /api/kalshi-series-scan, same status
// funnel (baseline → new → shortlisted → adopted/dismissed). The FIRST run baseline-seeds every
// currently-listed league (silently acknowledged); only leagues Gamma adds AFTER today surface
// as 'new'. Per-league enrichment records the distinct sportsMarketType families seen in live
// events — that's where a new market family (e.g. total-corners) shows up, not a new funnel.
// Auth: CRON_SECRET (cron) or ADMIN_KEY (manual). ?dry=1 skips all DB writes.
// ?dismiss= / ?undismiss= / ?promote= / ?unpromote= (admin) triage by Gamma sport slug.
const POLY_SPORTS_TABLE = "polymarket_sports_seen";
async function handlePolymarketScan({ path, request, env }) {
  if (path !== "polymarket-scan") return null;
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isCron  = env?.CRON_SECRET && bearer === env.CRON_SECRET;
  const isAdmin = env?.ADMIN_KEY  && bearer === env.ADMIN_KEY;
  if (!isCron && !isAdmin) return errorResponse("Forbidden", 403);
  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);
  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";

  await neonExec(`
    CREATE TABLE IF NOT EXISTS ${POLY_SPORTS_TABLE} (
      sport            TEXT PRIMARY KEY,
      series_id        TEXT,
      tags             TEXT,
      sample_event     TEXT,
      live_event_count INT,
      market_types     TEXT,
      status           TEXT NOT NULL DEFAULT 'new',
      first_seen       DATE NOT NULL,
      last_seen        DATE NOT NULL
    )
  `, env);

  // Admin triage shortcuts (mirror of kalshi-series-scan; keyed by Gamma sport slug).
  const dismiss = url.searchParams.get("dismiss");
  const undismiss = url.searchParams.get("undismiss");
  const promote = url.searchParams.get("promote");
  const unpromote = url.searchParams.get("unpromote");
  if (dismiss || undismiss || promote || unpromote) {
    if (!isAdmin) return errorResponse("Admin only", 403);
    if (dismiss) await neonQuery(`UPDATE ${POLY_SPORTS_TABLE} SET status='dismissed' WHERE sport = $1`, [dismiss], env, { write: true });
    if (undismiss) await neonQuery(`UPDATE ${POLY_SPORTS_TABLE} SET status='new' WHERE sport = $1 AND status='dismissed'`, [undismiss], env, { write: true });
    if (promote) await neonQuery(`UPDATE ${POLY_SPORTS_TABLE} SET status='shortlisted' WHERE sport = $1 AND status IN ('new','dismissed','baseline')`, [promote], env, { write: true });
    if (unpromote) await neonQuery(`UPDATE ${POLY_SPORTS_TABLE} SET status='new' WHERE sport = $1 AND status='shortlisted'`, [unpromote], env, { write: true });
    return jsonResponse({ ok: true, dismissed: dismiss || null, undismissed: undismiss || null, promoted: promote || null, unpromoted: unpromote || null });
  }

  // 1. League catalog (single call; module is failure-closed to []).
  const catalog = await fetchPolySportsCatalog();
  if (!catalog.length) return errorResponse("Empty Gamma sports catalog", 502);

  // 2. Leagues the observatory consumes (slug or Gamma series id — both count as known).
  const knownSlugs = new Set(Object.keys(POLY_SERIES));
  const knownSeriesIds = new Set(Object.values(POLY_SERIES).map(String));

  // 3. Slugs already recorded. {write:true} → pooled primary for read-after-create consistency.
  const existingRows = await neonQuery(`SELECT sport FROM ${POLY_SPORTS_TABLE}`, [], env, { write: true });
  const existing = new Set(existingRows.map(r => r.sport));
  const isFirstRun = existing.size === 0;

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  // 4. Classify slugs new to the table (the catalog can repeat a slug — first row wins).
  const seen = new Set();
  const toInsert = [];
  const enrichTargets = [];
  for (const s of catalog) {
    const slug = String(s.sport || "").toLowerCase();
    if (!slug || seen.has(slug) || existing.has(slug)) continue;
    seen.add(slug);
    const isKnown = knownSlugs.has(slug) || knownSeriesIds.has(String(s.series ?? ""));
    const status = isKnown ? "adopted" : (isFirstRun ? "baseline" : "new");
    const row = {
      sport: slug,
      series_id: s.series != null ? String(s.series) : null,
      tags: s.tags != null ? String(s.tags) : null,
      sample_event: null, live_event_count: null, market_types: null,
      status, first_seen: today, last_seen: today,
    };
    toInsert.push(row);
    if (status === "new") enrichTargets.push(row);
  }

  // Enrich one league: sample event + live event count + distinct market families. Best-effort;
  // null on fetch failure (never overwrites a prior read with a fake zero).
  const enrichPolySport = async (seriesId) => {
    if (!seriesId) return null;
    const events = await fetchPolySeriesEvents(seriesId, 25);
    if (!events) return null;
    const types = new Set();
    for (const ev of events) for (const m of (ev?.markets || [])) if (m?.sportsMarketType) types.add(m.sportsMarketType);
    return {
      sample_event: events[0]?.title ?? null,
      live_event_count: events.length,
      market_types: types.size ? [...types].sort().join(",") : null,
    };
  };
  const mapPool = async (items, concurrency, fn) => {
    let i = 0;
    const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  };

  // 5. Enrich genuinely-new rows (capped, parallel, best-effort).
  const ENRICH_CAP = 25;
  await mapPool(enrichTargets.slice(0, ENRICH_CAP), 3, async (row) => {
    const e = await enrichPolySport(row.series_id);
    if (e) Object.assign(row, e);
  });

  if (dry) {
    return jsonResponse({
      ok: true, dry: true, isFirstRun,
      catalogCount: catalog.length, existingCount: existing.size,
      toInsertCount: toInsert.length, newCount: enrichTargets.length,
      newMarkets: enrichTargets.slice(0, ENRICH_CAP).map(r => ({ sport: r.sport, sampleEvent: r.sample_event, marketTypes: r.market_types })),
    });
  }

  // 6a. Batch-insert new-to-table rows.
  const COLS = ["sport","series_id","tags","sample_event","live_event_count","market_types","status","first_seen","last_seen"];
  for (let i = 0; i < toInsert.length; i += 100) {
    const chunk = toInsert.slice(i, i + 100);
    const placeholders = chunk.map((_, ri) =>
      `(${COLS.map((_, ci) => `$${ri * COLS.length + ci + 1}`).join(", ")})`
    ).join(", ");
    const values = chunk.flatMap(row => COLS.map(c => row[c] ?? null));
    await neonQuery(
      `INSERT INTO ${POLY_SPORTS_TABLE} (${COLS.join(", ")}) VALUES ${placeholders} ON CONFLICT (sport) DO NOTHING`,
      values, env, { write: true }
    );
  }

  // 6b. Reconcile: slug since added to POLY_SERIES → adopted; vetted-and-rejected in code
  // (POLY_DISMISSED_SPORTS) → dismissed. Same self-clearing funnel as the Kalshi scan.
  const knownArr = [...knownSlugs];
  const knownPh = knownArr.map((_, i) => `$${i + 1}`).join(", ");
  await neonQuery(
    `UPDATE ${POLY_SPORTS_TABLE} SET status='adopted' WHERE status IN ('new','shortlisted') AND sport IN (${knownPh})`,
    knownArr, env, { write: true }
  );
  if (POLY_DISMISSED_SPORTS.length) {
    const dismPh = POLY_DISMISSED_SPORTS.map((_, i) => `$${i + 1}`).join(", ");
    await neonQuery(
      `UPDATE ${POLY_SPORTS_TABLE} SET status='dismissed' WHERE status IN ('new','shortlisted') AND sport IN (${dismPh})`,
      [...POLY_DISMISSED_SPORTS], env, { write: true }
    );
  }

  // 6c. Refresh enrichment for existing new/shortlisted rows so triage hints track current
  // liquidity, not first-seen (first_seen DESC matches the report's display order). Best-effort.
  const refreshRows = await neonQuery(
    `SELECT sport, series_id FROM ${POLY_SPORTS_TABLE} WHERE status IN ('new','shortlisted')
     ORDER BY first_seen DESC, sport LIMIT 60`,
    [], env, { write: true }
  );
  await mapPool(refreshRows, 3, async (r) => {
    const e = await enrichPolySport(r.series_id);
    if (e) await neonQuery(
      `UPDATE ${POLY_SPORTS_TABLE} SET sample_event=$2, live_event_count=$3, market_types=$4 WHERE sport = $1`,
      [r.sport, e.sample_event, e.live_event_count, e.market_types], env, { write: true }
    );
  });

  return jsonResponse({
    ok: true, isFirstRun, catalogCount: catalog.length,
    inserted: toInsert.length, newCount: enrichTargets.length, refreshed: refreshRows.length,
    newSports: enrichTargets.map(r => r.sport),
  });
}

// GET /api/polymarket-deltas — multi-day Kalshi-vs-Polymarket ML divergence distribution (Phase 1a
// observatory read). The kill-gate surface: does the gap persist + cluster, or is it noise? Auth:
// ADMIN_KEY or valid JWT. Params: ?days=N (default 30) ?sport=. Returns overall + in-window [67,91]
// + per-sport + a daily series. delta_cents = poly − kalshi (mean_signed = systematic venue bias).
async function handlePolymarketDeltas({ path, request, env }) {
  if (path !== "polymarket-deltas") return null;
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;
  let isUser = false;
  if (!isAdmin && bearer) { try { isUser = !!(await verifyJWT(bearer, env?.JWT_SECRET)); } catch {} }
  if (!isAdmin && !isUser) return errorResponse("Forbidden", 403);
  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1), 365);
  const sport = url.searchParams.get("sport");
  const sportFilter = sport ? " AND sport = $2" : "";
  const params = sport ? [days, sport] : [days];
  const num = (x) => x == null ? null : Number(Number(x).toFixed(3));

  const aggSql = (extra) => `
    SELECT count(*)::int AS n, count(distinct snapshot_date)::int AS days,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(delta_cents)) AS p90_abs,
      max(abs(delta_cents)) AS max_abs, avg(delta_cents) AS mean_signed,
      avg(CASE WHEN abs(delta_cents) >= 5 THEN 1.0 ELSE 0 END) AS frac_ge5,
      avg(CASE WHEN abs(delta_cents) >= 3 THEN 1.0 ELSE 0 END) AS frac_ge3
    FROM ${POLY_DELTAS_TABLE}
    WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}${extra}`;
  const fmtAgg = (r) => r ? {
    n: r.n, days: r.days, medianAbs: num(r.median_abs), p90Abs: num(r.p90_abs), maxAbs: num(r.max_abs),
    meanSigned: num(r.mean_signed), fracGe5c: num(r.frac_ge5), fracGe3c: num(r.frac_ge3),
  } : null;

  try {
    const [overall] = await neonQuery(aggSql(""), params, env, { write: true });
    const [inWindow] = await neonQuery(aggSql(" AND kalshi_pct >= 67 AND kalshi_pct <= 91"), params, env, { write: true });
    const bySport = await neonQuery(`
      SELECT sport, count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        max(abs(delta_cents)) AS max_abs, avg(delta_cents) AS mean_signed
      FROM ${POLY_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
      GROUP BY sport ORDER BY n DESC`, params, env, { write: true });
    const daily = await neonQuery(`
      SELECT snapshot_date, count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs
      FROM ${POLY_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
      GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 30`, params, env, { write: true });
    // Executable read (book-walked bettable sides). exec_delta = poly_vwap − kalshi; ≤−3 means
    // Polymarket is still ≥3¢ cheaper to BUY after slippage = surviving edge. THIS is the kill-gate.
    const [exec] = await neonQuery(`
      SELECT count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(exec_delta_cents)) AS median_abs,
        avg(exec_delta_cents) AS mean_signed,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY poly_slip_cents) AS median_slip,
        avg(CASE WHEN exec_delta_cents <= -3 THEN 1.0 ELSE 0 END) AS frac_edge3,
        avg(CASE WHEN exec_delta_cents <= -5 THEN 1.0 ELSE 0 END) AS frac_edge5
      FROM ${POLY_DELTAS_TABLE}
      WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter} AND exec_delta_cents IS NOT NULL`, params, env, { write: true });

    return jsonResponse({
      ok: true, days, sport: sport || "all",
      overall: fmtAgg(overall),
      inWindow6791: fmtAgg(inWindow),
      exec: exec ? {
        n: exec.n, medianAbs: num(exec.median_abs), meanSigned: num(exec.mean_signed),
        medianSlipCents: num(exec.median_slip), fracEdgeGe3c: num(exec.frac_edge3), fracEdgeGe5c: num(exec.frac_edge5),
      } : null,
      bySport: bySport.map(r => ({ sport: r.sport, n: r.n, medianAbs: num(r.median_abs), maxAbs: num(r.max_abs), meanSigned: num(r.mean_signed) })),
      daily: daily.map(r => ({ date: new Date(r.snapshot_date).toISOString().slice(0, 10), n: r.n, medianAbs: num(r.median_abs) })),
    });
  } catch (e) {
    return errorResponse(`polymarket-deltas query failed: ${e?.message}`, 500);
  }
}

// GET /api/sportsbook-deltas — multi-day Kalshi-vs-sharp-book ML divergence distribution (Phase 1a
// observatory read). THE kill-gate surface: does Kalshi systematically LAG the de-vigged sharp book
// (a timeable edge), or track it (no edge)? Auth: ADMIN_KEY or JWT. Params: ?days=N (default 30)
// ?sport=. ?minAbs=N adds a `rows` tail dump (|delta| ≥ N¢, biggest first, LIMIT 200) for auditing
// outliers — a huge delta on a liquid ML is either a game-matching bug or a real thin-market signal.
// ?purge=all (ADMIN only) wipes the table for a clean re-baseline after a data-quality fix.
// delta_cents = book_fair − kalshi; mean_signed > 0 = Kalshi systematically cheap vs the
// book (the directional edge); frac_ge3c/5c = how often the gap is actionable-sized.
async function handleSportsbookDeltas({ path, request, env }) {
  if (path !== "sportsbook-deltas") return null;
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;
  let isUser = false;
  if (!isAdmin && bearer) { try { isUser = !!(await verifyJWT(bearer, env?.JWT_SECRET)); } catch {} }
  if (!isAdmin && !isUser) return errorResponse("Forbidden", 403);
  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const url = new URL(request.url);

  // ?purge=all — wipe the observatory table for a clean re-baseline (ADMIN key only, not JWT).
  // Used 2026-07-01: the first 3 days were contaminated by the UTC-date/±1-day series mismatch.
  if (url.searchParams.get("purge") === "all") {
    if (!isAdmin) return errorResponse("Forbidden", 403);
    try {
      await neonQuery(`DELETE FROM ${SB_DELTAS_TABLE}`, [], env, { write: true });
      return jsonResponse({ ok: true, purged: true });
    } catch (e) { return errorResponse(`purge failed: ${e?.message}`, 500); }
  }

  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1), 365);
  const sport = url.searchParams.get("sport");
  const sportFilter = sport ? " AND sport = $2" : "";
  const params = sport ? [days, sport] : [days];
  const num = (x) => x == null ? null : Number(Number(x).toFixed(3));

  const aggSql = (extra) => `
    SELECT count(*)::int AS n, count(distinct snapshot_date)::int AS days,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(delta_cents)) AS p90_abs,
      max(abs(delta_cents)) AS max_abs, avg(delta_cents) AS mean_signed,
      avg(CASE WHEN abs(delta_cents) >= 5 THEN 1.0 ELSE 0 END) AS frac_ge5,
      avg(CASE WHEN abs(delta_cents) >= 3 THEN 1.0 ELSE 0 END) AS frac_ge3
    FROM ${SB_DELTAS_TABLE}
    WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}${extra}`;
  const minAbsRaw = parseFloat(url.searchParams.get("minAbs"));
  const minAbs = Number.isFinite(minAbsRaw) && minAbsRaw >= 0 ? minAbsRaw : null;
  const fmtAgg = (r) => r ? {
    n: r.n, days: r.days, medianAbs: num(r.median_abs), p90Abs: num(r.p90_abs), maxAbs: num(r.max_abs),
    meanSigned: num(r.mean_signed), fracGe5c: num(r.frac_ge5), fracGe3c: num(r.frac_ge3),
  } : null;

  try {
    const [overall] = await neonQuery(aggSql(""), params, env, { write: true });
    const [inWindow] = await neonQuery(aggSql(" AND kalshi_pct >= 67 AND kalshi_pct <= 91"), params, env, { write: true });
    const bySport = await neonQuery(`
      SELECT sport, count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        max(abs(delta_cents)) AS max_abs, avg(delta_cents) AS mean_signed
      FROM ${SB_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
      GROUP BY sport ORDER BY n DESC`, params, env, { write: true });
    const daily = await neonQuery(`
      SELECT snapshot_date, count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        avg(delta_cents) AS mean_signed
      FROM ${SB_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
      GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 30`, params, env, { write: true });
    const tailRows = minAbs == null ? null : await neonQuery(`
      SELECT snapshot_date, sport, game, game_date, market, side,
        kalshi_pct, book_fair_pct, delta_cents, book, model_true_pct
      FROM ${SB_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
        AND abs(delta_cents) >= $${params.length + 1}
      ORDER BY abs(delta_cents) DESC LIMIT 200`, [...params, minAbs], env, { write: true });

    return jsonResponse({
      ok: true, days, sport: sport || "all",
      overall: fmtAgg(overall),
      inWindow6791: fmtAgg(inWindow),
      bySport: bySport.map(r => ({ sport: r.sport, n: r.n, medianAbs: num(r.median_abs), maxAbs: num(r.max_abs), meanSigned: num(r.mean_signed) })),
      daily: daily.map(r => ({ date: new Date(r.snapshot_date).toISOString().slice(0, 10), n: r.n, medianAbs: num(r.median_abs), meanSigned: num(r.mean_signed) })),
      ...(tailRows ? { minAbs, rows: tailRows.map(r => ({
        date: new Date(r.snapshot_date).toISOString().slice(0, 10), sport: r.sport, game: r.game,
        gameDate: r.game_date, market: r.market, side: r.side, kalshiPct: num(r.kalshi_pct),
        bookFairPct: num(r.book_fair_pct), deltaCents: num(r.delta_cents), book: r.book,
        modelTruePct: num(r.model_true_pct),
      })) } : {}),
    });
  } catch (e) {
    return errorResponse(`sportsbook-deltas query failed: ${e?.message}`, 500);
  }
}

export { handlePolymarketScan, handlePolymarketDeltas, handleSportsbookDeltas };
