// api/lib/settlement-reconcile.js
// Reconciles Kalshi-settlement grading against the ESPN-based per-sport resolvers for one
// /api/shadow-resolver pass. Pure — no I/O, no DB, no env — so the precedence rules below are
// unit-testable without standing up a resolver run.
//
import { kalshiTickerDate } from "./kalshi-ticker.js";
//
// ── Doctrine (2026-07-25, see project_kalshi_missettlement_watch_2026_07_25 memory) ──
// For the shadow-only / model-free families, Kalshi's own settlement IS ground truth, because the
// only thing that data measures is ROI — and settlement is definitionally what a position would
// have been paid. That stays true even on the rare occasion Kalshi settles contrary to physical
// reality (confirmed once, 2026-07-24: KXMLBTEAMTOTAL-26JUL242215LAASF-SF8 settled "SF over 7.5" =
// yes on a 7-run game; the over really did pay).
//
// The historical reason MLB/NBA/WNBA/NHL/NFL stayed ESPN-graded was model-ACCURACY analysis, which
// wants physical reality rather than what the market paid. **That reason is GONE (2026-08-04 model
// teardown): no per-sport model, no accuracy analysis, every row is model-free ROI capture.** So
// MLB and WNBA are folded in here — additionally because the Polymarket cross-venue vig
// (venueVig / polymarket_plays, graded off Poly's own UMA settlement) is only apples-to-apples if
// the Kalshi side is graded by Kalshi's own settlement too: grading one venue by settlement and the
// other by a third-party (ESPN) view would make venue-vig deltas partly a grading-source artifact.
// NBA/NHL/NFL are left ESPN-graded FOR NOW only because they're off-season / not yet started (no
// Poly overlap, no rows); fold them the same way when they return.
//
// MLB/WNBA grade settlement-ONLY, exactly like the shadow-only families: the resolver also adds
// them to `_ownResolverSports`, so they leave `teamRows` and ESPN never runs on them. This was the
// deliberate choice over keeping ESPN as a cross-check: the makeup-reattribution escape (a forward-
// dated postponement makeup landing on the wrong doubleheader game) assumes an authoritative sport
// is never ESPN-graded, so leaving MLB in teamRows would re-expose that exact class during the
// settlement-pending window. The price is the ESPN-vs-settlement disagreement tripwire (the only
// reason we caught the mis-settlement above), accepted here: post-model there is no calibration to
// protect, settlement is definitionally correct for an ROI/vig row, and every other settlement
// family already runs with no such cross-check.

// The families whose grading Kalshi settlement wins. Model-free / shadow-only price-ROI capture,
// where settlement is definitionally correct: the club-soccer leagues + scocup, the Phase-1 shadow
// sports (tennis/soccer/fight/golf/nascar/nbasl/lmb), and — post model teardown (2026-08-04) — mlb
// and wnba. Adding a sport here makes settlement authoritative for it; removing one falls straight
// back to ESPN with no other change.
export const SETTLEMENT_AUTHORITATIVE_SPORTS = new Set([
  "tennis", "soccer", "fight", "golf", "nascar", "nbasl", "lmb",
  "mls", "brasileirao", "nwsl", "chnsl", "ligamx", "scocup", "argprem", "dimayor",
  "copadobrasil", "eredivisie", "eerstediv",
  "epl", "laliga", "seriea", "ligue1", "jleague",
  "laliga2", "usl", "copalib", "ligaportugal", "leaguescup", "bolpd",
  "mlb", "wnba",
  "dota2", "kleague", "kbo",
  "ufc", "boxing",
  // nfl folded in 2026-08-10 with the KXNFLGAME build, same reasoning as the 8/04 mlb/wnba
  // cutover: post-teardown there is no model-accuracy analysis left that needs physical reality,
  // and settlement grading makes the Kalshi side apples-to-apples with Polymarket's UMA
  // settlement for the cross-venue vig. Clean moment to cut over — NFL is between seasons, so the
  // five existing prop series (KXNFLPAYDS/RUYDS/REYDS/TDS/TOTAL) have no live rows and no
  // historical row changes meaning. Costs the ESPN-vs-settlement disagreement tripwire for NFL,
  // accepted on the same terms as mlb/wnba. nba/nhl stay ESPN-graded.
  "nfl",
]);

export function isSettlementAuthoritative(sport) {
  return SETTLEMENT_AUTHORITATIVE_SPORTS.has(sport);
}

