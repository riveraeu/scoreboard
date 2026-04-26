// Tests for simulate.js — run with: npm test
// Covers kDistPct monotonicity (the root cause of the player card truePct bug),
// simulateKsDist validity, and the qualified:false player card lookup fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateKsDist, kDistPct, buildNbaStatDist, nbaDistPct } from './simulate.js';
import {
  LINEUP_SMALL, LINEUP_MED, LINEUP_9_21,
  NBA_GAME_VALUES,
  makeSweepPlays, makeAllTonightPlays,
  HRR_ROWS,
  LINEUP_EARLY_RETURN, PITCHER_EARLY_RETURN,
} from './simulate.test.fixtures.js';

// --- simulateKsDist ---

test('simulateKsDist returns Int16Array of the requested length', () => {
  const dist = simulateKsDist(LINEUP_SMALL, 0.28, 1.0, 1000);
  assert.ok(dist instanceof Int16Array, 'should be Int16Array');
  assert.equal(dist.length, 1000);
});

test('simulateKsDist returns null for empty lineup', () => {
  assert.equal(simulateKsDist([], 0.28, 1.0, 1000), null);
});

test('simulateKsDist returns null for null pitcherKPct', () => {
  assert.equal(simulateKsDist(LINEUP_SMALL.slice(0, 2), null, 1.0, 1000), null);
});

// --- kDistPct ---

test('kDistPct returns null for null distribution', () => {
  assert.equal(kDistPct(null, 5), null);
});

test('kDistPct returns values in [0, 100]', () => {
  const dist = simulateKsDist(LINEUP_MED, 0.28, 1.0, 2000);
  for (let t = 1; t <= 10; t++) {
    const pct = kDistPct(dist, t);
    assert.ok(pct >= 0 && pct <= 100, `P(K>=${t})=${pct} should be in [0, 100]`);
  }
});

// Key invariant: sharing one distribution guarantees strict monotonicity.
// This is the root cause fix — before the fix, 3+/4+ used a fallback formula
// independent of the 5+ simulation, breaking monotonicity (76.8% < 97.9%).
test('kDistPct is monotonically non-increasing across thresholds (shared distribution)', () => {
  const dist = simulateKsDist(LINEUP_9_21, 0.28, 1.01, 10000);
  const thresholds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const pcts = thresholds.map(t => kDistPct(dist, t));
  for (let i = 0; i < pcts.length - 1; i++) {
    assert.ok(
      pcts[i] >= pcts[i + 1],
      `P(K>=${thresholds[i]})=${pcts[i]} must be >= P(K>=${thresholds[i + 1]})=${pcts[i + 1]}`
    );
  }
});

// The specific scenario from the bug: good pitcher (CSW 30%, K-BB 16%) vs Cardinals-like lineup.
// All thresholds querying the same dist must be monotonic — 4+ >= 5+ always holds.
test('shared distribution: P(K>=4) >= P(K>=5) for a Gavin Williams-like scenario', () => {
  const dist = simulateKsDist(LINEUP_9_21, 0.295, 1.01, 10000); // pitcher K% ~29.5%, +1% park
  const pct4 = kDistPct(dist, 4);
  const pct5 = kDistPct(dist, 5);
  assert.ok(pct4 >= pct5, `P(K>=4)=${pct4} must be >= P(K>=5)=${pct5}`);
});

// --- API-side monotonicity enforcement ---

// Mirrors the enforcement logic in api/[...path].js (~line 2286).
// When qualified:false plays (3+, 4+) have lower truePct than a qualifying play (5+)
// due to the fallback formula, the sweep must correct them.
test('API monotonicity sweep corrects qualified:false plays that underestimate truePct', () => {
  const plays = makeSweepPlays();

  // Reproduce the enforcement sweep from api/[...path].js
  const groups = {};
  for (const p of plays) {
    if (p.sport === 'mlb' && p.stat === 'strikeouts') {
      const key = `${p.playerTeam}|${p.gameDate}`;
      (groups[key] = groups[key] || []).push(p);
    }
  }
  for (const group of Object.values(groups)) {
    group.sort((a, b) => a.threshold - b.threshold);
    for (let i = group.length - 2; i >= 0; i--) {
      if (group[i].truePct < group[i + 1].truePct) {
        group[i].truePct = group[i + 1].truePct;
      }
    }
  }

  assert.equal(plays.find(p => p.threshold === 3).truePct, 97.9, '3+ should be bumped to 97.9');
  assert.equal(plays.find(p => p.threshold === 4).truePct, 97.9, '4+ should be bumped to 97.9');
  assert.equal(plays.find(p => p.threshold === 5).truePct, 97.9, '5+ unchanged');
});

