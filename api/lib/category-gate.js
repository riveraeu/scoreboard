// Shadow-calibration category gate — the single source of truth for which (sport, stat/gameType)
// + truePct bands are confirmed working by calibration (n≥50, positive ROI signal). Lives in
// api/lib/ (not src/) so BOTH the frontend display filter (src/lib/constants.js re-exports this)
// and the server-side push-notify cron apply the identical gate. Update this set when a new
// category crosses the threshold via `npm run tune:gate` — see CLAUDE.md "Category gate".
// Key format: `${sport}|${stat || gameType}` — matches what the calibration endpoint groups by.
export function passesCategoryGate(p) {
  const key = `${p.sport}|${p.stat || p.gameType}`;
  if (key === 'mlb|strikeouts') return (p.truePct ?? 0) >= 80 && (p.truePct ?? 0) < 85; // cap 90→85 2026-06-17: 85–90 band bled −35% in-gate (overconfidence); 80–85 ~breakeven
  if (key === 'wnba|points')    return (p.truePct ?? 0) >= 70 && (p.truePct ?? 0) < 80;
  if (key === 'wnba|rebounds')  return (p.truePct ?? 0) >= 70 && (p.truePct ?? 0) < 85;
  if (key === 'wnba|spread')    return (p.truePct ?? 0) >= 65 && (p.truePct ?? 0) < 85;
  return false;
}
