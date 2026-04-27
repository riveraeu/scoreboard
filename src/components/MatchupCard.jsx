import React from 'react';
import { WORKER, SPORT_KEY } from '../lib/constants.js';
import { tierColor } from '../lib/colors.js';

const SPORT_LOGO_KEY = { mlb: 'mlb', nba: 'nba', nhl: 'nhl' };

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

// Build deduped best-play-per-player list for badges
function buildBadgePlays(plays) {
  const map = new Map();
  const all = [...plays].sort((a, b) => (b.qualified === false ? -1 : 1) - (a.qualified === false ? -1 : 1) || (b.edge || 0) - (a.edge || 0));
  for (const p of all) {
    const key = p.gameType === 'total'
      ? `total|${p.homeTeam}|${p.awayTeam}|${p.threshold}|${p.direction || 'over'}`
      : p.gameType === 'teamTotal'
        ? `tt|${p.scoringTeam}|${p.threshold}`
        : `${p.playerName}|${p.stat}`;
    if (!map.has(key)) map.set(key, p);
  }
  return [...map.values()].sort((a, b) => {
    const qa = a.qualified !== false, qb = b.qualified !== false;
    if (qa !== qb) return qa ? -1 : 1;
    return (b.edge || 0) - (a.edge || 0);
  });
}

// Extract pitcher info per team from plays
function extractPitchers(plays) {
  const pitchers = {};
  for (const p of plays) {
    if (p.stat === 'strikeouts' && p.pitcherName && p.playerTeam && !pitchers[p.playerTeam]) {
      pitchers[p.playerTeam] = { name: p.pitcherName, era: p.pitcherEra ?? null };
    }
    if (p.stat === 'hrr' && p.hitterPitcherName && p.opponent && !pitchers[p.opponent]) {
      pitchers[p.opponent] = { name: p.hitterPitcherName, era: p.hitterPitcherEra ?? null };
    }
  }
  return pitchers;
}

function PlayBadge({ play, navigateToPlayer, navigateToTeam }) {
  const qualified = play.qualified !== false;
  const edge = play.edge ?? 0;
  const edgeColor = edge >= 5 ? '#3fb950' : edge >= 3 ? '#e3b341' : '#8b949e';

  const handleClick = () => {
    if (play.gameType === 'total') {
      // navigate to home team page
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
    sublabel = `${play.homeTeam} vs ${play.awayTeam} · Total`;
  } else if (play.gameType === 'teamTotal') {
    label = `${play.scoringTeam} O${play.threshold}`;
    sublabel = 'Team Runs';
  } else {
    const statMap = { strikeouts: 'K', hrr: 'HRR', points: 'PTS', rebounds: 'REB', assists: 'AST', threePointers: '3PM', goals: 'G' };
    label = `${play.playerName}`;
    sublabel = `${statMap[play.stat] || play.stat} ${play.threshold}+`;
  }

  const truePct = play.direction === 'under' ? play.noTruePct : play.truePct;

  return (
    <div onClick={handleClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
      padding: '5px 10px', borderRadius: 8,
      background: qualified ? 'rgba(63,185,80,0.06)' : 'rgba(139,148,158,0.05)',
      border: `1px solid ${qualified ? 'rgba(63,185,80,0.25)' : '#21262d'}`,
      transition: 'background 0.15s',
    }}
    onMouseEnter={e => e.currentTarget.style.background = qualified ? 'rgba(63,185,80,0.12)' : 'rgba(139,148,158,0.10)'}
    onMouseLeave={e => e.currentTarget.style.background = qualified ? 'rgba(63,185,80,0.06)' : 'rgba(139,148,158,0.05)'}
    >
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#c9d1d9', lineHeight: 1.3 }}>{label}</div>
        <div style={{ fontSize: 10, color: '#8b949e', lineHeight: 1.2 }}>{sublabel}</div>
      </div>
      {truePct != null && (
        <div style={{ fontSize: 11, fontWeight: 700, color: tierColor(truePct) }}>{truePct}%</div>
      )}
      {edge !== 0 && (
        <div style={{ fontSize: 11, fontWeight: 700, color: edgeColor }}>
          {edge > 0 ? '+' : ''}{edge.toFixed(1)}%
        </div>
      )}
    </div>
  );
}

