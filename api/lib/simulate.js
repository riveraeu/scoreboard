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

// Umpire K-rate factors: normalized to league avg (22.2% K rate, scale: 1.00 = neutral).
// Source: UmpScorecards / Baseball Savant 2022–2024 multi-year averages.
// Unlisted umpires default to 1.0. Names stored in ASCII (accent-stripped for lookup).
export const UMPIRE_KFACTOR = {
  "Ron Kulpa":          1.12, // consistently widest zone in MLB
  "CB Bucknor":         1.10,
  "Alan Porter":        1.08,
  "Phil Cuzzi":         1.07,
  "Pat Hoberg":         1.06,
  "Vic Carapazza":      1.06,
  "Mike Estabrook":     1.05,
  "Marvin Hudson":      1.05,
  "Shane Livensparger": 1.04,
  "Junior Valentine":   1.04,
  "Jordan Baker":       1.03,
  "Jim Reynolds":       1.03,
  "Chris Segal":        1.02,
  "Bill Miller":        1.01,
  "Andy Fletcher":      1.01,
  "Adam Hamari":        1.01,
  "Mark Ripperger":     1.01,
  "Todd Tichenor":      1.00,
  "Brian Gorman":       1.00,
  "Sam Holbrook":       1.00,
  "Jeff Nelson":        1.00,
  "Tom Hallion":        1.00,
  "Paul Emmel":         1.00,
  "Dan Iassogna":       1.00,
  "Tripp Gibson":       1.00,
  "Mark Carlson":       0.99,
  "Doug Eddings":       0.99,
  "Brian Knight":       0.99,
  "Rob Drake":          0.99,
  "David Rackley":      0.99,
  "John Tumpane":       0.98,
  "Angel Hernandez":    0.98, // accent-stripped from Ángel Hernández
  "Lance Barksdale":    0.98,
  "Cory Blaser":        0.98,
  "Gabe Morales":       0.98,
  "Chad Fairchild":     0.98,
  "Mike Winters":       0.97,
  "Laz Diaz":           0.97,
  "Roberto Ortiz":      0.97,
  "Mike Muchlinski":    0.97,
  "Jeremie Rehak":      0.97,
  "Nic Lentz":          0.96,
  "Ryan Additon":       0.95,
  "Chris Conroy":       0.94,
  "Jerry Layne":        0.93,
  "Ryan Blakney":       0.92,
  "Lance Barrett":      0.89, // notoriously tight zone
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

// Inverse-CDF: find Poisson rate λ such that P(X >= threshold) = targetProb.
// Used to translate observed seasonHitRate into an equivalent lambda for blending.
// Bisection in [0.05, 25]; ~30 iters → ε ≈ 1e-7. Returns null when target unreachable.
export function lambdaForPoissonTail(threshold, targetProb) {
  if (targetProb == null || targetProb <= 0 || targetProb >= 1 || threshold == null || threshold < 1) return null;
  const tailAt = (lam) => 1 - poissonCDF(threshold - 1, lam);
  let lo = 0.05, hi = 25;
  if (tailAt(lo) > targetProb) return lo;
  if (tailAt(hi) < targetProb) return hi;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (tailAt(mid) < targetProb) lo = mid; else hi = mid;
  }
  return parseFloat(((lo + hi) / 2).toFixed(3));
}

