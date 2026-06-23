#!/usr/bin/env node
// Historical umpire → strikeouts study (v2, matchup-residualized).
//
// v1 (raw game-total K) was UNDERPOWERED: total-K SD ~4.1 is dominated by the pitching matchup, so
// the ~±1 K/game ump effect was buried. v2 strips the matchup: derive each game's EXPECTED total K
// from a log5 combination of both teams' season batting-K% and pitching-K% (× actual PA), then run
// the umpire analysis on the RESIDUAL (actual − expected). The script reports RAW vs RESIDUAL side
// by side so the power gain (residual SD drop) is visible.
//
// Two questions, both price-free:
//   (1) Is the home-plate ump's K effect REAL once the matchup is removed? — variance-ratio +
//       split-half reliability ON THE RESIDUAL.
//   (2) Does the static 2022–24 UMPIRE_KFACTOR still match the 2025 effect? — r(model, residual effect).
//
//   *** Accuracy test, not edge. *** And note the SAMPLING FLOOR the script prints: even with
//   perfect matchup control, per-game K has an irreducible binomial SD (~√(PA·k·(1−k)) ≈ 3.6).
//   If the true between-ump signal (~0.5 K/g) is small vs that floor / √n_games, game-total K may
//   be the WRONG GRANULARITY for umpire no matter how good the control — the right one is pitch-level
//   called-strike data (Statcast). v2 quantifies exactly how close to that floor the control gets.
//
// Usage:  node scripts/backtest/umpire-k-study.js [--start 2025-04-01] [--end 2025-08-31] [--min 8]
// Source: MLB statsapi (schedule + boxscores + 2 team-rate leaderboards). No key.
//
// RESULT (2025-04..08, 2023 games): matchup control gave ~NO power gain (raw SD 4.11 → residual SD
// 4.15) because the SAMPLING FLOOR is 3.61 — irreducible binomial noise is ~88% of the raw SD, so
// the matchup-explainable part is tiny and the team-level control barely dents it. Both raw and
// residual: variance-ratio <1, signalSD≈0, split-half r<0 → NO stable ump effect detectable at
// game-total granularity. PROVEN, not suspected: you'd need ~200 games/ump (reality ≈25). The
// umpire K effect is real but lives at PITCH level (called strikes — thousands/ump/game); game
// totals are the wrong instrument no matter the control. Faint corroboration: residualizing nudged
// r(model,effect) 0.13→0.21 and Kulpa (model #1, 1.12) is empirical #1 (+2.46) — table isn't random
// but is below significance here. STALENESS: incomplete (many active 2025 umps absent — Barry,
// Hanahan, Metz, Moscoso, Visconti) and partly drifted (Livensparger model 1.04 → empirical #2
// suppressor). FIX is NOT a heavier study: refresh UMPIRE_KFACTOR from an updated UmpScorecards pull
// (its original source) — game-total can neither validate nor rebuild it. v2 proved the granularity.

import { UMPIRE_KFACTOR } from "../../api/lib/simulate.js";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const START = arg("--start", "2025-04-01");
const END   = arg("--end",   "2025-08-31");
const MIN   = parseInt(arg("--min", "8"), 10);
const SEASON = START.slice(0, 4);

const _norm = (n) => n ? n.normalize("NFD").replace(/[̀-ͯ]/g, "").trim() : "";
const _get = (url) => fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
  .then(r => r.ok ? r.json() : null).catch(() => null);
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } }));
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const variance = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length; };
const pearson = (xs, ys) => {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
};

// Per-umpire analysis on an arbitrary value accessor (raw totalK or residual).
function analyze(rows, valOf) {
  const all = rows.map(valOf), mu = mean(all), sig = Math.sqrt(variance(all));
  const byUmp = {};
  for (const r of rows) (byUmp[r.ump] ??= []).push(r);
  const umps = Object.entries(byUmp).filter(([, gs]) => gs.length >= MIN)
    .map(([ump, gs]) => ({ ump, n: gs.length, mean: mean(gs.map(valOf)), games: gs }))
    .map(u => ({ ...u, effect: u.mean - mu }))
    .sort((a, b) => b.effect - a.effect);
  const obsVar = variance(umps.map(u => u.effect));
  const nullVar = mean(umps.map(u => sig ** 2 / u.n));
  const signalSD = Math.sqrt(Math.max(0, obsVar - nullVar));
  const h1 = [], h2 = [];
  for (const u of umps) {
    const gs = [...u.games].sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
    const mid = Math.floor(gs.length / 2), a = gs.slice(0, mid), b = gs.slice(mid);
    if (a.length >= 3 && b.length >= 3) { h1.push(mean(a.map(valOf)) - mu); h2.push(mean(b.map(valOf)) - mu); }
  }
  const splitR = h1.length >= 8 ? pearson(h1, h2) : null;
  const matched = umps.filter(u => UMPIRE_KFACTOR[u.ump] != null);
  const modelR = matched.length >= 8 ? pearson(matched.map(u => UMPIRE_KFACTOR[u.ump]), matched.map(u => u.effect)) : null;
  return { sig, umps, obsVar, nullVar, signalSD, splitR, modelR, matched };
}
const report = (label, a) => {
  console.log(`\n${label}  (per-game SD ${a.sig.toFixed(2)})`);
  console.log(`  between-ump SD: observed ${Math.sqrt(a.obsVar).toFixed(2)} vs noise-only ${Math.sqrt(a.nullVar).toFixed(2)} → ratio ${(a.obsVar / a.nullVar).toFixed(2)}`);
  console.log(`  true between-ump SD (noise removed): ${a.signalSD.toFixed(2)}   split-half r: ${a.splitR == null ? "n/a" : a.splitR.toFixed(3)}   r(model,effect): ${a.modelR == null ? "n/a" : a.modelR.toFixed(3)} (${a.matched.length} umps)`);
};

