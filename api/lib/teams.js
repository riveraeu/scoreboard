// api/lib/teams.js — single source of team identity per sport (2026-06-11).
//
// Each record: canonical abbr + alias forms per external surface. Every legacy map
// (TEAM_NORM, _VALID_TEAMS, CANONICAL_TO_ESPN, WNBA_*, NHL_ABBR_MAP, MLB_ID_TO_ABBR)
// is DERIVED below and re-exported from its historical module, so consumers are
// unchanged. teams.test.js pins each derived map against the pre-registry literals —
// a registry typo fails the suite instead of silently breaking a parse.
//
// Surfaces (see CLAUDE.md gotchas — these are intentionally separate):
//   kalshi       — Kalshi ticker abbreviation(s) → canonical (TEAM_NORM). Identity
//                  aliases (e.g. mlb KC→KC) are FUNCTIONAL: TEAM_NORM membership marks
//                  2-char prefixes for parseGameTeams' 2+3 split path. Don't prune them.
//   polymarket   — Polymarket Gamma game-ticker abbr(s) when ≠ canonical-lowercased
//                  (POLY_TO_CANON). Only listed where Poly's form differs from our canonical
//                  (mlb oak→ATH; wnba gsv→GS / las→LV / nyl→NY). Identity match is automatic.
//   espnScore    — ESPN *scoreboard* abbr when ≠ canonical (/api/live translation).
//   espnStats    — ESPN stats/injuries endpoint form (WNBA only; CONNECTICU, DALLAS…).
//   espnStatsAlt — extra inbound stats-surface forms that normalize to canonical.
//   espnId / nhlId / mlbId — numeric ids per league data API.

