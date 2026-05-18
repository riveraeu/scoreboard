// Kalshi-related endpoints + tiny meta endpoints that don't justify their own file:
//   /api/kalshi             — player-prop market lookup
//   /api/kalshi-snapshot    — cron-only snapshot writer (auth: CRON_SECRET)
//   /api/keepalive          — KV liveness ping
//
// Context: { path, request, params, env, CACHE2 }
//
// normName + jsonResponse/errorResponse imported directly (utils is stable).

import { jsonResponse, errorResponse } from "../utils.js";

const normName = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export async function handleKalshiRoutes(ctx) {
  const { path, request, params, env, CACHE2 } = ctx;

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
    // MUST stay in sync with SERIES_CONFIG inside /api/tonight. Plus KXMLBGAME (game ML,
    // not in SERIES_CONFIG since it isn't a player-prop series but feeds tomorrow's MLB
    // odds fallback).
    const KALSHI_SERIES_TICKERS = [
      "KXNBAPTS", "KXNBAREB", "KXNBAAST", "KXNBA3PT",
      "KXWNBAPTS", "KXWNBAREB", "KXWNBAAST", "KXWNBA3PT",
      "KXNHLPTS",
      "KXMLBKS", "KXMLBHRR",
      "KXNFLPAYDS", "KXNFLRUYDS", "KXNFLREYDS", "KXNFLTDS",
      "KXMLBTOTAL", "KXNBATOTAL", "KXWNBATOTAL", "KXNHLTOTAL", "KXNFLTOTAL",
      "KXMLBTEAMTOTAL", "KXNBATEAMTOTAL",
      "KXMLBGAME",
      "KXMLBSPREAD",
    ];
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
    const writtenAt = Date.now();
    const successCount = Object.keys(_snapResults).length;
    // Pipelined Upstash write: 1 HTTP request for all SETs. Upstash bills per command
    // (not per request) so this doesn't cut Upstash billing; it cuts Vercel observability
    // event count (1 fetch event instead of N).
    if (successCount > 0) {
      const _snapCmds = [];
      for (const [ticker, data] of Object.entries(_snapResults)) {
        const value = JSON.stringify({ markets: data.markets || [], writtenAt });
        _snapCmds.push(["SET", `kalshi:snap:${ticker}`, value, "EX", 300]);
      }
      _snapCmds.push(["SET", "kalshi:snap:_meta", JSON.stringify({
        lastRunAt: writtenAt,
        successCount,
        failedTickers: _snapFailed.map(f => f.ticker),
        durationMs: Date.now() - startMs,
      }), "EX", 600]);
      try {
        await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify(_snapCmds),
        });
      } catch (e) {
        return errorResponse(`Pipeline write failed: ${e.message}`, 500);
      }
    }
    return jsonResponse({
      ok: successCount > 0,
      successCount,
      failedCount: _snapFailed.length,
      failed: _snapFailed,
      durationMs: Date.now() - startMs,
    });
  }

  return null;
}
