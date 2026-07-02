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
  // Soccer — FIFA World Cup. One Elo-derived score matrix per game feeds all five families
  // (api/lib/tonight/soccer.js). The `soccer` gameType routes these to the dedicated soccer
  // emit path (not parseGameTeams). Shadow-only: `soccer|*` is intentionally NOT in the gate.
  KXWCGAME:      { sport: "soccer", league: "wc", stat: "game",      col: "ML",  gameType: "soccer", subtype: "game"      },
  KXWCTOTAL:     { sport: "soccer", league: "wc", stat: "total",     col: "G",   gameType: "soccer", subtype: "total"     },
  KXWCSPREAD:    { sport: "soccer", league: "wc", stat: "spread",    col: "G",   gameType: "soccer", subtype: "spread"    },
  KXWCTEAMTOTAL: { sport: "soccer", league: "wc", stat: "teamTotal", col: "G",   gameType: "soccer", subtype: "teamTotal" },
  KXWCBTTS:      { sport: "soccer", league: "wc", stat: "btts",      col: "G",   gameType: "soccer", subtype: "btts"      },
  // World Cup half markets (shadow-only) — same Elo matrix, half λ (×0.5 even split). 1H + 2H ×
  // winner/total/spread/BTTS, projected by emitSoccerPlays off a half-scaled matrix. The `half`
  // tag routes them to the half matrix + prefixes the stat (soccer|1htotal, etc.).
  KXWC1H:        { sport: "soccer", league: "wc", stat: "1hgame",   col: "ML",  gameType: "soccer", subtype: "game",   half: "1h" },
  KXWC1HTOTAL:   { sport: "soccer", league: "wc", stat: "1htotal",  col: "G",   gameType: "soccer", subtype: "total",  half: "1h" },
  KXWC1HSPREAD:  { sport: "soccer", league: "wc", stat: "1hspread", col: "G",   gameType: "soccer", subtype: "spread", half: "1h" },
  KXWC1HBTTS:    { sport: "soccer", league: "wc", stat: "1hbtts",   col: "G",   gameType: "soccer", subtype: "btts",   half: "1h" },
  KXWC2H:        { sport: "soccer", league: "wc", stat: "2hgame",   col: "ML",  gameType: "soccer", subtype: "game",   half: "2h" },
  KXWC2HTOTAL:   { sport: "soccer", league: "wc", stat: "2htotal",  col: "G",   gameType: "soccer", subtype: "total",  half: "2h" },
  KXWC2HSPREAD:  { sport: "soccer", league: "wc", stat: "2hspread", col: "G",   gameType: "soccer", subtype: "spread", half: "2h" },
  KXWC2HBTTS:    { sport: "soccer", league: "wc", stat: "2hbtts",   col: "G",   gameType: "soccer", subtype: "btts",   half: "2h" },
  // World Cup knockout "to advance" (shadow-only) — a per-tie binary that settles on who advances
  // (ET/penalties outcome, not the 90' score). The `soccerAdvance` gameType routes these to the
  // dedicated emit path (api/lib/tonight/soccer-advance.js): the same Elo matrix as the 5 families,
  // with the 90'-draw mass folded into a "to advance" prob. Shadow-only: `soccer|advance` NOT gated.
  KXWCADVANCE:   { sport: "soccer", league: "wc", stat: "advance",   col: "ML",  gameType: "soccerAdvance" },
  // Fighting — UFC rounds O/U ("Will the fight end before round N?"). The `fight` gameType
  // routes these to the dedicated fight emit path (api/lib/tonight/fight.js): one weight-class
  // finish-rate → fight-duration CDF per bout. Shadow-only: `fight|rounds` is NOT in the gate.
  KXUFCROUNDS:   { sport: "fight", league: "ufc", stat: "rounds", col: "RD", gameType: "fight" },
  // Golf — PGA single-round head-to-head ("Will A beat B in round N?"). The `golfH2h` gameType
  // routes these to the dedicated golf emit path (api/lib/tonight/golf-h2h.js): OWGR rating →
  // one-round score differential. Binary favorite side. Shadow-only: `golf|h2h` NOT in the gate.
  KXPGAH2H:      { sport: "golf", league: "pga", stat: "h2h", col: "ML", gameType: "golfH2h" },
  // NASCAR — Cup head-to-head ("Will A beat B?") + Top-10 finish ("Will <driver> finish top 10?").
  // The `nascar` gameType routes both to the dedicated emit path (api/lib/tonight/nascar.js):
  // recent-form finishing-position model. Binary favorite side. Cup-only by construction (the
  // rating index is built from the Cup schedule). Shadow-only: `nascar|h2h`/`nascar|top10` NOT gated.
  KXNASCARH2H:   { sport: "nascar", league: "nascar", stat: "h2h",   col: "ML", gameType: "nascar", subtype: "h2h"   },
  KXNASCARTOP10: { sport: "nascar", league: "nascar", stat: "top10", col: "ML", gameType: "nascar", subtype: "top10" },
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
  "KXMLBGAME", "KXNBAGAME", "KXWNBAGAME", "KXNHLGAME",
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
  // 7/01 vet (shortlisted 6/30): model end is GREEN — cheapest baseball-ML build we have. statsapi
  // sportId 23 / leagueId 125 ("Mexican League") gives 20 name-exact teams (2 alias fixes: Tecos/
  // Tecolotes, Acereros del Norte/Monclova), schedule (gamePk+status) for hydrate+resolve, and
  // standings (W/L/RS/RA) for a Pythag/run-diff λ → simulateMLBJoint favorite-side P(win). BUT the
  // Kalshi end is DEAD: dense daily slate (96 active ML pairs) yet 0 volume / 0 OI / no MM book —
  // live orderbook is 1¢ placeholder bids both sides (~98¢ spread), even on the already-settled
  // Jun-30 game. yes_ask null/99¢ fails both CAPTURE_CAP 97 and CAPTURE_MAX_SPREAD 15¢ → captures
  // ZERO shadow rows. Same failure mode as KXWNBAH2H (buildable model, market too thin) except LMB
  // is dense-daily not sporadic → the ONLY blocker is Kalshi hasn't seeded liquidity. DISMISS to
  // clear the banner; revisit (build the λ→joint emit) the moment yes_ask populates on this series.
  "KXLMBGAME",
  "KXNBASUMMERGAME", // 7/01 triage: NBA Summer League game-winner (20 live mkts, window_fit=true). No
  // rating source — SL "teams" are NBA franchises with rookie/two-way/G-League rosters, so nba.js
  // ratings (OffRtg/pace/regime λ/usage, all regular-season) don't transfer, and there's no
  // off-the-shelf Summer League team rating to build a Phase-1 model from. window_fit=true is the
  // favorite false-positive. Same class as prior no-model dismissals. Revisit only if a draft-
  // capital / player-aggregate SL rating ever gets built. DISMISS.
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
];
