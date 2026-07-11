// Pins the capture-vs-bet-window contract (2026-06-29 de-blinding). The capture (shadow-logging)
// band MUST be strictly wider than the bet window on both ends — that's the whole point: log the
// full favorite curve so the bet window can be derived from calibration instead of assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KALSHI_GATE, KALSHI_CAP, CAPTURE_GATE, CAPTURE_CAP, CAPTURE_MAX_SPREAD, capturableSpread, CATEGORY_BET_WINDOWS, betWindowFor } from "./config.js";

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

test("betWindowFor defaults to the global [KALSHI_GATE, KALSHI_CAP] for any unset category", () => {
  assert.deepEqual(betWindowFor("mlb", "totalBases"), [KALSHI_GATE, KALSHI_CAP]);
  assert.deepEqual(betWindowFor("nba", "points"), [KALSHI_GATE, KALSHI_CAP]);
  assert.deepEqual(betWindowFor("anything", "unknown"), [KALSHI_GATE, KALSHI_CAP]);
});

test("CATEGORY_BET_WINDOWS active entries are all valid [lo, hi] windows within capture bounds", () => {
  // 2026-07-11: mlb|hrr added as provisional NO-side window [24,33] — not empty any more.
  // Each entry must be a valid shape (lo < hi, both within [CAPTURE_GATE, CAPTURE_CAP]).
  for (const [key, w] of Object.entries(CATEGORY_BET_WINDOWS)) {
    assert.ok(Array.isArray(w) && w.length === 2, `${key}: window must be [lo, hi]`);
    assert.ok(Number.isFinite(w[0]) && Number.isFinite(w[1]), `${key}: bounds must be finite`);
    assert.ok(w[0] < w[1], `${key}: lo must be < hi`);
    assert.ok(w[0] >= CAPTURE_GATE, `${key}: lo must be >= CAPTURE_GATE`);
    assert.ok(w[1] <= CAPTURE_CAP, `${key}: hi must be <= CAPTURE_CAP`);
  }
  // mlb|hrr NO-side window (2026-07-11) is the current live entry.
  assert.deepEqual(CATEGORY_BET_WINDOWS["mlb|hrr"], [24, 33]);
});

test("betWindowFor honors a set window but only within [CAPTURE_GATE, CAPTURE_CAP], else falls back", () => {
  // Simulate a validated override (mutate a copy of the semantics via a temporary key).
  const probe = (sport, stat, w) => {
    CATEGORY_BET_WINDOWS[`${sport}|${stat}`] = w;
    try { return betWindowFor(sport, stat); } finally { delete CATEGORY_BET_WINDOWS[`${sport}|${stat}`]; }
  };
  // Valid, inside capture bounds → respected. [40, 55] is the f5ml-shaped case the old
  // [55,97] capture floor made unshippable (full-curve capture 2026-07-03 unblocked it).
  assert.deepEqual(probe("mlb", "totalBases", [88, 97]), [88, 97]);
  assert.deepEqual(probe("mlb", "f5ml", [40, 55]), [40, 55]);
  assert.deepEqual(probe("mlb", "totalBases", [CAPTURE_GATE, CAPTURE_CAP]), [CAPTURE_GATE, CAPTURE_CAP]);
  // Out of capture bounds → rejected, falls back to global.
  assert.deepEqual(probe("mlb", "totalBases", [0, 97]), [KALSHI_GATE, KALSHI_CAP]);    // lo below CAPTURE_GATE
  assert.deepEqual(probe("mlb", "totalBases", [88, 100]), [KALSHI_GATE, KALSHI_CAP]);  // hi above CAPTURE_CAP
  // Malformed → falls back.
  assert.deepEqual(probe("mlb", "totalBases", [90, 90]), [KALSHI_GATE, KALSHI_CAP]);   // lo !< hi
  assert.deepEqual(probe("mlb", "totalBases", [97, 88]), [KALSHI_GATE, KALSHI_CAP]);   // inverted
  assert.deepEqual(probe("mlb", "totalBases", [88]), [KALSHI_GATE, KALSHI_CAP]);       // wrong length
  assert.deepEqual(probe("mlb", "totalBases", "88-97"), [KALSHI_GATE, KALSHI_CAP]);    // not an array
});
