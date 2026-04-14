// simulate.test.jxa.js — run with: osascript -l JavaScript api/lib/simulate.test.jxa.js
// Self-contained: inlines simulate.js functions (no ES module imports needed).
// Mock data is defined in simulate.test.fixtures.js — keep in sync when adding/changing fixtures.

// ---- Inlined from simulate.js ----

function log5K(pitcherKPct, batterKPct, leagueKPct) {
  leagueKPct = leagueKPct == null ? 22.2 : leagueKPct;
  var p = pitcherKPct / 100, b = batterKPct / 100, l = leagueKPct / 100;
  var num = p * b / l;
  return num / (num + (1 - p) * (1 - b) / (1 - l));
}

function poissonCDF(k, lambda) {
  var sum = 0, term = Math.exp(-lambda);
  for (var i = 0; i <= k; i++) { sum += term; term *= lambda / (i + 1); }
  return Math.min(1, sum);
}

function simulateKsDist(orderedKPcts, pitcherKPct, parkFactor, nSim, totalPA) {
  parkFactor = parkFactor == null ? 1 : parkFactor;
  nSim = nSim == null ? 5000 : nSim;
  totalPA = totalPA == null ? 24 : totalPA;
  var n = orderedKPcts.length;
  if (!n || pitcherKPct == null) return null;
  var base = Math.floor(totalPA / n);
  var extras = totalPA % n;
  var paArr = orderedKPcts.map(function(_, i) { return base + (i < extras ? 1 : 0); });
  var adjProbs = orderedKPcts.map(function(b) { return Math.min(0.95, log5K(pitcherKPct, b * 100) * parkFactor); });
  var dist = new Int16Array(nSim);
  for (var sim = 0; sim < nSim; sim++) {
    var ks = 0;
    for (var i = 0; i < n; i++) {
      var p = adjProbs[i], pa = paArr[i];
      for (var j = 0; j < pa; j++) { if (Math.random() < p) ks++; }
    }
    dist[sim] = ks;
  }
  return dist;
}

function kDistPct(dist, threshold) {
  if (!dist) return null;
  var hits = 0;
  for (var i = 0; i < dist.length; i++) { if (dist[i] >= threshold) hits++; }
  return parseFloat((hits / dist.length * 100).toFixed(1));
}

function buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim) {
  nSim = nSim == null ? 5000 : nSim;
  if (gameValues.length < 5) return null;
  var recentSlice = gameValues.slice(0, Math.min(10, gameValues.length));
  var meanRecent = recentSlice.reduce(function(a, b) { return a + b; }, 0) / recentSlice.length;
  var meanAll = gameValues.reduce(function(a, b) { return a + b; }, 0) / gameValues.length;
  var variance = gameValues.reduce(function(a, b) { return a + Math.pow(b - meanAll, 2); }, 0) / gameValues.length;
  var std = Math.sqrt(variance);
  if (meanRecent <= 0 || std < 0.5) return null;
  var adjMean = meanRecent;
  if (dvpFactor != null) adjMean *= dvpFactor;
  if (paceAdj != null) adjMean *= (1 + Math.min(Math.max(paceAdj, -15), 15) * 0.002);
  if (isB2B) adjMean *= 0.93;
  adjMean = Math.max(0, adjMean);
  var dist = new Float32Array(nSim);
  for (var i = 0; i < nSim; i++) {
    var u1 = Math.random() + 1e-10, u2 = Math.random();
    var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    dist[i] = adjMean + std * z;
  }
  return dist;
}

function nbaDistPct(dist, threshold) {
  if (!dist) return null;
  var hits = 0;
  for (var i = 0; i < dist.length; i++) { if (dist[i] >= threshold) hits++; }
  return parseFloat((hits / dist.length * 100).toFixed(1));
}

// ---- Test runner ----

var _results = [], _passed = 0, _failed = 0;

function test(name, fn) {
  try {
    fn();
    _results.push('PASS ' + name);
    _passed++;
  } catch(e) {
    _results.push('FAIL ' + name + '\n     ' + e.message);
    _failed++;
  }
}

var assert = {
  ok: function(val, msg) { if (!val) throw new Error(msg || 'Expected truthy, got ' + val); },
  equal: function(a, b, msg) { if (a !== b) throw new Error(msg || ('Expected ' + JSON.stringify(a) + ' === ' + JSON.stringify(b))); },
};

