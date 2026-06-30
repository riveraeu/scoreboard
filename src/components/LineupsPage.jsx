import React from 'react';
import MatchupCard from './MatchupCard.jsx';
import { useIsMobile } from '../lib/hooks.js';
import { qualifiesForDisplay, trackIdFor } from '../lib/qualify.js';
import { getPushState, subscribeToPush, unsubscribeFromPush, isStandalone, isIOS, pushSupported } from '../lib/push.js';

const SPORT_ORDER = { mlb: 0, nba: 1, wnba: 2, nhl: 3 };
const SPORT_LABEL = { mlb: 'MLB', nba: 'NBA', wnba: 'WNBA', nhl: 'NHL' };

// Build ordered games list for a single sport.
function buildGames(allPlays, sport, meta, metaTomorrow) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const gameMap = new Map();

  // Backfill lookup: when a play lacks gameTime (the backend gameTimes map can transiently come
  // back empty on an ESPN scoreboard hiccup), adopt the start time from the matching gameScores
  // entry so the play seeds the SAME card key as gameScores instead of spawning a timeless
  // duplicate card. Skip doubleheaders (2+ games for one pair+date) — a timeless play can't be
  // disambiguated, so leave it on the empty-time key (existing behavior).
  const scoreTimeByPairDate = new Map();
  for (const gs of [...Object.values(meta?.gameScores || {}), ...Object.values(metaTomorrow?.gameScores || {})]) {
    if (!gs.homeTeam || !gs.awayTeam || !gs.gameTime) continue;
    const k = `${[gs.homeTeam, gs.awayTeam].sort().join('|')}|${gs.gameDate ?? ''}`;
    if (!scoreTimeByPairDate.has(k)) scoreTimeByPairDate.set(k, gs.gameTime);
    else if (scoreTimeByPairDate.get(k) !== gs.gameTime) scoreTimeByPairDate.set(k, null); // DH → ambiguous
  }

  for (const play of allPlays || []) {
    if (play.sport !== sport) continue;
    // Only gate-passing plays seed matchup cards. qualified:false plays exist solely for the
    // player card (alt thresholds, missed gates).
    if (!passesGate(play)) continue;

    let homeTeam, awayTeam, gameDate, gameTime, ouLine;

    if (play.gameType === 'total' || play.gameType === 'teamTotal' || play.gameType === 'ml' || play.gameType === 'spread') {
      ({ homeTeam, awayTeam, gameDate, gameTime } = play);
      ouLine = play.gameOuLine ?? null;
    } else {
      const t1 = play.playerTeam, t2 = play.opponent;
      if (!t1 || !t2) continue;
      gameDate = play.gameDate ?? '';
      gameTime = play.gameTime ?? null;
      // For future-day plays, prefer the day-matched homeTeams map. Today's `meta.homeTeams`
      // would otherwise incorrectly anchor (e.g. PHI@BOS today → PHI mapped to BOS) when the
      // play is for a different opponent tomorrow.
      const _metaForDay = (gameDate && gameDate > today && metaTomorrow) ? metaTomorrow : meta;
      const _metaHome = _metaForDay?.homeTeams?.[t1] || _metaForDay?.homeTeams?.[t2];
      if (_metaHome) {
        homeTeam = _metaHome; awayTeam = _metaHome === t1 ? t2 : t1;
      } else {
        [homeTeam, awayTeam] = [t1, t2].sort();
      }
    }

    if (gameDate && gameDate < today) continue;
    if (!homeTeam || !awayTeam) continue;

    const sortedPair = [homeTeam, awayTeam].sort().join('|');
    // If the play has no gameTime, adopt the matching gameScores start time so it merges with
    // the gameScores-seeded card rather than duplicating it (see scoreTimeByPairDate above).
    if (!gameTime) {
      const backfill = scoreTimeByPairDate.get(`${sortedPair}|${gameDate ?? ''}`);
      if (backfill) gameTime = backfill;
    }
    // gameTime included so same-day doubleheaders (e.g. DET @ BAL twice) get separate cards.
    const key = `${sortedPair}|${gameDate ?? ''}|${gameTime ?? ''}`;

    if (!gameMap.has(key)) {
      gameMap.set(key, { sport, homeTeam, awayTeam, gameDate, gameTime, ouLine });
    }
    const g = gameMap.get(key);
    if (play.gameType === 'total' || play.gameType === 'ml' || play.gameType === 'spread') {
      g.homeTeam = play.homeTeam;
      g.awayTeam = play.awayTeam;
    }
    if (!g.gameTime && play.gameTime) g.gameTime = play.gameTime;
    if (g.ouLine == null && ouLine != null) g.ouLine = ouLine;
  }

  // Seed finished/in-progress games from meta.gameScores (any sport)
  if (meta?.gameScores) {
    for (const gs of Object.values(meta.gameScores)) {
      const { homeTeam: gsHome, awayTeam: gsAway, gameDate: gsDate, gameTime: gsTime } = gs;
      if (!gsHome || !gsAway) continue;
      if (gsDate && gsDate < today) continue;
      const sortedPair = [gsHome, gsAway].sort().join('|');
      const key = `${sortedPair}|${gsDate ?? ''}|${gsTime ?? ''}`;
      if (!gameMap.has(key)) {
        gameMap.set(key, { sport, homeTeam: gsHome, awayTeam: gsAway, gameDate: gsDate, gameTime: gsTime, ouLine: null });
      }
      const g = gameMap.get(key);
      g.gameState = gs.state;
      g.gameDetail = gs.detail;
      g.homeScore = gs.homeScore;
      g.awayScore = gs.awayScore;
      if (!g.gameTime && gsTime) g.gameTime = gsTime;
      if (gs.seriesSummary) g.seriesSummary = gs.seriesSummary;
      if (gs.homeRecord) g.homeRecord = gs.homeRecord;
      if (gs.awayRecord) g.awayRecord = gs.awayRecord;
    }
  }

  return [...gameMap.values()];
}

