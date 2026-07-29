import React from 'react';
import { WORKER } from '../lib/constants.js';
import { SCHEDULED_CHECKPOINTS } from '../lib/scheduledCheckpoints.js';
import { SERIES_CONFIG } from '../../api/lib/series-config.js';
import { CATEGORY_BET_WINDOWS, AWAITING_VALIDATED_EDGE } from '../../api/lib/config.js';
import { INPUT_SEARCH_EXHAUSTED, WINDOW_SEARCH_EXHAUSTED, stillExhausted as _stillExhausted } from '../../api/lib/model-holds.js';

// New primary landing page (2026-07-21) — promoted from ReportPage.jsx's MakerProgress module
// when taker picks (LineupsPage) were demoted to a secondary /picks route. See
// project_taker_ui_demotion_2026_07_21 memory for the reasoning (category gate empty since
// 7/18, taker edge structurally negative venue-wide per the 7/19 pooled calibration scan, while
// maker V2 looked at the time like it had a verified result in the 80-84 band).
//
// SUPERSEDED 2026-07-28: that 80-84 result was retired (post-fix bands alternate sign) and V2 is
// now SHELVED - no demonstrated fillable edge across six measurements, the last of them
// pre-registered and rejected on all three criteria. See docs/REENTRY.md. This page is therefore a
// monitoring surface for a strategy that is off; it must not render anything that reads as a call
// to arm.
//
// DoThisBanner + its full dependency chain (2026-07-22) ported here verbatim from the now-
// deleted ReportPage.jsx when /model was deprecated — see project_do_this_banner memory. This
// page is the eager-loaded default view (no more React.lazy ReportPage to defer against), so
// MODEL_NEXT + _doThisCandidates are now part of the landing page's eager bundle.
const C = { green:"#3fb950", amber:"#e3b341", red:"#f78166", blue:"#58a6ff", gray:"#8b949e", dim:"#484f58", text:"#c9d1d9", bg:"#0d1117", card:"#161b22", border:"#21262d" };
const sectionHead = { color:C.blue, fontSize:11, fontWeight:700, margin:"14px 0 8px", borderTop:`1px solid ${C.border}`, paddingTop:12, textTransform:"uppercase", letterSpacing:0.4 };
// Sub-section label inside a section (chart titles). Same weight/casing as sectionHead but no rule
// and no accent color — it names a figure, it doesn't open a section.
const microHead = { color:C.dim, fontSize:9, fontWeight:700, margin:"0 0 3px" };
// Inline text toggle (expand/collapse). Not a real button visually — these disclose detail that is
// deliberately hidden by default, so they must not compete with Refresh/Picks in the header.
const linkBtn = { background:"transparent", border:"none", padding:0, marginTop:5, cursor:"pointer", color:C.blue, fontSize:10, fontWeight:700 };

// A build-roadmap entry counts as SHIPPED once any of its Kalshi tickers exists in
// SERIES_CONFIG — which we ALWAYS edit when a market ships. Deriving "shipped" from that
// single source of truth (instead of a hand-maintained flag) is what keeps the "Do this
// today" banner from advertising a market we already built: it self-advances the moment a
// new series lands in the config. (Phase-2/placeholder tickers absent from the config —
// e.g. KXEPLTOTAL, KXUFCROUNDS — correctly read as not-yet-shipped.)
const _isShippedRoadmapEntry = (s) => !!s?.markets?.some(m => SERIES_CONFIG[m.ticker]);

// ---- MODEL BOARD: one row per model — profit + honesty fused into a "Do this" action ----
const _TONE = { green:C.green, gray:C.gray, red:C.red, blue:C.blue, amber:C.amber, dim:C.dim };
// Learning trend — is Brier skill still rising as data accrues (still learning), or flat (saturated)?
// recent-half minus early-half paired skill. Arrow + value; dim until each half clears n≥100.
const _LEARN_FLAT = 0.003; // |trend| below this reads "flat" (saturated)

