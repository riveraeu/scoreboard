// NHL data collection for backtest.
// Fetches per-team season schedules from api-web.nhle.com, deduplicates games,
// and builds per-team rolling goal history for the simulator.
import { fetchAll } from "../cache.js";

const NHL_API = "https://api-web.nhle.com/v1";

// 32-team list for 2022-23 and 2023-24 (ARI was active both seasons).
// 2024-25+: replace ARI with UTA.
const NHL_TEAMS = [
  "ANA","ARI","BOS","BUF","CAR","CBJ","CGY","CHI","COL","DAL",
  "DET","EDM","FLA","LAK","MIN","MTL","NJD","NSH","NYI","NYR",
  "OTT","PHI","PIT","SEA","SJS","STL","TBL","TOR","VAN","VGK","WPG","WSH",
];

// year=2024 → "20232024"
export function nhlSeasonStr(year) {
  return `${year - 1}${year}`;
}

export async function collectNHLSeason(year) {
  const season = nhlSeasonStr(year);
  const teams  = year >= 2025 ? [...NHL_TEAMS.filter(t => t !== "ARI"), "UTA"] : NHL_TEAMS;
  console.log(`\n[collect] NHL ${season} — fetching ${teams.length} team schedules...`);

  const urls = teams.map(t => `${NHL_API}/club-schedule-season/${t}/${season}`);
  const schedules = await fetchAll(urls, 8, "NHL schedules");

  // Deduplicate games by id; keep only completed RS games (gameType=2).
  const gameMap = {};
  for (const sched of schedules) {
    for (const g of sched?.games ?? []) {
      if (g.gameType !== 2) continue;
      if (g.gameState !== "OFF" && g.gameState !== "FINAL") continue;
      const hScore = g.homeTeam?.score;
      const aScore = g.awayTeam?.score;
      if (hScore == null || aScore == null) continue;
      gameMap[g.id] = {
        gameId:    g.id,
        date:      g.gameDate,
        homeTeam:  g.homeTeam.abbrev,
        awayTeam:  g.awayTeam.abbrev,
        homeGoals: hScore,
        awayGoals: aScore,
      };
    }
  }

  const games = Object.values(gameMap).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  Unique RS games: ${games.length}`);

  // Per-team chronological goal history (goals scored + goals allowed for defensive adj).
  const teamHistory = {};
  for (const g of games) {
    (teamHistory[g.homeTeam] ??= []).push({ date: g.date, goals: g.homeGoals, goalsAllowed: g.awayGoals });
    (teamHistory[g.awayTeam] ??= []).push({ date: g.date, goals: g.awayGoals, goalsAllowed: g.homeGoals });
  }

  return { year, season, games, teamHistory };
}