export const TEAMS = {
  nba: [
    { abbr: "ATL", kalshi: ["KAT"] },
    { abbr: "BOS" },
    { abbr: "BKN", kalshi: ["NJ"] },
    { abbr: "CHA" },
    { abbr: "CHI" },
    { abbr: "CLE" },
    { abbr: "DAL" },
    { abbr: "DEN" },
    { abbr: "DET" },
    { abbr: "GSW", kalshi: ["GS"], espnScore: "GS" },
    { abbr: "HOU" },
    { abbr: "IND" },
    { abbr: "LAC" },
    { abbr: "LAL" },
    { abbr: "MEM" },
    { abbr: "MIA" },
    { abbr: "MIL" },
    { abbr: "MIN" },
    { abbr: "NOP", kalshi: ["NO"], espnScore: "NO" },
    { abbr: "NYK", kalshi: ["NY"], espnScore: "NY" },
    { abbr: "OKC" },
    { abbr: "ORL" },
    { abbr: "PHI" },
    { abbr: "PHX", kalshi: ["PHO", "WPH"] },
    { abbr: "POR" },
    { abbr: "SAC" },
    { abbr: "SAS", kalshi: ["SA"], espnScore: "SA" },
    { abbr: "TOR" },
    { abbr: "UTA", espnScore: "UTAH" },
    { abbr: "WAS", espnScore: "WSH" },
  ],
  wnba: [
    { abbr: "ATL", espnId: 20 },
    { abbr: "CHI", espnId: 19 },
    { abbr: "CONN", kalshi: ["CONNECTICU", "CON"], espnScore: "CON", espnStats: "CONNECTICU", espnId: 18 },
    { abbr: "DAL", kalshi: ["DALLAS"], espnStats: "DALLAS", espnId: 3 },
    { abbr: "GS", kalshi: ["GSV"], polymarket: ["gsv"], espnStatsAlt: ["GSV"], espnId: 129689 },
    { abbr: "IND", espnId: 5 },
    { abbr: "LV", polymarket: ["las"], espnId: 17 },
    { abbr: "LA", kalshi: ["LAS"], espnStats: "LAS", espnId: 6 },
    { abbr: "MIN", espnId: 8 },
    { abbr: "NY", polymarket: ["nyl"], espnId: 9 },
    { abbr: "PHX", espnId: 11 },
    { abbr: "POR", kalshi: ["PDX"], espnId: 132052 },
    { abbr: "SEA", espnId: 14 },
    { abbr: "TOR", espnId: 131935 },
    { abbr: "WSH", kalshi: ["WAS"], espnStats: "WAS", espnId: 16 },
  ],
  nhl: [
    { abbr: "ANA", nhlId: 24 },
    { abbr: "BOS", nhlId: 6 },
    { abbr: "BUF", nhlId: 7 },
    { abbr: "CGY", nhlId: 20 },
    { abbr: "CAR", nhlId: 12 },
    { abbr: "CHI", nhlId: 16 },
    { abbr: "COL", nhlId: 21 },
    { abbr: "CBJ", nhlId: 29 },
    { abbr: "DAL", nhlId: 25 },
    { abbr: "DET", nhlId: 17 },
    { abbr: "EDM", nhlId: 22 },
    { abbr: "FLA", nhlId: 13 },
    { abbr: "LAK", kalshi: ["LA"], espnScore: "LA", nhlId: 26 },
    { abbr: "MIN", nhlId: 30 },
    { abbr: "MTL", nhlId: 8 },
    { abbr: "NSH", nhlId: 18 },
    { abbr: "NJD", kalshi: ["NJ"], espnScore: "NJ", nhlId: 1 },
    { abbr: "NYI", nhlId: 2 },
    { abbr: "NYR", nhlId: 3 },
    { abbr: "OTT", nhlId: 9 },
    { abbr: "PHI", nhlId: 4 },
    { abbr: "PIT", nhlId: 5 },
    { abbr: "STL", nhlId: 19 },
    { abbr: "SJS", kalshi: ["SJ"], espnScore: "SJ", nhlId: 28 },
    { abbr: "SEA", nhlId: 55 },
    { abbr: "TBL", kalshi: ["TB"], espnScore: "TB", nhlId: 14 },
    { abbr: "TOR", nhlId: 10 },
    { abbr: "UTA", nhlId: 68 },
    { abbr: "VAN", nhlId: 23 },
    { abbr: "VGK", kalshi: ["VGK"], nhlId: 54 },
    { abbr: "WSH", nhlId: 15 },
    { abbr: "WPG", nhlId: 52 },
  ],
  mlb: [
    { abbr: "ARI", kalshi: ["AZ"], mlbId: 109 },
    { abbr: "ATL", mlbId: 144 },
    { abbr: "ATH", kalshi: ["OAK"], polymarket: ["oak"], mlbId: 133 },
    { abbr: "BAL", mlbId: 110 },
    { abbr: "BOS", mlbId: 111 },
    { abbr: "CHC", mlbId: 112 },
    { abbr: "CIN", mlbId: 113 },
    { abbr: "CLE", mlbId: 114 },
    { abbr: "COL", mlbId: 115 },
    { abbr: "CWS", kalshi: ["CHW"], espnScore: "CHW", mlbId: 145 },
    { abbr: "DET", mlbId: 116 },
    { abbr: "HOU", mlbId: 117 },
    { abbr: "KC", kalshi: ["KCR", "KC"], mlbId: 118 },
    { abbr: "LAA", mlbId: 108 },
    { abbr: "LAD", mlbId: 119 },
    { abbr: "MIA", mlbId: 146 },
    { abbr: "MIL", mlbId: 158 },
    { abbr: "MIN", mlbId: 142 },
    { abbr: "NYM", mlbId: 121 },
    { abbr: "NYY", mlbId: 147 },
    { abbr: "PHI", mlbId: 143 },
    { abbr: "PIT", mlbId: 134 },
    { abbr: "SD", kalshi: ["SDP", "SD"], mlbId: 135 },
    { abbr: "SEA", mlbId: 136 },
    { abbr: "SF", kalshi: ["SFG", "SF"], mlbId: 137 },
    { abbr: "STL", mlbId: 138 },
    { abbr: "TB", kalshi: ["TBR", "TB"], mlbId: 139 },
    { abbr: "TEX", mlbId: 140 },
    { abbr: "TOR", mlbId: 141 },
    { abbr: "WSH", kalshi: ["WSN", "WAS"], mlbId: 120 },
  ],
  nfl: [
    { abbr: "ARI" }, { abbr: "ATL" }, { abbr: "BAL" }, { abbr: "BUF" },
    { abbr: "CAR" }, { abbr: "CHI" }, { abbr: "CIN" }, { abbr: "CLE" },
    { abbr: "DAL" }, { abbr: "DEN" }, { abbr: "DET" }, { abbr: "GB" },
    { abbr: "HOU" }, { abbr: "IND" }, { abbr: "JAX" }, { abbr: "KC" },
    { abbr: "LAC" },
    { abbr: "LAR", kalshi: ["LA"] },
    { abbr: "LV" }, { abbr: "MIA" }, { abbr: "MIN" }, { abbr: "NE" },
    { abbr: "NO" }, { abbr: "NYG" }, { abbr: "NYJ" }, { abbr: "PHI" },
    { abbr: "PIT" }, { abbr: "SEA" }, { abbr: "SF" }, { abbr: "TB" },
    { abbr: "TEN" }, { abbr: "WSH" },
  ],
  // Liga Mexicana de Béisbol (KXLMBGAME, adopted 2026-07-15). Canonical = Kalshi's 3-char
  // ticker abbrs (all exactly 3 chars → parseGameTeams' validated 3+3 split works untouched).
  // mlbId = MLB statsapi team id (sportId 23 / leagueId 125) — keying by id sidesteps the
  // statsapi↔Kalshi name drift entirely (statsapi "Acereros del Norte" = Kalshi "Acereros de
  // Monclova" ADM; statsapi "Tecos de los Dos Laredos" = Kalshi "Tecolotes…" TEL).
  lmb: [
    { abbr: "ADM", mlbId: 560 },  // Acereros de Monclova (statsapi: Acereros del Norte)
    { abbr: "AGU", mlbId: 5567 }, // El Aguila de Veracruz
    { abbr: "ALG", mlbId: 447 },  // Algodoneros de Union Laguna
    { abbr: "BLE", mlbId: 434 },  // Bravos de Leon
    { abbr: "CAL", mlbId: 4444 }, // Caliente de Durango
    { abbr: "CDJ", mlbId: 6304 }, // Charros de Jalisco
    { abbr: "CON", mlbId: 6303 }, // Conspiradores de Queretaro
    { abbr: "DIA", mlbId: 532 },  // Diablos Rojos del Mexico
    { abbr: "DOR", mlbId: 575 },  // Dorados de Chihuahua
    { abbr: "GUE", mlbId: 579 },  // Guerreros de Oaxaca
    { abbr: "LDY", mlbId: 496 },  // Leones de Yucatan
    { abbr: "ODT", mlbId: 442 },  // Olmecas de Tabasco
    { abbr: "PDC", mlbId: 523 },  // Piratas de Campeche
    { abbr: "PDP", mlbId: 520 },  // Pericos de Puebla
    { abbr: "RDA", mlbId: 528 },  // Rieleros de Aguascalientes
    { abbr: "SDM", mlbId: 562 },  // Sultanes de Monterrey
    { abbr: "SDS", mlbId: 502 },  // Saraperos de Saltillo
    { abbr: "TDQ", mlbId: 569 },  // Tigres de Quintana Roo
    { abbr: "TDT", mlbId: 5010 }, // Toros de Tijuana
    { abbr: "TEL", mlbId: 536 },  // Tecolotes de Los Dos Laredos (statsapi: Tecos de los Dos Laredos)
  ],
  // MLS (KXMLSGAME, adopted 2026-07-23 — model-free maker candidate, see project_maker_
  // modelfree_clubsoccer_2026_07_23 memory). Canonical = Kalshi's own ticker abbrs (same
  // precedent as lmb) — variable length (2/3/4 char), same class of parse problem as WNBA,
  // so parseGameTeams' "try every split" branch covers both. espnScore only where ESPN's
  // scoreboard abbr differs (verified live against site.api.espn.com .../soccer/usa.1/scoreboard,
  // 2026-07-23): DCU→DC, LAG→LA, NYRB→RBNY.
  mls: [
    { abbr: "ATL" }, { abbr: "ATX" }, { abbr: "CHI" }, { abbr: "CIN" }, { abbr: "CLB" },
    { abbr: "CLT" }, { abbr: "COL" }, { abbr: "DAL" },
    { abbr: "DCU", espnScore: "DC" },   // D.C. United
    { abbr: "HOU" },
    { abbr: "LAFC" },
    { abbr: "LAG", espnScore: "LA" },   // LA Galaxy
    { abbr: "MIA" }, { abbr: "MIN" }, { abbr: "MTL" },
    { abbr: "NE" },   // New England Revolution
    { abbr: "NSH" }, { abbr: "NYC" },
    { abbr: "NYRB", espnScore: "RBNY" }, // New York Red Bulls
    { abbr: "ORL" }, { abbr: "PHI" }, { abbr: "POR" }, { abbr: "RSL" },
    { abbr: "SD" },   // San Diego FC
    { abbr: "SEA" },
    { abbr: "SJ" },   // San Jose Earthquakes
    { abbr: "SKC" }, { abbr: "STL" }, { abbr: "TOR" }, { abbr: "VAN" },
  ],
};

