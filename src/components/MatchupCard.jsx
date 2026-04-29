import React from 'react';
import { WORKER } from '../lib/constants.js';
import PlaysColumn from './PlaysColumn.jsx';

const SPORT_LOGO_KEY = { mlb: 'mlb', nba: 'nba', nhl: 'nhl' };

// ESPN CDN uses shorter abbreviations for some teams than the API/Kalshi codes
const LOGO_CDN_ABBR = {
  nhl: { tbl: 'tb', njd: 'nj', lak: 'la', sjs: 'sj' },
  nba: { kat: 'atl' },
};

function logoUrl(sport, abbr) {
  if (!abbr) return null;
  const lower = abbr.toLowerCase();
  const mapped = LOGO_CDN_ABBR[sport]?.[lower] ?? lower;
  return `https://a.espncdn.com/i/teamlogos/${SPORT_LOGO_KEY[sport] || sport}/500/${mapped}.png`;
}

function fmtGameTime(gameTime) {
  if (!gameTime) return null;
  try {
    const d = new Date(gameTime);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' });
  } catch { return null; }
}

// "BOS leads series 3-2" → "BOS 3-2", "Series tied 2-2" → "2-2"
function fmtSeries(summary) {
  if (!summary) return null;
  const leads = summary.match(/^(\S+)\s+leads\s+series\s+(\d+-\d+)$/i);
  if (leads) return `${leads[1]} ${leads[2]}`;
  const tied = summary.match(/tied\s+(\d+-\d+)$/i);
  if (tied) return tied[1];
  return summary;
}

export default function MatchupCard({
  game, mlbMeta, mlbMetaTomorrow, nbaMeta, nhlMeta, navigateToPlayer, navigateToTeam,
  gamePlays, allTonightPlays, trackedPlays, trackPlay, untrackPlay,
  navigateToPlay, navigateToModel, expandedPlays, setExpandedPlays, openPicksDrawer,
}) {
  const { sport, homeTeam, awayTeam, gameDate, gameTime, gameState, gameDetail, homeScore, awayScore, seriesSummary } = game;
  const [playsOpen, setPlaysOpen] = React.useState(false);

  const gameTimeStr = fmtGameTime(gameTime);

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
          position: 'absolute', top: 5, right: 5, zIndex: 1,
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
              {seriesSummary && (sport === 'nba' || sport === 'nhl') && (
                <div style={{ fontSize: 10, color: '#8b949e', marginTop: 3 }}>{fmtSeries(seriesSummary)}</div>
              )}
            </>
          ) : (
            <>
              {seriesSummary && (sport === 'nba' || sport === 'nhl') && (
                <div style={{ fontSize: 10, color: '#8b949e' }}>{fmtSeries(seriesSummary)}</div>
              )}
              {gameTimeStr && <div style={{ fontSize: 10, color: '#8b949e', marginTop: seriesSummary && (sport === 'nba' || sport === 'nhl') ? 2 : 0 }}>{gameTimeStr}</div>}
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
