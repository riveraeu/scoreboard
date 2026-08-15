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

// THE Polymarket capture registry — one row per league we mirror from Kalshi (2026-08-13). Single
// source for three things that used to be hardcoded in three separate places: which Gamma series
// get fetched, which sports the event-ticker regexes admit, and which `sportsMarketType`s become
// captured rows. Adding a league is one row here + a `teams.js` `polymarket` alias block (optional,
// see below); adding a market family to an existing league is one line in its `categories`.
//
//   series     — Gamma series id, the fetch key. **VERIFY IT RETURNS EVENTS BEFORE TRUSTING IT.**
//                `GET /sports`'s own `series` field is unreliable: it lists Argentina as 10285 and
//                NFL as 10187, both of which return ZERO events, while their live events carry
//                10312 and 12185. Discover the real one with `GET /events?tag_slug=<slug>` and read
//                the series id off a returned event. Do NOT switch the fetch itself to tag_slug —
//                that endpoint mixes season futures into the same limit-capped page (50+ futures
//                rows on `tag_slug=mlb`, leaving only 41 game events), so it would REDUCE coverage.
//   slug       — Gamma sport slug. Discovery/verification key only, never the fetch key. Also the
//                join to `POLY_DISMISSED_SPORTS` / `polymarket_sports_seen` — a league built here
//                must be removed from the dismissal list, which is never auto-revived.
//   categories — Poly `sportsMarketType` → our category name. The category names are shared with
//                the Kalshi side of the venue-vig comparison (`KALSHI_VENUE_CATEGORY_PREFIXES` in
//                handlers/shadow/report.js) — a category added here with no Kalshi prefix captures
//                fine but produces no Δ, which is a half-built comparison, so add both.
//
// Only in-season leagues produce events, so an off-season row is a free no-op.
export const POLY_MARKETS = {
  mlb: {
    series: "3", slug: "mlb",
    categories: {
      moneyline: "ml", totals: "total", spreads: "spread",
      // All three F5 families live under the BARE game ticker (verified live 2026-08-13) except the
      // winner, which sits under `-first-five-winner`; both tickers parse, so no regex branch.
      baseball_team_first_five_winner: "f5",
      baseball_team_first_five_total: "f5total",
      baseball_team_first_five_spread: "f5spread",
    },
  },
  wnba: { series: "10105", slug: "wnba", categories: { moneyline: "ml", totals: "total", spreads: "spread" } },
  nba:  { series: "10345", slug: "nba",  categories: { moneyline: "ml", totals: "total", spreads: "spread" } },
  nhl:  { series: "10346", slug: "nhl",  categories: { moneyline: "ml", totals: "total", spreads: "spread" } },
  // NFL (Phase 2, 2026-08-14) — the catalog's own `series:10187` returns ZERO events (same trap as
  // Argentina); the real id was read off a live event via `tag_slug=nfl`. ml+totals ONLY: Kalshi has
  // no NFL spread/team-total book at all (KXNFLGAME+KXNFLTOTAL only), and Poly's NFL spread outcomes
  // are 3-letter abbrevs ("BUF"/"CAR") that don't match the moneyline's full names ("Panthers"/
  // "Bills") — `_nameToSide` can't resolve them, and team_totals need a per-team field the schema
  // doesn't carry. Both deferred to their own design pass rather than shipped half-built.
  nfl:  { series: "12185", slug: "nfl", categories: { moneyline: "ml", totals: "total" } },
  // KBO Korean baseball (Phase 2, 2026-08-14) — verified live via `GET /sports` + a
  // `tag_slug=kbo` cross-check (both agree on 10370, so unlike Argentina/NFL the catalog id was
  // right this time). Moneyline ONLY — matches Kalshi (KXKBOGAME is 2-way ML, no totals/spread
  // book at all) and Poly itself lists no other family for this league.
  kbo:  { series: "10370", slug: "kbo", categories: { moneyline: "ml" } },
  // UFC (Phase 2, 2026-08-14) — the catalog's own `series:10500` returns ONE unrelated event
  // (an nflx-price futures market), same trap as Argentina/NFL. `tag_slug=ufc` also fails (62
  // events, all season-long futures/props — "who will X fight next" — no per-fight events at all).
  // The real series id (38) was found via `GET /public-search?q=UFC`, which surfaces per-fight
  // events (`ufc-isl-ian1-2026-08-15`) that neither the catalog nor tag_slug listing returns;
  // confirmed all 30 events under series 38 are genuine per-fight tickers. ml-ONLY, matching
  // KXUFCFIGHT (Kalshi's model-free maker book, per-fighter YES markets). Poly's `totals` here is
  // ROUND totals (0.5/1.5/2.5… — how many rounds the fight lasts) which maps conceptually to
  // KXUFCROUNDS, but that series is model-BASED shadow-only (`fight.js`), not part of the
  // model-free capture-all system venueVig compares (`model_free = TRUE` is a hard filter in its
  // Kalshi-side query) — so a totals row would never surface a Δ regardless of registry wiring.
  // `ufc_go_the_distance`/`ufc_method_of_victory` are genuine props, out of scope entirely. No
  // teams.js registry — fighters are an unbounded roster, not a fixed set like a team league;
  // `buildCaptureCandidates` tolerates `game: null` by design (see the registry-driven comment
  // above), so `game` is null for every UFC row and venueVig aggregates by sport×category×band
  // with no team join anyway.
  ufc:  { series: "38", slug: "ufc", categories: { moneyline: "ml" } },
  // ATP + WTA tennis (Phase 2, 2026-08-14). Unlike NFL/UFC, the catalog ids (10365/10366) were
  // RIGHT this time — verified live (41/29 real match events). ml-ONLY: Kalshi's KXATPMATCH/
  // KXWTAMATCH are match-winner only, and Poly lists a large set/game prop family
  // (tennis_set_totals, tennis_set_handicap, tennis_first_set_winner, …) with no Kalshi
  // counterpart at all — same "no product to compare against" reasoning as NFL's spread/
  // team_totals. No teams.js registry — like UFC, players are an unbounded pool, not a fixed
  // team roster; `game` stays null by design.
  //
  // sport MISMATCH, not a copy-paste of the NFL/KBO/UFC pattern: Kalshi collapses both tours into
  // ONE `shadow_plays.sport = "tennis"` (tour is a separate feature field), but Poly's own ticker
  // prefix is "atp"/"wta" — the sport segment IS the tour, there's no bare "tennis" prefix to key
  // on. Keeping the registry key + captured row's `sport` column as "atp"/"wta" (truthful, and
  // matches every other Poly discovery/dedup path that keys off the real Gamma slug) means
  // venueVig's cross-venue join would otherwise NEVER match — two Poly buckets against Kalshi's
  // one. `vigSport: "tennis"` below drives `report.js`'s `pVigSportCaseSql` — a Poly-side sport
  // normalization CASE at aggregation time only (mirrors the category-CASE pattern, never touches
  // the stored column) — DERIVED from every `vigSport` in this registry, not a hand-written list,
  // because the soccer batch below hits this same mismatch on almost every league.
  atp:  { series: "10365", slug: "atp", categories: { moneyline: "ml" }, vigSport: "tennis" },
  wta:  { series: "10366", slug: "wta", categories: { moneyline: "ml" }, vigSport: "tennis" },
  // Dota 2 (Phase 2, 2026-08-14) — catalog id (10309) verified live, 29 events. ml-ONLY via the
  // "moneyline" sportsMarketType (overall SERIES/match winner), matching Kalshi's KXDOTA2GAME
  // (one YES per team per MATCH, not per map). Poly's Bo3/Bo5 events ALSO carry a same-named-
  // outcome "child_moneyline" (one per individual map) plus a large prop family (map_handicap,
  // first_blood_game, kill_over_under_game, dota2_rampage, …) with no Kalshi counterpart —
  // `categories` keys on the EXACT sportsMarketType string, so "child_moneyline" is a different
  // key and is skipped automatically, no extra filtering needed. No teams.js registry (esports
  // rosters are effectively unbounded, same reasoning as UFC/ATP/WTA) — `game` stays null.
  // Two of 29 live tickers carry a "-more-markets" suffix (e.g. "dota2-rnx-nem-2026-07-12-more-
  // markets") that the strict 2-segment regex rejects, same as any other suffixed ticker — minor,
  // ~7% of the slate, not worth a regex carve-out for.
  dota2: { series: "10309", slug: "dota2", categories: { moneyline: "ml" } },
  // Soccer (Phase 2, 2026-08-14 — first two leagues of ~20). `winnerShape: "3wayYesNo"` routes
  // these through polymarket-capture.js's soccer-specific branch: the bare game ticker carries
  // THREE separate "moneyline"-typed markets ("Will X win?" / "…end in a draw?" / "Will Y win?"),
  // not one 2-outcome market — see the long comment on `_soccerMlSide` there for the full shape and
  // why it needed real code, not just a registry row. Both catalog ids verified live (mls: 96
  // upcoming bare-ticker events; epl: 6). No `teams.js` polymarket aliases added — Poly's own
  // ticker abbrs happen to already match several Kalshi canonical codes 1:1 (e.g. mls "sea"/"rsl"),
  // so `game` resolves for free where they agree and stays null (tolerated) where they don't; never
  // worth guessing wrong. Sport keys match Kalshi's own (`mls`/`epl`) — no tennis-style sport-label
  // mismatch here, so no venueVig normalization needed.
  mls: { series: "10189", slug: "mls", categories: { moneyline: "ml" }, winnerShape: "3wayYesNo" },
  epl: { series: "10188", slug: "epl", categories: { moneyline: "ml" }, winnerShape: "3wayYesNo" },
  // Remaining 17 model-free soccer leagues (Phase 2, 2026-08-14). Same winnerShape:"3wayYesNo"
  // path as mls/epl — verified live for EVERY row below (question phrasing "Will X win on DATE?" /
  // "…end in a draw?", exactly 3 moneyline markets per bare-ticker event). `vigSport` is REQUIRED
  // on every one of these — Poly's own ticker slug is a short/different code from our internal
  // Kalshi sport key in all but nwsl (e.g. 'bra' -> 'brasileirao', 'arg' -> 'argprem'), the exact
  // mismatch tennis hit first; the registry key MUST equal Poly's real ticker slug (parsing) while
  // `vigSport` carries the Kalshi-side name (comparison) — conflating them silently breaks one or
  // the other. No teams.js aliases added for any of these (same as mls/epl — `game` resolves for
  // free where abbrs already agree, stays null and tolerated otherwise). `argprem`'s catalog id
  // (10285) is the SAME known-wrong trap as before (0 events) — the real one is 10312.
  bra:    { series: "10359", slug: "bra",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "brasileirao" },
  nwsl:   { series: "11462", slug: "nwsl",   categories: { moneyline: "ml" }, winnerShape: "3wayYesNo" },
  chi:    { series: "10439", slug: "chi",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "chnsl" },
  mex:    { series: "10290", slug: "mex",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "ligamx" },
  col1:   { series: "10964", slug: "col1",   categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "dimayor" },
  brco:   { series: "11460", slug: "brco",   categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "copadobrasil" },
  arg:    { series: "10312", slug: "arg",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "argprem" },
  ere:    { series: "10286", slug: "ere",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "eredivisie" },
  jap:    { series: "10360", slug: "jap",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "jleague" },
  lal:    { series: "10193", slug: "lal",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "laliga" },
  sea:    { series: "10203", slug: "sea",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "seriea" },
  fl1:    { series: "10195", slug: "fl1",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "ligue1" },
  es2:    { series: "10672", slug: "es2",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "laliga2" },
  // uslc was in POLY_DISMISSED_SPORTS (see below) — dismissed 2026-07-21 as "no overlap", before
  // KXUSLGAME existed; removed from that list in this same commit (never auto-revived otherwise).
  uslc:   { series: "12318", slug: "uslc",   categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "usl" },
  lib:    { series: "10289", slug: "lib",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "copalib" },
  por:    { series: "10330", slug: "por",    categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "ligaportugal" },
  ned2:   { series: "12353", slug: "ned2",   categories: { moneyline: "ml" }, winnerShape: "3wayYesNo", vigSport: "eerstediv" },
};

