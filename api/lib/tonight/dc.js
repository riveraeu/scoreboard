// dataConfidence penalty engine. Pure function over a play object + minimal context.
// Score starts at 10, subtracts per-rule penalties, clamps [0, 10].
//
// Gate is 7 — only kalshiStale (-4 → dc=6) and playerOut (-10 → dc=0) fail.
// All remaining penalties are display signals (dc 8–9) that pass the gate.
// Data-completeness penalties (lineup confirmation, source quality fallbacks, sample
// size tiers, opponent metric availability) were removed after shadow calibration showed
// they were anti-correlated with ROI/delta — fallback paths regress toward the mean and
// produce better-calibrated outputs than full-data paths. The category gate + edge gate
// do the real qualification work; dc gate now only catches genuinely unusable plays.
//
// dataConfidence: a captured data-quality column (dc≥7 = dcQualified); only kalshiStale/playerOut
// fail the gate, all other penalties are informational. The penalty logic below is the spec.

export const DC_GATE = (_sport, _gameType) => 7;

// Maximum |impliedMean − modelMean| (NBA/WNBA pts) or |impliedLambda − modelLambda| (MLB runs /
// NHL goals) allowed in the season-hit-rate blend. Re-exported because the inline simulate sites
// in /api/tonight also reference these.
export const _GT_IMPLIED_CAP = { nba: 8, wnba: 6, mlb: 1.5, nhl: 1.0 };
export const _TT_IMPLIED_CAP = { nba: 6, mlb: 1.0 };

const _PROD_SPORTS = new Set(["mlb", "nba", "nhl", "wnba"]);

export function computeDataConfidence(p, ctx = {}) {
  const { sportByteam = {} } = ctx;
  const sport = p.sport;
  const gameType = p.gameType;
  const isPlayerProp = !gameType;
  const penalties = {};
  const _pen = (label, cost) => { if (cost) penalties[label] = -Math.abs(cost); };

  // ── Market quality (hard disqualifiers at gate=7)
  if (p._kalshiStale === true) _pen("kalshiStale", 4);   // dc=6 → fails gate
  if (p.lowVolume === true)    _pen("lowVolume", 2);      // dc=8 → display only

  // ── Player availability
  if (isPlayerProp) {
    const ps = (p.playerStatus || "").toLowerCase();
    if (ps.includes("out") || ps.includes("inactive")) _pen("playerOut", 10);   // dc=0 → fails gate
    else if (ps.includes("question") || ps.includes("doubt") || ps.includes("gtd")) _pen("playerQuestionable", 2);
  }

  // ── NBA/WNBA bench / heavy-injury (display signals, dc=8–9)
  if (sport === "nba" && isPlayerProp) {
    const starters = sportByteam.nbaStarters;
    const team = p.playerTeam;
    const pid = String(p.playerId || "");
    if (starters && team && pid) {
      const confirmed = (starters.confirmedTeams || []).includes(team);
      const isStarter = confirmed && ((starters.startersByTeam || {})[team] || []).includes(pid);
      p.nbaStarterConfirmed = confirmed ? isStarter : null;
      if (confirmed && !isStarter) _pen("nbaBench", 2);
    } else {
      p.nbaStarterConfirmed = null;
    }
  } else if (sport === "wnba" && isPlayerProp) {
    const starters = sportByteam.wnbaStarters;
    const team = p.playerTeam;
    const pid = String(p.playerId || "");
    if (starters && team && pid) {
      const confirmed = (starters.confirmedTeams || []).includes(team);
      const isStarter = confirmed && ((starters.startersByTeam || {})[team] || []).includes(pid);
      p.wnbaStarterConfirmed = confirmed ? isStarter : null;
      if (confirmed && !isStarter) _pen("wnbaBench", 2);
    } else {
      p.wnbaStarterConfirmed = null;
    }
  }

  // ── NBA/WNBA ML/spread: heavy injury + model-vs-market divergence (display signals)
  if ((sport === "nba" || sport === "wnba") && (gameType === "ml" || gameType === "spread")) {
    const home = p.homeUsageOut || 0;
    const away = p.awayUsageOut || 0;
    if (home >= 30 || away >= 30) {
      _pen(home >= away
        ? (sport === "nba" ? "nbaHomeHeavyInjury" : "wnbaHomeHeavyInjury")
        : (sport === "nba" ? "nbaAwayHeavyInjury" : "wnbaAwayHeavyInjury"), 1);
    }
    if (gameType === "spread" && p.homeLambda != null && p.awayLambda != null && p.pickLine != null && p.pickTeam != null && p.homeTeam != null) {
      const homeModelMargin  = p.homeLambda - p.awayLambda;
      const homeMarketMargin = p.pickTeam === p.homeTeam ? -p.pickLine : p.pickLine;
      if (Math.abs(homeModelMargin - homeMarketMargin) > 10) _pen("spreadModelMarketDivergent", 1);
    }
  }

  // ── Season-hit-rate divergence (display signal — model λ vs market-implied λ disagree)
  if (gameType === "total" && _GT_IMPLIED_CAP[sport] != null) {
    const _model = p.modelMean ?? p.modelLambda;
    const _impl  = p.impliedMean ?? p.impliedLambda;
    if (_model != null && _impl != null && Math.abs(_impl - _model) > _GT_IMPLIED_CAP[sport]) {
      _pen("seasonRateDivergent", 2);
    }
  } else if (gameType === "teamTotal" && _TT_IMPLIED_CAP[sport] != null) {
    const _model = p.teamExpected;
    const _impl  = p.ttNbaImpliedMean ?? p.ttImpliedLambda;
    if (_model != null && _impl != null && Math.abs(_impl - _model) > _TT_IMPLIED_CAP[sport]) {
      _pen("seasonRateDivergent", 2);
    }
  }

  // ── Threshold-distance (display signal — tail probabilities are noisier)
  if ((gameType === "total" || gameType === "teamTotal") && p.gameOuLine != null && p.threshold != null) {
    const halfLine = gameType === "teamTotal" ? p.gameOuLine / 2 : p.gameOuLine;
    const dist = Math.abs(p.threshold - halfLine);
    const buckets = {
      mlb:  gameType === "total" ? [3, 5] : [2, 3],
      nba:  gameType === "total" ? [10, 20] : [5, 10],
      wnba: gameType === "total" ? [10, 20] : [5, 10],
      nhl:  gameType === "total" ? [2, 3]  : [1, 2],
    }[sport];
    if (buckets) {
      if (dist >= buckets[1]) _pen("farFromLine", 2);
      else if (dist >= buckets[0]) _pen("modestlyFromLine", 1);
    }
  }

  const totalPenalty = Object.values(penalties).reduce((s, v) => s + v, 0);
  const dataConfidence = Math.max(0, Math.min(10, 10 + totalPenalty));
  const gate = DC_GATE(sport, gameType);
  return { dataConfidence, dcPenalties: penalties, dcQualified: dataConfidence >= gate, dcGate: gate };
}
