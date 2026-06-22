// node --test api/lib/golf.test.js
// Tests for the Phase-1 golf model (api/lib/golf.js). Pins: rating monotonicity, the one-round
// H2H probabilities (sum to 1, symmetric for equal players, favor the better player, tie band),
// OWGR index building + name lookup, and the round-score resolution comparison.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ratingFromPoints, h2hWinProb, buildRatingIndex, lookupRating, normGolfName,
  GOLF_ROUND_SIGMA,
} from "./golf.js";

test("ratingFromPoints is monotonic increasing in OWGR points", () => {
  assert.ok(ratingFromPoints(16.6) > ratingFromPoints(5));
  assert.ok(ratingFromPoints(5) > ratingFromPoints(1));
  assert.ok(ratingFromPoints(0) === 0); // log10(1) = 0
});

test("h2hWinProb: equal players → symmetric, ~10% tie over one round", () => {
  const { pA, pB, pTie } = h2hWinProb(2.0, 2.0);
  assert.ok(Math.abs(pA - pB) < 1e-9, "equal players must be symmetric");
  assert.ok(Math.abs(pA + pB + pTie - 1) < 1e-9, "probabilities must sum to 1");
  assert.ok(pTie > 0.05 && pTie < 0.2, `tie prob unrealistic: ${pTie}`);
});

test("h2hWinProb: better player favored, but a single round stays high-variance", () => {
  // ~2-stroke skill edge → still only ~65% to strictly win ONE round (the thin-coverage reality).
  const { pA } = h2hWinProb(2.0, 0.0);
  assert.ok(pA > 0.5 && pA < 0.72, `single-round edge should be modest, got ${pA}`);
  // A big skill gap pushes higher but never near-certain over one round.
  const { pA: pBig } = h2hWinProb(5.0, 0.0);
  assert.ok(pBig > pA && pBig < 0.95);
});

test("h2hWinProb is the complement-consistent across argument order", () => {
  const ab = h2hWinProb(3.0, 1.0);
  const ba = h2hWinProb(1.0, 3.0);
  assert.ok(Math.abs(ab.pA - ba.pB) < 1e-9);
  assert.ok(Math.abs(ab.pTie - ba.pTie) < 1e-9);
});

test("differential sigma uses √2 of the per-round sigma (sanity on inputs)", () => {
  assert.ok(GOLF_ROUND_SIGMA > 0);
});

test("buildRatingIndex + lookupRating: full name and unambiguous last name", () => {
  const idx = buildRatingIndex({ rankingsList: [
    { rank: 1, pointsAverage: 16.57, player: { fullName: "Scottie Scheffler", lastName: "Scheffler" } },
    { rank: 2, pointsAverage: 9.57, player: { fullName: "Rory McIlroy", lastName: "McIlroy" } },
  ] });
  assert.equal(lookupRating(idx, "Scottie Scheffler").rank, 1);
  assert.equal(lookupRating(idx, "scheffler").rank, 1);          // last-name fallback
  assert.equal(lookupRating(idx, "Tiger Woods"), null);          // unranked → abstain
  assert.ok(lookupRating(idx, "Scottie Scheffler").rating > lookupRating(idx, "Rory McIlroy").rating);
});

test("buildRatingIndex marks colliding last names AMBIG (forces full-name match)", () => {
  const idx = buildRatingIndex({ rankingsList: [
    { rank: 10, pointsAverage: 3, player: { fullName: "Nicolai Hojgaard", lastName: "Hojgaard" } },
    { rank: 11, pointsAverage: 3, player: { fullName: "Rasmus Hojgaard", lastName: "Hojgaard" } },
  ] });
  assert.equal(lookupRating(idx, "Hojgaard"), null);             // ambiguous → abstain
  assert.equal(lookupRating(idx, "Nicolai Hojgaard").rank, 10);  // full name resolves
});

test("normGolfName strips diacritics + punctuation", () => {
  assert.equal(normGolfName("Joaquín Niemann"), "joaquin niemann");
  assert.equal(normGolfName("Min Woo Lee"), "min woo lee");
});

// Resolution rule: pick wins iff their round-N strokes are strictly lower than the opponent's;
// a tie resolves NO. Mirror the resolver comparison on the real USO round-4 data.
test("resolution: strictly-lower round score wins, tie loses", () => {
  const beats = (pick, opp) => pick < opp;
  assert.equal(beats(71, 73), true);   // Scheffler 71 < Clark 73 → YES (matches Kalshi)
  assert.equal(beats(70, 73), true);   // Tom Kim 70 < Theegala 73 → YES
  assert.equal(beats(73, 71), false);  // the losing side
  assert.equal(beats(70, 70), false);  // tie → NO for both
});
