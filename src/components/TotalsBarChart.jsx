import React from 'react';
import { TOTAL_THRESHOLDS, TEAM_TOTAL_THRESHOLDS } from '../lib/constants.js';
import { tierColor } from '../lib/colors.js';

// Universal qualification tunables — keep in sync with backend constants in api/[...path].js
const KALSHI_GATE = 67;
const KALSHI_CAP = 91;
const EDGE_GATE = 3;

const TAB_LABELS = {
  game_over:  'Game Over',
  game_under: 'Game Under',
  team_over:  'Team Over',
  team_under: 'Team Under',
};

function TotalsBarChart({ gameLog, sport, tonightTotalMap, tonightPlay, trackedPlays, onTrack, onUntrack, playType, onPlayTypeChange }) {
  const isTeamTotal = playType?.startsWith('team_') ?? false;
  const isUnder = playType?.includes('under') ?? false;
  const completed = (gameLog || []).filter(g => g.result);

  const visibleTabs = sport === 'nhl'
    ? ['game_over', 'game_under']
    : ['game_over', 'game_under', 'team_over', 'team_under'];

  // Select thresholds: team total tabs use team-scoring range, game total uses combined range.
  // Merge with any Kalshi thresholds present in tonightTotalMap.
  const defaultThresholds = isTeamTotal
    ? (TEAM_TOTAL_THRESHOLDS[sport] || [3,4,5,6,7,8])
    : (TOTAL_THRESHOLDS[sport] || [5,6,7,8,9,10]);
  const tonightKeys = Object.keys(tonightTotalMap || {}).map(Number).filter(n => !isNaN(n) && n > 0);
  const thresholds = [...new Set([...defaultThresholds, ...tonightKeys])].sort((a, b) => a - b);

  const statField = isTeamTotal ? 'teamScore' : 'total';
  const data = thresholds.map(t => {
    const overCount = completed.filter(g => (g[statField] ?? 0) >= t).length;
    const count = isUnder ? completed.length - overCount : overCount;
    const pct = completed.length > 0 ? (count / completed.length) * 100 : 0;
    return { t, count, pct };
  });

  return (
    <div>
      {/* Tab strip */}
      {onPlayTypeChange && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {visibleTabs.map(key => {
            const active = playType === key;
            return (
              <button key={key}
                onClick={() => onPlayTypeChange(key)}
                style={{
                  flex: 1, padding: '9px 0', borderRadius: 8,
                  border: '1px solid', cursor: 'pointer', fontSize: 13,
                  borderColor: active ? '#58a6ff' : '#30363d',
                  background: active ? 'rgba(88,166,255,0.12)' : '#161b22',
                  color: active ? '#58a6ff' : '#8b949e',
                  fontWeight: active ? 700 : 400,
                }}>
                {TAB_LABELS[key]}
              </button>
            );
          })}
        </div>
      )}

      {data.map(({ t, count, pct }) => {
        const tp = tonightTotalMap?.[t] ?? null;
        const lineLabel = `O${(t - 0.5).toFixed(1)}`;

        const rawKalshiPct = tp ? (isUnder ? (tp.noKalshiPct ?? tp.kalshiPct) : tp.kalshiPct) : null;
        const rawModelPct  = tp ? (isUnder ? (tp.noTruePct  ?? tp.truePct)  : tp.truePct)  : null;
        const kalshiPct = rawKalshiPct ?? null;
        const modelPct  = rawModelPct  ?? null;
        const edge = tp?.edge ?? null;
        const edgeColor = edge == null ? '#484f58' : edge >= EDGE_GATE ? '#3fb950' : edge >= 0 ? '#e3b341' : '#f78166';

        // Track ID — handles game total vs team total, over vs under
        const _gameType = tp?.gameType ?? 'total';
        const _isUnderPlay = tp?.direction === 'under';
        let trackId = null;
        if (tp) {
          trackId = _gameType === 'teamTotal'
            ? `teamtotal|${tp.sport}|${tp.scoringTeam}|${tp.oppTeam}|${t}|${tp.gameDate||''}${_isUnderPlay?'|under':''}`
            : `total|${tp.sport}|${tp.homeTeam}|${tp.awayTeam}|${t}|${tp.gameDate||''}${_isUnderPlay?'|under':''}`;
        }

        const _tAnchor = tp ?? tonightPlay;
        const _localToday = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
        const _existingPick = (_tAnchor && trackId) ? (trackedPlays || []).find(p => {
          if (_gameType === 'teamTotal') {
            const [pt,ps,psc,pOpp,pth,pd] = p.id.split('|');
            return pt==='teamtotal' && ps===_tAnchor.sport && psc===_tAnchor.scoringTeam && pOpp===_tAnchor.oppTeam && String(pth)===String(t) && (!pd || pd >= _localToday);
          }
          const [pt,ps,ph,pa,pth,pd] = p.id.split('|');
          return pt==='total' && ps===_tAnchor.sport && ph===_tAnchor.homeTeam && pa===_tAnchor.awayTeam && String(pth)===String(t) && (!pd || pd >= _localToday);
        }) : null;
        const isTracked = !!_existingPick || !!(trackId && (trackedPlays || []).some(p => p.id === trackId));
        const _untrackId = _existingPick?.id ?? trackId;
        const canTrack = tp?.qualified === true && (rawKalshiPct ?? 0) >= KALSHI_GATE && (rawKalshiPct ?? 0) <= KALSHI_CAP && edge != null && edge >= EDGE_GATE;
        const trackBtn = canTrack ? (
          <button
            onClick={() => isTracked ? onUntrack(_untrackId) : onTrack({ ...tp, threshold: t })}
            title={isTracked ? 'Remove pick' : 'Add to My Picks'}
            style={{ background: isTracked ? 'rgba(63,185,80,0.15)' : 'transparent',
              border: `1px solid ${isTracked ? '#3fb950' : '#30363d'}`,
              borderRadius: 6, padding: '1px 6px', cursor: 'pointer',
              color: isTracked ? '#3fb950' : '#484f58', fontSize: 13, lineHeight: 1, flexShrink: 0 }}>
            {isTracked ? '★' : '☆'}
          </button>
        ) : null;

        const hasTonightData = modelPct != null;
        const primaryPct = hasTonightData ? modelPct : pct;
        const barColor = tierColor(primaryPct);
        const labelColor = tp ? '#c9d1d9' : '#8b949e';

        return (
          <div key={t} style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'flex-start' }}>
            <div style={{ color: labelColor, fontSize: 13, width: 40, textAlign: 'right',
              flexShrink: 0, paddingTop: 2, fontWeight: 400 }}>
              {lineLabel}
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {/* Primary bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, background: '#21262d', borderRadius: 5, height: 18, overflow: 'hidden' }}>
                  <div style={{ width: `${primaryPct}%`, background: barColor, height: '100%', borderRadius: 5,
                    transition: 'width 0.5s ease', minWidth: primaryPct > 0 ? 4 : 0 }} />
                </div>
                <div style={{ color: barColor, fontSize: 13, fontWeight: 700, width: 42, textAlign: 'right', flexShrink: 0 }}>
                  {primaryPct.toFixed(1)}%
                </div>
                <div style={{ flexShrink: 0, width: 110, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: '#484f58', fontSize: 10, flex: 1 }}>{count}/{completed.length}g</span>
                  {hasTonightData && edge != null && (
                    <span style={{ background: edgeColor + '22', border: `1px solid ${edgeColor}`, borderRadius: 4,
                      padding: '1px 5px', fontSize: 10, fontWeight: 700, color: edgeColor, whiteSpace: 'nowrap' }}>
                      {edge >= 0 ? '+' : ''}{edge}%
                    </span>
                  )}
                  {trackBtn}
                </div>
              </div>
              {/* Kalshi bar */}
              {kalshiPct != null && (() => {
                const kOdds = kalshiPct >= 50 ? Math.round(-(kalshiPct/(100-kalshiPct))*100) : Math.round((100-kalshiPct)/kalshiPct*100);
                const kOddsStr = kOdds > 0 ? `+${kOdds}` : `${kOdds}`;
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, background: '#21262d', borderRadius: 4, height: 11, overflow: 'hidden' }}>
                      <div style={{ width: `${kalshiPct}%`, background: '#6e40c9', height: '100%', borderRadius: 4,
                        transition: 'width 0.5s ease', minWidth: kalshiPct > 0 ? 2 : 0 }} />
                    </div>
                    <div style={{ color: '#6e40c9', fontSize: 11, fontWeight: 600, width: 42, textAlign: 'right', flexShrink: 0 }}>
                      {kalshiPct}%
                    </div>
                    <div style={{ color: '#6e40c9', fontSize: 10, width: 110, flexShrink: 0, paddingLeft: 2 }}>
                      ({kOddsStr})
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default TotalsBarChart;
