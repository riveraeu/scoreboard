import React from 'react';
import MatchupCard from './MatchupCard.jsx';
import GamePlayDrawer from './GamePlayDrawer.jsx';

const SPORT_ORDER = { mlb: 0, nba: 1, nhl: 2 };

// Build ordered games list for a single sport.
function buildGames(allPlays, sport, meta) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const gameMap = new Map();

  for (const play of allPlays || []) {
    if (play.sport !== sport) continue;

    let homeTeam, awayTeam, gameDate, gameTime, ouLine;

    if (play.gameType === 'total') {
      ({ homeTeam, awayTeam, gameDate, gameTime } = play);
      ouLine = play.gameOuLine ?? null;
    } else if (play.gameType === 'teamTotal') {
      ({ homeTeam, awayTeam, gameDate, gameTime } = play);
      ouLine = play.gameOuLine ?? null;
    } else {
      const t1 = play.playerTeam, t2 = play.opponent;
      if (!t1 || !t2) continue;
      const _metaHome = meta?.homeTeams?.[t1] || meta?.homeTeams?.[t2];
      if (_metaHome) {
        homeTeam = _metaHome; awayTeam = _metaHome === t1 ? t2 : t1;
      } else {
        [homeTeam, awayTeam] = [t1, t2].sort();
      }
      gameDate = play.gameDate ?? '';
      gameTime = play.gameTime ?? null;
    }

    if (gameDate && gameDate < today) continue;
    if (!homeTeam || !awayTeam) continue;

    const sortedPair = [homeTeam, awayTeam].sort().join('|');
    const key = `${sortedPair}|${gameDate ?? ''}`;

    if (!gameMap.has(key)) {
      gameMap.set(key, { sport, homeTeam, awayTeam, gameDate, gameTime, ouLine });
    }
    const g = gameMap.get(key);
    if (play.gameType === 'total') {
      g.homeTeam = play.homeTeam;
      g.awayTeam = play.awayTeam;
    }
    if (!g.gameTime && play.gameTime) g.gameTime = play.gameTime;
    if (g.ouLine == null && ouLine != null) g.ouLine = ouLine;
  }

  // Seed finished/in-progress MLB games from gameScores
  if (sport === 'mlb' && meta?.gameScores) {
    for (const gs of Object.values(meta.gameScores)) {
      const { homeTeam: gsHome, awayTeam: gsAway, gameDate: gsDate, gameTime: gsTime } = gs;
      if (!gsHome || !gsAway) continue;
      if (gsDate && gsDate < today) continue;
      const sortedPair = [gsHome, gsAway].sort().join('|');
      const key = `${sortedPair}|${gsDate ?? ''}`;
      if (!gameMap.has(key)) {
        gameMap.set(key, { sport, homeTeam: gsHome, awayTeam: gsAway, gameDate: gsDate, gameTime: gsTime, ouLine: null });
      }
      const g = gameMap.get(key);
      g.gameState = gs.state;
      g.gameDetail = gs.detail;
      g.homeScore = gs.homeScore;
      g.awayScore = gs.awayScore;
      if (!g.gameTime && gsTime) g.gameTime = gsTime;
    }
  }

  return [...gameMap.values()];
}

// All sports combined.
function buildAllGames(allPlays, mlbMeta) {
  return [
    ...buildGames(allPlays, 'mlb', mlbMeta),
    ...buildGames(allPlays, 'nba', null),
    ...buildGames(allPlays, 'nhl', null),
  ];
}

