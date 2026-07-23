// api/lib/tonight/lmb-ml.js
// emitLmbPlays — LMB (Mexican League) game winner (Phase 1, shadow-only).
//
// Kalshi lists two binary markets per game (one "Will <team> win?" per side), grouped by
// event_ticker. The parse loop in tonight.js collects every priced side into lmbMarkets,
// each already carrying its canonical pick team + opponent (parsed from the ticker via
// parseGameTeams — LMB abbrs are all 3-char, validated 3+3 split). Here we build the run-rate
// λ pair for each matchup and emit every quoted side with the model's win probability.
//
// Output goes into a dedicated `lmbPlays` array (NOT the shared `plays` array) so LMB rows
// bypass prop/total dedup, the gameTime filter, and the frontend card builder. tonight.js
// merges lmbPlays into the shadow:staging payload only — shadow logs them, the client never
// sees them. `lmb|ml` is not in the category gate, so they're shadow-only.

// Shadow-only: the window is purely a capture selector (no dropped fallback), so use the wide
// CAPTURE band so calibration sees the full favorite curve. Betting is gated later (category gate).
import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";
import { getLmbRatesIndex, lmbLambdas, getLmbSchedule } from "../lmb.js";
import { simulateMLBJoint, mlPctFromJoint } from "../simulate.js";

export async function emitLmbPlays(ctx) {
  const { lmbMarkets, lmbPlays, cutoffStr, cache, isBustCache } = ctx;
  if (!lmbMarkets || lmbMarkets.length === 0) return;

  const rates = await getLmbRatesIndex({ cache, isBustCache });
  if (!rates) return; // standings unavailable — failure-closed, no LMB rows this run

  // Real gameTime for computeMakerQuote's pre-game gate (found 2026-07-23 — this module was
  // hardcoding gameTime:null despite statsapi's own gameDate being one field away). Fetch each
  // distinct date's schedule once, not once per market.
  const dateStrs = [...new Set(lmbMarkets.map(m => (m.gameDate || "").replace(/-/g, "")).filter(Boolean))];
  const schedulesByDate = new Map();
  await Promise.all(dateStrs.map(async (dateStr) => {
    schedulesByDate.set(dateStr, await getLmbSchedule({ dateStr, cache, isBustCache }));
  }));

  // One joint sim per matchup (both sides share it; the mirror side is the complement since
  // mlPctFromJoint drops ties and LMB games can't tie).
  const jointPctByPair = new Map(); // "A|B" sorted → P(first-sorted team wins) as pct
  const pairPct = (a, b) => {
    const [t1, t2] = [a, b].sort();
    const key = `${t1}|${t2}`;
    if (!jointPctByPair.has(key)) {
      const lam = lmbLambdas(rates, t1, t2);
      if (!lam) { jointPctByPair.set(key, null); return null; }
      const joint = simulateMLBJoint(lam.lamPick, lam.lamOpp);
      jointPctByPair.set(key, joint ? mlPctFromJoint(joint.home, joint.away) : null);
    }
    return jointPctByPair.get(key);
  };

  for (const m of lmbMarkets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue; // game already past cutoff day
    // Every quoted side is logged (full-curve capture 2026-07-03) — mirror sides land as
    // separate rows, same idiom as ML home/away. The band check is quote-sanity only now.
    if (m.kalshiPct < CAPTURE_GATE || m.kalshiPct > CAPTURE_CAP) continue;
    const firstSortedPct = pairPct(m.pickTeam, m.opponent);
    if (firstSortedPct == null) continue; // team missing from standings — failure-closed
    const pickIsFirst = m.pickTeam === [m.pickTeam, m.opponent].sort()[0];
    const truePct = parseFloat((pickIsFirst ? firstSortedPct : 100 - firstSortedPct).toFixed(1));
    const edge = parseFloat((truePct - m.kalshiPct).toFixed(1));
    const pickR = rates[m.pickTeam], oppR = rates[m.opponent];
    const dateStr = (m.gameDate || "").replace(/-/g, "");
    const schedGame = dateStr ? schedulesByDate.get(dateStr)?.[[m.gameTeam1, m.gameTeam2].sort().join("|")] : null;
    lmbPlays.push({
      sport: "lmb", stat: "ml",
      // Ticker-order teams land in homeTeam/awayTeam so the resolver's NOT NULL filter selects
      // these rows (Kalshi order ≠ true home/away; the LMB resolver matches on the sorted pair,
      // never on which side is home). pickTeam carries the bet side.
      homeTeam: m.gameTeam1, awayTeam: m.gameTeam2, pickTeam: m.pickTeam,
      threshold: null, direction: null,
      truePct, kalshiPct: m.kalshiPct, americanOdds: m.americanOdds ?? null,
      edge, dataConfidence: 10, dcQualified: true, qualified: true,
      gameDate: m.gameDate, gameTime: schedGame?.gameTime ?? null, modelVersion: "lmb-v1",
      // feature fields (→ features JSON via extractFeatures): season run-rate state at capture
      // time aids later tune:residual analysis.
      opponent: m.opponent,
      pickRsPg: pickR?.rsPg ?? null, pickRaPg: pickR?.raPg ?? null, pickGames: pickR?.games ?? null,
      oppRsPg: oppR?.rsPg ?? null, oppRaPg: oppR?.raPg ?? null, oppGames: oppR?.games ?? null,
      kalshiVolume: m.kalshiVolume ?? null,
    });
  }
}
