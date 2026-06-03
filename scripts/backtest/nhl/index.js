// ── Phase 3: NHL Backtest ──────────────────────────────────────────────────────
// NOT YET IMPLEMENTED. Data sources and implementation notes below.
//
// Categories: nhl|props, nhl|totalGoals, nhl|teamGoals, nhl|ml, nhl|spread
//
// Data sources:
//   NHL Stats API — https://api-web.nhle.com
//     - Schedule:    https://api-web.nhle.com/v1/schedule/{date}
//     - Game boxscore: https://api-web.nhle.com/v1/gamecenter/{gameId}/boxscore
//     - Player game log: https://api-web.nhle.com/v1/player/{id}/game-log/{season}/{gameType}
//     - Goalie stats:  https://api-web.nhle.com/v1/goalie-stats-leaders/{season}/{gameType}
//   Natural Stat Trick (nst.gg) — PP/PK percentages, Corsi, historical data
//     - (scrape during off-hours; prefer NHL Stats API for player stats)
//
// Sim functions available:
//   buildNbaStatDist (reused for NHL props — TOI-adjusted)
//   simulateNHLTotalDist(homeLambda, awayLambda, r, nSim)  [Poisson in legacy, NegBin since 2026-05-29]
//   simulateMLBJoint (reused for NHL ML — per-team NegBin is sport-agnostic)
//   mlPctFromJoint, spreadPctFromJoint, totalDistPct
//
// Key point-in-time features needed per game:
//   - Starting goalie SV% (rolling) — identify actual starter from boxscore
//   - Team PP% and PK% (rolling) — net special-teams factor clamped ±10%
//   - Per-player: last 10 games TOI, shots, goals, assists for props
//   - NegBin r fitted from historical per-team goal totals (typically r=5-8 for NHL goals)
//   - NHL_ABBR_MAP from api/lib/nhl.js for team ID→abbreviation
//   - Spread dampener: 0.80×sim + 0.20×65 (from CLAUDE.md 2026-05-29 note)
//
// Rollout notes:
//   - NHL API changed base URL in 2023-24 season to api-web.nhle.com
//   - UTA (Utah Mammoth) teamId=68 (rebranded 2025-26; old teamId=53 is invalid)
//   - Playoff games use different gameType code (3 vs 2 for regular season)
//   - Season IDs: "20232024" format

export async function collectNHLSeason(season) {
  throw new Error("NHL Phase 3 not yet implemented. See index.js for data source notes.");
}

export function simulateAllNHL(data) {
  throw new Error("NHL Phase 3 not yet implemented.");
}
