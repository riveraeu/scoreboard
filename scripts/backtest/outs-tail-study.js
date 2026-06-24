#!/usr/bin/env node
// Historical starter OUTS-RECORDED distribution study.  Does the Phase-1 plain-Normal model
// (outs ~ Normal(avgBF×outRate, stdBF×outRate)) actually fit the per-start outs distribution —
// and in particular, does it understate the LEFT tail (the early-hook / shelled-in-the-2nd
// blowup) the way the CLAUDE.md comment warns?  NO price data needed.
//
//   *** This is an ACCURACY / CALIBRATION test, not an edge test. ***
// It answers "is the Normal shape right, especially the downside" — a model-honesty check that's
// fully backtestable from history (IP is exactly reconstructable), unlike market edge.  A clean
// Normal fit ⇒ ship v1 as-is; a fat left tail ⇒ quantify the early-exit mass to add (Phase 1.5).
//
// Method: per starter (≥ MIN_STARTS), build the model params the live code would use from that
// pitcher's OWN season (avgBF, stdBF, out-rate = totalOuts/totalBF — the empirical truth of the
// 1−OBP quantity), then standardize each start's outs by the model's (μ,σ) and pool z across all
// pitcher-starts.  If outs ~ Normal(μ,σ): pooled z ~ N(0,1), symmetric, 2.3% below −2.  Excess
// mass below −2 + negative skew = the understated left tail.
//
// Usage:  node scripts/backtest/outs-tail-study.js [--start 2025-04-01] [--end 2025-06-30]
// Sources: MLB statsapi (schedule + boxscores, no key).

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const START = arg("--start", "2025-04-01");
const END   = arg("--end",   "2025-06-30");
const MIN_STARTS = 5;     // need a few starts to estimate that pitcher's μ,σ
const SIGMA_FLOOR = 3.5;  // mirror api/lib/tonight/mlb-outs.js
const SIGMA_DEFAULT = 4.5;

const _get = (url) => fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
  .then(r => r.ok ? r.json() : null).catch(() => null);

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

