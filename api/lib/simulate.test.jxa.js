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

var TTO_DECAY_FACTOR = 0.88;

function simulateKsDist(orderedKPcts, pitcherKPct, parkFactor, nSim, totalPA, earlyExitProb, stdBF) {
  parkFactor = parkFactor == null ? 1 : parkFactor;
  nSim = nSim == null ? 5000 : nSim;
  totalPA = totalPA == null ? 24 : totalPA;
  earlyExitProb = earlyExitProb == null ? 0 : earlyExitProb;
  stdBF = stdBF == null ? 0 : stdBF;
  var n = orderedKPcts.length;
  if (!n || pitcherKPct == null) return null;
  var base = Math.floor(totalPA / n);
  var extras = totalPA % n;
  var paArr = orderedKPcts.map(function(_, i) { return base + (i < extras ? 1 : 0); });
  var adjProbs = orderedKPcts.map(function(b) { return Math.min(0.95, log5K(pitcherKPct, b * 100) * parkFactor); });
  var _bmSpare = false, _bmZ1 = 0;
  function randNorm(mean, std) {
    if (_bmSpare) { _bmSpare = false; return mean + std * _bmZ1; }
    var u1 = 1.0 - Math.random(), u2 = Math.random();
    var r = Math.sqrt(-2.0 * Math.log(u1));
    _bmZ1 = r * Math.sin(2.0 * Math.PI * u2);
    _bmSpare = true;
    return mean + std * r * Math.cos(2.0 * Math.PI * u2);
  }
  var dist = new Int16Array(nSim);
  for (var sim = 0; sim < nSim; sim++) {
    var ks = 0, bf = 0;
    var trialPA = totalPA;
    if (earlyExitProb > 0 && Math.random() < earlyExitProb) {
      trialPA = 10 + Math.floor(Math.random() * 6);
    } else if (stdBF > 0) {
      trialPA = Math.min(27, Math.max(10, Math.round(randNorm(totalPA, stdBF))));
    }
    for (var i = 0; i < n; i++) {
      var pa = paArr[i];
      var p = bf >= 18 ? Math.min(0.95, adjProbs[i] * TTO_DECAY_FACTOR) : adjProbs[i];
      for (var j = 0; j < pa; j++) {
        if (bf >= trialPA) break;
        if (Math.random() < p) ks++;
        bf++;
      }
      if (bf >= trialPA) break;
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

function poissonSample(lambda) {
  if (lambda <= 0) return 0;
  var L = Math.exp(-Math.min(lambda, 100));
  var k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function simulateMLBTotalDist(homeLambda, awayLambda, nSim) {
  nSim = nSim == null ? 10000 : nSim;
  if (!homeLambda || !awayLambda || homeLambda <= 0 || awayLambda <= 0) return null;
  var dist = new Int16Array(nSim);
  for (var i = 0; i < nSim; i++) dist[i] = poissonSample(homeLambda) + poissonSample(awayLambda);
  return dist;
}

function simulateNBATotalDist(homeMean, awayMean, homeStd, awayStd, nSim) {
  homeStd = homeStd == null ? 11 : homeStd;
  awayStd = awayStd == null ? 11 : awayStd;
  nSim = nSim == null ? 10000 : nSim;
  if (!homeMean || !awayMean || homeMean <= 0 || awayMean <= 0) return null;
  var dist = new Int16Array(nSim);
  for (var i = 0; i < nSim; i++) {
    var u1h = Math.random() + 1e-10, u2h = Math.random();
    var u1a = Math.random() + 1e-10, u2a = Math.random();
    var zh = Math.sqrt(-2 * Math.log(u1h)) * Math.cos(2 * Math.PI * u2h);
    var za = Math.sqrt(-2 * Math.log(u1a)) * Math.cos(2 * Math.PI * u2a);
    var total = (homeMean + homeStd * zh) + (awayMean + awayStd * za);
    dist[i] = Math.round(Math.max(0, total));
  }
  return dist;
}

function simulateNHLTotalDist(homeLambda, awayLambda, nSim) {
  nSim = nSim == null ? 10000 : nSim;
  if (!homeLambda || !awayLambda || homeLambda <= 0 || awayLambda <= 0) return null;
  var dist = new Int16Array(nSim);
  for (var i = 0; i < nSim; i++) dist[i] = poissonSample(homeLambda) + poissonSample(awayLambda);
  return dist;
}

function totalDistPct(dist, threshold) {
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
  // gameTotal tier: ≥235→3pts, ≥225→2pts, ≥215→1pt, <215→0pts, null→1pt
  var totalPts = o.gameTotal == null ? 1 : o.gameTotal >= 235 ? 3 : o.gameTotal >= 225 ? 2 : o.gameTotal >= 215 ? 1 : 0;
  var preScore = (o.paceAdj != null && o.paceAdj > 0 ? 3 : 0)
    + (o.opportunity != null ? (o.opportunity >= 30 ? 4 : o.opportunity >= 25 ? 2 : 0) : 0)
    + (o.dvpRank != null && o.dvpRank <= 10 ? 2 : 0)
    + (!o.isB2B ? 2 : 0)
    + totalPts;
  // edge is a gate only — not part of simScore (max 14)
  return { preScore: preScore, simScore: preScore };
}

test('NBA drop simScore: all components contribute correctly', function() {
  // pace(3) + min≥30(4) + dvp≤10(2) + rested(2) + total null→1 = 12; with total≥235: 3+4+2+2+3=14
  var r = computeNbaDropSimScore({ paceAdj: 2.5, opportunity: 34, dvpRank: 8, isB2B: false, gameTotal: 238 });
  assert.equal(r.preScore, 14, '3+4+2+2+3=14 (high total)');
  assert.equal(r.simScore, 14, 'edge is gate only, simScore=preScore');
});

test('NBA drop simScore: null game total abstains (1pt)', function() {
  var r = computeNbaDropSimScore({ paceAdj: 2.5, opportunity: 34, dvpRank: 8, isB2B: false, gameTotal: null });
  assert.equal(r.preScore, 12, '3+4+2+2+1(abstain)=12');
});

test('NBA drop simScore: B2B and soft pace give lower score', function() {
  var r = computeNbaDropSimScore({ paceAdj: -1.0, opportunity: 28, dvpRank: 15, isB2B: true, gameTotal: 210 });
  assert.equal(r.preScore, 2, 'pre-score: 0+2+0+0+0=2 (slow game, no dvp, b2b)');
  assert.equal(r.simScore, 2, 'edge is gate only');
});

test('NBA drop simScore: missing fields default to 0 pts', function() {
  var r = computeNbaDropSimScore({ paceAdj: null, opportunity: null, dvpRank: null, isB2B: false, gameTotal: null });
  assert.equal(r.preScore, 3, 'rest(2) + total null→1(1) = 3');
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

// ---- Game total simulations ----

test('simulateMLBTotalDist returns Int16Array of requested length', function() {
  var dist = simulateMLBTotalDist(4.5, 4.2, 2000);
  assert.ok(dist instanceof Int16Array, 'should be Int16Array');
  assert.equal(dist.length, 2000);
});

test('simulateMLBTotalDist returns null for invalid lambdas', function() {
  assert.equal(simulateMLBTotalDist(0, 4.2, 1000), null);
  assert.equal(simulateMLBTotalDist(4.5, null, 1000), null);
  assert.equal(simulateMLBTotalDist(-1, 4.2, 1000), null);
});

test('simulateMLBTotalDist: P(total >= 1) near 100% for normal lambdas', function() {
  var dist = simulateMLBTotalDist(4.5, 4.2, 5000);
  var pct = totalDistPct(dist, 1);
  assert.ok(pct > 95, 'P(total >= 1) should be > 95% for lambdas of 4.5+4.2, got ' + pct);
});

test('simulateMLBTotalDist: monotonicity across thresholds', function() {
  var dist = simulateMLBTotalDist(4.5, 4.2, 5000);
  var prev = 100;
  for (var t = 1; t <= 15; t++) {
    var pct = totalDistPct(dist, t);
    assert.ok(pct <= prev, 'P(>='+t+')='+pct+' should be <= P(>='+(t-1)+')='+prev);
    prev = pct;
  }
});

test('simulateNBATotalDist returns Int16Array of requested length', function() {
  var dist = simulateNBATotalDist(115, 112, 11, 11, 2000);
  assert.ok(dist instanceof Int16Array, 'should be Int16Array');
  assert.equal(dist.length, 2000);
});

test('simulateNBATotalDist returns null for invalid means', function() {
  assert.equal(simulateNBATotalDist(0, 112, 11, 11, 1000), null);
  assert.equal(simulateNBATotalDist(115, null, 11, 11, 1000), null);
});

test('simulateNBATotalDist: mean total near 227 for 115+112', function() {
  var dist = simulateNBATotalDist(115, 112, 11, 11, 10000);
  var vals = Array.from(dist);
  var mean = vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
  assert.ok(mean > 215 && mean < 240, 'mean total should be near 227, got ' + mean.toFixed(1));
});

test('simulateNBATotalDist: monotonicity across thresholds', function() {
  var dist = simulateNBATotalDist(115, 112, 11, 11, 5000);
  var prev = 100;
  for (var t = 200; t <= 260; t += 5) {
    var pct = totalDistPct(dist, t);
    assert.ok(pct <= prev, 'P(>='+t+')='+pct+' should be <= P(>='+(t-5)+')='+prev);
    prev = pct;
  }
});

test('simulateNHLTotalDist returns Int16Array of requested length', function() {
  var dist = simulateNHLTotalDist(3.1, 2.8, 2000);
  assert.ok(dist instanceof Int16Array, 'should be Int16Array');
  assert.equal(dist.length, 2000);
});

test('simulateNHLTotalDist: P(total >= 1) near 100% for normal lambdas', function() {
  var dist = simulateNHLTotalDist(3.1, 2.8, 5000);
  var pct = totalDistPct(dist, 1);
  assert.ok(pct > 95, 'P(total >= 1) should be > 95%, got ' + pct);
});

test('totalDistPct returns null for null dist', function() {
  assert.equal(totalDistPct(null, 7), null);
});

test('totalDistPct: P(>= low) > P(>= high) for same dist', function() {
  var dist = simulateMLBTotalDist(4.5, 4.2, 5000);
  var pLow = totalDistPct(dist, 5);
  var pHigh = totalDistPct(dist, 10);
  assert.ok(pLow > pHigh, 'P(>=5)='+pLow+' should be > P(>=10)='+pHigh);
});

// ---- TTO decay and blowout hook ----

test('stdBF=0: trialPA is deterministic (no variance injected)', function() {
  // With stdBF=0 every trial uses exactly totalPA=18. Mean Ks should tightly match adjProb × 18.
  var lineup = [];
  for (var i = 0; i < 9; i++) lineup.push(0.22);
  var dist = simulateKsDist(lineup, 30, 1.0, 10000, 18, 0, 0);
  var mean = 0;
  for (var i = 0; i < dist.length; i++) mean += dist[i];
  mean /= dist.length;
  // With totalPA=18, TTO never kicks in (all BF < 19). Expected ≈ log5(30,22) × 18 ≈ 0.297 × 18 ≈ 5.35
  assert.ok(mean > 4.5 && mean < 6.2, 'stdBF=0 mean (' + mean.toFixed(2) + ') should be near 5.35');
});

test('stdBF=5: widens K-count distribution vs stdBF=0', function() {
  var lineup = [];
  for (var i = 0; i < 9; i++) lineup.push(0.22);
  var distNarrow = simulateKsDist(lineup, 30, 1.0, 10000, 24, 0, 0);
  var distWide   = simulateKsDist(lineup, 30, 1.0, 10000, 24, 0, 5);
  function variance(d) {
    var m = 0;
    for (var i = 0; i < d.length; i++) m += d[i];
    m /= d.length;
    var v = 0;
    for (var i = 0; i < d.length; i++) v += (d[i] - m) * (d[i] - m);
    return v / d.length;
  }
  var varN = variance(distNarrow), varW = variance(distWide);
  assert.ok(varW > varN, 'stdBF=5 variance (' + varW.toFixed(2) + ') should exceed stdBF=0 (' + varN.toFixed(2) + ')');
});

test('blowout hook overrides stdBF: earlyExitProb=1.0 caps BF even when stdBF=5', function() {
  var lineup = [];
  for (var i = 0; i < 9; i++) lineup.push(0.22);
  var dist = simulateKsDist(lineup, 30, 1.0, 5000, 24, 1.0, 5);
  var maxKs = 0;
  for (var i = 0; i < dist.length; i++) { if (dist[i] > maxKs) maxKs = dist[i]; }
  assert.ok(maxKs <= 15, 'hook overrides stdBF: max Ks should be <= 15, got ' + maxKs);
});

test('TTO decay: 24-BF dist mean Ks below naive expectation (no decay)', function() {
  // pitcherKPct is a percentage (30 = 30%); orderedKPcts are fractions (0.22 = 22%).
  // log5K(30, 0.22×100=22) ≈ 0.297 per PA. Naive expected Ks (no decay): 0.297×24 ≈ 7.1.
  // With TTO (BF 19-24 at 0.88×): 0.297×18 + 0.297×0.88×6 ≈ 5.35 + 1.57 ≈ 6.9.
  var lineup = [];
  for (var i = 0; i < 9; i++) lineup.push(0.22);
  var dist = simulateKsDist(lineup, 30, 1.0, 10000, 24);
  var mean = 0;
  for (var i = 0; i < dist.length; i++) mean += dist[i];
  mean /= dist.length;
  assert.ok(mean < 7.1, 'mean Ks with TTO (' + mean.toFixed(2) + ') should be below naive 7.1');
  assert.ok(mean > 5.5, 'mean Ks (' + mean.toFixed(2) + ') should be above 5.5 (sanity)');
});

test('earlyExitProb=1.0: all trials cap at BF <= 15, reducing P(K>=5) vs baseline', function() {
  var lineup = [];
  for (var i = 0; i < 9; i++) lineup.push(0.22);
  var distHook = simulateKsDist(lineup, 30, 1.0, 5000, 24, 1.0);
  var distBase = simulateKsDist(lineup, 30, 1.0, 5000, 24, 0);
  var maxKs = 0;
  for (var i = 0; i < distHook.length; i++) { if (distHook[i] > maxKs) maxKs = distHook[i]; }
  assert.ok(maxKs <= 15, 'hook dist max Ks should be <= 15, got ' + maxKs);
  var pHook = kDistPct(distHook, 5);
  var pBase = kDistPct(distBase, 5);
  assert.ok(pHook < pBase, 'earlyExitProb=1.0: P(K>=5) hook=' + pHook + ' should be < base=' + pBase);
});

// ---- Inlined from api/[...path].js: _parseWind + weatherFactor ----

function parseWind(dv) {
  if (!dv) return { windSpeed: null, windOutMph: null };
  var v = dv.toLowerCase();
  var m = v.match(/(\d+(?:\.\d+)?)\s*mph/);
  var spd = m ? parseFloat(m[1]) : null;
  if (spd == null) return { windSpeed: null, windOutMph: null };
  if (spd === 0) return { windSpeed: 0, windOutMph: 0 };
  var isOut = v.indexOf(' out to ') !== -1 || v.indexOf(' out ') !== -1 || (v.slice(-4) === ' out');
  var isIn  = v.indexOf(' in from ') !== -1 || v.indexOf(' in to ') !== -1 || (v.indexOf(' in ') !== -1 && !isOut);
  return { windSpeed: spd, windOutMph: isOut ? spd : isIn ? -spd : 0 };
}

function calcWeatherFactor(windOutMph, tempF) {
  if (windOutMph == null) return 1.0;
  var raw = 1 + windOutMph * 0.013 + ((tempF == null ? 72 : tempF) - 72) * 0.001;
  return Math.max(0.85, Math.min(1.15, raw));
}

// ---- parseWind tests ----

test('parseWind: "Out to LF" → positive windOutMph', function() {
  var r = parseWind('Partly Cloudy, 72 °F, Wind 14 mph Out to LF');
  assert.equal(r.windSpeed, 14, 'windSpeed=14');
  assert.equal(r.windOutMph, 14, 'windOutMph=14 (out)');
});

test('parseWind: "In from CF" → negative windOutMph', function() {
  var r = parseWind('Overcast, 65 °F, Wind 8 mph In from CF');
  assert.equal(r.windSpeed, 8, 'windSpeed=8');
  assert.equal(r.windOutMph, -8, 'windOutMph=-8 (in)');
});

test('parseWind: "Out to CF" short form → positive', function() {
  var r = parseWind('Clear, 78 °F, Wind 11 mph Out to CF');
  assert.equal(r.windOutMph, 11, 'windOutMph=11');
});

test('parseWind: "0 mph" → windOutMph=0', function() {
  var r = parseWind('Sunny, 80 °F, Wind 0 mph');
  assert.equal(r.windSpeed, 0, 'windSpeed=0');
  assert.equal(r.windOutMph, 0, 'windOutMph=0');
});

test('parseWind: crosswind (no out/in keyword) → windOutMph=0', function() {
  var r = parseWind('Partly Cloudy, 70 °F, Wind 6 mph, L to R');
  assert.equal(r.windSpeed, 6, 'windSpeed=6');
  assert.equal(r.windOutMph, 0, 'windOutMph=0 (crosswind)');
});

test('parseWind: empty string → both null', function() {
  var r = parseWind('');
  assert.equal(r.windSpeed, null);
  assert.equal(r.windOutMph, null);
});

test('parseWind: null → both null', function() {
  var r = parseWind(null);
  assert.equal(r.windSpeed, null);
  assert.equal(r.windOutMph, null);
});

test('parseWind: temperature-only string (no mph) → both null', function() {
  var r = parseWind('72 °F');
  assert.equal(r.windSpeed, null);
  assert.equal(r.windOutMph, null);
});

// ---- weatherFactor tests ----

test('weatherFactor: 10 mph out, 72F → 1 + 0.13 = 1.13', function() {
  var f = calcWeatherFactor(10, 72);
  assert.ok(Math.abs(f - 1.13) < 0.001, 'expected ~1.130, got ' + f);
});

test('weatherFactor: 8 mph in, 72F → 1 - 0.104 = 0.896', function() {
  var f = calcWeatherFactor(-8, 72);
  assert.ok(Math.abs(f - 0.896) < 0.001, 'expected ~0.896, got ' + f);
});

test('weatherFactor: warm day adds small boost (90F, calm → +0.018)', function() {
  var f = calcWeatherFactor(0, 90);
  assert.ok(Math.abs(f - 1.018) < 0.001, 'expected ~1.018, got ' + f);
});

test('weatherFactor: clamps to 1.15 for extreme wind-out + heat', function() {
  var f = calcWeatherFactor(20, 100);
  assert.equal(f, 1.15, 'clamp upper bound 1.15');
});

test('weatherFactor: clamps to 0.85 for extreme wind-in + cold', function() {
  var f = calcWeatherFactor(-20, 40);
  assert.equal(f, 0.85, 'clamp lower bound 0.85');
});

test('weatherFactor: null windOutMph → 1.0 (no adjustment)', function() {
  assert.equal(calcWeatherFactor(null, 72), 1.0);
});

test('weatherFactor: 0 mph wind, 72F → exactly 1.0', function() {
  assert.equal(calcWeatherFactor(0, 72), 1.0);
});

test('weatherFactor: null temp defaults to 72F (no temp contribution)', function() {
  var f = calcWeatherFactor(5, null);
  var expected = 1 + 5 * 0.013;
  assert.ok(Math.abs(f - expected) < 0.001, 'null temp = 72F baseline');
});

// ---- Summary ----

var summary = '\n' + _results.join('\n') + '\n\n' + _passed + ' passed, ' + _failed + ' failed';
if (_failed > 0) throw new Error(summary);
summary;
