// api/lib/tonight/fight.js
// emitFightPlays — UFC rounds O/U ("ends before round N"), model-free maker capture.
//
// The parse loop in tonight.js collects every priced KXUFCROUNDS side into fightMarkets, each
// tagged with the event ticker, the fighter-code segment, the threshold N (from the ticker suffix),
// and the per-side prices. Here we group by event, match the event's fighter codes to the ESPN
// fight card to read the two fighters' names (row identity) + the card start time (gameTime), and
// emit every priced threshold/side.
//
// Model-free (2026-08-04, model teardown): the weight-class finish-rate → fight-duration CDF model
// was deleted — no truePct/edge is computed, the row exists only to capture the Kalshi curve for the
// maker instrument. Output goes into a dedicated `fightPlays` array (NOT the shared `plays` array);
// tonight.js merges it into shadow:staging only.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getFightCardIndex, matchFightByCodes, normFighterName } from "../mma-card.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;

export async function emitFightPlays(ctx) {
  const { fightMarkets, fightPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!fightMarkets || fightMarkets.length === 0) return;

  const cardIndex = await getFightCardIndex({ cache, isBustCache });
  if (!cardIndex || Object.keys(cardIndex).length === 0) {
    if (isDebug) dropped.push({ sport: "fight", stat: "rounds", reason: "no_card" });
    return;
  }

  // Group every priced threshold by event so one card lookup serves the whole fight.
  const events = new Map();
  for (const m of fightMarkets) {
    if (!events.has(m.eventTicker)) {
      events.set(m.eventTicker, { codeSegment: m.codeSegment, gameDate: m.gameDate, sides: [] });
    }
    events.get(m.eventTicker).sides.push(m);
  }

  for (const [eventTicker, ev] of events) {
    if (ev.gameDate && cutoffStr && ev.gameDate < cutoffStr) continue; // fight already past cutoff day

    // Match the Kalshi fighter codes to an ESPN bout. Search the event's own date first, then the
    // whole card index (date keys can drift by a day across the UTC boundary).
    const tryDates = [ev.gameDate, ...Object.keys(cardIndex)].filter(Boolean);
    let fight = null;
    for (const d of tryDates) {
      fight = matchFightByCodes(ev.codeSegment, cardIndex[d] || []);
      if (fight) break;
    }
    if (!fight) {
      if (isDebug) dropped.push({ sport: "fight", stat: "rounds", reason: "no_fighter_match", eventTicker, codeSegment: ev.codeSegment });
      continue;
    }

    const lastA = (normFighterName(fight.names[0]).split(" ").pop()) || fight.lastNames[0];
    const lastB = (normFighterName(fight.names[1]).split(" ").pop()) || fight.lastNames[1];

    const base = {
      sport: "fight", stat: "rounds", gameType: "rounds", modelVersion: "fight-modelfree-v1",
      // Both fighters' last names land in homeTeam/awayTeam so the resolver's NOT NULL filter
      // selects these rows and can re-match the bout by name.
      homeTeam: lastA, awayTeam: lastB, pickTeam: null,
      // Card start time (all bouts on a card share it — ESPN doesn't expose per-bout walkout times).
      gameDate: ev.gameDate, gameTime: fight.eventDate ?? null,
      truePct: null, edge: null, dataConfidence: null, dcQualified: false, qualified: false,
      modelFree: true,
      fighterA: fight.names[0], fighterB: fight.names[1],
      eventCodes: ev.codeSegment,
    };

    for (const s of ev.sides) {
      const n = s.threshold;
      if (!(n >= 2)) continue;
      const sideBase = { ...base, threshold: n, kalshiVolume: s.kalshiVolume ?? null, kalshiTicker: s._ticker ?? null };
      // YES / "ends before round N" — gated on the YES price.
      if (inWindow(s.yesPct)) {
        fightPlays.push({ ...sideBase, direction: "over", kalshiPct: s.yesPct, noKalshiPct: s.noPct, americanOdds: s.yesAO ?? null });
      }
      // NO / "reaches round N" — gated on the NO price.
      if (inWindow(s.noPct)) {
        fightPlays.push({ ...sideBase, direction: "under", kalshiPct: s.noPct, noKalshiPct: s.yesPct, americanOdds: s.noAO ?? null });
      }
    }
  }
}
