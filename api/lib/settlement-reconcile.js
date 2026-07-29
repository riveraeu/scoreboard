// api/lib/settlement-reconcile.js
// Reconciles Kalshi-settlement grading against the ESPN-based per-sport resolvers for one
// /api/shadow-resolver pass. Pure — no I/O, no DB, no env — so the precedence rules below are
// unit-testable without standing up a resolver run.
//
// ── Doctrine (2026-07-25, see project_kalshi_missettlement_watch_2026_07_25 memory) ──
// For the shadow-only / model-free families, Kalshi's own settlement IS ground truth, because the
// only thing that data measures is ROI — and settlement is definitionally what a position would
// have been paid. That stays true even on the rare occasion Kalshi settles contrary to physical
// reality (confirmed once, 2026-07-24: KXMLBTEAMTOTAL-26JUL242215LAASF-SF8 settled "SF over 7.5" =
// yes on a 7-run game; the over really did pay). Model-ACCURACY analysis wants reality instead,
// which is why the calibrated families (MLB/NBA/WNBA/NHL/NFL props, totals, ML, spread, segments —
// everything the resolver calls `teamRows`) are deliberately absent from
// SETTLEMENT_AUTHORITATIVE_SPORTS and stay ESPN-graded.
//
// ESPN keeps running on authoritative rows rather than being skipped, purely so disagreements stay
// observable — that cross-check is the only reason we know about the mis-settlement above.
// Excluding those rows from the ESPN pass would be less work and would blind the sole tripwire we
// have on either feed.

// The shadow-only families whose grading Kalshi settlement wins. Every one is either model-free
// (the 6 club-soccer leagues + scocup — truePct is null, there is no calibration to protect) or
// shadow-only Phase-1 (tennis/soccer/fight/golf/nascar/nbasl/lmb), where the row's purpose is
// price/ROI measurement. Adding a sport here makes settlement authoritative for it; removing a
// sport falls straight back to ESPN with no other change.
export const SETTLEMENT_AUTHORITATIVE_SPORTS = new Set([
  "tennis", "soccer", "fight", "golf", "nascar", "nbasl", "lmb",
  "mls", "brasileirao", "nwsl", "chnsl", "ligamx", "scocup", "argprem", "dimayor",
]);

export function isSettlementAuthoritative(sport) {
  return SETTLEMENT_AUTHORITATIVE_SPORTS.has(sport);
}

// The day settlement grading went authoritative for the sports above. Load-bearing for
// /api/kalshi-dryrun-check: for an authoritative sport, a row resolved on or after this date has
// `won` written BY the settlement grader, so comparing it against settlement is circular and would
// report a tautological 100%. Rows resolved before it carry a genuine ESPN grade and stay a real
// comparison. Bump this only if the cutover is ever re-run from scratch.
export const SETTLEMENT_CUTOVER_DATE = "2026-07-25";

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
