// Per-play-type lambda input builders. Each builder returns an array of
// { label, value, color, tooltip? } objects — the components that fed truePct in the lambda /
// simulation for this play. Game O/U and non-K moneyline are NOT included (not lambda inputs).
// Auto-suppress null fields (umpire when unknown, weather for domed parks, etc.) by returning
// null for those entries; InputList filters them.
//
// Color tiers map directly to the same green/yellow/red treatment used in v1 SimScore prose,
// but without the (Npts) abstraction.

const GREEN = '#3fb950';
const YELLOW = '#e3b341';
const RED = '#f78166';
const GRAY = '#8b949e';
const FAINT = '#484f58';

// helpers — small predicates reused across builders. Each returns a color or undefined for "no
// color" (falls back to neutral). Null-safe.
const tier = (v, g, y) => v == null ? null : v >= g ? GREEN : v >= y ? YELLOW : RED;
const tierLow = (v, g, y) => v == null ? null : v <= g ? GREEN : v <= y ? YELLOW : RED;
const factor = (v) => v == null ? null : v > 1.03 ? GREEN : v < 0.97 ? RED : GRAY;
const factorLow = (v) => v == null ? null : v < 0.97 ? GREEN : v > 1.03 ? RED : GRAY;
const pct1 = (v) => v == null ? null : `${v.toFixed(1)}%`;
const pct0 = (v) => v == null ? null : `${v.toFixed(0)}%`;
const dec2 = (v) => v == null ? null : v.toFixed(2);
const dec1 = (v) => v == null ? null : v.toFixed(1);

// MLB lineup-injury display row: shows "−X% (N out)" when lineup factor < 1.0.
const lineupRow = (label, nOut, factor) => {
  if (!nOut || nOut === 0 || factor == null || factor === 1.0) return null;
  return { label, value: `−${Math.round((1 - factor) * 100)}% (${nOut} out)`,
    color: factor >= 0.97 ? YELLOW : RED };
};
// MLB pitcher-IL display row: shows "Yes — bullpen day" when probable starter on IL.
const pitcherIlRow = (label, onIL) => {
  if (!onIL) return null;
  return { label, value: 'Yes — bullpen day', color: RED };
};

function buildMlbKInputs(p) {
  return [
    { label: 'Pitcher K%', value: pct1(p.pitcherKPct), color: tier(p.pitcherKPct, 27, 24) },
    { label: 'CSW%', value: pct1(p.pitcherCSWPct), color: tier(p.pitcherCSWPct, 30, 26) },
    { label: 'K-BB%', value: pct1(p.pitcherKBBPct), color: tier(p.pitcherKBBPct, 18, 12) },
    { label: 'Recent K% (L5)', value: pct1(p.pitcherRecentKPct),
      color: p.pitcherRecentKPct == null || p.pitcherSeasonKPct == null ? null
        : (p.pitcherRecentKPct - p.pitcherSeasonKPct >= 2 ? GREEN
          : p.pitcherRecentKPct - p.pitcherSeasonKPct <= -2 ? RED : GRAY) },
    { label: 'Avg P/start', value: p.pitcherAvgPitches == null ? null : p.pitcherAvgPitches.toFixed(0),
      color: tier(p.pitcherAvgPitches, 85, 75) },
    { label: 'Expected BF', value: p.expectedBF == null ? null : String(p.expectedBF), color: GRAY },
    { label: 'BF variance', value: p.stdBF == null ? 'none' : (p.stdBF > 2.5 ? 'high' : 'low'),
      color: p.stdBF == null ? RED : (p.stdBF > 2.5 ? YELLOW : GREEN) },
    { label: 'Park K', value: p.parkFactor == null ? null
        : `${p.parkFactor < 1 ? '−' : '+'}${Math.abs(Math.round((p.parkFactor - 1) * 100))}%`,
      color: factorLow(p.parkFactor) },
    { label: 'Umpire K', value: p.umpireKFactor == null ? null
        : `${p.umpireKFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.umpireKFactor - 1) * 100))}%${p.umpireName ? ` (${p.umpireName})` : ''}`,
      color: factor(p.umpireKFactor) },
    { label: 'Days rest', value: p.pitcherDaysRest == null ? null : `${p.pitcherDaysRest}d`,
      // Standard rest is 4-5 days. Short (≤3) drags K% via fatigueAdj; long (≥7) is rust/uncertainty.
      color: p.pitcherDaysRest == null ? null
        : p.pitcherDaysRest <= 3 ? RED
        : p.pitcherDaysRest >= 7 ? YELLOW
        : GREEN },
    { label: 'Opp lineup K%', value: p.lineupKPct == null ? null
        : `${p.lineupKPct.toFixed(1)}%${p.lineupConfirmed ? '' : ' (proj)'}`,
      color: tier(p.lineupKPct, 24, 22) },
    { label: 'K H2H Hand', value: p.kH2HHandRate == null || (p.kH2HHandStarts ?? 0) < 5 ? null
        : `${p.kH2HHandRate.toFixed(0)}% (${p.kH2HHandStarts} GS)`,
      color: tier(p.kH2HHandRate, 80, 65) },
    { label: 'Hit rate ≥thr', value: p.blendedHitRate == null ? null : `${p.blendedHitRate.toFixed(0)}%`,
      color: tier(p.blendedHitRate, 90, 80) },
    { label: 'L10 ≥thr', value: p.l10HitRate == null ? null
        : `${p.l10HitRate}%${p.l10Games ? ` (${p.l10Games}g)` : ''}`,
      color: tier(p.l10HitRate, 80, 60) },
    { label: 'Team ML', value: p.gameMoneyline == null ? null
        : (p.gameMoneyline > 0 ? `+${p.gameMoneyline}` : `${p.gameMoneyline}`),
      color: p.gameMoneyline == null ? null
        : p.gameMoneyline <= -121 ? GREEN : p.gameMoneyline <= 120 ? YELLOW : RED,
      tooltip: 'Heavy underdogs trigger early-exit hook in simulation' },
  ];
}

