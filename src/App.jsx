import React from 'react';
import { WORKER, SPORTS, STAT_FULL, MLB_TEAM, TEAM_DB, TOTAL_THRESHOLDS, STAT_LABEL, SPORT_KEY, SPORT_BADGE_COLOR, GAMELOG_COLS } from './lib/constants.js';
import { ordinal, slugify, teamUrl } from './lib/utils.js';
import { useIsMobile } from './lib/hooks.js';
import { useTonight } from './lib/useTonight.js';
import InputList from './components/InputList.jsx';
import { buildLambdaInputs, buildModelOutput } from './lib/lambdaInputs.js';
import { buildLiveGameKey, getPickCurrentStat, findLivePlayer, resolveTotalGameScore, pitcherIsOut } from './lib/liveStats.js';
import { tierColor } from './lib/colors.js';
import TotalsBarChart from './components/TotalsBarChart.jsx';
import TeamPage, { STAT_CONFIGS } from './components/TeamPage.jsx';
import DayBar from './components/DayBar.jsx';
import { useDebounce } from './components/AddPickModal.jsx';
import AddPickModal from './components/AddPickModal.jsx';
import ModelPage from './components/ModelPage.jsx';
import MarketReport from './components/MarketReport.jsx';
import MyPicksColumn from './components/MyPicksColumn.jsx';
import LineupsPage from './components/LineupsPage.jsx';
import SimBadge from './components/SimBadge.jsx';

import { KALSHI_GATE, KALSHI_CAP, EDGE_GATE_CLIENT as EDGE_GATE } from "../api/lib/config.js";

