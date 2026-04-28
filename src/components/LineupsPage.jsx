import React from 'react';
import MatchupCard from './MatchupCard.jsx';
import MyPicksColumn from './MyPicksColumn.jsx';
import PlaysColumn from './PlaysColumn.jsx';

const SPORT_TABS = [
  { key: 'mlb', label: 'MLB' },
  { key: 'nba', label: 'NBA' },
  { key: 'nhl', label: 'NHL' },
];

// Build ordered games list from allTonightPlays for a given sport.
// Uses game total plays as anchors for home/away; falls back to sorted abbrs.
function buildGames(allPlays, sport, meta) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const gameMap = new Map(); // sorted-teams|gameDate → game object

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
      // player prop — playerTeam + opponent; home/away unknown until anchor found
      const t1 = play.playerTeam, t2 = play.opponent;
      if (!t1 || !t2) continue;
      // For MLB use schedule-derived home team; other sports fall back to alphabetical
      const _metaHome = meta?.homeTeams?.[t1] || meta?.homeTeams?.[t2];
      if (_metaHome) {
        homeTeam = _metaHome; awayTeam = _metaHome === t1 ? t2 : t1;
      } else {
        [homeTeam, awayTeam] = [t1, t2].sort();
      }
      gameDate = play.gameDate ?? '';
      gameTime = play.gameTime ?? null;
    }

    // Skip games from yesterday or earlier (by gameDate)
    if (gameDate && gameDate < today) continue;

    if (!homeTeam || !awayTeam) continue;
    const sortedPair = [homeTeam, awayTeam].sort().join('|');
    const key = `${sortedPair}|${gameDate ?? ''}`;

    if (!gameMap.has(key)) {
      gameMap.set(key, { sport, homeTeam, awayTeam, gameDate, gameTime, ouLine, plays: [] });
    }
    const g = gameMap.get(key);
    g.plays.push(play);

    // Anchor: total plays carry reliable home/away
    if (play.gameType === 'total') {
      g.homeTeam = play.homeTeam;
      g.awayTeam = play.awayTeam;
    }
    if (!g.gameTime && play.gameTime) g.gameTime = play.gameTime;
    if (g.ouLine == null && ouLine != null) g.ouLine = ouLine;
  }

  // Add finished/in-progress games from mlbMeta.gameScores (no active Kalshi markets = invisible otherwise)
  if (sport === 'mlb' && meta?.gameScores) {
    for (const gs of Object.values(meta.gameScores)) {
      const { homeTeam: gsHome, awayTeam: gsAway, gameDate: gsDate, gameTime: gsTime } = gs;
      if (!gsHome || !gsAway) continue;
      if (gsDate && gsDate < today) continue;
      const sortedPair = [gsHome, gsAway].sort().join('|');
      const key = `${sortedPair}|${gsDate ?? ''}`;
      if (!gameMap.has(key)) {
        gameMap.set(key, { sport, homeTeam: gsHome, awayTeam: gsAway, gameDate: gsDate, gameTime: gsTime, ouLine: null, plays: [] });
      }
      // Attach live score/state to all MLB games (active and finished)
      const g = gameMap.get(key);
      g.gameState = gs.state;
      g.gameDetail = gs.detail;
      g.homeScore = gs.homeScore;
      g.awayScore = gs.awayScore;
      if (!g.gameTime && gsTime) g.gameTime = gsTime;
    }
  }

  return [...gameMap.values()].sort((a, b) => {
    const dateDiff = (a.gameDate || '').localeCompare(b.gameDate || '');
    if (dateDiff !== 0) return dateDiff;
    return (a.gameTime || '').localeCompare(b.gameTime || '');
  });
}

