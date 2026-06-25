// node --test api/lib/soccer.test.js
// Tests for the Phase-1 soccer model (api/lib/soccer.js). Pins: the score matrix is a valid
// probability distribution, 1X2 sums to 1, monotonicity of each market projection, the
// Elo→λ supremacy split, Elo TSV parsing, and the ESPN→canonical team mapping.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lambdasFromElo, buildScoreMatrix, prob1x2, probTotalOver, probTeamOver,
  probSpreadCover, probBtts, parseEloTsv, eloForTeam, espnToCanonical,
  advanceProb, SOCCER_MU_TOTAL, WC_ADVANCE_ET_SHRINK, WC_TEAMS,
} from "./soccer.js";

const sum = (M) => M.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);

test("buildScoreMatrix is a normalized distribution (sums to 1)", () => {
  for (const [lh, la] of [[1.35, 1.35], [2.1, 0.6], [0.9, 1.8]]) {
    const M = buildScoreMatrix(lh, la);
    assert.ok(Math.abs(sum(M) - 1) < 1e-9, `sum=${sum(M)}`);
    for (const row of M) for (const v of row) assert.ok(v >= 0);
  }
});

test("prob1x2 sums to 1; equal λ → symmetric home/away", () => {
  const M = buildScoreMatrix(1.35, 1.35);
  const { home, draw, away } = prob1x2(M);
  assert.ok(Math.abs(home + draw + away - 1) < 1e-9);
  assert.ok(Math.abs(home - away) < 1e-9); // symmetric matchup
  assert.ok(draw > 0.2 && draw < 0.35);    // sane WC draw mass
});

test("prob1x2: stronger home team → higher P(home), lower P(away)", () => {
  const even = prob1x2(buildScoreMatrix(1.35, 1.35));
  const fav = prob1x2(buildScoreMatrix(2.0, 0.8));
  assert.ok(fav.home > even.home);
  assert.ok(fav.away < even.away);
});

test("probTotalOver is monotonic decreasing in the line", () => {
  const M = buildScoreMatrix(1.6, 1.1);
  const o15 = probTotalOver(M, 1.5), o25 = probTotalOver(M, 2.5), o35 = probTotalOver(M, 3.5);
  assert.ok(o15 > o25 && o25 > o35);
  assert.ok(o15 > 0 && o15 < 1);
});

test("probTeamOver respects the home/away axis", () => {
  const M = buildScoreMatrix(2.2, 0.7); // strong home, weak away
  assert.ok(probTeamOver(M, 1.5, true) > probTeamOver(M, 1.5, false)); // home scores more
  assert.ok(probTeamOver(M, 0.5, true) > probTeamOver(M, 1.5, true));  // lower line → higher
});

test("probSpreadCover: favorite covers less as the handicap grows; sign follows favIsHome", () => {
  const M = buildScoreMatrix(2.1, 0.7);
  assert.ok(probSpreadCover(M, 0.5, true) > probSpreadCover(M, 1.5, true));
  assert.ok(probSpreadCover(M, 1.5, true) > probSpreadCover(M, 1.5, false)); // home is the favorite
});

test("probBtts in (0,1) and rises with both λ", () => {
  const low = probBtts(buildScoreMatrix(0.8, 0.8));
  const high = probBtts(buildScoreMatrix(1.8, 1.8));
  assert.ok(high > low);
  assert.ok(low > 0 && high < 1);
});

test("lambdasFromElo: equal Elo → equal λ summing to μ_total; supremacy splits", () => {
  const eq = lambdasFromElo(1800, 1800);
  assert.ok(Math.abs(eq.lambdaHome - eq.lambdaAway) < 1e-9);
  assert.ok(Math.abs(eq.lambdaHome + eq.lambdaAway - SOCCER_MU_TOTAL) < 1e-9);
  const fav = lambdasFromElo(2000, 1700);
  assert.ok(fav.lambdaHome > fav.lambdaAway);
  assert.ok(Math.abs(fav.lambdaHome + fav.lambdaAway - SOCCER_MU_TOTAL) < 1e-9); // split preserves total
});

