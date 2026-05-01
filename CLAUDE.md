# Scoreboard — Project Guide for Claude

## Workflow for New Features and Debugging

1. **Check memory and CLAUDE.md** — Read `MEMORY.md` and relevant memory files. Scan CLAUDE.md for the area being changed.
2. **Plan and get approval** — Present the full plan as text only (files to change, logic, edge cases). Wait for explicit user approval before editing any files.
3. **Implement** — Make the changes. If backend logic changed, confirm with `/api/tonight?debug=1` (or relevant endpoint) and print key fields proving the change is correct.
4. **Deploy and document** — `git push origin main` to deploy. Update CLAUDE.md in the same commit. Save a memory entry for anything non-obvious future sessions should know.

---

## What This Is
Sports prop betting dashboard that pulls Kalshi prediction market prices, computes a model True%, and shows qualified plays with edge over the market. Vercel Edge runtime (Web Fetch + KV/Redis only — no Node APIs).

**Production**: `https://scoreboard-ivory-xi.vercel.app`
**Universal qualification**: Kalshi 67–91% · Edge ≥ 3% · SimScore ≥ 8/10. Game/team totals gate UNDERs by the same `noKalshiPct ∈ [67, 91]` window. Tunables live as module-level constants `KALSHI_GATE` (67, ~-200 floor) / `KALSHI_CAP` (91, ~-1000 cap) / `EDGE_GATE` / `SIMSCORE_GATE` in both `api/[...path].js` and `src/App.jsx` — change in both places.

---

## Architecture

### API: `api/[...path].js` + `api/lib/`
Single Vercel Edge Function. Imports four ES module lib files:
- `api/lib/simulate.js` — park factors + simulation functions (`log5K`, `simulateKsDist`, `buildNbaStatDist`, `simulateHits`, `simulateMLBTotalDist/NBATotalDist/NHLTotalDist`, `simulateTeamTotalDist`, `simulateTeamPtsDist`, `kDistPct/nbaDistPct/totalDistPct`, kelly/EV math), `TTO_DECAY_FACTOR`, `UMPIRE_KFACTOR`
- `api/lib/mlb.js` — `buildLineupKPct` (also exports `batterSplitBA`, `batterHRRSplits`), `buildBarrelPct`, `buildPitcherKPct` (also exports `pitcherRecentKPct`, `pitcherLastStartDate`, `pitcherLastStartPC`, `pitcherInfoByTeam`, `pitcherAvgBF`, `pitcherStdBF`, `umpireByGame`), `MLB_ID_TO_ABBR`. Pitcher gamelog batch uses `Promise.allSettled`.
- `api/lib/nba.js` — `buildNbaDvpStage1/FromBettingPros/Stage3FG`, `buildNbaDepthChartPos`, `buildNbaPaceData`, `buildNbaPlayerPosFromSleeper`, `warmPlayerInfoCache`, `buildNbaUsageRate`, `buildNbaInjuryReport`
- `api/lib/utils.js` — CORS helpers, `parseGameOdds` (returns `{total, moneyline, spread}`), `parseGameScores` (returns `{state, detail, homeScore, awayScore, gameDate, gameTime, seriesSummary}` keyed by home abbr; `seriesSummary` non-null in NBA/NHL playoffs), team rank helpers (`buildSoftTeamAbbrs`, `buildHardTeamAbbrs`, `buildTeamRankMap`)

### Frontend: Vite + React (`src/`)
Entry: `index.html` → `src/main.jsx` → `src/App.jsx`. Vercel runs `npm run build` → `dist/` on push.

- `src/App.jsx` — top-level state, routing, data fetching, player card
- `src/lib/constants.js` — `TEAM_DB`, `TOTAL_THRESHOLDS`, `MOCK_PLAYS`, `GAMELOG_COLS`, sport/stat metadata
- `src/lib/utils.js` — `slugify`, `teamUrl`, `logoUrl(sport, abbr)` (handles ESPN CDN abbr mismatches NHL `tbl→tb, njd→nj, lak→la, sjs→sj`; NBA `kat→atl`)
- `src/lib/liveStats.js` — live pick tracking helpers
- `src/lib/hooks.js` — `useIsMobile(threshold=600)`: resize+orientation-aware boolean. Use this for responsive layouts (e.g. `LineupsPage` toolbar wraps to 2 rows on mobile). `SimBadge`/`DayBar` tooltips also support tap-to-pin so SimScore breakdowns are accessible on touch devices.
- `src/components/` — `LineupsPage` (homepage tab layout), `MatchupCard` (per-game card), `PlaysColumn`, `MyPicksColumn`, `MarketReport`, `ModelPage`, `TeamPage`, `TotalsBarChart`, `DayBar`, `AddPickModal`

