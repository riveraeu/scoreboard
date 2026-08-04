// Pins the capture contract. Post-teardown (2026-08-04) the bet-window tunables (KALSHI_GATE /
// KALSHI_CAP / EDGE_GATE_SERVER / CATEGORY_BET_WINDOWS / betWindowFor) are gone — capture is now
// model-free capture-all, gated only by the CAPTURE band + the liquidity check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAPTURE_GATE, CAPTURE_CAP, CAPTURE_MAX_SPREAD, capturableSpread, AWAITING_VALIDATED_EDGE } from "./config.js";

test("capture band bounds are sane percentages in (0,100)", () => {
  for (const v of [CAPTURE_GATE, CAPTURE_CAP]) {
    assert.ok(Number.isFinite(v) && v > 0 && v < 100, `bound ${v} out of range`);
  }
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

test("AWAITING_VALIDATED_EDGE is a single shared flag, and it is ON", () => {
  // Mirrors maker-live.test.js pinning SHELVED: the closure is a deliberate state, so a silent
  // flip should fail a test rather than quietly re-open five closed programs.
  assert.strictEqual(typeof AWAITING_VALIDATED_EDGE, "boolean");
  assert.strictEqual(AWAITING_VALIDATED_EDGE, true,
    "flipping this resumes prescriptive prompting — read docs/REENTRY.md first");
});

test("AWAITING_VALIDATED_EDGE is never re-declared locally in the codebase", () => {
  // Guards against a past bug (2026-07-29) where a local re-declaration in MakerBoardPage.jsx
  // caused the UI and the brief to disagree silently. A future consumer should always import
  // from config.js rather than re-declare.
  const root = new URL("../../", import.meta.url);
  for (const rel of ["src/components/MakerBoardPage.jsx", "api/lib/handlers/shadow.js"]) {
    const src = readFileSync(new URL(rel, root), "utf8");
    assert.ok(!/^\s*(const|let|var)\s+AWAITING_VALIDATED_EDGE\s*=/m.test(src),
      `${rel} re-declares AWAITING_VALIDATED_EDGE locally — import from config.js instead`);
  }
});
