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
  // ── FIVE TAKER-TUNING CHECKPOINTS REMOVED 2026-07-28 ────────────────────────────────────────
  // (1) "tune:kblend recheck" 7/27 — walk K capWeight below 0.4; (2) "kblend hits recheck" 8/10;
  // (3) "kblend wnba recheck" 8/10; (4) "f5ml window check" 8/08 — tune:window on the [40,55]
  // candidate; (5) "hrr NO re-gate check" 7/25 — tune:gate on post-7/17 NO-side captures.
  //
  // All five were taker-model work, and the taker family is closed: 0 of 57 categories reach Brier
  // skill CI-lo > 0 at n≥100, the gate has been empty since 7/18 (docs/REENTRY.md). Each is also a
  // shape the doc names as DISQUALIFYING rather than merely unproductive — the three kblend re-runs
  // and the hrr re-gate are corrections discovered by searching the same days (§"a per-category or
  // per-sport breakout … slicing is 0-for-6"), and the f5ml entry is literally "a different price
  // band", the first-listed non-justification. Their banner tiers (2, 2.2, 3.15) are suppressed by
  // STRATEGY_CLOSED in MakerBoardPage.jsx, so leaving the entries here would have nagged daily for
  // work the ladder above them refuses to surface.
  //
  // Deleted rather than re-dated on purpose: a later date implies the work becomes valid with more
  // rows, and "more data will fix it" is itself on the doc's non-justification list. Re-entry needs
  // NEW DATA (a new market class) or a mechanism stated in advance — not a re-run of these.
  // [[project_k_blend_counterfactual]] [[project_f5ml_window_candidate]] [[project_bet_window_derivation]]
  // MLS (KXMLSGAME) shipped 2026-07-23 as the first model-free maker market — live-verified via
  // /api/tonight?debug=1 (45 rows, real gameTime, correct team parsing) but the day it shipped had
  // no MLS games, so the actual shadow_plays DB write was never confirmed end-to-end. Next MLS
  // slate is 7/25. [[project_maker_modelfree_clubsoccer_2026_07_23]]
  { date: "2026-07-25", tone: "blue", label: "Confirm MLS rows land in shadow_plays", short: "MLS DB-write check",
    why: "Shipped 7/23, live-verified at the KV-staging level (clubSoccerPlays: 45, real gameTime) but no MLS game fell on ship day so the DB write was never confirmed — check shadow_plays WHERE sport='mls' (via /api/auth/shadow-stats) after the 7/25 slate resolves" },
  // Brasileirão (KXBRASILEIROGAME) shipped 2026-07-23 as the second model-free maker market —
  // live-verified via /api/tonight?debug=1 (36/36 rows, real gameTime, correct parsing including
  // Remo's 2-char abbr) same day, unlike MLS this had live games to check against. Same DB-write
  // gap as MLS though: no shadow-snapshot cron pass has run since ship. [[project_brasileirao_build_2026_07_23]]
  { date: "2026-07-25", tone: "blue", label: "Confirm Brasileirão rows land in shadow_plays", short: "Brasileirão DB-write check",
    why: "Shipped 7/23, live-verified at the KV-staging level (36/36 rows, real gameTime/kalshiTicker, correct home/away/tie parsing) but no shadow-snapshot cron pass has run yet — check shadow_plays WHERE sport='brasileirao' (via /api/auth/shadow-stats) after the next 1-2 days of games resolve" },
  // NWSL (KXNWSLGAME) shipped 2026-07-23 as the 3rd model-free maker market — live-verified via
  // /api/tonight?debug=1 (21/21 rows, real gameTime, correct parsing including KC's 2-char abbr)
  // same day. Same DB-write gap as MLS/Brasileirão. [[project_nwsl_build_2026_07_23]]
  { date: "2026-07-25", tone: "blue", label: "Confirm NWSL rows land in shadow_plays", short: "NWSL DB-write check",
    why: "Shipped 7/23, live-verified at the KV-staging level (21/21 rows, real gameTime/kalshiTicker, correct home/away/tie parsing) but no shadow-snapshot cron pass has run yet — check shadow_plays WHERE sport='nwsl' (via /api/auth/shadow-stats) after the next 1-2 days of games resolve. Also: Angel City FC/Racing Louisville aren't in the registry yet (no live Kalshi ticker seen as of ship date) — add their Kalshi abbr once one appears" },
  // Chinese Super League (KXCHNSLGAME) shipped 2026-07-23 as the 4th model-free maker market,
  // built on the new shared soccer-modelfree.js engine — live-verified via /api/tonight?debug=1
  // (24/25 rows, one dropped by the [1,99] quote-sanity filter as expected; the tricky
  // Shenzhen/Shanghai team-abbr collision confirmed resolving correctly). Same DB-write gap as
  // every prior league. [[project_chnsl_build_and_soccer_refactor_2026_07_23]]
  { date: "2026-07-25", tone: "blue", label: "Confirm Chinese Super League rows land in shadow_plays", short: "CHNSL DB-write check",
    why: "Shipped 7/23, live-verified at the KV-staging level (24/25 rows, real gameTime/kalshiTicker, correct home/away/tie parsing including the Shenzhen/Shanghai Shenhua collision-safe mapping) but no shadow-snapshot cron pass has run yet — check shadow_plays WHERE sport='chnsl' (via /api/auth/shadow-stats) after the next 1-2 days of games resolve" },
  // Liga MX (KXLIGAMXGAME) shipped 2026-07-23 as the 5th model-free maker market, built
  // directly on the shared soccer-modelfree.js engine — live-verified via /api/tonight?debug=1
  // (21/21 rows; the Atlas/Atlante collision confirmed resolving correctly). Same DB-write gap
  // as every prior league. [[project_ligamx_build_2026_07_23]]
  { date: "2026-07-25", tone: "blue", label: "Confirm Liga MX rows land in shadow_plays", short: "Liga MX DB-write check",
    why: "Shipped 7/23, live-verified at the KV-staging level (21/21 rows, real gameTime/kalshiTicker, correct home/away/tie parsing including the Atlas/Atlante collision-safe mapping) but no shadow-snapshot cron pass has run yet — check shadow_plays WHERE sport='ligamx' (via /api/auth/shadow-stats) after the next 1-2 days of games resolve. Also: Cruz Azul/Pumas UNAM/Toluca/Mazatlán aren't in the registry yet (no live Kalshi ticker seen as of ship date) — add their Kalshi abbr once one appears" },
  // Kalshi-settlement-based grading built as a DRY-RUN comparison pass 2026-07-23 (new
  // kalshi_ticker/kalshi_side columns, api/lib/kalshi-settlement.js) — logs agreement against the
  // existing ESPN resolvers but writes nothing. kalshi_ticker only populates on rows written after
  // deploy, so there's an inherent one-day lag before any row qualifies; needs about a week of
  // cron passes to accumulate a real cross-sport sample. [[project_kalshi_settlement_grading_2026_07_23]]
  // (7/30 dry-run agreement check REMOVED 2026-07-25 — done 5 days early: the gate cleared at
  // 99.92% (agree 2558 / disagree 2, n=2560, 7 families) and Phase A shipped, making settlement
  // AUTHORITATIVE for the 14 shadow-only sports. Both disagreements were one market Kalshi itself
  // settled wrong. [[project_kalshi_missettlement_watch_2026_07_25]])
  //
  // Phase A (2026-07-25) left all 15 per-sport ESPN resolver blocks in place because kalshi_ticker
  // only exists on rows written after 2026-07-23 — tickerless rows can't be settlement-graded. The
  // 14-day abandonment rule means no tickerless row can still be in the resolver's scan after
  // 2026-08-07, which is what makes the ESPN blocks safely deletable on this date and not before.
  { date: "2026-08-08", tone: "blue", label: "Phase B: delete the 15 per-sport ESPN resolver blocks (~800 lines)", short: "Phase B ESPN block deletion",
    why: "Gate: /api/shadow-resolver's kalshiGrading.disagreed still ~0 across the 14 authoritative sports (and /api/kalshi-dryrun-check's non-circular agree% still >99%). Then delete the 15 blocks + _grade3Way/_gradeThreshold + _gradeTennisRows + ?regradetennis + ~15 imports from handlers/shadow.js (4298 → ~3500). KEEP every fetchXResults export — tonight/* still needs those modules for gameTime hydration. Also unlocks the ESPN-uncovered league class (KBO/NPB/CFL), which has no resolver path at all today" },
  // 3 of the original 4 loose-end checkpoints from 7/23 are DONE (soccer-advance gameTime fix
  // shipped; full KXNFLTSPEC ladder pulled + categorized into ~14 stat families; discovery-blind-
  // spot investigated — see project_scheduled_checkpoints_2026_07_23_backlog memory). The 4th
  // (build decision) stays open below, with the corrected, much-larger scope the investigation found.
  //
  // CORRECTED 2026-07-23 (same day, later pass): the "14 leagues invisible to kalshi_series_seen"
  // theory was wrong — they were correctly captured 2026-06-13 as status='baseline', which the
  // scan treats as pre-vetted and never surfaces. ?statuscounts=1 found 2141 baseline rows total,
  // none ever vetted under the two-track doctrine (which didn't exist until today). The 14 leagues
  // are a promotable SAMPLE of that backlog, not the whole story — the real prioritization question
  // is much bigger than picking among 24+14 known candidates. See project_maker_viability_doctrine_2026_07_23.
  { date: "2026-07-23", tone: "gray", label: "Decide which maker-candidate league to build first (24 reclassified + 14 confirmed + ~2100 unvetted baseline backlog)", short: "maker-candidate build decision",
    why: "7/23 reclassified 24 tickers (Scottish Cup, MLS/Liga MX/UEL/UECL derivatives, KXTBTGAME) as maker-viable, and confirmed 14 more real leagues via /api/kalshi-check?meta=1 — but those 14 are a sample of a much larger ~2141-row 'baseline'-status backlog never vetted under any doctrine (?statuscounts=1). Needs a prioritization pass among the 38 known-good candidates first (liquidity depth, resolution simplicity), separate from the larger backlog sweep, before picking the next build" },
];
