// NBA simulation runner for backtest calibration.
// Reconstructs point-in-time rolling averages and runs the same
// Normal-distribution model as the live model (no DVP, no injury adj —
// those are too expensive to reconstruct historically).
import {
  buildNbaStatDist, nbaDistPct,
  simulateNBAJoint,
  simulateTeamPtsDist, totalDistPct,
  mlPctFromJoint, spreadPctFromJoint,
} from "../../../api/lib/simulate.js";

// Thresholds — chosen to give calibration data across all truePct bands.
const GAME_TOTAL_THRESHOLDS = [200.5, 205.5, 210.5, 215.5, 220.5, 225.5, 230.5, 235.5, 240.5];
const TEAM_TOTAL_THRESHOLDS = [90.5, 95.5, 100.5, 105.5, 110.5, 115.5, 120.5, 125.5, 130.5];
const PTS_THRESHOLDS        = [9.5, 11.5, 13.5, 15.5, 17.5, 19.5, 21.5, 23.5, 25.5, 27.5, 29.5];
const SPREAD_CONFIGS        = [
  { line: 2.5, side: "home" }, { line: 2.5, side: "away" },
  { line: 5.5, side: "home" }, { line: 5.5, side: "away" },
  { line: 8.5, side: "home" }, { line: 8.5, side: "away" },
];

// σ=13 matches the NBA live model (simulate.js simulateNBAJoint default).
// σ=11 is WNBA. Empirical test showed NBA actual σ≈12.08 — σ=13 is the right assumption.
const TEAM_STD = 13;

// League-average pts per team per game (used for defensive adjustment).
// 2023-24: 113.1 pts/team/game. Adjust per season if running 2022-23 etc.
const LEAGUE_AVG_PTS = { 2024: 113.1, 2023: 112.1, 2022: 110.6 };

