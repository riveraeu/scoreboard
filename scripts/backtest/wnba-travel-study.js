#!/usr/bin/env node
// Historical WNBA travel study.  Does the distance a team flew since its previous game carry
// SCORING signal beyond team strength?  Travel is exogenous (the schedule, fixed in advance),
// exactly reconstructable, and — unlike rest/B2B — is NOT a model input.  WNBA travel is famously
// brutal (compressed schedule, long flights), and the WNBA market is thin, so it's a plausible
// underweighted edge for the flagged wnba|points / wnba|rebounds props.
//
//   *** ACCURACY test, not edge (MODEL_IMPROVEMENT.md). *** Flat = kill it cheaply today.
//   A real gradient = promote to "worth wiring + forward-shadow for market-orthogonality."
//
// Granularity: team POINTS (= sum of the props we bet) residualized by (own offense + opp defense
// + home-court), grouped by that team's travel distance.  Team points come free from the scoreboard
// (no boxscore fetch).  If team scoring doesn't move with travel, individual points/rebounds won't
// systematically either → no need for the heavier per-player cut.  (Rebounds would need boxscores;
// only worth it if points shows signal.)
//
// SAMPLING-FLOOR SCREEN (the umpire-study lesson): team-points residual SD ~9; a travel effect of
// a couple points over ~hundreds of long-trip team-games → SE small enough to clear if the effect
// is real.  The script prints the realized residual SD + per-bucket SE so the screen is verifiable.
//
// Usage: node scripts/backtest/wnba-travel-study.js [--start 20250516] [--end 20250911] [--min 25]
// Source: ESPN WNBA scoreboard (per-day). No key.
//
// RESULT (2025 n=268 games / 2024 n=216): FAILS. No stable scoring effect, and the only
// suggestive bucket SIGN-FLIPS between seasons → noise, not signal:
//   • cross-country (1500+ mi): 2025 resid −2.00 (away −2.20) but 2024 resid +1.12 (away +1.61)
//   • overall r(travel, scoringResid): 2025 −0.047, 2024 +0.061 — both below ~2·SE, opposite signs
//   • middle buckets non-monotone in both years. A real fatigue effect would be negative in BOTH.
// WNBA is small (~1 season of 13-team data), so power is limited — but a sign flip is a kill, not a
// "need more data." Don't wire travel; revisit only if a multi-season pull ever shows a stable
// negative cross-country bucket. Pre-filter did its job: killed in an afternoon, no prices.

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const START = arg("--start", "20250516"); // 2025 regular season
const END   = arg("--end",   "20250911");
const MIN   = parseInt(arg("--min", "25"), 10); // per-team-game floor for a travel bucket

// ESPN abbr → arena [lat, lon]. 13 teams (2025, incl. GS Valkyries).
const ARENA = {
  ATL: [33.65, -84.45], CHI: [41.94, -87.65], CON: [41.49, -72.09], DAL: [32.73, -97.11],
  GS:  [37.77, -122.39], IND: [39.76, -86.16], LA: [34.04, -118.27], LV: [36.09, -115.18],
  MIN: [44.98, -93.28], NY: [40.68, -73.97], PHX: [33.45, -112.07], SEA: [47.62, -122.35],
  WSH: [38.83, -76.98],
};