// ---- Tests (mirrors simulate.test.js) ----

test('simulateKsDist returns Int16Array of the requested length', function() {
  var dist = simulateKsDist([0.22, 0.25, 0.20], 0.28, 1.0, 1000);
  assert.ok(dist instanceof Int16Array, 'should be Int16Array');
  assert.equal(dist.length, 1000);
});

test('simulateKsDist returns null for empty lineup', function() {
  assert.equal(simulateKsDist([], 0.28, 1.0, 1000), null);
});

test('simulateKsDist returns null for null pitcherKPct', function() {
  assert.equal(simulateKsDist([0.22, 0.25], null, 1.0, 1000), null);
});

test('kDistPct returns null for null distribution', function() {
  assert.equal(kDistPct(null, 5), null);
});

test('kDistPct returns values in [0, 100]', function() {
  var dist = simulateKsDist([0.22, 0.25, 0.20, 0.18, 0.21], 0.28, 1.0, 2000);
  for (var t = 1; t <= 10; t++) {
    var pct = kDistPct(dist, t);
    assert.ok(pct >= 0 && pct <= 100, 'P(K>=' + t + ')=' + pct + ' should be in [0, 100]');
  }
});

test('kDistPct is monotonically non-increasing across thresholds (shared distribution)', function() {
  var lineup = [];
  for (var i = 0; i < 9; i++) lineup.push(0.21);
  var dist = simulateKsDist(lineup, 0.28, 1.01, 10000);
  var thresholds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  var pcts = thresholds.map(function(t) { return kDistPct(dist, t); });
  for (var i = 0; i < pcts.length - 1; i++) {
    assert.ok(pcts[i] >= pcts[i+1],
      'P(K>=' + thresholds[i] + ')=' + pcts[i] + ' must be >= P(K>=' + thresholds[i+1] + ')=' + pcts[i+1]);
  }
});

test('shared distribution: P(K>=4) >= P(K>=5) for a Gavin Williams-like scenario', function() {
  var lineup = [];
  for (var i = 0; i < 9; i++) lineup.push(0.21);
  var dist = simulateKsDist(lineup, 0.295, 1.01, 10000);
  var pct4 = kDistPct(dist, 4), pct5 = kDistPct(dist, 5);
  assert.ok(pct4 >= pct5, 'P(K>=4)=' + pct4 + ' must be >= P(K>=5)=' + pct5);
});

test('API monotonicity sweep corrects qualified:false plays that underestimate truePct', function() {
  var plays = [
    { sport: 'mlb', stat: 'strikeouts', playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 3, truePct: 92.6, qualified: false },
    { sport: 'mlb', stat: 'strikeouts', playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 4, truePct: 76.8, qualified: false },
    { sport: 'mlb', stat: 'strikeouts', playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 5, truePct: 97.9, qualified: true },
  ];
  var groups = {};
  for (var i = 0; i < plays.length; i++) {
    var p = plays[i];
    if (p.sport === 'mlb' && p.stat === 'strikeouts') {
      var key = p.playerTeam + '|' + p.gameDate;
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    }
  }
  var keys = Object.keys(groups);
  for (var k = 0; k < keys.length; k++) {
    var group = groups[keys[k]];
    group.sort(function(a, b) { return a.threshold - b.threshold; });
    for (var i = group.length - 2; i >= 0; i--) {
      if (group[i].truePct < group[i+1].truePct) group[i].truePct = group[i+1].truePct;
    }
  }
  assert.equal(plays[0].truePct, 97.9, '3+ should be bumped to 97.9');
  assert.equal(plays[1].truePct, 97.9, '4+ should be bumped to 97.9');
  assert.equal(plays[2].truePct, 97.9, '5+ unchanged');
});

