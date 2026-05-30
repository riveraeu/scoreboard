// Kalshi-related endpoints + tiny meta endpoints that don't justify their own file:
//   /api/kalshi             — player-prop market lookup
//   /api/kalshi-totals      — all alt-line prices for a game/team total matchup (no gate)
//   /api/kalshi-snapshot    — cron-only snapshot writer (auth: CRON_SECRET)
//   /api/keepalive          — KV liveness ping
//
// Context: { path, request, params, env, CACHE2 }
//
// normName + jsonResponse/errorResponse imported directly (utils is stable).

import { jsonResponse, errorResponse } from "../utils.js";
import { SERIES_CONFIG, CRON_ONLY_TICKERS } from "../series-config.js";
import { verifyJWT } from "../auth-utils.js";

const normName = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Wrap PKCS#1 RSA private key DER bytes in a PKCS#8 container for Web Crypto importKey.
function _pkcs1ToPkcs8(pkcs1Der) {
  const _encLen = (len) => len < 128 ? [len] : len < 256 ? [0x81, len] : [0x82, (len >> 8) & 0xff, len & 0xff];
  const _seq = (c) => [0x30, ..._encLen(c.length), ...c];
  // AlgorithmIdentifier: SEQUENCE { OID rsaEncryption, NULL }
  const algId = _seq([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const version = [0x02, 0x01, 0x00];
  const octetStr = [0x04, ..._encLen(pkcs1Der.length), ...pkcs1Der];
  return new Uint8Array(_seq([...version, ...algId, ...octetStr]));
}

async function _importKalshiKey(pemString) {
  const pem = pemString.replace(/\\n/g, '\n').trim();
  const pemBody = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const pkcs8Der = pem.includes('BEGIN RSA PRIVATE KEY') ? _pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey('pkcs8', pkcs8Der.buffer, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
}

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
    if (!env?.KALSHI_API_KEY_ID || !env?.KALSHI_PRIVATE_KEY) return errorResponse("Kalshi API not configured", 500);
    // Build order payload
    const kalshiPath = "/trade-api/v2/portfolio/orders";
    const timestamp = String(Date.now()); // milliseconds, as Kalshi SDK uses
    const orderPayload = {
      ticker, side, action: "buy", type: "limit", count,
      ...(side === "yes" ? { yes_price: price } : { no_price: price }),
      ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
    };
    const payloadStr = JSON.stringify(orderPayload);
    // Sign: timestamp + method + path only (no body) using RSA-PSS SHA-256 with DIGEST_LENGTH salt (32)
    let signature;
    try {
      const key = await _importKalshiKey(env.KALSHI_PRIVATE_KEY);
      const msgBuf = new TextEncoder().encode(timestamp + "POST" + kalshiPath);
      const sigBuf = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, msgBuf);
      signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    } catch (e) {
      return errorResponse(`Signing failed: ${e?.message || e}`, 500);
    }
    const resp = await fetch(`https://api.elections.kalshi.com${kalshiPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "KALSHI-ACCESS-KEY": env.KALSHI_API_KEY_ID,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": signature,
      },
      body: payloadStr,
    }).catch(() => null);
    if (!resp) return errorResponse("Kalshi unreachable", 502);
    const respBody = await resp.json().catch(() => ({}));
    if (!resp.ok) return errorResponse(respBody?.error?.message || `Kalshi error ${resp.status}`, resp.status);
    return jsonResponse({ ok: true, order: respBody.order ?? respBody });
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
    const balanceCents = respBody.balance ?? 0;
    return jsonResponse({ balanceCents, balanceDollars: balanceCents / 100 });
  }

  return null;
}
