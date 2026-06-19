// Shadow-calibration category gate — the single source of truth for which (sport, stat/gameType)
// + truePct bands are confirmed working by calibration (n≥50, positive ROI signal). Lives in
// api/lib/ (not src/) so BOTH the frontend display filter (src/lib/constants.js re-exports this)
// and the server-side push-notify cron apply the identical gate. Update this set when a new
// category crosses the threshold via `npm run tune:gate` — see CLAUDE.md "Category gate".
// Key format: `${sport}|${stat || gameType}` — matches what the calibration endpoint groups by.
export function passesCategoryGate(p) {
  const key = `${p.sport}|${p.stat || p.gameType}`;
  if (key === 'mlb|strikeouts') return (p.truePct ?? 0) >= 80 && (p.truePct ?? 0) < 85; // cap 90→85 2026-06-17: 85–90 band bled −35% in-gate (overconfidence); 80–85 ~breakeven
  // wnba|points PAUSED 2026-06-19: formula-clean validation (since 5/28) found the gate is mis-placed —
  // the [70,80) band caught only n=3 (33% hit, −36% ROI) while the profitable plays sit at [80,85)
  // (n=10, 90% hit, +14%) ABOVE the cap and were being EXCLUDED. Model is underconfident (+17.5), so
  // its high-truePct picks over-deliver. Do NOT re-enable until tune:gate confirms the right band at
  // n≥50 + coherence (likely [80,85)). See memory [[project-live-gate-validation-2026-06-19]].
  // if (key === 'wnba|points')    return (p.truePct ?? 0) >= 70 && (p.truePct ?? 0) < 80;
  if (key === 'wnba|rebounds')  return (p.truePct ?? 0) >= 70 && (p.truePct ?? 0) < 85;
  // wnba|spread PAUSED 2026-06-19: formula-clean validation (since 5/28) — bet set n=15 hit 20% / ROI
  // −15.5% while the model claimed +13.8% avg edge (severe overconfidence), and unfiltered Brier
  // skill −0.032 @ n=237 confirms the market is much sharper on the FULL distribution (not small-n).
  // Unlike points there's no profitable band to move to. The 6/11 promotion (~+11% @ n=39) was on
  // pre-formula-clean data. Re-enable only after tune:gate shows a coherent +ROI band at n≥50.
  // if (key === 'wnba|spread')    return (p.truePct ?? 0) >= 65 && (p.truePct ?? 0) < 85;
  return false;
}
