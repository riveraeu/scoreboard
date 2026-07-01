// Pins the capture-vs-bet-window contract (2026-06-29 de-blinding). The capture (shadow-logging)
// band MUST be strictly wider than the bet window on both ends — that's the whole point: log the
// full favorite curve so the bet window can be derived from calibration instead of assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KALSHI_GATE, KALSHI_CAP, CAPTURE_GATE, CAPTURE_CAP, CAPTURE_MAX_SPREAD, capturableSpread } from "./config.js";

test("capture band is strictly wider than the bet window on both ends", () => {
  assert.ok(CAPTURE_GATE < KALSHI_GATE, `CAPTURE_GATE (${CAPTURE_GATE}) must be below KALSHI_GATE (${KALSHI_GATE})`);
  assert.ok(CAPTURE_CAP > KALSHI_CAP, `CAPTURE_CAP (${CAPTURE_CAP}) must be above KALSHI_CAP (${KALSHI_CAP})`);
});

test("all four price bounds are sane percentages in (0,100)", () => {
  for (const v of [KALSHI_GATE, KALSHI_CAP, CAPTURE_GATE, CAPTURE_CAP]) {
    assert.ok(Number.isFinite(v) && v > 0 && v < 100, `bound ${v} out of range`);
  }
  assert.ok(KALSHI_GATE < KALSHI_CAP);
  assert.ok(CAPTURE_GATE < CAPTURE_CAP);
});

test("CAPTURE_MAX_SPREAD is a positive int well above real spreads, below the ~94¢ artifact", () => {
  assert.ok(Number.isInteger(CAPTURE_MAX_SPREAD) && CAPTURE_MAX_SPREAD > 0, "must be a positive int");
  assert.ok(CAPTURE_MAX_SPREAD >= 8 && CAPTURE_MAX_SPREAD < 90,
    `CAPTURE_MAX_SPREAD (${CAPTURE_MAX_SPREAD}) must clear real ≤7¢ spreads and reject the ~94¢ artifact`);
});

test("capturableSpread keeps real two-sided books, rejects lone-quote artifacts", () => {
  // Real favorites (France live 6/30): tight bet-side spreads.
  assert.equal(capturableSpread(4), true);   // yesAsk .44 / yesBid .40
  assert.equal(capturableSpread(7), true);   // thinnest real rung
  assert.equal(capturableSpread(8), true);   // cheap ask, empty bid — still tradeable, keep
  // The 94¢ artifact: lone NO quote implies yes_ask=94 with no yes bid.
  assert.equal(capturableSpread(94), false);
  // No ask on the side → sentinel 999 → never capture.
  assert.equal(capturableSpread(999), false);
  assert.equal(capturableSpread(null), false);
});
