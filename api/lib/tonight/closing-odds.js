// Closing-line snapshot helper used by NBA/WNBA/NHL meta builds.
//
// Pattern: ESPN scoreboard returns empty `odds` once a game is in/post. To preserve the
// pre-game closing line on the matchup card across the in→post lifecycle, snapshot every
// pre-game odds row to a Redis key per sport, then overlay it back when the game goes
// in/post. If no snapshot exists for an in/post game, CLEAR the live odds (in-game prices
// look like real lines but are model-derived — don't mislead).
//
// MLB uses the same pattern with a today/tomorrow split, so it stays inline in path.js.
//
// Args:
//   cache      — Vercel KV / Upstash cache (CACHE2)
//   isBustCache — boolean; skips the cache read so a bust starts fresh
//   snapKey    — Redis key (e.g. 'nbaClosingOdds')
//   scoresMap  — { '${homeAbbr}|${date}': { homeTeam, awayTeam, state, gameDate, ... } }
//   oddsMap    — { abbr: { ml, total, spread } } — MUTATED in-place

export async function applyClosingSnapshot(cache, isBustCache, snapKey, scoresMap, oddsMap) {
  try {
    const prev = (cache && !isBustCache) ? ((await cache.get(snapKey, 'json').catch(() => null)) || {}) : {};
    const snap = { ...prev };
    let dirty = false;
    for (const sc of Object.values(scoresMap || {})) {
      const hA = sc?.homeTeam, aA = sc?.awayTeam, gD = sc?.gameDate, state = sc?.state;
      if (!hA || !aA || !gD) continue;
      const gK = `${hA}|${aA}|${gD}`;
      const homeLive = oddsMap[hA];
      const awayLive = oddsMap[aA];
      if (state === 'pre') {
        if ((homeLive && (homeLive.ml != null || homeLive.total != null)) ||
            (awayLive && (awayLive.ml != null || awayLive.total != null))) {
          snap[gK] = { home: homeLive ?? null, away: awayLive ?? null };
          dirty = true;
        }
      } else if (state === 'in' || state === 'post') {
        const s = snap[gK];
        if (s) {
          if (s.home) oddsMap[hA] = s.home;
          if (s.away) oddsMap[aA] = s.away;
        } else {
          delete oddsMap[hA];
          delete oddsMap[aA];
        }
      }
    }
    if (dirty && cache) cache.put(snapKey, JSON.stringify(snap), { expirationTtl: 36 * 3600 }).catch(() => {});
  } catch { /* non-fatal */ }
}
