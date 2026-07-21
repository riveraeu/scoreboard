import React from 'react';
import { SERIES_CONFIG } from '../../api/lib/series-config.js';
import { CATEGORY_BET_WINDOWS } from '../../api/lib/config.js';
// Dated diagnose/window HOLD maps — shared with the shadow-report daily brief so the brief and
// the Do-this banner agree on what's already been diagnosed and parked.
import { INPUT_SEARCH_EXHAUSTED, WINDOW_SEARCH_EXHAUSTED, stillExhausted as _stillExhausted } from '../../api/lib/model-holds.js';
import { SCHEDULED_CHECKPOINTS } from '../lib/scheduledCheckpoints.js';

// A build-roadmap entry counts as SHIPPED once any of its Kalshi tickers exists in
// SERIES_CONFIG — which we ALWAYS edit when a market ships. Deriving "shipped" from that
// single source of truth (instead of a hand-maintained flag) is what keeps the "Do this
// today" banner from advertising a market we already built: it self-advances the moment a
// new series lands in the config. (Phase-2/placeholder tickers absent from the config —
// e.g. KXEPLTOTAL, KXUFCROUNDS — correctly read as not-yet-shipped.)
const _isShippedRoadmapEntry = (s) => !!s?.markets?.some(m => SERIES_CONFIG[m.ticker]);

// --- Report page (daily model briefing) -----------------------------------------
// Leads with DO THIS (a single top-priority action across the whole page, picked by a
// fall-through ladder: data health → model changes → validate ripe shadow models → build next
// market → vet shortlisted → triage detected markets → Polymarket),
// then the priority-ordered sections: DATA HEALTH (qualifier banner) · OPS (a four-line
// daily playbook + collapsed supporting tables) · MODEL BOARD (the price-band validation
// ladder — the single gate-decision surface, led by a one-line GATE digest).
//
// The MODEL BOARD slices BETTABLE plays by market price (where ROI actually lives —
// ROI = hitRate − price) and runs a promotion ladder: PROMOTE only when n≥50 AND the
// ROI 95%-CI lower bound clears 0 AND the window is coherent (both price-halves
// non-negative). Everything else is STRENGTHENING (positive, not yet validated),
// BUILDING (accruing), or NEGATIVE (stay out). truePct calibration is a SEPARATE
// model-honesty check, not a competing profitability axis (calibration ≠ profit).

const C = { green:"#3fb950", amber:"#e3b341", red:"#f78166", blue:"#58a6ff", gray:"#8b949e", dim:"#484f58", text:"#c9d1d9", bg:"#0d1117", card:"#161b22", border:"#21262d" };