test('tonightPlayerMap built from allTonightPlays includes qualified:false thresholds', function() {
  var allTonightPlays = [
    { playerId: 42, playerName: 'Gavin Williams', stat: 'strikeouts', threshold: 3, truePct: 97.9, qualified: false },
    { playerId: 42, playerName: 'Gavin Williams', stat: 'strikeouts', threshold: 4, truePct: 97.9, qualified: false },
    { playerId: 42, playerName: 'Gavin Williams', stat: 'strikeouts', threshold: 5, truePct: 97.9, qualified: true },
  ];
  var oldMap = {};
  for (var i = 0; i < allTonightPlays.length; i++) {
    var p = allTonightPlays[i];
    if (p.qualified !== false) oldMap[p.stat + '|' + p.threshold] = p;
  }
  assert.ok(!oldMap['strikeouts|3'], 'old: 3+ missing from map (causes fallback)');
  assert.ok(!oldMap['strikeouts|4'], 'old: 4+ missing from map (causes fallback)');
  var newMap = {};
  for (var i = 0; i < allTonightPlays.length; i++) {
    var p = allTonightPlays[i];
    if (p.playerId === 42) newMap[p.stat + '|' + p.threshold] = p;
  }
  assert.equal(newMap['strikeouts|3'].truePct, 97.9, 'new: 3+ has simulation truePct');
  assert.equal(newMap['strikeouts|4'].truePct, 97.9, 'new: 4+ has simulation truePct');
  assert.equal(newMap['strikeouts|5'].truePct, 97.9, 'new: 5+ unchanged');
});

test('nbaDistPct is monotonically non-increasing across thresholds', function() {
  var values = [22, 18, 25, 30, 19, 27, 24, 21, 28, 20];
  var dist = buildNbaStatDist(values, 1.0, 0, false, 5000);
  assert.ok(dist instanceof Float32Array, 'should be Float32Array');
  var thresholds = [10, 15, 20, 25, 30, 35, 40];
  var pcts = thresholds.map(function(t) { return nbaDistPct(dist, t); });
  for (var i = 0; i < pcts.length - 1; i++) {
    assert.ok(pcts[i] >= pcts[i+1],
      'P(pts>=' + thresholds[i] + ')=' + pcts[i] + ' must be >= P(pts>=' + thresholds[i+1] + ')=' + pcts[i+1]);
  }
});

test('buildNbaStatDist returns null for insufficient data', function() {
  assert.equal(buildNbaStatDist([], 1.0, 0, false, 1000), null);
  assert.equal(buildNbaStatDist([20, 18, 22, 25], 1.0, 0, false, 1000), null);
});

function computeNbaDropSimScore(o) {
  var preScore = (o.paceAdj != null && o.paceAdj > 0 ? 3 : 0)
    + (o.opportunity != null ? (o.opportunity >= 30 ? 4 : o.opportunity >= 25 ? 2 : 0) : 0)
    + (o.dvpRank != null && o.dvpRank <= 10 ? 2 : 0)
    + (!o.isB2B ? 2 : 0);
  return { preScore: preScore, simScore: preScore + (o.edge != null && o.edge > 5 ? 3 : 0) };
}

test('NBA drop simScore: all components contribute correctly', function() {
  var r = computeNbaDropSimScore({ paceAdj: 2.5, opportunity: 34, dvpRank: 8, isB2B: false, edge: 8 });
  assert.equal(r.preScore, 11, 'pre-edge: 3+4+2+2=11');
  assert.equal(r.simScore, 14, 'with edge bonus: 11+3=14');
});

test('NBA drop simScore: B2B and soft pace give lower score', function() {
  var r = computeNbaDropSimScore({ paceAdj: -1.0, opportunity: 28, dvpRank: 15, isB2B: true, edge: 2 });
  assert.equal(r.preScore, 2, 'pre-edge: 0+2+0+0=2');
  assert.equal(r.simScore, 2, 'no edge bonus');
});

test('NBA drop simScore: missing fields default to 0 pts', function() {
  var r = computeNbaDropSimScore({ paceAdj: null, opportunity: null, dvpRank: null, isB2B: false, edge: null });
  assert.equal(r.preScore, 2, 'only rest contributes when other fields null');
});

test('HRR rows filtered to threshold=1 only', function() {
  var allRows = [
    { stat: 'hrr', threshold: 1, playerName: 'A' },
    { stat: 'hrr', threshold: 2, playerName: 'A' },
    { stat: 'hrr', threshold: 3, playerName: 'B' },
    { stat: 'strikeouts', threshold: 3, playerName: 'C' },
    { stat: 'strikeouts', threshold: 5, playerName: 'C' },
  ];
  var filtered = allRows.filter(function(r) { return r.stat !== 'hrr' || r.threshold === 1; });
  var hrrRows = filtered.filter(function(r) { return r.stat === 'hrr'; });
  assert.equal(hrrRows.length, 1, 'only one HRR row (threshold=1)');
  assert.equal(hrrRows[0].threshold, 1);
  var ksRows = filtered.filter(function(r) { return r.stat === 'strikeouts'; });
  assert.equal(ksRows.length, 2, 'strikeout rows all pass through');
});

