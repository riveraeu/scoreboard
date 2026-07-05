import React from 'react';
import { WORKER } from './constants.js';
import { isMarketUntrusted } from './placeValidation.js';

// Stable key for deduplicating qualified plays across polls — mirrors trackIdFor shape.
function _playKey(p) {
  const gd = p.gameDate || '';
  const u = p.direction === 'under' ? '|u' : '';
  if (p.gameType === 'teamTotal') return `tt|${p.scoringTeam}|${p.threshold}|${gd}${u}`;
  if (p.gameType === 'total') return `tot|${p.homeTeam}|${p.awayTeam}|${p.threshold}|${gd}${u}`;
  if (p.gameType === 'ml') return `ml|${p.pickTeam}|${gd}`;
  if (p.gameType === 'spread') return `sp|${p.pickTeam}|${p.pickLine}|${gd}`;
  return `${p.sport}|${p.playerName}|${p.stat}|${p.threshold}|${gd}`;
}

function _notifyNewPlays(plays) {
  if (!('Notification' in window)) return;
  const show = () => {
    const n = plays.length;
    const first = plays[0];
    const label = first.playerName
      ? `${first.playerName} ${first.stat} ${first.direction === 'under' ? 'U' : 'O'}${first.threshold}`
      : `${first.pickTeam || first.homeTeam} ${first.gameType}`;
    new Notification(
      n === 1 ? 'New qualified play' : `${n} new qualified plays`,
      { body: n === 1 ? label : `${label} +${n - 1} more`, icon: '/favicon.ico' },
    );
  };
  if (Notification.permission === 'granted') {
    show();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { if (p === 'granted') show(); });
  }
}

// Tonight-plays state + fetch lifecycle, extracted from App.jsx 2026-05-27.
//
// Initial fetch is plain `/tonight` — the snap-first server path delivers warm-cached
// responses in a few hundred ms. After mount, polls every 2 min (aligned to the
// `/api/kalshi-snapshot` cron's cadence so most polls land on a fresh snap) and pauses
// when the tab is hidden. On visibility resume an immediate catch-up fetch fires so
// users returning after a long idle don't wait up to 2 min. `bustCache()` is the only
// path that uses `?bust=1` — the manual ↻ button.
export function useTonight(qualifiedFilter, trackedPlaysRef) {
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

  // null = not yet seeded (first load). After first applyData, holds all play keys seen so far.
  // Bust resets nothing — won't re-notify plays already seen.
  const seenIdsRef = React.useRef(null);

  const applyData = React.useCallback((data) => {
    const all = data.plays || [];
    setAllTonightPlays(all);
    setNbaDropped(data.nbaDropped || []);
    const qualified = all.filter(filterRef.current);
    setTonightPlays(qualified);
    setTonightMeta({ qualifyingCount: data.qualifyingCount, preFilteredCount: data.preFilteredCount });
    if (data.mlbMeta) setMlbMeta(data.mlbMeta);
    if (data.mlbMetaTomorrow) setMlbMetaTomorrow(data.mlbMetaTomorrow);
    if (data.nbaMeta) setNbaMeta(data.nbaMeta);
    if (data.wnbaMeta) setWnbaMeta(data.wnbaMeta);
    if (data.nhlMeta) setNhlMeta(data.nhlMeta);

    if (seenIdsRef.current === null) {
      // Seed on first load — don't notify plays that were already qualified. Risky-market plays
      // are intentionally NOT seeded so they can notify later when their market clears (see below).
      seenIdsRef.current = new Set(qualified.filter(p => !isMarketUntrusted(p)).map(_playKey));
    } else {
      // Only "settle" (mark seen + notify) plays whose market is trustworthy enough to act on —
      // mirrors Place All's default-checked state (qualified && !risky). A qualified-but-risky play
      // (untested/thin market) is left UN-seeded so a later poll re-evaluates it: once its volume
      // develops it becomes fresh + trustworthy and notifies then, instead of pinging on a stale
      // zero-volume quote we'd never auto-bet (2026-06-13).
      const fresh = qualified.filter(p => !isMarketUntrusted(p) && !seenIdsRef.current.has(_playKey(p)));
      if (fresh.length > 0) {
        fresh.forEach(p => seenIdsRef.current.add(_playKey(p)));
        // Suppress notifications for plays whose player+stat (props) or exact key is
        // already tracked for the SAME game day — prevents pinging when a lower threshold
        // qualifies while a higher one is already tracked (same exposure, no action needed).
        // Day-scoped + active-only: trackedPlays holds full pick history, and an unscoped
        // key silently muted every previously-bet player forever (2026-06-12 bug).
        const tracked = trackedPlaysRef?.current || [];
        const trackedPropKeys = new Set(
          tracked
            .filter(t => t.stat && t.playerName && !t.gameType && !t.result)
            .map(t => `${t.sport}|${t.playerName}|${t.stat}|${t.gameDate ?? ''}`)
        );
        const notifiable = fresh.filter(p => {
          if (p.playerName && p.stat && !p.gameType) {
            return !trackedPropKeys.has(`${p.sport}|${p.playerName}|${p.stat}|${p.gameDate ?? ''}`);
          }
          return true;
        });
        if (notifiable.length > 0) _notifyNewPlays(notifiable);
      }
    }
  }, [trackedPlaysRef]);

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
