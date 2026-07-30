// api/lib/handlers/shadow/report.js
// GET /api/shadow-report — the shadow morning report (accuracy board, betting board, maker boards,
// daily brief). Extracted verbatim from handlers/shadow.js during the handler split (zero behavior
// change). Shares the schema consts + resolution high-water-mark helpers via ./common.js.

import { neonQuery } from "../../neon.js";
import { errorResponse, jsonResponse } from "../../utils.js";
import { verifyJWT } from "../../auth-utils.js";
import { detectAndGradeMakerFills, gradeMakerFills } from "../../maker.js";
import { isArmed as isMakerV2Armed } from "../../maker-live.js";
import { fetchKalshiSettlements, resolveTickerSideViaKalshi } from "../../kalshi-settlement.js";
import { weightedPnlSumsSql, weightedPnlFromRow, dayClusteredPnl, quotedOutcomesByBand,
  adverseSelectionWithinBand, leadTimeBuckets, spearmanEdgeVsLead, mixAdjustedNearFarByDay,
  dayLevelDiffCI, leadTimeVerdict, exitCounterfactual } from "../../maker-stats.js";
import { KALSHI_GATE, KALSHI_CAP, EDGE_GATE_SERVER, AWAITING_VALIDATED_EDGE } from "../../config.js";
import { passesCategoryGate } from "../../category-gate.js";
import { INPUT_SEARCH_EXHAUSTED, stillExhausted } from "../../model-holds.js";
import {
  MIN_N_PROMOTE as _MIN_N_PROMOTE,
  priceWindowBins as _priceWindowBins,
  discoverPriceWindow as _discoverPriceWindow,
  windowQuality as _windowQuality,
} from "../../price-window.js";
import { POLY_DELTAS_TABLE, SB_DELTAS_TABLE, _readResolutionRobust } from "./common.js";

// Maker ask-price band buckets, as a SQL CASE over any ask column. ONE definition (2026-07-26) —
// previously copy-pasted per query, and the quoted-vs-filled comparison is only meaningful if both
// sides bucket identically, so a third copy was the wrong way to add one. `col` is a trusted
// identifier from call sites in this file, never user input.
// EVERY maker board query filters `source = 'live'` (2026-07-28). `maker_quotes` now also holds
// replayed segments (api/lib/maker-backfill.js), and the board's day-clustered CI is the arm gate —
// letting an unvalidated replay leak into it would arm real money on reconstructed data. Found the
// hard way: the first 2026-07-24 validation run put 9,299 replayed segments and 2,073 fills into a
// board that had no source filter at all. Phase 2 widens this deliberately, per day, or not at all.
// 5¢ buckets across the FULL price range. Extended below 55 on 2026-07-29 when the V1 paper
// engine began quoting the underdog side too (MAKER_FULL_BAND) — before that, favorite-only
// quoting meant nothing landed under ~50, so the sub-55 buckets were dead. `< 5` is the floor
// (a 1¢ book side quotes at 0 and is dropped, so 0-4 mostly holds the low single-digit asks).
const _makerBandCase = (col) => `CASE
  WHEN ${col} < 5 THEN '0-4' WHEN ${col} < 10 THEN '5-9'
  WHEN ${col} < 15 THEN '10-14' WHEN ${col} < 20 THEN '15-19'
  WHEN ${col} < 25 THEN '20-24' WHEN ${col} < 30 THEN '25-29'
  WHEN ${col} < 35 THEN '30-34' WHEN ${col} < 40 THEN '35-39'
  WHEN ${col} < 45 THEN '40-44' WHEN ${col} < 50 THEN '45-49'
  WHEN ${col} < 55 THEN '50-54' WHEN ${col} < 60 THEN '55-59'
  WHEN ${col} < 65 THEN '60-64' WHEN ${col} < 70 THEN '65-69'
  WHEN ${col} < 75 THEN '70-74' WHEN ${col} < 80 THEN '75-79'
  WHEN ${col} < 85 THEN '80-84' WHEN ${col} < 90 THEN '85-89' ELSE '90-96' END`;

const REPORT_CACHE_KEY_PREFIX = "shadow:report:";
const REPORT_TTL = 60 * 60 * 25; // 25 hours
// Short TTL when yesterday's resolution is meaningfully incomplete (<90% resolved).
// Without this, a pre-7am-resolver refresh freezes a partial "3/487 resolved" snapshot
// into the full-day cache; the 0.9 threshold ignores a few permanently-stuck noData rows.
const INCOMPLETE_REPORT_TTL = 60 * 15; // 15 minutes

// Mirror passesCategoryGate() from api/lib/category-gate.js — kept in sync manually.
// Whether a category key (`sport|stat-or-gameType`) is currently in the live truePct gate.
// Derived from passesCategoryGate (the single source of truth in category-gate.js) by probing the
// truePct axis — NOT a hardcoded list, which drifted out of sync when gates were paused/demoted
// 2026-06-19 (the report kept showing demoted cats as live). Returns true if ANY truePct is gated.
function _isGatedCategory(key) {
  const [sport, cat] = key.split("|");
  // Probe with and without direction:'under' — direction-conditional gates (mlb|hrr NO-side,
  // 2026-07-11) never match a direction-less probe, which read the live gate as empty.
  for (let tp = 1; tp < 100; tp++) {
    if (passesCategoryGate({ sport, stat: cat, truePct: tp })) return true;
    if (passesCategoryGate({ sport, stat: cat, truePct: tp, direction: "under" })) return true;
  }
  return false;
}
// SQL fragment that mirrors passesCategoryGate() for use in the top-picks query — kept in
// sync manually; update BOTH when the gate changes (this list drifted 6/19→7/13, surfacing
// demoted categories and missing hrr). passesCategoryGate() keys on p.truePct (always the
// YES/over-side probability), NOT the bet side; the stored model_true_pct IS the bet side,
// so direction='under' rows reconstruct truePct as 100 - model_true_pct (hrr NO-side flips
// a YES-framed prob; spread cover probs are complementary — same arithmetic either way).
const _CATEGORY_GATE_SQL = `(FALSE)`; // gate EMPTY 2026-07-18 (mlb|hrr NO-side pulled — zero
// real NO-quote captures behind the 7/11 provisional band; see category-gate.js). When a
// category is re-gated, restore its clause here, e.g. hrr NO-side was:
//   (sport='mlb' AND stat='hrr' AND direction='under' AND
//      (100 - model_true_pct) >= 63 AND (100 - model_true_pct) < 73)
const _BAND_MID = { "55-60":57.5,"60-65":62.5,"65-70":67.5,"70-75":72.5,"75-80":77.5,"80-85":82.5,"85-90":87.5,"90-95":92.5,"95+":97.5 };
const _BAND_ORDER = Object.keys(_BAND_MID); // low → high, for adjacency/coherence

// Per-category current-formula cutoffs — calibration before these dates was produced by a
// SUPERSEDED formula and must not be mixed in (the #1 analysis trap, docs/MODEL_IMPROVEMENT.md).
// Keyed by `${sport}|${COALESCE(stat,game_type)}`. Keep in sync with MEMORY.md "Model changes".
// Only cutoffs within the trailing window actually trim; older ones are harmless.
const FORMULA_CUTOFFS = {
  "mlb|strikeouts": "2026-07-06", // blend capWeight 0.5→0.4 (tune:kblend); prior: K_FORM_SIGMA 0.26 @ 2026-06-13
  "mlb|hrr":        "2026-06-30", // capture liquidity gate — pre-gate dead-book YES≥80 rows faked all Brier skill (was 2026-06-22: FIP-over-WHIP split + weather)
  "mlb|hits":       "2026-06-30", // capture liquidity gate — same artifact class as hrr/totalBases (was 2026-06-12: ticker fix)
  "mlb|totalBases": "2026-06-30", // capture liquidity gate (2b67064) — pre-fix rows contaminated by lone-quote 94¢ artifacts (was 2026-06-12)
  "mlb|outs":       "2026-06-23", // pitcher outs-recorded O/U Phase 1 — data starts here
  "mlb|totalRuns":  "2026-06-01", // totalRuns market-line anchor
  "mlb|teamRuns":   "2026-05-27", // MLB teamTotal regime blend
  "nhl|totalGoals": "2026-05-29", // NHL NegBin + spread dampener
  "nhl|spread":     "2026-05-29",
  "nhl|ml":         "2026-05-29",
  "tennis|match":   "2026-06-13",
  "soccer|game":      "2026-06-21", // WC Phase 1 — Elo→λ→DC-Poisson matrix, data starts here
  "soccer|total":     "2026-06-21",
  "soccer|teamTotal": "2026-06-21",
  "soccer|spread":    "2026-06-21",
  "soccer|btts":      "2026-06-21",
  "soccer|1hgame":  "2026-06-21", // WC half markets — half-scaled matrix, data starts here
  "soccer|1htotal": "2026-06-21",
  "soccer|1hspread":"2026-06-21",
  "soccer|1hbtts":  "2026-06-21",
  "soccer|2hgame":  "2026-06-21",
  "soccer|2htotal": "2026-06-21",
  "soccer|2hspread":"2026-06-21",
  "soccer|2hbtts":  "2026-06-21",
  "soccer|advance": "2026-06-25", // WC knockout to-advance — Elo matrix + ET/pens draw allocation
  "fight|rounds":   "2026-06-21", // UFC Phase 1 — weight-class finish-rate → duration CDF
  "golf|h2h":       "2026-06-21", // PGA Phase 1 — OWGR rating → one-round score differential
  "nascar|h2h":     "2026-06-22", // NASCAR Cup Phase 1 — recent-form finishing-position model
  "nascar|top10":   "2026-06-22",
  "nbasl|ml":       "2026-07-13", // NBA Summer League Phase 1 — within-tournament Elo, data starts here
  "lmb|ml":         "2026-07-15", // LMB Phase 1 — standings run-rate λ → NegBin joint, data starts here
  "wnba|points":    "2026-05-28", // injury OffRtg piecewise (last broad λ change)
  "wnba|rebounds":  "2026-05-28",
  "wnba|assists":   "2026-05-28",
  "wnba|spread":    "2026-05-28",
  // B2B one-sided→transfer (2026-06-22): only the TOTAL axis changed (margin preserved → ML/spread
  // un-cutoff). NBA is offseason (forward-only Oct); WNBA accrues now.
  "nba|total":      "2026-06-22",
  "nba|teamTotal":  "2026-06-22",
  "wnba|total":     "2026-06-22",
  "wnba|teamTotal": "2026-06-22",
  // Game-row capture liquidity gate (2026-07-11) — pre-fix rows for in-play-only segment
  // markets are dead-book quote garbage (both-side ~95¢ asks logged as fake favorites;
  // f3/f7ml overround ~1.6, WNBA Q2-Q4/H2 up to ~1.9). f5 family + full-game categories
  // deliberately NOT bumped: their books were always real, so their history is clean.
  "mlb|f3ml":       "2026-07-11",
  "mlb|f7ml":       "2026-07-11",
  "wnba|q1total":   "2026-07-11", "wnba|q1spread": "2026-07-11", "wnba|q1ml": "2026-07-11",
  "wnba|q2total":   "2026-07-11", "wnba|q2spread": "2026-07-11", "wnba|q2ml": "2026-07-11",
  "wnba|q3total":   "2026-07-11", "wnba|q3spread": "2026-07-11", "wnba|q3ml": "2026-07-11",
  "wnba|q4total":   "2026-07-11", "wnba|q4spread": "2026-07-11", "wnba|q4ml": "2026-07-11",
  "wnba|h1total":   "2026-07-11", "wnba|h1spread": "2026-07-11", "wnba|h1ml": "2026-07-11",
  "wnba|h2total":   "2026-07-11", "wnba|h2spread": "2026-07-11", "wnba|h2ml": "2026-07-11",
  "nba|h1total":    "2026-07-11", "nba|h1spread":  "2026-07-11", "nba|h1ml":  "2026-07-11",
  "nba|h2total":    "2026-07-11", "nba|h2spread":  "2026-07-11", "nba|h2ml":  "2026-07-11",
};

// SQL: GREATEST(30d-floor, per-category formula cutoff) so each category's window is
// current-formula only. Category key mirrors the queries' COALESCE(stat, game_type).
function _formulaFloorSql(paramRef = "$1") {
  const whens = Object.entries(FORMULA_CUTOFFS).map(([key, date]) => {
    const [sport, cat] = key.split("|");
    return `WHEN sport='${sport}' AND COALESCE(stat, game_type)='${cat}' THEN '${date}'`;
  }).join("\n          ");
  return `GREATEST(${paramRef}::date, (CASE\n          ${whens}\n          ELSE '2000-01-01' END)::date)`;
}

// Significance verdict from a hit rate + sample. SE on the proportion = √(p(1−p)/n).
// kind='gate' → display-toggle bar (n≥50). kind='band' → formula bar (n≥200 + |Δ|>2·SE).
function _calibSig({ n, hitRate, predicted, kind }) {
  if (!n || hitRate == null) return { se: null, ci95: null, verdict: "too_few" };
  const p = Math.max(0, Math.min(1, hitRate / 100));
  const se = Math.sqrt(p * (1 - p) / n) * 100; // percentage points
  const ci95 = [parseFloat((hitRate - 1.96 * se).toFixed(1)), parseFloat((hitRate + 1.96 * se).toFixed(1))];
  let verdict;
  if (kind === "gate") {
    verdict = n >= 50 ? "gate_ready" : "building";
  } else {
    const delta = predicted != null ? hitRate - predicted : null;
    if (n < 200) verdict = "needs_n200";
    else if (delta != null && Math.abs(delta) > 2 * se) verdict = "actionable";
    else verdict = "within_noise";
  }
  return { se: parseFloat(se.toFixed(2)), ci95, verdict };
}

// Coherence: a same-direction miss across ≥3 adjacent bands pools n and is trustworthy
// sooner than one isolated band. Mutates each band row in-place, setting `coherent`.
function _markBandCoherence(bands) {
  const byCat = {};
  for (const b of bands) (byCat[`${b.sport}|${b.category}`] ??= []).push(b);
  for (const arr of Object.values(byCat)) {
    arr.sort((a, b) => _BAND_ORDER.indexOf(a.band) - _BAND_ORDER.indexOf(b.band));
    let runStart = 0;
    for (let i = 1; i <= arr.length; i++) {
      const adjacent = i < arr.length
        && _BAND_ORDER.indexOf(arr[i].band) === _BAND_ORDER.indexOf(arr[i - 1].band) + 1
        && Math.sign(arr[i].delta ?? 0) === Math.sign(arr[i - 1].delta ?? 0)
        && (arr[i].delta ?? 0) !== 0;
      if (!adjacent) {
        if (i - runStart >= 3) for (let j = runStart; j < i; j++) arr[j].coherent = true;
        runStart = i;
      }
    }
  }
}

// Per-category calibration summary from the band rows (the model-honesty axis). Picks the most
// significant ACTIONABLE band (proven over/under-confident) as the headline; falls back to a
// status of "honest" (some band has n≥200 and is within noise) or "insufficient" (not enough
// data to judge yet). direction: "over" = model too confident (Δ<0), "under" = too shy (Δ>0).
function _calibSummaryByCat(allBands) {
  const byCat = {};
  for (const b of allBands) (byCat[`${b.sport}|${b.category}`] ??= []).push(b);
  const out = {};
  for (const [key, arr] of Object.entries(byCat)) {
    const actionable = arr.filter(b => b.verdict === "actionable" && b.delta != null);
    let summary;
    if (actionable.length) {
      const top = actionable.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
      summary = { status: "actionable", direction: top.delta < 0 ? "over" : "under", delta: top.delta, band: top.band, n: top.n };
    } else if (arr.some(b => b.n >= 200)) {
      summary = { status: "honest", direction: null, delta: null, band: null, n: null };
    } else {
      summary = { status: "insufficient", direction: null, delta: null, band: null, n: null };
    }
    out[key] = summary;
  }
  return out;
}

// Fuse the profitability verdict + calibration signal + gate state into a single recommendation.
// The trap this guards: a model can be provably under-confident (Δ>0) AND still unprofitable (the
// market beats it) — de-shrinking would only bet more into a loss. So "underconfident" never maps
// to "tune up" unless there is actually a profitable window. Returns { action, tone, why }.
// Two-board split (2026-06-22): model ACCURACY (Layer 1) and BETTING (Layer 2 — price/ROI, gated by
// accuracy). Refocused 2026-06-23: Layer 1 now scores PURE accuracy vs reality (calibration: model%
// vs actual hit%, no price), not "beats the price". The price comparison (Brier skill) is kept as a
// secondary "vs market" signal and is what bridges to betting (eligible = skill CI lo > 0), computed
// directly from the Brier row — NOT from the accuracy verdict anymore.

