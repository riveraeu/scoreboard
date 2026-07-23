// api/lib/tonight/soccer-advance.js
// emitSoccerAdvancePlays — World Cup knockout "to advance" (Phase 1, shadow-only).
//
// Kalshi lists two binary markets per knockout tie ("<A> advances" / "<B> advances"), grouped by
// event_ticker (e.g. KXWCADVANCE-26JUN28RSACAN-{RSA,CAN}). The parse loop in tonight.js collects
// every priced side into soccerAdvanceMarkets, each carrying the event's home/away canonical codes
// plus this side's team code + price. Here we reuse the same Elo-derived Dixon–Coles score matrix
// as the rest of soccer to get the 90' 1X2, then fold the draw mass into a "to advance" probability
// (advanceProb — the ET/penalties allocation). We emit the FAVORITE side (Kalshi YES in [67,91]).
//
// Output goes into a dedicated `soccerAdvancePlays` array (NOT the shared `plays` array) so these
// rows bypass prop/total dedup, the gameTime filter, and the frontend card builder. tonight.js
// merges soccerAdvancePlays into the shadow:staging payload only — shadow logs them, the client
// never sees them. `soccer|advance` is not in the category gate, so they're shadow-only.

// Shadow-only: the window is purely a capture selector (no dropped fallback), so use the wide
// CAPTURE band so calibration sees the full favorite curve. Betting is gated later (category gate).
import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import {
  getEloIndex, eloForTeam, lambdasFromElo, buildScoreMatrix, prob1x2, advanceProb, WC_TEAMS,
  getWcSchedule,
} from "../soccer.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;
const round1 = (x) => parseFloat(x.toFixed(1));

export async function emitSoccerAdvancePlays(ctx) {
  const { soccerAdvanceMarkets, soccerAdvancePlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!soccerAdvanceMarkets || soccerAdvanceMarkets.length === 0) return;

  const eloIndex = await getEloIndex({ cache, isBustCache });
  if (!eloIndex) {
    if (isDebug) dropped.push({ sport: "soccer", stat: "advance", reason: "no_elo_index" });
    return;
  }

  // Real gameTime for computeMakerQuote's pre-game gate (missed by the 2026-07-23 batch fix
  // that covered the other 7 Phase-1 modules — found later the same day). Same idiom as
  // soccer.js's emitSoccerPlays: fetch each distinct date's schedule once, not once per tie.
  const dateStrs = [...new Set(soccerAdvanceMarkets.map(m => (m.gameDate || "").replace(/-/g, "")).filter(Boolean))];
  const schedulesByDate = new Map();
  await Promise.all(dateStrs.map(async (dateStr) => {
    schedulesByDate.set(dateStr, await getWcSchedule({ dateStr, cache, isBustCache }));
  }));

  // One matrix per event serves both sides of the tie.
  const matrixCache = new Map(); // eventTicker → { p1x2, homeCode, awayCode } | null
  const getEvent = (m) => {
    if (matrixCache.has(m.eventTicker)) return matrixCache.get(m.eventTicker);
    const eloHome = eloForTeam(eloIndex, m.homeCode);
    const eloAway = eloForTeam(eloIndex, m.awayCode);
    if (eloHome == null || eloAway == null) {
      if (isDebug) dropped.push({ sport: "soccer", stat: "advance", reason: "no_elo", eventTicker: m.eventTicker, homeCode: m.homeCode, awayCode: m.awayCode });
      matrixCache.set(m.eventTicker, null);
      return null;
    }
    const { lambdaHome, lambdaAway } = lambdasFromElo(eloHome, eloAway);
    const p1x2 = prob1x2(buildScoreMatrix(lambdaHome, lambdaAway));
    const e = { p1x2, eloHome, eloAway, lambdaHome, lambdaAway };
    matrixCache.set(m.eventTicker, e);
    return e;
  };

  for (const m of soccerAdvanceMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // tie already past cutoff day
    if (!inWindow(m.kalshiPct)) continue; // quote-sanity only (full-curve capture 2026-07-03) — both mirror sides log
    const ev = getEvent(m);
    if (!ev) continue;
    // This side's regulation win / loss against the shared draw mass.
    const isHome = m.sideCode === m.homeCode;
    const pWin = isHome ? ev.p1x2.home : ev.p1x2.away;
    const pLoss = isHome ? ev.p1x2.away : ev.p1x2.home;
    const pDraw = ev.p1x2.draw;
    const truePct = round1(advanceProb(pWin, pDraw, pLoss) * 100);
    const edge = round1(truePct - m.kalshiPct);
    const dateStr = (m.gameDate || "").replace(/-/g, "");
    const schedGame = dateStr ? schedulesByDate.get(dateStr)?.[[m.homeCode, m.awayCode].sort().join("|")] : null;
    soccerAdvancePlays.push({
      sport: "soccer", stat: "advance",
      // Both codes land in homeTeam/awayTeam so the resolver's NOT NULL filter selects these rows;
      // pickTeam carries the side we bet to advance.
      homeTeam: m.homeCode, awayTeam: m.awayCode, pickTeam: m.sideCode,
      homeName: WC_TEAMS[m.homeCode]?.name ?? null, awayName: WC_TEAMS[m.awayCode]?.name ?? null,
      pickName: WC_TEAMS[m.sideCode]?.name ?? null,
      threshold: null, direction: null,
      truePct, kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct ?? null,
      americanOdds: m.americanOdds ?? null, edge,
      dataConfidence: 10, dcQualified: true, qualified: true,
      gameDate: m.gameDate, gameTime: schedGame?.gameTime ?? null, modelVersion: "soccer-adv-v1",
      // feature fields (→ features JSON) for later analysis.
      eloHome: ev.eloHome, eloAway: ev.eloAway,
      lambdaHome: round1(ev.lambdaHome), lambdaAway: round1(ev.lambdaAway),
      pWin90: round1(pWin * 100), pDraw90: round1(pDraw * 100),
      kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
    });
  }
}
