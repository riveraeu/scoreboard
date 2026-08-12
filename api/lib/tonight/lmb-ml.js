// api/lib/tonight/lmb-ml.js
// emitLmbPlays — LMB (Mexican League) game winner, model-free maker capture.
//
// Kalshi lists two binary markets per game (one "Will <team> win?" per side), grouped by
// event_ticker. The parse loop in tonight.js collects every priced side into lmbMarkets, each
// already carrying its canonical pick team + opponent (parsed from the ticker via parseGameTeams —
// LMB abbrs are all 3-char, validated 3+3 split). Here we emit EVERY quoted side with a real
// gameTime from the statsapi schedule.
//
// Model-free (2026-08-04, model teardown): the run-rate λ → NegBin-joint win-prob model was deleted
// (along with simulate.js) — no truePct/edge is computed, the row exists only to capture the Kalshi
// curve for the maker instrument. Output goes into a dedicated `lmbPlays` array (NOT the shared
// `plays` array); tonight.js merges it into shadow:staging only.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getLmbSchedule } from "../lmb-schedule.js";
import { kalshiTickerGameTime } from "../kalshi-ticker.js";

export async function emitLmbPlays(ctx) {
  const { lmbMarkets, lmbPlays, cutoffStr, cache, isBustCache } = ctx;
  if (!lmbMarkets || lmbMarkets.length === 0) return;

  // Real gameTime for computeMakerQuote's pre-game gate. Fetch each distinct date's schedule once.
  const dateStrs = [...new Set(lmbMarkets.map(m => (m.gameDate || "").replace(/-/g, "")).filter(Boolean))];
  const schedulesByDate = new Map();
  await Promise.all(dateStrs.map(async (dateStr) => {
    schedulesByDate.set(dateStr, await getLmbSchedule({ dateStr, cache, isBustCache }));
  }));

  for (const m of lmbMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // game already past cutoff day
    // Every quoted side is logged (full-curve capture 2026-07-03) — mirror sides land as separate
    // rows, same idiom as ML home/away. The band check is quote-sanity only.
    if (m.kalshiPct < CAPTURE_GATE || m.kalshiPct > CAPTURE_CAP) continue;
    const dateStr = (m.gameDate || "").replace(/-/g, "");
    const schedGame = dateStr ? schedulesByDate.get(dateStr)?.[[m.gameTeam1, m.gameTeam2].sort().join("|")] : null;
    lmbPlays.push({
      sport: "lmb", stat: "ml",
      // Ticker-order teams land in homeTeam/awayTeam so the resolver's NOT NULL filter selects
      // these rows (Kalshi order ≠ true home/away). pickTeam carries the bet side.
      homeTeam: m.gameTeam1, awayTeam: m.gameTeam2, pickTeam: m.pickTeam,
      threshold: null, direction: null,
      truePct: null, kalshiPct: m.kalshiPct, americanOdds: m.americanOdds ?? null,
      edge: null, dataConfidence: null, dcQualified: false, qualified: false,
      modelFree: true,
      // Schedule first (statsapi reflects a moved first pitch; the ticker is frozen at listing),
      // ticker second. The fallback exists because statsapi's sportId=23 slate is NOT always
      // complete for a date Kalshi has already listed — on 2026-08-11 it carried 4 of the 6
      // matchups Kalshi quoted, and the two it omitted logged `gameTime: null`, which grades and
      // logs fine but is never maker-quotable (the silent-killer field, root CLAUDE.md).
      // KXLMBGAME tickers carry HHMM (`KXLMBGAME-26AUG112130SDMCDJ-SDM`), and on the four games
      // where both sources existed that day the two agreed to the minute, 4/4.
      gameDate: m.gameDate, gameTime: schedGame?.gameTime ?? kalshiTickerGameTime(m.eventTicker), modelVersion: "lmb-modelfree-v1",
      opponent: m.opponent,
      kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
    });
  }
}
