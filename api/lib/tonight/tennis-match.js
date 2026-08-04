// api/lib/tonight/tennis-match.js
// emitTennisMatchPlays — ATP/WTA match-winner, model-free maker capture.
//
// Kalshi lists two binary markets per match (one "Will <player> win?" per side), grouped by
// event_ticker. The parse loop in tonight.js collects every priced side into tennisMatchMarkets;
// here we group by event so each side knows its opponent (the other side's player) and emit EVERY
// priced side (full-curve capture 2026-07-03), with a real gameTime from the tour schedule.
//
// Model-free (2026-08-04, model teardown): the ESPN-rankings logistic win-prob model was deleted —
// no truePct/edge is computed, the row exists only to capture the Kalshi curve for the maker
// instrument. `truePct`/`edge` are null, `qualified` is false. Output goes into a dedicated
// `tennisPlays` array (NOT the shared `plays` array) so tennis rows bypass prop/total dedup, the
// gameTime filter, and the frontend card builder; tonight.js merges it into shadow:staging only.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { normTennisName, getTennisSchedule } from "../tennis-schedule.js";

export async function emitTennisMatchPlays(ctx) {
  const { tennisMatchMarkets, tennisPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!tennisMatchMarkets || tennisMatchMarkets.length === 0) return;

  // Group markets by event_ticker so each side can see its opponent.
  const events = new Map();
  for (const m of tennisMatchMarkets) {
    if (!events.has(m.eventTicker)) {
      events.set(m.eventTicker, { tour: m.tour, gameDate: m.gameDate, matchup: m.matchup, sides: [] });
    }
    events.get(m.eventTicker).sides.push(m);
  }

  // Real gameTime for computeMakerQuote's pre-game gate. Fetch each distinct (tour, date) schedule
  // once, not once per event.
  const tourDates = [...new Set([...events.values()].map(ev => `${ev.tour}|${(ev.gameDate || "").replace(/-/g, "")}`))]
    .filter(td => td.split("|")[1]);
  const schedulesByTourDate = new Map();
  await Promise.all(tourDates.map(async (td) => {
    const [tour, dateStr] = td.split("|");
    schedulesByTourDate.set(td, await getTennisSchedule(tour, dateStr, { cache, isBustCache }));
  }));

  for (const [eventTicker, ev] of events) {
    if (ev.gameDate && cutoffStr && ev.gameDate < cutoffStr) continue; // stale (game already past cutoff day)
    for (const side of ev.sides) {
      // Every quoted side is logged (full-curve capture 2026-07-03) — mirror sides land as
      // separate rows, same idiom as ML home/away. The band check is quote-sanity only.
      if (side.kalshiPct < CAPTURE_GATE || side.kalshiPct > CAPTURE_CAP) continue;
      // Opponent: the other side's full name if priced; else the last name parsed from the title.
      const other = ev.sides.find((s) => s !== side);
      const opponent = other?.player || side.opponentRaw || null;
      if (!opponent) {
        if (isDebug) dropped.push({ sport: "tennis", stat: "match", playerName: side.player, reason: "no_opponent", eventTicker });
        continue;
      }
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
        truePct: null, kalshiPct: side.kalshiPct, americanOdds: side.americanOdds ?? null,
        edge: null, dataConfidence: null, dcQualified: false, qualified: false,
        modelFree: true,
        gameDate: ev.gameDate, gameTime: schedGame?.gameTime ?? null, modelVersion: "tennis-modelfree-v1",
        // feature field (→ features JSON): tour drives resolver scoreboard selection.
        tour: ev.tour, opponent,
        kalshiVolume: side.kalshiVolume ?? null, kalshiTicker: side._ticker ?? null,
      });
    }
  }
}
