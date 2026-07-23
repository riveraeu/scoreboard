// api/lib/lmb.js
// Liga Mexicana de Béisbol (LMB) data + model — Phase 1: Pythag/run-diff λ for the binary
// game-winner market (KXLMBGAME). Shadow-only — `lmb|ml` is intentionally NOT in the
// category gate.
//
// Adopted 2026-07-15, reversing the 7/01 dismissal: the Kalshi books proved REAL on recheck
// (game-day sides with ~600-contract volume, multi-level resting depth, 1–18¢ spreads vs the
// 7/01 state of 1¢ placeholder bids / ~98¢ spreads / zero volume everywhere). The model end
// was green at the original vet: MLB statsapi covers the league (sportId 23 / leagueId 125)
// with the same schedule/standings surface the MLB stack already uses.
//
// The single Phase-1 knob is a per-team run-rate pair from the season standings: each team's
// runs scored/game and runs allowed/game (~70 games in by July, so no shrinkage). A game's
// per-team λ blends offense vs the opponent's defense — λ_team = (team RS/G + opp RA/G) / 2 —
// and the pair feeds the existing simulateMLBJoint NegBin joint → P(team wins). Team-aggregate
// by construction (no LMB Statcast), consistent with the team-aggregate-fallback doctrine.
// No home-field term: Kalshi ticker order ≠ true home/away and Phase 1 stays symmetric.
//
// Identity: everything is keyed by statsapi team id via LMB_ID_TO_ABBR (teams.js registry) —
// no name matching anywhere, which sidesteps the statsapi↔Kalshi name drift (Acereros del
// Norte/de Monclova, Tecos/Tecolotes).

import { LMB_ID_TO_ABBR } from "./teams.js";

export const LMB_LEAGUE_ID = 125; // statsapi "Mexican League"
export const LMB_SPORT_ID = 23;   // statsapi independent-league sport bucket (LMB + others → filter by team id)

const STATSAPI = "https://statsapi.mlb.com/api/v1";

// Per-game λ pair for pick vs opponent. rates = { ABBR: { rsPg, raPg, games } }.
// Returns null when either team is missing (failure-closed — emit nothing).
export function lmbLambdas(rates, pickAbbr, oppAbbr) {
  const p = rates?.[pickAbbr], o = rates?.[oppAbbr];
  if (!p || !o || !(p.rsPg > 0) || !(o.rsPg > 0)) return null;
  return {
    lamPick: (p.rsPg + o.raPg) / 2,
    lamOpp: (o.rsPg + p.raPg) / 2,
  };
}

