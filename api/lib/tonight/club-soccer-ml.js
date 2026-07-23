// api/lib/tonight/club-soccer-ml.js
// emitClubSoccerMlPlays — MLS game winner (3-way home/away/tie), Phase 1, model-free.
//
// No probability model at all: the maker strategy captures Kalshi's own favorite-ask
// mispricing directly (see project_maker_modelfree_clubsoccer_2026_07_23 memory), so this
// module only needs a real gameTime (fetched from ESPN via api/lib/mls.js — unlike every other
// Phase-1 shadow-only module, which hardcodes gameTime:null and is therefore silently never
// maker-quotable, since computeMakerQuote's pre-game gate requires a real future timestamp),
// the parsed home/away/tie identity, and the quoted price for calibration bookkeeping.
// truePct/edge/dataConfidence are all null; dcQualified/qualified are false — these rows are
// maker-only and must never enter the taker-bettable universe (see the model_true_pct IS NOT
// NULL guards added to the Brier/calibration queries the same day this shipped).
//
// Output goes into a dedicated `clubSoccerPlays` array (NOT the shared `plays` array) so these
// rows bypass prop/total dedup, the gameTime filter, and the frontend card builder — same idiom
// as every other Phase-1 module. tonight.js merges clubSoccerPlays into the shadow:staging
// payload only; the client never sees them. `mls|game` is not in the category gate.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getMlsSchedule } from "../mls.js";

export async function emitClubSoccerMlPlays(ctx) {
  const { clubSoccerMarkets, clubSoccerPlays, cutoffStr, cache, isBustCache } = ctx;
  if (!clubSoccerMarkets || clubSoccerMarkets.length === 0) return;

  // Group every priced side by event so one schedule lookup serves all of that game's sides.
  const events = new Map();
  for (const m of clubSoccerMarkets) {
    if (!events.has(m.eventTicker)) {
      events.set(m.eventTicker, { homeTeam: m.homeTeam, awayTeam: m.awayTeam, gameDate: m.gameDate, sides: [] });
    }
    events.get(m.eventTicker).sides.push(m);
  }

  // Fetch each distinct date's schedule once (MLS plays several games/night — one shared
  // fetch avoids N concurrent calls racing to populate the same cache key).
  const dateStrs = [...new Set([...events.values()].map(ev => (ev.gameDate || "").replace(/-/g, "")).filter(Boolean))];
  const schedulesByDate = new Map();
  await Promise.all(dateStrs.map(async (dateStr) => {
    schedulesByDate.set(dateStr, await getMlsSchedule({ dateStr, cache, isBustCache }));
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
      clubSoccerPlays.push({
        sport: "mls", stat: "game", gameType: "game", modelVersion: "mls-modelfree-v1",
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
