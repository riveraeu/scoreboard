// Simulation functions and park factor constants.
// Pure math — no external dependencies, no imports needed.

// SO park factors from FanGraphs 2024 SO column (multi-year rolling avg, scale: 1.00 = neutral).
// Source: fangraphs.com/tools/guts?type=pf — SO column (season=2024).
export const PARK_KFACTOR = {
  MIL: 1.04, // FG: 103.73
  SEA: 1.04, // FG: 103.59
  SD:  1.02, // FG: 102.33
  TB:  1.02, // FG: 102.02
  ATL: 1.02, // FG: 102.05
  LAA: 1.02, // FG: 101.96
  HOU: 1.02, // FG: 101.73
  CIN: 1.01, // FG: 101.38
  NYM: 1.01, // FG: 101.17
  CHC: 1.01, // FG: 101.06
  CLE: 1.01, // FG: 100.75
  TEX: 1.01, // FG: 100.53
  PHI: 1.01, // FG: 100.54
  ATH: 1.00, // FG: 100.31
  MIA: 1.00, // FG: 100.31
  TOR: 1.00, // FG: 100.10
  NYY: 1.00, // FG: 100.01
  MIN: 1.00, // FG: 100.01
  LAD: 1.00, // FG:  99.83
  CWS: 0.99, // FG:  99.23
  ARI: 0.99, // FG:  99.21 (humidor since 2022)
  BAL: 0.99, // FG:  98.56
  WSH: 0.98, // FG:  98.48
  DET: 0.98, // FG:  98.07
  SF:  0.98, // FG:  97.71
  BOS: 0.98, // FG:  97.63
  STL: 0.97, // FG:  97.27
  PIT: 0.97, // FG:  96.98
  KC:  0.97, // FG:  96.75
  COL: 0.96, // FG:  96.49
  OAK: 1.00, // legacy fallback (team now ATH)
};

export const PARK_HITFACTOR = {
  COL: 1.14,
  CIN: 1.08,
  BOS: 1.07,
  MIL: 1.06,
  TEX: 1.05,
  NYY: 1.03,
  PHI: 1.03,
  KC: 1.02,
  BAL: 1.01,
  ARI: 1.01,
  ATL: 1,
  CHC: 1,
  WSH: 1,
  MIA: 0.99,
  STL: 0.99,
  MIN: 0.98,
  HOU: 0.98,
  CLE: 0.97,
  LAD: 0.97,
  DET: 0.97,
  NYM: 0.96,
  PIT: 0.96,
  CWS: 0.96,
  TB: 0.96,
  LAA: 0.95,
  ATH: 0.95,
  TOR: 0.95,
  SD: 0.94,
  SF: 0.94,
  SEA: 0.93
};

export const PARK_HRFACTOR = {
  COL: 1.35,
  CIN: 1.2,
  PHI: 1.15,
  BOS: 1.12,
  MIL: 1.1,
  TEX: 1.08,
  NYY: 1.07,
  BAL: 1.05,
  KC: 1.04,
  ATL: 1.03,
  CHC: 1.02,
  WSH: 1.01,
  ARI: 1,
  STL: 0.99,
  MIN: 0.98,
  HOU: 0.97,
  MIA: 0.97,
  LAD: 0.96,
  CLE: 0.95,
  DET: 0.95,
  NYM: 0.94,
  PIT: 0.93,
  CWS: 0.93,
  TB: 0.92,
  LAA: 0.91,
  ATH: 0.91,
  TOR: 0.91,
  SD: 0.89,
  SF: 0.89,
  SEA: 0.87
};

export function log5K(pitcherKPct, batterKPct, leagueKPct = 22.2) {
  const p = pitcherKPct / 100, b = batterKPct / 100, l = leagueKPct / 100;
  const num = p * b / l;
  return num / (num + (1 - p) * (1 - b) / (1 - l));
}

export function poissonCDF(k, lambda) {
  let sum = 0, term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) {
    sum += term;
    term *= lambda / (i + 1);
  }
  return Math.min(1, sum);
}

export function log5HitRate(log5Avg, threshold, avgBF = 26) {
  const lambda = log5Avg / 100 * avgBF;
  return (1 - poissonCDF(threshold - 1, lambda)) * 100;
}

