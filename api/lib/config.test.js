// Pins the capture-vs-bet-window contract (2026-06-29 de-blinding). The capture (shadow-logging)
// band MUST be strictly wider than the bet window on both ends — that's the whole point: log the
// full favorite curve so the bet window can be derived from calibration instead of assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KALSHI_GATE, KALSHI_CAP, CAPTURE_GATE, CAPTURE_CAP } from "./config.js";

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
