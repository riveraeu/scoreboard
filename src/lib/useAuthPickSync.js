import React from 'react';
import { WORKER } from './constants.js';

// Orchestrates the three auth-driven sync effects, extracted from App.jsx 2026-05-27:
//   1. On mount with a token: load picks + bankroll from server, prime delta-save baseline,
//      run one-time legacy-localStorage migration. Sets `picksLoaded` so subsequent saves
//      know it's safe to write back.
//   2. Debounced auto-save (400ms) whenever trackedPlays/bankroll change.
//   3. Pre-unload flush (`visibilitychange` hidden + `pagehide`) so mobile users who star
//      a pick and immediately background the app don't lose it.
//
// This hook is pure side-effects — returns nothing. Inputs come from the other hooks
// (useAuth, useSavePicks, usePicks). Coordinates them so App.jsx doesn't have to.
export function useAuthPickSync({
  authToken,
  trackedPlays,
  bankroll,
  savePicks,
  primeSync,
  setSyncStatus,
  setTrackedPlays,
  setBankrollState,
  authClearToken,
}) {
  const picksLoaded = React.useRef(!localStorage.getItem("sb_token")); // true if no token (no server load needed)
  const syncTimer = React.useRef(null);

  // Auto-save picks to server whenever they change (debounced 400ms — short enough that mobile
  // users tapping a star and immediately refreshing have a good chance of the save landing).
  // Guard: don't save until server picks have been loaded — prevents overwriting with [] on mount.
  React.useEffect(() => {
    if (!authToken || !picksLoaded.current) return;
    setSyncStatus("saving");
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => savePicks(authToken, trackedPlays, bankroll), 400);
    return () => clearTimeout(syncTimer.current);
  }, [trackedPlays, bankroll, authToken, savePicks, setSyncStatus]);

  // Flush pending picks before the tab is hidden/closed — covers the case where the user
  // taps star then immediately backgrounds the app on mobile (Safari/iOS may not fire
  // beforeunload). pagehide and visibilitychange combined cover all platforms.
  React.useEffect(() => {
    if (!authToken) return;
    const flush = () => {
      if (!picksLoaded.current) return;
      clearTimeout(syncTimer.current);
      savePicks(authToken, trackedPlays, bankroll).catch(() => {});
    };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
    };
  }, [authToken, trackedPlays, bankroll, savePicks]);

  // Load picks from server on mount if token exists.
  // Server is the single source of truth — no localStorage merging. A one-time migration
  // pushes any legacy localStorage picks not on the server up before clearing local state.
  React.useEffect(() => {
    if (!authToken) return;
    const legacyLocal = (() => { try { return JSON.parse(localStorage.getItem("scoreboard_tracked_plays") || "[]"); } catch { return []; } })();
    fetch(`${WORKER}/user/picks`, { headers: { "Authorization": `Bearer ${authToken}` } })
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
          // Seed the delta-save baseline with the server's authoritative snapshot. Without
          // this, savePicks would diff against an empty Map and treat every pick as an upsert
          // on the first save after load.
          primeSync(serverPicks, pd.bankroll);
          // One-time migration: union any legacy-local picks the server doesn't have, then
          // drop the legacy key. After this runs successfully once, localStorage is never
          // consulted for picks again.
          if (legacyLocal.length > 0) {
            const serverIds = new Set(serverPicks.map(p => p.id));
            const localOnly = legacyLocal.filter(p => !serverIds.has(p.id));
            const merged = [...localOnly, ...serverPicks].sort((a, b) => (b.trackedAt || 0) - (a.trackedAt || 0));
            setTrackedPlays(merged);
            if (localOnly.length > 0) {
              savePicks(authToken, merged, pd.bankroll ?? null).catch(() => {});
            }
            localStorage.removeItem("scoreboard_tracked_plays");
          } else {
            setTrackedPlays(serverPicks);
          }
        }
        picksLoaded.current = true;
      })
      .catch(() => {
        // Server unreachable — leave trackedPlays empty and leave any legacy localStorage
        // key in place so the next successful load can migrate it.
        picksLoaded.current = true;
      });
  // Intentional one-shot effect (empty deps): only run the mount load. Subsequent token
  // changes via login/register are handled by authSubmit in App.jsx, not by re-firing this.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
