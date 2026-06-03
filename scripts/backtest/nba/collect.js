// NBA data collection for backtest.
// Fetches team + player game logs from the NBA Stats API for a given season.
// Returns structured data for simulateAllNBA().
import { fetchCached } from "../cache.js";

const NBA_API = "https://stats.nba.com/stats";

// NBA Stats API requires specific headers to avoid 403/connection reset.
// Works via Node.js fetch (with NODE_EXTRA_CA_CERTS for Netskope); curl doesn't work.
const NBA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://www.nba.com/",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
};

// year=2024 → "2023-24"
export function nbaSeasonStr(year) {
  return `${year - 1}-${String(year).slice(2)}`;
}

// Parse NBA resultSet into array of objects.
function parseRS(rs) {
  const h = rs.headers;
  return rs.rowSet.map(row => {
    const obj = {};
    h.forEach((k, i) => { obj[k] = row[i]; });
    return obj;
  });
}

// Normalise GAME_DATE → "YYYY-MM-DD".
// NBA Stats API returns dates as "OCT 24, 2023" on some endpoints, "2023-10-24" on others.
function normDate(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // "OCT 24, 2023" → parse via Date
  const d = new Date(raw);
  if (isNaN(d)) return raw;
  return d.toISOString().slice(0, 10);
}

// Prior calendar day.
function prevDay(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function collectNBASeason(year) {
  const season = nbaSeasonStr(year);
  console.log(`\n[collect] NBA ${season} — fetching team game log...`);

  // 1. Team game log (all RS games)
  const teamUrl = `${NBA_API}/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=ASC&LeagueID=00&PlayerOrTeam=T&Season=${encodeURIComponent(season)}&SeasonType=Regular+Season&Sorter=DATE`;
  const teamData = await fetchCached(teamUrl, { headers: NBA_HEADERS, delayMs: 300 });
  const teamRows = parseRS(teamData.resultSets[0]);
  console.log(`  Team rows: ${teamRows.length}`);

  // 2. Player game log
  console.log(`[collect] NBA ${season} — fetching player game log...`);
  const playerUrl = `${NBA_API}/playergamelogs?Season=${encodeURIComponent(season)}&SeasonType=Regular+Season&PlayerOrTeam=P&DateFrom=&DateTo=`;
  const playerData = await fetchCached(playerUrl, { headers: NBA_HEADERS, delayMs: 300 });
  const playerRows = parseRS(playerData.resultSets[0]);
  console.log(`  Player rows: ${playerRows.length}`);

  // 3. Build per-game records by pairing team rows on the same GAME_ID.
  const byGame = {};
  for (const r of teamRows) {
    if (!byGame[r.GAME_ID]) byGame[r.GAME_ID] = [];
    byGame[r.GAME_ID].push(r);
  }

  const games = [];
  for (const [gameId, pair] of Object.entries(byGame)) {
    if (pair.length !== 2) continue;
    const homeRow = pair.find(r => r.MATCHUP.includes("vs."));
    const awayRow = pair.find(r => r.MATCHUP.includes("@"));
    if (!homeRow || !awayRow) continue;
    games.push({
      gameId,
      date:     normDate(homeRow.GAME_DATE),
      homeTeam: homeRow.TEAM_ABBREVIATION,
      awayTeam: awayRow.TEAM_ABBREVIATION,
      homePts:  homeRow.PTS,
      awayPts:  awayRow.PTS,
      homePlusMinus: homeRow.PLUS_MINUS,
    });
  }
  games.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`  Parsed ${games.length} games`);

  // 4. Per-team chronological scoring history — pts scored + pts allowed (for defensive adj).
  const teamHistory = {}; // abbr → [{date, pts, ptsAllowed}]
  for (const g of games) {
    (teamHistory[g.homeTeam] ??= []).push({ date: g.date, pts: g.homePts, ptsAllowed: g.awayPts });
    (teamHistory[g.awayTeam] ??= []).push({ date: g.date, pts: g.awayPts, ptsAllowed: g.homePts });
  }

  // 5. Per-player chronological game history.
  const playerHistory = {}; // playerId → { name, games: [{date, gameId, pts, reb, ast, fg3m, min}] }
  for (const r of playerRows) {
    const id = String(r.PLAYER_ID);
    if (!playerHistory[id]) playerHistory[id] = { name: r.PLAYER_NAME, games: [] };
    playerHistory[id].games.push({
      date:   normDate(r.GAME_DATE),
      gameId: r.GAME_ID,
      team:   r.TEAM_ABBREVIATION,
      pts:    r.PTS  ?? 0,
      reb:    r.REB  ?? 0,
      ast:    r.AST  ?? 0,
      fg3m:   r.FG3M ?? 0,
      min:    parseFloat(r.MIN) || 0,
    });
  }
  for (const p of Object.values(playerHistory)) {
    p.games.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Index: gameId → [{ playerId, team, min, pts, reb, ast, fg3m }] for fast lookup in simulate.
  const gamePlayerIndex = {};
  for (const [playerId, ph] of Object.entries(playerHistory)) {
    for (const g of ph.games) {
      (gamePlayerIndex[g.gameId] ??= []).push({ playerId, team: g.team, min: g.min, pts: g.pts, reb: g.reb, ast: g.ast, fg3m: g.fg3m });
    }
  }

  console.log(`  Players: ${Object.keys(playerHistory).length}`);
  return { year, season, games, teamHistory, playerHistory, gamePlayerIndex };
}
