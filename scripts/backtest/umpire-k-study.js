#!/usr/bin/env node
// Historical umpire → strikeouts study.  Two questions, both answerable on history with NO prices:
//   (1) Is the home-plate umpire's K effect REAL and stable (not matchup noise)?  — variance-ratio
//       + split-half reliability.
//   (2) Does the model's static UMPIRE_KFACTOR (sourced 2022–24) still match the EMPIRICAL 2025
//       effect, or has it drifted?  — Pearson r(model factor, empirical effect).  This is the
//       actionable one: umpire is ALREADY a strikeouts input, so the question is L2 (is it weighted
//       right / has the table gone stale), not L0 (does the signal exist).
//
//   *** Accuracy test, not edge. *** A real, correctly-sized, NON-stale umpire effect is necessary
//   for the input to help, not sufficient to beat the price (the market sees the ump too).
//
// Game-level total Ks (both teams) is the clean isolation: umpire crews rotate independently of the
// pitching matchup, so across a season an umpire's mean-total-K above league reads their zone effect.
//
// Usage:  node scripts/backtest/umpire-k-study.js [--start 2025-04-01] [--end 2025-08-31] [--min 8]
// Source: MLB statsapi (schedule + boxscores: Ks AND home-plate ump in one fetch). No key.
//
// RESULT (2025-04..08, 2023 games): INCONCLUSIVE — the study is UNDERPOWERED as built. Game-total
// K SD is 4.1, dominated by the PITCHING MATCHUP; the ump effect (~±1 K/game) is the same size as
// the SE of an ump's mean at ~20 games (variance-ratio 0.87 <1, signalSD≈0, split-half r=−0.11).
// So matchup noise SWAMPS the ump signal — this can neither confirm nor size it, and the weak
// r(model,empirical)=0.13 is attenuated by a noise-dominated empirical estimate, NOT proof the
// table is fine OR stale. LESSON: the cheap single-control residualization that worked for weather
// (park is one clean categorical; wind is exogenous) does NOT transfer here — the umpire confound
// (which pitchers/lineups they drew) is high-variance. v2 fix: residualize total-K by EXPECTED K
// (both teams' batting K% + pitching K% from one leaderboard fetch each) BEFORE the ump effect,
// to strip matchup variance and give the test power. Until then: treat the static table as at-risk
// of staleness (many active 2025 umps — Torres, Hanahan, Barry, Visconti, Wolcott — aren't in it).

import { UMPIRE_KFACTOR } from "../../api/lib/simulate.js";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const START = arg("--start", "2025-04-01");
const END   = arg("--end",   "2025-08-31");
const MIN   = parseInt(arg("--min", "8"), 10); // min games to rate an umpire

const _norm = (n) => n ? n.normalize("NFD").replace(/[̀-ͯ]/g, "").trim() : "";
const _get = (url) => fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
  .then(r => r.ok ? r.json() : null).catch(() => null);

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const variance = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length; };
const pearson = (xs, ys) => {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
};