// All sports combined.
function buildAllGames(allPlays, mlbMeta, mlbMetaTomorrow, nbaMeta, wnbaMeta, nhlMeta) {
  return [
    ...buildGames(allPlays, 'mlb', mlbMeta, mlbMetaTomorrow),
    ...buildGames(allPlays, 'nba', nbaMeta, undefined),
    ...buildGames(allPlays, 'wnba', wnbaMeta, undefined),
    ...buildGames(allPlays, 'nhl', nhlMeta, undefined),
  ];
}

// Mirror of App.jsx's _qualifiedFilter: dc + edge gate, no SimScore. Alt-line dedup is
// suppressed client-side so each threshold that clears EDGE_GATE surfaces independently.
// EDGE_GATE imported from shared config.
// Build a tracked-id Set so passesGate can re-surface alt-line picks the user has tracked
// (server-side dedup may have demoted them in favor of a higher-edge alt; we want them
// visible in their matchup card regardless).
function buildTrackedIds(trackedPlays) {
  const ids = new Set();
  for (const p of (trackedPlays || [])) if (p?.id) ids.add(p.id);
  return ids;
}
function passesGate(p, trackedIds) {
  // Tracked picks always pass — keep visibility of the user's actual bet even if dedup
  // demoted it. Check this BEFORE the dedup filter so tracked alts survive. This bypass is
  // intentionally looser than App's _qualifiedFilter (which still enforces dc + edge):
  // matchup cards must show the user's actual bet unconditionally.
  if (trackedIds && trackedIds.has(trackIdFor(p))) return true;
  return qualifiesForDisplay(p);
}
// Mirror the server-side _ddKey from api/[...path].js so the client can decide whether a
// given API play sits in the same dedup-group as a tracked pick (and if so, suppress it in
// favor of the user's tracked alt).
function _dedupKey(p) {
  const gd = p.gameDate || '';
  if (p.gameType === 'total') return `gt|${p.sport}|${p.homeTeam}|${p.awayTeam}|${gd}|${p.direction || 'over'}`;
  if (p.gameType === 'teamTotal') return `tt|${p.sport}|${p.scoringTeam}|${p.oppTeam}|${gd}|${p.direction || 'over'}`;
  if (p.gameType === 'spread') {
    const teams = [p.pickTeam, p.oppTeam].sort().join('|');
    return `sp|${p.sport}|${teams}|${gd}`;
  }
  if (!p.gameType && p.playerName && p.stat) return `pp|${p.sport}|${p.playerName}|${p.stat}|${gd}`;
  return null;
}
function _matchesGame(p, game) {
  if (p.sport !== game.sport) return false;
  if (game.gameDate && p.gameDate && p.gameDate !== game.gameDate) return false;
  // Same-day doubleheader disambiguation: when both sides know the time, require an exact
  // match so a play attached to game 2 (22:05Z) doesn't also surface on game 1's card.
  if (game.gameTime && p.gameTime && p.gameTime !== game.gameTime) return false;
  const teams = new Set([game.homeTeam, game.awayTeam]);
  if (p.gameType === 'total') return p.homeTeam === game.homeTeam && p.awayTeam === game.awayTeam;
  if (p.gameType === 'teamTotal') return teams.has(p.scoringTeam);
  if (p.gameType === 'ml') return p.homeTeam === game.homeTeam && p.awayTeam === game.awayTeam;
  if (p.gameType === 'spread') return p.homeTeam === game.homeTeam && p.awayTeam === game.awayTeam;
  return teams.has(p.playerTeam);
}
function playsForGame(allPlays, game, trackedIds, trackedPlays, placeableIds) {
  // Tracked dedup-keys for this matchup — any API alt that lands in the same group as a
  // tracked pick gets suppressed (unless it IS the tracked pick). E.g. user tracked LAD +1.5,
  // server emits LAD +2.5 as the highest-edge alt; we hide LAD +2.5 because the user already
  // has a bet on this matchup's spread.
  const trackedKeysForMatchup = new Set();
  for (const tp of (trackedPlays || [])) {
    if (!_matchesGame(tp, game)) continue;
    const k = _dedupKey(tp);
    if (k) trackedKeysForMatchup.add(k);
  }
  const apiPlays = (allPlays || []).filter(p => {
    if (!passesGate(p, trackedIds) || !_matchesGame(p, game)) return false;
    const k = _dedupKey(p);
    // If this play sits in a dedup-group the user has tracked AND it's not their tracked pick,
    // hide it — their tracked alt is shown instead.
    if (k && trackedKeysForMatchup.has(k) && !trackedIds.has(trackIdFor(p))) return false;
    // When a placeable set is provided, hide untracked plays that aren't in it (e.g. Kelly=0).
    // Tracked plays always show regardless so existing bets stay visible.
    // Exception: started/in-progress games always show — placeableIds excludes them to prevent
    // Place All orders, but users should still be able to view and manually track them.
    const gameStarted = game.gameState === 'in' || game.gameState === 'post' ||
      (game.gameTime && new Date(game.gameTime).getTime() <= Date.now());
    if (placeableIds && !gameStarted && !trackedIds.has(trackIdFor(p)) && !placeableIds.has(trackIdFor(p))) return false;
    return true;
  });
  // Spread alt-line dedup: when multiple qualifying lines exist for the same pickTeam
  // (e.g. CWS +2.5 and CWS +3.5 both pass the category gate), keep only the highest-edge one.
  // Tracked plays are exempt — they always show regardless of line.
  const _spreadBest = new Map();
  for (const p of apiPlays) {
    if (p.gameType !== 'spread' || (trackedIds && trackedIds.has(trackIdFor(p)))) continue;
    const sk = `${p.sport}|${p.pickTeam}|${p.oppTeam}|${p.gameDate ?? ''}`;
    if (!_spreadBest.has(sk) || (p.edge ?? 0) > (_spreadBest.get(sk).edge ?? 0)) _spreadBest.set(sk, p);
  }
  const dedupedApiPlays = apiPlays.filter(p => {
    if (p.gameType !== 'spread' || (trackedIds && trackedIds.has(trackIdFor(p)))) return true;
    const sk = `${p.sport}|${p.pickTeam}|${p.oppTeam}|${p.gameDate ?? ''}`;
    return _spreadBest.get(sk) === p;
  });
  // Synthesize a play for any tracked pick on this matchup that wasn't in the API response
  // (e.g. tracked LAD +1.5 today — server-side EDGE_GATE filtered it out before dedup, so it
  // doesn't exist in plays[] for the tracked-id check to match against). _synthFromTracked
  // marker prevents the matchup-card badge "all tracked" check from firing on cards where the
  // only plays are synthesized (which would always evaluate as all-tracked).
  if (!trackedPlays) return dedupedApiPlays;
  const apiIds = new Set(dedupedApiPlays.map(trackIdFor));
  const extras = (trackedPlays || [])
    .filter(p => !apiIds.has(p.id) && _matchesGame(p, game))
    .map(p => ({ ...p, _synthFromTracked: true }));
  return [...dedupedApiPlays, ...extras];
}

