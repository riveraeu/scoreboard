import React from 'react';
import { TOTAL_THRESHOLDS } from '../lib/constants.js';
import { tierColor } from '../lib/colors.js';

const TAB_LABELS = {
  game_over:  'Game Over',
  game_under: 'Game Under',
  team_over:  'Team Over',
  team_under: 'Team Under',
};

function TotalsBarChart({ gameLog, sport, tonightTotalMap, tonightPlay, trackedPlays, onTrack, onUntrack, playType, onPlayTypeChange, availableTabs }) {
  const thresholds = TOTAL_THRESHOLDS[sport] || [5,6,7,8,9,10];
  const completed = (gameLog || []).filter(g => g.result);
  const isUnder = playType?.includes('under') ?? false;

  const visibleTabs = sport === 'nhl'
    ? ['game_over', 'game_under']
    : ['game_over', 'game_under', 'team_over', 'team_under'];
  const availSet = new Set(availableTabs || []);

  const data = thresholds.map(t => {
    const count = completed.filter(g => g.total >= t).length;
    const pct = completed.length > 0 ? (count / completed.length) * 100 : 0;
    return { t, count, pct };
  });

  return (
    <div>
      {/* Tab strip */}
      {onPlayTypeChange && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {visibleTabs.map(key => {
            const active = playType === key;
            const enabled = availSet.has(key);
            return (
              <button key={key}
                onClick={() => enabled && onPlayTypeChange(key)}
                disabled={!enabled}
                style={{
                  background: active ? 'rgba(88,166,255,0.12)' : 'transparent',
                  border: `1px solid ${active ? '#58a6ff' : '#30363d'}`,
                  borderRadius: 20, padding: '3px 10px', fontSize: 11,
                  fontWeight: active ? 700 : 400,
                  color: active ? '#58a6ff' : enabled ? '#8b949e' : '#484f58',
                  cursor: enabled ? 'pointer' : 'not-allowed',
                  opacity: enabled ? 1 : 0.4,
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
        const edgeColor = edge == null ? '#484f58' : edge >= 3 ? '#3fb950' : edge >= 0 ? '#e3b341' : '#f78166';

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
        const canTrack = tp != null && (rawKalshiPct ?? 0) >= 70 && edge != null && edge >= 3;
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
