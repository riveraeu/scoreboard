// api/lib/handlers/shadow/resolver.js
// /api/shadow-resolver (grades yesterday's shadow_plays vs ESPN + Kalshi settlement) and
// /api/kalshi-dryrun-check (settlement-vs-ESPN agreement audit), plus resolveOpenMakerPositions
// (called on the kalshi-snapshot cron tick). Extracted verbatim from handlers/shadow.js during the
// handler split (zero behavior change). ESPN resolution helpers + resolution KV live in ./common.js.

import { neonQuery, neonBatchResolve } from "../../neon.js";
import { errorResponse, jsonResponse, selfOrigin } from "../../utils.js";
import { detectAndGradeMakerFills } from "../../maker.js";
import { reconcileLiveMakerFills } from "../../maker-live.js";
// MODEL_FREE_LEAGUE_KEYS is retained (not leagueSource): it still scopes the model-free leagues
// OUT of the ESPN teamRows path in _ownResolverSports below. Their ESPN resolver block was deleted
// 2026-07-30 (Phase B) — they grade off Kalshi settlement only.
import { MODEL_FREE_LEAGUE_KEYS } from "../../model-free-leagues.js";
import { fetchKalshiSettlements, fetchKalshiSettlementsWithMeta, resolveRowViaKalshi, classifyRowViaKalshi } from "../../kalshi-settlement.js";
import { reconcileGrades, isSettlementAuthoritative, isMakeupReattributed, isNonFinalTerminal, SETTLEMENT_AUTHORITATIVE_SPORTS, SETTLEMENT_CUTOVER_DATE } from "../../settlement-reconcile.js";
import { kalshiTickerDate } from "../../kalshi-ticker.js";
import {
  SHADOW_TABLE, _resolveRow,
  _RESOLUTION_SQL, _parseResolutionRow, _RESOLUTION_KV_PREFIX, _stampResolutionFloor,
} from "./common.js";

// ── Shadow Resolver ──────────────────────────────────────────────────────────