// Monte Carlo PA-level simulation: runs nSim games and returns the full K-count distribution
// (array of length nSim with Ks per game). Use kDistPct(dist, t) to get P(Ks >= t).
// Running once per pitcher and sharing the distribution guarantees monotonicity across thresholds.
export function simulateKsDist(orderedKPcts, pitcherKPct, parkFactor = 1, nSim = 5000, totalPA = 24) {
  const n = orderedKPcts.length;
  if (!n || pitcherKPct == null) return null;
  const base = Math.floor(totalPA / n);
  const extras = totalPA % n;
  const paArr = orderedKPcts.map((_, i) => base + (i < extras ? 1 : 0));
  const adjProbs = orderedKPcts.map(b => Math.min(0.95, log5K(pitcherKPct, b * 100) * parkFactor));
  const dist = new Int16Array(nSim);
  for (let sim = 0; sim < nSim; sim++) {
    let ks = 0;
    for (let i = 0; i < n; i++) {
      const p = adjProbs[i], pa = paArr[i];
      for (let j = 0; j < pa; j++) { if (Math.random() < p) ks++; }
    }
    dist[sim] = ks;
  }
  return dist;
}

export function kDistPct(dist, threshold) {
  if (!dist) return null;
  let hits = 0;
  for (let i = 0; i < dist.length; i++) { if (dist[i] >= threshold) hits++; }
  return parseFloat((hits / dist.length * 100).toFixed(1));
}

// Legacy single-threshold wrapper (kept for reference, unused in main loop)
export function simulateKs(orderedKPcts, pitcherKPct, threshold, parkFactor = 1, nSim = 5000, totalPA = 24) {
  const dist = simulateKsDist(orderedKPcts, pitcherKPct, parkFactor, nSim, totalPA);
  return kDistPct(dist, threshold);
}

// NBA Monte Carlo: build a shared Float32Array of simulated per-game values.
// All thresholds for the same player+stat query the same distribution →
// guarantees P(X≥3) ≥ P(X≥4) ≥ P(X≥5) by construction.
export function buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim = 5000) {
  if (gameValues.length < 5) return null;
  // Mean from recent 10 (recency), std from full season (stability)
  const recentSlice = gameValues.slice(0, Math.min(10, gameValues.length));
  const meanRecent = recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length;
  const meanAll = gameValues.reduce((a, b) => a + b, 0) / gameValues.length;
  const variance = gameValues.reduce((a, b) => a + (b - meanAll) ** 2, 0) / gameValues.length;
  const std = Math.sqrt(variance);
  if (meanRecent <= 0 || std < 0.5) return null;
  // Apply matchup/context adjustments to mean
  let adjMean = meanRecent;
  if (dvpFactor != null) adjMean *= dvpFactor;
  if (paceAdj != null) adjMean *= (1 + Math.min(Math.max(paceAdj, -15), 15) * 0.002);
  if (isB2B) adjMean *= 0.93;
  adjMean = Math.max(0, adjMean);
  // Box-Muller normal — store raw values so any threshold can be queried
  const dist = new Float32Array(nSim);
  for (let i = 0; i < nSim; i++) {
    const u1 = Math.random() + 1e-10;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    dist[i] = adjMean + std * z;
  }
  return dist;
}

export function nbaDistPct(dist, threshold) {
  if (!dist) return null;
  let hits = 0;
  for (let i = 0; i < dist.length; i++) { if (dist[i] >= threshold) hits++; }
  return parseFloat((hits / dist.length * 100).toFixed(1));
}

export function simulateHits(batterBA, pitcherBAA, parkFactor, threshold, nSim = 10000) {
  const leagueBA = 0.248;
  const hitProb = Math.min(0.95, Math.max(0.01, (batterBA * pitcherBAA / leagueBA) * parkFactor));
  let hits = 0;
  for (let sim = 0; sim < nSim; sim++) {
    // Spots 1-4 average ~4 PA per game
    let count = 0;
    for (let j = 0; j < 4; j++) {
      if (Math.random() < hitProb) count++;
    }
    if (count >= threshold) hits++;
  }
  return parseFloat((hits / nSim * 100).toFixed(1));
}

export function decimalOdds(americanOdds) {
  return americanOdds >= 0 ? americanOdds / 100 + 1 : 100 / Math.abs(americanOdds) + 1;
}

