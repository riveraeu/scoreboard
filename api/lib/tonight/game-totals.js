// api/lib/tonight/game-totals.js
// Game total + team total play emission — all sports (MLB, NBA, WNBA, NHL).
// Extracted from api/lib/handlers/tonight.js Phase B5 (2026-05-29). Zero behavior change.
// Returns the _*MlContext maps consumed by emitAllMlAndSpread in ml-spread.js.

import { PARK_RUNFACTOR, UMPIRE_KFACTOR, poissonCDF, simulateMLBTotalDist, simulateMLBJoint, simulateNBAJoint, simulateNBATotalDist, simulateNHLTotalDist, totalDistPct, simulateTeamTotalDist, simulateTeamPtsDist, lambdaForPoissonTail, muForNegBinTail, negBinCDF, meanForNormalTail, normCDF } from "../simulate.js";
import { KALSHI_GATE, KALSHI_CAP, EDGE_GATE_SERVER as EDGE_GATE } from "../config.js";
import { _GT_IMPLIED_CAP, _TT_IMPLIED_CAP } from "./dc.js";
import { normTeam } from "./parse-teams.js";
import { PT_FMT, ptDateMinusOne } from "../pt.js";

// B2B lambda dampener constants (only used in game-total + team-total emission).
const B2B_NBA  = 0.975;
const B2B_WNBA = 0.975;
const B2B_NHL  = 1.05;

// True when the team played yesterday relative to `gameDate` (back-to-back detection).
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

// NBA/WNBA injury OffRtg adjustment — piecewise factor on pct of usage-weighted out players.
// Sums each Out player's USG% **weighted by their minutes share (avgMin/48)** so a low-minutes
// bench player can't contribute his full per-possession USG% as if he played the whole game.
// (Before 2026-05-30 this summed raw USG%, which over-counted: an OKC Game-7 slate with J-Williams
// + Mitchell + a 0-min rookie OUT summed to 49.1 — pushing the 36-50% tier — vs 27.8 weighted.)
// Players missing usage data contribute 0; players with usage but missing avgMin get weight 1.0
// (no de-weighting — conservative, preserves prior behavior for that gap). Cap floor 0.70.
// Tiers: ≤20% ×0.15, 21-35% ×0.22, 36-50% ×0.30, >50% ×0.35.
const _OFFRTG_INJ_CAP = 0.70;
const _injuryOffRtgFactor = (share) => share <= 20 ? 0.15 : share <= 35 ? 0.22 : share <= 50 ? 0.30 : 0.35;
const _NBAshortNorm = { GSW:"GS", SAS:"SA", NYK:"NY", NOP:"NO", PHX:"PHO" };
const _injuryOffRtgAdj = (team, injuryMap, usageMap, shortMap) => {
  const players = injuryMap.get(team) || injuryMap.get(shortMap?.[team]) || [];
  let share = 0;
  for (const p of players) {
    if (p.status !== "out") continue;
    const u = p.id ? usageMap[p.id] : null;
    const usg = u?.usg;
    if (usg != null && usg > 0) {
      // Weight by minutes share of a 48-min game, capped at 1.0. Missing avgMin → weight 1.0.
      const w = u?.avgMin != null ? Math.min(1, u.avgMin / 48) : 1;
      share += usg * w;
    }
  }
  share = parseFloat(share.toFixed(1));
  const factor = _injuryOffRtgFactor(share);
  const adj = Math.max(_OFFRTG_INJ_CAP, 1 - share / 100 * factor);
  return { share, adj: parseFloat(adj.toFixed(3)) };
};
// Damp regime/seasonHitRate blend weight linearly to 0 as USG-out rises. Range rescaled
// 2026-05-30 (60→42 / 30→21, ×0.7) to match the MPG-weighted usageOut now produced by
// _injuryOffRtgAdj — a full-time starter's ~0.7 minutes weight means the old 30-60 raw-sum
// range would no longer trigger damping at the same real injury severity. Pre-rescale, OKC's
// raw 49.1 gave damp 0.36; weighted 27.8 under the new range gives (42-27.8)/21 = 0.68 (vs 1.0
// = no damping under the old range), preserving the 2026-05-28 stale-blend protection.
const _injuryBlendDamp = (usageOut) => Math.max(0, Math.min(1, (42 - (usageOut || 0)) / 21));

