// api/lib/tonight/nascar.js
// emitNascarPlays — NASCAR Cup head-to-head + Top-10 finish (Phase 1, shadow-only).
//
// Kalshi lists two binary driver-vs-driver markets per H2H matchup ("A beats B" / "B beats A")
// and one binary per driver for Top-10 ("<driver> finishes top 10"). The parse loop in tonight.js
// collects every priced side into nascarMarkets, each carrying its subtype + driver name(s) (from
// yes_sub_title) + race code + gameDate. Here we emit the FAVORITE side (the one whose Kalshi YES
// price sits in the [67,91] window) with the recent-form finishing-position probability.
//
// Output goes into a dedicated `nascarPlays` array (NOT the shared `plays` array) so NASCAR rows
// bypass prop/total dedup, the gameTime filter, and the frontend card builder. tonight.js merges
// nascarPlays into the shadow:staging payload only — shadow logs them, the client never sees them.
// `nascar|h2h` / `nascar|top10` are not in the category gate, so they're shadow-only.
//
// Each play stores the pick/opponent ESPN athlete ids (→ features JSONB) so the resolver grades by
// id off the race's competitor list — no name matching needed at resolve time. Both driver names
// land in home_team/away_team (Top-10 uses "FIELD" as the away sentinel) so the resolver's NOT-NULL
// filter selects the rows.

// Shadow-only: the window is purely a capture selector (no dropped fallback), so use the wide
// CAPTURE band so calibration sees the full favorite curve. Betting is gated later (category gate).
import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getDriverIndex, lookupDriver, pBeats, pTopN } from "../nascar.js";

export async function emitNascarPlays(ctx) {
  const { nascarMarkets, nascarPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!nascarMarkets || nascarMarkets.length === 0) return;

  const index = await getDriverIndex({ cache, isBustCache });
  if (!index) {
    if (isDebug) dropped.push({ sport: "nascar", stat: "h2h", reason: "no_ratings" });
    return;
  }

  for (const m of nascarMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // race already past the cutoff day
    if (m.kalshiPct < CAPTURE_GATE || m.kalshiPct > CAPTURE_CAP) continue; // capture the favorite curve

    if (m.subtype === "h2h") {
      if (!m.player || !m.opponent) {
        if (isDebug) dropped.push({ sport: "nascar", stat: "h2h", reason: "no_matchup", eventTicker: m.eventTicker });
        continue;
      }
      const rPick = lookupDriver(index, m.player);
      const rOpp = lookupDriver(index, m.opponent);
      if (!rPick || !rOpp) {
        // Also the Cup-scoping drain: Truck/Xfinity-only drivers aren't in the Cup index.
        if (isDebug) dropped.push({ sport: "nascar", stat: "h2h", playerName: m.player, opponent: m.opponent, reason: "no_rating", eventTicker: m.eventTicker });
        continue;
      }
      const truePct = parseFloat((pBeats(rPick.avgFinish, rOpp.avgFinish) * 100).toFixed(1));
      const edge = parseFloat((truePct - m.kalshiPct).toFixed(1));
      nascarPlays.push({
        sport: "nascar", stat: "h2h",
        playerName: m.player,
        homeTeam: m.player, awayTeam: m.opponent, pickTeam: m.player,
        threshold: null, direction: null,
        truePct, kalshiPct: m.kalshiPct, americanOdds: m.americanOdds ?? null,
        edge, dataConfidence: 10, dcQualified: true, qualified: true,
        gameDate: m.gameDate, gameTime: null, modelVersion: "nascar-v1",
        // feature fields (→ features JSON): pick/opp ids drive id-based resolution; the rest analyze.
        race: m.raceCode, opponent: m.opponent,
        pickId: rPick.id, oppId: rOpp.id,
        pickAvgFinish: rPick.avgFinish, oppAvgFinish: rOpp.avgFinish,
        pickRaces: rPick.nRaces, oppRaces: rOpp.nRaces,
        kalshiVolume: m.kalshiVolume ?? null,
      });
    } else if (m.subtype === "top10") {
      if (!m.player) {
        if (isDebug) dropped.push({ sport: "nascar", stat: "top10", reason: "no_driver", eventTicker: m.eventTicker });
        continue;
      }
      const rPick = lookupDriver(index, m.player);
      if (!rPick) {
        if (isDebug) dropped.push({ sport: "nascar", stat: "top10", playerName: m.player, reason: "no_rating", eventTicker: m.eventTicker });
        continue;
      }
      const truePct = parseFloat((pTopN(rPick.avgFinish, 10) * 100).toFixed(1));
      const edge = parseFloat((truePct - m.kalshiPct).toFixed(1));
      nascarPlays.push({
        sport: "nascar", stat: "top10",
        playerName: m.player,
        homeTeam: m.player, awayTeam: "FIELD", pickTeam: m.player,
        threshold: 10, direction: null,
        truePct, kalshiPct: m.kalshiPct, americanOdds: m.americanOdds ?? null,
        edge, dataConfidence: 10, dcQualified: true, qualified: true,
        gameDate: m.gameDate, gameTime: null, modelVersion: "nascar-v1",
        race: m.raceCode,
        pickId: rPick.id,
        pickAvgFinish: rPick.avgFinish, pickRaces: rPick.nRaces,
        kalshiVolume: m.kalshiVolume ?? null,
      });
    }
  }
}
