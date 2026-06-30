// api/lib/sportsbook.js — sharp-sportsbook reference feed (The Odds API). Phase 1a, 2026-06-29.
//
// PURPOSE: a read-only price REFERENCE, not a forecaster. The strategic finding this session is
// that our per-sport models can't out-forecast the sharp-book consensus on liquid markets — so
// instead of competing with the book, we USE it as the truth anchor: de-vig the sharp line to a
// fair probability and compare it to the Kalshi price (in tonight/sportsbook-deltas.js). The
// kill-gate question: does Kalshi systematically LAG the de-vigged sharp book (a real, timeable
// edge), or does it track tightly (no edge → redirect to thin markets)? Shadow-only — these prices
// NEVER reach the client response.
//
// Source = The Odds API (the-odds-api.com), Pinnacle bookmaker (the low-vig de-vig gold standard,
// region "eu"). Needs THE_ODDS_API_KEY. Failure-closed → [] (no key, outage, rate-limit) so a book
// outage can never affect the main /api/tonight response.
//
// MONEYLINE-ONLY by design (Phase 1a) — same reasoning as polymarket-deltas.js: ML is the liquid
// main line (sharpest book price, cleanest Kalshi side to match), whereas our emitted alt-line
// totals/spreads carry stale prices + dropped rows omit gameDate. Totals/spreads = Phase 1a.1.
//
// Team mapping is a contained full-name→canonical map for the IN-SEASON leagues (MLB + WNBA) that
// generate kill-gate data now. NBA/NHL are off-season no-ops (the fetch is gated to active sports
// anyway). SINGLE-SOURCE NOTE: this duplicates identity that "should" live in teams.js — deferred
// on purpose (a 105-team registry refactor isn't worth it for an unvalidated hypothesis; fold it in
// IF the Phase-1b kill-gate proves the edge).

const ODDS_BASE = "https://api.the-odds-api.com/v4";

// Our sport key → The Odds API sport key. Only in-season leagues are fetched (caller passes the
// active set), so off-season keys are harmless.
export const ODDS_SPORT_KEYS = {
  mlb: "baseball_mlb",
  wnba: "basketball_wnba",
  nba: "basketball_nba",   // off-season now — mapping TODO before NBA tip-off
  nhl: "icehockey_nhl",    // off-season now — mapping TODO before NHL puck-drop
};

// Full team name (lowercased) → canonical abbr. Matches the abbrs parseGameTeams/normTeam emit, so
// the de-vigged book game lines up with our Kalshi ML rows. MLB + WNBA only (the active leagues).
export const ODDSAPI_TO_CANON = {
  mlb: {
    "arizona diamondbacks": "ARI", "atlanta braves": "ATL", "athletics": "ATH",
    "oakland athletics": "ATH", "baltimore orioles": "BAL", "boston red sox": "BOS",
    "chicago cubs": "CHC", "cincinnati reds": "CIN", "cleveland guardians": "CLE",
    "colorado rockies": "COL", "chicago white sox": "CWS", "detroit tigers": "DET",
    "houston astros": "HOU", "kansas city royals": "KC", "los angeles angels": "LAA",
    "los angeles dodgers": "LAD", "miami marlins": "MIA", "milwaukee brewers": "MIL",
    "minnesota twins": "MIN", "new york mets": "NYM", "new york yankees": "NYY",
    "philadelphia phillies": "PHI", "pittsburgh pirates": "PIT", "san diego padres": "SD",
    "seattle mariners": "SEA", "san francisco giants": "SF", "st. louis cardinals": "STL",
    "st louis cardinals": "STL", "tampa bay rays": "TB", "texas rangers": "TEX",
    "toronto blue jays": "TOR", "washington nationals": "WSH",
  },
  wnba: {
    "atlanta dream": "ATL", "chicago sky": "CHI", "connecticut sun": "CONN",
    "dallas wings": "DAL", "golden state valkyries": "GS", "indiana fever": "IND",
    "las vegas aces": "LV", "los angeles sparks": "LA", "minnesota lynx": "MIN",
    "new york liberty": "NY", "phoenix mercury": "PHX", "portland fire": "POR",
    "seattle storm": "SEA", "toronto tempo": "TOR", "washington mystics": "WSH",
  },
};