export function kellyFraction(truePct, americanOdds) {
  const p = truePct / 100;
  const b = decimalOdds(americanOdds) - 1;
  return Math.max(0, parseFloat(((p * b - (1 - p)) / b).toFixed(4)));
}

export function evPerUnit(truePct, americanOdds) {
  const p = truePct / 100;
  const b = decimalOdds(americanOdds) - 1;
  return parseFloat((p * b - (1 - p)).toFixed(4));
}

// ─── Game Total Simulation ────────────────────────────────────────────────────

// Park run factors (FanGraphs multi-year rolling avg, "R" column, scale: 1.00 = neutral).
export const PARK_RUNFACTOR = {
  COL: 1.15, CIN: 1.09, BOS: 1.08, MIL: 1.07, TEX: 1.06,
  PHI: 1.05, NYY: 1.04, BAL: 1.03, ARI: 1.03, CHC: 1.02,
  KC:  1.02, ATL: 1.01, WSH: 1.00, NYM: 0.99, STL: 0.99,
  MIA: 0.99, MIN: 0.98, DET: 0.98, HOU: 0.98, LAD: 0.97,
  CLE: 0.96, CWS: 0.96, TB:  0.96, ATH: 0.95, LAA: 0.95,
  TOR: 0.95, PIT: 0.95, SD:  0.94, SF:  0.94, SEA: 0.93,
  OAK: 1.00, // legacy fallback
};

// Knuth Poisson sampler — internal helper, not exported.
function poissonSample(lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-Math.min(lambda, 100)); // cap to avoid underflow
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

// MLB combined runs distribution: two independent Poisson teams summed.
// homeLambda/awayLambda = expected runs per team (season RPG adjusted by pitcher ERA & park).
// Returns Int16Array of nSim combined run totals; query with totalDistPct(dist, threshold).
export function simulateMLBTotalDist(homeLambda, awayLambda, nSim = 10000) {
  if (!homeLambda || !awayLambda || homeLambda <= 0 || awayLambda <= 0) return null;
  const dist = new Int16Array(nSim);
  for (let i = 0; i < nSim; i++) {
    dist[i] = poissonSample(homeLambda) + poissonSample(awayLambda);
  }
  return dist;
}

// NBA combined points distribution: two independent normals summed.
// homeMean/awayMean = expected points per team; std defaults to 11 pts/team (historical).
// Returns Int16Array of nSim combined point totals; query with totalDistPct(dist, threshold).
export function simulateNBATotalDist(homeMean, awayMean, homeStd = 11, awayStd = 11, nSim = 10000) {
  if (!homeMean || !awayMean || homeMean <= 0 || awayMean <= 0) return null;
  const dist = new Int16Array(nSim);
  for (let i = 0; i < nSim; i++) {
    const u1h = Math.random() + 1e-10, u2h = Math.random();
    const u1a = Math.random() + 1e-10, u2a = Math.random();
    const zh = Math.sqrt(-2 * Math.log(u1h)) * Math.cos(2 * Math.PI * u2h);
    const za = Math.sqrt(-2 * Math.log(u1a)) * Math.cos(2 * Math.PI * u2a);
    const total = (homeMean + homeStd * zh) + (awayMean + awayStd * za);
    dist[i] = Math.round(Math.max(0, total));
  }
  return dist;
}

// NHL combined goals distribution: two independent Poisson teams summed.
// homeLambda/awayLambda = expected goals per team (season GPG adjusted by opp GAA & home adv).
// Returns Int16Array of nSim combined goal totals; query with totalDistPct(dist, threshold).
export function simulateNHLTotalDist(homeLambda, awayLambda, nSim = 10000) {
  if (!homeLambda || !awayLambda || homeLambda <= 0 || awayLambda <= 0) return null;
  const dist = new Int16Array(nSim);
  for (let i = 0; i < nSim; i++) {
    dist[i] = poissonSample(homeLambda) + poissonSample(awayLambda);
  }
  return dist;
}

// Query a game total distribution at any threshold → P(total >= threshold).
// Same interface as nbaDistPct. Monotonicity guaranteed when same dist is reused per game.
export function totalDistPct(dist, threshold) {
  if (!dist) return null;
  let hits = 0;
  for (let i = 0; i < dist.length; i++) { if (dist[i] >= threshold) hits++; }
  return parseFloat((hits / dist.length * 100).toFixed(1));
}
