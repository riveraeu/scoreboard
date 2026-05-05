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

// Parse fraction of game elapsed from sport + ESPN status detail string.
// Returns 0 (pre), 1 (post/final), or [0..1] for in-progress games. 0.5 fallback when
// the detail format isn't recognized — keeps pace-based coloring alive without throwing.
// Used by buildLiveProgress to color the bar by pace, not just raw progress.
export function gameElapsedFrac(sport, state, detail) {
  if (state === "post") return 1;
  if (state !== "in") return 0;
  const d = (detail || "").toLowerCase();
  if (!d) return 0.5;

  if (sport === "mlb") {
    // "Top 2nd", "Bot 5th", "Mid 7th", "End 8th"; OT-ish (extras) clamps to 1.
    const m = d.match(/(top|bot|mid|end)\s+(\d+)/);
    if (!m) return 0.5;
    const half = m[1];
    const inn = parseInt(m[2]);
    let frac;
    if (half === "top") frac = (inn - 1) / 9;
    else if (half === "mid" || half === "bot") frac = (inn - 1 + 0.5) / 9;
    else frac = inn / 9; // end
    return Math.min(1, frac);
  }

  if (sport === "nba") {
    if (/\bot\b/.test(d)) return 0.97;
    const qm = d.match(/q\s*(\d)/) || d.match(/(\d)(?:st|nd|rd|th)\s*q/);
    if (!qm) return 0.5;
    const q = parseInt(qm[1]);
    const tm = d.match(/(\d+):(\d+)/);
    if (tm) {
      const minLeft = parseInt(tm[1]) + parseInt(tm[2]) / 60;
      const elapsedInQ = Math.max(0, Math.min(1, (12 - minLeft) / 12));
      return Math.min(1, ((q - 1) + elapsedInQ) / 4);
    }
    if (/end/.test(d)) return Math.min(1, q / 4);
    return Math.min(1, (q - 0.5) / 4);
  }

  if (sport === "nhl") {
    if (/\bot\b|\bso\b|shootout/.test(d)) return 0.97;
    const pm = d.match(/(\d)(?:st|nd|rd)/) || d.match(/period\s*(\d)/) || d.match(/p\s*(\d)/);
    if (!pm) return 0.5;
    const p = parseInt(pm[1]);
    const tm = d.match(/(\d+):(\d+)/);
    if (tm) {
      const minLeft = parseInt(tm[1]) + parseInt(tm[2]) / 60;
      const elapsedInP = Math.max(0, Math.min(1, (20 - minLeft) / 20));
      return Math.min(1, ((p - 1) + elapsedInP) / 3);
    }
    if (/end/.test(d)) return Math.min(1, p / 3);
    return Math.min(1, (p - 0.5) / 3);
  }

  return 0.5;
}

// Color a progress bar by pace = (current/threshold) / elapsed.
// Pre-game and very early game return gray (too early to judge pace).
// Post handled by met flag (green) / not-met (red).
function _paceColor({ current, threshold, elapsed, isUnder, isPost, isPre }) {
  if (isPre) return "#484f58";
  const met = isUnder ? current < threshold : current >= threshold;
  if (isPost) return met ? "#3fb950" : "#f78166";
  if (met) return "#3fb950";

  if (isUnder) {
    // For UNDER: bad means current/threshold approaches 1 too fast for elapsed.
    // current >= threshold here is impossible (met would have caught it).
    if (elapsed < 0.05) return "#8b949e";
    const pace = (current / threshold) / elapsed;
    if (pace >= 1.1) return "#f78166";
    if (pace >= 0.85) return "#e3b341";
    return "#3fb950";
  }

  // OVER: good means current/threshold is on or ahead of elapsed.
  if (elapsed < 0.05) return "#8b949e";
  const pace = (current / threshold) / elapsed;
  if (pace >= 1) return "#3fb950";
  if (pace >= 0.66) return "#e3b341";
  return "#f78166";
}

// Build progress-bar display for any active pick (player prop, total, team total).
// Returns null only when there's truly nothing to show (pre-game with no detail to render
// is still returned so the bar can render an empty/gray state with start time).
export function buildLiveProgress(pick, liveGame, totalGameScore) {
  const isTotalish = pick.gameType === "total" || pick.gameType === "teamTotal";
  const game = isTotalish ? totalGameScore : liveGame;
  const state = game?.state || "pre";
  const isPre = state === "pre" || state === "unknown" || !game;
  const isPost = state === "post";
  const isUnder = pick.direction === "under";

  let current = null, threshold = pick.threshold, valLabel = null;

  if (isTotalish) {
    const lineDisplay = (threshold - 0.5).toFixed(1);
    if (game) {
      if (pick.gameType === "total") {
        current = (game.homeScore ?? 0) + (game.awayScore ?? 0);
      } else {
        const isHome = game.homeTeam === pick.scoringTeam;
        current = isHome ? (game.homeScore ?? 0) : (game.awayScore ?? 0);
      }
    }
    const dir = isUnder ? "U" : "O";
    valLabel = current != null ? `${current} ${dir}${lineDisplay}` : `— ${dir}${lineDisplay}`;
  } else {
    if (liveGame && !isPre) {
      const playerStats = findLivePlayer(liveGame.players, pick.playerName);
      current = getPickCurrentStat(pick, playerStats);
    }
    valLabel = current != null ? `${current}/${threshold}` : `—/${threshold}`;
  }

  // For totals, `threshold` is stored as N where the actual line is N-0.5 (e.g. 8 = "over 7.5").
  // Use the line value for both fill % and pace coloring so 8 runs on an Over 7.5 reads exactly 100%.
  const lineThreshold = isTotalish ? threshold - 0.5 : threshold;
  const elapsed = gameElapsedFrac(pick.sport, state, game?.detail);
  const fillPct = current != null
    ? Math.max(0, Math.min(100, (current / lineThreshold) * 100))
    : 0;

  // Player not yet in boxscore mid-game → gray (could be DNP, could just be unsubbed).
  // Don't penalize pace coloring with a phantom 0; auto-resolve handles DNP at game end.
  const noLiveStat = current == null && !isTotalish && !isPre;
  const barColor = noLiveStat
    ? "#8b949e"
    : _paceColor({
        current: current ?? 0,
        threshold: lineThreshold,
        elapsed,
        isUnder,
        isPost,
        isPre,
      });

  // State label: prefer detail; pre-game shows nothing (caller may render gameTime instead).
  const stateLabel = isPre
    ? null
    : (isPost ? "Final" : (game?.detail || "Live"));

  return { current, threshold, fillPct, barColor, valLabel, stateLabel, isPre, isPost, elapsed };
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

