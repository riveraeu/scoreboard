// api/lib/tonight/tennis-match.js
// emitTennisMatchPlays — ATP/WTA match-winner emission (Phase 1, shadow-only).
//
// Kalshi lists two binary markets per match (one "Will <player> win?" per side), grouped by
// event_ticker. The parse loop in tonight.js collects every priced side into
// tennisMatchMarkets; here we group by event so each side knows its opponent (the other
// side's player), look up both players' ranking-based ratings, and emit the FAVORITE side
// (the one whose Kalshi YES price sits in the [67,91] qualification window) with the model's
// win probability. Both-sides-priced is the common case; if only one side is priced we fall
// back to the opponent last-name parsed from the title.
//
// Output goes into a dedicated `tennisPlays` array (NOT the shared `plays` array) so tennis
// rows bypass the prop/total dedup, gameTime filter, and frontend card builder entirely.
// tonight.js merges tennisPlays into the shadow:staging payload only — shadow logs them, the
// client never sees them. `tennis|match` is not in the category gate, so they're shadow-only.

// Shadow-only: the window is purely a capture selector (no dropped fallback), so use the wide
// CAPTURE band so calibration sees the full favorite curve. Betting is gated later (category gate).
import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getRatingIndex, lookupRating, tennisMatchProb, normTennisName, getTennisSchedule } from "../tennis.js";

export async function emitTennisMatchPlays(ctx) {
  const { tennisMatchMarkets, tennisPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!tennisMatchMarkets || tennisMatchMarkets.length === 0) return;

  // Rating indexes for whichever tours are present this run (cached in KV, 12h TTL).
  const tours = [...new Set(tennisMatchMarkets.map((m) => m.tour))];
  const indexes = {};
  await Promise.all(tours.map(async (t) => { indexes[t] = await getRatingIndex(t, { cache, isBustCache }); }));

  // Group markets by event_ticker so each side can see its opponent.
  const events = new Map();
  for (const m of tennisMatchMarkets) {
    if (!events.has(m.eventTicker)) {
      events.set(m.eventTicker, { tour: m.tour, gameDate: m.gameDate, matchup: m.matchup, sides: [] });
    }
    events.get(m.eventTicker).sides.push(m);
  }

  // Real gameTime for computeMakerQuote's pre-game gate (found 2026-07-23 — this module was
  // hardcoding gameTime:null despite ESPN's own c.date being one field away). Fetch each
  // distinct (tour, date) schedule once, not once per event.
  const tourDates = [...new Set([...events.values()].map(ev => `${ev.tour}|${(ev.gameDate || "").replace(/-/g, "")}`))]
    .filter(td => td.split("|")[1]);
  const schedulesByTourDate = new Map();
  await Promise.all(tourDates.map(async (td) => {
    const [tour, dateStr] = td.split("|");
    schedulesByTourDate.set(td, await getTennisSchedule(tour, dateStr, { cache, isBustCache }));
  }));

  for (const [eventTicker, ev] of events) {
    if (ev.gameDate && cutoffStr && ev.gameDate < cutoffStr) continue; // stale (game already past cutoff day)
    const index = indexes[ev.tour];
    if (!index) {
      if (isDebug) dropped.push({ sport: "tennis", stat: "match", reason: "no_ratings", eventTicker });
      continue;
    }
    for (const side of ev.sides) {
      // Every quoted side is logged (full-curve capture 2026-07-03) — mirror sides land as
      // separate rows, same idiom as ML home/away. The band check is quote-sanity only now.
      if (side.kalshiPct < CAPTURE_GATE || side.kalshiPct > CAPTURE_CAP) continue;
      // Opponent: the other side's full name if priced; else the last name parsed from the title.
      const other = ev.sides.find((s) => s !== side);
      const opponent = other?.player || side.opponentRaw || null;
      if (!opponent) {
        if (isDebug) dropped.push({ sport: "tennis", stat: "match", playerName: side.player, reason: "no_opponent", eventTicker });
        continue;
      }
      const rPick = lookupRating(index, side.player);
      const rOpp = lookupRating(index, opponent);
      if (!rPick || !rOpp) {
        if (isDebug) dropped.push({ sport: "tennis", stat: "match", playerName: side.player, opponent, reason: "no_rating", eventTicker });
        continue;
      }
      const truePct = parseFloat((tennisMatchProb(rPick.rating, rOpp.rating) * 100).toFixed(1));
      const edge = parseFloat((truePct - side.kalshiPct).toFixed(1));
      const tourDateKey = `${ev.tour}|${(ev.gameDate || "").replace(/-/g, "")}`;
      const pairKey = [normTennisName(side.player), normTennisName(opponent)].sort().join("|");
      const schedGame = schedulesByTourDate.get(tourDateKey)?.[pairKey];
      tennisPlays.push({
        sport: "tennis", stat: "match",
        playerName: side.player,
        // Both player names land in homeTeam/awayTeam so the resolver's NOT NULL filter
        // selects these rows; pickTeam carries the bet side for reporting symmetry with ML.
        homeTeam: side.player, awayTeam: opponent, pickTeam: side.player,
        threshold: null, direction: null,
        truePct, kalshiPct: side.kalshiPct, americanOdds: side.americanOdds ?? null,
        edge, dataConfidence: 10, dcQualified: true, qualified: true,
        gameDate: ev.gameDate, gameTime: schedGame?.gameTime ?? null, modelVersion: "tennis-v1",
        // feature fields (→ features JSON via extractFeatures): tour drives resolver scoreboard
        // selection; ranks/opponent/volume aid later analysis.
        tour: ev.tour, opponent, pickRank: rPick.rank, oppRank: rOpp.rank,
        kalshiVolume: side.kalshiVolume ?? null, kalshiTicker: side._ticker ?? null,
      });
    }
  }
}
