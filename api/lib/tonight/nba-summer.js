// api/lib/tonight/nba-summer.js
// emitNbaSummerPlays — NBA Summer League game winner (Phase 1, shadow-only).
//
// Kalshi lists two binary markets per game (one "Will <team> win?" per side), grouped by
// event_ticker. The parse loop in tonight.js collects every priced side into nbaSummerMarkets,
// each already carrying its canonical pick team + opponent (parsed from the ticker via
// parseGameTeams). Here we look up both teams' within-tournament Elo and emit every quoted
// side with the model's win probability — no grouping needed, each side is self-contained.
//
// Output goes into a dedicated `nbaSummerPlays` array (NOT the shared `plays` array) so SL rows
// bypass prop/total dedup, the gameTime filter, and the frontend card builder. tonight.js merges
// nbaSummerPlays into the shadow:staging payload only — shadow logs them, the client never sees
// them. `nbasl|ml` is not in the category gate, so they're shadow-only.

// Shadow-only: the window is purely a capture selector (no dropped fallback), so use the wide
// CAPTURE band so calibration sees the full favorite curve. Betting is gated later (category gate).
import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getSlEloIndex, lookupSlElo, slWinProb } from "../nba-summer.js";

export async function emitNbaSummerPlays(ctx) {
  const { nbaSummerMarkets, nbaSummerPlays, cutoffStr, cache, isBustCache } = ctx;
  if (!nbaSummerMarkets || nbaSummerMarkets.length === 0) return;

  const index = await getSlEloIndex({ cache, isBustCache });
  const ratings = index?.ratings || {};

  for (const m of nbaSummerMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // game already past cutoff day
    // Every quoted side is logged (full-curve capture 2026-07-03) — mirror sides land as
    // separate rows, same idiom as ML home/away. The band check is quote-sanity only now.
    if (m.kalshiPct < CAPTURE_GATE || m.kalshiPct > CAPTURE_CAP) continue;
    // Unplayed teams rate at the parity base (the model's prior), so no no_rating drop path.
    const rPick = lookupSlElo(ratings, m.pickTeam);
    const rOpp = lookupSlElo(ratings, m.opponent);
    const truePct = parseFloat((slWinProb(rPick.rating, rOpp.rating) * 100).toFixed(1));
    const edge = parseFloat((truePct - m.kalshiPct).toFixed(1));
    nbaSummerPlays.push({
      sport: "nbasl", stat: "ml",
      // Ticker-order teams land in homeTeam/awayTeam so the resolver's NOT NULL filter selects
      // these rows (Kalshi order ≠ true home/away; the SL resolver matches on the sorted pair,
      // never on which side is home). pickTeam carries the bet side.
      homeTeam: m.gameTeam1, awayTeam: m.gameTeam2, pickTeam: m.pickTeam,
      threshold: null, direction: null,
      truePct, kalshiPct: m.kalshiPct, americanOdds: m.americanOdds ?? null,
      edge, dataConfidence: 10, dcQualified: true, qualified: true,
      gameDate: m.gameDate, gameTime: null, modelVersion: "nbasl-v1",
      // feature fields (→ features JSON via extractFeatures): Elo state at capture time aids
      // later analysis (parity-start rows are separable via pickGames/oppGames = 0).
      opponent: m.opponent, pickElo: rPick.rating, oppElo: rOpp.rating,
      pickGames: rPick.games, oppGames: rOpp.games, eloGamesUsed: index?.gamesUsed ?? 0,
      kalshiVolume: m.kalshiVolume ?? null,
    });
  }
}