function buildMlbHitterInputs(p) {
  const isBvP = p.hitterH2HSource === 'bvp';
  return [
    { label: 'Pitcher', value: p.hitterPitcherName
        ? `${p.hitterPitcherName}${p.oppPitcherHand ? ` (${p.oppPitcherHand})` : ''}`
        : null, color: '#c9d1d9' },
    { label: isBvP ? 'BvP rate' : 'Hand rate', value: p.softPct == null ? null
        : `${p.softPct.toFixed(1)}%${isBvP && p.softGames ? ` (${p.softGames})` : ''}`,
      color: tier(p.softPct, 80, 70) },
    { label: 'Season rate', value: pct1(p.seasonPct), color: tier(p.seasonPct, 80, 70) },
    { label: 'L10 ≥thr', value: p.l10HitRate == null ? null
        : `${p.l10HitRate}%${p.l10Games ? ` (${p.l10Games}g)` : ''}`,
      color: tier(p.l10HitRate, 70, 50) },
    { label: 'Hitter OPS', value: p.hitterOps == null ? null : p.hitterOps.toFixed(3),
      color: tier(p.hitterOps, 0.850, 0.720) },
    { label: 'Hitter BA', value: p.hitterBa == null ? null
        : '.' + Math.round(p.hitterBa * 1000).toString().padStart(3, '0'),
      color: tier(p.hitterBa, 0.300, 0.270) },
    { label: 'Lineup spot', value: p.hitterLineupSpot == null ? null : `#${p.hitterLineupSpot}`,
      color: p.hitterLineupSpot == null ? null
        : p.hitterLineupSpot <= 3 ? GREEN : p.hitterLineupSpot <= 5 ? YELLOW : RED },
    { label: 'Platoon', value: p.hitterPlatoonRatio == null ? null
        : `${p.hitterPlatoonRatio >= 1 ? '+' : '−'}${Math.abs(Math.round((p.hitterPlatoonRatio - 1) * 100))}%`,
      color: p.hitterPlatoonRatio == null ? null
        : p.hitterPlatoonRatio >= 1.10 ? GREEN : p.hitterPlatoonRatio >= 1.00 ? YELLOW : RED },
    { label: 'Barrel%', value: pct1(p.hitterBarrelPct),
      color: p.hitterBarrelPct == null ? null
        : p.hitterBarrelPct >= 14 ? GREEN : p.hitterBarrelPct >= 10 ? YELLOW
          : p.hitterBarrelPct >= 7 ? GRAY : RED },
    { label: 'Opp WHIP', value: dec2(p.pitcherWHIP), color: tier(p.pitcherWHIP, 1.35, 1.20) },
    { label: 'Opp FIP', value: dec2(p.pitcherFIP), color: tier(p.pitcherFIP, 4.50, 3.80) },
    { label: 'Opp ERA', value: dec2(p.hitterPitcherEra ?? p.pitcherEra),
      color: tier(p.hitterPitcherEra ?? p.pitcherEra, 4.50, 3.50) },
    { label: 'Park hit', value: p.hitterParkKF == null ? null
        : `${p.hitterParkKF >= 1 ? '+' : '−'}${Math.abs(Math.round((p.hitterParkKF - 1) * 100))}%`,
      color: factor(p.hitterParkKF) },
  ];
}

function buildNbaPropInputs(p) {
  const isReb = p.stat === 'rebounds';
  const c1 = isReb ? p.nbaOpportunity : p.nbaUsage;
  return [
    { label: isReb ? 'AvgMin' : 'USG%',
      value: c1 == null ? null : isReb ? `${c1.toFixed(0)}m` : `${c1.toFixed(1)}%`,
      color: isReb ? tier(c1, 30, 25) : tier(c1, 28, 22) },
    { label: 'Opp DvP', value: p.oppRank == null ? null
        : `#${p.oppRank}${p.posGroup ? ` ${p.posGroup}` : ''}${p.dvpRatio ? ` (${(p.dvpRatio*100-100).toFixed(0)}%)` : ''}`,
      color: p.dvpRatio == null ? null
        : p.dvpRatio >= 1.05 ? GREEN : p.dvpRatio >= 1.02 ? YELLOW : RED },
    { label: 'Season rate', value: pct0(p.seasonPct), color: tier(p.seasonPct, 80, 70) },
    { label: 'Soft tier rate', value: pct0(p.softPct), color: tier(p.softPct, 80, 70) },
    { label: 'L10 ≥thr', value: p.l10HitRate == null ? null
        : `${p.l10HitRate}%${p.l10Games ? ` (${p.l10Games}g)` : ''}`,
      color: tier(p.l10HitRate, 80, 60) },
    { label: 'Pace adj', value: p.nbaPaceAdj == null ? null
        : `${p.nbaPaceAdj > 0 ? '+' : ''}${p.nbaPaceAdj.toFixed(1)}`,
      color: p.nbaPaceAdj == null ? null
        : p.nbaPaceAdj > 0 ? GREEN : p.nbaPaceAdj > -2 ? YELLOW : GRAY },
    { label: 'Starter', value: p.nbaStarterConfirmed === true ? 'Confirmed'
        : p.nbaStarterConfirmed === false ? 'Bench' : null,
      color: p.nbaStarterConfirmed === true ? GREEN
        : p.nbaStarterConfirmed === false ? YELLOW : null },
    { label: 'Rest', value: p.isB2B == null ? null : (p.isB2B ? 'B2B' : 'Rested'),
      color: p.isB2B == null ? null : (p.isB2B ? RED : GREEN) },
    { label: 'Home/away split', value: p.nbaSplitAdj == null ? null
        : `${p.nbaSplitAdj >= 1 ? '+' : '−'}${Math.abs(Math.round((p.nbaSplitAdj - 1) * 100))}%`,
      color: p.nbaSplitAdj == null ? null
        : p.nbaSplitAdj >= 1.05 ? GREEN : p.nbaSplitAdj >= 0.95 ? YELLOW : RED },
    { label: 'Game spread', value: p.gameSpread == null ? null
        : `${p.gameSpread > 0 ? '+' : ''}${p.gameSpread}`,
      color: p.gameSpread == null ? null
        : Math.abs(p.gameSpread) <= 5 ? GREEN : Math.abs(p.gameSpread) <= 10 ? YELLOW : RED },
    { label: 'Status', value: p.playerStatus && p.playerStatus !== 'active' ? p.playerStatus : null,
      color: p.playerStatus && p.playerStatus !== 'active' ? RED : null },
  ];
}

