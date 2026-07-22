// api/lib/polymarket.js — Polymarket (Gamma API) cross-venue price feed. Phase 1a, 2026-06-23.
//
// PURPOSE: a read-only price OBSERVATORY. Fetches Polymarket game prices for the leagues we
// already model on Kalshi (MLB/NBA/NHL/WNBA), normalizes them, and hands them to
// tonight/polymarket-deltas.js which compares them to our Kalshi prices. The whole point is the
// kill-gate question: "do the two venues actually price the same games differently?" If deltas
// are ~0, the expansion is moot. Shadow-only — these prices NEVER reach the client response.
//
// Public Gamma API, no auth (gamma-api.polymarket.com). The US-regulated entity (QCX) may price
// differently from this global feed — that gap is itself something the observatory measures, and
// is the reason Phase 1b/trading stays deferred (see CLAUDE.md / project_polymarket_phase1a).
//
// Data shape learned live 2026-06-23:
//   - GET /events?series_id=<id>&closed=false&limit=100 returns a now-centered window of events.
//   - A *game* event's ticker is `<sport>-<away>-<home>-YYYY-MM-DD` (abbrs ≈ canonical lowercased;
//     ordering is "away"-first). Suffixed tickers (-player-props, -first-five-winner, …) and
//     non-game futures are filtered out by the strict ticker regex.
//   - Each event carries markets[]; `sportsMarketType` ∈ {moneyline, totals, spreads, nrfi, …}.
//     `outcomes`/`outcomePrices`/`clobTokenIds` are JSON STRINGS (must be parsed).
//       moneyline: outcomes [awayName, homeName], prices [pAway, pHome] (0–1), line null.
//       totals:    sportsMarketType "totals", line = O/U number, outcomes ["Over","Under"].
//     Untraded placeholder markets show ["0.5","0.5"] with bestBid≤0.02/bestAsk≥0.98 — skipped.

import { POLY_TO_CANON } from "./teams.js";
import { PT_FMT } from "./pt.js";

const GAMMA = "https://gamma-api.polymarket.com";

// Sport → Polymarket Gamma series id (from GET /sports, 2026-06-23). Written generically for all
// four leagues; only the in-season ones produce events, so off-season leagues are free no-ops.
export const POLY_SERIES = { mlb: "3", nba: "10345", nhl: "10346", wnba: "10105" };

// Gamma sport slugs vetted-and-rejected for the observatory. The polymarket-scan cron reconciles
// these to status='dismissed' in polymarket_sports_seen, so triaged noise clears on a code change
// instead of a manual ?dismiss= curl (mirror of series-config.js DISMISSED_SERIES).
export const POLY_DISMISSED_SPORTS = [
  // 7/21 triage (13 detected, all 0 live except ttelite=1): niche low-signal leagues (Czech/
  // Moldova/Ukraine "Setka Cup" table-tennis family, USL Championship, a handful of unclear thin
  // slugs) — none overlap sports/leagues we model, and Polymarket has been observatory-only since
  // the 7/04 kill (no active build target). DISMISS all.
  "chfa", "czechligapro", "pol", "sclc", "setkamecz", "setkamemd", "setkameua", "setkawoua",
  "sui", "ttchallenger", "ttcup", "ttelite", "uslc",
  // 7/22 triage (3 detected): cricket (The Hundred, men's + women's) and cycling (Tour de France
  // margin of victory) — no rating/model source in our stack (same class as the Kalshi-side
  // KXCLUBFGAME/cycling dismissals), and Polymarket is observatory-only since the 7/04 kill
  // regardless. DISMISS all.
  "crichundred", "crichundredw", "cycling",
];

// Gamma league catalog (GET /sports): ~300 rows of { sport: slug, series: id, tags, ... }. The
// discovery unit for /api/polymarket-scan — a new row = Polymarket added a league. Failure-closed.
export async function fetchPolySportsCatalog() {
  try {
    const res = await fetch(`${GAMMA}/sports`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? j.filter((s) => s && s.sport) : [];
  } catch { return []; }
}

// A real two-sided market (not an untraded 0.5/0.5 placeholder). bestBid/bestAsk describe the
// first outcome's token; degenerate book = no price discovery yet.
function _liquid(m) {
  const b = Number(m?.bestBid), a = Number(m?.bestAsk);
  if (!isFinite(b) || !isFinite(a)) return false;
  return b > 0.02 && a < 0.98;
}

function _parseArr(s) {
  if (Array.isArray(s)) return s;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Parse a game event ticker → { sport, awayPoly, homePoly, dateStr } or null. The strict shape
// (exactly two abbr segments + an ISO date, no suffix) rejects props/first-five/futures tickers.
export function parseGameTicker(ticker) {
  const m = /^(mlb|nba|nhl|wnba)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})$/.exec(String(ticker || ""));
  if (!m) return null;
  return { sport: m[1], awayPoly: m[2], homePoly: m[3], dateStr: m[4] };
}