const _get = (url) => fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
  .then(r => r.ok ? r.json() : null).catch(() => null);
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } }));
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const variance = a => { const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length; };
const dayNum = (yyyymmdd) => Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) / 864e5;
const fmtDate = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
function haversine(a, b) {
  if (!a || !b) return null;
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const la1 = a[0] * toR, la2 = b[0] * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function main() {
  // 1. Iterate dates → one scoreboard fetch each → completed regular-season finals.
  const dates = [];
  for (let d = dayNum(START); d <= dayNum(END); d++) dates.push(fmtDate(new Date(d * 864e5)));
  const games = [];
  await pool(dates, 10, async (ymd) => {
    const j = await _get(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${ymd}&limit=50`);
    for (const ev of (j?.events || [])) {
      if (ev.season?.type !== 2) continue; // regular season only
      const c = ev.competitions?.[0]; if (!c || !c.status?.type?.completed) continue;
      const home = (c.competitors || []).find(x => x.homeAway === "home");
      const away = (c.competitors || []).find(x => x.homeAway === "away");
      if (!home || !away) continue;
      const hs = +home.score, as = +away.score;
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
      games.push({ ymd, day: dayNum(ymd), home: home.team?.abbreviation, away: away.team?.abbreviation, hs, as });
    }
  });
  if (games.length < 100) { console.log(`Only ${games.length} games — widen the range or check the source.`); return; }
  games.sort((a, b) => a.day - b.day);

  // 2. Per-team chronological log → travel (haversine from prev game's arena) + rest (for control).
  //    A game's location = the HOME team's arena. Travel for each side = distance from its previous
  //    game location to this game's location (home team often 0 on a home stand).
  const prev = {}; // team → { loc, day }
  for (const g of games) {
    const loc = ARENA[g.home];
    g.homeTravel = prev[g.home] ? haversine(prev[g.home].loc, loc) : null;
    g.awayTravel = prev[g.away] ? haversine(prev[g.away].loc, loc) : null;
    g.homeRest = prev[g.home] ? g.day - prev[g.home].day : null;
    g.awayRest = prev[g.away] ? g.day - prev[g.away].day : null;
    prev[g.home] = { loc, day: g.day };
    prev[g.away] = { loc, day: g.day };
  }

  // 3. Team offense / defense = season avg points scored / allowed; HCA from residual.
  const off = {}, def = {};
  for (const g of games) {
    (off[g.home] ??= []).push(g.hs); (def[g.home] ??= []).push(g.as);
    (off[g.away] ??= []).push(g.as); (def[g.away] ??= []).push(g.hs);
  }
  const O = {}, D = {}; for (const t in off) { O[t] = mean(off[t]); D[t] = mean(def[t]); }
  const lgPts = mean(games.flatMap(g => [g.hs, g.as]));
  // HCA on points: home teams score this much more than the off/def model predicts.
  const hca = mean(games.map(g => g.hs - ((O[g.home] + D[g.away]) / 2)));

  // 4. One row per TEAM-GAME with a known travel value. Scoring residual = actual pts − expected.
  //    expected = (ownOff + oppDef)/2 + (home ? +hca : −hca).
  const rows = [];
  for (const g of games) {
    const push = (team, opp, pts, isHome, travel, rest) => {
      if (travel == null) return;
      const exp = (O[team] + D[opp]) / 2 + (isHome ? hca : -hca);
      rows.push({ team, pts, resid: pts - exp, travel, rest, isHome });
    };
    push(g.home, g.away, g.hs, true,  g.homeTravel, g.homeRest);
    push(g.away, g.home, g.as, false, g.awayTravel, g.awayRest);
  }
  const residSD = Math.sqrt(variance(rows.map(r => r.resid)));

  // 5. Scoring residual by travel bucket.
  const EDGES = [1, 500, 1500]; // miles: 0 (home stand), short, medium, cross-country
  const LABELS = ["0 (no travel)", "1–500 mi", "500–1500 mi", "1500+ mi"];
  const bucket = (mi) => { let b = EDGES.findIndex(e => mi < e); return b === -1 ? EDGES.length : b; };
  const groups = LABELS.map(() => []);
  for (const r of rows) groups[bucket(r.travel)].push(r);

  // Correlation travel(mi) vs scoring residual.
  const tr = rows.map(r => r.travel), re = rows.map(r => r.resid);
  const mx = mean(tr), my = mean(re);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < rows.length; i++) { const dx = tr[i] - mx, dy = re[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const travCorr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;

  // AWAY-only cut (travel confounds with being the road team; home rarely travels). The away
  // subset isolates "how far the road team flew" with home/away held fixed.
  const awayRows = rows.filter(r => !r.isHome);
  const awayGroups = LABELS.map(() => []);
  for (const r of awayRows) awayGroups[bucket(r.travel)].push(r);

  console.log(`\nWNBA travel → scoring study   ${START} … ${END}`);
  console.log(`${games.length} reg-season finals · ${rows.length} team-games with travel known · lg ${lgPts.toFixed(1)} pts · HCA ${hca.toFixed(2)}`);
  console.log(`SAMPLING-FLOOR SCREEN: scoring-residual SD ${residSD.toFixed(1)} (per-bucket SE = SD/√n below; signal must clear ~2·SE)\n`);

  const printGroups = (label, gs) => {
    console.log(`${label} (− = scored below expectation):`);
    gs.forEach((g, i) => {
      const n = g.length, m = n ? mean(g.map(r => r.resid)) : 0, se = n ? Math.sqrt(variance(g.map(r => r.resid)) / n) : 0;
      const flag = n >= MIN ? (Math.abs(m) > 2 * se ? " ✓>2·SE" : "") : "  · thin";
      console.log(`  ${LABELS[i].padEnd(16)} n=${String(n).padStart(4)}  resid ${m >= 0 ? "+" : ""}${m.toFixed(2)} ± ${se.toFixed(2)}${flag}`);
    });
  };
  printGroups("SCORING RESIDUAL by travel (all team-games)", groups);
  console.log(`  → r(travelMiles, scoringResid) = ${travCorr.toFixed(3)}  (n=${rows.length}, SE≈${(1 / Math.sqrt(rows.length)).toFixed(3)})\n`);
  printGroups("SCORING RESIDUAL by travel (AWAY teams only — home/away held fixed)", awayGroups);

  console.log(`\nRead: a monotone NEGATIVE gradient (more travel → scored further below expectation)`);
  console.log(`that clears 2·SE = travel carries scoring signal team strength can't see → wire it`);
  console.log(`(it's NOT a current input), then forward-shadow for market-orthogonality. Flat = KILL.`);
  console.log(`(Accuracy only — beating the PRICE still needs forward shadow.)\n`);
}
main();
