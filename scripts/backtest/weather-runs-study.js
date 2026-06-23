#!/usr/bin/env node
// Historical weather → RUNS study, targeting the unmodeled weather dimensions.
//
// The live model already prices WIND-OUT + TEMPERATURE into run scoring (game-totals.js
// `_weatherFactor` = 1 + windOut·0.013 + (temp−72)·0.001, and the same on team totals; HRR
// uses wind+temp too). It does NOT see HUMIDITY or BAROMETRIC PRESSURE — both change air
// density → ball carry → runs, both are free from Open-Meteo archive, both are exogenous and
// exactly reconstructable. This asks the cheap accuracy question for the flagged MLB run
// categories (totalRuns / f5total / ml / spread): does humidity or pressure predict
// park-residual runs ABOVE the wind+temp the model already prices?
//
//   *** ACCURACY test, not edge (MODEL_IMPROVEMENT.md). *** A flat result KILLS the input
//   today; a positive INCREMENTAL gradient PROMOTES it to "worth wiring + forward-shadow."
//   Whether the market already prices it (orthogonality to the line) still needs forward CLV.
//
// The rigor that matters here is the INCREMENTAL test: park-residualize runs, THEN regress out
// the modeled wind+temp (2-var OLS), and read humidity/pressure against THAT residual. A raw
// humidity gradient can be pure temp-collinearity (hot air holds more moisture); the partial
// gradient is the part the model can't already see.
//
// SAMPLING-FLOOR note (the umpire-study lesson): total runs/game SD ~3.2; a weather effect of a
// few tenths of a run over ~1500 games clears √-n easily — coarser than HR and higher base rate,
// so power is BETTER than the HR study. The script prints the realized residual SD + r so the
// screen is verifiable.
//
// Usage:  node scripts/backtest/weather-runs-study.js [--start 2025-05-01] [--end 2025-08-31]
// Sources: MLB statsapi (schedule + boxscores, no key) + Open-Meteo archive (no key).
//
// RESULT (2024 full n=1539, 2025 Apr–Sep n=888, 2025 May–Aug n=562): BOTH CANDIDATES FAIL.
//   • PRESSURE — dead. Incremental r ≈ −0.01..−0.03, non-monotone across all windows. Kill.
//   • HUMIDITY — weak and DECAYING with n: incremental r 0.068 (n=562) → 0.034 (n=1539) →
//     0.017 (n=888). Not monotone — only the rare >85% RH tail (~5% of games) is elevated
//     (+0.4..+0.8 runs). Below the "monotone + r well above 0" bar → not worth wiring as an
//     input. The pre-filter did its job: killed in an afternoon instead of a month of shadow.
//   • BONUS (the modeled levers): wind-out r≈−0.02 and temp r≈0.00 on TOTAL RUNS — i.e. the
//     live game/team-total `_weatherFactor` (carried over from the HR study) has little
//     historical support for RUN scoring (HR is ~1.1 of ~8.7 runs, so the HR weather signal
//     dilutes ~8:1). Separate model-honesty item: the run/total weather factor may be ~noise
//     for totals even though it's right for HRR. Not changed here.

