// Simulation functions and park factor constants.
// Pure math — no external dependencies, no imports needed.

export const PARK_KFACTOR = {
  SEA: 1.02,
  NYM: 1.01,
  STL: 1.01,
  ARI: 1.01,
  TB: 1.01,
  MIL: 1.01,
  SF: 1.01,
  HOU: 1,
  BOS: 1,
  NYY: 1,
  ATL: 1,
  MIN: 1,
  DET: 1,
  CWS: 1,
  LAD: 1,
  MIA: 1,
  PIT: 1,
  CLE: 1,
  OAK: 1,
  KC: 1,
  BAL: 0.99,
  CHC: 0.99,
  SD: 0.99,
  PHI: 0.99,
  WSH: 0.99,
  LAA: 0.99,
  TEX: 0.99,
  CIN: 0.99,
  ATH: 0.99,
  COL: 0.98
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
