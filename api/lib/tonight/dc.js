// dataConfidence penalty engine. Pure function over a play object + minimal context.
// Score starts at 10, subtracts per-rule penalties, clamps [0, 10]. v2 uses dcQualified
// (= dataConfidence >= DC_GATE[sport][gameType]) as a primary qualification gate.
//
// See docs/MODEL.md "dataConfidence" for the penalty table.
//
// Context shape: { sportByteam } — only needed for NBA/WNBA starter-confirmation lookups
// (which mutate p.nbaStarterConfirmed / p.wnbaStarterConfirmed as a side effect — preserved
// from inline behavior).

// Per-sport AND per-play-type qualification thresholds. Player props softer than totals because
// totals can't accumulate per-player penalties; flat gate would let totals dominate. WNBA/NHL
// previously had a -1 sport-wide structural penalty (noDvpRatioStructural, noLineupData) so
// their gates were one tick lower to compensate. Both penalties removed 2026-05-21 — gates
// now match NBA/MLB across the board.
export const DC_GATE = (sport, gameType) => {
  // Unified to 10 for ALL play types (2026-05-31). Previously totals=10, ml/spread=8, props=9.
  // Rationale: the client (`_passesCleanData` / `_qualifiedFilter` in LineupsPage.jsx + App.jsx,
  // and MarketReport `_isQ`) already requires `dataConfidence === 10` for every play type, so the
  // split server gates were a weaker, inconsistent flag the client overrode anyway. `dcQualified`
  // is stamped in a post-pass and is NOT used to drop plays during emission (emit modules never
  // reference it), so raising the gate changes only the boolean's meaning — no play-volume change
  // server-side. Tracked picks are all dc=10 already (client only surfaces dc=10), so calibration
  // of tracked outcomes is unaffected. The dc heavy-injury (-1) and prop penalties still apply;
  // they just now correctly read as not-qualified at dc=9 instead of a misleading dcQualified=true.
  return 10;
};

// Maximum |impliedMean − modelMean| (NBA/WNBA pts) or |impliedLambda − modelLambda| (MLB runs /
// NHL goals) allowed in the season-hit-rate blend. Re-exported because the inline simulate sites
// in /api/tonight also reference these.
export const _GT_IMPLIED_CAP = { nba: 8, wnba: 6, mlb: 1.5, nhl: 1.0 };
export const _TT_IMPLIED_CAP = { nba: 6, mlb: 1.0 };

// Set of sports with active play generation. Mirrors PROD_SPORTS in path.js.
const _PROD_SPORTS = new Set(["mlb", "nba", "nhl", "wnba"]);

