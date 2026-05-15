import React from 'react';

// Model version toggle (Phase A — infra only). Returns [version, setVersion] where version is
// "v1" (default, current model) or "v2" (beta — SimScore-as-attribution refactor). When v2 is
// active, fetch URLs to /api/tonight should append &model=v2, and picks tracked while v2 is
// active get a `modelVersion: "v2"` field for calibration filtering. Phase A v1 and v2 produce
// identical play output; Phase B will add the actual behavior branching.
const MODEL_VERSION_KEY = "scoreboard_modelVersion";
export function useModelVersion() {
  const [version, setVersionState] = React.useState(() => {
    if (typeof window === "undefined") return "v1";
    return localStorage.getItem(MODEL_VERSION_KEY) === "v2" ? "v2" : "v1";
  });
  const setVersion = React.useCallback((v) => {
    const normalized = v === "v2" ? "v2" : "v1";
    localStorage.setItem(MODEL_VERSION_KEY, normalized);
    setVersionState(normalized);
  }, []);
  return [version, setVersion];
}

// Resize-aware media query check. Used for layout decisions that need to respond to rotation
// or window resize without a remount. Defaults to a 600px breakpoint.
export function useIsMobile(threshold = 600) {
  const [isMobile, setIsMobile] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= threshold;
  });
  React.useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= threshold);
    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', handler);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('orientationchange', handler);
    };
  }, [threshold]);
  return isMobile;
}
