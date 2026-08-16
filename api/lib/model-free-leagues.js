// api/lib/model-free-leagues.js
// THE registry of model-free soccer leagues — one entry per league, replacing six near-identical
// copies of the same wiring (2026-07-28).
//
// Before this, adding a league meant ~170 lines across five files: a ~63-line emit module, a
// ~35-line lib wrapper, a ~35-line tonight.js parse branch, a ~30-line shadow.js resolver block,
// and a SERIES_CONFIG entry. Diffed with the league name normalized, two emit modules were
// BYTE-IDENTICAL (only comment prose differed) and two lib wrappers differed by exactly one line:
// the ESPN slug. All that duplication encoded four real values — Kalshi series ticker, ESPN slug,
// gameType tag, team registry.
//
// The reason to collapse it is not typing, it is the bug record. Every recurring silent failure in
// this codebase has been a copy-paste omission across these N copies: `gameTime: null` in 8-9
// Phase-1 modules (none had ever been maker-quotable), `kalshiTicker` never set across the same 9,
// and Argentina's `datesBySport` key omission that silently dropped 100% of its rows' gameTime —
// which was itself fixed by deriving the keys from one source "so this can't recur". A code
// generator would have made copy #7 faster AND the eighth instance of that bug class faster.
// Generalizing removes the class. The maker-league roadmap pre-registered this: "generalize the
// per-league wiring at league #7".
//
// TO ADD A LEAGUE: add one entry here + a `teams.js` registry + a SERIES_CONFIG row with
// `gameType: "modelFreeMl"`. No new files, no parse branch, no resolver block.
// ONE EXCEPTION (copadobrasil, 2026-08-04): if the registry has any 2-char abbr mixed with 3-char
// (Remo's "CR"), the league MUST also be added to parseGameTeams' variable-length-split allowlist
// in tonight/parse-teams.js. That branch validates splits against _VALID_TEAMS; the generic path it
// otherwise falls to keys `has2charPrefix` on TEAM_NORM, which is EMPTY for a registry with no
// kalshi aliases (canonical = Kalshi abbr) — so CRSAN silently mis-parses as CRS+AN and the fixture
// vanishes. Uniform-3-char registries (dimayor/chnsl/ligamx) don't need it.
// Verify the ESPN slug against live data before trusting it, and send `--compressed` — a gzipped
// body silently parses as empty and looks exactly like "league not covered". Two live examples:
// `aus.1` is Australian *soccer*, not the Australian Football League (KXAFLGAME) that shares the
// name; and the Canadian Premier League (KXCANPLGAME, REAL_BOOK with ~$98k volume) has NO ESPN
// slug at all — can.1 / can.cpl / can.nsl / can.canpl / can.2 / can.l1o all return zero teams
// with decompression handled. **Do not re-probe those.** CANPL is therefore unbuildable on this
// path: no ESPN feed means no gameTime and no resolution, and its ticker is date-only so
// kalshiTickerGameTime can't fill the gap — rows would log with gameTime:null and never be
// maker-quotable, the exact defect that left 9 Phase-1 modules silently useless.
// K League (KXKLEAGUEGAME) had the same ESPN-slug blocker but IS BUILT (2026-08-10) via the
// Dota2-style ticker-parse path — ticker encodes gameDate (YYMONDD + 3+3 teams), gameTime=null
// (occurrence_datetime is settlement expiration, not kickoff). See tonight/ticker-ml-modelfree.js,
// the shared emitter for this no-ESPN ticker-parsed shape (kleague + kbo).
// Czech FNL (KXCZEFNLGAME/SPREAD/TOTAL/BTTS) vetted 2026-08-14, real books on every sibling
// (GAME 42/42, SPREAD 8/16, TOTAL 12/12, BTTS 3/4) — PARKED, same class as CANPL: no ESPN slug
// found after cze.2/cze.3/cze.nfl/cze.national/cze.fnl1/cze.2liga/cze.nb/cze.b/cze.2a/cze.2.division/
// cze.2nd/cze.fnl.1 all returned empty, ESPN's own core league directory (216 leagues) has no Czech
// entry at all (not even cze.1, which DOES resolve live — that directory is curated, not
// authoritative), and the ID-neighborhood around cze.1's own numeric id (5347) has no valid
// siblings. **Do not re-probe those slugs.** Same kleague/kbo-style ticker-parse workaround
// (gameTime:null forever, capture+grade only, never maker-quotable) is a live option if this is
// ever revisited — not attempted here since it wasn't asked for.
// Finnish Ykkösliiga (KXFINYLGAME/SPREAD/TOTAL/BTTS), same vet: real books everywhere (GAME 24/24,
// TOTAL 10/18, SPREAD 6/12, BTTS 2/3), but a DIFFERENT blocker than Czech — `fin.2` IS a valid ESPN
// slug ("Finnish 1. Division") but returns ZERO teams and ZERO events for the entire month, so
// there's no schedule to match Kalshi tickers against even though the league object exists. Also
// PARKED; same kleague/kbo ticker-parse escape hatch applies.
// And cross-check team abbrs on BOTH sides: collisions have hit ~1 per non-US league, in
// Kalshi-vs-ESPN (chnsl "SHE", ligamx "ATL") and ESPN-internal (argprem "RIV") flavors.