// ---- MODEL NEXT: curated build roadmap, alt-line-first -----------------------------
// Static editorial roadmap (NOT report data) — the markets we plan to model next, in
// priority order. Alt-line markets (totals / spreads / rounds: multiple thresholds +
// two-sided yes/no pricing) rank ABOVE single-line markets (1X2 result, outrights, H2H)
// because more lines = more chances to find edge than a one-shot ML — and one per-team
// rate estimate feeds totals, team totals, spread AND result off a shared joint sim
// (the MLB pipeline pattern). Each sport names its "first knob": the single input the
// v1 (shadow-only) model ships with, per the minimum-viable-input doctrine in
// docs/MODEL_IMPROVEMENT.md. Frontend constant → edit here, deploys instantly.
const MODEL_NEXT = [
  {
    sport: "Model triage", rank: 0, infra: true,
    note: "Infra, not a market — sharpen the diagnosis before widening the surface: make /model say which fix each losing category needs, so chat sessions go straight to the right move.",
    knob: "two-board split: ACCURACY (Brier vs market, Layer 1) gates BETTING (price/ROI, Layer 2) — eligible = model provably beats the price",
    markets: [
      { t: "infra", badge: "LIVE", ticker: "Two-board split", title: "Accuracy board (does the model beat the price?) gates the betting board (what to bet) — separates model quality from bet selection" },
      { t: "infra", badge: "LIVE", ticker: "Skill column", title: "Brier skill on the accuracy board — does the model beat the price? (market-Brier − model-Brier)" },
      { t: "infra", badge: "LIVE", ticker: "tune:residual", title: "Phase 2 CLI — slice residuals by stored dims (features JSONB), ranked by gradient + per-bucket Brier skill (npm run tune:residual). Exercised against its first LIVE miss 2026-06-24 (mlb|totalBases): n=140 too thin to rank any dimension, no L0 candidate — re-run at n≥200." },
      { t: "infra", badge: "LIVE", ticker: "Recalibrate vs Improve-inputs fork", title: "_accuracyAction forks miscalibrated categories on Brier skill into 3 states (2026-06-24 → split 2026-06-25): model sharper by sign → Recalibrate (L2; thin +skill tagged provisional, banner-gated to n≥200), market TRUSTABLY sharper (skill<0 @ n≥100) → Improve inputs (L0 new input — the only state that nags), else Accruing. Fixed both mlb|totalBases/hits (told to find a new input when a reweight is the fix) AND model-sharper-but-thin cats like wnba|threePointers (skill +0.045/n=33 mislabeled 'needs a NEW input')." },
      { t: "infra", badge: "LIVE", ticker: "Exogenous feature stamp", title: "Standardized x* namespace in extractFeatures (xVolume/xSpread/xLineMove/xLineupConfirmed/xRestDays/xWindOutMph/xTempF) so EVERY category — not just props — carries the raw market-independent dims a mispricing signal lives in; MLB run markets now log game-time weather; tune:residual ranks native+f:x* first (--all-features for intermediates). Shipped 2026-06-26, forward-only." },
      { t: "infra", badge: "TODO ~2026-07-10", ticker: "re-open exhausted run markets", title: "Once x* dims have accrued (~2wk), DROP the run-market keys (mlb|totalRuns etc.) from INPUT_SEARCH_EXHAUSTED so the banner re-fires Improve inputs → run tune:residual against the NEW liquidity (xVolume/xSpread) hypothesis. Premature today — x* has zero rows, the nag would slice empty data. Liquidity is the fresh part; weather→runs was already rejected (project-weather-runs-study)." },
      { t: "infra", badge: "LIVE", ticker: "capture-window de-blinding", title: "tune:residual on mlb|totalBases (n=255) + hits (n=185), 2026-06-29: the bettable edge lives ABOVE the [67,91] cap — but [67,91] was ALSO the shadow-CAPTURE gate, so calibration was blind to its own edge band (max logged price was exactly 91). Fix (844de25): split config into the bet window [67,91] (qualified flag, unchanged) vs a wider CAPTURE_GATE 55 / CAP 97 logging band, applied at the tonight.js collection pre-filters + every phase-1 shadow module. Dropped the per-category BET-window idea — a hand-set [80,95] just trades one assumption for another. Forward-only; live-verified 55–97 capture, bet rows still gate [67,91]. [[project-percategory-price-window]]" },
      { t: "infra", badge: "TODO ~data-gated", ticker: "derive bet selection from calibration", title: "Once the wider capture data accrues (~2wk) AND a category becomes skill-eligible: replace the two hand-set bet assumptions with data-derived selection — (1) bet window = bettingBoard.discoveredWindow, not [67,91]; (2) demote the fixed edge gate (EDGE_GATE 3/5) to a per-category data-derived selector subordinate to skill. edgeBucketRoi (2026-06-29) shows ROI flat-negative across EVERY edge band → edge doesn't predict ROI (it's endogenous, real only where Brier skill>0). Make bettingBoard.eligible (skillLoCI>0 & n≥100) the PRIMARY live gate — today it only drives display; the live path still runs passesCategoryGate + the fixed edge gate. Untestable until a category beats the market → forward-only, NOT a today action. [[project-edge-gate-subordinate-to-skill]]" },
      { t: "infra", badge: "LATER", ticker: "residual board column", title: "Surface the slice on /model — upgrade Look deeper → Reweight (L2) / Add input: ⟨dim⟩ (L0); gated until a category has a live surviving miss" },
    ],
  },
  {
    // Soccer Phase 1 (World Cup) SHIPPED 2026-06-21 — shadow-only, one Elo-derived Dixon–Coles
    // Poisson matrix per game feeds all 5 families (1X2/total/teamTotal/spread/BTTS). Kept on the
    // roadmap so the club-league Phase-2 extension stays visible; it's auto-detected as shipped
    // (KXWCGAME is in SERIES_CONFIG) → the banner skips it and advances to the next unbuilt market.
    sport: "Soccer", rank: 1,
    note: "Phase 1 (World Cup) shipped — shadow-only. One Elo goal-rate → score matrix covers totals + team totals + spread + 1X2 + BTTS.",
    knob: "national-team Elo → goal supremacy → DC-Poisson matrix (μ=2.7, C=160, ρ=−0.13); Phase 2 = attack/defence ratings + host bump + club leagues",
    markets: [
      { t: "single", badge: "LIVE", ticker: "KXWCGAME", title: "World Cup — 1X2 / total / team total / spread / BTTS (all 5 live in shadow)" },
      { t: "single", badge: "LIVE", ticker: "KXWCADVANCE", title: "World Cup knockout \"to advance\" — Elo matrix + ET/penalties draw allocation (live in shadow)" },
      { t: "alt", badge: "LATER", ticker: "KXEPLTOTAL", title: "Club leagues (EPL / La Liga / Serie A / Bundesliga / MLS / UCL) — Phase 2, offseason now; needs club Elo" },
    ],
  },
  {
    // Fighting Phase 1 (UFC rounds O/U) SHIPPED 2026-06-21 — shadow-only. Pure fight-duration
    // model: one weight-class finish-rate → constant per-round hazard → "ends before round N" CDF,
    // independent of who wins (sidesteps the thin MMA rating data). Auto-detected as shipped
    // (KXUFCROUNDS is in SERIES_CONFIG) → the banner advances to the next unbuilt market.
    sport: "Fighting", rank: 2,
    note: "Phase 1 (UFC rounds O/U) shipped — shadow-only. Winner deferred (no independent fighter rating; sportsbook odds would launder the market); method-of-victory doesn't exist on Kalshi.",
    knob: "weight-class finish rate → per-round hazard → fight-duration CDF; Phase 2 = per-round hazard vector + fighter durability, then winner off a real fighter Elo",
    markets: [
      { t: "alt", badge: "LIVE", ticker: "KXUFCROUNDS", title: "UFC rounds O/U — \"ends before round N\" (live in shadow)" },
      { t: "single", badge: "LATER", ticker: "KXUFCFIGHT", title: "UFC Fight winner — Phase 1b, needs a fighter Elo" },
      { t: "single", badge: "LATER", ticker: "KXBOXINGFIGHT", title: "Boxing Fight winner — Phase 2" },
    ],
  },
  {
    // Golf Phase 1 (PGA single-round head-to-head) SHIPPED 2026-06-21 — shadow-only. OWGR rating
    // → one-round score differential (field-independent, like tennis). Auto-detected as shipped
    // (KXPGAH2H is in SERIES_CONFIG) → the banner advances to the next unbuilt market.
    sport: "Golf", rank: 3,
    note: "Phase 1 (PGA H2H) shipped — shadow-only. OWGR rating → one-round score differential. Coverage is thin (single-round variance keeps most matchups <67%). Phase 2 = field sim → make-cut + cut-line (the alt-line families).",
    knob: "OWGR avg-points → strokes-vs-field skill → Normal one-round differential (scale 1.7, σ 2.8); Phase 2 = strokes-gained rating + 36-hole field simulation",
    markets: [
      { t: "single", badge: "LIVE", ticker: "KXPGAH2H", title: "PGA single-round head-to-head (live in shadow)" },
      { t: "single", badge: "LATER", ticker: "KXPGAMAKECUT", title: "PGA make-cut — Phase 2, needs field sim" },
      { t: "alt", badge: "LATER", ticker: "KXPGACUTLINE", title: "PGA cut line (alt) — Phase 2, falls out of the field sim" },
      { t: "single", badge: "LATER", ticker: "KXPGAWIN", title: "Outright winner — sub-window longshot" },
    ],
  },
  {
    // NASCAR Phase 1 (Cup H2H + Top-10) SHIPPED 2026-06-22 — shadow-only. Recent-form finishing-
    // position model (μ = last-10-race avg finish, σ=9). Auto-detected as shipped (KXNASCARH2H is in
    // SERIES_CONFIG) → the banner skips it and advances to the next unbuilt market.
    sport: "NASCAR", rank: 4,
    note: "Phase 1 (Cup H2H + Top-10) shipped — shadow-only. Cup-only by construction (the rating index is built from the Cup schedule, so Truck/Xfinity-only drivers drop out).",
    knob: "μ = mean finish over last 10 Cup races (min 3 starts), league σ=9; pBeats Φ((μB−μA)/√2σ) + pTopN Φ((10.5−μ)/σ); Phase 2 = per-track/qualifying/manufacturer + recency weighting",
    markets: [
      { t: "single", badge: "LIVE", ticker: "KXNASCARH2H", title: "NASCAR Cup driver head-to-head (live in shadow)" },
      { t: "single", badge: "LIVE", ticker: "KXNASCARTOP10", title: "NASCAR Cup Top-10 finish (live in shadow)" },
    ],
  },
  {
    // MLB Pitcher Outs-Recorded SHIPPED 2026-06-23 — shadow-only. Normal workload model (μ = avgBF ×
    // out-rate, σ 0.90-scaled from the outs-tail accuracy backtest). Auto-detected as shipped
    // (KXMLBOUTS is in SERIES_CONFIG) → the banner skips it and advances to the next unbuilt market.
    sport: "MLB Outs", rank: 5,
    note: "Pitcher outs-recorded O/U shipped — shadow-only. Smoother target than the K tail (manager-leash-dominated); σ calibrated against 2257 historical starts (the feared early-hook left tail was disproven).",
    knob: "μ = avgBF × outRate (outRate = 1−(BAA+.06)), σ = 0.90 × max(stdBF × outRate, 3.5); Phase 2 = pitcher-specific OBP (vs the league walk constant) + opp/park, and pitcher coverage (spot-starter no_pitcher_data drops)",
    markets: [
      { t: "alt", badge: "LIVE", ticker: "KXMLBOUTS", title: "Pitcher outs recorded O/U — alt-line ladder per starter (live in shadow)" },
    ],
  },
  {
    // MiLB game winner — vetted 2026-07-15 (shortlisted from the 7/15 rollout flood, dismissed
    // same day with a recheck). Model end GREEN: statsapi covers all 4 full-season levels
    // (sportIds 11-14 → 10 leagueIds, 120 teams, ~62 games/day), standings carry id-keyed
    // RS/RA, and the resolver shape is identical to lmb.js — the whole build is "parameterize
    // lmb.js + author the registry". Kalshi end: a registered SHELL with zero markets ever
    // listed, so the registry (Kalshi abbrs ↔ statsapi ids) is unauthorable and there is no
    // book to vet. infra:true is NOT semantic here — it's the blocked-on-Kalshi flag (Polymarket
    // precedent) so the build-next banner can't nag for an unbuildable market; the 7/29
    // SCHEDULED_CHECKPOINTS entry owns the wait. FLIP to non-infra (or just build) when
    // markets list with real books.
    sport: "MiLB", rank: 6, infra: true,
    note: "Minor League Baseball game winner (KXMILBGAME) — LMB playbook at ~6x the volume (~62 games/day across AAA/AA/High-A/A vs LMB's ~10) IF Kalshi ever seeds it. Vetted 7/15: data end green, Kalshi end an empty shell — blocked until markets list.",
    knob: "per-team season RS/G + opp RA/G → λ pair → simulateMLBJoint (identical to lmb.js — parameterize sportId/leagueIds, add the registry once Kalshi tickers exist); resolver = statsapi schedule Finals, split-DH guard mandatory (MiLB DHs are common and 7-inning)",
    markets: [
      { t: "single", badge: "BLOCKED", ticker: "KXMILBGAME", title: "MiLB game winner — Kalshi series is a zero-market shell; 7/29 checkpoint re-checks for listings + real books (asks populated, game-day spread ≤15¢), then un-dismiss and build" },
    ],
  },
  {
    // Polymarket platform expansion. Phase 1a (cross-venue ML price observatory) SHIPPED 2026-06-23;
    // kill-gate CLOSED 2026-07-04 → Phase 1b trading KILLED (no executable cross-venue edge).
    // infra:true so the "build next" prompt never picks it. The observatory stays live: zero
    // marginal cost, feeds the client Poly reference price on ML cards, and its daily medians
    // would surface a future regime change (e.g. US volume migrating to QCX decoupling prices).
    sport: "Polymarket", rank: 9, infra: true,
    note: "Kill-gate CLOSED 2026-07-04: on post-date-fix data (7/01→) exec.fracEdgeGe3c = 0 — Poly mid sits ~0.5¢ below Kalshi but the walkable ask lands at/above Kalshi every time (mid gap not buyable; meanSigned exec +1¢). 11 days / 402 matched sides: mid median |Δ| 0.5¢ every single day, clean-window fracGe5c = 0. Phase 1b trading + QCX pursuit + totals (1a.1) KILLED; observatory stays as reference feed. Don't re-open unless daily medians move.",
    knob: "Gamma public API → normalize game ML → match our Kalshi rows → CLOB book-walk for executable VWAP; exec.fracEdgeGe3c (% of bettable sides still ≥3¢ cheaper to BUY after slippage) was the go/no-go — it read 0",
    markets: [
      { t: "infra", badge: "LIVE", ticker: "ML observatory", title: "Cross-venue moneyline deltas — mid + book-walked executable VWAP → /api/polymarket-deltas. Kept post-kill as the client Poly reference price + regime-change tripwire (venues track within ~0.5¢; the 14d exec 0.289 was pre-7/01 date-fuzz artifact, rolls clean ~7/09)." },
      { t: "infra", badge: "KILLED", ticker: "Phase 1b trading", title: "KILLED 2026-07-04 at the designed kill-gate: zero surviving post-slippage edge on clean data (exec.fracEdgeGe3c = 0, n=9; mid population n=402 shows no ≥3¢ gaps to walk). Cheap-kill doctrine outcome — observatory built to answer exactly this." },
    ],
  },
];

