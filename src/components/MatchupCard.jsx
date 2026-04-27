import React from 'react';
import { WORKER, SPORT_KEY } from '../lib/constants.js';
import { tierColor } from '../lib/colors.js';

const SPORT_LOGO_KEY = { mlb: 'mlb', nba: 'nba', nhl: 'nhl' };

// Home teams that play in domed/retractable-roof stadiums (weather irrelevant)
const DOMED_STADIUMS = new Set(['TB', 'TOR', 'HOU', 'MIA', 'SEA', 'ARI', 'TEX', 'MIL']);

function logoUrl(sport, abbr) {
  if (!abbr) return null;
  return `https://a.espncdn.com/i/teamlogos/${SPORT_LOGO_KEY[sport] || sport}/500/${abbr.toLowerCase()}.png`;
}

function fmtGameTime(gameTime) {
  if (!gameTime) return null;
  try {
    const d = new Date(gameTime);
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA');
    const tomorrowStr = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA');
    const gameDateStr = d.toLocaleDateString('en-CA');
    const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    const label = gameDateStr === todayStr ? 'Today' : gameDateStr === tomorrowStr ? 'Tomorrow' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${label} · ${timeStr}`;
  } catch { return null; }
}

function fmtML(ml) {
  if (ml == null) return null;
  return ml > 0 ? `+${ml}` : `${ml}`;
}

function fmtOdds(ml) {
  if (ml == null) return null;
  return ml > 0 ? `+${ml}` : `${ml}`;
}

function weatherIcon(condition) {
  if (!condition) return '🌤';
  const c = condition.toLowerCase();
  if (c.includes('thunder') || c.includes('storm')) return '⛈';
  if (c.includes('rain') || c.includes('shower') || c.includes('drizzle')) return '🌧';
  if (c.includes('snow') || c.includes('sleet') || c.includes('flurr')) return '🌨';
  if (c.includes('fog') || c.includes('mist') || c.includes('haze')) return '🌫';
  if (c.includes('wind') && !c.includes('sunny') && !c.includes('clear')) return '💨';
  if (c.includes('overcast') || c.includes('cloudy')) return '☁️';
  if (c.includes('partly') || c.includes('mostly cloudy')) return '⛅';
  if (c.includes('sunny') || c.includes('clear')) return '☀️';
  return '🌤';
}

function getSimScore(play) {
  if (play.gameType === 'total') return play.totalSimScore ?? null;
  if (play.gameType === 'teamTotal') return play.teamTotalSimScore ?? null;
  if (play.stat === 'strikeouts') return play.finalSimScore ?? null;
  if (play.stat === 'hrr' || play.stat === 'hits') return play.hitterFinalSimScore ?? null;
  if (play.sport === 'nba') return play.nbaSimScore ?? null;
  if (play.sport === 'nhl') return play.nhlSimScore ?? null;
  return null;
}

// Qualified-only, deduped best play per player/stat
function buildBadgePlays(plays) {
  const qualified = plays.filter(p => p.qualified !== false);
  const map = new Map();
  for (const p of [...qualified].sort((a, b) => (b.edge || 0) - (a.edge || 0))) {
    const key = p.gameType === 'total'
      ? `total|${p.homeTeam}|${p.awayTeam}|${p.threshold}|${p.direction || 'over'}`
      : p.gameType === 'teamTotal'
        ? `tt|${p.scoringTeam}|${p.threshold}`
        : `${p.playerName}|${p.stat}`;
    if (!map.has(key)) map.set(key, p);
  }
  return [...map.values()].sort((a, b) => (b.edge || 0) - (a.edge || 0));
}

function PlayBadge({ play, navigateToPlayer, navigateToTeam }) {
  const edge = play.edge ?? 0;
  const edgeColor = edge >= 5 ? '#3fb950' : edge >= 3 ? '#e3b341' : '#8b949e';
  const truePct = play.direction === 'under' ? play.noTruePct : play.truePct;
  const simScore = getSimScore(play);
  const odds = fmtOdds(play.americanOdds);

  const handleClick = () => {
    if (play.gameType === 'total') {
      navigateToTeam(play.homeTeam, play.sport);
    } else if (play.gameType === 'teamTotal') {
      navigateToTeam(play.scoringTeam, play.sport);
    } else {
      navigateToPlayer(
        { id: play.playerId, name: play.playerName, team: play.playerTeam,
          sportKey: SPORT_KEY[play.sport], opponent: play.opponent },
        play.stat
      );
    }
  };

  let label, sublabel;
  if (play.gameType === 'total') {
    label = `${play.direction === 'under' ? 'Under' : 'Over'} ${play.threshold}`;
    sublabel = `${play.awayTeam} @ ${play.homeTeam} · Total`;
  } else if (play.gameType === 'teamTotal') {
    label = `${play.scoringTeam} O${play.threshold}`;
    sublabel = 'Team Runs';
  } else {
    const statMap = { strikeouts: 'K', hrr: 'HRR', points: 'PTS', rebounds: 'REB', assists: 'AST', threePointers: '3PM', goals: 'G' };
    label = play.playerName;
    sublabel = `${statMap[play.stat] || play.stat} ${play.threshold}+`;
  }

  return (
    <div onClick={handleClick} style={{
      display: 'inline-flex', flexDirection: 'column', gap: 4, cursor: 'pointer',
      padding: '7px 10px', borderRadius: 8,
      background: 'rgba(63,185,80,0.06)', border: '1px solid rgba(63,185,80,0.25)',
      transition: 'background 0.15s', minWidth: 140,
    }}
    onMouseEnter={e => e.currentTarget.style.background = 'rgba(63,185,80,0.12)'}
    onMouseLeave={e => e.currentTarget.style.background = 'rgba(63,185,80,0.06)'}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#c9d1d9', lineHeight: 1.3 }}>{label}</div>
        <div style={{ fontSize: 10, color: '#8b949e', whiteSpace: 'nowrap' }}>{sublabel}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {truePct != null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: 9, color: '#484f58' }}>True%</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: tierColor(truePct) }}>{truePct}%</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <span style={{ fontSize: 9, color: '#484f58' }}>Edge</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: edgeColor }}>{edge > 0 ? '+' : ''}{edge.toFixed(1)}%</span>
        </div>
        {simScore != null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <span style={{ fontSize: 9, color: '#484f58' }}>Score</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#8b949e' }}>{simScore}/10</span>
          </div>
        )}
        {odds && (
          <span style={{ fontSize: 10, color: '#484f58' }}>{odds}</span>
        )}
      </div>
    </div>
  );
}

export default function MatchupCard({ game, mlbMeta, navigateToPlayer, navigateToTeam }) {
  const { sport, homeTeam, awayTeam, gameDate, gameTime, ouLine, plays } = game;
  const [lineupOpen, setLineupOpen] = React.useState(false);
  const [lineup, setLineup] = React.useState(null);
  const [lineupLoading, setLineupLoading] = React.useState(false);

  const gameTimeStr = fmtGameTime(gameTime);
  const badgePlays = buildBadgePlays(plays);
  const isDomed = DOMED_STADIUMS.has(homeTeam);

  // MLB metadata from backend (pitchers, ML, umpire, weather, lineup status)
  const pitchers = sport === 'mlb' ? (mlbMeta?.pitchers ?? {}) : {};
  const awayPitcher = pitchers[awayTeam] ?? null;
  const homePitcher = pitchers[homeTeam] ?? null;
  const gameOdds = mlbMeta?.gameOdds ?? {};
  const awayML = gameOdds[awayTeam]?.ml ?? null;
  const homeML = gameOdds[homeTeam]?.ml ?? null;
  const umpireKey = `${homeTeam}|${awayTeam}`;
  const umpire = mlbMeta?.umpires?.[umpireKey] ?? null;
  const weatherData = mlbMeta?.weather?.[umpireKey] ?? null;

  // Lineup confirmed status (from backend projectedLineupTeams / teamsWithLineup)
  const _projTeams = new Set(mlbMeta?.projectedLineupTeams ?? []);
  const _teamsWithLineup = new Set(mlbMeta?.teamsWithLineup ?? []);
  const getLineupConfirmed = (abbr) => {
    if (!_teamsWithLineup.has(abbr)) return null;
    return !_projTeams.has(abbr);
  };
  const awayLineupConfirmed = sport === 'mlb' ? getLineupConfirmed(awayTeam) : null;
  const homeLineupConfirmed = sport === 'mlb' ? getLineupConfirmed(homeTeam) : null;

  const showMlbExtra = sport === 'mlb' && (awayPitcher || homePitcher);
  const showMlbDetails = sport === 'mlb'; // always show umpire/weather row for MLB

  function LineupBadge({ confirmed }) {
    if (confirmed === true) return (
      <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
        background: 'rgba(63,185,80,0.12)', border: '1px solid #3fb950', color: '#3fb950' }}>
        ✓ Confirmed
      </span>
    );
    if (confirmed === false) return (
      <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
        background: 'rgba(139,148,158,0.10)', border: '1px solid #484f58', color: '#8b949e' }}>
        Expected
      </span>
    );
    return null;
  }

  async function onToggleLineup() {
    if (!lineupOpen && !lineup) {
      setLineupLoading(true);
      try {
        const [homeRes, awayRes] = await Promise.all([
          fetch(`${WORKER}/team?abbr=${homeTeam}&sport=${sport}`).then(r => r.ok ? r.json() : null),
          fetch(`${WORKER}/team?abbr=${awayTeam}&sport=${sport}`).then(r => r.ok ? r.json() : null),
        ]);
        setLineup({
          home: homeRes?.lineup ?? [],
          away: awayRes?.lineup ?? [],
        });
      } catch { setLineup({ home: [], away: [] }); }
      setLineupLoading(false);
    }
    setLineupOpen(o => !o);
  }

  return (
    <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 12, overflow: 'hidden' }}>

      {/* Header: away @ home with logos */}
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

        {/* Center: time + O/U + ML */}
        <div style={{ textAlign: 'center', minWidth: 120, padding: '0 8px' }}>
          <div style={{ fontSize: 10, color: '#484f58', fontWeight: 700, letterSpacing: 1 }}>@</div>
          {gameTimeStr && <div style={{ fontSize: 10, color: '#8b949e', marginTop: 2 }}>{gameTimeStr}</div>}
          {ouLine != null && (
            <div style={{ fontSize: 11, color: '#8b949e', marginTop: 1 }}>O/U {ouLine}</div>
          )}
          {(awayML != null || homeML != null) && (
            <div style={{ fontSize: 10, color: '#484f58', marginTop: 2 }}>
              {fmtML(awayML)} / {fmtML(homeML)}
            </div>
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

      {/* MLB: pitchers row + lineup confirmed badge */}
      {showMlbExtra && (
        <div style={{ padding: '6px 16px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderTop: '1px solid #0d1117' }}>
          <div style={{ fontSize: 11 }}>
            {awayPitcher
              ? (
                <span
                  onClick={() => navigateToPlayer({ name: awayPitcher.name, team: awayTeam, sportKey: 'baseball/mlb' }, 'strikeouts')}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.75'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                  <span style={{ color: '#c9d1d9', fontWeight: 600 }}>{awayPitcher.name}</span>
                  {awayPitcher.era != null && <span style={{ color: '#484f58' }}> ({awayPitcher.era} ERA)</span>}
                </span>
              )
              : <span style={{ color: '#484f58', fontStyle: 'italic' }}>TBD</span>}
            {awayLineupConfirmed !== null && (
              <div style={{ marginTop: 3 }}><LineupBadge confirmed={awayLineupConfirmed} /></div>
            )}
          </div>
          <div style={{ fontSize: 11, textAlign: 'right' }}>
            {homePitcher
              ? (
                <span
                  onClick={() => navigateToPlayer({ name: homePitcher.name, team: homeTeam, sportKey: 'baseball/mlb' }, 'strikeouts')}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '0.75'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                >
                  <span style={{ color: '#c9d1d9', fontWeight: 600 }}>{homePitcher.name}</span>
                  {homePitcher.era != null && <span style={{ color: '#484f58' }}> ({homePitcher.era} ERA)</span>}
                </span>
              )
              : <span style={{ color: '#484f58', fontStyle: 'italic' }}>TBD</span>}
            {homeLineupConfirmed !== null && (
              <div style={{ marginTop: 3, display: 'flex', justifyContent: 'flex-end' }}><LineupBadge confirmed={homeLineupConfirmed} /></div>
            )}
          </div>
        </div>
      )}

      {/* MLB: umpire + weather row */}
      {showMlbDetails && (
        <div style={{ padding: '5px 16px 7px', display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid #0d1117', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10, color: '#484f58', fontWeight: 600 }}>HP Ump:</span>
            <span style={{ fontSize: 10, color: umpire ? '#8b949e' : '#30363d', fontStyle: umpire ? 'normal' : 'italic' }}>
              {umpire || 'Not announced yet'}
            </span>
          </div>
          {isDomed ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 13, lineHeight: 1 }}>🏟</span>
              <span style={{ fontSize: 10, color: '#484f58' }}>Dome</span>
            </div>
          ) : weatherData ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 13, lineHeight: 1 }}>{weatherIcon(weatherData.condition)}</span>
              {weatherData.temp != null && <span style={{ fontSize: 10, color: '#8b949e' }}>{weatherData.temp}°</span>}
              {weatherData.condition && <span style={{ fontSize: 10, color: '#484f58' }}>{weatherData.condition}</span>}
            </div>
          ) : null}
        </div>
      )}

      {/* Play badges */}
      {badgePlays.length > 0 && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid #0d1117', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {badgePlays.map((p, i) => (
            <PlayBadge key={i} play={p} navigateToPlayer={navigateToPlayer} navigateToTeam={navigateToTeam} />
          ))}
        </div>
      )}

      {/* MLB lineup drawer */}
      {sport === 'mlb' && (
        <div style={{ borderTop: '1px solid #0d1117' }}>
          <button onClick={onToggleLineup} style={{
            width: '100%', background: 'none', border: 'none', cursor: 'pointer',
            padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 6,
            color: '#484f58', fontSize: 11, fontWeight: 600, textAlign: 'left',
          }}>
            <span style={{ fontSize: 9, display: 'inline-block', transition: 'transform 0.15s',
              transform: lineupOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            Batting Lineups
            {lineupLoading && <span style={{ color: '#30363d', marginLeft: 4 }}>Loading…</span>}
          </button>

          {lineupOpen && lineup && (
            <div style={{ padding: '0 16px 12px', display: 'flex', gap: 16 }}>
              {[
                { abbr: awayTeam, data: lineup.away, label: 'Away' },
                { abbr: homeTeam, data: lineup.home, label: 'Home' },
              ].map(({ abbr, data, label }) => (
                <div key={abbr} style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ marginBottom: 5 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#484f58', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {abbr} {label}
                    </span>
                  </div>
                  {data.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#484f58', fontStyle: 'italic' }}>No lineup posted</div>
                  ) : (
                    data.map((player, idx) => (
                      <div key={idx} style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0',
                        borderBottom: idx < data.length - 1 ? '1px solid #0d1117' : 'none',
                      }}>
                        <span style={{ fontSize: 10, color: '#484f58', width: 14, textAlign: 'center', flexShrink: 0 }}>
                          {player.isProbable ? 'P' : (player.spot ?? idx + 1)}
                        </span>
                        <span
                          onClick={() => navigateToPlayer(
                            { id: player.playerId || null, name: player.name, team: abbr, sportKey: 'baseball/mlb' },
                            player.isProbable ? 'strikeouts' : 'hrr'
                          )}
                          style={{ fontSize: 11, color: '#c9d1d9', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.color = '#58a6ff'}
                          onMouseLeave={e => e.currentTarget.style.color = '#c9d1d9'}
                        >
                          {player.name}
                        </span>
                        {player.position && (
                          <span style={{ fontSize: 10, color: '#484f58', flexShrink: 0 }}>{player.position}</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