test("model 1X2 win-expectancy tracks the Elo formula (anchor for C=160)", () => {
  // We_model = P(home)+0.5·P(draw) should ≈ Elo We = 1/(10^(-Δ/400)+1) within ~0.02.
  for (const dr of [50, 100, 150, 200]) {
    const { lambdaHome, lambdaAway } = lambdasFromElo(1800 + dr, 1800);
    const { home, draw } = prob1x2(buildScoreMatrix(lambdaHome, lambdaAway));
    const weModel = home + 0.5 * draw;
    const weElo = 1 / (10 ** (-dr / 400) + 1);
    assert.ok(Math.abs(weModel - weElo) < 0.02, `dr=${dr} model=${weModel.toFixed(3)} elo=${weElo.toFixed(3)}`);
  }
});

test("parseEloTsv + eloForTeam: pull a rating by canonical code", () => {
  const tsv = "1\t1\tES\t2129\textra\n2\t1\tAR\t2128\textra\n3\t1\tIR\t1756\textra\n";
  const idx = parseEloTsv(tsv);
  assert.equal(idx.ES, 2129);
  assert.equal(eloForTeam(idx, "ESP"), 2129); // ESP → elo code ES
  assert.equal(eloForTeam(idx, "IRI"), 1756); // IRI → IR
  assert.equal(eloForTeam(idx, "USA"), null);  // not in this TSV
});

test("WC_TEAMS elo codes are distinct and pin the non-ISO home-nation codes", () => {
  // Guard against the SC=Seychelles trap: an elo code can EXIST in the TSV yet be the wrong
  // nation. England/Scotland use eloratings-specific codes, not ISO-3166 alpha-2.
  assert.equal(WC_TEAMS.ENG.elo, "EN");
  assert.equal(WC_TEAMS.SCO.elo, "SQ"); // NOT "SC" (Seychelles)
  const elos = Object.values(WC_TEAMS).map((t) => t.elo);
  assert.equal(new Set(elos).size, elos.length, "elo codes must be unique (no two teams share one)");
  assert.equal(Object.keys(WC_TEAMS).length, 48);
});

test("advanceProb: even tie + shutout-draw fallback both resolve to 0.5", () => {
  // Symmetric regulation odds → exactly a coin flip regardless of k.
  assert.ok(Math.abs(advanceProb(0.3, 0.4, 0.3) - 0.5) < 1e-12);
  // Both teams scoreless in regulation → winShare falls back to 0.5 → coin flip.
  assert.ok(Math.abs(advanceProb(0, 1, 0) - 0.5) < 1e-12);
});

test("advanceProb: favorite gets a shrunk share of the draw mass, bounded by win90 and pWin+pDraw", () => {
  const pWin = 0.5, pDraw = 0.3, pLoss = 0.2;
  const adv = advanceProb(pWin, pDraw, pLoss);
  // Advancing prob exceeds the 90' win prob (draw mass tilts the favorite's way)…
  assert.ok(adv > pWin);
  // …but never claims the whole draw mass (k<1 shrinks toward a coin flip).
  assert.ok(adv < pWin + pDraw);
  // Closed form: winShare=.5/.7, w=.5+.5·(winShare−.5), adv=pWin+pDraw·w.
  const winShare = pWin / (pWin + pLoss);
  const w = 0.5 + WC_ADVANCE_ET_SHRINK * (winShare - 0.5);
  assert.ok(Math.abs(adv - (pWin + pDraw * w)) < 1e-12);
});

test("advanceProb: k=1 hands the full draw split by win-share; k=0 splits it evenly", () => {
  const pWin = 0.5, pDraw = 0.3, pLoss = 0.2;
  const winShare = pWin / (pWin + pLoss);
  assert.ok(Math.abs(advanceProb(pWin, pDraw, pLoss, 1) - (pWin + pDraw * winShare)) < 1e-12);
  assert.ok(Math.abs(advanceProb(pWin, pDraw, pLoss, 0) - (pWin + pDraw * 0.5)) < 1e-12);
});

test("espnToCanonical: abbr passthrough, overrides, and name fallback", () => {
  assert.equal(espnToCanonical("BEL", "Belgium"), "BEL");      // direct
  assert.equal(espnToCanonical("ALG", "Algeria"), "DZA");      // override
  assert.equal(espnToCanonical("IRN", "Iran"), "IRI");         // override
  assert.equal(espnToCanonical("HAI", "Haiti"), "HTI");        // override
  assert.equal(espnToCanonical("XXX", "South Korea"), "KOR");  // name fallback
  assert.equal(espnToCanonical("1B", "Group B Winner"), null); // bracket placeholder → no match
});
