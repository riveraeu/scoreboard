// Shared tunables for the tonight capture pipeline. Single source of truth — imported by the
// server emit modules (api/lib/tonight/*.js).
//
// POST-TEARDOWN (2026-08-04). The taker "bet window" constants (KALSHI_GATE / KALSHI_CAP /
// EDGE_GATE_SERVER / betWindowFor / CATEGORY_BET_WINDOWS) were deleted with the MODEL teardown:
// they set the `qualified` marker that drove the per-player-stat dedup + game/total cross-winner
// pick, and the model teardown replaced all of that with model-free capture-all (every quoted
// side is its own row). They gate nothing now. What remains here: the two CAPTURE gates (band +
// liquidity — quote-sanity, still applied at parse), the MAKER_* engine params, and the
// AWAITING_VALIDATED_EDGE posture flag.

// ── No validated edge yet (2026-07-28, reframed 2026-07-29) ─────────────────────────────────
// Posture, not an epitaph: **nothing has cleared its validation bar yet, so we accumulate rather
// than act.** Every strategy family measured so far — taker, maker, cross-venue, lead-lag, path —
// came back without a pattern that held up, and the instruments are still running to find one.
// `docs/REENTRY.md` records what each measurement actually showed and what would count as a real
// signal; read it before starting work premised on a new edge.
//
// What this flag suppresses is the IMPERATIVE mood: "run tune:window on X", "pull X from the
// gate", "Improve inputs". Those prescribe work on a pattern that has not been established, and
// acting on them has produced six false positives so far — every one from re-slicing days already
// in hand (a different price band, a per-category breakout, one more week of the same rows). What
// it never suppresses is a MEASUREMENT: boards, CIs, calibration, quoting, fill detection and the
// series scan all keep running and keep rendering, because the data they accumulate is the only
// thing that can turn into a reliable pattern.
//
// So the bar for acting is: a pattern that shows up in NEW data (a new market class — NFL in
// September is the nearest), or a mechanism stated in advance and then tested. Not a better slice
// of the same days.
//
// Lives here rather than in a component because it has TWO consumers and they disagreed: the
// DoThisBanner (src/components/MakerBoardPage.jsx) held it as a local const and went quiet, while
// /api/shadow-report's `brief` had no equivalent and kept emitting "Action needed today: run
// tune:window on mlb f3ml" — a category tune:window had ALREADY returned NO-GO on. The UI looked
// settled while every non-UI consumer (routines, reports, anything reading the JSON) was still
// being told to work an unvalidated lead.
//
// Renamed from STRATEGY_CLOSED 2026-07-29: nothing here is dead, and a name that says otherwise
// invites both the wrong conclusion and the wrong fix.
export const AWAITING_VALIDATED_EDGE = true;

// Capture (shadow-logging) band — quote-sanity only, the sole price gate at collection. Capture-
// all doctrine (2026-07-03): log every quoted side; any price filtering belongs at analysis time,
// never at collection. 1/99 exclude only structurally dead quotes (ask of 0 = no ask; 100 = no
// real offer). The liquidity gate below (CAPTURE_MAX_SPREAD) is the other capture gate — it
// rejects fake prices (dead one-sided books), not price levels.
export const CAPTURE_GATE = 1;        // capture floor — a 0¢ ask is an absent quote, not a price
export const CAPTURE_CAP  = 99;       // capture cap — a 100¢ ask is an absent offer, not a price

// Capture liquidity gate (2026-06-30). A prop rung with no real two-sided book — only a lone
// wide quote on the opposite side — reports a bet-side ask that is an ARTIFACT, not a tradeable
// price. On Kalshi, a lone NO bid at ~6¢ mechanically implies yes_ask=94¢, so high-threshold
// totalBases longshots got logged as 94¢ "favorites" (116 live on 6/30), inflating the accuracy
// board's Brier skill to a fake +0.15 (clean = +0.004 parity). Real favorites have a tight
// bet-side spread (France live: ≤7¢); artifacts are ~94¢. Reject at capture when the bet-side
// bid-ask spread exceeds this.
export const CAPTURE_MAX_SPREAD = 15; // cents — max bet-side bid-ask spread to log a rung
export const capturableSpread = (spreadCents, cap = CAPTURE_MAX_SPREAD) =>
  spreadCents != null && spreadCents <= cap;