// The day settlement grading went authoritative for the sports above. Load-bearing for
// /api/kalshi-dryrun-check: for an authoritative sport, a row resolved on or after this date has
// `won` written BY the settlement grader, so comparing it against settlement is circular and would
// report a tautological 100%. Rows resolved before it carry a genuine ESPN grade and stay a real
// comparison. Bump this only if the cutover is ever re-run from scratch.
// NOTE: mlb/wnba only became authoritative 2026-08-04 (their rows resolved 7/25→8/03 are still
// genuine ESPN grades), but this single global date treats them as circular from 7/25 — a
// CONSERVATIVE effect (it drops a few genuine MLB/WNBA comparisons from the dryrun diagnostic; it
// never manufactures a tautological agreement). Not worth a per-sport cutover for an ADMIN readout.
export const SETTLEMENT_CUTOVER_DATE = "2026-07-25";

// ── Row-level settlement authority: postponed games and their makeups (2026-07-29) ──────────
//
// The two predicates below name the cases where the ESPN path is STRUCTURALLY unable to identify
// which physical event a row's market refers to. They do not express a preference for settlement —
// they express that ESPN has no answer, so its answer must not be written.
//
// Found on the 2026-07-27 CLE@CIN postponement (65 mis-graded rows, /api/kalshi-dryrun-check):
// the game was postponed and made up as a 7/28 doubleheader, and BOTH halves of the row set broke,
// each in its own way. See docs/DEBUGGING.md § Postponed games and makeup doubleheaders.
//
// The trap worth knowing before touching this: **the ticker cannot identify the makeup game.**
// Ticker `KXMLBF3-26JUL271910CLECIN` encodes 19:10 ET, and makeup game 2 also started 23:10Z —
// the same wall clock one day later — while the market actually settled against game 1 (17:40Z).
// So matching on ticker time picks game 2 (wrong) and matching on ticker date picks 7/27 (also
// wrong, the game did not happen then). MLB's "the makeup is game 1" convention is a habit, not a
// rule. There is no ESPN-side mapping from a postponed market to its specific makeup game; only
// Kalshi's settlement knows which one it paid against. Anything that guesses here re-creates this
// bug in a new shape, which is exactly the failure pattern the 2026-07-27 cross-day mis-grade
// memo already warns about. Hence: detect, refuse to guess, defer.