function App() {
  const isMobile = useIsMobile();
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
  // Player-card per-threshold tab — null means "show default (first qualified or first available)".
  // Reset when stat tab or direction changes (different threshold sets), or when player changes.
  const [selectedThreshold, setSelectedThreshold] = React.useState(null);
  const [kalshiOdds, setKalshiOdds] = React.useState({});
  const [showBreakdown, setShowBreakdown] = React.useState(false);
  const [direction, setDirection] = React.useState("over"); // "over" | "under"
  const [editPickId, setEditPickId] = React.useState(null); // pick.id being edited
  const [searching, setSearching] = React.useState(false);
  // tonight fetch/poll/visibility state lives in useTonight() — called below after _qualifiedFilter is defined.

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
  // Stake sizing — flat ⅛-Kelly for every play, 1u ($30) when Kelly can't compute,
  // $500 hard cap to bound tail risk on rare huge-Kelly recommendations.
  const UNIT_DOLLARS = 30;
  const STAKE_CAP = 500;
  const unitsForPlay = (play) => {
    const e = play?.edge ?? null;
    // Kelly inputs. UNDER direction uses noTruePct so the probability matches the side taken.
    const truePct = play?.direction === "under" ? (play?.noTruePct ?? play?.truePct) : play?.truePct;
    const ao = play?.americanOdds;
    const kFrac = e == null ? null : 0.125;
    if (kFrac != null && truePct != null && ao != null && ao !== 0) {
      const b = ao > 0 ? ao / 100 : 100 / Math.abs(ao);
      const p = truePct / 100;
      const f = Math.max(0, (b * p - (1 - p)) / b);
      const stake = bankroll * f * kFrac;
      if (stake > 0) return Math.round(Math.min(stake, STAKE_CAP));
    }

    // Fallback when Kelly can't compute (missing truePct/odds, or Kelly = 0).
    return Math.round(Math.min(UNIT_DOLLARS, STAKE_CAP));
  };
  const kalshiCache = React.useRef({}); // memoize Kalshi fetches by "playerName|sport|stat"
  const [expandedPlays, setExpandedPlays] = React.useState(new Set());
  // Picks are server-authoritative. Initial state is empty; the server-load effect below
  // fills it (and runs a one-time migration to push any legacy localStorage picks up before
  // dropping localStorage as a picks store entirely).
  const [trackedPlays, setTrackedPlays] = React.useState([]);
  const [bankroll, setBankrollState] = React.useState(() => {
    return parseFloat(localStorage.getItem("scoreboard_bankroll") || "1000");
  });
  const [chartMonth, setChartMonth] = React.useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  });
  const [pendingTrackPlay, setPendingTrackPlay] = React.useState(null);
  const [pendingOdds, setPendingOdds] = React.useState("-110");
  const [openPickDays, setOpenPickDays] = React.useState(() => new Set([new Date().toLocaleDateString("en-CA")]));
  const [openPickWeeks, setOpenPickWeeks] = React.useState(() => {
    const d = new Date(); const dow = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - ((dow + 6) % 7));
    return new Set([mon.toLocaleDateString("en-CA")]);
  });
  const [openPickMonths, setOpenPickMonths] = React.useState(() => new Set([new Date().toLocaleDateString("en-CA").slice(0, 7)]));
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
  const [liveStats, setLiveStats] = React.useState({}); // { "sport:team1:team2|gameDate": { state, detail, players } }
  const liveIntervalRef = React.useRef(null);
  const liveMetaRef = React.useRef({ mlbMeta: null, nbaMeta: null, wnbaMeta: null, nhlMeta: null });
  const syncTimer = React.useRef(null);
  const fabRef = React.useRef(null);
  const picksLoaded = React.useRef(!localStorage.getItem("sb_token")); // true if no token (no server load needed)
  // Delta-save bookkeeping. lastSyncedPicks is the last server-confirmed state, indexed by
  // pick id → serialized JSON. savePicks diffs trackedPlays against this map and POSTs only
  // the upserts/deletes. Refs (not state) so updates inside the save handler don't trigger
  // re-renders. trackedPlaysRef/bankrollRef mirror state so a re-fired save after an inflight
  // one reads the latest values, not a stale closure.
  const lastSyncedPicks = React.useRef(new Map());
  const lastSyncedBankroll = React.useRef(null);
  const inflightSave = React.useRef(false);
  const pendingSave = React.useRef(false);
  const trackedPlaysRef = React.useRef([]);
  const bankrollRef = React.useRef(null);
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
    const spPriority = sportOverride ? [sportOverride] : ["mlb","nba","wnba","nhl"];
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

  const navigateToTeam = React.useCallback((abbr, sport) => {
    const url = teamUrl(abbr, sport);
    history.pushState({}, "", url);
    loadTeamPage(abbr, sport);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateToPlayer = React.useCallback((p, tab) => {
    const slug = slugify(p.name);
    history.pushState({}, "", `/${slug}`);
    selectPlayer(p, tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = React.useCallback(() => {
    history.pushState({}, "", "/");
    setPlayer(null);
    setTeamPage(null);
    setModelPage(false);
    setQuery("");
  }, []);

  const navigateToModel = React.useCallback(() => {
    history.pushState({}, "", "/model");
    setPlayer(null);
    setTeamPage(null);
    setModelPage(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // Qualified play filter: dcQualified=true AND edge >= 5% AND dc=10 (fully clean inputs). v1
  // (SimScore-gated) was dropped 2026-05-18 — SimScore is display/attribution only now. Mirrors
  // passesGate in LineupsPage; keep these in sync.
  const _qualifiedFilter = React.useCallback((p) => {
    if (p._altLineDemoted === true) return false;
    if (p.dcQualified !== true || (p.edge ?? 0) < EDGE_GATE) return false;
    return (p.dataConfidence ?? 0) === 10;
  }, []);
  const {
    tonightPlays, allTonightPlays, nbaDropped,
    tonightMeta, tonightLoading,
    mlbMeta, mlbMetaTomorrow, nbaMeta, wnbaMeta, nhlMeta,
    bustCache, bustLoading,
  } = useTonight(_qualifiedFilter);


  function setBankroll(val) {
    const n = Math.max(1, parseFloat(val) || 0);
    setBankrollState(n);
    localStorage.setItem("scoreboard_bankroll", String(n));
  }
  function trackPlay(play) {
    const id = play.gameType === "teamTotal"
      ? `teamtotal|${play.sport}|${play.scoringTeam}|${play.oppTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
      : play.gameType === "total"
      ? `total|${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
      : play.gameType === "ml"
      ? `ml|${play.sport}|${play.pickTeam}|${play.homeTeam}|${play.awayTeam}|${play.gameDate || ""}`
      : play.gameType === "spread"
      ? `spread|${play.sport}|${play.pickTeam}|${play.homeTeam}|${play.awayTeam}|${play.pickLine}|${play.gameDate || ""}`
      : `${play.sport || "nba"}|${play.playerName}|${play.stat}|${play.threshold}|${play.gameDate || ""}`;
    const savedOdds = play.americanOdds ?? -110;
    // Recompute implied%, edge, and units from savedOdds. When the user overrides odds
    // via the pendingOdds dialog (e.g. takes -250 at sportsbook vs -350 at Kalshi),
    // the saved pick's edge/kalshiPct must reflect the price actually taken — otherwise
    // unitsForPlay reads the stale Kalshi edge and the bet is sized for the wrong band.
    const impliedFromOdds = savedOdds < 0
      ? Math.abs(savedOdds) / (Math.abs(savedOdds) + 100) * 100
      : 100 / (savedOdds + 100) * 100;
    const newKalshiPct = parseFloat(impliedFromOdds.toFixed(1));
    const truePct = play.direction === "under" ? (play.noTruePct ?? play.truePct) : play.truePct;
    const newEdge = truePct != null ? parseFloat((truePct - newKalshiPct).toFixed(1)) : (play.edge ?? null);
    // Stamp modelVersion:"v2" so /api/auth/calibration can split historical (pre-v2-drop)
    // vs current outcomes. Without the stamp, post-drop picks would be treated as v1.
    // Live tracking requires { playerTeam, opponent } (or for totals: { homeTeam, awayTeam } /
    // { scoringTeam, oppTeam }) to build a `sport:team:opp` key for /api/live, and the pick
    // card's live progress bar is gated on pick.gameTime. /api/tonight-derived picks have
    // these; manual picks from AddPickModal don't — backfill from gameScores here so the
    // pick is fully resolvable from the moment it's saved.
    let extras = {};
    const scoresMap = play.sport === "mlb" ? mlbMeta?.gameScores
                    : play.sport === "nba" ? nbaMeta?.gameScores
                    : play.sport === "wnba" ? wnbaMeta?.gameScores
                    : play.sport === "nhl" ? nhlMeta?.gameScores
                    : null;
    if (scoresMap) {
      let matchedGame = null;
      if ((play.gameType === "total" || play.gameType === "ml" || play.gameType === "spread") && play.homeTeam) {
        matchedGame = scoresMap[play.homeTeam] ||
          Object.values(scoresMap).find(g => g?.homeTeam === play.homeTeam && g?.awayTeam === play.awayTeam) ||
          null;
      } else if (play.gameType === "teamTotal" && play.scoringTeam) {
        matchedGame = scoresMap[play.scoringTeam] ||
          Object.values(scoresMap).find(g =>
            (g?.homeTeam === play.scoringTeam && g?.awayTeam === play.oppTeam) ||
            (g?.awayTeam === play.scoringTeam && g?.homeTeam === play.oppTeam)
          ) || null;
      } else if (!play.gameType && play.playerTeam) {
        for (const g of Object.values(scoresMap)) {
          if (g?.homeTeam === play.playerTeam || g?.awayTeam === play.playerTeam) { matchedGame = g; break; }
        }
        if (matchedGame && !play.opponent) {
          extras.opponent = matchedGame.homeTeam === play.playerTeam ? matchedGame.awayTeam : matchedGame.homeTeam;
        }
      }
      if (matchedGame) {
        if (!play.gameTime && matchedGame.gameTime) extras.gameTime = matchedGame.gameTime;
        // For teamTotal, surface homeTeam/awayTeam too — used by some UI paths and consistent
        // with /api/tonight-derived picks.
        if (play.gameType === "teamTotal") {
          if (!play.homeTeam && matchedGame.homeTeam) extras.homeTeam = matchedGame.homeTeam;
          if (!play.awayTeam && matchedGame.awayTeam) extras.awayTeam = matchedGame.awayTeam;
        }
      }
    }
    const enriched = { ...play, ...extras, americanOdds: savedOdds, kalshiPct: newKalshiPct, edge: newEdge, modelVersion: "v2" };
    setTrackedPlays(prev => {
      if (prev.find(p => p.id === id)) return prev;
      return [{ ...enriched, id, trackedAt: Date.now(), result: null,
        units: unitsForPlay(enriched),
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

  // ── Live stat polling ────────────────────────────────────────────────────────
  const fetchLiveStats = React.useCallback(async (currentPicks, currentMeta) => {
    const today = new Date().toLocaleDateString("en-CA");
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString("en-CA"); })();
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA"); })();
    // Include yesterday's unresolved picks so games that ended after midnight UTC still get auto-settled.
    // Aging cap: ignore picks older than yesterday — at that point manual resolution.
    const activePicks = currentPicks.filter(p => !p.result && (p.gameDate === today || p.gameDate === tomorrow || p.gameDate === yesterday));
    if (!activePicks.length) return;

    // Resolve playerTeam + opponent from gameScores when one or both are missing on the pick.
    // Older picks may have empty playerTeam ("") or null opponent; backfill from whichever is present.
    // Also treat any value containing "|" as invalid (legacy bug saved opponent as "STL|date").
    const resolveTeams = (pick) => {
      const has = (v) => typeof v === "string" && v.length > 0 && !v.includes("|");
      let playerTeam = has(pick.playerTeam) ? pick.playerTeam : null;
      let opponent = has(pick.opponent) ? pick.opponent : null;
      if (playerTeam && opponent) return { playerTeam, opponent };
      const scores = pick.sport === "mlb" ? currentMeta?.mlbMeta?.gameScores
                   : pick.sport === "nba" ? currentMeta?.nbaMeta?.gameScores
                   : pick.sport === "wnba" ? currentMeta?.wnbaMeta?.gameScores
                   : pick.sport === "nhl" ? currentMeta?.nhlMeta?.gameScores
                   : null;
      if (!scores) return { playerTeam, opponent };
      for (const g of Object.values(scores)) {
        if (playerTeam && !opponent) {
          if (g.homeTeam === playerTeam) { opponent = g.awayTeam; break; }
          if (g.awayTeam === playerTeam) { opponent = g.homeTeam; break; }
        } else if (opponent && !playerTeam) {
          if (g.homeTeam === opponent) { playerTeam = g.awayTeam; break; }
          if (g.awayTeam === opponent) { playerTeam = g.homeTeam; break; }
        }
      }
      return { playerTeam, opponent };
    };

    // Collect unique game keys for ALL active picks (player props + totals + team totals),
    // grouped by gameDate so we can hit /api/live with the right date for each batch.
    // Yesterday's picks need yesterday's ESPN scoreboard, today's need today's.
    // pickKeyMap stores DATE-SCOPED keys (`raw|gameDate`); the same matchup recurring
    // across days would otherwise alias and let one day's response settle another's pick.
    const pickKeyMap = new Map(); // pick.id → `${rawKey}|${gameDate}`
    const keysByDate = new Map(); // gameDate → Set<rawKey>  (raw is what /api/live expects)
    for (const p of activePicks) {
      let rawKey = null;
      if (p.gameType === "total") {
        if (p.homeTeam && p.awayTeam) rawKey = `${p.sport}:${p.awayTeam}:${p.homeTeam}`;
      } else if (p.gameType === "teamTotal") {
        if (p.scoringTeam && p.oppTeam) rawKey = `${p.sport}:${p.scoringTeam}:${p.oppTeam}`;
      } else if (p.gameType === "ml" || p.gameType === "spread") {
        if (p.homeTeam && p.awayTeam) rawKey = `${p.sport}:${p.awayTeam}:${p.homeTeam}`;
      } else {
        const { playerTeam, opponent } = resolveTeams(p);
        if (playerTeam && opponent) rawKey = `${p.sport}:${playerTeam}:${opponent}`;
      }
      if (!rawKey || !p.gameDate) continue;
      // Append @gameTime when present so /api/live can disambiguate same-day doubleheaders.
      if (p.gameTime) rawKey = `${rawKey}@${p.gameTime}`;
      pickKeyMap.set(p.id, `${rawKey}|${p.gameDate}`);
      if (!keysByDate.has(p.gameDate)) keysByDate.set(p.gameDate, new Set());
      keysByDate.get(p.gameDate).add(rawKey);
    }
    if (!keysByDate.size) return;

    try {
      // Fan out one /api/live call per distinct gameDate. Today omits the date param
      // (default behavior); other dates pass `&date=YYYY-MM-DD`. Server response is keyed by
      // the raw matchup; we re-scope to `raw|gameDate` before merging so cross-day collisions
      // can't overwrite each other (e.g. NYY:BAL on consecutive days).
      const fetches = [...keysByDate.entries()].map(([gd, keys]) => {
        const games = [...keys].join(",");
        const dateQs = gd === today ? "" : `&date=${gd}`;
        return fetch(`${WORKER}/live?games=${games}${dateQs}`)
          .then(r => r.ok ? r.json() : {})
          .catch(() => ({}))
          .then(resp => {
            const scoped = {};
            for (const [k, v] of Object.entries(resp)) scoped[`${k}|${gd}`] = v;
            return scoped;
          });
      });
      const responses = await Promise.all(fetches);
      const data = Object.assign({}, ...responses);
      setLiveStats(prev => ({ ...prev, ...data }));

      // Auto-resolve: check each active player-prop pick against live data
      setTrackedPlays(prev => prev.map(pick => {
        if (pick.result) return pick; // already settled
        if (pick.gameType === "total" || pick.gameType === "teamTotal" || pick.gameType === "ml" || pick.gameType === "spread") return pick; // handled separately
        const gameKey = pickKeyMap.get(pick.id);
        if (!gameKey) return pick;
        // gameKey is `sport:team:opp|gameDate` (date-scoped) — strip the `|date` from the opp
        // segment so backfilled `opponent` is the clean team abbr. Previously this set
        // opponent="STL|2026-05-16", breaking subsequent live polls (split key never matched).
        const parts = gameKey.split(":");
        const resolvedTeam = parts[1];
        const resolvedOpp = parts[2]?.split("|")[0];
        const has = (v) => typeof v === "string" && v.length > 0 && !v.includes("|");
        const backfill = {};
        if (!has(pick.playerTeam) && resolvedTeam) backfill.playerTeam = resolvedTeam;
        if (!has(pick.opponent) && resolvedOpp) backfill.opponent = resolvedOpp;
        const hasBackfill = Object.keys(backfill).length > 0;
        const liveGame = data[gameKey];
        if (!liveGame || liveGame.state === "pre" || liveGame.state === "unknown") {
          return hasBackfill ? { ...pick, ...backfill } : pick;
        }

        const playerStats = findLivePlayer(liveGame.players, pick.playerName);
        const current = getPickCurrentStat(pick, playerStats);

        if (current !== null && current >= pick.threshold) {
          return { ...pick, ...backfill, result: "won" };
        }
        // MLB strikeouts: once the pitcher is pulled, their K count is final. Resolve "lost"
        // without waiting for the game to end so the pick card stops showing as in-progress.
        // Uses isCurrentPitcher flag from /api/live (correct for bulk pitchers behind openers).
        if (pick.sport === "mlb" && pick.stat === "strikeouts"
            && liveGame.state === "in"
            && pitcherIsOut(playerStats)) {
          return { ...pick, ...backfill, result: "lost" };
        }
        if (liveGame.state === "post") {
          if (playerStats === undefined && pick.stat !== "strikeouts") {
            return { ...pick, ...backfill, result: "dnp" }; // player not in boxscore after game ended
          }
          return { ...pick, ...backfill, result: "lost" };
        }
        return hasBackfill ? { ...pick, ...backfill } : pick;
      }));
    } catch { /* network error — silently skip */ }
  }, []);

  // Auto-resolve totals/team-totals picks. Reads from liveStats first (fresh, includes
  // yesterday's settled games when polled with date param), falls back to mlbMeta/nbaMeta/
  // nhlMeta gameScores for today's games loaded via /api/tonight.
  React.useEffect(() => {
    if (!trackedPlays.length) return;
    const today = new Date().toLocaleDateString("en-CA");
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA"); })();
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString("en-CA"); })();
    const allScores = {
      ...(mlbMeta?.gameScores || {}),
      ...(nbaMeta?.gameScores || {}),
      ...(wnbaMeta?.gameScores || {}),
      ...(nhlMeta?.gameScores || {}),
    };
    const hasAnyData = Object.keys(allScores).length > 0 || Object.keys(liveStats).length > 0;
    if (!hasAnyData) return;

    setTrackedPlays(prev => prev.map(pick => {
      if (pick.result) return pick;
      if (pick.gameType !== "total" && pick.gameType !== "teamTotal" && pick.gameType !== "ml" && pick.gameType !== "spread") return pick;
      if (pick.gameDate !== today && pick.gameDate !== yesterday && pick.gameDate !== tomorrow) return pick;

      const gameScore = resolveTotalGameScore(pick, liveStats, allScores);
      if (!gameScore || (gameScore.state !== "post" && gameScore.state !== "in")) return pick;

      if (pick.gameType === "ml") {
        // ML resolves only at Final — no early "winning at half" win-locking. The pre-game
        // model truePct is based on full 9-inning outcomes; in-game leads have plenty of
        // variance left.
        if (gameScore.state !== "post") return pick;
        const winningTeam = (gameScore.homeScore ?? 0) > (gameScore.awayScore ?? 0)
          ? gameScore.homeTeam
          : (gameScore.awayScore ?? 0) > (gameScore.homeScore ?? 0)
            ? gameScore.awayTeam
            : null;
        if (winningTeam == null) return pick; // tie shouldn't happen in MLB regulation; defensive
        return { ...pick, result: winningTeam === pick.pickTeam ? "won" : "lost" };
      }

      if (pick.gameType === "spread") {
        // Spread resolves only at Final. Half-line markets only (no push handling). Pick covers
        // when (pickTeamFinal - oppFinal) > line for YES picks (negative pickLine) or
        // (pickTeamFinal - oppFinal) > -|line| for NO picks (positive pickLine) — equivalently
        // (pickFinal - oppFinal) + pickLine > 0 in both directions.
        if (gameScore.state !== "post") return pick;
        const pickIsHome = gameScore.homeTeam === pick.pickTeam;
        const pickFinal = pickIsHome ? (gameScore.homeScore ?? 0) : (gameScore.awayScore ?? 0);
        const oppFinal = pickIsHome ? (gameScore.awayScore ?? 0) : (gameScore.homeScore ?? 0);
        const covered = (pickFinal - oppFinal) + (pick.pickLine ?? 0) > 0;
        return { ...pick, result: covered ? "won" : "lost" };
      }

      const isHome = gameScore.homeTeam === (pick.gameType === "total" ? pick.homeTeam : pick.scoringTeam);
      const current = pick.gameType === "total"
        ? (gameScore.homeScore ?? 0) + (gameScore.awayScore ?? 0)
        : (isHome ? (gameScore.homeScore ?? 0) : (gameScore.awayScore ?? 0));

      const isUnder = pick.direction === "under";
      // OVER: resolve won mid-game the moment threshold is crossed; resolve lost only at game end
      // UNDER: must wait for game to end
      if (gameScore.state === "in") {
        if (!isUnder && current >= pick.threshold) return { ...pick, result: "won" };
        return pick;
      }
      const met = isUnder ? current < pick.threshold : current >= pick.threshold;
      return { ...pick, result: met ? "won" : "lost" };
    }));
  }, [mlbMeta, nbaMeta, wnbaMeta, nhlMeta, liveStats]);

  // Keep latest meta in a ref so the polling interval reads fresh values
  // (effect dep array can't include meta without re-creating the interval).
  React.useEffect(() => {
    const prev = liveMetaRef.current;
    liveMetaRef.current = { mlbMeta, nbaMeta, wnbaMeta, nhlMeta };
    // When meta first becomes available, fire an immediate poll so picks
    // tracked without `opponent` can resolve via the gameScores backfill
    // without waiting up to 60s.
    const becameAvailable = (k) => !prev?.[k]?.gameScores && liveMetaRef.current[k]?.gameScores;
    if ((becameAvailable("mlbMeta") || becameAvailable("nbaMeta") || becameAvailable("wnbaMeta") || becameAvailable("nhlMeta")) && liveIntervalRef.current) {
      setTrackedPlays(current => { fetchLiveStats(current, liveMetaRef.current); return current; });
    }
  }, [mlbMeta, nbaMeta, wnbaMeta, nhlMeta]);

  // Start/stop background polling every 60s
  React.useEffect(() => {
    const today = new Date().toLocaleDateString("en-CA");
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString("en-CA"); })();
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA"); })();
    // Include totals/team-totals so they also poll /api/live, and include yesterday's
    // unresolved picks so games that ended after midnight UTC still get auto-settled.
    const hasTodayActivePicks = trackedPlays.some(p =>
      !p.result && (p.gameDate === today || p.gameDate === tomorrow || p.gameDate === yesterday)
    );

    if (liveIntervalRef.current) {
      clearInterval(liveIntervalRef.current);
      liveIntervalRef.current = null;
    }
    if (!hasTodayActivePicks) return;

    // Fire immediately, then every 60s. Meta read from ref so polls always see latest.
    fetchLiveStats(trackedPlays, liveMetaRef.current);
    liveIntervalRef.current = setInterval(() => {
      setTrackedPlays(current => {
        fetchLiveStats(current, liveMetaRef.current);
        return current;
      });
    }, 60000);
    return () => { clearInterval(liveIntervalRef.current); liveIntervalRef.current = null; };
  }, [trackedPlays.filter(p => !p.result).length, fetchLiveStats]);

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

  // Delta save. Computes upserts/deletes against lastSyncedPicks and POSTs only the diff.
  // Serialized via inflightSave; if a save fires while one's in flight, pendingSave is
  // marked and a follow-up save runs after the current one with the latest state from refs
  // (so any changes made during the in-flight request aren't lost).
  async function savePicks(token, picks, roll) {
    if (!token) return;
    if (inflightSave.current) { pendingSave.current = true; return; }
    inflightSave.current = true;
    try {
      const upserts = [];
      const currentIds = new Set();
      for (const p of picks) {
        if (!p || !p.id) continue;
        currentIds.add(p.id);
        const serialized = JSON.stringify(p);
        if (lastSyncedPicks.current.get(p.id) !== serialized) upserts.push(p);
      }
      const deletes = [];
      for (const id of lastSyncedPicks.current.keys()) {
        if (!currentIds.has(id)) deletes.push(id);
      }
      const bankrollChanged = roll !== lastSyncedBankroll.current;

      if (upserts.length === 0 && deletes.length === 0 && !bankrollChanged) {
        setSyncStatus("saved");
        return;
      }

      const body = { upserts, deletes };
      if (bankrollChanged) body.bankroll = roll;
      const bodyStr = JSON.stringify(body);
      // keepalive has a 64 KiB cumulative body cap (per Fetch spec). Opt in only when the
      // delta fits comfortably so tab-close / visibility-hidden flushes have a chance to
      // land. Larger deltas (rare with delta saves — would need ~40+ picks changing at
      // once) fall back to plain fetch and rely on the active tab to keep it alive.
      const fetchOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: bodyStr,
      };
      if (bodyStr.length < 60 * 1024) fetchOpts.keepalive = true;
      const res = await fetch(`${WORKER}/user/picks`, fetchOpts);

      if (res.ok) {
        for (const p of upserts) lastSyncedPicks.current.set(p.id, JSON.stringify(p));
        for (const id of deletes) lastSyncedPicks.current.delete(id);
        if (bankrollChanged) lastSyncedBankroll.current = roll;
        setSyncStatus("saved");
      } else {
        setSyncStatus("error");
      }
    } catch {
      setSyncStatus("error");
    } finally {
      inflightSave.current = false;
      if (pendingSave.current) {
        pendingSave.current = false;
        // Re-run with the latest state from refs to catch changes made during the in-flight save.
        setTimeout(() => savePicks(token, trackedPlaysRef.current, bankrollRef.current), 0);
      }
    }
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
    // Reset delta-save baseline so a re-login doesn't diff against a stale prior-user snapshot.
    lastSyncedPicks.current = new Map();
    lastSyncedBankroll.current = null;
  }

  // Auto-save picks to server whenever they change (debounced 400ms — short enough that mobile
  // users tapping a star and immediately refreshing have a good chance of the save landing).
  // Guard: don't save until server picks have been loaded — prevents overwriting with [] on mount.
  React.useEffect(() => {
    if (!authToken || !picksLoaded.current) return;
    setSyncStatus("saving");
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => savePicks(authToken, trackedPlays, bankroll), 400);
    return () => clearTimeout(syncTimer.current);
  }, [trackedPlays, bankroll, authToken]);

  // Mirror state into refs so a follow-up save after an inflight one reads the latest values.
  React.useEffect(() => { trackedPlaysRef.current = trackedPlays; }, [trackedPlays]);
  React.useEffect(() => { bankrollRef.current = bankroll; }, [bankroll]);

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
  }, [authToken, trackedPlays, bankroll]);

  // Load picks from server on mount if token exists.
  // Server is the single source of truth — no localStorage merging. A one-time migration
  // pushes any legacy localStorage picks not on the server up before clearing local state.
  React.useEffect(() => {
    if (!authToken) return;
    const legacyLocal = (() => { try { return JSON.parse(localStorage.getItem("scoreboard_tracked_plays") || "[]"); } catch { return []; } })();
    fetch(`${WORKER}/user/picks`, { headers:{"Authorization":`Bearer ${authToken}`} })
      .then(r => {
        if (r.status === 401) {
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
          const serverPicks = pd.picks || [];
          if (pd.bankroll) setBankrollState(pd.bankroll);
          // Seed the delta-save baseline with the server's authoritative snapshot. Without
          // this, savePicks would diff against an empty Map and treat every pick as an upsert
          // on the first save after load.
          lastSyncedPicks.current = new Map(
            serverPicks.filter(p => p && p.id).map(p => [p.id, JSON.stringify(p)])
          );
          lastSyncedBankroll.current = pd.bankroll != null ? pd.bankroll : null;
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

      if (sport === "basketball/nba" || sport === "basketball/wnba") {
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
    if (play.gameType === "total" || play.gameType === "teamTotal" || play.gameType === "ml" || play.gameType === "spread") return; // totals/ML/spread don't have a player card
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
    history.pushState({}, "", `/${slugify(play.playerName)}`);
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
        const oddsValid = !isNaN(n) && raw !== "" && raw !== "-" && raw !== "+";
        let implied = null;
        if (oddsValid) {
          if (n < 0) implied = Math.abs(n) / (Math.abs(n) + 100) * 100;
          else if (n > 0) implied = 100 / (n + 100) * 100;
        }
        // truePct from the pick's perspective — UNDER uses noTruePct.
        const _tp = play.direction === "under" ? (play.noTruePct ?? (play.truePct != null ? 100 - play.truePct : null)) : play.truePct;
        const edge = (_tp != null && implied != null) ? parseFloat((_tp - implied).toFixed(1)) : null;
        // Suggested stake — mirror unitsForPlay (⅛-Kelly, $500 cap, $30 fallback) using the
        // user-entered odds so the recommendation updates live as they type.
        const suggestedStake = (() => {
          if (_tp == null || !oddsValid) return UNIT_DOLLARS;
          const b = n > 0 ? n / 100 : 100 / Math.abs(n);
          const p = _tp / 100;
          const f = Math.max(0, (b * p - (1 - p)) / b);
          const stake = bankroll * f * 0.125;
          return stake > 0 ? Math.round(Math.min(stake, STAKE_CAP)) : UNIT_DOLLARS;
        })();
        const color = implied === null ? "#8b949e" : implied >= 70 ? "#3fb950" : implied >= 50 ? "#e3b341" : "#f78166";
        const name = play.playerName ?? (play.gameType === "total" ? `${play.awayTeam} @ ${play.homeTeam}` : play.gameType === "ml" ? `${play.pickTeam} ML` : play.gameType === "spread" ? `${play.pickTeam} ${play.pickLine > 0 ? "+" : ""}${play.pickLine}` : play.scoringTeam ?? "");
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
                      // Block submission when entered odds put edge below the track-popup gate (3%).
                      // Looser than the home-page qualified gate (5%) — picks tracked at 3-5% edge
                      // are intentional, not misclicks; we only disable the truly negative-EV cases.
                      if (edge !== null && edge < 3) return;
                      const _n = parseInt(pendingOdds.trim(), 10);
                      const oddsVal = !isNaN(_n) && pendingOdds.trim() !== "-" && pendingOdds.trim() !== "+" ? _n : null;
                      trackPlay(oddsVal ? { ...play, americanOdds: oddsVal } : play);
                      setPendingTrackPlay(null);
                      openPickDate(play.gameDate);
                      triggerFlyAnimation();
                    } else if (e.key === "Escape") {
                      setPendingTrackPlay(null);
                    }
                  }}
                  style={{flex:1,background:"#0d1117",border:"1px solid #30363d",borderRadius:7,
                    color:"#c9d1d9",fontSize:16,padding:"7px 10px",outline:"none",textAlign:"center"}}
                />
                <span style={{fontSize:16,fontWeight:700,color,minWidth:52,textAlign:"right",whiteSpace:"nowrap"}}>
                  {implied !== null ? `${implied.toFixed(1)}%` : "—"}
                </span>
              </div>
              {edge !== null && (
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                  marginBottom:8,fontSize:11,color:"#484f58"}}>
                  <span>Edge (True% − implied)</span>
                  <span style={{color: edge >= EDGE_GATE ? "#3fb950" : edge >= 0 ? "#e3b341" : "#f78166", fontWeight:700}}>
                    {edge >= 0 ? "+" : ""}{edge}%
                  </span>
                </div>
              )}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                marginBottom:14,fontSize:11,color:"#484f58"}}>
                <span>Suggested stake (⅛-Kelly)</span>
                <span style={{color:"#c9d1d9",fontWeight:700}}>${suggestedStake}</span>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={() => setPendingTrackPlay(null)}
                  style={{flex:1,padding:"8px 0",fontSize:12,borderRadius:7,border:"1px solid #30363d",
                    background:"transparent",color:"#8b949e",cursor:"pointer"}}>
                  Cancel
                </button>
                {(() => {
                  // Disable when entered odds put edge below the track-popup gate (3%) — looser
                  // than the home-page qualified filter (5%) since picks at 3-5% edge are still
                  // intentional adds (closing-line value, hedges, etc.), just won't surface in
                  // the qualified feed. Edge null (no odds entered) doesn't disable.
                  const TRACK_MIN_EDGE = 3;
                  const _belowGate = edge !== null && edge < TRACK_MIN_EDGE;
                  return (
                    <button
                      disabled={_belowGate}
                      title={_belowGate ? `Edge ${edge}% is below the ${TRACK_MIN_EDGE}% minimum — adjust odds or cancel` : undefined}
                      onClick={() => {
                        if (_belowGate) return;
                        const _n = parseInt(pendingOdds.trim(), 10);
                        const oddsVal = !isNaN(_n) && pendingOdds.trim() !== "-" && pendingOdds.trim() !== "+" ? _n : null;
                        trackPlay(oddsVal ? { ...play, americanOdds: oddsVal } : play);
                        setPendingTrackPlay(null);
                        openPickDate(play.gameDate);
                        triggerFlyAnimation();
                      }}
                      style={{flex:1,padding:"8px 0",fontSize:12,borderRadius:7,
                        border:`1px solid ${_belowGate ? "#30363d" : "#3fb950"}`,
                        background: _belowGate ? "transparent" : "rgba(63,185,80,0.12)",
                        color: _belowGate ? "#484f58" : "#3fb950",
                        cursor: _belowGate ? "not-allowed" : "pointer",
                        fontWeight:600,
                        opacity: _belowGate ? 0.6 : 1}}>
                      Add Pick
                    </button>
                  );
                })()}
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
          tonightLoading={tonightLoading}
          allTonightPlays={allTonightPlays}
          onBack={goBack}
          navigateToTeam={navigateToTeam}
          navigateToPlayer={navigateToPlayer}
          trackedPlays={trackedPlays}
          trackPlay={trackPlay}
          untrackPlay={untrackPlay}
        />
      )}

      {/* Player loading state — when accessed via direct URL, tonightPlays is null while the
          initial /api/tonight fetch is in-flight. Show a centered loader (matches LineupsPage
          pattern) instead of rendering an empty page. */}
      {player && !teamPage && tonightLoading && !tonightPlays && (
        <div style={{textAlign:'center',padding:52,color:'#8b949e',fontSize:13}}>Loading {player.name}…</div>
      )}

      {/* Player header */}
              {player && !teamPage && !(tonightLoading && !tonightPlays) && (
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
          <div style={{minWidth:0,flex:1}}>
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
          {!isMobile && (
            <div style={{marginLeft:"auto",display:"flex",gap:8}}>
              {[["AVG",avg],["HIGH",hi],["GP",totalGames]].map(([l,v]) => (
                <div key={l} style={{background:"#161b22",border:"1px solid #30363d",borderRadius:8,padding:"7px 11px",textAlign:"center"}}>
                  <div style={{color:"#58a6ff",fontSize:16,fontWeight:700}}>{loading?"…":v}</div>
                  <div style={{color:"#8b949e",fontSize:10}}>{l}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {isMobile && (
          <div style={{display:"flex",gap:8,marginTop:12}}>
            {[["AVG",avg],["HIGH",hi],["GP",totalGames]].map(([l,v]) => (
              <div key={l} style={{flex:1,background:"#161b22",border:"1px solid #30363d",borderRadius:8,padding:"7px 11px",textAlign:"center"}}>
                <div style={{color:"#58a6ff",fontSize:16,fontWeight:700}}>{loading?"…":v}</div>
                <div style={{color:"#8b949e",fontSize:10}}>{l}</div>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {/* Stat tabs */}
      {player && !teamPage && !(tonightLoading && !tonightPlays) && (
        <div style={{display:"flex",gap:6,marginBottom:18}}>
          {tabs.map(k => (
            <button key={k} onClick={() => { setActiveTab(k); setDirection("over"); setSelectedThreshold(null); }} style={{flex:1,padding:"9px 0",borderRadius:8,
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
      {player && !teamPage && !(tonightLoading && !tonightPlays) && (() => {
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
                {/* Explanation at top — follows the active threshold tab (selectedThreshold).
                    Default = first qualified threshold for the stat, else lowest-numbered.
                    Falls through when no tonight play exists for the active stat. */}
                {showExplanation && (() => {
                  const _hasK = Object.keys(kalshiOdds).length > 0;
                  const _allRates = _hasK ? rates.filter(({t}) => kalshiOdds[t]) : rates;
                  const _qm = {};
                  for (const {t} of _allRates) {
                    const tp = tonightPlayerMap[`${safeTab}|${t}`];
                    _qm[t] = !!tp && (tp.edge ?? 0) >= EDGE_GATE;
                  }
                  const _defaultT = _allRates.find(({t}) => _qm[t])?.t ?? _allRates[0]?.t ?? null;
                  const _activeT = selectedThreshold != null && _allRates.some(r => r.t === selectedThreshold)
                    ? selectedThreshold : _defaultT;
                  const activePlay = _activeT != null
                    ? tonightPlayerMap[`${safeTab}|${_activeT}`]
                    : (Object.values(tonightPlayerMap).find(p => p.stat === safeTab) || null);
                  if (!activePlay) return null;
                  return (
                    <div style={{background:"#0d1117",borderRadius:8,padding:"8px 12px",marginBottom:12}}>
                      <InputList inputs={buildLambdaInputs({ ...activePlay, direction })} output={buildModelOutput(activePlay)} />
                    </div>
                  );
                })()}

                {showTriple && !isMLB && (
                  <div style={{color:"#8b949e",fontSize:11,marginBottom:14}}>
                    Soft matchup teams <span style={{color:"#484f58"}}>({wTotal}/{totalGames}g)</span>: {weakTeamList.map(t => t.abbr).join(" · ")}
                  </div>
                )}

                {/* Per-threshold tab strip — show one tab per available threshold (qualified ones
                    marked with a green ★). Click to drill into that threshold's row + lambda inputs.
                    Falls through to no-op when only one threshold is available. */}
                {(() => {
                  const hasK = Object.keys(kalshiOdds).length > 0;
                  const tabRates = hasK ? rates.filter(({t}) => kalshiOdds[t]) : rates;
                  if (tabRates.length <= 1) return null;
                  const qualMap = {};
                  for (const {t} of tabRates) {
                    const tp = tonightPlayerMap[`${safeTab}|${t}`];
                    qualMap[t] = !!tp && (tp.edge ?? 0) >= EDGE_GATE;
                  }
                  const defaultT = tabRates.find(({t}) => qualMap[t])?.t ?? tabRates[0]?.t ?? null;
                  const activeT = selectedThreshold != null && tabRates.some(r => r.t === selectedThreshold)
                    ? selectedThreshold : defaultT;
                  return (
                    <div style={{display:"flex",gap:4,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
                      {tabRates.map(({t}) => {
                        const active = t === activeT;
                        const q = qualMap[t];
                        const label = direction === "under" ? `<${t}` : `${t}+`;
                        return (
                          <button key={t} onClick={() => setSelectedThreshold(t)}
                            style={{padding:"5px 10px",borderRadius:6,
                              border:`1px solid ${active ? "#58a6ff" : q ? "#3fb950" : "#30363d"}`,
                              background: active ? "rgba(88,166,255,0.12)" : q ? "rgba(63,185,80,0.08)" : "#161b22",
                              color: active ? "#58a6ff" : q ? "#3fb950" : "#8b949e",
                              fontSize:11,fontWeight: active ? 700 : 500,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                            {label}{q && !active ? " ★" : ""}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Threshold rows — filter to Kalshi thresholds when available, then drill into
                    selectedThreshold (single-row render). Lambda InputList rendered after the row. */}
                {(() => {
                  const hasKalshi = Object.keys(kalshiOdds).length > 0;
                  const allRates = hasKalshi ? rates.filter(({t}) => kalshiOdds[t]) : rates;
                  // Default to first qualified threshold, fall back to first available
                  const _qm = {};
                  for (const {t} of allRates) {
                    const tp = tonightPlayerMap[`${safeTab}|${t}`];
                    _qm[t] = !!tp && (tp.edge ?? 0) >= EDGE_GATE;
                  }
                  const _defaultT = allRates.find(({t}) => _qm[t])?.t ?? allRates[0]?.t ?? null;
                  const _activeT = selectedThreshold != null && allRates.some(r => r.t === selectedThreshold)
                    ? selectedThreshold : _defaultT;
                  const displayRates = allRates.filter(({t}) => t === _activeT);
                  // Pre-compute raw truePct per threshold. Track which thresholds have API truePct
                  // so the monotonicity walk doesn't let a noisy fallback value lift an API value.
                  const _rawTruePctMap = {};
                  const _apiThresholds = new Set();
                  for (const {t, pct: pctOver} of displayRates) {
                    const _tp = tonightPlayerMap[`${safeTab}|${t}`];
                    const _pct = pctOver;
                    const _dvp = dvpMap[t];
                    const _softPctRaw = isMLB ? (_dvp?.wPct ?? null) : (_tp?.softPct != null ? _tp.softPct : (_dvp?.wPct ?? null));
                    const _truePctRaw = (_tp && _tp.truePct != null) ? _tp.truePct : (_softPctRaw !== null ? (_pct + _softPctRaw) / 2 : null);
                    _rawTruePctMap[t] = _truePctRaw;
                    if (_tp && _tp.truePct != null) _apiThresholds.add(t);
                  }
                  // Enforce monotonicity only across API-sourced thresholds (P(X>=3) >= P(X>=4) >= ...).
                  // Fallback-derived values (e.g. naive (season+soft)/2 for thresholds outside the
                  // 70–97% Kalshi band) are left untouched so they can't lift the model's API values.
                  { const _mts = [..._apiThresholds].filter(t => _rawTruePctMap[t] != null).sort((a,b) => b-a);
                    let _mx = 0;
                    for (const _t of _mts) { if (_rawTruePctMap[_t] < _mx) _rawTruePctMap[_t] = _mx; else _mx = _rawTruePctMap[_t]; } }
                  // Cap fallback thresholds above an API anchor: P(X>=t) cannot exceed P(X>=t') for t > t'.
                  // Walk low→high; once an API value is seen, every later (higher-threshold) fallback is capped at it.
                  { const _ts = [...new Set(displayRates.map(r => r.t))].sort((a,b) => a-b);
                    let _apiCap = null;
                    for (const _t of _ts) {
                      if (_apiThresholds.has(_t)) { _apiCap = _rawTruePctMap[_t]; }
                      else if (_apiCap != null && _rawTruePctMap[_t] != null && _rawTruePctMap[_t] > _apiCap) {
                        _rawTruePctMap[_t] = _apiCap;
                      }
                    } }
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
                    const edgeColor = edge === null ? null : edge >= EDGE_GATE ? "#3fb950" : edge >= 0 ? "#e3b341" : "#f78166";
                    const edgeStr = edge === null ? null : (edge >= 0 ? `+${edge.toFixed(1)}%` : `${edge.toFixed(1)}%`);

                    // Show track button only when the play+threshold qualifies:
                    // kalshi within [KALSHI_GATE, KALSHI_CAP] and edge >= EDGE_GATE.
                    const qualifyingPct = truePct !== null ? truePct : pct;
                    const qualifies = k && k.pct >= KALSHI_GATE && k.pct <= KALSHI_CAP && edge >= EDGE_GATE && tonightPlay;
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
                          opponent: tonightPlay?.opponent || "",
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
                              {!isMobile && <div style={{color:"#8b949e",fontSize:11,width:80,flexShrink:0}}>{count}/{totalGames}g</div>}
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
                                    {!isMobile && <div title={softGamesLabel} style={{color:"#8b949e",fontSize:10,width:80,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{softGamesLabel}</div>}
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
                                  {!isMobile && <div style={{color:"#8b949e",fontSize:10,width:80,flexShrink:0}}>{isMLB ? `'25+'26 (${totalGames}g)` : `${count}/${totalGames}g`}</div>}
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
                                      {!isMobile && <div title={softGamesLabel} style={{color:"#8b949e",fontSize:10,width:80,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{softGamesLabel}</div>}
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
                        <table style={{width:"100%",minWidth:520,borderCollapse:"collapse",fontSize:11}}>
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
          allTonightPlays={allTonightPlays || []}
          tonightPlays={tonightPlays || []}
          tonightLoading={tonightLoading}
          navigateToPlayer={navigateToPlayer}
          navigateToTeam={navigateToTeam}
          navigateToModel={navigateToModel}
          fetchReport={fetchReport}
          authEmail={authEmail}
          logout={logout}
          syncStatus={syncStatus}
          onLoginClick={() => { setShowAuthModal(true); setAuthMode("login"); setAuthError(""); }}
          mlbMeta={mlbMeta}
          mlbMetaTomorrow={mlbMetaTomorrow}
          nbaMeta={nbaMeta}
          wnbaMeta={wnbaMeta}
          nhlMeta={nhlMeta}
          trackedPlays={trackedPlays}
          untrackPlay={untrackPlay}
          navigateToPlay={navigateToPlay}
          trackPlay={initiateTrack}
          openPicksDrawer={() => setShowPicksDrawer(d => !d)}
          showPicksDrawer={showPicksDrawer}
          picksButtonRef={fabRef}
        />
      )}

      <div style={{color:"#484f58",fontSize:11,marginTop:12,textAlign:"center"}}>
        Powered by ESPN API · Vercel Edge
      </div>


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
        width: isMobile ? "100vw" : "min(max(340px, 50vw), 680px)",
        maxWidth: "100vw",
        background:"#0d1117",
        borderLeft: isMobile ? "none" : "1px solid #30363d",
        zIndex:598,
        display:"flex", flexDirection:"column",
        transform: showPicksDrawer ? "translateX(0)" : "translateX(100%)",
        transition:"transform 0.3s ease",
        boxShadow:"-4px 0 32px rgba(0,0,0,0.6)",
        // overflowX:hidden on the panel + inner content prevents wide child elements
        // (cards with long names, week/day pickers, chart rows) from pushing horizontal
        // scroll on mobile where the drawer is 100vw.
        overflowX:"hidden",
        boxSizing:"border-box",
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
        <div style={{flex:1, overflowY:"auto", overflowX:"hidden", padding:"12px 20px 24px", boxSizing:"border-box", minWidth:0}}>
          <MyPicksColumn
            trackedPlays={trackedPlays}
            setTrackedPlays={setTrackedPlays}
            untrackPlay={untrackPlay}
            navigateToTeam={navigateToTeam}
            navigateToPlay={navigateToPlay}
            bankroll={bankroll}
            setBankroll={setBankroll}
            setPickUnits={setPickUnits}
            chartMonth={chartMonth}
            setChartMonth={setChartMonth}
            openPickMonths={openPickMonths}
            setOpenPickMonths={setOpenPickMonths}
            openPickWeeks={openPickWeeks}
            setOpenPickWeeks={setOpenPickWeeks}
            openPickDays={openPickDays}
            setOpenPickDays={setOpenPickDays}
            editPickId={editPickId}
            setEditPickId={setEditPickId}
            setPlayResult={setPlayResult}
            setShowAddPick={setShowAddPick}
            oddsToProfit={oddsToProfit}
            liveStats={liveStats}
            mlbGameScores={mlbMeta?.gameScores || {}}
            nbaGameScores={nbaMeta?.gameScores || {}}
            wnbaGameScores={wnbaMeta?.gameScores || {}}
            nhlGameScores={nhlMeta?.gameScores || {}}
          />
        </div>
      </div>

    </div>
  );
}


export default App;
