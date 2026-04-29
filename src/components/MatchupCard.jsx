import React from 'react';
import { WORKER } from '../lib/constants.js';

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


export default function MatchupCard({ game, mlbMeta, mlbMetaTomorrow, nbaMeta, navigateToPlayer, navigateToTeam, gamePlays, trackedPlays, onNotificationClick }) {
  const { sport, homeTeam, awayTeam, gameDate, gameTime, ouLine, gameState, gameDetail, homeScore, awayScore } = game;
  const [lineupOpen, setLineupOpen] = React.useState(false);
  const [lineup, setLineup] = React.useState(null);
  const [lineupLoading, setLineupLoading] = React.useState(false);


  const gameTimeStr = fmtGameTime(gameTime);

  // ── MLB metadata ──────────────────────────────────────────────────────────
  const todayPT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const isToday = !gameDate || gameDate === todayPT;
  const mlbGameOdds = (isToday ? mlbMeta : null)?.gameOdds ?? {};
  const mlbAwayML = mlbGameOdds[awayTeam]?.ml ?? null;
  const mlbHomeML = mlbGameOdds[homeTeam]?.ml ?? null;

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

      {/* NBA: injured players — always visible outside drawer */}
      {sport === 'nba' && (awayInjured.length > 0 || homeInjured.length > 0) && (
        <div style={{ borderTop: '1px solid #0d1117', padding: '8px 16px' }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {awayInjured.map((p, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '1px 0' }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '0 4px', borderRadius: 3,
                    background: p.status === 'out' ? 'rgba(247,129,102,0.15)' : 'rgba(227,179,65,0.15)',
                    color: p.status === 'out' ? '#f78166' : '#e3b341',
                    border: `1px solid ${p.status === 'out' ? 'rgba(247,129,102,0.3)' : 'rgba(227,179,65,0.3)'}`,
                  }}>{p.status === 'out' ? 'OUT' : 'GTD'}</span>
                  <span style={{ fontSize: 10, color: '#8b949e' }}>{p.name}</span>
                </div>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {homeInjured.map((p, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '1px 0', flexDirection: 'row-reverse' }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '0 4px', borderRadius: 3,
                    background: p.status === 'out' ? 'rgba(247,129,102,0.15)' : 'rgba(227,179,65,0.15)',
                    color: p.status === 'out' ? '#f78166' : '#e3b341',
                    border: `1px solid ${p.status === 'out' ? 'rgba(247,129,102,0.3)' : 'rgba(227,179,65,0.3)'}`,
                  }}>{p.status === 'out' ? 'OUT' : 'GTD'}</span>
                  <span style={{ fontSize: 10, color: '#8b949e' }}>{p.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Play notification badge */}
      {onNotificationClick && gamePlays && gamePlays.length > 0 && (() => {
        const totalPlays = gamePlays.length;
        const trackedCount = gamePlays.filter(gp => (trackedPlays || []).some(tp => tp.id === gp.id)).length;
        const allTracked = trackedCount === totalPlays;
        return (
          <div style={{ borderTop: '1px solid #0d1117', padding: '8px 14px', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={e => { e.stopPropagation(); onNotificationClick(game); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                fontSize: 11, fontWeight: 700, cursor: 'pointer',
                padding: '4px 10px', borderRadius: 20,
                border: `1px solid ${allTracked ? 'rgba(227,179,65,0.4)' : 'rgba(88,166,255,0.4)'}`,
                background: allTracked ? 'rgba(227,179,65,0.1)' : 'rgba(88,166,255,0.1)',
                color: allTracked ? '#e3b341' : '#58a6ff',
              }}>
              {allTracked ? '★' : '▶'}
              <span>{totalPlays} play{totalPlays !== 1 ? 's' : ''}</span>
            </button>
          </div>
        );
      })()}

      {/* NBA lineup drawer */}
      {sport === 'nba' && (
        <div style={{ borderTop: '1px solid #0d1117' }}>
          <button onClick={onToggleLineup} style={{
            width: '100%', background: 'none', border: 'none', cursor: 'pointer',
            padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 6,
            color: '#484f58', fontSize: 11, fontWeight: 600, textAlign: 'left',
          }}>
            <span style={{ fontSize: 9, display: 'inline-block', transition: 'transform 0.15s',
              transform: lineupOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            Starting Lineups
            {lineupLoading && <span style={{ color: '#30363d', marginLeft: 4 }}>Loading…</span>}
          </button>
          {lineupOpen && lineup && (
            <div style={{ padding: '0 16px 12px', display: 'flex', gap: 16 }}>
              {[
                { abbr: awayTeam, data: lineup.away, confirmed: lineup.awayConfirmed, isHome: false },
                { abbr: homeTeam, data: lineup.home, confirmed: lineup.homeConfirmed, isHome: true },
              ].map(({ abbr, data, confirmed, isHome }) => (
                <div key={abbr} style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, flexDirection: isHome ? 'row-reverse' : 'row' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#484f58', textTransform: 'uppercase', letterSpacing: 0.5 }}>{abbr}</span>
                    <LineupBadge confirmed={confirmed} />
                  </div>
                  {data.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#484f58', fontStyle: 'italic', textAlign: isHome ? 'right' : 'left' }}>No lineup posted</div>
                  ) : (
                    data.map((player, idx) => (
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
