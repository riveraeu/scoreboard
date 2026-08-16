// api/lib/tonight/atp-total.js
// emitAtpTotalPlays — ATP total-games-in-a-match threshold market (KXATPGTOTAL), model-free maker.
//
// Kalshi lists no player identity on this series at all (yes_sub_title is just "Over 18.5 games",
// subtitle is null) — the market carries only a threshold. The sibling series KXATPMATCH (already
// built, see tonight/tennis-match.js) covers the SAME matches and shares the SAME event-ticker
// segment (date + 6-char match code, e.g. both "KXATPGTOTAL-26AUG16WALBUS" and
// "KXATPMATCH-26AUG16WALBUS" cover Walton vs Buse — verified live 2026-08-16). Identity and
// gameTime are both borrowed from tennisMatchMarkets (the already-parsed KXATPMATCH rows) by
// matching on that shared segment, rather than fetching or parsing anything new — the same
// getTennisSchedule/normTennisName helpers tennis-match.js already uses.
//
// Consequence worth naming: a match only gets total-games rows if KXATPMATCH ALSO has both sides
// quoted in the same pull cycle (need both player names for the schedule pair-key lookup). ATP
// moneyline markets are liquid whenever a match is listed, so this should rarely bind, but a
// match with only one live ML side that cycle will drop its total-games rows too (reason
// "no_opponent", same as tennis-match.js's own gate for exactly the same reason).
//
// Follows soccer.js's WC OVER/UNDER row convention: kalshiPct always the YES/OVER ask,
// noKalshiPct always the NO/UNDER ask; truePct/edge stay null (no model). Output goes into a
// dedicated `atpTotalPlays` array (NOT the shared `plays` array), merged into shadow:staging only
// — same idiom as tennisPlays/fightPlays/etc.

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { normTennisName, getTennisSchedule } from "../tennis-schedule.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;

export async function emitAtpTotalPlays(ctx) {
  const { atpTotalMarkets, tennisMatchMarkets, atpTotalPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!atpTotalMarkets || atpTotalMarkets.length === 0) return;

  // Segment -> { tour, gameDate, players[] } from the already-parsed KXATPMATCH rows. A segment
  // can carry 1 or 2 player entries depending on how many sides had a live book that cycle.
  const segmentToInfo = new Map();
  for (const m of (tennisMatchMarkets || [])) {
    if (m.tour !== "atp") continue;
    const segment = (m.eventTicker || "").split("-")[1] || "";
    if (!segment) continue;
    if (!segmentToInfo.has(segment)) segmentToInfo.set(segment, { gameDate: m.gameDate, players: [] });
    const info = segmentToInfo.get(segment);
    if (m.player && !info.players.includes(m.player)) info.players.push(m.player);
  }

  // One schedule fetch per distinct date (same 30min-cached ESPN lookup tennis-match.js uses).
  const dates = [...new Set(atpTotalMarkets.map((m) => (m.gameDate || "").replace(/-/g, "")))].filter(Boolean);
  const schedulesByDate = new Map();
  await Promise.all(dates.map(async (dateStr) => {
    schedulesByDate.set(dateStr, await getTennisSchedule("atp", dateStr, { cache, isBustCache }));
  }));

  for (const m of atpTotalMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // stale (day already past cutoff)
    const info = segmentToInfo.get(m.segment);
    if (!info || info.players.length < 2) {
      if (isDebug) dropped.push({ sport: "tennis", stat: "totalGames", threshold: m.threshold, reason: "no_opponent", eventTicker: m.eventTicker });
      continue;
    }
    const [p1, p2] = info.players;
    const dateStr = (m.gameDate || "").replace(/-/g, "");
    const pairKey = [normTennisName(p1), normTennisName(p2)].sort().join("|");
    const gameTime = schedulesByDate.get(dateStr)?.[pairKey]?.gameTime ?? null;

    const base = {
      sport: "tennis", stat: "totalGames", gameType: "atpGameTotal",
      modelVersion: "tennis-modelfree-v1",
      homeTeam: p1, awayTeam: p2, pickTeam: null,
      threshold: m.threshold, line: m.threshold,
      truePct: null, dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
      gameDate: m.gameDate, gameTime, eventTicker: m.eventTicker, tour: "atp",
      kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
    };
    if (inWindow(m.kalshiPct)) {
      atpTotalPlays.push({ ...base, direction: "over", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, americanOdds: m.americanOdds ?? null, edge: null });
    }
    if (inWindow(m.noKalshiPct)) {
      atpTotalPlays.push({ ...base, direction: "under", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, americanOdds: m.noAmericanOdds ?? null, edge: null });
    }
  }
}