// ---- DO THIS: the single top-priority action for the morning, across the whole page ----
// A fall-through priority ladder — pick the first tier that has something actionable as the
// PRIMARY "do this"; the queued rest is no longer shown in the banner (still in the copy text).
// Tiers: (1) data health — bad data poisons everything below, so an ACTIONABLE warning (catastrophic
// resolution, or the same coverage/CLV failure ≥2 days running = live pipeline bug) trumps all;
// (1.6) maker adverse selection — the one failure mode that kills the REAL-MONEY V2 strategy, so it
// outranks everything except broken data; (1.8) shadow maker V2 lifecycle (verify/arm → trial → scale
// decision) — real capital, ranked above the taker-side tiers below since maker is the current primary
// strategy (taker UI demoted, category gate empty since 2026-07-18 — see project_taker_ui_demotion);
// (2) betting changes pending on the board (gate promote/demote/investigate); (2.2) accuracy changes
// (Recalibrate / Improve inputs / Diagnose, with ripeness + exhaustion suppression); (2.5) validate
// ripe shadow models — ungated + eligible + n≥50 + STRENGTHENING, the build→gate half of the funnel
// (run tune:gate + Brier); (3) build a NEXT-flagged roadmap market (an explicit "this first"
// override); (3.15) derive a per-category bet window (harvest of already-accrued data — ranks above
// authoring new markets); (3.2) build the next merely-unshipped roadmap market — currently INERT
// (every MODEL_NEXT entry is either infra-without-NEXT or already shipped per SERIES_CONFIG,
// verified 2026-07-22) but self-advancing: fires again the moment a new unshipped entry is added,
// so the mechanism stays rather than getting deleted; (3.25) vet shortlisted markets (promoted
// detections, mid-funnel); (3.5) triage detected new markets (the funnel's first step); (3.6)
// sportsbook regime-change tripwire (kill-gate CLOSED 2026-07-04 — GAP now means "investigate", not
// "build 1b"); (4) SCHEDULED_CHECKPOINTS — dated follow-ups (x* re-open, …) that surface on their
// date and persist until handled; (5) quiet-day floor naming the next upcoming checkpoint.
// Candidates are pushed per-tier then SORTED by tier (push order ≠ priority order since 3.2).
// Betting-board (Layer 2) actions that count as a "model change pending".
const _BET_ACTIONS = {
  "Add to gate":    { tone:"green", verb:"Promote" },
  "Pull from gate": { tone:"red",   verb:"Pull from gate" },
  "Look deeper":    { tone:"blue",  verb:"Investigate" },
};
// Accuracy-board (Layer 1) actions that warrant a model-improvement session.
const _ACC_ACTIONS = {
  "Improve inputs":     { tone:"amber", verb:"Improve inputs for" },     // OVER/UNDER + market sharper → L0 new input
  "Recalibrate":        { tone:"amber", verb:"Recalibrate" },            // model beats price but miscalibrated → L2 de-shrink
  "Diagnose then stop": { tone:"red",   verb:"Diagnose (tune:residual)" }, // MARKET_SHARPER → one-time sub-slice/L0 check, then park
};
// A Recalibrate task isn't safe to act on until the formula-grade bar (n≥200): below it the
// calibration curve is noisy and often non-monotonic (e.g. 2026-06-24 mlb|totalBases under at
// 60-65 but OVER at 75-90 — a uniform de-shrink would worsen the high bands), so a reweight would
// chase a single thin band. Below RECAL_MIN_N the row stays on the accuracy board but is held OUT
// of the daily Do This banner so it doesn't nag an un-ripe task; it resurfaces at n≥200.
const RECAL_MIN_N = 200;
// (MAKER_V2_TRIAL_N removed 2026-07-28 — V2 is shelved, so there is no trial to size.)
// n≥200 is necessary but NOT sufficient: a category can clear it yet still have a MOVING Brier-skill
// trend (reliable |learning.skillTrend| > _LEARN_FLAT) — rising as data accrues (still learning) OR
// falling (decaying toward a market tie, the wnba|points signature). EITHER direction means the
// calibration gap (and the β* de-shrink step) isn't settled, so locking an L2 reweight now chases a
// moving target. An un-flat-trend Recalibrate is therefore ALSO held off the banner (the board row +
// its ↗/↘ Learning arrow keep showing it); it resurfaces only once the trend flattens (converged).
// Per-category bet-window derivation nudge (tier 3.15). WINDOW_RECOMMEND_N = enough settled bets to
// trust a tune:window read (mirrors the CLI's --min-n default + MODEL_IMPROVEMENT.md's window-grade
// floor). WINDOW_SEARCH_EXHAUSTED = categories already run to a TERMINAL no-go (the discovered window
// doesn't hold out-of-sample), so the banner stops nagging — mirrors INPUT_SEARCH_EXHAUSTED, including
// the auto-UN-suppress: a FORMULA_CUTOFF newer than the exhaustion date re-accrues the category clean
// and re-opens the search (via _stillExhausted). A NON-terminal no-go (OOS split merely too thin) does
// NOT belong here — give it a dated SCHEDULED_CHECKPOINTS entry to re-run once OOS n accrues instead
// of either nagging daily or being forgotten.
const WINDOW_RECOMMEND_N = 200;

// ---- STRATEGY CLOSED (2026-07-28) — suppresses the tune-the-model tiers -------------------
// All five strategy families are closed (`docs/REENTRY.md`): taker (0 of 57 categories with Brier
// skill CI-lo > 0 at n≥100), maker (no fillable edge, six dissolutions), cross-venue, lead-lag, and
// path. The banner's ladder was authored while taker-side model improvement was the daily program,
// so five of its tiers nag actions that REENTRY.md now names as DISQUALIFYING rather than merely
// unproductive:
//
//   1.6  maker adverse selection  — its remedy is "diagnose which categories/bands drive it",
//                                   i.e. a band slice. Slicing is 0-for-6, and V2 is shelved so
//                                   there is no capital to protect.
//   2    promote/pull/investigate — the gate is empty and the bettingBoard PROMOTE verdict is
//                                   "a screen, not a decision" (in-sample, no OOS split).
//   2.2  Improve inputs / Recalibrate / Diagnose — all three are residual search. §2 of the doc
//                                   admits a model change only with "a stated mechanism … NOT a
//                                   correction discovered by searching residuals". `tune:residual`
//                                   IS the residual searcher.
//   2.5  validate via tune:gate   — gating a category is betting the closed taker family.
//   3.15 derive a bet window      — "a different price band" is the first-listed non-justification.
//
// Left standing: 1 (data health — shadow logging is the instrument the doc keeps running), 3.25 and
// 3.5 (vet/triage new markets — condition #1, the ONE thing that could justify re-entry, and
// `kalshi-series-scan` is kept expressly as "the only sensor pointed at" it), 3.6 (regime-change
// tripwire), 4 (dated checkpoints), 5 (quiet-day floor).
//
// A const rather than deleted code, matching `SHELVED` in maker-live.js and `TAPE_REPLAY_ENABLED`
// in maker.js — the doc's own posture is that the instruments stay and only the actions stop
// ("the instruments are all still here"). Re-entry is a one-line revert, with the conditions above
// in front of whoever does it. **Do not flip this because a number got interesting** — read
// docs/REENTRY.md first; it exists because that has already happened six times.
//
// Moved to api/lib/config.js 2026-07-29 (and renamed there from STRATEGY_CLOSED) — it was a local
// const here, so this banner went quiet while /api/shadow-report's `brief` kept telling every
// non-UI consumer to run tune:window on an unvalidated lead. One flag, two consumers, one source.