function buildWnbaPropInputs(p) {
  // Same as NBA but retuned tiers; dvpRatio always null (no per-position DvP).
  const isReb = p.stat === 'rebounds';
  const c1 = isReb ? p.wnbaOpportunity : p.wnbaUsage;
  return [
    { label: isReb ? 'AvgMin' : 'USG%',
      value: c1 == null ? null : isReb ? `${c1.toFixed(0)}m` : `${c1.toFixed(1)}%`,
      color: tier(c1, 27, 22) },
    { label: 'Opp rank', value: p.oppRank == null ? null : `#${p.oppRank}`,
      color: p.oppRank == null ? null : p.oppRank <= 4 ? GREEN : p.oppRank <= 8 ? YELLOW : RED,
      tooltip: 'WNBA: no per-position DvP available' },
    { label: 'Season rate', value: pct0(p.seasonPct), color: tier(p.seasonPct, 80, 70) },
    { label: 'Soft tier rate', value: pct0(p.softPct), color: tier(p.softPct, 80, 70) },
    { label: 'L10 ≥thr', value: p.l10HitRate == null ? null
        : `${p.l10HitRate}%${p.l10Games ? ` (${p.l10Games}g)` : ''}`,
      color: tier(p.l10HitRate, 80, 60) },
    { label: 'Pace adj', value: p.wnbaPaceAdj == null ? null
        : `${p.wnbaPaceAdj > 0 ? '+' : ''}${p.wnbaPaceAdj.toFixed(1)}`,
      color: p.wnbaPaceAdj == null ? null
        : p.wnbaPaceAdj > 0 ? GREEN : p.wnbaPaceAdj > -2 ? YELLOW : GRAY },
    { label: 'Starter', value: p.wnbaStarterConfirmed === true ? 'Confirmed'
        : p.wnbaStarterConfirmed === false ? 'Bench' : null,
      color: p.wnbaStarterConfirmed === true ? GREEN
        : p.wnbaStarterConfirmed === false ? YELLOW : null },
    { label: 'Rest', value: p.isB2B == null ? null : (p.isB2B ? 'B2B' : 'Rested'),
      color: p.isB2B == null ? null : (p.isB2B ? RED : GREEN) },
    { label: 'Home/away split', value: p.wnbaSplitAdj == null ? null
        : `${p.wnbaSplitAdj >= 1 ? '+' : '−'}${Math.abs(Math.round((p.wnbaSplitAdj - 1) * 100))}%`,
      color: p.wnbaSplitAdj == null ? null
        : p.wnbaSplitAdj >= 1.05 ? GREEN : p.wnbaSplitAdj >= 0.95 ? YELLOW : RED },
    { label: 'Game spread', value: p.gameSpread == null ? null
        : `${p.gameSpread > 0 ? '+' : ''}${p.gameSpread}`,
      color: p.gameSpread == null ? null
        : Math.abs(p.gameSpread) <= 5 ? GREEN : Math.abs(p.gameSpread) <= 10 ? YELLOW : RED },
    { label: 'Status', value: p.playerStatus && p.playerStatus !== 'active' ? p.playerStatus : null,
      color: p.playerStatus && p.playerStatus !== 'active' ? RED : null },
  ];
}

function buildNhlPropInputs(p) {
  return [
    { label: 'Avg TOI', value: p.avgTOI == null ? null : p.avgTOI,
      color: GRAY }, // TOI formatted depends on source; show whatever's emitted
    { label: 'Opp GAA', value: p.oppMetricValue == null ? null
        : `#${p.oppRank} (${p.oppMetricValue.toFixed(2)})`,
      color: p.oppRank == null ? null : p.oppRank <= 10 ? GREEN : p.oppRank <= 20 ? YELLOW : RED },
    { label: 'Team GPG', value: dec2(p.nhlTeamGPG), color: tier(p.nhlTeamGPG, 3.5, 3.0) },
    { label: 'Shots adj', value: p.nhlShotsAdj == null ? null
        : `${p.nhlShotsAdj > 0 ? '+' : ''}${p.nhlShotsAdj.toFixed(1)}`,
      color: p.nhlShotsAdj == null ? null
        : p.nhlShotsAdj > 1 ? GREEN : p.nhlShotsAdj > -1 ? YELLOW : RED },
    { label: 'Season rate', value: pct0(p.seasonPct), color: tier(p.seasonPct, 75, 65) },
    { label: 'Soft tier rate', value: pct0(p.softPct), color: tier(p.softPct, 75, 65) },
    { label: 'L10 ≥thr', value: p.l10HitRate == null ? null
        : `${p.l10HitRate}%${p.l10Games ? ` (${p.l10Games}g)` : ''}`,
      color: tier(p.l10HitRate, 70, 50) },
    { label: 'Rest', value: p.isB2B == null ? null : (p.isB2B ? 'B2B' : 'Rested'),
      color: p.isB2B == null ? null : (p.isB2B ? RED : GREEN) },
  ];
}

// Direction-aware tier helpers. For UNDER plays, "good" means low value
// (low RPG, low ERA, low WHIP, low H2H rate, etc.) — invert the tier function.
const tierDir = (isUnder, v, gHigh, yHigh) => isUnder ? tierLow(v, yHigh, gHigh) : tier(v, gHigh, yHigh);
const factorDir = (isUnder, v) => isUnder ? factorLow(v) : factor(v);

function buildMlbTotalInputs(p) {
  const isUnder = p.direction === 'under';
  const whipSrc = (src) => src === 'starter' ? '' : src === 'team' ? ' (team)' : '';
  return [
    { label: 'Home RPG', value: dec1(p.homeRPG), color: tierDir(isUnder, p.homeRPG, 5, 4) },
    { label: 'Away RPG', value: dec1(p.awayRPG), color: tierDir(isUnder, p.awayRPG, 5, 4) },
    { label: 'Home WHIP', value: p.homeWHIP == null ? null
        : `${p.homeWHIP.toFixed(2)}${whipSrc(p.homeWHIPSource)}`,
      color: tierDir(isUnder, p.homeWHIP, 1.35, 1.20) },
    { label: 'Away WHIP', value: p.awayWHIP == null ? null
        : `${p.awayWHIP.toFixed(2)}${whipSrc(p.awayWHIPSource)}`,
      color: tierDir(isUnder, p.awayWHIP, 1.35, 1.20) },
    { label: 'Home FIP', value: dec2(p.homeFIP), color: tierDir(isUnder, p.homeFIP, 4.50, 3.80) },
    { label: 'Away FIP', value: dec2(p.awayFIP), color: tierDir(isUnder, p.awayFIP, 4.50, 3.80) },
    { label: 'Park run', value: p.parkFactor == null ? null
        : `${p.parkFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.parkFactor - 1) * 100))}%`,
      color: factorDir(isUnder, p.parkFactor) },
    { label: 'Weather', value: p.weatherFactor == null ? null
        : `${p.weatherFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.weatherFactor - 1) * 100))}%${p.windOutMph ? ` (${p.windOutMph}mph)` : ''}`,
      color: factorDir(isUnder, p.weatherFactor) },
    { label: 'Umpire', value: p.umpireRunFactor == null ? null
        : `${p.umpireRunFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.umpireRunFactor - 1) * 100))}%${p.umpireName ? ` (${p.umpireName})` : ''}`,
      color: factorDir(isUnder, p.umpireRunFactor) },
    { label: 'Ssn rate ≥thr', value: p.gtSeasonHitRate == null ? null
        : `${p.gtSeasonHitRate}%${p.gtSsnSample ? ` (${p.gtSsnSample}g)` : ''}`,
      color: tierDir(isUnder, p.gtSeasonHitRate, 50, 35) },
    { label: 'H2H ≥thr', value: p.h2hTotalHitRate == null ? null
        : `${p.h2hTotalHitRate}%${p.h2hTotalGames ? ` (${p.h2hTotalGames}g)` : ''}`,
      color: tierDir(isUnder, p.h2hTotalHitRate, 60, 40) },
    lineupRow('Home lineup', p.homeTopOut, p.homeLineupFactor),
    lineupRow('Away lineup', p.awayTopOut, p.awayLineupFactor),
    pitcherIlRow('Home pitcher IL', p.homePitcherOnIL),
    pitcherIlRow('Away pitcher IL', p.awayPitcherOnIL),
  ].filter(Boolean);
}

