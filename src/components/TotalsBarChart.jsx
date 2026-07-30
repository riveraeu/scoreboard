import React from 'react';
import { TOTAL_THRESHOLDS, TEAM_TOTAL_THRESHOLDS, EDGE_HIGHLIGHT } from '../lib/constants.js';
import { tierColor } from '../lib/colors.js';

const TAB_LABELS = {
  game_over:  'Game Over',
  game_under: 'Game Under',
  team_over:  'Team Over',
  team_under: 'Team Under',
};

// Model-display totals chart for TeamPage. Shows season hit rate, the model's True%, and the
// Kalshi market price + edge per threshold. The taker ★ track button + bet-window gating were
// removed 2026-07-30; this is now purely an analytical view (edge = how far the model disagrees
// with the market, colored via EDGE_HIGHLIGHT — a display cue, not a bet signal).
function TotalsBarChart({ gameLog, sport, tonightTotalMap, tonightPlay, extraAltMap, allMatchupPlays, playType, onPlayTypeChange, onSelectPlay }) {
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
  const altKeys = Object.keys(extraAltMap || {}).map(Number).filter(n => !isNaN(n) && n > 0);
  const thresholds = [...new Set([...defaultThresholds, ...tonightKeys, ...altKeys])].sort((a, b) => a - b);

  const statField = isTeamTotal ? 'teamScore' : 'total';
  const data = thresholds.map(t => {
    const overCount = completed.filter(g => (g[statField] ?? 0) >= t).length;
    const count = isUnder ? completed.length - overCount : overCount;
    const pct = completed.length > 0 ? (count / completed.length) * 100 : 0;
    return { t, count, pct };
  });

  // Default-selected threshold: the model's strongest line (edge >= EDGE_HIGHLIGHT) else the
  // first threshold in the data list. Re-derives when thresholds change (e.g. switching playType).
  const defaultT = React.useMemo(() => {
    const strong = thresholds.find(t => {
      const tp = tonightTotalMap?.[t];
      return tp && (tp.edge ?? 0) >= EDGE_HIGHLIGHT;
    });
    return strong ?? thresholds[0] ?? null;
  }, [thresholds.join(','), tonightTotalMap, playType]);
  const [selectedT, setSelectedT] = React.useState(defaultT);
  // Reset selectedT when the threshold list shifts (playType change) or default changes
  React.useEffect(() => {
    if (!thresholds.includes(selectedT)) setSelectedT(defaultT);
  }, [defaultT, thresholds.join(',')]);

  // The play object that drives lambda inputs — lifted to a memo so TeamPage can consume it.
  const _hasLambda = (p) => p && (p.homeExpected != null || p.awayExpected != null
    || p.teamExpected != null || p.teamRPG != null || p.homeLambda != null);
  const selectedPlay = React.useMemo(() => (
    tonightTotalMap?.[selectedT]
    ?? Object.values(tonightTotalMap || {}).find(_hasLambda)
    ?? (allMatchupPlays || []).find(_hasLambda)
    ?? null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [selectedT, tonightTotalMap, allMatchupPlays]);
  React.useEffect(() => { onSelectPlay?.(selectedPlay); }, [selectedPlay]);

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

      {/* Per-threshold tab strip — one tab per available threshold. Scrolls horizontally on
          narrow screens. Active tab = selectedT; clicking switches the rendered row + InputList.
          Edge shown on EVERY tab: from the tonight play when available, falling back to
          (season hit rate − Kalshi price). Green = model edge ≥ EDGE_HIGHLIGHT, yellow =
          positive-but-smaller, red = negative. */}
      {thresholds.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 14, overflowX: 'auto', paddingBottom: 4 }}>
          {thresholds.map(t => {
            const tp = tonightTotalMap?.[t];
            const alt = extraAltMap?.[t];
            const tEdge = tp?.edge ?? null;
            const active = t === selectedT;
            const label = isUnder ? `U${(t - 0.5).toFixed(1)}` : `O${(t - 0.5).toFixed(1)}`;
            // Fallback edge: season hit rate vs Kalshi price (extraAltMap). UNDER flips both.
            const _seasonRow = data.find(d => d.t === t);
            const _seasonPct = _seasonRow?.pct ?? null;
            const _kalshiForEdge = tp
              ? (isUnder ? (tp.noKalshiPct ?? tp.kalshiPct) : tp.kalshiPct)
              : (alt ? (isUnder ? alt.noPct : alt.pct) : null);
            const fallbackEdge = (tEdge == null && _seasonPct != null && _kalshiForEdge != null)
              ? parseFloat((_seasonPct - _kalshiForEdge).toFixed(1)) : null;
            const displayEdge = tEdge ?? fallbackEdge;
            const strong = displayEdge != null && displayEdge >= EDGE_HIGHLIGHT;
            const edgeColor = displayEdge == null ? null
              : strong ? '#3fb950'
              : displayEdge >= 0 ? '#e3b341' : '#f78166';
            return (
              <div key={t} onClick={() => setSelectedT(t)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderRadius: 6,
                  border: `1px solid ${active ? '#58a6ff' : strong ? '#3fb950' : '#30363d'}`,
                  background: active ? 'rgba(88,166,255,0.12)' : strong ? 'rgba(63,185,80,0.08)' : '#161b22',
                  color: active ? '#58a6ff' : strong ? '#3fb950' : '#8b949e',
                  fontSize: 11, fontWeight: active ? 700 : 500, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                <span>{label}</span>
                {displayEdge != null && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: edgeColor }}>
                    {displayEdge >= 0 ? '+' : ''}{displayEdge}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {data.filter(({ t }) => t === selectedT).map(({ t, count, pct }) => {
        const tp = tonightTotalMap?.[t] ?? null;
        const alt = extraAltMap?.[t] ?? null;

        // Kalshi price: tonight play preferred (has full edge data), else fall back to extraAltMap
        // which carries the raw market price for thresholds outside the [67, 91] /api/tonight gate.
        // UNDER side uses noPct from either source.
        const rawKalshiPct = tp
          ? (isUnder ? (tp.noKalshiPct ?? tp.kalshiPct) : tp.kalshiPct)
          : (alt ? (isUnder ? alt.noPct : alt.pct) : null);
        const rawModelPct  = tp ? (isUnder ? (tp.noTruePct  ?? tp.truePct)  : tp.truePct)  : null;
        const kalshiPct = rawKalshiPct ?? null;
        const modelPct  = rawModelPct  ?? null;

        const hasTonightData = modelPct != null;
        const primaryPct = hasTonightData ? modelPct : pct;
        const barColor = tierColor(primaryPct);

        return (
          <div key={t} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {/* Primary bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, background: '#21262d', borderRadius: 5, height: 18, overflow: 'hidden' }}>
                  <div style={{ width: `${primaryPct}%`, background: barColor, height: '100%', borderRadius: 5,
                    transition: 'width 0.5s ease', minWidth: primaryPct > 0 ? 4 : 0 }} />
                </div>
                <div style={{ color: barColor, fontSize: 13, fontWeight: 700, width: 42, textAlign: 'right', flexShrink: 0 }}>
                  {primaryPct.toFixed(1)}%
                </div>
                <div style={{ flexShrink: 0 }}>
                  <span style={{ color: '#484f58', fontSize: 10 }}>{count}/{completed.length}g</span>
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
                    <div style={{ color: '#6e40c9', fontSize: 13, fontWeight: 600, width: 42, textAlign: 'right', flexShrink: 0 }}>
                      {(+kalshiPct).toFixed(1)}%
                    </div>
                    <div style={{ color: '#6e40c9', fontSize: 10, flexShrink: 0, paddingLeft: 2 }}>
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
