// ── Phase 2: NBA Backtest ──────────────────────────────────────────────────────
// NOT YET IMPLEMENTED. Data sources and implementation notes below.
//
// Categories: nba|props, nba|totalPoints, nba|teamPoints, nba|ml, nba|spread, nba|halves
//
// Data sources:
//   NBA Stats API (stats.nba.com) — game logs, player stats, team pace
//     - Game log:    https://stats.nba.com/stats/playergamelogs?Season=2023-24&SeasonType=Regular+Season
//     - Team game log: https://stats.nba.com/stats/teamgamelogs?Season=2023-24&SeasonType=Regular+Season
//     - Player info: https://stats.nba.com/stats/commonplayerinfo?PlayerID={id}
//   Basketball Reference (bbref) — historical season stats, injuries archive
//     - (scrape sparingly; prefer NBA Stats API)
//
// Sim functions available:
//   buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim, miscAdj, paceFactor, recentVals)
//   nbaDistPct(dist, threshold)
//   simulateNBATotalDist(homeMean, awayMean, homeStd, awayStd, nSim)
//   simulateNBAJoint(homeMean, awayMean, homeStd, awayStd, nSim)
//   mlPctFromJoint, spreadPctFromJoint, totalDistPct
//
// Key point-in-time features needed per game:
//   - Per-player: last 10-game rolling stats (points, rebounds, assists, etc.)
//   - Team pace ratio (rolling)
//   - DVP (defensive matchup factor) — needs per-position stats vs opponent
//   - B2B flag (team playing on back-to-back)
//   - Injury-adjusted OffRtg (MPG-weighted USG-out)
//
// Rollout notes:
//   - NBA Stats API has rate limits; add 200ms delay between requests in fetchAll
//   - Season IDs are "2023-24" format (not just year)
//   - Playoff vs regular season handled via SeasonType param
//   - Normal σ=13 for team totals — validate empirically from historical data before assuming

export async function collectNBASeason(season) {
  throw new Error("NBA Phase 2 not yet implemented. See index.js for data source notes.");
}

export function simulateAllNBA(data) {
  throw new Error("NBA Phase 2 not yet implemented.");
}
