// api/lib/handlers/tonight.js
// Extracted from api/[...path].js during Phase A (2026-05-26). Zero behavior change —
// imports + helpers needed only by the tonight pipeline moved with the block. The
// outer indentation level (8 spaces) is preserved from the original nesting; future
// phases will reformat.
import { ALLOWED_ORIGIN, corsHeaders, jsonResponse, errorResponse, fetchSafe, parseGameOdds, parseGameScores, parseTopPlayers, buildSoftTeamAbbrs, buildHardTeamAbbrs, buildTeamRankMap, pLimit } from "../utils.js";
import { PARK_KFACTOR, PARK_HITFACTOR, PARK_RUNFACTOR, UMPIRE_KFACTOR, log5K, poissonCDF, log5HitRate, simulateKsDist, kDistPct, buildNbaStatDist, nbaDistPct, simulateMLBTotalDist, simulateMLBJoint, simulateNBAJoint, mlPctFromJoint, joint3WayPct, spreadPctFromJoint, simulateNBATotalDist, simulateNHLTotalDist, totalDistPct, simulateTeamTotalDist, simulateTeamPtsDist, lambdaForPoissonTail, muForNegBinTail, negBinCDF, meanForNormalTail, normCDF } from "../simulate.js";
import { buildLineupKPct, buildBarrelPct, buildPitcherKPct, MLB_ID_TO_ABBR, buildMlbByteam, buildMlbInjuryReport } from "../mlb.js";
import { buildNbaDepthChartPos, buildNbaDvpFromBettingPros, buildNbaPaceData, buildNbaPlayerPosFromSleeper, buildNbaUsageRate, buildNbaInjuryReport, buildNbaByteam } from "../nba.js";
import { buildWnbaPaceData, buildWnbaUsageRate, buildWnbaInjuryReport, buildWnbaDvp, WNBA_TEAM_IDS, WNBA_ESPN_TO_CANON, WNBA_CANON_TO_ESPN, buildWnbaByteam } from "../wnba.js";
import { SERIES_CONFIG } from "../series-config.js";
import { buildNhlGoalieData, buildNhlInjuryReport, buildNhlSpecialTeams, NHL_ABBR_MAP } from "../nhl.js";
import { verifyJWT } from "../auth-utils.js";
import { PT_FMT } from "../pt.js";
import { computeDataConfidence, DC_GATE, _GT_IMPLIED_CAP, _TT_IMPLIED_CAP } from "../tonight/dc.js";
import { applyClosingSnapshot } from "../tonight/closing-odds.js";
import { fetchKalshiMarkets } from "../tonight/kalshi-pipeline.js";
import { blendMarketPrice } from "../tonight/blend-fill.js";
import { KALSHI_GATE, KALSHI_CAP, CAPTURE_GATE, CAPTURE_CAP, CAPTURE_MAX_SPREAD, capturableSpread, EDGE_GATE_SERVER as EDGE_GATE } from "../config.js";
import { TEAM_NORM, normTeam, parseGameTeams } from "../tonight/parse-teams.js";
import { dedupAltLines } from "../tonight/dedup.js";
import { emitAllMlAndSpread } from "../tonight/ml-spread.js";
import { emitGameTotalPlays } from "../tonight/game-totals.js";
import { emitPropPlays } from "../tonight/props.js";
import { emitTennisMatchPlays } from "../tonight/tennis-match.js";
import { emitSoccerPlays } from "../tonight/soccer.js";
import { emitSoccerAdvancePlays } from "../tonight/soccer-advance.js";
import { WC_TEAMS } from "../soccer.js";
import { emitFightPlays } from "../tonight/fight.js";
import { emitGolfH2hPlays } from "../tonight/golf-h2h.js";
import { emitNascarPlays } from "../tonight/nascar.js";
import { emitNbaSummerPlays } from "../tonight/nba-summer.js";
import { emitLmbPlays } from "../tonight/lmb-ml.js";
import { emitModelFreeMlPlays } from "../tonight/model-free-ml.js";
import { MODEL_FREE_LEAGUE_KEYS } from "../model-free-leagues.js";
import { emitClubSoccerThresholdPlays } from "../tonight/club-soccer-threshold.js";
import { emitScoCupPlays } from "../tonight/scocup.js";
import { emitMlbOutsPlays } from "../tonight/mlb-outs.js";
import { fetchPolymarketGames } from "../polymarket.js";
import { emitPolymarketDeltas } from "../tonight/polymarket-deltas.js";
import { enrichDeltasWithExec } from "../polymarket-book.js";
import { fetchSportsbookGames } from "../sportsbook.js";
import { emitSportsbookDeltas } from "../tonight/sportsbook-deltas.js";

