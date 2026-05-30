import React from 'react';
import { WORKER } from './constants.js';

// Login/register/logout flow, extracted from App.jsx (E-11). Sits on top of the lower-level
// useAuth (token + form state + /auth/login + /auth/register calls) and coordinates with
// the picks subsystem (usePicks + useSavePicks) so:
//
//   - Successful register pushes the in-memory picks/bankroll to the server (preserves any
//     work the user did before signing up).
//   - Successful login fetches the server's authoritative picks/bankroll and replaces
//     in-memory state (server wins).
//   - Logout drops legacy localStorage keys, calls useAuth's clearToken, resets pick state
//     to defaults, and resets the delta-save baseline so a fresh login doesn't diff against
//     the prior user's snapshot.
//
// Also owns the showAuthModal toggle — purely UI state for the login/register overlay.
export function useAuthFlow({
  authenticate,
  authMode,
  authLogout,
  savePicks,
  resetSync,
  trackedPlays,
  bankroll,
  setTrackedPlays,
  setBankrollState,
}) {
  const [showAuthModal, setShowAuthModal] = React.useState(false);

  const authSubmit = React.useCallback(async (e) => {
    e.preventDefault();
    const res = await authenticate(authMode);
    if (!res.ok) return;
    setShowAuthModal(false);
    // On login: load picks from server (server is authoritative).
    // On register: push current local picks to server.
    if (authMode === "register") {
      await savePicks(trackedPlays, bankroll);
    } else {
      const pr = await fetch(`${WORKER}/user/picks`);
      if (pr.ok) {
        const pd = await pr.json();
        setTrackedPlays(pd.picks || []);
        if (pd.bankroll) setBankrollState(pd.bankroll);
      }
    }
  }, [authenticate, authMode, savePicks, trackedPlays, bankroll, setTrackedPlays, setBankrollState]);

  const logout = React.useCallback(() => {
    localStorage.removeItem("scoreboard_tracked_plays");
    localStorage.removeItem("scoreboard_bankroll");
    authLogout();
    setTrackedPlays([]);
    setBankrollState(1000);
    // Reset delta-save baseline so a re-login doesn't diff against a stale prior-user snapshot.
    resetSync();
  }, [authLogout, setTrackedPlays, setBankrollState, resetSync]);

  return { showAuthModal, setShowAuthModal, authSubmit, logout };
}
