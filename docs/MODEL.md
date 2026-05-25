# Scoreboard — Model Reference

Per-sport modeling internals. CLAUDE.md has the architecture map and load-bearing gotchas; this file is the deep reference for play-generation logic.

---

## Universal definitions
- **SimScore**: 5 components × 2pts each → max 10. Qualifies at ≥ 8. Null component → 1pt abstain (unless noted otherwise).
- **Edge gate**: `edge = truePct − kalshiPct ≥ 3%`. `kalshiPct` is already the fill price (ask or blended orderbook walk); `spreadAdj` is computed but **not** subtracted.
- **`pct ∈ [67, 91]` filter**: universal qualification window for player props, game totals, and team totals. UNDER discovery uses `noKalshiPct ∈ [67, 91]`. Tunables `KALSHI_GATE` / `KALSHI_CAP` / `EDGE_GATE` / `SIMSCORE_GATE` live in both `api/[...path].js` and `src/App.jsx` — change in both places.
- **UNDER plays** (totals only): `underEdge = (100−truePct) − (100−kalshiPct) ≥ 3%` AND `noKalshiPct ∈ [67, 91]`. `direction:"under"`, badge red, bars use `noTruePct`/`noKalshiPct`, prose colors inverted, track ID appends `|under`.
- **dataConfidence** (0–10, penalty-based since 2026-05-15 refactor): score of input-data trust, separate from SimScore (which scores matchup favorability). Starts at 10, subtracts penalties for issues, clamps `[0, 10]`. Computed centrally in `_computeDataConfidence` in `/api/tonight`; emitted as `dataConfidence`, `dcPenalties: {reason: -cost}` (only non-zero entries), `dcQualified: bool` (= `dataConfidence >= DC_GATE[sport]`), and `dcGate` (per-sport threshold). Per-sport AND per-play-type gates: **player props — MLB/NBA 9, WNBA/NHL 8**; **totals/teamTotals — MLB/NBA 10, WNBA/NHL 9**; **ml — MLB 8** (loosened from 10 on 2026-05-18; ML-only gate). Totals get a stricter gate because they don't accumulate the per-player penalties props do (lineup confirmation, softGames, etc.), so a flat gate would let totals dominate the qualified feed. WNBA/NHL get -1 across the board for structural data gaps. `dcQualified` is **emitted but not actively filtering**; the v2 model toggle adopts it as the gate in Phase B. Penalty table:
  - **Market quality**: `_kalshiStale` → -4 · `lowVolume` → -2 · `kalshiSpread ≥ 5` → -1
  - **Lineup**: MLB `lineupConfirmed/lineupsConfirmed === false` (or undefined) → -3 · NBA team not in `confirmedTeams` → -2 · NBA confirmed bench → -2 · WNBA/NHL structural → -1
  - **Availability** (player props): `playerStatus` `"out"/"inactive"` → -10 (effective drop) · `"questionable"/"doubtful"/"GTD"` → -2
  - **Sample size**:
    - MLB-K: `stdBF == null` → -3 · stdBF > 2.5 → -1
    - MLB-Hitter: `softGames < 5` (or null) → -3 · 5–9 → -2 · 10–15 → -1
    - NBA/WNBA/NHL prop: `softGames < 5` → -2 · 5–9 → -1 · absent → -1
    - Game total: `gtSsnSample == null` → -3 · <10 → -2 · 10–29 → -1
    - Team total: `h2hGames == null` → -3 · <3 → -2 · 3–5 → -1
  - **Opp data**:
    - MLB-K: `lineupKPct == null` → -3 · opp lineup projected (not confirmed) → -1
    - MLB-Hitter: `hitterH2HSource == null` → -3 · `"hand"` (handedness only) → -1
    - NBA prop: both `dvpRatio` AND `oppRank` null → -3 · `dvpRatio` null only → -1
    - WNBA prop: `oppRank == null` → -3 · `dvpRatio` structural (always null) → -1
    - NHL prop: `oppMetricValue == null` → -3
    - Game totals: `gameOuLine == null` → -2
    - MLB teamTotal: `oppWHIPSource == null` → -3 · `"team"` (fallback) → -1
    - NBA teamTotal: `oppDefRtg == null` → -3
  - **Threshold-distance from O/U line** (totals & team totals only): tail probabilities are noisier than central ones. Per-sport buckets — for team totals, half-line heuristic uses `gameOuLine / 2`:
    - MLB total: dist ≥ 3 → -1, ≥ 5 → -2 · teamTotal: ≥ 2 → -1, ≥ 3 → -2
    - NBA total: ≥ 10 → -1, ≥ 20 → -2 · teamTotal: ≥ 5 → -1, ≥ 10 → -2
    - WNBA total: ≥ 10 → -1, ≥ 20 → -2 · teamTotal: ≥ 5 → -1, ≥ 10 → -2
    - NHL total: ≥ 2 → -1, ≥ 3 → -2 · teamTotal: ≥ 1 → -1, ≥ 2 → -2
  - **Season-rate divergence** (game + team totals): when the rate-inverted implied mean/lambda diverges from the model mean/lambda (`teamExpected` for team totals) by more than the per-sport cap, the blend math is clamped in the simulate path and the resulting truePct is built on softened evidence. Game-total caps `_GT_IMPLIED_CAP`: NBA pts ≥ 8, WNBA ≥ 6, MLB runs ≥ 1.5, NHL goals ≥ 1.0. Team-total caps `_TT_IMPLIED_CAP` (tighter — single-team std is smaller): NBA pts ≥ 6, MLB runs ≥ 1.0. Trigger → `seasonRateDivergent` -2. The cap itself stops runaway inversions at far-from-line thresholds where seasonHitRate is near 0/100; the dataConfidence penalty stops the dampened pick from passing the v2 dcGate.
  - **MLB game total — both starters via starter source**: pitcher quality is the primary lambda input, so a team-WHIP fallback is a real trust hit. Per-side check — worst case -4 (both unknown).
    - `homeWHIPSource == null` → -2 · `"team"` (fallback) → -1
    - `awayWHIPSource == null` → -2 · `"team"` (fallback) → -1
  - **MLB game/team total — bullpen ERA source**: 40% rest-of-game share prefers bullpen-only ERA; whole-staff fallback is tolerable but double-counts the starter. -1 per side (game total max -2, team total max -1).
    - Game total: `homeBullpenSource === "team"` → -1 · `awayBullpenSource === "team"` → -1
    - Team total: `oppBullpenSource === "team"` → -1
  - **NHL game total — starting goalie SV%**: opponent factor is keyed off tonight's goalie when known; team-GAA fallback is a smaller trust hit. Per-side check — worst case -2 (both unknown).
    - `homeGoalieSource === "team"` → -1
    - `awayGoalieSource === "team"` → -1

---

## MLB Strikeouts
**True%**: `simulateKsDist(orderedKPcts, pitcherKPct, parkFactor, nSim, totalPA, earlyExitProb, stdBF)` → `kDistPct(dist, threshold)`. Shared distribution per pitcher (key `team|hand`) guarantees monotonicity. nSim 10k if simScore ≥ 8 else 5k.

**Adjustments inside `simulateKsDist`**:
- TTO decay: K% × `TTO_DECAY_FACTOR (0.88)` for BF ≥ 19
- Blowout hook: `_earlyExitProb` from pitcher team ML (`+150→8%, +200→12%, +250+→18%`); each trial may pull pitcher early (BF = rand[10,15])
- stdBF variance: each trial samples `trialPA ~ Normal(totalPA, stdBF)` clamped [10,27] via scoped Box-Muller (function-scoped to prevent cross-request races). 0 if <3 qualified starts.

