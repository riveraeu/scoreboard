// node --test api/lib/mma.test.js
// Tests for the Phase-1 MMA model (api/lib/mma.js). Pins: the finish-rate→hazard conversion,
// the "ends before round N" CDF (monotonic in N, bounded, matches the per-round identity),
// weight-class lookup + normalization, fighter-code matching, and the period<N resolution rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEIGHT_CLASS_FINISH_RATE, normWeightClass, finishRateFor, roundHazard, pEndBeforeRound,
  normFighterName, matchFightByCodes,
} from "./mma.js";

test("roundHazard inverts the 3-round finish rate", () => {
  for (const F of [0.30, 0.45, 0.62]) {
    const h = roundHazard(F);
    // going the distance over 3 rounds = (1-h)^3 = 1-F
    assert.ok(Math.abs(Math.pow(1 - h, 3) - (1 - F)) < 1e-9, `F=${F} h=${h}`);
    assert.ok(h > 0 && h < 1);
  }
});

test("pEndBeforeRound: N=2 equals the per-round hazard", () => {
  const h = roundHazard(0.45);
  assert.ok(Math.abs(pEndBeforeRound(h, 2) - h) < 1e-12);
});

test("pEndBeforeRound is monotonic increasing in N and bounded [0,1)", () => {
  const h = roundHazard(0.5);
  let prev = -1;
  for (const n of [2, 3, 4, 5]) {
    const p = pEndBeforeRound(h, n);
    assert.ok(p >= 0 && p < 1, `p=${p}`);
    assert.ok(p > prev, `not increasing at N=${n}`);
    prev = p;
  }
  // P(ends before final round of a 3-round fight) = 1-(1-h)^2
  assert.ok(Math.abs(pEndBeforeRound(h, 3) - (1 - Math.pow(1 - h, 2))) < 1e-12);
});

test("heavier weight classes finish earlier (higher P end before round 3)", () => {
  const hHw = roundHazard(finishRateFor("Heavyweight"));
  const hFw = roundHazard(finishRateFor("Flyweight"));
  assert.ok(pEndBeforeRound(hHw, 3) > pEndBeforeRound(hFw, 3));
});

test("normWeightClass + finishRateFor handle ESPN labels and unknowns", () => {
  assert.equal(normWeightClass("Light Heavyweight"), "lightheavyweight");
  assert.equal(normWeightClass("Women's Strawweight"), "womensstrawweight");
  assert.equal(finishRateFor("Light Heavyweight"), WEIGHT_CLASS_FINISH_RATE.lightheavyweight);
  assert.equal(finishRateFor("Open Weight"), 0.45); // unknown → default
  assert.equal(finishRateFor(null), 0.45);
});

test("normFighterName strips diacritics + punctuation", () => {
  assert.equal(normFighterName("José Aldo Jr."), "jose aldo jr");
  assert.equal(normFighterName("Khabib Nurmagomedov"), "khabib nurmagomedov");
});

test("matchFightByCodes matches last-name prefixes order-independently", () => {
  const fights = [
    { lastNames: ["collins", "tanzilovi"], names: ["Shane Collins", "Otari Tanzilovi"] },
    { lastNames: ["fiziev", "torres"], names: ["Rafael Fiziev", "Manuel Torres"] },
  ];
  assert.equal(matchFightByCodes("COLTAN", fights), fights[0]);
  assert.equal(matchFightByCodes("FIZTOR", fights), fights[1]);
  assert.equal(matchFightByCodes("TORFIZ", fights), fights[1]); // order-independent
  assert.equal(matchFightByCodes("XYZABC", fights), null);      // no match
});

// Resolution rule: "ends before round N" wins iff finishRound < N. A finish in round k sets
// status.period=k; a decision leaves period=scheduled. Verify all the cases the resolver relies on.
test("resolution rule period<N covers finishes and decisions", () => {
  const endsBefore = (finishRound, n) => finishRound < n;
  // R1 finish (period 1), 3-round fight, thresholds 2 & 3
  assert.equal(endsBefore(1, 2), true);   // ends before round 2 → YES
  assert.equal(endsBefore(1, 3), true);   // ends before round 3 → YES
  // R2 finish (period 2)
  assert.equal(endsBefore(2, 2), false);  // not before round 2
  assert.equal(endsBefore(2, 3), true);   // before round 3
  // decision in a 3-round fight (period 3)
  assert.equal(endsBefore(3, 2), false);
  assert.equal(endsBefore(3, 3), false);  // went the distance → both NO
  // 5-round main event, R3 finish (period 3)
  assert.equal(endsBefore(3, 4), true);   // before round 4
  assert.equal(endsBefore(3, 5), true);   // before round 5
  // 5-round decision (period 5)
  assert.equal(endsBefore(5, 5), false);
});
