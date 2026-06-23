#!/usr/bin/env node
// NBA rest / back-to-back study.  Does rest carry MARGIN + SCORING signal beyond team strength,
// and does the EMPIRICAL B2B effect match the dampeners the model already applies?
//
// B2B is already a model input → this is an L2 (is it the right SIZE?) question, not L0:
//   • player props:  buildNbaStatDist  isB2B → adjMean ×0.93   (−7% on the player line)
//   • game/team totals: B2B_NBA = 0.975                        (−2.5% on team λ)
// This study works at TEAM level (margin + total points), so it directly tests the totals/spread
// implication; the −7% prop dampener is a different (per-player, load-management) granularity.
//
// SAMPLING-FLOOR SCREEN (the rule the umpire study taught us — check BEFORE trusting a result):
// margin residual SD ~12, B2B effect ~2 pts, ~380 B2B team-games/season → SE ~0.6 → t~3. PASSES.
// Coarse outcome (one margin/game), exogenous signal (schedule), effect > floor/√n. The script
// prints the realized floor + SE so the screen is verifiable, not assumed.
//
// Method: pull a full reg-season of finals, compute each team's rest (days since previous game),
// residualize home margin by team strength (season avg point-diff) + home-court advantage, then read
// the residual by rest scenario. Accuracy only — no prices.
//
// Usage: node scripts/backtest/nba-rest-study.js [--start 20241022] [--end 20250413]
// Source: ESPN NBA scoreboard (per-day). No key.
//
// RESULT (2024-25, 1234 games): floor screen PASSED as predicted. B2B MARGIN penalty −3.12 ± 0.75
// pts (t=4.2, clears the floor) — clean scenarios: both-rested −0.01, home-B2B −3.45, away-B2B
// +2.80. The margin/spread dampener is correctly sized (model-implied ~2.8 ≈ empirical 3.1). BUT
// the TOTAL-points effect is ~ZERO: 0-B2B 227.7 → 1-B2B 227.4 (drop −0.37, n.s.) — a tired team
// scores less AND defends worse, so the opponent scores more and the TOTAL barely moves. The model
// dampens the B2B team's λ by 2.5% (≈ −2.8 on the projected total), so it likely OVER-dampens
// TOTALS → a phantom UNDER lean on B2B games with no empirical support. ACTIONABLE L2: keep the B2B
// term for margin/spread, but neutralize its net effect on the game TOTAL. (Accuracy only — but this
// one removes false UNDER edges regardless of market, a model-honesty win.)

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const START = arg("--start", "20241022"); // 2024-25 regular season
const END   = arg("--end",   "20250413");

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