async function main() {
  // Team season K rates: batting (SO/PA) and pitching (SO/BF), keyed by team id; league K% from totals.
  const teamRate = async (group, denom) => {
    const j = await _get(`https://statsapi.mlb.com/api/v1/teams/stats?season=${SEASON}&group=${group}&gameType=R&sportId=1&stats=season`);
    const m = {}; let so = 0, d = 0;
    for (const s of (j?.stats?.[0]?.splits || [])) {
      const id = s.team?.id, k = s.stat?.strikeOuts, den = s.stat?.[denom];
      if (id && k != null && den) { m[id] = k / den; so += k; d += den; }
    }
    return { m, lg: d ? so / d : null };
  };
  const [bat, pit] = await Promise.all([teamRate("hitting", "plateAppearances"), teamRate("pitching", "battersFaced")]);
  const lg = bat.lg;
  if (!lg || !Object.keys(bat.m).length || !Object.keys(pit.m).length) { console.log("Team rate leaderboards unavailable."); return; }

  // Schedule → Final regular-season games.
  const sched = await _get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${START}&endDate=${END}`);
  const games = [];
  for (const d of (sched?.dates || []))
    for (const g of (d.games || []))
      if (g.status?.abstractGameState === "Final" && g.gameType === "R")
        games.push({ gamePk: g.gamePk, dateISO: g.gameDate });
  if (!games.length) { console.log("No Final regular-season games."); return; }

  // Boxscore → totalK, batting PA (both teams), team ids, home-plate ump.
  await pool(games, 12, async (g) => {
    const j = await _get(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
    const hp = (j?.officials || []).find(o => o.officialType === "Home Plate");
    const T = j?.teams; if (!T) return;
    const k = (T.home?.teamStats?.pitching?.strikeOuts ?? 0) + (T.away?.teamStats?.pitching?.strikeOuts ?? 0);
    g.ump = hp?.official?.fullName ? _norm(hp.official.fullName) : null;
    g.totalK = k > 0 ? k : null;
    g.homeId = T.home?.team?.id; g.awayId = T.away?.team?.id;
    g.homePA = T.home?.teamStats?.batting?.plateAppearances ?? null;
    g.awayPA = T.away?.teamStats?.batting?.plateAppearances ?? null;
  });

  // Expected total K via log5: each half's K% = batK·pitchK/lgK, × that side's actual PA.
  for (const g of games) {
    if (!g.ump || g.totalK == null) continue;
    const bA = bat.m[g.awayId], pH = pit.m[g.homeId], bH = bat.m[g.homeId], pA = pit.m[g.awayId];
    if (bA == null || pH == null || bH == null || pA == null || g.homePA == null || g.awayPA == null) continue;
    g.expK = (bA * pH / lg) * g.awayPA + (bH * pA / lg) * g.homePA; // away batters vs home pitching + vice versa
    g.resid = g.totalK - g.expK;
  }

  const raw = games.filter(g => g.ump && g.totalK != null);
  const res = games.filter(g => g.resid != null);
  if (res.length < 100) { console.log(`Only ${res.length} residualized games — widen the window.`); return; }
  const muK = mean(raw.map(g => g.totalK));
  const meanPA = mean(res.map(g => g.homePA + g.awayPA));
  const floorSD = Math.sqrt(meanPA * lg * (1 - lg)); // irreducible binomial SD of game-total K

  console.log(`\nHistorical umpire → strikeouts study v2 (matchup-residualized)   ${START} … ${END}`);
  console.log(`${raw.length} games · league ${muK.toFixed(1)} total K/g · lgK% ${(lg * 100).toFixed(1)} · ${meanPA.toFixed(0)} PA/g`);
  console.log(`sampling floor (irreducible binomial SD) ≈ ${floorSD.toFixed(2)} K/game — even perfect matchup control can't beat this`);

  report("RAW total-K", analyze(raw, g => g.totalK));
  report("RESIDUAL (actual − expected, matchup removed)", analyze(res, g => g.resid));

  const a = analyze(res, g => g.resid);
  const fmt = u => `  ${u.ump.padEnd(20)} n=${String(u.n).padStart(3)}  resid ${u.effect >= 0 ? "+" : ""}${u.effect.toFixed(2)} K/g (${(u.effect / 2).toFixed(2)}/start)  model ${UMPIRE_KFACTOR[u.ump] != null ? UMPIRE_KFACTOR[u.ump].toFixed(2) : "—"}`;
  console.log(`\nTOP K-BOOSTING UMPS (residual, 2025):`); a.umps.slice(0, 6).forEach(u => console.log(fmt(u)));
  console.log(`TOP K-SUPPRESSING UMPS (residual, 2025):`); a.umps.slice(-6).reverse().forEach(u => console.log(fmt(u)));

  console.log(`\nRead: if RESIDUAL SD ≪ RAW SD but the residual variance-ratio is still ~1 / split-half`);
  console.log(`r≈0, the control worked yet the ump signal is still below the sampling floor at this n →`);
  console.log(`game-total K is the wrong granularity for umpire (use pitch-level). If residual ratio≫1`);
  console.log(`+ split-half r>0, the effect is real and r(model,residual) judges the table's staleness.\n`);
}
main();