import { BALLPARKS, windOutComponent } from "../../api/lib/mlb-weather.js";
import { MLB_ID_TO_ABBR } from "../../api/lib/mlb-shared.js";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const START = arg("--start", "2025-05-01");
const END   = arg("--end",   "2025-08-31");

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
function pearson(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

// 2-predictor OLS — returns residual of y after removing [x1, x2] (+ intercept).
function residualize2(y, x1, x2) {
  const n = y.length;
  const m1 = mean(x1), m2 = mean(x2), my = mean(y);
  // center
  const a = x1.map(v => v - m1), b = x2.map(v => v - m2), c = y.map(v => v - my);
  let saa = 0, sbb = 0, sab = 0, say = 0, sby = 0;
  for (let i = 0; i < n; i++) { saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; say += a[i] * c[i]; sby += b[i] * c[i]; }
  const det = saa * sbb - sab * sab;
  if (!det) return c; // degenerate → just mean-center
  const beta1 = (sbb * say - sab * sby) / det;
  const beta2 = (saa * sby - sab * say) / det;
  return y.map((v, i) => v - (my + beta1 * a[i] + beta2 * b[i]));
}

async function main() {
  // 1. Schedule → Final games at non-dome, mapped parks.
  const sched = await _get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${START}&endDate=${END}`);
  const games = [];
  for (const d of (sched?.dates || [])) {
    for (const g of (d.games || [])) {
      if (g.status?.abstractGameState !== "Final") continue;
      if (g.gameType !== "R") continue;
      const abbr = MLB_ID_TO_ABBR[g.teams?.home?.team?.id];
      const bp = abbr && BALLPARKS[abbr];
      if (!bp || bp.dome) continue;
      games.push({ gamePk: g.gamePk, dateISO: g.gameDate, abbr, bp, runs: null });
    }
  }
  if (!games.length) { console.log("No Final non-dome reg-season games in range."); return; }

  // 2. One Open-Meteo archive call per park; index by UTC hour. ADD humidity + surface pressure.
  const parks = [...new Set(games.map(g => g.abbr))];
  const wx = {};
  await pool(parks, 6, async (abbr) => {
    const bp = BALLPARKS[abbr];
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${bp.lat}&longitude=${bp.lon}`
      + `&start_date=${START}&end_date=${END}`
      + `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,relative_humidity_2m,surface_pressure`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT`;
    const j = await _get(url);
    const h = j?.hourly; if (!h?.time) return;
    const idx = {};
    for (let k = 0; k < h.time.length; k++) idx[String(h.time[k]).slice(0, 13)] = k;
    wx[abbr] = { h, idx };
  });

  // 3. Boxscores → total runs per game (both teams).
  await pool(games, 8, async (g) => {
    const j = await _get(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
    const runs = ["home", "away"].reduce((s, side) => s + (j?.teams?.[side]?.teamStats?.batting?.runs ?? 0), 0);
    g.runs = Number.isFinite(runs) && runs >= 0 ? runs : null;
  });

  // 4. Join weather at first-pitch hour.
  const rows = [];
  for (const g of games) {
    if (g.runs == null) continue;
    const w = wx[g.abbr]; if (!w) continue;
    const k = w.idx[new Date(g.dateISO).toISOString().slice(0, 13)];
    if (k == null) continue;
    const temp = w.h.temperature_2m?.[k], spd = w.h.wind_speed_10m?.[k], dir = w.h.wind_direction_10m?.[k];
    const rh = w.h.relative_humidity_2m?.[k], pr = w.h.surface_pressure?.[k];
    if (temp == null || spd == null || dir == null || rh == null || pr == null) continue;
    rows.push({
      abbr: g.abbr, runs: g.runs,
      windOut: windOutComponent(spd, dir, g.bp.cfAz),
      tempF: Math.round(temp), humidity: Math.round(rh), pressure: Math.round(pr),
    });
  }
  if (rows.length < 100) { console.log(`Only ${rows.length} joined rows — widen the window.`); return; }

  // 5. Park-residualize runs (remove each park's mean) → reads the WEATHER effect, not the park.
  const sum = {}, cnt = {};
  for (const r of rows) { sum[r.abbr] = (sum[r.abbr] || 0) + r.runs; cnt[r.abbr] = (cnt[r.abbr] || 0) + 1; }
  for (const r of rows) r.resid = r.runs - sum[r.abbr] / cnt[r.abbr];

  // 6. INCREMENTAL residual: strip the MODELED wind+temp out of the park-residual, so humidity/
  //    pressure are read on the part the model can't already see.
  const parkResid = rows.map(r => r.resid);
  const incr = residualize2(parkResid, rows.map(r => r.windOut), rows.map(r => r.tempF));
  rows.forEach((r, i) => { r.incr = incr[i]; });

  const bucketize = (key, edges, valOf) => {
    const groups = edges.map(() => []); groups.push([]);
    for (const r of rows) { let b = edges.findIndex(e => r[key] <= e); if (b === -1) b = edges.length; groups[b].push(r); }
    return groups.map((g, i) => {
      const lo = i === 0 ? "  -inf" : String(edges[i - 1]);
      const hi = i < edges.length ? String(edges[i]) : "+inf";
      const n = g.length;
      return { range: `${lo}..${hi}`, n, mRuns: n ? mean(g.map(r => r.runs)) : 0, val: n ? mean(g.map(valOf)) : 0 };
    }).filter(b => b.n > 0);
  };
  const printBuckets = (key, edges, valOf, label) => {
    for (const b of bucketize(key, edges, valOf))
      console.log(`  ${b.range.padStart(12)}  n=${String(b.n).padStart(4)}  runs/g ${b.mRuns.toFixed(2)}  ${label} ${b.val >= 0 ? "+" : ""}${b.val.toFixed(2)}`);
  };

  const residSD = Math.sqrt(variance(parkResid));
  console.log(`\nHistorical weather → RUNS study   ${START} … ${END}`);
  console.log(`${rows.length} non-dome reg-season Final games across ${parks.length} parks · park-residual runs SD ${residSD.toFixed(2)}\n`);

  // --- MODELED levers (sanity: runs should respond to wind+temp like HR did) ---
  console.log(`[MODELED] Park-residual runs/g by WIND-OUT (mph, + = out to CF):`);
  printBuckets("windOut", [-8, -3, 0, 3, 8], r => r.resid, "parkResid");
  console.log(`  → r(windOut, parkResidRuns) = ${pearson(rows.map(r => r.windOut), parkResid).toFixed(3)}`);
  console.log(`\n[MODELED] Park-residual runs/g by TEMP (°F):`);
  printBuckets("tempF", [55, 65, 75, 85], r => r.resid, "parkResid");
  console.log(`  → r(tempF, parkResidRuns) = ${pearson(rows.map(r => r.tempF), parkResid).toFixed(3)}`);

  // --- CANDIDATE levers, read on the INCREMENTAL residual (wind+temp removed) ---
  console.log(`\n========== CANDIDATES (read on residual with modeled wind+temp removed) ==========`);
  console.log(`\n[CANDIDATE] HUMIDITY (% RH) → incremental residual runs:`);
  printBuckets("humidity", [40, 55, 70, 85], r => r.incr, "incrResid");
  console.log(`  → raw r(humidity, parkResid) = ${pearson(rows.map(r => r.humidity), parkResid).toFixed(3)}` +
              `   INCREMENTAL r(humidity, resid|wind,temp) = ${pearson(rows.map(r => r.humidity), incr).toFixed(3)}`);
  console.log(`\n[CANDIDATE] SURFACE PRESSURE (hPa) → incremental residual runs:`);
  printBuckets("pressure", [995, 1005, 1012, 1018], r => r.incr, "incrResid");
  console.log(`  → raw r(pressure, parkResid) = ${pearson(rows.map(r => r.pressure), parkResid).toFixed(3)}` +
              `   INCREMENTAL r(pressure, resid|wind,temp) = ${pearson(rows.map(r => r.pressure), incr).toFixed(3)}`);

  console.log(`\nRead: a monotone INCREMENTAL gradient + |incremental r| well above 0 = the dimension`);
  console.log(`carries run signal the modeled wind+temp can't see → wire it (build→hydrate→consume),`);
  console.log(`then forward-shadow for market-orthogonality. Flat incremental r = it was just temp`);
  console.log(`collinearity → KILL it. (Accuracy only — beating the PRICE still needs forward shadow.)\n`);
}
main();
