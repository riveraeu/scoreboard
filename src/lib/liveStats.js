// Live stat helpers for pick card tracking

const STAT_LABEL_LIVE = {
  strikeouts: "K",
  hrr: "HRR",
  hits: "H",
  points: "PTS",
  rebounds: "REB",
  assists: "AST",
  threePointers: "3PM",
};

// Build the games param key for a pick (used to call /api/live and to look up results)
export function buildLiveGameKey(pick) {
  if (pick.gameType === "total") return `${pick.sport}:${pick.awayTeam}:${pick.homeTeam}`;
  if (pick.gameType === "teamTotal") return `${pick.sport}:${pick.scoringTeam}:${pick.oppTeam}`;
  // Player prop — playerTeam + opponent (either order; backend matches both)
  return `${pick.sport}:${pick.playerTeam}:${pick.opponent}`;
}

// Extract the relevant numeric stat value for a pick from the live players map.
// Returns 0 (not null) for missing pitcher stats so the display shows "K: 0 / 4+"
export function getPickCurrentStat(pick, playerStats) {
  if (!playerStats) {
    return pick.stat === "strikeouts" ? 0 : null;
  }
  switch (pick.stat) {
    case "strikeouts":    return playerStats.strikeouts ?? 0;
    case "hrr":           return playerStats.hrr ?? ((playerStats.hits ?? 0) + (playerStats.runs ?? 0) + (playerStats.rbi ?? 0));
    case "hits":          return playerStats.hits ?? 0;
    case "points":        return playerStats.points ?? 0;
    case "rebounds":      return playerStats.rebounds ?? 0;
    case "assists":       return playerStats.assists ?? 0;
    case "threePointers": return playerStats.threePointers ?? 0;
    default:              return null;
  }
}

// Build the live stat display for a player prop pick card.
// Returns null when there's no live data to show.
export function buildLiveDisplay(pick, liveGame) {
  if (!liveGame || liveGame.state === "pre") return null;
  if (pick.gameType === "total" || pick.gameType === "teamTotal") return null;

  const playerStats = liveGame.players?.[pick.playerName];
  const current = getPickCurrentStat(pick, playerStats);
  if (current === null) return null;

  const threshold = pick.threshold;
  const met = current >= threshold;
  const close = !met && current === threshold - 1;
  const label = STAT_LABEL_LIVE[pick.stat] || pick.stat.toUpperCase();
  const detail = liveGame.detail || "";
  const color = met ? "#3fb950" : close ? "#e3b341" : "#8b949e";
  const text = met
    ? `${label}: ${current} ✓ · ${detail}`
    : `${label}: ${current} / ${threshold}+ · ${detail}`;

  return { text, color, met, current, threshold };
}

// Build live display for a game total or team total pick using existing gameScores data.
// gameScores is from mlbMeta/nbaMeta/nhlMeta — keyed by homeTeam abbr.
export function buildTotalLiveDisplay(pick, gameScores) {
  if (!gameScores) return null;

  // Find the game entry — could be keyed by either team (always keyed by homeTeam)
  let gameScore = null;
  if (pick.gameType === "total") {
    gameScore = gameScores[pick.homeTeam];
  } else if (pick.gameType === "teamTotal") {
    // scoringTeam may be home or away — search both
    gameScore = gameScores[pick.scoringTeam] ||
      Object.values(gameScores).find(g => g.awayTeam === pick.scoringTeam && g.homeTeam === pick.oppTeam) ||
      Object.values(gameScores).find(g => g.homeTeam === pick.scoringTeam && g.awayTeam === pick.oppTeam);
  }

  if (!gameScore || gameScore.state === "pre") return null;

  const detail = gameScore.detail || "";
  const threshold = pick.threshold; // threshold is N+0.5 as integer e.g. 8 means "over 7.5"
  const thresholdDisplay = (threshold - 0.5).toFixed(1);
  const isUnder = pick.direction === "under";

  let current, statLabel;
  if (pick.gameType === "total") {
    current = (gameScore.homeScore ?? 0) + (gameScore.awayScore ?? 0);
    const sportLabel = { mlb: "Runs", nba: "Pts", nhl: "Goals" }[pick.sport] || "Pts";
    statLabel = sportLabel;
  } else {
    // Team total — get scoring team's score
    const isHome = gameScore.homeTeam === pick.scoringTeam;
    current = isHome ? (gameScore.homeScore ?? 0) : (gameScore.awayScore ?? 0);
    statLabel = { mlb: "Runs", nba: "Pts" }[pick.sport] || "Pts";
  }

  const met = isUnder ? current < threshold - 0.5 : current >= threshold;
  const color = isUnder
    ? (current < threshold - 1.5 ? "#3fb950" : current < threshold ? "#e3b341" : "#8b949e")
    : (met ? "#3fb950" : current === threshold - 1 ? "#e3b341" : "#8b949e");

  const dirLabel = isUnder ? "U" : "O";
  const text = met
    ? `${statLabel}: ${current} ✓ (${dirLabel}${thresholdDisplay}) · ${detail}`
    : `${statLabel}: ${current} / ${dirLabel}${thresholdDisplay} · ${detail}`;

  return { text, color, met, current };
}
