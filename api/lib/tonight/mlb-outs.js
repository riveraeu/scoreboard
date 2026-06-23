// api/lib/tonight/mlb-outs.js
// emitMlbOutsPlays — MLB pitcher outs-recorded O/U (KXMLBOUTS), Phase 1, shadow-only.
//
// Kalshi lists a threshold ladder per starting pitcher ("Kodai Senga: 15+", 18+, 21+, ...). Each
// market is a binary YES = "records N+ outs". The parse loop in tonight.js collects every priced
// threshold into outsMarkets, each carrying the pitcher name (yes_sub_title), the over threshold
// (floor_strike), the YES/NO prices, the resolved home/away abbrs, and gameDate. Here we emit the
// FAVORITE side (the one whose Kalshi price sits in the [67,91] window).
//
// MODEL (provisional, anchored to workload intuition — NOT market prices):
//   outs ≈ batters-faced × out-rate. The manager's leash (pitch count / effectiveness) sets how
//   many batters a starter faces, which we already hydrate as pitcherAvgBF / pitcherStdBF. Out-rate
//   per batter = 1 − OBP-against, derived from the pitcher's regressed BAA + a league walk/HBP rate.
//     μ (eOuts) = avgBF × outRate
//     σ         = max(stdBF × outRate, SIGMA_FLOOR)
//     truePct("N+ outs") = P(outs ≥ N) = 1 − Φ((N − 0.5 − μ)/σ)   [outsTailPct, continuity-corrected]
//   Outs is a smoother target than the K-count tail (it clusters tightly around the starter's
//   normal workload). v1 is a plain Normal; the early-hook / blowup LEFT tail is understated and
//   deferred to a Phase-1.5 backtest of starter-IP distributions (a known refinement, not a guess).
//
// Output goes into a dedicated `outsPlays` array (NOT the shared `plays` array) so outs rows bypass
// prop dedup, the gameTime filter, and the frontend card builder. tonight.js merges outsPlays into
// the shadow:staging payload ONLY — shadow logs them, the client never sees them. `mlb|outs` is NOT
// in the category gate, so it's shadow-only. Rows are PROP-SHAPED (player_name + stat:"outs" +
// threshold + direction) so the existing player-prop resolver grades them off /api/live (ps.ip → outs).

import { KALSHI_GATE, KALSHI_CAP } from "../config.js";
import { outsTailPct } from "../simulate.js";

// Provisional knobs — anchored to pitcher-workload intuition, not Kalshi. Shadow-calibrated.
const LEAGUE_OUT_RATE = 0.685;  // ~1 − league OBP-against (.315): outs per batter faced
const WALK_HBP_RATE   = 0.06;   // OBP-against ≈ BAA + this (the non-hit on-base component)
const OUT_RATE_MIN    = 0.60;   // clamp: even a shelled start converts ≥60% of BF to outs
const OUT_RATE_MAX    = 0.74;   // clamp: an ace's out-rate ceiling
const SIGMA_FLOOR     = 3.5;    // ≈1.2 IP — never let a thin BF sample claim near-certainty
const SIGMA_DEFAULT   = 4.5;    // ≈1.5 IP — when stdBF is missing/zero
const MIN_GS          = 3;      // need ≥3 starts to trust the workload mean

const _nn = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// Pure projection — exported for unit tests. Returns null when there's no usable workload anchor.
export function projectOuts({ avgBF, stdBF, baa, gs26 }) {
  if (avgBF == null || !(avgBF > 0)) return null;
  if (gs26 != null && gs26 < MIN_GS) return null;
  const outRate = baa != null
    ? Math.max(OUT_RATE_MIN, Math.min(OUT_RATE_MAX, 1 - (baa + WALK_HBP_RATE)))
    : LEAGUE_OUT_RATE;
  const eOuts = avgBF * outRate;
  const sigma = (stdBF != null && stdBF > 0) ? Math.max(stdBF * outRate, SIGMA_FLOOR) : SIGMA_DEFAULT;
  return {
    eOuts: parseFloat(eOuts.toFixed(2)),
    sigma: parseFloat(sigma.toFixed(2)),
    outRate: parseFloat(outRate.toFixed(3)),
  };
}

export function emitMlbOutsPlays(ctx) {
  const { outsMarkets, outsPlays, dropped, isDebug, cutoffStr, sportByteam } = ctx;
  if (!outsMarkets || outsMarkets.length === 0) return;

  const byName = sportByteam?.mlb?.pitcherStatsByName || {};

  for (const m of outsMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // game already past the cutoff day

    // Favorite side: only one of YES(over)/NO(under) can sit in [67,91] (complementary prices).
    const overFav = m.yesPct >= KALSHI_GATE && m.yesPct <= KALSHI_CAP;
    const underFav = m.noPct >= KALSHI_GATE && m.noPct <= KALSHI_CAP;
    if (!overFav && !underFav) continue;

    const ps = byName[_nn(m.player)];
    if (!ps) {
      if (isDebug) dropped.push({ sport: "mlb", stat: "outs", playerName: m.player, threshold: m.threshold, reason: "no_pitcher_data", gameDate: m.gameDate });
      continue;
    }
    const proj = projectOuts(ps);
    if (!proj) {
      if (isDebug) dropped.push({ sport: "mlb", stat: "outs", playerName: m.player, threshold: m.threshold, reason: "no_rating", gameDate: m.gameDate });
      continue;
    }

    const pOver = outsTailPct(proj.eOuts, proj.sigma, m.threshold); // P(outs ≥ N) in %
    if (pOver == null) continue;

    const direction = overFav ? "over" : "under";
    const truePct = overFav ? pOver : parseFloat((100 - pOver).toFixed(1));
    const kalshiPct = overFav ? m.yesPct : m.noPct;
    const americanOdds = overFav ? m.yesAO : m.noAO;
    const edge = parseFloat((truePct - kalshiPct).toFixed(1));

    outsPlays.push({
      sport: "mlb", stat: "outs",
      playerName: m.player,
      homeTeam: m.homeTeam, awayTeam: m.awayTeam, pickTeam: m.pitcherTeam || null,
      threshold: m.threshold, direction,
      truePct, kalshiPct, noKalshiPct: m.noPct,
      americanOdds: americanOdds ?? null,
      edge, dataConfidence: 10, dcQualified: true, qualified: true,
      gameDate: m.gameDate, gameTime: null, modelVersion: "mlb-outs-v1",
      // feature fields (→ features JSON) for future tune:residual slicing
      eOuts: proj.eOuts, sigmaOuts: proj.sigma, outRate: proj.outRate,
      avgBF: ps.avgBF, stdBF: ps.stdBF, baa: ps.baa ?? null, gs26: ps.gs26 ?? null,
      pitcherTeam: m.pitcherTeam || null,
      kalshiVolume: m.kalshiVolume ?? null,
    });
  }
}
