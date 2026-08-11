// Shared Kalshi series configuration.
// Imported by tonight.js (play pipeline) and kalshi.js (snapshot cron).
// To add a new series: add it here — both consumers update automatically.

export const SERIES_CONFIG = {
  // Player props
  KXNBAPTS:    { sport: "nba",  league: "nba",  stat: "points",         col: "PTS" },
  KXNBAREB:    { sport: "nba",  league: "nba",  stat: "rebounds",       col: "REB" },
  KXNBAAST:    { sport: "nba",  league: "nba",  stat: "assists",        col: "AST" },
  KXNBA3PT:    { sport: "nba",  league: "nba",  stat: "threePointers",  col: "3PT" },
  KXWNBAPTS:   { sport: "wnba", league: "wnba", stat: "points",         col: "PTS" },
  KXWNBAREB:   { sport: "wnba", league: "wnba", stat: "rebounds",       col: "REB" },
  KXWNBAAST:   { sport: "wnba", league: "wnba", stat: "assists",        col: "AST" },
  KXWNBA3PT:   { sport: "wnba", league: "wnba", stat: "threePointers",  col: "3PT" },
  KXNHLPTS:    { sport: "nhl",  league: "nhl",  stat: "points",         col: "PTS" },
  KXMLBKS:     { sport: "mlb",  league: "mlb",  stat: "strikeouts",     col: "K"   },
  KXMLBHRR:    { sport: "mlb",  league: "mlb",  stat: "hrr",            col: "HRR" },
  KXMLBHIT:    { sport: "mlb",  league: "mlb",  stat: "hits",           col: "H"   },
  KXMLBTB:     { sport: "mlb",  league: "mlb",  stat: "totalBases",     col: "TB"  },
  // Pitcher outs-recorded O/U ("Senga: 15+"). The `mlbOuts` gameType routes these to the dedicated
  // emit path (api/lib/tonight/mlb-outs.js): Normal workload model off pitcherStatsByName (avgBF ×
  // out-rate), favorite side. Prop-shaped rows reuse the player-prop resolver. Shadow-only: `mlb|outs`
  // is intentionally NOT in the category gate.
  KXMLBOUTS:   { sport: "mlb",  league: "mlb",  stat: "outs",           col: "OUTS", gameType: "mlbOuts" },
  KXNFLPAYDS:  { sport: "nfl",  league: "nfl",  stat: "passingYards",   col: "YDS" },
  KXNFLRUYDS:  { sport: "nfl",  league: "nfl",  stat: "rushingYards",   col: "YDS" },
  KXNFLREYDS:  { sport: "nfl",  league: "nfl",  stat: "receivingYards", col: "YDS" },
  KXNFLTDS:    { sport: "nfl",  league: "nfl",  stat: "touchdowns",     col: "TD"  },
  // Tennis match-winner (ATP + WTA) — binary, player-vs-player. The `tennisMatch` gameType
  // routes these to the dedicated tennis emit path (api/lib/tonight/tennis-match.js) instead
  // of parseGameTeams. Shadow-only: `tennis|match` is intentionally NOT in the category gate.
  KXATPMATCH:  { sport: "tennis", league: "atp", tour: "atp", stat: "match", col: "ML", gameType: "tennisMatch" },
  KXWTAMATCH:  { sport: "tennis", league: "wta", tour: "wta", stat: "match", col: "ML", gameType: "tennisMatch" },
  // World Cup soccer (KXWC* — `soccer` + `soccerAdvance` gameTypes) REMOVED 2026-08-04 with the
  // model teardown: the Dixon–Coles model was deleted and the tournament is off-season (0 live
  // markets). Historical `soccer|*` rows keep grading off Kalshi settlement (still in
  // SETTLEMENT_AUTHORITATIVE_SPORTS + the resolver's own-sports set).
  // Fighting — UFC rounds O/U ("Will the fight end before round N?"). The `fight` gameType
  // routes these to the dedicated fight emit path (api/lib/tonight/fight.js): one weight-class
  // finish-rate → fight-duration CDF per bout. Shadow-only: `fight|rounds` is NOT in the gate.
  KXUFCROUNDS:   { sport: "fight", league: "ufc", stat: "rounds", col: "RD", gameType: "fight" },
  // Golf PGA H2H — model-free maker (rebuilt 2026-08-07). gameTime from ESPN PGA scoreboard
  // round `date` field (tournament-level, sufficient for the pre-game gate). YES + NO sides
  // captured independently. Resolution: settlement-authoritative.
  KXPGAH2H: { sport: "golf", league: "pga", stat: "h2h", col: "ML", gameType: "golfH2h" },
  // NASCAR — Cup head-to-head ("Will A beat B?") + Top-10 finish ("Will <driver> finish top 10?").
  // The `nascar` gameType routes both to the dedicated emit path (api/lib/tonight/nascar.js):
  // recent-form finishing-position model. Binary favorite side. Cup-only by construction (the
  // rating index is built from the Cup schedule). Shadow-only: `nascar|h2h`/`nascar|top10` NOT gated.
  KXNASCARH2H:   { sport: "nascar", league: "nascar", stat: "h2h",   col: "ML", gameType: "nascar", subtype: "h2h"   },
  KXNASCARTOP10: { sport: "nascar", league: "nascar", stat: "top10", col: "ML", gameType: "nascar", subtype: "top10" },
  // NBA Summer League (KXNBASUMMERGAME — `nbaSummer`) REMOVED 2026-08-04 with the model teardown:
  // the within-tournament Elo model was deleted and the ~11-day July tournament is over (0 live
  // markets). Historical `nbasl|ml` rows keep grading off Kalshi settlement.
  // LMB (Liga Mexicana de Béisbol) game winner — binary team ML. The `lmbGame` gameType routes
  // these to the dedicated emit path (api/lib/tonight/lmb-ml.js): season standings run-rate λ
  // pair → existing simulateMLBJoint NegBin joint (api/lib/lmb.js; statsapi sportId 23 /
  // leagueId 125, id-keyed via the teams.js lmb registry). Adopted 2026-07-15, reversing the
  // 7/01 dead-book dismissal: the recheck found real MM books on game-day markets (~600-contract
  // volume, multi-level depth, 1–18¢ spreads; far-out listings still quote ~48¢ placeholders,
  // which the parse-time spread gate skips). Dense daily slate (~8-10 games/day) = the highest
  // capture-per-effort baseball build. Shadow-only: `lmb|ml` is NOT in the category gate.
  KXLMBGAME: { sport: "lmb", league: "lmb", stat: "ml", col: "ML", gameType: "lmbGame" },
  // MLS (Major League Soccer) game winner — 3-way (home/away/tie), model-free: no probability
  // model at all (the maker strategy only needs a real gameTime + a way to resolve the result,
  // see project_maker_modelfree_clubsoccer_2026_07_23 memory). The `clubSoccerMl` gameType
  // routes these to the shared model-free emit path (api/lib/tonight/model-free-ml.js): parseGameTeams
  // for the variable-length MLS abbrs, real gameTime fetched from ESPN's usa.1 scoreboard
  // (api/lib/mls.js) — unlike every other Phase-1 shadow-only module, which hardcodes
  // gameTime:null and is therefore silently NEVER maker-quotable (found 2026-07-23; fixed here
  // for MLS only, the other 8 modules are a tracked follow-up, not yet fixed). Adopted
  // 2026-07-23 after a live liquidity recheck (corrected an earlier wrong-field-name read):
  // real 1¢-spread books, volume in the hundreds-to-thousands per market. `mls|game` is NOT in
  // the category gate (shadow-only, maker-only).
  KXMLSGAME: { sport: "mls", league: "mls", stat: "game", col: "ML", gameType: "modelFreeMl" },
  // Brasileirão Série A (Brazil) game winner — same model-free playbook one league later
  // (adopted 2026-07-23, see project_maker_modelfree_clubsoccer_2026_07_23 memory + the
  // 2026-07-23 build-decision review: picked as the highest-liquidity confirmed-real league
  // from the historical two-track sweep, 36/36 markets with real two-sided books, volumes up
  // to ~30k contracts). Dedicated gameType (not clubSoccerMl) since it needs its own parse
  // branch/array — resolves off a different ESPN league endpoint (bra.1, not usa.1) per row.
  KXBRASILEIROGAME: { sport: "brasileirao", league: "brasileirao", stat: "game", col: "ML", gameType: "modelFreeMl" },
  // NWSL (National Women's Soccer League) game winner — 3rd model-free maker league, same
  // playbook (adopted 2026-07-23, see project_maker_modelfree_clubsoccer_2026_07_23 memory).
  // Picked over KXUSLGAME (also 36/36 real books) because USL has a genuine ESPN-side team-
  // abbreviation collision (Louisville City FC and Loudoun United FC both "LOU") — NWSL had
  // zero such collisions across its confirmed roster. Dedicated gameType (own parse branch/
  // array, resolves off usa.nwsl not usa.1/bra.1).
  KXNWSLGAME: { sport: "nwsl", league: "nwsl", stat: "game", col: "ML", gameType: "modelFreeMl" },
  // Chinese Super League game winner — 4th model-free maker league, same playbook (adopted
  // 2026-07-23, see project_maker_modelfree_clubsoccer_2026_07_23 memory). First league built
  // directly onto the shared ESPN-fetch engine (api/lib/soccer-modelfree.js) — MLS/Brasileirão/
  // NWSL were refactored onto it in the same session once this 4th league made the duplication
  // worth generalizing. Dedicated gameType (own parse branch/array, resolves off chn.1).
  KXCHNSLGAME: { sport: "chnsl", league: "chnsl", stat: "game", col: "ML", gameType: "modelFreeMl" },
  // Liga MX (Mexico) game winner — 5th model-free maker league, same playbook (adopted
  // 2026-07-23, see project_maker_modelfree_clubsoccer_2026_07_23 memory). Built on the shared
  // ESPN-fetch engine (api/lib/soccer-modelfree.js). Dedicated gameType (own parse branch/
  // array, resolves off mex.1).
  KXLIGAMXGAME: { sport: "ligamx", league: "ligamx", stat: "game", col: "ML", gameType: "modelFreeMl" },
  // MLS + Liga MX 1H spread/total/BTTS + full-game team-total — maker-viable derivatives of the
  // base ML markets above (adopted 2026-07-23, see project_mls_ligamx_threshold_2026_07_23
  // memory). 1H family reuses the clubSoccerMl/ligamxMl gameType + emit path (same ticker/
  // suffix shape as the base GAME market, tagged `half:"1h"`); spread/total/BTTS/teamTotal route
  // through the shared `clubSoccerThreshold` gameType (api/lib/tonight/club-soccer-threshold.js).
  KXMLS1H:         { sport: "mls",    league: "mls",    stat: "1hgame", col: "ML", gameType: "modelFreeMl", half: "1h" },
  KXMLS1HBTTS:     { sport: "mls",    league: "mls",    stat: "1hbtts", col: "G",  gameType: "clubSoccerThreshold", subtype: "btts",      half: "1h" },
  KXMLS1HSPREAD:   { sport: "mls",    league: "mls",    stat: "1hspread", col: "G", gameType: "clubSoccerThreshold", subtype: "spread",  half: "1h" },
  KXMLS1HTOTAL:    { sport: "mls",    league: "mls",    stat: "1htotal", col: "G", gameType: "clubSoccerThreshold", subtype: "total",    half: "1h" },
  KXMLSTEAMTOTAL:  { sport: "mls",    league: "mls",    stat: "teamTotal", col: "G", gameType: "clubSoccerThreshold", subtype: "teamTotal" },
  KXLIGAMX1H:      { sport: "ligamx", league: "ligamx", stat: "1hgame", col: "ML", gameType: "modelFreeMl", half: "1h" },
  KXLIGAMX1HBTTS:  { sport: "ligamx", league: "ligamx", stat: "1hbtts", col: "G",  gameType: "clubSoccerThreshold", subtype: "btts",      half: "1h" },
  KXLIGAMX1HSPREAD:{ sport: "ligamx", league: "ligamx", stat: "1hspread", col: "G", gameType: "clubSoccerThreshold", subtype: "spread",  half: "1h" },
  KXLIGAMX1HTOTAL: { sport: "ligamx", league: "ligamx", stat: "1htotal", col: "G", gameType: "clubSoccerThreshold", subtype: "total",    half: "1h" },
  KXLIGAMXTEAMTOTAL:{ sport: "ligamx", league: "ligamx", stat: "teamTotal", col: "G", gameType: "clubSoccerThreshold", subtype: "teamTotal" },
  // Argentina Liga Profesional de Fútbol game winner + full-game spread/total/BTTS — model-free,
  // found via the 2141-row kalshi_series_seen baseline backlog sweep (adopted 2026-07-24, see
  // project_baseline_backlog_2026_07_24 memory). GAME reuses the clubSoccerMl-style dedicated
  // module (api/lib/tonight/model-free-ml.js); spread/total/BTTS route through the shared
  // clubSoccerThreshold gameType (no half tag — full game). Two team-mapping landmines: Kalshi's
  // "CAT" (Talleres Córdoba) collides with ESPN's OWN "CAT" (Atlético Tucumán); ESPN's OWN
  // /teams endpoint reuses "RIV" for both River Plate and Independiente Rivadavia — see the
  // argprem registry comment in teams.js.
  // Colombian Primera A / Liga DIMAYOR game winner (adopted 2026-07-28) — 7th model-free
  // league and the first to ship as pure config: one registry entry + this row, no new
  // files. Found by the kalshi_series_seen baseline sweep (REAL_BOOK, 6¢ median spread).
  KXDIMAYORGAME:      { sport: "dimayor", league: "dimayor", stat: "game",     col: "ML", gameType: "modelFreeMl" },
  // Copa do Brasil game winner (adopted 2026-08-04) — 8th model-free league, pure config like
  // DIMAYOR. Surfaced by the morning-report discovery vet queue (REAL_BOOK, 2¢ median spread,
  // overround 1.02). ESPN slug bra.copa_do_brazil; registry shares brasileirao's espnScore aliases.
  KXCOPADOBRASILGAME: { sport: "copadobrasil", league: "copadobrasil", stat: "game", col: "ML", gameType: "modelFreeMl" },
  // Dutch Eredivisie game winner — 9th model-free maker league, pure config (adopted 2026-08-07).
  // 30/30 real books, 1¢ median spread, overround 1.01. ESPN slug ned.1.
  KXEREDIVISIEGAME:     { sport: "eredivisie", league: "eredivisie", stat: "game",   col: "ML", gameType: "modelFreeMl" },
  KXEREDIVISIESPREAD:   { sport: "eredivisie", league: "eredivisie", stat: "spread", col: "G",  gameType: "clubSoccerThreshold", subtype: "spread" },
  KXCOPADOBRASILTOTAL:  { sport: "copadobrasil", league: "copadobrasil", stat: "total",  col: "G", gameType: "clubSoccerThreshold", subtype: "total" },
  KXCOPADOBRASILSPREAD: { sport: "copadobrasil", league: "copadobrasil", stat: "spread", col: "G", gameType: "clubSoccerThreshold", subtype: "spread" },
  KXARGPREMDIVGAME:   { sport: "argprem", league: "argprem", stat: "game",     col: "ML", gameType: "modelFreeMl" },
  KXARGPREMDIVSPREAD: { sport: "argprem", league: "argprem", stat: "spread",   col: "G",  gameType: "clubSoccerThreshold", subtype: "spread" },
  KXARGPREMDIVTOTAL:  { sport: "argprem", league: "argprem", stat: "total",    col: "G",  gameType: "clubSoccerThreshold", subtype: "total" },
  KXARGPREMDIVBTTS:   { sport: "argprem", league: "argprem", stat: "btts",     col: "G",  gameType: "clubSoccerThreshold", subtype: "btts" },
  // Scottish League Cup spread + total — maker-viable, model-free (adopted 2026-07-23, see
  // project_scocup_spread_total_2026_07_23 memory). First model-free THRESHOLD market (the 5
  // leagues above are all 3-way ML) — dedicated emit path (api/lib/tonight/scocup.js) pushes
  // over/under rows per threshold, no probability model. TICKER-NAME TRAP: despite the "SCOCUP"
  // prefix this is the Scottish LEAGUE Cup (ESPN sco.cis), NOT the Scottish Cup proper
  // (sco.tennents, dormant until ~September) — verified live, sco.tennents matched 0 of the 16
  // live events, sco.cis matched 16/16. Team identity resolved from each market's subtitle text,
  // not the 3-char ticker code — see the scocup registry comment in teams.js for the "DUN" abbr
  // collision (Dundee FC vs Dunfermline) that makes an abbr-keyed map unsafe here.
  KXSCOCUPSPREAD: { sport: "scocup", league: "scocup", stat: "spread", col: "G", gameType: "scocupSpread" },
  KXSCOCUPTOTAL:  { sport: "scocup", league: "scocup", stat: "total",  col: "G", gameType: "scocupTotal"  },
  // eSports — Dota 2 match-winner (KXDOTA2GAME). Kalshi lists one YES market per team per match
  // (e.g. KXDOTA2GAME-26AUG071100LVLUPFTS-LVLUP and -FTS for the same event). gameType:dota2Game
  // routes to emitDota2ModelFreePlays (api/lib/tonight/dota2-modelfree.js); YES-side only captured
  // since each team has its own YES market. gameTime from ticker (YYMONDDHHMMM ET→UTC). 1¢ median
  // spread, overround ~1.00. Settlement-authoritative (dota2 in SETTLEMENT_AUTHORITATIVE_SPORTS).
  // Team codes are ephemeral eSports orgs — no teams.js registry; ticker suffix is the team code.
  KXDOTA2GAME: { sport: "dota2", league: "dota2", stat: "ml", col: "ML", gameType: "dota2Game" },
  // K League 1 match-winner (KXKLEAGUEGAME). 3-way binary markets (homeTeam / awayTeam / TIE);
  // all three YES sides captured. gameDate from ticker (YYMONDD), gameTime=null —
  // occurrence_datetime is post-game settlement expiration, not kickoff; no ESPN slug.
  // Settlement-authoritative (kleague in SETTLEMENT_AUTHORITATIVE_SPORTS). 12 teams in teams.js.
  // `tickerMl` (renamed from `kleagueGame` 2026-08-10 when KBO joined): the no-ESPN shape where
  // identity/date/kickoff all come from the ticker. Routing tag only — emitted rows still carry
  // gameType:"game", so no stored row contract changes.
  KXKLEAGUEGAME: { sport: "kleague", league: "kleague", stat: "ml", col: "ML", gameType: "tickerMl" },
  // KBO Korean baseball (adopted 2026-08-10). 2-way (no TIE market). 30/30 real books but a 10¢
  // median spread — only ~63% of markets clear capturableSpread's 15¢ cap, materially wider than
  // the soccer leagues; the gate rejects the rest at parse, which is the intended behaviour.
  // Unlike kleague, the ticker DOES carry HHMM (KXKBOGAME-26AUG130600LGKIW) so gameTime is real
  // and these rows are maker-quotable. No ESPN slug — settlement-authoritative only.
  KXKBOGAME: { sport: "kbo", league: "kbo", stat: "ml", col: "ML", gameType: "tickerMl" },
  // UFC match-winner (KXUFCFIGHT) + Boxing match-winner (KXBOXING) — model-free maker (built
  // 2026-08-10). Kalshi lists one YES market per fighter per bout (e.g. KXUFCFIGHT-26AUG15JOHOCH-JOH
  // and -OCH). YES-side only (same pattern as Dota2): each fighter's YES market covers one direction,
  // so both are captured without shadowId collision. gameTime from close_time (per-bout fight start
  // time — the ticker date segment YYMONDD is unrelated to the actual fight date). No teams.js
  // registry; no ESPN fetch. Settlement-authoritative ("ufc"/"boxing" in SETTLEMENT_AUTHORITATIVE_SPORTS).
  KXUFCFIGHT: { sport: "ufc",    league: "ufc",    stat: "ml", col: "UFC", gameType: "fightMl" },
  KXBOXING:   { sport: "boxing", league: "boxing", stat: "ml", col: "BOX", gameType: "fightMl" },
  // English Premier League game winner — 3-way (home/away/tie), model-free maker (built 2026-08-10).
  // TICKER NOTE: KXPREMIERLEAGUE (bare prefix) = season champion futures (20 mkts, closes 2027-06-13)
  // — same class as KXNWSL/KXUCL; added to DISMISSED_SERIES this commit. KXEPLGAME is the per-game
  // series: 30/30 real books, 1¢ median spread, confirmed live 2026-08-10. ESPN slug eng.1.
  KXEPLGAME:    { sport: "epl",    league: "epl",    stat: "game", col: "ML", gameType: "modelFreeMl" },
  // La Liga game winner — 3-way, model-free maker (built 2026-08-10). KXLALIGA bare prefix = season
  // champion futures (same class as KXPREMIERLEAGUE above); KXLALIGAGAME is per-game: 51/51 real
  // books, 4¢ median spread. ESPN slug esp.1.
  KXLALIGAGAME: { sport: "laliga", league: "laliga", stat: "game", col: "ML", gameType: "modelFreeMl" },
  // La Liga spread — 11th threshold market family (adopted 2026-08-10, from the discovery queue).
  // 24/24 real books, 4¢ median spread. Volume is thin ($1.1K) because the season opens 8/22, but
  // the books are two-sided NOW (tickers close 8/16-8/17), so this verifies immediately rather
  // than on a pre-season empty shell. All 12 team codes seen live (ALA GET DEP ELC ESP LEV RCC OSA
  // SAN VIL SEV RVC) are already in the 20-team laliga registry — no teams.js change, and laliga
  // was already in MODEL_FREE_LEAGUES + SETTLEMENT_AUTHORITATIVE_SPORTS from the 8/10 GAME build.
  KXLALIGASPREAD: { sport: "laliga", league: "laliga", stat: "spread", col: "G", gameType: "clubSoccerThreshold", subtype: "spread" },
  // Total + BTTS siblings, adopted 2026-08-10 (both listed after the spread build the same day).
  // Pure config — the spread build already put `laliga` in SCHEDULE_BY_SPORT, and the registry,
  // MODEL_FREE_LEAGUES entry and settlement authority were all in place from the GAME build.
  // KXLALIGATOTAL: 36/36 real books, 6¢ median. KXLALIGABTTS: 6/6 at 4¢ but zero volume so far —
  // added anyway because it costs one line and rides identical wiring; it captures nothing until
  // the book develops, which is the failure-closed outcome, not a silent one.
  KXLALIGATOTAL:  { sport: "laliga", league: "laliga", stat: "total",  col: "G", gameType: "clubSoccerThreshold", subtype: "total" },
  KXLALIGABTTS:   { sport: "laliga", league: "laliga", stat: "btts",   col: "G", gameType: "clubSoccerThreshold", subtype: "btts" },
  // Serie A game winner — 3-way, model-free maker (built 2026-08-10). KXSERIEA bare prefix = season
  // champion futures; KXSERIEAGAME is per-game: 30/30 real books, 3.5¢ median spread. ESPN slug ita.1.
  KXSERIEAGAME: { sport: "seriea", league: "seriea", stat: "game", col: "ML", gameType: "modelFreeMl" },
  // Ligue 1 game winner — 3-way, model-free maker (built 2026-08-10). KXLIGUE1 bare prefix = season
  // champion futures; KXLIGUE1GAME is per-game: 27/27 real books, 3¢ median spread. ESPN slug fra.1.
  // TWO 2-CHAR ABBRS in ligue1 registry (OL=Lyon, OM=Marseille) — ligue1 is in the parse-teams.js
  // variable-length allowlist (this commit).
  KXLIGUE1GAME: { sport: "ligue1", league: "ligue1", stat: "game", col: "ML", gameType: "modelFreeMl" },
  // J.League 1 game winner — 3-way (home/away/tie), model-free maker (built 2026-08-10).
  // 30/30 real books, 1¢ median spread. ESPN slug jpn.1 verified. All 20 Kalshi codes are 3-char.
  // 11 ESPN mismatches resolved in teams.js (includes 2 four-char ESPN codes: MIT→MITO, VER→TYKV).
  KXJLEAGUEGAME:        { sport: "jleague",  league: "jleague",  stat: "game", col: "ML", gameType: "modelFreeMl" },
  // La Liga 2 game winner — 3-way, model-free maker (built 2026-08-10). 22 teams, 33/33 real books,
  // 5¢ median spread. ESPN slug esp.2. KXLALIGA2 bare prefix = season champion futures (empty shell
  // 8/10) — added to DISMISSED_SERIES this commit. All Kalshi codes are 3-char (no allowlist).
  // 4 ESPN mismatches: CDE→ELD, GIJ→RSG, MAL→MLL, SAB→CDS. RS2=Real Sociedad II (code inferred).
  KXLALIGA2GAME:        { sport: "laliga2",  league: "laliga2",  stat: "game", col: "ML", gameType: "modelFreeMl" },
  // USL Championship game winner — 3-way, model-free maker (built 2026-08-10). 24 teams, 39/39
  // real books, 2¢ median spread. ESPN slug usa.usl.1. KXUSL bare prefix = season champion futures
  // (25 mkts, 1 per team) — added to DISMISSED_SERIES this commit. OC (2-char) → usl in parse-teams
  // allowlist. LOU collision (Louisville/Loudoun) → wrapCanonTeam in model-free-leagues.js.
  KXUSLGAME:            { sport: "usl",      league: "usl",      stat: "game", col: "ML", gameType: "modelFreeMl" },
  // Copa Libertadores game winner — 3-way, model-free maker (built 2026-08-10). 16 teams (QF stage),
  // 24/24 real books, 2¢ median spread. ESPN slug conmebol.libertadores. KXCONMEBOLLIB bare prefix
  // = tournament-winner futures (same class as KXPREMIERLEAGUE) — added to DISMISSED_SERIES this
  // commit. UC (2-char) + CARC (4-char) → copalib in parse-teams allowlist.
  KXCONMEBOLLIBGAME:    { sport: "copalib",  league: "copalib",  stat: "game", col: "ML", gameType: "modelFreeMl" },
  // Game totals
  KXMLBTOTAL:     { sport: "mlb",  league: "mlb",  stat: "totalRuns",   col: "R",   gameType: "total"     },
  KXNBATOTAL:     { sport: "nba",  league: "nba",  stat: "totalPoints", col: "PTS", gameType: "total"     },
  KXWNBATOTAL:    { sport: "wnba", league: "wnba", stat: "totalPoints", col: "PTS", gameType: "total"     },
  KXNHLTOTAL:     { sport: "nhl",  league: "nhl",  stat: "totalGoals",  col: "G",   gameType: "total"     },
  KXNFLTOTAL:     { sport: "nfl",  league: "nfl",  stat: "totalPoints", col: "PTS", gameType: "total"     },
  // Team totals
  KXMLBTEAMTOTAL:  { sport: "mlb", league: "mlb",  stat: "teamRuns",    col: "R",   gameType: "teamTotal" },
  KXNBATEAMTOTAL:  { sport: "nba", league: "nba",  stat: "teamPoints",  col: "PTS", gameType: "teamTotal" },
  // Spreads
  KXMLBSPREAD:   { sport: "mlb",  league: "mlb",  stat: "spread", col: "R",   gameType: "spread" },
  KXNBASPREAD:   { sport: "nba",  league: "nba",  stat: "spread", col: "PTS", gameType: "spread" },
  KXWNBASPREAD:  { sport: "wnba", league: "wnba", stat: "spread", col: "PTS", gameType: "spread" },
  KXNHLSPREAD:   { sport: "nhl",  league: "nhl",  stat: "spread", col: "G",   gameType: "spread" },
  // MLB First-5-Innings
  KXMLBF5TOTAL:  { sport: "mlb", league: "mlb", stat: "f5total",  col: "R", gameType: "total",  segment: "f5" },
  KXMLBF5SPREAD: { sport: "mlb", league: "mlb", stat: "f5spread", col: "R", gameType: "spread", segment: "f5" },
  // NBA/WNBA halves
  KXNBA1HTOTAL:   { sport: "nba",  league: "nba",  stat: "h1total",  col: "PTS", gameType: "total",  segment: "1h" },
  KXNBA1HSPREAD:  { sport: "nba",  league: "nba",  stat: "h1spread", col: "PTS", gameType: "spread", segment: "1h" },
  KXNBA2HTOTAL:   { sport: "nba",  league: "nba",  stat: "h2total",  col: "PTS", gameType: "total",  segment: "2h" },
  KXNBA2HSPREAD:  { sport: "nba",  league: "nba",  stat: "h2spread", col: "PTS", gameType: "spread", segment: "2h" },
  KXWNBA1HTOTAL:  { sport: "wnba", league: "wnba", stat: "h1total",  col: "PTS", gameType: "total",  segment: "1h" },
  KXWNBA1HSPREAD: { sport: "wnba", league: "wnba", stat: "h1spread", col: "PTS", gameType: "spread", segment: "1h" },
  KXWNBA2HTOTAL:  { sport: "wnba", league: "wnba", stat: "h2total",  col: "PTS", gameType: "total",  segment: "2h" },
  KXWNBA2HSPREAD: { sport: "wnba", league: "wnba", stat: "h2spread", col: "PTS", gameType: "spread", segment: "2h" },
  // WNBA quarters (shadow-only) — same machinery as halves, λ×0.25 / σ×0.5, emitted by the
  // dedicated quarters block in ml-spread.js. Winner series live in CRON_ONLY_TICKERS below.
  KXWNBA1QTOTAL:  { sport: "wnba", league: "wnba", stat: "q1total",  col: "PTS", gameType: "total",  segment: "1q" },
  KXWNBA1QSPREAD: { sport: "wnba", league: "wnba", stat: "q1spread", col: "PTS", gameType: "spread", segment: "1q" },
  KXWNBA2QTOTAL:  { sport: "wnba", league: "wnba", stat: "q2total",  col: "PTS", gameType: "total",  segment: "2q" },
  KXWNBA2QSPREAD: { sport: "wnba", league: "wnba", stat: "q2spread", col: "PTS", gameType: "spread", segment: "2q" },
  KXWNBA3QTOTAL:  { sport: "wnba", league: "wnba", stat: "q3total",  col: "PTS", gameType: "total",  segment: "3q" },
  KXWNBA3QSPREAD: { sport: "wnba", league: "wnba", stat: "q3spread", col: "PTS", gameType: "spread", segment: "3q" },
  KXWNBA4QTOTAL:  { sport: "wnba", league: "wnba", stat: "q4total",  col: "PTS", gameType: "total",  segment: "4q" },
  KXWNBA4QSPREAD: { sport: "wnba", league: "wnba", stat: "q4spread", col: "PTS", gameType: "spread", segment: "4q" },
};