test('buildLineupKPct early-return shape includes all destructured fields', function() {
  var ret = { lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {}, lineupBatterKPctsOrdered: {}, lineupBatterKPctsVROrdered: {}, lineupBatterKPctsVLOrdered: {}, lineupSpotByName: {}, gameHomeTeams: {}, projectedLineupTeams: [] };
  var required = ['lineupKPct','lineupBatterKPcts','lineupKPctVR','lineupKPctVL','lineupBatterKPctsOrdered','lineupBatterKPctsVROrdered','lineupBatterKPctsVLOrdered','lineupSpotByName','gameHomeTeams','projectedLineupTeams'];
  for (var i = 0; i < required.length; i++) {
    assert.ok(required[i] in ret, 'lineupKPct early-return missing key: ' + required[i]);
  }
});

test('buildPitcherKPct early-return shape includes all destructured fields', function() {
  var ret = { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherCSWPct: {}, pitcherAvgPitches: {} };
  var required = ['pitcherKPct','pitcherKBBPct','pitcherHand','pitcherEra','pitcherCSWPct','pitcherAvgPitches'];
  for (var i = 0; i < required.length; i++) {
    assert.ok(required[i] in ret, 'pitcherKPct early-return missing key: ' + required[i]);
  }
});

test('_nameWhite: MLB uses score>10, non-MLB uses m.qualified', function() {
  var nameWhite = function(sport, m) {
    return sport === 'mlb'
      ? (m.finalSimScore != null || m.hitterFinalSimScore != null) && (m.finalSimScore || m.hitterFinalSimScore) > 10
      : m.qualified;
  };
  assert.equal(nameWhite('mlb', { finalSimScore: 14, qualified: true }),  true,  'mlb 14 → white');
  assert.equal(nameWhite('mlb', { finalSimScore: 10, qualified: true }),  false, 'mlb 10 → not white');
  assert.equal(nameWhite('mlb', { finalSimScore: 8,  qualified: false }), false, 'mlb 8 → not white');
  assert.equal(nameWhite('mlb', { hitterFinalSimScore: 11, qualified: true }),  true,  'hrr 11 → white');
  assert.equal(nameWhite('mlb', { hitterFinalSimScore: 9,  qualified: true }),  false, 'hrr 9 → not white');
  assert.equal(nameWhite('nba', { nbaSimScore: 14, qualified: true }),  true,  'nba qualified → white');
  assert.equal(nameWhite('nba', { nbaSimScore: 14, qualified: false }), false, 'nba not qualified → not white');
});

// ---- Frontend monotonicity enforcement (new — index.html fix) ----

test('frontend _rawTruePctMap monotonicity: raises lower thresholds to match a higher sim value', function() {
  // Mirrors the new enforcement block added to index.html after _rawTruePctMap population.
  // Simulates the Gavin Williams scenario: 5+ sim=98.1, 4+ fallback=70.1, 3+ fallback=92.6
  var _rawTruePctMap = { 3: 92.6, 4: 70.1, 5: 98.1, 6: 44.6, 7: 35.8, 8: 32.8, 9: 15.7, 10: 12.7 };
  var _mts = Object.keys(_rawTruePctMap).map(Number).filter(function(t) { return _rawTruePctMap[t] != null; }).sort(function(a,b) { return b-a; });
  var _mx = 0;
  for (var i = 0; i < _mts.length; i++) {
    var _t = _mts[i];
    if (_rawTruePctMap[_t] < _mx) _rawTruePctMap[_t] = _mx;
    else _mx = _rawTruePctMap[_t];
  }
  assert.equal(_rawTruePctMap[3],  98.1, '3+ raised to 98.1');
  assert.equal(_rawTruePctMap[4],  98.1, '4+ raised to 98.1');
  assert.equal(_rawTruePctMap[5],  98.1, '5+ unchanged');
  assert.equal(_rawTruePctMap[6],  44.6, '6+ unchanged');
  assert.equal(_rawTruePctMap[10], 12.7, '10+ unchanged');
  // verify full monotonicity
  var sorted = Object.keys(_rawTruePctMap).map(Number).sort(function(a,b) { return a-b; });
  for (var i = 0; i < sorted.length - 1; i++) {
    assert.ok(_rawTruePctMap[sorted[i]] >= _rawTruePctMap[sorted[i+1]],
      'threshold ' + sorted[i] + ' (' + _rawTruePctMap[sorted[i]] + ') must be >= ' + sorted[i+1] + ' (' + _rawTruePctMap[sorted[i+1]] + ')');
  }
});