// Sports we capture, as a regex alternation — derived so a new POLY_MARKETS row is admitted by both
// ticker parsers without touching either.
export const POLY_SPORTS_RE = Object.keys(POLY_MARKETS).join("|");

// Sport → Gamma series id. DERIVED from POLY_MARKETS (was the hand-written source until 2026-08-13);
// kept as its own export because the observatory (`fetchPolymarketGames`) and the polymarket-scan
// baseline diff both key off this exact shape.
export const POLY_SERIES = Object.fromEntries(
  Object.entries(POLY_MARKETS).map(([sport, cfg]) => [sport, cfg.series])
);

// Gamma sport slugs vetted-and-rejected for the observatory. The polymarket-scan cron reconciles
// these to status='dismissed' in polymarket_sports_seen, so triaged noise clears on a code change
// instead of a manual ?dismiss= curl (mirror of series-config.js DISMISSED_SERIES).
export const POLY_DISMISSED_SPORTS = [
  // 7/21 triage (13 detected, all 0 live except ttelite=1): niche low-signal leagues (Czech/
  // Moldova/Ukraine "Setka Cup" table-tennis family, a handful of unclear thin slugs) — none
  // overlap sports/leagues we model, and Polymarket has been observatory-only since the 7/04 kill
  // (no active build target). DISMISS all. (`uslc` — USL Championship — was dismissed here too;
  // removed 2026-08-14 when KXUSLGAME made it buildable, see POLY_MARKETS.uslc above.)
  "chfa", "czechligapro", "pol", "sclc", "setkamecz", "setkamemd", "setkameua", "setkawoua",
  "sui", "ttchallenger", "ttcup", "ttelite",
  // 7/22 triage (3 detected): cricket (The Hundred, men's + women's) and cycling (Tour de France
  // margin of victory) — no rating/model source in our stack (same class as the Kalshi-side
  // KXCLUBFGAME/cycling dismissals), and Polymarket is observatory-only since the 7/04 kill
  // regardless. DISMISS all.
  "crichundred", "crichundredw", "cycling",
  // 7/23 triage (25 detected): a mix of lower-division/regional soccer leagues (afcl, argcopa,
  // bel1, bel2, cafcl, ecs, frtc, gre1, ned2, par1, ptsc, qat1) and niche cricket T10/T20/domestic
  // leagues (cricecsch, cricecseng, cricfalcons, cricgermant10, cricgsl, cricinterprov, cricjclt10,
  // crickerala, cricmaharani, cricmukono, cricodc, cricodcl2w, cricppl) — none overlap sports/
  // leagues we model (no club Elo for the soccer leagues, no cricket model at all), and Polymarket
  // stays observatory-only since the 7/04 kill regardless of individual league quality. DISMISS all.
  "afcl", "argcopa", "bel1", "bel2", "cafcl", "ecs", "frtc", "gre1", "ned2", "par1", "ptsc", "qat1",
  "cricecsch", "cricecseng", "cricfalcons", "cricgermant10", "cricgsl", "cricinterprov",
  "cricjclt10", "crickerala", "cricmaharani", "cricmukono", "cricodc", "cricodcl2w", "cricppl",
  // 8/10 triage (4 of 5 detected): usl1 (USL Championship corner props only — 1 live event, no
  // ML; niche shape), tur2 (Turkish 2nd division — 0 live events), uae1 (UAE top flight — 0 live),
  // saf1 (South African top flight — 0 live). clf left undismissed at the time, mislabeled "La
  // Liga 1" from its sample event ("Real Madrid vs. CD Leganes") — actually confirmed 2026-08-15
  // against the live Gamma /sports catalog: sport="clf" is **"Club Friendlies"**, not a league.
  // No stable Kalshi counterpart exists (Kalshi lists specific competitions, not a generic
  // friendlies bucket) and the 25 live events are a transient preseason cluster, not a recurring
  // series — same class as KXFIFALEAVE (real volume, resolves once, not worth building against).
  "usl1", "tur2", "uae1", "saf1", "clf",
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
  const m = new RegExp(`^(${POLY_SPORTS_RE})-([a-z0-9]+)-([a-z0-9]+)-(\\d{4}-\\d{2}-\\d{2})$`)
    .exec(String(ticker || ""));
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