function buildNbaTotalInputs(p) {
  const isUnder = p.direction === 'under';
  const paceAdj = p.projPace != null && p.leagueAvgPace != null ? (p.projPace - p.leagueAvgPace) : null;
  // H2H rate has different server-side field names: NBA emits `nbaGtH2HRate`, WNBA emits
  // `wnbaGtH2HRate`. Read either so the shared NBA/WNBA total builder picks up the right value.
  const h2hRate = p.nbaGtH2HRate ?? p.wnbaGtH2HRate ?? null;
  const h2hGames = p.nbaGtH2HGames ?? p.wnbaGtH2HGames ?? null;
  return [
    { label: 'Comb OffRtg', value: dec1(p.combOffRtg), color: tierDir(isUnder, p.combOffRtg, 118, 113) },
    { label: 'Comb DefRtg', value: dec1(p.combDefRtg), color: tierDir(isUnder, p.combDefRtg, 118, 113) },
    { label: 'Pace adj', value: paceAdj == null ? null
        : `${paceAdj > 0 ? '+' : ''}${paceAdj.toFixed(1)}`,
      color: paceAdj == null ? null
        : isUnder ? (paceAdj < -1 ? GREEN : paceAdj < 2 ? YELLOW : RED)
                  : (paceAdj > 1 ? GREEN : paceAdj > -2 ? YELLOW : RED) },
    { label: 'H2H ≥thr', value: h2hRate == null ? null
        : `${h2hRate}%${h2hGames ? ` (${h2hGames}g)` : ''}`,
      color: tierDir(isUnder, h2hRate, 60, 40) },
    { label: 'Ssn ≥thr', value: p.gtSeasonHitRate == null ? null
        : `${p.gtSeasonHitRate}%${p.gtSsnSample ? ` (${p.gtSsnSample}g)` : ''}`,
      color: tierDir(isUnder, p.gtSeasonHitRate, 50, 35) },
    // Wider spreads tend to suppress totals — game ends with bench minutes for the trailing
    // team. Color tier mirrors team-total convention.
    { label: 'Game spread', value: p.gameSpread == null ? null
        : `${p.gameSpread > 0 ? '+' : ''}${p.gameSpread}`,
      color: p.gameSpread == null ? null
        : (isUnder
          ? (Math.abs(p.gameSpread) > 10 ? GREEN : Math.abs(p.gameSpread) > 5 ? YELLOW : RED)
          : (Math.abs(p.gameSpread) <= 5 ? GREEN : Math.abs(p.gameSpread) <= 10 ? YELLOW : RED)) },
    { label: 'Injuries', value: p.homeOut != null || p.awayOut != null
        ? `${(p.homeOut ?? 0) + (p.awayOut ?? 0)}` : null,
      // More injuries → fewer pts → good for under
      color: (() => {
        const outs = (p.homeOut ?? 0) + (p.awayOut ?? 0);
        if (isUnder) return outs >= 3 ? GREEN : outs >= 1 ? YELLOW : GRAY;
        return outs <= 1 ? GREEN : outs <= 3 ? YELLOW : RED;
      })() },
    { label: 'Playoff boost', value: p.playoffBoost == null ? null
        : `×${p.playoffBoost.toFixed(2)}`, color: isUnder ? RED : GREEN },
  ];
}

function buildNhlTotalInputs(p) {
  const isUnder = p.direction === 'under';
  return [
    { label: 'Home GPG', value: dec2(p.homeGPG), color: tierDir(isUnder, p.homeGPG, 3.5, 3.0) },
    { label: 'Away GPG', value: dec2(p.awayGPG), color: tierDir(isUnder, p.awayGPG, 3.5, 3.0) },
    { label: 'Home GAA', value: dec2(p.homeGAA), color: tierDir(isUnder, p.homeGAA, 3.5, 3.0) },
    { label: 'Away GAA', value: dec2(p.awayGAA), color: tierDir(isUnder, p.awayGAA, 3.5, 3.0) },
    { label: 'H2H ≥thr', value: p.nhlGtH2HRate == null ? null
        : `${p.nhlGtH2HRate}%${p.nhlGtH2HGames ? ` (${p.nhlGtH2HGames}g)` : ''}`,
      color: tierDir(isUnder, p.nhlGtH2HRate, 60, 40) },
    { label: 'Ssn ≥thr', value: p.gtSeasonHitRate == null ? null
        : `${p.gtSeasonHitRate}%${p.gtSsnSample ? ` (${p.gtSsnSample}g)` : ''}`,
      color: tierDir(isUnder, p.gtSeasonHitRate, 50, 35) },
  ];
}

function buildMlbTeamTotalInputs(p) {
  const isUnder = p.direction === 'under';
  const whipSrc = (src) => src === 'starter' ? '' : src === 'team' ? ' (team)' : '';
  return [
    { label: 'Team RPG', value: dec1(p.teamRPG), color: tierDir(isUnder, p.teamRPG, 5, 4) },
    { label: 'Opp ERA', value: dec2(p.oppERA), color: tierDir(isUnder, p.oppERA, 4.50, 3.50) },
    { label: 'Opp FIP', value: dec2(p.oppFIP), color: tierDir(isUnder, p.oppFIP, 4.50, 3.80) },
    { label: 'Opp WHIP', value: p.oppWHIP == null ? null
        : `${p.oppWHIP.toFixed(2)}${whipSrc(p.oppWHIPSource)}`,
      color: tierDir(isUnder, p.oppWHIP, 1.35, 1.20) },
    { label: 'Park run', value: p.parkFactor == null ? null
        : `${p.parkFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.parkFactor - 1) * 100))}%`,
      color: factorDir(isUnder, p.parkFactor) },
    { label: 'L10 RPG', value: dec1(p.teamL10RPG), color: tierDir(isUnder, p.teamL10RPG, 5, 4) },
    { label: 'H2H ≥thr', value: p.h2hHitRate == null ? null
        : `${p.h2hHitRate}%${p.h2hGames ? ` (${p.h2hGames}g)` : ''}`,
      color: tierDir(isUnder, p.h2hHitRate, 60, 40) },
    { label: 'Umpire run', value: p.umpireRunFactor == null ? null
        : `${p.umpireRunFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.umpireRunFactor - 1) * 100))}%${p.umpireName ? ` (${p.umpireName})` : ''}`,
      color: factorDir(isUnder, p.umpireRunFactor) },
    { label: 'Platoon', value: p.platoonFactor == null ? null
        : `${p.platoonFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.platoonFactor - 1) * 100))}%`,
      color: factorDir(isUnder, p.platoonFactor) },
    { label: 'Ssn ≥thr', value: p.ttSeasonHitRate == null ? null
        : `${p.ttSeasonHitRate}%`, color: tierDir(isUnder, p.ttSeasonHitRate, 50, 35) },
    lineupRow('Team lineup', p.scoringTopOut, p.scoringLineupFactor),
    pitcherIlRow('Opp pitcher IL', p.oppPitcherOnIL),
  ].filter(Boolean);
}

