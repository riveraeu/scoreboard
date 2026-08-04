// Unit tests for tennis name-norm + schedule parsing (model-free survivors of tennis.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normTennisName } from "./tennis-schedule.js";

test("normTennisName strips diacritics, case, punctuation", () => {
  assert.equal(normTennisName("Stéfanos Tsitsipás"), "stefanos tsitsipas");
  assert.equal(normTennisName("J.J. Wolf"), "j j wolf");
  assert.equal(normTennisName("  Félix   Auger-Aliassime "), "felix auger aliassime");
  assert.equal(normTennisName(""), "");
  assert.equal(normTennisName(null), "");
});
