// node --test api/lib/kalshi-settlement.test.js
// Table-driven tests for the Kalshi-settlement grading mapping — see CLAUDE.md /
// project_kalshi_settlement_grading_2026_07_23 memory. Dry-run only as of 2026-07-23.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKalshiSide, wonFromKalshiResult, resolveRowViaKalshi } from "./kalshi-settlement.js";

test("deriveKalshiSide: explicit kalshiSide wins regardless of direction", () => {
  assert.equal(deriveKalshiSide({ kalshiSide: "yes", direction: "under" }), "yes");
  assert.equal(deriveKalshiSide({ kalshiSide: "no", direction: "over" }), "no");
  assert.equal(deriveKalshiSide({ kalshiSide: "no", direction: null }), "no");
});

test("deriveKalshiSide: direction-based fallback (over/under families without kalshiSide)", () => {
  assert.equal(deriveKalshiSide({ direction: "under" }), "no");
  assert.equal(deriveKalshiSide({ direction: "over" }), "yes");
});

test("deriveKalshiSide: direction:null defaults to yes (one-ticker-per-outcome families)", () => {
  assert.equal(deriveKalshiSide({ direction: null }), "yes");
  assert.equal(deriveKalshiSide({}), "yes");
});

test("wonFromKalshiResult: yes/no results grade against the stored side", () => {
  assert.equal(wonFromKalshiResult("yes", "yes"), true);
  assert.equal(wonFromKalshiResult("no", "yes"), false);
  assert.equal(wonFromKalshiResult("yes", "no"), false);
  assert.equal(wonFromKalshiResult("no", "no"), true);
});

test("wonFromKalshiResult: scalar (void) and anything non-binary → null, never a guess", () => {
  assert.equal(wonFromKalshiResult("scalar", "yes"), null);
  assert.equal(wonFromKalshiResult(null, "yes"), null);
  assert.equal(wonFromKalshiResult(undefined, "no"), null);
});

test("resolveRowViaKalshi: null when the row has no ticker", () => {
  const settlements = new Map([["KXFOO-1", { status: "finalized", result: "yes" }]]);
  assert.equal(resolveRowViaKalshi({ kalshi_ticker: null, kalshi_side: "yes" }, settlements), null);
});

test("resolveRowViaKalshi: null when the ticker isn't in the settlements map (fetch miss / not settled)", () => {
  const settlements = new Map();
  assert.equal(resolveRowViaKalshi({ kalshi_ticker: "KXFOO-1", kalshi_side: "yes" }, settlements), null);
});

test("resolveRowViaKalshi: null when status isn't finalized yet", () => {
  const settlements = new Map([["KXFOO-1", { status: "open", result: null }]]);
  assert.equal(resolveRowViaKalshi({ kalshi_ticker: "KXFOO-1", kalshi_side: "yes" }, settlements), null);
});

test("resolveRowViaKalshi: null on a void (scalar) settlement — the LMB/MLS postponement + MLB props/tennis/golf withdrawal case", () => {
  const settlements = new Map([["KXFOO-1", { status: "finalized", result: "scalar" }]]);
  assert.equal(resolveRowViaKalshi({ kalshi_ticker: "KXFOO-1", kalshi_side: "yes" }, settlements), null);
});

test("resolveRowViaKalshi: real yes/no settlement grades correctly against kalshi_side", () => {
  const settlements = new Map([
    ["KXFOO-1", { status: "finalized", result: "yes" }],
    ["KXFOO-2", { status: "finalized", result: "no" }],
  ]);
  // e.g. a total/prop "under" row: kalshi_side "no" means we bet the NO price.
  assert.equal(resolveRowViaKalshi({ kalshi_ticker: "KXFOO-1", kalshi_side: "yes" }, settlements), true);
  assert.equal(resolveRowViaKalshi({ kalshi_ticker: "KXFOO-2", kalshi_side: "yes" }, settlements), false);
  assert.equal(resolveRowViaKalshi({ kalshi_ticker: "KXFOO-2", kalshi_side: "no" }, settlements), true);
});
