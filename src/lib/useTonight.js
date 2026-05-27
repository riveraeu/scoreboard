import React from 'react';
import { WORKER } from './constants.js';

// Tonight-plays state + fetch lifecycle, extracted from App.jsx 2026-05-27.
//
// Initial fetch is plain `/tonight` — the snap-first server path delivers warm-cached
// responses in a few hundred ms. After mount, polls every 2 min (aligned to the
// `/api/kalshi-snapshot` cron's cadence so most polls land on a fresh snap) and pauses
// when the tab is hidden. On visibility resume an immediate catch-up fetch fires so
// users returning after a long idle don't wait up to 2 min. `bustCache()` is the only
// path that uses `?bust=1` — the manual ↻ button.
export function useTonight(qualifiedFilter) {
  const [tonightPlays, setTonightPlays] = React.useState(null);
  const [allTonightPlays, setAllTonightPlays] = React.useState(null);
  const [nbaDropped, setNbaDropped] = React.useState(null);
  const [tonightLoading, setTonightLoading] = React.useState(true);
  const [tonightMeta, setTonightMeta] = React.useState(null);
  const [mlbMeta, setMlbMeta] = React.useState(null);
  const [mlbMetaTomorrow, setMlbMetaTomorrow] = React.useState(null);
  const [nbaMeta, setNbaMeta] = React.useState(null);
  const [wnbaMeta, setWnbaMeta] = React.useState(null);
  const [nhlMeta, setNhlMeta] = React.useState(null);
  const [bustLoading, setBustLoading] = React.useState(false);

  // Stash latest filter in a ref so the long-lived polling closure picks up changes
  // without restarting the interval.
  const filterRef = React.useRef(qualifiedFilter);
  React.useEffect(() => { filterRef.current = qualifiedFilter; }, [qualifiedFilter]);

  const applyData = React.useCallback((data) => {
    const all = data.plays || [];
    setAllTonightPlays(all);
    setNbaDropped(data.nbaDropped || []);
    setTonightPlays(all.filter(filterRef.current));
    setTonightMeta({ qualifyingCount: data.qualifyingCount, preFilteredCount: data.preFilteredCount });
    if (data.mlbMeta) setMlbMeta(data.mlbMeta);
    if (data.mlbMetaTomorrow) setMlbMetaTomorrow(data.mlbMetaTomorrow);
    if (data.nbaMeta) setNbaMeta(data.nbaMeta);
    if (data.wnbaMeta) setWnbaMeta(data.wnbaMeta);
    if (data.nhlMeta) setNhlMeta(data.nhlMeta);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    let intervalId = null;
    const POLL_MS = 120_000;
    const doFetch = (isInitial) => {
      if (cancelled) return;
      if (isInitial) setTonightLoading(true);
      fetch(`${WORKER}/tonight`)
        .then(r => r.json())
        .then(data => { if (cancelled) return; applyData(data); if (isInitial) setTonightLoading(false); })
        .catch(() => { if (cancelled || !isInitial) return; setAllTonightPlays([]); setNbaDropped([]); setTonightPlays([]); setTonightLoading(false); });
    };
    const startPolling = () => {
      if (intervalId != null) return;
      intervalId = setInterval(() => doFetch(false), POLL_MS);
    };
    const stopPolling = () => {
      if (intervalId == null) return;
      clearInterval(intervalId);
      intervalId = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        doFetch(false);
        startPolling();
      } else {
        stopPolling();
      }
    };
    doFetch(true);
    if (document.visibilityState === "visible") startPolling();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [applyData]);

  const bustCache = React.useCallback(() => {
    if (bustLoading) return;
    setBustLoading(true);
    setTonightLoading(true);
    fetch(`${WORKER}/tonight?bust=1`)
      .then(r => r.json())
      .then(data => { applyData(data); setTonightLoading(false); setBustLoading(false); })
      .catch(() => { setAllTonightPlays([]); setNbaDropped([]); setTonightPlays([]); setTonightLoading(false); setBustLoading(false); });
  }, [applyData, bustLoading]);

  return {
    tonightPlays, allTonightPlays, nbaDropped,
    tonightMeta, tonightLoading,
    mlbMeta, mlbMetaTomorrow, nbaMeta, wnbaMeta, nhlMeta,
    bustCache, bustLoading,
  };
}
