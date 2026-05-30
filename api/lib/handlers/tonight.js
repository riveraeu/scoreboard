// api/lib/handlers/tonight.js
// Extracted from api/[...path].js during Phase A (2026-05-26). Zero behavior change —
// imports + helpers needed only by the tonight pipeline moved with the block. The
// outer indentation level (8 spaces) is preserved from the original nesting; future
// phases will reformat.
import { ALLOWED_ORIGIN, corsHeaders, jsonResponse, errorResponse, fetchSafe, parseGameOdds, parseGameScores, parseTopPlayers, buildSoftTeamAbbrs, buildHardTeamAbbrs, buildTeamRankMap } from "../utils.js";
import { PARK_KFACTOR, PARK_HITFACTOR, PARK_RUNFACTOR, UMPIRE_KFACTOR, log5K, poissonCDF, log5HitRate, simulateKsDist, kDistPct, buildNbaStatDist, nbaDistPct, simulateHits, simulateMLBTotalDist, simulateMLBJoint, simulateNBAJoint, mlPctFromJoint, joint3WayPct, spreadPctFromJoint, simulateNBATotalDist, simulateNHLTotalDist, totalDistPct, simulateTeamTotalDist, simulateTeamPtsDist, lambdaForPoissonTail, muForNegBinTail, negBinCDF, meanForNormalTail, normCDF } from "../simulate.js";
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
import { KALSHI_GATE, KALSHI_CAP, EDGE_GATE_SERVER as EDGE_GATE } from "../config.js";
import { TEAM_NORM, normTeam, parseGameTeams } from "../tonight/parse-teams.js";
import { emitAllMlAndSpread } from "../tonight/ml-spread.js";
import { emitGameTotalPlays } from "../tonight/game-totals.js";
import { emitPropPlays } from "../tonight/props.js";

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

// Domed MLB stadiums — weather factor does not apply.
const _MLB_DOMED = new Set(["TB", "TOR", "HOU", "MIA", "SEA", "ARI", "TEX", "MIL"]);

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
        // nhlSoftTeams / mlbSoftTeams / glCacheKey / _MLB_DOMED / _parseWind / _extractMlbWeather
        // / injury helpers — moved to module level (Phase B, 2026-05-29).
        const isDebugMode = params.get("debug") === "1";
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
          const segment = cfg.segment || "full"; // "f5" for segmented markets, "full" otherwise
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
              totalMarkets.push({ gameType: "total", sport, stat, col, segment, threshold, kalshiPct: pct, americanOdds: _toAO, noKalshiPct: noPct, noKalshiAO: _tNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, gameDate: _tGameDate, kalshiSpread: _tSpread, _ticker: m.ticker, _yesAsk: yesAsk, _yesBid: _tYesBid, _noAsk: noAsk });
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
              spreadMarkets.push({ gameType: "spread", sport, stat, col, segment, line: strike, marginTeam, kalshiPct: pct, americanOdds: _spAO, noKalshiPct: noPct, noKalshiAO: _spNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, gameDate: _spGameDate, kalshiSpread: _spSpread, _ticker: m.ticker, _yesAsk: yesAsk, _noAsk: noAsk });
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
            weatherByGame,
            nbaInjuryMap, wnbaInjuryMap, nbaUsageMap, wnbaUsageMap,
            mlbBothTeamsConfirmed: _mlbBothTeamsConfirmed,
            sportByteam,
            leagueAvgCache,
            mlbRPGMap, mlbRoadRPGMap, mlbTeamERAMap, mlbTeamWHIPMap, mlbBullpenERAMap,
            nhlGPGMap, nhlGAAMap, nhlLeagueAvgGAA, nhlGoalieByTeam, nhlLeagueAvgSV,
            nbaOffPPGMap, nbaLeagueAvgOffPPG,
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
            // Segment qualifier: F5 (first-5-innings) and full-game markets on the same matchup
            // are *independent* bets — different outcomes resolve them — so they must not dedup
            // against each other. Default to "full" when absent.
            const _seg = p.segment || "full";
            if (p.gameType === "total") return `gt|${p.sport}|${_seg}|${p.homeTeam}|${p.awayTeam}|${p.gameDate}|${p.direction || 'over'}`;
            if (p.gameType === "teamTotal") return `tt|${p.sport}|${_seg}|${p.scoringTeam}|${p.oppTeam}|${p.gameDate}|${p.direction || 'over'}`;
            // Spread: matchup-symmetric key (sort teams) so BOTH sides of the same game land in
            // the same group — keeps only the highest-edge spread pick per matchup. Both-sides
            // qualifying happens on near-pick'em games where the model thinks each team keeps
            // it close on the cover line; correlation risk is similar to alt-line stacking.
            if (p.gameType === "spread") {
              const teams = [p.pickTeam, p.oppTeam].sort().join('|');
              return `sp|${p.sport}|${_seg}|${teams}|${p.gameDate}`;
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
}
