// Unit tests for the MLB pitcher outs-recorded model (Phase 1, shadow-only).
import { test } from "node:test";
import assert from "node:assert";
import { projectOuts, emitMlbOutsPlays } from "./mlb-outs.js";
import { outsTailPct } from "../simulate.js";

test("projectOuts: μ = avgBF × out-rate, out-rate from BAA; σ = 0.90 × stdBF × out-rate", () => {
  // BAA .245 → OBP ≈ .305 → outRate ≈ .695; avgBF 24 → eOuts ≈ 16.7; stdBF 6 (above floor) → σ scaled
  const p = projectOuts({ avgBF: 24, stdBF: 6, baa: 0.245, gs26: 12 });
  assert.ok(p, "should project");
  assert.ok(Math.abs(p.outRate - 0.695) < 0.01, `outRate ${p.outRate}`);
  assert.ok(Math.abs(p.eOuts - 24 * p.outRate) < 0.05, `eOuts ${p.eOuts}`);
  assert.ok(Math.abs(p.sigma - 0.90 * 6 * p.outRate) < 0.05, `sigma ${p.sigma}`);
});

test("projectOuts: falls back to league out-rate when BAA missing", () => {
  const p = projectOuts({ avgBF: 24, stdBF: 5, baa: null, gs26: 12 });
  assert.strictEqual(p.outRate, 0.685);
});

test("projectOuts: out-rate clamped to [0.60, 0.74]", () => {
  const hi = projectOuts({ avgBF: 24, stdBF: 5, baa: 0.180, gs26: 12 }); // would be .76 → clamp .74
  assert.strictEqual(hi.outRate, 0.74);
  const lo = projectOuts({ avgBF: 24, stdBF: 5, baa: 0.380, gs26: 12 }); // would be .56 → clamp .60
  assert.strictEqual(lo.outRate, 0.60);
});

test("projectOuts: σ floor + default (×0.90 scale) when stdBF thin/missing", () => {
  const floored = projectOuts({ avgBF: 24, stdBF: 1, baa: 0.245, gs26: 12 }); // 1×.695 < 3.5 floor → 0.90×3.5
  assert.strictEqual(floored.sigma, 3.15);
  const dflt = projectOuts({ avgBF: 24, stdBF: 0, baa: 0.245, gs26: 12 }); // 0.90×4.5
  assert.strictEqual(dflt.sigma, 4.05);
});

test("projectOuts: null when no workload anchor or too few starts", () => {
  assert.strictEqual(projectOuts({ avgBF: null, stdBF: 5, baa: 0.245, gs26: 12 }), null);
  assert.strictEqual(projectOuts({ avgBF: 24, stdBF: 5, baa: 0.245, gs26: 2 }), null); // < MIN_GS
});

test("outsTailPct: monotone decreasing in threshold, continuity-corrected", () => {
  const mu = 17, sigma = 4.5;
  const p15 = outsTailPct(mu, sigma, 15);
  const p18 = outsTailPct(mu, sigma, 18);
  const p21 = outsTailPct(mu, sigma, 21);
  assert.ok(p15 > p18 && p18 > p21, `monotone: ${p15} ${p18} ${p21}`);
  // threshold at the mean+0.5 ≈ 50%
  assert.ok(Math.abs(outsTailPct(mu, sigma, 17) - 54) < 6, "near-mean ~50%");
  assert.strictEqual(outsTailPct(null, sigma, 15), null);
  assert.strictEqual(outsTailPct(mu, 0, 15), null);
});

test("emitMlbOutsPlays: emits favorite over side with bet-side truePct", () => {
  const outsPlays = [], dropped = [];
  const ctx = {
    outsMarkets: [{
      player: "Kodai Senga", threshold: 15, gameTeam1: "CHC", gameTeam2: "NYM",
      pitcherTeam: "NYM", yesPct: 72, noPct: 30, yesAO: -257, noAO: 233,
      kalshiVolume: 50, gameDate: "2026-06-23",
    }],
    outsPlays, dropped, isDebug: true, cutoffStr: "2026-06-22",
    sportByteam: { mlb: { gameHomeTeams: { NYM: "NYM" }, pitcherStatsByName: { "kodai senga": { avgBF: 25, stdBF: 5, baa: 0.230, gs26: 14 } } } },
  };
  emitMlbOutsPlays(ctx);
  assert.strictEqual(outsPlays.length, 1);
  const pl = outsPlays[0];
  assert.strictEqual(pl.stat, "outs");
  assert.strictEqual(pl.direction, "over");
  assert.strictEqual(pl.kalshiPct, 72);
  assert.strictEqual(pl.homeTeam, "NYM"); // swapped from ticker order via gameHomeTeams
  assert.strictEqual(pl.awayTeam, "CHC");
  assert.ok(pl.truePct > 0 && pl.truePct <= 100);
  assert.strictEqual(pl.edge, parseFloat((pl.truePct - 72).toFixed(1)));
});

test("emitMlbOutsPlays: under favorite → direction under, complement truePct", () => {
  const outsPlays = [], dropped = [];
  emitMlbOutsPlays({
    outsMarkets: [{
      player: "Some Pitcher", threshold: 21, gameTeam1: "SD", gameTeam2: "LAD",
      pitcherTeam: "LAD", yesPct: 18, noPct: 80, yesAO: 455, noAO: -400,
      kalshiVolume: 10, gameDate: "2026-06-23",
    }],
    outsPlays, dropped, isDebug: true, cutoffStr: "2026-06-22",
    sportByteam: { mlb: { pitcherStatsByName: { "some pitcher": { avgBF: 22, stdBF: 4, baa: 0.250, gs26: 10 } } } },
  });
  assert.strictEqual(outsPlays.length, 1);
  assert.strictEqual(outsPlays[0].direction, "under");
  assert.strictEqual(outsPlays[0].kalshiPct, 80);
});

test("emitMlbOutsPlays: skips when neither side in [67,91] + drops unknown pitcher", () => {
  const outsPlays = [], dropped = [];
  emitMlbOutsPlays({
    outsMarkets: [
      { player: "Mid Market", threshold: 17, gameTeam1: "NYY", gameTeam2: "BOS", yesPct: 55, noPct: 47, gameDate: "2026-06-23" },
      { player: "Unknown Guy", threshold: 15, gameTeam1: "NYY", gameTeam2: "BOS", yesPct: 75, noPct: 27, gameDate: "2026-06-23" },
    ],
    outsPlays, dropped, isDebug: true, cutoffStr: "2026-06-22",
    sportByteam: { mlb: { pitcherStatsByName: {} } },
  });
  assert.strictEqual(outsPlays.length, 0);
  assert.ok(dropped.some(d => d.reason === "no_pitcher_data"));
});
