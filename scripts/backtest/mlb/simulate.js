// MLB simulation runner. For each game, reconstructs features and runs all MLB category sims.
// Returns rows[] compatible with calibration.js summarize().
import {
  PARK_KFACTOR, PARK_HITFACTOR, PARK_RUNFACTOR, UMPIRE_KFACTOR,
  simulateKsDist, kDistPct,
  simulateMLBTotalDist, totalDistPct,
  simulateTeamTotalDist,
  simulateMLBJoint, mlPctFromJoint, spreadPctFromJoint,
} from "../../../api/lib/simulate.js";
import {
  pitcherStatsAsOf, buildOrderedKPcts,
  batterBA, lineupOPS, teamRunLambda, fitNegBinR,
} from "./features.js";

// Ks thresholds — same range as live model
const K_THRESHOLDS = [4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5];
// Total runs thresholds
const TOTAL_THRESHOLDS  = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11];
// Team run thresholds
const TEAM_THRESHOLDS   = [2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7];
// HRR threshold (1+ hit)
const HRR_THRESHOLD = 1;
// Spread configs: positive line magnitude + side (mirrors spreadPctFromJoint signature)
const SPREAD_CONFIGS = [
  { line: 1.5, side: "home" },
  { line: 1.5, side: "away" },
  { line: 2.5, side: "home" },
  { line: 2.5, side: "away" },
];

// HRR logit formula — mirrors the live model's logit-sigmoid path in props.js.
// simulateHits (the old backtest approach) used a per-PA multiplicative formula
// (hitProb = ba × pitcherBAA/leagueBA per 4 PAs) that amplified pitcher effects
// at the tails by 3–10pp, causing systematic overconfidence (−3 to −16 delta
// across all bands in 2024 backtest). The logit formula matches the live model:
// convert seasonal BA to a per-game rate, then apply park/pitcher/OPS/WHIP in
// logit (additive) space — bounded vs the multiplicative-per-PA compounding.
const LEAGUE_BA_HRR  = 0.248;
const LEAGUE_OPS_HRR = 0.720;
const LEAGUE_WHIP_HRR = 1.30;
// Effective at-bat count per game. MLB teams average ~3.5 AB/batter/game, but
// game-to-game form variance (pitcher stuff that day, batter slump/hot streak,
// early removal) inflates 0-hit games beyond what pure Binomial predicts.
// Calibrated at 3.0 to match 2024 observed per-game hit rates across all bands.
const N_EFF_AB = 3.0;

function hrrLogitTruePct(bBA, pitcherStats, parkHitFactor, hitterOPS) {
  // Base per-game hit rate from seasonal BA with calibrated effective PA count
  const rawGameRate = 1 - Math.pow(1 - Math.max(0.05, Math.min(0.50, bBA)), N_EFF_AB);

  // Pitcher quality: BAA vs league in logit space (additive, not multiplicative per-PA)
  const pitcherBAA = pitcherStats?.baa ?? LEAGUE_BA_HRR;
  const pitcherAdj = Math.log(pitcherBAA / LEAGUE_BA_HRR);

  // OPS adjustment (weight 0.4 — same as live model)
  const opsAdj = hitterOPS != null
    ? Math.max(0.85, Math.min(1.15, hitterOPS / LEAGUE_OPS_HRR))
    : 1.0;

  // WHIP adjustment (weight 0.3 — same as live model)
  const whip = pitcherStats?.whip;
  const whipAdj = whip != null
    ? Math.max(0.92, Math.min(1.08, Math.pow(whip / LEAGUE_WHIP_HRR, 0.5)))
    : 1.0;

  const p = Math.max(0.01, Math.min(0.99, rawGameRate));
  const logOdds = Math.log(p / (1 - p))
    + pitcherAdj
    + Math.log(Math.max(0.5, parkHitFactor))
    + 0.4 * Math.log(opsAdj)
    + 0.3 * Math.log(whipAdj);

  return parseFloat((100 / (1 + Math.exp(-logOdds))).toFixed(1));
}

// Normalize team abbreviation for park factor lookup.
const normAbbr = abbr => {
  const MAP = { CWS: "CWS", CHW: "CWS", OAK: "ATH" };
  return MAP[abbr] ?? abbr;
};

