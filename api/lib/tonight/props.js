// api/lib/tonight/props.js
// emitPropPlays — player prop capture (all sports), model-free.
//
// Model-free (2026-08-04, model teardown): every per-sport prop model (MLB K/HRR/hits/totalBases
// gamelog projections, NBA/WNBA points/rebounds/etc. DVP+pace+usage models, NHL SOG) was deleted.
// No truePct/edge is computed — each captured Kalshi prop market becomes one model-free row for the
// maker instrument. `truePct`/`edge` are null, `qualified` is false.
//
// The prop markets are already parsed in tonight.js into `loopMarkets` (= qualifyingMarkets), each
// carrying the full identity: playerName(+Display), sport, stat, threshold, kalshiPct (YES),
// direction ("under" for totalBases NO-favored; absent = over) + noKalshiPct/noKalshiAO, gameTeam1/2,
// kalshiPlayerTeam, gameDate, kalshiVolume, _ticker. The full-curve capture band ([CAPTURE_GATE,
// CAPTURE_CAP]) + the liquidity gate are ALREADY applied at parse, so here we just resolve the
// opponent + gameTime and emit — no dedup (capture-all-sides: every alt-line is its own row, there is
// no "best edge" without a model).
//
// Under props follow the totals convention: kalshiPct stays the YES/over price, the NO/under price
// rides in noKalshiPct, and `direction` tells consumers which side the row is framed to.
//
// Returns { plays, dropped, nbaDropped } — the shared arrays game-totals.js / ml-spread.js also push
// into. dropped/nbaDropped stay empty (model-free has no model-drop rows); kept for call-site shape.

export async function emitPropPlays({ loopMarkets, gameTimes, isDebug }) {
  const plays = [];
  const dropped = [];
  const nbaDropped = [];
  if (!loopMarkets || loopMarkets.length === 0) return { plays, dropped, nbaDropped };

  const _tomorrowISOStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  for (const m of loopMarkets) {
    const { sport, stat, threshold, gameDate } = m;
    const playerName = m.playerNameDisplay || m.playerName;
    const playerTeam = m.kalshiPlayerTeam;

    // Opponent = the other team in the matchup (the resolver needs it to find the player's game).
    let opponent = null;
    if (m.gameTeam1 && m.gameTeam2) {
      if (m.gameTeam1 === playerTeam) opponent = m.gameTeam2;
      else if (m.gameTeam2 === playerTeam) opponent = m.gameTeam1;
    }
    if (!opponent) {
      if (isDebug) dropped.push({ playerName, sport, stat, threshold, kalshiPct: m.kalshiPct, reason: "no_opp", playerTeam, gameTeam1: m.gameTeam1, gameTeam2: m.gameTeam2, gameDate, kalshiTicker: m._ticker ?? null });
      continue;
    }

    const gameTime = gameTimes?.[`${sport}:${playerTeam}:${gameDate}`]
      ?? gameTimes?.[`${sport}:${playerTeam}:${_tomorrowISOStr}`]
      ?? gameTimes?.[`${sport}:${playerTeam}`]
      ?? null;

    plays.push({
      sport, stat,
      playerName, playerId: null,
      playerTeam, opponent,
      threshold,
      // Directional (under) props carry the NO side; over props (direction absent) stay YES-framed.
      ...(m.direction ? { direction: m.direction, noKalshiPct: m.noKalshiPct ?? null, noKalshiAO: m.noKalshiAO ?? null } : {}),
      kalshiPct: m.kalshiPct, americanOdds: m.americanOdds ?? null,
      truePct: null, edge: null, dataConfidence: null, dcQualified: false, qualified: false,
      modelFree: true,
      gameDate, gameTime, modelVersion: `${sport}-modelfree-v1`,
      kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
    });
  }

  return { plays, dropped, nbaDropped };
}
