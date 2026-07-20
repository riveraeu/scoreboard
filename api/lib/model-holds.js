// Model-improvement HOLDS — the dated "already diagnosed, parked" maps shared by the /model
// page's Do-this banner (src/components/ReportPage.jsx) AND the shadow-report daily brief
// (api/lib/handlers/shadow.js), so the brief can never re-nag a diagnostic the banner knows is
// done. Same sanctioned frontend←api/lib import pattern as config.js / series-config.js /
// category-gate.js. Keep this module dependency-free (imported by the Vite bundle).
//
// MARKET_SHARPER / miscalibrated categories whose L0 input search is EXHAUSTED — tune:residual
// found no addable in-data dimension and the historical pre-filters (weather→runs, WNBA travel)
// failed (see memories project-residual-sweep / project-weather-runs-study /
// project-wnba-travel-study). The daily "Improve inputs" / "Diagnose then stop" nags are
// suppressed for these; the rows STILL appear on the accuracy board and in the brief's model
// state, phrased as parked. Value = the date the search was exhausted. A category
// auto-UN-suppresses when its FORMULA_CUTOFF (stamped on both board rows) moves past that date —
// a formula change re-accrues clean data, which re-opens the search with zero manual bookkeeping.
// Still REMOVE a key by hand the moment a NEW exogenous input HYPOTHESIS appears for it
// (something fresh to pre-filter, e.g. the dated x* re-open checkpoint in SCHEDULED_CHECKPOINTS);
// a stale key is harmless (it only matters while still market-sharper).
export const INPUT_SEARCH_EXHAUSTED = {
  "mlb|f5spread": "2026-06-23", "mlb|ml": "2026-06-23", "mlb|totalRuns": "2026-06-23",
  "mlb|strikeouts": "2026-07-20", "mlb|f5total": "2026-06-23", "mlb|spread": "2026-06-23",
  "mlb|hits": "2026-06-23",
  "wnba|points": "2026-06-23", "wnba|totalPoints": "2026-06-23", "wnba|rebounds": "2026-06-23",
  "mlb|teamRuns": "2026-06-29",
  "tennis|match": "2026-07-19",
  "mlb|outs": "2026-07-11",
  "mlb|f5ml": "2026-07-14",
  "mlb|hrr": "2026-07-19",
};
// mlb|teamRuns added 2026-06-29 after the MARKET_SHARPER banner prompted its tune:residual run:
// overall skill −0.002 (market sharper near-tie, n≈261); NO sub-trust sub-slice (faint +skill only at
// 70-80¢, n=32-69, below the n≥100 Brier floor; the 80-95¢ tail where totalBases shines is empty),
// and NO addable L0 input (edge anti-predictive, dayOfWeek noise, x* dims too thin to read yet).
// Same run-market posture as the others → re-check on the ~07-10 liquidity (x*) sweep.
// tennis|match added 2026-07-01 after the Accuracy banner prompted its tune:residual run: overall
// skill −0.068 (market sharper, n=133); underconfident on favorites (betPrice 70-95¢ resid +12→+41pp)
// but every real-n bucket has NEGATIVE skill (the market prices those favorites sharper — not edge),
// edge anti-predictive, xVolume/dayOfWeek no +skill slice, pickSide degenerate (all "home"). NO
// sliceable in-data input: the gap is intrinsic to a rankings-only model (no surface/form/H2H/fatigue),
// which is the Phase-2 surface-Elo BUILD on the tennis roadmap, not an L0 pre-filter. [[project-tennis-phase1]]
// RE-DATED 2026-07-19: the 7/01 run used labels corrupted by the resolver wide-window bug (fixed +
// backfilled 2026-07-19 — see memory project_tennis_resolver_wide_window_bug). tune:residual re-run
// on regraded labels reaches the SAME verdict, stronger: skill −0.045 (n=326), every real-n miss
// bucket market-priced, edge≥15 severely overconfident (resid −31.7pp, skill −0.098). No in-data
// input; surface-Elo build remains the only path.
// mlb|outs added 2026-07-11 after the MARKET_SHARPER banner prompted its tune:residual run: overall
// skill −0.041 (market sharper, n=217, mean resid +15.8pp — underconfident on favorites, steepest at
// rungs 17–19, resid +22→+32pp) but every real-n bucket with the miss has NEGATIVE skill — the market
// already prices the deep-rung favorites. Near-parity pockets only (threshold=16 +0.006 n=51,
// xVolume>906 +0.004 n=52); betPrice +skill buckets all n≤6; dayOfWeek noise. No addable in-data L0
// input — the missing information (manager leash / pitch-count news, pitcher-specific OBP-against)
// isn't in the logged dims. Same market-has-more-information posture as the run markets.
// mlb|f5ml added 2026-07-14 after the MARKET_SHARPER banner prompted its tune:residual run on the
// de-biased rank-1 population (post rank-group backfill, n=339): overall skill −0.0002 (near-parity,
// market sharper). The only +skill pocket at real n is betPrice 50-55¢ (+0.0241, n=74) — the SAME
// pocket the 7/13 tune:window NO-GO adjudicated as a price artifact (adjacent bands flip negative,
// n<100 Brier floor). Edge 15+ overconfidence (resid −14.3pp) is market-priced (skill −0.0278);
// xVolume≤214 / pickSide=home / lineup-unconfirmed misses all carry negative skill; dayOfWeek noise;
// xWindOutMph pockets below the n≥30 bucket floor (weather→runs pre-filter failed 6/23 anyway). No
// addable in-data L0 input. The 2026-08-08 SCHEDULED_CHECKPOINTS tune:window re-check stays —
// window derivation on clean accrual is a separate question from the input search.
// mlb|hrr added 2026-07-19, same day its FORMULA_CUTOFF moved to 2026-06-30 (pre-liquidity-gate
// dead-book YES≥80¢ rows had faked the entire +0.05 Brier skill — see memory
// project_hrr_hits_skill_artifact): tune:residual on the clean since-6/30 window (n=251) reports
// skill −0.0078 (market sharper near-tie) and NO addable input — every steep-gradient miss bucket
// (xWindOutMph>6.2, xTempF, dayOfWeek, edge≥3 overconfidence) carries NEGATIVE skill (market-priced);
// no +skill pocket at real n. The NO-side flip validation (tune:gate n≥50 on post-7/17 real NO
// quotes) is a separate market-mispricing question and proceeds regardless. NOTE: the same 6/30
// cutoff intentionally auto-UN-suppresses mlb|hits' 2026-06-23 entry above (artifact-clean data
// re-opens its input search once it clears the n≥100 Brier floor); its WINDOW_SEARCH_EXHAUSTED
// entry (2026-07-01) postdates the cutoff and stays suppressed.