import { CANONICAL_TO_ESPN } from "./teams.js";
import { makeSoccerModelFreeSource } from "./soccer-modelfree.js";

// The default ESPN-abbr → canonical-abbr mapping every league uses: invert that league's
// `CANONICAL_TO_ESPN` block (derived from the teams.js registry), identity when unmapped.
function _defaultCanonTeam(league) {
  const espnToCanon = Object.fromEntries(
    Object.entries(CANONICAL_TO_ESPN[league] || {}).map(([canon, espn]) => [espn, canon])
  );
  return (abbr) => espnToCanon[abbr] || abbr;
}

export const MODEL_FREE_LEAGUES = {
  mls:         { espnSlug: "usa.1" },
  brasileirao: { espnSlug: "bra.1" },
  nwsl:        { espnSlug: "usa.nwsl" },
  chnsl:       { espnSlug: "chn.1" },
  ligamx:      { espnSlug: "mex.1" },
  // 7th league, adopted 2026-07-28 — the first added via this registry rather than a file set.
  // ESPN slug verified live (col.1 → "Colombian Primera A", 20 teams) before anything was written.
  dimayor:     { espnSlug: "col.1" },
  // 8th league, adopted 2026-08-04 — Copa do Brasil (KXCOPADOBRASILGAME). Slug is bra.copa_do_brazil
  // with a 'z': bra.copa_do_brasil (an 's') 400s. Verified live — 8 fixtures matched the Kalshi
  // slate exactly on 2026-08-04. Default canonTeam suffices (no ESPN-internal abbr collision).
  copadobrasil: { espnSlug: "bra.copa_do_brazil" },
  // The one league needing more than the default mapping. ESPN's OWN /teams endpoint reuses the
  // abbreviation "RIV" for two different clubs (River Plate and Independiente Rivadavia, which
  // Kalshi correctly distinguishes as RIV/IRM), and a flat espnScore entry cannot express "two
  // canonical codes share one ESPN abbr" — so it is resolved off the displayName that
  // soccer-modelfree.js threads through as canonTeam's 2nd argument. Verified live 2026-07-24,
  // not guessed. `wrapCanonTeam` receives the default mapper so an override extends it rather
  // than replacing the registry-derived table.
  argprem: {
    espnSlug: "arg.1",
    wrapCanonTeam: (base) => (abbr, displayName) =>
      abbr === "RIV" ? ((displayName || "").includes("Rivadavia") ? "IRM" : "RIV") : base(abbr),
  },
  // 9th league, adopted 2026-08-07 — Dutch Eredivisie (KXEREDIVISIEGAME). ESPN slug ned.1
  // verified live: Aug 8-9 fixtures on ned.1 matched Kalshi's slate exactly. Three espnScore
  // remaps (AZA→AZ, FCU→UTR, ZWO→PEC) confirmed by cross-referencing both sides. Default
  // canonTeam suffices — no ESPN-internal abbr collision in the Eredivisie registry.
  eredivisie: { espnSlug: "ned.1" },
  // 10th league, adopted 2026-08-10 — J.League 1 (KXJLEAGUEGAME). ESPN slug jpn.1 verified live:
  // 20 teams, 30/30 real books, 1¢ median spread. K League 1 (KXKLEAGUEGAME) already tracked via
  // the Dota2-style ticker-parse path (no ESPN feed). J.League uses the standard MODEL_FREE_LEAGUES
  // path (ESPN jpn.1 feed exists, all abbrs confirmed).
  jleague: { espnSlug: "jpn.1" },
  // 11th–14th leagues, adopted 2026-08-10 — English Premier League, La Liga, Serie A, Ligue 1.
  // All 4 confirmed real books (eng.1/esp.1/ita.1/fra.1 verified live before commit).
  // KXBUNDESLIGAGAME skipped — 0 live markets (season not started yet); revisit late Aug 2026.
  epl:    { espnSlug: "eng.1" },
  laliga: { espnSlug: "esp.1" },
  seriea: { espnSlug: "ita.1" },
  ligue1: { espnSlug: "fra.1" },
  // Leagues Cup, adopted 2026-08-11 — the MLS × Liga MX summer tournament (KXLEAGUESCUPGAME), and
  // the first CROSS-LEAGUE competition here: its `leaguescup` registry is derived as mls ∪ ligamx
  // in teams.js rather than hand-written. ESPN slug is `concacaf.leagues.cup` with DOTS — the
  // underscore forms (concacaf.leagues_cup / usa.leagues_cup / mex.leagues_cup) all return 0
  // events; found by enumerating the core-API league index, not by guessing.
  // Largest liquid book in the vet queue when adopted: 42 live markets, 39 real books, 1¢ median
  // spread, overround 1.02, $4.19M volume. Default canonTeam suffices — the one collision (ATL) is
  // resolved inside the derived registry, not here.
  // SEASON SHAPE, and why gameTime will look wrong before it looks right: ESPN's own season types
  // run League Phase → 2026-08-17, QF 08-17→09-01, SF 09-01→09-05, 3rd/Final 09-05→09-07, but the
  // knockout fixtures are `count:0` — unpublished until the group phase resolves. So knockout rows
  // log with `gameTime: null` and `leaguescup` WILL appear in `gameTimeNullBySport` until ESPN
  // publishes. That is the scocup pattern and it self-heals; it is NOT a registry defect, and the
  // ticker cannot backstop it (KXLEAGUESCUPGAME tickers are date-only, no HHMM).
  leaguescup: { espnSlug: "concacaf.leagues.cup" },
  // 15th league, adopted 2026-08-10 — La Liga 2 (KXLALIGA2GAME). ESPN slug esp.2 verified live:
  // 22 teams, 33/33 real books, 5¢ median spread. Default canonTeam suffices (no ESPN-internal
  // abbr collision in the laliga2 registry; all Kalshi codes are 3-char).
  laliga2: { espnSlug: "esp.2" },
  // 16th league, adopted 2026-08-10 — USL Championship (KXUSLGAME). ESPN slug usa.usl.1 verified
  // live: 24 teams, 39/39 real books, 2¢ median spread. ESPN-internal collision: both Louisville
  // City (Kalshi: LFC) and Loudoun United FC (Kalshi: LOU) map to ESPN abbreviation "LOU" — resolved
  // via displayName just as argprem's RIV/IRM collision is. OC (Orange County SC) is 2-char in Kalshi
  // → usl in parse-teams.js variable-length allowlist (this commit).
  usl: {
    espnSlug: "usa.usl.1",
    wrapCanonTeam: (base) => (abbr, displayName) =>
      abbr === "LOU" ? ((displayName || "").includes("Louisville") ? "LFC" : "LOU") : base(abbr),
  },
  // 17th league, adopted 2026-08-10 — Copa Libertadores QF (KXCONMEBOLLIBGAME). ESPN slug
  // conmebol.libertadores verified live: 16 QF teams, 24/24 real books, 2¢ median spread.
  // Default canonTeam suffices (no ESPN-internal abbr collision). UC (2-char) and CARC (4-char)
  // → copalib in parse-teams.js variable-length allowlist (this commit).
  copalib: { espnSlug: "conmebol.libertadores" },
  // 18th league, adopted 2026-08-10 — Liga Portugal (KXLIGAPORTUGALGAME). ESPN slug por.1 verified
  // live: 33 fixtures Aug 8–Sep 1, 27/27 real books, 3¢ median spread, overround 1.04. Default
  // canonTeam suffices (the 18 ESPN abbrs are mutually distinct). The registry carries 14 espnScore
  // remaps — the worst divergence of any league here — including a true EST collision (Kalshi EST =
  // Estoril vs ESPN EST = Estrela) and CSM = Marítimo, both resolved by same-date fixture matching
  // rather than name similarity. See the teams.js block for the evidence.
  ligaportugal: { espnSlug: "por.1" },
  // 19th league, adopted 2026-08-14 — Eerste Divisie, Dutch 2nd tier (KXEERSTEDIVGAME). ESPN slug
  // ned.2 verified live: exact same-date fixture match (FC Volendam vs TOP Oss, 2026-08-15, matching
  // Kalshi's VOLOSS ticker). 48/48 real books on GAME, real books across SPREAD/TOTAL too (BTTS also
  // real but deliberately not built here, matching Eredivisie's own scope). Default canonTeam
  // suffices (no ESPN-internal abbr collision — the "Jong" mismatches are handled as plain espnScore
  // remaps, not a shared-abbr collision like RIV/IRM or LOU/LFC). AZ (2-char, Jong AZ Alkmaar) →
  // eerstediv in parseGameTeams' variable-length allowlist (this commit). See the teams.js block for
  // the unusually high (10/20) mismatch rate and why.
  eerstediv: { espnSlug: "ned.2" },
  // 20th league, adopted 2026-08-16 — Bolivian Primera Division (KXBOLPDIVGAME). ESPN slug bol.1
  // verified live: exact same-date fixture match, all 3 of 2026-08-16's Kalshi games (INDCLU,
  // CNPABB, AREPOT) matched bol.1's scoreboard for that date. Default canonTeam suffices (no
  // ESPN-internal abbr collision requiring wrapCanonTeam — the Kalshi/ESPN "POT" cross-venue
  // collision is a plain per-team espnScore remap, see the teams.js block). No Polymarket
  // counterpart (not in POLY_MARKETS, not in their discovery queue either) — recorded, not a blocker.
  bolpd: { espnSlug: "bol.1" },
};

export const MODEL_FREE_LEAGUE_KEYS = Object.keys(MODEL_FREE_LEAGUES);

// Memoized per league — `makeSoccerModelFreeSource` closes over an ESPN fetch/parse/cache path, so
// building it once per league keeps the cache key namespace stable across calls within an instance.
const _sources = new Map();
export function leagueSource(league) {
  if (_sources.has(league)) return _sources.get(league);
  const cfg = MODEL_FREE_LEAGUES[league];
  if (!cfg) throw new Error(`model-free league not registered: ${league}`);
  const base = _defaultCanonTeam(league);
  const src = makeSoccerModelFreeSource({
    espnSlug: cfg.espnSlug,
    canonTeam: cfg.wrapCanonTeam ? cfg.wrapCanonTeam(base) : base,
    cacheKeyPrefix: league,
  });
  _sources.set(league, src);
  return src;
}
