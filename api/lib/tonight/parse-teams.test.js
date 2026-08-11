// node --test api/lib/tonight/parse-teams.test.js
// Table-driven tests for the Kalshi event-ticker team parser + TEAM_NORM normalization.
// Each case here pins a documented breakage mode (see CLAUDE.md "Key Gotchas").

import { test } from "node:test";
import assert from "node:assert/strict";
import { TEAM_NORM, normTeam, parseGameTeams, _VALID_TEAMS } from "./parse-teams.js";

// Ticker format: KXSPORT-YYMMDDHHMMTEAM1TEAM2-SUFFIX. The parser does seg.slice(7), then an
// optional /^\d{4}[A-Z]/ strip for tickers carrying a 4-digit time tail.
// Build a ticker whose post-slice(7) rest is exactly `teams` (7 date chars before teams):
const ticker = (teams) => `KXTEST-2606111${teams}-SUF`;
// And one exercising the extra 4-digit strip: rest = "9300" + teams (time HHMM tail).
const tickerWithTime = (teams) => `KXTEST-26061119300${teams}-SUF`;

test("parseGameTeams: NBA 3+3 validated split (NYKPHI gotcha)", () => {
  // Without _VALID_TEAMS validation this parsed as NY+KPH (NY is a 2-char Kalshi prefix).
  assert.deepEqual(parseGameTeams(ticker("NYKPHI"), "nba"), ["NYK", "PHI"]);
  assert.deepEqual(parseGameTeams(ticker("SASMIN"), "nba"), ["SAS", "MIN"]);
});

test("parseGameTeams: NBA 2+3 split for 2-char Kalshi prefixes", () => {
  assert.deepEqual(parseGameTeams(ticker("GSMIA"), "nba"), ["GSW", "MIA"]);
  assert.deepEqual(parseGameTeams(ticker("NODEN"), "nba"), ["NOP", "DEN"]);
  assert.deepEqual(parseGameTeams(ticker("NJBOS"), "nba"), ["BKN", "BOS"]);
});

test("parseGameTeams: 4-digit time tail stripped before team parse", () => {
  assert.deepEqual(parseGameTeams(tickerWithTime("NYKPHI"), "nba"), ["NYK", "PHI"]);
});

test("parseGameTeams: WNBA variable-length splits", () => {
  // 4+3: longer-left preference — CONNIN must parse CONN+IND, not CON+NIN or CO+NNIN.
  assert.deepEqual(parseGameTeams(ticker("CONNIND"), "wnba"), ["CONN", "IND"]);
  // 3+4: right side 4-char.
  assert.deepEqual(parseGameTeams(ticker("INDCONN"), "wnba"), ["IND", "CONN"]);
  // 2+2: both halves 2-char canonical.
  assert.deepEqual(parseGameTeams(ticker("LVNY"), "wnba"), ["LV", "NY"]);
  assert.deepEqual(parseGameTeams(ticker("GSLA"), "wnba"), ["GS", "LA"]);
  // Kalshi alias forms normalize: LAS→LA, GSV→GS, WAS→WSH.
  assert.deepEqual(parseGameTeams(ticker("LASATL"), "wnba"), ["LA", "ATL"]);
  assert.deepEqual(parseGameTeams(ticker("GSVSEA"), "wnba"), ["GS", "SEA"]);
  assert.deepEqual(parseGameTeams(ticker("WASMIN"), "wnba"), ["WSH", "MIN"]);
});

test("parseGameTeams: MLS variable-length splits (2/3/4-char mix, like WNBA)", () => {
  // 4+3: longer-left preference — NYRBCLT must parse NYRB+CLT, not NY+RBCLT.
  assert.deepEqual(parseGameTeams(ticker("NYRBCLT"), "mls"), ["NYRB", "CLT"]);
  // 4+4: both sides 4-char.
  assert.deepEqual(parseGameTeams(ticker("LAFCNYRB"), "mls"), ["LAFC", "NYRB"]);
  // 2+3: 2-char left side (SJ, SD, NE all 2-char canonical MLS abbrs).
  assert.deepEqual(parseGameTeams(ticker("SJLAG"), "mls"), ["SJ", "LAG"]);
  assert.deepEqual(parseGameTeams(ticker("SDDAL"), "mls"), ["SD", "DAL"]);
  assert.deepEqual(parseGameTeams(ticker("NEATL"), "mls"), ["NE", "ATL"]);
  // 3+4: right side 4-char.
  assert.deepEqual(parseGameTeams(ticker("SKCLAFC"), "mls"), ["SKC", "LAFC"]);
  // 3+3: the common case.
  assert.deepEqual(parseGameTeams(ticker("DCUTOR"), "mls"), ["DCU", "TOR"]);
  assert.deepEqual(parseGameTeams(ticker("PHISEA"), "mls"), ["PHI", "SEA"]);
});

