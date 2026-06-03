// NHL simulation runner for backtest calibration.
// Uses the same NegBin model as the live NHL total/ML/spread surfaces.
// Spread dampener (0.80×sim + 0.20×65) matches the live model tuned 2026-05-29.
// Props (nhl|props) not included — needs per-player game log fetching.
import {
  simulateNHLTotalDist, simulateMLBJoint,
  mlPctFromJoint, spreadPctFromJoint, totalDistPct,
} from "../../../api/lib/simulate.js";

const TOTAL_THRESHOLDS = [3.5, 4.5, 5.5, 6.5, 7.5, 8.5];
const TEAM_THRESHOLDS  = [1.5, 2.5, 3.5, 4.5, 5.5];
const SPREAD_CONFIGS   = [
  { line: 1.5, side: "home" },
  { line: 1.5, side: "away" },
];

// Spread dampener from live model (landed 2026-05-29 after 50%→83% calibration miss).
const SPREAD_DAMPENER = 0.80;
const SPREAD_ANCHOR   = 65.0;

// NHL average goals per team per game.
const LEAGUE_AVG_GOALS = { 2025: 3.08, 2024: 3.08, 2023: 3.14, 2022: 3.09 };

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Exp-decay weighted mean (most recent = last element, HALF_LIFE=5).
function weightedMean(vals) {
  const n = Math.min(10, vals.length);
  const DECAY = Math.log(2) / 5;
  let sumW = 0, sumWV = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.exp(-DECAY * i);
    sumW += w; sumWV += w * vals[n - 1 - i];
  }
  return sumWV / sumW;
}

// Fit NegBin r by moment-matching: r = μ²/(Var − μ).
function fitNegBinR(samples) {
  if (!samples || samples.length < 10) return 5;
  const mu = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mu) ** 2, 0) / samples.length;
  if (variance <= mu) return 8;
  const r = mu * mu / (variance - mu);
  return parseFloat(Math.max(2, Math.min(12, r)).toFixed(2));
}

