// api/lib/tonight/game-totals.js
// Game total + team total capture — all sports (MLB, NBA, WNBA, NHL; NFL totals pass through).
//
// Model-free (2026-08-04, model teardown): every per-sport total/team-total model (MLB lambda
// pipeline, NBA/WNBA/NHL rating blends, schedule H2H / season-hit-rate / dispersion fits, B2B,
// injury/usage/pace, SimScore) was deleted. No truePct/edge is computed — each captured Kalshi
// total/team-total market becomes one model-free row PER QUOTED SIDE for the maker instrument.
// `truePct`/`edge` are null, `qualified` is false, `modelFree` is true. No dedup / edge ranking
// (capture-all-sides: every alt-line + both sides are their own rows).
//
// The full-curve CAPTURE band + the `capturableSpread` liquidity gate are ALREADY applied at
// parse (tonight.js), so a market present in totalMarkets/teamTotalMarkets has real two-sided
// quotes — we emit YES/OVER (from kalshiPct) and NO/UNDER (from the real no_ask noKalshiPct;
// never synthesize `100 - yes`) without re-gating.
//
// Home/away is the load-bearing piece: MLB/NBA/WNBA/NHL are the calibrated families graded off
// ESPN /api/live, where a wrong home/away silently mis-grades. The Kalshi ticker order
// (gameTeam1/gameTeam2) does NOT reflect ESPN home/away, so we keep the exact swap logic from the
// model era (nba/nhl/wnba/nfl via *GameScores; mlb via gameHomeTeams; team totals mlb+nba).
// nfl joined 2026-08-10 with the KXNFLGAME build — KXNFLTOTAL had been parsing with NO context
// map and no home/away source at all, so this repairs the total family as well as feeding ML.
//
// Returns the minimal `_*MlContext` maps consumed by emitAllMlAndSpread in ml-spread.js:
// `{ [`${homeTeam}|${awayTeam}|${gameDate}`]: { homeTeam, awayTeam, gameDate, kalshiVolume,
// kalshiSpread, lowVolume } }` — home/away resolution + game-level volume flags, NO lambdas.
// Populated for every full-game total market so ML/spread home/away coverage is >= the model era.

