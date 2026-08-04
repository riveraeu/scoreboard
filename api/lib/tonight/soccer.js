// api/lib/tonight/soccer.js
// emitSoccerPlays — World Cup, all five market families off ONE Elo-derived score matrix per
// game (Phase 1, shadow-only).
//
// The parse loop in tonight.js collects every priced soccer market side into soccerMarkets,
// each tagged with: subtype (game/total/teamTotal/spread/btts), the event's home/away canonical
// codes, the per-side price, and (where relevant) a teamCode + line. Here we group by event,
// build the single Dixon–Coles Poisson matrix once from both teams' Elo, and project each
// market family off it.
//
// Output goes into a dedicated `soccerPlays` array (NOT the shared `plays` array) so soccer rows
// bypass prop/total dedup, the gameTime filter, and the frontend card builder. tonight.js merges
// soccerPlays into the shadow:staging payload only — shadow logs them, the client never sees
// them. `soccer|*` is not in the category gate, so they're shadow-only.
//
// Two-sided markets (total/teamTotal/spread/btts) follow the same OVER/UNDER convention as
// game-totals.js: truePct ALWAYS carries the YES/OVER model prob, and the UNDER row adds
// noTruePct — the shadow insert flips model_true_pct to 100−truePct for direction:"under".
// The 1X2 (game) market is a 3-way pick (direction:null), one row per in-window side.

// Shadow-only: the window is purely a capture selector (no dropped fallback), so use the wide
// CAPTURE band so calibration sees the full favorite curve. Betting is gated later (category gate).
import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import {
  getEloIndex, eloForTeam, lambdasFromElo, buildScoreMatrix,
  prob1x2, probTotalOver, probTeamOver, probSpreadCover, probBtts,
  getWcSchedule,
} from "../soccer.js";
import { WC_TEAMS } from "../soccer-wc-teams.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;
const round1 = (x) => parseFloat(x.toFixed(1));

