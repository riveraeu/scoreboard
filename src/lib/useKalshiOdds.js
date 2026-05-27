import React from 'react';
import { WORKER } from './constants.js';

// Player-card Kalshi player-prop odds fetcher, extracted from App.jsx (E-14).
//
// Fires whenever player / sport / safeTab changes. Only the three sports/stats Kalshi
// actually lists player-prop markets for (NBA points/rebounds/assists/3PT, NHL points,
// MLB hits/HRR/strikeouts) trigger a fetch; everything else short-circuits to {}.
// Per-player+stat results memoize in kalshiCache (a ref, not a state — no re-renders on
// cache hit) so flipping between tabs and back doesn't refetch.
const KALSHI_STATS = {
  "basketball/nba": { points:"points", rebounds:"rebounds", assists:"assists", threePointers:"threePointers" },
  "hockey/nhl":     { points:"points" },
  "baseball/mlb":   { hits:"hits", hrr:"hrr", strikeouts:"strikeouts" },
};

export function useKalshiOdds({ player, sport, safeTab }) {
  const [kalshiOdds, setKalshiOdds] = React.useState({});
  const kalshiCache = React.useRef({}); // memoize Kalshi fetches by "playerName|sport|stat"

  React.useEffect(() => {
    const kalshiStat = KALSHI_STATS[sport]?.[safeTab];
    if (!player || !kalshiStat) { setKalshiOdds({}); return; }
    const cacheKey = `${player.name}|${sport.split("/")[1]}|${kalshiStat}`;
    if (kalshiCache.current[cacheKey]) { setKalshiOdds(kalshiCache.current[cacheKey]); return; }
    const sportSlug = sport.split("/")[1];
    fetch(`${WORKER}/kalshi?playerName=${encodeURIComponent(player.name)}&stat=${kalshiStat}&sport=${sportSlug}`)
      .then(r => r.json())
      .then(data => {
        const map = {};
        (data.markets || []).forEach(m => { map[m.threshold] = m; });
        kalshiCache.current[cacheKey] = map;
        setKalshiOdds(map);
      })
      .catch(() => setKalshiOdds({}));
  }, [player, safeTab, sport]);

  return { kalshiOdds };
}