// Gamma(shape, scale) sampler via Marsaglia & Tsang. Shape boosting for shape < 1.
function gammaSample(shape, scale) {
  if (shape < 1) {
    return gammaSample(shape + 1, scale) * Math.pow(Math.random() + 1e-12, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let z, v;
    do {
      const u1 = Math.random() + 1e-10, u2 = Math.random();
      z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * z;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * z * z * z * z) return d * v * scale;
    if (Math.log(u) < 0.5 * z * z + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

// Negative Binomial sampler via Poisson-Gamma mixture. Mean = mu, variance = mu + mu²/r.
// As r → ∞, NegBin → Poisson. r is the dispersion parameter (lower r → fatter tails).
// Returns an integer count.
export function negBinSample(mu, r) {
  if (mu <= 0) return 0;
  if (!r || r >= 100) return poissonSample(mu);
  const lam = gammaSample(r, mu / r);
  return poissonSample(lam);
}

// NegBin CDF: P(X <= k | mean = mu, dispersion = r). Computes pmf iteratively in log space
// to avoid overflow at moderate mu. Falls back to Poisson when r is missing or large.
export function negBinCDF(k, mu, r) {
  if (k < 0 || mu == null || mu <= 0) return 0;
  if (!r || r >= 100) return poissonCDF(k, mu);
  const p = r / (r + mu);
  const log1mP = Math.log(1 - p);
  let logPmf = r * Math.log(p);
  let sum = Math.exp(logPmf);
  for (let i = 1; i <= k; i++) {
    logPmf += Math.log((i + r - 1) / i) + log1mP;
    sum += Math.exp(logPmf);
  }
  return Math.min(1, sum);
}

// Inverse: find μ such that P(X >= threshold | μ, r) = targetProb under NegBin.
// Mirror of lambdaForPoissonTail; used to translate observed seasonHitRate to an
// implied lambda that's consistent with the NegBin variance assumption. Bisection.
export function muForNegBinTail(threshold, targetProb, r) {
  if (targetProb == null || targetProb <= 0 || targetProb >= 1 || threshold == null || threshold < 1) return null;
  if (!r || r >= 100) return lambdaForPoissonTail(threshold, targetProb);
  const tailAt = (mu) => 1 - negBinCDF(threshold - 1, mu, r);
  let lo = 0.05, hi = 25;
  if (tailAt(lo) > targetProb) return lo;
  if (tailAt(hi) < targetProb) return hi;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (tailAt(mid) < targetProb) lo = mid; else hi = mid;
  }
  return parseFloat(((lo + hi) / 2).toFixed(3));
}

// Standard normal inverse CDF (Acklam approximation, ~1e-9 max error). Internal.
function _normInv(p) {
  if (p <= 0 || p >= 1) return null;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p <= ph) {
    const q = p - 0.5, r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

// Inverse-CDF: find Normal mean μ such that P(N(μ, std) >= threshold) = targetProb.
// Closed form: μ = threshold - std * Φ^-1(1 - targetProb).
export function meanForNormalTail(threshold, targetProb, std) {
  if (targetProb == null || targetProb <= 0 || targetProb >= 1 || std == null || std <= 0) return null;
  const z = _normInv(1 - targetProb);
  if (z == null) return null;
  return parseFloat((threshold - std * z).toFixed(3));
}

// Standard normal CDF via erf approximation (Abramowitz & Stegun 7.1.26, ~1.5e-7 max error).
// Used to compute truePct from a (mean, std) pair without re-running the sim.
export function normCDF(x, mean = 0, std = 1) {
  if (std <= 0) return null;
  const z = (x - mean) / (std * Math.SQRT2);
  // erf approximation
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erfZ = z >= 0 ? y : -y;
  return 0.5 * (1 + erfZ);
}

// K% multiplier applied to BF 19+ (third time through the order).
// League-average decline: ~10–15% drop in K% on 3rd pass due to batter familiarity.
const TTO_DECAY_FACTOR = 0.88;

// Between-game pitcher-form variance (added 2026-06-01 from the 6/1 calibration).
// The per-batter Bernoulli loop only captures within-game randomness — it treats the
// pitcher's true K ability as fixed every night. Real starters have meaningful game-to-game
// quality swings (sharp vs flat) on top of the binomial, so the point model under-disperses
// the K-count distribution and over-projects tail (over) thresholds — the 6/1 audit showed
// strikeouts Δ −17.9 (n=38), concentrated in the 80–90% truePct band (act ~54%). Each sim
// draws one mean-1 lognormal form multiplier and scales every batter's K prob by it: this
// widens the distribution (pulls extreme truePct toward 50%) while preserving the mean
// (E[formMult] = 1, so E[p·formMult] = p). σ is the tunable knob — start conservative and
// retune against realized K-residual variance at n≥40. See [[project-calibration-audit-2026-06-01]].
const K_FORM_SIGMA = 0.22;

// Monte Carlo PA-level simulation: runs nSim games and returns the full K-count distribution
// (array of length nSim with Ks per game). Use kDistPct(dist, t) to get P(Ks >= t).
// Running once per pitcher and sharing the distribution guarantees monotonicity across thresholds.
// earlyExitProb: fraction of trials where the pitcher is pulled early (BF = rand[10,15]).
//   Used for blowout hook — heavy underdogs have a non-trivial chance of being chased in 3rd inning.
// stdBF: standard deviation of batters faced per start. When > 0, each trial samples trialPA from
//   Normal(totalPA, stdBF), clamped [10,27]. Blowout hook takes precedence when both are set.
//   stdBF = 0 (default) keeps deterministic totalPA — no variance injected.
// PA loop cycles the batting order (bf % n) until trialPA (fixed 2026-06-10). The old version
//   pre-allocated exactly totalPA across the 9 batters consecutively, which (a) silently truncated
//   upside trialPA draws — stdBF acted as a downside-only haircut, biasing K means ~0.5 low and
//   over truePcts ~3pts low on stdBF>0 plays — and (b) made early exits cut the bottom of the
//   order entirely instead of cutting the later trips through the order.
export function simulateKsDist(orderedKPcts, pitcherKPct, parkFactor = 1, nSim = 5000, totalPA = 24, earlyExitProb = 0, stdBF = 0) {
  const n = orderedKPcts.length;
  if (!n || pitcherKPct == null) return null;
  const adjProbs = orderedKPcts.map(b => Math.min(0.95, log5K(pitcherKPct, b * 100) * parkFactor));
  // Scoped Box-Muller cache — inside function to avoid module-level state (race conditions on
  // concurrent requests). Generates two normals per call, saves the spare for the next invocation,
  // halving Math.log + Math.cos calls vs the single-variable form.
  let _bmSpare = false, _bmZ1 = 0;
  const randNorm = (mean, std) => {
    if (_bmSpare) { _bmSpare = false; return mean + std * _bmZ1; }
    const u1 = 1.0 - Math.random(), u2 = Math.random();
    const r = Math.sqrt(-2.0 * Math.log(u1));
    _bmZ1 = r * Math.sin(2.0 * Math.PI * u2);
    _bmSpare = true;
    return mean + std * r * Math.cos(2.0 * Math.PI * u2);
  };
  const dist = new Int16Array(nSim);
  for (let sim = 0; sim < nSim; sim++) {
    let ks = 0, bf = 0;
    let trialPA = totalPA;
    if (earlyExitProb > 0 && Math.random() < earlyExitProb) {
      trialPA = 10 + Math.floor(Math.random() * 6);
    } else if (stdBF > 0) {
      trialPA = Math.min(27, Math.max(10, Math.round(randNorm(totalPA, stdBF))));
    }
    // One mean-1 lognormal form draw per game: exp(σ·Z − σ²/2) so E[formMult] = 1 (mean
    // preserved). Scales every batter's K prob this sim → between-game quality variance.
    const formMult = Math.exp(K_FORM_SIGMA * randNorm(0, 1) - 0.5 * K_FORM_SIGMA * K_FORM_SIGMA);
    for (; bf < trialPA; bf++) {
      const p = Math.min(0.95, adjProbs[bf % n] * formMult * (bf >= 18 ? TTO_DECAY_FACTOR : 1));
      if (Math.random() < p) ks++;
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

// NBA Monte Carlo: build a shared Float32Array of simulated per-game values.
// All thresholds for the same player+stat query the same distribution →
// guarantees P(X≥3) ≥ P(X≥4) ≥ P(X≥5) by construction.
// paceAdj (linear delta from league avg) is the legacy NHL-shots-against pathway and
// still feeds NHL props. paceFactor (geometric-mean ratio) is the NBA/WNBA pathway
// added 2026-05-25 — the previous +0.002-per-pace-unit linear bump capped at ±3% volume
// effect, way under the ~±10% possession swings real NBA matchups exhibit.
export function buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim = 5000, miscAdj = 1.0, paceFactor = null, recentVals = null) {
  if (gameValues.length < 5) return null;
  // Mean from recent 10 with **exponential-decay recency weighting** (added 2026-05-26 same
  // day as the playoff filter + Bayesian shrinkage). Flat-10 averaging treats a hot game from
  // 8 days ago the same as last night's cold game; exp-decay with HALF_LIFE games half-weights
  // a game from HALF_LIFE games back, surfacing recent regime shifts (slumps, hot streaks).
  // HALF_LIFE=5: most-recent game weight 1.0, 5 games back 0.50, 10 games back 0.25. Std/var
  // still come from the full sample for stability — exp-decaying variance over-fits to noise.
  //
  // Combined with the existing Bayesian playoff shrinkage: each slice (playoff-only and
  // mixed-flat-10) is collapsed to a weighted mean first, then the playoff/mixed means are
  // blended with `w = n_playoff / (n_playoff + 10)`.
  const HALF_LIFE = 5;
  const _DECAY = Math.log(2) / HALF_LIFE;
  const _weightedMean = (vals) => {
    const n = Math.min(10, vals.length);
    let sumW = 0, sumWV = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.exp(-_DECAY * i); // i=0 = most recent
      sumW += w;
      sumWV += w * vals[i];
    }
    return sumWV / sumW;
  };
  const PLAYOFF_PRIOR_N = 10;
  const meanMixed = _weightedMean(gameValues);
  let meanRecent;
  if (recentVals && recentVals.length >= 5) {
    const meanPlayoff = _weightedMean(recentVals);
    const w = recentVals.length / (recentVals.length + PLAYOFF_PRIOR_N);
    meanRecent = meanPlayoff * w + meanMixed * (1 - w);
  } else {
    meanRecent = meanMixed;
  }
  const meanAll = gameValues.reduce((a, b) => a + b, 0) / gameValues.length;
  const variance = gameValues.reduce((a, b) => a + (b - meanAll) ** 2, 0) / gameValues.length;
  const std = Math.sqrt(variance);
  if (meanRecent <= 0 || std < 0.5) return null;
  // Apply matchup/context adjustments to mean
  let adjMean = meanRecent;
  if (dvpFactor != null) adjMean *= dvpFactor;
  if (paceAdj != null) adjMean *= (1 + Math.min(Math.max(paceAdj, -15), 15) * 0.002);
  if (paceFactor != null) adjMean *= Math.max(0.92, Math.min(1.08, paceFactor));
  if (isB2B) adjMean *= 0.93;
  if (miscAdj !== 1.0) adjMean *= miscAdj; // blowout/home-away/injury/PPTOI adj
  adjMean = Math.max(0, adjMean);
  // Box-Muller normal — store raw values so any threshold can be queried
  const dist = new Float32Array(nSim);
  for (let i = 0; i < nSim; i++) {
    const u1 = Math.random() + 1e-10;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    dist[i] = Math.max(0, adjMean + std * z);
  }
  return dist;
}

export function nbaDistPct(dist, threshold) {
  if (!dist) return null;
  let hits = 0;
  for (let i = 0; i < dist.length; i++) { if (dist[i] >= threshold) hits++; }
  return parseFloat((hits / dist.length * 100).toFixed(1));
}

// Exact binomial tail P(X >= threshold) for the MLB hits prop model (2026-06-11).
// Replaces the MC simulateHits (fixed 4 PA, no lineup-spot awareness): with a known
// per-AB hit prob and AB count the binomial tail is exact, deterministic, and monotonic
// across alt thresholds by construction — no nSim noise, no per-player dist cache needed.
// n may be fractional (expected AB from lineup spot); interpolates linearly between
// floor(n) and ceil(n) tails. Returns percentage (0-100), or null on bad inputs.
export function binomTailPct(n, p, threshold) {
  if (n == null || p == null || !(n > 0) || !(p > 0)) return null;
  const pc = Math.min(0.99, p);
  const t = Math.ceil(threshold); // "1+ hits" → 1; "1.5" → 2
  const tail = (ni) => {
    if (t <= 0) return 1;
    if (ni < t) return 0;
    // 1 - CDF(t-1): accumulate pmf terms via the multiplicative recurrence
    let term = Math.pow(1 - pc, ni); // k = 0
    let cdf = term;
    for (let k = 1; k < t; k++) {
      term *= ((ni - k + 1) / k) * (pc / (1 - pc));
      cdf += term;
    }
    return Math.max(0, 1 - cdf);
  };
  const n0 = Math.floor(n), frac = n - n0;
  const pr = frac > 1e-9 ? (1 - frac) * tail(n0) + frac * tail(n0 + 1) : tail(n0);
  return parseFloat((pr * 100).toFixed(1));
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

// MLB combined runs distribution: two independent NegBin teams summed (Poisson if r is
// null/large for backward compat). homeLambda/awayLambda = expected runs per team (season
// RPG adjusted by pitcher ERA & park). r = NegBin dispersion (league-wide pooled MoM fit
// from per-team game-by-game residuals, typically 5-10 for MLB). Real MLB game totals are
// ~2× overdispersed vs Poisson; NegBin restores the fat-tail behavior so far-from-line
// alt thresholds aren't systematically overconfident. Returns Int16Array of nSim combined
// run totals; query with totalDistPct(dist, threshold).
export function simulateMLBTotalDist(homeLambda, awayLambda, r = null, nSim = 10000) {
  if (!homeLambda || !awayLambda || homeLambda <= 0 || awayLambda <= 0) return null;
  const dist = new Int16Array(nSim);
  for (let i = 0; i < nSim; i++) {
    dist[i] = negBinSample(homeLambda, r) + negBinSample(awayLambda, r);
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

// NHL combined goals distribution: two independent NegBin teams summed (Poisson if r is null).
// homeLambda/awayLambda = expected goals per team (season GPG adjusted by opp GAA & home adv).
// r = NegBin dispersion fit from per-team schedule residuals; null falls back to Poisson.
// Returns Int16Array of nSim combined goal totals; query with totalDistPct(dist, threshold).
export function simulateNHLTotalDist(homeLambda, awayLambda, r = null, nSim = 10000) {
  if (!homeLambda || !awayLambda || homeLambda <= 0 || awayLambda <= 0) return null;
  const dist = new Int16Array(nSim);
  for (let i = 0; i < nSim; i++) {
    dist[i] = (r != null ? negBinSample(homeLambda, r) : poissonSample(homeLambda)) +
              (r != null ? negBinSample(awayLambda, r) : poissonSample(awayLambda));
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

// MLB joint per-team distributions for ML/spread. Same NegBin draws as simulateMLBTotalDist
// but exposes home[] and away[] separately so we can count P(home > away) for moneyline and
// P(home - away > line) for spread. r matches the totals sim so ML/spread/total share the
// same per-team variance assumption.
export function simulateMLBJoint(homeLambda, awayLambda, r = null, nSim = 10000) {
  if (!homeLambda || !awayLambda || homeLambda <= 0 || awayLambda <= 0) return null;
  const home = new Int16Array(nSim);
  const away = new Int16Array(nSim);
  for (let i = 0; i < nSim; i++) {
    home[i] = negBinSample(homeLambda, r);
    away[i] = negBinSample(awayLambda, r);
  }
  return { home, away };
}

// NBA joint per-team distributions for ML/spread. Independent Normal draws per team via
// Box-Muller (matches simulateNBATotalDist's per-team treatment). homeMean/awayMean = expected
// points per team; per-team stddev defaults to 11 (matches simulateNBATotalDist default). Each
// per-team draw clamped at 0 before rounding. Returns home/away Int16Arrays sized nSim.
// Same shape as simulateMLBJoint so mlPctFromJoint/spreadPctFromJoint accept either.
export function simulateNBAJoint(homeMean, awayMean, homeStd = 11, awayStd = 11, nSim = 10000) {
  if (!homeMean || !awayMean || homeMean <= 0 || awayMean <= 0) return null;
  const home = new Int16Array(nSim);
  const away = new Int16Array(nSim);
  for (let i = 0; i < nSim; i++) {
    const u1h = Math.random() + 1e-10, u2h = Math.random();
    const u1a = Math.random() + 1e-10, u2a = Math.random();
    const zh = Math.sqrt(-2 * Math.log(u1h)) * Math.cos(2 * Math.PI * u2h);
    const za = Math.sqrt(-2 * Math.log(u1a)) * Math.cos(2 * Math.PI * u2a);
    home[i] = Math.round(Math.max(0, homeMean + homeStd * zh));
    away[i] = Math.round(Math.max(0, awayMean + awayStd * za));
  }
  return { home, away };
}

// P(home wins) over non-tie sims. Real MLB resolves in extras, so we drop tied sims rather
// than splitting them 50/50 — the Poisson model has no notion of extra-inning scoring and
// dropping ties is the cleanest proxy. NBA/WNBA ties are theoretically possible from the
// rounded-Normal draws but vanishingly rare (~0.5% of sims) and reality always resolves in
// OT, so dropping is also the right call there. Returns null if both arrays are missing or
// every sim tied (shouldn't happen with realistic lambdas).
export function mlPctFromJoint(home, away) {
  if (!home || !away || home.length !== away.length) return null;
  let wins = 0, decided = 0;
  for (let i = 0; i < home.length; i++) {
    if (home[i] === away[i]) continue;
    decided++;
    if (home[i] > away[i]) wins++;
  }
  if (decided === 0) return null;
  return parseFloat((wins / decided * 100).toFixed(1));
}

// 3-way joint sim reduction with ties NOT dropped. Used for any Kalshi market where a TIE
// outcome is a real settlement option — MLB First-5-Innings ML (~15-17% tie rate), NBA/WNBA
// 1H and 2H winner markets (~3-5% tie rate). Distinct from mlPctFromJoint which drops ties
// since full-game MLB/NBA resolve in extras/OT. side ∈ {"home","away","tie"}. Returns null
// on bad inputs.
export function joint3WayPct(home, away, side) {
  if (!home || !away || home.length !== away.length) return null;
  const N = home.length;
  let hits = 0;
  if (side === "home") {
    for (let i = 0; i < N; i++) if (home[i] > away[i]) hits++;
  } else if (side === "away") {
    for (let i = 0; i < N; i++) if (away[i] > home[i]) hits++;
  } else if (side === "tie") {
    for (let i = 0; i < N; i++) if (home[i] === away[i]) hits++;
  } else {
    return null;
  }
  return parseFloat((hits / N * 100).toFixed(1));
}

// P(`side` wins by more than `line` runs) from the joint Poisson draws. Used for MLB run-line /
// spread markets where Kalshi prices "Team X wins by over Y runs" (half-integer Y). Caller
// passes the side that's on the win-by-margin question; the YES probability is returned. NO is
// the simple complement (1 - YES) since half-lines have no pushes. Returns null on bad inputs
// or non-half-integer line (integer lines would require push handling we don't model in v1).
export function spreadPctFromJoint(home, away, line, side) {
  if (!home || !away || home.length !== away.length) return null;
  if (line == null || line <= 0) return null;
  if (line === Math.floor(line)) return null; // integer line → pushes possible; not supported
  if (side !== "home" && side !== "away") return null;
  let wins = 0;
  const N = home.length;
  if (side === "home") {
    for (let i = 0; i < N; i++) if (home[i] - away[i] > line) wins++;
  } else {
    for (let i = 0; i < N; i++) if (away[i] - home[i] > line) wins++;
  }
  return parseFloat((wins / N * 100).toFixed(1));
}

// Single-team runs/goals distribution. Uses NegBin when r is provided (MLB), Poisson
// otherwise (NHL, backward compat). MLB per-team runs are overdispersed vs Poisson at the
// same r as game totals — pass the same _mlbDispR that simulateMLBTotalDist receives.
export function simulateTeamTotalDist(lambda, nSim = 10000, r = null) {
  if (!lambda || lambda <= 0) return null;
  const dist = new Int16Array(nSim);
  for (let i = 0; i < nSim; i++) {
    dist[i] = r != null ? negBinSample(lambda, r) : poissonSample(lambda);
  }
  return dist;
}

// Single-team points distribution (Normal): for NBA team totals.
// mean = expected points for this team; std defaults to 11.
export function simulateTeamPtsDist(mean, std = 11, nSim = 10000) {
  if (!mean || mean <= 0) return null;
  const dist = new Int16Array(nSim);
  for (let i = 0; i < nSim; i++) {
    const u1 = Math.random() + 1e-10;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    dist[i] = Math.round(Math.max(0, mean + std * z));
  }
  return dist;
}
