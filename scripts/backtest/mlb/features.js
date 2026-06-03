// Point-in-time feature reconstruction for MLB backtest.
// All functions return stats as-they-would-have-been-known on game date — no future leakage.

const LEAGUE_K_PCT    = 0.222;
const LEAGUE_ERA      = 4.20;
const LEAGUE_WHIP     = 1.30;
const LEAGUE_FIP      = 4.20;
const LEAGUE_OPS      = 0.720;
const LEAGUE_BA       = 0.248;
const LEAGUE_RPG      = 4.55; // runs per team per game, 2022-2024 avg
const FIP_CONST       = 3.10;

const parseIP = (v) => {
  if (v == null || v === "") return 0;
  const s = String(v);
  const dot = s.indexOf(".");
  if (dot < 0) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }
  const whole = parseInt(s.slice(0, dot), 10) || 0;
  const frac = s.slice(dot + 1);
  return whole + (frac === "1" ? 1 / 3 : frac === "2" ? 2 / 3 : 0);
};

const safeFIP = (s) => {
  if (!s || !s.ip || parseIP(s.ip) < 1) return null;
  const ip = parseIP(s.ip);
  const raw = ((13 * (s.homeRuns || 0)) + (3 * ((s.baseOnBalls || 0) + (s.hitByPitch || 0))) - (2 * (s.strikeOuts || 0))) / ip + FIP_CONST;
  return parseFloat(raw.toFixed(2));
};

// Two-step regression: 2-season blend → league-anchor shrink.
// Mirrors live model logic in mlb-pitchers.js _regressedRate.
function regressRate(val26, ip26, val25, ip25, gs26, lgMean, priorIP) {
  const has26 = val26 != null && ip26 >= 1;
  const has25 = val25 != null && ip25 >= 1;
  let blendedVal, blendedIp;
  if (has26 && has25) {
    const trust26 = Math.min(1, gs26 / 15);
    blendedVal = trust26 * val26 + (1 - trust26) * val25;
    blendedIp  = ip26 + (1 - trust26) * ip25;
  } else if (has26) {
    blendedVal = val26; blendedIp = ip26;
  } else if (has25) {
    blendedVal = val25; blendedIp = ip25;
  } else {
    return null;
  }
  return (blendedIp * blendedVal + priorIP * lgMean) / (blendedIp + priorIP);
}

// Cumulative pitcher stats from gamelog entries prior to gameDate (point-in-time).
function cumulativePriorStats(gameLogs, gameDate) {
  let so = 0, bf = 0, bb = 0, hbp = 0, hr = 0, ip = 0, h = 0, er = 0, gs = 0;
  const bfPerStart = [];
  for (const entry of gameLogs) {
    if (entry.date >= gameDate) break; // only prior starts
    if (!entry.stat) continue;
    const s = entry.stat;
    const thisIP  = parseIP(s.inningsPitched);
    const thisBF  = s.battersFaced || 0;
    so  += s.strikeOuts || 0;
    bf  += thisBF;
    bb  += s.baseOnBalls || 0;
    hbp += s.hitByPitch || 0;
    hr  += s.homeRuns || 0;
    ip  += thisIP;
    h   += s.hits || 0;
    er  += s.earnedRuns || 0;
    if ((s.gamesStarted || 0) > 0 || (s.inningsPitched && thisIP >= 3)) {
      gs++;
      if (thisBF > 0) bfPerStart.push(thisBF);
    }
  }
  const avgBF = bfPerStart.length > 0
    ? bfPerStart.reduce((a, b) => a + b, 0) / bfPerStart.length
    : null;
  const stdBF = bfPerStart.length > 2
    ? Math.sqrt(bfPerStart.reduce((s, v) => s + (v - avgBF) ** 2, 0) / (bfPerStart.length - 1))
    : null;
  const era  = ip > 0 ? (er / ip) * 9 : null;
  const whip = ip > 0 ? (h + bb) / ip : null;
  const fip  = safeFIP({ homeRuns: hr, baseOnBalls: bb, hitByPitch: hbp, strikeOuts: so, ip });
  const kPct = bf > 0 ? so / bf : null;
  return { so, bf, bb, hbp, hr, ip, h, er, gs, kPct, era, whip, fip, avgBF, stdBF };
}