function _doThisCandidates(d) {
  const out = [];
  // 1 — data health, but ONLY when actionable. `dataHealth.actionable` (server) is true only for
  // partial resolution (re-runnable). Coverage under-log + CLV dips are about a now-closed yesterday
  // and unrecoverable — they stay in the ⚠ caution strip (DataHealth) but must NOT claim the day's
  // primary to-do (else the banner nags "Fix data health" for something with no fix). On a quiet
  // healthy day this falls through to the real next action.
  const warns = d?.dataHealth?.warnings || [];
  if (warns.length && d?.dataHealth?.actionable) {
    out.push({ tier:1, tone:"red", label:"Fix data health", why: warns.join(" · "), short:"Fix data health" });
  }
  // 1.6 — maker adverse-selection red flag (2026-07-19): the ONE failure mode that kills the
  // maker strategy. Fires once graded fills are readable (n≥30) and either fills give up ≥2¢/contract
  // vs quotes at the SAME price band, or fill PnL is decisively negative (CI-hi < 0 via avg + CI-lo
  // symmetry).
  //
  // Rewritten 2026-07-26: this used to compare raw sold-side win RATES (fills vs quoted overall) and
  // fire at ≥8pp. That comparison was confounded — fills sit ~4¢ lower in price than quotes, and a
  // lower win rate is exactly what a lower price should produce, so the pp gap measured price mix as
  // much as selection. It read −5.15pp (fills "better") on 2026-07-26 while genuine selection was
  // unmeasurable. Now reads `adverseSelection.gapCents`, which is computed within band and mix-adjusted.
  const mb = d?.makerBoard;
  if (!AWAITING_VALIDATED_EDGE && (mb?.fills?.graded || 0) >= 30) {
    const _gap = mb.adverseSelection?.gapCents ?? null;
    // Fill-level CI, renamed server-side 2026-07-28 so it cannot be grabbed by accident. Legitimate
    // HERE only because this clause fires when the interval is entirely NEGATIVE — a too-narrow CI
    // makes it warn more readily, and over-warning is the safe direction. It must never gate an ARM.
    const _fillLoCI = mb.fills.pnlLoCI_fillLevel_SUPERSEDED;
    const _pnlHiCI = mb.fills.avgPnlCents != null && _fillLoCI != null
      ? mb.fills.avgPnlCents + (mb.fills.avgPnlCents - _fillLoCI) : null;
    if ((_gap != null && _gap >= 2) || (_pnlHiCI != null && _pnlHiCI < 0)) {
      out.push({ tier:1.6, tone:"red", label:"Maker fills are adversely selected — margin is selection, not edge",
        why:`at equal price bands, fills earn ${_gap != null ? `${_gap.toFixed(2)}¢/contract less` : "materially less"} than quotes (quoted ${mb.adverseSelection?.quotedEdgeCents}¢ vs mix-adjusted filled ${mb.adverseSelection?.filledEdgeMixAdjustedCents}¢, n=${mb.fills.graded} graded)${_pnlHiCI != null && _pnlHiCI < 0 ? `; fill-level PnL CI entirely negative (${_fillLoCI}..${_pnlHiCI.toFixed(1)}¢ — NOT the day-clustered arm interval)` : ""} — diagnose which categories/bands drive it before more accrual`,
        short:"Maker adverse selection" });
    }
  }
  // 1.8 — shadow maker V2 status. Ranked above the taker-side tiers (2/2.2/2.5 below) since real
  // capital is now on the line and maker is the current primary strategy (taker demoted, gate empty
  // — renumbered from 2.05 on 2026-07-22 when this banner moved off the deprecated /model page;
  // previously a stray taker-gate suggestion could outrank a live V2 trial update, which no longer
  // reflected priority). The V1 aggregate crossing its criterion was a ONE-TIME signal that already
  // fired and was acted on (ARM review 2026-07-21: decision made to scope V2 to the 80-84¢ band, not
  // the full [55,97] — see docs/INFRA.md § Shadow maker engine). Re-showing "review V2" every day off
  // the same stale V1 aggregate would nag a decision that's already made, so once makerBoard.live
  // exists (V2 built, api/lib/maker-live.js) this tier tracks V2's OWN lifecycle instead: verify-
  // then-arm → trial running → trial resolved (scale or investigate).
  // SHELVED 2026-07-28. This tier used to be an arming ladder (verify → arm → trial → scale), and
  // the whole point of removing it is that the banner should stop pointing at a decision that has
  // been made. One terminal notice, no call to action. The old `pnlLoCI`-based fallback below it is
  // gone too: it fired on the fill-level CI, which day-clustering superseded on 2026-07-26 — it
  // could still have shown "ARM DECISION — cleared its criterion" off a criterion known to be wrong.
  //
  // TIER REMOVED 2026-07-28 (same day, second pass). Replacing the ladder with a terminal notice
  // still left `if (mb) out.push(...)` — and `mb` is ALWAYS present, so the notice became the
  // primary candidate every single day, permanently. Since the banner renders only `primary`,
  // tiers 2 → 5 became structurally unreachable: on the day this was found it was burying 1
  // accuracy action, 16 shortlisted markets, 15 detected markets, and **8 overdue checkpoints**
  // (oldest 5 days). A status is not an action and must not hold an action slot — the shelved
  // fact now renders next to the arm state in the Open-positions section head, off `board.shelved`
  // (server-side `MAKER_V2_SHELVED`), where a reader already looks for whether the engine is live.
  // If a future tier needs this slot, give it a real firing CONDITION.
  // 2 — betting changes pending on the betting board (promote / demote / investigate).
  // "Look deeper" is the Phase-2 residual-slicer nag (eligible-but-window-loses). It's only
  // actionable once a coherent price window has been DISCOVERED to slice against — with
  // discoveredWindow=null the category is still accruing (the wider [55,97] capture data
  // hasn't filled the band yet), so an immediate slice has nothing to bite on and the to-do
  // is unfixable today. Hold it out of the daily banner until a window exists (the board row +
  // its verdict still show). Promote/Pull are live gate changes — never window-gated.
  const changes = (d?.bettingBoard || []).filter(e =>
    _BET_ACTIONS[e?.doThis?.action] &&
    !(e.doThis.action === "Look deeper" && e.discoveredWindow == null));
  if (!AWAITING_VALIDATED_EDGE && changes.length) {
    const byAction = {};
    for (const e of changes) (byAction[e.doThis.action] ||= []).push(`${e.sport} ${e.category}`);
    const parts = Object.entries(byAction).map(([a, names]) => `${_BET_ACTIONS[a].verb} ${names.join(", ")}`);
    const lead = changes[0];
    out.push({ tier:2, tone:_BET_ACTIONS[lead.doThis.action].tone,
      label: parts.join("; "),
      why: lead.doThis.why || "betting change pending on the board",
      short:`${changes.length} betting change${changes.length>1?"s":""}` });
  }
  // 2.2 — model ACCURACY changes: proven-miscalibrated categories. The fix forks on Brier skill
  // (set server-side in honest.action): "Recalibrate" (model beats the price → L2 de-shrink, NOT a
  // new input) vs "Improve inputs" (market out-predicts → L0 new input, run tune:residual). Below a
  // live gate change, above ripe-validate. INPUT_SEARCH_EXHAUSTED suppresses ONLY the new-input nag
  // (a dead-end L0 search); a Recalibrate task is suppressed only while UN-RIPE — below RECAL_MIN_N
  // (n<200) or its Brier-skill trend is still MOVING (reliable |skillTrend| > _LEARN_FLAT, rising OR
  // falling) — since its de-shrink step isn't settled yet.
  const accChanges = (d?.accuracyBoard || []).filter(e =>
    _ACC_ACTIONS[e?.honest?.action] &&
    // Both the L0-input nag ("Improve inputs") and the MARKET_SHARPER one-time diagnostic
    // ("Diagnose then stop") point at tune:residual; suppress either once the L0 search is exhausted
    // — until a FORMULA_CUTOFF newer than the exhaustion date re-accrues the category clean.
    !((e.honest.action === "Improve inputs" || e.honest.action === "Diagnose then stop")
        && _stillExhausted(INPUT_SEARCH_EXHAUSTED, e.key || `${e.sport}|${e.category}`, e.formulaCutoff)) &&
    !(e.honest.action === "Recalibrate" && (
      (e.n || 0) < RECAL_MIN_N ||
      (e.learning?.reliable && Math.abs(e.learning.skillTrend) > _LEARN_FLAT))));
  if (!AWAITING_VALIDATED_EDGE && accChanges.length) {
    const byAction = {};
    for (const e of accChanges) (byAction[e.honest.action] ||= []).push(`${e.sport} ${e.category}`);
    const parts = Object.entries(byAction).map(([a, names]) =>
      `${_ACC_ACTIONS[a].verb} ${names.slice(0,3).join(", ")}${names.length>3?` +${names.length-3}`:""}`);
    const lead = accChanges[0]; // accuracyBoard is skill-desc, so the sharpest miss leads
    out.push({ tier:2.2, tone:_ACC_ACTIONS[lead.honest.action].tone,
      label: parts.join("; "),
      why: lead.honest?.why || "model calibration needs attention — see the accuracy board",
      short: `Accuracy ${accChanges.length}` });
  }
  // 2.5 — validate ripe shadow models: ungated categories with enough settled bets (n≥50) that are
  // trending positive but not yet gate-clean (verdict STRENGTHENING) — go run the manual tune:gate
  // + ?brier=1 to decide on gating. This is the build→gate half of the funnel: upstream of building
  // a NEW market, downstream of an actual board change (a clean PROMOTE already surfaces in tier 2).
  // `eligible` is required: the two-board hard gate refuses an ineligible category no matter what
  // tune:gate says, so nagging a validation run for one is wasted work — it stays a board row only.
  const ripe = (d?.bettingBoard || []).filter(e =>
    !e.gated && e.eligible === true && e.verdict === "STRENGTHENING" && e.checklist?.nOk && !_BET_ACTIONS[e?.doThis?.action]);
  if (!AWAITING_VALIDATED_EDGE && ripe.length) {
    const names = ripe.map(e => `${e.sport}|${e.category}`);
    out.push({ tier:2.5, tone:"blue",
      label: `Validate ${names.slice(0,3).join(", ")}${names.length>3?` +${names.length-3}`:""}`,
      why: "n≥50 and trending +ROI but not yet gate-clean — run tune:gate + ?brier=1 to decide on gating",
      short: `Validate ${ripe.length}` });
  }
  // 3 / 3.2 — build the next market on the roadmap (lowest rank wins; for the infra row, name its
  // NEXT item). Skip an infra/shipped row whose work is all done or data-gated (no NEXT badge) so the
  // quiet-day action falls through to the next thing actually buildable now. Priority forks on the
  // NEXT badge: an explicitly-flagged NEXT build is tier 3 (above the tier-3.15 window harvest — a
  // deliberate "this first" override), but a merely-unshipped roadmap entry is tier 3.2 (below it) —
  // harvesting already-accrued data beats authoring a NEW market unless the roadmap says otherwise.
  const next = [...MODEL_NEXT]
    .sort((a,b) => a.rank - b.rank)
    .find(s => (!s.infra && !_isShippedRoadmapEntry(s)) || s.markets?.some(m => m.badge === "NEXT"));
  if (next) {
    const nextItem = next.markets?.find(m => m.badge === "NEXT");
    const label = next.infra && nextItem ? `Build ${nextItem.ticker}` : `Build ${next.sport}`;
    out.push({ tier: nextItem ? 3 : 3.2, tone:"blue", label, why: nextItem?.title || next.note, short: label });
  }
  // 3.15 — derive a per-category bet window: an ungated category has accrued enough settled bets
  // (n≥WINDOW_RECOMMEND_N) AND provably beats the price (eligible = Brier skill CI-lo>0 @ n≥100) AND
  // shows +ROI OUTSIDE the current [67,91] window (over/sub-window) — i.e. its edge may live in a band
  // the global window misses (the mlb|totalBases-above-91¢ case capture de-blinding was built for).
  // Harvest of already-accrued data (near-term ROI, one script + a one-line config edit) → above
  // build/vet/triage of NEW markets, below the roadmap's flagged NEXT build. WINDOW_SEARCH_EXHAUSTED
  // suppresses categories already run to a terminal NO-GO, mirroring INPUT_SEARCH_EXHAUSTED.
  // Gate on the ACCURACY-board n (the Brier population tune:window actually reads), NOT the betting
  // board's own `n` — the latter is the narrow edge≥5 bettable histogram (~10) and would never clear
  // 200, while the tool operates on the full dc-qualified resolved set (~235). Join by key.
  // A key already in CATEGORY_BET_WINDOWS is DONE — its window was derived and applied, and since the
  // board's sub/over-window splits keep measuring against the GLOBAL [67,91] (not the override), the
  // trigger condition would otherwise hold forever. Same self-advancing source-of-truth pattern as
  // tier 3's SERIES_CONFIG shipped-detection: finishing the task silences the nag, no manual list edit.
  const _accN = Object.fromEntries((d?.accuracyBoard || []).map(a => [a.key, a.n || 0]));
  const winnable = (d?.bettingBoard || []).filter(e =>
    !e.gated && e.eligible === true && (_accN[e.key] || 0) >= WINDOW_RECOMMEND_N &&
    ((e.overWindow?.roi > 0) || (e.subWindow?.roi > 0)) &&
    !CATEGORY_BET_WINDOWS[e.key] &&
    !_stillExhausted(WINDOW_SEARCH_EXHAUSTED, e.key, e.formulaCutoff));
  if (!AWAITING_VALIDATED_EDGE && winnable.length) {
    const names = winnable.map(e => e.key);
    out.push({ tier:3.15, tone:"green",
      label: `Derive bet window: ${names.slice(0,3).join(", ")}${names.length>3?` +${names.length-3}`:""}`,
      why: `n≥${WINDOW_RECOMMEND_N}, model beats the price, and +ROI sits OUTSIDE [67,91] — run \`npm run tune:window -- --category ${names[0]}\` to derive + OOS/Brier-validate a window, then set CATEGORY_BET_WINDOWS.`,
      short: `Derive window ${winnable.length}` });
  }
  // 3.25 — vet shortlisted markets (promoted detections, mid-funnel). Below build-next (a vetted
  // roadmap market is further along), above triage (raw detections). Confirm data on both ends +
  // the first knob, then author the roadmap entry. Drop any ticker already live in SERIES_CONFIG
  // (shipped) so the banner self-advances the instant a market ships, without waiting for the
  // scan's adopt reconcile + the next report regen to flip its DB status.
  const shortlisted = (d?.shortlistedMarkets || []).filter(m => !SERIES_CONFIG[m.ticker]);
  if (shortlisted.length) {
    const titles = shortlisted.slice(0, 3).map(m => m.title || m.sampleSubtitle || m.ticker).join(", ");
    out.push({ tier:3.25, tone:"blue",
      label: `Vet ${shortlisted.length} shortlisted market${shortlisted.length > 1 ? "s" : ""}`,
      why: `${titles}${shortlisted.length > 3 ? " …" : ""} — confirm data on both ends + the first knob, then author the roadmap entry`,
      short: `Vet ${shortlisted.length} shortlisted` });
  }
  // 3.5 — triage detected new markets (kalshi-series-scan → `newMarkets`, already in the payload;
  // the funnel's first step). Below "build next" (a vetted roadmap market outranks raw detections)
  // but above the Polymarket floor, so an un-triaged queue becomes the quiet-day prompt instead of
  // jumping straight to platform expansion.
  const nm = (d?.newMarkets || []).filter(m => !SERIES_CONFIG[m.ticker]);
  if (nm.length) {
    const titles = nm.slice(0, 3).map(m => m.title || m.sampleSubtitle || m.ticker).join(", ");
    out.push({ tier:3.5, tone:"blue",
      label: `Triage ${nm.length} detected market${nm.length > 1 ? "s" : ""}`,
      why: `${titles}${nm.length > 3 ? " …" : ""} — dismiss noise, promote real candidates`,
      short: `Triage ${nm.length} detected` });
  }
  // 3.6 — sportsbook regime-change tripwire. Kill-gate CLOSED 2026-07-04: clean post-purge read
  // (0/68 sides ≥3¢ over 3d, max |Δ| 2¢, meanSigned −0.6¢ = Kalshi slightly EXPENSIVE) rejected
  // the ≥10% GAP bar at p≈0.001 — Phase 1b (latency logger) KILLED, liquid-ML lag thesis dead.
  // The feed stays as the truth anchor, so a GAP verdict NOW means the regime CHANGED (or a data
  // artifact — audit the tail first, per the 7/01 lesson), not "build 1b".
  const sbv = d?.sportsbookValidation;
  if (sbv?.verdict === "GAP") {
    out.push({ tier:3.6, tone:"blue",
      label:"Sportsbook GAP after closed kill-gate — investigate",
      why:`Kalshi is cheap vs the sharp book ≥3¢ on ${Math.round((sbv.fracBuyEdge3||0)*100)}% of traded sides (n=${sbv.n}/${sbv.days}d). The 7/04 kill-gate read was TIGHT (0/68 ≥3¢), so this is either a regime change or an artifact — audit /api/sportsbook-deltas?minAbs=3 rows BEFORE acting (fake-tail lesson, 7/01).`,
      short:"Sportsbook GAP → audit" });
  }
  // 4 — scheduled checkpoints (dated follow-ups; primary only when nothing above is actionable).
  // Each SCHEDULED_CHECKPOINTS entry stays quiet until its date, then surfaces daily until its
  // entry is removed/re-dated — so a "come back in two weeks" wait neither nags early nor gets
  // forgotten. Multiple due checkpoints surface oldest-first.
  const todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  for (const cp of [...SCHEDULED_CHECKPOINTS].sort((a, b) => a.date.localeCompare(b.date))) {
    if (todayPT < cp.date) continue;
    out.push({ tier:4, tone: cp.tone || "gray", label: cp.label,
      why: `${cp.why} (checkpoint due ${cp.date} — remove or re-date its SCHEDULED_CHECKPOINTS entry once handled)`,
      short: cp.short || cp.label });
  }
  // 5 — quiet-day floor: nothing above is actionable and no checkpoint is due yet. Show a calm
  // "caught up" state naming the NEXT upcoming checkpoint instead of an empty/absent banner.
  //
  // Copy rewritten 2026-07-28, reframed 2026-07-29: it read "Maker shadow accruing (N/200 graded
  // fills)" — progress toward an arm bar, off the fill count that day-clustering retired (days,
  // not fills, are the binding constraint). A quiet day means the instruments are running and
  // nothing has tripped them yet, which is the honest state: we are accumulating the data a
  // reliable pattern would show up in, and the series scan is what watches for a new market class.
  if (!out.length) {
    const upcoming = [...SCHEDULED_CHECKPOINTS].filter(c => c.date > todayPT).sort((a, b) => a.date.localeCompare(b.date))[0];
    out.push({ tier:5, tone:"gray", label:"No trade to place today — keep collecting",
      why:`No pattern has cleared its validation bar yet (docs/REENTRY.md). Shadow logging, maker quoting and fill detection, and the Kalshi series scan are all running and accumulating; the scan is what watches for a new market class worth vetting.${upcoming ? ` Next scheduled checkpoint: ${upcoming.short || upcoming.label} ~${upcoming.date}.` : ""}`, short:"Collecting" });
  }
  // Push order ≠ priority order anymore (tier 3.2 is pushed before 3.15) — sort by tier; ties keep
  // insertion order (stable sort), so multiple due checkpoints stay oldest-first.
  return out.sort((a, b) => a.tier - b.tier);
}
function DoThisBanner({ d }) {
  const [copied, setCopied] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  if (!d || d.notYet || d.error) return null;
  const cands = _doThisCandidates(d);
  if (!cands.length) return null;
  const [primary, ...rest] = cands;
  const color = _TONE[primary.tone] || C.blue;
  // A terminal/no-action tier (dim, gray) still has to be READABLE. What makes it quiet is the
  // absence of an accent color on the frame and of anything to click — not low contrast on the
  // headline itself, which just made the longest text block on the page the hardest to read.
  const labelColor = (primary.tone === "dim" || primary.tone === "gray") ? C.text : color;
  // Plain-text digest for pasting straight into a chat session as the next prompt.
  const copyText = [
    `Do this today: ${primary.label}`,
    primary.why,
    rest.length ? `Then: ${rest.map(r => r.short).join(" · ")}` : null,
  ].filter(Boolean).join("\n");
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked (insecure context / denied) — no-op */ }
  };
  return (
    <div style={{ background:`${color}14`, border:`1px solid ${color}66`, borderRadius:8, padding:"10px 14px", marginBottom:14 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:5 }}>
        <span style={{ color:C.gray, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:0.5 }}>Do this today</span>
        <button onClick={onCopy} title={copied ? "Copied" : "Copy as next-prompt input"} aria-label="Copy as next-prompt input" style={{
          cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
          color: copied ? C.green : color, background:"transparent",
          border:`1px solid ${copied ? C.green : color}66`, borderRadius:4, padding:"3px",
        }}>
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          )}
        </button>
      </div>
      <div style={{ color:labelColor, fontSize:15, fontWeight:700 }}>▶ {primary.label}</div>
      {/* `why` runs to a full paragraph on the terminal tiers (the shelve notice is ~600 chars).
          Clamp to two lines so the headline stays the thing you read first; the full text is one
          click away and always intact in the copy-to-prompt digest above. */}
      {primary.why && (
        <>
          <div style={{ color:C.text, fontSize:12, marginTop:3, lineHeight:1.45,
            ...(expanded ? {} : { display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden" }) }}>
            {primary.why}
          </div>
          {primary.why.length > 180 && (
            <button onClick={() => setExpanded(v => !v)} style={linkBtn}
              aria-expanded={expanded}>{expanded ? "Less ▲" : "Why ▼"}</button>
          )}
        </>
      )}
      {/* The queued rest. Restored to the DOM 2026-07-28: it had been copy-text-only, which meant
          the entire ladder below `primary` was visible only to someone who clicked the copy icon
          and pasted it somewhere. Combined with an unconditional tier that always won the primary
          slot, that hid 8 overdue checkpoints. Every remaining item shows — truncating this list is
          how work goes missing, and `short` is a few words each. */}
      {rest.length > 0 && (
        <div style={{ color:C.gray, fontSize:11, marginTop:7, lineHeight:1.5 }}>
          <span style={{ color:C.dim, fontWeight:700 }}>Then · </span>
          {rest.map(r => r.short).join(" · ")}
        </div>
      )}
    </div>
  );
}

// ---- STAT TILE -------------------------------------------------------------------
function Tile({ label, value, color, sub }) {
  return (
    <div style={{ flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 10px", minWidth:0 }}>
      <div style={{ color, fontSize:22, fontWeight:700, lineHeight:1, fontVariantNumeric:"tabular-nums" }}>{value}</div>
      <div style={{ color:C.dim, fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4, marginTop:3 }}>{label}</div>
      {sub && <div style={{ color:C.dim, fontSize:9, marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{sub}</div>}
    </div>
  );
}

// ---- MAKER PROGRESS: the shadow (V1) strategy progress module (2026-07-19) ------------------
// Replaces the legacy accuracy/betting board table. The strategy question changed from
// "which model beats the market?" (answered 7/19: none — taker edge is structurally
// negative venue-wide) to "is the maker margin surviving adverse selection, and how close
// are we to arming?" Forms follow the data's job: arm progress = stat tile + meter;
// margin trajectory = single-hue cumulative line; category×band economics = a diverging heatmap.
// Color doctrine: NO categorical series palette — magnitude via one channel (alpha), green/red
// only on SIGNED values (the +/− prefix is the non-color channel).
//
// ArmTile was REMOVED 2026-07-29. It rendered progress toward arming (N/14 days · N/200 fills +
// a meter), which read as a countdown to going live — wrong twice over (V2 is shelved, and the
// board is negative) and the source of four false greens off the fill-level CI. Its one honest
// element, the day-clustered mean + CI, moved into CrossCheckStrip's "Book" cell. The arm gate is
// `armCriterion.met` server-side; the client never re-derives it.

// Cumulative graded paper PnL by day. Single series → one hue, no legend; the section
// title names it. Zero baseline; per-point tooltip; the current value is the one direct label.
// Cumulative totals display in dollars (matches the $-formatting idiom used for pick P/L
// elsewhere — MyPicksColumn/DayBar); per-contract rates stay in cents everywhere else, since
// cents is the native Kalshi quoting unit and a running total in cents gets unreadable fast.
const fmtUsdFromCents = c => `${c >= 0 ? "+" : ""}$${Math.abs(c / 100).toFixed(2)}`;
// `day` arrives as an ISO date string (`makerBoard.daily[].day`, `String(q.game_date).slice(0,10)`
// server-side — verified against live payload, not assumed). Anything else renders raw rather than
// guessing: a mis-parsed axis label is worse than an ugly one.
const fmtAxisDay = (day) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day || "");
  return m ? `${+m[1]}/${+m[2]}` : (day || "");
};

function EquityCurve({ daily }) {
  const pts = [];
  let cum = 0;
  for (const d of daily || []) {
    if (!(d.graded > 0) && !pts.length) continue; // skip leading no-fill days
    cum += d.pnlTotal || 0;
    pts.push({ day: d.day, cum: parseFloat(cum.toFixed(1)) });
  }
  if (pts.length < 2) {
    return <div style={{ color:C.dim, fontSize:10, padding:"10px 0" }}>
      Paper equity curve appears once graded fills span two days{pts.length === 1 ? ` — day 1: ${fmtUsdFromCents(pts[0].cum)} paper` : ""}.
    </div>;
  }
  // PH = plot height; AXIS = the band below it that holds the date labels. ys() maps into the PLOT
  // area only, so adding the axis grew the svg rather than compressing the series.
  const W = 560, PH = 90, AXIS = 15, H = PH + AXIS, P = 8;
  const xs = i => P + i * (W - 2 * P) / (pts.length - 1);
  const vals = pts.map(p => p.cum);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const ys = v => hi === lo ? PH / 2 : P + (hi - v) * (PH - 2 * P) / (hi - lo);
  // Thin the labels so they can never collide: LABEL_W is one label's footprint in viewBox units at
  // fontSize 9. Today's 9 days all fit (~68 units apart); this only starts dropping labels once the
  // series is long enough that it has to, and the LAST day is always kept — it's the one the
  // endpoint value belongs to.
  const LABEL_W = 34;
  const step = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor((W - 2 * P) / LABEL_W))));
  const ticks = pts.map((_, i) => i).filter(i => i % step === 0 || i === pts.length - 1);
  if (ticks.length > 2 && xs(ticks[ticks.length - 1]) - xs(ticks[ticks.length - 2]) < LABEL_W) {
    ticks.splice(ticks.length - 2, 1);
  }
  const path = pts.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.cum).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", display:"block" }} role="img"
      aria-label={`Cumulative paper maker PnL by day, ${pts[0].day} to ${last.day}, ending ${fmtUsdFromCents(last.cum)} simulated`}>
      <line x1={P} x2={W - P} y1={ys(0)} y2={ys(0)} stroke={C.border} strokeWidth="1" />
      <path d={path} fill="none" stroke={C.blue} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={p.day} cx={xs(i)} cy={ys(p.cum)} r="3.5" fill={C.blue} stroke={C.bg} strokeWidth="2">
          <title>{`${p.day}: ${fmtUsdFromCents(p.cum)} cumulative — simulated, not account money`}</title>
        </circle>
      ))}
      {/* The endpoint label carries the word "paper" INLINE. This figure sits ~250px from the real
          V2 PnL tile and is ~230x larger; whatever the section head says, the two things actually
          read at a glance are these two dollar amounts, so the disclaimer has to live on the number
          itself. Subordinated to C.gray for the same reason — real money is the brighter figure. */}
      <text x={Math.min(xs(pts.length - 1), W - P - 4)} y={Math.max(12, ys(last.cum) - 8)}
        textAnchor="end" fill={C.gray} fontSize="11" fontWeight="700">
        {fmtUsdFromCents(last.cum)}<tspan fill={C.dim} fontWeight="400"> paper</tspan>
      </text>
      {/* Date axis. No rule and no tick marks — the dots already mark the x positions and the zero
          line is the only reference the series needs; a second horizontal rule 8 units under the
          first would read as a second baseline. End labels anchor inward so they can't clip. */}
      {ticks.map(i => (
        <text key={pts[i].day} x={xs(i)} y={PH + 10} fontSize="9" fill={C.dim}
          textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}>
          {fmtAxisDay(pts[i].day)}
        </text>
      ))}
    </svg>
  );
}

