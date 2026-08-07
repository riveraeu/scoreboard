// api/lib/settlement-reconcile.test.js
import test from "node:test";
import assert from "node:assert";
import {
  reconcileGrades,
  isSettlementAuthoritative,
  isMakeupReattributed,
  isNonFinalTerminal,
  SETTLEMENT_AUTHORITATIVE_SPORTS,
  SETTLEMENT_CUTOVER_DATE,
} from "./settlement-reconcile.js";
import { MODEL_FREE_LEAGUE_KEYS } from "./model-free-leagues.js";

const graded = (entries) => new Map(entries.map(([id, won, sport = "lmb"]) => [id, { won, sport }]));
const voided = (entries) => new Map(entries.map(([id, sport = "lmb", result = "scalar"]) => [id, { sport, result }]));
const byId = (res) => new Map(res.updates.map(u => [u.id, u]));

test("authoritative set covers the shadow-only sports + mlb/wnba; nba/nhl/nfl stay ESPN", () => {
  // 16 shadow-only/model-free + mlb + wnba (folded in 2026-08-04, post model teardown — no model
  // accuracy to protect, and settlement grading makes the Kalshi side apples-to-apples with Poly's
  // own UMA settlement for the cross-venue vig).
  assert.strictEqual(SETTLEMENT_AUTHORITATIVE_SPORTS.size, 19);
  for (const s of ["tennis", "soccer", "fight", "golf", "nascar", "nbasl", "lmb",
                   "mls", "brasileirao", "nwsl", "chnsl", "ligamx", "scocup", "argprem", "dimayor",
                   "copadobrasil", "eredivisie", "mlb", "wnba"]) {
    assert.ok(isSettlementAuthoritative(s), `${s} should be authoritative`);
  }
  // nba/nhl/nfl stay ESPN-graded FOR NOW — off-season / not yet started, no Poly overlap. Fold the
  // same way when they return in season.
  for (const s of ["nba", "nhl", "nfl"]) {
    assert.ok(!isSettlementAuthoritative(s), `${s} must NOT be authoritative`);
  }
});

test("settlement wins on conflict, and ESPN's actualValue is preserved", () => {
  const res = reconcileGrades({
    settlementGraded: graded([["a", true]]),
    espnUpdates: [{ id: "a", won: false, actualValue: 3 }],
  });
  assert.strictEqual(res.updates.length, 1);
  assert.deepStrictEqual(res.updates[0], { id: "a", won: true, actualValue: 3 });
  assert.strictEqual(res.disagreed, 1);
  assert.strictEqual(res.agreed, 0);
  assert.deepStrictEqual(res.disagreements[0], { id: "a", sport: "lmb", espnWon: false, kalshiWon: true });
});

test("agreement is counted without changing the written grade", () => {
  const res = reconcileGrades({
    settlementGraded: graded([["a", true], ["b", false]]),
    espnUpdates: [{ id: "a", won: true, actualValue: 1 }, { id: "b", won: false, actualValue: 2 }],
  });
  assert.strictEqual(res.agreed, 2);
  assert.strictEqual(res.disagreed, 0);
  assert.deepStrictEqual(byId(res).get("a"), { id: "a", won: true, actualValue: 1 });
  assert.deepStrictEqual(byId(res).get("b"), { id: "b", won: false, actualValue: 2 });
});

test("won:false is a real grade, never confused with 'ESPN could not grade'", () => {
  // Guards the `espn.won !== null && !== undefined` check against a truthiness regression.
  const res = reconcileGrades({
    settlementGraded: graded([["a", false]]),
    espnUpdates: [{ id: "a", won: false, actualValue: 0 }],
  });
  assert.strictEqual(res.agreed, 1);
  assert.strictEqual(res.settlementOnly, 0);
});

test("settlement rescues rows ESPN explicitly abandoned (won:null), counted separately", () => {
  const res = reconcileGrades({
    settlementGraded: graded([["a", true]]),
    espnUpdates: [{ id: "a", won: null, actualValue: null }],
  });
  assert.strictEqual(res.settlementOnly, 1);
  assert.strictEqual(res.agreed, 0);
  assert.strictEqual(res.disagreed, 0);
  assert.strictEqual(byId(res).get("a").won, true);
});

test("settlement grades rows ESPN never reached at all", () => {
  const res = reconcileGrades({ settlementGraded: graded([["a", true]]), espnUpdates: [] });
  assert.strictEqual(res.settlementOnly, 1);
  assert.deepStrictEqual(res.updates[0], { id: "a", won: true, actualValue: null });
});

test("voids resolve to won:null so they exit the scan instead of waiting out abandonment", () => {
  const res = reconcileGrades({ settlementVoided: voided([["a"]]), espnUpdates: [] });
  assert.strictEqual(res.voided, 1);
  assert.strictEqual(res.voidedOverridingEspn, 0);
  assert.deepStrictEqual(res.updates[0], { id: "a", won: null, actualValue: null });
});

