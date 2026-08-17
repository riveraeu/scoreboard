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
import { mlsCanonTeam } from "./mls.js";

// ── Fixtures: exact pre-registry literals ────────────────────────────────────────

const LEGACY_TEAM_NORM = {
  nba: { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX", WPH: "PHX", KAT: "ATL" },
  wnba: { CONNECTICU: "CONN", CON: "CONN", DALLAS: "DAL", WAS: "WSH", GSV: "GS", LAS: "LA", PDX: "POR" },
  nhl: { NJ: "NJD", TB: "TBL", LA: "LAK", SJ: "SJS", VGK: "VGK" },
  mlb: { KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", CHW: "CWS", AZ: "ARI", KC: "KC", SD: "SD", SF: "SF", TB: "TB", OAK: "ATH", WSN: "WSH", WAS: "WSH" },
  // JAC/WAS added 2026-08-10 with the KXNFLGAME build — Kalshi's spellings for Jacksonville and
  // Washington, whose canonical/ESPN forms are JAX/WSH. Four live 2026 events failed to parse
  // without them.
  nfl: { LA: "LAR", JAC: "JAX", WAS: "WSH" },
  lmb: {}, // canonical = Kalshi abbrs, no aliases
  mls: {}, // canonical = Kalshi abbrs, no aliases (like lmb)
  brasileirao: {}, // canonical = Kalshi abbrs, no aliases (like mls/lmb)
  nwsl: {}, // canonical = Kalshi abbrs, no aliases (like mls/lmb/brasileirao)
  chnsl: {}, // canonical = Kalshi abbrs, no aliases (like mls/lmb/brasileirao/nwsl)
  ligamx: {}, // canonical = Kalshi abbrs, no aliases (like mls/lmb/brasileirao/nwsl/chnsl)
  scocup: {}, // canonical = ESPN abbrs (not Kalshi's — see teams.js scocup comment for the
  // "DUN" collision); team identity resolved from subtitle text, not TEAM_NORM/parseGameTeams.
  argprem: {}, // canonical = Kalshi abbrs, no aliases (like mls/lmb/brasileirao/nwsl/chnsl/
  // ligamx) — RIV/IRM resolved via displayName in argprem.js's canonTeam, not TEAM_NORM.
  dimayor: {}, // canonical = Kalshi abbrs, no aliases — the CAL→DCI "Cali" collision is an
  // ESPN-side mapping (espnScore), so it lives in CANONICAL_TO_ESPN, not TEAM_NORM.
  copadobrasil: {}, // canonical = Kalshi abbrs, no aliases (like brasileirao); the 4 espnScore
  // aliases live in CANONICAL_TO_ESPN, not TEAM_NORM.
  kleague: {},    // canonical = Kalshi abbrs, no aliases; settlement-authoritative, no ESPN slug.
  kbo: {},        // canonical = Kalshi abbrs, no aliases; settlement-authoritative, no ESPN slug.
  eredivisie: {}, // canonical = Kalshi abbrs, no aliases; espnScore remaps live in CANONICAL_TO_ESPN.
  epl: {},        // canonical = Kalshi abbrs, no aliases; espnScore remaps live in CANONICAL_TO_ESPN.
  laliga: {},     // canonical = Kalshi abbrs, no aliases; espnScore remaps live in CANONICAL_TO_ESPN.
  seriea: {},     // canonical = Kalshi abbrs, no aliases; espnScore remaps live in CANONICAL_TO_ESPN.
  ligue1: {},     // canonical = Kalshi abbrs, no aliases (OL/OM are 2-char canonical abbrs).
  jleague: {},    // canonical = Kalshi abbrs, no aliases; espnScore remaps live in CANONICAL_TO_ESPN.
  laliga2: {},    // canonical = Kalshi abbrs, no aliases; espnScore remaps live in CANONICAL_TO_ESPN.
  usl: {},        // canonical = Kalshi abbrs, no aliases; espnScore remaps live in CANONICAL_TO_ESPN.
  copalib: {},    // canonical = Kalshi abbrs, no aliases; espnScore remaps live in CANONICAL_TO_ESPN.
  ligaportugal: {}, // canonical = Kalshi abbrs, no aliases; the 14 espnScore remaps (incl. the
  // EST=Estoril / ESA=Estrela collision) live in CANONICAL_TO_ESPN, not TEAM_NORM.
  leaguescup: {}, // DERIVED registry (mls ∪ ligamx) — inherits no aliases because neither parent
  // has any; its espnScore remaps come from ligamx via CANONICAL_TO_ESPN.
  eerstediv: {}, // canonical = Kalshi abbrs, no aliases; the 10 espnScore remaps (incl. the four
  // "Jong" reserve-team abbrs) live in CANONICAL_TO_ESPN, not TEAM_NORM.
  bolpd: {}, // canonical = Kalshi abbrs, no aliases; the 4 espnScore remaps (incl. the two-sided
  // "POT" collision) live in CANONICAL_TO_ESPN, not TEAM_NORM.
  belgianpl: {}, // canonical = Kalshi abbrs (from event sub_title, e.g. "BRU vs CER"), no
  // aliases; the 13 espnScore remaps live in CANONICAL_TO_ESPN, not TEAM_NORM.
};

const LEGACY_VALID_TEAMS = {
  nba: ["ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"],
  wnba: ["ATL","CHI","CONN","DAL","GS","IND","LV","LA","MIN","NY","PHX","POR","SEA","TOR","WSH"],
  nhl: ["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","STL","SJS","SEA","TBL","TOR","UTA","VAN","VGK","WSH","WPG"],
  mlb: ["ARI","ATL","ATH","BAL","BOS","CHC","CIN","CLE","COL","CWS","DET","HOU","KC","LAA","LAD","MIA","MIL","MIN","NYM","NYY","PHI","PIT","SD","SEA","SF","STL","TB","TEX","TOR","WSH"],
  nfl: ["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SEA","SF","TB","TEN","WSH"],
  lmb: ["ADM","AGU","ALG","BLE","CAL","CDJ","CON","DIA","DOR","GUE","LDY","ODT","PDC","PDP","RDA","SDM","SDS","TDQ","TDT","TEL"],
  mls: ["ATL","ATX","CHI","CIN","CLB","CLT","COL","DAL","DCU","HOU","LAFC","LAG","MIA","MIN","MTL","NE","NSH","NYC","NYRB","ORL","PHI","POR","RSL","SD","SEA","SJ","SKC","STL","TOR","VAN"],
  brasileirao: ["BAH","BOT","RBB","CAP","ATL","CFC","CHA","COR","CRU","FLA","FLU","GPA","INT","MIR","PAL","CR","SAN","SPA","VDG","VIT"],
  copadobrasil: ["CAP","ATL","CHA","COR","CRU","FLU","FOR","GPA","INT","JUV","MIR","PAL","CR","SAN","VDG","VIT"],
  kleague:    ["ANY","BUC","DAJ","GAW","GIS","GWA","INC","JEJ","JEO","POH","SEO","ULS"],
  kbo:        ["DOO","HAN","KIA","KIW","KTW","LG","LOT","NCD","SAM","SSG"],
  eredivisie: ["AJA","FEY","PSV","AZA","TWE","SPA","GRO","HEE","FCU","ZWO","ADO","FOR","TEL","NIJ","GAE","WIL","EXC","CAM"],
  nwsl: ["WSP","DEN","SAN","REI","URO","NCC","KC","BOS","PTH","GOT","OPR","CHI","HDA","BAY"],
  chnsl: ["ZHP","DAL","CHR","BJG","SHT","HEN","YUN","SHE","WUH","CHO","LIT","QIN","QWC","SHP","SHS","TTT"],
  ligamx: ["ALA","AME","ASL","ATL","CDG","CRA","JUA","LEO","MON","NCX","PAC","PUE","PUM","QUE","SLA","TIG","TIJ","TOL"],
  argprem: ["ARG","BAN","BAR","BOC","CAA","CAB","CAI","CARC","CAS","CAT","CC","DYJ","ELP","GEM","GLP","HUR","IACC","IRM","LAN","NOB","PLA","RAC","RCU","RIE","RIV","SLA","TIG","TUC","UNI","VEL"],
  epl: ["ARS","AVL","BOU","BRE","BRI","CFC","COV","CRY","EVE","FUL","HUL","IPS","LEE","LFC","MCI","MUN","NEW","NFO","SUN","TOT"],
  laliga: ["ALA","ATH","ATM","BAR","DEP","ELC","ESP","GET","LEV","MCF","OSA","RBB","RCC","RMA","RSO","RVC","SAN","SEV","VCF","VIL"],
  seriea: ["ACM","ATA","BFC","CAG","COM","FIO","FRO","GEN","INT","JUV","LAZ","LEC","MON","NAP","PAR","ROM","SAS","TOR","UDI","VEN"],
  ligue1: ["ANG","ASM","AUX","EST","FCL","HAC","LIL","MAN","NIC","OL","OM","PAR","PSG","RCL","RCS","REN","STB","TFC"],
  jleague: ["AVI","CER","FAG","GAM","JEF","KAS","KAW","KYO","MAC","MAR","MIT","NGE","REY","SAN","SHI","TOK","URD","VER","VIK","VVN"],
  laliga2: ["ALB","ALM","AND","BUR","CAD","CAS","CDE","CEU","COR","EIB","GCF","GIJ","GIR","LEG","LPA","MAL","OVI","RCC","RSO","SAB","TEN","VLL"],
  usl: ["BIR","BRO","CHS","CSS","DET","HFD","IND","JAX","LAS","LEX","LFC","LOU","MIA","MON","NEW","OAK","OC","PAS","PIT","RHI","SAN","SRP","TBR","TUL"],
  copalib: ["CARC","COQ","COR","CPO","CRU","ELP","FLA","FLU","IND","LDU","MIR","PAL","PLA","RIV","TOL","UC"],
  ligaportugal: ["ACV","ALV","ARO","BEN","BRA","CAS","CDN","CSM","ESA","EST","FAM","FCP","GIL","MOR","RAV","SCL","SPO","VIT"],
  eerstediv: ["ALM","PSV","EIN","MAA","HER","DBO","BRE","VEN","WAA","DOR","ROD","HEL","VOL","OSS","GRA","AZ","AJA","EMM","UTR","VIT"],
  bolpd: ["IND","CLU","CNP","ABB","ARE","POT"],
  belgianpl: ["BRU","CER","LOM","WES","RAFC","GEN","KAA","OHL","RCH","YRM","ZUL","BEV","STA","RAAL","STT","KOR","USG","RSC"],
};

const LEGACY_CANONICAL_TO_ESPN = {
  mlb: { CWS: "CHW" },
  nba: { GSW: "GS", SAS: "SA", NYK: "NY", NOP: "NO", UTA: "UTAH", WAS: "WSH" },
  wnba: { CONN: "CON" },
  nhl: { TBL: "TB", NJD: "NJ", LAK: "LA", SJS: "SJ" },
  mls: { DCU: "DC", LAG: "LA", NYRB: "RBNY" },
  brasileirao: { RBB: "BRA", ATL: "CAM", GPA: "GRE", CR: "REMO", SPA: "SAO", VDG: "VAS" },
  copadobrasil: { ATL: "CAM", GPA: "GRE", CR: "REMO", VDG: "VAS" },
  nwsl: { WSP: "WAS", SAN: "SD", REI: "SEA", URO: "UTA", NCC: "NC", PTH: "POR", GOT: "GFC", OPR: "ORL", HDA: "HOU" },
  chnsl: { ZHP: "ZHE", DAL: "DYI", CHR: "CHE", BJG: "BG", SHE: "SHX", WUH: "WTT", LIT: "LIA", SHP: "SIPG", SHS: "SHE", TTT: "TIG" },
  ligamx: { ALA: "ATL", ATL: "ATS", CDG: "GDL", CRA: "CAZ", MON: "MTY", PUM: "UNAM", QUE: "QRO", SLA: "SAN", TIG: "UANL" },
  argprem: { ARG: "ARGJ", BOC: "CABJ", CAA: "ALDO", CAB: "BEL", CAI: "IND", CARC: "ROS", CAS: "SARM", CAT: "TALL", CC: "CTR", ELP: "EST", GEM: "GMZ", RCU: "AAE", SLA: "SLO", TUC: "CAT", UNI: "USF" },
  eredivisie: { AZA: "AZ", FCU: "UTR", ZWO: "PEC", NIJ: "NEC" },
  epl:     { BRI: "BHA", CFC: "CHE", LFC: "LIV", MCI: "MNC", MUN: "MAN" },
  laliga:  { RBB: "BET", RCC: "CEL", RVC: "RAY", SAN: "RAC", VCF: "VAL" },
  seriea:  { ACM: "MIL", BFC: "BOL", COM: "COMO", ROM: "ROMA" },
  ligue1:  { ASM: "MON", EST: "TRY", FCL: "LOR", LIL: "LILL", MAN: "MNS", NIC: "NICE", OL: "LYON", OM: "OLM", RCS: "STR", STB: "BRE", TFC: "TOU" },
  jleague: { AVI: "AVF", FAG: "OKA", KAS: "KAN", MAC: "ZEL", MAR: "YOK", MIT: "MITO", NGE: "NAG", REY: "KRE", URD: "URA", VER: "TYKV", VIK: "VIS" },
  laliga2: { CDE: "ELD", RCC: "CEL", GIJ: "RSG", GCF: "GRA", MAL: "MLL", RSO: "RSO2", SAB: "CDS" },
  usl:     { BIR: "BRM", BRO: "BFKC", CSS: "COS", IND: "INDY", LAS: "LVL", LFC: "LOU", MON: "MTB", NEW: "NMU", OC: "OCSC", PAS: "ELP", SAN: "SAFC", SRP: "SAC" },
  copalib: { CARC: "ROS", CPO: "CPT", ELP: "EST", IND: "IDV", UC: "CDUC" },
  ligaportugal: { ARO: "FCA", BEN: "SLB", BRA: "SCB", CAS: "CPAC", CSM: "MAR", ESA: "EST", EST: "EPF", FAM: "FCF", GIL: "GVFC", MOR: "MFC", RAV: "RAFC", SCL: "CDSC", SPO: "SCP", VIT: "VSC" },
  eerstediv: { PSV: "JPS", MAA: "MVV", BRE: "NAC", VEN: "VVV", WAA: "RKC", ROD: "RJC", OSS: "TOP", AZ: "JAZ", AJA: "JAJ", UTR: "JUT" },
  bolpd: { IND: "CIP", CLU: "GVSJ", CNP: "POT", ARE: "CAR", POT: "RPO" },
  belgianpl: { CER: "CBK", WES: "KVCW", RAFC: "ANT", GEN: "GENK", KAA: "GENT", RCH: "CHA", YRM: "KVM", BEV: "WAA", STA: "STL", RAAL: "RLL", STT: "STVV", KOR: "KVK", RSC: "AND" },
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

// MLS (KXMLSGAME, adopted 2026-07-23): canonical = Kalshi abbrs, verified live via
// api.elections.kalshi.com ticker suffixes; espnScore aliases verified live via
// site.api.espn.com/.../soccer/usa.1/scoreboard at adoption.
test("mlsCanonTeam maps ESPN's 3 mismatched abbrs, identity passthrough otherwise", () => {
  assert.equal(mlsCanonTeam("DC"), "DCU");
  assert.equal(mlsCanonTeam("LA"), "LAG");
  assert.equal(mlsCanonTeam("RBNY"), "NYRB");
  assert.equal(mlsCanonTeam("ATL"), "ATL");
  assert.equal(mlsCanonTeam("LAFC"), "LAFC");
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

// The DIMAYOR "Cali" collision, pinned because getting it backwards is SILENT: Kalshi's "CAL" is
// subtitled just "Cali" and is Deportivo Cali (ESPN "DCI"), while ESPN's OWN "CAL" is Once Caldas
// — a different club, from Manizales, not in Cali at all. Verified 2026-07-28 by matching Kalshi
// event ticker KXDIMAYORGAME-26AUG01DIMCAL to ESPN col.1's 2026-08-01 fixture "Deportivo Cali at
// Independiente Medellín" (DIM vs DCI). If CAL ever maps to itself, every Deportivo Cali row
// grades against Once Caldas and nothing throws.
test("eredivisie: ESPN-side abbr mismatches verified live 2026-08-07/08", () => {
  assert.strictEqual(CANONICAL_TO_ESPN.eredivisie.AZA, "AZ");   // AZ Alkmaar — ESPN drops trailing A
  assert.strictEqual(CANONICAL_TO_ESPN.eredivisie.FCU, "UTR");  // FC Utrecht — ESPN uses city abbr
  assert.strictEqual(CANONICAL_TO_ESPN.eredivisie.ZWO, "PEC");  // PEC Zwolle — ESPN uses club name
  assert.strictEqual(CANONICAL_TO_ESPN.eredivisie.NIJ, "NEC");  // NEC Nijmegen — ESPN uses club abbr
  // Identity teams must NOT carry an espnScore entry.
  for (const a of ["AJA", "FEY", "PSV", "TWE", "SPA", "GRO", "HEE", "ADO", "FOR", "TEL", "GAE", "WIL", "EXC", "CAM"]) {
    assert.ok(!(a in CANONICAL_TO_ESPN.eredivisie), `${a} should map to itself, not be remapped`);
  }
});

test("dimayor: Kalshi CAL is Deportivo Cali (ESPN DCI), never ESPN's own CAL (Once Caldas)", () => {
  assert.strictEqual(CANONICAL_TO_ESPN.dimayor.CAL, "DCI");
  assert.notStrictEqual(CANONICAL_TO_ESPN.dimayor.CAL, "CAL");
  // The OTHER side of that collision, added 2026-08-10 when the registry was completed: ESPN's own
  // "CAL" IS Once Caldas, which Kalshi calls "OC". Without this the identity passthrough sends
  // ESPN's Once Caldas fixtures to Kalshi's Deportivo Cali — a silent wrong-team match. The two
  // assertions together pin the collision from both directions.
  assert.strictEqual(CANONICAL_TO_ESPN.dimayor.OC, "CAL");
  // The other verified remaps, same fixture-matching method.
  assert.strictEqual(CANONICAL_TO_ESPN.dimayor.ADR, "AGD");
  assert.strictEqual(CANONICAL_TO_ESPN.dimayor.ALI, "AFC");
  assert.strictEqual(CANONICAL_TO_ESPN.dimayor.CAN, "NAL");
  assert.strictEqual(CANONICAL_TO_ESPN.dimayor.INT, "BOG");
  assert.strictEqual(CANONICAL_TO_ESPN.dimayor.JAG, "COR");
  // Identity teams must NOT carry an espnScore entry (an accidental one would be a silent remap).
  for (const a of ["AME", "BUC", "CHI", "CUC", "DIM", "FOR", "JUN", "LLA", "MIL", "PAS", "PER", "SFE", "TOL"]) {
    assert.ok(!(a in CANONICAL_TO_ESPN.dimayor), `${a} should map to itself, not be remapped`);
  }
  // All 20 clubs registered — an incomplete registry is what let OCALI mis-parse, and it is the
  // precondition for dimayor being in parseGameTeams' validated variable-length allowlist.
  assert.strictEqual(_VALID_TEAMS.dimayor.size, 20);
});

// ── Leagues Cup: the derived cross-league registry (2026-08-11) ──────────────────
//
// `leaguescup` is the first registry in this file that is DERIVED (mls ∪ ligamx) rather than
// written out. Everything below pins the properties that derivation depends on — if any of them
// stops holding, the union silently starts mapping clubs to the wrong ESPN teams.

test("leaguescup: the mls/ligamx overlap is EXACTLY {ATL} — a second collision must fail here", () => {
  const mls = new Set(TEAMS.mls.map(t => t.abbr));
  const overlap = TEAMS.ligamx.map(t => t.abbr).filter(a => mls.has(a)).sort();
  // The union resolves collisions by "ligamx wins", which is only safe while ATL is the sole
  // conflict. A rebrand that creates a second one would otherwise be resolved silently and
  // wrongly, so this assertion is the tripwire for it — not a restatement of the current data.
  assert.deepEqual(overlap, ["ATL"]);
});

test("leaguescup: ATL is Atlas (ESPN ATS), never Atlanta United; ALA is Atlante (ESPN ATL)", () => {
  // Kalshi's own market subtitles are the source: ATL -> "Atlas", ALA -> "Atlante". ESPN's OWN
  // abbr for Atlante in this competition is "ATL" and for Atlas is "ATS", so mls winning the
  // union would identity-map Atlas onto Atlante — a different club, silently. Pinned from both
  // directions, same as the dimayor CAL collision above.
  assert.strictEqual(CANONICAL_TO_ESPN.leaguescup.ATL, "ATS");
  assert.strictEqual(CANONICAL_TO_ESPN.leaguescup.ALA, "ATL");
  assert.notStrictEqual(CANONICAL_TO_ESPN.leaguescup.ATL, "ATL");
});

test("leaguescup: every code in the live tournament resolves, with ligamx's ESPN remaps intact", () => {
  // The 36 distinct codes seen across OPEN and SETTLED KXLEAGUESCUPGAME markets on 2026-08-11
  // (TIE excluded — it is the 3-way draw leg, not a club).
  const LIVE = ["ALA","AME","ASL","ATL","ATX","CDG","CHI","CIN","CLB","CLT","CRA","DAL","JUA",
    "LAFC","LEO","MIA","MIN","MON","NCX","NSH","NYC","ORL","PAC","PHI","POR","PUE","PUM","QUE",
    "RSL","SD","SEA","SLA","TIG","TIJ","TOL","VAN"];
  for (const c of LIVE) assert.ok(_VALID_TEAMS.leaguescup.has(c), `${c} missing from leaguescup`);
  // Liga MX remaps proven by same-date fixture against ESPN concacaf.leagues.cup — ESPN uses the
  // same abbreviations here as on mex.1, which is what makes the union viable at all.
  for (const [k, espn] of [["CRA","CAZ"],["SLA","SAN"],["CDG","GDL"],["QUE","QRO"],["MON","MTY"],
                           ["TIG","UANL"],["PUM","UNAM"]])
    assert.strictEqual(CANONICAL_TO_ESPN.leaguescup[k], espn, `${k} -> ${espn}`);
  // MLS side identity-maps (12/12 confirmed against same-date fixtures); an accidental espnScore
  // on any of these would be a silent remap.
  for (const a of ["ATX","CHI","DAL","LAFC","MIA","NSH","NYC","ORL","PHI","POR","RSL","SD","SEA","VAN"])
    assert.ok(!(a in CANONICAL_TO_ESPN.leaguescup), `${a} should map to itself`);
});

test("leaguescup: mixed-length codes are present, which is why it needs the allowlist path", () => {
  // SD (2-char) and LAFC (4-char) are inherited from mls. Their presence is the precondition for
  // leaguescup being in parseGameTeams' validated variable-length allowlist; if they ever left the
  // registry the allowlist entry would be dead weight rather than load-bearing.
  assert.ok(_VALID_TEAMS.leaguescup.has("SD"));
  assert.ok(_VALID_TEAMS.leaguescup.has("LAFC"));
  assert.strictEqual(_VALID_TEAMS.leaguescup.size, TEAMS.mls.length + TEAMS.ligamx.length - 1);
});

// eerstediv (Dutch 2nd tier), adopted 2026-08-14. Every mapping verified by same-date ESPN
// scoreboard cross-reference over live GAME-market tickers 8/14-8/21, not name similarity — see
// teams.js for the full evidence (VOL/OSS = FC Volendam/TOP Oss on 2026-08-15, matching Kalshi's
// VOLOSS ticker exactly).
test("eerstediv: ESPN-side abbr mismatches verified live 2026-08-14 (Jong-prefix + city/club naming)", () => {
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.PSV, "JPS"); // Jong PSV
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.AZ,  "JAZ"); // Jong AZ Alkmaar
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.AJA, "JAJ"); // Jong Ajax
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.UTR, "JUT"); // Jong FC Utrecht
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.MAA, "MVV"); // MVV Maastricht
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.BRE, "NAC"); // NAC Breda
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.VEN, "VVV"); // VVV-Venlo
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.WAA, "RKC"); // RKC Waalwijk
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.ROD, "RJC"); // Roda JC Kerkrade
  assert.strictEqual(CANONICAL_TO_ESPN.eerstediv.OSS, "TOP"); // TOP Oss
  // Identity teams must NOT carry an espnScore entry.
  for (const a of ["ALM", "EIN", "HER", "DBO", "DOR", "HEL", "VOL", "GRA", "EMM", "VIT"]) {
    assert.ok(!(a in CANONICAL_TO_ESPN.eerstediv), `${a} should map to itself, not be remapped`);
  }
});

test("eerstediv: AZ is a 2-char code mixed with 3-char, which is why it needs the allowlist path", () => {
  assert.ok(_VALID_TEAMS.eerstediv.has("AZ"));
  assert.strictEqual(_VALID_TEAMS.eerstediv.size, 20);
});