test("parseGameTeams: copadobrasil 2-char CR (Remo) split, no false 3+2 fallback", () => {
  // The bug: copadobrasil was NOT in the variable-length split allowlist, so CRSAN (Remo+Santos)
  // fell through to the unvalidated 3+2 fallback → ["CRS","AN"] (both invalid). CR has no TEAM_NORM
  // alias (registry has no kalshi aliases), so the generic has2charPrefix path could not save it.
  assert.deepEqual(parseGameTeams(ticker("CRSAN"), "copadobrasil"), ["CR", "SAN"]);
  // Longer-left preference must still win: CRUCHA is CRU+CHA, not CR+UCHA.
  assert.deepEqual(parseGameTeams(ticker("CRUCHA"), "copadobrasil"), ["CRU", "CHA"]);
  // 3+3 common case + an espnScore-aliased code (ATL canonical here = Atlético Mineiro).
  assert.deepEqual(parseGameTeams(ticker("JUVATL"), "copadobrasil"), ["JUV", "ATL"]);
  assert.deepEqual(parseGameTeams(ticker("CORINT"), "copadobrasil"), ["COR", "INT"]);
});

test("parseGameTeams: NFL variable-length splits (eight 2-char abbrs)", () => {
  // The bug this pins (found 2026-08-10, before KXNFLGAME capture went live): nfl was NOT in the
  // variable-length allowlist and only "LA" carries a TEAM_NORM entry, so has2charPrefix was false
  // for GB/KC/LV/NE/NO/SF/TB. 2+2 pairs fell past every branch to [null,null]; 2+3 pairs hit the
  // unvalidated 3+2 fallback and silently invented teams.
  assert.deepEqual(parseGameTeams(ticker("GBKC"), "nfl"), ["GB", "KC"]);   // was [null,null]
  assert.deepEqual(parseGameTeams(ticker("NEKC"), "nfl"), ["NE", "KC"]);   // was [null,null]
  assert.deepEqual(parseGameTeams(ticker("SFTB"), "nfl"), ["SF", "TB"]);   // was [null,null]
  assert.deepEqual(parseGameTeams(ticker("NOLV"), "nfl"), ["NO", "LV"]);   // was [null,null]
  assert.deepEqual(parseGameTeams(ticker("GBSEA"), "nfl"), ["GB", "SEA"]); // was ["GBS","EA"]
  assert.deepEqual(parseGameTeams(ticker("SEAGB"), "nfl"), ["SEA", "GB"]); // 3+2
  assert.deepEqual(parseGameTeams(ticker("DALSEA"), "nfl"), ["DAL", "SEA"]);
  assert.deepEqual(parseGameTeams(ticker("NYGNYJ"), "nfl"), ["NYG", "NYJ"]);
  // Longer-left preference is load-bearing here: LAC and LA (→LAR) share a prefix, so the
  // 5-char and 6-char forms must land on different teams.
  assert.deepEqual(parseGameTeams(ticker("LACHI"), "nfl"), ["LAR", "CHI"]);
  assert.deepEqual(parseGameTeams(ticker("LACCHI"), "nfl"), ["LAC", "CHI"]);
  // Kalshi spells Jacksonville JAC and Washington WAS; canonical is JAX/WSH. Missing these two
  // aliases dropped four real 2026 events (JACNO / MIAWAS / CLEJAC / WASPHI) with no drop row.
  assert.deepEqual(parseGameTeams(ticker("JACNO"), "nfl"), ["JAX", "NO"]);
  assert.deepEqual(parseGameTeams(ticker("MIAWAS"), "nfl"), ["MIA", "WSH"]);
  assert.deepEqual(parseGameTeams(ticker("CLEJAC"), "nfl"), ["CLE", "JAX"]);
  assert.deepEqual(parseGameTeams(ticker("WASPHI"), "nfl"), ["WSH", "PHI"]);
});