// Per-ask-band ladder: bar length = fills (magnitude, single hue); margin is a signed,
// colored figure per row (small fixed row count → direct labels are correct here).
// ---- CROSS-CHECK STRIP (2026-07-29) --------------------------------------------------------
// Two independent measurements of the same quantity, shown as a DIFF with the disagreement as the
// headline — the class of view that catches instrument bugs (a prettier slice of one stream never
// does). Replaces the loose "fill rate / adverse selection / checkpoints" tile row, whose numbers
// were all single-stream aggregates. The V1↔V2 cell is the one that would have surfaced the
// wrong-side-fill bug months earlier: on the SAME [80,84] band the simulator and real orders must
// agree, and for the engine's whole life they didn't — a gap rationalised as "different
// populations". Plus a Book cell carrying the day-clustered interval (the honest one), folding in
// what ArmTile used to say.
function _centsColor(v) { return v == null ? C.dim : v > 0 ? C.green : v < 0 ? C.red : C.gray; }
function _fmtCents(v) { return v == null ? "—" : `${v > 0 ? "+" : ""}${v}¢`; }

function CrossCheckCell({ children, flag }) {
  return (
    <div style={{ flex:1, minWidth:180, background:C.card, borderRadius:6, padding:"8px 10px",
      border:`1px solid ${flag ? C.red : C.border}` }}>{children}</div>
  );
}

