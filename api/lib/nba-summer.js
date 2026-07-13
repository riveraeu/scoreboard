// api/lib/nba-summer.js
// NBA Summer League (Las Vegas) data + model — Phase 1: within-tournament Elo for the binary
// game-winner market (KXNBASUMMERGAME). Shadow-only — `nbasl|ml` is intentionally NOT in the
// category gate.
//
// The single Phase-1 knob is a per-team Elo built ONLY from this tournament's completed games:
// every team starts at SL_ELO_BASE (SL rosters are rookie/two-way/G-League players, so regular-
// season NBA ratings don't transfer and no off-the-shelf SL rating exists — first meetings emit
// ~50%, an honest parity prior), updated with a high K so ~5 games of results move the rating
// meaningfully. P(A beats B) is the standard Elo logistic. K is PROVISIONAL — anchored to
// fast-adaptation intuition, NOT fit to Kalshi prices (fitting to market would launder the
// market's edge into the model). Phase 2 = roster-aggregate draft capital as a pre-tournament
// prior. Annual cadence: the tournament runs ~11 days each July (2026: Jul 10–19 PT), so the
// category accrues ~130 both-side rows per year toward the n≥200 window bar.
//
// Data source — ESPN Summer League scoreboard (no auth, market-independent):
//   site.api.espn.com/apis/site/v2/sports/basketball/nba-summer-las-vegas/scoreboard
//   ?dates=YYYYMMDD-YYYYMMDD — SL "teams" are NBA franchises, abbreviated with ESPN scoreboard
//   abbrs (NO, PHX, …) → mapped to canonical via the inverse of CANONICAL_TO_ESPN.nba.

import { CANONICAL_TO_ESPN } from "./teams.js";

export const SL_ELO_BASE = 1500;
export const SL_ELO_K = 64; // high-K fast adaptation over a ~5-game sample. PROVISIONAL.
// Rating-build lookback (days). Covers the full ~11-day Vegas tournament with margin; keeps the
// build self-scoping to the current tournament next July with no hardcoded dates.
export const SL_LOOKBACK_DAYS = 16;

const SL_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba-summer-las-vegas/scoreboard";

// ESPN SL scoreboard abbr → canonical NBA abbr (NO→NOP, GS→GSW, …). Identity when unmapped.
const _ESPN_TO_CANON = Object.fromEntries(
  Object.entries(CANONICAL_TO_ESPN.nba || {}).map(([canon, espn]) => [espn, canon])
);
export const slCanonTeam = (abbr) => _ESPN_TO_CANON[abbr] || abbr;

// P(A beats B) — standard Elo logistic.
export function slWinProb(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

// One Elo pass over chronologically-ordered completed games. Pure (testable without HTTP).
// games: [{ winner, loser }] canonical abbrs. Returns { ABBR: { rating, games } }.
export function buildSlEloFrom(games) {
  const ratings = {};
  const rec = (t) => (ratings[t] ??= { rating: SL_ELO_BASE, games: 0 });
  for (const g of (games || [])) {
    if (!g?.winner || !g?.loser) continue;
    const w = rec(g.winner), l = rec(g.loser);
    const pWin = slWinProb(w.rating, l.rating);
    w.rating = +(w.rating + SL_ELO_K * (1 - pWin)).toFixed(1);
    l.rating = +(l.rating - SL_ELO_K * (1 - pWin)).toFixed(1);
    w.games++; l.games++;
  }
  return ratings;
}

// Look up a team's Elo record. Unplayed teams get the parity base — that's the model's honest
// pre-tournament prior, not a data failure, so there is no no_rating drop path.
export function lookupSlElo(ratings, team) {
  return ratings?.[team] || { rating: SL_ELO_BASE, games: 0 };
}

const _ptDate = (iso) => {
  try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
  catch { return null; }
};
const _ymd = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }).replace(/-/g, "");

async function _slScoreboard(datesParam) {
  try {
    const res = await fetch(`${SL_SCOREBOARD}?dates=${datesParam}&limit=100`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return (await res.json())?.events || [];
  } catch { return []; }
}

// Completed games from a list of ESPN events → [{ date (PT), home, away, homeScore, awayScore,
// winner, loser }] chronological, canonical abbrs. Pure given events; exported for tests.
export function parseSlEvents(events) {
  const out = [];
  for (const ev of (events || [])) {
    const comp = ev?.competitions?.[0];
    if (!comp?.status?.type?.completed) continue;
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    const hAbbr = slCanonTeam(home?.team?.abbreviation || "");
    const aAbbr = slCanonTeam(away?.team?.abbreviation || "");
    const hs = Number(home?.score), as = Number(away?.score);
    if (!hAbbr || !aAbbr || !(hs >= 0) || !(as >= 0) || hs === as) continue;
    out.push({
      date: _ptDate(ev.date), home: hAbbr, away: aAbbr, homeScore: hs, awayScore: as,
      winner: hs > as ? hAbbr : aAbbr, loser: hs > as ? aAbbr : hAbbr,
    });
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// Build the tournament Elo index from the trailing SL_LOOKBACK_DAYS of completed games.
// Returns { ratings, gamesUsed } (KV-serializable) — never null: an empty scoreboard yields
// all-parity ratings, which is the correct day-one state (failure-closed to the prior).
export async function buildSlElo({ now = new Date() } = {}) {
  const start = new Date(now.getTime() - SL_LOOKBACK_DAYS * 86400_000);
  const games = parseSlEvents(await _slScoreboard(`${_ymd(start)}-${_ymd(now)}`));
  return { ratings: buildSlEloFrom(games), gamesUsed: games.length };
}

// Fetch + KV-cache the Elo index (1h TTL; ratings move as the day's games complete).
export async function getSlEloIndex({ cache, isBustCache } = {}) {
  const key = "nbasl:elo";
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const index = await buildSlElo();
  if (cache && index) {
    try { await cache.put(key, JSON.stringify(index), { expirationTtl: 3600 }); } catch {}
  }
  return index;
}

// ── Resolution ──────────────────────────────────────────────────────────────
// Completed SL games on a PT date (dateStr YYYYMMDD), keyed by sorted canonical pair "A|B"
// (Kalshi ticker order ≠ ESPN home/away, so the pair key is order-independent). Fetches a
// 2-day UTC window so evening games that roll past midnight UTC still land on their PT date.
export async function fetchSlResults(dateStr) {
  if (!dateStr || dateStr.length !== 8) return {};
  const target = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  const next = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8) + 1));
  const nextYmd = `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, "0")}${String(next.getUTCDate()).padStart(2, "0")}`;
  const games = parseSlEvents(await _slScoreboard(`${dateStr}-${nextYmd}`));
  const out = {};
  for (const g of games) {
    if (g.date !== target) continue;
    out[[g.home, g.away].sort().join("|")] = g;
  }
  return out;
}
