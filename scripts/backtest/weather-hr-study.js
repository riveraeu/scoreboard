#!/usr/bin/env node
// Historical weather → HR study.  Does game-time wind-out / temperature predict home runs
// ABOVE the park baseline?  If yes, weather carries signal the static park factor can't see —
// worth the HRR input.  If flat, kill it.  NO price data needed.
//
//   *** This is an ACCURACY test, not an edge test. ***
// It answers "does weather predict the outcome beyond what the model already sees" — a NECESSARY
// condition for beating the market, not a sufficient one.  Whether the market already PRICES the
// weather (orthogonality to the line) still needs forward shadow + CLV; history has no prop prices.
// So: a flat result KILLS the input cheaply today; a positive result PROMOTES it to "worth the
// forward-shadow wait" — it does not by itself prove a market edge.
//
// Game-level HR (not per-hitter) is the cleaner isolation of the WEATHER effect: which team is
// home is independent of that day's wind, so park-residualized HR/game reads the wind effect with
// less confounding than a per-hitter cut.  HRR is downstream of the same HR/run process.
//
// Usage:  node scripts/backtest/weather-hr-study.js [--start 2025-05-01] [--end 2025-06-20]
// Sources: MLB statsapi (schedule + boxscores, no key) + Open-Meteo archive (no key).

import { BALLPARKS, windOutComponent } from "../../api/lib/mlb-weather.js";
import { MLB_ID_TO_ABBR } from "../../api/lib/mlb-shared.js";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const START = arg("--start", "2025-05-01");
const END   = arg("--end",   "2025-06-20");

const _get = (url) => fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
  .then(r => r.ok ? r.json() : null).catch(() => null);

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  }));
}

async function main() {
  // 1. Schedule → Final games at non-dome, mapped parks.
  const sched = await _get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${START}&endDate=${END}`);
  const games = [];
  for (const d of (sched?.dates || [])) {
    for (const g of (d.games || [])) {
      if (g.status?.abstractGameState !== "Final") continue;
      const abbr = MLB_ID_TO_ABBR[g.teams?.home?.team?.id];
      const bp = abbr && BALLPARKS[abbr];
      if (!bp || bp.dome) continue;
      games.push({ gamePk: g.gamePk, dateISO: g.gameDate, abbr, bp, hr: null });
    }
  }
  if (!games.length) { console.log("No Final non-dome games in range."); return; }

  // 2. One Open-Meteo archive call per park over the window; index by UTC hour.
  const parks = [...new Set(games.map(g => g.abbr))];
  const wx = {};
  await pool(parks, 6, async (abbr) => {
    const bp = BALLPARKS[abbr];
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${bp.lat}&longitude=${bp.lon}`
      + `&start_date=${START}&end_date=${END}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT`;
    const j = await _get(url);
    const h = j?.hourly; if (!h?.time) return;
    const idx = {};
    for (let k = 0; k < h.time.length; k++) idx[String(h.time[k]).slice(0, 13)] = k;
    wx[abbr] = { h, idx };
  });

  // 3. Boxscores → total HR per game (both teams).
  await pool(games, 8, async (g) => {
    const j = await _get(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
    const hr = ["home", "away"].reduce((s, side) => s + (j?.teams?.[side]?.teamStats?.batting?.homeRuns ?? 0), 0);
    g.hr = Number.isFinite(hr) ? hr : null;
  });

  // 4. Join weather at first-pitch hour.
  const rows = [];
  for (const g of games) {
    if (g.hr == null) continue;
    const w = wx[g.abbr]; if (!w) continue;
    const k = w.idx[new Date(g.dateISO).toISOString().slice(0, 13)];
    if (k == null) continue;
    const temp = w.h.temperature_2m?.[k], spd = w.h.wind_speed_10m?.[k], dir = w.h.wind_direction_10m?.[k];
    if (temp == null || spd == null || dir == null) continue;
    rows.push({ abbr: g.abbr, hr: g.hr, windOut: windOutComponent(spd, dir, g.bp.cfAz), tempF: Math.round(temp) });
  }
  if (rows.length < 30) { console.log(`Only ${rows.length} joined rows — widen the window.`); return; }

  // 5. Park-residualize HR (remove each park's mean) so we read the WEATHER effect, not the park.
  const sum = {}, cnt = {};
  for (const r of rows) { sum[r.abbr] = (sum[r.abbr] || 0) + r.hr; cnt[r.abbr] = (cnt[r.abbr] || 0) + 1; }
  for (const r of rows) r.resid = r.hr - sum[r.abbr] / cnt[r.abbr];

  const bucketize = (key, edges) => {
    const groups = edges.map(() => []); groups.push([]);
    for (const r of rows) { let b = edges.findIndex(e => r[key] <= e); if (b === -1) b = edges.length; groups[b].push(r); }
    return groups.map((g, i) => {
      const lo = i === 0 ? "  -inf" : String(edges[i - 1]);
      const hi = i < edges.length ? String(edges[i]) : "+inf";
      const n = g.length;
      return { range: `${lo}..${hi}`, n, mHr: n ? g.reduce((s, r) => s + r.hr, 0) / n : 0, resid: n ? g.reduce((s, r) => s + r.resid, 0) / n : 0 };
    }).filter(b => b.n > 0);
  };
  const corr = (key) => {
    const n = rows.length, mx = rows.reduce((a, r) => a + r[key], 0) / n, my = rows.reduce((a, r) => a + r.resid, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const r of rows) { const dx = r[key] - mx, dy = r.resid - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  };
  const printBuckets = (key, edges) => {
    for (const b of bucketize(key, edges))
      console.log(`  ${b.range.padStart(12)}  n=${String(b.n).padStart(4)}  HR/g ${b.mHr.toFixed(2)}  parkResid ${b.resid >= 0 ? "+" : ""}${b.resid.toFixed(2)}`);
  };

  console.log(`\nHistorical weather → HR study   ${START} … ${END}`);
  console.log(`${rows.length} non-dome Final games across ${parks.length} parks\n`);
  console.log(`Park-residualized HR/game by WIND-OUT (mph, + = blowing out to CF):`);
  printBuckets("windOut", [-8, -3, 0, 3, 8]);
  console.log(`  → Pearson r(windOut, parkResidHR) = ${corr("windOut").toFixed(3)}`);
  console.log(`\nPark-residualized HR/game by TEMP (°F):`);
  printBuckets("tempF", [55, 65, 75, 85]);
  console.log(`  → Pearson r(tempF, parkResidHR) = ${corr("tempF").toFixed(3)}`);
  console.log(`\nRead: a monotone POSITIVE wind-out gradient + r>0 = weather carries HR signal beyond`);
  console.log(`park → keep the input, forward-shadow to test market-orthogonality. Flat/zero r = kill it.`);
  console.log(`(Accuracy only — beating the PRICE still needs forward shadow.)\n`);
}
main();