const _roiFromPct  = p => p == null ? "—" : `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
const _roiColorPct  = p => p == null ? C.gray : p >= 2 ? C.green : p <= -2 ? C.red : C.amber;

const sectionHead = { color:C.blue, fontSize:11, fontWeight:700, margin:"14px 0 8px", borderTop:`1px solid ${C.border}`, paddingTop:12, textTransform:"uppercase", letterSpacing:0.4 };


// ---- Status strip (always visible) + Data health warnings (only when degraded) ----
function StatusStrip({ dh, reportData, fetchShadowReport }) {
  const res = dh?.resolution || {};
  const clv = dh?.clvCapture || {};
  const warn = dh?.warnings?.length > 0;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10, fontSize:11, color:C.dim, borderBottom:`1px solid ${C.border}`, paddingBottom:8 }}>
      <span style={{ color: warn ? C.amber : C.green, fontWeight:700, fontSize:10 }}>{warn ? "⚠" : "✓"}</span>
      <span>{res.resolved ?? 0}/{res.total ?? 0} resolved · CLV {clv.pct ?? 0}%{dh?.coverageWarning ? " · under-logged" : ""}</span>
      {reportData?.generatedAt && (
        <span>· {new Date(reportData.generatedAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"})} PT</span>
      )}
      <button onClick={() => fetchShadowReport(true)} style={{ marginLeft:"auto", background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.dim, fontSize:10, padding:"2px 7px", cursor:"pointer" }}>↻ Refresh</button>
    </div>
  );
}
function DataHealth({ dh }) {
  if (!dh?.warnings?.length) return null;
  return (
    <div style={{ background:"rgba(247,129,102,0.08)", border:`1px solid #f7816644`, borderRadius:6, padding:"6px 10px", marginBottom:10 }}>
      <div style={{ color:C.red, fontSize:11, fontWeight:700, marginBottom:3 }}>⚠ Data health — interpret with caution</div>
      {dh.warnings.map((w, i) => <div key={i} style={{ color:C.text, fontSize:11 }}>• {w}</div>)}
    </div>
  );
}


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
// (2) betting changes pending on the board (gate promote/demote/investigate); (2.2) accuracy changes
// (Recalibrate / Improve inputs / Diagnose, with ripeness + exhaustion suppression); (2.5) validate
// ripe shadow models — ungated + eligible + n≥50 + STRENGTHENING, the build→gate half of the funnel
// (run tune:gate + Brier); (3) build a NEXT-flagged roadmap market (an explicit "this first"
// override); (3.15) derive a per-category bet window (harvest of already-accrued data — ranks above
// authoring new markets); (3.2) build the next merely-unshipped roadmap market; (3.25) vet
// shortlisted markets (promoted detections, mid-funnel); (3.5) triage detected new markets (the
// funnel's first step); (3.6) sportsbook regime-change tripwire (kill-gate CLOSED 2026-07-04 —
// GAP now means "investigate", not "build 1b"); (4) SCHEDULED_CHECKPOINTS — dated follow-ups
// (x* re-open, …) that surface on their date and persist until handled; (5) quiet-day floor
// naming the next upcoming checkpoint.
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
// V2 (real resting orders, api/lib/maker-live.js) trial size — smaller than the V1 arm
// criterion's n≥200 (that established statistical edge; this just validates mechanics —
// place/reprice/fill/settle/grade — with real but small capital before a scale decision).
const MAKER_V2_TRIAL_N = 50;
// n≥200 is necessary but NOT sufficient: a category can clear it yet still have a MOVING Brier-skill
// trend (reliable |learning.skillTrend| > _LEARN_FLAT) — rising as data accrues (still learning) OR
// falling (decaying toward a market tie, the wnba|points signature). EITHER direction means the
// calibration gap (and the β* de-shrink step) isn't settled, so locking an L2 reweight now chases a
// moving target. An un-flat-trend Recalibrate is therefore ALSO held off the banner (the board row +
// its ↗/↘ Learning arrow keep showing it); it resurfaces only once the trend flattens (converged).
// (2026-06-28: mlb|totalBases n=251 but skillTrend +0.163 — STILL LEARNING; tune:learncurve says keep
// accruing, not lock the step. mlb|hits is the same shape. See [[project-totalbases-recalibrate-hold]].)
// ---- SCHEDULED CHECKPOINTS: dated follow-ups the ladder must not forget --------------
// Moved to src/lib/scheduledCheckpoints.js (2026-07-21) when MakerProgress moved out to its own
// page (MakerBoardPage.jsx) — both files need the same list for their "next clock" tiles/tiers,
// so it's a shared module now instead of a local const. Same semantics as before: a comment TODO
// never fires, so every "come back in ~2 weeks" wait lives in that one list.
// INPUT_SEARCH_EXHAUSTED + _stillExhausted moved to api/lib/model-holds.js (2026-07-01, imported
// above) — shared with the shadow-report daily brief so both surfaces agree on parked diagnostics.

