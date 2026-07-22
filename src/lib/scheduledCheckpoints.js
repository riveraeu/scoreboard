// Dated re-check list — used by MakerBoardPage.jsx for both DoThisBanner's tier-4 candidate +
// quiet-day "next clock" floor, and MakerProgress's "next clock" tile. Originally extracted
// 2026-07-21 when MakerProgress moved out of ReportPage.jsx to its own page (both referenced the
// same list); DoThisBanner itself moved into MakerBoardPage.jsx 2026-07-22 when ReportPage/the
// /model route was deprecated.
//
// Each entry surfaces as a tier-4 banner candidate once todayPT >= date and keeps surfacing
// until handled; REMOVE (or re-date, if the window is extended) its entry when the check is
// done. The quiet-day floor names the NEXT upcoming entry so a calm day still shows when the
// ladder wakes up next.
export const SCHEDULED_CHECKPOINTS = [
  // (Polymarket 1b kill-gate checkpoint REMOVED 2026-07-04 — reviewed 3 days early on unambiguous
  // clean data: exec.fracEdgeGe3c = 0 post-date-fix, Phase 1b KILLED. [[project-polymarket-phase1a]])
  // (x* run-market sweep REMOVED 2026-07-08 — decision: ACCEPT market-sharper status on run markets.
  // Market beats us because it has more information (sharp flow, real-time news), not because our
  // inputs are wrong. Removing/adding inputs won't create edge that isn't in public data. Categories
  // stay parked in INPUT_SEARCH_EXHAUSTED indefinitely. [[project-exogenous-feature-stamp]])
  // (KXLMBGAME liquidity recheck REMOVED 2026-07-15 — checked on its date: game-day books now
  // REAL (~600-contract volume, multi-level depth, 1–18¢ spreads) → un-dismissed and SHIPPED
  // the Pythag-λ model (api/lib/lmb.js + tonight/lmb-ml.js, `lmb|ml` shadow-only).
  // [[project-lmbgame-vet]])
  // KXMILBGAME vetted + dismissed-with-recheck 2026-07-15: model end green (statsapi sportIds
  // 11-14, LMB playbook at ~6x volume), Kalshi end a ZERO-market shell — nothing to vet or
  // build against. Same wait shape as the LMB recheck (which converted on its date).
  { date: "2026-07-29", tone: "gray", label: "Re-check KXMILBGAME listings", short: "KXMILBGAME recheck",
    why: "Dismissed 7/15 as a zero-market shell with the model side green (statsapi covers all 4 levels, ~62 games/day) — if markets now list with real game-day books (asks populated, spread ≤15¢), un-dismiss and build the LMB-playbook λ model (parameterize lmb.js + author the registry from the live tickers)" },
  // K blend capWeight 0.5→0.4 shipped 2026-07-06 (tune:kblend GO); the held-out curve kept
  // improving below 0.4 but 0.4 was the train-picked winner — re-run on fresh post-cutoff rows
  // (~10 rank-1/day → n≈200 by here) before walking it lower. [[project_k_blend_counterfactual]]
  { date: "2026-07-27", tone: "blue", label: "Re-run tune:kblend (walk K capWeight below 0.4?)", short: "tune:kblend recheck",
    why: "capWeight 0.5→0.4 shipped 7/06 off the counterfactual GO; held-out Brier kept improving toward cap=0 but selecting below the train-picked 0.4 would have been test-peeking — re-run tune:kblend on post-7/06 rows (baseline now 0.4) at n≥200" },
  // 7/05 cross-category sweep: hits showed the K-shaped lower-cap curve but NO-GO (+1.13m, CI
  // straddles) AND the effect flipped sign across the 7/03 capture-all seam — the post-seam row
  // mix (full-curve longshots) may change the answer. ~26 rank-any rows/day → ~950 post-seam
  // rows by here; run post-seam-only. [[project_k_blend_counterfactual]]
  { date: "2026-08-10", tone: "blue", label: "Re-run tune:kblend --category mlb|hits (post-seam only)", short: "kblend hits recheck",
    why: "7/05 sweep: K-shaped curve but NO-GO and seam-unstable (pre +2.97m / post −0.99m) — re-run with --since 2026-07-03 so the capture-all row mix answers for itself (~950 post-seam rank-any rows by now)" },
  // wnba|points showed the same K-shaped curve, underpowered (+2.01m, CI ±5m at test n=119);
  // ~10 rank-any rows/day. Same sitting as the hits recheck. [[project_k_blend_counterfactual]]
  { date: "2026-08-10", tone: "blue", label: "Re-run tune:kblend --category wnba|points", short: "kblend wnba recheck",
    why: "7/05 sweep: K-shaped lower-cap curve, NO-GO on power only (train pick 0.3, +2.01m, CI [−3.13,+7.46]) — re-run at ~750 total rows; if CI-lo>0, propose the WNBA capWeight cut same as K" },
  // mlb|f5ml is the only game market that's Brier-sharper than the price (7/11: skill +0.0124 n=109,
  // trend rising) with a coherent discovered [40,55]¢ window (ROI +24.2%, CI-lo +8.1%) — blocked only
  // on power (32/50 in-window bets; ~1.1/day + All-Star break ~7/13–16). NOT in the 7/04 sub-55
  // NO-GO sweep. If GO: shipping needs the non-prop build step too — the F5 ML emit path uses the
  // global [67,91] inline, so route it through betWindowFor before a CATEGORY_BET_WINDOWS entry can
  // take effect (config.js comment; the [40,55] shape is already pinned in config.test.js).
  { date: "2026-08-08", tone: "blue", label: "Run tune:window --category mlb|f5ml (window [40,55] candidate)", short: "f5ml window check",
    why: "7/11: STRENGTHENING + Brier-eligible, discovered [40,55]¢ ROI +24.2% CI-lo>0 coherent, short only 32/50 in-window bets — re-run at n≥200 resolved (~Aug 8 after the All-Star break); a GO also needs the F5 ML emit routed through betWindowFor (non-prop paths are inline-global today)" },
  // mlb|hrr NO-side gate PULLED 2026-07-18: the 7/11 provisional band [63,73) was derived on
  // synthesized YES-complement NO prices (feed dead 7/11–7/17, zero real captures). Shadow
  // capture continues; ~10–15 in-band rows/day → n≥50 ~7/25. [[project_hrr_no_side_flip]]
  { date: "2026-07-25", tone: "blue", label: "Re-run tune:gate on mlb|hrr NO-side (real post-7/17 captures)", short: "hrr NO re-gate check",
    why: "Gate pulled 7/18 — the 7/11 provisional +8.8% ROI band rested on synthesized complements with zero real NO-quote rows; re-gate only if tune:gate shows +ROI at n≥50 on post-7/17 captures with band coherence (window [24,33] still capturing throughout)" },
];