**Pre-sim adjustments**:
- A1 recent form: effective K% = `recentKPct × 0.6 + seasonKPct × 0.4` when ≥3 starts and 30+ BF in last 5 (uses `a1Splits` filter, no NP minimum)
- A2 rest/fatigue: × 0.96 if days since last start ≤ 3; × 0.92 if also last PC ≥ 95
- E3a umpire: `pitcherKPctAdj = min(40, pitcherKPctOut × umpireKFactor)`; lookup is ASCII-normalized
- K% regression: `trust = min(1, bf26/200)` blends 2026 actual with 2025 anchor (or league avg 22.2%)
- E3b expectedBF: `clamp(round(_avgBF), 15, 27)`. Fallback chain: `pitcherStatsByName.avgBF` → `sportByteam.mlb.pitcherAvgBF` (team key) → `clamp(round(avgP/3.85), 15, 27)`. Default 24. Both `avgP` and `avgBF` are sample-weighted blends of 2026 and 2025 anchors: `trust26 = min(1, gs26/15)`, blended = `trust26 × val26 + (1 − trust26) × val25`. Stabilizes early-season ramp-up workloads (e.g. Skenes 2026 avgP=81 with ~7 starts blended toward his 2025 ace baseline ~95) where raw 2026 sample alone would tank expectedBF and the K-market truePct. Pitchers with only one season's data use it as-is.
  - **Pitch-limited start cap**: when `pitcherLastStartPC ≤ 70` AND `gs26 < 5`, the pitcher is on a build-up (e.g., spot starter coming up from bullpen). The 2025 anchor still dominates the blend (`1 − trust26 ≥ 80%`), over-projecting volume relative to recent reality. Cap `_expectedBF = min(blended, round(lastStartPC / 3.85 + 3))` — last start's pitch count converted to BF at league-average 3.85 P/PA, plus a 3-BF cushion for moderate progression to the next outing. Floor stays at 15. Only fires when the cap is *below* the blend, so normal starters are unaffected.

**SimScore**:
- `kpctPts` — CSW% (≥30→2, >26→1, ≤26→0); falls back to regressed K% (>27/>24/≤24)
- `lkpPts` — Lineup oK% hand-adjusted (>24→2, >22→1, ≤22→0)
- `kHitRatePts` — Trust-weighted blend of 2026 observed and 2025 computed K-threshold hit rate (≥90→2, ≥80→1, <80→0). `trust26 = min(1, vals26.length/15)`. `blendedHitRate` is the value. **Pitcher gamelog is filtered to starts only** (`IP ≥ 3.0 AND TBF ≥ 12`) — ESPN gamelog returns all appearances incl. relief stints; mixing them in would tank per-threshold hit rate (e.g. Ashcraft 2025: 8 starts but 26 total appearances → unfiltered hit rate at ≥4 K was ~31%, start-only is ~95%). Filter applied once at `playerColCache` build (`_evtPool`); all downstream pitcher-K consumers (`vals25`/`vals26`/`_bf26`/`seasonPct`/soft-bucket history) operate on starter-only data.
- `kH2HHandPts` — Pitcher's K hit rate vs opponents whose lineup hand majority matches tonight's. Tonight uses full switch-hitter adjustment (S vs RHP→L); historical uses `staticTeamHandMajority` (S = 0.5R + 0.5L). ≥5 starts required (≥80→2, ≥65→1, <65→0). **Folded into K lambda 2026-05-13**: `_kHandAdj = clamp(h2hHandRate / 70, [0.90, 1.10])` multiplies into `_pitcherKPctAdj` before `simulateKsDist`. Was SimScore-only.
- `totalPts` — O/U tier (≤7.5→2, <10.5→1, ≥10.5→0)

**Display-only fields** (not in SimScore, kept for debug/calibration): `kbbPts`, `parkMeets`, `mlPts`, `kTrendPts` (calibration breakdown only — no longer shown in prose), `pitchesPts`. Recent K% still drives the A1 effective-K blend in the model; just removed from explanations to declutter.

**Gates** (in addition to SimScore ≥ 8):
1. Threshold sanity: `threshold > ceil(expectedKs) + 2` → `qualified:false` (only when lineup confirmed and expectedKs available)
2. Insufficient_starts: if `pitcherHasAnchor !== true` (gs25 ≥ 5 AND bf25 ≥ 100) requires `gs26 ≥ 8`. Catches TJ-return / pure-reliever cases. Checked in pre-filter AND main loop.

---

## MLB Hitters (HRR)
**True%**: logit-sigmoid base-rate adjustment with park, hitter OPS, and pitcher WHIP shifts (no Monte Carlo for HRR — `simulateHits` removed when MLB hits stat dropped 2026-05-16).
```
# BvP shrinkage (2026-05-16) — only when hitterH2HSource === "bvp"
N = 20                                                       # prior weight in games
shrunkSoftPct = (softGames·softPct + N·primaryPct) / (softGames + N)
rawMlbPct = (primaryPct + shrunkSoftPct) / 2
opsAdj  = clamp(hitterOPS / 0.720, [0.85, 1.15])             # weight 0.4 in logit
whipAdj = clamp((pitcherWHIP / 1.30)^0.5, [0.92, 1.08])      # weight 0.3 in logit (third-order)
truePct = sigmoid(logit(rawMlbPct/100) + ln(parkFactor) + 0.4·ln(opsAdj) + 0.3·ln(whipAdj)) × 100
```
- **BvP shrinkage added 2026-05-16**: small-sample BvP rates (10 games at 100%) were dominating the 50/50 blend. Bayesian-style: at softGames=20 the blend is 50/50 BvP/season-prior; at softGames=10, BvP gets ~33% weight. Hand-source `softPct` skips shrinkage (handedness samples are large by definition).
- OPS folded into lambda 2026-05-13 (was SimScore-only). Top-quartile (~.850) lifts truePct ~1.5–2pt.
- WHIP folded into lambda 2026-05-13 (was SimScore-only). Lower weight than OPS; high-WHIP pitcher → more contact → higher HRR base rate beyond what BvP captures.
- `primaryPct` = 2026 HRR 1+ rate (fallback: 2025+2026 blend, then career)
- `softPct` = HRR 1+ rate vs tonight's pitcher (BvP, ≥10 games). **Handedness fallback** when BvP <10: `batterHRRSplits[name][vsR/vsL]` (MLB Stats API, 2025+2026 combined), Poisson approx `1 − e^(−lambda)` where `lambda = totalHRR/games`; ≥10 games vs that hand required. `softLabel` set to `"vs RHP"`/`"vs LHP"`.
- B2 batter recent form: `hitterEffectiveBA = 0.3 × recentBA + 0.7 × seasonBA` when ≥20 AB in last 10 (used by `simulateHits`, not HRR formula)

**SimScore**:
- `hitterOpsPts` — 2026 OPS (≥.850→2, ≥.720→1, <.720→0). Fetched via 7th parallel request in `buildLineupKPct`.
- `hitterWhipPts` — Pitcher WHIP (>1.35→2, >1.20→1, ≤1.20→0)
- `hitterSeasonHitRatePts` — Blended season HRR rate (≥80→2, ≥70→1, <70→0). `trust26 = min(1, vals26.length/30)`.
- `hitterH2HHitRatePts` — BvP path (≥10g): ≥80→2, ≥70→1; or handedness path (<10 BvP, hand known, ≥10g vs hand): same tiers. `hitterH2HSource` = `"bvp"|"hand"|"abstain"`.
- O/U tier (≥9.5→2, ≥7.5→1, <7.5→0)

**Gates**: lineup spot 1–5 required (6+ dropped); `low_lineup_spot` and `hitterSimScore < 5` are pre-gates that do NOT push to `plays[]`.

**Pitcher data fallback chain** (for `hitterPitcherName`/`hitterPitcherEra`, also for gamelog loading):
1. `sportByteam.mlb.probables[oppAbbr]` (ESPN scoreboard)
2. `sportByteam.mlb.pitcherInfoByTeam[oppAbbr]` (MLB Stats API — announced day before, very reliable)
3. `pitcherGamelogs[oppAbbr].name` (if gamelog loaded)

Included in **all** drop objects so the market report renders pitcher info for non-qualified rows.

---

