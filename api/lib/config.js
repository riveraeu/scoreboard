// Shared universal-qualification tunables. Single source of truth — imported by both
// the server (api/lib/handlers/tonight.js) and the client (src/App.jsx, LineupsPage.jsx).
//
// Server and client use different EDGE gates intentionally: server stores every pick at
// edge≥3 to preserve calibration data continuity, client filters display to ≥5 (the
// tighter regime per feedback_totals_aggressive_corrections). See CLAUDE.md "Universal
// qualification" for context.

export const KALSHI_GATE = 67;        // ~-200 American odds floor (66.67% rounded up)
export const KALSHI_CAP  = 91;        // ~-1000 American odds cap (90.91% rounded up)
export const EDGE_GATE_SERVER = 3;    // server-side filter, preserved for calibration analysis
export const EDGE_GATE_CLIENT = 5;    // client-side filter for display + tracking gate

// Capture (shadow-logging) bounds — deliberately WIDER than the bet window so calibration can
// see the whole favorite curve, not just the [67,91] band we already bet. This is the fix for
// the 2026-06-29 blindness: tune:residual found mlb|totalBases' Brier edge lives ABOVE 91¢, but
// the collection pre-filter capped capture at 91 — we "discovered" an edge band we couldn't see
// the top of. Capturing wider lets the bet window be DERIVED from data (bettingBoard
// discoveredWindow + Brier eligibility) instead of assumed. These gate ONLY what gets logged;
// the `qualified` bet flag still uses [KALSHI_GATE, KALSHI_CAP]. Bounded (not "log everything")
// to protect staging size (Upstash 10MB) + drop dead coinflips/near-certs with no learning value.
export const CAPTURE_GATE = 55;       // favorite-side floor (below ~55 both sides are dogs / coinflip)
export const CAPTURE_CAP  = 97;       // favorite-side cap (above ~97 payout asymmetry is unbettable, liquidity dead)

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
