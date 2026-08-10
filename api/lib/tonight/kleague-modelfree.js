// api/lib/tonight/kleague-modelfree.js
// emitKleagueModelFreePlays — K League 1 (KXKLEAGUEGAME) match-winner, model-free maker.
//
// Kalshi lists three binary markets per match: homeTeam / awayTeam / TIE. All three YES sides
// are captured independently. gameDate from the ticker (YYMONDD format via kalshiTickerDate),
// gameTime = null — occurrence_datetime is the post-game settlement expiration, not kickoff;
// no ESPN slug exists for K League. Settlement-authoritative (kleague in
// SETTLEMENT_AUTHORITATIVE_SPORTS). 12-team registry in teams.js, all 3-char abbrs.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;

export function emitKleagueModelFreePlays({ markets, plays, cutoffStr }) {
  if (!markets || markets.length === 0) return;

  const events = new Map();
  for (const m of markets) {
    if (!events.has(m.eventTicker)) {
      events.set(m.eventTicker, { homeTeam: m.homeTeam, awayTeam: m.awayTeam, gameDate: m.gameDate, sides: [] });
    }
    events.get(m.eventTicker).sides.push(m);
  }

  for (const [eventTicker, ev] of events) {
    if (ev.gameDate && cutoffStr && ev.gameDate < cutoffStr) continue;

    for (const s of ev.sides) {
      if (!inWindow(s.yesPct)) continue;

      plays.push({
        sport: "kleague", stat: "game", gameType: "game", modelVersion: "kleague-modelfree-v1",
        homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
        pickTeam: s.side,
        threshold: null, direction: null,
        truePct: null, kalshiPct: s.yesPct, noKalshiPct: s.noPct ?? null,
        americanOdds: null, edge: null,
        dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
        gameDate: ev.gameDate, gameTime: null, eventTicker,
        kalshiVolume: s.kalshiVolume ?? null, kalshiTicker: s._ticker ?? null,
        kalshiSide: "yes",
      });
    }
  }
}
