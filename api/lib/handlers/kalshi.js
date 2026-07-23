// Kalshi-related endpoints + tiny meta endpoints that don't justify their own file:
//   /api/kalshi             — player-prop market lookup
//   /api/kalshi-totals      — all alt-line prices for a game/team total matchup (no gate)
//   /api/kalshi-snapshot    — cron-only snapshot writer (auth: CRON_SECRET)
//   /api/keepalive          — KV liveness ping
//
// Context: { path, request, params, env, CACHE2 }
//
// normName + jsonResponse/errorResponse imported directly (utils is stable).

import { jsonResponse, errorResponse, pLimit } from "../utils.js";
import { SERIES_CONFIG, CRON_ONLY_TICKERS, DISMISSED_SERIES } from "../series-config.js";
import { verifyJWT } from "../auth-utils.js";
import { neonQuery, neonExec } from "../neon.js";
import { fetchKalshiOrderbook } from "../kalshi-book.js";
import { pipeWriteChunked } from "../kv-pipeline.js";
import { gzipToString } from "../kv-compress.js";
import { updateMakerQuotes } from "../maker.js";
import { importKalshiKey as _importKalshiKey, placeKalshiOrder, cancelKalshiOrder } from "../kalshi-order-client.js";
import { resolveOpenMakerPositions } from "./shadow.js";
import { updateLiveMakerOrders, emergencyKillLive, setArmed, computeWantedMakerQuotes,
  gradeResolvedMakerPositions,
  isArmed as isMakerV2Armed, ensureMakerLiveTables } from "../maker-live.js";
import { fetchKalshiMarkets } from "../tonight/kalshi-pipeline.js";
import { MAKER_V2_MAX_CONCURRENT, MAKER_V2_SAME_GAME_CAP } from "../config.js";

