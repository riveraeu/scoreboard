// api/lib/tonight/golf-h2h.js
// emitGolfH2hPlays — PGA single-round head-to-head (Phase 1, shadow-only).
//
// Kalshi lists two binary markets per matchup ("A beats B in round N" / "B beats A in round N"),
// grouped by event_ticker. The parse loop in tonight.js collects every priced side into
// golfH2hMarkets, each carrying its own player + opponent + round (parsed from yes_sub_title:
// "<A> beats <B> in the <N>th Round"). Here we emit the FAVORITE side (the one whose Kalshi YES
// price sits in the [67,91] qualification window) with the OWGR-derived P(player beats opponent).
//
// Output goes into a dedicated `golfH2hPlays` array (NOT the shared `plays` array) so golf rows
// bypass prop/total dedup, the gameTime filter, and the frontend card builder. tonight.js merges
// golfH2hPlays into the shadow:staging payload only — shadow logs them, the client never sees
// them. `golf|h2h` is not in the category gate, so they're shadow-only.

// Shadow-only: the window is purely a capture selector (no dropped fallback), so use the wide
// CAPTURE band so calibration sees the full favorite curve. Betting is gated later (category gate).
import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getRatingIndex, lookupRating, h2hWinProb } from "../golf.js";

export async function emitGolfH2hPlays(ctx) {
  const { golfH2hMarkets, golfH2hPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!golfH2hMarkets || golfH2hMarkets.length === 0) return;

  const index = await getRatingIndex({ cache, isBustCache });
  if (!index) {
    if (isDebug) dropped.push({ sport: "golf", stat: "h2h", reason: "no_ratings" });
    return;
  }

  for (const m of golfH2hMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // round already past cutoff day
    // Only the favorite side (Kalshi YES price in the capture band) is logged.
    if (m.kalshiPct < CAPTURE_GATE || m.kalshiPct > CAPTURE_CAP) continue;
    if (!m.player || !m.opponent) {
      if (isDebug) dropped.push({ sport: "golf", stat: "h2h", reason: "no_matchup", eventTicker: m.eventTicker });
      continue;
    }
    const rPick = lookupRating(index, m.player);
    const rOpp = lookupRating(index, m.opponent);
    if (!rPick || !rOpp) {
      if (isDebug) dropped.push({ sport: "golf", stat: "h2h", playerName: m.player, opponent: m.opponent, reason: "no_rating", eventTicker: m.eventTicker });
      continue;
    }
    const truePct = parseFloat((h2hWinProb(rPick.rating, rOpp.rating).pA * 100).toFixed(1));
    const edge = parseFloat((truePct - m.kalshiPct).toFixed(1));
    golfH2hPlays.push({
      sport: "golf", stat: "h2h",
      playerName: m.player,
      // Both player names land in homeTeam/awayTeam so the resolver's NOT NULL filter selects
      // these rows; pickTeam carries the bet side for reporting symmetry with ML.
      homeTeam: m.player, awayTeam: m.opponent, pickTeam: m.player,
      threshold: null, direction: null,
      truePct, kalshiPct: m.kalshiPct, americanOdds: m.americanOdds ?? null,
      edge, dataConfidence: 10, dcQualified: true, qualified: true,
      gameDate: m.gameDate, gameTime: null, modelVersion: "golf-v1",
      // feature fields (→ features JSON): round drives resolver round-score selection; the rest
      // aid later analysis.
      round: m.round, tournament: m.tournament, opponent: m.opponent,
      pickRank: rPick.rank, oppRank: rOpp.rank, pickPts: rPick.points, oppPts: rOpp.points,
      kalshiVolume: m.kalshiVolume ?? null,
    });
  }
}