// Season standings → { ABBR: { rsPg, raPg, games } }. Returns null on any fetch/shape
// failure (failure-closed: no rates → no LMB rows this run, never a throw into the parse loop).
export async function buildLmbRates({ season = new Date().getFullYear() } = {}) {
  try {
    const res = await fetch(`${STATSAPI}/standings?leagueId=${LMB_LEAGUE_ID}&season=${season}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rates = {};
    for (const rec of data?.records || []) {
      for (const tr of rec?.teamRecords || []) {
        const abbr = LMB_ID_TO_ABBR[tr?.team?.id];
        const g = Number(tr?.gamesPlayed);
        if (!abbr || !(g > 0)) continue;
        rates[abbr] = {
          rsPg: +(Number(tr.runsScored) / g).toFixed(3),
          raPg: +(Number(tr.runsAllowed) / g).toFixed(3),
          games: g,
        };
      }
    }
    return Object.keys(rates).length ? rates : null;
  } catch { return null; }
}

// Fetch + KV-cache the rates index (1h TTL; standings move once a day but the cron cadence
// is minutes). Same idiom as getSlEloIndex. Null result is NOT cached (retry next run).
export async function getLmbRatesIndex({ cache, isBustCache } = {}) {
  const key = "lmb:rates";
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const rates = await buildLmbRates();
  if (cache && rates) {
    try { await cache.put(key, JSON.stringify(rates), { expirationTtl: 3600 }); } catch {}
  }
  return rates;
}

// ── Resolution ──────────────────────────────────────────────────────────────
// Completed LMB games on a date (dateStr YYYYMMDD), keyed by sorted canonical pair "A|B"
// (Kalshi ticker order ≠ statsapi home/away, so the pair key is order-independent). The
// statsapi official game date matches the Kalshi ticker date (evening games that roll past
// midnight UTC keep their official date), so a single-date query aligns with row.game_date.
//
// Doubleheader guard: two finals on one pair+date with DIFFERENT winners are irreconcilable
// from a pair-keyed row (the Kalshi ticker time segment isn't stored on the row), so the pair
// is dropped — the row stays unresolved (failure-closed) rather than coin-flipped. A swept DH
// (same winner twice) resolves normally.
export function parseLmbSchedule(games, target) {
  const out = {};
  const conflicted = new Set();
  for (const g of games || []) {
    const homeId = g?.teams?.home?.team?.id, awayId = g?.teams?.away?.team?.id;
    const home = LMB_ID_TO_ABBR[homeId], away = LMB_ID_TO_ABBR[awayId];
    if (!home || !away) continue; // sportId 23 carries other independent leagues — LMB ids only
    if (g?.status?.abstractGameState !== "Final") continue;
    const detail = g?.status?.detailedState || "";
    if (!/^(Final|Completed)/.test(detail)) continue; // excludes Postponed/Cancelled terminal states
    const hs = Number(g?.teams?.home?.score), as = Number(g?.teams?.away?.score);
    if (!(hs >= 0) || !(as >= 0) || hs === as) continue;
    const rec = {
      date: target, home, away, homeScore: hs, awayScore: as,
      winner: hs > as ? home : away, loser: hs > as ? away : home,
    };
    const key = [home, away].sort().join("|");
    if (out[key]) {
      if (out[key].winner !== rec.winner) conflicted.add(key); // split DH — unresolvable by pair
      continue; // swept DH: first final stands
    }
    out[key] = rec;
  }
  for (const key of conflicted) delete out[key];
  return out;
}

export async function fetchLmbResults(dateStr) {
  if (!dateStr || dateStr.length !== 8) return {};
  const target = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  try {
    const res = await fetch(`${STATSAPI}/schedule?sportId=${LMB_SPORT_ID}&date=${target}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const games = (data?.dates || []).flatMap(d => d?.games || []);
    return parseLmbSchedule(games, target);
  } catch { return {}; }
}

// ── Schedule (any status, for a real gameTime) ───────────────────────────────
// statsapi's own `gameDate` is a real ISO UTC timestamp on EVERY game, scheduled or final —
// unlike fetchLmbResults/parseLmbSchedule above, which only keeps `Final` games for grading.
// Found 2026-07-23: computeMakerQuote (maker.js) requires a real future stagingRow.gameTime,
// but the emit path was hardcoding gameTime:null despite this data being one field away.
// Doubleheader simplification: first game found for a pair wins (same "unresolvable by pair"
// class as the resolver's DH handling above) — good enough for a pre-game eligibility gate,
// not exact-precision; if the market is actually game 2, the gate still correctly reads "pre-game."
export function parseLmbScheduleAny(games, target) {
  const out = {};
  for (const g of games || []) {
    const homeId = g?.teams?.home?.team?.id, awayId = g?.teams?.away?.team?.id;
    const home = LMB_ID_TO_ABBR[homeId], away = LMB_ID_TO_ABBR[awayId];
    if (!home || !away) continue;
    const key = [home, away].sort().join("|");
    if (out[key]) continue; // doubleheader: first game's time stands
    out[key] = { date: target, home, away, gameTime: g?.gameDate || null };
  }
  return out;
}

export async function fetchLmbSchedule(dateStr) {
  if (!dateStr || dateStr.length !== 8) return {};
  const target = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  try {
    const res = await fetch(`${STATSAPI}/schedule?sportId=${LMB_SPORT_ID}&date=${target}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const games = (data?.dates || []).flatMap(d => d?.games || []);
    return parseLmbScheduleAny(games, target);
  } catch { return {}; }
}

// Fetch + KV-cache one date's schedule (30min TTL — same idiom as mls.js's getMlsSchedule).
export async function getLmbSchedule({ dateStr, cache, isBustCache } = {}) {
  if (!dateStr) return {};
  const key = `lmb:schedule:${dateStr}`;
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const schedule = await fetchLmbSchedule(dateStr);
  if (cache && schedule) {
    try { await cache.put(key, JSON.stringify(schedule), { expirationTtl: 1800 }); } catch {}
  }
  return schedule;
}
