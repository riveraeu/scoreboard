// api/lib/settlement-reconcile.test.js
import test from "node:test";
import assert from "node:assert";
import {
  reconcileGrades,
  isSettlementAuthoritative,
  SETTLEMENT_AUTHORITATIVE_SPORTS,
  SETTLEMENT_CUTOVER_DATE,
} from "./settlement-reconcile.js";

const graded = (entries) => new Map(entries.map(([id, won, sport = "lmb"]) => [id, { won, sport }]));
const voided = (entries) => new Map(entries.map(([id, sport = "lmb", result = "scalar"]) => [id, { sport, result }]));
const byId = (res) => new Map(res.updates.map(u => [u.id, u]));

test("authoritative set covers exactly the 15 shadow-only sports, and no calibrated family", () => {
  assert.strictEqual(SETTLEMENT_AUTHORITATIVE_SPORTS.size, 15);
  for (const s of ["tennis", "soccer", "fight", "golf", "nascar", "nbasl", "lmb",
                   "mls", "brasileirao", "nwsl", "chnsl", "ligamx", "scocup", "argprem", "dimayor"]) {
    assert.ok(isSettlementAuthoritative(s), `${s} should be authoritative`);
  }
  // The calibrated families must stay ESPN-graded — model accuracy needs physical reality.
  for (const s of ["mlb", "nba", "wnba", "nhl", "nfl"]) {
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