function CrossCheckStrip({ mb }) {
  const cc = mb?.crossChecks || [];
  const v1v2 = cc.find(c => c.key === "v1v2");
  const mm = cc.find(c => c.key === "model_market");
  const dc = mb?.fills?.dayClustered || {};
  const ci = dc.loCI != null && dc.hiCI != null
    ? `${dc.loCI > 0 ? "+" : ""}${dc.loCI} … ${dc.hiCI > 0 ? "+" : ""}${dc.hiCI}` : null;
  const headStyle = { color:C.dim, fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:0.4, marginBottom:5 };
  return (
    <div style={{ display:"flex", gap:8, marginBottom:10, flexWrap:"wrap" }}>
      {/* 1 — the bug-catcher: two independent measurements of the SAME band */}
      {v1v2 && (
        <CrossCheckCell flag={v1v2.flag}>
          <div style={headStyle}>Cross-check · sim vs real</div>
          <div style={{ display:"flex", alignItems:"baseline", gap:6, fontVariantNumeric:"tabular-nums" }}>
            <span style={{ color:_centsColor(v1v2.a.cents), fontSize:16, fontWeight:700 }}>{_fmtCents(v1v2.a.cents)}</span>
            <span style={{ color:C.dim, fontSize:11 }}>sim</span>
            <span style={{ color:C.dim, fontSize:11 }}>vs</span>
            <span style={{ color:_centsColor(v1v2.b.cents), fontSize:16, fontWeight:700 }}>{_fmtCents(v1v2.b.cents)}</span>
            <span style={{ color:C.dim, fontSize:11 }}>real</span>
          </div>
          <div style={{ color: v1v2.flag ? C.red : C.dim, fontSize:9, marginTop:3 }}>
            Δ {v1v2.deltaCents != null ? `${v1v2.deltaCents > 0 ? "+" : ""}${v1v2.deltaCents}¢` : "—"} on [80,84] · {v1v2.flag ? "DISAGREE — instrument bug" : "agree (same band)"}
          </div>
        </CrossCheckCell>
      )}
      {/* 2 — model vs market: headline is how many categories beat the market with confidence */}
      {mm && (
        <CrossCheckCell flag={mm.flag}>
          <div style={headStyle}>Cross-check · model vs market</div>
          <div style={{ fontVariantNumeric:"tabular-nums" }}>
            <span style={{ color: mm.beats > 0 ? C.green : C.gray, fontSize:16, fontWeight:700 }}>{mm.beats}/{mm.trusted}</span>
            <span style={{ color:C.dim, fontSize:11, marginLeft:6 }}>beat market (Brier, n≥100)</span>
          </div>
          <div style={{ color:C.dim, fontSize:9, marginTop:3 }}>
            best {mm.a.cat ? mm.a.cat.replace("|", " ") : "—"} skill {mm.a.skill != null ? `${mm.a.skill > 0 ? "+" : ""}${mm.a.skill.toFixed(3)}` : "—"}
          </div>
        </CrossCheckCell>
      )}
      {/* 3 — the honest book total: day-clustered, never the fill-level CI */}
      <CrossCheckCell flag={false}>
        <div style={headStyle}>Book · day-clustered</div>
        <div style={{ fontVariantNumeric:"tabular-nums" }}>
          <span style={{ color:_centsColor(dc.mean), fontSize:16, fontWeight:700 }}>{dc.mean != null ? _fmtCents(dc.mean) : "—"}</span>
          <span style={{ color:C.dim, fontSize:11, marginLeft:6 }}>/ct · {dc.days ?? 0} days</span>
        </div>
        <div style={{ color:C.dim, fontSize:9, marginTop:3 }}>{ci ? `95% CI ${ci}` : "accruing"} · {(mb?.fills?.graded ?? 0).toLocaleString("en-US")} graded fills</div>
      </CrossCheckCell>
    </div>
  );
}