function buildNbaTeamTotalInputs(p) {
  const isUnder = p.direction === 'under';
  const paceAdj = p.projPace != null && p.leagueAvgPace != null ? (p.projPace - p.leagueAvgPace) : null;
  return [
    { label: 'Team OffRtg', value: dec1(p.teamOffRtg), color: tierDir(isUnder, p.teamOffRtg, 118, 113) },
    { label: 'Opp DefRtg', value: dec1(p.oppDefRtg), color: tierDir(isUnder, p.oppDefRtg, 118, 113) },
    { label: 'Team expected', value: dec1(p.teamExpected), color: GRAY },
    { label: 'Pace adj', value: paceAdj == null ? null
        : `${paceAdj > 0 ? '+' : ''}${paceAdj.toFixed(1)}`,
      color: paceAdj == null ? null
        : isUnder ? (paceAdj < -1 ? GREEN : paceAdj < 2 ? YELLOW : RED)
                  : (paceAdj > 1 ? GREEN : paceAdj > -2 ? YELLOW : RED) },
    { label: 'Game spread', value: p.gameSpread == null ? null
        : `${p.gameSpread > 0 ? '+' : ''}${p.gameSpread}`,
      color: p.gameSpread == null ? null
        : Math.abs(p.gameSpread) <= 5 ? GREEN : Math.abs(p.gameSpread) <= 10 ? YELLOW : RED },
    // Injuries: scoring team's outs hurt the OVER; opp's outs help the OVER. Combined count
    // with a directional color tier — under flips the polarity.
    { label: 'Injuries', value: p.scoringOut != null || p.oppOut != null
        ? `${p.scoringOut ?? 0} sco / ${p.oppOut ?? 0} opp` : null,
      color: (() => {
        const net = (p.oppOut ?? 0) - (p.scoringOut ?? 0); // +ve favors over
        if (p.scoringOut == null && p.oppOut == null) return null;
        if (isUnder) return net <= -1 ? GREEN : net <= 1 ? YELLOW : RED;
        return net >= 1 ? GREEN : net >= -1 ? YELLOW : RED;
      })() },
    { label: 'H2H ≥thr', value: p.h2hHitRate == null ? null
        : `${p.h2hHitRate}%${p.h2hGames ? ` (${p.h2hGames}g)` : ''}`,
      color: tierDir(isUnder, p.h2hHitRate, 60, 40) },
    { label: 'Ssn ≥thr', value: p.ttNbaSeasonHitRate == null ? null
        : `${p.ttNbaSeasonHitRate}%`, color: tierDir(isUnder, p.ttNbaSeasonHitRate, 50, 35) },
    { label: 'Playoff boost', value: p.playoffBoost == null ? null
        : `×${p.playoffBoost.toFixed(2)}`, color: isUnder ? RED : GREEN },
  ];
}

// MLB moneyline — pickTeam-oriented factor list. Pick λ vs opp λ is the core driver;
// margin (pick − opp) is the cleanest single-number summary. Pitcher quality breakouts +
// shared game-level factors (park, weather, umpire) round it out.
function buildMlbMlInputs(p) {
  const isHomePick = p.pickTeam === p.homeTeam;
  const pickLambda = isHomePick ? p.homeLambda : p.awayLambda;
  const oppLambda = isHomePick ? p.awayLambda : p.homeLambda;
  const margin = (pickLambda != null && oppLambda != null) ? pickLambda - oppLambda : null;
  const pickFIP = isHomePick ? p.homeFIP : p.awayFIP;
  const oppFIP = isHomePick ? p.awayFIP : p.homeFIP;
  const pickWHIP = isHomePick ? p.homeWHIP : p.awayWHIP;
  const oppWHIP = isHomePick ? p.awayWHIP : p.homeWHIP;
  const pickWHIPSrc = isHomePick ? p.homeWHIPSource : p.awayWHIPSource;
  const oppWHIPSrc = isHomePick ? p.awayWHIPSource : p.homeWHIPSource;
  const whipSrc = (src) => src === 'starter' ? '' : src === 'team' ? ' (team)' : '';
  return [
    { label: 'Pick λ runs', value: dec1(pickLambda), color: tier(pickLambda, 5, 4) },
    { label: 'Opp λ runs', value: dec1(oppLambda), color: tierLow(oppLambda, 4, 5) },
    { label: 'Margin (runs)', value: margin == null ? null
        : `${margin >= 0 ? '+' : ''}${margin.toFixed(2)}`,
      color: margin == null ? null : margin > 0.4 ? GREEN : margin > 0 ? YELLOW : RED },
    { label: 'Pick FIP', value: dec2(pickFIP), color: tierLow(pickFIP, 3.80, 4.50) },
    { label: 'Opp FIP', value: dec2(oppFIP), color: tier(oppFIP, 4.50, 3.80) },
    { label: 'Pick WHIP', value: pickWHIP == null ? null
        : `${pickWHIP.toFixed(2)}${whipSrc(pickWHIPSrc)}`,
      color: tierLow(pickWHIP, 1.20, 1.35) },
    { label: 'Opp WHIP', value: oppWHIP == null ? null
        : `${oppWHIP.toFixed(2)}${whipSrc(oppWHIPSrc)}`,
      color: tier(oppWHIP, 1.35, 1.20) },
    { label: 'Park run', value: p.parkFactor == null ? null
        : `${p.parkFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.parkFactor - 1) * 100))}%`,
      color: GRAY },
    { label: 'Weather', value: p.weatherFactor == null ? null
        : `${p.weatherFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.weatherFactor - 1) * 100))}%${p.windOutMph ? ` (${p.windOutMph}mph)` : ''}`,
      color: GRAY },
    { label: 'Umpire', value: p.umpireRunFactor == null ? null
        : `${p.umpireRunFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.umpireRunFactor - 1) * 100))}%${p.umpireName ? ` (${p.umpireName})` : ''}`,
      color: GRAY },
    lineupRow('Pick lineup', isHomePick ? p.homeTopOut : p.awayTopOut, isHomePick ? p.homeLineupFactor : p.awayLineupFactor),
    lineupRow('Opp lineup', isHomePick ? p.awayTopOut : p.homeTopOut, isHomePick ? p.awayLineupFactor : p.homeLineupFactor),
    pitcherIlRow('Pick pitcher IL', isHomePick ? p.homePitcherOnIL : p.awayPitcherOnIL),
    pitcherIlRow('Opp pitcher IL', isHomePick ? p.awayPitcherOnIL : p.homePitcherOnIL),
  ].filter(Boolean);
}

