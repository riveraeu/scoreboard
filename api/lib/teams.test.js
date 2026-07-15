// node --test api/lib/teams.test.js
// Pins every map derived from the team registry (teams.js) against the literal values
// that lived in parse-teams.js / sports.js / wnba.js / nhl.js / mlb-shared.js before the
// 2026-06-11 consolidation. A registry typo fails here instead of silently breaking a
// ticker parse or an ESPN lookup. If a team genuinely changes (rebrand, relocation,
// new alias), update the fixture AND the registry together.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEAMS, TEAM_NORM, _VALID_TEAMS, CANONICAL_TO_ESPN,
  WNBA_CANON_TO_ESPN, WNBA_ESPN_TO_CANON, WNBA_TEAM_IDS,
  NHL_ABBR_MAP, MLB_ID_TO_ABBR, LMB_ID_TO_ABBR,
} from "./teams.js";

// ── Fixtures: exact pre-registry literals ────────────────────────────────────────

const LEGACY_TEAM_NORM = {
  nba: { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX", WPH: "PHX", KAT: "ATL" },
  wnba: { CONNECTICU: "CONN", CON: "CONN", DALLAS: "DAL", WAS: "WSH", GSV: "GS", LAS: "LA", PDX: "POR" },
  nhl: { NJ: "NJD", TB: "TBL", LA: "LAK", SJ: "SJS", VGK: "VGK" },
  mlb: { KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", CHW: "CWS", AZ: "ARI", KC: "KC", SD: "SD", SF: "SF", TB: "TB", OAK: "ATH", WSN: "WSH", WAS: "WSH" },
  nfl: { LA: "LAR" },
  lmb: {}, // canonical = Kalshi abbrs, no aliases
};

const LEGACY_VALID_TEAMS = {
  nba: ["ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"],
  wnba: ["ATL","CHI","CONN","DAL","GS","IND","LV","LA","MIN","NY","PHX","POR","SEA","TOR","WSH"],
  nhl: ["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","STL","SJS","SEA","TBL","TOR","UTA","VAN","VGK","WSH","WPG"],
  mlb: ["ARI","ATL","ATH","BAL","BOS","CHC","CIN","CLE","COL","CWS","DET","HOU","KC","LAA","LAD","MIA","MIL","MIN","NYM","NYY","PHI","PIT","SD","SEA","SF","STL","TB","TEX","TOR","WSH"],
  nfl: ["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SEA","SF","TB","TEN","WSH"],
  lmb: ["ADM","AGU","ALG","BLE","CAL","CDJ","CON","DIA","DOR","GUE","LDY","ODT","PDC","PDP","RDA","SDM","SDS","TDQ","TDT","TEL"],
};

const LEGACY_CANONICAL_TO_ESPN = {
  mlb: { CWS: "CHW" },
  nba: { GSW: "GS", SAS: "SA", NYK: "NY", NOP: "NO", UTA: "UTAH", WAS: "WSH" },
  wnba: { CONN: "CON" },
  nhl: { TBL: "TB", NJD: "NJ", LAK: "LA", SJS: "SJ" },
};

const LEGACY_WNBA_TEAM_IDS = {
  ATL: 20, CHI: 19, CONN: 18, DAL: 3, GS: 129689,
  IND: 5, LV: 17, LA: 6, MIN: 8, NY: 9,
  PHX: 11, POR: 132052, SEA: 14, TOR: 131935, WSH: 16,
};
const LEGACY_WNBA_ESPN_TO_CANON = { CONNECTICU: "CONN", DALLAS: "DAL", WAS: "WSH", GSV: "GS", LAS: "LA" };
const LEGACY_WNBA_CANON_TO_ESPN = { CONN: "CONNECTICU", DAL: "DALLAS", WSH: "WAS", LA: "LAS" };

const LEGACY_NHL_ABBR_MAP = { 1: "NJD", 2: "NYI", 3: "NYR", 4: "PHI", 5: "PIT", 6: "BOS", 7: "BUF", 8: "MTL", 9: "OTT", 10: "TOR", 12: "CAR", 13: "FLA", 14: "TBL", 15: "WSH", 16: "CHI", 17: "DET", 18: "NSH", 19: "STL", 20: "CGY", 21: "COL", 22: "EDM", 23: "VAN", 24: "ANA", 25: "DAL", 26: "LAK", 28: "SJS", 29: "CBJ", 30: "MIN", 52: "WPG", 54: "VGK", 55: "SEA", 68: "UTA" };

const LEGACY_MLB_ID_TO_ABBR = {
  108: "LAA", 109: "ARI", 110: "BAL", 111: "BOS", 112: "CHC", 113: "CIN", 114: "CLE",
  115: "COL", 116: "DET", 117: "HOU", 118: "KC", 119: "LAD", 120: "WSH", 121: "NYM",
  133: "ATH", 134: "PIT", 135: "SD", 136: "SEA", 137: "SF", 138: "STL", 139: "TB",
  140: "TEX", 141: "TOR", 142: "MIN", 143: "PHI", 144: "ATL", 145: "CWS", 146: "MIA",
  147: "NYY", 158: "MIL",
};

// ── Derived === legacy ───────────────────────────────────────────────────────────

test("TEAM_NORM matches pre-registry literals (all sports)", () => {
  assert.deepEqual(TEAM_NORM, LEGACY_TEAM_NORM);
});

test("_VALID_TEAMS matches pre-registry literals (all sports)", () => {
  for (const [sport, abbrs] of Object.entries(LEGACY_VALID_TEAMS)) {
    assert.deepEqual([..._VALID_TEAMS[sport]].sort(), [...abbrs].sort(), sport);
    assert.equal(_VALID_TEAMS[sport].size, abbrs.length, `${sport} size`);
  }
});

test("CANONICAL_TO_ESPN (scoreboard) matches pre-registry literals", () => {
  for (const sport of Object.keys(LEGACY_CANONICAL_TO_ESPN)) {
    assert.deepEqual(CANONICAL_TO_ESPN[sport], LEGACY_CANONICAL_TO_ESPN[sport], sport);
  }
  assert.deepEqual(CANONICAL_TO_ESPN.nfl, {}, "nfl has no scoreboard mismatches");
});

test("WNBA maps match pre-registry literals", () => {
  assert.deepEqual(WNBA_TEAM_IDS, LEGACY_WNBA_TEAM_IDS);
  assert.deepEqual(WNBA_ESPN_TO_CANON, LEGACY_WNBA_ESPN_TO_CANON);
  assert.deepEqual(WNBA_CANON_TO_ESPN, LEGACY_WNBA_CANON_TO_ESPN);
});

test("NHL_ABBR_MAP matches pre-registry literal", () => {
  assert.deepEqual(NHL_ABBR_MAP, LEGACY_NHL_ABBR_MAP);
});

test("MLB_ID_TO_ABBR matches pre-registry literal", () => {
  assert.deepEqual(MLB_ID_TO_ABBR, LEGACY_MLB_ID_TO_ABBR);
});

// LMB (KXLMBGAME, adopted 2026-07-15): statsapi sportId 23 / leagueId 125 team ids,
// verified against the live teams endpoint + Kalshi yes_sub_title names at adoption.
test("LMB_ID_TO_ABBR pins the statsapi id → Kalshi abbr mapping", () => {
  assert.deepEqual(LMB_ID_TO_ABBR, {
    560: "ADM", 5567: "AGU", 447: "ALG", 434: "BLE", 4444: "CAL",
    6304: "CDJ", 6303: "CON", 532: "DIA", 575: "DOR", 579: "GUE",
    496: "LDY", 442: "ODT", 523: "PDC", 520: "PDP", 528: "RDA",
    562: "SDM", 502: "SDS", 569: "TDQ", 5010: "TDT", 536: "TEL",
  });
});

// ── Registry invariants ──────────────────────────────────────────────────────────

test("registry: no duplicate canonical abbrs within a sport", () => {
  for (const [sport, teams] of Object.entries(TEAMS)) {
    const abbrs = teams.map(t => t.abbr);
    assert.equal(new Set(abbrs).size, abbrs.length, sport);
  }
});

test("registry: kalshi aliases never collide across teams within a sport", () => {
  for (const [sport, teams] of Object.entries(TEAMS)) {
    const seen = new Map();
    for (const t of teams) {
      for (const a of t.kalshi || []) {
        assert.ok(!seen.has(a) || seen.get(a) === t.abbr, `${sport}: alias ${a} claimed by ${seen.get(a)} and ${t.abbr}`);
        seen.set(a, t.abbr);
      }
    }
  }
});

test("registry: numeric ids unique per sport", () => {
  for (const [sport, key] of [["nhl", "nhlId"], ["mlb", "mlbId"], ["wnba", "espnId"], ["lmb", "mlbId"]]) {
    const ids = TEAMS[sport].map(t => t[key]).filter(v => v != null);
    assert.equal(new Set(ids).size, ids.length, sport);
    assert.equal(ids.length, TEAMS[sport].length, `${sport}: every team has a ${key}`);
  }
});
