import React from 'react';
import { WORKER } from './constants.js';

// Orchestrates the three auth-driven sync effects, extracted from App.jsx 2026-05-27.
//   1. On mount with a stored email: load picks + bankroll from server via cookie auth,
//      prime delta-save baseline, run one-time legacy-localStorage migration.
//   2. Debounced auto-save (400ms) whenever trackedPlays/bankroll change.
//   3. Pre-unload flush (visibilitychange hidden + pagehide) so mobile users who star
//      a pick and immediately background the app don't lose it.
//
// Uses authEmail (localStorage-backed) as the "is logged in" signal instead of authToken.
// The session cookie (HttpOnly, set by the server on login) is sent automatically on all
// same-origin requests — no Authorization header needed.
export function useAuthPickSync({
  authEmail,
  trackedPlays,
  bankroll,
  savePicks,
  primeSync,
  setSyncStatus,
  setTrackedPlays,
  setBankrollState,
  authClearToken,
}) {
  const picksLoaded = React.useRef(!localStorage.getItem("sb_email")); // true = no server load needed
  const syncTimer = React.useRef(null);

  // Auto-save whenever picks/bankroll change (debounced 400ms).
  // Guard: don't save until server picks have been loaded — prevents overwriting with [] on mount.
  React.useEffect(() => {
    if (!authEmail || !picksLoaded.current) return;
    setSyncStatus("saving");
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => savePicks(trackedPlays, bankroll), 400);
    return () => clearTimeout(syncTimer.current);
  }, [trackedPlays, bankroll, authEmail, savePicks, setSyncStatus]);

  // Flush pending picks before tab is hidden/closed.
  React.useEffect(() => {
    if (!authEmail) return;
    const flush = () => {
      if (!picksLoaded.current) return;
      clearTimeout(syncTimer.current);
      savePicks(trackedPlays, bankroll).catch(() => {});
    };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
    };
  }, [authEmail, trackedPlays, bankroll, savePicks]);

  // Load picks from server on mount if email is stored (= user had an active session).
  // Cookie is sent automatically; no Authorization header needed.
  React.useEffect(() => {
    if (!authEmail) return;
    const legacyLocal = (() => { try { return JSON.parse(localStorage.getItem("scoreboard_tracked_plays") || "[]"); } catch { return []; } })();
    fetch(`${WORKER}/user/picks`)
      .then(r => {
        if (r.status === 401) {
          authClearToken();
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then(pd => {
        if (pd) {
          const serverPicks = pd.picks || [];
          if (pd.bankroll) setBankrollState(pd.bankroll);
          primeSync(serverPicks, pd.bankroll);
          if (legacyLocal.length > 0) {
            const serverIds = new Set(serverPicks.map(p => p.id));
            const localOnly = legacyLocal.filter(p => !serverIds.has(p.id));
            const merged = [...localOnly, ...serverPicks].sort((a, b) => (b.trackedAt || 0) - (a.trackedAt || 0));
            setTrackedPlays(merged);
            if (localOnly.length > 0) {
              savePicks(merged, pd.bankroll ?? null).catch(() => {});
            }
            localStorage.removeItem("scoreboard_tracked_plays");
          } else {
            setTrackedPlays(serverPicks);
          }
        }
        picksLoaded.current = true;
      })
      .catch(() => { picksLoaded.current = true; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
