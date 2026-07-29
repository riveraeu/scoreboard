// Shared universal-qualification tunables. Single source of truth — imported by both
// the server (api/lib/handlers/tonight.js) and the client (src/App.jsx, LineupsPage.jsx).
//
// Server and client use different EDGE gates intentionally: server stores every pick at
// edge≥3 to preserve calibration data continuity, client filters display to ≥5 (the
// tighter regime per feedback_totals_aggressive_corrections). See CLAUDE.md "Universal
// qualification" for context.

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

export const KALSHI_GATE = 67;        // ~-200 American odds floor (66.67% rounded up)
export const KALSHI_CAP  = 91;        // ~-1000 American odds cap (90.91% rounded up)
export const EDGE_GATE_SERVER = 3;    // server-side filter, preserved for calibration analysis
export const EDGE_GATE_CLIENT = 5;    // client-side filter for display + tracking gate

// Capture (shadow-logging) bounds — quote-sanity only. Full-curve capture (2026-07-03): the
// goal was always to track ALL picks and let the data locate where the model performs best;
// price filtering belongs at analysis/bet-window time, never at collection. The prior
// favorite-curve band [55,97] (2026-06-29 de-blinding) still blinded the coin-flip zone (both
// sides <55 — WNBA half/quarter spreads were almost entirely unlogged) and the >97 tail, and
// its floor made any sub-55 derived bet window (e.g. f5ml's discovered 40–55) unshippable via
// betWindowFor's bounds check. Measured cost of de-gating: ~+19% rows/day, no plan-tier change.
// 1/99 exclude only structurally dead quotes (ask of 0 = no ask; 100 = no real offer). These
// gate ONLY what gets logged; the `qualified` bet flag still uses betWindowFor (global [67,91]).
// The liquidity gate below (CAPTURE_MAX_SPREAD) stays — it rejects fake prices, not price levels.
export const CAPTURE_GATE = 1;        // capture floor — a 0¢ ask is an absent quote, not a price
export const CAPTURE_CAP  = 99;       // capture cap — a 100¢ ask is an absent offer, not a price

// Capture liquidity gate (2026-06-30). A prop rung with no real two-sided book — only a lone
// wide quote on the opposite side — reports a bet-side ask that is an ARTIFACT, not a tradeable
// price. On Kalshi, a lone NO bid at ~6¢ mechanically implies yes_ask=94¢, so high-threshold
// totalBases longshots got logged as 94¢ "favorites" (116 live on 6/30), inflating the accuracy
// board's Brier skill to a fake +0.15 (clean = +0.004 parity). Real favorites have a tight
// bet-side spread (France live: ≤7¢); artifacts are ~94¢. Reject at capture when the bet-side
// bid-ask spread exceeds this. Capture-only — the [KALSHI_GATE, KALSHI_CAP] bet flag is untouched.
export const CAPTURE_MAX_SPREAD = 15; // cents — max bet-side bid-ask spread to log a rung
export const capturableSpread = (spreadCents, cap = CAPTURE_MAX_SPREAD) =>
  spreadCents != null && spreadCents <= cap;

// Shadow maker engine (2026-07-19, api/lib/maker.js). The pooled market-calibration scan
// (n=44.5k) found the venue's vig sits on the FAVORITE ask (2-8¢ above realized frequency,
// monotone in price) while longshot asks are ~fair — so the structural play is QUOTING the
// favorite side (selling the rich ask as a maker), not taking. V1 simulates: quote 1¢ inside
// the prevailing favorite ask on maker-fee-free series, detect fills from the public trade
// tape, grade at settlement. Arm real orders only at fill-PnL CI-lo>0, n≥200 fills.
export const MAKER_BAND = [55, 97];   // favorite-ask band to quote inside (≥98 = stale-ask regime).
// Floor dropped 80→55 on 2026-07-21: the 7/21 ARM review found the real (shadow-fill) edge lives
// only in 80-84 of the original [80,97] band — 85-97 is flat/negative. 55-79 is measurement-only
// exploration of the pooled-calibration gap between "longshot asks are ~fair" (≤35¢, already
// answered) and the studied 70-97 favorite zone; V2 scope stays [80,84] until this range proves
// itself. See docs/INFRA.md § Shadow maker engine.
export const MAKER_INSIDE_C = 1;      // quote this many cents inside the prevailing ask
export const MAKER_SIZE = 10;         // simulated contracts per quote segment

