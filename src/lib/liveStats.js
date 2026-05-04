// Live stat helpers for pick card tracking

// Look up a player in the live boxscore tolerantly (strip diacritics + lowercase).
// ESPN's scoreboard returns "Nikola Jokic" (ASCII) but search/profile returns
// "Nikola Jokić" — exact-key lookup misses, so we fall back to a normalized scan.
const _normLiveName = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export function findLivePlayer(players, name) {
  if (!players || !name) return undefined;
  if (players[name] !== undefined) return players[name];
  const target = _normLiveName(name);
  for (const k in players) {
    if (_normLiveName(k) === target) return players[k];
  }
  return undefined;
}

const STAT_LABEL_LIVE = {
  strikeouts: "K",
  hrr: "HRR",
  hits: "H",
  points: "PTS",
  rebounds: "REB",
  assists: "AST",
  threePointers: "3PM",
};

// Raw game key without date — used as the `games` param to /api/live.
export function buildLiveGameKeyRaw(pick) {
  if (pick.gameType === "total") return `${pick.sport}:${pick.awayTeam}:${pick.homeTeam}`;
  if (pick.gameType === "teamTotal") return `${pick.sport}:${pick.scoringTeam}:${pick.oppTeam}`;
  // Player prop — playerTeam + opponent (either order; backend matches both)
  return `${pick.sport}:${pick.playerTeam}:${pick.opponent}`;
}

// Date-scoped key for the client-side liveStats map. The same matchup (e.g. NYY:BAL) can
// recur across consecutive days — without the date suffix, an earlier day's response
// overwrites today's during the merge in fetchLiveStats and stale stats leak into the UI
// (and the auto-resolver), incorrectly settling today's picks against yesterday's box.
export function buildLiveGameKey(pick) {
  const raw = buildLiveGameKeyRaw(pick);
  return pick.gameDate ? `${raw}|${pick.gameDate}` : raw;
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

  const playerStats = findLivePlayer(liveGame.players, pick.playerName);
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

// Resolve a game-score entry for a totals/team-total pick. `liveStats` is keyed by
// `sport:team:team|gameDate` (from /api/live polling, scoped by pick.gameDate);
// `gameScores` is keyed by homeTeam abbr (from mlbMeta/nbaMeta/nhlMeta — frozen at
// /api/tonight load, today only). Prefer live, fall back.
export function resolveTotalGameScore(pick, liveStats, gameScores) {
  const liveKey = buildLiveGameKey(pick);
  const live = liveStats?.[liveKey];
  if (live && live.state !== "unknown") return live;

  if (!gameScores) return null;
  if (pick.gameType === "total") return gameScores[pick.homeTeam] || null;
  if (pick.gameType === "teamTotal") {
    return gameScores[pick.scoringTeam] ||
      Object.values(gameScores).find(g => g.awayTeam === pick.scoringTeam && g.homeTeam === pick.oppTeam) ||
      Object.values(gameScores).find(g => g.homeTeam === pick.scoringTeam && g.awayTeam === pick.oppTeam) ||
      null;
  }
  return null;
}

// Build live display for a game total or team total pick from a resolved game-score entry.
// Entry shape: { state, detail, homeTeam, awayTeam, homeScore, awayScore }.
export function buildTotalLiveDisplay(pick, gameScore) {
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