## NBA player props
**True%**: `buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim, miscAdj)` → `nbaDistPct`. Dist cached per `playerId|stat` so all thresholds share one distribution. Mean from last 10, std from full season. Adjusted: `× teamDefFactor × (1 + paceAdj×0.002) × 0.93 if B2B × miscAdj`. nSim scales with pre-edge simScore (≥8 → 10k, ≥5 → 5k, else 2k).

**`miscAdj` = C2 × C3 × C4**:
- C2 injury boost: `1.08` per Out player on own team, capped 1.15× (from `buildNbaInjuryReport`)
- C3 blowout risk: `max(0.85, 1 − (|spread|−10) × 0.007)` when `|spread| > 10`
- C4 home/away split: `splitMean / overallMean` weighted (0.7 home / 0.3 away)

`teamDefFactor` = general team defense (`rankMap[opp].value / leagueAvg`), NOT position-adjusted. Falls back to `avg(seasonPct, softPct) − 4% if B2B` when sim returns null (<5 game values).

**SimScore**:
- C1 stat-specific opportunity (from `buildNbaUsageRate`):
  - points/assists/threePointers: USG% ≥28→2, ≥22→1, <22→0 (USG% formula: `(avgFGA + 0.44×avgFTA + avgTO) / (avgMin × 2.255) × 100` — ESPN `usageRate` is 0.0 so fallback always runs)
  - rebounds: avgMin ≥30→2, ≥25→1, <25→0
- DVP ratio (`dvpRatio`): ≥1.05→2, ≥1.02→1, else 0
- `nbaSeasonHitRatePts` — `primaryPct` at threshold (≥90→2, ≥80→1, <80→0)
- `nbaSoftHitRatePts` — `softPct` = hit rate vs teams in **same DVP tier** as tonight's opp (rank 1–10 soft, 11–20 neutral, 21–30 hard). ≥90→2, ≥80→1, <80→0.
- `nbaTotalPts` — Game O/U (≥215→2, <215→0). Game totals from `sportByteam.nbaGameOdds`. Pace applied to sim mean but NOT scored.

**Gates**: edge ≥ 3%, nbaSimScore ≥ 8. No soft-matchup pre-filter — all NBA markets enter the play loop.

---

## WNBA player props
Kalshi series: `KXWNBAPTS`, `KXWNBAREB`, `KXWNBAAST`, `KXWNBA3PT`. No team totals on Kalshi (mirrors NHL/NFL).

**True%**: reuses `buildNbaStatDist` + `nbaDistPct`. Cache key `wnbaPlayerDistCache[playerId|stat]`. Same formula as NBA: `× teamDefFactor × (1 + paceAdj×0.002) × 0.93 if B2B × wnbaMiscAdj`. nSim scales with pre-edge simScore.

