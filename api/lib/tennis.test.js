// node --test api/lib/tennis.test.js
// Tests for the Phase-1 tennis model + name matching (api/lib/tennis.js).
// Pins: logistic symmetry/monotonicity, ranking-points → rating transform, and the
// full-name / last-name / ambiguous / diacritic behavior of the rating index.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normTennisName, ratingFromPoints, tennisMatchProb, buildRatingIndex, lookupRating,
} from "./tennis.js";

test("normTennisName strips diacritics, case, punctuation", () => {
  assert.equal(normTennisName("Stéfanos Tsitsipás"), "stefanos tsitsipas");
  assert.equal(normTennisName("J.J. Wolf"), "j j wolf");
  assert.equal(normTennisName("  Félix   Auger-Aliassime "), "felix auger aliassime");
});

test("ratingFromPoints is monotonic increasing and floors at 1 point", () => {
  assert.ok(ratingFromPoints(8000) > ratingFromPoints(2000));
  assert.equal(ratingFromPoints(0), ratingFromPoints(1)); // floor → log10(1)=0
  assert.equal(ratingFromPoints(1), 0);
});

test("tennisMatchProb: equal ratings → 0.5, complementary, favorite > 0.5", () => {
  assert.equal(tennisMatchProb(1000, 1000), 0.5);
  const p = tennisMatchProb(1200, 800);
  assert.ok(p > 0.5);
  assert.ok(Math.abs(tennisMatchProb(800, 1200) + p - 1) < 1e-9); // complementary
});

test("model collapses to points-ratio: P(A) = ptsA/(ptsA+ptsB)", () => {
  const a = 4000, b = 1500;
  const p = tennisMatchProb(ratingFromPoints(a), ratingFromPoints(b));
  assert.ok(Math.abs(p - a / (a + b)) < 1e-9);
});

const RANKINGS = {
  rankings: [{
    ranks: [
      { current: 1, points: 11000, athlete: { displayName: "Jannik Sinner", lastName: "Sinner" } },
      { current: 2, points: 9000,  athlete: { displayName: "Carlos Alcaraz", lastName: "Alcaraz" } },
      { current: 50, points: 1000, athlete: { displayName: "Marcos Giron", lastName: "Giron" } },
      { current: 80, points: 700,  athlete: { displayName: "Rinky Hijikata", lastName: "Hijikata" } },
      // last-name collision: two different "Williams" → byLast must mark ambiguous
      { current: 90, points: 600,  athlete: { displayName: "Reilly Williams", lastName: "Williams" } },
      { current: 95, points: 550,  athlete: { displayName: "Sloane Williams", lastName: "Williams" } },
      // unranked-style 0 points row is ignored
      { current: 999, points: 0,   athlete: { displayName: "Nobody Ranked", lastName: "Ranked" } },
    ],
  }],
};

test("buildRatingIndex + lookupRating: full-name match", () => {
  const idx = buildRatingIndex(RANKINGS);
  const rec = lookupRating(idx, "Jannik Sinner");
  assert.equal(rec.points, 11000);
  assert.ok(rec.rating > 0);
});

test("lookupRating: unambiguous last-name fallback (M. Giron → Marcos Giron)", () => {
  const idx = buildRatingIndex(RANKINGS);
  assert.equal(lookupRating(idx, "M. Giron").name, "Marcos Giron");
  assert.equal(lookupRating(idx, "Giron").name, "Marcos Giron");
});

test("lookupRating: ambiguous last name returns null (forces full-name match)", () => {
  const idx = buildRatingIndex(RANKINGS);
  assert.equal(lookupRating(idx, "Williams"), null);
  // but the full name still resolves
  assert.equal(lookupRating(idx, "Sloane Williams").points, 550);
});

test("lookupRating: zero-point rows excluded; unknown returns null", () => {
  const idx = buildRatingIndex(RANKINGS);
  assert.equal(lookupRating(idx, "Nobody Ranked"), null);
  assert.equal(lookupRating(idx, "Someone Else"), null);
});

test("lookupRating tolerates diacritics in the query", () => {
  const idx = buildRatingIndex({
    rankings: [{ ranks: [{ current: 3, points: 5000, athlete: { displayName: "Stefanos Tsitsipas", lastName: "Tsitsipas" } }] }],
  });
  assert.equal(lookupRating(idx, "Stéfanos Tsitsipás").points, 5000);
});