// Returns qualified plays belonging to a given game.
function playsForGame(allPlays, game) {
  return (allPlays || []).filter(p => {
    if (p.qualified === false) return false;
    if (p.sport !== game.sport) return false;
    const teams = new Set([game.homeTeam, game.awayTeam]);
    if (p.gameType === 'total') return p.homeTeam === game.homeTeam && p.awayTeam === game.awayTeam;
    if (p.gameType === 'teamTotal') return teams.has(p.scoringTeam);
    return teams.has(p.playerTeam);
  });
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
  tonightLoading,
  navigateToPlayer,
  navigateToTeam,
  navigateToModel,
  fetchReport,
  bustLoading,
  bustCache,
  testMode,
  setTestMode,
  authEmail,
  logout,
  syncStatus,
  onLoginClick,
  mlbMeta,
  mlbMetaTomorrow,
  nbaMeta,
  trackedPlays,
  untrackPlay,
  navigateToPlay,
  trackPlay,
  openPicksDrawer,
}) {
  const [activeDayTab, setActiveDayTab] = React.useState(() =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
  );
  const [drawerGame, setDrawerGame] = React.useState(null);
  const [expandedPlays, setExpandedPlays] = React.useState(new Set());

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

  // If the stored tab is no longer in dayTabs (e.g. day rolled over), reset to today
  React.useEffect(() => {
    if (dayTabs.length > 0 && !dayTabs.includes(activeDayTab)) {
      setActiveDayTab(dayTabs[0]);
    }
  }, [dayTabs, activeDayTab]);

  // Qualified play count per day for tab badges
  const qualifiedByDay = React.useMemo(() => {
    const counts = {};
    for (const p of allTonightPlays || []) {
      if (p.qualified === false) continue;
      const d = p.gameTime ? ptDate(p.gameTime) : p.gameDate;
      if (d) counts[d] = (counts[d] || 0) + 1;
    }
    return counts;
  }, [allTonightPlays]);

  // All games across sports, filtered to active day, sorted by sport then time
  const gamesForDay = React.useMemo(() => {
    const all = buildAllGames(allTonightPlays, mlbMeta);
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
  }, [allTonightPlays, mlbMeta, activeDayTab]);

  function onNotificationClick(game) {
    const gPlays = playsForGame(allTonightPlays, game);
    const allTracked = gPlays.length > 0 && gPlays.every(gp => (trackedPlays || []).some(tp => tp.id === gp.id));
    if (allTracked) {
      openPicksDrawer();
    } else {
      setDrawerGame(game);
    }
  }

  const drawerPlays = drawerGame ? playsForGame(allTonightPlays, drawerGame) : [];

  return (
    <div>
      {/* Tab row: date left | day tabs center | buttons right */}
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
        <div style={{ display: 'flex', gap: 0 }}>
          {dayTabs.map(dateStr => {
            const active = activeDayTab === dateStr;
            const count = qualifiedByDay[dateStr] ?? 0;
            return (
              <button
                key={dateStr}
                onClick={() => setActiveDayTab(dateStr)}
                style={{
                  padding: '8px 14px', background: 'none', border: 'none',
                  borderBottom: active ? '2px solid #58a6ff' : '2px solid transparent',
                  color: active ? '#58a6ff' : '#8b949e', fontWeight: active ? 700 : 400,
                  fontSize: 13, cursor: 'pointer', transition: 'color 0.15s',
                  marginBottom: -1,
                }}>
                {dayTabLabel(dateStr)}
                {count > 0 && (
                  <span style={{
                    marginLeft: 5, fontSize: 10, fontWeight: 700, color: '#3fb950',
                    background: 'rgba(63,185,80,0.12)', border: '1px solid rgba(63,185,80,0.3)',
                    borderRadius: 10, padding: '1px 5px',
                  }}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Right: action buttons */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
          <button onClick={navigateToModel}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid #30363d', background: 'transparent', color: '#484f58', fontWeight: 600 }}>
            model
          </button>
          <button onClick={() => fetchReport('mlb')}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid #30363d', background: 'transparent', color: '#484f58', fontWeight: 600 }}>
            report
          </button>
          <button onClick={() => setTestMode(m => !m)}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${testMode ? '#e3b341' : '#30363d'}`,
              background: testMode ? 'rgba(227,179,65,0.12)' : 'transparent',
              color: testMode ? '#e3b341' : '#484f58', fontWeight: 600 }}>
            {testMode ? '⚗ mock' : 'mock'}
          </button>
          <button onClick={bustCache} disabled={bustLoading}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, cursor: bustLoading ? 'default' : 'pointer',
              border: '1px solid #30363d', background: 'transparent',
              color: bustLoading ? '#30363d' : '#484f58', fontWeight: 600 }}>
            {bustLoading ? 'busting…' : 'bust'}
          </button>
          {authEmail ? (
            <button onClick={logout}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
                border: '1px solid #30363d', background: 'transparent', color: '#484f58', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                background: syncStatus === 'saving' ? '#e3b341' : syncStatus === 'error' ? '#f78166' : '#3fb950',
                display: 'inline-block' }} />
              log out
            </button>
          ) : (
            <button onClick={onLoginClick}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
                border: '1px solid #58a6ff', background: 'transparent', color: '#58a6ff', fontWeight: 600 }}>
              log in
            </button>
          )}
        </div>
      </div>

      {/* Games grid */}
      {tonightLoading && (
        <div style={{ color: '#484f58', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
          Loading games…
        </div>
      )}
      {!tonightLoading && gamesForDay.length === 0 && (
        <div style={{ color: '#484f58', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
          No games scheduled for {dayTabLabel(activeDayTab)}.
        </div>
      )}
      {gamesForDay.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(480px, 1fr))', gap: 12, alignItems: 'start' }}>
          {gamesForDay.map((game, i) => {
            const gPlays = playsForGame(allTonightPlays, game);
            return (
              <MatchupCard
                key={`${game.sport}|${game.homeTeam}|${game.awayTeam}|${game.gameDate}|${i}`}
                game={game}
                mlbMeta={mlbMeta}
                mlbMetaTomorrow={mlbMetaTomorrow}
                nbaMeta={nbaMeta}
                navigateToPlayer={navigateToPlayer}
                navigateToTeam={navigateToTeam}
                gamePlays={gPlays}
                trackedPlays={trackedPlays}
                onNotificationClick={onNotificationClick}
              />
            );
          })}
        </div>
      )}

      {/* Per-game play drawer */}
      {drawerGame && (
        <GamePlayDrawer
          game={drawerGame}
          plays={drawerPlays}
          allTonightPlays={allTonightPlays}
          trackedPlays={trackedPlays}
          trackPlay={trackPlay}
          untrackPlay={untrackPlay}
          navigateToPlay={navigateToPlay}
          navigateToTeam={navigateToTeam}
          navigateToModel={navigateToModel}
          onClose={() => setDrawerGame(null)}
          expandedPlays={expandedPlays}
          setExpandedPlays={setExpandedPlays}
        />
      )}
    </div>
  );
}