const __defProp = Object.defineProperty;
const __name = (target, value) => __defProp(target, "name", { value, configurable: true });
// Production sport set (sports with active play generation + matchup cards). NFL is
// supported in code but not currently in any active Kalshi market lookup paths.
const PROD_SPORTS = new Set(["mlb", "nba", "nhl", "wnba"]);
// B2B_*, _isB2B, and injury helpers moved to api/lib/tonight/game-totals.js (Phase B5, 2026-05-29).
const normName = /* @__PURE__ */ __name((s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(), "normName");
const ESPN_BASE = "https://site.web.api.espn.com/apis";
const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports";

// ── Module-level pure helpers ─────────────────────────────────────────────────────────────────
// Hoisted from handleTonightRoute body (Phase B, 2026-05-29). No closure deps — safe at module
// scope. These replace the old inline `let x = function...` chain.

// Did an authoritative source confirm a game play's home/away orientation, or did the emit
// fall back to Kalshi ticker order (which doesn't match ESPN — see "Kalshi ticker home/away
// order" gotcha)? Used by the client Place All pre-flight to block swap-risk plays. Mirrors the
// per-branch swap logic in game-totals.js/ml-spread.js: MLB consults gameHomeTeams; NBA/WNBA/NHL
// scan gameScores; props have no home/away bet side so return null. Returns 'authoritative' |
// 'fallback' | null.
function _homeAwayResolved(p, sportByteam) {
  const gt = p.gameType;
  if (gt !== "total" && gt !== "teamTotal" && gt !== "spread" && gt !== "ml") return null;
  const a = gt === "teamTotal" ? p.scoringTeam : p.homeTeam;
  const b = gt === "teamTotal" ? p.oppTeam : p.awayTeam;
  if (!a || !b) return "fallback";
  if (p.sport === "mlb") {
    const ghm = sportByteam.mlb?.gameHomeTeams || {};
    return ghm[a] || ghm[b] ? "authoritative" : "fallback";
  }
  const gs = p.sport === "nba" ? sportByteam.nbaGameScores
    : p.sport === "wnba" ? sportByteam.wnbaGameScores
    : p.sport === "nhl" ? sportByteam.nhlGameScores : null;
  if (!gs) return "fallback";
  for (const g of Object.values(gs)) {
    if (!g) continue;
    if ((g.homeTeam === a && g.awayTeam === b) || (g.homeTeam === b && g.awayTeam === a)) return "authoritative";
  }
  return "fallback";
}

function nhlSoftTeams(arr, sortKey, label, unit, n = 10) {
  const sorted = [...arr].sort((a, b) => b[sortKey] - a[sortKey]);
  const softTeams = new Set();
  const rankMap = {};
  sorted.forEach((t, i) => {
    const abbr = NHL_ABBR_MAP[t.teamId];
    if (!abbr) return;
    rankMap[abbr] = { rank: i + 1, value: parseFloat((t[sortKey] || 0).toFixed(2)), label, unit };
    if (i < n) softTeams.add(abbr);
  });
  return { softTeams, rankMap };
}

function mlbSoftTeams(data, isPitcherStat, n = 10) {
  const topCats = data?.categories || [];
  const catName = isPitcherStat ? "batting" : "pitching";
  const keyword = isPitcherStat ? "strikeout" : "era";
  const label = isPitcherStat ? "lineup Ks" : "ERA";
  const unit = isPitcherStat ? "" : "ERA";
  const topCat = topCats.find((c) => c.name === catName);
  const statIdx = (topCat?.names || []).findIndex((nm) => nm.toLowerCase().includes(keyword));
  if (statIdx === -1) return { softTeams: new Set(), rankMap: {} };
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
}

function glCacheKey(key) {
  const [sport] = key.split("|");
  // Non-MLB version bumped v2→v3 on 2026-05-16: gamelog event shape now includes
  // `isHome` (was missing from `parseEspnGamelog`), which the NBA/WNBA home-away
  // split adjustment depends on. Old v2 cache entries lack isHome → splitAdj always
  // falls back to 1.0. Bumping invalidates them in one cycle.
  return sport === "mlb" ? `gl:mlb242526v2|${key}` : `gl:v3|${key}`;
}

// Parse wind direction from ESPN displayValue: "Out to LF" → positive, "In from CF" → negative, crosswind → 0.
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


export async function handleTonightRoute({ path, params, request, env, CACHE2, runtimeCtx }) {
  if (path !== "tonight") return null;
  const ctx = runtimeCtx;
  const JWT_SECRET = env?.JWT_SECRET;
        // nhlSoftTeams / mlbSoftTeams / glCacheKey / _parseWind / _extractMlbWeather
        // / injury helpers — moved to module level (Phase B, 2026-05-29).
        const isDebugMode = params.get("debug") === "1";
        // FD/socket pressure probe (EMFILE/EBUSY hunt 2026-07-05): snapshot open-FD count and
        // active libuv resource types at run start + response time. Debug-only, failure-closed.
        const _fdProbe = async () => {
          const out = {};
          try {
            const fs = await import("node:fs");
            const names = fs.readdirSync("/proc/self/fd");
            out.fds = names.length;
            // Classify each fd by its readlink target: socket:/pipe:/anon_inode:<type>/file path.
            const byKind = {};
            for (const n of names) {
              let kind = "?";
              try {
                const t = fs.readlinkSync(`/proc/self/fd/${n}`);
                kind = t.startsWith("socket:") ? "socket"
                  : t.startsWith("pipe:") ? "pipe"
                  : t.startsWith("anon_inode:") ? t.slice(0, 24)
                  : t.slice(0, 24);
              } catch { /* raced a close */ }
              byKind[kind] = (byKind[kind] || 0) + 1;
            }
            out.byKind = Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 8));
          } catch (e) { out.fds = null; out.fdErr = String(e?.code || e?.message || e).slice(0, 60); }
          try {
            const res = typeof process?.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
            const byType = {};
            for (const t of res) byType[t] = (byType[t] || 0) + 1;
            out.resources = byType;
          } catch { out.resources = null; }
          return out;
        };
        const _fdMilestones = [];
        const _fdMark = async (label) => { if (isDebugMode) { try { _fdMilestones.push({ label, ...(await _fdProbe()) }); } catch { /* probe never breaks the run */ } } };
        await _fdMark("start");
        const isBustCache = params.get("bust") === "1";
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
        // SERIES_CONFIG imported from api/lib/series-config.js; TEAM_NORM / normTeam / weather
        // helpers / injury helpers — module-level (Phase B, 2026-05-29).
        const seriesTickers = Object.keys(SERIES_CONFIG);
        // 3-tier Kalshi read chain (snap → bundle → REST + stale). See lib/tonight/kalshi-pipeline.js.
        const { kalshiResults, staleKalshiSeries, kalshiSnapMeta, kalshiUsedSnaps } =
          await fetchKalshiMarkets({ seriesTickers, cache: CACHE2, env, isBustCache });
        await _fdMark("afterKalshi");
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
        const tennisMatchMarkets = []; // ATP/WTA match-winner — every priced side (favorite + dog), grouped by event in emit
        const soccerMarkets = []; // WC — every priced side across all 5 families, grouped by event in emit
        const soccerAdvanceMarkets = []; // WC knockout "to advance" — each priced side carries its tie + side code
        const fightMarkets = []; // UFC rounds O/U — every priced threshold, grouped by event in emit
        const golfH2hMarkets = []; // PGA single-round head-to-head — each priced side carries its own matchup
        const nascarMarkets = []; // NASCAR Cup H2H + Top-10 — each priced side carries its own driver(s)
        const nbaSummerMarkets = []; // NBA Summer League game winner — each priced side carries its own pick + opponent
        const lmbMarkets = []; // LMB (Mexican League) game winner — each priced side carries its own pick + opponent
        // Model-free soccer game winners, keyed by league (was six separate hand-declared arrays).
        // Each priced side (home/away/tie) lands in its league's bucket and is grouped by event in
        // the emit path; the buckets stay separate because each league resolves gameTime/results
        // off a different ESPN league endpoint.
        const modelFreeMarkets = {};
        const clubSoccerThresholdMarkets = []; // MLS/Liga MX/Argentina spread/total/BTTS + team-total (model-free, threshold shape) — one shared array, sport-tagged per row
        const scocupSpreadMarkets = []; // Scottish League Cup spread (model-free, threshold shape) — each priced threshold carries its team's subtitle name
        const scocupTotalMarkets = []; // Scottish League Cup total (model-free, threshold shape) — no team identity, joined to spread siblings by event segment
        const outsMarkets = []; // MLB pitcher outs-recorded O/U (KXMLBOUTS) — each priced threshold carries its pitcher
        const globalSeen = /* @__PURE__ */ new Set();
        for (let i = 0; i < seriesTickers.length; i++) {
          const ticker = seriesTickers[i];
          const cfg = SERIES_CONFIG[ticker];
          const { sport, stat, col } = cfg;
          const segment = cfg.segment || "full"; // "f5" for segmented markets, "full" otherwise
          for (const m of kalshiResults[i].markets || []) {
            // ── Tennis match-winner branch ── binary markets have no floor_strike, so handle
            // before strike parsing. Collect EVERY priced side (favorite + underdog) keyed by
            // event_ticker; emitTennisMatchPlays groups them so each side knows its opponent and
            // emits only the favorite (Kalshi in [67,91]). Not team-based → skips parseGameTeams.
            if (cfg.gameType === "tennisMatch") {
              const _tYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _tLast = parseFloat(m.last_price_dollars) || 0;
              const _tYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _tPrice = (_tYesAsk >= 0.98 && _tYesBid === 0 && _tLast > 0) ? _tLast : (_tYesAsk > 0 ? _tYesAsk : _tLast);
              if (_tPrice === 0) continue; // no live book — skip (tennis books fill near match time; sparse is expected)
              const _tPct = Math.round(_tPrice * 100);
              const _tVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _tTitle = m.title || m.event_title || "";
              // Pick player full name: yes_sub_title is exact; fall back to the title's subject.
              let _tPick = (m.yes_sub_title || "").trim();
              if (!_tPick) { const _mm = _tTitle.match(/^Will\s+(.+?)\s+win the\b/i); if (_mm) _tPick = _mm[1].trim(); }
              if (!_tPick) continue;
              // Opponent last name + matchup label from "... win the <A> vs <B>: <round> match?".
              let _tOpp = null, _tMatchup = null;
              const _mvs = _tTitle.match(/win the\s+(.+?)\s+vs\s+([^:]+?)\s*:/i);
              if (_mvs) {
                const _a = _mvs[1].trim(), _b = _mvs[2].trim();
                _tMatchup = `${_a} vs ${_b}`;
                _tOpp = _tPick.toLowerCase().includes(_a.toLowerCase()) ? _b : _a;
              }
              // gameDate from event_ticker date segment (e.g. KXATPMATCH-26JUN14HIJGIR → 2026-06-14).
              const _tDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _tGameDate = null;
              if (_tDateSeg.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _tMo = _KMONT[_tDateSeg.slice(2, 5).toUpperCase()];
                if (_tMo) _tGameDate = `20${_tDateSeg.slice(0, 2)}-${_tMo}-${_tDateSeg.slice(5, 7)}`;
              }
              const _tAO = _tPct >= 50 ? Math.round(-(_tPct / (100 - _tPct)) * 100) : Math.round((100 - _tPct) / _tPct * 100);
              tennisMatchMarkets.push({ gameType: "tennisMatch", sport, tour: cfg.tour, eventTicker: m.event_ticker, player: _tPick, opponentRaw: _tOpp, matchup: _tMatchup, kalshiPct: _tPct, americanOdds: _tAO, kalshiVolume: _tVol, gameDate: _tGameDate, _ticker: m.ticker, _yesAsk: _tYesAsk, _depth: m._depth });
              continue;
            }
            // ── Soccer (World Cup) branch ── 5 market families, all keyed by event_ticker. The
            // event segment encodes date + the two FIFA codes (3+3), e.g. KXWCTOTAL-26JUN21BELIRI
            // → 2026-06-21, home BEL / away IRI (Kalshi lists home first). game/btts are binary
            // (no floor_strike); total/teamTotal/spread carry floor_strike. Collect every priced
            // side; emitSoccerPlays groups by event and projects all families off one matrix.
            if (cfg.gameType === "soccer") {
              const _scSub = cfg.subtype;
              const _scYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _scNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _scLast = parseFloat(m.last_price_dollars) || 0;
              const _scYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _scPrice = (_scYesAsk >= 0.98 && _scYesBid === 0 && _scLast > 0) ? _scLast : (_scYesAsk > 0 ? _scYesAsk : _scLast);
              if (_scPrice === 0) continue; // no live book — skip (books fill near kickoff)
              const _scYesPct = Math.round(_scPrice * 100);
              const _scNoPct = _scNoAsk > 0 ? Math.round(_scNoAsk * 100) : (100 - _scYesPct);
              const _scVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              // event segment → date + teams (3+3). Home = first code (Kalshi "A vs B" order).
              const _scSeg = (m.event_ticker || "").split("-")[1] || "";
              const _scDateSeg = _scSeg.slice(0, 7);
              const _scTeamsSeg = _scSeg.slice(7);
              let _scGameDate = null;
              if (_scDateSeg.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _scMo = _KMONT[_scDateSeg.slice(2, 5).toUpperCase()];
                if (_scMo) _scGameDate = `20${_scDateSeg.slice(0, 2)}-${_scMo}-${_scDateSeg.slice(5, 7)}`;
              }
              const _scHome = _scTeamsSeg.slice(0, 3), _scAway = _scTeamsSeg.slice(3, 6);
              if (!WC_TEAMS[_scHome] || !WC_TEAMS[_scAway]) continue; // unknown teams → drop
              const _scAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              const _scSuffix = (m.ticker || "").split("-").pop();
              const _scCommon = { subtype: _scSub, half: cfg.half || null, sport, eventTicker: m.event_ticker, homeCode: _scHome, awayCode: _scAway, gameDate: _scGameDate, kalshiVolume: _scVol, _ticker: m.ticker, _depth: m._depth };
              if (_scSub === "game") {
                let _side, _sideCode;
                if (_scSuffix === "TIE") { _side = "tie"; _sideCode = "TIE"; }
                else if (_scSuffix === _scHome) { _side = "home"; _sideCode = _scHome; }
                else if (_scSuffix === _scAway) { _side = "away"; _sideCode = _scAway; }
                else continue;
                soccerMarkets.push({ ..._scCommon, side: _side, sideCode: _sideCode, kalshiPct: _scYesPct, noKalshiPct: _scNoPct, americanOdds: _scAO(_scYesPct) });
              } else if (_scSub === "btts") {
                soccerMarkets.push({ ..._scCommon, yesPct: _scYesPct, noPct: _scNoPct, yesAO: _scAO(_scYesPct), noAO: _scAO(_scNoPct) });
              } else {
                const _scFloor = parseFloat(m.floor_strike);
                if (isNaN(_scFloor)) continue;
                let _scTeam = null;
                if (_scSub === "teamTotal" || _scSub === "spread") {
                  _scTeam = _scSuffix.replace(/\d+$/, "");
                  if (!WC_TEAMS[_scTeam]) continue;
                }
                soccerMarkets.push({ ..._scCommon, line: _scFloor, teamCode: _scTeam, yesPct: _scYesPct, noPct: _scNoPct, yesAO: _scAO(_scYesPct), noAO: _scAO(_scNoPct) });
              }
              continue;
            }
            // ── Soccer (World Cup) knockout "to advance" branch ── per-tie binary, two sides
            // ("<A> advances" / "<B> advances"). Event segment = date + 3+3 FIFA codes
            // (KXWCADVANCE-26JUN28RSACAN); the ticker suffix is the advancing team's code. Collect
            // every priced side; emitSoccerAdvancePlays folds the 90'-draw mass into a "to advance"
            // probability and emits the favorite side (Kalshi YES in [67,91]).
            if (cfg.gameType === "soccerAdvance") {
              const _aYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _aNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _aLast = parseFloat(m.last_price_dollars) || 0;
              const _aYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _aPrice = (_aYesAsk >= 0.98 && _aYesBid === 0 && _aLast > 0) ? _aLast : (_aYesAsk > 0 ? _aYesAsk : _aLast);
              if (_aPrice === 0) continue; // no live book — skip (books fill near kickoff)
              const _aYesPct = Math.round(_aPrice * 100);
              const _aNoPct = _aNoAsk > 0 ? Math.round(_aNoAsk * 100) : (100 - _aYesPct);
              const _aVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _aSeg = (m.event_ticker || "").split("-")[1] || "";
              const _aDateSeg = _aSeg.slice(0, 7);
              let _aGameDate = null;
              if (_aDateSeg.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _aMo = _KMONT[_aDateSeg.slice(2, 5).toUpperCase()];
                if (_aMo) _aGameDate = `20${_aDateSeg.slice(0, 2)}-${_aMo}-${_aDateSeg.slice(5, 7)}`;
              }
              const _aTeamsSeg = _aSeg.slice(7);
              const _aHome = _aTeamsSeg.slice(0, 3), _aAway = _aTeamsSeg.slice(3, 6);
              if (!WC_TEAMS[_aHome] || !WC_TEAMS[_aAway]) continue; // unknown teams → drop
              const _aSide = (m.ticker || "").split("-").pop();
              if (_aSide !== _aHome && _aSide !== _aAway) continue; // side code must be one of the two teams
              const _aAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              soccerAdvanceMarkets.push({ eventTicker: m.event_ticker, homeCode: _aHome, awayCode: _aAway, sideCode: _aSide, gameDate: _aGameDate, kalshiPct: _aYesPct, noKalshiPct: _aNoPct, americanOdds: _aAO(_aYesPct), kalshiVolume: _aVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── Fighting (UFC rounds O/U) branch ── binary "ends before round N" markets, grouped
            // by event_ticker. The threshold N is the ticker suffix (-2..-5); the event segment
            // encodes date + a fighter-code segment (last-name-based, e.g. 26JUN20COLTAN). Collect
            // every priced threshold; emitFightPlays matches codes→ESPN weight class and projects
            // the fight-duration CDF off it.
            if (cfg.gameType === "fight") {
              const _fN = parseInt((m.ticker || "").split("-").pop());
              if (!(_fN >= 2)) continue; // not a round threshold
              const _fYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _fNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _fLast = parseFloat(m.last_price_dollars) || 0;
              const _fYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _fPrice = (_fYesAsk >= 0.98 && _fYesBid === 0 && _fLast > 0) ? _fLast : (_fYesAsk > 0 ? _fYesAsk : _fLast);
              if (_fPrice === 0) continue; // no live book — skip (books fill near the event)
              const _fYesPct = Math.round(_fPrice * 100);
              const _fNoPct = _fNoAsk > 0 ? Math.round(_fNoAsk * 100) : (100 - _fYesPct);
              const _fVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _fSeg = (m.event_ticker || "").split("-")[1] || "";
              const _fDateSeg = _fSeg.slice(0, 7);
              let _fGameDate = null;
              if (_fDateSeg.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _fMo = _KMONT[_fDateSeg.slice(2, 5).toUpperCase()];
                if (_fMo) _fGameDate = `20${_fDateSeg.slice(0, 2)}-${_fMo}-${_fDateSeg.slice(5, 7)}`;
              }
              const _fCodeSeg = _fSeg.slice(7); // fighter codes (last-name based, usually 3+3)
              if (!_fCodeSeg) continue;
              const _fAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              fightMarkets.push({ eventTicker: m.event_ticker, codeSegment: _fCodeSeg, gameDate: _fGameDate, threshold: _fN, yesPct: _fYesPct, noPct: _fNoPct, yesAO: _fAO(_fYesPct), noAO: _fAO(_fNoPct), kalshiVolume: _fVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── Golf (PGA single-round head-to-head) branch ── binary "A beats B in round N"
            // markets. yes_sub_title carries the matchup + round; the event segment encodes the
            // tournament + round + player codes (KXPGAH2H-USO26R4SSCHWCLA). Each side is its own
            // candidate (favorite side emitted by emitGolfH2hPlays). gameDate = the round date,
            // taken from close_time (expiration_time is a generic +2wk settlement deadline).
            if (cfg.gameType === "golfH2h") {
              const _gm = (m.yes_sub_title || "").match(/^(.+?) beats (.+?) in the (\d+)(?:st|nd|rd|th) round/i);
              if (!_gm) continue;
              const _gPlayer = _gm[1].trim(), _gOpp = _gm[2].trim(), _gRound = parseInt(_gm[3]);
              if (!(_gRound >= 1)) continue;
              const _gYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _gLast = parseFloat(m.last_price_dollars) || 0;
              const _gYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _gPrice = (_gYesAsk >= 0.98 && _gYesBid === 0 && _gLast > 0) ? _gLast : (_gYesAsk > 0 ? _gYesAsk : _gLast);
              if (_gPrice === 0) continue; // no live book — skip (books fill near tee-off)
              const _gPct = Math.round(_gPrice * 100);
              const _gVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _gDate = (m.close_time || "").slice(0, 10) || null;
              const _gSeg = (m.event_ticker || "").split("-")[1] || "";
              const _gTourn = (_gSeg.match(/^([A-Z0-9]+?)R\d/) || [])[1] || _gSeg.slice(0, 5);
              const _gAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              golfH2hMarkets.push({ eventTicker: m.event_ticker, player: _gPlayer, opponent: _gOpp, round: _gRound, tournament: _gTourn, gameDate: _gDate, kalshiPct: _gPct, americanOdds: _gAO(_gPct), kalshiVolume: _gVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── NASCAR (Cup head-to-head + Top-10) branch ── binary markets. H2H yes_sub_title =
            // "<A> beats <B>"; Top-10 yes_sub_title = "<driver>". The event segment is the race
            // code (H2H also appends the two driver codes); emitNascarPlays groups nothing — each
            // priced side is its own candidate (favorite side in [67,91]). gameDate from close_time
            // (the race start ≈ close; the resolver tolerates a ±1-day UTC roll on night races).
            if (cfg.gameType === "nascar") {
              const _nYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _nLast = parseFloat(m.last_price_dollars) || 0;
              const _nYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _nPrice = (_nYesAsk >= 0.98 && _nYesBid === 0 && _nLast > 0) ? _nLast : (_nYesAsk > 0 ? _nYesAsk : _nLast);
              if (_nPrice === 0) continue; // no live book — skip (books fill near the green flag)
              const _nPct = Math.round(_nPrice * 100);
              const _nVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _nDate = (m.close_time || "").slice(0, 10) || null;
              const _nRace = (m.event_ticker || "").split("-")[1] || "";
              const _nAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              let _nPlayer = null, _nOpp = null;
              if (cfg.subtype === "h2h") {
                const _nm = (m.yes_sub_title || "").match(/^(.+?)\s+beats\s+(.+?)\s*$/i);
                if (!_nm) continue;
                _nPlayer = _nm[1].trim(); _nOpp = _nm[2].trim();
              } else { // top10
                _nPlayer = (m.yes_sub_title || "").trim();
                if (!_nPlayer) continue;
              }
              nascarMarkets.push({ subtype: cfg.subtype, eventTicker: m.event_ticker, raceCode: _nRace, player: _nPlayer, opponent: _nOpp, gameDate: _nDate, kalshiPct: _nPct, americanOdds: _nAO(_nPct), kalshiVolume: _nVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── NBA Summer League game-winner branch ── binary, two markets per event (one per
            // team). Event segment = date + team abbrs (KXNBASUMMERGAME-26JUL13DETNYK), parsed
            // with the regular NBA registry; the ticker suffix is the pick team's Kalshi abbr.
            // Liquidity-gated at parse (same doctrine as game rows 2026-07-11): SL books seed
            // only near game day — far-out listings quote ~70¢+ spreads on both sides.
            if (cfg.gameType === "nbaSummer") {
              const _slYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _slNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _slLast = parseFloat(m.last_price_dollars) || 0;
              const _slYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _slNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _slStale = _slYesAsk >= 0.98 && _slYesBid === 0 && _slLast > 0;
              const _slPrice = _slStale ? _slLast : (_slYesAsk > 0 ? _slYesAsk : _slLast);
              if (_slPrice === 0) continue; // no live book — skip (books fill near tip-off)
              const _slYesSpreadC = _slYesAsk > 0 ? Math.round((_slYesAsk - _slYesBid) * 100) : 999;
              const _slNoSpreadC = _slNoAsk > 0 ? Math.round((_slNoAsk - _slNoBid) * 100) : 999;
              if (!_slStale && !capturableSpread(Math.min(_slYesSpreadC, _slNoSpreadC))) continue;
              const _slPct = Math.round(_slPrice * 100);
              const _slVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              // SL tickers use the regular NBA Kalshi abbrs (validated 2+3/3+3 split).
              const [_slT1, _slT2] = parseGameTeams(m.event_ticker, "nba");
              if (!_slT1 || !_slT2) continue;
              const _slPick = normTeam("nba", (m.ticker || "").split("-").pop() || "");
              if (_slPick !== _slT1 && _slPick !== _slT2) continue;
              const _slDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _slGameDate = null;
              if (_slDateSeg.length >= 7) {
                const _KMONS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _slMo = _KMONS[_slDateSeg.slice(2, 5).toUpperCase()];
                if (_slMo) _slGameDate = `20${_slDateSeg.slice(0, 2)}-${_slMo}-${_slDateSeg.slice(5, 7)}`;
              }
              const _slAO = _slPct >= 50 ? Math.round(-(_slPct / (100 - _slPct)) * 100) : Math.round((100 - _slPct) / _slPct * 100);
              nbaSummerMarkets.push({ eventTicker: m.event_ticker, gameTeam1: _slT1, gameTeam2: _slT2, pickTeam: _slPick, opponent: _slPick === _slT1 ? _slT2 : _slT1, gameDate: _slGameDate, kalshiPct: _slPct, americanOdds: _slAO, kalshiVolume: _slVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── LMB (Mexican League) game-winner branch ── binary, two markets per event (one per
            // team). Event segment = date + game time + team abbrs (KXLMBGAME-26JUL152030DIATDQ) —
            // parseGameTeams strips the 4-digit time and does the validated 3+3 split against the
            // lmb registry; the ticker suffix is the pick team's Kalshi abbr. Liquidity-gated at
            // parse (same doctrine as game rows 2026-07-11): only game-day books are real — far-out
            // listings quote ~48¢ placeholder spreads on both sides.
            if (cfg.gameType === "lmbGame") {
              const _lmYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _lmNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _lmLast = parseFloat(m.last_price_dollars) || 0;
              const _lmYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _lmNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _lmStale = _lmYesAsk >= 0.98 && _lmYesBid === 0 && _lmLast > 0;
              const _lmPrice = _lmStale ? _lmLast : (_lmYesAsk > 0 ? _lmYesAsk : _lmLast);
              if (_lmPrice === 0) continue; // no live book — skip (books seed near game time)
              const _lmYesSpreadC = _lmYesAsk > 0 ? Math.round((_lmYesAsk - _lmYesBid) * 100) : 999;
              const _lmNoSpreadC = _lmNoAsk > 0 ? Math.round((_lmNoAsk - _lmNoBid) * 100) : 999;
              if (!_lmStale && !capturableSpread(Math.min(_lmYesSpreadC, _lmNoSpreadC))) continue;
              const _lmPct = Math.round(_lmPrice * 100);
              const _lmVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const [_lmT1, _lmT2] = parseGameTeams(m.event_ticker, "lmb");
              if (!_lmT1 || !_lmT2) continue;
              const _lmPick = normTeam("lmb", (m.ticker || "").split("-").pop() || "");
              if (_lmPick !== _lmT1 && _lmPick !== _lmT2) continue;
              const _lmDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _lmGameDate = null;
              if (_lmDateSeg.length >= 7) {
                const _KMONS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _lmMo = _KMONS[_lmDateSeg.slice(2, 5).toUpperCase()];
                if (_lmMo) _lmGameDate = `20${_lmDateSeg.slice(0, 2)}-${_lmMo}-${_lmDateSeg.slice(5, 7)}`;
              }
              const _lmAO = _lmPct >= 50 ? Math.round(-(_lmPct / (100 - _lmPct)) * 100) : Math.round((100 - _lmPct) / _lmPct * 100);
              lmbMarkets.push({ eventTicker: m.event_ticker, gameTeam1: _lmT1, gameTeam2: _lmT2, pickTeam: _lmPick, opponent: _lmPick === _lmT1 ? _lmT2 : _lmT1, gameDate: _lmGameDate, kalshiPct: _lmPct, americanOdds: _lmAO, kalshiVolume: _lmVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── MODEL-FREE SOCCER game-winner branch (3-way home/away/tie) ────────────────────
            // ONE branch for every league in MODEL_FREE_LEAGUES, replacing six copies of this
            // same ~35 lines that differed only in their local variable prefix and target array
            // (2026-07-28). Each league still needs its own bucket — the emit path resolves
            // gameTime/results off a DIFFERENT ESPN league endpoint per league — but the bucket
            // is now a key in `modelFreeMarkets`, not a separate hand-declared array.
            //
            // Event segment = date + team abbrs (KXMLSGAME-26JUL25SJLAG); `parseGameTeams` does
            // the validated variable-length split against that league's registry, which is what
            // handles the mixed 2-to-4-char abbrs (MLS NE/SD/SJ vs LAFC/NYRB, Brasileirão's CR).
            // Liquidity-gated at parse (same doctrine as game rows 2026-07-11): far-out listings
            // quote placeholder-wide spreads until books seed near kickoff.
            // `cfg.half` ("1h" or unset) tags which score the emit path resolves against.
            if (cfg.gameType === "modelFreeMl") {
              const _mfYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _mfNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _mfLast = parseFloat(m.last_price_dollars) || 0;
              const _mfYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _mfNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _mfStale = _mfYesAsk >= 0.98 && _mfYesBid === 0 && _mfLast > 0;
              const _mfPrice = _mfStale ? _mfLast : (_mfYesAsk > 0 ? _mfYesAsk : _mfLast);
              if (_mfPrice === 0) continue; // no live book — skip (books fill near kickoff)
              const _mfYesSpreadC = _mfYesAsk > 0 ? Math.round((_mfYesAsk - _mfYesBid) * 100) : 999;
              const _mfNoSpreadC = _mfNoAsk > 0 ? Math.round((_mfNoAsk - _mfNoBid) * 100) : 999;
              if (!_mfStale && !capturableSpread(Math.min(_mfYesSpreadC, _mfNoSpreadC))) continue;
              const _mfYesPct = Math.round(_mfPrice * 100);
              const _mfNoPct = _mfNoAsk > 0 ? Math.round(_mfNoAsk * 100) : (100 - _mfYesPct);
              const _mfVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const [_mfHome, _mfAway] = parseGameTeams(m.event_ticker, cfg.league);
              if (!_mfHome || !_mfAway) continue;
              const _mfSuffix = (m.ticker || "").split("-").pop();
              let _mfSide, _mfSideCode;
              if (_mfSuffix === "TIE") { _mfSide = "tie"; _mfSideCode = "TIE"; }
              else if (_mfSuffix === _mfHome) { _mfSide = "home"; _mfSideCode = _mfHome; }
              else if (_mfSuffix === _mfAway) { _mfSide = "away"; _mfSideCode = _mfAway; }
              else continue;
              const _mfDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _mfGameDate = null;
              if (_mfDateSeg.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _mfMo = _KMONT[_mfDateSeg.slice(2, 5).toUpperCase()];
                if (_mfMo) _mfGameDate = `20${_mfDateSeg.slice(0, 2)}-${_mfMo}-${_mfDateSeg.slice(5, 7)}`;
              }
              const _mfAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              (modelFreeMarkets[cfg.league] ||= []).push({ eventTicker: m.event_ticker, homeTeam: _mfHome, awayTeam: _mfAway, side: _mfSide, sideCode: _mfSideCode, gameDate: _mfGameDate, kalshiPct: _mfYesPct, noKalshiPct: _mfNoPct, americanOdds: _mfAO(_mfYesPct), kalshiVolume: _mfVol, _ticker: m.ticker, _depth: m._depth, half: cfg.half || null });
              continue;
            }
            // ── MLS/Liga MX threshold branch (1H spread/total/BTTS + full-game team-total) ──
            // model-free, one shared array+branch for both leagues (adopted 2026-07-23, see
            // project_mls_ligamx_threshold_2026_07_23 memory) — unlike scocup, MLS/LigaMX have
            // no team-abbr collision, so `parseGameTeams` + ticker-suffix extraction (the
            // existing generic teamTotal branch's own idiom, below) work directly; no
            // subtitle-based team resolution needed. Threshold parsed from subtitle text per
            // subtype (same rationale as scocup: floor_strike's raw/displayed-value offset
            // convention wasn't independently verifiable). `cfg.subtype` routes the shape;
            // `cfg.half` ("1h" or unset) tags which score the emit path resolves against.
            if (cfg.gameType === "clubSoccerThreshold") {
              const _ctYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _ctNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _ctLast = parseFloat(m.last_price_dollars) || 0;
              const _ctYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _ctNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _ctStale = _ctYesAsk >= 0.98 && _ctYesBid === 0 && _ctLast > 0;
              const _ctPrice = _ctStale ? _ctLast : (_ctYesAsk > 0 ? _ctYesAsk : _ctLast);
              if (_ctPrice === 0) continue; // no live book — skip (books fill near kickoff)
              const _ctYesSpreadC = _ctYesAsk > 0 ? Math.round((_ctYesAsk - _ctYesBid) * 100) : 999;
              const _ctNoSpreadC = _ctNoAsk > 0 ? Math.round((_ctNoAsk - _ctNoBid) * 100) : 999;
              if (!_ctStale && !capturableSpread(Math.min(_ctYesSpreadC, _ctNoSpreadC))) continue;
              const _ctYesPct = Math.round(_ctPrice * 100);
              const _ctNoPct = _ctNoAsk > 0 ? Math.round(_ctNoAsk * 100) : (100 - _ctYesPct);
              const _ctVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _ctSub = m.subtitle || m.yes_sub_title || "";
              const [_ctHome, _ctAway] = parseGameTeams(m.event_ticker, sport);
              if (!_ctHome || !_ctAway) continue;
              let _ctThreshold = null, _ctPickTeam = null;
              if (cfg.subtype === "spread") {
                const _ctMatch = _ctSub.match(/by more than\s+([\d.]+)\s+goals/i);
                if (!_ctMatch) continue;
                _ctThreshold = parseFloat(_ctMatch[1]);
                const _ctTm = ((m.ticker || "").split("-").pop() || "").match(/^([A-Z]+)/);
                if (!_ctTm) continue;
                _ctPickTeam = normTeam(sport, _ctTm[1]);
              } else if (cfg.subtype === "total") {
                const _ctMatch = _ctSub.match(/Over\s+([\d.]+)\s+(?:1H\s+)?goals scored/i);
                if (!_ctMatch) continue;
                _ctThreshold = parseFloat(_ctMatch[1]);
              } else if (cfg.subtype === "teamTotal") {
                const _ctMatch = _ctSub.match(/over\s+([\d.]+)\s+goals$/i);
                if (!_ctMatch) continue;
                _ctThreshold = parseFloat(_ctMatch[1]);
                const _ctTm = ((m.ticker || "").split("-").pop() || "").match(/^([A-Z]+)/);
                if (!_ctTm) continue;
                _ctPickTeam = normTeam(sport, _ctTm[1]);
              } else if (cfg.subtype !== "btts") {
                continue;
              }
              if (cfg.subtype !== "btts" && isNaN(_ctThreshold)) continue;
              const _ctSegment = (m.event_ticker || "").split("-")[1] || "";
              let _ctGameDate = null;
              if (_ctSegment.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _ctMo = _KMONT[_ctSegment.slice(2, 5).toUpperCase()];
                if (_ctMo) _ctGameDate = `20${_ctSegment.slice(0, 2)}-${_ctMo}-${_ctSegment.slice(5, 7)}`;
              }
              const _ctAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              clubSoccerThresholdMarkets.push({ sport, subtype: cfg.subtype, half: cfg.half || null, eventTicker: m.event_ticker, segment: _ctSegment, gameDate: _ctGameDate, homeTeam: _ctHome, awayTeam: _ctAway, threshold: _ctThreshold, pickTeam: _ctPickTeam, kalshiPct: _ctYesPct, noKalshiPct: _ctNoPct, americanOdds: _ctAO(_ctYesPct), noAmericanOdds: _ctAO(_ctNoPct), kalshiVolume: _ctVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── Scottish League Cup spread branch ── threshold market ("<team> wins by more
            // than N.5 goals"), model-free (see tonight/scocup.js). Team identity comes from the
            // market's subtitle text, NOT the 3-char ticker code — Kalshi reuses "DUN" for two
            // different clubs across events (see the scocup registry comment in teams.js), so
            // resolving from the human-readable subtitle sidesteps the collision entirely. The
            // segment (date + team-code pair, e.g. "26JUL26MIRDUN") is shared with the sibling
            // KXSCOCUPTOTAL series and used to join them in the emit path.
            if (cfg.gameType === "scocupSpread") {
              // Threshold parsed from the subtitle text ("<team> wins by more than 2.5 goals"),
              // not floor_strike — the raw/displayed-value offset convention for this series
              // wasn't independently verifiable (Kalshi's public API isn't reachable from every
              // environment this runs in), and the subtitle states the number directly.
              const _scsSub = m.subtitle || m.yes_sub_title || "";
              const _scsMatch = _scsSub.match(/wins by more than\s+([\d.]+)\s+goals/i);
              if (!_scsMatch) continue;
              const _scsStrike = parseFloat(_scsMatch[1]);
              if (isNaN(_scsStrike)) continue;
              const _scsYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _scsNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _scsLast = parseFloat(m.last_price_dollars) || 0;
              const _scsYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _scsNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _scsStale = _scsYesAsk >= 0.98 && _scsYesBid === 0 && _scsLast > 0;
              const _scsPrice = _scsStale ? _scsLast : (_scsYesAsk > 0 ? _scsYesAsk : _scsLast);
              if (_scsPrice === 0) continue; // no live book — skip (books fill near kickoff)
              // Liquidity gating happens in the emit path (tonight/scocup.js), NOT here — team
              // identity for an event is derived from every subtitled market seen, regardless of
              // that specific line's own liquidity. Gating here caused a real bug (found live
              // 2026-07-23): when only the favorite's lines had a real book, the underdog's name
              // never made it into scocupSpreadMarkets, so the event's team pair could never
              // resolve to 2 names and EVERY row silently dropped as "unresolved_teams".
              const _scsYesSpreadC = _scsYesAsk > 0 ? Math.round((_scsYesAsk - _scsYesBid) * 100) : 999;
              const _scsNoSpreadC = _scsNoAsk > 0 ? Math.round((_scsNoAsk - _scsNoBid) * 100) : 999;
              const _scsYesPct = Math.round(_scsPrice * 100);
              const _scsNoPct = _scsNoAsk > 0 ? Math.round(_scsNoAsk * 100) : (100 - _scsYesPct);
              const _scsVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _scsTeamName = _scsSub.split(" wins by")[0].trim();
              if (!_scsTeamName) continue;
              const _scsSegment = (m.event_ticker || "").split("-")[1] || "";
              let _scsGameDate = null;
              if (_scsSegment.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _scsMo = _KMONT[_scsSegment.slice(2, 5).toUpperCase()];
                if (_scsMo) _scsGameDate = `20${_scsSegment.slice(0, 2)}-${_scsMo}-${_scsSegment.slice(5, 7)}`;
              }
              const _scsAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              scocupSpreadMarkets.push({ segment: _scsSegment, gameDate: _scsGameDate, teamName: _scsTeamName, threshold: _scsStrike, line: _scsStrike, kalshiPct: _scsYesPct, noKalshiPct: _scsNoPct, americanOdds: _scsAO(_scsYesPct), noAmericanOdds: _scsAO(_scsNoPct), kalshiVolume: _scsVol, eventTicker: m.event_ticker, _ticker: m.ticker, _depth: m._depth, _stale: _scsStale, _yesSpreadC: _scsYesSpreadC, _noSpreadC: _scsNoSpreadC });
              continue;
            }
            // ── Scottish League Cup total branch ── threshold market ("Over N.5 goals scored"),
            // model-free, same doctrine as the spread branch above. No team subtitle — joined to
            // its spread siblings by the shared event segment in the emit path.
            if (cfg.gameType === "scocupTotal") {
              // Threshold parsed from the subtitle text ("Over 2.5 goals scored") — same
              // rationale as the spread branch above (floor_strike offset unverified).
              const _sctSub = m.subtitle || m.yes_sub_title || "";
              const _sctMatch = _sctSub.match(/Over\s+([\d.]+)\s+goals\s+scored/i);
              if (!_sctMatch) continue;
              const _sctStrike = parseFloat(_sctMatch[1]);
              if (isNaN(_sctStrike)) continue;
              const _sctYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _sctNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _sctLast = parseFloat(m.last_price_dollars) || 0;
              const _sctYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _sctNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _sctStale = _sctYesAsk >= 0.98 && _sctYesBid === 0 && _sctLast > 0;
              const _sctPrice = _sctStale ? _sctLast : (_sctYesAsk > 0 ? _sctYesAsk : _sctLast);
              if (_sctPrice === 0) continue; // no live book — skip (books fill near kickoff)
              const _sctYesSpreadC = _sctYesAsk > 0 ? Math.round((_sctYesAsk - _sctYesBid) * 100) : 999;
              const _sctNoSpreadC = _sctNoAsk > 0 ? Math.round((_sctNoAsk - _sctNoBid) * 100) : 999;
              if (!_sctStale && !capturableSpread(Math.min(_sctYesSpreadC, _sctNoSpreadC))) continue;
              const _sctYesPct = Math.round(_sctPrice * 100);
              const _sctNoPct = _sctNoAsk > 0 ? Math.round(_sctNoAsk * 100) : (100 - _sctYesPct);
              const _sctVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _sctSegment = (m.event_ticker || "").split("-")[1] || "";
              let _sctGameDate = null;
              if (_sctSegment.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _sctMo = _KMONT[_sctSegment.slice(2, 5).toUpperCase()];
                if (_sctMo) _sctGameDate = `20${_sctSegment.slice(0, 2)}-${_sctMo}-${_sctSegment.slice(5, 7)}`;
              }
              const _sctAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              scocupTotalMarkets.push({ segment: _sctSegment, gameDate: _sctGameDate, threshold: _sctStrike, line: _sctStrike, kalshiPct: _sctYesPct, noKalshiPct: _sctNoPct, americanOdds: _sctAO(_sctYesPct), noAmericanOdds: _sctAO(_sctNoPct), kalshiVolume: _sctVol, eventTicker: m.event_ticker, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── MLB pitcher outs-recorded branch ── threshold ladder per starter ("Senga: 15+").
            // yes_sub_title = "<pitcher>: N+"; floor_strike = N−0.5. Both YES(over)/NO(under) priced;
            // emitMlbOutsPlays picks the favorite side in [67,91]. Team-based (need home/away for the
            // resolver's /api/live lookup), so parse teams here + resolve home via gameHomeTeams.
            if (cfg.gameType === "mlbOuts") {
              const _oStrike = parseFloat(m.floor_strike);
              if (isNaN(_oStrike)) continue;
              const _oThreshold = Math.round(_oStrike + 0.5); // "N+" over threshold
              const _oYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _oNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _oLast = parseFloat(m.last_price_dollars) || 0;
              const _oYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _oYesPrice = (_oYesAsk >= 0.98 && _oYesBid === 0 && _oLast > 0) ? _oLast : (_oYesAsk > 0 ? _oYesAsk : _oLast);
              if (_oYesPrice === 0) continue; // no live book — skip (books fill near first pitch)
              const _oYesPct = Math.round(_oYesPrice * 100);
              const _oNoPct = _oNoAsk > 0 ? Math.round(_oNoAsk * 100) : (100 - _oYesPct);
              const _oVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _oName = (m.yes_sub_title || "").split(":")[0].trim();
              if (!_oName) continue;
              // gameDate from the YYMMMDD ticker segment (the ET game date; avoids the UTC roll that
              // close_time has on night games). Fallback to close_time.
              const _oEvSeg = (m.event_ticker || "").split("-")[1] || "";
              const _oMd = _oEvSeg.match(/^(\d{2})([A-Z]{3})(\d{2})/);
              const _oMonths = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
              const _oDate = _oMd ? `20${_oMd[1]}-${_oMonths[_oMd[2]] || "01"}-${_oMd[3]}` : ((m.close_time || "").slice(0, 10) || null);
              // Parse teams in ticker order; the home/away swap (needs gameHomeTeams) is deferred to
              // emitMlbOutsPlays — sportByteam isn't initialized yet here (TDZ in the parse loop).
              const [_oT1, _oT2] = parseGameTeams(m.event_ticker, "mlb");
              // Pitcher's team = leading abbr of the market-ticker suffix (after the event segment).
              const _oMktSuffix = (m.ticker || "").slice((m.event_ticker || "").length + 1);
              let _oPitTeam = null;
              if (_oT1 && _oMktSuffix.startsWith(_oT1)) _oPitTeam = _oT1;
              else if (_oT2 && _oMktSuffix.startsWith(_oT2)) _oPitTeam = _oT2;
              const _oAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              outsMarkets.push({ player: _oName, threshold: _oThreshold, gameTeam1: _oT1, gameTeam2: _oT2, pitcherTeam: _oPitTeam, yesPct: _oYesPct, noPct: _oNoPct, yesAO: _oAO(_oYesPct), noAO: _oAO(_oNoPct), kalshiVolume: _oVol, gameDate: _oDate, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            const strike = parseFloat(m.floor_strike);
            if (isNaN(strike)) continue;
            const threshold = Math.round(strike + 0.5);
            const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
            const noAsk = parseFloat(m.no_ask_dollars) || 0;
            const last = parseFloat(m.last_price_dollars) || 0;
            const volume = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
            const yesBidEarly = parseFloat(m.yes_bid_dollars) || 0;
            const noBidEarly = parseFloat(m.no_bid_dollars) || 0;
            // Bet-side bid-ask spread (cents) — the CAPTURE_MAX_SPREAD gate below rejects a rung
            // whose captured side is a lone-quote artifact (no real two-sided book). No ask on a
            // side → 999 so that side can never be captured. See config.js CAPTURE_MAX_SPREAD.
            const yesSpreadC = yesAsk > 0 ? Math.round((yesAsk - yesBidEarly) * 100) : 999;
            const noSpreadC  = noAsk  > 0 ? Math.round((noAsk  - noBidEarly)  * 100) : 999;
            // Stale ask: market maker maxed ask at 99¢ with no bid — use last traded price instead
            const _staleAskPath = yesAsk >= 0.98 && yesBidEarly === 0 && last > 0;
            const price = _staleAskPath ? last : (yesAsk > 0 ? yesAsk : last);
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
              // Capture markets where EITHER side (YES/OVER or NO/UNDER) sits in the wide
              // [CAPTURE_GATE, CAPTURE_CAP] favorite curve — wider than the [67,91] bet window so
              // calibration sees the full curve (2026-06-29 de-blinding). The `qualified` bet flag
              // is re-applied downstream at [67,91]. The OVER push gates on YES (yesAsk), the UNDER
              // push gates on NO (noAsk = real ask, not synthetic 1-yesAsk), so we don't bet OVERs
              // against an UNDER-favored line and vice versa.
              if ((pct < CAPTURE_GATE || pct > CAPTURE_CAP) && (noPct < CAPTURE_GATE || noPct > CAPTURE_CAP)) continue;
              // Liquidity gate (2026-07-11, game rows — same doctrine as the prop gate below):
              // Kalshi's book is unified (NO ask ≡ YES bid), so bid-ask spread ≈ overround and
              // both sides share it when both asks exist; min() lets a real one-sided book carry
              // the market when the other ask is absent (999). In-play-only segments (WNBA Q2-Q4,
              // halves) captured pre-game list ~95¢ asks on BOTH sides — quotes, not prices.
              if (!_staleAskPath && !capturableSpread(Math.min(yesSpreadC, noSpreadC))) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              const dedupeKey = `total|${sport}|${segment}|${gameTeam1}|${gameTeam2}|${threshold}`;
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
              totalMarkets.push({ gameType: "total", sport, stat, col, segment, threshold, kalshiPct: pct, americanOdds: _toAO, noKalshiPct: noPct, noKalshiAO: _tNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, gameDate: _tGameDate, kalshiSpread: _tSpread, _ticker: m.ticker, _yesAsk: yesAsk, _yesBid: _tYesBid, _noAsk: noAsk, _depth: m._depth });
              continue;
            }

            // ── Team total branch (single team's score vs opposing defense) ──
            if (cfg.gameType === "teamTotal") {
              // Same wide capture gate as game totals — accept either OVER-side or UNDER-side alt
              // lines across the [CAPTURE_GATE, CAPTURE_CAP] favorite curve; the OVER/UNDER push
              // paths apply their own [67,91] kalshiPct/noKalshiPct bet gate downstream.
              // UNDER side uses real noAsk (not 1-yesAsk) since YES/NO books are independent.
              if ((pct < CAPTURE_GATE || pct > CAPTURE_CAP) && (noPct < CAPTURE_GATE || noPct > CAPTURE_CAP)) continue;
              // Liquidity gate — see the game-total branch above (2026-07-11).
              if (!_staleAskPath && !capturableSpread(Math.min(yesSpreadC, noSpreadC))) continue;
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
              teamTotalMarkets.push({ gameType: "teamTotal", sport, stat, col, threshold, kalshiPct: pct, americanOdds: _ttAO, noKalshiPct: noPct, noKalshiAO: _ttNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, scoringTeam, gameDate: _ttGameDate, kalshiSpread: _ttSpread, _ticker: m.ticker, _yesAsk: yesAsk, _noAsk: noAsk, _depth: m._depth });
              continue;
            }

            // ── Spread branch (MLB run-line: "Team X wins by over Y runs?") ──
            // Suffix `{team}{N}` where line = strike (== N - 0.5). YES = the margin side; NO = the
            // cover side (handled identically to totals UNDER via real no_ask, not 1 - yes_ask).
            // Same wide capture gate as totals: keep if either side sits in the favorite curve
            // [CAPTURE_GATE, CAPTURE_CAP]; emission re-gates `qualified` at [67,91].
            if (cfg.gameType === "spread") {
              if ((pct < CAPTURE_GATE || pct > CAPTURE_CAP) && (noPct < CAPTURE_GATE || noPct > CAPTURE_CAP)) continue;
              // Liquidity gate — see the game-total branch above (2026-07-11).
              if (!_staleAskPath && !capturableSpread(Math.min(yesSpreadC, noSpreadC))) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              const _spSuffix = (m.ticker || "").split("-").pop() || "";
              const _spMatch = _spSuffix.match(/^([A-Z]+)(\d+)$/);
              if (!_spMatch) continue;
              const marginTeam = normTeam(sport, _spMatch[1]);
              // Trust the parsed strike (floor_strike) as the line; suffix N is a sanity-check tier.
              if (isNaN(strike) || strike <= 0 || strike === Math.floor(strike)) continue;
              const dedupeKey = `spread|${sport}|${segment}|${marginTeam}|${gameTeam1}|${gameTeam2}|${strike}`;
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
              spreadMarkets.push({ gameType: "spread", sport, stat, col, segment, line: strike, marginTeam, kalshiPct: pct, americanOdds: _spAO, noKalshiPct: noPct, noKalshiAO: _spNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, gameDate: _spGameDate, kalshiSpread: _spSpread, _ticker: m.ticker, _yesAsk: yesAsk, _noAsk: noAsk, _depth: m._depth });
              continue;
            }

            // Player props are YES-side by default. Total bases is the exception (2026-06-12):
            // Kalshi lists TB thresholds 2+ and up only, and P(2+ TB) never prices ≥67, so the
            // YES side can't reach the window — the tradeable side is the NO ("under 2 TB" ~70-85).
            // Push those as under-direction props priced at no_ask. Scoped to totalBases; every
            // other prop series keeps YES-only behavior.
            // Capture band is the wide [CAPTURE_GATE, CAPTURE_CAP] favorite curve, NOT the [67,91]
            // bet window — so calibration sees the favorite tail above 91¢ (the 2026-06-29 finding:
            // totalBases' Brier edge lives above the cap, but we were capping capture at it). The
            // `qualified` bet flag is still applied at [67,91] downstream in props.js.
            // Liquidity gate (2026-06-30): a rung whose captured side is a lone-quote artifact
            // (no real two-sided book) reports a bet-side ask that isn't tradeable — e.g. a lone
            // NO bid at ~6¢ implies yes_ask=94¢, so high-threshold totalBases longshots masquerade
            // as 94¢ favorites and poison calibration. Reject when the captured side's bid-ask
            // spread exceeds CAPTURE_MAX_SPREAD. Under captures on NO, over on YES — gate the side
            // we'd actually buy. Real favorites are ≤7¢; artifacts ~94¢. See config.js.
            let propDirection = null; // null = YES/over (legacy field shape on all other props)
            // Full-curve capture (2026-07-03): the flip used to trigger on "YES out of the
            // favorite band, NO in it"; with the band now quote-sanity-wide that condition is
            // dead, so flip on the equivalent semantics directly — NO is the favorite side.
            // Preserves row continuity: every rung that logged as an under keeps logging as one.
            if (stat === "totalBases" && noPct > pct
                && noPct >= CAPTURE_GATE && noPct <= CAPTURE_CAP) {
              if (!capturableSpread(noSpreadC)) continue;
              propDirection = "under";
            } else {
              if (pct < CAPTURE_GATE) continue;
              if (pct > CAPTURE_CAP) continue;
              // Exempt the stale-ask path (priced off a real `last` trade, not the maxed ask) —
              // its wide book is expected and it deliberately captures the near-cert tail. The 94¢
              // artifacts sit below 0.98 so take the normal path and are still rejected here.
              if (!_staleAskPath && !capturableSpread(yesSpreadC)) continue;
            }
            // HRR is YES/over-side only at EVERY threshold (unlike totalBases, which lists no 1+
            // line and is bet as a NO/under). The 1+ over is the bread-and-butter play; 2+/3+ overs
            // only reach the [67,91] window for elite bats and pass the YES gate above organically.
            // 2026-06-12: dropped the `threshold > 1` skip so those higher-line overs flow to shadow
            // for calibration (mlb|hrr is shadow-only, not in the category gate). Band shadow
            // analysis by threshold — the 6/10 recalibration was fit on 1+ rows only.
            const raw = m.event_title || m.title || "";
            let playerName = raw.replace(/\s*:\s*\d.*$/, "").replace(/\s+(Points?|Rebounds?|Assists?|3-Pointers?|Three Pointers?|Made Threes?|Goals?|Shots on Goal|Hits?|Home Runs?|RBIs?|Strikeouts?|Total Bases?|Passing Yards?|Rushing Yards?|Receiving Yards?|Touchdowns?)\b.*/i, "").replace(/\s+Over\s+\d.*$/i, "").replace(/\s+Under\s+\d.*$/i, "").replace(/\s*\(.*\)\s*$/, "").replace(/\s*-\s*$/, "").trim();
            if (!playerName || playerName.length < 4) continue;
            const playerNameDisplay = playerName;
            playerName = normName(playerName);
            const dedupeKey = `${sport}|${playerName}|${stat}|${threshold}`;
            if (globalSeen.has(dedupeKey)) continue;
            globalSeen.add(dedupeKey);
            const americanOdds = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
            // Under props follow the totals convention: kalshiPct/truePct stay over-framed,
            // the NO side rides in noKalshiPct/noKalshiAO, and consumers flip on direction.
            const noKalshiAO = noPct >= 50 ? Math.round(-(noPct / (100 - noPct)) * 100) : Math.round((100 - noPct) / noPct * 100);
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
            const noBid = parseFloat(m.no_bid_dollars) || 0;
            const kalshiSpread = propDirection === "under"
              ? (noAsk > 0 && noBid > 0 ? Math.round((noAsk - noBid) * 100) : null)
              : (yesAsk > 0 && yesBid > 0 ? Math.round((yesAsk - yesBid) * 100) : null);
            // HRR: attach the NO quote (no direction — the row stays YES-framed) so the props.js
            // NO-side flip (2026-07-11) can evaluate it. Only when the NO book is real: noAsk
            // absent → noPct is the synthetic 100-pct fallback (never a fill price), and a
            // one-sided NO book (spread > CAPTURE_MAX_SPREAD, incl. stale-ask books via noBid=0)
            // would redirect the bet to an untradeable artifact price. Absent field = flip can't
            // fire, failure-closed.
            const _hrrNoQuote = stat === "hrr" && noAsk > 0 && capturableSpread(noSpreadC)
              ? { noKalshiPct: noPct, noKalshiAO } : {};
            qualifyingMarkets.push({ playerName, playerNameDisplay, sport, stat, col, threshold, kalshiPct: pct, americanOdds, kalshiVolume: volume, gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate, kalshiSpread, ...(propDirection ? { direction: propDirection, noKalshiPct: noPct, noKalshiAO } : _hrrNoQuote), _ticker: m.ticker, _yesAsk: yesAsk, _yesBid: yesBid, _yesAskSize: yesAskSize, _depth: m._depth });
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
        // Blended fill price (player props): re-price kalshiPct to the true cost of sweeping a
        // unit-sized position, not just top-of-book ask. Depth comes from the snapshot cron's
        // cached `_depth` (kalshi:snap:{ticker}) — NO live orderbook fetch on the hot path
        // (replaced the prior live walk 2026-05-31; see blend-fill.js). Player props are always
        // a YES buy. Markets without cached depth keep top-of-book (blendMarketPrice → null).
        for (const m of qualifyingMarkets) {
          m.rawKalshiPct = m.kalshiPct; // pre-blend top-of-book — lets the client measure true slippage
          const blended = blendMarketPrice(m._depth, "yes", m.kalshiPct);
          if (blended) { m.kalshiPct = blended.pct; m.americanOdds = blended.americanOdds; }
          // Under props (totalBases) actually buy the NO side — re-price it from the NO book
          // too, mirroring the totals/spreads loop below. HRR rows carry noKalshiPct without a
          // direction (props.js decides the flip) — their NO price needs the same re-price so
          // the flip compares blended fills on both sides.
          if (m.noKalshiPct != null) {
            m.rawNoKalshiPct = m.noKalshiPct;
            const nb = blendMarketPrice(m._depth, "no", m.noKalshiPct);
            if (nb) { m.noKalshiPct = nb.pct; m.noKalshiAO = nb.americanOdds; }
          }
        }
        // Blended fill price (totals / team totals / spreads): same cached-depth blend, but each
        // of these has TWO tradeable sides — the OVER/margin (YES buy) and the UNDER/cover (NO
        // buy) — so we re-price both. Done here at the PARSE site (before game-totals.js and
        // ml-spread.js read these arrays) so the emit modules need zero changes; they consume
        // already-slippage-adjusted kalshiPct/noKalshiPct. YES re-prices kalshiPct+americanOdds;
        // NO re-prices noKalshiPct+noKalshiAO. Markets without cached depth keep top-of-book.
        for (const m of [...totalMarkets, ...teamTotalMarkets, ...spreadMarkets]) {
          m.rawKalshiPct = m.kalshiPct;     // pre-blend top-of-book (YES) — client slippage measure
          m.rawNoKalshiPct = m.noKalshiPct; // pre-blend top-of-book (NO)
          const yb = blendMarketPrice(m._depth, "yes", m.kalshiPct);
          if (yb) { m.kalshiPct = yb.pct; m.americanOdds = yb.americanOdds; }
          const nb = blendMarketPrice(m._depth, "no", m.noKalshiPct);
          if (nb) { m.noKalshiPct = nb.pct; m.noKalshiAO = nb.americanOdds; }
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
        // NHL_ABBR_MAP imported from ../nhl.js (moved Phase B, 2026-05-29).
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
              fetchSafe("tonight:nhl-gaa", "https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=goalsAgainstPerGame&start=0&limit=50&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2", { headers: { "User-Agent": "Mozilla/5.0" } }),
              fetchSafe("tonight:nhl-sa",  "https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=shotsAgainstPerGame&start=0&limit=50&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2", { headers: { "User-Agent": "Mozilla/5.0" } }),
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
        await _fdMark("afterByteam");
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
          // +2 days (2026-07-27). Kalshi lists markets further out than ESPN's old today+tomorrow
          // window, so rows for D+2 games were captured with gameTime:null — which silently blocks
          // maker quoting. 98 WNBA rows/day sat in that gap.
          const dayAfterDateStr = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
          const sbResults = await Promise.all(sportsToFetch.map(async s => {
            try {
              const H2 = { "User-Agent": "Mozilla/5.0" };
              const base = `https://site.api.espn.com/apis/site/v2/sports/${SPORT_SB_PATH[s]}/scoreboard`;
              const [r1, r2, r3, r4] = await Promise.all([
                fetch(`${base}?dates=${yesterdayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${todayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${tomorrowDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${dayAfterDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
              ]);
              // The D+2 events are deliberately kept OUT of `events` and exposed separately.
              // Every `events` consumer below (parseGameOdds, parseGameScores, _extractMlbWeather,
              // parseTopPlayers) is keyed by TEAM with last-event-wins, so folding D+2 in would let
              // a further-out game overwrite a nearer game's odds. Only the gameTimes map — which
              // keys by `sport:team:ptDate` and so cannot collide across dates — reads this.
              return {
                sport: s,
                events: [...(r1.events || []), ...(r2.events || []), ...(r3.events || [])],
                eventsDayAfter: [...(r4.events || [])],
              };
            } catch { return { sport: s, events: [], eventsDayAfter: [] }; }
          }));
          if (needGameTimes) {
            for (const { sport, events, eventsDayAfter } of sbResults) {
              // D+2 events appended LAST so the bare `gameTimes[key]` fallback (first-seen-wins)
              // still prefers the nearest game; the dated keys can't collide across days anyway.
              for (const ev of [...events, ...(eventsDayAfter || [])]) {
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
        await _fdMark("afterScoreboards");
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
          for (const st of ["hits", "hrr", "totalBases"]) {
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
        // Shared network-concurrency gate for the player-hydration fan-outs below. Unbounded
        // Promise.all over 100+ players exhausted the instance's file descriptors on big
        // slates (EMFILE/EBUSY 2026-07-05) and took down every subsequent fetch in the run.
        const _netLimit = pLimit(20);
        if (CACHE2) {
          // Batched cache reads — one MGET pipeline instead of N parallel GET connections
          // (getMany falls back to parallel GETs only on non-Upstash cache bindings).
          const _pinfoKeys = uniquePlayerKeys.map(k => `pinfo:${k}`);
          const pinfoVals = CACHE2.getMany
            ? await CACHE2.getMany(_pinfoKeys, "json")
            : await Promise.all(_pinfoKeys.map(k => CACHE2.get(k, "json").catch(() => null)));
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
        // ESPN player-info fetches, concurrency-capped (pinfo cached 7 days so this is rare on warm caches)
        await Promise.all(keysNeedingInfo.slice(0, MAX_PINFO_FETCHES).map(key => _netLimit(async () => {
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
            pInfoErrors.push({ key, reason: "exception", error: String(e), cause: String(e?.cause?.code || e?.cause?.message || e?.cause || "") || undefined });
          }
        })));
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
          // Batched cache lookups — one MGET pipeline instead of N parallel GET connections
          const _glKeys = keysForGamelog.map(k => _pitchPlayerKeys.has(k) ? _pitchGlCacheKey(k) : glCacheKey(k));
          const cachedVals = CACHE2.getMany
            ? await CACHE2.getMany(_glKeys, "json")
            : await Promise.all(_glKeys.map(k => CACHE2.get(k, "json").catch(() => null)));
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
              // Postseason detection — preserved per-event for playoff-aware prop lambdas
              // (added 2026-05-26). Both "postseason" and "playoff" surface in ESPN labels
              // depending on sport; checking both covers NBA/WNBA/NHL.
              const _isPlayoff = _stDn.includes("post") || _stDn.includes("playoff");
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
                    isPlayoff: _isPlayoff,
                  });
                }
              }
            }
            return events.length ? { ul, events } : null;
          } catch (e) {
            if (isDebug) gamelogErrors.push({ key: debugKey, err: String(e), cause: String(e?.cause?.code || e?.cause?.message || e?.cause || "") || undefined });
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
        // Fetch all uncached gamelogs through the shared concurrency gate — full parallel
        // (pre-2026-07-05) hit the FD ceiling on big slates; fixed delay batching (pre-2026-05)
        // added ~26s for 60 players. pLimit keeps the pipe full without the burst.
        await _fdMark("beforeGamelogs");
        await Promise.all(keysNeedingGamelog.map((k) => _netLimit(() => fetchGamelog(k, null, _pitchPlayerKeys.has(k)))));
        await _fdMark("afterGamelogs");
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
          if (CACHE2) {
            const _pKeys = pitcherEntriesToLoad.map(([, { name }]) => _pitchGlCacheKey(`mlb|${name}`));
            const _pVals = CACHE2.getMany
              ? await CACHE2.getMany(_pKeys, "json")
              : await Promise.all(_pKeys.map(k => CACHE2.get(k, "json").catch(() => null)));
            for (let i = 0; i < pitcherEntriesToLoad.length; i++) {
              const [teamAbbr, { name }] = pitcherEntriesToLoad[i];
              if (_pVals[i]) pitcherGamelogs[teamAbbr] = { name, gl: _normGlOpp(_pVals[i]) };
            }
          }
          const uncachedPitchers = pitcherEntriesToLoad.filter(([teamAbbr]) => !pitcherGamelogs[teamAbbr]);
          await Promise.all(uncachedPitchers.map(([teamAbbr, { name, id }]) => _netLimit(async () => {
            const pitcherKey = `mlb|${name}`;
            await fetchGamelog(pitcherKey, id, true);
            const gl = playerGamelogs[pitcherKey] || null;
            if (gl) pitcherGamelogs[teamAbbr] = { name, gl };
          })));
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
        // Backfill gameTimes from the (independently-fetched) per-sport gameScores maps. The
        // dedicated scoreboard fetch above can silently come back empty on an ESPN hiccup/429
        // (`.then(r => r.ok ? r.json() : {})` swallows non-OK), which would leave every play with
        // gameTime:null → duplicate matchup cards client-side AND the started-game pre-game drop
        // below no-ops (keeps !gameTime plays). gameScores is a SEPARATE request (MLB from
        // buildMlbByteam, others from their byteam builders), so it fills the gap. Only sets
        // absent keys — preserves the dedicated fetch's doubleheader "latest UTC time wins"
        // entries. Not written back to the gameTimes:v2 cache: the dedicated fetch retries next
        // request and stays the authoritative source; this is a per-request gap-fill only.
        for (const [_gtSport, _gtScores] of [
          ["mlb", sportByteam.mlb?.gameScores],
          ["nba", sportByteam.nbaGameScores],
          ["nhl", sportByteam.nhlGameScores],
          ["wnba", sportByteam.wnbaGameScores],
        ]) {
          if (!_gtScores) continue;
          for (const gs of Object.values(_gtScores)) {
            if (!gs?.gameTime || !gs.gameDate) continue;
            for (const team of [gs.homeTeam, gs.awayTeam]) {
              if (!team) continue;
              const _dk = `${_gtSport}:${team}:${gs.gameDate}`;
              if (!gameTimes[_dk]) gameTimes[_dk] = gs.gameTime;
              const _bk = `${_gtSport}:${team}`;
              if (!gameTimes[_bk]) gameTimes[_bk] = gs.gameTime;
            }
          }
        }
        // _OFFRTG_INJ_CAP / _injuryOffRtgFactor / _NBAshortNorm / _injuryOffRtgAdj — module level.
        // ── Player prop plays — all sports ──────────────────────────────────────────────
        // Extracted to api/lib/tonight/props.js (Phase B6, 2026-05-29).
        const { plays, dropped, nbaDropped } = await emitPropPlays({
          loopMarkets, playerInfoMap, playerGamelogs,
          STAT_SOFT, sportByteam, gameTimes,
          nbaInjuryMap, wnbaInjuryMap, nbaUsageMap, wnbaUsageMap,
          allPositionsDvp, nbaDepthChartPos, wnbaDvpMap,
          isDebug, _todayPT,
          leagueAvgCache, nhlGPGMap, nhlGAAMap, nhlLeagueAvgGAA,
          nbaPaceData, wnbaPaceData, nhlSaRankMap, nhlLeagueAvgSa,
          pitcherGamelogs, nbaPlayerStatus,
        });
        // Filter out plays from old dates (yesterday cutoff handles UTC/local differences
        // for late games: a 9:40pm ET game = 1:40am UTC next day).
        const cutoffStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        // ── Game Total + Team Total plays — all sports ───────────────────────────────────
        // Extracted to api/lib/tonight/game-totals.js (Phase B5, 2026-05-29).
        const { _mlbMlContext, _nbaMlContext, _wnbaMlContext, _nhlMlContext } =
          await emitGameTotalPlays({
            plays, dropped, isDebug, cutoffStr, gameTimes,
            CACHE2, isBustCache, PROD_SPORTS,
            totalMarkets, teamTotalMarkets,
            nbaInjuryMap, wnbaInjuryMap, nbaUsageMap, wnbaUsageMap,
            mlbBothTeamsConfirmed: _mlbBothTeamsConfirmed,
            sportByteam,
            leagueAvgCache,
            mlbRPGMap, mlbRoadRPGMap, mlbTeamERAMap, mlbTeamWHIPMap, mlbBullpenERAMap,
            nhlGPGMap, nhlGAAMap, nhlLeagueAvgGAA, nhlGoalieByTeam, nhlLeagueAvgSV,
            nbaOffPPGMap, nbaLeagueAvgOffPPG,
            nbaPaceData, wnbaPaceData, STAT_SOFT,
          });
        // ── ML / Spread / F5 / Halves emission — all sports ──────────────────────────────
        // Extracted to api/lib/tonight/ml-spread.js (Phase B, 2026-05-29).
        await emitAllMlAndSpread({
          plays, dropped, isDebug, cutoffStr, gameTimes, _todayPT,
          CACHE2, isBustCache,
          _mlbMlContext, _nbaMlContext, _wnbaMlContext, _nhlMlContext,
          spreadMarkets, totalMarkets,
          mlbBothTeamsConfirmed: _mlbBothTeamsConfirmed,
          reattrMlbGameDate: _reattrMlbGameDate,
        });
        // ── Tennis match-winner (ATP/WTA) — Phase 1, shadow-only ─────────────────────────
        // Emits into a separate tennisPlays array (NOT `plays`) so tennis rows bypass the prop
        // dedup, gameTime filter, and frontend card builder. Merged into shadow:staging only.
        const tennisPlays = [];
        await emitTennisMatchPlays({
          tennisMatchMarkets, tennisPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Soccer (World Cup) — Phase 1, shadow-only. Like tennis, emits into its own array
        // (NOT `plays`) so soccer bypasses dedup/gameTime-filter/card-builder; merged into
        // shadow:staging only. All 5 families project off one Elo-derived matrix per game.
        const soccerPlays = [];
        await emitSoccerPlays({
          soccerMarkets, soccerPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Soccer knockout "to advance" — Phase 1, shadow-only. Own array (NOT `plays`); reuses
        // the same Elo matrix as the 5 families, folding the 90'-draw mass into a to-advance prob.
        const soccerAdvancePlays = [];
        await emitSoccerAdvancePlays({
          soccerAdvanceMarkets, soccerAdvancePlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Fighting (UFC rounds O/U) — Phase 1, shadow-only. Like tennis/soccer, emits into its
        // own array (NOT `plays`) so fight rows bypass dedup/gameTime-filter/card-builder; merged
        // into shadow:staging only. One weight-class finish-rate CDF per bout feeds all thresholds.
        const fightPlays = [];
        await emitFightPlays({
          fightMarkets, fightPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Golf (PGA single-round head-to-head) — Phase 1, shadow-only. Like tennis/fight, emits
        // into its own array (NOT `plays`) so golf rows bypass dedup/gameTime-filter/card-builder;
        // merged into shadow:staging only. OWGR rating → one-round score differential, favorite side.
        const golfH2hPlays = [];
        await emitGolfH2hPlays({
          golfH2hMarkets, golfH2hPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── NASCAR (Cup H2H + Top-10) — Phase 1, shadow-only. Like tennis/golf, emits into its own
        // array (NOT `plays`) so NASCAR rows bypass dedup/gameTime-filter/card-builder; merged into
        // shadow:staging only. Recent-form finishing-position model, favorite side. Cup-only.
        const nascarPlays = [];
        await emitNascarPlays({
          nascarMarkets, nascarPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── NBA Summer League game winner — Phase 1, shadow-only. Same dedicated-array idiom;
        // merged into shadow:staging only. Within-tournament Elo (parity start), both sides.
        const nbaSummerPlays = [];
        await emitNbaSummerPlays({
          nbaSummerMarkets, nbaSummerPlays, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── LMB (Mexican League) game winner — Phase 1, shadow-only. Same dedicated-array idiom;
        // merged into shadow:staging only. Standings run-rate λ pair → NegBin joint, both sides.
        const lmbPlays = [];
        await emitLmbPlays({
          lmbMarkets, lmbPlays, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Model-free soccer game winners (MLS, Brasileirão, NWSL, Chinese Super League,
        // Liga MX, Argentina Liga Profesional) — Phase 1, no probability model at all; see
        // project_maker_modelfree_clubsoccer_2026_07_23. One loop over MODEL_FREE_LEAGUES
        // replaces six near-identical emit calls (2026-07-28). Per-league play buckets are kept
        // (each league's rows carry their own sport tag and resolve off their own ESPN endpoint)
        // and merged into shadow:staging only. Real gameTime fetched from ESPN per league.
        const modelFreePlays = {};
        for (const _lg of MODEL_FREE_LEAGUE_KEYS) {
          const _mkts = modelFreeMarkets[_lg];
          if (!_mkts || !_mkts.length) { modelFreePlays[_lg] = []; continue; }
          const _out = [];
          await emitModelFreeMlPlays({
            league: _lg, markets: _mkts, plays: _out, cutoffStr,
            cache: CACHE2, isBustCache,
          });
          modelFreePlays[_lg] = _out;
        }
        // Flat list for the staging merge; the per-league buckets stay addressable for ?debug=1.
        const modelFreeAllPlays = MODEL_FREE_LEAGUE_KEYS.flatMap(k => modelFreePlays[k] || []);
        // ── MLS/Liga MX 1H spread/total/BTTS + full-game team-total — Phase 1, model-free,
        // threshold shape, one shared array+module for both leagues (see
        // project_mls_ligamx_threshold_2026_07_23 memory). Merged into shadow:staging only.
        const clubSoccerThresholdPlays = [];
        await emitClubSoccerThresholdPlays({
          clubSoccerThresholdMarkets, clubSoccerThresholdPlays, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Scottish League Cup spread + total — Phase 1, model-free, threshold shape (first
        // maker module of this shape — see project_scocup_spread_total_2026_07_23 memory). Same
        // dedicated-array idiom; merged into shadow:staging only. Real gameTime fetched from
        // ESPN sco.cis (api/lib/scocup.js) — despite the "SCOCUP" ticker prefix, the real
        // competition is the Scottish LEAGUE Cup, not the Scottish Cup proper (verified live).
        const scocupPlays = [];
        await emitScoCupPlays({
          scocupSpreadMarkets, scocupTotalMarkets, scocupPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── MLB pitcher outs-recorded (KXMLBOUTS) — Phase 1, shadow-only. Prop-shaped rows in a
        // dedicated array (NOT `plays`) so they bypass dedup/gameTime-filter/card-builder; merged
        // into shadow:staging only. Normal workload model off pitcherStatsByName, favorite side.
        const outsPlays = [];
        emitMlbOutsPlays({ outsMarkets, outsPlays, dropped, isDebug, cutoffStr, sportByteam, gameTimes });
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
        // Per-matchup alt-line dedup — key semantics + keep/demote pass extracted to
        // api/lib/tonight/dedup.js (2026-06-11) so they're unit-testable.
        {
          const { kept: _kept, demoted: _demoted } = dedupAltLines(plays);
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
        // ── seasonType stamping (added 2026-05-26) — ESPN convention: 2=RS, 3=postseason.
        // Pulled from gameScores. Lets /api/auth/calibration bucket plays by seasonType
        // without changing emission sites. Single lookup table keyed by `sport|home|gameDate`
        // (lowest-cost denominator that's stable across pipelines — gameTime varies between
        // play-emission and the ESPN event ISO with seconds precision differences).
        {
          const _seasonTypeMap = {};
          const _addSrc = (sport, gsObj) => {
            for (const v of Object.values(gsObj || {})) {
              if (v?.homeTeam && v?.gameDate && v?.seasonType != null) {
                _seasonTypeMap[`${sport}|${v.homeTeam}|${v.gameDate}`] = v.seasonType;
              }
            }
          };
          _addSrc("mlb", sportByteam.mlb?.gameScores);
          _addSrc("nba", sportByteam.nbaGameScores);
          _addSrc("wnba", sportByteam.wnbaGameScores);
          _addSrc("nhl", sportByteam.nhlGameScores);
          const _stampSeasonType = (p) => {
            const home = p.homeTeam || p.scoringTeam || p.playerTeam;
            const st = _seasonTypeMap[`${p.sport}|${home}|${p.gameDate || ""}`];
            if (st != null) p.seasonType = st;
          };
          for (const p of plays) _stampSeasonType(p);
          for (const p of dropped) _stampSeasonType(p);
        }
        // ── dataConfidence (0-10) — penalty-based score starting at 10, subtracting for input-data
        // issues. Strict by design: only plays with zero or one minor issue reach the gate. NOT
        // YET an active filter — `dcQualified` is computed and emitted but the v1 frontend still
        // ignores it. The v2 model toggle (Phase B) is where this becomes the gate.
        //
        // Spec details + full penalty table in docs/MODEL.md "dataConfidence". Must run AFTER the
        // _kalshiStale propagation above and BEFORE the isDebug return below so debug-mode plays
        // carry the field too.
        // Pre-flight evidence for the client Place All validation (Flow A): homeAwayResolved
        // (swap-risk guard, #2) + rawKalshiPct/rawNoKalshiPct (true slippage measure, #4). Raw
        // prices are keyed by parse-site ticker; ML uses per-team tickers not in this map, so it
        // simply omits them and the client falls back to kalshiSpread/lowVolume proxies.
        const _rawByTicker = {};
        for (const m of [...qualifyingMarkets, ...totalMarkets, ...teamTotalMarkets, ...spreadMarkets]) {
          if (m._ticker) _rawByTicker[m._ticker] = { rawKalshiPct: m.rawKalshiPct, rawNoKalshiPct: m.rawNoKalshiPct };
        }
        for (const _p of plays) {
          _p.homeAwayResolved = _homeAwayResolved(_p, sportByteam);
          const _raw = _p.kalshiTicker ? _rawByTicker[_p.kalshiTicker] : null;
          if (_raw) {
            if (_raw.rawKalshiPct != null) _p.rawKalshiPct = _raw.rawKalshiPct;
            if (_raw.rawNoKalshiPct != null) _p.rawNoKalshiPct = _raw.rawNoKalshiPct;
          }
        }
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
        // ── Polymarket cross-venue price deltas — Phase 1a observatory (shadow-only). Fetches
        // Polymarket game prices (Gamma, public/no-auth) for the leagues we model and compares them
        // to our Kalshi prices in plays/dropped. Runs after the gameTime splice + DC loops so the
        // rows are final. Merged into shadow:staging + ?debug only; NEVER the client response.
        // Failure-closed: a Polymarket outage must not affect the main response.
        const polymarketDeltas = [];
        let polymarketDeltaSummary = null;
        try {
          // Don't bust the poly cache — `?bust=1` is for refreshing Kalshi/model data, and a cold
          // poly fetch under heavy bust load is flaky (starved → empty). The 120s cache is fine for
          // a shadow observatory; decoupling keeps deltas reliable on bust runs + the cron.
          const _polyGames = await fetchPolymarketGames({ cache: CACHE2 });
          polymarketDeltaSummary = emitPolymarketDeltas({ polyGames: _polyGames, plays, dropped, deltas: polymarketDeltas });
          // Sharpen the kill-gate: walk the Poly CLOB book for the bettable [67,91] sides so the
          // delta is EXECUTABLE (real VWAP after slippage), not just mid-price. Bounded + failure-
          // closed — leaves the mid delta intact on any book miss.
          const _tokensByGame = {};
          for (const g of _polyGames) if (g.mlTokens) _tokensByGame[`${g.sport}|${g.away}@${g.home}`] = g.mlTokens;
          await enrichDeltasWithExec({ deltas: polymarketDeltas, tokensByGame: _tokensByGame });
        } catch (e) { console.error("[tonight] polymarket deltas failed:", e?.message); }

        // Display map for the matchup-card cross-venue strip: per-game Kalshi-vs-Poly ML, derived
        // from the same deltas (single source). The shadow delta rows/summary stay shadow-only; this
        // is the display-shaped subset (no modelTruePct/exec fields) the client strip needs. Empty
        // when the poly fetch failed (failure-closed). Key: `${sport}|${away}@${home}|${gameDate}`.
        // (Per-bet comparison rides on the play rows themselves via the polyPct/polyDeltaCents stamp.)
        const polyMlByGame = {};
        for (const _d of polymarketDeltas) {
          if (_d.market !== "ml") continue;
          ((polyMlByGame[`${_d.sport}|${_d.game}|${_d.gameDate}`] ||= {})[_d.side]) =
            { kalshiPct: _d.kalshiPct, polyPct: _d.polyPct, deltaCents: _d.deltaCents };
        }

        // ── Sportsbook-reference deltas — Phase 1a observatory (shadow-only). De-vigs the sharp
        // book (Pinnacle via The Odds API) and compares its fair ML prob to our Kalshi price. The
        // kill-gate: does Kalshi LAG the sharp book (a timeable edge)? deltaCents = bookFairPct −
        // kalshiPct (+ = Kalshi cheap = edge to BUY). Fetches ONLY the sports present in tonight's
        // Kalshi ML set (credit-conserving). Merged into shadow:staging + ?debug only; never the
        // client. Failure-closed: no key / book outage → []. Requires env.THE_ODDS_API_KEY.
        const sportsbookDeltas = [];
        let sportsbookDeltaSummary = null;
        try {
          const _bookSports = [...new Set([...plays, ...dropped].filter(r => r?.gameType === "ml" && r?.sport).map(r => r.sport))];
          const _bookGames = await fetchSportsbookGames({ cache: CACHE2, apiKey: env?.THE_ODDS_API_KEY, sports: _bookSports });
          sportsbookDeltaSummary = emitSportsbookDeltas({ bookGames: _bookGames, plays, dropped, deltas: sportsbookDeltas });
        } catch (e) { console.error("[tonight] sportsbook deltas failed:", e?.message); }
        // Stage plays for shadow-snapshot — eliminates the 55s internal re-fetch.
        // `schedule` = today's ESPN game count per sport, so shadow-snapshot can compare
        // distinct games in the logged rows against the actual slate (coverage check).
        // gameScores keys are `${home}|${gameDate}|${eventISO}` with today+tomorrow merged,
        // so filter on the gameDate segment.
        if (CACHE2) {
          const _schedCounts = {};
          const _schedSources = {
            mlb: sportByteam.mlb?.gameScores,
            nba: sportByteam.nbaGameScores,
            wnba: sportByteam.wnbaGameScores,
            nhl: sportByteam.nhlGameScores,
          };
          for (const [_sp, _gs] of Object.entries(_schedSources)) {
            if (!_gs) continue;
            const _n = Object.keys(_gs).filter(k => k.split("|")[1] === _todayPT).length;
            if (_n > 0) _schedCounts[_sp] = _n;
          }
          // Tennis plays live in their own array (kept out of `plays` to bypass dedup/frontend);
          // merge them into the staging `plays` so shadow-snapshot logs them like any other play.
          CACHE2.put(`shadow:staging:${_todayPT}`, JSON.stringify({ plays: [...plays, ...tennisPlays, ...soccerPlays, ...soccerAdvancePlays, ...fightPlays, ...golfH2hPlays, ...nascarPlays, ...nbaSummerPlays, ...lmbPlays, ...modelFreeAllPlays, ...clubSoccerThresholdPlays, ...scocupPlays, ...outsPlays], dropped, schedule: _schedCounts, polymarketDeltas, polymarketDeltaSummary, sportsbookDeltas, sportsbookDeltaSummary, writtenAt: Date.now() }), { expirationTtl: 21600 }).catch(() => {});
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
          return jsonResponse({ fdProbe: { milestones: _fdMilestones, atEnd: await _fdProbe() }, plays: debugPlays, dropped: debugDropped, preDropped: debugPreDropped, tennisPlays, tennisMarketCount: tennisMatchMarkets.length, soccerPlays, soccerMarketCount: soccerMarkets.length, soccerAdvancePlays, soccerAdvanceMarketCount: soccerAdvanceMarkets.length, fightPlays, fightMarketCount: fightMarkets.length, golfH2hPlays, golfH2hMarketCount: golfH2hMarkets.length, nascarPlays, nascarMarketCount: nascarMarkets.length, nbaSummerPlays, nbaSummerMarketCount: nbaSummerMarkets.length, lmbPlays, lmbMarketCount: lmbMarkets.length, clubSoccerPlays: modelFreePlays.mls, clubSoccerMarketCount: (modelFreeMarkets.mls || []).length, brasileiraoPlays: modelFreePlays.brasileirao, brasileiraoMarketCount: (modelFreeMarkets.brasileirao || []).length, nwslPlays: modelFreePlays.nwsl, nwslMarketCount: (modelFreeMarkets.nwsl || []).length, chnslPlays: modelFreePlays.chnsl, chnslMarketCount: (modelFreeMarkets.chnsl || []).length, ligamxPlays: modelFreePlays.ligamx, ligamxMarketCount: (modelFreeMarkets.ligamx || []).length, argPremPlays: modelFreePlays.argprem, argPremMarketCount: (modelFreeMarkets.argprem || []).length, clubSoccerThresholdPlays, clubSoccerThresholdMarketCount: clubSoccerThresholdMarkets.length, scocupPlays, scocupSpreadMarketCount: scocupSpreadMarkets.length, scocupTotalMarketCount: scocupTotalMarkets.length, outsPlays, outsMarketCount: outsMarkets.length, polymarketDeltas, polymarketDeltaSummary, sportsbookDeltas, sportsbookDeltaSummary, staleKalshiSeries, kalshiSnap: _kalshiSnapDebug, gamelogErrors, pInfoErrors, qualifyingCount: qualifyingMarkets.length, totalMarketsCount: totalMarkets.length, preFilteredCount: preFilteredMarkets.length, uniquePlayersSearched: uniquePlayerKeys.length, playersWithInfo: Object.keys(playerInfoMap).length, playersWithGamelog: Object.keys(playerGamelogs).length, lineupKPct: sportByteam.mlb?.lineupKPct ?? null, lineupKPctVR: sportByteam.mlb?.lineupKPctVR ?? null, pitcherKPctCache: sportByteam.mlb?.pitcherKPct ?? null, pitcherAvgPitchesCache: sportByteam.mlb?.pitcherAvgPitches ?? null, nbaGlLabels, nbaGlSample }, true);
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
        const mlbMeta = { pitchers: _mlbPitchers, pitchersByGame: _mlbPitchersByGame, gameOdds: _mlbGameOdds, umpires: sportByteam.mlb?.umpireByGame ?? {}, weather: weatherByGame, homeTeams: sportByteam.mlb?.gameHomeTeams ?? {}, gameScores: sportByteam.mlb?.gameScores ?? {} };
        // Build mlbMetaTomorrow: tomorrow's probables + umpires (no lineup/weather data available yet)
        let mlbMetaTomorrow = { pitchers: {}, pitchersByGame: {}, gameOdds: _mlbGameOddsTomorrow, umpires: {}, weather: {}, homeTeams: {}, gameScores: {} };
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
          mlbMetaTomorrow = { pitchers: _tmrPitchers, pitchersByGame: _tmrPitchersByGame, gameOdds: _mlbGameOddsTomorrow, umpires: _tmrUmpires, weather: {}, homeTeams: _tmrHomeTeams, gameScores: {} };
        } catch { /* leave empty */ }
        // Sport meta builders — same shape, varying inputs. Injury maps are server-side only
        // (emitPropPlays/emitGameTotalPlays read them via ctx); the client injury badge was
        // removed 2026-06-10, so injuries are no longer shipped in the response meta.
        const _buildSportMeta = async (snapKey, gameOddsRaw, normMap, scoresMap, topPlayers) => {
          const gameOdds = _buildOddsMap(gameOddsRaw, normMap);
          await applyClosingSnapshot(CACHE2, isBustCache, snapKey, scoresMap, gameOdds);
          return { gameOdds, gameScores: scoresMap ?? {}, topPlayers: topPlayers ?? {} };
        };
        const nbaMeta = await _buildSportMeta(
          'nbaClosingOdds', sportByteam.nbaGameOdds, TEAM_NORM.nba,
          sportByteam.nbaGameScores, sportByteam.nbaTopPlayers
        );
        const wnbaMeta = await _buildSportMeta(
          'wnbaClosingOdds', sportByteam.wnbaGameOdds, TEAM_NORM.wnba,
          sportByteam.wnbaGameScores, sportByteam.wnbaTopPlayers
        );
        const nhlMeta = await _buildSportMeta(
          'nhlClosingOdds', sportByteam.nhlGameOdds, {},
          sportByteam.nhlGameScores, sportByteam.nhlTopPlayers
        );
        const playsResult = { plays, nbaDropped, mlbMeta, mlbMetaTomorrow, nbaMeta, wnbaMeta, nhlMeta, polyMlByGame, staleKalshiSeries, qualifyingCount: qualifyingMarkets.length, totalMarketsCount: totalMarkets.length, preFilteredCount: preFilteredMarkets.length };
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
        // Edge SWR: the snap-first assembly is ~7s, so serve a CDN-cached copy fresh for 2 min
        // (matching the snap cron + client poll cadence, so the displayed set is no staler than
        // the 2-min poll already allowed), then serve the instant stale copy for up to 24h while
        // revalidating in the background. The long SWR window matters for the solo-user cold-open
        // case: opening the app after hours idle still gets an instant response (a possibly-stale
        // play SET that self-heals on the next 2-min poll) instead of paying the 7s on a fully
        // evicted edge cache. Display-price staleness is harmless since the order modal walks the
        // live book at placement (2026-06-15). `?bust=1` (manual ↻) and debug stay no-store so
        // neither serves nor populates the shared cache.
        return jsonResponse(playsResult, isBustCache ? true : "public, s-maxage=120, stale-while-revalidate=86400");
}
