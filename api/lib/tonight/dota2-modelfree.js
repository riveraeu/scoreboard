// api/lib/tonight/dota2-modelfree.js
// emitDota2ModelFreePlays — Dota 2 (KXDOTA2GAME) match-winner, model-free maker capture.
//
// Kalshi lists two separate YES markets per match — one per team. Each is captured as a
// YES-side row: `kalshiSide:"yes"`, `pickTeam=teamCode` (ticker suffix after the final `-`).
// Stable home/away: the two team codes for one event are sorted alphabetically →
// homeTeam = lexically-first code, awayTeam = second. This ensures both rows share the same
// homeTeam/awayTeam so their shadowIds differ only by pickTeam (the bet side).
//
// gameTime is derived directly from the ticker (YYMONDDHHMMM format, ET→UTC via
// kalshiTickerGameTime) — no external API fetch needed. Emit is synchronous.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;

export function emitDota2ModelFreePlays({ markets, plays, cutoffStr }) {
  if (!markets || markets.length === 0) return;

  // Group markets by event_ticker so we can sort team codes for stable home/away assignment.
  const events = new Map();
  for (const m of markets) {
    if (!events.has(m.eventTicker)) events.set(m.eventTicker, []);
    events.get(m.eventTicker).push(m);
  }

  for (const [, sides] of events) {
    // Sort by teamCode for deterministic home/away regardless of API response order.
    sides.sort((a, b) => a.teamCode.localeCompare(b.teamCode));
    const homeTeam = sides[0].teamCode;
    const awayTeam = sides.length > 1 ? sides[1].teamCode : sides[0].teamCode;

    for (const m of sides) {
      if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue;
      if (!inWindow(m.yesPct)) continue;

      plays.push({
        sport: "dota2", stat: "ml", gameType: "dota2Game", modelVersion: "dota2-modelfree-v1",
        homeTeam, awayTeam, pickTeam: m.teamCode,
        gameDate: m.gameDate, gameTime: m.gameTime ?? null,
        kalshiPct: m.yesPct, noKalshiPct: m.noPct ?? null,
        kalshiSide: "yes", kalshiTicker: m._ticker ?? null, kalshiVolume: m.kalshiVolume ?? null,
        truePct: null, edge: null, dataConfidence: null, dcQualified: false,
        qualified: false, modelFree: true,
      });
    }
  }
}