// ---- CATEGORY × BAND HEATMAP (2026-07-29, replaces BandLadder) ------------------------------
// The band ladder pooled every category into one price bar, which is exactly how the 55-64
// "edge" (really one category, ligamx|teamTotal, at an impossible +52¢) hid long enough to send
// us chasing a phantom. This grain LOCALISES: category rows × band columns, cell = ¢/contract,
// green/red on sign only (color doctrine — magnitude via alpha, never hue). Two marks the pooled
// view could not carry: a red ring on an ANOMALY (sideWon pinned 0/1 = grading/side artifact,
// the flag that would have caught the wrong-side bug) and a caution dot when >50% of a cell's PnL
// came from ONE day (the selection tell that debunked both 55-64 and 90-96). Rows sorted by
// volume, capped so the page stays a screen; the tail is low-volume noise.
const _BANDS = ["55-59", "60-64", "65-69", "70-74", "75-79", "80-84", "85-89", "90-96"];
// Color encodes RELIABILITY, not magnitude. Coloring the biggest mean brightest is best-of-N
// selection with a paint job — it aims the eye at whichever of ~100 noisy cells caught the
// luckiest slate. So a cell whose day-clustered CI straddles zero (i.e. not distinguishable from
// noise — which is currently every cell) is heavily MUTED regardless of how big its number is;
// only a cell whose interval actually clears zero gets saturated. A big number in a pale cell is
// the tell: that is noise, not a target.
function _cellBg(v, scale, reliable) {
  if (v == null) return "transparent";
  const base = Math.min(0.85, 0.12 + Math.abs(v) / scale * 0.6);
  const a = reliable ? base : base * 0.28;   // unreliable → dim, on purpose
  return v > 0 ? `rgba(63,185,80,${a})` : v < 0 ? `rgba(247,129,102,${a})` : C.card;
}
function CategoryBandHeatmap({ cells, maxRows = 14 }) {
  const rows = React.useMemo(() => {
    const cs = cells || [];
    if (!cs.length) return [];
    const byCat = new Map();
    for (const c of cs) {
      const k = `${c.sport}|${c.category}`;
      let row = byCat.get(k);
      if (!row) { row = { key: k, label: `${c.sport} ${c.category}`, contracts: 0, pnl: 0, cells: {} }; byCat.set(k, row); }
      row.cells[c.band] = c;
      row.contracts += c.contracts;
      row.pnl += (c.perContract ?? 0) * c.contracts;
    }
    return [...byCat.values()].sort((a, b) => b.contracts - a.contracts);
  }, [cells]);
  if (!rows.length) return <div style={{ color:C.dim, fontSize:10, padding:"6px 0" }}>Category economics appear with the first graded fills.</div>;
  const scale = Math.max(4, ...rows.flatMap(r => Object.values(r.cells).map(c => Math.abs(c.perContract ?? 0))));
  const shown = rows.slice(0, maxRows);
  const colW = 46;
  const total = (cells || []).length;
  const reliableN = (cells || []).filter(c => c.reliable).length;
  return (
    <div style={{ overflowX:"auto" }}>
      {/* Headline that answers "is any single cell bettable?" before the eye starts hunting the
          brightest number. When 0 cells clear zero (the current, honest state), it says so. */}
      <div style={{ fontSize:10, marginBottom:5, color: reliableN ? C.amber : C.dim }}>
        {reliableN
          ? `${reliableN} of ${total} cells clear zero (day-clustered) — still selection among ${total}; confirm forward before treating any as a target.`
          : `0 of ${total} cells clear zero (day-clustered) — no single cell is distinguishable from noise. This view is for spotting anomalies and where PnL sits, not for picking bets.`}
      </div>
      <div style={{ minWidth: 150 + _BANDS.length * colW }}>
        {/* header: band price columns */}
        <div style={{ display:"flex", fontSize:9, color:C.dim, fontWeight:700, marginBottom:2 }}>
          <span style={{ width:150 }} />
          {_BANDS.map(b => <span key={b} style={{ width:colW, textAlign:"center" }}>{b}</span>)}
          <span style={{ width:56, textAlign:"right" }}>¢/ct</span>
        </div>
        {shown.map(r => {
          const rowPer = r.contracts ? r.pnl / r.contracts : null;
          return (
            <div key={r.key} style={{ display:"flex", alignItems:"stretch", marginBottom:2, fontSize:10 }}>
              <span style={{ width:150, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", alignSelf:"center" }}>{r.label}</span>
              {_BANDS.map(b => {
                const c = r.cells[b];
                if (!c) return <span key={b} style={{ width:colW, height:22, border:`1px solid ${C.border}`, boxSizing:"border-box", marginRight:1 }} />;
                const oneDay = (c.topDayShare ?? 0) >= 0.5;
                const ciTxt = c.ciLo != null ? `${c.ciLo > 0 ? "+" : ""}${c.ciLo}…${c.ciHi > 0 ? "+" : ""}${c.ciHi}` : "n/a";
                return (
                  <span key={b} title={`${r.label} ${b}¢: ${c.perContract > 0 ? "+" : ""}${c.perContract}¢/ct · ${c.fills} fills · sideWon ${c.sideWon} · ${c.days}d · day-clustered CI ${ciTxt} (${c.reliable ? "clears 0" : "straddles 0 — not distinguishable from noise"}) · top day ${Math.round((c.topDayShare ?? 0) * 100)}% of |PnL|${c.anomaly ? " · ANOMALY: outcome pinned against price" : ""}`}
                    style={{ position:"relative", width:colW, height:22, marginRight:1, boxSizing:"border-box",
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontVariantNumeric:"tabular-nums", color: c.reliable ? C.text : C.dim,
                      background:_cellBg(c.perContract, scale, c.reliable),
                      border: c.anomaly ? `1.5px solid ${C.red}` : `1px solid ${C.border}` }}>
                    {c.perContract != null ? `${c.perContract > 0 ? "+" : ""}${c.perContract}` : ""}
                    {oneDay && <span style={{ position:"absolute", top:1, right:2, width:4, height:4, borderRadius:2, background:C.amber }} />}
                  </span>
                );
              })}
              <span style={{ width:56, textAlign:"right", alignSelf:"center", fontWeight:700, fontVariantNumeric:"tabular-nums", color:_centsColor(rowPer && parseFloat(rowPer.toFixed(2))) }}>
                {rowPer != null ? `${rowPer > 0 ? "+" : ""}${rowPer.toFixed(1)}` : "—"}
              </span>
            </div>
          );
        })}
        <div style={{ color:C.dim, fontSize:9, marginTop:5, lineHeight:1.5 }}>
          ¢/contract, graded fills · <b>brightness = reliability</b> (day-clustered CI clear of zero), NOT size — a big number in a pale cell is noise · <span style={{ color:C.amber }}>●</span> &gt;50% of PnL from one day · <span style={{ color:C.red }}>▢</span> anomaly: outcome pinned against price (P&lt;0.1%)
          {rows.length > shown.length ? ` · +${rows.length - shown.length} lower-volume categories hidden` : ""}
        </div>
      </div>
    </div>
  );
}

function MakerProgress({ mb }) {
  const todayPT = new Date().toLocaleDateString("en-CA", { timeZone:"America/Los_Angeles" });
  // Overdue checkpoints outrank the next future one. This tile used to filter `c.date > todayPT`
  // ONLY, so it structurally skipped everything already due: on 2026-07-28 it displayed
  // "next clock · Jul 29" while EIGHT checkpoints were overdue (oldest 2026-07-23). Since the
  // banner was simultaneously burying its own checkpoint tier, the page's two independent
  // checkpoint surfaces agreed that nothing was due — the failure mode a dated-follow-up
  // mechanism exists to prevent. A checkpoint that isn't due yet is FYI; one that is due is work.
  const dueCps = [...SCHEDULED_CHECKPOINTS].filter(c => c.date <= todayPT).sort((a, b) => a.date.localeCompare(b.date));
  const nextCp = [...SCHEDULED_CHECKPOINTS].filter(c => c.date > todayPT).sort((a, b) => a.date.localeCompare(b.date))[0];
  const fmtCpDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month:"short", day:"numeric" });
  if (!mb) {
    return <div style={{ color:C.dim, fontSize:11, padding:8 }}>Maker board not in this report yet — Refresh regenerates it.</div>;
  }
  const f = mb.fills || {};
  const cbAnomalies = (mb.categoryBands || []).filter(c => c.anomaly).length;
  return (
    <div style={{ marginBottom:12 }}>
      <div style={sectionHead}>Shadow maker V1 · simulated favorite-ask quoting</div>
      <div style={{ color:C.dim, fontSize:10, lineHeight:1.45, margin:"-4px 0 9px", maxWidth:760 }}>
        Paper — V1 quotes every eligible ticker ({(f.graded ?? 0).toLocaleString("en-US")} graded fills). Read the
        cross-checks first: they compare two independent measurements of the same thing, which is what catches an
        instrument bug — a bad slice of one stream never does. {cbAnomalies > 0
          ? <span style={{ color:C.red }}>{cbAnomalies} category×band cell{cbAnomalies > 1 ? "s" : ""} flagged (sideWon pinned) — investigate before trusting the rest.</span>
          : "No cell anomalies flagged."}
      </div>

      {/* Cross-check strip replaces the old loose tile row (fill-rate / adverse-selection /
          checkpoints — all single-stream aggregates). The checkpoint clock moved to the DoThisBanner,
          which already owns dated follow-ups, so it is not duplicated here. */}
      <CrossCheckStrip mb={mb} />
      {dueCps.length ? (
        <div style={{ color:C.amber, fontSize:10, margin:"-2px 0 8px" }}>
          {dueCps.length} checkpoint{dueCps.length > 1 ? "s" : ""} due — oldest {fmtCpDate(dueCps[0].date)}: {dueCps[0].short || dueCps[0].label}
        </div>
      ) : nextCp ? (
        <div style={{ color:C.dim, fontSize:10, margin:"-2px 0 8px" }}>next checkpoint {fmtCpDate(nextCp.date)} · {nextCp.short}</div>
      ) : null}

      {/* Category × band heatmap (localiser) full-width; equity curve (trajectory) kept but
          secondary, below it. The old side-by-side curve+ladder is gone: the ladder was the
          band-picking anti-pattern, and the heatmap needs the width. */}
      <div style={microHead}>CATEGORY × BAND · ¢/CONTRACT (GRADED) — WHERE PnL ACTUALLY COMES FROM</div>
      <CategoryBandHeatmap cells={mb.categoryBands} />
      <div style={{ marginTop:12, maxWidth:560 }}>
        <div style={microHead}>PAPER EQUITY · CUMULATIVE GRADED PnL (TRAJECTORY)</div>
        <EquityCurve daily={mb.daily} />
      </div>
    </div>
  );
}

// ---- MAKER UTILIZATION: eligible-vs-resting per sport (2026-07-21) -----------------
// Reuses BandLadder's bar-row visual pattern. Surfaces cap pressure — e.g. 73 eligible vs a
// 20-slot MAKER_V2_MAX_CONCURRENT cap means most eligible tickers never get a resting order,
// which is useful context for whether the cap should move, not just an FYI.
// Collapsed while DISARMED (2026-07-28): with no engine resting orders every per-sport row is a
// full-width empty track reading `0/N resting`, so the block became the largest thing on the page
// while carrying one bit ("nothing is resting"). That bit belongs in the summary line. The rows
// stay one click away, and come back expanded-by-default the moment the engine is armed — that is
// when eligible-vs-resting per sport is the cap-pressure diagnostic it was built to be.
function MakerUtilization({ eligibleBySport, orders, caps, armed }) {
  const [expanded, setExpanded] = React.useState(false);
  const restingBySport = {};
  for (const o of orders || []) {
    if (o.status !== "resting") continue;
    const s = o.sport || "unknown";
    restingBySport[s] = (restingBySport[s] || 0) + 1;
  }
  const sports = Object.keys(eligibleBySport || {}).sort((a, b) => (eligibleBySport[b] || 0) - (eligibleBySport[a] || 0));
  if (!sports.length) {
    return <div style={{ color:C.dim, fontSize:10, padding:"6px 0" }}>No eligible tickers right now.</div>;
  }
  const totalEligible = sports.reduce((s, k) => s + (eligibleBySport[k] || 0), 0);
  const totalResting = Object.values(restingBySport).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...sports.map(s => eligibleBySport[s] || 0));
  const showRows = armed || expanded;
  return (
    <div style={{ maxWidth:560 }}>
      <div style={{ color:C.dim, fontSize:10, marginBottom:6 }}>
        {totalResting}/{totalEligible} eligible currently resting · cap {caps?.maxConcurrent ?? "—"} concurrent, {caps?.sameGameCap ?? "—"}/game
        {totalEligible > (caps?.maxConcurrent ?? Infinity) && (
          <span style={{ color:C.amber, fontWeight:700 }}> · cap-bound tonight</span>
        )}
      </div>
      {!armed && (
        <button onClick={() => setExpanded(v => !v)} style={{ ...linkBtn, marginTop:0, marginBottom:expanded ? 4 : 0 }}
          aria-expanded={expanded}>
          {expanded ? "Hide per-sport ▲" : `Show per-sport (${sports.length} sports, none resting while disarmed) ▼`}
        </button>
      )}
      {showRows && sports.map(s => {
        const eligible = eligibleBySport[s] || 0;
        const resting = restingBySport[s] || 0;
        return (
          <div key={s} style={{ display:"flex", alignItems:"center", gap:8, margin:"3px 0", fontSize:10 }}
            title={`${s}: ${eligible} eligible, ${resting} currently resting`}>
            <span style={{ color:C.gray, width:70, textTransform:"uppercase" }}>{s}</span>
            <div style={{ flex:1, height:10, background:C.card, border:`1px solid ${C.border}`, borderRadius:3, overflow:"hidden", boxSizing:"border-box", position:"relative" }}>
              <div style={{ width:`${eligible / max * 100}%`, height:"100%", background:C.border }} />
              <div style={{ width:`${resting / max * 100}%`, height:"100%", background:C.blue, position:"absolute", top:0, left:0 }} />
            </div>
            <span style={{ color:C.dim, width:100, whiteSpace:"nowrap", textAlign:"right" }}>{resting}/{eligible} resting</span>
          </div>
        );
      })}
    </div>
  );
}

