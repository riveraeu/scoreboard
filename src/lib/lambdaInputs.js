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
    { label: 'Opp lineup K%', value: p.lineupKPct == null ? null
        : `${p.lineupKPct.toFixed(1)}%${p.lineupConfirmed ? '' : ' (proj)'}`,
      color: tier(p.lineupKPct, 24, 22) },
    { label: 'K H2H Hand', value: p.kH2HHandRate == null || (p.kH2HHandStarts ?? 0) < 5 ? null
        : `${p.kH2HHandRate.toFixed(0)}% (${p.kH2HHandStarts} GS)`,
      color: tier(p.kH2HHandRate, 80, 65) },
    { label: 'Hit rate ≥thr', value: p.blendedHitRate == null ? null : `${p.blendedHitRate.toFixed(0)}%`,
      color: tier(p.blendedHitRate, 90, 80) },
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
    { label: 'Pace adj', value: p.wnbaPaceAdj == null ? null
        : `${p.wnbaPaceAdj > 0 ? '+' : ''}${p.wnbaPaceAdj.toFixed(1)}`,
      color: p.wnbaPaceAdj == null ? null
        : p.wnbaPaceAdj > 0 ? GREEN : p.wnbaPaceAdj > -2 ? YELLOW : GRAY },
    { label: 'Rest', value: p.isB2B == null ? null : (p.isB2B ? 'B2B' : 'Rested'),
      color: p.isB2B == null ? null : (p.isB2B ? RED : GREEN) },
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
    { label: 'Season rate', value: pct0(p.seasonPct), color: tier(p.seasonPct, 75, 65) },
    { label: 'Soft tier rate', value: pct0(p.softPct), color: tier(p.softPct, 75, 65) },
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
  ];
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
  ];
}

function buildNbaTeamTotalInputs(p) {
  const isUnder = p.direction === 'under';
  return [
    { label: 'Team OffRtg', value: dec1(p.teamOffRtg), color: tierDir(isUnder, p.teamOffRtg, 118, 113) },
    { label: 'Opp DefRtg', value: dec1(p.oppDefRtg), color: tierDir(isUnder, p.oppDefRtg, 118, 113) },
    { label: 'Team expected', value: dec1(p.teamExpected), color: GRAY },
    { label: 'Game spread', value: p.gameSpread == null ? null
        : `${p.gameSpread > 0 ? '+' : ''}${p.gameSpread}`,
      color: p.gameSpread == null ? null
        : Math.abs(p.gameSpread) <= 5 ? GREEN : Math.abs(p.gameSpread) <= 10 ? YELLOW : RED },
    { label: 'H2H ≥thr', value: p.h2hHitRate == null ? null
        : `${p.h2hHitRate}%${p.h2hGames ? ` (${p.h2hGames}g)` : ''}`,
      color: tierDir(isUnder, p.h2hHitRate, 60, 40) },
    { label: 'Ssn ≥thr', value: p.ttNbaSeasonHitRate == null ? null
        : `${p.ttNbaSeasonHitRate}%`, color: tierDir(isUnder, p.ttNbaSeasonHitRate, 50, 35) },
    { label: 'Playoff boost', value: p.playoffBoost == null ? null
        : `×${p.playoffBoost.toFixed(2)}`, color: isUnder ? RED : GREEN },
  ];
}

// Dispatcher — picks the right builder per play type
export function buildLambdaInputs(p) {
  const { sport, stat, gameType } = p;
  if (gameType === 'total') {
    if (sport === 'mlb') return buildMlbTotalInputs(p);
    if (sport === 'nba' || sport === 'wnba') return buildNbaTotalInputs(p);
    if (sport === 'nhl') return buildNhlTotalInputs(p);
    return [];
  }
  if (gameType === 'teamTotal') {
    if (sport === 'mlb') return buildMlbTeamTotalInputs(p);
    if (sport === 'nba') return buildNbaTeamTotalInputs(p);
    return [];
  }
  if (sport === 'mlb' && stat === 'strikeouts') return buildMlbKInputs(p);
  if (sport === 'mlb') return buildMlbHitterInputs(p);
  if (sport === 'nba') return buildNbaPropInputs(p);
  if (sport === 'wnba') return buildWnbaPropInputs(p);
  if (sport === 'nhl') return buildNhlPropInputs(p);
  return [];
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
  if (p.sport === 'mlb' && p.stat === 'strikeouts') {
    return { expected: p.expectedKs != null ? p.expectedKs.toFixed(1) : null, prob: probStr };
  }
  // For other player props we don't emit an explicit expected value; just show the probability
  return { prob: probStr };
}
