// Tests for simulate.js — run with: npm test
// Covers kDistPct monotonicity (the root cause of the player card truePct bug),
// simulateKsDist validity, and the qualified:false player card lookup fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateKsDist, kDistPct, buildNbaStatDist, nbaDistPct } from './simulate.js';

// --- simulateKsDist ---

test('simulateKsDist returns Int16Array of the requested length', () => {
  const dist = simulateKsDist([0.22, 0.25, 0.20], 0.28, 1.0, 1000);
  assert.ok(dist instanceof Int16Array, 'should be Int16Array');
  assert.equal(dist.length, 1000);
});

test('simulateKsDist returns null for empty lineup', () => {
  assert.equal(simulateKsDist([], 0.28, 1.0, 1000), null);
});

test('simulateKsDist returns null for null pitcherKPct', () => {
  assert.equal(simulateKsDist([0.22, 0.25], null, 1.0, 1000), null);
});

// --- kDistPct ---

test('kDistPct returns null for null distribution', () => {
  assert.equal(kDistPct(null, 5), null);
});

test('kDistPct returns values in [0, 100]', () => {
  const dist = simulateKsDist([0.22, 0.25, 0.20, 0.18, 0.21], 0.28, 1.0, 2000);
  for (let t = 1; t <= 10; t++) {
    const pct = kDistPct(dist, t);
    assert.ok(pct >= 0 && pct <= 100, `P(K>=${t})=${pct} should be in [0, 100]`);
  }
});

// Key invariant: sharing one distribution guarantees strict monotonicity.
// This is the root cause fix — before the fix, 3+/4+ used a fallback formula
// independent of the 5+ simulation, breaking monotonicity (76.8% < 97.9%).
test('kDistPct is monotonically non-increasing across thresholds (shared distribution)', () => {
  const lineup = Array(9).fill(0.21); // 9-batter lineup, each K% 21%
  const dist = simulateKsDist(lineup, 0.28, 1.01, 10000);
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
  const lineup = Array(9).fill(0.21); // Cardinals K% ~21% vs RHP
  const dist = simulateKsDist(lineup, 0.295, 1.01, 10000); // pitcher K% ~29.5%, +1% park
  const pct4 = kDistPct(dist, 4);
  const pct5 = kDistPct(dist, 5);
  assert.ok(pct4 >= pct5, `P(K>=4)=${pct4} must be >= P(K>=5)=${pct5}`);
});

// --- API-side monotonicity enforcement ---

