// api/lib/tonight/club-soccer-threshold.js
// emitClubSoccerThresholdPlays — MLS + Liga MX 1H spread/total/BTTS + full-game team-total,
// Phase 1, model-free (adopted 2026-07-23, see project_mls_ligamx_threshold_2026_07_23 memory).
// One shared array + module for both leagues (sport-tagged per row) — unlike the per-league
// GAME-winner modules (club-soccer-ml.js/ligamx-ml.js), team identity here needs no
// subtitle-based disambiguation (MLS/LigaMX have no abbr collision, see scocup.js for the
// league that does), so there was no forcing reason to keep the leagues in separate files.
//
// Follows soccer.js's WC OVER/UNDER row convention: kalshiPct always the YES/OVER ask,
// noKalshiPct always the NO/UNDER ask; truePct/edge stay null (no model). dcQualified/qualified
// are false — maker-only, never taker-bettable, same as every model-free module.
//
// Output goes into a dedicated `clubSoccerThresholdPlays` array (NOT the shared `plays` array),
// merged into shadow:staging only. `mls|*`/`ligamx|*` threshold stats are not in the category
// gate (same as the base ML families).

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getMlsSchedule } from "../mls.js";
import { getLigaMxSchedule } from "../ligamx.js";

const inWindow = (pct) => pct >= CAPTURE_GATE && pct <= CAPTURE_CAP;
const SCHEDULE_BY_SPORT = { mls: getMlsSchedule, ligamx: getLigaMxSchedule };

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

  const datesBySport = { mls: new Set(), ligamx: new Set() };
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