// Fetch final boxscores from /api/live for one game_date into liveByKey.
// On the early-morning resolver crons (2am/3:05am PT) the function is COLD, so the first
// internal fetch to /api/live (itself a cold function + ESPN round-trip) can blow past the
// timeout and abort. That abort used to be swallowed by an empty `catch {}`, leaving every
// row noData (resolved≈0) until something warmed the stack hours later. So: a generous
// timeout, one retry on abort/non-OK (the failed first call warms /api/live → the retry
// lands), and errors are logged, never swallowed.
async function fetchLiveInto(liveByKey, origin, game_date, gamesParam, tbParam, timeoutMs) {
  const url = `${origin}/api/live?games=${encodeURIComponent(gamesParam)}&date=${game_date}${tbParam}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "shadow-resolver/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.error(`[shadow-resolver] live fetch ${res.status} (attempt ${attempt + 1}, date ${game_date})`);
        continue; // retry once on non-OK
      }
      // Non-JSON = we were served an interstitial (Vercel SSO / challenge page), not /api/live.
      // Name the host so the misroute is obvious in logs instead of a JSON parse error.
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("json")) {
        console.error(`[shadow-resolver] live fetch non-JSON (${ctype || "no content-type"}) from ${new URL(url).host} (attempt ${attempt + 1}, date ${game_date})`);
        continue;
      }
      const data = await res.json();
      for (const [k, v] of Object.entries(data)) liveByKey.set(`${k}|${game_date}`, v);
      return;
    } catch (e) {
      console.error(`[shadow-resolver] live fetch failed (attempt ${attempt + 1}, date ${game_date}): ${e?.message}`);
    }
  }
}

// Real-money V2 fast path (2026-07-22) — the main resolver below deliberately only resolves
// rows from PRIOR days (`game_date < today`, since today's games may still be in progress), so
// a V2 position whose game already finished TODAY sits ungraded until the next scheduled
// shadow-resolver run (2am/3:05am/5:50am PT) — real Kalshi money is already settled hours
// before our own PnL tile reflects it. Rather than touch that shared date filter (it drives
// resolution for every sport/market, not just V2), this is a narrow, V2-scoped path: find
// shadow_plays rows backing currently-open, ungraded V2 positions and resolve them the moment
// their game goes final, using the exact same /api/live + _resolveRow machinery as the main
// resolver — a still-in-progress game safely no-ops via _resolveRow's own `state !== "post"`
// gate, so this carries no more resolution risk than the main path already does. Scoped to
// team-row-shaped markets only (props/totals/spreads via /api/live) — everything V2 currently
// quotes (its eligible universe is entirely MLB/WNBA team-shaped markets); tennis/soccer/etc.
// use different feeds and aren't in MAKER_V2_BAND's universe, so they're out of scope here.
// Called from the 2min kalshi-snapshot cron tick, right after updateLiveMakerOrders.
export async function resolveOpenMakerPositions({ env, request }) {
  const rows = await neonQuery(
    `SELECT s.id, s.sport, s.stat, s.game_type, s.player_name, s.home_team, s.away_team,
            s.scoring_team, s.pick_team, s.pick_line, s.threshold, s.direction,
            s.game_date, s.game_time, s.features, s.snapshot_date
     FROM shadow_plays s
     JOIN maker_orders_v2 mo ON mo.shadow_row_id = s.id
     WHERE mo.status = 'executed' AND mo.graded_at IS NULL AND s.resolved = FALSE
       AND s.home_team IS NOT NULL AND s.away_team IS NOT NULL`,
    [], env, { write: true }
  );
  if (!rows.length) return { checked: 0, resolved: 0, skipped: 0, noData: 0 };

  const keysByDate = new Map(); // effectiveDate → Set<rawKey>
  const rowToKey = new Map();   // row.id → { rawKey, effectiveDate }
  for (const row of rows) {
    const { sport, home_team, away_team, game_time } = row;
    const effectiveDate = row.game_date
      || (row.game_time ? new Date(row.game_time).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) : null)
      || (row.snapshot_date ? new Date(row.snapshot_date).toISOString().slice(0, 10) : null);
    let rawKey = `${sport}:${away_team}:${home_team}`;
    if (game_time) rawKey += `@${game_time}`;
    rowToKey.set(row.id, { rawKey, effectiveDate });
    if (!keysByDate.has(effectiveDate)) keysByDate.set(effectiveDate, new Set());
    keysByDate.get(effectiveDate).add(rawKey);
  }

  const liveByKey = new Map();
  const origin = selfOrigin(request);
  const tbParam = rows.some(r => r.stat === "totalBases") ? "&tb=1" : "";
  await Promise.all([...keysByDate.entries()].map(([game_date, keys]) =>
    fetchLiveInto(liveByKey, origin, game_date, [...keys].join(","), tbParam, 12_000)
  ));

  const updates = [];
  let noData = 0, skipped = 0;
  for (const row of rows) {
    const { rawKey, effectiveDate } = rowToKey.get(row.id);
    let game = liveByKey.get(`${rawKey}|${effectiveDate}`);
    if (game?.state === "unknown") {
      const atIdx = rawKey.indexOf("@");
      if (atIdx !== -1) {
        const baseKey = rawKey.slice(0, atIdx);
        game = liveByKey.get(`${baseKey}|${effectiveDate}`) ?? game;
      }
    }
    if (!game || game.state === "unknown") { noData++; continue; }
    const result = _resolveRow(row, game);
    if (result === null) { skipped++; continue; } // not final yet (or void) — safe no-op
    updates.push({ id: row.id, won: result.won, actualValue: result.actualValue });
  }
  if (updates.length) await neonBatchResolve(updates, env);
  return { checked: rows.length, resolved: updates.length, skipped, noData };
}

// ── /api/kalshi-dryrun-check ─────────────────────────────────────────────────
// Standing read-only diagnostic (added 2026-07-24): recomputes the Kalshi-settlement dry-run
// agreement check (see kalshi-settlement.js and project_kalshi_settlement_grading_2026_07_23
// memory) on demand against every already-ESPN-graded row that carries a kalshi_ticker, instead
// of depending on catching a resolver cron's console.log output within Vercel's log retention
// window. ADMIN_KEY only; GET, no DB writes — mirrors /api/kalshi-check's idiom. Same functions
// the resolver's own dry-run pass uses (fetchKalshiSettlements/resolveRowViaKalshi), just called
// standalone. `won` on shadow_plays is ESPN's verdict (existing resolvers); this endpoint never
// writes it, purely a comparison surface. `?funnel=1` breaks the two WHERE conditions
// (kalshi_ticker capture vs ESPN resolution) apart instead of just their intersection, plus a
// per-game_date and per-sport(last 7d) ticker-coverage breakdown — explains a low `checked` count.
async function handleKalshiDryrunCheck({ path, request, env }) {
  if (path !== "kalshi-dryrun-check") return null;

  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  if (!env?.ADMIN_KEY || bearer !== env.ADMIN_KEY) return errorResponse("Forbidden", 403);

  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  // ?funnel=1 — explains a low `checked` count: breaks the WHERE clause's two conditions apart
  // (kalshi_ticker capture vs ESPN resolution) instead of just reporting their intersection.
  if (new URL(request.url).searchParams.get("funnel") === "1") {
    const [overall, byDate, byGate] = await Promise.all([
      neonQuery(`
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE kalshi_ticker IS NOT NULL)::int AS has_ticker,
          COUNT(*) FILTER (WHERE resolved)::int AS resolved,
          COUNT(*) FILTER (WHERE won IS NOT NULL)::int AS has_won,
          COUNT(*) FILTER (WHERE resolved AND won IS NULL)::int AS resolved_but_void,
          COUNT(*) FILTER (WHERE kalshi_ticker IS NOT NULL AND won IS NOT NULL)::int AS both
        FROM ${SHADOW_TABLE}`, [], env),
      neonQuery(`
        SELECT game_date,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE kalshi_ticker IS NOT NULL)::int AS has_ticker
        FROM ${SHADOW_TABLE}
        GROUP BY game_date ORDER BY game_date DESC LIMIT 10`, [], env),
      neonQuery(`
        SELECT sport,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE kalshi_ticker IS NOT NULL)::int AS has_ticker
        FROM ${SHADOW_TABLE}
        WHERE game_date >= to_char(CURRENT_DATE - 7, 'YYYY-MM-DD')
        GROUP BY sport ORDER BY total DESC`, [], env),
    ]);
    // Granular (sport, game_type, stat) breakdown for the one date that actually has ANY ticket
    // capture — distinguishes "whole sport missing entirely" from "rows exist but kalshi_ticker
    // is null on all of them" (the latter is a real code gap, not a capture-frequency problem).
    const byCategory = await neonQuery(`
      SELECT sport, game_type, stat,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE kalshi_ticker IS NOT NULL)::int AS has_ticker
      FROM ${SHADOW_TABLE}
      WHERE game_date = (SELECT MAX(game_date) FROM ${SHADOW_TABLE} WHERE kalshi_ticker IS NOT NULL)
      GROUP BY sport, game_type, stat ORDER BY total DESC`, [], env);
    return jsonResponse({ ok: true, overall: overall[0], byDate, last7dBySport: byGate, byCategoryOnLastTickeredDate: byCategory });
  }

  const rows = await neonQuery(
    `SELECT id, sport, stat, kalshi_ticker, kalshi_side, won, game_date, resolved_at
     FROM ${SHADOW_TABLE}
     WHERE kalshi_ticker IS NOT NULL AND won IS NOT NULL
     ORDER BY game_date DESC`,
    [], env
  );

  if (!rows.length) {
    return jsonResponse({ ok: true, checked: 0, incomplete: false, wouldResolve: 0, comparedAgainstEspn: 0, agree: 0, disagree: 0, bySport: {}, disagreements: [] });
  }

  const tickers = [...new Set(rows.map(r => r.kalshi_ticker))];
  const { settlements, meta: settlementFetch } = await fetchKalshiSettlementsWithMeta(tickers);

  // ── Circularity guard (2026-07-25) ── this endpoint compares each row's STORED `won` against
  // Kalshi's settlement. For a SETTLEMENT_AUTHORITATIVE_SPORTS row resolved on/after the cutover,
  // `won` was written BY that same settlement — so it agrees by construction and would silently
  // inflate the headline agreement rate with a tautology. Those rows are counted separately under
  // `circular` and excluded from the real comparison. Pre-cutover rows of the same sports still
  // carry genuine ESPN grades, so they stay in.
  const isCircular = (r) => {
    if (!isSettlementAuthoritative(r.sport)) return false;
    if (!r.resolved_at) return false;
    return new Date(r.resolved_at).toISOString().slice(0, 10) >= SETTLEMENT_CUTOVER_DATE;
  };

  let wouldResolve = 0, agree = 0, disagree = 0, circular = 0;
  const bySport = new Map();
  const circularBySport = new Map();
  const disagreements = [];
  for (const r of rows) {
    const kalshiWon = resolveRowViaKalshi(r, settlements);
    if (kalshiWon === null) continue;
    wouldResolve++;
    if (isCircular(r)) {
      circular++;
      circularBySport.set(r.sport, (circularBySport.get(r.sport) || 0) + 1);
      continue;
    }
    const rec = bySport.get(r.sport) || { agree: 0, disagree: 0 };
    if (r.won === kalshiWon) { agree++; rec.agree++; }
    else {
      disagree++; rec.disagree++;
      if (disagreements.length < 20) {
        disagreements.push({ id: r.id, sport: r.sport, stat: r.stat, ticker: r.kalshi_ticker, side: r.kalshi_side, espnWon: r.won, kalshiWon, gameDate: r.game_date ? new Date(r.game_date).toISOString().slice(0, 10) : null });
      }
    }
    bySport.set(r.sport, rec);
  }

  return jsonResponse({
    ok: true,
    checked: rows.length,
    settlementsFound: settlements.size,
    // Fetch health (2026-07-26). Before this existed, a silently-dropped 200-ticker chunk shrank
    // the denominators at random and could hide a real disagreement — one run reported disagree=0
    // purely because the chunk holding the known bad settlement was never fetched. Treat
    // `incomplete: true` as "this run didn't look at everything", not as a clean bill of health.
    settlementFetch,
    incomplete: settlementFetch.chunksFailed > 0,
    wouldResolve,
    comparedAgainstEspn: agree + disagree,
    agree,
    disagree,
    bySport: Object.fromEntries(bySport),
    disagreements,
    // Rows whose `won` the settlement grader itself wrote — agreement is tautological, so they are
    // excluded from the numbers above. Growth here is expected post-cutover, not a problem.
    circular: {
      excluded: circular,
      bySport: Object.fromEntries(circularBySport),
      cutoverDate: SETTLEMENT_CUTOVER_DATE,
      authoritativeSports: [...SETTLEMENT_AUTHORITATIVE_SPORTS],
    },
  });
}

async function handleShadowResolver({ path, request, env, cache }) {
  if (path !== "shadow-resolver") return null;

  if (!env?.CRON_SECRET) return errorResponse("CRON_SECRET not set", 500);
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  if (auth !== env.CRON_SECRET) return errorResponse("Forbidden", 403);

  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const t0 = Date.now();

  // Only resolve rows from prior days (today's games may not be finished).
  // COALESCE(game_date, snapshot_date::varchar) handles early-dropped prop rows
  // that lack game_date — snapshot_date (3pm PT) is the same calendar day as the game.
  // write:true — must read the pooled primary. The unpooled conn may be a read-only
  // replica that returns 0 rows on cold wake (2026-06-11: both morning crons missed
  // all 1051 of the prior day's rows).
  // Abandon rows that have sat unresolved for 14+ days (postponed games, unparseable
  // teams — permanent noData). resolved=TRUE with won=NULL exits them from this scan
  // without polluting calibration (which filters won IS NOT NULL). Without this they
  // accumulate (~17/day) and, since the SELECT below is LIMIT-bounded, could eventually
  // starve fresh rows.
  const abandoned = await neonQuery(
    `UPDATE shadow_plays SET resolved = TRUE, resolved_at = NOW()
     WHERE resolved = FALSE
       AND COALESCE(game_date, snapshot_date::varchar) < $1
     RETURNING id`,
    [new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)],
    env,
    { write: true }
  ).catch((e) => {
    console.error(`[shadow-resolver] abandon UPDATE failed: ${e?.message}`);
    return [];
  });
  if (abandoned.length) console.log(`[shadow-resolver] abandoned=${abandoned.length} (unresolved >14d)`);

  // ORDER BY newest first: if backlog ever exceeds the LIMIT, fresh rows (still
  // resolvable) win over old strays rather than Postgres picking arbitrarily.
  const rows = await neonQuery(
    `SELECT id, sport, stat, game_type, player_name, home_team, away_team,
            scoring_team, pick_team, pick_line, threshold, direction,
            game_date, game_time, features, snapshot_date, kalshi_ticker, kalshi_side
     FROM shadow_plays
     WHERE resolved = FALSE
       AND COALESCE(game_date, snapshot_date::varchar) < $1
       AND home_team IS NOT NULL
       AND away_team IS NOT NULL
     ORDER BY snapshot_date DESC
     LIMIT 2000`,
    [today],
    env,
    { write: true }
  );

  console.log(`[shadow-resolver] rows=${rows.length} selectMs=${Date.now() - t0}`);

  if (!rows.length) {
    return jsonResponse({ ok: true, resolved: 0, skipped: 0, noData: 0, durationMs: Date.now() - t0 });
  }

  // ── Kalshi-settlement grading (2026-07-23 dry-run → 2026-07-25 AUTHORITATIVE for the
  // shadow-only families in SETTLEMENT_AUTHORITATIVE_SPORTS; see kalshi-settlement.js,
  // settlement-reconcile.js, and project_kalshi_missettlement_watch_2026_07_25 memory).
  //
  // One pass classifies every row carrying a kalshi_ticker, then splits three ways:
  //   • authoritative sport + finalized binary  → `settlementGraded`, wins over ESPN at the
  //     reconcile chokepoint below (ESPN still runs on these rows, so disagreements stay visible).
  //   • authoritative sport + void ("scalar")   → `settlementVoided`, resolved with won=NULL.
  //   • everything else (the calibrated teamRows families) → `dryRunById`, comparison ONLY, exactly
  //     as it behaved before. Those stay ESPN-graded: model accuracy wants physical reality, not
  //     what the market paid. See the doctrine note atop settlement-reconcile.js.
  //
  // Failure-closed: any throw leaves all three maps empty and every row falls through to ESPN
  // precisely as it did before this existed.
  let settlementGraded = new Map();   // id → { won, sport } (authoritative sports only)
  let settlementVoided = new Map();   // id → { sport, result }
  let kalshiDryRun = { checked: 0, wouldResolve: 0, byId: new Map() };
  // Settlement verdicts for NON-authoritative (calibrated) rows, kept in the {won, sport} /
  // {sport, result} shapes `settlementGraded`/`settlementVoided` take. These are comparison-only
  // by default; the postponed/makeup escape below promotes individual rows out of here when the
  // ESPN path proves structurally unable to identify the event. Separate from
  // `kalshiDryRun.byId` (id → won) rather than reshaping it, because that map has its own
  // consumers downstream and its contract is not this feature's to change.
  const dryRunGraded = new Map();     // id → { won, sport }
  const dryRunVoided = new Map();     // id → { sport, result }
  // Settlement-fetch health for this pass. chunksFailed > 0 means some tickers were never looked
  // up at all, so `graded`/`disagreed` below undercount — the pass was incomplete, not clean.
  let settlementFetchMeta = null;
  try {
    const tickeredRows = rows.filter(r => r.kalshi_ticker);
    if (tickeredRows.length) {
      const { settlements, meta: fetchMeta } = await fetchKalshiSettlementsWithMeta(tickeredRows.map(r => r.kalshi_ticker));
      settlementFetchMeta = fetchMeta;
      const dryRunById = new Map();
      let wouldResolve = 0;
      for (const r of tickeredRows) {
        const c = classifyRowViaKalshi(r, settlements);
        if (c.state === "graded") wouldResolve++;
        if (isSettlementAuthoritative(r.sport)) {
          if (c.state === "graded") settlementGraded.set(r.id, { won: c.won, sport: r.sport });
          else if (c.state === "void") settlementVoided.set(r.id, { sport: r.sport, result: c.result });
        } else if (c.state === "graded") {
          dryRunById.set(r.id, c.won);
          dryRunGraded.set(r.id, { won: c.won, sport: r.sport });
        } else if (c.state === "void") {
          dryRunVoided.set(r.id, { sport: r.sport, result: c.result });
        }
      }
      kalshiDryRun = { checked: tickeredRows.length, wouldResolve, byId: dryRunById };
    }
  } catch (e) {
    console.error(`[shadow-resolver] kalshi settlement fetch failed: ${e?.message}`);
    settlementGraded = new Map();
    settlementVoided = new Map();
    dryRunGraded.clear();
    dryRunVoided.clear();
  }

  // ── Postponed / makeup escape, pass 1 of 2 (2026-07-29) ────────────────────────────────────
  // Rows whose game_date sits FORWARD of their ticker's date: a postponed game re-attributed to a
  // later slate, where `gameTimes`' last-event-wins keying hands a makeup market the wrong game of
  // that day's doubleheader. Pure row data, so it is decided here, before any ESPN work.
  //
  // The second pass (rows whose matched ESPN event came back postponed) can only run after the
  // ESPN lookup and folds into the same sets further down, just before reconcileGrades.
  const espnUnidentifiable = new Set();   // row ids ESPN must not grade
  let makeupDeferred = 0, postponedSkipped = 0;
  for (const r of rows) {
    if (isSettlementAuthoritative(r.sport)) continue;   // already settlement-first
    if (!isMakeupReattributed(r)) continue;
    espnUnidentifiable.add(r.id);
    makeupDeferred++;
  }

  // The shadow-only sports (tennis, soccer families, fight, golf, nascar, nbasl, lmb, scocup, and
  // the model-free leagues) grade off Kalshi settlement ONLY, so they resolve nothing on the ESPN
  // team path. Their per-sport ESPN resolver blocks were deleted 2026-07-30 (Phase B). They must
  // still be kept OUT of teamRows below, or /api/live would try to grade e.g. a tennis row (whose
  // home/away are player names) and mis-resolve it.
  //
  // Everything that resolves through its OWN scoreboard rather than the team-based /api/live path.
  // The model-free leagues are spread from MODEL_FREE_LEAGUE_KEYS rather than listed by name: this
  // was a hand-maintained `!==` chain and it had already drifted — `dimayor` (7th league, shipped
  // 2026-07-28) was never added, so its rows fell into teamRows, got dropped by /api/live's
  // SPORT_PATHS filter, and landed in `noData` every pass. Harmless only by luck (dimayor is
  // settlement-authoritative, so it still graded correctly) but it inflated noData and padded the
  // games param. Deriving it keeps the registry's contract honest — adding league #8 stays "one
  // MODEL_FREE_LEAGUES entry + teams.js + a SERIES_CONFIG row", with no Nth place to forget.
  const _ownResolverSports = new Set([
    "tennis", "soccer", "fight", "golf", "nascar", "nbasl", "lmb", "scocup",
    ...MODEL_FREE_LEAGUE_KEYS,
  ]);
  const teamRows = rows.filter(r => !_ownResolverSports.has(r.sport));

  // Build unique game keys per date. Key: sport:away:home[@gameTime] — matches /api/live format.
  const keysByDate = new Map(); // game_date → Set<rawKey>
  const rowToKey = new Map();   // row.id → rawKey
  // Rows graded against a guessed (snapshot_date) date — no game_date, no ticker, no game_time.
  // Surfaced on the response so this can't silently regrow the way the null-game_date population did.
  let _guessedDateRows = 0;

  for (const row of teamRows) {
    const { sport, home_team, away_team, game_time } = row;
    // Prefer game_date when set — for MLB it may have been deliberately re-attributed forward to
    // a postponed game's makeup date, which the ticker (frozen at the original date) would not
    // reflect, so it has to stay first.
    //
    // Then the Kalshi ticker's own date segment (2026-07-27). The ticker is the venue's identifier
    // for the event and is exactly what settlement grades against, so it beats anything derived
    // from our own snapshot timing. This rung is what stops the cross-day mis-grade: a row logged
    // on day D for a day-D+1 market used to fall through to snapshot_date and match the SAME
    // matchup played on D — routine in MLB, where 3-4 game series are the norm. The +1-day retry
    // pass below could not save it, because that pass only fires when the primary lookup finds
    // NOTHING, and here it wrongly finds yesterday's game.
    //
    // Then the PT calendar date from game_time (ISO string like 2026-06-03T23:00:00Z). Only fall
    // back to snapshot_date when none of the above is available — that rung is a GUESS, and now
    // only reachable for pre-2026-07-23 rows, which predate the kalshi_ticker column.
    // snapshot_date is a DATE column; Neon may return JS Date or ISO string — both safe via toISOString().
    const _tickerDate = kalshiTickerDate(row.kalshi_ticker);
    const effectiveDate = row.game_date
      || _tickerDate
      || (row.game_time ? new Date(row.game_time).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) : null)
      || (row.snapshot_date ? new Date(row.snapshot_date).toISOString().slice(0, 10) : null);
    if (!row.game_date && !_tickerDate && !row.game_time) _guessedDateRows++;
    let rawKey = `${sport}:${away_team}:${home_team}`;
    if (game_time) rawKey += `@${game_time}`;
    rowToKey.set(row.id, { rawKey, effectiveDate });
    if (!keysByDate.has(effectiveDate)) keysByDate.set(effectiveDate, new Set());
    keysByDate.get(effectiveDate).add(rawKey);
  }

  // Fetch final boxscores from /api/live (one call per distinct game_date).
  const liveByKey = new Map(); // `rawKey|game_date` → game object

  // totalBases rows need the statsapi TB merge in /api/live (?tb=1 — ESPN box has no TB).
  // Request it only when the batch actually contains such rows so regular runs keep the
  // cheap ESPN-only path and its unsuffixed cache slots.
  const tbParam = teamRows.some(r => r.stat === "totalBases") ? "&tb=1" : "";

  const origin = selfOrigin(request);
  await Promise.all([...keysByDate.entries()].map(([game_date, keys]) =>
    fetchLiveInto(liveByKey, origin, game_date, [...keys].join(","), tbParam, 30_000)
  ));

  // Second pass: rows whose primary lookup returned state:"unknown" (event not found, likely
  // because a wrong game_time was stored when gameDate was null on the Kalshi ticker) get a
  // retry with the time-stripped base key. This lets /api/live match any event for those
  // teams on that date without a time-prefix filter.
  const retryByDate = new Map(); // effectiveDate → Set<baseKey (no @gameTime)>
  for (const { rawKey, effectiveDate } of rowToKey.values()) {
    const atIdx = rawKey.indexOf("@");
    if (atIdx === -1) continue; // no game_time — already time-agnostic
    const primary = liveByKey.get(`${rawKey}|${effectiveDate}`);
    if (primary?.state !== "unknown") continue; // primary found OK
    const baseKey = rawKey.slice(0, atIdx);
    if (liveByKey.has(`${baseKey}|${effectiveDate}`)) continue; // already have base lookup
    if (!retryByDate.has(effectiveDate)) retryByDate.set(effectiveDate, new Set());
    retryByDate.get(effectiveDate).add(baseKey);
  }
  if (retryByDate.size > 0) {
    await Promise.all([...retryByDate.entries()].map(([game_date, keys]) =>
      fetchLiveInto(liveByKey, origin, game_date, [...keys].join(","), tbParam, 15_000)
    ));
  }

  // Third pass: rows where game_date AND game_time were both null get effectiveDate=snapshot_date,
  // which may be a day early when the game is actually the next day (Kalshi markets open before
  // the ESPN schedule publishes for the following day). Retry with snapshot_date+1 and +2 for
  // these rows when the primary lookup is still unknown.
  const nullDateRows = teamRows.filter(r => !r.game_date && !r.game_time);
  if (nullDateRows.length > 0) {
    const offsetByDate = new Map(); // offsetDate → Set<baseKey>
    for (const row of nullDateRows) {
      const { rawKey, effectiveDate } = rowToKey.get(row.id);
      const primary = liveByKey.get(`${rawKey}|${effectiveDate}`);
      if (primary && primary.state !== "unknown") continue; // already resolved
      const baseKey = rawKey.includes("@") ? rawKey.slice(0, rawKey.indexOf("@")) : rawKey;
      const base = new Date(effectiveDate);
      for (const deltaDays of [1, 2, 3, 4, 5]) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() + deltaDays);
        const offsetDate = d.toISOString().slice(0, 10);
        if (offsetDate >= today) continue; // don't look up future dates
        if (liveByKey.has(`${baseKey}|${offsetDate}`)) continue;
        if (!offsetByDate.has(offsetDate)) offsetByDate.set(offsetDate, new Set());
        offsetByDate.get(offsetDate).add(baseKey);
      }
    }
    if (offsetByDate.size > 0) {
      await Promise.all([...offsetByDate.entries()].map(([game_date, keys]) =>
        fetchLiveInto(liveByKey, origin, game_date, [...keys].join(","), tbParam, 12_000)
      ));
    }
  }

  // Resolve each row.
  const updates = [];
  let skipped = 0;
  let noData = 0;

  for (const row of teamRows) {
    // Pass 1 already ruled this row unidentifiable (makeup re-attribution). Not `skipped` and not
    // `noData` — ESPN could well produce a confident verdict here, and that verdict would be about
    // the wrong physical game. Leaving it out of `updates` entirely is what keeps `actualValue`
    // from being written off that wrong game at the reconcile chokepoint.
    if (espnUnidentifiable.has(row.id)) continue;
    const { rawKey, effectiveDate } = rowToKey.get(row.id);
    let game = liveByKey.get(`${rawKey}|${effectiveDate}`);
    // If primary lookup was unknown (wrong stored game_time), try base key fallback.
    if (game?.state === "unknown") {
      const atIdx = rawKey.indexOf("@");
      if (atIdx !== -1) {
        const baseKey = rawKey.slice(0, atIdx);
        game = liveByKey.get(`${baseKey}|${effectiveDate}`) ?? game;
      }
    }
    // Third-pass fallback: for null-date rows (no game_date or game_time), the effective date
    // may be several days early. Try offsets +1 through +5 using the base key.
    if ((!game || game.state === "unknown") && !row.game_date && !row.game_time) {
      const baseKey = rawKey.includes("@") ? rawKey.slice(0, rawKey.indexOf("@")) : rawKey;
      const base = new Date(effectiveDate);
      for (const deltaDays of [1, 2, 3, 4, 5]) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() + deltaDays);
        const offsetDate = d.toISOString().slice(0, 10);
        const candidate = liveByKey.get(`${baseKey}|${offsetDate}`);
        if (candidate && candidate.state !== "unknown") { game = candidate; break; }
      }
    }
    if (!game || game.state === "unknown") { noData++; continue; } // game not found in ESPN — leave unresolved
    // Pass 2 of the postponed/makeup escape: the event ESPN matched never actually finished
    // (POSTPONED / CANCELED / SUSPENDED — state:"post", completed:false, 0-0). `_resolveRow` also
    // refuses these, but catching it here separates them from the ordinary `skipped` population
    // and marks the row for the settlement promotion below.
    if (isNonFinalTerminal(game)) { espnUnidentifiable.add(row.id); postponedSkipped++; continue; }
    const result = _resolveRow(row, game);
    if (result === null) { skipped++; continue; }
    updates.push({ id: row.id, won: result.won, actualValue: result.actualValue });
  }

  // ── Postponed / makeup escape, promotion step ──────────────────────────────────────────────
  // Both passes have run, so `espnUnidentifiable` is complete. For those rows only, settlement is
  // promoted from comparison-only to authoritative — NOT because settlement is preferred for a
  // calibrated family (it isn't; those want physical reality), but because ESPN has no answer to
  // prefer. A wrong grade corrupts calibration far worse than a settlement grade does, and the
  // alternative for these rows is not "an ESPN grade" but "no grade at all".
  //
  // Runs before reconcileGrades and simply seeds its existing maps, so the reconcile chokepoint,
  // its counters, and neonBatchResolve stay exactly as they were.
  let makeupPromoted = 0, makeupVoided = 0, makeupUngraded = 0;
  for (const id of espnUnidentifiable) {
    if (settlementGraded.has(id) || settlementVoided.has(id)) continue;
    const g = dryRunGraded.get(id);
    if (g) { settlementGraded.set(id, g); makeupPromoted++; continue; }
    const v = dryRunVoided.get(id);
    // A postponement Kalshi voids outright (game never made up) resolves to won=NULL now rather
    // than waiting out the 14-day abandonment sweep, and drops cleanly from calibration.
    if (v) { settlementVoided.set(id, v); makeupVoided++; continue; }
    // Settlement hasn't finalized yet (makeup not played, or market still open). Leave the row
    // unresolved so a later pass picks it up — the one correct outcome, and the failure-closed one.
    makeupUngraded++;
  }
  if (espnUnidentifiable.size) {
    console.log(`[shadow-resolver] postponed/makeup escape: makeupReattributed=${makeupDeferred} postponedEvent=${postponedSkipped} → settlementGraded=${makeupPromoted} voided=${makeupVoided} stillUngraded=${makeupUngraded}`);
  }

  // ── Reconcile chokepoint ── settlement grades win over ESPN for the authoritative sports; every
  // other row passes through untouched. Deliberately ONE site, after all 15 per-sport ESPN blocks
  // have pushed, so none of them needed editing (and Phase B can delete them wholesale without
  // touching this). `finalUpdates` is what gets written and what every downstream count reads.
  const rec = reconcileGrades({ settlementGraded, settlementVoided, espnUpdates: updates });
  const finalUpdates = rec.updates;
  if (settlementGraded.size || settlementVoided.size) {
    console.log(`[shadow-resolver] kalshi authoritative graded=${settlementGraded.size} voided=${rec.voided} (overrodeEspnGrade=${rec.voidedOverridingEspn}) agreedWithEspn=${rec.agreed} disagreed=${rec.disagreed} espnCouldNotGrade=${rec.settlementOnly} (nulled=${rec.espnNulled} absent=${rec.espnAbsent}) bySport=${JSON.stringify(rec.bySport)}${rec.disagreed ? ` sample=${JSON.stringify(rec.disagreements)}` : ""}`);
  }

  if (finalUpdates.length) await neonBatchResolve(finalUpdates, env);

  // ── Shadow maker: grade any still-ungraded fills (api/lib/maker.js). The tape REPLAY half is
  // disabled as of 2026-07-28 (V2 shelved — see TAPE_REPLAY_ENABLED in maker.js), so this now only
  // drains the ungraded backlog and then becomes a no-op. Failure-closed — must never break
  // resolution.
  let makerMeta = null;
  try {
    const _yd = new Date(new Date(today).getTime() - 86400_000).toISOString().slice(0, 10);
    makerMeta = await detectAndGradeMakerFills({ env, dayPT: _yd });
    console.log(`[shadow-resolver] maker graded=${makerMeta.graded}`
      + (makerMeta.skipped ? ` skipped=${makerMeta.skipped}` : ` tickers=${makerMeta.tickers} new=${makerMeta.newFills} tapeFails=${makerMeta.tapeFails} rateLimited=${makerMeta.rateLimited}`));
  } catch (e) {
    console.error(`[shadow-resolver] maker fill pass failed: ${e?.message}`);
  }

  // ── Shadow maker V2 reconcile (api/lib/maker-live.js, 2026-07-21) ── real fills poll +
  // grading. No-op cheaply if V2 has never been armed (maker_orders_v2 stays empty).
  let makerLiveMeta = null;
  try {
    const _yd2 = new Date(new Date(today).getTime() - 86400_000).toISOString().slice(0, 10);
    makerLiveMeta = await reconcileLiveMakerFills({ env, dayPT: _yd2 });
    console.log(`[shadow-resolver] maker-live fillsFetched=${makerLiveMeta.fillsFetched} matched=${makerLiveMeta.fillsMatched} graded=${makerLiveMeta.graded}`);
  } catch (e) {
    console.error(`[shadow-resolver] maker-live reconcile pass failed: ${e?.message}`);
  }

  // Replica-proof resolution floor for the morning report. This pass's own writes are read-after-
  // write consistent on the pooled primary, and max-merge across the overnight passes (2am/3am/
  // 5:50am) locks in yesterday's true resolved count in KV — which the 6am report reads instead of
  // trusting a cold-instance SQL read that lags the replica (the recurring "not yet generated" miss).
  //
  // 2026-06-30 hardening: the SQL re-COUNT below is ITSELF subject to read-your-own-write replica
  // lag on a cold instance (the >1min instance-pinned lag from the 6/26 miss) — so the decisive late
  // pass that resolves the bulk of yesterday's games can stamp a stale-LOW floor (90 while 990 truly
  // resolved), and since earlier passes legitimately resolved fewer, the max-merge never captures the
  // truth before the 6am report. Defense: derive a lag-IMMUNE lower bound from this pass's own ground
  // truth — prevKvFloor.resolved (Upstash, read-after-write consistent) + the rows we KNOW we just
  // resolved for yesterday (in-memory) — and floor `resolved` at it. Only `resolved` needs this (the
  // just-written, lag-prone field that drives the report's incomplete/TTL gate); `total` is settled
  // (rows inserted hours ago) and clv is written by a different path.
  try {
    const yesterday = new Date(new Date(today).getTime() - 86400_000).toISOString().slice(0, 10);
    const _y10 = (g) => { try { return new Date(g).toISOString().slice(0, 10); } catch { return null; } };
    const yesterdayIds = new Set(
      rows.filter(r => r.game_date && _y10(r.game_date) === yesterday).map(r => r.id)
    );
    const newResolvedYesterday = finalUpdates.reduce((n, u) => n + (yesterdayIds.has(u.id) ? 1 : 0), 0);
    const prevFloor = cache
      ? await cache.get(`${_RESOLUTION_KV_PREFIX}${yesterday}`, "json").catch(() => null)
      : null;
    const yRow = _parseResolutionRow(
      (await neonQuery(_RESOLUTION_SQL, [yesterday], env, { write: true }).catch(() => null))?.[0]
    );
    if (yRow) {
      // Lag-immune lower bound; max so the SQL read still self-corrects total/abandons upward.
      const sqlResolved = yRow.resolved;
      const bound = (Number(prevFloor?.resolved) || 0) + newResolvedYesterday;
      yRow.resolved = Math.max(sqlResolved, bound);
      const stamped = await _stampResolutionFloor(yesterday, yRow, cache);
      console.log(`[shadow-resolver] floor ${yesterday} stamped resolved=${stamped?.resolved}/${stamped?.total} (sql=${sqlResolved} bound=${bound} newY=${newResolvedYesterday})`);
    }
  } catch (e) {
    console.error(`[shadow-resolver] resolution floor stamp failed: ${e?.message}`);
  }

  // Kalshi-settlement dry-run comparison — agreement check only, never overwrites a grade. Scoped
  // to the NON-authoritative (calibrated teamRows) families now that the shadow-only sports grade
  // off settlement for real above; those report through `rec` instead. Only meaningful once ESPN
  // resolved the SAME row this same pass (fair apples-to-apples); a row Kalshi could grade but ESPN
  // didn't reach yet just isn't in `finalById` and is skipped, not counted as a disagreement.
  let kalshiDryRunSummary = null;
  if (kalshiDryRun.byId.size) {
    const finalById = new Map(finalUpdates.map(u => [u.id, u.won]));
    let agree = 0, disagree = 0;
    const disagreements = [];
    for (const [id, kalshiWon] of kalshiDryRun.byId) {
      if (!finalById.has(id)) continue;
      const espnWon = finalById.get(id);
      if (espnWon === null || espnWon === undefined) continue; // ESPN path abandoned/nulled it — not a real comparison
      if (espnWon === kalshiWon) agree++;
      else { disagree++; if (disagreements.length < 10) disagreements.push({ id, espnWon, kalshiWon }); }
    }
    kalshiDryRunSummary = { checked: kalshiDryRun.checked, wouldResolve: kalshiDryRun.wouldResolve, comparedAgainstEspn: agree + disagree, agree, disagree };
    console.log(`[shadow-resolver] kalshi dry-run checked=${kalshiDryRun.checked} wouldResolve=${kalshiDryRun.wouldResolve} comparedAgainstEspn=${agree + disagree} agree=${agree} disagree=${disagree}${disagree ? ` sample=${JSON.stringify(disagreements)}` : ""}`);
  }

  // `noData`/`skipped` are ESPN-feed metrics — they still count rows that settlement went on to
  // resolve, so `noData` alone overstates what was actually left behind. The explicit
  // `noDataNetOfSettlement` is the real "still unresolved" number.
  const noDataNetOfSettlement = Math.max(0, noData - rec.espnAbsent);
  console.log(`[shadow-resolver] resolved=${finalUpdates.length} skipped=${skipped} noData=${noData} (netOfSettlement=${noDataNetOfSettlement}) games=${liveByKey.size} durationMs=${Date.now() - t0}`);
  return jsonResponse({
    ok: true,
    resolved: finalUpdates.length,
    skipped,
    noData,
    noDataNetOfSettlement,
    // Rows graded against a GUESSED date (snapshot_date — no game_date, no ticker, no game_time).
    // Should be 0 for anything logged after the kalshi_ticker column landed 2026-07-23; a non-zero
    // on fresh rows means a capture path is dropping identity again (see game-totals.js 2026-07-27).
    guessedDateRows: _guessedDateRows,
    // Postponed games + their makeups (2026-07-29). These rows leave the ESPN-vs-settlement
    // disagreement tripwire by construction, so they need their own visibility or the fix would
    // trade a wrong grade for a blind spot — the failure mode the 414 silent-drop incident
    // (2026-07-26) turned on. `stillUngraded` is the only one expected to be transient: it should
    // drain to 0 once the makeup is played and Kalshi settles.
    postponedMakeup: espnUnidentifiable.size ? {
      makeupReattributed: makeupDeferred,
      postponedEvent: postponedSkipped,
      settlementGraded: makeupPromoted,
      voided: makeupVoided,
      stillUngraded: makeupUngraded,
    } : null,
    maker: makerMeta,
    makerLive: makerLiveMeta,
    // Authoritative settlement grading for the shadow-only sports (2026-07-25). `disagreed` is the
    // live tripwire on both feeds — a sustained non-zero means one of them drifted.
    kalshiGrading: (settlementGraded.size || settlementVoided.size) ? {
      graded: settlementGraded.size,
      voided: rec.voided,
      voidedOverridingEspn: rec.voidedOverridingEspn,
      agreedWithEspn: rec.agreed,
      disagreed: rec.disagreed,
      espnCouldNotGrade: rec.settlementOnly,
      bySport: rec.bySport,
      disagreements: rec.disagreements,
      // Non-null chunksFailed means this pass didn't see every ticker — read the counts above as
      // a floor, and don't read disagreed=0 as "no disagreements exist".
      settlementFetch: settlementFetchMeta,
      incomplete: (settlementFetchMeta?.chunksFailed || 0) > 0,
    } : null,
    // Comparison-only, calibrated teamRows families (still ESPN-authoritative).
    kalshiDryRun: kalshiDryRunSummary,
    durationMs: Date.now() - t0,
  });
}

export { handleShadowResolver, handleKalshiDryrunCheck };