// Context: plays, dropped (mutated via push), isDebug, cutoffStr, gameTimes,
//          totalMarkets/teamTotalMarkets, mlbBothTeamsConfirmed (closure), sportByteam.
export async function emitGameTotalPlays({
  plays, dropped, isDebug, cutoffStr, gameTimes,
  totalMarkets, teamTotalMarkets,
  mlbBothTeamsConfirmed: _mlbBothTeamsConfirmed,
  sportByteam,
}) {
  const _mlbMlContext = {};
  const _nbaMlContext = {};
  const _wnbaMlContext = {};
  const _nhlMlContext = {};
  const _nflMlContext = {};
  const _ctxFor = (sport) => sport === "mlb" ? _mlbMlContext : sport === "nba" ? _nbaMlContext : sport === "wnba" ? _wnbaMlContext : sport === "nhl" ? _nhlMlContext : sport === "nfl" ? _nflMlContext : null;

  const _gameTimeFor = (sport, homeTeam, awayTeam, gameDate) =>
    gameTimes?.[`${sport}:${homeTeam}:${gameDate}`]
    ?? gameTimes?.[`${sport}:${awayTeam}:${gameDate}`]
    ?? gameTimes?.[`${sport}:${homeTeam}`]
    ?? gameTimes?.[`${sport}:${awayTeam}`]
    ?? null;

  // ── Game totals (KX*TOTAL) ─────────────────────────────────────────────────────────────
  {
    const _gtVolumeMap = {};
    for (const tm of totalMarkets) { const _gk = `${tm.sport}|${tm.gameTeam1}|${tm.gameTeam2}`; _gtVolumeMap[_gk] = (_gtVolumeMap[_gk] ?? 0) + (tm.kalshiVolume ?? 0); }
    for (const tm of totalMarkets) {
      const { sport, stat, threshold, kalshiPct, americanOdds, noKalshiPct, noKalshiAO, gameTeam1, gameTeam2, gameDate, kalshiSpread, kalshiVolume } = tm;
      // Segment totals (F5 / halves / quarters) emit through ml-spread.js's segment blocks.
      if (tm.segment && tm.segment !== "full") continue;
      if (gameDate && gameDate < cutoffStr) continue;
      const lowVolume = (_gtVolumeMap[`${sport}|${gameTeam1}|${gameTeam2}`] ?? 0) < 50;
      // Kalshi ticker order != ESPN home/away. Swap so downstream (card, resolver, ML/spread
      // context) all see the same home/away as gameScores/gameHomeTeams.
      let homeTeam = gameTeam1, awayTeam = gameTeam2;
      if (sport === "nba" || sport === "nhl" || sport === "wnba" || sport === "nfl") {
        const _gsMap = sport === "nba" ? sportByteam.nbaGameScores : sport === "wnba" ? sportByteam.wnbaGameScores : sport === "nfl" ? sportByteam.nflGameScores : sportByteam.nhlGameScores;
        if (_gsMap) {
          for (const _gs of Object.values(_gsMap)) {
            if (_gs?.homeTeam === gameTeam2 && _gs?.awayTeam === gameTeam1) { homeTeam = gameTeam2; awayTeam = gameTeam1; break; }
          }
        }
      } else if (sport === "mlb") {
        if (sportByteam.mlb?.gameHomeTeams?.[gameTeam2]) { homeTeam = gameTeam2; awayTeam = gameTeam1; }
      }
      const _gameTime = _gameTimeFor(sport, homeTeam, awayTeam, gameDate);
      const _lineupsConfirmed = sport === "mlb" ? _mlbBothTeamsConfirmed(homeTeam, awayTeam, gameDate) : void 0;
      // Populate the minimal ML/spread context once per game (home/away + game-level volume).
      const _ctx = _ctxFor(sport);
      if (_ctx) {
        const _k = `${homeTeam}|${awayTeam}|${gameDate}`;
        if (!_ctx[_k]) _ctx[_k] = { homeTeam, awayTeam, gameDate, kalshiVolume, kalshiSpread, lowVolume };
      }
      const _base = {
        gameType: "total", sport, stat,
        homeTeam, awayTeam, threshold,
        truePct: null, edge: null, dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
        kalshiVolume, kalshiSpread, lowVolume,
        gameDate, gameTime: _gameTime, lineupsConfirmed: _lineupsConfirmed,
        kalshiTicker: tm._ticker ?? null, modelVersion: `${sport}-modelfree-v1`,
      };
      // OVER (YES ask)
      plays.push({ ..._base, direction: "over", kalshiPct, americanOdds, kalshiSide: "yes" });
      // UNDER (real NO ask only — never synthesize 100 - yes)
      if (noKalshiPct != null) {
        plays.push({ ..._base, direction: "under", kalshiPct, noKalshiPct, americanOdds: noKalshiAO ?? null, kalshiSide: "no" });
      }
    }
  }

  // ── Team totals (KXMLBTEAMTOTAL, KXNBATEAMTOTAL) ───────────────────────────────────────
  {
    const _ttVolumeMap = {};
    for (const tm of teamTotalMarkets) { const _ttgk = `${tm.sport}|${tm.gameTeam1}|${tm.gameTeam2}`; _ttVolumeMap[_ttgk] = (_ttVolumeMap[_ttgk] ?? 0) + (tm.kalshiVolume ?? 0); }
    for (const tm of teamTotalMarkets) {
      const { sport, stat, threshold, kalshiPct, americanOdds, noKalshiPct, noKalshiAO, gameTeam1, gameTeam2, scoringTeam, gameDate, kalshiSpread, kalshiVolume } = tm;
      if (gameDate && gameDate < cutoffStr) continue;
      const lowVolume = (_ttVolumeMap[`${sport}|${gameTeam1}|${gameTeam2}`] ?? 0) < 50;
      // Same home/away swap as game totals (KXMLBTEAMTOTAL/KXNBATEAMTOTAL only).
      let homeTeam = gameTeam1, awayTeam = gameTeam2;
      if (sport === "mlb" && sportByteam.mlb?.gameHomeTeams?.[gameTeam2]) { homeTeam = gameTeam2; awayTeam = gameTeam1; }
      else if (sport === "nba" && sportByteam.nbaGameScores) {
        for (const _gs of Object.values(sportByteam.nbaGameScores)) {
          if (_gs?.homeTeam === gameTeam2 && _gs?.awayTeam === gameTeam1) { homeTeam = gameTeam2; awayTeam = gameTeam1; break; }
        }
      }
      const oppTeam = scoringTeam === homeTeam ? awayTeam : homeTeam;
      const _gameTime = _gameTimeFor(sport, homeTeam, awayTeam, gameDate);
      // Game-time weather (MLB shadow-only exogenous feature — logged, not modeled).
      const _ttWx = sport === "mlb" ? sportByteam.mlb?.weatherByTeam?.[homeTeam] : null;
      const _ttWeather = (_ttWx && !_ttWx.dome && _ttWx.windOutMph != null)
        ? { windOutMph: _ttWx.windOutMph, tempF: _ttWx.tempF } : null;
      const _base = {
        gameType: "teamTotal", sport, stat,
        scoringTeam, oppTeam, homeTeam, awayTeam, threshold,
        truePct: null, edge: null, dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
        kalshiVolume, kalshiSpread, lowVolume,
        gameDate, gameTime: _gameTime,
        kalshiTicker: tm._ticker ?? null, modelVersion: `${sport}-modelfree-v1`,
        ...(_ttWeather || {}),
      };
      // OVER (YES ask)
      plays.push({ ..._base, direction: "over", kalshiPct, americanOdds, kalshiSide: "yes" });
      // UNDER (real NO ask only)
      if (noKalshiPct != null) {
        plays.push({ ..._base, direction: "under", kalshiPct, noKalshiPct, americanOdds: noKalshiAO ?? null, kalshiSide: "no" });
      }
    }
  }

  void isDebug; void dropped; // model-free capture routes every row to `plays`; kept for call-site shape.
  return { _mlbMlContext, _nbaMlContext, _wnbaMlContext, _nhlMlContext, _nflMlContext };
}