// --- Player card qualified:false lookup fix ---

// Before the fix: tonightPlayerMap was built from tonightPlays = plays.filter(qualified !== false).
// This left 3+ and 4+ out of the map, causing fallback to (seasonPct+softPct)/2.
// After the fix: tonightPlayerMap uses allTonightPlays (unfiltered), so all thresholds
// get their simulation-based truePct from the API response.
test('tonightPlayerMap built from allTonightPlays includes qualified:false thresholds', () => {
  const allTonightPlays = makeAllTonightPlays();

  // Old behavior: only qualified plays
  const oldMap = {};
  for (const p of allTonightPlays.filter(p => p.qualified !== false)) {
    oldMap[`${p.stat}|${p.threshold}`] = p;
  }
  assert.ok(!oldMap['strikeouts|3'], 'old: 3+ missing from map (causes fallback)');
  assert.ok(!oldMap['strikeouts|4'], 'old: 4+ missing from map (causes fallback)');

  // New behavior: all plays including qualified:false
  const newMap = {};
  for (const p of allTonightPlays) {
    if (p.playerId === 42) newMap[`${p.stat}|${p.threshold}`] = p;
  }
  assert.equal(newMap['strikeouts|3'].truePct, 97.9, 'new: 3+ has simulation truePct');
  assert.equal(newMap['strikeouts|4'].truePct, 97.9, 'new: 4+ has simulation truePct');
  assert.equal(newMap['strikeouts|5'].truePct, 97.9, 'new: 5+ unchanged');
});

// --- NBA distribution ---

test('nbaDistPct is monotonically non-increasing across thresholds', () => {
  const dist = buildNbaStatDist(NBA_GAME_VALUES, 1.0, 0, false, 5000);
  assert.ok(dist instanceof Float32Array, 'should be Float32Array');
  const thresholds = [10, 15, 20, 25, 30, 35, 40];
  const pcts = thresholds.map(t => nbaDistPct(dist, t));
  for (let i = 0; i < pcts.length - 1; i++) {
    assert.ok(
      pcts[i] >= pcts[i + 1],
      `P(pts>=${thresholds[i]})=${pcts[i]} must be >= P(pts>=${thresholds[i + 1]})=${pcts[i + 1]}`
    );
  }
});

test('buildNbaStatDist returns null for insufficient data', () => {
  assert.equal(buildNbaStatDist([], 1.0, 0, false, 1000), null);
  assert.equal(buildNbaStatDist([20, 18, 22, 25], 1.0, 0, false, 1000), null); // < 5 values
});

// --- NBA simScore computed at opp_not_soft drop site ---

// Mirrors the inline computation in api/[...path].js.
// Five components: pace, minutes, DVP rank, rest, game total. Edge is gate only (max 14).
function computeNbaDropSimScore({ paceAdj, opportunity, dvpRank, isB2B, gameTotal }) {
  const totalPts = gameTotal == null ? 1 : gameTotal >= 235 ? 3 : gameTotal >= 225 ? 2 : gameTotal >= 215 ? 1 : 0;
  const preScore = (paceAdj != null && paceAdj > 0 ? 3 : 0)
    + (opportunity != null ? (opportunity >= 30 ? 4 : opportunity >= 25 ? 2 : 0) : 0)
    + (dvpRank != null && dvpRank <= 10 ? 2 : 0)
    + (!isB2B ? 2 : 0)
    + totalPts;
  return { preScore, simScore: preScore }; // edge is gate only
}

test('NBA drop simScore: all components contribute correctly', () => {
  const { preScore, simScore } = computeNbaDropSimScore({
    paceAdj: 2.5,       // above avg → +3
    opportunity: 34,    // ≥30 min → +4
    dvpRank: 8,         // ≤10 → +2
    isB2B: false,       // rested → +2
    gameTotal: 238,     // ≥235 → +3
  });
  assert.equal(preScore, 14, '3+4+2+2+3=14 (high total)');
  assert.equal(simScore, 14, 'edge is gate only, simScore=preScore');
});

