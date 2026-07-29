// api/lib/tonight/scocup.js
// emitScoCupPlays — Scottish League Cup spread + total, Phase 1, model-free (no probability
// model at all — see project_scocup_spread_total_2026_07_23 memory). Unlike the 5 model-free
// GAME-winner leagues (model-free-ml.js), this is a THRESHOLD market shape, so it
// follows soccer.js's OVER/UNDER row convention instead: kalshiPct always carries the YES/OVER
// ask, noKalshiPct always carries the NO/UNDER ask; truePct/noTruePct stay null (no model to
// compute them) and edge stays null. dcQualified/qualified are false — maker-only, never
// taker-bettable, same as every other model-free module.
//
// Team identity is resolved from each SPREAD market's subtitle text ("Dunfermline wins by more
// than 2.5 goals"), NOT from the 3-char ticker code — Kalshi reuses "DUN" for two different
// clubs across different events (see the scocup registry comment in teams.js), so an
// abbr-keyed lookup would silently mismap one of them. TOTAL markets carry no team subtitle, so
// they're joined to their SPREAD siblings via the shared date+teamcode ticker segment (identical
// across the two series, e.g. both "KXSCOCUPSPREAD-26JUL26MIRDUN" and
// "KXSCOCUPTOTAL-26JUL26MIRDUN" share segment "26JUL26MIRDUN") — an event missing its spread
// markets has no known team identity and is dropped (fail-closed).
//
// Output goes into a dedicated `scocupPlays` array (NOT the shared `plays` array), merged into
// shadow:staging only — same idiom as every other Phase-1 module. `scocup|*` is not in the
// category gate.

import { CAPTURE_GATE, CAPTURE_CAP, capturableSpread } from "../config.js";
import { SCOCUP_NAME_TO_ESPN } from "../teams.js";
import { getScoCupSchedule } from "../scocup.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;

export async function emitScoCupPlays(ctx) {
  const { scocupSpreadMarkets, scocupTotalMarkets, scocupPlays, dropped, isDebug, cutoffStr, cache, isBustCache } = ctx;
  if ((!scocupSpreadMarkets || scocupSpreadMarkets.length === 0) && (!scocupTotalMarkets || scocupTotalMarkets.length === 0)) return;

  // One event per segment: { gameDate, teams: Map<name, {abbr, side}> }. Built from spread
  // markets only — total markets have no team subtitle and just join onto this by segment.
  const events = new Map();
  for (const m of scocupSpreadMarkets || []) {
    if (!events.has(m.segment)) events.set(m.segment, { gameDate: m.gameDate, teamAbbrs: new Set() });
    const ev = events.get(m.segment);
    const abbr = SCOCUP_NAME_TO_ESPN[m.teamName];
    if (abbr) ev.teamAbbrs.add(abbr);
  }

  const dateStrs = [...new Set([...events.values()].map(ev => (ev.gameDate || "").replace(/-/g, "")).filter(Boolean))];
  const schedulesByDate = new Map();
  await Promise.all(dateStrs.map(async (dateStr) => {
    schedulesByDate.set(dateStr, await getScoCupSchedule({ dateStr, cache, isBustCache }));
  }));

  const resolveEvent = (segment) => {
    const ev = events.get(segment);
    if (!ev || ev.teamAbbrs.size !== 2) return null; // unknown name(s), or not exactly 2 teams — fail-closed
    const [homeTeam, awayTeam] = [...ev.teamAbbrs];
    const dateStr = (ev.gameDate || "").replace(/-/g, "");
    const schedGame = dateStr ? schedulesByDate.get(dateStr)?.[[homeTeam, awayTeam].sort().join("|")] : null;
    return { gameDate: ev.gameDate, homeTeam, awayTeam, gameTime: schedGame?.gameTime ?? null };
  };

  // ── Spread ── "<team> wins by more than <line> goals". over = covers (favorite's margin >
  // line); under = doesn't (draw, loss, or a margin ≤ line).
  for (const m of scocupSpreadMarkets || []) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue;
    const resolved = resolveEvent(m.segment);
    if (!resolved) { if (isDebug) dropped.push({ sport: "scocup", stat: "spread", reason: "unresolved_teams", segment: m.segment, teamName: m.teamName }); continue; }
    const pickTeam = SCOCUP_NAME_TO_ESPN[m.teamName];
    if (!pickTeam) continue;
    // Liquidity gate applied HERE, not at parse time — team identity above is derived from
    // every subtitled market regardless of its own liquidity (see the module header comment for
    // why); this row's own two-sided book still has to be real to be worth capturing.
    if (!m._stale && !capturableSpread(Math.min(m._yesSpreadC ?? 999, m._noSpreadC ?? 999))) {
      if (isDebug) dropped.push({ sport: "scocup", stat: "spread", reason: "illiquid", segment: m.segment, teamName: m.teamName });
      continue;
    }
    const base = {
      sport: "scocup", stat: "spread", gameType: "spread", modelVersion: "scocup-modelfree-v1",
      homeTeam: resolved.homeTeam, awayTeam: resolved.awayTeam, pickTeam,
      threshold: m.threshold, line: m.line,
      truePct: null, dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
      gameDate: m.gameDate, gameTime: resolved.gameTime, eventTicker: m.eventTicker,
      kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
    };
    if (inWindow(m.kalshiPct)) {
      scocupPlays.push({ ...base, direction: "over", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, americanOdds: m.americanOdds ?? null, edge: null });
    } else if (isDebug) {
      dropped.push({ ...base, direction: "over", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, reason: "kalshi_out_of_window" });
    }
    if (inWindow(m.noKalshiPct)) {
      scocupPlays.push({ ...base, direction: "under", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, americanOdds: m.noAmericanOdds ?? null, edge: null });
    } else if (isDebug) {
      dropped.push({ ...base, direction: "under", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, reason: "kalshi_out_of_window" });
    }
  }

  // ── Total ── "Over <line> goals scored". No team subtitle — joins onto its spread siblings'
  // resolved event (same segment) purely for gameDate/gameTime/home-away identity.
  for (const m of scocupTotalMarkets || []) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue;
    const resolved = resolveEvent(m.segment);
    if (!resolved) { if (isDebug) dropped.push({ sport: "scocup", stat: "total", reason: "unresolved_teams", segment: m.segment }); continue; }
    const base = {
      sport: "scocup", stat: "total", gameType: "total", modelVersion: "scocup-modelfree-v1",
      homeTeam: resolved.homeTeam, awayTeam: resolved.awayTeam, pickTeam: null,
      threshold: m.threshold, line: m.line,
      truePct: null, dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
      gameDate: m.gameDate, gameTime: resolved.gameTime, eventTicker: m.eventTicker,
      kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
    };
    if (inWindow(m.kalshiPct)) {
      scocupPlays.push({ ...base, direction: "over", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, americanOdds: m.americanOdds ?? null, edge: null });
    } else if (isDebug) {
      dropped.push({ ...base, direction: "over", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, reason: "kalshi_out_of_window" });
    }
    if (inWindow(m.noKalshiPct)) {
      scocupPlays.push({ ...base, direction: "under", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, americanOdds: m.noAmericanOdds ?? null, edge: null });
    } else if (isDebug) {
      dropped.push({ ...base, direction: "under", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, reason: "kalshi_out_of_window" });
    }
  }
}
