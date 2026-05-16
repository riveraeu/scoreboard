import React from 'react';
import { WORKER } from '../lib/constants.js';
import { logoUrl, fmtGameTime } from '../lib/utils.js';
import { useIsMobile } from '../lib/hooks.js';
import PlaysColumn from './PlaysColumn.jsx';

// Lineup confirmation badge (MLB only). status: 'confirmed' → green, 'projected' → grey.
function LineupBadge({ status, align }) {
  const isConfirmed = status === 'confirmed';
  const color = isConfirmed ? '#3fb950' : '#8b949e';
  const bg = isConfirmed ? 'rgba(63,185,80,0.12)' : 'rgba(139,148,158,0.10)';
  return (
    <span style={{
      display: 'inline-block', marginTop: 2, marginBottom: 4,
      fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
      background: bg, border: `1px solid ${color}`, color,
      whiteSpace: 'nowrap',
    }}
      title={isConfirmed ? 'Lineup confirmed' : 'Projected lineup — not yet official'}>
      ✓ Lineup
    </span>
  );
}

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
  game, mlbMeta, mlbMetaTomorrow, nbaMeta, wnbaMeta, nhlMeta, navigateToPlayer, navigateToTeam,
  gamePlays, allTonightPlays, trackedPlays, trackPlay, untrackPlay,
  navigateToPlay, navigateToModel, expandedPlays, setExpandedPlays, openPicksDrawer,
}) {
  const { sport, homeTeam, awayTeam, gameDate, gameTime, gameState, gameDetail, homeScore, awayScore, seriesSummary } = game;
  const [playsOpen, setPlaysOpen] = React.useState(false);
  const isMobile = useIsMobile();
  // Mobile sizing for the feature-player row — tighter center column + smaller headshot
  // give each side ~25px more text room so player names + stats don't truncate to "D…".
  const featHsSize = isMobile ? 30 : 36;
  const featCenterMin = isMobile ? 90 : 120;
  const featCenterPadX = isMobile ? 4 : 8;

  const gameTimeStr = fmtGameTime(gameTime);

  // Feature player row — MLB starting pitcher, or NBA/WNBA/NHL "top player" (Rating/Points leader).
  // For MLB: pick today vs tomorrow meta by gameDate so consecutive-day starters don't collide.
  const ptToday = React.useMemo(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()),
    []
  );
  const isTomorrowGame = sport === 'mlb' && gameDate && gameDate > ptToday;
  const mlbPitchSrc = isTomorrowGame ? mlbMetaTomorrow : mlbMeta;

  // Per-team MLB lineup confirmation. teamsWithLineup includes any team with lineup data
  // (confirmed or projected); projectedLineupTeams flags the ones that are still projections.
  const mlbLineupStatus = (abbr) => {
    if (sport !== 'mlb' || !abbr) return null;
    const teams = mlbPitchSrc?.teamsWithLineup || [];
    const projected = mlbPitchSrc?.projectedLineupTeams || [];
    if (!teams.includes(abbr)) return null;
    return projected.includes(abbr) ? 'projected' : 'confirmed';
  };
  const featureFor = (abbr) => {
    if (!abbr) return null;
    if (sport === 'mlb') {
      const p = mlbPitchSrc?.pitchers?.[abbr];
      if (!p?.name) return null;
      const eraStr = (p.era != null && !isNaN(p.era)) ? `${(+p.era).toFixed(2)} ERA` : null;
      const recStr = (p.wins != null && p.losses != null) ? `${p.wins}-${p.losses}` : null;
      const stats = [eraStr, recStr].filter(Boolean).join(' · ') || null;
      return {
        name: p.name,
        id: p.id,
        // MLB pitcher headshot is intentionally hidden — saves vertical real estate, focus stays
        // on the stat row + lineup confirmation badge. NBA/WNBA/NHL still show headshots below.
        headshot: null,
        stats,
        sportKey: 'baseball/mlb',
        tab: 'strikeouts',
        lineupStatus: mlbLineupStatus(abbr),
      };
    }
    const meta = sport === 'nba' ? nbaMeta : sport === 'wnba' ? wnbaMeta : sport === 'nhl' ? nhlMeta : null;
    const tp = meta?.topPlayers?.[abbr];
    if (!tp?.name) return null;
    return {
      name: tp.name,
      id: tp.id,
      headshot: tp.headshot,
      stats: tp.stats,
      sportKey: sport === 'nba' ? 'basketball/nba' : sport === 'wnba' ? 'basketball/wnba' : 'hockey/nhl',
      tab: 'points',
    };
  };
  const awayFeature = featureFor(awayTeam);
  const homeFeature = featureFor(homeTeam);
  const hasFeatureRow = !!(awayFeature || homeFeature);
  const openFeature = (f, team) => {
    if (!f?.name) return;
    navigateToPlayer({ id: null, name: f.name, team, sportKey: f.sportKey }, f.tab);
  };

  // Game odds shown in feature-row center. Server overlays the closing line once the game
  // state transitions to in/post, so this displays closing — not live — odds across all sports.
  const oddsMeta = sport === 'mlb' ? mlbPitchSrc
    : sport === 'nba' ? nbaMeta
    : sport === 'wnba' ? wnbaMeta
    : sport === 'nhl' ? nhlMeta
    : null;
  const awayOdds = oddsMeta?.gameOdds?.[awayTeam] ?? null;
  const homeOdds = oddsMeta?.gameOdds?.[homeTeam] ?? null;
  const oddsTotal = awayOdds?.total ?? homeOdds?.total ?? null;
  const fmtMl = (ml) => (ml == null || isNaN(ml)) ? null : (ml > 0 ? `+${ml}` : `${ml}`);
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

      {/* Feature player row — MLB starting pitcher or NBA/WNBA/NHL top player */}
      {hasFeatureRow && (
        <div style={{ borderTop: '1px solid #21262d', padding: '8px 16px 10px', display: 'flex', alignItems: 'center' }}>
          {/* Away feature */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, cursor: awayFeature ? 'pointer' : 'default' }}
            onClick={() => openFeature(awayFeature, awayTeam)}>
            {awayFeature?.headshot ? (
              <img src={awayFeature.headshot} alt={awayFeature.name}
                style={{ width: featHsSize, height: featHsSize, borderRadius: '50%', objectFit: 'cover', background: '#0d1117', flexShrink: 0 }}
                onError={e => { e.target.style.visibility = 'hidden'; }} />
            ) : sport !== 'mlb' ? (
              <div style={{ width: featHsSize, height: featHsSize, borderRadius: '50%', background: '#0d1117', flexShrink: 0 }} />
            ) : null}
            <div style={{ minWidth: 0 }}>
              {awayFeature?.lineupStatus && (
                <LineupBadge status={awayFeature.lineupStatus} />
              )}
              <div style={{ fontSize: 12, color: '#c9d1d9', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {awayFeature?.name || '—'}
              </div>
              {awayFeature?.stats && (
                <div style={{ fontSize: 10, color: '#8b949e' }}>{awayFeature.stats}</div>
              )}
            </div>
          </div>

          {/* Center: MLB game total + per-team ML; spacer for other sports */}
          <div style={{ textAlign: 'center', minWidth: featCenterMin, padding: `0 ${featCenterPadX}px` }}>
            {hasOdds ? (
              <>
                {oddsTotal != null && (
                  <div style={{ fontSize: 11, color: '#8b949e' }}>
                    Total <span style={{ color: '#c9d1d9' }}>{oddsTotal}</span>
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

          {/* Home feature */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', minWidth: 0, cursor: homeFeature ? 'pointer' : 'default' }}
            onClick={() => openFeature(homeFeature, homeTeam)}>
            <div style={{ textAlign: 'right', minWidth: 0 }}>
              {homeFeature?.lineupStatus && (
                <LineupBadge status={homeFeature.lineupStatus} align="right" />
              )}
              <div style={{ fontSize: 12, color: '#c9d1d9', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {homeFeature?.name || '—'}
              </div>
              {homeFeature?.stats && (
                <div style={{ fontSize: 10, color: '#8b949e' }}>{homeFeature.stats}</div>
              )}
            </div>
            {homeFeature?.headshot ? (
              <img src={homeFeature.headshot} alt={homeFeature.name}
                style={{ width: featHsSize, height: featHsSize, borderRadius: '50%', objectFit: 'cover', background: '#0d1117', flexShrink: 0 }}
                onError={e => { e.target.style.visibility = 'hidden'; }} />
            ) : sport !== 'mlb' ? (
              <div style={{ width: featHsSize, height: featHsSize, borderRadius: '50%', background: '#0d1117', flexShrink: 0 }} />
            ) : null}
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
