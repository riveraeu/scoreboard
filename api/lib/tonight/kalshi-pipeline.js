// Kalshi market-fetch pipeline. 2-tier read chain:
//   1. Snap-first read (single Upstash MGET, all-or-nothing freshness check) — preferred.
//      The snapshot cron writes kalshi:snap:{ticker} every 10 min; this is the hot path.
//   2. REST fallback with throttled batches (3 parallel / 700ms delay, shuffled) + per-ticker
//      stale fallback (kalshi:stale:{ticker}). Genuinely-fresh fetches are written back to the
//      snap keys (chunked at 7MB) so the next request takes Tier 1 again. The old monolithic
//      kalshi:bundle key was retired 2026-06-22 — a single SET of the whole slate silently 413'd
//      once it grew past the Upstash 10MB request cap (see api/lib/kv-pipeline.js).
//
// Stale markets are marked with `_kalshiStale: true` so downstream consumers can flag them in
// the dataConfidence penalty table.
//
// Returns: { kalshiResults: [{markets:[]}, ...], staleKalshiSeries: string[], kalshiSnapMeta,
//   kalshiUsedSnaps: boolean }

import { pipeWriteChunked } from "../kv-pipeline.js";
import { gzipToString, gunzipFromString } from "../kv-compress.js";

const SNAP_FRESHNESS_MS = 900_000;  // 1.5× the 10-min cron cycle
const KALSHI_BATCH = 3;
const KALSHI_BATCH_DELAY_MS = 700;

