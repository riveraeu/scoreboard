// api/lib/tonight/nascar.js
// emitNascarPlays — NASCAR Cup head-to-head + Top-10 finish, model-free maker capture.
//
// Kalshi lists two binary driver-vs-driver markets per H2H matchup ("A beats B" / "B beats A")
// and one binary per driver for Top-10 ("<driver> finishes top 10"). The parse loop in tonight.js
// collects every priced side into nascarMarkets, each carrying its subtype + driver name(s) (from
// yes_sub_title) + race code + gameDate. Here we emit the FAVORITE side (the higher-priced side) —
// a PURELY PRICE-BASED selection, no model.
//
// Model-free (2026-08-04, model teardown): the recent-form finishing-position model was deleted, and
// grading went Kalshi-settlement-only (Phase B), so the driver-id index is gone too. No truePct/edge
// is computed; the row exists only to capture the Kalshi curve for the maker instrument. Output goes
// into a dedicated `nascarPlays` array (NOT the shared `plays` array); tonight.js merges it into
// shadow:staging only.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getRaceGameTime } from "../nascar-schedule.js";

export async function emitNascarPlays(ctx) {
  const { nascarMarkets, nascarPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!nascarMarkets || nascarMarkets.length === 0) return;

  // Real green-flag time for computeMakerQuote's pre-game gate. ~1 Cup race per weekend, so this is
  // at most a couple of distinct dates per run.
  const dateStrs = [...new Set(nascarMarkets.map(m => (m.gameDate || "").replace(/-/g, "")).filter(Boolean))];
  const gameTimesByDate = new Map();
  await Promise.all(dateStrs.map(async (dateStr) => {
    gameTimesByDate.set(dateStr, await getRaceGameTime(dateStr, { cache, isBustCache }));
  }));

  for (const m of nascarMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // race already past the cutoff day
    if (m.kalshiPct < CAPTURE_GATE || m.kalshiPct > CAPTURE_CAP) continue; // quote-sanity only (full-curve capture 2026-07-03)
    const gameTime = gameTimesByDate.get((m.gameDate || "").replace(/-/g, "")) ?? null;

    if (m.subtype === "h2h") {
      if (!m.player || !m.opponent) {
        if (isDebug) dropped.push({ sport: "nascar", stat: "h2h", reason: "no_matchup", eventTicker: m.eventTicker });
        continue;
      }
      nascarPlays.push({
        sport: "nascar", stat: "h2h",
        playerName: m.player,
        homeTeam: m.player, awayTeam: m.opponent, pickTeam: m.player,
        threshold: null, direction: null,
        truePct: null, kalshiPct: m.kalshiPct, americanOdds: m.americanOdds ?? null,
        edge: null, dataConfidence: null, dcQualified: false, qualified: false,
        modelFree: true,
        gameDate: m.gameDate, gameTime, modelVersion: "nascar-modelfree-v1",
        race: m.raceCode, opponent: m.opponent,
        kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
      });
    } else if (m.subtype === "top10") {
      if (!m.player) {
        if (isDebug) dropped.push({ sport: "nascar", stat: "top10", reason: "no_driver", eventTicker: m.eventTicker });
        continue;
      }
      nascarPlays.push({
        sport: "nascar", stat: "top10",
        playerName: m.player,
        homeTeam: m.player, awayTeam: "FIELD", pickTeam: m.player,
        threshold: 10, direction: null,
        truePct: null, kalshiPct: m.kalshiPct, americanOdds: m.americanOdds ?? null,
        edge: null, dataConfidence: null, dcQualified: false, qualified: false,
        modelFree: true,
        gameDate: m.gameDate, gameTime, modelVersion: "nascar-modelfree-v1",
        race: m.raceCode,
        kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
      });
    }
  }
}