export function computeDataConfidence(p, ctx = {}) {
  const { sportByteam = {} } = ctx;
  const sport = p.sport;
  const gameType = p.gameType; // "total" | "teamTotal" | undefined
  const isPlayerProp = !gameType;
  const isMlbK = sport === "mlb" && p.stat === "strikeouts";
  const isMlbHitter = sport === "mlb" && (p.stat === "hits" || p.stat === "hrr" || p.stat === "homeRuns");
  const penalties = {};
  const _pen = (label, cost) => { if (cost) penalties[label] = -Math.abs(cost); };

  // ── Market quality
  if (p._kalshiStale === true) _pen("kalshiStale", 4);
  if (p.lowVolume === true) _pen("lowVolume", 2);
  // wideSpread penalty dropped 2026-05-31: it was a proxy for "this market will cost more to fill
  // than top-of-book shows." Now that every surface (props + totals/teamTotal/spread) re-prices
  // its displayed edge through the cached orderbook-depth blend (blend-fill.js), slippage is
  // accounted for directly in kalshiPct/noKalshiPct — penalizing the spread again would double-count.
  // The raw spread is still emitted as `kalshiSpread` for display; it just no longer gates dc.

  // ── Lineup / starter confirmation
  if (sport === "mlb" && (gameType === "ml" || gameType === "spread")) {
    // ML + spread use the both-sides-confirmed signal (same as MLB game total). Treated identically.
    const conf = p.lineupsConfirmed;
    if (conf === false) _pen("mlbLineupNotConfirmed", 3);
    else if (conf == null) _pen("mlbLineupUnknown", 3);
  } else if (sport === "nba" && (gameType === "ml" || gameType === "spread")) {
    // No lineup-posted penalty: NBA starting 5 isn't officially posted pre-game (ESPN
    // `boxscore.players[].starter` is only populated in/post). The lambda already adjusts
    // OffRtg for known-out players via the injury report (piecewise on MPG-weighted USG-out,
    // floor 0.70 — see _injuryOffRtgAdj); we just penalize the materially-under-modeled case.
    // Heavy-injury fires once per game for the heavier side only (same shape as WNBA below) —
    // stacking both sides was auto-capping plays at dc=8 on rare both-injured games without
    // adding signal beyond the dominant side. Threshold is 30 on the 0–100 usageOut scale
    // (fixed 2026-05-31 from 0.30, which fired on any injury since usageOut is never 0–1).
    const home = p.homeUsageOut || 0;
    const away = p.awayUsageOut || 0;
    if (home >= 30 || away >= 30) {
      _pen(home >= away ? "nbaHomeHeavyInjury" : "nbaAwayHeavyInjury", 1);
    }
    // Model-vs-market divergence: if the model's expected margin and the market spread
    // disagree by >10 pts, the rating system likely missed something (injury, form, etc.).
    // Applies to full-game and half-game spreads (both use gameType="spread").
    if (gameType === "spread" && p.homeLambda != null && p.awayLambda != null && p.pickLine != null && p.pickTeam != null && p.homeTeam != null) {
      const homeModelMargin = p.homeLambda - p.awayLambda;
      const homeMarketMargin = p.pickTeam === p.homeTeam ? -p.pickLine : p.pickLine;
      if (Math.abs(homeModelMargin - homeMarketMargin) > 10) _pen("spreadModelMarketDivergent", 1);
    }
  } else if (sport === "wnba" && (gameType === "ml" || gameType === "spread")) {
    // No pre-game starter feed (same as NBA). Heavy-injury fires once per game for the
    // heavier-injured side only — WNBA roster sizes make both-sides cases common (~69%
    // of games in the 2026-05-26 audit), and stacking to -2 was auto-capping most ML/
    // spread plays at dc=8. NBA branch above matches for consistency (added 2026-05-26).
    const home = p.homeUsageOut || 0;
    const away = p.awayUsageOut || 0;
    if (home >= 30 || away >= 30) {
      _pen(home >= away ? "wnbaHomeHeavyInjury" : "wnbaAwayHeavyInjury", 1);
    }
    // Same model-vs-market divergence gate as NBA (added 2026-06-01).
    if (gameType === "spread" && p.homeLambda != null && p.awayLambda != null && p.pickLine != null && p.pickTeam != null && p.homeTeam != null) {
      const homeModelMargin = p.homeLambda - p.awayLambda;
      const homeMarketMargin = p.pickTeam === p.homeTeam ? -p.pickLine : p.pickLine;
      if (Math.abs(homeModelMargin - homeMarketMargin) > 10) _pen("spreadModelMarketDivergent", 1);
    }
  } else if (sport === "mlb") {
    const conf = isPlayerProp ? p.lineupConfirmed : p.lineupsConfirmed;
    if (conf === false) _pen("mlbLineupNotConfirmed", 3);
    // conf === undefined (no data at all) is treated as not-confirmed for strictness
    else if (conf == null) _pen("mlbLineupUnknown", 3);
  } else if (sport === "nba" && isPlayerProp) {
    // NBA: only penalize bench (lineup IS posted AND player isn't in it — model assumed
    // starter minutes, prop is wrong). "Lineup not posted" is the default pre-game state
    // for NBA (ESPN's boxscore.players[].starter only populates in/post) — penalizing it
    // would cap every pre-game NBA prop at dc=8 and block them all from the strict dc=10
    // home-page filter without saying anything about an individual play's quality. Same
    // logic as the NHL branch below. Side effect: p.nbaStarterConfirmed still stamped for
    // downstream display (true/false/null).
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
    // WNBA: mirror of NBA — only penalize confirmed-bench. Same structural-data-gap reasoning.
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
  // NHL: no penalty for missing lineup data. ESPN doesn't expose pre-game NHL lineups, same
  // as NBA/WNBA above — sport-wide data limitations are documented, not penalized at the
  // play level.

  // ── Player availability (player props only)
  if (isPlayerProp) {
    const ps = (p.playerStatus || "").toLowerCase();
    if (ps.includes("out") || ps.includes("inactive")) _pen("playerOut", 10);
    else if (ps.includes("question") || ps.includes("doubt") || ps.includes("gtd")) _pen("playerQuestionable", 2);
  }

  // ── Sample size (per play type)
  if (isMlbK) {
    const sb = p.stdBF;
    if (sb == null) _pen("noStdBF", 3);
    else if (typeof sb === "number" && sb > 2.5) _pen("highStdBF", 2);
  } else if (isMlbHitter) {
    const sg = p.softGames;
    if (sg == null || sg < 5) _pen("tinyBvPSample", 3);
    else if (sg < 10) _pen("smallBvPSample", 2);
    else if (sg < 16) _pen("modestBvPSample", 1);
  } else if (isPlayerProp) {
    const sg = p.softGames;
    if (sg == null) _pen("noSoftGames", 1);
    else if (sg < 5) _pen("tinySoftSample", 2);
    else if (sg < 10) _pen("smallSoftSample", 1);
  } else if (gameType === "total") {
    // Segmented totals (MLB F5, NBA/WNBA 1H/2H) don't have per-game per-segment season-hit-rate
    // data in v1, so skip the season-sample penalty for them. Full-game gtSsnSample remains
    // the trust signal for full-game totals.
    const isSegment = p.segment && p.segment !== "full";
    if (!isSegment) {
      const ss = p.gtSsnSample;
      if (ss == null) _pen("noSeasonSample", 3);
      else if (ss < 10) _pen("tinySeasonSample", 2);
      else if (ss < 30) _pen("smallSeasonSample", 1);
    }
  } else if (gameType === "teamTotal") {
    const hg = p.h2hGames;
    if (hg == null) _pen("noH2HSample", 3);
    else if (hg < 3) _pen("tinyH2HSample", 2);
    else if (hg < 6) _pen("smallH2HSample", 1);
  }

  // ── Opponent data quality (per play type)
  if (isMlbK) {
    if (p.lineupKPct == null) _pen("noOppLineupKPct", 3);
    else if (p.lineupConfirmed === false) _pen("oppLineupProjected", 1);
  } else if (isMlbHitter) {
    if (p.hitterH2HSource == null) _pen("noBvPSource", 3);
    else if (p.hitterH2HSource === "hand") _pen("handednessOnly", 1);
  } else if (sport === "nba" && isPlayerProp) {
    if (p.dvpRatio == null && p.oppRank == null) _pen("noOppMetric", 3);
    else if (p.dvpRatio == null) _pen("noDvpRatio", 1);
  } else if (sport === "wnba" && isPlayerProp) {
    if (p.oppRank == null) _pen("noOppRank", 3);
    // Conditional -1: was unconditional when WNBA had no DvP. The WNBA build (shipped
    // 2026-05-10) now populates dvpRatio from `wnbaDvpMap.rankings[stat][i].ratio` —
    // aggregate stat-allowed (not per-position like NBA), but a real signal. Only fire
    // when actually missing. Same shape as the NBA branch above.
    if (p.dvpRatio == null) _pen("noDvpRatio", 1);
  } else if (sport === "nhl" && isPlayerProp) {
    if (p.oppMetricValue == null) _pen("noOppMetric", 3);
  } else if (gameType === "total" && _PROD_SPORTS.has(sport)) {
    if (p.gameOuLine == null) _pen("noGameOuLine", 2);
  } else if (sport === "mlb" && gameType === "teamTotal") {
    if (p.oppWHIPSource == null) _pen("noOppWhipSource", 3);
    else if (p.oppWHIPSource === "team") _pen("oppWhipTeamFallback", 1);
  } else if (sport === "nba" && gameType === "teamTotal") {
    if (p.oppDefRtg == null) _pen("noOppDefRtg", 3);
  }

  // ── Season-hit-rate divergence penalty (game + team totals) — when the rate-inverted
  // implied mean/lambda diverges from the model mean/lambda by more than the per-sport
  // cap, the blend clamps in the simulate path but the play is built on softened math.
  // -2 so clamping = definitive drop in both v2 NBA/MLB gates (10 - 2 = 8 < 10) and softer
  // WNBA/NHL gates (9 - 2 = 7 < 9). Caps differ between game totals and team totals because
  // single-team std is smaller.
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

  // ── Threshold-distance penalty (totals & team totals) — tail probabilities are harder
  // to estimate than central ones, so plays far from the market O/U line have noisier
  // edge measurements. Per-sport buckets reflect each sport's scoring magnitude. For
  // team totals, gameOuLine/2 is a half-line heuristic (assumes roughly equal split).
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

  // ── MLB game total: both starters via starter source. Pitcher quality is the primary
  // input to the lambda — fallback to staff-wide WHIP is a meaningful trust hit. Team
  // totals already check `oppWHIPSource`; here we cover both sides for game totals.
  // Same penalty table is applied to MLB ML since both reuse the same lambda inputs.
  if (sport === "mlb" && (gameType === "total" || gameType === "ml" || gameType === "spread")) {
    if (p.homeWHIPSource == null) _pen("noHomeWhipSource", 2);
    else if (p.homeWHIPSource === "team") _pen("homeWhipTeamFallback", 1);
    if (p.awayWHIPSource == null) _pen("noAwayWhipSource", 2);
    else if (p.awayWHIPSource === "team") _pen("awayWhipTeamFallback", 1);
    // Bullpen ERA powers the 40% rest-of-game share. Whole-staff fallback double-counts
    // the starter; tolerable but less precise. -1 per side (max -2).
    if (p.homeBullpenSource === "team") _pen("homeBullpenTeamFallback", 1);
    if (p.awayBullpenSource === "team") _pen("awayBullpenTeamFallback", 1);
  }
  if (sport === "mlb" && gameType === "teamTotal") {
    if (p.oppBullpenSource === "team") _pen("oppBullpenTeamFallback", 1);
  }
  // ── MLB lineup / pitcher-injury penalties (added 2026-05-18) — lambda already adjusts for
  // missing hitters and IL starters, but high injury exposure increases model variance regardless.
  // Game total / ML / spread look at both sides; team total looks at scoring side + opp pitcher.
  if (sport === "mlb" && (gameType === "total" || gameType === "ml" || gameType === "spread")) {
    if ((p.homeTopOut || 0) >= 2) _pen("homeLineupHeavyOut", 1);
    if ((p.awayTopOut || 0) >= 2) _pen("awayLineupHeavyOut", 1);
    if (p.homePitcherOnIL === true) _pen("homePitcherOnIL", 2);
    if (p.awayPitcherOnIL === true) _pen("awayPitcherOnIL", 2);
  }
  if (sport === "mlb" && gameType === "teamTotal") {
    if ((p.scoringTopOut || 0) >= 2) _pen("scoringLineupHeavyOut", 1);
    if (p.oppPitcherOnIL === true) _pen("oppPitcherOnIL", 2);
  }
  // ── NHL game total / ML / spread: starting-goalie SV%. Lambda's opponent factor is set by
  // tonight's goalie when known; team-GAA fallback works but loses precision. -1 per side (max -2).
  // ML/spread reuse the same lambdas as total, so the penalty applies identically.
  if (sport === "nhl" && (gameType === "total" || gameType === "ml" || gameType === "spread")) {
    if (p.homeGoalieSource === "team") _pen("homeGoalieTeamFallback", 1);
    if (p.awayGoalieSource === "team") _pen("awayGoalieTeamFallback", 1);
  }

  const totalPenalty = Object.values(penalties).reduce((s, v) => s + v, 0);
  const dataConfidence = Math.max(0, Math.min(10, 10 + totalPenalty));
  const gate = DC_GATE(sport, gameType);
  return { dataConfidence, dcPenalties: penalties, dcQualified: dataConfidence >= gate, dcGate: gate };
}