export function normSportsbookTeam(sport, fullName) {
  return ODDSAPI_TO_CANON[sport]?.[String(fullName || "").trim().toLowerCase()] ?? null;
}

// Two-way multiplicative de-vig: strip the book's juice so the two sides sum to 1.0. Decimal odds →
// implied prob 1/odds, then normalize. (Shin/power are sharper upgrades once the data justifies it;
// multiplicative is the standard MVP and Pinnacle's vig is already low.) Returns {a,b} fair probs
// (0–1) or null if either price is unusable. Pure — unit-tested.
export function devigTwoWay(oddsA, oddsB) {
  const a = Number(oddsA), b = Number(oddsB);
  if (!(a > 1) || !(b > 1)) return null;
  const ia = 1 / a, ib = 1 / b;
  const s = ia + ib;
  if (!(s > 0)) return null;
  return { a: ia / s, b: ib / s };
}

const _ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

// Pure normalize: one Odds API event → { sport, away, home, gameDate, ml:{away,home} fair probs,
// book } or null. Requires a Pinnacle (or sole returned book) h2h market with both teams
// canon-resolvable. `sport` is OUR key (mlb/wnba/…). Exported for tests (no HTTP).
export function normalizeOddsEvent(sport, event) {
  if (!event) return null;
  const away = normSportsbookTeam(sport, event.away_team);
  const home = normSportsbookTeam(sport, event.home_team);
  if (!away || !home) return null;
  const bk = (event.bookmakers || [])[0]; // we request bookmakers=pinnacle, so [0] is the sharp book
  if (!bk) return null;
  const h2h = (bk.markets || []).find((m) => m.key === "h2h");
  if (!h2h || !Array.isArray(h2h.outcomes) || h2h.outcomes.length !== 2) return null;
  // Outcome names are full team names; map each to its canonical side.
  let oddsHome = null, oddsAway = null;
  for (const o of h2h.outcomes) {
    const c = normSportsbookTeam(sport, o.name);
    if (c === home) oddsHome = o.price;
    else if (c === away) oddsAway = o.price;
  }
  if (oddsHome == null || oddsAway == null) return null;
  const fair = devigTwoWay(oddsAway, oddsHome);
  if (!fair) return null;
  const gameDate = event.commence_time ? _ymd(new Date(event.commence_time)) : null;
  if (!gameDate) return null;
  return { sport, away, home, gameDate, ml: { away: fair.a, home: fair.b }, book: bk.key || "pinnacle" };
}

async function _fetchSportOdds(sportKey, apiKey) {
  try {
    const url = `${ODDS_BASE}/sports/${sportKey}/odds?apiKey=${apiKey}&bookmakers=pinnacle&markets=h2h&oddsFormat=decimal`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

// Fetch + de-vig sharp-book games for the ACTIVE sports only (credit-conserving — The Odds API bills
// per request, so we never poll off-season leagues). `sports` = iterable of our keys present in
// tonight's Kalshi ML set. KV-cached 180s (book prices move, but the observatory only needs a
// fresh-ish snapshot per request and we want to spare credits). Failure-closed → [].
export async function fetchSportsbookGames({ cache, isBustCache, apiKey, sports } = {}) {
  if (!apiKey) return []; // no key provisioned → clean no-op until THE_ODDS_API_KEY is set
  const active = [...new Set([...(sports || [])])].filter((s) => ODDS_SPORT_KEYS[s]).sort();
  if (!active.length) return [];
  const KEY = `sportsbook:games:${active.join(",")}`;
  if (cache && !isBustCache) {
    try { const hit = await cache.get(KEY); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const lists = await Promise.all(active.map((s) => _fetchSportOdds(ODDS_SPORT_KEYS[s], apiKey).then((evs) => [s, evs])));
  const games = [];
  for (const [s, evs] of lists) {
    for (const ev of evs) {
      const g = normalizeOddsEvent(s, ev);
      if (g) games.push(g);
    }
  }
  if (cache && games.length) {
    try { await cache.put(KEY, JSON.stringify(games), { expirationTtl: 180 }); } catch {}
  }
  return games;
}
