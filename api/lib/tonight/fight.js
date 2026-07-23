// api/lib/tonight/fight.js
// emitFightPlays — UFC rounds O/U ("ends before round N"), Phase 1, shadow-only.
//
// The parse loop in tonight.js collects every priced KXUFCROUNDS side into fightMarkets, each
// tagged with the event ticker, the fighter-code segment, the threshold N (from the ticker
// suffix), and the per-side prices. Here we group by event, match the event's fighter codes to
// the ESPN fight card to read its weight class + scheduled rounds, derive the constant per-round
// finish hazard from the weight class's finish rate, and read each threshold's "ends before
// round N" probability off the resulting CDF.
//
// Output goes into a dedicated `fightPlays` array (NOT the shared `plays` array) so fight rows
// bypass prop/total dedup, the gameTime filter, and the frontend card builder. tonight.js merges
// fightPlays into the shadow:staging payload only — shadow logs them, the client never sees them.
// `fight|rounds` is not in the category gate, so they're shadow-only.
//
// OVER/UNDER convention mirrors soccer/game-totals: truePct ALWAYS carries the YES model prob
// (here P(ends before round N) — the early-finish side), and the UNDER/NO row (reaches round N)
// adds noTruePct — the shadow insert flips model_true_pct to 100−truePct for direction:"under".

// Shadow-only: the window is purely a capture selector (no dropped fallback), so use the wide
// CAPTURE band so calibration sees the full favorite curve. Betting is gated later (category gate).
import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import {
  getFightCardIndex, matchFightByCodes, finishRateFor, roundHazard, pEndBeforeRound,
  normFighterName,
} from "../mma.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;
const round1 = (x) => parseFloat(x.toFixed(1));

export async function emitFightPlays(ctx) {
  const { fightMarkets, fightPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!fightMarkets || fightMarkets.length === 0) return;

  const cardIndex = await getFightCardIndex({ cache, isBustCache });
  if (!cardIndex || Object.keys(cardIndex).length === 0) {
    if (isDebug) dropped.push({ sport: "fight", stat: "rounds", reason: "no_card" });
    return;
  }

  // Group every priced threshold by event so one weight-class lookup serves the whole fight.
  const events = new Map();
  for (const m of fightMarkets) {
    if (!events.has(m.eventTicker)) {
      events.set(m.eventTicker, { codeSegment: m.codeSegment, gameDate: m.gameDate, sides: [] });
    }
    events.get(m.eventTicker).sides.push(m);
  }

  for (const [eventTicker, ev] of events) {
    if (ev.gameDate && cutoffStr && ev.gameDate < cutoffStr) continue; // fight already past cutoff day

    // Match the Kalshi fighter codes to an ESPN bout. Search the event's own date first, then
    // the whole card index (date keys can drift by a day across the UTC boundary).
    const tryDates = [ev.gameDate, ...Object.keys(cardIndex)].filter(Boolean);
    let fight = null;
    for (const d of tryDates) {
      fight = matchFightByCodes(ev.codeSegment, cardIndex[d] || []);
      if (fight) break;
    }
    if (!fight) {
      if (isDebug) dropped.push({ sport: "fight", stat: "rounds", reason: "no_weightclass", eventTicker, codeSegment: ev.codeSegment });
      continue;
    }

    const finishRate = finishRateFor(fight.weightClass);
    const h = roundHazard(finishRate);
    const lastA = (normFighterName(fight.names[0]).split(" ").pop()) || fight.lastNames[0];
    const lastB = (normFighterName(fight.names[1]).split(" ").pop()) || fight.lastNames[1];

    const base = {
      sport: "fight", stat: "rounds", gameType: "rounds", modelVersion: "fight-v1",
      // Both fighters' last names land in homeTeam/awayTeam so the resolver's NOT NULL filter
      // selects these rows and can re-match the bout by name.
      homeTeam: lastA, awayTeam: lastB, pickTeam: null,
      // Card start time (found 2026-07-23 — computeMakerQuote needs a real future gameTime;
      // getFightCardIndex already fetches future cards, this was just never captured). Coarse:
      // all bouts on a card share it (ESPN doesn't expose per-bout walkout times), but real.
      gameDate: ev.gameDate, gameTime: fight.eventDate ?? null,
      dataConfidence: 10, dcQualified: true, qualified: true,
      // feature fields (→ features JSON): weight class + scheduled rounds drive the model;
      // fighter names aid later analysis / resolution sanity.
      weightClass: fight.weightClass || null, scheduledRounds: fight.scheduledRounds,
      finishRate, roundHazard: round1(h * 100) / 100, fighterA: fight.names[0], fighterB: fight.names[1],
      eventCodes: ev.codeSegment, // resolver fallback when last-name match misses

    };

    for (const s of ev.sides) {
      const n = s.threshold;
      if (!(n >= 2)) continue;
      const pOver = pEndBeforeRound(h, n); // P(ends before round N) — the YES side
      const overPct = round1(pOver * 100);
      const sideBase = { ...base, threshold: n, kalshiVolume: s.kalshiVolume ?? null };

      // YES / "ends before round N" — gated on the YES price.
      if (inWindow(s.yesPct)) {
        fightPlays.push({
          ...sideBase, direction: "over",
          truePct: overPct, kalshiPct: s.yesPct, noKalshiPct: s.noPct,
          americanOdds: s.yesAO ?? null, edge: round1(overPct - s.yesPct),
        });
      } else if (isDebug) {
        dropped.push({ ...sideBase, direction: "over", truePct: overPct, kalshiPct: s.yesPct, reason: "kalshi_out_of_window" });
      }
      // NO / "reaches round N" — gated on the NO price; truePct stays the OVER prob, noTruePct added.
      if (inWindow(s.noPct)) {
        fightPlays.push({
          ...sideBase, direction: "under",
          truePct: overPct, noTruePct: round1(100 - overPct),
          kalshiPct: s.yesPct, noKalshiPct: s.noPct,
          americanOdds: s.noAO ?? null, edge: round1((100 - overPct) - s.noPct),
        });
      } else if (isDebug) {
        dropped.push({ ...sideBase, direction: "under", truePct: overPct, noTruePct: round1(100 - overPct), noKalshiPct: s.noPct, reason: "kalshi_out_of_window" });
      }
    }
  }
}
