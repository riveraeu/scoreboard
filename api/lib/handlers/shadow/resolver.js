// api/lib/handlers/shadow/resolver.js
// /api/shadow-resolver (grades yesterday's shadow_plays vs ESPN + Kalshi settlement) and
// /api/kalshi-dryrun-check (settlement-vs-ESPN agreement audit), plus resolveOpenMakerPositions
// (called on the kalshi-snapshot cron tick). Extracted verbatim from handlers/shadow.js during the
// handler split (zero behavior change). ESPN resolution helpers + resolution KV live in ./common.js.

import { neonQuery, neonBatchResolve } from "../../neon.js";
import { errorResponse, jsonResponse, selfOrigin } from "../../utils.js";
import { fetchCompletedMatches } from "../../tennis.js";
import { fetchWcFinals, fetchWcHalfFinals, fetchWcAdvance } from "../../soccer.js";
import { fetchFightResults, matchFightByCodes, normFighterName } from "../../mma.js";
import { fetchRoundScores, normGolfName } from "../../golf.js";
import { fetchRaceResults } from "../../nascar.js";
import { fetchSlResults } from "../../nba-summer.js";
import { detectAndGradeMakerFills } from "../../maker.js";
import { reconcileLiveMakerFills } from "../../maker-live.js";
import { fetchLmbResults } from "../../lmb.js";
import { MODEL_FREE_LEAGUE_KEYS, leagueSource } from "../../model-free-leagues.js";
import { fetchScoCupResults } from "../../scocup.js";
import { fetchKalshiSettlements, fetchKalshiSettlementsWithMeta, resolveRowViaKalshi, classifyRowViaKalshi } from "../../kalshi-settlement.js";
import { reconcileGrades, isSettlementAuthoritative, isMakeupReattributed, isNonFinalTerminal, SETTLEMENT_AUTHORITATIVE_SPORTS, SETTLEMENT_CUTOVER_DATE } from "../../settlement-reconcile.js";
import { kalshiTickerDate } from "../../kalshi-ticker.js";
import {
  SHADOW_TABLE, _resolveRow, _fuzzyName, _editDist,
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

// Shared tennis grader — groups rows by (date, tour), fetches that day's completed matches,
// and grades each row against the match containing BOTH players. 2026-07-19: the ESPN tennis
// scoreboard returns the WHOLE TOURNAMENT's completed matches for a date query (478 on 7/04),
// so the old single-name `find` graded picks off the wrong match — both sides of a head-to-head
// could "win" (61/84 both-side pairs were bothWon). With both names required, any remaining
// ambiguity (rematch / doubles echo) settles by exact competition date; still ambiguous → skip
// (failure-closed, stays unresolved). Used by the nightly pass AND the ?regradetennis backfill.
async function _gradeTennisRows(tennisRows) {
  const tourOf = (r) => {
    try { const f = typeof r.features === "string" ? JSON.parse(r.features) : r.features; return f?.tour || "atp"; }
    catch { return "atp"; }
  };
  const dateOf = (r) => r.game_date
    || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
    || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
  const updates = [];
  let noData = 0;
  const byKey = new Map(); // `${date}|${tour}` → rows
  for (const r of tennisRows) {
    const date = dateOf(r);
    if (!date) { noData++; continue; }
    const key = `${date}|${tourOf(r)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const matchesByKey = new Map();
  await Promise.all([...byKey.keys()].map(async (key) => {
    const [date, tour] = key.split("|");
    matchesByKey.set(key, await fetchCompletedMatches(tour, date.replace(/-/g, "")));
  }));
  const sameName = (a, b) => a === b || (a.length >= 8 && _editDist(a, b) <= 2);
  for (const [key, rws] of byKey) {
    const matches = matchesByKey.get(key) || [];
    const dateKey = key.split("|")[0].replace(/-/g, "");
    for (const r of rws) {
      const pick = _fuzzyName(r.player_name || r.pick_team || "");
      const nmH = _fuzzyName(r.home_team || ""), nmA = _fuzzyName(r.away_team || "");
      if (!pick || !nmH || !nmA) { noData++; continue; }
      const has = (mt, nm) => mt.players.some(p => sameName(_fuzzyName(p), nm));
      const cands = matches.filter(mt => has(mt, nmH) && has(mt, nmA));
      // One head-to-head → trust it even if its UTC date drifted a day; several → exact date only.
      const found = cands.length === 1 ? cands[0] : cands.find(mt => mt.date === dateKey);
      if (!found || !found.winner) { noData++; continue; } // not final / not found / ambiguous
      updates.push({ id: r.id, won: sameName(_fuzzyName(found.winner), pick), actualValue: null });
    }
  }
  return { updates, noData };
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

  // ── One-shot tennis regrade backfill (2026-07-19, wide-window bug) ── re-grades every
  // already-resolved tennis row with the fixed both-names matcher. Idempotent; ?dry=1 diffs
  // without writing. Rows the fixed matcher can no longer grade (ambiguous/absent) get
  // won=NULL (stays resolved — the abandon idiom — so calibration drops them cleanly).
  const _rq = new URL(request.url).searchParams;
  if (_rq.get("regradetennis") === "1") {
    const dry = _rq.get("dry") === "1";
    const rows = await neonQuery(
      `SELECT id, player_name, pick_team, home_team, away_team, game_date, game_time,
              snapshot_date, features, won
       FROM shadow_plays
       WHERE sport = 'tennis' AND resolved = TRUE
       ORDER BY snapshot_date`,
      [], env, { write: true }
    );
    const { updates: graded, noData: ungradable } = await _gradeTennisRows(rows);
    const byId = new Map(graded.map(u => [u.id, u]));
    const changes = [], nulls = [];
    let unchanged = 0;
    for (const r of rows) {
      const g = byId.get(r.id);
      if (!g) {
        if (r.won !== null) nulls.push({ id: r.id, won: null, actualValue: null });
        else unchanged++;
        continue;
      }
      if (r.won === g.won) unchanged++;
      else changes.push(g);
    }
    if (!dry && changes.length) await neonBatchResolve(changes, env);
    if (!dry && nulls.length) await neonBatchResolve(nulls, env);
    console.log(`[shadow-resolver] regradetennis dry=${dry} checked=${rows.length} changed=${changes.length} nulled=${nulls.length} unchanged=${unchanged} ungradable=${ungradable}`);
    return jsonResponse({ ok: true, dry, checked: rows.length, changed: changes.length,
      nulled: nulls.length, unchanged, ungradable });
  }

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

  // Tennis match-winner + soccer rows resolve via their own ESPN scoreboards (not the team-based
  // /api/live path, which doesn't know tennis players or soccer's 5 market families + draws), so
  // split them out of teamRows below.
  const tennisRows = rows.filter(r => r.sport === "tennis");
  const _isSoccerHalf = (r) => /^(1h|2h)(game|total|spread|btts)$/.test(r.stat || "");
  const soccerRows = rows.filter(r => r.sport === "soccer" && r.stat !== "advance" && !_isSoccerHalf(r));
  const soccerHalfRows = rows.filter(r => r.sport === "soccer" && _isSoccerHalf(r));
  const soccerAdvanceRows = rows.filter(r => r.sport === "soccer" && r.stat === "advance");
  const fightRows = rows.filter(r => r.sport === "fight");
  const golfRows = rows.filter(r => r.sport === "golf");
  const nascarRows = rows.filter(r => r.sport === "nascar");
  const nbaslRows = rows.filter(r => r.sport === "nbasl");
  const lmbRows = rows.filter(r => r.sport === "lmb");
  // Model-free soccer rows are filtered per league inside the MODEL_FREE_LEAGUES loop below.
  const scocupRows = rows.filter(r => r.sport === "scocup");
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

  // ── Tennis resolution ── shared grader (also used by the ?regradetennis backfill).
  if (tennisRows.length) {
    const t = await _gradeTennisRows(tennisRows);
    updates.push(...t.updates);
    noData += t.noData;
  }

  // ── Soccer (World Cup) resolution ── grade all 5 families off the ESPN fifa.world scoreboard
  // at the 90'+stoppage final (matches Kalshi settlement — excludes ET/penalties). We read the
  // goal map per game (canonical FIFA code → goals) and resolve alignment-independently: totals,
  // team totals, spreads, BTTS, and the 3-way 1X2 (a draw is a real settled outcome).
  if (soccerRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map(); // date → rows
    for (const r of soccerRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const finalsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      finalsByDate.set(date, await fetchWcFinals(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const finals = finalsByDate.get(date) || [];
      for (const r of rws) {
        // Find the game by the unordered {home,away} pair, then read goals per canonical code.
        const game = finals.find(g => g.codes[r.home_team] != null && g.codes[r.away_team] != null);
        if (!game || !game.final) { noData++; continue; } // not played / not final yet
        const gh = game.codes[r.home_team], ga = game.codes[r.away_team];
        const th = parseFloat(r.threshold);
        const isUnder = r.direction === "under";
        let won = null, actual = null;
        if (r.stat === "game") {
          // 1X2 — pick_team is a FIFA code or "TIE". Settles on the 90' result.
          if (r.pick_team === "TIE") won = gh === ga;
          else won = game.codes[r.pick_team] != null && game.codes[r.pick_team] > (r.pick_team === r.home_team ? ga : gh);
        } else if (r.stat === "total") {
          actual = gh + ga;
          won = isUnder ? actual < th : actual >= th;
        } else if (r.stat === "teamTotal") {
          actual = game.codes[r.scoring_team];
          if (actual == null) { noData++; continue; }
          won = isUnder ? actual < th : actual >= th;
        } else if (r.stat === "spread") {
          // "favored team wins by more than `threshold` goals" — over = covers, under = doesn't.
          const fav = r.pick_team;
          if (game.codes[fav] == null) { noData++; continue; }
          const margin = game.codes[fav] - (fav === r.home_team ? ga : gh);
          actual = margin;
          const covered = margin > th;
          won = isUnder ? !covered : covered;
        } else if (r.stat === "btts") {
          const btts = gh >= 1 && ga >= 1;
          won = isUnder ? !btts : btts;
        } else { noData++; continue; }
        updates.push({ id: r.id, won, actualValue: actual });
      }
    }
  }

  // ── Soccer half resolution (1H / 2H × game/total/spread/btts) ── grade off per-team per-half
  // goals from the event summary (fetchWcHalfFinals). stat = "<half><family>" (e.g. "1htotal");
  // family logic mirrors the full-game soccer block, applied to the chosen half's goal map.
  if (soccerHalfRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map();
    for (const r of soccerHalfRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const finalsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      finalsByDate.set(date, await fetchWcHalfFinals(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const finals = finalsByDate.get(date) || [];
      for (const r of rws) {
        const half = (r.stat || "").slice(0, 2);  // "1h" | "2h"
        const fam = (r.stat || "").slice(2);       // game | total | spread | btts
        const game = finals.find(g => g.h1[r.home_team] != null && g.h1[r.away_team] != null);
        if (!game || !game.final) { noData++; continue; }
        const goals = half === "1h" ? game.h1 : game.h2;
        const gh = goals[r.home_team], ga = goals[r.away_team];
        if (gh == null || ga == null) { noData++; continue; }
        const th = parseFloat(r.threshold);
        const isUnder = r.direction === "under";
        let won = null, actual = null;
        if (fam === "game") {
          if (r.pick_team === "TIE") won = gh === ga;
          else won = goals[r.pick_team] != null && goals[r.pick_team] > (r.pick_team === r.home_team ? ga : gh);
        } else if (fam === "total") {
          actual = gh + ga;
          won = isUnder ? actual < th : actual >= th;
        } else if (fam === "spread") {
          const fav = r.pick_team;
          if (goals[fav] == null) { noData++; continue; }
          const margin = goals[fav] - (fav === r.home_team ? ga : gh);
          actual = margin;
          const covered = margin > th;
          won = isUnder ? !covered : covered;
        } else if (fam === "btts") {
          const btts = gh >= 1 && ga >= 1;
          won = isUnder ? !btts : btts;
        } else { noData++; continue; }
        updates.push({ id: r.id, won, actualValue: actual });
      }
    }
  }

  // ── Soccer knockout "to advance" resolution ── grade the per-tie binary off who advanced
  // (the ET/penalties outcome via fetchWcAdvance, NOT the 90' score). Find the tie by the unordered
  // {home,away} pair; the row wins iff the advancing side equals pick_team. A tie that's completed
  // but not yet flagged (advancer null) records noData rather than a wrong grade.
  if (soccerAdvanceRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map(); // date → rows
    for (const r of soccerAdvanceRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const advByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      advByDate.set(date, await fetchWcAdvance(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const ties = advByDate.get(date) || [];
      for (const r of rws) {
        const game = ties.find(g => g.codes[r.home_team] != null && g.codes[r.away_team] != null);
        if (!game || !game.final || !game.advancer) { noData++; continue; } // not played / not settled yet
        updates.push({ id: r.id, won: game.advancer === r.pick_team, actualValue: null });
      }
    }
  }

  // ── Fighting (UFC rounds O/U) resolution ── grade "ends before round N" rows off the ESPN MMA
  // scoreboard. We fetch each date's card once and match the bout by the stored fighter last
  // names (home_team/away_team), falling back to the event code segment in features. A finish in
  // round k sets status.period=k; a decision leaves period=scheduled. "ends before round N" wins
  // iff the bout finished before round N (period < N) — which also handles decisions, since no
  // threshold exceeds scheduled rounds. direction "under" (reaches round N) is the complement.
  if (fightRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map(); // date → rows
    for (const r of fightRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const cardByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      cardByDate.set(date, await fetchFightResults(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const fights = cardByDate.get(date) || [];
      for (const r of rws) {
        const a = normFighterName(r.home_team), b = normFighterName(r.away_team);
        let fight = fights.find(f => {
          const set = (f.lastNames || []).map(normFighterName);
          return set.includes(a) && set.includes(b);
        });
        if (!fight) {
          let codeSeg = null;
          try { const ff = typeof r.features === "string" ? JSON.parse(r.features) : r.features; codeSeg = ff?.eventCodes || null; } catch {}
          if (codeSeg) fight = matchFightByCodes(codeSeg, fights);
        }
        if (!fight || !fight.final || fight.finishRound == null) { noData++; continue; } // not fought / not final yet
        const n = parseFloat(r.threshold);
        const endsBefore = fight.finishRound < n;
        const won = r.direction === "under" ? !endsBefore : endsBefore;
        updates.push({ id: r.id, won, actualValue: fight.finishRound });
      }
    }
  }

  // ── Golf (PGA single-round head-to-head) resolution ── grade off the ESPN PGA leaderboard for
  // the round's date. We read each player's per-round scores and compare the bet round: the pick
  // wins iff their round-N strokes are strictly lower than the opponent's (a tie resolves NO,
  // matching Kalshi's "beats" settlement). Round comes from features; both names from home/away.
  if (golfRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const roundOf = (r) => {
      try { const f = typeof r.features === "string" ? JSON.parse(r.features) : r.features; return parseInt(f?.round) || null; }
      catch { return null; }
    };
    const byDate = new Map(); // date → rows
    for (const r of golfRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const scoresByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      scoresByDate.set(date, await fetchRoundScores(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const scores = scoresByDate.get(date) || {};
      // Match a player to a scores key: exact normGolfName, then fuzzy/edit-distance fallback.
      const findScores = (name) => {
        const key = normGolfName(name || "");
        if (scores[key]) return scores[key];
        const fz = _fuzzyName(name || "");
        for (const k in scores) { if (_fuzzyName(k) === fz) return scores[k]; }
        if (fz.length >= 8) {
          let best = null, bd = 3;
          for (const k in scores) { const fk = _fuzzyName(k); if (Math.abs(fk.length - fz.length) > 2) continue; const d = _editDist(fz, fk); if (d < bd) { bd = d; best = k; } }
          if (best) return scores[best];
        }
        return null;
      };
      for (const r of rws) {
        const n = roundOf(r);
        if (!n) { noData++; continue; }
        const ps = findScores(r.player_name || r.home_team);
        const os = findScores(r.away_team);
        const pa = ps && ps[n - 1], ob = os && os[n - 1];
        if (pa == null || ob == null) { noData++; continue; } // round not complete / player not found
        updates.push({ id: r.id, won: pa < ob, actualValue: pa }); // strictly lower wins; tie → NO
      }
    }
  }

  // ── NASCAR (Cup H2H + Top-10) resolution ── grade off the ESPN core-API race results for the
  // race's date. Each play stores the pick (and, for H2H, opponent) ESPN athlete id in features,
  // so we match by id off the competitor list — no name matching. H2H: pick wins iff its finishing
  // order is strictly lower than the opponent's. Top-10: pick wins iff order ≤ 10.
  if (nascarRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const featOf = (r) => { try { return typeof r.features === "string" ? JSON.parse(r.features) : (r.features || {}); } catch { return {}; } };
    const byDate = new Map();
    for (const r of nascarRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const resultsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      resultsByDate.set(date, await fetchRaceResults(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const results = resultsByDate.get(date) || {};
      if (!Object.keys(results).length) { noData += rws.length; continue; } // race not run / not found yet
      for (const r of rws) {
        const f = featOf(r);
        const pickOrder = f.pickId != null ? results[String(f.pickId)] : null;
        if (pickOrder == null) { noData++; continue; }
        if (r.stat === "top10") {
          updates.push({ id: r.id, won: pickOrder <= (r.threshold || 10), actualValue: pickOrder });
        } else { // h2h
          const oppOrder = f.oppId != null ? results[String(f.oppId)] : null;
          if (oppOrder == null) { noData++; continue; }
          updates.push({ id: r.id, won: pickOrder < oppOrder, actualValue: pickOrder }); // strictly lower wins
        }
      }
    }
  }

  // ── NBA Summer League resolution ── grade game-winner rows off the ESPN SL scoreboard.
  // Games are matched on the sorted canonical team pair (Kalshi ticker order ≠ ESPN home/away).
  if (nbaslRows.length) {
    const dateOf = (r) => r.game_date
      ? new Date(r.game_date).toISOString().slice(0, 10)
      : (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map();
    for (const r of nbaslRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const resultsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      resultsByDate.set(date, await fetchSlResults(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const results = resultsByDate.get(date) || {};
      for (const r of rws) {
        const g = results[[r.home_team, r.away_team].sort().join("|")];
        if (!g) { noData++; continue; } // game not played / not final yet
        const pickScore = g.home === r.pick_team ? g.homeScore : (g.away === r.pick_team ? g.awayScore : null);
        const oppScore = g.home === r.pick_team ? g.awayScore : g.homeScore;
        if (pickScore == null) { noData++; continue; }
        updates.push({ id: r.id, won: g.winner === r.pick_team, actualValue: pickScore - oppScore });
      }
    }
  }

  // ── LMB resolution ── grade game-winner rows off the statsapi schedule (sportId 23).
  // Games are matched on the sorted canonical team pair (Kalshi ticker order ≠ statsapi
  // home/away). Split doubleheaders (different winners) come back unkeyed from
  // fetchLmbResults, so those rows stay unresolved (failure-closed).
  if (lmbRows.length) {
    const dateOf = (r) => r.game_date
      ? new Date(r.game_date).toISOString().slice(0, 10)
      : (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map();
    for (const r of lmbRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const resultsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      resultsByDate.set(date, await fetchLmbResults(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const results = resultsByDate.get(date) || {};
      for (const r of rws) {
        const g = results[[r.home_team, r.away_team].sort().join("|")];
        if (!g) { noData++; continue; } // game not final yet / split DH (unresolvable by pair)
        const pickScore = g.home === r.pick_team ? g.homeScore : (g.away === r.pick_team ? g.awayScore : null);
        const oppScore = g.home === r.pick_team ? g.awayScore : g.homeScore;
        if (pickScore == null) { noData++; continue; }
        updates.push({ id: r.id, won: g.winner === r.pick_team, actualValue: pickScore - oppScore });
      }
    }
  }

  // ── Shared graders for MLS/Liga MX club-soccer rows (base 3-way ML + the 2026-07-23 threshold
  // derivatives: 1H game/spread/total/BTTS + full-game team-total). `game` shape: { home, away,
  // homeScore, awayScore } (fetchXResults) or additionally h1HomeScore/h1AwayScore
  // (fetchXHalfResults) — `isHalf` picks which pair to grade off. 3-way pick_team is a canonical
  // abbr or "TIE"; threshold stats mirror the WC soccer/scocup resolver convention (direction
  // "under" flips the comparison).
  const _grade3Way = (r, g, isHalf) => {
    const [hs, as] = isHalf ? [g.h1HomeScore, g.h1AwayScore] : [g.homeScore, g.awayScore];
    if (r.pick_team === "TIE") return { won: hs === as, actual: null };
    const pickScore = g.home === r.pick_team ? hs : (g.away === r.pick_team ? as : null);
    const oppScore = g.home === r.pick_team ? as : hs;
    if (pickScore == null) return null;
    return { won: pickScore > oppScore, actual: null };
  };
  const _gradeThreshold = (r, g) => {
    const th = parseFloat(r.threshold);
    const isUnder = r.direction === "under";
    if (r.stat === "1htotal") {
      const actual = g.h1HomeScore + g.h1AwayScore;
      return { won: isUnder ? actual < th : actual >= th, actual };
    }
    if (r.stat === "1hspread") {
      const favScore = g.home === r.pick_team ? g.h1HomeScore : (g.away === r.pick_team ? g.h1AwayScore : null);
      if (favScore == null) return null;
      const oppScore = r.pick_team === g.home ? g.h1AwayScore : g.h1HomeScore;
      const actual = favScore - oppScore;
      const covered = actual > th;
      return { won: isUnder ? !covered : covered, actual };
    }
    if (r.stat === "1hbtts") {
      const btts = g.h1HomeScore >= 1 && g.h1AwayScore >= 1;
      return { won: isUnder ? !btts : btts, actual: null };
    }
    if (r.stat === "teamTotal") {
      const actual = g.home === r.pick_team ? g.homeScore : (g.away === r.pick_team ? g.awayScore : null);
      if (actual == null) return null;
      return { won: isUnder ? actual < th : actual >= th, actual };
    }
    // Full-game spread/total/BTTS (Argentina Liga Profesional, adopted 2026-07-24 — no half
    // family, so `g` is fetchResults' plain shape: homeScore/awayScore only, no h1-prefixed
    // fields). Same math as the 1h branches above, off the full-game score instead.
    if (r.stat === "total") {
      const actual = g.homeScore + g.awayScore;
      return { won: isUnder ? actual < th : actual >= th, actual };
    }
    if (r.stat === "spread") {
      const favScore = g.home === r.pick_team ? g.homeScore : (g.away === r.pick_team ? g.awayScore : null);
      if (favScore == null) return null;
      const oppScore = r.pick_team === g.home ? g.awayScore : g.homeScore;
      const actual = favScore - oppScore;
      const covered = actual > th;
      return { won: isUnder ? !covered : covered, actual };
    }
    if (r.stat === "btts") {
      const btts = g.homeScore >= 1 && g.awayScore >= 1;
      return { won: isUnder ? !btts : btts, actual: null };
    }
    return null;
  };

  // ── MODEL-FREE SOCCER resolution ── one loop over MODEL_FREE_LEAGUES, replacing six
  // near-identical per-league blocks (2026-07-28). Grades the 3-way (home/away/tie) game-winner
  // rows plus, where a league has them, the 1H spread/total/BTTS + full-game team-total
  // derivatives. Games match on the sorted canonical team pair (Kalshi ticker order ≠ ESPN
  // home/away). pick_team is a canonical abbr or "TIE" (mirrors WC soccer's 1X2 grading): a draw
  // settles the TIE row, a scoreline settles whichever team's row it is. Model-free rows
  // (model_true_pct NULL) resolve exactly like any other row.
  //
  // "game" grades off the plain full-game fetch; any other stat needs half-time scores and grades
  // off `fetchHalfResults` (which also carries a derived full-game score for teamTotal). That
  // second fetch is issued ONLY for dates that actually have a non-"game" row — today only MLS and
  // Liga MX have 1H series, and the four other leagues must not pay an extra ESPN round-trip per
  // date for a family they don't list. That conditional is what keeps this loop behaviourally
  // identical to the six blocks it replaces, rather than merely equivalent.
  for (const _league of MODEL_FREE_LEAGUE_KEYS) {
    const leagueRows = rows.filter(r => r.sport === _league);
    if (!leagueRows.length) continue;
    const { fetchResults, fetchHalfResults } = leagueSource(_league);
    const dateOf = (r) => r.game_date
      ? new Date(r.game_date).toISOString().slice(0, 10)
      : (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map();
    for (const r of leagueRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const resultsByDate = new Map();
    const halfResultsByDate = new Map();
    await Promise.all([...byDate.entries()].map(async ([date, rws]) => {
      const ds = date.replace(/-/g, "");
      const needsHalf = rws.some(r => r.stat !== "game");
      const [full, half] = await Promise.all([
        fetchResults(ds),
        needsHalf ? fetchHalfResults(ds) : Promise.resolve(null),
      ]);
      resultsByDate.set(date, full);
      if (half) halfResultsByDate.set(date, half);
    }));
    for (const [date, rws] of byDate) {
      const results = resultsByDate.get(date) || {};
      const halfResults = halfResultsByDate.get(date) || {};
      for (const r of rws) {
        const key = [r.home_team, r.away_team].sort().join("|");
        if (r.stat === "game") {
          const g = results[key];
          if (!g) { noData++; continue; } // game not played / not final yet
          const graded = _grade3Way(r, g, false);
          if (!graded) { noData++; continue; }
          updates.push({ id: r.id, won: graded.won, actualValue: graded.actual });
          continue;
        }
        // Non-"game" stats: 1H families read half-time scores; a league without a half fetch
        // (argprem's full-game spread/total/BTTS) falls back to the plain result, which is what
        // its own block did.
        const g = (halfResultsByDate.has(date) ? halfResults[key] : undefined) ?? results[key];
        if (!g) { noData++; continue; }
        const graded = r.stat === "1hgame" ? _grade3Way(r, g, true) : _gradeThreshold(r, g);
        if (!graded) { noData++; continue; }
        updates.push({ id: r.id, won: graded.won, actualValue: graded.actual });
      }
    }
  }

  // ── Scottish League Cup resolution ── spread + total, off the ESPN sco.cis scoreboard
  // (api/lib/scocup.js). First model-free THRESHOLD resolver (the leagues above are all 3-way
  // ML) — margin/total comparison mirrors the WC spread/total block above, but reads
  // homeScore/awayScore directly (soccer-modelfree.js's result shape) instead of a codes map.
  if (scocupRows.length) {
    const dateOf = (r) => r.game_date
      ? new Date(r.game_date).toISOString().slice(0, 10)
      : (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map();
    for (const r of scocupRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const resultsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      resultsByDate.set(date, await fetchScoCupResults(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const results = resultsByDate.get(date) || {};
      for (const r of rws) {
        const g = results[[r.home_team, r.away_team].sort().join("|")];
        if (!g) { noData++; continue; } // game not played / not final yet
        const goalsFor = (code) => code === g.home ? g.homeScore : (code === g.away ? g.awayScore : null);
        const th = parseFloat(r.threshold);
        const isUnder = r.direction === "under";
        let won, actual;
        if (r.stat === "total") {
          actual = g.homeScore + g.awayScore;
          won = isUnder ? actual < th : actual >= th;
        } else if (r.stat === "spread") {
          const favScore = goalsFor(r.pick_team);
          const oppScore = r.pick_team === g.home ? g.awayScore : g.homeScore;
          if (favScore == null) { noData++; continue; }
          actual = favScore - oppScore;
          const covered = actual > th;
          won = isUnder ? !covered : covered;
        } else { noData++; continue; }
        updates.push({ id: r.id, won, actualValue: actual });
      }
    }
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
