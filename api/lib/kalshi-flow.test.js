import test from "node:test";
import assert from "node:assert/strict";
import { computeFlowFeatures } from "./kalshi-flow.js";

test("empty tape stamps zero counts and no ratio fields", () => {
  const f = computeFlowFeatures([]);
  assert.deepEqual(f, { xFlowTrades: 0, xFlowContracts: 0 });
});

test("non-array input treated as empty tape", () => {
  assert.deepEqual(computeFlowFeatures(undefined), { xFlowTrades: 0, xFlowContracts: 0 });
  assert.deepEqual(computeFlowFeatures(null), { xFlowTrades: 0, xFlowContracts: 0 });
});

test("taker yes share is contract-weighted, not trade-weighted (count_fp strings)", () => {
  const f = computeFlowFeatures([
    { count_fp: "90.00", taker_side: "yes" },
    { count_fp: "5.00", taker_side: "no" },
    { count_fp: "5.00", taker_side: "no" },
  ]);
  assert.equal(f.xFlowTrades, 3);
  assert.equal(f.xFlowContracts, 100);
  assert.equal(f.xFlowTakerYesPct, 90);
  assert.equal(f.xFlowAvgSize, 33.3);
});

test("large share counts trades at/above the 100-contract threshold", () => {
  const f = computeFlowFeatures([
    { count_fp: "100.00", taker_side: "yes" }, // large
    { count_fp: "99.00", taker_side: "no" },   // not large
    { count_fp: "1.00", taker_side: "no" },
  ]);
  assert.equal(f.xFlowLargeShare, 50);
});

test("legacy numeric count field still works as fallback", () => {
  const f = computeFlowFeatures([{ count: 10, taker_side: "yes" }]);
  assert.equal(f.xFlowContracts, 10);
  assert.equal(f.xFlowTakerYesPct, 100);
});

test("malformed rows (missing/NaN count, missing taker_side) don't poison totals", () => {
  const f = computeFlowFeatures([
    { count_fp: "20.00", taker_side: "yes" },
    { count_fp: null, taker_side: "yes" },
    { taker_side: "no" },
    { count_fp: "abc" },
    null,
  ]);
  assert.equal(f.xFlowTrades, 5);
  assert.equal(f.xFlowContracts, 20);
  assert.equal(f.xFlowTakerYesPct, 100);
});

test("all-no flow gives 0% taker yes", () => {
  const f = computeFlowFeatures([{ count_fp: "10.00", taker_side: "no" }]);
  assert.equal(f.xFlowTakerYesPct, 0);
});