// Compute exp-decay weighted mean (most recent = last element, HALF_LIFE=5 games).
function weightedMean(vals) {
  const n = Math.min(10, vals.length);
  const DECAY = Math.log(2) / 5;
  let sumW = 0, sumWV = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.exp(-DECAY * i);
    sumW += w; sumWV += w * vals[n - 1 - i]; // i=0 → most recent (last element)
  }
  return sumWV / sumW;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function simulateAllNBA(data, oddsMap = new Map()) {
  const { games, teamHistory, playerHistory, gamePlayerIndex } = data;
  const rows = [];
  let gamesProcessed = 0, gamesSkipped = 0;

  // Empirical σ — compute from first ~quarter of season after 10-game warmup
  const allTeamScores = {};
  for (const [team, hist] of Object.entries(teamHistory)) {
    allTeamScores[team] = hist.map(g => g.pts);
  }
  // Empirical per-team std (avg across all teams, for reporting)
  let empStdSum = 0, empStdN = 0;
  for (const scores of Object.values(allTeamScores)) {
    if (scores.length < 20) continue;
    const mu = scores.reduce((a, b) => a + b) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mu) ** 2, 0) / scores.length;
    empStdSum += Math.sqrt(variance);
    empStdN++;
  }
  const empStd = empStdN > 0 ? parseFloat((empStdSum / empStdN).toFixed(2)) : null;
  console.log(`\n[simulate] NBA — empirical team σ = ${empStd} (model uses σ=${TEAM_STD})`);

  for (const game of games) {
    const { gameId, date, homeTeam, awayTeam, homePts, awayPts } = game;

    // Rolling 10-game history entering this game (strictly prior dates).
    const homePrior = (teamHistory[homeTeam] ?? []).filter(g => g.date < date);
    const awayPrior = (teamHistory[awayTeam] ?? []).filter(g => g.date < date);

    if (homePrior.length < 5 || awayPrior.length < 5) { gamesSkipped++; continue; }

    const homeLast10 = homePrior.slice(-10);
    const awayLast10 = awayPrior.slice(-10);
    const homeMean = weightedMean(homeLast10.map(g => g.pts));
    const awayMean = weightedMean(awayLast10.map(g => g.pts));

    // Defensive adjustment: expected points = raw scoring × (opponent def / league avg).
    // Without this, teams that faced weak defenses look artificially strong and vice versa,
    // creating extreme ML win probabilities that don't hold up (80-85% model → 58% actual).
    const lgAvg = LEAGUE_AVG_PTS[data.year] ?? 113.1;
    const homeDefAllowed = weightedMean(homeLast10.map(g => g.ptsAllowed)); // how much home allows
    const awayDefAllowed = weightedMean(awayLast10.map(g => g.ptsAllowed)); // how much away allows
    const homeOffAdj = clamp(awayDefAllowed / lgAvg, 0.85, 1.15); // home scores vs away defense
    const awayOffAdj = clamp(homeDefAllowed / lgAvg, 0.85, 1.15); // away scores vs home defense
    const homeAdjMean = homeMean * homeOffAdj;
    const awayAdjMean = awayMean * awayOffAdj;

    // B2B detection.
    const yday = new Date(date + "T12:00:00Z");
    yday.setDate(yday.getDate() - 1);
    const yesterday = yday.toISOString().slice(0, 10);
    const homeB2B = homePrior.some(g => g.date === yesterday);
    const awayB2B = awayPrior.some(g => g.date === yesterday);

    // ── JOINT SIM (reused for total, ML, spread, team total) ─────────────────
    const homeMeanAdj = homeAdjMean * (homeB2B ? 0.93 : 1.0);
    const awayMeanAdj = awayAdjMean * (awayB2B ? 0.93 : 1.0);
    const joint = simulateNBAJoint(homeMeanAdj, awayMeanAdj, TEAM_STD, TEAM_STD, 10000);
    if (!joint) { gamesSkipped++; continue; }

    const actualTotal = homePts + awayPts;
    const margin      = homePts - awayPts;

    // ── GAME TOTAL ────────────────────────────────────────────────────────────
    for (const threshold of GAME_TOTAL_THRESHOLDS) {
      let hits = 0;
      for (let i = 0; i < joint.home.length; i++) {
        if (joint.home[i] + joint.away[i] >= threshold) hits++;
      }
      const tp = parseFloat((hits / joint.home.length * 100).toFixed(1));
      rows.push({
        date, category: "nba|totalPoints",
        subject: `${homeTeam}vs${awayTeam}`,
        homeTeam, awayTeam, threshold,
        truePct: tp, actualValue: actualTotal,
        hit: actualTotal >= threshold ? 1 : 0,
        marketPct: null, edge: null,
      });
    }

    // ── TEAM TOTALS ───────────────────────────────────────────────────────────
    for (const threshold of TEAM_TOTAL_THRESHOLDS) {
      rows.push({
        date, category: "nba|teamPoints", subject: homeTeam,
        homeTeam, awayTeam, threshold,
        truePct: totalDistPct(joint.home, threshold),
        actualValue: homePts, hit: homePts >= threshold ? 1 : 0,
        marketPct: null, edge: null,
      });
      rows.push({
        date, category: "nba|teamPoints", subject: awayTeam,
        homeTeam, awayTeam, threshold,
        truePct: totalDistPct(joint.away, threshold),
        actualValue: awayPts, hit: awayPts >= threshold ? 1 : 0,
        marketPct: null, edge: null,
      });
    }

    // ── ML ────────────────────────────────────────────────────────────────────
    const homeMlPct = mlPctFromJoint(joint.home, joint.away);
    if (homeMlPct != null) {
      const awayMlPct = parseFloat((100 - homeMlPct).toFixed(1));
      rows.push({
        date, category: "nba|ml", subject: homeTeam,
        homeTeam, awayTeam, threshold: 0.5,
        truePct: homeMlPct, actualValue: homePts, hit: homePts > awayPts ? 1 : 0,
        marketPct: null, edge: null,
      });
      rows.push({
        date, category: "nba|ml", subject: awayTeam,
        homeTeam, awayTeam, threshold: 0.5,
        truePct: awayMlPct, actualValue: awayPts, hit: awayPts > homePts ? 1 : 0,
        marketPct: null, edge: null,
      });
    }

    // ── SPREAD ────────────────────────────────────────────────────────────────
    for (const { line, side } of SPREAD_CONFIGS) {
      const coverPct = spreadPctFromJoint(joint.home, joint.away, line, side);
      if (coverPct == null) continue;
      const covered = side === "home" ? margin > line : margin < -line;
      rows.push({
        date, category: "nba|spread",
        subject: `${side === "home" ? homeTeam : awayTeam}${side === "home" ? `-${line}` : `+${line}`}`,
        homeTeam, awayTeam, threshold: line,
        truePct: coverPct, actualValue: margin,
        hit: covered ? 1 : 0,
        marketPct: null, edge: null,
      });
    }

    // ── PLAYER POINTS PROPS ───────────────────────────────────────────────────
    const gamePlayers = gamePlayerIndex[gameId] ?? [];
    for (const { playerId, team: playerTeam, min, pts: actualPts } of gamePlayers) {
      if (min < 10) continue; // skip DNP / garbage-time
      const ph = playerHistory[playerId];
      if (!ph) continue;

      const priorGames = ph.games.filter(g => g.date < date);
      if (priorGames.length < 5) continue;

      const last10pts = priorGames.slice(-10).map(g => g.pts);
      const isB2B     = playerTeam === homeTeam ? homeB2B : awayB2B;

      const dist = buildNbaStatDist(last10pts, null, null, isB2B, 5000);
      if (!dist) continue;

      for (const threshold of PTS_THRESHOLDS) {
        const tp = nbaDistPct(dist, threshold);
        if (tp == null) continue;
        rows.push({
          date, category: "nba|props",
          subject: ph.name,
          homeTeam, awayTeam, threshold,
          truePct: tp, actualValue: actualPts,
          hit: actualPts >= threshold ? 1 : 0,
          marketPct: null, edge: null,
        });
      }
    }

    gamesProcessed++;
  }

  console.log(`[simulate] NBA — ${rows.length} rows from ${gamesProcessed} games (${gamesSkipped} skipped — warmup)`);
  return rows;
}