// ── Layer 1: model ACCURACY (calibration vs reality) — no price, no gate ──────
// Scored on the truePct calibration summary (model% vs actual hit% per band). "actionable" already
// requires n≥200 or a coherent multi-band run, so CALIBRATED/miscalibrated stay conservative.
// |skillTrend| below this reads "flat"/saturated — mirror of the frontend _LEARN_FLAT.
const _LEARN_FLAT = 0.003;
function _accuracyVerdict(calib, brier, learning) {
  const c = calib || {};
  if (c.status === "actionable") return c.direction === "over" ? "OVERCONFIDENT" : "UNDERCONFIDENT";
  if (c.status === "honest")     return "CALIBRATED";   // some band hit n≥200 and lands within noise
  // Calibration insufficient — but "can't judge calibration yet" is NOT "no verdict possible". Two
  // Brier-skill outcomes are already TERMINAL and shouldn't hide behind a hopeful "BUILDING":
  //   • market TRUSTABLY sharper (skill<0 at n≥BRIER_MIN_N) AND not recovering (trend reliable + flat
  //     or falling) → MARKET_SHARPER: a settled negative — filling calibration bands can't rescue a
  //     model the price out-predicts; stop accruing. (A negative skill that's still RISING stays
  //     BUILDING — it may cross.)
  //   • model already beats the price (skill>0 at n≥BRIER_MIN_N) → PROMISING: near-eligible, just thin
  //     calibration — accrue toward eligibility, not "accruing from zero".
  // Everything else (skillN<BRIER_MIN_N, or skill≈0) is genuinely undecided → BUILDING.
  const skill = brier?.skill, skillN = brier?.n || 0;
  if (skill != null && skillN >= BRIER_MIN_N) {
    if (skill < 0 && learning?.reliable && learning.skillTrend != null && learning.skillTrend <= _LEARN_FLAT)
      return "MARKET_SHARPER";
    if (skill > 0) return "PROMISING";
  }
  return "BUILDING";
}
// `skill`/`skillN` = Brier skill (market−model) over the honesty population + its n. They fork the
// PRESCRIPTION for a miscalibrated category (not the verdict, which stays calibration-based) into THREE
// states, because "market out-predicts you" (the only justification for an L0 input hunt) requires the
// market's Brier to be TRUSTABLY better — a non-negative skill is the opposite of that:
//   • model sharper by sign (skill>0, any n) → the miss is pure SCALING → RECALIBRATE (L2 de-shrink).
//     A thin (skillN<BRIER_MIN_N) +skill is provisional — labeled so, and held off the daily banner
//     frontend-side until the n≥200 ripe-recalibrate bar (RECAL_MIN_N).
//   • market TRUSTABLY sharper (skill<0 AND skillN≥BRIER_MIN_N) → the model is missing a signal the
//     market prices → IMPROVE INPUTS (L0 new input, the only state that nags "run tune:residual").
//   • undecided (skill≈0, null, or a too-thin skill<0) → ACCRUING — don't claim the market is sharper
//     off a noisy Brier; no banner nag either way.
// (2026-06-24: the Recalibrate fork fixed mlb|totalBases/hits — underconfident AND beating the price —
// being told "find a new input." 2026-06-25: split out the thin/undecided cases so a model-sharper-but-
// thin category like wnba|threePointers (skill +0.045, n≈33) stops being mislabeled "needs a NEW input"
// just because its Brier n is below 100. See [[project-accuracy-recalibrate-fork]].)
function _accuracyAction(verdict, calib, skill, skillN) {
  const c = calib || { status: "insufficient" };
  const trusted       = (skillN || 0) >= BRIER_MIN_N;          // Brier reliable
  const beatsPrice    = skill != null && skill > 0;            // model sharper by SIGN (any n)
  const marketSharper = skill != null && skill < 0 && trusted; // market TRUSTABLY sharper
  const provNote      = trusted ? "" : ` (provisional, n<${BRIER_MIN_N})`;
  const deltaTxt = c.delta != null ? `${Math.abs(c.delta)}pts ` : "";
  switch (verdict) {
    case "CALIBRATED":
      return { action: "Calibrated", tone: "green",
        why: "model% matches actual outcomes within noise — well-calibrated to reality" };
    case "MARKET_SHARPER":
      // The market out-predicts the model and calibration won't rescue it — but "stop" isn't the
      // FIRST move: a globally-negative skill can still hide a sharp sub-slice (the totalBases
      // above-91¢ shape) or an unmodeled exogenous L0 input. So the next step is a ONE-TIME
      // diagnostic, not a blind stop. The frontend collapses this to "Stop — search exhausted" once
      // the category is in INPUT_SEARCH_EXHAUSTED (diagnostic already run, came up empty).
      return { action: "Diagnose then stop", tone: "red",
        why: `market out-predicts the model (negative Brier skill at n≥${BRIER_MIN_N}, trend not recovering) — calibration can't rescue it. Next: run tune:residual ONCE for a sharp sub-slice (price×threshold) or an unmodeled L0 input; if empty, park it and redirect effort to a less-efficient market` };
    case "PROMISING":
      return { action: "Promising — accrue", tone: "green",
        why: `model already beats the price (positive Brier skill at n≥${BRIER_MIN_N}) but calibration bands are still thin — accrue toward eligibility, not an input change` };
    case "OVERCONFIDENT":
      if (marketSharper)
        return { action: "Improve inputs", tone: "amber",
          why: `model is overconfident AND the market out-predicts it — says ${deltaTxt}more than it delivers in the ${c.band ?? ""}% band; needs a NEW input, run tune:residual` };
      if (beatsPrice)
        return { action: "Recalibrate", tone: "amber",
          why: `model beats the price${provNote} but over-claims (${deltaTxt}too high in the ${c.band ?? ""}% band) — scale down / de-shrink (L2 reweight), NOT a new input` };
      return { action: "Accruing", tone: "dim",
        why: `model over-claims (${deltaTxt}too high in the ${c.band ?? ""}% band) but model-vs-market is undecided at n<${BRIER_MIN_N} — accruing, not a new-input case yet` };
    case "UNDERCONFIDENT":
      if (marketSharper)
        return { action: "Improve inputs", tone: "amber",
          why: `model is underconfident AND the market out-predicts it — delivers ${deltaTxt}more than it claims in the ${c.band ?? ""}% band; needs a NEW input, run tune:residual` };
      if (beatsPrice)
        return { action: "Recalibrate", tone: "amber",
          why: `model beats the price${provNote} but under-claims (+${deltaTxt}in the ${c.band ?? ""}% band) — de-shrink / scale up (L2 reweight), NOT a new input` };
      return { action: "Accruing", tone: "dim",
        why: `model under-claims (+${deltaTxt}in the ${c.band ?? ""}% band) but model-vs-market is undecided at n<${BRIER_MIN_N} — accruing, not a new-input case yet` };
    default:
      return { action: "Accruing", tone: "dim", why: "not enough resolved plays to judge calibration yet" };
  }
}

// ── Layer 2: BETTING action (price/ROI), gated by Layer-1 eligibility ─────────
function _bettingAction(verdict, gated, eligible, hint) {
  if (!eligible)
    return { action: "Don't bet", tone: "dim",
      why: "model doesn't beat the price — no edge to bet regardless of window" };
  switch (verdict) {
    // NOT "Add to gate" (2026-07-27). Two distinct mechanisms were being conflated: this ladder
    // discovers a PRICE WINDOW (CATEGORY_BET_WINDOWS, owned by `tune:window`), whereas "the gate"
    // is passesCategoryGate (a truePct threshold, owned by `tune:gate`) — different bar, different
    // file. Worse, PROMOTE only clears an IN-SAMPLE screen at n≥MIN_N_PROMOTE (50); shipping a
    // window needs `tune:window` GO at n≥200 with an OUT-OF-SAMPLE CI-lo>0, precisely because the
    // discovered window is ROI-maximized over many candidate ranges and so is upward-biased.
    // Live example the same day: mlb|f3ml read PROMOTE here (in-sample 30–50¢, ROI +24.7%, CI-lo
    // +11.8%, n=52) while tune:window returned NO-GO — OOS CI-lo −1.8% and the window slid to
    // 45–60¢. So this verdict is a LEAD to verify, never an instruction to bet.
    case "PROMOTE":       return { action: "Verify with tune:window", tone: "green", why: "in-sample window screen passed (n≥50) — confirm out-of-sample before shipping a window; this is not the category gate" };
    case "HOLD":          return { action: "Keep betting", tone: "gray", why: "gated and still profitable" };
    // DEMOTE deliberately KEEPS gate language while PROMOTE lost it — the asymmetry is the point.
    // DEMOTE only fires when the category is already gated (real money on it), and pulling it from
    // passesCategoryGate is exactly how you stop betting. Acting on a weaker in-sample signal is
    // correct in the stop-risk direction and wrong in the take-risk one. Don't "fix" for symmetry.
    case "DEMOTE":        return { action: "Pull from gate", tone: "red", why: "window went significantly negative" };
    case "STRENGTHENING": return { action: "Build", tone: "blue", why: hint || "eligible + positive but window not yet validated — accruing" };
    case "NEGATIVE":
      // eligible ⇒ skillLoCI>0 already, so the old "Look deeper" guard is satisfied by construction:
      // a provably-sharper model that still loses the bettable window is a real selection/sizing puzzle.
      return gated
        ? { action: "Pull from gate", tone: "red", why: "eligible but no longer has a profitable window" }
        : { action: "Look deeper", tone: "blue", why: "model beats the price but the bettable window still loses — selection/sizing puzzle (Phase 2 residual slicer)" };
    default:              return { action: "Build", tone: "dim", why: "too few bettable plays yet — accruing" };
  }
}

// ── Price-band profitability (the Model board) ───────────────────────────────
// Price-window math (MIN_N_WINDOW/MIN_N_PROMOTE, priceWindowBins, discoverPriceWindow,
// windowQuality) lives in ../price-window.js — imported above, shared with the tune:window CLI.
// Brier skill (= marketBrier − modelBrier; >0 = model sharper than the price). No longer drives the
// accuracy verdict (that's calibration-based now) — it's the secondary "vs market" signal and the
// betting board's `eligible` gate: skill CI lo > 0 AND n ≥ BRIER_MIN_N. Only trusted above
// BRIER_MIN_N resolved plays (Brier is a mean of squared errors → lower variance than a tail
// hit-rate, but still noisy at small n, where the CI can read misleadingly positive).
const BRIER_MIN_N = 100; // min resolved n before Brier skill can gate betting eligibility

function _extractReportToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
  if (m?.[1]) return m[1];
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
}

// ── Daily brief — deterministic prose over the assembled report ───────────────
// The readable replacement for scanning the accuracy grid: every sentence is templated straight
// from numbers the report already computed (no free text, no model call), so the brief can never
// drift from the boards it summarizes. Sections (reader order, 2026-07-04 format): health (is the
// data trustworthy?) · headline · what changed vs yesterday (null when no prior exists — first run
// or a post-expiry mid-day regen) · model state (notable categories only, the rest collapsed to a
// count) · betting accrual clocks (eligible rows: in-window read + discovered window vs the promote
// bar) · pricing findings (both cross-venue observatories) · takeaway (the one-line "so what").
const _briefSkill = s => s == null ? "—" : `${s >= 0 ? "+" : ""}${Number(s).toFixed(3)}`;
const _briefRoi = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${(Number(v) * 100).toFixed(1)}%`;
const _briefVerdict = v => String(v || "").toLowerCase().replace(/_/g, " ");
function _buildDailyBrief(r, prior) {
  const acc = r.accuracyBoard || [];
  const bet = r.bettingBoard || [];
  const name = k => String(k || "").replace("|", " ");

  // Health — one sentence answering "can I trust the numbers below?" before showing any of them.
  // Mirrors dataHealth exactly: clean → the trust line; warned → the warnings verbatim (they're
  // already sentences); tone carries clean/caution/action so the client can color without re-deriving.
  const dh = r.dataHealth;
  let health = null;
  if (dh?.resolution?.total > 0) {
    if (dh.warnings?.length) {
      health = { tone: dh.actionable ? "action" : "caution", text: dh.warnings.join(" ") };
    } else {
      const res = dh.resolution;
      const clvTxt = dh.clvCapture?.pct != null ? `, ${dh.clvCapture.pct}% CLV capture` : "";
      health = {
        tone: "clean",
        text: `Pipeline health clean — ${res.ratePct}% of yesterday's plays resolved (${res.pending} pending, mostly next-day pre-listings)${clvTxt}, no coverage warning — the readings below are trustworthy.`,
      };
    }
  }

  // Headline — the one-sentence answer to "can we bet anything yet?".
  const eligibleRows = bet.filter(b => b.eligible);
  const gatedN = bet.filter(b => b.gated).length;
  const trusted = acc.filter(a => a.skill != null && (a.n || 0) >= BRIER_MIN_N);
  const best = trusted.slice().sort((a, b) => b.skill - a.skill)[0] || null;
  const headline = eligibleRows.length
    ? `${eligibleRows.length} categor${eligibleRows.length === 1 ? "y" : "ies"} provably beat${eligibleRows.length === 1 ? "s" : ""} the market (${eligibleRows.map(b => name(b.key)).join(", ")}); ${gatedN ? `${gatedN} in the live gate` : "the live gate is empty"}.`
    : `No category beats the market with confidence yet; the gate is ${gatedN ? `running ${gatedN}` : "empty"}.` +
      (best ? ` Closest: ${name(best.key)} at skill ${_briefSkill(best.skill)} (n=${best.n}).` : "");

  // Model state — one sentence per NOTABLE category (verdict beyond BUILDING); the categories
  // closest to bettable lead (PROMISING/CALIBRATED — the rows the headline names must appear here,
  // not get crowded out by the amber pile), then prescriptive actions, then by data weight.
  // Everything else collapses to a single count line.
  const model = [];
  // A row whose tune:residual diagnostic already ran empty (dated INPUT_SEARCH_EXHAUSTED, shared
  // with the Do-this banner via model-holds.js) must read as PARKED, not re-nag the diagnostic —
  // the brief and the banner have to agree on what's already been done. Auto-un-parks when a
  // FORMULA_CUTOFF postdates the exhaustion (stillExhausted), same as the banner.
  const _parked = a => (a.honest?.action === "Improve inputs" || a.honest?.action === "Diagnose then stop")
    && stillExhausted(INPUT_SEARCH_EXHAUSTED, a.key, a.formulaCutoff);
  const _parkedTxt = a => `parked — input search exhausted ${INPUT_SEARCH_EXHAUSTED[a.key]} (tune:residual found nothing addable); re-opens on a formula reset or its scheduled checkpoint`;
  const _verdictRank = { PROMISING: 0, CALIBRATED: 0 };
  const _actRank = { "Diagnose then stop": 1, "Improve inputs": 2, "Recalibrate": 3 };
  const _rank = a => _verdictRank[a.verdict] ?? (_parked(a) ? 8 : (_actRank[a.honest?.action] ?? 9));
  const notable = acc.filter(a => a.verdict && a.verdict !== "BUILDING")
    .sort((a, b) => _rank(a) - _rank(b) || (b.n || 0) - (a.n || 0));
  for (const a of notable.slice(0, 6)) {
    const skillTxt = `skill ${_briefSkill(a.skill)} vs market, n=${a.n}`;
    const c = a.calib || {};
    const dTxt = c.delta != null ? `${Math.abs(c.delta)}pts` : "";
    // `honest.action` is the correction-ladder verb ("Improve inputs" / "Recalibrate" /
    // "Diagnose then stop") — the exact work DoThisBanner's tier 2.2 suppresses. While no pattern
    // is validated the diagnosis stays (it IS the measurement) and only the verb goes.
    const act = _parked(a) ? _parkedTxt(a)
      : (AWAITING_VALIDATED_EDGE ? "tracking — no validated pattern here yet (docs/REENTRY.md)"
        : (a.honest?.action || "review"));
    // Decay caution — a positive-skill category whose reliable learning trend is materially
    // negative is real-but-eroding (the market is closing the gap); say so on its own bullet so
    // the green verdict doesn't read as static. Threshold −0.05 ≈ well past trend noise.
    const decayTxt = (a.skill > 0 && a.learning?.reliable && (a.learning?.skillTrend ?? 0) <= -0.05)
      ? ` One caution: its skill trend is ${_briefSkill(a.learning.skillTrend)} — the edge is real but the market is closing the gap.` : "";
    switch (a.verdict) {
      case "CALIBRATED":     model.push(`${name(a.key)} is calibrated — model% matches outcomes within noise (${skillTxt}).${decayTxt}`); break;
      case "PROMISING":      model.push(`${name(a.key)} beats the market (${skillTxt}) but calibration bands are still thin — closest to betting-eligible.${decayTxt}`); break;
      case "MARKET_SHARPER": model.push(`${name(a.key)}: the market out-predicts the model and the trend isn't recovering (${skillTxt}) — ${act}.`); break;
      case "OVERCONFIDENT":  model.push(`${name(a.key)} is overconfident — claims ${dTxt} more than it delivers in the ${c.band ?? "?"}% band (${skillTxt}) — ${act}.`); break;
      case "UNDERCONFIDENT": model.push(`${name(a.key)} is underconfident — delivers ${dTxt} more than it claims in the ${c.band ?? "?"}% band (${skillTxt}) — ${act}.`); break;
      default:               model.push(`${name(a.key)}: ${_briefVerdict(a.verdict)} (${skillTxt}).`);
    }
  }
  const buildingN = acc.length - notable.length;
  if (buildingN > 0) model.push(`${buildingN} other categor${buildingN === 1 ? "y is" : "ies are"} still accruing data — nothing to act on there.`);

  // Betting accrual clocks — one bullet per eligible category: the in-window read (flagged when
  // too thin to mean anything), and the discovered window's distance from the n≥MIN_N_PROMOTE
  // promote bar. Gate-level changes (rare, important) lead the section.
  const betting = [];
  for (const b of bet) {
    // "candidate", not "ready to gate" (2026-07-27) — this is a bet-WINDOW screen, and an
    // in-sample one; the category gate is a different mechanism entirely. See _bettingAction.
    // The verdict itself is a measurement and stays visible while nothing is validated (instruments
    // keep running); only the imperative tail changes, so this line can't contradict a takeaway
    // that just said there is nothing to act on.
    if (b.verdict === "PROMOTE")            betting.push(`${name(b.key)} is a bet-window candidate — ${b.hint || "in-sample window passed"} — ${AWAITING_VALIDATED_EDGE ? "in-sample screen only, not a validated pattern — a price-band re-slice has not held up out-of-sample before (docs/REENTRY.md)." : "confirm with tune:window before shipping."}`);
    else if (b.verdict === "DEMOTE")        betting.push(AWAITING_VALIDATED_EDGE ? `${name(b.key)}'s window went significantly negative (the gate is already empty).` : `Pull ${name(b.key)} from the gate — its window went significantly negative.`);
    else if (b.gated && b.verdict === "HOLD") betting.push(`${name(b.key)} stays in the gate — still profitable.`);
  }
  for (const b of bet) {
    if (!b.eligible || b.verdict === "PROMOTE" || b.verdict === "DEMOTE") continue;
    const parts = [];
    const sw = b.subWindow;
    if (sw?.n) parts.push(`in the current ${b.currentWindow?.[0]}–${b.currentWindow?.[1]}¢ window ROI ${_briefRoi(sw.roi)} (n=${sw.n}${sw.n < 30 ? " — too thin to read yet" : ""})`);
    const dw = b.discoveredWindow;
    if (dw?.lo != null)
      parts.push(`discovered ${dw.lo}–${dw.hi}¢ window ROI ${_briefRoi(dw.roi)} (CI-lo ${_briefRoi(dw.roiLoCI)}, n=${dw.n}/${_MIN_N_PROMOTE} toward the promote bar${dw.coherent === false ? ", bands not coherent" : ""})`);
    if (parts.length) betting.push(`${name(b.key)}: ${parts.join("; ")}.`);
  }

  // Pricing findings — one sentence per cross-venue observatory, verdict in plain words.
  const pricing = [];
  // BOTH kill-gates CLOSED 2026-07-04 (Polymarket + sportsbook: zero surviving executable edge on
  // clean post-date-fix data; Phase-1b builds killed). The observatories stay as reference/tripwire
  // feeds, so the template reads accordingly: GAP = regime change vs the closed gate (or an
  // artifact — both prior ≥5¢ tails were fake, audit first), never a build prompt; the exec clause
  // still rides on every Poly verdict but as tripwire context, not a go/no-go.
  const venue = (v, label, extra) => {
    if (!v) return;
    if (v.verdict === "ACCRUING")  pricing.push(`${label}: thin window (n=${v.n} sides over ${v.days}d).${extra || ""}`);
    else if (v.verdict === "GAP")  pricing.push(`${label}: Kalshi shows cheap — ${Math.round((v.fracBuyEdge3 || 0) * 100)}% of traded sides ≥3¢ under the reference (median |Δ| ${v.medianAbs}¢, n=${v.n}/${v.days}d) — regime change vs the closed 7/04 kill-gate or an artifact: audit the ?minAbs=3 tail before acting.${extra || ""}`);
    else if (v.verdict === "TIGHT") pricing.push(`${label}: venues track — only ${Math.round((v.fracBuyEdge3 || 0) * 100)}% of sides ≥3¢ cheap (median |Δ| ${v.medianAbs}¢, n=${v.n}/${v.days}d) — no liquid lag edge (kill-gate closed 7/04).${extra || ""}`);
  };
  venue(r.sportsbookValidation, "Sharp book (de-vigged)");
  const pm = r.polymarketValidation;
  venue(pm, "Polymarket", pm?.execN ? ` Executable read: ${Math.round((pm.execFracEdge3 || 0) * 100)}% of bettable sides stay ≥3¢ cheaper after walking the Poly book (exec n=${pm.execN}) — tripwire only; the Phase-1b build was killed at the 7/04 gate.` : "");
  if (!pricing.length) pricing.push("No cross-venue pricing data captured yet (observatory feeds not populated).");

  // What changed vs yesterday's report — verdict flips, trusted-skill moves, n crossings,
  // eligibility flips, freshly-detected series. Omitted entirely (null) when no prior exists.
  let changes = null;
  if (prior?.accuracyBoard) {
    changes = [];
    const pAcc = Object.fromEntries((prior.accuracyBoard || []).map(a => [a.key, a]));
    for (const a of acc) {
      const p = pAcc[a.key];
      if (!p) continue;
      if (p.verdict !== a.verdict) changes.push(`${name(a.key)}: ${_briefVerdict(p.verdict)} → ${_briefVerdict(a.verdict)}.`);
      if (p.skill != null && a.skill != null && (a.n || 0) >= BRIER_MIN_N && Math.abs(a.skill - p.skill) >= 0.01)
        changes.push(`${name(a.key)} skill moved ${_briefSkill(p.skill)} → ${_briefSkill(a.skill)} (n=${a.n}).`);
      if ((p.n || 0) < BRIER_MIN_N && (a.n || 0) >= BRIER_MIN_N)
        changes.push(`${name(a.key)} crossed n=${BRIER_MIN_N} — its vs-market skill is now trusted.`);
    }
    const pBet = Object.fromEntries((prior.bettingBoard || []).map(b => [b.key, b]));
    for (const b of bet) {
      const p = pBet[b.key];
      if (p && !!p.eligible !== !!b.eligible)
        changes.push(`${name(b.key)} ${b.eligible ? "became betting-eligible" : "lost betting eligibility"}.`);
    }
    const pNew = new Set((prior.newMarkets || []).map(m => m.ticker));
    const fresh = (r.newMarkets || []).filter(m => !pNew.has(m.ticker));
    if (fresh.length) changes.push(`${fresh.length} new Kalshi series detected: ${fresh.map(m => m.ticker).join(", ")}.`);
    if (!changes.length) changes.push("No material change since yesterday's report.");
  }

  // Takeaway — the one-line "so what": actions if any exist (data-health fix, gate moves),
  // otherwise name the accrual clocks that matter (discovered windows short of the promote bar,
  // eligible categories whose in-window sample is still too thin). Capped at 3 clocks.
  //
  // AWAITING_VALIDATED_EDGE (2026-07-29) suppresses the prescriptive items here, mirroring what
  // the DoThisBanner's tiers 2/3.15 already did — the flag lives in config.js precisely because
  // those two surfaces disagreed, and this one was the loud half: it emitted "Action needed today:
  // run tune:window on mlb f3ml" to every routine and report reading the JSON, for a category
  // tune:window had already returned NO-GO on. Data health is deliberately NOT gated (it is
  // pipeline integrity, not strategy — the banner keeps its tier 1 too, and the instruments are
  // exactly what we keep running while looking for a pattern that holds).
  const actions = [];
  if (dh?.actionable) actions.push("fix data health (see the health line)");
  for (const b of bet) {
    if (AWAITING_VALIDATED_EDGE) break;
    // Was `add ... to the gate` (2026-07-27) — wrong mechanism AND premature. PROMOTE is an
    // in-sample bet-WINDOW screen; the decision belongs to tune:window's out-of-sample split.
    if (b.verdict === "PROMOTE") actions.push(`run tune:window on ${name(b.key)} (in-sample window candidate)`);
    else if (b.verdict === "DEMOTE") actions.push(`pull ${name(b.key)} from the gate`);
  }
  let takeaway;
  if (actions.length) {
    takeaway = `Action needed today: ${actions.join("; ")}.`;
  } else if (AWAITING_VALIDATED_EDGE) {
    // The accrual clocks below count toward promote bars that no pattern has earned yet, so naming
    // them would be the same prompt one indirection out ("the clocks that matter are…" — they
    // aren't yet). The honest state is: the instruments are running and the data is accumulating.
    takeaway = "No trade to place today — no pattern has cleared its validation bar yet. "
      + "The instruments keep running: shadow logging, maker quoting and fill detection, and the "
      + "Kalshi series scan are accumulating the data a reliable pattern would show up in. What "
      + "counts as one: a signal in NEW data (a new market class) or a mechanism stated in advance "
      + "and then tested — re-slicing days already in hand has produced six false positives "
      + "(docs/REENTRY.md).";
  } else {
    const clocks = [];
    for (const b of bet.filter(x => x.eligible)) {
      const dw = b.discoveredWindow;
      if (dw?.lo != null && (dw.n || 0) < _MIN_N_PROMOTE) clocks.push(`${name(b.key)}'s ${dw.lo}–${dw.hi}¢ window (n ${dw.n}/${_MIN_N_PROMOTE})`);
      else if ((b.subWindow?.n || 0) < 30) clocks.push(`${name(b.key)}'s calibration bands`);
    }
    takeaway = clocks.length
      ? `Nothing needs action today — the clocks that matter are ${clocks.slice(0, 3).join(", ")}.`
      : "Nothing needs action today.";
  }

  return { health, headline, changes, model, betting, pricing, takeaway };
}

