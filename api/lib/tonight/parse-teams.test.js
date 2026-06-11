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