// Tickers fetched by the snapshot cron but not part of the play pipeline:
// per-sport moneyline series, winner markets, and the 3-way F3/F5/F7 inning-winner series.
export const CRON_ONLY_TICKERS = [
  "KXMLBGAME", "KXNBAGAME", "KXWNBAGAME", "KXNHLGAME", "KXNFLGAME",
  "KXMLBF3", "KXMLBF5", "KXMLBF7",
  "KXNBA1HWINNER", "KXNBA2HWINNER",
  "KXWNBA1HWINNER", "KXWNBA2HWINNER",
  "KXWNBA1QWINNER", "KXWNBA2QWINNER", "KXWNBA3QWINNER", "KXWNBA4QWINNER",
];

// Series we've vetted and decided NOT to build (the dismiss half of the funnel).
// The series-scan cron reconciles any 'new'/'shortlisted' row here → 'dismissed',
// mirroring the adopt reconcile (SERIES_CONFIG∪CRON_ONLY → 'adopted'). This makes a
// dismissal a code change the scan can detect, so the "Vet shortlisted" banner clears
// itself when we complete the vet — no manual `?dismiss=` curl needed.
// Add the ticker here when a vet concludes DISMISS; note why inline.
//
// TWO-TRACK VIABILITY DOCTRINE (added 2026-07-23, see project_maker_viability_doctrine_2026_07_23
// memory): every dismissal below this point (and most above it) was reasoned under a SINGLE test —
// "does a probability model + data source exist for this series?" That test is the right one for
// TAKER viability, but it's the WRONG lens for MAKER viability. The maker strategy (api/lib/maker.js)
// captures Kalshi's own favorite-ask mispricing directly and needs NO probability model at all —
// only (1) real liquidity (a genuine two-sided book, not a 0-volume shell), (2) a real gameTime
// (for computeMakerQuote's pre-game gate), and (3) a resolvable outcome (via ESPN/statsapi OR,
// as of 2026-07-23, via Kalshi's own settlement result directly — see kalshi-settlement.js).
// "No club Elo" / "no ratings source" / "no cricket model" block TAKER, not MAKER. From now on,
// vet BOTH tracks before dismissing: a series that fails the taker test can still be promoted to
// 'shortlisted' as a MAKER candidate if it has real liquidity. Exception: exact-cell markets
// (correct-score, N-way outcomes) are a poor MAKER fit too — maker needs a genuine favorite-priced
// side, which a market with 15-30 near-equally-unlikely outcomes doesn't have — so those stay
// dismissed under both tracks, not just one.
//
// HISTORICAL SWEEP (2026-07-23, via the new /api/kalshi-check standing diagnostic — see
// project_maker_viability_doctrine_2026_07_23 memory): checked ~40 of the ~45 "no club Elo"
// leagues' BASE game markets directly against Kalshi (not via kalshi_series_seen — see the blind
// spot below). ~14 came back REAL, live, two-sided books TODAY (all confirmed with an actual
// favorite-priced side, i.e. not just a shell): KXBRASILEIROGAME (Brazil, 36 mkts), KXPREMIERLEAGUE
// (England top flight — NOT "KXEPL", a different ticker than its own dismissed derivative family's
// prefix), KXLALIGA (Spain, 20 mkts), KXSERIEA (Italy, 20 mkts), KXBUNDESLIGA (Germany, 18 mkts),
// KXLIGUE1 (France, 18 mkts), KXUCL (Champions League, 29 mkts), KXKLEAGUE (Korea, 12 mkts),
// KXCONMEBOLLIB (Copa Libertadores, 16 mkts), KXUSL (USA lower div, 25 mkts), KXNWSL (US women's,
// 16 mkts), KXCHNSL (Chinese Super League, 16 mkts, real books but no favorite currently in-window),
// KXECULP (Ecuador, 16 mkts), KXPERLIGA1 (Peru, 18 mkts — real prices but no market showed a fully
// two-sided book, lower confidence than the others). The rest (EFL Championship/L1/Cup, Eredivisie,
// Scottish Prem, Eliteserien, J-League, Liga Portugal, Conmebol Sudamericana, Copa del Rey, Coppa
// Italia, Coupe de France, DFB-Pokal, FA Cup, US Open Cup, Belgian PL, Egyptian PL, Saudi PL, Thai
// League 1, UAE PL, Swiss league, Dimayor, A-League, Bundesliga 2, Ekstraklasa, Allsvenskan, Danish
// Superliga, Czech league, HNL, Süper Lig) came back 0 live — MOST OF EUROPE IS JULY OFF-SEASON, so
// this is NOT confirmation they're permanently dead; recheck once each league's season is underway.
//
// DISCOVERY BLIND SPOT — CORRECTED 2026-07-23 (later the same day): the original theory here was
// WRONG. `/api/kalshi-check?ticker=X&meta=1` (GET /v2/series/{ticker}) confirms all 14 leagues
// above carry `category:"Sports"` — they're NOT miscategorized, and `?search=` against the live
// catalog fetch confirms every one of them IS present in `/v2/series?category=Sports` (found:true,
// catalogCount 3002). The catalog-fetch step is fine. The real bug is one step downstream: every
// one of these tickers was ALREADY in `kalshi_series_seen`, first_seen 2026-06-13 (the very first
// scan run), sitting at `status:'baseline'` — the code path that bulk-labels every ticker already
// listed on day one as "silently acknowledged," permanently excluded from the new/shortlisted
// triage queue the reports/banners surface. The two-track maker viability doctrine (above) didn't
// exist until TODAY, so every 'baseline' row was rubber-stamped "ignore" before either the taker OR
// maker test was ever applied to it. `?statuscounts=1` (kalshi-series-scan diagnostic) shows the
// real scale: 2141 rows at status='baseline' vs only 66 adopted / 28 shortlisted / 766 dismissed —
// a ~2100-series backlog that has NEVER been vetted under any doctrine, across every sport, not
// just soccer. The 14 leagues here are a promotable sample of that backlog (`?promote=TICKER`
// moves a 'baseline' row straight to 'shortlisted' — already handled, no code change needed there),
// not a demonstration of a catalog blind spot. Sweeping the full 'baseline' backlog for maker/taker
// viability is a large, separate follow-up (2100 rows, most surely genuine no-model/no-liquidity
// futures/novelty noise — same character as the DISMISSED_SERIES entries below — but unknown how
// many more real leagues like these 14 are hiding in it). KXBRASILEIROGAME BUILT 2026-07-23 (see
// its SERIES_CONFIG entry above — picked as the highest-liquidity confirmed-real candidate, 36/36
// real two-sided books). The other 13 + the 24 reclassified tickers above stay NOT built.
export const DISMISSED_SERIES = [
  "KXWC1HSCORE", // 6/22 vet: exact half-scoreline longshots, no in-window edge (1H signal already covered by the soccer half score-matrix)
  "KXWTAROE", // 6/22 vet: WTA round-of-elimination = draw-progression distribution; our tennis is single-match winner only (tennisMatchProb), no bracket sim. No Phase-1 path.
  "KXWC3RDPLACEQUAL", // 6/22 vet: needs full group-table + cross-group 3rd-place ranking sim; our Dixon–Coles matrix models one match, not group standings. window_fit false-positive (12 mkts). Defer to a tournament-sim phase.
  "KXWCWINMARGIN", // 6/23 vet: exact-margin longshot trap (same shape as KXWC1HSCORE) — only longshot-NO sides reach [67,91] with no edge; the tractable margin signal is already emitted via soccer probSpreadCover + 1X2. DISMISS.
  "KXWNBAH2HPTS", // 6/23 vet: model end is BUILDABLE (buildNbaStatDist point Normals + golf-style h2hWinProb combine) but DEFERRED — listed only sporadically (0-open even on full evening slates) → too thin for useful shadow data; NASCAR was the better next build and shipped. Dismissing to clear the banner; revisit if higher-liquidity builds dry up.
  "KXWNBAH2HPRA", // 6/23 vet: same as KXWNBAH2HPTS, second in line (Points pipeline + one cross-stat ρ(P,R,A) variance-inflation knob). DEFERRED for the same thin-coverage reason. Revisit alongside H2HPTS.
  "KXBILGAME", // 6/23 triage: "Ball is Life" grassroots/AAU streetball (individual amateur players) — no ESPN/ratings data source exists, unmodelable. window_fit false.
  "KXNBANEWCHAMPION", // 6/23 triage: season-long futures novelty ("Nth straight different champion"), single market, no per-game model applies.
  "KXWCDELAY", // 6/23 triage: World Cup delay novelty, 0 live markets, no sample subtitle — nothing to model.
  "KXWCGOALSTREAK", // 6/23 triage: per-player consecutive-goal-streak longshot. window_fit=true is the longshot-NO false positive; soccer Phase 1 is national-team Elo only (no per-player goal model). DISMISS.
  "KXWCAWARDCOMBO", // 6/23 triage: award-combo parlay futures (e.g. "Messi wins Golden Boot + Golden Ball") — no per-player/award soccer model (Phase 1 is national-team Elo score-matrix only); exact-combo longshot, 1 mkt, window_fit false. Same class as KXWCGOALSTREAK. DISMISS.
  "KXNCAALAX", // 6/26 triage: College Lacrosse National Championship — 48-team title FUTURES (KXNCAALAX-27-YAL etc.), no college-lacrosse model or off-the-shelf rating source. window_fit false (longshots). Same class as the NFL/NCAAF futures dismissed 6/25. DISMISS.
  "KXWCCONCEDE1ST", // 6/26 triage: "Which Team will Concede a Goal First?" — single tournament-wide novelty outright (1 event KXWCCONCEDE1ST-26, 4 arbitrary teams, closes at the 7/27 final, zero prices). A real-time concede race across the whole tournament, NOT a per-match market — our Elo→λ first-goal closed form needs a defined match pair, which this has none. window_fit false. DISMISS.
  // 6/28 triage (9 CFB qualifier futures): conference-championship QUALIFIER futures — no college-football model exists. Same class as the NFL/NCAAF futures dismissed 6/25. window_fit=true on AAC/B10/B12/PAC12 is the outright-favorite false-positive (a strong qualifier's YES in [67,91] is not edge). DISMISS.
  "KXNCAAFAACQUAL",
  "KXNCAAFACCQUAL",
  "KXNCAAFB10QUAL",
  "KXNCAAFB12QUAL",
  "KXNCAAFCUSAQUAL",
  "KXNCAAFMACQUAL",
  "KXNCAAFMWCQUAL",
  "KXNCAAFPAC12QUAL",
  "KXNCAAFSBELTQUAL",
  "KXNFLTEAMPTS", // 6/28 triage: NFL season most/least-points FUTURES — our NFL model is game-level hit-rate props only, not season leaders. No model. DISMISS.
  "KXNFLWINS-ANY", // 6/28 triage: NFL season-wins-any-team FUTURES — same, no season-level model. DISMISS.
  "KXWCFINALMATCHUP", // 6/28 triage: exact World Cup final-PAIR longshot — no bracket-pair model (Dixon–Coles matrix prices one match, not a two-team-reach-final combinatorial); tiny probabilities, window_fit false. Same shape as the prior WC exact-cell dismissals. DISMISS.
  // 6/28 triage (3 Nathan's Hot Dog novelties): competitive-eating event — no model and no data source (ESPN/MLB/etc. expose nothing on hot-dog counts). Pure novelty, same class as the prior NBA/WC novelty dismissals. DISMISS.
  "KXNATHANSHDOU",      // Nathan's Hot Dog over/unders (hot dogs eaten O/U)
  "KXNATHANSHDRECORD",  // Nathan's Hot Dog — will the record be broken
  "KXNATHANSWINNERWO",  // Nathan's Hot Dog contest winner (field without the favorite)
  // 6/28 triage (2 held WC markets, resolved against the live Kalshi markets API — both 0-live last pass, now verifiable):
  "KXWCPLAY",       // "World Cup Play in Game" is NOT a play-in match (my earlier guess) — it's a per-PLAYER appearance novelty ("Lionel Messi enters the game", "Erling Haaland enters the game"). No soccer player-availability/lineup model (Phase 1 = national-team Elo score-matrix only) and no pre-game data source for who plays. Novelty, same class as the other WC player-prop dismissals. DISMISS.
  "KXWCMATCHUP",    // never listed a single market (0 in EVERY status, not even finalized) — a dead/empty series. Name parallels the dismissed KXWCFINALMATCHUP (exact-pairing longshot) and WC per-game is already covered by KXWCGAME → nothing to build against. DISMISS.
  // 6/30 triage (6 of 7 detected; KXLMBGAME shortlisted separately — statsapi sportId 23/league 125 gives our MLB stack a real data path):
  "KXATPTIEBREAK",     // "Tiebreak to occur in Match" — derived set-competitiveness prop needing a set-score distribution we don't model; our tennis is match-winner only AND already market-sharper (AUC 0.51 vs 0.72). No path. DISMISS.
  "KXNCAAWBAPRANK",    // Women's CBB AP Poll ranking — poll/opinion outcome, not a game result; no NCAAW model. Futures-like. DISMISS.
  "KXWCSTART",         // "World Cup Starters" — lineup/team-news market (coach decision); our WC model is national-team Elo score-matrix, not lineup prediction. No pre-game starter data source. DISMISS.
  "KXCHAMPTOURR1LEAD", // Champions (senior) Tour round-1 leader — wide-field outright longshot (exact-cell trap; window_fit false-positive on favorite NO). No field-sim; senior-tour OWGR coverage thin. Same class as prior golf-leader dismissals. DISMISS.
  "KXNELKHOLEINONE",   // NELK hole-in-one — novelty/entertainment event; hole-in-one is near-pure luck, unmodelable. Same class as the Nathan's/streetball novelties. DISMISS.
  "KXBDSHOLEINONE",    // Bob Does Sports hole-in-one — same novelty pure-luck class as KXNELKHOLEINONE. DISMISS.
  // (KXLMBGAME was dismissed here 7/01 for a dead Kalshi book — 0 vol/OI, 1¢ placeholder bids,
  // ~98¢ spreads — with the model end green. ADOPTED 2026-07-15 on the scheduled liquidity
  // recheck: real MM books appeared on game-day markets — see SERIES_CONFIG above.)
  // (KXNBASUMMERGAME was dismissed here 7/01 for the no-rating problem; ADOPTED 2026-07-13 with a
  // within-tournament parity-start Elo instead — see SERIES_CONFIG above.)
  "KXDPWTH2H", // 7/01 triage: golf FULL-TOURNAMENT H2H ("A beats B in the full tournament"). NOT a
  // drop-in for our golfH2h path — golf.js is single-round, field-independent ("A beats B in round
  // N", one-round Normal σ=√2·GOLF_ROUND_SIGMA). A 72-hole cumulative matchup (with cut effects)
  // needs the golf Phase-2 36-hole field sim (make-cut/cut-line), which doesn't exist. Also dead
  // liquidity (1 matchup, 2 mkts, 0 vol, no book). Revisit when golf Phase-2 lands AND it trades.
  // 7/02 triage (3 detected):
  "KXMANAGEROUTDATE", // soccer manager departure-DATE futures ("Tuchel out before Jun 1, 2028", 8 mkts).
  // Managerial job security is news/insider-driven — no data model exists or is buildable from our
  // sources. Same novelty-futures class as KXNBANEWCHAMPION. window_fit false. DISMISS.
  "KXNEXTMANAGER", // next-manager-APPOINTMENT novelty ("Robin van Persie next NLD manager", 17 mkts).
  // Pure insider-news outright over an open candidate field; no model, no data source. DISMISS.
  "KXNBACUPQUAL", // NBA Cup qualifier/finalist FUTURES — 30 teams × {26KO qualify-for-knockout,
  // 26FIN reach-final}, close Feb 2027. Season-long tournament futures: nba.js is a per-game joint
  // sim, no group-stage/season sim exists (same class as the NCAAF conference-qual dismissals 6/28).
  // Book is completely dead: 0 of 60 markets have ANY bid (yes 0/99¢ placeholders, no volume/OI).
  // Revisit only if a season-sim phase ever lands AND the book seeds. DISMISS.
  "KXTFWORLDRECORD", // 7/02 triage: Track & Field outdoor world-record novelty — record-breaking
  // events are unmodelable from our sources (no athletics model/data path), 0 live markets, no
  // sample. Same novelty class as the Nathan's/hole-in-one dismissals. DISMISS.
  // 7/03 triage (4 detected):
  "KXCYCLINGSTAGE", // Cycling stage winner — wide-field outright over a 150+ rider peloton; no
  // cycling model or rating source (ESPN/our stack expose nothing). 0 live markets, no sample.
  // Same field-outright exact-cell class as the golf-leader dismissals. DISMISS.
  "KXMLBFASTPITCH", // "Fastest Pitch of season" — season-long record-extreme novelty (max of ~700k
  // pitches); tail-of-tails, unmodelable even though Statcast velo data exists. 0 live markets.
  // Same record-novelty class as KXTFWORLDRECORD. DISMISS.
  "KXNASCARCUPSEASON", // NASCAR Cup REGULAR-SEASON CHAMPION futures (38 driver outrights, annual).
  // nascar.js is per-race H2H/Top-10 recent-form — no season-points sim exists. Same season-futures
  // class as the NFL/NBA-Cup dismissals. window_fit false (longshot outrights). DISMISS.
  "KXWCHOSTWIN", // "Any host nation to win the World Cup" — single novelty binary (1 mkt, closes at
  // the final). Pricing it needs a full-tournament WINNER sim (soccer advanceProb is per-round
  // knockout only). window_fit=true is the longshot-NO false positive (no_ask 93¢ on an 11¢-spread,
  // 0-volume book). One market total → no calibration sample even if built. DISMISS.
  "KXNBACONF", // 7/05 triage: East vs West conference to win the NBA Finals — season-long futures
  // binary (one market/year, resolves next June). No repeatable daily flow to calibrate; same
  // season-futures class as KXNBANEWCHAMPION/KXNBACUPQUAL. DISMISS.
  // 7/06 triage (3 detected):
  "KXHKANEKNIGHT", // "Harry Kane Knighted in 2026" — UK honours novelty (tagged Soccer but it's a
  // royal-honours announcement, news/insider-driven). No model surface; 1 mkt/year. window_fit=true
  // is the longshot-side false positive. Same award/news-futures class as KXSUPERBALLONDOR and the
  // manager-departure dismissals. DISMISS.
  "KXNBASUMMER", // NBA Summer League CHAMPION futures — tournament-winner outright; needs a
  // tournament sim on top of a team rating. (KXNBASUMMERGAME was adopted 7/13 with a within-
  // tournament Elo, but a champion market still has ~1 resolution/year — no calibration flow.)
  // 0 live mkts. DISMISS.
  "KXBALOGUNPLAY", // "Will Balogun Play Today" — per-player appearance/team-news market (coach
  // decision), same class as KXWCPLAY and KXWCSTART. No player-availability model or pre-game
  // lineup data source for soccer. DISMISS.
  // 7/07 triage (6 detected):
  "KXCYCLINGJERSEY", // Tour de France jersey classification winner (polka dot/green/white) — tournament
  // futures over 150+ rider field; no cycling model or rating source. Same wide-field-outright class
  // as KXCYCLINGSTAGE. window_fit false. DISMISS.
  "KXGOLFTOURN", // Golf tournament outright winner — full-field futures (90 mkts / Zach LaVine-type
  // outrights); KXGOLFH2H is our golf path (one-round Normal H2H). Tournament winner needs 72-hole
  // field sim + cut model (golf Phase-2, not built). Same class as KXDPWTH2H. window_fit false. DISMISS.
  "KXNBARULE", // "Pro Basketball to implement the one free throw rule" — governance/policy novelty
  // (1 mkt). Not a game result; no model surface. Same novelty class as KXNBANEWCHAMPION. DISMISS.
  "KXNBATEAMANNOUNCE", // "Pro Basketball New Team Announce" (LeBron James signing rumours, 14 mkts) —
  // news/announcement futures; no player-signing model or data source. window_fit=true is the
  // outright-favorite false-positive on binary announcement markets. Same class as KXNEXTMANAGER. DISMISS.
  "KXPPLMATCH", // Padel match winner (PPL league) — racket sport, niche, no rating data or model;
  // our tennis path (tennisMatchProb) is ATP/WTA OWGR-derived and doesn't transfer. 20 mkts,
  // window_fit false. Same class as other no-data-source dismissals. DISMISS.
  "KXWCPREPACK", // "World Cup Prepack" — 0 live markets, null sample; likely a bundled/parlay
  // wrapper series, not individual game outcomes. Nothing to model or price. DISMISS.
  // 7/10 triage (1 detected):
  "KXNCAAFH2HWINS", // College Football Head-to-Head Regular Season Wins — season-long futures binary
  // ("will Team A finish with more regular-season wins than Team B?"). Two blockers: (1) book is DEAD:
  // yesAsk=98¢, noAsk=99¢, spread=97¢, volume=0 → fails CAPTURE_MAX_SPREAD 15¢ by 6.5× (same blocker
  // as KXLMBGAME 7/01 — buildable data end, Kalshi hasn't seeded liquidity). (2) Season-long futures
  // class: resolves December, no repeatable daily flow — same class as the 9 NCAAF qualifier futures
  // dismissed 6/28. window_fit=true is the outright-favorite false-positive (strong team's YES in
  // [67,91] on a season-total comparison, same as qualifier series). ESPN FPI projects team wins and
  // would be the model end (site.api.espn.com/apis/site/v2/sports/football/college-football/teams),
  // but zero captures until Kalshi seeds the book. DISMISS; revisit if yes_ask < 91¢ appears.
  // 7/11 triage (12 detected — 6 soccer confederation tournaments + 6 MLB Home Run Derby):
  // Soccer: all 6 are national-team confederation tournaments. Our soccer model is WC national-team
  // Elo only (WC_TEAMS registry + Dixon–Coles matrix); no Elo ratings exist for AFC/CONCACAF/COPA/
  // UEFA clubs or their qualifying pools. All 0 live markets (future tournament registrations).
  // No model surface, no calibration path. DISMISS all.
  "KXAFCA",        // AFC Asian Cup — Asian confederation tournament, WC_TEAMS Elo doesn't cover.
  "KXCONCACAFGC",  // CONCACAF Gold Cup — CONCACAF tournament, no Elo for CONCACAF non-WC teams.
  "KXCONCACAFNL",  // CONCACAF Nations League — multi-round confederation league, same blocker.
  "KXCOPAAMERICA", // Copa America — next edition 2028+; WC_TEAMS includes CONMEBOL but no active mkts.
  "KXUEFAEURO",    // UEFA European Championship — next UEFA Euro 2028; 0 live mkts.
  "KXUEFANL",      // UEFA Nations League — 2026/27 edition; 0 live mkts; different format (no WC_TEAMS).
  // Home Run Derby: timed batting competition, completely orthogonal to our MLB K/HRR/stat models.
  // No pitch stats, no pitcher, no PA-based distributions — needs a separate HRD power/bracket model
  // we don't have. window_fit=true on the matchup/semifinal series is the outright-favorite false-
  // positive (strong batter's YES in [67,91] on H2H bracket markets). DISMISS all 8 (2 more 7/12).
  "KXMLBHRDERBY500",      // 500+ Foot HRs at the HRD — per-round aggregate HR distance, no model.
  "KXMLBHRDERBYDISTANCE", // Longest single HR distance — HRD physics model, not our MLB stack.
  "KXMLBHRDERBYLONGEST",  // Player to Hit the Longest HR — player outright; needs HRD field sim.
  "KXMLBHRDERBYMATCHUP",  // Final Matchup (28 live mkts) — bracket prediction; window_fit=true is false-positive.
  "KXMLBHRDERBYOU",       // O/U Home Runs per player/round — HRD-specific distribution, 0 live mkts.
  "KXMLBHRDERBYSEMI",     // Semifinals Qualifiers — bracket advancement; window_fit=true is false-positive.
  "KXMLBHRDERBYFIN",      // Finals Qualifiers — bracket advancement, same class as SEMI (8 live mkts).
  "KXMLBHRDERBYR1LEAD",   // Round 1 Leader — 8-player field outright per round, needs HRD field sim.
  // 7/13 triage (2 detected):
  "KXMLBASGMVP", // All-Star Game MVP — award outright over a 30-player exhibition field (1 mkt/year
  // resolving on voters, not stats). Same award-futures class as KXMLBGG/KXNBASUMMERMVP. DISMISS.
  "KXUFCFIGHTOCCUR", // "Fighter to compete in a fight by <date>" (McGregor, 1 mkt) — appearance/news
  // novelty, insider-driven; same class as KXBALOGUNPLAY/KXWCPLAY. No model surface. DISMISS.
  // 7/14 triage (17 detected — the All-Star-break novelty flood; every one maps to an
  // already-established dismissal class):
  "KXATPCOMPETE", // "ATP Player to Compete" — per-player appearance/news novelty (1 mkt), same
  // class as KXUFCFIGHTOCCUR/KXBALOGUNPLAY. DISMISS.
  // All-Star Game props (4): one-day EXHIBITION — rotating wholesale lineups, 1-inning pitcher
  // stints, no projected-AB/starter structure, so the K/hits/HRR machinery doesn't apply; 1 game/yr
  // = no calibration flow. Same class as the KXMLBASGMVP dismissal 7/13. window_fit=true on
  // HIT/HR/ALLSTARHR is the longshot/favorite false-positive on prop rungs. DISMISS all.
  "KXMLBALLSTARHR", // ASG total home runs (7 live mkts).
  "KXMLBASGHIT",    // ASG player hits (59 live mkts).
  "KXMLBASGHR",     // ASG player home runs (42 live mkts).
  "KXMLBASGKS",     // ASG strikeouts (0 live mkts).
  // Home Run Derby stragglers (3): same HRD class as the 10 dismissed 7/11–7/12. DISMISS all.
  "KXMLBHRDERBYFORECAST", // Finals forecast — bracket prediction variant.
  "KXMLBHRDERBYTOT",      // HRD total home runs — HRD-specific distribution.
  "KXMLBHRDERBYVELO",     // Highest exit velocity — record-extreme novelty, same class as KXMLBFASTPITCH.
  // "Next Team" (4): player signing/trade DESTINATION futures — news/insider-driven, open candidate
  // field; same class as KXNBATEAMANNOUNCE/KXNEXTMANAGER. No model surface. DISMISS all.
  "KXMLBNEXTTEAM",
  "KXNBANEXTTEAM",
  "KXNFLNEXTTEAM",
  "KXNHLNEXTTEAM",
  // Summer League 1st-half markets (3): nbasl|ml (adopted 7/12) is a within-tournament WIN-PROB Elo
  // only — no scoring-rate/λ model exists for SL, so half spread/total/winner have no model surface;
  // 0 live mkts, tournament ends ~7/19, and segment markets are the dead-book trap class (7/11
  // overround artifact). Revisit only if nbasl|ml proves out AND an SL scoring model ever exists.
  "KXNBASUMMER1HSPREAD",
  "KXNBASUMMER1HTOTAL",
  "KXNBASUMMER1HWINNER",
  "KXWCFINISHINGORDER", // World Cup finishing ORDER (16 live) — combinatorial bracket/ordering
  // futures; advanceProb is per-round only, no full-tournament winner/order sim. window_fit=true is
  // the longshot false-positive. Same class as KXWCFINALMATCHUP/KXWCHOSTWIN. DISMISS.
  "KXWMARMADSEED", // Women's CBB tournament SEEDS — committee-decision futures, no NCAAW model;
  // same class as KXNCAAWBAPRANK/KXNCAAWBWINS. DISMISS.
  // 7/15 triage (31: the 25-row club-soccer derivative flood + 6 fresh detections).
  // Club-soccer market families (25): Kalshi rolled out BTTS/spread/total/1H/correct-score
  // families for club leagues whose BASE game series we already dismissed (KXBRASILEIRO{B,C}GAME
  // 6/25) or never modeled — our soccer model is WC NATIONAL-TEAM Elo only (WC_TEAMS + Dixon–
  // Coles); no club Elo exists (that's soccer Phase 2). Every row 0 live mkts, window_fit=false
  // (pre-registration shells). Derivative families inherit the base-league blocker — if a club
  // Elo ever lands, the full market surface is waiting (revisit then, not before).
  "KXALLSVENSKANBTTS", "KXALLSVENSKANSPREAD", "KXALLSVENSKANTOTAL", // Allsvenskan (Sweden)
  "KXBRASILEIRO1H", "KXBRASILEIRO1HBTTS", "KXBRASILEIRO1HSPREAD", "KXBRASILEIRO1HTOTAL", // Brasileirão A halves
  "KXBRASILEIROBTTS", "KXBRASILEIROFTTS", // Brasileirão A BTTS + First Team to Score (no scoring-order model)
  "KXBRASILEIROSCORE", // Brasileirão A CORRECT SCORE — exact-cell trap class on top of the club blocker
  "KXBRASILEIROB1H", "KXBRASILEIROB1HBTTS", "KXBRASILEIROB1HSPREAD", "KXBRASILEIROB1HTOTAL", // Série B halves
  "KXBRASILEIROBBTTS", "KXBRASILEIROBSPREAD", "KXBRASILEIROBTOTAL", // Série B full-game families
  "KXBRASILEIROCBTTS", "KXBRASILEIROCSPREAD", "KXBRASILEIROCTOTAL", // Série C full-game families
  "KXCANPLBTTS", "KXCANPLSPREAD", "KXCANPLTOTAL", // Canadian Premier League
  "KXCHNSLBTTS", // Chinese Super League
  "KXBNXTGAME", // BNXT Supercup (Belgian-Dutch basketball) — one-off supercup game, no BNXT
  // rating/data source, 0 live mkts. Same no-data-source class as KXPPLMATCH. DISMISS.
  // NCAAMB conference regular-season futures (4): season-long champion/top-finisher outrights,
  // resolve March 2027; no NCAAMB game model. Same class as the NCAAF conference-qual (6/28) and
  // KXNCAAWBWINS dismissals. DISMISS all.
  "KXNCAAMBSECREG", "KXNCAAMBSECREGTOP", "KXNCAAMBBIGEASTREG", "KXNCAAMBBIGEASTREGTOP",
  // NPB (Japanese baseball) first-inning-run + game totals (2): dense daily league (LMB-class
  // cadence) BUT no data path in our stack — NPB is NOT in MLB statsapi (LMB was adoptable only
  // because sportId 23 covered it) and ESPN doesn't carry NPB stats/scores. No standings/run-rate
  // source → no λ, no resolver. Revisit ONLY if a clean NPB stats API surfaces AND books seed.
  "KXNPBRFI",
  "KXNPBTOTAL",
  // 7/15 second wave (25 more landed via the cron scan the same day — Kalshi is mid-rollout on
  // international/derivative families). 24 dismissed, 1 promoted (KXMILBGAME → shortlisted:
  // MiLB IS in MLB statsapi (sportIds 11-14 AAA→A), so the LMB machinery generalizes directly —
  // vet its books when markets go live; 0 live at detection).
  // Club-soccer derivative families (17): same no-club-Elo blocker as the morning batch. All 0 live.
  "KXCHNSLSPREAD", "KXCHNSLTOTAL", // Chinese Super League (completes the CHNSL family)
  "KXELITESERIENBTTS", "KXELITESERIENSPREAD", "KXELITESERIENTOTAL", // Eliteserien (Norway)
  // KXLIGAMX1H/1HBTTS/1HSPREAD/1HTOTAL + KXMLS1H/1HBTTS/1HSPREAD/1HTOTAL RECLASSIFIED + BUILT
  // 2026-07-23 — see the two-track maker-viability doctrine note near the top of this list. Liga
  // MX/MLS base game markets confirmed real+liquid same day (club-soccer maker vet); these
  // halves derivatives share the same underlying games. Removed from DISMISSED_SERIES; now in
  // SERIES_CONFIG above (still taker-dismissed — no club Elo; maker-only, model-free, see
  // project_mls_ligamx_threshold_2026_07_23 memory).
  "KXLIGAMXFTTS", "KXLIGAMXSCORE", // Liga MX first-to-score + correct score — STAYS dismissed:
  // exact-cell trap (many near-equally-unlikely outcomes) is a poor maker fit too, not just a
  // taker one — maker needs a genuine favorite-priced side, which N-way correct-score markets don't have.
  "KXMLSFTTS", "KXMLSSCORE", // MLS first-to-score + correct score — same exact-cell reasoning, STAYS dismissed.
  // International basketball games (4): no rating/data source in our stack for any of them
  // (FIBA/EuroBasket national teams, German DBB Supercup, Iceland Premier League, Philippine
  // PBA). Same no-data-source class as KXBNXTGAME/KXPPLMATCH. All 0 live. DISMISS.
  "KXDBBSUPERGAME", "KXEUROBASKETGAME", "KXIBPLGAME", "KXPBAGAME",
  "KXLPL", // Lanka Premier League CHAMPION (cricket, despite the esports-looking ticker) —
  // tournament futures + no cricket model. DISMISS.
  "KXCOPAAMERICAHOST", // Copa America HOST selection (3 live) — committee/news decision futures,
  // same class as KXWMARMADSEED. DISMISS.
  "KXNBANEXTTEAMCONF", // "Next Team CONFERENCE" variant of KXNBANEXTTEAM (dismissed 7/14) —
  // signing-destination news futures; window_fit=true is the announcement false-positive. DISMISS.
  // 7/15 third + fourth waves (25 + 4 — the rollout's alphabet tail, P→W; all 0 live).
  // Club-soccer derivative families (25): same no-club-Elo blocker. Note the UEFA cups (UCL/UEL/
  // UECL) are in here — biggest club competitions in the world, still blocked on club Elo; if
  // soccer Phase 2 (club Elo) ever lands, these plus the Brasileirão/LigaMX/MLS families above
  // are the market surface waiting for it.
  "KXPERLIGA1BBTTS", "KXPERLIGA1SPREAD", "KXPERLIGA1TOTAL", // Peru Liga 1
  "KXUCLFTTS", "KXUCLSCORE", // UEFA Champions League first-to-score + correct score
  // KXUECL1HBTTS/1HSPREAD/1HTOTAL + KXUEL1HBTTS/1HSPREAD/1HTOTAL RECLASSIFIED 2026-07-23 (same
  // reasoning as the Liga MX/MLS halves above — UEL/UECL base game markets confirmed real same
  // day). Removed from DISMISSED_SERIES, promoted to shortlisted. NOT built.
  "KXUECLFTTS", "KXUECLSCORE", // Conference League first-to-score + correct score — STAYS
  // dismissed, exact-cell trap (poor maker fit too, see the Liga MX/MLS note above).
  "KXUELFTTS", "KXUELSCORE", // Europa League first-to-score + correct score — same, STAYS dismissed.
  "KXURYPDBBTTS", "KXURYPDSPREAD", "KXURYPDTOTAL", // Uruguay Primera División
  "KXUSL1H", "KXUSL1HBTTS", "KXUSL1HSPREAD", "KXUSL1HTOTAL", "KXUSLBTTS", "KXUSLSPREAD", "KXUSLTOTAL", // USL
  "KXWCWOMEN", // Women's World Cup (2027) — our WC Elo is men's national teams (WC_TEAMS); no
  // women's Elo source in stack, 0 live, resolves 2027. Same class as the confederation dismissals.
  // Women's international/league basketball (3): no ratings/data source, same class as
  // KXEUROBASKETGAME/KXIBPLGAME.
  "KXWFIBAGAME", "KXWIBPLGAME",
  "KXSOWBBALLGAME", // Summer Olympics Women's Basketball — national-team hoops, no ratings
  // source, next edition 2028. DISMISS.
  // 7/15 vet (shortlisted same day): model end GREEN — the LMB playbook generalizes directly.
  // statsapi covers all 4 full-season levels (sportId 11 AAA: IL 117 + PCL 112; 12 AA: Eastern
  // 113 + Southern 111 + Texas 109; 13 High-A: SAL 116 + Midwest 118 + NW 126; 14 Single-A:
  // Carolina 122 + FSL 123 + California 110) — 120 teams, ~62 games/day on regular days,
  // standings carry id-keyed W/L/RS/RA (91-game samples), schedule Final+scores identical to
  // the lmb.js resolver shape. First knob = the SAME standings run-rate λ → simulateMLBJoint
  // (parameterize lmb.js by sportId/leagueIds + a new registry). BUT the Kalshi end is a pure
  // SHELL: series registered ("MILB Game"), ZERO markets in ANY status ever — more premature
  // than KXLMBGAME 7/01 (which at least listed dead-book pairs). No tickers/sub_titles → the
  // team registry can't even be authored yet, and there's nothing to vet for liquidity.
  // DISMISS to clear the funnel; the 7/29 SCHEDULED_CHECKPOINTS entry (ReportPage) re-checks
  // for listings — if markets appear with real game-day books (asks + spread ≤15¢), un-dismiss
  // and build. Build notes: MiLB doubleheaders are COMMON and 7-INNING — the split-DH guard is
  // load-bearing; roster churn makes team run-rates noisier than MLB (acceptable for Phase 1);
  // which levels Kalshi lists is unknown until markets exist.
  "KXMILBGAME",
  // 7/16 triage (25 detected — wave 5 of the A→W international/derivative rollout; all 0 live
  // markets, pre-registration shells for tournaments that are months out).
  // AFC Asian Cup derivative families (11): the BASE series KXAFCA was dismissed 7/11 (national-
  // team confederation tournament — WC_TEAMS Elo doesn't cover it, next edition Jan 2027).
  // Derivatives inherit the base blocker; MOV/SCORE/FTTS additionally have no model surface even
  // for the WC (KXWCMOV class). If the national-team Elo registry ever extends past WC_TEAMS,
  // this surface (plus AFCON below) is waiting — revisit near the Jan 2027 Asian Cup, not before.
  "KXAFCAC1H", "KXAFCAC1HBTTS", "KXAFCAC1HSPREAD", "KXAFCAC1HTOTAL",
  "KXAFCACADVANCE", "KXAFCACBTTS", "KXAFCACFTTS", "KXAFCACMOV",
  "KXAFCACSCORE", "KXAFCACSPREAD", "KXAFCACTOTAL",
  // AFC Champions League derivative families (11): CLUB soccer — same no-club-Elo blocker as the
  // UCL/UEL/UECL families dismissed 7/15; season resumes September. If soccer Phase 2 club Elo
  // lands, this joins that waiting surface.
  "KXAFCCL1H", "KXAFCCL1HBTTS", "KXAFCCL1HSPREAD", "KXAFCCL1HTOTAL",
  "KXAFCCLADVANCE", "KXAFCCLBTTS", "KXAFCCLFTTS", "KXAFCCLMOV",
  "KXAFCCLSCORE", "KXAFCCLSPREAD", "KXAFCCLTOTAL",
  // Africa Cup of Nations derivative families (first 3 — expect the rest of the family in the
  // next cron waves): national-team confederation tournament, same KXAFCA/KXUEFAEURO class
  // (no Elo coverage beyond WC_TEAMS, next edition Dec 2027).
  "KXAFCON1H", "KXAFCON1HBTTS", "KXAFCON1HSPREAD",
  // 7/16 continued — the funnel behind the LIMIT-25 banner held 403 MORE rows (428 total today):
  // Kalshi's full-alphabet soccer-derivative rollout (A-League -> Venezuela FUTVE). Every row was
  // 0-live / pre-registration shell; all live-dismissed page-by-page via ?dismiss= (report
  // newMarkets drained to []). Classes, all established:
  // - Club-soccer derivative families (~370): 1H*/2H*/BTTS/FTTS/MOV/SCORE/SPREAD/TOTAL/ADVANCE for
  //   ~45 club leagues + cups (big-5 leagues' missing families incl. EPL/LaLiga/SerieA/Bundesliga/
  //   Ligue1, UEFA cups' stragglers, continental club cups CONMEBOL/CONCACAF/AFC/ClubWC, domestic
  //   cups, women's club leagues NWSL/EWSL/UCLW/FIFAW). ALL inherit the no-club-Elo blocker —
  //   when soccer Phase 2 club Elo lands, this entire surface is waiting.
  // - National-team families: AFCON remainder (KXAFCA class), KXUEFANL* + KXFINALISSIMA* +
  //   KXINTLFRIENDLY* (WC_TEAMS Elo covers WC only; friendlies also rotation-noise), KXWC (bare
  //   shell, ZERO markets ever — NOT the adopted KXWCGAME; if it becomes champion-outright that is
  //   the full-tournament-sim class), KXWCW (Women's WC, same class as KXWCWOMEN 7/15).
  // - KXNCAAMB{ACC,BIG10,BIG12,BIGTEN}REG{,TOP} (6): conference season futures, class of the 4
  //   dismissed 7/15.
  // - KXCHESSAWARD: Chess.com award futures — no chess model, award-futures class (KXSUPERBALLONDOR).
  "KXAFCON1HTOTAL", "KXAFCONBTTS", "KXAFCONFTTS", "KXAFCONMOV", "KXAFCONSCORE", "KXAFCONSPREAD",
  "KXAFCONTOTAL", "KXALEAGUE1H", "KXALEAGUE1HBTTS", "KXALEAGUE1HSPREAD", "KXALEAGUE1HTOTAL", "KXALEAGUEADVANCE",
  "KXALEAGUEBTTS", "KXALLSVENSKANADVANCE", "KXAPFDDHADVANCE", "KXAPFDDHBTTS", "KXAPFDDHSPREAD", "KXAPFDDHTOTAL",
  "KXBELGIANPLADVANCE", "KXBELGIANPLBTTS", "KXBELGIANPLSPREAD", "KXBELGIANPLTOTAL", "KXBOLPDIVADVANCE",
  "KXBRASILEIROADVANCE", "KXBRASILEIROBADVANCE", "KXBRASILEIROC1H", "KXBRASILEIROC1HBTTS", "KXBRASILEIROC1HSPREAD",
  "KXBRASILEIROC1HTOTAL", "KXBRASILEIROCADVANCE", "KXBRASILEIROMOV", "KXBUNDESLIGA2ADVANCE", "KXBUNDESLIGA2BTTS",
  "KXBUNDESLIGA2SPREAD", "KXBUNDESLIGA2TOTAL", "KXBUNDESLIGAADVANCE", "KXBUNDESLIGAFTTS", "KXBUNDESLIGAMOV",
  "KXBUNDESLIGASCORE", "KXCANPLADVANCE", "KXCHESSAWARD", "KXCHLLDPADVANCE", "KXCHLLDPBTTS", "KXCHLLDPSPREAD",
  "KXCHLLDPTOTAL", "KXCHNSLADVANCE", "KXCLUBWC1H", "KXCLUBWC1HBTTS", "KXCLUBWC1HSCORE", "KXCLUBWC1HSPREAD",
  "KXCLUBWC1HTOTAL", "KXCLUBWC2H", "KXCLUBWC2HBTTS", "KXCLUBWC2HSPREAD", "KXCLUBWC2HTOTAL", "KXCLUBWCADVANCE",
  "KXCLUBWCBTTS", "KXCLUBWCFTTS", "KXCLUBWCSCORE", "KXCLUBWCSPREAD", "KXCLUBWCTOTAL", "KXCONCACAFCCUP1H",
  "KXCONCACAFCCUP1HBTTS", "KXCONCACAFCCUP1HSPREAD", "KXCONCACAFCCUP1HTOTAL", "KXCONCACAFCCUPADVANCE",
  "KXCONCACAFCCUPBTTS", "KXCONCACAFCCUPSPREAD", "KXCONCACAFCCUPTOTAL", "KXCONMEBOLLIB1H", "KXCONMEBOLLIB1HBTTS",
  "KXCONMEBOLLIB1HSPREAD", "KXCONMEBOLLIB1HTOTAL", "KXCONMEBOLLIBADVANCE", "KXCONMEBOLLIBBTTS", "KXCONMEBOLLIBSPREAD",
  "KXCONMEBOLLIBTOTAL", "KXCONMEBOLSUD1H", "KXCONMEBOLSUD1HBTTS", "KXCONMEBOLSUD1HSPREAD", "KXCONMEBOLSUD1HTOTAL",
  "KXCONMEBOLSUDADVANCE", "KXCONMEBOLSUDBTTS", "KXCONMEBOLSUDSPREAD", "KXCONMEBOLSUDTOTAL", "KXCOPADELREY1H",
  "KXCOPADELREY1HBTTS", "KXCOPADELREY1HSPREAD", "KXCOPADELREY1HTOTAL", "KXCOPADELREYBTTS", "KXCOPADELREYFTTS",
  "KXCOPADELREYMOV", "KXCOPADELREYSCORE", "KXCOPADOBRASIL", "KXCOPADOBRASIL1H", "KXCOPADOBRASIL1HBTTS",
  "KXCOPADOBRASIL1HSPREAD", "KXCOPADOBRASIL1HTOTAL", "KXCOPADOBRASILADVANCE", "KXCOPADOBRASILBTTS",
  "KXCOPPAITALIA1H", "KXCOPPAITALIA1HBTTS", "KXCOPPAITALIA1HSPREAD", "KXCOPPAITALIA1HTOTAL", "KXCOPPAITALIABTTS",
  "KXCOPPAITALIAFTTS", "KXCOPPAITALIAMOV", "KXCOPPAITALIASCORE", "KXCOUPEDEFRANCE1H", "KXCOUPEDEFRANCE1HBTTS",
  "KXCOUPEDEFRANCE1HSPREAD", "KXCOUPEDEFRANCE1HTOTAL", "KXCOUPEDEFRANCEBTTS", "KXCOUPEDEFRANCEFTTS",
  "KXCOUPEDEFRANCEMOV", "KXCOUPEDEFRANCESCORE", "KXCZEFLADVANCE", "KXCZEFLBTTS", "KXCZEFLSPREAD",
  "KXCZEFLTOTAL", "KXDENSUPERLIGAADVANCE", "KXDENSUPERLIGABTTS", "KXDENSUPERLIGASPREAD", "KXDENSUPERLIGATOTAL",
  "KXDFBPOKAL1H", "KXDFBPOKAL1HBTTS", "KXDFBPOKAL1HSPREAD", "KXDFBPOKAL1HTOTAL", "KXDFBPOKALBTTS",
  "KXDFBPOKALFTTS", "KXDFBPOKALMOV", "KXDFBPOKALSCORE", "KXDIMAYORADVANCE", "KXDIMAYORBTTS", "KXDIMAYORSPREAD",
  "KXDIMAYORTOTAL", "KXECULPADVANCE", "KXECULPBTTS", "KXECULPSPREAD", "KXECULPTOTAL", "KXEFLCHAMPIONSHIP1H",
  "KXEFLCHAMPIONSHIP1HBTTS", "KXEFLCHAMPIONSHIP1HSPREAD", "KXEFLCHAMPIONSHIP1HTOTAL", "KXEFLCHAMPIONSHIPBTTS",
  "KXEFLCUP1H", "KXEFLCUP1HBTTS", "KXEFLCUP1HSPREAD", "KXEFLCUP1HTOTAL", "KXEFLCUPBTTS", "KXEFLCUPFTTS",
  "KXEFLCUPMOV", "KXEFLCUPSCORE", "KXEFLL11H", "KXEFLL11HBTTS", "KXEFLL11HSPREAD", "KXEFLL11HTOTAL",
  "KXEFLL1ADVANCE", "KXEFLL1BTTS", "KXEFLL1SPREAD", "KXEFLL1TOTAL", "KXEGYPLADVANCE", "KXEGYPLBTTS",
  "KXEGYPLSPREAD", "KXEGYPLTOTAL", "KXEKSTRAKLASAADVANCE", "KXEKSTRAKLASABTTS", "KXEKSTRAKLASASPREAD",
  "KXEKSTRAKLASATOTAL", "KXELITESERIENADVANCE", "KXEPL1HSCORE", "KXEPL2H", "KXEPL2HBTTS", "KXEPL2HSPREAD",
  "KXEPL2HTOTAL", "KXEPLADVANCE", "KXEPLFTTS", "KXEPLSCORE", "KXEREDIVISIE1H", "KXEREDIVISIE1HBTTS",
  "KXEREDIVISIE1HSPREAD", "KXEREDIVISIE1HTOTAL", "KXEREDIVISIEADVANCE", "KXEREDIVISIEBTTS", "KXESPSUPERCUP1H",
  "KXESPSUPERCUP1HBTTS", "KXESPSUPERCUP1HSPREAD", "KXESPSUPERCUP1HTOTAL", "KXESPSUPERCUPBTTS", "KXESPSUPERCUPFTTS",
  "KXESPSUPERCUPMOV", "KXESPSUPERCUPSCORE", "KXESPSUPERCUPSPREAD", "KXESPSUPERCUPTOTAL", "KXEWSLADVANCE",
  "KXFACUP1H", "KXFACUP1HBTTS", "KXFACUP1HSCORE", "KXFACUP1HSPREAD", "KXFACUP1HTOTAL", "KXFACUP2H",
  "KXFACUP2HBTTS", "KXFACUP2HSPREAD", "KXFACUP2HTOTAL", "KXFACUPBTTS", "KXFACUPFTTS", "KXFACUPSCORE",
  "KXFIFAWADVANCE", "KXFIFAWBTTS", "KXFIFAWSPREAD", "KXFIFAWTOTAL", "KXFINALISSIMA1H", "KXFINALISSIMA1HBTTS",
  "KXFINALISSIMA1HSPREAD", "KXFINALISSIMA1HTOTAL", "KXFINALISSIMAADVANCE", "KXFINALISSIMABTTS", "KXFINALISSIMAFTTS",
  "KXFINALISSIMAMOV", "KXFINALISSIMASCORE", "KXFINALISSIMASPREAD", "KXFINALISSIMATOTAL", "KXFRASUPERCUP1H",
  "KXFRASUPERCUP1HBTTS", "KXFRASUPERCUP1HSPREAD", "KXFRASUPERCUP1HTOTAL", "KXFRASUPERCUPBTTS", "KXFRASUPERCUPFTTS",
  "KXFRASUPERCUPMOV", "KXFRASUPERCUPSCORE", "KXFRASUPERCUPSPREAD", "KXFRASUPERCUPTOTAL", "KXHNLADVANCE",
  "KXHNLBTTS", "KXHNLSPREAD", "KXHNLTOTAL", "KXINTLFRIENDLY1H", "KXINTLFRIENDLY1HBTTS", "KXINTLFRIENDLY1HSPREAD",
  "KXINTLFRIENDLY1HTOTAL", "KXINTLFRIENDLYADVANCE", "KXINTLFRIENDLYBTTS", "KXITASUPERCUP1H", "KXITASUPERCUP1HBTTS",
  "KXITASUPERCUP1HSPREAD", "KXITASUPERCUP1HTOTAL", "KXITASUPERCUPBTTS", "KXITASUPERCUPFTTS", "KXITASUPERCUPMOV",
  "KXITASUPERCUPSCORE", "KXITASUPERCUPSPREAD", "KXITASUPERCUPTOTAL", "KXJLEAGUE1H", "KXJLEAGUE1HBTTS",
  "KXJLEAGUE1HSPREAD", "KXJLEAGUE1HTOTAL", "KXJLEAGUEADVANCE", "KXJLEAGUEBTTS", "KXJLEAGUESPREAD",
  "KXJLEAGUETOTAL", "KXKLEAGUE1H", "KXKLEAGUE1HBTTS", "KXKLEAGUE1HSPREAD", "KXKLEAGUE1HTOTAL", "KXKLEAGUEADVANCE",
  "KXKLEAGUEBTTS", "KXKLEAGUESPREAD", "KXKLEAGUETOTAL", "KXKNVBCUPBTTS", "KXKNVBCUPSPREAD", "KXKNVBCUPTOTAL",
  "KXLALIGA1HSCORE", "KXLALIGA2ADVANCE", "KXLALIGA2BTTS", "KXLALIGA2H", "KXLALIGA2HBTTS", "KXLALIGA2HSPREAD",
  "KXLALIGA2HTOTAL", "KXLALIGA2SPREAD", "KXLALIGA2TOTAL", "KXLALIGAADVANCE", "KXLALIGAFTTS", "KXLALIGAMOV",
  "KXLALIGASCORE", "KXLIGAMXMOV", "KXLIGAPORTUGAL1H", "KXLIGAPORTUGAL1HBTTS", "KXLIGAPORTUGAL1HSPREAD",
  "KXLIGAPORTUGAL1HTOTAL", "KXLIGAPORTUGALADVANCE", "KXLIGAPORTUGALBTTS", "KXLIGAPORTUGALSPREAD",
  "KXLIGAPORTUGALTOTAL", "KXLIGUE1ADVANCE", "KXLIGUE1FTTS", "KXLIGUE1MOV", "KXLIGUE1SCORE", "KXMLSMOV",
  "KXNCAAMBACCREG", "KXNCAAMBACCREGTOP", "KXNCAAMBBIG10REG", "KXNCAAMBBIG10REGTOP", "KXNCAAMBBIG12REG",
  "KXNCAAMBBIG12REGTOP", "KXNCAAMBBIGTENREG", "KXNCAAMBBIGTENREGTOP", "KXNWSLADVANCE", "KXPERLIGA1ADVANCE",
  "KXSAUDIPL1H", "KXSAUDIPL1HBTTS", "KXSAUDIPL1HSPREAD", "KXSAUDIPL1HTOTAL", "KXSAUDIPLADVANCE",
  "KXSAUDIPLBTTS", "KXSCOTTISHPREM1H", "KXSCOTTISHPREM1HBTTS", "KXSCOTTISHPREM1HSPREAD", "KXSCOTTISHPREM1HTOTAL",
  "KXSCOTTISHPREMADVANCE", "KXSCOTTISHPREMBTTS", "KXSCOTTISHPREMSPREAD", "KXSCOTTISHPREMTOTAL", "KXSERIEAADVANCE",
  "KXSERIEAFTTS", "KXSERIEAMOV", "KXSERIEASCORE", "KXSERIEBADVANCE", "KXSERIEBBTTS", "KXSERIEBSPREAD",
  "KXSERIEBTOTAL", "KXSLGREECEADVANCE", "KXSLGREECEBTTS", "KXSLGREECESPREAD", "KXSLGREECETOTAL",
  "KXSUPERLIGADVANCE", "KXSUPERLIGBTTS", "KXSUPERLIGSPREAD", "KXSUPERLIGTOTAL", "KXSWISSLEAGUEADVANCE",
  "KXSWISSLEAGUEBTTS", "KXSWISSLEAGUESPREAD", "KXSWISSLEAGUETOTAL", "KXTACAPORT1H", "KXTACAPORT1HBTTS",
  "KXTACAPORT1HSPREAD", "KXTACAPORT1HTOTAL", "KXTACAPORTBTTS", "KXTHAIL1ADVANCE", "KXTHAIL1BTTS",
  "KXTHAIL1SPREAD", "KXTHAIL1TOTAL", "KXUAEPLADVANCE", "KXUAEPLBTTS", "KXUAEPLSPREAD", "KXUAEPLTOTAL",
  "KXUCL1HSCORE", "KXUCL2H", "KXUCL2HBTTS", "KXUCL2HSPREAD", "KXUCL2HTOTAL", "KXUCLWADVANCE", "KXUCLWBTTS",
  "KXUCLWSPREAD", "KXUCLWTOTAL", "KXUECLMOV", "KXUEFANL1H", "KXUEFANL1HBTTS", "KXUEFANL1HSPREAD",
  "KXUEFANL1HTOTAL", "KXUEFANLADVANCE", "KXUEFANLBTTS", "KXUEFANLFTTS", "KXUEFANLMOV", "KXUEFANLSCORE",
  "KXUEFANLSPREAD", "KXUEFANLTOTAL", "KXURYPDADVANCE", "KXUSLADVANCE", "KXUSLCUP1H", "KXUSLCUP1HBTTS",
  "KXUSLCUP1HSPREAD", "KXUSLCUP1HTOTAL", "KXUSLCUPADVANCE", "KXUSLCUPBTTS", "KXUSLCUPSPREAD", "KXUSLCUPTOTAL",
  "KXUSOPENCUP1H", "KXUSOPENCUP1HBTTS", "KXUSOPENCUP1HSPREAD", "KXUSOPENCUP1HTOTAL", "KXUSOPENCUPADVANCE",
  "KXUSOPENCUPBTTS", "KXUSOPENCUPFTTS", "KXUSOPENCUPMOV", "KXUSOPENCUPSCORE", "KXUSOPENCUPSPREAD",
  "KXUSOPENCUPTOTAL", "KXVENFUTVEADVANCE", "KXVENFUTVEBTTS", "KXVENFUTVESPREAD", "KXVENFUTVETOTAL",
  "KXWC", "KXWCW",
  // 7/17 triage (66 detected — wave 6 of the A→W derivative rollout: TEAMTOTAL + MOF (Method of
  // Finish) + MOV families for the same club leagues/cups dismissed 7/15–7/16. All 0 live markets;
  // all inherit the no-club-Elo blocker (the whole surface waits on soccer Phase 2 club Elo).
  // KXBRASILEIROTEAMTOTAL's window_fit=true is the known longshot/favorite false positive. DISMISS.
  "KXAFCACTEAMTOTAL", "KXAFCCLMOF", "KXAFCCLTEAMTOTAL", "KXAFCONTEAMTOTAL", "KXALEAGUETEAMTOTAL",
  "KXBRASILEIROBTEAMTOTAL", "KXBRASILEIROCTEAMTOTAL", "KXBRASILEIROTEAMTOTAL", "KXBUNDESLIGATEAMTOTAL",
  "KXCLUBWCMOF", "KXCLUBWCMOV", "KXCLUBWCTEAMTOTAL", "KXCONCACAFCCUPTEAMTOTAL", "KXCONMEBOLLIBTEAMTOTAL",
  "KXCONMEBOLSUDTEAMTOTAL", "KXCOPADELREYMOF", "KXCOPADELREYTEAMTOTAL", "KXCOPADOBRASILTEAMTOTAL",
  "KXCOPPAITALIAMOF", "KXCOPPAITALIATEAMTOTAL", "KXCOUPEDEFRANCEMOF", "KXCOUPEDEFRANCETEAMTOTAL",
  "KXDFBPOKALMOF", "KXDFBPOKALTEAMTOTAL", "KXEFLCHAMPIONSHIPTEAMTOTAL", "KXEFLCUPMOF", "KXEFLCUPTEAMTOTAL",
  "KXEFLL1TEAMTOTAL", "KXEREDIVISIETEAMTOTAL", "KXESPSUPERCUPMOF", "KXESPSUPERCUPTEAMTOTAL",
  "KXFACUPMOF", "KXFACUPMOV", "KXFACUPTEAMTOTAL", "KXFINALISSIMATEAMTOTAL", "KXFRASUPERCUPMOF",
  "KXFRASUPERCUPTEAMTOTAL", "KXINTLFRIENDLYTEAMTOTAL", "KXITASUPERCUPMOF", "KXITASUPERCUPTEAMTOTAL",
  "KXJLEAGUETEAMTOTAL", "KXKLEAGUETEAMTOTAL", "KXLALIGATEAMTOTAL",
  "KXLIGAPORTUGALTEAMTOTAL", "KXLIGUE1TEAMTOTAL", "KXPERLIGA1BTTS",
  "KXSAUDIPLTEAMTOTAL", "KXSCOTTISHPREMTEAMTOTAL", "KXSERIEATEAMTOTAL", "KXTACAPORTTEAMTOTAL",
  "KXUECLMOF", "KXUEFANLTEAMTOTAL", "KXUELMOF", "KXURYPDBTTS",
  "KXUSLCUPTEAMTOTAL", "KXUSLTEAMTOTAL", "KXUSOPENCUPMOF", "KXUSOPENCUPTEAMTOTAL",
  // KXLIGAMXTEAMTOTAL, KXMLSTEAMTOTAL RECLASSIFIED + BUILT 2026-07-23 — removed from this list,
  // same reasoning as the halves reclassification above (base game markets confirmed real+liquid
  // the same day); now in SERIES_CONFIG above. KXUECLTEAMTOTAL/KXUELTEAMTOTAL stay OUT of
  // SERIES_CONFIG — their base game markets are 0 live (UEL/UECL off-season until ~September,
  // see project_maker_league_roadmap_2026_07_23 memory), so still shortlisted only, not built.
  // 7/17 non-soccer stragglers in the same wave:
  "KXLNBPGAME", // LNBP (Mexican pro basketball) game winner — same class as the 7/15 international-
  // basketball dismissals (BNXT/PBA/etc.): no ratings/stats data source (ESPN doesn't cover LNBP;
  // no statsapi equivalent — the LMB adoption relied on MLB statsapi, which has no basketball twin).
  // 0 live markets. Revisit only if a clean LNBP stats API surfaces AND books seed. DISMISS.
  "KXNCAAMBKENPOMRANK", // KenPom ranking futures — poll/rating-position outcome, not a game result;
  "KXNCAAMBKENPOMTOP",  // no NCAAMB model. Same class as KXNCAAWBAPRANK + the 7/15–7/16 NCAAMB
  // conference season futures. DISMISS.
  "KXWCBRACE", // WC player to score a brace (2 goals) — per-player goal novelty; soccer Phase 1 is
  // national-team Elo only (no per-player goal model). Same class as KXWCGOALSTREAK/KXWCGBOOTGOALS. DISMISS.
  // 7/18 wave — cricket match winners + NFL/CFB season futures:
  "KXCPLMATCH", // Caribbean Premier League T20 match winner — no cricket model or data path (KXLPL
  "KXLPLMATCH", // class, 7/15). LPL has live match rows but the books are dead shells (2/98¢, 96¢
  // spread, 0 vol — fails CAPTURE_MAX_SPREAD 6.4×), CPL 0 markets. NOTE: "no data path" no longer
  // means "no ESPN slug" — KXHUNDREDMATCH (8/10 vet) confirmed settlement-authoritative resolution
  // works for cricket (finalized markets carry result:"yes"/"no"). CPL/LPL remain blocked on dead
  // books (not on the data path). Revisit only if books seed. DISMISS.
  "KXNCAAFACCREGTOP", "KXNCAAFB12REGTOP", "KXNCAAFBIGTENREGTOP", "KXNCAAFSECREGTOP",
  // ^ CFB conference regular-season top-finisher futures — no CFB model; season futures class
  // (KXNCAAFH2HWINS 7/10, NCAAF qualifier futures 6/28). DISMISS.
  "KXNFLMATCHUP", // zero markets ever in any status (bare shell, KXWC/KXMILBGAME class) — structure
  // unvettable; no NFL game model exists regardless. DISMISS.
  "KXNFLSTAGEOFELIM", // per-team playoff elimination-stage futures — NFL season futures class. DISMISS.
  "KXNFLTIES", // "≥N ties in the 2026-27 season" novelty futures; windowFit=true was the longshot
  // rung false positive (KXMLBFASTPITCH record-novelty class). DISMISS.
  // 7/20 triage (1 detected):
  "KXWCSCOREET", // "Correct Score after Extra Time" — exact-cell trap class (KXWC1HSCORE/
  // KXBRASILEIROSCORE/KXUCLSCORE/etc., all dismissed) PLUS an ET-specific blocker: soccer.js's
  // Dixon–Coles matrix prices the 90' score only, no extra-time additional-goals sub-model exists.
  // 0 live markets (ET is conditional on a knockout draw after 90'), window_fit false. DISMISS.
  // 7/21 triage (10 detected):
  "KXARGNACBGAME", // Argentine Nacional B (2nd div club soccer) — no club Elo, 0 live. DISMISS.
  "KXASEANGAME",   // ASEAN regional soccer — teams outside the WC_TEAMS Elo registry, 0 live. DISMISS.
  "KXCLUBFGAME",   // Club Friendlies — arbitrary worldwide pairings, no Elo coverage, no
  // competitive-incentive model (lineup effort varies), 0 live. DISMISS.
  "KXLIGAEXPGAME", // Liga de Expansión MX (Mexican 2nd div) — no club Elo, 0 live. DISMISS.
  // KXSCOCUPGAME RECLASSIFIED 2026-07-23 — originally dismissed 7/21 at 0 live markets; its
  // SPREAD/TOTAL siblings showed 64/96 live markets on 2026-07-23 (see the two-track doctrine
  // note near the top of this list), meaning liquidity genuinely changed, not just a stale
  // no-model assumption. Removed from DISMISSED_SERIES, promoted to shortlisted (maker-candidate
  // — the GAME market itself still wasn't independently re-checked, inferred from its siblings).
  // SPREAD/TOTAL were built same-day (see SERIES_CONFIG above); GAME itself remains NOT built —
  // pull a live sample before adding it, don't assume it's still 0.
  "KXINTLPLAYAGAIN", // Player-appearance novelty ("Ronaldo plays for Portugal") — KXWCPLAY/
  // KXBALOGUNPLAY/KXUFCFIGHTOCCUR class; windowFit=true is the usual favorite-appearance false
  // positive. 2 live. DISMISS.
  "KXWCCAREERGOALS", // Career goal-threshold novelty (e.g. "Mbappé 40+ WC goals") — record/threshold
  // class, same shape as KXWCGOALSTREAK. windowFit=true false positive. 3 live. DISMISS.
  "KXWCTEAMS",     // World Cup field-size format vote (governance novelty, not a match outcome).
  // 1 live. DISMISS.
  "KXWNBAASGMVP",  // WNBA All-Star Game MVP award futures — exhibition/award class (KXMLBASGMVP/
  // KXNBASUMMERMVP). 23 live. DISMISS.
  "KXWCQUAL",      // World Cup QUALIFICATION futures (per-team, e.g. "Wales qualifies") — needs a
  // full qualifying-bracket Monte Carlo across every confederation's remaining fixtures; a much
  // bigger build than KXWCADVANCE's knockout sim (which only runs once teams are already IN the
  // tournament). 76 live markets — real depth, revisit as a Phase-2 candidate if a future build
  // cycle needs a target — but no model surface today. windowFit=true is the outright-favorite
  // false positive. DISMISS.
  // 7/22 triage (26 detected, 2 not listed below — see NOTE): sibling market-type tickers
  // (BTTS/spread/total/advance/1H-*) for leagues whose GAME (moneyline) ticker was already
  // dismissed 7/21 — same root cause (no club Elo coverage) applies regardless of market type.
  "KXARGNACBADVANCE", "KXARGNACBBTTS", "KXARGNACBSPREAD", "KXARGNACBTOTAL", // see KXARGNACBGAME.
  "KXASEANADVANCE", "KXASEANBTTS", "KXASEANSPREAD", "KXASEANTOTAL", // see KXASEANGAME.
  "KXCLUBFBTTS", "KXCLUBFSPREAD", "KXCLUBFTOTAL", // see KXCLUBFGAME.
  "KXLIGAEXP1H", "KXLIGAEXP1HBTTS", "KXLIGAEXP1HSPREAD", "KXLIGAEXP1HTOTAL",
  "KXLIGAEXPADVANCE", "KXLIGAEXPBTTS", "KXLIGAEXPSPREAD", "KXLIGAEXPTEAMTOTAL", "KXLIGAEXPTOTAL", // see KXLIGAEXPGAME.
  // KXSCOCUPADVANCE, KXSCOCUPBTTS RECLASSIFIED 2026-07-23 — see KXSCOCUPGAME above. Promoted to
  // shortlisted. NOT built.
  "KXNBANEXTCONTRACT", "KXNBANEXTTEAMOUTLET", // contract-value / news-outlet futures — same
  // news/insider-driven, no-model-surface class as KXNBANEXTTEAM. DISMISS.
  // NOTE: KXNFLTSPEC ("NFL Team Specials") NOT dismissed — still shortlisted (no SERIES_CONFIG
  // entry, not built). Full 305-market ladder pulled 2026-07-23 via /api/kalshi-check?limit=500
  // (blocked earlier same day by a connectivity issue, now resolved). Confirmed a genuine multi-
  // stat-family bundle, ~14 distinct families across TEAM and PLAYER levels, by live market count:
  // PLAYER receiving yards (67, largest single family, 16 real-book), TEAM sacks (32, opponent-flip
  // gotcha applies — see below), TEAM passing yards (32), TEAM shutout/points-allowed (32), PLAYER
  // passing TDs (29), PLAYER rush+rec-yards combo (29), PLAYER any-TDs (23), PLAYER rushing yards
  // (21), PLAYER rushing TDs (13), PLAYER sacks — individual defenders (11), PLAYER interceptions
  // (7), PLAYER season-long passing yards — no "in a single game" qualifier, different target than
  // the single-game family above (6), PLAYER pass+rush-TD combo (2), PLAYER tackles (1, too thin to
  // model alone). None of these map cleanly onto the originally-assumed "just a higher KXNFLTDS
  // rung" — TDs is one family of ~14, not the whole series. TEAM sacks keeps the same opponent-flip
  // gotcha found 2026-07-23 (a team's own boxscore stat is sacks ALLOWED, not recorded — must read
  // the opponent's row). Building this would mean ≥3-4 separate models (team-level Poisson count
  // for sacks/points-allowed, a team-total-yards Normal, a player-yardage/TD hit-rate stack reusing
  // the existing NFL prop hit-rate approach) — a multi-model NFL build, not a single-rung addition.
  // See project_nfltspec_vet_2026_07_23 memory for the full vet + why it's not built yet.
  // 7/23 triage (36 detected — 11 Kalshi + 25 Polymarket):
  "KXSOCCERRETIRE", "KXSOCCERINTLRETIRE", // player retirement announcements — a retirement
  // decision isn't a competitive sporting outcome, no model surface exists or ever will (same
  // non-outcome class as KXWCTEAMS governance votes). 13 / 0 live. DISMISS.
  "KXT20CANADA", "KXT20CANADAMATCH", // Global T20 Canada (champion futures + match winner) —
  // cricket, 0 live markets (shell). Settlement-authoritative resolution is now proven viable for
  // cricket (KXHUNDREDMATCH 8/10 vet), so data-path is not the blocker. Dead books are. DISMISS.
  // KXTBTGAME RECLASSIFIED 2026-07-23 — dismissed same-day for "no ratings source" (true, single-
  // elim streetball with rotating alumni/pickup rosters that don't persist year to year, unlike
  // NBA Summer League's within-tournament Elo), but that's a TAKER blocker only, not a MAKER one
  // (see the two-track doctrine note at the top of this list) — 6 live markets is real liquidity.
  // Removed from DISMISSED_SERIES, promoted to shortlisted (maker-candidate). NOT built.
  "KXWNBA3PTCONTEST", "KXWNBA3PTCONTESTOU", "KXWNBA3PTROUND", // WNBA All-Star 3-point contest
  // (winner futures / threes-made O/U / round-qualifier) — re-checked against the two-track
  // doctrine too: it's a real competitive event (unlike KXWNBAASGMVP-style award futures), so in
  // PRINCIPLE it's maker-viable, but one-day-a-year + only 6 live markets is too thin to be worth
  // a special-case build (same "too thin for useful data" reasoning as the WNBA H2H points/PRA
  // deferral). STAYS dismissed on practical grounds, not the stale no-model reasoning.
  // KXSCOCUPSPREAD, KXSCOCUPTOTAL RECLASSIFIED + BUILT 2026-07-23 — 64/96 live markets, real
  // books; the no-club-Elo blocker is TAKER-only (see the two-track doctrine note above).
  // Removed from DISMISSED_SERIES; now in SERIES_CONFIG above (gameType scocupSpread/
  // scocupTotal, model-free — see project_scocup_spread_total_2026_07_23 memory). Also surfaced
  // that the ticker's "SCOCUP" prefix is a naming trap: the real competition is the Scottish
  // LEAGUE Cup (ESPN sco.cis), not the Scottish Cup proper (sco.tennents, dormant in July).
  "KXWWEFIGHTOCCUR", // WWE wrestler crossing over into a real (non-scripted) fight — a booking/
  // business decision about WHETHER a crossover event happens at all, not a competitive outcome to
  // model. Bare shell (enrichment fetch found 0 live markets). DISMISS.
  // 8/08 triage (8 items from discovery queue):
  "KXNCAAFCONFLEAVE", // College Football Conference Leave — futures outright ("teams to leave their
  // Conference before Jul 1, 2027"), 67 real books but single event per season, no per-game
  // resolution path. Same class as the CFB qualifier futures dismissed 6/28. DISMISS.
  "KXLEAGUESCUP",    // Leagues Cup — discovered 8/08 as perGame:false; confirmed single-event:
  // "Leagues Cup Champion 2026 Season" futures only. No per-game KXLEAGUESCUPGAME listed. DISMISS.
  "KXUEFAEUROQUAL",  // UEFA Euros Qualifiers — single event "2028 UEFA Euros Qualifiers", a
  // multi-year qualification outright. No per-game markets. DISMISS.
  "KXMMACOMPETE",    // "Fighters to compete in MVP event" — MVP event participation futures
  // (25 real books), not per-fight outcome markets. No ESPN resolver path. DISMISS.
  "KXNBAXMASOPPONENT", // NBA Christmas Day Opponent — pre-season schedule futures (which team
  // each franchise plays on Christmas Day). No per-game model or resolver path. DISMISS.
  "KXMLBAWARDFIN",   // MLB Award Finalists — season-end award nomination futures (e.g. MVP, Cy
  // Young finalists). No game-level resolution path. DISMISS.
  "KXNBAFIRSTOPPONENT", // NBA First Opponent of the Season — pre-season futures. DISMISS.
  "KXHEISMANSPECIAL", // Heisman Trophy Winner Specials — award futures, 9 real books (too thin
  // even for shortlist). No college football model. DISMISS.
  "KXNWSL", // NWSL Champion season-long futures — bare-prefix (futures), confirmed as champion
  // outright; KXNWSLGAME (per-game) is already adopted. DISMISS.
  // 8/10 vet — KXNBASTARTERS + KXKFTOUR + KXHUNDREDMATCH:
  "KXKFTOUR", // Korn Ferry Tour (PGA developmental tour) — per-player tournament WINNER outrights
  // ("Will X win the Boise Open?"), NOT H2H. Wrong structure for the golf framework (KXPGAH2H is
  // H2H only). Dead books: 94 of 100 markets have no_ask=100¢ (NO side completely unquoted) —
  // YES-only one-sided quotes. 15 total contracts across all markets; 3 markets with any volume.
  // medianSpreadC 15 is at the cap and reflects only the YES bid-ask width, not a real two-sided
  // spread. ESPN `golf/kft/scoreboard` returns 1 event with no league name (partial support).
  // perGame:false confirmed — per-tournament outrights. DISMISS.
  "KXNBASTARTERS", // NBA Season-Opener Starting Lineup — per-PLAYER binary "will start the first
  // game of the 2026-27 regular season" futures. 100 markets across 9 of 30 teams (BOS/DAL/DEN/
  // GSW/LAL/MIA/MIN/NYK/PHI), 10-13 players per team. All settle once (season opener ~late Oct
  // 2026; close_time Nov 7). 9¢ median spread, mostly 0 OI (only Shannon Jr. at ~700 ct had real
  // volume). NOT a recurring per-game surface — one event per team ever (first game only), so
  // there is no calibration data set to accrue. Market class: pre-season lineup speculation
  // outrights, same class as KXNBAFIRSTOPPONENT/KXNBAXMASOPPONENT. DISMISS.
  "KXHUNDREDMATCH", // The Hundred cricket (men's) match winner — binary ML, BOTH sides quoted,
  // 1¢ spread, real books with genuine day-of liquidity (~36K contracts/33K OI on TRE vs SOU;
  // pre-game D-1 is thin: ~50-150 contracts, fills up day-of). 8 teams: BIR/LON/MLO/MSG/SOU/
  // SUL/TRE/WEL — clean 3-char abbrs, no collision. Overround ~1.01 (both sides sum to 101¢).
  // No ESPN cricket slug (site.api.espn.com 404s on cricket; ESPNcricinfo is a different API,
  // blocked by Akamai). Resolution path: settlement-AUTHORITATIVE — finalized Kalshi markets
  // carry result:"yes"/"no" within hours of game end, same class as Dota2 (no ESPN resolver
  // needed). gameTime encodes directly in the ticker: KXHUNDREDMATCH-26AUG101330SOUTRE-SOU →
  // Aug 10 at 13:30 UTC (same kalshiTickerGameTime parse pattern as Dota2). Ties/abandonment
  // resolve to $0.50 (Kalshi rules). Settlement sources: Cricbuzz/ESPNcricinfo/BBC/ICC/official.
  // BLOCKER: season ends ~Aug 14, 2026 — 4 games remained when vetted (8/10). Annual series
  // (runs July–Aug each year). BUILD PATH for 2027: settlement-authoritative + ticker gameTime
  // (no ESPN slug), both sides captured (unlike Dota2 which is YES-only), 8-team teams.js
  // block, one SERIES_CONFIG row with gameType:"hundredMatch" or reuse a dota2Game-like emitter.
  // REVISIT June 2027 before the season opens.
  "KXWHUNDREDMATCH", // The Hundred cricket (WOMEN'S) — surfaced 2026-08-10 by the re-screen, which
  // revived it on a 1¢ spread. Same competition family, same verdict, same blocker as the men's
  // entry above: REAL_BOOK (6/6 two-sided, $32.6k volume) but the season ends ~Aug 14 2026, so a
  // build lands with a handful of games. Same build path — settlement-authoritative, gameTime
  // straight off the ticker (KXWHUNDREDMATCH-26AUG121000MIBIR → Aug 12 10:00 UTC), both sides
  // quoted, same 8 franchises. ONE EXTRA TRAP for 2027: the women's side uses a 2-char code
  // ("MI" for MI London, e.g. 26AUG121000MIBIR), so unlike the men's it ALSO needs `whundred` in
  // parseGameTeams' variable-length allowlist — a canonical 2-char abbr is invisible to the
  // generic has2charPrefix path (see the NFL GBSEA→["GBS","EA"] failure, same day).
  // REVISIT June 2027 alongside the men's.
  // 8/10 triage — KXUCL, KXLEAGUESCUPSCORE, KXLEAGUESCUPFTTS:
  "KXUCL", // UCL season champion futures — bare-prefix outright ("which club wins the 2026-27
  // Champions League"), 29 markets all closing 2027-06-19, same class as KXNWSL dismissed.
  // KXUCLGAME (per-game qualifier/group-stage matches, 30/30 real books, 1¢ spread) is separate
  // and shortlisted. DISMISS this bare-prefix futures only.
  "KXLEAGUESCUPSCORE", // Leagues Cup exact final-score longshot (e.g. "Tigres UANL wins 5-2") —
  // 100 markets, 41 real books, 3¢ spread. Same exact-cell longshot class as KXWCWINMARGIN
  // (dismissed 6/23). Volume 497 total across all markets. DISMISS.
  "KXLEAGUESCUPFTTS", // Leagues Cup First Team To Score — "which team scores first" prop market,
  // 18 markets, 23 total contracts, 7.5¢ spread. Thin and non-standard shape (3 outcomes:
  // team-A / team-B / No Goal). DISMISS.
  // 8/10 — Big 5 European league bare-prefix futures. Pattern identical to KXNWSL/KXUCL dismissed
  // above: bare-prefix = season champion outright (closes ~Jun 2027); per-game series is separate.
  // KXBUNDESLIGAGAME (per-game) also 0 live / empty shell 2026-08-10 (season not started) — stays
  // shortlisted, not built; recheck late Aug when Bundesliga GW1 kicks off.
  "KXPREMIERLEAGUE", // EPL season champion futures (20 mkts, all close 2027-06-13). Per-game = KXEPLGAME, adopted this commit.
  "KXLALIGA",        // La Liga season champion futures. Per-game = KXLALIGAGAME, adopted this commit.
  "KXSERIEA",        // Serie A season champion futures. Per-game = KXSERIEAGAME, adopted this commit.
  "KXLIGUE1",        // Ligue 1 season champion futures. Per-game = KXLIGUE1GAME, adopted this commit.
  "KXBUNDESLIGA",    // Bundesliga season champion futures. Per-game KXBUNDESLIGAGAME = empty shell 8/10.
  // 8/10 — 3 more bare-prefix futures, same class as Big 5 above.
  "KXLALIGA2",       // La Liga 2 season champion futures (empty shell 8/10, 0 live mkts). Per-game = KXLALIGA2GAME, adopted this commit.
  "KXUSL",           // USL Championship season champion futures (25 mkts, 1 per team). Per-game = KXUSLGAME, adopted this commit.
  "KXCONMEBOLLIB",   // Copa Libertadores tournament-winner futures (16 mkts, 1 per QF team). Per-game = KXCONMEBOLLIBGAME, adopted this commit.
  // ── 8/10 discovery-queue vet, 9 items. All screened THIN (the deliberate not-enough-evidence
  // bucket the auto-screen never actions), so each is a human structural call, not a liquidity
  // one — none of these has a per-game resolution flow no matter how deep the book gets.
  // KXFIFALEAVE is the reminder that volume proves nothing about buildability: $77.6k traded on
  // ONE market that resolves once.
  "KXNBARELOCATION",   // Which city Portland relocates to (Tampa Bay / St. Louis / Seattle / …),
  // 11 mkts closing 2027-12-01. Insider/news-driven city outright — no game, no model surface.
  // Same class as the manager/signing novelties dismissed 8/08.
  "KXNBAMOSTWINS",     // Season win-total ladder ("72+ wins", "70+", "67+"), closes 2027-05-08.
  // Season futures — resolves once a year, no repeatable daily flow. Same class as KXNFLTEAMPTS.
  "KXNCAAFACCWINS",    // "N+ ACC teams to win in week 10" — an aggregated per-WEEK count across
  // many games, not a per-game market. Combinatorial over a slate we don't model; 1 real book,
  // 56¢ spread, zero volume.
  "KXFIFALEAVE",       // Single YES/NO governance novelty closing 2027-01-01. One market, one
  // resolution, insider-driven. High volume ($77.6k) but nothing repeatable to capture.
  "KXMLBPITCH",        // "Shohei Ohtani to pitch in a game" — player usage/availability novelty.
  // No lineup or usage model and no pre-game data source for it. Same class as KXWCSTART.
  "KXMLBTRIPLECROWN",  // Season award futures ("Yordan Alvarez wins Triple Crown"), closes with
  // the season. Same class as the MLB award finalists dismissed 8/08.
  "KXNBACOMPETE",      // Player participation futures ("Ben Simmons", closes 2027-07-08) — exactly
  // the KXMMACOMPETE class dismissed 8/08. No participation model.
  "KXPOCHETTINOOUT",   // Manager-departure novelty closing 2030-06-15. Same class as the coaching
  // -hire/manager-exit markets dismissed 8/08.
  "KXUEFASC1HSPREAD",  // UEFA Super Cup 1st-half spread. The only one here that IS a real per-game
  // threshold market (PSG v Aston Villa, 2026-08-12) — dismissed on FREQUENCY, not shape: the
  // Super Cup is ONE match per year, so at 2 markets a year this can never reach a sample size
  // that means anything, and it currently quotes a 53¢ spread on zero volume. Same reasoning as
  // the Home Run Derby dismissal (a 72-hour event, not a season flow).
  // ── 8/10, second pass: two items the post-dismissal scan surfaced.
  "KXNCAAFSECWINS",    // "N+ SEC teams to win in week 10" — the exact twin of KXNCAAFACCWINS
  // above (same 26W10 event shape, closes 2027-01-07). Aggregated per-WEEK count across a slate,
  // not a per-game market. Screens REAL_BOOK (6/8, 5¢) — real book, wrong shape, which is the
  // whole reason the screen never auto-promotes.
  "KXYTDAILYTOPVIDEOG", // "top music video global" — YouTube daily chart, NOT A SPORT. Sits in the
  // Sports catalog by Kalshi's own miscategorization, which is why the scan keeps reviving it on
  // its 1¢ spread and $113k volume. No sports resolution path exists because there is no sport.
  "KXLEADERNFLRUSHTDS", // NFL season rushing-TD leader — one market per player, closes 2027-02-08.
  // Season-leader outright: resolves once a year off a full-season aggregate, no per-game flow.
  // FIRST explicit dismissal of the KXLEADER* family (KXLEADERMLBHR and siblings are still sitting
  // in `baseline`, silently ack'd rather than judged) — same class, dismiss them as they surface.
];