// Context: plays/dropped (mutated via push), isDebug, cutoffStr, gameTimes,
//          CACHE2/isBustCache, PROD_SPORTS, totalMarkets/teamTotalMarkets, weatherByGame,
//          nba*/wnba* injury+usage maps, mlbBothTeamsConfirmed (closure), sportByteam.
// Returns: { _mlbMlContext, _nbaMlContext, _wnbaMlContext, _nhlMlContext } for ml-spread.js.
export async function emitGameTotalPlays({
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
  nbaPaceData, wnbaPaceData, STAT_SOFT,
}) {
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
  // NHL analog. homeLambda/awayLambda are NegBin goals — same engine as MLB; dispR fit
  // per-request from schedule residuals via _fitNhlDispersion (2026-05-29). Stored in
  // _nhlMlContext.dispR so ml-spread.js can pass it to simulateMLBJoint for ML + spread.
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
  // _injuryBlendDamp — module level.
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
    const _fitNhlDispersion = () => {
      let sumResid2 = 0, sumMean = 0, nGames = 0;
      for (const key in _gtScheduleMap) {
        if (!key.startsWith("nhl:")) continue;
        const team = key.slice(4);
        const evts = _gtScheduleMap[key];
        if (!evts || evts.length < 8) continue;
        const scores = [];
        for (const ev of evts) {
          const myComp = ev.comps?.find(c => normTeam("nhl", c.abbr) === team);
          if (myComp?.score != null) scores.push(myComp.score);
        }
        if (scores.length < 8) continue;
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
        for (const s of scores) { sumResid2 += (s - mean) * (s - mean); sumMean += mean; nGames += 1; }
      }
      if (nGames < 50) return 6;
      const pooledMean = sumMean / nGames;
      const pooledVar = sumResid2 / nGames;
      if (pooledVar <= pooledMean) return 50;
      const r = (pooledMean * pooledMean) / (pooledVar - pooledMean);
      return Math.max(3, Math.min(50, parseFloat(r.toFixed(2))));
    };
    const _nhlDispR = _fitNhlDispersion();
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
      // Segmented markets (e.g. MLB F5) emit through a dedicated F5 block further down;
      // skip them in the full-game total loop to avoid running full-game lambdas on F5 lines.
      if (tm.segment && tm.segment !== "full") continue;
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
        // Days-rest penalty (2026-05-25). MLB convention: "X days rest" = X full off-days
        // between starts, so a pitcher throwing 5/20 → 5/25 has 4 days rest (5/21-5/24 off).
        // Calendar diff = MLB-days-rest + 1. Short rest (3 days rest, calendar 4) costs
        // ~0.30 ERA; 4 days rest (calendar 5, one day short of normal rotation) ~0.15 ERA;
        // 5+ days rest (calendar 6+, normal) is the baseline. Stacked with TTO on FIP+ERA.
        const _daysRest = (lastStartIso, gameDate) => {
          if (!lastStartIso || !gameDate) return null;
          const last = new Date(lastStartIso).getTime();
          const game = new Date(gameDate + "T18:00:00Z").getTime();
          if (!isFinite(last) || !isFinite(game)) return null;
          return Math.max(0, Math.round((game - last) / 86400000));
        };
        const _restBump = (calendarDays) => {
          if (calendarDays == null) return 1.0;
          if (calendarDays <= 4) return 1.08;  // ≤ 3 days rest (true short)
          if (calendarDays === 5) return 1.04; // 4 days rest (short by 1 day)
          return 1.0;                          // 6+ calendar (5+ days rest, normal/extra)
        };
        const _homeDaysRest = _daysRest(sportByteam.mlb?.pitcherLastStartDate?.[homeTeam], gameDate);
        const _awayDaysRest = _daysRest(sportByteam.mlb?.pitcherLastStartDate?.[awayTeam], gameDate);
        const _homeRestBump = _restBump(_homeDaysRest);
        const _awayRestBump = _restBump(_awayDaysRest);
        // 60/40 starter/bullpen blend — away staff vs home offense, home staff vs away offense.
        // 40% term is bullpen-only (preferred) or whole-staff teamERA (fallback). Whole-staff
        // double-counts the starter; bullpen-only is the clean rest-of-game proxy.
        const _awayStarter = _starterMult(
          awayFipEff != null ? awayFipEff * _awayTto * _awayRestBump : (awayFIP != null ? awayFIP * _awayTto * _awayRestBump : null),
          awayERA != null ? awayERA * _awayTto * _awayRestBump : null,
          awayWhipEff != null ? awayWhipEff : awayWHIP
        );
        const _homeStarter = _starterMult(
          homeFipEff != null ? homeFipEff * _homeTto * _homeRestBump : (homeFIP != null ? homeFIP * _homeTto * _homeRestBump : null),
          homeERA != null ? homeERA * _homeTto * _homeRestBump : null,
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
        // F5 (First 5 Innings) lambdas — starter-only, scaled to 5/9 of a 9-inning game.
        // Skips two full-game terms: (1) TTO bump (3rd-time-through penalty kicks in past
        // BF=22 = inning 6+, so F5 ≈ 1st time + part of 2nd time), and (2) bullpen 40% share
        // (F5 assumes the starter still in). Days-rest, vs-L/R splits, park, platoon, weather,
        // umpire, and lineup-out multipliers all still apply. No regime blend in v1 — schedule
        // cache stores full-game runs, not per-inning splits.
        const _F5_FRAC = 5 / 9;
        const _awayStarter_F5 = _starterMult(
          awayFipEff != null ? awayFipEff * _awayRestBump : (awayFIP != null ? awayFIP * _awayRestBump : null),
          awayERA != null ? awayERA * _awayRestBump : null,
          awayWhipEff != null ? awayWhipEff : awayWHIP
        );
        const _homeStarter_F5 = _starterMult(
          homeFipEff != null ? homeFipEff * _homeRestBump : (homeFIP != null ? homeFIP * _homeRestBump : null),
          homeERA != null ? homeERA * _homeRestBump : null,
          homeWhipEff != null ? homeWhipEff : homeWHIP
        );
        const _hLam_F5 = (homeRPG != null && _awayStarter_F5 != null)
          ? parseFloat((Math.max(0.3, Math.min(8, homeRPG * _F5_FRAC * _awayStarter_F5 * parkRF * _homePlatFactor * _weatherFactor * _umpRunFactor * homeLineupFactor))).toFixed(2))
          : null;
        const _aLam_F5 = (awayRPG != null && _homeStarter_F5 != null)
          ? parseFloat((Math.max(0.3, Math.min(8, awayRPG * _F5_FRAC * _homeStarter_F5 * parkRF * _awayPlatFactor * _weatherFactor * _umpRunFactor * awayLineupFactor))).toFixed(2))
          : null;
        // H2H combined hit rate: how often (homeScore+awayScore) >= threshold in last 10 H2H meetings
        const _gtH2H = _gtH2HRate(homeTeam, awayTeam, threshold);
        const h2hTotalHitRate = _gtH2H?.rate ?? null;
        const h2hTotalGames = _gtH2H?.games ?? null;
        const _h2hTotalPts = h2hTotalHitRate == null ? 1 : h2hTotalHitRate >= 80 ? 2 : h2hTotalHitRate >= 60 ? 1 : 0;
        const _combinedRPG = homeRPG != null && awayRPG != null ? parseFloat((homeRPG + awayRPG).toFixed(2)) : null;
        const _combinedRPGPts = _combinedRPG == null ? 1 : _combinedRPG >= 10.5 ? 2 : _combinedRPG >= 8.5 ? 1 : 0;
        const _homeWhipPts = homeWHIP == null ? 1 : homeWHIP > 1.35 ? 2 : homeWHIP > 1.20 ? 1 : 0;
        const _awayWhipPts = awayWHIP == null ? 1 : awayWHIP > 1.35 ? 2 : awayWHIP > 1.20 ? 1 : 0;
        _simData = { homeRPG, awayRPG, homeERA, awayERA, homeFIP, awayFIP, homeWHIP, awayWHIP, ...(homeWHIPSource && { homeWHIPSource }), ...(awayWHIPSource && { awayWHIPSource }), homeBullpenERA: _homeRestERA, awayBullpenERA: _awayRestERA, ...(homeBullpenSource && { homeBullpenSource }), ...(awayBullpenSource && { awayBullpenSource }), parkFactor: parkRF, homeExpected: _hLam, awayExpected: _aLam, expectedTotal: (_hLam != null && _aLam != null) ? parseFloat((_hLam + _aLam).toFixed(1)) : null, gameOuLine, mlbOuPts: _mlbOuPts, homeWhipPts: _homeWhipPts, awayWhipPts: _awayWhipPts, combinedRpgPts: _combinedRPGPts, h2hTotalPts: _h2hTotalPts, combinedRPG: _combinedRPG, umpireRunFactor: _umpNameT != null ? _umpRunFactor : null, umpireName: _umpNameT, h2hTotalHitRate, h2hTotalGames, homeStarterHand: _homeStarterHand, awayStarterHand: _awayStarterHand, ...(_homePlatFactor !== 1.0 && { homePlatoonFactor: _homePlatFactor }), ...(_awayPlatFactor !== 1.0 && { awayPlatoonFactor: _awayPlatFactor }), ...(_weatherFactor !== 1.0 && { weatherFactor: _weatherFactor, windOutMph: _wData?.windOutMph }), ...(homeTopOut > 0 && { homeTopOut, homeLineupFactor }), ...(awayTopOut > 0 && { awayTopOut, awayLineupFactor }), ...(homePitcherOnIL && { homePitcherOnIL: true }), ...(awayPitcherOnIL && { awayPitcherOnIL: true }), ...(_homeTto !== 1.0 && { homeExpectedBF: _homeBF, homeTtoBump: parseFloat(_homeTto.toFixed(3)) }), ...(_awayTto !== 1.0 && { awayExpectedBF: _awayBF, awayTtoBump: parseFloat(_awayTto.toFixed(3)) }), ...(_homeRestBump !== 1.0 && { homeDaysRest: _homeDaysRest, homeRestBump: parseFloat(_homeRestBump.toFixed(3)) }), ...(_awayRestBump !== 1.0 && { awayDaysRest: _awayDaysRest, awayRestBump: parseFloat(_awayRestBump.toFixed(3)) }), ...(_mlbRegimeBlendW > 0 && { regimeBlendW: parseFloat(_mlbRegimeBlendW.toFixed(2)), homeRecentMean: parseFloat(_mlbHomeRecent.mean.toFixed(2)), awayRecentMean: parseFloat(_mlbAwayRecent.mean.toFixed(2)) }), ...(_homeMix.lFrac != null && { homeOppLFrac: _homeMix.lFrac, homeFipMod: _homeMix.fipMod, homeWhipMod: _homeMix.whipMod, homeFipEff, homeWhipEff }), ...(_awayMix.lFrac != null && { awayOppLFrac: _awayMix.lFrac, awayFipMod: _awayMix.fipMod, awayWhipMod: _awayMix.whipMod, awayFipEff, awayWhipEff }) };
        // Plan C (2026-06-01 calibration): anchor the total's lambda toward the market O/U
        // line — the sharpest available prior on the game mean. totalRuns overs ran +17
        // overconfident (Δ −26.5 side-aware) because the regime blend + seasonHitRate blend
        // stack λ upward, especially when the threshold sits well below the mean. The anchor
        // pulls 25% toward the line; it self-targets the overconfident games (biggest pull
        // where the model diverges most from market) and barely moves games already near the
        // line. Local to the total truePct only — _mlbMlContext keeps the RAW model lambda so
        // the (healthy, +11% ROI) ML/spread surfaces are untouched. Gated to plausible lines.
        const _anchorTotalLam = (lam) =>
          (gameOuLine != null && Number.isFinite(gameOuLine) && gameOuLine >= 5 && gameOuLine <= 14)
            ? parseFloat((0.75 * lam + 0.25 * gameOuLine).toFixed(2))
            : lam;
        if (_hLam != null && _aLam != null) {
          const _sumLam = _hLam + _aLam;
          const _lamScale = _sumLam > 0 ? _anchorTotalLam(_sumLam) / _sumLam : 1;
          const _dk = `mlb|${homeTeam}|${awayTeam}`;
          if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateMLBTotalDist(_hLam * _lamScale, _aLam * _lamScale, _mlbDispR, 10000);
          truePct = totalDistPct(totalDistCache[_dk], threshold);
          const _mlCtxKey = `${homeTeam}|${awayTeam}|${gameDate}`;
          if (!_mlbMlContext[_mlCtxKey]) {
            _mlbMlContext[_mlCtxKey] = { homeTeam, awayTeam, gameDate, homeLambda: _hLam, awayLambda: _aLam, f5HomeLambda: _hLam_F5, f5AwayLambda: _aLam_F5, dispR: _mlbDispR, kalshiVolume, kalshiSpread, lowVolume, _simData: { ..._simData } };
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
            // Plan A (2026-06-01 calibration): tighten the seasonHitRate blend clamp for MLB
            // totals from 1.5 → 0.75. Decoupled from _GT_IMPLIED_CAP.mlb (still 1.5), which also
            // drives the seasonRateDivergent dc penalty in dc.js — keeping that at 1.5 means the
            // same plays qualify/drop; only the blend math softens. Limits the upward pull of a
            // high season-implied λ at low thresholds. Final λ then anchored toward the market line.
            const _cap = 0.75;
            const _impliedClamped = Math.max(_modelLambda - _cap, Math.min(_modelLambda + _cap, _impliedLambda));
            const _blendedLambda = _anchorTotalLam((1 - _w) * _modelLambda + _w * _impliedClamped);
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
        const _hInjDamp = _injuryBlendDamp(_homeInjAdj.share);
        const _aInjDamp = _injuryBlendDamp(_awayInjAdj.share);
        if (_homeRecent && _awayRecent && _homeExpRaw != null && _awayExpRaw != null) {
          const _sample = Math.min(_homeRecent.effectiveSample, _awayRecent.effectiveSample);
          _regimeBlendW = _regimeBlendWeight(_sample);
          const _hRegimeW = _regimeBlendW * _hInjDamp;
          const _aRegimeW = _regimeBlendW * _aInjDamp;
          _homeExpRaw = (1 - _hRegimeW) * _homeExpRaw + _hRegimeW * _homeRecent.mean;
          _awayExpRaw = (1 - _aRegimeW) * _awayExpRaw + _aRegimeW * _awayRecent.mean;
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
        _simData = { homeOffRtg: _hOffRtg, awayOffRtg: _aOffRtg, homeOffRtgAdj: _hOffRtgAdj, awayOffRtgAdj: _aOffRtgAdj, homeDefRtg: _hDefRtg, awayDefRtg: _aDefRtg, combOffRtg: _combOffRtg, combDefRtg: _combDefRtg, homePace: _hp, awayPace: _ap, leagueAvgPace: _lgPace, projPace: _projPace, gameOuLine: _nbaOuLine, gameSpread: _nbaGtSpread, homeOut: _homeOut, awayOut: _awayOut, homeUsageOut: _homeInjAdj.share, awayUsageOut: _awayInjAdj.share, ...(_homeInjAdj.adj < 1 && { homeOffRtgFactor: _homeInjAdj.adj }), ...(_awayInjAdj.adj < 1 && { awayOffRtgFactor: _awayInjAdj.adj }), ...(_homeB2B && { homeB2B: true, homeB2BFactor: _homeB2BFactor }), ...(_awayB2B && { awayB2B: true, awayB2BFactor: _awayB2BFactor }), nbaGtH2HRate, nbaGtH2HGames, combOffRtgPts: _combOffRtgPts, combDefRtgPts: _combDefRtgPts, pacePts: _pacePts, nbaGtH2HPts: _nbaGtH2HPts, nbaOuPts: _nbaOuPts, homeExpected: _homeExpRaw != null ? parseFloat(_homeExpRaw.toFixed(1)) : null, awayExpected: _awayExpRaw != null ? parseFloat(_awayExpRaw.toFixed(1)) : null, expectedTotal: (_homeExpRaw != null && _awayExpRaw != null) ? parseFloat((_homeExpRaw + _awayExpRaw).toFixed(1)) : null, ...(_isPlayoff && { isPlayoff: true }), ...(_regimeBlendW > 0 && { regimeBlendW: parseFloat(_regimeBlendW.toFixed(2)), homeRecentMean: parseFloat(_homeRecent.mean.toFixed(1)), awayRecentMean: parseFloat(_awayRecent.mean.toFixed(1)) }), ...(_hInjDamp < 1 && { homeInjDamp: parseFloat(_hInjDamp.toFixed(2)) }), ...(_aInjDamp < 1 && { awayInjDamp: parseFloat(_aInjDamp.toFixed(2)) }) };
        if (_homeExpRaw != null && _awayExpRaw != null) {
          const _dk = `nba|${homeTeam}|${awayTeam}`;
          // Per-team std=13 (was 11) — produces game-total std ≈ 18.4, closer to empirical
          // NBA game-total std (~15-18) than the prior ~15.6. Fattens both tails so far-from-line
          // thresholds get more honest probability mass.
          if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNBATotalDist(_homeExpRaw, _awayExpRaw, 13, 13, 10000);
          truePct = totalDistPct(totalDistCache[_dk], threshold);
          const _mlCtxKey = `${homeTeam}|${awayTeam}|${gameDate}`;
          if (!_nbaMlContext[_mlCtxKey]) {
            // Half lambdas (v1) — 50/50 split of full-game λ. NBA reality is ~49.5/50.5
            // due to Q4 pace + ~6% OT contribution to 2H. Refine via calibration.
            const _h1Home = parseFloat((_homeExpRaw * 0.5).toFixed(2));
            const _h1Away = parseFloat((_awayExpRaw * 0.5).toFixed(2));
            _nbaMlContext[_mlCtxKey] = { homeTeam, awayTeam, gameDate, homeLambda: parseFloat(_homeExpRaw.toFixed(2)), awayLambda: parseFloat(_awayExpRaw.toFixed(2)), h1HomeLambda: _h1Home, h1AwayLambda: _h1Away, h2HomeLambda: _h1Home, h2AwayLambda: _h1Away, kalshiVolume, kalshiSpread, lowVolume, _simData: { ..._simData } };
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
        const _whInjDamp = _injuryBlendDamp(_wHomeInjAdj.share);
        const _waInjDamp = _injuryBlendDamp(_wAwayInjAdj.share);
        if (_whRecent && _waRecent && _wHomeExpRaw != null && _wAwayExpRaw != null) {
          const _wSample = Math.min(_whRecent.effectiveSample, _waRecent.effectiveSample);
          _wRegimeBlendW = _regimeBlendWeight(_wSample);
          const _whRegimeW = _wRegimeBlendW * _whInjDamp;
          const _waRegimeW = _wRegimeBlendW * _waInjDamp;
          _wHomeExpRaw = (1 - _whRegimeW) * _wHomeExpRaw + _whRegimeW * _whRecent.mean;
          _wAwayExpRaw = (1 - _waRegimeW) * _wAwayExpRaw + _waRegimeW * _waRecent.mean;
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
          expectedTotal: (_wHomeExpRaw != null && _wAwayExpRaw != null) ? parseFloat((_wHomeExpRaw + _wAwayExpRaw).toFixed(1)) : null,
          ...(_wRegimeBlendW > 0 && { regimeBlendW: parseFloat(_wRegimeBlendW.toFixed(2)), homeRecentMean: parseFloat(_whRecent.mean.toFixed(1)), awayRecentMean: parseFloat(_waRecent.mean.toFixed(1)) }),
          ...(_whInjDamp < 1 && { homeInjDamp: parseFloat(_whInjDamp.toFixed(2)) }),
          ...(_waInjDamp < 1 && { awayInjDamp: parseFloat(_waInjDamp.toFixed(2)) })
        };
        if (_wHomeExpRaw != null && _wAwayExpRaw != null) {
          const _dk = `wnba|${homeTeam}|${awayTeam}`;
          // Per-team std=11 (WNBA scoring variance is roughly NBA × (40/48) × scale factor;
          // empirically the game-total std runs ~13–15, so per-team std=11 produces ~15.6).
          if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNBATotalDist(_wHomeExpRaw, _wAwayExpRaw, 11, 11, 10000);
          truePct = totalDistPct(totalDistCache[_dk], threshold);
          const _mlCtxKey = `${homeTeam}|${awayTeam}|${gameDate}`;
          if (!_wnbaMlContext[_mlCtxKey]) {
            // Half lambdas (v1) — 50/50 split of full-game λ. WNBA = 4 quarters of 10 min.
            const _h1Home = parseFloat((_wHomeExpRaw * 0.5).toFixed(2));
            const _h1Away = parseFloat((_wAwayExpRaw * 0.5).toFixed(2));
            _wnbaMlContext[_mlCtxKey] = { homeTeam, awayTeam, gameDate, homeLambda: parseFloat(_wHomeExpRaw.toFixed(2)), awayLambda: parseFloat(_wAwayExpRaw.toFixed(2)), h1HomeLambda: _h1Home, h1AwayLambda: _h1Away, h2HomeLambda: _h1Home, h2AwayLambda: _h1Away, kalshiVolume, kalshiSpread, lowVolume, _simData: { ..._simData } };
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
          if (!totalDistCache[_dk]) totalDistCache[_dk] = simulateNHLTotalDist(_hGLRaw, _aGLRaw, _nhlDispR, 10000);
          truePct = totalDistPct(totalDistCache[_dk], threshold);
          const _mlCtxKey = `${homeTeam}|${awayTeam}|${gameDate}`;
          if (!_nhlMlContext[_mlCtxKey]) {
            _nhlMlContext[_mlCtxKey] = { homeTeam, awayTeam, gameDate, homeLambda: parseFloat(_hGLRaw.toFixed(2)), awayLambda: parseFloat(_aGLRaw.toFixed(2)), dispR: _nhlDispR, kalshiVolume, kalshiSpread, lowVolume, _simData: { ..._simData } };
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
          const _impliedLambda = muForNegBinTail(threshold, _gtNhlSsn.rate / 100, _nhlDispR);
          if (_impliedLambda != null) {
            const _cap = _GT_IMPLIED_CAP.nhl;
            const _impliedClamped = Math.max(_modelLambda - _cap, Math.min(_modelLambda + _cap, _impliedLambda));
            const _blendedLambda = (1 - _w) * _modelLambda + _w * _impliedClamped;
            _simData.modelTruePct = parseFloat(truePct.toFixed(1));
            _simData.gtSeasonHitRate = _gtNhlSsn.rate;
            _simData.gtSsnSample = _gtNhlSsn.sample;
            _simData.modelLambda = parseFloat(_modelLambda.toFixed(2));
            _simData.impliedLambda = _impliedLambda;
            _simData.nhlDispR = _nhlDispR;
            if (_impliedClamped !== _impliedLambda) _simData.impliedLambdaClamped = parseFloat(_impliedClamped.toFixed(2));
            _simData.blendedLambda = parseFloat(_blendedLambda.toFixed(2));
            truePct = parseFloat(((1 - negBinCDF(threshold - 1, _blendedLambda, _nhlDispR)) * 100).toFixed(1));
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
        totalPlays.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), rawEdge, edge: overEdge, totalSimScore, qualified: true, kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed, kalshiTicker: tm._ticker ?? null, kalshiSide: "yes", ..._simData });
      } else if (isDebug) {
        dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), rawEdge, edge: overEdge, totalSimScore, lineupsConfirmed: _lineupsConfirmed, reason: !_overInWindow ? "kalshi_out_of_window" : "edge_too_low", ..._simData });
      }
      // UNDER play — mirror the OVER filter: require noKalshiPct >= 70 (YES <= 30)
      // so we only bet UNDERs the market also considers likely (same gate as OVERs).
      // Debug-dropped path matches team-totals: push every non-qualifying UNDER so the
      // market report shows a row for every market, not just those with edge ≥ 3%.
      if (underEdge >= EDGE_GATE && noKalshiPct >= KALSHI_GATE && noKalshiPct <= KALSHI_CAP) {
        totalPlays.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "under", kalshiPct, noKalshiPct, americanOdds: noKalshiAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, rawEdge, edge: underEdge, totalSimScore: underSimScore, qualified: true, kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed, kalshiTicker: tm._ticker ?? null, kalshiSide: "no", ..._simData, ..._underComponents });
      } else if (isDebug) {
        dropped.push({ gameType: "total", sport, stat, homeTeam, awayTeam, threshold, direction: "under", kalshiPct, noKalshiPct, americanOdds: noKalshiAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, rawEdge, edge: underEdge, totalSimScore: underSimScore, lineupsConfirmed: _lineupsConfirmed, reason: noKalshiPct < KALSHI_GATE ? "under_no_price_too_low" : "edge_too_low", ..._simData, ..._underComponents });
      }
    }
  }
  {
    // Step 1: per-game dedup for game totals — pure edge dominance (SimScore tiebreak dropped with v1).
    const _totalBestMap = {};
    for (const tp of totalPlays) {
      const key = `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}`;
      const prev = _totalBestMap[key];
      if (!prev || tp.edge > prev.edge) _totalBestMap[key] = tp;
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
        let _lam = teamRPG != null ? parseFloat((Math.max(0.5, Math.min(12, teamRPG * _oppMult * parkRF * _ttPlatFactor * _ttWeatherFactor * _ttUmpRunFactor * lineupFactor))).toFixed(2)) : null;
        // Regime-aware blend: shift λ toward recency-weighted recent runs.
        // Conservative cap (0.5 share / denom 12) — half of game-total cap because
        // single-team variance is larger than two-team-combined variance.
        const _ttMlbRecent = _lam != null ? _recentTeamScoreMean(_ttScheduleMap, "mlb", scoringTeam, _MLB_HALF_LIFE_DAYS) : null;
        let _ttMlbRegimeBlendW = 0;
        if (_ttMlbRecent && _ttMlbRecent.effectiveSample >= 3) {
          _ttMlbRegimeBlendW = Math.min(0.50, _ttMlbRecent.effectiveSample / 12 * 0.50);
          _lam = parseFloat(((1 - _ttMlbRegimeBlendW) * _lam + _ttMlbRegimeBlendW * _ttMlbRecent.mean).toFixed(2));
        }
        if (_lam != null) {
          const _dk = `mlb|team|${scoringTeam}|${oppTeam}|${_lam}`;
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
        const _ttBaseFields = { gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), ...(_ttModelTruePct != null && _ttModelTruePct !== truePct && { modelTruePct: parseFloat(_ttModelTruePct.toFixed(1)) }), ...(_ttImpliedLambda != null && { ttImpliedLambda: _ttImpliedLambda, ttBlendedLambda: _ttBlendedLambda }), ...(_ttImpliedLambdaClamped != null && { ttImpliedLambdaClamped: _ttImpliedLambdaClamped }), kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _ttGameTime, lineupsConfirmed: _ttLineupsConfirmed, teamRPG, oppERA, oppFIP, oppWHIP, ...(oppWHIPSource && { oppWHIPSource }), oppBullpenERA: _oppRestERA, ...(oppBullpenSource && { oppBullpenSource }), oppRPG, parkFactor: parkRF, gameOuLine, teamExpected: _lam != null ? parseFloat(_lam.toFixed(1)) : null, h2hHitRate, h2hGames, h2hHitRatePts, teamL10RPG, ttL10Pts, ttWhipPts, ttOuPts, umpireRunFactor: _ttUmpRunFactor, ...(_ttUmpName && { umpireName: _ttUmpName }), ttSeasonHitRate, ttSeasonHitRatePts, oppStarterHand: _ttOppStarterHand, ...(_ttPlatFactor !== 1.0 && { platoonFactor: _ttPlatFactor }), ...(scoringTopOut > 0 && { scoringTopOut, scoringLineupFactor: lineupFactor }), ...(oppPitcherOnIL && { oppPitcherOnIL: true }), ...(_ttMlbRegimeBlendW > 0 && { regimeBlendW: parseFloat(_ttMlbRegimeBlendW.toFixed(2)), scoringRecentMean: parseFloat(_ttMlbRecent.mean.toFixed(2)) }) };
        const rawEdge = parseFloat((truePct - kalshiPct).toFixed(1));
        const edge = rawEdge;
        const _ttOverInWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
        if (edge >= EDGE_GATE && _ttOverInWindow) {
          teamTotalPlays.push({ ..._ttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, qualified: true, kalshiTicker: tm._ticker ?? null, kalshiSide: "yes" });
        } else if (isDebug) {
          dropped.push({ ..._ttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, reason: !_ttOverInWindow ? "kalshi_out_of_window" : "edge_too_low" });
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
          teamTotalPlays.push({ ..._ttBaseFields, ..._ttUnderComponents, direction: "under", noTruePct: _ttNoTruePct, noKalshiPct: _ttNoKalshiPct, americanOdds: _ttNoKalshiAO, edge: _ttUnderEdge, rawEdge: _ttUnderEdge, teamTotalSimScore: _ttUnderSimScore, qualified: true, kalshiTicker: tm._ticker ?? null, kalshiSide: "no" });
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
        const _ttInjDamp = _injuryBlendDamp(_ttScoringInjAdj.share);
        if (_ttRecent && _teamExpected != null) {
          _ttRegimeBlendW = _regimeBlendWeight(_ttRecent.effectiveSample);
          const _ttEffectiveRegimeW = _ttRegimeBlendW * _ttInjDamp;
          _teamExpected = (1 - _ttEffectiveRegimeW) * _teamExpected + _ttEffectiveRegimeW * _ttRecent.mean;
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
          const _w = Math.min(1, _ttNbaSched.length / 40) * 0.7 * _ttInjDamp;
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
        const _nttBaseFields = { gameType: "teamTotal", sport, stat, scoringTeam, oppTeam, homeTeam, awayTeam, threshold, kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), ...(_ttNbaModelTruePct != null && _ttNbaModelTruePct !== truePct && { modelTruePct: _ttNbaModelTruePct }), ...(_ttNbaImpliedMean != null && { ttNbaImpliedMean: _ttNbaImpliedMean, ttNbaBlendedMean: _ttNbaBlendedMean }), ...(_ttNbaImpliedMeanClamped != null && { ttNbaImpliedMeanClamped: _ttNbaImpliedMeanClamped }), kalshiVolume, kalshiSpread, lowVolume, gameDate, gameTime: _nttGameTime, teamOffRtg, teamOffRtgAdj: _teamOffRtgAdj, oppDefRtg, teamExpected: _teamExpected != null ? parseFloat(_teamExpected.toFixed(1)) : null, gameOuLine: _nbaOuLine, gameSpread: _gameSpread, projPace: _ttNbaProjPace, leagueAvgPace: _lgPaceNba, scoringOut: _ttScoringOut, oppOut: _ttOppOut, scoringUsageOut: _ttScoringInjAdj.share, ...(_ttScoringInjAdj.adj < 1 && { scoringOffRtgFactor: _ttScoringInjAdj.adj }), ...(_ttScoringB2B && { scoringB2B: true, scoringB2BFactor: _ttScoringB2BFactor }), h2hHitRate, h2hGames, h2hHitRatePts, ttNbaSeasonHitRate, ttNbaSeasonHitRatePts, ttOffRtgPts, ttDefRtgPts, ttNbaOuPts, ...(_ttIsPlayoff && { isPlayoff: true }), ...(_ttRegimeBlendW > 0 && { regimeBlendW: parseFloat(_ttRegimeBlendW.toFixed(2)), scoringRecentMean: parseFloat(_ttRecent.mean.toFixed(1)) }), ...(_ttInjDamp < 1 && { scoringInjDamp: parseFloat(_ttInjDamp.toFixed(2)) }) };
        const rawEdge = parseFloat((truePct - kalshiPct).toFixed(1));
        const edge = rawEdge;
        const _nttOverInWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
        if (edge >= EDGE_GATE && _nttOverInWindow) {
          teamTotalPlays.push({ ..._nttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, qualified: true, kalshiTicker: tm._ticker ?? null, kalshiSide: "yes" });
        } else if (isDebug) {
          dropped.push({ ..._nttBaseFields, direction: "over", edge, rawEdge, teamTotalSimScore, reason: !_nttOverInWindow ? "kalshi_out_of_window" : "edge_too_low" });
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
          teamTotalPlays.push({ ..._nttBaseFields, ..._nttUnderComponents, direction: "under", noTruePct: _nttNoTruePct, noKalshiPct: _nttNoKalshiPct, americanOdds: _nttNoKalshiAO, edge: _nttUnderEdge, rawEdge: _nttUnderEdge, teamTotalSimScore: _nttUnderSimScore, qualified: true, kalshiTicker: tm._ticker ?? null, kalshiSide: "no" });
        } else if (isDebug) {
          dropped.push({ ..._nttBaseFields, ..._nttUnderComponents, direction: "under", noTruePct: _nttNoTruePct, noKalshiPct: _nttNoKalshiPct, americanOdds: _nttNoKalshiAO, edge: _nttUnderEdge, teamTotalSimScore: _nttUnderSimScore, reason: _nttNoKalshiPct < KALSHI_GATE ? "under_no_price_too_low" : "edge_too_low" });
        }
      }
    }
    // Dedup: one play per scoringTeam+oppTeam+direction — pure edge dominance (SimScore tiebreak dropped with v1).
    const _ttBestMap = {};
    for (const tp of teamTotalPlays) {
      const key = `${tp.sport}|${tp.scoringTeam}|${tp.oppTeam}|${tp.direction}`;
      const prev = _ttBestMap[key];
      if (!prev || tp.edge > prev.edge) _ttBestMap[key] = tp;
    }
    const _ttBestIds = new Set(Object.values(_ttBestMap).map(tp => `${tp.sport}|${tp.scoringTeam}|${tp.oppTeam}|${tp.threshold}|${tp.direction}`));
    // Cross-type dedup: one play per game across game totals AND team totals — pure edge dominance.
    const _crossBestMap = {};
    for (const tp of [...Object.values(_ttBestMap)]) {
      const key = `${tp.sport}|${tp.homeTeam}|${tp.awayTeam}`;
      const prev = _crossBestMap[key];
      if (!prev || tp.edge > prev.edge) _crossBestMap[key] = tp;
    }
    // Compare team total winners against any non-demoted game total for the same game; game total wins on edge tie.
    for (const [key, gameTp] of Object.entries(_crossBestMap)) {
      const existingGameTotal = plays.find(p => p.gameType === "total" && p.sport === gameTp.sport && p.homeTeam === gameTp.homeTeam && p.awayTeam === gameTp.awayTeam && p.qualified !== false);
      if (existingGameTotal && existingGameTotal.edge >= gameTp.edge) _crossBestMap[key] = existingGameTotal;
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
  return { _mlbMlContext, _nbaMlContext, _wnbaMlContext, _nhlMlContext };
}
