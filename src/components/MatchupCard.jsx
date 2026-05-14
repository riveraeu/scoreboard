import React from 'react';
import { WORKER } from '../lib/constants.js';
import { logoUrl, fmtGameTime } from '../lib/utils.js';
import PlaysColumn from './PlaysColumn.jsx';

// "BOS leads series 3-2" → "BOS 3-2", "Series tied 2-2" → "2-2"
function fmtSeries(summary) {
  if (!summary) return null;
  const leads = summary.match(/^(\S+)\s+leads?\s+series\s+(\d+-\d+)$/i);
  if (leads) return `${leads[1]} ${leads[2]}`;
  const tied = summary.match(/tied\s+(\d+-\d+)$/i);
  if (tied) return tied[1];
  return summary;
}

function MatchupCard({
  game, mlbMeta, mlbMetaTomorrow, nbaMeta, nhlMeta, navigateToPlayer, navigateToTeam,
  gamePlays, allTonightPlays, trackedPlays, trackPlay, untrackPlay,
  navigateToPlay, navigateToModel, expandedPlays, setExpandedPlays, openPicksDrawer,
}) {
  const { sport, homeTeam, awayTeam, gameDate, gameTime, gameState, gameDetail, homeScore, awayScore, seriesSummary } = game;
  const [playsOpen, setPlaysOpen] = React.useState(false);

  const gameTimeStr = fmtGameTime(gameTime);

  // MLB starting pitcher row — prefer today's meta, fall back to tomorrow's
  const pitcherFor = (abbr) => {
    if (sport !== 'mlb' || !abbr) return null;
    const p = mlbMeta?.pitchers?.[abbr] ?? mlbMetaTomorrow?.pitchers?.[abbr];
    return p?.name ? p : null;
  };
  const awayPitcher = pitcherFor(awayTeam);
  const homePitcher = pitcherFor(homeTeam);
  const hasPitcherRow = sport === 'mlb' && (awayPitcher || homePitcher);
  const fmtEraRec = (p) => {
    if (!p) return null;
    const eraStr = (p.era != null && !isNaN(p.era)) ? `${(+p.era).toFixed(2)} ERA` : null;
    const recStr = (p.wins != null && p.losses != null) ? `${p.wins}-${p.losses}` : null;
    if (eraStr && recStr) return `${eraStr} · ${recStr}`;
    return eraStr || recStr || null;
  };
  const headshotUrl = (id) => id ? `https://midfield.mlbstatic.com/v1/people/${id}/spots/120` : null;
  const openPitcher = (p, team) => {
    if (!p?.name) return;
    navigateToPlayer({ id: null, name: p.name, team, sportKey: 'baseball/mlb' }, 'strikeouts');
  };

  // Game odds shown in pitcher-row center (MLB only)
  const awayOdds = sport === 'mlb' ? (mlbMeta?.gameOdds?.[awayTeam] ?? mlbMetaTomorrow?.gameOdds?.[awayTeam] ?? null) : null;
  const homeOdds = sport === 'mlb' ? (mlbMeta?.gameOdds?.[homeTeam] ?? mlbMetaTomorrow?.gameOdds?.[homeTeam] ?? null) : null;
  const oddsTotal = awayOdds?.total ?? homeOdds?.total ?? null;
  const fmtMl = (ml) => (ml == null || isNaN(ml)) ? null : (ml > 0 ? `+${ml}` : `${ml}`);
  const mlbTotalColor = (t) => t == null ? '#8b949e' : t <= 7.5 ? '#3fb950' : t < 10.5 ? '#e3b341' : '#f78166';
  const hasOdds = oddsTotal != null || awayOdds?.ml != null || homeOdds?.ml != null;

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

      {/* Pitcher row (MLB only) — headshot + name + ERA · W-L */}
      {hasPitcherRow && (
        <div style={{ borderTop: '1px solid #21262d', padding: '8px 16px 10px', display: 'flex', alignItems: 'center' }}>
          {/* Away pitcher */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, cursor: awayPitcher ? 'pointer' : 'default' }}
            onClick={() => openPitcher(awayPitcher, awayTeam)}>
            {awayPitcher?.id ? (
              <img src={headshotUrl(awayPitcher.id)} alt={awayPitcher.name}
                style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', background: '#0d1117' }}
                onError={e => { e.target.style.visibility = 'hidden'; }} />
            ) : (
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#0d1117' }} />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#c9d1d9', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {awayPitcher?.name || '—'}
              </div>
              {fmtEraRec(awayPitcher) && (
                <div style={{ fontSize: 10, color: '#8b949e' }}>{fmtEraRec(awayPitcher)}</div>
              )}
            </div>
          </div>

          {/* Center: game total + per-team ML (aligned under game time) */}
          <div style={{ textAlign: 'center', minWidth: 120, padding: '0 8px' }}>
            {hasOdds ? (
              <>
                {oddsTotal != null && (
                  <div style={{ fontSize: 11, color: '#8b949e' }}>
                    O/U <span style={{ color: mlbTotalColor(oddsTotal), fontWeight: 600 }}>{oddsTotal}</span>
                  </div>
                )}
                {(awayOdds?.ml != null || homeOdds?.ml != null) && (
                  <div style={{ fontSize: 10, color: '#8b949e', marginTop: 2 }}>
                    {awayOdds?.ml != null && <>{awayTeam} <span style={{ color: '#c9d1d9' }}>{fmtMl(awayOdds.ml)}</span></>}
                    {awayOdds?.ml != null && homeOdds?.ml != null && ' · '}
                    {homeOdds?.ml != null && <>{homeTeam} <span style={{ color: '#c9d1d9' }}>{fmtMl(homeOdds.ml)}</span></>}
                  </div>
                )}
              </>
            ) : null}
          </div>

          {/* Home pitcher */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', minWidth: 0, cursor: homePitcher ? 'pointer' : 'default' }}
            onClick={() => openPitcher(homePitcher, homeTeam)}>
            <div style={{ textAlign: 'right', minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#c9d1d9', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {homePitcher?.name || '—'}
              </div>
              {fmtEraRec(homePitcher) && (
                <div style={{ fontSize: 10, color: '#8b949e' }}>{fmtEraRec(homePitcher)}</div>
              )}
            </div>
            {homePitcher?.id ? (
              <img src={headshotUrl(homePitcher.id)} alt={homePitcher.name}
                style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', background: '#0d1117' }}
                onError={e => { e.target.style.visibility = 'hidden'; }} />
            ) : (
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#0d1117' }} />
            )}
          </div>
        </div>
      )}

      {/* Inline play drawer — always mounted when plays exist so transition works */}
      {totalPlays > 0 && (
        <div style={{
          overflow: 'hidden',
          maxHeight: playsOpen ? 4000 : 0,
          opacity: playsOpen ? 1 : 0,
          transition: playsOpen
            ? 'max-height 0.35s ease, opacity 0.2s ease 0.05s'
            : 'max-height 0.28s ease, opacity 0.15s ease',
        }}>
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
        </div>
      )}

    </div>
  );
}

export default React.memo(MatchupCard);
