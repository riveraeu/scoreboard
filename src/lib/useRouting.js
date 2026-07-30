import React from 'react';
import { WORKER, TEAM_DB } from './constants.js';
import { slugify, teamUrl } from './utils.js';

// URL routing extracted from App.jsx (E-7). Owns teamPage / teamPageData / pendingSlug state,
// the mount + popstate listeners, the team-page loader, and the navigation callbacks
// (navigateToTeam / navigateToPlayer / goBack). The taker /picks route (picksPage /
// navigateToPicks / LineupsPage) was removed 2026-07-30 with the taker strategy; the maker
// board is now the only non-player/team landing. /model was removed 2026-07-22 when the
// ReportPage route was deprecated — see project_do_this_banner memory.
//
// Player state still lives in App.jsx (entangled with player card, gamelog parsing, and
// Kalshi-odds effects), so the hook takes setPlayer + setQuery setters for the bits it
// needs to nudge. selectPlayer is accepted via a ref (selectPlayerRef) because selectPlayer
// itself depends on setTeamPage (returned from this hook) — passing it as a value would be
// a circular dependency. App.jsx assigns `selectPlayerRef.current = selectPlayer` after
// defining selectPlayer; the ref is only dereferenced inside async/event handlers, so it's
// always populated by the time it's read.
export function useRouting({ setPlayer, setQuery, selectPlayerRef }) {
  const [teamPage, setTeamPage] = React.useState(null);
  const [teamPageData, setTeamPageData] = React.useState(null);
  const [pendingSlug, setPendingSlug] = React.useState(null);

  const loadTeamPage = React.useCallback(async (abbr, sport) => {
    setPlayer(null);
    setTeamPage({ abbr: abbr.toUpperCase(), sport });
    setTeamPageData({ loading: true, error: null, data: null });
    try {
      const r = await fetch(`${WORKER}/team?abbr=${abbr}&sport=${sport}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setTeamPageData({ loading: false, error: null, data });
    } catch(e) {
      setTeamPageData({ loading: false, error: e.message, data: null });
    }
  }, [setPlayer]);

  const resolveSlug = React.useCallback((slug, sportOverride) => {
    if (!slug) { setPlayer(null); setTeamPage(null); return; }
    const upper = slug.toUpperCase();
    const spPriority = sportOverride ? [sportOverride] : ["mlb","nba","wnba","nhl"];
    for (const sp of spPriority) {
      const match = TEAM_DB.find(t => t.abbr === upper && t.sport === sp);
      if (match) { loadTeamPage(match.abbr, match.sport); return; }
    }
    // Player slug — store and resolve after athletes search
    setPendingSlug(slug);
  }, [setPlayer, loadTeamPage]);

  // On mount: resolve URL slug; listen for back/forward
  React.useEffect(() => {
    const slug = window.location.pathname.slice(1);
    const sp = new URLSearchParams(window.location.search).get("sport");
    if (slug) resolveSlug(slug, sp);
    const onPop = () => {
      const s = window.location.pathname.slice(1);
      const qp = new URLSearchParams(window.location.search).get("sport");
      if (!s) { setPlayer(null); setTeamPage(null); }
      else resolveSlug(s, qp);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  // Intentional one-shot effect — resolveSlug uses stable setters only, so the captured
  // mount-time identity continues to work.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve pending player slug via ESPN search
  React.useEffect(() => {
    if (!pendingSlug) return;
    // CamelCase → "Gavin Williams"
    const name = pendingSlug.replace(/([A-Z][a-z]*)/g, "$1 ").trim();
    fetch(`${WORKER}/athletes?q=${encodeURIComponent(name)}`)
      .then(r => r.json())
      .then(d => {
        const items = d.items || [];
        const match = items.find(a => slugify(a.name) === pendingSlug) || items[0];
        if (match) selectPlayerRef.current?.(match);
      })
      .catch(() => {})
      .finally(() => setPendingSlug(null));
  // selectPlayerRef is a ref — intentionally not in deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSlug]);

  const navigateToTeam = React.useCallback((abbr, sport) => {
    const url = teamUrl(abbr, sport);
    history.pushState({}, "", url);
    loadTeamPage(abbr, sport);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [loadTeamPage]);

  const navigateToPlayer = React.useCallback((p, tab) => {
    const slug = slugify(p.name);
    history.pushState({}, "", `/${slug}`);
    selectPlayerRef.current?.(p, tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  // selectPlayerRef is a ref — intentionally not in deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goBack = React.useCallback(() => {
    history.pushState({}, "", "/");
    setPlayer(null);
    setTeamPage(null);
    setQuery("");
  }, [setPlayer, setQuery]);

  return {
    teamPage, setTeamPage,
    teamPageData,
    navigateToTeam, navigateToPlayer, goBack,
  };
}