test("parseGameTeams: KBO 2+3 / 3+2 splits (LG Twins' 2-char code)", () => {
  // kbo has no kalshi aliases, so TEAM_NORM.kbo is EMPTY and has2charPrefix can never see "LG".
  // Without kbo in the variable-length allowlist, LGKIW (5 chars) falls to the unvalidated 3+2
  // fallback → ["LGK","IW"], the GBSEA failure in a second league.
  assert.deepEqual(parseGameTeams(ticker("LGKIW"), "kbo"), ["LG", "KIW"]);
  assert.deepEqual(parseGameTeams(ticker("KIWLG"), "kbo"), ["KIW", "LG"]);
  assert.deepEqual(parseGameTeams(ticker("SAMKIA"), "kbo"), ["SAM", "KIA"]);
  assert.deepEqual(parseGameTeams(ticker("LGSSG"), "kbo"), ["LG", "SSG"]);
  assert.deepEqual(parseGameTeams(ticker("NCDKTW"), "kbo"), ["NCD", "KTW"]);
  // Real ticker shape carries HHMM after YYMONDD — the 4-digit strip must run first.
  assert.deepEqual(parseGameTeams("KXKBOGAME-26AUG130600LGKIW-LG", "kbo"), ["LG", "KIW"]);
});

test("parseGameTeams: MLB normalization inside split", () => {
  assert.deepEqual(parseGameTeams(ticker("CHWDET"), "mlb"), ["CWS", "DET"]);
  assert.deepEqual(parseGameTeams(ticker("OAKSEA"), "mlb"), ["ATH", "SEA"]);
  // 2-char Kalshi prefixes that are already canonical (KC, SD, SF, TB).
  assert.deepEqual(parseGameTeams(ticker("KCHOU"), "mlb"), ["KC", "HOU"]);
  assert.deepEqual(parseGameTeams(ticker("TBNYY"), "mlb"), ["TB", "NYY"]);
});

test("parseGameTeams: NHL alias normalization", () => {
  assert.deepEqual(parseGameTeams(ticker("TBLDAL"), "nhl"), ["TBL", "DAL"]);
  assert.deepEqual(parseGameTeams(ticker("LACHI"), "nhl"), ["LAK", "CHI"]);
  assert.deepEqual(parseGameTeams(ticker("SJEDM"), "nhl"), ["SJS", "EDM"]);
});

test("parseGameTeams: garbage and too-short input → [null, null]", () => {
  assert.deepEqual(parseGameTeams("", "nba"), [null, null]);
  assert.deepEqual(parseGameTeams(null, "nba"), [null, null]);
  assert.deepEqual(parseGameTeams("KXTEST", "nba"), [null, null]); // no dash segment
  assert.deepEqual(parseGameTeams(ticker("XY"), "nba"), [null, null]); // rest too short
  assert.deepEqual(parseGameTeams(ticker("ZZZQQQ"), "wnba"), [null, null]); // no valid split
});

test("normTeam: passthrough for unmapped abbrs, mapping for aliases", () => {
  assert.equal(normTeam("nba", "BOS"), "BOS");
  assert.equal(normTeam("nba", "GS"), "GSW");
  assert.equal(normTeam("nba", "KAT"), "ATL");
  assert.equal(normTeam("wnba", "CONNECTICU"), "CONN");
  assert.equal(normTeam("mlb", "WSN"), "WSH");
  assert.equal(normTeam("nosport", "ABC"), "ABC");
});

test("TEAM_NORM targets are all valid canonical teams", () => {
  // Every normalization must land inside _VALID_TEAMS for its sport, otherwise the
  // parser validates against an abbr no other map recognizes (silent market drop).
  for (const [sport, map] of Object.entries(TEAM_NORM)) {
    const valid = _VALID_TEAMS[sport];
    if (!valid) continue;
    for (const [from, to] of Object.entries(map)) {
      assert.ok(valid.has(to), `TEAM_NORM.${sport}.${from} → ${to} not in _VALID_TEAMS.${sport}`);
    }
  }
});
