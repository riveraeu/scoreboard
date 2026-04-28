import React from 'react';
import { WORKER } from '../lib/constants.js';

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


export default function MatchupCard({ game, mlbMeta, nbaMeta, navigateToPlayer, navigateToTeam }) {
  const { sport, homeTeam, awayTeam, gameDate, gameTime, ouLine } = game;
  const [lineupOpen, setLineupOpen] = React.useState(false);
  const [lineup, setLineup] = React.useState(null);
  const [lineupLoading, setLineupLoading] = React.useState(false);

  // Auto-fetch NBA lineup on mount (shown inline, no drawer click needed)
  React.useEffect(() => {
    if (sport !== 'nba') return;
    setLineupLoading(true);
    Promise.all([
      fetch(`${WORKER}/team?abbr=${homeTeam}&sport=nba`).then(r => r.ok ? r.json() : null),
      fetch(`${WORKER}/team?abbr=${awayTeam}&sport=nba`).then(r => r.ok ? r.json() : null),
    ]).then(([homeRes, awayRes]) => {
      setLineup({
        home: homeRes?.lineup ?? [],
        away: awayRes?.lineup ?? [],
        homeConfirmed: homeRes?.lineupConfirmed ?? null,
        awayConfirmed: awayRes?.lineupConfirmed ?? null,
      });
      setLineupLoading(false);
    }).catch(() => {
      setLineup({ home: [], away: [], homeConfirmed: null, awayConfirmed: null });
      setLineupLoading(false);
    });
  }, [sport, homeTeam, awayTeam]);

  const gameTimeStr = fmtGameTime(gameTime);
  const isDomed = DOMED_STADIUMS.has(homeTeam);

  // ── MLB metadata ──────────────────────────────────────────────────────────
  const pitchers = sport === 'mlb' ? (mlbMeta?.pitchers ?? {}) : {};
  const awayPitcher = pitchers[awayTeam] ?? null;
  const homePitcher = pitchers[homeTeam] ?? null;
  const mlbGameOdds = mlbMeta?.gameOdds ?? {};
  const mlbAwayML = mlbGameOdds[awayTeam]?.ml ?? null;
  const mlbHomeML = mlbGameOdds[homeTeam]?.ml ?? null;
  const umpireKey = `${homeTeam}|${awayTeam}`;
  const umpire = mlbMeta?.umpires?.[umpireKey] ?? null;
  const weatherData = mlbMeta?.weather?.[umpireKey] ?? null;

  // Lineup confirmed (MLB)
  const _projTeams = new Set(mlbMeta?.projectedLineupTeams ?? []);
  const _teamsWithLineup = new Set(mlbMeta?.teamsWithLineup ?? []);
  const getMlbLineupConfirmed = (abbr) => {
    if (!_teamsWithLineup.has(abbr)) return null;
    return !_projTeams.has(abbr);
  };
  const awayMlbConfirmed = sport === 'mlb' ? getMlbLineupConfirmed(awayTeam) : null;
  const homeMlbConfirmed = sport === 'mlb' ? getMlbLineupConfirmed(homeTeam) : null;

  // ── NBA metadata ──────────────────────────────────────────────────────────
  const nbaGameOdds = sport === 'nba' ? (nbaMeta?.gameOdds ?? {}) : {};
  const nbaAwayOdds = nbaGameOdds[awayTeam] ?? {};
  const nbaHomeOdds = nbaGameOdds[homeTeam] ?? {};
  const nbaAwayML = nbaAwayOdds.ml ?? null;
  const nbaHomeML = nbaHomeOdds.ml ?? null;
  // O/U: prefer nbaMeta (always available from ESPN), fall back to game.ouLine
  const nbaTotal = nbaHomeOdds.total ?? nbaAwayOdds.total ?? ouLine ?? null;
  const nbaHomeSpread = nbaHomeOdds.spread ?? null;
  const nbaAwaySpread = nbaAwayOdds.spread ?? null;
  const nbaInjuries = sport === 'nba' ? (nbaMeta?.injuries ?? {}) : {};
  const awayInjured = nbaInjuries[awayTeam] ?? [];
  const homeInjured = nbaInjuries[homeTeam] ?? [];

  // Center header stats (sport-aware)
  const displayTotal = sport === 'nba' ? nbaTotal : ouLine;
  const displayAwayML = sport === 'nba' ? nbaAwayML : mlbAwayML;
  const displayHomeML = sport === 'nba' ? nbaHomeML : mlbHomeML;
  // Spread: show home spread for NBA (negative = favored)
  const displaySpread = sport === 'nba' ? nbaHomeSpread : null;

  const showMlbExtra = sport === 'mlb' && (awayPitcher || homePitcher);
  const showMlbDetails = sport === 'mlb';

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
          homeConfirmed: homeRes?.lineupConfirmed ?? null,
          awayConfirmed: awayRes?.lineupConfirmed ?? null,
        });
      } catch { setLineup({ home: [], away: [], homeConfirmed: null, awayConfirmed: null }); }
      setLineupLoading(false);
    }
    setLineupOpen(o => !o);
  }

  return (
    <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 12, overflow: 'hidden' }}>

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

        {/* Center: time + O/U + ML + spread */}
        <div style={{ textAlign: 'center', minWidth: 120, padding: '0 8px' }}>
          {gameTimeStr && <div style={{ fontSize: 10, color: '#8b949e' }}>{gameTimeStr}</div>}
          {displayTotal != null && (
            <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>O/U {displayTotal}</div>
          )}
          {(displayAwayML != null || displayHomeML != null) && (
            <div style={{ fontSize: 10, color: '#484f58', marginTop: 2 }}>
              {fmtML(displayAwayML)} / {fmtML(displayHomeML)}
            </div>
          )}
          {displaySpread != null && (
            <div style={{ fontSize: 10, color: '#484f58', marginTop: 1 }}>
              {homeTeam} {fmtSpread(displaySpread)}
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
            {awayMlbConfirmed !== null && (
              <div style={{ marginTop: 3 }}><LineupBadge confirmed={awayMlbConfirmed} /></div>
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
            {homeMlbConfirmed !== null && (
              <div style={{ marginTop: 3, display: 'flex', justifyContent: 'flex-end' }}><LineupBadge confirmed={homeMlbConfirmed} /></div>
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

      {/* NBA lineup — shown inline, auto-fetched on mount */}
      {sport === 'nba' && (
        <div style={{ borderTop: '1px solid #0d1117', padding: '10px 16px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#484f58', textTransform: 'uppercase', letterSpacing: 0.5 }}>Lineups</span>
            {lineupLoading && <span style={{ fontSize: 10, color: '#30363d' }}>Loading…</span>}
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            {[
              { abbr: awayTeam, data: lineup?.away ?? [], confirmed: lineup?.awayConfirmed ?? null, injured: awayInjured, label: 'Away', isHome: false },
              { abbr: homeTeam, data: lineup?.home ?? [], confirmed: lineup?.homeConfirmed ?? null, injured: homeInjured, label: 'Home', isHome: true },
            ].map(({ abbr, data, confirmed, injured, label, isHome }) => (
              <div key={abbr} style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, flexDirection: isHome ? 'row-reverse' : 'row' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#484f58', textTransform: 'uppercase', letterSpacing: 0.5 }}>{abbr}</span>
                  <span style={{ fontSize: 10, color: '#484f58' }}>{label}</span>
                  <LineupBadge confirmed={confirmed} />
                </div>
                {/* Active players */}
                {data.map((player, idx) => (
                  <div key={idx} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0',
                    flexDirection: isHome ? 'row-reverse' : 'row',
                    borderBottom: idx < data.length - 1 ? '1px solid #0d1117' : 'none',
                  }}>
                    {player.position && (
                      <span style={{ fontSize: 9, color: '#484f58', width: 22, flexShrink: 0, textAlign: isHome ? 'right' : 'left' }}>{player.position}</span>
                    )}
                    <span
                      onClick={() => navigateToPlayer(
                        { id: player.playerId || null, name: player.name, team: abbr, sportKey: 'basketball/nba' },
                        'points'
                      )}
                      style={{ fontSize: 11, color: '#c9d1d9', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', textAlign: isHome ? 'right' : 'left' }}
                      onMouseEnter={e => e.currentTarget.style.color = '#58a6ff'}
                      onMouseLeave={e => e.currentTarget.style.color = '#c9d1d9'}
                    >
                      {player.name}
                    </span>
                  </div>
                ))}
                {data.length === 0 && !lineupLoading && (
                  <div style={{ fontSize: 11, color: '#484f58', fontStyle: 'italic', textAlign: isHome ? 'right' : 'left' }}>No lineup posted</div>
                )}
                {/* Injured players (always from nbaMeta, no fetch needed) */}
                {injured.length > 0 && (
                  <div style={{ marginTop: 6, paddingTop: 4, borderTop: data.length > 0 ? '1px solid #0d1117' : 'none' }}>
                    {injured.map((p, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '1px 0', flexDirection: isHome ? 'row-reverse' : 'row' }}>
                        <span style={{ fontSize: 10, color: '#8b949e' }}>{p.name}</span>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '0 4px', borderRadius: 3,
                          background: p.status === 'out' ? 'rgba(247,129,102,0.15)' : 'rgba(227,179,65,0.15)',
                          color: p.status === 'out' ? '#f78166' : '#e3b341',
                          border: `1px solid ${p.status === 'out' ? 'rgba(247,129,102,0.3)' : 'rgba(227,179,65,0.3)'}`,
                        }}>
                          {p.status === 'out' ? 'OUT' : 'GTD'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
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
                { abbr: awayTeam, data: lineup.away, confirmed: lineup.awayConfirmed, label: 'Away' },
                { abbr: homeTeam, data: lineup.home, confirmed: lineup.homeConfirmed, label: 'Home' },
              ].map(({ abbr, data, confirmed, label }) => (
                <div key={abbr} style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
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