// Shadow maker engine (2026-07-19, api/lib/maker.js). The pooled market-calibration scan
// (n=44.5k) found the venue's vig sits on the FAVORITE ask (2-8¢ above realized frequency,
// monotone in price) while longshot asks are ~fair — which suggested QUOTING the favorite side
// (selling the rich ask as a maker) as the structural play. V1 simulates: quote 1¢ inside the
// prevailing favorite ask on maker-fee-free series, detect fills from the public trade tape,
// grade at settlement. **That premise did NOT survive to a fill (corrected 2026-07-29):**
// replayFills matched the wrong taker side for the engine's whole life, and the corrected 10-day
// rebuild is −1.02¢/contract, not +1.5¢. The pooled scan measures a TAKER's spread; capturing it
// as a maker loses to adverse selection. Kept quoting as a live instrument, not a live edge —
// see [[maker-wrongside-fill-bug-2026-07-29]] and docs/REENTRY.md.
export const MAKER_BAND = [55, 97];   // favorite-ask band to quote inside (≥98 = stale-ask regime).
// Floor dropped 80→55 on 2026-07-21: the 7/21 ARM review found the real (shadow-fill) edge lives
// only in 80-84 of the original [80,97] band — 85-97 is flat/negative. 55-79 is measurement-only
// exploration of the pooled-calibration gap between "longshot asks are ~fair" (≤35¢, already
// answered) and the studied 70-97 favorite zone; V2 scope stays [80,84] until this range proves
// itself. See docs/INFRA.md § Shadow maker engine.
export const MAKER_INSIDE_C = 1;      // quote this many cents inside the prevailing ask
export const MAKER_SIZE = 10;         // simulated contracts per quote segment
// Full-range measurement band for the V1 (paper) quote pass, added 2026-07-29. MAKER_BAND above
// is the FAVORITE band — its ≥55 floor means the paper engine only ever measured favorite-sells,
// so the fill-price map had no data below ~50 (a favorite ask is ≥50 by definition). Quoting BOTH
// sides across [1,97] completes the picture: the underdog side of every market (asks ~1-50) now
// gets a paper segment too. Measurement only — V2 real orders stay locked to MAKER_V2_BAND. The
// prior (n=44.5k pooled scan: longshot asks are ~fair) says expect ~0 edge down there, but the
// maker side was never measured and quoting is free. Used ONLY by updateMakerQuotes with
// bothSides=true; V2 and the backfill keep MAKER_BAND / MAKER_V2_BAND single-side (favorite).
export const MAKER_FULL_BAND = [1, 97];

// Shadow maker V2 (2026-07-21, api/lib/maker-live.js) — REAL resting orders, scoped tight to
// the one sub-band the 7/21 ARM review found a real, non-borderline edge in (n=295,
// CI-lo≈+6¢); 85-97 stays V1-shadow-only. Defaults are deliberately conservative for the debut
// — scale up only as a human decision once mechanics (place/reprice/fill/settle/grade) are
// confirmed against real fills. See docs/INFRA.md § Shadow maker engine.
export const MAKER_V2_BAND = [80, 84];       // real-order eligibility band (narrower than MAKER_BAND)
export const MAKER_V2_SIZE = 5;              // contracts per resting order
export const MAKER_V2_MAX_CONCURRENT = 20;   // total resting orders across all tickers
export const MAKER_V2_SAME_GAME_CAP = 2;     // max concurrent resting orders per game (correlation guard)
// Self-expiring safety net. Was 150 (2.5min), sized for the kalshi-snapshot cron's ORIGINAL */2min
// cadence ("outlives one cron cycle"). That cron widened to */10min on 2026-08-17 (Neon
// compute-cost fix, see docs/INFRA.md) but this was never re-tuned to match — an order sat
// resting for only 150s of every ~600s between requotes (~25% duty cycle), then went dark with
// nothing on the book until the next tick replaced it. Set to 540 (9min, just under the 10min
// cron interval) so an order stays resting continuously between quote passes instead of expiring
// and sitting unquoted for most of the cycle; still bounded below the cron interval as the
// safety net this was always meant to be, in case a cron tick is ever skipped/delayed.
export const MAKER_V2_EXPIRATION_SEC = 540;

