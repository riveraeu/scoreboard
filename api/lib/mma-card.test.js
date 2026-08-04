// Unit tests for UFC card identity helpers (model-free survivors of mma.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normFighterName, matchFightByCodes } from "./mma-card.js";

test("normFighterName strips diacritics + punctuation", () => {
  assert.equal(normFighterName("José Aldo Jr."), "jose aldo jr");
  assert.equal(normFighterName("Khabib Nurmagomedov"), "khabib nurmagomedov");
  assert.equal(normFighterName(""), "");
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
  assert.equal(matchFightByCodes("", fights), null);
});
