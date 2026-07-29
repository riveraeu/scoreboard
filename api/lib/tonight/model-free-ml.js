// api/lib/tonight/model-free-ml.js
// emitModelFreeMlPlays — game winner (3-way home/away/tie) for every model-free soccer league,
// Phase 1. Replaces six per-league emit modules (club-soccer-ml, brasileirao-ml, nwsl-ml,
// chnsl-ml, ligamx-ml, argprem-ml) that were BYTE-IDENTICAL once the league name was normalized —
// the only difference between any two of them was comment prose. See model-free-leagues.js for
// why that duplication was the bug source rather than merely verbose.
//
// No probability model at all: the maker strategy captures Kalshi's own favorite-ask mispricing
// directly (project_maker_modelfree_clubsoccer_2026_07_23), so this only needs a real gameTime
// (from ESPN via the league's registered source), the parsed home/away/tie identity, and the
// quoted price for calibration bookkeeping. truePct/edge/dataConfidence are null; dcQualified and
// qualified are false — these rows are maker-only and must never enter the taker-bettable universe.
//
// Rows go into a per-league bucket (NOT the shared `plays` array) so they bypass prop/total dedup,
// the gameTime filter, and the frontend card builder; tonight.js merges them into shadow:staging
// only. No `<league>|game` category is in the category gate.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { leagueSource } from "../model-free-leagues.js";

export async function emitModelFreeMlPlays(ctx) {
  const { league, markets, plays, cutoffStr, cache, isBustCache } = ctx;
  if (!league || !markets || markets.length === 0) return;
  const { getSchedule } = leagueSource(league);

  // Group every priced side by event so one schedule lookup serves all of that game's sides.
  const events = new Map();
  for (const m of markets) {
    if (!events.has(m.eventTicker)) {
      events.set(m.eventTicker, { homeTeam: m.homeTeam, awayTeam: m.awayTeam, gameDate: m.gameDate, sides: [] });
    }
    events.get(m.eventTicker).sides.push(m);
  }

  // Fetch each distinct date's schedule once.
  const dateStrs = [...new Set([...events.values()].map(ev => (ev.gameDate || "").replace(/-/g, "")).filter(Boolean))];
  const schedulesByDate = new Map();
  await Promise.all(dateStrs.map(async (dateStr) => {
    schedulesByDate.set(dateStr, await getSchedule({ dateStr, cache, isBustCache }));
  }));

  for (const [eventTicker, ev] of events) {
    if (ev.gameDate && cutoffStr && ev.gameDate < cutoffStr) continue; // game already past cutoff day
    const dateStr = (ev.gameDate || "").replace(/-/g, "");
    const schedule = schedulesByDate.get(dateStr) || {};
    const game = schedule[[ev.homeTeam, ev.awayTeam].sort().join("|")];
    const gameTime = game?.gameTime ?? null; // no schedule match → stays null (maker just won't quote it)

    for (const s of ev.sides) {
      // Full-curve capture (2026-07-03 doctrine) — quote-sanity band only, no model to gate on.
      if (s.kalshiPct < CAPTURE_GATE || s.kalshiPct > CAPTURE_CAP) continue;
      plays.push({
        // `half` is set for the 1H markets (KXMLS1H / KXLIGAMX1H — same ticker/suffix shape as
        // their full-game siblings, routed here by the same gameType). stat + half are what tell
        // shadow.js's resolver to grade off half-time scores (`fetchHalfResults`) rather than the
        // full-game result; the other four leagues have no 1H series and always emit `game`.
        sport: league, stat: s.half ? `${s.half}game` : "game", gameType: "game", half: s.half || null,
        modelVersion: `${league}-modelfree-v1`,
        homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
        pickTeam: s.side === "tie" ? "TIE" : s.sideCode,
        threshold: null, direction: null,
        truePct: null, kalshiPct: s.kalshiPct, noKalshiPct: s.noKalshiPct ?? null,
        americanOdds: s.americanOdds ?? null, edge: null,
        dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
        gameDate: ev.gameDate, gameTime, eventTicker,
        kalshiVolume: s.kalshiVolume ?? null, kalshiTicker: s._ticker ?? null,
      });
    }
  }
}
