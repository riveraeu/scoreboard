// api/lib/tonight/mlb-outs.js
// emitMlbOutsPlays — MLB pitcher outs-recorded O/U (KXMLBOUTS), model-free maker capture.
//
// Kalshi lists a threshold ladder per starting pitcher ("Kodai Senga: 15+", 18+, 21+, ...). Each
// market is a binary YES = "records N+ outs". The parse loop in tonight.js collects every priced
// threshold into outsMarkets, each carrying the pitcher name (yes_sub_title), the over threshold
// (floor_strike), the YES/NO prices, the resolved home/away abbrs, and gameDate. Here we emit the
// FAVORITE side (the higher-priced side) — a PURELY PRICE-BASED selection, no model.
//
// Model-free (2026-08-04, model teardown): the outs workload projection (Normal on batters-faced ×
// out-rate) was deleted with the rest of the models — no truePct/edge is computed, the row exists
// only to capture the Kalshi curve for the maker instrument. `truePct`/`edge` are null,
// `qualified` is false. Output goes into a dedicated `outsPlays` array (NOT the shared `plays`
// array) so outs rows bypass prop dedup, the gameTime filter, and the frontend card builder.
// tonight.js merges outsPlays into the shadow:staging payload ONLY. Rows are PROP-SHAPED
// (player_name + stat:"outs" + threshold + direction) so the existing player-prop resolver / Kalshi
// settlement grade them.

// Shadow-only: the window is purely a capture selector, so use the wide CAPTURE band so the full
// favorite curve is logged.
import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";

export function emitMlbOutsPlays(ctx) {
  const { outsMarkets, outsPlays, cutoffStr, sportByteam, gameTimes } = ctx;
  if (!outsMarkets || outsMarkets.length === 0) return;

  // Real gameTime for computeMakerQuote's pre-game gate. Same lookup idiom as props.js: keyed off
  // the pitcher's own team (this is a prop-shaped row), with a tomorrow-date fallback for the
  // pre-midnight-PT / post-midnight-UTC listing gap.
  const _tomorrowISOStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  for (const m of outsMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // game already past the cutoff day

    // Canonical side = the favorite (higher-priced side), by PRICE only — no model. Under full-curve
    // capture (2026-07-03) the band is quote-sanity-wide, so both sides can sit in it; pick one row
    // per rung by price.
    const overFav = (m.yesPct ?? 0) >= CAPTURE_GATE && m.yesPct <= CAPTURE_CAP
                 && (m.yesPct ?? 0) >= (m.noPct ?? 0);
    const underFav = !overFav && (m.noPct ?? 0) >= CAPTURE_GATE && m.noPct <= CAPTURE_CAP;
    if (!overFav && !underFav) continue;

    const direction = overFav ? "over" : "under";
    const kalshiPct = overFav ? m.yesPct : m.noPct;
    const americanOdds = overFav ? m.yesAO : m.noAO;

    // Resolve home/away (Kalshi ticker order ≠ ESPN home/away) via gameHomeTeams.
    let homeTeam = m.gameTeam1, awayTeam = m.gameTeam2;
    if (sportByteam?.mlb?.gameHomeTeams?.[m.gameTeam2]) { homeTeam = m.gameTeam2; awayTeam = m.gameTeam1; }

    const gameTime = gameTimes?.[`mlb:${m.pitcherTeam}:${m.gameDate}`]
      ?? gameTimes?.[`mlb:${m.pitcherTeam}:${_tomorrowISOStr}`]
      ?? gameTimes?.[`mlb:${m.pitcherTeam}`]
      ?? gameTimes?.[`mlb:${homeTeam}:${m.gameDate}`]
      ?? gameTimes?.[`mlb:${awayTeam}:${m.gameDate}`]
      ?? null;

    outsPlays.push({
      sport: "mlb", stat: "outs",
      playerName: m.player,
      homeTeam, awayTeam, pickTeam: m.pitcherTeam || null,
      threshold: m.threshold, direction,
      truePct: null, kalshiPct, noKalshiPct: m.noPct,
      americanOdds: americanOdds ?? null,
      edge: null, dataConfidence: null, dcQualified: false, qualified: false,
      modelFree: true,
      gameDate: m.gameDate, gameTime, modelVersion: "mlb-outs-modelfree-v1",
      pitcherTeam: m.pitcherTeam || null,
      kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
    });
  }
}