const normName = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export async function handleKalshiRoutes(ctx) {
  const { path, request, params, env, CACHE2, method, JWT_SECRET } = ctx;

  if (path === "keepalive") {
    if (CACHE2) await CACHE2.put("keepalive", new Date().toISOString(), { expirationTtl: 172800 });
    return jsonResponse({ ok: true, ts: new Date().toISOString() });
  }

  if (path === "kalshi") {
    const playerName = params.get("playerName") || "";
    const stat = params.get("stat") || "points";
    const sportParam = params.get("sport") || "nba";
    const SERIES = {
      nba: { points: "KXNBAPTS", rebounds: "KXNBAREB", assists: "KXNBAAST", threePointers: "KXNBA3PT" },
      nhl: { points: "KXNHLPTS" },
      mlb: { hrr: "KXMLBHRR", strikeouts: "KXMLBKS" },
    };
    const series = SERIES[sportParam]?.[stat];
    if (!series || !playerName) return jsonResponse({ markets: [] });
    const url = `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&limit=1000&status=open`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      cf: { cacheEverything: false },
    });
    if (!res.ok) return jsonResponse({ markets: [] });
    const data = await res.json();
    const nameLower = normName(playerName);
    const matching = (data.markets || []).filter(
      (m) => normName(m.event_title || m.title || "").includes(nameLower)
    );
    const seen = new Set();
    const markets = [];
    for (const m of matching) {
      const strike = parseFloat(m.floor_strike);
      if (isNaN(strike)) continue;
      const threshold = Math.round(strike + 0.5);
      if (seen.has(threshold)) continue;
      seen.add(threshold);
      const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
      const last = parseFloat(m.last_price_dollars) || 0;
      const price = yesAsk > 0 ? yesAsk : last;
      const pct = Math.round(price * 100);
      if (pct <= 0 || pct > 97) continue;
      const americanOdds = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
      markets.push({ threshold, pct, americanOdds });
    }
    return jsonResponse({ markets }, 900);
  }

  // Live orderbook for a single ticker — used by the order modals to walk the FULL resting book
  // for our actual suggested size and measure real VWAP slippage (the cached snapshot `_depth` is
  // top-3-only and is often absent for fresh 0-volume markets, so reported slip reads a false 0).
  // Returns integer-cent levels: `n` = NO-side resting bids, `y` = YES-side resting bids, each
  // descending by price. To BUY YES you lift NO bids (yes_ask = 100 - no_bid); symmetric for NO.
  if (path === "kalshi-orderbook" && method === "GET") {
    const ticker = params.get("ticker") || "";
    if (!ticker) return jsonResponse({ ok: false, error: "ticker required" }, 0);
    const book = await fetchKalshiOrderbook(ticker);
    if (!book.ok) return jsonResponse({ ok: false, error: "fetch failed" }, 0);
    return jsonResponse(book, 0);
  }

  if (path === "kalshi-totals") {
    // All alt-line Kalshi prices for a single matchup × gameType — used by TeamPage to fill
    // threshold tabs that fall OUTSIDE the universal [67, 91] /api/tonight gate (e.g. O4.5 at
    // ~95% YES is too high to be a tradeable play but the user wants to see the price).
    //
    // Params: sport ∈ {mlb, nba, wnba, nhl, nfl}, awayTeam, homeTeam, gameType ∈ {total, teamTotal},
    //         scoringTeam (required when gameType === "teamTotal").
    // Returns: { thresholds: { N: { pct, americanOdds, noPct, noAmericanOdds, kalshiVolume } }, eventTicker }
    // No filtering by gate — caller decides what to display.
    const sportParam = params.get("sport") || "mlb";
    const gtParam = params.get("gameType") || "total";
    const awayTeam = (params.get("awayTeam") || "").toUpperCase();
    const homeTeam = (params.get("homeTeam") || "").toUpperCase();
    const scoringTeam = (params.get("scoringTeam") || "").toUpperCase();
    if (!awayTeam || !homeTeam) return jsonResponse({ thresholds: {} });
    const SERIES_TOTALS = {
      mlb: { total: "KXMLBTOTAL", teamTotal: "KXMLBTEAMTOTAL" },
      nba: { total: "KXNBATOTAL", teamTotal: "KXNBATEAMTOTAL" },
      wnba: { total: "KXWNBATOTAL" },
      nhl: { total: "KXNHLTOTAL" },
      nfl: { total: "KXNFLTOTAL" },
    };
    const series = SERIES_TOTALS[sportParam]?.[gtParam];
    if (!series) return jsonResponse({ thresholds: {} });
    // Kalshi tickers concatenate team abbrs as `{awayHome}` OR `{homeAway}` — match either order.
    const matchKey1 = `${awayTeam}${homeTeam}`;
    const matchKey2 = `${homeTeam}${awayTeam}`;
    const cacheKey = `kalshi:alts:${series}:${matchKey1}${gtParam === "teamTotal" ? `:${scoringTeam}` : ""}`;
    if (CACHE2) {
      const cached = await CACHE2.get(cacheKey, "json").catch(() => null);
      if (cached) return jsonResponse(cached, 300);
    }
    const url = `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&limit=1000&status=open`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }).catch(() => null);
    if (!res || !res.ok) return jsonResponse({ thresholds: {} });
    const data = await res.json().catch(() => ({ markets: [] }));
    const thresholds = {};
    let eventTickerOut = null;
    for (const m of data.markets || []) {
      const ev = (m.event_ticker || "").toUpperCase();
      if (!ev.includes(matchKey1) && !ev.includes(matchKey2)) continue;
      // For team total, the per-team line suffix is `{team}{N}` — only count markets whose
      // scoring side matches the requested team.
      if (gtParam === "teamTotal") {
        if (!scoringTeam) continue;
        const suf = (m.ticker || "").split("-").pop() || "";
        const suffixMatch = suf.match(/^([A-Z]+)(\d+)$/);
        if (!suffixMatch || suffixMatch[1] !== scoringTeam) continue;
      }
      const strike = parseFloat(m.floor_strike);
      if (isNaN(strike)) continue;
      const threshold = Math.round(strike + 0.5);
      const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
      const noAsk = parseFloat(m.no_ask_dollars) || 0;
      if (yesAsk <= 0 && noAsk <= 0) continue;
      const pct = Math.round(yesAsk * 100);
      const noPct = noAsk > 0 ? Math.round(noAsk * 100) : (100 - pct);
      const americanOdds = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
      const noAmericanOdds = noPct >= 50 ? Math.round(-(noPct / (100 - noPct)) * 100) : Math.round((100 - noPct) / noPct * 100);
      const kalshiVolume = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
      thresholds[threshold] = { pct, americanOdds, noPct, noAmericanOdds, kalshiVolume };
      if (!eventTickerOut) eventTickerOut = m.event_ticker;
    }
    const out = { thresholds, eventTicker: eventTickerOut };
    if (CACHE2 && Object.keys(thresholds).length > 0) {
      await CACHE2.put(cacheKey, JSON.stringify(out), { expirationTtl: 300 }).catch(() => {});
    }
    return jsonResponse(out, 300);
  }

  if (path === "kalshi-snapshot") {
    // Vercel Cron-triggered snapshot of every Kalshi series we care about, written to
    // kalshi:snap:{ticker} so /api/tonight can read pre-warmed snaps instead of hammering
    // Kalshi REST on each invocation. Cron schedule lives in vercel.json (*/2 * * * *).
    //
    // Auth: when CRON_SECRET is set in Vercel, the cron runner attaches
    // `Authorization: Bearer ${CRON_SECRET}`. Fail-closed if the env var is missing.
    const cronAuth = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!env?.CRON_SECRET) return errorResponse("CRON_SECRET not set", 500);
    if (cronAuth !== env.CRON_SECRET) return errorResponse("Forbidden", 403);
    if (!CACHE2) return errorResponse("Cache unavailable", 500);
    if (!env?.UPSTASH_REDIS_REST_URL || !env?.UPSTASH_REDIS_REST_TOKEN) {
      return errorResponse("Upstash not configured", 500);
    }
    // Derived from shared SERIES_CONFIG + cron-only tickers (game ML series, winner
    // markets, 3-way F5 ML). Defined in api/lib/series-config.js — edit there.
    const KALSHI_SERIES_TICKERS = [...Object.keys(SERIES_CONFIG), ...CRON_ONLY_TICKERS];
    const startMs = Date.now();
    // Match /api/tonight's hot-path throttle (3 parallel / 700ms delay). Cron isn't
    // user-facing, so slower is fine; what matters is not getting 429s, which the more
    // aggressive 6/300ms settings did on ~half the tickers per run.
    const _SNAP_BATCH = 3;
    const _SNAP_BATCH_DELAY_MS = 700;
    const _snapResults = {};
    const _snapFailed = [];
    const _snapShuffled = [...KALSHI_SERIES_TICKERS];
    for (let _i = _snapShuffled.length - 1; _i > 0; _i--) {
      const _j = Math.floor(Math.random() * (_i + 1));
      [_snapShuffled[_i], _snapShuffled[_j]] = [_snapShuffled[_j], _snapShuffled[_i]];
    }
    const _snapFetchOne = async (ticker) => {
      try {
        const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ticker}&limit=1000&status=open`, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        });
        if (!r.ok) return { ticker, ok: false, status: r.status };
        const data = await r.json();
        return { ticker, ok: true, data };
      } catch (e) {
        return { ticker, ok: false, err: String(e?.message || e) };
      }
    };
    for (let off = 0; off < _snapShuffled.length; off += _SNAP_BATCH) {
      const batch = _snapShuffled.slice(off, off + _SNAP_BATCH);
      const batchRes = await Promise.all(batch.map(_snapFetchOne));
      for (const r of batchRes) {
        // Empty markets is a legitimate Kalshi response for off-season / pre-open series
        // and must be cached so the snap-first read can succeed for sports we're not
        // actively betting. Only treat actual HTTP failures (429, timeout, !ok) as failed.
        if (r.ok) {
          _snapResults[r.ticker] = { markets: r.data?.markets || [] };
        } else {
          _snapFailed.push({ ticker: r.ticker, status: r.status, err: r.err });
        }
      }
      if (off + _SNAP_BATCH < _snapShuffled.length) {
        await new Promise(res => setTimeout(res, _SNAP_BATCH_DELAY_MS));
      }
    }
    // ── Snap write #1: persist snaps IMMEDIATELY, before any orderbook depth work ───────────
    // The depth loop below can take 30s+; the Edge function's wall-clock ceiling is ~25s, so
    // running it BEFORE the write was killing the cron mid-flight → no snaps written → /api/tonight
    // never took the snap-first path (usedSnaps stayed false, _depth never flowed). Decoupled
    // 2026-05-31: write snaps first so they ALWAYS land, then fetch depth best-effort and re-write
    // only the snaps that gained it. `writtenAt` is shared across both writes (one cron cycle);
    // the read side judges freshness from it (180s gate).
    const writtenAt = Date.now();
    const successCount = Object.keys(_snapResults).length;
    // Pipelined Upstash write, chunked at 7MB to stay under the Upstash 10MB request cap
    // (shared with the read-path snap refresh — see api/lib/kv-pipeline.js).
    const _pipeWrite = (cmds) => pipeWriteChunked({
      url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, cmds, label: "kalshi-snapshot",
    });
    const _metaCmd = (extra) => ["SET", "kalshi:snap:_meta", JSON.stringify({
      lastRunAt: writtenAt,
      successCount,
      failedTickers: _snapFailed.map(f => f.ticker),
      durationMs: Date.now() - startMs,
      ...extra,
    }), "EX", 600];
    let _w1 = { sent: 0, failed: 0, errors: [] };
    if (successCount > 0) {
      const _snapCmds = [];
      for (const [ticker, data] of Object.entries(_snapResults)) {
        const raw = JSON.stringify({ markets: data.markets || [], writtenAt });
        let v = raw;
        try { v = await gzipToString(raw); } catch {}
        _snapCmds.push(["SET", `kalshi:snap:${ticker}`, v, "EX", 300]);
      }
      _w1 = await _pipeWrite(_snapCmds);
      // Meta goes in its own (tiny) request AFTER the snap chunks, so a fresh meta means the
      // snap write phase actually ran to completion — and carries its failure count if any
      // chunk was rejected. Depth not fetched yet — record 0/pending so a timed-out depth
      // phase still leaves valid meta.
      await _pipeWrite([_metaCmd({
        depthOk: 0, depthFail: 0, depthTargets: null, depthPending: true,
        snapWriteFailed: _w1.failed, ...(_w1.errors.length && { snapWriteError: _w1.errors[0] }),
      })]);
    }

    // ── Orderbook depth for in-window markets (best-effort, time-bounded) ───────────────────
    // For markets in the tradeable window (yes_ask OR no_ask ∈ [67,91]), fetch the orderbook and
    // attach a compact top-3-levels `_depth` so /api/tonight can blend the true sweep cost
    // (slippage-honest edge) with NO live fetch on the hot path. Purely additive: a market that
    // misses out (fetch failed, budget/deadline hit) simply lacks `_depth` and blending falls back
    // to top-of-book. Highest-volume (most-likely-bet) markets get depth first; the wall-clock
    // deadline guarantees room for write #2 before the Edge ceiling.
    const DEPTH_GATE_LO = 67, DEPTH_GATE_HI = 91;
    const DEPTH_FETCH_CAP = 90;            // ceiling; the deadline is the real limiter
    const DEPTH_BATCH = 3, DEPTH_BATCH_DELAY_MS = 700;  // mirror the series throttle (avoid 429s)
    const DEPTH_DEADLINE_MS = 21000;       // stop launching batches past this; ~4s headroom to ~25s
    const _depthTargets = [];              // { ticker, vol, market, series } refs into _snapResults
    for (const [series, data] of Object.entries(_snapResults)) {
      for (const m of data.markets || []) {
        const ya = Math.round((parseFloat(m.yes_ask_dollars) || 0) * 100);
        const na = Math.round((parseFloat(m.no_ask_dollars) || 0) * 100);
        const inWin = (ya >= DEPTH_GATE_LO && ya <= DEPTH_GATE_HI) ||
                      (na >= DEPTH_GATE_LO && na <= DEPTH_GATE_HI);
        if (!inWin || !m.ticker) continue;
        const vol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
        _depthTargets.push({ ticker: m.ticker, vol, market: m, series });
      }
    }
    // Cap: keep the highest-volume (most-liquid, most-likely-bet) markets when over budget.
    _depthTargets.sort((a, b) => b.vol - a.vol);
    const _depthBudgeted = _depthTargets.slice(0, DEPTH_FETCH_CAP);
    let _depthOk = 0, _depthFail = 0;
    const _touchedSeries = new Set();      // series snaps that gained depth → re-written in write #2
    const _topLevels = (rows) => (Array.isArray(rows) ? rows : [])
      .map(([p, q]) => [Math.round(parseFloat(p) * 100), Math.round(parseFloat(q))])
      .filter(([c, q]) => c > 0 && c < 100 && q > 0)
      .sort((a, b) => b[0] - a[0])   // descending price (highest bid first)
      .slice(0, 3);
    const _fetchDepth = async ({ ticker, market, series }) => {
      try {
        const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        });
        if (!r.ok) { _depthFail++; return; }
        const ob = (await r.json())?.orderbook_fp || {};
        const n = _topLevels(ob.no_dollars);
        const y = _topLevels(ob.yes_dollars);
        if (n.length || y.length) { market._depth = { n, y }; _depthOk++; _touchedSeries.add(series); }
      } catch { _depthFail++; }
    };
    for (let off = 0; off < _depthBudgeted.length; off += DEPTH_BATCH) {
      if (Date.now() - startMs > DEPTH_DEADLINE_MS) break;  // out of budget — keep what we have
      const batch = _depthBudgeted.slice(off, off + DEPTH_BATCH);
      await Promise.all(batch.map(_fetchDepth));
      if (off + DEPTH_BATCH < _depthBudgeted.length) {
        await new Promise(res => setTimeout(res, DEPTH_BATCH_DELAY_MS));
      }
    }

    // ── Snap write #2: re-persist only the series snaps that gained depth, plus real meta ────
    // Skipped entirely when no depth landed (timeout/empty slate), so the cheap path costs nothing
    // extra. `_depth` rides inside the snap JSON, so /api/tonight's read path is unchanged. A failed
    // write #2 is non-fatal — write #1's snaps already landed; depth is purely additive.
    let _w2 = { sent: 0, failed: 0, errors: [] };
    if (successCount > 0 && _depthOk > 0) {
      const _depthCmds = [];
      for (const series of _touchedSeries) {
        const data = _snapResults[series];
        if (!data) continue;
        const raw = JSON.stringify({ markets: data.markets || [], writtenAt });
        let v = raw;
        try { v = await gzipToString(raw); } catch {}
        _depthCmds.push(["SET", `kalshi:snap:${series}`, v, "EX", 300]);
      }
      _w2 = await _pipeWrite(_depthCmds); // failure non-fatal: write #1's snaps already landed; depth is additive
      const _wFailed = _w1.failed + _w2.failed;
      const _wErr = _w1.errors[0] ?? _w2.errors[0];
      await _pipeWrite([_metaCmd({
        depthOk: _depthOk, depthFail: _depthFail, depthTargets: _depthTargets.length,
        snapWriteFailed: _wFailed, ...(_wErr && { snapWriteError: _wErr }),
      })]);
    }

    // ── Shadow maker quote pass (api/lib/maker.js, 2026-07-19) ── simulated favorite-ask
    // quotes computed from the books just fetched (zero extra Kalshi calls) + today's
    // shadow:staging index. Best-effort and LAST: snaps + depth + meta have already landed,
    // so a maker failure costs nothing but this cycle's quote segments. Skips cleanly when
    // staging hasn't been written yet (before the first /api/tonight run of the day).
    let _makerMeta = null;
    try {
      const _mkT = Date.now();
      const _mkToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const _staging = await CACHE2.get(`shadow:staging:${_mkToday}`, "json");
      if (_staging && successCount > 0) {
        _makerMeta = await updateMakerQuotes({
          snapResults: _snapResults, staging: _staging, snapshotDate: _mkToday, env,
        });
        _makerMeta.ms = Date.now() - _mkT;
      } else {
        _makerMeta = { skipped: !_staging ? "no_staging" : "no_snaps" };
      }
    } catch (e) {
      _makerMeta = { error: String(e?.message || e) };
      console.error(`[kalshi-snapshot] maker quote pass failed: ${_makerMeta.error}`);
    }

    // ── Shadow maker V2 (api/lib/maker-live.js, 2026-07-21) ── REAL resting orders, scoped to
    // MAKER_V2_BAND [80,84]. Fail-closed: no-ops immediately unless BOTH env.MAKER_V2_ARMED and
    // the KV armed-flag are true — see isArmed(). Runs last, after V1's simulated pass, off the
    // same just-fetched books + staging index.
    let _makerLiveMeta = null;
    try {
      const _mlT = Date.now();
      const _mkToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      const _staging = await CACHE2.get(`shadow:staging:${_mkToday}`, "json");
      if (_staging && successCount > 0) {
        _makerLiveMeta = await updateLiveMakerOrders({
          snapResults: _snapResults, staging: _staging, snapshotDate: _mkToday, env, cache: CACHE2,
        });
        _makerLiveMeta.ms = Date.now() - _mlT;
      } else {
        _makerLiveMeta = { skipped: !_staging ? "no_staging" : "no_snaps" };
      }
    } catch (e) {
      _makerLiveMeta = { error: String(e?.message || e) };
      console.error(`[kalshi-snapshot] maker-live order pass failed: ${_makerLiveMeta.error}`);
    }

    // ── V2 real-money grading fast path (2026-07-22) ── the main shadow-resolver only resolves
    // PRIOR days, so a V2 position whose game finished TODAY would otherwise sit ungraded (and
    // the PnL tile wrong) until the next 2am/3:05am/5:50am PT run. Independent of the staging
    // gate above — this only touches already-placed maker_orders_v2 rows, no staging needed.
    let _makerResolveMeta = null;
    try {
      const _resolveRes = await resolveOpenMakerPositions({ env, request });
      const _gradeRes = await gradeResolvedMakerPositions({ env });
      _makerResolveMeta = { ..._resolveRes, graded: _gradeRes.graded };
    } catch (e) {
      _makerResolveMeta = { error: String(e?.message || e) };
      console.error(`[kalshi-snapshot] maker-live resolve/grade pass failed: ${_makerResolveMeta.error}`);
    }

    return jsonResponse({
      ok: successCount > 0 && _w1.failed === 0,
      successCount,
      failedCount: _snapFailed.length,
      failed: _snapFailed,
      durationMs: Date.now() - startMs,
      snapWriteSent: _w1.sent,
      snapWriteFailed: _w1.failed,
      depthWriteFailed: _w2.failed,
      writeErrors: [..._w1.errors, ..._w2.errors],
      depthOk: _depthOk,
      depthFail: _depthFail,
      depthTargets: _depthTargets.length,
      depthBudgeted: _depthBudgeted.length,
      touchedSeries: _touchedSeries.size,
      maker: _makerMeta,
      makerLive: _makerLiveMeta,
      makerResolve: _makerResolveMeta,
    });
  }

  // ── /api/maker-v2-arm, /api/maker-v2-kill ───────────────────────────────────
  // Admin-only (ADMIN_KEY) manual gates for the shadow-maker V2 real-order engine. Arming here
  // sets only the KV half of the fail-closed AND — env.MAKER_V2_ARMED must ALSO be "true" for
  // any real order to ever place (see maker-live.js isArmed()). Kill always works regardless of
  // the env var, and cancels every currently resting order immediately (doesn't wait for the
  // self-expiring safety net).
  if (path === "maker-v2-arm" && method === "POST") {
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    if (!env?.ADMIN_KEY || bearer !== env.ADMIN_KEY) return errorResponse("Forbidden", 403);
    if (!CACHE2) return errorResponse("No KV", 500);
    await setArmed(CACHE2, true);
    return jsonResponse({ ok: true, armed: true, note: env?.MAKER_V2_ARMED === "true"
      ? "KV flag set — engine is now live-armed" : "KV flag set, but env.MAKER_V2_ARMED is not \"true\" — still disarmed" });
  }
  if (path === "maker-v2-kill" && method === "POST") {
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    if (!env?.ADMIN_KEY || bearer !== env.ADMIN_KEY) return errorResponse("Forbidden", 403);
    if (!CACHE2) return errorResponse("No KV", 500);
    const result = await emergencyKillLive({ env, cache: CACHE2 });
    return jsonResponse({ ok: true, ...result });
  }

  // ── /api/maker-v2-verify-cancel ──────────────────────────────────────────────
  // One-time verification for the cancel schema in kalshi-order-client.js (unverified against a
  // live call — see its top-of-file note). Runs server-side because KALSHI_API_KEY_ID/
  // KALSHI_PRIVATE_KEY are Vercel "sensitive" env vars (write-only — `vercel env pull` can never
  // retrieve them, only the running function gets them injected), so this can't be a local
  // script. Places ONE real order (caller-specified ticker/side/price/count, no silent defaults
  // given the stakes) then immediately cancels it, returning both raw Kalshi responses. ADMIN_KEY
  // only — this is a real trade when invoked, so it must be YOU running the curl, not an agent.
  if (path === "maker-v2-verify-cancel" && method === "POST") {
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    if (!env?.ADMIN_KEY || bearer !== env.ADMIN_KEY) return errorResponse("Forbidden", 403);
    let body;
    try { body = await request.json(); } catch { return errorResponse("Invalid JSON", 400); }
    const { ticker, side, price, count } = body || {};
    if (!ticker || !side || price == null || count == null) return errorResponse("Missing required fields: ticker, side, price, count", 400);
    if (side !== "yes" && side !== "no") return errorResponse("side must be 'yes' or 'no'", 400);
    if (!Number.isInteger(count) || count < 1 || count > 9999) return errorResponse("count must be integer 1–9999", 400);
    if (!Number.isInteger(price) || price < 1 || price > 99) return errorResponse("price must be integer 1–99 (cents)", 400);
    const placed = await placeKalshiOrder({ ticker, side, price, count }, env);
    if (!placed.ok || (placed.remainingCount || 0) === 0) {
      return jsonResponse({ ok: placed.ok, placed, canceled: null,
        note: !placed.ok ? "placement failed" : "nothing left resting (fully filled or gone) — nothing to cancel" });
    }
    const canceled = await cancelKalshiOrder({ orderId: placed.orderId }, env);
    return jsonResponse({ ok: true, placed, canceled });
  }

  // ── /api/maker-v2-graded-audit ───────────────────────────────────────────────
  // One-off diagnostic (2026-07-22) — dump every graded maker_orders_v2 row for a date, joined
  // to its shadow_plays resolution, so a suspicious PnL total can be spot-checked row-by-row
  // against real game outcomes. Same auth as maker-v2-board. ?date=YYYY-MM-DD, default today PT.
  if (path === "maker-v2-graded-audit" && method === "GET") {
    const _bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    const _jwtOk = (_bearer && JWT_SECRET) ? await verifyJWT(_bearer, JWT_SECRET) : null;
    const _adminOk = env?.ADMIN_KEY && _bearer === env.ADMIN_KEY;
    if (!_jwtOk && !_adminOk) return errorResponse("Unauthorized", 401);
    const date = new URL(request.url).searchParams.get("date")
      || new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const rows = await neonQuery(
      `SELECT mo.id, mo.ticker, mo.series, mo.sport, mo.category, mo.game_date, mo.game_key,
              mo.side, mo.price, mo.size, mo.filled_count, mo.side_won, mo.pnl_cents, mo.graded_at,
              mo.kalshi_order_id, mo.client_order_id, mo.placed_at, mo.status,
              s.id AS shadow_id, s.stat, s.game_type, s.direction, s.pick_team, s.home_team,
              s.away_team, s.threshold, s.pick_line, s.won, s.actual_value, s.resolved_at
       FROM maker_orders_v2 mo JOIN shadow_plays s ON s.id = mo.shadow_row_id
       WHERE mo.graded_at IS NOT NULL AND mo.game_date = $1
       ORDER BY mo.graded_at DESC LIMIT 300`,
      [date], env, { write: true }
    );
    return jsonResponse({ ok: true, date, count: rows.length, rows });
  }

  // ── /api/maker-v2-board ──────────────────────────────────────────────────────
  // Near-real-time read for the MakerBoardPage frontend — NOT folded into the 25h-cached
  // shadow-report, since order status needs fresher reads than that. Re-derives "what's
  // eligible right now" via computeWantedMakerQuotes (the exact same logic
  // updateLiveMakerOrders uses — one source of truth) off the snap-first Kalshi read
  // (fetchKalshiMarkets, same hot path /api/tonight uses) + today's shadow:staging. Auth:
  // ADMIN_KEY or user JWT (same level as kalshi-balance/kalshi-fills).
  if (path === "maker-v2-board" && method === "GET") {
    const _cookie = request.headers.get("Cookie") || "";
    const _cookieM = _cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
    const _bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    const _jwt = _cookieM?.[1] || _bearer;
    const _jwtOk = (_jwt && JWT_SECRET) ? await verifyJWT(_jwt, JWT_SECRET) : null;
    const _adminOk = env?.ADMIN_KEY && _bearer === env.ADMIN_KEY;
    if (!_jwtOk && !_adminOk) return errorResponse("Unauthorized", 401);

    const todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const yesterdayPT = new Date(Date.now() - 86400_000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

    let eligibleBySport = {}, armed = false;
    try {
      const seriesTickers = Object.keys(SERIES_CONFIG);
      const { kalshiResults } = await fetchKalshiMarkets({ seriesTickers, cache: CACHE2, env, isBustCache: false });
      const snapResults = {};
      seriesTickers.forEach((s, i) => { snapResults[s] = kalshiResults[i]; });
      const staging = await CACHE2.get(`shadow:staging:${todayPT}`, "json");
      const want = computeWantedMakerQuotes({ snapResults, staging });
      for (const { row } of want.values()) {
        const sport = row?.sport || "unknown";
        eligibleBySport[sport] = (eligibleBySport[sport] || 0) + 1;
      }
      armed = await isMakerV2Armed(env, CACHE2);
    } catch (e) {
      console.error(`[maker-v2-board] eligibility computation failed: ${e?.message}`);
    }

    let orders = [];
    try {
      await ensureMakerLiveTables(env);
      const rows = await neonQuery(
        `SELECT ticker, series, sport, category, game_date, game_key, side, price, size,
           filled_count, status, side_won, pnl_cents, placed_at, expires_at, canceled_at, graded_at
         FROM maker_orders_v2 WHERE game_date >= $1
         ORDER BY (status = 'resting') DESC, placed_at DESC LIMIT 300`,
        [yesterdayPT], env, { write: true });
      orders = rows.map(r => ({
        ticker: r.ticker, series: r.series, sport: r.sport, category: r.category,
        gameDate: r.game_date, gameKey: r.game_key, side: r.side, price: Number(r.price),
        size: Number(r.size), filledCount: Number(r.filled_count), status: r.status,
        sideWon: r.side_won, pnlCents: r.pnl_cents != null ? Number(r.pnl_cents) : null,
        placedAt: r.placed_at, expiresAt: r.expires_at, canceledAt: r.canceled_at, gradedAt: r.graded_at,
      }));
    } catch (e) {
      console.error(`[maker-v2-board] order read failed: ${e?.message}`);
    }

    // Live positions — currently-held, ungraded fills (status='executed' with graded_at IS NULL,
    // same subset `reconcileLiveMakerFills` targets). We SOLD `side` at `price`¢ (real order sent
    // is a buy of the complement, per sellAsBuy — see maker-live.js), so this is a short: current
    // mark-to-market needs the CURRENT ask on that same `side`, not the complement. Top-of-book
    // only (one market-summary fetch per distinct ticker, no full book walk) — read-only display,
    // failure-closed per position (a failed book fetch just omits the live fields for that row).
    const positions = [];
    const heldRows = orders.filter(o => o.status === "executed" && o.gradedAt == null);
    if (heldRows.length) {
      const bookLimit = pLimit(8);
      const books = await Promise.all(
        heldRows.map(o => bookLimit(() => fetchKalshiOrderbook(o.ticker).catch(() => ({ ok: false }))))
      );
      heldRows.forEach((o, i) => {
        const book = books[i];
        const currentAskCents = book?.ok ? (o.side === "yes" ? book.yesAsk : book.noAsk) : null;
        const unrealizedCents = currentAskCents != null ? o.price - currentAskCents : null;
        positions.push({
          ...o,
          currentAskCents,
          unrealizedCents,
          unrealizedDollars: unrealizedCents != null ? (unrealizedCents * o.filledCount) / 100 : null,
          maxRiskCents: 100 - o.price,
        });
      });
    }

    return jsonResponse({
      ok: true, armed, orders, positions, eligibleBySport,
      caps: { maxConcurrent: MAKER_V2_MAX_CONCURRENT, sameGameCap: MAKER_V2_SAME_GAME_CAP },
    });
  }

  if (path === "kalshi-order" && method === "POST") {
    // Verify user JWT — cookie first, then Authorization: Bearer fallback
    if (!JWT_SECRET) return errorResponse("Auth not configured", 500);
    const _cookie = request.headers.get("Cookie") || "";
    const _cookieM = _cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
    const jwtToken = _cookieM?.[1] || (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!jwtToken) return errorResponse("Unauthorized", 401);
    const _jwtPayload = await verifyJWT(jwtToken, JWT_SECRET);
    if (!_jwtPayload) return errorResponse("Unauthorized", 401);
    // Parse + validate body
    let body;
    try { body = await request.json(); } catch { return errorResponse("Invalid JSON", 400); }
    const { ticker, side, price, count, clientOrderId } = body || {};
    if (!ticker || !side || price == null || count == null) return errorResponse("Missing required fields: ticker, side, price, count", 400);
    if (side !== "yes" && side !== "no") return errorResponse("side must be 'yes' or 'no'", 400);
    if (!Number.isInteger(count) || count < 1 || count > 9999) return errorResponse("count must be integer 1–9999", 400);
    if (!Number.isInteger(price) || price < 1 || price > 99) return errorResponse("price must be integer 1–99 (cents)", 400);
    // Kalshi V2 event-order API (2026-07: the legacy /portfolio/orders POST returns "Please
    // switch to the V2 endpoints"). V2 is a single book quoted in YES terms: bid = buy YES,
    // ask = sell YES — and selling YES you don't hold IS the NO buy (ask at (100−p)¢ costs
    // p¢/contract). Client contract unchanged (side yes/no + integer cents); placeKalshiOrder
    // (kalshi-order-client.js) is the translation chokepoint both directions, shared with the
    // automated maker-live.js V2 engine — the response is normalized back to the legacy
    // taker_fill_* shape below so App.jsx needs no changes.
    const r = await placeKalshiOrder({ ticker, side, price, count, clientOrderId }, env);
    if (!r.ok) return errorResponse(r.error, r.status || 500);
    // average_fill_price is a YES price: a NO buy's per-contract cost is its complement
    // (already normalized to per-contract cents in avgFillPriceCents).
    const order = {
      order_id: r.orderId,
      client_order_id: r.clientOrderId,
      taker_fill_count: r.fillCount,
      taker_fill_cost: r.avgFillPriceCents != null ? r.fillCount * r.avgFillPriceCents : 0,
      remaining_count: r.remainingCount,
      average_fill_price: r.raw.average_fill_price ?? null,
      average_fee_paid: r.raw.average_fee_paid ?? null,
    };
    return jsonResponse({ ok: true, order, v2: r.raw });
  }

  if (path === "kalshi-balance" && method === "GET") {
    if (!JWT_SECRET) return errorResponse("Auth not configured", 500);
    const _cookie = request.headers.get("Cookie") || "";
    const _cookieM = _cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
    const jwtToken = _cookieM?.[1] || (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!jwtToken) return errorResponse("Unauthorized", 401);
    const _jwtPayload = await verifyJWT(jwtToken, JWT_SECRET);
    if (!_jwtPayload) return errorResponse("Unauthorized", 401);
    if (!env?.KALSHI_API_KEY_ID || !env?.KALSHI_PRIVATE_KEY) return errorResponse("Kalshi API not configured", 500);
    const kalshiPath = "/trade-api/v2/portfolio/balance";
    const timestamp = String(Date.now());
    let signature;
    try {
      const key = await _importKalshiKey(env.KALSHI_PRIVATE_KEY);
      const msgBuf = new TextEncoder().encode(timestamp + "GET" + kalshiPath);
      const sigBuf = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, msgBuf);
      signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    } catch (e) {
      return errorResponse(`Signing failed: ${e?.message || e}`, 500);
    }
    const resp = await fetch(`https://api.elections.kalshi.com${kalshiPath}`, {
      headers: {
        "KALSHI-ACCESS-KEY": env.KALSHI_API_KEY_ID,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": signature,
      },
    }).catch(() => null);
    if (!resp) return errorResponse("Kalshi unreachable", 502);
    const respBody = await resp.json().catch(() => ({}));
    if (!resp.ok) return errorResponse(respBody?.error?.message || `Kalshi error ${resp.status}`, resp.status);
    const cashCents = respBody.balance ?? 0;
    // Second signed call: open-position cost basis (market_exposure, cents). Summed into the
    // bankroll so balanceDollars reflects cash + capital deployed in open positions. Signature
    // covers the path only (no query), matching the order/fills endpoints. Degrades to
    // positionsCents=0 if this call fails — bankroll still shows cash rather than erroring.
    let positionsCents = 0;
    try {
      const posPath = "/trade-api/v2/portfolio/positions";
      const posTs = String(Date.now());
      const posKey = await _importKalshiKey(env.KALSHI_PRIVATE_KEY);
      const posSigBuf = await crypto.subtle.sign(
        { name: "RSA-PSS", saltLength: 32 },
        posKey,
        new TextEncoder().encode(posTs + "GET" + posPath),
      );
      const posSig = btoa(String.fromCharCode(...new Uint8Array(posSigBuf)));
      const posResp = await fetch(`https://api.elections.kalshi.com${posPath}?settlement_status=unsettled&limit=1000`, {
        headers: {
          "KALSHI-ACCESS-KEY": env.KALSHI_API_KEY_ID,
          "KALSHI-ACCESS-TIMESTAMP": posTs,
          "KALSHI-ACCESS-SIGNATURE": posSig,
        },
      });
      if (posResp.ok) {
        const posBody = await posResp.json().catch(() => ({}));
        for (const p of posBody.market_positions || []) {
          positionsCents += Math.round(parseFloat(p.market_exposure_dollars || 0) * 100);
        }
      }
    } catch { /* leave positionsCents = 0 — bankroll falls back to cash only */ }
    const balanceCents = cashCents + positionsCents;
    // Maker V2 capital committed — margin/collateral tied up in currently-resting real orders
    // (max-loss basis: size * (100-price)¢ per contract, since a sold favorite's worst case is
    // owing the full dollar). Surfaced so manual pick sizing accounts for capital the automated
    // engine already has committed on this same funded account. Degrades to 0 on any failure —
    // never blocks the balance the user actually needs to see.
    let makerCommittedCents = 0;
    try {
      await ensureMakerLiveTables(env);
      const [row] = await neonQuery(
        `SELECT COALESCE(SUM(size * (100 - price)), 0) AS committed_cents
         FROM maker_orders_v2 WHERE status = 'resting'`, [], env, { write: true });
      makerCommittedCents = Math.round(Number(row?.committed_cents || 0));
    } catch { /* leave makerCommittedCents = 0 */ }
    return jsonResponse({ cashCents, positionsCents, balanceCents, balanceDollars: balanceCents / 100,
      makerCommittedCents, makerCommittedDollars: makerCommittedCents / 100 });
  }

  if (path === "kalshi-fills" && method === "GET") {
    // Read of the account's actual Kalshi fills, signed with the server's RSA-PSS API key
    // (no browser session cookie needed). Used to reconcile real fills vs the app's stored
    // picks. Auth: user JWT (cookie sb_token or Bearer) — same level as kalshi-balance —
    // OR Bearer ADMIN_KEY so it's also runnable from curl/CI.
    const _fcookie = request.headers.get("Cookie") || "";
    const _fcookieM = _fcookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
    const _fbearer = (request.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    const _fjwt = _fcookieM?.[1] || _fbearer;
    const _fjwtOk = (_fjwt && JWT_SECRET) ? await verifyJWT(_fjwt, JWT_SECRET) : null;
    const _fadminOk = env?.ADMIN_KEY && _fbearer === env.ADMIN_KEY;
    if (!_fjwtOk && !_fadminOk) return errorResponse("Unauthorized", 401);
    if (!env?.KALSHI_API_KEY_ID || !env?.KALSHI_PRIVATE_KEY) return errorResponse("Kalshi API not configured", 500);
    // Optional filters: ?limit=N (default 200, Kalshi max 1000), ?min_ts=<unix_seconds>.
    const _limit = Math.min(1000, Math.max(1, parseInt(params.get("limit") || "200", 10) || 200));
    const _minTs = params.get("min_ts");
    const _qs = `?limit=${_limit}${_minTs ? `&min_ts=${encodeURIComponent(_minTs)}` : ""}`;
    // Signature covers the path only (no query string), matching the balance/order endpoints.
    const kalshiPath = "/trade-api/v2/portfolio/fills";
    const timestamp = String(Date.now());
    let signature;
    try {
      const key = await _importKalshiKey(env.KALSHI_PRIVATE_KEY);
      const msgBuf = new TextEncoder().encode(timestamp + "GET" + kalshiPath);
      const sigBuf = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, msgBuf);
      signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    } catch (e) {
      return errorResponse(`Signing failed: ${e?.message || e}`, 500);
    }
    const resp = await fetch(`https://api.elections.kalshi.com${kalshiPath}${_qs}`, {
      headers: {
        "KALSHI-ACCESS-KEY": env.KALSHI_API_KEY_ID,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": signature,
      },
    }).catch(() => null);
    if (!resp) return errorResponse("Kalshi unreachable", 502);
    const respBody = await resp.json().catch(() => ({}));
    if (!resp.ok) return errorResponse(respBody?.error?.message || `Kalshi error ${resp.status}`, resp.status);
    return jsonResponse({ ok: true, fills: respBody.fills ?? [], cursor: respBody.cursor ?? null });
  }

  // ── /api/kalshi-series-scan ──────────────────────────────────────────────
  // Daily cron. Diffs Kalshi's Sports-category series catalog against the tickers
  // we actually consume (SERIES_CONFIG + CRON_ONLY_TICKERS) and records unknown
  // ones in Neon (kalshi_series_seen). The catalog is ~2200 series, almost all of
  // it futures/awards/novelty noise — so the FIRST run baseline-seeds every
  // currently-listed unknown ticker as status='baseline' (silently acknowledged);
  // only series Kalshi lists AFTER today surface as status='new', the alert set the
  // morning report renders. A known ticker absent from the catalog (e.g. NFL props
  // off-season) is normal — the diff is one-directional and never flags those.
  // Auth: CRON_SECRET (cron) or ADMIN_KEY (manual). ?dry=1 skips all DB writes.
  // ?dismiss=KX.. / ?undismiss=KX.. (admin) triage noise rows out of / into 'new'.
  if (path === "kalshi-series-scan") {
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
    const isCron  = env?.CRON_SECRET && bearer === env.CRON_SECRET;
    const isAdmin = env?.ADMIN_KEY  && bearer === env.ADMIN_KEY;
    if (!isCron && !isAdmin) return errorResponse("Forbidden", 403);
    if (!env?.DATABASE_URL_UNPOOLED && !env?.POSTGRES_URL && !env?.NEON_DATABASE_URL && !env?.POSTGRES_URL_NON_POOLING) {
      return errorResponse("No Neon connection", 500);
    }
    const url = new URL(request.url);
    const dry = url.searchParams.get("dry") === "1";

    await neonExec(`
      CREATE TABLE IF NOT EXISTS kalshi_series_seen (
        ticker          TEXT PRIMARY KEY,
        title           TEXT,
        category        TEXT,
        tags            TEXT,
        frequency       TEXT,
        sample_market   TEXT,
        sample_subtitle TEXT,
        status          TEXT NOT NULL DEFAULT 'new',
        first_seen      DATE NOT NULL,
        last_seen       DATE NOT NULL
      )
    `, env);
    // Additive triage-hint columns (live liquidity + window fit). Safe on re-run.
    await neonExec(`
      ALTER TABLE kalshi_series_seen ADD COLUMN IF NOT EXISTS live_market_count INT;
      ALTER TABLE kalshi_series_seen ADD COLUMN IF NOT EXISTS window_fit BOOLEAN
    `, env);

    // Enrich one series with a sample market + live liquidity + window-fit (any side priced in the
    // [67,91] qualification band — a rough "favorites priced in our band" hint, not a gate).
    // Best-effort; returns null on fetch failure.
    const _WIN_LO = 0.67, _WIN_HI = 0.91;
    // Bounded-concurrency map — Kalshi rate-limits a wide parallel burst (a 42-wide Promise.all
    // 429'd most requests), so cap in-flight enrichment fetches.
    const mapPool = async (items, concurrency, fn) => {
      let i = 0;
      const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    };
    // One retry on failure — Kalshi 429s under the parallel scan even at low concurrency, so a
    // single backoff recovers transient rate-limits (verified: series returning 200/28 markets to
    // a sequential curl were coming back null from the burst).
    const enrichSeries = async (ticker) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ticker}&limit=100&status=open`, {
            headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) { if (attempt === 0) { await new Promise(res => setTimeout(res, 500)); continue; } return null; }
          const markets = (await r.json())?.markets || [];
          let windowFit = false;
          for (const m of markets) {
            const ya = parseFloat(m.yes_ask_dollars), na = parseFloat(m.no_ask_dollars);
            if ((ya >= _WIN_LO && ya <= _WIN_HI) || (na >= _WIN_LO && na <= _WIN_HI)) { windowFit = true; break; }
          }
          const m0 = markets[0];
          return {
            sample_market: m0?.ticker ?? null,
            sample_subtitle: m0?.subtitle ?? m0?.yes_sub_title ?? m0?.title ?? null,
            live_market_count: markets.length,
            window_fit: windowFit,
          };
        } catch { if (attempt === 0) { await new Promise(res => setTimeout(res, 500)); continue; } return null; }
      }
      return null;
    };

    // Admin triage shortcuts: dismiss (→dismissed), undismiss (→new), promote (→shortlisted),
    // unpromote (shortlisted→new). Curl-only (admin gate) — no on-page write surface.
    const dismiss = url.searchParams.get("dismiss");
    const undismiss = url.searchParams.get("undismiss");
    const promote = url.searchParams.get("promote");
    const unpromote = url.searchParams.get("unpromote");
    if (dismiss || undismiss || promote || unpromote) {
      if (!isAdmin) return errorResponse("Admin only", 403);
      if (dismiss) await neonQuery(`UPDATE kalshi_series_seen SET status='dismissed' WHERE ticker = $1`, [dismiss], env, { write: true });
      if (undismiss) await neonQuery(`UPDATE kalshi_series_seen SET status='new' WHERE ticker = $1 AND status='dismissed'`, [undismiss], env, { write: true });
      if (promote) await neonQuery(`UPDATE kalshi_series_seen SET status='shortlisted' WHERE ticker = $1 AND status IN ('new','dismissed','baseline')`, [promote], env, { write: true });
      if (unpromote) await neonQuery(`UPDATE kalshi_series_seen SET status='new' WHERE ticker = $1 AND status='shortlisted'`, [unpromote], env, { write: true });
      return jsonResponse({ ok: true, dismissed: dismiss || null, undismissed: undismiss || null, promoted: promote || null, unpromoted: unpromote || null });
    }

    // 1. Fetch the Sports-category series catalog (single call; no pagination as of 2026-06).
    let catalog;
    try {
      const r = await fetch("https://api.elections.kalshi.com/trade-api/v2/series?category=Sports", {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      });
      if (!r.ok) return errorResponse(`Kalshi series ${r.status}`, 502);
      const data = await r.json();
      catalog = (data?.series || []).filter(s => s && (s.ticker || s.series_ticker));
    } catch (e) {
      return errorResponse(`Kalshi unreachable: ${e?.message || e}`, 502);
    }
    if (!catalog.length) return errorResponse("Empty catalog", 502);

    // 2. The set of tickers we actually consume (same source the snapshot cron uses).
    const known = new Set([...Object.keys(SERIES_CONFIG), ...CRON_ONLY_TICKERS]);

    // 3. Tickers already recorded. {write:true} → pooled primary for read-after-create
    //    consistency (unpooled replica can serve a stale-empty read on cold wake).
    const existingRows = await neonQuery(`SELECT ticker FROM kalshi_series_seen`, [], env, { write: true });
    const existing = new Set(existingRows.map(r => r.ticker));
    const isFirstRun = existing.size === 0;

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

    // 4. Classify tickers new to the table.
    const toInsert = [];       // rows for batch insert
    const enrichTargets = [];  // status='new' rows needing a sample-market fetch
    for (const s of catalog) {
      const ticker = s.ticker || s.series_ticker;
      if (existing.has(ticker)) continue;
      const status = known.has(ticker) ? "adopted" : (isFirstRun ? "baseline" : "new");
      const row = {
        ticker,
        title: s.title ?? null,
        category: s.category ?? null,
        tags: Array.isArray(s.tags) ? s.tags.join(",") : (s.tags ?? null),
        frequency: s.frequency ?? null,
        sample_market: null,
        sample_subtitle: null,
        live_market_count: null,
        window_fit: null,
        status,
        first_seen: today,
        last_seen: today,
      };
      toInsert.push(row);
      if (status === "new") enrichTargets.push(row);
    }

    // 5. Enrich genuinely-new rows with sample market + live count + window-fit (capped, parallel).
    const ENRICH_CAP = 25;
    await mapPool(enrichTargets.slice(0, ENRICH_CAP), 3, async (row) => {
      const e = await enrichSeries(row.ticker);
      if (e) Object.assign(row, e);
    });

    const newTickers = enrichTargets.map(r => r.ticker);

    if (dry) {
      return jsonResponse({
        ok: true, dry: true, isFirstRun,
        catalogCount: catalog.length, knownCount: known.size, existingCount: existing.size,
        toInsertCount: toInsert.length, newCount: newTickers.length,
        newMarkets: enrichTargets.slice(0, ENRICH_CAP).map(r => ({ ticker: r.ticker, title: r.title })),
      });
    }

    // 6a. Batch-insert new-to-table rows.
    const COLS = ["ticker","title","category","tags","frequency","sample_market","sample_subtitle","live_market_count","window_fit","status","first_seen","last_seen"];
    for (let i = 0; i < toInsert.length; i += 100) {
      const chunk = toInsert.slice(i, i + 100);
      const placeholders = chunk.map((_, ri) =>
        `(${COLS.map((_, ci) => `$${ri * COLS.length + ci + 1}`).join(", ")})`
      ).join(", ");
      const values = chunk.flatMap(row => COLS.map(c => row[c] ?? null));
      await neonQuery(
        `INSERT INTO kalshi_series_seen (${COLS.join(", ")}) VALUES ${placeholders} ON CONFLICT (ticker) DO NOTHING`,
        values, env, { write: true }
      );
    }

    // 6b. Reconcile: any lingering 'new' ticker we've since added to the allowlist → adopted.
    const knownArr = [...known];
    const knownPh = knownArr.map((_, i) => `$${i + 1}`).join(", ");
    await neonQuery(
      `UPDATE kalshi_series_seen SET status='adopted' WHERE status IN ('new','shortlisted') AND ticker IN (${knownPh})`,
      knownArr, env, { write: true }
    );

    // 6b-ii. Mirror reconcile: any 'new'/'shortlisted' ticker we've vetted-and-rejected
    // (DISMISSED_SERIES) → dismissed, so the "Vet shortlisted" banner clears on the code
    // change instead of needing a manual `?dismiss=` curl.
    if (DISMISSED_SERIES.length) {
      const dismPh = DISMISSED_SERIES.map((_, i) => `$${i + 1}`).join(", ");
      await neonQuery(
        `UPDATE kalshi_series_seen SET status='dismissed' WHERE status IN ('new','shortlisted') AND ticker IN (${dismPh})`,
        [...DISMISSED_SERIES], env, { write: true }
      );
    }

    // 6c. Refresh enrichment for existing new/shortlisted rows so triage hints track current
    // liquidity, not first-seen. Ordered first_seen DESC to MATCH the report's display order
    // (newMarkets/shortlistedMarkets each LIMIT 25 first_seen DESC) so the rows users actually see
    // get enriched. Capped + parallel + best-effort.
    const REFRESH_CAP = 60;
    const refreshRows = await neonQuery(
      `SELECT ticker FROM kalshi_series_seen WHERE status IN ('new','shortlisted')
       ORDER BY first_seen DESC, ticker LIMIT ${REFRESH_CAP}`,
      [], env, { write: true }
    );
    await mapPool(refreshRows, 3, async (r) => {
      const e = await enrichSeries(r.ticker);
      if (e) await neonQuery(
        `UPDATE kalshi_series_seen SET sample_market=$2, sample_subtitle=$3, live_market_count=$4, window_fit=$5 WHERE ticker = $1`,
        [r.ticker, e.sample_market, e.sample_subtitle, e.live_market_count, e.window_fit], env, { write: true }
      );
    });

    return jsonResponse({
      ok: true, isFirstRun,
      catalogCount: catalog.length, knownCount: known.size,
      inserted: toInsert.length, newCount: newTickers.length, refreshed: refreshRows.length, newTickers,
    });
  }

  return null;
}