// Matchup label from the DB game_key (sport|gameDate|team1-team2, sorted teams — see
// gameKeyFor in api/lib/maker-live.js). Falls back to the ticker if the key is malformed.
function matchupLabel(o) {
  const parts = (o.gameKey || "").split("|");
  const teams = parts[2];
  return teams ? teams.replace("-", " vs ") : o.ticker;
}

// V2 sells the favorite (a short: real order is a buy of the complement — see sellAsBuy in
// maker-live.js), so a held position's economics don't map onto Kalshi's own "cost/cash-out/max
// payout" (long-position) framing. Collected = premium taken in at sale; Buy-back now = current
// ask on the same side, i.e. what it'd cost to close today; Unrealized = the difference (positive
// = favorite got cheaper = winning); Max risk = 100 − collected, the worst case at resolution.
function MakerLivePositions({ positions }) {
  if (!positions?.length) {
    return <div style={{ color:C.dim, fontSize:10, padding:"6px 0" }}>No open positions — appears once a resting V2 order fills.</div>;
  }
  const sorted = [...positions].sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
  return (
    <div style={{ maxWidth:820 }}>
      <div style={{ display:"flex", gap:8, fontSize:9, color:C.dim, fontWeight:700, textTransform:"uppercase", padding:"0 2px", marginBottom:2 }}>
        <span style={{ width:70 }}>Sport</span>
        <span style={{ flex:1 }}>Market</span>
        <span style={{ width:36 }}>Side</span>
        <span style={{ width:64, textAlign:"right" }}>Collected</span>
        <span style={{ width:80, textAlign:"right" }}>Buy-back now</span>
        <span style={{ width:70, textAlign:"right" }}>Unrealized</span>
        <span style={{ width:64, textAlign:"right" }}>Max risk</span>
      </div>
      <div style={{ maxHeight:280, overflowY:"auto" }}>
        {sorted.slice(0, 80).map(o => (
          <div key={`${o.ticker}-${o.placedAt}`} style={{ display:"flex", gap:8, alignItems:"center", fontSize:10, padding:"3px 2px",
            borderTop:`1px solid ${C.border}` }} title={o.ticker}>
            <span style={{ width:70, color:C.gray, textTransform:"uppercase" }}>{o.sport || "—"}</span>
            <span style={{ flex:1, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {matchupLabel(o)} <span style={{ color:C.dim }}>· {o.category || o.series}</span>
            </span>
            <span style={{ width:36, color:C.gray, textTransform:"uppercase" }}>{o.side}</span>
            <span style={{ width:64, textAlign:"right", color:C.text, fontVariantNumeric:"tabular-nums" }}>{o.price}¢×{o.filledCount}</span>
            <span style={{ width:80, textAlign:"right", color:C.text, fontVariantNumeric:"tabular-nums" }}>
              {o.currentAskCents != null ? `${o.currentAskCents}¢` : "—"}
            </span>
            <span style={{ width:70, textAlign:"right", fontWeight:700, fontVariantNumeric:"tabular-nums",
              color: o.unrealizedCents == null ? C.dim : o.unrealizedCents > 0 ? C.green : o.unrealizedCents < 0 ? C.red : C.gray }}>
              {o.unrealizedDollars != null
                ? `${o.unrealizedDollars > 0 ? "+" : ""}$${o.unrealizedDollars.toFixed(2)} ${o.unrealizedCents > 0 ? "▲" : o.unrealizedCents < 0 ? "▼" : ""}`
                : "—"}
            </span>
            <span style={{ width:64, textAlign:"right", color:C.dim, fontVariantNumeric:"tabular-nums" }}>{o.maxRiskCents}¢×{o.filledCount}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function useMakerBoardData() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const fetchBoard = React.useCallback(() => {
    setLoading(true);
    return fetch(`${WORKER}/maker-v2-board`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData(prev => prev))
      .finally(() => setLoading(false));
  }, []);
  React.useEffect(() => { fetchBoard(); }, [fetchBoard]);
  return { boardData: data, boardLoading: loading, fetchBoard };
}

// Portfolio summary strip — mirrors Kalshi's own app header (Portfolio total + a green/red
// "+$X.XX (+Y.YY%)" delta line). Bankroll + Positions come from the real Kalshi account
// (/api/kalshi-balance — Positions is cost basis across ALL open real positions, V2 + any
// manually-placed orders, NOT mark-to-market). The PnL delta is V2-only — cumulative graded
// PnL summed across every day in the equity-curve series (all-time since V2 started, same
// total the old line chart ended on), shown as % of the current bankroll — since there's no
// whole-account PnL ledger; manually-placed real orders are never logged anywhere but the KV
// picks blob, which has no PnL rollup at all.
function PortfolioTiles({ kalshiBalance, kalshiPositions, dailyV2 }) {
  const graded = (dailyV2 || []).filter(d => d.graded > 0);
  const cumCents = graded.length ? graded.reduce((s, d) => s + (d.pnlTotal || 0), 0) : null;
  const pnlColor = cumCents == null ? C.dim : cumCents > 0 ? C.green : cumCents < 0 ? C.red : C.gray;
  const pct = cumCents != null && kalshiBalance ? (cumCents / 100 / kalshiBalance) * 100 : null;
  const pnlLabel = cumCents == null ? "—"
    : `${cumCents < 0 ? "-" : "+"}$${Math.abs(cumCents / 100).toFixed(2)}${pct != null ? ` (${pct < 0 ? "-" : "+"}${Math.abs(pct).toFixed(2)}%)` : ""}`;
  return (
    <div style={{ display:"flex", gap:8, marginBottom:12, flexWrap:"wrap" }}>
      <Tile label="bankroll" color={C.text} value={kalshiBalance != null ? `$${kalshiBalance.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}` : "—"}
        sub="Kalshi account · cash + positions" />
      <Tile label="positions" color={C.text} value={kalshiPositions != null ? `$${kalshiPositions.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}` : "—"}
        sub="cost basis · V2 + manual, not mark-to-market" />
      {/* "real" is in the LABEL, not just the sub-line: the V1 paper equity total further down the
          page is ~230x this number, and a reader scanning two dollar figures needs the real/paper
          split before they read either value. */}
      <Tile label="V2 PnL · real money" color={pnlColor} value={pnlLabel}
        sub={graded.length ? `real capital · all-time · ${graded.reduce((s, d) => s + d.graded, 0)} graded fills` : "awaiting first graded fill"} />
    </div>
  );
}

// ---- MAKER BOARD PAGE (the new default landing page, 2026-07-21) ------------------
export default function MakerBoardPage({ shadowReportData, shadowReportLoading, fetchShadowReport,
  isLoggedIn, navigateToPicks, kalshiBalance, kalshiPositions }) {
  const { boardData, boardLoading, fetchBoard } = useMakerBoardData();

  React.useEffect(() => {
    if (isLoggedIn && !shadowReportData && !shadowReportLoading) fetchShadowReport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  // Refresh must reload BOTH data sources: boardData (orders/positions — always live, no cache)
  // and shadowReportData (bankroll/positions/V2-PnL tiles + DoThisBanner + MakerProgress — cached
  // up to 25h server-side). Before this, Refresh only re-fetched boardData, so a real change to
  // realized PnL (e.g. new grades landing) stayed invisible until a full page reload picked up a
  // fresh shadowReportData on mount — confusing when the underlying numbers had genuinely changed.
  const refreshAll = React.useCallback(() => {
    fetchBoard();
    fetchShadowReport(true);
  }, [fetchBoard, fetchShadowReport]);

  return (
    <div style={{ maxWidth:1280, margin:"0 auto", padding:"16px 16px" }}>
      <div style={{ display:"flex", alignItems:"center", marginBottom:14, gap:12 }}>
        <h1 style={{ color:"#fff", fontSize:18, fontWeight:700, margin:0, flex:1 }}>Shadow Maker</h1>
        <button onClick={refreshAll} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"4px 10px", cursor:"pointer" }}>
          {boardLoading || shadowReportLoading ? "Refreshing…" : "Refresh"}
        </button>
        <button onClick={navigateToPicks} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"4px 10px", cursor:"pointer" }}>
          Picks →
        </button>
      </div>

      {!isLoggedIn ? (
        <div style={{ color:C.dim, fontSize:12, padding:12 }}>Log in to see the shadow maker board.</div>
      ) : (
        <>
          {shadowReportLoading && !shadowReportData ? (
            <div style={{ color:C.dim, fontSize:12, padding:12 }}>Generating report…</div>
          ) : (
            <DoThisBanner d={shadowReportData} />
          )}

          <PortfolioTiles kalshiBalance={kalshiBalance} kalshiPositions={kalshiPositions}
            dailyV2={shadowReportData?.makerBoard?.live?.daily} />

          {/* Arm state, and — since 2026-07-28 — the shelved fact, moved here out of the DoThisBanner
              tier that was permanently occupying the day's primary action slot with it. This is
              where a reader already looks to find out whether the engine is live, and a status
              costs nothing here whereas in the banner it cost the entire ladder below it.
              `shelved` comes from the server's own MAKER_V2_SHELVED, so the one-line un-shelve
              revert clears this line too. */}
          <div style={{ ...sectionHead, borderTop:"none", paddingTop:0, marginTop:8 }}>Open positions (V2 · real capital) {boardData?.armed
            ? <span style={{ color:C.green }}>· ARMED</span>
            : <span style={{ color:C.dim }}>· {boardData?.shelved ? "SHELVED" : "disarmed"}</span>}
          </div>
          {boardData?.shelved && (
            <div style={{ color:C.dim, fontSize:10, lineHeight:1.45, margin:"-4px 0 8px", maxWidth:720 }}>
              No demonstrated fillable edge. The apparent quote-side vig (+1.5-1.6¢) that once looked like the one
              replicating effect turned out to be an instrument bug — <code>replayFills</code> matched the wrong taker
              side for the engine's whole life; corrected and rebuilt, the book is <span style={{ color:C.red }}>−1.0¢/contract</span>.
              V2 real money (+$6.65 / 361 fills, graded off settlement) always agreed with ~zero, not the paper +1.5¢.
              Un-shelving is a code change (<code>SHELVED</code> in <code>api/lib/maker-live.js</code>) — see <code>docs/REENTRY.md</code>.
            </div>
          )}
          <MakerLivePositions positions={boardData?.positions} />

          {!(shadowReportLoading && !shadowReportData) && <MakerProgress mb={shadowReportData?.makerBoard} />}

          <div style={sectionHead}>Utilization by sport</div>
          <MakerUtilization eligibleBySport={boardData?.eligibleBySport} orders={boardData?.orders} caps={boardData?.caps}
            armed={boardData?.armed} />
        </>
      )}
    </div>
  );
}
