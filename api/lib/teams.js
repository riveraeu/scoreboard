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
    { abbr: "HOU" }, { abbr: "IND" },
    // Kalshi spells Jacksonville "JAC" and Washington "WAS"; ESPN/canonical are JAX/WSH. Found
    // 2026-08-10 by diffing every live KXNFLGAME event ticker against the ESPN slate — without
    // these, 26AUG15JACNO / 26AUG14MIAWAS / 26SEP13CLEJAC / 26SEP13WASPHI all failed validation
    // and their markets vanished with no drop row. The once-per-league abbr collision, on schedule.
    { abbr: "JAX", kalshi: ["JAC"] }, { abbr: "KC" },
    { abbr: "LAC" },
    // Polymarket happens to reuse the same "la"/"was" abbrs as Kalshi's own aliases here (verified
    // live 2026-08-14 against all 32 team codes in the current preseason slate — every other code
    // matches canonical lowercase exactly).
    { abbr: "LAR", kalshi: ["LA"], polymarket: ["la"] },
    { abbr: "LV" }, { abbr: "MIA" }, { abbr: "MIN" }, { abbr: "NE" },
    { abbr: "NO" }, { abbr: "NYG" }, { abbr: "NYJ" }, { abbr: "PHI" },
    { abbr: "PIT" }, { abbr: "SEA" }, { abbr: "SF" }, { abbr: "TB" },
    { abbr: "TEN" }, { abbr: "WSH", kalshi: ["WAS"], polymarket: ["was"] },
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
  // COMPLETED 2026-08-10 from 12 → all 20 clubs. The 8 additions were forced by a live defect the
  // `gameTimeNullBySport` tripwire surfaced: the registry held only the teams seen by ship date, so
  // `parseGameTeams` fell through to its UNVALIDATED 3+3 fallback for everything else. That happened
  // to return the right answer for 3+3 pairs (DIMMIL → DIM+MIL) but silently invented teams on the
  // one 2-char code: `OCALI` → ["OCA","LI"] instead of ["OC","ALI"]. `dimayor` is now in
  // parseGameTeams' variable-length allowlist, which is only SAFE because the registry is complete —
  // that path validates BOTH halves against _VALID_TEAMS, so an incomplete registry would turn
  // parses that previously worked by luck into nulls and drop the rows outright.
  // Every mapping below verified against ESPN col.1 by deducing each unknown from its fixture
  // partner (the 20 Kalshi codes and the 20 ESPN abbrs form an exact bijection).
  // TWO-SIDED "CAL" COLLISION — the reason this registry is dangerous to eyeball:
  //   Kalshi CAL = Deportivo Cali  → ESPN DCI
  //   Kalshi OC  = Once Caldas     → ESPN CAL   (ESPN's own "CAL" is Once Caldas, NOT Cali)
  // So ESPN's CAL and Kalshi's CAL are different clubs. Without OC→CAL, identity passthrough sends
  // ESPN's Once Caldas fixtures to Kalshi's Deportivo Cali — a silent wrong-team match.
  dimayor: [
    { abbr: "ADR", espnScore: "AGD" }, // Águilas Doradas Rionegro
    { abbr: "ALI", espnScore: "AFC" }, // Alianza FC Valledupar
    { abbr: "AME" },                   // América de Cali
    { abbr: "BUC" },                   // Atlético Bucaramanga
    { abbr: "CAL", espnScore: "DCI" }, // Deportivo Cali — see collision note above
    { abbr: "CAN", espnScore: "NAL" }, // Atlético Nacional
    { abbr: "CHI" },                   // Boyacá Chicó FC
    { abbr: "CUC" },                   // Cúcuta Deportivo
    { abbr: "DIM" },                   // Independiente Medellín
    { abbr: "FOR" },                   // Fortaleza CEIF
    { abbr: "INT", espnScore: "BOG" }, // Internacional de Bogotá
    { abbr: "JAG", espnScore: "COR" }, // Jaguares de Córdoba
    { abbr: "JUN" },                   // Atlético Junior
    { abbr: "LLA" },                   // Llaneros FC
    { abbr: "MIL" },                   // Millonarios
    { abbr: "OC",  espnScore: "CAL" }, // Once Caldas — the 2-char code; see collision note above
    { abbr: "PAS" },                   // Deportivo Pasto
    { abbr: "PER" },                   // Deportivo Pereira
    { abbr: "SFE" },                   // Independiente Santa Fe
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
    // +4 completed 2026-08-10 (registry was 14 of 18 — the "add when first seen" note above).
    // All verified against ESPN mex.1 by same-date fixture partner; Mazatlán still has not
    // appeared in a live Kalshi ticker, so it stays unregistered.
    { abbr: "CRA", espnScore: "CAZ" },  // Cruz Azul
    { abbr: "PUE" },                    // Puebla
    { abbr: "PUM", espnScore: "UNAM" }, // Pumas UNAM
    { abbr: "TOL" },                    // Toluca
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
    // +4 completed 2026-08-10. These were the WORST of the sweep: argprem is in
    // parseGameTeams' variable-length allowlist, which validates BOTH halves — so an
    // unregistered club did not merely lose gameTime, it made the whole event parse to
    // [null,null] and DROP every row for that fixture. 17 of 75 event tickers were being
    // lost outright, invisible to gameTimeNullBySport because dropped rows never appear.
    // All four verified against ESPN arg.1 by same-date fixture partner.
    { abbr: "ARG",  espnScore: "ARGJ" }, // Argentinos Juniors
    { abbr: "CAB",  espnScore: "BEL"  }, // Belgrano (Córdoba)
    { abbr: "CARC", espnScore: "ROS"  }, // Rosario Central — 4-char Kalshi code
    { abbr: "CAS",  espnScore: "SARM" }, // Sarmiento (Junín)
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
  // Liga Portugal / Primeira Liga (KXLIGAPORTUGALGAME — adopted 2026-08-10). ESPN slug por.1.
  // WORST Kalshi-vs-ESPN abbr divergence of any league here: only 4 of 18 codes are identity
  // (ACV/ALV/CDN/FCP); the other 14 need an espnScore remap. Every mapping below was verified by
  // matching each Kalshi event ticker to the SAME-DATE por.1 fixture — not by name similarity,
  // which is exactly what would have gotten the two hard ones wrong:
  //   • EST/ESA is a genuine COLLISION. Kalshi EST = Estoril, but ESPN's OWN "EST" = Estrela.
  //     Kalshi ESA = Estrela Amadora. So an identity map on EST silently points Estoril at
  //     Estrela — the CHNSL "SHE" / LigaMX "ATL" / DIMAYOR "CAL" class, fourth instance.
  //   • CSM is subtitled only "Madeira", and BOTH Marítimo and Nacional are Madeira clubs
  //     (Kalshi lists Nacional separately as CDN). Resolved on evidence: Kalshi's 26AUG16FAMCSM
  //     is ESPN's "MAR (Maritimo) @ FCF (Famalicao)" on 2026-08-16 → CSM = Marítimo.
  // All 18 codes are uniformly 3-char, so no parseGameTeams allowlist entry is needed, and the
  // 18 ESPN abbrs are mutually distinct, so the default canonTeam inversion suffices (no
  // wrapCanonTeam — there is no ESPN-internal duplicate like argprem's RIV).
  ligaportugal: [
    { abbr: "ACV" },                     // Académico de Viseu
    { abbr: "ALV" },                     // Alverca
    { abbr: "ARO", espnScore: "FCA"  },  // Arouca
    { abbr: "BEN", espnScore: "SLB"  },  // SL Benfica
    { abbr: "BRA", espnScore: "SCB"  },  // SC Braga
    { abbr: "CAS", espnScore: "CPAC" },  // Casa Pia
    { abbr: "CDN" },                     // CD Nacional (Madeira)
    { abbr: "CSM", espnScore: "MAR"  },  // CS Marítimo — the other Madeira club; see note above
    { abbr: "ESA", espnScore: "EST"  },  // Estrela Amadora → ESPN's EST
    { abbr: "EST", espnScore: "EPF"  },  // Estoril → ESPN's EPF; NOT ESPN's EST
    { abbr: "FAM", espnScore: "FCF"  },  // FC Famalicão
    { abbr: "FCP" },                     // FC Porto
    { abbr: "GIL", espnScore: "GVFC" },  // Gil Vicente
    { abbr: "MOR", espnScore: "MFC"  },  // Moreirense
    { abbr: "RAV", espnScore: "RAFC" },  // Rio Ave
    { abbr: "SCL", espnScore: "CDSC" },  // Santa Clara (Azores)
    { abbr: "SPO", espnScore: "SCP"  },  // Sporting CP
    { abbr: "VIT", espnScore: "VSC"  },  // Vitória de Guimarães
  ],
  // KBO (Korean baseball, KXKBOGAME — adopted 2026-08-10). Canonical = Kalshi's own codes; no ESPN
  // slug exists for the KBO, so there is nothing to alias to and resolution is settlement-only.
  // All 10 clubs confirmed against live Kalshi subtitles 2026-08-10. NOTE the 2-char "LG": that
  // makes `kbo` a mandatory member of parseGameTeams' variable-length allowlist — the generic path
  // keys has2charPrefix on TEAM_NORM, which is EMPTY for a registry with no aliases, so LGKIW would
  // otherwise fall to an unvalidated split (the NFL GBSEA→["GBS","EA"] failure, same day).
  kbo: [
    { abbr: "DOO" }, // Doosan Bears
    { abbr: "HAN" }, // Hanwha Eagles
    { abbr: "KIA" }, // Kia Tigers
    { abbr: "KIW" }, // Kiwoom Heroes
    // Polymarket's own ticker abbrs are shorter than Kalshi's for these two (verified live
    // 2026-08-14 against all 10 teams; every other code matches canonical lowercase exactly).
    { abbr: "KTW", polymarket: ["kt"] },  // KT Wiz
    { abbr: "LG"  }, // LG Twins — the 2-char code; see allowlist note above
    { abbr: "LOT" }, // Lotte Giants
    { abbr: "NCD", polymarket: ["nc"] },  // NC Dinos
    { abbr: "SAM" }, // Samsung Lions
    { abbr: "SSG" }, // SSG Landers
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
  // Eerste Divisie (Dutch 2nd tier) — model-free maker (KXEERSTEDIVGAME, built 2026-08-14).
  // ESPN slug ned.2 verified live: exact same-date fixture match (VOL/OSS = FC Volendam/TOP Oss,
  // 2026-08-15, matching Kalshi's VOLOSS ticker precisely). Registry is every team observed across
  // live GAME-market tickers 8/14-8/21 (20 teams — the doctrine of adding teams only as first seen
  // in a live ticker, same as NWSL/LigaMX's partial rosters). **Unusually high mismatch rate (10/20)**
  // vs Eredivisie's 3/18: the Eerste Divisie fields several Eredivisie clubs' reserve ("Jong") sides,
  // and Kalshi's 3-char code drops the "Jong" prefix entirely (its own team-name text still shows
  // it, e.g. "Jong AZ Alkmaar") while ESPN's abbr keeps a leading J (JAZ/JAJ/JPS/JUT). A handful of
  // senior clubs also use Kalshi codes that don't match ESPN's own abbreviation scheme (city-based
  // vs club-name-based: BRE→NAC, WAA→RKC, ROD→RJC, MAA→MVV, OSS→TOP). All 10 mismatches verified by
  // same-date ESPN scoreboard cross-reference, not name similarity. **AZ is a 2-char Kalshi code**
  // (Jong AZ Alkmaar) mixed with 3-char everywhere else — `eerstediv` is in parseGameTeams'
  // variable-length-split allowlist for this reason (tonight/parse-teams.js).
  eerstediv: [
    { abbr: "ALM" },                    // Almere City FC
    { abbr: "PSV", espnScore: "JPS" },  // Jong PSV
    { abbr: "EIN" },                    // FC Eindhoven
    { abbr: "MAA", espnScore: "MVV" },  // MVV Maastricht
    { abbr: "HER" },                    // Heracles Almelo
    { abbr: "DBO" },                    // FC Den Bosch
    { abbr: "BRE", espnScore: "NAC" },  // NAC Breda
    { abbr: "VEN", espnScore: "VVV" },  // VVV-Venlo
    { abbr: "WAA", espnScore: "RKC" },  // RKC Waalwijk
    { abbr: "DOR" },                    // FC Dordrecht
    { abbr: "ROD", espnScore: "RJC" },  // Roda JC Kerkrade
    { abbr: "HEL" },                    // Helmond Sport
    { abbr: "VOL" },                    // FC Volendam
    { abbr: "OSS", espnScore: "TOP" },  // TOP Oss
    { abbr: "GRA" },                    // De Graafschap
    { abbr: "AZ",  espnScore: "JAZ" },  // Jong AZ Alkmaar
    { abbr: "AJA", espnScore: "JAJ" },  // Jong Ajax
    { abbr: "EMM" },                    // FC Emmen
    { abbr: "UTR", espnScore: "JUT" },  // Jong FC Utrecht
    { abbr: "VIT" },                    // Vitesse Arnhem
  ],
  // Bolivian Primera División — model-free maker (KXBOLPDIVGAME, built 2026-08-16). ESPN slug
  // bol.1 verified live: exact same-date fixture match against 2026-08-16's full 3-game Kalshi
  // slate (INDCLU, CNPABB, AREPOT — all three confirmed against bol.1's scoreboard for that date).
  // Registry is every team observed across that slate (6 teams) — add the rest only as first seen
  // in a live ticker, same doctrine as NWSL/LigaMX's partial rosters.
  // TWO-SIDED "POT" COLLISION — the reason this registry is dangerous to eyeball: Kalshi's own
  // "POT" is Real Potosi, but ESPN's own "POT" abbr is a DIFFERENT club, Nacional Potosi (Kalshi
  // calls that one "CNP"). Get this backwards and Real Potosi's games silently resolve as Nacional
  // Potosi's. All 4 remaps below verified by same-date fixture cross-reference, not name similarity.
  bolpd: [
    { abbr: "IND", espnScore: "CIP" },  // Independiente Petrolero
    { abbr: "CLU", espnScore: "GVSJ" }, // GV Club Deportivo San Jose de Oruro
    { abbr: "CNP", espnScore: "POT" },  // Nacional Potosi -- see collision note above
    { abbr: "ABB" },                    // Academia del Balompie Boliviano
    { abbr: "ARE", espnScore: "CAR" },  // Always Ready
    { abbr: "POT", espnScore: "RPO" },  // Real Potosi -- see collision note above
  ],
  // Belgian Pro League — model-free maker (KXBELGIANPLGAME, built 2026-08-17). ESPN slug bel.1
  // verified live: same-date fixture match (Club Brugge vs Cercle Brugge + Lommel vs Westerlo,
  // both 2026-08-23) against Kalshi's own slate. All 18 codes come from Kalshi's event `sub_title`
  // field ("BRU vs CER"), not guessed from team names. No ESPN-internal collision (all 18 ESPN
  // abbrs are mutually distinct) — the high mismatch rate below is just naming-convention drift
  // (Kalshi favors historical/short codes, ESPN favors its own abbreviation scheme), not a
  // collision requiring wrapCanonTeam. RAFC (4-char) needs the parseGameTeams variable-length
  // allowlist, same reason mls/leaguescup need it for LAFC/NYRB.
  belgianpl: [
    { abbr: "BRU" },                    // Club Brugge
    { abbr: "CER", espnScore: "CBK" },  // Cercle Brugge
    { abbr: "LOM" },                    // Lommel SK
    { abbr: "WES", espnScore: "KVCW" }, // KVC Westerlo
    { abbr: "RAFC", espnScore: "ANT" }, // Antwerp (Kalshi: Royal Antwerp FC)
    { abbr: "GEN", espnScore: "GENK" }, // Racing Genk
    { abbr: "KAA", espnScore: "GENT" }, // KAA Gent
    { abbr: "OHL" },                    // OH Leuven
    { abbr: "RCH", espnScore: "CHA" },  // Royal Charleroi SC
    { abbr: "YRM", espnScore: "KVM" },  // KV Mechelen (Kalshi code from "Yellow-Red Mechelen")
    { abbr: "ZUL" },                    // Zulte-Waregem
    { abbr: "BEV", espnScore: "WAA" },  // Waasland-Beveren
    { abbr: "STA", espnScore: "STL" },  // Standard Liège
    { abbr: "RAAL", espnScore: "RLL" }, // RAAL La Louvière
    { abbr: "STT", espnScore: "STVV" }, // Sint-Truidense
    { abbr: "KOR", espnScore: "KVK" },  // KV Kortrijk
    { abbr: "USG" },                    // Union St.-Gilloise
    { abbr: "RSC", espnScore: "AND" },  // Anderlecht (Kalshi: Royal Sporting Club Anderlecht)
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
  // J.League 1 (Japan) — model-free maker (KXJLEAGUEGAME, built 2026-08-10). ESPN slug jpn.1
  // verified live: 30/30 real books, 1¢ median spread (round 25). All 20 teams confirmed by
  // cross-referencing KXJLEAGUEGAME round-25 tickers with ESPN jpn.1 scoreboard 2026-08-14/15.
  // All Kalshi codes are 3-char — no parseGameTeams allowlist needed.
  // 11 ESPN-side mismatches: AVI→AVF, FAG→OKA, KAS→KAN, MAC→ZEL, MAR→YOK, MIT→MITO,
  //   NGE→NAG, REY→KRE, URD→URA, VER→TYKV, VIK→VIS.
  // NOTE: MIT→MITO and VER→TYKV are 4-char ESPN codes (same handling as ligue1's LILL/NICE/LYON).
  jleague: [
    { abbr: "AVI", espnScore: "AVF" },  // Avispa Fukuoka
    { abbr: "CER" },                    // Cerezo Osaka
    { abbr: "FAG", espnScore: "OKA" },  // Fagiano Okayama
    { abbr: "GAM" },                    // Gamba Osaka
    { abbr: "JEF" },                    // JEF United Ichihara-Chiba
    { abbr: "KAS", espnScore: "KAN" },  // Kashima Antlers
    { abbr: "KAW" },                    // Kawasaki Frontale
    { abbr: "KYO" },                    // Kyoto Sanga
    { abbr: "MAC", espnScore: "ZEL" },  // Machida Zelvia
    { abbr: "MAR", espnScore: "YOK" },  // Yokohama F. Marinos
    { abbr: "MIT", espnScore: "MITO" }, // Mito Hollyhock
    { abbr: "NGE", espnScore: "NAG" },  // Nagoya Grampus
    { abbr: "REY", espnScore: "KRE" },  // Kashiwa Reysol
    { abbr: "SAN" },                    // Sanfrecce Hiroshima
    { abbr: "SHI" },                    // Shimizu S-Pulse
    { abbr: "TOK" },                    // FC Tokyo
    { abbr: "URD", espnScore: "URA" },  // Urawa Red Diamonds
    { abbr: "VER", espnScore: "TYKV" }, // Tokyo Verdy 1969
    { abbr: "VIK", espnScore: "VIS" },  // Vissel Kobe
    { abbr: "VVN" },                    // V-Varen Nagasaki
  ],
  // La Liga 2 (Spain) — model-free maker (KXLALIGA2GAME, built 2026-08-10). ESPN slug esp.2
  // verified live: 22 teams, 33/33 real books, 5¢ median spread. KXLALIGA2 bare prefix = season
  // champion futures (empty shell 8/10, 0 live mkts) — added to DISMISSED_SERIES this commit.
  // All Kalshi codes are 3-char (no allowlist needed).
  // 4 confirmed ESPN mismatches from KXLALIGA2GAME round tickers cross-referenced 2026-08-10:
  //   CDE→ELD (CD Eldense), GIJ→RSG (Sporting Gijón), MAL→MLL (Mallorca), SAB→CDS (CD Sabadell).
  // RS2: Kalshi code for Real Sociedad II (ESPN: RSO2 4-char) — inferred; verify on first RS2×××
  // ticker (today's game is live but outside the 20-ticker kalshi-check sample). Wrong = 3 mkts drop.
  // CORRECTED 2026-08-10 (same day it shipped): three codes had been taken from ESPN's roster
  // instead of verified against live Kalshi tickers, the exact "cross-check BOTH sides" landmine.
  // Kalshi uses RCC / GCF / RSO where this registry had CEL / GRA / RS2 (the last was even
  // commented "Kalshi code inferred"). Those three clubs' markets therefore never matched an ESPN
  // fixture, so they logged with gameTime:null — surfaced by gameTimeNullBySport at 27%.
  // The stale codes are REPLACED, not kept alongside: two of them would otherwise collide on the
  // inverse map (both RS2→RSO2 and RSO→RSO2 exist, and Object.fromEntries takes last-wins, so the
  // ESPN→canonical direction becomes ambiguous). Safe to drop because only OPEN markets are ever
  // captured — settled history is already graded and never re-parsed.
  // Note the seven codes seen ONLY in settled markets (DEP/HUE/LEO/MCF/MIR/SAN/ZAR) are last
  // season's Segunda clubs, promoted or relegated out; deliberately NOT registered.
  laliga2: [
    { abbr: "ALB" },                    // Albacete Balompié
    { abbr: "ALM" },                    // UD Almería
    { abbr: "AND" },                    // FC Andorra
    { abbr: "BUR" },                    // Burgos CF
    { abbr: "CAD" },                    // Cádiz CF
    { abbr: "CAS" },                    // CD Castellón
    { abbr: "CDE", espnScore: "ELD" },  // CD Eldense
    { abbr: "RCC", espnScore: "CEL" },  // RC Celta Fortuna — Kalshi says RCC, not CEL (see note)
    { abbr: "CEU" },                    // Ceuta FC
    { abbr: "COR" },                    // Córdoba CF
    { abbr: "EIB" },                    // SD Eibar
    { abbr: "GIJ", espnScore: "RSG" },  // Sporting Gijón
    { abbr: "GIR" },                    // Girona FC
    { abbr: "GCF", espnScore: "GRA" },  // Granada CF — Kalshi says GCF, not GRA (see note)
    { abbr: "LEG" },                    // CD Leganés
    { abbr: "LPA" },                    // UD Las Palmas
    { abbr: "MAL", espnScore: "MLL" },  // RCD Mallorca
    { abbr: "OVI" },                    // Real Oviedo
    { abbr: "RSO", espnScore: "RSO2" }, // Real Sociedad II — Kalshi says RSO (the guess was RS2)
    { abbr: "SAB", espnScore: "CDS" },  // CD Sabadell
    { abbr: "TEN" },                    // CD Tenerife
    { abbr: "VLL" },                    // Real Valladolid
  ],
  // USL Championship (USA) — model-free maker (KXUSLGAME, built 2026-08-10). ESPN slug usa.usl.1
  // verified live: 24 teams confirmed, 39/39 real books, 2¢ median spread. KXUSL bare prefix =
  // season champion futures (25 mkts, 1 per team) — added to DISMISSED_SERIES this commit.
  // ESPN-internal collision: both Louisville City (Kalshi: LFC) and Loudoun United FC (Kalshi: LOU)
  // map to ESPN abbreviation "LOU" — resolved via displayName in model-free-leagues.js wrapCanonTeam.
  // OC (Orange County SC) is 2-char Kalshi → usl added to parse-teams.js variable-length allowlist.
  // 11 confirmed ESPN mismatches (kalshi-check 20-ticker sample + ESPN scoreboard 2026-08-10):
  //   SRP→SAC, LAS→LVL, BRO→BFKC(4-char), OC→OCSC(4-char), LFC→LOU (collision!), MON→MTB,
  //   NEW→NMU, SAN→SAFC(4-char), PAS→ELP, CSS→COS, BIR→BRM. IND→INDY(4-char Indy Eleven).
  //   9 codes inferred as identity from ESPN (CHS, DET, HFD, JAX, LOU, MIA, PIT, RHI, TBR).
  usl: [
    { abbr: "BIR", espnScore: "BRM" },  // Birmingham Legion FC
    { abbr: "BRO", espnScore: "BFKC" }, // Brooklyn FC
    { abbr: "CHS" },                    // Charleston Battery
    { abbr: "CSS", espnScore: "COS" },  // Colorado Springs Switchbacks FC
    { abbr: "DET" },                    // Detroit City FC
    { abbr: "HFD" },                    // Hartford Athletic
    { abbr: "IND", espnScore: "INDY" }, // Indy Eleven (ESPN uses 4-char "INDY")
    { abbr: "JAX" },                    // Sporting JAX
    { abbr: "LAS", espnScore: "LVL" },  // Las Vegas Lights FC
    { abbr: "LEX" },                    // Lexington SC
    { abbr: "LFC", espnScore: "LOU" },  // Louisville City FC — ESPN "LOU" also = Loudoun United
    { abbr: "LOU" },                    // Loudoun United FC — ESPN also "LOU"; wrapCanonTeam disambiguates
    { abbr: "MIA" },                    // Miami FC
    { abbr: "MON", espnScore: "MTB" },  // Monterey Bay FC
    { abbr: "NEW", espnScore: "NMU" },  // New Mexico United
    { abbr: "OAK" },                    // Oakland Roots SC
    { abbr: "OC",  espnScore: "OCSC" }, // Orange County SC — 2-char Kalshi code
    { abbr: "PAS", espnScore: "ELP" },  // El Paso Locomotive FC
    { abbr: "PIT" },                    // Pittsburgh Riverhounds SC
    { abbr: "RHI" },                    // Rhode Island FC
    { abbr: "SAN", espnScore: "SAFC" }, // San Antonio FC
    { abbr: "SRP", espnScore: "SAC" },  // Sacramento Republic FC
    { abbr: "TBR" },                    // Tampa Bay Rowdies
    { abbr: "TUL" },                    // FC Tulsa
  ],
  // Copa Libertadores — model-free maker (KXCONMEBOLLIBGAME, built 2026-08-10). ESPN slug conmebol.libertadores
  // verified live: 16 teams (QF stage), 24/24 real books, 2¢ median spread. KXCONMEBOLLIB bare prefix
  // = tournament-winner futures (same class as KXPREMIERLEAGUE) — added to DISMISSED_SERIES this commit.
  // UC (Universidad Católica) is 2-char Kalshi + CARC (Rosario Central) is 4-char → copalib added to
  // parse-teams.js variable-length allowlist.
  // 5 confirmed ESPN mismatches (kalshi-check subtitles cross-referenced 2026-08-10/11):
  //   CARC→ROS (Rosario Central), CPO→CPT (Cerro Porteño), ELP→EST (Estudiantes de La Plata),
  //   IND→IDV (Independiente del Valle), UC→CDUC (4-char, Universidad Católica).
  // FLU (Fluminense) and RIV (Independiente Rivadavia) inferred as identity — not in 20-ticker sample;
  // wrong = Aug 11 FLURIV game (3 mkts) drops. Verify on first copa lib aug 11 ticker.
  copalib: [
    { abbr: "CARC", espnScore: "ROS" }, // Rosario Central — 4-char Kalshi code
    { abbr: "COQ" },                    // Coquimbo Unido
    { abbr: "COR" },                    // Corinthians
    { abbr: "CPO",  espnScore: "CPT" }, // Cerro Porteño
    { abbr: "CRU" },                    // Cruzeiro
    { abbr: "ELP",  espnScore: "EST" }, // Estudiantes de La Plata
    { abbr: "FLA" },                    // Flamengo
    { abbr: "FLU" },                    // Fluminense — inferred identity; see note above
    { abbr: "IND",  espnScore: "IDV" }, // Independiente del Valle
    { abbr: "LDU" },                    // LDU Quito
    { abbr: "MIR" },                    // Mirassol
    { abbr: "PAL" },                    // Palmeiras
    { abbr: "PLA" },                    // Platense
    { abbr: "RIV" },                    // Independiente Rivadavia — inferred identity; see note above
    { abbr: "TOL" },                    // Deportes Tolima
    { abbr: "UC",   espnScore: "CDUC" }, // Universidad Católica — 2-char Kalshi, 4-char ESPN
  ],
};

// ── Leagues Cup: a DERIVED registry, not a hand-written one (2026-08-11) ─────────
//
// KXLEAGUESCUPGAME is the first CROSS-LEAGUE competition in this repo: every group-phase fixture
// is an MLS club against a Liga MX club, so its team set is exactly `mls ∪ ligamx`. Writing 36
// literal records would duplicate both parents and silently rot the moment either one is corrected
// — so the registry is derived, and a rebrand or espnScore fix upstream propagates for free.
//
// Verified live 2026-08-11 against ESPN `concacaf.leagues.cup` and Kalshi's own market subtitles:
// all 36 codes across OPEN ∪ SETTLED markets resolve, and every Liga MX ESPN remap the tournament
// needs (CRA→CAZ, SLA→SAN, CDG→GDL, QUE→QRO, MON→MTY, TIG→UANL, PUM→UNAM) was ALREADY correct in
// the ligamx registry — ESPN uses the same abbreviations here as it does on mex.1. The MLS side
// identity-maps (12/12 confirmed against same-date fixtures).
//
// **ligamx is applied SECOND so it wins collisions, and that is the whole point.** The two parents
// overlap on exactly ONE abbr: `ATL`. Kalshi's subtitles prove `ATL` = Atlas and `ALA` = Atlante,
// and the ligamx registry already carries both (ATL→ATS, ALA→ATL). MLS's ATL is Atlanta United and
// has no espnScore, so an mls-wins union would identity-map Atlas onto ESPN's `ATL` — which in THIS
// competition is Atlante. A different club, mapped silently, with no tripwire: the same two-sided
// collision class as dimayor's CAL. teams.test.js pins the overlap set to exactly {ATL}, so a
// SECOND collision introduced by any future rebrand fails the suite instead of resolving quietly.
//
// Limitation worth knowing: this pins `ATL` to Atlas for all time. Atlanta United did not qualify
// for the 2026 edition; if it ever does, Kalshi must disambiguate and the mapping has to be
// re-derived from subtitles rather than assumed.
TEAMS.leaguescup = (() => {
  const byAbbr = new Map();
  for (const t of TEAMS.mls) byAbbr.set(t.abbr, t);
  for (const t of TEAMS.ligamx) byAbbr.set(t.abbr, t); // ligamx wins ATL (Atlas, not Atlanta)
  return [...byAbbr.values()];
})();

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
