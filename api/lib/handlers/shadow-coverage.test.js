import test from "node:test";
import assert from "node:assert/strict";
import { mergeCoverage } from "./shadow.js";

test("no previous stamp: current run stands alone", () => {
  const { coverage, coverageWarning } = mergeCoverage(null, { mlb: { games: 15, scheduled: 15 } });
  assert.deepEqual(coverage, { mlb: { games: 15, scheduled: 15 } });
  assert.equal(coverageWarning, false);
});

test("late run over decayed staging cannot erase the healthy cron stamp", () => {
  // The 2026-07-06 incident: cron stamped 15/15 + 4/2, then a 9pm manual verification
  // run recomputed 9/15 + 5/2 from evening staging and clobbered the KV.
  const prev = { mlb: { games: 15, scheduled: 15 }, wnba: { games: 4, scheduled: 2 } };
  const curr = { mlb: { games: 9, scheduled: 15 }, wnba: { games: 5, scheduled: 2 } };
  const { coverage, coverageWarning } = mergeCoverage(prev, curr);
  assert.deepEqual(coverage, { mlb: { games: 15, scheduled: 15 }, wnba: { games: 5, scheduled: 2 } });
  assert.equal(coverageWarning, false);
});

test("later fuller run raises coverage and clears the warning", () => {
  const prev = { mlb: { games: 9, scheduled: 15 } };
  const curr = { mlb: { games: 15, scheduled: 15 } };
  const { coverage, coverageWarning } = mergeCoverage(prev, curr);
  assert.deepEqual(coverage, { mlb: { games: 15, scheduled: 15 } });
  assert.equal(coverageWarning, false);
});

test("warning recomputes from merged values, union of sports", () => {
  // A sport only present in the previous stamp survives; a genuinely under-logged
  // sport still warns after the merge.
  const prev = { nba: { games: 5, scheduled: 5 } };
  const curr = { mlb: { games: 7, scheduled: 15 } };
  const { coverage, coverageWarning } = mergeCoverage(prev, curr);
  assert.deepEqual(coverage, { nba: { games: 5, scheduled: 5 }, mlb: { games: 7, scheduled: 15 } });
  assert.equal(coverageWarning, true);
});

test("scheduled also max-merges (degraded late run can under-stamp the slate)", () => {
  const prev = { mlb: { games: 12, scheduled: 15 } };
  const curr = { mlb: { games: 13, scheduled: 0 } };
  const { coverage } = mergeCoverage(prev, curr);
  assert.deepEqual(coverage, { mlb: { games: 13, scheduled: 15 } });
});

test("malformed previous values degrade to zeros, never throw", () => {
  const { coverage, coverageWarning } = mergeCoverage(
    { mlb: { games: "x" }, wnba: null },
    { mlb: { games: 2, scheduled: 2 } },
  );
  assert.deepEqual(coverage, { mlb: { games: 2, scheduled: 2 }, wnba: { games: 0, scheduled: 0 } });
  assert.equal(coverageWarning, false);
});