async function main() {
  // 1. Schedule → Final regular-season games.
  const sched = await _get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${START}&endDate=${END}`);
  const games = [];
  for (const d of (sched?.dates || []))
    for (const g of (d.games || []))
      if (g.status?.abstractGameState === "Final" && g.gameType === "R")
        games.push({ gamePk: g.gamePk, dateISO: g.gameDate, ump: null, totalK: null });
  if (!games.length) { console.log("No Final regular-season games in range."); return; }

  // 2. Boxscore → total Ks (both teams' pitching) + home-plate umpire, in one fetch.
  await pool(games, 12, async (g) => {
    const j = await _get(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
    const hp = (j?.officials || []).find(o => o.officialType === "Home Plate");
    const k = ["home", "away"].reduce((s, side) => s + (j?.teams?.[side]?.teamStats?.pitching?.strikeOuts ?? 0), 0);
    if (hp?.official?.fullName && Number.isFinite(k) && k > 0) { g.ump = _norm(hp.official.fullName); g.totalK = k; }
  });

  const rows = games.filter(g => g.ump && g.totalK != null);
  if (rows.length < 100) { console.log(`Only ${rows.length} usable games — widen the window.`); return; }
  const allK = rows.map(r => r.totalK);
  const muK = mean(allK), sigK = Math.sqrt(variance(allK));

  // 3. Per-umpire effect = mean total-K − league mean.
  const byUmp = {};
  for (const r of rows) (byUmp[r.ump] ??= []).push(r);
  const umps = Object.entries(byUmp)
    .filter(([, gs]) => gs.length >= MIN)
    .map(([ump, gs]) => ({ ump, n: gs.length, mean: mean(gs.map(g => g.totalK)), games: gs }))
    .map(u => ({ ...u, effect: u.mean - muK }));
  umps.sort((a, b) => b.effect - a.effect);

  // 4. Variance-ratio: is between-umpire variation more than sampling noise predicts?
  //    Under the null (ump has no effect), Var(ump mean) ≈ σ²/n. Compare observed to that.
  const obsVar = variance(umps.map(u => u.effect));
  const nullVar = mean(umps.map(u => sigK ** 2 / u.n));
  const signalSD = Math.sqrt(Math.max(0, obsVar - nullVar)); // true between-ump SD, noise removed

  // 5. Split-half reliability: per ump, chronological halves → does half-1 effect predict half-2?
  const h1 = [], h2 = [];
  for (const u of umps) {
    const gs = [...u.games].sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
    const mid = Math.floor(gs.length / 2);
    const a = gs.slice(0, mid), b = gs.slice(mid);
    if (a.length >= 3 && b.length >= 3) { h1.push(mean(a.map(g => g.totalK)) - muK); h2.push(mean(b.map(g => g.totalK)) - muK); }
  }
  const splitR = h1.length >= 8 ? pearson(h1, h2) : null;

  // 6. Model vs empirical: does the static UMPIRE_KFACTOR still match 2025? (staleness check)
  const matched = umps.filter(u => UMPIRE_KFACTOR[u.ump] != null);
  const modelR = matched.length >= 8 ? pearson(matched.map(u => UMPIRE_KFACTOR[u.ump]), matched.map(u => u.effect)) : null;

  const perPitcher = e => (e / 2).toFixed(2); // one starter ≈ half the game's batters; ump calls both halves

  console.log(`\nHistorical umpire → strikeouts study   ${START} … ${END}`);
  console.log(`${rows.length} games · league ${muK.toFixed(1)} total K/g (SD ${sigK.toFixed(1)}) · ${umps.length} umps ≥${MIN} games\n`);

  console.log(`IS THE EFFECT REAL?`);
  console.log(`  between-ump SD of mean total-K : observed ${Math.sqrt(obsVar).toFixed(2)}  vs noise-only ${Math.sqrt(nullVar).toFixed(2)}  → ratio ${(obsVar / nullVar).toFixed(2)}`);
  console.log(`  true between-ump SD (noise removed): ${signalSD.toFixed(2)} K/game  (≈ ${perPitcher(signalSD)} K per starter)`);
  console.log(`  split-half reliability r        : ${splitR == null ? "n/a (too few)" : splitR.toFixed(3)}  (>0 = stable ump identity, not matchup luck)\n`);

  console.log(`MODEL vs EMPIRICAL (is the static 2022–24 UMPIRE_KFACTOR still right?)`);
  console.log(`  r(model factor, 2025 effect) = ${modelR == null ? "n/a" : modelR.toFixed(3)}  over ${matched.length} rated umps  (high = table holds; low = drifted/stale)\n`);

  const fmt = u => `  ${u.ump.padEnd(20)} n=${String(u.n).padStart(3)}  ${u.effect >= 0 ? "+" : ""}${u.effect.toFixed(2)} K/g (${perPitcher(u.effect)}/start)  model ${UMPIRE_KFACTOR[u.ump] != null ? UMPIRE_KFACTOR[u.ump].toFixed(2) : "—"}`;
  console.log(`TOP K-BOOSTING UMPS (2025):`);
  umps.slice(0, 6).forEach(u => console.log(fmt(u)));
  console.log(`TOP K-SUPPRESSING UMPS (2025):`);
  umps.slice(-6).reverse().forEach(u => console.log(fmt(u)));

  console.log(`\nRead: ratio≫1 + split-half r>0 = the ump effect is real. Then r(model,empirical)`);
  console.log(`tells you if the shipped table still holds (high) or has gone stale and needs a refresh`);
  console.log(`(low). Per-starter swing sizes the input vs a 0.5-K prop line. Accuracy only — the`);
  console.log(`market prices the ump too, so a real effect is necessary, not sufficient, for edge.\n`);
}
main();