// ── Derived maps (legacy shapes, re-exported from their historical modules) ──────

// Kalshi ticker abbr → canonical, per sport (legacy home: tonight/parse-teams.js).
export const TEAM_NORM = Object.fromEntries(
  Object.entries(TEAMS).map(([sport, teams]) => {
    const m = {};
    for (const t of teams) for (const a of t.kalshi || []) m[a] = t.abbr;
    return [sport, m];
  })
);

// Canonical abbr sets, per sport (legacy home: tonight/parse-teams.js).
export const _VALID_TEAMS = Object.fromEntries(
  Object.entries(TEAMS).map(([sport, teams]) => [sport, new Set(teams.map(t => t.abbr))])
);

// Polymarket Gamma game-ticker abbr (lowercased) → canonical, per sport. Identity = canonical
// lowercased; `polymarket` aliases override where Poly's form differs. Consumers do
// `POLY_TO_CANON[sport]?.[abbr.toLowerCase()]`. New 2026-06-23 for the cross-venue observatory.
export const POLY_TO_CANON = Object.fromEntries(
  Object.entries(TEAMS).map(([sport, teams]) => {
    const m = {};
    for (const t of teams) {
      m[t.abbr.toLowerCase()] = t.abbr;
      for (const a of t.polymarket || []) m[a.toLowerCase()] = t.abbr;
    }
    return [sport, m];
  })
);

