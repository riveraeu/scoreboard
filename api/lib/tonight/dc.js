// dataConfidence penalty engine. Pure function over a play object + minimal context.
// Score starts at 10, subtracts per-rule penalties, clamps [0, 10].
//
// Gate is 7. Only kalshiStale (-4 → dc=6) fails it; lowVolume (-2 → dc=8) is a display
// signal that passes. All model-era penalty branches (playerOut, heavy-injury,
// season-rate-divergence, threshold-distance) removed — those fields are never set on
// play objects post-teardown (2026-08-04). DC_GATE is kept because dc.js callers still
// need the gate value for dcQualified/dcGate in the play row.

export const DC_GATE = (_sport, _gameType) => 7;

export function computeDataConfidence(p, ctx = {}) {
  const sport = p.sport;
  const gameType = p.gameType;
  const penalties = {};
  const _pen = (label, cost) => { if (cost) penalties[label] = -Math.abs(cost); };

  // ── Market quality
  if (p._kalshiStale === true) _pen("kalshiStale", 4);   // dc=6 → fails gate
  if (p.lowVolume === true)    _pen("lowVolume", 2);      // dc=8 → display only

  const totalPenalty = Object.values(penalties).reduce((s, v) => s + v, 0);
  const dataConfidence = Math.max(0, Math.min(10, 10 + totalPenalty));
  const gate = DC_GATE(sport, gameType);
  return { dataConfidence, dcPenalties: penalties, dcQualified: dataConfidence >= gate, dcGate: gate };
}
