// api/lib/tonight/club-soccer-threshold.js
// emitClubSoccerThresholdPlays — MLS + Liga MX 1H spread/total/BTTS + full-game team-total
// (adopted 2026-07-23), plus Argentina Liga Profesional's full-game spread/total/BTTS (added
// 2026-07-24, no `half` tag — see project_baseline_backlog_2026_07_24 memory). Phase 1,
// model-free. One shared array + module across all three leagues (sport-tagged per row) —
// unlike the shared GAME-winner module (model-free-ml.js, one path for all six leagues),
// team identity here needs no subtitle-based disambiguation (none of MLS/LigaMX/Argentina have
// scocup's kind of Kalshi-abbr collision), so there's no forcing reason to keep them in
// separate files. `half` is null for Argentina's full-game markets, same as the existing
// full-game `teamTotal` entries.
//
// Follows soccer.js's WC OVER/UNDER row convention: kalshiPct always the YES/OVER ask,
// noKalshiPct always the NO/UNDER ask; truePct/edge stay null (no model). dcQualified/qualified
// are false — maker-only, never taker-bettable, same as every model-free module.
//
// Output goes into a dedicated `clubSoccerThresholdPlays` array (NOT the shared `plays` array),
// merged into shadow:staging only. `mls|*`/`ligamx|*`/`argprem|*` threshold stats are not in the
// category gate (same as the base ML families).

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getMlsSchedule } from "../mls.js";
import { getLigaMxSchedule } from "../ligamx.js";
import { getArgPremSchedule } from "../argprem.js";
import { leagueSource } from "../model-free-leagues.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;
// copadobrasil (full-game total/spread, added 2026-08-05) has no per-league shim file — its ML path
// runs straight off the MODEL_FREE_LEAGUES registry, so pull its ESPN schedule from the same source
// (identical getSchedule signature) rather than adding a shim just to feed this one entry.
const SCHEDULE_BY_SPORT = {
  mls: getMlsSchedule, ligamx: getLigaMxSchedule, argprem: getArgPremSchedule,
  copadobrasil: leagueSource("copadobrasil").getSchedule,
};

export async function emitClubSoccerThresholdPlays(ctx) {
  const { clubSoccerThresholdMarkets, clubSoccerThresholdPlays, cutoffStr, cache, isBustCache } = ctx;
  if (!clubSoccerThresholdMarkets || clubSoccerThresholdMarkets.length === 0) return;

  // Group every priced row by (sport, event) so one schedule lookup serves every subtype/
  // threshold of that game (a game can carry spread + total + BTTS rows at once).
  const events = new Map();
  for (const m of clubSoccerThresholdMarkets) {
    const key = `${m.sport}|${m.eventTicker}`;
    if (!events.has(key)) events.set(key, { sport: m.sport, homeTeam: m.homeTeam, awayTeam: m.awayTeam, gameDate: m.gameDate, rows: [] });
    events.get(key).rows.push(m);
  }

  // Derived from SCHEDULE_BY_SPORT's own keys (not hardcoded) — a hardcoded copy here silently
  // dropped every date for a new sport added only to SCHEDULE_BY_SPORT (found live 2026-07-24:
  // argprem was added to SCHEDULE_BY_SPORT but this object still only had mls/ligamx, so 100% of
  // argprem's threshold rows lost gameTime — datesBySport[ev.sport] was undefined, so the `if`
  // guard below silently skipped every argprem date instead of throwing).
  const datesBySport = Object.fromEntries(Object.keys(SCHEDULE_BY_SPORT).map(sport => [sport, new Set()]));
  for (const ev of events.values()) {
    const d = (ev.gameDate || "").replace(/-/g, "");
    if (d && datesBySport[ev.sport]) datesBySport[ev.sport].add(d);
  }
  const schedulesByKey = new Map(); // `${sport}|${dateStr}` -> schedule map
  await Promise.all(Object.entries(datesBySport).flatMap(([sport, dates]) =>
    [...dates].map(async (dateStr) => {
      schedulesByKey.set(`${sport}|${dateStr}`, await SCHEDULE_BY_SPORT[sport]({ dateStr, cache, isBustCache }));
    })
  ));

  for (const ev of events.values()) {
    if (ev.gameDate && cutoffStr && ev.gameDate < cutoffStr) continue;
    const dateStr = (ev.gameDate || "").replace(/-/g, "");
    const schedule = dateStr ? schedulesByKey.get(`${ev.sport}|${dateStr}`) : null;
    const game = schedule?.[[ev.homeTeam, ev.awayTeam].sort().join("|")];
    const gameTime = game?.gameTime ?? null; // no schedule match → stays null (maker just won't quote it)

    for (const m of ev.rows) {
      const base = {
        sport: m.sport, stat: m.half ? `${m.half}${m.subtype}` : m.subtype, gameType: m.subtype, half: m.half || null,
        modelVersion: `${m.sport}-modelfree-v1`,
        homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, pickTeam: m.pickTeam,
        threshold: m.threshold, line: m.threshold,
        truePct: null, dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
        gameDate: m.gameDate, gameTime, eventTicker: m.eventTicker,
        kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
      };
      if (inWindow(m.kalshiPct)) {
        clubSoccerThresholdPlays.push({ ...base, direction: "over", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, americanOdds: m.americanOdds ?? null, edge: null });
      }
      if (inWindow(m.noKalshiPct)) {
        clubSoccerThresholdPlays.push({ ...base, direction: "under", kalshiPct: m.kalshiPct, noKalshiPct: m.noKalshiPct, americanOdds: m.noAmericanOdds ?? null, edge: null });
      }
    }
  }
}