// MLB spread — pickTeam-oriented factor list. Same backbone as ML (margin from pickλ - oppλ
// is the core driver) plus the line itself so the user can see how the model's margin compares
// to the spread bar. For YES picks (negative pickLine) we want margin > |pickLine|; for NO
// picks (positive pickLine) we want margin > -pickLine. The "Cover by" row formats this.
function buildMlbSpreadInputs(p) {
  const isHomePick = p.pickTeam === p.homeTeam;
  const pickLambda = isHomePick ? p.homeLambda : p.awayLambda;
  const oppLambda = isHomePick ? p.awayLambda : p.homeLambda;
  const margin = (pickLambda != null && oppLambda != null) ? pickLambda - oppLambda : null;
  const needed = p.pickLine != null ? -p.pickLine : null; // model margin needed to cover
  const surplus = (margin != null && needed != null) ? margin - needed : null;
  const pickFIP = isHomePick ? p.homeFIP : p.awayFIP;
  const oppFIP = isHomePick ? p.awayFIP : p.homeFIP;
  const pickWHIP = isHomePick ? p.homeWHIP : p.awayWHIP;
  const oppWHIP = isHomePick ? p.awayWHIP : p.homeWHIP;
  const pickWHIPSrc = isHomePick ? p.homeWHIPSource : p.awayWHIPSource;
  const oppWHIPSrc = isHomePick ? p.awayWHIPSource : p.homeWHIPSource;
  const whipSrc = (src) => src === 'starter' ? '' : src === 'team' ? ' (team)' : '';
  const pickLineStr = p.pickLine == null ? null : (p.pickLine > 0 ? `+${p.pickLine}` : `${p.pickLine}`);
  return [
    { label: 'Spread', value: pickLineStr, color: GRAY },
    { label: 'Pick λ runs', value: dec1(pickLambda), color: tier(pickLambda, 5, 4) },
    { label: 'Opp λ runs', value: dec1(oppLambda), color: tierLow(oppLambda, 4, 5) },
    { label: 'Model margin', value: margin == null ? null
        : `${margin >= 0 ? '+' : ''}${margin.toFixed(2)}`,
      color: margin == null ? null : margin > 0.4 ? GREEN : margin > 0 ? YELLOW : RED },
    { label: 'Cover by', value: surplus == null ? null
        : `${surplus >= 0 ? '+' : ''}${surplus.toFixed(2)}`,
      color: surplus == null ? null : surplus > 0.5 ? GREEN : surplus > 0 ? YELLOW : RED },
    { label: 'Pick FIP', value: dec2(pickFIP), color: tierLow(pickFIP, 3.80, 4.50) },
    { label: 'Opp FIP', value: dec2(oppFIP), color: tier(oppFIP, 4.50, 3.80) },
    { label: 'Pick WHIP', value: pickWHIP == null ? null
        : `${pickWHIP.toFixed(2)}${whipSrc(pickWHIPSrc)}`,
      color: tierLow(pickWHIP, 1.20, 1.35) },
    { label: 'Opp WHIP', value: oppWHIP == null ? null
        : `${oppWHIP.toFixed(2)}${whipSrc(oppWHIPSrc)}`,
      color: tier(oppWHIP, 1.35, 1.20) },
    { label: 'Park run', value: p.parkFactor == null ? null
        : `${p.parkFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.parkFactor - 1) * 100))}%`,
      color: GRAY },
    { label: 'Weather', value: p.weatherFactor == null ? null
        : `${p.weatherFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.weatherFactor - 1) * 100))}%${p.windOutMph ? ` (${p.windOutMph}mph)` : ''}`,
      color: GRAY },
    { label: 'Umpire', value: p.umpireRunFactor == null ? null
        : `${p.umpireRunFactor >= 1 ? '+' : '−'}${Math.abs(Math.round((p.umpireRunFactor - 1) * 100))}%${p.umpireName ? ` (${p.umpireName})` : ''}`,
      color: GRAY },
    lineupRow('Pick lineup', isHomePick ? p.homeTopOut : p.awayTopOut, isHomePick ? p.homeLineupFactor : p.awayLineupFactor),
    lineupRow('Opp lineup', isHomePick ? p.awayTopOut : p.homeTopOut, isHomePick ? p.awayLineupFactor : p.homeLineupFactor),
    pitcherIlRow('Pick pitcher IL', isHomePick ? p.homePitcherOnIL : p.awayPitcherOnIL),
    pitcherIlRow('Opp pitcher IL', isHomePick ? p.awayPitcherOnIL : p.homePitcherOnIL),
  ].filter(Boolean);
}

// NBA/WNBA moneyline — pickTeam-oriented factor list. Pick λ vs opp λ from possession-based
// projection; margin (pick − opp) is the cleanest single-number summary. Includes OffRtg/DefRtg
// breakdown, pace, injuries, and playoff boost (NBA only). Same builder works for both sports
// since they share the same per-team Normal-mean simData shape; σ differs (NBA 13, WNBA 11)
// but that's a sim-internal — not surfaced as an input row.
function buildNbaWnbaMlInputs(p) {
  const isHomePick = p.pickTeam === p.homeTeam;
  const pickLambda = isHomePick ? p.homeLambda : p.awayLambda;
  const oppLambda = isHomePick ? p.awayLambda : p.homeLambda;
  const margin = (pickLambda != null && oppLambda != null) ? pickLambda - oppLambda : null;
  const pickOffRtg = isHomePick ? p.homeOffRtg : p.awayOffRtg;
  const oppOffRtg = isHomePick ? p.awayOffRtg : p.homeOffRtg;
  const pickDefRtg = isHomePick ? p.homeDefRtg : p.awayDefRtg;
  const oppDefRtg = isHomePick ? p.awayDefRtg : p.homeDefRtg;
  const pickOut = isHomePick ? p.homeOut : p.awayOut;
  const oppOut = isHomePick ? p.awayOut : p.homeOut;
  const pickUsageOut = isHomePick ? p.homeUsageOut : p.awayUsageOut;
  const oppUsageOut = isHomePick ? p.awayUsageOut : p.homeUsageOut;
  const pickB2B = isHomePick ? p.homeB2B : p.awayB2B;
  const oppB2B = isHomePick ? p.awayB2B : p.homeB2B;
  const paceAdj = p.projPace != null && p.leagueAvgPace != null ? (p.projPace - p.leagueAvgPace) : null;
  return [
    { label: 'Pick λ pts', value: dec1(pickLambda), color: tier(pickLambda, 115, 105) },
    { label: 'Opp λ pts', value: dec1(oppLambda), color: tierLow(oppLambda, 105, 115) },
    { label: 'Margin (pts)', value: margin == null ? null
        : `${margin >= 0 ? '+' : ''}${margin.toFixed(1)}`,
      color: margin == null ? null : margin > 3 ? GREEN : margin > 0 ? YELLOW : RED },
    { label: 'Pick OffRtg', value: dec1(pickOffRtg), color: tier(pickOffRtg, 118, 113) },
    { label: 'Opp DefRtg', value: dec1(oppDefRtg), color: tierLow(oppDefRtg, 113, 118) },
    { label: 'Pick DefRtg', value: dec1(pickDefRtg), color: tierLow(pickDefRtg, 113, 118) },
    { label: 'Opp OffRtg', value: dec1(oppOffRtg), color: tier(oppOffRtg, 118, 113) },
    { label: 'Pace adj', value: paceAdj == null ? null
        : `${paceAdj > 0 ? '+' : ''}${paceAdj.toFixed(1)}`, color: GRAY },
    { label: 'Pick injuries', value: pickOut != null ? `${pickOut} out${pickUsageOut ? ` (${Math.round(pickUsageOut)}% USG)` : ''}` : null,
      color: pickUsageOut == null ? GRAY : pickUsageOut >= 30 ? RED : pickUsageOut >= 15 ? YELLOW : GREEN },
    { label: 'Opp injuries', value: oppOut != null ? `${oppOut} out${oppUsageOut ? ` (${Math.round(oppUsageOut)}% USG)` : ''}` : null,
      color: oppUsageOut == null ? GRAY : oppUsageOut >= 30 ? GREEN : oppUsageOut >= 15 ? YELLOW : GRAY },
    pickB2B ? { label: 'Pick B2B', value: 'yes', color: RED } : null,
    oppB2B ? { label: 'Opp B2B', value: 'yes', color: GREEN } : null,
    p.playoffBoost != null ? { label: 'Playoff boost', value: `×${p.playoffBoost.toFixed(2)}`, color: GRAY } : null,
  ].filter(Boolean);
}

