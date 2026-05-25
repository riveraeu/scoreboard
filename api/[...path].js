import { ALLOWED_ORIGIN, corsHeaders, jsonResponse, errorResponse, parseGameOdds, parseGameScores, parseTopPlayers, buildSoftTeamAbbrs, buildHardTeamAbbrs, buildTeamRankMap } from "./lib/utils.js";
import { PARK_KFACTOR, PARK_HITFACTOR, PARK_RUNFACTOR, UMPIRE_KFACTOR, log5K, poissonCDF, log5HitRate, simulateKsDist, kDistPct, buildNbaStatDist, nbaDistPct, simulateHits, simulateMLBTotalDist, simulateMLBJoint, simulateNBAJoint, mlPctFromJoint, spreadPctFromJoint, simulateNBATotalDist, simulateNHLTotalDist, totalDistPct, simulateTeamTotalDist, simulateTeamPtsDist, lambdaForPoissonTail, muForNegBinTail, negBinCDF, meanForNormalTail, normCDF } from "./lib/simulate.js";
import { buildLineupKPct, buildBarrelPct, buildPitcherKPct, MLB_ID_TO_ABBR, buildMlbByteam, buildMlbInjuryReport } from "./lib/mlb.js";
import { warmPlayerInfoCache, buildNbaDvpStage1, buildNbaDvpFromBettingPros, buildNbaDepthChartPos, buildNbaPaceData, buildNbaPlayerPosFromSleeper, buildNbaDvpStage3FG, buildNbaUsageRate, buildNbaInjuryReport, buildNbaByteam } from "./lib/nba.js";
import { buildWnbaPaceData, buildWnbaUsageRate, buildWnbaInjuryReport, buildWnbaDvp, WNBA_TEAM_IDS, WNBA_ESPN_TO_CANON, WNBA_CANON_TO_ESPN, buildWnbaByteam } from "./lib/wnba.js";
import { buildNhlGoalieData, buildNhlInjuryReport, buildNhlSpecialTeams } from "./lib/nhl.js";
import { verifyJWT } from "./lib/auth-utils.js";
import { handleAuthRoutes } from "./lib/handlers/auth.js";
import { handlePlayerRoutes } from "./lib/handlers/player.js";
import { handleSportsRoutes } from "./lib/handlers/sports.js";
import { handleDvpRoutes } from "./lib/handlers/dvp.js";
import { handleKalshiRoutes } from "./lib/handlers/kalshi.js";
import { PT_FMT, ptDateMinusOne } from "./lib/pt.js";
import { computeDataConfidence, DC_GATE, _GT_IMPLIED_CAP, _TT_IMPLIED_CAP } from "./lib/tonight/dc.js";
import { applyClosingSnapshot } from "./lib/tonight/closing-odds.js";
import { fetchKalshiMarkets } from "./lib/tonight/kalshi-pipeline.js";

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// Universal qualification tunables — see CLAUDE.md "Universal qualification".
const KALSHI_GATE = 67;   // ~-200 American odds floor (66.67% rounded up)
const KALSHI_CAP = 91;    // ~-1000 American odds cap (90.91% rounded up)
const EDGE_GATE = 3;
const SIMSCORE_GATE = 8;
// PT_FMT + ptDateMinusOne are imported from ./lib/pt.js (shared with handler modules).
// Production sport set (sports with active play generation + matchup cards). NFL is
// supported in code but not currently in any active Kalshi market lookup paths.
const PROD_SPORTS = new Set(["mlb", "nba", "nhl", "wnba"]);
// B2B lambda dampener constants — see docs/MODEL.md "B2B dampener". NBA/WNBA dampen own
// offense by -2.5%; NHL boosts opp goalie factor by +5% (B2B team gives up more goals).
// MLB plays daily; no B2B concept.
const B2B_NBA  = 0.975;
const B2B_WNBA = 0.975;
const B2B_NHL  = 1.05;
// Per-team B2B detection: most-recent completed event's PT date == (gameDate − 1) PT date.
// scheduleMap caller passes either _gtScheduleMap (game total) or _ttScheduleMap (team total).
const _isB2B = (scheduleMap, sport, team, gameDate) => {
  const evts = scheduleMap[`${sport}:${team}`] ?? [];
  if (!evts.length) return false;
  const target = ptDateMinusOne(gameDate);
  if (!target) return false;
  let latestDate = null;
  for (const ev of evts) {
    if (!ev.date) continue;
    if (latestDate == null || ev.date > latestDate) latestDate = ev.date;
  }
  if (!latestDate) return false;
  return PT_FMT.format(new Date(latestDate)) === target;
};
// DC_GATE + _GT_IMPLIED_CAP + _TT_IMPLIED_CAP imported from ./lib/tonight/dc.js — see that
// file for the penalty table. dcQualified is the v2 model qualification gate (Phase B landed —
// see [[project-model-version-toggle]]).

// worker.js
function makeCache(env) {
  if (env?.CACHE) return env.CACHE;
  if (env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) {
    const url = env.UPSTASH_REDIS_REST_URL;
    const auth = `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`;
    const cmd = /* @__PURE__ */ __name((...args) => fetch(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(args)
    }).then((r) => r.json()).then((body) => {
      if (body?.error) console.error("[upstash]", args[0], body.error);
      return body;
    }).catch(() => ({ result: null })), "cmd");
    return {
      async get(key, type) {
        const { result } = await cmd("GET", key);
        if (result == null) return null;
        if (type === "json") {
          try {
            return JSON.parse(result);
          } catch {
            return null;
          }
        }
        return result;
      },
      async put(key, value, opts = {}) {
        const v = typeof value === "string" ? value : JSON.stringify(value);
        const args = ["SET", key, v];
        if (opts.expirationTtl) args.push("EX", opts.expirationTtl);
        await cmd(...args);
      },
      async delete(key) {
        await cmd("DEL", key);
      }
    };
  }
  try { return CACHE || null; } catch { return null; }
}
__name(makeCache, "makeCache");
var normName = /* @__PURE__ */ __name((s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(), "normName");
var ESPN_BASE = "https://site.web.api.espn.com/apis";
var ESPN_CORE = "https://sports.core.api.espn.com/v2/sports";
var VALID_SPORTS = [
  "basketball/nba",
  "football/nfl",
  "baseball/mlb",
  "hockey/nhl",
  "basketball/mens-college-basketball",
  "football/college-football"
];
// pbkdf2Hash / makeJWT / verifyJWT live in ./lib/auth-utils.js (used by handlers/auth.js).
// verifyJWT is also imported into this file for the /api/tonight calibration check below.
var worker_default = {
  // Daily crons (DvP build — KV reads are free, so state passes between stages via KV):
  //   17:00 UTC (9am PST):  Stage 1 — fetch teams+rosters (31 req), cache posMap to KV; warm player info
  //   20:00 UTC (12pm PST): Stage 2 — fetch BettingPros DvP page (1 req) → all positions cached
  //   23:00 UTC (3pm PST):  Stage 3 — retry Stage 2 if failed; gamelog fallback if BP blocked
  //   01:00 UTC (5pm PST):  Stage 4 — final refresh; retry BettingPros or gamelog fallback
  async scheduled(event, env, ctx) {
    const cache = makeCache(env);
    const hour = new Date(event.scheduledTime).getUTCHours();
    const clearPlayCache = /* @__PURE__ */ __name(async () => {
      const todayKey = `tonight:plays:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
      await Promise.all([
        cache.delete(todayKey).catch(() => {
        }),
        cache.delete("byteam:mlb").catch(() => {
        })
      ]);
      await warmPlayerInfoCache(cache);
    }, "clearPlayCache");
    if (hour === 17) {
      ctx.waitUntil(Promise.all([buildNbaDvpStage1(cache), warmPlayerInfoCache(cache)]).then(clearPlayCache));
    } else if (hour === 20) {
      ctx.waitUntil(buildNbaDvpFromBettingPros(cache).then(clearPlayCache));
    } else if (hour === 23) {
      ctx.waitUntil(buildNbaDvpFromBettingPros(cache).then((r) => r || buildNbaDvpStage3FG(cache)).then(clearPlayCache));
    } else if (hour === 1) {
      ctx.waitUntil(buildNbaDvpFromBettingPros(cache).then((r) => r || buildNbaDvpStage3FG(cache)).then(clearPlayCache));
    }
  },
  async fetch(request, env, ctx) {
    const CACHE2 = makeCache(env);
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    const path = url.pathname.replace(/^\/api\//, "").replace(/^\//, "");
    const params = url.searchParams;
    const method = request.method;
    const JWT_SECRET = env?.JWT_SECRET;
    try {
      // Extracted handler modules — each returns a Response on path match or null to fall through.
      const _authResp = await handleAuthRoutes({ path, method, request, params, env, CACHE2, JWT_SECRET });
      if (_authResp) return _authResp;
      const _playerResp = await handlePlayerRoutes({
        path, method, request, params, env, CACHE2, runtimeCtx: ctx,
        warmFn: warmPlayerInfoCache, makeCacheFn: makeCache,
        ESPN_BASE, ESPN_CORE, ALLOWED_ORIGIN, jsonResponse, errorResponse,
      });
      if (_playerResp) return _playerResp;
      const _sportsResp = await handleSportsRoutes({ path, method, params, env, CACHE2, VALID_SPORTS });
      if (_sportsResp) return _sportsResp;
      const _dvpResp = await handleDvpRoutes({ path, params, CACHE2, runtimeCtx: ctx, ESPN_CORE, jsonResponse, errorResponse });
      if (_dvpResp) return _dvpResp;
      const _kalshiResp = await handleKalshiRoutes({ path, request, params, env, CACHE2 });
      if (_kalshiResp) return _kalshiResp;
      if (path === "tonight") {
        // Hardcoded valid team abbreviations per sport — used to disambiguate Kalshi tickers
        // where a 2-char prefix (e.g. "NY" → NYK) is a substring of a 3-char team code starting
        // the same way (e.g. "NYK" itself). Without validation, "NYKPHI" was parsing as NY+KPH
        // instead of NYK+PHI; same for SASMIN→SA+SMI. Try 3+3 first, validate, fall back to 2+3.
        const _VALID_TEAMS = {
          nba: new Set(["ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"]),
          // WNBA has multiple 2-char abbrs (GS/LV/LA/NY/DA) and pairs like LVNY/LANY/GSLA/LVGS hit 2+2
          // splits. Validation guards against 2-char-prefix stealing the parse from a 3-char team.
          wnba: new Set(["ATL","CHI","CONN","DAL","GS","IND","LV","LA","MIN","NY","PHX","POR","SEA","TOR","WSH"]),
          nhl: new Set(["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","STL","SJS","SEA","TBL","TOR","UTA","VAN","VGK","WSH","WPG"]),
          mlb: new Set(["ARI","ATL","ATH","BAL","BOS","CHC","CIN","CLE","COL","CWS","DET","HOU","KC","LAA","LAD","MIA","MIL","MIN","NYM","NYY","PHI","PIT","SD","SEA","SF","STL","TB","TEX","TOR","WSH"]),
          nfl: new Set(["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SEA","SF","TB","TEN","WSH"]),
        };
        let parseGameTeams = function(eventTicker, sport) {
          const seg = (eventTicker || "").split("-")[1] || "";
          let rest = seg.slice(7);
          if (/^\d{4}[A-Z]/.test(rest)) rest = rest.slice(4);
          if (rest.length < 4) return [null, null];
          const valid = _VALID_TEAMS[sport];
          // WNBA has 2-, 3-, and 4-char canonical abbrs (LV/NY/GS/LA + ATL/IND/DAL + CONN).
          // Try every (i, len-i) split and accept the first one where both halves validate.
          // Prefer longer left-side first so e.g. CONNIN parses as CONN+IND, not CO+NNIN.
          if (sport === "wnba" && valid) {
            for (let i = Math.min(4, rest.length - 2); i >= 2; i--) {
              const a = normTeam(sport, rest.slice(0, i));
              for (let j = Math.min(4, rest.length - i); j >= 2; j--) {
                const b = normTeam(sport, rest.slice(i, i + j));
                if (valid.has(a) && valid.has(b)) return [a, b];
              }
            }
            return [null, null];
          }
          // Try 3+3 first when length >= 6: only commit if both halves are recognized teams.
          if (rest.length >= 6) {
            const a3 = normTeam(sport, rest.slice(0, 3));
            const b3 = normTeam(sport, rest.slice(3, 6));
            if (valid && valid.has(a3) && valid.has(b3)) return [a3, b3];
          }
          const has2charPrefix = TEAM_NORM[sport]?.[rest.slice(0, 2)] !== void 0;
          // Validated 2+3 split — covers Kalshi tickers using 2-char shorthand for first team.
          if (rest.length >= 5 && has2charPrefix) {
            const a2 = normTeam(sport, rest.slice(0, 2));
            const b3 = normTeam(sport, rest.slice(2, 5));
            if (valid && valid.has(a2) && valid.has(b3)) return [a2, b3];
          }
          // Unvalidated fallbacks (legacy ordering preserved for sports without _VALID_TEAMS).
          if (rest.length >= 6 && !has2charPrefix) return [normTeam(sport, rest.slice(0, 3)), normTeam(sport, rest.slice(3, 6))];
          if (rest.length >= 5 && has2charPrefix) return [normTeam(sport, rest.slice(0, 2)), normTeam(sport, rest.slice(2, 5))];
          if (rest.length >= 5) return [normTeam(sport, rest.slice(0, 3)), normTeam(sport, rest.slice(3, 5))];
          if (rest.length >= 4 && has2charPrefix) return [normTeam(sport, rest.slice(0, 2)), normTeam(sport, rest.slice(2, 4))];
          if (rest.length >= 6) return [normTeam(sport, rest.slice(0, 3)), normTeam(sport, rest.slice(3, 6))];
          return [null, null];
        }, nhlSoftTeams = function(arr, sortKey, label, unit, n = 10) {
          const sorted = [...arr].sort((a, b) => b[sortKey] - a[sortKey]);
          const softTeams = /* @__PURE__ */ new Set();
          const rankMap = {};
          sorted.forEach((t, i) => {
            const abbr = NHL_ABBR_MAP[t.teamId];
            if (!abbr) return;
            rankMap[abbr] = { rank: i + 1, value: parseFloat((t[sortKey] || 0).toFixed(2)), label, unit };
            if (i < n) softTeams.add(abbr);
          });
          return { softTeams, rankMap };
        }, mlbSoftTeams = function(data, isPitcherStat, n = 10) {
          const topCats = data?.categories || [];
          const catName = isPitcherStat ? "batting" : "pitching";
          const keyword = isPitcherStat ? "strikeout" : "era";
          const label = isPitcherStat ? "lineup Ks" : "ERA";
          const unit = isPitcherStat ? "" : "ERA";
          const topCat = topCats.find((c) => c.name === catName);
          const statIdx = (topCat?.names || []).findIndex((nm) => nm.toLowerCase().includes(keyword));
          if (statIdx === -1) return { softTeams: /* @__PURE__ */ new Set(), rankMap: {} };
          const sorted = [...data?.teams || []].map((team) => {
            const teamCat = (team.categories || []).find((c) => c.name === catName);
            const val = parseFloat(teamCat?.values?.[statIdx] ?? 0);
            return { abbr: team.team?.abbreviation || "", val };
          }).filter((t) => t.abbr).sort((a, b) => b.val - a.val);
          const softTeams = new Set(sorted.slice(0, n).map((t) => t.abbr));
          const rankMap = {};
          sorted.forEach((t, i) => {
            rankMap[t.abbr] = { rank: i + 1, value: parseFloat(t.val.toFixed(2)), label, unit };
          });
          return { softTeams, rankMap };
        }, glCacheKey = function(key) {
          const [sport] = key.split("|");
          // Non-MLB version bumped v2→v3 on 2026-05-16: gamelog event shape now includes
          // `isHome` (was missing from `parseEspnGamelog`), which the NBA/WNBA home-away
          // split adjustment depends on. Old v2 cache entries lack isHome → splitAdj always
          // falls back to 1.0. Bumping invalidates them in one cycle.
          return sport === "mlb" ? `gl:mlb242526v2|${key}` : `gl:v3|${key}`;
        };
        __name(parseGameTeams, "parseGameTeams");
        __name(nhlSoftTeams, "nhlSoftTeams");
        __name(mlbSoftTeams, "mlbSoftTeams");
        __name(glCacheKey, "glCacheKey");
        const isDebugMode = params.get("debug") === "1";
        const isBustCache = params.get("bust") === "1";
        // v1 model toggle dropped 2026-05-18; ?model= param ignored (clients pre-drop may still
        // send it). /api/auth/calibration keeps the modelVersion filter for historical pick
        // analysis. See [[project-model-version-toggle]].
        const reportSportFilter = params.get("sport") || null;
        // NBA totals: regular-season aggregate OffRtg/DefRtg systematically under-projects playoff
        // scoring (LAL/OKC G3 = 232 vs model 199 vs market 210.5). Multiplier on home/away expected
        // closes most of the gap to market without erasing genuine edge. Single tunable; calibrate
        // after 2 weeks of playoff data. Applied via _isPlayoffNbaGame() against seriesSummary.
        const _PLAYOFF_OFF_BOOST = 1.04;
        if (params.get("mock") === "true") {
          return jsonResponse({ plays: [
            { playerName: "Shai Gilgeous-Alexander", playerId: "4278073", sport: "nba", playerTeam: "OKC", position: "PG", posGroup: "PG", opponent: "DAL", oppRank: 2, oppMetricValue: 119.8, oppMetricLabel: "PPG allowed", oppMetricUnit: "PPG", stat: "points", threshold: 30, kalshiPct: 74, americanOdds: -163, seasonPct: 78.4, softPct: 84.2, softGames: 11, truePct: 81.3, edge: 7.3, gameDate: "2026-04-08", gameTime: "2026-04-09T00:30:00Z" },
            { playerName: "Nikola Jokic", playerId: "3112335", sport: "nba", playerTeam: "DEN", position: "C", posGroup: "C", opponent: "MEM", oppRank: 5, oppMetricValue: 46.1, oppMetricLabel: "REB allowed/game", oppMetricUnit: "REB", stat: "rebounds", threshold: 10, kalshiPct: 72, americanOdds: -138, seasonPct: 74.5, softPct: 77.3, softGames: 8, truePct: 75.9, edge: 3.9, gameDate: "2026-04-08", gameTime: "2026-04-09T02:00:00Z", playerStatus: "questionable" },
            { playerName: "Connor McDavid", playerId: "3895074", sport: "nhl", playerTeam: "EDM", position: "C", opponent: "VGK", oppRank: 3, oppMetricValue: 3.4, oppMetricLabel: "Goals against/game", oppMetricUnit: "GAA", stat: "goals", threshold: 1, kalshiPct: 73, americanOdds: -122, seasonPct: 72.1, softPct: 74.5, softGames: 8, truePct: 73.3, edge: 0.3, gameDate: "2026-04-08", gameTime: "2026-04-09T02:00:00Z" },
            {
              playerName: "Dylan Cease",
              playerId: "34943",
              sport: "mlb",
              playerTeam: "SD",
              position: "SP",
              opponent: "CLE",
              oppRank: null,
              oppMetricValue: null,
              oppMetricLabel: "vs high-K lineups",
              oppMetricUnit: "%",
              stat: "strikeouts",
              threshold: 6,
              kalshiPct: 71,
              americanOdds: -245,
              seasonPct: 74,
              softPct: 80,
              softGames: 10,
              truePct: 77,
              edge: 6,
              lineupKPct: 27.3,
              pitcherKPct: 26.5,
              pitcherKBBPct: 18.2,
              log5Avg: 31.6,
              log5Pct: 96.1,
              expectedKs: 8.5,
              parkFactor: 1,
              isStrongMatchup: true,
              pkpMeets: true,
              lkpMeets: true,
              gameLineMeets: true,
              gameTotal: 7.5,
              gameMoneyline: -145,
              pitcherHand: "R",
              gameDate: "2026-04-08",
              gameTime: "2026-04-08T20:10:00Z",
              lineupConfirmed: true
            },
            { playerName: "Shohei Ohtani", playerId: "39949", sport: "mlb", playerTeam: "LAD", position: "DH", opponent: "SD", oppRank: 4, oppMetricValue: 4.85, oppMetricLabel: "ERA allowed", oppMetricUnit: "ERA", stat: "hits", threshold: 1, kalshiPct: 72, americanOdds: -300, seasonPct: 73.8, softPct: 76.4, truePct: 76.1, edge: 4.1, hitterBa: 0.291, hitterBaTier: "good", hitterMoneyline: -175, gameDate: "2026-04-08", gameTime: "2026-04-09T02:10:00Z", lineupConfirmed: false }
          ], mock: true }, true);
        }
        const SERIES_CONFIG = {
          KXNBAPTS: { sport: "nba", league: "nba", stat: "points", col: "PTS" },
          KXNBAREB: { sport: "nba", league: "nba", stat: "rebounds", col: "REB" },
          KXNBAAST: { sport: "nba", league: "nba", stat: "assists", col: "AST" },
          KXNBA3PT: { sport: "nba", league: "nba", stat: "threePointers", col: "3PT" },
          KXWNBAPTS: { sport: "wnba", league: "wnba", stat: "points", col: "PTS" },
          KXWNBAREB: { sport: "wnba", league: "wnba", stat: "rebounds", col: "REB" },
          KXWNBAAST: { sport: "wnba", league: "wnba", stat: "assists", col: "AST" },
          KXWNBA3PT: { sport: "wnba", league: "wnba", stat: "threePointers", col: "3PT" },
          KXNHLPTS: { sport: "nhl", league: "nhl", stat: "points", col: "PTS" },
          KXMLBKS: { sport: "mlb", league: "mlb", stat: "strikeouts", col: "K" },
          KXMLBHRR: { sport: "mlb", league: "mlb", stat: "hrr", col: "HRR" },
          KXNFLPAYDS: { sport: "nfl", league: "nfl", stat: "passingYards", col: "YDS" },
          KXNFLRUYDS: { sport: "nfl", league: "nfl", stat: "rushingYards", col: "YDS" },
          KXNFLREYDS: { sport: "nfl", league: "nfl", stat: "receivingYards", col: "YDS" },
          KXNFLTDS: { sport: "nfl", league: "nfl", stat: "touchdowns", col: "TD" },
          // Game totals — both over and under plays surfaced per market
          KXMLBTOTAL: { sport: "mlb", league: "mlb", stat: "totalRuns",   col: "R",   gameType: "total" },
          KXNBATOTAL: { sport: "nba", league: "nba", stat: "totalPoints", col: "PTS", gameType: "total" },
          KXWNBATOTAL: { sport: "wnba", league: "wnba", stat: "totalPoints", col: "PTS", gameType: "total" },
          KXNHLTOTAL: { sport: "nhl", league: "nhl", stat: "totalGoals",  col: "G",   gameType: "total" },
          KXNFLTOTAL: { sport: "nfl", league: "nfl", stat: "totalPoints", col: "PTS", gameType: "total" },
          // Team totals — single team's score vs opposing defense
          KXMLBTEAMTOTAL: { sport: "mlb", league: "mlb", stat: "teamRuns",   col: "R",   gameType: "teamTotal" },
          KXNBATEAMTOTAL: { sport: "nba", league: "nba", stat: "teamPoints", col: "PTS", gameType: "teamTotal" },
          // Spreads — per-market is "Team X wins by over Y units?", line=N-0.5 from suffix `{team}{N}`.
          // Kalshi only lists half-lines (no integer pushes). Same parser branch handles every sport.
          KXMLBSPREAD: { sport: "mlb", league: "mlb", stat: "spread", col: "R", gameType: "spread" },
          KXNBASPREAD: { sport: "nba", league: "nba", stat: "spread", col: "PTS", gameType: "spread" },
          KXWNBASPREAD: { sport: "wnba", league: "wnba", stat: "spread", col: "PTS", gameType: "spread" },
          KXNHLSPREAD: { sport: "nhl", league: "nhl", stat: "spread", col: "G", gameType: "spread" },
        };
        const TEAM_NORM = {
          nba: { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX", WPH: "PHX", KAT: "ATL" },
          // WNBA: Kalshi uses CONN/DAL but ESPN scoreboard returns CONNECTICU/DALLAS — translate via parallel
          // map (WNBA_CANON_TO_ESPN) when fetching ESPN; canonical (short) lives here.
          wnba: { CONNECTICU: "CONN", CON: "CONN", DALLAS: "DAL", WAS: "WSH", GSV: "GS", LAS: "LA" },
          nhl: { NJ: "NJD", TB: "TBL", LA: "LAK", SJ: "SJS", VGK: "VGK" },
          mlb: { KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", CHW: "CWS", AZ: "ARI", KC: "KC", SD: "SD", SF: "SF", TB: "TB", OAK: "ATH", WSN: "WSH", WAS: "WSH" },
          nfl: { LA: "LAR" }
        };
        const normTeam = /* @__PURE__ */ __name((sport, a) => TEAM_NORM[sport]?.[a] || a, "normTeam");
        // Domed MLB stadiums — weather factor does not apply
        const _MLB_DOMED = new Set(["TB", "TOR", "HOU", "MIA", "SEA", "ARI", "TEX", "MIL"]);
        // Parse wind direction from ESPN displayValue: "Out to LF" → positive, "In from CF" → negative, crosswind → 0
        const _parseWind = (dv) => {
          if (!dv) return { windSpeed: null, windOutMph: null };
          const v = dv.toLowerCase();
          const m = v.match(/(\d+(?:\.\d+)?)\s*mph/);
          const spd = m ? parseFloat(m[1]) : null;
          if (spd == null) return { windSpeed: null, windOutMph: null };
          if (spd === 0) return { windSpeed: 0, windOutMph: 0 };
          const isOut = v.includes(" out to ") || v.includes(" out ") || v.endsWith(" out");
          const isIn = v.includes(" in from ") || v.includes(" in to ") || (v.includes(" in ") && !isOut);
          return { windSpeed: spd, windOutMph: isOut ? spd : isIn ? -spd : 0 };
        };
        const _extractMlbWeather = (events, byGame, nt) => {
          for (const ev of events) {
            const comps = ev.competitions?.[0];
            const weather = comps?.weather;
            if (!weather) continue;
            const homeC = (comps?.competitors ?? []).find(c => c.homeAway === "home");
            const awayC = (comps?.competitors ?? []).find(c => c.homeAway === "away");
            if (!homeC || !awayC) continue;
            const homeA = nt("mlb", homeC.team?.abbreviation ?? "");
            const awayA = nt("mlb", awayC.team?.abbreviation ?? "");
            if (!homeA || !awayA) continue;
            const { windSpeed, windOutMph } = _parseWind(weather.displayValue ?? "");
            byGame[`${homeA}|${awayA}`] = { temp: weather.temperature ?? null, condition: weather.displayValue ?? null, windSpeed, windOutMph };
          }
        };
        const seriesTickers = Object.keys(SERIES_CONFIG);
        // 3-tier Kalshi read chain (snap → bundle → REST + stale). See lib/tonight/kalshi-pipeline.js.
        const { kalshiResults, staleKalshiSeries, kalshiSnapMeta, kalshiUsedSnaps } =
          await fetchKalshiMarkets({ seriesTickers, cache: CACHE2, env, isBustCache });
        const _staleKalshiSet = new Set(staleKalshiSeries);
        const _findKalshiTicker = (sport, stat, gameType) => {
          for (const [ticker, cfg] of Object.entries(SERIES_CONFIG)) {
            if (cfg.sport === sport && cfg.stat === stat && (cfg.gameType || null) === (gameType || null)) return ticker;
          }
          return null;
        };
        const qualifyingMarkets = [];
        const totalMarkets = []; // game total markets (pct 70–97); under plays computed from same markets
        const teamTotalMarkets = []; // single-team score markets (KXMLBTEAMTOTAL, KXNBATEAMTOTAL)
        const spreadMarkets = []; // MLB run-line / spread markets (KXMLBSPREAD) — line = strike, marginTeam = win-by side
        const globalSeen = /* @__PURE__ */ new Set();
        for (let i = 0; i < seriesTickers.length; i++) {
          const ticker = seriesTickers[i];
          const cfg = SERIES_CONFIG[ticker];
          const { sport, stat, col } = cfg;
          for (const m of kalshiResults[i].markets || []) {
            const strike = parseFloat(m.floor_strike);
            if (isNaN(strike)) continue;
            const threshold = Math.round(strike + 0.5);
            const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
            const noAsk = parseFloat(m.no_ask_dollars) || 0;
            const last = parseFloat(m.last_price_dollars) || 0;
            const volume = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
            const yesBidEarly = parseFloat(m.yes_bid_dollars) || 0;
            // Stale ask: market maker maxed ask at 99¢ with no bid — use last traded price instead
            const price = (yesAsk >= 0.98 && yesBidEarly === 0 && last > 0) ? last : (yesAsk > 0 ? yesAsk : last);
            const pct = Math.round(price * 100);
            // Real NO-side ask (cost to actually buy the UNDER). Kalshi's YES and NO books are
            // independent — `1 - yes_ask` is the *fair* synthetic NO price, but the real fill
            // is no_ask, which can be 3–7 cents higher due to spread. Using 1 - pct here would
            // systematically underprice UNDERs (e.g. yes_ask=0.17 → fake NO=-488 vs real NO=-720).
            // Fall back to 1 - pct only when no_ask is missing.
            const noPct = noAsk > 0 ? Math.round(noAsk * 100) : (100 - pct);
            if (price === 0) continue;

            // ── Game total branch (wider pct filter; team-based, not player-based) ──
            if (cfg.gameType === "total") {
              // Keep markets where EITHER side (YES/OVER or NO/UNDER) sits in our [67,91]
              // qualification window. The OVER push gates on YES (yesAsk), the UNDER push
              // gates on NO (noAsk = real ask, not synthetic 1-yesAsk), so we don't bet
              // OVERs against an UNDER-favored line and vice versa.
              if ((pct < KALSHI_GATE || pct > KALSHI_CAP) && (noPct < KALSHI_GATE || noPct > KALSHI_CAP)) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              const dedupeKey = `total|${sport}|${gameTeam1}|${gameTeam2}|${threshold}`;
              if (globalSeen.has(dedupeKey)) continue;
              globalSeen.add(dedupeKey);
              const _toAO = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              const _tNoAO = noPct >= 50 ? Math.round(-(noPct / (100 - noPct)) * 100) : Math.round((100 - noPct) / noPct * 100);
              const _tDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _tGameDate = null;
              if (_tDateSeg.length >= 7) {
                const _KMON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _tYr = "20" + _tDateSeg.slice(0, 2);
                const _tMo = _KMON[_tDateSeg.slice(2, 5).toUpperCase()];
                const _tDy = _tDateSeg.slice(5, 7);
                if (_tMo) _tGameDate = `${_tYr}-${_tMo}-${_tDy}`;
              }
              const _tYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _tSpread = yesAsk > 0 && _tYesBid > 0 ? Math.round((yesAsk - _tYesBid) * 100) : null;
              totalMarkets.push({ gameType: "total", sport, stat, col, threshold, kalshiPct: pct, americanOdds: _toAO, noKalshiPct: noPct, noKalshiAO: _tNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, gameDate: _tGameDate, kalshiSpread: _tSpread, _ticker: m.ticker, _yesAsk: yesAsk, _yesBid: _tYesBid, _noAsk: noAsk });
              continue;
            }

            // ── Team total branch (single team's score vs opposing defense) ──
            if (cfg.gameType === "teamTotal") {
              // Same broadened gate as game totals — accept either OVER-side or UNDER-side
              // alt lines; the OVER/UNDER push paths apply their own kalshiPct/noKalshiPct gate.
              // UNDER side uses real noAsk (not 1-yesAsk) since YES/NO books are independent.
              if ((pct < KALSHI_GATE || pct > KALSHI_CAP) && (noPct < KALSHI_GATE || noPct > KALSHI_CAP)) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              // Extract scoring team from ticker suffix (e.g. "LAD8" → "LAD", "PHI97" → "PHI")
              const _ttSuffix = (m.ticker || "").split("-").pop() || "";
              const _ttMatch = _ttSuffix.match(/^([A-Z]+)/);
              if (!_ttMatch) continue;
              const scoringTeam = normTeam(sport, _ttMatch[1]);
              const dedupeKey = `teamtotal|${sport}|${scoringTeam}|${gameTeam1}|${gameTeam2}|${threshold}`;
              if (globalSeen.has(dedupeKey)) continue;
              globalSeen.add(dedupeKey);
              const _ttAO = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              const _ttNoAO = noPct >= 50 ? Math.round(-(noPct / (100 - noPct)) * 100) : Math.round((100 - noPct) / noPct * 100);
              const _ttDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _ttGameDate = null;
              if (_ttDateSeg.length >= 7) {
                const _KMON2 = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _ttYr = "20" + _ttDateSeg.slice(0, 2);
                const _ttMo = _KMON2[_ttDateSeg.slice(2, 5).toUpperCase()];
                const _ttDy = _ttDateSeg.slice(5, 7);
                if (_ttMo) _ttGameDate = `${_ttYr}-${_ttMo}-${_ttDy}`;
              }
              const _ttYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _ttSpread = yesAsk > 0 && _ttYesBid > 0 ? Math.round((yesAsk - _ttYesBid) * 100) : null;
              teamTotalMarkets.push({ gameType: "teamTotal", sport, stat, col, threshold, kalshiPct: pct, americanOdds: _ttAO, noKalshiPct: noPct, noKalshiAO: _ttNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, scoringTeam, gameDate: _ttGameDate, kalshiSpread: _ttSpread, _ticker: m.ticker, _yesAsk: yesAsk, _noAsk: noAsk });
              continue;
            }

            // ── Spread branch (MLB run-line: "Team X wins by over Y runs?") ──
            // Suffix `{team}{N}` where line = strike (== N - 0.5). YES = the margin side; NO = the
            // cover side (handled identically to totals UNDER via real no_ask, not 1 - yes_ask).
            // Same broad gate as totals: keep if either side sits in [67,91]; emission re-gates.
            if (cfg.gameType === "spread") {
              if ((pct < KALSHI_GATE || pct > KALSHI_CAP) && (noPct < KALSHI_GATE || noPct > KALSHI_CAP)) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              const _spSuffix = (m.ticker || "").split("-").pop() || "";
              const _spMatch = _spSuffix.match(/^([A-Z]+)(\d+)$/);
              if (!_spMatch) continue;
              const marginTeam = normTeam(sport, _spMatch[1]);
              // Trust the parsed strike (floor_strike) as the line; suffix N is a sanity-check tier.
              if (isNaN(strike) || strike <= 0 || strike === Math.floor(strike)) continue;
              const dedupeKey = `spread|${sport}|${marginTeam}|${gameTeam1}|${gameTeam2}|${strike}`;
              if (globalSeen.has(dedupeKey)) continue;
              globalSeen.add(dedupeKey);
              const _spAO = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              const _spNoAO = noPct >= 50 ? Math.round(-(noPct / (100 - noPct)) * 100) : Math.round((100 - noPct) / noPct * 100);
              const _spDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _spGameDate = null;
              if (_spDateSeg.length >= 7) {
                const _KMON3 = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _spYr = "20" + _spDateSeg.slice(0, 2);
                const _spMo = _KMON3[_spDateSeg.slice(2, 5).toUpperCase()];
                const _spDy = _spDateSeg.slice(5, 7);
                if (_spMo) _spGameDate = `${_spYr}-${_spMo}-${_spDy}`;
              }
              const _spYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _spSpread = yesAsk > 0 && _spYesBid > 0 ? Math.round((yesAsk - _spYesBid) * 100) : null;
              spreadMarkets.push({ gameType: "spread", sport, stat, col, line: strike, marginTeam, kalshiPct: pct, americanOdds: _spAO, noKalshiPct: noPct, noKalshiAO: _spNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, gameDate: _spGameDate, kalshiSpread: _spSpread, _ticker: m.ticker, _yesAsk: yesAsk, _noAsk: noAsk });
              continue;
            }

            if (pct < KALSHI_GATE) continue;
            if (pct > KALSHI_CAP) continue;
            // HRR: only bet 1+ threshold — user never bets 2+/3+ alt lines (sub-1% baseline hit
            // rate makes those plays speculative). Skip at parse so they don't even reach dedup.
            if (stat === "hrr" && threshold > 1) continue;
            const raw = m.event_title || m.title || "";
            let playerName = raw.replace(/\s*:\s*\d.*$/, "").replace(/\s+(Points?|Rebounds?|Assists?|3-Pointers?|Three Pointers?|Made Threes?|Goals?|Shots on Goal|Hits?|Home Runs?|RBIs?|Strikeouts?|Total Bases?|Passing Yards?|Rushing Yards?|Receiving Yards?|Touchdowns?)\b.*/i, "").replace(/\s+Over\s+\d.*$/i, "").replace(/\s+Under\s+\d.*$/i, "").replace(/\s*\(.*\)\s*$/, "").replace(/\s*-\s*$/, "").trim();
            if (!playerName || playerName.length < 4) continue;
            const playerNameDisplay = playerName;
            playerName = normName(playerName);
            const dedupeKey = `${sport}|${playerName}|${stat}|${threshold}`;
            if (globalSeen.has(dedupeKey)) continue;
            globalSeen.add(dedupeKey);
            const americanOdds = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
            const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
            const tickerSegs = (m.ticker || "").split("-");
            let kalshiPlayerTeam = null;
            if (tickerSegs.length >= 3) {
              const seg3 = tickerSegs[2];
              if (gameTeam1 && seg3.startsWith(gameTeam1)) kalshiPlayerTeam = gameTeam1;
              else if (gameTeam2 && seg3.startsWith(gameTeam2)) kalshiPlayerTeam = gameTeam2;
              else {
                // Kalshi sometimes appends player initial to a 2-char team prefix (e.g. "SJM" for SJS + Macklin Celebrini)
                const norm2 = normTeam(sport, seg3.slice(0, 2));
                if (norm2 && (norm2 === gameTeam1 || norm2 === gameTeam2)) kalshiPlayerTeam = norm2;
                else kalshiPlayerTeam = normTeam(sport, seg3.slice(0, 3));
              }
            }
            const dateSeg = (m.event_ticker || "").split("-")[1] || "";
            let gameDate = null;
            if (dateSeg.length >= 7) {
              const KMON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
              const yr = "20" + dateSeg.slice(0, 2);
              const mo = KMON[dateSeg.slice(2, 5).toUpperCase()];
              const dy = dateSeg.slice(5, 7);
              if (mo) gameDate = `${yr}-${mo}-${dy}`;
            }
            const yesBid = parseFloat(m.yes_bid_dollars) || 0;
            const yesAskSize = parseFloat(m.yes_ask_size_fp) || 0;
            const kalshiSpread = yesAsk > 0 && yesBid > 0 ? Math.round((yesAsk - yesBid) * 100) : null;
            qualifyingMarkets.push({ playerName, playerNameDisplay, sport, stat, col, threshold, kalshiPct: pct, americanOdds, kalshiVolume: volume, gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate, kalshiSpread, _ticker: m.ticker, _yesAsk: yesAsk, _yesBid: yesBid, _yesAskSize: yesAskSize });
          }
        }
        if (qualifyingMarkets.length === 0 && totalMarkets.length === 0) {
          return jsonResponse({ plays: [], note: "no qualifying kalshi markets (implied pct >= 60)" });
        }
        // Derive implied NBA game O/U line from Kalshi KXNBATOTAL markets.
        // Uses ALL pcts (no 70-97 filter) to find the 50% YES crossing per game.
        // Falls back into nbaGameOdds for teams ESPN doesn't include in today's scoreboard odds.
        // Same fallback applied for MLB + NHL below — ESPN scoreboard only carries today's odds,
        // so tomorrow's games render with O/U "—" without a Kalshi-derived backfill.
        const _buildKalshiOuMap = (sport, ticker) => {
          const _map = {};
          const _idx = seriesTickers.indexOf(ticker);
          if (_idx < 0) return _map;
          const _ouByGame = {};
          for (const m of kalshiResults[_idx].markets || []) {
            const _strike = parseFloat(m.floor_strike);
            if (isNaN(_strike)) continue;
            const _thr = Math.round(_strike + 0.5);
            const _ask = parseFloat(m.yes_ask_dollars) || 0;
            const _last = parseFloat(m.last_price_dollars) || 0;
            const _bid = parseFloat(m.yes_bid_dollars) || 0;
            const _price = (_ask >= 0.98 && _bid === 0 && _last > 0) ? _last : (_ask > 0 ? _ask : _last);
            const _pct = Math.round(_price * 100);
            if (_pct <= 0 || _pct >= 100) continue;
            const [_t1, _t2] = parseGameTeams(m.event_ticker, sport);
            if (!_t1 || !_t2) continue;
            const _gk = `${_t1}|${_t2}`;
            if (!_ouByGame[_gk]) _ouByGame[_gk] = [];
            _ouByGame[_gk].push({ threshold: _thr, pct: _pct });
          }
          for (const [_gk, _mks] of Object.entries(_ouByGame)) {
            _mks.sort((a, b) => a.threshold - b.threshold);
            // Highest threshold where YES >= 50% → that threshold - 0.5 is implied O/U line
            let _ouLine = null;
            for (const _mk of _mks) { if (_mk.pct >= 50) _ouLine = _mk.threshold - 0.5; }
            if (_ouLine != null) {
              const [_t1, _t2] = _gk.split("|");
              _map[_t1] = _ouLine;
              _map[_t2] = _ouLine;
            }
          }
          return _map;
        };
        const kalshiNbaOuMap = _buildKalshiOuMap("nba", "KXNBATOTAL");
        const kalshiWnbaOuMap = _buildKalshiOuMap("wnba", "KXWNBATOTAL");
        const kalshiMlbOuMap = _buildKalshiOuMap("mlb", "KXMLBTOTAL");
        const kalshiNhlOuMap = _buildKalshiOuMap("nhl", "KXNHLTOTAL");
        // Blended fill price: walk the orderbook for unit-sized positions so kalshiPct reflects
        // true cost, not just top-of-book ask. 1 unit = $100 at risk; tiers: 70-83% = 1u, 83-93% = 3u, 93%+ = 5u.
        const UNIT_DOLLARS = 50; // 1 unit = 1% of $5k bankroll
        const getContracts = (pct, ask) => ask > 0 ? Math.ceil(UNIT_DOLLARS * (pct >= 93 ? 5 : pct >= 83 ? 3 : 1) / ask) : 0;
        const thinMarkets = qualifyingMarkets.filter((m) => m._ticker && getContracts(m.kalshiPct, m._yesAsk) > m._yesAskSize);
        const obMap = {};
        if (thinMarkets.length > 0) {
          const obFetches = await Promise.all(thinMarkets.map((m) =>
            fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${m._ticker}/orderbook`, {
              headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
            }).then((r) => (r.ok && r.status !== 429) ? r.json() : null).catch(() => null)
          ));
          for (let i = 0; i < thinMarkets.length; i++) {
            if (obFetches[i]?.orderbook_fp) obMap[thinMarkets[i]._ticker] = obFetches[i].orderbook_fp;
          }
        }
        for (const m of qualifyingMarkets) {
          const contracts = getContracts(m.kalshiPct, m._yesAsk);
          if (contracts <= 0 || m._yesAskSize >= contracts) continue;
          const book = obMap[m._ticker];
          if (!book) continue;
          // no_dollars are NO bids sorted ascending; YES ask at level = 1 - no_price
          // Walk highest no_price first (= lowest YES ask first) to fill the position
          const levels = (book.no_dollars || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]).sort((a, b) => b[0] - a[0]);
          let filled = 0, totalCost = 0;
          for (const [noPrice, qty] of levels) {
            if (filled >= contracts) break;
            const yesAsk = 1 - noPrice;
            if (yesAsk >= 1) continue;
            const take = Math.min(qty, contracts - filled);
            totalCost += take * yesAsk;
            filled += take;
          }
          if (filled === 0) continue;
          if (filled < contracts && levels.length > 0) {
            // Book exhausted; extend at worst quoted price
            totalCost += (contracts - filled) * Math.min(0.99, 1 - levels[levels.length - 1][0]);
          }
          const blendedPct = Math.round((totalCost / contracts) * 100);
          if (blendedPct > m.kalshiPct && blendedPct <= 97) {
            m.kalshiPct = blendedPct;
            m.americanOdds = blendedPct >= 50 ? Math.round(-(blendedPct / (100 - blendedPct)) * 100) : Math.round((100 - blendedPct) / blendedPct * 100);
          }
        }
        // E1: Line movement tracking — record opening price the first time we see each ticker.
        // lineMove = current yesAsk (after blend) - openYesAsk (first seen today).
        // KV key: lineOpen:{ticker}:{gameDate} → openYesAsk (cents, 0-100)
        if (CACHE2) {
          const _allTrackedMarkets = [...qualifyingMarkets, ...totalMarkets];
          await Promise.all(_allTrackedMarkets.map(async m => {
            if (!m._ticker || !m.gameDate) return;
            const _lmKey = `lineOpen:${m._ticker}:${m.gameDate}`;
            try {
              const _existing = await CACHE2.get(_lmKey);
              if (_existing != null) {
                const _openAsk = parseFloat(_existing);
                if (!isNaN(_openAsk)) m.lineMove = parseFloat((m.kalshiPct - _openAsk).toFixed(1));
              } else {
                // First time — write opening price; TTL = 48h (covers game day + settlement)
                await CACHE2.put(_lmKey, String(m.kalshiPct), { expirationTtl: 172800 });
                m.lineMove = 0;
              }
            } catch {}
          }));
        }
        // E2: Market depth flags — thinMarket and marketConfidence
        for (const m of [...qualifyingMarkets, ...totalMarkets, ...teamTotalMarkets]) {
          m.thinMarket = m.kalshiSpread != null && m.kalshiSpread > 8;
          m.marketConfidence = m.kalshiVolume >= 100 ? "deep" : m.kalshiVolume >= 50 ? "moderate" : "thin";
        }
        const sportsNeeded = new Set([...qualifyingMarkets.map((m) => m.sport), ...totalMarkets.map((m) => m.sport)]);
        const sportByteam = {};
        const NHL_ABBR_MAP = { 1: "NJD", 2: "NYI", 3: "NYR", 4: "PHI", 5: "PIT", 6: "BOS", 7: "BUF", 8: "MTL", 9: "OTT", 10: "TOR", 12: "CAR", 13: "FLA", 14: "TBL", 15: "WSH", 16: "CHI", 17: "DET", 18: "NSH", 19: "STL", 20: "CGY", 21: "COL", 22: "EDM", 23: "VAN", 24: "ANA", 25: "DAL", 26: "LAK", 28: "SJS", 29: "CBJ", 30: "MIN", 52: "WPG", 54: "VGK", 55: "SEA", 68: "UTA" };
        if (CACHE2) {
          await Promise.all([...sportsNeeded].map(async (sport) => {
            // When busting, skip the cache read for MLB so fresh computation is forced.
            // Deleting + reading in the same request is unreliable due to KV eventual consistency.
            if (isBustCache && PROD_SPORTS.has(sport)) return;
            const cached = await CACHE2.get(`byteam:${sport}`, "json").catch(() => null);
            if (cached) sportByteam[sport] = cached;
          }));
        }
        const sportsNeedingFetch = new Set([...sportsNeeded].filter((s) => !sportByteam[s]));
        if (sportsNeedingFetch.size > 0) {
          await Promise.all([
            sportsNeedingFetch.has("nba") && buildNbaByteam(CACHE2, normTeam).then(r => Object.assign(sportByteam, r)),
            sportsNeedingFetch.has("wnba") && buildWnbaByteam(CACHE2, normTeam).then(r => Object.assign(sportByteam, r)),
            sportsNeedingFetch.has("nhl") && Promise.all([
              fetch("https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=goalsAgainstPerGame&start=0&limit=50&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch("https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=shotsAgainstPerGame&start=0&limit=50&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              buildNhlGoalieData(CACHE2).catch(() => ({ goalieByTeam: {}, leagueAvgSV: 0.905 })),
              buildNhlInjuryReport(CACHE2).catch(() => new Map()),
              buildNhlSpecialTeams(CACHE2, NHL_ABBR_MAP).catch(() => ({ byTeam: {}, leaguePPPct: 0.21, leaguePKPct: 0.79 }))
            ]).then(async ([gaData, saData, goalieData, injuryMap, stData]) => {
              // Serialize Map → plain object for the byteam:nhl JSON cache; the consumer site
              // does NOT need a Map (just object lookups by team abbr).
              const _nhlInjuryObj = {};
              for (const [k, v] of (injuryMap || new Map()).entries()) _nhlInjuryObj[k] = v;
              sportByteam.nhl = {
                ga: gaData.data || [],
                sa: saData.data || [],
                goalieByTeam: goalieData?.goalieByTeam || {},
                leagueAvgSV: goalieData?.leagueAvgSV ?? 0.905,
                injuryByTeam: _nhlInjuryObj,
                specialTeams: stData || { byTeam: {}, leaguePPPct: 0.21, leaguePKPct: 0.79 },
              };
              if (CACHE2) await CACHE2.put("byteam:nhl", JSON.stringify(sportByteam.nhl), { expirationTtl: 21600 });
            }),
            sportsNeedingFetch.has("mlb") && Promise.all([
              buildMlbByteam(CACHE2),
              buildMlbInjuryReport(CACHE2).catch(() => new Map())
            ]).then(([d, injuryMap]) => {
              sportByteam.mlb = d || {};
              // Serialize Map → plain object (consumer uses object lookups by abbr; same pattern as NHL).
              const _mlbInjuryObj = {};
              for (const [k, v] of (injuryMap || new Map()).entries()) _mlbInjuryObj[k] = v;
              sportByteam.mlb.injuryByTeam = _mlbInjuryObj;
            }),
            sportsNeedingFetch.has("nfl") && fetch("https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byteam?region=us&lang=en&isqualified=true&page=1&limit=32&category=passing", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then(async (d) => {
              sportByteam.nfl = d.teams || [];
              if (CACHE2) await CACHE2.put("byteam:nfl", JSON.stringify(sportByteam.nfl), { expirationTtl: 1800 });
            })
          ].filter(Boolean));
        }
        // Kalshi MLB postponed-ticker reattribution: when a game is rained out, Kalshi
        // keeps the original ticker (date segment + expected_expiration_time both stale)
        // and reuses it for the makeup game. The market parse loop above stamps gameDate
        // from the ticker segment, so a postponed-but-played-today market would otherwise
        // get filtered out as "yesterday's game". Look up the actual next-scheduled game
        // between the two teams in ESPN's schedule and overwrite gameDate in place.
        // _mlbNextGameByTeams + _reattrMlbGameDate are hoisted out so the ML/spread
        // emission loops below can reattribute using the same logic (their expected_
        // expiration_time-derived gameDate hits the same staleness).
        const _todayForReattr = PT_FMT.format(new Date());
        const _mlbNextGameByTeams = {};
        if (sportByteam.mlb?.gameScores) {
          for (const gs of Object.values(sportByteam.mlb.gameScores)) {
            if (gs?.state !== "pre" || !gs.gameDate || gs.gameDate < _todayForReattr) continue;
            if (!gs.homeTeam || !gs.awayTeam) continue;
            const k = [gs.homeTeam, gs.awayTeam].sort().join("|");
            const existing = _mlbNextGameByTeams[k];
            if (!existing || (gs.gameTime && existing.gameTime && gs.gameTime < existing.gameTime) || (gs.gameDate < existing.gameDate)) {
              _mlbNextGameByTeams[k] = { gameDate: gs.gameDate, gameTime: gs.gameTime };
            }
          }
        }
        const _reattrMlbGameDate = (parsedGameDate, teamA, teamB, isResolved) => {
          if (!parsedGameDate || parsedGameDate >= _todayForReattr) return parsedGameDate;
          if (isResolved) return parsedGameDate;
          if (!teamA || !teamB) return parsedGameDate;
          const next = _mlbNextGameByTeams[[teamA, teamB].sort().join("|")];
          return next?.gameDate ?? parsedGameDate;
        };
        const _isMlbResolvedMarket = (m) => {
          const ya = m._yesAsk ?? 0;
          const na = m._noAsk ?? 0;
          const _atFloor = (v) => v > 0 && v <= 0.02;
          const _atCeil = (v) => v >= 0.99;
          return (_atFloor(ya) || _atCeil(ya)) && (_atFloor(na) || _atCeil(na));
        };
        for (const arr of [totalMarkets, teamTotalMarkets, spreadMarkets]) {
          for (const m of arr) {
            if (m.sport !== "mlb") continue;
            m.gameDate = _reattrMlbGameDate(m.gameDate, m.gameTeam1, m.gameTeam2, _isMlbResolvedMarket(m));
          }
        }
        // NBA scoring (offensive PPG) — load from KV cache or fetch fresh when nba byteam was served from cache
        if (sportsNeeded.has("nba") && !sportByteam.nbaScoring) {
          if (CACHE2 && !isBustCache) sportByteam.nbaScoring = await CACHE2.get("byteam:nba:scoring", "json").catch(() => null);
          if (!sportByteam.nbaScoring) {
            sportByteam.nbaScoring = await fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=scoring&seasontype=2", {
              headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
            }).then(r => r.ok ? r.json() : {}).then(d => d.teams || []).catch(() => []);
            if (CACHE2 && Array.isArray(sportByteam.nbaScoring) && sportByteam.nbaScoring.length > 0) {
              await CACHE2.put("byteam:nba:scoring", JSON.stringify(sportByteam.nbaScoring), { expirationTtl: 21600 }).catch(() => {});
            }
          }
        }
        if (sportsNeeded.has("wnba") && !sportByteam.wnbaScoring) {
          if (CACHE2 && !isBustCache) sportByteam.wnbaScoring = await CACHE2.get("byteam:wnba:scoring", "json").catch(() => null);
          if (!sportByteam.wnbaScoring) {
            sportByteam.wnbaScoring = await fetch("https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=20&category=scoring&seasontype=2&season=2025", {
              headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" }
            }).then(r => r.ok ? r.json() : {}).then(d => d.teams || []).catch(() => []);
            if (CACHE2 && Array.isArray(sportByteam.wnbaScoring) && sportByteam.wnbaScoring.length > 0) {
              await CACHE2.put("byteam:wnba:scoring", JSON.stringify(sportByteam.wnbaScoring), { expirationTtl: 21600 }).catch(() => {});
            }
          }
        }
        // Fetch game start times + NBA player availability for tonight's games
        const todayDateStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
        // Today's PT date in ISO (YYYY-MM-DD) — used by lineupConfirmed checks to refuse
        // crediting today's lineup data toward tomorrow's games (sportByteam.mlb.lineupSpotByName
        // is a team-level map without date scoping; without this guard, a team playing
        // back-to-back days would inherit today's confirmation for tomorrow's game).
        const _todayPT = PT_FMT.format(new Date());
        // Single source of truth for "both teams have a confirmed (non-projected) lineup posted
        // for this game's date". Used by game-total / team-total / ML / spread emission. Player
        // props use the asymmetric _mlbLineupConf helper (per stat: K = opp only, hitter = own +
        // opp-pitcher-known). DO NOT inline this check — duplicate definitions drift (see
        // 187f9f3 where I missed two sites updating just one). teamA/teamB are interchangeable.
        const _mlbBothTeamsConfirmed = (teamA, teamB, gameDate) => {
          if (gameDate !== _todayPT) return false;
          const _spotMap = sportByteam.mlb?.lineupSpotByName || {};
          const _proj = sportByteam.mlb?.projectedLineupTeams || [];
          const _ok = (t) => _spotMap[t] != null && !_proj.includes(t);
          return _ok(teamA) && _ok(teamB);
        };
        // nbaStarters loaded in parallel with nbaPlayerStatus since the fetch that populates
        // them shares the same ESPN summary URL — same lifecycle (600s TTL).
        let nbaStarters = (sportsNeeded.has("nba") && CACHE2 && !isBustCache)
          ? await CACHE2.get(`nba:starters:${todayDateStr}`, "json").catch(() => null)
          : null;
        let wnbaStarters = (sportsNeeded.has("wnba") && CACHE2 && !isBustCache)
          ? await CACHE2.get(`wnba:starters:${todayDateStr}`, "json").catch(() => null)
          : null;
        let [gameTimes, nbaPlayerStatus, _cachedWeather] = await Promise.all([
          CACHE2 && !isBustCache ? CACHE2.get(`gameTimes:v2:${todayDateStr}`, "json").catch(() => null) : null,
          CACHE2 ? CACHE2.get(`nbaStatus:${todayDateStr}`, "json").catch(() => null) : null,
          CACHE2 && !isBustCache ? CACHE2.get(`weather:mlb:${todayDateStr}`, "json").catch(() => null) : null,
        ]);
        const weatherByGame = _cachedWeather ? { ..._cachedWeather } : {}; // keyed "homeAbbr|awayAbbr" → {temp, condition}
        const needGameTimes = !gameTimes;
        const needNbaStatus = !nbaPlayerStatus && sportsNeeded.has("nba");
        const needNbaStarters = !nbaStarters && sportsNeeded.has("nba");
        const needWnbaStarters = !wnbaStarters && sportsNeeded.has("wnba");
        const needNbaSummaries = needNbaStatus || needNbaStarters;
        const needAnySummary = needNbaSummaries || needWnbaStarters;
        if (needGameTimes || needAnySummary) {
          gameTimes = gameTimes || {};
          nbaPlayerStatus = nbaPlayerStatus || {};
          const SPORT_SB_PATH = { nba: "basketball/nba", wnba: "basketball/wnba", nhl: "hockey/nhl", mlb: "baseball/mlb" };
          // When game times are already cached we still need scoreboards for any sport that
          // needs summary data (NBA + WNBA both fetch starters via per-event summary endpoints).
          const sportsToFetch = needGameTimes
            ? [...sportsNeeded].filter(s => SPORT_SB_PATH[s])
            : [
                ...(needNbaSummaries ? ["nba"] : []),
                ...(needWnbaStarters ? ["wnba"] : []),
              ];
          const yesterdayDateStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, "");
          const tomorrowDateStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10).replace(/-/g, "");
          const sbResults = await Promise.all(sportsToFetch.map(async s => {
            try {
              const H2 = { "User-Agent": "Mozilla/5.0" };
              const base = `https://site.api.espn.com/apis/site/v2/sports/${SPORT_SB_PATH[s]}/scoreboard`;
              const [r1, r2, r3] = await Promise.all([
                fetch(`${base}?dates=${yesterdayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${todayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${tomorrowDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
              ]);
              return { sport: s, events: [...(r1.events || []), ...(r2.events || []), ...(r3.events || [])] };
            } catch { return { sport: s, events: [] }; }
          }));
          if (needGameTimes) {
            for (const { sport, events } of sbResults) {
              for (const ev of events) {
                const abbrs = (ev.competitions?.[0]?.competitors || []).map(c => c.team?.abbreviation).filter(Boolean);
                if (ev.date && abbrs.length === 2) {
                  const ptDate = PT_FMT.format(new Date(ev.date));
                  for (const abbr of abbrs) {
                    const key = `${sport}:${normTeam(sport, abbr)}`;
                    const _existDt = gameTimes[`${key}:${ptDate}`];
                    if (!_existDt || ev.date > _existDt) gameTimes[`${key}:${ptDate}`] = ev.date; // latest UTC time wins
                    if (!gameTimes[key]) gameTimes[key] = ev.date; // bare fallback (first seen wins)
                  }
                }
              }
            }
            if (CACHE2 && Object.keys(gameTimes).length > 0) await CACHE2.put(`gameTimes:v2:${todayDateStr}`, JSON.stringify(gameTimes), { expirationTtl: 600 }).catch(() => {});
            // Extract MLB weather from already-fetched scoreboard events (no extra request)
            const _mlbSbResult = sbResults.find(r => r.sport === "mlb");
            _extractMlbWeather(_mlbSbResult?.events ?? [], weatherByGame, normTeam);
            if (CACHE2 && Object.keys(weatherByGame).length > 0) await CACHE2.put(`weather:mlb:${todayDateStr}`, JSON.stringify(weatherByGame), { expirationTtl: 600 }).catch(() => {});
            // Extract NHL game odds + scores from already-fetched ESPN events (no extra request)
            const _nhlSbResult = sbResults.find(r => r.sport === "nhl");
            if (_nhlSbResult?.events.length > 0) {
              const _raw = parseGameOdds(_nhlSbResult.events);
              sportByteam.nhlGameOdds = Object.fromEntries(Object.entries(_raw).map(([k, v]) => [normTeam("nhl", k), v]));
              sportByteam.nhlGameScores = parseGameScores(_nhlSbResult.events, a => normTeam("nhl", a));
              sportByteam.nhlTopPlayers = parseTopPlayers(_nhlSbResult.eventsAll || _nhlSbResult.events, a => normTeam("nhl", a), "nhl");
            }
            // Extract NBA game scores from already-fetched ESPN events
            const _nbaSbResult = sbResults.find(r => r.sport === "nba");
            if (_nbaSbResult?.events.length > 0 && !sportByteam.nbaGameScores) {
              sportByteam.nbaGameScores = parseGameScores(_nbaSbResult.events, a => normTeam("nba", a));
            }
            // Extract WNBA game odds + scores from already-fetched ESPN events
            const _wnbaSbResult = sbResults.find(r => r.sport === "wnba");
            if (_wnbaSbResult?.events.length > 0) {
              if (!sportByteam.wnbaGameOdds) sportByteam.wnbaGameOdds = Object.fromEntries(Object.entries(parseGameOdds(_wnbaSbResult.events)).map(([k, v]) => [normTeam("wnba", k), v]));
              if (!sportByteam.wnbaGameScores) sportByteam.wnbaGameScores = parseGameScores(_wnbaSbResult.events, a => normTeam("wnba", a));
            }
          }
          if (needNbaSummaries) {
            // One fetch per game serves BOTH injuries (nbaPlayerStatus) and boxscore starters
            // (nbaStarters). Both feed downstream consumers with 600s TTL on the same cycle.
            const nbaEvents = sbResults.find(r => r.sport === "nba")?.events || [];
            const _starterConfirmedTeams = [];
            const _starterByTeam = {};
            await Promise.all(nbaEvents.map(async ev => {
              try {
                const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${ev.id}`, { headers: { "User-Agent": "Mozilla/5.0" } });
                if (!r.ok) return;
                const d = await r.json();
                if (needNbaStatus) {
                  for (const teamInj of d.injuries || []) {
                    for (const inj of teamInj.injuries || []) {
                      const aid = inj.athlete?.id;
                      if (aid) nbaPlayerStatus[String(aid)] = (inj.status || "Out").toLowerCase();
                    }
                  }
                }
                if (needNbaStarters) {
                  for (const tp of d.boxscore?.players || []) {
                    const abbr = normTeam("nba", tp.team?.abbreviation || "");
                    if (!abbr) continue;
                    const athletes = tp.statistics?.[0]?.athletes || [];
                    const starterIds = athletes.filter(a => a.starter).map(a => String(a.athlete?.id || "")).filter(Boolean);
                    if (starterIds.length > 0) {
                      _starterConfirmedTeams.push(abbr);
                      _starterByTeam[abbr] = starterIds;
                    }
                  }
                }
              } catch {}
            }));
            if (needNbaStatus && CACHE2) await CACHE2.put(`nbaStatus:${todayDateStr}`, JSON.stringify(nbaPlayerStatus), { expirationTtl: 600 }).catch(() => {});
            if (needNbaStarters) {
              nbaStarters = { confirmedTeams: _starterConfirmedTeams, startersByTeam: _starterByTeam };
              if (CACHE2) await CACHE2.put(`nba:starters:${todayDateStr}`, JSON.stringify(nbaStarters), { expirationTtl: 600 }).catch(() => {});
            }
          }
          if (needWnbaStarters) {
            // Mirror the NBA starter detection for WNBA. Boxscore shape is identical at the
            // basketball/wnba/summary endpoint. Same 600s cache TTL.
            const wnbaEvents = sbResults.find(r => r.sport === "wnba")?.events || [];
            const _wStarterConfirmedTeams = [];
            const _wStarterByTeam = {};
            await Promise.all(wnbaEvents.map(async ev => {
              try {
                const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event=${ev.id}`, { headers: { "User-Agent": "Mozilla/5.0" } });
                if (!r.ok) return;
                const d = await r.json();
                for (const tp of d.boxscore?.players || []) {
                  const abbr = normTeam("wnba", tp.team?.abbreviation || "");
                  if (!abbr) continue;
                  const athletes = tp.statistics?.[0]?.athletes || [];
                  const starterIds = athletes.filter(a => a.starter).map(a => String(a.athlete?.id || "")).filter(Boolean);
                  if (starterIds.length > 0) {
                    _wStarterConfirmedTeams.push(abbr);
                    _wStarterByTeam[abbr] = starterIds;
                  }
                }
              } catch {}
            }));
            wnbaStarters = { confirmedTeams: _wStarterConfirmedTeams, startersByTeam: _wStarterByTeam };
            if (CACHE2) await CACHE2.put(`wnba:starters:${todayDateStr}`, JSON.stringify(wnbaStarters), { expirationTtl: 600 }).catch(() => {});
          }
        }
        nbaPlayerStatus = nbaPlayerStatus || {};
        // sportByteam.{nba,wnba}Starters are the single sources the dataConfidence helper reads.
        // Always assign — populated either by the summary fetch block above (cache miss path)
        // or by the parallel cache load at the top of this section (warm path).
        sportByteam.nbaStarters = nbaStarters || { confirmedTeams: [], startersByTeam: {} };
        sportByteam.wnbaStarters = wnbaStarters || { confirmedTeams: [], startersByTeam: {} };
        // Refresh MLB weather independently if cache was empty (gameTimes may have been cached)
        if (sportsNeeded.has("mlb") && Object.keys(weatherByGame).length === 0 && !isBustCache) {
          try {
            const _wRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${todayDateStr}`, { headers: { "User-Agent": "Mozilla/5.0" } }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
            _extractMlbWeather(_wRes.events || [], weatherByGame, normTeam);
            if (CACHE2 && Object.keys(weatherByGame).length > 0) await CACHE2.put(`weather:mlb:${todayDateStr}`, JSON.stringify(weatherByGame), { expirationTtl: 600 }).catch(() => {});
          } catch {}
        }
        // Fetch NHL game odds + scores if nhl byteam was loaded from cache (scoreboard not fetched above)
        if (sportsNeeded.has("nhl") && !sportByteam.nhlGameOdds) {
          const _nd3a = new Date(Date.now() - 7 * 3600 * 1000); const _nd3b = new Date(_nd3a); _nd3b.setDate(_nd3b.getDate() + 1);
          const _ns3fmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
          const _nh3 = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
          const [_nhlFbSb0, _nhlFbSb1] = await Promise.all([
            fetch(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${_ns3fmt(_nd3a)}`, { headers: _nh3 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${_ns3fmt(_nd3b)}`, { headers: _nh3 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
          ]);
          const _nhlFbToday = _nhlFbSb0.events || [];
          const _nhlFbAll = [..._nhlFbToday, ...(_nhlFbSb1.events || [])];
          sportByteam.nhlGameOdds = Object.fromEntries(Object.entries(parseGameOdds(_nhlFbToday)).map(([k, v]) => [normTeam("nhl", k), v]));
          if (!sportByteam.nhlGameScores) sportByteam.nhlGameScores = parseGameScores(_nhlFbAll, a => normTeam("nhl", a));
          if (!sportByteam.nhlTopPlayers) sportByteam.nhlTopPlayers = parseTopPlayers(_nhlFbAll, a => normTeam("nhl", a), "nhl");
        }
        // Fetch WNBA game odds + scores if wnba byteam was loaded from cache (scoreboard not fetched above)
        if (sportsNeeded.has("wnba") && !sportByteam.wnbaGameOdds) {
          const _wd2a = new Date(Date.now() - 7 * 3600 * 1000); const _wd2b = new Date(_wd2a); _wd2b.setDate(_wd2b.getDate() + 1);
          const _ws2fmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
          const _wh2 = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
          const [_wnbaFbSb0, _wnbaFbSb1] = await Promise.all([
            fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${_ws2fmt(_wd2a)}`, { headers: _wh2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${_ws2fmt(_wd2b)}`, { headers: _wh2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
          ]);
          const _wnbaFbToday = _wnbaFbSb0.events || [];
          const _wnbaFbAll = [..._wnbaFbToday, ...(_wnbaFbSb1.events || [])];
          sportByteam.wnbaGameOdds = Object.fromEntries(Object.entries(parseGameOdds(_wnbaFbToday)).map(([k, v]) => [normTeam("wnba", k), v]));
          if (!sportByteam.wnbaGameScores) sportByteam.wnbaGameScores = parseGameScores(_wnbaFbAll, a => normTeam("wnba", a));
          if (!sportByteam.wnbaTopPlayers) sportByteam.wnbaTopPlayers = parseTopPlayers(_wnbaFbAll, a => normTeam("wnba", a), "wnba");
        }
        // Fetch NBA game odds + scores if nba byteam was loaded from cache (scoreboard not fetched above)
        if (sportsNeeded.has("nba") && !sportByteam.nbaGameOdds) {
          const _nd2a = new Date(Date.now() - 7 * 3600 * 1000); const _nd2b = new Date(_nd2a); _nd2b.setDate(_nd2b.getDate() + 1);
          const _ns2fmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
          const _nh2 = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
          const [_nbaFbSb0, _nbaFbSb1] = await Promise.all([
            fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_ns2fmt(_nd2a)}`, { headers: _nh2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_ns2fmt(_nd2b)}`, { headers: _nh2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
          ]);
          const _nbaFbToday = _nbaFbSb0.events || [];
          const _nbaFbAll = [..._nbaFbToday, ...(_nbaFbSb1.events || [])];
          sportByteam.nbaGameOdds = parseGameOdds(_nbaFbToday);
          if (!sportByteam.nbaGameScores) sportByteam.nbaGameScores = parseGameScores(_nbaFbAll, a => normTeam("nba", a));
          if (!sportByteam.nbaTopPlayers) sportByteam.nbaTopPlayers = parseTopPlayers(_nbaFbAll, a => normTeam("nba", a), "nba");
        }
        // Fill in missing NBA game O/U totals from Kalshi (ESPN omits odds for live/imminent games)
        if (Object.keys(kalshiNbaOuMap).length > 0) {
          if (!sportByteam.nbaGameOdds) sportByteam.nbaGameOdds = {};
          for (const [_team, _ouLine] of Object.entries(kalshiNbaOuMap)) {
            if (!sportByteam.nbaGameOdds[_team]) sportByteam.nbaGameOdds[_team] = {};
            if (sportByteam.nbaGameOdds[_team].total == null) sportByteam.nbaGameOdds[_team].total = _ouLine;
          }
        }
        if (Object.keys(kalshiWnbaOuMap).length > 0) {
          if (!sportByteam.wnbaGameOdds) sportByteam.wnbaGameOdds = {};
          for (const [_team, _ouLine] of Object.entries(kalshiWnbaOuMap)) {
            if (!sportByteam.wnbaGameOdds[_team]) sportByteam.wnbaGameOdds[_team] = {};
            if (sportByteam.wnbaGameOdds[_team].total == null) sportByteam.wnbaGameOdds[_team].total = _ouLine;
          }
        }
        // Same Kalshi fallback for MLB — covers tomorrow's games where today's ESPN scoreboard
        // doesn't carry odds and `mlbMetaTomorrow.gameOdds` is intentionally empty.
        if (Object.keys(kalshiMlbOuMap).length > 0) {
          if (!sportByteam.mlb) sportByteam.mlb = {};
          if (!sportByteam.mlb.gameOdds) sportByteam.mlb.gameOdds = {};
          for (const [_team, _ouLine] of Object.entries(kalshiMlbOuMap)) {
            if (!sportByteam.mlb.gameOdds[_team]) sportByteam.mlb.gameOdds[_team] = {};
            if (sportByteam.mlb.gameOdds[_team].total == null) sportByteam.mlb.gameOdds[_team].total = _ouLine;
          }
        }
        // Same Kalshi fallback for NHL.
        if (Object.keys(kalshiNhlOuMap).length > 0) {
          if (!sportByteam.nhlGameOdds) sportByteam.nhlGameOdds = {};
          for (const [_team, _ouLine] of Object.entries(kalshiNhlOuMap)) {
            if (!sportByteam.nhlGameOdds[_team]) sportByteam.nhlGameOdds[_team] = {};
            if (sportByteam.nhlGameOdds[_team].total == null) sportByteam.nhlGameOdds[_team].total = _ouLine;
          }
        }
        const STAT_SOFT = {};
        if (sportByteam.nba) {
          for (const st of ["points", "rebounds", "assists", "threePointers"]) {
            STAT_SOFT[`nba|${st}`] = { softTeams: new Set(buildSoftTeamAbbrs(sportByteam.nba, st)), rankMap: buildTeamRankMap(sportByteam.nba, st) };
          }
          // Normalize short ESPN codes (GS→GSW, SA→SAS, etc.) so game-total lookups find the right key
          const _nbaAbbrs = TEAM_NORM.nba;
          for (const st of ["points", "rebounds", "assists", "threePointers"]) {
            const ss = STAT_SOFT[`nba|${st}`];
            if (!ss) continue;
            for (const [raw, val] of Object.entries(ss.rankMap)) {
              const norm = _nbaAbbrs[raw];
              if (norm && !ss.rankMap[norm]) ss.rankMap[norm] = val;
            }
            for (const raw of [...ss.softTeams]) {
              const norm = _nbaAbbrs[raw];
              if (norm) ss.softTeams.add(norm);
            }
          }
        }
        if (sportByteam.wnba) {
          for (const st of ["points", "rebounds", "assists", "threePointers"]) {
            STAT_SOFT[`wnba|${st}`] = { softTeams: new Set(buildSoftTeamAbbrs(sportByteam.wnba, st)), rankMap: buildTeamRankMap(sportByteam.wnba, st) };
          }
          // Normalize ESPN's irregular WNBA codes (CONNECTICU→CONN, DALLAS→DAL) to canonical
          const _wnbaAbbrs = TEAM_NORM.wnba;
          for (const st of ["points", "rebounds", "assists", "threePointers"]) {
            const ss = STAT_SOFT[`wnba|${st}`];
            if (!ss) continue;
            for (const [raw, val] of Object.entries(ss.rankMap)) {
              const norm = _wnbaAbbrs[raw];
              if (norm && !ss.rankMap[norm]) ss.rankMap[norm] = val;
            }
            for (const raw of [...ss.softTeams]) {
              const norm = _wnbaAbbrs[raw];
              if (norm) ss.softTeams.add(norm);
            }
          }
        }
        let nhlSaRankMap = {}, nhlLeagueAvgSa = null;
        if (sportByteam.nhl) {
          const { ga, sa } = sportByteam.nhl;
          STAT_SOFT["nhl|points"] = nhlSoftTeams(ga, "goalsAgainstPerGame", "Goals against/game", "GAA");
          if (sa?.length) {
            const _nhlSa = nhlSoftTeams(sa, "shotsAgainstPerGame", "Shots against/game", "SA");
            nhlSaRankMap = _nhlSa.rankMap;
            const _saVals = Object.values(nhlSaRankMap).map(r => r.value).filter(v => v > 0);
            if (_saVals.length >= 15) nhlLeagueAvgSa = parseFloat((_saVals.reduce((a, b) => a + b, 0) / _saVals.length).toFixed(2));
          }
        }
        if (sportByteam.mlb) {
          const { pitching, batting, probables = {} } = sportByteam.mlb;
          const LEAGUE_AVG_ERA = 4;
          const teamFallback = mlbSoftTeams(pitching, false);
          const pitcherEntries = Object.entries(probables).filter(([, p]) => p.era !== null && !isNaN(p.era)).sort(([, a], [, b]) => b.era - a.era);
          const hitterSoftTeams = /* @__PURE__ */ new Set();
          const hitterRankMap = { ...teamFallback.rankMap };
          pitcherEntries.forEach(([abbr, { name, era }], i) => {
            if (era > LEAGUE_AVG_ERA) hitterSoftTeams.add(abbr);
            hitterRankMap[abbr] = { rank: i + 1, value: era, label: `${name || abbr} ERA`, unit: "ERA" };
          });
          for (const abbr of teamFallback.softTeams) {
            if (!probables[abbr]) hitterSoftTeams.add(abbr);
          }
          for (const st of ["hits", "hrr"]) {
            STAT_SOFT[`mlb|${st}`] = { softTeams: hitterSoftTeams, rankMap: hitterRankMap };
          }
          STAT_SOFT["mlb|strikeouts"] = mlbSoftTeams(batting, true);
        }
        if (sportByteam.nfl) {
          const NFL_STAT_METRIC = {
            passingYards: { hint: "opponent passing", idx: 8, label: "Pass yds allowed", unit: "PAYDS" },
            rushingYards: { hint: "opponent rushing", idx: 1, label: "Rush yds allowed", unit: "RUYDS" },
            receivingYards: { hint: "opponent receiving", idx: 3, label: "Rec yds allowed", unit: "REYDS" },
            touchdowns: { hint: "opponent passing", idx: 8, label: "Pass yds allowed", unit: "PAYDS" }
          };
          for (const [st, { hint, idx, label, unit }] of Object.entries(NFL_STAT_METRIC)) {
            const sorted = [...sportByteam.nfl].map((t) => {
              const cat = (t.categories || []).find((c) => c.displayName?.toLowerCase().includes(hint));
              return { abbr: t.team?.abbreviation || "", val: parseFloat(cat?.values?.[idx] ?? 0) };
            }).filter((t) => t.abbr).sort((a, b) => b.val - a.val);
            const softTeams = new Set(sorted.slice(0, 10).map((t) => t.abbr));
            const rankMap = {};
            sorted.forEach((t, i) => {
              rankMap[t.abbr] = { rank: i + 1, value: parseFloat(t.val.toFixed(1)), label, unit };
            });
            STAT_SOFT[`nfl|${st}`] = { softTeams, rankMap };
          }
        }
        // Read all secondary caches in parallel, then fire any cold fallbacks in parallel too.
        let [allPositionsDvp, nbaDepthChartPos, _cachedBarrel, _cachedPace] = await Promise.all([
          CACHE2 ? CACHE2.get("dvp:nba:all-positions", "json").catch(() => null) : null,
          CACHE2 ? CACHE2.get("dvp:nba:depth-chart-pos", "json").catch(() => null) : null,
          (sportsNeeded.has("mlb") && CACHE2) ? CACHE2.get("mlb:barrelPct", "json").catch(() => null) : null,
          (sportsNeeded.has("nba") && CACHE2 && !isBustCache) ? CACHE2.get("nba:pace:2526", "json").catch(() => null) : null
        ]);
        // WNBA: pace + DVP (cached first, cold-build if missing). Mirrors NBA pace+depthchart pair.
        let _cachedWnbaPace = (sportsNeeded.has("wnba") && CACHE2 && !isBustCache) ? await CACHE2.get("wnba:pace:2025", "json").catch(() => null) : null;
        let _cachedWnbaDvp = (sportsNeeded.has("wnba") && CACHE2 && !isBustCache) ? await CACHE2.get(`wnba:dvp:2025:${(/* @__PURE__ */ new Date()).toISOString().slice(0,10)}`, "json").catch(() => null) : null;
        // Fire cold fallbacks in parallel
        [allPositionsDvp, nbaDepthChartPos, _cachedBarrel, _cachedPace, _cachedWnbaPace, _cachedWnbaDvp] = await Promise.all([
          (!allPositionsDvp && CACHE2) ? buildNbaDvpFromBettingPros(CACHE2).catch(() => null) : allPositionsDvp,
          (!nbaDepthChartPos && CACHE2) ? buildNbaDepthChartPos(CACHE2).catch(() => null) : nbaDepthChartPos,
          (!_cachedBarrel && sportsNeeded.has("mlb")) ? buildBarrelPct().then(async m => { if (CACHE2 && Object.keys(m).length > 0) await CACHE2.put("mlb:barrelPct", JSON.stringify(m), { expirationTtl: 21600 }).catch(() => {}); return m; }).catch(() => null) : _cachedBarrel,
          (!_cachedPace && sportsNeeded.has("nba")) ? buildNbaPaceData(CACHE2).catch(() => null) : _cachedPace,
          (!_cachedWnbaPace && sportsNeeded.has("wnba")) ? buildWnbaPaceData(CACHE2, 2025).catch(() => null) : _cachedWnbaPace,
          (!_cachedWnbaDvp && sportsNeeded.has("wnba")) ? buildWnbaDvp(CACHE2, 2025).catch(() => null) : _cachedWnbaDvp
        ]);
        if (sportByteam.mlb && _cachedBarrel) sportByteam.mlb.barrelPctMap = _cachedBarrel;
        const nbaPaceData = _cachedPace;
        const wnbaPaceData = _cachedWnbaPace;
        const wnbaDvpMap = _cachedWnbaDvp;
        const preFilteredMarkets = [];
        const preDropped = [];
        for (const m of qualifyingMarkets) {
          const softData = STAT_SOFT[`${m.sport}|${m.stat}`];
          if (!softData) { preDropped.push({ ...m, reason: "no_soft_data" }); continue; }
          if (m.sport === "mlb") {
            if (!m.gameTeam1 || !m.gameTeam2) { preDropped.push({ ...m, reason: "no_opp" }); continue; }
            if (m.stat === "strikeouts") {
              const _gs26 = sportByteam.mlb?.pitcherGS26?.[m.kalshiPlayerTeam] ?? null;
              const _hasAnchor = sportByteam.mlb?.pitcherHasAnchor?.[m.kalshiPlayerTeam] ?? null;
              // No 2025 anchor (TJ return, pure reliever, etc.): require 8 GS in 2026.
              // Treat null 2026 data as 0 — if the API can't confirm starts, don't trust the model.
              // Has valid 2025 anchor (gs25≥5, bf25≥100): pass through regardless of gs26 — the anchor IS the reliability signal.
              if (_hasAnchor !== true) {
                if ((_gs26 ?? 0) < 8) { preDropped.push({ ...m, reason: "insufficient_starts", gs26: _gs26 ?? 0, hasAnchor: _hasAnchor }); continue; }
              }
              preFilteredMarkets.push(m); continue;
            }
            const playerTeam2 = m.kalshiPlayerTeam;
            if (!playerTeam2) { preDropped.push({ ...m, reason: "no_opp" }); continue; }
            const opp2 = m.gameTeam1 === playerTeam2 ? m.gameTeam2 : m.gameTeam2 === playerTeam2 ? m.gameTeam1 : null;
            if (!opp2) { preDropped.push({ ...m, reason: "no_opp" }); continue; }
            preFilteredMarkets.push(m);
            continue;
          }
          if (m.sport === "nhl") { preFilteredMarkets.push(m); continue; }
          // NBA (and others) — no soft-matchup gate; all markets enter the main loop
          const playerTeam = m.kalshiPlayerTeam;
          if (!playerTeam || !m.gameTeam1 || !m.gameTeam2) { preFilteredMarkets.push(m); continue; }
          const opp = m.gameTeam1 === playerTeam ? m.gameTeam2 : m.gameTeam2 === playerTeam ? m.gameTeam1 : null;
          if (!opp) { preDropped.push({ ...m, reason: "no_opp" }); continue; }
          preFilteredMarkets.push(m);
        }
        // In debug mode, process ALL qualifying markets so every player gets a gamelog fetch and full stats
        const loopMarkets = isDebugMode ? qualifyingMarkets : preFilteredMarkets;
        const uniquePlayerKeys = [...new Map(loopMarkets.map((m) => [`${m.sport}|${m.playerName}`, m])).keys()];
        const playerInfoMap = {};
        const keysNeedingInfo = [];
        if (CACHE2) {
          // Parallel cache reads — serial await per-key was seconds of dead time for large slates
          const pinfoVals = await Promise.all(uniquePlayerKeys.map(k => CACHE2.get(`pinfo:${k}`, "json").catch(() => null)));
          for (let i = 0; i < uniquePlayerKeys.length; i++) {
            const key = uniquePlayerKeys[i], cached = pinfoVals[i];
            if (cached) {
              playerInfoMap[key] = cached;
              if ((cached.position === null || cached.position === "G" || cached.position === "F") && key.startsWith("nba|")) keysNeedingInfo.push(key);
            } else {
              keysNeedingInfo.push(key);
            }
          }
        } else {
          keysNeedingInfo.push(...uniquePlayerKeys);
        }
        const ESPN_SEARCH_HEADERS = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.espn.com/",
          "Accept": "application/json"
        };
        const MAX_PINFO_FETCHES = 150;
        const pInfoErrors = [];
        // Parallel ESPN player-info fetches (pinfo cached 7 days so this is rare on warm caches)
        await Promise.all(keysNeedingInfo.slice(0, MAX_PINFO_FETCHES).map(async key => {
          const [sport, ...nameParts] = key.split("|");
          const playerName = nameParts.join("|");
          try {
            const r = await fetch(
              `${ESPN_BASE}/search/v2?query=${encodeURIComponent(playerName)}&lang=en&region=us&limit=5&type=player`,
              { headers: ESPN_SEARCH_HEADERS, signal: AbortSignal.timeout(5000) }
            );
            if (!r.ok) { pInfoErrors.push({ key, reason: `http_${r.status}` }); return; }
            const d = await r.json();
            const allContents = d.results?.find((x) => x.type === "player")?.contents || [];
            const players = allContents.filter((p2) => p2.defaultLeagueSlug === sport);
            if (!players.length) { pInfoErrors.push({ key, reason: "no_league_match", sport, found: allContents.map((c) => c.defaultLeagueSlug) }); return; }
            const p = players[0];
            const id = p.uid?.split("~a:")?.[1];
            if (!id) { pInfoErrors.push({ key, reason: "no_id", uid: p.uid }); return; }
            const posMatch = (p.description || p.subtitle || "").match(/\b(QB|RB|WR|TE|K|P|PG|SG|SF|PF|Center|Forward|Guard|C|G|F|SP|RP|OF|1B|2B|3B|SS|LW|RW|D)\b/i);
            const rawPos = posMatch ? posMatch[1].toUpperCase() : null;
            const POS_NORMALIZE = { CENTER: "C", GUARD: null, FORWARD: null };
            const info = { id, teamAbbr: "", position: rawPos ? rawPos in POS_NORMALIZE ? POS_NORMALIZE[rawPos] : rawPos === "G" || rawPos === "F" ? null : rawPos : null };
            playerInfoMap[key] = info;
            if (CACHE2) CACHE2.put(`pinfo:${key}`, JSON.stringify(info), { expirationTtl: 604800 }).catch(() => {});
          } catch (e) {
            pInfoErrors.push({ key, reason: "exception", error: String(e) });
          }
        }));
        const isDebug = isDebugMode || params.get("debug") === "true";
        const GAMELOG_API = {
          nba: /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog?season=2026`, "nba"),
          // WNBA anchors on 2025 (most-complete signal; 2026 season just opening). Trust ramps via vals26.
          wnba: /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/${id}/gamelog?season=2025`, "wnba"),
          nfl: /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}/gamelog?season=2025`, "nfl"),
          nhl: /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes/${id}/gamelog?season=2026`, "nhl"),
          mlb: /* @__PURE__ */ __name((id) => `https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${id}/gamelog?season=2026`, "mlb")
        };
        const playerGamelogs = {};
        const keysForGamelog = uniquePlayerKeys.filter((k) => playerInfoMap[k]?.id);
        const gamelogErrors = [];
        const keysNeedingGamelog = [];
        const _mlbAbbrNorm = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
        const _normGlOpp = (gl) => gl && gl.events ? { ...gl, events: gl.events.map((ev) => ev.oppAbbr && _mlbAbbrNorm[ev.oppAbbr] ? { ...ev, oppAbbr: _mlbAbbrNorm[ev.oppAbbr] } : ev) } : gl;
        // Two-way players (e.g. Ohtani) need &category=pitching for strikeout markets
        const _pitchPlayerKeys = new Set(loopMarkets.filter(m => m.stat === "strikeouts" && m.sport === "mlb").map(m => `mlb|${m.playerName}`));
        const _pitchGlCacheKey = (k) => glCacheKey(k).replace("242526v2", "242526pv1");
        if (CACHE2) {
          // Parallel cache lookups — serial await per-key was ~100ms × N players = seconds of dead time
          const cachedVals = await Promise.all(keysForGamelog.map(k => CACHE2.get(_pitchPlayerKeys.has(k) ? _pitchGlCacheKey(k) : glCacheKey(k), "json").catch(() => null)));
          for (let i = 0; i < keysForGamelog.length; i++) {
            if (cachedVals[i]) playerGamelogs[keysForGamelog[i]] = keysForGamelog[i].startsWith("mlb|") ? _normGlOpp(cachedVals[i]) : cachedVals[i];
            else keysNeedingGamelog.push(keysForGamelog[i]);
          }
        } else {
          keysNeedingGamelog.push(...keysForGamelog);
        }
        const ESPN_HEADERS = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.espn.com/",
          "Origin": "https://www.espn.com"
        };
        async function parseEspnGamelog(url2, debugKey) {
          try {
            const r = await fetch(url2, { headers: ESPN_HEADERS, signal: AbortSignal.timeout(6000) });
            if (!r.ok) {
              if (isDebug) gamelogErrors.push({ key: debugKey, status: r.status, url: url2 });
              return null;
            }
            const d = await r.json();
            const ul = (d.labels || []).map((l) => (l || "").toUpperCase());
            const events = [];
            const seenIds = /* @__PURE__ */ new Set();
            for (const st of d.seasonTypes || []) {
              const _stDn = (st.displayName || "").toLowerCase();
              if (_stDn.includes("pre") || _stDn.includes("spring") || _stDn.includes("exhibition")) continue;
              for (const cat of st.categories || []) {
                for (const ev of cat.events || []) {
                  if (seenIds.has(ev.eventId)) continue;
                  const meta = d.events?.[ev.eventId];
                  if (!meta || meta.opponent?.isAllStar) continue;
                  seenIds.add(ev.eventId);
                  // isHome: ESPN's atVs field is "vs"/"@" depending on home/away. Required by
                  // the NBA/WNBA home-away split adjustment (nbaSplitAdj / wnbaSplitAdj) which
                  // filters gamelog events by location. Without this field on each event the
                  // splitAdj computation silently falls back to 1.0.
                  events.push({
                    stats: ev.stats || [],
                    oppAbbr: meta.opponent?.abbreviation || "",
                    isHome: meta.atVs != null ? meta.atVs !== "@" : null,
                  });
                }
              }
            }
            return events.length ? { ul, events } : null;
          } catch (e) {
            if (isDebug) gamelogErrors.push({ key: debugKey, err: String(e) });
            return null;
          }
        }
        __name(parseEspnGamelog, "parseEspnGamelog");
        async function fetchGamelog(key, overrideId = null, forcePitching = false) {
          const [sport] = key.split("|");
          const info = playerInfoMap[key];
          const athleteId = overrideId || info?.id;
          if (!athleteId) return;
          if (sport === "mlb") {
            const catSuffix = forcePitching ? "&category=pitching" : "";
            const pSfx = forcePitching ? "p" : "";
            const baseUrl = `https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${athleteId}/gamelog`;
            const key24 = `gl:mlb2024${pSfx}|${key}`;
            const key25 = `gl:mlb2025${pSfx}|${key}`;
            const key26 = `gl:mlb2026${pSfx}|${key}`;
            let [gl24, gl25] = CACHE2 ? await Promise.all([
              CACHE2.get(key24, "json").catch(() => null),
              CACHE2.get(key25, "json").catch(() => null)
            ]) : [null, null];
            const fetchSeasons = [2026];
            if (!gl25) fetchSeasons.push(2025);
            if (!gl24) fetchSeasons.push(2024);
            const results = await Promise.all(fetchSeasons.map((yr) => parseEspnGamelog(`${baseUrl}?season=${yr}${catSuffix}`, key)));
            const seasonResults = Object.fromEntries(fetchSeasons.map((yr, i) => [yr, results[i]]));
            const gl26 = seasonResults[2026] || null;
            if (!gl25) {
              gl25 = seasonResults[2025] || null;
              if (gl25 && CACHE2) await CACHE2.put(key25, JSON.stringify(gl25), { expirationTtl: 86400 });
            }
            if (!gl24) {
              gl24 = seasonResults[2024] || null;
              if (gl24 && CACHE2) await CACHE2.put(key24, JSON.stringify(gl24), { expirationTtl: 86400 });
            }
            if (gl26 && CACHE2) await CACHE2.put(key26, JSON.stringify(gl26), { expirationTtl: 21600 });
            const anyGl = gl26 || gl25 || gl24;
            if (anyGl) {
              const ul = anyGl.ul;
              const _mlbNorm = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
              const normOpp = (o) => _mlbNorm[o] || o;
              const events = [
                ...(gl26?.events || []).map((ev) => ({ ...ev, season: 2026, oppAbbr: normOpp(ev.oppAbbr) })),
                ...(gl25?.events || []).map((ev) => ({ ...ev, season: 2025, oppAbbr: normOpp(ev.oppAbbr) })),
                ...(gl24?.events || []).map((ev) => ({ ...ev, season: 2024, oppAbbr: normOpp(ev.oppAbbr) }))
              ];
              playerGamelogs[key] = { ul, events };
              const combinedKey = forcePitching ? _pitchGlCacheKey(key) : glCacheKey(key);
              if (CACHE2) await CACHE2.put(combinedKey, JSON.stringify({ ul, events }), { expirationTtl: 21600 });
            }
          } else {
            const glUrl = GAMELOG_API[sport]?.(athleteId);
            if (!glUrl) return;
            const gl = await parseEspnGamelog(glUrl, key);
            if (gl) {
              playerGamelogs[key] = gl;
              if (CACHE2) await CACHE2.put(glCacheKey(key), JSON.stringify(gl), { expirationTtl: 21600 });
            }
          }
        }
        __name(fetchGamelog, "fetchGamelog");
        // Fetch all uncached gamelogs in parallel — batching with delays was adding ~26s for 60 players
        const GL_BATCH = 5; // kept for pitcher loop below
        await Promise.all(keysNeedingGamelog.map((k) => fetchGamelog(k, null, _pitchPlayerKeys.has(k))));
        const pitcherGamelogs = {};
        // Merge probables (ESPN source) with pitcherInfoByTeam (MLB Stats API source).
        // pitcherInfoByTeam is more reliable for early-day requests before ESPN announces probables.
        const _allPitcherEntries = new Map();
        for (const [abbr, info] of Object.entries(sportByteam.mlb?.pitcherInfoByTeam || {})) {
          if (info?.name && info?.id) _allPitcherEntries.set(abbr, { name: info.name, id: info.id });
        }
        // ESPN probables take precedence (override MLB API entry with ESPN name/id if available)
        for (const [abbr, info] of Object.entries(sportByteam.mlb?.probables || {})) {
          if (info?.name && info?.id) _allPitcherEntries.set(abbr, { name: info.name, id: info.id });
        }
        const pitcherEntriesToLoad = [..._allPitcherEntries.entries()];
        if (pitcherEntriesToLoad.length > 0) {
          await Promise.all(pitcherEntriesToLoad.map(async ([teamAbbr, { name }]) => {
            const pitcherKey = `mlb|${name}`;
            const cached = CACHE2 ? await CACHE2.get(_pitchGlCacheKey(pitcherKey), "json").catch(() => null) : null;
            if (cached) pitcherGamelogs[teamAbbr] = { name, gl: _normGlOpp(cached) };
          }));
          const uncachedPitchers = pitcherEntriesToLoad.filter(([teamAbbr]) => !pitcherGamelogs[teamAbbr]);
          await Promise.all(uncachedPitchers.map(async ([teamAbbr, { name, id }]) => {
            const pitcherKey = `mlb|${name}`;
            await fetchGamelog(pitcherKey, id, true);
            const gl = playerGamelogs[pitcherKey] || null;
            if (gl) pitcherGamelogs[teamAbbr] = { name, gl };
          }));
        }
        const leagueAvgCache = {};
        for (const key of ["nba|points", "nba|rebounds", "nba|assists", "nba|threePointers", "wnba|points", "wnba|rebounds", "wnba|assists", "wnba|threePointers", "nhl|points"]) {
          const sd = STAT_SOFT[key];
          if (!sd) continue;
          const vals = Object.values(sd.rankMap).map((r) => r.value).filter((v) => v > 0);
          if (vals.length >= 15) leagueAvgCache[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        // ── Game total: team stat maps (RPG, GPG, PPG) ──────────────────────────────────────────
        const mlbRPGMap = {};
        if (sportByteam.mlb?.batting) {
          const _bt = sportByteam.mlb.batting;
          const _btTop = (_bt.categories || []).find(c => c.name === "batting");
          const _gIdx = (_btTop?.names || []).findIndex(n => n === "G" || n === "GP" || n === "gamesPlayed");
          const _rIdx = (_btTop?.names || []).findIndex(n => n === "R" || n === "runs");
          const _MLB2 = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
          if (_gIdx !== -1 && _rIdx !== -1) {
            for (const team of (_bt.teams || [])) {
              const abbr = _MLB2[team.team?.abbreviation] || team.team?.abbreviation;
              if (!abbr) continue;
              const tc = (team.categories || []).find(c => c.name === "batting");
              const gp = parseFloat(tc?.values?.[_gIdx] ?? 0);
              const runs = parseFloat(tc?.values?.[_rIdx] ?? 0);
              if (gp > 0 && runs > 0) mlbRPGMap[abbr] = parseFloat((runs / gp).toFixed(2));
            }
          }
        }
        const mlbLeagueAvgRPG = (() => { const vals = Object.values(mlbRPGMap).filter(v => v > 0); return vals.length >= 15 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : 4.5; })();
        // Road RPG and team ERA maps (for park-clean lambdas and 60/40 bullpen proxy)
        const mlbRoadRPGMap = sportByteam.mlb?.roadRPGMap || {};
        const mlbTeamERAMap = sportByteam.mlb?.teamERAMap || {};
        const mlbTeamWHIPMap = sportByteam.mlb?.teamWHIPMap || {};
        // Bullpen-only maps. Used in MLB game-total + team-total lambda's 40% rest-of-game share
        // to replace whole-staff teamERA (which double-counts the starter). Falls back to teamERA
        // when bullpen aggregate is missing (rare — MLB Stats API is reliable).
        const mlbBullpenERAMap = sportByteam.mlb?.bullpenERAMap || {};
        const mlbBullpenWHIPMap = sportByteam.mlb?.bullpenWHIPMap || {};
        const nhlGPGMap = {};
        const nhlGAAMap = {};
        if (sportByteam.nhl) {
          for (const team of (sportByteam.nhl.ga || [])) {
            const abbr = NHL_ABBR_MAP[team.teamId];
            if (!abbr) continue;
            if (team.goalsForPerGame != null) nhlGPGMap[abbr] = parseFloat(team.goalsForPerGame.toFixed(2));
            if (team.goalsAgainstPerGame != null) nhlGAAMap[abbr] = parseFloat(team.goalsAgainstPerGame.toFixed(2));
          }
        }
        const nhlLeagueAvgGAA = leagueAvgCache["nhl|points"] ?? 3.0;
        const nhlLeagueAvgGPG = (() => { const vals = Object.values(nhlGPGMap).filter(v => v > 0); return vals.length >= 15 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : 2.9; })();
        // Starting-goalie data (buildNhlGoalieData). goalieByTeam[abbr] = {starterName, starterSV, starterGS, source}.
        // Used in NHL game-total lambda to shift opponent factor toward tonight's actual goaltender instead of
        // team-aggregate GAA (which conflates starter and backup). Fallback to team GAA when goalie absent.
        const nhlGoalieByTeam = sportByteam.nhl?.goalieByTeam || {};
        const nhlLeagueAvgSV = sportByteam.nhl?.leagueAvgSV ?? 0.905;
        const nbaOffPPGMap = {};
        if (Array.isArray(sportByteam.nbaScoring)) {
          for (const team of sportByteam.nbaScoring) {
            const rawAbbr = team.team?.abbreviation || "";
            const abbr = TEAM_NORM.nba[rawAbbr] || rawAbbr;
            if (!abbr) continue;
            const offCat = (team.categories || []).find(c => { const dn = (c.displayName || c.name || "").toLowerCase(); return dn.includes("offensive") || dn.includes("scoring"); });
            const ppg = parseFloat(offCat?.values?.[0] ?? 0);
            if (ppg > 0) nbaOffPPGMap[abbr] = parseFloat(ppg.toFixed(1));
          }
        }
        const nbaLeagueAvgOffPPG = (() => { const vals = Object.values(nbaOffPPGMap).filter(v => v > 0); return vals.length >= 15 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : 113.0; })();
        // C1: NBA usage rate map (espnId → { usg, source })
        const nbaUsageMap = {};
        // C2: NBA injury report (teamAbbr → [{name, status}])
        let nbaInjuryMap = new Map();
        if (sportsNeeded.has("nba")) {
          const _nbaPlayerIds = [...new Set(
            Object.entries(playerInfoMap)
              .filter(([k]) => k.startsWith("nba|"))
              .map(([, v]) => v?.id)
              .filter(Boolean)
          )];
          const [_usgResult, _injResult] = await Promise.all([
            _nbaPlayerIds.length > 0 ? buildNbaUsageRate(_nbaPlayerIds, CACHE2) : Promise.resolve({}),
            buildNbaInjuryReport(CACHE2)
          ]);
          Object.assign(nbaUsageMap, _usgResult);
          nbaInjuryMap = _injResult;
          // Supplementary usage fetch for Out players not in the Kalshi-driven playerInfoMap
          // (e.g., a 7th man with no prop markets). Lets the totals lambda's offRtgAdj cover
          // every Out player, not just those who happen to have Kalshi props tonight.
          const _injOutIds = [];
          for (const players of nbaInjuryMap.values()) {
            for (const p of players) {
              if (p.id && p.status === "out" && !nbaUsageMap[p.id]) _injOutIds.push(p.id);
            }
          }
          if (_injOutIds.length > 0) {
            const _injUsg = await buildNbaUsageRate(_injOutIds, CACHE2);
            Object.assign(nbaUsageMap, _injUsg);
          }
        }
        // Same pattern for WNBA — 2025-anchored USG; injuries.
        const wnbaUsageMap = {};
        let wnbaInjuryMap = new Map();
        if (sportsNeeded.has("wnba")) {
          const _wnbaPlayerIds = [...new Set(
            Object.entries(playerInfoMap)
              .filter(([k]) => k.startsWith("wnba|"))
              .map(([, v]) => v?.id)
              .filter(Boolean)
          )];
          const [_wusgResult, _winjResult] = await Promise.all([
            _wnbaPlayerIds.length > 0 ? buildWnbaUsageRate(_wnbaPlayerIds, CACHE2, 2025) : Promise.resolve({}),
            buildWnbaInjuryReport(CACHE2)
          ]);
          Object.assign(wnbaUsageMap, _wusgResult);
          wnbaInjuryMap = _winjResult;
          const _wInjOutIds = [];
          for (const players of wnbaInjuryMap.values()) {
            for (const p of players) {
              if (p.id && p.status === "out" && !wnbaUsageMap[p.id]) _wInjOutIds.push(p.id);
            }
          }
          if (_wInjOutIds.length > 0) {
            const _wInjUsg = await buildWnbaUsageRate(_wInjOutIds, CACHE2, 2025);
            Object.assign(wnbaUsageMap, _wInjUsg);
          }
        }
        // Injury-adjusted OffRtg helper for NBA/WNBA totals lambda. Sums USG% of all Out players
        // on a team and applies replacement-penalty factor (0.15 — empirically calibrated: losing a
        // 28% USG star drops team OffRtg ~4%). Returns the {share, adj} pair so _simData can expose
        // both. Cap at 0.85 prevents multi-star scenarios from cratering lambda below 85% of base.
        // Players missing usage data contribute 0 (won't error; treated as not playing meaningfully).
        const _OFFRTG_INJ_FACTOR = 0.15;
        const _OFFRTG_INJ_CAP = 0.85;
        const _NBAshortNorm = { GSW:"GS", SAS:"SA", NYK:"NY", NOP:"NO", PHX:"PHO" };
        const _injuryOffRtgAdj = (team, injuryMap, usageMap, shortMap) => {
          const players = injuryMap.get(team) || injuryMap.get(shortMap?.[team]) || [];
          let share = 0;
          for (const p of players) {
            if (p.status !== "out") continue;
            const usg = p.id ? usageMap[p.id]?.usg : null;
            if (usg != null && usg > 0) share += usg;
          }
          share = parseFloat(share.toFixed(1));
          const adj = Math.max(_OFFRTG_INJ_CAP, 1 - share / 100 * _OFFRTG_INJ_FACTOR);
          return { share, adj: parseFloat(adj.toFixed(3)) };
        };
        const NBA_POS_MAP = {
          PG: "PG",
          "PG/SG": "PG",
          SG: "SG",
          "SG/PG": "SG",
          "SG/SF": "SG",
          SF: "SF",
          "SF/PF": "SF",
          "SF/SG": "SF",
          PF: "PF",
          "PF/SF": "PF",
          "G/F": "PF",
          C: "C",
          "C/PF": "C",
          "PF/C": "C"
          // "G" and "F" are omitted — ambiguous, fall through to roster-based position map
        };
        const playerColCache = {};
        for (const { playerName, sport, col } of loopMarkets) {
          const cacheKey = `${sport}|${playerName}|${col}`;
          if (playerColCache[cacheKey] !== void 0) continue;
          const gl = playerGamelogs[`${sport}|${playerName}`];
          if (!gl) {
            playerColCache[cacheKey] = null;
            continue;
          }
          const colIdx = gl.ul.indexOf(col);
          let getStat, allVals;
          if (colIdx === -1 && col === "TB" && sport === "mlb") {
            const hIdx = gl.ul.indexOf("H"), dIdx = gl.ul.indexOf("2B"), tIdx = gl.ul.indexOf("3B"), hrIdx = gl.ul.indexOf("HR");
            if (hIdx === -1 || dIdx === -1 || tIdx === -1 || hrIdx === -1) {
              playerColCache[cacheKey] = null;
              continue;
            }
            getStat = /* @__PURE__ */ __name((ev) => (parseFloat(ev.stats[hIdx]) || 0) + (parseFloat(ev.stats[dIdx]) || 0) + 2 * (parseFloat(ev.stats[tIdx]) || 0) + 3 * (parseFloat(ev.stats[hrIdx]) || 0), "getStat");
          } else if (colIdx === -1 && col === "HRR" && sport === "mlb") {
            const hIdx = gl.ul.indexOf("H"), rIdx = gl.ul.indexOf("R"), rbiIdx = gl.ul.indexOf("RBI");
            if (hIdx === -1 || rIdx === -1 || rbiIdx === -1) {
              playerColCache[cacheKey] = null;
              continue;
            }
            getStat = /* @__PURE__ */ __name((ev) => (parseFloat(ev.stats[hIdx]) || 0) + (parseFloat(ev.stats[rIdx]) || 0) + (parseFloat(ev.stats[rbiIdx]) || 0), "getStat");
          } else if (colIdx === -1) {
            playerColCache[cacheKey] = null;
            continue;
          } else {
            getStat = /* @__PURE__ */ __name((ev) => parseFloat(ev.stats[colIdx]), "getStat");
          }
          // Pitcher K props: filter gamelog to actual starts (IP ≥ 3 AND TBF ≥ 12).
          // ESPN gamelog returns all appearances; mixing relief stints in tanks per-threshold
          // hit rate. Applies once at cache build so all downstream uses (seasonPct, vals25/26,
          // _bf26, soft-history fallbacks) operate on starter-only data.
          let _evtPool = gl.events;
          if (sport === "mlb" && col === "K") {
            const _ipI = gl.ul.indexOf("IP"), _tbfI = gl.ul.indexOf("TBF");
            if (_ipI !== -1 && _tbfI !== -1) {
              _evtPool = gl.events.filter((ev) => {
                const ip = parseFloat(ev.stats?.[_ipI] ?? "0") || 0;
                const tbf = parseInt(ev.stats?.[_tbfI] ?? "0") || 0;
                return ip >= 3.0 && tbf >= 12;
              });
            }
          }
          allVals = _evtPool.map(getStat).filter((v) => !isNaN(v));
          playerColCache[cacheKey] = { getStat, allVals, _evtPool };
        }
        const plays = [];
        const dropped = [];
        const nbaDropped = [];
        // Tomorrow's ISO date string for gameTime fallback lookup (Kalshi sometimes uses today's date
        // in event tickers for tomorrow's games, so we need to try tomorrow's key when today's misses).
        const _tomorrowISOStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        // Cache pitcher K-count distributions keyed by playerTeam so all thresholds for the same
        // pitcher share one simulation run — guarantees P(K>=4) >= P(K>=5) by construction.
        const pitcherKDistCache = {};
        // Cache NBA stat distributions keyed by playerId|stat so all thresholds share one sim run.
        const nbaPlayerDistCache = {};
        // Cache WNBA stat distributions — separate keyspace from NBA to avoid id collisions
        // (ESPN player IDs are global but treating them as separate keeps semantics clean).
        const wnbaPlayerDistCache = {};
        // Cache NHL stat distributions keyed by playerId|stat — same monotonicity guarantee as NBA.
        const nhlPlayerDistCache = {};
        for (const { playerName, playerNameDisplay, sport, stat, col, threshold, kalshiPct, americanOdds, kalshiVolume, kalshiSpread, gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate, lineMove, thinMarket, marketConfidence } of loopMarkets) {
          const key = `${sport}|${playerName}`;
          const info = playerInfoMap[key];
          const gl = playerGamelogs[key];
          if (!info || !gl) {
            if (isDebug) dropped.push({ playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, reason: !info ? "no_espn_info" : "no_gamelog", gameTeam1, gameTeam2, kalshiPlayerTeam });
            continue;
          }
          const softData = STAT_SOFT[`${sport}|${stat}`];
          if (!softData) {
            if (isDebug) dropped.push({ playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, reason: "no_soft_data" });
            continue;
          }
          const { softTeams, rankMap } = softData;
          let playerTeam = kalshiPlayerTeam || info.teamAbbr;
          // For MLB strikeouts: validate team against ESPN probable pitcher name and correct if inverted
          if (sport === "mlb" && stat === "strikeouts" && playerTeam) {
            const probs = sportByteam.mlb?.probables || {};
            const probEntry = probs[playerTeam];
            if (probEntry && normName(probEntry.name || "") !== normName(playerName)) {
              const otherTeam = playerTeam === gameTeam1 ? gameTeam2 : (playerTeam === gameTeam2 ? gameTeam1 : null);
              if (otherTeam && probs[otherTeam] && normName(probs[otherTeam].name || "") === normName(playerName)) {
                playerTeam = otherTeam;
              } else if (info.teamAbbr && (info.teamAbbr === gameTeam1 || info.teamAbbr === gameTeam2)) {
                playerTeam = info.teamAbbr;
              }
            }
          }
          let tonightOpp = null;
          if (gameTeam1 && gameTeam2) {
            if (gameTeam1 === playerTeam) tonightOpp = gameTeam2;
            else if (gameTeam2 === playerTeam) tonightOpp = gameTeam1;
          }
          if (!tonightOpp) {
            if (isDebug) dropped.push({ playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, reason: "no_opp", playerTeam, gameTeam1, gameTeam2 });
            continue;
          }
          // For MLB strikeouts, the player IS the pitcher — name-based lookup is immune to all
          // doubleheader overwrite scenarios (same or different opponent; matchup keys can still
          // collide when both games are vs the same team). Falls back to matchup key, then team key.
          const _ps = sport === "mlb" && stat === "strikeouts"
            ? (sportByteam.mlb?.pitcherStatsByName?.[playerName] ?? null) : null;
          // _pt(map, field): try name-based (_ps.field) first, then team|opp key, then team key
          const _pt = (m, f) => (f != null && _ps?.[f] !== undefined ? _ps[f] : null) ?? (m?.[`${playerTeam}|${tonightOpp}`] ?? null) ?? m?.[playerTeam] ?? null;
          // MLB lineupConfirmed signal — stat-aware:
          //   - strikeouts (pitcher prop): opp team's batting lineup confirmed
          //   - hrr/hits (hitter prop): OWN team's lineup confirmed AND opp pitcher known
          //     (opp batting lineup is irrelevant — hitter faces the pitcher, not the batters)
          // null when not MLB (other sports use their own confirmation paths).
          // A team is "confirmed" only when it BOTH has lineup data posted (in lineupSpotByName)
          // AND that data isn't a projection. Checking only !projectedLineupTeams returns true
          // for teams with NO data at all (tomorrow's games, byteam:mlb hasn't pulled them) —
          // would stamp tomorrow's MLB plays as lineupConfirmed=true and bypass the dc penalty.
          const _mlbLineupConf = (() => {
            if (sport !== "mlb") return null;
            // Tomorrow's (or any future) game can't use today's lineup data — lineupSpotByName
            // is team-keyed, not date-scoped, so a team that played today + plays tomorrow would
            // inherit today's confirmation for tomorrow's card without this guard.
            if (gameDate && gameDate !== _todayPT) return false;
            const _proj = sportByteam.mlb?.projectedLineupTeams || [];
            const _spotMap = sportByteam.mlb?.lineupSpotByName || {};
            const _teamConfirmed = (t) => _spotMap[t] != null && !_proj.includes(t);
            if (stat === "strikeouts") return _teamConfirmed(tonightOpp);
            const _oppPitcherKnown = sportByteam.mlb?.probables?.[tonightOpp]?.name != null;
            return _teamConfirmed(playerTeam) && _oppPitcherKnown;
          })();
          // Base fields included on every drop in this loop
          const _dropBase = { playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, playerTeam };
          // Manual position overrides for known depth-chart misclassifications
          const NBA_POS_OVERRIDES = { "4871144": "C" }; // Alperen Sengun listed as PF in depth chart
          const nbaPos = sport === "nba" ? (NBA_POS_OVERRIDES[String(info.id)] || nbaDepthChartPos?.[String(info.id)] || (info.position ? NBA_POS_MAP[info.position] || null : null)) : null;
          const nbaDvpSoftTeams = sport === "nba" && nbaPos && allPositionsDvp?.[nbaPos]?.softTeams?.[stat] ? new Set(allPositionsDvp[nbaPos].softTeams[stat]) : null;
          const nbaEffectiveSoftTeams = nbaDvpSoftTeams || (sport === "nba" ? softTeams : null);
          if (sport === "nfl" && !softTeams.has(tonightOpp)) {
            if (isDebug) dropped.push({ ..._dropBase, reason: "opp_not_soft", opponent: tonightOpp });
            continue;
          }
          const colCached = playerColCache[`${sport}|${playerName}|${col}`];
          if (!colCached) {
            if (isDebug) dropped.push({ ..._dropBase, reason: "col_not_found", col, headers: gl.ul });
            continue;
          }
          const { getStat, allVals, _evtPool } = colCached;
          if (allVals.length === 0) {
            if (isDebug) dropped.push({ ..._dropBase, reason: "no_gamelog_vals" });
            continue;
          }
          const seasonPct = allVals.filter((v) => v >= threshold).length / allVals.length * 100;
          // _evtPool is pre-filtered to starts when this is a pitcher K cache (MLB + col="K");
          // for other props it's just gl.events. Use it for everything that needs season-tagged events.
          const _glEvents = _evtPool || gl.events;
          // L10 hit rate at this threshold — recent-form proxy. Universal across props
          // (uses the same `getStat` extractor as the season rate, so it always reflects the
          // current market's stat). Surfaced in the lambda input panel; not currently a model input.
          const _l10Vals = _glEvents.slice(0, 10).map(getStat).filter((v) => !isNaN(v) && v >= 0);
          const _l10HitRate = _l10Vals.length >= 5 ? Math.round(_l10Vals.filter((v) => v >= threshold).length / _l10Vals.length * 100) : null;
          const _l10Games = _l10Vals.length;
          const hasSeasonTags = sport === "mlb" && _glEvents.length > 0 && _glEvents[0].season !== void 0;
          const _tbfIdx = gl.ul.indexOf("TBF");
          const _ipIdx2 = gl.ul.indexOf("IP");
          const vals26 = hasSeasonTags ? _glEvents.filter((ev) => ev.season === 2026).map(getStat).filter((v) => !isNaN(v)) : [];
          const vals25 = hasSeasonTags ? _glEvents.filter((ev) => ev.season === 2025).map(getStat).filter((v) => !isNaN(v)) : [];
          // For pitchers, compute total batters faced in 2026 using TBF column, fallback to IP*3.3, fallback to game count*20
          const _events26 = hasSeasonTags ? _glEvents.filter((ev) => ev.season === 2026) : [];
          const _bf26 = sport === "mlb" && stat === "strikeouts"
            ? _tbfIdx !== -1
              ? _events26.reduce((s, ev) => s + (parseFloat(ev.stats[_tbfIdx]) || 0), 0)
              : _ipIdx2 !== -1
              ? _events26.reduce((s, ev) => { const ip = parseFloat(ev.stats[_ipIdx2]) || 0; return s + Math.floor(ip) * 3 + Math.round((ip % 1) * 10); }, 0)
              : vals26.length * 20
            : null;
          const _thresh26 = _bf26 !== null ? _bf26 >= 15 : vals26.length >= 3;
          // Compute pitcher ERA from game log (strikeouts only: player IS the pitcher)
          let _pitcherEraFromGl = null;
          if (sport === "mlb" && stat === "strikeouts" && _ipIdx2 !== -1) {
            const _erIdx = gl.ul.indexOf("ER");
            if (_erIdx !== -1) {
              const _calcEra = (evs) => {
                const tER = evs.reduce((s, ev) => s + (parseFloat(ev.stats[_erIdx]) || 0), 0);
                const tIP = evs.reduce((s, ev) => { const ip = parseFloat(ev.stats[_ipIdx2]) || 0; return s + Math.floor(ip) + (ip % 1) * 10 / 3; }, 0);
                return tIP >= 3 ? parseFloat((tER * 9 / tIP).toFixed(2)) : null;
              };
              _pitcherEraFromGl = _calcEra(_events26) ?? _calcEra(_glEvents);
            }
          }
          const pct26 = _thresh26 ? vals26.filter((v) => v >= threshold).length / vals26.length * 100 : null;
          const pct25 = vals25.length >= 5 ? vals25.filter((v) => v >= threshold).length / vals25.length * 100 : null;
          const blendVals = [...vals25, ...vals26];
          const blendedPct = blendVals.length >= 5 ? blendVals.filter((v) => v >= threshold).length / blendVals.length * 100 : null;
          // Prefer 2026 season rate; fall back to blended 25+26; fall back to all-career
          const primaryPct = pct26 ?? blendedPct ?? seasonPct;
          let simScore = null, kpctMeets = null, kpctPts = null, kbbMeets = null, kbbPts = null, lkpMeets = null, lkpPts = null, pitchesPts = null, parkMeets = null, mlPts = null, totalPts = null, kTrendPts = null, kHitRatePts = null, kH2HHandPts = null, _blendedHR = null;
          let _kH2HHandRate = null, _kH2HHandStarts = 0, _kH2HHandMaj = null;
          let _recentKPct = null, _seasonKPct = null;
          let _pitcherHand = null;
          let _avgP = null; // hoisted so all strikeout output sites can use it
          let _avgBF = null; // empirical avg batters faced per start — replaces _avgP / 3.85 when available
          let _umpireName = null;    // E3a: home plate umpire
          let _umpireKFactor = 1.0;  // factor relative to league avg (>1 = high-K zone)
          let _expectedBF = 24;      // E3b: expected batters faced from avg pitch count
          let _earlyExitProb = 0;    // blowout hook: P(pitcher pulled before BF 16) per trial
          let _stdBF = null;         // std dev of BF per start — widens trialPA distribution in MC (null = unknown, 0 = consistent arm)
          if (sport === "mlb" && stat === "strikeouts") {
            _pitcherHand = _pt(sportByteam.mlb?.pitcherHand, "hand");
            const _csw = _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct");
            // Gamelog fallback: if schedule-based lookup returns null (e.g. MLB schedule switched to
            // tomorrow and today's pitcher isn't in pitcherByTeam), compute from the player's own
            // ESPN gamelog — immune to schedule confusion since the gamelog IS the player's own data.
            _seasonKPct = _pt(sportByteam.mlb?.pitcherKPct, "kPct") ??
              (_bf26 != null && _bf26 >= 15 ? parseFloat((vals26.reduce((s, v) => s + v, 0) / _bf26 * 100).toFixed(1)) : null);
            // A1: Recent form — blend last 5 starts K% (0.6 weight) with season K% (0.4 weight).
            // Requires 3+ recent starts and 30+ BF to apply; falls back to season K% alone.
            // pitcherRecentKPct is a flat map {team: number}, not nested — use direct access
            const _recKey = `${playerTeam}|${tonightOpp}`;
            _recentKPct = sportByteam.mlb?.pitcherRecentKPct?.[_recKey] ?? sportByteam.mlb?.pitcherRecentKPct?.[playerTeam] ?? null;
            const _pkp = (_recentKPct != null && _seasonKPct != null)
              ? parseFloat((_recentKPct * 0.6 + _seasonKPct * 0.4).toFixed(1))
              : _seasonKPct;
            const _kbb = (() => {
              const v = _pt(sportByteam.mlb?.pitcherKBBPct, "kbbPct");
              if (v != null) return v;
              const _bbi = gl.ul.indexOf("BB");
              if (_bf26 == null || _bf26 < 15 || _bbi === -1) return null;
              const _evs26 = hasSeasonTags ? _glEvents.filter(ev => ev.season === 2026) : _glEvents;
              const _bb26 = _evs26.reduce((s, e) => s + (parseFloat(e.stats[_bbi]) || 0), 0);
              return parseFloat((vals26.reduce((s, v) => s + v, 0) / _bf26 * 100 - _bb26 / _bf26 * 100).toFixed(1));
            })();
            _avgP = (() => {
              // 1. Name-based (pitcherStatsByName — immune to schedule errors when pitcher is in probables)
              if (_ps?.avgPitches !== undefined) return _ps.avgPitches;
              // 2. ESPN gamelog starts-only (player-specific: uses this player's own gamelog data,
              //    immune to stale/wrong probables that might have another pitcher under the team key).
              //    IP >= 3 is a reliable proxy for starts (starters go 3+ IP; relievers rarely do).
              // ESPN MLB pitcher gamelog uses "P" for pitches; other contexts may use "PC". Try both.
              const _pci = gl.ul.indexOf("PC") !== -1 ? gl.ul.indexOf("PC") : gl.ul.indexOf("P");
              if (_pci !== -1) {
                const _ipIdx = gl.ul.indexOf("IP");
                // _glEvents is already start-filtered for pitcher K; the IP>=3 fallback is redundant but kept for safety.
                const _evs26 = hasSeasonTags ? _glEvents.filter(ev => ev.season === 2026) : _glEvents;
                const _startEvs = _ipIdx !== -1 ? _evs26.filter(e => parseFloat(e.stats[_ipIdx]) >= 3) : _evs26;
                const _pv = _startEvs.map(e => parseFloat(e.stats[_pci])).filter(v => !isNaN(v) && v > 0);
                if (_pv.length >= 1) return parseFloat((_pv.reduce((a, b) => a + b, 0) / _pv.length).toFixed(1));
              }
              // 3. Team key fallback — last resort; may return a different pitcher's value if the
              //    schedule has a stale/wrong probable for this team (e.g. cache built before starter confirmed).
              return _pt(sportByteam.mlb?.pitcherAvgPitches, "avgPitches");
            })();
            // E3a: Umpire K% adjustment — look up home plate ump for this game
            const _gameHome = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? null;
            const _umpKey = _gameHome
              ? (_gameHome === playerTeam ? `${playerTeam}|${tonightOpp}` : `${tonightOpp}|${playerTeam}`)
              : null;
            _umpireName = _umpKey ? (sportByteam.mlb?.umpireByGame?.[_umpKey] ?? null) : null;
            const _normUmpName = n => n ? n.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : n;
            _umpireKFactor = _umpireName ? (UMPIRE_KFACTOR[_normUmpName(_umpireName)] ?? 1.0) : 1.0;
            // E3b: Expected BF — use empirical avgBF when available; fall back to avgP / 3.85 league constant
            _avgBF = (() => {
              if (_ps?.avgBF !== undefined) return _ps.avgBF;
              return _pt(sportByteam.mlb?.pitcherAvgBF, "avgBF");
            })();
            _expectedBF = _avgBF != null
              ? Math.min(27, Math.max(15, Math.round(_avgBF)))
              : (_avgP != null ? Math.min(27, Math.max(15, Math.round(_avgP / 3.85))) : 24);
            // Pitch-limited start guard: when last start was <=70 pitches and the pitcher
            // has few 2026 starts, they're on a build-up (e.g., spot starter coming out of
            // bullpen). _avgBF blends 2026 with the 2025 anchor (80% weight at gs26<3), which
            // over-projects volume — cap _expectedBF to last-start pitch count converted to
            // BF (P / 3.85 league avg) + 3 BF cushion for moderate progression.
            const _lastPcCap = (() => {
              const lpc = _pt(sportByteam.mlb?.pitcherLastStartPC, "lastStartPC");
              const gs26 = _pt(sportByteam.mlb?.pitcherGS26, "gs26") ?? 0;
              if (lpc == null || lpc > 70 || gs26 >= 5) return null;
              return Math.round(lpc / 3.85 + 3);
            })();
            if (_lastPcCap != null && _lastPcCap < _expectedBF) {
              _expectedBF = Math.max(15, _lastPcCap);
            }
            const _lkpVR = sportByteam.mlb?.lineupKPctVR?.[tonightOpp] ?? null;
            const _lkpVL = sportByteam.mlb?.lineupKPctVL?.[tonightOpp] ?? null;
            const _lkpAll = sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null;
            const _lkp = _pitcherHand === "R" ? _lkpVR ?? _lkpAll : _pitcherHand === "L" ? _lkpVL ?? _lkpAll : _lkpAll;
            const _homeTeamK = sportByteam.mlb?.gameHomeTeams?.[playerTeam] || tonightOpp;
            const _parkKF = PARK_KFACTOR[_homeTeamK] ?? 1;
            // null = data unavailable (abstains); only known-true metrics contribute points
            // When gs26 < 4, skip raw CSW% (unreliable small sample) and use only regressed K%
            const _gs26 = _pt(sportByteam.mlb?.pitcherGS26, "gs26");
            // Re-check insufficient_starts gate here — pre-filter is bypassed in debug mode (?debug=1)
            const _hasAnchorMain = _pt(sportByteam.mlb?.pitcherHasAnchor, "hasAnchor");
            if (_hasAnchorMain !== true && (_gs26 ?? 0) < 8) {
              if (isDebug) dropped.push({ ..._dropBase, reason: "insufficient_starts", gs26: _gs26 ?? 0, hasAnchor: _hasAnchorMain });
              continue;
            }
            const _useCsw = _csw != null; // use CSW% whenever available; K% only when CSW% is null
            // CSW%/K% tiered (max 2pts): ≥30% CSW or >27% K → 2pts; 26-30% CSW or 24-27% K → 1pt; below → 0pts; null → 1pt abstain
            if (_useCsw) {
              kpctPts = _csw >= 30 ? 2 : _csw > 26 ? 1 : 0;
            } else if (_pkp != null) {
              kpctPts = _pkp > 27 ? 2 : _pkp > 24 ? 1 : 0;
            } else {
              kpctPts = 1; // null → abstain
            }
            kpctMeets = kpctPts > 0;
            // kbbPts tiered: >18% → 2pts, >12% → 1pt, ≤12% → 0pts; null → 1pt (abstain)
            kbbPts = _kbb == null ? 1 : _kbb > 18 ? 2 : _kbb > 12 ? 1 : 0;
            kbbMeets = kbbPts > 0;
            // lkpPts tiered (max 2pts): >24% → 2pts, >22% → 1pt, ≤22% → 0pts; null → 1pt (abstain)
            lkpPts = _lkp == null ? 1 : _lkp > 24 ? 2 : _lkp > 22 ? 1 : 0;
            lkpMeets = lkpPts > 0;
            // pitchesPts/kTrendPts still computed for output fields — no longer in simScore
            pitchesPts = _avgP == null ? 1 : _avgP > 85 ? 2 : _avgP > 75 ? 1 : 0;
            parkMeets = _parkKF > 1.0;
            const _teamML = sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null;
            mlPts = _teamML == null ? 1 : _teamML <= -121 ? 2 : _teamML <= 120 ? 1 : 0;
            // Blowout hook: heavy underdogs have elevated P(early hook) in MC trials.
            // +150→8%, +200→12%, +250+→18%. Null ML (no line yet) = no adjustment.
            _earlyExitProb = _teamML == null ? 0 : _teamML >= 250 ? 0.18 : _teamML >= 200 ? 0.12 : _teamML >= 150 ? 0.08 : 0;
            // stdBF: std dev of BF per start from gamelog — same priority chain as _avgBF.
            // Requires ≥3 NP≥30 starts in mlb.js; 0 when insufficient data.
            // `??` (not `||`) so a legitimately-computed 0 (consistent-BF arm) propagates instead of falling through.
            // Final fallback: league-average ~2.5 for rookies / early-season / post-trade starters where
            // we have skill data (kPct / CSW) + workload (avgBF) but not yet enough starts to compute
            // variance. 2.5 is the boundary where dc.js's highStdBF penalty triggers (>2.5), so it's
            // the most neutral value — no penalty, realistic sim variance. (Added 2026-05-19 — was
            // null-falling-through to dc -3 noStdBF for ~50% of K plays in early season.)
            _stdBF = _ps?.stdBF ?? _pt(sportByteam.mlb?.pitcherStdBF, "stdBF") ?? 2.5;
            // O/U total (low total = pitcher-friendly): ≤7.5 → 2pts, <10.5 → 1pt, ≥10.5 → 0pts; null → 1pt
            const _gameTotal = sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null;
            totalPts = _gameTotal == null ? 1 : _gameTotal <= 7.5 ? 2 : _gameTotal < 10.5 ? 1 : 0;
            // kTrendPts still computed for output/display — no longer in simScore
            const _kTrendRatio = (_recentKPct != null && _seasonKPct != null && _seasonKPct > 0)
              ? _recentKPct / _seasonKPct : null;
            kTrendPts = _kTrendRatio == null ? 1 : _kTrendRatio >= 1.10 ? 2 : _kTrendRatio >= 0.90 ? 1 : 0;
            // Hit Rate %: 2026 observed starts + 2025 implied (trust-weighted). ≥90%→2, ≥80%→1, <80%→0, null→1
            const _hitRate26 = vals26.length >= 3 ? vals26.filter(v => v >= threshold).length / vals26.length * 100 : null;
            const _hitRate25 = vals25.length >= 5 ? vals25.filter(v => v >= threshold).length / vals25.length * 100 : null;
            const _trust26 = Math.min(1.0, vals26.length / 15);
            _blendedHR = (_hitRate26 != null && _hitRate25 != null)
              ? _trust26 * _hitRate26 + (1 - _trust26) * _hitRate25
              : (_hitRate26 ?? _hitRate25);
            kHitRatePts = _blendedHR == null ? 1 : _blendedHR >= 90 ? 2 : _blendedHR >= 80 ? 1 : 0;
            // kH2HHandPts: pitcher K hit rate vs opponents whose lineup hand majority matches tonight's
            // Tonight's majority = full switch-hitter adjustment (S vs RHP → L, S vs LHP → R)
            const _bnByName = sportByteam.mlb?.batterHandByName || {};
            const _bnNorm = n => n ? n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() : "";
            const _staticHand = sportByteam.mlb?.staticTeamHandMajority || {};
            const _oppSpotMap = sportByteam.mlb?.lineupSpotByName?.[tonightOpp] ?? null;
            let _tonightOppHandMaj = null;
            if (_oppSpotMap) {
              let _rCnt = 0, _lCnt = 0;
              for (const bName of Object.keys(_oppSpotMap)) {
                const bHand = _bnByName[_bnNorm(bName)] ?? null;
                if (bHand === 'R' || (bHand === 'S' && _pitcherHand === 'L')) _rCnt++;
                else if (bHand === 'L' || (bHand === 'S' && _pitcherHand === 'R')) _lCnt++;
              }
              if (_rCnt + _lCnt > 0) _tonightOppHandMaj = _rCnt >= _lCnt ? 'R' : 'L';
            }
            if (!_tonightOppHandMaj) _tonightOppHandMaj = _staticHand[tonightOpp] ?? null;
            const _h2hPitcherStarts = (sportByteam.mlb?.pitcherH2HStarts || {})[playerTeam] ?? [];
            const _h2hHandStarts = _tonightOppHandMaj
              ? _h2hPitcherStarts.filter(s => s.oppAbbr && (_staticHand[s.oppAbbr] ?? null) === _tonightOppHandMaj)
              : _h2hPitcherStarts;
            const _h2hHandHitRate = _h2hHandStarts.length >= 5
              ? _h2hHandStarts.filter(s => s.strikeouts >= threshold).length / _h2hHandStarts.length * 100
              : null;
            kH2HHandPts = _h2hHandHitRate == null ? 1 : _h2hHandHitRate >= 80 ? 2 : _h2hHandHitRate >= 65 ? 1 : 0;
            // Store actual rate + start count for prose display (hoisted to outer scope)
            _kH2HHandRate = _h2hHandHitRate != null ? parseFloat(_h2hHandHitRate.toFixed(1)) : null;
            _kH2HHandStarts = _h2hHandStarts.length;
            _kH2HHandMaj = _tonightOppHandMaj;
            // SimScore (max 10): CSW%/K%→0-2, lineup K%→0-2, hit rate→0-2, H2H hand→0-2, O/U→0-2
            simScore = kpctPts + lkpPts + kHitRatePts + kH2HHandPts + totalPts;
          }
          let softVals, softLabel, softUnit, _hrrUsingTeamFallback = false;
          if (sport === "mlb" && stat === "strikeouts") {
            const allLineupKPctAll = sportByteam.mlb?.lineupKPct || {};
            const allLineupKPctVR = sportByteam.mlb?.lineupKPctVR || {};
            const allLineupKPctVL = sportByteam.mlb?.lineupKPctVL || {};
            // Use hand-adjusted K rates for bucketing (fall back to overall if missing)
            const handLineupKPct = _pitcherHand === "R"
              ? Object.fromEntries(Object.keys(allLineupKPctAll).map(t => [t, allLineupKPctVR[t] ?? allLineupKPctAll[t]]))
              : _pitcherHand === "L"
              ? Object.fromEntries(Object.keys(allLineupKPctAll).map(t => [t, allLineupKPctVL[t] ?? allLineupKPctAll[t]]))
              : allLineupKPctAll;
            const tonightLkp = handLineupKPct[tonightOpp] ?? null;
            // Bucket tonight's opponent K rate: low (<20%), avg (20–24%), high (>=24%)
            const lkpBucket = tonightLkp == null ? null : tonightLkp >= 24 ? "high" : tonightLkp >= 20 ? "avg" : "low";
            const similarKAbbrs = new Set(
              Object.entries(handLineupKPct)
                .filter(([, k]) => lkpBucket === "high" ? k >= 24 : lkpBucket === "avg" ? (k >= 20 && k < 24) : lkpBucket === "low" ? k < 20 : true)
                .map(([a]) => a)
            );
            const _kFilter = (ev) => similarKAbbrs.size > 0 ? similarKAbbrs.has(ev.oppAbbr) : true;
            // Use _glEvents (start-filtered) for pitcher K — relief outings would skew the soft-bucket hit rate.
            const _kVals26 = hasSeasonTags ? _glEvents.filter((ev) => ev.season === 2026 && _kFilter(ev)).map(getStat).filter((v) => !isNaN(v)) : [];
            const _kVals25 = hasSeasonTags ? _glEvents.filter((ev) => ev.season === 2025 && _kFilter(ev)).map(getStat).filter((v) => !isNaN(v)) : [];
            // Compute BF for filtered 2026 events; prefer 2026 if 15+ BF, else add 2025
            const _kBF26 = _tbfIdx !== -1
              ? _glEvents.filter((ev) => ev.season === 2026 && _kFilter(ev)).reduce((s, ev) => s + (parseFloat(ev.stats[_tbfIdx]) || 0), 0)
              : _ipIdx2 !== -1
              ? _glEvents.filter((ev) => ev.season === 2026 && _kFilter(ev)).reduce((s, ev) => { const ip = parseFloat(ev.stats[_ipIdx2]) || 0; return s + Math.floor(ip) * 3 + Math.round((ip % 1) * 10); }, 0)
              : _kVals26.length * 20;
            const _kValsAll = _glEvents.filter(_kFilter).map(getStat).filter((v) => !isNaN(v));
            const _kVals2526 = [..._kVals25, ..._kVals26];
            // allVals = all career starts (pre-computed in playerColCache); use as final fallback
            softVals = (_kBF26 >= 15 && _kVals26.length >= 3) ? _kVals26 : _kVals2526.length >= 3 ? _kVals2526 : _kValsAll.length >= 3 ? _kValsAll : allVals;
            const _handSuffix = _pitcherHand === "R" ? " vs RHP" : _pitcherHand === "L" ? " vs LHP" : "";
            softLabel = lkpBucket === "high" ? `high-K lineups${_handSuffix}` : lkpBucket === "avg" ? `avg-K lineups${_handSuffix}` : lkpBucket === "low" ? `low-K lineups${_handSuffix}` : "career";
            softUnit = "%";
          } else if (sport === "mlb") {
            const pitcherName = pitcherGamelogs[tonightOpp]?.name || null;
            const _pitcherGl = pitcherGamelogs[tonightOpp]?.gl || null;
            const _pitcherDates = _pitcherGl ? new Set(_pitcherGl.events.filter((ev) => ev.oppAbbr === playerTeam).map((ev) => ev.date)) : null;
            const _pitcherVals = (_pitcherDates && _pitcherDates.size > 0)
              ? gl.events.filter((ev) => _pitcherDates.has(ev.date) && ev.oppAbbr === tonightOpp).map(getStat).filter((v) => !isNaN(v))
              : [];
            if (_pitcherVals.length >= 10) {
              // Enough pitcher-specific H2H games (10+ ≈ 30+ PAs; signal is mature)
              softVals = _pitcherVals;
              softLabel = pitcherName ? `vs ${pitcherName}` : `vs ${tonightOpp}`;
            } else {
              // Sparse pitcher H2H (<12 games) → platoon-adjusted fallback (primary path for ~90% of matchups)
              // Flag set so HRR block overrides softPct with platoon-adjusted rate
              softVals = gl.events.filter((ev) => (ev.season === 2025 || ev.season === 2026) && ev.oppAbbr === tonightOpp).map(getStat).filter((v) => !isNaN(v));
              softLabel = `vs ${tonightOpp}`;
              _hrrUsingTeamFallback = true;
            }
            softUnit = "%";
          } else {
            let effectiveSoftSet;
            if (sport === "nba") {
              // DVP-tier matching: bucket opp's rank (1-10 soft / 11-20 neutral / 21-30 hard)
              // and collect all teams in the same tier, giving tier-appropriate context
              const _oppTierRank = rankMap[tonightOpp]?.rank ?? null;
              if (_oppTierRank != null) {
                const _oppTier = _oppTierRank <= 10 ? "soft" : _oppTierRank <= 20 ? "neutral" : "hard";
                effectiveSoftSet = new Set(Object.entries(rankMap)
                  .filter(([, v]) => _oppTier === "soft" ? v.rank <= 10 : _oppTier === "neutral" ? v.rank > 10 && v.rank <= 20 : v.rank > 20)
                  .map(([k]) => k));
              } else {
                effectiveSoftSet = nbaEffectiveSoftTeams || softTeams;
              }
            } else {
              effectiveSoftSet = softTeams;
            }
            softVals = gl.events.filter((ev) => effectiveSoftSet.has(ev.oppAbbr)).map(getStat).filter((v) => !isNaN(v));
            softLabel = null;
            softUnit = null;
          }
          const MIN_H2H = 10;
          // Hoist for both binomial softPct and BA gate below
          const abIdxH = (sport === "mlb" && stat !== "strikeouts") ? gl.ul.indexOf("AB") : -1;
          const blendEventsH = (sport === "mlb" && hasSeasonTags)
            ? gl.events.filter((ev) => ev.season === 2025 || ev.season === 2026)
            : gl.events;
          // Per-game hit rate: % of career games vs tonight's pitcher (or team fallback) where threshold was hit
          // For strikeouts, allow 1+ game (thin samples still shown with "(Xg)" indicator)
          const minSoft = sport === "mlb" && stat === "strikeouts" ? 1 : MIN_H2H;
          let softPct = softVals.length >= minSoft ? softVals.filter((v) => v >= threshold).length / softVals.length * 100 : null;
          const lineupKPctOut = (() => {
            if (sport !== "mlb" || stat !== "strikeouts") return null;
            const vr = sportByteam.mlb?.lineupKPctVR?.[tonightOpp] ?? null;
            const vl = sportByteam.mlb?.lineupKPctVL?.[tonightOpp] ?? null;
            const all = sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null;
            return _pitcherHand === "R" ? vr ?? all : _pitcherHand === "L" ? vl ?? all : all;
          })();
          const lineupKPctProjected = sport === "mlb" && stat === "strikeouts" && lineupKPctOut !== null ? (sportByteam.mlb?.projectedLineupTeams || []).includes(tonightOpp) : false;
          const pitcherKPctOut = sport === "mlb" && stat === "strikeouts"
            ? (_pt(sportByteam.mlb?.pitcherKPct, "kPct") ?? (_bf26 != null && _bf26 >= 15 ? parseFloat((vals26.reduce((s, v) => s + v, 0) / _bf26 * 100).toFixed(1)) : null))
            : null;
          const pitcherKBBPctOut = sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherKBBPct, "kbbPct") : null;
          let log5AvgOut = null, expectedKsOut = null, parkFactorOut = null, log5PctOut = null, simPctOut = null;
          if (sport === "mlb" && stat === "strikeouts" && pitcherKPctOut !== null) {
            const homeTeam = sportByteam.mlb?.gameHomeTeams?.[playerTeam] || tonightOpp;
            parkFactorOut = PARK_KFACTOR[homeTeam] ?? 1;
            // Prefer ordered per-batter arrays (enables simulation); fall back to unordered
            const ordAll = sportByteam.mlb?.lineupBatterKPctsOrdered?.[tonightOpp] ?? null;
            const ordVR = sportByteam.mlb?.lineupBatterKPctsVROrdered?.[tonightOpp] ?? null;
            const ordVL = sportByteam.mlb?.lineupBatterKPctsVLOrdered?.[tonightOpp] ?? null;
            // When per-batter data is unavailable (lineup not confirmed), synthesize a 9-batter uniform
            // lineup from the hand-adjusted team K% — lets the simulation run and cache the distribution.
            const _lkpForSynth = _pitcherHand === "R" ? (sportByteam.mlb?.lineupKPctVR?.[tonightOpp] ?? sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null) : _pitcherHand === "L" ? (sportByteam.mlb?.lineupKPctVL?.[tonightOpp] ?? sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null) : (sportByteam.mlb?.lineupKPct?.[tonightOpp] ?? null);
            const _synthOrd = _lkpForSynth != null ? Array(9).fill(_lkpForSynth / 100) : null;
            const orderedKPcts = (_pitcherHand === "R" ? (ordVR ?? ordAll) : _pitcherHand === "L" ? (ordVL ?? ordAll) : ordAll) ?? _synthOrd;
            const batterKPcts = orderedKPcts ?? (sportByteam.mlb?.lineupBatterKPcts?.[tonightOpp] ?? []);
            if (batterKPcts.length >= 3) {
              const scores = batterKPcts.map((b) => log5K(pitcherKPctOut, b * 100));
              log5AvgOut = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length * 100).toFixed(1));
              const adjustedLog5 = log5AvgOut * parkFactorOut;
              expectedKsOut = parseFloat((adjustedLog5 / 100 * 26).toFixed(1));
              if (orderedKPcts && orderedKPcts.length >= 8) {
                // Use cached distribution for this pitcher so all thresholds share the same sim run
                const _distKey = `${playerTeam}|${_pitcherHand ?? ""}`;
                if (!pitcherKDistCache[_distKey]) {
                  const _nSim = simScore !== null && simScore >= 8 ? 10000 : 5000;
                  // K H2H Hand factor: pitcher's K hit rate vs same-handed-majority lineups (≥5 starts).
                  // Neutral pivot 70 (rough threshold-neutral hit rate); clamp ±10% to keep this third-order
                  // signal from dominating ERA/FIP/WHIP. Replaces SimScore-only role.
                  const _kHandAdj = (_kH2HHandRate != null && _kH2HHandStarts >= 5)
                    ? Math.max(0.90, Math.min(1.10, _kH2HHandRate / 70))
                    : 1.0;
                  const _pitcherKPctAdj = Math.min(40, pitcherKPctOut * _umpireKFactor * _kHandAdj);
                  pitcherKDistCache[_distKey] = simulateKsDist(orderedKPcts, _pitcherKPctAdj, parkFactorOut, _nSim, _expectedBF, _earlyExitProb, _stdBF);
                }
                simPctOut = kDistPct(pitcherKDistCache[_distKey], threshold);
              } else {
                log5PctOut = parseFloat(log5HitRate(adjustedLog5, threshold).toFixed(1));
              }
            }
          }
          // simScore gate moved here so simPctOut is available for qualified:false push
          let recentAvgOut = null, dvpFactorOut = null, teamDefFactorOut = null, projectedStatOut = null;
          let posDvpRankOut = null, posDvpValueOut = null, posGroupOut = null, oppDvpRatioOut = null;
          if (sport === "nba" || sport === "nhl" || sport === "wnba") {
            const recentVals = gl.events.slice(0, 10).map(getStat).filter((v) => !isNaN(v));
            recentAvgOut = recentVals.length >= 5 ? parseFloat((recentVals.reduce((a, b) => a + b, 0) / recentVals.length).toFixed(2)) : null;
            if (recentAvgOut !== null && rankMap[tonightOpp]?.value != null) {
              const leagueAvg = leagueAvgCache[`${sport}|${stat}`] ?? null;
              if (leagueAvg) {
                dvpFactorOut = parseFloat((rankMap[tonightOpp].value / leagueAvg).toFixed(3));
                teamDefFactorOut = dvpFactorOut; // general team defense (not position-adjusted)
                const adjustedFactor = sport === "nhl" ? dvpFactorOut * 1.06 : dvpFactorOut;
                projectedStatOut = parseFloat((recentAvgOut * adjustedFactor).toFixed(2));
              }
            }
            // WNBA: aggregate stat-allowed DVP. Keep dvpRatio for SimScore (unitless), but do NOT
            // expose buildWnbaDvp's per-player avgPts as posDvpRank/posDvpValue — its unit (~12 ppg
            // per individual player) doesn't match the rankMap "PPG allowed" label (~88 team PPG)
            // that the UI displays. Letting oppRank/oppMetricValue fall through to rankMap keeps
            // the value and label consistent ("DAL has the 2nd-worst defense in points allowed —
            // giving up 88 per game"). No per-position split exists for WNBA so posGroup stays null.
            if (sport === "wnba" && wnbaDvpMap?.rankings?.[stat]) {
              const _wEntry = wnbaDvpMap.rankings[stat].find(t => t.abbr === tonightOpp);
              if (_wEntry) {
                oppDvpRatioOut = _wEntry.ratio ?? null;
                if (recentAvgOut !== null && oppDvpRatioOut !== null) {
                  projectedStatOut = parseFloat((recentAvgOut * oppDvpRatioOut).toFixed(2));
                }
              }
            }
            if (sport === "nba" && allPositionsDvp && nbaPos) {
              if (allPositionsDvp[nbaPos]?.rankings?.[stat]) {
                const ranked = allPositionsDvp[nbaPos].rankings[stat];
                const entry = ranked.find((t) => t.abbr === tonightOpp);
                if (entry) {
                  posGroupOut = nbaPos;
                  posDvpRankOut = entry.rank;
                  posDvpValueOut = parseFloat(entry.avgPts.toFixed(1));
                  oppDvpRatioOut = entry.ratio ?? null;
                  if (recentAvgOut !== null) {
                    const posVals = ranked.map((t) => t.avgPts).filter((v) => v > 0);
                    if (posVals.length >= 15) {
                      const posLeagueAvg = posVals.reduce((a, b) => a + b, 0) / posVals.length;
                      dvpFactorOut = parseFloat((entry.avgPts / posLeagueAvg).toFixed(3));
                      projectedStatOut = parseFloat((recentAvgOut * dvpFactorOut).toFixed(2));
                    }
                  }
                }
              }
            }
          }
          const isHomeGame = sport === "mlb" ? sportByteam.mlb?.gameHomeTeams?.[playerTeam] === playerTeam : sport === "nba" ? sportByteam.nba?.gameHomeTeams?.[playerTeam] === playerTeam : sport === "wnba" ? sportByteam.wnba?.gameHomeTeams?.[playerTeam] === playerTeam : null;
          const yesterday = /* @__PURE__ */ new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = yesterday.toISOString().slice(0, 10);
          const isB2B = (sport === "nba" || sport === "nhl" || sport === "wnba") && gl.events.length > 0 && (gl.events[0]?.date || "").startsWith(yesterdayStr);
          // Provisional truePct for MLB hitter debug drops (computed before gates so all drops can include it)
          let _hlSeasonPct = null, _hlSoftPct = null, _hlTruePct = null, _hlEdge = null;
          if (sport === "mlb" && stat !== "strikeouts" && hasSeasonTags) {
            _hlSeasonPct = parseFloat((primaryPct).toFixed(1));
            _hlSoftPct = softPct !== null ? parseFloat(softPct.toFixed(1)) : null;
            const _hlRaw = _hlSoftPct !== null ? (_hlSeasonPct + _hlSoftPct) / 2 : _hlSeasonPct;
            const _hlHomeTeam = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? tonightOpp;
            const _hlPf = PARK_HITFACTOR?.[_hlHomeTeam] ?? 1;
            _hlTruePct = parseFloat(Math.min(99, _hlRaw * _hlPf).toFixed(1));
            _hlEdge = parseFloat((_hlTruePct - kalshiPct).toFixed(1));
          }
          let hitterBa = null, hitterBaTier = null, hitterAbVsPitcher = 0;
          let hitterSimScore = null, hitterFinalSimScore = null, hitterSimPctOut = null;
          let hitterLineupSpot = null, hitterWhipMeets = null, hitterFipMeets = null, hitterParkMeets = null;
          let pitcherWHIP = null, pitcherFIP = null, pitcherBAA = null;
          let hitterParkKF = null, hitterMoneyline = null, hitterBarrelPct = null;
          let hitterBarrelPts = null, hitterTotalPts = null, hitterGameTotal = null, hitterPlatoonPts = null, hitterOppPitcherHand = null, hitterSplitBA = null, hitterWhipPts = null;
          let hitterOpsPts = null, hitterSeasonHitRatePts = null, hitterH2HHitRatePts = null;
          let hitterPlatoonRatio = null, hitterH2HSource = null;
          let _hitterOps = null; // hoisted — declared in HRR block, referenced in drops/plays outside
          if (sport === "mlb" && stat !== "strikeouts") {
            const hitterML = sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null;
            const hIdx2 = gl.ul.indexOf("H");
            // Compute season BA from blended '25+'26 events (reuse hoisted abIdxH / blendEventsH)
            if (abIdxH !== -1 && hIdx2 !== -1) {
              const totalAB = blendEventsH.reduce((s, ev) => s + (parseFloat(ev.stats[abIdxH]) || 0), 0);
              const totalH = blendEventsH.reduce((s, ev) => s + (parseFloat(ev.stats[hIdx2]) || 0), 0);
              if (totalAB >= 20) {
                hitterBa = parseFloat((totalH / totalAB).toFixed(3));
                hitterBaTier = hitterBa >= 0.300 ? "elite" : hitterBa >= 0.270 ? "good" : hitterBa >= 0.240 ? "avg" : "below";
              }
              const _hAbPitcherGl = pitcherGamelogs[tonightOpp]?.gl || null;
              const _hAbPitcherDates = _hAbPitcherGl ? new Set(_hAbPitcherGl.events.filter((ev) => ev.oppAbbr === playerTeam).map((ev) => ev.date)) : null;
              hitterAbVsPitcher = ((_hAbPitcherDates && _hAbPitcherDates.size > 0)
                ? gl.events.filter((ev) => _hAbPitcherDates.has(ev.date) && ev.oppAbbr === tonightOpp)
                : gl.events.filter((ev) => (ev.season === 2025 || ev.season === 2026) && ev.oppAbbr === tonightOpp)
              ).reduce((s, ev) => s + (parseFloat(ev.stats[abIdxH]) || 0), 0);
            }
            // Lineup spot via name-based lookup (MLB API lineup hydration includes fullName)
            const _spotMap = sportByteam.mlb?.lineupSpotByName?.[playerTeam] ?? null;
            const _brlNorm = n => n ? n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
            if (_spotMap) {
              hitterLineupSpot = _spotMap[_brlNorm(playerName)] ?? _spotMap[_brlNorm(playerNameDisplay)] ?? null;
            }
            // Barrel% from Baseball Savant (keyed by normalized "first last")
            const _brlMap = sportByteam.mlb?.barrelPctMap ?? null;
            if (_brlMap) {
              const _brl = _brlMap[_brlNorm(playerName)] ?? _brlMap[_brlNorm(playerNameDisplay)] ?? null;
              if (_brl != null) hitterBarrelPct = _brl;
            }
            // Pitcher WHIP, FIP, BAA from game log
            const _pgGl = pitcherGamelogs[tonightOpp]?.gl ?? null;
            if (_pgGl) {
              const _glH = _pgGl.ul.indexOf("H");
              const _glBB = _pgGl.ul.indexOf("BB");
              const _glIP = _pgGl.ul.indexOf("IP");
              const _glK = _pgGl.ul.indexOf("K");
              const _glHR = _pgGl.ul.indexOf("HR");
              const _glTBF = _pgGl.ul.indexOf("TBF");
              const _pgEvts = (() => {
                const blend = _pgGl.events.filter(ev => ev.season === 2025 || ev.season === 2026);
                return blend.length >= 3 ? blend : _pgGl.events;
              })();
              const _ipToDecimal = ip => Math.floor(ip) + (ip % 1) * 10 / 3;
              const totalIP = _glIP !== -1 ? _pgEvts.reduce((s, ev) => s + _ipToDecimal(parseFloat(ev.stats[_glIP]) || 0), 0) : 0;
              if (totalIP >= 5) {
                const _pgH = _glH !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glH]) || 0), 0) : 0;
                const _pgBB = _glBB !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glBB]) || 0), 0) : 0;
                const _pgK = _glK !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glK]) || 0), 0) : 0;
                const _pgHR = _glHR !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glHR]) || 0), 0) : 0;
                const _pgTBF = _glTBF !== -1 ? _pgEvts.reduce((s, ev) => s + (parseFloat(ev.stats[_glTBF]) || 0), 0) : totalIP * 4.33;
                pitcherWHIP = parseFloat(((_pgH + _pgBB) / totalIP).toFixed(2));
                if (_glK !== -1 && _glHR !== -1) pitcherFIP = parseFloat(((13 * _pgHR + 3 * _pgBB - 2 * _pgK) / totalIP + 3.2).toFixed(2));
                if (_pgTBF >= 10) pitcherBAA = parseFloat((_pgH / _pgTBF).toFixed(3));
              }
            }
            // Sim-Score components
            const _hlHomeTeam2 = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? tonightOpp;
            const _hlParkKF2 = PARK_HITFACTOR?.[_hlHomeTeam2] ?? 1;
            const _hlEra = sportByteam.mlb?.pitcherEra?.[tonightOpp] ?? sportByteam.mlb?.probables?.[tonightOpp]?.era ?? null;
            hitterWhipMeets = pitcherWHIP != null ? pitcherWHIP > 1.35 : null;
            // WHIP tiered (max 2pts): >1.35→2pts, >1.20→1pt, ≤1.20→0pts, null→1pt abstain
            hitterWhipPts = pitcherWHIP == null ? 1 : pitcherWHIP > 1.35 ? 2 : pitcherWHIP > 1.20 ? 1 : 0;
            hitterFipMeets = (pitcherFIP != null && _hlEra != null) ? pitcherFIP > _hlEra : null;
            hitterParkMeets = _hlParkKF2 > 1.0;
            hitterParkKF = _hlParkKF2;
            hitterMoneyline = hitterML;
            // B1: Platoon advantage — pitcher hand vs batter hand
            // Opposing pitcher hand (keyed by pitching team)
            const _oppPitcherHand = (sportByteam.mlb?.pitcherHand?.[`${tonightOpp}|${playerTeam}`] ?? sportByteam.mlb?.pitcherHand?.[tonightOpp]) || null;
            hitterOppPitcherHand = _oppPitcherHand;
            // Batter split BA from buildLineupKPct (vsR/vsL, needs 30+ AB)
            const _bsMap = sportByteam.mlb?.batterSplitBA || {};
            const _bsKey = _brlNorm(playerName);
            const _bsEntry = _bsMap[_bsKey] ?? _bsMap[_brlNorm(playerNameDisplay)] ?? null;
            const _splitBA = _oppPitcherHand === "R" ? (_bsEntry?.vsR ?? null) : _oppPitcherHand === "L" ? (_bsEntry?.vsL ?? null) : null;
            const _splitBAPA = _oppPitcherHand === "R" ? (_bsEntry?.vsRPA ?? 0) : _oppPitcherHand === "L" ? (_bsEntry?.vsLPA ?? 0) : 0;
            hitterSplitBA = _splitBA;
            // Platoon ratio kept for output/display only — not used in SimScore
            hitterPlatoonPts = 1; // abstain default
            hitterPlatoonRatio = null;
            if (_splitBA != null && hitterBa != null) {
              hitterPlatoonRatio = parseFloat((_splitBA / hitterBa).toFixed(3));
              hitterPlatoonPts = hitterPlatoonRatio >= 1.10 ? 2 : hitterPlatoonRatio >= 1.00 ? 1 : 0;
            }
            // B2: Batter recent form — last 10 2026 games rolling BA.
            let hitterEffectiveBA = hitterBa;
            if (abIdxH !== -1 && hIdx2 !== -1) {
              const _evs26_recent = hasSeasonTags ? gl.events.filter(ev => ev.season === 2026).slice(0, 10) : gl.events.slice(0, 10);
              const _recentAB = _evs26_recent.reduce((s, ev) => s + (parseFloat(ev.stats[abIdxH]) || 0), 0);
              const _recentH  = _evs26_recent.reduce((s, ev) => s + (parseFloat(ev.stats[hIdx2]) || 0), 0);
              if (_recentAB >= 20 && hitterBa != null) {
                const _recentBA = _recentH / _recentAB;
                hitterEffectiveBA = parseFloat((_recentBA * 0.3 + hitterBa * 0.7).toFixed(3));
              }
            }
            // Barrel% still computed for output/display (not SimScore)
            hitterBarrelPts = hitterBarrelPct == null ? 1 : hitterBarrelPct >= 14 ? 3 : hitterBarrelPct >= 10 ? 2 : hitterBarrelPct >= 7 ? 1 : 0;
            // O/U total tier: ≥9.5→2pts, ≥7.5→1pt, <7.5→0pts, null→1pt
            hitterGameTotal = sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null;
            hitterTotalPts = hitterGameTotal == null ? 1 : hitterGameTotal >= 9.5 ? 2 : hitterGameTotal >= 7.5 ? 1 : 0;
            // OPS (2026 season): ≥.850→2pts, ≥.720→1pt, <.720→0pts, null→1pt abstain
            const _opsMap = sportByteam.mlb?.hitterOpsMap || {};
            const _opsNorm = n => n ? n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() : "";
            _hitterOps = _opsMap[_opsNorm(playerName)] ?? _opsMap[_opsNorm(playerNameDisplay)] ?? null;
            hitterOpsPts = _hitterOps == null ? 1 : _hitterOps >= 0.850 ? 2 : _hitterOps >= 0.720 ? 1 : 0;
            // Blended season hit rate (2026 trust-weighted + 2025): ≥90%→2, ≥80%→1, <80%→0, null→1
            const _hrrHR26 = vals26.length >= 3 ? vals26.filter(v => v >= threshold).length / vals26.length * 100 : null;
            const _hrrHR25 = vals25.length >= 5 ? vals25.filter(v => v >= threshold).length / vals25.length * 100 : null;
            const _hrrTrust26 = Math.min(1.0, vals26.length / 30);
            const _hrrBlendedSeasonHR = (_hrrHR26 != null && _hrrHR25 != null)
              ? _hrrTrust26 * _hrrHR26 + (1 - _hrrTrust26) * _hrrHR25
              : (_hrrHR26 ?? _hrrHR25);
            hitterSeasonHitRatePts = _hrrBlendedSeasonHR == null ? 1 : _hrrBlendedSeasonHR >= 80 ? 2 : _hrrBlendedSeasonHR >= 70 ? 1 : 0;
            // H2H hit rate: ≥10 games vs specific pitcher → BvP; else cross-reference all loaded pitcher gamelogs by handedness
            const _h2hPitcherDates = pitcherGamelogs[tonightOpp]?.gl
              ? new Set(pitcherGamelogs[tonightOpp].gl.events.filter(ev => ev.oppAbbr === playerTeam).map(ev => ev.date))
              : null;
            const _h2hVals = (_h2hPitcherDates && _h2hPitcherDates.size > 0)
              ? gl.events.filter(ev => _h2hPitcherDates.has(ev.date) && ev.oppAbbr === tonightOpp).map(getStat).filter(v => !isNaN(v))
              : [];
            const _h2hHitRate = _h2hVals.length >= 10 ? _h2hVals.filter(v => v >= threshold).length / _h2hVals.length * 100 : null;
            // Handedness fallback: vsR/vsL HRR splits from MLB Stats API (Poisson approx: 1 - e^(-lambda))
            // Covers all 2025+2026 games vs same-hand pitchers — far broader than pitcherGamelogs cross-reference
            let _h2hHandRate = null;
            if (_h2hHitRate == null && _oppPitcherHand) {
              const _hrrSplitMap = sportByteam.mlb?.batterHRRSplits || {};
              const _hrrEntry = _hrrSplitMap[_bsKey] ?? _hrrSplitMap[_brlNorm(playerNameDisplay)] ?? null;
              const _hrrHandKey = _oppPitcherHand === "R" ? "vsR" : "vsL";
              const _hrrSplit = _hrrEntry?.[_hrrHandKey] ?? null;
              if (_hrrSplit && _hrrSplit.g >= 10) {
                const _lambda = _hrrSplit.hrr / _hrrSplit.g;
                _h2hHandRate = parseFloat(((1 - Math.exp(-_lambda)) * 100).toFixed(1));
                softPct = _h2hHandRate;
                softLabel = _oppPitcherHand === "R" ? "vs RHP" : "vs LHP";
              }
            }
            const _effectiveHitRate = _h2hHitRate ?? _h2hHandRate;
            hitterH2HHitRatePts = _effectiveHitRate == null ? 1
              : _effectiveHitRate >= 80 ? 2
              : _effectiveHitRate >= 70 ? 1
              : 0;
            hitterH2HSource = _h2hHitRate != null ? 'bvp' : _h2hHandRate != null ? 'hand' : 'abstain';
            // Refresh _hlSoftPct/_hlTruePct/_hlEdge with post-Poisson live softPct (was captured stale before this block)
            _hlSoftPct = softPct !== null ? parseFloat(softPct.toFixed(1)) : null;
            if (_hlSeasonPct !== null) {
              const _hlRawPost = _hlSoftPct !== null ? (_hlSeasonPct + _hlSoftPct) / 2 : _hlSeasonPct;
              const _hlHomePost = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? tonightOpp;
              const _hlPfPost = PARK_HITFACTOR?.[_hlHomePost] ?? 1;
              _hlTruePct = parseFloat(Math.min(99, _hlRawPost * _hlPfPost).toFixed(1));
              _hlEdge = parseFloat((_hlTruePct - kalshiPct).toFixed(1));
            }
            // SimScore (max 10): OPS→0-2, WHIP→0-2, season hit rate→0-2, H2H hit rate→0-2, O/U→0-2
            hitterSimScore = (hitterOpsPts ?? 1)
              + (hitterWhipPts ?? 0)
              + hitterSeasonHitRatePts
              + hitterH2HHitRatePts
              + hitterTotalPts;
            const _hlPitcherName = sportByteam.mlb?.probables?.[tonightOpp]?.name ?? null;
            const _hlML = hitterML;
            const _hlCommon = { opponent: tonightOpp, pitcherName: _hlPitcherName, seasonPct: _hlSeasonPct, softPct: _hlSoftPct, truePct: _hlTruePct, edge: _hlEdge, pitcherEra: _hlEra, moneyline: _hlML, hitterBa, hitterBaTier, abVsTeam: hitterAbVsPitcher, hitterLineupSpot, pitcherWHIP, pitcherFIP, hitterSimScore, hitterParkKF, hitterMoneyline, hitterBarrelPct, hitterBarrelPts, hitterTotalPts, hitterGameTotal, hitterPlatoonPts, hitterPlatoonRatio, hitterH2HSource, hitterSoftLabel: softLabel ?? void 0, hitterOps: _hitterOps, hitterOpsPts, hitterSeasonHitRatePts, hitterH2HHitRatePts, oppPitcherHand: _oppPitcherHand, hitterSplitBA: _splitBA, hitterWhipPts };
            // Stage 1: lineup spot 5-9 discard
            if (hitterLineupSpot !== null && hitterLineupSpot >= 6) {
              if (isDebug) dropped.push({ ..._dropBase, reason: "low_lineup_spot", hitterLineupSpot, ..._hlCommon });
              continue;
            }
            // Stage 2: sim-score gate
            if (hitterSimScore < 5) {
              if (isDebug) dropped.push({ ..._dropBase, reason: "low_confidence", hitterSimScore, ..._hlCommon });
              continue;
            }
            // Monte Carlo simulation for hits stat when effectiveBA and pitcherBAA available (B2 feeds this)
            if (stat === "hits" && hitterEffectiveBA != null && pitcherBAA != null) {
              const _nSimH = hitterSimScore >= 8 ? 10000 : 1000;
              hitterSimPctOut = simulateHits(hitterEffectiveBA, pitcherBAA, _hlParkKF2, threshold, _nSimH);
            }
          }
          // NBA: pre-edge SimScore + Monte Carlo simulation (runs before rawTruePct)
          let nbaSimPctOut = null, nbaPreSimScore = null, nbaPaceAdj = null, nbaPaceFactor = null, nbaOpportunity = null, nbaTotalPts = null, nbaGameTotal = null;
          let nbaBlowoutAdj = null, nbaSplitAdj = null, nbaMiscAdj = 1.0, nba3pMPG = null;
          if (sport === "nba") {
            let _sc = 0;
            // Pace: linear delta (nbaPaceAdj) retained for emit only — display field, no sim effect now.
            // nbaPaceFactor = geometric-mean ratio (matches NBA totals math). Captures pace's actual
            // ±10% possession swing on a typical season, vs the prior linear δ × 0.002 capped at ±3%.
            if (nbaPaceData) {
              const _tp = nbaPaceData.teamPace?.[playerTeam] ?? null;
              const _op = nbaPaceData.teamPace?.[tonightOpp] ?? null;
              const _lg = nbaPaceData.leagueAvgPace ?? null;
              if (_tp !== null && _op !== null) {
                nbaPaceAdj = parseFloat(((_tp + _op) / 2 - (_lg ?? 100)).toFixed(1));
                if (_lg && _lg > 0) {
                  nbaPaceFactor = parseFloat(((_tp * _op) / (_lg * _lg)).toFixed(3));
                }
              }
            }
            // AvgMin computed for display
            const _minIdx = gl.ul.indexOf("MIN");
            if (_minIdx !== -1) {
              const _minVals = gl.events.slice(0, 10).map(ev => parseFloat(ev.stats[_minIdx])).filter(v => !isNaN(v) && v > 0);
              if (_minVals.length >= 3) {
                nbaOpportunity = parseFloat((_minVals.reduce((a, b) => a + b, 0) / _minVals.length).toFixed(1));
              }
            }
            const _usgEntry = nbaUsageMap[String(info.id)] ?? null;
            const _usg = _usgEntry?.usg ?? null;
            const _avgAst = _usgEntry?.avgAst ?? null;
            const _avgReb = _usgEntry?.avgReb ?? null;
            // 1. C1: stat-appropriate opportunity signal (max 2pts, rescaled)
            // points/assists/threePointers: USG% ≥28→2, ≥22→1, else 0, null→1 abstain
            // rebounds: avgMin ≥30→2, ≥25→1, else 0, null→1 abstain
            if (stat === "threePointers") {
              const _3pIdx = gl.ul.indexOf("3P");
              if (_3pIdx !== -1) {
                const _3pVals = gl.events.slice(0, 10).map(ev => parseFloat(ev.stats[_3pIdx])).filter(v => !isNaN(v) && v >= 0);
                if (_3pVals.length >= 3) nba3pMPG = parseFloat((_3pVals.reduce((a, b) => a + b, 0) / _3pVals.length).toFixed(2));
              }
              _sc += _usg == null ? 1 : _usg >= 28 ? 2 : _usg >= 22 ? 1 : 0;
            } else if (stat === "rebounds") {
              _sc += nbaOpportunity == null ? 1 : nbaOpportunity >= 30 ? 2 : nbaOpportunity >= 25 ? 1 : 0;
            } else {
              _sc += _usg == null ? 1 : _usg >= 28 ? 2 : _usg >= 22 ? 1 : 0;
            }
            // 2. DVP — position-adjusted ratio tiers: ≥1.05→2pts, ≥1.02→1pt, else→0pts (unchanged)
            const _dvpPts = oppDvpRatioOut == null ? 0 : oppDvpRatioOut >= 1.05 ? 2 : oppDvpRatioOut >= 1.02 ? 1 : 0;
            _sc += _dvpPts;
            // 3. Season hit rate (primaryPct = blended 2026/2025/career): ≥90%→2, ≥80%→1, <80%→0
            const _nbaSeasonHRPts = primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0;
            _sc += _nbaSeasonHRPts;
            // 4. DVP-tier hit rate (vs teams in same DVP tier as tonight's opp): ≥90%→2, ≥80%→1, <80%→0, null→1 abstain
            const _nbaSoftHRPts = softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0;
            _sc += _nbaSoftHRPts;
            // 5. O/U line: ≥215 → 2pts; null → 1pt abstain; <215 → 0pts
            nbaGameTotal = (sportByteam.nbaGameOdds ?? {})[playerTeam]?.total ?? null;
            nbaTotalPts = nbaGameTotal === null ? 1 : nbaGameTotal >= 215 ? 2 : 0;
            _sc += nbaTotalPts;
            nbaPreSimScore = _sc;
            // C3: Blowout risk — downward adj when spread implies likely blowout (|spread|>10)
            const _nbaSpread = (sportByteam.nbaGameOdds ?? {})[playerTeam]?.spread ?? null;
            if (_nbaSpread != null) {
              const _absSpread = Math.abs(_nbaSpread);
              nbaBlowoutAdj = _absSpread > 10 ? Math.max(0.85, 1 - (_absSpread - 10) * 0.007) : 1.0;
            }
            // C4: Home/away splits — blend location-specific avg with overall avg (0.7/0.3)
            const _isHomeGame2 = sportByteam.nba?.gameHomeTeams?.[playerTeam] === playerTeam;
            const _nbaGameValsAll = gl.events.map(getStat).filter(v => !isNaN(v) && v >= 0);
            if (_nbaGameValsAll.length >= 10) {
              const _locVals = gl.events.filter(ev => (ev.isHome === _isHomeGame2)).map(getStat).filter(v => !isNaN(v) && v >= 0);
              if (_locVals.length >= 5) {
                const _overallMean = _nbaGameValsAll.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, _nbaGameValsAll.length);
                const _locMean = _locVals.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, _locVals.length);
                const _splitMean = _locMean * 0.7 + _overallMean * 0.3;
                nbaSplitAdj = _overallMean > 0 ? parseFloat((_splitMean / _overallMean).toFixed(3)) : null;
              }
            }
            // Combine miscAdj: C2 (injury boost) × C3 (blowout) × C4 (split)
            // C2: if teammates are out, apply boost (1.08 per out player, capped at 1.15)
            const _injuredTeammates = nbaInjuryMap.get(playerTeam) || [];
            const _injBoost = _injuredTeammates.length > 0 ? Math.min(1.15, 1 + _injuredTeammates.length * 0.08) : 1.0;
            nbaMiscAdj = _injBoost * (nbaBlowoutAdj ?? 1.0) * (nbaSplitAdj ?? 1.0);
            // Shared distribution per player+stat — all thresholds query the same run.
            // miscAdj key component ensures we don't reuse a stale dist if adjustments differ.
            const _nbaDistKey = `${info.id}|${stat}`;
            if (!nbaPlayerDistCache[_nbaDistKey]) {
              const _nSim = _sc >= 8 ? 10000 : _sc >= 5 ? 5000 : 2000;
              nbaPlayerDistCache[_nbaDistKey] = buildNbaStatDist(_nbaGameValsAll, teamDefFactorOut, null, isB2B, _nSim, nbaMiscAdj, nbaPaceFactor);
            }
            nbaSimPctOut = nbaDistPct(nbaPlayerDistCache[_nbaDistKey], threshold);
          }
          // WNBA: pre-edge SimScore + Monte Carlo sim. Mirrors NBA but with WNBA-tuned thresholds:
          //   USG ≥27/≥22 (vs 28/22); MIN ≥27/≥22 (vs 30/25, WNBA caps at 40min/game);
          //   game total ≥168/≥158 (vs 215, WNBA totals run 150–175).
          let wnbaSimPctOut = null, wnbaPreSimScore = null, wnbaPaceAdj = null, wnbaPaceFactor = null, wnbaOpportunity = null, wnbaTotalPts = null, wnbaGameTotal = null;
          let wnbaBlowoutAdj = null, wnbaSplitAdj = null, wnbaMiscAdj = 1.0, wnba3pMPG = null;
          if (sport === "wnba") {
            let _wsc = 0;
            if (wnbaPaceData) {
              const _wtp = wnbaPaceData.teamPace?.[playerTeam] ?? null;
              const _wop = wnbaPaceData.teamPace?.[tonightOpp] ?? null;
              const _wlg = wnbaPaceData.leagueAvgPace ?? null;
              if (_wtp !== null && _wop !== null) {
                wnbaPaceAdj = parseFloat(((_wtp + _wop) / 2 - (_wlg ?? 90)).toFixed(1));
                if (_wlg && _wlg > 0) {
                  wnbaPaceFactor = parseFloat(((_wtp * _wop) / (_wlg * _wlg)).toFixed(3));
                }
              }
            }
            const _wminIdx = gl.ul.indexOf("MIN");
            if (_wminIdx !== -1) {
              const _wminVals = gl.events.slice(0, 10).map(ev => parseFloat(ev.stats[_wminIdx])).filter(v => !isNaN(v) && v > 0);
              if (_wminVals.length >= 3) {
                wnbaOpportunity = parseFloat((_wminVals.reduce((a, b) => a + b, 0) / _wminVals.length).toFixed(1));
              }
            }
            const _wusgEntry = wnbaUsageMap[String(info.id)] ?? null;
            const _wusg = _wusgEntry?.usg ?? null;
            // 1. Stat-appropriate opportunity. USG tiers: ≥27/≥22 (NBA: 28/22 — WNBA shorter game compresses USG slightly).
            //    Rebounds use MIN tiers: ≥27/≥22 (NBA: 30/25 — 40-min game vs 48).
            if (stat === "threePointers") {
              const _w3pIdx = gl.ul.indexOf("3P");
              if (_w3pIdx !== -1) {
                const _w3pVals = gl.events.slice(0, 10).map(ev => parseFloat(ev.stats[_w3pIdx])).filter(v => !isNaN(v) && v >= 0);
                if (_w3pVals.length >= 3) wnba3pMPG = parseFloat((_w3pVals.reduce((a, b) => a + b, 0) / _w3pVals.length).toFixed(2));
              }
              _wsc += _wusg == null ? 1 : _wusg >= 27 ? 2 : _wusg >= 22 ? 1 : 0;
            } else if (stat === "rebounds") {
              _wsc += wnbaOpportunity == null ? 1 : wnbaOpportunity >= 27 ? 2 : wnbaOpportunity >= 22 ? 1 : 0;
            } else {
              _wsc += _wusg == null ? 1 : _wusg >= 27 ? 2 : _wusg >= 22 ? 1 : 0;
            }
            // 2. DVP ratio (single-tier, stat-allowed aggregate from buildWnbaDvp)
            const _wdvpPts = oppDvpRatioOut == null ? 0 : oppDvpRatioOut >= 1.05 ? 2 : oppDvpRatioOut >= 1.02 ? 1 : 0;
            _wsc += _wdvpPts;
            // 3. Season hit rate (primary = 2025-anchored blended): ≥90→2, ≥80→1
            const _wnbaSeasonHRPts = primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0;
            _wsc += _wnbaSeasonHRPts;
            // 4. Soft hit rate: ≥90→2, ≥80→1; null→1 abstain
            const _wnbaSoftHRPts = softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0;
            _wsc += _wnbaSoftHRPts;
            // 5. Game O/U: WNBA totals run 150–175 (NBA: 215–235). ≥168 → 2pts; ≥158 → 1pt; null→1 abstain
            wnbaGameTotal = (sportByteam.wnbaGameOdds ?? {})[playerTeam]?.total ?? null;
            wnbaTotalPts = wnbaGameTotal === null ? 1 : wnbaGameTotal >= 168 ? 2 : wnbaGameTotal >= 158 ? 1 : 0;
            _wsc += wnbaTotalPts;
            wnbaPreSimScore = _wsc;
            // Blowout / split / injury adjustments — same shape as NBA, identical multipliers
            const _wnbaSpread = (sportByteam.wnbaGameOdds ?? {})[playerTeam]?.spread ?? null;
            if (_wnbaSpread != null) {
              const _absSpreadW = Math.abs(_wnbaSpread);
              wnbaBlowoutAdj = _absSpreadW > 10 ? Math.max(0.85, 1 - (_absSpreadW - 10) * 0.007) : 1.0;
            }
            const _wisHomeGame = sportByteam.wnba?.gameHomeTeams?.[playerTeam] === playerTeam;
            const _wnbaGameValsAll = gl.events.map(getStat).filter(v => !isNaN(v) && v >= 0);
            if (_wnbaGameValsAll.length >= 10) {
              const _wlocVals = gl.events.filter(ev => (ev.isHome === _wisHomeGame)).map(getStat).filter(v => !isNaN(v) && v >= 0);
              if (_wlocVals.length >= 5) {
                const _woverallMean = _wnbaGameValsAll.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, _wnbaGameValsAll.length);
                const _wlocMean = _wlocVals.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, _wlocVals.length);
                const _wsplitMean = _wlocMean * 0.7 + _woverallMean * 0.3;
                wnbaSplitAdj = _woverallMean > 0 ? parseFloat((_wsplitMean / _woverallMean).toFixed(3)) : null;
              }
            }
            const _wInjured = wnbaInjuryMap.get(playerTeam) || [];
            const _wInjBoost = _wInjured.length > 0 ? Math.min(1.15, 1 + _wInjured.length * 0.08) : 1.0;
            wnbaMiscAdj = _wInjBoost * (wnbaBlowoutAdj ?? 1.0) * (wnbaSplitAdj ?? 1.0);
            const _wnbaDistKey = `${info.id}|${stat}`;
            if (!wnbaPlayerDistCache[_wnbaDistKey]) {
              const _wnSim = _wsc >= 8 ? 10000 : _wsc >= 5 ? 5000 : 2000;
              wnbaPlayerDistCache[_wnbaDistKey] = buildNbaStatDist(_wnbaGameValsAll, teamDefFactorOut, null, isB2B, _wnSim, wnbaMiscAdj, wnbaPaceFactor);
            }
            wnbaSimPctOut = nbaDistPct(wnbaPlayerDistCache[_wnbaDistKey], threshold);
          }
          // NHL: pre-edge SimScore + Monte Carlo simulation (same normal-distribution approach as NBA)
          let nhlSimPctOut = null, nhlPreSimScore = null, nhlShotsAdj = null, nhlOpportunity = null, nhlSaRank = null, nhlTeamGPG = null;
          let nhlGameTotal = null, nhlSeasonHitRatePts = null, nhlDvpHitRatePts = null, _gaaRank = null;
          if (sport === "nhl") {
            let _sc = 0;
            // SA rank still computed for display/output
            if (nhlLeagueAvgSa !== null && nhlSaRankMap[tonightOpp]?.value != null) {
              nhlShotsAdj = parseFloat((nhlSaRankMap[tonightOpp].value - nhlLeagueAvgSa).toFixed(1));
              nhlSaRank = nhlSaRankMap[tonightOpp]?.rank ?? null;
            }
            // 1. Ice time (TOI, max 2pts): ≥18 min → 2pts, ≥15 min → 1pt, else 0pts, null → 0pts
            const _toiIdx = gl.ul.findIndex(h => h === "TOI" || h === "TOI/G" || h === "timeOnIce");
            if (_toiIdx !== -1) {
              const _toiVals = gl.events.slice(0, 10).map(ev => {
                const s = ev.stats[_toiIdx];
                if (s == null) return NaN;
                const str = String(s);
                if (str.includes(':')) { const [m2, sec] = str.split(':'); return parseInt(m2, 10) + parseInt(sec, 10) / 60; }
                return parseFloat(str);
              }).filter(v => !isNaN(v) && v > 0);
              if (_toiVals.length >= 3) {
                nhlOpportunity = parseFloat((_toiVals.reduce((a, b) => a + b, 0) / _toiVals.length).toFixed(1));
                if (nhlOpportunity >= 18) _sc += 2;
                else if (nhlOpportunity >= 15) _sc += 1;
              }
            }
            // 2. Opponent GAA rank (max 2pts): ≤10→2, ≤15→1, else 0
            _gaaRank = rankMap[tonightOpp]?.rank ?? null;
            if (_gaaRank !== null) _sc += _gaaRank <= 10 ? 2 : _gaaRank <= 15 ? 1 : 0;
            // 3. Season hit rate (all career games): ≥90%→2, ≥80%→1, <80%→0
            nhlSeasonHitRatePts = seasonPct >= 90 ? 2 : seasonPct >= 80 ? 1 : 0;
            _sc += nhlSeasonHitRatePts;
            // 4. DVP hit rate (games vs teams with GAA > league avg): ≥90%→2, ≥80%→1, <80%→0, null→1 abstain
            const _nhlDvpVals = gl.events
              .filter(ev => { const gaa = nhlGAAMap[ev.oppAbbr] ?? null; return gaa !== null && gaa > (nhlLeagueAvgGAA ?? 0); })
              .map(getStat).filter(v => !isNaN(v) && v >= 0);
            const _nhlDvpHR = _nhlDvpVals.length >= 3 ? _nhlDvpVals.filter(v => v >= threshold).length / _nhlDvpVals.length * 100 : null;
            nhlDvpHitRatePts = _nhlDvpHR == null ? 1 : _nhlDvpHR >= 90 ? 2 : _nhlDvpHR >= 80 ? 1 : 0;
            _sc += nhlDvpHitRatePts;
            // 5. Game total (replaces B2B): ≥7→2, ≥5.5→1, <5.5→0, null→1 abstain
            nhlGameTotal = sportByteam.nhlGameOdds?.[playerTeam]?.total ?? sportByteam.nhlGameOdds?.[tonightOpp]?.total ?? null;
            const _nhlTotalPts = nhlGameTotal == null ? 1 : nhlGameTotal >= 7 ? 2 : nhlGameTotal >= 5.5 ? 1 : 0;
            _sc += _nhlTotalPts;
            // Team GPG still computed for output/display
            const _teamGPG = nhlGPGMap[playerTeam] ?? null;
            nhlTeamGPG = _teamGPG;
            nhlPreSimScore = _sc;
            // D3: TOI trend — compare recent 3 games TOI vs season avg (last 10).
            // If trending up (>5% more), boost mean; if trending down (>5% less), reduce.
            let nhlToiTrendAdj = 1.0;
            if (_toiIdx !== -1 && nhlOpportunity != null) {
              const _parseTOI = s => {
                if (s == null) return NaN;
                const str = String(s);
                if (str.includes(':')) { const [m2, sec] = str.split(':'); return parseInt(m2, 10) + parseInt(sec, 10) / 60; }
                return parseFloat(str);
              };
              const _recent3TOI = gl.events.slice(0, 3).map(ev => _parseTOI(ev.stats[_toiIdx])).filter(v => !isNaN(v) && v > 0);
              if (_recent3TOI.length >= 2) {
                const _recentAvgTOI = _recent3TOI.reduce((a, b) => a + b, 0) / _recent3TOI.length;
                const _toiRatio = _recentAvgTOI / nhlOpportunity;
                // +/- 5% band: above → boost up to +8%; below → cut up to -8%
                nhlToiTrendAdj = _toiRatio > 1.05 ? Math.min(1.08, _toiRatio) : _toiRatio < 0.95 ? Math.max(0.92, _toiRatio) : 1.0;
              }
            }
            // Shared distribution per player+stat — all thresholds query the same sim run
            const _nhlDistKey = `${info.id}|${stat}`;
            if (!nhlPlayerDistCache[_nhlDistKey]) {
              const _nhlGameVals = gl.events.map(getStat).filter(v => !isNaN(v) && v >= 0);
              const _nSim = _sc >= 8 ? 10000 : _sc >= 5 ? 5000 : 2000;
              nhlPlayerDistCache[_nhlDistKey] = buildNbaStatDist(_nhlGameVals, teamDefFactorOut, nhlShotsAdj, isB2B, _nSim, nhlToiTrendAdj);
            }
            nhlSimPctOut = nbaDistPct(nhlPlayerDistCache[_nhlDistKey], threshold);
          }
          const rawTruePct = (() => {
            if (sport === "mlb" && stat === "strikeouts") {
              // Simulation is the primary model when lineup data is available
              if (simPctOut !== null) return simPctOut;
              // Fallback: average of season rate + soft matchup rate
              const parts = [primaryPct, ...softPct !== null ? [softPct] : []];
              return parts.reduce((a, b) => a + b, 0) / parts.length;
            }
            if (sport === "mlb" && hasSeasonTags) {
              if (hitterSimPctOut !== null) return hitterSimPctOut;
              // PA-aware adjustment was shipped 2026-05-25 then immediately reverted: the
              // _nPAtypical = 4.0 baseline assumed each hitter's seasonPct was observed at 4.0
              // PA/game on average, but in reality a hitter who normally bats in spot 4 was
              // observed at ~4.31 PAs. Without per-hitter typical-spot history the adjustment
              // pushed predictions in the wrong direction (UP for all spots 1-5, when the audit
              // showed spot 4 was already over-predicted). Revisit when per-hitter typical PA
              // can be derived from gamelogs.
              const basePct = primaryPct;
              // BvP shrinkage (2026-05-16): small-sample BvP rates (e.g., 10/10 = 100%) were
              // dominating the 50/50 blend and inflating truePct (Bellinger vs Brazoban case:
              // truePct 90.9% vs market 74% = +16.9% edge). Bayesian-style shrinkage with N=20
              // "prior games" pulls extreme BvP rates toward the player's own season rate.
              // At softGames=20 the blend is 50/50 BvP/season-prior; at softGames=10, BvP gets
              // ~33% weight. Hand-source softPct skips shrinkage (handedness samples are large).
              const _bvpN = 20;
              const _isBvPSrc = hitterH2HSource === 'bvp' && softVals.length > 0 && softPct !== null;
              const _shrunkSoftPct = _isBvPSrc
                ? (softVals.length * softPct + _bvpN * primaryPct) / (softVals.length + _bvpN)
                : softPct;
              const rawMlbPct = _shrunkSoftPct !== null ? (basePct + _shrunkSoftPct) / 2 : basePct;
              const homeTeam = sportByteam.mlb?.gameHomeTeams?.[playerTeam] ?? tonightOpp;
              const parkFactor = PARK_HITFACTOR[homeTeam] ?? 1;
              // OPS adjustment: ratio to league-avg OPS shifts the logit. Top-quartile (~.850 OPS)
              // lifts truePct ~1.5–2pt; replaces OPS-as-SimScore-only with a real lambda input.
              const _LG_OPS = 0.720;
              const opsAdj = _hitterOps != null ? Math.max(0.85, Math.min(1.15, _hitterOps / _LG_OPS)) : 1.0;
              // WHIP adjustment: pitcher traffic factor (high WHIP = more contact = more HRR opportunities).
              // Lower weight (0.3) than OPS — already partially baked into primaryPct vs this pitcher.
              const _LG_WHIP_HRR = 1.30;
              const whipAdj = pitcherWHIP != null ? Math.max(0.92, Math.min(1.08, Math.pow(pitcherWHIP / _LG_WHIP_HRR, 0.5))) : 1.0;
              const _p = Math.max(0.01, Math.min(0.99, rawMlbPct / 100));
              const _logOddsAdj = Math.log(_p / (1 - _p)) + Math.log(parkFactor) + 0.4 * Math.log(opsAdj) + 0.3 * Math.log(whipAdj);
              return Math.min(99.9, parseFloat((100 / (1 + Math.exp(-_logOddsAdj))).toFixed(1)));
            }
            if (sport === "nba") {
              // Monte Carlo simulation is primary model; fall back to season/soft blend
              if (nbaSimPctOut !== null) return nbaSimPctOut;
              let base = softPct !== null ? (seasonPct + softPct) / 2 : seasonPct;
              if (isB2B) base = Math.max(0, base - 4);
              return base;
            }
            if (sport === "wnba") {
              if (wnbaSimPctOut !== null) return wnbaSimPctOut;
              let base = softPct !== null ? (seasonPct + softPct) / 2 : seasonPct;
              if (isB2B) base = Math.max(0, base - 4);
              return base;
            }
            if (sport === "nhl") {
              // Monte Carlo simulation is primary model; fall back to dvp-adjusted average
              if (nhlSimPctOut !== null) return nhlSimPctOut;
              if (dvpFactorOut !== null) {
                const dvpAdjustedPct = Math.min(99, seasonPct * dvpFactorOut);
                const _nhlParts = [seasonPct, dvpAdjustedPct, ...softPct !== null ? [softPct] : []];
                let result = _nhlParts.reduce((a, b) => a + b, 0) / _nhlParts.length;
                if (isB2B) result = Math.max(0, result - 4);
                return result;
              }
            }
            let base = softPct !== null ? (seasonPct + softPct) / 2 : seasonPct;
            if (isB2B) base = Math.max(0, base - 4);
            return base;
          })();
          let truePct = rawTruePct;
          // A2: Pitcher rest/fatigue — apply downward multiplier when pitcher is on short rest
          // or threw a high pitch count. Uses daysSinceLastStart + lastStartPC from mlb.js.
          // fatigueAdj ∈ [0.92, 1.0]: high-PC short-rest starts get ~0.92; normal rest = 1.0.
          if (sport === "mlb" && stat === "strikeouts") {
            const _lastDate = _pt(sportByteam.mlb?.pitcherLastStartDate, "lastStartDate");
            const _lastPC   = _pt(sportByteam.mlb?.pitcherLastStartPC,   "lastStartPC");
            if (_lastDate) {
              const _daysDiff = Math.round((Date.now() - new Date(_lastDate).getTime()) / 86400000);
              // Short rest = 3 or fewer days between starts (typical = 4-5 days)
              const _isShortRest = _daysDiff <= 3;
              // High pitch count last start = depleted arm (95+ pitches is taxing at short rest)
              const _highPC = _lastPC != null && _lastPC >= 95;
              if (_isShortRest && _highPC) {
                truePct = Math.max(0, truePct * 0.92);
              } else if (_isShortRest) {
                truePct = Math.max(0, truePct * 0.96);
              }
            }
          }
          const lowVolume = kalshiVolume < 50;
          const rawEdge = truePct - kalshiPct;
          const spreadAdj = kalshiSpread != null ? kalshiSpread / 2 : 0;
          // kalshiPct is already the fill price (yes_ask or blended orderbook); no additional
          // spread deduction needed — spreading the edge by half-spread double-penalizes.
          const edge = rawEdge;
          // finalSimScore = simScore (total/ML already baked in; edge gates separately)
          const finalSimScore = (sport === "mlb" && stat === "strikeouts" && simScore !== null)
            ? simScore
            : null;
          // HRR/hits: edge is a gate only (≥3% required), not part of simScore — max 14 like strikeouts
          hitterFinalSimScore = (sport === "mlb" && stat !== "strikeouts" && hitterSimScore !== null)
            ? hitterSimScore
            : null;
          // NBA SimScore — edge is a gate only (≥3% required), not part of simScore — max 14 like strikeouts
          let nbaSimScore = null;
          if (sport === "nba" && nbaPreSimScore !== null) {
            nbaSimScore = nbaPreSimScore;
          }
          let wnbaSimScore = null;
          if (sport === "wnba" && wnbaPreSimScore !== null) {
            wnbaSimScore = wnbaPreSimScore;
          }
          // NHL SimScore — edge is a gate only (not scored), same pattern as NBA/MLB
          let nhlSimScore = null;
          if (sport === "nhl" && nhlPreSimScore !== null) {
            nhlSimScore = nhlPreSimScore;
          }
          if (kalshiPct < KALSHI_GATE || kalshiPct > KALSHI_CAP || edge < EDGE_GATE) {
            const _dropObj = {
              ..._dropBase,
              truePct: parseFloat(truePct.toFixed(1)), rawTruePct: parseFloat(rawTruePct.toFixed(1)),
              edge: parseFloat(edge.toFixed(1)),
              reason: edge < EDGE_GATE ? "edge_too_low" : kalshiPct > KALSHI_CAP ? "kalshi_pct_too_high" : "kalshi_pct_too_low",
              opponent: tonightOpp, seasonPct: parseFloat((primaryPct).toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              l10HitRate: _l10HitRate, l10Games: _l10Games,
              oppRank: posDvpRankOut ?? rankMap[tonightOpp]?.rank ?? null,
              oppMetricValue: posDvpValueOut ?? rankMap[tonightOpp]?.value ?? null,
              oppMetricLabel: rankMap[tonightOpp]?.label || null,
              oppMetricUnit: rankMap[tonightOpp]?.unit ?? null,
              posDvpRank: posDvpRankOut, dvpRatio: oppDvpRatioOut, posGroup: posGroupOut,
              ...(sport === "mlb" && stat === "strikeouts" ? {
                simScore, finalSimScore,
                parkFactor: parkFactorOut,
                gameMoneyline: sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null,
                gameTotal: sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null,
                pitcherKPct: pitcherKPctOut,
                pitcherCSWPct: _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct"),
                pitcherKBBPct: _pt(sportByteam.mlb?.pitcherKBBPct, "kbbPct"),
                pitcherRecentKPct: _recentKPct, pitcherSeasonKPct: _seasonKPct,
                lineupKPct: lineupKPctOut, pitcherAvgPitches: _avgP,
                expectedBF: _expectedBF !== 24 ? _expectedBF : null,
                // stdBF is what feeds the dataConfidence noStdBF check — must travel with the play
                // on every emit path (qualifying + early-drop) or every dropped MLB-K pick lights up
                // -3 noStdBF for a value that actually exists.
                stdBF: _stdBF != null ? _stdBF : null,
                pitcherGS26: _pt(sportByteam.mlb?.pitcherGS26, "gs26"),
                pitcherHasAnchor: _pt(sportByteam.mlb?.pitcherHasAnchor, "hasAnchor"),
                kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts, kHitRatePts, kH2HHandPts, kH2HHandRate: _kH2HHandRate, kH2HHandStarts: _kH2HHandStarts, kH2HHandMaj: _kH2HHandMaj, blendedHitRate: _blendedHR != null ? parseFloat(_blendedHR.toFixed(1)) : null,
              } : {}),
              ...(sport === "mlb" && stat !== "strikeouts" ? {
                hitterSimScore, hitterFinalSimScore,
                hitterLineupSpot, pitcherWHIP, pitcherFIP, hitterParkKF, hitterMoneyline, hitterBarrelPct,
                hitterBarrelPts, hitterTotalPts, hitterGameTotal, hitterPlatoonPts,
                hitterPlatoonRatio: hitterPlatoonRatio ?? undefined,
                hitterH2HSource: hitterH2HSource ?? undefined,
                hitterOps: _hitterOps ?? undefined, hitterOpsPts, hitterSeasonHitRatePts, hitterH2HHitRatePts,
                hitterBa: hitterBa !== null ? hitterBa : undefined,
                hitterBaTier: hitterBaTier ?? undefined,
                hitterWhipPts, hitterSplitBA,
                oppPitcherHand: hitterOppPitcherHand ?? undefined,
                hitterSoftLabel: softLabel ?? undefined,
                softGames: softVals.length,
                hitterPitcherName: sportByteam.mlb?.probables?.[tonightOpp]?.name ?? sportByteam.mlb?.pitcherInfoByTeam?.[tonightOpp]?.name ?? pitcherGamelogs[tonightOpp]?.name ?? null,
                hitterPitcherEra: sportByteam.mlb?.pitcherEra?.[tonightOpp] ?? sportByteam.mlb?.probables?.[tonightOpp]?.era ?? null,
              } : {}),
              ...(sport === "nba" ? {
                nbaSimScore, nbaPreSimScore, nbaSimPct: nbaSimPctOut, nbaPaceAdj, nbaPaceFactor, nbaOpportunity, isB2B,
                nbaGameTotal, nbaTotalPts, nba3pMPG, nbaBlowoutAdj, nbaSplitAdj,
                nbaSeasonHitRatePts: primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0,
                nbaSoftHitRatePts: softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0,
                posDvpValue: posDvpValueOut,
                nbaUsage: nbaUsageMap[String(info.id)]?.usg ?? null,
                nbaAvgAst: nbaUsageMap[String(info.id)]?.avgAst ?? null,
                nbaAvgReb: nbaUsageMap[String(info.id)]?.avgReb ?? null,
                gameSpread: (sportByteam.nbaGameOdds ?? {})[playerTeam]?.spread ?? null,
                softGames: softVals.length,
              } : {}),
              ...(sport === "wnba" ? {
                wnbaSimScore, wnbaPreSimScore, wnbaSimPct: wnbaSimPctOut, wnbaPaceAdj, wnbaPaceFactor, wnbaOpportunity, isB2B,
                wnbaGameTotal, wnbaTotalPts, wnba3pMPG, wnbaBlowoutAdj, wnbaSplitAdj,
                wnbaSeasonHitRatePts: primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0,
                wnbaSoftHitRatePts: softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0,
                posDvpValue: posDvpValueOut, dvpRatio: oppDvpRatioOut,
                wnbaUsage: wnbaUsageMap[String(info.id)]?.usg ?? null,
                wnbaAvgAst: wnbaUsageMap[String(info.id)]?.avgAst ?? null,
                wnbaAvgReb: wnbaUsageMap[String(info.id)]?.avgReb ?? null,
                gameSpread: (sportByteam.wnbaGameOdds ?? {})[playerTeam]?.spread ?? null,
                softGames: softVals.length,
              } : {}),
              ...(sport === "nhl" ? { nhlSimScore, nhlPreSimScore, nhlSimPct: nhlSimPctOut, nhlShotsAdj, nhlOpportunity, nhlTeamGPG, nhlSaRank, gaaRank: _gaaRank, nhlGameTotal, nhlSeasonHitRatePts, nhlDvpHitRatePts, isB2B, softGames: softVals.length } : {}),
            };
            if (isDebug) dropped.push(_dropObj);
            // For all player prop sports: include in plays with qualified:false so player card
            // explanation renders even when the play fails edge or other gates.
            const _qualFalseBase = {
              ..._dropObj,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: _mlbLineupConf,
              playerStatus: null,
            };
            if (PROD_SPORTS.has(sport)) plays.push(_qualFalseBase);
            continue;
          }
          // Threshold sanity gate: reject plays where the threshold far exceeds expected Ks.
          // Even with good edge, a threshold 3+ above the model mean is a high-variance long shot.
          // Only applies when expectedKsOut is available (lineup confirmed); skipped when null.
          if (sport === "mlb" && stat === "strikeouts" && expectedKsOut != null && threshold > Math.ceil(expectedKsOut) + 2) {
            const _kTruePct = parseFloat((simPctOut ?? (softPct !== null ? (primaryPct + softPct) / 2 : primaryPct)).toFixed(1));
            const _dropThresh = {
              ..._dropBase,
              reason: "threshold_too_high",
              simScore, finalSimScore, expectedKs: expectedKsOut, threshold,
              opponent: tonightOpp,
              kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, lkpPts, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts, kHitRatePts, kH2HHandPts, kH2HHandRate: _kH2HHandRate, kH2HHandStarts: _kH2HHandStarts, kH2HHandMaj: _kH2HHandMaj, blendedHitRate: _blendedHR != null ? parseFloat(_blendedHR.toFixed(1)) : null,
              seasonPct: parseFloat(primaryPct.toFixed(1)), softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: _kTruePct, edge: parseFloat((_kTruePct - kalshiPct).toFixed(1)),
              pitcherKPct: pitcherKPctOut, pitcherAvgPitches: _avgP,
              expectedBF: _expectedBF !== 24 ? _expectedBF : null,
              pitcherHand: _pitcherHand ?? null, simPct: simPctOut,
            };
            if (isDebug) dropped.push(_dropThresh);
            plays.push({
              ..._dropThresh,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: _kTruePct,
              log5Pct: simPctOut ?? log5PctOut, simPct: simPctOut,
              spreadAdj: kalshiSpread != null ? parseFloat((kalshiSpread / 2).toFixed(1)) : 0,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: _mlbLineupConf,
              playerStatus: null,
            });
            continue;
          }
          // Strikeout finalSimScore gate: must reach >= 11 (Alpha tier) to qualify as a play.
          // Scores 7-10 show in report but marked qualified:false so player card still shows truePct.
          if (sport === "mlb" && stat === "strikeouts" && finalSimScore !== null && finalSimScore < SIMSCORE_GATE) {
            const _dropLowScore = {
              ..._dropBase,
              reason: "low_confidence",
              simScore, finalSimScore,
              opponent: tonightOpp,
              kpctMeets, kpctPts, kbbMeets, kbbPts, lkpMeets, lkpPts, pitchesPts, parkMeets, mlPts, totalPts, kTrendPts, kHitRatePts, kH2HHandPts, kH2HHandRate: _kH2HHandRate, kH2HHandStarts: _kH2HHandStarts, kH2HHandMaj: _kH2HHandMaj, blendedHitRate: _blendedHR != null ? parseFloat(_blendedHR.toFixed(1)) : null,
              seasonPct: parseFloat(primaryPct.toFixed(1)), softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              pitcherCSWPct: _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct"),
              pitcherKPct: pitcherKPctOut, pitcherKBBPct: pitcherKBBPctOut, pitcherRecentKPct: _recentKPct, pitcherSeasonKPct: _seasonKPct,
              pitcherAvgPitches: _avgP,
              expectedBF: _expectedBF !== 24 ? _expectedBF : null,
              // stdBF / pitcherGS26 / pitcherHasAnchor MUST travel even on the low_confidence drop
              // path — dataConfidence reads them and the absence triggers noStdBF -3 even though
              // the data is computed (see project_mlbk_dc_emit_bug memory; same divergence the
              // 2026-05-17 fix addressed for the qualified path but missed for this drop branch).
              stdBF: _stdBF != null ? _stdBF : null,
              pitcherGS26: sportByteam.mlb?.pitcherStatsByName?.[playerName]?.gs26 ?? sportByteam.mlb?.pitcherGS26?.[playerTeam] ?? null,
              pitcherHasAnchor: sportByteam.mlb?.pitcherStatsByName?.[playerName]?.hasAnchor ?? sportByteam.mlb?.pitcherHasAnchor?.[playerTeam] ?? null,
              lineupKPct: lineupKPctOut,
              pitcherEra: _pitcherEraFromGl ?? _pt(sportByteam.mlb?.pitcherEra, "era") ?? null,
              pitcherHand: _pitcherHand ?? null, simPct: simPctOut,
              parkFactor: parkFactorOut ?? 1,
              gameMoneyline: sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null,
              gameTotal: sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null,
            };
            if (isDebug) dropped.push(_dropLowScore);
            plays.push({
              ..._dropLowScore,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut, simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: _mlbLineupConf,
              playerStatus: null,
            });
            continue;
          }
          // NBA SimScore gate: must reach >= 11 (Alpha tier) to qualify as a play
          if (sport === "nba" && nbaSimScore !== null && nbaSimScore < SIMSCORE_GATE) {
            const _nbaLowScoreDrop = {
              ..._dropBase,
              reason: "low_confidence",
              nbaSimScore, nbaPreSimScore,
              opponent: tonightOpp,
              oppRank: posDvpRankOut ?? rankMap[tonightOpp]?.rank ?? null,
              oppMetricValue: posDvpValueOut ?? rankMap[tonightOpp]?.value ?? null,
              oppMetricLabel: rankMap[tonightOpp]?.label || null,
              oppMetricUnit: rankMap[tonightOpp]?.unit ?? null,
              seasonPct: parseFloat(primaryPct.toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              nbaSimPct: nbaSimPctOut, nbaPaceAdj, nbaPaceFactor, nbaOpportunity, isB2B,
              nbaGameTotal, nbaTotalPts, nba3pMPG, nbaBlowoutAdj, nbaSplitAdj,
              nbaSeasonHitRatePts: primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0,
              nbaSoftHitRatePts: softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0,
              posDvpRank: posDvpRankOut, posDvpValue: posDvpValueOut, dvpRatio: oppDvpRatioOut, posGroup: posGroupOut,
              nbaUsage: nbaUsageMap[String(info.id)]?.usg ?? null,
              nbaAvgAst: nbaUsageMap[String(info.id)]?.avgAst ?? null,
              nbaAvgReb: nbaUsageMap[String(info.id)]?.avgReb ?? null,
              softGames: softVals.length,
            };
            if (isDebug) dropped.push(_nbaLowScoreDrop);
            plays.push({
              ..._nbaLowScoreDrop,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              playerStatus: null,
            });
            continue;
          }
          // WNBA SimScore gate (≥SIMSCORE_GATE qualifies; lower → qualified:false for player card)
          if (sport === "wnba" && wnbaSimScore !== null && wnbaSimScore < SIMSCORE_GATE) {
            const _wnbaLowScoreDrop = {
              ..._dropBase,
              reason: "low_confidence",
              wnbaSimScore, wnbaPreSimScore,
              opponent: tonightOpp,
              oppRank: posDvpRankOut ?? rankMap[tonightOpp]?.rank ?? null,
              oppMetricValue: posDvpValueOut ?? rankMap[tonightOpp]?.value ?? null,
              oppMetricLabel: rankMap[tonightOpp]?.label || null,
              oppMetricUnit: rankMap[tonightOpp]?.unit ?? null,
              seasonPct: parseFloat(primaryPct.toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              wnbaSimPct: wnbaSimPctOut, wnbaPaceAdj, wnbaPaceFactor, wnbaOpportunity, isB2B,
              wnbaGameTotal, wnbaTotalPts, wnba3pMPG, wnbaBlowoutAdj, wnbaSplitAdj,
              wnbaSeasonHitRatePts: primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0,
              wnbaSoftHitRatePts: softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0,
              posDvpRank: posDvpRankOut, posDvpValue: posDvpValueOut, dvpRatio: oppDvpRatioOut,
              wnbaUsage: wnbaUsageMap[String(info.id)]?.usg ?? null,
              wnbaAvgAst: wnbaUsageMap[String(info.id)]?.avgAst ?? null,
              wnbaAvgReb: wnbaUsageMap[String(info.id)]?.avgReb ?? null,
              softGames: softVals.length,
            };
            if (isDebug) dropped.push(_wnbaLowScoreDrop);
            plays.push({
              ..._wnbaLowScoreDrop,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              playerStatus: null,
            });
            continue;
          }
          // NHL SimScore gate: must reach >= 11 (Alpha tier) to qualify as a play
          if (sport === "nhl" && nhlSimScore !== null && nhlSimScore < SIMSCORE_GATE) {
            const _nhlLowScoreDrop = {
              ..._dropBase,
              reason: "low_confidence",
              nhlSimScore, nhlPreSimScore,
              opponent: tonightOpp,
              oppRank: posDvpRankOut ?? rankMap[tonightOpp]?.rank ?? null,
              oppMetricValue: posDvpValueOut ?? rankMap[tonightOpp]?.value ?? null,
              oppMetricLabel: rankMap[tonightOpp]?.label || null,
              oppMetricUnit: rankMap[tonightOpp]?.unit ?? null,
              seasonPct: parseFloat(primaryPct.toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              nhlSimPct: nhlSimPctOut, nhlShotsAdj, nhlOpportunity, nhlTeamGPG, nhlSaRank, gaaRank: _gaaRank, isB2B,
              nhlGameTotal, nhlSeasonHitRatePts, nhlDvpHitRatePts,
              posDvpRank: posDvpRankOut, dvpRatio: oppDvpRatioOut, posGroup: posGroupOut,
              softGames: softVals.length,
            };
            if (isDebug) dropped.push(_nhlLowScoreDrop);
            plays.push({
              ..._nhlLowScoreDrop,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              playerStatus: null,
            });
            continue;
          }
          // HRR SimScore gate: must reach >= 11 (Alpha tier) to qualify as a play
          if (sport === "mlb" && stat !== "strikeouts" && hitterFinalSimScore !== null && hitterFinalSimScore < SIMSCORE_GATE) {
            const _hitterLowScoreDrop = {
              ..._dropBase,
              reason: "low_confidence",
              hitterSimScore, hitterFinalSimScore,
              opponent: tonightOpp,
              seasonPct: parseFloat(primaryPct.toFixed(1)),
              softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
              softGames: softVals.length,
              truePct: parseFloat(truePct.toFixed(1)), edge: parseFloat(edge.toFixed(1)),
              hitterLineupSpot, pitcherWHIP, pitcherFIP, hitterBarrelPct,
              hitterBarrelPts, hitterTotalPts, hitterGameTotal, hitterPlatoonPts,
              hitterPlatoonRatio: hitterPlatoonRatio ?? undefined,
              hitterH2HSource: hitterH2HSource ?? undefined,
              hitterOps: _hitterOps ?? undefined, hitterOpsPts, hitterSeasonHitRatePts, hitterH2HHitRatePts,
              hitterBa: hitterBa !== null ? hitterBa : undefined,
              hitterBaTier: hitterBaTier ?? undefined,
              hitterWhipPts, hitterSplitBA,
              oppPitcherHand: hitterOppPitcherHand ?? undefined,
              hitterSoftLabel: softLabel ?? undefined,
              hitterPitcherName: sportByteam.mlb?.probables?.[tonightOpp]?.name ?? sportByteam.mlb?.pitcherInfoByTeam?.[tonightOpp]?.name ?? pitcherGamelogs[tonightOpp]?.name ?? null,
              hitterPitcherEra: sportByteam.mlb?.pitcherEra?.[tonightOpp] ?? sportByteam.mlb?.probables?.[tonightOpp]?.era ?? null,
            };
            if (isDebug) dropped.push(_hitterLowScoreDrop);
            plays.push({
              ..._hitterLowScoreDrop,
              qualified: false,
              playerName: playerNameDisplay || playerName,
              playerId: info.id,
              sport, playerTeam, stat, threshold, kalshiPct, americanOdds,
              truePct: parseFloat(truePct.toFixed(1)),
              log5Pct: simPctOut ?? log5PctOut,
              simPct: simPctOut,
              spreadAdj,
              gameDate,
              gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
              lineupConfirmed: _mlbLineupConf,
              playerStatus: null,
            });
            continue;
          }
          const mlbH2H = sport === "mlb" && softPct !== null;
          plays.push({
            qualified: true,
            playerName: playerNameDisplay || playerName,
            playerId: info.id,
            sport,
            playerTeam,
            position: info.position || null,
            opponent: tonightOpp,
            oppRank: mlbH2H ? null : posDvpRankOut ?? rankMap[tonightOpp]?.rank ?? null,
            oppMetricValue: mlbH2H ? parseFloat(softPct.toFixed(1)) : posDvpValueOut ?? rankMap[tonightOpp]?.value ?? null,
            oppMetricLabel: mlbH2H ? `${softLabel} (${softVals.length}g)` : rankMap[tonightOpp]?.label || null,
            oppMetricUnit: mlbH2H ? "%" : rankMap[tonightOpp]?.unit ?? null,
            posGroup: posGroupOut,
            posDvpRank: posDvpRankOut,
            posDvpValue: posDvpValueOut,
            dvpRatio: oppDvpRatioOut,
            lineupKPct: lineupKPctOut,
            lineupKPctProjected,
            pitcherKPct: pitcherKPctOut,
            pitcherKBBPct: pitcherKBBPctOut,
            log5Avg: log5AvgOut,
            log5Pct: simPctOut ?? log5PctOut,
            expectedKs: expectedKsOut,
            simPct: simPctOut,
            stat,
            threshold,
            kalshiPct,
            americanOdds,
            seasonPct: parseFloat((primaryPct).toFixed(1)),
            seasonGames: allVals.length,
            blendGames: blendVals.length,
            l10HitRate: _l10HitRate,
            l10Games: _l10Games,
            pct25: pct25 !== null ? parseFloat(pct25.toFixed(1)) : null,
            pct25Games: vals25.length,
            pct26: pct26 !== null ? parseFloat(pct26.toFixed(1)) : null,
            pct26Games: vals26.length,
            softPct: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
            softGames: softVals.length,
            isHardMatchup: sport === "nba" && oppDvpRatioOut !== null ? oppDvpRatioOut <= 0.95 : false,
            simScore: sport === "mlb" && stat === "strikeouts" ? simScore : void 0,
            finalSimScore: sport === "mlb" && stat === "strikeouts" ? finalSimScore : void 0,
            kpctMeets: sport === "mlb" && stat === "strikeouts" ? kpctMeets : void 0,
            kbbMeets: sport === "mlb" && stat === "strikeouts" ? kbbMeets : void 0,
            lkpMeets: sport === "mlb" && stat === "strikeouts" ? lkpMeets : void 0,
            pitchesPts: sport === "mlb" && stat === "strikeouts" ? pitchesPts : void 0,
            parkMeets: sport === "mlb" && stat === "strikeouts" ? parkMeets : void 0,
            mlPts: sport === "mlb" && stat === "strikeouts" ? mlPts : void 0,
            totalPts: sport === "mlb" && stat === "strikeouts" ? totalPts : void 0,
            kpctPts: sport === "mlb" && stat === "strikeouts" ? kpctPts : void 0,
            lkpPts: sport === "mlb" && stat === "strikeouts" ? lkpPts : void 0,
            kTrendPts: sport === "mlb" && stat === "strikeouts" ? kTrendPts : void 0,
            kHitRatePts: sport === "mlb" && stat === "strikeouts" ? kHitRatePts : void 0,
            kH2HHandPts: sport === "mlb" && stat === "strikeouts" ? kH2HHandPts : void 0,
            kH2HHandRate: sport === "mlb" && stat === "strikeouts" ? _kH2HHandRate : void 0,
            kH2HHandStarts: sport === "mlb" && stat === "strikeouts" ? _kH2HHandStarts : void 0,
            kH2HHandMaj: sport === "mlb" && stat === "strikeouts" ? _kH2HHandMaj : void 0,
            blendedHitRate: sport === "mlb" && stat === "strikeouts" ? (_blendedHR != null ? parseFloat(_blendedHR.toFixed(1)) : null) : void 0,
            pitcherGS26: sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherGS26, "gs26") : void 0,
            pitcherHasAnchor: sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherHasAnchor, "hasAnchor") : void 0,
            hitterSimScore: sport === "mlb" && stat !== "strikeouts" ? hitterSimScore : void 0,
            hitterFinalSimScore: sport === "mlb" && stat !== "strikeouts" ? hitterFinalSimScore : void 0,
            hitterLineupSpot: sport === "mlb" && stat !== "strikeouts" ? hitterLineupSpot : void 0,
            hitterWhipMeets: sport === "mlb" && stat !== "strikeouts" ? hitterWhipMeets : void 0,
            hitterWhipPts: sport === "mlb" && stat !== "strikeouts" ? hitterWhipPts : void 0,
            hitterFipMeets: sport === "mlb" && stat !== "strikeouts" ? hitterFipMeets : void 0,
            hitterPlatoonPts: sport === "mlb" && stat !== "strikeouts" ? hitterPlatoonPts : void 0,
            hitterPlatoonRatio: sport === "mlb" && stat !== "strikeouts" ? (hitterPlatoonRatio ?? void 0) : void 0,
            hitterH2HSource: sport === "mlb" && stat !== "strikeouts" ? (hitterH2HSource ?? void 0) : void 0,
            hitterOps: sport === "mlb" && stat !== "strikeouts" ? (_hitterOps ?? void 0) : void 0,
            hitterOpsPts: sport === "mlb" && stat !== "strikeouts" ? hitterOpsPts : void 0,
            hitterSeasonHitRatePts: sport === "mlb" && stat !== "strikeouts" ? hitterSeasonHitRatePts : void 0,
            hitterH2HHitRatePts: sport === "mlb" && stat !== "strikeouts" ? hitterH2HHitRatePts : void 0,
            hitterSplitBA: sport === "mlb" && stat !== "strikeouts" ? hitterSplitBA : void 0,
            oppPitcherHand: sport === "mlb" && stat !== "strikeouts" ? hitterOppPitcherHand : void 0,
            hitterParkMeets: sport === "mlb" && stat !== "strikeouts" ? hitterParkMeets : void 0,
            pitcherWHIP: sport === "mlb" && stat !== "strikeouts" ? pitcherWHIP : void 0,
            pitcherFIP: sport === "mlb" && stat !== "strikeouts" ? pitcherFIP : void 0,
            hitterSimPct: sport === "mlb" && stat !== "strikeouts" ? hitterSimPctOut : void 0,
            hitterParkKF: sport === "mlb" && stat !== "strikeouts" ? hitterParkKF : void 0,
            hitterMoneyline: sport === "mlb" && stat !== "strikeouts" ? hitterMoneyline : void 0,
            hitterBarrelPct: sport === "mlb" && stat !== "strikeouts" ? hitterBarrelPct : void 0,
            hitterBarrelPts: sport === "mlb" && stat !== "strikeouts" ? hitterBarrelPts : void 0,
            hitterTotalPts: sport === "mlb" && stat !== "strikeouts" ? hitterTotalPts : void 0,
            hitterGameTotal: sport === "mlb" && stat !== "strikeouts" ? hitterGameTotal : void 0,
            pitcherAvgPitches: sport === "mlb" && stat === "strikeouts" ? _avgP : void 0,
            umpireName: sport === "mlb" && stat === "strikeouts" ? _umpireName : void 0,
            umpireKFactor: sport === "mlb" && stat === "strikeouts" && _umpireKFactor !== 1.0 ? _umpireKFactor : void 0,
            pitcherDaysRest: sport === "mlb" && stat === "strikeouts" ? (() => {
              const _lsd = _pt(sportByteam.mlb?.pitcherLastStartDate, "lastStartDate");
              return _lsd ? Math.round((Date.now() - new Date(_lsd).getTime()) / 86400000) : null;
            })() : void 0,
            expectedBF: sport === "mlb" && stat === "strikeouts" && _expectedBF !== 24 ? _expectedBF : void 0,
            earlyExitProb: sport === "mlb" && stat === "strikeouts" && _earlyExitProb > 0 ? _earlyExitProb : void 0,
            stdBF: sport === "mlb" && stat === "strikeouts" && _stdBF != null ? _stdBF : void 0,
            gameTotal: sport === "mlb" && stat === "strikeouts" ? sportByteam.mlb?.gameOdds?.[playerTeam]?.total ?? null : void 0,
            gameMoneyline: sport === "mlb" && stat === "strikeouts" ? sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null : void 0,
            pitcherCSWPct: sport === "mlb" && stat === "strikeouts" ? _pt(sportByteam.mlb?.pitcherCSWPct, "cswPct") : void 0,
            pitcherRecentKPct: sport === "mlb" && stat === "strikeouts" ? _recentKPct : void 0,
            pitcherSeasonKPct: sport === "mlb" && stat === "strikeouts" ? _seasonKPct : void 0,
            pitcherHand: sport === "mlb" && stat === "strikeouts" ? _pitcherHand ?? null : void 0,
            pitcherEra: sport === "mlb" && stat === "strikeouts" ? (_pitcherEraFromGl ?? _pt(sportByteam.mlb?.pitcherEra, "era") ?? null) : void 0,
            recentAvg: recentAvgOut,
            hitterBa: hitterBa !== null ? hitterBa : void 0,
            hitterBaTier: hitterBaTier ?? void 0,
            hitterAbVsPitcher: sport === "mlb" && stat !== "strikeouts" ? hitterAbVsPitcher : void 0,
            hitterPitcherName: sport === "mlb" && stat !== "strikeouts" ? (sportByteam.mlb?.probables?.[tonightOpp]?.name ?? sportByteam.mlb?.pitcherInfoByTeam?.[tonightOpp]?.name ?? pitcherGamelogs[tonightOpp]?.name ?? null) : void 0,
            hitterSoftLabel: sport === "mlb" && stat !== "strikeouts" ? softLabel : void 0,
            hitterPitcherEra: sport === "mlb" && stat !== "strikeouts" ? (sportByteam.mlb?.pitcherEra?.[tonightOpp] ?? sportByteam.mlb?.probables?.[tonightOpp]?.era ?? null) : void 0,
            nbaSimScore: sport === "nba" ? nbaSimScore : void 0,
            nbaPreSimScore: sport === "nba" ? nbaPreSimScore : void 0,
            nbaSimPct: sport === "nba" ? nbaSimPctOut : void 0,
            nbaPaceAdj: sport === "nba" ? nbaPaceAdj : void 0,
            nbaPaceFactor: sport === "nba" ? nbaPaceFactor : void 0,
            nbaOpportunity: sport === "nba" ? nbaOpportunity : void 0,
            nbaTotalPts: sport === "nba" ? nbaTotalPts : void 0,
            nbaSeasonHitRatePts: sport === "nba" ? (primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0) : void 0,
            nbaSoftHitRatePts: sport === "nba" ? (softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0) : void 0,
            nbaGameTotal: sport === "nba" ? nbaGameTotal : void 0,
            nbaUsage: sport === "nba" ? ((nbaUsageMap[String(info.id)]?.usg) ?? null) : void 0,
            nbaAvgAst: sport === "nba" ? ((nbaUsageMap[String(info.id)]?.avgAst) ?? null) : void 0,
            nbaAvgReb: sport === "nba" ? ((nbaUsageMap[String(info.id)]?.avgReb) ?? null) : void 0,
            nba3pMPG: sport === "nba" && stat === "threePointers" ? nba3pMPG : void 0,
            nbaBlowoutAdj: sport === "nba" ? nbaBlowoutAdj : void 0,
            nbaSplitAdj: sport === "nba" ? nbaSplitAdj : void 0,
            ...(sport === "nba" ? { gameSpread: (sportByteam.nbaGameOdds ?? {})[playerTeam]?.spread ?? null } : {}),
            wnbaSimScore: sport === "wnba" ? wnbaSimScore : void 0,
            wnbaPreSimScore: sport === "wnba" ? wnbaPreSimScore : void 0,
            wnbaSimPct: sport === "wnba" ? wnbaSimPctOut : void 0,
            wnbaPaceAdj: sport === "wnba" ? wnbaPaceAdj : void 0,
            wnbaPaceFactor: sport === "wnba" ? wnbaPaceFactor : void 0,
            wnbaOpportunity: sport === "wnba" ? wnbaOpportunity : void 0,
            wnbaTotalPts: sport === "wnba" ? wnbaTotalPts : void 0,
            wnbaSeasonHitRatePts: sport === "wnba" ? (primaryPct >= 90 ? 2 : primaryPct >= 80 ? 1 : 0) : void 0,
            wnbaSoftHitRatePts: sport === "wnba" ? (softPct == null ? 1 : softPct >= 90 ? 2 : softPct >= 80 ? 1 : 0) : void 0,
            wnbaGameTotal: sport === "wnba" ? wnbaGameTotal : void 0,
            wnbaUsage: sport === "wnba" ? ((wnbaUsageMap[String(info.id)]?.usg) ?? null) : void 0,
            wnbaAvgAst: sport === "wnba" ? ((wnbaUsageMap[String(info.id)]?.avgAst) ?? null) : void 0,
            wnbaAvgReb: sport === "wnba" ? ((wnbaUsageMap[String(info.id)]?.avgReb) ?? null) : void 0,
            wnba3pMPG: sport === "wnba" && stat === "threePointers" ? wnba3pMPG : void 0,
            wnbaBlowoutAdj: sport === "wnba" ? wnbaBlowoutAdj : void 0,
            wnbaSplitAdj: sport === "wnba" ? wnbaSplitAdj : void 0,
            ...(sport === "wnba" ? { gameSpread: (sportByteam.wnbaGameOdds ?? {})[playerTeam]?.spread ?? null } : {}),
            nhlSimScore: sport === "nhl" ? nhlSimScore : void 0,
            nhlPreSimScore: sport === "nhl" ? nhlPreSimScore : void 0,
            nhlSimPct: sport === "nhl" ? nhlSimPctOut : void 0,
            nhlShotsAdj: sport === "nhl" ? nhlShotsAdj : void 0,
            nhlSaRank: sport === "nhl" ? nhlSaRank : void 0,
            gaaRank: sport === "nhl" ? _gaaRank : void 0,
            nhlOpportunity: sport === "nhl" ? nhlOpportunity : void 0,
            nhlTeamGPG: sport === "nhl" ? nhlTeamGPG : void 0,
            nhlGameTotal: sport === "nhl" ? nhlGameTotal : void 0,
            nhlSeasonHitRatePts: sport === "nhl" ? nhlSeasonHitRatePts : void 0,
            nhlDvpHitRatePts: sport === "nhl" ? nhlDvpHitRatePts : void 0,
            isHomeGame,
            isB2B,
            dvpFactor: dvpFactorOut,
            projectedStat: projectedStatOut,
            parkFactor: parkFactorOut,
            truePct: parseFloat(truePct.toFixed(1)),
            rawTruePct: parseFloat(rawTruePct.toFixed(1)),

            kalshiVolume,
            kalshiSpread,
            lowVolume,
            rawEdge: parseFloat(rawEdge.toFixed(1)),
            spreadAdj: spreadAdj > 0 ? parseFloat(spreadAdj.toFixed(1)) : 0,
            edge: parseFloat(edge.toFixed(1)),
            historicalHitRate: softPct !== null ? parseFloat(softPct.toFixed(1)) : null,
            historicalGames: softVals.length,
            hitterMoneyline: sport === "mlb" && stat !== "strikeouts" ? sportByteam.mlb?.gameOdds?.[playerTeam]?.moneyline ?? null : void 0,
            gameDate,
            gameTime: gameTimes[`${sport}:${playerTeam}:${gameDate}`] ?? gameTimes[`${sport}:${playerTeam}:${_tomorrowISOStr}`] ?? gameTimes[`${sport}:${playerTeam}`] ?? null,
            lineupConfirmed: _mlbLineupConf,
            playerStatus: sport === "nba" ? (nbaPlayerStatus[String(info.id)] || null) : null,
            lineMove: lineMove ?? null,
            thinMarket: thinMarket ?? false,
            marketConfidence: marketConfidence ?? "thin"
          });
        }
        // Save all MLB strikeout plays before dedup so we can re-add non-winning thresholds as
        // qualified:false afterward — player card needs all thresholds in allTonightPlays.
        const _preDedupSkPlays = {};
        for (const play of plays) {
          if (play.sport === "mlb" && play.stat === "strikeouts") {
            const k = `${play.playerTeam}|${play.gameDate}`;
            (_preDedupSkPlays[k] = _preDedupSkPlays[k] || []).push(play);
          }
        }
        // WNBA-only: tighten qualified dedup to one play per player (across stats). The highest-edge
        // qualified play wins; the rest are demoted to qualified:false so allTonightPlays still has
        // them for the player card, but the homepage Plays card only shows the winner.
        const _wnbaBestByPlayer = {};
        for (const play of plays) {
          if (play.sport !== "wnba" || play.qualified === false) continue;
          const k = play.playerName;
          if (!_wnbaBestByPlayer[k] || play.edge > _wnbaBestByPlayer[k].edge) {
            _wnbaBestByPlayer[k] = play;
          }
        }
        for (const play of plays) {
          if (play.sport !== "wnba" || play.qualified === false) continue;
          if (_wnbaBestByPlayer[play.playerName] !== play) play.qualified = false;
        }
        const bestMap = {};
        for (const play of plays) {
          // qualified:false plays exist for the player card (all thresholds needed) — keep per-threshold.
          // qualified:true/null plays are deduped to one per player+stat for the plays card display.
          const key = play.qualified === false
            ? `${play.playerName}|${play.sport}|${play.stat}|${play.threshold}`
            : `${play.playerName}|${play.sport}|${play.stat}`;
          const prev = bestMap[key];
          // For deduped (qualified:true) plays, keep the highest edge — best market value.
          // For per-threshold (qualified:false) plays, there is no competing prev.
          const isBetter = !prev || play.edge > prev.edge;
          if (isBetter) bestMap[key] = play;
        }
        plays.splice(0, plays.length, ...Object.values(bestMap));
        plays.sort((a, b) => {
          const ta = a.gameTime || "9999";
          const tb = b.gameTime || "9999";
          return ta < tb ? -1 : ta > tb ? 1 : b.edge - a.edge;
        });
        // Filter out plays from old dates (Kalshi sometimes keeps settled markets open).
        // Use yesterday as cutoff (not today) to handle UTC/local timezone differences
        // for late games: a TEX game at 9:40pm ET = 1:40am UTC next day, so today() on the
        // server would be April 14 while the game date is still April 13.
        const cutoffStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        plays.splice(0, plays.length, ...plays.filter(p => !p.gameDate || p.gameDate >= cutoffStr));
        // Re-add non-winning MLB strikeout thresholds as qualified:false so allTonightPlays has all
        // thresholds and the player card can show distinct simulation-based truePct per threshold.
        {
          const _existingSkKeys = new Set(plays.filter(p => p.sport === "mlb" && p.stat === "strikeouts").map(p => `${p.playerTeam}|${p.gameDate}|${p.threshold}`));
          const _extraSkPlays = [];
          for (const p of plays) {
            if (p.sport !== "mlb" || p.stat !== "strikeouts" || p.qualified === false) continue;
            const k = `${p.playerTeam}|${p.gameDate}`;
            const _hand = sportByteam.mlb?.pitcherHand?.[`${p.playerTeam}|${p.opponent ?? ""}`] ?? sportByteam.mlb?.pitcherHand?.[p.playerTeam] ?? "";
            const _dist = pitcherKDistCache[`${p.playerTeam}|${_hand}`];
            for (const other of (_preDedupSkPlays[k] || [])) {
              if (_existingSkKeys.has(`${other.playerTeam}|${other.gameDate}|${other.threshold}`)) continue;
              const _truePct = _dist ? kDistPct(_dist, other.threshold) : other.truePct;
              _extraSkPlays.push({ ...other, qualified: false, truePct: _truePct ?? other.truePct, simPct: _truePct ?? other.simPct, edge: _truePct != null ? parseFloat((_truePct - other.kalshiPct).toFixed(1)) : other.edge });
              _existingSkKeys.add(`${other.playerTeam}|${other.gameDate}|${other.threshold}`);
            }
          }
          plays.push(..._extraSkPlays);
        }
        // Enforce monotonicity: for MLB strikeout props on the same pitcher, lower threshold must have >= truePct.
        // If the simulation distribution is still in the pitcherKDistCache, re-derive all thresholds from it
        // so each threshold gets a distinct, correct value (e.g. 3+≈99.5%, 4+≈99.0%, 5+=98.1%).
        // Without this, qualified:false plays at lower thresholds use the fallback formula, which can be
        // lower than the simulation truePct of a qualifying higher threshold.
        {
          const _skGroups = {};
          for (const p of plays) {
            if (p.sport === "mlb" && p.stat === "strikeouts") {
              const key = `${p.playerTeam}|${p.gameDate}`;
              (_skGroups[key] = _skGroups[key] || []).push(p);
            }
          }
          for (const group of Object.values(_skGroups)) {
            group.sort((a, b) => a.threshold - b.threshold);
            const _pTeam = group[0].playerTeam;
            const _hand = sportByteam.mlb?.pitcherHand?.[`${_pTeam}|${group[0]?.opponent ?? ""}`] ?? sportByteam.mlb?.pitcherHand?.[_pTeam] ?? "";
            const _dist = pitcherKDistCache[`${_pTeam}|${_hand}`];
            if (_dist) {
              // Re-derive all thresholds from the shared distribution — guarantees distinct monotonic values.
              for (const play of group) {
                const _recomp = kDistPct(_dist, play.threshold);
                if (_recomp != null) {
                  play.truePct = _recomp;
                  play.simPct = _recomp;
                  play.edge = parseFloat((_recomp - play.kalshiPct).toFixed(1));
                }
              }
            } else {
              // Fallback: copy-up sweep (lower threshold gets at least the value of the next higher)
              for (let i = group.length - 2; i >= 0; i--) {
                if (group[i].truePct < group[i + 1].truePct) {
                  group[i].truePct = group[i + 1].truePct;
                  group[i].rawTruePct = group[i + 1].rawTruePct;
                  group[i].edge = parseFloat((group[i].truePct - group[i].kalshiPct - (group[i].spreadAdj ?? 0)).toFixed(1));
                }
              }
            }
          }
        }
        // ── Game Total plays ─────────────────────────────────────────────────────────────────────
        // Schedule event parser (shared by game total H2H and team total H2H pre-fetches)
        const _parseSchedEvts = d => (d.events ?? [])
          .filter(ev => ev.competitions?.[0]?.status?.type?.completed)
          .map(ev => ({ date: ev.date || null, comps: (ev.competitions[0].competitors ?? []).map(c => ({ abbr: (c.team?.abbreviation ?? '').toUpperCase(), score: parseFloat(c.score?.value ?? c.score ?? 0) })) }));
        const totalDistCache = {};
        const totalPlays = [];
        // Captured during the MLB game-total loop body so the downstream MLB-ML emission can
        // reuse the per-game lambdas, simData (FIP/ERA/WHIP/bullpen sources), and gateable fields
        // without recomputing. Key: `${homeTeam}|${awayTeam}|${gameDate}`. Populated only when
        // _hLam and _aLam are both non-null — ML requires a valid joint distribution.
        const _mlbMlContext = {};
        // NBA analog. homeLambda/awayLambda are the Normal means (per-team expected points), not
        // Poisson rates. Captured from the NBA game-total loop body. simulateNBAJoint draws use
        // per-team std = 13 to match the existing NBA total sim variance (line ~3558).
        const _nbaMlContext = {};
        // WNBA analog. Same shape as _nbaMlContext but per-team std = 11 (matches WNBA total sim).
        const _wnbaMlContext = {};
        // NHL analog. homeLambda/awayLambda are Poisson goals (mirror MLB but lower magnitude).
        // simulateMLBJoint is reused with r=null so it falls back to Poisson sampling (NHL hasn't
        // been fit for NegBin dispersion yet; phase 2). MLB ML/spread pass _mlbDispR to opt in.
        const _nhlMlContext = {};
        // ── Regime-aware lambda helpers (shared by game-total + team-total blocks). Blends a
        // team's recency-weighted recent-score average into the rating-based expected.
        // Half-life 21 days. Replaces the fixed 4% NBA playoff boost — a team-specific
        // data-driven signal catches both playoff scoring shifts AND mid-season hot/cold
        // streaks without a manually-tuned multiplier. Sample-weighted: w caps at 50%.
        const _SEASON_HALF_LIFE_DAYS = 21;  // default for NBA/WNBA/NHL — see _recentTeamScoreMean
        const _MLB_HALF_LIFE_DAYS    = 14;  // MLB plays daily; faster turnover ⇒ shorter half-life
        const _gtRefMs = Date.now();
        const _recencyWeight = (dateStr, halfLife = _SEASON_HALF_LIFE_DAYS) => {
          if (!dateStr) return 0;
          const t = new Date(dateStr).getTime();
          if (!isFinite(t)) return 0;
          const daysAgo = Math.max(0, (_gtRefMs - t) / 86400000);
          return Math.pow(0.5, daysAgo / halfLife);
        };
        // Takes a schedule map (gtScheduleMap or ttScheduleMap) + sport + team. Both maps
        // share the same shape: { "sport:team": [{ date, comps: [{ abbr, score }] }] }.
        // halfLife defaults to _SEASON_HALF_LIFE_DAYS; MLB callers pass _MLB_HALF_LIFE_DAYS.
        const _recentTeamScoreMean = (schedMap, sport, team, halfLife) => {
          const evts = schedMap?.[`${sport}:${team}`] || [];
          if (evts.length < 5) return null;
          let wSum = 0, scoreSum = 0;
          for (const ev of evts) {
            const w = _recencyWeight(ev.date, halfLife);
            if (w <= 0) continue;
            const mine = ev.comps.find(c => normTeam(sport, c.abbr) === team);
            if (!mine || typeof mine.score !== "number") continue;
            wSum += w;
            scoreSum += w * mine.score;
          }
          if (wSum < 3) return null;
          return { mean: scoreSum / wSum, effectiveSample: wSum };
        };
        // Cap 0.85 / denominator 8. With 21-day half-life, a typical playoff team has ~6-8
        // effective recent-game samples, so 0.85/8 produces ~0.65-0.85 weight — recent form
        // dominates. Rating-based keeps a 15% floor for matchup-specific Off×Def signal.
        // Prior tunings (0.5/30, 0.7/12) underweighted regime and left divergent penalties
        // firing on nearly all playoff totals.
        const _regimeBlendWeight = (sample) => Math.min(0.85, (sample || 0) / 8 * 0.85);
        {
          const _MLB_ERA = 4.20;
          // Pre-fetch home team schedules for MLB + NBA game total H2H hit rate
          const _gtScheduleMap = {};
          // Canonical → ESPN team-route slug translation (mirrors CANONICAL_TO_ESPN in /api/live).
          // Without this, e.g. CWS (canonical) fetches /teams/cws/schedule which 404s — ESPN's
          // White Sox slug is chw. Cache key keeps the canonical form so reads are consistent.
          const _SCHED_TO_ESPN = { mlb: { CWS: "CHW" }, nhl: { TBL: "TB", NJD: "NJ", LAK: "LA", SJS: "SJ" } };
          const _toEspnSlug = (sp, a) => (_SCHED_TO_ESPN[sp]?.[a] || a).toLowerCase();
          const _leagueOf = (sp) => sp === 'mlb' ? 'baseball/mlb' : sp === 'nhl' ? 'hockey/nhl' : sp === 'wnba' ? 'basketball/wnba' : 'basketball/nba';
          // WNBA slugs: ESPN uses CONNECTICU/DALLAS in scoreboard responses but team-route URLs accept short forms.
          // Build a canonical→ESPN slug map mirroring _SCHED_TO_ESPN structure.
          const _WNBA_SCHED_TO_ESPN = { CONN: "conn", DAL: "dal", GS: "gs", LA: "la", LV: "lv", NY: "ny", PHX: "phx", POR: "por", SEA: "sea", TOR: "tor", WSH: "wsh", ATL: "atl", CHI: "chi", IND: "ind", MIN: "min" };
          const _toEspnSlugW = (sp, a) => sp === "wnba" ? (_WNBA_SCHED_TO_ESPN[a] || a.toLowerCase()) : _toEspnSlug(sp, a);
          { const _gtHTs = new Set(); for (const tm of totalMarkets) { if (PROD_SPORTS.has(tm.sport)) { _gtHTs.add(`${tm.sport}:${tm.gameTeam1}`); _gtHTs.add(`${tm.sport}:${tm.gameTeam2}`); } } await Promise.all([..._gtHTs].map(async spHt => { const [sp, ht] = spHt.split(':'); const league = _leagueOf(sp); const ck = `teamschedule:v3:${sp}:${ht.toLowerCase()}`; let ev = isBustCache ? null : await CACHE2?.get(ck, "json").catch(() => null); if (!ev) { try { const base = `https://site.api.espn.com/apis/site/v2/sports/${league}/teams/${_toEspnSlugW(sp, ht)}/schedule`; const r25 = await fetch(`${base}?season=2025`, { signal: AbortSignal.timeout(3000) }); const e25 = r25.ok ? _parseSchedEvts(await r25.json()) : []; const r26 = await fetch(base, { signal: AbortSignal.timeout(3000) }); const e26 = r26.ok ? _parseSchedEvts(await r26.json()) : []; ev = [...e25, ...e26]; if (ev.length && CACHE2) await CACHE2.put(ck, JSON.stringify(ev), { expirationTtl: 3600 }).catch(() => {}); } catch(e) {} } if (ev) _gtScheduleMap[spHt] = ev; })); }
          const _gtH2HRate = (ht, at, thr) => { const evts = _gtScheduleMap[`mlb:${ht}`] ?? _gtScheduleMap[ht] ?? []; const h2h = evts.filter(ev => ev.comps.some(c => normTeam("mlb", c.abbr) === at)).slice(-10); if (h2h.length < 3) return null; const hits = h2h.filter(ev => ev.comps.reduce((s, c) => s + (c.score || 0), 0) >= thr).length; return { rate: Math.round(hits / h2h.length * 100), games: h2h.length }; };
          // Season hit rate for MLB/NBA/NHL game totals: average of home + away team's full-season
          // rate of games where combined score >= threshold. Used as a sample-weighted blend
          // against the sim model truePct to correct for tail-thinness at far-from-line thresholds.
          // Returns { rate, sample } where sample = min(home games, away games) for blend weighting.
          // Requires both teams to have >= 5 schedule games.
          const _gtSeasonHitRate = (sport, ht, at, thr) => {
            const hEvts = _gtScheduleMap[`${sport}:${ht}`] || [];
            const aEvts = _gtScheduleMap[`${sport}:${at}`] || [];
            if (hEvts.length < 5 || aEvts.length < 5) return null;
            const _rate = (evts) => evts.filter(ev => ev.comps.reduce((s, c) => s + (c.score || 0), 0) >= thr).length / evts.length * 100;
            return { rate: Math.round((_rate(hEvts) + _rate(aEvts)) / 2), sample: Math.min(hEvts.length, aEvts.length) };
          };
          // League-wide MLB run dispersion: pooled method-of-moments fit on per-team residuals
          // from _gtScheduleMap. Real MLB game totals are overdispersed vs Poisson (~2× var/mean
          // ratio) due to big-inning fat tails + no-hit thin left tail. Lambdas are still right;
          // variance is wrong. r is the NegBin dispersion (lower r = fatter tails, r → ∞ recovers
          // Poisson). Sampled per request from current schedule so it self-adjusts as the season
          // matures. Falls back to 8 (~empirical from May 2026 audit) when sample is thin.
          const _fitMlbDispersion = () => {
            let sumResid2 = 0, sumMean = 0, nGames = 0;
            for (const key in _gtScheduleMap) {
              if (!key.startsWith("mlb:")) continue;
              const team = key.slice(4);
              const evts = _gtScheduleMap[key];
              if (!evts || evts.length < 8) continue;
              const scores = [];
              for (const ev of evts) {
                const myComp = ev.comps?.find(c => normTeam("mlb", c.abbr) === team);
                if (myComp?.score != null) scores.push(myComp.score);
              }
              if (scores.length < 8) continue;
              const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
              for (const s of scores) {
                sumResid2 += (s - mean) * (s - mean);
                sumMean += mean;
                nGames += 1;
              }
            }
            if (nGames < 100) return 8;
            const pooledMean = sumMean / nGames;
            const pooledVar = sumResid2 / nGames;
            if (pooledVar <= pooledMean) return 50;
            const r = (pooledMean * pooledMean) / (pooledVar - pooledMean);
            return Math.max(3, Math.min(50, parseFloat(r.toFixed(2))));
          };
          const _mlbDispR = _fitMlbDispersion();
          // Sample-weighted blend factor: model retains at least 30% weight so tonight-specific
          // factors (pitcher matchup, pace, weather) aren't drowned out. Caps obs weight at 0.7
          // when N >= 40 games; ramps linearly from 0 (no schedule) to 0.7.
          const _ssnBlendWeight = (sample) => Math.min(1, (sample || 0) / 40) * 0.7;
          const _nbaGtH2HRate = (ht, at, thr) => { const evts = _gtScheduleMap[`nba:${ht}`] ?? []; const h2h = evts.filter(ev => ev.comps.some(c => normTeam("nba", c.abbr) === at)).slice(-10); if (h2h.length < 3) return null; const hits = h2h.filter(ev => ev.comps.reduce((s, c) => s + (c.score || 0), 0) >= thr).length; return { rate: Math.round(hits / h2h.length * 100), games: h2h.length }; };
          // B2B detection + dampener constants are hoisted to module scope (see top of file).
          const _gtVolumeMap = {};
          for (const tm of totalMarkets) { const _gk = `${tm.sport}|${tm.gameTeam1}|${tm.gameTeam2}`; _gtVolumeMap[_gk] = (_gtVolumeMap[_gk] ?? 0) + (tm.kalshiVolume ?? 0); }
          for (const tm of totalMarkets) {
            const { sport, stat, threshold, kalshiPct, americanOdds, noKalshiPct: _tmNoPct, noKalshiAO: _tmNoAO, gameTeam1, gameTeam2, gameDate, kalshiSpread, kalshiVolume } = tm;
            if (gameDate && gameDate < cutoffStr) continue;
            const spreadAdj = kalshiSpread != null ? parseFloat((kalshiSpread / 2).toFixed(1)) : 0;
            const lowVolume = (_gtVolumeMap[`${sport}|${gameTeam1}|${gameTeam2}`] ?? 0) < 50;
            let truePct = null, homeTeam = gameTeam1, awayTeam = gameTeam2, totalSimScore = 0, _simData = {};
            // Kalshi ticker order doesn't reflect ESPN home/away. Swap if needed so the matchup
            // card and downstream consumers see the same home/away as gameScores.
            if (sport === "nba" || sport === "nhl" || sport === "wnba") {
              const _gsMap = sport === "nba" ? sportByteam.nbaGameScores : sport === "wnba" ? sportByteam.wnbaGameScores : sportByteam.nhlGameScores;
              if (_gsMap) {
                for (const _gs of Object.values(_gsMap)) {
                  if (_gs?.homeTeam === gameTeam2 && _gs?.awayTeam === gameTeam1) { homeTeam = gameTeam2; awayTeam = gameTeam1; break; }
                }
              }
            }
            if (sport === "mlb") {
              if (sportByteam.mlb?.gameHomeTeams?.[gameTeam2]) { homeTeam = gameTeam2; awayTeam = gameTeam1; }
              // Road RPG strips home-park bias from the lambda numerator (fallback to overall RPG)
              const homeRPG = mlbRoadRPGMap[homeTeam] ?? mlbRPGMap[homeTeam] ?? null;
              const awayRPG = mlbRoadRPGMap[awayTeam] ?? mlbRPGMap[awayTeam] ?? null;
              // Lineup / pitcher injury adjustments (added 2026-05-18). Each team's lambda gets a
              // tiered multiplier based on how many of their hitters are in today's injury report
              // (status: out/gtd/il), excluding pitchers. Pitcher IL is detected by ID match against
              // pitcherInfoByTeam[team].id; if true, we null the starter inputs so the existing
              // fallback uses bullpen-only ERA (a reasonable proxy for a bullpen day / AAA call-up).
              const _injReport = sportByteam.mlb?.injuryByTeam || {};
              const _countHitterOuts = (team) => {
                const list = _injReport[team] || [];
                // Pitchers identified by pos field (P/SP/RP) or by ID match against pitcherInfoByTeam
                const pitcherId = sportByteam.mlb?.pitcherInfoByTeam?.[team]?.id ? String(sportByteam.mlb.pitcherInfoByTeam[team].id) : null;
                return list.filter(p => {
                  const isPitcher = p.pos === "P" || p.pos === "SP" || p.pos === "RP" || (pitcherId && p.id === pitcherId);
                  return !isPitcher;
                }).length;
              };
              const _isPitcherOnIL = (team) => {
                const list = _injReport[team] || [];
                const pitcherId = sportByteam.mlb?.pitcherInfoByTeam?.[team]?.id ? String(sportByteam.mlb.pitcherInfoByTeam[team].id) : null;
                if (!pitcherId) return false;
                return list.some(p => p.id === pitcherId && (p.status === "out" || p.status === "gtd"));
              };
              const _lineupFactor = (nOut) => nOut === 0 ? 1.0 : nOut === 1 ? 0.98 : nOut === 2 ? 0.96 : 0.93;
              const homeTopOut = _countHitterOuts(homeTeam);
              const awayTopOut = _countHitterOuts(awayTeam);
              const homeLineupFactor = _lineupFactor(homeTopOut);
              const awayLineupFactor = _lineupFactor(awayTopOut);
              const homePitcherOnIL = _isPitcherOnIL(homeTeam);
              const awayPitcherOnIL = _isPitcherOnIL(awayTeam);
              // Regressed pitcherEra (two-step shrinkage, see api/lib/mlb.js) preferred over raw probables.era;
              // probables fallback only fires for pitchers with no 2026/2025 sample (debut/late-announcement).
              // If today's probable is on the IL (detected via injury report ID match), null the starter inputs
              // so the lambda falls back to bullpen-only ERA — catches the lag between IL announcement and ESPN probable update.
              const homeERA = homePitcherOnIL ? null : (sportByteam.mlb?.pitcherEra?.[homeTeam] ?? sportByteam.mlb?.probables?.[homeTeam]?.era ?? null);
              const awayERA = awayPitcherOnIL ? null : (sportByteam.mlb?.pitcherEra?.[awayTeam] ?? sportByteam.mlb?.probables?.[awayTeam]?.era ?? null);
              const homeFIP = homePitcherOnIL ? null : (sportByteam.mlb?.pitcherFIPByTeam?.[homeTeam] ?? null);
              const awayFIP = awayPitcherOnIL ? null : (sportByteam.mlb?.pitcherFIPByTeam?.[awayTeam] ?? null);
              // Starter WHIP first; fall back to team-staff WHIP when starter unknown (debut/late-announcement).
              const homeStarterWHIP = homePitcherOnIL ? null : (sportByteam.mlb?.pitcherWHIPByTeam?.[homeTeam] ?? null);
              const awayStarterWHIP = awayPitcherOnIL ? null : (sportByteam.mlb?.pitcherWHIPByTeam?.[awayTeam] ?? null);
              const homeWHIP = homeStarterWHIP ?? mlbTeamWHIPMap[homeTeam] ?? null;
              const awayWHIP = awayStarterWHIP ?? mlbTeamWHIPMap[awayTeam] ?? null;
              const homeWHIPSource = homeStarterWHIP != null ? "starter" : (mlbTeamWHIPMap[homeTeam] != null ? "team" : null);
              const awayWHIPSource = awayStarterWHIP != null ? "starter" : (mlbTeamWHIPMap[awayTeam] != null ? "team" : null);
              // Pitcher vs-L/vs-R split modifiers (added 2026-05-25). Each side's starter FIP and
              // WHIP get a multiplicative bump based on the opposing lineup's hand composition vs
              // the starter's per-split rates. Switch hitters resolve opposite the starter's hand.
              // Modifier defaults to 1.0 when split or lineup data is missing.
              const _splitMix = (oppComp, starterHand, splits, side) => {
                if (!oppComp || !starterHand || !splits) return { fipMod: 1.0, whipMod: 1.0, lFrac: null };
                const lCnt = oppComp.l + (starterHand === "R" ? oppComp.s : 0);
                const rCnt = oppComp.r + (starterHand === "L" ? oppComp.s : 0);
                const total = lCnt + rCnt;
                if (total < 6) return { fipMod: 1.0, whipMod: 1.0, lFrac: null };
                const lFrac = lCnt / total;
                return {
                  fipMod: parseFloat((lFrac * splits.vlFipMod + (1 - lFrac) * splits.vrFipMod).toFixed(3)),
                  whipMod: parseFloat((lFrac * splits.vlWhipMod + (1 - lFrac) * splits.vrWhipMod).toFixed(3)),
                  lFrac: parseFloat(lFrac.toFixed(3)),
                };
              };
              const _homeStarterHand = sportByteam.mlb?.pitcherHand?.[homeTeam] ?? null;
              const _awayStarterHand = sportByteam.mlb?.pitcherHand?.[awayTeam] ?? null;
              const _homeSplits = sportByteam.mlb?.pitcherSplitsByTeam?.[homeTeam] ?? null;
              const _awaySplits = sportByteam.mlb?.pitcherSplitsByTeam?.[awayTeam] ?? null;
              const _homeMix = _splitMix(sportByteam.mlb?.lineupHandByTeam?.[awayTeam] ?? null, _homeStarterHand, _homeSplits, "home");
              const _awayMix = _splitMix(sportByteam.mlb?.lineupHandByTeam?.[homeTeam] ?? null, _awayStarterHand, _awaySplits, "away");
              // TEMP DEBUG: emit raw counts so we can diagnose why splits aren't firing in prod.
              const _splitDebug = {
                _hasSplitsByTeam: !!sportByteam.mlb?.pitcherSplitsByTeam,
                _splitsTeamCount: Object.keys(sportByteam.mlb?.pitcherSplitsByTeam || {}).length,
                _hasLineupHandByTeam: !!sportByteam.mlb?.lineupHandByTeam,
                _lineupHandTeamCount: Object.keys(sportByteam.mlb?.lineupHandByTeam || {}).length,
                _homeSplitsRaw: _homeSplits ? "yes" : "no",
                _awaySplitsRaw: _awaySplits ? "yes" : "no",
                _homeOppComp: JSON.stringify(sportByteam.mlb?.lineupHandByTeam?.[awayTeam] ?? null),
              };
              const homeFipEff  = homeFIP  != null ? parseFloat((homeFIP  * _homeMix.fipMod).toFixed(2))  : null;
              const awayFipEff  = awayFIP  != null ? parseFloat((awayFIP  * _awayMix.fipMod).toFixed(2))  : null;
              const homeWhipEff = homeWHIP != null ? parseFloat((homeWHIP * _homeMix.whipMod).toFixed(2)) : null;
              const awayWhipEff = awayWHIP != null ? parseFloat((awayWHIP * _awayMix.whipMod).toFixed(2)) : null;
              const homeTeamERA = mlbTeamERAMap[homeTeam] ?? null;
              const awayTeamERA = mlbTeamERAMap[awayTeam] ?? null;
              // Bullpen ERA replaces whole-staff teamERA in the 40% rest-of-game share so the starter
              // isn't double-counted. Falls back to teamERA when bullpen aggregate is missing (rare).
              const _homeBullpenERA = mlbBullpenERAMap[homeTeam] ?? null;
              const _awayBullpenERA = mlbBullpenERAMap[awayTeam] ?? null;
              const homeBullpenSource = _homeBullpenERA != null ? "bullpen" : (homeTeamERA != null ? "team" : null);
              const awayBullpenSource = _awayBullpenERA != null ? "bullpen" : (awayTeamERA != null ? "team" : null);
              const _homeRestERA = _homeBullpenERA ?? homeTeamERA ?? null;
              const _awayRestERA = _awayBullpenERA ?? awayTeamERA ?? null;
              const parkRF = PARK_RUNFACTOR[homeTeam] ?? 1;
              const gameOuLine = sportByteam.mlb?.gameOdds?.[homeTeam]?.total ?? sportByteam.mlb?.gameOdds?.[awayTeam]?.total ?? null;
              const _mlbOuPts = gameOuLine == null ? 1 : gameOuLine >= 9.5 ? 2 : gameOuLine >= 7.5 ? 1 : 0;
              // Starter component: 50/50 FIP/ERA blend (FIP strips fielding/sequencing luck, ERA captures recent results),
              // multiplied by a WHIP traffic factor. Exponent 0.5 dampens WHIP so it doesn't fully double-count ERA/FIP.
              // Falls back gracefully when one or both are missing.
              const _LG_WHIP = 1.30;
              const _whipAdj = (whip) => whip != null ? Math.max(0.90, Math.min(1.10, Math.pow(whip / _LG_WHIP, 0.5))) : 1.0;
              const _starterMult = (fip, era, whip) => {
                const erafipMult = fip != null && era != null ? 0.5*(fip/_MLB_ERA) + 0.5*(era/_MLB_ERA)
                  : fip != null ? fip/_MLB_ERA
                  : era != null ? era/_MLB_ERA
                  : null;
                return erafipMult != null ? erafipMult * _whipAdj(whip) : null;
              };
              // TTO (Third Time Through Order) penalty: 3rd-TTO PAs run ~0.50 ERA / 15% wOBA
              // higher than 1st. When expectedBF > 22, the starter is going through the lineup
              // a third time and the back-end PAs deserve a multiplicative bump on their
              // run-rate inputs. Ramps from 1.0 at BF=22 to a cap of 1.10 at BF≥29 (covers
              // both ERA and FIP — WHIP is a traffic measure and stays untouched).
              const _ttoBump = (bf) => bf == null ? 1.0 : 1 + Math.max(0, Math.min(0.10, (bf - 22) / 22 * 0.30));
              const _homeBF = sportByteam.mlb?.pitcherAvgBF?.[homeTeam] ?? null;
              const _awayBF = sportByteam.mlb?.pitcherAvgBF?.[awayTeam] ?? null;
              const _homeTto = _ttoBump(_homeBF);
              const _awayTto = _ttoBump(_awayBF);
              // 60/40 starter/bullpen blend — away staff vs home offense, home staff vs away offense.
              // 40% term is bullpen-only (preferred) or whole-staff teamERA (fallback). Whole-staff
              // double-counts the starter; bullpen-only is the clean rest-of-game proxy.
              const _awayStarter = _starterMult(
                awayFipEff != null ? awayFipEff * _awayTto : (awayFIP != null ? awayFIP * _awayTto : null),
                awayERA != null ? awayERA * _awayTto : null,
                awayWhipEff != null ? awayWhipEff : awayWHIP
              );
              const _homeStarter = _starterMult(
                homeFipEff != null ? homeFipEff * _homeTto : (homeFIP != null ? homeFIP * _homeTto : null),
                homeERA != null ? homeERA * _homeTto : null,
                homeWhipEff != null ? homeWhipEff : homeWHIP
              );
              const _awayMult = _awayStarter != null && _awayRestERA != null ? 0.6*_awayStarter + 0.4*(_awayRestERA/_MLB_ERA) : _awayStarter != null ? _awayStarter : _awayRestERA != null ? _awayRestERA/_MLB_ERA : 1;
              const _homeMult = _homeStarter != null && _homeRestERA != null ? 0.6*_homeStarter + 0.4*(_homeRestERA/_MLB_ERA) : _homeStarter != null ? _homeStarter : _homeRestERA != null ? _homeRestERA/_MLB_ERA : 1;
              // Platoon adjustment: ratio of team's RPG vs opposing starter's hand to overall RPG
              // Park effects cancel in the ratio (same mix of home/away games in numerator & denominator)
              const _platoonMap = sportByteam.mlb?.teamPlatoonRPGMap ?? {};
              // _homeStarterHand / _awayStarterHand already declared above for split-mix calc — reuse.
              const _homePlatCode = _awayStarterHand === 'L' ? 'vl' : _awayStarterHand === 'R' ? 'vr' : null;
              const _awayPlatCode = _homeStarterHand === 'L' ? 'vl' : _homeStarterHand === 'R' ? 'vr' : null;
              const _homePlatFactor = (_homePlatCode && _platoonMap[homeTeam]?.[_homePlatCode])
                ? _platoonMap[homeTeam][_homePlatCode] : 1.0;
              const _awayPlatFactor = (_awayPlatCode && _platoonMap[awayTeam]?.[_awayPlatCode])
                ? _platoonMap[awayTeam][_awayPlatCode] : 1.0;
              // Weather factor: wind out → more scoring, wind in → fewer runs; skip domed parks
              const _wKey = `${homeTeam}|${awayTeam}`;
              const _wData = weatherByGame[_wKey] ?? null;
              const _weatherFactor = (_wData?.windOutMph != null && !_MLB_DOMED.has(homeTeam))
                ? parseFloat((Math.max(0.85, Math.min(1.15, 1 + _wData.windOutMph * 0.013 + ((_wData.temp ?? 72) - 72) * 0.001))).toFixed(3))
                : 1.0;
              // Umpire run factor (1/kFactor): loose-zone ump → more scoring; applied directly to lambdas
              const _umpKeyT = `${homeTeam}|${awayTeam}`;
              const _umpNameT = sportByteam.mlb?.umpireByGame?.[_umpKeyT] ?? null;
              const _normUT = n => n?.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
              const _umpKFT = _umpNameT ? (UMPIRE_KFACTOR[_normUT(_umpNameT)] ?? 1.0) : 1.0;
              const _umpRunFactor = parseFloat((1 / _umpKFT).toFixed(3));
              let _hLam = homeRPG != null ? parseFloat((Math.max(1, Math.min(12, homeRPG * _awayMult * parkRF * _homePlatFactor * _weatherFactor * _umpRunFactor * homeLineupFactor))).toFixed(1)) : null;
              let _aLam = awayRPG != null ? parseFloat((Math.max(1, Math.min(12, awayRPG * _homeMult * parkRF * _awayPlatFactor * _weatherFactor * _umpRunFactor * awayLineupFactor))).toFixed(1)) : null;
              // Regime-aware blend — each team's recency-weighted recent-runs average folded
              // into the pitcher-matchup-derived lambda so it tracks current form. Mirrors the
              // 2026-05-21 NBA/WNBA/NHL change but with a 14-day half-life (MLB plays daily;
              // turnover is faster). The pitcher-driven lambda is still the primary signal;
              // _regimeBlendWeight caps the recency share at 0.85 with denominator 8.
              const _mlbHomeRecent = _recentTeamScoreMean(_gtScheduleMap, "mlb", homeTeam, _MLB_HALF_LIFE_DAYS);
              const _mlbAwayRecent = _recentTeamScoreMean(_gtScheduleMap, "mlb", awayTeam, _MLB_HALF_LIFE_DAYS);
              let _mlbRegimeBlendW = 0;
              if (_mlbHomeRecent && _mlbAwayRecent && _hLam != null && _aLam != null) {
                const _mlbSample = Math.min(_mlbHomeRecent.effectiveSample, _mlbAwayRecent.effectiveSample);
                _mlbRegimeBlendW = _regimeBlendWeight(_mlbSample);
                _hLam = parseFloat(((1 - _mlbRegimeBlendW) * _hLam + _mlbRegimeBlendW * _mlbHomeRecent.mean).toFixed(2));
                _aLam = parseFloat(((1 - _mlbRegimeBlendW) * _aLam + _mlbRegimeBlendW * _mlbAwayRecent.mean).toFixed(2));
              }
              // H2H combined hit rate: how often (homeScore+awayScore) >= threshold in last 10 H2H meetings
              const _gtH2H = _gtH2HRate(homeTeam, awayTeam, threshold);
              const h2hTotalHitRate = _gtH2H?.rate ?? null;
              const h2hTotalGames = _gtH2H?.games ?? null;
              const _h2hTotalPts = h2hTotalHitRate == null ? 1 : h2hTotalHitRate >= 80 ? 2 : h2hTotalHitRate >= 60 ? 1 : 0;
              const _combinedRPG = homeRPG != null && awayRPG != null ? parseFloat((homeRPG + awayRPG).toFixed(2)) : null;
              const _combinedRPGPts = _combinedRPG == null ? 1 : _combinedRPG >= 10.5 ? 2 : _combinedRPG >= 8.5 ? 1 : 0;
              const _homeWhipPts = homeWHIP == null ? 1 : homeWHIP > 1.35 ? 2 : homeWHIP > 1.20 ? 1 : 0;
              const _awayWhipPts = awayWHIP == null ? 1 : awayWHIP > 1.35 ? 2 : awayWHIP > 1.20 ? 1 : 0;
              _simData = { homeRPG, awayRPG, homeERA, awayERA, homeFIP, awayFIP, homeWHIP, awayWHIP, ...(homeWHIPSource && { homeWHIPSource }), ...(awayWHIPSource && { awayWHIPSource }), homeBullpenERA: _homeRestERA, awayBullpenERA: _awayRestERA, ...(homeBullpenSource && { homeBullpenSource }), ...(awayBullpenSource && { awayBullpenSource }), parkFactor: parkRF, homeExpected: _hLam, awayExpected: _aLam, expectedTotal: (_hLam != null && _aLam != null) ? parseFloat((_hLam + _aLam).toFixed(1)) : null, gameOuLine, mlbOuPts: _mlbOuPts, homeWhipPts: _homeWhipPts, awayWhipPts: _awayWhipPts, combinedRpgPts: _combinedRPGPts, h2hTotalPts: _h2hTotalPts, combinedRPG: _combinedRPG, umpireRunFactor: _umpNameT != null ? _umpRunFactor : null, umpireName: _umpNameT, h2hTotalHitRate, h2hTotalGames, homeStarterHand: _homeStarterHand, awayStarterHand: _awayStarterHand, ...(_homePlatFactor !== 1.0 && { homePlatoonFactor: _homePlatFactor }), ...(_awayPlatFactor !== 1.0 && { awayPlatoonFactor: _awayPlatFactor }), ...(_weatherFactor !== 1.0 && { weatherFactor: _weatherFactor, windOutMph: _wData?.windOutMph }), ...(homeTopOut > 0 && { homeTopOut, homeLineupFactor }), ...(awayTopOut > 0 && { awayTopOut, awayLineupFactor }), ...(homePitcherOnIL && { homePitcherOnIL: true }), ...(awayPitcherOnIL && { awayPitcherOnIL: true }), ...(_homeTto !== 1.0 && { homeExpectedBF: _homeBF, homeTtoBump: parseFloat(_homeTto.toFixed(3)) }), ...(_awayTto !== 1.0 && { awayExpectedBF: _awayBF, awayTtoBump: parseFloat(_awayTto.toFixed(3)) }), ...(_mlbRegimeBlendW > 0 && { regimeBlendW: parseFloat(_mlbRegimeBlendW.toFixed(2)), homeRecentMean: parseFloat(_mlbHomeRecent.mean.toFixed(2)), awayRecentMean: parseFloat(_mlbAwayRecent.mean.toFixed(2)) }), ...(_homeMix.lFrac != null && { homeOppLFrac: _homeMix.lFrac, homeFipMod: _homeMix.fipMod, homeWhipMod: _homeMix.whipMod, homeFipEff, homeWhipEff }), ...(_awayMix.lFrac != null && { awayOppLFrac: _awayMix.lFrac, awayFipMod: _awayMix.fipMod, awayWhipMod: _awayMix.whipMod, awayFipEff, awayWhipEff }), ..._splitDebug };
              if (_hLam != null && _aLam != null) {
                const _dk = `mlb|${homeTeam}|${awayTeam}`;
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateMLBTotalDist(_hLam, _aLam, _mlbDispR, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
                const _mlCtxKey = `${homeTeam}|${awayTeam}|${gameDate}`;
                if (!_mlbMlContext[_mlCtxKey]) {
                  _mlbMlContext[_mlCtxKey] = { homeTeam, awayTeam, gameDate, homeLambda: _hLam, awayLambda: _aLam, dispR: _mlbDispR, kalshiVolume, kalshiSpread, lowVolume, _simData: { ..._simData } };
                }
              }
              // Pre-sim lambda blend: solve for the NegBin mean that would produce the observed
              // season hit rate at this threshold (matches the sim's NegBin variance), then
              // sample-weighted blend with model lambda. Cleaner attribution than post-sim blend —
              // seasonHitRate is now an input to the distribution, not a correction on its output.
              // Falls back to model lambda if no obs.
              const _gtMlbSsn = (truePct != null && _hLam != null && _aLam != null) ? _gtSeasonHitRate("mlb", homeTeam, awayTeam, threshold) : null;
              if (_gtMlbSsn != null) {
                const _w = _ssnBlendWeight(_gtMlbSsn.sample);
                const _modelLambda = _hLam + _aLam;
                const _impliedLambda = muForNegBinTail(threshold, _gtMlbSsn.rate / 100, _mlbDispR);
                if (_impliedLambda != null) {
                  const _cap = _GT_IMPLIED_CAP.mlb;
                  const _impliedClamped = Math.max(_modelLambda - _cap, Math.min(_modelLambda + _cap, _impliedLambda));
                  const _blendedLambda = (1 - _w) * _modelLambda + _w * _impliedClamped;
                  _simData.modelTruePct = parseFloat(truePct.toFixed(1));
                  _simData.gtSeasonHitRate = _gtMlbSsn.rate;
                  _simData.gtSsnSample = _gtMlbSsn.sample;
                  _simData.modelLambda = parseFloat(_modelLambda.toFixed(2));
                  _simData.impliedLambda = _impliedLambda;
                  if (_impliedClamped !== _impliedLambda) _simData.impliedLambdaClamped = parseFloat(_impliedClamped.toFixed(2));
                  _simData.blendedLambda = parseFloat(_blendedLambda.toFixed(2));
                  _simData.mlbDispR = _mlbDispR;
                  truePct = parseFloat(((1 - negBinCDF(threshold - 1, _blendedLambda, _mlbDispR)) * 100).toFixed(1));
                }
              }
              // MLB SimScore (max 10): homeWHIP→0-2, awayWHIP→0-2, combinedRPG→0-2, H2H→0-2, O/U→0-2
              totalSimScore += _homeWhipPts + _awayWhipPts + _combinedRPGPts + _h2hTotalPts + _mlbOuPts;
            } else if (sport === "nba") {
              const _hp = nbaPaceData?.teamPace?.[homeTeam] ?? null, _ap = nbaPaceData?.teamPace?.[awayTeam] ?? null;
              const _lgPace = nbaPaceData?.leagueAvgPace ?? null;
              const _nbaOuLine = sportByteam.nbaGameOdds?.[homeTeam]?.total ?? sportByteam.nbaGameOdds?.[awayTeam]?.total ?? null;
              const _nbaGtSpread = sportByteam.nbaGameOdds?.[homeTeam]?.spread ?? sportByteam.nbaGameOdds?.[awayTeam]?.spread ?? null;
              // Possession-based projection — eliminates pace double-count from raw PPG
              // OffRtg = avgPoints / pace * 100 (derived in buildNbaPaceData from ESPN stats)
              // DefRtg = defPPGAllowed / pace * 100 (derived inline from existing nbaDefRank data)
              const _hOffRtg = nbaPaceData?.teamOffRtg?.[homeTeam] ?? null;
              const _aOffRtg = nbaPaceData?.teamOffRtg?.[awayTeam] ?? null;
              const _lgOffRtg = nbaPaceData?.leagueAvgOffRtg ?? 113.0;
              const nbaDefRank = STAT_SOFT["nba|points"]?.rankMap ?? {};
              const nbaAvgDef = leagueAvgCache["nba|points"] ?? nbaLeagueAvgOffPPG;
              // DefRtg: PPG allowed / pace * 100 — eliminates pace from defense metric too
              const _hDefRtg = (nbaDefRank[homeTeam]?.value != null && _hp != null && _hp > 0) ? parseFloat((nbaDefRank[homeTeam].value / _hp * 100).toFixed(1)) : null;
              const _aDefRtg = (nbaDefRank[awayTeam]?.value != null && _ap != null && _ap > 0) ? parseFloat((nbaDefRank[awayTeam].value / _ap * 100).toFixed(1)) : null;
              // Injury-adjusted OffRtg: reduce season OffRtg by sum-of-Out-player-USG × replacement penalty (0.15).
              // Bench replacements cover most of the absolute scoring volume; reduction reflects efficiency loss.
              const _homeInjAdj = _injuryOffRtgAdj(homeTeam, nbaInjuryMap, nbaUsageMap, _NBAshortNorm);
              const _awayInjAdj = _injuryOffRtgAdj(awayTeam, nbaInjuryMap, nbaUsageMap, _NBAshortNorm);
              // B2B dampener: own offense -2.5% if the team played yesterday in PT.
              const _homeB2B = _isB2B(_gtScheduleMap, "nba", homeTeam, gameDate);
              const _awayB2B = _isB2B(_gtScheduleMap, "nba", awayTeam, gameDate);
              const _homeB2BFactor = _homeB2B ? B2B_NBA : 1.0;
              const _awayB2BFactor = _awayB2B ? B2B_NBA : 1.0;
              const _hOffRtgAdj = _hOffRtg != null ? parseFloat((_hOffRtg * _homeInjAdj.adj * _homeB2BFactor).toFixed(1)) : null;
              const _aOffRtgAdj = _aOffRtg != null ? parseFloat((_aOffRtg * _awayInjAdj.adj * _awayB2BFactor).toFixed(1)) : null;
              let _homeExpRaw = null, _awayExpRaw = null, _projPace = null;
              if (_hOffRtg != null && _aDefRtg != null && _aOffRtg != null && _hDefRtg != null && _hp != null && _ap != null && _lgPace != null && _lgPace > 0) {
                // Geometric-mean pace: correctly handles extreme pace matchups without simple averaging
                _projPace = parseFloat(((_hp * _ap) / _lgPace).toFixed(1));
                _homeExpRaw = (_hOffRtgAdj * _aDefRtg / (_lgOffRtg * _lgOffRtg)) * _projPace;
                _awayExpRaw = (_aOffRtgAdj * _hDefRtg / (_lgOffRtg * _lgOffRtg)) * _projPace;
              } else {
                // Fallback: old PPG-based formula when pace data unavailable. Apply same injury adj.
                const homeOff = nbaOffPPGMap[homeTeam] ?? null, awayOff = nbaOffPPGMap[awayTeam] ?? null;
                const homeDef = nbaDefRank[homeTeam]?.value ?? null, awayDef = nbaDefRank[awayTeam]?.value ?? null;
                const _homeOffAdj = homeOff != null ? homeOff * _homeInjAdj.adj : null;
                const _awayOffAdj = awayOff != null ? awayOff * _awayInjAdj.adj : null;
                _homeExpRaw = _homeOffAdj != null ? _homeOffAdj * (awayDef != null && nbaAvgDef ? awayDef / nbaAvgDef : 1) : null;
                _awayExpRaw = _awayOffAdj != null ? _awayOffAdj * (homeDef != null && nbaAvgDef ? homeDef / nbaAvgDef : 1) : null;
              }
              // Playoff context detection retained for simData attribution only — the
              // _PLAYOFF_OFF_BOOST static 4% multiplier was replaced 2026-05-21 with the
              // regime-blend below (recency-weighted recent-score average folded into the
              // rating-based expected). The blend captures playoff scoring shifts AND
              // mid-season hot/cold streaks without a manually-tuned multiplier.
              const _isPlayoff = Object.values(sportByteam.nbaGameScores || {}).some(g =>
                g?.seriesSummary && (g.homeTeam === homeTeam || g.awayTeam === homeTeam || g.homeTeam === awayTeam || g.awayTeam === awayTeam)
              );
              const _homeRecent = _recentTeamScoreMean(_gtScheduleMap, "nba", homeTeam);
              const _awayRecent = _recentTeamScoreMean(_gtScheduleMap, "nba", awayTeam);
              let _regimeBlendW = 0;
              if (_homeRecent && _awayRecent && _homeExpRaw != null && _awayExpRaw != null) {
                const _sample = Math.min(_homeRecent.effectiveSample, _awayRecent.effectiveSample);
                _regimeBlendW = _regimeBlendWeight(_sample);
                _homeExpRaw = (1 - _regimeBlendW) * _homeExpRaw + _regimeBlendW * _homeRecent.mean;
                _awayExpRaw = (1 - _regimeBlendW) * _awayExpRaw + _regimeBlendW * _awayRecent.mean;
              }
              // Keep injuries in simData for reference (not scored)
              const _NBAshort = { GSW:"GS", SAS:"SA", NYK:"NY", NOP:"NO", PHX:"PHO" };
              const _homeOut = (nbaInjuryMap.get(homeTeam) || nbaInjuryMap.get(_NBAshort[homeTeam]) || []).length;
              const _awayOut = (nbaInjuryMap.get(awayTeam) || nbaInjuryMap.get(_NBAshort[awayTeam]) || []).length;
              // H2H combined hit rate: combined score >= threshold in last 10 H2H meetings
              const _nbaGtH2H = _nbaGtH2HRate(homeTeam, awayTeam, threshold);
              const nbaGtH2HRate = _nbaGtH2H?.rate ?? null;
              const nbaGtH2HGames = _nbaGtH2H?.games ?? null;
              // Combined OffRtg and DefRtg averages
              const _combOffRtg = (_hOffRtg != null && _aOffRtg != null) ? parseFloat(((_hOffRtg + _aOffRtg) / 2).toFixed(1)) : (_hOffRtg ?? _aOffRtg);
              const _combDefRtg = (_hDefRtg != null && _aDefRtg != null) ? parseFloat(((_hDefRtg + _aDefRtg) / 2).toFixed(1)) : (_hDefRtg ?? _aDefRtg);
              // NBA SimScore (max 10): combOffRtg→0-2, combDefRtg→0-2, pace→0-2, H2H HR%→0-2, O/U→0-2
              const _pacePts = (_hp == null || _ap == null || _lgPace == null) ? 1 : (_hp > _lgPace + 2 && _ap > _lgPace + 2) ? 2 : (_hp > _lgPace || _ap > _lgPace) ? 1 : 0;
              const _combOffRtgPts = _combOffRtg == null ? 1 : _combOffRtg >= 118 ? 2 : _combOffRtg >= 113 ? 1 : 0;
              const _combDefRtgPts = _combDefRtg == null ? 1 : _combDefRtg >= 118 ? 2 : _combDefRtg >= 113 ? 1 : 0;
              const _nbaGtH2HPts = nbaGtH2HRate == null ? 1 : nbaGtH2HRate >= 80 ? 2 : nbaGtH2HRate >= 60 ? 1 : 0;
              const _nbaOuPts = _nbaOuLine == null ? 1 : _nbaOuLine >= 225 ? 2 : _nbaOuLine >= 215 ? 1 : 0;
              _simData = { homeOffRtg: _hOffRtg, awayOffRtg: _aOffRtg, homeOffRtgAdj: _hOffRtgAdj, awayOffRtgAdj: _aOffRtgAdj, homeDefRtg: _hDefRtg, awayDefRtg: _aDefRtg, combOffRtg: _combOffRtg, combDefRtg: _combDefRtg, homePace: _hp, awayPace: _ap, leagueAvgPace: _lgPace, projPace: _projPace, gameOuLine: _nbaOuLine, gameSpread: _nbaGtSpread, homeOut: _homeOut, awayOut: _awayOut, homeUsageOut: _homeInjAdj.share, awayUsageOut: _awayInjAdj.share, ...(_homeInjAdj.adj < 1 && { homeOffRtgFactor: _homeInjAdj.adj }), ...(_awayInjAdj.adj < 1 && { awayOffRtgFactor: _awayInjAdj.adj }), ...(_homeB2B && { homeB2B: true, homeB2BFactor: _homeB2BFactor }), ...(_awayB2B && { awayB2B: true, awayB2BFactor: _awayB2BFactor }), nbaGtH2HRate, nbaGtH2HGames, combOffRtgPts: _combOffRtgPts, combDefRtgPts: _combDefRtgPts, pacePts: _pacePts, nbaGtH2HPts: _nbaGtH2HPts, nbaOuPts: _nbaOuPts, homeExpected: _homeExpRaw != null ? parseFloat(_homeExpRaw.toFixed(1)) : null, awayExpected: _awayExpRaw != null ? parseFloat(_awayExpRaw.toFixed(1)) : null, expectedTotal: (_homeExpRaw != null && _awayExpRaw != null) ? parseFloat((_homeExpRaw + _awayExpRaw).toFixed(1)) : null, ...(_isPlayoff && { isPlayoff: true }), ...(_regimeBlendW > 0 && { regimeBlendW: parseFloat(_regimeBlendW.toFixed(2)), homeRecentMean: parseFloat(_homeRecent.mean.toFixed(1)), awayRecentMean: parseFloat(_awayRecent.mean.toFixed(1)) }) };
              if (_homeExpRaw != null && _awayExpRaw != null) {
                const _dk = `nba|${homeTeam}|${awayTeam}`;
                // Per-team std=13 (was 11) — produces game-total std ≈ 18.4, closer to empirical
                // NBA game-total std (~15-18) than the prior ~15.6. Fattens both tails so far-from-line
                // thresholds get more honest probability mass.
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNBATotalDist(_homeExpRaw, _awayExpRaw, 13, 13, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
                const _mlCtxKey = `${homeTeam}|${awayTeam}|${gameDate}`;
                if (!_nbaMlContext[_mlCtxKey]) {
                  _nbaMlContext[_mlCtxKey] = { homeTeam, awayTeam, gameDate, homeLambda: parseFloat(_homeExpRaw.toFixed(2)), awayLambda: parseFloat(_awayExpRaw.toFixed(2)), kalshiVolume, kalshiSpread, lowVolume, _simData: { ..._simData } };
                }
              }
              // Pre-sim mean blend: solve for the Normal mean that would produce the observed
              // season hit rate at this threshold, then sample-weighted blend with model mean.
              // total std = sqrt(13^2 + 13^2) ≈ 18.4 (per-team std=13 in sim above).
              const _gtNbaSsn = (truePct != null && _homeExpRaw != null && _awayExpRaw != null) ? _gtSeasonHitRate("nba", homeTeam, awayTeam, threshold) : null;
              if (_gtNbaSsn != null) {
                const _w = _ssnBlendWeight(_gtNbaSsn.sample);
                const _totalStd = Math.sqrt(13 * 13 + 13 * 13);
                const _modelMean = _homeExpRaw + _awayExpRaw;
                const _impliedMean = meanForNormalTail(threshold, _gtNbaSsn.rate / 100, _totalStd);
                if (_impliedMean != null) {
                  const _cap = _GT_IMPLIED_CAP.nba;
                  const _impliedClamped = Math.max(_modelMean - _cap, Math.min(_modelMean + _cap, _impliedMean));
                  const _blendedMean = (1 - _w) * _modelMean + _w * _impliedClamped;
                  _simData.modelTruePct = parseFloat(truePct.toFixed(1));
                  _simData.gtSeasonHitRate = _gtNbaSsn.rate;
                  _simData.gtSsnSample = _gtNbaSsn.sample;
                  _simData.modelMean = parseFloat(_modelMean.toFixed(2));
                  _simData.impliedMean = _impliedMean;
                  if (_impliedClamped !== _impliedMean) _simData.impliedMeanClamped = parseFloat(_impliedClamped.toFixed(2));
                  _simData.blendedMean = parseFloat(_blendedMean.toFixed(2));
                  truePct = parseFloat(((1 - normCDF(threshold - 0.5, _blendedMean, _totalStd)) * 100).toFixed(1));
                }
              }
              totalSimScore += _combOffRtgPts + _combDefRtgPts + _pacePts + _nbaGtH2HPts + _nbaOuPts;
            } else if (sport === "wnba") {
              // Same possession-based projection as NBA; uses wnbaPaceData (2025 anchored)
              const _whp = wnbaPaceData?.teamPace?.[homeTeam] ?? null;
              const _wap = wnbaPaceData?.teamPace?.[awayTeam] ?? null;
              const _wlgPace = wnbaPaceData?.leagueAvgPace ?? null;
              const _wnbaOuLine = sportByteam.wnbaGameOdds?.[homeTeam]?.total ?? sportByteam.wnbaGameOdds?.[awayTeam]?.total ?? null;
              const _wnbaGtSpread = sportByteam.wnbaGameOdds?.[homeTeam]?.spread ?? sportByteam.wnbaGameOdds?.[awayTeam]?.spread ?? null;
              const _whOffRtg = wnbaPaceData?.teamOffRtg?.[homeTeam] ?? null;
              const _waOffRtg = wnbaPaceData?.teamOffRtg?.[awayTeam] ?? null;
              const _wlgOffRtg = wnbaPaceData?.leagueAvgOffRtg ?? 92.7;
              const _whDefRtg = wnbaPaceData?.teamDefRtg?.[homeTeam] ?? null;
              const _waDefRtg = wnbaPaceData?.teamDefRtg?.[awayTeam] ?? null;
              // Injury-adjusted OffRtg: same formula as NBA. WNBA rosters are smaller (12 vs 15) and
              // stars carry slightly larger usage shares, but starting with the same 0.15 factor for
              // calibration parity — adjust later if WNBA-specific data shows under-correction.
              const _wHomeInjAdj = _injuryOffRtgAdj(homeTeam, wnbaInjuryMap, wnbaUsageMap);
              const _wAwayInjAdj = _injuryOffRtgAdj(awayTeam, wnbaInjuryMap, wnbaUsageMap);
              const _wHomeB2B = _isB2B(_gtScheduleMap, "wnba", homeTeam, gameDate);
              const _wAwayB2B = _isB2B(_gtScheduleMap, "wnba", awayTeam, gameDate);
              const _wHomeB2BFactor = _wHomeB2B ? B2B_WNBA : 1.0;
              const _wAwayB2BFactor = _wAwayB2B ? B2B_WNBA : 1.0;
              const _whOffRtgAdj = _whOffRtg != null ? parseFloat((_whOffRtg * _wHomeInjAdj.adj * _wHomeB2BFactor).toFixed(1)) : null;
              const _waOffRtgAdj = _waOffRtg != null ? parseFloat((_waOffRtg * _wAwayInjAdj.adj * _wAwayB2BFactor).toFixed(1)) : null;
              let _wHomeExpRaw = null, _wAwayExpRaw = null, _wProjPace = null;
              if (_whOffRtg != null && _waDefRtg != null && _waOffRtg != null && _whDefRtg != null && _whp != null && _wap != null && _wlgPace != null && _wlgPace > 0) {
                _wProjPace = parseFloat(((_whp * _wap) / _wlgPace).toFixed(1));
                _wHomeExpRaw = (_whOffRtgAdj * _waDefRtg / (_wlgOffRtg * _wlgOffRtg)) * _wProjPace;
                _wAwayExpRaw = (_waOffRtgAdj * _whDefRtg / (_wlgOffRtg * _wlgOffRtg)) * _wProjPace;
              }
              // Regime-aware blend (same shape as NBA) — recency-weighted recent-score average
              // folded into the rating-based expected to track hot/cold form.
              const _whRecent = _recentTeamScoreMean(_gtScheduleMap, "wnba", homeTeam);
              const _waRecent = _recentTeamScoreMean(_gtScheduleMap, "wnba", awayTeam);
              let _wRegimeBlendW = 0;
              if (_whRecent && _waRecent && _wHomeExpRaw != null && _wAwayExpRaw != null) {
                const _wSample = Math.min(_whRecent.effectiveSample, _waRecent.effectiveSample);
                _wRegimeBlendW = _regimeBlendWeight(_wSample);
                _wHomeExpRaw = (1 - _wRegimeBlendW) * _wHomeExpRaw + _wRegimeBlendW * _whRecent.mean;
                _wAwayExpRaw = (1 - _wRegimeBlendW) * _wAwayExpRaw + _wRegimeBlendW * _waRecent.mean;
              }
              // H2H combined hit rate (last 10 H2H)
              const _wnbaH2H = (() => {
                const evts = _gtScheduleMap[`wnba:${homeTeam}`] ?? [];
                const h2h = evts.filter(ev => ev.comps.some(c => normTeam("wnba", c.abbr) === awayTeam)).slice(-10);
                if (h2h.length < 3) return null;
                const hits = h2h.filter(ev => ev.comps.reduce((s, c) => s + (c.score || 0), 0) >= threshold).length;
                return { rate: Math.round(hits / h2h.length * 100), games: h2h.length };
              })();
              const wnbaGtH2HRate = _wnbaH2H?.rate ?? null;
              const wnbaGtH2HGames = _wnbaH2H?.games ?? null;
              const _wnbaHomeOut = (wnbaInjuryMap.get(homeTeam) || []).length;
              const _wnbaAwayOut = (wnbaInjuryMap.get(awayTeam) || []).length;
              const _wCombOffRtg = (_whOffRtg != null && _waOffRtg != null) ? parseFloat(((_whOffRtg + _waOffRtg) / 2).toFixed(1)) : (_whOffRtg ?? _waOffRtg);
              const _wCombDefRtg = (_whDefRtg != null && _waDefRtg != null) ? parseFloat(((_whDefRtg + _waDefRtg) / 2).toFixed(1)) : (_whDefRtg ?? _waDefRtg);
              // WNBA SimScore tiers — calibrated to WNBA scoring environment:
              //   OffRtg ≥98 / ≥93 (NBA: ≥118 / ≥113)
              //   DefRtg same (defensive efficiency uses same rating scale)
              //   Pace ≥ leagueAvg+1 (smaller variance than NBA)
              //   O/U ≥ 168 / ≥ 158 (NBA: ≥225 / ≥215)
              const _wPacePts = (_whp == null || _wap == null || _wlgPace == null) ? 1 : (_whp > _wlgPace + 1 && _wap > _wlgPace + 1) ? 2 : (_whp > _wlgPace || _wap > _wlgPace) ? 1 : 0;
              const _wCombOffRtgPts = _wCombOffRtg == null ? 1 : _wCombOffRtg >= 98 ? 2 : _wCombOffRtg >= 93 ? 1 : 0;
              const _wCombDefRtgPts = _wCombDefRtg == null ? 1 : _wCombDefRtg >= 98 ? 2 : _wCombDefRtg >= 93 ? 1 : 0;
              const _wnbaGtH2HPts = wnbaGtH2HRate == null ? 1 : wnbaGtH2HRate >= 80 ? 2 : wnbaGtH2HRate >= 60 ? 1 : 0;
              const _wnbaOuPts = _wnbaOuLine == null ? 1 : _wnbaOuLine >= 168 ? 2 : _wnbaOuLine >= 158 ? 1 : 0;
              _simData = {
                homeOffRtg: _whOffRtg, awayOffRtg: _waOffRtg, homeOffRtgAdj: _whOffRtgAdj, awayOffRtgAdj: _waOffRtgAdj,
                homeDefRtg: _whDefRtg, awayDefRtg: _waDefRtg,
                combOffRtg: _wCombOffRtg, combDefRtg: _wCombDefRtg,
                homePace: _whp, awayPace: _wap, leagueAvgPace: _wlgPace, projPace: _wProjPace,
                gameOuLine: _wnbaOuLine, gameSpread: _wnbaGtSpread, wnbaGtH2HRate, wnbaGtH2HGames,
                homeOut: _wnbaHomeOut, awayOut: _wnbaAwayOut,
                homeUsageOut: _wHomeInjAdj.share, awayUsageOut: _wAwayInjAdj.share,
                ...(_wHomeInjAdj.adj < 1 && { homeOffRtgFactor: _wHomeInjAdj.adj }),
                ...(_wAwayInjAdj.adj < 1 && { awayOffRtgFactor: _wAwayInjAdj.adj }),
                ...(_wHomeB2B && { homeB2B: true, homeB2BFactor: _wHomeB2BFactor }),
                ...(_wAwayB2B && { awayB2B: true, awayB2BFactor: _wAwayB2BFactor }),
                combOffRtgPts: _wCombOffRtgPts, combDefRtgPts: _wCombDefRtgPts, pacePts: _wPacePts,
                wnbaGtH2HPts: _wnbaGtH2HPts, wnbaOuPts: _wnbaOuPts,
                homeExpected: _wHomeExpRaw != null ? parseFloat(_wHomeExpRaw.toFixed(1)) : null,
                awayExpected: _wAwayExpRaw != null ? parseFloat(_wAwayExpRaw.toFixed(1)) : null,
                expectedTotal: (_wHomeExpRaw != null && _wAwayExpRaw != null) ? parseFloat((_wHomeExpRaw + _wAwayExpRaw).toFixed(1)) : null
              };
              if (_wHomeExpRaw != null && _wAwayExpRaw != null) {
                const _dk = `wnba|${homeTeam}|${awayTeam}`;
                // Per-team std=11 (WNBA scoring variance is roughly NBA × (40/48) × scale factor;
                // empirically the game-total std runs ~13–15, so per-team std=11 produces ~15.6).
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNBATotalDist(_wHomeExpRaw, _wAwayExpRaw, 11, 11, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
                const _mlCtxKey = `${homeTeam}|${awayTeam}|${gameDate}`;
                if (!_wnbaMlContext[_mlCtxKey]) {
                  _wnbaMlContext[_mlCtxKey] = { homeTeam, awayTeam, gameDate, homeLambda: parseFloat(_wHomeExpRaw.toFixed(2)), awayLambda: parseFloat(_wAwayExpRaw.toFixed(2)), kalshiVolume, kalshiSpread, lowVolume, _simData: { ..._simData } };
                }
              }
              // Pre-sim mean blend (same pattern as NBA). Total std = sqrt(11^2 + 11^2) ≈ 15.6.
              const _gtWnbaSsn = (truePct != null && _wHomeExpRaw != null && _wAwayExpRaw != null) ? _gtSeasonHitRate("wnba", homeTeam, awayTeam, threshold) : null;
              if (_gtWnbaSsn != null) {
                const _w = _ssnBlendWeight(_gtWnbaSsn.sample);
                const _wTotalStd = Math.sqrt(11 * 11 + 11 * 11);
                const _modelMean = _wHomeExpRaw + _wAwayExpRaw;
                const _impliedMean = meanForNormalTail(threshold, _gtWnbaSsn.rate / 100, _wTotalStd);
                if (_impliedMean != null) {
                  const _cap = _GT_IMPLIED_CAP.wnba;
                  const _impliedClamped = Math.max(_modelMean - _cap, Math.min(_modelMean + _cap, _impliedMean));
                  const _blendedMean = (1 - _w) * _modelMean + _w * _impliedClamped;
                  _simData.modelTruePct = parseFloat(truePct.toFixed(1));
                  _simData.gtSeasonHitRate = _gtWnbaSsn.rate;
                  _simData.gtSsnSample = _gtWnbaSsn.sample;
                  _simData.modelMean = parseFloat(_modelMean.toFixed(2));
                  _simData.impliedMean = _impliedMean;
                  if (_impliedClamped !== _impliedMean) _simData.impliedMeanClamped = parseFloat(_impliedClamped.toFixed(2));
                  _simData.blendedMean = parseFloat(_blendedMean.toFixed(2));
                  truePct = parseFloat(((1 - normCDF(threshold - 0.5, _blendedMean, _wTotalStd)) * 100).toFixed(1));
                }
              }
              totalSimScore += _wCombOffRtgPts + _wCombDefRtgPts + _wPacePts + _wnbaGtH2HPts + _wnbaOuPts;
            } else if (sport === "nhl") {
              const homeGPG = nhlGPGMap[homeTeam] ?? null, awayGPG = nhlGPGMap[awayTeam] ?? null;
              const homeGAA = nhlGAAMap[homeTeam] ?? null, awayGAA = nhlGAAMap[awayTeam] ?? null;
              const _nhlOuLine = sportByteam.nhlGameOdds?.[homeTeam]?.total ?? sportByteam.nhlGameOdds?.[awayTeam]?.total ?? null;
              // Goalie-aware opponent factor: (1 - starterSV) / (1 - leagueAvgSV) is goals-allowed-per-shot
              // normalized to league. Falls back to team GAA ratio when starter SV% unavailable.
              const _homeGoalie = nhlGoalieByTeam[homeTeam] || null;
              const _awayGoalie = nhlGoalieByTeam[awayTeam] || null;
              const _gFactor = (goalie, teamGAA) => {
                if (goalie && goalie.starterSV != null && nhlLeagueAvgSV > 0 && nhlLeagueAvgSV < 1) {
                  return (1 - goalie.starterSV) / (1 - nhlLeagueAvgSV);
                }
                return teamGAA != null ? teamGAA / nhlLeagueAvgGAA : 1;
              };
              // B2B: a team on the second night of a B2B gives up more (goalie fatigue / backup more
              // likely). _homeFactor scales home's lambda via AWAY team's defense → if AWAY is on B2B,
              // their defense softens → _homeFactor *= 1.05 (home scores more). Vice versa for away.
              const _nhlHomeB2B = _isB2B(_gtScheduleMap, "nhl", homeTeam, gameDate);
              const _nhlAwayB2B = _isB2B(_gtScheduleMap, "nhl", awayTeam, gameDate);
              const _homeFactor = _gFactor(_awayGoalie, awayGAA) * (_nhlAwayB2B ? B2B_NHL : 1.0);
              const _awayFactor = _gFactor(_homeGoalie, homeGAA) * (_nhlHomeB2B ? B2B_NHL : 1.0);
              // Special teams: own PP% advantage + opp PK% weakness shift goal expectation.
              // PP+PK goals are ~20% of NHL scoring (NHL Stats 2024-25 league-wide), so a team
              // 5pp above league PP% facing a team 5pp below league PK% nets ~+2% goals — small
              // but real, and the model otherwise ignores special teams entirely. Clamped ±10%
              // so extreme mismatches don't run away. ST data caches in sportByteam.nhl.specialTeams.
              const _nhlST = sportByteam.nhl?.specialTeams || null;
              const _homePP = _nhlST?.byTeam?.[homeTeam]?.ppPct ?? null;
              const _awayPP = _nhlST?.byTeam?.[awayTeam]?.ppPct ?? null;
              const _homePK = _nhlST?.byTeam?.[homeTeam]?.pkPct ?? null;
              const _awayPK = _nhlST?.byTeam?.[awayTeam]?.pkPct ?? null;
              const _lgPP = _nhlST?.leaguePPPct ?? 0.21;
              const _lgPK = _nhlST?.leaguePKPct ?? 0.79;
              const _stWeight = 0.20;
              const _stClamp = (x) => Math.max(0.90, Math.min(1.10, x));
              const _homeSTAdj = (_homePP != null && _awayPK != null)
                ? _stClamp(1 + ((_homePP - _lgPP) + (_lgPK - _awayPK)) * _stWeight) : 1.0;
              const _awaySTAdj = (_awayPP != null && _homePK != null)
                ? _stClamp(1 + ((_awayPP - _lgPP) + (_lgPK - _homePK)) * _stWeight) : 1.0;
              let _hGLRaw = homeGPG != null ? Math.max(0.5, Math.min(8, homeGPG * _homeFactor * _homeSTAdj)) : null;
              let _aGLRaw = awayGPG != null ? Math.max(0.5, Math.min(8, awayGPG * _awayFactor * _awaySTAdj)) : null;
              // Regime-aware blend — each team's recency-weighted recent-goals average folded
              // into the goalie-adjusted GPG so the lambda tracks playoff/hot/cold form.
              const _nhlHomeRecent = _recentTeamScoreMean(_gtScheduleMap, "nhl", homeTeam);
              const _nhlAwayRecent = _recentTeamScoreMean(_gtScheduleMap, "nhl", awayTeam);
              let _nhlRegimeBlendW = 0;
              if (_nhlHomeRecent && _nhlAwayRecent && _hGLRaw != null && _aGLRaw != null) {
                const _nhlSample = Math.min(_nhlHomeRecent.effectiveSample, _nhlAwayRecent.effectiveSample);
                _nhlRegimeBlendW = _regimeBlendWeight(_nhlSample);
                _hGLRaw = (1 - _nhlRegimeBlendW) * _hGLRaw + _nhlRegimeBlendW * _nhlHomeRecent.mean;
                _aGLRaw = (1 - _nhlRegimeBlendW) * _aGLRaw + _nhlRegimeBlendW * _nhlAwayRecent.mean;
              }
              const _homeGoalieSource = _awayGoalie ? "starter" : "team";
              const _awayGoalieSource = _homeGoalie ? "starter" : "team";
              // NHL SimScore (max 10): homeGPG→0-2, awayGPG→0-2, homeGAA→0-2, awayGAA→0-2, O/U→0-2
              const _homeGpgPts = homeGPG == null ? 1 : homeGPG >= 3.5 ? 2 : homeGPG >= 3.0 ? 1 : 0;
              const _awayGpgPts = awayGPG == null ? 1 : awayGPG >= 3.5 ? 2 : awayGPG >= 3.0 ? 1 : 0;
              const _homeGaaPts = homeGAA == null ? 1 : homeGAA >= 3.5 ? 2 : homeGAA >= 3.0 ? 1 : 0;
              const _awayGaaPts = awayGAA == null ? 1 : awayGAA >= 3.5 ? 2 : awayGAA >= 3.0 ? 1 : 0;
              const _nhlOuPts = _nhlOuLine == null ? 1 : _nhlOuLine >= 7 ? 2 : _nhlOuLine >= 5.5 ? 1 : 0;
              // H2H combined hit rate (last 10 H2H) — same pattern as NBA/WNBA/MLB.
              const _nhlH2H = (() => {
                const evts = _gtScheduleMap[`nhl:${homeTeam}`] ?? [];
                const h2h = evts.filter(ev => ev.comps.some(c => normTeam("nhl", c.abbr) === awayTeam)).slice(-10);
                if (h2h.length < 3) return null;
                const hits = h2h.filter(ev => ev.comps.reduce((s, c) => s + (c.score || 0), 0) >= threshold).length;
                return { rate: Math.round(hits / h2h.length * 100), games: h2h.length };
              })();
              const nhlGtH2HRate = _nhlH2H?.rate ?? null;
              const nhlGtH2HGames = _nhlH2H?.games ?? null;
              _simData = {
                homeGPG, awayGPG, homeGAA, awayGAA,
                gameOuLine: _nhlOuLine, nhlGtH2HRate, nhlGtH2HGames,
                homeGpgPts: _homeGpgPts, awayGpgPts: _awayGpgPts, homeGaaPts: _homeGaaPts, awayGaaPts: _awayGaaPts, nhlOuPts: _nhlOuPts,
                homeGoalie: _homeGoalie?.starterName ?? null,
                awayGoalie: _awayGoalie?.starterName ?? null,
                homeGoalieSV: _homeGoalie?.starterSV ?? null,
                awayGoalieSV: _awayGoalie?.starterSV ?? null,
                homeGoalieSource: _homeGoalieSource,
                awayGoalieSource: _awayGoalieSource,
                leagueAvgSV: nhlLeagueAvgSV,
                ...(_nhlHomeB2B && { homeB2B: true }),
                ...(_nhlAwayB2B && { awayB2B: true }),
                ...(_homePP != null && { homePPPct: _homePP }),
                ...(_awayPP != null && { awayPPPct: _awayPP }),
                ...(_homePK != null && { homePKPct: _homePK }),
                ...(_awayPK != null && { awayPKPct: _awayPK }),
                ...(_homeSTAdj !== 1.0 && { homeSTAdj: parseFloat(_homeSTAdj.toFixed(3)) }),
                ...(_awaySTAdj !== 1.0 && { awaySTAdj: parseFloat(_awaySTAdj.toFixed(3)) }),
                homeExpected: _hGLRaw != null ? parseFloat(_hGLRaw.toFixed(2)) : null,
                awayExpected: _aGLRaw != null ? parseFloat(_aGLRaw.toFixed(2)) : null,
                expectedTotal: (_hGLRaw != null && _aGLRaw != null) ? parseFloat((_hGLRaw + _aGLRaw).toFixed(1)) : null
              };
              if (_hGLRaw != null && _aGLRaw != null) {
                const _dk = `nhl|${homeTeam}|${awayTeam}`;
                if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNHLTotalDist(_hGLRaw, _aGLRaw, 10000);
                truePct = totalDistPct(totalDistCache[_dk], threshold);
                const _mlCtxKey = `${homeTeam}|${awayTeam}|${gameDate}`;
                if (!_nhlMlContext[_mlCtxKey]) {
                  _nhlMlContext[_mlCtxKey] = { homeTeam, awayTeam, gameDate, homeLambda: parseFloat(_hGLRaw.toFixed(2)), awayLambda: parseFloat(_aGLRaw.toFixed(2)), kalshiVolume, kalshiSpread, lowVolume, _simData: { ..._simData } };
                }
              }
              // Same sample-weighted seasonHitRate blend as MLB/NBA. NHL Poisson tails are
              // particularly thin for high-scoring matchups (overdispersion from PP swings),
              // and there's no fatter-tail alternative wired in — blend is the practical correction.
              // Pre-sim lambda blend (Poisson, same as MLB).
              const _gtNhlSsn = (truePct != null && _hGLRaw != null && _aGLRaw != null) ? _gtSeasonHitRate("nhl", homeTeam, awayTeam, threshold) : null;
              if (_gtNhlSsn != null) {
                const _w = _ssnBlendWeight(_gtNhlSsn.sample);
                const _modelLambda = _hGLRaw + _aGLRaw;
                const _impliedLambda = lambdaForPoissonTail(threshold, _gtNhlSsn.rate / 100);
                if (_impliedLambda != null) {
                  const _cap = _GT_IMPLIED_CAP.nhl;
                  const _impliedClamped = Math.max(_modelLambda - _cap, Math.min(_modelLambda + _cap, _impliedLambda));
                  const _blendedLambda = (1 - _w) * _modelLambda + _w * _impliedClamped;
                  _simData.modelTruePct = parseFloat(truePct.toFixed(1));
                  _simData.gtSeasonHitRate = _gtNhlSsn.rate;
                  _simData.gtSsnSample = _gtNhlSsn.sample;
                  _simData.modelLambda = parseFloat(_modelLambda.toFixed(2));
                  _simData.impliedLambda = _impliedLambda;
                  if (_impliedClamped !== _impliedLambda) _simData.impliedLambdaClamped = parseFloat(_impliedClamped.toFixed(2));
                  _simData.blendedLambda = parseFloat(_blendedLambda.toFixed(2));
                  truePct = parseFloat(((1 - poissonCDF(threshold - 1, _blendedLambda)) * 100).toFixed(1));
                }
              }
              totalSimScore += _homeGpgPts + _awayGpgPts + _homeGaaPts + _awayGaaPts + _nhlOuPts;
            }
            // ── UNDER SimScore (inverted tiers — low values favor under) ──
            // _underComponents is spread into UNDER pushes to override the OVER-direction *Pts
            // fields inherited from _simData, so each pick's components reflect the bet direction.
            let underSimScore = 0;
            let _underComponents = {};
            if (sport === "mlb") {
              const { homeWHIP: _hW, awayWHIP: _aW, combinedRPG: _cRPG, gameOuLine, h2hTotalHitRate: _h2hTR } = _simData;
              const _uHomeWhipPts = _hW == null ? 1 : _hW <= 1.10 ? 2 : _hW <= 1.25 ? 1 : 0;
              const _uAwayWhipPts = _aW == null ? 1 : _aW <= 1.10 ? 2 : _aW <= 1.25 ? 1 : 0;
              const _uCombRpgPts = _cRPG == null ? 1 : _cRPG < 8.5 ? 2 : _cRPG <= 10.5 ? 1 : 0;
              const _uH2hTotalPts = _h2hTR == null ? 1 : _h2hTR <= 20 ? 2 : _h2hTR <= 40 ? 1 : 0;
              const _uMlbOuPts = gameOuLine == null ? 1 : gameOuLine < 7.5 ? 2 : gameOuLine < 9.5 ? 1 : 0;
              underSimScore = _uHomeWhipPts + _uAwayWhipPts + _uCombRpgPts + _uH2hTotalPts + _uMlbOuPts;
              _underComponents = { homeWhipPts: _uHomeWhipPts, awayWhipPts: _uAwayWhipPts, combinedRpgPts: _uCombRpgPts, h2hTotalPts: _uH2hTotalPts, mlbOuPts: _uMlbOuPts };
            } else if (sport === "nba") {
              // UNDER SimScore: inverted — weak offenses, strong defenses, slow pace, no H2H history of scoring, low O/U
              const { combOffRtg, combDefRtg, homePace, awayPace, leagueAvgPace, gameOuLine, nbaGtH2HRate: _nbaH2H } = _simData;
              const _uCombOffRtgPts = combOffRtg == null ? 1 : combOffRtg < 113 ? 2 : combOffRtg < 118 ? 1 : 0;
              const _uCombDefRtgPts = combDefRtg == null ? 1 : combDefRtg < 113 ? 2 : combDefRtg < 118 ? 1 : 0;
              const _uPacePts = (homePace == null || awayPace == null || leagueAvgPace == null) ? 1 : (homePace < leagueAvgPace - 2 && awayPace < leagueAvgPace - 2) ? 2 : (homePace < leagueAvgPace || awayPace < leagueAvgPace) ? 1 : 0;
              const _uNbaGtH2HPts = _nbaH2H == null ? 1 : _nbaH2H <= 30 ? 2 : _nbaH2H <= 50 ? 1 : 0;
              const _uNbaOuPts = gameOuLine == null ? 1 : gameOuLine < 215 ? 2 : gameOuLine < 225 ? 1 : 0;
              underSimScore = _uCombOffRtgPts + _uCombDefRtgPts + _uPacePts + _uNbaGtH2HPts + _uNbaOuPts;
              _underComponents = { combOffRtgPts: _uCombOffRtgPts, combDefRtgPts: _uCombDefRtgPts, pacePts: _uPacePts, nbaGtH2HPts: _uNbaGtH2HPts, nbaOuPts: _uNbaOuPts };
            } else if (sport === "wnba") {
              const { combOffRtg, combDefRtg, homePace, awayPace, leagueAvgPace, gameOuLine, wnbaGtH2HRate: _wH2H } = _simData;
              const _uCombOffRtgPts = combOffRtg == null ? 1 : combOffRtg < 93 ? 2 : combOffRtg < 98 ? 1 : 0;
              const _uCombDefRtgPts = combDefRtg == null ? 1 : combDefRtg < 93 ? 2 : combDefRtg < 98 ? 1 : 0;
              const _uPacePts = (homePace == null || awayPace == null || leagueAvgPace == null) ? 1 : (homePace < leagueAvgPace - 1 && awayPace < leagueAvgPace - 1) ? 2 : (homePace < leagueAvgPace || awayPace < leagueAvgPace) ? 1 : 0;
              const _uWnbaGtH2HPts = _wH2H == null ? 1 : _wH2H <= 30 ? 2 : _wH2H <= 50 ? 1 : 0;
              const _uWnbaOuPts = gameOuLine == null ? 1 : gameOuLine < 158 ? 2 : gameOuLine < 168 ? 1 : 0;
              underSimScore = _uCombOffRtgPts + _uCombDefRtgPts + _uPacePts + _uWnbaGtH2HPts + _uWnbaOuPts;
              _underComponents = { combOffRtgPts: _uCombOffRtgPts, combDefRtgPts: _uCombDefRtgPts, pacePts: _uPacePts, wnbaGtH2HPts: _uWnbaGtH2HPts, wnbaOuPts: _uWnbaOuPts };
            } else if (sport === "nhl") {
              const { homeGPG, awayGPG, homeGAA, awayGAA, gameOuLine } = _simData;
              const _uHomeGpgPts = homeGPG == null ? 1 : homeGPG < 3.0 ? 2 : homeGPG < 3.5 ? 1 : 0;
              const _uAwayGpgPts = awayGPG == null ? 1 : awayGPG < 3.0 ? 2 : awayGPG < 3.5 ? 1 : 0;
              const _uHomeGaaPts = homeGAA == null ? 1 : homeGAA < 3.0 ? 2 : homeGAA < 3.5 ? 1 : 0;
              const _uAwayGaaPts = awayGAA == null ? 1 : awayGAA < 3.0 ? 2 : awayGAA < 3.5 ? 1 : 0;
              const _uNhlOuPts = gameOuLine == null ? 1 : gameOuLine < 5.5 ? 2 : gameOuLine < 7 ? 1 : 0;
              underSimScore = _uHomeGpgPts + _uAwayGpgPts + _uHomeGaaPts + _uAwayGaaPts + _uNhlOuPts;
              _underComponents = { homeGpgPts: _uHomeGpgPts, awayGpgPts: _uAwayGpgPts, homeGaaPts: _uHomeGaaPts, awayGaaPts: _uAwayGaaPts, nhlOuPts: _uNhlOuPts };
            }
            if (truePct == null) {
              if (isDebug) dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, totalSimScore, underSimScore, reason: "no_simulation_data", ..._simData });
              continue;
            }
            const rawEdge = kalshiPct != null ? parseFloat((truePct - kalshiPct).toFixed(1)) : null;
            const noTruePct = parseFloat((100 - truePct).toFixed(1));
            // Real no_ask price flows through `_tmNoPct`. Fall back to 1 - kalshiPct only when
            // parse site couldn't fetch no_ask_dollars (older snap shape / missing field).
            const noKalshiPct = _tmNoPct ?? (100 - kalshiPct);
            const _rawUnderEdge = parseFloat((noTruePct - noKalshiPct).toFixed(1));
            // Raw edges (undampened). The MLB tail-distance edge dampener (0.7× when |thr - O/U| ≥ 3)
            // was removed 2026-05-15: it was a pre-calibration heuristic, and dataConfidence's new
            // threshold-distance penalty (modestlyFromLine / farFromLine) now handles tail-skepticism
            // at the gate level instead of in edge math. Re-introduce dampening only if the
            // 2026-05-27 calibration audit shows MLB tails systematically over-hit. See
            // [[project-mlb-tail-dampener-removal]].
            const overEdge = rawEdge ?? 0;
            const underEdge = _rawUnderEdge;
            const noKalshiAO = _tmNoAO ?? (noKalshiPct >= 50 ? Math.round(-(noKalshiPct/(100-noKalshiPct))*100) : Math.round((100-noKalshiPct)/noKalshiPct*100));
            const _gameTime = gameTimes[`${sport}:${homeTeam}:${gameDate}`] ?? gameTimes[`${sport}:${awayTeam}:${gameDate}`] ?? gameTimes[`${sport}:${homeTeam}`] ?? gameTimes[`${sport}:${awayTeam}`] ?? null;
            // MLB-only: both lineups confirmed = both teams have a posted lineup (in lineupSpotByName)
            // AND neither is in the projected-fallback set. Undefined for non-MLB so the badge hides.
            const _lineupsConfirmed = sport === "mlb"
              ? _mlbBothTeamsConfirmed(homeTeam, awayTeam, gameDate)
              : void 0;
            // OVER play — require kalshiPct in window so we don't bet OVERs against UNDER-favored
            // alt lines (e.g. over 12.5 priced at 19c — winning that bet at +426 demands a much
            // higher truePct than our OVER signal on a 7.5-line market).
            const _overInWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
            if (overEdge >= EDGE_GATE && _overInWindow) {
              totalPlays.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), rawEdge, edge: overEdge, totalSimScore, qualified: totalSimScore >= SIMSCORE_GATE, kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed, ..._simData });
            } else if (isDebug && _overInWindow) {
              dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), rawEdge, edge: overEdge, totalSimScore, lineupsConfirmed: _lineupsConfirmed, reason: "edge_too_low", ..._simData });
            }
            // UNDER play — mirror the OVER filter: require noKalshiPct >= 70 (YES <= 30)
            // so we only bet UNDERs the market also considers likely (same gate as OVERs).
            // Debug-dropped path matches team-totals: push every non-qualifying UNDER so the
            // market report shows a row for every market, not just those with edge ≥ 3%.
            if (underEdge >= EDGE_GATE && noKalshiPct >= KALSHI_GATE && noKalshiPct <= KALSHI_CAP) {
              totalPlays.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "under", kalshiPct, noKalshiPct, americanOdds: noKalshiAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, rawEdge, edge: underEdge, totalSimScore: underSimScore, qualified: underSimScore >= SIMSCORE_GATE, kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed, ..._simData, ..._underComponents });
            } else if (isDebug) {
              dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "under", kalshiPct, noKalshiPct, americanOdds: noKalshiAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, rawEdge, edge: underEdge, totalSimScore: underSimScore, lineupsConfirmed: _lineupsConfirmed, reason: noKalshiPct < KALSHI_GATE ? "under_no_price_too_low" : "edge_too_low", ..._simData, ..._underComponents });
            }
          }
        }
        {
          // Step 1: per-game dedup for game totals — qualified (simScore≥8) beats non-qualified; ties broken by edge
          const _totalBestMap = {};
          for (const tp of totalPlays) {
            const key = `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}`;
            const tpQ = tp.totalSimScore >= SIMSCORE_GATE;
            const prev = _totalBestMap[key];
            const prevQ = prev && (prev.totalSimScore >= SIMSCORE_GATE);
            if (!prev || (!prevQ && tpQ) || (prevQ === tpQ && tp.edge > prev.edge)) _totalBestMap[key] = tp;
          }
          const _bestTotalIds = new Set(Object.values(_totalBestMap).map(tp => `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}|${tp.threshold}|${tp.direction}`));
          // NOTE: team total cross-dedup applied after teamTotalPlays loop below
          for (const tp of totalPlays) {
            const isBest = _bestTotalIds.has(`${tp.sport}|${tp.homeTeam}|${tp.awayTeam}|${tp.threshold}|${tp.direction}`);
            plays.push(isBest ? tp : { ...tp, qualified: false });
          }
        }
        // ── Team Total plays (KXMLBTEAMTOTAL, KXNBATEAMTOTAL) ─────────────────────────────────────
        {
          const _MLB_ERA = 4.20;
          const teamTotalDistCache = {};
          const teamTotalPlays = [];
          // Pre-fetch ESPN team schedules for H2H hit rate computation (current + prior season, sequential fetches)
          const _ttScheduleMap = {};
          const _ttTeams = new Set(teamTotalMarkets.map(tm => `${tm.sport}:${tm.scoringTeam}`));
          await Promise.all([..._ttTeams].map(async key => {
            const [sp, abbr] = key.split(':');
            const cacheKey = `teamschedule:v3:${sp}:${abbr}`;
            let events = isBustCache ? null : await CACHE2?.get(cacheKey, "json").catch(() => null);
            if (!events) {
              try {
                const league = sp === 'mlb' ? 'baseball/mlb' : 'basketball/nba';
                const _ttEspnSlug = ({ mlb: { CWS: "CHW" } }[sp]?.[abbr] || abbr).toLowerCase();
                const base = `https://site.api.espn.com/apis/site/v2/sports/${league}/teams/${_ttEspnSlug}/schedule`;
                const r25 = await fetch(`${base}?season=2025`, { signal: AbortSignal.timeout(3000) });
                const ev25 = r25.ok ? _parseSchedEvts(await r25.json()) : [];
                const r26 = await fetch(base, { signal: AbortSignal.timeout(3000) });
                const ev26 = r26.ok ? _parseSchedEvts(await r26.json()) : [];
                events = [...ev25, ...ev26];
                if (events.length && CACHE2) await CACHE2.put(cacheKey, JSON.stringify(events), { expirationTtl: 3600 }).catch(() => {});
              } catch(e) {}
            }
            if (events) _ttScheduleMap[key] = events;
          }));
          const _ttH2HRate = (sport, scoringTeam, oppTeam, threshold) => {
            const events = _ttScheduleMap[`${sport}:${scoringTeam}`] ?? [];
            const h2h = events.filter(ev => ev.comps.some(c => normTeam(sport, c.abbr) === oppTeam)).slice(-10);
            if (h2h.length < 3) return null;
            const hits = h2h.filter(ev => { const mine = ev.comps.find(c => normTeam(sport, c.abbr) === scoringTeam); return mine && mine.score >= threshold; });
            return { rate: Math.round(hits.length / h2h.length * 100), games: h2h.length };
          };
          // B2B detection uses the module-scope _isB2B helper; team total passes _ttScheduleMap.
          const _ttVolumeMap = {};
          for (const tm of teamTotalMarkets) { const _ttgk = `${tm.sport}|${tm.gameTeam1}|${tm.gameTeam2}`; _ttVolumeMap[_ttgk] = (_ttVolumeMap[_ttgk] ?? 0) + (tm.kalshiVolume ?? 0); }
          for (const tm of teamTotalMarkets) {
            const { sport, stat, threshold, kalshiPct, americanOdds, noKalshiPct: _ttmNoPct, noKalshiAO: _ttmNoAO, gameTeam1, gameTeam2, scoringTeam, gameDate, kalshiSpread, kalshiVolume } = tm;
            if (gameDate && gameDate < cutoffStr) continue;
            const lowVolume = (_ttVolumeMap[`${sport}|${gameTeam1}|${gameTeam2}`] ?? 0) < 50;
            // Determine home/away (same correction logic as game total loop)
            let homeTeam = gameTeam1, awayTeam = gameTeam2;
            if (sport === "mlb" && sportByteam.mlb?.gameHomeTeams?.[gameTeam2]) { homeTeam = gameTeam2; awayTeam = gameTeam1; }
            else if (sport === "nba" && sportByteam.nbaGameScores) {
              for (const _gs of Object.values(sportByteam.nbaGameScores)) {
                if (_gs?.homeTeam === gameTeam2 && _gs?.awayTeam === gameTeam1) { homeTeam = gameTeam2; awayTeam = gameTeam1; break; }
              }
            }
            const isHome = scoringTeam === homeTeam;
            const oppTeam = isHome ? awayTeam : homeTeam;
            let truePct = null, teamTotalSimScore = 0;
            if (sport === "mlb") {
              const teamRPG = mlbRoadRPGMap[scoringTeam] ?? mlbRPGMap[scoringTeam] ?? null;
              const oppRPG = mlbRoadRPGMap[oppTeam] ?? mlbRPGMap[oppTeam] ?? null;
              // Lineup / pitcher injury adjustments (added 2026-05-18). Mirror of game-total logic:
              // scoring team gets a lineup-factor multiplier on its λ; opposing pitcher-IL nulls the
              // starter inputs so the lambda uses bullpen-only ERA.
              const _ttInjReport = sportByteam.mlb?.injuryByTeam || {};
              const _ttCountHitterOuts = (team) => {
                const list = _ttInjReport[team] || [];
                const pitcherId = sportByteam.mlb?.pitcherInfoByTeam?.[team]?.id ? String(sportByteam.mlb.pitcherInfoByTeam[team].id) : null;
                return list.filter(p => !(p.pos === "P" || p.pos === "SP" || p.pos === "RP" || (pitcherId && p.id === pitcherId))).length;
              };
              const _ttPitcherOnIL = (team) => {
                const list = _ttInjReport[team] || [];
                const pitcherId = sportByteam.mlb?.pitcherInfoByTeam?.[team]?.id ? String(sportByteam.mlb.pitcherInfoByTeam[team].id) : null;
                if (!pitcherId) return false;
                return list.some(p => p.id === pitcherId && (p.status === "out" || p.status === "gtd"));
              };
              const _ttLineupFactor = (n) => n === 0 ? 1.0 : n === 1 ? 0.98 : n === 2 ? 0.96 : 0.93;
              const scoringTopOut = _ttCountHitterOuts(scoringTeam);
              const lineupFactor = _ttLineupFactor(scoringTopOut);
              const oppPitcherOnIL = _ttPitcherOnIL(oppTeam);
              const oppERA = oppPitcherOnIL ? null : (sportByteam.mlb?.pitcherEra?.[oppTeam] ?? sportByteam.mlb?.probables?.[oppTeam]?.era ?? null);
              const oppFIP = oppPitcherOnIL ? null : (sportByteam.mlb?.pitcherFIPByTeam?.[oppTeam] ?? null);
              const oppTeamERA = mlbTeamERAMap[oppTeam] ?? null;
              // Bullpen ERA replaces whole-staff teamERA in the 40% rest-of-game share (same rationale
              // as game-total lambda — whole-staff double-counts the starter).
              const _oppBullpenERA = mlbBullpenERAMap[oppTeam] ?? null;
              const oppBullpenSource = _oppBullpenERA != null ? "bullpen" : (oppTeamERA != null ? "team" : null);
              const _oppRestERA = _oppBullpenERA ?? oppTeamERA ?? null;
              const parkRF = PARK_RUNFACTOR[homeTeam] ?? 1;
              const gameOuLine = sportByteam.mlb?.gameOdds?.[homeTeam]?.total ?? sportByteam.mlb?.gameOdds?.[awayTeam]?.total ?? null;
              // Starter WHIP (resolved early so it can feed the starter mult).
              const oppStarterWHIP = oppPitcherOnIL ? null : (sportByteam.mlb?.pitcherWHIPByTeam?.[oppTeam] ?? null);
              const oppWHIP = oppStarterWHIP ?? mlbTeamWHIPMap[oppTeam] ?? null;
              const oppWHIPSource = oppStarterWHIP != null ? "starter" : (mlbTeamWHIPMap[oppTeam] != null ? "team" : null);
              // Starter component: 50/50 FIP/ERA blend × WHIP traffic factor (exp=0.5 dampens overlap with ERA).
              const _LG_WHIP_TT = 1.30;
              const _ttWhipAdj = oppWHIP != null ? Math.max(0.90, Math.min(1.10, Math.pow(oppWHIP / _LG_WHIP_TT, 0.5))) : 1.0;
              const _oppErafip = oppFIP != null && oppERA != null ? 0.5*(oppFIP/_MLB_ERA) + 0.5*(oppERA/_MLB_ERA)
                : oppFIP != null ? oppFIP/_MLB_ERA
                : oppERA != null ? oppERA/_MLB_ERA
                : null;
              const _oppStarter = _oppErafip != null ? _oppErafip * _ttWhipAdj : null;
              const _oppMult = _oppStarter != null && _oppRestERA != null ? 0.6*_oppStarter + 0.4*(_oppRestERA/_MLB_ERA) : _oppStarter != null ? _oppStarter : _oppRestERA != null ? _oppRestERA/_MLB_ERA : 1;
              const _ttPlatoonMap = sportByteam.mlb?.teamPlatoonRPGMap ?? {};
              const _ttOppStarterHand = sportByteam.mlb?.pitcherHand?.[oppTeam] ?? null;
              const _ttPlatCode = _ttOppStarterHand === 'L' ? 'vl' : _ttOppStarterHand === 'R' ? 'vr' : null;
              const _ttPlatFactor = (_ttPlatCode && _ttPlatoonMap[scoringTeam]?.[_ttPlatCode])
                ? _ttPlatoonMap[scoringTeam][_ttPlatCode] : 1.0;
              const _ttWData = weatherByGame[`${homeTeam}|${awayTeam}`] ?? null;
              const _ttWeatherFactor = (_ttWData?.windOutMph != null && !_MLB_DOMED.has(homeTeam))
                ? parseFloat((Math.max(0.85, Math.min(1.15, 1 + _ttWData.windOutMph * 0.013 + ((_ttWData.temp ?? 72) - 72) * 0.001))).toFixed(3))
                : 1.0;
              // Umpire run factor (independent env signal — loose zone → more scoring); applied to lambda
              const _ttUmpKey = `${homeTeam}|${awayTeam}`;
              const _ttUmpName = sportByteam.mlb?.umpireByGame?.[_ttUmpKey] ?? null;
              const _normTTUmp = n => n?.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
              const _ttUmpKF = _ttUmpName ? (UMPIRE_KFACTOR[_normTTUmp(_ttUmpName)] ?? 1.0) : 1.0;
              const _ttUmpRunFactor = parseFloat((1 / _ttUmpKF).toFixed(3));
              // Note: umpire factor adjusts the lambda (so it's reflected in truePct) but is
              // intentionally not a separate SimScore component to avoid double-counting.
              const _lam = teamRPG != null ? parseFloat((Math.max(0.5, Math.min(12, teamRPG * _oppMult * parkRF * _ttPlatFactor * _ttWeatherFactor * _ttUmpRunFactor * lineupFactor))).toFixed(2)) : null;
              if (_lam != null) {
                const _dk = `mlb|team|${scoringTeam}|${oppTeam}`;
                if (!teamTotalDistCache[_dk]) teamTotalDistCache[_dk] = simulateTeamTotalDist(_lam, 10000);
                truePct = totalDistPct(teamTotalDistCache[_dk], threshold);
              }
              // WHIP is now folded into _oppStarter above (line ~4585). SimScore tier kept for display continuity.
              const ttWhipPts = oppWHIP == null ? 1 : oppWHIP > 1.35 ? 2 : oppWHIP > 1.20 ? 1 : 0;
              // L10 RPG — computed from already-fetched team schedule (same cache as H2H)
              const _ttSched = _ttScheduleMap[`mlb:${scoringTeam}`] || [];
              const _ttLast10 = _ttSched.slice(-10);
              const _ttRunVals = _ttLast10.map(ev => ev.comps?.find(c => normTeam("mlb", c.abbr) === scoringTeam)?.score ?? null).filter(v => v !== null && !isNaN(v));
              const teamL10RPG = _ttRunVals.length >= 5 ? parseFloat((_ttRunVals.reduce((a, b) => a + b, 0) / _ttRunVals.length).toFixed(2)) : null;
              const ttL10Pts = teamL10RPG == null ? 1 : teamL10RPG > 5.0 ? 2 : teamL10RPG > 4.0 ? 1 : 0;
              // Season hit rate: scoring team's rate of scoring >= threshold across all completed season games
              const _ttSeasonHits = _ttSched.filter(ev => { const mine = ev.comps.find(c => normTeam("mlb", c.abbr) === scoringTeam); return mine && mine.score >= threshold; });
              const ttSeasonHitRate = _ttSched.length >= 5 ? Math.round(_ttSeasonHits.length / _ttSched.length * 100) : null;
              const ttSeasonHitRatePts = ttSeasonHitRate == null ? 1 : ttSeasonHitRate >= 80 ? 2 : ttSeasonHitRate >= 60 ? 1 : 0;
              // Pre-sim lambda blend (Poisson). Solve for the rate that would give the observed
              // ttSeasonHitRate at this threshold; sample-weighted blend with model lambda.
              // Cleaner attribution than post-sim — seasonHitRate is a lambda input now.
              const _ttModelTruePct = truePct;
              let _ttImpliedLambda = null, _ttBlendedLambda = null, _ttImpliedLambdaClamped = null;
              if (truePct != null && ttSeasonHitRate != null && _lam != null) {
                const _w = Math.min(1, _ttSched.length / 40) * 0.7;
                _ttImpliedLambda = lambdaForPoissonTail(threshold, ttSeasonHitRate / 100);
                if (_ttImpliedLambda != null) {
                  const _cap = _TT_IMPLIED_CAP.mlb;
                  const _impliedClamped = Math.max(_lam - _cap, Math.min(_lam + _cap, _ttImpliedLambda));
                  if (_impliedClamped !== _ttImpliedLambda) _ttImpliedLambdaClamped = parseFloat(_impliedClamped.toFixed(2));
                  _ttBlendedLambda = parseFloat(((1 - _w) * _lam + _w * _impliedClamped).toFixed(2));
                  truePct = parseFloat(((1 - poissonCDF(threshold - 1, _ttBlendedLambda)) * 100).toFixed(1));
                }
              }
              const _h2h = _ttH2HRate("mlb", scoringTeam, oppTeam, threshold);
              const h2hHitRate = _h2h?.rate ?? null;
              const h2hGames = _h2h?.games ?? null;
              const h2hHitRatePts = h2hHitRate == null ? 1 : h2hHitRate >= 80 ? 2 : h2hHitRate >= 60 ? 1 : 0;
              const ttOuPts = gameOuLine == null ? 1 : gameOuLine >= 9.5 ? 2 : gameOuLine >= 7.5 ? 1 : 0;
              teamTotalSimScore += ttSeasonHitRatePts + ttWhipPts + ttL10Pts + h2hHitRatePts + ttOuPts;
              if (truePct == null) { if (isDebug) dropped.push({ gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, teamTotalSimScore, teamRPG, oppERA, oppFIP, oppWHIP, ...(oppWHIPSource && { oppWHIPSource }), oppBullpenERA: _oppRestERA, ...(oppBullpenSource && { oppBullpenSource }), oppRPG, parkFactor: parkRF, gameOuLine, h2hHitRate, h2hGames, h2hHitRatePts, teamL10RPG, ttL10Pts, ttWhipPts, ttOuPts, ttSeasonHitRate, ttSeasonHitRatePts, umpireName: _ttUmpName, reason: "no_simulation_data" }); continue; }
              const _ttGameTime = gameTimes[`${sport}:${homeTeam}:${gameDate}`] ?? gameTimes[`${sport}:${awayTeam}:${gameDate}`] ?? gameTimes[`${sport}:${homeTeam}`] ?? gameTimes[`${sport}:${awayTeam}`] ?? null;
              // Both lineups confirmed (MLB only): scoringTeam + oppTeam each have a posted lineup, neither projected.
              const _ttLineupsConfirmed = _mlbBothTeamsConfirmed(scoringTeam, oppTeam, gameDate);
              const _ttBaseFields = { gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), ...(_ttModelTruePct != null && _ttModelTruePct !== truePct && { modelTruePct: parseFloat(_ttModelTruePct.toFixed(1)) }), ...(_ttImpliedLambda != null && { ttImpliedLambda: _ttImpliedLambda, ttBlendedLambda: _ttBlendedLambda }), ...(_ttImpliedLambdaClamped != null && { ttImpliedLambdaClamped: _ttImpliedLambdaClamped }), kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _ttGameTime, lineupsConfirmed: _ttLineupsConfirmed, teamRPG, oppERA, oppFIP, oppWHIP, ...(oppWHIPSource && { oppWHIPSource }), oppBullpenERA: _oppRestERA, ...(oppBullpenSource && { oppBullpenSource }), oppRPG, parkFactor: parkRF, gameOuLine, teamExpected: _lam != null ? parseFloat(_lam.toFixed(1)) : null, h2hHitRate, h2hGames, h2hHitRatePts, teamL10RPG, ttL10Pts, ttWhipPts, ttOuPts, umpireRunFactor: _ttUmpRunFactor, ...(_ttUmpName && { umpireName: _ttUmpName }), ttSeasonHitRate, ttSeasonHitRatePts, oppStarterHand: _ttOppStarterHand, ...(_ttPlatFactor !== 1.0 && { platoonFactor: _ttPlatFactor }), ...(scoringTopOut > 0 && { scoringTopOut, scoringLineupFactor: lineupFactor }), ...(oppPitcherOnIL && { oppPitcherOnIL: true }) };
              const rawEdge = parseFloat((truePct - kalshiPct).toFixed(1));
              const edge = rawEdge;
              const _ttOverInWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && _ttOverInWindow) {
                teamTotalPlays.push({ ..._ttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, qualified: teamTotalSimScore >= SIMSCORE_GATE });
              } else if (isDebug && _ttOverInWindow) {
                dropped.push({ ..._ttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, reason: "edge_too_low" });
              }
              // UNDER play — use real no_ask price flowed through from the parse site.
              // Pre-2026-05-15 this synthesized noPct from 1 - kalshiPct, which underpriced
              // UNDERs by the Kalshi YES/NO spread (~3–7 cents). See CLAUDE.md "Kalshi UNDER pricing".
              const _ttNoTruePct = parseFloat((100 - truePct).toFixed(1));
              const _ttNoKalshiPct = _ttmNoPct ?? (100 - kalshiPct);
              const _ttUnderEdge = parseFloat((_ttNoTruePct - _ttNoKalshiPct).toFixed(1));
              const _ttNoKalshiAO = _ttmNoAO ?? (_ttNoKalshiPct >= 50 ? Math.round(-(_ttNoKalshiPct/(100-_ttNoKalshiPct))*100) : Math.round((100-_ttNoKalshiPct)/_ttNoKalshiPct*100));
              const _uTtSeasonHitRatePts = ttSeasonHitRate == null ? 1 : ttSeasonHitRate <= 20 ? 2 : ttSeasonHitRate <= 40 ? 1 : 0;
              const _uTtWhipPts = oppWHIP == null ? 1 : oppWHIP <= 1.10 ? 2 : oppWHIP <= 1.25 ? 1 : 0;
              const _uTtL10Pts = teamL10RPG == null ? 1 : teamL10RPG <= 3.5 ? 2 : teamL10RPG <= 4.5 ? 1 : 0;
              const _uH2hHitRatePts = h2hHitRate == null ? 1 : h2hHitRate <= 30 ? 2 : h2hHitRate <= 50 ? 1 : 0;
              const _uTtOuPts = gameOuLine == null ? 1 : gameOuLine < 7.5 ? 2 : gameOuLine < 9.5 ? 1 : 0;
              const _ttUnderSimScore = _uTtSeasonHitRatePts + _uTtWhipPts + _uTtL10Pts + _uH2hHitRatePts + _uTtOuPts;
              const _ttUnderComponents = { ttSeasonHitRatePts: _uTtSeasonHitRatePts, ttWhipPts: _uTtWhipPts, ttL10Pts: _uTtL10Pts, h2hHitRatePts: _uH2hHitRatePts, ttOuPts: _uTtOuPts };
              if (_ttUnderEdge >= EDGE_GATE && _ttNoKalshiPct >= KALSHI_GATE && _ttNoKalshiPct <= KALSHI_CAP) {
                teamTotalPlays.push({ ..._ttBaseFields, ..._ttUnderComponents, direction: "under", noTruePct: _ttNoTruePct, noKalshiPct: _ttNoKalshiPct, americanOdds: _ttNoKalshiAO, edge: _ttUnderEdge, rawEdge: _ttUnderEdge, teamTotalSimScore: _ttUnderSimScore, qualified: _ttUnderSimScore >= SIMSCORE_GATE });
              } else if (isDebug) {
                dropped.push({ ..._ttBaseFields, ..._ttUnderComponents, direction: "under", noTruePct: _ttNoTruePct, noKalshiPct: _ttNoKalshiPct, americanOdds: _ttNoKalshiAO, edge: _ttUnderEdge, teamTotalSimScore: _ttUnderSimScore, reason: _ttNoKalshiPct < KALSHI_GATE ? "under_no_price_too_low" : "edge_too_low" });
              }
            } else if (sport === "nba") {
              const nbaDefRank = STAT_SOFT["nba|points"]?.rankMap ?? {};
              const nbaAvgDef = leagueAvgCache["nba|points"] ?? nbaLeagueAvgOffPPG;
              const _nbaOuLine = sportByteam.nbaGameOdds?.[homeTeam]?.total ?? sportByteam.nbaGameOdds?.[awayTeam]?.total ?? null;
              const _gameSpread = sportByteam.nbaGameOdds?.[homeTeam]?.spread ?? sportByteam.nbaGameOdds?.[awayTeam]?.spread ?? null;
              // OffRtg (pace-adjusted) from nbaPaceData; DefRtg computed from PPG-allowed / pace
              const teamOffRtg = nbaPaceData?.teamOffRtg?.[scoringTeam] ?? null;
              const _oppPaceNba = nbaPaceData?.teamPace?.[oppTeam] ?? null;
              const oppDefPPGNba = nbaDefRank[oppTeam]?.value ?? null;
              const oppDefRtg = (oppDefPPGNba != null && _oppPaceNba != null && _oppPaceNba > 0) ? parseFloat((oppDefPPGNba / _oppPaceNba * 100).toFixed(1)) : null;
              // Injury adjustment for scoring team's OffRtg (mirrors NBA game total).
              const _ttScoringInjAdj = _injuryOffRtgAdj(scoringTeam, nbaInjuryMap, nbaUsageMap, _NBAshortNorm);
              const _ttScoringB2B = _isB2B(_ttScheduleMap, "nba", scoringTeam, gameDate);
              const _ttScoringB2BFactor = _ttScoringB2B ? B2B_NBA : 1.0;
              const _teamOffRtgAdj = teamOffRtg != null ? parseFloat((teamOffRtg * _ttScoringInjAdj.adj * _ttScoringB2BFactor).toFixed(1)) : null;
              // Simulation: OffRtg-based projection when available, fall back to PPG
              const _teamPaceNba = nbaPaceData?.teamPace?.[scoringTeam] ?? null;
              const _lgPaceNba = nbaPaceData?.leagueAvgPace ?? null;
              const _lgOffRtgNba = nbaPaceData?.leagueAvgOffRtg ?? 113.0;
              let _teamExpected = null;
              if (teamOffRtg != null && oppDefRtg != null && _teamPaceNba != null && _oppPaceNba != null && _lgPaceNba != null && _lgPaceNba > 0) {
                const _projPaceNba = (_teamPaceNba * _oppPaceNba) / _lgPaceNba;
                _teamExpected = (_teamOffRtgAdj * oppDefRtg / (_lgOffRtgNba * _lgOffRtgNba)) * _projPaceNba;
              } else {
                const teamOff = nbaOffPPGMap[scoringTeam] ?? null;
                const oppDef = nbaDefRank[oppTeam]?.value ?? null;
                const _teamOffPPGAdj = teamOff != null ? teamOff * _ttScoringInjAdj.adj : null;
                if (_teamOffPPGAdj != null) _teamExpected = _teamOffPPGAdj * (oppDef != null && nbaAvgDef ? oppDef / nbaAvgDef : 1);
              }
              // Same regime-aware blend as NBA game totals — scoring team's recent-form
              // average (recency-weighted) blends into the rating-based expected.
              const _ttIsPlayoff = Object.values(sportByteam.nbaGameScores || {}).some(g =>
                g?.seriesSummary && (g.homeTeam === scoringTeam || g.awayTeam === scoringTeam || g.homeTeam === oppTeam || g.awayTeam === oppTeam)
              );
              const _ttRecent = _recentTeamScoreMean(_ttScheduleMap, "nba", scoringTeam);
              let _ttRegimeBlendW = 0;
              if (_ttRecent && _teamExpected != null) {
                _ttRegimeBlendW = _regimeBlendWeight(_ttRecent.effectiveSample);
                _teamExpected = (1 - _ttRegimeBlendW) * _teamExpected + _ttRegimeBlendW * _ttRecent.mean;
              }
              if (_teamExpected != null) {
                const _dk = `nba|team|${scoringTeam}|${oppTeam}`;
                if (!teamTotalDistCache[_dk]) teamTotalDistCache[_dk] = simulateTeamPtsDist(_teamExpected, 11, 10000);
                truePct = totalDistPct(teamTotalDistCache[_dk], threshold);
              }
              // Season HR%: scoring team's rate of scoring >= threshold this season
              const _ttNbaSched = _ttScheduleMap[`nba:${scoringTeam}`] || [];
              const _ttNbaSeasonHits = _ttNbaSched.filter(ev => { const mine = ev.comps.find(c => normTeam("nba", c.abbr) === scoringTeam); return mine && mine.score >= threshold; });
              const ttNbaSeasonHitRate = _ttNbaSched.length >= 5 ? Math.round(_ttNbaSeasonHits.length / _ttNbaSched.length * 100) : null;
              const ttNbaSeasonHitRatePts = ttNbaSeasonHitRate == null ? 1 : ttNbaSeasonHitRate >= 80 ? 2 : ttNbaSeasonHitRate >= 60 ? 1 : 0;
              // Pre-sim mean blend (Normal). Single-team std=11 for NBA. Same lambda-blend
              // attribution pattern as game totals.
              let _ttNbaModelTruePct = null, _ttNbaImpliedMean = null, _ttNbaBlendedMean = null, _ttNbaImpliedMeanClamped = null;
              if (truePct != null && ttNbaSeasonHitRate != null && _teamExpected != null) {
                _ttNbaModelTruePct = parseFloat(truePct.toFixed(1));
                const _w = Math.min(1, _ttNbaSched.length / 40) * 0.7;
                _ttNbaImpliedMean = meanForNormalTail(threshold, ttNbaSeasonHitRate / 100, 11);
                if (_ttNbaImpliedMean != null) {
                  const _cap = _TT_IMPLIED_CAP.nba;
                  const _impliedClamped = Math.max(_teamExpected - _cap, Math.min(_teamExpected + _cap, _ttNbaImpliedMean));
                  if (_impliedClamped !== _ttNbaImpliedMean) _ttNbaImpliedMeanClamped = parseFloat(_impliedClamped.toFixed(2));
                  _ttNbaBlendedMean = parseFloat(((1 - _w) * _teamExpected + _w * _impliedClamped).toFixed(2));
                  truePct = parseFloat(((1 - normCDF(threshold - 0.5, _ttNbaBlendedMean, 11)) * 100).toFixed(1));
                }
              }
              const _h2h = _ttH2HRate("nba", scoringTeam, oppTeam, threshold);
              const h2hHitRate = _h2h?.rate ?? null;
              const h2hGames = _h2h?.games ?? null;
              const h2hHitRatePts = h2hHitRate == null ? 1 : h2hHitRate >= 80 ? 2 : h2hHitRate >= 60 ? 1 : 0;
              // SimScore (max 10): OffRtg→0-2, oppDefRtg→0-2, Season HR%→0-2, H2H HR%→0-2, O/U→0-2
              const ttOffRtgPts = teamOffRtg == null ? 1 : teamOffRtg >= 118 ? 2 : teamOffRtg >= 113 ? 1 : 0;
              const ttDefRtgPts = oppDefRtg == null ? 1 : oppDefRtg >= 118 ? 2 : oppDefRtg >= 113 ? 1 : 0;
              const ttNbaOuPts = _nbaOuLine == null ? 1 : _nbaOuLine >= 225 ? 2 : _nbaOuLine >= 215 ? 1 : 0;
              teamTotalSimScore += ttOffRtgPts + ttDefRtgPts + ttNbaSeasonHitRatePts + h2hHitRatePts + ttNbaOuPts;
              if (truePct == null) { if (isDebug) dropped.push({ gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, teamTotalSimScore, teamOffRtg, oppDefRtg, ttOffRtgPts, ttDefRtgPts, ttNbaOuPts, gameOuLine: _nbaOuLine, h2hHitRate, h2hGames, h2hHitRatePts, ttNbaSeasonHitRate, ttNbaSeasonHitRatePts, reason: "no_simulation_data" }); continue; }
              const _nttGameTime = gameTimes[`${sport}:${homeTeam}:${gameDate}`] ?? gameTimes[`${sport}:${awayTeam}:${gameDate}`] ?? gameTimes[`${sport}:${homeTeam}`] ?? gameTimes[`${sport}:${awayTeam}`] ?? null;
              // Pace + injury surfacing for the lambda inputs panel. Pace is the projected joint
              // pace minus league average (matches the game-total convention). Injuries reported
              // as scoring team's outs / opponent's outs separately so the user can see direction
              // (scoring team injured = bad for the team total; opp injured = good).
              const _ttNbaProjPace = (_teamPaceNba != null && _oppPaceNba != null && _lgPaceNba != null && _lgPaceNba > 0)
                ? parseFloat(((_teamPaceNba * _oppPaceNba) / _lgPaceNba).toFixed(1))
                : null;
              const _ttScoringOut = (nbaInjuryMap.get(scoringTeam) || []).length;
              const _ttOppOut = (nbaInjuryMap.get(oppTeam) || []).length;
              const _nttBaseFields = { gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), ...(_ttNbaModelTruePct != null && _ttNbaModelTruePct !== truePct && { modelTruePct: _ttNbaModelTruePct }), ...(_ttNbaImpliedMean != null && { ttNbaImpliedMean: _ttNbaImpliedMean, ttNbaBlendedMean: _ttNbaBlendedMean }), ...(_ttNbaImpliedMeanClamped != null && { ttNbaImpliedMeanClamped: _ttNbaImpliedMeanClamped }), kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _nttGameTime, teamOffRtg, teamOffRtgAdj: _teamOffRtgAdj, oppDefRtg, teamExpected: _teamExpected != null ? parseFloat(_teamExpected.toFixed(1)) : null, gameOuLine: _nbaOuLine, gameSpread: _gameSpread, projPace: _ttNbaProjPace, leagueAvgPace: _lgPaceNba, scoringOut: _ttScoringOut, oppOut: _ttOppOut, scoringUsageOut: _ttScoringInjAdj.share, ...(_ttScoringInjAdj.adj < 1 && { scoringOffRtgFactor: _ttScoringInjAdj.adj }), ...(_ttScoringB2B && { scoringB2B: true, scoringB2BFactor: _ttScoringB2BFactor }), h2hHitRate, h2hGames, h2hHitRatePts, ttNbaSeasonHitRate, ttNbaSeasonHitRatePts, ttOffRtgPts, ttDefRtgPts, ttNbaOuPts, ...(_ttIsPlayoff && { isPlayoff: true }), ...(_ttRegimeBlendW > 0 && { regimeBlendW: parseFloat(_ttRegimeBlendW.toFixed(2)), scoringRecentMean: parseFloat(_ttRecent.mean.toFixed(1)) }) };
              const rawEdge = parseFloat((truePct - kalshiPct).toFixed(1));
              const edge = rawEdge;
              const _nttOverInWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && _nttOverInWindow) {
                teamTotalPlays.push({ ..._nttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, qualified: teamTotalSimScore >= SIMSCORE_GATE });
              } else if (isDebug && _nttOverInWindow) {
                dropped.push({ ..._nttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, reason: "edge_too_low" });
              }
              // UNDER play — same real-no_ask correction as MLB team total UNDER above.
              const _nttNoTruePct = parseFloat((100 - truePct).toFixed(1));
              const _nttNoKalshiPct = _ttmNoPct ?? (100 - kalshiPct);
              const _nttUnderEdge = parseFloat((_nttNoTruePct - _nttNoKalshiPct).toFixed(1));
              const _nttNoKalshiAO = _ttmNoAO ?? (_nttNoKalshiPct >= 50 ? Math.round(-(_nttNoKalshiPct/(100-_nttNoKalshiPct))*100) : Math.round((100-_nttNoKalshiPct)/_nttNoKalshiPct*100));
              const _uTtOffRtgPts = teamOffRtg == null ? 1 : teamOffRtg < 113 ? 2 : teamOffRtg < 118 ? 1 : 0;
              const _uTtDefRtgPts = oppDefRtg == null ? 1 : oppDefRtg < 113 ? 2 : oppDefRtg < 118 ? 1 : 0;
              const _uTtNbaSeasonHitRatePts = ttNbaSeasonHitRate == null ? 1 : ttNbaSeasonHitRate <= 20 ? 2 : ttNbaSeasonHitRate <= 40 ? 1 : 0;
              const _uNbaH2hHitRatePts = h2hHitRate == null ? 1 : h2hHitRate <= 30 ? 2 : h2hHitRate <= 50 ? 1 : 0;
              const _uTtNbaOuPts = _nbaOuLine == null ? 1 : _nbaOuLine < 215 ? 2 : _nbaOuLine < 225 ? 1 : 0;
              const _nttUnderSimScore = _uTtOffRtgPts + _uTtDefRtgPts + _uTtNbaSeasonHitRatePts + _uNbaH2hHitRatePts + _uTtNbaOuPts;
              const _nttUnderComponents = { ttOffRtgPts: _uTtOffRtgPts, ttDefRtgPts: _uTtDefRtgPts, ttNbaSeasonHitRatePts: _uTtNbaSeasonHitRatePts, h2hHitRatePts: _uNbaH2hHitRatePts, ttNbaOuPts: _uTtNbaOuPts };
              if (_nttUnderEdge >= EDGE_GATE && _nttNoKalshiPct >= KALSHI_GATE && _nttNoKalshiPct <= KALSHI_CAP) {
                teamTotalPlays.push({ ..._nttBaseFields, ..._nttUnderComponents, direction: "under", noTruePct: _nttNoTruePct, noKalshiPct: _nttNoKalshiPct, americanOdds: _nttNoKalshiAO, edge: _nttUnderEdge, rawEdge: _nttUnderEdge, teamTotalSimScore: _nttUnderSimScore, qualified: _nttUnderSimScore >= SIMSCORE_GATE });
              } else if (isDebug) {
                dropped.push({ ..._nttBaseFields, ..._nttUnderComponents, direction: "under", noTruePct: _nttNoTruePct, noKalshiPct: _nttNoKalshiPct, americanOdds: _nttNoKalshiAO, edge: _nttUnderEdge, teamTotalSimScore: _nttUnderSimScore, reason: _nttNoKalshiPct < KALSHI_GATE ? "under_no_price_too_low" : "edge_too_low" });
              }
            }
          }
          // Dedup: one play per scoringTeam+oppTeam+direction (qualified plays win over non-qualified; edge breaks ties within same tier)
          const _ttBestMap = {};
          for (const tp of teamTotalPlays) {
            const key = `${tp.sport}|${tp.scoringTeam}|${tp.oppTeam}|${tp.direction}`;
            const prev = _ttBestMap[key];
            const tpQ = tp.qualified !== false;
            const prevQ = prev && prev.qualified !== false;
            if (!prev || (!prevQ && tpQ) || (prevQ === tpQ && tp.edge > prev.edge)) _ttBestMap[key] = tp;
          }
          const _ttBestIds = new Set(Object.values(_ttBestMap).map(tp => `${tp.sport}|${tp.scoringTeam}|${tp.oppTeam}|${tp.threshold}|${tp.direction}`));
          // Cross-type dedup: one qualified play per game across game totals AND team totals
          // Qualified (simScore≥8) always beats non-qualified; ties broken by edge
          const _crossBestMap = {};
          for (const tp of [...Object.values(_ttBestMap)]) {
            const key = `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}`;
            const tpQ = tp.teamTotalSimScore >= SIMSCORE_GATE;
            const prev = _crossBestMap[key];
            const prevQ = prev && (prev.teamTotalSimScore != null ? prev.teamTotalSimScore >= SIMSCORE_GATE : prev.totalSimScore >= SIMSCORE_GATE);
            if (!prev || (!prevQ && tpQ) || (prevQ === tpQ && tp.edge > prev.edge)) _crossBestMap[key] = tp;
          }
          // Compare team total winners against any qualified game total for the same game
          for (const [key, gameTp] of Object.entries(_crossBestMap)) {
            const existingGameTotal = plays.find(p => p.gameType === "total" && p.sport === gameTp.sport && p.homeTeam === gameTp.homeTeam && p.awayTeam === gameTp.awayTeam && p.qualified !== false);
            if (existingGameTotal) {
              const gtQ = existingGameTotal.totalSimScore >= SIMSCORE_GATE;
              const ttQ = gameTp.teamTotalSimScore >= SIMSCORE_GATE;
              // Game total wins if: team total isn't qualified, OR both qualified and game total has higher/equal edge
              if (!ttQ || (gtQ && existingGameTotal.edge >= gameTp.edge)) _crossBestMap[key] = existingGameTotal;
            }
          }
          for (const tp of teamTotalPlays) {
            const isTypeBest = _ttBestIds.has(`${tp.sport}|${tp.scoringTeam}|${tp.oppTeam}|${tp.threshold}|${tp.direction}`);
            const crossWinner = _crossBestMap[`${tp.sport}|${tp.homeTeam}|${tp.awayTeam}`];
            const isCrossWinner = crossWinner?.gameType === "teamTotal" && crossWinner?.scoringTeam === tp.scoringTeam && crossWinner?.threshold === tp.threshold && crossWinner?.direction === tp.direction;
            plays.push(isTypeBest && isCrossWinner ? tp : { ...tp, qualified: false });
          }
          // Retroactively mark game totals as non-qualified when a team total won cross-dedup for the same game
          for (let i = 0; i < plays.length; i++) {
            const p = plays[i];
            if (p.gameType !== "total" || p.qualified === false) continue;
            const crossWinner = _crossBestMap[`${p.sport}|${p.homeTeam}|${p.awayTeam}`];
            if (crossWinner?.gameType === "teamTotal") plays[i] = { ...p, qualified: false };
          }
        }
        // ── MLB ML plays (KXMLBGAME) ──────────────────────────────────────────────────────────
        // v1 of moneyline play type. Joint sim from the per-team Poisson lambdas computed in
        // the game-total loop above; each side's kalshiPct comes straight from its Kalshi
        // yes_ask (each ML side is its own market, so no UNDER `no_ask` workaround needed).
        // Qualification matches game totals (Kalshi window + edge gate + dcQualified).
        //
        // Self-contained Kalshi fetch + parse so this block doesn't depend on the late
        // mlbMeta-build KXMLBGAME parse below. The two share an Upstash cache, so the
        // second fetch hits warm storage — minimal extra cost. Decoupled scope keeps ML
        // emission orderable independently of the mlbMeta build.
        const _mlbMlMarkets = {};
        try {
          const _kImpliedProbMl = (m) => {
            const a = parseFloat(m.yes_ask_dollars) || 0;
            const l = parseFloat(m.last_price_dollars) || 0;
            const b = parseFloat(m.yes_bid_dollars) || 0;
            return (a >= 0.98 && b === 0 && l > 0) ? l : (a > 0 ? a : l);
          };
          const _kGameDateMl = (m) => m?.expected_expiration_time ? PT_FMT.format(new Date(m.expected_expiration_time)) : null;
          let _gMarketsMl = [];
          {
            const _gSnapKey = 'kalshi:snap:KXMLBGAME';
            const _gKey = 'kalshi:KXMLBGAME';
            let _gData = null;
            if (CACHE2 && !isBustCache) {
              const _gSnap = await CACHE2.get(_gSnapKey, 'json').catch(() => null);
              if (_gSnap && Array.isArray(_gSnap.markets) && _gSnap.markets.length > 0 &&
                  (Date.now() - (_gSnap.writtenAt || 0) <= 180_000)) {
                _gData = { markets: _gSnap.markets };
              }
            }
            if (!_gData && CACHE2 && !isBustCache) {
              _gData = await CACHE2.get(_gKey, 'json').catch(() => null);
            }
            if (!_gData) {
              const r = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMLBGAME&limit=1000&status=open', {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
              }).catch(() => null);
              if (r?.ok) {
                _gData = await r.json().catch(() => null);
                if (_gData && CACHE2) CACHE2.put(_gKey, JSON.stringify(_gData), { expirationTtl: 600 }).catch(() => {});
              }
            }
            _gMarketsMl = _gData?.markets || [];
          }
          const _byEventMl = {};
          for (const m of _gMarketsMl) {
            const tk = m.ticker || '';
            const lastDash = tk.lastIndexOf('-');
            if (lastDash < 0) continue;
            // Apply MLB Kalshi→canonical normalization (TBR→TB, KCR→KC, SDP→SD, CHW→CWS, AZ→ARI,
            // OAK→ATH, WSN/WAS→WSH) so the lookup against canonical _mlbMlContext keys lines up.
            const abbr = normTeam('mlb', tk.slice(lastDash + 1));
            const eventT = m.event_ticker;
            if (!eventT || !abbr) continue;
            const p = _kImpliedProbMl(m);
            if (!p || p <= 0 || p >= 1) continue;
            if (!_byEventMl[eventT]) _byEventMl[eventT] = { probs: {}, gameDate: _kGameDateMl(m) };
            _byEventMl[eventT].probs[abbr] = p;
          }
          for (const info of Object.values(_byEventMl)) {
            const teams = Object.keys(info.probs);
            if (teams.length !== 2 || !info.gameDate) continue;
            const [t1, t2] = teams;
            // Reattribute stale postponed-ticker gameDate (e.g. 26MAY231605DETBAL re-used
            // for today's makeup game). Skip when the market is resolved (one side near
            // certainty — likely yesterday's actual outcome, not a live makeup).
            const _mlResolved = Math.min(info.probs[t1], info.probs[t2]) <= 0.02
                              || Math.max(info.probs[t1], info.probs[t2]) >= 0.99;
            const _attrDate = _reattrMlbGameDate(info.gameDate, t1, t2, _mlResolved);
            const yesPayload = { yesByTeam: { [t1]: info.probs[t1], [t2]: info.probs[t2] } };
            _mlbMlMarkets[`${t1}|${t2}|${_attrDate}`] = yesPayload;
            _mlbMlMarkets[`${t2}|${t1}|${_attrDate}`] = yesPayload;
          }
        } catch { /* non-fatal — no ML plays if fetch/parse blows up */ }
        // Shared joint Poisson cache across ML + spread emission — same `${home}|${away}` key,
        // same 10k draws fed to both `mlPctFromJoint` and `spreadPctFromJoint`.
        const _mlJointCache = {};
        {
          for (const ctx of Object.values(_mlbMlContext)) {
            const { homeTeam, awayTeam, gameDate, homeLambda, awayLambda, dispR, kalshiVolume, kalshiSpread, lowVolume, _simData } = ctx;
            if (gameDate && gameDate < cutoffStr) continue;
            const mlMarket = _mlbMlMarkets[`${homeTeam}|${awayTeam}|${gameDate}`];
            if (!mlMarket?.yesByTeam) continue;
            const homeYesAsk = mlMarket.yesByTeam[homeTeam];
            const awayYesAsk = mlMarket.yesByTeam[awayTeam];
            if (homeYesAsk == null || awayYesAsk == null) continue;
            const _mlk = `${homeTeam}|${awayTeam}`;
            if (!_mlJointCache[_mlk]) _mlJointCache[_mlk] = simulateMLBJoint(homeLambda, awayLambda, dispR, 10000);
            const joint = _mlJointCache[_mlk];
            if (!joint) continue;
            const homeTruePct = mlPctFromJoint(joint.home, joint.away);
            if (homeTruePct == null) continue;
            const awayTruePct = parseFloat((100 - homeTruePct).toFixed(1));
            const _gameTime = gameTimes[`mlb:${homeTeam}:${gameDate}`] ?? gameTimes[`mlb:${awayTeam}:${gameDate}`] ?? gameTimes[`mlb:${homeTeam}`] ?? gameTimes[`mlb:${awayTeam}`] ?? null;
            const _lineupsConfirmed = _mlbBothTeamsConfirmed(homeTeam, awayTeam, gameDate);
            const _toAO = (p) => p == null ? null : p >= 50 ? Math.round(-(p / (100 - p)) * 100) : Math.round((100 - p) / p * 100);
            for (const side of ["home", "away"]) {
              const pickTeam = side === "home" ? homeTeam : awayTeam;
              const oppTeam = side === "home" ? awayTeam : homeTeam;
              const yesAsk = side === "home" ? homeYesAsk : awayYesAsk;
              const truePct = side === "home" ? homeTruePct : awayTruePct;
              const kalshiPct = parseFloat((yesAsk * 100).toFixed(1));
              const edge = parseFloat((truePct - kalshiPct).toFixed(1));
              const americanOdds = _toAO(kalshiPct);
              const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && inWindow) {
                plays.push({
                  gameType: "ml", sport: "mlb", stat: "ml",
                  homeTeam, awayTeam, pickTeam, oppTeam, side, gameDate,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  totalSimScore: 0, qualified: false,
                  kalshiVolume, kalshiSpread, lowVolume,
                  gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed,
                  homeLambda, awayLambda,
                  ..._simData,
                });
              } else if (isDebug && inWindow) {
                dropped.push({
                  gameType: "ml", sport: "mlb", stat: "ml",
                  homeTeam, awayTeam, pickTeam, oppTeam, side, gameDate,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  lineupsConfirmed: _lineupsConfirmed,
                  reason: "edge_too_low",
                  homeLambda, awayLambda,
                  ..._simData,
                });
              }
            }
          }
        }
        // ── MLB spread emission (KXMLBSPREAD) ───────────────────────────────────────────────
        // Walk parsed spreadMarkets, look up the matching _mlbMlContext (try both Kalshi-ticker
        // orientations since gameTeam1/2 don't necessarily match ESPN home/away), pull the joint
        // sim from _mlJointCache (shared with ML; built on demand), and emit YES (margin side)
        // and NO (cover side) plays. Each direction has its own Kalshi market price (yes_ask /
        // no_ask are independent books — same UNDER-pricing gotcha as totals).
        {
          for (const m of spreadMarkets) {
            if (m.gameDate && m.gameDate < cutoffStr) continue;
            const { gameTeam1, gameTeam2, gameDate, marginTeam, line, kalshiPct: yesKalshi, americanOdds: yesAO, noKalshiPct: noKalshi, noKalshiAO: noAO, kalshiVolume, kalshiSpread } = m;
            const ctx = _mlbMlContext[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? _mlbMlContext[`${gameTeam2}|${gameTeam1}|${gameDate}`];
            if (!ctx) continue;
            const { homeTeam, awayTeam, homeLambda, awayLambda, dispR, _simData } = ctx;
            if (marginTeam !== homeTeam && marginTeam !== awayTeam) continue;
            const _mlk = `${homeTeam}|${awayTeam}`;
            if (!_mlJointCache[_mlk]) _mlJointCache[_mlk] = simulateMLBJoint(homeLambda, awayLambda, dispR, 10000);
            const joint = _mlJointCache[_mlk];
            if (!joint) continue;
            const marginSide = marginTeam === homeTeam ? "home" : "away";
            const yesTruePct = spreadPctFromJoint(joint.home, joint.away, line, marginSide);
            if (yesTruePct == null) continue;
            const noTruePct = parseFloat((100 - yesTruePct).toFixed(1));
            const _gameTime = gameTimes[`mlb:${homeTeam}:${gameDate}`] ?? gameTimes[`mlb:${awayTeam}:${gameDate}`] ?? gameTimes[`mlb:${homeTeam}`] ?? gameTimes[`mlb:${awayTeam}`] ?? null;
            const _lineupsConfirmed = _mlbBothTeamsConfirmed(homeTeam, awayTeam, gameDate);
            // Two directions: YES (marginTeam covers `-line`), NO (other team covers `+line`).
            for (const dir of ["yes", "no"]) {
              const pickTeam = dir === "yes" ? marginTeam : (marginTeam === homeTeam ? awayTeam : homeTeam);
              const oppTeam = dir === "yes" ? (marginTeam === homeTeam ? awayTeam : homeTeam) : marginTeam;
              const pickSide = pickTeam === homeTeam ? "home" : "away";
              const truePct = dir === "yes" ? yesTruePct : noTruePct;
              const kalshiPct = dir === "yes" ? yesKalshi : noKalshi;
              const americanOdds = dir === "yes" ? yesAO : noAO;
              // Signed spread from the pick's perspective: YES picks the margin side → -line;
              // NO picks the cover side → +line. Display: `-1.5` or `+1.5`.
              const pickLine = dir === "yes" ? -line : line;
              const edge = parseFloat((truePct - kalshiPct).toFixed(1));
              const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && inWindow) {
                plays.push({
                  gameType: "spread", sport: "mlb", stat: "spread",
                  homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
                  line, pickLine, marginTeam,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  totalSimScore: 0, qualified: false,
                  kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
                  gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed,
                  homeLambda, awayLambda,
                  ..._simData,
                });
              } else if (isDebug && inWindow) {
                dropped.push({
                  gameType: "spread", sport: "mlb", stat: "spread",
                  homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
                  line, pickLine, marginTeam,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  lineupsConfirmed: _lineupsConfirmed,
                  reason: "edge_too_low",
                  homeLambda, awayLambda,
                  ..._simData,
                });
              }
            }
          }
        }
        // ── NBA ML plays (KXNBAGAME) ──────────────────────────────────────────────────────────
        // Per-team Normal joint sim from the same lambdas as NBA game totals. Each ML side is
        // its own Kalshi market, so kalshiPct = own yes_ask (mirror of MLB ML; no `no_ask` for
        // each side). Joint sim drops tied draws — NBA games never end in regulation ties in
        // reality, and rounded-Normal sim ties are <0.5% so the approximation is harmless.
        const _nbaMlMarkets = {};
        try {
          const _kImpliedProbMlN = (m) => {
            const a = parseFloat(m.yes_ask_dollars) || 0;
            const l = parseFloat(m.last_price_dollars) || 0;
            const b = parseFloat(m.yes_bid_dollars) || 0;
            return (a >= 0.98 && b === 0 && l > 0) ? l : (a > 0 ? a : l);
          };
          const _kGameDateMlN = (m) => m?.expected_expiration_time ? PT_FMT.format(new Date(m.expected_expiration_time)) : null;
          let _gMarketsMlN = [];
          {
            const _gSnapKey = 'kalshi:snap:KXNBAGAME';
            const _gKey = 'kalshi:KXNBAGAME';
            let _gData = null;
            if (CACHE2 && !isBustCache) {
              const _gSnap = await CACHE2.get(_gSnapKey, 'json').catch(() => null);
              if (_gSnap && Array.isArray(_gSnap.markets) && _gSnap.markets.length > 0 &&
                  (Date.now() - (_gSnap.writtenAt || 0) <= 180_000)) {
                _gData = { markets: _gSnap.markets };
              }
            }
            if (!_gData && CACHE2 && !isBustCache) {
              _gData = await CACHE2.get(_gKey, 'json').catch(() => null);
            }
            if (!_gData) {
              const r = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNBAGAME&limit=1000&status=open', {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
              }).catch(() => null);
              if (r?.ok) {
                _gData = await r.json().catch(() => null);
                if (_gData && CACHE2) CACHE2.put(_gKey, JSON.stringify(_gData), { expirationTtl: 600 }).catch(() => {});
              }
            }
            _gMarketsMlN = _gData?.markets || [];
          }
          const _byEventMlN = {};
          for (const m of _gMarketsMlN) {
            const tk = m.ticker || '';
            const lastDash = tk.lastIndexOf('-');
            if (lastDash < 0) continue;
            const abbr = normTeam('nba', tk.slice(lastDash + 1));
            const eventT = m.event_ticker;
            if (!eventT || !abbr) continue;
            const p = _kImpliedProbMlN(m);
            if (!p || p <= 0 || p >= 1) continue;
            if (!_byEventMlN[eventT]) _byEventMlN[eventT] = { probs: {}, gameDate: _kGameDateMlN(m) };
            _byEventMlN[eventT].probs[abbr] = p;
          }
          for (const info of Object.values(_byEventMlN)) {
            const teams = Object.keys(info.probs);
            if (teams.length !== 2 || !info.gameDate) continue;
            const [t1, t2] = teams;
            const yesPayload = { yesByTeam: { [t1]: info.probs[t1], [t2]: info.probs[t2] } };
            _nbaMlMarkets[`${t1}|${t2}|${info.gameDate}`] = yesPayload;
            _nbaMlMarkets[`${t2}|${t1}|${info.gameDate}`] = yesPayload;
          }
        } catch { /* non-fatal */ }
        // Shared joint Normal cache for NBA ML + spread emission.
        const _nbaJointCache = {};
        {
          for (const ctx of Object.values(_nbaMlContext)) {
            const { homeTeam, awayTeam, gameDate, homeLambda, awayLambda, kalshiVolume, kalshiSpread, lowVolume, _simData } = ctx;
            if (gameDate && gameDate < cutoffStr) continue;
            const mlMarket = _nbaMlMarkets[`${homeTeam}|${awayTeam}|${gameDate}`];
            if (!mlMarket?.yesByTeam) continue;
            const homeYesAsk = mlMarket.yesByTeam[homeTeam];
            const awayYesAsk = mlMarket.yesByTeam[awayTeam];
            if (homeYesAsk == null || awayYesAsk == null) continue;
            const _mlk = `${homeTeam}|${awayTeam}`;
            if (!_nbaJointCache[_mlk]) _nbaJointCache[_mlk] = simulateNBAJoint(homeLambda, awayLambda, 13, 13, 10000);
            const joint = _nbaJointCache[_mlk];
            if (!joint) continue;
            const homeTruePct = mlPctFromJoint(joint.home, joint.away);
            if (homeTruePct == null) continue;
            const awayTruePct = parseFloat((100 - homeTruePct).toFixed(1));
            const _gameTime = gameTimes[`nba:${homeTeam}:${gameDate}`] ?? gameTimes[`nba:${awayTeam}:${gameDate}`] ?? gameTimes[`nba:${homeTeam}`] ?? gameTimes[`nba:${awayTeam}`] ?? null;
            const _toAO = (p) => p == null ? null : p >= 50 ? Math.round(-(p / (100 - p)) * 100) : Math.round((100 - p) / p * 100);
            for (const side of ["home", "away"]) {
              const pickTeam = side === "home" ? homeTeam : awayTeam;
              const oppTeam = side === "home" ? awayTeam : homeTeam;
              const yesAsk = side === "home" ? homeYesAsk : awayYesAsk;
              const truePct = side === "home" ? homeTruePct : awayTruePct;
              const kalshiPct = parseFloat((yesAsk * 100).toFixed(1));
              const edge = parseFloat((truePct - kalshiPct).toFixed(1));
              const americanOdds = _toAO(kalshiPct);
              const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && inWindow) {
                plays.push({
                  gameType: "ml", sport: "nba", stat: "ml",
                  homeTeam, awayTeam, pickTeam, oppTeam, side, gameDate,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  totalSimScore: 0, qualified: false,
                  kalshiVolume, kalshiSpread, lowVolume,
                  gameTime: _gameTime,
                  homeLambda, awayLambda,
                  ..._simData,
                });
              } else if (isDebug && inWindow) {
                dropped.push({
                  gameType: "ml", sport: "nba", stat: "ml",
                  homeTeam, awayTeam, pickTeam, oppTeam, side, gameDate,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  reason: "edge_too_low",
                  homeLambda, awayLambda,
                  ..._simData,
                });
              }
            }
          }
        }
        // ── NBA spread emission (KXNBASPREAD) ────────────────────────────────────────────────
        // Same shape as MLB spread: walks spreadMarkets (already parsed sport-agnostically),
        // filters to sport==='nba', looks up _nbaMlContext both orientations, reuses _nbaJointCache.
        {
          for (const m of spreadMarkets) {
            if (m.sport !== "nba") continue;
            if (m.gameDate && m.gameDate < cutoffStr) continue;
            const { gameTeam1, gameTeam2, gameDate, marginTeam, line, kalshiPct: yesKalshi, americanOdds: yesAO, noKalshiPct: noKalshi, noKalshiAO: noAO, kalshiVolume, kalshiSpread } = m;
            const ctx = _nbaMlContext[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? _nbaMlContext[`${gameTeam2}|${gameTeam1}|${gameDate}`];
            if (!ctx) continue;
            const { homeTeam, awayTeam, homeLambda, awayLambda, _simData } = ctx;
            if (marginTeam !== homeTeam && marginTeam !== awayTeam) continue;
            const _mlk = `${homeTeam}|${awayTeam}`;
            if (!_nbaJointCache[_mlk]) _nbaJointCache[_mlk] = simulateNBAJoint(homeLambda, awayLambda, 13, 13, 10000);
            const joint = _nbaJointCache[_mlk];
            if (!joint) continue;
            const marginSide = marginTeam === homeTeam ? "home" : "away";
            const yesTruePct = spreadPctFromJoint(joint.home, joint.away, line, marginSide);
            if (yesTruePct == null) continue;
            const noTruePct = parseFloat((100 - yesTruePct).toFixed(1));
            const _gameTime = gameTimes[`nba:${homeTeam}:${gameDate}`] ?? gameTimes[`nba:${awayTeam}:${gameDate}`] ?? gameTimes[`nba:${homeTeam}`] ?? gameTimes[`nba:${awayTeam}`] ?? null;
            for (const dir of ["yes", "no"]) {
              const pickTeam = dir === "yes" ? marginTeam : (marginTeam === homeTeam ? awayTeam : homeTeam);
              const oppTeam = dir === "yes" ? (marginTeam === homeTeam ? awayTeam : homeTeam) : marginTeam;
              const pickSide = pickTeam === homeTeam ? "home" : "away";
              const truePct = dir === "yes" ? yesTruePct : noTruePct;
              const kalshiPct = dir === "yes" ? yesKalshi : noKalshi;
              const americanOdds = dir === "yes" ? yesAO : noAO;
              const pickLine = dir === "yes" ? -line : line;
              const edge = parseFloat((truePct - kalshiPct).toFixed(1));
              const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && inWindow) {
                plays.push({
                  gameType: "spread", sport: "nba", stat: "spread",
                  homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
                  line, pickLine, marginTeam,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  totalSimScore: 0, qualified: false,
                  kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
                  gameTime: _gameTime,
                  homeLambda, awayLambda,
                  ..._simData,
                });
              } else if (isDebug && inWindow) {
                dropped.push({
                  gameType: "spread", sport: "nba", stat: "spread",
                  homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
                  line, pickLine, marginTeam,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  reason: "edge_too_low",
                  homeLambda, awayLambda,
                  ..._simData,
                });
              }
            }
          }
        }
        // ── WNBA ML plays (KXWNBAGAME) ────────────────────────────────────────────────────────
        // Mirror of NBA block: independent per-team Normal joint sim, per-team σ=11 (matches the
        // WNBA total sim variance). Same dropped-tie treatment as NBA — WNBA games never end
        // regulation tied in reality (OT resolves), and rounded-Normal ties are <0.5% of sims.
        const _wnbaMlMarkets = {};
        try {
          const _kImpliedProbMlW = (m) => {
            const a = parseFloat(m.yes_ask_dollars) || 0;
            const l = parseFloat(m.last_price_dollars) || 0;
            const b = parseFloat(m.yes_bid_dollars) || 0;
            return (a >= 0.98 && b === 0 && l > 0) ? l : (a > 0 ? a : l);
          };
          const _kGameDateMlW = (m) => m?.expected_expiration_time ? PT_FMT.format(new Date(m.expected_expiration_time)) : null;
          let _gMarketsMlW = [];
          {
            const _gSnapKey = 'kalshi:snap:KXWNBAGAME';
            const _gKey = 'kalshi:KXWNBAGAME';
            let _gData = null;
            if (CACHE2 && !isBustCache) {
              const _gSnap = await CACHE2.get(_gSnapKey, 'json').catch(() => null);
              if (_gSnap && Array.isArray(_gSnap.markets) && _gSnap.markets.length > 0 &&
                  (Date.now() - (_gSnap.writtenAt || 0) <= 180_000)) {
                _gData = { markets: _gSnap.markets };
              }
            }
            if (!_gData && CACHE2 && !isBustCache) {
              _gData = await CACHE2.get(_gKey, 'json').catch(() => null);
            }
            if (!_gData) {
              const r = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXWNBAGAME&limit=1000&status=open', {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
              }).catch(() => null);
              if (r?.ok) {
                _gData = await r.json().catch(() => null);
                if (_gData && CACHE2) CACHE2.put(_gKey, JSON.stringify(_gData), { expirationTtl: 600 }).catch(() => {});
              }
            }
            _gMarketsMlW = _gData?.markets || [];
          }
          const _byEventMlW = {};
          for (const m of _gMarketsMlW) {
            const tk = m.ticker || '';
            const lastDash = tk.lastIndexOf('-');
            if (lastDash < 0) continue;
            const abbr = normTeam('wnba', tk.slice(lastDash + 1));
            const eventT = m.event_ticker;
            if (!eventT || !abbr) continue;
            const p = _kImpliedProbMlW(m);
            if (!p || p <= 0 || p >= 1) continue;
            if (!_byEventMlW[eventT]) _byEventMlW[eventT] = { probs: {}, gameDate: _kGameDateMlW(m) };
            _byEventMlW[eventT].probs[abbr] = p;
          }
          for (const info of Object.values(_byEventMlW)) {
            const teams = Object.keys(info.probs);
            if (teams.length !== 2 || !info.gameDate) continue;
            const [t1, t2] = teams;
            const yesPayload = { yesByTeam: { [t1]: info.probs[t1], [t2]: info.probs[t2] } };
            _wnbaMlMarkets[`${t1}|${t2}|${info.gameDate}`] = yesPayload;
            _wnbaMlMarkets[`${t2}|${t1}|${info.gameDate}`] = yesPayload;
          }
        } catch { /* non-fatal */ }
        const _wnbaJointCache = {};
        {
          for (const ctx of Object.values(_wnbaMlContext)) {
            const { homeTeam, awayTeam, gameDate, homeLambda, awayLambda, kalshiVolume, kalshiSpread, lowVolume, _simData } = ctx;
            if (gameDate && gameDate < cutoffStr) continue;
            const mlMarket = _wnbaMlMarkets[`${homeTeam}|${awayTeam}|${gameDate}`];
            if (!mlMarket?.yesByTeam) continue;
            const homeYesAsk = mlMarket.yesByTeam[homeTeam];
            const awayYesAsk = mlMarket.yesByTeam[awayTeam];
            if (homeYesAsk == null || awayYesAsk == null) continue;
            const _mlk = `${homeTeam}|${awayTeam}`;
            if (!_wnbaJointCache[_mlk]) _wnbaJointCache[_mlk] = simulateNBAJoint(homeLambda, awayLambda, 11, 11, 10000);
            const joint = _wnbaJointCache[_mlk];
            if (!joint) continue;
            const homeTruePct = mlPctFromJoint(joint.home, joint.away);
            if (homeTruePct == null) continue;
            const awayTruePct = parseFloat((100 - homeTruePct).toFixed(1));
            const _gameTime = gameTimes[`wnba:${homeTeam}:${gameDate}`] ?? gameTimes[`wnba:${awayTeam}:${gameDate}`] ?? gameTimes[`wnba:${homeTeam}`] ?? gameTimes[`wnba:${awayTeam}`] ?? null;
            const _toAO = (p) => p == null ? null : p >= 50 ? Math.round(-(p / (100 - p)) * 100) : Math.round((100 - p) / p * 100);
            for (const side of ["home", "away"]) {
              const pickTeam = side === "home" ? homeTeam : awayTeam;
              const oppTeam = side === "home" ? awayTeam : homeTeam;
              const yesAsk = side === "home" ? homeYesAsk : awayYesAsk;
              const truePct = side === "home" ? homeTruePct : awayTruePct;
              const kalshiPct = parseFloat((yesAsk * 100).toFixed(1));
              const edge = parseFloat((truePct - kalshiPct).toFixed(1));
              const americanOdds = _toAO(kalshiPct);
              const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && inWindow) {
                plays.push({
                  gameType: "ml", sport: "wnba", stat: "ml",
                  homeTeam, awayTeam, pickTeam, oppTeam, side, gameDate,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  totalSimScore: 0, qualified: false,
                  kalshiVolume, kalshiSpread, lowVolume,
                  gameTime: _gameTime,
                  homeLambda, awayLambda,
                  ..._simData,
                });
              } else if (isDebug && inWindow) {
                dropped.push({
                  gameType: "ml", sport: "wnba", stat: "ml",
                  homeTeam, awayTeam, pickTeam, oppTeam, side, gameDate,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  reason: "edge_too_low",
                  homeLambda, awayLambda,
                  ..._simData,
                });
              }
            }
          }
        }
        // ── WNBA spread emission (KXWNBASPREAD) ──────────────────────────────────────────────
        {
          for (const m of spreadMarkets) {
            if (m.sport !== "wnba") continue;
            if (m.gameDate && m.gameDate < cutoffStr) continue;
            const { gameTeam1, gameTeam2, gameDate, marginTeam, line, kalshiPct: yesKalshi, americanOdds: yesAO, noKalshiPct: noKalshi, noKalshiAO: noAO, kalshiVolume, kalshiSpread } = m;
            const ctx = _wnbaMlContext[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? _wnbaMlContext[`${gameTeam2}|${gameTeam1}|${gameDate}`];
            if (!ctx) continue;
            const { homeTeam, awayTeam, homeLambda, awayLambda, _simData } = ctx;
            if (marginTeam !== homeTeam && marginTeam !== awayTeam) continue;
            const _mlk = `${homeTeam}|${awayTeam}`;
            if (!_wnbaJointCache[_mlk]) _wnbaJointCache[_mlk] = simulateNBAJoint(homeLambda, awayLambda, 11, 11, 10000);
            const joint = _wnbaJointCache[_mlk];
            if (!joint) continue;
            const marginSide = marginTeam === homeTeam ? "home" : "away";
            const yesTruePct = spreadPctFromJoint(joint.home, joint.away, line, marginSide);
            if (yesTruePct == null) continue;
            const noTruePct = parseFloat((100 - yesTruePct).toFixed(1));
            const _gameTime = gameTimes[`wnba:${homeTeam}:${gameDate}`] ?? gameTimes[`wnba:${awayTeam}:${gameDate}`] ?? gameTimes[`wnba:${homeTeam}`] ?? gameTimes[`wnba:${awayTeam}`] ?? null;
            for (const dir of ["yes", "no"]) {
              const pickTeam = dir === "yes" ? marginTeam : (marginTeam === homeTeam ? awayTeam : homeTeam);
              const oppTeam = dir === "yes" ? (marginTeam === homeTeam ? awayTeam : homeTeam) : marginTeam;
              const pickSide = pickTeam === homeTeam ? "home" : "away";
              const truePct = dir === "yes" ? yesTruePct : noTruePct;
              const kalshiPct = dir === "yes" ? yesKalshi : noKalshi;
              const americanOdds = dir === "yes" ? yesAO : noAO;
              const pickLine = dir === "yes" ? -line : line;
              const edge = parseFloat((truePct - kalshiPct).toFixed(1));
              const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && inWindow) {
                plays.push({
                  gameType: "spread", sport: "wnba", stat: "spread",
                  homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
                  line, pickLine, marginTeam,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  totalSimScore: 0, qualified: false,
                  kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
                  gameTime: _gameTime,
                  homeLambda, awayLambda,
                  ..._simData,
                });
              } else if (isDebug && inWindow) {
                dropped.push({
                  gameType: "spread", sport: "wnba", stat: "spread",
                  homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
                  line, pickLine, marginTeam,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  reason: "edge_too_low",
                  homeLambda, awayLambda,
                  ..._simData,
                });
              }
            }
          }
        }
        // ── NHL ML plays (KXNHLGAME) ──────────────────────────────────────────────────────────
        // Per-team Poisson joint sim — same engine as MLB (goals and runs are both independent
        // count distributions). `simulateMLBJoint` is sport-agnostic; reusing it directly here
        // rather than renaming to avoid touching the MLB call site. Ties dropped from ML
        // numerator (real NHL ~22% of games go to OT/SO; this approximation under-projects the
        // favorite slightly since OT/SO winners are weighted toward the favored team in reality).
        const _nhlMlMarkets = {};
        try {
          const _kImpliedProbMlH = (m) => {
            const a = parseFloat(m.yes_ask_dollars) || 0;
            const l = parseFloat(m.last_price_dollars) || 0;
            const b = parseFloat(m.yes_bid_dollars) || 0;
            return (a >= 0.98 && b === 0 && l > 0) ? l : (a > 0 ? a : l);
          };
          const _kGameDateMlH = (m) => m?.expected_expiration_time ? PT_FMT.format(new Date(m.expected_expiration_time)) : null;
          let _gMarketsMlH = [];
          {
            const _gSnapKey = 'kalshi:snap:KXNHLGAME';
            const _gKey = 'kalshi:KXNHLGAME';
            let _gData = null;
            if (CACHE2 && !isBustCache) {
              const _gSnap = await CACHE2.get(_gSnapKey, 'json').catch(() => null);
              if (_gSnap && Array.isArray(_gSnap.markets) && _gSnap.markets.length > 0 &&
                  (Date.now() - (_gSnap.writtenAt || 0) <= 180_000)) {
                _gData = { markets: _gSnap.markets };
              }
            }
            if (!_gData && CACHE2 && !isBustCache) {
              _gData = await CACHE2.get(_gKey, 'json').catch(() => null);
            }
            if (!_gData) {
              const r = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNHLGAME&limit=1000&status=open', {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
              }).catch(() => null);
              if (r?.ok) {
                _gData = await r.json().catch(() => null);
                if (_gData && CACHE2) CACHE2.put(_gKey, JSON.stringify(_gData), { expirationTtl: 600 }).catch(() => {});
              }
            }
            _gMarketsMlH = _gData?.markets || [];
          }
          const _byEventMlH = {};
          for (const m of _gMarketsMlH) {
            const tk = m.ticker || '';
            const lastDash = tk.lastIndexOf('-');
            if (lastDash < 0) continue;
            const abbr = normTeam('nhl', tk.slice(lastDash + 1));
            const eventT = m.event_ticker;
            if (!eventT || !abbr) continue;
            const p = _kImpliedProbMlH(m);
            if (!p || p <= 0 || p >= 1) continue;
            if (!_byEventMlH[eventT]) _byEventMlH[eventT] = { probs: {}, gameDate: _kGameDateMlH(m) };
            _byEventMlH[eventT].probs[abbr] = p;
          }
          for (const info of Object.values(_byEventMlH)) {
            const teams = Object.keys(info.probs);
            if (teams.length !== 2 || !info.gameDate) continue;
            const [t1, t2] = teams;
            const yesPayload = { yesByTeam: { [t1]: info.probs[t1], [t2]: info.probs[t2] } };
            _nhlMlMarkets[`${t1}|${t2}|${info.gameDate}`] = yesPayload;
            _nhlMlMarkets[`${t2}|${t1}|${info.gameDate}`] = yesPayload;
          }
        } catch { /* non-fatal */ }
        const _nhlJointCache = {};
        {
          for (const ctx of Object.values(_nhlMlContext)) {
            const { homeTeam, awayTeam, gameDate, homeLambda, awayLambda, kalshiVolume, kalshiSpread, lowVolume, _simData } = ctx;
            if (gameDate && gameDate < cutoffStr) continue;
            const mlMarket = _nhlMlMarkets[`${homeTeam}|${awayTeam}|${gameDate}`];
            if (!mlMarket?.yesByTeam) continue;
            const homeYesAsk = mlMarket.yesByTeam[homeTeam];
            const awayYesAsk = mlMarket.yesByTeam[awayTeam];
            if (homeYesAsk == null || awayYesAsk == null) continue;
            const _mlk = `${homeTeam}|${awayTeam}`;
            if (!_nhlJointCache[_mlk]) _nhlJointCache[_mlk] = simulateMLBJoint(homeLambda, awayLambda, null, 10000);
            const joint = _nhlJointCache[_mlk];
            if (!joint) continue;
            const homeTruePct = mlPctFromJoint(joint.home, joint.away);
            if (homeTruePct == null) continue;
            const awayTruePct = parseFloat((100 - homeTruePct).toFixed(1));
            const _gameTime = gameTimes[`nhl:${homeTeam}:${gameDate}`] ?? gameTimes[`nhl:${awayTeam}:${gameDate}`] ?? gameTimes[`nhl:${homeTeam}`] ?? gameTimes[`nhl:${awayTeam}`] ?? null;
            const _toAO = (p) => p == null ? null : p >= 50 ? Math.round(-(p / (100 - p)) * 100) : Math.round((100 - p) / p * 100);
            for (const side of ["home", "away"]) {
              const pickTeam = side === "home" ? homeTeam : awayTeam;
              const oppTeam = side === "home" ? awayTeam : homeTeam;
              const yesAsk = side === "home" ? homeYesAsk : awayYesAsk;
              const truePct = side === "home" ? homeTruePct : awayTruePct;
              const kalshiPct = parseFloat((yesAsk * 100).toFixed(1));
              const edge = parseFloat((truePct - kalshiPct).toFixed(1));
              const americanOdds = _toAO(kalshiPct);
              const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && inWindow) {
                plays.push({
                  gameType: "ml", sport: "nhl", stat: "ml",
                  homeTeam, awayTeam, pickTeam, oppTeam, side, gameDate,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  totalSimScore: 0, qualified: false,
                  kalshiVolume, kalshiSpread, lowVolume,
                  gameTime: _gameTime,
                  homeLambda, awayLambda,
                  ..._simData,
                });
              } else if (isDebug && inWindow) {
                dropped.push({
                  gameType: "ml", sport: "nhl", stat: "ml",
                  homeTeam, awayTeam, pickTeam, oppTeam, side, gameDate,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  reason: "edge_too_low",
                  homeLambda, awayLambda,
                  ..._simData,
                });
              }
            }
          }
        }
        // ── NHL spread emission (KXNHLSPREAD) ────────────────────────────────────────────────
        // Half-lines only (Kalshi NHL: ±1.5, ±2.5). v1 approximation: regulation-only Poisson
        // sim. OT/SO winners get +1 goal in reality, so spread truePct is slightly understated
        // on tight games where the favorite wins by exactly 1 in regulation but goes 2 in OT.
        // Acceptable v1 noise; revisit if calibration shows systematic miss on -1.5 favorites.
        {
          for (const m of spreadMarkets) {
            if (m.sport !== "nhl") continue;
            if (m.gameDate && m.gameDate < cutoffStr) continue;
            const { gameTeam1, gameTeam2, gameDate, marginTeam, line, kalshiPct: yesKalshi, americanOdds: yesAO, noKalshiPct: noKalshi, noKalshiAO: noAO, kalshiVolume, kalshiSpread } = m;
            const ctx = _nhlMlContext[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? _nhlMlContext[`${gameTeam2}|${gameTeam1}|${gameDate}`];
            if (!ctx) continue;
            const { homeTeam, awayTeam, homeLambda, awayLambda, _simData } = ctx;
            if (marginTeam !== homeTeam && marginTeam !== awayTeam) continue;
            const _mlk = `${homeTeam}|${awayTeam}`;
            if (!_nhlJointCache[_mlk]) _nhlJointCache[_mlk] = simulateMLBJoint(homeLambda, awayLambda, null, 10000);
            const joint = _nhlJointCache[_mlk];
            if (!joint) continue;
            const marginSide = marginTeam === homeTeam ? "home" : "away";
            const yesTruePct = spreadPctFromJoint(joint.home, joint.away, line, marginSide);
            if (yesTruePct == null) continue;
            const noTruePct = parseFloat((100 - yesTruePct).toFixed(1));
            const _gameTime = gameTimes[`nhl:${homeTeam}:${gameDate}`] ?? gameTimes[`nhl:${awayTeam}:${gameDate}`] ?? gameTimes[`nhl:${homeTeam}`] ?? gameTimes[`nhl:${awayTeam}`] ?? null;
            for (const dir of ["yes", "no"]) {
              const pickTeam = dir === "yes" ? marginTeam : (marginTeam === homeTeam ? awayTeam : homeTeam);
              const oppTeam = dir === "yes" ? (marginTeam === homeTeam ? awayTeam : homeTeam) : marginTeam;
              const pickSide = pickTeam === homeTeam ? "home" : "away";
              const truePct = dir === "yes" ? yesTruePct : noTruePct;
              const kalshiPct = dir === "yes" ? yesKalshi : noKalshi;
              const americanOdds = dir === "yes" ? yesAO : noAO;
              const pickLine = dir === "yes" ? -line : line;
              const edge = parseFloat((truePct - kalshiPct).toFixed(1));
              const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
              if (edge >= EDGE_GATE && inWindow) {
                plays.push({
                  gameType: "spread", sport: "nhl", stat: "spread",
                  homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
                  line, pickLine, marginTeam,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  totalSimScore: 0, qualified: false,
                  kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
                  gameTime: _gameTime,
                  homeLambda, awayLambda,
                  ..._simData,
                });
              } else if (isDebug && inWindow) {
                dropped.push({
                  gameType: "spread", sport: "nhl", stat: "spread",
                  homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
                  line, pickLine, marginTeam,
                  kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
                  reason: "edge_too_low",
                  homeLambda, awayLambda,
                  ..._simData,
                });
              }
            }
          }
        }
        // Drop plays whose scheduled gameTime has already passed — pre-game market is closed,
        // and our model truePct is built on pre-game inputs so it's no longer valid in-game.
        // Plays without gameTime are kept (we already gate by gameDate earlier).
        {
          const _nowMs = Date.now();
          plays.splice(0, plays.length, ...plays.filter(p => {
            if (!p.gameTime) return true;
            const t = new Date(p.gameTime).getTime();
            return isNaN(t) || t > _nowMs;
          }));
        }
        // Per-matchup alt-line dedup (added 2026-05-18, extended to player props 2026-05-19) for
        // every play type that has multiple alt thresholds/lines per logical bet:
        //   - total: same matchup × direction (correlated by game outcome)
        //   - teamTotal: same scoring team × direction
        //   - spread: same pickTeam × opponent
        //   - player props: same player × stat (alt thresholds sample one distribution)
        // ML is excluded (each side is its own play, no alt lines). Keeps highest-edge line per
        // group; demoted lines move to dropped[] in debug mode with reason "altLineDedup".
        {
          const _ddKey = (p) => {
            if (p.gameType === "total") return `gt|${p.sport}|${p.homeTeam}|${p.awayTeam}|${p.gameDate}|${p.direction || 'over'}`;
            if (p.gameType === "teamTotal") return `tt|${p.sport}|${p.scoringTeam}|${p.oppTeam}|${p.gameDate}|${p.direction || 'over'}`;
            // Spread: matchup-symmetric key (sort teams) so BOTH sides of the same game land in
            // the same group — keeps only the highest-edge spread pick per matchup. Both-sides
            // qualifying happens on near-pick'em games where the model thinks each team keeps
            // it close on the cover line; correlation risk is similar to alt-line stacking.
            if (p.gameType === "spread") {
              const teams = [p.pickTeam, p.oppTeam].sort().join('|');
              return `sp|${p.sport}|${teams}|${p.gameDate}`;
            }
            // Player props (no gameType): same player × stat across alt thresholds are sampling the
            // same underlying random variable (Tucker 1+/2+/3+ HRR draws from his HRR distribution).
            // Keep highest-edge threshold per player×stat — reverses the 2026-05-16 "see all alts"
            // decision since correlation is too strong to size independently.
            if (!p.gameType && p.playerName && p.stat) return `pp|${p.sport}|${p.playerName}|${p.stat}|${p.gameDate}`;
            return null;
          };
          const _bestByKey = {};
          for (const p of plays) {
            const k = _ddKey(p);
            if (!k) continue;
            if (!_bestByKey[k] || (p.edge ?? 0) > (_bestByKey[k].edge ?? 0)) _bestByKey[k] = p;
          }
          const _kept = [];
          const _demoted = [];
          for (const p of plays) {
            const k = _ddKey(p);
            if (!k || _bestByKey[k] === p) _kept.push(p);
            // Mark with `_altLineDemoted: true` — separate from dcQualified because the
            // dataConfidence pass below overwrites dcQualified per-play and would otherwise
            // restore the demoted alt to qualified. _altLineDemoted is the dedup-stable marker
            // the client filter uses to exclude (unless the user has the pick tracked).
            else _demoted.push({ ...p, reason: "altLineDedup", _altLineDemoted: true });
          }
          plays.splice(0, plays.length, ..._kept, ..._demoted);
          if (isDebug) dropped.push(..._demoted);
        }
        // Mark plays whose source kalshi series fell back to per-ticker stale (or prior-bundle
        // preservation) this request. Single pass keeps the per-play push sites untouched.
        if (_staleKalshiSet.size) {
          for (const p of plays) {
            const ticker = _findKalshiTicker(p.sport, p.stat, p.gameType);
            if (ticker && _staleKalshiSet.has(ticker)) p._kalshiStale = true;
          }
        }
        // ── dataConfidence (0-10) — penalty-based score starting at 10, subtracting for input-data
        // issues. Strict by design: only plays with zero or one minor issue reach the gate. NOT
        // YET an active filter — `dcQualified` is computed and emitted but the v1 frontend still
        // ignores it. The v2 model toggle (Phase B) is where this becomes the gate.
        //
        // Spec details + full penalty table in docs/MODEL.md "dataConfidence". Must run AFTER the
        // _kalshiStale propagation above and BEFORE the isDebug return below so debug-mode plays
        // carry the field too.
        for (const _p of plays) {
          const dc = computeDataConfidence(_p, { sportByteam });
          _p.dataConfidence = dc.dataConfidence;
          _p.dcPenalties = dc.dcPenalties;
          _p.dcQualified = dc.dcQualified;
          _p.dcGate = dc.dcGate;
        }
        // Also compute DC for `dropped` plays so the debug Market Report shows DC columns for
        // every row (otherwise pre-DC drops like edge_too_low / no_simulation_data render DC=—).
        for (const _p of dropped) {
          const dc = computeDataConfidence(_p, { sportByteam });
          _p.dataConfidence = dc.dataConfidence;
          _p.dcPenalties = dc.dcPenalties;
          _p.dcQualified = dc.dcQualified;
          _p.dcGate = dc.dcGate;
        }
        if (isDebug) {
          const nbaGlLabels = Object.fromEntries(Object.entries(playerGamelogs).filter(([k]) => k.startsWith("nba|")).map(([k, gl]) => [k, gl?.ul ?? null]));
          const nbaGlSample = Object.fromEntries(Object.entries(playerGamelogs).filter(([k]) => k.startsWith("nba|")).map(([k, gl]) => [k, gl?.events?.slice(0, 3).map(ev => ({ stats: ev.stats?.slice(0, 3), statsLen: ev.stats?.length })) ?? null]));
          const sf = reportSportFilter;
          const debugPlays = sf ? plays.filter(m => m.sport === sf) : plays;
          const debugDropped = sf ? dropped.filter(m => m.sport === sf) : dropped;
          const debugPreDropped = sf ? preDropped.filter(m => m.sport === sf) : preDropped;
          const _kalshiSnapDebug = {
            usedSnaps: kalshiUsedSnaps,
            meta: kalshiSnapMeta,
            ageMs: kalshiSnapMeta?.lastRunAt ? Date.now() - kalshiSnapMeta.lastRunAt : null,
          };
          return jsonResponse({ plays: debugPlays, dropped: debugDropped, preDropped: debugPreDropped, staleKalshiSeries, kalshiSnap: _kalshiSnapDebug, gamelogErrors, pInfoErrors, qualifyingCount: qualifyingMarkets.length, totalMarketsCount: totalMarkets.length, preFilteredCount: preFilteredMarkets.length, uniquePlayersSearched: uniquePlayerKeys.length, playersWithInfo: Object.keys(playerInfoMap).length, playersWithGamelog: Object.keys(playerGamelogs).length, lineupKPct: sportByteam.mlb?.lineupKPct ?? null, lineupKPctVR: sportByteam.mlb?.lineupKPctVR ?? null, pitcherKPctCache: sportByteam.mlb?.pitcherKPct ?? null, pitcherAvgPitchesCache: sportByteam.mlb?.pitcherAvgPitches ?? null, nbaGlLabels, nbaGlSample }, true);
        }
        // Build mlbMeta: pitchers, ML odds, umpires, weather — keyed by team abbr or "home|away"
        // Pitcher entries: { name, id, era, wins, losses }. MLB Stats API (pitcherInfoByTeam) preferred
        // for id (powers midfield.mlbstatic.com headshots); ESPN probables fallback for early-day.
        const _mlbPitcherEra = sportByteam.mlb?.pitcherEra ?? {};
        const _mlbPitcherWins = sportByteam.mlb?.pitcherWinsByTeam ?? {};
        const _mlbPitcherLosses = sportByteam.mlb?.pitcherLossesByTeam ?? {};
        const _mlbPitcherInfo = sportByteam.mlb?.pitcherInfoByTeam ?? {};
        const _mlbProbables = sportByteam.mlb?.probables ?? {};
        const _mlbPitchers = {};
        const _allPitcherAbbrs = new Set([...Object.keys(_mlbProbables), ...Object.keys(_mlbPitcherInfo)]);
        for (const abbr of _allPitcherAbbrs) {
          const prob = _mlbProbables[abbr];
          const info = _mlbPitcherInfo[abbr];
          const name = prob?.name ?? info?.name ?? null;
          if (!name) continue;
          const id = info?.id ?? prob?.id ?? null;
          const era = _mlbPitcherEra[abbr] ?? prob?.era ?? null;
          const wins = _mlbPitcherWins[abbr] ?? null;
          const losses = _mlbPitcherLosses[abbr] ?? null;
          _mlbPitchers[abbr] = { name, id, era, wins, losses };
        }
        // Per-game pitcher map for doubleheader correctness — team-keyed _mlbPitchers above
        // only holds one entry per team (the late game's pitcher wins). Key shape mirrors
        // gameScores: "{team}|{gameKey}" where gameKey is the ESPN-style ISO (no seconds).
        const _mlbPitcherIdByGame = sportByteam.mlb?.pitcherIdByGame ?? {};
        const _mlbPitcherEraById = sportByteam.mlb?.pitcherEraById ?? {};
        const _mlbPitcherWinsById = sportByteam.mlb?.pitcherWinsById ?? {};
        const _mlbPitcherLossesById = sportByteam.mlb?.pitcherLossesById ?? {};
        const _mlbPitcherNameById = sportByteam.mlb?.pitcherNameById ?? {};
        const _mlbPitchersByGame = {};
        for (const [gameSideKey, pid] of Object.entries(_mlbPitcherIdByGame)) {
          if (!pid) continue;
          const name = _mlbPitcherNameById[pid];
          if (!name) continue;
          _mlbPitchersByGame[gameSideKey] = {
            name,
            id: pid,
            era: _mlbPitcherEraById[pid] ?? null,
            wins: _mlbPitcherWinsById[pid] ?? null,
            losses: _mlbPitcherLossesById[pid] ?? null,
          };
        }
        // Build {team: {ml, total, spread}} from raw gameOdds, optionally normalizing team abbrs.
        const _buildOddsMap = (raw, normMap = null) => {
          const out = {};
          for (const [abbr, odds] of Object.entries(raw ?? {})) {
            const key = normMap?.[abbr] || abbr;
            out[key] = { ml: odds.moneyline ?? null, total: odds.total ?? null, spread: odds.spread ?? null };
          }
          return out;
        };
        const _mlbGameOdds = _buildOddsMap(sportByteam.mlb?.gameOdds);
        // Tomorrow's gameOdds from ESPN scoreboard (sb1.events parsed at the byteam build site).
        const _mlbGameOddsTomorrow = _buildOddsMap(sportByteam.mlb?.gameOddsTomorrow);
        // Kalshi-derived fallback for MLB game ML + total. ESPN doesn't post tomorrow's lines
        // until close to first pitch; Kalshi's KXMLBGAME / KXMLBTOTAL markets are priced earlier.
        // We fill only missing fields so ESPN remains authoritative once it has data.
        try {
          const _kGameDate = (m) => m?.expected_expiration_time ? PT_FMT.format(new Date(m.expected_expiration_time)) : null;
          const _kImpliedProb = (m) => {
            const a = parseFloat(m.yes_ask_dollars) || 0;
            const l = parseFloat(m.last_price_dollars) || 0;
            const b = parseFloat(m.yes_bid_dollars) || 0;
            return (a >= 0.98 && b === 0 && l > 0) ? l : (a > 0 ? a : l);
          };
          const _toAmerican = (p) => {
            if (!p || p <= 0 || p >= 1) return null;
            return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
          };
          const kOdds = {}; // "{abbr}|{abbr}|{gameDate}" → { total, mlByTeam: {abbr: ml} }
          // KXMLBGAME isn't in SERIES_CONFIG (it's not a player-prop series). The /api/kalshi-snapshot
          // cron writes kalshi:snap:KXMLBGAME alongside the rest; try that first, then fall back to
          // the legacy kalshi:KXMLBGAME bundle and finally a direct REST fetch.
          let _gameMarkets = [];
          {
            const _gSnapKey = 'kalshi:snap:KXMLBGAME';
            const _gKey = 'kalshi:KXMLBGAME';
            let _gData = null;
            if (CACHE2 && !isBustCache) {
              const _gSnap = await CACHE2.get(_gSnapKey, 'json').catch(() => null);
              if (_gSnap && Array.isArray(_gSnap.markets) && _gSnap.markets.length > 0 &&
                  (Date.now() - (_gSnap.writtenAt || 0) <= 180_000)) {
                _gData = { markets: _gSnap.markets };
              }
            }
            if (!_gData && CACHE2 && !isBustCache) {
              _gData = await CACHE2.get(_gKey, 'json').catch(() => null);
            }
            if (!_gData) {
              const r = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMLBGAME&limit=1000&status=open', {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
              }).catch(() => null);
              if (r?.ok) {
                _gData = await r.json().catch(() => null);
                if (_gData && CACHE2) CACHE2.put(_gKey, JSON.stringify(_gData), { expirationTtl: 600 }).catch(() => {});
              }
            }
            _gameMarkets = _gData?.markets || [];
          }
          if (_gameMarkets.length > 0) {
            const byEvent = {};
            for (const m of _gameMarkets) {
              const tk = m.ticker || '';
              const lastDash = tk.lastIndexOf('-');
              if (lastDash < 0) continue;
              const abbr = tk.slice(lastDash + 1);
              const eventT = m.event_ticker;
              if (!eventT || !abbr) continue;
              const p = _kImpliedProb(m);
              if (!p || p <= 0 || p >= 1) continue;
              if (!byEvent[eventT]) byEvent[eventT] = { probs: {}, gameDate: _kGameDate(m) };
              byEvent[eventT].probs[abbr] = p;
            }
            for (const info of Object.values(byEvent)) {
              const teams = Object.keys(info.probs);
              if (teams.length !== 2 || !info.gameDate) continue;
              const [t1, t2] = teams;
              const sum = info.probs[t1] + info.probs[t2];
              if (sum <= 0) continue;
              const _resolved = Math.min(info.probs[t1], info.probs[t2]) <= 0.02
                              || Math.max(info.probs[t1], info.probs[t2]) >= 0.99;
              const _attr = _reattrMlbGameDate(info.gameDate, t1, t2, _resolved);
              const ml1 = _toAmerican(info.probs[t1] / sum);
              const ml2 = _toAmerican(info.probs[t2] / sum);
              const payload = { mlByTeam: { [t1]: ml1, [t2]: ml2 } };
              const k1 = `${t1}|${t2}|${_attr}`;
              const k2 = `${t2}|${t1}|${_attr}`;
              kOdds[k1] = { ...(kOdds[k1] || {}), ...payload };
              kOdds[k2] = { ...(kOdds[k2] || {}), ...payload };
            }
          }
          const _tIdx = seriesTickers.indexOf('KXMLBTOTAL');
          if (_tIdx >= 0) {
            const byEvent = {};
            for (const m of (kalshiResults[_tIdx]?.markets || [])) {
              const strike = parseFloat(m.floor_strike);
              if (isNaN(strike)) continue;
              const thr = Math.round(strike + 0.5);
              const p = _kImpliedProb(m);
              const pct = Math.round(p * 100);
              if (pct <= 0 || pct >= 100) continue;
              const [t1, t2] = parseGameTeams(m.event_ticker, 'mlb');
              if (!t1 || !t2) continue;
              const eventT = m.event_ticker;
              if (!byEvent[eventT]) byEvent[eventT] = { thrs: [], teams: [t1, t2], gameDate: _kGameDate(m) };
              byEvent[eventT].thrs.push({ thr, pct });
            }
            for (const info of Object.values(byEvent)) {
              if (!info.gameDate) continue;
              info.thrs.sort((a, b) => a.thr - b.thr);
              let line = null;
              for (const x of info.thrs) { if (x.pct >= 50) line = x.thr - 0.5; }
              if (line == null) continue;
              const [t1, t2] = info.teams;
              // Resolved when no threshold sits in an actively-trading band [5,95].
              const _resolved = !info.thrs.some(x => x.pct >= 5 && x.pct <= 95);
              const _attr = _reattrMlbGameDate(info.gameDate, t1, t2, _resolved);
              const k1 = `${t1}|${t2}|${_attr}`;
              const k2 = `${t2}|${t1}|${_attr}`;
              kOdds[k1] = { ...(kOdds[k1] || {}), total: line };
              kOdds[k2] = { ...(kOdds[k2] || {}), total: line };
            }
          }
          // Fill missing fields on _mlbGameOdds / _mlbGameOddsTomorrow from kOdds.
          const _ptToday = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
          for (const sc of Object.values(sportByteam.mlb?.gameScores ?? {})) {
            const hA = sc?.homeTeam, aA = sc?.awayTeam, gD = sc?.gameDate;
            if (!hA || !aA || !gD) continue;
            const k = kOdds[`${hA}|${aA}|${gD}`];
            if (!k) continue;
            const map = (gD > _ptToday) ? _mlbGameOddsTomorrow : _mlbGameOdds;
            if (!map[hA]) map[hA] = { ml: null, total: null, spread: null };
            if (!map[aA]) map[aA] = { ml: null, total: null, spread: null };
            if (map[hA].ml == null && k.mlByTeam?.[hA] != null) map[hA].ml = k.mlByTeam[hA];
            if (map[aA].ml == null && k.mlByTeam?.[aA] != null) map[aA].ml = k.mlByTeam[aA];
            if (map[hA].total == null && k.total != null) map[hA].total = k.total;
            if (map[aA].total == null && k.total != null) map[aA].total = k.total;
          }
        } catch { /* non-fatal */ }
        // Closing-line preservation: ESPN drops odds once a game starts. Snapshot pre-game
        // odds keyed by "{home}|{away}|{gameDate}" so once state transitions to in/post we can
        // overlay the last pre-game odds (= closing line) onto live odds maps. Single global
        // Redis key (`mlbClosingOdds`) survives date rollover; 36h TTL refreshes on each write.
        try {
          const _scores = sportByteam.mlb?.gameScores ?? {};
          const _odsSnapKey = 'mlbClosingOdds';
          const _odsSnapPrev = (CACHE2 && !isBustCache) ? ((await CACHE2.get(_odsSnapKey, 'json').catch(() => null)) || {}) : {};
          const _odsSnap = { ..._odsSnapPrev };
          let _odsSnapDirty = false;
          for (const sc of Object.values(_scores)) {
            const hA = sc?.homeTeam, aA = sc?.awayTeam, gD = sc?.gameDate, state = sc?.state;
            if (!hA || !aA || !gD) continue;
            const gK = `${hA}|${aA}|${gD}`;
            // Pick live odds from the day's source: today odds for today's games, tomorrow odds for tomorrow's.
            const liveMap = (gD > new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10)) ? _mlbGameOddsTomorrow : _mlbGameOdds;
            const homeLive = liveMap[hA];
            const awayLive = liveMap[aA];
            if (state === 'pre') {
              if ((homeLive && (homeLive.ml != null || homeLive.total != null)) ||
                  (awayLive && (awayLive.ml != null || awayLive.total != null))) {
                _odsSnap[gK] = { home: homeLive ?? null, away: awayLive ?? null };
                _odsSnapDirty = true;
              }
            } else if (state === 'in' || state === 'post') {
              const snap = _odsSnap[gK];
              if (snap) {
                if (snap.home) liveMap[hA] = snap.home;
                if (snap.away) liveMap[aA] = snap.away;
              } else {
                // No closing snapshot (game started before we captured it). Clear odds so we
                // don't show misleading in-game model values from ESPN-cache/Kalshi-live.
                delete liveMap[hA];
                delete liveMap[aA];
              }
            }
          }
          if (_odsSnapDirty && CACHE2) CACHE2.put(_odsSnapKey, JSON.stringify(_odsSnap), { expirationTtl: 36 * 3600 }).catch(() => {});
        } catch { /* non-fatal */ }
        const mlbMeta = { pitchers: _mlbPitchers, pitchersByGame: _mlbPitchersByGame, gameOdds: _mlbGameOdds, umpires: sportByteam.mlb?.umpireByGame ?? {}, weather: weatherByGame, projectedLineupTeams: sportByteam.mlb?.projectedLineupTeams ?? [], teamsWithLineup: Object.keys(sportByteam.mlb?.lineupSpotByName ?? {}), homeTeams: sportByteam.mlb?.gameHomeTeams ?? {}, gameScores: sportByteam.mlb?.gameScores ?? {} };
        // Build mlbMetaTomorrow: tomorrow's probables + umpires (no lineup/weather data available yet)
        let mlbMetaTomorrow = { pitchers: {}, pitchersByGame: {}, gameOdds: _mlbGameOddsTomorrow, umpires: {}, weather: {}, projectedLineupTeams: [], teamsWithLineup: [], homeTeams: {}, gameScores: {} };
        try {
          const _tmrPT = new Date(Date.now() - 7 * 3600 * 1000 + 86400 * 1000);
          const _tmrDateStr = _tmrPT.toISOString().slice(0, 10);
          const _tmrCacheKey = `mlbSchedTomorrow:${_tmrDateStr}`;
          const _tmrCached = CACHE2 && !isBustCache ? await CACHE2.get(_tmrCacheKey, 'json').catch(() => null) : null;
          const _tmrSched = _tmrCached ?? await fetch(
            `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tmrDateStr}&hydrate=probablePitcher,officials`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          ).then(r => r.ok ? r.json() : {}).catch(() => ({}));
          if (!_tmrCached && CACHE2) CACHE2.put(_tmrCacheKey, JSON.stringify(_tmrSched), { expirationTtl: 600 }).catch(() => {});
          const _tmrPitchers = {}, _tmrUmpires = {}, _tmrHomeTeams = {};
          const _tmrPitcherIdsByAbbr = {}; // abbr → MLB Stats API id
          const _tmrPitchersByGame = {}; // "{team}|{gameKey}" → pitcher entry (DH-safe)
          const _tmrTrimSec = (iso) => (iso ? iso.replace(/:\d{2}Z$/, 'Z') : null);
          const _tmrGameEntries = []; // [{abbr, gameKey, id, name}] — fill stats later
          for (const _td of _tmrSched.dates || []) {
            for (const _tg of _td.games || []) {
              const _tHome = MLB_ID_TO_ABBR[_tg.teams?.home?.team?.id] || _tg.teams?.home?.team?.abbreviation;
              const _tAway = MLB_ID_TO_ABBR[_tg.teams?.away?.team?.id] || _tg.teams?.away?.team?.abbreviation;
              const _tHomeName = _tg.teams?.home?.probablePitcher?.fullName;
              const _tAwayName = _tg.teams?.away?.probablePitcher?.fullName;
              const _tHomeId = _tg.teams?.home?.probablePitcher?.id || null;
              const _tAwayId = _tg.teams?.away?.probablePitcher?.id || null;
              const _gameKey = _tmrTrimSec(_tg.gameDate);
              if (_tHome && _tHomeName) {
                _tmrPitchers[_tHome] = { name: _tHomeName, id: _tHomeId, era: null, wins: null, losses: null };
                if (_tHomeId) _tmrPitcherIdsByAbbr[_tHome] = _tHomeId;
                if (_gameKey) _tmrGameEntries.push({ abbr: _tHome, gameKey: _gameKey, id: _tHomeId, name: _tHomeName });
              }
              if (_tAway && _tAwayName) {
                _tmrPitchers[_tAway] = { name: _tAwayName, id: _tAwayId, era: null, wins: null, losses: null };
                if (_tAwayId) _tmrPitcherIdsByAbbr[_tAway] = _tAwayId;
                if (_gameKey) _tmrGameEntries.push({ abbr: _tAway, gameKey: _gameKey, id: _tAwayId, name: _tAwayName });
              }
              const _tHp = (_tg.officials || []).find(o => o.officialType === 'Home Plate');
              if (_tHp?.official?.fullName && _tHome && _tAway) _tmrUmpires[`${_tHome}|${_tAway}`] = _tHp.official.fullName;
              if (_tHome) _tmrHomeTeams[_tHome] = _tHome;
            }
          }
          // Hydrate tomorrow's probables with ERA + W-L (one MLB Stats API call, cached).
          const _tmrIds = Object.values(_tmrPitcherIdsByAbbr).filter(Boolean);
          const _tmrStatsById = {};
          if (_tmrIds.length > 0) {
            const _tmrStatsKey = `mlbTmrPitcherStats:${_tmrDateStr}`;
            const _tmrStatsCached = CACHE2 && !isBustCache ? await CACHE2.get(_tmrStatsKey, 'json').catch(() => null) : null;
            const _tmrStatsRes = _tmrStatsCached ?? await fetch(
              `https://statsapi.mlb.com/api/v1/people?personIds=${_tmrIds.join(',')}&hydrate=stats(group=pitching,type=season,season=2026,gameType=R)`,
              { headers: { 'User-Agent': 'Mozilla/5.0' } }
            ).then(r => r.ok ? r.json() : {}).catch(() => ({}));
            if (!_tmrStatsCached && CACHE2) CACHE2.put(_tmrStatsKey, JSON.stringify(_tmrStatsRes), { expirationTtl: 600 }).catch(() => {});
            for (const _p of (_tmrStatsRes.people || [])) {
              const _split = _p.stats?.[0]?.splits?.[0]?.stat;
              if (_split) _tmrStatsById[_p.id] = _split;
            }
            for (const [abbr, id] of Object.entries(_tmrPitcherIdsByAbbr)) {
              const _s = _tmrStatsById[id];
              if (!_s || !_tmrPitchers[abbr]) continue;
              const _era = parseFloat(_s.era);
              if (!isNaN(_era)) _tmrPitchers[abbr].era = _era;
              if (typeof _s.wins === 'number') _tmrPitchers[abbr].wins = _s.wins;
              if (typeof _s.losses === 'number') _tmrPitchers[abbr].losses = _s.losses;
            }
          }
          // Populate per-game map now that stats are resolved.
          for (const { abbr, gameKey, id, name } of _tmrGameEntries) {
            const _s = id ? _tmrStatsById[id] : null;
            const _era = _s ? parseFloat(_s.era) : NaN;
            _tmrPitchersByGame[`${abbr}|${gameKey}`] = {
              name,
              id,
              era: !isNaN(_era) ? _era : null,
              wins: typeof _s?.wins === 'number' ? _s.wins : null,
              losses: typeof _s?.losses === 'number' ? _s.losses : null,
            };
          }
          mlbMetaTomorrow = { pitchers: _tmrPitchers, pitchersByGame: _tmrPitchersByGame, gameOdds: _mlbGameOddsTomorrow, umpires: _tmrUmpires, weather: {}, projectedLineupTeams: [], teamsWithLineup: [], homeTeams: _tmrHomeTeams, gameScores: {} };
        } catch { /* leave empty */ }
        // Sport meta builders — same shape, varying inputs. injuryMap entries get enriched with
        // avgMin from the usage map (frontend filters the matchup-card injury badge to starters
        // only: NBA avgMin >= 25, WNBA >= 20 for 40-min game). Dual-keyed (normalized + raw) so
        // either abbr form looks up.
        const _enrichInjuries = (injuryMap, usageMap, normMap) => {
          const out = {};
          for (const [abbr, players] of (injuryMap || new Map()).entries()) {
            const enriched = players.map(p => ({ ...p, avgMin: (p.id && usageMap[p.id]?.avgMin) ?? null }));
            const key = normMap[abbr] || abbr;
            out[key] = enriched;
            out[abbr] = enriched;
          }
          return out;
        };
        const _buildSportMeta = async (snapKey, gameOddsRaw, normMap, scoresMap, topPlayers, injuries) => {
          const gameOdds = _buildOddsMap(gameOddsRaw, normMap);
          await applyClosingSnapshot(CACHE2, isBustCache, snapKey, scoresMap, gameOdds);
          return { gameOdds, injuries, gameScores: scoresMap ?? {}, topPlayers: topPlayers ?? {} };
        };
        const nbaMeta = await _buildSportMeta(
          'nbaClosingOdds', sportByteam.nbaGameOdds, TEAM_NORM.nba,
          sportByteam.nbaGameScores, sportByteam.nbaTopPlayers,
          _enrichInjuries(nbaInjuryMap, nbaUsageMap, TEAM_NORM.nba)
        );
        const wnbaMeta = await _buildSportMeta(
          'wnbaClosingOdds', sportByteam.wnbaGameOdds, TEAM_NORM.wnba,
          sportByteam.wnbaGameScores, sportByteam.wnbaTopPlayers,
          _enrichInjuries(wnbaInjuryMap, wnbaUsageMap, TEAM_NORM.wnba)
        );
        // NHL: no usage map, so injuries pass through unenriched (matchup card shows all NHL out players).
        const nhlMeta = await _buildSportMeta(
          'nhlClosingOdds', sportByteam.nhlGameOdds, {},
          sportByteam.nhlGameScores, sportByteam.nhlTopPlayers,
          sportByteam.nhl?.injuryByTeam ?? {}
        );
        const playsResult = { plays, nbaDropped, mlbMeta, mlbMetaTomorrow, nbaMeta, wnbaMeta, nhlMeta, staleKalshiSeries, qualifyingCount: qualifyingMarkets.length, totalMarketsCount: totalMarkets.length, preFilteredCount: preFilteredMarkets.length };
        const sportsInPlays = new Set(plays.map((p) => p.sport));
        if (CACHE2 && sportsInPlays.size >= 2) {
          const summary = {
            date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
            count: plays.length,
            sports: plays.reduce((acc, p) => {
              acc[p.sport] = (acc[p.sport] || 0) + 1;
              return acc;
            }, {}),
            avgEdge: plays.length ? parseFloat((plays.reduce((s, p) => s + (p.edge || 0), 0) / plays.length).toFixed(1)) : 0,
            avgTruePct: plays.length ? parseFloat((plays.reduce((s, p) => s + (p.truePct || 0), 0) / plays.length).toFixed(1)) : 0
          };
          await CACHE2.put(`plays:daily:${summary.date}`, JSON.stringify(summary), { expirationTtl: 7776e3 }).catch(() => {
          });
        }
        return jsonResponse(playsResult, true);
      } else {
        return errorResponse("Unknown route: " + path, 404);
      }
    } catch (e) {
      return errorResponse(e.message, 500);
    }
  }
};

export const config = { runtime: 'edge' }; // redeploy 2

export default async function handler(request) {
  const env = {
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_KEY: process.env.ADMIN_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
  };
  const ctx = { waitUntil: (p) => { try { p.catch?.(() => {}); } catch {} } };
  return worker_default.fetch(request, env, ctx);
}