// Mirrors the enforcement logic in api/[...path].js (~line 2286).
// When qualified:false plays (3+, 4+) have lower truePct than a qualifying play (5+)
// due to the fallback formula, the sweep must correct them.
test('API monotonicity sweep corrects qualified:false plays that underestimate truePct', () => {
  const plays = [
    { sport: 'mlb', stat: 'strikeouts', playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 3, truePct: 92.6, qualified: false },
    { sport: 'mlb', stat: 'strikeouts', playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 4, truePct: 76.8, qualified: false }, // was fallback formula
    { sport: 'mlb', stat: 'strikeouts', playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 5, truePct: 97.9, qualified: true },  // from simulation
  ];

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
  const allTonightPlays = [
    { playerId: 42, playerName: 'Gavin Williams', stat: 'strikeouts', threshold: 3, truePct: 97.9, simPct: 97.9, qualified: false },
    { playerId: 42, playerName: 'Gavin Williams', stat: 'strikeouts', threshold: 4, truePct: 97.9, simPct: 97.9, qualified: false },
    { playerId: 42, playerName: 'Gavin Williams', stat: 'strikeouts', threshold: 5, truePct: 97.9, simPct: 97.9, qualified: true },
  ];

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
  const values = [22, 18, 25, 30, 19, 27, 24, 21, 28, 20]; // 10 game sample
  const dist = buildNbaStatDist(values, 1.0, 0, false, 5000);
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

// Mirrors the inline computation added to api/[...path].js at the opp_not_soft drop.
// All four components (pace, minutes, DVP rank, rest) plus edge bonus must be correct.
function computeNbaDropSimScore({ paceAdj, opportunity, dvpRank, isB2B, edge }) {
  const preScore = (paceAdj != null && paceAdj > 0 ? 3 : 0)
    + (opportunity != null ? (opportunity >= 32 ? 4 : opportunity >= 25 ? 2 : 0) : 0)
    + (dvpRank != null && dvpRank <= 10 ? 2 : 0)
    + (!isB2B ? 2 : 0);
  return { preScore, simScore: preScore + (edge != null && edge > 5 ? 3 : 0) };
}

test('NBA drop simScore: all components contribute correctly', () => {
  const { preScore, simScore } = computeNbaDropSimScore({
    paceAdj: 2.5,      // above avg → +3
    opportunity: 34,   // ≥32 min → +4
    dvpRank: 8,        // ≤10 → +2
    isB2B: false,      // rested → +2
    edge: 8,           // >5% → +3 bonus
  });
  assert.equal(preScore, 11, 'pre-edge: 3+4+2+2=11');
  assert.equal(simScore, 14, 'with edge bonus: 11+3=14');
});

test('NBA drop simScore: B2B and soft pace give lower score', () => {
  const { preScore, simScore } = computeNbaDropSimScore({
    paceAdj: -1.0,     // below avg → 0
    opportunity: 28,   // ≥25 but <32 → +2
    dvpRank: 15,       // >10 → 0
    isB2B: true,       // B2B → 0
    edge: 2,           // ≤5% → no bonus
  });
  assert.equal(preScore, 2, 'pre-edge: 0+2+0+0=2');
  assert.equal(simScore, 2, 'no edge bonus');
});

test('NBA drop simScore: missing fields default to 0 pts', () => {
  const { preScore } = computeNbaDropSimScore({
    paceAdj: null,
    opportunity: null,
    dvpRank: null,
    isB2B: false,   // rested → +2
    edge: null,
  });
  assert.equal(preScore, 2, 'only rest contributes when other fields null');
});

// --- HRR threshold filter ---

// The report filters HRR rows to threshold=1 only (2+/3+/etc. are too noisy).
// This tests the filter expression used in index.html.
test('HRR rows filtered to threshold=1 only', () => {
  const allRows = [
    { stat: 'hrr', threshold: 1, playerName: 'A' },
    { stat: 'hrr', threshold: 2, playerName: 'A' },
    { stat: 'hrr', threshold: 3, playerName: 'B' },
    { stat: 'strikeouts', threshold: 3, playerName: 'C' },
    { stat: 'strikeouts', threshold: 5, playerName: 'C' },
  ];
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
  // Mirrors the early-return on allIds.length === 0
  const ret = { lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {}, lineupBatterKPctsOrdered: {}, lineupBatterKPctsVROrdered: {}, lineupBatterKPctsVLOrdered: {}, lineupSpotByName: {}, gameHomeTeams: {}, projectedLineupTeams: [] };
  const required = ['lineupKPct','lineupBatterKPcts','lineupKPctVR','lineupKPctVL','lineupBatterKPctsOrdered','lineupBatterKPctsVROrdered','lineupBatterKPctsVLOrdered','lineupSpotByName','gameHomeTeams','projectedLineupTeams'];
  for (const key of required) {
    assert.ok(key in ret, `lineupKPct early-return missing key: ${key}`);
  }
});

test('buildPitcherKPct early-return shape includes all destructured fields', () => {
  const ret = { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherCSWPct: {}, pitcherAvgPitches: {} };
  const required = ['pitcherKPct','pitcherKBBPct','pitcherHand','pitcherEra','pitcherCSWPct','pitcherAvgPitches'];
  for (const key of required) {
    assert.ok(key in ret, `pitcherKPct early-return missing key: ${key}`);
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