test("a void overrides a real ESPN grade, and says so out loud", () => {
  const res = reconcileGrades({
    settlementVoided: voided([["a"]]),
    espnUpdates: [{ id: "a", won: true, actualValue: 5 }],
  });
  assert.strictEqual(res.voided, 1);
  assert.strictEqual(res.voidedOverridingEspn, 1);
  assert.strictEqual(byId(res).get("a").won, null, "voided market must not carry a win/loss");
  assert.strictEqual(byId(res).get("a").actualValue, 5, "realized value is still worth keeping");
});

test("a graded settlement beats a void for the same id (can't be both)", () => {
  const res = reconcileGrades({
    settlementGraded: graded([["a", true]]),
    settlementVoided: voided([["a"]]),
    espnUpdates: [],
  });
  assert.strictEqual(res.updates.length, 1);
  assert.strictEqual(res.updates[0].won, true);
  assert.strictEqual(res.voided, 0);
});

test("non-authoritative rows pass through untouched — the teamRows no-op", () => {
  const espnUpdates = [
    { id: "mlb-1", won: true, actualValue: 7 },
    { id: "mlb-2", won: false, actualValue: 2 },
    { id: "mlb-3", won: null, actualValue: null },
  ];
  const res = reconcileGrades({ espnUpdates });
  assert.deepStrictEqual(res.updates, espnUpdates);
  assert.strictEqual(res.agreed, 0);
  assert.strictEqual(res.disagreed, 0);
  assert.strictEqual(res.voided, 0);
});

test("output has no duplicate ids — safe to hand to neonBatchResolve", () => {
  const res = reconcileGrades({
    settlementGraded: graded([["a", true], ["b", false]]),
    settlementVoided: voided([["c"]]),
    espnUpdates: [
      { id: "a", won: true, actualValue: 1 },
      { id: "b", won: true, actualValue: 2 },
      { id: "c", won: false, actualValue: 3 },
      { id: "d", won: true, actualValue: 4 },
    ],
  });
  const ids = res.updates.map(u => u.id);
  assert.strictEqual(ids.length, new Set(ids).size);
  assert.strictEqual(ids.length, 4);
});

test("per-sport attribution splits agree/disagree/settlementOnly/voided", () => {
  const res = reconcileGrades({
    settlementGraded: graded([
      ["t1", true, "tennis"], ["t2", true, "tennis"], ["m1", true, "mls"],
    ]),
    settlementVoided: voided([["g1", "golf"]]),
    espnUpdates: [
      { id: "t1", won: true, actualValue: null },   // tennis agree
      { id: "t2", won: false, actualValue: null },  // tennis disagree
      { id: "m1", won: null, actualValue: null },   // mls settlementOnly
    ],
  });
  assert.deepStrictEqual(res.bySport.tennis, { agree: 1, disagree: 1, settlementOnly: 0, voided: 0 });
  assert.deepStrictEqual(res.bySport.mls, { agree: 0, disagree: 0, settlementOnly: 1, voided: 0 });
  assert.deepStrictEqual(res.bySport.golf, { agree: 0, disagree: 0, settlementOnly: 0, voided: 1 });
});

test("disagreement samples are capped", () => {
  const entries = Array.from({ length: 25 }, (_, i) => [`id${i}`, true]);
  const res = reconcileGrades({
    settlementGraded: graded(entries),
    espnUpdates: entries.map(([id]) => ({ id, won: false, actualValue: null })),
    maxSamples: 3,
  });
  assert.strictEqual(res.disagreed, 25, "every disagreement is counted");
  assert.strictEqual(res.disagreements.length, 3, "only the sample is capped");
});

test("empty input is a clean no-op (the failure-closed path)", () => {
  const res = reconcileGrades();
  assert.deepStrictEqual(res.updates, []);
  assert.strictEqual(res.agreed + res.disagreed + res.voided + res.settlementOnly, 0);
});

test("cutover date is a plain YYYY-MM-DD, safe for lexicographic comparison", () => {
  assert.match(SETTLEMENT_CUTOVER_DATE, /^\d{4}-\d{2}-\d{2}$/);
});

test("espnAbsent vs espnNulled split — keeps the resolver's noData log line honest", () => {
  const res = reconcileGrades({
    settlementGraded: graded([["absent1", true], ["absent2", false], ["nulled", true]]),
    settlementVoided: voided([["voidAbsent"]]),
    espnUpdates: [{ id: "nulled", won: null, actualValue: null }],
  });
  // 2 graded rows + 1 voided row that ESPN never produced any verdict for (its noData/skipped).
  assert.strictEqual(res.espnAbsent, 3);
  // 1 row ESPN saw but explicitly abandoned.
  assert.strictEqual(res.espnNulled, 1);
  assert.strictEqual(res.settlementOnly, 3, "settlementOnly covers graded rows only, not voids");
});

// ── Postponed games + makeup doubleheaders (2026-07-29) ──────────────────────────────────────
// Regression cover for the 65 mis-graded CLE@CIN rows. Both predicates decide whether the ESPN
// path is allowed to write a grade at all, so a false NEGATIVE re-opens the bug and a false
// POSITIVE silently stops grading a healthy population — both directions are pinned.