export default function MatchupCard({ game, navigateToPlayer, navigateToTeam }) {
  const { sport, homeTeam, awayTeam, gameDate, gameTime, ouLine, plays } = game;
  const [lineupOpen, setLineupOpen] = React.useState(false);
  const [lineup, setLineup] = React.useState(null);
  const [lineupLoading, setLineupLoading] = React.useState(false);

  const gameTimeStr = fmtGameTime(gameTime);
  const pitchers = sport === 'mlb' ? extractPitchers(plays) : {};
  const umpire = plays.find(p => p.umpireName)?.umpireName ?? null;
  const badgePlays = buildBadgePlays(plays);
  const qualifiedCount = plays.filter(p => p.qualified !== false).length;

  async function onToggleLineup() {
    if (!lineupOpen && !lineup) {
      setLineupLoading(true);
      try {
        const [homeRes, awayRes] = await Promise.all([
          fetch(`${WORKER}/team?abbr=${homeTeam}&sport=${sport}`).then(r => r.ok ? r.json() : null),
          fetch(`${WORKER}/team?abbr=${awayTeam}&sport=${sport}`).then(r => r.ok ? r.json() : null),
        ]);
        setLineup({ home: homeRes?.lineup ?? [], away: awayRes?.lineup ?? [] });
      } catch { setLineup({ home: [], away: [] }); }
      setLineupLoading(false);
    }
    setLineupOpen(o => !o);
  }

  return (
    <div style={{
      background: '#161b22', border: '1px solid #21262d', borderRadius: 12,
      marginBottom: 12, overflow: 'hidden',
    }}>
      {/* Header: away @ home */}
      <div style={{ padding: '14px 16px 10px', display: 'flex', alignItems: 'center', gap: 0 }}>
        {/* Away */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
          onClick={() => navigateToTeam(awayTeam, sport)}>
          <img src={logoUrl(sport, awayTeam)} alt={awayTeam}
            style={{ width: 44, height: 44, objectFit: 'contain' }}
            onError={e => { e.target.style.display = 'none'; }} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#c9d1d9' }}>{awayTeam}</div>
            <div style={{ fontSize: 10, color: '#484f58' }}>Away</div>
          </div>
        </div>

        {/* Center: time + O/U */}
        <div style={{ textAlign: 'center', minWidth: 110, padding: '0 8px' }}>
          <div style={{ fontSize: 10, color: '#484f58', fontWeight: 600, letterSpacing: 1 }}>@</div>
          {gameTimeStr && <div style={{ fontSize: 10, color: '#8b949e', marginTop: 2 }}>{gameTimeStr}</div>}
          {ouLine != null && (
            <div style={{ fontSize: 11, color: '#8b949e', marginTop: 1 }}>O/U {ouLine}</div>
          )}
        </div>

        {/* Home */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', cursor: 'pointer' }}
          onClick={() => navigateToTeam(homeTeam, sport)}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#c9d1d9' }}>{homeTeam}</div>
            <div style={{ fontSize: 10, color: '#484f58' }}>Home</div>
          </div>
          <img src={logoUrl(sport, homeTeam)} alt={homeTeam}
            style={{ width: 44, height: 44, objectFit: 'contain' }}
            onError={e => { e.target.style.display = 'none'; }} />
        </div>
      </div>

      {/* MLB: pitchers + umpire */}
      {sport === 'mlb' && (Object.keys(pitchers).length > 0 || umpire) && (
        <div style={{ padding: '0 16px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #0d1117' }}>
          <div style={{ fontSize: 11, color: '#8b949e' }}>
            {pitchers[awayTeam]
              ? <><span style={{ color: '#c9d1d9' }}>{pitchers[awayTeam].name}</span>{pitchers[awayTeam].era != null ? <span style={{ color: '#484f58' }}> ({pitchers[awayTeam].era} ERA)</span> : null}</>
              : <span style={{ color: '#484f58' }}>TBD</span>}
          </div>
          <div style={{ fontSize: 10, color: '#484f58', textAlign: 'center', padding: '0 8px' }}>
            {umpire ? `HP: ${umpire}` : ''}
          </div>
          <div style={{ fontSize: 11, color: '#8b949e', textAlign: 'right' }}>
            {pitchers[homeTeam]
              ? <><span style={{ color: '#c9d1d9' }}>{pitchers[homeTeam].name}</span>{pitchers[homeTeam].era != null ? <span style={{ color: '#484f58' }}> ({pitchers[homeTeam].era} ERA)</span> : null}</>
              : <span style={{ color: '#484f58' }}>TBD</span>}
          </div>
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

      {/* MLB lineup drawer toggle */}
      {sport === 'mlb' && (
        <div style={{ borderTop: '1px solid #0d1117' }}>
          <button onClick={onToggleLineup} style={{
            width: '100%', background: 'none', border: 'none', cursor: 'pointer',
            padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 6,
            color: '#484f58', fontSize: 11, fontWeight: 600, textAlign: 'left',
          }}>
            <span style={{ fontSize: 9, transition: 'transform 0.15s', display: 'inline-block',
              transform: lineupOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
            Batting Lineups
            {lineupLoading && <span style={{ color: '#30363d', marginLeft: 4 }}>Loading…</span>}
          </button>

          {lineupOpen && lineup && (
            <div style={{ padding: '0 16px 12px', display: 'flex', gap: 16 }}>
              {[{ abbr: awayTeam, data: lineup.away, label: 'Away' }, { abbr: homeTeam, data: lineup.home, label: 'Home' }].map(({ abbr, data, label }) => (
                <div key={abbr} style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#484f58', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {abbr} {label}
                  </div>
                  {data.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#484f58', fontStyle: 'italic' }}>No lineup posted</div>
                  ) : (
                    data.map((player, idx) => (
                      <div key={idx} style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0',
                        borderBottom: idx < data.length - 1 ? '1px solid #0d1117' : 'none',
                      }}>
                        {player.isProbable ? (
                          <span style={{ fontSize: 10, color: '#484f58', width: 14, textAlign: 'center' }}>P</span>
                        ) : (
                          <span style={{ fontSize: 10, color: '#484f58', width: 14, textAlign: 'center' }}>
                            {player.spot ?? idx + 1}
                          </span>
                        )}
                        <span style={{ fontSize: 11, color: '#c9d1d9', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {player.name}
                        </span>
                        {player.position && (
                          <span style={{ fontSize: 10, color: '#484f58' }}>{player.position}</span>
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