async function main() {
  // 1. Iterate dates → one scoreboard fetch each → completed regular-season finals.
  const dates = [];
  for (let d = dayNum(START); d <= dayNum(END); d++) dates.push(fmtDate(new Date(d * 864e5)));
  const games = [];
  await pool(dates, 10, async (ymd) => {
    const j = await _get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ymd}&limit=50`);
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
  if (games.length < 200) { console.log(`Only ${games.length} games — widen the range or check the source.`); return; }
  games.sort((a, b) => a.day - b.day);

  // 2. Rest = days since each team's previous game.
  const last = {};
  for (const g of games) {
    g.homeRest = last[g.home] != null ? g.day - last[g.home] : null;
    g.awayRest = last[g.away] != null ? g.day - last[g.away] : null;
    last[g.home] = g.day; last[g.away] = g.day;
  }

  // 3. Team strength = season avg point differential; HCA from the residual.
  const diffs = {};
  for (const g of games) {
    (diffs[g.home] ??= []).push(g.hs - g.as);
    (diffs[g.away] ??= []).push(g.as - g.hs);
  }
  const strength = {}; for (const t in diffs) strength[t] = mean(diffs[t]);
  const hca = mean(games.map(g => (g.hs - g.as) - (strength[g.home] - strength[g.away])));

  // 4. Residual home margin = actual − (strengthDiff + HCA). Keep games where both rests known.
  const rows = games.filter(g => g.homeRest != null && g.awayRest != null)
    .map(g => ({ ...g, resid: (g.hs - g.as) - ((strength[g.home] - strength[g.away]) + hca), restDiff: Math.max(-3, Math.min(3, g.homeRest - g.awayRest)) }));
  const residSD = Math.sqrt(variance(rows.map(r => r.resid)));

  // 5. Residual margin by rest scenario.
  const scen = (pred) => { const xs = rows.filter(pred).map(r => r.resid); return { n: xs.length, m: xs.length ? mean(xs) : 0 }; };
  const bothRested = scen(r => r.homeRest >= 2 && r.awayRest >= 2);
  const homeB2B    = scen(r => r.homeRest === 1 && r.awayRest >= 2);
  const awayB2B    = scen(r => r.awayRest === 1 && r.homeRest >= 2);
  const bothB2B    = scen(r => r.homeRest === 1 && r.awayRest === 1);

  // Pooled B2B margin penalty (team-on-B2B perspective): home-B2B → resid; away-B2B → −resid.
  const pen = [];
  for (const r of rows) {
    if (r.homeRest === 1 && r.awayRest >= 2) pen.push(r.resid);
    else if (r.awayRest === 1 && r.homeRest >= 2) pen.push(-r.resid);
  }
  const penM = mean(pen), penSE = Math.sqrt(variance(pen) / pen.length);

  // Correlation rest-diff vs residual margin.
  const mx = mean(rows.map(r => r.restDiff)), my = mean(rows.map(r => r.resid));
  let sxy = 0, sxx = 0, syy = 0;
  for (const r of rows) { const dx = r.restDiff - mx, dy = r.resid - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const restCorr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;

  // 6. Total points by number of B2B teams (tests the totals λ×0.975 dampener).
  const totBy = (k) => { const xs = rows.filter(r => ((r.homeRest === 1) + (r.awayRest === 1)) === k).map(r => r.hs + r.as); return { n: xs.length, m: xs.length ? mean(xs) : 0 }; };
  const t0 = totBy(0), t1 = totBy(1), t2 = totBy(2);

  // Model-implied B2B effect: totals dampener 0.975 on ~avg team points.
  const avgTeamPts = mean(games.map(g => (g.hs + g.as) / 2));
  const modelTotalsPenalty = avgTeamPts * (1 - 0.975); // pts a B2B team is dampened in the totals model

  console.log(`\nNBA rest / B2B study   ${START} … ${END}`);
  console.log(`${games.length} reg-season finals · ${rows.length} with rest known · HCA ${hca.toFixed(2)} · avg team pts ${avgTeamPts.toFixed(1)}`);
  console.log(`SAMPLING-FLOOR SCREEN: residual-margin SD ${residSD.toFixed(1)} · B2B n=${pen.length} → SE ${penSE.toFixed(2)} (signal must clear ~2·SE = ${(2 * penSE).toFixed(2)})\n`);

  console.log(`RESIDUAL HOME MARGIN by rest scenario (− = home underperformed expectation):`);
  console.log(`  both rested (2+/2+)   n=${String(bothRested.n).padStart(4)}  ${bothRested.m >= 0 ? "+" : ""}${bothRested.m.toFixed(2)}`);
  console.log(`  home B2B, away rested n=${String(homeB2B.n).padStart(4)}  ${homeB2B.m >= 0 ? "+" : ""}${homeB2B.m.toFixed(2)}  ← home tired`);
  console.log(`  away B2B, home rested n=${String(awayB2B.n).padStart(4)}  ${awayB2B.m >= 0 ? "+" : ""}${awayB2B.m.toFixed(2)}  ← away tired`);
  console.log(`  both B2B              n=${String(bothB2B.n).padStart(4)}  ${bothB2B.m >= 0 ? "+" : ""}${bothB2B.m.toFixed(2)}`);
  console.log(`  → r(restDiff, residMargin) = ${restCorr.toFixed(3)}\n`);

  const sig = Math.abs(penM) > 2 * penSE;
  console.log(`B2B MARGIN PENALTY (team on a B2B 2nd night): ${penM >= 0 ? "+" : ""}${penM.toFixed(2)} ± ${penSE.toFixed(2)} pts  ${sig ? "✓ clears the floor" : "✗ below the floor — inconclusive"}`);
  console.log(`B2B TOTAL-POINTS effect: 0 B2B ${t0.m.toFixed(1)} (n=${t0.n}) · 1 B2B ${t1.m.toFixed(1)} (n=${t1.n}) · 2 B2B ${t2.m.toFixed(1)} (n=${t2.n})`);
  console.log(`  drop 0→1 B2B team = ${(t1.m - t0.m).toFixed(2)} total pts\n`);

  console.log(`MODEL CHECK (totals dampener B2B_NBA=0.975 ⇒ a B2B team modeled ${modelTotalsPenalty.toFixed(1)} pts lighter):`);
  console.log(`  empirical B2B margin penalty ${Math.abs(penM).toFixed(1)} pts vs model-implied ~${modelTotalsPenalty.toFixed(1)} → ${Math.abs(penM) > modelTotalsPenalty + 2 * penSE ? "model UNDER-dampens" : Math.abs(penM) < modelTotalsPenalty - 2 * penSE ? "model OVER-dampens" : "model ≈ matches"}`);
  console.log(`\nRead: a real, floor-clearing B2B margin penalty that EXCEEDS the model's implied dampener`);
  console.log(`= the totals/spread B2B term is too soft (candidate L2 reweight). Accuracy only — whether`);
  console.log(`the MARKET already prices rest (it largely does) still needs forward shadow/CLV.\n`);
}
main();
