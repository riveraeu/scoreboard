import React from 'react';
import { WORKER, SPORTS, STAT_FULL, MLB_TEAM, TEAM_DB, TOTAL_THRESHOLDS, STAT_LABEL, SPORT_KEY, TODAY, MOCK_PLAYS, SPORT_BADGE_COLOR, GAMELOG_COLS } from './lib/constants.js';
import { lsGet, lsSet, ordinal, slugify, teamUrl } from './lib/utils.js';
import { getColor, matchupColor, tierColor } from './lib/colors.js';

import TotalsBarChart from './components/TotalsBarChart.jsx';
import TeamPage from './components/TeamPage.jsx';
import DayBar from './components/DayBar.jsx';
import { useDebounce } from './components/AddPickModal.jsx';
import AddPickModal from './components/AddPickModal.jsx';
import ModelPage from './components/ModelPage.jsx';

function App() {
  const [sport, setSport] = React.useState("basketball/nba"); // derived from selected player
  const [perGame, setPerGame] = React.useState([]);
  const [dvpData, setDvpData] = React.useState(null);
  const [mlbIsPitcher, setMlbIsPitcher] = React.useState(null); // null = unknown, true/false for MLB
  const [logs25, setLogs25] = React.useState(null); // MLB 2025 season aggregated (for truePct)
  const [query, setQuery] = React.useState("");
  const [suggestions, setSuggestions] = React.useState([]);
  const [showDrop, setShowDrop] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(-1);
  const [player, setPlayer] = React.useState(null);
  const [logs, setLogs] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [activeTab, setActiveTab] = React.useState("points");
  const [kalshiOdds, setKalshiOdds] = React.useState({});
  const [showBreakdown, setShowBreakdown] = React.useState(false);
  const [direction, setDirection] = React.useState("over"); // "over" | "under"
  const [editPickId, setEditPickId] = React.useState(null); // pick.id being edited
  const [searching, setSearching] = React.useState(false);
  const [tonightPlays, setTonightPlays] = React.useState(null);
  const [allTonightPlays, setAllTonightPlays] = React.useState(null); // unfiltered — includes qualified:false, used for player card truePct lookup
  const [nbaDropped, setNbaDropped] = React.useState(null); // NBA opp_not_soft drops — used for player card explanation when play didn't qualify
  const [tonightLoading, setTonightLoading] = React.useState(true);
  const [tonightMeta, setTonightMeta] = React.useState(null);
  const [testMode, setTestMode] = React.useState(false);
  const [bustLoading, setBustLoading] = React.useState(false);
  const [sportFilter, setSportFilter] = React.useState([]); // empty = all sports
  const [statFilter, setStatFilter] = React.useState([]);  // empty = all stats
  const [showPlaysInfo, setShowPlaysInfo] = React.useState(false);
  const [reportSort, setReportSort] = React.useState({"mlb|teamRuns":{col:"sim",dir:"desc"},"nba|teamPoints":{col:"sim",dir:"desc"}}); // { "sport|stat": { col, dir } }
  const [showReport, setShowReport] = React.useState(false);
  const [teamPage, setTeamPage] = React.useState(null);       // { abbr, sport }
  const [teamPageData, setTeamPageData] = React.useState(null); // { loading, error, data }
  const [pendingSlug, setPendingSlug] = React.useState(null);  // player slug to resolve after load
  const [modelPage, setModelPage] = React.useState(false);
  const [reportDataBySport, setReportDataBySport] = React.useState({});
  const [reportLoadingSport, setReportLoadingSport] = React.useState(null); // "mlb"|"nba"|"nhl"|null
  const [reportSport, setReportSport] = React.useState("mlb");
  const [calibData, setCalibData] = React.useState(null);
  const [calibLoading, setCalibLoading] = React.useState(false);
  const [gamelogSort, setGamelogSort] = React.useState({ col: 'date', dir: 'desc' });
  // Odds-based stake sizing: stake ($) = |americanOdds| / 10 (e.g. -257 → $25.7)
  const tierUnits = (americanOdds) => Math.abs(americanOdds || 0) / 10;
  const kalshiCache = React.useRef({}); // memoize Kalshi fetches by "playerName|sport|stat"
  const [expandedPlays, setExpandedPlays] = React.useState(new Set());
  const [trackedPlays, setTrackedPlays] = React.useState(() => {
    // Always load from localStorage as initial state — server load will overwrite if it has more data
    try { return JSON.parse(localStorage.getItem("scoreboard_tracked_plays") || "[]"); } catch { return []; }
  });
  const [bankroll, setBankrollState] = React.useState(() => {
    return parseFloat(localStorage.getItem("scoreboard_bankroll") || "1000");
  });
  const [chartGroupBy, setChartGroupBy] = React.useState("day");
  const [calcOdds, setCalcOdds] = React.useState("-");
  const [openPickDays, setOpenPickDays] = React.useState(() => new Set([new Date().toLocaleDateString("en-CA")]));
  const [openPickWeeks, setOpenPickWeeks] = React.useState(() => {
    const d = new Date(); const dow = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - ((dow + 6) % 7));
    return new Set([mon.toLocaleDateString("en-CA")]);
  });
  const [showAddPick, setShowAddPick] = React.useState(false);
  const [authToken, setAuthToken] = React.useState(() => localStorage.getItem("sb_token") || null);
  const [authEmail, setAuthEmail] = React.useState(() => localStorage.getItem("sb_email") || null);
  const [showAuthModal, setShowAuthModal] = React.useState(false);
  const [authMode, setAuthMode] = React.useState("login");
  const [authForm, setAuthForm] = React.useState({ email:"", password:"" });
  const [authError, setAuthError] = React.useState("");
  const [authLoading, setAuthLoading] = React.useState(false);
  const [syncStatus, setSyncStatus] = React.useState(null); // "saving"|"saved"|"error"
  const syncTimer = React.useRef(null);
  const picksLoaded = React.useRef(!localStorage.getItem("sb_token")); // true if no token (no server load needed)
  const debouncedQuery = useDebounce(query, 300);
  const dropRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const fetchRef = React.useRef(null);

  React.useEffect(() => {
    const h = e => {
      if (!dropRef.current?.contains(e.target) && !inputRef.current?.contains(e.target))
        setShowDrop(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // ── URL routing ──────────────────────────────────────────────────────────────
  function resolveSlug(slug, sportOverride) {
    if (!slug) { setPlayer(null); setTeamPage(null); setModelPage(false); return; }
    if (slug === "model") { setPlayer(null); setTeamPage(null); setModelPage(true); return; }
    setModelPage(false);
    const upper = slug.toUpperCase();
    const spPriority = sportOverride ? [sportOverride] : ["mlb","nba","nhl"];
    for (const sp of spPriority) {
      const match = TEAM_DB.find(t => t.abbr === upper && t.sport === sp);
      if (match) { loadTeamPage(match.abbr, match.sport); return; }
    }
    // Player slug — store and resolve after athletes search
    setPendingSlug(slug);
  }

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
        if (match) selectPlayer(match);
      })
      .catch(() => {})
      .finally(() => setPendingSlug(null));
  }, [pendingSlug]);

  async function loadTeamPage(abbr, sport) {
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
  }

  function navigateToTeam(abbr, sport) {
    const url = teamUrl(abbr, sport);
    history.pushState({}, "", url);
    loadTeamPage(abbr, sport);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function navigateToPlayer(p, tab) {
    const slug = slugify(p.name);
    history.pushState({}, "", `/${slug}`);
    selectPlayer(p, tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goBack() {
    history.pushState({}, "", "/");
    setPlayer(null);
    setTeamPage(null);
    setModelPage(false);
    setQuery("");
  }

  function navigateToModel() {
    history.pushState({}, "", "/model");
    setPlayer(null);
    setTeamPage(null);
    setModelPage(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Fetch tonight's plays on mount and when testMode toggles
  React.useEffect(() => {
    if (testMode) {
      setTonightPlays(MOCK_PLAYS);
      setTonightLoading(false);
      return;
    }
    const _sk = `tonight_v1_${new Date().toLocaleDateString('en-CA')}`;
    const _sc = (() => { try { const s = sessionStorage.getItem(_sk); if (!s) return null; const p = JSON.parse(s); return Date.now() - p.ts < 120000 ? p.data : null; } catch { return null; } })();
    if (_sc) { const all = _sc.plays || []; setAllTonightPlays(all); setNbaDropped(_sc.nbaDropped || []); setTonightPlays(all.filter(p => p.qualified !== false && (p.finalSimScore == null || p.finalSimScore >= 8) && (p.hitterFinalSimScore == null || p.hitterFinalSimScore >= 8))); setTonightMeta({ qualifyingCount: _sc.qualifyingCount, preFilteredCount: _sc.preFilteredCount }); setTonightLoading(false); return; }
    let cancelled = false;
    setTonightLoading(true);
    fetch(`${WORKER}/tonight`)
      .then(r => r.json())
      .then(data => { if (cancelled) return; try { sessionStorage.setItem(_sk, JSON.stringify({ts: Date.now(), data})); } catch {} const all = data.plays || []; setAllTonightPlays(all); setNbaDropped(data.nbaDropped || []); setTonightPlays(all.filter(p => p.qualified !== false && (p.finalSimScore == null || p.finalSimScore >= 8) && (p.hitterFinalSimScore == null || p.hitterFinalSimScore >= 8))); setTonightMeta({ qualifyingCount: data.qualifyingCount, preFilteredCount: data.preFilteredCount }); setTonightLoading(false); })
      .catch(() => { if (cancelled) return; setAllTonightPlays([]); setNbaDropped([]); setTonightPlays([]); setTonightLoading(false); });
    return () => { cancelled = true; };
  }, [testMode]);

  const bustCache = () => {
    if (bustLoading) return;
    try { sessionStorage.removeItem(`tonight_v1_${new Date().toLocaleDateString('en-CA')}`); } catch {}
    setBustLoading(true);
    setTonightLoading(true);
    fetch(`${WORKER}/tonight?bust=1`)
      .then(r => r.json())
      .then(data => { const all = data.plays || []; setAllTonightPlays(all); setNbaDropped(data.nbaDropped || []); setTonightPlays(all.filter(p => p.qualified !== false && (p.finalSimScore == null || p.finalSimScore >= 8) && (p.hitterFinalSimScore == null || p.hitterFinalSimScore >= 8))); setTonightMeta({ qualifyingCount: data.qualifyingCount, preFilteredCount: data.preFilteredCount }); setTonightLoading(false); setBustLoading(false); })
      .catch(() => { setAllTonightPlays([]); setNbaDropped([]); setTonightPlays([]); setTonightLoading(false); setBustLoading(false); });
  };

  // Always persist tracked plays to localStorage as a backup (server is authoritative when logged in, but localStorage is the fallback)
  React.useEffect(() => {
    localStorage.setItem("scoreboard_tracked_plays", JSON.stringify(trackedPlays));
  }, [trackedPlays, authToken]);

  function setBankroll(val) {
    const n = Math.max(1, parseFloat(val) || 0);
    setBankrollState(n);
    localStorage.setItem("scoreboard_bankroll", String(n));
  }
  function trackPlay(play) {
    const id = play.gameType === "teamTotal"
      ? `teamtotal|${play.sport}|${play.scoringTeam}|${play.oppTeam}|${play.threshold}|${play.gameDate || ""}`
      : play.gameType === "total"
      ? `total|${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
      : `${play.sport || "nba"}|${play.playerName}|${play.stat}|${play.threshold}|${play.gameDate || ""}`;
    const finalOdds = play.americanOdds ?? -110;
    const _calcN = parseInt(calcOdds.trim());
    const calcOverride = !isNaN(_calcN) && calcOdds.trim() !== "-" && calcOdds.trim() !== "+" ? _calcN : null;
    setTrackedPlays(prev => {
      if (prev.find(p => p.id === id)) return prev;
      return [{ ...play, id, trackedAt: Date.now(), result: null,
        units: tierUnits(calcOverride ?? finalOdds),
        americanOdds: finalOdds,
      }, ...prev];
    });
  }
  function untrackPlay(id) {
    setTrackedPlays(prev => prev.filter(p => p.id !== id));
  }
  function setPlayResult(id, result) {
    setTrackedPlays(prev => prev.map(p => {
      if (p.id !== id) return p;
      // Send outcome to feedback loop — updates per-sport/stat calibration in worker
      return { ...p, result };
    }));
  }
  function setPickUnits(id, units) {
    const u = Math.max(0, parseFloat(units) || 0);
    setTrackedPlays(prev => prev.map(p => p.id === id ? { ...p, units: u } : p));
  }
  // P&L helpers (American odds → decimal profit multiplier on stake)
  function oddsToProfit(americanOdds) {
    return americanOdds >= 0 ? americanOdds / 100 : 100 / Math.abs(americanOdds);
  }

  // --- Auth ---
  async function authSubmit(e) {
    e.preventDefault();
    setAuthError(""); setAuthLoading(true);
    const endpoint = authMode === "login" ? "auth/login" : "auth/register";
    try {
      const r = await fetch(`${WORKER}/${endpoint}`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ email: authForm.email.trim(), password: authForm.password }),
      });
      const data = await r.json();
      if (!r.ok) { setAuthError(data.error || "Something went wrong"); return; }
      localStorage.setItem("sb_token", data.token);
      localStorage.setItem("sb_email", data.email);
      setAuthToken(data.token);
      setAuthEmail(data.email);
      setShowAuthModal(false);
      setAuthForm({ email:"", password:"" });
      // On login: load picks from server (server is authoritative)
      // On register: push current local picks to server
      if (authMode === "register") {
        await savePicks(data.token, trackedPlays, bankroll);
      } else {
        const pr = await fetch(`${WORKER}/user/picks`, { headers:{"Authorization":`Bearer ${data.token}`} });
        if (pr.ok) {
          const pd = await pr.json();
          setTrackedPlays(pd.picks || []);
          if (pd.bankroll) setBankrollState(pd.bankroll);
        }
      }
    } catch { setAuthError("Network error"); }
    finally { setAuthLoading(false); }
  }

  async function savePicks(token, picks, roll) {
    if (!token) return;
    try {
      await fetch(`${WORKER}/user/picks`, {
        method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},
        body: JSON.stringify({ picks, bankroll: roll }),
      });
      setSyncStatus("saved");
    } catch { setSyncStatus("error"); }
  }

  function logout() {
    localStorage.removeItem("sb_token");
    localStorage.removeItem("sb_email");
    localStorage.removeItem("scoreboard_tracked_plays");
    localStorage.removeItem("scoreboard_bankroll");
    setAuthToken(null);
    setAuthEmail(null);
    setTrackedPlays([]);
    setBankrollState(1000);
  }

  // Auto-save picks to server whenever they change (debounced 1.5s)
  // Guard: don't save until server picks have been loaded — prevents overwriting with [] on mount
  React.useEffect(() => {
    if (!authToken || !picksLoaded.current) return;
    setSyncStatus("saving");
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => savePicks(authToken, trackedPlays, bankroll), 1500);
    return () => clearTimeout(syncTimer.current);
  }, [trackedPlays, bankroll, authToken]);

  // Load picks from server on mount if token exists
  React.useEffect(() => {
    if (!authToken) return;
    const localBackup = (() => { try { return JSON.parse(localStorage.getItem("scoreboard_tracked_plays") || "[]"); } catch { return []; } })();
    fetch(`${WORKER}/user/picks`, { headers:{"Authorization":`Bearer ${authToken}`} })
      .then(r => {
        if (r.status === 401) {
          // Token expired — clear auth state so user sees the logged-out experience
          localStorage.removeItem("sb_token");
          localStorage.removeItem("sb_email");
          setAuthToken(null);
          setAuthEmail(null);
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then(pd => {
        if (pd) {
          // Use server data if it has picks; otherwise fall back to localStorage backup
          const serverPicks = pd.picks || [];
          const picks = serverPicks.length > 0 ? serverPicks : localBackup;
          setTrackedPlays(picks);
          if (pd.bankroll) setBankrollState(pd.bankroll);
          // If we fell back to local backup, push it up to the server now
          if (serverPicks.length === 0 && localBackup.length > 0) {
            savePicks(authToken, localBackup, null).catch(() => {});
          }
        }
        picksLoaded.current = true; // unblock auto-save now that server picks are loaded
      })
      .catch(() => {
        // Server unreachable — keep localStorage data already loaded in initial state
        picksLoaded.current = true;
      });
  }, []);

  // Client-side team search (instant, no API call)
  const teamSuggestions = React.useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return TEAM_DB.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.short.toLowerCase().includes(q) ||
      t.abbr.toLowerCase() === q ||
      t.abbr.toLowerCase().startsWith(q)
    ).slice(0, 5);
  }, [debouncedQuery]);

  // Show dropdown immediately when team suggestions exist
  React.useEffect(() => {
    if (teamSuggestions.length > 0) setShowDrop(true);
  }, [teamSuggestions]);

  React.useEffect(() => {
    if (debouncedQuery.trim().length < 2) { setSuggestions([]); setShowDrop(false); return; }
    setSearching(true);
    fetch(`${WORKER}/athletes?q=${encodeURIComponent(debouncedQuery)}`)
      .then(r => r.json())
      .then(data => {
        const items = (data.items || []);
        setSuggestions(items);
        setShowDrop(items.length > 0 || teamSuggestions.length > 0);
      })
      .catch(e => { console.error("search error:", e); setSuggestions([]); })
      .finally(() => setSearching(false));
  }, [debouncedQuery]);

  async function fetchReport(sport) {
    if (!sport) return;
    setReportSport(sport);
    setShowReport(true);
    if (reportDataBySport[sport]) return; // already cached
    setReportLoadingSport(sport);
    try {
      const r = await fetch(`${WORKER}/tonight?debug=1&sport=${sport}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setReportDataBySport(prev => ({ ...prev, [sport]: d }));
    } catch(e) {
      setReportDataBySport(prev => ({ ...prev, [sport]: { error: e.message } }));
    }
    setReportLoadingSport(null);
  }

  async function fetchCalib() {
    setCalibLoading(true);
    setCalibData(null);
    try {
      const r = await fetch(`${WORKER}/auth/calibration`, { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setCalibData(await r.json());
    } catch(e) {
      setCalibData({ error: e.message });
    }
    setCalibLoading(false);
  }

  async function loadPlayer(p, activeSport) {
    const sp = activeSport || sport;
    setPlayer(p); setLogs(null); setLogs25(null); setPerGame([]); setDvpData(null); setError(null); setLoading(true); setShowBreakdown(false);
    const id = Date.now(); fetchRef.current = id;
    try {
      const teamParam = p.team ? `&team=${encodeURIComponent(p.team)}` : "";
      if (sp === "baseball/mlb") {
        // Fetch 3 seasons in parallel for full h2h history, plus dvp for tonight's matchup
        const [d26, d25, d24, dv] = await Promise.all([
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${p.id}&season=2026`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${p.id}&season=2025`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${p.id}&season=2024`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${WORKER}/dvp?sport=${sp}&athleteId=${p.id}${teamParam}`),
        ]);
        if (fetchRef.current !== id) return;
        // Merged gamelog for perGame (h2h filtering needs all career data)
        const base = d26 || d25 || d24;
        const mergedEvents = [
          ...(d26?.events || []).map(ev => ({ ...ev, season: 2026 })),
          ...(d25?.events || []).map(ev => ({ ...ev, season: 2025 })),
          ...(d24?.events || []).map(ev => ({ ...ev, season: 2024 })),
        ];
        const mergedData = base ? { labels: base.labels, events: mergedEvents, totalGames: mergedEvents.length } : { labels: [], events: [], totalGames: 0 };
        const { perGame: pg, isPitcher: isP } = parseGameLog(mergedData, sp);
        // Season-specific aggregates for truePct (2026 = main bar, 2025 = secondary)
        const { aggregated: agg26 } = d26 ? parseGameLog(d26, sp) : { aggregated: null };
        const { aggregated: agg25 } = d25 ? parseGameLog(d25, sp) : { aggregated: null };
        // Blend 2025+2026 events as primary season rate; individual years as breakdown bars
        const blendEvents = [...(d25?.events || []), ...(d26?.events || [])];
        const blendBase = d25 || d26;
        const { aggregated: aggBlend } = blendBase && blendEvents.length > 0
          ? parseGameLog({ labels: blendBase.labels, events: blendEvents }, sp)
          : { aggregated: null };
        const has2026 = agg26 && Object.values(agg26).some(arr => Array.isArray(arr) && arr.length >= 5);
        setLogs(has2026 ? agg26 : (aggBlend || agg25 || agg26));
        setLogs25(has2026 ? aggBlend : agg26);
        setPerGame(pg);
        setMlbIsPitcher(isP);
        if (dv.ok) {
          const dvJson = await dv.json();
          if (fetchRef.current !== id) return;
          setDvpData(dvJson);
        }
      } else {
        const season = sp === "football/nfl" ? "2025" : "2026";
        const [gameRes, dv] = await Promise.all([
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${p.id}&season=${season}`),
          fetch(`${WORKER}/dvp?sport=${sp}&athleteId=${p.id}${teamParam}`),
        ]);
        if (fetchRef.current !== id) return;
        if (!gameRes.ok) throw new Error('Could not load game log');
        const data = await gameRes.json();
        const { aggregated, perGame: pg } = parseGameLog(data, sp);
        setLogs(aggregated);
        setPerGame(pg);
        if (dv.ok) {
          const dvJson = await dv.json();
          if (fetchRef.current !== id) return;
          setDvpData(dvJson);
        }
      }
    } catch(e) {
      if (fetchRef.current !== id) return;
      setError("Could not load game log: " + e.message);
    }
    setLoading(false);
  }

  function parseGameLog(data, sport) {
    const result = {};
    const statConfigs = STAT_CONFIGS[sport] || {};
    Object.keys(statConfigs).forEach(k => result[k] = []);

    const labels = data.labels || [];
    const events = data.events || [];
    const ul = labels.map(l => (l || "").toUpperCase());

    // Helper: get numeric value at first occurrence of a label
    const byLabel = (stats, lbl) => {
      const i = ul.indexOf(lbl);
      if (i === -1) return undefined;
      const v = parseFloat(stats[i]);
      return isNaN(v) ? undefined : v;
    };

    // NFL: YDS appears multiple times — pre-compute indices by context
    const nflCols = {};
    if (sport === "football/nfl") {
      ul.forEach((lbl, i) => {
        const prev = i > 0 ? ul[i - 1] : "";
        if (lbl === "CMP")                       nflCols.cmp     = i;
        if (lbl === "ATT")                       nflCols.att     = i;
        if (lbl === "YDS" && prev === "ATT")     nflCols.passYds = i;
        if (lbl === "YDS" && prev === "CAR")     nflCols.rushYds = i;
        if (lbl === "REC")                       nflCols.rec     = i;
        if (lbl === "TGTS")                      nflCols.tgts    = i;
        if (lbl === "YDS" && prev === "TGTS")    nflCols.recYds  = i;
      });
    }

    // MLB: pitcher vs hitter determined by presence of IP column
    const isPitcher = sport === "baseball/mlb" && ul.includes("IP");
    if (isPitcher) { result.bb = []; result.ip = []; result.hitsAllowed = []; }

    const perGame = [];

    events.forEach(ev => {
      const stats = ev.stats || [];
      const col = key => {
        const i = nflCols[key];
        if (i === undefined) return undefined;
        const v = parseFloat(stats[i]);
        return isNaN(v) ? undefined : v;
      };
      const lv = lbl => byLabel(stats, lbl);
      const gs = {}; // per-game stats for DvP

      if (sport === "basketball/nba") {
        const pts = lv("PTS"), reb = lv("REB"), ast = lv("AST");
        if (pts !== undefined) { result.points?.push(pts); gs.points = pts; }
        if (reb !== undefined) { result.rebounds?.push(reb); gs.rebounds = reb; }
        if (ast !== undefined) { result.assists?.push(ast); gs.assists = ast; }

        const tpm = lv("3PT");
        if (tpm !== undefined) { result.threePointers?.push(tpm); gs.threePointers = tpm; }
        const min = lv("MIN");
        if (min !== undefined) { gs.min = min; }
      }

      if (sport === "football/nfl") {
        if (col("passYds") !== undefined) { result.passingYards?.push(col("passYds")); gs.passingYards = col("passYds"); }
        if (col("cmp")     !== undefined) { result.completions?.push(col("cmp")); gs.completions = col("cmp"); }
        if (col("att")     !== undefined) { result.attempts?.push(col("att")); gs.attempts = col("att"); }
        if (col("rushYds") !== undefined) { result.rushingYards?.push(col("rushYds")); gs.rushingYards = col("rushYds"); }
        if (col("recYds")  !== undefined) { result.receivingYards?.push(col("recYds")); gs.receivingYards = col("recYds"); }
        if (col("rec")     !== undefined) { result.receptions?.push(col("rec")); gs.receptions = col("rec"); }
      }

      if (sport === "baseball/mlb") {
        if (isPitcher) {
          const k = lv("K");
          const bb = lv("BB");
          const ip = lv("IP");
          const ha = lv("H"); // hits allowed
          const er = lv("ER");
          const pc = lv("P"); // ESPN uses "P" for pitch count (not "PC")
          if (k  !== undefined) { result.strikeouts?.push(k);  gs.strikeouts = k; }
          if (bb !== undefined) { result.bb?.push(bb); gs.bb = bb; }
          if (ip !== undefined) { result.ip?.push(ip); gs.ip = ip; }
          if (ha !== undefined) { result.hitsAllowed?.push(ha); gs.hitsAllowed = ha; }
          if (er !== undefined) { gs.er = er; }
          if (pc !== undefined) { gs.pc = pc; }
        } else {
          const h = lv("H"), hr = lv("HR"), rbi = lv("RBI"), r = lv("R"), b2 = lv("2B"), b3 = lv("3B");
          const ab = lv("AB"), bb = lv("BB");
          if (h   !== undefined) { result.hits?.push(h); gs.hits = h; }
          if (hr  !== undefined) { gs.homeRuns = hr; }
          if (ab  !== undefined) { gs.ab = ab; }
          if (r   !== undefined) { gs.r = r; }
          if (rbi !== undefined) { gs.rbi = rbi; }
          if (bb  !== undefined) { gs.bb = bb; }
          // H+R+RBI combined stat
          if (h !== undefined && r !== undefined && rbi !== undefined) {
            const hrr = h + r + rbi; result.hrr?.push(hrr); gs.hrr = hrr;
          }
          // Total bases: H + 2B + 2*3B + 3*HR
          if (h !== undefined && hr !== undefined && b2 !== undefined && b3 !== undefined) {
            const tb = h + b2 + 2*b3 + 3*hr;
            result.totalBases?.push(tb); gs.totalBases = tb;
          }
        }
      }

      if (sport === "hockey/nhl") {
        const sog = lv("SOG") ?? lv("S"), pts = lv("PTS"), sv = lv("SV");
        const g = lv("G"), a = lv("A");
        const toiIdx = ul.indexOf("TOI");
        const toi = toiIdx !== -1 && stats[toiIdx] != null ? stats[toiIdx] : undefined; // raw string — parseFloat("18:32") would truncate to 18
        if (sog !== undefined) { result.shotsOnGoal?.push(sog); gs.shotsOnGoal = sog; }
        if (pts !== undefined) { result.points?.push(pts); gs.points = pts; }
        if (sv  !== undefined) { result.saves?.push(sv); gs.saves = sv; }
        if (g   !== undefined) { gs.g = g; }
        if (a   !== undefined) { gs.a = a; }
        if (toi !== undefined) { gs.toi = toi; }
      }

      // Derive season from date (ev.season is never set by the API)
      const evDate = ev.date || null;
      const evSeason = evDate ? parseInt(evDate.slice(0, 4)) : null;
      perGame.push({ oppId: ev.oppId || null, oppAbbr: ev.oppAbbr || null,
        date: evDate, isHome: ev.isHome ?? null, season: evSeason, ...gs });
    });

    return { aggregated: result, perGame, isPitcher };
  }

  const selectPlayer = (p, tab = null) => {
    const newSport = p.sportKey || sport;
    setSport(newSport);
    setTeamPage(null);
    setActiveTab(tab || Object.keys(STAT_CONFIGS[newSport] || {})[0] || "points");
    setQuery(""); setSuggestions([]); setShowDrop(false); setActiveIdx(-1);
    loadPlayer(p, newSport);
  };

  // Navigate to player card from a play/pick object — looks up ID by name if missing
  const navigateToPlay = async (play) => {
    if (play.gameType === "total" || play.gameType === "teamTotal") return; // totals don't have a player card
    const sportFull = SPORT_KEY[play.sport] || play.sportKey || "basketball/nba";
    let pid = play.playerId;
    if (!pid) {
      try {
        const r = await fetch(`${WORKER}/athletes?q=${encodeURIComponent(play.playerName)}`);
        const d = await r.json();
        const items = d.items || [];
        const m = items.find(a => a.name.toLowerCase() === play.playerName.toLowerCase()) || items[0];
        if (m) pid = m.id;
      } catch(e) {}
    }
    selectPlayer({ id: pid, name: play.playerName, team: play.playerTeam, sportKey: sportFull,
      opponent: play.opponent, oppRank: play.oppRank, oppMetricValue: play.oppMetricValue,
      oppMetricLabel: play.oppMetricLabel, oppMetricUnit: play.oppMetricUnit,
      playIsStrong: play.playIsStrong, projectedStat: play.projectedStat,
      recentAvg: play.recentAvg, dvpFactor: play.dvpFactor,
      playSoftPct: play.softPct, playSoftGames: play.softGames,
      playSport: play.sport, playThreshold: play.threshold, playStat: play.stat }, play.stat);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleKeyDown = e => {
    if (!showDrop) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i+1, suggestions.length-1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i-1, 0)); }
    else if (e.key === "Enter" && activeIdx >= 0) selectPlayer(suggestions[activeIdx]);
    else if (e.key === "Escape") setShowDrop(false);
  };

  const highlight = (name, q) => {
    const i = name.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return <span>{name}</span>;
    return (
      <span>
        {name.slice(0, i)}
        <strong style={{color:"#fff"}}>{name.slice(i, i + q.length)}</strong>
        {name.slice(i + q.length)}
      </span>
    );
  };

  const allStatCfgs = STAT_CONFIGS[sport] || {};
  // For MLB, only show tabs relevant to the player's role once we know pitcher/hitter
  const statCfgs = (() => {
    if (sport !== "baseball/mlb" || mlbIsPitcher === null) return allStatCfgs;
    const pitcherTabs = ["strikeouts"];
    const hitterTabs  = ["hrr"];
    const allowed = mlbIsPitcher ? pitcherTabs : hitterTabs;
    return Object.fromEntries(Object.entries(allStatCfgs).filter(([k]) => allowed.includes(k)));
  })();
  const tabs = Object.keys(statCfgs);
  const safeTab = tabs.includes(activeTab) ? activeTab : tabs[0];
  const cfg = statCfgs[safeTab];
  const activeLogs = logs?.[safeTab] ?? [];
  const totalGames = activeLogs.length;
  const avg = totalGames > 0 ? (activeLogs.reduce((a,b)=>a+b,0)/totalGames).toFixed(1) : "—";
  const hi  = totalGames > 0 ? Math.max(...activeLogs) : "—";
  const rates = (cfg?.thresholds || []).map(t => {
    const count = activeLogs.filter(v => v >= t).length;
    return { t, count, pct: totalGames > 0 ? (count/totalGames)*100 : 0 };
  });
  // MLB 2025 season rates (secondary bar for truePct blending)
  const isMLB = sport === "baseball/mlb";
  const activeLogs25 = isMLB ? (logs25?.[safeTab] ?? []) : [];
  const totalGames25 = activeLogs25.length;
  const rates25Map = isMLB ? Object.fromEntries((cfg?.thresholds || []).map(t => {
    const count = activeLogs25.filter(v => v >= t).length;
    return [t, totalGames25 > 0 ? (count / totalGames25) * 100 : null];
  })) : {};

  // Fetch Kalshi odds — placed here so safeTab is already defined
  React.useEffect(() => {
    const KALSHI_STATS = {
      "basketball/nba": { points:"points", rebounds:"rebounds", assists:"assists", threePointers:"threePointers" },
      "hockey/nhl":     { points:"points" },
      "baseball/mlb":   { hits:"hits", hrr:"hrr", strikeouts:"strikeouts" },
    };
    const kalshiStat = KALSHI_STATS[sport]?.[safeTab];
    if (!player || !kalshiStat) { setKalshiOdds({}); return; }
    const cacheKey = `${player.name}|${sport.split("/")[1]}|${kalshiStat}`;
    if (kalshiCache.current[cacheKey]) { setKalshiOdds(kalshiCache.current[cacheKey]); return; }
    const sportSlug = sport.split("/")[1];
    fetch(`${WORKER}/kalshi?playerName=${encodeURIComponent(player.name)}&stat=${kalshiStat}&sport=${sportSlug}`)
      .then(r => r.json())
      .then(data => {
        const map = {};
        (data.markets || []).forEach(m => { map[m.threshold] = m; });
        kalshiCache.current[cacheKey] = map;
        setKalshiOdds(map);
      })
      .catch(() => setKalshiOdds({}));
  }, [player, safeTab, sport]);

  return (
    <div style={{maxWidth:1280,margin:"0 auto",padding:"24px 16px"}}>

      {/* Market Report overlay */}
      {showReport && (() => {
        const reportData = reportDataBySport[reportSport] || null;
        const reportLoading = reportLoadingSport === reportSport;
        return (
        <div style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.88)",overflow:"auto",padding:"20px 16px"}}
          onClick={e => { if (e.target === e.currentTarget) setShowReport(false); }}>
          <div style={{maxWidth:1280,margin:"0 auto",background:"#161b22",borderRadius:12,border:"1px solid #30363d",minHeight:200}}>
            {/* Header */}
            <div style={{display:"flex",alignItems:"center",padding:"14px 20px",borderBottom:"1px solid #30363d"}}>
              <div style={{color:"#c9d1d9",fontWeight:700,fontSize:15}}>Market Report</div>
              {reportData && !reportLoading && (
                <div style={{marginLeft:12,fontSize:11,color:"#8b949e"}}>
                  {(reportData.plays||[]).length} plays · {(reportData.dropped||[]).length} filtered
                </div>
              )}
              <button onClick={() => setShowReport(false)}
                style={{marginLeft:"auto",background:"none",border:"none",color:"#8b949e",fontSize:20,cursor:"pointer",lineHeight:1,padding:"0 2px"}}>✕</button>
            </div>
            {/* Sport tabs */}
            <div style={{display:"flex",gap:2,padding:"10px 20px 0",borderBottom:"1px solid #21262d"}}>
              {["mlb","nba","nhl"].map(s => (
                <button key={s} onClick={() => { setReportSport(s); if (!reportDataBySport[s]) fetchReport(s); }} style={{
                  padding:"5px 14px",borderRadius:"6px 6px 0 0",border:"none",cursor:"pointer",fontSize:12,
                  background: reportSport===s ? "#0d1117" : "transparent",
                  color: reportSport===s ? "#c9d1d9" : "#484f58",
                  fontWeight: reportSport===s ? 700 : 400}}>
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
            {/* Body */}
            <div style={{padding:"16px 20px"}}>
              {/* Market report */}
              {reportLoading && <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>Loading market data…</div>}
              {reportData?.error && <div style={{color:"#f78166",textAlign:"center",padding:40,fontSize:13}}>Error: {reportData.error}</div>}
              {!reportData && !reportLoading && <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>No data loaded.</div>}
              {reportData && !reportLoading && (() => {
                const REASON = {
                  edge_too_low: "Edge < 5%",
                  kalshi_pct_too_low: "Implied < 70%",
                  opp_not_soft: "Soft matchup not met",
                  low_confidence: "Sim-Score < 7",
                  team_not_favored: "Team not favored",
                  pitcher_era_too_low: "ERA < 4.0",
                  no_h2h_data: "No career AB vs team",
                  insufficient_ab_vs_pitcher: "< 10 AB vs pitcher",
                  low_batting_avg: "BA < .270",
                  no_opp: "Team not resolved",
                  no_espn_info: "No player data",
                  no_gamelog: "No game log",
                  no_soft_data: "No stat data",
                };
                const STAT_NAME = { points:"Points",rebounds:"Rebounds",assists:"Assists",threePointers:"3-Pointers",goals:"Goals",hits:"Hits",hrr:"H+R+RBI",strikeouts:"Strikeouts",totalRuns:"Totals",totalPoints:"Totals",totalGoals:"Totals",teamRuns:"Team Runs",teamPoints:"Team Points" };
                const SPORT_COL = { mlb:"#4ade80", nba:"#f97316", nhl:"#60a5fa" };
                const SPORT_ORD = { mlb:0, nba:1, nhl:2, nfl:3 };

                const plays = (reportData.plays || []).map(p => ({ ...p, qualified: p.qualified !== false }));
                const dropped = (reportData.dropped || []).map(p => ({ ...p, qualified: false }));
                const filtered = [...plays, ...dropped];

                // Group by sport+stat
                const groups = {};
                for (const m of filtered) {
                  const key = `${m.sport}|${m.stat}`;
                  if (!groups[key]) groups[key] = { sport: m.sport, stat: m.stat, items: [] };
                  groups[key].items.push(m);
                }
                const sortedGroups = Object.values(groups).sort((a, b) => {
                  const sd = (SPORT_ORD[a.sport]??9) - (SPORT_ORD[b.sport]??9);
                  return sd !== 0 ? sd : a.stat.localeCompare(b.stat);
                });

                if (sortedGroups.length === 0) return <div style={{color:"#8b949e",textAlign:"center",padding:40,fontSize:13}}>No markets.</div>;

                const CRITERIA_SUMMARIES = {
                  "mlb|hrr":       { note: "True% = Monte Carlo simulation (batterBA \u00d7 pitcherBAA log5) \u00b7 park-adjusted \u00b7 Sim-Score \u2265 8 (Quality\u21920-2, WHIP\u21920-2, Ssn HR%\u21920-2, H2H HR%\u21920-2, O/U\u21920-2) = max 10; edge gates separately", gates: ["Lineup spot 1\u20134", "Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "mlb|hits":      { note: "True% = Monte Carlo simulation (batterBA \u00d7 pitcherBAA log5) \u00b7 park-adjusted \u00b7 Sim-Score \u2265 8 (Quality\u21920-2, WHIP\u21920-2, Ssn HR%\u21920-2, H2H HR%\u21920-2, O/U\u21920-2) = max 10; edge gates separately", gates: ["Lineup spot 1\u20134", "Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "mlb|strikeouts":{ note: "True% = Monte Carlo simulation (pitcher K% \u00d7 lineup K% log5) \u00b7 regressed to mean \u00b7 park-adjusted \u00b7 Sim-Score \u2265 8 (CSW%\u21920-2, K-BB%\u21920-2, Lineup K%\u21920-2, Hit Rate\u21920-2, O/U\u21920-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "nba|points":    { note: "True% = Monte Carlo simulation \u00b7 B2B \u00d70.93 \u00b7 Sim-Score: C1 USG%(0-2) + DVP(0-2) + Ssn HR%(0-2) + Soft HR%(0-2) + Pace+O/U(0-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "nba|rebounds":  { note: "True% = Monte Carlo simulation \u00b7 B2B \u00d70.93 \u00b7 Sim-Score: C1 AvgMin(0-2) + DVP(0-2) + Ssn HR%(0-2) + Soft HR%(0-2) + Pace+O/U(0-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "nba|assists":   { note: "True% = Monte Carlo simulation \u00b7 B2B \u00d70.93 \u00b7 Sim-Score: C1 USG%(0-2) + DVP(0-2) + Ssn HR%(0-2) + Soft HR%(0-2) + Pace+O/U(0-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                  "nba|threePointers": { note: "True% = Monte Carlo simulation \u00b7 B2B \u00d70.93 \u00b7 Sim-Score: C1 USG%(0-2) + DVP(0-2) + Ssn HR%(0-2) + Soft HR%(0-2) + Pace+O/U(0-2) = max 10; edge gates separately", gates: ["Sim-Score \u2265 8 (max 10)", "Edge \u2265 5%"] },
                };

                return sortedGroups.map(({ sport, stat, items }) => {
                  // Dedupe by playerName|threshold (or homeTeam|awayTeam|threshold for totals), prefer qualified
                  const dedupeMap = {};
                  for (const m of items) {
                    const k = m.gameType === "teamTotal"
                      ? `${m.scoringTeam}|${m.oppTeam}|${m.threshold}`
                      : m.gameType === "total"
                      ? `${m.homeTeam}|${m.awayTeam}|${m.threshold}${m.direction === "under" ? "|under" : ""}`
                      : `${m.playerName}|${m.threshold}`;
                    if (!dedupeMap[k] || (!dedupeMap[k].qualified && m.qualified)) dedupeMap[k] = m;
                  }
                  const _sortCfg = reportSort[`${sport}|${stat}`];
                  const rows = Object.values(dedupeMap).sort((a, b) => {
                    if (_sortCfg) {
                      const _sv = m => { switch(_sortCfg.col) {
                        case "player": return m.playerName ?? `${m.awayTeam}${m.homeTeam}` ?? "";
                        case "line": return m.threshold ?? 0;
                        case "true": return m.truePct ?? 0;
                        case "kalshi": return m.kalshiPct ?? 0;
                        case "edge": return m.edge ?? 0;
                        case "opp": return m.opponent ?? "";
                        case "season": return m.seasonPct ?? 0;
                        case "h2h": return m.softPct ?? 0;
                        case "era": return m.hitterPitcherEra ?? m.pitcherEra ?? 999;
                        case "ba": return m.hitterBa ?? 0;
                        case "ml": return m.hitterMoneyline ?? m.gameMoneyline ?? 0;
                        case "ab": return m.hitterAbVsPitcher ?? 0;
                        case "csw": return m.pitcherCSWPct ?? m.pitcherKPct ?? 0;
                        case "pkp": return m.pitcherKPct ?? 0;
                        case "kbb": return m.pitcherKBBPct ?? 0;
                        case "pps": return m.pitcherAvgPitches ?? 0;
                        case "lkp": return m.lineupKPct ?? 0;
                        case "spot": return m.hitterLineupSpot ?? 99;
                        case "whip": return m.pitcherWHIP ?? 0;
                        case "plat": return m.hitterSplitBA ?? 0;
                        case "fip": return m.pitcherFIP ?? 0;
                        case "ou": return m.gameTotal ?? 0;
                        case "dvp": return m.posDvpRank ?? 99;
                        case "sim": return m.teamTotalSimScore ?? m.totalSimScore ?? m.finalSimScore ?? m.hitterFinalSimScore ?? m.nbaSimScore ?? 0;
                        case "env": return m.parkFactor ?? m.hitterParkKF ?? 1;
                        case "brrl": return m.hitterBarrelPct ?? 0;
                        case "nbapace": return m.nbaPaceAdj ?? -99;
                        case "nbaopp": return m.nbaOpportunity ?? 0;
                        case "nba_b2b": return m.isB2B ? 0 : 1;
                        case "nbaC1": return m.stat==="rebounds" ? (m.nbaOpportunity??0) : (m.nbaUsage??0);
                        case "nbaOu": return m.nbaGameTotal ?? 0;
                        case "nbaSeasonHR": return m.seasonPct ?? -1;
                        case "nbaSoftHR": return m.softPct ?? -1;
                        case "nbaPaceTotal": return m.nbaTotalPts ?? 1;
                        case "nba_spread": return m.nbaBlowoutAdj ?? 0;
                        case "mlbOu": return m.gameOuLine ?? m.hitterGameTotal ?? 0;
                        case "ktrend": return m.kTrendPts ?? 0;
                        case "kHitRate": return m.blendedHitRate ?? 0;
                        case "hQuality": return m.hitterBatterQualityPts ?? 0;
                        case "hSsnHR": return m.seasonPct ?? 0;
                        case "hH2HHR": return m.softPct ?? 0;
                        case "ttH2HHR": return m.h2hHitRate ?? 0;
                        case "ttTeamRPG": return m.teamRPG ?? 0;
                        case "ttOppERA": return m.oppERA ?? 999;
                        case "ttOppRPG": return m.oppRPG ?? 0;
                        case "ttPark": return m.parkFactor ?? 1;
                        case "ttOu": return m.gameOuLine ?? 0;
                        case "ttTeamOff": return m.teamOff ?? 0;
                        case "ttOppDef": return m.oppDef ?? 0;
                        case "ttPace": return (m.teamPace??0) - (m.leagueAvgPace??0);
                        case "ttSpread": return Math.abs(m.gameSpread ?? 99);
                        case "nhlSeasonHR": return m.seasonPct ?? 0;
                        case "nhlDvpHR": return m.softPct ?? 0;
                        case "nhlGameTotalOu": return m.nhlGameTotal ?? 0;
                        case "homeRPG": case "awayRPG": case "homeERA": case "awayERA":
                        case "homeOff": case "awayOff": case "homeDef": case "awayDef":
                        case "homeGPG": case "awayGPG": case "homeGAA": case "awayGAA": return m[_sortCfg.col] ?? 0;
                        default: return 0;
                      }};
                      const va = _sv(a), vb = _sv(b);
                      const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
                      return _sortCfg.dir === "desc" ? -cmp : cmp;
                    }
                    if ((a.qualified !== false) !== (b.qualified !== false)) return (a.qualified !== false) ? -1 : 1;
                    const sa = a.totalSimScore ?? a.finalSimScore ?? a.hitterFinalSimScore ?? a.nbaSimScore ?? a.nhlSimScore ?? a.simScore ?? a.hitterSimScore ?? 0;
                    const sb = b.totalSimScore ?? b.finalSimScore ?? b.hitterFinalSimScore ?? b.nbaSimScore ?? b.nhlSimScore ?? b.simScore ?? b.hitterSimScore ?? 0;
                    if (sb !== sa) return sb - sa;
                    return (b.edge || b.kalshiPct || 0) - (a.edge || a.kalshiPct || 0);
                  }).filter(r => stat !== "hrr" || r.threshold === 1);
                  const qualCount = rows.filter(r => r.qualified).length;

                  const cs = CRITERIA_SUMMARIES[`${sport}|${stat}`];
                  return (
                    <div key={`${sport}|${stat}`} style={{marginBottom:18}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,paddingBottom:5,borderBottom:"1px solid #21262d",flexWrap:"wrap"}}>
                        <span style={{color:SPORT_COL[sport]||"#8b949e",fontWeight:700,fontSize:11}}>{sport.toUpperCase()}</span>
                        <span style={{color:"#8b949e",fontSize:12,marginRight:2}}>{STAT_NAME[stat]||stat}</span>
                        <span style={{color:"#484f58",fontSize:11,marginLeft:"auto"}}>{rows.length} markets · <span style={{color:"#3fb950"}}>{qualCount}</span> play{qualCount!==1?"s":""}</span>
                      </div>
                      {(() => {
                        // Sport+stat specific extra columns
                        const XCOLS = {
                          "mlb|hrr":        [{k:"sim",l:"Score"},{k:"hQuality",l:"Quality"},{k:"whip",l:"WHIP"},{k:"hSsnHR",l:"Ssn HR%"},{k:"hH2HHR",l:"H2H HR%"},{k:"mlbOu",l:"O/U"}],
                          "mlb|hits":       [{k:"sim",l:"Score"},{k:"hQuality",l:"Quality"},{k:"whip",l:"WHIP"},{k:"hSsnHR",l:"Ssn HR%"},{k:"hH2HHR",l:"H2H HR%"},{k:"mlbOu",l:"O/U"}],
                          "mlb|strikeouts": [{k:"sim",l:"Score"},{k:"csw",l:"CSW%"},{k:"kbb",l:"K-BB%"},{k:"lkp",l:"Lineup K%"},{k:"kHitRate",l:"Hit Rate"},{k:"ou",l:"O/U"}],
                          "nba|points":     [{k:"sim",l:"Score"},{k:"nbaC1",l:"Usage"},{k:"dvp",l:"DVP"},{k:"nbaSeasonHR",l:"Ssn HR%"},{k:"nbaSoftHR",l:"Soft HR%"},{k:"nbaPaceTotal",l:"Pace+O/U"}],
                          "nba|rebounds":   [{k:"sim",l:"Score"},{k:"nbaC1",l:"AvgMin"},{k:"dvp",l:"DVP"},{k:"nbaSeasonHR",l:"Ssn HR%"},{k:"nbaSoftHR",l:"Soft HR%"},{k:"nbaPaceTotal",l:"Pace+O/U"}],
                          "nba|assists":    [{k:"sim",l:"Score"},{k:"nbaC1",l:"Usage"},{k:"dvp",l:"DVP"},{k:"nbaSeasonHR",l:"Ssn HR%"},{k:"nbaSoftHR",l:"Soft HR%"},{k:"nbaPaceTotal",l:"Pace+O/U"}],
                          "nba|threePointers":[{k:"sim",l:"Score"},{k:"nbaC1",l:"Usage"},{k:"dvp",l:"DVP"},{k:"nbaSeasonHR",l:"Ssn HR%"},{k:"nbaSoftHR",l:"Soft HR%"},{k:"nbaPaceTotal",l:"Pace+O/U"}],
                          "nhl|points": [{k:"sim",l:"Score"},{k:"nhltoi",l:"AvgTOI"},{k:"nhlgaa",l:"GAA Rank"},{k:"nhlSeasonHR",l:"Ssn HR%"},{k:"nhlDvpHR",l:"DVP HR%"},{k:"nhlGameTotalOu",l:"O/U"}],
                          "mlb|totalRuns":    [{k:"sim",l:"Score"},{k:"homeRPG",l:"H RPG"},{k:"awayRPG",l:"A RPG"},{k:"homeERA",l:"H ERA"},{k:"awayERA",l:"A ERA"},{k:"mlbOu",l:"O/U"}],
                          "nba|totalPoints":  [{k:"sim",l:"Score"},{k:"homeOff",l:"H PPG"},{k:"awayOff",l:"A PPG"},{k:"homeDef",l:"H Def"},{k:"awayDef",l:"A Def"},{k:"totalOu",l:"O/U"}],
                          "nhl|totalGoals":   [{k:"sim",l:"Score"},{k:"homeGPG",l:"H GPG"},{k:"awayGPG",l:"A GPG"},{k:"homeGAA",l:"H GAA"},{k:"awayGAA",l:"A GAA"},{k:"totalOu",l:"O/U"}],
                          "mlb|teamRuns":     [{k:"sim",l:"Score"},{k:"ttTeamRPG",l:"Team RPG"},{k:"ttOppERA",l:"Opp ERA"},{k:"ttH2HHR",l:"H2H HR%"},{k:"ttPark",l:"Park"},{k:"ttOu",l:"O/U"},{k:"ttOpp",l:"Opp"}],
                          "nba|teamPoints":   [{k:"sim",l:"Score"},{k:"ttTeamOff",l:"Team PPG"},{k:"ttOppDef",l:"Opp Def"},{k:"ttOu",l:"O/U"},{k:"ttPace",l:"Pace"},{k:"ttH2HHR",l:"H2H HR%"},{k:"ttOpp",l:"Opp"}],
                        };
                        const xcols = XCOLS[`${sport}|${stat}`] || [];
                        const DASH = <span style={{color:"#21262d"}}>—</span>;
                        const xcell = (m, k) => {
                          const C = (v, col) => v != null ? <span style={{color:col}}>{v}</span> : DASH;
                          const era = m.hitterPitcherEra ?? m.pitcherEra ?? m.era;
                          const ml  = m.hitterMoneyline ?? m.gameMoneyline ?? m.moneyline ?? m.gameOdds?.moneyline;
                          const ab  = m.hitterAbVsPitcher ?? m.abVsTeam;
                          const pkp = m.pitcherKPct;
                          const lkp = m.lineupKPct;
                          const ou  = m.gameTotal ?? m.gameOdds?.total;
                          const fML = v => v > 0 ? `+${v}` : `${v}`;
                          if (k==="season") { const v = m.seasonPct; return C(v != null ? v.toFixed(1)+"%" : null, v >= 60 ? "#3fb950" : v >= 50 ? "#e3b341" : "#f78166"); }
                          if (k==="h2h") { const v = m.softPct; return v != null ? <span style={{color:v>=60?"#3fb950":v>=50?"#e3b341":"#f78166"}}>{v.toFixed(1)+"%"}</span> : DASH; }
                          if (k==="era") { const eraColor = stat === "strikeouts" ? (era < 3.5 ? "#3fb950" : era < 4.5 ? "#8b949e" : "#f78166") : (era >= 4.0 ? "#8b949e" : "#f78166"); return C(era != null ? parseFloat(era).toFixed(2) : null, eraColor); }
                          if (k==="ml")  return C(ml  != null ? fML(ml) : null, ml <= -121 ? "#3fb950" : ml <= 120 ? "#e3b341" : "#f78166");
                          if (k==="ktrend") { const v = m.pitcherRecentKPct; const pts = m.kTrendPts; return C(v != null ? v.toFixed(1)+"%" : null, pts === 2 ? "#3fb950" : pts === 1 ? "#e3b341" : "#f78166"); }
                          if (k==="kHitRate") { const v=m.blendedHitRate; const pts=m.blendedHitRatePts; return v!=null ? <span style={{color:pts===2?"#3fb950":pts===1?"#e3b341":"#f78166"}}>{v.toFixed(1)+"%"}</span> : DASH; }
                          if (k==="ab")  return C(ab  != null ? String(ab) : null, ab >= 10 ? "#8b949e" : "#f78166");
                          if (k==="csw") { const csw = m.pitcherCSWPct ?? m.pitcherKPct; const isReal = m.pitcherCSWPct != null; return C(csw != null ? csw.toFixed(1)+"%" : null, isReal ? (csw >= 30 ? "#3fb950" : csw > 26 ? "#e3b341" : "#f78166") : (csw >= 27 ? "#3fb950" : csw >= 24 ? "#e3b341" : "#f78166")); }
                          if (k==="pkp") return C(pkp != null ? pkp.toFixed(1)+"%" : null, pkp > 24 ? "#3fb950" : pkp > 20 ? "#e3b341" : "#f78166");
                          if (k==="kbb") { const kbb = m.pitcherKBBPct; return C(kbb != null ? kbb.toFixed(1)+"%" : null, kbb > 18 ? "#3fb950" : kbb > 12 ? "#e3b341" : "#f78166"); }
                          if (k==="pps") { const pps = m.pitcherAvgPitches; return C(pps != null ? pps.toFixed(0) : null, pps > 85 ? "#3fb950" : pps > 75 ? "#e3b341" : "#f78166"); }
                          if (k==="lkp") return C(lkp != null ? lkp.toFixed(1)+"%" : null, lkp > 24 ? "#3fb950" : lkp > 22 ? "#e3b341" : "#f78166");
                          if (k==="spot") { const sp = m.hitterLineupSpot; return C(sp != null ? `#${sp}` : null, sp <= 3 ? "#3fb950" : sp <= 4 ? "#e3b341" : "#f78166"); }
                          if (k==="whip") { const w = m.pitcherWHIP; return C(w != null ? w.toFixed(2) : null, w > 1.35 ? "#3fb950" : w > 1.20 ? "#e3b341" : "#f78166"); }
                          if (k==="plat") { const s = m.hitterSplitBA; const pts = m.hitterPlatoonPts; if (s == null) return DASH; const ba = "."+Math.round(s*1000).toString().padStart(3,"0"); return <span style={{color:pts===2?"#3fb950":pts===0?"#f78166":"#e3b341"}}>{ba}</span>; }
                          if (k==="ou")  return C(ou  != null ? ou : null, ou <= 7.5 ? "#3fb950" : ou < 10.5 ? "#e3b341" : "#f78166");
                          if (k==="mlbOu") { const v = m.gameOuLine ?? m.hitterGameTotal; return v != null ? <span style={{color:v>=9.5?"#3fb950":v>=7.5?"#e3b341":"#f78166"}}>{v}</span> : DASH; }
                          if (k==="dvp") { const r = m.posDvpRank; return C(r != null ? `#${r}${m.posGroup?" "+m.posGroup:""}` : null, r<=10?"#3fb950":r<=20?"#e3b341":"#f78166"); }
                          if (k==="sim") { const sc = m.teamTotalSimScore ?? m.totalSimScore ?? m.finalSimScore ?? m.hitterFinalSimScore ?? m.nbaSimScore ?? m.nhlSimScore ?? m.simScore ?? m.hitterSimScore; const isTeamTotal = m.gameType === "teamTotal"; const isKPlay = m.finalSimScore != null && m.totalSimScore == null && !isTeamTotal; const isHRR = m.hitterFinalSimScore != null && m.finalSimScore == null && !isTeamTotal; const isNBA = m.nbaSimScore != null && m.totalSimScore == null && !isTeamTotal; const isNHL = m.nhlSimScore != null && m.totalSimScore == null && !isTeamTotal; const qualGreen = 8; const qualGate = 6; let tip = null; if (isKPlay) { tip = [`CSW%/K%: ${m.kpctPts??1}/2`,`K-BB%: ${m.kbbPts??1}/2`,`Lineup K%: ${m.lkpPts??1}/2`,`Hit Rate: ${m.blendedHitRatePts??1}/2`,`O/U: ${m.totalPts??1}/2`].join('\n'); } else if (isHRR) { tip = [`Quality: ${m.hitterBatterQualityPts??1}/2`,`WHIP: ${m.hitterWhipPts??1}/2`,`Season HR: ${m.hitterSeasonHitRatePts??1}/2`,`H2H HR: ${m.hitterH2HHitRatePts??1}/2`,`O/U: ${m.hitterTotalPts??1}/2`].join('\n'); } else if (isNBA) { const dvpPts=m.dvpRatio>=1.05?2:m.dvpRatio>=1.02?1:0; const gt=m.nbaGameTotal; const pace=m.nbaPaceAdj; const _paceGood=pace!=null&&pace>0; const _totalGood=gt!=null&&gt>=225; const comboPts=(_paceGood&&_totalGood)?2:(_paceGood||_totalGood)?1:0; let c1Label='C1', c1Pts=m.nbaSimScore != null ? 1 : 1; if(m.stat==='rebounds'){const v=m.nbaOpportunity;c1Pts=v==null?1:v>=30?2:v>=25?1:0;c1Label=`AvgMin ${v!=null?v.toFixed(0)+'m':'—'}`;} else {const u=m.nbaUsage;c1Pts=u==null?1:u>=28?2:u>=22?1:0;c1Label=`USG% ${u!=null?u.toFixed(1)+'%':'—'}`;} tip = [`${c1Label}: ${c1Pts}/2`,`DVP: ${dvpPts}/2`,`Season HR: ${m.nbaSeasonHitRatePts??1}/2`,`Soft HR: ${m.nbaSoftHitRatePts??1}/2`,`Pace+Total: ${comboPts}/2`].join('\n'); } else if (isNHL) { const toiPts=m.nhlOpportunity>=18?2:m.nhlOpportunity>=15?1:m.nhlOpportunity!=null?0:1; const gaaRank=m.posDvpRank; const gaaPts=gaaRank==null?1:gaaRank<=10?2:gaaRank<=15?1:0; const nhlTotal=m.nhlGameTotal; const nhlTotalPts=nhlTotal==null?1:nhlTotal>=7?2:nhlTotal>=5.5?1:0; tip = [`TOI ${m.nhlOpportunity?.toFixed(1)??'—'}m: ${toiPts}/2`,`GAA rank: ${gaaPts}/2`,`Season HR: ${m.nhlSeasonHitRatePts??1}/2`,`DVP HR: ${m.nhlDvpHitRatePts??1}/2`,`O/U ${nhlTotal??'—'}: ${nhlTotalPts}/2`].join('\n'); } else if (isTeamTotal) { const h2hPts=m.h2hHitRatePts??1; if (m.sport==="mlb") { const rpgPts=v=>v==null?1:v>5.0?2:v>4.0?1:0; const eraPts=v=>v==null?1:v>4.5?2:v>3.5?1:0; const pf=m.parkFactor; const parkPts=pf==null?0:pf>1.05?2:pf>1.00?1:0; const ou=m.gameOuLine; const ouPts=ou==null?1:ou>=9.5?2:ou>=7.5?1:0; tip=[`${m.scoringTeam} RPG (${m.teamRPG??'—'}): ${rpgPts(m.teamRPG)}/2`,`${m.oppTeam} ERA (${m.oppERA??'—'}): ${eraPts(m.oppERA)}/2`,`H2H HR% (${m.h2hHitRate!=null?m.h2hHitRate+'%':'—'}${m.h2hGames?' · '+m.h2hGames+'g':''}): ${h2hPts}/2`,`Park (${pf!=null?(((pf-1)*100).toFixed(0)+'%'):'—'}): ${parkPts}/2`,`O/U (${ou??'—'}): ${ouPts}/2`].join('\n'); } else if (m.sport==="nba") { const offPts=v=>v==null?1:v>=118?2:v>=113?1:0; const defPts=v=>v==null?1:v>=118?2:v>=113?1:0; const ou=m.gameOuLine; const ouPts=ou==null?1:ou>=235?2:ou>=225?1:0; const pace=m.teamPace,lgPace=m.leagueAvgPace; const pacePts=pace==null||lgPace==null?1:pace>lgPace+2?2:pace>lgPace-2?1:0; tip=[`${m.scoringTeam} off PPG (${m.teamOff??'—'}): ${offPts(m.teamOff)}/2`,`${m.oppTeam} def allowed (${m.oppDef??'—'}): ${defPts(m.oppDef)}/2`,`O/U (${ou??'—'}): ${ouPts}/2`,`${m.scoringTeam} pace (${pace!=null?pace.toFixed(1):'—'}): ${pacePts}/2`,`H2H HR% (${m.h2hHitRate!=null?m.h2hHitRate+'%':'—'}${m.h2hGames?' · '+m.h2hGames+'g':''}): ${h2hPts}/2`].join('\n'); } } else if (m.totalSimScore != null) { if (m.sport==="mlb") { const hERA=m.homeERA,aERA=m.awayERA,hRPG=m.homeRPG,aRPG=m.awayRPG,ou=m.gameOuLine; const eraPts=v=>v==null?1:v>4.5?2:v>3.5?1:0; const rpgPts=v=>v==null?1:v>5.0?2:v>4.0?1:0; tip=[`${m.homeTeam} ERA (${hERA??'—'}): ${eraPts(hERA)}/2`,`${m.awayTeam} ERA (${aERA??'—'}): ${eraPts(aERA)}/2`,`${m.homeTeam} RPG (${hRPG??'—'}): ${rpgPts(hRPG)}/2`,`${m.awayTeam} RPG (${aRPG??'—'}): ${rpgPts(aRPG)}/2`,`O/U (${ou??'—'}): ${ou!=null?(ou>=9.5?2:ou>=7.5?1:0):1}/2`].join('\n'); } else if (m.sport==="nba") { const hOff=m.homeOff,aOff=m.awayOff,hDef=m.homeDef,aDef=m.awayDef; const ou=m.gameOuLine; const offPts=v=>v==null?1:v>=118?2:v>=113?1:0; const defPts=v=>v==null?1:v>=118?2:v>=113?1:0; const ouPts=v=>v==null?1:v>=235?2:v>=225?1:0; tip=[`${m.homeTeam} off PPG (${hOff??'—'}): ${offPts(hOff)}/2`,`${m.awayTeam} off PPG (${aOff??'—'}): ${offPts(aOff)}/2`,`${m.homeTeam} def allowed (${hDef??'—'}): ${defPts(hDef)}/2`,`${m.awayTeam} def allowed (${aDef??'—'}): ${defPts(aDef)}/2`,`O/U (${ou??'—'}): ${ouPts(ou)}/2`].join('\n'); } else if (m.sport==="nhl") { const hGPG=m.homeGPG,aGPG=m.awayGPG,hGAA=m.homeGAA,aGAA=m.awayGAA,ou=m.gameOuLine; const gpgPts=v=>v==null?1:v>=3.5?2:v>=3.0?1:0; const gaaPts=v=>v==null?1:v>=3.5?2:v>=3.0?1:0; const ouPts=v=>v==null?1:v>=7?2:v>=5.5?1:0; tip=[`${m.homeTeam} GPG (${hGPG??'—'}): ${gpgPts(hGPG)}/2`,`${m.awayTeam} GPG (${aGPG??'—'}): ${gpgPts(aGPG)}/2`,`${m.homeTeam} GAA (${hGAA??'—'}): ${gaaPts(hGAA)}/2`,`${m.awayTeam} GAA (${aGAA??'—'}): ${gaaPts(aGAA)}/2`,`O/U (${ou??'—'}): ${ouPts(ou)}/2`].join('\n'); } } return sc != null ? <span title={tip??undefined} style={{color:sc>=qualGreen?"#3fb950":sc>=qualGate?"#e3b341":"#8b949e",fontWeight:600,cursor:tip?"help":"default"}}>{sc}/10</span> : DASH; }
                          if (k==="env") { const pf = m.parkFactor ?? m.hitterParkKF; if (pf == null) return DASH; const pct = Math.round((pf-1)*100); const disp = (pct>=0?"+":"")+pct+"%"; return <span style={{color:pf>1.02?"#3fb950":pf<0.98?"#f78166":"#8b949e"}}>{disp}</span>; }
                          if (k==="brrl") { const b = m.hitterBarrelPct; return b != null ? <span style={{color:b>=14?"#3fb950":b>=10?"#e3b341":b>=7?"#8b949e":"#f78166"}}>{b.toFixed(1)+"%"}</span> : DASH; }
                          if (k==="nbapace") { const p = m.nbaPaceAdj; return p != null ? <span style={{color:p>0?"#3fb950":p>-2?"#e3b341":"#8b949e"}}>{p>0?"+":""}{p.toFixed(1)}</span> : DASH; }
                          if (k==="nbaopp")  { const o = m.nbaOpportunity; return o != null ? <span style={{color:o>=30?"#3fb950":o>=25?"#e3b341":"#f78166"}}>{o.toFixed(0)}m</span> : DASH; }
                          if (k==="nba_b2b") { if (m.isB2B == null) return DASH; return <span style={{color:m.isB2B?"#f78166":"#3fb950"}}>{m.isB2B?"B2B":"Rested"}</span>; }
                          if (k==="nbaC1") { const isReb = m.stat==="rebounds"; const v = isReb ? m.nbaOpportunity : m.nbaUsage; if (v == null) return DASH; const color = isReb ? (v>=30?"#3fb950":v>=25?"#e3b341":"#f78166") : (v>=28?"#3fb950":v>=22?"#e3b341":"#f78166"); return <span style={{color}}>{isReb ? v.toFixed(0)+"m" : v.toFixed(1)+"%"}</span>; }
                          if (k==="nbaOu")   { const v = m.nbaGameTotal; return v != null ? <span style={{color:v>=235?"#3fb950":v>=225?"#e3b341":"#8b949e"}}>{v}</span> : DASH; }
                          if (k==="nbaSeasonHR") { const v = m.seasonPct; const pts = m.nbaSeasonHitRatePts ?? (v==null?1:v>=90?2:v>=80?1:0); const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return v!=null ? <span style={{color}}>{v.toFixed(0)}%</span> : DASH; }
                          if (k==="nbaSoftHR") { const v = m.softPct; if (v==null) return DASH; const pts = m.nbaSoftHitRatePts ?? (v>=90?2:v>=80?1:0); const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
                          if (k==="nbaPaceTotal") { const pts = m.nbaTotalPts ?? 1; const pa = m.nbaPaceAdj; const ou = m.nbaGameTotal; const color = pts>=2?"#3fb950":pts>=1?"#e3b341":"#8b949e"; const paStr = pa!=null?(pa>0?"+":"")+pa.toFixed(1):null; const ouStr = ou!=null?String(ou):null; const label = [paStr,ouStr].filter(Boolean).join(" · "); return label ? <span style={{color}}>{label}</span> : DASH; }
                          if (k==="nba_spread") { const adj = m.nbaBlowoutAdj; if (adj == null) return DASH; const color = adj===1.0?"#3fb950":adj>0.92?"#e3b341":"#f78166"; const sp = m.nbaBlowoutAdj!=null && adj<1.0 ? Math.round((1-adj)/0.007+10) : null; return <span style={{color}}>{adj===1.0?"Tight":sp!=null?`-${sp}`:"—"}</span>; }
                          if (k==="nhlgaa") { const r = m.oppRank; return C(r != null ? `#${r}` : null, r<=10?"#3fb950":r<=15?"#e3b341":"#f78166"); }
                          if (k==="nhlsa")  { const v = m.nhlShotsAdj; const r = m.nhlSaRank; return v != null ? <span style={{color:(r!=null&&r<=10)?"#3fb950":v>0?"#e3b341":"#f78166"}}>{v>0?"+":""}{v.toFixed(1)}</span> : DASH; }
                          if (k==="nhltoi") { const t = m.nhlOpportunity; return t != null ? <span style={{color:t>=18?"#3fb950":t>=15?"#e3b341":"#f78166"}}>{t.toFixed(1)}m</span> : DASH; }
                          if (k==="nhl_b2b") { if (m.isB2B == null) return DASH; return <span style={{color:m.isB2B?"#f78166":"#3fb950"}}>{m.isB2B?"B2B":"Rested"}</span>; }
                          if (k==="nhlSeasonHR") { const v=m.seasonPct; if (v==null) return DASH; const pts=m.nhlSeasonHitRatePts??(v>=90?2:v>=80?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
                          if (k==="nhlDvpHR") { const v=m.softPct; if (v==null) return DASH; const pts=m.nhlDvpHitRatePts??(v>=90?2:v>=80?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(0)}%</span>; }
                          if (k==="nhlGameTotalOu") { const v=m.nhlGameTotal; if (v==null) return DASH; const color=v>=7?"#3fb950":v>=5.5?"#e3b341":"#f78166"; return <span style={{color,fontWeight:600}}>O{v}</span>; }
                          // Total PPG columns
                          if (k==="homeRPG"||k==="awayRPG") { const v = m[k]; return v != null ? <span style={{color:v>=5.0?"#3fb950":v>=4.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
                          if (k==="homeERA"||k==="awayERA") { const v = m[k]; return v != null ? <span style={{color:v>=4.5?"#3fb950":v>=3.5?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(2)}</span> : DASH; }
                          if (k==="homeOff"||k==="awayOff") { const v = m[k]; return v != null ? <span style={{color:v>=115?"#3fb950":v>=108?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(0)}</span> : DASH; }
                          if (k==="homeDef"||k==="awayDef") { const v = m[k]; return v != null ? <span style={{color:v>=112?"#3fb950":v>=105?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(0)}</span> : DASH; }
                          if (k==="totalOu") { const v = m.threshold; if (v == null) return DASH; const line = (v-0.5).toFixed(1); const color = m.sport==="nba" ? (v>=215?"#3fb950":v>=205?"#e3b341":"#8b949e") : m.sport==="nhl" ? (v>=6?"#3fb950":v>=5?"#e3b341":"#8b949e") : "#8b949e"; return <span style={{color,fontWeight:600}}>O{line}</span>; }
                          if (k==="homeGPG"||k==="awayGPG"||k==="homeGAA"||k==="awayGAA") { const v = m[k]; return v != null ? <span style={{color:v>=3.5?"#3fb950":v>=3.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span> : DASH; }
                          // HRR new SimScore columns
                          if (k==="hQuality") { const pts=m.hitterBatterQualityPts; const sp=m.hitterLineupSpot; const brrl=m.hitterBarrelPct; if (pts==null) return DASH; const color=pts===2?"#3fb950":pts===1?"#e3b341":"#f78166"; const disp=sp!=null?`#${sp}${brrl!=null?' '+brrl.toFixed(0)+'%':''}`:brrl!=null?brrl.toFixed(1)+'%':`${pts}/2`; return <span style={{color}}>{disp}</span>; }
                          if (k==="hSsnHR") { const v=m.seasonPct; if (v==null) return DASH; const pts=m.hitterSeasonHitRatePts ?? (v>=80?2:v>=70?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(1)+"%"}</span>; }
                          if (k==="hH2HHR") { const v=m.softPct; if (v==null) return DASH; const pts=m.hitterH2HHitRatePts ?? (v>=80?2:v>=70?1:0); const color=pts>=2?"#3fb950":pts>=1?"#e3b341":"#f78166"; return <span style={{color}}>{v.toFixed(1)+"%"}</span>; }
                          // Team total columns
                          if (k==="ttOpp") { return m.oppTeam ? <span onClick={() => { setShowReport(false); navigateToTeam(m.oppTeam, m.sport); }} style={{color:"#8b949e",cursor:"pointer"}}>{m.oppTeam}</span> : DASH; }
                          if (k==="ttH2HHR") { const v=m.h2hHitRate; const g=m.h2hGames; if (v==null) return DASH; const color=v>=80?"#3fb950":v>=60?"#e3b341":"#f78166"; return <span style={{color}} title={g!=null?`${g} H2H games`:undefined}>{v}%</span>; }
                          if (k==="ttTeamRPG") { const v=m.teamRPG; return v!=null?<span style={{color:v>5.0?"#3fb950":v>4.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
                          if (k==="ttOppERA") { const v=m.oppERA; return v!=null?<span style={{color:v>4.5?"#3fb950":v>3.5?"#e3b341":"#8b949e",fontWeight:600}}>{parseFloat(v).toFixed(2)}</span>:DASH; }
                          if (k==="ttOppRPG") { const v=m.oppRPG; return v!=null?<span style={{color:v>5.0?"#3fb950":v>4.0?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(1)}</span>:DASH; }
                          if (k==="ttPark") { const pf=m.parkFactor; if(pf==null) return DASH; const pct=Math.round((pf-1)*100); return <span style={{color:pf>1.05?"#3fb950":pf>1.00?"#e3b341":"#8b949e"}}>{(pct>=0?"+":"")+pct+"%"}</span>; }
                          if (k==="ttOu") { const v=m.gameOuLine; if(v==null) return DASH; const color=m.sport==="nba"?(v>=235?"#3fb950":v>=225?"#e3b341":"#8b949e"):(v>=9.5?"#3fb950":v>=7.5?"#e3b341":"#8b949e"); return <span style={{color,fontWeight:600}}>{v}</span>; }
                          if (k==="ttTeamOff") { const v=m.teamOff; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(0)}</span>:DASH; }
                          if (k==="ttOppDef") { const v=m.oppDef; return v!=null?<span style={{color:v>=118?"#3fb950":v>=113?"#e3b341":"#8b949e",fontWeight:600}}>{v.toFixed(0)}</span>:DASH; }
                          if (k==="ttPace") { const pace=m.teamPace,lg=m.leagueAvgPace; if(pace==null||lg==null) return DASH; const d=parseFloat((pace-lg).toFixed(1)); return <span style={{color:d>2?"#3fb950":d>-2?"#e3b341":"#8b949e"}}>{d>0?"+":""}{d}</span>; }
                          if (k==="ttSpread") { const sp=m.gameSpread; if(sp==null) return DASH; const abs=Math.abs(sp); return <span style={{color:abs<=5?"#3fb950":abs<=10?"#e3b341":"#f78166"}}>{sp>0?"+":""}{sp.toFixed(1)}</span>; }
                          return DASH;
                        };
                        const RESULT_LABELS = {
                          edge_too_low:"edge low", kalshi_pct_too_low:"<70%",
                          opp_not_soft:"not soft", low_confidence:"low score",
                          team_not_favored:"ML ✗", pitcher_era_too_low:"ERA ✗",
                          no_h2h_data:"no h2h", insufficient_ab_vs_pitcher:"AB ✗",
                          low_batting_avg:"BA ✗", no_opp:"no team",
                          no_espn_info:"no info", no_gamelog:"no log",
                          no_soft_data:"no data", col_not_found:"no col", no_gamelog_vals:"no vals",
                          low_lineup_spot:"spot 5-9", no_simulation_data:"no data",
                        };
                        const _sk = `${sport}|${stat}`;
                        const _sc = reportSort[_sk];
                        const COL_TIPS = {
                          player:"Player name", line:"Prop line threshold",
                          true:"Model True% (Monte Carlo simulation)",
                          kalshi:"Kalshi market price", edge:"Model edge over Kalshi market",
                          opp:"Tonight's opponent / starting pitcher",
                          sim:"Sim-Score (max 10 — 8+ = Alpha tier); hover for component breakdown",
                          env:"Park factor: green = pitcher/hitter-friendly stadium",
                          ml:"Team moneyline (your team's odds)", ou:"Game total (over/under line)",
                          csw:"Called Strike + Whiff% — pitch quality indicator (>30% = green)",
                          kbb:"K% − BB% — command indicator (>15% = green)",
                          lkp:"Opposing lineup K-rate vs this pitcher hand (>24% = green, >22% = yellow, ≤22% = red)",
                          kbb:"K-BB% command indicator (>18% = green, >12% = yellow, ≤12% = red)",
                          pps:"Pitcher avg pitches per start (>85 means deeper into games)",
                          spot:"Batting order position (1–3 = green, 4 = yellow, 5+ filtered)",
                          whip:"Pitcher WHIP (H+BB)/IP — >1.35 favors hitter",
                          plat:"Batter split BA vs pitcher hand — green=platoon edge (≥+15%), red=disadvantage",
                          brrl:"Barrel% hard-contact rate (Statcast)",
                          season:"Season hit rate %", h2h:"Hit rate vs soft-DVP opponents",
                          nbapace:"Avg game pace vs league avg (positive = faster pace = more possessions)",
                          nbaC1:"C1 opportunity: USG% for pts/ast/3pt (≥28% green, ≥22% yellow); AvgMin for rebounds (≥30m green, ≥25m yellow)",
                          nbaOu:"Game total (O/U line — ≥235 green, ≥225 yellow)",
                          nbaSeasonHR:"Season hit rate at this threshold (blended 2026/2025) — ≥90% green, ≥80% yellow, <80% red",
                          nbaSoftHR:"Hit rate vs soft defensive teams — ≥90% green, ≥80% yellow, <80% red; null = dash (1pt abstain in SimScore)",
                          nbaPaceTotal:"Pace delta + O/U line (both shown). Color: both favorable (pace>0 AND O/U≥225) = green/2pts; one = yellow/1pt; neither = gray/0pts",
                          nba_spread:"Game spread tightness — tight game (≤10) = full minutes, no garbage time",
                          dvp:"Defense vs Position rank (lower = softer matchup)",
                          nhlgaa:"Opponent GAA rank — ≤10 green (2pts), ≤15 yellow (1pt), >15 red (0pts)",
                          nhlsa:"Shots against adj vs league avg (positive = more shots allowed = more opportunities)",
                          nhltoi:"Player avg ice time last 10 games — ≥18m green (2pts), ≥15m yellow (1pt), <15m red (0pts)",
                          nhl_b2b:"Rest status (B2B = back-to-back game, red; Rested = green)",
                          nhlSeasonHR:"Career season hit rate at threshold — ≥90% green (2pts), ≥80% yellow (1pt), <80% red (0pts)",
                          nhlDvpHR:"Hit rate vs teams with GAA above league avg (≥3 games req) — ≥90% green, ≥80% yellow; null = 1pt abstain",
                          nhlGameTotalOu:"Game O/U line — ≥7 green (2pts), ≥5.5 yellow (1pt), <5.5 red (0pts)",
                          homeRPG:"Home team runs per game — higher = more scoring (green ≥5.0, yellow ≥4.0)",
                          awayRPG:"Away team runs per game — higher = more scoring (green ≥5.0, yellow ≥4.0)",
                          homeERA:"Home starter ERA — higher = more hittable pitcher (green ≥4.5, yellow ≥3.5)",
                          awayERA:"Away starter ERA — higher = more hittable pitcher (green ≥4.5, yellow ≥3.5)",
                          homeOff:"Home team offensive PPG — higher = better for over (green ≥115, yellow ≥108)",
                          awayOff:"Away team offensive PPG — higher = better for over (green ≥115, yellow ≥108)",
                          homeDef:"Home team defensive PPG allowed — higher = worse defense = good for over (green ≥112, yellow ≥105)",
                          awayDef:"Away team defensive PPG allowed — higher = worse defense = good for over (green ≥112, yellow ≥105)",
                          totalOu:"Market O/U threshold — Kalshi qualifying line (NBA: green ≥215, NHL: green ≥6)",
                          homeGPG:"Home team goals per game — higher = better for over (green ≥3.5, yellow ≥3.0)",
                          awayGPG:"Away team goals per game — higher = better for over (green ≥3.5, yellow ≥3.0)",
                          homeGAA:"Home team goals against average — higher = worse defense = good for over (green ≥3.5, yellow ≥3.0)",
                          awayGAA:"Away team goals against average — higher = worse defense = good for over (green ≥3.5, yellow ≥3.0)",
                          kHitRate:"Blended hit rate at threshold (trust-weighted 2026/2025) — ≥90% = 2pts green, ≥80% = 1pt yellow, <80% = 0pts red",
                          hQuality:"Batter quality composite — lineup spot 1–3 + barrel% ≥10%; both = green, one = yellow, neither = red. Shows #spot + barrel%.",
                          hSsnHR:"Season HRR hit rate (2026/2025 blended) — ≥80% = 2pts green, ≥70% = 1pt yellow, <70% = 0pts red",
                          hH2HHR:"H2H hit rate vs tonight's pitcher (≥5 games) or platoon-adjusted team rate — ≥80% = 2pts green, ≥70% = 1pt yellow; null = 1pt abstain",
                          ttOpp:"Opponent team — click to navigate to team page",
                          ttH2HHR:"H2H hit rate — scoring team scored ≥ threshold in last 10 games vs this opponent — ≥80% green (2pts), ≥60% yellow (1pt), <60% red (0pts); null (<3 H2H games) = 1pt abstain",
                          ttTeamRPG:"Scoring team runs per game (regular season) — higher = better for team runs over (green >5.0, yellow >4.0)",
                          ttOppERA:"Opponent starter ERA — higher = more hittable pitcher = better for over (green >4.5, yellow >3.5)",
                          ttOppRPG:"Opponent runs per game — higher = game environment favors scoring (green >5.0, yellow >4.0)",
                          ttPark:"Park run factor — green = hitter-friendly (>+5% green, >0% yellow)",
                          ttOu:"Game O/U line — MLB: green ≥9.5, yellow ≥7.5; NBA: green ≥235, yellow ≥225",
                          ttTeamOff:"Team offensive PPG (regular season) — higher = better for team points over (green ≥118, yellow ≥113)",
                          ttOppDef:"Opponent defensive PPG allowed — higher = worse defense = easier scoring (green ≥118, yellow ≥113)",
                          ttPace:"Team pace vs league average — positive = faster pace = more possessions = more scoring opportunities",
                          ttSpread:"Game spread — tight game (≤5) = full minutes competitive play (green ≤5, yellow ≤10, red >10)",
                        };
                        const _hdr = (col, label, extraStyle={}, textAlign="right") => {
                          const active = _sc?.col === col;
                          const onClick = () => setReportSort(prev => {
                            const cur = prev[_sk];
                            const dir = cur?.col === col && cur.dir === "desc" ? "asc" : "desc";
                            return {...prev, [_sk]: {col, dir}};
                          });
                          return <div title={COL_TIPS[col]} style={{flex:1,color:active?"#c9d1d9":"#484f58",fontSize:10,textAlign,cursor:"pointer",userSelect:"none",...extraStyle}} onClick={onClick}>
                            {label}{active ? (_sc.dir === "desc" ? "↓" : "↑") : ""}
                          </div>;
                        };
                        const _oppFlex = (sport === "nba" || (sport === "mlb" && stat === "strikeouts")) ? 1 : 2;
                        return <React.Fragment>
                          <div style={{display:"flex",alignItems:"center",gap:6,padding:"3px 12px 4px",marginBottom:2}}>
                            {_hdr("player", stat.startsWith("team") ? "Team" : stat.startsWith("total") ? "Matchup" : "Player", {flex:2,minWidth:0}, "left")}
                            {_hdr("line","Line")}
                            {_hdr("true","True%")}
                            {_hdr("kalshi","Kalshi")}
                            {_hdr("edge","Edge")}
                            {xcols.map(c => <React.Fragment key={c.k}>{_hdr(c.k,c.l)}</React.Fragment>)}
                            {!stat.startsWith("total") && !stat.startsWith("team") && _hdr("opp","Opp",{flex:_oppFlex})}
                          </div>
                          <div style={{background:"#0d1117",borderRadius:8,overflow:"hidden"}}>
                            {rows.map((m, i) => {
                              const truePct = m.truePct ?? null;
                              const edge = m.edge ?? null;
                              const _mlbRowScore = sport === "mlb" ? (m.finalSimScore ?? m.hitterFinalSimScore ?? null) : null;
                              const _highScore = _mlbRowScore != null && _mlbRowScore > 7;
                              const resultCell = (() => {
                                if (m.qualified) {
                                  if (stat === "strikeouts" && m.finalSimScore != null) {
                                    const sc = m.finalSimScore;
                                    const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                                    return <span style={{background:"rgba(63,185,80,0.15)",borderRadius:4,padding:"1px 6px",display:"inline-flex",gap:4,alignItems:"center"}}>
                                      <span style={{color:scColor,fontWeight:700,fontSize:10}}>{sc}/10</span>
                                      <span style={{color:sc>=8?"#3fb950":"#e3b341",fontSize:9}}>{sc>=8?"Alpha":"Mid"}</span>
                                    </span>;
                                  }
                                  if (stat !== "strikeouts" && m.hitterFinalSimScore != null) {
                                    const sc = m.hitterFinalSimScore;
                                    const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                                    const tier = sc >= 8 ? "Alpha" : "Mid";
                                    return <span style={{background:"rgba(63,185,80,0.15)",borderRadius:4,padding:"1px 6px",display:"inline-flex",gap:4,alignItems:"center"}}>
                                      <span style={{color:scColor,fontWeight:700,fontSize:10}}>{sc}/10</span>
                                      <span style={{color:sc>=8?"#3fb950":"#e3b341",fontSize:9}}>{tier}</span>
                                    </span>;
                                  }
                                  if (sport === "nba" && m.nbaSimScore != null) {
                                    const sc = m.nbaSimScore;
                                    const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                                    const tier = sc >= 8 ? "Alpha" : sc >= 5 ? "Mid" : "Low";
                                    return <span style={{background:"rgba(63,185,80,0.15)",borderRadius:4,padding:"1px 6px",display:"inline-flex",gap:4,alignItems:"center"}}>
                                      <span style={{color:scColor,fontWeight:700,fontSize:10}}>{sc}/10</span>
                                      <span style={{color:scColor,fontSize:9}}>{tier}</span>
                                    </span>;
                                  }
                                  return <span style={{background:"rgba(63,185,80,0.15)",color:"#3fb950",borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:700}}>PLAY</span>;
                                }
                                if (m.reason === "low_confidence" && (m.simScore ?? m.hitterSimScore) != null) {
                                  return <span style={{fontSize:10,color:"#484f58"}}>{(m.simScore ?? m.hitterSimScore)}/10</span>;
                                }
                                return <span style={{fontSize:10,color:"#484f58"}}>{RESULT_LABELS[m.reason] ?? m.reason ?? ""}</span>;
                              })();
                              const isTotal = m.gameType === "total";
                              const isTeamTotal = m.gameType === "teamTotal";
                              const _nameWhite = (isTotal || isTeamTotal) ? m.qualified : sport === "mlb" ? (_highScore && m.qualified !== false) : m.qualified;
                              const _rowKey = isTeamTotal ? `${m.scoringTeam}|${m.oppTeam}|${m.threshold}|${i}` : isTotal ? `${m.homeTeam}|${m.awayTeam}|${m.threshold}|${i}` : `${m.playerName}|${m.threshold}|${i}`;
                              return (
                                <div key={_rowKey} style={{
                                  display:"flex",alignItems:"center",gap:6,padding:"6px 12px",
                                  borderTop: i>0?"1px solid #161b22":"none"}}>
                                  <div style={{flex:2,minWidth:0,fontSize:12,fontWeight:_nameWhite?600:400,display:"flex",alignItems:"baseline",gap:3}}>
                                    {isTeamTotal
                                      ? <span onClick={() => { setShowReport(false); navigateToTeam(m.scoringTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{m.scoringTeam}</span>
                                      : isTotal
                                      ? <><span onClick={() => { setShowReport(false); navigateToTeam(m.awayTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{m.awayTeam}</span>
                                          <span style={{color:"#484f58"}}> @ </span>
                                          <span onClick={() => { setShowReport(false); navigateToTeam(m.homeTeam, m.sport); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",cursor:"pointer"}}>{m.homeTeam}</span></>
                                      : <><span onClick={() => { setShowReport(false); navigateToPlayer({ id: m.playerId, name: m.playerName, sportKey: SPORT_KEY[m.sport] }, m.stat); }} style={{color:_nameWhite?"#c9d1d9":"#8b949e",whiteSpace:"nowrap",textTransform:"capitalize",cursor:"pointer"}}>{m.playerNameDisplay||m.playerName}</span>
                                         {(m.playerTeam||m.kalshiPlayerTeam)&&<span style={{color:"#484f58",fontWeight:400,flexShrink:0,fontSize:10}}>({m.playerTeam||m.kalshiPlayerTeam})</span>}</>
                                    }
                                  </div>
                                  <div style={{flex:1,color:"#8b949e",fontSize:11,textAlign:"right"}}>
                                    {(isTotal || isTeamTotal) ? `${m.direction === "under" ? "U" : "O"}${(m.threshold - 0.5).toFixed(1)}` : `${m.threshold}+`}
                                  </div>
                                  {(() => { const _tp = m.direction === "under" ? (m.noTruePct ?? null) : (m.truePct ?? null); return <div style={{flex:1,fontSize:11,textAlign:"right",color:_tp!=null?"#e3b341":"#21262d",fontWeight:_tp!=null?600:400}}>{_tp!=null?`${_tp}%`:"—"}</div>; })()}
                                  {(() => { const _kp = m.direction === "under" ? (m.noKalshiPct ?? null) : (m.kalshiPct ?? null); return <div style={{flex:1,fontSize:11,textAlign:"right"}}><span style={{color:_kp != null ? "#c9d1d9" : "#484f58"}}>{_kp != null ? `${_kp}%` : "—"}</span></div>; })()}
                                  <div style={{flex:1,fontSize:11,textAlign:"right",color:edge!=null&&edge>=5?"#3fb950":edge!=null&&edge<0?"#f78166":"#8b949e"}}>{edge!=null?(edge>=0?`+${edge.toFixed(1)}`:`${edge.toFixed(1)}`)+"%" :"—"}</div>
                                  {xcols.map(c => <div key={c.k} style={{flex:1,fontSize:11,textAlign:"right"}}>{xcell(m,c.k)}</div>)}
                                  {!isTotal && !isTeamTotal && <div style={{flex:_oppFlex,fontSize:10,textAlign:"right",whiteSpace:"nowrap"}}>
                                    {(() => { const pn = m.pitcherName || m.hitterPitcherName; const parts = pn ? pn.trim().split(" ") : []; const shortPn = parts.length >= 2 ? `${parts[0][0]}. ${parts.slice(1).join(" ")}` : pn; return m.sport==="mlb" && m.stat!=="strikeouts" && pn
                                      ? <><span style={{color:"#8b949e"}}>{shortPn}</span> <span style={{color:"#484f58"}}>({m.opponent})</span></>
                                      : <span style={{color:"#484f58"}}>{m.opponent||""}</span>; })()}
                                  </div>}
                                </div>
                              );
                            })}
                          </div>
                        </React.Fragment>;
                      })()}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
        );
      })()}

      {/* Auth modal */}
      {showAuthModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
          onClick={e => { if (e.target === e.currentTarget) setShowAuthModal(false); }}>
          <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:14,padding:"28px 28px 24px",width:"100%",maxWidth:360}}>
            <div style={{display:"flex",marginBottom:20,gap:0,border:"1px solid #30363d",borderRadius:8,overflow:"hidden"}}>
              {["login","register"].map(m => (
                <button key={m} onClick={() => { setAuthMode(m); setAuthError(""); }}
                  style={{flex:1,padding:"8px 0",fontSize:13,fontWeight:600,cursor:"pointer",border:"none",
                    background: authMode===m ? "rgba(88,166,255,0.15)" : "transparent",
                    color: authMode===m ? "#58a6ff" : "#8b949e"}}>
                  {m === "login" ? "Log in" : "Create account"}
                </button>
              ))}
            </div>
            <form onSubmit={authSubmit} style={{display:"flex",flexDirection:"column",gap:12}}>
              <input type="email" placeholder="Email" required value={authForm.email}
                onChange={e => setAuthForm(f => ({...f, email:e.target.value}))}
                style={{background:"#0d1117",border:"1px solid #30363d",borderRadius:8,color:"#c9d1d9",
                  fontSize:14,padding:"10px 14px",outline:"none",width:"100%"}}/>
              <input type="password" placeholder="Password (min 6 chars)" required value={authForm.password}
                onChange={e => setAuthForm(f => ({...f, password:e.target.value}))}
                style={{background:"#0d1117",border:"1px solid #30363d",borderRadius:8,color:"#c9d1d9",
                  fontSize:14,padding:"10px 14px",outline:"none",width:"100%"}}/>
              {authError && <div style={{color:"#f78166",fontSize:12}}>{authError}</div>}
              <button type="submit" disabled={authLoading}
                style={{background:"#58a6ff",border:"none",borderRadius:8,color:"#0d1117",
                  fontSize:14,fontWeight:700,padding:"10px 0",cursor:"pointer",opacity:authLoading?0.6:1}}>
                {authLoading ? "…" : authMode === "login" ? "Log in" : "Create account"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Add Pick modal */}
      {showAddPick && (
        <AddPickModal
          onClose={() => setShowAddPick(false)}
          onAdd={play => trackPlay(play)}
          initialOdds={(() => { const v = calcOdds.trim(); return (v && v !== "-" && v !== "+" && !isNaN(parseInt(v))) ? v : "-110"; })()}
        />
      )}

      {/* Account bar */}
      <div style={{maxWidth:640,margin:"0 auto 12px",display:"flex",alignItems:"center",justifyContent:"flex-end",gap:8}}>
        {authEmail ? (
          <>
            <span style={{color:"#484f58",fontSize:11,display:"flex",alignItems:"center",gap:5}}>
              <span style={{width:6,height:6,borderRadius:"50%",background: syncStatus==="saving"?"#e3b341":syncStatus==="error"?"#f78166":"#3fb950",display:"inline-block"}}/>
              {authEmail}
            </span>
            <button onClick={logout}
              style={{fontSize:11,padding:"2px 8px",borderRadius:6,cursor:"pointer",
                border:"1px solid #30363d",background:"transparent",color:"#484f58"}}>
              log out
            </button>
          </>
        ) : (
          <button onClick={() => { setShowAuthModal(true); setAuthMode("login"); setAuthError(""); }}
            style={{fontSize:12,padding:"4px 12px",borderRadius:6,cursor:"pointer",
              border:"1px solid #58a6ff",background:"transparent",color:"#58a6ff",fontWeight:600}}>
            Log in / Sign up
          </button>
        )}
      </div>

      {/* Search + player card — constrained width */}
      <div style={{maxWidth:800,margin:"0 auto"}}>
      {/* Search */}
      <div style={{position:"relative",marginBottom:22}}>
        <span style={{position:"absolute",left:13,top:"50%",transform:"translateY(-50%)",fontSize:15,pointerEvents:"none",zIndex:1}}>
          {searching ? "⏳" : "🔍"}
        </span>
        <input ref={inputRef} value={query}
          onChange={e => { setQuery(e.target.value); setActiveIdx(-1); }}
          onKeyDown={handleKeyDown}
          onFocus={() => (suggestions.length > 0 || (query.trim().length >= 2 && teamSuggestions.length > 0)) && setShowDrop(true)}
          placeholder={player ? `Search player… (${player.name})` : teamPage ? `Search team or player… (${teamPage.abbr})` : "Search teams, NFL, NBA, MLB, NHL players…"}
          style={{width:"100%",background:"#161b22",border:"1px solid #30363d",borderRadius:10,
            color:"#fff",fontSize:14,padding:"12px 14px 12px 40px",outline:"none"}}
        />
        {showDrop && (suggestions.length > 0 || teamSuggestions.length > 0) && (
          <div ref={dropRef} style={{position:"absolute",top:"calc(100% + 6px)",left:0,right:0,
            background:"#161b22",border:"1px solid #30363d",borderRadius:10,overflow:"hidden",
            zIndex:100,boxShadow:"0 8px 24px rgba(0,0,0,0.6)"}}>
            {teamSuggestions.map((t, i) => (
              <div key={`team-${t.abbr}-${t.sport}`}
                onMouseDown={() => { setShowDrop(false); navigateToTeam(t.abbr, t.sport); }}
                onMouseEnter={() => setActiveIdx(-(i+1))}
                style={{padding:"10px 16px",cursor:"pointer",fontSize:14,color:"#c9d1d9",
                  borderBottom:"1px solid #21262d",
                  background: activeIdx===-(i+1)?"rgba(88,166,255,0.12)":"transparent",
                  display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <img src={`https://a.espncdn.com/i/teamlogos/${t.sport}/500/${t.abbr.toLowerCase()}.png`}
                    alt={t.abbr} onError={e=>e.target.style.visibility="hidden"}
                    style={{width:28,height:28,borderRadius:6,objectFit:"contain",background:"#21262d",flexShrink:0,padding:2}}/>
                  <span>{highlight(t.name, query)}</span>
                </div>
                <span style={{color:"#484f58",fontSize:11}}>{t.sport.toUpperCase()} · {t.abbr}</span>
              </div>
            ))}
            {suggestions.map((p,i) => (
              <div key={p.id} onMouseDown={() => { setShowDrop(false); navigateToPlayer(p, null); }}
                onMouseEnter={() => setActiveIdx(i)}
                style={{padding:"10px 16px",cursor:"pointer",fontSize:14,color:"#c9d1d9",
                  borderBottom: i<suggestions.length-1?"1px solid #21262d":"none",
                  background: activeIdx===i?"rgba(88,166,255,0.12)":"transparent",
                  display:"flex",alignItems:"center",justifyContent:"space-between"}}
              >
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <img
                    src={`https://a.espncdn.com/i/headshots/${p.league || sport.split("/")[1]}/players/full/${p.id}.png`}
                    alt={p.name}
                    onError={e => {
                      e.target.onerror = null;
                      if (p.teamId && p.league) {
                        e.target.src = `https://a.espncdn.com/i/teamlogos/${p.league}/500/${p.teamId}.png`;
                      }
                    }}
                    style={{width:28,height:28,borderRadius:6,objectFit:"cover",background:"#21262d",flexShrink:0}}
                  />
                  {highlight(p.name, query)}
                </div>
                <span style={{color:"#484f58",fontSize:11}}>{p.team}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Model reference page */}
      {modelPage && !player && !teamPage && (
        <ModelPage onBack={goBack} calibData={calibData} calibLoading={calibLoading} fetchCalib={fetchCalib} authToken={authToken} />
      )}

      {/* Team page */}
      {teamPage && !modelPage && (
        <TeamPage
          abbr={teamPage.abbr} sport={teamPage.sport}
          teamPageData={teamPageData}
          tonightPlays={tonightPlays}
          allTonightPlays={allTonightPlays}
          onBack={goBack}
          navigateToTeam={navigateToTeam}
          navigateToPlayer={navigateToPlayer}
          trackedPlays={trackedPlays}
          trackPlay={trackPlay}
          untrackPlay={untrackPlay}
        />
      )}

      {/* Player header */}
              {player && !teamPage && (
        <div style={{marginBottom:20}}>
        <button onClick={goBack}
          style={{background:"none",border:"none",color:"#8b949e",fontSize:13,cursor:"pointer",
            padding:"0 0 12px 0",display:"flex",alignItems:"center",gap:4}}>
          ← Back
        </button>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <img
            key={player.id}
            src={`https://a.espncdn.com/i/headshots/${sport.split("/")[1]}/players/full/${player.id}.png`}
            alt={player.name}
            style={{width:50,height:50,borderRadius:12,objectFit:"cover",background:"#161b22",flexShrink:0}}
          />
<div>
            <h1 style={{color:"#fff",margin:0,fontSize:19,fontWeight:700}}>{player.name}</h1>
            <div style={{color:"#8b949e",fontSize:12}}>{player.team}{(() => { const opp = player.opponent || (tonightPlays || []).find(p => (p.playerId && p.playerId === player.id) || p.playerName?.toLowerCase() === player.name?.toLowerCase())?.opponent; const oppSport = (player.sportKey||sport).split("/")[1]; return opp ? <> · <span style={{color:"#58a6ff",cursor:"pointer",textDecoration:"underline",textDecorationColor:"rgba(88,166,255,0.4)"}} onClick={()=>navigateToTeam(opp,oppSport)}>vs {opp}</span></> : ""; })()} · {SPORTS.find(s=>s.value===(player.sportKey||sport))?.label} 2025-26</div>
            {(() => {
              const _pp = (allTonightPlays || tonightPlays || []).filter(p => (p.playerId && p.playerId === player.id) || p.playerName?.toLowerCase() === player.name?.toLowerCase()).sort((a,b) => (a.gameDate||"").localeCompare(b.gameDate||""));
              const gt = _pp[0]?.gameTime;
              if (!gt) return null;
              const d = new Date(gt);
              const ptFmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"});
              const gamePT = ptFmt.format(d), todayPT = ptFmt.format(new Date()), tmrwPT = ptFmt.format(new Date(Date.now()+86400000));
              const dayLabel = gamePT === todayPT ? "Today" : gamePT === tmrwPT ? "Tomorrow" : new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric"}).format(d);
              const timePart = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"2-digit",hour12:true}).format(d);
              return <div style={{color:"#6e7681",fontSize:11,marginTop:2}}>{dayLabel} · {timePart} PT</div>;
            })()}
          </div>
          <div style={{marginLeft:"auto",display:"flex",gap:8}}>
            {[["AVG",avg],["HIGH",hi],["GP",totalGames]].map(([l,v]) => (
              <div key={l} style={{background:"#161b22",border:"1px solid #30363d",borderRadius:8,padding:"7px 11px",textAlign:"center"}}>
                <div style={{color:"#58a6ff",fontSize:16,fontWeight:700}}>{loading?"…":v}</div>
                <div style={{color:"#8b949e",fontSize:10}}>{l}</div>
              </div>
            ))}
          </div>
        </div>
        </div>
      )}

      {/* Stat tabs */}
      {player && !teamPage && (
        <div style={{display:"flex",gap:6,marginBottom:18}}>
          {tabs.map(k => (
            <button key={k} onClick={() => { setActiveTab(k); setDirection("over"); }} style={{flex:1,padding:"9px 0",borderRadius:8,
              border:"1px solid",cursor:"pointer",fontSize:13,
              borderColor: safeTab===k?"#58a6ff":"#30363d",
              background: safeTab===k?"rgba(88,166,255,0.12)":"#161b22",
              color: safeTab===k?"#58a6ff":"#8b949e",
              fontWeight: safeTab===k?700:400}}>
              {statCfgs[k].label}
            </button>
          ))}
        </div>
      )}

      {/* Combined chart: Season + Soft Matchup + True Probability */}
      {player && !teamPage && (() => {
        const hasDvp = dvpData && perGame.length > 0 && !loading && totalGames > 0;
        const isMLB = sport === "baseball/mlb";
        const WEAK_N = 10;
        let dvpMap = {}, wTotal = 0, weakTeamList = [];
        let mlbH2HOpp = isMLB ? (dvpData?.h2h?.opp || null) : null;
        let isLastMatchupFallback = false;
        // MLB: resolve matchup opponent — tonight's opp first, then cascade to most recent game with h2h data
        if (isMLB && perGame.length > 0) {
          const findLastOpp = () => [...perGame].reverse().find(g => g.oppAbbr && g[safeTab] !== undefined)?.oppAbbr ?? null;
          if (!mlbH2HOpp) {
            mlbH2HOpp = findLastOpp();
            if (mlbH2HOpp) isLastMatchupFallback = true;
          } else {
            // Tonight's opponent set — check if we actually have h2h history; if not, fall back to most recent
            const hasH2H = perGame.some(g => g.oppAbbr === mlbH2HOpp && g[safeTab] !== undefined);
            if (!hasH2H) {
              mlbH2HOpp = findLastOpp();
              if (mlbH2HOpp) isLastMatchupFallback = true;
            }
          }
        }
        if (hasDvp) {
          if (!isMLB) {
            // NBA/NHL/NFL: soft team ranking mode
            const softAbbrs = dvpData.softTeams?.[safeTab]?.length
              ? new Set(dvpData.softTeams[safeTab])
              : new Set((dvpData.teams || []).filter(t => t.rank <= WEAK_N).map(t => t.abbr));
            const weakGames = perGame.filter(g => softAbbrs.has(g.oppAbbr));
            wTotal = weakGames.length;
            weakTeamList = (dvpData.teams || [])
              .filter(t => softAbbrs.has(t.abbr))
              .filter(t => perGame.some(g => g.oppAbbr === t.abbr));
            if (wTotal > 0) {
              (cfg?.thresholds || []).forEach(t => {
                const wCount = weakGames.filter(g => (g[safeTab] ?? -1) >= t).length;
                dvpMap[t] = { wCount, wPct: (wCount / wTotal) * 100 };
              });
            }
          } else if (isMLB) {
            const allLkp = dvpData?.allLineupKPct || {};
            const tonightLkp = dvpData?.h2h?.lineupKPct
              ?? (tonightPlays || []).find(p => (p.playerId === player?.id || p.playerName === player?.name) && p.stat === "strikeouts")?.lineupKPct
              ?? null;
            if (safeTab === "strikeouts" && tonightLkp !== null && Object.keys(allLkp).length > 0) {
              // Pitcher strikeouts: bucket by tonight's opponent K rate (low/avg/high)
              const lkpBucket = tonightLkp >= 24 ? "high" : tonightLkp >= 20 ? "avg" : "low";
              const similarKAbbrs = new Set(
                Object.entries(allLkp)
                  .filter(([, k]) => lkpBucket === "high" ? k >= 24 : lkpBucket === "avg" ? (k >= 20 && k < 24) : k < 20)
                  .map(([a]) => a)
              );
              const _bucketFilter = g => g.oppAbbr && similarKAbbrs.has(g.oppAbbr) && g[safeTab] !== undefined;
              const bucketGames26 = perGame.filter(g => g.season === 2026 && _bucketFilter(g));
              const bucketGames25 = perGame.filter(g => g.season === 2025 && _bucketFilter(g));
              const bucketGamesAll = perGame.filter(g => _bucketFilter(g));
              // Prefer 2026 (15+ BF proxy: 3+ starts), fall back to 25+26 (3+), then all career
              const bucketGames = bucketGames26.length >= 3 ? bucketGames26
                : (bucketGames26.length + bucketGames25.length) >= 3 ? [...bucketGames25, ...bucketGames26]
                : bucketGamesAll;
              wTotal = bucketGames.length;
              if (wTotal >= 1) {
                (cfg?.thresholds || []).forEach(t => {
                  const wCount = bucketGames.filter(g => (g[safeTab] ?? -1) >= t).length;
                  dvpMap[t] = { wCount, wPct: (wCount / wTotal) * 100 };
                });
              } else {
                wTotal = 0; // no data
              }
            }
            // If bucket mode found no games, fall back to h2h vs resolved opponent (min 1)
            if (wTotal === 0 && mlbH2HOpp) {
              const h2hGames = perGame.filter(g => g.oppAbbr === mlbH2HOpp && g[safeTab] !== undefined);
              if (h2hGames.length >= 1) {
                wTotal = h2hGames.length;
                (cfg?.thresholds || []).forEach(t => {
                  const wCount = h2hGames.filter(g => (g[safeTab] ?? -1) >= t).length;
                  dvpMap[t] = { wCount, wPct: (wCount / wTotal) * 100 };
                });
              }
            }
          }
        }

        // Tonight plays for this player — keyed by "stat|threshold" for consistent truePct/Kalshi.
        // Uses allTonightPlays (unfiltered) so qualified:false plays (e.g. 3+/4+ strikeouts with no edge)
        // still provide their simulation-based truePct rather than falling back to the raw formula.
        const tonightPlayerMap = {};
        if (allTonightPlays && player) {
          for (const p of allTonightPlays) {
            if (p.playerId === player.id || p.playerName === player.name) {
              tonightPlayerMap[`${p.stat}|${p.threshold}`] = p;
            }
          }
        }
        // Fill in NBA opp_not_soft drops (have pace/minutes/B2B/SimScore data) without overwriting real plays
        if (nbaDropped && player) {
          for (const p of nbaDropped) {
            if (p.playerId === player.id || p.playerName === player.name) {
              const key = `${p.stat}|${p.threshold}`;
              if (!tonightPlayerMap[key]) tonightPlayerMap[key] = p;
            }
          }
        }
        const hasTonightData = Object.values(tonightPlayerMap).some(p => p.stat === safeTab);
        const showTriple = (hasDvp && (wTotal > 0 || (isMLB && totalGames25 >= 5))) || hasTonightData;
        // Fallback: if dvpData.h2h is missing (team not found in probables), use tonight play data
        if (isMLB && !mlbH2HOpp && safeTab === "strikeouts") {
          const anyStrikeoutsPlay = Object.values(tonightPlayerMap).find(p => p.stat === "strikeouts");
          if (anyStrikeoutsPlay?.opponent) mlbH2HOpp = anyStrikeoutsPlay.opponent;
        }
        // Explanation shows whenever dvp data is loaded — even for pitchers with 0 starts this season
        // Fallback opponent for non-MLB sports when no tonight's game
        const tonightOpp = Object.values(tonightPlayerMap).find(p => p.opponent)?.opponent ?? null;
        const lastPerGameOpp = !player.opponent && !tonightOpp && !isMLB && perGame.length > 0
          ? ([...perGame].reverse().find(g => g.oppAbbr)?.oppAbbr ?? null)
          : null;
        const effectiveOpp = player.opponent || tonightOpp || lastPerGameOpp;
        const isOppFallback = !player.opponent && !tonightOpp && !!lastPerGameOpp;
        const showExplanation = !loading && !error && (dvpData && (mlbH2HOpp || dvpData.position));
        // Tab-specific opponent rank from dvpData.rankMaps (NBA only)
        const tabRankEntry = (!isMLB && dvpData?.rankMaps?.[safeTab] && effectiveOpp)
          ? (dvpData.rankMaps[safeTab][effectiveOpp] || null)
          : null;
        const tabOppRank = tabRankEntry?.rank ?? player?.oppRank ?? null;
        const tabOppMetricValue = tabRankEntry?.value ?? player?.oppMetricValue ?? null;
        const tabOppMetricLabel = tabRankEntry?.label ?? player?.oppMetricLabel ?? null;

        return (
          <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,padding:"20px 22px"}}>
            {loading ? (
              <div style={{color:"#8b949e",textAlign:"center",padding:48,fontSize:13}}>⏳ Loading game log…</div>
            ) : error ? (
              <div style={{color:"#f78166",textAlign:"center",padding:48,fontSize:13}}>⚠️ {error}</div>
            ) : totalGames === 0 ? (
              <div style={{color:"#8b949e",textAlign:"center",padding:48,fontSize:13}}>No game data found.</div>
            ) : (
              <>
                {/* Explanation at top */}
                {showExplanation && (
                  <div style={{background:"#0d1117",borderRadius:8,padding:"8px 12px",fontSize:11,color:"#8b949e",lineHeight:1.6,marginBottom:12}}>
                    {(() => {
                      const first = player.name.split(" ")[0];
                      // For strikeout tab, prefer tonight play data (canonical source) over DVP endpoint to keep in sync with plays card
                      const h2h = (() => {
                        if (isMLB && safeTab === "strikeouts") {
                          const tp = Object.values(tonightPlayerMap).find(p => p.stat === "strikeouts");
                          if (tp) return { opp: tp.opponent, lineupKPct: tp.lineupKPct ?? dvpData?.h2h?.lineupKPct ?? null, lineupKPctProjected: tp.lineupKPctProjected ?? dvpData?.h2h?.lineupKPctProjected ?? false,
                            pitcherCSWPct: tp.pitcherCSWPct, pitcherKPct: tp.pitcherKPct, pitcherKBBPct: tp.pitcherKBBPct, pitcherAvgPitches: tp.pitcherAvgPitches, log5Avg: tp.log5Avg,
                            pitcherRecentKPct: tp.pitcherRecentKPct ?? null, pitcherSeasonKPct: tp.pitcherSeasonKPct ?? null,
                            expectedKs: tp.expectedKs, parkFactor: tp.parkFactor, pitcherHand: tp.pitcherHand,
                            pitcherEra: tp.pitcherEra ?? null,
                            simScore: tp.simScore ?? null, finalSimScore: tp.finalSimScore ?? null,
                            kpctMeets: tp.kpctMeets, kpctPts: tp.kpctPts, kbbMeets: tp.kbbMeets, kbbPts: tp.kbbPts, lkpMeets: tp.lkpMeets, lkpPts: tp.lkpPts, pitchesPts: tp.pitchesPts, parkMeets: tp.parkMeets, mlPts: tp.mlPts, totalPts: tp.totalPts, kTrendPts: tp.kTrendPts, blendedHitRatePts: tp.blendedHitRatePts,
                            edge: tp.edge, rawEdge: tp.rawEdge, spreadAdj: tp.spreadAdj,
                            gameTotal: tp.gameTotal, gameMoneyline: tp.gameMoneyline,
                            lineupConfirmed: tp.lineupConfirmed ?? null, gameTime: tp.gameTime ?? null };
                        }
                        return dvpData?.h2h || null;
                      })();
                      if (isMLB) {
                        if (safeTab === "strikeouts") {
                          const lkp   = h2h?.lineupKPct   ?? null;
                          const l5    = h2h?.log5Avg      ?? null;
                          const expK  = h2h?.expectedKs   ?? null;
                          const pf    = h2h?.parkFactor   ?? null;
                          const glK  = logs25?.strikeouts  || logs?.strikeouts  || [];
                          const glBB = logs25?.bb          || logs?.bb          || [];
                          const glIP = logs25?.ip          || logs?.ip          || [];
                          const glH  = logs25?.hitsAllowed || logs?.hitsAllowed || [];
                          const sumK  = glK.reduce((a,b)=>a+b,0);
                          const sumBB = glBB.reduce((a,b)=>a+b,0);
                          const sumIP = glIP.reduce((a,b)=>a+b,0);
                          const sumH  = glH.reduce((a,b)=>a+b,0);
                          const estBF = sumIP > 0 ? (sumIP * 3 + sumH + sumBB) : 0;
                          const csw = h2h?.pitcherCSWPct ?? null;
                          const pkpRaw = h2h?.pitcherKPct ?? (estBF >= 15 ? parseFloat((sumK / estBF * 100).toFixed(1)) : null);
                          const pkp = csw ?? pkpRaw;
                          const pkpLabel = csw != null ? "CSW%" : "K%";
                          const pkpColor  = pkp == null ? "#8b949e" : (csw != null ? (pkp >= 30 ? "#3fb950" : pkp > 26 ? "#e3b341" : "#f78166") : (pkp >= 27 ? "#3fb950" : pkp >= 24 ? "#e3b341" : "#f78166"));
                          const lkpProjected = h2h?.lineupKPctProjected === true;
                          const lkpColor  = lkp == null ? "#8b949e" : lkp > 24 ? "#3fb950" : lkp > 20 ? "#e3b341" : "#f78166";
                          const oppColor  = lkp != null ? (lkp >= 24 ? "#3fb950" : lkp < 20 ? "#f78166" : "#c9d1d9") : "#c9d1d9";
                          const strikeoutsThreshold = Object.entries(tonightPlayerMap).find(([k]) => k.startsWith("strikeouts|"))?.[1]?.threshold ?? null;
                          const expKColor = expK != null && strikeoutsThreshold != null ? (expK >= strikeoutsThreshold ? "#3fb950" : expK >= strikeoutsThreshold - 1 ? "#c9d1d9" : "#f78166") : "#c9d1d9";
                          const pitcherEra = h2h?.pitcherEra ?? null;
                          const eraColor = pitcherEra == null ? "#8b949e" : pitcherEra < 3.5 ? "#3fb950" : pitcherEra < 4.5 ? "#8b949e" : "#f78166";
                          const simScore = h2h?.simScore ?? null;
                          const finalSimScore = h2h?.finalSimScore ?? null;
                          const gameTotal = h2h?.gameTotal ?? null;
                          const gameML = h2h?.gameMoneyline ?? null;
                          const pitcherHand = h2h?.pitcherHand ?? null;
                          const handLabel = pitcherHand === "R" ? " against RHP" : pitcherHand === "L" ? " against LHP" : "";
                          const totalColor = t => t == null ? "#8b949e" : t <= 7.5 ? "#3fb950" : t < 10.5 ? "#e3b341" : "#f78166";
                          const mlColor = ml => ml == null ? "#8b949e" : ml <= -121 ? "#3fb950" : ml <= 120 ? "#e3b341" : "#f78166";
                          const oppName = MLB_TEAM[h2h?.opp || mlbH2HOpp] || h2h?.opp || mlbH2HOpp;
                          const pitcherTeamName = MLB_TEAM[player.team] || player.team;
                          const kbb = h2h?.pitcherKBBPct ?? null;
                          const ap = h2h?.pitcherAvgPitches ?? null;
                          const recK = h2h?.pitcherRecentKPct ?? null;
                          const seaK = h2h?.pitcherSeasonKPct ?? null;
                          const kbbColor = kbb == null ? "#8b949e" : kbb > 18 ? "#3fb950" : kbb > 12 ? "#e3b341" : "#f78166";
                          const apColor = ap == null ? "#8b949e" : ap > 85 ? "#3fb950" : ap > 75 ? "#e3b341" : "#f78166";
                          const pkpQual = pkp == null ? "" : csw != null ? (pkp >= 30 ? "elite" : pkp > 26 ? "above-average" : "below-average") : (pkp > 24 ? "above-average" : "below-average");
                          const apDesc = ap == null ? null : ap > 85 ? "expect him to work deep into the game" : ap > 75 ? "typically goes 5–6 innings" : null;
                          const lkpDesc = lkp == null ? null : lkp > 24 ? "a high-strikeout lineup — works in his favor" : lkp > 20 ? "below-average strikeout tendency" : "elite contact lineup — a tougher test";
                          const _sc = finalSimScore ?? simScore;
                          const scColor = _sc == null ? "#8b949e" : _sc >= 8 ? "#3fb950" : _sc >= 5 ? "#e3b341" : "#8b949e";
                          const scTitle = _sc != null ? [`CSW%/K%: ${h2h?.kpctPts ?? 1}/2`,`K-BB%: ${h2h?.kbbPts ?? 1}/2`,`Lineup K%: ${h2h?.lkpPts ?? 1}/2`,`Hit Rate: ${h2h?.blendedHitRatePts ?? 1}/2`,`O/U: ${h2h?.totalPts ?? 1}/2`].join("\n") : null;
                          const _lcSK = h2h?.lineupConfirmed ?? null;
                          const _gtSK = h2h?.gameTime ?? null;
                          const _gameImminent = _gtSK && Date.now() >= new Date(_gtSK).getTime() - 30*60*1000;
                          const lineupBadgeSK = _lcSK === true
                            ? <span title="Official lineup posted" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(63,185,80,0.12)",border:"1px solid #3fb950",color:"#3fb950",verticalAlign:"middle"}}>✓ Lineup</span>
                            : _lcSK === false && !_gameImminent
                              ? <span title="Projected lineup — not yet official" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(139,148,158,0.12)",border:"1px solid #484f58",color:"#8b949e",verticalAlign:"middle"}}>Proj. Lineup</span>
                              : null;
                          return (
                            <>
                              <div>
                                {first} has {pkpQual ? <>{pkpQual} </> : ""}swing-and-miss stuff
                                {pkp != null && <> — <span style={{color:pkpColor,fontWeight:600}}>{pkp}%</span> {pkpLabel}</>}
                                {kbb != null && <>, <span style={{color:kbbColor,fontWeight:600}}>{kbb.toFixed(1)}%</span> K-BB% <span style={{color:"#8b949e"}}>(strikeouts vs walks)</span></>}
                                {ap != null && <>, averaging <span style={{color:apColor,fontWeight:600}}>{Math.round(ap)}</span> pitches/start{apDesc ? <span style={{color:"#8b949e"}}> — {apDesc}</span> : ""}</>}.
                                {lkp != null && <>{" "}The {oppName} lineup strikes out at <span style={{color:lkpColor,fontWeight:600}}>{lkp}%</span>{handLabel}{lkpProjected ? <span style={{color:"#484f58",fontSize:10}}> (est.)</span> : ""} — <span style={{color:"#8b949e"}}>{lkpDesc}</span>.</>}
                                {pf != null && Math.abs(pf - 1.0) >= 0.01 && <>{" "}Tonight's venue {pf > 1 ? "is strikeout-friendly" : "suppresses strikeouts"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}%</span>).</>}
                                {(recK != null || gameTotal != null) && <>{" "}{recK != null && <><span style={{color:h2h?.kTrendPts===2?"#3fb950":h2h?.kTrendPts===0?"#f78166":"#e3b341",fontWeight:600}}>{recK.toFixed(1)}%</span><span style={{color:"#8b949e"}}> recent K%{h2h?.kTrendPts===2?" ↑":h2h?.kTrendPts===0?" ↓":""}{seaK!=null?` (${seaK.toFixed(1)}% season)`:""}</span>{gameTotal != null ? <span style={{color:"#8b949e"}}>, </span> : <span style={{color:"#8b949e"}}>.</span>}</>}{gameTotal != null && <><span style={{color:"#8b949e"}}>game total </span><span style={{color:totalColor(gameTotal),fontWeight:600}}>{gameTotal}</span><span style={{color:"#8b949e"}}>{gameTotal <= 8.5 ? " — a low-scoring slate, favorable for strikeouts" : gameTotal <= 10.5 ? " — an average total" : " — a high-scoring total, tougher for Ks"}.</span></>}</>}
                                {_sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{_sc}/10 {_sc>=8?"Alpha":"Mid"}</span></>}
                                {lineupBadgeSK && <>{" "}{lineupBadgeSK}</>}
                              </div>
                            </>
                          );
                        }
                        {
                          const tonightHitPlay = Object.values(tonightPlayerMap).find(p => p.stat === safeTab) || null;
                          const baVal = tonightHitPlay?.hitterBa ? `.${Math.round(tonightHitPlay.hitterBa * 1000).toString().padStart(3,"0")}` : null;
                          const baTier = tonightHitPlay?.hitterBaTier;
                          const baTierLabel = baTier === "elite" ? "elite" : baTier === "good" ? "good" : baTier === "avg" ? "average" : null;
                          const baColor = baTier === "elite" ? "#58a6ff" : baTier === "good" ? "#3fb950" : "#8b949e";
                          const lineupSpot = tonightHitPlay?.hitterLineupSpot ?? null;
                          const spotColor = lineupSpot == null ? "#8b949e" : lineupSpot <= 3 ? "#3fb950" : lineupSpot <= 4 ? "#e3b341" : "#8b949e";
                          const pitcherName = tonightHitPlay?.hitterPitcherName ?? h2h?.pitcherName ?? null;
                          const whip = tonightHitPlay?.pitcherWHIP ?? null;
                          const fip = tonightHitPlay?.pitcherFIP ?? null;
                          const era = tonightHitPlay?.hitterPitcherEra ?? tonightHitPlay?.pitcherEra ?? h2h?.pitcherEra ?? null;
                          const pf = tonightHitPlay?.parkFactor ?? tonightHitPlay?.hitterParkKF ?? null;
                          const seasonPct = tonightHitPlay?.seasonPct ?? null;
                          const softPct = tonightHitPlay?.softPct ?? null;
                          const seasonG = tonightHitPlay?.pct26 != null ? tonightHitPlay?.pct26Games : (tonightHitPlay?.blendGames || tonightHitPlay?.seasonGames);
                          const seasonWindow = tonightHitPlay?.pct26 != null ? "this season" : "2025-26";
                          const threshold = tonightHitPlay?.threshold ?? null;
                          const statFull = STAT_FULL[safeTab] || safeTab;
                          const sc = tonightHitPlay?.hitterFinalSimScore ?? tonightHitPlay?.hitterSimScore ?? null;
                          const whipColor = whip == null ? "#8b949e" : whip > 1.35 ? "#3fb950" : whip > 1.20 ? "#e3b341" : "#f78166";
                          const fipColor = fip == null ? "#8b949e" : fip > 4.5 ? "#3fb950" : fip > 3.5 ? "#e3b341" : "#8b949e";
                          const scColor = sc != null ? (sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e") : "#8b949e";
                          const seasonColor = seasonPct == null ? "#c9d1d9" : seasonPct >= 75 ? "#3fb950" : seasonPct >= 60 ? "#c9d1d9" : "#f78166";
                          const spotDesc = lineupSpot == null ? null : lineupSpot <= 3 ? "top of the order — guaranteed at-bats every game" : lineupSpot <= 4 ? "heart of the order — plenty of at-bats" : null;
                          const whipDesc = whip == null ? null : whip > 1.35 ? "a lot of baserunners" : whip > 1.20 ? "some traffic on base" : null;
                          const fipDesc = fip == null ? null : fip > 4.5 ? "hittable pitcher" : fip > 3.5 ? "average pitcher" : null;
                          const mkH = (meets, label) => meets != null ? <span key={label} style={{color:meets?"#3fb950":"#f78166",fontSize:9,whiteSpace:"nowrap"}}>{meets?"✓":"✗"}{label}</span> : null;
                          const hitterGameTotal = tonightHitPlay?.hitterGameTotal ?? null;
                          const hitterTotalColor = t => t == null ? "#8b949e" : t >= 9.5 ? "#3fb950" : t >= 7.5 ? "#e3b341" : "#f78166";
                          const barrelPct = tonightHitPlay?.hitterBarrelPct ?? null;
                          const barrelColor = barrelPct == null ? "#8b949e" : barrelPct >= 14 ? "#3fb950" : barrelPct >= 10 ? "#e3b341" : barrelPct >= 7 ? "#8b949e" : "#f78166";
                          const platoonPts = tonightHitPlay?.hitterPlatoonPts ?? null;
                          const pitcherHand = tonightHitPlay?.oppPitcherHand ?? null;
                          const scTitle = sc != null ? [`Quality: ${tonightHitPlay?.hitterBatterQualityPts ?? 1}/2`,`WHIP: ${tonightHitPlay?.hitterWhipPts ?? 1}/2`,`Season HR: ${tonightHitPlay?.hitterSeasonHitRatePts ?? 1}/2`,`H2H HR: ${tonightHitPlay?.hitterH2HHitRatePts ?? 1}/2`,`O/U: ${tonightHitPlay?.hitterTotalPts ?? 1}/2`].join("\n") : null;
                          return (
                            <>
                              <div>
                                {first}{lineupSpot != null && <>, batting <span style={{color:spotColor,fontWeight:600}}>#{lineupSpot}</span>{spotDesc ? <span style={{color:"#8b949e"}}> — {spotDesc}</span> : ""}</>}.
                                {(pitcherName || whip != null) && (
                                  <>{" "}Facing{pitcherName ? <> <span style={{color:"#c9d1d9",fontWeight:600}}>{pitcherName}</span></> : " the opposing starter"}{whip != null ? <> — WHIP <span style={{color:whipColor,fontWeight:600}}>{whip}</span>{whipDesc ? <span style={{color:"#8b949e"}}> ({whipDesc})</span> : ""}</> : ""}.</>
                                )}
                                {seasonPct != null && <>{" "}{first} has gone {threshold}+ {statFull} in <span style={{color:seasonColor,fontWeight:600}}>{seasonPct}%</span> of games {seasonWindow}{seasonG ? <span style={{color:"#484f58",fontSize:10}}> ({seasonG}g)</span> : ""}</>}
                                {softPct != null ? <>, and <span style={{color:"#3fb950",fontWeight:600}}>{softPct}%</span> {tonightHitPlay?.hitterSoftLabel ?? "against weak pitching matchups"}{tonightHitPlay?.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({tonightHitPlay.softGames}g)</span> : ""}.</> : seasonPct != null ? "." : ""}
                                {tonightHitPlay?.oppRank && softPct === null && (() => {
                                  const _opp2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{tonightHitPlay.opponent}</span>;
                                  const _rank2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{ordinal(tonightHitPlay.oppRank)}-worst</span>;
                                  const _metricStr2 = tonightHitPlay.oppMetricValue ? ` (${tonightHitPlay.oppMetricValue} ${tonightHitPlay.oppMetricUnit || ""})` : "";
                                  const _ctx2 = {"mlb|hits":"one of the easiest pitching matchups in the league — their staff has a high ERA this season","mlb|hrr":"one of the easiest pitching matchups in the league — their staff allows hits, runs, and RBIs at a high rate"}[`mlb|${safeTab}`] || "one of the weakest defenses for this stat";
                                  return <>{" "}{_opp2} ranks {_rank2} in {tonightHitPlay.oppMetricLabel || "this stat"}{_metricStr2} this season — {_ctx2}.{<>{" "}No head-to-head history yet{tonightHitPlay.pct25 != null && tonightHitPlay.pct25Games >= 5 ? <> — was at <span style={{color:"#c9d1d9"}}>{tonightHitPlay.pct25}%</span> in {tonightHitPlay.pct25Games} games in 2025</> : ""}.</>}</>;
                                })()}
                                {pf != null && Math.abs(pf - 1.0) >= 0.03 && <>{" "}Tonight's venue is {pf > 1 ? "hitter-friendly" : "pitcher-friendly"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}% park factor</span>).</>}
                                {hitterGameTotal != null && <>{" "}<span style={{color:"#8b949e"}}>Game total </span><span style={{color:hitterTotalColor(hitterGameTotal),fontWeight:600}}>{hitterGameTotal}</span><span style={{color:"#8b949e"}}>{hitterGameTotal >= 9.5 ? " — a high-scoring game, favorable for hitting" : hitterGameTotal >= 7.5 ? " — an average total" : " — a low-scoring game, tougher for hitters"}.</span></>}
                                {barrelPct != null && <>{" "}<span style={{color:"#8b949e"}}>Barrel rate </span><span style={{color:barrelColor,fontWeight:600}}>{barrelPct.toFixed(1)}%</span><span style={{color:"#484f58"}}>{barrelPct >= 14 ? " — elite hard contact" : barrelPct >= 10 ? " — strong contact quality" : barrelPct >= 7 ? " — average contact" : " — below-average contact"}.</span></>}
                                {platoonPts === 2 && pitcherHand && (() => { const splitBA = tonightHitPlay?.hitterSplitBA; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#3fb950",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon edge.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon edge vs {handStr}.</span></>; })()}
                                {platoonPts === 0 && pitcherHand && (() => { const splitBA = tonightHitPlay?.hitterSplitBA; const seasonBA = tonightHitPlay?.hitterBa; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#f78166",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon disadvantage{seasonBA != null ? <> (<span style={{color:"#c9d1d9"}}>.{Math.round(seasonBA*1000).toString().padStart(3,"0")}</span> season)</> : ""}.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon disadvantage vs {handStr}.</span></>; })()}
                                {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                                {(() => { const _lc = tonightHitPlay?.lineupConfirmed ?? null; const _gt = tonightHitPlay?.gameTime ?? null; const _imm = _gt && Date.now() >= new Date(_gt).getTime() - 30*60*1000; return _lc === true ? <>{" "}<span title="Official lineup posted" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(63,185,80,0.12)",border:"1px solid #3fb950",color:"#3fb950",verticalAlign:"middle"}}>✓ Lineup</span></> : _lc === false && !_imm ? <>{" "}<span title="Projected lineup — not yet official" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(139,148,158,0.12)",border:"1px solid #484f58",color:"#8b949e",verticalAlign:"middle"}}>Proj. Lineup</span></> : null; })()}
                              </div>
                            </>
                          );
                        }
                      }
                      if (dvpData?.position) {
                        const opp = player.opponent;
                        const statLabel = {points:"scoring",rebounds:"rebounding",assists:"playmaking",threePointers:"3-point shooting",goals:"scoring",shotsOnGoal:"shots on goal"}[safeTab]||safeTab;
                        const rank = tabOppRank;
                        const metricVal = tabOppMetricValue;
                        const metricUnit = tabRankEntry?.unit ?? player?.oppMetricUnit;
                        const tonightTabPlay = Object.values(tonightPlayerMap).find(p => p.stat === safeTab) || null;
                        const proj = tonightTabPlay?.projectedStat ?? player.projectedStat ?? null;
                        const recent = tonightTabPlay?.recentAvg ?? player.recentAvg ?? null;
                        const dvpFactor = tonightTabPlay?.dvpFactor ?? player.dvpFactor ?? null;
                        const tabTonightPlay = tonightPlayerMap[`${safeTab}|${player.playThreshold}`] || tonightTabPlay;
                        const softPctDisplay = tabTonightPlay?.softPct ?? (dvpMap[player.playThreshold]?.wPct ?? null);
                        const softGamesDisplay = tabTonightPlay?.softGames ?? wTotal;
                        const thresholdDisplay = tabTonightPlay?.threshold ?? player.playThreshold;
                        if (effectiveOpp && rank != null) {
                          const opp = effectiveOpp;
                          const metricStr = metricVal != null ? ` (${metricVal}${metricUnit ? " "+metricUnit : ""})` : "";
                          const oppEl = <span style={{color:"#c9d1d9",fontWeight:600}}>{opp}</span>;
                          const rankEl = <span style={{color:"#f78166",fontWeight:700}}>{ordinal(rank)}-worst</span>;
                          const hitRate = softPctDisplay != null ? <span style={{color:"#3fb950",fontWeight:600}}>{softPctDisplay.toFixed ? softPctDisplay.toFixed(1) : softPctDisplay}%</span> : null;
                          const games = softGamesDisplay ? ` (${softGamesDisplay} games)` : "";
                          const isNBA = sport === "basketball/nba";
                          const isNHL = sport === "hockey/nhl";
                          if (isNBA) {
                            const posGroup = tonightTabPlay?.posGroup ?? null;
                            const posName = {PG:"point guard",SG:"shooting guard",SF:"small forward",PF:"power forward",C:"center"}[posGroup] ?? null;
                            const hasPosDvp = tonightTabPlay?.posDvpRank != null;
                            const displayRank = hasPosDvp ? tonightTabPlay.posDvpRank : rank;
                            const displayValue = hasPosDvp ? tonightTabPlay.posDvpValue : null;
                            const statName = { points:"points", rebounds:"rebounds", assists:"assists", threePointers:"3-pointers" }[safeTab] || safeTab;
                            const seasonPct = tonightTabPlay?.seasonPct ?? null;
                            const nbaOpportunity = tonightTabPlay?.nbaOpportunity ?? null;
                            const nbaPaceAdj = tonightTabPlay?.nbaPaceAdj ?? null;
                            const isB2B = tonightTabPlay?.isB2B ?? null;
                            const sc = tonightTabPlay?.nbaSimScore ?? null;
                            const edge = tonightTabPlay?.edge ?? null;
                            const spreadAdj = tonightTabPlay?.spreadAdj ?? 0;
                            const rawEdge = tonightTabPlay?.rawEdge ?? edge;
                            const isNBAStrong = tonightTabPlay?.softPct != null;
                            const isNBAHard = !isNBAStrong && effectiveOpp && (dvpData.hardTeams?.[safeTab] || []).includes(effectiveOpp);
                            const rankColor = isNBAHard ? "#f78166" : (displayRank != null && displayRank <= 10) ? "#3fb950" : (displayRank != null && displayRank <= 15) ? "#e3b341" : isNBAStrong ? "#3fb950" : "#c9d1d9";
                            const scColor = sc != null ? (sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e") : "#8b949e";
                            const seasonColor = seasonPct == null ? "#c9d1d9" : seasonPct >= 75 ? "#3fb950" : seasonPct >= 60 ? "#c9d1d9" : "#f78166";
                            const minColor = nbaOpportunity == null ? "#8b949e" : nbaOpportunity >= 30 ? "#3fb950" : nbaOpportunity >= 25 ? "#e3b341" : "#f78166";
                            const paceColor = nbaPaceAdj == null ? "#8b949e" : nbaPaceAdj > 0 ? "#3fb950" : nbaPaceAdj > -2 ? "#e3b341" : "#f78166";
                            const minDesc = nbaOpportunity == null ? null : nbaOpportunity >= 33 ? "a featured starter with a big role" : nbaOpportunity >= 30 ? "a key starter" : nbaOpportunity >= 25 ? "solid rotation player" : "limited role";
                            const paceDesc = nbaPaceAdj == null ? null : nbaPaceAdj > 2 ? "a fast game — more possessions, more opportunities to score" : nbaPaceAdj > 0 ? "slightly above-average pace" : nbaPaceAdj > -2 ? "slightly slower pace" : "a slow game — fewer scoring opportunities";
                            const rankDesc = displayRank == null ? null : displayRank <= 3 ? "one of the worst defenses in the league" : displayRank <= 8 ? "a weak defense" : displayRank <= 15 ? "a soft matchup" : null;
                            const nbaGameTotal = tonightTabPlay?.nbaGameTotal ?? null;
                            const nbaTotalPts = tonightTabPlay?.nbaTotalPts ?? null;
                            const nbaUsage = tonightTabPlay?.nbaUsage ?? null;
                            const nbaAvgAst = tonightTabPlay?.nbaAvgAst ?? null;
                            const nbaAvgReb = tonightTabPlay?.nbaAvgReb ?? null;
                            const nba3pMPG = tonightTabPlay?.nba3pMPG ?? null;
                            const nbaBlowoutAdj = tonightTabPlay?.nbaBlowoutAdj ?? null;
                            const _usgPts = safeTab === "rebounds"
                              ? (nbaOpportunity == null ? 1 : nbaOpportunity >= 30 ? 2 : nbaOpportunity >= 25 ? 1 : 0)
                              : (nbaUsage == null ? 1 : nbaUsage >= 28 ? 2 : nbaUsage >= 22 ? 1 : 0);
                            const _c1Label = safeTab === "rebounds"
                              ? `AvgMin: ${nbaOpportunity != null ? nbaOpportunity.toFixed(0)+"m → "+_usgPts : "—"}/2`
                              : `USG%: ${nbaUsage != null ? nbaUsage.toFixed(1)+"% → "+_usgPts : "—"}/2`;
                            const _dvpPts = tonightTabPlay?.posDvpRank != null ? (tonightTabPlay.posDvpRank <= 10 ? 2 : tonightTabPlay.posDvpRank <= 15 ? 1 : 0) : 1;
                            const _nbaSeasonHRPts = tonightTabPlay?.nbaSeasonHitRatePts ?? (seasonPct >= 90 ? 2 : seasonPct >= 80 ? 1 : 0);
                            const _nbaSoftHRPts = tonightTabPlay?.nbaSoftHitRatePts ?? (tonightTabPlay?.softPct == null ? 1 : tonightTabPlay.softPct >= 90 ? 2 : tonightTabPlay.softPct >= 80 ? 1 : 0);
                            const _paceGood = nbaPaceAdj != null && nbaPaceAdj > 0;
                            const _totalGood = nbaGameTotal != null && nbaGameTotal >= 225;
                            const _comboPts = (_paceGood && _totalGood) ? 2 : (_paceGood || _totalGood) ? 1 : 0;
                            const scTitle = sc != null ? [_c1Label,`DVP: ${_dvpPts}/2`,`Season HR: ${_nbaSeasonHRPts}/2`,`Soft HR: ${_nbaSoftHRPts}/2`,`Pace+Total: ${_comboPts}/2`].join("\n") : null;
                            return (
                              <>
                                <div>
                                  {seasonPct != null
                                    ? <>{first} hits this line in <span style={{color:seasonColor,fontWeight:600}}>{seasonPct}%</span> of games{tonightTabPlay?.seasonGames ? <span style={{color:"#484f58",fontSize:10}}> ({tonightTabPlay.seasonGames}g)</span> : ""}</>
                                    : <>{first}</>
                                  }
                                  {nbaOpportunity != null ? <>, averaging <span style={{color:minColor,fontWeight:600}}>{nbaOpportunity.toFixed(0)} minutes</span> a night{minDesc ? <span style={{color:"#8b949e"}}> — {minDesc}</span> : ""}</> : ""}
                                  {safeTab === "assists" && nbaAvgAst != null ? <> (<span style={{color:nbaAvgAst>=7?"#3fb950":nbaAvgAst>=5?"#e3b341":"#f78166",fontWeight:600}}>{nbaAvgAst.toFixed(1)} APG</span>)</> : safeTab === "rebounds" && nbaAvgReb != null ? <> (<span style={{color:nbaAvgReb>=9?"#3fb950":nbaAvgReb>=7?"#e3b341":"#f78166",fontWeight:600}}>{nbaAvgReb.toFixed(1)} RPG</span>)</> : nbaUsage != null ? <> (<span style={{color:nbaUsage>=28?"#3fb950":nbaUsage>=22?"#e3b341":"#f78166",fontWeight:600}}>{nbaUsage.toFixed(0)}% USG</span>)</> : ""}.
                                  {displayRank != null && <>{" "}{effectiveOpp} has {rankDesc || `the ${ordinal(displayRank)}-worst defense`} in {statName} allowed{posName ? ` to ${posName}s` : ""}{displayValue != null ? <> — giving up <span style={{color:rankColor,fontWeight:600}}>{displayValue} per game</span></> : <>, ranked <span style={{color:rankColor,fontWeight:700}}>{ordinal(displayRank)}</span></>}.</>}
                                  {softPctDisplay != null && <>{" "}{first} hits this in <span style={{color:softPctDisplay>=70?"#3fb950":softPctDisplay>=60?"#e3b341":"#f78166",fontWeight:600}}>{softPctDisplay}%</span> of games against soft defenses{softGamesDisplay ? <span style={{color:"#484f58",fontSize:10}}> ({softGamesDisplay}g)</span> : ""}.</>}
                                  {nbaPaceAdj != null && <>{" "}Game pace is <span style={{color:paceColor,fontWeight:600}}>{nbaPaceAdj > 0 ? "+" : ""}{nbaPaceAdj}</span> possessions above average — {paceDesc}.</>}
                                  {nbaGameTotal != null && <>{" "}Game total <span style={{color:nbaTotalPts>=3?"#3fb950":nbaTotalPts>=2?"#e3b341":nbaTotalPts>=1?"#8b949e":"#f78166",fontWeight:600}}>{nbaGameTotal}</span><span style={{color:"#8b949e"}}>{nbaGameTotal>=235?" — a high-scoring slate":nbaGameTotal>=225?" — above-average scoring":nbaGameTotal>=215?" — an average total":" — a low-scoring slate"}.</span></>}
                                  {nbaBlowoutAdj != null && nbaBlowoutAdj < 0.99 && <>{" "}<span style={{color:"#f78166",fontWeight:600}}>Blowout risk</span> — large spread reduces model mean by {Math.round((1-nbaBlowoutAdj)*100)}%.</>}
                                  {isB2B != null && <>{" "}{isB2B ? <><span style={{color:"#f78166",fontWeight:600}}>Back-to-back</span> — model applies a scoring reduction.</> : <>Fully rested tonight.</>}</>}
                                  {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                                  {isOppFallback && <div style={{color:"#484f58",fontSize:10,marginTop:3}}>Showing last game vs {effectiveOpp} — updates when next game is scheduled.</div>}
                                </div>
                              </>
                            );
                          }
                          if (isNHL) {
                            const nhlOpportunity = tonightTabPlay?.nhlOpportunity ?? null;
                            const nhlShotsAdj = tonightTabPlay?.nhlShotsAdj ?? null;
                            const nhlIsB2B = tonightTabPlay?.isB2B ?? null;
                            const sc = tonightTabPlay?.nhlSimScore ?? null;
                            const edge = tonightTabPlay?.edge ?? null;
                            const spreadAdj = tonightTabPlay?.spreadAdj ?? 0;
                            const rawEdge = tonightTabPlay?.rawEdge ?? edge;
                            const seasonPct = tonightTabPlay?.seasonPct ?? null;
                            const scColor = sc != null ? (sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e") : "#8b949e";
                            const seasonColor = seasonPct == null ? "#c9d1d9" : seasonPct >= 75 ? "#3fb950" : seasonPct >= 60 ? "#c9d1d9" : "#f78166";
                            const toiColor = nhlOpportunity == null ? "#8b949e" : nhlOpportunity >= 18 ? "#3fb950" : nhlOpportunity >= 15 ? "#e3b341" : "#f78166";
                            const nhlSaRank = tonightTabPlay?.nhlSaRank ?? null;
                            const saColor = nhlShotsAdj == null ? "#8b949e" : (nhlSaRank != null && nhlSaRank <= 10) ? "#3fb950" : nhlShotsAdj > 0 ? "#e3b341" : "#f78166";
                            const rankColor = rank != null && rank <= 5 ? "#3fb950" : "#e3b341";
                            const toiDesc = nhlOpportunity == null ? null : nhlOpportunity >= 21 ? "a top-line role" : nhlOpportunity >= 18 ? "a key contributor" : nhlOpportunity >= 15 ? "solid ice time" : "limited role";
                            const rankDesc = rank == null ? null : rank <= 3 ? "one of the worst defenses in the league" : rank <= 8 ? "a weak defense" : rank <= 15 ? "a soft matchup" : null;
                            const saDesc = nhlShotsAdj == null ? null : nhlShotsAdj > 2 ? "generating high shot volume — more scoring chances" : nhlShotsAdj > 0 ? "above-average shot volume" : nhlShotsAdj > -2 ? "slightly below average" : "low shot volume allowed";
                            const _nhlToiPts = nhlOpportunity != null && nhlOpportunity >= 18 ? 2 : nhlOpportunity != null && nhlOpportunity >= 15 ? 1 : 0;
                            const _nhlGaaPts = rank != null ? (rank <= 10 ? 2 : rank <= 15 ? 1 : 0) : 1;
                            const nhlGameTotalPC = tonightTabPlay?.nhlGameTotal ?? null;
                            const _nhlTotalPts = nhlGameTotalPC == null ? 1 : nhlGameTotalPC >= 7 ? 2 : nhlGameTotalPC >= 5.5 ? 1 : 0;
                            const _nhlSeasonHRPts = tonightTabPlay?.nhlSeasonHitRatePts ?? (seasonPct == null ? 1 : seasonPct >= 90 ? 2 : seasonPct >= 80 ? 1 : 0);
                            const _nhlDvpHRPts = tonightTabPlay?.nhlDvpHitRatePts ?? 1;
                            const scTitle = sc != null ? [`TOI ${nhlOpportunity != null ? nhlOpportunity.toFixed(0) + "m" : "—"}: ${_nhlToiPts}/2`, `GAA rank: ${_nhlGaaPts}/2`, `Season HR: ${_nhlSeasonHRPts}/2`, `DVP HR: ${_nhlDvpHRPts}/2`, `O/U ${nhlGameTotalPC ?? "—"}: ${_nhlTotalPts}/2`].join("\n") : null;
                            return (
                              <>
                                <div>
                                  {seasonPct != null
                                    ? <>{first} hits this line in <span style={{color:seasonColor,fontWeight:600}}>{seasonPct}%</span> of games{tonightTabPlay?.seasonGames ? <span style={{color:"#484f58",fontSize:10}}> ({tonightTabPlay.seasonGames}g)</span> : ""}</>
                                    : <>{first}</>
                                  }
                                  {nhlOpportunity != null ? <>, averaging <span style={{color:toiColor,fontWeight:600}}>{nhlOpportunity.toFixed(0)} min</span> of ice time{toiDesc ? <span style={{color:"#8b949e"}}> — {toiDesc}</span> : ""}</> : ""}.
                                  {rank != null && <>{" "}{effectiveOpp} has {rankDesc || `the ${ordinal(rank)}-worst defense`} in points allowed — ranked <span style={{color:rankColor,fontWeight:700}}>{ordinal(rank)}</span> in goals against.</>}
                                  {nhlShotsAdj != null && <>{" "}They allow <span style={{color:saColor,fontWeight:600}}>{nhlShotsAdj > 0 ? "+" : ""}{nhlShotsAdj}</span> shots/game above average — {saDesc}.</>}
                                  {softPctDisplay != null && <>{" "}{first} hits this in <span style={{color:"#3fb950",fontWeight:600}}>{softPctDisplay}%</span> vs weak defenses{softGamesDisplay ? <span style={{color:"#484f58",fontSize:10}}> ({softGamesDisplay}g)</span> : ""}.</>}
                                  {nhlIsB2B != null && <>{" "}{nhlIsB2B ? <><span style={{color:"#f78166",fontWeight:600}}>Back-to-back</span> — model applies a fatigue reduction.</> : <>Fully rested tonight.</>}</>}
                                  {isOppFallback && <div style={{color:"#484f58",fontSize:10,marginTop:3}}>Showing last game vs {effectiveOpp} — updates when next game is scheduled.</div>}
                                  {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                                </div>
                              </>
                            );
                          }
                          return <>
                            {first} {isOppFallback ? "last faced" : "faces"} {oppEl} {isOppFallback ? "" : "tonight "}— they rank <span style={{color:"#f78166",fontWeight:600}}>#{rank}</span> in {statLabel} allowed{metricStr}, giving up {rank === 1 ? "the most" : rank <= 5 ? "among the most" : "a lot of"} in the league.
                            {isOppFallback && <div style={{color:"#484f58",fontSize:10,marginTop:3}}>Showing last game vs {opp} — updates when next game is scheduled.</div>}
                          </>;
                        }
                        if (wTotal > 0) {
                          const softNames = weakTeamList.slice(0,4).map(t=>t.abbr).join(", ");
                          return <>As a <span style={{color:"#58a6ff",fontWeight:600}}>{dvpData.position}</span>, {first} has {wTotal} game{wTotal>1?"s":""} vs weak {statLabel} defenses{softNames?<> ({softNames})</>:<>.</>} — position-specific matchup data used.</>;
                        }
                        return <>Position-specific DvP loaded for <span style={{color:"#58a6ff",fontWeight:600}}>{dvpData.position}</span> — identifies weak {statLabel} defenses for tonight's matchup.</>;
                      }
                      return null;
                    })()}
                  </div>
                )}

                {showTriple && !isMLB && (
                  <div style={{color:"#484f58",fontSize:11,marginBottom:14}}>
                    Soft matchup teams ({wTotal}/{totalGames}g): {weakTeamList.map(t => t.abbr).join(" · ")}
                  </div>
                )}

                {/* Threshold rows — filter to Kalshi thresholds when available */}
                {(() => {
                  const hasKalshi = Object.keys(kalshiOdds).length > 0;
                  const displayRates = hasKalshi ? rates.filter(({t}) => kalshiOdds[t]) : rates;
                  // Pre-compute raw truePct per threshold, then enforce monotonicity (lower threshold >= higher)
                  const _rawTruePctMap = {};
                  for (const {t, pct: pctOver} of displayRates) {
                    const _tp = tonightPlayerMap[`${safeTab}|${t}`];
                    const _pct = pctOver;
                    const _dvp = dvpMap[t];
                    const _softPctRaw = isMLB ? (_dvp?.wPct ?? null) : (_tp?.softPct != null ? _tp.softPct : (_dvp?.wPct ?? null));
                    const _truePctRaw = (_tp && _tp.truePct != null) ? _tp.truePct : (_softPctRaw !== null ? (_pct + _softPctRaw) / 2 : null);
                    _rawTruePctMap[t] = _truePctRaw;
                  }
                  // Enforce monotonicity: walk highest→lowest threshold, raise any value that dips
                  // below the max seen so far (P(X>=3) must be >= P(X>=4) >= P(X>=5) etc.)
                  { const _mts = Object.keys(_rawTruePctMap).map(Number).filter(t => _rawTruePctMap[t] != null).sort((a,b) => b-a);
                    let _mx = 0;
                    for (const _t of _mts) { if (_rawTruePctMap[_t] < _mx) _rawTruePctMap[_t] = _mx; else _mx = _rawTruePctMap[_t]; } }
                  return displayRates.map(({t, count: countOver, pct: pctOver}) => {
                    const isUnder = direction === "under";
                    // Flip all hit-rate values for "under" direction
                    const count = isUnder ? (totalGames - countOver) : countOver;
                    const pct   = isUnder ? 100 - pctOver : pctOver;
                    const dvp = dvpMap[t];
                    // Use exact threshold's tonight play — never cross-contaminate softPct from a different threshold
                    const tonightPlay = tonightPlayerMap[`${safeTab}|${t}`];
                    // MLB: always use dvpMap h2h rate for consistency across all thresholds
                    // Non-MLB: prefer tonight play's pre-computed soft rate, fall back to dvpMap
                    const softPctRaw = isMLB
                      ? (dvp?.wPct ?? null)
                      : (tonightPlay?.softPct != null ? tonightPlay.softPct : (dvp?.wPct ?? null));
                    const _lkpBucketLabel = (() => {
                      if (!isMLB || safeTab !== "strikeouts") return null;
                      const lkp = dvpData?.h2h?.lineupKPct ?? Object.values(tonightPlayerMap).find(p => p.stat === "strikeouts")?.lineupKPct ?? null;
                      if (lkp == null) return null;
                      return lkp >= 24 ? "high" : lkp >= 20 ? "avg" : "low";
                    })();
                    const _pitcherHandLabel = (() => {
                      const hand = dvpData?.h2h?.pitcherHand ?? null;
                      return hand === "R" ? " vs RHP" : hand === "L" ? " vs LHP" : "";
                    })();
                    const softGamesLabel = isMLB
                      ? (_lkpBucketLabel
                          ? (dvp ? `${_lkpBucketLabel}-K lineups${_pitcherHandLabel} (${dvp.wCount}/${wTotal}g)` : "")
                          : (dvp ? `vs ${mlbH2HOpp} (${dvp.wCount}/${wTotal}g)` :
                             (tonightTabPlay?.matchupPct != null ? `${(tonightTabPlay.oppMetricLabel || "").replace(/\s*\(\d+g\)\s*$/, "")}${tonightTabPlay.matchupGames ? ` (${tonightTabPlay.matchupGames}g)` : ""}` : "")))
                      : (tonightPlay?.softPct != null
                          ? (tonightPlay.opponent ? `vs ${tonightPlay.opponent}${tonightPlay.softGames ? ` (${tonightPlay.softGames}g)` : ""}` : (tonightPlay.softGames ? `${tonightPlay.softGames}g` : ""))
                          : (dvp ? `${dvp.wCount}/${wTotal}g` : ""));
                    const softPct = isUnder ? (softPctRaw !== null ? 100 - softPctRaw : null) : softPctRaw;
                    // truePct = avg(seasonPct, matchupPct) — use monotonicity-enforced pre-computed value
                    const truePct = (() => {
                      if (!isUnder && _rawTruePctMap[t] != null) return _rawTruePctMap[t];
                      return softPct !== null ? (pct + softPct) / 2 : null;
                    })();
                    // Prefer tonight endpoint's Kalshi data when available; fall back to live fetch
                    const kRawLocal = kalshiOdds[t];
                    const kTonightRaw = (tonightPlay && !isUnder) ? { pct: tonightPlay.kalshiPct, americanOdds: tonightPlay.americanOdds } : null;
                    const kRaw = kTonightRaw || kRawLocal;
                    const k = (kRaw && isUnder) ? { ...kRaw, pct: 100 - kRaw.pct, americanOdds: kRaw.pct >= 50 ? Math.round(((kRaw.pct) / (100 - kRaw.pct)) * 100) : -Math.round(((100 - kRaw.pct) / kRaw.pct) * 100) } : kRaw;
                    const oddsStr = k ? (k.americanOdds >= 0 ? `+${k.americanOdds}` : `${k.americanOdds}`) : null;
                    // Use API net edge (includes spreadAdj) when available; fallback recomputes raw edge
                    const edge = (tonightPlay?.edge != null && !isUnder) ? tonightPlay.edge : (truePct !== null && k) ? truePct - k.pct : null;
                    const edgeColor = edge === null ? null : edge >= 3 ? "#3fb950" : edge >= 0 ? "#e3b341" : "#f78166";
                    const edgeStr = edge === null ? null : (edge >= 0 ? `+${edge.toFixed(1)}%` : `${edge.toFixed(1)}%`);

                    // Show track button only when the play qualifies (same criteria as /tonight)
                    // Use raw season pct as fallback when no h2h softPct is available
                    const qualifyingPct = truePct !== null ? truePct : pct;
                    const strongMatchupOk = !(isMLB && safeTab === "strikeouts") || ((dvpData?.h2h?.simScore ?? tonightPlay?.simScore ?? -1) >= 7);
                    const qualifies = k && k.pct >= 70 && edge >= 3 && strongMatchupOk;
                    const sportSlug = sport.split("/")[1];
                    const trackId = `${sportSlug}|${player.name}|${safeTab}|${t}|${tonightPlay?.gameDate || ""}`;
                    const _today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
                    const existingPick = trackedPlays.find(p => { const [ps,pn,pst,pt,pd] = p.id.split("|"); return ps===sportSlug && pn===player.name && pst===safeTab && String(pt)===String(t) && (!pd || pd >= _today); });
                    const isTracked = !!existingPick;
                    const trackBtn = qualifies ? (
                      <button onClick={() => {
                        if (isTracked) { untrackPlay(existingPick.id); return; }
                        trackPlay({
                          sport: sportSlug,
                          playerName: player.name,
                          playerTeam: player.team || "",
                          playerId: player.id,
                          position: dvpData?.position || null,
                          stat: safeTab,
                          threshold: t,
                          kalshiPct: k.pct,
                          americanOdds: k.americanOdds,
                          seasonPct: parseFloat(pct.toFixed(1)),
                          softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
                          truePct: truePct !== null ? parseFloat(truePct.toFixed(1)) : null,
                          edge: parseFloat(edge.toFixed(1)),
                          gameDate: tonightPlay?.gameDate || "",
                        });
                      }}
                        title={isTracked ? "Remove from My Picks" : "Add to My Picks"}
                        style={{background: isTracked ? "rgba(227,179,65,0.15)" : "transparent",
                          border:`1px solid ${isTracked ? "#e3b341" : "#30363d"}`,
                          borderRadius:6, padding:"1px 6px", cursor:"pointer",
                          color: isTracked ? "#e3b341" : "#484f58", fontSize:13, lineHeight:1,
                          flexShrink:0}}>
                        {isTracked ? "★" : "☆"}
                      </button>
                    ) : null;

                    if (!showTriple) {
                      // Non-NBA / no DvP: season bar + optional Kalshi + matchup
                      const color = tierColor(pct);
                      return (
                        <div key={t} style={{display:"flex",gap:10,marginBottom:14,alignItems:"flex-start"}}>
                          <div style={{color:"#8b949e",fontSize:13,width:40,textAlign:"right",flexShrink:0,paddingTop:2}}>{isUnder ? `<${t}` : `${t}+`}</div>
                          <div style={{flex:1,display:"flex",flexDirection:"column",gap:5}}>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <div style={{flex:1,background:"#21262d",borderRadius:5,height:18,overflow:"hidden"}}>
                                <div style={{width:`${pct}%`,background:color,height:"100%",borderRadius:5,transition:"width 0.5s ease",minWidth:pct>0?4:0}}/>
                              </div>
                              <div style={{color,fontSize:13,fontWeight:700,width:42,textAlign:"right",flexShrink:0}}>{pct.toFixed(1)}%</div>
                              <div style={{color:"#484f58",fontSize:11,width:80,flexShrink:0}}>{count}/{totalGames}g</div>
                            </div>
                            {k && (
                              <div style={{display:"flex",alignItems:"center",gap:8}}>
                                <div style={{flex:1,background:"#21262d",borderRadius:4,height:13,overflow:"hidden"}}>
                                  <div style={{width:`${k.pct}%`,background:tierColor(k.pct),height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:k.pct>0?3:0}}/>
                                </div>
                                <div style={{color:tierColor(k.pct),fontSize:11,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{k.pct}%</div>
                                <div style={{flexShrink:0,width:80,display:"flex",alignItems:"center",gap:4}}>
                                  <div style={{color:"#6e40c9",fontSize:10,flex:1}}>({oddsStr})</div>
                                  {trackBtn}
                                </div>
                              </div>
                            )}
                            {softPct !== null && (
                              <div style={{display:"flex",alignItems:"center",gap:8}}>
                                {(() => {
                                  const mc = tierColor(softPct);
                                  return <>
                                    <div style={{flex:1,background:"#21262d",borderRadius:4,height:13,overflow:"hidden"}}>
                                      <div style={{width:`${softPct}%`,background:mc,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:softPct>0?3:0}}/>
                                    </div>
                                    <div style={{color:mc,fontSize:11,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{softPct.toFixed(1)}%</div>
                                    <div title={softGamesLabel} style={{color:"#484f58",fontSize:10,width:80,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{softGamesLabel}</div>
                                  </>;
                                })()}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }

                    // Triple mode: True probability + Kalshi primary, season/soft in drawer
                    return (
                      <div key={t} style={{marginBottom:14}}>
                        <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                          <div style={{color:"#8b949e",fontSize:13,width:40,textAlign:"right",flexShrink:0,paddingTop:2}}>{isUnder ? `<${t}` : `${t}+`}</div>
                          <div style={{flex:1,display:"flex",flexDirection:"column",gap:5}}>
                            {/* True probability — primary */}
                            {(() => {
                              const displayPct = truePct != null ? truePct : (hasKalshi ? null : pct);
                              const displayColor = tierColor(displayPct ?? 0);
                              return (
                                <div style={{display:"flex",flexDirection:"column",gap:5}}>
                                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                                    <div style={{flex:1,background:"#21262d",borderRadius:4,height:16,overflow:"hidden"}}>
                                      {displayPct != null && <div style={{width:`${displayPct}%`,background:displayColor,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:displayPct>0?3:0}}/>}
                                    </div>
                                    <div style={{color:displayPct != null ? displayColor : "#484f58",fontSize:13,fontWeight:700,width:42,textAlign:"right",flexShrink:0}}>{displayPct != null ? `${displayPct.toFixed(1)}%` : "—"}</div>
                                    <div style={{width:90,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"flex-start",paddingLeft:2,gap:4}}>
                                      {edgeStr && (
                                        <span style={{background:edgeColor+"22",border:`1px solid ${edgeColor}`,borderRadius:4,padding:"1px 5px",fontSize:10,fontWeight:700,color:edgeColor,whiteSpace:"nowrap"}}>
                                          {edgeStr}
                                        </span>
                                      )}
                                      {trackBtn}
                                    </div>
                                  </div>
                                  {/* Odds bar */}
                                  {k && (
                                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:11,overflow:"hidden"}}>
                                        <div style={{width:`${k.pct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:k.pct>0?2:0}}/>
                                      </div>
                                      <div style={{color:"#6e40c9",fontSize:11,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{k.pct.toFixed(1)}%</div>
                                      <div style={{color:"#6e40c9",fontSize:10,width:90,flexShrink:0,paddingLeft:2}}>({oddsStr})</div>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            {/* Drawer: season rate + matchup rate + odds */}
                            {showBreakdown && !isMLB && (
                              <div style={{borderLeft:"2px solid #30363d",paddingLeft:10,marginTop:2,display:"flex",flexDirection:"column",gap:4}}>
                                {/* Season hit rate */}
                                <div style={{display:"flex",alignItems:"center",gap:8}}>
                                  <div style={{flex:1,background:"#21262d",borderRadius:4,height:11,overflow:"hidden"}}>
                                    <div style={{width:`${pct}%`,background:tierColor(pct),height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:pct>0?2:0}}/>
                                  </div>
                                  <div style={{color:tierColor(pct),fontSize:10,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{pct.toFixed(1)}%</div>
                                  <div style={{color:"#484f58",fontSize:10,width:80,flexShrink:0}}>{isMLB ? `'25+'26 (${totalGames}g)` : `${count}/${totalGames}g`}</div>
                                </div>
                                {/* Matchup rate */}
                                {softPct !== null && (() => {
                                  const mc = tierColor(softPct);
                                  return (
                                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:11,overflow:"hidden"}}>
                                        <div style={{width:`${softPct}%`,background:mc,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:softPct>0?2:0}}/>
                                      </div>
                                      <div style={{color:mc,fontSize:10,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{softPct.toFixed(1)}%</div>
                                      <div title={softGamesLabel} style={{color:"#484f58",fontSize:10,width:80,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{softGamesLabel}</div>
                                    </div>
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}

                {/* Footer */}
                <div style={{marginTop:8,paddingTop:12,borderTop:"1px solid #21262d",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                  {showTriple && !isMLB && (
                    <button onClick={() => setShowBreakdown(b => !b)}
                      style={{background:"transparent",border:"1px solid #30363d",borderRadius:6,
                        color:"#8b949e",fontSize:11,padding:"3px 10px",cursor:"pointer"}}>
                      {showBreakdown ? "▲ Hide breakdown" : "▼ Show breakdown"}
                    </button>
                  )}
                  <div style={{display:"flex",gap:12,flexWrap:"wrap",fontSize:11,color:"#484f58",marginLeft:"auto"}}>
                    {showTriple
                      ? <><span><span style={{color:"#58a6ff",fontWeight:600}}>Color</span> = ≥90% green · ≥80% blue · ≥70% yellow · else red</span>
                          {Object.keys(kalshiOdds).length > 0 && <span><span style={{color:"#3fb950",fontWeight:600}}>+edge</span> / <span style={{color:"#f78166",fontWeight:600}}>−edge</span> vs market</span>}</>
                      : Object.keys(kalshiOdds).length > 0
                        ? <span>Color = ≥90% green · ≥80% blue · ≥70% yellow · else red</span>
                        : <span style={{color:"#8b949e"}}>Season hit rate</span>
                    }
                  </div>
                </div>

                {/* Gamelog table */}
                {(() => {
                  const glKey = sport === "baseball/mlb"
                    ? (mlbIsPitcher ? "baseball/mlb_pitcher" : "baseball/mlb_hitter")
                    : sport;
                  const cols = GAMELOG_COLS[glKey];
                  if (!cols || perGame.length === 0) return null;

                  // Filter to current season (derived from date year)
                  const seasons = perGame.map(r => r.season).filter(s => s != null);
                  const currentSeason = seasons.length > 0 ? Math.max(...seasons) : null;
                  const seasonRows = currentSeason != null
                    ? perGame.filter(r => r.season === currentSeason)
                    : perGame;
                  if (seasonRows.length === 0) return null;

                  // Compute rest days (days since prior game) without mutating perGame
                  const byDateAsc = [...seasonRows].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
                  const restMap = new Map();
                  byDateAsc.forEach((row, i) => {
                    const rest = (i > 0 && row.date && byDateAsc[i-1].date)
                      ? Math.round((new Date(row.date) - new Date(byDateAsc[i-1].date)) / 86400000)
                      : null;
                    restMap.set(row, rest);
                  });

                  // TOI: parse "MM:SS" or decimal-minutes → total seconds for sorting
                  const toiToSec = v => {
                    if (v == null) return -1;
                    const s = String(v);
                    if (s.includes(':')) { const [m, sec] = s.split(':').map(Number); return m * 60 + (sec || 0); }
                    const f = parseFloat(s); return isNaN(f) ? -1 : Math.round(f * 60);
                  };
                  // Format TOI for display
                  const fmtToi = v => {
                    if (v == null) return '—';
                    const s = String(v);
                    if (s.includes(':')) return s;
                    const f = parseFloat(s);
                    if (isNaN(f)) return s;
                    return `${Math.floor(f)}:${String(Math.round((f % 1) * 60)).padStart(2, '0')}`;
                  };

                  // Sort
                  const { col: sCol, dir: sDir } = gamelogSort;
                  const sorted = [...seasonRows].sort((a, b) => {
                    let av, bv;
                    if (sCol === 'rest') { av = restMap.get(a); bv = restMap.get(b); }
                    else if (sCol === 'toi') { av = toiToSec(a.toi); bv = toiToSec(b.toi); }
                    else { av = a[sCol] ?? null; bv = b[sCol] ?? null; }
                    if (av === null && bv === null) return 0;
                    if (av === null) return 1;
                    if (bv === null) return -1;
                    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
                    return sDir === 'asc' ? cmp : -cmp;
                  });

                  const handleSort = key => setGamelogSort(prev => ({
                    col: key,
                    dir: prev.col === key ? (prev.dir === 'desc' ? 'asc' : 'desc') : 'desc',
                  }));

                  // Active stat column highlight: maps safeTab → column key
                  const activeColKey = {
                    strikeouts: 'strikeouts', hits: 'hits', hrr: 'hrr',
                    points: 'points', rebounds: 'rebounds', assists: 'assists', threePointers: 'threePointers',
                  }[safeTab] ?? null;

                  return (
                    <div style={{marginTop:16,borderTop:"1px solid #21262d",paddingTop:14}}>
                      <div style={{fontSize:11,color:"#484f58",marginBottom:8}}>
                        {currentSeason ? `${currentSeason} season` : "Season"} · {seasonRows.length} games
                      </div>
                      <div style={{overflowX:"auto",overflowY:"auto",maxHeight:280,borderRadius:6,border:"1px solid #21262d"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                          <thead>
                            <tr style={{position:"sticky",top:0,background:"#1c2128",zIndex:2}}>
                              {cols.map(c => {
                                const isSortActive = c.key === sCol;
                                const isStatCol = c.key === activeColKey;
                                return (
                                  <th key={c.key} onClick={() => handleSort(c.key)} style={{
                                    padding:"5px 8px",
                                    textAlign: c.align || 'right',
                                    color: isStatCol ? "#58a6ff" : isSortActive ? "#c9d1d9" : "#8b949e",
                                    fontWeight: isSortActive ? 700 : 500,
                                    cursor:"pointer",
                                    whiteSpace:"nowrap",
                                    userSelect:"none",
                                    borderBottom:"1px solid #30363d",
                                  }}>
                                    <span className="gl-th-wrap">
                                      {c.label}
                                      <span style={{marginLeft:3,opacity:isSortActive?1:0.35,fontSize:9}}>
                                        {isSortActive ? (sDir === 'asc' ? '▲' : '▼') : '⇅'}
                                      </span>
                                      <span className="gl-tooltip" style={{
                                        display:"none",
                                        position:"absolute",
                                        top:"calc(100% + 4px)",
                                        left:"50%",
                                        transform:"translateX(-50%)",
                                        background:"#1c2128",
                                        border:"1px solid #30363d",
                                        borderRadius:4,
                                        padding:"3px 8px",
                                        fontSize:10,
                                        color:"#c9d1d9",
                                        whiteSpace:"nowrap",
                                        pointerEvents:"none",
                                        zIndex:50,
                                        boxShadow:"0 2px 8px rgba(0,0,0,0.5)",
                                      }}>{c.tooltip}</span>
                                    </span>
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {sorted.map((row, i) => (
                              <tr key={i} style={{background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)"}}>
                                {cols.map(c => {
                                  const isStatCol = c.key === activeColKey;
                                  let display;
                                  if (c.key === 'date') {
                                    display = row.date ? row.date.slice(5, 10).replace('-', '/') : '—';
                                  } else if (c.key === 'isHome') {
                                    display = row.isHome === false
                                      ? <span style={{color:"#8b949e"}}>@</span>
                                      : row.isHome === true ? '' : '—';
                                  } else if (c.key === 'rest') {
                                    const r = restMap.get(row);
                                    display = r === null ? '—'
                                      : r === 1 ? <span style={{color:"#f78166",fontWeight:600}}>1</span>
                                      : r;
                                  } else if (c.key === 'toi') {
                                    display = fmtToi(row.toi);
                                  } else if (c.key === 'ip') {
                                    display = row.ip != null ? row.ip.toFixed(1) : '—';
                                  } else {
                                    const v = row[c.key];
                                    display = v != null ? v : '—';
                                  }
                                  return (
                                    <td key={c.key} style={{
                                      padding:"3px 8px",
                                      textAlign: c.align || 'right',
                                      color: isStatCol && row[c.key] != null ? "#c9d1d9" : "#8b949e",
                                      background: isStatCol ? "rgba(88,166,255,0.04)" : "transparent",
                                      borderBottom:"1px solid #161b22",
                                      whiteSpace:"nowrap",
                                    }}>{display}</td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        );
      })()}

      </div>{/* end constrained search/player section */}

      {!player && !teamPage && !modelPage && (
        <div className="plays-picks-grid">
        <div>
          <div style={{display:"flex",alignItems:"center",marginBottom:14}}>
            <div style={{color:"#c9d1d9",fontSize:15,fontWeight:700}}>
              {(() => {
                const _nowD = new Date(); const _dow = _nowD.getDay(); const _daysToMon = (_dow + 6) % 7;
                const _monday = new Date(_nowD - _daysToMon * 86400000);
                const _weekLabel = _monday.toLocaleDateString("en-US", { month:"short", day:"numeric" });
                const dates = [...new Set((tonightPlays || []).map(p => p.gameDate).filter(Boolean))].sort();
                return dates.length === 0
                  ? "Plays"
                  : <><span style={{color:"#484f58",fontWeight:400,fontSize:13}}>Plays — </span>{"Week of " + _weekLabel}</>;
              })()}
              <span style={{position:"relative",marginLeft:6}}>
                <span onClick={() => setShowPlaysInfo(o => !o)}
                  style={{cursor:"pointer",color:showPlaysInfo?"#58a6ff":"#484f58",fontSize:13,lineHeight:1,userSelect:"none"}}>ⓘ</span>
                {showPlaysInfo && (
                  <div style={{position:"absolute",top:20,left:0,zIndex:99,width:300,background:"#161b22",border:"1px solid #30363d",borderRadius:8,padding:"10px 12px",fontSize:11,color:"#c9d1d9",lineHeight:1.6,boxShadow:"0 4px 16px rgba(0,0,0,0.5)"}}>
                    <div style={{fontWeight:700,marginBottom:6,color:"#fff"}}>Play qualification criteria</div>
                    <div style={{marginBottom:3}}><span style={{color:"#58a6ff"}}>Implied prob</span> ≥ 70% (Kalshi market price)</div>
                    <div style={{marginBottom:3}}><span style={{color:"#3fb950"}}>Edge</span> ≥ 5% (True% minus implied)</div>
                    <div style={{marginBottom:3}}><span style={{color:"#e3b341"}}>SimScore</span> ≥ 8 / 10 (model confidence gate)</div>
                  </div>
                )}
              </span>
              <span style={{color:"#484f58",fontSize:11,marginLeft:8,userSelect:"none"}}>Reports:</span>
              {["mlb","nba","nhl"].map(s => (
                <span key={s} onClick={() => fetchReport(s)}
                  style={{cursor:"pointer",color:"#484f58",fontSize:11,marginLeft:5,
                    textDecoration:"underline",textDecorationStyle:"dotted",userSelect:"none"}}>
                  {s.toUpperCase()}
                </span>
              ))}
            </div>
            <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
              <div style={{width:1,height:14,background:"#30363d",margin:"0 2px"}} />
              <button onClick={navigateToModel}
                style={{fontSize:10,padding:"2px 8px",borderRadius:6,cursor:"pointer",
                  border:"1px solid #30363d",background:"transparent",
                  color:"#484f58", fontWeight:600}}>
                model
              </button>
              <button onClick={() => setTestMode(m => !m)}
                style={{fontSize:10,padding:"2px 8px",borderRadius:6,cursor:"pointer",
                  border:`1px solid ${testMode?"#e3b341":"#30363d"}`,
                  background: testMode?"rgba(227,179,65,0.12)":"transparent",
                  color: testMode?"#e3b341":"#484f58", fontWeight:600}}>
                {testMode ? "⚗ mock" : "mock"}
              </button>
              <button onClick={bustCache} disabled={bustLoading}
                style={{fontSize:10,padding:"2px 8px",borderRadius:6,cursor:bustLoading?"default":"pointer",
                  border:"1px solid #30363d",background:"transparent",
                  color: bustLoading?"#30363d":"#484f58", fontWeight:600}}>
                {bustLoading ? "busting…" : "bust"}
              </button>
              <a href="#my-picks" className="picks-fab"
                onClick={e => { e.preventDefault(); const el = document.getElementById("my-picks"); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 16, behavior:"smooth" }); }}
                style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:6,
                  border:"1px solid #30363d",color:"#8b949e",textDecoration:"none",lineHeight:"20px",cursor:"pointer"}}>
                My Picks ↓
              </a>
            </div>
          </div>
          {/* ROI Summary panel */}
          {!tonightLoading && (tonightPlays || []).length > 0 && (() => {
            const isStrongMatchup = play => {
              if (play.sport === "mlb" && play.stat === "strikeouts") return false;
              if (play.sport === "mlb") return play.softPct != null;
              if (play.sport === "nba") return play.oppRank != null && play.oppRank <= 5 && (play.projectedStat == null || play.projectedStat >= play.threshold * 0.95);
              if (play.sport === "nhl") return play.oppRank != null && play.oppRank <= 5;
              return play.oppRank != null && play.oppRank <= 5;
            };
            const visiblePlays = (tonightPlays || []).filter(p => {
              if (sportFilter.length > 0 && !sportFilter.includes(p.sport)) return false;
              if (statFilter.length > 0 && !statFilter.includes(p.stat)) return false;
              return true;
            });
            if (visiblePlays.length === 0) return null;
            return null; // ROI panel removed
          })()}
          {tonightLoading ? (
            <div style={{color:"#8b949e",textAlign:"center",padding:52,fontSize:13}}>
              Loading plays…
            </div>
          ) : (() => {
            const isStrongMatchup = play => {
              if (play.sport === "mlb" && play.stat === "strikeouts") return false;
              if (play.sport === "mlb") return play.softPct != null;
              if (play.sport === "nba") return play.oppRank != null && play.oppRank <= 5 && (play.projectedStat == null || play.projectedStat >= play.threshold * 0.95);
              // NHL: projectedStat is per-game rate (e.g. 0.6 goals/game), not comparable to threshold (1)
              if (play.sport === "nhl") return play.oppRank != null && play.oppRank <= 5;
              return play.oppRank != null && play.oppRank <= 5;
            };
            const impliedProb = odds => {
              if (odds == null) return null;
              if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100) * 100;
              if (odds > 0) return 100 / (odds + 100) * 100;
              return null;
            };
            const trackedGameKeys = new Set(
              trackedPlays
                .filter(p => p.id?.startsWith("total|"))
                .map(p => { const pts = p.id.split("|"); return pts.length >= 6 ? `${pts[1]}|${pts[2]}|${pts[3]}|${pts[5]}` : null; })
                .filter(Boolean)
            );
            const untrackedPlays = (tonightPlays || []).filter(play => {
              const trackId = play.gameType === "teamTotal"
                ? `teamtotal|${play.sport}|${play.scoringTeam}|${play.oppTeam}|${play.threshold}|${play.gameDate || ""}`
                : play.gameType === "total"
                ? `total|${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
                : `${play.sport || "nba"}|${play.playerName}|${play.stat}|${play.threshold}|${play.gameDate || ""}`;
              if (trackedPlays.some(p => p.id === trackId)) return false;
              if (play.gameType === "total" && trackedGameKeys.has(`${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.gameDate || ""}`)) return false;
              if (sportFilter.length > 0 && !sportFilter.includes(play.sport)) return false;
              if (statFilter.length > 0 && !statFilter.includes(play.stat)) return false;
              return true;
            });
            if (untrackedPlays.length === 0) return (
              <div style={{color:"#484f58",textAlign:"center",padding:52,fontSize:13,lineHeight:1.6}}>
                {tonightPlays?.length > 0
                  ? "All plays added to My Picks."
                  : (() => {
                      const qc = tonightMeta?.qualifyingCount ?? 0;
                      const pf = tonightMeta?.preFilteredCount ?? 0;
                      const filtered = qc - pf;
                      if (qc === 0) return "No Kalshi markets found — check back later when tomorrow's markets open.";
                      if (filtered > 0 && pf === 0) return <>
                        <div>{qc} markets found — all filtered: tonight's opponents don't meet the soft matchup threshold.</div>
                        <div style={{fontSize:11,marginTop:6,color:"#30363d"}}>NBA: vs bottom-10 defense · MLB hitters: team favored + 10 AB vs pitcher + BA ≥.270 · MLB pitchers: lineup K-rate ≥22%</div>
                      </>;
                      if (filtered > 0) return <>
                        <div>{qc} markets found · {filtered} filtered by matchup · {pf - (tonightPlays?.length ?? 0)} filtered by edge.</div>
                        <div style={{fontSize:11,marginTop:6,color:"#30363d"}}>NBA: vs bottom-10 defense · MLB hitters: team favored + 10 AB vs pitcher + BA ≥.270 · MLB pitchers: lineup K-rate ≥22%</div>
                      </>;
                      return "No qualifying plays found.";
                    })()
                }
              </div>
            );
            // Group plays by gameDate, sort dates ascending
            const localDate = n => { const d = new Date(Date.now() + n*86400000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
            const today = localDate(0);
            const tomorrow = localDate(1);
            const grouped = {};
            untrackedPlays.forEach(play => {
              const d = play.gameDate || today;
              if (!grouped[d]) grouped[d] = [];
              grouped[d].push(play);
            });
            const sortedDates = Object.keys(grouped).sort();

            function dateLabel(d) {
              if (d === today) return "Today";
              if (d === tomorrow) return "Tomorrow";
              const [yr, mo, dy] = d.split("-").map(Number);
              return new Date(yr, mo-1, dy).toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" });
            }

            return sortedDates.map(date => (
              <div key={date}>
                {/* Date header */}
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,marginTop: date === sortedDates[0] ? 0 : 20}}>
                  <div style={{color: date === today ? "#e3b341" : "#c9d1d9", fontSize:13, fontWeight:700}}>
                    {dateLabel(date)}
                  </div>
                  <div style={{flex:1,height:1,background:"#21262d"}}/>
                  <div style={{color:"#484f58",fontSize:11}}>{grouped[date].length} play{grouped[date].length !== 1 ? "s" : ""}</div>
                </div>

                {[...grouped[date]].sort((a, b) => {
                  const ta = a.gameTime || "9999";
                  const tb = b.gameTime || "9999";
                  return ta < tb ? -1 : ta > tb ? 1 : b.edge - a.edge;
                }).map((play) => {
              const playKey = play.gameType === "teamTotal"
                ? `teamtotal-${play.sport}-${play.scoringTeam}-${play.oppTeam}-${play.threshold}`
                : play.gameType === "total"
                ? `total-${play.sport}-${play.homeTeam}-${play.awayTeam}-${play.threshold}${play.direction === "under" ? "-under" : ""}`
                : `${play.playerName}-${play.stat}-${play.threshold}`;
              const oddsStr = play.americanOdds >= 0 ? `+${play.americanOdds}` : `${play.americanOdds}`;
              const isExpanded = expandedPlays.has(playKey);
              const trackId = play.gameType === "teamTotal"
                ? `teamtotal|${play.sport}|${play.scoringTeam}|${play.oppTeam}|${play.threshold}|${play.gameDate || ""}`
                : play.gameType === "total"
                ? `total|${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
                : `${play.sport || "nba"}|${play.playerName}|${play.stat}|${play.threshold}|${play.gameDate || ""}`;
              const isTracked = trackedPlays.some(p => p.id === trackId);
              const headshotUrl = play.playerId ? `https://a.espncdn.com/i/headshots/${play.sport || "nba"}/players/full/${play.playerId}.png` : null;

              // ── Team total play card ────────────────────────────────────────────────────────────
              if (play.gameType === "teamTotal") {
                const tLabel = { teamRuns:"Runs", teamPoints:"Pts" }[play.stat] || play.stat;
                const lineVal = (play.threshold - 0.5).toFixed(1);
                const tColor = tierColor(play.truePct);
                const tTrueOdds = play.truePct >= 100 ? -99999 : (play.truePct >= 50 ? Math.round(-(play.truePct/(100-play.truePct))*100) : Math.round((100-play.truePct)/play.truePct*100));
                const tTrueOddsStr = tTrueOdds > 0 ? `+${tTrueOdds}` : `${tTrueOdds}`;
                const logoUrl = abbr => `https://a.espncdn.com/i/teamlogos/${play.sport}/500/${abbr.toLowerCase()}.png`;
                const sc = play.teamTotalSimScore;
                const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                return (
                  <div key={playKey}
                    style={{background:"#161b22",border:`1px solid ${isTracked?"#3fb950":"#30363d"}`,borderRadius:12,
                      padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                    onMouseEnter={e => { if (!isTracked) e.currentTarget.style.borderColor="#58a6ff"; }}
                    onMouseLeave={e => { if (!isTracked) e.currentTarget.style.borderColor="#30363d"; }}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                          <img src={logoUrl(play.scoringTeam)} alt={play.scoringTeam}
                            onClick={e=>{e.stopPropagation();navigateToTeam(play.scoringTeam,play.sport);}}
                            style={{width:44,height:44,objectFit:"contain",background:"#21262d",borderRadius:6,padding:2,flexShrink:0,cursor:"pointer"}}
                            onError={e=>e.target.style.display="none"}/>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.scoringTeam,play.sport);}}
                            style={{color:"#c9d1d9",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.scoringTeam}</span>
                          <span style={{color:"#484f58",fontSize:11}}>vs</span>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.oppTeam,play.sport);}}
                            style={{color:"#8b949e",fontSize:12,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.oppTeam}</span>
                        </div>
                        <div style={{color:"#8b949e",fontSize:11,marginTop:3,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                          {play.gameTime && (() => { const _d = new Date(play.gameTime); const ptFmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"}); const tPT = ptFmt.format(new Date()), rPT = ptFmt.format(new Date(Date.now()+86400000)); const gd = play.gameDate || ptFmt.format(_d); const dl = gd===tPT?"Today":gd===rPT?"Tomorrow":new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric"}).format(_d); const tp = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"2-digit",hour12:true}).format(_d); return <span>{dl} · {tp} PT</span>; })()}
                        </div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                        <span style={{background:"rgba(88,166,255,0.12)",border:"1px solid #58a6ff",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#58a6ff",fontWeight:700,whiteSpace:"nowrap"}}>
                          Over {lineVal} {tLabel}
                        </span>
                        <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                          +{play.edge}%
                        </span>
                        <button onClick={e => { e.stopPropagation(); if (isTracked) { untrackPlay(trackId); return; } const calcV = calcOdds.trim(); const overrideOdds = (calcV && calcV !== "-" && calcV !== "+" && !isNaN(parseInt(calcV))) ? parseInt(calcV) : null; trackPlay(overrideOdds ? { ...play, americanOdds: overrideOdds } : play); }}
                          title={isTracked ? "Remove from My Picks" : "Add to My Picks"}
                          style={{background: isTracked ? "rgba(227,179,65,0.15)" : "transparent",
                            border: `1px solid ${isTracked ? "#e3b341" : "#30363d"}`,
                            borderRadius:6, padding:"2px 7px", cursor:"pointer",
                            color: isTracked ? "#e3b341" : "#484f58", fontSize:14, lineHeight:1}}>
                          {isTracked ? "★" : "☆"}
                        </button>
                      </div>
                    </div>
                    {/* True% bar */}
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:14,overflow:"hidden"}}>
                        <div style={{width:`${play.truePct}%`,background:tColor,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:play.truePct>0?3:0}}/>
                      </div>
                      <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                        <span style={{color:tColor,fontSize:12,fontWeight:700}}>{play.truePct}%</span>
                        <span style={{color:tColor,fontSize:10}}>({tTrueOddsStr})</span>
                      </div>
                    </div>
                    {/* Kalshi price bar */}
                    {play.kalshiPct != null && (() => {
                      const kPct = play.kalshiPct;
                      const kOdds = kPct >= 50 ? Math.round(-(kPct/(100-kPct))*100) : Math.round((100-kPct)/kPct*100);
                      const kOddsStr = kOdds > 0 ? `+${kOdds}` : `${kOdds}`;
                      return (
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                          <div style={{flex:1,background:"#21262d",borderRadius:4,height:10,overflow:"hidden"}}>
                            <div style={{width:`${kPct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:kPct>0?3:0}}/>
                          </div>
                          <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                            <span style={{color:"#6e40c9",fontSize:12,fontWeight:600}}>{kPct}%</span>
                            <span style={{color:"#6e40c9",fontSize:10}}>({kOddsStr})</span>
                          </div>
                        </div>
                      );
                    })()}
                    {/* Explanation prose */}
                    <div style={{marginTop:4}}>
                      {play.sport === "mlb" && (() => {
                        const eraColor = v => v == null ? "#8b949e" : v > 4.5 ? "#3fb950" : v > 3.5 ? "#e3b341" : "#f78166";
                        const rpgColor = v => v == null ? "#8b949e" : v > 5.0 ? "#3fb950" : v > 4.0 ? "#e3b341" : "#8b949e";
                        const ouColor = play.gameOuLine == null ? "#8b949e" : play.gameOuLine >= 9.5 ? "#3fb950" : play.gameOuLine >= 7.5 ? "#e3b341" : "#f78166";
                        const rpgDesc = play.teamRPG == null ? null : play.teamRPG > 5.0 ? "above-average offense" : play.teamRPG > 4.0 ? "solid offense" : "below-average offense";
                        const eraDesc = play.oppERA == null ? null : play.oppERA > 4.5 ? "a hittable arm" : play.oppERA > 3.5 ? "an average starter" : "a tough matchup";
                        const ouDesc = play.gameOuLine == null ? null : play.gameOuLine >= 9.5 ? "a high-scoring game" : play.gameOuLine >= 7.5 ? "an average total" : "a pitcher's duel";
                        const etColor = play.teamExpected == null ? "#8b949e" : play.teamExpected >= play.threshold + 1.5 ? "#3fb950" : play.teamExpected >= play.threshold - 0.5 ? "#e3b341" : "#8b949e";
                        const _rpgPts = play.teamRPG == null ? 1 : play.teamRPG > 5.0 ? 2 : play.teamRPG > 4.0 ? 1 : 0;
                        const _eraPts = play.oppERA == null ? 1 : play.oppERA > 4.5 ? 2 : play.oppERA > 3.5 ? 1 : 0;
                        const _parkPts = play.parkFactor == null ? 1 : play.parkFactor > 1.05 ? 2 : play.parkFactor > 1.00 ? 1 : 0;
                        const _h2hPts = play.h2hHitRatePts ?? 1;
                        const _ouPts = play.gameOuLine == null ? 1 : play.gameOuLine >= 9.5 ? 2 : play.gameOuLine >= 7.5 ? 1 : 0;
                        const scTitle = [`RPG (${play.teamRPG?.toFixed(1) ?? "—"}): ${_rpgPts}/2`,`Opp ERA (${play.oppERA?.toFixed(2) ?? "—"}): ${_eraPts}/2`,`H2H HR% (${play.h2hHitRate?.toFixed(0) ?? "—"}%): ${_h2hPts}/2`,`Park (${play.parkFactor != null ? (play.parkFactor > 1 ? "+" : "") + ((play.parkFactor-1)*100).toFixed(0) + "%" : "—"}): ${_parkPts}/2`,`O/U (${play.gameOuLine ?? "—"}): ${_ouPts}/2`].join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> averages{play.teamRPG != null ? <> <span style={{color:rpgColor(play.teamRPG),fontWeight:600}}>{play.teamRPG.toFixed(1)}</span> runs/game</> : " — RPG"}{rpgDesc ? <> — <span style={{color:"#484f58"}}>{rpgDesc}</span></> : null}.{" "}
                            Facing a <span style={{color:"#c9d1d9"}}>{play.oppTeam}</span> starter with{play.oppERA != null ? <> <span style={{color:eraColor(play.oppERA),fontWeight:600}}>{play.oppERA.toFixed(2)} ERA</span></> : " — ERA"}{eraDesc ? <> — <span style={{color:"#484f58"}}>{eraDesc}</span></> : null}.
                            {play.h2hHitRate != null ? <>{" "}<span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> <span style={{color:"#484f58"}}>has scored {lineVal}+ runs in</span> <span style={{color: play.h2hHitRate >= 80 ? "#3fb950" : play.h2hHitRate >= 60 ? "#e3b341" : "#f78166",fontWeight:600}}>{play.h2hHitRate.toFixed(0)}%</span> <span style={{color:"#484f58"}}>of their last {play.h2hGames}g H2H meetings.</span></> : null}
                            {Math.abs((play.parkFactor ?? 1) - 1) > 0.01 ? <>{" "}<span style={{color:"#484f58"}}>Park factor</span> <span style={{color:"#8b949e"}}>{play.parkFactor > 1 ? "+" : ""}{((play.parkFactor - 1)*100).toFixed(0)}%</span>.</> : null}
                            {play.gameOuLine != null && <>{" "}<span style={{color:"#484f58"}}>Game total</span> <span style={{color:ouColor,fontWeight:600}}>{play.gameOuLine}</span>{ouDesc ? <> — <span style={{color:"#484f58"}}>{ouDesc}</span></> : null}.</>}
                            {play.teamExpected != null && <>{" "}<span style={{color:"#484f58"}}>Model projects</span> <span style={{color:etColor,fontWeight:600}}>{play.teamExpected}</span> <span style={{color:"#484f58"}}>expected runs vs the {lineVal} line.</span></>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"help"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                      {play.sport === "nba" && (() => {
                        const offColor = v => v == null ? "#8b949e" : v >= 118 ? "#f78166" : v >= 113 ? "#e3b341" : "#8b949e";
                        const defColor = v => v == null ? "#8b949e" : v >= 118 ? "#3fb950" : v >= 113 ? "#e3b341" : "#f78166";
                        const offDesc = play.teamOff == null ? null : play.teamOff >= 118 ? "an elite offense" : play.teamOff >= 113 ? "an above-average offense" : "an average offense";
                        const defDesc = play.oppDef == null ? null : play.oppDef >= 118 ? "one of the weakest defenses in the league" : play.oppDef >= 113 ? "a below-average defense" : "a solid defense";
                        const ouDesc2 = play.gameOuLine == null ? null : play.gameOuLine >= 235 ? "a fast-paced game" : play.gameOuLine >= 225 ? "an above-average total" : "a low-total game";
                        const paceAdj = (play.teamPace != null && play.leagueAvgPace != null) ? parseFloat((play.teamPace - play.leagueAvgPace).toFixed(1)) : null;
                        const etColor = play.teamExpected == null ? "#8b949e" : play.teamExpected >= play.threshold + 5 ? "#3fb950" : play.teamExpected >= play.threshold - 5 ? "#e3b341" : "#8b949e";
                        const _offPts = play.teamOff == null ? 1 : play.teamOff >= 118 ? 2 : play.teamOff >= 113 ? 1 : 0;
                        const _defPts = play.oppDef == null ? 1 : play.oppDef >= 118 ? 2 : play.oppDef >= 113 ? 1 : 0;
                        const _ouPts2 = play.gameOuLine == null ? 1 : play.gameOuLine >= 235 ? 2 : play.gameOuLine >= 225 ? 1 : 0;
                        const _pacePts = (play.teamPace == null || play.leagueAvgPace == null) ? 1 : play.teamPace > play.leagueAvgPace + 2 ? 2 : play.teamPace > play.leagueAvgPace - 2 ? 1 : 0;
                        const _h2hPts2 = play.h2hHitRatePts ?? 1;
                        const scTitle = [`Off PPG (${play.teamOff?.toFixed(0) ?? "—"}): ${_offPts}/2`,`Opp Def PPG (${play.oppDef?.toFixed(0) ?? "—"}): ${_defPts}/2`,`O/U (${play.gameOuLine ?? "—"}): ${_ouPts2}/2`,`Pace (${play.teamPace?.toFixed(1) ?? "—"}): ${_pacePts}/2`,`H2H HR% (${play.h2hHitRate?.toFixed(0) ?? "—"}%): ${_h2hPts2}/2`].join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> averages{play.teamOff != null ? <> <span style={{color:offColor(play.teamOff),fontWeight:600}}>{play.teamOff.toFixed(0)} PPG</span></> : " —"}{offDesc ? <> — <span style={{color:"#484f58"}}>{offDesc}</span></> : null}.{" "}
                            The <span style={{color:"#c9d1d9"}}>{play.oppTeam}</span> defense allows{play.oppDef != null ? <> <span style={{color:defColor(play.oppDef),fontWeight:600}}>{play.oppDef.toFixed(0)} PPG</span></> : " —"}{defDesc ? <> — <span style={{color:"#484f58"}}>{defDesc}</span></> : null}.
                            {play.h2hHitRate != null ? <>{" "}<span style={{color:"#c9d1d9"}}>{play.scoringTeam}</span> <span style={{color:"#484f58"}}>has scored {lineVal}+ pts in</span> <span style={{color: play.h2hHitRate >= 80 ? "#3fb950" : play.h2hHitRate >= 60 ? "#e3b341" : "#f78166",fontWeight:600}}>{play.h2hHitRate.toFixed(0)}%</span> <span style={{color:"#484f58"}}>of their last {play.h2hGames}g H2H meetings.</span></> : null}
                            {paceAdj != null && <>{" "}<span style={{color:"#484f58"}}>Team pace</span> <span style={{color:paceAdj > 2 ? "#3fb950" : paceAdj > -2 ? "#e3b341" : "#8b949e"}}>{paceAdj > 0 ? "+" : ""}{paceAdj}</span> <span style={{color:"#484f58"}}>vs league avg.</span></>}
                            {play.gameOuLine != null && <>{" "}<span style={{color:"#484f58"}}>Game total</span> <span style={{color:play.gameOuLine >= 235 ? "#3fb950" : play.gameOuLine >= 225 ? "#e3b341" : "#8b949e",fontWeight:600}}>{play.gameOuLine}</span>{ouDesc2 ? <> — <span style={{color:"#484f58"}}>{ouDesc2}</span></> : null}.</>}
                            {play.teamExpected != null && <>{" "}<span style={{color:"#484f58"}}>Model projects</span> <span style={{color:etColor,fontWeight:600}}>{play.teamExpected}</span> <span style={{color:"#484f58"}}>pts vs the {lineVal} line.</span></>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"help"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              }
              // ── End team total play card ────────────────────────────────────────────────────────

              // ── Game total play card ────────────────────────────────────────────────────────────
              if (play.gameType === "total") {
                const isUnder = play.direction === "under";
                const displayTruePct = isUnder ? play.noTruePct : play.truePct;
                const displayKalshiPct = isUnder ? play.noKalshiPct : play.kalshiPct;
                const tColor = tierColor(displayTruePct);
                const logoUrl = abbr => `https://a.espncdn.com/i/teamlogos/${play.sport}/500/${abbr.toLowerCase()}.png`;
                const tLabel = { totalRuns:"Runs", totalPoints:"Pts", totalGoals:"Goals" }[play.stat] || play.stat;
                const lineVal = (play.threshold - 0.5).toFixed(1);
                const tTrueOdds = displayTruePct >= 100 ? -99999 : (displayTruePct >= 50 ? Math.round(-(displayTruePct/(100-displayTruePct))*100) : Math.round((100-displayTruePct)/displayTruePct*100));
                const tTrueOddsStr = tTrueOdds > 0 ? `+${tTrueOdds}` : `${tTrueOdds}`;
                return (
                  <div key={playKey}
                    style={{background:"#161b22",border:`1px solid ${isTracked?"#3fb950":"#30363d"}`,borderRadius:12,
                      padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                    onMouseEnter={e => { if (!isTracked) e.currentTarget.style.borderColor="#58a6ff"; }}
                    onMouseLeave={e => { if (!isTracked) e.currentTarget.style.borderColor="#30363d"; }}>
                    {/* Header */}
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      {/* Matchup info */}
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                          <img src={logoUrl(play.awayTeam)} alt={play.awayTeam} onClick={e=>{e.stopPropagation();navigateToTeam(play.awayTeam,play.sport);}}
                            style={{width:44,height:44,objectFit:"contain",background:"#21262d",borderRadius:6,padding:2,flexShrink:0,cursor:"pointer"}}
                            onError={e=>e.target.style.display="none"}/>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.awayTeam,play.sport);}}
                            style={{color:"#c9d1d9",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.awayTeam}</span>
                          <span style={{color:"#484f58",fontSize:11}}>@</span>
                          <span onClick={e=>{e.stopPropagation();navigateToTeam(play.homeTeam,play.sport);}}
                            style={{color:"#c9d1d9",fontSize:12,fontWeight:600,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{play.homeTeam}</span>
                          <img src={logoUrl(play.homeTeam)} alt={play.homeTeam} onClick={e=>{e.stopPropagation();navigateToTeam(play.homeTeam,play.sport);}}
                            style={{width:44,height:44,objectFit:"contain",background:"#21262d",borderRadius:6,padding:2,flexShrink:0,cursor:"pointer"}}
                            onError={e=>e.target.style.display="none"}/>
                        </div>
                        <div style={{color:"#8b949e",fontSize:11,marginTop:3,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                          {play.gameTime && (() => { const _d = new Date(play.gameTime); const ptFmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"}); const tPT = ptFmt.format(new Date()), rPT = ptFmt.format(new Date(Date.now()+86400000)); const gd = play.gameDate || ptFmt.format(_d); const dl = gd===tPT?"Today":gd===rPT?"Tomorrow":new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric"}).format(_d); const tp = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"2-digit",hour12:true}).format(_d); return <span>{dl} · {tp} PT</span>; })()}
                          {play.lowVolume && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(231,179,49,0.12)",border:"1px solid #e3b341",color:"#e3b341"}}>Low Vol</span>}
                          {play.thinMarket && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(247,129,102,0.10)",border:"1px solid #f78166",color:"#f78166"}}>Wide Spread</span>}
                          {play.lineMove != null && Math.abs(play.lineMove) >= 3 && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:play.lineMove > 0 ? "rgba(63,185,80,0.10)" : "rgba(247,129,102,0.10)",border:`1px solid ${play.lineMove > 0 ? "#3fb950" : "#f78166"}`,color:play.lineMove > 0 ? "#3fb950" : "#f78166"}}>{play.lineMove > 0 ? "▲" : "▼"} {Math.abs(play.lineMove)}c</span>}
                        </div>
                      </div>
                      {/* Threshold badge + edge badge + star button */}
                      <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                        <span style={{background:isUnder?"rgba(247,129,102,0.12)":"rgba(88,166,255,0.12)",border:`1px solid ${isUnder?"#f78166":"#58a6ff"}`,
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:isUnder?"#f78166":"#58a6ff",fontWeight:700,whiteSpace:"nowrap"}}>
                          {isUnder ? "Under" : "Over"} {lineVal} {tLabel}
                        </span>
                        <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                          borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                          +{play.edge}%
                        </span>
                        <button onClick={e => { e.stopPropagation(); isTracked ? untrackPlay(trackId) : trackPlay(play); }}
                          title={isTracked ? "Remove from My Picks" : "Add to My Picks"}
                          style={{background: isTracked ? "rgba(227,179,65,0.15)" : "transparent",
                            border: `1px solid ${isTracked ? "#e3b341" : "#30363d"}`,
                            borderRadius:6, padding:"2px 7px", cursor:"pointer",
                            color: isTracked ? "#e3b341" : "#484f58", fontSize:14, lineHeight:1}}>
                          {isTracked ? "★" : "☆"}
                        </button>
                      </div>
                    </div>
                    {/* True% bar */}
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:14,overflow:"hidden"}}>
                        <div style={{width:`${displayTruePct}%`,background:tColor,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:displayTruePct>0?3:0}}/>
                      </div>
                      <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                        <span style={{color:tColor,fontSize:12,fontWeight:700}}>{displayTruePct}%</span>
                        <span style={{color:tColor,fontSize:10}}>({tTrueOddsStr})</span>
                      </div>
                    </div>
                    {/* Kalshi price bar */}
                    {displayKalshiPct != null && (() => {
                      const kPct = displayKalshiPct;
                      const kOdds = kPct >= 50 ? Math.round(-(kPct/(100-kPct))*100) : Math.round((100-kPct)/kPct*100);
                      const kOddsStr = kOdds > 0 ? `+${kOdds}` : `${kOdds}`;
                      return (
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                          <div style={{flex:1,background:"#21262d",borderRadius:4,height:10,overflow:"hidden"}}>
                            <div style={{width:`${kPct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:kPct>0?3:0}}/>
                          </div>
                          <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                            <span style={{color:"#6e40c9",fontSize:12,fontWeight:600}}>{kPct}%</span>
                            <span style={{color:"#6e40c9",fontSize:10}}>({kOddsStr})</span>
                          </div>
                        </div>
                      );
                    })()}
                    {/* Rich text explanation */}
                    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:4}}>
                      {/* MLB Total */}
                      {play.sport === "mlb" && (() => {
                        const sc = play.totalSimScore;
                        const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                        const hERA = play.homeERA ?? null, aERA = play.awayERA ?? null;
                        const hRPG = play.homeRPG ?? null, aRPG = play.awayRPG ?? null;
                        const pf = play.parkFactor ?? 1;
                        const et = play.expectedTotal ?? null;
                        const eraColor = isUnder
                          ? (v => v == null ? "#8b949e" : v <= 3.5 ? "#3fb950" : v <= 4.5 ? "#e3b341" : "#f78166")
                          : (v => v == null ? "#8b949e" : v > 4.5 ? "#3fb950" : v > 3.5 ? "#e3b341" : "#f78166");
                        const rpgColor = isUnder
                          ? (v => v == null ? "#8b949e" : v <= 4.0 ? "#3fb950" : v <= 5.0 ? "#e3b341" : "#8b949e")
                          : (v => v == null ? "#8b949e" : v > 5.0 ? "#3fb950" : v > 4.0 ? "#e3b341" : "#8b949e");
                        const etColor = isUnder
                          ? (et == null ? "#8b949e" : et < play.threshold - 0.5 ? "#3fb950" : et < play.threshold + 0.5 ? "#e3b341" : "#8b949e")
                          : (et == null ? "#8b949e" : et >= play.threshold + 0.5 ? "#3fb950" : et >= play.threshold - 0.5 ? "#e3b341" : "#8b949e");
                        const gameOuLine = play.gameOuLine ?? null;
                        const mlbOuPts = play.mlbOuPts ?? 1;
                        const ouColor = isUnder
                          ? (gameOuLine == null ? "#8b949e" : gameOuLine < 7.5 ? "#3fb950" : gameOuLine < 9.5 ? "#e3b341" : "#f78166")
                          : (gameOuLine == null ? "#8b949e" : gameOuLine >= 9.5 ? "#3fb950" : gameOuLine >= 7.5 ? "#e3b341" : "#f78166");
                        const ouDesc = isUnder
                          ? (gameOuLine == null ? null : gameOuLine < 7.5 ? "a low total, supports the under" : gameOuLine < 9.5 ? "an average total" : "a high total — market expects heavy scoring")
                          : (gameOuLine == null ? null : gameOuLine >= 9.5 ? "a high-scoring game, supports the over" : gameOuLine >= 7.5 ? "an average total" : "a low total — market doesn't expect high scoring");
                        const scTitle = [isUnder?"[Under SimScore]":"",`${play.homeTeam} ERA (${hERA != null ? hERA.toFixed(2) : "—"}): ${hERA != null ? (hERA > 4.5 ? 2 : hERA > 3.5 ? 1 : 0) : 1}/2`,`${play.awayTeam} ERA (${aERA != null ? aERA.toFixed(2) : "—"}): ${aERA != null ? (aERA > 4.5 ? 2 : aERA > 3.5 ? 1 : 0) : 1}/2`,`${play.homeTeam} RPG (${hRPG != null ? hRPG.toFixed(1) : "—"}): ${hRPG != null ? (hRPG > 5.0 ? 2 : hRPG > 4.0 ? 1 : 0) : 1}/2`,`${play.awayTeam} RPG (${aRPG != null ? aRPG.toFixed(1) : "—"}): ${aRPG != null ? (aRPG > 5.0 ? 2 : aRPG > 4.0 ? 1 : 0) : 1}/2`,`O/U (${gameOuLine != null ? gameOuLine : "—"}): ${mlbOuPts}/2`].filter(Boolean).join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span>'s starter has{aERA != null ? <> a <span style={{color:eraColor(aERA),fontWeight:600}}>{aERA.toFixed(2)} ERA</span></> : " — ERA"}, facing a <span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> offense averaging{hRPG != null ? <> <span style={{color:rpgColor(hRPG),fontWeight:600}}>{hRPG.toFixed(1)}</span> runs/game</> : " — RPG"}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.homeTeam}</span>'s starter posts{hERA != null ? <> a <span style={{color:eraColor(hERA),fontWeight:600}}>{hERA.toFixed(2)} ERA</span></> : " — ERA"} against a <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> offense at{aRPG != null ? <> <span style={{color:rpgColor(aRPG),fontWeight:600}}>{aRPG.toFixed(1)}</span> RPG</> : " — RPG"}.
                            {Math.abs(pf - 1) > 0.01 && <>{" "}Tonight's park {pf > 1 ? "inflates run scoring" : "suppresses run scoring"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}%</span>).</>}
                            {gameOuLine != null && <>{" "}Game total <span style={{color:ouColor,fontWeight:600}}>{gameOuLine}</span><span style={{color:"#8b949e"}}> — {ouDesc}.</span></>}
                            {et != null && <>{" "}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined runs {isUnder ? "— under the" : "vs the"} <span style={{color:"#c9d1d9"}}>{lineVal}</span> threshold.</>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"default"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                      {/* NBA Total */}
                      {play.sport === "nba" && (() => {
                        const sc = play.totalSimScore;
                        const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                        const hOff = play.homeOff ?? null, aOff = play.awayOff ?? null;
                        const hDef = play.homeDef ?? null, aDef = play.awayDef ?? null;
                        const hPace = play.homePace ?? null, aPace = play.awayPace ?? null;
                        const lgPace = play.leagueAvgPace ?? null;
                        const et = play.expectedTotal ?? null;
                        const paceAdj = (hPace != null && aPace != null && lgPace != null) ? parseFloat(((hPace + aPace) / 2 - lgPace).toFixed(1)) : null;
                        const offColor = isUnder
                          ? (v => v == null ? "#8b949e" : v < 113 ? "#3fb950" : v < 118 ? "#e3b341" : "#f78166")
                          : (v => v == null ? "#8b949e" : v >= 118 ? "#f78166" : v >= 113 ? "#e3b341" : "#8b949e");
                        const defColor = isUnder
                          ? (v => v == null ? "#8b949e" : v < 113 ? "#3fb950" : v < 118 ? "#e3b341" : "#f78166")
                          : (v => v == null ? "#8b949e" : v >= 118 ? "#3fb950" : v >= 113 ? "#e3b341" : "#f78166");
                        const paceColor = isUnder
                          ? (paceAdj == null ? "#8b949e" : paceAdj < -2 ? "#3fb950" : paceAdj < 0 ? "#e3b341" : "#8b949e")
                          : (paceAdj == null ? "#8b949e" : paceAdj > 0 ? "#3fb950" : paceAdj > -2 ? "#e3b341" : "#8b949e");
                        const etColor = isUnder
                          ? (et == null ? "#8b949e" : et < play.threshold - 2 ? "#3fb950" : et < play.threshold + 2 ? "#e3b341" : "#8b949e")
                          : (et == null ? "#8b949e" : et >= play.threshold + 2 ? "#3fb950" : et >= play.threshold - 2 ? "#e3b341" : "#8b949e");
                        const nbaOuLinePC = play.gameOuLine ?? null; const nbaOuPtsPC = nbaOuLinePC == null ? 1 : nbaOuLinePC >= 235 ? 2 : nbaOuLinePC >= 225 ? 1 : 0;
                        const scTitle = [isUnder?"[Under SimScore]":"",`${play.homeTeam} off PPG (${hOff != null ? hOff.toFixed(0) : "—"}): ${hOff != null ? (hOff >= 118 ? 2 : hOff >= 113 ? 1 : 0) : 1}/2`,`${play.awayTeam} off PPG (${aOff != null ? aOff.toFixed(0) : "—"}): ${aOff != null ? (aOff >= 118 ? 2 : aOff >= 113 ? 1 : 0) : 1}/2`,`${play.homeTeam} def allowed (${hDef != null ? hDef.toFixed(0) : "—"}): ${hDef != null ? (hDef >= 118 ? 2 : hDef >= 113 ? 1 : 0) : 1}/2`,`${play.awayTeam} def allowed (${aDef != null ? aDef.toFixed(0) : "—"}): ${aDef != null ? (aDef >= 118 ? 2 : aDef >= 113 ? 1 : 0) : 1}/2`,`O/U (${nbaOuLinePC ?? "—"}): ${nbaOuPtsPC}/2`].filter(Boolean).join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> averages{aOff != null ? <> <span style={{color:offColor(aOff),fontWeight:600}}>{aOff.toFixed(0)} PPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> defense allowing{hDef != null ? <> <span style={{color:defColor(hDef),fontWeight:600}}>{hDef.toFixed(0)} PPG</span></> : " —"}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> averages{hOff != null ? <> <span style={{color:offColor(hOff),fontWeight:600}}>{hOff.toFixed(0)} PPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> defense allowing{aDef != null ? <> <span style={{color:defColor(aDef),fontWeight:600}}>{aDef.toFixed(0)} PPG</span></> : " —"}.
                            {paceAdj != null && <>{" "}Game pace is <span style={{color:paceColor,fontWeight:600}}>{paceAdj > 0 ? "+" : ""}{paceAdj}</span> vs league avg{isUnder ? (paceAdj < -2 ? " — slower game, supports under" : " — near average") : (paceAdj > 0 ? " — more possessions, more scoring" : paceAdj > -2 ? " — near league average" : " — slower game, fewer possessions")}.</>}
                            {et != null && <>{" "}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined pts {isUnder ? "— under the" : "vs the"} <span style={{color:"#c9d1d9"}}>{lineVal}</span> threshold.</>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"default"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                      {/* NHL Total */}
                      {play.sport === "nhl" && (() => {
                        const sc = play.totalSimScore;
                        const scColor = sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e";
                        const hGPG = play.homeGPG ?? null, aGPG = play.awayGPG ?? null;
                        const hGAA = play.homeGAA ?? null, aGAA = play.awayGAA ?? null;
                        const et = play.expectedTotal ?? null;
                        const gpgColor = isUnder
                          ? (v => v == null ? "#8b949e" : v < 3.0 ? "#3fb950" : v < 3.5 ? "#e3b341" : "#8b949e")
                          : (v => v == null ? "#8b949e" : v >= 3.5 ? "#3fb950" : v >= 3.0 ? "#e3b341" : "#8b949e");
                        const gaaColor = isUnder
                          ? (v => v == null ? "#8b949e" : v < 3.0 ? "#3fb950" : v < 3.5 ? "#e3b341" : "#8b949e")
                          : (v => v == null ? "#8b949e" : v >= 3.5 ? "#3fb950" : v >= 3.0 ? "#e3b341" : "#8b949e");
                        const etColor = isUnder
                          ? (et == null ? "#8b949e" : et < play.threshold - 0.5 ? "#3fb950" : et < play.threshold + 0.5 ? "#e3b341" : "#8b949e")
                          : (et == null ? "#8b949e" : et >= play.threshold + 0.5 ? "#3fb950" : et >= play.threshold - 0.5 ? "#e3b341" : "#8b949e");
                        const _gpgPts = v => v == null ? 1 : v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0;
                        const _gaaPts = v => v == null ? 1 : v >= 3.5 ? 2 : v >= 3.0 ? 1 : 0;
                        const nhlOuLinePC = play.gameOuLine ?? null; const nhlOuPtsPC = nhlOuLinePC == null ? 1 : nhlOuLinePC >= 7 ? 2 : nhlOuLinePC >= 5.5 ? 1 : 0;
                        const scTitle = [isUnder?"[Under SimScore]":"",`${play.homeTeam} GPG (${hGPG ?? "—"}): ${_gpgPts(hGPG)}/2`,`${play.awayTeam} GPG (${aGPG ?? "—"}): ${_gpgPts(aGPG)}/2`,`${play.homeTeam} GAA (${hGAA ?? "—"}): ${_gaaPts(hGAA)}/2`,`${play.awayTeam} GAA (${aGAA ?? "—"}): ${_gaaPts(aGAA)}/2`,`O/U (${nhlOuLinePC ?? "—"}): ${nhlOuPtsPC}/2`].filter(Boolean).join("\n");
                        return (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                            <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> averages{aGPG != null ? <> <span style={{color:gpgColor(aGPG),fontWeight:600}}>{aGPG.toFixed(1)} GPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> defense with{hGAA != null ? <> <span style={{color:gaaColor(hGAA),fontWeight:600}}>{hGAA.toFixed(2)} GAA</span></> : " — GAA"}.
                            {" "}<span style={{color:"#c9d1d9"}}>{play.homeTeam}</span> averages{hGPG != null ? <> <span style={{color:gpgColor(hGPG),fontWeight:600}}>{hGPG.toFixed(1)} GPG</span></> : " —"} facing a <span style={{color:"#c9d1d9"}}>{play.awayTeam}</span> defense allowing{aGAA != null ? <> <span style={{color:gaaColor(aGAA),fontWeight:600}}>{aGAA.toFixed(2)} GAA</span></> : " — GAA"}.
                            {et != null && <>{" "}Model projects <span style={{color:etColor,fontWeight:600}}>{et}</span> combined goals {isUnder ? "— under the" : "vs the"} <span style={{color:"#c9d1d9"}}>{lineVal}</span> threshold.</>}
                            {" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,verticalAlign:"middle",cursor:"default"}}>{sc}/10 {sc>=8?"Alpha":sc>=5?"Mid":"Low"}</span>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              }
              // ── End total play card ─────────────────────────────────────────────────────────────
              return (
                <div key={playKey}
                  style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,
                    padding:"14px 16px",marginBottom:10,transition:"border-color 0.15s"}}
                  onMouseEnter={e => e.currentTarget.style.borderColor = "#58a6ff"}
                  onMouseLeave={e => e.currentTarget.style.borderColor = "#30363d"}>
                  {/* Header row — click navigates to player card */}
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,cursor:"pointer"}}
                    onClick={() => navigateToPlay(play)}>
                    {/* Headshot */}
                    {headshotUrl && (
                      <img src={headshotUrl} alt={play.playerName}
                        style={{width:44,height:44,borderRadius:"50%",objectFit:"cover",objectPosition:"top",
                          background:"#21262d",flexShrink:0,border:"1px solid #30363d"}}
                        onError={e => { e.target.style.display="none"; }}/>
                    )}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <div style={{color:"#fff",fontSize:14,fontWeight:700}}>{play.playerName}</div>
                      </div>
                      <div style={{color:"#8b949e",fontSize:11,marginTop:2,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                        <span>{play.playerTeam} vs {play.opponent}{play.position ? ` · ${play.position}` : ""}</span>
                        {play.gameTime && (
                          <span style={{color:"#6e7681"}}>·</span>
                        )}
                        {play.gameTime && (() => { const _d = new Date(play.gameTime); const ptFmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"}); const tPT = ptFmt.format(new Date()), rPT = ptFmt.format(new Date(Date.now()+86400000)); const gd = play.gameDate || ptFmt.format(_d); const dl = gd===tPT?"Today":gd===rPT?"Tomorrow":new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric"}).format(_d); const tp = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"2-digit",hour12:true}).format(_d); return <span style={{color:"#8b949e"}}>{dl} · {tp} PT</span>; })()}
                        {play.lineupConfirmed === true && (
                          <span title="Official lineup posted" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(63,185,80,0.12)",border:"1px solid #3fb950",color:"#3fb950"}}>✓ Lineup</span>
                        )}
                        {play.lineupConfirmed === false && !(play.gameTime && Date.now() >= new Date(play.gameTime).getTime() - 30*60*1000) && (
                          <span title="Projected lineup — not yet official" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(139,148,158,0.12)",border:"1px solid #484f58",color:"#8b949e"}}>Proj. Lineup</span>
                        )}
                        {play.playerStatus === "out" && (
                          <span title="Listed as Out" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(248,113,113,0.15)",border:"1px solid #f87171",color:"#f87171"}}>Out</span>
                        )}
                        {play.playerStatus === "doubtful" && (
                          <span title="Listed as Doubtful" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(251,146,60,0.15)",border:"1px solid #fb923c",color:"#fb923c"}}>Doubtful</span>
                        )}
                        {play.playerStatus === "questionable" && (
                          <span title="Listed as Questionable" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(234,179,8,0.15)",border:"1px solid #eab308",color:"#eab308"}}>Questionable</span>
                        )}
                        {play.isB2B && (
                          <span title="Back-to-back: played yesterday" style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:4,background:"rgba(248,113,113,0.15)",border:"1px solid #f87171",color:"#f87171"}}>B2B</span>
                        )}
                      </div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
                      <span style={{background:"rgba(88,166,255,0.12)",border:"1px solid #58a6ff",
                        borderRadius:6,padding:"2px 8px",fontSize:12,color:"#58a6ff",fontWeight:700,whiteSpace:"nowrap"}}>
                        {play.threshold}+ {STAT_LABEL[play.stat] || play.stat}
                      </span>
                      <span style={{background:"rgba(63,185,80,0.13)",border:"1px solid #3fb950",
                        borderRadius:6,padding:"2px 8px",fontSize:12,color:"#3fb950",fontWeight:700,whiteSpace:"nowrap"}}>
                        +{play.edge}%
                      </span>
                      <button onClick={e => { e.stopPropagation(); if (isTracked) { untrackPlay(trackId); return; } const calcV = calcOdds.trim(); const overrideOdds = (calcV && calcV !== "-" && calcV !== "+" && !isNaN(parseInt(calcV))) ? parseInt(calcV) : null; const finalOdds = overrideOdds ?? play.americanOdds; const newKalshiPct = overrideOdds != null ? (overrideOdds < 0 ? Math.abs(overrideOdds)/(Math.abs(overrideOdds)+100)*100 : 100/(overrideOdds+100)*100) : play.kalshiPct; const newEdge = play.truePct != null ? parseFloat((play.truePct - newKalshiPct).toFixed(1)) : play.edge; trackPlay({ ...play, americanOdds: finalOdds, kalshiPct: parseFloat(newKalshiPct.toFixed(1)), edge: newEdge }); }}
                        title={isTracked ? "Remove from My Picks" : "Add to My Picks"}
                        style={{background: isTracked ? "rgba(227,179,65,0.15)" : "transparent",
                          border: `1px solid ${isTracked ? "#e3b341" : "#30363d"}`,
                          borderRadius:6, padding:"2px 7px", cursor:"pointer",
                          color: isTracked ? "#e3b341" : "#484f58", fontSize:14, lineHeight:1}}>
                        {isTracked ? "★" : "☆"}
                      </button>
                    </div>
                  </div>
                  {/* True probability bar */}
                  {(() => { const tc = tierColor(play.truePct); const tp = play.truePct; const trueOdds = tp != null ? (tp >= 100 ? -99999 : (tp >= 50 ? Math.round(-(tp/(100-tp))*100) : Math.round((100-tp)/tp*100))) : null; const trueOddsStr = trueOdds != null ? (trueOdds > 0 ? `+${trueOdds}` : `${trueOdds}`) : null; return (
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                    <div style={{flex:1,background:"#21262d",borderRadius:4,height:14,overflow:"hidden"}}>
                      <div style={{width:`${tp}%`,background:tc,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:tp>0?3:0}}/>
                    </div>
                    <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                      <span style={{color:tc,fontSize:12,fontWeight:700}}>{tp}%</span>
                      {trueOddsStr && <span style={{color:tc,fontSize:10}}>({trueOddsStr})</span>}
                    </div>
                  </div>
                  ); })()}
                  {/* Odds bar */}
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                    <div style={{flex:1,background:"#21262d",borderRadius:4,height:10,overflow:"hidden"}}>
                      <div style={{width:`${play.kalshiPct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:play.kalshiPct>0?3:0}}/>
                    </div>
                    <div style={{width:70,flexShrink:0,display:"flex",justifyContent:"flex-end",alignItems:"baseline",gap:4}}>
                      <span style={{color:"#6e40c9",fontSize:12,fontWeight:600}}>{play.kalshiPct}%</span>
                      <span style={{color:"#6e40c9",fontSize:10}}>({oddsStr})</span>
                    </div>
                  </div>
                  {/* Breakdown — NFL only (not NBA, not MLB, not NHL which has its own card) */}
                  {play.sport !== "mlb" && play.sport !== "nba" && play.sport !== "nhl" && <div style={{borderTop:"1px solid #21262d",paddingTop:8}}>
                    <button onClick={e => { e.stopPropagation(); setExpandedPlays(s => { const n = new Set(s); n.has(playKey) ? n.delete(playKey) : n.add(playKey); return n; }); }}
                      style={{background:"none",border:"none",color:"#484f58",fontSize:11,cursor:"pointer",padding:0,display:"flex",alignItems:"center",gap:4}}>
                      {isExpanded ? "▲ hide breakdown" : "▼ show breakdown"}
                    </button>
                    {isExpanded && (
                      <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:8}}>
                        <div style={{display:"flex",flexDirection:"column",gap:6}}>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <div style={{width:110,color:"#8b949e",fontSize:10,flexShrink:0,lineHeight:1.35}}>
                                {`Season rate${play.seasonGames ? ` (${play.seasonGames}g)` : ""}`}
                              </div>
                              <div style={{flex:1,background:"#21262d",borderRadius:3,height:8,overflow:"hidden"}}>
                                <div style={{width:`${play.seasonPct}%`,background:tierColor(play.seasonPct),height:"100%",borderRadius:3}}/>
                              </div>
                              <div style={{color:tierColor(play.seasonPct),fontSize:11,fontWeight:600,width:38,textAlign:"right",flexShrink:0}}>{play.seasonPct}%</div>
                            </div>
                            {play.softPct !== null && (
                              <div style={{display:"flex",alignItems:"center",gap:8}}>
                                <div style={{width:110,color:"#8b949e",fontSize:10,flexShrink:0,lineHeight:1.35}}>
                                  {play.oppRank === null ? (play.oppMetricLabel || "").replace(/\s*\(\d+g\)\s*$/, "") : "vs weak matchup"}
                                  {play.softGames ? ` (${play.softGames}g)` : ""}
                                </div>
                                <div style={{flex:1,background:"#21262d",borderRadius:3,height:8,overflow:"hidden"}}>
                                  <div style={{width:`${play.softPct}%`,background:tierColor(play.softPct),height:"100%",borderRadius:3}}/>
                                </div>
                                <div style={{color:tierColor(play.softPct),fontSize:11,fontWeight:600,width:38,textAlign:"right",flexShrink:0}}>{play.softPct}%</div>
                              </div>
                            )}
                        </div>
                      </div>
                    )}
                  </div>}
                  {/* Matchup explanations — always visible */}
                  <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:play.sport==="mlb"?0:8}}>
                        {/* ── MLB Strikeouts ── */}
                        {play.stat === "strikeouts" && play.sport === "mlb" && (() => {
                          const csw = play.pitcherCSWPct ?? null;
                          const pkp = csw ?? play.pitcherKPct;
                          const pkpLabel = csw != null ? "CSW%" : "K%";
                          const kbb = play.pitcherKBBPct ?? null;
                          const ap = play.pitcherAvgPitches ?? null;
                          const recK = play.pitcherRecentKPct ?? null;
                          const seaK = play.pitcherSeasonKPct ?? null;
                          const lkp = play.lineupKPct;
                          const pf = play.parkFactor;
                          const isProjected = play.lineupKPctProjected === true;
                          const gameTotal = play.gameTotal ?? null;
                          const gameML = play.gameMoneyline ?? null;
                          const handLabel = play.pitcherHand === "R" ? " vs RHP" : play.pitcherHand === "L" ? " vs LHP" : "";
                          const _sc = play.finalSimScore ?? play.simScore ?? null;
                          const first = play.playerName.split(" ")[0];
                          const oppName = MLB_TEAM[play.opponent] || play.opponent;
                          const pkpColor = pkp == null ? "#8b949e" : (csw != null ? (pkp >= 30 ? "#3fb950" : pkp > 26 ? "#e3b341" : "#f78166") : (pkp >= 27 ? "#3fb950" : pkp >= 24 ? "#e3b341" : "#f78166"));
                          const kbbColor = kbb == null ? "#8b949e" : kbb > 18 ? "#3fb950" : kbb > 12 ? "#e3b341" : "#f78166";
                          const apColor = ap == null ? "#8b949e" : ap > 85 ? "#3fb950" : ap > 75 ? "#e3b341" : "#f78166";
                          const lkpColor = lkp == null ? "#8b949e" : lkp > 24 ? "#3fb950" : lkp > 20 ? "#e3b341" : "#f78166";
                          const totalColor = t => t == null ? "#8b949e" : t <= 7.5 ? "#3fb950" : t < 10.5 ? "#e3b341" : "#f78166";
                          const mlColor = ml => ml == null ? "#8b949e" : ml <= -121 ? "#3fb950" : ml <= 120 ? "#e3b341" : "#f78166";
                          const pkpQual = pkp == null ? "" : csw != null ? (pkp >= 30 ? "elite" : pkp > 26 ? "above-average" : "below-average") : (pkp > 24 ? "above-average" : "below-average");
                          const apDesc = ap == null ? null : ap > 85 ? "expect him to work deep into the game" : ap > 75 ? "typically goes 5–6 innings" : null;
                          const lkpDesc = lkp == null ? null : lkp > 24 ? "a high-strikeout lineup — works in his favor" : lkp > 20 ? "below-average strikeout tendency" : "elite contact lineup — a tougher test";
                          const scColor = _sc == null ? "#8b949e" : _sc >= 8 ? "#3fb950" : _sc >= 5 ? "#e3b341" : "#8b949e";
                          const scTitle = _sc != null ? [`CSW%/K%: ${play.kpctPts ?? 1}/2`,`K-BB%: ${play.kbbPts ?? 1}/2`,`Lineup K%: ${play.lkpPts ?? 1}/2`,`Hit Rate: ${play.blendedHitRatePts ?? 1}/2`,`O/U: ${play.totalPts ?? 1}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first} has {pkpQual ? <>{pkpQual} </> : ""}swing-and-miss stuff
                                {pkp != null && <> — <span style={{color:pkpColor,fontWeight:600}}>{pkp}%</span> {pkpLabel}</>}
                                {kbb != null && <>, <span style={{color:kbbColor,fontWeight:600}}>{kbb.toFixed(1)}%</span> K-BB% <span style={{color:"#8b949e"}}>(strikeouts vs walks)</span></>}
                                {ap != null && <>, averaging <span style={{color:apColor,fontWeight:600}}>{Math.round(ap)}</span> pitches/start{apDesc ? <span style={{color:"#8b949e"}}> — {apDesc}</span> : ""}</>}.
                                {lkp != null && <>{" "}The {oppName} lineup strikes out at <span style={{color:lkpColor,fontWeight:600}}>{lkp}%</span>{handLabel}{isProjected ? <span style={{color:"#484f58",fontSize:10}}> (est.)</span> : ""} — <span style={{color:"#8b949e"}}>{lkpDesc}</span>.</>}
                                {pf != null && Math.abs(pf - 1.0) >= 0.01 && <>{" "}Tonight's venue {pf > 1 ? "is strikeout-friendly" : "suppresses strikeouts"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}%</span>).</>}
                                {(recK != null || gameTotal != null) && <>{" "}{recK != null && <><span style={{color:play.kTrendPts===2?"#3fb950":play.kTrendPts===0?"#f78166":"#e3b341",fontWeight:600}}>{recK.toFixed(1)}%</span><span style={{color:"#8b949e"}}> recent K%{play.kTrendPts===2?" ↑":play.kTrendPts===0?" ↓":""}{seaK!=null?` (${seaK.toFixed(1)}% season)`:""}</span>{gameTotal != null ? <span style={{color:"#8b949e"}}>, </span> : <span style={{color:"#8b949e"}}>.</span>}</>}{gameTotal != null && <><span style={{color:"#8b949e"}}>game total </span><span style={{color:totalColor(gameTotal),fontWeight:600}}>{gameTotal}</span><span style={{color:"#8b949e"}}>{gameTotal <= 8.5 ? " — a low-scoring slate, favorable for strikeouts" : gameTotal <= 10.5 ? " — an average total" : " — a high-scoring total, tougher for Ks"}.</span></>}</>}
                                {_sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{_sc}/10 {_sc>=8?"Alpha":"Mid"}</span></>}
                              </div>
                            </div>
                          );
                        })()}
                        {/* ── MLB Hitters (hits/hrr) — always show ── */}
                        {play.sport === "mlb" && play.stat !== "strikeouts" && (() => {
                          const baVal = play.hitterBa ? `.${Math.round(play.hitterBa * 1000).toString().padStart(3,"0")}` : null;
                          const baTier = play.hitterBaTier;
                          const baTierLabel = baTier === "elite" ? "elite" : baTier === "good" ? "good" : baTier === "avg" ? "average" : null;
                          const baColor = baTier === "elite" ? "#58a6ff" : baTier === "good" ? "#3fb950" : "#8b949e";
                          const lineupSpot = play.hitterLineupSpot;
                          const spotColor = lineupSpot == null ? "#8b949e" : lineupSpot <= 3 ? "#3fb950" : lineupSpot <= 4 ? "#e3b341" : "#8b949e";
                          const pitcherName = play.hitterPitcherName;
                          const ab = play.hitterAbVsPitcher;
                          const whip = play.pitcherWHIP;
                          const fip = play.pitcherFIP;
                          const era = play.hitterPitcherEra ?? play.pitcherEra ?? null;
                          const pf = play.parkFactor ?? play.hitterParkKF;
                          const seasonG = play.pct26 != null ? play.pct26Games : (play.blendGames || play.seasonGames);
                          const seasonWindow = play.pct26 != null ? "this season" : "2025-26";
                          const statFull = STAT_FULL[play.stat] || play.stat;
                          const sc = play.hitterFinalSimScore ?? play.hitterSimScore ?? null;
                          const first = play.playerName.split(" ")[0];
                          const whipColor = whip == null ? "#8b949e" : whip > 1.35 ? "#3fb950" : whip > 1.20 ? "#e3b341" : "#f78166";
                          const fipColor = fip == null ? "#8b949e" : fip > 4.5 ? "#3fb950" : fip > 3.5 ? "#e3b341" : "#8b949e";
                          const scColor = sc != null ? (sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e") : "#8b949e";
                          const seasonColor = play.seasonPct >= 75 ? "#3fb950" : play.seasonPct >= 60 ? "#c9d1d9" : "#f78166";
                          const spotDesc = lineupSpot == null ? null : lineupSpot <= 3 ? "top of the order — guaranteed at-bats every game" : lineupSpot <= 4 ? "heart of the order — plenty of at-bats" : null;
                          const whipDesc = whip == null ? null : whip > 1.35 ? "a lot of baserunners" : whip > 1.20 ? "some traffic on base" : null;
                          const fipDesc = fip == null ? null : fip > 4.5 ? "hittable pitcher" : fip > 3.5 ? "average pitcher" : null;
                          const mk = (meets, label) => meets != null ? <span key={label} style={{color:meets?"#3fb950":"#f78166",fontSize:9,whiteSpace:"nowrap"}}>{meets?"✓":"✗"}{label}</span> : null;
                          const hitterGameTotal = play.hitterGameTotal ?? null;
                          const hitterTotalColor = t => t == null ? "#8b949e" : t >= 9.5 ? "#3fb950" : t >= 7.5 ? "#e3b341" : "#f78166";
                          const barrelPct = play.hitterBarrelPct ?? null;
                          const barrelColor = barrelPct == null ? "#8b949e" : barrelPct >= 14 ? "#3fb950" : barrelPct >= 10 ? "#e3b341" : barrelPct >= 7 ? "#8b949e" : "#f78166";
                          const platoonPts = play.hitterPlatoonPts ?? null;
                          const pitcherHand = play.oppPitcherHand ?? null;
                          const scTitle = sc != null ? [`Quality: ${play.hitterBatterQualityPts ?? 1}/2`,`WHIP: ${play.hitterWhipPts ?? 1}/2`,`Season HR: ${play.hitterSeasonHitRatePts ?? 1}/2`,`H2H HR: ${play.hitterH2HHitRatePts ?? 1}/2`,`O/U: ${play.hitterTotalPts ?? 1}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first}{lineupSpot != null && <>, batting <span style={{color:spotColor,fontWeight:600}}>#{lineupSpot}</span>{spotDesc ? <span style={{color:"#8b949e"}}> — {spotDesc}</span> : ""}</>}.
                                {(pitcherName || whip != null) && (
                                  <> Facing{pitcherName ? <> <span style={{color:"#c9d1d9",fontWeight:600}}>{pitcherName}</span>{ab ? <span style={{color:"#484f58",fontSize:10}}> ({ab} career AB)</span> : ""}</> : " the opposing starter"}{whip != null ? <> — WHIP <span style={{color:whipColor,fontWeight:600}}>{whip.toFixed(2)}</span>{whipDesc ? <span style={{color:"#8b949e"}}> ({whipDesc})</span> : ""}</> : ""}.</>
                                )}
                                {" "}{first} has gone {play.threshold}+ {statFull} in <span style={{color:seasonColor,fontWeight:600}}>{play.seasonPct}%</span> of games {seasonWindow}{seasonG ? <span style={{color:"#484f58",fontSize:10}}> ({seasonG}g)</span> : ""}
                                {play.softPct != null ? <>, and <span style={{color:"#3fb950",fontWeight:600}}>{play.softPct}%</span> {play.hitterSoftLabel ?? "against weak pitching matchups"}{play.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.softGames}g)</span> : ""}</> : ""}.
                                {play.oppRank && play.softPct === null && (() => {
                                  const _opp2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{play.opponent}</span>;
                                  const _rank2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{ordinal(play.oppRank)}-worst</span>;
                                  const _metricStr2 = play.oppMetricValue ? ` (${play.oppMetricValue} ${play.oppMetricUnit || ""})` : "";
                                  const _ctx2 = {"mlb|hits":"one of the easiest pitching matchups in the league — their staff has a high ERA this season","mlb|hrr":"one of the easiest pitching matchups in the league — their staff allows hits, runs, and RBIs at a high rate"}[`${play.sport}|${play.stat}`] || "one of the weakest defenses for this stat";
                                  return <>{" "}{_opp2} ranks {_rank2} in {play.oppMetricLabel || "this stat"}{_metricStr2} this season — {_ctx2}.{<>{" "}No head-to-head history yet{play.pct25 != null && play.pct25Games >= 5 ? <> — was at <span style={{color:"#c9d1d9"}}>{play.pct25}%</span> in {play.pct25Games} games in 2025</> : ""}.</>}</>;
                                })()}
                                {pf != null && Math.abs(pf - 1.0) >= 0.03 && <>{" "}Tonight's venue is {pf > 1 ? "hitter-friendly" : "pitcher-friendly"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}% park factor</span>).</>}
                                {hitterGameTotal != null && <>{" "}<span style={{color:"#8b949e"}}>Game total </span><span style={{color:hitterTotalColor(hitterGameTotal),fontWeight:600}}>{hitterGameTotal}</span><span style={{color:"#8b949e"}}>{hitterGameTotal >= 9.5 ? " — a high-scoring game, favorable for hitting" : hitterGameTotal >= 7.5 ? " — an average total" : " — a low-scoring game, tougher for hitters"}.</span></>}
                                {barrelPct != null && <>{" "}<span style={{color:"#8b949e"}}>Barrel rate </span><span style={{color:barrelColor,fontWeight:600}}>{barrelPct.toFixed(1)}%</span><span style={{color:"#484f58"}}>{barrelPct >= 14 ? " — elite hard contact" : barrelPct >= 10 ? " — strong contact quality" : barrelPct >= 7 ? " — average contact" : " — below-average contact"}.</span></>}
                                {platoonPts === 2 && pitcherHand && (() => { const splitBA = play.hitterSplitBA; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#3fb950",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon edge.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon edge vs {handStr}.</span></>; })()}
                                {platoonPts === 0 && pitcherHand && (() => { const splitBA = play.hitterSplitBA; const seasonBA = play.hitterBa; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#f78166",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon disadvantage{seasonBA != null ? <> (<span style={{color:"#c9d1d9"}}>.{Math.round(seasonBA*1000).toString().padStart(3,"0")}</span> season)</> : ""}.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon disadvantage vs {handStr}.</span></>; })()}
                                {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                              </div>
                            </div>
                          );
                        })()}
                        {/* ── NBA — always show ── */}
                        {play.sport === "nba" && (() => {
                          const statName = { points:"points", rebounds:"rebounds", assists:"assists", threePointers:"3-pointers" }[play.stat] || play.stat;
                          const posName = {PG:"point guard",SG:"shooting guard",SF:"small forward",PF:"power forward",C:"center"}[play.posGroup] ?? null;
                          const hasPosDvp = play.posDvpRank != null;
                          const displayRank = hasPosDvp ? play.posDvpRank : play.oppRank;
                          const displayValue = hasPosDvp ? play.posDvpValue : play.oppMetricValue;
                          const sc = play.nbaSimScore;
                          const first = play.playerName.split(" ")[0];
                          const scColor = sc != null ? (sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e") : "#8b949e";
                          const rankColor = play.isHardMatchup ? "#f78166" : (displayRank != null && displayRank <= 10) ? "#3fb950" : (displayRank != null && displayRank <= 15) ? "#e3b341" : play.softPct !== null ? "#3fb950" : "#c9d1d9";
                          const seasonColor = play.seasonPct == null ? "#c9d1d9" : play.seasonPct >= 75 ? "#3fb950" : play.seasonPct >= 60 ? "#c9d1d9" : "#f78166";
                          const minColor = play.nbaOpportunity == null ? "#8b949e" : play.nbaOpportunity >= 30 ? "#3fb950" : play.nbaOpportunity >= 25 ? "#e3b341" : "#f78166";
                          const paceColor = play.nbaPaceAdj == null ? "#8b949e" : play.nbaPaceAdj > 0 ? "#3fb950" : play.nbaPaceAdj > -2 ? "#e3b341" : "#f78166";
                          const minDesc = play.nbaOpportunity == null ? null : play.nbaOpportunity >= 33 ? "a featured starter with a big role" : play.nbaOpportunity >= 30 ? "a key starter" : play.nbaOpportunity >= 25 ? "solid rotation player" : "limited role";
                          const paceDesc = play.nbaPaceAdj == null ? null : play.nbaPaceAdj > 2 ? "a fast game — more possessions, more opportunities to score" : play.nbaPaceAdj > 0 ? "slightly above-average pace" : play.nbaPaceAdj > -2 ? "slightly slower pace" : "a slow game — fewer scoring opportunities";
                          const rankDesc = displayRank == null ? null : displayRank <= 3 ? "one of the worst defenses in the league" : displayRank <= 8 ? "a weak defense" : displayRank <= 15 ? "a soft matchup" : null;
                          const _usgPts = play.stat === "rebounds"
                            ? (play.nbaOpportunity == null ? 1 : play.nbaOpportunity >= 30 ? 2 : play.nbaOpportunity >= 25 ? 1 : 0)
                            : (play.nbaUsage == null ? 1 : play.nbaUsage >= 28 ? 2 : play.nbaUsage >= 22 ? 1 : 0);
                          const _c1Label = play.stat === "rebounds"
                            ? `AvgMin: ${play.nbaOpportunity != null ? play.nbaOpportunity.toFixed(0)+"m → "+_usgPts : "—"}/2`
                            : `USG%: ${play.nbaUsage != null ? play.nbaUsage.toFixed(1)+"% → "+_usgPts : "—"}/2`;
                          const _dvpPtsPC = play.posDvpRank != null ? (play.posDvpRank <= 10 ? 2 : play.posDvpRank <= 15 ? 1 : 0) : 1;
                          const _nbaSeasonHRPtsPC = play.nbaSeasonHitRatePts ?? (play.seasonPct >= 90 ? 2 : play.seasonPct >= 80 ? 1 : 0);
                          const _nbaSoftHRPtsPC = play.nbaSoftHitRatePts ?? (play.softPct == null ? 1 : play.softPct >= 90 ? 2 : play.softPct >= 80 ? 1 : 0);
                          const _paceGoodPC = play.nbaPaceAdj != null && play.nbaPaceAdj > 0;
                          const _totalGoodPC = play.nbaGameTotal != null && play.nbaGameTotal >= 225;
                          const _comboPtsPC = (_paceGoodPC && _totalGoodPC) ? 2 : (_paceGoodPC || _totalGoodPC) ? 1 : 0;
                          const scTitle = sc != null ? [_c1Label,`DVP: ${_dvpPtsPC}/2`,`Season HR: ${_nbaSeasonHRPtsPC}/2`,`Soft HR: ${_nbaSoftHRPtsPC}/2`,`Pace+Total: ${_comboPtsPC}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first} hits this line in <span style={{color:seasonColor,fontWeight:600}}>{play.seasonPct}%</span> of games{play.seasonGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.seasonGames}g)</span> : ""}
                                {play.nbaOpportunity != null ? <>, averaging <span style={{color:minColor,fontWeight:600}}>{play.nbaOpportunity.toFixed(0)} minutes</span> a night{minDesc ? <span style={{color:"#484f58"}}> — {minDesc}</span> : ""}</> : ""}
                                {play.stat === "assists" && play.nbaAvgAst != null ? <> (<span style={{color:play.nbaAvgAst>=7?"#3fb950":play.nbaAvgAst>=5?"#e3b341":"#f78166",fontWeight:600}}>{play.nbaAvgAst.toFixed(1)} APG</span>)</> : play.stat === "rebounds" && play.nbaAvgReb != null ? <> (<span style={{color:play.nbaAvgReb>=9?"#3fb950":play.nbaAvgReb>=7?"#e3b341":"#f78166",fontWeight:600}}>{play.nbaAvgReb.toFixed(1)} RPG</span>)</> : play.nbaUsage != null ? <> (<span style={{color:play.nbaUsage>=28?"#3fb950":play.nbaUsage>=22?"#e3b341":"#f78166",fontWeight:600}}>{play.nbaUsage.toFixed(0)}% USG</span>)</> : ""}.
                                {displayRank != null && <>{" "}{play.opponent} has {rankDesc || `the ${ordinal(displayRank)}-worst defense`} in {statName} allowed{posName ? ` to ${posName}s` : ""}{displayValue != null ? <> — giving up <span style={{color:rankColor,fontWeight:600}}>{displayValue} per game</span></> : <>, ranked <span style={{color:rankColor,fontWeight:700}}>{ordinal(displayRank)}</span></>}.</>}
                                {play.softPct != null && <>{" "}{first} hits this in <span style={{color:play.softPct>=70?"#3fb950":play.softPct>=60?"#e3b341":"#f78166",fontWeight:600}}>{play.softPct}%</span> of games against soft defenses{play.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.softGames}g)</span> : ""}.</>}
                                {play.nbaPaceAdj != null && <>{" "}Game pace is <span style={{color:paceColor,fontWeight:600}}>{play.nbaPaceAdj > 0 ? "+" : ""}{play.nbaPaceAdj}</span> possessions above average — {paceDesc}.</>}
                                {play.nbaGameTotal != null && <>{" "}Game total <span style={{color:play.nbaTotalPts>=3?"#3fb950":play.nbaTotalPts>=2?"#e3b341":play.nbaTotalPts>=1?"#8b949e":"#f78166",fontWeight:600}}>{play.nbaGameTotal}</span><span style={{color:"#8b949e"}}>{play.nbaGameTotal>=235?" — a high-scoring slate":play.nbaGameTotal>=225?" — above-average scoring":play.nbaGameTotal>=215?" — an average total":" — a low-scoring slate"}.</span></>}
                                {play.nbaBlowoutAdj != null && play.nbaBlowoutAdj < 0.99 && <>{" "}<span style={{color:"#f78166",fontWeight:600}}>Blowout risk</span> — large spread reduces model mean by {Math.round((1-play.nbaBlowoutAdj)*100)}%.</>}
                                {play.isB2B != null && <>{" "}{play.isB2B ? <><span style={{color:"#f78166",fontWeight:600}}>Back-to-back</span> — model applies a scoring reduction.</> : <>Fully rested tonight.</>}</>}
                                {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                              </div>
                            </div>
                          );
                        })()}
                        {/* ── NHL — always show ── */}
                        {play.sport === "nhl" && (() => {
                          const statName = "points";
                          const sc = play.nhlSimScore;
                          const first = play.playerName.split(" ")[0];
                          const scColor = sc != null ? (sc >= 8 ? "#3fb950" : sc >= 5 ? "#e3b341" : "#8b949e") : "#8b949e";
                          const seasonColor = play.seasonPct >= 75 ? "#3fb950" : play.seasonPct >= 60 ? "#c9d1d9" : "#f78166";
                          const toiColor = play.nhlOpportunity == null ? "#8b949e" : play.nhlOpportunity >= 18 ? "#3fb950" : play.nhlOpportunity >= 15 ? "#e3b341" : "#f78166";
                          const saColor = play.nhlShotsAdj == null ? "#8b949e" : (play.nhlSaRank != null && play.nhlSaRank <= 10) ? "#3fb950" : play.nhlShotsAdj > 0 ? "#e3b341" : "#f78166";
                          const rankColor = play.oppRank != null && play.oppRank <= 5 ? "#3fb950" : "#e3b341";
                          const toiDesc = play.nhlOpportunity == null ? null : play.nhlOpportunity >= 21 ? "a top-line role" : play.nhlOpportunity >= 18 ? "a key contributor" : play.nhlOpportunity >= 15 ? "solid ice time" : "limited role";
                          const rankDesc = play.oppRank == null ? null : play.oppRank <= 3 ? "one of the worst defenses in the league" : play.oppRank <= 8 ? "a weak defense" : play.oppRank <= 15 ? "a soft matchup" : null;
                          const saDesc = play.nhlShotsAdj == null ? null : play.nhlShotsAdj > 2 ? "generating high shot volume — more scoring chances" : play.nhlShotsAdj > 0 ? "above-average shot volume" : play.nhlShotsAdj > -2 ? "slightly below average" : "low shot volume allowed";
                          const _nhlToiPtsPC = play.nhlOpportunity != null && play.nhlOpportunity >= 18 ? 2 : play.nhlOpportunity != null && play.nhlOpportunity >= 15 ? 1 : 0;
                          const _nhlGaaPtsPC = play.oppRank != null ? (play.oppRank <= 10 ? 2 : play.oppRank <= 15 ? 1 : 0) : 1;
                          const _nhlTotalPtsPC = play.nhlGameTotal == null ? 1 : play.nhlGameTotal >= 7 ? 2 : play.nhlGameTotal >= 5.5 ? 1 : 0;
                          const _nhlSeasonHRPtsPC = play.nhlSeasonHitRatePts ?? (play.seasonPct == null ? 1 : play.seasonPct >= 90 ? 2 : play.seasonPct >= 80 ? 1 : 0);
                          const _nhlDvpHRPtsPC = play.nhlDvpHitRatePts ?? 1;
                          const scTitle = sc != null ? [`TOI ${play.nhlOpportunity != null ? play.nhlOpportunity.toFixed(0) + "m" : "—"}: ${_nhlToiPtsPC}/2`, `GAA rank: ${_nhlGaaPtsPC}/2`, `Season HR: ${_nhlSeasonHRPtsPC}/2`, `DVP HR: ${_nhlDvpHRPtsPC}/2`, `O/U ${play.nhlGameTotal ?? "—"}: ${_nhlTotalPtsPC}/2`].join("\n") : null;
                          return (
                            <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.65}}>
                              <div>
                                {first} hits this line in <span style={{color:seasonColor,fontWeight:600}}>{play.seasonPct}%</span> of games{play.seasonGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.seasonGames}g)</span> : ""}
                                {play.nhlOpportunity != null ? <>, averaging <span style={{color:toiColor,fontWeight:600}}>{play.nhlOpportunity.toFixed(0)} min</span> of ice time{toiDesc ? <span style={{color:"#484f58"}}> — {toiDesc}</span> : ""}</> : ""}.
                                {play.oppRank != null && <>{" "}{play.opponent} has {rankDesc || `the ${ordinal(play.oppRank)}-worst defense`} in {statName} allowed — ranked <span style={{color:rankColor,fontWeight:700}}>{ordinal(play.oppRank)}</span> in goals against.</>}
                                {play.nhlShotsAdj != null && <>{" "}They allow <span style={{color:saColor,fontWeight:600}}>{play.nhlShotsAdj > 0 ? "+" : ""}{play.nhlShotsAdj}</span> shots/game above average — {saDesc}.</>}
                                {play.softPct != null && <>{" "}{first} hits this in <span style={{color:"#3fb950",fontWeight:600}}>{play.softPct}%</span> vs weak defenses{play.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({play.softGames}g)</span> : ""}.</>}
                                {play.isB2B != null && <>{" "}{play.isB2B ? <><span style={{color:"#f78166",fontWeight:600}}>Back-to-back</span> — model applies a fatigue reduction.</> : <>Fully rested tonight.</>}</>}
                                {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                              </div>
                            </div>
                          );
                        })()}
                        {/* ── NHL / NFL (team ranking) ── */}
                        {play.oppRank && play.stat !== "strikeouts" && play.sport !== "nba" && play.sport !== "nhl" && play.sport !== "mlb" && (
                          <div style={{background:"#0d1117",borderRadius:8,padding:"8px 10px",fontSize:11,color:"#8b949e",lineHeight:1.5}}>
                            {(() => {
                              const first = play.playerName.split(" ")[0];
                              const opp = <span style={{color:"#c9d1d9",fontWeight:600}}>{play.opponent}</span>;
                              const metricStr = play.oppMetricValue ? ` (${play.oppMetricValue} ${play.oppMetricUnit || ""})` : "";
                              const rank = <span style={{color:"#f78166",fontWeight:700}}>{ordinal(play.oppRank)}-worst</span>;
                              const hitRate = <span style={{color:"#3fb950",fontWeight:600}}>{play.softPct}%</span>;
                              const games = play.softGames ? ` (${play.softGames} games)` : "";
                              const proj = play.projectedStat;
                              const recent = play.recentAvg;
                              const dvp = play.dvpFactor;

                              // NFL / MLB (non-strikeout with oppRank)
                              const context = {
                                "mlb|hits":           "one of the easiest pitching matchups in the league — their staff has a high ERA this season",
                                "mlb|hrr":            "one of the easiest pitching matchups in the league — their staff allows hits, runs, and RBIs at a high rate",
                                "mlb|totalBases":     "one of the easiest pitching matchups in the league — their staff allows lots of base hits",
                                "nfl|passingYards":   "one of the softest defenses against the pass — they allow the most passing yards per game",
                                "nfl|rushingYards":   "one of the softest defenses against the run — they allow the most rushing yards per game",
                                "nfl|receivingYards": "one of the softest defenses in coverage — they allow the most receiving yards per game",
                                "nfl|touchdowns":     "one of the softest defenses in the red zone — they allow the most passing yards and TDs per game",
                              }[`${play.sport}|${play.stat}`] || "one of the weakest defenses for this stat";
                              {
                                const pf = play.parkFactor;
                                const parkNote = pf != null && Math.abs(pf - 1.0) >= 0.03
                                  ? <> Tonight's venue {pf > 1 ? "boosts" : "suppresses"} hit production ({pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}% park factor).</>
                                  : null;
                                const noH2h = play.softPct === null
                                  ? <>
                                      {" "}No head-to-head history vs {opp} yet —{" "}
                                      {first} has hit {play.threshold}+ {STAT_FULL[play.stat] || play.stat} in <span style={{color:"#3fb950",fontWeight:600}}>{play.seasonPct}%</span> of his {play.pct26 != null ? play.pct26Games : (play.blendGames || play.seasonGames)} games {play.pct26 != null ? "this season" : "in 2025-26"}.
                                      {play.pct25 != null && play.pct25Games >= 5 && <> He was at {play.pct25}% in {play.pct25Games} games in 2025.</>}
                                      {parkNote}
                                    </>
                                  : <> {first} has hit {play.threshold}+ {STAT_FULL[play.stat] || play.stat} in {hitRate} of games vs weak matchups{games}.{parkNote}</>;
                                return <>{opp} ranks {rank} in {play.oppMetricLabel || "this stat"}{metricStr} this season — {context}.{noH2h}</>;
                              }
                            })()}
                          </div>
                        )}
                  </div>
                </div>
              );
            })}
            </div>
          ));
        })()}
        </div>

        {/* Column 2: Calculator + My Picks */}
        <div id="my-picks">
        {/* Implied Probability Calculator */}
        {(() => {
          const raw = calcOdds.trim();
          const n = parseInt(raw, 10);
          let implied = null;
          if (!isNaN(n) && raw !== "" && raw !== "-" && raw !== "+") {
            if (n < 0) implied = Math.abs(n) / (Math.abs(n) + 100) * 100;
            else if (n > 0) implied = 100 / (n + 100) * 100;
          }
          const color = implied === null ? "#8b949e" : implied >= 70 ? "#3fb950" : implied >= 50 ? "#e3b341" : "#f78166";
          return (
            <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:10,
              padding:"12px 16px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:16}}>
              <span style={{color:"#8b949e",fontSize:12,whiteSpace:"nowrap"}}>Implied probability</span>
              <div style={{display:"flex",alignItems:"center",background:"#0d1117",border:"1px solid #30363d",
                borderRadius:7,overflow:"hidden",flex:"0 0 auto"}}>
                <input type="text" inputMode="numeric" placeholder="-110" value={calcOdds}
                  onChange={e => {
                    let v = e.target.value;
                    // Auto-prepend "-" if user types a bare number (no sign)
                    if (v.length > 0 && v[0] !== "-" && v[0] !== "+") v = "-" + v;
                    setCalcOdds(v);
                  }}
                  style={{background:"transparent",border:"none",outline:"none",color:"#c9d1d9",
                    fontSize:14,width:80,padding:"7px 10px",textAlign:"center"}}/>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
                {implied !== null && (
                  <div style={{flex:1,background:"#21262d",borderRadius:5,height:14,overflow:"hidden",minWidth:60}}>
                    <div style={{width:`${implied}%`,background:color,height:"100%",borderRadius:5,transition:"width 0.3s ease"}}/>
                  </div>
                )}
                <span style={{color,fontSize:18,fontWeight:700,minWidth:60,textAlign:"right"}}>
                  {implied !== null ? `${implied.toFixed(1)}%` : "—"}
                </span>
              </div>
            </div>
          );
        })()}
        {(() => {
        if (trackedPlays.length === 0) return null;
        const settled = trackedPlays.filter(p => p.result && p.result !== "dnp");
        const wons = settled.filter(p => p.result === "won").length;

        // P&L calculations (only won/lost picks, DNP excluded)
        let totalStaked = 0, totalPL = 0;
        settled.forEach(p => {
          const stake = p.units != null ? p.units : Math.abs(p.americanOdds || 0) / 10;
          totalStaked += stake;
          if (p.result === "won") totalPL += stake * oddsToProfit(p.americanOdds);
          else totalPL -= stake;
        });
        const roi = totalStaked > 0 ? (totalPL / totalStaked) * 100 : null;
        const plColor = totalPL > 0 ? "#3fb950" : totalPL < 0 ? "#f78166" : "#8b949e";
        const fmt = n => (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2);
        // Average odds across settled picks (average decimal odds → back to American)
        const oddsSettled = settled.filter(p => p.americanOdds != null);
        const avgDecOdds = oddsSettled.length > 0
          ? oddsSettled.reduce((s, p) => s + (p.americanOdds >= 0 ? p.americanOdds/100+1 : 100/Math.abs(p.americanOdds)+1), 0) / oddsSettled.length
          : null;
        const avgAmerican = avgDecOdds != null
          ? avgDecOdds >= 2 ? Math.round((avgDecOdds-1)*100) : Math.round(-100/(avgDecOdds-1))
          : null;
        const avgOddsStr = avgAmerican != null ? (avgAmerican >= 0 ? `+${avgAmerican}` : `${avgAmerican}`) : null;

        return (
          <div>
            {/* Header row */}
            <div style={{display:"flex",alignItems:"center",marginBottom:12,gap:8,flexWrap:"wrap"}}>
              <div style={{color:"#c9d1d9",fontSize:15,fontWeight:700}}>My Picks</div>
              <span style={{background:"#21262d",borderRadius:10,padding:"1px 8px",fontSize:11,color:"#8b949e"}}>
                {trackedPlays.length}
              </span>
              {(() => {
                const activeCount = trackedPlays.filter(p => !p.result).length;
                const finishedCount = trackedPlays.filter(p => p.result && p.result !== "dnp").length;
                return (
                  <span style={{fontSize:11,color:"#484f58"}}>
                    <span style={{color:"#3fb950"}}>{activeCount} active</span>
                    {" · "}
                    <span style={{color:"#8b949e"}}>{finishedCount} finished</span>
                  </span>
                );
              })()}
              <button onClick={() => setShowAddPick(true)}
                style={{fontSize:11,padding:"2px 10px",borderRadius:6,cursor:"pointer",
                  border:"1px solid #238636",background:"rgba(35,134,54,0.15)",color:"#3fb950",fontWeight:600}}>
                + Add
              </button>
              {/* Bankroll input */}
              <div style={{display:"flex",alignItems:"center",gap:6,marginLeft:"auto"}}>
                <span style={{color:"#484f58",fontSize:11}}>Bankroll</span>
                <div style={{display:"flex",alignItems:"center",background:"#0d1117",border:"1px solid #30363d",borderRadius:6,overflow:"hidden"}}>
                  <span style={{color:"#8b949e",fontSize:12,padding:"2px 6px 2px 8px"}}>$</span>
                  <input type="number" min="1" value={bankroll}
                    onChange={e => setBankroll(e.target.value)}
                    style={{background:"transparent",border:"none",outline:"none",color:"#c9d1d9",
                      fontSize:12,width:70,padding:"3px 6px 3px 0"}}/>
                </div>
              </div>
            </div>

            {/* P&L Summary */}
            {settled.length > 0 && (
              <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:10,padding:"12px 16px",marginBottom:12}}>
                <div style={{display:"flex",gap:20,flexWrap:"wrap",alignItems:"flex-start"}}>
                  <div>
                    <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Record</div>
                    <div style={{fontSize:13,fontWeight:700}}>
                      <span style={{color:"#3fb950"}}>{wons}W</span>
                      <span style={{color:"#484f58"}}> – </span>
                      <span style={{color:"#f78166"}}>{settled.length - wons}L</span>
                      <span style={{color:"#8b949e",fontSize:11,fontWeight:400,marginLeft:5}}>
                        ({((wons / settled.length) * 100).toFixed(0)}%)
                      </span>
                    </div>
                  </div>
                  <div>
                    <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Net P&L</div>
                    <div style={{color:plColor,fontSize:13,fontWeight:700}}>{fmt(totalPL)}</div>
                  </div>
                  {roi !== null && (
                    <div>
                      <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>ROI</div>
                      <div style={{color:plColor,fontSize:13,fontWeight:700}}>
                        {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                      </div>
                    </div>
                  )}
                  {avgOddsStr && (
                    <div>
                      <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Avg odds</div>
                      <div style={{color:"#c9d1d9",fontSize:13,fontWeight:700}}>{avgOddsStr}</div>
                    </div>
                  )}
                  <div style={{marginLeft:"auto"}}>
                    <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Group by</div>
                    <select value={chartGroupBy} onChange={e => setChartGroupBy(e.target.value)}
                      style={{background:"#0d1117",border:"1px solid #30363d",borderRadius:4,color:"#8b949e",fontSize:11,padding:"2px 6px",cursor:"pointer",outline:"none"}}>
                      <option value="day">Day</option>
                      <option value="week">Week</option>
                      <option value="month">Month</option>
                      <option value="year">Year</option>
                    </select>
                  </div>
                </div>
                {/* P&L bar chart */}
                {(() => {
                  const playsWithPL = [...trackedPlays]
                    .filter(p => p.result && p.result !== "dnp")
                    .sort((a, b) => (a.gameDate || "").localeCompare(b.gameDate || "") || a.trackedAt - b.trackedAt)
                    .map(p => {
                      const s = p.units != null ? p.units : Math.abs(p.americanOdds || 0) / 10;
                      const pl = p.result === "won" ? s * oddsToProfit(p.americanOdds) : -s;
                      const dateKey = p.gameDate || new Date(p.trackedAt).toISOString().slice(0,10);
                      const barLabel = p.gameType === "total"
                        ? `${p.awayTeam}@${p.homeTeam} O${(p.threshold-0.5).toFixed(1)}`
                        : `${p.playerName} ${p.threshold}+ ${p.stat?.toUpperCase?.() || ""}`.trim();
                      return { pl, dateKey, barLabel };
                    });
                  if (!playsWithPL.length) return null;
                  // Bucket key + label per groupBy
                  const toBucket = (dateKey) => {
                    const [yr, mo, dy] = dateKey.split("-").map(Number);
                    if (chartGroupBy === "month") return { key: `${yr}-${String(mo).padStart(2,"0")}`, label: new Date(yr, mo-1, 1).toLocaleDateString("en-US", { month:"short", year:"2-digit" }) };
                    if (chartGroupBy === "year")  return { key: `${yr}`, label: `${yr}` };
                    if (chartGroupBy === "week") {
                      const d = new Date(yr, mo-1, dy);
                      const dow = d.getDay(); // 0=Sun
                      const mon = new Date(d); mon.setDate(d.getDate() - ((dow + 6) % 7));
                      const wKey = mon.toISOString().slice(0,10);
                      const wLabel = mon.toLocaleDateString("en-US", { month:"short", day:"numeric" });
                      return { key: wKey, label: wLabel };
                    }
                    // day (default)
                    return { key: dateKey, label: new Date(yr, mo-1, dy).toLocaleDateString("en-US", { month:"short", day:"numeric" }) };
                  };
                  const bucketMap = {};
                  playsWithPL.forEach(p => {
                    const { key, label } = toBucket(p.dateKey);
                    if (!bucketMap[key]) bucketMap[key] = { key, label, pl: 0, wins: 0, losses: 0, plays: [] };
                    bucketMap[key].pl += p.pl;
                    if (p.pl > 0) bucketMap[key].wins += p.pl;
                    else if (p.pl < 0) bucketMap[key].losses += Math.abs(p.pl);
                    bucketMap[key].plays.push(p);
                  });
                  const days = Object.values(bucketMap).sort((a,b) => a.key.localeCompare(b.key));
                  const maxAbs = Math.max(...days.map(d => Math.max(d.wins, d.losses)), 0.01);
                  const HALF = 60;
                  const yMax = maxAbs;
                  const yTicks = [yMax, yMax/2, 0, -yMax/2, -yMax];
                  return (
                    <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #21262d"}}>
                      <div style={{display:"flex",gap:4}}>
                        {/* Y-axis labels */}
                        <div style={{display:"flex",flexDirection:"column",justifyContent:"space-between",height:HALF*2+20,paddingBottom:20,flexShrink:0}}>
                          {yTicks.map((v,i) => (
                            <div key={i} style={{color:"#484f58",fontSize:9,textAlign:"right",lineHeight:1}}>
                              {v >= 0 ? "+" : ""}${Math.abs(v).toFixed(v === 0 ? 0 : 1)}
                            </div>
                          ))}
                        </div>
                        {/* Bars + x-axis */}
                        <div style={{flex:1,display:"flex",flexDirection:"column"}}>
                          <div style={{position:"relative",height:HALF*2,display:"flex",gap:3,alignItems:"stretch"}}>
                            <div style={{position:"absolute",left:0,right:0,top:HALF,height:1,background:"#30363d",zIndex:1}}/>
                            {days.map((day, i) => (
                              <DayBar key={i} day={day} HALF={HALF} maxAbs={maxAbs} />
                            ))}
                          </div>
                          {/* X-axis labels */}
                          <div style={{display:"flex",gap:3,marginTop:3}}>
                            {days.map((day, i) => (
                              <div key={i} style={{flex:1,textAlign:"center",color:"#484f58",fontSize:8,lineHeight:1.2,overflow:"hidden"}}>
                                {day.label}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}


            {/* Pick cards — grouped by week → day, collapsible */}
            {(() => {
              const toWeekKey = dk => {
                const [yr, mo, dy] = dk.split("-").map(Number);
                const d = new Date(yr, mo-1, dy);
                const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
                return mon.toLocaleDateString("en-CA");
              };
              const sorted = [...trackedPlays].sort((a, b) => {
                const aDate = a.gameDate || new Date(a.trackedAt).toISOString().slice(0,10);
                const bDate = b.gameDate || new Date(b.trackedAt).toISOString().slice(0,10);
                if (bDate !== aDate) return bDate < aDate ? -1 : 1;
                const aOpen = !a.result, bOpen = !b.result;
                if (aOpen !== bOpen) return aOpen ? -1 : 1;
                return b.trackedAt - a.trackedAt;
              });
              // Group by week → day
              const weekOrder = []; const weekMap = {};
              sorted.forEach(pick => {
                const dk = pick.gameDate || new Date(pick.trackedAt).toISOString().slice(0,10);
                const wk = toWeekKey(dk);
                if (!weekMap[wk]) { weekMap[wk] = { wk, dayOrder: [], dayMap: {} }; weekOrder.push(weekMap[wk]); }
                const w = weekMap[wk];
                if (!w.dayMap[dk]) { w.dayMap[dk] = { dk, picks: [] }; w.dayOrder.push(w.dayMap[dk]); }
                w.dayMap[dk].picks.push(pick);
              });
              const todayKey = new Date().toLocaleDateString("en-CA");
              const yesterdayKey = (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toLocaleDateString("en-CA"); })();
              const toggleDay = dk => setOpenPickDays(prev => { const n = new Set(prev); n.has(dk) ? n.delete(dk) : n.add(dk); return n; });
              const toggleWeek = wk => setOpenPickWeeks(prev => { const n = new Set(prev); n.has(wk) ? n.delete(wk) : n.add(wk); return n; });
              const calcPL = picks => {
                const settled = picks.filter(p => p.result && p.result !== "dnp");
                if (!settled.length) return null;
                return settled.reduce((sum, p) => {
                  const s = p.units != null ? p.units : Math.abs(p.americanOdds || 0) / 10;
                  return sum + (p.result === "won" ? s * oddsToProfit(p.americanOdds) : -s);
                }, 0);
              };
              return weekOrder.map(({ wk, dayOrder }) => {
                const weekOpen = openPickWeeks.has(wk);
                const [wyr, wmo, wdy] = wk.split("-").map(Number);
                const weekLabel = "Week of " + new Date(wyr, wmo-1, wdy).toLocaleDateString("en-US", { month:"short", day:"numeric" });
                const allWeekPicks = dayOrder.flatMap(d => d.picks);
                const weekPL = calcPL(allWeekPicks);
                const weekActive = allWeekPicks.filter(p => !p.result).length;
                const weekPLColor = weekPL > 0 ? "#3fb950" : weekPL < 0 ? "#f78166" : "#8b949e";
                return (
                  <div key={wk} style={{marginBottom:8}}>
                    {/* Week header */}
                    <div onClick={() => toggleWeek(wk)}
                      style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",
                        background:"#161b22",border:"1px solid #30363d",borderRadius:weekOpen ? "8px 8px 0 0" : 8,
                        cursor:"pointer",userSelect:"none"}}>
                      <span style={{color:"#8b949e",fontSize:11,display:"inline-block",
                        transition:"transform 0.15s",transform:weekOpen?"rotate(90deg)":"rotate(0deg)"}}>▸</span>
                      <span style={{color:"#e6edf3",fontSize:12,fontWeight:700}}>{weekLabel}</span>
                      <span style={{background:"#21262d",borderRadius:8,padding:"0px 6px",fontSize:10,color:"#8b949e"}}>
                        {allWeekPicks.length}
                      </span>
                      {weekActive > 0 && <span style={{fontSize:10,color:"#3fb950"}}>{weekActive} active</span>}
                      {weekPL !== null && (
                        <span style={{marginLeft:"auto",fontSize:12,fontWeight:700,color:weekPLColor}}>
                          {weekPL >= 0 ? "+" : ""}${Math.abs(weekPL).toFixed(2)}
                        </span>
                      )}
                    </div>
                    {/* Day groups inside this week */}
                    {weekOpen && (
                      <div style={{border:"1px solid #30363d",borderTop:"none",borderRadius:"0 0 8px 8px",padding:"6px 6px 2px 6px"}}>
                        {dayOrder.map(({ dk, picks: dayPicks }) => {
                          const dayOpen = openPickDays.has(dk);
                          const [yr, mo, dy] = dk.split("-").map(Number);
                          const dayLabel = dk === todayKey ? "Today" : dk === yesterdayKey ? "Yesterday"
                            : new Date(yr, mo-1, dy).toLocaleDateString("en-US", { month:"short", day:"numeric" });
                          const dayPL = calcPL(dayPicks);
                          const dayPLColor = dayPL > 0 ? "#3fb950" : dayPL < 0 ? "#f78166" : "#8b949e";
                          const dayActive = dayPicks.filter(p => !p.result).length;
                          return (
                            <div key={dk} style={{marginBottom:4}}>
                              {/* Day header */}
                              <div onClick={() => toggleDay(dk)}
                                style={{display:"flex",alignItems:"center",gap:8,padding:"5px 10px",
                                  background:"#0d1117",border:"1px solid #21262d",borderRadius:dayOpen ? "6px 6px 0 0" : 6,
                                  cursor:"pointer",userSelect:"none"}}>
                                <span style={{color:"#484f58",fontSize:10,display:"inline-block",
                                  transition:"transform 0.15s",transform:dayOpen?"rotate(90deg)":"rotate(0deg)"}}>▸</span>
                                <span style={{color:"#c9d1d9",fontSize:11,fontWeight:600}}>{dayLabel}</span>
                                <span style={{background:"#21262d",borderRadius:8,padding:"0px 5px",fontSize:10,color:"#8b949e"}}>
                                  {dayPicks.length}
                                </span>
                                {dayActive > 0 && <span style={{fontSize:10,color:"#3fb950"}}>{dayActive} active</span>}
                                {dayPL !== null && (
                                  <span style={{marginLeft:"auto",fontSize:11,fontWeight:700,color:dayPLColor}}>
                                    {dayPL >= 0 ? "+" : ""}${Math.abs(dayPL).toFixed(2)}
                                  </span>
                                )}
                              </div>
                              {/* Pick cards */}
                              {dayOpen && (
                                <div style={{border:"1px solid #21262d",borderTop:"none",borderRadius:"0 0 6px 6px",padding:"5px 5px 1px 5px"}}>
                                  {dayPicks.map(pick => {
              const oddsStr = pick.americanOdds >= 0 ? `+${pick.americanOdds}` : `${pick.americanOdds}`;
              const resultColor = pick.result === "won" ? "#3fb950" : pick.result === "lost" ? "#f78166" : pick.result === "dnp" ? "#8b949e" : null;
              const units = pick.units != null ? pick.units : Math.abs(pick.americanOdds || 0) / 10;
              const stake = units;
              let pickPL = null;
              if (pick.result === "won") pickPL = stake * oddsToProfit(pick.americanOdds);
              else if (pick.result === "lost") pickPL = -stake;
              // DNP = void, pickPL stays null
              const pickPLColor = pickPL > 0 ? "#3fb950" : pickPL < 0 ? "#f78166" : "#8b949e";
              return (
                <div key={pick.id} style={{background:"#161b22",
                  border:`1px solid ${resultColor ? resultColor + "44" : "#30363d"}`,
                  borderRadius:8, padding:"7px 10px", marginBottom:5,
                  display:"flex", gap:9, alignItems:"center"}}>
                  {/* Photo / Logo */}
                  {pick.gameType === "teamTotal" ? (
                    <div style={{width:36,height:36,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:"#21262d",borderRadius:18}}>
                      <img src={`https://a.espncdn.com/i/teamlogos/${pick.sport}/500/${(pick.scoringTeam||"").toLowerCase()}.png`}
                        style={{width:28,height:28,objectFit:"contain"}} onError={e=>e.target.style.opacity="0"} />
                    </div>
                  ) : pick.gameType === "total" ? (
                    <div style={{width:36,height:36,flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1}}>
                      <img src={`https://a.espncdn.com/i/teamlogos/${pick.sport}/500/${(pick.awayTeam||"").toLowerCase()}.png`}
                        style={{width:19,height:19,objectFit:"contain"}} onError={e=>e.target.style.opacity="0"} />
                      <img src={`https://a.espncdn.com/i/teamlogos/${pick.sport}/500/${(pick.homeTeam||"").toLowerCase()}.png`}
                        style={{width:19,height:19,objectFit:"contain"}} onError={e=>e.target.style.opacity="0"} />
                    </div>
                  ) : (
                    <div style={{width:36,height:36,flexShrink:0,borderRadius:18,background:"#21262d",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {pick.playerId ? (
                        <img src={`https://a.espncdn.com/i/headshots/${pick.sport}/players/full/${pick.playerId}.png`}
                          style={{width:36,height:36,objectFit:"cover",objectPosition:"top center"}}
                          onError={e=>{e.target.style.display="none";}} />
                      ) : (
                        <span style={{color:"#484f58",fontSize:14,fontWeight:700}}>{(pick.playerName||"?").charAt(0)}</span>
                      )}
                    </div>
                  )}
                  {/* Content */}
                  <div style={{flex:1,minWidth:0}}>
                    {/* Row 1: name + badges + (settled: result+P&L+undo) + edit/remove */}
                    <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                      {pick.gameType === "teamTotal" ? (
                        <span style={{color:"#fff",fontSize:12,fontWeight:700,flexShrink:1,minWidth:0}}>
                          <span onClick={()=>navigateToTeam(pick.scoringTeam,pick.sport)} style={{cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{pick.scoringTeam}</span>
                          <span style={{color:"#484f58",fontWeight:400}}> vs {pick.oppTeam}</span>
                        </span>
                      ) : pick.gameType === "total" ? (
                        <span style={{color:"#fff",fontSize:12,fontWeight:700,flexShrink:1,minWidth:0}}>
                          <span onClick={()=>navigateToTeam(pick.awayTeam,pick.sport)} style={{cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{pick.awayTeam}</span>
                          {" @ "}
                          <span onClick={()=>navigateToTeam(pick.homeTeam,pick.sport)} style={{cursor:"pointer",textDecoration:"underline",textDecorationColor:"#484f58"}}>{pick.homeTeam}</span>
                        </span>
                      ) : (
                        <span onClick={() => navigateToPlay(pick)}
                          style={{color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",textDecoration:"underline",textDecorationColor:"#30363d",textUnderlineOffset:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:140,flexShrink:1}}>
                          {pick.playerName}
                        </span>
                      )}
                      {pick.sport && (
                        <span style={{border:`1px solid ${SPORT_BADGE_COLOR[pick.sport]||"#8b949e"}`,
                          borderRadius:4,padding:"0px 4px",fontSize:9,color:SPORT_BADGE_COLOR[pick.sport]||"#8b949e",fontWeight:600,textTransform:"uppercase",flexShrink:0}}>
                          {pick.sport}
                        </span>
                      )}
                      {pick.edge != null && (
                        <span style={{background:"rgba(63,185,80,0.12)",border:"1px solid #3fb950",borderRadius:4,
                          padding:"0px 5px",fontSize:10,color:"#3fb950",fontWeight:700,flexShrink:0}}>
                          +{pick.edge}%
                        </span>
                      )}
                      {pick.result && (
                        <span style={{fontSize:10,fontWeight:700,color:resultColor,textTransform:"uppercase",letterSpacing:0.3,flexShrink:0}}>
                          {pick.result === "won" ? "✓ Won" : pick.result === "lost" ? "✗ Lost" : "— DNP"}
                        </span>
                      )}
                      {pickPL !== null && (
                        <span style={{fontSize:10,fontWeight:700,color:pickPLColor,flexShrink:0}}>
                          {fmt(pickPL)}
                        </span>
                      )}
                      <div style={{flex:1}} />
                      {pick.result && (
                        <button onClick={() => setPlayResult(pick.id, null)}
                          style={{background:"transparent",border:"1px solid #30363d",borderRadius:5,
                            padding:"2px 6px",fontSize:11,color:"#484f58",cursor:"pointer",flexShrink:0}}>
                          ↺
                        </button>
                      )}
                      <button onClick={() => setEditPickId(id => id === pick.id ? null : pick.id)} title="Edit"
                        style={{background: editPickId === pick.id ? "rgba(88,166,255,0.12)" : "transparent",
                          border:`1px solid ${editPickId === pick.id ? "#58a6ff" : "#30363d"}`,borderRadius:5,
                          padding:"2px 6px",fontSize:10,color: editPickId === pick.id ? "#58a6ff" : "#484f58",cursor:"pointer",flexShrink:0}}>
                        ✎
                      </button>
                      <button onClick={() => untrackPlay(pick.id)} title="Remove"
                        style={{background:"transparent",border:"1px solid #30363d",borderRadius:5,
                          padding:"2px 6px",fontSize:11,color:"#484f58",cursor:"pointer",flexShrink:0}}>
                        ×
                      </button>
                    </div>
                    {/* Row 2: subtitle + stake + (active: icon buttons / settled: win profit) */}
                    <div style={{display:"flex",alignItems:"center",gap:0}}>
                      <div style={{flex:1,minWidth:0,display:"flex",alignItems:"center",flexWrap:"wrap",lineHeight:1.4}}>
                        {pick.gameType !== "total" && pick.gameType !== "teamTotal" && (
                          <span style={{color:"#8b949e",fontSize:10}}>
                            {pick.playerTeam} vs {pick.opponent}
                            <span style={{color:"#484f58",margin:"0 3px"}}>·</span>
                          </span>
                        )}
                        <span style={{color:"#58a6ff",fontWeight:600,fontSize:10}}>
                          {pick.gameType === "teamTotal"
                            ? `Over ${(pick.threshold-0.5).toFixed(1)} ${({teamRuns:"Runs",teamPoints:"Pts"})[pick.stat]||pick.stat}`
                            : pick.gameType === "total"
                            ? `${pick.direction === "under" ? "Under" : "Over"} ${(pick.threshold-0.5).toFixed(1)} ${({totalRuns:"Runs",totalPoints:"Pts",totalGoals:"Goals"})[pick.stat]||pick.stat}`
                            : `${pick.threshold}+ ${STAT_LABEL[pick.stat] || pick.stat}`}
                        </span>
                        <span style={{color:"#484f58",fontSize:10,margin:"0 3px"}}>·</span>
                        <span style={{color:"#a855f7",fontSize:10}}>{oddsStr}</span>
                        <span style={{color:"#484f58",fontSize:10,margin:"0 3px"}}>·</span>
                        <span style={{color:"#e3b341",fontSize:10}}>{pick.direction === "under" ? (pick.noTruePct ?? pick.truePct) : pick.truePct}% true</span>
                        <span style={{color:"#484f58",fontSize:10,margin:"0 3px"}}>·</span>
                        <span style={{color:"#484f58",fontSize:10}}>$</span>
                        <input type="number" min="0" step="0.1" value={units}
                          onChange={e => setPickUnits(pick.id, e.target.value)}
                          style={{background:"transparent",border:"none",outline:"none",color:"#c9d1d9",
                            fontSize:10,width:46,padding:"0 2px",textAlign:"left"}}/>
                      </div>
                      {!pick.result && (
                        <div style={{display:"flex",gap:4,flexShrink:0,marginLeft:6}}>
                          {[["won","rgba(63,185,80,0.12)","#3fb950","✓","Won"],["lost","rgba(247,129,102,0.12)","#f78166","✗","Lost"],["dnp","rgba(139,148,158,0.12)","#484f58","–","DNP"]].map(([res,bg,bdr,icon,lbl]) => (
                            <button key={res} onClick={() => setPlayResult(pick.id, res)} title={lbl}
                              style={{background:bg,border:`1px solid ${bdr}`,borderRadius:5,
                                padding:"2px 6px",fontSize:10,fontWeight:700,
                                color:res==="dnp"?"#8b949e":bdr,cursor:"pointer",flexShrink:0}}>
                              {icon}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Edit mode: full inline form */}
                    {editPickId === pick.id && (() => {
                      const SPORT_STATS_EDIT = {
                        nba:["points","rebounds","assists","threePointers"],
                        mlb:["hits","hrr","strikeouts"],
                        nfl:["passingYards","rushingYards","receivingYards","receptions"],
                        nhl:["points"],
                      };
                      const ei = { background:"#0d1117", border:"1px solid #30363d", borderRadius:5, color:"#c9d1d9", fontSize:12, padding:"4px 7px", outline:"none", width:"100%" };
                      return (
                        <div style={{marginTop:8,padding:10,background:"#0d1117",borderRadius:7,border:"1px solid #30363d"}}>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Stat</div>
                              <select style={ei} value={pick.stat}
                                onChange={e => setTrackedPlays(prev => prev.map(p => p.id === pick.id ? {...p, stat: e.target.value} : p))}>
                                {(SPORT_STATS_EDIT[pick.sport] || []).map(s => <option key={s} value={s}>{STAT_LABEL[s] || s}</option>)}
                              </select>
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Stake ($)</div>
                              <input style={ei} type="number" min="0" step="0.1" defaultValue={units}
                                onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setPickUnits(pick.id, v); }} />
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Line</div>
                              <input style={ei} type="number" step="0.5" defaultValue={pick.threshold}
                                onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setTrackedPlays(prev => prev.map(p => p.id === pick.id ? {...p, threshold: v} : p)); }} />
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Odds</div>
                              <input style={ei} type="number" defaultValue={pick.americanOdds}
                                onBlur={e => { const v = parseInt(e.target.value); if (!isNaN(v)) setTrackedPlays(prev => prev.map(p => p.id === pick.id ? {...p, americanOdds: v, kalshiPct: parseFloat((v < 0 ? Math.abs(v)/(Math.abs(v)+100)*100 : 100/(v+100)*100).toFixed(1))} : p)); }} />
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>True Prob %</div>
                              <input style={ei} type="number" min="0" max="100" step="0.1" defaultValue={pick.truePct ?? ""}
                                onBlur={e => { const v = parseFloat(e.target.value); setTrackedPlays(prev => prev.map(p => { if (p.id !== pick.id) return p; const kp = p.kalshiPct ?? p.americanOdds < 0 ? Math.abs(p.americanOdds)/(Math.abs(p.americanOdds)+100)*100 : 100/(p.americanOdds+100)*100; return {...p, truePct: isNaN(v) ? null : v, edge: isNaN(v) ? null : parseFloat((v - kp).toFixed(1))}; })); }} />
                            </div>
                            <div>
                              <div style={{color:"#484f58",fontSize:10,marginBottom:3}}>Game Date</div>
                              <input style={ei} type="date" defaultValue={pick.gameDate || ""}
                                onBlur={e => { const v = e.target.value; setTrackedPlays(prev => prev.map(p => p.id === pick.id ? {...p, gameDate: v || null} : p)); }} />
                            </div>
                          </div>
                          <button onClick={() => setEditPickId(null)}
                            style={{width:"100%",padding:"4px",borderRadius:5,background:"rgba(88,166,255,0.12)",border:"1px solid #58a6ff",color:"#58a6ff",fontSize:11,fontWeight:600,cursor:"pointer"}}>
                            done
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                </div>
                                  );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              });
            })()}

          </div>
        );
      })()}
        </div>
        </div>
      )}

      <div style={{color:"#484f58",fontSize:11,marginTop:12,textAlign:"center"}}>
        Powered by ESPN API · via Cloudflare Worker proxy
      </div>
    </div>
  );
}


export default App;