**Anchor**: 2025 season as base; 2026 trust ramps `vals26.length/10` (vs NBA's `/15`) because the WNBA season is ~40g vs 82g, so equivalent trust accumulates faster relative to season length.

**SimScore — calibrated to WNBA scoring environment**:
- C1 opportunity (from `buildWnbaUsageRate`):
  - points/assists/threePointers: USG% ≥27→2, ≥22→1, <22→0 (vs NBA 28/22 — slightly compressed)
  - rebounds: avgMin ≥27→2, ≥22→1, <22→0 (vs NBA 30/25 — 40-min game vs 48)
- DVP ratio (`dvpRatio`): ≥1.05→2, ≥1.02→1, else 0 (same tiers as NBA, single-tier from `buildWnbaDvp` aggregate — no per-position split, no BettingPros equivalent)
- `wnbaSeasonHitRatePts` — `primaryPct` at threshold (≥90/≥80, same as NBA)
- `wnbaSoftHitRatePts` — same DVP-tier matching as NBA
- `wnbaTotalPts` — Game O/U: ≥168→2, ≥158→1, <158→0 (vs NBA 215/215; WNBA totals run 150–175)

**USG fallback formula adjustment**: `(avgFGA + 0.44·avgFTA + avgTO) / (avgMin × 1.88) × 100` — coefficient 1.88 = NBA's 2.255 × (40/48) to rescale for 40-min game. Without this rescale, WNBA USG would be ~20% inflated relative to NBA tiers.

**Gates**: edge ≥ 3%, wnbaSimScore ≥ 8.

---

## NHL Points
**True%**: reuses `buildNbaStatDist` + `nbaDistPct`. Cache key `nhlPlayerDistCache[playerId|stat]`. Adjusted: `× teamDefFactor × (1 + shotsAdj×0.002) × 0.93 if B2B × nhlToiTrendAdj`. `teamDefFactor` = opp GAA / league avg.

**D3 TOI trend** (passed as `miscAdj`): `clamp(recent3TOI / last10TOI, 0.92, 1.08)`. Only applied when ratio >1.05 or <0.95.

**SimScore**:
- `nhlOpportunity` — Avg TOI last 10 (≥18min→2, ≥15min→1, <15→0)
- `_gaaRank` — Opp GAA rank (≤10→2, ≤15→1, else 0)
- `nhlSeasonHitRatePts` — Career rate at threshold (≥90→2, ≥80→1, <80→0)
- `nhlDvpHitRatePts` — Rate vs teams with GAA > league avg (≥3 qualifying games; ≥90→2, ≥80→1, <80→0)
- `nhlGameTotal` — O/U line (≥7→2, ≥5.5→1, <5.5→0)

Display-only: `nhlSaRank`, `nhlTeamGPG`. **B2B detection**: last gamelog event was yesterday UTC.

---

## NFL
Stats: `passingYards`, `rushingYards`, `receivingYards`, `receptions`, `completions`, `attempts`. Gate: opp in soft teams; edge ≥ 3%.

---

## Game Totals (MLB/NBA/WNBA/NHL/NFL)
Kalshi series: `KXMLBTOTAL`, `KXNBATOTAL`, `KXWNBATOTAL`, `KXNHLTOTAL`, `KXNFLTOTAL`. `gameType: "total"`. Market format: `floor_strike = N` means YES = total ≥ N (i.e. "over N−0.5").

**WNBA totals**: same possession-based projection as NBA but with `wnbaPaceData` (2025 anchor). Per-team std=11 (WNBA scoring variance roughly NBA × (40/48); empirical game-total std ~13–15). **SimScore tiers retuned**: Comb OffRtg/DefRtg ≥98/≥93 (vs NBA 118/113), Pace > leagueAvg+1 (vs +2), O/U ≥168/≥158 (vs 225/215). Pace data from ESPN `avgEstimatedPossessions` (no separate `paceFactor` field for WNBA). Sample-weighted seasonHitRate blend via `_ssnBlendWeight`, same as NBA/MLB/NHL. Same injury-adjusted OffRtg as NBA (2026-05-17, 0.15 replacement factor, cap 0.85) — WNBA rosters are smaller and stars carry larger usage shares, but starting with the same factor for calibration parity (adjust later if data shows under-correction).

**True%**: NegBin MC for MLB (added 2026-05-24), Poisson MC for NHL, Normal for NBA/WNBA. `_simData` includes per-team expected and `expectedTotal`. **All four sports blend `gtSeasonHitRate` into the lambda PRE-sim** (changed 2026-05-13 from post-sim truePct blend) — for the threshold being predicted, solve for the rate that would produce the observed seasonHitRate, then sample-weighted blend with model lambda.
- **MLB (NegBin since 2026-05-24)**: `impliedLambda = muForNegBinTail(threshold, ssnRate/100, r)`; `blendedLambda = (1-w) × modelLambda + w × impliedLambda`; `truePct = (1 - negBinCDF(threshold-1, blendedLambda, r)) × 100`. Per-team draws via `negBinSample(λ, r)` (Poisson-Gamma mixture). `r` = league-wide pooled MoM dispersion fit from `_gtScheduleMap` per request — pooled per-team residuals → `r = pooled_mean² / (pooled_var − pooled_mean)`, clamped [3, 50], fallback `r=8` when `nGames < 100`. Real MLB game totals are ~2× overdispersed vs Poisson (fat-tail big-inning behavior + thin no-hit left tail); the prior Poisson sim systematically overstated tail probabilities at far-from-line alt thresholds (May 2026 audit: 79% predicted, 54% actual on n=24 alt totalRuns). `_simData.mlbDispR` records the fit value per pick for audit. Filter MLB total / ML / spread calibration by `trackedAt < 2026-05-24`.
- **NHL (still Poisson)**: `impliedLambda = lambdaForPoissonTail(threshold, ssnRate/100)`; `blendedLambda = (1-w) × modelLambda + w × impliedLambda`; `truePct = (1 - poissonCDF(threshold-1, blendedLambda)) × 100`. NHL hasn't been audited for overdispersion yet; phase 2.
- Normal sports: `impliedMean = meanForNormalTail(threshold, ssnRate/100, totalStd)` (closed form via inverse Φ); `blendedMean = (1-w) × modelMean + w × impliedMean`; `truePct = (1 - normCDF(threshold - 0.5, blendedMean, totalStd)) × 100` (with 0.5 continuity correction).
- Total std (Normal): `sqrt(homeStd² + awayStd²)` — NBA std=13 per team → ~18.4 total; WNBA std=11 per team → ~15.6 total.
- Why pre-sim: clean attribution. seasonHitRate is now an upstream lambda input, comparable to FIP/ERA/WHIP/RPG via counterfactual Δ rather than a separate post-hoc correction.
- `_gtSeasonHitRate(sport, home, away, thr)` helper returns `{ rate, sample }` — average of home + away team's season rate of games where combined score ≥ threshold; requires ≥5 schedule games per team. Sample = `min(home games, away games)`. `_ssnBlendWeight(sample) = min(1, sample/40) × 0.7` — observations earn up to 70% weight at N≥40, model retains a 30% minimum for tonight-specific factors.
- Saves `modelTruePct` (pre-blend), `gtSeasonHitRate`, `gtSsnSample`, `modelLambda`/`impliedLambda`/`blendedLambda` (or `modelMean`/`impliedMean`/`blendedMean` for Normal) in `_simData`.
- `_gtScheduleMap` populates both teams for every sport that has game totals; `_SCHED_TO_ESPN` translates canonical → ESPN team-route slug for MLB CWS→CHW and NHL TBL→TB / NJD→NJ / LAK→LA / SJS→SJ.

**MLB edge dampener — REMOVED 2026-05-15**: previously when `|threshold − gameOuLine| ≥ 3`, `overEdge`/`underEdge` were multiplied by 0.7. Removed because (1) it was a pre-calibration heuristic, (2) dataConfidence's threshold-distance penalty now handles tail-skepticism at the gate level (one signal instead of two), (3) MLB getting a tail dampener while NBA didn't biased calibration audits. Re-introduce only if the 2026-05-27 calibration audit shows MLB tails systematically over-hit. See `project-mlb-tail-dampener-removal`.

**Schedule fetch abbr translation**: `_gtScheduleMap` (game totals) and `_ttScheduleMap` (team totals) translate canonical → ESPN team-route slug before building the schedule URL — mirrors `CANONICAL_TO_ESPN` in `/api/live`. `_SCHED_TO_ESPN` covers MLB `CWS → CHW` and NHL `TBL → TB / NJD → NJ / LAK → LA / SJS → SJ`. Cache keys keep the canonical form so cached reads are consistent. Without this, schedules for affected teams silently fetched as empty arrays, breaking H2H and game-total seasonHitRate blends for any matchup involving them.

**ESPN schedule event abbrs are NOT canonical** — they're whatever ESPN puts on each competitor (e.g. `c.abbr === "CHW"` in the events even when fetched via the `chw` slug). **Any consumer of `_gtScheduleMap` / `_ttScheduleMap` events that filters by team abbr must normalize via `normTeam(sport, c.abbr)` before comparing to canonical scoringTeam/oppTeam values.** Three sites had silent bugs where this was missing: `_gtH2HRate`, `_ttRunVals` (teamL10RPG), `_ttSeasonHits` (ttSeasonHitRate) — all caused CWS team-total picks to read `ttSeasonHitRate=0` because filters didn't match `CHW`-form abbrs. NBA equivalents (`_nbaGtH2HRate`, `_ttNbaSeasonHits`) already used `normTeam`. This is the third instance of the canonical-vs-ESPN-abbr divergence (after live-API translation and schedule URL slugs); always normalize when filtering ESPN-sourced events.

**Lambda / projection formulas**:

*MLB*:
```
whipAdj(whip)         = clamp((whip/1.30)^0.5, [0.90, 1.10])
ttoBump(expectedBF)  = 1 + clamp((expectedBF − 22)/22 × 0.30, [0, 0.10])           # 3rd-TTO penalty on FIP+ERA (since 2026-05-25)
starterMult(fip, era, whip, ttoBump)
                      = (0.5×(fip×ttoBump/4.20) + 0.5×(era×ttoBump/4.20)) × whipAdj(whip)   # FIP/ERA fallbacks apply
restERA(team)        = bullpenERA[team] ?? teamERA[team]                          # bullpen preferred (cleaner rest-of-game proxy)
awayMult = 0.6 × starterMult(awayFIP, awayERA, awayWHIP, ttoBump(awayBF)) + 0.4 × (restERA(away)/4.20)
homeMult = 0.6 × starterMult(homeFIP, homeERA, homeWHIP, ttoBump(homeBF)) + 0.4 × (restERA(home)/4.20)
homeLambda₀ = homeRoadRPG × awayMult × parkRF × homePlatoonFactor × weatherFactor × umpireRunFactor × homeLineupFactor   # clamped [1,12]
awayLambda₀ = awayRoadRPG × homeMult × parkRF × awayPlatoonFactor × weatherFactor × umpireRunFactor × awayLineupFactor   # clamped [1,12]
# Regime-aware blend (since 2026-05-25, 14-day half-life via _MLB_HALF_LIFE_DAYS):
homeLambda = (1 − w) × homeLambda₀ + w × homeRecentMean
awayLambda = (1 − w) × awayLambda₀ + w × awayRecentMean
# w = _regimeBlendWeight(min(homeSample, awaySample)) — caps at 0.85
```
- **Bullpen-only ERA folded into the 40% rest-of-game share 2026-05-17** (was whole-staff teamERA). Whole-staff ERA includes the starter who's already counted in the 60% term — double-count. Bullpen-only (`playerPool=bullpen` on MLB Stats API team-stats endpoint, one extra fetch in the MLB hydration Promise.all) is the clean rest-of-game proxy and typically runs 0.10–0.40 ERA below whole-staff. `_simData` adds `homeBullpenERA`/`awayBullpenERA` (value used) and `homeBullpenSource`/`awayBullpenSource` (`"bullpen" | "team" | null`). Same swap applied to team-total lambda via `oppBullpenERA`/`oppBullpenSource`. dataConfidence penalty -1 per side when source is `"team"` (game total max -2; team total max -1).
- 60/40 weights unchanged — workload-weighted starter share (`starterShare = expectedBF/38`) is the natural follow-up tunable but kept fixed for now so calibration can isolate the bullpen-separation impact alone.
- WHIP folded into lambda 2026-05-13 (was SimScore-only). Exponent 0.5 dampens overlap with FIP/ERA. Same adjustment applied to team-total `oppMult`.
- **FIP** (`api/lib/mlb.js` `_seasonFIP`): `((13×HR) + (3×(BB+HBP)) − (2×K)) / IP + 3.10` per season. Constant 3.10 aligns FIP onto the ~4.20 ERA scale. IP parsed from MLB Stats API string format ("45.2" = 45 ⅔). Strips fielding/sequencing luck from the starter signal — a "lucky" starter (low ERA / high FIP) gets penalized, an "unlucky" one (high ERA / low FIP) gets credit. ERA stays as the second half of the starter blend so observed run prevention still counts. `pitcherFIPByTeam` exported from `buildPitcherKPct` and surfaced as `homeFIP`/`awayFIP` in `_simData`.
- **Two-step pitcher rate regression (ERA / WHIP / FIP, added 2026-05-18)** — `_regressedRate` helper in `api/lib/mlb.js`: (1) blend 2026↔2025 by `trust26 = min(1, gs26/15)`, (2) shrink the blended estimate toward league mean by `priorIP` weight. Effective sample = `ip26 + (1−trust26)×ip25`; final = `(ip × blended + priorIP × lgMean) / (ip + priorIP)`. Constants: **ERA** lgMean=4.20, priorIP=50; **WHIP** lgMean=1.30, priorIP=50; **FIP** lgMean=4.20, priorIP=30 (FIP stabilizes faster — ~100 IP vs ~150 for ERA). Replaces the prior raw-2026-or-fall-back-to-2025 lookup for ERA/WHIP, and adds the league-anchor step to FIP (was only doing step 1). The lambda code at `api/[...path].js` (game-total ~3244, team-total ~3807, HRR ~2091) was separately patched to prefer `sportByteam.mlb.pitcherEra[t]` (regressed) over `sportByteam.mlb.probables[t].era` (raw schedule hydrate) — without this, the lambda would still see raw probables ERA even with the regression in place. FIP/WHIP go through `pitcherFIPByTeam`/`pitcherWHIPByTeam` so they pick up the regression directly. Net effect: extreme small-sample seasons pull meaningfully toward 4.20/1.30 while full-season ace/scrub gaps survive. MLB-K unaffected (uses regressed `pitcherKPct`/`pitcherCSWPct`, not ERA/WHIP). Pre-2026-05-18 MLB total/team-total/ML calibration data used raw rates — filter `trackedAt < 2026-05-18` when comparing lambda accuracy.
- **Platoon factor**: `(lineup composite BA vs starter's hand) / (lineup composite overall BA)` from `batterSplitBA`. Falls back to 1.0 when hand unknown or sample <80 AB. **Note**: MLB Stats API `/teams/stats` does NOT support pitcher-handedness sitCodes (`vl/vr` returns empty) — handedness splits are individual-only. Same factor applied to team total lambda.
- **Weather factor**: `1 + windOutMph × 0.013 + (tempF − 72) × 0.001`, clamped [0.85, 1.15]. `windOutMph` parsed from ESPN `displayValue` ("Out to LF/CF/RF" positive, "In from..." negative, "L to R"/"R to L" = 0). Skipped for `_MLB_DOMED` parks (TB/TOR/HOU/MIA/SEA/ARI/TEX/MIL).
- **Road RPG**: from MLB Stats API `sitCodes=A`, stored as `mlbRoadRPGMap`.
- `umpireRunFactor = 1 / UMPIRE_KFACTOR` applied to both lambdas (and team total lambda).
- **TTO penalty on starter (added 2026-05-25)**: 3rd-time-through-order PAs run ~0.50 ERA / 15% wOBA higher than 1st. When `pitcherAvgBF[team] > 22`, the starter's FIP and ERA inputs are multiplied by `ttoBump = 1 + clamp((expectedBF − 22)/22 × 0.30, [0, 0.10])` — ramps from 1.0 at BF=22 to 1.10 at BF≥29. WHIP is a traffic measure (not run-rate) so it stays untouched. ML/spread inherit via `_mlbMlContext`. `_simData` adds `homeExpectedBF`/`awayExpectedBF` + `homeTtoBump`/`awayTtoBump` when bump > 1.0. Filter `trackedAt < 2026-05-25` from MLB total/team-total/ML/spread calibration for this change.
- **Regime-aware lambda blend (added 2026-05-25)**: parallels the 2026-05-21 NBA/WNBA/NHL change with a 14-day half-life (MLB plays daily; faster turnover). `_recentTeamScoreMean(_gtScheduleMap, "mlb", team, _MLB_HALF_LIFE_DAYS)` computes the team's recency-weighted recent-runs mean and blends with the pitcher-matchup-derived λ via `_regimeBlendWeight` (cap 0.85, denom 8). ML/spread inherit. `_simData` adds `regimeBlendW`, `homeRecentMean`, `awayRecentMean` when blend fires. Same calibration cutoff as TTO.
- **Lineup / pitcher-injury adjustment (added 2026-05-18)**: each team's λ is multiplied by `lineupFactor(topOut)` — `0/1/2/3+ → 1.0/0.98/0.96/0.93` — where `topOut` counts FRESH hitter absences (status `out` / `day-to-day` / `questionable` / `doubtful` / `game-time`) from `sportByteam.mlb.injuryByTeam[team]`, excluding pitchers (by `pos` ∈ {P, SP, RP} OR by ID match against `pitcherInfoByTeam[team].id`). **Long-IL stays (10/15/60-Day-IL) are EXCLUDED** — those players are replaced on the roster and team RPG already reflects life without them. Probable pitcher on IL (ID match) → starter inputs nulled → existing fallback uses bullpen-only ERA (catches lag between IL announcement and ESPN probable update). Same logic mirrors to team-total λ via `scoringLineupFactor` + `oppPitcherOnIL`. ML + spread inherit via `_mlbMlContext`. `buildMlbInjuryReport` in `api/lib/mlb.js` (ESPN endpoint, `mlb:injuries:v2:{date}` 30min cache, CHW→CWS normalization). dataConfidence: -1 per side at `topOut ≥ 2`, -2 per side at `pitcherOnIL`. Player props are NOT affected (HRR uses `hitterLineupSpot`; K uses `lineupKPct` — both already lineup-aware). Filter `trackedAt < 2026-05-18` for total/teamTotal/ML/spread calibration across this change.

*NHL*:
```
# Opponent factor prefers tonight's goalie SV% when known; falls back to team GAA.
goalieFactor(goalieSV, teamGAA) = goalieSV != null
  ? (1 - goalieSV) / (1 - leagueAvgSV)   # goals-allowed-per-shot, league-normalized
  : (teamGAA / leagueAvgGAA)              # fallback when no qualified starter
# Special-teams adjustment (since 2026-05-25): own PP advantage + opp PK weakness.
# 0.20 weight ≈ PP+PK goals as a share of all NHL scoring.
stAdj(ownPP, lgPP, oppPK, lgPK) = clamp(1 + ((ownPP − lgPP) + (lgPK − oppPK)) × 0.20, [0.90, 1.10])
homeLambda = homeGPG × goalieFactor(awayGoalieSV, awayGAA) × stAdj(homePP, lgPP, awayPK, lgPK)  # clamped [0.5, 8]
awayLambda = awayGPG × goalieFactor(homeGoalieSV, homeGAA) × stAdj(awayPP, lgPP, homePK, lgPK)  # clamped [0.5, 8]
```
- **PP/PK adjustment (added 2026-05-25)**: PP+PK goals are ~20% of NHL scoring; team aggregates (GPG / GAA / SV%) flatten ST advantage. `buildNhlSpecialTeams` (`api/lib/nhl.js`) fetches `stats/rest/en/team/powerplay` + `team/penaltykill` once per request (cache `nhl:specialteams:20252026`, 6h TTL) and stores `{ ppPct, pkPct, ppOppPerGame, penaltiesPerGame }` per abbr on `sportByteam.nhl.specialTeams.byTeam`. Net-ST factor clamped at ±10%. Missing data on either side → factor = 1.0 (no adjustment, fail-soft). ML/spread inherit via `_nhlMlContext`. `_simData` adds `homePPPct`, `awayPPPct`, `homePKPct`, `awayPKPct`, `homeSTAdj`/`awaySTAdj` when non-trivial. Filter `trackedAt < 2026-05-25` from NHL total/ML/spread calibration.
- **Goalie SV% source**: `buildNhlGoalieData` (`api/lib/nhl.js`) hits `stats/rest/en/goalie/summary` once per hydration (cache `nhl:goaliepool:20252026`, 6h TTL), filters to goalies with ≥5 regular-season starts, picks the team's max-GS goalie as the "primary starter". League-avg SV% is the GS-weighted mean of the same pool. NHL's pre-game endpoints don't reliably expose tonight's confirmed starter, so we treat each team's season-leading starter as the goalie of record — true ~75%+ of nights in regular season and ~90% in playoffs. When the backup actually starts, team-GAA fallback would have been equally biased (it averages across both), so swapping to primary-goalie-SV% nets ahead in expectation.
- **Why SV% not GAA per goalie**: SV% is per-shot and independent of team shot-allowed volume (already captured in `homeGPG`/`awayGPG`). GAA conflates the two.
- `_simData` for NHL game totals adds: `homeGoalie`, `awayGoalie`, `homeGoalieSV`, `awayGoalieSV`, `homeGoalieSource`/`awayGoalieSource` (`"starter"|"team"`), `leagueAvgSV`. dataConfidence penalty -1 per side when source is `"team"` (max -2).

*NBA* (possession-based):
```
projPace = (homePace × awayPace) / leagueAvgPace                        # geometric mean
# Injury-adjusted OffRtg: reduce by sum-of-Out-player-USG × replacement penalty (0.15), cap [0.85, 1.00].
offRtgAdj(team)    = clamp(1 - Σ(usg[Out players on team])/100 × 0.15, [0.85, 1.00])
homeOffRtgAdj      = homeOffRtg × offRtgAdj(home)
awayOffRtgAdj      = awayOffRtg × offRtgAdj(away)
homeExpected = (homeOffRtgAdj × awayDefRtg / leagueAvgOffRtg²) × projPace
awayExpected = (awayOffRtgAdj × homeDefRtg / leagueAvgOffRtg²) × projPace
# Playoff scoring boost when seriesSummary non-null on either team:
#   homeExpected *= _PLAYOFF_OFF_BOOST  (1.04)
#   awayExpected *= _PLAYOFF_OFF_BOOST
```
OffRtg/DefRtg from same ESPN team-stats call as pace. `nba:pace:2526` stores `teamOffRtg`, `teamDefRtg`, `leagueAvgOffRtg`, `leagueAvgDefRtg`. `_PLAYOFF_OFF_BOOST` is a single tunable at the top of the tonight handler — RS-aggregate ratings systematically under-projected playoff totals (LAL/OKC G3 = 232 vs model 199 vs market 210.5); +4% closes most of the model-vs-market gap. Surfaced as `playoffBoost: 1.04` in `_simData` when applied. Same boost applied to NBA team totals (`_teamExpected *= _PLAYOFF_OFF_BOOST`).
- **Injury OffRtg adjustment added 2026-05-17**: previously totals lambda used season-to-date OffRtg unchanged regardless of who's Out tonight. Now we sum the USG% of every Out player (via `nbaInjuryMap` × `nbaUsageMap`) and apply a 0.15 replacement-penalty factor. Empirical calibration: losing LeBron (28% USG) drops Lakers ~4.2% OffRtg, matching real-world LAL-without-LeBron data. Cap at 0.85 prevents multi-star scenarios from cratering lambda. DefRtg intentionally NOT adjusted — losing a defensive specialist has no clean usage proxy. Supplementary `buildNbaUsageRate` call after the parallel hydration backfills usage for injured players who don't have Kalshi prop markets tonight (e.g., 7th-man bench star out). `_simData` adds `homeOffRtgAdj`, `awayOffRtgAdj`, `homeUsageOut`, `awayUsageOut`, and `homeOffRtgFactor`/`awayOffRtgFactor` (omitted when factor = 1.0). Same swap applied to NBA team-total lambda via `teamOffRtgAdj`/`scoringUsageOut`/`scoringOffRtgFactor`. **No dataConfidence penalty** — adjustment makes lambda more accurate, not less.
- **B2B dampener added 2026-05-17**: B2B = most-recent completed schedule event's PT date == yesterday's PT date (via `_isTeamB2B(sport, team)` reading `_gtScheduleMap` event dates). Per-sport multiplier folded into the offense path (NBA/WNBA) or into the opponent goalie factor (NHL):
  - NBA / WNBA total: `homeOffRtgAdj *= 0.975 if home B2B`, same for away. Same on NBA team total via `scoringB2BFactor`. Empirical NBA effect: B2B teams score ~2–3% less.
  - NHL total: `_homeFactor *= 1.05 if away B2B`, `_awayFactor *= 1.05 if home B2B` (B2B team gives up ~3–5% more goals — goalie fatigue, occasional backup start). Partial counter to the Tier-1 #1 primary-goalie SV% assumption on B2B nights.
  - MLB: skipped — every day is "B2B"; concept doesn't apply.
  - `_simData` emits `homeB2B`/`awayB2B` (true) and `homeB2BFactor`/`awayB2BFactor` when fired (omitted otherwise). NBA team total emits `scoringB2B`/`scoringB2BFactor`.
  - Schedule parse (`_parseSchedEvts`) now keeps event `date`. Cache key bumped `teamschedule:v2 → v3` to evict date-less entries.

**SimScore — MLB**: homeWHIP, awayWHIP (>1.35→2, >1.20→1, ≤1.20→0), combinedRPG (`homeRPG+awayRPG`; ≥10.5→2, ≥8.5→1), H2H combined hit rate% (homeScore+awayScore ≥ threshold last 10 H2H; ≥3 games required), O/U line (≥9.5→2, ≥7.5→1). WHIP fallback: `pitcherWHIPByTeam[abbr]` → `teamWHIPMap[abbr]` → 1pt abstain. `homeWHIPSource`/`awayWHIPSource` = `"starter"|"team"|null` flags which path fired (covers debut/late-announcement starters).

**SimScore — NBA**: combined pace (both > lgAvg+2 → 2, one > lgAvg → 1), `combOffRtg = (home+away)/2` (≥118→2, ≥113→1), `combDefRtg` (same), `nbaGtH2HRate` (combined score ≥ threshold last 10 H2H; ≥3 games), O/U (≥225→2, ≥215→1).

**SimScore — NHL**: homeGPG, awayGPG, homeGAA, awayGAA (all ≥3.5→2, ≥3.0→1, <3.0→0), O/U (≥7→2, ≥5.5→1).

**UNDER inverted tiers** (representative): MLB WHIP ≤1.10→2, ≤1.25→1; NBA OffRtg/DefRtg <113→2, <118→1; NHL GPG/GAA <3.0→2, <3.5→1; H2H ≤30→2, ≤50→1; O/U inverts thresholds.

**Component point fields are direction-correct** (game totals + team totals): every play stores per-component `*Pts` fields (`homeWhipPts`, `combOffRtgPts`, `ttSeasonHitRatePts`, etc.) reflecting the bet direction. OVER picks store OVER-tier point values; UNDER picks override the same field names with UNDER-tier values via `_underComponents` / `_ttUnderComponents` / `_nttUnderComponents` spread last. **Pre-2026-05-08 UNDER picks have OVER-tier values stored** — calibration analysis on `direction === "under"` rows must filter by `trackedAt >= 1778270400000` (epoch ms for 2026-05-08T16:00Z) to trust per-component fields. Umpire is **not** a SimScore component (the run factor is applied to lambda directly); `ttUmpirePts` was dropped from the API response on 2026-05-08.

**Dedup**: one play per game (homeTeam+awayTeam+sport) — best edge wins across OVER+UNDER AND across game total vs team total. Track ID: `total|sport|home|away|threshold|gameDate[|under]`.

**`Kalshi O/U fallback (NBA + MLB + NHL)`**: Built via `_buildKalshiOuMap(sport, ticker)` from all KX{SPORT}TOTAL markets (unfiltered pct). Highest threshold where YES ≥ 50%, set `total = threshold − 0.5`. Three call sites populate `sportByteam.nbaGameOdds`, `sportByteam.mlb.gameOdds`, `sportByteam.nhlGameOdds` for any team missing a `total`. Originally NBA-only (ESPN omits odds for live/imminent games); MLB+NHL added 2026-05-07 because today's ESPN scoreboard never carries tomorrow's odds and `mlbMetaTomorrow.gameOdds` is intentionally empty — without the fallback, every tomorrow MLB/NHL game total play renders with O/U "—".

---

## Team Totals (MLB, NBA only)
Kalshi series `KXMLBTEAMTOTAL`, `KXNBATEAMTOTAL`. `gameType: "teamTotal"`. NHL/NFL absent on Kalshi. Scoring team extracted from ticker suffix (e.g. `LAD8` → LAD).

**True%**:
- MLB: `simulateTeamTotalDist(lambda)` Poisson. `oppMult = 0.6 × starterMult(oppFIP, oppERA, oppWHIP) + 0.4 × (oppTeamERA/4.20)` (FIP/ERA/WHIP starter blend, same as game totals). `lambda = teamRPG × oppMult × parkRF × platoonFactor × weatherFactor × umpireRunFactor`, clamped [0.5, 12]. **Pre-sim lambda blend**: `impliedLambda = lambdaForPoissonTail(threshold, ttSeasonHitRate/100)`; `blendedLambda = (1-w) × lambda + w × impliedLambda` where `w = min(1, sample/40) × 0.7`. truePct from analytical `1 - poissonCDF(threshold-1, blendedLambda)`. `modelTruePct`, `ttImpliedLambda`, `ttBlendedLambda` stored in debug output.
- NBA: `simulateTeamPtsDist(mean, std=11)` Normal. `mean = (teamOffRtg × oppDefRtg / lgOffRtg²) × projPace`. `oppDefRtg = oppDefPPG/oppPace × 100`. **Pre-sim mean blend**: `impliedMean = meanForNormalTail(threshold, ttNbaSeasonHitRate/100, 11)`; `blendedMean = (1-w) × mean + w × impliedMean`. truePct from analytical `1 - normCDF(threshold - 0.5, blendedMean, 11)`. `modelTruePct`, `ttNbaImpliedMean`, `ttNbaBlendedMean` stored in debug output.

**SimScore — MLB OVER**: seasonHitRate% (≥80→2, ≥60→1), oppWHIP (>1.35→2, >1.20→1), teamL10RPG (>5.0→2, >4.0→1), H2H HR% (≥80→2, ≥60→1), O/U (≥9.5→2, ≥7.5→1). `oppWHIP` uses same starter→team fallback as game totals; `oppWHIPSource` flag indicates path.
**SimScore — NBA OVER**: teamOffRtg, oppDefRtg (≥118→2, ≥113→1), Season HR%, H2H HR% (≥80→2, ≥60→1), O/U (≥225→2, ≥215→1).

**NBA team total truePct also blends sample-weighted with `ttNbaSeasonHitRate`** when available (≥5 schedule games) — same `_ssnBlendWeight` helper as game totals. Saves `modelTruePct` (pre-blend Normal sim) in the play when blend changed the value. Without this, NBA team totals were over-confident on far-from-mean thresholds.

**H2H HR%** (team total): scoring team's hit rate ≥ threshold in last 10 H2H vs opp. **Season HR%** (MLB team total): full-season rate from `_ttScheduleMap`. Both from ESPN team schedule cached at `teamschedule:v2:{sport}:{abbr}`. Requires ≥3 H2H or ≥5 season games; null = 1pt abstain.

**Dedup**: one play per `sport|scoringTeam|oppTeam`, best edge across OVER/UNDER. `_ttBestMap` rule: qualified wins over non-qualified even if edge is lower (commit 4903d5c).

---

## MLB Moneyline (v1, shipped 2026-05-18)
Kalshi series `KXMLBGAME` (same series that powers the MLB game-odds fallback). `gameType: "ml"`, `stat: "ml"`. MLB-only in v1; other sports waiting on confirmed Kalshi tickers.

**True%**: `simulateMLBJoint(homeLambda, awayLambda, 10000)` draws each team's runs as independent Poissons (same lambdas the game-total sim uses — captured in `_mlbMlContext` during the totals loop). `mlPctFromJoint(home, away)` counts `home[i] > away[i]` over non-tie sims; tied sims are dropped, not split 50/50, since real MLB resolves in extras and the Poisson model has no notion of extra-inning scoring. `awayTruePct = 100 − homeTruePct` once ties are out of the denominator.

**Kalshi pricing**: each ML side is its own market on Kalshi (one YES per team), so each side's `kalshiPct = own yes_ask_dollars × 100`. The totals UNDER `no_ask_dollars` workaround **doesn't apply here** because we never have to synthesize the opposite side from `1 − yes_ask`. Overround stays in the price the user actually pays (typical: 3–5% combined, identical to existing OVER kalshiPct convention).

**Gate**: standard `dcQualified === true && edge ≥ 5` (client) / `edge ≥ 3` (server, for calibration continuity). Kalshi window 67–91 same as totals. No SimScore — display-only attribution lives in the InputList factor breakdown (`buildMlbMlInputs` in `src/lib/lambdaInputs.js`).

**dataConfidence**: shares the MLB game-total starter/bullpen-source penalty table (homeWHIPSource/awayWHIPSource, homeBullpenSource/awayBullpenSource) plus the both-sides-lineup-confirmed signal. `DC_GATE("mlb", "ml") = 8` (loosened from 10 on 2026-05-18 — 10 was effectively unreachable given typical penalties; combined with universal Kalshi 67-91 window, qualified ML plays remain rare by design). No threshold-distance or seasonRateDivergent penalty (no threshold; no season-rate blend in v1).

**No correlation shrinkage in v1**: MLB park/weather/umpire are already shared per-game inputs, so independent Poissons don't over-disperse the margin much. Revisit if calibration shows tail bias on heavy favorites/dogs.

**Live resolution**: reads `meta.gameScores[homeTeam][gameDate]`. `pickTeam` wins iff its final score is higher. Resolves only at `state === "post"` (unlike OVER totals, which can win mid-game when the threshold is crossed — for ML, in-game leads have plenty of variance left).

**Emission**: one pass after team-total cross-dedup. For each `_mlbMlContext` entry with a matching `_mlbMlMarkets` ML pair, run the joint sim once (cached per `homeTeam|awayTeam`), then emit a play per qualifying side. Both sides can in theory pass the Kalshi 67–91 window if the dog is priced near 30c (= no_ask ~70c); in practice the favorite side is what we usually see.

---

## MLB Spread / Run-line v1 (2026-05-18)

**Series**: `KXMLBSPREAD`. Per-market title: "Team X wins by over Y runs?" Ticker: `KXMLBSPREAD-{eventTicker}-{team}{N}` where the suffix decodes to `marginTeam` (the side on the win-by question) and `line = floor_strike = N − 0.5`. Half-lines only — integer lines would allow pushes; not modeled in v1 (parse skips them via `strike === Math.floor(strike)` check).

**True%**: `spreadPctFromJoint(home, away, line, side)` reuses the joint Poisson draws cached in `_mlJointCache` (hoisted out of the ML emission block so ML + spread share the same 10k draws per game). Side = "home"/"away" indicates which team is on the margin question. YES = `P(side − opp > line)`; NO = complement (no pushes). Same per-team lambdas as MLB game totals + ML.

**Kalshi pricing**: each spread market is an independent YES/NO book. YES side pays `yes_ask_dollars × 100` for the margin team (`-line`); NO side pays `no_ask_dollars × 100` for the cover team (`+line`) — **must use real `no_ask`, not `1 − yes_ask`** (same gotcha as totals UNDER, since YES/NO books are independent and typical spread is 3–7c).

**Lines emitted**: ALL Kalshi-listed alt lines per game. Typical: ±1.5, ±2.5, ±3.5; sometimes ±4.5+ for big mismatches. Both sides of each line are independent Kalshi markets (e.g. "LAD wins by 1.5+" AND "SD wins by 1.5+" are both listed for LAD@SD), so the parser handles both orientations via `parseGameTeams` + `marginTeam` decode. `pickLine` field is signed from the pick's perspective: `-1.5` for margin side, `+1.5` for cover side.

**Gate**: standard `dcQualified === true && edge ≥ 5` (client) / `edge ≥ 3` (server). Kalshi window 67-91. `DC_GATE("mlb", "spread") = 8` — same as ML, since spread reuses identical lambda inputs (FIP/ERA/WHIP/bullpen sources, lineup confirmation). The `gameType === "spread"` clause is added to all MLB ml branches in `api/lib/tonight/dc.js` (gate, lineup-confirmation penalty, starter-source penalty).

**No correlation shrinkage in v1**: park/weather/umpire are shared per-game inputs so independent Poissons don't over-disperse margins much. Heavy-favorite alt lines (e.g. -3.5 or worse) are the highest-variance corner — watch calibration there first.

**Live resolution (frontend, not yet wired)**: at `state === "post"`, pickTeam covers if `(pickTeamFinal − oppFinal) > line` for YES picks, or `(oppFinal − pickTeamFinal) ≤ line` for NO picks. Half-lines only → no pushes. Same `meta.gameScores[homeTeam][gameDate]` lookup as ML.

**Asymmetry vs ML (observed 2026-05-18 deploy)**: tonight has 0 qualifying ML plays (no MLB ML favorite hits 67% Kalshi) but 43 qualifying spread plays. Reason: spread `no_ask` for moderate underdog +X.5 covers naturally lands in 67-91 (favorite -X.5 priced 10-30% → cover 70-90%). If 43/night turns out to be too many on real calibration, consider tightening with a `kalshiVolume` floor or restricting to ±1.5 only.

---

## Kalshi Market Parsing
- Series in `SERIES_CONFIG` (18 tickers across all sports/stats)
- Player props, game totals, team totals: `pct ∈ [KALSHI_GATE, KALSHI_CAP] = [67, 91]` (constants in `api/[...path].js`). Markets outside this band aren't fetched/parsed at all.
- **Rate limiting**:
  - Bundle cache `kalshi:bundle:{date}` (600s TTL) — all 18 series as one blob, cache hit = zero calls. Bypassed by `?bust=1`.
  - Cold: **3 series at a time with 700ms delay** between batches, **shuffled order**. 6+300ms still left ~6/18 series falling back to stale per `?bust=1` (KXMLBTEAMTOTAL was always last-in-line). Shuffling distributes rate-limit pain across categories instead of starving the same tickers. Cost: ~3.6s on cold builds; bundle hits unaffected. 429 → fall through to `kalshi:stale:{ticker}` (no retry). The per-ticker stale fallback fires on both bust and non-bust — it holds the last successful fetch, and is preferable to empty even on bust. (Briefly tried skipping stale on bust to dodge "yesterday's residue", but that strands the 600s bundle once any rate-limited bust call writes empty entries; preserving stale is the safer trade.)
  - **Bundle preserves prior entries on partial failure**: when a follow-up bundle fetch returns empty for a series due to rate-limit/failure, the prior bundle's entry for that ticker is reused before writing the new bundle. Stops a rapid-bust race from blanking healthy categories (KXMLBTEAMTOTAL was getting blanked between `?bust=1` calls because it was the most rate-limit-prone).
  - **Staleness surfacing**: any series served from per-ticker stale fallback OR prior-bundle preservation marks each affected market `_kalshiStale: true`. Two consumer paths: (1) `/api/tonight` response (debug + production) returns `staleKalshiSeries: ["KXMLBTOTAL", ...]` listing tickers that fell back this request — at-a-glance signal for diagnosing drift like "Kalshi shows -968 but UI shows -669". (2) Each affected play has `_kalshiStale: true` (derived via `(sport, stat, gameType)` → ticker reverse lookup against the stale set). The flag is omitted on fresh plays.
  - Orderbooks (thin markets): 8 at a time with 200ms delay. 429 silently skipped.
- Blended fill price via orderbook walk for thin markets
- **Stale-ask fallback**: when `yes_ask ≥ $0.98` AND `yes_bid == 0` AND `last_price > 0`, use `last_price_dollars` instead. Handles maxed-ask illiquid markets.
- `kalshiSpread` = bid-ask in cents. Kept as liquidity signal but **not** subtracted from edge.
- E1 line movement: opening yesAsk stored at `lineOpen:{ticker}:{gameDate}` (2-day TTL). `lineMove = current − opening`. Badge `▲/▼ Xc` when `|lineMove| ≥ 3`.
- E2 market depth: `lowVolume = vol < 50`, `thinMarket = spread > 8`, `marketConfidence = "deep" (vol≥50 && spread≤4) | "moderate" | "thin"`.

### Time-based filters
- **Date cutoff** (`cutoffStr`, ~`[...path].js:3492`): drops plays with `gameDate < yesterday`. Applied to player props pre-merge; game/team totals do an inline `gameDate < cutoffStr` skip in their loops.
- **Game-start cutoff** (post-dedup, after cross-dedup loop): drops any play whose `gameTime` is already in the past (pre-game market closed; model truePct built on pre-game inputs is no longer valid in-game). Plays missing `gameTime` are kept (already gated by gameDate).

### preDropped vs dropped vs qualified:false
- `preDropped[]` — filtered before main play loop (no ESPN info yet). Debug-only.
- `dropped[]` — filtered inside play loop. Debug-only. **Includes game totals** that fail edge or have no sim data (`reason: "edge_too_low"` or `"no_simulation_data"`).
- `nbaDropped[]` — always present in regular `/api/tonight` response (now empty after pre-filter removed; kept as fallback for `tonightPlayerMap` building).
- **`qualified:false` plays** — pushed to `plays[]` so player card explanation renders. `tonightPlays` filters them out client-side; `allTonightPlays` keeps them (used to build `tonightPlayerMap`).
  - MLB strikeouts: edge gate, threshold_too_high, simScore<8 — all thresholds pushed for monotonicity
  - MLB HRR: edge gate, simScore<8 — `low_lineup_spot` and `hitterSimScore<5` are pre-gates that do NOT push
  - NBA, NHL: edge gate, simScore<8

### bestMap deduplication
Dedupe to one play per `playerName|sport|stat`. Winner = highest edge. Non-qualifying plays use threshold-inclusive key and don't compete. After bestMap, non-winning qualified thresholds are re-added as `qualified:false`.

**WNBA pre-pass**: before bestMap, qualified WNBA plays are deduped to one per **player** (across all stats), highest edge wins. Losing stats are mutated to `qualified:false` so allTonightPlays still has them for the player card, but the homepage Plays card only shows the per-player winner. Tighter than NBA/NHL because WNBA slates are small and a player's points/rebounds/assists markets often correlate — showing all of them was clutter.

For totals: dedup key is `homeTeam|awayTeam|threshold` (game) or `sport|scoringTeam|oppTeam` (team). All threshold plays passing edge gate (≥3%) are pushed; best per game is qualified, rest are `qualified:false` (used by team-page bar chart).

### Backend monotonicity for player card
Strikeout truePct is enforced via:
1. `qualified:false` plays in `plays[]` keep all thresholds (key `playerName|sport|stat|threshold` so no dedup collision)
2. Post-loop sweep re-derives truePct for every threshold from `pitcherKDistCache` distribution
3. Frontend `_rawTruePctMap` walks highest→lowest tracking running max across API thresholds as safety net (fallback values excluded so noisy fallbacks can't lift API values)
4. Frontend cap pass: walks low→high, and any fallback threshold above an API anchor is capped at the anchor's truePct (P(X≥t) cannot exceed P(X≥t') for t > t'). Needed because the player card hits `/api/kalshi` directly — bypasses the [67,91] gate — so thresholds outside the band render with `(seasonHitRate + softPct) / 2` fallback that can otherwise exceed the in-band API anchor.
