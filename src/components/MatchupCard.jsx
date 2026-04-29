import React from 'react';
import { WORKER } from '../lib/constants.js';
import PlaysColumn from './PlaysColumn.jsx';

const SPORT_LOGO_KEY = { mlb: 'mlb', nba: 'nba', nhl: 'nhl' };

function logoUrl(sport, abbr) {
  if (!abbr) return null;
  return `https://a.espncdn.com/i/teamlogos/${SPORT_LOGO_KEY[sport] || sport}/500/${abbr.toLowerCase()}.png`;
}

function fmtGameTime(gameTime) {
  if (!gameTime) return null;
  try {
    const d = new Date(gameTime);
    const tz = 'America/Los_Angeles';
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const tomorrowStr = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: tz });
    const gameDateStr = d.toLocaleDateString('en-CA', { timeZone: tz });
    const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
    const label = gameDateStr === todayStr ? 'Today' : gameDateStr === tomorrowStr ? 'Tomorrow' : d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
    return `${label} · ${timeStr}`;
  } catch { return null; }
}

function fmtML(ml) {
  if (ml == null) return null;
  return ml > 0 ? `+${ml}` : `${ml}`;
}

function fmtSpread(spread) {
  if (spread == null) return null;
  return spread > 0 ? `+${spread}` : `${spread}`;
}