// Sub-50 one-sided live trial (2026-08-24, docs/MAKER_V2_SUBFIFTY_TRIAL.md) — the eligibility set
// updateWantedMakerQuotes actually reads while this trial runs; MAKER_V2_BAND/MAKER_V2_SIZE above
// are the earlier, separately-shelved 80-84 favorite-band hypothesis and are not consulted by this
// trial. Two independent groups, each targeting a category the netting screen (docs/
// MAKER_LADDER_ARTIFACT.md) found NOT explained by the favorite-longshot mirror artifact — whole
// book positive on both halves for wnba|points, mildly positive pooled for mlb|f5total. Each group
// has its OWN dollar cap (capCents — max $ notional outstanding across resting + executed-
// ungraded orders in that group at any moment; frees up as positions grade) and its OWN stop-loss
// (stopLossCents — realized PnL floor; breach halts new placement AND cancels that group's
// resting orders, see haltedGroups() in maker-live.js). sizeContracts is fixed per group so one
// fill's cost is a small fraction of the group's cap, not inherited from the old 80-84 sizing.
// `resumeFrom` is each group's own ledger start: groupExposureCents/groupRealizedCents (maker-live.js)
// only sum rows with game_date >= their group's resumeFrom, so a group's cap/stop-loss reads against
// ITS OWN window, not the whole table's history.
export const MAKER_V2_TRIAL_START = "2026-08-24";      // original forward window opens — see docs/MAKER_V2_SUBFIFTY_TRIAL.md
export const MAKER_V2_TRIAL_CHECKPOINT = "2026-09-07"; // 2 weeks — see docs/MAKER_V2_SUBFIFTY_TRIAL.md
// wnba-points breached its -$15 stop-loss for real (-$60.75) under the pre-2026-08-24-fix exposure-
// cap bug — its ledger resets here on re-arm rather than staying permanently halted against bug-era
// losses. mlb-f5total never breached its stop-loss (+$28.00 realized) and keeps its original window.
export const MAKER_V2_WNBA_POINTS_RESUME = "2026-08-25"; // fresh ledger — see docs/MAKER_V2_SUBFIFTY_TRIAL.md
// 2026-08-26 expansion: two diagnostic cells, added not for expected profit but to test the trial
// INSTRUMENT itself (does live one-sided execution match what shadow data predicts?) — see
// "Expansion 2026-08-26" in docs/MAKER_V2_SUBFIFTY_TRIAL.md. Both start at half the standard
// $30/$15 cap/stop-loss (smaller size = smaller blast radius while the new-cell machinery is
// unproven at n>2 groups) and their own fresh `resumeFrom`.
// - `mlb-hrr-negctrl`: a NEGATIVE CONTROL. Today's netting screen found mlb|hrr|30-34's sub-50
//   half confidently LOSES in shadow (-1.30c/ct, island pattern, same shape as the already-killed
//   hrr-7074). Expected to lose live too — if it does, that's evidence the sim-vs-real fill
//   assumption holds; if it doesn't, that undermines every promote/kill decision the shadow
//   pipeline has made.
// - `wnba3p-killdiag`: an explicit, one-time EXCEPTION to the "killed cells are never re-added"
//   rule (see maker-prereg.test.js's absence tripwire for the shadow-prereg registry, which this
//   does NOT touch — wnba3p-6064 stays permanently absent from PREREG_CELLS). wnba3p-6064 inverted
//   forward in shadow (+29c/ct in-sample -> CI-lo -2.85 at its 8/24 checkpoint); re-quoting it live
//   at reduced size tests whether that inversion was a real mechanism failure or a shadow-fill
//   artifact. Tracked here, explicitly, as a deliberate diagnostic — never to be read as "reopening"
//   the shadow kill.
// - `wnbasp-onesided`: tests the question docs/MAKER_LADDER_ARTIFACT.md explicitly left open —
//   "whether the sub-50 premium survives one-sided quoting." wnba|spread is a near-perfect MIRROR
//   book (sub-50 wins big, 50+ loses big, whole book nets ~zero pooled — the wnbasp shadow prereg
//   cluster was killed on this basis). The sub-50 half alone, though, clears the robustness bar
//   cleanly on its own (band 20-24: +16.36c/ct, CI [10.19,22.53], 19 days) — this cell tests
//   whether that individually-clean reading survives actually being quoted, one-sided, for real,
//   rather than being a two-sided-pooling artifact that a real maker never has to net against.
export const MAKER_V2_HRR_NEGCTRL_START = "2026-08-26";
export const MAKER_V2_WNBA3P_KILLDIAG_START = "2026-08-26";
export const MAKER_V2_WNBASP_ONESIDED_START = "2026-08-26";
// Checkpoint for all three 2026-08-26 diagnostic cells (2 weeks, matching the original trial's
// cadence) — see docs/MAKER_V2_SUBFIFTY_TRIAL.md § Expansion for the pre-committed pass/fail
// thresholds evaluated at this date. Unlike a shadow prereg checkpoint, an inconclusive (too-thin-
// sample) read here may extend once rather than forcing a KILL — these cells gate no capital-
// allocation decision themselves (sizing doesn't change on their result), so extending to actually
// learn something doesn't carry the same re-slicing risk the no-extend prereg rule exists to stop.
export const MAKER_V2_DIAGNOSTIC_CHECKPOINT = "2026-09-09";
// Portfolio-level backstop, independent of any single group's own cap arithmetic — the exposure-cap
// bug (2026-08-24) showed per-group cap math itself can be wrong, so this is a second, simpler
// check (plain sum across groups) that doesn't share code with groupExposureCents' per-group logic.
// Set below the sum of all per-group caps ($105) so it can actually bind, not just mirror it.
export const MAKER_V2_GLOBAL_CAP_CENTS = 7500; // $75
export const MAKER_V2_LIVE_CELLS = [
  { group: "wnba-points", sport: "wnba", category: "points", band: [20, 24], sizeContracts: 25, capCents: 3000, stopLossCents: -1500, resumeFrom: MAKER_V2_WNBA_POINTS_RESUME },
  { group: "wnba-points", sport: "wnba", category: "points", band: [25, 29], sizeContracts: 25, capCents: 3000, stopLossCents: -1500, resumeFrom: MAKER_V2_WNBA_POINTS_RESUME },
  { group: "mlb-f5total", sport: "mlb", category: "f5total", band: [10, 14], sizeContracts: 40, capCents: 3000, stopLossCents: -1500, resumeFrom: MAKER_V2_TRIAL_START },
  { group: "mlb-hrr-negctrl", sport: "mlb", category: "hrr", band: [30, 34], sizeContracts: 20, capCents: 1500, stopLossCents: -750, resumeFrom: MAKER_V2_HRR_NEGCTRL_START },
  { group: "wnbasp-onesided", sport: "wnba", category: "spread", band: [20, 24], sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: MAKER_V2_WNBASP_ONESIDED_START },
  { group: "wnba3p-killdiag", sport: "wnba", category: "threePointers", band: [60, 64], sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: MAKER_V2_WNBA3P_KILLDIAG_START },
];