// mlb|strikeouts RE-DATED 2026-07-20: the 7/06 K-blend capWeight ship (0.5→0.4) moved its
// FORMULA_CUTOFF past the old 6/23 exhaustion date, auto-re-opening the search on clean
// post-ship data. tune:residual re-run (since=7/06, n=218): overall skill −0.0229 (model
// Brier 0.2468 vs market 0.2239 — market sharper), mean residual +4.7pp (underconfident
// overall). Ran --all-features to also screen the xFlow* taker-flow candidates: steep
// gradients on xFlowAvgSize (32.5pp), xFlowLargeShare (20.4pp), xFlowContracts (18.5pp),
// xFlowTrades (16.5pp) — but EVERY bucket across ALL four flow dims carries NEGATIVE skill,
// so the residual they explain is one the market already prices (unsurprising: taker flow
// is itself market-derived). betPrice/edge/threshold/dayOfWeek/xLineupConfirmed all show the
// same pattern — real gradients, no positive-skill bucket at trustworthy n (the only two
// near-zero positives, betPrice 40-45¢ +0.0001 and edge 0-3 +0.0009, are both noise-floor,
// not real skill; one is even below the n≥30 bucket floor). No addable in-data L0 input.
// Same "market has more information" posture as mlb|outs/tennis|match — whatever closes this
// gap (live scratches, umpire zone tendencies intraday, bullpen usage news) isn't in the
// logged dims. Don't re-run without a fresh exogenous hypothesis or another formula ship.

// Categories already run through tune:window to a TERMINAL no-go (the discovered window doesn't
// hold out-of-sample), so the tier-3.15 derive-a-window nag stops — mirrors INPUT_SEARCH_EXHAUSTED,
// including the auto-UN-suppress: a FORMULA_CUTOFF newer than the exhaustion date re-accrues the
// category clean and re-opens the search (via stillExhausted). A NON-terminal no-go (OOS split
// merely too thin) does NOT belong here — give it a dated SCHEDULED_CHECKPOINTS entry to re-run
// once OOS n accrues instead of either nagging daily or being forgotten.
export const WINDOW_SEARCH_EXHAUSTED = {
  "mlb|hits": "2026-07-01", // tune:window: Brier-eligible (skill +0.053) but the discovered [60,70]
  //            window fails in-sample CI (−7%) AND out-of-sample (−4.3%) — model skill ≠ a profitable
  //            price window. Auto-re-opens on a new mlb|hits FORMULA_CUTOFF. [[project_bet_window_derivation]]
};

// Exhausted-until-formula-reset test shared by both maps: suppressed while the key is present AND
// no FORMULA_CUTOFF newer than the exhaustion date exists (dates are YYYY-MM-DD strings, so
// lexicographic > is date >). No cutoff known (null/undefined) = nothing changed = stay suppressed.
export const stillExhausted = (map, key, formulaCutoff) =>
  map[key] != null && !(formulaCutoff && formulaCutoff > map[key]);
