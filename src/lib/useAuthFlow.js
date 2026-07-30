import React from 'react';

// Login/register/logout flow, extracted from App.jsx (E-11). Sits on top of the lower-level
// useAuth (token + form state + /auth/login + /auth/register calls). Since the taker picks
// subsystem was removed (2026-07-30) this no longer migrates tracked picks on login/register —
// it just drives the auth modal and clears the legacy localStorage pick keys on logout (harmless
// cleanup for accounts that predate the removal). Login is still required for the maker board and
// the Kalshi balance chip.
export function useAuthFlow({ authenticate, authMode, authLogout }) {
  const [showAuthModal, setShowAuthModal] = React.useState(false);

  const authSubmit = React.useCallback(async (e) => {
    e.preventDefault();
    const res = await authenticate(authMode);
    if (!res.ok) return;
    setShowAuthModal(false);
  }, [authenticate, authMode]);

  const logout = React.useCallback(() => {
    localStorage.removeItem("scoreboard_tracked_plays");
    localStorage.removeItem("scoreboard_bankroll");
    authLogout();
  }, [authLogout]);

  return { showAuthModal, setShowAuthModal, authSubmit, logout };
}