// Map a Polymarket abbr → our canonical (POLY_TO_CANON), or null when unknown (no false match).
export function normPolyTeam(sport, abbr) {
  return POLY_TO_CANON[sport]?.[String(abbr || "").toLowerCase()] ?? null;
}

// Gamma `gameStartTime` ("2026-07-01 23:40:00+00" or ISO) → epoch ms, or null. The event-level
// `startDate` is market CREATION time — useless as a game clock; the real one rides on markets[].
function _gameStartMs(event) {
  const gst = (event?.markets || []).find((m) => m?.gameStartTime)?.gameStartTime;
  if (!gst) return null;
  const t = Date.parse(String(gst).replace(" ", "T").replace(/\+00$/, "Z"));
  return Number.isFinite(t) ? t : null;
}

// Pure normalize: raw Gamma event → { sport, away, home, gameDate, ml:{away,home}, totals:[{line,
// over,under}] } or null. Requires a parseable game ticker, both teams canon-resolvable, and a
// LIVE moneyline market. Exported for tests (no HTTP).
// gameDate: PT date of markets[].gameStartTime when present (also fixes POSTPONED games, whose
// ticker keeps the original date); already-commenced games are dropped — Poly trades in-play, and
// a live price is not a pre-game reference (same artifact class as sportsbook-deltas, 2026-07-01).
// No gameStartTime → fall back to the ticker date (observed = the local game date, NOT UTC).
export function normalizeEvent(event, nowMs = Date.now()) {
  const tk = parseGameTicker(event?.ticker);
  if (!tk) return null;
  const away = normPolyTeam(tk.sport, tk.awayPoly);
  const home = normPolyTeam(tk.sport, tk.homePoly);
  if (!away || !home) return null;
  const startMs = _gameStartMs(event);
  if (startMs != null && startMs <= nowMs) return null; // in-play or finished — live odds, skip
  const gameDate = startMs != null ? PT_FMT.format(new Date(startMs)) : tk.dateStr;

  let ml = null;
  let mlTokens = null;
  const totalsByLine = {};
  for (const mkt of (event?.markets || [])) {
    if (mkt?.closed || mkt?.active === false || !_liquid(mkt)) continue;
    const type = mkt.sportsMarketType;
    const prices = _parseArr(mkt.outcomePrices).map(Number);
    if (type === "moneyline") {
      // outcomes/prices/tokens are [away, home] per the away-first ordering.
      if (prices.length === 2 && prices.every(isFinite)) {
        ml = { away: prices[0], home: prices[1] };
        const toks = _parseArr(mkt.clobTokenIds).map(String);
        if (toks.length === 2) mlTokens = { away: toks[0], home: toks[1] };
      }
    } else if (type === "totals") {
      const outcomes = _parseArr(mkt.outcomes).map(String);
      const line = Number(mkt.line);
      if (isFinite(line) && prices.length === 2 && prices.every(isFinite) && /over/i.test(outcomes[0] || "")) {
        totalsByLine[line] = { line, over: prices[0], under: prices[1] };
      }
    }
  }
  if (!ml) return null; // no live moneyline → nothing to compare; skip the game
  return { sport: tk.sport, away, home, gameDate, ml, mlTokens, totals: Object.values(totalsByLine) };
}

// Raw open events for one Gamma series id. Returns null on fetch failure (vs [] for a live-but-
// empty league) so the scan's enrichment can skip the write instead of stamping a fake zero.
export async function fetchPolySeriesEvents(series, limit = 100) {
  try {
    const res = await fetch(`${GAMMA}/events?series_id=${series}&closed=false&limit=${limit}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j) ? j : null;
  } catch { return null; }
}

const _ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

// Fetch + normalize Polymarket games for all modeled leagues, windowed to [today−1, today+2] (UTC,
// to span the tonight games whose Poly ticker date is the UTC rollover). KV-cached 120s (prices
// move; the observatory only needs a fresh-ish snapshot per request). Failure-closed → []. Returns
// a flat array of normalized games across leagues.
export async function fetchPolymarketGames({ cache, isBustCache, now = new Date() } = {}) {
  const KEY = "polymarket:games";
  if (cache && !isBustCache) {
    try { const hit = await cache.get(KEY); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const today = _ymd(now);
  const lo = _ymd(new Date(now.getTime() - 86400000));
  const hi = _ymd(new Date(now.getTime() + 2 * 86400000));
  const inWindow = (d) => d >= lo && d <= hi;

  const leagues = Object.entries(POLY_SERIES);
  const lists = await Promise.all(leagues.map(([, series]) => fetchPolySeriesEvents(series)));
  const games = [];
  for (const list of lists) {
    for (const ev of (list || [])) {
      const g = normalizeEvent(ev, now.getTime());
      if (g && inWindow(g.gameDate)) games.push(g);
    }
  }
  if (cache && games.length) {
    try { await cache.put(KEY, JSON.stringify(games), { expirationTtl: 120 }); } catch {}
  }
  return games;
}