// Per-category bet-window derivation nudge (tier 3.15). WINDOW_RECOMMEND_N = enough settled bets to
// trust a tune:window read (mirrors the CLI's --min-n default + MODEL_IMPROVEMENT.md's window-grade
// floor). WINDOW_SEARCH_EXHAUSTED = categories already run to a TERMINAL no-go (the discovered window
// doesn't hold out-of-sample), so the banner stops nagging — mirrors INPUT_SEARCH_EXHAUSTED, including
// the auto-UN-suppress: a FORMULA_CUTOFF newer than the exhaustion date re-accrues the category clean
// and re-opens the search (via _stillExhausted). A NON-terminal no-go (OOS split merely too thin) does
// NOT belong here — give it a dated SCHEDULED_CHECKPOINTS entry to re-run once OOS n accrues instead
// of either nagging daily or being forgotten.
const WINDOW_RECOMMEND_N = 200;
// WINDOW_SEARCH_EXHAUSTED also lives in api/lib/model-holds.js now (imported above).
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
  // maker strategy. Fires once graded fills are readable (n≥30) and either fills' sold sides
  // win ≥8pp more often than quoted markets overall (the margin is selection, not edge) or
  // fill PnL is decisively negative (CI-hi < 0 via avg + CI-lo symmetry).
  const mb = d?.makerBoard;
  if ((mb?.fills?.graded || 0) >= 30) {
    const _adv = mb.fills.sideWonRate != null && mb.quotedOutcomes?.sideWonRate != null
      ? (mb.fills.sideWonRate - mb.quotedOutcomes.sideWonRate) * 100 : null;
    const _pnlHiCI = mb.fills.avgPnlCents != null && mb.fills.pnlLoCI != null
      ? mb.fills.avgPnlCents + (mb.fills.avgPnlCents - mb.fills.pnlLoCI) : null;
    if ((_adv != null && _adv >= 8) || (_pnlHiCI != null && _pnlHiCI < 0)) {
      out.push({ tier:1.6, tone:"red", label:"Maker fills are adversely selected — margin is selection, not edge",
        why:`filled quotes' sold side wins ${_adv != null ? `${_adv.toFixed(1)}pp more often` : "far more often"} than quoted markets overall (n=${mb.fills.graded} graded)${_pnlHiCI != null && _pnlHiCI < 0 ? `; fill PnL CI entirely negative (${mb.fills.pnlLoCI}..${_pnlHiCI.toFixed(1)}¢)` : ""} — diagnose which categories/bands drive it before more accrual`,
        short:"Maker adverse selection" });
    }
  }
  // 2.05 — shadow maker V2 status. The V1 aggregate crossing its criterion was a ONE-TIME signal
  // that already fired and was acted on (ARM review 2026-07-21: decision made to scope V2 to the
  // 80-84¢ band, not the full [55,97] — see docs/INFRA.md § Shadow maker engine). Re-showing
  // "review V2" every day off the same stale V1 aggregate would nag a decision that's already
  // made, so once makerBoard.live exists (V2 built, api/lib/maker-live.js) this tier tracks V2's
  // OWN lifecycle instead: verify-then-arm → trial running → trial resolved (scale or investigate).
  const live = mb?.live;
  if (live) {
    if (!live.armed && (live.orders || 0) === 0) {
      out.push({ tier:2.05, tone:"blue", label:"Shadow maker V2 built, not armed — verify cancel endpoint, then arm for a small trial",
        why:"V2 (real resting orders, scoped to the 80-84¢ band) shipped 2026-07-21 but has never been armed — MAKER_V2_ARMED is unset. The cancel-endpoint wire format is unverified against a live call (documented in kalshi-order-client.js); place one harmless test order + cancel before arming with real size.",
        short:"V2: verify + arm" });
    } else if (live.armed && (live.graded || 0) < MAKER_V2_TRIAL_N) {
      out.push({ tier:2.05, tone:"blue", label:`Shadow maker V2 trial running — ${live.graded || 0}/${MAKER_V2_TRIAL_N} graded fills`,
        why:`Live resting orders are armed and accruing (${live.resting || 0} resting, ${live.executed || 0} executed). Let the trial run to ${MAKER_V2_TRIAL_N} graded fills before deciding on sizing.`,
        short:"V2 trial running" });
    } else if (live.armed && (live.graded || 0) >= MAKER_V2_TRIAL_N) {
      const ok = (live.pnlLoCI ?? -1) > 0;
      out.push({ tier:2.05, tone: ok ? "green" : "red",
        label: ok
          ? `Shadow maker V2 trial cleared — ${live.graded} graded, CI-lo +${live.pnlLoCI}¢ — decide on scaling size`
          : `Shadow maker V2 trial underperforming — ${live.graded} graded, CI-lo ${live.pnlLoCI}¢ — investigate or kill`,
        why:`Live avg ${live.avgPnlCents > 0 ? "+" : ""}${live.avgPnlCents}¢/contract, CI-lo ${live.pnlLoCI > 0 ? "+" : ""}${live.pnlLoCI}¢ at n=${live.graded}. Compare against V1 shadow expectations before touching MAKER_V2_SIZE.`,
        short: ok ? "V2 trial: scale?" : "V2 trial: investigate" });
    }
  } else if ((mb?.fills?.graded || 0) >= (mb?.armCriterion?.minFills ?? 200) && (mb?.fills?.pnlLoCI ?? -1) > 0) {
    // Fallback only for a report generated before makerBoard.live existed.
    out.push({ tier:2.05, tone:"green", label:"ARM DECISION — shadow maker cleared its criterion, review V2",
      why:`${mb.fills.graded} graded fills at ${mb.fills.avgPnlCents > 0 ? "+" : ""}${mb.fills.avgPnlCents}¢/contract (CI-lo ${mb.fills.pnlLoCI > 0 ? "+" : ""}${mb.fills.pnlLoCI}¢) — margin survives adverse selection. Decide V2 scope from the band ladder.`,
      short:"Review maker V2 arm" });
  }
  // 2 — betting changes pending on the betting board (promote / demote / investigate).
  // "Look deeper" is the Phase-2 residual-slicer nag (eligible-but-window-loses). It's only
  // actionable once a coherent price window has been DISCOVERED to slice against — with
  // discoveredWindow=null the category is still accruing (the wider [55,97] capture data
  // hasn't filled the band yet), so an immediate slice has nothing to bite on and the to-do
  // is unfixable today. Hold it out of the daily banner until a window exists (the board row +
  // its "Look deeper" verdict still show). Promote/Pull are live gate changes — never window-gated.
  const changes = (d?.bettingBoard || []).filter(e =>
    _BET_ACTIONS[e?.doThis?.action] &&
    !(e.doThis.action === "Look deeper" && e.discoveredWindow == null));
  if (changes.length) {
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
  if (accChanges.length) {
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
  if (ripe.length) {
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
  if (winnable.length) {
    const names = winnable.map(e => e.key);
    out.push({ tier:3.15, tone:"green",
      label: `Derive bet window: ${names.slice(0,3).join(", ")}${names.length>3?` +${names.length-3}`:""}`,
      why: `n≥${WINDOW_RECOMMEND_N}, model beats the price, and +ROI sits OUTSIDE [67,91] — run \`npm run tune:window -- --category ${names[0]}\` to derive + OOS/Brier-validate a window, then set CATEGORY_BET_WINDOWS.`,
      short: `Derive window ${winnable.length}` });
  }
  // 3.25 — vet shortlisted markets (promoted detections, mid-funnel). Below build-next (a vetted
  // roadmap market is further along), above triage (raw detections). Confirm data on both ends +
  // the first knob, then author the roadmap entry. Drop any ticker already live in SERIES_CONFIG
  // (shipped) — same filter the ModelNext "Shortlisted" card uses (line ~350) — so the banner
  // self-advances the instant a market ships, without waiting for the scan's adopt reconcile + the
  // next report regen to flip its DB status.
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
  // (4.6 sportsbook observatory floor REMOVED 2026-07-04 — the kill-gate is CLOSED, so TIGHT/
  // ACCRUING are no longer a pending wait worth a daily banner slot; the CrossVenueValidation
  // readout under the betting board still shows the live status, and tier 3.6 fires on GAP.)
  // 5 — quiet-day floor: nothing above is actionable and no checkpoint is due yet. Show a calm
  // "caught up" state naming the NEXT upcoming checkpoint instead of an empty/absent banner.
  if (!out.length) {
    const upcoming = [...SCHEDULED_CHECKPOINTS].filter(c => c.date > todayPT).sort((a, b) => a.date.localeCompare(b.date))[0];
    const _mbFills = d?.makerBoard?.fills;
    out.push({ tier:5, tone:"gray", label:"Nothing to act on today",
      why:`Maker shadow accruing (${_mbFills?.graded ?? 0}/${d?.makerBoard?.armCriterion?.minFills ?? 200} graded fills), gate empty, no new markets to triage.${upcoming ? ` Next scheduled checkpoint: ${upcoming.short || upcoming.label} ~${upcoming.date}.` : ""}`, short:"All clear" });
  }
  // Push order ≠ priority order anymore (tier 3.2 is pushed before 3.15) — sort by tier; ties keep
  // insertion order (stable sort), so multiple due checkpoints stay oldest-first.
  return out.sort((a, b) => a.tier - b.tier);
}
function DoThisBanner({ d }) {
  const [copied, setCopied] = React.useState(false);
  if (!d || d.notYet || d.error) return null;
  const cands = _doThisCandidates(d);
  if (!cands.length) return null;
  const [primary, ...rest] = cands;
  const color = _TONE[primary.tone] || C.blue;
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
      <div style={{ color, fontSize:15, fontWeight:700 }}>▶ {primary.label}</div>
      {primary.why && <div style={{ color:C.text, fontSize:12, marginTop:3, lineHeight:1.4 }}>{primary.why}</div>}
    </div>
  );
}

// ---- MAKER PROGRESS ----------------------------------------------------------------
// Moved to src/components/MakerBoardPage.jsx (2026-07-21) along with its helpers (Tile,
// ArmTile, EquityCurve, BandLadder) when maker was promoted to the app's new primary landing
// page. This report page keeps the broader daily-brief content (StatusStrip/DataHealth/
// DoThisBanner) — see project_taker_ui_demotion_2026_07_21 memory for the reasoning.

function MorningBriefing({ shadowReportData, shadowReportLoading, fetchShadowReport, isLoggedIn }) {
  if (!isLoggedIn) return null;
  const d = shadowReportData;
  const noReport = !d || d.notYet || d.error;

  if (shadowReportLoading) return <div style={{ color:C.dim, fontSize:12, padding:12 }}>Generating report…</div>;
  if (noReport) {
    return (
      <div style={{ padding:12, display:"flex", gap:10, alignItems:"center" }}>
        <span style={{ color:C.dim, fontSize:12 }}>
          {d?.error ? `Error: ${d.error}` : "Report not yet generated — cron runs at 6am PT. Click Refresh to generate now."}
        </span>
        <button onClick={() => fetchShadowReport(true)} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:4, color:C.gray, fontSize:11, padding:"2px 8px", cursor:"pointer" }}>Refresh</button>
      </div>
    );
  }

  return (
    <div>
      <StatusStrip dh={d.dataHealth} reportData={shadowReportData} fetchShadowReport={fetchShadowReport} />
      <DataHealth dh={d.dataHealth} />
      <DoThisBanner d={d} />
    </div>
  );
}

