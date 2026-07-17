// api/lib/tonight/props.js
// Player prop play generation — MLB (K + HRR), NBA, WNBA, NHL.
// Extracted from api/lib/handlers/tonight.js Phase B6 (2026-05-29). Zero behavior change.
// Returns { plays, dropped, nbaDropped } for use by the rest of the pipeline.

import { log5K, log5HitRate, PARK_KFACTOR, PARK_HITFACTOR, UMPIRE_KFACTOR, poissonCDF, simulateKsDist, kDistPct, buildNbaStatDist, nbaDistPct, binomTailPct, tbTailPct } from "../simulate.js";
import { KALSHI_GATE, KALSHI_CAP, EDGE_GATE_SERVER as EDGE_GATE, betWindowFor } from "../config.js";
import { ptDateMinusOne } from "../pt.js";

const PROD_SPORTS = new Set(["mlb", "nba", "nhl", "wnba"]);
const normName = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Context: loopMarkets, playerInfoMap, playerGamelogs, STAT_SOFT, sportByteam, gameTimes,
//          nba/wnba injury+usage maps, allPositionsDvp, nbaDepthChartPos, wnbaDvpMap,
//          isDebug, _todayPT.
export async function emitPropPlays({
  loopMarkets, playerInfoMap, playerGamelogs,
  STAT_SOFT, sportByteam, gameTimes,
  nbaInjuryMap, wnbaInjuryMap, nbaUsageMap, wnbaUsageMap,
  allPositionsDvp, nbaDepthChartPos, wnbaDvpMap,
  isDebug, _todayPT,
  leagueAvgCache, nhlGPGMap, nhlGAAMap, nhlLeagueAvgGAA,
  nbaPaceData, wnbaPaceData, nhlSaRankMap, nhlLeagueAvgSa,
  pitcherGamelogs, nbaPlayerStatus,
}) {
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
      getStat = (ev) => (parseFloat(ev.stats[hIdx]) || 0) + (parseFloat(ev.stats[dIdx]) || 0) + 2 * (parseFloat(ev.stats[tIdx]) || 0) + 3 * (parseFloat(ev.stats[hrIdx]) || 0);
    } else if (colIdx === -1 && col === "HRR" && sport === "mlb") {
      const hIdx = gl.ul.indexOf("H"), rIdx = gl.ul.indexOf("R"), rbiIdx = gl.ul.indexOf("RBI");
      if (hIdx === -1 || rIdx === -1 || rbiIdx === -1) {
        playerColCache[cacheKey] = null;
        continue;
      }
      getStat = (ev) => (parseFloat(ev.stats[hIdx]) || 0) + (parseFloat(ev.stats[rIdx]) || 0) + (parseFloat(ev.stats[rbiIdx]) || 0);
    } else if (colIdx === -1) {
      playerColCache[cacheKey] = null;
      continue;
    } else {
      getStat = (ev) => parseFloat(ev.stats[colIdx]);
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
  for (const { playerName, playerNameDisplay, sport, stat, col, threshold, kalshiPct, americanOdds, kalshiVolume, kalshiSpread, gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate, lineMove, thinMarket, marketConfidence, direction, noKalshiPct, noKalshiAO, _ticker: _propKalshiTicker } of loopMarkets) {
    const key = `${sport}|${playerName}`;
    const info = playerInfoMap[key];
    const gl = playerGamelogs[key];
    if (!info || !gl) {
      if (isDebug) dropped.push({ playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, reason: !info ? "no_espn_info" : "no_gamelog", gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate });
      continue;
    }
    const softData = STAT_SOFT[`${sport}|${stat}`];
    if (!softData) {
      if (isDebug) dropped.push({ playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, reason: "no_soft_data", gameDate });
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
    // Base fields included on every drop in this loop. direction + noKalshi* ("under",
    // totalBases only) ride along so shadow rows + debug drops carry the NO side they price.
    const _dropBase = { playerName: playerNameDisplay || playerName, sport, stat, threshold, kalshiPct, playerTeam, ...(direction ? { direction, noKalshiPct, noKalshiAO } : {}) };
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
    const yesterdayStr = ptDateMinusOne(_todayPT);
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
      // Handedness fallback: vsR/vsL HRR splits from MLB Stats API (Poisson tail at the line)
      // Covers all 2025+2026 games vs same-hand pitchers — far broader than pitcherGamelogs cross-reference
      // HRR only: the lambda is (H+R+RBI)/G — roughly 2× a hits-per-game rate, so this override
      // would inflate the hits-prop soft ref. Hits gets its platoon signal via batterSplitBA instead.
      // Threshold-aware (2026-06-12): P(X≥threshold) = 1 − poissonCDF(threshold−1, λ), not a fixed
      // P(≥1). At threshold 1 this reduces to 1 − e^(−λ) (unchanged for 1+ overs). Caveat: HRR is
      // lumpy (a solo HR is instantly 3 HRR), so Poisson understates the upper tail for power bats —
      // this is last-resort only; empirical season/BvP hit rates stay primary via _effectiveHitRate.
      let _h2hHandRate = null;
      if (stat === "hrr" && _h2hHitRate == null && _oppPitcherHand) {
        const _hrrSplitMap = sportByteam.mlb?.batterHRRSplits || {};
        const _hrrEntry = _hrrSplitMap[_bsKey] ?? _hrrSplitMap[_brlNorm(playerNameDisplay)] ?? null;
        const _hrrHandKey = _oppPitcherHand === "R" ? "vsR" : "vsL";
        const _hrrSplit = _hrrEntry?.[_hrrHandKey] ?? null;
        if (_hrrSplit && _hrrSplit.g >= 10) {
          const _lambda = _hrrSplit.hrr / _hrrSplit.g;
          _h2hHandRate = parseFloat(((1 - poissonCDF(threshold - 1, _lambda)) * 100).toFixed(1));
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
      // Hits prop model (2026-06-11): exact binomial tail over expected ABs.
      //   pHit = effectiveBA (recent-blended) × platoon adj × pitcher-BAA ratio × park hit factor
      //   nAB  = player's own AB/game, scaled by tonight's lineup-spot PA load vs typical
      // Replaces the v0 MC sim (fixed 4 PA, no platoon, no pitcher-quality regression).
      // Total-bases prop model (2026-06-12) shares pHit/nAB and adds a per-hit bases split
      // (1B/2B/3B/HR shares from the blended gamelog, shrunk to league) → tbTailPct.
      if ((stat === "hits" || stat === "totalBases") && hitterEffectiveBA != null) {
        const _LG_BA_H = 0.248;
        // Pitcher BAA: regressed statsapi value (matchup key first — doubleheader-safe),
        // falling back to the gamelog H/TBF estimate scaled to per-AB units (TBF includes
        // BB/HBP, deflating it ~11% vs true BAA), then league mean.
        const _baaMap = sportByteam.mlb?.pitcherBAAByTeam || {};
        const _baaEff = _baaMap[`${tonightOpp}|${playerTeam}`] ?? _baaMap[tonightOpp]
          ?? (pitcherBAA != null ? Math.min(0.400, parseFloat((pitcherBAA * 1.12).toFixed(3))) : null);
        // Platoon: shrunk ratio of split BA to overall BA (batterSplitBA has a ≥20 AB gate upstream)
        const _platoonAdjH = hitterPlatoonRatio != null ? Math.max(0.88, Math.min(1.12, hitterPlatoonRatio)) : 1.0;
        const _pHit = Math.max(0.08, Math.min(0.50,
          hitterEffectiveBA * _platoonAdjH * ((_baaEff ?? _LG_BA_H) / _LG_BA_H) * _hlParkKF2));
        // Expected ABs: own AB/game (reflects the player's walk rate + usual spot), scaled by
        // tonight's lineup-spot PA load vs typical when both are known and differ meaningfully
        // (same gate as the HRR PA-aware adjustment). Spots ≥6 were discarded at Stage 1.
        let _abPerGame = null;
        if (abIdxH !== -1 && blendEventsH.length >= 15) {
          const _abTot = blendEventsH.reduce((s, ev) => s + (parseFloat(ev.stats[abIdxH]) || 0), 0);
          if (_abTot > 0) _abPerGame = _abTot / blendEventsH.length;
        }
        const _paSpotH = hitterLineupSpot != null ? Math.max(3.5, 4.7 - 0.13 * (hitterLineupSpot - 1)) : null;
        const _typPA_H = sportByteam.mlb?.hitterTypicalPA?.[_brlNorm(playerName)] ?? sportByteam.mlb?.hitterTypicalPA?.[_brlNorm(playerNameDisplay)] ?? null;
        let _nAB = _abPerGame ?? (_paSpotH != null ? _paSpotH * 0.89 : 3.9);
        if (_abPerGame != null && _paSpotH != null && _typPA_H != null && Math.abs(_paSpotH - _typPA_H) >= 0.3) {
          _nAB = _abPerGame * (_paSpotH / _typPA_H);
        }
        if (stat === "hits") {
          hitterSimPctOut = binomTailPct(_nAB, _pHit, threshold);
        } else {
          // Hit-type shares [1B, 2B, 3B, HR] from the blended '25+'26 gamelog, shrunk
          // toward the league split with a 40-hit prior — a 50-hit sample of pure
          // singles still carries meaningful XBH probability, and small samples don't
          // fabricate power. Singles derived as H − 2B − 3B − HR.
          const _LG_SHARES = [0.635, 0.199, 0.017, 0.149];
          const _PRIOR_HITS = 40;
          const _dIdxTB = gl.ul.indexOf("2B"), _tIdxTB = gl.ul.indexOf("3B"), _hrIdxTB = gl.ul.indexOf("HR");
          let _shares = _LG_SHARES;
          if (hIdx2 !== -1 && _dIdxTB !== -1 && _tIdxTB !== -1 && _hrIdxTB !== -1) {
            let _h = 0, _d = 0, _t3 = 0, _hr = 0;
            for (const ev of blendEventsH) {
              _h  += parseFloat(ev.stats[hIdx2])   || 0;
              _d  += parseFloat(ev.stats[_dIdxTB]) || 0;
              _t3 += parseFloat(ev.stats[_tIdxTB]) || 0;
              _hr += parseFloat(ev.stats[_hrIdxTB]) || 0;
            }
            const _s1 = Math.max(0, _h - _d - _t3 - _hr);
            if (_h > 0) {
              const _w = _h / (_h + _PRIOR_HITS);
              _shares = [
                _w * (_s1 / _h) + (1 - _w) * _LG_SHARES[0],
                _w * (_d  / _h) + (1 - _w) * _LG_SHARES[1],
                _w * (_t3 / _h) + (1 - _w) * _LG_SHARES[2],
                _w * (_hr / _h) + (1 - _w) * _LG_SHARES[3],
              ];
            }
          }
          hitterSimPctOut = tbTailPct(_nAB, _pHit, _shares, threshold);
        }
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
        // Playoff-aware lambda (added 2026-05-26): if tonight's game is postseason
        // AND the player has ≥5 playoff games in their gamelog, use playoff-only
        // games as the meanRecent source. The full sample still drives std/variance.
        // Falls back gracefully to the existing flat-10 mixed slice otherwise.
        const _nbaIsPlayoff = Object.values(sportByteam.nbaGameScores || {}).some(g =>
          g?.seasonType === 3 && (g.homeTeam === playerTeam || g.awayTeam === playerTeam)
        );
        const _nbaPlayoffVals = _nbaIsPlayoff
          ? gl.events.filter(ev => ev.isPlayoff).map(getStat).filter(v => !isNaN(v) && v >= 0)
          : null;
        const _nbaRecentVals = (_nbaPlayoffVals && _nbaPlayoffVals.length >= 5) ? _nbaPlayoffVals : null;
        nbaPlayerDistCache[_nbaDistKey] = buildNbaStatDist(_nbaGameValsAll, teamDefFactorOut, null, isB2B, _nSim, nbaMiscAdj, nbaPaceFactor, _nbaRecentVals);
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
        // Playoff-aware lambda (added 2026-05-26) — mirror of NBA branch.
        const _wnbaIsPlayoff = Object.values(sportByteam.wnbaGameScores || {}).some(g =>
          g?.seasonType === 3 && (g.homeTeam === playerTeam || g.awayTeam === playerTeam)
        );
        const _wnbaPlayoffVals = _wnbaIsPlayoff
          ? gl.events.filter(ev => ev.isPlayoff).map(getStat).filter(v => !isNaN(v) && v >= 0)
          : null;
        const _wnbaRecentVals = (_wnbaPlayoffVals && _wnbaPlayoffVals.length >= 5) ? _wnbaPlayoffVals : null;
        wnbaPlayerDistCache[_wnbaDistKey] = buildNbaStatDist(_wnbaGameValsAll, teamDefFactorOut, null, isB2B, _wnSim, wnbaMiscAdj, wnbaPaceFactor, _wnbaRecentVals);
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
        // Playoff-aware lambda (added 2026-05-26) — NHL playoffs run May–June, so this
        // is the immediate beneficiary. Mirror of NBA/WNBA branches.
        const _nhlIsPlayoff = Object.values(sportByteam.nhlGameScores || {}).some(g =>
          g?.seasonType === 3 && (g.homeTeam === playerTeam || g.awayTeam === playerTeam)
        );
        const _nhlPlayoffVals = _nhlIsPlayoff
          ? gl.events.filter(ev => ev.isPlayoff).map(getStat).filter(v => !isNaN(v) && v >= 0)
          : null;
        const _nhlRecentVals = (_nhlPlayoffVals && _nhlPlayoffVals.length >= 5) ? _nhlPlayoffVals : null;
        nhlPlayerDistCache[_nhlDistKey] = buildNbaStatDist(_nhlGameVals, teamDefFactorOut, nhlShotsAdj, isB2B, _nSim, nhlToiTrendAdj, null, _nhlRecentVals);
      }
      nhlSimPctOut = nbaDistPct(nhlPlayerDistCache[_nhlDistKey], threshold);
    }
    let _hrrBarrelAdj = null, _hrrFipAdj = null, _hrrWeatherAdj = null, _hrrWindOut = null, _hrrTempF = null;
    let _hrrPaFromSpot = null, _hrrTypicalPA = null, _hrrSeasonPctAdj = null, _hrrSoftPctAdj = null;
    // Sample-weighted seasonRate blend for prop truePct (added 2026-05-26). Same shape
    // as the game-total seasonHitRate blend: anchor pure-sim truePct toward the
    // empirical threshold hit rate from the player's own gamelog. The reference rate
    // matches each sport's existing no-sim fallback formula so the blend is a smooth
    // transition. capWeight is the max anchor strength at 20+ games:
    //   - 0.50 for sim-based props (NBA/WNBA/NHL) — pure-sim drift correction
    //   - 0.40 for MLB strikeouts (lowered 0.5→0.4 2026-07-06) — tune:kblend
    //     counterfactual: the hit-rate anchor was the residual sweep's noise carrier
    //     (held-out ΔBrier +2.24m at 0.4, CI-lo>0; global shrink failed OOS).
    //   - 0.25 for MLB HRR (added later same day) — already rate-based at the logit
    //     core, so the blend is a sanity check against multiplicative stacking
    //     (park × ops × whip × barrel), not a real damper.
    const _propBlend = (simPct, refPct, sample, capWeight = 0.5) => {
      if (simPct == null || refPct == null) return simPct;
      const _w = Math.min(1, (sample || 0) / 20) * capWeight;
      return _w > 0 ? (1 - _w) * simPct + _w * refPct : simPct;
    };
    const rawTruePct = (() => {
      if (sport === "mlb" && stat === "strikeouts") {
        const _kRef = softPct !== null ? (primaryPct + softPct) / 2 : primaryPct;
        if (simPctOut !== null) return _propBlend(simPctOut, _kRef, allVals.length, 0.4);
        // Fallback: average of season rate + soft matchup rate
        const parts = [primaryPct, ...softPct !== null ? [softPct] : []];
        return parts.reduce((a, b) => a + b, 0) / parts.length;
      }
      if (sport === "mlb" && (stat === "hits" || stat === "totalBases") && hasSeasonTags) {
        // Hits prop: binomial-tail model blended toward the empirical threshold hit rate
        // (capWeight 0.5 like the other sim-based props), then a conservative sigmoid cap
        // (knee=80, max≈85 — unproven market, shrink aggressively until shadow calibrates;
        // P(≥1 hit) for a good hitter legitimately sits in the mid-70s so the HRR 68-knee
        // below would systematically crush hits truePcts and fabricate UNDER edges).
        // Total bases (2026-06-12) shares this branch: same tail-model shape (tbTailPct),
        // same empirical-threshold ref via the TB getStat, same conservative cap.
        const _hitsRef = softPct !== null ? (primaryPct + softPct) / 2 : primaryPct;
        const _hitsBase = hitterSimPctOut !== null ? _propBlend(hitterSimPctOut, _hitsRef, allVals.length) : _hitsRef;
        return _hitsBase <= 80 ? parseFloat(_hitsBase.toFixed(1)) : parseFloat((80 + 5 * (1 - Math.exp(-0.4 * (_hitsBase - 80)))).toFixed(1));
      }
      if (sport === "mlb" && hasSeasonTags) {
        // PA-aware adjustment (retry 2026-05-25). First attempt used a flat 4.0 PA baseline
        // and was reverted — pushed predictions UP for every spot since all of spots 1-5 sit
        // above 4.0 PAs/game. This retry uses the hitter's actual typical PA/game derived
        // from season GP, gated to only adjust when typical ≠ tonight by ≥0.3 PAs. Hitters
        // batting at their normal spot get no adjustment (which is correct — their seasonPct
        // already reflects games at this PA load). Hitters bumped up/down in the order get
        // the real opportunity delta. Requires GP ≥ 20 for the baseline to populate.
        const _paFromSpot = (spot) => spot == null ? null : Math.max(3.5, 4.7 - 0.13 * (spot - 1));
        const _nPAtonight = _paFromSpot(hitterLineupSpot);
        const _bsNormInline = n => n ? n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() : "";
        const _hitterTypicalPA = sportByteam.mlb?.hitterTypicalPA?.[_bsNormInline(playerName)] ?? sportByteam.mlb?.hitterTypicalPA?.[_bsNormInline(playerNameDisplay)] ?? null;
        let basePct = primaryPct;
        let _adjSoft = softPct;
        if (_nPAtonight != null && _hitterTypicalPA != null && Math.abs(_nPAtonight - _hitterTypicalPA) >= 0.3) {
          _hrrPaFromSpot = _nPAtonight;
          _hrrTypicalPA  = _hitterTypicalPA;
          const _paAdjust = (pctGame) => {
            if (pctGame == null) return pctGame;
            const _p = Math.max(0.001, Math.min(0.999, pctGame / 100));
            const perPA = 1 - Math.pow(1 - _p, 1 / _hitterTypicalPA);
            return parseFloat(((1 - Math.pow(1 - perPA, _nPAtonight)) * 100).toFixed(2));
          };
          const _adjPrimary = _paAdjust(primaryPct);
          if (_adjPrimary !== primaryPct) _hrrSeasonPctAdj = _adjPrimary;
          if (softPct !== null) {
            _adjSoft = _paAdjust(softPct);
            if (_adjSoft !== softPct) _hrrSoftPctAdj = _adjSoft;
          }
          basePct = _adjPrimary;
        }
        // BvP shrinkage (2026-05-16): small-sample BvP rates (e.g., 10/10 = 100%) were
        // dominating the 50/50 blend and inflating truePct (Bellinger vs Brazoban case:
        // truePct 90.9% vs market 74% = +16.9% edge). Bayesian-style shrinkage with N=20
        // "prior games" pulls extreme BvP rates toward the player's own season rate.
        // At softGames=20 the blend is 50/50 BvP/season-prior; at softGames=10, BvP gets
        // ~33% weight. Hand-source softPct skips shrinkage (handedness samples are large).
        const _bvpN = 20;
        const _isBvPSrc = hitterH2HSource === 'bvp' && softVals.length > 0 && _adjSoft !== null;
        const _shrunkSoftPct = _isBvPSrc
          ? (softVals.length * _adjSoft + _bvpN * basePct) / (softVals.length + _bvpN)
          : _adjSoft;
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
        // Barrel% adjustment (2026-05-25): quality-of-contact signal beyond OPS. Top barrel
        // hitters (~14%) lift truePct ~1.5pt; weakest contact (~5%) drops ~1.5pt. Weight 0.25
        // (lower than OPS) since barrel rate is per-batted-ball — more volatile per game than
        // season OPS. Was previously SimScore-only via hitterBarrelPts; now also in lambda.
        const _LG_BARREL = 8.5;
        const barrelAdj = hitterBarrelPct != null ? Math.max(0.92, Math.min(1.10, hitterBarrelPct / _LG_BARREL)) : 1.0;
        if (barrelAdj !== 1.0) _hrrBarrelAdj = parseFloat(barrelAdj.toFixed(3));
        // FIP-over-WHIP split (2026-06-22): WHIP is a traffic stat — wrong for HRR's HR component.
        // Split the pitcher term: keep WHIP (0.15) for contact/traffic, add FIP (0.18) for HR/run
        // allowance (FIP = 13·HR + …). Weights drop WHIP 0.30→0.15 to avoid double-counting traffic.
        const _LG_FIP_HRR = 4.20;
        const fipAdj = pitcherFIP != null ? Math.max(0.92, Math.min(1.10, Math.pow(pitcherFIP / _LG_FIP_HRR, 0.5))) : 1.0;
        if (fipAdj !== 1.0) _hrrFipAdj = parseFloat(fipAdj.toFixed(3));
        // Game-time weather (2026-06-22, shadow-only): wind out to CF + warmth lift HR/run carry —
        // signal the static park factor can't see. Coeffs provisional, anchored to published HR
        // sensitivities (~1%/mph out, ~0.6%/°F), NOT market. Dome/retractable parks → neutral 1.0.
        const _wx = sportByteam.mlb?.weatherByTeam?.[homeTeam];
        const _W_WIND = 0.010, _W_TEMP = 0.006;
        const weatherAdj = (_wx && !_wx.dome && _wx.windOutMph != null)
          ? Math.max(0.93, Math.min(1.10, 1 + _wx.windOutMph * _W_WIND + (_wx.tempF - 70) * _W_TEMP))
          : 1.0;
        if (weatherAdj !== 1.0) { _hrrWeatherAdj = parseFloat(weatherAdj.toFixed(3)); _hrrWindOut = _wx.windOutMph; _hrrTempF = _wx.tempF; }
        const _p = Math.max(0.01, Math.min(0.99, rawMlbPct / 100));
        // OPS weight reduced 0.4→0.25 (2026-06-10): n=345 shadow showed dominant 70–75% band
        // hitting 68.4% actual vs 72.5% predicted (−4.1 delta, ROI −7%). Kalshi prices HRR at
        // 72–76% — market is efficient; the 0.4 OPS boost was stacking with WHIP/barrel to push
        // truePct above what the market already priced in. Smaller weight preserves the signal
        // direction without overclaiming edge.
        const _logOddsAdj = Math.log(_p / (1 - _p)) + Math.log(parkFactor)
          + 0.25 * Math.log(opsAdj) + 0.15 * Math.log(whipAdj) + 0.18 * Math.log(fipAdj)
          + 0.25 * Math.log(barrelAdj) + 0.20 * Math.log(weatherAdj);
        const _hrrAdjusted = Math.min(99.9, parseFloat((100 / (1 + Math.exp(-_logOddsAdj))).toFixed(1)));
        // Gentle seasonRate anchor (capWeight=0.25, half the sim-based prop cap). HRR's
        // logit-sigmoid is rate-based at its core (base = rawMlbPct = (primaryPct + softPct)/2)
        // but the multiplicative adjustments (park × OPS × WHIP × barrel) can drift ~7 pp
        // above the un-adjusted base when stacked. Blending back toward rawMlbPct preserves
        // most of the matchup signal while sanity-checking against extreme stacks.
        const _hrrBlended = _propBlend(_hrrAdjusted, rawMlbPct, allVals.length, 0.25);
        // Sigmoid cap: compresses high outputs toward a 71% ceiling (knee=68, headroom=3pp,
        // rate=0.5, max≈71). Shadow n=345 shows actual HRR plateau at ~68–71% (not 72%
        // from the 2022-24 backtest). Formula: values ≤68 pass unchanged; above 68 compressed.
        // knee=68 ensures 70→69.9, 72→70.6, 75→70.9, 80→71.0 — matching observed shadow plateau.
        // Cap knee lowered 72→68 (2026-06-10): combined with OPS weight 0.4→0.25 gives ~2-4pp
        // deflation in the dominant 70-75% band (actual 68.4%, was predicting 72.5%).
        return _hrrBlended <= 68 ? _hrrBlended : parseFloat((68 + 3 * (1 - Math.exp(-0.5 * (_hrrBlended - 68)))).toFixed(1));
      }
      if (sport === "nba") {
        const _nbaRef = softPct !== null ? (seasonPct + softPct) / 2 : seasonPct;
        if (nbaSimPctOut !== null) return _propBlend(nbaSimPctOut, _nbaRef, allVals.length);
        // Fallback: season/soft blend when sim couldn't run
        let base = _nbaRef;
        if (isB2B) base = Math.max(0, base - 4);
        return base;
      }
      if (sport === "wnba") {
        const _wnbaRef = softPct !== null ? (seasonPct + softPct) / 2 : seasonPct;
        if (wnbaSimPctOut !== null) return _propBlend(wnbaSimPctOut, _wnbaRef, allVals.length);
        let base = _wnbaRef;
        if (isB2B) base = Math.max(0, base - 4);
        return base;
      }
      if (sport === "nhl") {
        const _nhlRef = softPct !== null ? (seasonPct + softPct) / 2 : seasonPct;
        if (nhlSimPctOut !== null) return _propBlend(nhlSimPctOut, _nhlRef, allVals.length);
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
    // Under-direction props (totalBases, 2026-06-12) follow the totals storage convention:
    // truePct/kalshiPct stay over-framed everywhere (emit, shadow rows, debug fields); only
    // the bet-side values below flip — P(<t) vs the NO ask — so edge prices the side we'd
    // actually buy. The shadow report SQL flips under rows the same way at read time.
    //
    // HRR NO-side flip (2026-07-11): market systematically overprices hits by ~7¢. The sigmoid
    // cap (71%) prevents the model from ever clearing market prices (~74¢ avg), so YES bets can't
    // generate edge. Edge lives on NO. When NO edge > YES edge and noKalshiPct is available,
    // redirect to the NO side — same over-framed storage convention as totalBases "under".
    let _effectiveDirection = direction;
    if (stat === "hrr" && noKalshiPct != null) {
      const _noEdge = (100 - truePct) - noKalshiPct;
      if (_noEdge > truePct - kalshiPct) _effectiveDirection = "under";
    }
    const _betTruePct = _effectiveDirection === "under" ? 100 - truePct : truePct;
    const _betKalshiPct = _effectiveDirection === "under" ? (noKalshiPct ?? 100 - kalshiPct) : kalshiPct;
    const rawEdge = _betTruePct - _betKalshiPct;
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
    // Per-category bet window: the derived [lo,hi] override if one is set in CATEGORY_BET_WINDOWS
    // (populated only after a tune:window GO at n≥200), else the global [KALSHI_GATE, KALSHI_CAP].
    const [_betLo, _betHi] = betWindowFor(sport, stat);
    if (_betKalshiPct < _betLo || _betKalshiPct > _betHi || edge < EDGE_GATE) {
      const _dropObj = {
        ..._dropBase,
        truePct: parseFloat(truePct.toFixed(1)), rawTruePct: parseFloat(rawTruePct.toFixed(1)),
        edge: parseFloat(edge.toFixed(1)),
        reason: edge < EDGE_GATE ? "edge_too_low" : _betKalshiPct > _betHi ? "kalshi_pct_too_high" : "kalshi_pct_too_low",
        opponent: tonightOpp, seasonPct: parseFloat((primaryPct).toFixed(1)),
        seasonGames: allVals.length,
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
          ...(_hrrBarrelAdj !== null && { hitterBarrelAdj: _hrrBarrelAdj }),
          ...(_hrrFipAdj !== null && { hitterFipAdj: _hrrFipAdj }),
          ...(_hrrWeatherAdj !== null && { hitterWeatherAdj: _hrrWeatherAdj, windOutMph: _hrrWindOut, tempF: _hrrTempF }),
          ...(_hrrPaFromSpot !== null && { hitterPaFromSpot: _hrrPaFromSpot, hitterTypicalPA: _hrrTypicalPA }),
          ...(_hrrSeasonPctAdj !== null && { seasonPctAdj: _hrrSeasonPctAdj }),
          ...(_hrrSoftPctAdj !== null && { softPctAdj: _hrrSoftPctAdj }),
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
        ...(_effectiveDirection ? { direction: _effectiveDirection, noKalshiPct, noKalshiAO, noTruePct: parseFloat((100 - truePct).toFixed(1)) } : {}),
        qualified: false,
        playerName: playerNameDisplay || playerName,
        playerId: info.id,
        sport, playerTeam, stat, threshold, kalshiPct,
        americanOdds: _effectiveDirection === "under" ? noKalshiAO : americanOdds,
        kalshiTicker: _propKalshiTicker ?? null,
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
        kalshiTicker: _propKalshiTicker ?? null,
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
    const mlbH2H = sport === "mlb" && softPct !== null;
    plays.push({
      qualified: true,
      // Under props: totals convention — over-framed truePct/kalshiPct + NO side fields.
      ...(_effectiveDirection ? { direction: _effectiveDirection, noKalshiPct, noKalshiAO, noTruePct: parseFloat((100 - truePct).toFixed(1)) } : {}),
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
      // Under props bet the NO side — americanOdds mirrors the bought side (totals convention).
      americanOdds: _effectiveDirection === "under" ? noKalshiAO : americanOdds,
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
      marketConfidence: marketConfidence ?? "thin",
      // Side must follow the flip: under-direction props are a NO buy — the whole client order
      // chain (sizing, book walk, order POST) keys off kalshiSide, same as the totals under emits.
      kalshiTicker: _propKalshiTicker ?? null, kalshiSide: _effectiveDirection === "under" ? "no" : "yes",
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
  // Dedup plays to one per player+stat for the plays card. Non-headline thresholds carry
  // qualified:false so the player card can still show them per-threshold (keys include
  // threshold to preserve them).
  const bestMap = {};
  for (const play of plays) {
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
        // Apply the seasonRate blend (same shape as the IIFE/monotonicity step) so the
        // qualified:false extras shown on the player card have blended truePct too.
        let _blendedTp = _truePct;
        if (_truePct != null) {
          const _refRate = (other.softPct != null && other.seasonPct != null)
            ? (other.seasonPct + other.softPct) / 2
            : other.seasonPct;
          const _sample = other.seasonGames ?? 0;
          const _w = Math.min(1, _sample / 20) * 0.5;
          if (_w > 0 && _refRate != null) {
            _blendedTp = parseFloat(((1 - _w) * _truePct + _w * _refRate).toFixed(1));
          }
        }
        _extraSkPlays.push({ ...other, qualified: false, truePct: _blendedTp ?? other.truePct, simPct: _truePct ?? other.simPct, edge: _blendedTp != null ? parseFloat((_blendedTp - other.kalshiPct).toFixed(1)) : other.edge });
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
        // Re-apply the seasonRate blend that buildTruePct already applies in the IIFE — otherwise
        // this step overwrites it with raw sim, which is exactly the bug that made Peterson's
        // 89.3% truePct lock in despite seasonPct=54.5% (audit 2026-05-26).
        for (const play of group) {
          const _recomp = kDistPct(_dist, play.threshold);
          if (_recomp != null) {
            play.simPct = _recomp;
            const _refRate = (play.softPct != null && play.seasonPct != null)
              ? (play.seasonPct + play.softPct) / 2
              : play.seasonPct;
            const _sample = play.seasonGames ?? 0;
            const _w = Math.min(1, _sample / 20) * 0.5;
            const _blended = (_w > 0 && _refRate != null)
              ? (1 - _w) * _recomp + _w * _refRate
              : _recomp;
            play.truePct = parseFloat(_blended.toFixed(1));
            play.edge = parseFloat((play.truePct - play.kalshiPct).toFixed(1));
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
  return { plays, dropped, nbaDropped };
}
