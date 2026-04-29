import React from 'react';
import { WORKER, SPORTS, STAT_FULL, MLB_TEAM, TEAM_DB, TOTAL_THRESHOLDS, STAT_LABEL, SPORT_KEY, TODAY, MOCK_PLAYS, SPORT_BADGE_COLOR, GAMELOG_COLS } from './lib/constants.js';
import { lsGet, lsSet, ordinal, slugify, teamUrl } from './lib/utils.js';
import { getColor, matchupColor, tierColor } from './lib/colors.js';
import TotalsBarChart from './components/TotalsBarChart.jsx';
import TeamPage, { STAT_CONFIGS } from './components/TeamPage.jsx';
import DayBar from './components/DayBar.jsx';
import { useDebounce } from './components/AddPickModal.jsx';
import AddPickModal from './components/AddPickModal.jsx';
import ModelPage from './components/ModelPage.jsx';
import MarketReport from './components/MarketReport.jsx';
import MyPicksColumn from './components/MyPicksColumn.jsx';
import LineupsPage from './components/LineupsPage.jsx';

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
  const [mlbMeta, setMlbMeta] = React.useState(null); // pitchers, ML odds, umpires, weather
  const [mlbMetaTomorrow, setMlbMetaTomorrow] = React.useState(null); // tomorrow's probables + umpires
  const [nbaMeta, setNbaMeta] = React.useState(null); // NBA game odds + injuries
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
  const [pendingTrackPlay, setPendingTrackPlay] = React.useState(null);
  const [pendingOdds, setPendingOdds] = React.useState("-110");
  const [openPickDays, setOpenPickDays] = React.useState(() => new Set([new Date().toLocaleDateString("en-CA")]));
  const [openPickWeeks, setOpenPickWeeks] = React.useState(() => {
    const d = new Date(); const dow = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - ((dow + 6) % 7));
    return new Set([mon.toLocaleDateString("en-CA")]);
  });
  const [showAddPick, setShowAddPick] = React.useState(false);
  const [showPicksDrawer, setShowPicksDrawer] = React.useState(false);
  const [flyingPick, setFlyingPick] = React.useState(null);
  const [starClickOrigin, setStarClickOrigin] = React.useState(null);
  const [authToken, setAuthToken] = React.useState(() => localStorage.getItem("sb_token") || null);
  const [authEmail, setAuthEmail] = React.useState(() => localStorage.getItem("sb_email") || null);
  const [showAuthModal, setShowAuthModal] = React.useState(false);
  const [authMode, setAuthMode] = React.useState("login");
  const [authForm, setAuthForm] = React.useState({ email:"", password:"" });
  const [authError, setAuthError] = React.useState("");
  const [authLoading, setAuthLoading] = React.useState(false);
  const [syncStatus, setSyncStatus] = React.useState(null); // "saving"|"saved"|"error"
  const syncTimer = React.useRef(null);
  const fabRef = React.useRef(null);
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
    const _applyData = (data) => { const all = data.plays || []; setAllTonightPlays(all); setNbaDropped(data.nbaDropped || []); setTonightPlays(all.filter(p => p.qualified !== false && (p.finalSimScore == null || p.finalSimScore >= 8) && (p.hitterFinalSimScore == null || p.hitterFinalSimScore >= 8))); setTonightMeta({ qualifyingCount: data.qualifyingCount, preFilteredCount: data.preFilteredCount }); if (data.mlbMeta) setMlbMeta(data.mlbMeta); if (data.mlbMetaTomorrow) setMlbMetaTomorrow(data.mlbMetaTomorrow); if (data.nbaMeta) setNbaMeta(data.nbaMeta); };
    if (_sc) { _applyData(_sc); setTonightLoading(false); return; }
    let cancelled = false;
    setTonightLoading(true);
    fetch(`${WORKER}/tonight`)
      .then(r => r.json())
      .then(data => { if (cancelled) return; try { sessionStorage.setItem(_sk, JSON.stringify({ts: Date.now(), data})); } catch {} _applyData(data); setTonightLoading(false); })
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
      .then(data => { const all = data.plays || []; setAllTonightPlays(all); setNbaDropped(data.nbaDropped || []); setTonightPlays(all.filter(p => p.qualified !== false && (p.finalSimScore == null || p.finalSimScore >= 8) && (p.hitterFinalSimScore == null || p.hitterFinalSimScore >= 8))); setTonightMeta({ qualifyingCount: data.qualifyingCount, preFilteredCount: data.preFilteredCount }); if (data.mlbMeta) setMlbMeta(data.mlbMeta); if (data.mlbMetaTomorrow) setMlbMetaTomorrow(data.mlbMetaTomorrow); if (data.nbaMeta) setNbaMeta(data.nbaMeta); setTonightLoading(false); setBustLoading(false); })
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
    const savedOdds = play.americanOdds ?? -110;
    setTrackedPlays(prev => {
      if (prev.find(p => p.id === id)) return prev;
      return [{ ...play, id, trackedAt: Date.now(), result: null,
        units: tierUnits(savedOdds),
        americanOdds: savedOdds,
      }, ...prev];
    });
  }
  function initiateTrack(play, event) {
    if (event) {
      const rect = event.currentTarget.getBoundingClientRect();
      setStarClickOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    } else {
      setStarClickOrigin(null);
    }
    const odds = play.americanOdds;
    const defaultOdds = odds != null ? (odds > 0 ? `+${odds}` : `${odds}`) : "-110";
    setPendingOdds(defaultOdds);
    setPendingTrackPlay(play);
  }
  function triggerFlyAnimation() {
    if (!starClickOrigin || !fabRef.current) return;
    const fabRect = fabRef.current.getBoundingClientRect();
    setFlyingPick({
      x: starClickOrigin.x,
      y: starClickOrigin.y,
      destX: fabRect.left + fabRect.width / 2,
      destY: fabRect.top + fabRect.height / 2,
      key: Date.now(),
    });
    setStarClickOrigin(null);
  }
  function openPickDate(gameDate) {
    const dk = gameDate || new Date().toLocaleDateString("en-CA");
    const [yr, mo, dy] = dk.split("-").map(Number);
    const d = new Date(yr, mo - 1, dy);
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const wk = mon.toLocaleDateString("en-CA");
    setOpenPickDays(prev => new Set([...prev, dk]));
    setOpenPickWeeks(prev => new Set([...prev, wk]));
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
      // Resolve ESPN athlete ID by name search when ID is missing
      let resolvedId = p.id;
      if (!resolvedId && p.name) {
        try {
          const r = await fetch(`${WORKER}/athletes?q=${encodeURIComponent(p.name)}`);
          const d = await r.json();
          const items = d.items || [];
          const m = items.find(a => a.name.toLowerCase() === p.name.toLowerCase()) || items[0];
          if (m) { resolvedId = m.id; setPlayer(prev => ({ ...prev, id: m.id })); }
        } catch {}
        if (fetchRef.current !== id) return;
        if (!resolvedId) { setError('Player not found'); setLoading(false); return; }
      }
      const teamParam = p.team ? `&team=${encodeURIComponent(p.team)}` : "";
      if (sp === "baseball/mlb") {
        // Fetch 3 seasons in parallel for full h2h history, plus dvp for tonight's matchup
        const [d26, d25, d24, dv] = await Promise.all([
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${resolvedId}&season=2026`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${resolvedId}&season=2025`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${resolvedId}&season=2024`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${WORKER}/dvp?sport=${sp}&athleteId=${resolvedId}${teamParam}`),
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
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${resolvedId}&season=${season}`),
          fetch(`${WORKER}/dvp?sport=${sp}&athleteId=${resolvedId}${teamParam}`),
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
      {showReport && <MarketReport
        onClose={() => setShowReport(false)}
        fetchReport={fetchReport}
        reportDataBySport={reportDataBySport}
        reportSport={reportSport}
        setReportSport={setReportSport}
        reportLoadingSport={reportLoadingSport}
        reportSort={reportSort}
        setReportSort={setReportSort}
        navigateToPlayer={navigateToPlayer}
        navigateToTeam={navigateToTeam}
      />}

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
          initialOdds="-110"
        />
      )}

      {/* Confirm pick modal */}
      {pendingTrackPlay && (() => {
        const play = pendingTrackPlay;
        const raw = pendingOdds.trim();
        const n = parseInt(raw, 10);
        let implied = null;
        if (!isNaN(n) && raw !== "" && raw !== "-" && raw !== "+") {
          if (n < 0) implied = Math.abs(n) / (Math.abs(n) + 100) * 100;
          else if (n > 0) implied = 100 / (n + 100) * 100;
        }
        const color = implied === null ? "#8b949e" : implied >= 70 ? "#3fb950" : implied >= 50 ? "#e3b341" : "#f78166";
        const name = play.playerName ?? (play.gameType === "total" ? `${play.awayTeam} @ ${play.homeTeam}` : play.scoringTeam ?? "");
        const statLabel = play.stat ? play.stat.toUpperCase() : play.sport ? play.sport.toUpperCase() : "";
        const dirLabel = play.direction === "under" ? `Under ${play.threshold}` : `Over ${play.threshold}`;
        const subtitle = play.playerName ? `${play.stat?.toUpperCase()} ${play.threshold}+` : dirLabel;
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",zIndex:700,display:"flex",alignItems:"center",justifyContent:"center"}}
            onClick={() => setPendingTrackPlay(null)}>
            <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,padding:"20px 22px",width:360}}
              onClick={e => e.stopPropagation()}>
              <div style={{fontSize:13,color:"#c9d1d9",fontWeight:600,marginBottom:2}}>{name}</div>
              <div style={{fontSize:11,color:"#8b949e",marginBottom:16}}>{subtitle} {statLabel && !play.playerName ? `· ${statLabel}` : ""}</div>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
                <span style={{fontSize:11,color:"#484f58",whiteSpace:"nowrap"}}>Odds</span>
                <input autoFocus type="text" inputMode="numeric" value={pendingOdds}
                  onChange={e => {
                    let v = e.target.value;
                    if (v.length > 0 && v[0] !== "-" && v[0] !== "+") v = "-" + v;
                    setPendingOdds(v);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      const _n = parseInt(pendingOdds.trim(), 10);
                      const oddsVal = !isNaN(_n) && pendingOdds.trim() !== "-" && pendingOdds.trim() !== "+" ? _n : null;
                      trackPlay(oddsVal ? { ...play, americanOdds: oddsVal } : play);
                      setPendingTrackPlay(null);
                      setShowPicksDrawer(true);
                      openPickDate(play.gameDate);
                      triggerFlyAnimation();
                    } else if (e.key === "Escape") {
                      setPendingTrackPlay(null);
                    }
                  }}
                  style={{flex:1,background:"#0d1117",border:"1px solid #30363d",borderRadius:7,
                    color:"#c9d1d9",fontSize:15,padding:"7px 10px",outline:"none",textAlign:"center"}}
                />
                <span style={{fontSize:16,fontWeight:700,color,minWidth:52,textAlign:"right",whiteSpace:"nowrap"}}>
                  {implied !== null ? `${implied.toFixed(1)}%` : "—"}
                </span>
              </div>
              {play.truePct != null && implied !== null && (
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                  marginBottom:14,fontSize:11,color:"#484f58"}}>
                  <span>Edge (True% − implied)</span>
                  {(() => {
                    const edge = parseFloat((play.truePct - implied).toFixed(1));
                    const edgeColor = edge >= 3 ? "#3fb950" : edge >= 0 ? "#e3b341" : "#f78166";
                    return <span style={{color:edgeColor,fontWeight:700}}>{edge >= 0 ? "+" : ""}{edge}%</span>;
                  })()}
                </div>
              )}
              <div style={{display:"flex",gap:8}}>
                <button onClick={() => setPendingTrackPlay(null)}
                  style={{flex:1,padding:"8px 0",fontSize:12,borderRadius:7,border:"1px solid #30363d",
                    background:"transparent",color:"#8b949e",cursor:"pointer"}}>
                  Cancel
                </button>
                <button onClick={() => {
                  const _n = parseInt(pendingOdds.trim(), 10);
                  const oddsVal = !isNaN(_n) && pendingOdds.trim() !== "-" && pendingOdds.trim() !== "+" ? _n : null;
                  trackPlay(oddsVal ? { ...play, americanOdds: oddsVal } : play);
                  setPendingTrackPlay(null);
                  setShowPicksDrawer(true);
                  openPickDate(play.gameDate);
                  triggerFlyAnimation();
                }}
                  style={{flex:1,padding:"8px 0",fontSize:12,borderRadius:7,border:"1px solid #3fb950",
                    background:"rgba(63,185,80,0.12)",color:"#3fb950",cursor:"pointer",fontWeight:600}}>
                  Add Pick
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Search + player card — constrained width */}
      <div style={{maxWidth:1280,margin:"0 auto"}}>
      {/* Full-width top row: search */}
      <div style={{marginBottom:22}}>
      <div style={{position:"relative"}}>
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
      </div>{/* end top row */}

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
                          const allKPlays = Object.values(tonightPlayerMap).filter(p => p.stat === "strikeouts");
                          const tp = allKPlays.reduce((best, p) => {
                            const sc = p.finalSimScore ?? p.simScore ?? -1;
                            const bsc = best ? (best.finalSimScore ?? best.simScore ?? -1) : -1;
                            return sc > bsc ? p : best;
                          }, null) ?? allKPlays[0] ?? null;
                          if (tp) return { opp: tp.opponent, lineupKPct: tp.lineupKPct ?? dvpData?.h2h?.lineupKPct ?? null, lineupKPctProjected: tp.lineupKPctProjected ?? dvpData?.h2h?.lineupKPctProjected ?? false,
                            pitcherCSWPct: tp.pitcherCSWPct, pitcherKPct: tp.pitcherKPct, pitcherKBBPct: tp.pitcherKBBPct, pitcherAvgPitches: tp.pitcherAvgPitches, log5Avg: tp.log5Avg,
                            pitcherRecentKPct: tp.pitcherRecentKPct ?? null, pitcherSeasonKPct: tp.pitcherSeasonKPct ?? null,
                            expectedKs: tp.expectedKs, parkFactor: tp.parkFactor, pitcherHand: tp.pitcherHand,
                            pitcherEra: tp.pitcherEra ?? null,
                            simScore: tp.simScore ?? null, finalSimScore: tp.finalSimScore ?? null,
                            kpctMeets: tp.kpctMeets, kpctPts: tp.kpctPts, kbbMeets: tp.kbbMeets, kbbPts: tp.kbbPts, lkpMeets: tp.lkpMeets, lkpPts: tp.lkpPts, pitchesPts: tp.pitchesPts, parkMeets: tp.parkMeets, mlPts: tp.mlPts, totalPts: tp.totalPts, kTrendPts: tp.kTrendPts, kHitRatePts: tp.kHitRatePts, kH2HHandPts: tp.kH2HHandPts, kH2HHandRate: tp.kH2HHandRate, kH2HHandStarts: tp.kH2HHandStarts, kH2HHandMaj: tp.kH2HHandMaj,
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
                          const ap = h2h?.pitcherAvgPitches ?? null;
                          const recK = h2h?.pitcherRecentKPct ?? null;
                          const seaK = h2h?.pitcherSeasonKPct ?? null;
                          const kH2HHandRate = h2h?.kH2HHandRate ?? null;
                          const kH2HHandStarts = h2h?.kH2HHandStarts ?? 0;
                          const kH2HHandMaj = h2h?.kH2HHandMaj ?? null;
                          const kH2HHandColor = kH2HHandRate == null ? "#8b949e" : kH2HHandRate >= 80 ? "#3fb950" : kH2HHandRate >= 65 ? "#e3b341" : "#f78166";
                          const apColor = ap == null ? "#8b949e" : ap > 85 ? "#3fb950" : ap > 75 ? "#e3b341" : "#f78166";
                          const pkpQual = pkp == null ? "" : csw != null ? (pkp >= 30 ? "elite" : pkp > 26 ? "above-average" : "below-average") : (pkp > 24 ? "above-average" : "below-average");
                          const apDesc = ap == null ? null : ap > 85 ? "expect him to work deep into the game" : ap > 75 ? "typically goes 5–6 innings" : null;
                          const lkpDesc = lkp == null ? null : lkp > 24 ? "a high-strikeout lineup — works in his favor" : lkp > 20 ? "below-average strikeout tendency" : "elite contact lineup — a tougher test";
                          const _sc = finalSimScore ?? simScore;
                          const scColor = _sc == null ? "#8b949e" : _sc >= 8 ? "#3fb950" : _sc >= 5 ? "#e3b341" : "#8b949e";
                          const scTitle = _sc != null ? [`CSW%/K%: ${h2h?.kpctPts ?? 1}/2`,`Lineup K%: ${h2h?.lkpPts ?? 1}/2`,`Hit Rate %: ${h2h?.kHitRatePts ?? 1}/2`,`H2H Hand: ${h2h?.kH2HHandPts ?? 1}/2`,`O/U: ${h2h?.totalPts ?? 1}/2`].join("\n") : null;
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
                                {ap != null && <>, averaging <span style={{color:apColor,fontWeight:600}}>{Math.round(ap)}</span> pitches/start{apDesc ? <span style={{color:"#8b949e"}}> — {apDesc}</span> : ""}</>}.
                                {lkp != null && <>{" "}The {oppName} lineup strikes out at <span style={{color:lkpColor,fontWeight:600}}>{lkp}%</span>{handLabel}{lkpProjected ? <span style={{color:"#484f58",fontSize:10}}> (est.)</span> : ""} — <span style={{color:"#8b949e"}}>{lkpDesc}</span>.</>}
                                {pf != null && Math.abs(pf - 1.0) >= 0.01 && <>{" "}Tonight's venue {pf > 1 ? "is strikeout-friendly" : "suppresses strikeouts"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}%</span>).</>}
                                {(recK != null || gameTotal != null) && <>{" "}{recK != null && <><span style={{color:h2h?.kTrendPts===2?"#3fb950":h2h?.kTrendPts===0?"#f78166":"#e3b341",fontWeight:600}}>{recK.toFixed(1)}%</span><span style={{color:"#8b949e"}}> recent K%{h2h?.kTrendPts===2?" ↑":h2h?.kTrendPts===0?" ↓":""}{seaK!=null?` (${seaK.toFixed(1)}% season)`:""}</span>{gameTotal != null ? <span style={{color:"#8b949e"}}>, </span> : <span style={{color:"#8b949e"}}>.</span>}</>}{gameTotal != null && <><span style={{color:"#8b949e"}}>game total </span><span style={{color:totalColor(gameTotal),fontWeight:600}}>{gameTotal}</span><span style={{color:"#8b949e"}}>{gameTotal <= 8.5 ? " — a low-scoring slate, favorable for strikeouts" : gameTotal <= 10.5 ? " — an average total" : " — a high-scoring total, tougher for Ks"}.</span></>}</>}
                                {kH2HHandRate != null && kH2HHandStarts >= 5 && <>{" "}In <span style={{color:"#8b949e"}}>{kH2HHandStarts} starts vs {kH2HHandMaj === "R" ? "right" : kH2HHandMaj === "L" ? "left" : ""}-heavy lineups</span>, hit {strikeoutsThreshold != null ? `${strikeoutsThreshold}+` : "this threshold"} in <span style={{color:kH2HHandColor,fontWeight:600}}>{kH2HHandRate.toFixed(1)}%</span>.</>}
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
                          const isPlatoonFallback = tonightHitPlay?.hitterSoftLabel === "vs RHP" || tonightHitPlay?.hitterSoftLabel === "vs LHP";
                          const softRateColor = isPlatoonFallback && platoonPts === 0 ? "#f78166" : "#3fb950";
                          const hitterOps = tonightHitPlay?.hitterOps ?? null;
                          const hitterOpsPts = tonightHitPlay?.hitterOpsPts ?? null;
                          const opsColor = hitterOpsPts == null ? "#8b949e" : hitterOpsPts >= 2 ? "#3fb950" : hitterOpsPts >= 1 ? "#e3b341" : "#f78166";
                          const scTitle = sc != null ? [`OPS: ${tonightHitPlay?.hitterOpsPts ?? 1}/2`,`WHIP: ${tonightHitPlay?.hitterWhipPts ?? 1}/2`,`Season HR: ${tonightHitPlay?.hitterSeasonHitRatePts ?? 1}/2`,`H2H HR: ${tonightHitPlay?.hitterH2HHitRatePts ?? 1}/2`,`O/U: ${tonightHitPlay?.hitterTotalPts ?? 1}/2`].join("\n") : null;
                          return (
                            <>
                              <div>
                                {first}{lineupSpot != null && <>, batting <span style={{color:spotColor,fontWeight:600}}>#{lineupSpot}</span>{spotDesc ? <span style={{color:"#8b949e"}}> — {spotDesc}</span> : ""}</>}.{hitterOps != null && <>{" "}<span style={{color:"#8b949e"}}>OPS </span><span style={{color:opsColor,fontWeight:600}}>{hitterOps.toFixed(3)}</span><span style={{color:"#8b949e"}}>{hitterOps >= 0.850 ? " — elite hitter" : hitterOps >= 0.720 ? " — above-average producer" : " — below-average OPS"}.</span></>}
                                {(pitcherName || whip != null) && (
                                  <>{" "}Facing{pitcherName ? <> <span style={{color:"#c9d1d9",fontWeight:600}}>{pitcherName}</span></> : " the opposing starter"}{whip != null ? <> — WHIP <span style={{color:whipColor,fontWeight:600}}>{whip}</span>{whipDesc ? <span style={{color:"#8b949e"}}> ({whipDesc})</span> : ""}</> : ""}.</>
                                )}
                                {seasonPct != null && <>{" "}{first} has gone {threshold}+ {statFull} in <span style={{color:seasonColor,fontWeight:600}}>{seasonPct}%</span> of games {seasonWindow}{seasonG ? <span style={{color:"#484f58",fontSize:10}}> ({seasonG}g)</span> : ""}</>}
                                {softPct != null ? <>, and <span style={{color:softRateColor,fontWeight:600}}>{softPct}%</span> {tonightHitPlay?.hitterSoftLabel ?? "against weak pitching matchups"}{isPlatoonFallback && tonightHitPlay?.hitterSplitBA != null ? <span style={{color:"#484f58",fontSize:10}}> (hits .{Math.round(tonightHitPlay.hitterSplitBA*1000).toString().padStart(3,"0")} vs {pitcherHand === "R" ? "RHP" : "LHP"})</span> : !isPlatoonFallback && tonightHitPlay?.softGames ? <span style={{color:"#484f58",fontSize:10}}> ({tonightHitPlay.softGames}g)</span> : ""}.</> : seasonPct != null ? "." : ""}
                                {tonightHitPlay?.oppRank && softPct === null && (() => {
                                  const _opp2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{tonightHitPlay.opponent}</span>;
                                  const _rank2 = <span style={{color:"#c9d1d9",fontWeight:600}}>{ordinal(tonightHitPlay.oppRank)}-worst</span>;
                                  const _metricStr2 = tonightHitPlay.oppMetricValue ? ` (${tonightHitPlay.oppMetricValue} ${tonightHitPlay.oppMetricUnit || ""})` : "";
                                  const _ctx2 = {"mlb|hits":"one of the easiest pitching matchups in the league — their staff has a high ERA this season","mlb|hrr":"one of the easiest pitching matchups in the league — their staff allows hits, runs, and RBIs at a high rate"}[`mlb|${safeTab}`] || "one of the weakest defenses for this stat";
                                  return <>{" "}{_opp2} ranks {_rank2} in {tonightHitPlay.oppMetricLabel || "this stat"}{_metricStr2} this season — {_ctx2}.{<>{" "}No head-to-head history yet{tonightHitPlay.pct25 != null && tonightHitPlay.pct25Games >= 5 ? <> — was at <span style={{color:"#c9d1d9"}}>{tonightHitPlay.pct25}%</span> in {tonightHitPlay.pct25Games} games in 2025</> : ""}.</>}</>;
                                })()}
                                {pf != null && Math.abs(pf - 1.0) >= 0.03 && <>{" "}Tonight's venue is {pf > 1 ? "hitter-friendly" : "pitcher-friendly"} (<span style={{color:"#8b949e"}}>{pf > 1 ? "+" : ""}{((pf-1)*100).toFixed(0)}% park factor</span>).</>}
                                {hitterGameTotal != null && <>{" "}<span style={{color:"#8b949e"}}>Game total </span><span style={{color:hitterTotalColor(hitterGameTotal),fontWeight:600}}>{hitterGameTotal}</span><span style={{color:"#8b949e"}}>{hitterGameTotal >= 9.5 ? " — a high-scoring game, favorable for hitting" : hitterGameTotal >= 7.5 ? " — an average total" : " — a low-scoring game, tougher for hitters"}.</span></>}
                                {!isPlatoonFallback && platoonPts === 2 && pitcherHand && (() => { const splitBA = tonightHitPlay?.hitterSplitBA; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#3fb950",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon edge.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon edge vs {handStr}.</span></>; })()}
                                {!isPlatoonFallback && platoonPts === 0 && pitcherHand && (() => { const splitBA = tonightHitPlay?.hitterSplitBA; const seasonBA = tonightHitPlay?.hitterBa; const handStr = pitcherHand === "R" ? "RHP" : "LHP"; return splitBA != null ? <>{" "}<span style={{color:"#8b949e"}}>Hits </span><span style={{color:"#f78166",fontWeight:600}}>.{Math.round(splitBA*1000).toString().padStart(3,"0")}</span><span style={{color:"#8b949e"}}> vs {handStr} — platoon disadvantage{seasonBA != null ? <> (<span style={{color:"#c9d1d9"}}>.{Math.round(seasonBA*1000).toString().padStart(3,"0")}</span> season)</> : ""}.</span></> : <>{" "}<span style={{color:"#8b949e"}}>Platoon disadvantage vs {handStr}.</span></>; })()}
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
                                  {isOppFallback && <div style={{color:"#8b949e",fontSize:10,marginTop:3}}>Showing last game vs {effectiveOpp} — updates when next game is scheduled.</div>}
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
                                  {isOppFallback && <div style={{color:"#8b949e",fontSize:10,marginTop:3}}>Showing last game vs {effectiveOpp} — updates when next game is scheduled.</div>}
                                  {sc != null && <>{" "}<span title={scTitle} style={{background:"#161b22",borderRadius:4,padding:"1px 5px",color:scColor,fontWeight:700,fontSize:10,cursor:"default",verticalAlign:"middle"}}>{sc}/10 {sc>=8?"Alpha":"Mid"}</span></>}
                                </div>
                              </>
                            );
                          }
                          return <>
                            {first} {isOppFallback ? "last faced" : "faces"} {oppEl} {isOppFallback ? "" : "tonight "}— they rank <span style={{color:"#f78166",fontWeight:600}}>#{rank}</span> in {statLabel} allowed{metricStr}, giving up {rank === 1 ? "the most" : rank <= 5 ? "among the most" : "a lot of"} in the league.
                            {isOppFallback && <div style={{color:"#8b949e",fontSize:10,marginTop:3}}>Showing last game vs {opp} — updates when next game is scheduled.</div>}
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
                  <div style={{color:"#8b949e",fontSize:11,marginBottom:14}}>
                    Soft matchup teams <span style={{color:"#484f58"}}>({wTotal}/{totalGames}g)</span>: {weakTeamList.map(t => t.abbr).join(" · ")}
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
                        initiateTrack({
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
                              <div style={{color:"#8b949e",fontSize:11,width:80,flexShrink:0}}>{count}/{totalGames}g</div>
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
                                    <div title={softGamesLabel} style={{color:"#8b949e",fontSize:10,width:80,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{softGamesLabel}</div>
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
                                    <div style={{color:displayPct != null ? displayColor : "#8b949e",fontSize:13,fontWeight:700,width:42,textAlign:"right",flexShrink:0}}>{displayPct != null ? `${displayPct.toFixed(1)}%` : "—"}</div>
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
                                  <div style={{color:"#8b949e",fontSize:10,width:80,flexShrink:0}}>{isMLB ? `'25+'26 (${totalGames}g)` : `${count}/${totalGames}g`}</div>
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
                                      <div title={softGamesLabel} style={{color:"#8b949e",fontSize:10,width:80,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{softGamesLabel}</div>
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
        <LineupsPage
          allTonightPlays={testMode ? MOCK_PLAYS : (allTonightPlays || [])}
          tonightLoading={tonightLoading}
          navigateToPlayer={navigateToPlayer}
          navigateToTeam={navigateToTeam}
          navigateToModel={navigateToModel}
          fetchReport={fetchReport}
          bustLoading={bustLoading}
          bustCache={bustCache}
          testMode={testMode}
          setTestMode={setTestMode}
          authEmail={authEmail}
          logout={logout}
          syncStatus={syncStatus}
          onLoginClick={() => { setShowAuthModal(true); setAuthMode("login"); setAuthError(""); }}
          mlbMeta={mlbMeta}
          mlbMetaTomorrow={mlbMetaTomorrow}
          nbaMeta={nbaMeta}
          trackedPlays={trackedPlays}
          untrackPlay={untrackPlay}
          navigateToPlay={navigateToPlay}
          trackPlay={initiateTrack}
          openPicksDrawer={() => setShowPicksDrawer(true)}
        />
      )}

      <div style={{color:"#484f58",fontSize:11,marginTop:12,textAlign:"center"}}>
        Powered by ESPN API · via Cloudflare Worker proxy
      </div>

      {/* FAB picks button */}
      {(() => {
        const activePicks = trackedPlays.filter(p => !p.result || p.result === "dnp");
        return (
          <button ref={fabRef}
            onClick={() => setShowPicksDrawer(d => !d)}
            title="My Picks"
            style={{
              position:"fixed", bottom:24, right:24,
              width:52, height:52, borderRadius:"50%",
              background: showPicksDrawer ? "#1c2128" : "#161b22",
              border:`2px solid ${showPicksDrawer ? "#58a6ff" : "#30363d"}`,
              cursor:"pointer",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:22, color:"#e3b341",
              boxShadow:"0 4px 20px rgba(0,0,0,0.6)",
              zIndex:600,
              transition:"border-color 0.15s, background 0.15s",
            }}>
            ★
            {activePicks.length > 0 && (
              <span style={{
                position:"absolute", top:-5, right:-5,
                background:"#3fb950", color:"#0d1117",
                fontSize:10, fontWeight:700,
                borderRadius:10, padding:"1px 5px",
                minWidth:18, textAlign:"center", lineHeight:"16px",
                border:"2px solid #0d1117",
              }}>{activePicks.length}</span>
            )}
          </button>
        );
      })()}

      {/* Flying pick star animation */}
      {flyingPick && (
        <div
          key={flyingPick.key}
          style={{
            position:"fixed",
            left: flyingPick.x,
            top: flyingPick.y,
            "--fly-dx": `${flyingPick.destX - flyingPick.x}px`,
            "--fly-dy": `${flyingPick.destY - flyingPick.y}px`,
            width:24, height:24,
            fontSize:18,
            display:"flex", alignItems:"center", justifyContent:"center",
            color:"#e3b341",
            zIndex:9999,
            pointerEvents:"none",
            animation:"fly-to-fab 0.45s cubic-bezier(0.25,0.46,0.45,0.94) forwards",
          }}
          onAnimationEnd={() => setFlyingPick(null)}
        >★</div>
      )}

      {/* Picks drawer backdrop */}
      <div
        onClick={() => setShowPicksDrawer(false)}
        style={{
          position:"fixed", inset:0,
          background:"rgba(0,0,0,0.5)",
          zIndex:597,
          opacity: showPicksDrawer ? 1 : 0,
          pointerEvents: showPicksDrawer ? "auto" : "none",
          transition:"opacity 0.3s ease",
        }}
      />

      {/* Picks drawer panel */}
      <div style={{
        position:"fixed", top:0, right:0, bottom:0,
        width:"min(50vw, 680px)",
        background:"#0d1117",
        borderLeft:"1px solid #30363d",
        zIndex:598,
        display:"flex", flexDirection:"column",
        transform: showPicksDrawer ? "translateX(0)" : "translateX(100%)",
        transition:"transform 0.3s ease",
        boxShadow:"-4px 0 32px rgba(0,0,0,0.6)",
      }}>
        {/* Drawer header */}
        <div style={{
          display:"flex", alignItems:"center", gap:8,
          padding:"16px 20px 14px",
          borderBottom:"1px solid #21262d",
          flexShrink:0,
        }}>
          <span style={{color:"#c9d1d9", fontWeight:700, fontSize:15}}>My Picks</span>
          <span style={{background:"#21262d", borderRadius:10, padding:"1px 8px", fontSize:11, color:"#8b949e"}}>
            {trackedPlays.length}
          </span>
          <button onClick={() => setShowPicksDrawer(false)}
            style={{marginLeft:"auto", background:"transparent", border:"none", color:"#8b949e", fontSize:20, cursor:"pointer", lineHeight:1, padding:"2px 4px"}}>
            ×
          </button>
        </div>
        {/* Drawer content */}
        <div style={{flex:1, overflowY:"auto", padding:"12px 20px 24px"}}>
          <MyPicksColumn
            trackedPlays={trackedPlays}
            setTrackedPlays={setTrackedPlays}
            untrackPlay={untrackPlay}
            navigateToTeam={navigateToTeam}
            navigateToPlay={navigateToPlay}
            bankroll={bankroll}
            setBankroll={setBankroll}
            setPickUnits={setPickUnits}
            chartGroupBy={chartGroupBy}
            setChartGroupBy={setChartGroupBy}
            openPickWeeks={openPickWeeks}
            setOpenPickWeeks={setOpenPickWeeks}
            openPickDays={openPickDays}
            setOpenPickDays={setOpenPickDays}
            editPickId={editPickId}
            setEditPickId={setEditPickId}
            setPlayResult={setPlayResult}
            setShowAddPick={setShowAddPick}
            oddsToProfit={oddsToProfit}
          />
        </div>
      </div>

    </div>
  );
}


export default App;