// Reconstruct point-in-time pitcher stats with regression. Returns null if insufficient data.
export function pitcherStatsAsOf(pitcherId, gameDate, pitcherGamelogMap, pitcherPriorStats, pitcherHandById) {
  const gameLogs = pitcherGamelogMap[pitcherId] || [];
  const priorRaw = pitcherPriorStats[pitcherId];
  const hand = pitcherHandById[pitcherId] || null;

  const cur = cumulativePriorStats(gameLogs, gameDate);

  // Prior-year aggregate stats
  const prior = priorRaw ? {
    bf: priorRaw.battersFaced || 0,
    so: priorRaw.strikeOuts || 0,
    ip: parseIP(priorRaw.inningsPitched),
    era: parseFloat(priorRaw.era) || null,
    whip: parseFloat(priorRaw.whip) || null,
    fip: safeFIP(priorRaw),
    gs: priorRaw.gamesStarted || 0,
  } : null;

  const hasAnchor = prior && prior.gs >= 5 && prior.bf >= 100;

  // Regress K%
  const kPct26 = cur.bf > 0 ? cur.so / cur.bf : null;
  const anchorK = (prior && prior.bf >= 50) ? prior.so / prior.bf : LEAGUE_K_PCT;
  const trustK = Math.min(1.0, cur.bf / 200);
  const kPct = kPct26 != null
    ? kPct26 * trustK + anchorK * (1 - trustK)
    : (prior && prior.bf >= 50 ? prior.so / prior.bf : LEAGUE_K_PCT);

  // Regress ERA / WHIP / FIP
  const era  = regressRate(cur.era,  cur.ip, prior?.era,  prior?.ip ?? 0, cur.gs, LEAGUE_ERA,  50) ?? LEAGUE_ERA;
  const whip = regressRate(cur.whip, cur.ip, prior?.whip, prior?.ip ?? 0, cur.gs, LEAGUE_WHIP, 50) ?? LEAGUE_WHIP;
  const fip  = regressRate(cur.fip,  cur.ip, prior?.fip,  prior?.ip ?? 0, cur.gs, LEAGUE_FIP,  30) ?? LEAGUE_FIP;

  // Proxy BAA (batting average against) for HRR model: hits / (BF - BB - HBP)
  const approxAB = cur.bf - cur.bb - cur.hbp;
  const baa = approxAB > 0 ? cur.h / approxAB : LEAGUE_BA;

  const avgBF = cur.avgBF ?? 24;
  const stdBF = cur.stdBF ?? 2.5;

  return {
    pitcherId, hand, kPct: kPct * 100, gs: cur.gs, bf: cur.bf,
    era, whip, fip, baa, avgBF, stdBF, hasAnchor,
  };
}

// Batter K% for lineup construction (vs pitcher hand).
export function batterKPct(batterId, pitcherHand, batterSplitsVL, batterSplitsVR, batterSeason) {
  const split = pitcherHand === "L" ? batterSplitsVL[batterId] : batterSplitsVR[batterId];
  if (split?.kPct != null) return split.kPct;
  const season = batterSeason[batterId];
  if (season?.kPct != null) return season.kPct;
  return LEAGUE_K_PCT; // fallback
}

// Batter BA vs pitcher hand (for HRR), shrunk toward season BA.
// Raw split BA at pa≥10 can be as low as .100 (1-for-10), driving rawGameRate
// to 27% and producing near-zero truePct predictions (actual hit rate ~38%).
// Mirrors live model's BvP shrinkage: N_PRIOR=30 PA means a 10-PA split
// carries only 25% weight; splits stabilize around 50+ PA.
const N_PRIOR_BA = 30;
export function batterBA(batterId, pitcherHand, batterSplitsVL, batterSplitsVR, batterSeason) {
  const split = pitcherHand === "L" ? batterSplitsVL[batterId] : batterSplitsVR[batterId];
  const seasonBA = batterSeason[batterId]?.ba ?? LEAGUE_BA;
  if (split?.ba == null) return seasonBA;
  return (split.pa * split.ba + N_PRIOR_BA * seasonBA) / (split.pa + N_PRIOR_BA);
}

// Build ordered K% array for lineup (same as live model's orderedKPcts).
export function buildOrderedKPcts(batterIds, pitcherHand, batterSplitsVL, batterSplitsVR, batterSeason) {
  return batterIds.map(id => batterKPct(id, pitcherHand, batterSplitsVL, batterSplitsVR, batterSeason));
}

// MLB run-scoring lambda for a team (simplified — no regime blend, no lineup-out adjustment).
// pitcherStats = { era, fip } for the opposing pitcher (they pitch against this team's lineup).
// opponentOPS = this team's lineup OPS (they are batting).
export function teamRunLambda(pitcherStats, opponentOPS, parkRunFactor) {
  const pitcherFactor = (0.5 * pitcherStats.fip / LEAGUE_FIP) + (0.5 * pitcherStats.era / LEAGUE_ERA);
  const lineupFactor  = (opponentOPS || LEAGUE_OPS) / LEAGUE_OPS;
  return LEAGUE_RPG * pitcherFactor * lineupFactor * (parkRunFactor ?? 1);
}

// Fit NegBin dispersion r from a list of observed per-team run totals.
// Method-of-moments: r = μ² / (σ² − μ). Pooled across both teams all games.
export function fitNegBinR(allRunTotals) {
  if (allRunTotals.length < 30) return 6; // fallback
  const n = allRunTotals.length;
  const mu = allRunTotals.reduce((a, b) => a + b, 0) / n;
  const v  = allRunTotals.reduce((a, b) => a + (b - mu) ** 2, 0) / (n - 1);
  if (v <= mu) return 20; // near-Poisson fallback
  const r = mu * mu / (v - mu);
  return Math.max(2, Math.min(20, parseFloat(r.toFixed(2))));
}

// Mean lineup OPS for a team's batting order from season stats.
export function lineupOPS(batterIds, batterSeason) {
  const vals = batterIds
    .map(id => batterSeason[id]?.ops)
    .filter(v => v != null && v > 0);
  if (vals.length === 0) return LEAGUE_OPS;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
