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
// maker-quotable, the exact defect that left 9 Phase-1 modules silently useless. Same blocker as
// K League.
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