// Shadow maker V2 (2026-07-21, api/lib/maker-live.js) — REAL resting orders, scoped tight to
// the one sub-band the 7/21 ARM review found a real, non-borderline edge in (n=295,
// CI-lo≈+6¢); 85-97 stays V1-shadow-only. Defaults are deliberately conservative for the debut
// — scale up only as a human decision once mechanics (place/reprice/fill/settle/grade) are
// confirmed against real fills. See docs/INFRA.md § Shadow maker engine.
export const MAKER_V2_BAND = [80, 84];       // real-order eligibility band (narrower than MAKER_BAND)
export const MAKER_V2_SIZE = 5;              // contracts per resting order
export const MAKER_V2_MAX_CONCURRENT = 20;   // total resting orders across all tickers
export const MAKER_V2_SAME_GAME_CAP = 2;     // max concurrent resting orders per game (correlation guard)
export const MAKER_V2_EXPIRATION_SEC = 150;  // self-expiring safety net — outlives one ~2min cron cycle

// Per-category DATA-DERIVED bet windows. The `qualified` bet flag defaults to the global
// [KALSHI_GATE, KALSHI_CAP]; an entry here OVERRIDES it for one "sport|stat" category with a
// [lo, hi] cents band. This is the payoff of capture de-blinding: tune:residual showed some
// categories' edge lives outside [67,91] (e.g. mlb|totalBases above the 91¢ cap), and the wider
// [CAPTURE_GATE, CAPTURE_CAP] capture band lets that window be MEASURED. Populate a category here
// ONLY after `npm run tune:window -- --category <sport|stat>` returns GO at n≥200 — i.e. the
// discovered window's out-of-sample ROI CI-lo > 0 AND the model is Brier-eligible. This is a
// forward-only, human-in-the-loop apply (like the category gate + FORMULA_CUTOFFS); we do NOT
// auto-tune the live window from the report's in-sample discoveredWindow (that ROI is upward-biased
// by construction — the out-of-sample split in tune:window is the guard). Windows must satisfy
// CAPTURE_GATE ≤ lo < hi ≤ CAPTURE_CAP. Empty = every category bets [67,91] (no behavior change).
//
// COVERAGE: `betWindowFor` is applied at the PROP emit chokepoint (api/lib/tonight/props.js) — the
// one site that governs every player-prop category, incl. the mlb|totalBases target. The game-total
// / teamTotal / ML / spread emit paths (game-totals.js, ml-spread.js) still use the global window
// inline at ~28 sites; extend those (route each through betWindowFor) only if/when a NON-prop
// category earns a derived window. A window set here for a non-prop category is currently a no-op —
// betWindowFor validates shape but does not know a category's emit path.
export const CATEGORY_BET_WINDOWS = {
  // "mlb|totalBases": [88, 97],  // example — DO NOT enable without a tune:window GO
  // mlb|hrr NO-side window (2026-07-11): emit flip redirects HRR to bet NO when NO edge > YES edge.
  // Market overprices hits by ~7¢ avg; sigmoid cap (71%) blocks YES edge. NO ask for YES-priced
  // [67,76]¢ markets lands ~24–33¢. 65–70 YES band: actual=67.9%, market=73.5¢, NO ROI ≈ +8.8% (n=187).
  // Pre-tune:window provisional starter; recheck tune:window at n≥200 OOS post-2026-07-11.
  "mlb|hrr": [24, 33],
};

// The bet window for a category: its derived override if set, else the global [67,91]. One
// chokepoint — imported by the server qualified flag (tonight.js) and the client core (qualify.js).
export function betWindowFor(sport, stat) {
  const w = CATEGORY_BET_WINDOWS[`${sport}|${stat}`];
  if (Array.isArray(w) && w.length === 2 &&
      Number.isFinite(w[0]) && Number.isFinite(w[1]) &&
      w[0] < w[1] && w[0] >= CAPTURE_GATE && w[1] <= CAPTURE_CAP) {
    return w;
  }
  return [KALSHI_GATE, KALSHI_CAP];
}
