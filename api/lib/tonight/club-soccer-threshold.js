// api/lib/tonight/club-soccer-threshold.js
// emitClubSoccerThresholdPlays — MLS + Liga MX 1H spread/total/BTTS + full-game team-total
// (adopted 2026-07-23), Argentina Liga Profesional's full-game spread/total/BTTS (added 2026-07-24,
// no `half` tag — see project_baseline_backlog_2026_07_24 memory), Copa do Brasil's full-game
// total/spread (added 2026-08-05, no `half` tag, same pattern as Argentina), and Dutch Eredivisie
// full-game spread + total (KXEREDIVISIESPREAD 2026-08-08, KXEREDIVISIETOTAL 2026-08-11 — the
// latter reached the vet queue by REVIVAL after an earlier pre-season auto-dismissal), and
// Leagues Cup's 1H total + full-game team-total (KXLEAGUESCUP1HTOTAL/TEAMTOTAL, added 2026-08-11 —
// the first CROSS-LEAGUE entry here, whose `leaguescup` registry is derived as mls ∪ ligamx in
// teams.js), and Eerste Divisie's full-game spread + total (KXEERSTEDIVSPREAD/TOTAL, added
// 2026-08-14, no `half` tag), and Liga MX's 2nd-half BTTS + Ligue 1's first threshold derivative
// (KXLIGAMX2HBTTS/KXLIGUE12HBTTS, both added 2026-08-28 off the discovery queue). Phase 1, model-free.
// One shared array + module across all leagues (sport-tagged per row) —
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
  eredivisie: leagueSource("eredivisie").getSchedule,
  eerstediv: leagueSource("eerstediv").getSchedule,
  laliga: leagueSource("laliga").getSchedule,
  // leaguescup added 2026-08-11 (1HTOTAL + TEAMTOTAL). Like copadobrasil it has no per-league shim
  // — its ML path runs straight off MODEL_FREE_LEAGUES, so the schedule comes from the same source.
  // **This entry is the whole reason those rows get a gameTime**: omitting it is the exact 2026-07-24
  // argprem failure, which is silent (the lookup is falsy-safe) and costs 100% of the league's
  // gameTime — and leaguescup cannot fall back to the ticker, which is date-only.
  leaguescup: leagueSource("leaguescup").getSchedule,
  // ligue1 added 2026-08-28 for KXLIGUE12HBTTS — its first threshold derivative (only GAME
  // existed before). Same argprem-omission trap as every entry above: leaving this out drops
  // 100% of ligue1 threshold rows' gameTime silently (the `datesBySport[sport]` guard is
  // falsy-safe). MODEL_FREE_LEAGUES already carries ligue1's espnSlug (fra.1, verified live).
  ligue1: leagueSource("ligue1").getSchedule,
  // efll1 added 2026-09-03 for KXEFLL1SPREAD/TOTAL/BTTS — same argprem-omission trap as every
  // entry above. MODEL_FREE_LEAGUES already carries efll1's espnSlug (eng.3, verified live for
  // the same-session KXEFLL1GAME build).
  efll1: leagueSource("efll1").getSchedule,
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