// --- ReportPage --------------------------------------------------------------------
function ReportPage({ onBack, shadowReportData, shadowReportLoading, fetchShadowReport, isLoggedIn }) {
  React.useEffect(() => {
    if (isLoggedIn && !shadowReportData && !shadowReportLoading) fetchShadowReport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  return (
    <div style={{ maxWidth:1280, margin:"0 auto", padding:"16px 16px" }}>
      <div style={{ display:"flex", alignItems:"center", marginBottom:14, gap:12 }}>
        <button onClick={onBack} style={{ background:"transparent", border:`1px solid #30363d`, borderRadius:6, color:C.gray, fontSize:12, padding:"4px 10px", cursor:"pointer" }}>← Back</button>
        <div style={{ color:C.text, fontSize:17, fontWeight:700 }}>Model Report</div>
        {shadowReportData?.reportDate && <span style={{ color:C.dim, fontSize:11 }}>{shadowReportData.reportDate}</span>}
        {shadowReportData?.generatedAt && <span style={{ color:C.dim, fontSize:10 }}>· generated {new Date(shadowReportData.generatedAt).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/Los_Angeles"})} PT</span>}
      </div>

      {isLoggedIn ? (
        <MorningBriefing shadowReportData={shadowReportData} shadowReportLoading={shadowReportLoading} fetchShadowReport={fetchShadowReport} isLoggedIn={isLoggedIn} />
      ) : (
        <div style={{ color:C.gray, textAlign:"center", padding:40, fontSize:13 }}>Log in to view the model report.</div>
      )}
    </div>
  );
}

export default ReportPage;