// NBA/WNBA spread — same backbone as ML plus the line + cover-by surplus, mirroring MLB.
function buildNbaWnbaSpreadInputs(p) {
  const base = buildNbaWnbaMlInputs(p);
  const pickLineStr = p.pickLine == null ? null : (p.pickLine > 0 ? `+${p.pickLine}` : `${p.pickLine}`);
  const isHomePick = p.pickTeam === p.homeTeam;
  const pickLambda = isHomePick ? p.homeLambda : p.awayLambda;
  const oppLambda = isHomePick ? p.awayLambda : p.homeLambda;
  const margin = (pickLambda != null && oppLambda != null) ? pickLambda - oppLambda : null;
  const needed = p.pickLine != null ? -p.pickLine : null;
  const surplus = (margin != null && needed != null) ? margin - needed : null;
  return [
    { label: 'Spread', value: pickLineStr, color: GRAY },
    { label: 'Cover by', value: surplus == null ? null
        : `${surplus >= 0 ? '+' : ''}${surplus.toFixed(1)}`,
      color: surplus == null ? null : surplus > 2 ? GREEN : surplus > 0 ? YELLOW : RED },
    ...base,
  ];
}

// NHL moneyline — Poisson goals λ on each side, goalie SV% breakouts (lambdas already
// incorporate goalie when known; fallback flag is surfaced as a "(team)" suffix), GPG/GAA gut
// checks, and B2B flags.
function buildNhlMlInputs(p) {
  const isHomePick = p.pickTeam === p.homeTeam;
  const pickLambda = isHomePick ? p.homeLambda : p.awayLambda;
  const oppLambda = isHomePick ? p.awayLambda : p.homeLambda;
  const margin = (pickLambda != null && oppLambda != null) ? pickLambda - oppLambda : null;
  const pickGPG = isHomePick ? p.homeGPG : p.awayGPG;
  const oppGPG = isHomePick ? p.awayGPG : p.homeGPG;
  const pickGAA = isHomePick ? p.homeGAA : p.awayGAA;
  const oppGAA = isHomePick ? p.awayGAA : p.homeGAA;
  const pickGoalie = isHomePick ? p.homeGoalie : p.awayGoalie;
  const oppGoalie = isHomePick ? p.awayGoalie : p.homeGoalie;
  const pickGoalieSV = isHomePick ? p.homeGoalieSV : p.awayGoalieSV;
  const oppGoalieSV = isHomePick ? p.awayGoalieSV : p.homeGoalieSV;
  const pickGoalieSrc = isHomePick ? p.homeGoalieSource : p.awayGoalieSource;
  const oppGoalieSrc = isHomePick ? p.awayGoalieSource : p.homeGoalieSource;
  const goalieSrc = (src) => src === 'starter' ? '' : src === 'team' ? ' (team)' : '';
  const pickB2B = isHomePick ? p.homeB2B : p.awayB2B;
  const oppB2B = isHomePick ? p.awayB2B : p.homeB2B;
  return [
    { label: 'Pick λ goals', value: dec2(pickLambda), color: tier(pickLambda, 3.5, 3.0) },
    { label: 'Opp λ goals', value: dec2(oppLambda), color: tierLow(oppLambda, 3.0, 3.5) },
    { label: 'Margin (goals)', value: margin == null ? null
        : `${margin >= 0 ? '+' : ''}${margin.toFixed(2)}`,
      color: margin == null ? null : margin > 0.3 ? GREEN : margin > 0 ? YELLOW : RED },
    { label: 'Pick goalie SV%', value: pickGoalieSV == null ? null
        : `${(pickGoalieSV * 100).toFixed(1)}%${goalieSrc(pickGoalieSrc)}${pickGoalie ? ` (${pickGoalie})` : ''}`,
      color: tier(pickGoalieSV, 0.915, 0.895) },
    { label: 'Opp goalie SV%', value: oppGoalieSV == null ? null
        : `${(oppGoalieSV * 100).toFixed(1)}%${goalieSrc(oppGoalieSrc)}${oppGoalie ? ` (${oppGoalie})` : ''}`,
      color: tierLow(oppGoalieSV, 0.895, 0.915) },
    { label: 'Pick GPG', value: dec2(pickGPG), color: tier(pickGPG, 3.5, 3.0) },
    { label: 'Opp GAA', value: dec2(oppGAA), color: tier(oppGAA, 3.5, 3.0) },
    { label: 'Pick GAA', value: dec2(pickGAA), color: tierLow(pickGAA, 3.0, 3.5) },
    { label: 'Opp GPG', value: dec2(oppGPG), color: tierLow(oppGPG, 3.0, 3.5) },
    pickB2B ? { label: 'Pick B2B', value: 'yes', color: RED } : null,
    oppB2B ? { label: 'Opp B2B', value: 'yes', color: GREEN } : null,
  ].filter(Boolean);
}

// NHL spread — same backbone as NHL ML plus line + cover-by surplus.
function buildNhlSpreadInputs(p) {
  const base = buildNhlMlInputs(p);
  const pickLineStr = p.pickLine == null ? null : (p.pickLine > 0 ? `+${p.pickLine}` : `${p.pickLine}`);
  const isHomePick = p.pickTeam === p.homeTeam;
  const pickLambda = isHomePick ? p.homeLambda : p.awayLambda;
  const oppLambda = isHomePick ? p.awayLambda : p.homeLambda;
  const margin = (pickLambda != null && oppLambda != null) ? pickLambda - oppLambda : null;
  const needed = p.pickLine != null ? -p.pickLine : null;
  const surplus = (margin != null && needed != null) ? margin - needed : null;
  return [
    { label: 'Spread', value: pickLineStr, color: GRAY },
    { label: 'Cover by', value: surplus == null ? null
        : `${surplus >= 0 ? '+' : ''}${surplus.toFixed(2)}`,
      color: surplus == null ? null : surplus > 0.3 ? GREEN : surplus > 0 ? YELLOW : RED },
    ...base,
  ];
}

