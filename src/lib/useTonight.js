import React from 'react';
import { WORKER } from './constants.js';

// Tonight-plays state + fetch lifecycle, extracted from App.jsx 2026-05-27.
//
// Since the taker strategy was removed (2026-07-30), this hook no longer filters plays into a
// "qualified" subset or fires new-play notifications — it just exposes the model's tonight plays
// for the player and team model dashboards. `tonightPlays` and `allTonightPlays` are the same
// array; both names are kept so the player card / TeamPage consumers didn't have to change.
//
// Initial fetch is plain `/tonight` — the snap-first server path delivers warm-cached
// responses in a few hundred ms. After mount, polls every 2 min (aligned to the
// `/api/kalshi-snapshot` cron's cadence so most polls land on a fresh snap) and pauses
// when the tab is hidden. On visibility resume an immediate catch-up fetch fires.
export function useTonight() {
  const [tonightPlays, setTonightPlays] = React.useState(null);
  const [allTonightPlays, setAllTonightPlays] = React.useState(null);
  const [nbaDropped, setNbaDropped] = React.useState(null);
  const [tonightLoading, setTonightLoading] = React.useState(true);

  const applyData = React.useCallback((data) => {
    const all = data.plays || [];
    setAllTonightPlays(all);
    setTonightPlays(all);
    setNbaDropped(data.nbaDropped || []);
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

  return { tonightPlays, allTonightPlays, nbaDropped, tonightLoading };
}