**Dev proxy**: `vite.config.js` proxies `/api` to production so `npm run dev` works without local backend.

### Storage: Upstash Redis
On Vercel, `env.CACHE` (Cloudflare KV binding) is unavailable — `makeCache()` falls through to Upstash REST client (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`).

**Free tier 500k commands/month** — when exceeded, all reads/writes silently return null (Upstash returns HTTP 400 but the `cmd()` wrapper only extracts `result`). Diagnose with `curl -H "Authorization: Bearer <ADMIN_KEY>" .../api/auth/debug-redis`.

User auth (`user:{email}`) and picks (`picks:{userId}`) live in the same Redis. JWT expires after 365 days. Picks also kept in `localStorage` as backup — restored to server if server returns 0 but local has data.

### Cache keys & TTLs
| Key | TTL | Notes |
|---|---|---|
| `byteam:mlb` | 600s | Probables, lineup K-rates, pitcher avg pitches/BF. **Excludes** `barrelPctMap` (separate). 60s if lineup data empty. |
| `byteam:nba` / `:scoring` | 1800s / 21600s | Defensive stats / offensive PPG |
| `byteam:nhl` | 21600s | GAA + SA per team |
| `byteam:nfl` | 1800s | |
| `kalshi:bundle:{date}` | 600s | All 18 series responses as JSON blob — cache hit = zero Kalshi calls. Bypassed by `?bust=1`. |
| `kalshi:stale:{ticker}` | none | Stale-while-revalidate per-ticker fallback for 429/empty. |
| `gameTimes:v2:{date}` | 600s | Stores `sport:team:ptDate` AND bare `sport:team` (first wins). Built from yesterday + today + tomorrow ESPN scoreboards in parallel. Cleared by `?bust=1`. |
| `nba:pace:2526` | 12h | Pace + OffRtg/DefRtg + leagueAvg. Cleared by `?bust=1`. |
| `nba:injuries:{date}` | 1800s | ESPN injuries (Out + GTD) |
| `nba:depth:{date}` | daily | |
| `mlb:barrelPct` | 6h | Baseball Savant CSV |
| `mlbSchedTomorrow:{date}` | 600s | Tomorrow's MLB schedule (probables only) |
| `weather:mlb:{date}` | 600s | ESPN weather, refreshed independently of gameTimes |
| `teamschedule:v2:{sport}:{abbr}` | 3600s | H2H + season hit rates. Cleared by `?bust=1`. |
| `lineOpen:{ticker}:{gameDate}` | 2 days | E1 line-movement opening price |
| `team:v3:{sport}:{abbr}:{date}` | 3600s | `/api/team` data |
| `live:{sport}:{teams sorted}:{ptDate}` | 60s in / 300s post | `/api/live` boxscore |

### Routes
- `/api/tonight` — main play generation. `?debug=1` returns dropped/preDropped + debug fields. `?bust=1` bypasses caches.
- `/api/kalshi` — raw Kalshi market data
- `/api/player`, `/api/gamelog` — ESPN player info + gamelog
- `/api/team` — team page data (gameLog, lineup, season stats, nextGame)
- `/api/live` — in-game boxscore for pick tracking (`?games=mlb:LAD:SD,nba:GSW:LAL`); player props poll this; total/team-total picks resolve from existing `meta.gameScores` (no extra fetch)
- `/api/dvp`, `/api/nba-depth`, `/api/dvp/debug-dc` — DVP/depth chart
- `/api/auth/{register,login,reset,list-users,debug-redis,calibration}` — auth + admin. Password min 8 chars. Admin endpoints fail-closed if `ADMIN_KEY` missing.
- `/api/auth/calibration` — outcome stats. Auth: bearer JWT (any user) or `?adminKey=`. Returns `overall`, `byCategory`, `byCategoryDetail` (per-category truePct buckets, used by `CalibModule` per ModelPage tab), `kStrikeouts` (K-feature breakdowns).
- `/api/user/picks` — GET/POST user picks (bearer JWT)
- `/api/keepalive` — daily cron

---

## Models

### Universal definitions
- **SimScore**: 5 components × 2pts each → max 10. Qualifies at ≥ 8. Null component → 1pt abstain (unless noted otherwise).
- **Edge gate**: `edge = truePct − kalshiPct ≥ 3%`. `kalshiPct` is already the fill price (ask or blended orderbook walk); `spreadAdj` is computed but **not** subtracted.
- **`pct ∈ [67, 91]` filter**: universal qualification window for player props, game totals, and team totals. UNDER discovery uses `noKalshiPct ∈ [67, 91]`.
- **UNDER plays** (totals only): `underEdge = (100−truePct) − (100−kalshiPct) ≥ 3%` AND `noKalshiPct ∈ [67, 91]`. `direction:"under"`, badge red, bars use `noTruePct`/`noKalshiPct`, prose colors inverted, track ID appends `|under`.

### MLB Strikeouts
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
- E3b expectedBF: `clamp(round(_avgBF), 15, 27)`. Fallback chain: `pitcherStatsByName.avgBF` → `sportByteam.mlb.pitcherAvgBF` (team key) → `clamp(round(avgP/3.85), 15, 27)`. Default 24.

**SimScore**:
- `kpctPts` — CSW% (≥30→2, >26→1, ≤26→0); falls back to regressed K% (>27/>24/≤24)
- `lkpPts` — Lineup oK% hand-adjusted (>24→2, >22→1, ≤22→0)
- `kHitRatePts` — Trust-weighted blend of 2026 observed and 2025 computed K-threshold hit rate (≥90→2, ≥80→1, <80→0). `trust26 = min(1, vals26.length/15)`. `blendedHitRate` is the value.
- `kH2HHandPts` — Pitcher's K hit rate vs opponents whose lineup hand majority matches tonight's. Tonight uses full switch-hitter adjustment (S vs RHP→L); historical uses `staticTeamHandMajority` (S = 0.5R + 0.5L). ≥5 starts required (≥80→2, ≥65→1, <65→0).
- `totalPts` — O/U tier (≤7.5→2, <10.5→1, ≥10.5→0)

**Display-only fields** (not in SimScore, kept for debug/calibration): `kbbPts`, `parkMeets`, `mlPts`, `kTrendPts` (`pitcherRecentKPct` shown in prose), `pitchesPts`.

**Gates** (in addition to SimScore ≥ 8):
1. Threshold sanity: `threshold > ceil(expectedKs) + 2` → `qualified:false` (only when lineup confirmed and expectedKs available)
2. Insufficient_starts: if `pitcherHasAnchor !== true` (gs25 ≥ 5 AND bf25 ≥ 100) requires `gs26 ≥ 8`. Catches TJ-return / pure-reliever cases. Checked in pre-filter AND main loop.

### MLB Hitters (HRR)
**True%**: logit-sigmoid park adjustment on blended base rate (no Monte Carlo for HRR — `simulateHits` only used for hits stat).
```
rawMlbPct = (primaryPct + softPct) / 2
truePct = sigmoid(logit(rawMlbPct/100) + ln(parkFactor)) × 100
```
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

### NBA player props
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

### NHL Points
**True%**: reuses `buildNbaStatDist` + `nbaDistPct`. Cache key `nhlPlayerDistCache[playerId|stat]`. Adjusted: `× teamDefFactor × (1 + shotsAdj×0.002) × 0.93 if B2B × nhlToiTrendAdj`. `teamDefFactor` = opp GAA / league avg.

**D3 TOI trend** (passed as `miscAdj`): `clamp(recent3TOI / last10TOI, 0.92, 1.08)`. Only applied when ratio >1.05 or <0.95.

**SimScore**:
- `nhlOpportunity` — Avg TOI last 10 (≥18min→2, ≥15min→1, <15→0)
- `_gaaRank` — Opp GAA rank (≤10→2, ≤15→1, else 0)
- `nhlSeasonHitRatePts` — Career rate at threshold (≥90→2, ≥80→1, <80→0)
- `nhlDvpHitRatePts` — Rate vs teams with GAA > league avg (≥3 qualifying games; ≥90→2, ≥80→1, <80→0)
- `nhlGameTotal` — O/U line (≥7→2, ≥5.5→1, <5.5→0)

Display-only: `nhlSaRank`, `nhlTeamGPG`. **B2B detection**: last gamelog event was yesterday UTC.

### NFL
Stats: `passingYards`, `rushingYards`, `receivingYards`, `receptions`, `completions`, `attempts`. Gate: opp in soft teams; edge ≥ 3%.

### Game Totals (MLB/NBA/NHL/NFL)
Kalshi series: `KXMLBTOTAL`, `KXNBATOTAL`, `KXNHLTOTAL`, `KXNFLTOTAL`. `gameType: "total"`. Market format: `floor_strike = N` means YES = total ≥ N (i.e. "over N−0.5").

**True%**: Poisson MC for MLB/NHL, Normal for NBA. `_simData` includes per-team expected and `expectedTotal`.

**Lambda / projection formulas**:

*MLB*:
```
awayMult = 0.6 × (awayERA/4.20) + 0.4 × (awayTeamERA/4.20)
homeMult = 0.6 × (homeERA/4.20) + 0.4 × (homeTeamERA/4.20)
homeLambda = homeRoadRPG × awayMult × parkRF × homePlatoonFactor × weatherFactor × umpireRunFactor  # clamped [1,12]
awayLambda = awayRoadRPG × homeMult × parkRF × awayPlatoonFactor × weatherFactor × umpireRunFactor  # clamped [1,12]
```
- **Platoon factor**: `(lineup composite BA vs starter's hand) / (lineup composite overall BA)` from `batterSplitBA`. Falls back to 1.0 when hand unknown or sample <80 AB. **Note**: MLB Stats API `/teams/stats` does NOT support pitcher-handedness sitCodes (`vl/vr` returns empty) — handedness splits are individual-only. Same factor applied to team total lambda.
- **Weather factor**: `1 + windOutMph × 0.013 + (tempF − 72) × 0.001`, clamped [0.85, 1.15]. `windOutMph` parsed from ESPN `displayValue` ("Out to LF/CF/RF" positive, "In from..." negative, "L to R"/"R to L" = 0). Skipped for `_MLB_DOMED` parks (TB/TOR/HOU/MIA/SEA/ARI/TEX/MIL).
- **Road RPG**: from MLB Stats API `sitCodes=A`, stored as `mlbRoadRPGMap`.
- `umpireRunFactor = 1 / UMPIRE_KFACTOR` applied to both lambdas (and team total lambda).

*NHL*:
```
homeLambda = homeGPG × (awayGAA / leagueAvgGAA)  # clamped [0.5, 8]
awayLambda = awayGPG × (homeGAA / leagueAvgGAA)  # clamped [0.5, 8]
```

*NBA* (possession-based):
```
projPace = (homePace × awayPace) / leagueAvgPace                        # geometric mean
homeExpected = (homeOffRtg × awayDefRtg / leagueAvgOffRtg²) × projPace
awayExpected = (awayOffRtg × homeDefRtg / leagueAvgOffRtg²) × projPace
```
OffRtg/DefRtg from same ESPN team-stats call as pace. `nba:pace:2526` stores `teamOffRtg`, `teamDefRtg`, `leagueAvgOffRtg`, `leagueAvgDefRtg`.

**SimScore — MLB**: homeWHIP, awayWHIP (>1.35→2, >1.20→1, ≤1.20→0), combinedRPG (`homeRPG+awayRPG`; ≥10.5→2, ≥8.5→1), H2H combined hit rate% (homeScore+awayScore ≥ threshold last 10 H2H; ≥3 games required), O/U line (≥9.5→2, ≥7.5→1). WHIP fallback: `pitcherWHIPByTeam[abbr]` → `teamWHIPMap[abbr]` → 1pt abstain. `homeWHIPSource`/`awayWHIPSource` = `"starter"|"team"|null` flags which path fired (covers debut/late-announcement starters).

**SimScore — NBA**: combined pace (both > lgAvg+2 → 2, one > lgAvg → 1), `combOffRtg = (home+away)/2` (≥118→2, ≥113→1), `combDefRtg` (same), `nbaGtH2HRate` (combined score ≥ threshold last 10 H2H; ≥3 games), O/U (≥225→2, ≥215→1).

**SimScore — NHL**: homeGPG, awayGPG, homeGAA, awayGAA (all ≥3.5→2, ≥3.0→1, <3.0→0), O/U (≥7→2, ≥5.5→1).

**UNDER inverted tiers** (representative): MLB WHIP ≤1.10→2, ≤1.25→1; NBA OffRtg/DefRtg <113→2, <118→1; NHL GPG/GAA <3.0→2, <3.5→1; H2H ≤30→2, ≤50→1; O/U inverts thresholds.

**Dedup**: one play per game (homeTeam+awayTeam+sport) — best edge wins across OVER+UNDER AND across game total vs team total. Track ID: `total|sport|home|away|threshold|gameDate[|under]`.

**`Kalshi NBA O/U fallback`**: ESPN omits odds for live/imminent games. After ESPN fetch, `kalshiNbaOuMap` (built from all KXNBATOTAL markets, unfiltered pct) fills missing entries: highest threshold where YES ≥ 50%, set `total = threshold − 0.5`.

### Team Totals (MLB, NBA only)
Kalshi series `KXMLBTEAMTOTAL`, `KXNBATEAMTOTAL`. `gameType: "teamTotal"`. NHL/NFL absent on Kalshi. Scoring team extracted from ticker suffix (e.g. `LAD8` → LAD).

**True%**:
- MLB: `simulateTeamTotalDist(lambda)` Poisson, `lambda = teamRPG × (oppERA/4.20) × parkRF`, clamped [0.5, 12]. **Blend**: `truePct = 0.5 × model + 0.5 × ttSeasonHitRate` when season data available. Corrects ~12pt Poisson overestimation at low thresholds. `modelTruePct` stored in debug output.
- NBA: `simulateTeamPtsDist(mean, std=11)` Normal. `mean = (teamOffRtg × oppDefRtg / lgOffRtg²) × projPace`. `oppDefRtg = oppDefPPG/oppPace × 100`.

**SimScore — MLB OVER**: seasonHitRate% (≥80→2, ≥60→1), oppWHIP (>1.35→2, >1.20→1), teamL10RPG (>5.0→2, >4.0→1), H2H HR% (≥80→2, ≥60→1), O/U (≥9.5→2, ≥7.5→1). `oppWHIP` uses same starter→team fallback as game totals; `oppWHIPSource` flag indicates path.
**SimScore — NBA OVER**: teamOffRtg, oppDefRtg (≥118→2, ≥113→1), Season HR%, H2H HR% (≥80→2, ≥60→1), O/U (≥225→2, ≥215→1).

**H2H HR%** (team total): scoring team's hit rate ≥ threshold in last 10 H2H vs opp. **Season HR%** (MLB team total): full-season rate from `_ttScheduleMap`. Both from ESPN team schedule cached at `teamschedule:v2:{sport}:{abbr}`. Requires ≥3 H2H or ≥5 season games; null = 1pt abstain.

**Dedup**: one play per `sport|scoringTeam|oppTeam`, best edge across OVER/UNDER. `_ttBestMap` rule: qualified wins over non-qualified even if edge is lower (commit 4903d5c).

---

## Kalshi Market Parsing
- Series in `SERIES_CONFIG` (18 tickers across all sports/stats)
- Player props, game totals, team totals: `pct ∈ [KALSHI_GATE, KALSHI_CAP] = [67, 91]` (constants in `api/[...path].js`). Markets outside this band aren't fetched/parsed at all.
- **Rate limiting**:
  - Bundle cache `kalshi:bundle:{date}` (90s TTL) — all 18 series as one blob, cache hit = zero calls. Bypassed by `?bust=1`.
  - Cold: 6 series at a time with 300ms delay. 429 → fall through to `kalshi:stale:{ticker}` (no retry).
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

For totals: dedup key is `homeTeam|awayTeam|threshold` (game) or `sport|scoringTeam|oppTeam` (team). All threshold plays passing edge gate (≥3%) are pushed; best per game is qualified, rest are `qualified:false` (used by team-page bar chart).

---

## Key Gotchas

**TEAM_NORM (Kalshi → ESPN)**: NBA `{ GS→GSW, SA→SAS, NY→NYK, NJ→BKN, NO→NOP, PHO→PHX, WPH→PHX, KAT→ATL }`. After building `STAT_SOFT["nba|*"]` rankMaps from ESPN byteam (which also returns short codes), a post-normalization loop adds the long-form key so `nbaDefRank["GSW"]` resolves.

**NHL_ABBR_MAP**: NHL Stats API teamIds → abbreviations. **UTA (Utah Mammoth) = teamId 68** (rebranded from Utah Hockey Club for 2025-26; old teamId 53 absent). New teams showing `—` for GPG/GAA/SA need their teamId added.

**gameTimes lookup chain** (in play loop): `sport:team:gameDate` → `sport:team:tomorrowISOStr` (handles Kalshi encoding tomorrow's games under today's ticker date) → bare `sport:team`.

**`gameScores` today + tomorrow merge**: Each ESPN scoreboard fetch that produces `gameScores` (MLB tonight, NBA tonight, NBA fallback, NHL fallback) fetches **today AND tomorrow in parallel** (PT date, `Date.now() - 7h`) and passes merged events to `parseGameScores`. Today's events alone go to `parseGameOdds`/probables (so tomorrow doesn't overwrite today's pitcher/odds). `parseGameScores` keys by `${hA}|${gameDate}` so today's NYY and tomorrow's NYY don't collide. Without this, when today's MLB is all `state==="post"` (or after midnight UTC for NBA/NHL using UTC date), today's "Final" data is wiped and the today-tab matchup cards have no `gameState` to seed.

**Two-way players** (MLB strikeouts): ESPN gamelog defaults to **batting** stats. The play loop appends `&category=pitching` for all MLB K-market players and pitcher gamelog fetches. Separate Redis cache keys (`gl:mlb242526pv1`, `gl:mlb2025p|`, `gl:mlb2026p|`) prevent batting/pitching collision. Without this, two-way players (e.g. Ohtani) drop with `col_not_found` because the K column is absent from batting gamelog.

**ESPN gamelog endpoint**: ESPN now blocks server-side HTML page fetches with AWS WAF. Use the JSON API (`site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog`) for ALL sports including NBA/NHL.

**NBA lineup source chain**: (1) ESPN scoreboard → game summary boxscore starters (today's actual, `lineupConfirmed:true`); (2) most recent **playoff** schedule game first (`seasontype=3`), fallback to regular season `lastGameId` only if no playoff games — boxscore starters; (3) ESPN team roster (one player per position group, up to 8). ESPN depth chart (`/teams/{abbr}/depthchart`) returns `{}` during playoffs — removed. Always prefer playoff over regular season — RS finals often have rested/bench starters that don't reflect playoff rotations.

**MLB lineup**: (1) MLB Stats API schedule `hydrate=lineups,probables` (PT date `Date.now()-7h`); (2) active roster fallback (non-pitchers, up to 12, `spot:null`, `lineupConfirmed:false`).

**Edge handler env-var wiring**: ALL env vars must be passed through `process.env` to the explicit `env` object at the bottom of `api/[...path].js`. Vercel doesn't auto-attach them. If you add a new env var, add it here too:
```js
const env = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_KEY: process.env.ADMIN_KEY,
};
```
Symptom of missing wire-up: `env?.VAR` is `undefined` even though Vercel dashboard shows it set. JWT_SECRET specifically: `TextEncoder.encode(undefined)` = 0 bytes → `"Imported HMAC key length (0)"` 500 on login.

---

## Frontend

### URL Routing
History.pushState + popstate. Routes:
- `/:ABBR` → team page (uppercase, e.g. `/LAD`, `/GSW`)
- `/:ABBR?sport=nhl` → disambiguate multi-sport abbrs (`_multiSportAbbrs` Set)
- `/:SlugName` → player page (CamelCase via `slugify`)
- `/model` → Model Reference page

`vercel.json` `/:slug` rewrite serves `index.html` for cold loads. `resolveSlug` checks `"model"` first, then `TEAM_DB`, else stores `pendingSlug` for async ESPN athlete search.

`navigateToPlayer` accepts player objects without `id`; `loadPlayer` resolves ESPN athlete ID via `/athletes?q={name}` when missing.

### State (App.jsx)
- `tonightPlays` — qualified plays (filtered `qualified !== false`)
- `allTonightPlays` — raw including `qualified:false`. Used to build `tonightPlayerMap` so all market-report players have explanation data.
- `mlbMeta` — `{ pitchers, gameOdds, umpires, weather, projectedLineupTeams, teamsWithLineup }` — pitchers merged from ESPN probables + MLB API. `gameOdds` includes total+spread (from ESPN MLB scoreboard, today OR tomorrow if today complete; no date gate in MatchupCard).
- `mlbMetaTomorrow` — same shape from tomorrow's MLB API schedule. Pitchers only (era null); gameOdds/weather always empty.
- `nbaMeta` — `{ gameOdds, injuries, gameScores }`. `gameScores` from `parseGameScores`, includes `seriesSummary` in playoffs.
- `nhlMeta` — `{ gameScores, gameOdds }`. Same shape.
- `reportData` — full debug response for Market Report overlay
- `player`, `teamPage`, `teamPageData`, `pendingSlug`, `trackedPlays`

### Market Report
Sport tabs: ALL / MLB / NBA / NHL (calibration moved to Model Reference page). Columns vary by sport/stat via `XCOLS` map; `COL_TIPS` dictionary supplies hover tooltips. `xcell` function in `MarketReport.jsx` is authoritative for column color tiers — match SimScore tiers (yellow = middle tier, gray = abstain or lowest, red = 0pts).

`fetchReport` updates `tonightPlays` and `allTonightPlays` from the debug response so the plays card stays in sync.

**SimScore tooltip** (hover any `X/10` badge): `buildSimTooltip(m)` in `MarketReport.jsx` is the canonical helper for all play types. Per-component breakdown with actual values.

**Sort defaults**: team totals = Score desc. HRR table: threshold=1 only (others filtered client-side).

**Score>7 highlight**: MLB rows show white+bold name only when `finalSimScore ?? hitterFinalSimScore > 7` (Alpha tier). Other rows use `m.qualified`.

### Live Pick Tracking
- Player props: `App.jsx` polls `/api/live` every 60s when any active player-prop pick has `gameDate === today`. Auto-resolves on threshold met (`won`), state==="post" + stat<threshold (`lost`), or player absent from boxscore after game end (`DNP`).
- Totals/team totals: separate effect resolves from existing `mlbMeta/nbaMeta/nhlMeta.gameScores` when state==="post" (no extra API call).
- `fetchLiveStats` requires `pick.opponent` to build the `sport:team1:team2` game key. Picks tracked from the **player card** include `opponent: tonightPlay?.opponent` (App.jsx track button); the play card's `trackPlay` already spreads it from the API. For older picks lacking `opponent`, `fetchLiveStats` resolves it from `currentMeta.{sport}Meta.gameScores` by `playerTeam` and backfills it on the pick (one-time mutation persisted via `setTrackedPlays`). `AddPickModal` does NOT collect opponent — manual picks stay unresolved unless the user enters the result by hand.
- Polling effect must read meta from `liveMetaRef.current` (not closure). The polling `useEffect` deps are `[unresolvedCount, fetchLiveStats]` so it does NOT re-run when meta loads asynchronously — without the ref, the 60s `setInterval` callback would forever close over the empty initial meta and the backfill path would never fire. A separate effect on `[mlbMeta, nbaMeta, nhlMeta]` updates the ref and triggers an immediate poll the first time `gameScores` becomes available.
- Player-name lookup must be diacritic-tolerant via `findLivePlayer(players, name)` in `liveStats.js`. ESPN's scoreboard returns ASCII names (`"Nikola Jokic"`) while the player profile/search returns the original (`"Nikola Jokić"`). Picks tracked from the player card store the diacritic form, so a direct `players[pick.playerName]` lookup misses. The helper does an exact-key check first (cheap), then falls back to NFD-normalized scan. Used in both `buildLiveDisplay` and the auto-resolve path in `App.jsx fetchLiveStats`.

### Game time + lineup badges
- Play card subtitle: `"Today · 7:40 PM PT"` / `"Tomorrow · 1:10 PM PT"` from `play.gameTime`.
- Lineup badge: `play.lineupConfirmed === true` → green `✓ Lineup`; `=== false` → gray `Proj. Lineup`. **`Proj. Lineup` suppressed when game is within 30min of start** (`Date.now() ≥ new Date(gameTime).getTime() - 30*60*1000`).

### Stake / pick units
`tierUnits(americanOdds) = |americanOdds|/10`. Stored on tracked picks as `units`. Implied-probability-calculator override: if a value is entered at track time, `savedOdds = calcOverride ?? finalOdds` overrides BOTH `americanOdds` and `units`. Picks editor has `$` input for override.

### Color tiers (utility)
```
tierColor(pct): ≥80 → #3fb950 green, ≥65 → #e3b341 yellow, else #f78166 red
```

### Backend monotonicity for player card
Strikeout truePct is enforced via:
1. `qualified:false` plays in `plays[]` keep all thresholds (key `playerName|sport|stat|threshold` so no dedup collision)
2. Post-loop sweep re-derives truePct for every threshold from `pitcherKDistCache` distribution
3. Frontend `_rawTruePctMap` walks highest→lowest tracking running max as safety net

---

## Data Sources

| Source | Used for | Reliability |
|---|---|---|
| Kalshi Trade API | Market prices | ✅ |
| MLB Stats API | Schedule, lineups, pitcher stats, season aggregates, splits | ✅ |
| ESPN APIs (`site.web.api.espn.com`) | Player info, gamelogs (all sports) | ✅ |
| ESPN scoreboard | Probables, game odds, weather, scores, series | ✅ |
| Baseball Savant | Barrel% CSV | ⚠️ 5s timeout, cached 6h |
| ESPN DVP, depth chart | DVP, NBA position | ✅ |
| ESPN `sports.core.api.espn.com` | NBA pace + OffRtg/DefRtg | ✅ cached 12h |
| stats.nba.com | — | ❌ blocks server-side |

---

## Deployment
- Vercel Edge Functions; auto-deploys on `git push origin main` (no `vercel` CLI). Frontend built by Vercel via `npm run build`.
- Rewrites in `vercel.json`: `/api/:path*` → `/api/[...path]`. CORS headers also there (required for OPTIONS preflight through rewrite layer).
- Cron: `/api/keepalive` daily at noon UTC.

### Required env vars (Vercel dashboard AND wired via `env` object — see Gotchas):
| Variable | Purpose | Generate |
|---|---|---|
| `JWT_SECRET` | HMAC for auth tokens | `openssl rand -base64 32` |
| `ADMIN_KEY` | Admin endpoint shared secret | `openssl rand -base64 32` |
| `UPSTASH_REDIS_REST_URL` | Upstash REST endpoint | Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash auth token | Upstash console |

No hardcoded fallbacks. Missing `JWT_SECRET` → 500 on auth. Missing `ADMIN_KEY` → 403 on all admin endpoints (fail-closed). Redeploy after rotating.

---

## Testing
```
# Preferred (no Node — uses macOS JavaScriptCore):
osascript -l JavaScript api/lib/simulate.test.jxa.js

# If Node installed:
node --test api/lib/simulate.test.js
```
Both files kept in sync. Coverage: `kDistPct` monotonicity, `simulateKsDist` validity, `buildNbaStatDist`, API monotonicity sweep, `allTonightPlays` player card fix, frontend `_rawTruePctMap` enforcement, NBA simScore, report filter logic, `_parseWind` ESPN string parsing, `weatherFactor` formula. 55 tests total.

---

## Common Debugging
See [docs/DEBUGGING.md](docs/DEBUGGING.md).