// Humanize dc penalty keys for display — keep these in sync with api/lib/tonight/dc.js.
const _DC_LABELS = {
  kalshiStale: 'Stale Kalshi data', lowVolume: 'Low Kalshi volume', wideSpread: 'Wide Kalshi spread',
  mlbLineupNotConfirmed: 'MLB lineup not confirmed', mlbLineupUnknown: 'MLB lineup unknown',
  oppLineupProjected: 'Opp lineup projected',
  nbaLineupNotPosted: 'NBA lineup not posted', nbaBench: 'NBA bench / not starting',
  wnbaLineupNotPosted: 'WNBA lineup not posted', wnbaBench: 'WNBA bench / not starting',
  noStdBF: 'No std-BF data (rookie / small sample)', highStdBF: 'Volatile starter (high stdBF)',
  tinyBvPSample: 'Tiny BvP sample (<5g)', smallBvPSample: 'Small BvP sample (<10g)', modestBvPSample: 'Modest BvP sample (<16g)',
  noSoftGames: 'No soft-games sample',
  noHomeWhipSource: 'No home WHIP source', homeWhipTeamFallback: 'Home WHIP = team fallback',
  noAwayWhipSource: 'No away WHIP source', awayWhipTeamFallback: 'Away WHIP = team fallback',
  homeBullpenTeamFallback: 'Home bullpen = team fallback', awayBullpenTeamFallback: 'Away bullpen = team fallback',
  oppBullpenTeamFallback: 'Opp bullpen = team fallback',
  nhlHomeGoalieTeamFallback: 'Home goalie = team GAA fallback', nhlAwayGoalieTeamFallback: 'Away goalie = team GAA fallback',
  homeGoalieTeamFallback: 'Home goalie = team GAA fallback', awayGoalieTeamFallback: 'Away goalie = team GAA fallback',
  nbaHomeHeavyInjury: 'Home heavy injury (≥30% USG out)', nbaAwayHeavyInjury: 'Away heavy injury (≥30% USG out)',
  wnbaHomeHeavyInjury: 'Home heavy injury (≥30% USG out)', wnbaAwayHeavyInjury: 'Away heavy injury (≥30% USG out)',
  spreadModelMarketDivergent: 'Model/market margin divergence >10 pts',
  farFromLine: 'Far from O/U line', modestlyFromLine: 'Modestly far from O/U line',
  seasonRateDivergent: 'Season-rate divergent (clamped)',
  homeLineupHeavyOut: 'Home ≥2 hitters out', awayLineupHeavyOut: 'Away ≥2 hitters out',
  scoringLineupHeavyOut: 'Scoring team ≥2 hitters out',
  homePitcherOnIL: 'Home pitcher on IL', awayPitcherOnIL: 'Away pitcher on IL',
  oppPitcherOnIL: 'Opp pitcher on IL',
  playerOut: 'Player Out', playerQuestionable: 'Player questionable',
};
// Append dc penalty rows after the play-type-specific lambda inputs. Each penalty becomes a
// red-tinted row showing humanized label + signed point value. Skipped when dcPenalties is
// missing/empty. Also shows the resulting dc score + gate for context.
function _appendDcRows(inputs, p) {
  const pens = p?.dcPenalties || {};
  const keys = Object.keys(pens);
  if (!keys.length && p?.dataConfidence == null) return inputs;
  const rows = [];
  // Header: dc score + gate
  if (p?.dataConfidence != null) {
    const dc = p.dataConfidence;
    const gate = p.dcGate ?? null;
    const dcColor = dc >= 9 ? GREEN : dc >= 7 ? YELLOW : RED;
    rows.push({ label: 'Data Confidence',
      value: `${dc}/10${gate != null ? ` (gate ≥${gate})` : ''}`, color: dcColor });
  }
  for (const k of keys) {
    const v = pens[k];
    if (v == null || v === 0) continue;
    rows.push({ label: _DC_LABELS[k] || k, value: `${v > 0 ? '+' : ''}${v}`, color: v < 0 ? RED : YELLOW });
  }
  return [...inputs, ...rows];
}

// Dispatcher — picks the right builder per play type, then appends DC penalty rows so users
// see WHY dc dropped below the gate (and where the model is operating on shaky data).
export function buildLambdaInputs(p) {
  const { sport, stat, gameType } = p;
  let inputs;
  if (gameType === 'total') {
    inputs = sport === 'mlb' ? buildMlbTotalInputs(p)
      : (sport === 'nba' || sport === 'wnba') ? buildNbaTotalInputs(p)
      : sport === 'nhl' ? buildNhlTotalInputs(p)
      : [];
  } else if (gameType === 'teamTotal') {
    inputs = sport === 'mlb' ? buildMlbTeamTotalInputs(p)
      : sport === 'nba' ? buildNbaTeamTotalInputs(p)
      : [];
  } else if (gameType === 'ml') {
    inputs = sport === 'mlb' ? buildMlbMlInputs(p)
      : (sport === 'nba' || sport === 'wnba') ? buildNbaWnbaMlInputs(p)
      : sport === 'nhl' ? buildNhlMlInputs(p)
      : [];
  } else if (gameType === 'spread') {
    inputs = sport === 'mlb' ? buildMlbSpreadInputs(p)
      : (sport === 'nba' || sport === 'wnba') ? buildNbaWnbaSpreadInputs(p)
      : sport === 'nhl' ? buildNhlSpreadInputs(p)
      : [];
  } else if (sport === 'mlb' && stat === 'strikeouts') {
    inputs = buildMlbKInputs(p);
  } else if (sport === 'mlb') {
    inputs = buildMlbHitterInputs(p);
  } else if (sport === 'nba') {
    inputs = buildNbaPropInputs(p);
  } else if (sport === 'wnba') {
    inputs = buildWnbaPropInputs(p);
  } else if (sport === 'nhl') {
    inputs = buildNhlPropInputs(p);
  } else {
    inputs = [];
  }
  return _appendDcRows(inputs, p);
}

// Model output mini-section — expected value + sigma (if Normal) + final probability.
export function buildModelOutput(p) {
  const isUnder = p.direction === 'under';
  const truePct = isUnder ? (p.noTruePct ?? p.truePct) : p.truePct;
  const probStr = truePct != null ? `${truePct.toFixed(1)}%` : null;
  if (p.gameType === 'total' || p.gameType === 'teamTotal') {
    const expected = p.expectedTotal ?? p.teamExpected;
    return { expected: expected != null ? expected.toFixed(1) : null, prob: probStr };
  }
  if (p.gameType === 'ml') {
    // Pick team's expected runs is the cleanest single number for ML; margin is in the input list.
    const isHomePick = p.pickTeam === p.homeTeam;
    const pickLambda = isHomePick ? p.homeLambda : p.awayLambda;
    return { expected: pickLambda != null ? pickLambda.toFixed(1) : null, prob: probStr };
  }
  if (p.sport === 'mlb' && p.stat === 'strikeouts') {
    return { expected: p.expectedKs != null ? p.expectedKs.toFixed(1) : null, prob: probStr };
  }
  // For other player props we don't emit an explicit expected value; just show the probability
  return { prob: probStr };
}
