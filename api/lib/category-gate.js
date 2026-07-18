// Shadow-calibration category gate — the single source of truth for which (sport, stat/gameType)
// + truePct bands are confirmed working by calibration (n≥50, positive ROI signal). Lives in
// api/lib/ (not src/) so BOTH the frontend display filter (src/lib/constants.js re-exports this)
// and the server-side push-notify cron apply the identical gate. Update this set when a new
// category crosses the threshold via `npm run tune:gate` — see CLAUDE.md "Category gate".
// Key format: `${sport}|${stat || gameType}` — matches what the calibration endpoint groups by.
export function passesCategoryGate(p) {
  const key = `${p.sport}|${p.stat || p.gameType}`;
  // mlb|strikeouts DEMOTED 2026-06-19: formula-clean in-gate [80,85) bet set (since 6/13) was n=5,
  // ROI −13%, overconfident (pred 82.5 → won 60); Brier skill −0.007 (market sharper). With the 3 wnba
  // gates also paused, the gate is now EMPTY — nothing currently beats the market on formula-clean data.
  // NOTE: this is a GATE change, not a formula change — the K_FORM_SIGMA freeze (don't touch the K
  // formula until ~6/26, see [[project-strikeouts-formula-freeze]]) still holds; shadow data keeps
  // accruing. Re-enable only after tune:gate confirms a coherent +ROI band at n≥50 + non-neg Brier.
  // if (key === 'mlb|strikeouts') return (p.truePct ?? 0) >= 80 && (p.truePct ?? 0) < 85;
  // wnba|points PAUSED 2026-06-19: formula-clean validation (since 5/28) found the gate is mis-placed —
  // the [70,80) band caught only n=3 (33% hit, −36% ROI) while the profitable plays sit at [80,85)
  // (n=10, 90% hit, +14%) ABOVE the cap and were being EXCLUDED. Model is underconfident (+17.5), so
  // its high-truePct picks over-deliver. Do NOT re-enable until tune:gate confirms the right band at
  // n≥50 + coherence (likely [80,85)). See memory [[project-live-gate-validation-2026-06-19]].
  // if (key === 'wnba|points')    return (p.truePct ?? 0) >= 70 && (p.truePct ?? 0) < 80;
  // wnba|rebounds PAUSED 2026-06-19: formula-clean validation (since 5/28) — gate mis-placed + weak.
  // The [70,85) band caught only n=1; the actual bet plays land at 85-90 (n=13, ABOVE the cap) and
  // are only ~breakeven (ROI −0.003), with Brier skill −0.028 @ n=96 (market sharper). No coherent
  // +ROI band exists. Re-enable only after tune:gate confirms a band at n≥50 + coherence.
  // if (key === 'wnba|rebounds')  return (p.truePct ?? 0) >= 70 && (p.truePct ?? 0) < 85;
  // wnba|spread PAUSED 2026-06-19: formula-clean validation (since 5/28) — bet set n=15 hit 20% / ROI
  // −15.5% while the model claimed +13.8% avg edge (severe overconfidence), and unfiltered Brier
  // skill −0.032 @ n=237 confirms the market is much sharper on the FULL distribution (not small-n).
  // Unlike points there's no profitable band to move to. The 6/11 promotion (~+11% @ n=39) was on
  // pre-formula-clean data. Re-enable only after tune:gate shows a coherent +ROI band at n≥50.
  // if (key === 'wnba|spread')    return (p.truePct ?? 0) >= 65 && (p.truePct ?? 0) < 85;
  // mlb|hrr NO-side PULLED 2026-07-18 (was provisional 2026-07-11): the parse loop never fed
  // noKalshiPct until 2026-07-17, so the [63,73) band + [24,33] window rested entirely on
  // YES-ask complements (the exact synthesized-NO pricing the UNDER-pricing doctrine forbids)
  // with ZERO real NO-side captures behind them. Shadow capture is gate-independent and keeps
  // accruing; re-enable only after tune:gate confirms +ROI at n≥50 on real post-7/17 NO-quote
  // rows (~1 week at current volume). See memory project-hrr-no-side-flip.
  // if (key === "mlb|hrr") return p.direction === "under" && (p.truePct ?? 0) >= 63 && (p.truePct ?? 0) < 73;
  return false;
}
