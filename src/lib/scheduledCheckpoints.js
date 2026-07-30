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
  // Pre-registered forward test of the one positive maker cell (mlb f5total 50-54¢), registered
  // 2026-07-29. In-sample it read +16¢/ct (sideWon 0.38, CI [+2.24,+29.76], 6/8 days) but it is
  // the best-of-280 cell, so the number can't be acted on — only a forward test on new days can.
  // Criteria + green-light action are FIXED in docs/MAKER_F5TOTAL_PREREG.md; do not adjust them.
  { date: "2026-08-13", tone: "blue", label: "Evaluate f5total 50-54 pre-registration (forward test)", short: "f5total 50-54 prereg",
    why: "docs/MAKER_F5TOTAL_PREREG.md. Run /api/shadow-report?makerCell=mlb|f5total|50-54&since=2026-07-30 and check ALL green criteria (day-clustered CI-lo>0, mean ≥+5¢, ≥60% positive days, sideWon<0.45, ≥8 days & ≥50 fills, no anomaly). ALL pass → un-shelve V2 scoped to this cell, small ⅛-Kelly real-money trial. Any of 1-4/6 fail → KILL, no re-slice. Only sample-thin → extend once to 2026-08-27" },
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
  // Re-checked 2026-07-29 on its date: still an EMPTY_SHELL — /api/kalshi-check reports
  // liveMarketCount 0, volumeTotal 0. Nothing listed to vet, so re-dated two weeks rather than
  // removed: the model end stays green (statsapi covers all 4 levels, ~62 games/day), so this is
  // waiting on Kalshi to list, which is exactly the wait the LMB recheck converted on.
  { date: "2026-08-12", tone: "gray", label: "Re-check KXMILBGAME listings", short: "KXMILBGAME recheck",
    why: "Dismissed 7/15 as a zero-market shell with the model side green (statsapi covers all 4 levels, ~62 games/day) — if markets now list with real game-day books (asks populated, spread ≤15¢), un-dismiss and build the LMB-playbook λ model (parameterize lmb.js + author the registry from the live tickers)" },
  // ── FIVE TAKER-TUNING CHECKPOINTS REMOVED 2026-07-28 ────────────────────────────────────────
  // (1) "tune:kblend recheck" 7/27 — walk K capWeight below 0.4; (2) "kblend hits recheck" 8/10;
  // (3) "kblend wnba recheck" 8/10; (4) "f5ml window check" 8/08 — tune:window on the [40,55]
  // candidate; (5) "hrr NO re-gate check" 7/25 — tune:gate on post-7/17 NO-side captures.
  //
  // All five were taker-model work, and no taker pattern has been validated: 0 of 57 categories
  // reach Brier skill CI-lo > 0 at n≥100, and the gate has been empty since 7/18 (docs/REENTRY.md).
  // Each is also a shape the doc names as DISQUALIFYING rather than merely unproductive — the three
  // kblend re-runs and the hrr re-gate are corrections discovered by searching the same days
  // (§"a per-category or per-sport breakout … slicing is 0-for-6"), and the f5ml entry is literally
  // "a different price band", the first-listed non-justification. Their banner tiers (2, 2.2, 3.15)
  // are suppressed by AWAITING_VALIDATED_EDGE (api/lib/config.js), so leaving the entries here would
  // have prompted daily for work the ladder above them refuses to surface.
  //
  // Deleted rather than re-dated on purpose: a later date implies the work becomes valid with more
  // rows of the SAME kind, and "more data will fix it" is itself on the doc's non-justification
  // list. What would count is a signal in NEW data (a new market class) or a mechanism stated in
  // advance and then tested — not a re-run of these.
  // [[project_k_blend_counterfactual]] [[project_f5ml_window_candidate]] [[project_bet_window_derivation]]
  // ── FIVE LEAGUE DB-WRITE CHECKPOINTS RESOLVED + REMOVED 2026-07-29 ─────────────────────────
  // MLS / Brasileirao / NWSL / CHNSL / Liga MX, all dated 7/25, all asking the same question:
  // did the shipped league's rows actually reach shadow_plays? Answered in one pass off
  // /api/kalshi-dryrun-check's `circular.bySport`, which counts rows the settlement grader
  // wrote: mls 449, argprem 322, scocup 284, ligamx 204, brasileirao 30 (+6 ESPN-compared),
  // nwsl 21. CHNSL was absent there but confirmed a different way — `chnsl|game` appears in
  // /api/shadow-report?makerDay= attribution on 7/25 and 7/26, the only two days CSL played
  // after ship, so its rows exist and carry a real game_date.
  //
  // Worth keeping as method: shadow-calibration reports n=0 for every one of these leagues,
  // which looks like 'no rows' and is not — it filters `model_true_pct IS NOT NULL`, and
  // model-free rows have no truePct by construction. Don't use it to answer 'did rows land'.
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
