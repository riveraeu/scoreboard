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
  "mlb|strikeouts": "2026-06-23", "mlb|f5total": "2026-06-23", "mlb|spread": "2026-06-23",
  "mlb|hits": "2026-06-23",
  "wnba|points": "2026-06-23", "wnba|totalPoints": "2026-06-23", "wnba|rebounds": "2026-06-23",
  "mlb|teamRuns": "2026-06-29",
  "tennis|match": "2026-07-01",
  "mlb|outs": "2026-07-11",
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
// mlb|outs added 2026-07-11 after the MARKET_SHARPER banner prompted its tune:residual run: overall
// skill −0.041 (market sharper, n=217, mean resid +15.8pp — underconfident on favorites, steepest at
// rungs 17–19, resid +22→+32pp) but every real-n bucket with the miss has NEGATIVE skill — the market
// already prices the deep-rung favorites. Near-parity pockets only (threshold=16 +0.006 n=51,
// xVolume>906 +0.004 n=52); betPrice +skill buckets all n≤6; dayOfWeek noise. No addable in-data L0
// input — the missing information (manager leash / pitch-count news, pitcher-specific OBP-against)
// isn't in the logged dims. Same market-has-more-information posture as the run markets.

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
