// MLB data fetchers: injury report + the byteam hydration orchestrator.
// Pitcher/hitter builders moved to mlb-pitchers.js / mlb-hitters.js (Phase C, 2026-05-29).
// MLB_ID_TO_ABBR + _fs live in mlb-shared.js. Re-exported below so existing
// `import { ... } from "../mlb.js"` call sites keep working unchanged.
import { buildLineupKPct } from "./mlb-hitters.js";
import { buildBallparkWeather } from "./mlb-weather.js";
// Re-export so existing `import { ... } from "../mlb.js"` call sites keep working.
export { MLB_ID_TO_ABBR } from "./mlb-shared.js";
export { buildLineupKPct } from "./mlb-hitters.js";
export { buildBallparkWeather } from "./mlb-weather.js";

// Full MLB byteam hydration pipeline. Single call that fetches every MLB upstream we need for
// /api/tonight and returns the consolidated byteam:mlb object. Also writes to cache with a
// partial-data guard (60s TTL when key fields are empty, 600s otherwise).
//
// Args:
//   cache  — Vercel KV / Upstash cache (CACHE2)
//   PT_FMT — Intl.DateTimeFormat for PT date strings (passed in to avoid re-importing pt.js)
//   parseGameOdds — utils helper (passed in to avoid cross-lib cycles)
import { parseGameOdds as _parseGameOdds } from "./utils.js";
import { PT_FMT } from "./pt.js";

// byteam:mlb is a large consolidated blob (~40 maps incl. historical per-team H2H/splits). It is
// transparently gzipped by makeCache.put (api/[...path].js) when it exceeds the size threshold, so
// a single SET never approaches Upstash's 10MB request cap — no special wrapper needed here.