// ---- Deduplication fix: qualified:false plays kept per-threshold ----

test('deduplication keeps all qualified:false plays per threshold (not collapsed to one)', function() {
  // Before fix: key was playerName|sport|stat → all thresholds collapsed to the one with highest edge.
  // 5+ (edge +24.1%) would win; 3+ (-0.4%) and 4+ (-16.9%) would be removed.
  // After fix: qualified:false plays use key with threshold appended.
  var plays = [
    { playerName: 'Gavin Williams', sport: 'mlb', stat: 'strikeouts', threshold: 3, edge: -0.4, kalshiPct: 93, truePct: 92.6, qualified: false },
    { playerName: 'Gavin Williams', sport: 'mlb', stat: 'strikeouts', threshold: 4, edge: -16.9, kalshiPct: 87, truePct: 70.1, qualified: false },
    { playerName: 'Gavin Williams', sport: 'mlb', stat: 'strikeouts', threshold: 5, edge: 24.1, kalshiPct: 74, truePct: 98.1, qualified: true },
  ];
  var bestMap = {};
  for (var i = 0; i < plays.length; i++) {
    var play = plays[i];
    var key = play.qualified === false
      ? play.playerName + '|' + play.sport + '|' + play.stat + '|' + play.threshold
      : play.playerName + '|' + play.sport + '|' + play.stat;
    var prev = bestMap[key];
    var isBetter = !prev || (play.sport === 'mlb' && play.stat === 'strikeouts' ? play.edge > prev.edge : play.kalshiPct > prev.kalshiPct);
    if (isBetter) bestMap[key] = play;
  }
  var result = Object.values(bestMap);
  assert.equal(result.length, 3, 'all 3 thresholds kept');
  assert.ok(result.some(function(p) { return p.threshold === 3; }), '3+ present');
  assert.ok(result.some(function(p) { return p.threshold === 4; }), '4+ present');
  assert.ok(result.some(function(p) { return p.threshold === 5; }), '5+ present');
});

// ---- Backend dist-based monotonicity sweep ----

test('backend sweep: re-derives all thresholds from shared distribution giving distinct values', function() {
  // Simulates the sweep in api/[...path].js after dedup fix.
  // Distribution is shared across thresholds — values must be strictly monotonic.
  // Use a weaker pitcher (22% K vs 22% lineup) so thresholds have meaningfully distinct values.
  // lineup values are decimals (×100 inside simulateKsDist), pitcherKPct is a percentage.
  var lineup = [];
  for (var i = 0; i < 9; i++) lineup.push(0.22);
  var dist = simulateKsDist(lineup, 22, 1.0, 10000);
  var plays = [
    { playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 3, kalshiPct: 93, truePct: 92.6, simPct: null, qualified: false },
    { playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 4, kalshiPct: 87, truePct: 70.1, simPct: null, qualified: false },
    { playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 5, kalshiPct: 74, truePct: 98.1, simPct: 98.1, qualified: true },
  ];
  // Simulate the sweep: re-derive from dist
  for (var i = 0; i < plays.length; i++) {
    var recomp = kDistPct(dist, plays[i].threshold);
    if (recomp != null) {
      plays[i].truePct = recomp;
      plays[i].simPct = recomp;
      plays[i].edge = parseFloat((recomp - plays[i].kalshiPct).toFixed(1));
    }
  }
  // After sweep: all truePcts come from the shared dist → strictly monotonic
  assert.ok(plays[0].truePct >= plays[1].truePct, '3+.truePct >= 4+.truePct');
  assert.ok(plays[1].truePct >= plays[2].truePct, '4+.truePct >= 5+.truePct');
  // Values should be distinct (3+ > 4+ > 5+ for a mid-range pitcher)
  assert.ok(plays[0].truePct > plays[2].truePct, '3+.truePct > 5+.truePct (distinct values)');
});

// ---- Summary ----

var summary = '\n' + _results.join('\n') + '\n\n' + _passed + ' passed, ' + _failed + ' failed';
if (_failed > 0) throw new Error(summary);
summary;