export async function emitSoccerPlays(ctx) {
  const { soccerMarkets, soccerPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if (!soccerMarkets || soccerMarkets.length === 0) return;

  const eloIndex = await getEloIndex({ cache, isBustCache });
  if (!eloIndex) {
    if (isDebug) dropped.push({ sport: "soccer", reason: "no_elo_index" });
    return;
  }

  // Group every priced side by event so one matrix serves all of that game's markets.
  const events = new Map();
  for (const m of soccerMarkets) {
    if (!events.has(m.eventTicker)) {
      events.set(m.eventTicker, { homeCode: m.homeCode, awayCode: m.awayCode, gameDate: m.gameDate, sides: [] });
    }
    events.get(m.eventTicker).sides.push(m);
  }

  // Real gameTime for computeMakerQuote's pre-game gate (found 2026-07-23 — this module was
  // hardcoding gameTime:null despite ESPN's own ev.date being one field away). Fetch each
  // distinct date's schedule once, not once per event.
  const dateStrs = [...new Set([...events.values()].map(ev => (ev.gameDate || "").replace(/-/g, "")).filter(Boolean))];
  const schedulesByDate = new Map();
  await Promise.all(dateStrs.map(async (dateStr) => {
    schedulesByDate.set(dateStr, await getWcSchedule({ dateStr, cache, isBustCache }));
  }));

  for (const [eventTicker, ev] of events) {
    if (ev.gameDate && cutoffStr && ev.gameDate < cutoffStr) continue; // game already past cutoff day
    const eloHome = eloForTeam(eloIndex, ev.homeCode);
    const eloAway = eloForTeam(eloIndex, ev.awayCode);
    if (eloHome == null || eloAway == null) {
      if (isDebug) dropped.push({ sport: "soccer", reason: "no_elo", eventTicker, homeCode: ev.homeCode, awayCode: ev.awayCode });
      continue;
    }
    const { lambdaHome, lambdaAway } = lambdasFromElo(eloHome, eloAway);
    const M = buildScoreMatrix(lambdaHome, lambdaAway);
    const Mh = buildScoreMatrix(lambdaHome * 0.5, lambdaAway * 0.5); // half matrix (even ×0.5 split, v1) — feeds both 1H + 2H families

    const dateStr = (ev.gameDate || "").replace(/-/g, "");
    const schedGame = dateStr ? schedulesByDate.get(dateStr)?.[[ev.homeCode, ev.awayCode].sort().join("|")] : null;

    // Shared feature context stamped on every play from this event (→ features JSON).
    const base = {
      sport: "soccer", gameDate: ev.gameDate, gameTime: schedGame?.gameTime ?? null, modelVersion: "soccer-v1",
      homeTeam: ev.homeCode, awayTeam: ev.awayCode,
      homeName: WC_TEAMS[ev.homeCode]?.name ?? null, awayName: WC_TEAMS[ev.awayCode]?.name ?? null,
      eloHome, eloAway, lambdaHome: round1(lambdaHome), lambdaAway: round1(lambdaAway),
      dataConfidence: 10, dcQualified: true, qualified: true,
    };

    const p1x2 = prob1x2(M);
    const p1x2h = prob1x2(Mh);

    for (const s of ev.sides) {
      const vol = s.kalshiVolume ?? null;
      // Half markets (s.half "1h"/"2h") project off the half-scaled matrix and prefix the stat
      // (1htotal, 2hgame, …); full-game markets use the full matrix + bare family stat.
      const _isHalf = s.half === "1h" || s.half === "2h";
      const _Mx = _isHalf ? Mh : M;
      const _p1x2x = _isHalf ? p1x2h : p1x2;
      const _statOf = (fam) => _isHalf ? `${s.half}${fam}` : fam;
      if (s.subtype === "game") {
        // 1X2 — each binary side (home/away/tie) is its own market. Emit any side priced in
        // window with the model's probability for that outcome. direction:null (3-way pick).
        const pSide = s.side === "home" ? _p1x2x.home : s.side === "away" ? _p1x2x.away : _p1x2x.draw;
        const truePct = round1(pSide * 100);
        if (!inWindow(s.kalshiPct)) continue;
        const edge = round1(truePct - s.kalshiPct);
        soccerPlays.push({
          ...base, stat: _statOf("game"), gameType: "game", side: s.side,
          pickTeam: s.side === "tie" ? "TIE" : s.sideCode,
          threshold: null, direction: null,
          truePct, kalshiPct: s.kalshiPct, noKalshiPct: s.noKalshiPct ?? null,
          americanOdds: s.americanOdds ?? null, edge, kalshiVolume: vol,
          kalshiTicker: s._ticker ?? null,
        });
        continue;
      }

      // Two-sided markets — compute the YES/OVER model prob, emit the in-window side(s).
      let pOver, overSubtype = s.subtype, extra = {};
      if (s.subtype === "total") {
        pOver = probTotalOver(_Mx, s.line);
        extra = { threshold: s.line + 0.5, line: s.line };
      } else if (s.subtype === "teamTotal") {
        const isHome = s.teamCode === ev.homeCode;
        pOver = probTeamOver(_Mx, s.line, isHome);
        extra = { threshold: s.line + 0.5, line: s.line, scoringTeam: s.teamCode };
      } else if (s.subtype === "spread") {
        const favIsHome = s.teamCode === ev.homeCode;
        pOver = probSpreadCover(_Mx, s.line, favIsHome);
        extra = { threshold: s.line, line: s.line, pickTeam: s.teamCode };
      } else if (s.subtype === "btts") {
        pOver = probBtts(_Mx);
        extra = { threshold: null };
      } else {
        continue;
      }
      const overPct = round1(pOver * 100);
      const sideBase = { ...base, stat: _statOf(overSubtype), gameType: overSubtype, kalshiVolume: vol,
        kalshiTicker: s._ticker ?? null, ...extra };

      // OVER / YES side — gated on the YES price.
      if (inWindow(s.yesPct)) {
        soccerPlays.push({
          ...sideBase, direction: "over",
          truePct: overPct, kalshiPct: s.yesPct, noKalshiPct: s.noPct,
          americanOdds: s.yesAO ?? null, edge: round1(overPct - s.yesPct),
        });
      } else if (isDebug) {
        dropped.push({ ...sideBase, direction: "over", truePct: overPct, kalshiPct: s.yesPct, reason: "kalshi_out_of_window" });
      }
      // UNDER / NO side — gated on the NO price; truePct stays the OVER prob, noTruePct added.
      if (inWindow(s.noPct)) {
        soccerPlays.push({
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