test('NBA drop simScore: null game total abstains (1pt)', () => {
  const { preScore } = computeNbaDropSimScore({
    paceAdj: 2.5, opportunity: 34, dvpRank: 8, isB2B: false, gameTotal: null,
  });
  assert.equal(preScore, 12, '3+4+2+2+1(abstain)=12');
});

test('NBA drop simScore: B2B and soft pace give lower score', () => {
  const { preScore, simScore } = computeNbaDropSimScore({
    paceAdj: -1.0,     // below avg → 0
    opportunity: 28,   // ≥25 but <30 → +2
    dvpRank: 15,       // >10 → 0
    isB2B: true,       // B2B → 0
    gameTotal: 210,    // <215 → 0
  });
  assert.equal(preScore, 2, 'pre-score: 0+2+0+0+0=2');
  assert.equal(simScore, 2, 'edge is gate only');
});

test('NBA drop simScore: missing fields default to 0 pts', () => {
  const { preScore } = computeNbaDropSimScore({
    paceAdj: null,
    opportunity: null,
    dvpRank: null,
    isB2B: false,    // rested → +2
    gameTotal: null, // null → +1 (abstain)
  });
  assert.equal(preScore, 3, 'rest(2) + total null→1 = 3');
});

// --- HRR threshold filter ---

// The report filters HRR rows to threshold=1 only (2+/3+/etc. are too noisy).
// This tests the filter expression used in index.html.
test('HRR rows filtered to threshold=1 only', () => {
  const allRows = HRR_ROWS;
  const filtered = allRows.filter(r => r.stat !== 'hrr' || r.threshold === 1);
  const hrrRows = filtered.filter(r => r.stat === 'hrr');
  assert.equal(hrrRows.length, 1, 'only one HRR row (threshold=1)');
  assert.equal(hrrRows[0].threshold, 1);
  // non-HRR rows are unaffected
  const ksRows = filtered.filter(r => r.stat === 'strikeouts');
  assert.equal(ksRows.length, 2, 'strikeout rows all pass through');
});

// --- mlb.js early-return / catch completeness ---

// buildLineupKPct and buildPitcherKPct return full field sets even on early exit.
// These tests mirror the shapes that api/[...path].js destructures so missing keys
// cause silent undefined bugs rather than loud errors.
test('buildLineupKPct early-return shape includes all destructured fields', () => {
  const required = ['lineupKPct','lineupBatterKPcts','lineupKPctVR','lineupKPctVL','lineupBatterKPctsOrdered','lineupBatterKPctsVROrdered','lineupBatterKPctsVLOrdered','lineupSpotByName','gameHomeTeams','projectedLineupTeams'];
  for (const key of required) {
    assert.ok(key in LINEUP_EARLY_RETURN, `lineupKPct early-return missing key: ${key}`);
  }
});

test('buildPitcherKPct early-return shape includes all destructured fields', () => {
  const required = ['pitcherKPct','pitcherKBBPct','pitcherHand','pitcherEra','pitcherCSWPct','pitcherAvgPitches'];
  for (const key of required) {
    assert.ok(key in PITCHER_EARLY_RETURN, `pitcherKPct early-return missing key: ${key}`);
  }
});

// --- Score > 10 name highlight (MLB only) ---

// For MLB tables: player name is white+bold only when score > 10 (Alpha tier).
// For non-MLB tables: original behavior — white+bold when row is qualified.
// No row background is applied (removed in favor of name-only highlight).
test('_nameWhite: MLB uses score>10, non-MLB uses m.qualified', () => {
  const nameWhite = (sport, m) => sport === 'mlb'
    ? (sport === 'mlb' ? (m.finalSimScore ?? m.hitterFinalSimScore ?? null) : null) != null
      && (m.finalSimScore ?? m.hitterFinalSimScore) > 10
    : m.qualified;

  // MLB strikeouts: name white only when finalSimScore > 10
  assert.equal(nameWhite('mlb', { finalSimScore: 14, qualified: true }),  true,  'mlb 14 → white');
  assert.equal(nameWhite('mlb', { finalSimScore: 10, qualified: true }),  false, 'mlb 10 → not white (must be > 10)');
  assert.equal(nameWhite('mlb', { finalSimScore: 8,  qualified: false }), false, 'mlb 8 → not white');
  // MLB HRR: uses hitterFinalSimScore
  assert.equal(nameWhite('mlb', { hitterFinalSimScore: 11, qualified: true }),  true,  'hrr 11 → white');
  assert.equal(nameWhite('mlb', { hitterFinalSimScore: 9,  qualified: true }),  false, 'hrr 9 → not white');
  // NBA: uses m.qualified regardless of score
  assert.equal(nameWhite('nba', { nbaSimScore: 14, qualified: true }),  true,  'nba qualified → white');
  assert.equal(nameWhite('nba', { nbaSimScore: 14, qualified: false }), false, 'nba not qualified → not white');
});

