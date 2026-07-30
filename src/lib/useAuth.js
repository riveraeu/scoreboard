import React from 'react';
import { WORKER } from './constants.js';

// Auth state + login/register/logout.
//
// Token is kept in React state only — never written to localStorage.
// An HttpOnly session cookie (sb_token) is set by the server on login/register,
// so the browser automatically sends it on every same-origin request. This means:
//   - XSS cannot steal the token (HttpOnly = not readable by JS)
//   - Page reloads preserve the session via cookie; authToken in state resets to null
//     but authEmail (localStorage) is the persistent "is logged in" signal.
//
// logout() calls POST /api/auth/logout to clear the server-side cookie, then
// drops the local email so the UI shows the login prompt.
export function useAuth() {
  const [authToken, setAuthToken] = React.useState(null); // memory only — not localStorage
  const [authEmail, setAuthEmail] = React.useState(() => localStorage.getItem("sb_email") || null);
  const [authMode, setAuthMode] = React.useState("login");
  const [authForm, setAuthForm] = React.useState({ email: "", password: "" });
  const [authError, setAuthError] = React.useState("");
  const [authLoading, setAuthLoading] = React.useState(false);

  const authenticate = React.useCallback(async (mode) => {
    setAuthError("");
    setAuthLoading(true);
    const endpoint = mode === "login" ? "auth/login" : "auth/register";
    try {
      const r = await fetch(`${WORKER}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authForm.email.trim(), password: authForm.password }),
      });
      const data = await r.json();
      if (!r.ok) {
        setAuthError(data.error || "Something went wrong");
        return { ok: false };
      }
      // Server sets the HttpOnly cookie; we only store the non-sensitive email locally.
      localStorage.setItem("sb_email", data.email);
      setAuthEmail(data.email);
      setAuthForm({ email: "", password: "" });
      return { ok: true, email: data.email };
    } catch {
      setAuthError("Network error");
      return { ok: false };
    } finally {
      setAuthLoading(false);
    }
  }, [authForm.email, authForm.password]);

  const logout = React.useCallback(async () => {
    // Clear the server-side HttpOnly cookie.
    await fetch(`${WORKER}/auth/logout`, { method: "POST" }).catch(() => {});
    localStorage.removeItem("sb_email");
    setAuthToken(null);
    setAuthEmail(null);
  }, []);

  return {
    authToken, authEmail,
    authMode, setAuthMode,
    authForm, setAuthForm,
    authError, setAuthError, authLoading,
    authenticate, logout,
  };
}
