// Kalshi market-fetch pipeline. 3-tier read chain:
//   1. Snap-first read (single Upstash MGET, all-or-nothing freshness check) — preferred
//   2. Bundle cache (kalshi:bundle:{date}, 600s TTL, all series in one Redis key)
//   3. REST with throttled batches (3 parallel / 700ms delay, shuffled) + per-ticker stale fallback
//
// Stale markets are marked with `_kalshiStale: true` so downstream consumers can flag them in
// the dataConfidence penalty table.
//
// Returns: { kalshiResults: [{markets:[]}, ...], staleKalshiSeries: string[], kalshiSnapMeta,
//   kalshiUsedSnaps: boolean }

const SNAP_FRESHNESS_MS = 180_000;  // 1.5× the 2-min cron cycle
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
  const KALSHI_BUNDLE_KEY = `kalshi:bundle:${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

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
        const _parsed = _mget.map(s => { try { return s ? JSON.parse(s) : null; } catch { return null; } });
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

  // Tier 2: bundle cache
  const bundleCached = !kalshiUsedSnaps && !isBustCache && cache
    ? await cache.get(KALSHI_BUNDLE_KEY, "json").catch(() => null)
    : null;

  if (kalshiUsedSnaps) {
    // already populated from snaps
  } else if (bundleCached) {
    kalshiResults = seriesTickers.map(t => bundleCached[t] || { markets: [] });
  } else {
    // Tier 3: throttled REST. Shuffle so no series is deterministically last-in-line.
    const _shuffled = [...seriesTickers];
    for (let _si = _shuffled.length - 1; _si > 0; _si--) {
      const _sj = Math.floor(Math.random() * (_si + 1));
      [_shuffled[_si], _shuffled[_sj]] = [_shuffled[_sj], _shuffled[_si]];
    }
    // Read the previous bundle once so we can preserve entries for any series that came
    // back rate-limited / empty this cycle. Without this, a successful first fetch fills
    // the bundle, then a follow-up `?bust=1` racing into Kalshi rate limits would write
    // an empty entry over the good one and starve subsequent non-bust requests.
    const priorBundle = cache ? await cache.get(KALSHI_BUNDLE_KEY, "json").catch(() => null) : null;
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
    // Partial-outage protection: fall back to prior bundle entry for any rate-limited/failed series.
    if (priorBundle) {
      for (const t of seriesTickers) {
        const cur = resultMap[t]?.markets || [];
        const prior = priorBundle[t]?.markets || [];
        const meta = fetchMeta[t] || {};
        if (cur.length === 0 && prior.length > 0 && (meta.rateLimited || meta.failed)) {
          for (const m of prior) m._kalshiStale = true;
          resultMap[t] = priorBundle[t];
        }
      }
    }
    kalshiResults = seriesTickers.map(t => resultMap[t] || { markets: [] });
    if (cache && kalshiResults.some(d => (d.markets || []).length > 0)) {
      await cache.put(KALSHI_BUNDLE_KEY, JSON.stringify(resultMap), { expirationTtl: 600 }).catch(() => {});
    }
  }

  // Series that came from per-ticker stale fallback OR prior-bundle preservation this request.
  // Surfaced at the top of the response so we can spot when prices have drifted past one bundle
  // cycle, and used to mark per-play `_kalshiStale: true`.
  const staleKalshiSeries = [];
  for (let i = 0; i < seriesTickers.length; i++) {
    const markets = kalshiResults[i]?.markets || [];
    if (markets.some(m => m._kalshiStale)) staleKalshiSeries.push(seriesTickers[i]);
  }

  return { kalshiResults, staleKalshiSeries, kalshiSnapMeta, kalshiUsedSnaps };
}