async function handleShadowReport({ path, request, env, cache }) {
  if (path !== "shadow-report") return null;

  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isCron  = env?.CRON_SECRET && bearer === env.CRON_SECRET;
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;

  let isUser = false;
  if (!isCron && !isAdmin && env?.JWT_SECRET) {
    const token = _extractReportToken(request);
    const payload = token ? await verifyJWT(token, env.JWT_SECRET) : null;
    isUser = !!payload;
  }

  if (!isCron && !isAdmin && !isUser) return errorResponse("Forbidden", 403);
  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("No Neon connection", 500);

  // ── ?makerQueueCheck=1 — V1-vs-V2 fill agreement, the queue-priority calibration (2026-07-29) ──
  // V1 is a COUNTERFACTUAL simulator: it never places an order, then asserts a fill whenever a
  // taker traded at `px >= our ask` inside a segment window (`replayFills`). That assertion rests
  // on "we quote 1¢ inside, so price priority is ours" — true at the instant of quoting, and
  // unverifiable afterwards, because V1 records only top-of-book and samples every 2 minutes. A
  // competitor can improve, absorb the flow and revert between ticks, and V1 would still credit us.
  //
  // V2's 3 live days are the only ground truth that exists: real resting orders, same engine, same
  // eligibility logic (`computeMakerQuote` with MAKER_V2_BAND). Joining them gives a 2x2 —
  // per V2 order, did V1 predict a fill over the same ticker/side/window?
  //
  //   both filled           → V1 agrees with reality
  //   V2 filled, V1 did not → V1 is CONSERVATIVE (under-counts fills)
  //   V1 filled, V2 did not → V1 is OPTIMISTIC — the queue-priority assumption failing, and the
  //                           single number this endpoint exists to produce
  //   neither               → agrees
  //
  // Read-only; no writes anywhere. Scoped by the orders table, so it is inherently limited to the
  // V2 band/days — that is the point, not a defect: it is the only place the two overlap.
  //
  // Caveats to carry into any conclusion. (1) A V2 order and a V1 segment are not the same unit:
  // V2 orders self-expire on MAKER_V2_EXPIRATION_SEC and get re-placed, V1 segments close when the
  // quote changes — so `v1Segments` per order is usually >1 and the comparison is "did EITHER
  // predict a fill in this window". (2) V2 capped at MAKER_V2_MAX_CONCURRENT, so absolute volumes
  // are not comparable between the two — only per-order RATES are. (3) n is 3 days.
  if (new URL(request.url).searchParams.get("makerQueueCheck") === "1") {
    try {
      const rows = await neonQuery(`
        SELECT o.id, o.ticker, o.side, o.price, o.size, o.filled_count, o.status, o.game_date,
               COUNT(q.id)::int                          AS v1_segments,
               COALESCE(MAX(q.quote_ask), 0)::int        AS v1_ask,
               COALESCE(SUM(fq.c), 0)::numeric           AS v1_contracts
          FROM maker_orders_v2 o
          LEFT JOIN maker_quotes q
            ON q.ticker = o.ticker
           AND q.source = 'live'
           AND q.quote_side = o.side
           AND q.valid_from < COALESCE(o.canceled_at, o.expires_at, NOW())
           AND COALESCE(q.valid_to, NOW()) > o.placed_at
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(f.contracts), 0) AS c
              FROM maker_fills f
             WHERE f.quote_id = q.id
               AND f.traded_at >= o.placed_at
               AND f.traded_at <  COALESCE(o.canceled_at, o.expires_at, NOW())
          ) fq ON TRUE
         GROUP BY o.id, o.ticker, o.side, o.price, o.size, o.filled_count, o.status, o.game_date`,
        [], env, { write: true });

      const cell = { bothFilled: 0, v2Only: 0, v1Only: 0, neither: 0 };
      let noSegment = 0, priceMatch = 0, priceRows = 0, sumPriceDiff = 0;
      const byDay = new Map();
      const v1OnlySamples = [];
      for (const r of rows) {
        const v2f = Number(r.filled_count) > 0;
        const v1f = Number(r.v1_contracts) > 0;
        if (!r.v1_segments) noSegment++;
        const k = v2f && v1f ? "bothFilled" : v2f ? "v2Only" : v1f ? "v1Only" : "neither";
        cell[k]++;
        if (k === "v1Only" && v1OnlySamples.length < 10) {
          v1OnlySamples.push({ ticker: r.ticker, side: r.side, v2Price: r.price,
            v1Ask: r.v1_ask, v1Contracts: Number(r.v1_contracts), segments: r.v1_segments });
        }
        if (r.v1_segments && r.v1_ask) {
          priceRows++; sumPriceDiff += Math.abs(Number(r.price) - Number(r.v1_ask));
          if (Number(r.price) === Number(r.v1_ask)) priceMatch++;
        }
        const d = r.game_date || "?";
        const day = byDay.get(d) || { orders: 0, v2Filled: 0, v1Filled: 0 };
        day.orders++; if (v2f) day.v2Filled++; if (v1f) day.v1Filled++;
        byDay.set(d, day);
      }
      const n = rows.length;
      const rate = (x) => (n ? +(x / n * 100).toFixed(1) : null);
      return jsonResponse({
        ok: true, orders: n,
        // The headline: how often each engine says "filled", on the SAME orders.
        v2FillRatePct: rate(cell.bothFilled + cell.v2Only),
        v1FillRatePct: rate(cell.bothFilled + cell.v1Only),
        matrix: cell,
        agreementPct: rate(cell.bothFilled + cell.neither),
        // >0 means V1 claimed fills reality did not deliver — the queue-priority assumption failing.
        v1OptimismPct: rate(cell.v1Only),
        v1ConservatismPct: rate(cell.v2Only),
        // Orders V1 never quoted at all (eligibility or timing divergence) — these are NOT a
        // queue-priority signal, and they sit inside `neither`/`v2Only`, so read them separately.
        ordersWithNoV1Segment: noSegment,
        priceAgreement: priceRows
          ? { rows: priceRows, exactMatchPct: +(priceMatch / priceRows * 100).toFixed(1),
              meanAbsDiffC: +(sumPriceDiff / priceRows).toFixed(2) }
          : null,
        byDay: [...byDay.entries()].sort().map(([day, v]) => ({ day, ...v })),
        v1OnlySamples,
      });
    } catch (e) { return errorResponse(`makerQueueCheck failed: ${e?.message}`, 500); }
  }

  // ── ?makerTapeProbe=YYYY-MM-DD — is V1's single tape page actually covering the day? ──────────
  // Follow-up to ?makerQueueCheck=1, which found V1 predicting a 0.7% fill rate on the very orders
  // that really filled 15.6% of the time. That is V1 UNDER-detecting by ~22x, not over-claiming,
  // and the prime suspect is in detectAndGradeMakerFills: one `/markets/trades` page per ticker,
  // `limit=1000`, `min_ts` only — no pagination, no cursor. Its comment asserts "these markets
  // trade well under that in a day", which is exactly the kind of assumption worth checking on the
  // liquid *GAME series that make up V2's band.
  //
  // If the endpoint returns MOST-RECENT-first, then on a market with >1000 trades/day the page is
  // all in-play trades and the PRE-GAME window — the only window V1 ever quotes in — is truncated
  // off the end. That would make V1's fill sample systematically biased toward ILLIQUID tickers,
  // which distorts every downstream V1 number, band analysis included.
  //
  // The probe: take tickers where a real V2 order filled, fetch each tape exactly as V1 does, and
  // report how many trades came back and what time range they span. `hitLimit` with a `firstTrade`
  // later than the order window is the smoking gun.
  if (new URL(request.url).searchParams.get("makerTapeProbe")) {
    const dayPT = new URL(request.url).searchParams.get("makerTapeProbe");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPT)) return errorResponse("makerTapeProbe must be YYYY-MM-DD", 400);
    try {
      const picks = await neonQuery(
        `SELECT o.ticker, MIN(o.placed_at) AS first_order, MAX(COALESCE(o.canceled_at, o.expires_at)) AS last_order,
                SUM(o.filled_count)::int AS filled
           FROM maker_orders_v2 o
          WHERE o.game_date = $1 AND o.filled_count > 0
          GROUP BY o.ticker ORDER BY filled DESC LIMIT 8`, [dayPT], env, { write: true });
      const minTs = Math.floor((Date.parse(`${dayPT}T00:00:00-07:00`) - 6 * 3600_000) / 1000);
      const out = [];
      for (const p of picks) {
        try {
          const r = await fetch(
            `https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${encodeURIComponent(p.ticker)}&limit=1000&min_ts=${minTs}`,
            { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
          if (!r.ok) { out.push({ ticker: p.ticker, error: `HTTP ${r.status}` }); continue; }
          const j = await r.json();
          const tr = j?.trades || [];
          const times = tr.map(t => t.created_time).filter(Boolean).sort();
          out.push({
            ticker: p.ticker, v2Filled: p.filled,
            orderWindow: { from: p.first_order, to: p.last_order },
            trades: tr.length,
            hitLimit: tr.length >= 1000,
            hasCursor: !!j?.cursor,
            firstTrade: times[0] || null,
            lastTrade: times[times.length - 1] || null,
            // The decisive field: pre-game orders rested BEFORE firstTrade means the page
            // never reached the window V1 quotes in.
            windowCoveredByPage: times.length
              ? Date.parse(times[0]) <= Date.parse(p.first_order) : null,
          });
        } catch (e) { out.push({ ticker: p.ticker, error: String(e?.message || e) }); }
      }
      const covered = out.filter(o => o.windowCoveredByPage === true).length;
      const truncated = out.filter(o => o.windowCoveredByPage === false).length;
      return jsonResponse({ ok: true, day: dayPT, probed: out.length,
        windowCovered: covered, windowTruncated: truncated,
        hitLimit: out.filter(o => o.hitLimit).length, tickers: out });
    } catch (e) { return errorResponse(`makerTapeProbe failed: ${e?.message}`, 500); }
  }

  // ── ?makerFillForensic=YYYY-MM-DD — WHY did V1 miss a fill reality delivered? ────────────────
  // ?makerQueueCheck=1 left one thing unexplained: V1's per-segment fill rate in the V2 band is
  // 9.1%, but inside V2's actual order windows it is 0.7%. Those should be comparable — both are
  // per unit of resting exposure — so an order-of-magnitude gap means either `replayFills` has a
  // matching bug, or V1's exposure model differs from a real resting order. Different fixes.
  //
  // This takes cases where a real V2 order FILLED and V1 recorded nothing, then replays V1's own
  // match conditions trade by trade and reports WHICH one rejected each trade:
  //   outsideWindow  — trade fell outside every overlapping segment's [valid_from, valid_to)
  //   sideMismatch   — t.taker_side !== segment.quote_side
  //   priceBelowAsk  — px < our quoted ask
  //   noPrice        — the side's price came back null
  //   wouldMatch     — passes every condition, so V1 SHOULD have booked it (a real bug)
  //
  // `wouldMatch > 0` means the detector is broken. All rejections in `sideMismatch` means our
  // taker_side convention is inverted. All in `outsideWindow` means the segment bookkeeping, not
  // the matcher, is what diverges from a live order.
  // ── ?makerCell=sport|category|band — drill into ONE heatmap cell (2026-07-29) ────────────────
  // The heatmap tooltip gives a cell's summary; this answers the question that separates a real
  // mechanism from a lucky stretch: is the edge spread across the days, or is it two of them? Per
  // day it returns fills/contracts/sideWon/¢-per-contract, plus the top tickers (which games), plus
  // the day-clustered CI echoed. Graded, source='live'. Read-only. The reliability bar is NOT
  // multiplicity-corrected, so a single "clears zero" cell out of ~280 is expected under pure
  // noise — this exists to inspect such a cell, not to bless it.
  if (new URL(request.url).searchParams.get("makerCell")) {
    const _mcQs = new URL(request.url).searchParams;
    const spec = _mcQs.get("makerCell");
    const [sport, category, band] = spec.split("|");
    if (!sport || !category || !band) return errorResponse("makerCell must be sport|category|band", 400);
    // &since=YYYY-MM-DD restricts to game_date >= since — this is how the forward (out-of-sample)
    // leg of a pre-registration is evaluated: pass the registration's forward-start date and the
    // totals/CI below are computed on NEW days only (see docs/MAKER_F5TOTAL_PREREG.md).
    const _mcSince = /^\d{4}-\d{2}-\d{2}$/.test(_mcQs.get("since") || "") ? _mcQs.get("since") : null;
    try {
      const _bandCase = _makerBandCase("f.fill_ask");
      const _sinceSql = _mcSince ? ` AND q.game_date >= $4` : "";
      const _args = _mcSince ? [sport, category, band, _mcSince] : [sport, category, band];
      const perDay = await neonQuery(
        `SELECT q.game_date AS day, COUNT(*)::int AS fills,
           COALESCE(SUM(f.contracts),0)::numeric AS contracts,
           COALESCE(SUM(f.pnl_cents*f.contracts),0)::numeric AS pnl_total,
           COALESCE(SUM((f.side_won)::int::numeric*f.contracts),0)::numeric AS won_contracts,
           ROUND(AVG(f.fill_ask),1) AS avg_ask
         FROM maker_fills f JOIN maker_quotes q ON q.id=f.quote_id
         WHERE q.source='live' AND f.graded_at IS NOT NULL
           AND q.sport=$1 AND COALESCE(q.category,q.sport)=$2 AND ${_bandCase}=$3${_sinceSql}
         GROUP BY 1 ORDER BY 1`, _args, env, { write: true });
      const topTickers = await neonQuery(
        `SELECT q.ticker, q.quote_side AS side, COUNT(*)::int AS fills,
           COALESCE(SUM(f.contracts),0)::numeric AS contracts,
           ROUND(COALESCE(SUM(f.pnl_cents*f.contracts),0) / NULLIF(SUM(f.contracts),0), 1) AS pnl_per_ct,
           ROUND(AVG((f.side_won)::int::numeric),2) AS side_won
         FROM maker_fills f JOIN maker_quotes q ON q.id=f.quote_id
         WHERE q.source='live' AND f.graded_at IS NOT NULL
           AND q.sport=$1 AND COALESCE(q.category,q.sport)=$2 AND ${_bandCase}=$3${_sinceSql}
         GROUP BY q.ticker, q.quote_side ORDER BY contracts DESC LIMIT 15`, _args, env, { write: true });
      const days = perDay.map(r => ({
        day: String(r.day).slice(0, 10), fills: Number(r.fills),
        contracts: parseFloat(Number(r.contracts).toFixed(1)),
        perContract: Number(r.contracts) ? parseFloat((Number(r.pnl_total) / Number(r.contracts)).toFixed(2)) : null,
        sideWon: Number(r.contracts) ? parseFloat((Number(r.won_contracts) / Number(r.contracts)).toFixed(3)) : null,
        avgAsk: r.avg_ask != null ? Number(r.avg_ask) : null,
      }));
      const dc = dayClusteredPnl({ days: perDay.map(r => ({ pnl: Number(r.pnl_total), contracts: Number(r.contracts) })) });
      return jsonResponse({
        ok: true, cell: { sport, category, band }, since: _mcSince,
        totals: {
          fills: days.reduce((a, d) => a + d.fills, 0),
          contracts: parseFloat(days.reduce((a, d) => a + d.contracts, 0).toFixed(1)),
          days: days.length,
          perContract: dc?.mean ?? null, ciLo: dc?.loCI ?? null, ciHi: dc?.hiCI ?? null,
          positiveDays: days.filter(d => (d.perContract ?? 0) > 0).length,
        },
        byDay: days,
        topTickers: topTickers.map(r => ({ ticker: r.ticker, side: r.side, fills: Number(r.fills),
          contracts: parseFloat(Number(r.contracts).toFixed(1)),
          perContract: r.pnl_per_ct != null ? Number(r.pnl_per_ct) : null,
          sideWon: r.side_won != null ? Number(r.side_won) : null })),
      });
    } catch (e) { return errorResponse(`makerCell failed: ${e?.message}`, 500); }
  }

  if (new URL(request.url).searchParams.get("makerFillForensic")) {
    const dayPT = new URL(request.url).searchParams.get("makerFillForensic");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPT)) return errorResponse("makerFillForensic must be YYYY-MM-DD", 400);
    try {
      const cases = await neonQuery(
        `SELECT o.id, o.ticker, o.side, o.price, o.size, o.filled_count,
                o.placed_at, COALESCE(o.canceled_at, o.expires_at) AS ended_at
           FROM maker_orders_v2 o
          WHERE o.game_date = $1 AND o.filled_count > 0
            AND NOT EXISTS (
              SELECT 1 FROM maker_quotes q
                JOIN maker_fills f ON f.quote_id = q.id
               WHERE q.ticker = o.ticker AND q.source = 'live' AND q.quote_side = o.side
                 AND f.traded_at >= o.placed_at
                 AND f.traded_at <  COALESCE(o.canceled_at, o.expires_at, NOW()))
          ORDER BY o.filled_count DESC LIMIT 3`, [dayPT], env, { write: true });
      if (!cases.length) return jsonResponse({ ok: true, day: dayPT, cases: [], note: "no V2-filled/V1-missed orders that day" });

      const minTs = Math.floor((Date.parse(`${dayPT}T00:00:00-07:00`) - 6 * 3600_000) / 1000);
      const out = [];
      for (const c of cases) {
        const segs = await neonQuery(
          `SELECT id, quote_side, quote_ask, size, valid_from, valid_to
             FROM maker_quotes
            WHERE ticker = $1 AND source = 'live' AND quote_side = $2
              AND valid_from < $4 AND COALESCE(valid_to, NOW()) > $3
            ORDER BY valid_from`, [c.ticker, c.side, c.placed_at, c.ended_at], env, { write: true });
        let trades = [];
        try {
          const r = await fetch(
            `https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${encodeURIComponent(c.ticker)}&limit=1000&min_ts=${minTs}`,
            { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
          if (r.ok) trades = (await r.json())?.trades || [];
        } catch {}
        const from = Date.parse(c.placed_at), to = Date.parse(c.ended_at);
        const inWin = trades.filter(t => { const ts = Date.parse(t.created_time); return ts >= from && ts < to; });
        const reasons = { outsideWindow: 0, sideMismatch: 0, priceBelowAsk: 0, noPrice: 0, wouldMatch: 0 };
        const samples = [];
        for (const t of inWin) {
          const ts = Date.parse(t.created_time);
          const seg = segs.find(s => ts >= Date.parse(s.valid_from) && ts < (s.valid_to ? Date.parse(s.valid_to) : Infinity));
          if (!seg) { reasons.outsideWindow++; continue; }
          const px = seg.quote_side === "yes"
            ? (t.yes_price_dollars != null ? Math.round(parseFloat(t.yes_price_dollars) * 100) : null)
            : (t.no_price_dollars  != null ? Math.round(parseFloat(t.no_price_dollars)  * 100) : null);
          let why;
          // Same rule as replayFills: the taker fills us from the OPPOSITE side. This inline copy
          // asserted the old inverted rule (`!==`) through the 2026-07-29 investigation and so
          // reported stale "sideMismatch" on trades that DO fill us — corrected here to match the
          // fixed matcher, or this endpoint keeps pointing at a bug that no longer exists.
          if (t.taker_side === seg.quote_side) { reasons.sideMismatch++; why = "sameSideNoFill"; }
          else if (px == null) { reasons.noPrice++; why = "noPrice"; }
          else if (px < Number(seg.quote_ask)) { reasons.priceBelowAsk++; why = "priceBelowAsk"; }
          else { reasons.wouldMatch++; why = "wouldMatch"; }
          if (samples.length < 6) samples.push({ why, takerSide: t.taker_side, quoteSide: seg.quote_side,
            px, quoteAsk: Number(seg.quote_ask), count: t.count_fp ?? t.count, at: t.created_time });
        }
        out.push({
          ticker: c.ticker, v2Side: c.side, v2Price: c.price, v2FilledCount: c.filled_count,
          window: { from: c.placed_at, to: c.ended_at },
          v1Segments: segs.map(s => ({ side: s.quote_side, ask: Number(s.quote_ask), size: s.size,
            from: s.valid_from, to: s.valid_to })),
          tradesTotal: trades.length, tradesInWindow: inWin.length, reasons, samples,
        });
      }
      return jsonResponse({ ok: true, day: dayPT, cases: out });
    } catch (e) { return errorResponse(`makerFillForensic failed: ${e?.message}`, 500); }
  }

  // ── ?makerSideAudit=YYYY-MM-DD — establish the taker_side↔quote_side mapping from ground truth ─
  // ?makerFillForensic= showed every missed fill rejected on `t.taker_side !== s.quote_side` alone,
  // with price, size and timestamp all matching a real V2 fill exactly. Before flipping that
  // condition, two things have to be known, because getting the convention backwards a SECOND time
  // would re-break detection in the opposite direction and silently invalidate the rebuild:
  //
  //   A. How lopsided is the existing fill population by quote_side? If V1's 19k fills are nearly
  //      all one side, the current data is a wrong-side artifact and has to be rebuilt, not patched.
  //   B. What does the mapping actually look like on REAL fills? For every V2 order that executed,
  //      find the trade that filled it and tabulate (our quote_side x observed taker_side).
  //
  // B is the oracle. The rule that comes out of it gets written into replayFills as an EMPIRICAL
  // fact with this endpoint named, not as a theory about Kalshi's book semantics — the theory is
  // exactly what produced the bug.
  if (new URL(request.url).searchParams.get("makerSideAudit")) {
    const dayPT = new URL(request.url).searchParams.get("makerSideAudit");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPT)) return errorResponse("makerSideAudit must be YYYY-MM-DD", 400);
    try {
      // ── A. existing V1 population, all-time, by side ──
      const [segBySide, fillBySide] = await Promise.all([
        neonQuery(`SELECT quote_side, COUNT(*)::int AS n FROM maker_quotes WHERE source='live' GROUP BY 1`, [], env, { write: true }),
        neonQuery(`SELECT q.quote_side, COUNT(*)::int AS n, COALESCE(SUM(f.contracts),0)::numeric AS contracts
                     FROM maker_fills f JOIN maker_quotes q ON q.id=f.quote_id
                    WHERE q.source='live' GROUP BY 1`, [], env, { write: true }),
      ]);
      // ── B. ground-truth mapping from V2's executed orders ──
      const orders = await neonQuery(
        `SELECT ticker, side, price, filled_count, placed_at,
                COALESCE(canceled_at, expires_at) AS ended_at
           FROM maker_orders_v2
          WHERE game_date = $1 AND filled_count > 0
          ORDER BY ticker LIMIT 120`, [dayPT], env, { write: true });
      const minTs = Math.floor((Date.parse(`${dayPT}T00:00:00-07:00`) - 6 * 3600_000) / 1000);
      const tapeCache = new Map();
      const getTape = async (ticker) => {
        if (tapeCache.has(ticker)) return tapeCache.get(ticker);
        let tr = [];
        try {
          const r = await fetch(
            `https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=1000&min_ts=${minTs}`,
            { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
          if (r.ok) tr = (await r.json())?.trades || [];
        } catch {}
        tapeCache.set(ticker, tr);
        return tr;
      };
      const map = {};                       // "quoteSide->takerSide" -> count
      let matchedOrders = 0, unmatchedOrders = 0;
      const samples = [];
      for (const o of orders) {
        const tape = await getTape(o.ticker);
        const from = Date.parse(o.placed_at), to = Date.parse(o.ended_at);
        // The trade that filled us: inside the window, and priced on OUR side at our exact price.
        const hit = tape.filter(t => {
          const ts = Date.parse(t.created_time);
          if (!(ts >= from && ts < to)) return false;
          const px = o.side === "yes"
            ? (t.yes_price_dollars != null ? Math.round(parseFloat(t.yes_price_dollars) * 100) : null)
            : (t.no_price_dollars  != null ? Math.round(parseFloat(t.no_price_dollars)  * 100) : null);
          return px === Number(o.price);
        });
        if (!hit.length) { unmatchedOrders++; continue; }
        matchedOrders++;
        for (const t of hit) {
          const k = `${o.side}->${t.taker_side}`;
          map[k] = (map[k] || 0) + 1;
          if (samples.length < 8) samples.push({ ticker: o.ticker, quoteSide: o.side,
            takerSide: t.taker_side, price: o.price, count: t.count_fp ?? t.count, at: t.created_time });
        }
      }
      // The rule the data supports: does taker_side EQUAL our side, or OPPOSE it?
      const same = Object.entries(map).filter(([k]) => k.split("->")[0] === k.split("->")[1])
        .reduce((a, [, v]) => a + v, 0);
      const opposite = Object.entries(map).filter(([k]) => k.split("->")[0] !== k.split("->")[1])
        .reduce((a, [, v]) => a + v, 0);
      return jsonResponse({
        ok: true, day: dayPT,
        existingPopulation: {
          segmentsBySide: Object.fromEntries(segBySide.map(r => [r.quote_side, r.n])),
          fillsBySide: Object.fromEntries(fillBySide.map(r => [r.quote_side, { fills: r.n, contracts: Number(r.contracts) }])),
        },
        groundTruth: {
          ordersExamined: orders.length, matchedOrders, unmatchedOrders,
          mapping: map, takerSideSameAsQuoteSide: same, takerSideOppositeQuoteSide: opposite,
          // What replayFills should require. Stated as a verdict so the fix cites a number.
          // Dominance, not purity. The first run read 136 opposite / 1 same and returned "MIXED"
          // on a `same === 0` test — too strict, because matching every same-priced trade in the
          // window picks up the occasional unrelated one. 95% settles it; anything less genuinely
          // is ambiguous and must not be acted on.
          verdict: (same + opposite) < 20 ? "TOO FEW — need more matched orders"
                 : opposite / (same + opposite) >= 0.95 ? "REQUIRE taker_side !== quote_side"
                 : same / (same + opposite) >= 0.95 ? "REQUIRE taker_side === quote_side"
                 : "MIXED — do not flip; investigate before changing replayFills",
          samples,
        },
      });
    } catch (e) { return errorResponse(`makerSideAudit failed: ${e?.message}`, 500); }
  }

  // ── ?makerExitCheck=1 — early-exit counterfactual (2026-07-28) ──────────
  // "Would selling back before settlement, while in profit, have helped?" Never examined before —
  // both V1 and V2 model every position as hold-to-settlement (`pnl_cents = fill_ask − 100·won`),
  // and there is no exit price anywhere in the schema.
  //
  // The price path comes from the SEGMENTS themselves: a ticker's later `maker_quotes` rows record
  // the book each time the favorite-side ask moved, which is exactly a change-log of the price. No
  // candlestick fetch needed.
  //
  // HARD LIMIT, stated up front: quoting is pre-game only, so segments stop at first pitch. This
  // therefore tests the PRE-GAME take-profit rule only. Any in-play exit is invisible here and
  // would need the candlestick path (api/lib/maker-backfill.js proved that is available).
  if (new URL(request.url).searchParams.get("makerExitCheck") === "1") {
    try {
      const rows = await neonQuery(`
        WITH f AS (
          SELECT mf.id, mf.contracts, mf.pnl_cents, mf.fill_ask, mf.traded_at,
                 q.ticker, q.game_date, q.quote_side,
                 (q.book_yes_ask - q.book_yes_bid) AS entry_spread
            FROM maker_fills mf
            JOIN maker_quotes q ON q.id = mf.quote_id
           WHERE q.source = 'live' AND mf.graded_at IS NOT NULL AND mf.traded_at IS NOT NULL
        )
        SELECT f.id, f.contracts, f.pnl_cents, f.fill_ask, f.entry_spread,
               -- Cheapest price the SOLD side could have been bought back at, after the fill.
               MIN(CASE WHEN f.quote_side = 'yes' THEN q2.book_yes_ask ELSE q2.book_no_ask END)
                 AS min_ask_after
          FROM f
          LEFT JOIN maker_quotes q2
            ON q2.ticker = f.ticker AND q2.game_date = f.game_date
           AND q2.source = 'live' AND q2.valid_from > f.traded_at
         GROUP BY f.id, f.contracts, f.pnl_cents, f.fill_ask, f.entry_spread`,
        [], env, { write: true });

      const fills = rows.map((r) => ({
        pnlCents: r.pnl_cents == null ? null : Number(r.pnl_cents),
        contracts: Number(r.contracts),
        // Short at fill_ask; buying back costs min_ask_after. Positive = a profitable exit existed.
        excursionCents: r.min_ask_after == null ? null : Number(r.fill_ask) - Number(r.min_ask_after),
      }));
      const result = exitCounterfactual({ fills });

      const spreads = rows.map((r) => (r.entry_spread == null ? null : Number(r.entry_spread)))
        .filter((v) => v != null).sort((a, b) => a - b);
      const sp = (p) => (spreads.length ? spreads[Math.floor((p / 100) * spreads.length)] : null);

      console.log(`[shadow-report] makerExitCheck hold=${result.holdPnlPerContract} `
        + `bestDelta=${Math.max(...result.byThreshold.map((t) => t.deltaVsHold ?? -99))}`);
      return jsonResponse({
        ok: true,
        scope: "PRE-GAME exits only — quoting stops at first pitch, so in-play paths are invisible",
        entrySpreadCents: { p25: sp(25), median: sp(50), p75: sp(75), p90: sp(90), n: spreads.length },
        ...result,
      });
    } catch (e) { return errorResponse(`makerExitCheck failed: ${e?.message}`, 500); }
  }

  // ── ?makerLeadTime=1 — the pre-registered lead-time test (2026-07-28) ──────────
  // Decision rule fixed in docs/MAKER_LEADTIME_PREREG.md BEFORE this code was written. H1: a
  // resting quote is adversely selected in proportion to its time at risk, so seller edge should
  // decline as lead time grows. Estimators live in maker-stats.js (pure + tested) — a
  // pre-registered test computed by unverified inline SQL would be worth nothing, and this exact
  // class of diagnostic has already been wrong twice on this board while it was inline.
  //
  // source='live' only: the replayed segments failed their own validation and are excluded.
  // Returns before the report cache read, same reasoning as ?makerDay below.
  if (new URL(request.url).searchParams.get("makerLeadTime") === "1") {
    try {
      const rows = await neonQuery(`
        SELECT q.game_date AS day,
               ${_makerBandCase("f.fill_ask")} AS band,
               CASE
                 WHEN lead_h < 1  THEN '0-1h'
                 WHEN lead_h < 3  THEN '1-3h'
                 WHEN lead_h < 6  THEN '3-6h'
                 WHEN lead_h < 12 THEN '6-12h'
                 ELSE '12h+' END AS bucket,
               COUNT(*)::int AS fills,
               COALESCE(SUM(f.contracts), 0) AS contracts,
               COALESCE(SUM(f.fill_ask * f.contracts), 0) AS sum_ask_ctr,
               COALESCE(SUM((f.side_won)::int::numeric * f.contracts), 0) AS sum_won_ctr
          FROM maker_fills f
          JOIN maker_quotes q ON q.id = f.quote_id
          CROSS JOIN LATERAL (
            SELECT EXTRACT(EPOCH FROM (q.game_time - f.traded_at)) / 3600 AS lead_h) l
         WHERE q.source = 'live'
           AND f.graded_at IS NOT NULL
           AND q.game_time IS NOT NULL
           AND f.traded_at IS NOT NULL
           AND lead_h >= 0
         GROUP BY 1, 2, 3`, [], env, { write: true });

      const buckets = leadTimeBuckets(rows);
      const spearman = spearmanEdgeVsLead(buckets);
      const { days, weights } = mixAdjustedNearFarByDay(rows);
      const ci = dayLevelDiffCI(days);
      const verdict = leadTimeVerdict({ ci, days, spearman });

      // Unadjusted near-vs-far, reported for transparency and explicitly NOT the test — if it
      // disagrees with the mix-adjusted figure, the disagreement IS price mix.
      const armEdge = (pred) => {
        let c = 0, ask = 0, won = 0;
        for (const r of rows) {
          if (!pred(r.bucket)) continue;
          c += Number(r.contracts); ask += Number(r.sum_ask_ctr); won += Number(r.sum_won_ctr);
        }
        return c > 0 ? Math.round(((ask - 100 * won) / c) * 100) / 100 : null;
      };
      const near = armEdge((b) => b === "0-1h" || b === "1-3h");
      const far = armEdge((b) => b === "6-12h" || b === "12h+");

      console.log(`[shadow-report] makerLeadTime verdict=${verdict.verdict} ci=[${ci.loCI},${ci.hiCI}] `
        + `rho=${spearman} signs=${verdict.signPositive}/${verdict.totalDays}`);
      return jsonResponse({
        ok: true,
        preregistration: "docs/MAKER_LEADTIME_PREREG.md",
        buckets,
        spearman,
        dailyDiff: days,
        bandWeights: weights,
        dayClusteredDiff: ci,
        unadjusted: { nearEdgeCents: near, farEdgeCents: far, diffCents: near != null && far != null ? Math.round((near - far) * 100) / 100 : null },
        verdict,
      });
    } catch (e) { return errorResponse(`makerLeadTime failed: ${e?.message}`, 500); }
  }

  // ── ?makerDay=YYYY-MM-DD — single-day V1 maker drilldown (2026-07-28) ──────────
  // Attribution for ONE day's maker PnL, which `makerBoard` can't give: its `daily` series
  // carries only fills/contracts/pnl, and `bands` is cumulative over the 30-day window. Built
  // after a +$1,111 day (2026-07-27) could only be explained by inference off the book-wide
  // average ask.
  //
  // Deliberately returns BEFORE the report cache read below. The report is a 25h-cached, 40s+
  // payload; if this branch sat after that gate it would either serve the cached full report and
  // silently ignore the flag, or trigger a full regeneration to answer a one-day question. Here it
  // never reads, writes, or invalidates `shadow:report:{date}`, so it also can't perturb the 6am
  // cron. Failure-closed: any error is a 500, never a partial board.
  const makerDay = new URL(request.url).searchParams.get("makerDay");
  if (makerDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(makerDay)) {
      return errorResponse("Invalid makerDay — expected YYYY-MM-DD", 400);
    }
    try {
      // Every aggregate is graded-only. `avgFillAsk` and `sideWonRate` MUST come from the same
      // population for the seller's identity `pnl = fill_ask − 100·side_won` to reconcile — the
      // cumulative board's `avgFillAsk` deliberately spans ungraded fills too, so don't compare
      // the two numbers directly. The contract-weighted pair below reconstructs `pnlPerContract`
      // exactly (weightedAsk − 100·weightedSideWon), which is the actual decomposition of a day:
      // a price the book sold at, versus the rate the favorites it sold actually won.
      const _dayAgg = (extraSelect, groupBy, orderBy, limit) => `
        SELECT ${extraSelect}
          COUNT(*)::int AS fills,
          COALESCE(SUM(f.contracts), 0) AS contracts,
          COALESCE(SUM(f.pnl_cents * f.contracts), 0) AS pnl_total,
          ROUND(AVG(f.fill_ask), 1) AS avg_fill_ask,
          ROUND(AVG((f.side_won)::int::numeric), 4) AS side_won_rate
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.game_date = $1 AND q.source = 'live' AND f.graded_at IS NOT NULL
        ${groupBy} ${orderBy} ${limit}`;
      const [[mdTotals], mdSport, mdBand, mdTickers, mdCatBand, mdUngraded] = await Promise.all([
        neonQuery(`
          SELECT COUNT(*)::int AS fills,
            COALESCE(SUM(f.contracts), 0) AS contracts,
            COUNT(*) FILTER (WHERE f.graded_at IS NOT NULL)::int AS graded,
            COALESCE(SUM(f.contracts) FILTER (WHERE f.graded_at IS NOT NULL), 0) AS contracts_graded,
            COALESCE(SUM(f.pnl_cents * f.contracts) FILTER (WHERE f.graded_at IS NOT NULL), 0) AS pnl_total,
            ROUND(AVG(f.fill_ask) FILTER (WHERE f.graded_at IS NOT NULL), 1) AS avg_fill_ask,
            ROUND(AVG((f.side_won)::int::numeric) FILTER (WHERE f.graded_at IS NOT NULL), 4) AS side_won_rate,
            COALESCE(SUM(f.fill_ask * f.contracts) FILTER (WHERE f.graded_at IS NOT NULL), 0) AS sum_ask_ctr,
            COALESCE(SUM((f.side_won)::int::numeric * f.contracts) FILTER (WHERE f.graded_at IS NOT NULL), 0) AS sum_won_ctr
          FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
          WHERE q.game_date = $1 AND q.source = 'live'`, [makerDay], env, { write: true }),
        neonQuery(_dayAgg("q.sport, q.category,", "GROUP BY 1, 2", "ORDER BY pnl_total DESC", ""),
          [makerDay], env, { write: true }),
        // Same `_makerBandCase` helper the cumulative board uses — a hand-copied second CASE is
        // exactly how `quotedOutcomes` drifted out of sync before the 2026-07-26 rebuild.
        neonQuery(_dayAgg(`${_makerBandCase("f.fill_ask")} AS band,`, "GROUP BY 1", "ORDER BY 1", ""),
          [makerDay], env, { write: true }),
        // ABS() so a day carried by one huge LOSER is as visible as one carried by a winner.
        neonQuery(_dayAgg("f.ticker, q.sport,", "GROUP BY 1, 2", "ORDER BY ABS(SUM(f.pnl_cents * f.contracts)) DESC", "LIMIT 20"),
          [makerDay], env, { write: true }),
        // Category × band cross-tab (2026-07-28). `bySport` and `byBand` are MARGINALS, and a
        // day-demeaned residual analysis over 7 days found two overlapping hits — `mlb|f5ml`
        // (t −3.30) and band 65-69 (t −3.37) — that the marginals cannot separate, because f5ml's
        // 65.8¢ average ask sits inside that band while the band's largest constituents by volume
        // (teamRuns, f5total) are different categories entirely. Same `_makerBandCase` as `byBand`
        // above so a cell always sums into its own marginal. ~15 categories × 8 bands, so the row
        // count is bounded and no LIMIT is needed.
        neonQuery(_dayAgg(`q.sport, q.category, ${_makerBandCase("f.fill_ask")} AS band,`,
          "GROUP BY 1, 2, 3", "ORDER BY 1, 2, 3", ""), [makerDay], env, { write: true }),
        // Ungraded tail — how much of the day is still unsettled, i.e. how far the number can move.
        neonQuery(`
          SELECT q.sport, COUNT(*)::int AS fills, COALESCE(SUM(f.contracts), 0) AS contracts,
            ROUND(AVG(f.fill_ask), 1) AS avg_fill_ask
          FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
          WHERE q.game_date = $1 AND q.source = 'live' AND f.graded_at IS NULL
          GROUP BY 1 ORDER BY contracts DESC`, [makerDay], env, { write: true }),
      ]);
      const _num = (v) => (v == null ? null : Number(v));
      const _r = (v, d = 2) => (v == null ? null : parseFloat(Number(v).toFixed(d)));
      const _ctrGraded = Number(mdTotals?.contracts_graded || 0);
      const _pnl = Number(mdTotals?.pnl_total || 0);
      const _row = (r) => ({
        fills: Number(r.fills || 0),
        contracts: _r(r.contracts, 1),
        pnlTotalCents: _r(r.pnl_total, 1),
        pnlPerContract: Number(r.contracts) > 0 ? _r(Number(r.pnl_total) / Number(r.contracts)) : null,
        avgFillAsk: _num(r.avg_fill_ask),
        sideWonRate: _num(r.side_won_rate),
      });
      return jsonResponse({
        day: makerDay,
        totals: {
          fills: Number(mdTotals?.fills || 0),
          contracts: _r(mdTotals?.contracts, 1),
          graded: Number(mdTotals?.graded || 0),
          contractsGraded: _r(_ctrGraded, 1),
          pnlTotalCents: _r(_pnl, 1),
          pnlPerContract: _ctrGraded > 0 ? _r(_pnl / _ctrGraded) : null,
          avgFillAsk: _num(mdTotals?.avg_fill_ask),
          sideWonRate: _num(mdTotals?.side_won_rate),
          // Contract-weighted pair — these two ARE the day: pnlPerContract = weightedAsk − 100·weightedSideWon.
          weightedAsk: _ctrGraded > 0 ? _r(Number(mdTotals.sum_ask_ctr) / _ctrGraded) : null,
          weightedSideWon: _ctrGraded > 0 ? _r(Number(mdTotals.sum_won_ctr) / _ctrGraded, 4) : null,
        },
        bySport: (mdSport || []).map(r => ({ sport: r.sport, category: r.category, ..._row(r) })),
        byBand: (mdBand || []).map(r => ({ band: r.band, ..._row(r) })),
        topTickers: (mdTickers || []).map(r => ({ ticker: r.ticker, sport: r.sport, ..._row(r) })),
        byCategoryBand: (mdCatBand || []).map(r => ({
          sport: r.sport, category: r.category, band: r.band, ..._row(r),
        })),
        ungraded: {
          fills: (mdUngraded || []).reduce((a, r) => a + Number(r.fills || 0), 0),
          contracts: _r((mdUngraded || []).reduce((a, r) => a + Number(r.contracts || 0), 0), 1),
          bySport: (mdUngraded || []).map(r => ({
            sport: r.sport, fills: Number(r.fills || 0),
            contracts: _r(r.contracts, 1), avgFillAsk: _num(r.avg_fill_ask),
          })),
        },
      });
    } catch (e) {
      console.error(`[shadow-report] makerDay ${makerDay} failed:`, e?.message);
      return errorResponse("maker day query failed", 500);
    }
  }

  const reportDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const cacheKey = `${REPORT_CACHE_KEY_PREFIX}${reportDate}`;
  const bust = new URL(request.url).searchParams.get("bust") === "1";

  // Serve cached report for non-cron reads (cron always regenerates).
  if (!isCron && !bust) {
    const cached = cache ? await cache.get(cacheKey, "json").catch(() => null) : null;
    if (cached) return jsonResponse(cached);
    // No cached report. Past the 6am cron hour, an empty cache almost always means a cold-replica
    // read flagged the cron's report "incomplete" → 15-min TTL → it expired (the recurring 6:35am
    // miss). Rather than show the dead "not yet generated" state, regenerate once on this read — by
    // now the instance is warm so the resolution read is fresh. A short KV lock avoids a stampede;
    // before the cron hour there genuinely is no report yet, so keep the friendly stub.
    const ptHour = Number(new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false,
    })) % 24;
    if (cache && ptHour >= 6) {
      const lockKey = `shadow:report:lock:${reportDate}`;
      const locked = await cache.get(lockKey).catch(() => null);
      if (locked) return jsonResponse({ notYet: true, reportDate, regenerating: true });
      cache.put(lockKey, "1", { expirationTtl: 60 }).catch(() => {});
      // fall through to regenerate
    } else {
      return jsonResponse({ notYet: true, reportDate });
    }
  }

  const t0 = Date.now();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  // Yesterday in PT — the recap scopes to games played yesterday (pick.gameDate). Report runs
  // 6am PT, well clear of the midnight boundary, so a flat 24h subtraction is safe.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  let catRows, bandRows, clvRows, volRows, picksRows, healthRows, perGameRows, priceHistRows, brierRows, learnRows;
  try {
    [catRows, bandRows, clvRows, volRows, picksRows, healthRows, perGameRows, priceHistRows, brierRows, learnRows] = await Promise.all([
      // Q1: Category overview — one row per player/game (threshold_rank=1 dedup).
      // Window floored per-category at the current-formula cutoff (no superseded-formula mixing).
      neonQuery(`
        SELECT sport, COALESCE(stat, game_type) AS category,
          COUNT(*) AS n, SUM(won::int) AS wins,
          ROUND(AVG(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0, 4) AS avg_bet_pct,
          ROUND(AVG(edge), 2) AS avg_edge,
          MIN(snapshot_date) AS first_date
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND snapshot_date >= ${_formulaFloorSql("$1")} AND threshold_rank = 1
        GROUP BY sport, COALESCE(stat, game_type)
        ORDER BY n DESC LIMIT 20
      `, [since], env, { write: true }),

      // Q2: Band distribution (55–100%, n≥5) — where is there most data + biggest gap?
      neonQuery(`
        WITH src AS (
          SELECT sport, COALESCE(stat, game_type) AS category,
            model_true_pct AS bsp, -- bet-side 0–100 (shadow.js:1571); no under-flip (fixed 2026-06-19)
            won::int AS w,
            CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END AS bet_pct
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL AND snapshot_date >= ${_formulaFloorSql("$1")} AND threshold_rank = 1
        )
        SELECT sport, category,
          CASE
            WHEN bsp >= 95 THEN '95+' WHEN bsp >= 90 THEN '90-95' WHEN bsp >= 85 THEN '85-90'
            WHEN bsp >= 80 THEN '80-85' WHEN bsp >= 75 THEN '75-80' WHEN bsp >= 70 THEN '70-75'
            WHEN bsp >= 65 THEN '65-70' WHEN bsp >= 60 THEN '60-65' ELSE '55-60'
          END AS band,
          COUNT(*) AS n, SUM(w) AS wins,
          ROUND(AVG(bsp), 1) AS avg_bsp,
          ROUND(AVG(bet_pct)/100.0, 4) AS avg_bet_pct
        FROM src WHERE bsp >= 55
        GROUP BY sport, category, band HAVING COUNT(*) >= 5
        ORDER BY n DESC
      `, [since], env, { write: true }),

      // Q3: CLV — per-category avg line movement (3pm snapshot → 7pm pre-game stamp).
      neonQuery(`
        SELECT sport, COALESCE(stat, game_type) AS category,
          COUNT(*) AS n,
          ROUND(AVG(CASE WHEN direction='under'
            THEN (kalshi_no_price_pre - kalshi_no_price) * 100
            ELSE (kalshi_yes_price_pre - kalshi_yes_price) * 100 END), 2) AS avg_clv_pct,
          ROUND(AVG(CASE WHEN direction='under'
            THEN (model_true_pct/100.0 - 1 + kalshi_no_price_pre) * -100
            ELSE (model_true_pct/100.0 - kalshi_yes_price_pre) * 100 END), 2) AS avg_edge_at_close,
          ROUND(AVG(CASE WHEN direction='under'
            THEN (model_true_pct/100.0 - 1 + kalshi_no_price) * -100
            ELSE (model_true_pct/100.0 - kalshi_yes_price) * 100 END), 2) AS avg_edge_at_snap,
          ROUND(AVG(won::int) * 100, 1) AS hit_rate_pct
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND snapshot_date >= $1
          AND threshold_rank = 1 AND kalshi_yes_price_pre IS NOT NULL
          AND model_true_pct IS NOT NULL
        GROUP BY sport, COALESCE(stat, game_type) HAVING COUNT(*) >= 5
        ORDER BY n DESC
      `, [since], env, { write: true }),

      // Q4: Daily volume ROI — plays/day bucket vs realized ROI.
      neonQuery(`
        WITH daily AS (
          SELECT snapshot_date,
            COUNT(*) AS n_plays, SUM(won::int) AS wins,
            AVG(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 AS avg_price
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL AND snapshot_date >= $1 AND threshold_rank = 1
          GROUP BY snapshot_date
        )
        SELECT
          CASE WHEN n_plays<=2 THEN '1-2' WHEN n_plays<=4 THEN '3-4'
               WHEN n_plays<=6 THEN '5-6' WHEN n_plays<=9 THEN '7-9' ELSE '10+' END AS picks_bucket,
          CASE WHEN n_plays<=2 THEN 1 WHEN n_plays<=4 THEN 2
               WHEN n_plays<=6 THEN 3 WHEN n_plays<=9 THEN 4 ELSE 5 END AS bucket_order,
          COUNT(*) AS n_days, SUM(n_plays) AS total_plays,
          ROUND(AVG(n_plays), 1) AS avg_plays,
          ROUND(SUM(wins)::numeric / SUM(n_plays) * 100, 1) AS hit_rate_pct,
          ROUND(AVG(avg_price) * 100, 1) AS avg_price_pct,
          ROUND((SUM(wins)::numeric / SUM(n_plays)) - AVG(avg_price), 4) AS roi
        FROM daily
        GROUP BY picks_bucket, bucket_order ORDER BY bucket_order
      `, [since], env, { write: true }),

      // Q5: Today's top picks — qualified plays from this morning's snapshot.
      // Category gate is replicated from passesCategoryGate() in src/lib/constants.js.
      neonQuery(`
        SELECT sport, COALESCE(stat, game_type) AS category, stat, game_type,
          player_name, home_team, away_team, pick_team,
          direction, threshold, pick_line,
          ROUND(model_true_pct, 1) AS model_true_pct,
          ROUND(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END, 1) AS market_pct,
          ROUND(edge, 2) AS edge,
          game_time
        FROM shadow_plays
        WHERE snapshot_date = $1
          AND dc_qualified = TRUE
          AND edge >= 5
          AND is_best_edge = TRUE
          AND ${_CATEGORY_GATE_SQL}
        ORDER BY edge DESC LIMIT 5
      `, [reportDate], env, { write: true }),

      // Q6: Data health — yesterday's resolution + CLV capture (garbage-in guard).
      neonQuery(`
        SELECT
          COUNT(*) AS total,
          SUM(resolved::int) AS resolved,
          SUM((won IS NOT NULL)::int) AS scored,
          SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS clv_captured
        FROM shadow_plays
        WHERE game_date = $1
      `, [yesterday], env, { write: true }),

      // Q7: Picks-per-game calibration — among the gated bet set (dc_qualified, edge≥5,
      // Kalshi 67–91), rank picks within a game by edge and report ROI per within-game rank.
      // rnk=0 is the solo-game baseline; multi rows reveal whether the 2nd/3rd pick adds ROI.
      neonQuery(`
        WITH gated AS (
          SELECT edge, won::int AS w,
            CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END AS bet_pct,
            sport || '|' || LEAST(home_team, away_team) || '|' || GREATEST(home_team, away_team)
              || '|' || COALESCE(game_date, snapshot_date::text) AS game_key
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL AND dc_qualified AND edge >= 5
            AND threshold_rank = 1 AND home_team IS NOT NULL AND away_team IS NOT NULL
            AND snapshot_date >= $1
            AND (CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END) BETWEEN 67 AND 91
        ),
        ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY game_key ORDER BY edge DESC, bet_pct ASC) AS rnk,
            COUNT(*)     OVER (PARTITION BY game_key) AS game_n
          FROM gated
        )
        SELECT
          (game_n > 1) AS multi,
          CASE WHEN game_n > 1 THEN rnk ELSE 0 END AS rnk,
          COUNT(*) AS n,
          ROUND(100.0 * AVG(w), 1) AS hit_rate,
          ROUND(AVG(bet_pct), 1) AS avg_price,
          ROUND(100.0 * AVG(w) - AVG(bet_pct), 2) AS roi_pct
        FROM ranked
        GROUP BY 1, 2 ORDER BY 1, 2
      `, [since], env, { write: true }),

      // Q8: Price-band profitability — fine 5¢ grid of model-positive plays (dc_qualified,
      // edge ≥ server gate) across the FULL Kalshi price range. No 67–91 window and no truePct
      // category gate are applied — those are the assumptions under test, so the data shows where
      // the profitable window actually is. The server edge gate (looser than the client 5) is
      // the documented calibration bar and the loosest "model sees value" filter — maximizes
      // usable signal. Formula-windowed + threshold_rank=1 deduped like the other model Qs.
      neonQuery(`
        WITH bp AS (
          SELECT sport, COALESCE(stat, game_type) AS category,
            (CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END) AS price,
            won::int AS w
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL
            AND snapshot_date >= ${_formulaFloorSql("$1")}
            AND threshold_rank = 1 AND dc_qualified = TRUE AND edge >= ${EDGE_GATE_SERVER}
        )
        SELECT sport, category, (FLOOR(price/5)*5)::int AS price_lo,
          COUNT(*) AS n, SUM(w) AS wins, ROUND(AVG(price), 2) AS avg_price
        FROM bp WHERE price >= 1 AND price <= 99
        GROUP BY sport, category, price_lo
        ORDER BY sport, category, price_lo
      `, [since], env, { write: true }),

      // Q9: Proper-score head-to-head — model-Brier vs market-Brier per category over the
      // honesty population (all resolved formula-clean rows, threshold_rank=1; no edge/price
      // gate). `model_true_pct` is bet-side so it predicts `won` directly; the market bet-side
      // price is the no-side for UNDERs. skill = market − model (>0 = model sharper than price).
      // Same math as /api/auth/shadow-calibration?brier=1, surfaced live on the model board.
      neonQuery(`
        SELECT sport, COALESCE(stat, game_type) AS category,
          COUNT(*) AS n,
          AVG(POWER(model_true_pct/100.0 - (won)::int, 2)) AS model_brier,
          AVG(POWER((CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 - (won)::int, 2)) AS market_brier,
          -- Paired per-play skill difference (market_se − model_se); its mean IS the skill, its
          -- stddev gives the SE for a CI lower bound. >0 per play = model sharper on that play.
          STDDEV_SAMP(
            POWER((CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 - (won)::int, 2)
            - POWER(model_true_pct/100.0 - (won)::int, 2)
          ) AS skill_sd
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND snapshot_date >= ${_formulaFloorSql("$1")} AND threshold_rank = 1
          AND model_true_pct IS NOT NULL
        GROUP BY sport, COALESCE(stat, game_type)
      `, [since], env, { write: true }),

      // Q10: Learning curve (coarse) — is the model still LEARNING, or saturated? Splits each
      // category's current-formula population at its median snapshot_date (NTILE(2) chronological)
      // and computes paired Brier skill (market − model) in each half. skillTrend = recent − early:
      // >0 = skill rising as data accrues (still extracting signal → keep accruing), ≈0 = saturated
      // (reweighting tapped out; flat+below-price ⇒ needs a new input). Fine-grained per-checkpoint
      // curve + the β* step size live in `npm run tune:learncurve`; this is the board headline.
      neonQuery(`
        WITH halved AS (
          SELECT sport, COALESCE(stat, game_type) AS category,
            NTILE(2) OVER (PARTITION BY sport, COALESCE(stat, game_type) ORDER BY snapshot_date) AS half,
            POWER((CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 - (won)::int, 2)
              - POWER(model_true_pct/100.0 - (won)::int, 2) AS skill_i
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL AND snapshot_date >= ${_formulaFloorSql("$1")} AND threshold_rank = 1
            AND model_true_pct IS NOT NULL
        )
        SELECT sport, category,
          COUNT(*) FILTER (WHERE half = 1) AS n_early,
          COUNT(*) FILTER (WHERE half = 2) AS n_recent,
          AVG(skill_i) FILTER (WHERE half = 1) AS skill_early,
          AVG(skill_i) FILTER (WHERE half = 2) AS skill_recent
        FROM halved
        GROUP BY sport, category
      `, [since], env, { write: true }),
    ]);
  } catch (e) {
    console.error("[shadow-report] query failed:", e?.message);
    return errorResponse(`query failed: ${e?.message}`, 500);
  }

  // Process category overview. Window is current-formula only (Q1 floor); annotate the cutoff,
  // how many days the sample spans, and a significance verdict (gate-sample readiness).
  const _MS_DAY = 86400 * 1000;
  const categories = catRows.map(r => {
    const n = Number(r.n ?? 0);
    const wins = Number(r.wins ?? 0);
    const hitRate = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
    const avgBetPct = r.avg_bet_pct != null ? parseFloat(Number(r.avg_bet_pct).toFixed(4)) : null;
    const roi = hitRate != null && avgBetPct != null ? parseFloat((hitRate / 100 - avgBetPct).toFixed(4)) : null;
    const key = `${r.sport}|${r.category}`;
    const status = _isGatedCategory(key) ? "active"
      : n >= 50 && (roi ?? -1) > 0 ? "building"
      : n >= 30 && (roi ?? 0) <= 0 ? "losing"
      : "too_few";
    const formulaCutoff = FORMULA_CUTOFFS[key] ?? null;
    const effFloor = formulaCutoff && formulaCutoff > since ? formulaCutoff : since;
    const windowTrimmed = !!(formulaCutoff && formulaCutoff > since);
    const daysInWindow = Math.max(1, Math.round((Date.parse(reportDate) - Date.parse(effFloor)) / _MS_DAY));
    const sig = _calibSig({ n, hitRate, predicted: null, kind: "gate" });
    return {
      key, sport: r.sport, category: r.category, n, hitRate,
      roi, avgEdge: r.avg_edge != null ? parseFloat(Number(r.avg_edge).toFixed(2)) : null, status,
      formulaCutoff, windowTrimmed, daysInWindow, ...sig,
    };
  });

  // Process opportunity bands — calibration gap (actual vs predicted) with a formula-bar
  // verdict. Coherence is marked across ALL bands per category before the display slice, so a
  // 3+-adjacent-band same-direction miss is trusted even when individual bands are < n200.
  const allBands = bandRows.map(r => {
    const n = Number(r.n ?? 0);
    const wins = Number(r.wins ?? 0);
    const actual = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
    const predicted = _BAND_MID[r.band] ?? null;
    const delta = actual != null && predicted != null ? parseFloat((actual - predicted).toFixed(1)) : null;
    const avgBetPct = r.avg_bet_pct != null ? parseFloat(Number(r.avg_bet_pct).toFixed(4)) : null;
    const roi = actual != null && avgBetPct != null ? parseFloat((actual / 100 - avgBetPct).toFixed(4)) : null;
    const sig = _calibSig({ n, hitRate: actual, predicted, kind: "band" });
    return {
      key: `${r.sport}|${r.category}|${r.band}`,
      sport: r.sport, category: r.category, band: r.band,
      n, actual, predicted, delta, roi, coherent: false, ...sig,
    };
  });
  _markBandCoherence(allBands);
  // A coherent run is actionable even below n200 (coherence pools n, per doctrine).
  for (const b of allBands) if (b.coherent && b.verdict === "needs_n200" && Math.abs(b.delta ?? 0) > (b.se ?? 99)) b.verdict = "actionable";
  // Per-category calibration headline (model-honesty axis) + that category's own bands, for the
  // consolidated model board (each row fuses profitability + honesty into one "Do this" action).
  const _calibByCat = _calibSummaryByCat(allBands);
  const _bandsByCat = {};
  for (const b of allBands) (_bandsByCat[`${b.sport}|${b.category}`] ??= []).push(b);
  for (const arr of Object.values(_bandsByCat)) arr.sort((a, b) => _BAND_ORDER.indexOf(a.band) - _BAND_ORDER.indexOf(b.band));
  // Sort: most data first; within same n, largest |delta| first.
  const topBands = allBands
    .sort((a, b) => b.n !== a.n ? b.n - a.n : Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 15);

  // Model board — per-category price-band profitability. This is the single gate-decision
  // surface: it slices BETTABLE plays by market price (where ROI actually lives) across the
  // full range, derives the profitable window from data, and compares it to the current 67–91.
  // The truePct calibration (categories/topBands above) is the separate "is the model honest?"
  // check — NOT a competing profitability axis (calibration ≠ profit, the totalRuns lesson).
  const _catByKey = Object.fromEntries(categories.map(c => [c.key, c]));
  // Brier head-to-head per category (Q9) — model-vs-market probability quality. skill>0 = model
  // sharper than the price; the NEGATIVE verdict forks on it (market-sharper → Stay out).
  const _brierByCat = {};
  for (const r of (brierRows || [])) {
    const mb = r.model_brier != null ? parseFloat(Number(r.model_brier).toFixed(4)) : null;
    const kb = r.market_brier != null ? parseFloat(Number(r.market_brier).toFixed(4)) : null;
    const n = Number(r.n ?? 0);
    const skill = mb != null && kb != null ? parseFloat((kb - mb).toFixed(4)) : null;
    // 95% CI lower bound on skill (paired t, normal approx). >0 = model PROVABLY sharper than
    // the price, not just a Brier tie. Gates the "Look deeper" verdict so a tie reads "no edge".
    const sd = r.skill_sd != null ? Number(r.skill_sd) : null;
    const skillSe = sd != null && n > 1 ? sd / Math.sqrt(n) : null;
    const skillLoCI = skill != null && skillSe != null ? parseFloat((skill - 1.96 * skillSe).toFixed(4)) : null;
    _brierByCat[`${r.sport}|${r.category}`] = { n, modelBrier: mb, marketBrier: kb, skill, skillLoCI };
  }
  // Learning trend (Q10) — recent-half minus early-half paired Brier skill. >0 = still learning,
  // ≈0 = saturated. `reliable` once each half clears BRIER_MIN_N (Brier is noisy below that). β* is
  // the credibility weight on the calibration gap = the honest L2 de-shrink step (200 = formula-n).
  const _LEARN_K = 200;
  const _learnByCat = {};
  for (const r of (learnRows || [])) {
    const nE = Number(r.n_early ?? 0), nR = Number(r.n_recent ?? 0);
    const sE = r.skill_early != null ? Number(r.skill_early) : null;
    const sR = r.skill_recent != null ? Number(r.skill_recent) : null;
    const trend = sE != null && sR != null ? parseFloat((sR - sE).toFixed(4)) : null;
    const total = nE + nR;
    _learnByCat[`${r.sport}|${r.category}`] = {
      skillTrend: trend,
      betaStar: total > 0 ? parseFloat((total / (total + _LEARN_K)).toFixed(3)) : null,
      reliable: Math.min(nE, nR) >= BRIER_MIN_N,
    };
  }
  const _histByCat = {};
  for (const r of (priceHistRows || [])) {
    const key = `${r.sport}|${r.category}`;
    (_histByCat[key] ??= []).push({ lo: Number(r.price_lo), n: Number(r.n), wins: Number(r.wins), avgPrice: Number(r.avg_price) });
  }
  const bettingBoard = Object.keys(_histByCat).map(key => {
    const cells = _histByCat[key];
    const [sport, category] = key.split("|");
    const totalN = cells.reduce((s, c) => s + c.n, 0);
    const bins = _priceWindowBins(cells);
    const win = _discoverPriceWindow(cells);
    const gated = _isGatedCategory(key);
    const cat = _catByKey[key];
    // Sub-window opportunity: bettable plays priced BELOW the current 67¢ floor.
    const sub = cells.filter(c => c.lo < KALSHI_GATE);
    const subN = sub.reduce((s, c) => s + c.n, 0);
    const subWins = sub.reduce((s, c) => s + c.wins, 0);
    const subPSum = sub.reduce((s, c) => s + c.avgPrice * c.n, 0);
    const subRoi = subN > 0 ? subWins / subN - (subPSum / subN) / 100 : null;
    // Over-window: bettable plays priced ABOVE the current 91¢ cap.
    const hi = cells.filter(c => c.lo >= KALSHI_CAP);
    const hiN = hi.reduce((s, c) => s + c.n, 0);
    const hiWins = hi.reduce((s, c) => s + c.wins, 0);
    const hiPSum = hi.reduce((s, c) => s + c.avgPrice * c.n, 0);
    const hiRoi = hiN > 0 ? hiWins / hiN - (hiPSum / hiN) / 100 : null;

    // Validation ladder — three explicit promotion criteria so "act now" vs "still cooking" is
    // unambiguous and selection-bias-proof (the discovered window is ROI-maximized over many
    // candidate ranges, so the aggregate ROI is upward-biased; the CI + coherence gates are what
    // make it trustworthy). PROMOTE only when ALL pass.
    const q = win ? _windowQuality(cells, win) : null;
    const checklist = win && q ? {
      nOk: win.n >= _MIN_N_PROMOTE,          // enough bettable resolved plays
      ciOk: q.roiLoCI > 0,                    // ROI 95%-CI lower bound clears 0 (beats noise + price)
      coherentOk: q.coherent,                 // both price-halves non-negative (not a lucky slice)
    } : null;
    const allReady = checklist && checklist.nOk && checklist.ciOk && checklist.coherentOk;

    let verdict, hint = null, action = null;
    if (totalN < 20 || !win) {
      verdict = "BUILDING"; hint = `n=${totalN} bettable — accruing`;
    } else if (win.roi <= 0 || (q && q.roiHiCI < 0)) {
      verdict = "NEGATIVE"; hint = "no profitable price window — stay out";
    } else if (gated) {
      // Already bet. Pull only on a SIGNIFICANTLY negative window (CI upper bound < 0).
      verdict = (q && q.roiHiCI < 0) ? "DEMOTE" : "HOLD";
    } else if (allReady) {
      verdict = "PROMOTE";
      // Emit the exact command that makes the real decision, not an imperative to bet — the
      // checklist above is in-sample only (see _bettingAction's PROMOTE note).
      action = `verify ${key} @ ${win.lo}–${win.hi}¢ — npm run tune:window -- --category "${key}"`;
      hint = `in-sample ${win.lo}–${win.hi}¢ · ROI ${(win.roi * 100).toFixed(1)}% (CI-lo +${(q.roiLoCI * 100).toFixed(1)}%) · n=${win.n} · coherent — needs out-of-sample confirmation`;
    } else {
      // Positive but not yet validated — name exactly what's missing, in plain words.
      verdict = "STRENGTHENING";
      const missing = [];
      if (!checklist.nOk) missing.push(`more bets (${win.n}/${_MIN_N_PROMOTE})`);
      if (!checklist.ciOk) missing.push("edge not proven yet — could still be luck");
      if (!checklist.coherentOk) missing.push("profit too concentrated in one price slice");
      hint = `${win.lo}–${win.hi}¢ ROI ${(win.roi * 100).toFixed(1)}% — needs: ${missing.join("; ")}`;
    }

    // The bridge: a category is bettable only if the model provably beats the price (Brier skill CI
    // lo > 0). Computed straight from the Brier row — the accuracy verdict is now calibration-based.
    const _b = _brierByCat[key];
    const eligible = _b?.skillLoCI != null && _b.skillLoCI > 0 && (_b.n || 0) >= BRIER_MIN_N;
    const doThis = _bettingAction(verdict, gated, eligible, hint);

    return {
      key, sport, category, gated, eligible, n: totalN,
      currentWindow: [KALSHI_GATE, KALSHI_CAP],
      discoveredWindow: win ? { ...win, roiLoCI: q?.roiLoCI ?? null, roiHiCI: q?.roiHiCI ?? null, coherent: q?.coherent ?? null } : null,
      checklist,
      subWindow: subRoi != null ? { roi: parseFloat(subRoi.toFixed(4)), n: subN } : null,
      overWindow: hiRoi != null ? { roi: parseFloat(hiRoi.toFixed(4)), n: hiN } : null,
      priceBands: bins,
      verdict, hint, action, doThis,
      roi: cat?.roi ?? null,
      formulaCutoff: cat?.formulaCutoff ?? null,
      daysInWindow: cat?.daysInWindow ?? null,
    };
  }).sort((a, b) => b.n - a.n);

  // ── Model ACCURACY board (Layer 1) — calibration vs reality, NO price ──
  // Verdict scored on truePct calibration (model% vs actual hit%). Brier skill is carried as the
  // secondary "vs market" signal + the betting bridge (eligible above). Keyed on the UNION of the
  // Brier and calibration populations (a category can have calib bands but no Brier row, or vice-versa).
  const _accKeys = new Set([...Object.keys(_brierByCat), ...Object.keys(_bandsByCat)]);
  const accuracyBoard = [..._accKeys].map(key => {
    const [sport, category] = key.split("|");
    const brier = _brierByCat[key] ?? { n: 0, modelBrier: null, marketBrier: null, skill: null, skillLoCI: null };
    const calib = _calibByCat[key] ?? { status: "insufficient", direction: null, delta: null, band: null, n: null };
    const verdict = _accuracyVerdict(calib, brier, _learnByCat[key]);
    const honest = _accuracyAction(verdict, calib, brier.skill, brier.n);
    // `active` = this truePct slice is in the live category gate right now. Bands are 5-wide and
    // aligned to the gate's 5-boundaries, so the band midpoint membership-tests the gate exactly.
    const calibBands = (_bandsByCat[key] || []).map(b => ({
      band: b.band, n: b.n, predicted: b.predicted, actual: b.actual, delta: b.delta, verdict: b.verdict, coherent: b.coherent,
      active: passesCategoryGate({ sport, stat: category, truePct: b.predicted }),
    }));
    return {
      key, sport, category, gated: _isGatedCategory(key),
      // Stamped so the frontend's exhaustion maps (INPUT_SEARCH_EXHAUSTED et al.) can auto-un-suppress
      // a category whose formula reset AFTER its search was exhausted (clean data re-opens the search).
      formulaCutoff: FORMULA_CUTOFFS[key] ?? null,
      n: brier.n, skill: brier.skill, skillLoCI: brier.skillLoCI,
      modelBrier: brier.modelBrier, marketBrier: brier.marketBrier,
      learning: _learnByCat[key] ?? null,
      verdict, honest, calib, calibBands,
    };
  }).sort((a, b) => (b.skill ?? -9) - (a.skill ?? -9));

  // Process CLV analysis.
  const clv = clvRows.map(r => ({
    key: `${r.sport}|${r.category}`,
    sport: r.sport, category: r.category,
    n: Number(r.n ?? 0),
    avgClvPct: r.avg_clv_pct != null ? parseFloat(Number(r.avg_clv_pct).toFixed(2)) : null,
    avgEdgeAtSnap: r.avg_edge_at_snap != null ? parseFloat(Number(r.avg_edge_at_snap).toFixed(2)) : null,
    avgEdgeAtClose: r.avg_edge_at_close != null ? parseFloat(Number(r.avg_edge_at_close).toFixed(2)) : null,
    hitRatePct: r.hit_rate_pct != null ? parseFloat(Number(r.hit_rate_pct).toFixed(1)) : null,
  }));

  // Process picks-per-game calibration + derive the optimal same-game cap.
  const perGameRoi = (perGameRows || []).map(r => ({
    multi: r.multi === true || r.multi === "t",
    rnk: Number(r.rnk ?? 0),
    n: Number(r.n ?? 0),
    hitRate: r.hit_rate != null ? parseFloat(Number(r.hit_rate).toFixed(1)) : null,
    avgPrice: r.avg_price != null ? parseFloat(Number(r.avg_price).toFixed(1)) : null,
    roiPct: r.roi_pct != null ? parseFloat(Number(r.roi_pct).toFixed(2)) : null,
  }));
  // Cap = highest within-game rank where each rank 1..k still has positive ROI (n≥10 each).
  let optimalPerGameCap = null;
  const multiRanks = perGameRoi.filter(r => r.multi && r.rnk >= 1).sort((a, b) => a.rnk - b.rnk);
  for (const r of multiRanks) {
    if (r.n >= 10 && (r.roiPct ?? -1) > 0) optimalPerGameCap = r.rnk;
    else break;
  }

  // Process data health — coverage (KV from snapshot cron) + yesterday's resolution/CLV capture.
  let dataHealth = null;
  try {
    const covKV = cache ? await cache.get(`shadow:coverage:${yesterday}`, "json").catch(() => null) : null;
    // Robust resolution read — seeded with Q6 (healthRows), cross-checked + retried against cold-wake
    // replica lag so a stale-low count can't false-flag the report incomplete (→ 15-min TTL → vanish).
    const rr = await _readResolutionRobust(yesterday, env, healthRows?.[0], cache);
    const total = rr.total, resolved = rr.resolved, scored = rr.scored;
    // CLV capture is a per-snapshot_date operation: pregame-snap stamps kalshi_yes_price_pre on the
    // rows it processed THAT day (matched against that day's live staging). Measuring it over
    // game_date=yesterday is the wrong cohort — it mixes in rows snapshotted on OTHER days (whose CLV
    // was attempted by those days' pipelines) and counts markets that never had a live pre-game window,
    // dragging the rate misleadingly low. Scope to snapshot_date=yesterday = exactly the plays
    // yesterday's pregame-snap targeted (complete by report time — the last pregame cron for game_date
    // T runs 03:00 UTC = 8pm PT on day T). Failure-closed → no CLV warning rather than a false one.
    let clvCaptured = 0, clvEligible = 0;
    try {
      const cr = await neonQuery(
        `SELECT COUNT(*) AS eligible, SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS captured
           FROM shadow_plays WHERE snapshot_date = $1`,
        [yesterday], env, { write: true }
      );
      clvEligible = Number(cr?.[0]?.eligible ?? 0);
      clvCaptured = Number(cr?.[0]?.captured ?? 0);
    } catch (e) { console.error("[shadow-report] CLV cohort read failed:", e?.message); }
    const warnings = [];
    const covWarned = !!covKV?.coverageWarning;
    if (covWarned) {
      const covStr = Object.entries(covKV.coverage || {}).map(([sp, c]) => `${sp} ${c.games}/${c.scheduled}`).join(", ");
      warnings.push(`Slate under-logged yesterday (${covStr}) — model numbers may be incomplete.`);
    }
    // Re-runnable gate (2026-06-30). A day-1 report ALWAYS shows a resolution shortfall that re-running
    // the resolver right now can't close: shadow-only soccer/tennis resolve late (event-summary / name-
    // lookup) and totals age out of the today+tomorrow live window — those rows self-heal over the next
    // 1-2 days of scheduled passes (prior days mature to ~100%), and an immediate re-run resolves ~0 of
    // them (confirmed live: trigger → resolved 0-2). So flagging `actionable` on a flat `<0.9` nagged
    // "Fix data health" every morning with nothing to DO. (A trailing-baseline anomaly check is wrong
    // too — it compares today at 1-day maturity against prior days at full maturity, so it over-flags.)
    // The ONLY case re-running now recovers is a catastrophic pass failure — a cron swallow / cold-start
    // abort (the 6/18 7/889 ≈ 0.8%) where games ARE final but the pass processed ~nothing. That lands an
    // order of magnitude below the normal ~87% day-1 floor, so a low ABSOLUTE threshold separates them
    // cleanly with wide margin. `pending` stays exposed; the warning + actionable both gate on it.
    const todayRate = total > 0 ? resolved / total : 1;
    const ACTIONABLE_RESOLVE_FLOOR = 0.5; // < this = catastrophic pass failure, not normal day-1 lag
    const resolutionFailed = total > 0 && todayRate < ACTIONABLE_RESOLVE_FLOOR;
    // Caution strip warns only on a real failure now (a normal day-1 floor is not "ROI partial").
    if (resolutionFailed) warnings.push(`Only ${resolved}/${total} of yesterday's plays resolved — re-run the resolver (ROI partial).`);
    const clvWarned = clvEligible > 0 && clvCaptured / clvEligible < 0.5;
    if (clvWarned) warnings.push(`CLV captured for only ${clvCaptured}/${clvEligible} of yesterday's snapshotted plays.`);
    // Streak escalation (2026-07-01): ONE day's coverage under-log / CLV dip is caution-only — that
    // yesterday is closed and unrecoverable, nothing to do (the rationale above). But the SAME warning
    // ≥2 days running is a different animal: a live pipeline bug (the 6/10 pregame-snap-502 shape)
    // that a fix TODAY stops from eating tonight's slate — so a streak flips `actionable`. Counter is
    // a per-report-date KV breadcrumb: read the prior day's counts, extend or reset, write under
    // today's key only when warned (a missing day-key naturally reads as a reset). Keying by report
    // date makes ?bust=1 regens idempotent. Failure-closed: a KV error just skips escalation.
    let healthStreak = null;
    try {
      if (cache) {
        const dayBefore = new Date(Date.parse(`${yesterday}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
        const prev = await cache.get(`shadow:healthstreak:${dayBefore}`, "json").catch(() => null);
        healthStreak = {
          coverage: covWarned ? 1 + Number(prev?.coverage || 0) : 0,
          clv: clvWarned ? 1 + Number(prev?.clv || 0) : 0,
        };
        if (covWarned || clvWarned)
          await cache.put(`shadow:healthstreak:${yesterday}`, JSON.stringify(healthStreak), { expirationTtl: 86400 * 4 }).catch(() => {});
      }
    } catch (e) { console.error("[shadow-report] health-streak read skipped:", e?.message); }
    const streakParts = [];
    if ((healthStreak?.coverage || 0) >= 2) streakParts.push(`coverage under-log ${healthStreak.coverage} days running`);
    if ((healthStreak?.clv || 0) >= 2) streakParts.push(`CLV capture failing ${healthStreak.clv} days running`);
    if (streakParts.length) warnings.push(`Repeated data-health failure (${streakParts.join("; ")}) — a live pipeline bug, not one-day noise. Investigate the ${(healthStreak?.coverage || 0) >= 2 ? "snapshot/coverage" : "pregame-snap"} path today.`);
    // `actionable` = is there a data-health issue you can DO something about today? A catastrophic
    // resolution failure qualifies (a warm re-run recovers it), and so does a ≥2-day coverage/CLV
    // streak (a live bug a fix today stops from repeating). A single day-1 self-healing lag, coverage
    // under-log, or CLV dip is about a now-closed yesterday and unrecoverable-by-action, so it stays
    // caution-only (the ⚠ strip), NOT a "Do this today" action. The frontend's tier-1 banner fires only
    // when this is true so it never promotes an unfixable/self-healing caution into the day's primary to-do.
    dataHealth = {
      coverage: covKV?.coverage ?? null,
      coverageWarning: covKV?.coverageWarning ?? null,
      resolution: {
        total, resolved, scored, pending: Math.max(0, total - resolved),
        ratePct: total > 0 ? parseFloat((todayRate * 100).toFixed(0)) : null,
        failed: resolutionFailed,
      },
      clvCapture: { captured: clvCaptured, eligible: clvEligible, pct: clvEligible > 0 ? parseFloat((clvCaptured / clvEligible * 100).toFixed(0)) : null },
      streak: healthStreak,
      warnings,
      actionable: resolutionFailed || streakParts.length > 0,
    };
  } catch (e) {
    console.error("[shadow-report] dataHealth skipped:", e?.message);
  }

  // Process daily volume ROI + derive optimal picks/day recommendation.
  const dailyVolumeRoi = volRows.map(r => ({
    picksBucket: r.picks_bucket,
    nDays: Number(r.n_days ?? 0),
    totalPlays: Number(r.total_plays ?? 0),
    avgPlays: r.avg_plays != null ? parseFloat(Number(r.avg_plays).toFixed(1)) : null,
    hitRatePct: r.hit_rate_pct != null ? parseFloat(Number(r.hit_rate_pct).toFixed(1)) : null,
    avgPricePct: r.avg_price_pct != null ? parseFloat(Number(r.avg_price_pct).toFixed(1)) : null,
    roi: r.roi != null ? parseFloat(Number(r.roi).toFixed(4)) : null,
  }));

  // Derive optimal picks/day from buckets with at least 3 sample days.
  let optimalDailyPicks = null;
  const eligible = dailyVolumeRoi.filter(r => r.nDays >= 3);
  if (eligible.length > 0) {
    const best = eligible.reduce((a, b) => ((b.roi ?? -Infinity) > (a.roi ?? -Infinity) ? b : a));
    // First bucket (sorted ascending) where ROI turns negative — stop before it.
    const firstNeg = dailyVolumeRoi.find(r => r.nDays >= 3 && (r.roi ?? 0) < 0);
    optimalDailyPicks = {
      bucket: best.picksBucket,
      roi: best.roi,
      nDays: best.nDays,
      stopAt: firstNeg?.picksBucket ?? null,
      confidence: eligible.some(r => r.nDays >= 10) ? "medium" : "low",
    };
  }

  // Process today's top picks.
  const topPicks = picksRows.map(r => ({
    sport: r.sport,
    category: r.category,
    playerName: r.player_name ?? null,
    homeTeam: r.home_team ?? null,
    awayTeam: r.away_team ?? null,
    pickTeam: r.pick_team ?? null,
    direction: r.direction ?? null,
    threshold: r.threshold != null ? parseFloat(Number(r.threshold).toFixed(1)) : null,
    pickLine: r.pick_line != null ? parseFloat(Number(r.pick_line).toFixed(1)) : null,
    modelTruePct: r.model_true_pct != null ? parseFloat(Number(r.model_true_pct).toFixed(1)) : null,
    marketPct: r.market_pct != null ? parseFloat(Number(r.market_pct).toFixed(1)) : null,
    edge: r.edge != null ? parseFloat(Number(r.edge).toFixed(2)) : null,
    gameTime: r.game_time ?? null,
  }));

  // Newly-listed Kalshi markets we don't consume yet (status='new' in kalshi_series_seen,
  // populated by the /api/kalshi-series-scan cron). Separate try/catch — the table may not
  // exist yet on first deploy, and a discovery miss must never break the briefing.
  // `new` = detected (un-triaged); `shortlisted` = promoted, being vetted. Both carry the
  // triage-hint columns (live_market_count + window_fit) the series-scan cron refreshes daily.
  const queryDiscovered = async (status) => {
    try {
      const rows = await neonQuery(`
        SELECT ticker, title, tags, frequency, sample_market, sample_subtitle,
               live_market_count, window_fit, first_seen
        FROM kalshi_series_seen WHERE status = $1
        ORDER BY first_seen DESC, ticker LIMIT 25
      `, [status], env, { write: true });
      return rows.map(r => ({
        ticker: r.ticker,
        title: r.title ?? null,
        tags: r.tags ?? null,
        frequency: r.frequency ?? null,
        sampleMarket: r.sample_market ?? null,
        sampleSubtitle: r.sample_subtitle ?? null,
        liveMarketCount: r.live_market_count ?? null,
        windowFit: r.window_fit ?? null,
        firstSeen: r.first_seen ? new Date(r.first_seen).toISOString().slice(0, 10) : null,
      }));
    } catch (e) {
      console.error(`[shadow-report] ${status} markets query skipped:`, e?.message);
      return [];
    }
  };
  // Polymarket league funnel (polymarket_sports_seen, populated by /api/polymarket-scan) merges
  // into the SAME newMarkets/shortlistedMarkets arrays: `ticker` = Gamma sport slug (can't collide
  // with KX* series tickers or SERIES_CONFIG), venue:"polymarket". One display chokepoint — the
  // ReportPage triage/shortlist banners and the brief's fresh-detection diff (both keyed on
  // m.ticker / m.title) pick these up with no frontend change.
  const queryPolyDiscovered = async (status) => {
    try {
      const rows = await neonQuery(`
        SELECT sport, series_id, sample_event, live_event_count, market_types, first_seen
        FROM polymarket_sports_seen WHERE status = $1
        ORDER BY first_seen DESC, sport LIMIT 25
      `, [status], env, { write: true });
      return rows.map(r => ({
        venue: "polymarket",
        ticker: r.sport,
        title: `Polymarket league: ${r.sport}`,
        tags: r.market_types ?? null,
        frequency: null,
        sampleMarket: r.series_id != null ? `series ${r.series_id}` : null,
        sampleSubtitle: r.sample_event ?? null,
        liveMarketCount: r.live_event_count ?? null,
        windowFit: null,
        firstSeen: r.first_seen ? new Date(r.first_seen).toISOString().slice(0, 10) : null,
      }));
    } catch (e) {
      console.error(`[shadow-report] poly ${status} markets query skipped:`, e?.message);
      return [];
    }
  };
  const [kNewMarkets, kShortlistedMarkets, pNewMarkets, pShortlistedMarkets] = await Promise.all([
    queryDiscovered("new"),
    queryDiscovered("shortlisted"),
    queryPolyDiscovered("new"),
    queryPolyDiscovered("shortlisted"),
  ]);
  const newMarkets = [...kNewMarkets, ...pNewMarkets];
  const shortlistedMarkets = [...kShortlistedMarkets, ...pShortlistedMarkets];

  // Cross-venue kill-gate (sportsbook reference): does Kalshi systematically LAG the de-vigged sharp
  // book? Live read of the sportsbook_deltas accrual over the bettable in-window [67,91] band, so
  // /model + the Do-This banner reflect the actual answer (not a static date reminder). delta_cents =
  // bookFair − kalshi, so mean_signed > 0 = Kalshi cheap vs the book = the lag edge. Failure-closed.
  let sportsbookValidation = null;
  try {
    const _SB_DAYS = 7;
    // The kill-gate metric is the BUY-EDGE FREQUENCY: how often a Kalshi side is CHEAP vs the
    // de-vigged sharp book (delta_cents = bookFair − kalshi ≥ +3 = a ≥3¢ buy). NOT mean(delta): both
    // sides of a game are mirror images, so mean(delta) ≈ −(Kalshi overround), not lag. NOT |delta|:
    // that counts the expensive side you'd never buy. No [67,91] restriction — the cross-venue edge
    // is "buy the cheap side", not bounded by the prop model window. All rows are liquidity-gated at
    // emit, so this is the traded-line population.
    const [agg] = await neonQuery(`
      SELECT count(*)::int AS n, count(distinct snapshot_date)::int AS days,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        avg(CASE WHEN delta_cents >= 3 THEN 1.0 ELSE 0 END) AS frac_buy3,
        avg(CASE WHEN delta_cents >= 5 THEN 1.0 ELSE 0 END) AS frac_buy5
      FROM ${SB_DELTAS_TABLE}
      WHERE snapshot_date >= CURRENT_DATE - $1::int`, [_SB_DAYS], env, { write: true });
    const n = Number(agg?.n || 0), days = Number(agg?.days || 0);
    const medianAbs = agg?.median_abs != null ? parseFloat(Number(agg.median_abs).toFixed(2)) : null;
    const fracBuyEdge3 = agg?.frac_buy3 != null ? parseFloat(Number(agg.frac_buy3).toFixed(3)) : null;
    const fracBuyEdge5 = agg?.frac_buy5 != null ? parseFloat(Number(agg.frac_buy5).toFixed(3)) : null;
    // Verdict ladder (kill-gate CLOSED 2026-07-04 — TIGHT confirmed on clean data, Phase 1b
    // killed; the ladder now feeds the tripwire readouts, not a build decision):
    //   ACCRUING — too little to read (n<60 sides ≈ <30 games, or <3 days).
    //   GAP      — Kalshi is cheap vs the book ≥3¢ on ≥10% of traded sides → post-kill this means
    //              regime change OR artifact — audit the ?minAbs=3 tail first (both prior fat
    //              tails were fake), don't resurrect Phase 1b off one window.
    //   TIGHT    — venues track → no liquid lag edge (the confirmed steady state).
    let verdict;
    if (n < 60 || days < 3) verdict = "ACCRUING";
    else if ((fracBuyEdge3 ?? 0) >= 0.10) verdict = "GAP";
    else verdict = "TIGHT";
    sportsbookValidation = { n, days, windowDays: _SB_DAYS, medianAbs, fracBuyEdge3, fracBuyEdge5, verdict };
  } catch (e) { console.error("[shadow-report] sportsbook validation skipped:", e?.message); }

  // Cross-venue kill-gate (Polymarket): same read over polymarket_deltas, so the daily brief covers
  // BOTH observatories (before this the report only carried the sportsbook one — the Poly answer
  // lived solely in /api/polymarket-deltas). Adds the Phase-1b executable read: exec_delta_cents =
  // polyVWAP − kalshi, so ≤−3 = still ≥3¢ cheaper to BUY on Poly after walking the book = the
  // surviving edge. Verdict ladder mirrors the sportsbook one. Failure-closed.
  let polymarketValidation = null;
  try {
    const _PM_DAYS = 7;
    const [agg] = await neonQuery(`
      SELECT count(*)::int AS n, count(distinct snapshot_date)::int AS days,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        avg(CASE WHEN delta_cents >= 3 THEN 1.0 ELSE 0 END) AS frac_buy3,
        avg(CASE WHEN delta_cents >= 5 THEN 1.0 ELSE 0 END) AS frac_buy5,
        count(exec_delta_cents)::int AS exec_n,
        avg(CASE WHEN exec_delta_cents <= -3 THEN 1.0 ELSE 0 END)
          FILTER (WHERE exec_delta_cents IS NOT NULL) AS exec_frac3
      FROM ${POLY_DELTAS_TABLE}
      WHERE snapshot_date >= CURRENT_DATE - $1::int`, [_PM_DAYS], env, { write: true });
    const n = Number(agg?.n || 0), days = Number(agg?.days || 0);
    const medianAbs = agg?.median_abs != null ? parseFloat(Number(agg.median_abs).toFixed(2)) : null;
    const fracBuyEdge3 = agg?.frac_buy3 != null ? parseFloat(Number(agg.frac_buy3).toFixed(3)) : null;
    const fracBuyEdge5 = agg?.frac_buy5 != null ? parseFloat(Number(agg.frac_buy5).toFixed(3)) : null;
    const execN = Number(agg?.exec_n || 0);
    const execFracEdge3 = agg?.exec_frac3 != null ? parseFloat(Number(agg.exec_frac3).toFixed(3)) : null;
    let verdict;
    if (n < 60 || days < 3) verdict = "ACCRUING";
    else if ((fracBuyEdge3 ?? 0) >= 0.10) verdict = "GAP";
    else verdict = "TIGHT";
    polymarketValidation = { n, days, windowDays: _PM_DAYS, medianAbs, fracBuyEdge3, fracBuyEdge5, execN, execFracEdge3, verdict };
  } catch (e) { console.error("[shadow-report] polymarket validation skipped:", e?.message); }

  // Shadow maker board (api/lib/maker.js, 2026-07-19) — simulated favorite-ask quoting.
  // Three reads: quote volume, fill economics (the arm decision input), and the adverse-
  // selection check (see `adverseSelection` below — compared WITHIN price band since 2026-07-26,
  // because the filled and quoted populations sit at very different prices).
  // Arm criterion: see `armCriterion` — n≥200 fills AND ≥14 days AND dayClustered.loCI>0.
  // Failure-closed.
  let makerBoard = null;
  try {
    const [[mq], [mf], _qoRows, _mDaily, _mBands, _mCatBandDay] = await Promise.all([
      neonQuery(`
        SELECT COUNT(*)::int AS segments, COUNT(DISTINCT ticker)::int AS tickers,
          COUNT(DISTINCT game_date)::int AS days, ROUND(AVG(quote_ask), 1) AS avg_ask
        FROM maker_quotes WHERE game_date >= $1 AND source = 'live'`, [since], env, { write: true }),
      neonQuery(`
        SELECT COUNT(*)::int AS fills, COALESCE(SUM(f.contracts), 0) AS contracts,
          COUNT(*) FILTER (WHERE f.graded_at IS NOT NULL)::int AS graded,
          ROUND(AVG(f.pnl_cents) FILTER (WHERE f.graded_at IS NOT NULL), 2) AS avg_pnl,
          ROUND(STDDEV_SAMP(f.pnl_cents) FILTER (WHERE f.graded_at IS NOT NULL), 2) AS sd_pnl,
          ROUND(AVG((f.side_won)::int::numeric) FILTER (WHERE f.graded_at IS NOT NULL), 4) AS side_won_rate,
          ROUND(AVG(f.fill_ask), 1) AS avg_fill_ask,
          ${weightedPnlSumsSql({ pnlCol: "f.pnl_cents", contractsCol: "f.contracts", filter: "f.graded_at IS NOT NULL" })}
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.game_date >= $1 AND q.source = 'live'`, [since], env, { write: true }),
      // Quoted-outcome counterfactual, aggregated per (band, ticker, side) — side_won is resolved
      // directly off Kalshi's own settlement (resolveTickerSideViaKalshi, kalshi-settlement.js)
      // after this query returns, same source gradeMakerFills uses (2026-07-24 rewrite), so it
      // can't drift out of sync the way the pre-2026-07-22 duplicated CASE-WHEN copy did.
      //
      // **Rewritten 2026-07-26 — was `DISTINCT ON (ticker, game_date) … ORDER BY valid_from DESC`,
      // i.e. ONE row per ticker-day, the FINAL quote.** That made the "quoted" population sit ~2.1¢
      // higher in price than the quoting activity it was meant to represent (last-quote avgAsk 75.3
      // vs 73.2 across all segments), while fills are drawn from any of ~10 segments per ticker-day.
      // Since measured edge swings hard by price band, the old aggregate compared two different
      // price distributions and the adverse-selection number was confounded — it read +1.45¢ on
      // 7/25 and NEGATIVE (fills better than quotes, mechanically backwards) on 7/26. Now every
      // segment counts, bucketed by its own band, so quoted-vs-filled is a within-band comparison.
      // Grouping keeps the row count ~ tickers × bands-visited (~15k) rather than one row/segment.
      neonQuery(`
        SELECT ${_makerBandCase("quote_ask")} AS band, ticker, quote_side,
          COUNT(*)::int AS segments, COALESCE(SUM(quote_ask), 0)::numeric AS sum_ask
        FROM maker_quotes WHERE game_date >= $1 AND source = 'live'
        GROUP BY 1, ticker, quote_side`, [since], env, { write: true }),
      // Daily fill series — feeds the /model paper equity curve (frontend cumsums pnl_total) and
      // the day-clustered CI. `contracts_graded` is deliberately separate from `contracts`: the
      // latter counts ungraded fills too, and pairing it with a graded-only `pnl_total` would bias
      // the clustered ratio estimator's denominator.
      neonQuery(`
        SELECT q.game_date AS day, COUNT(*)::int AS fills,
          COALESCE(SUM(f.contracts), 0) AS contracts,
          COALESCE(SUM(f.contracts) FILTER (WHERE f.graded_at IS NOT NULL), 0) AS contracts_graded,
          COUNT(*) FILTER (WHERE f.graded_at IS NOT NULL)::int AS graded,
          COALESCE(SUM(f.pnl_cents * f.contracts) FILTER (WHERE f.graded_at IS NOT NULL), 0) AS pnl_total
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.game_date >= $1 AND q.source = 'live'
        GROUP BY q.game_date ORDER BY q.game_date`, [since], env, { write: true }),
      // Per-ask-band quote/fill economics — feeds the /model band ladder (V2 targeting view).
      neonQuery(`
        WITH qb AS (
          SELECT ${_makerBandCase("quote_ask")} AS band,
            COUNT(*)::int AS segments
          FROM maker_quotes WHERE game_date >= $1 AND source = 'live' GROUP BY 1),
        fb AS (
          SELECT ${_makerBandCase("f.fill_ask")} AS band,
            COUNT(*)::int AS fills,
            COUNT(*) FILTER (WHERE f.graded_at IS NOT NULL)::int AS graded,
            ROUND(AVG(f.pnl_cents) FILTER (WHERE f.graded_at IS NOT NULL), 2) AS avg_pnl,
            ROUND(AVG((f.side_won)::int::numeric) FILTER (WHERE f.graded_at IS NOT NULL), 4) AS filled_side_won
          FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
          WHERE q.game_date >= $1 AND q.source = 'live' GROUP BY 1)
        SELECT COALESCE(qb.band, fb.band) AS band, COALESCE(qb.segments, 0) AS segments,
          COALESCE(fb.fills, 0) AS fills, COALESCE(fb.graded, 0) AS graded,
          fb.avg_pnl, fb.filled_side_won
        FROM qb FULL OUTER JOIN fb ON fb.band = qb.band ORDER BY 1`, [since], env, { write: true }),
      // Category × band × DAY graded economics — the diagnostic grain (2026-07-29). This is the
      // slice that LOCALIZES anomalies band/total pooling hides: the 55-64 "edge" that kicked off
      // the wrong-side-fill investigation was one category (ligamx|teamTotal at +52¢, an impossible
      // value) buried inside a price band that averaged 16 categories. Day is carried so the
      // frontend can compute top-day concentration per cell (the anti-selection check) and flag a
      // cell whose whole result is one slate. Graded fills only.
      neonQuery(`
        SELECT COALESCE(q.sport,'?') AS sport, COALESCE(q.category, q.sport, '?') AS category,
          ${_makerBandCase("f.fill_ask")} AS band, q.game_date AS day,
          COUNT(*)::int AS fills,
          COALESCE(SUM(f.contracts), 0)::numeric AS contracts,
          COALESCE(SUM(f.pnl_cents * f.contracts), 0)::numeric AS pnl_total,
          COALESCE(SUM((f.side_won)::int::numeric * f.contracts), 0)::numeric AS won_contracts,
          ROUND(AVG(f.fill_ask), 1) AS avg_fill_ask
        FROM maker_fills f JOIN maker_quotes q ON q.id = f.quote_id
        WHERE q.game_date >= $1 AND q.source = 'live' AND f.graded_at IS NOT NULL
        GROUP BY 1, 2, 3, 4`, [since], env, { write: true }),
    ]);
    const graded = Number(mf?.graded || 0);
    const avgPnl = mf?.avg_pnl != null ? Number(mf.avg_pnl) : null;
    const sd = mf?.sd_pnl != null ? Number(mf.sd_pnl) : null;
    // FILL-LEVEL CI — superseded 2026-07-26, renamed 2026-07-28. Treats every fill as an
    // independent observation; fills sharing a day share one slate, so this understates the spread
    // ~5x. It has produced a false green on this board FOUR times, including the 2026-07-21 reading
    // that put real money at risk. Emitted as `pnlLoCI_fillLevel_SUPERSEDED` precisely so it cannot
    // be picked up by autocomplete or a casual grep for "pnlLoCI" and mistaken for the arm gate.
    // The gate is `armCriterion.met` (which reads `dayClustered.loCI`).
    const _fillLevelPnlLoCI = avgPnl != null && sd != null && graded > 1
      ? parseFloat((avgPnl - 1.96 * sd / Math.sqrt(graded)).toFixed(2)) : null;
    const weightedV1 = weightedPnlFromRow(mf);
    const _v1Daily = (_mDaily || []).map(r => ({
      day: String(r.day).slice(0, 10), fills: Number(r.fills || 0),
      contracts: Number(r.contracts || 0), graded: Number(r.graded || 0),
      contractsGraded: Number(r.contracts_graded || 0),
      pnlTotal: parseFloat(Number(r.pnl_total || 0).toFixed(1)),
    }));
    // Day-clustered CI (2026-07-26) — the honest interval. `weighted` above treats each FILL as
    // independent; fills sharing a day share game outcomes and one common favorites-covered factor,
    // so the real sample size is days, not fills. Read THIS before any arm decision.
    const dayClusteredV1 = dayClusteredPnl({
      days: _v1Daily.map(d => ({ pnl: d.pnlTotal, contracts: d.contractsGraded })),
    });
    // Not every quoted ticker is Kalshi-finalized yet (e.g. today's still-live games) —
    // resolveTickerSideViaKalshi returns null for those; excluded from both n and the rate,
    // same "not resolvable this pass" semantics as the dry-run comparison and V1 grading.
    const _qoTickers = [...new Set(_qoRows.map(r => r.ticker))];
    const _qoSettlements = _qoTickers.length ? await fetchKalshiSettlements(_qoTickers) : new Map();
    // Roll-up + within-band adverse selection live in maker-stats.js as pure functions (extracted
    // 2026-07-26 — this diagnostic had been wrong twice while it was untested inline code). The
    // settlement resolution stays here; the math is unit-tested over plain rows.
    const qo = quotedOutcomesByBand(_qoRows.map(r => ({
      band: r.band, ticker: r.ticker, segments: r.segments, sumAsk: r.sum_ask,
      sideWon: resolveTickerSideViaKalshi(r.ticker, r.quote_side, _qoSettlements),
    })));
    const adverseSelection = adverseSelectionWithinBand({
      quotedByBand: qo.byBand,
      filledBands: (_mBands || []).map(r => ({ band: r.band, avgPnl: r.avg_pnl, graded: r.graded })),
      filledEdgeRawCents: avgPnl,
    });
    // Category × band diagnostic grain (2026-07-29). Roll the per-day rows up to one cell per
    // (category, band): contract-weighted ¢/ct, side-won, graded n, and the two things a bare mean
    // hides — top-day concentration (what share of the cell's |PnL| came from its single biggest
    // day; high = one slate, not an edge) and an anomaly flag. `sideWon` pinned at 0 or 1 across
    // real volume is the impossible value that first exposed the wrong-side-fill bug
    // (ligamx|teamTotal read +52¢ at sideWon 0), so it is flagged explicitly rather than left for
    // the eye. `perContract` is pnl/contracts; the arithmetic bound for a seller is [ask-100, ask],
    // so a cell hugging it is degenerate.
    const _cbCells = new Map(); // key "sport|category|band" -> {..., byDay:Map(day->{c,p,w})}
    for (const r of (_mCatBandDay || [])) {
      const key = `${r.sport}|${r.category}|${r.band}`;
      let cell = _cbCells.get(key);
      if (!cell) { cell = { sport: r.sport, category: r.category, band: r.band,
        fills: 0, contracts: 0, pnl: 0, won: 0, byDay: new Map() }; _cbCells.set(key, cell); }
      const c = Number(r.contracts || 0), p = Number(r.pnl_total || 0), w = Number(r.won_contracts || 0);
      cell.fills += Number(r.fills || 0); cell.contracts += c; cell.pnl += p; cell.won += w;
      const _d = String(r.day).slice(0, 10);
      const dcur = cell.byDay.get(_d) || { pnl: 0, contracts: 0 };
      dcur.pnl += p; dcur.contracts += c; cell.byDay.set(_d, dcur);
    }
    const _categoryBands = [..._cbCells.values()].map(cell => {
      const perContract = cell.contracts ? cell.pnl / cell.contracts : null;
      const sideWon = cell.contracts ? cell.won / cell.contracts : null;
      const dayVals = [...cell.byDay.values()];
      const absTot = dayVals.reduce((a, v) => a + Math.abs(v.pnl), 0);
      const topDayShare = absTot ? Math.max(...dayVals.map(v => Math.abs(v.pnl))) / absTot : null;
      // Per-cell day-clustered CI — the reason the heatmap colors by RELIABILITY, not by the raw
      // mean. Coloring the biggest number brightest is best-of-N selection wearing a heatmap: it
      // points the eye at whichever of ~100 noisy cells drew the luckiest slate (mlb f5ml 70-74
      // read +30.55¢ off ~40 fills, >50% from one day). The day is the independent unit here too,
      // so a cell whose day-clustered interval straddles zero is not distinguishable from noise and
      // the frontend mutes it. `reliable` requires >=3 days for the interval to be estimable at all.
      const cellDC = dayClusteredPnl({ days: dayVals.map(v => ({ pnl: v.pnl, contracts: v.contracts })) });
      // dayClusteredPnl's own loCI/hiCI use a 1.96 (normal) multiplier, which badly understates the
      // interval at the handful of days a single cell has — a 3-day cell has 2 df, where the right
      // two-sided 95% multiplier is ~4.30, not 1.96. Using the normal number here over-declares
      // "reliable" and would just replace the raw-magnitude pick-me trap with a false-CI one. So
      // rebuild the interval with a Student-t multiplier on (days-1) df, and require a real sample
      // (>=5 days AND >=50 fills) before a cell is allowed to count as distinguishable at all.
      const _T95 = { 1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26 };
      const _tMult = (df) => df >= 10 ? 2.23 : (_T95[df] ?? 12.71);
      const _days = cell.byDay.size;
      let ciLo = null, ciHi = null, reliable = false;
      if (cellDC?.mean != null && cellDC?.se != null && _days >= 2) {
        const t = _tMult(_days - 1);
        ciLo = parseFloat((cellDC.mean - t * cellDC.se).toFixed(2));
        ciHi = parseFloat((cellDC.mean + t * cellDC.se).toFixed(2));
        reliable = _days >= 5 && cell.fills >= 50 && (ciLo > 0 || ciHi < 0);
      }
      // Anomaly: a pinned outcome (sideWon 0 or 1 over >=20 fills) that is IMPROBABLE given the
      // band's own price. The first cut flagged any pin, which over-fired: an 85-89¢ favorite
      // winning every time (sideWon=1) is expected, not an artifact, and flagging it trains the eye
      // to ignore the tripwire. The real signature — the one the wrong-side bug showed at +52¢ on a
      // club-soccer teamTotal — is a favorite that NEVER won (sideWon=0) at a price implying it
      // usually should. So test the pin
      // against the price-implied win rate p (band midpoint): P(all won)=p^n for sideWon=1,
      // P(none won)=(1-p)^n for sideWon=0; flag only when that tail is < 0.1%. `fills` is the n
      // (the independent unit; contracts within a fill are correlated), consistent with the
      // day-clustering elsewhere. Cheap, principled, and it stops crying wolf on high favorites.
      let anomaly = false;
      if (cell.fills >= 20 && (sideWon === 0 || sideWon === 1)) {
        const [_lo, _hi] = cell.band.split("-").map(Number);
        const p = (_lo + _hi) / 2 / 100;
        const tail = sideWon === 1 ? Math.pow(p, cell.fills) : Math.pow(1 - p, cell.fills);
        anomaly = tail < 0.001;
      }
      return { sport: cell.sport, category: cell.category, band: cell.band,
        fills: cell.fills, contracts: parseFloat(cell.contracts.toFixed(1)),
        perContract: perContract != null ? parseFloat(perContract.toFixed(2)) : null,
        sideWon: sideWon != null ? parseFloat(sideWon.toFixed(4)) : null,
        days: cell.byDay.size, ciLo, ciHi, reliable,
        topDayShare: topDayShare != null ? parseFloat(topDayShare.toFixed(2)) : null,
        anomaly };
    }).sort((a, b) => b.contracts - a.contracts);
    makerBoard = {
      quotes: { segments: Number(mq?.segments || 0), tickers: Number(mq?.tickers || 0),
        days: Number(mq?.days || 0), avgAsk: mq?.avg_ask != null ? Number(mq.avg_ask) : null },
      fills: { n: Number(mf?.fills || 0), contracts: Number(mf?.contracts || 0), graded,
        avgPnlCents: avgPnl, pnlLoCI_fillLevel_SUPERSEDED: _fillLevelPnlLoCI, sideWonRate: mf?.side_won_rate != null ? Number(mf.side_won_rate) : null,
        avgFillAsk: mf?.avg_fill_ask != null ? Number(mf.avg_fill_ask) : null,
        // Contract-weighted mean + CI (2026-07-25) — what capital actually earns. `avgPnlCents`
        // above is per-FILL and unweighted, so it counts a 1-contract and a 500-contract fill
        // equally; kept because armCriterion was written against it. The CI here treats the FILL as
        // the independent unit (ratio estimator, see maker-stats.js) — NOT the contract, which
        // would understate it ~2.6x on this book and could arm real money on noise.
        weighted: weightedV1,
        // Day-clustered version of the same contract-weighted mean. Wider by construction; the gap
        // between this and `weighted` IS the correlation the fill-level CI ignores.
        dayClustered: dayClusteredV1 },
      // NOTE (2026-07-26): `n` is now SEGMENTS (quote-ticks), not ticker-days — the population
      // changed from last-quote-only to every segment. `tickers` is the distinct-market count if
      // that's what you wanted. Rates are segment-weighted throughout.
      quotedOutcomes: qo,
      adverseSelection,
      // `need` is the ORIGINAL criterion and reads the fill-level `pnlLoCI`, kept for continuity.
      // It is not sufficient on its own: on 2026-07-26 it was satisfied (loCI +0.49) by a book whose
      // entire positive result came from two of seven days, because a fill-level CI credits ~9,400
      // independent observations to what is really ~7. `needClustered` is the gate to act on.
      // `minDays` is a sanity floor so the clustered interval is estimable at all — necessary, not
      // sufficient; clearing `needClustered` is the actual bar.
      armCriterion: {
        minFills: 200, need: "pnlLoCI_fillLevel_SUPERSEDED > 0 (historical, NOT sufficient)",
        minDays: 14, needClustered: "dayClustered.loCI > 0",
        met: graded >= 200
          && (dayClusteredV1?.days || 0) >= 14
          && dayClusteredV1?.loCI != null && dayClusteredV1.loCI > 0,
      },
      armed: false,
      daily: _v1Daily,
      bands: (_mBands || []).map(r => ({
        band: r.band, segments: Number(r.segments || 0), fills: Number(r.fills || 0),
        graded: Number(r.graded || 0),
        avgPnl: r.avg_pnl != null ? Number(r.avg_pnl) : null,
        filledSideWon: r.filled_side_won != null ? Number(r.filled_side_won) : null,
      })),
      categoryBands: _categoryBands,
    };
  } catch (e) { console.error("[shadow-report] maker board skipped:", e?.message); }

  // Shadow maker V2 live board (api/lib/maker-live.js, 2026-07-21) — real resting orders,
  // separate try/catch so a maker_orders_v2-not-yet-created error (V2 never armed) never takes
  // down the V1 makerBoard above. Empty/zeroed until armed.
  if (makerBoard) {
    makerBoard.live = { orders: 0, resting: 0, executed: 0, graded: 0, avgPnlCents: null,
      pnlLoCI_fillLevel_SUPERSEDED: null,
      weighted: weightedPnlFromRow(null), armed: false, daily: [] };
    try {
      const [[lo], armedNow, _mLiveDaily] = await Promise.all([
        neonQuery(`
          SELECT COUNT(*)::int AS orders,
            COUNT(*) FILTER (WHERE status = 'resting')::int AS resting,
            COUNT(*) FILTER (WHERE status = 'executed')::int AS executed,
            COUNT(*) FILTER (WHERE graded_at IS NOT NULL)::int AS graded,
            ROUND(AVG(pnl_cents) FILTER (WHERE graded_at IS NOT NULL), 2) AS avg_pnl,
            ROUND(STDDEV_SAMP(pnl_cents) FILTER (WHERE graded_at IS NOT NULL), 2) AS sd_pnl,
            ${weightedPnlSumsSql({ pnlCol: "pnl_cents", contractsCol: "size", filter: "graded_at IS NOT NULL" })}
          FROM maker_orders_v2 WHERE game_date >= $1`, [since], env, { write: true }),
        isMakerV2Armed(env, cache).catch(() => false),
        // Real-capital equity curve — mirrors V1's daily fill series, keyed the same way
        // (game_date, not placed_at, so a late-night PT fill lands on the game's own day).
        neonQuery(`
          SELECT game_date AS day, COUNT(*)::int AS fills,
            COALESCE(SUM(size), 0) AS contracts,
            COALESCE(SUM(size) FILTER (WHERE graded_at IS NOT NULL), 0) AS contracts_graded,
            COUNT(*) FILTER (WHERE graded_at IS NOT NULL)::int AS graded,
            COALESCE(SUM(pnl_cents * size) FILTER (WHERE graded_at IS NOT NULL), 0) AS pnl_total
          FROM maker_orders_v2 WHERE game_date >= $1 AND status = 'executed'
          GROUP BY game_date ORDER BY game_date`, [since], env, { write: true }),
      ]);
      const gradedV2 = Number(lo?.graded || 0);
      const avgPnlV2 = lo?.avg_pnl != null ? Number(lo.avg_pnl) : null;
      const sdV2 = lo?.sd_pnl != null ? Number(lo.sd_pnl) : null;
      // Same fill-level hazard as V1 above — and worse here, because this board is real capital.
      const _fillLevelPnlLoCIV2 = avgPnlV2 != null && sdV2 != null && gradedV2 > 1
        ? parseFloat((avgPnlV2 - 1.96 * sdV2 / Math.sqrt(gradedV2)).toFixed(2)) : null;
      const _v2Daily = (_mLiveDaily || []).map(r => ({
        day: String(r.day).slice(0, 10), fills: Number(r.fills || 0),
        contracts: Number(r.contracts || 0), graded: Number(r.graded || 0),
        contractsGraded: Number(r.contracts_graded || 0),
        pnlTotal: parseFloat(Number(r.pnl_total || 0).toFixed(1)),
      }));
      // Real-capital board, so this is THE interval an arm/disarm call reads.
      const _v2DayClustered = dayClusteredPnl({
        days: _v2Daily.map(d => ({ pnl: d.pnlTotal, contracts: d.contractsGraded })),
      });
      makerBoard.live = {
        orders: Number(lo?.orders || 0), resting: Number(lo?.resting || 0),
        executed: Number(lo?.executed || 0), graded: gradedV2,
        avgPnlCents: avgPnlV2, pnlLoCI_fillLevel_SUPERSEDED: _fillLevelPnlLoCIV2, armed: !!armedNow,
        // Same contract-weighted view as V1's fills.weighted — this is the real-capital board, so
        // it is the number an arm/disarm call should actually be read off.
        weighted: weightedPnlFromRow(lo),
        dayClustered: _v2DayClustered,
        daily: _v2Daily,
      };
    } catch (e) { console.error("[shadow-report] maker live board skipped (likely never armed):", e?.message); }

    // Cross-checks (2026-07-29): two independent measurements of the same quantity, rendered as a
    // DIFF with the disagreement as the headline. This is the class of view that actually catches
    // instrument bugs — a prettier slice of one data stream never does. The wrong-side fill bug was
    // visible for days as V1-paper (+1.5¢) vs V2-real (~0) disagreeing on the SAME [80,84] band, and
    // it got rationalized as "different populations". A diff panel makes that impossible to wave off.
    // Both pairs are computed from data already in hand — no extra fetch. `flagCents`/`flag` mark a
    // material disagreement so the strip draws attention to itself rather than needing to be read.
    const _band8084 = (makerBoard.bands || []).find(b => b.band === "80-84");
    const _v1_8084 = _band8084?.avgPnl ?? null;                 // V1 paper, same band V2 rests in
    const _v2Mean = makerBoard.live?.weighted?.mean ?? null;    // V2 real, all [80,84] by config
    const _bestAcc = (accuracyBoard || [])
      .filter(a => a.skill != null && (a.n || 0) >= BRIER_MIN_N)
      .sort((a, b) => b.skill - a.skill)[0] || null;
    const _beatMarket = (accuracyBoard || [])
      .filter(a => a.skill != null && (a.n || 0) >= BRIER_MIN_N && a.skill > 0).length;
    const _trustedAcc = (accuracyBoard || []).filter(a => a.skill != null && (a.n || 0) >= BRIER_MIN_N).length;
    makerBoard.crossChecks = [
      {
        key: "v1v2",
        label: "V1 paper vs V2 real · same [80,84] band",
        a: { name: "V1 sim", cents: _v1_8084 },
        b: { name: "V2 real", cents: _v2Mean },
        deltaCents: (_v1_8084 != null && _v2Mean != null) ? parseFloat((_v1_8084 - _v2Mean).toFixed(2)) : null,
        // On the same band the simulator and real orders should agree; a persistent gap is an
        // instrument bug, not two populations. 3¢ is well outside sampling noise at these n.
        flagCents: 3,
        flag: (_v1_8084 != null && _v2Mean != null) && Math.abs(_v1_8084 - _v2Mean) >= 3,
        note: "should agree on the shared band; a gap is an instrument bug, not two populations",
      },
      {
        key: "model_market",
        label: "Model vs market · Brier skill",
        a: { name: "best category", skill: _bestAcc?.skill ?? null, cat: _bestAcc?.key ?? null, n: _bestAcc?.n ?? null },
        b: { name: "market (baseline)", skill: 0 },
        beats: _beatMarket, trusted: _trustedAcc,
        // Not a cents diff — the headline is "how many categories beat the market with confidence".
        flag: false,
        note: `${_beatMarket}/${_trustedAcc} trusted categories beat the market`,
      },
    ];
  }

  const report = {
    reportDate,
    generatedAt: new Date().toISOString(),
    since,
    dataHealth,
    topPicks,
    accuracyBoard,
    bettingBoard,
    categories,
    topBands,
    clv,
    perGameRoi,
    optimalPerGameCap,
    dailyVolumeRoi,
    optimalDailyPicks,
    newMarkets,
    shortlistedMarkets,
    sportsbookValidation,
    polymarketValidation,
    makerBoard,
    durationMs: Date.now() - t0,
  };

  // Daily brief — deterministic prose synthesis of the boards + both cross-venue observatories,
  // diffed against yesterday's cached report (still alive at cron time: 25h TTL, cron 6am). Additive
  // + failure-closed: any error → brief stays null and the page falls back to the raw boards.
  report.brief = null;
  try {
    const prior = cache ? await cache.get(`${REPORT_CACHE_KEY_PREFIX}${yesterday}`, "json").catch(() => null) : null;
    report.brief = _buildDailyBrief(report, prior);
  } catch (e) { console.error("[shadow-report] brief skipped:", e?.message); }

  const res = dataHealth?.resolution;
  const incomplete = res && res.total > 0 && (res.resolved / res.total) < 0.9;
  const ttl = incomplete ? INCOMPLETE_REPORT_TTL : REPORT_TTL;
  if (cache) cache.put(cacheKey, JSON.stringify(report), { expirationTtl: ttl }).catch(() => {});
  return jsonResponse(report);
}

export { handleShadowReport };