// Canonical → ESPN scoreboard abbr, per sport (legacy home: inline in handlers/sports.js).
// Only sports with at least one mismatch carry entries; consumers do `[sport] || {}`.
export const CANONICAL_TO_ESPN = Object.fromEntries(
  Object.entries(TEAMS).map(([sport, teams]) => {
    const m = {};
    for (const t of teams) if (t.espnScore) m[t.abbr] = t.espnScore;
    return [sport, m];
  })
);

// WNBA stats/injuries endpoint forms (legacy home: wnba.js). NOT the scoreboard map.
export const WNBA_CANON_TO_ESPN = (() => {
  const m = {};
  for (const t of TEAMS.wnba) if (t.espnStats) m[t.abbr] = t.espnStats;
  return m;
})();
export const WNBA_ESPN_TO_CANON = (() => {
  const m = {};
  for (const t of TEAMS.wnba) {
    if (t.espnStats) m[t.espnStats] = t.abbr;
    for (const a of t.espnStatsAlt || []) m[a] = t.abbr;
  }
  return m;
})();
export const WNBA_TEAM_IDS = Object.fromEntries(
  TEAMS.wnba.map(t => [t.abbr, t.espnId])
);

// NHL stats API teamId → canonical (legacy home: nhl.js).
export const NHL_ABBR_MAP = Object.fromEntries(
  TEAMS.nhl.map(t => [t.nhlId, t.abbr])
);

// MLB Stats API teamId → canonical (legacy home: mlb-shared.js).
export const MLB_ID_TO_ABBR = Object.fromEntries(
  TEAMS.mlb.map(t => [t.mlbId, t.abbr])
);

// LMB Stats API teamId → canonical Kalshi abbr (same statsapi id space as MLB, sportId 23).
export const LMB_ID_TO_ABBR = Object.fromEntries(
  TEAMS.lmb.map(t => [t.mlbId, t.abbr])
);
