import React from 'react';
import { WORKER } from './constants.js';

// Auth state + login/register/logout, extracted from App.jsx 2026-05-27.
//
// Owns: authToken/authEmail (localStorage-backed), authMode (login/register form toggle),
// authForm (email/password), authError, authLoading. Exposes `authenticate(mode)` which
// performs the API call and returns `{ ok, token?, email? }`. On `ok: true` the hook has
// already updated state + localStorage; the caller handles pick load / pick push.
//
// `logout` clears the auth state + sb_token/sb_email localStorage keys. Callers should
// also reset pick state / sync baseline / pick-storage localStorage in App.jsx since those
// cross hook boundaries.
export function useAuth() {
  const [authToken, setAuthToken] = React.useState(() => localStorage.getItem("sb_token") || null);
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
      localStorage.setItem("sb_token", data.token);
      localStorage.setItem("sb_email", data.email);
      setAuthToken(data.token);
      setAuthEmail(data.email);
      setAuthForm({ email: "", password: "" });
      return { ok: true, token: data.token, email: data.email };
    } catch {
      setAuthError("Network error");
      return { ok: false };
    } finally {
      setAuthLoading(false);
    }
  }, [authForm.email, authForm.password]);

  const logout = React.useCallback(() => {
    localStorage.removeItem("sb_token");
    localStorage.removeItem("sb_email");
    setAuthToken(null);
    setAuthEmail(null);
  }, []);

  // Used by the pick-load effect to clear stale tokens server-rejected as 401.
  const clearToken = React.useCallback(() => {
    localStorage.removeItem("sb_token");
    localStorage.removeItem("sb_email");
    setAuthToken(null);
    setAuthEmail(null);
  }, []);

  return {
    authToken, authEmail,
    authMode, setAuthMode,
    authForm, setAuthForm,
    authError, authLoading,
    authenticate, logout, clearToken,
  };
}