export default function LineupsPage({
  allTonightPlays,
  tonightLoading,
  activeSportTab,
  setActiveSportTab,
  navigateToPlayer,
  navigateToTeam,
  navigateToModel,
  fetchReport,
  bustLoading,
  bustCache,
  testMode,
  setTestMode,
  mlbMeta,
  mlbMetaTomorrow,
  nbaMeta,
  // MyPicksColumn props
  trackedPlays,
  setTrackedPlays,
  untrackPlay,
  calcOdds,
  setCalcOdds,
  bankroll,
  setBankroll,
  setPickUnits,
  chartGroupBy,
  setChartGroupBy,
  openPickWeeks,
  setOpenPickWeeks,
  openPickDays,
  setOpenPickDays,
  editPickId,
  setEditPickId,
  setPlayResult,
  setShowAddPick,
  oddsToProfit,
  navigateToPlay,
  trackPlay,
}) {
  const tabs = [...SPORT_TABS];
  const [expandedPlays, setExpandedPlays] = React.useState(new Set());
  const [showPlaysInfo, setShowPlaysInfo] = React.useState(false);

  // Qualified play count per sport for badge
  const qualifiedBySport = React.useMemo(() => {
    const counts = {};
    for (const p of allTonightPlays || []) {
      if (p.qualified !== false) counts[p.sport] = (counts[p.sport] || 0) + 1;
    }
    return counts;
  }, [allTonightPlays]);

  const games = React.useMemo(
    () => activeSportTab !== 'picks' ? buildGames(allTonightPlays, activeSportTab, activeSportTab === 'mlb' ? mlbMeta : null) : [],
    [allTonightPlays, activeSportTab, mlbMeta]
  );

  const qualifiedPlays = React.useMemo(
    () => activeSportTab !== 'picks'
      ? (allTonightPlays || []).filter(p => p.qualified !== false && p.sport === activeSportTab)
      : [],
    [allTonightPlays, activeSportTab]
  );

  return (
    <div>
      {/* Single row: date left | tabs center | buttons right */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #21262d', marginBottom: 16 }}>
        {/* Left: date */}
        <div style={{ flex: 1 }}>
          {(() => {
            const d = new Date(), dow = d.getDay(), daysToMon = (dow + 6) % 7;
            const mon = new Date(d - daysToMon * 86400000);
            const label = mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return <span style={{ color: '#484f58', fontWeight: 400, fontSize: 12 }}>Week of {label}</span>;
          })()}
        </div>
        {/* Center: tabs */}
        <div style={{ display: 'flex', gap: 0 }}>
          {tabs.map(tab => {
            const active = activeSportTab === tab.key;
            const count = tab.key !== 'picks' ? qualifiedBySport[tab.key] : null;
            return (
              <div key={tab.key} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <button
                  onClick={() => setActiveSportTab(tab.key)}
                  style={{
                    padding: '8px 14px', background: 'none', border: 'none',
                    borderBottom: active ? '2px solid #58a6ff' : '2px solid transparent',
                    color: active ? '#58a6ff' : '#8b949e', fontWeight: active ? 700 : 400,
                    fontSize: 13, cursor: 'pointer', transition: 'color 0.15s',
                    marginBottom: -1,
                  }}>
                  {tab.label}
                  {count > 0 && (
                    <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 700, color: '#3fb950',
                      background: 'rgba(63,185,80,0.12)', border: '1px solid rgba(63,185,80,0.3)',
                      borderRadius: 10, padding: '1px 5px' }}>
                      {count}
                    </span>
                  )}
                </button>
                {tab.key !== 'picks' && (
                  <span
                    onClick={e => { e.stopPropagation(); fetchReport(tab.key); }}
                    title={`Open ${tab.label} market report`}
                    style={{ fontSize: 11, cursor: 'pointer', color: '#484f58', marginLeft: -8, marginRight: 4,
                      userSelect: 'none', lineHeight: 1 }}
                    onMouseEnter={e => e.currentTarget.style.color = '#8b949e'}
                    onMouseLeave={e => e.currentTarget.style.color = '#484f58'}>
                    ⊞
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {/* Right: buttons */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
          <button onClick={navigateToModel}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
              border: '1px solid #30363d', background: 'transparent', color: '#484f58', fontWeight: 600 }}>
            model
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
        </div>
      </div>

      {/* My Picks tab */}
      {activeSportTab === 'picks' && (
        <MyPicksColumn
          trackedPlays={trackedPlays}
          setTrackedPlays={setTrackedPlays}
          untrackPlay={untrackPlay}
          navigateToTeam={navigateToTeam}
          navigateToPlay={navigateToPlay}
          calcOdds={calcOdds}
          setCalcOdds={setCalcOdds}
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
      )}

      {/* Game cards */}
      {activeSportTab !== 'picks' && (
        <>
          {tonightLoading && (
            <div style={{ color: '#484f58', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
              Loading games…
            </div>
          )}
          {!tonightLoading && games.length === 0 && (
            <div style={{ color: '#484f58', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
              No {activeSportTab.toUpperCase()} games found for today.
            </div>
          )}
          {(() => {
            const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            const tomorrowPT = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
            const _ptFmtLp = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });
            // Group games by actual game date (use gameTime PT date; gameDate from Kalshi can lag by a day)
            const gamesByDate = {};
            games.forEach(g => {
              const gd = g.gameTime ? _ptFmtLp.format(new Date(g.gameTime)) : (g.gameDate || todayPT);
              if (!gamesByDate[gd]) gamesByDate[gd] = [];
              gamesByDate[gd].push(g);
            });
            // Group qualified plays by date
            const playsByDate = {};
            qualifiedPlays.forEach(p => {
              const gd = p.gameTime ? _ptFmtLp.format(new Date(p.gameTime)) : (p.gameDate || todayPT);
              if (!playsByDate[gd]) playsByDate[gd] = [];
              playsByDate[gd].push(p);
            });
            const sortedDates = Object.keys(gamesByDate).sort();
            function dateLabel(gd) {
              if (gd === todayPT) return 'Today';
              if (gd === tomorrowPT) return 'Tomorrow';
              return gd ? new Date(gd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
            }
            return sortedDates.map((gd, di) => {
              const label = dateLabel(gd);
              const gamesForDate = gamesByDate[gd];
              const playsForDate = playsByDate[gd] || [];
              return (
                <div key={gd} style={{ marginTop: di > 0 ? 20 : 0 }}>
                  {label && (
                    <div style={{ paddingBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.8 }}>{label}</span>
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(480px, 1fr))', gap: 12, alignItems: 'start' }}>
                    {gamesForDate.map((game, i) => (
                      <MatchupCard
                        key={`${game.homeTeam}|${game.awayTeam}|${game.gameDate}|${i}`}
                        game={game}
                        mlbMeta={mlbMeta}
                        mlbMetaTomorrow={mlbMetaTomorrow}
                        nbaMeta={nbaMeta}
                        navigateToPlayer={navigateToPlayer}
                        navigateToTeam={navigateToTeam}
                      />
                    ))}
                  </div>
                  {playsForDate.length > 0 && (() => {
                    const raw = calcOdds.trim();
                    const n = parseInt(raw, 10);
                    let implied = null;
                    if (!isNaN(n) && raw !== '' && raw !== '-' && raw !== '+') {
                      if (n < 0) implied = Math.abs(n) / (Math.abs(n) + 100) * 100;
                      else if (n > 0) implied = 100 / (n + 100) * 100;
                    }
                    const color = implied === null ? '#8b949e' : implied >= 70 ? '#3fb950' : implied >= 50 ? '#e3b341' : '#f78166';
                    return (
                      <div style={{ marginTop: 16, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#161b22', border: '1px solid #30363d',
                          borderRadius: 10, padding: '0 12px', height: 38, flexShrink: 0 }}>
                          <span style={{ fontSize: 11, color: '#484f58', whiteSpace: 'nowrap' }}>Odds</span>
                          <input type="text" inputMode="numeric" placeholder="-110" value={calcOdds}
                            onChange={e => {
                              let v = e.target.value;
                              if (v.length > 0 && v[0] !== '-' && v[0] !== '+') v = '-' + v;
                              setCalcOdds(v);
                            }}
                            style={{ background: 'transparent', border: 'none', outline: 'none', color: '#c9d1d9',
                              fontSize: 13, width: 62, textAlign: 'center' }}
                          />
                          <span style={{ color, fontSize: 14, fontWeight: 700, minWidth: 48, textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {implied !== null ? `${implied.toFixed(1)}%` : '—'}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                  {playsForDate.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <PlaysColumn
                        tonightPlays={playsForDate}
                        allTonightPlays={allTonightPlays}
                        tonightLoading={false}
                        trackedPlays={trackedPlays}
                        trackPlay={trackPlay}
                        untrackPlay={untrackPlay}
                        navigateToPlay={navigateToPlay}
                        navigateToTeam={navigateToTeam}
                        navigateToModel={navigateToModel}
                        calcOdds={calcOdds}
                        expandedPlays={expandedPlays}
                        setExpandedPlays={setExpandedPlays}
                        fetchReport={fetchReport}
                        bustLoading={bustLoading}
                        bustCache={bustCache}
                        showPlaysInfo={showPlaysInfo}
                        setShowPlaysInfo={setShowPlaysInfo}
                        testMode={testMode}
                        setTestMode={setTestMode}
                        hideHeader={true}
                        gridColumns={2}
                      />
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </>
      )}
    </div>
  );
}
