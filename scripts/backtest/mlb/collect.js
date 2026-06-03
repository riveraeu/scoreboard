// MLB data collection for backtest.
// Returns a structured object with everything needed for feature reconstruction + simulation.
import { fetchCached, fetchAll } from "../cache.js";

const BASE = "https://statsapi.mlb.com/api/v1";

// Month chunks for schedule fetching (avoids single huge response).
function monthChunks(season) {
  const months = [];
  const start = season === 2024 ? "03-20" : season === 2023 ? "03-30" : season === 2022 ? "04-07" : "03-31";
  const end   = season === 2024 ? "10-01" : season === 2023 ? "10-02" : season === 2022 ? "10-07" : "10-03";
  const startDate = new Date(`${season}-${start}`);
  const endDate   = new Date(`${season}-${end}`);
  let cur = new Date(startDate);
  while (cur < endDate) {
    const next = new Date(cur);
    next.setMonth(next.getMonth() + 1);
    const chunkEnd = next < endDate ? next : endDate;
    months.push([fmtDate(cur), fmtDate(chunkEnd)]);
    cur = new Date(chunkEnd);
    cur.setDate(cur.getDate() + 1);
  }
  return months;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function collectMLBSeason(season) {
  console.log(`\n[collect] MLB ${season} — fetching schedule...`);

  // 1. Season schedule (all games, umpires, probable pitchers)
  const chunks = monthChunks(season);
  const scheduleResponses = await Promise.all(
    chunks.map(([s, e]) =>
      fetchCached(`${BASE}/schedule?sportId=1&startDate=${s}&endDate=${e}&gameType=R&hydrate=probablePitcher,officials`)
    )
  );

  // Flatten all games
  const allGames = [];
  for (const resp of scheduleResponses) {
    for (const dateEntry of resp.dates || []) {
      for (const game of dateEntry.games || []) {
        allGames.push({ ...game, _date: dateEntry.date });
      }
    }
  }
  console.log(`  Schedule: ${allGames.length} games found`);

  // Filter to Final games only
  const finalGames = allGames.filter(g => g.status?.abstractGameState === "Final");
  console.log(`  Final games: ${finalGames.length}`);

  // 2. Per-game boxscores
  const gamePks = finalGames.map(g => g.gamePk);
  const boxscoreUrls = gamePks.map(pk => `${BASE}/game/${pk}/boxscore`);
  const boxscores = await fetchAll(boxscoreUrls, 20, "Boxscores");

  const boxscoreByPk = {};
  gamePks.forEach((pk, i) => { boxscoreByPk[pk] = boxscores[i]; });

  // 3. Build game records + collect unique pitcher/batter IDs
  const games = [];
  const pitcherIds = new Set();
  const batterIds = new Set();

  for (const game of finalGames) {
    const pk = game.gamePk;
    const bs = boxscoreByPk[pk];
    if (!bs?.teams) continue;

    const homeAbbr = game.teams?.home?.team?.abbreviation;
    const awayAbbr = game.teams?.away?.team?.abbreviation;
    const gameDate = game._date;

    // Umpire
    const officials = game.officials || bs.officials || [];
    const hp = officials.find(o => o.officialType === "Home Plate");
    const umpireName = hp?.official?.fullName ?? null;

    // Probable pitchers (from schedule — who was expected)
    const homeProbableId = game.teams?.home?.probablePitcher?.id ?? null;
    const awayProbableId = game.teams?.away?.probablePitcher?.id ?? null;

    // Actual starters (first pitcher in boxscore array = actual starter)
    const homeActualStarterId = bs.teams.home?.pitchers?.[0] ?? homeProbableId;
    const awayActualStarterId = bs.teams.away?.pitchers?.[0] ?? awayProbableId;

    if (homeActualStarterId) pitcherIds.add(homeActualStarterId);
    if (awayActualStarterId) pitcherIds.add(awayActualStarterId);

    // Batting orders (first 9 batters in order)
    const homeBatters = (bs.teams.home?.batters || []).slice(0, 9);
    const awayBatters = (bs.teams.away?.batters || []).slice(0, 9);
    homeBatters.forEach(id => batterIds.add(id));
    awayBatters.forEach(id => batterIds.add(id));

    // Actual outcomes from boxscore
    const homePlayers = bs.teams.home?.players || {};
    const awayPlayers = bs.teams.away?.players || {};

    // Starter Ks
    const homeStarterKs = homeActualStarterId
      ? (homePlayers[`ID${homeActualStarterId}`]?.stats?.pitching?.strikeOuts ?? null)
      : null;
    const awayStarterKs = awayActualStarterId
      ? (awayPlayers[`ID${awayActualStarterId}`]?.stats?.pitching?.strikeOuts ?? null)
      : null;

    // Starter BF (for short-start filtering)
    const homeStarterBF = homeActualStarterId
      ? (homePlayers[`ID${homeActualStarterId}`]?.stats?.pitching?.battersFaced ?? null)
      : null;
    const awayStarterBF = awayActualStarterId
      ? (awayPlayers[`ID${awayActualStarterId}`]?.stats?.pitching?.battersFaced ?? null)
      : null;

    // Starter hits allowed + BF (for pitcherBAA proxy used in HRR)
    const homeStarterH = homeActualStarterId
      ? (homePlayers[`ID${homeActualStarterId}`]?.stats?.pitching?.hits ?? null)
      : null;
    const awayStarterH = awayActualStarterId
      ? (awayPlayers[`ID${awayActualStarterId}`]?.stats?.pitching?.hits ?? null)
      : null;

    // Team runs
    const homeRuns = bs.teams.home?.teamStats?.batting?.runs ?? null;
    const awayRuns = bs.teams.away?.teamStats?.batting?.runs ?? null;

    // Per-batter hit outcomes (for HRR)
    const batterHits = {};
    for (const id of [...homeBatters, ...awayBatters]) {
      const pHome = homePlayers[`ID${id}`];
      const pAway = awayPlayers[`ID${id}`];
      const p = pHome || pAway;
      batterHits[id] = p?.stats?.batting?.hits ?? null;
    }

    // Pitcher hand (from probable pitcher or null — filled later from gamelog)
    const homePitcherHand = game.teams?.home?.probablePitcher?.pitchHand?.code ?? null;
    const awayPitcherHand = game.teams?.away?.probablePitcher?.pitchHand?.code ?? null;

    games.push({
      gamePk: pk, gameDate, homeAbbr, awayAbbr, umpireName,
      homeStarterId: homeActualStarterId, awayStarterId: awayActualStarterId,
      homeStarterBF, awayStarterBF,
      homeStarterKs, awayStarterKs,
      homeStarterH, awayStarterH,
      homeBatters, awayBatters, batterHits,
      homeRuns, awayRuns,
      homePitcherHand, awayPitcherHand,
    });
  }

  console.log(`  Parsed ${games.length} game records`);
  console.log(`  Unique pitchers: ${pitcherIds.size} | Unique batters: ${batterIds.size}`);

  // 4. Pitcher game logs for the season (for rolling YTD reconstruction)
  const pitcherIdArr = [...pitcherIds];
  const gamelogUrls = pitcherIdArr.map(
    id => `${BASE}/people/${id}/stats?stats=gameLog&season=${season}&group=pitching&gameType=R`
  );
  const gamelogs = await fetchAll(gamelogUrls, 20, "Pitcher gamelogs");

  const pitcherGamelogMap = {};
  pitcherIdArr.forEach((id, i) => {
    const splits = gamelogs[i]?.stats?.[0]?.splits || [];
    // Sort ascending by date so we can slice for point-in-time
    const sorted = splits
      .filter(s => s.stat && s.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    pitcherGamelogMap[id] = sorted;
  });

  // 5. Prior-season pitcher stats (for regression anchor)
  const priorSeason = season - 1;
  const priorUrls = pitcherIdArr.map(
    id => `${BASE}/people/${id}/stats?stats=season&season=${priorSeason}&group=pitching&gameType=R`
  );
  const priorStats = await fetchAll(priorUrls, 20, `Prior-year (${priorSeason}) pitcher stats`);

  const pitcherPriorStats = {};
  pitcherIdArr.forEach((id, i) => {
    const split = priorStats[i]?.stats?.[0]?.splits?.[0]?.stat;
    if (split) pitcherPriorStats[id] = split;
  });

  // 6. Pitcher hand from gamelog (fills gaps from probable-pitcher hand)
  const pitcherHandById = {};
  for (const [id, logs] of Object.entries(pitcherGamelogMap)) {
    // Gamelog splits include pitchHand on the player summary
  }
  // Fetch person data for pitcherHand
  const pitcherPersonUrls = pitcherIdArr.map(id => `${BASE}/people/${id}`);
  const pitcherPersons = await fetchAll(pitcherPersonUrls, 20, "Pitcher hand");
  pitcherIdArr.forEach((id, i) => {
    const hand = pitcherPersons[i]?.people?.[0]?.pitchHand?.code;
    if (hand) pitcherHandById[id] = hand;
  });

  // 7. Batter season splits (K% and BA vs-L/vs-R)
  const batterIdArr = [...batterIds];
  // Batch by 100
  const batchSize = 100;
  const batterBatches = [];
  for (let i = 0; i < batterIdArr.length; i += batchSize) {
    batterBatches.push(batterIdArr.slice(i, i + batchSize));
  }

  const [vlResponses, vrResponses, batterSeasonResponses] = await Promise.all([
    fetchAll(
      batterBatches.map(b => `${BASE}/people?personIds=${b.join(",")}&hydrate=stats(group=hitting,type=statSplits,season=${season},sitCodes=vl,gameType=R)`),
      5, "Batter splits vs-L"
    ),
    fetchAll(
      batterBatches.map(b => `${BASE}/people?personIds=${b.join(",")}&hydrate=stats(group=hitting,type=statSplits,season=${season},sitCodes=vr,gameType=R)`),
      5, "Batter splits vs-R"
    ),
    fetchAll(
      batterBatches.map(b => `${BASE}/people?personIds=${b.join(",")}&hydrate=stats(group=hitting,type=season,season=${season},gameType=R)`),
      5, "Batter season stats"
    ),
  ]);

  const batterSplitsVL = {}; // batterId → { kPct, ba, ab, pa }
  const batterSplitsVR = {};
  const batterSeason   = {}; // batterId → { ba, ops, kPct, ab }

  const parseSplit = (resp, map) => {
    for (const res of resp) {
      for (const person of res.people || []) {
        const s = person.stats?.[0]?.splits?.[0]?.stat;
        if (!s || !s.battersFaced && !s.plateAppearances) continue;
        const pa = s.plateAppearances || s.battersFaced || 0;
        if (pa < 10) continue; // not enough data
        map[person.id] = {
          kPct: pa > 0 ? (s.strikeOuts || 0) / pa : null,
          ba: parseFloat(s.avg) || null,
          pa,
        };
      }
    }
  };

  parseSplit(vlResponses, batterSplitsVL);
  parseSplit(vrResponses, batterSplitsVR);

  for (const res of batterSeasonResponses) {
    for (const person of res.people || []) {
      const s = person.stats?.[0]?.splits?.[0]?.stat;
      if (!s) continue;
      const pa = s.plateAppearances || 0;
      batterSeason[person.id] = {
        ba: parseFloat(s.avg) || null,
        ops: parseFloat(s.ops) || null,
        kPct: pa > 0 ? (s.strikeOuts || 0) / pa : null,
        pa,
      };
    }
  }

  console.log(`\n[collect] MLB ${season} complete.`);
  console.log(`  Games: ${games.length} | Pitchers: ${pitcherIdArr.length} | Batters: ${batterIdArr.length}`);

  return {
    season, games,
    pitcherGamelogMap,
    pitcherPriorStats,
    pitcherHandById,
    batterSplitsVL, batterSplitsVR, batterSeason,
  };
}
