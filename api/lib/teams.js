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
  // Brasileirão Série A (KXBRASILEIROGAME, adopted 2026-07-23 — model-free maker candidate,
  // same playbook as mls above, see project_maker_modelfree_clubsoccer_2026_07_23 memory).
  // Canonical = Kalshi's own ticker abbrs (verified live via /api/kalshi-check 2026-07-23: all
  // 20 Série A teams, 3-char except Remo's 2-char "CR" — the one team requiring the "try every
  // split" parseGameTeams branch, same class of problem as MLS's NE/SD/SJ). espnScore only
  // where ESPN's bra.1 scoreboard abbr differs (verified live 2026-07-23): ATL→CAM (Atlético
  // Mineiro), GPA→GRE (Grêmio), RBB→BRA (Red Bull Bragantino), CR→REMO (Remo), SPA→SAO (São
  // Paulo), VDG→VAS (Vasco da Gama).
  brasileirao: [
    { abbr: "BAH" }, { abbr: "BOT" },
    { abbr: "RBB", espnScore: "BRA" },  // Red Bull Bragantino
    { abbr: "CAP" },
    { abbr: "ATL", espnScore: "CAM" },  // Atlético Mineiro
    { abbr: "CFC" },                    // Coritiba
    { abbr: "CHA" }, { abbr: "COR" }, { abbr: "CRU" }, { abbr: "FLA" }, { abbr: "FLU" },
    { abbr: "GPA", espnScore: "GRE" },  // Grêmio
    { abbr: "INT" }, { abbr: "MIR" }, { abbr: "PAL" },
    { abbr: "CR", espnScore: "REMO" },  // Remo
    { abbr: "SAN" },
    { abbr: "SPA", espnScore: "SAO" },  // São Paulo
    { abbr: "VDG", espnScore: "VAS" },  // Vasco da Gama
    { abbr: "VIT" },
  ],
  // Copa do Brasil (KXCOPADOBRASILGAME, adopted 2026-08-04 — 8th model-free maker league, same
  // playbook, added through MODEL_FREE_LEAGUES with no new files). A cup, not a league, so its
  // field is a subset of Brazilian clubs (mostly Série A) plus a few lower-division sides — every
  // one of the 16 round-of-16 clubs was verified live in a KXCOPADOBRASILGAME ticker on 2026-08-04
  // (nothing guessed). Canonical = Kalshi's own ticker abbrs; the four espnScore aliases (ATL→CAM,
  // GPA→GRE, CR→REMO, VDG→VAS) are the SAME ones already live-verified for brasileirao above, and
  // ESPN's own bra.copa_do_brazil scoreboard abbrs for all 16 are mutually distinct (no argprem-style
  // ESPN-internal collision → no wrapCanonTeam needed). CR (Remo) is the 2-char code needing the
  // "try every split" parseGameTeams branch: CRSAN→CR+SAN (2+3), CRUCHA→CRU+CHA (3+3-first, does NOT
  // grab CR) — the exact "Brasileirão's CR" case. Registries are per-key, so Kalshi ATL=Atlético
  // Mineiro here does not conflict with ligamx's ATL=Atlas. FORWARD WATCH: if Atlético Goianiense
  // reaches a later round, verify its code before that fixture (three "Atlético" clubs exist; only
  // Mineiro/ATL→CAM and Athletico-PR/CAP appear now, distinct on both sides).
  copadobrasil: [
    { abbr: "CAP" },                    // Athletico Paranaense
    { abbr: "ATL", espnScore: "CAM" },  // Atlético Mineiro
    { abbr: "CHA" },                    // Chapecoense
    { abbr: "COR" }, { abbr: "CRU" }, { abbr: "FLU" }, { abbr: "FOR" },  // Fortaleza
    { abbr: "GPA", espnScore: "GRE" },  // Grêmio
    { abbr: "INT" }, { abbr: "JUV" },   // Juventude
    { abbr: "MIR" }, { abbr: "PAL" },
    { abbr: "CR", espnScore: "REMO" },  // Remo
    { abbr: "SAN" },
    { abbr: "VDG", espnScore: "VAS" },  // Vasco da Gama
    { abbr: "VIT" },
  ],
  // NWSL (KXNWSLGAME, adopted 2026-07-23 — 3rd model-free maker league, same playbook, see
  // project_maker_modelfree_clubsoccer_2026_07_23 memory). Canonical = Kalshi's own ticker
  // abbrs, verified live via /api/kalshi-check 2026-07-23 — 14 of 16 teams confirmed (only 7
  // games were listed that day; Angel City FC and Racing Louisville hadn't appeared in a
  // ticker yet, so their Kalshi abbr is NOT guessed here — add when first seen, per this
  // session's "verify live, don't guess" discipline). Mostly 3-char except KC's 2-char code,
  // the one team requiring the "try every split" parseGameTeams branch (same class of problem
  // as MLS/brasileirao). espnScore only where ESPN's usa.nwsl scoreboard abbr differs (verified
  // live 2026-07-23): WSP→WAS (Washington Spirit), SAN→SD (San Diego Wave), REI→SEA (Seattle
  // Reign), URO→UTA (Utah Royals), NCC→NC (North Carolina Courage), PTH→POR (Portland Thorns),
  // GOT→GFC (Gotham FC), OPR→ORL (Orlando Pride), HDA→HOU (Houston Dash).
  nwsl: [
    { abbr: "WSP", espnScore: "WAS" },  // Washington Spirit
    { abbr: "DEN" },                    // Denver Summit FC
    { abbr: "SAN", espnScore: "SD" },   // San Diego Wave
    { abbr: "REI", espnScore: "SEA" },  // Seattle Reign
    { abbr: "URO", espnScore: "UTA" },  // Utah Royals
    { abbr: "NCC", espnScore: "NC" },   // North Carolina Courage
    { abbr: "KC" },                     // Kansas City Current
    { abbr: "BOS" },                    // Boston Legacy FC
    { abbr: "PTH", espnScore: "POR" },  // Portland Thorns
    { abbr: "GOT", espnScore: "GFC" },  // Gotham FC
    { abbr: "OPR", espnScore: "ORL" },  // Orlando Pride
    { abbr: "CHI" },                    // Chicago Stars FC
    { abbr: "HDA", espnScore: "HOU" },  // Houston Dash
    { abbr: "BAY" },                    // Bay FC
  ],
  // Chinese Super League (KXCHNSLGAME, adopted 2026-07-23 — 4th model-free maker league, same
  // playbook, see project_maker_modelfree_clubsoccer_2026_07_23 memory). Canonical = Kalshi's
  // own ticker abbrs, all 3-char (no mixed-length parseGameTeams special-case needed, unlike
  // mls/brasileirao/nwsl). espnScore mappings verified live via /api/kalshi-check 2026-07-23.
  // COLLISION GOTCHA: Kalshi's "SHE" is Shenzhen Peng City, which would collide with ESPN's
  // OWN "SHE" abbr for a DIFFERENT club (Shanghai Shenhua, id 977) — Kalshi's SHE maps to
  // ESPN's SHX (Shenzhen's real ESPN abbr), and Kalshi's SHS (Shanghai Shenhua) maps to ESPN's
  // SHE. Get this backwards and Shenzhen's games silently resolve as Shanghai Shenhua's.
  chnsl: [
    { abbr: "ZHP", espnScore: "ZHE" },  // Zhejiang Professional
    { abbr: "DAL", espnScore: "DYI" },  // Dalian Yingbo
    { abbr: "CHR", espnScore: "CHE" },  // Chengdu Rongcheng
    { abbr: "BJG", espnScore: "BG" },   // Beijing Guoan
    { abbr: "SHT" },                    // Shandong Taishan
    { abbr: "HEN" },                    // Henan
    { abbr: "YUN" },                    // Yunnan Yukun
    { abbr: "SHE", espnScore: "SHX" },  // Shenzhen Peng City — see collision note above
    { abbr: "WUH", espnScore: "WTT" },  // Wuhan Three Towns
    { abbr: "CHO" },                    // Chongqing Tonglianglong
    { abbr: "LIT", espnScore: "LIA" },  // Liaoning Tieren
    { abbr: "QIN" },                    // Qingdao Hainiu
    { abbr: "QWC" },                    // Qingdao West Coast
    { abbr: "SHP", espnScore: "SIPG" }, // Shanghai Port
    { abbr: "SHS", espnScore: "SHE" },  // Shanghai Shenhua — see collision note above
    { abbr: "TTT", espnScore: "TIG" },  // Tianjin Jinmen Tiger
  ],
  // Colombian Primera A / Liga DIMAYOR (KXDIMAYORGAME, adopted 2026-07-28 — 7th model-free maker
  // league, the FIRST built on the generalized MODEL_FREE_LEAGUES path). Surfaced by the
  // kalshi_series_seen baseline-backlog sweep (REAL_BOOK, 18 markets, 6¢ median spread, ~$39k
  // volume). Canonical = Kalshi's own ticker abbrs, all 3-char. Registry has 12 of ESPN's 20
  // teams — América de Cali, Int. de Bogotá, Jaguares de Córdoba, Cúcuta, Junior, Millonarios,
  // Santa Fe and Once Caldas had no live Kalshi ticker on ship day, so their Kalshi abbr was NOT
  // guessed (add when first seen; until then their tickers fail parseGameTeams and drop
  // failure-closed).
  // COLLISION GOTCHA (verified live by matching Kalshi event tickers to ESPN col.1 fixtures on
  // the SAME date, NOT guessed): Kalshi's "CAL" is subtitled just "Cali" and is Deportivo Cali,
  // whose real ESPN abbr is "DCI" — while ESPN's OWN "CAL" is Once Caldas, a different club from
  // Manizales that isn't in Cali at all. Proof: Kalshi KXDIMAYORGAME-26AUG01DIMCAL matched ESPN's
  // 2026-08-01 "Deportivo Cali at Independiente Medellín" (DIM vs DCI). Map CAL→CAL and every
  // Deportivo Cali game silently grades against Once Caldas. Note there are THREE Cali-area clubs
  // in this league (Deportivo Cali, América de Cali, and the unrelated Once Caldas abbr), which is
  // why a bare "Cali" subtitle cannot be trusted on its own.
  dimayor: [
    { abbr: "ADR", espnScore: "AGD" }, // Águilas Doradas Rionegro
    { abbr: "ALI", espnScore: "AFC" }, // Alianza FC Valledupar
    { abbr: "BUC" },                   // Atlético Bucaramanga
    { abbr: "CAL", espnScore: "DCI" }, // Deportivo Cali — see collision note above
    { abbr: "CAN", espnScore: "NAL" }, // Atlético Nacional
    { abbr: "CHI" },                   // Boyacá Chicó FC
    { abbr: "DIM" },                   // Independiente Medellín
    { abbr: "FOR" },                   // Fortaleza CEIF
    { abbr: "LLA" },                   // Llaneros FC
    { abbr: "PAS" },                   // Deportivo Pasto
    { abbr: "PER" },                   // Deportivo Pereira
    { abbr: "TOL" },                   // Deportes Tolima
  ],
  // Liga MX (KXLIGAMXGAME, adopted 2026-07-23 — 5th model-free maker league, same playbook,
  // see project_maker_modelfree_clubsoccer_2026_07_23 memory). Canonical = Kalshi's own ticker
  // abbrs, all 3-char (no mixed-length parseGameTeams special-case needed). Registry has 14 of
  // ~18 teams — Cruz Azul, Pumas UNAM, Toluca, and Mazatlán hadn't appeared in a live Kalshi
  // ticker as of ship date, so their Kalshi abbr wasn't guessed (add when first seen).
  // COLLISION GOTCHA (verified live via ESPN mex.1 scoreboard, NOT guessed): Kalshi's "ATL" is
  // Atlas, but ESPN's OWN "ATL" abbr is a DIFFERENT club, Atlante (id 226) — Kalshi separately
  // lists Atlante as "ALA". Kalshi ATL→ESPN ATS (Atlas's real ESPN abbr), Kalshi ALA→ESPN ATL
  // (Atlante's ESPN abbr, which collides textually with Kalshi's own ATL for Atlas). Get this
  // backwards and Atlas's games silently resolve as Atlante's.
  ligamx: [
    { abbr: "ALA", espnScore: "ATL" },  // Atlante — see collision note above
    { abbr: "AME" },                    // América
    { abbr: "ASL" },                    // Atlético San Luis
    { abbr: "ATL", espnScore: "ATS" },  // Atlas — see collision note above
    { abbr: "CDG", espnScore: "GDL" },  // Guadalajara (Chivas)
    { abbr: "JUA" },                    // FC Juárez
    { abbr: "LEO" },                    // León
    { abbr: "MON", espnScore: "MTY" },  // Monterrey
    { abbr: "NCX" },                    // Necaxa
    { abbr: "PAC" },                    // Pachuca
    { abbr: "QUE", espnScore: "QRO" },  // Querétaro
    { abbr: "SLA", espnScore: "SAN" },  // Santos Laguna
    { abbr: "TIG", espnScore: "UANL" }, // Tigres UANL
    { abbr: "TIJ" },                    // Tijuana
  ],
  // Scottish League Cup spread/total (KXSCOCUPSPREAD/KXSCOCUPTOTAL, adopted 2026-07-23 —
  // maker-viable per the two-track doctrine, model-free like the 5 GAME-winner leagues above,
  // but a THRESHOLD market shape, not 3-way ML — see project_scocup_spread_total_2026_07_23
  // memory). Canonical = ESPN's OWN sco.cis abbr, NOT Kalshi's — a deliberate deviation from
  // every other league in this file. Reason: Kalshi reuses its own 3-char code "DUN" for TWO
  // different clubs across different events (Dundee FC in one game, Dunfermline in another,
  // confirmed live via /api/kalshi-check subtitles) — a flat abbr→canonical map is unsafe even
  // before touching ESPN, so a Kalshi-abbr-keyed registry (the pattern every other league here
  // uses) cannot represent this competition correctly. `kalshiName` instead records the exact
  // human-readable name Kalshi prints in each market's subtitle ("Dunfermline wins by more than
  // 2.5 goals") — unambiguous even where the 3-char code collides — and tonight/scocup.js
  // resolves team identity from that text, never from the abbr. TICKER-NAME TRAP: despite the
  // "SCOCUP" prefix this is the Scottish LEAGUE Cup (ESPN slug sco.cis), NOT the Scottish Cup
  // proper (sco.tennents, FA-Cup equivalent) — the latter is dormant in July (next round starts
  // ~September) and returns zero events for these tickers' dates. Verified by cross-referencing
  // all 16 live event dates/teams against ESPN 2026-07-23; sco.tennents matched 0, sco.cis
  // matched 16/16.
  scocup: [
    { abbr: "ABE", kalshiName: "Aberdeen" },
    { abbr: "AIR", kalshiName: "Airdrieonians" },
    { abbr: "ALL", kalshiName: "Alloa" },
    { abbr: "ARB", kalshiName: "Arbroath" },
    { abbr: "AYR", kalshiName: "Ayr" },
    { abbr: "BRC", kalshiName: "Brechin" },
    { abbr: "CLY", kalshiName: "Clyde" },
    { abbr: "COVE", kalshiName: "Cove" },
    { abbr: "DFA", kalshiName: "Dunfermline" },     // Dunfermline — see collision note above
    { abbr: "DUM", kalshiName: "Dumbarton" },
    { abbr: "DUN", kalshiName: "Dundee FC" },        // Dundee FC — see collision note above
    { abbr: "EFIF", kalshiName: "East Fife" },
    { abbr: "ELG", kalshiName: "Elgin City" },
    { abbr: "FALK", kalshiName: "Falkirk" },
    { abbr: "FOR", kalshiName: "Forfar" },
    { abbr: "HAM", kalshiName: "Hamilton" },
    { abbr: "ICT", kalshiName: "Inverness" },
    { abbr: "KEL", kalshiName: "Kelty" },
    { abbr: "KIL", kalshiName: "Kilmarnock" },
    { abbr: "LIV", kalshiName: "Livingston" },
    { abbr: "MON", kalshiName: "Montrose" },
    { abbr: "MORT", kalshiName: "Greenock" },
    { abbr: "PET", kalshiName: "Peterhead" },
    { abbr: "QOS", kalshiName: "Queen of the South" },
    { abbr: "QUE", kalshiName: "Queen's Park" },
    { abbr: "ROSS", kalshiName: "Ross County" },
    { abbr: "SFC", kalshiName: "Spartans" },
    { abbr: "STE", kalshiName: "Stenhousemuir" },
    { abbr: "STI", kalshiName: "Stirling" },
    { abbr: "STJ", kalshiName: "St. Johnstone" },
    { abbr: "STM", kalshiName: "St. Mirren" },
    { abbr: "STR", kalshiName: "Stranraer" },
  ],
  // Argentina Liga Profesional de Fútbol ("Argentina Premier Division" on Kalshi) — game winner
  // + spread/total/BTTS (KXARGPREMDIVGAME/SPREAD/TOTAL/BTTS, adopted 2026-07-24 — found via the
  // 2141-row kalshi_series_seen baseline backlog sweep, see project_baseline_backlog_2026_07_24
  // memory). Canonical = Kalshi's own abbr (standard pattern, unlike scocup — Kalshi's OWN side
  // has only one real collision here, not a systemic one). Two landmines:
  // (1) COLLISION — Kalshi's "CAT" is Talleres Córdoba, which textually collides with ESPN's OWN
  //     "CAT" (a DIFFERENT club, Atlético Tucumán) — same class as CHNSL "SHE"/LigaMX "ATL".
  //     Kalshi's code for Tucumán is "TUC", mapped to ESPN's real "CAT" below.
  // (2) ESPN-OWN COLLISION (new class, not Kalshi's fault) — ESPN's OWN /teams endpoint reuses
  //     abbreviation "RIV" for TWO different real clubs: River Plate and Independiente
  //     Rivadavia (Kalshi correctly distinguishes them as "RIV" and "IRM"). A flat espnScore
  //     entry can't represent "two canonical codes map to the same ESPN abbr" — resolved instead
  //     in api/lib/argprem.js's canonTeam via the displayName soccer-modelfree.js now threads
  //     through (see its 2026-07-24 header comment): "RIV" abbr + displayName containing
  //     "Rivadavia" → canonical "IRM", else → canonical "RIV". No espnScore entry for RIV/IRM
  //     here — the logic lives in code, not the registry, since it needs the displayName.
  argprem: [
    { abbr: "BAN" },                    // Banfield
    { abbr: "BAR" },                    // Barracas Central
    { abbr: "BOC", espnScore: "CABJ" }, // Boca Juniors
    { abbr: "CAA", espnScore: "ALDO" }, // Aldosivi
    { abbr: "CAI", espnScore: "IND" },  // Independiente (Avellaneda)
    { abbr: "CAT", espnScore: "TALL" }, // Talleres (Córdoba) — see collision note above
    { abbr: "CC", espnScore: "CTR" },   // Central Córdoba (Santiago del Estero)
    { abbr: "DYJ" },                    // Defensa y Justicia
    { abbr: "ELP", espnScore: "EST" },  // Estudiantes de La Plata
    { abbr: "GEM", espnScore: "GMZ" },  // Gimnasia (Mendoza)
    { abbr: "GLP" },                    // Gimnasia La Plata
    { abbr: "HUR" },                    // Huracán
    { abbr: "IACC" },                   // Instituto (Córdoba)
    { abbr: "IRM" },                    // Independiente Rivadavia — see ESPN-own-collision note above
    { abbr: "LAN" },                    // Lanús
    { abbr: "NOB" },                    // Newell's Old Boys
    { abbr: "PLA" },                    // Platense
    { abbr: "RAC" },                    // Racing Club (Avellaneda)
    { abbr: "RCU", espnScore: "AAE" },  // Estudiantes de Río Cuarto
    { abbr: "RIE" },                    // Deportivo Riestra
    { abbr: "RIV" },                    // River Plate — see ESPN-own-collision note above
    { abbr: "SLA", espnScore: "SLO" },  // San Lorenzo de Almagro
    { abbr: "TIG" },                    // Tigre
    { abbr: "TUC", espnScore: "CAT" },  // Atlético Tucumán — see collision note above
    { abbr: "UNI", espnScore: "USF" },  // Unión (Santa Fe)
    { abbr: "VEL" },                    // Vélez Sarsfield
  ],
  // Dutch Eredivisie game winner (KXEREDIVISIEGAME, adopted 2026-08-07) + spread
  // (KXEREDIVISIESPREAD, adopted 2026-08-08). ESPN slug ned.1. Canonical = Kalshi's own 3-char
  // ticker abbrs — all uniform 3-char, no mixed-length parseGameTeams exception needed.
  // ESPN-side abbr mismatches verified live against ned.1 scoreboard:
  //   AZA → ESPN "AZ"  (AZ Alkmaar — ESPN drops the trailing A)
  //   FCU → ESPN "UTR" (FC Utrecht — ESPN uses city abbr, not FC-prefix)
  //   ZWO → ESPN "PEC" (PEC Zwolle — ESPN uses official club name abbreviation, not city)
  //   NIJ → ESPN "NEC" (NEC Nijmegen — ESPN uses club abbreviation, not city)
  // All 18 current-season clubs confirmed via live Kalshi tickers + ESPN ned.1 scoreboard 2026-08-08.
  // K League 1 — model-free maker (KXKLEAGUEGAME, built 2026-08-10). Settlement-authoritative;
  // no ESPN slug exists. All 12 teams verified live from open Kalshi markets 2026-08-10.
  // Uniform 3-char abbrs (no parseGameTeams variable-length path needed). No espnScore entries.
  kleague: [
    { abbr: "ULS" }, // Ulsan HD
    { abbr: "GAW" }, // Gangwon FC
    { abbr: "BUC" }, // Bucheon FC
    { abbr: "JEO" }, // Jeonbuk Hyundai Motors
    { abbr: "GWA" }, // Gwangju FC
    { abbr: "POH" }, // Pohang Steelers
    { abbr: "INC" }, // Incheon United
    { abbr: "GIS" }, // Gimcheon Sangmu
    { abbr: "JEJ" }, // Jeju United SK
    { abbr: "ANY" }, // FC Anyang
    { abbr: "SEO" }, // FC Seoul
    { abbr: "DAJ" }, // Daejeon Citizen
  ],
  eredivisie: [
    { abbr: "AJA" },                    // Ajax Amsterdam
    { abbr: "FEY" },                    // Feyenoord Rotterdam
    { abbr: "PSV" },                    // PSV Eindhoven
    { abbr: "AZA", espnScore: "AZ" },   // AZ Alkmaar — see mismatch note above
    { abbr: "TWE" },                    // FC Twente
    { abbr: "SPA" },                    // Sparta Rotterdam
    { abbr: "GRO" },                    // FC Groningen
    { abbr: "HEE" },                    // Heerenveen
    { abbr: "FCU", espnScore: "UTR" },  // FC Utrecht — see mismatch note above
    { abbr: "ZWO", espnScore: "PEC" },  // PEC Zwolle — see mismatch note above
    { abbr: "ADO" },                    // ADO Den Haag
    { abbr: "FOR" },                    // Fortuna Sittard
    { abbr: "TEL" },                    // Telstar
    { abbr: "NIJ", espnScore: "NEC" },  // NEC Nijmegen — see mismatch note above
    { abbr: "GAE" },                    // Go Ahead Eagles
    { abbr: "WIL" },                    // Willem II
    { abbr: "EXC" },                    // Excelsior Rotterdam
    { abbr: "CAM" },                    // SC Cambuur
  ],
  // English Premier League — model-free maker (KXEPLGAME, built 2026-08-10). ESPN slug eng.1
  // verified live. All 20 teams confirmed from KXPREMIERLEAGUE season-futures tickers 2026-08-10.
  // 5 ESPN-side mismatches: BRI→BHA, CFC→CHE, LFC→LIV, MCI→MNC, MUN→MAN.
  epl: [
    { abbr: "ARS" },                    // Arsenal
    { abbr: "AVL" },                    // Aston Villa
    { abbr: "BOU" },                    // Bournemouth
    { abbr: "BRE" },                    // Brentford
    { abbr: "BRI", espnScore: "BHA" },  // Brighton & Hove Albion
    { abbr: "CFC", espnScore: "CHE" },  // Chelsea
    { abbr: "COV" },                    // Coventry City
    { abbr: "CRY" },                    // Crystal Palace
    { abbr: "EVE" },                    // Everton
    { abbr: "FUL" },                    // Fulham
    { abbr: "HUL" },                    // Hull City
    { abbr: "IPS" },                    // Ipswich Town
    { abbr: "LEE" },                    // Leeds United
    { abbr: "LFC", espnScore: "LIV" },  // Liverpool
    { abbr: "MCI", espnScore: "MNC" },  // Manchester City
    { abbr: "MUN", espnScore: "MAN" },  // Manchester United
    { abbr: "NEW" },                    // Newcastle United
    { abbr: "NFO" },                    // Nottingham Forest
    { abbr: "SUN" },                    // Sunderland
    { abbr: "TOT" },                    // Tottenham Hotspur
  ],
  // La Liga (Spain) — model-free maker (KXLALIGAGAME, built 2026-08-10). ESPN slug esp.1
  // verified live. All 20 teams confirmed from KXLALIGA season-futures tickers 2026-08-10.
  // 5 ESPN-side mismatches: RBB→BET, RCC→CEL, RVC→RAY, SAN→RAC, VCF→VAL.
  laliga: [
    { abbr: "ALA" },                    // Alavés
    { abbr: "ATH" },                    // Athletic Club
    { abbr: "ATM" },                    // Atlético Madrid
    { abbr: "BAR" },                    // Barcelona
    { abbr: "DEP" },                    // Deportivo de La Coruña
    { abbr: "ELC" },                    // Elche CF
    { abbr: "ESP" },                    // Espanyol
    { abbr: "GET" },                    // Getafe
    { abbr: "LEV" },                    // Levante
    { abbr: "MCF" },                    // Málaga CF
    { abbr: "OSA" },                    // Osasuna
    { abbr: "RBB", espnScore: "BET" },  // Real Betis
    { abbr: "RCC", espnScore: "CEL" },  // Celta Vigo
    { abbr: "RMA" },                    // Real Madrid
    { abbr: "RSO" },                    // Real Sociedad
    { abbr: "RVC", espnScore: "RAY" },  // Rayo Vallecano
    { abbr: "SAN", espnScore: "RAC" },  // Racing Santander
    { abbr: "SEV" },                    // Sevilla
    { abbr: "VCF", espnScore: "VAL" },  // Valencia
    { abbr: "VIL" },                    // Villarreal
  ],
  // Serie A (Italy) — model-free maker (KXSERIEAGAME, built 2026-08-10). ESPN slug ita.1
  // verified live. All 20 teams confirmed from KXSERIEA season-futures tickers 2026-08-10.
  // 4 ESPN-side mismatches: ACM→MIL, BFC→BOL, COM→COMO, ROM→ROMA.
  seriea: [
    { abbr: "ACM", espnScore: "MIL" },  // AC Milan
    { abbr: "ATA" },                    // Atalanta
    { abbr: "BFC", espnScore: "BOL" },  // Bologna FC
    { abbr: "CAG" },                    // Cagliari
    { abbr: "COM", espnScore: "COMO" }, // Como 1907
    { abbr: "FIO" },                    // Fiorentina
    { abbr: "FRO" },                    // Frosinone
    { abbr: "GEN" },                    // Genoa
    { abbr: "INT" },                    // Inter Milan
    { abbr: "JUV" },                    // Juventus
    { abbr: "LAZ" },                    // Lazio
    { abbr: "LEC" },                    // Lecce
    { abbr: "MON" },                    // Monza
    { abbr: "NAP" },                    // Napoli
    { abbr: "PAR" },                    // Parma Calcio
    { abbr: "ROM", espnScore: "ROMA" }, // AS Roma
    { abbr: "SAS" },                    // Sassuolo
    { abbr: "TOR" },                    // Torino
    { abbr: "UDI" },                    // Udinese
    { abbr: "VEN" },                    // Venezia
  ],
  // Ligue 1 (France) — model-free maker (KXLIGUE1GAME, built 2026-08-10). ESPN slug fra.1
  // verified live. All 18 teams confirmed from KXLIGUE1 season-futures tickers 2026-08-10.
  // 11 ESPN-side mismatches (highest mismatch count of the Big 5): ASM→MON, EST→TRY, FCL→LOR,
  // LIL→LILL, MAN→MNS, NIC→NICE, OL→LYON, OM→OLM, RCS→STR, STB→BRE, TFC→TOU.
  // TWO 2-CHAR ABBRS: OL (Lyon) and OM (Marseille). These make 5-char HOME+AWAY strings
  // when either team plays (e.g. TFCOL, OMLIL). ligue1 MUST be in the parseGameTeams
  // variable-length allowlist (parse-teams.js line ~33) — see the copadobrasil note there.
  ligue1: [
    { abbr: "ANG" },                    // Angers SCO
    { abbr: "ASM", espnScore: "MON" },  // AS Monaco
    { abbr: "AUX" },                    // Auxerre
    { abbr: "EST", espnScore: "TRY" },  // ESTAC Troyes
    { abbr: "FCL", espnScore: "LOR" },  // FC Lorient
    { abbr: "HAC" },                    // Le Havre AC
    { abbr: "LIL", espnScore: "LILL" }, // Lille OSC
    { abbr: "MAN", espnScore: "MNS" },  // Le Mans FC
    { abbr: "NIC", espnScore: "NICE" }, // OGC Nice
    { abbr: "OL",  espnScore: "LYON" }, // Olympique Lyonnais — 2-char
    { abbr: "OM",  espnScore: "OLM" },  // Olympique de Marseille — 2-char
    { abbr: "PAR" },                    // Paris FC
    { abbr: "PSG" },                    // Paris Saint-Germain
    { abbr: "RCL" },                    // RC Lens
    { abbr: "RCS", espnScore: "STR" },  // RC Strasbourg Alsace
    { abbr: "REN" },                    // Stade Rennais
    { abbr: "STB", espnScore: "BRE" },  // Stade Brest 29
    { abbr: "TFC", espnScore: "TOU" },  // Toulouse FC
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

// Kalshi subtitle team name → canonical (ESPN) abbr, scocup only. Name-keyed instead of
// abbr-keyed because Kalshi's own 3-char codes collide for this competition (see the scocup
// registry comment above) — exact match on Kalshi's printed name sidesteps that entirely.
export const SCOCUP_NAME_TO_ESPN = Object.fromEntries(
  (TEAMS.scocup || []).filter(t => t.kalshiName).map(t => [t.kalshiName, t.abbr])
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
