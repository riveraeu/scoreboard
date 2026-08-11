// api/lib/tonight/ticker-ml-modelfree.js
// emitTickerMlModelFreePlays — THE shared emitter for model-free match-winner leagues whose
// identity comes entirely from the Kalshi ticker, with no ESPN feed behind them.
//
// Generalized from kleague-modelfree.js on 2026-08-10 when KBO became the second league of this
// exact shape. Deliberately generalized at copy #2 rather than #7: the two modules differed only
// in a sport string and where gameTime comes from, and the MODEL_FREE_LEAGUES history is explicit
// that every recurring silent failure in this pipeline has been a copy-paste omission across N
// near-identical copies (gameTime:null in 8-9 Phase-1 modules, kalshiTicker never set across the
// same 9). One copy cannot drift from another.
//
// Shape: Kalshi lists one binary YES market per outcome of a match — N=2 for KBO (no ties in
// Korean baseball as Kalshi lists it), N=3 for K League (home / away / TIE). Every quoted side is
// captured independently; the caller's parse branch has already applied the CAPTURE band and
// capturableSpread gates and resolved teams via parseGameTeams.
//
// gameTime is passed through per-market rather than derived here, because the two leagues differ:
//   kleague — null. The ticker carries no HHMM and occurrence_datetime is the post-game settlement
//             expiration, not kickoff. Rows log but are not maker-quotable; accepted at build time.
//   kbo     — real. The ticker DOES carry HHMM (KXKBOGAME-26AUG130600LGKIW → 06:00), so
//             kalshiTickerGameTime gives a true first pitch.
// Both are settlement-authoritative (`kleague`/`kbo` in SETTLEMENT_AUTHORITATIVE_SPORTS and the
// resolver's _ownResolverSports), so no ESPN slug is needed for grading either.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;

export function emitTickerMlModelFreePlays({ markets, plays, cutoffStr, sport }) {
  if (!markets || markets.length === 0) return;

  const events = new Map();
  for (const m of markets) {
    if (!events.has(m.eventTicker)) {
      events.set(m.eventTicker, {
        homeTeam: m.homeTeam, awayTeam: m.awayTeam,
        gameDate: m.gameDate, gameTime: m.gameTime ?? null, sides: [],
      });
    }
    events.get(m.eventTicker).sides.push(m);
  }

  for (const [eventTicker, ev] of events) {
    if (ev.gameDate && cutoffStr && ev.gameDate < cutoffStr) continue;

    for (const s of ev.sides) {
      if (!inWindow(s.yesPct)) continue;

      plays.push({
        sport, stat: "game", gameType: "game", modelVersion: `${sport}-modelfree-v1`,
        homeTeam: ev.homeTeam, awayTeam: ev.awayTeam,
        pickTeam: s.side,
        threshold: null, direction: null,
        truePct: null, kalshiPct: s.yesPct, noKalshiPct: s.noPct ?? null,
        americanOdds: null, edge: null,
        dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
        gameDate: ev.gameDate, gameTime: ev.gameTime, eventTicker,
        kalshiVolume: s.kalshiVolume ?? null, kalshiTicker: s._ticker ?? null,
        kalshiSide: "yes",
      });
    }
  }
}