export function simulateAllNHL(data, oddsMap = new Map()) {
  const { year, games, teamHistory } = data;

  // Fit NegBin r from all per-team goal totals this season.
  const allGoals = Object.values(teamHistory).flatMap(h => h.map(g => g.goals));
  const negBinR  = fitNegBinR(allGoals);
  console.log(`\n[simulate] NHL ${year} — NegBin r = ${negBinR} (from ${allGoals.length} team-game goal totals)`);

  const lgAvg = LEAGUE_AVG_GOALS[year] ?? 3.08;
  const rows = [];
  let processed = 0, skipped = 0;

  for (const game of games) {
    const { date, homeTeam, awayTeam, homeGoals, awayGoals } = game;

    const homePrior = (teamHistory[homeTeam] ?? []).filter(g => g.date < date);
    const awayPrior = (teamHistory[awayTeam] ?? []).filter(g => g.date < date);

    if (homePrior.length < 5 || awayPrior.length < 5) { skipped++; continue; }

    const homeLast10 = homePrior.slice(-10);
    const awayLast10 = awayPrior.slice(-10);

    const homeGoalMean   = weightedMean(homeLast10.map(g => g.goals));
    const awayGoalMean   = weightedMean(awayLast10.map(g => g.goals));
    const homeDefAllowed = weightedMean(homeLast10.map(g => g.goalsAllowed));
    const awayDefAllowed = weightedMean(awayLast10.map(g => g.goalsAllowed));

    // Defensive adjustment — clamped tighter than NBA (NHL scoring is less variable).
    const homeOffAdj = clamp(awayDefAllowed / lgAvg, 0.80, 1.20);
    const awayOffAdj = clamp(homeDefAllowed / lgAvg, 0.80, 1.20);
    const homeLambda = homeGoalMean * homeOffAdj;
    const awayLambda = awayGoalMean * awayOffAdj;
    // NOTE: ML/spread results are unreliable in this simplified backtest — without goalie
    // SV% and PP/PK factors the rolling goal averages create inflated λ differences that
    // generate over-confident win probabilities (Δ -20 to -25 at 75-85%). The live model
    // includes goalie SV% factor and PP/PK net adj which moderate λ differences. Use
    // nhl|totalGoals and nhl|teamGoals for calibration decisions; shadow calib will give
    // the real ML/spread signal once n≥30 per band.

    // ── TOTAL GOALS ───────────────────────────────────────────────────────────
    const totalDist = simulateNHLTotalDist(homeLambda, awayLambda, negBinR, 10000);
    if (totalDist) {
      const actualTotal = homeGoals + awayGoals;
      for (const threshold of TOTAL_THRESHOLDS) {
        rows.push({
          date, category: "nhl|totalGoals",
          subject: `${homeTeam}vs${awayTeam}`,
          homeTeam, awayTeam, threshold,
          truePct: totalDistPct(totalDist, threshold),
          actualValue: actualTotal,
          hit: actualTotal >= threshold ? 1 : 0,
          marketPct: null, edge: null,
        });
      }
    }

    // ── JOINT (ML + spread + team totals) ────────────────────────────────────
    const joint = simulateMLBJoint(homeLambda, awayLambda, negBinR, 10000);
    if (!joint) { processed++; continue; }

    // ── TEAM GOALS ────────────────────────────────────────────────────────────
    for (const threshold of TEAM_THRESHOLDS) {
      rows.push({
        date, category: "nhl|teamGoals", subject: homeTeam,
        homeTeam, awayTeam, threshold,
        truePct: totalDistPct(joint.home, threshold),
        actualValue: homeGoals, hit: homeGoals >= threshold ? 1 : 0,
        marketPct: null, edge: null,
      });
      rows.push({
        date, category: "nhl|teamGoals", subject: awayTeam,
        homeTeam, awayTeam, threshold,
        truePct: totalDistPct(joint.away, threshold),
        actualValue: awayGoals, hit: awayGoals >= threshold ? 1 : 0,
        marketPct: null, edge: null,
      });
    }

    // ── ML ────────────────────────────────────────────────────────────────────
    // Ties are dropped (regulation-only approximation — real games go to OT/SO).
    const homeMlPct = mlPctFromJoint(joint.home, joint.away);
    if (homeMlPct != null) {
      const awayMlPct = parseFloat((100 - homeMlPct).toFixed(1));
      // OT winner tracked as +1 goal over the loser in reality but not in our Poisson model.
      // Regulation ties (~22% of NHL games) resolve in OT/SO; home wins OT ~55% → slight
      // upward bias for home team in actual outcomes vs regulation-only model. Acceptable.
      const homeWon = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0 : 0;
      const awayWon = awayGoals > homeGoals ? 1 : homeGoals === awayGoals ? 0 : 0;
      rows.push({
        date, category: "nhl|ml", subject: homeTeam,
        homeTeam, awayTeam, threshold: 0.5,
        truePct: homeMlPct, actualValue: homeGoals, hit: homeWon,
        marketPct: null, edge: null,
      });
      rows.push({
        date, category: "nhl|ml", subject: awayTeam,
        homeTeam, awayTeam, threshold: 0.5,
        truePct: awayMlPct, actualValue: awayGoals, hit: awayWon,
        marketPct: null, edge: null,
      });
    }

    // ── SPREAD ────────────────────────────────────────────────────────────────
    // Spread dampener: 0.80×sim + 0.20×65. Matches the live model tuned on 2026-05-29
    // after finding 83% simulated → 50% actual (Poisson over-confidence on ±1.5 NHL line).
    for (const { line, side } of SPREAD_CONFIGS) {
      const rawPct = spreadPctFromJoint(joint.home, joint.away, line, side);
      if (rawPct == null) continue;
      const dampedPct = parseFloat((SPREAD_DAMPENER * rawPct + (1 - SPREAD_DAMPENER) * SPREAD_ANCHOR).toFixed(1));
      const margin = homeGoals - awayGoals;
      const covered = side === "home" ? margin > line : margin < -line;
      rows.push({
        date, category: "nhl|spread",
        subject: `${side === "home" ? homeTeam : awayTeam}${side === "home" ? `-${line}` : `+${line}`}`,
        homeTeam, awayTeam, threshold: line,
        truePct: dampedPct,
        actualValue: margin,
        hit: covered ? 1 : 0,
        marketPct: null, edge: null,
      });
    }

    processed++;
  }

  console.log(`[simulate] NHL ${year} — ${rows.length} rows from ${processed} games (${skipped} skipped — warmup)`);
  return rows;
}