function normUmpire(name) {
  if (!name) return null;
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

export function simulateAllMLB(data) {
  const {
    games, pitcherGamelogMap, pitcherPriorStats, pitcherHandById,
    batterSplitsVL, batterSplitsVR, batterSeason,
  } = data;

  // Pre-compute NegBin r from all observed per-team run totals this season
  const allRunTotals = [];
  for (const g of games) {
    if (g.homeRuns != null) allRunTotals.push(g.homeRuns);
    if (g.awayRuns  != null) allRunTotals.push(g.awayRuns);
  }
  const negBinR = fitNegBinR(allRunTotals);
  console.log(`\n[simulate] NegBin r = ${negBinR} (from ${allRunTotals.length} team-game run totals)`);

  const rows = [];
  let skipped = 0;

  for (const game of games) {
    const {
      gameDate, homeAbbr, awayAbbr, umpireName,
      homeStarterId, awayStarterId,
      homeStarterBF, awayStarterBF,
      homeStarterKs, awayStarterKs,
      homeStarterH, awayStarterH,
      homeBatters, awayBatters, batterHits,
      homeRuns, awayRuns,
      homePitcherHand: homePitcherHandSched,
      awayPitcherHand: awayPitcherHandSched,
    } = game;

    const homeNorm = normAbbr(homeAbbr);
    const awayNorm = normAbbr(awayAbbr);
    const parkKFactor   = PARK_KFACTOR[homeNorm]   ?? 1;
    const parkHitFactor = PARK_HITFACTOR[homeNorm]  ?? 1;
    const parkRunFactor = PARK_RUNFACTOR[homeNorm]  ?? 1;
    const umpireK = UMPIRE_KFACTOR[normUmpire(umpireName)] ?? 1.0;

    // Pitcher stats (point-in-time)
    const homeP = homeStarterId
      ? pitcherStatsAsOf(homeStarterId, gameDate, pitcherGamelogMap, pitcherPriorStats, pitcherHandById)
      : null;
    const awayP = awayStarterId
      ? pitcherStatsAsOf(awayStarterId, gameDate, pitcherGamelogMap, pitcherPriorStats, pitcherHandById)
      : null;

    // Use gamelog-derived hand; fall back to scheduled probable pitcher hand
    const homePHand = homeP?.hand ?? homePitcherHandSched;
    const awayPHand = awayP?.hand ?? awayPitcherHandSched;

    // ── STRIKEOUTS ──
    // Home starter vs away batters
    if (homeP && homeStarterKs != null && (homeStarterBF ?? 0) >= 3) {
      const ordKPcts = buildOrderedKPcts(awayBatters, homePHand, batterSplitsVL, batterSplitsVR, batterSeason);
      if (ordKPcts.length >= 6) {
        const pitcherAdj = Math.min(40, homeP.kPct * umpireK);
        const dist = simulateKsDist(ordKPcts, pitcherAdj, parkKFactor, 5000, Math.round(homeP.avgBF), 0, homeP.stdBF);
        if (dist) {
          for (const threshold of K_THRESHOLDS) {
            rows.push({
              date: gameDate, category: "mlb|strikeouts",
              subject: `${homeAbbr}:${homeStarterId}`,
              homeTeam: homeAbbr, awayTeam: awayAbbr,
              threshold,
              truePct: kDistPct(dist, threshold),
              actualValue: homeStarterKs,
              hit: homeStarterKs >= threshold ? 1 : 0,
            });
          }
        }
      }
    }
    // Away starter vs home batters
    if (awayP && awayStarterKs != null && (awayStarterBF ?? 0) >= 3) {
      const ordKPcts = buildOrderedKPcts(homeBatters, awayPHand, batterSplitsVL, batterSplitsVR, batterSeason);
      if (ordKPcts.length >= 6) {
        const pitcherAdj = Math.min(40, awayP.kPct * umpireK);
        const dist = simulateKsDist(ordKPcts, pitcherAdj, parkKFactor, 5000, Math.round(awayP.avgBF), 0, awayP.stdBF);
        if (dist) {
          for (const threshold of K_THRESHOLDS) {
            rows.push({
              date: gameDate, category: "mlb|strikeouts",
              subject: `${awayAbbr}:${awayStarterId}`,
              homeTeam: homeAbbr, awayTeam: awayAbbr,
              threshold,
              truePct: kDistPct(dist, threshold),
              actualValue: awayStarterKs,
              hit: awayStarterKs >= threshold ? 1 : 0,
            });
          }
        }
      }
    }

    if (!homeP || !awayP || homeRuns == null || awayRuns == null) {
      skipped++;
      continue; // need both pitchers + scores for total/ML/spread
    }

    // Lineup OPS for lambda computation
    const homeOPS = lineupOPS(homeBatters, batterSeason);
    const awayOPS = lineupOPS(awayBatters, batterSeason);

    // Home team bats against away pitcher; away team bats against home pitcher
    const homeLambda = teamRunLambda(awayP, homeOPS, parkRunFactor);
    const awayLambda = teamRunLambda(homeP, awayOPS, parkRunFactor);

    // ── TOTAL RUNS ──
    const totalDist = simulateMLBTotalDist(homeLambda, awayLambda, negBinR, 10000);
    if (totalDist) {
      const actualTotal = homeRuns + awayRuns;
      for (const threshold of TOTAL_THRESHOLDS) {
        rows.push({
          date: gameDate, category: "mlb|totalRuns",
          subject: `${homeAbbr}vs${awayAbbr}`,
          homeTeam: homeAbbr, awayTeam: awayAbbr,
          threshold,
          truePct: totalDistPct(totalDist, threshold),
          actualValue: actualTotal,
          hit: actualTotal >= threshold ? 1 : 0,
        });
      }
    }

    // ── TEAM RUNS ──
    const homeTeamDist = simulateTeamTotalDist(homeLambda, 10000, negBinR);
    const awayTeamDist = simulateTeamTotalDist(awayLambda, 10000, negBinR);
    if (homeTeamDist && homeRuns != null) {
      for (const threshold of TEAM_THRESHOLDS) {
        rows.push({
          date: gameDate, category: "mlb|teamRuns",
          subject: homeAbbr,
          homeTeam: homeAbbr, awayTeam: awayAbbr,
          threshold,
          truePct: totalDistPct(homeTeamDist, threshold),
          actualValue: homeRuns,
          hit: homeRuns >= threshold ? 1 : 0,
        });
      }
    }
    if (awayTeamDist && awayRuns != null) {
      for (const threshold of TEAM_THRESHOLDS) {
        rows.push({
          date: gameDate, category: "mlb|teamRuns",
          subject: awayAbbr,
          homeTeam: homeAbbr, awayTeam: awayAbbr,
          threshold,
          truePct: totalDistPct(awayTeamDist, threshold),
          actualValue: awayRuns,
          hit: awayRuns >= threshold ? 1 : 0,
        });
      }
    }

    // ── ML ──
    const joint = simulateMLBJoint(homeLambda, awayLambda, negBinR, 10000);
    if (joint) {
      // mlPctFromJoint returns home win % (ties dropped); away = complement
      const homeMlPct = mlPctFromJoint(joint.home, joint.away);
      const awayMlPct = homeMlPct != null ? parseFloat((100 - homeMlPct).toFixed(1)) : null;
      const homeWon = homeRuns > awayRuns ? 1 : 0;
      const awayWon = awayRuns > homeRuns ? 1 : 0;
      if (homeMlPct != null) {
        rows.push({
          date: gameDate, category: "mlb|ml",
          subject: homeAbbr,
          homeTeam: homeAbbr, awayTeam: awayAbbr,
          threshold: 0.5,
          truePct: homeMlPct,
          actualValue: homeRuns,
          hit: homeWon,
        });
        rows.push({
          date: gameDate, category: "mlb|ml",
          subject: awayAbbr,
          homeTeam: homeAbbr, awayTeam: awayAbbr,
          threshold: 0.5,
          truePct: awayMlPct,
          actualValue: awayRuns,
          hit: awayWon,
        });
      }

      // ── SPREAD ──
      for (const { line, side } of SPREAD_CONFIGS) {
        const coverPct = spreadPctFromJoint(joint.home, joint.away, line, side);
        if (coverPct == null) continue;
        const margin = homeRuns - awayRuns;
        const covered = side === "home" ? margin > line : margin < -line;
        rows.push({
          date: gameDate, category: "mlb|spread",
          subject: `${side === "home" ? homeAbbr : awayAbbr}${side === "home" ? `-${line}` : `+${line}`}`,
          homeTeam: homeAbbr, awayTeam: awayAbbr,
          threshold: line,
          truePct: coverPct,
          actualValue: margin,
          hit: covered ? 1 : 0,
        });
      }
    }

    // ── HRR (1+ hit per batter) ──
    // Home batters vs away pitcher
    if (awayP && awayStarterH != null && (awayStarterBF ?? 0) >= 3) {
      for (const batterId of homeBatters) {
        const bBA = batterBA(batterId, awayPHand, batterSplitsVL, batterSplitsVR, batterSeason);
        const hits = batterHits[batterId];
        if (hits == null) continue;
        const hitterOPS = batterSeason[batterId]?.ops ?? null;
        const truePct = hrrLogitTruePct(bBA, awayP, parkHitFactor, hitterOPS);
        rows.push({
          date: gameDate, category: "mlb|hrr",
          subject: String(batterId),
          homeTeam: homeAbbr, awayTeam: awayAbbr,
          threshold: HRR_THRESHOLD,
          truePct,
          actualValue: hits,
          hit: hits >= HRR_THRESHOLD ? 1 : 0,
        });
      }
    }
    // Away batters vs home pitcher
    if (homeP && homeStarterH != null && (homeStarterBF ?? 0) >= 3) {
      for (const batterId of awayBatters) {
        const bBA = batterBA(batterId, homePHand, batterSplitsVL, batterSplitsVR, batterSeason);
        const hits = batterHits[batterId];
        if (hits == null) continue;
        const hitterOPS = batterSeason[batterId]?.ops ?? null;
        const truePct = hrrLogitTruePct(bBA, homeP, parkHitFactor, hitterOPS);
        rows.push({
          date: gameDate, category: "mlb|hrr",
          subject: String(batterId),
          homeTeam: homeAbbr, awayTeam: awayAbbr,
          threshold: HRR_THRESHOLD,
          truePct,
          actualValue: hits,
          hit: hits >= HRR_THRESHOLD ? 1 : 0,
        });
      }
    }
  }

  console.log(`[simulate] ${rows.length} rows generated (${skipped} games skipped — missing pitcher/score data)`);
  return rows;
}