// "5.2" (5⅔ IP) → 17 outs
function ipToOuts(ip) {
  const v = parseFloat(ip);
  if (!Number.isFinite(v) || v <= 0) return null;
  const whole = Math.trunc(v);
  const frac = Math.round((v - whole) * 10); // .0/.1/.2 → 0/1/2
  return whole * 3 + frac;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const normCDF = (x) => { const z = x / Math.SQRT2; const t = 1 / (1 + 0.3275911 * Math.abs(z)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z); return 0.5 * (1 + (z >= 0 ? y : -y)); };

async function main() {
  // 1. Schedule → Final game pks.
  console.log(`Fetching schedule ${START} … ${END} …`);
  const sched = await _get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${START}&endDate=${END}`);
  const gamePks = [];
  for (const d of (sched?.dates || []))
    for (const g of (d.games || []))
      if (g.status?.abstractGameState === "Final" && g.gameType === "R") gamePks.push(g.gamePk);
  if (!gamePks.length) { console.log("No Final regular-season games in range."); return; }
  console.log(`${gamePks.length} Final games → fetching boxscores …`);

  // 2. Boxscores → each STARTER's (outs, BF) for that game. Starter = teams[side].pitchers[0].
  const byPitcher = new Map(); // id → { name, starts:[{outs, bf}] }
  let done = 0;
  await pool(gamePks, 10, async (pk) => {
    const j = await _get(`https://statsapi.mlb.com/api/v1/game/${pk}/boxscore`);
    if (++done % 200 === 0) console.log(`  …${done}/${gamePks.length}`);
    if (!j?.teams) return;
    for (const side of ["home", "away"]) {
      const t = j.teams[side];
      const starterId = t?.pitchers?.[0];
      if (!starterId) continue;
      const pl = t.players?.[`ID${starterId}`];
      const p = pl?.stats?.pitching;
      if (!p || p.gamesStarted !== 1) continue; // confirm this was a start
      const outs = ipToOuts(p.inningsPitched);
      const bf = p.battersFaced ?? null;
      if (outs == null || !(bf > 0)) continue;
      if (!byPitcher.has(starterId)) byPitcher.set(starterId, { name: pl.person?.fullName || String(starterId), starts: [] });
      byPitcher.get(starterId).starts.push({ outs, bf });
    }
  });

  // 3. Per pitcher → model params (mirror projectOuts), then pooled standardized residuals.
  const z = [];          // standardized residuals across all qualifying starts
  let nPitchers = 0, nStarts = 0;
  const tailRows = [];   // for per-threshold calibration: {predOver, hit}
  for (const { starts } of byPitcher.values()) {
    if (starts.length < MIN_STARTS) continue;
    const outsArr = starts.map(s => s.outs);
    const bfArr = starts.map(s => s.bf);
    const totalOuts = outsArr.reduce((s, x) => s + x, 0);
    const totalBF = bfArr.reduce((s, x) => s + x, 0);
    const outRate = totalOuts / totalBF;            // empirical 1−OBP
    const avgBF = mean(bfArr);
    const stdBF = std(bfArr);
    const mu = avgBF * outRate;
    const sigma = stdBF > 0 ? Math.max(stdBF * outRate, SIGMA_FLOOR) : SIGMA_DEFAULT;
    nPitchers++;
    for (const o of outsArr) {
      z.push((o - mu) / sigma);
      nStarts++;
      // tail calibration at integer thresholds spanning the pitcher's range
      for (let N = Math.round(mu) - 6; N <= Math.round(mu) + 6; N++) {
        const predOver = 1 - normCDF((N - 0.5 - mu) / sigma);
        if (predOver > 0.02 && predOver < 0.98) tailRows.push({ predOver, hit: o >= N ? 1 : 0 });
      }
    }
  }

  if (nStarts < 100) { console.log(`Only ${nStarts} qualifying starts — widen the window.`); return; }

  // 4. Pooled-z diagnostics.
  const mz = mean(z), sz = std(z);
  const skew = mean(z.map(v => ((v - mz) / sz) ** 3));
  const frac = (pred) => z.filter(pred).length / z.length;
  const belowM2 = frac(v => v <= -2), belowM1 = frac(v => v <= -1);
  const aboveP1 = frac(v => v >= 1), aboveP2 = frac(v => v >= 2);

  console.log(`\n=== Starter outs-recorded distribution study   ${START} … ${END} ===`);
  console.log(`${nPitchers} starters (≥${MIN_STARTS} starts), ${nStarts} starts pooled\n`);
  console.log(`Pooled standardized residual z = (outs − μ_model)/σ_model:`);
  console.log(`  mean ${mz.toFixed(3)} (Normal 0)   std ${sz.toFixed(3)} (Normal 1)   skew ${skew.toFixed(3)} (Normal 0)`);
  console.log(`  P(z ≤ −2) ${(belowM2 * 100).toFixed(1)}%  vs Normal 2.3%   ← LEFT tail (blowups)`);
  console.log(`  P(z ≤ −1) ${(belowM1 * 100).toFixed(1)}%  vs Normal 15.9%`);
  console.log(`  P(z ≥ +1) ${(aboveP1 * 100).toFixed(1)}%  vs Normal 15.9%`);
  console.log(`  P(z ≥ +2) ${(aboveP2 * 100).toFixed(1)}%  vs Normal 2.3%   ← RIGHT tail (complete-game)`);

  // 5. Tail calibration (reliability) — model P(outs≥N) vs actual, in deciles.
  console.log(`\nTail calibration  (model P(outs≥N) vs actual, ${tailRows.length} pitcher×threshold points):`);
  const edges = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  let lo = 0;
  for (const hi of edges) {
    const g = tailRows.filter(r => r.predOver > lo && r.predOver <= hi);
    if (g.length >= 20) {
      const pred = mean(g.map(r => r.predOver)), act = mean(g.map(r => r.hit));
      const flag = Math.abs(pred - act) > 0.05 ? (act < pred ? "  ← model OVER-predicts" : "  ← model UNDER-predicts") : "";
      console.log(`  ${(lo * 100).toFixed(0).padStart(3)}–${(hi * 100).toFixed(0).padStart(3)}%  n=${String(g.length).padStart(5)}  pred ${(pred * 100).toFixed(1)}%  act ${(act * 100).toFixed(1)}%${flag}`);
    }
    lo = hi;
  }

  // 6. Verdict.
  const fatLeft = belowM2 > 0.035 && skew < -0.25;
  console.log(`\nVERDICT: ${fatLeft
    ? `FAT LEFT TAIL — Normal understates blowups (${(belowM2 * 100).toFixed(1)}% vs 2.3%, skew ${skew.toFixed(2)}). `
      + `Add an early-exit mass / left-skew in Phase 1.5; the excess below −2σ ≈ ${((belowM2 - 0.023) * 100).toFixed(1)}pts is the mass to relocate.`
    : `LEFT TAIL ~ NORMAL (z≤−2 ${(belowM2 * 100).toFixed(1)}% vs 2.3%, skew ${skew.toFixed(2)}). `
      + `The plain-Normal v1 is adequate on the downside — ship as-is, don't add a skew knob.`}`);
}

main().catch(e => { console.error(e); process.exit(1); });