export default function MatchupCard({
  game, mlbMeta, mlbMetaTomorrow, nbaMeta, nhlMeta, navigateToPlayer, navigateToTeam,
  gamePlays, allTonightPlays, trackedPlays, trackPlay, untrackPlay,
  navigateToPlay, navigateToModel, expandedPlays, setExpandedPlays, openPicksDrawer,
}) {
  const { sport, homeTeam, awayTeam, gameDate, gameTime, ouLine, gameState, gameDetail, homeScore, awayScore } = game;
  const [playsOpen, setPlaysOpen] = React.useState(false);

  const gameTimeStr = fmtGameTime(gameTime);

  // ── MLB metadata ──────────────────────────────────────────────────────────
  // Use mlbMeta.gameOdds directly — keyed by whatever date ESPN currently serves
  // (today's or tomorrow's depending on whether today's slate is complete)
  const mlbGameOdds = mlbMeta?.gameOdds ?? {};
  const mlbAwayML = mlbGameOdds[awayTeam]?.ml ?? null;
  const mlbHomeML = mlbGameOdds[homeTeam]?.ml ?? null;
  const mlbTotal = mlbGameOdds[homeTeam]?.total ?? mlbGameOdds[awayTeam]?.total ?? null;
  const mlbHomeSpread = mlbGameOdds[homeTeam]?.spread ?? null;

  // ── NBA metadata ──────────────────────────────────────────────────────────
  const nbaGameOdds = sport === 'nba' ? (nbaMeta?.gameOdds ?? {}) : {};
  const nbaAwayOdds = nbaGameOdds[awayTeam] ?? {};
  const nbaHomeOdds = nbaGameOdds[homeTeam] ?? {};
  const nbaAwayML = nbaAwayOdds.ml ?? null;
  const nbaHomeML = nbaHomeOdds.ml ?? null;
  const nbaTotal = nbaHomeOdds.total ?? nbaAwayOdds.total ?? ouLine ?? null;
  const nbaHomeSpread = nbaHomeOdds.spread ?? null;
  const nbaAwaySpread = nbaAwayOdds.spread ?? null;

  // ── NHL metadata ──────────────────────────────────────────────────────────
  const nhlGameOdds = sport === 'nhl' ? (nhlMeta?.gameOdds ?? {}) : {};
  const nhlAwayOdds = nhlGameOdds[awayTeam] ?? {};
  const nhlHomeOdds = nhlGameOdds[homeTeam] ?? {};
  const nhlAwayML = nhlAwayOdds.ml ?? null;
  const nhlHomeML = nhlHomeOdds.ml ?? null;
  const nhlTotal = nhlHomeOdds.total ?? nhlAwayOdds.total ?? null;
  const nhlHomeSpread = nhlHomeOdds.spread ?? null;

  // Center header stats (sport-aware)
  const displayTotal = sport === 'nba' ? nbaTotal : sport === 'nhl' ? (nhlTotal ?? ouLine) : (mlbTotal ?? ouLine);
  const displayAwayML = sport === 'nba' ? nbaAwayML : sport === 'nhl' ? nhlAwayML : mlbAwayML;
  const displayHomeML = sport === 'nba' ? nbaHomeML : sport === 'nhl' ? nhlHomeML : mlbHomeML;
  const displaySpread = sport === 'nba' ? nbaHomeSpread : sport === 'nhl' ? nhlHomeSpread : mlbHomeSpread;

  // Play notification badge state
  const totalPlays = (gamePlays || []).length;
  const trackedCount = (gamePlays || []).filter(gp => (trackedPlays || []).some(tp => tp.id === gp.id)).length;
  const allTracked = totalPlays > 0 && trackedCount === totalPlays;

  function onPlayBadgeClick(e) {
    e.stopPropagation();
    if (allTracked) {
      openPicksDrawer?.();
    } else {
      setPlaysOpen(o => !o);
    }
  }

  return (
    <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 12, position: 'relative' }}>

      {/* Play count badge — top right */}
      {totalPlays > 0 && (
        <button onClick={onPlayBadgeClick} style={{
          position: 'absolute', top: 8, right: 10, zIndex: 1,
          fontSize: 10, fontWeight: 700, cursor: 'pointer',
          color: '#3fb950', background: 'rgba(63,185,80,0.12)',
          border: '1px solid rgba(63,185,80,0.3)', borderRadius: 10,
          padding: '1px 5px',
        }}>
          {totalPlays}
        </button>
      )}

      {/* Header: away vs home with logos */}
      <div style={{ padding: '14px 16px 10px', display: 'flex', alignItems: 'center' }}>
        {/* Away */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
          onClick={() => navigateToTeam(awayTeam, sport)}>
          <img src={logoUrl(sport, awayTeam)} alt={awayTeam}
            style={{ width: 44, height: 44, objectFit: 'contain' }}
            onError={e => { e.target.style.display = 'none'; }} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#c9d1d9' }}>{awayTeam}</div>
            <div style={{ fontSize: 10, color: '#484f58' }}>Away</div>
          </div>
        </div>

        {/* Center: score (in/post) or time + odds (pre) */}
        <div style={{ textAlign: 'center', minWidth: 120, padding: '0 8px' }}>
          {(gameState === 'in' || gameState === 'post') ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#c9d1d9', letterSpacing: 1 }}>
                {awayScore ?? 0} – {homeScore ?? 0}
              </div>
              <div style={{ fontSize: 9, fontWeight: 600, color: gameState === 'post' ? '#484f58' : '#e3b341', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {gameDetail || (gameState === 'post' ? 'Final' : 'Live')}
              </div>
            </>
          ) : (
            <>
              {gameTimeStr && <div style={{ fontSize: 10, color: '#8b949e' }}>{gameTimeStr}</div>}
              {displayTotal != null && (
                <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>total {displayTotal}</div>
              )}
              {(displayAwayML != null || displayHomeML != null) && (
                <div style={{ fontSize: 10, color: '#8b949e', marginTop: 2 }}>
                  {fmtML(displayAwayML)} / {fmtML(displayHomeML)}
                </div>
              )}
              {displaySpread != null && (
                <div style={{ fontSize: 10, color: '#8b949e', marginTop: 1 }}>
                  {homeTeam} {fmtSpread(displaySpread)}
                </div>
              )}
            </>
          )}
        </div>

        {/* Home */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', cursor: 'pointer' }}
          onClick={() => navigateToTeam(homeTeam, sport)}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#c9d1d9' }}>{homeTeam}</div>
            <div style={{ fontSize: 10, color: '#484f58' }}>Home</div>
          </div>
          <img src={logoUrl(sport, homeTeam)} alt={homeTeam}
            style={{ width: 44, height: 44, objectFit: 'contain' }}
            onError={e => { e.target.style.display = 'none'; }} />
        </div>
      </div>

      {/* Inline play drawer */}
      {playsOpen && totalPlays > 0 && (
        <div style={{ borderTop: '1px solid #0d1117', padding: '12px 16px 16px' }}>
          <PlaysColumn
            tonightPlays={gamePlays}
            allTonightPlays={allTonightPlays}
            tonightLoading={false}
            trackedPlays={trackedPlays}
            trackPlay={trackPlay}
            untrackPlay={untrackPlay}
            navigateToPlay={navigateToPlay}
            navigateToTeam={navigateToTeam}
            navigateToModel={navigateToModel}
            expandedPlays={expandedPlays}
            setExpandedPlays={setExpandedPlays}
            hideHeader={true}
            gridColumns={1}
          />
        </div>
      )}

    </div>
  );
}