export async function buildMlbByteam(cache) {
  // Model teardown (2026-08-04): the pitcher build (mlb-pitchers.js) + the ESPN/statsapi team-stat
  // fetches (pitching/batting/road-batting/bullpen → teamERA/roadRPG/bullpen/platoon maps) were all
  // model inputs and are gone. What survives is INFRA: gameScores + gameHomeTeams (home/away),
  // lineupSpotByName/projectedLineupTeams (lineupsConfirmed), weatherByTeam (team-total stamp),
  // and probables/gameOdds (the — now unconsumed — mlbMeta response block still reads them cheaply).
  const [sbData, mlbSched] = await Promise.all([
    (() => {
      // Always fetch today + tomorrow in parallel. sbData.events = today (probables/gameOdds);
      // sbData.eventsAll = today+tomorrow (gameScores, so both day tabs see scheduled/finished games).
      const _td0 = new Date(Date.now() - 7 * 3600 * 1000); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
      const _tfmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
      const _h = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
      return Promise.all([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_tfmt(_td0)}`, { headers: _h }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
        fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_tfmt(_td1)}`, { headers: _h }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      ]).then(([sb0, sb1]) => ({ events: sb0.events || [], eventsTomorrow: sb1.events || [], eventsAll: [...(sb0.events || []), ...(sb1.events || [])] }));
    })(),
    (() => {
      const _td0 = new Date(Date.now() - 7 * 3600 * 1000); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
      const _tfmt2 = (d) => d.toISOString().slice(0, 10);
      return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td0)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((s0) => {
        const allFinal = (s0.dates || []).flatMap((d) => d.games || []).every((g) => g.status?.abstractGameState === "Final");
        if ((s0.dates || []).length === 0 || allFinal) {
          return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td1)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
        }
        return s0;
      });
    })(),
  ]);

  // ESPN uses different abbreviations than Kalshi for some MLB teams
  const MLB_ESPN_NORM = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
  const normMlbAbbr = (a) => MLB_ESPN_NORM[a] || a;

  const probables = {};
  for (const event of sbData.events || []) {
    for (const comp of event.competitions || []) {
      const gameAbbrs = (comp.competitors || []).map((c) => normMlbAbbr(c.team?.abbreviation)).filter(Boolean);
      for (const competitor of comp.competitors || []) {
        const abbr = normMlbAbbr(competitor.team?.abbreviation);
        const probable = (competitor.probables || [])[0];
        if (!abbr || !probable) continue;
        const stats = probable.statistics || [];
        const eraStat = stats.find((s) => s.abbreviation === "ERA");
        const era = eraStat ? parseFloat(eraStat.displayValue) : null;
        const whipStat = stats.find((s) => s.abbreviation === "WHIP");
        const whip = whipStat ? parseFloat(whipStat.displayValue) : null;
        const name = probable.athlete?.displayName || probable.athlete?.fullName || null;
        const id = probable.athlete?.id || null;
        const opp = gameAbbrs.find((a) => a !== abbr) || null;
        probables[abbr] = { name, era, whip, id, opp };
      }
    }
  }
  const gameOddsRaw = _parseGameOdds(sbData.events);
  const gameOdds = Object.fromEntries(Object.entries(gameOddsRaw).map(([k, v]) => [normMlbAbbr(k), v]));
  const gameOddsTomorrowRaw = _parseGameOdds(sbData.eventsTomorrow || []);
  const gameOddsTomorrow = Object.fromEntries(Object.entries(gameOddsTomorrowRaw).map(([k, v]) => [normMlbAbbr(k), v]));
  // Game scores for matchup cards (includes finished games with no active Kalshi markets).
  // Iterate today+tomorrow merged events so both day tabs see scheduled/finished games.
  // Key includes gameDate (today vs tomorrow collision) AND event.date (same-day
  // doubleheader collision, e.g. DET @ BAL twice).
  const gameScores = {};
  for (const event of sbData.eventsAll || sbData.events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const homeComp = (comp.competitors || []).find(c => c.homeAway === "home");
    const awayComp = (comp.competitors || []).find(c => c.homeAway === "away");
    if (!homeComp || !awayComp) continue;
    const hA = normMlbAbbr(homeComp.team?.abbreviation), awA = normMlbAbbr(awayComp.team?.abbreviation);
    if (!hA || !awA) continue;
    const gsDate = event.date ? PT_FMT.format(new Date(event.date)) : null;
    const pickRecord = (recs) => {
      if (!Array.isArray(recs)) return null;
      const overall = recs.find(r => r?.type === "total" || r?.name === "overall");
      return overall?.summary ?? recs[0]?.summary ?? null;
    };
    gameScores[`${hA}|${gsDate ?? ""}|${event.date ?? ""}`] = {
      homeTeam: hA, awayTeam: awA,
      state: comp.status?.type?.state ?? "pre",
      detail: comp.status?.type?.shortDetail || comp.status?.type?.detail || "",
      homeScore: parseInt(homeComp.score ?? 0) || 0,
      awayScore: parseInt(awayComp.score ?? 0) || 0,
      gameDate: gsDate,
      gameTime: event.date || null,
      homeRecord: pickRecord(homeComp.records),
      awayRecord: pickRecord(awayComp.records),
      seasonType: event.season?.type ?? null,
    };
  }
  // gameScores is ready above; weather + lineup fetch in parallel. buildLineupKPct is kept ONLY
  // for its infra outputs (gameHomeTeams = home/away, lineupSpotByName/projectedLineupTeams =
  // lineupsConfirmed); its K%/OPS/split model fields are discarded. buildBallparkWeather →
  // weatherByTeam (the game-total team-total exogenous stamp).
  const _todayPT = PT_FMT.format(new Date());
  const [lineupResult, weatherByTeam] = await Promise.all([
    buildLineupKPct(mlbSched),
    buildBallparkWeather(gameScores, _todayPT).catch(() => ({})),
  ]);
  const { lineupSpotByName, gameHomeTeams, projectedLineupTeams } = lineupResult;

  const byteam = {
    probables, gameOdds, gameOddsTomorrow, gameScores,
    gameHomeTeams, lineupSpotByName, projectedLineupTeams, weatherByTeam,
  };

  // Short TTL (60s) if lineups/home-away aren't confirmed yet, else 600s.
  const _mlbDataReady = Object.keys(lineupSpotByName || {}).length > 0
    && Object.keys(gameHomeTeams || {}).length > 0;
  if (cache) await cache.put("byteam:mlb", JSON.stringify(byteam), { expirationTtl: _mlbDataReady ? 600 : 60 });

  return byteam;
}