function ptDate(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function dayTabLabel(dateStr) {
  const today = ptDate(Date.now());
  const tomorrow = ptDate(Date.now() + 86400000);
  if (dateStr === today) return 'Today';
  if (dateStr === tomorrow) return 'Tomorrow';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function LineupsPage({
  allTonightPlays,
  tonightPlays = [],
  tonightLoading,
  navigateToPlayer,
  navigateToTeam,
  navigateToModel,
  authEmail,
  logout,
  syncStatus,
  onLoginClick,
  mlbMeta,
  mlbMetaTomorrow,
  nbaMeta,
  wnbaMeta,
  nhlMeta,
  polyMlByGame,
  trackedPlays,
  untrackPlay,
  navigateToPlay,
  trackPlay,
  openPicksDrawer,
  showPicksDrawer,
  picksButtonRef,
  placeAllCount = 0,
  onPlaceAll,
  activeDayTab,
  setActiveDayTab,
  placeAllCountByDay = {},
  placeAllPlaceableIds = null,
}) {
  const [expandedPlays, setExpandedPlays] = React.useState(new Set());
  // Web Push subscription state: 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed' | null (loading).
  const [pushState, setPushState] = React.useState(null);
  const [pushBusy, setPushBusy] = React.useState(false);
  React.useEffect(() => { getPushState().then(setPushState); }, []);

  // Toggle background push. On iOS, push only works once installed to the Home Screen —
  // if we're in a Safari tab, point the user there instead of silently failing.
  const togglePush = async () => {
    if (pushBusy) return;
    if (pushState === 'subscribed') {
      setPushBusy(true);
      try { await unsubscribeFromPush(); setPushState('unsubscribed'); }
      finally { setPushBusy(false); }
      return;
    }
    if (isIOS() && !isStandalone()) {
      alert('To get alerts on iPhone: tap the Share button in Safari, choose "Add to Home Screen", then open Scoreboard from your Home Screen and enable notifications there.');
      return;
    }
    setPushBusy(true);
    try {
      await subscribeToPush();
      setPushState('subscribed');
    } catch (e) {
      setPushState(await getPushState());
      alert(e?.message || 'Could not enable notifications');
    } finally {
      setPushBusy(false);
    }
  };

  // Collect unique PT dates from all plays + mlbMeta.gameScores
  const dayTabs = React.useMemo(() => {
    const today = ptDate(Date.now());
    const dates = new Set([today]);
    for (const p of allTonightPlays || []) {
      const d = p.gameTime ? ptDate(p.gameTime) : p.gameDate;
      if (d && d >= today) dates.add(d);
    }
    for (const gs of Object.values(mlbMeta?.gameScores || {})) {
      const d = gs.gameTime ? ptDate(gs.gameTime) : gs.gameDate;
      if (d && d >= today) dates.add(d);
    }
    return [...dates].sort();
  }, [allTonightPlays, mlbMeta]);

  // Reset tab if it rolls off the list
  React.useEffect(() => {
    if (dayTabs.length > 0 && !dayTabs.includes(activeDayTab)) {
      setActiveDayTab(dayTabs[0]);
    }
  }, [dayTabs, activeDayTab]);

  // DNP excluded — it's a settled result (player didn't play), not an active pick.
  // Matches MyPicksColumn's "active" stat so the badge count agrees with the drawer.
  const activePicks = (trackedPlays || []).filter(p => !p.result);
  // Build trackedIds once per render so playsForGame can re-surface demoted alt-line picks
  // the user is already tracking (server-side dedup may demote them — see passesGate).
  const trackedIds = React.useMemo(() => buildTrackedIds(activePicks), [activePicks]);
  // Tracked active picks per day for the second (gold) tab badge.
  const trackedByDay = React.useMemo(() => {
    const counts = {};
    for (const p of (trackedPlays || [])) {
      if (p.result) continue; // settled (won/lost/dnp) doesn't count as active
      const d = p.gameTime ? ptDate(p.gameTime) : p.gameDate;
      if (d) counts[d] = (counts[d] || 0) + 1;
    }
    return counts;
  }, [trackedPlays]);
  // Dedup keys for tracked picks per day — used to mirror playsForGame's tracked-alt
  // suppression logic at the day-tab level (so a non-tracked alt the user has tracked-
  // at-a-different-line doesn't get double-counted alongside the tracked one).
  const trackedDedupKeysByDay = React.useMemo(() => {
    const map = {};
    for (const p of (trackedPlays || [])) {
      if (p.result) continue;
      const d = p.gameTime ? ptDate(p.gameTime) : p.gameDate;
      if (!d) continue;
      const k = _dedupKey(p);
      if (!k) continue;
      if (!map[d]) map[d] = new Set();
      map[d].add(k);
    }
    return map;
  }, [trackedPlays]);
  // Untracked-visible count per day for the green tab badge. Mirrors what the user actually
  // sees on the matchup cards: plays passing the gate (incl tracked-bypass for low-dc tracked
  // picks), minus tracked picks themselves, minus alt-line plays hidden because the user
  // tracked a different alt of the same dedup-group.
  const qualifiedByDay = React.useMemo(() => {
    const nowMs = Date.now();
    const counts = {};
    for (const p of allTonightPlays || []) {
      if (!passesGate(p, trackedIds)) continue;
      // Exclude plays whose game has already started — can't be bet.
      if (p.gameTime && new Date(p.gameTime).getTime() <= nowMs) continue;
      const d = p.gameTime ? ptDate(p.gameTime) : p.gameDate;
      if (!d) continue;
      // Exclude tracked picks (they're counted by trackedByDay → gold badge).
      if (trackedIds.has(trackIdFor(p))) continue;
      // Mirror playsForGame's dedup-hide: if user tracked a different alt of the same
      // dedup-group, this play is hidden on the card and shouldn't count here either.
      const k = _dedupKey(p);
      const dayDedup = trackedDedupKeysByDay[d];
      if (k && dayDedup && dayDedup.has(k)) continue;
      counts[d] = (counts[d] || 0) + 1;
    }
    return counts;
  }, [allTonightPlays, trackedIds, trackedDedupKeysByDay]);

  // All games for the active day, sorted by sport then game time
  const gamesForDay = React.useMemo(() => {
    const all = buildAllGames(allTonightPlays, mlbMeta, mlbMetaTomorrow, nbaMeta, wnbaMeta, nhlMeta);
    return all
      .filter(g => {
        const d = g.gameTime ? ptDate(g.gameTime) : (g.gameDate || '');
        return d === activeDayTab;
      })
      .sort((a, b) => {
        const sd = (SPORT_ORDER[a.sport] ?? 9) - (SPORT_ORDER[b.sport] ?? 9);
        if (sd !== 0) return sd;
        return (a.gameTime || '').localeCompare(b.gameTime || '');
      });
  }, [allTonightPlays, mlbMeta, mlbMetaTomorrow, nbaMeta, wnbaMeta, nhlMeta, activeDayTab]);

  const sportGroups = React.useMemo(() => {
    const groups = {};
    for (const game of gamesForDay) {
      if (!groups[game.sport]) groups[game.sport] = [];
      groups[game.sport].push(game);
    }
    return groups;
  }, [gamesForDay]);

  const isMobile = useIsMobile();
  const btnSize = isMobile
    ? { fontSize: 12, padding: '0 12px', height: 32 }
    : { fontSize: 10, padding: '0 8px', height: 22 };

  const dayTabsEl = (
    <div style={{ display: 'flex', gap: 0, overflowX: 'auto', flex: isMobile ? '1 1 auto' : '0 0 auto', scrollbarWidth: 'none' }}>
      {dayTabs.map(dateStr => {
        const active = activeDayTab === dateStr;
        const count = (authEmail && placeAllPlaceableIds != null)
          ? (placeAllCountByDay[dateStr] ?? 0)
          : (qualifiedByDay[dateStr] ?? 0);
        const tracked = trackedByDay[dateStr] ?? 0;
        return (
          <button
            key={dateStr}
            onClick={() => setActiveDayTab(dateStr)}
            style={{
              padding: isMobile ? '10px 14px' : '8px 14px',
              background: 'none', border: 'none',
              borderBottom: active ? '2px solid #58a6ff' : '2px solid transparent',
              color: active ? '#58a6ff' : '#8b949e', fontWeight: active ? 700 : 400,
              fontSize: 13, cursor: 'pointer', transition: 'color 0.15s',
              marginBottom: -1, whiteSpace: 'nowrap', flexShrink: 0,
            }}>
            {dayTabLabel(dateStr)}
            {count > 0 && (
              <span style={{
                marginLeft: 5, fontSize: 10, fontWeight: 700, color: '#3fb950',
                background: 'rgba(63,185,80,0.12)', border: '1px solid rgba(63,185,80,0.3)',
                borderRadius: 10, padding: '1px 5px',
              }}>{count}</span>
            )}
            {tracked > 0 && (
              <span style={{
                marginLeft: 3, fontSize: 10, fontWeight: 700, color: '#e3b341',
                background: 'rgba(227,179,65,0.12)', border: '1px solid rgba(227,179,65,0.3)',
                borderRadius: 10, padding: '1px 5px',
              }}>{tracked}</span>
            )}
          </button>
        );
      })}
    </div>
  );

  const actionButtonsEl = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...(isMobile ? { justifyContent: 'flex-end', flexWrap: 'wrap' } : { flex: 1, justifyContent: 'flex-end' }) }}>
      {pushSupported() && pushState && pushState !== 'denied' && pushState !== 'subscribed' && (
        <button
          title={pushState === 'subscribed' ? 'Background alerts on — tap to turn off' : 'Get play alerts on this device (even when the app is closed)'}
          onClick={togglePush}
          disabled={pushBusy}
          style={{ ...btnSize, borderRadius: 6, cursor: pushBusy ? 'default' : 'pointer',
            border: `1px solid ${pushState === 'subscribed' ? 'rgba(63,185,80,0.3)' : '#30363d'}`,
            background: pushState === 'subscribed' ? 'rgba(63,185,80,0.12)' : 'transparent',
            color: pushState === 'subscribed' ? '#3fb950' : '#484f58', fontWeight: 600,
            opacity: pushBusy ? 0.6 : 1 }}>
          {pushState === 'subscribed' ? '🔔' : '🔕'}
        </button>
      )}
      {authEmail && placeAllCount > 0 && (
        <button onClick={onPlaceAll}
          title={`Order all ${placeAllCount} qualified Kalshi contracts`}
          style={{ ...btnSize, borderRadius: 6, cursor: 'pointer',
            border: '1px solid #30363d', background: 'transparent', color: '#484f58', fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 4 }}>
          <span>⚡</span> Order
          <span style={{ background: 'rgba(63,185,80,0.12)', border: '1px solid rgba(63,185,80,0.3)',
            color: '#3fb950', fontSize: 9, fontWeight: 700, borderRadius: 8, padding: '0 4px', lineHeight: '14px' }}>
            {placeAllCount}
          </span>
        </button>
      )}
      <button ref={picksButtonRef} onClick={openPicksDrawer}
        style={{ ...btnSize, borderRadius: 6, cursor: 'pointer',
          border: `1px solid ${showPicksDrawer ? '#58a6ff' : '#30363d'}`,
          background: showPicksDrawer ? 'rgba(88,166,255,0.12)' : 'transparent',
          color: showPicksDrawer ? '#58a6ff' : '#484f58', fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: '#e3b341' }}>★</span> Track
        {activePicks.length > 0 && (
          <span title="Tracked picks" style={{ background: 'rgba(227,179,65,0.12)', border: '1px solid rgba(227,179,65,0.3)',
            color: '#e3b341', fontSize: 9, fontWeight: 700,
            borderRadius: 8, padding: '0 4px', lineHeight: '14px' }}>
            {activePicks.length}
          </span>
        )}
      </button>
      <button onClick={() => navigateToModel()}
        style={{ ...btnSize, borderRadius: 6, cursor: 'pointer',
          border: '1px solid #30363d', background: 'transparent', color: '#484f58', fontWeight: 600 }}>
        Report
      </button>
      {authEmail ? (
        <button onClick={logout}
          style={{ ...btnSize, borderRadius: 6, cursor: 'pointer',
            border: '1px solid #30363d', background: 'transparent', color: '#484f58', fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
            background: syncStatus === 'saving' ? '#e3b341' : syncStatus === 'error' ? '#f78166' : '#3fb950',
            display: 'inline-block' }} />
          Log Out
        </button>
      ) : (
        <button onClick={onLoginClick}
          style={{ ...btnSize, borderRadius: 6, cursor: 'pointer',
            border: '1px solid #58a6ff', background: 'transparent', color: '#58a6ff', fontWeight: 600 }}>
          Log In
        </button>
      )}
    </div>
  );

  return (
    <div>
      {isMobile ? (
        <>
          {/* Row 1: day tabs (full width, horizontal scroll if many) */}
          <div style={{ borderBottom: '1px solid #21262d', marginBottom: 10 }}>
            {dayTabsEl}
          </div>
          {/* Row 2: action buttons */}
          <div style={{ marginBottom: 14 }}>
            {actionButtonsEl}
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #21262d', marginBottom: 16 }}>
          {/* Left: week label */}
          <div style={{ flex: 1 }}>
            {(() => {
              const d = new Date(), dow = d.getDay(), daysToMon = (dow + 6) % 7;
              const mon = new Date(d - daysToMon * 86400000);
              const label = mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              return <span style={{ color: '#484f58', fontWeight: 400, fontSize: 12 }}>Week of {label}</span>;
            })()}
          </div>
          {/* Center: day tabs */}
          {dayTabsEl}
          {/* Right: action buttons */}
          {actionButtonsEl}
        </div>
      )}

      {/* Loading */}
      {tonightLoading && (
        <div style={{ color: '#484f58', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
          Loading games…
        </div>
      )}

      {/* Empty state */}
      {!tonightLoading && gamesForDay.length === 0 && (
        <div style={{ color: '#484f58', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
          No games scheduled for {dayTabLabel(activeDayTab)}.
        </div>
      )}

      {/* Sport-grouped game cards */}
      {['mlb', 'nba', 'wnba', 'nhl'].map(sport => {
        const games = sportGroups[sport];
        if (!games || games.length === 0) return null;
        return (
          <div key={sport} style={{ marginBottom: 24 }}>
            {/* Sport header */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#484f58', textTransform: 'uppercase', letterSpacing: 1 }}>
                {SPORT_LABEL[sport]}
              </span>
              <div style={{ flex: 1, height: 1, background: '#21262d', marginLeft: 10 }} />
            </div>
            {/* Game grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(480px, 100%), 1fr))', gap: 12, alignItems: 'start' }}>
              {games.map((game, i) => {
                const isPostponed = (game.gameDetail || '').toLowerCase().includes('postpone');
                const gPlays = isPostponed ? [] : playsForGame(allTonightPlays, game, trackedIds, activePicks, placeAllPlaceableIds);
                // Count tracked picks shown on this card — API plays don't have an `id` field
                // (only tracked picks do), so we re-compute via trackIdFor and match against the
                // trackedIds Set built from activePicks (settled picks excluded). Synth plays are
                // already filtered out of the badge count inside MatchupCard via _realPlays.
                const _gPlayTrackedCount = gPlays.filter(gp => !gp._synthFromTracked && trackedIds.has(trackIdFor(gp))).length;
                const _gPlayUntrackedBadge = gPlays.filter(gp => !gp._synthFromTracked && !trackedIds.has(trackIdFor(gp))).length;
                return (
                  <MatchupCard
                    key={`${sport}|${game.homeTeam}|${game.awayTeam}|${game.gameDate}|${i}`}
                    game={game}
                    mlbMeta={mlbMeta}
                    mlbMetaTomorrow={mlbMetaTomorrow}
                    nbaMeta={nbaMeta}
                    wnbaMeta={wnbaMeta}
                    nhlMeta={nhlMeta}
                    polyMl={polyMlByGame?.[`${sport}|${game.awayTeam}@${game.homeTeam}|${game.gameDate}`] || null}
                    navigateToPlayer={navigateToPlayer}
                    navigateToTeam={navigateToTeam}
                    gamePlays={gPlays}
                    gamePlaysTrackedCount={_gPlayTrackedCount}
                    allTonightPlays={allTonightPlays}
                    trackedPlays={trackedPlays}
                    trackPlay={trackPlay}
                    untrackPlay={untrackPlay}
                    navigateToPlay={navigateToPlay}
                    navigateToModel={navigateToModel}
                    expandedPlays={expandedPlays}
                    setExpandedPlays={setExpandedPlays}
                    openPicksDrawer={openPicksDrawer}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