// Per-ticker REST fetch with stale fallback. Used by the bundle/REST tier.
async function fetchKalshiSeries(ticker, cache) {
  const staleKey = `kalshi:stale:${ticker}`;
  const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ticker}&limit=1000&status=open`, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    cf: { cacheEverything: false },
  }).catch(() => null);
  if (r?.status === 429) {
    if (cache) {
      const stale = await cache.get(staleKey, "json").catch(() => null);
      if (stale) {
        for (const m of stale.markets || []) m._kalshiStale = true;
        return { data: stale, stale: true, rateLimited: true };
      }
    }
    return { data: { markets: [] }, rateLimited: true };
  }
  const fresh = r?.ok ? await r.json().catch(() => null) : null;
  if (fresh && (fresh.markets || []).length > 0) {
    // 30-min TTL caps how stale per-ticker fallback can drift if Kalshi keeps 429-ing.
    if (cache) await cache.put(staleKey, JSON.stringify(fresh), { expirationTtl: 1800 }).catch(() => {});
    return { data: fresh };
  }
  if (cache) {
    const stale = await cache.get(staleKey, "json").catch(() => null);
    if (stale) {
      for (const m of stale.markets || []) m._kalshiStale = true;
      return { data: stale, stale: true };
    }
  }
  return { data: { markets: [] }, failed: true };
}

export async function fetchKalshiMarkets({ seriesTickers, cache, env, isBustCache }) {
  // Tier 1: snap-first read (Upstash MGET; all-or-nothing freshness)
  let kalshiResults;
  let kalshiSnapMeta = null;
  let kalshiUsedSnaps = false;
  if (!isBustCache && env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) {
    const _snapAuth = `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`;
    try {
      const _snapCmds = [
        ["MGET", ...seriesTickers.map(t => `kalshi:snap:${t}`)],
        ["GET", "kalshi:snap:_meta"],
      ];
      const _pipeRes = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
        method: "POST",
        headers: { Authorization: _snapAuth, "Content-Type": "application/json" },
        body: JSON.stringify(_snapCmds),
      }).then(r => r.json()).catch(() => null);
      const _mget = _pipeRes?.[0]?.result;
      const _metaRaw = _pipeRes?.[1]?.result;
      try { kalshiSnapMeta = _metaRaw ? JSON.parse(_metaRaw) : null; } catch {}
      if (Array.isArray(_mget) && _mget.length === seriesTickers.length) {
        const _parsed = await Promise.all(_mget.map(async s => {
          if (!s) return null;
          try { return JSON.parse(await gunzipFromString(s)); } catch { return null; }
        }));
        const _now = Date.now();
        // Empty markets is a valid snap (off-season / no-game-tonight series). Require
        // only that the snap exists and is fresh; downstream loops yield zero plays naturally.
        const _allFresh = _parsed.every(s =>
          s && Array.isArray(s.markets)
          && (_now - (s.writtenAt || 0) <= SNAP_FRESHNESS_MS)
        );
        if (_allFresh) {
          kalshiResults = _parsed.map(s => ({ markets: s.markets }));
          kalshiUsedSnaps = true;
        }
      }
    } catch {}
  }

  if (kalshiUsedSnaps) {
    // already populated from snaps
  } else {
    // Tier 2: throttled REST. Shuffle so no series is deterministically last-in-line.
    const _shuffled = [...seriesTickers];
    for (let _si = _shuffled.length - 1; _si > 0; _si--) {
      const _sj = Math.floor(Math.random() * (_si + 1));
      [_shuffled[_si], _shuffled[_sj]] = [_shuffled[_sj], _shuffled[_si]];
    }
    const resultMap = {};
    const fetchMeta = {};
    for (let off = 0; off < _shuffled.length; off += KALSHI_BATCH) {
      const batch = _shuffled.slice(off, off + KALSHI_BATCH);
      const batchRes = await Promise.all(batch.map(t => fetchKalshiSeries(t, cache)));
      for (let j = 0; j < batch.length; j++) {
        resultMap[batch[j]] = batchRes[j].data;
        fetchMeta[batch[j]] = { rateLimited: !!batchRes[j].rateLimited, failed: !!batchRes[j].failed, stale: !!batchRes[j].stale };
      }
      if (off + KALSHI_BATCH < _shuffled.length) {
        await new Promise(res => setTimeout(res, KALSHI_BATCH_DELAY_MS));
      }
    }
    kalshiResults = seriesTickers.map(t => resultMap[t] || { markets: [] });
    // Refresh the per-ticker snap cache with the genuinely-fresh fetches so the next request
    // takes the Tier-1 snap path instead of re-hitting Kalshi REST. Chunked at 7MB to stay under
    // the Upstash 10MB cap (the retired kalshi:bundle key was one un-chunked SET of the whole
    // slate). Only write rows that came back fresh + non-empty: stale/rate-limited/failed series
    // keep their own kalshi:stale:{ticker} fallback (set in fetchKalshiSeries) and must NOT be
    // re-stamped with a fresh writtenAt. A bust=1 refetch may briefly overwrite the cron's
    // depth-enriched snaps with depthless ones; the next 2-min cron re-attaches depth.
    if (cache && env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) {
      const _now = Date.now();
      const _cmds = [];
      for (const t of seriesTickers) {
        const meta = fetchMeta[t] || {};
        const markets = resultMap[t]?.markets || [];
        if (markets.length > 0 && !meta.stale && !meta.rateLimited && !meta.failed) {
          const raw = JSON.stringify({ markets, writtenAt: _now });
          let v = raw;
          try { v = await gzipToString(raw); } catch {}
          _cmds.push(["SET", `kalshi:snap:${t}`, v, "EX", 300]);
        }
      }
      if (_cmds.length) {
        await pipeWriteChunked({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, cmds: _cmds, label: "kalshi-snap-refresh" });
      }
    }
  }

  // Series that came from the per-ticker stale fallback (kalshi:stale:{ticker}) this request.
  // Surfaced at the top of the response so we can spot when prices have drifted past a snap
  // cycle, and used to mark per-play `_kalshiStale: true`.
  const staleKalshiSeries = [];
  for (let i = 0; i < seriesTickers.length; i++) {
    const markets = kalshiResults[i]?.markets || [];
    if (markets.some(m => m._kalshiStale)) staleKalshiSeries.push(seriesTickers[i]);
  }

  return { kalshiResults, staleKalshiSeries, kalshiSnapMeta, kalshiUsedSnaps };
}