test("isMakeupReattributed: game_date FORWARD of the ticker date is a makeup re-attribution", () => {
  // The real row: ticker says 2026-07-27, the makeup was played (and re-attributed) on 07-28.
  assert.ok(isMakeupReattributed({
    kalshi_ticker: "KXMLBF3-26JUL271910CLECIN-CIN",
    game_date: "2026-07-28",
  }));
});

test("isMakeupReattributed: a game_date BEHIND the ticker date is a PT/ET artifact, not a makeup", () => {
  // game_date is derived in PT, ticker dates are ET, so a late game can legitimately sit one day
  // behind its ticker. Flagging that would stop grading healthy west-coast rows.
  assert.strictEqual(isMakeupReattributed({
    kalshi_ticker: "KXMLBGAME-26JUL28LADSF-LAD",
    game_date: "2026-07-27",
  }), false);
});

test("isMakeupReattributed: matching dates are the normal case", () => {
  assert.strictEqual(isMakeupReattributed({
    kalshi_ticker: "KXMLBF3-26JUL271910CLECIN-CIN",
    game_date: "2026-07-27",
  }), false);
});

test("isMakeupReattributed: accepts a Neon DATE (JS Date object), not just an ISO string", () => {
  // Neon returns DATE columns as Date objects — String(d).slice(0,10) would yield "Mon Jul 2".
  assert.ok(isMakeupReattributed({
    kalshi_ticker: "KXMLBF3-26JUL271910CLECIN-CIN",
    game_date: new Date("2026-07-28T00:00:00.000Z"),
  }));
});

test("isMakeupReattributed: failure-closed on missing/unparseable inputs", () => {
  for (const row of [
    {},
    { kalshi_ticker: null, game_date: "2026-07-28" },
    { kalshi_ticker: "KXMLBF3-NOTADATE-CIN", game_date: "2026-07-28" },   // pre-2026-07-23 rows
    { kalshi_ticker: "KXMLBF3-26JUL271910CLECIN-CIN", game_date: null },
    { kalshi_ticker: "KXMLBF3-26JUL271910CLECIN-CIN", game_date: "not-a-date" },
  ]) {
    assert.strictEqual(isMakeupReattributed(row), false, JSON.stringify(row));
  }
});

test("isNonFinalTerminal: ESPN reports POSTPONED as state:post + completed:false", () => {
  // The exact payload shape that graded the 7/27 CLE@CIN rows as a 0-0 final.
  assert.ok(isNonFinalTerminal({ state: "post", completed: false, homeScore: 0, awayScore: 0 }));
});

test("isNonFinalTerminal: a real final is not terminal-non-final", () => {
  assert.strictEqual(isNonFinalTerminal({ state: "post", completed: true, homeScore: 6, awayScore: 5 }), false);
});

test("isNonFinalTerminal: absent `completed` (payload cached pre-2026-07-29) grades as before", () => {
  // Must be `=== false`, never falsiness — relaxing this would make every cached payload
  // un-gradeable at once, which is a far bigger outage than the bug being fixed.
  assert.strictEqual(isNonFinalTerminal({ state: "post", homeScore: 6, awayScore: 5 }), false);
  assert.strictEqual(isNonFinalTerminal({ state: "post", completed: undefined }), false);
});

test("isNonFinalTerminal: non-post states and missing games are never terminal", () => {
  assert.strictEqual(isNonFinalTerminal({ state: "in", completed: false }), false);
  assert.strictEqual(isNonFinalTerminal({ state: "pre", completed: false }), false);
  assert.strictEqual(isNonFinalTerminal({ state: "unknown" }), false);
  assert.strictEqual(isNonFinalTerminal(null), false);
  assert.strictEqual(isNonFinalTerminal(undefined), false);
});

test("promoted postponed rows carry no actualValue from the wrong game", () => {
  // The forward path keeps these rows out of `espnUpdates` entirely, so reconcile has no ESPN
  // entry to inherit an actualValue from. Pins that the promotion path writes a clean row rather
  // than a corrected label over a stale value read off the wrong physical game.
  const res = reconcileGrades({
    settlementGraded: graded([["postponed1", true, "mlb"]]),
    espnUpdates: [],
  });
  const u = byId(res).get("postponed1");
  assert.strictEqual(u.won, true);
  assert.strictEqual(u.actualValue, null);
  assert.strictEqual(res.espnAbsent, 1, "counted as ESPN-absent, not as a disagreement");
  assert.strictEqual(res.disagreed, 0);
});

test("every model-free league is settlement-authoritative", () => {
  // A model-free league has no truePct, so there is no calibration to protect and ESPN accuracy is
  // beside the point — settlement IS its grading path. Adding league #8 to MODEL_FREE_LEAGUES while
  // forgetting this set would leave it ESPN-graded with no model behind it, silently. The resolver's
  // teamRows split now derives from the same registry, so this is the remaining hand-maintained
  // half of that contract.
  for (const league of MODEL_FREE_LEAGUE_KEYS) {
    assert.ok(isSettlementAuthoritative(league),
      `${league} is in MODEL_FREE_LEAGUES but not SETTLEMENT_AUTHORITATIVE_SPORTS`);
  }
});
