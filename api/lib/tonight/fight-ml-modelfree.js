// api/lib/tonight/fight-ml-modelfree.js
// emitFightMlModelFreePlays — UFC (KXUFCFIGHT) + Boxing (KXBOXING) match-winner, model-free.
//
// Each fight has one YES market per fighter (e.g. KXUFCFIGHT-26AUG15JOHOCH-JOH and -OCH).
// Captures the YES side of each market — both fighters covered without shadowId collision (the
// same pattern as Dota2: YES on fighter A + YES on fighter B = both directions of the fight).
//
// gameTime from close_time (per-bout, not per-card). Stable home/away: fighter codes sorted
// alphabetically per event so both rows share identical homeTeam/awayTeam.
//
// Resolution: settlement-authoritative ("ufc"/"boxing" in SETTLEMENT_AUTHORITATIVE_SPORTS).

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";

export function emitFightMlModelFreePlays({ markets, plays, cutoffStr }) {
  if (!markets || markets.length === 0) return;

  const events = new Map();
  for (const m of markets) {
    if (!events.has(m.eventTicker)) events.set(m.eventTicker, []);
    events.get(m.eventTicker).push(m);
  }

  for (const [, sides] of events) {
    sides.sort((a, b) => a.fighterCode.localeCompare(b.fighterCode));
    const homeTeam = sides[0].fighterCode;
    const awayTeam = sides.length > 1 ? sides[1].fighterCode : sides[0].fighterCode;
    const { sport, gameDate, gameTime } = sides[0];

    if (gameDate && cutoffStr && gameDate < cutoffStr) continue;

    for (const m of sides) {
      if (!(m.yesPct >= CAPTURE_GATE && m.yesPct <= CAPTURE_CAP)) continue;
      plays.push({
        sport, stat: "ml", gameType: "fightMl", modelVersion: "fight-ml-modelfree-v1",
        homeTeam, awayTeam, pickTeam: m.fighterCode,
        gameDate, gameTime: gameTime ?? null,
        kalshiPct: m.yesPct, noKalshiPct: m.noPct ?? null,
        kalshiSide: "yes", kalshiTicker: m._ticker ?? null, kalshiVolume: m.kalshiVolume ?? null,
        truePct: null, edge: null, dataConfidence: null, dcQualified: false,
        qualified: false, modelFree: true,
      });
    }
  }
}