// Normalize a Neon DATE (JS Date object) or an ISO-ish string to "YYYY-MM-DD".
// Neon returns DATE columns as JS Date objects — `String(d).slice(0,10)` yields "Mon Jul 2"
// (see the Neon gotchas in CLAUDE.md), so both shapes go through Date.
function _ymd(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * True when a row's game_date was re-attributed FORWARD of the date its Kalshi ticker encodes —
 * the signature of a postponed game whose makeup we hydrated from a later slate.
 *
 * Strictly forward (`>`), and that asymmetry is load-bearing rather than stylistic: `game_date` is
 * derived in PT while ticker dates are ET, so a late game can legitimately sit one day BEHIND its
 * ticker. Only a forward gap means re-attribution; a backward one is a timezone artifact and must
 * not be flagged. Requires no extra fetch — both values are on the row.
 *
 * Sport-agnostic on purpose: NBA/NHL/WNBA postponements have the identical shape.
 * Failure-closed — no ticker, no game_date, or an unparseable either → false (grade as before).
 */
export function isMakeupReattributed(row) {
  const tickerDate = kalshiTickerDate(row?.kalshi_ticker);
  if (!tickerDate) return false;
  const gameDate = _ymd(row?.game_date);
  if (!gameDate) return false;
  return gameDate > tickerDate;
}

/**
 * True when /api/live returned a terminal-LOOKING event that never actually finished — ESPN reports
 * POSTPONED / CANCELED / SUSPENDED as state:"post" with completed:false and 0-0 scores.
 *
 * The `=== false` test is the whole point and must not be relaxed to falsiness: `completed` is
 * absent from /api/live payloads cached before 2026-07-29, and those must keep behaving exactly as
 * they did rather than becoming un-gradeable en masse. The fix therefore phases in as the `live:*`
 * KV entries expire, which is the safe direction.
 */
export function isNonFinalTerminal(game) {
  return !!game && game.state === "post" && game.completed === false;
}

/**
 * Merge settlement grades over ESPN grades for one resolver pass.
 *
 * @param settlementGraded Map(id → { won: boolean, sport }) — finalized binary settlements for
 *        authoritative-sport rows only. The caller is responsible for that scoping.
 * @param settlementVoided Map(id → { sport, result }) — finalized-but-non-binary (void) markets.
 * @param espnUpdates      [{ id, won, actualValue }] as pushed by the per-sport ESPN blocks.
 * @returns { updates, agreed, disagreed, settlementOnly, espnAbsent, espnNulled, voided,
 *            voidedOverridingEspn, disagreements, bySport }
 *
 * `espnAbsent` is the count of rows settlement resolved that the ESPN pass never produced any
 * verdict for — i.e. rows the resolver counted as `noData`/`skipped`. The caller needs it to keep
 * its log line honest: those rows ARE resolved now, so a raw `noData` count overstates what was
 * left behind.
 *
 * `updates` is safe to hand straight to neonBatchResolve: one entry per id, no duplicates.
 * ESPN's `actualValue` is preserved whenever ESPN saw the same row, since settlement can never
 * produce one (Kalshi reports yes/no, not the realized stat value).
 */
export function reconcileGrades({
  settlementGraded = new Map(),
  settlementVoided = new Map(),
  espnUpdates = [],
  maxSamples = 10,
} = {}) {
  const espnById = new Map(espnUpdates.map(u => [u.id, u]));
  const byId = new Map(); // id → final update (dedupes by construction)
  const disagreements = [];
  const bySport = {};
  let agreed = 0, disagreed = 0, settlementOnly = 0, voided = 0, voidedOverridingEspn = 0;
  let espnAbsent = 0, espnNulled = 0;

  const bump = (sport, field) => {
    const s = bySport[sport] || (bySport[sport] = {
      agree: 0, disagree: 0, settlementOnly: 0, voided: 0,
    });
    s[field]++;
  };

  // 1. Settlement-graded rows win outright.
  for (const [id, { won, sport }] of settlementGraded) {
    const espn = espnById.get(id);
    const actualValue = espn?.actualValue ?? null;
    byId.set(id, { id, won, actualValue });

    // A null/undefined ESPN `won` is not a disagreement — it means the ESPN path explicitly
    // abandoned the row (DNP, incomplete segment, unmatched event). Settlement rescuing those is
    // the single biggest win here, so it gets its own counter rather than being lumped in.
    if (espn && espn.won !== null && espn.won !== undefined) {
      if (espn.won === won) { agreed++; bump(sport, "agree"); }
      else {
        disagreed++; bump(sport, "disagree");
        if (disagreements.length < maxSamples) {
          disagreements.push({ id, sport, espnWon: espn.won, kalshiWon: won });
        }
      }
    } else {
      settlementOnly++; bump(sport, "settlementOnly");
      if (espn) espnNulled++; else espnAbsent++;
    }
  }

  // 2. Voids are terminal: resolved with won=NULL so they exit the scan now instead of waiting out
  //    the 14-day abandonment sweep, and drop cleanly from calibration (which filters
  //    won IS NOT NULL). This is the one path that can discard a real ESPN grade — deliberate:
  //    a voided market contributes nothing to ROI, so keeping a win/loss on it would actively
  //    corrupt the only number these rows exist to produce. It is also the safer read on the
  //    data, since an ESPN grade on a market Kalshi voided usually means ESPN matched the wrong
  //    event (a rescheduled game, or tennis's whole-tournament scoreboard). Counted separately so
  //    a spike is visible rather than silent.
  for (const [id, { sport }] of settlementVoided) {
    if (settlementGraded.has(id)) continue; // graded wins; a ticker can't be both
    const espn = espnById.get(id);
    if (espn && espn.won !== null && espn.won !== undefined) voidedOverridingEspn++;
    else if (!espn) espnAbsent++;
    byId.set(id, { id, won: null, actualValue: espn?.actualValue ?? null });
    voided++; bump(sport, "voided");
  }

  // 3. Everything settlement didn't touch passes through exactly as ESPN graded it — including
  //    every teamRows row, which is why this function is a no-op for the calibrated families.
  for (const u of espnUpdates) {
    if (!byId.has(u.id)) byId.set(u.id, u);
  }

  return {
    updates: [...byId.values()],
    agreed, disagreed, settlementOnly, espnAbsent, espnNulled, voided, voidedOverridingEspn,
    disagreements, bySport,
  };
}