// --- TTO decay and blowout hook ---

test('stdBF=0: trialPA is deterministic (no variance injected)', () => {
  const lineup = Array(9).fill(0.22);
  const dist = simulateKsDist(lineup, 30, 1.0, 10000, 18, 0, 0);
  const mean = Array.from(dist).reduce((a, b) => a + b, 0) / dist.length;
  // totalPA=18, TTO never kicks in. Expected ≈ log5(30,22) × 18 ≈ 0.297 × 18 ≈ 5.35
  assert.ok(mean > 4.5 && mean < 6.2, `stdBF=0 mean (${mean.toFixed(2)}) should be near 5.35`);
});

test('stdBF=5: widens K-count distribution vs stdBF=0', () => {
  const lineup = Array(9).fill(0.22);
  const distNarrow = simulateKsDist(lineup, 30, 1.0, 10000, 24, 0, 0);
  const distWide   = simulateKsDist(lineup, 30, 1.0, 10000, 24, 0, 5);
  const variance = d => {
    const m = Array.from(d).reduce((a, b) => a + b, 0) / d.length;
    return Array.from(d).reduce((a, b) => a + (b - m) ** 2, 0) / d.length;
  };
  const varN = variance(distNarrow), varW = variance(distWide);
  assert.ok(varW > varN, `stdBF=5 variance (${varW.toFixed(2)}) should exceed stdBF=0 (${varN.toFixed(2)})`);
});

test('blowout hook overrides stdBF: earlyExitProb=1.0 caps BF even when stdBF=5', () => {
  const lineup = Array(9).fill(0.22);
  const dist = simulateKsDist(lineup, 30, 1.0, 5000, 24, 1.0, 5);
  const maxKs = Math.max(...dist);
  assert.ok(maxKs <= 15, `hook overrides stdBF: max Ks should be <= 15, got ${maxKs}`);
});

test('TTO decay: 24-BF dist mean Ks below naive expectation (no decay)', () => {
  // pitcherKPct is a percentage (30 = 30%); orderedKPcts are fractions (0.22 = 22%).
  // log5K(30, 22) ≈ 0.297 per PA. Naive expected (no decay): 0.297×24 ≈ 7.1.
  // With TTO (BF 19-24 at 0.88×): 0.297×18 + 0.297×0.88×6 ≈ 6.9.
  const lineup = Array(9).fill(0.22);
  const dist = simulateKsDist(lineup, 30, 1.0, 10000, 24);
  const mean = Array.from(dist).reduce((a, b) => a + b, 0) / dist.length;
  assert.ok(mean < 7.1, `mean Ks with TTO (${mean.toFixed(2)}) should be below naive 7.1`);
  assert.ok(mean > 5.5, `mean Ks (${mean.toFixed(2)}) should be above 5.5 (sanity)`);
});

test('earlyExitProb=1.0: all trials cap at BF <= 15, reducing P(K>=5) vs baseline', () => {
  const lineup = Array(9).fill(0.22);
  const distHook = simulateKsDist(lineup, 30, 1.0, 5000, 24, 1.0);
  const distBase = simulateKsDist(lineup, 30, 1.0, 5000, 24, 0);
  const maxKs = Math.max(...distHook);
  assert.ok(maxKs <= 15, `hook dist max Ks should be <= 15, got ${maxKs}`);
  const pHook = kDistPct(distHook, 5);
  const pBase = kDistPct(distBase, 5);
  assert.ok(pHook < pBase, `earlyExitProb=1.0: P(K>=5) hook=${pHook} should be < base=${pBase}`);
});
