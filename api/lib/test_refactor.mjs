// Test suite for the api/lib/* module split.
// Run with: node api/lib/test_refactor.mjs

import {
  PARK_KFACTOR, PARK_HITFACTOR, PARK_HRFACTOR,
  log5K, poissonCDF, log5HitRate,
  simulateKsDist, kDistPct, simulateKs,
  buildNbaStatDist, nbaDistPct,
  simulateHits, decimalOdds, kellyFraction, evPerUnit
} from "./simulate.js";

import { MLB_ID_TO_ABBR } from "./mlb.js";

import {
  ALLOWED_ORIGIN, corsHeaders, jsonResponse, errorResponse,
  SOFT_TEAM_METRIC, parseGameOdds,
  buildSoftTeamAbbrs, buildHardTeamAbbrs, buildTeamRankMap
} from "./utils.js";

let passed = 0, failed = 0;

function assert(description, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}${detail ? ": " + detail : ""}`);
    failed++;
  }
}

function approx(a, b, tol = 0.5) {
  return Math.abs(a - b) <= tol;
}

// ──────────────────────────────────────────────────────────────
// simulate.js
// ──────────────────────────────────────────────────────────────
console.log("\n=== simulate.js ===");

// Park factors exist and have correct shape
assert("PARK_KFACTOR has COL at 0.98", PARK_KFACTOR["COL"] === 0.98);
assert("PARK_HITFACTOR has COL at 1.14", PARK_HITFACTOR["COL"] === 1.14);
assert("PARK_HRFACTOR has COL at 1.35", PARK_HRFACTOR["COL"] === 1.35);
assert("PARK_KFACTOR has 30 teams", Object.keys(PARK_KFACTOR).length === 30);

// log5K: p=0.25, b=0.25, l=0.222 → should be > 0.25 (higher than base rate)
const l5 = log5K(25, 25, 22.2);
assert("log5K returns number between 0 and 1", l5 > 0 && l5 < 1, `got ${l5}`);
assert("log5K(25,25) > 0.25 (both above league avg)", l5 > 0.25, `got ${l5}`);

// log5K(22.2, 22.2) should return ≈ 0.222
const l5_baseline = log5K(22.2, 22.2, 22.2);
assert("log5K at league avg returns ≈ league avg", approx(l5_baseline * 100, 22.2, 0.1), `got ${(l5_baseline * 100).toFixed(2)}`);

// poissonCDF
const p0 = poissonCDF(0, 0.5); // P(k<=0 | lambda=0.5) = e^-0.5 ≈ 0.607
assert("poissonCDF(0, 0.5) ≈ 0.607", approx(p0, 0.607, 0.01), `got ${p0.toFixed(4)}`);
assert("poissonCDF(100, 0.5) ≈ 1.0", approx(poissonCDF(100, 0.5), 1.0, 0.001));

// log5HitRate
const hr = log5HitRate(25, 1);
assert("log5HitRate(25%, threshold=1) returns 0-100", hr > 0 && hr < 100, `got ${hr}`);

// simulateKsDist monotonicity
const orderedKPcts = [0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22]; // 9-batter lineup
const dist = simulateKsDist(orderedKPcts, 25, 1.0, 5000);
assert("simulateKsDist returns Int16Array of length 5000", dist instanceof Int16Array && dist.length === 5000);

const pct4 = kDistPct(dist, 4);
const pct5 = kDistPct(dist, 5);
const pct6 = kDistPct(dist, 6);
assert("kDistPct: P(K≥4) ≥ P(K≥5) ≥ P(K≥6) (monotonicity)", pct4 >= pct5 && pct5 >= pct6, `${pct4} / ${pct5} / ${pct6}`);
assert("kDistPct returns a number", typeof pct4 === "number");
assert("kDistPct(null) returns null", kDistPct(null, 4) === null);

// simulateKsDist with null pitcherKPct
const nullDist = simulateKsDist([0.22, 0.22], null);
assert("simulateKsDist returns null when pitcherKPct is null", nullDist === null);

// buildNbaStatDist monotonicity
const gameVals = [25, 18, 22, 30, 15, 28, 20, 19, 24, 26, 17, 21, 23, 27, 16];
const nbaDist = buildNbaStatDist(gameVals, 1.05, 2, false, 5000);
assert("buildNbaStatDist returns Float32Array of length 5000", nbaDist instanceof Float32Array && nbaDist.length === 5000);

const nba3 = nbaDistPct(nbaDist, 3);
const nba15 = nbaDistPct(nbaDist, 15);
const nba25 = nbaDistPct(nbaDist, 25);
assert("nbaDistPct: P(≥3) ≥ P(≥15) ≥ P(≥25) (monotonicity)", nba3 >= nba15 && nba15 >= nba25, `${nba3} / ${nba15} / ${nba25}`);
assert("nbaDistPct returns null for null dist", nbaDistPct(null, 15) === null);

// buildNbaStatDist too few games
const tinyVals = [10, 12, 9, 8]; // only 4
assert("buildNbaStatDist returns null with <5 game values", buildNbaStatDist(tinyVals, 1, 0, false) === null);

// B2B reduces mean (run 3 times for statistical stability)
let b2bWins = 0;
for (let i = 0; i < 5; i++) {
  const dNorm = buildNbaStatDist(gameVals, 1, 0, false, 10000);
  const dB2B  = buildNbaStatDist(gameVals, 1, 0, true,  10000);
  const normMean = Array.from(dNorm).reduce((a,b)=>a+b,0) / dNorm.length;
  const b2bMean  = Array.from(dB2B).reduce((a,b)=>a+b,0) / dB2B.length;
  if (b2bMean < normMean) b2bWins++;
}
assert("buildNbaStatDist B2B flag reduces mean (4+ of 5 trials)", b2bWins >= 4, `${b2bWins}/5`);

// simulateHits
const hitPct = simulateHits(0.300, 0.275, 1.0, 1, 10000);
assert("simulateHits: P(hits≥1) returns 0-100", hitPct > 0 && hitPct < 100, `got ${hitPct}`);
const hitPct2 = simulateHits(0.300, 0.275, 1.0, 2, 10000);
assert("simulateHits: P(hits≥1) ≥ P(hits≥2) (monotonicity)", hitPct >= hitPct2, `${hitPct} vs ${hitPct2}`);

// decimalOdds
assert("decimalOdds(+100) = 2.0", decimalOdds(100) === 2.0);
assert("decimalOdds(-110) ≈ 1.909", approx(decimalOdds(-110), 1.909, 0.001));
assert("decimalOdds(+200) = 3.0", decimalOdds(200) === 3.0);

// kellyFraction
const kelly = kellyFraction(60, -110); // truePct=60%, odds=-110
assert("kellyFraction(60%, -110) returns positive", kelly > 0, `got ${kelly}`);
assert("kellyFraction(40%, -110) = 0 (no edge)", kellyFraction(40, -110) === 0);

// evPerUnit
const ev = evPerUnit(60, -110);
assert("evPerUnit(60%, -110) returns positive", ev > 0, `got ${ev}`);
assert("evPerUnit(40%, -110) returns negative", evPerUnit(40, -110) < 0);

// ──────────────────────────────────────────────────────────────
// mlb.js
// ──────────────────────────────────────────────────────────────
console.log("\n=== mlb.js ===");

assert("MLB_ID_TO_ABBR[147] = NYY", MLB_ID_TO_ABBR[147] === "NYY");
assert("MLB_ID_TO_ABBR[108] = LAA", MLB_ID_TO_ABBR[108] === "LAA");
assert("MLB_ID_TO_ABBR has 30 entries", Object.keys(MLB_ID_TO_ABBR).length === 30);
assert("MLB_ID_TO_ABBR[133] = ATH", MLB_ID_TO_ABBR[133] === "ATH");

// ──────────────────────────────────────────────────────────────
// utils.js
// ──────────────────────────────────────────────────────────────
console.log("\n=== utils.js ===");

assert("ALLOWED_ORIGIN = '*'", ALLOWED_ORIGIN === "*");

const hdrs = corsHeaders();
assert("corsHeaders returns ACAO header", hdrs["Access-Control-Allow-Origin"] === "*");
assert("corsHeaders returns ACAM header", typeof hdrs["Access-Control-Allow-Methods"] === "string");

// jsonResponse
const jRes = jsonResponse({ ok: true });
assert("jsonResponse is a Response", jRes instanceof Response);
assert("jsonResponse Content-Type is application/json", jRes.headers.get("Content-Type") === "application/json");

const jResCached = jsonResponse({ ok: true }, 3600);
assert("jsonResponse with TTL sets Cache-Control", jResCached.headers.get("Cache-Control") === "public, max-age=3600");

const jResNoStore = jsonResponse({ ok: true }, true);
assert("jsonResponse(true) sets no-store", jResNoStore.headers.get("Cache-Control") === "no-store");

// errorResponse
const eRes = errorResponse("bad request", 400);
assert("errorResponse is a Response with status 400", eRes.status === 400);

// SOFT_TEAM_METRIC shape
assert("SOFT_TEAM_METRIC.points has hint/idx/label/unit",
  SOFT_TEAM_METRIC.points.hint && SOFT_TEAM_METRIC.points.idx === 0 &&
  SOFT_TEAM_METRIC.points.label && SOFT_TEAM_METRIC.points.unit);
assert("SOFT_TEAM_METRIC has 4 stats", Object.keys(SOFT_TEAM_METRIC).length === 4);

// parseGameOdds: empty input
assert("parseGameOdds([]) returns empty object", Object.keys(parseGameOdds([])).length === 0);
assert("parseGameOdds(null) returns empty object", Object.keys(parseGameOdds(null)).length === 0);

// parseGameOdds with mock data
const mockEvents = [{
  competitions: [{
    odds: [{ overUnder: 225.5, homeTeamOdds: { moneyLine: -150 }, awayTeamOdds: { moneyLine: 130 } }],
    competitors: [
      { homeAway: "home", team: { abbreviation: "GSW" } },
      { homeAway: "away", team: { abbreviation: "LAL" } }
    ]
  }]
}];
const odds = parseGameOdds(mockEvents);
assert("parseGameOdds extracts total", odds["GSW"]?.total === 225.5, `got ${odds["GSW"]?.total}`);
assert("parseGameOdds extracts home moneyline", odds["GSW"]?.moneyline === -150, `got ${odds["GSW"]?.moneyline}`);
assert("parseGameOdds extracts away moneyline", odds["LAL"]?.moneyline === 130, `got ${odds["LAL"]?.moneyline}`);

// buildSoftTeamAbbrs with mock byteam data
const mockTeams = [
  { team: { abbreviation: "ATL" }, categories: [{ displayName: "Opponent Offensive Statistics", values: [120, 50, 30] }] },
  { team: { abbreviation: "DET" }, categories: [{ displayName: "Opponent Offensive Statistics", values: [105, 45, 25] }] },
  { team: { abbreviation: "BOS" }, categories: [{ displayName: "Opponent Offensive Statistics", values: [100, 40, 20] }] },
];
const soft = buildSoftTeamAbbrs(mockTeams, "points", 2);
assert("buildSoftTeamAbbrs returns top 2 teams", soft.length === 2, `got ${soft.length}`);
assert("buildSoftTeamAbbrs first entry is ATL (highest)", soft[0] === "ATL", `got ${soft[0]}`);

const hard = buildHardTeamAbbrs(mockTeams, "points");
assert("buildHardTeamAbbrs excludes ATL (above league avg)", !hard.includes("ATL"), `got ${hard.join(",")}`);
assert("buildHardTeamAbbrs includes BOS (below 95% league avg)", hard.includes("BOS"), `got ${hard.join(",")}`);

const rankMap = buildTeamRankMap(mockTeams, "points");
assert("buildTeamRankMap ATL rank=1", rankMap["ATL"]?.rank === 1, `got ${rankMap["ATL"]?.rank}`);
assert("buildTeamRankMap BOS rank=3", rankMap["BOS"]?.rank === 3, `got ${rankMap["BOS"]?.rank}`);
assert("buildTeamRankMap includes label and unit", rankMap["ATL"]?.label === "PPG allowed" && rankMap["ATL"]?.unit === "PPG");

// buildSoftTeamAbbrs with unknown stat falls back gracefully
const unknownSoft = buildSoftTeamAbbrs(mockTeams, "nonexistent_stat");
assert("buildSoftTeamAbbrs returns [] for unknown stat gracefully (no crash)", Array.isArray(unknownSoft));

// ──────────────────────────────────────────────────────────────
// Cross-module: simulate uses no external deps
// ──────────────────────────────────────────────────────────────
console.log("\n=== cross-module integration ===");

// Verify the entire simulation pipeline works end-to-end
const fullDist = simulateKsDist(
  [0.24, 0.26, 0.20, 0.22, 0.28, 0.18, 0.25, 0.23],
  28.5,   // pitcherKPct
  PARK_KFACTOR["NYY"] || 1.0, // park factor
  5000
);
assert("Full sim pipeline (simulateKsDist + PARK_KFACTOR) runs without error", fullDist instanceof Int16Array);

const p4 = kDistPct(fullDist, 4);
const p5 = kDistPct(fullDist, 5);
assert("Full pipeline: P(K≥4) ≥ P(K≥5)", p4 >= p5, `${p4} vs ${p5}`);

// ──────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed`);
}
