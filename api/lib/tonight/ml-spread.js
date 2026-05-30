// api/lib/tonight/ml-spread.js
// ML / spread / F5 / halves play emission — all sports.
// Extracted from api/lib/handlers/tonight.js Phase B (2026-05-29). Zero behavior change.
// Called once near the end of handleTonightRoute after game-total + team-total loops.

import { simulateMLBJoint, simulateNBAJoint, mlPctFromJoint, joint3WayPct, spreadPctFromJoint, totalDistPct } from "../simulate.js";
import { KALSHI_GATE, KALSHI_CAP, EDGE_GATE_SERVER as EDGE_GATE } from "../config.js";
import { PT_FMT } from "../pt.js";
import { normTeam } from "./parse-teams.js";

// Context: plays/dropped (mutated), isDebug, cutoffStr, gameTimes, _todayPT,
//          CACHE2/isBustCache, _*MlContext maps, spreadMarkets, totalMarkets,
//          mlbBothTeamsConfirmed/reattrMlbGameDate (closures from handleTonightRoute).
export async function emitAllMlAndSpread({
  plays, dropped, isDebug, cutoffStr, gameTimes, _todayPT,
  CACHE2, isBustCache,
  _mlbMlContext, _nbaMlContext, _wnbaMlContext, _nhlMlContext,
  spreadMarkets, totalMarkets,
  mlbBothTeamsConfirmed: _mlbBothTeamsConfirmed,
  reattrMlbGameDate: _reattrMlbGameDate,
}) {
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
      const mlMarket = _mlbMlMarkets[`${homeTeam}|${awayTeam}|${gameDate}`]
                    ?? (gameDate == null ? (_mlbMlMarkets[`${homeTeam}|${awayTeam}|${_todayPT}`] ?? _mlbMlMarkets[`${awayTeam}|${homeTeam}|${_todayPT}`]) : null);
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
      const _lineupsConfirmed = _mlbBothTeamsConfirmed(homeTeam, awayTeam, gameDate ?? _todayPT);
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
      // F5 spread emits through the dedicated F5 block below.
      if (m.segment && m.segment !== "full") continue;
      if (m.gameDate && m.gameDate < cutoffStr) continue;
      const { gameTeam1, gameTeam2, gameDate, marginTeam, line, kalshiPct: yesKalshi, americanOdds: yesAO, noKalshiPct: noKalshi, noKalshiAO: noAO, kalshiVolume, kalshiSpread } = m;
      const ctx = _mlbMlContext[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? _mlbMlContext[`${gameTeam2}|${gameTeam1}|${gameDate}`]
               ?? _mlbMlContext[`${gameTeam1}|${gameTeam2}|null`] ?? _mlbMlContext[`${gameTeam2}|${gameTeam1}|null`];
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
      const _lineupsConfirmed = _mlbBothTeamsConfirmed(homeTeam, awayTeam, ctx.gameDate ?? _todayPT);
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
  // ── MLB First-5-Innings emission (KXMLBF5TOTAL + KXMLBF5SPREAD) ─────────────────────
  // Reuses the per-game F5 lambdas already stashed on _mlbMlContext (computed in the MLB
  // total loop). NegBin joint sim shares dispR with full-game (acceptable v1 bias — F5 is
  // slightly less overdispersed than full-game since bullpen variance is absent, so reusing
  // full-r under-disperses F5 tails marginally). One joint cache per game; total queries
  // derive the combined-runs Int16Array from home[i]+away[i] for monotonicity.
  const _mlbF5JointCache = {};
  const _mlbF5TotalDistCache = {};
  {
    // F5 totals (KXMLBF5TOTAL)
    for (const tm of totalMarkets) {
      if (tm.segment !== "f5" || tm.sport !== "mlb") continue;
      if (tm.gameDate && tm.gameDate < cutoffStr) continue;
      const { threshold, kalshiPct, americanOdds, noKalshiPct: _tmNoPct, noKalshiAO: _tmNoAO, gameTeam1, gameTeam2, gameDate, kalshiSpread, kalshiVolume } = tm;
      const ctx = _mlbMlContext[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? _mlbMlContext[`${gameTeam2}|${gameTeam1}|${gameDate}`]
               ?? _mlbMlContext[`${gameTeam1}|${gameTeam2}|null`] ?? _mlbMlContext[`${gameTeam2}|${gameTeam1}|null`];
      if (!ctx) continue;
      const { homeTeam, awayTeam, f5HomeLambda, f5AwayLambda, dispR, _simData } = ctx;
      if (f5HomeLambda == null || f5AwayLambda == null) continue;
      const _f5k = `${homeTeam}|${awayTeam}`;
      if (!_mlbF5JointCache[_f5k]) _mlbF5JointCache[_f5k] = simulateMLBJoint(f5HomeLambda, f5AwayLambda, dispR, 10000);
      const joint = _mlbF5JointCache[_f5k];
      if (!joint) continue;
      if (!_mlbF5TotalDistCache[_f5k]) {
        const _dist = new Int16Array(joint.home.length);
        for (let i = 0; i < joint.home.length; i++) _dist[i] = joint.home[i] + joint.away[i];
        _mlbF5TotalDistCache[_f5k] = _dist;
      }
      const truePct = totalDistPct(_mlbF5TotalDistCache[_f5k], threshold);
      if (truePct == null) continue;
      const noTruePct = parseFloat((100 - truePct).toFixed(1));
      const _gameTime = gameTimes[`mlb:${homeTeam}:${gameDate}`] ?? gameTimes[`mlb:${awayTeam}:${gameDate}`] ?? gameTimes[`mlb:${homeTeam}`] ?? gameTimes[`mlb:${awayTeam}`] ?? null;
      const _lineupsConfirmed = _mlbBothTeamsConfirmed(homeTeam, awayTeam, ctx.gameDate ?? _todayPT);
      // F5 OU line: derive from full-game OU × 5/9 so the dc threshold-distance penalty
      // bucket has an anchor (mlb buckets are [3, 5] for full-game; ~5/9 scaling makes them
      // [1.7, 2.8] effective for F5 — slightly tighter than ideal but workable v1).
      const _fullGameOu = _simData?.gameOuLine ?? null;
      const _f5GameOuLine = _fullGameOu != null ? parseFloat((_fullGameOu * 5 / 9).toFixed(1)) : null;
      // F5 expected total = sum of F5 lambdas (mirrors full-game expectedTotal field)
      const _f5ExpectedTotal = parseFloat((f5HomeLambda + f5AwayLambda).toFixed(2));
      const _f5Common = {
        gameType: "total", sport: "mlb", stat: "f5total", segment: "f5",
        homeTeam, awayTeam, gameDate, threshold,
        totalSimScore: 0, qualified: false,
        kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
        gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed,
        homeLambda: f5HomeLambda, awayLambda: f5AwayLambda,
        ..._simData,
        // F5-specific overrides (must follow _simData spread to win)
        homeExpected: f5HomeLambda, awayExpected: f5AwayLambda,
        expectedTotal: _f5ExpectedTotal,
        gameOuLine: _f5GameOuLine,
        // H2H uses full-game _gtScheduleMap scores — meaningless vs F5 thresholds.
        // Null these out so the play card doesn't show a misleading 80–100% OVER rate.
        h2hTotalHitRate: null, h2hTotalGames: null, h2hTotalPts: 1,
      };
      // OVER
      {
        const edge = parseFloat((truePct - kalshiPct).toFixed(1));
        const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
        if (edge >= EDGE_GATE && inWindow) {
          plays.push({ ..._f5Common, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge });
        } else if (isDebug && inWindow) {
          dropped.push({ ..._f5Common, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge, reason: "edge_too_low" });
        }
      }
      // UNDER (use real no_ask, not 1-yes_ask)
      {
        const edge = parseFloat((noTruePct - _tmNoPct).toFixed(1));
        const inWindow = _tmNoPct >= KALSHI_GATE && _tmNoPct <= KALSHI_CAP;
        if (edge >= EDGE_GATE && inWindow) {
          plays.push({ ..._f5Common, direction: "under", kalshiPct, noKalshiPct: _tmNoPct, americanOdds: _tmNoAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, edge });
        } else if (isDebug && inWindow) {
          dropped.push({ ..._f5Common, direction: "under", kalshiPct, noKalshiPct: _tmNoPct, americanOdds: _tmNoAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, edge, reason: _tmNoPct < KALSHI_GATE ? "under_no_price_too_low" : "edge_too_low" });
        }
      }
    }
    // F5 spreads (KXMLBF5SPREAD)
    for (const m of spreadMarkets) {
      if (m.segment !== "f5" || m.sport !== "mlb") continue;
      if (m.gameDate && m.gameDate < cutoffStr) continue;
      const { gameTeam1, gameTeam2, gameDate, marginTeam, line, kalshiPct: yesKalshi, americanOdds: yesAO, noKalshiPct: noKalshi, noKalshiAO: noAO, kalshiVolume, kalshiSpread } = m;
      const ctx = _mlbMlContext[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? _mlbMlContext[`${gameTeam2}|${gameTeam1}|${gameDate}`]
               ?? _mlbMlContext[`${gameTeam1}|${gameTeam2}|null`] ?? _mlbMlContext[`${gameTeam2}|${gameTeam1}|null`];
      if (!ctx) continue;
      const { homeTeam, awayTeam, f5HomeLambda, f5AwayLambda, dispR, _simData } = ctx;
      if (f5HomeLambda == null || f5AwayLambda == null) continue;
      if (marginTeam !== homeTeam && marginTeam !== awayTeam) continue;
      const _f5k = `${homeTeam}|${awayTeam}`;
      if (!_mlbF5JointCache[_f5k]) _mlbF5JointCache[_f5k] = simulateMLBJoint(f5HomeLambda, f5AwayLambda, dispR, 10000);
      const joint = _mlbF5JointCache[_f5k];
      if (!joint) continue;
      const marginSide = marginTeam === homeTeam ? "home" : "away";
      const yesTruePct = spreadPctFromJoint(joint.home, joint.away, line, marginSide);
      if (yesTruePct == null) continue;
      const noTruePct = parseFloat((100 - yesTruePct).toFixed(1));
      const _gameTime = gameTimes[`mlb:${homeTeam}:${gameDate}`] ?? gameTimes[`mlb:${awayTeam}:${gameDate}`] ?? gameTimes[`mlb:${homeTeam}`] ?? gameTimes[`mlb:${awayTeam}`] ?? null;
      const _lineupsConfirmed = _mlbBothTeamsConfirmed(homeTeam, awayTeam, ctx.gameDate ?? _todayPT);
      // F5 OU + expected: full-game OU × 5/9 anchor, sum of F5 lambdas. Override after the
      // _simData spread so spread picks don't display full-game values.
      const _fullGameOu = _simData?.gameOuLine ?? null;
      const _f5GameOuLine = _fullGameOu != null ? parseFloat((_fullGameOu * 5 / 9).toFixed(1)) : null;
      const _f5ExpectedTotal = parseFloat((f5HomeLambda + f5AwayLambda).toFixed(2));
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
        const _base = {
          gameType: "spread", sport: "mlb", stat: "f5spread", segment: "f5",
          homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
          line, pickLine, marginTeam,
          kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
          totalSimScore: 0, qualified: false,
          kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
          gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed,
          ..._simData,
          // F5-specific overrides (must follow _simData spread to win)
          homeLambda: f5HomeLambda, awayLambda: f5AwayLambda,
          homeExpected: f5HomeLambda, awayExpected: f5AwayLambda,
          expectedTotal: _f5ExpectedTotal,
          gameOuLine: _f5GameOuLine,
          h2hTotalHitRate: null, h2hTotalGames: null, h2hTotalPts: 1,
        };
        if (edge >= EDGE_GATE && inWindow) {
          plays.push(_base);
        } else if (isDebug && inWindow) {
          dropped.push({ ..._base, reason: "edge_too_low" });
        }
      }
    }
    // F5 ML 3-way (KXMLBF5) — home/away/tie. Unlike full-game ML (where ties are dropped
    // since extras resolve them), F5 ties are a real Kalshi outcome (priced 15-17% in
    // typical samples). Same joint draws as F5 total/spread (reuses _mlbF5JointCache).
    // Series fetched inline via snap → 600s cache → REST (same pattern as KXMLBGAME).
    const _mlbF5MlMarkets = {};
    try {
      const _kImpliedProbF5Ml = (m) => {
        const a = parseFloat(m.yes_ask_dollars) || 0;
        const l = parseFloat(m.last_price_dollars) || 0;
        const b = parseFloat(m.yes_bid_dollars) || 0;
        return (a >= 0.98 && b === 0 && l > 0) ? l : (a > 0 ? a : l);
      };
      const _kGameDateF5Ml = (m) => m?.expected_expiration_time ? PT_FMT.format(new Date(m.expected_expiration_time)) : null;
      let _f5MlRaw = [];
      {
        const _snapKey = 'kalshi:snap:KXMLBF5';
        const _legKey = 'kalshi:KXMLBF5';
        let _data = null;
        if (CACHE2 && !isBustCache) {
          const _snap = await CACHE2.get(_snapKey, 'json').catch(() => null);
          if (_snap && Array.isArray(_snap.markets) && _snap.markets.length > 0 &&
              (Date.now() - (_snap.writtenAt || 0) <= 180_000)) {
            _data = { markets: _snap.markets };
          }
        }
        if (!_data && CACHE2 && !isBustCache) {
          _data = await CACHE2.get(_legKey, 'json').catch(() => null);
        }
        if (!_data) {
          const r = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMLBF5&limit=1000&status=open', {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
          }).catch(() => null);
          if (r?.ok) {
            _data = await r.json().catch(() => null);
            if (_data && CACHE2) CACHE2.put(_legKey, JSON.stringify(_data), { expirationTtl: 600 }).catch(() => {});
          }
        }
        _f5MlRaw = _data?.markets || [];
      }
      // Group by event_ticker. Allow TIE as a 3rd key alongside the two team abbrs.
      const _byEventF5 = {};
      for (const m of _f5MlRaw) {
        const tk = m.ticker || '';
        const lastDash = tk.lastIndexOf('-');
        if (lastDash < 0) continue;
        const sfx = tk.slice(lastDash + 1);
        const key = sfx === "TIE" ? "TIE" : normTeam('mlb', sfx);
        const eventT = m.event_ticker;
        if (!eventT || !key) continue;
        const p = _kImpliedProbF5Ml(m);
        if (!p || p <= 0 || p >= 1) continue;
        if (!_byEventF5[eventT]) _byEventF5[eventT] = { probs: {}, gameDate: _kGameDateF5Ml(m) };
        _byEventF5[eventT].probs[key] = p;
      }
      for (const info of Object.values(_byEventF5)) {
        const keys = Object.keys(info.probs);
        if (keys.length !== 3 || !info.gameDate) continue;
        if (!keys.includes("TIE")) continue;
        const teams = keys.filter(k => k !== "TIE");
        const [t1, t2] = teams;
        // Postponed-ticker reattribution — same `_reattrMlbGameDate` used by full-game ML.
        const _resolved = Math.min(...keys.map(k => info.probs[k])) <= 0.02
                        || Math.max(...keys.map(k => info.probs[k])) >= 0.99;
        const _attrDate = _reattrMlbGameDate(info.gameDate, t1, t2, _resolved);
        const payload = { probs: { ...info.probs } };
        _mlbF5MlMarkets[`${t1}|${t2}|${_attrDate}`] = payload;
        _mlbF5MlMarkets[`${t2}|${t1}|${_attrDate}`] = payload;
      }
    } catch { /* non-fatal — no F5 ML plays if fetch/parse blows up */ }
    // Emit F5 ML picks. Reuses _mlbF5JointCache built above (or builds on demand).
    {
      for (const ctx of Object.values(_mlbMlContext)) {
        const { homeTeam, awayTeam, gameDate, f5HomeLambda, f5AwayLambda, dispR, kalshiVolume, kalshiSpread, lowVolume, _simData } = ctx;
        if (gameDate && gameDate < cutoffStr) continue;
        if (f5HomeLambda == null || f5AwayLambda == null) continue;
        const f5MlMarket = _mlbF5MlMarkets[`${homeTeam}|${awayTeam}|${gameDate}`]
                        ?? (gameDate == null ? (_mlbF5MlMarkets[`${homeTeam}|${awayTeam}|${_todayPT}`] ?? _mlbF5MlMarkets[`${awayTeam}|${homeTeam}|${_todayPT}`]) : null);
        if (!f5MlMarket?.probs) continue;
        const homeYes = f5MlMarket.probs[homeTeam];
        const awayYes = f5MlMarket.probs[awayTeam];
        const tieYes = f5MlMarket.probs["TIE"];
        if (homeYes == null || awayYes == null || tieYes == null) continue;
        const _f5k = `${homeTeam}|${awayTeam}`;
        if (!_mlbF5JointCache[_f5k]) _mlbF5JointCache[_f5k] = simulateMLBJoint(f5HomeLambda, f5AwayLambda, dispR, 10000);
        const joint = _mlbF5JointCache[_f5k];
        if (!joint) continue;
        const homeTruePct = joint3WayPct(joint.home, joint.away, "home");
        const awayTruePct = joint3WayPct(joint.home, joint.away, "away");
        const tieTruePct  = joint3WayPct(joint.home, joint.away, "tie");
        if (homeTruePct == null || awayTruePct == null || tieTruePct == null) continue;
        const _gameTime = gameTimes[`mlb:${homeTeam}:${gameDate}`] ?? gameTimes[`mlb:${awayTeam}:${gameDate}`] ?? gameTimes[`mlb:${homeTeam}`] ?? gameTimes[`mlb:${awayTeam}`] ?? null;
        const _lineupsConfirmed = _mlbBothTeamsConfirmed(homeTeam, awayTeam, gameDate ?? _todayPT);
        const _toAO = (p) => p == null ? null : p >= 50 ? Math.round(-(p / (100 - p)) * 100) : Math.round((100 - p) / p * 100);
        const _fullGameOu = _simData?.gameOuLine ?? null;
        const _f5GameOuLine = _fullGameOu != null ? parseFloat((_fullGameOu * 5 / 9).toFixed(1)) : null;
        const _f5ExpectedTotal = parseFloat((f5HomeLambda + f5AwayLambda).toFixed(2));
        const _sides = [
          { side: "home", pickTeam: homeTeam, oppTeam: awayTeam, yesAsk: homeYes, truePct: homeTruePct },
          { side: "away", pickTeam: awayTeam, oppTeam: homeTeam, yesAsk: awayYes, truePct: awayTruePct },
          { side: "tie",  pickTeam: "TIE",   oppTeam: null,     yesAsk: tieYes,  truePct: tieTruePct  },
        ];
        for (const s of _sides) {
          const kalshiPct = parseFloat((s.yesAsk * 100).toFixed(1));
          const edge = parseFloat((s.truePct - kalshiPct).toFixed(1));
          const americanOdds = _toAO(kalshiPct);
          const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
          const _base = {
            gameType: "ml", sport: "mlb", stat: "f5ml", segment: "f5",
            homeTeam, awayTeam, pickTeam: s.pickTeam, oppTeam: s.oppTeam, side: s.side, gameDate,
            kalshiPct, americanOdds, truePct: parseFloat(s.truePct.toFixed(1)), edge,
            totalSimScore: 0, qualified: false,
            kalshiVolume, kalshiSpread, lowVolume,
            gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed,
            ..._simData,
            // F5-specific overrides (must follow _simData spread to win)
            homeLambda: f5HomeLambda, awayLambda: f5AwayLambda,
            homeExpected: f5HomeLambda, awayExpected: f5AwayLambda,
            expectedTotal: _f5ExpectedTotal,
            gameOuLine: _f5GameOuLine,
            h2hTotalHitRate: null, h2hTotalGames: null, h2hTotalPts: 1,
          };
          if (edge >= EDGE_GATE && inWindow) {
            plays.push(_base);
          } else if (isDebug && inWindow) {
            dropped.push({ ..._base, reason: "edge_too_low" });
          }
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
      // 1H/2H spreads emit through the dedicated halves block below.
      if (m.segment && m.segment !== "full") continue;
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
      // 1H/2H spreads emit through the dedicated halves block below.
      if (m.segment && m.segment !== "full") continue;
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
  // ── NBA + WNBA halves emission (1H / 2H × total / spread / ml) ───────────────────────
  // Mirror of the MLB F5 emission pattern but for NBA/WNBA halves. Lambdas pre-computed
  // in the game-total loop (h1HomeLambda / h1AwayLambda / h2HomeLambda / h2AwayLambda on
  // _nbaMlContext + _wnbaMlContext, all = full λ × 0.5 in v1). Joint sim uses Normal with
  // σ scaled by sqrt(0.5) ≈ 9.2 for NBA, 7.8 for WNBA. Winner markets are 3-way (TIE
  // priced ~3-5%); fetched inline via snap → 600s legacy → REST (mirror of KXMLBF5).
  const _halfJointCache = {}; // keyed by `${sport}|${homeTeam}|${awayTeam}|${half}`
  const _halfTotalDistCache = {};
  const _halvesWinnerMarkets = {}; // keyed by `${sport}|${homeTeam}|${awayTeam}|${gameDate}|${half}`
  // Fetch all 4 winner series inline. Same snap/legacy/REST pattern as KXMLBF5 / KXMLBGAME.
  for (const [_sportH, _halfH, _seriesH] of [
    ["nba",  "1h", "KXNBA1HWINNER"],
    ["nba",  "2h", "KXNBA2HWINNER"],
    ["wnba", "1h", "KXWNBA1HWINNER"],
    ["wnba", "2h", "KXWNBA2HWINNER"],
  ]) {
    try {
      const _impP = (m) => {
        const a = parseFloat(m.yes_ask_dollars) || 0;
        const l = parseFloat(m.last_price_dollars) || 0;
        const b = parseFloat(m.yes_bid_dollars) || 0;
        return (a >= 0.98 && b === 0 && l > 0) ? l : (a > 0 ? a : l);
      };
      const _gd = (m) => m?.expected_expiration_time ? PT_FMT.format(new Date(m.expected_expiration_time)) : null;
      let _raw = [];
      const _snapKey = `kalshi:snap:${_seriesH}`;
      const _legKey = `kalshi:${_seriesH}`;
      let _data = null;
      if (CACHE2 && !isBustCache) {
        const _snap = await CACHE2.get(_snapKey, 'json').catch(() => null);
        if (_snap && Array.isArray(_snap.markets) && _snap.markets.length > 0 &&
            (Date.now() - (_snap.writtenAt || 0) <= 180_000)) {
          _data = { markets: _snap.markets };
        }
      }
      if (!_data && CACHE2 && !isBustCache) {
        _data = await CACHE2.get(_legKey, 'json').catch(() => null);
      }
      if (!_data) {
        const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${_seriesH}&limit=1000&status=open`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        }).catch(() => null);
        if (r?.ok) {
          _data = await r.json().catch(() => null);
          if (_data && CACHE2) CACHE2.put(_legKey, JSON.stringify(_data), { expirationTtl: 600 }).catch(() => {});
        }
      }
      _raw = _data?.markets || [];
      // Group by event_ticker; allow TIE as a 3rd key alongside the two team abbrs.
      const _byEv = {};
      for (const m of _raw) {
        const tk = m.ticker || '';
        const lastDash = tk.lastIndexOf('-');
        if (lastDash < 0) continue;
        const sfx = tk.slice(lastDash + 1);
        const key = sfx === "TIE" ? "TIE" : normTeam(_sportH, sfx);
        const eventT = m.event_ticker;
        if (!eventT || !key) continue;
        const p = _impP(m);
        if (!p || p <= 0 || p >= 1) continue;
        if (!_byEv[eventT]) _byEv[eventT] = { probs: {}, gameDate: _gd(m) };
        _byEv[eventT].probs[key] = p;
      }
      for (const info of Object.values(_byEv)) {
        const keys = Object.keys(info.probs);
        if (keys.length !== 3 || !info.gameDate) continue;
        if (!keys.includes("TIE")) continue;
        const teams = keys.filter(k => k !== "TIE");
        const [t1, t2] = teams;
        const payload = { probs: { ...info.probs } };
        _halvesWinnerMarkets[`${_sportH}|${t1}|${t2}|${info.gameDate}|${_halfH}`] = payload;
        _halvesWinnerMarkets[`${_sportH}|${t2}|${t1}|${info.gameDate}|${_halfH}`] = payload;
      }
    } catch { /* non-fatal */ }
  }
  // Emit halves: walk over both sports × both halves. Reuse joint cache across emissions.
  for (const _segH of ["1h", "2h"]) {
    for (const [_sportH, _ctxMap, _sigma] of [
      ["nba",  _nbaMlContext,  13],
      ["wnba", _wnbaMlContext, 11],
    ]) {
      const _halfSigma = parseFloat((_sigma * Math.sqrt(0.5)).toFixed(2));
      // Helper: get the half lambdas for this game + half.
      const _getHalfLambdas = (ctx) => {
        if (_segH === "1h") return { hλ: ctx.h1HomeLambda, aλ: ctx.h1AwayLambda };
        return { hλ: ctx.h2HomeLambda, aλ: ctx.h2AwayLambda };
      };
      const _statTotal  = _segH === "1h" ? "h1total"  : "h2total";
      const _statSpread = _segH === "1h" ? "h1spread" : "h2spread";
      const _statMl     = _segH === "1h" ? "h1ml"     : "h2ml";
      // Totals
      for (const tm of totalMarkets) {
        if (tm.sport !== _sportH || tm.segment !== _segH) continue;
        if (tm.gameDate && tm.gameDate < cutoffStr) continue;
        const { threshold, kalshiPct, americanOdds, noKalshiPct: _tmNoPct, noKalshiAO: _tmNoAO, gameTeam1, gameTeam2, gameDate, kalshiSpread, kalshiVolume } = tm;
        const ctx = _ctxMap[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? _ctxMap[`${gameTeam2}|${gameTeam1}|${gameDate}`];
        if (!ctx) continue;
        const { homeTeam, awayTeam, _simData } = ctx;
        const { hλ, aλ } = _getHalfLambdas(ctx);
        if (hλ == null || aλ == null) continue;
        const _hk = `${_sportH}|${homeTeam}|${awayTeam}|${_segH}`;
        if (!_halfJointCache[_hk]) _halfJointCache[_hk] = simulateNBAJoint(hλ, aλ, _halfSigma, _halfSigma, 10000);
        const joint = _halfJointCache[_hk];
        if (!joint) continue;
        if (!_halfTotalDistCache[_hk]) {
          const _dist = new Int16Array(joint.home.length);
          for (let i = 0; i < joint.home.length; i++) _dist[i] = joint.home[i] + joint.away[i];
          _halfTotalDistCache[_hk] = _dist;
        }
        const truePct = totalDistPct(_halfTotalDistCache[_hk], threshold);
        if (truePct == null) continue;
        const noTruePct = parseFloat((100 - truePct).toFixed(1));
        const _gameTime = gameTimes[`${_sportH}:${homeTeam}:${gameDate}`] ?? gameTimes[`${_sportH}:${awayTeam}:${gameDate}`] ?? gameTimes[`${_sportH}:${homeTeam}`] ?? gameTimes[`${_sportH}:${awayTeam}`] ?? null;
        const _fullGameOu = _simData?.gameOuLine ?? null;
        const _halfGameOuLine = _fullGameOu != null ? parseFloat((_fullGameOu * 0.5).toFixed(1)) : null;
        const _halfExpectedTotal = parseFloat((hλ + aλ).toFixed(2));
        const _base = {
          gameType: "total", sport: _sportH, stat: _statTotal, segment: _segH,
          homeTeam, awayTeam, gameDate, threshold,
          totalSimScore: 0, qualified: false,
          kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
          gameTime: _gameTime,
          ..._simData,
          homeLambda: hλ, awayLambda: aλ,
          homeExpected: hλ, awayExpected: aλ,
          expectedTotal: _halfExpectedTotal,
          gameOuLine: _halfGameOuLine,
        };
        // OVER
        {
          const edge = parseFloat((truePct - kalshiPct).toFixed(1));
          const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
          if (edge >= EDGE_GATE && inWindow) plays.push({ ..._base, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge });
          else if (isDebug && inWindow) dropped.push({ ..._base, direction: "over", kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge, reason: "edge_too_low" });
        }
        // UNDER
        {
          const edge = parseFloat((noTruePct - _tmNoPct).toFixed(1));
          const inWindow = _tmNoPct >= KALSHI_GATE && _tmNoPct <= KALSHI_CAP;
          if (edge >= EDGE_GATE && inWindow) plays.push({ ..._base, direction: "under", kalshiPct, noKalshiPct: _tmNoPct, americanOdds: _tmNoAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, edge });
          else if (isDebug && inWindow) dropped.push({ ..._base, direction: "under", kalshiPct, noKalshiPct: _tmNoPct, americanOdds: _tmNoAO, truePct: parseFloat(truePct.toFixed(1)), noTruePct, edge, reason: _tmNoPct < KALSHI_GATE ? "under_no_price_too_low" : "edge_too_low" });
        }
      }
      // Spreads
      for (const m of spreadMarkets) {
        if (m.sport !== _sportH || m.segment !== _segH) continue;
        if (m.gameDate && m.gameDate < cutoffStr) continue;
        const { gameTeam1, gameTeam2, gameDate, marginTeam, line, kalshiPct: yesKalshi, americanOdds: yesAO, noKalshiPct: noKalshi, noKalshiAO: noAO, kalshiVolume, kalshiSpread } = m;
        const ctx = _ctxMap[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? _ctxMap[`${gameTeam2}|${gameTeam1}|${gameDate}`];
        if (!ctx) continue;
        const { homeTeam, awayTeam, _simData } = ctx;
        const { hλ, aλ } = _getHalfLambdas(ctx);
        if (hλ == null || aλ == null) continue;
        if (marginTeam !== homeTeam && marginTeam !== awayTeam) continue;
        const _hk = `${_sportH}|${homeTeam}|${awayTeam}|${_segH}`;
        if (!_halfJointCache[_hk]) _halfJointCache[_hk] = simulateNBAJoint(hλ, aλ, _halfSigma, _halfSigma, 10000);
        const joint = _halfJointCache[_hk];
        if (!joint) continue;
        const marginSide = marginTeam === homeTeam ? "home" : "away";
        const yesTruePct = spreadPctFromJoint(joint.home, joint.away, line, marginSide);
        if (yesTruePct == null) continue;
        const noTruePct = parseFloat((100 - yesTruePct).toFixed(1));
        const _gameTime = gameTimes[`${_sportH}:${homeTeam}:${gameDate}`] ?? gameTimes[`${_sportH}:${awayTeam}:${gameDate}`] ?? gameTimes[`${_sportH}:${homeTeam}`] ?? gameTimes[`${_sportH}:${awayTeam}`] ?? null;
        const _fullGameOu = _simData?.gameOuLine ?? null;
        const _halfGameOuLine = _fullGameOu != null ? parseFloat((_fullGameOu * 0.5).toFixed(1)) : null;
        const _halfExpectedTotal = parseFloat((hλ + aλ).toFixed(2));
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
          const _base = {
            gameType: "spread", sport: _sportH, stat: _statSpread, segment: _segH,
            homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
            line, pickLine, marginTeam,
            kalshiPct, americanOdds, truePct: parseFloat(truePct.toFixed(1)), edge,
            totalSimScore: 0, qualified: false,
            kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
            gameTime: _gameTime,
            ..._simData,
            homeLambda: hλ, awayLambda: aλ,
            homeExpected: hλ, awayExpected: aλ,
            expectedTotal: _halfExpectedTotal,
            gameOuLine: _halfGameOuLine,
          };
          if (edge >= EDGE_GATE && inWindow) plays.push(_base);
          else if (isDebug && inWindow) dropped.push({ ..._base, reason: "edge_too_low" });
        }
      }
      // ML 3-way (home/away/tie)
      for (const ctx of Object.values(_ctxMap)) {
        const { homeTeam, awayTeam, gameDate, kalshiVolume, kalshiSpread, lowVolume, _simData } = ctx;
        if (gameDate && gameDate < cutoffStr) continue;
        const { hλ, aλ } = _getHalfLambdas(ctx);
        if (hλ == null || aλ == null) continue;
        const wMarket = _halvesWinnerMarkets[`${_sportH}|${homeTeam}|${awayTeam}|${gameDate}|${_segH}`];
        if (!wMarket?.probs) continue;
        const homeYes = wMarket.probs[homeTeam];
        const awayYes = wMarket.probs[awayTeam];
        const tieYes = wMarket.probs["TIE"];
        if (homeYes == null || awayYes == null || tieYes == null) continue;
        const _hk = `${_sportH}|${homeTeam}|${awayTeam}|${_segH}`;
        if (!_halfJointCache[_hk]) _halfJointCache[_hk] = simulateNBAJoint(hλ, aλ, _halfSigma, _halfSigma, 10000);
        const joint = _halfJointCache[_hk];
        if (!joint) continue;
        const homeTruePct = joint3WayPct(joint.home, joint.away, "home");
        const awayTruePct = joint3WayPct(joint.home, joint.away, "away");
        const tieTruePct  = joint3WayPct(joint.home, joint.away, "tie");
        if (homeTruePct == null || awayTruePct == null || tieTruePct == null) continue;
        const _gameTime = gameTimes[`${_sportH}:${homeTeam}:${gameDate}`] ?? gameTimes[`${_sportH}:${awayTeam}:${gameDate}`] ?? gameTimes[`${_sportH}:${homeTeam}`] ?? gameTimes[`${_sportH}:${awayTeam}`] ?? null;
        const _toAO = (p) => p == null ? null : p >= 50 ? Math.round(-(p / (100 - p)) * 100) : Math.round((100 - p) / p * 100);
        const _fullGameOu = _simData?.gameOuLine ?? null;
        const _halfGameOuLine = _fullGameOu != null ? parseFloat((_fullGameOu * 0.5).toFixed(1)) : null;
        const _halfExpectedTotal = parseFloat((hλ + aλ).toFixed(2));
        const _sides = [
          { side: "home", pickTeam: homeTeam, oppTeam: awayTeam, yesAsk: homeYes, truePct: homeTruePct },
          { side: "away", pickTeam: awayTeam, oppTeam: homeTeam, yesAsk: awayYes, truePct: awayTruePct },
          { side: "tie",  pickTeam: "TIE",   oppTeam: null,     yesAsk: tieYes,  truePct: tieTruePct  },
        ];
        for (const s of _sides) {
          const kalshiPct = parseFloat((s.yesAsk * 100).toFixed(1));
          const edge = parseFloat((s.truePct - kalshiPct).toFixed(1));
          const americanOdds = _toAO(kalshiPct);
          const inWindow = kalshiPct >= KALSHI_GATE && kalshiPct <= KALSHI_CAP;
          const _base = {
            gameType: "ml", sport: _sportH, stat: _statMl, segment: _segH,
            homeTeam, awayTeam, pickTeam: s.pickTeam, oppTeam: s.oppTeam, side: s.side, gameDate,
            kalshiPct, americanOdds, truePct: parseFloat(s.truePct.toFixed(1)), edge,
            totalSimScore: 0, qualified: false,
            kalshiVolume, kalshiSpread, lowVolume,
            gameTime: _gameTime,
            ..._simData,
            homeLambda: hλ, awayLambda: aλ,
            homeExpected: hλ, awayExpected: aλ,
            expectedTotal: _halfExpectedTotal,
            gameOuLine: _halfGameOuLine,
          };
          if (edge >= EDGE_GATE && inWindow) plays.push(_base);
          else if (isDebug && inWindow) dropped.push({ ..._base, reason: "edge_too_low" });
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
}
