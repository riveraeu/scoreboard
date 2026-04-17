# Scoreboard — Project Guide for Claude

## Workflow for New Features and Debugging

Follow these steps in order for every change:

1. **Check memory and CLAUDE.md** — Read `MEMORY.md` and relevant memory files for prior context. Scan CLAUDE.md for existing documentation on the area being changed (architecture, debugging sections, key functions table).
2. **Plan and get approval** — Present the full plan as text only (files to change, logic to add/modify, edge cases). Wait for explicit user approval before editing any files.
3. **Implement** — Make the changes. If any backend logic changed, confirm the fix by calling the production API (`/api/tonight?debug=1` or the relevant endpoint) and printing the key fields that prove the change is correct.
4. **Deploy and document** — `git push origin main` to deploy. Update CLAUDE.md in the same commit (not a separate step). Save a memory entry for anything non-obvious that future sessions should know.

---

## What This Is
A sports prop betting dashboard that pulls Kalshi prediction market prices, computes a model True%, and shows qualified plays with an edge over the market. Deployed on Vercel Edge (no Node.js APIs — Web Fetch/KV only).

**Production URL**: `https://scoreboard-ivory-xi.vercel.app`

---

## Architecture

### API: `api/[...path].js` + `api/lib/`
`api/[...path].js` handles all server logic as a Vercel Edge Function. It imports from four ES module lib files:
- `api/lib/simulate.js` — park factor constants + all simulation functions (log5K, simulateKsDist, buildNbaStatDist, simulateHits, kelly/EV math)
- `api/lib/mlb.js` — MLB data fetchers (buildLineupKPct, buildBarrelPct, buildPitcherKPct) + MLB_ID_TO_ABBR
- `api/lib/nba.js` — NBA/DVP data fetchers (buildNbaDvpStage1/FromBettingPros/Stage3FG, buildNbaDepthChartPos, buildNbaPaceData, buildNbaPlayerPosFromSleeper, warmPlayerInfoCache, buildNbaUsageRate, buildNbaInjuryReport)
- `api/lib/utils.js` — response helpers (corsHeaders, jsonResponse, errorResponse), ALLOWED_ORIGIN, team ranking helpers (buildSoftTeamAbbrs, buildHardTeamAbbrs, buildTeamRankMap, parseGameOdds, SOFT_TEAM_METRIC)

Routes via `pathname`:
- `/api/tonight` — main play generation endpoint
- `/api/tonight?debug=1` — returns all markets including dropped/preDropped + debug fields
- `/api/tonight?bust=1` — bypasses KV cache
- `/api/kalshi` — raw Kalshi market data
- `/api/player` — ESPN player info + gamelog
- `/api/dvp` — Defense vs Position data
- `/api/nba-depth` — NBA depth chart from ESPN
- `/api/keepalive` — cron ping (daily)
- `/api/dvp/debug-dc` — inspect depth chart cache
- `/api/auth/register` — create account (POST `{email, password}`)
- `/api/auth/login` — login (POST `{email, password}`) → `{token, userId, email}`
- `/api/auth/reset` — admin password reset (POST `{email, newPassword, adminKey}`)
- `/api/auth/list-users` — list all user keys in Redis (GET `?adminKey=`)
- `/api/auth/debug-redis` — raw Upstash SET+GET diagnostic (GET `?adminKey=`) — returns `{setStatus, setRaw, getStatus, getRaw, match}` to confirm Redis is writable
- `/api/auth/import-kalshi-picks` — import fills from Kalshi into user picks (POST `{kalshiSession, adminKey, userId}`) — fetches last 5 days of YES fills, maps tickers to play format, auto-populates won/lost for finalized markets
- `/api/user/picks` — GET/POST user picks (requires `Authorization: Bearer <token>`)

### Frontend: `index.html`
Single HTML file with JSX compiled via Babel standalone (no build step). All React components inline.

### Storage: Upstash Redis (`CACHE2`)
On Vercel, `env.CACHE` (Cloudflare KV binding) is unavailable — `makeCache()` falls through to the Upstash Redis REST client using `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` env vars. The Upstash free tier caps at **500k commands/month** — when exceeded, all reads/writes silently return null (Upstash returns HTTP 400 `{"error":"ERR max requests limit exceeded..."}` but the `cmd()` wrapper only extracts `result`, so errors are invisible). Use `/api/auth/debug-redis?adminKey=` to confirm Redis is writable. If the limit is hit: create a new free Upstash database or upgrade to Pay-As-You-Go in the Upstash console, then update `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Vercel Environment Variables.

User auth data (`user:{email}`) and picks (`picks:{userId}`) are stored in the same Redis instance. JWT tokens expire after **365 days**. Picks are also kept in `localStorage` as a live backup — if server returns 0 picks on load but localStorage has data, the frontend restores from local and pushes it back to the server.

Used for caching expensive fetches. Key TTLs:
- `byteam:mlb` — 600s (MLB team stats, probables, lineup K-rates). **Does NOT include `barrelPctMap`** — that lives in `mlb:barrelPct`. Uses 60s TTL if lineupSpotByName or pitcherAvgPitches come back empty (e.g. bust before lineups confirmed), so next request retries quickly.
- `byteam:nba` — 1800s (defensive stats)
- `byteam:nba:scoring` — 21600s (6h, NBA team offensive PPG; used for total simulation)
- `nba:injuries:{date}` — 1800s (ESPN NBA injury report: Out players per team, used for C2 injury boost)
- `byteam:nfl` — 1800s
- `byteam:nhl` — 21600s (6h, NHL team stats: goalsAgainstPerGame + shotsAgainstPerGame)
- `gameTimes:v2:{date}` — 600s
- `nbaStatus:{date}` — 600s
- `nba:pace:2526` — 43200s (12h, fetched via ESPN `sports.core.api.espn.com` team stats, `buildNbaPaceData()`)
- `mlb:barrelPct` — 21600s (6h, Baseball Savant barrel%)
- `nba:depth:{date}` — daily

---

## Sports & Stats

### Game Totals (all sports)
- **Stat**: `totalRuns` (MLB), `totalPoints` (NBA), `totalGoals` (NHL), `totalPoints` (NFL)
- **Kalshi series**: `KXMLBTOTAL`, `KXNBATOTAL`, `KXNHLTOTAL`, `KXNFLTOTAL` — each with `gameType: "total"` in SERIES_CONFIG
- **Market format**: `floor_strike = N` means "over N-0.5" (i.e., YES = total >= N); `pct` filter: 30–97% (wider than player props)
- **True%**: Monte Carlo simulation per sport — Poisson for MLB/NHL (`simulateMLBTotalDist`, `simulateNHLTotalDist`), Normal for NBA (`simulateNBATotalDist`)
- **Team extraction**: `parseGameTeams()` handles all sport-specific team code formats. Kalshi uses non-standard abbreviations for some teams; `TEAM_NORM` (in `api/[...path].js`) maps them to ESPN standard codes: NBA: `{ GS→GSW, SA→SAS, NY→NYK, NJ→BKN, NO→NOP, PHO→PHX, WPH→PHX }`. After building `STAT_SOFT["nba|*"]` rankMaps from ESPN byteam (which also returns short codes like "GS"), a post-normalization loop adds the long-form key so `nbaDefRank["GSW"]` resolves correctly.
- **`direction: "over"`** — currently only over plays surfaced (YES on Kalshi)
- **Edge gate**: `edge >= 3%` (same as player props); no soft matchup gate for totals
- **SimScore** (max 14): tiered by stat quality, not just data existence; `qualified: totalSimScore >= 11`
- **Data maps** (`mlbRPGMap`, `nhlGPGMap/GAAMap`, `nbaOffPPGMap`) computed inline after `leagueAvgCache` block
- **Play card**: `gameType: "total"` flag triggers `TotalPlayCard` branch in the play card render; shows dual team logos (ESPN CDN), matchup header, true%/Kalshi% bars, explanation prose, SimScore badge
- **Deduplication**: one total play per game (homeTeam+awayTeam+sport), keeping highest truePct — multiple thresholds for the same game reduced to the best one
- **Expected total**: `homeExpected + awayExpected` (lambda sum for MLB/NHL, PPG-adjusted for NBA) shown in explanation prose; `_simData` includes `homeExpected`, `awayExpected`, `expectedTotal`; NBA also includes `homePace`, `awayPace`, `leagueAvgPace`; NHL includes `homeSAKnown`, `awaySAKnown`
- **SimScore tooltip**: hover the `X/14` badge to see per-component breakdown with actual values. NBA example: `CHA off PPG (116): 2/3`. NHL example: `LAK GPG (2.7): 1/3`, `CGY GAA (3.15): 1/2`.
- **Edge badge**: shows `+X%` only — tooltip removed (spreadAdj no longer subtracted from edge)
- **Track ID format**: `total|sport|homeTeam|awayTeam|threshold|gameDate`

#### Total SimScore details
- **MLB**: homeERA tiered (>4.5→3, >3.5→2, ≤3.5→1, null→0), awayERA tiered (same), homeRPG tiered (>5.0→2, >4.0→1, ≤4.0→0, null→0), awayRPG tiered (same), parkRF>1.01→2pts (run-friendly parks only; pitcher-friendly parks score 0), O/U line tiered (≥9.5→2pts, ≥7.5→1pt, <7.5→0pts, null→1pt) (max 14). High ERA and high RPG score higher — both are over-favorable signals. O/U is the market consensus and is independent of ERA/RPG.
- **NBA**: off PPG tiered (≥118→3, ≥113→2, else 1, null→0) per team (max 3+3=6); def PPG allowed tiered (≥118→2, ≥113→1, else 0, null→0) per team (max 2+2=4); both pace known→2pts; avg pace above league→2pts (max 14)
- **NHL**: homeGPG tiered (≥3.5→3, ≥3.0→2, <3.0→1, null→0), awayGPG tiered (same), homeGAA tiered (≥3.5→2, ≥3.0→1, <3.0→0, null→0), awayGAA tiered (same), home SA rank→2pts, away SA rank→2pts (max 14). High GPG and high GAA score higher — both are over-favorable signals.

#### Lambda computation (MLB)
`homeLambda = homeRPG × (awayERA / 4.20) × parkRF`, clamped [1, 12]
`awayLambda = awayRPG × (homeERA / 4.20) × parkRF`, clamped [1, 12]

#### Lambda computation (NHL)
`homeLambda = homeGPG × (awayGAA / leagueAvgGAA)`, clamped [0.5, 8]
`awayLambda = awayGPG × (homeGAA / leagueAvgGAA)`, clamped [0.5, 8]

#### Mean computation (NBA)
`homeExpected = homeOffPPG × (awayDefPPG / leagueAvgDef)`
`awayExpected = awayOffPPG × (homeDefPPG / leagueAvgDef)`

### MLB
- **Stats**: `hits`, `hrr` (H+R+RBI), `strikeouts`
- **Kalshi series**: `KXMLBHITS`, `KXMLBHRR`, `KXMLBKS`
- **Data sources**: MLB Stats API (schedule, lineups, probables, pitcher gamelogs), ESPN gamelogs, Baseball Savant (barrel%)

#### MLB Strikeouts Model
True% = Monte Carlo simulation (`simulateKsDist` + `kDistPct`)
- Shared distribution per pitcher (keyed `playerTeam|pitcherHand`) — guarantees P(K≥4) ≥ P(K≥5)
- `pitcherKDistCache` built before play loop
- 10000 sims if `simScore ≥ 11`, else 5000
- **SimScore** (max 14, no edge bonus — edge gates separately):
  - CSW%/K% tiered (1/2/3pts): CSW% > 30% = 3pts (green), CSW% > 26% to ≤ 30% = 2pts (yellow), CSW% ≤ 26% = 1pt (red). Falls back to regressed K% only if CSW% is unavailable (null): K% > 27% = 3pts, K% > 24% to ≤ 27% = 2pts, K% ≤ 24% = 1pt. Null CSW% + null K% = 1pt (abstain). (The gs26 < 4 small-sample guard was removed — CSW% is always used when present, regardless of gs26.) Stored as `kpctPts` (1/2/3); `kpctMeets = kpctPts > 0` (boolean, always true now).
  - K-BB% > 15% → 2pts
  - Lineup oK% tiered (`lkpPts`): > 24% → 3pts (green), > 16% → 2pt (yellow, avg/below-avg lineup), ≤ 16% → 0pts; null → 1pt (abstain, like ML/total). `lkpMeets = lkpPts > 0`. Hand-adjusted vs RHP/LHP.
  - Avg pitches/start tiered (`pitchesPts`): > 85 → 2pts (green), > 75 → 1pt (yellow), ≤ 75 → 0pts; null → 1pt (abstain). (uses 2026 data only if gs26 ≥ 4; else falls back to 2025)
  - ML tier (`mlPts`): ≤ -130 → 2pts, -129 to -101 → 1pt, ≥ -100 → 0pts; null → 1pt
  - O/U tier (`totalPts`): ≤ 8.5 → 2pts (low total = pitcher dominant), 8.5–10.5 → 1pt, >10.5 → 0pts; null → 1pt
  - Edge ≥ 3% required (gates play independently, not part of SimScore)
- `parkMeets` (`PARK_KFACTOR[homeTeam] > 1.0`) is still computed and included in debug output but no longer contributes to SimScore — park factor is applied inside `simulateKsDist` and affects truePct directly. `PARK_KFACTOR` values updated from FanGraphs 2024 SO column (multi-year rolling avg).
- `kpctPts`: 1/2/3 — CSW%/K% tier score. 3=green (CSW%>30% or K%>27%), 2=yellow (CSW% 26-30% or K% 24-27%), 1=red (≤26% CSW or ≤24% K, or null). Drives badge color and value in explanation cards.
- `mlPts`: 0/1/2 — ML tier score. Color in UI: 2=green, 1=yellow, 0=red. Also drives ML column color in market report (≤-130 green, -129 to -101 yellow, ≥-100 red).
- `totalPts`: 0/1/2 — O/U tier score. Color in UI: 2=green, 1=yellow, 0=red. Drives O/U column color in market report (≤8.5 green, 8.5–10.5 yellow, >10.5 red). Low total = pitcher dominant = favorable for Ks.
- `pitcherGS26`: 2026 games started per team abbr, exported from `buildPitcherKPct`, used for small-sample guards. Included in `plays[]` output for debugging (alongside `pitcherHasAnchor`).
- **Gates**: simScore ≥ 7 to enter play loop; finalSimScore ≥ 11 to qualify as a play (7–10 = qualified:false, shows in report but not plays card); insufficient_starts gate: if `hasAnchor !== true` (no reliable 2025 anchor, or null if not in data) requires `gs26 ≥ 8` (null gs26 treated as 0); if `hasAnchor === true` passes through regardless of gs26 — the 2025 anchor IS the reliability signal. Catches TJ-return / pure-reliever pitchers who have a few 2026 starts but no valid 2025 baseline (e.g. Detmers with 0 2025 GS — needs 8 starts before model trusts). **Important**: insufficient_starts is checked in BOTH the pre-filter loop AND the main play loop (because `?debug=1` bypasses the pre-filter and uses `qualifyingMarkets` directly). Main loop gate at `api/[...path].js` ~line 1713 uses corrected `playerTeam`; in debug mode pushes to `dropped[]` with reason `"insufficient_starts"` so they appear in the report but not in `plays[]`.
- `pitcherHasAnchor`: `true` if gs25 ≥ 5 AND bf25 ≥ 100 (reliable 2025 *starter* anchor). Included in `plays[]` output for debugging. A reliever-turned-starter has bf25 > 0 but gs25 = 0 — reliever K% is not a valid anchor. bf25 ≥ 100 also excludes injury-shortened seasons (e.g. TJ recovery with 5 starts but minimal workload).
- Pitchers fetched via `buildPitcherKPct(mlbSched)` — avg pitches per start from 2026 gamelog (starts-only filtered via `gamesStarted > 0`); falls back to 2025 season aggregate `numberOfPitches / gamesStarted` when no 2026 start data in gamelog
- **K% regression**: `trust = min(1.0, bf26 / 200)` — uses 2026 BF only (NOT combined 2026+2025). Full trust at ~33 starts. Blends 2026 actual K% with 2025 anchor (or league avg 22.2% if no 2025 data). KBB% regressed the same way.
- **A1 — Pitcher recent form**: `_recentKPct` from last 5 starts with ≥3 starts and 30+ BF. Effective K% = `recentKPct × 0.6 + seasonKPct × 0.4` when recent data meets the threshold; else uses season K% only. `pitcherRecentKPct` map exported from `buildPitcherKPct`, keyed by team abbr.
- **A2 — Pitcher rest/fatigue**: After truePct is computed, a fatigue multiplier is applied to the simulated pitcherKPct before re-querying the distribution. Days since last start ≤ 3 → `× 0.96`; days ≤ 3 AND last start pitch count ≥ 95 → `× 0.92` (short rest + heavy workload). `pitcherLastStartDate` and `pitcherLastStartPC` maps exported from `buildPitcherKPct`, keyed by team abbr.

#### MLB Hitters (hits/hrr) Model
- **`hits` True%**: Monte Carlo simulation (`simulateHits`) using batter BA × pitcher BAA (log5), park-adjusted
- **`hrr` True%**: `(primaryPct + softPct) / 2 × parkFactor` (no Monte Carlo)
  - `primaryPct` = player's 2026 HRR 1+ rate (falls back to 2025+2026 blend, then career)
  - `softPct` = HRR 1+ rate vs tonight's pitcher (H2H gamelog dates) or vs tonight's team (2025+2026 fallback)
  - BA is NOT directly in the formula — it's implicit via the player's historical HRR rate
- **SimScore** (max 14, edge gates separately — same pattern as strikeouts):
  - Lineup spot 1–3 → 3pts, spot 4 → 2pts
  - Pitcher WHIP > 1.35 → 3pts (from pitcher gamelog)
  - B1 platoon tier (`hitterPlatoonPts`): `splitBA / seasonBA ≥ 1.10 → 2pts` (strong platoon advantage), `≥ 0.95 → 1pt` (neutral/slight), `< 0.95 → 0pts` (platoon disadvantage); null → 1pt (abstain). `batterSplitBA` from MLB Stats API `statSplits/sitCodes=vr|vl`, requires 30+ AB; replaces former Pitcher FIP > ERA pts.
  - Park hit factor > 1.02 → 1pt
  - Barrel% tier: ≥14% → 3pts, ≥10% → 2pts, ≥7% → 1pt, <7% → 0pts, null → 1pt (abstain)
  - O/U total tier (high total = more run-scoring): ≥9.5 → 2pts, ≥7.5 → 1pt, <7.5 → 0pts, null → 1pt
  - Max: 3+3+2+1+3+2 = 14
- **B2 — Batter recent form**: `hitterEffectiveBA = 0.6 × recentBA + 0.4 × seasonBA` when ≥20 AB in last 10 2026 games; else uses seasonBA. Fed directly into `simulateHits` as `batterBA`. `batterRecentBA` map built inline from ESPN gamelog in main play loop.
- **Gates**: lineup spot 1–4 required; hitterSimScore ≥ 7; edge ≥ 3% (gate only, not scored)
- Barrel% from Baseball Savant (`buildBarrelPct`) — cached 6h in KV; `hitterBarrelPts` stored in play output
- NBA game totals fetched from ESPN scoreboard (`sportByteam.nbaGameOdds`) — always fresh (not long-term cached)

### NBA
- **Stats**: `points`, `rebounds`, `assists`, `threePointers`
- **Kalshi series**: various per stat
- True% = Monte Carlo simulation (`buildNbaStatDist` + `nbaDistPct`) — normal distribution over per-game values
  - `nbaPlayerDistCache` keyed `playerId|stat` — all thresholds (3+, 4+, 5+) share one distribution, guaranteeing monotonicity
  - Mean from last 10 games (recency), std from full season (stability)
  - Adjusted mean: `× teamDefFactor × (1 + paceAdj×0.002) × 0.93 if B2B × miscAdj`
  - `teamDefFactor` = general team defense (`rankMap[opp].value / leagueAvg`) — NOT position-adjusted DVP
  - `miscAdj` (6th param of `buildNbaStatDist`, default 1.0) = combined C2 × C3 × C4 scalar:
    - **C2 — Injury boost**: `1.08` per Out player on opponent (capped at `1.15x`). Out players from `buildNbaInjuryReport` (ESPN NBA injuries endpoint, cached 1800s).
    - **C3 — Blowout risk**: `max(0.85, 1 - (|spread| - 10) × 0.007)` when `|spread| > 10`; else 1.0. Spread from `parseGameOdds` (now included in `sportByteam.nbaGameOdds`). Shows "Blowout risk — large spread reduces model mean by X%" badge in explanation.
    - **C4 — Home/away split**: `nbaSplitAdj = splitMean / overallMean` where `splitMean` is the weighted avg (0.7 home or 0.3 away depending on venue) of home/away-filtered game values vs the opponent type; fallback to 1.0 if insufficient split data.
  - Falls back to avg(seasonPct, softPct) − 4% if B2B when simulation returns null (<5 game values)
- **SimScore** (max 14, edge gates separately — same pattern as MLB strikeouts):
  - Pace: avg pace >0 vs league avg → 3pts, >-2 → 2pts, else 0pts — fetched from ESPN via `buildNbaPaceData()`, cached 12h
  - **C1 — USG%** (replaces avgMin): ≥28% → 4pts, ≥22% → 2pts, <22% → 0pts, null → 2pts (abstain). From `buildNbaUsageRate` (endpoint: `sports.core.api.espn.com/v2/.../seasons/2026/types/2/athletes/{id}/statistics`, path `d.splits.categories`; ESPN `usageRate` field is 0.0 this season so fallback always runs: `USG% = (avgFGA + 0.44×avgFTA + avgTO) / (avgMin × 2.255) × 100` — verified ~29% for Banchero vs actual ~30%).
  - Position-adjusted DVP rank ≤ 10 → 2pts
  - Not B2B → 2pts
  - Game total tier: ≥235 → 3pts, ≥225 → 2pts, ≥215 → 1pt, <215 → 0pts, null → 1pt (abstain)
  - Max: 3+4+2+2+3 = 14
  - Game totals from `sportByteam.nbaGameOdds` (ESPN NBA scoreboard, fetched fresh each request alongside byteam stats)
- nSim scales with pre-edge simScore: ≥8 → 10k, ≥5 → 5k, else 2k
- **Gate**: opp in soft DVP teams; edge ≥ 3% (gate only, not scored)
- Avg minutes still extracted from ESPN gamelog `MIN` column (last 10 games) — used for display in explanation card but no longer the SimScore component
- Depth chart position via `nbaDepthChartPos` (ESPN depth chart API, cached daily)

### NHL
- **Stats**: `points` only (goals/assists removed)
- **Kalshi series**: `KXNHLPTS`
- **Data sources**: NHL Stats API (GAA, shots against per team), ESPN gamelogs (points, TOI)

#### NHL Points Model
True% = Monte Carlo simulation (reuses `buildNbaStatDist` + `nbaDistPct`) — normal distribution over per-game point values
- `nhlPlayerDistCache` keyed `playerId|stat` — all thresholds share one distribution, guaranteeing monotonicity
- Mean from recent game values, adjusted: `× teamDefFactor × (1 + shotsAdj×0.002) × 0.93 if B2B × nhlToiTrendAdj`
- `teamDefFactor` = opp GAA / league avg GAA
- **D3 — TOI trend**: `nhlToiTrendAdj = clamp(recent3TOI / last10TOI, 0.92, 1.08)` where recent3 is the last 3 games and last10 is the 10-game avg — applied as `miscAdj` 6th param to `buildNbaStatDist`. Only applied when ratio > 1.05 (increasing → boost up to 1.08×) or < 0.95 (decreasing → penalty down to 0.92×); else 1.0.
- Falls back to dvp-adjusted average formula if simulation returns null
- **SimScore** (max 11 pre-edge, 14 with edge bonus):
  - Shots against adj (opp SA vs league avg > 0) → 3pts
  - Avg TOI ≥ 18 min (last 10 games) → 4pts; ≥ 15 min → 2pts
  - Opponent GAA rank ≤ 10 → 2pts
  - Not B2B → 2pts
  - Edge ≥ 3% → 3pts (bonus, added after simulation)
- nSim scales with pre-edge simScore: ≥8 → 10k, ≥5 → 5k, else 2k
- **B2B** detection: same as NBA — checks if last gamelog event was yesterday (UTC)
- TOI from ESPN gamelog `TOI` or `timeOnIce` column; parsed as `MM:SS` or decimal minutes
- Shots against rank from NHL API `shotsAgainstPerGame`, stored in `nhlSaRankMap`, league avg in `nhlLeagueAvgSa`
- **Gate**: edge ≥ 3% (no backend soft team gate — all NHL markets enter play loop)

### NFL
- **Stats**: `passingYards`, `rushingYards`, `receivingYards`, `receptions`, `completions`, `attempts`
- Gate: opp in soft teams; edge ≥ 3%

---

## Key Functions & Code Locations

### `api/lib/simulate.js` — Simulation & Math

| Function/Constant | What it does |
|---|---|
| `PARK_KFACTOR` | Park factors for strikeout simulation (30 parks) |
| `PARK_HITFACTOR` | Park factors for hit simulation |
| `PARK_HRFACTOR` | Park factors for home run simulation (defined, available if needed) |
| `log5K(pitcherKPct, batterKPct)` | Log5 formula for K probability |
| `simulateKsDist(orderedKPcts, pitcherKPct, parkFactor, nSim)` | Shared Monte Carlo, returns `Int16Array` of K counts |
| `kDistPct(dist, threshold)` | Queries K dist — guarantees monotonicity |
| `buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim, miscAdj)` | Shared `Float32Array` of simulated NBA per-game values; `miscAdj` (6th param, default 1.0) is a scalar multiplier applied to adjusted mean — used for C2 injury boost, C3 blowout risk, C4 H/A split, and D3 NHL TOI trend |
| `nbaDistPct(dist, threshold)` | Queries NBA dist for any threshold — guarantees monotonicity |
| `simulateHits(batterBA, pitcherBAA, parkFactor, threshold, nSim)` | Monte Carlo for hitter hits/HRR |
| `PARK_RUNFACTOR` | Park run factors for game total simulation (30 parks + OAK legacy) |
| `simulateMLBTotalDist(homeLambda, awayLambda, nSim)` | Poisson MC for MLB game total, returns `Int16Array` |
| `simulateNBATotalDist(homeMean, awayMean, homeStd, awayStd, nSim)` | Normal MC for NBA game total, returns `Int16Array` |
| `simulateNHLTotalDist(homeLambda, awayLambda, nSim)` | Poisson MC for NHL game total, returns `Int16Array` |
| `totalDistPct(dist, threshold)` | Queries game total dist — same interface as `nbaDistPct` |
| `kellyFraction / evPerUnit` | Kelly and EV calculations |

### `api/lib/mlb.js` — MLB Data Fetchers

| Function/Constant | What it does |
|---|---|
| `MLB_ID_TO_ABBR` | MLB team ID → abbreviation mapping |
| `buildLineupKPct(mlbSched)` | Lineup batter K-rates, lineup spots, ordered arrays; also exports `batterSplitBA` (vsR/vsL BA, 30+ AB) for B1 platoon |
| `buildBarrelPct()` | Baseball Savant barrel% CSV, 5s timeout, cached 6h |
| `buildPitcherKPct(mlbSched)` | Pitcher season stats (K%, KBB%, ERA, P/GS, CSW%, GS26); also exports `pitcherRecentKPct`, `pitcherLastStartDate`, `pitcherLastStartPC` for A1/A2 |

### `api/lib/nba.js` — NBA/DVP Data Fetchers

| Function | What it does |
|---|---|
| `warmPlayerInfoCache(cache)` | Batch-fetches ESPN player info for all Kalshi market players |
| `buildNbaDvpStage1(cache)` | ESPN rosters → posMap, selectedByPos cached to KV |
| `buildNbaDvpFromBettingPros(cache)` | DVP from BettingPros (preferred source) |
| `buildNbaDepthChartPos(cache)` | ESPN depth chart → `{espnPlayerId: "PG"\|"SG"\|...}` |
| `buildNbaPaceData(cache)` | ESPN team stats → `{teamPace, leagueAvgPace}`, cached 12h |
| `buildNbaPlayerPosFromSleeper(cache)` | Sleeper.app fallback for player → position |
| `buildNbaDvpStage3FG(cache)` | DVP stage 3 gamelog fallback |
| `buildNbaUsageRate(playerIds)` | `sports.core.api.espn.com/v2/.../seasons/2026/types/2/athletes/{id}/statistics` → `{playerId: {usg, source}}` map; path `d.splits.categories`; batches in groups of 10; ESPN `usageRate` = 0.0 (not populated), so fallback computes `(avgFGA + 0.44×avgFTA + avgTO) / (avgMin × 2.255) × 100` |
| `buildNbaInjuryReport(cache)` | ESPN NBA injuries → `Map<teamAbbr, [{name, status}]>` (Out only); cached 1800s in `nba:injuries:{date}` |

### `api/lib/utils.js` — Response Helpers & Team Ranking

| Function/Constant | What it does |
|---|---|
| `ALLOWED_ORIGIN` | CORS origin (`"*"`) |
| `corsHeaders()` | CORS response headers |
| `jsonResponse(data, opts)` | Returns JSON Response with CORS headers |
| `errorResponse(msg, status)` | Returns error JSON Response |
| `SOFT_TEAM_METRIC` | ESPN stat hint/index per NBA stat |
| `parseGameOdds(events)` | Extract ML/total/spread from ESPN scoreboard events; returns `{total, moneyline, spread}` per team abbr |
| `buildSoftTeamAbbrs(teams, stat)` | Top-N teams allowing most of a stat |
| `buildHardTeamAbbrs(teams, stat)` | Teams ≤ 95% of league avg (tough defenses) |
| `buildTeamRankMap(teams, stat)` | Full rank map `{abbr: {rank, value}}` |

### `api/[...path].js` — Route Handlers & Play Loop

**Key constants & loop setup**
| Symbol | Line | What it is |
|---|---|---|
| `SERIES_CONFIG` | ~889 | Kalshi series tickers per sport/stat |
| `pitcherKDistCache` | ~1549 | Per-pitcher K distribution cache (keyed `team|hand`) |
| `nbaPlayerDistCache` | ~1551 | Per-player NBA stat distribution cache (keyed `playerId|stat`) |
| `leagueAvgCache` | ~1487 | League avg per `sport|stat` for DVP factor computation |
| `STAT_SOFT` | ~1176 | Soft/rank data per `sport|stat`, built from byteam data |

### Kalshi Market Parsing
- Series tickers in `SERIES_CONFIG`
- Filter: `pct >= 70` AND `pct <= 97`
- Blended fill price via orderbook walk for thin markets
- `kalshiSpread` = bid-ask spread in cents (`round((yesAsk − yesBid) × 100)`); kept in output as a liquidity signal (shown as badge when wide)
- `rawEdge = truePct − kalshiPct`; `edge = rawEdge` — `kalshiPct` is already the fill price (ask or blended orderbook walk), so no further spread deduction is applied. `spreadAdj` is computed and stored but not subtracted from edge. This rule applies to **both player props and game totals**.
- Edge badge on play cards shows `+X%` with no tooltip — the old "Raw − spread = net" tooltip was removed since spread is no longer subtracted.
- **E1 — Line movement tracking**: Opening yesAsk stored in KV at `lineOpen:{ticker}:{gameDate}` (TTL 172800s / 2 days) on first encounter. `lineMove = current yesAsk − opening yesAsk` (positive = line moved up / market became more expensive). Shown as badge `▲ Xc` or `▼ Xc` when `|lineMove| ≥ 3`. Included in plays output.
- **E2 — Market depth thresholds**: `lowVolume = kalshiVolume < 50` (raised from 20); `thinMarket = kalshiSpread > 8` (cents, shown as "Wide Spread" badge in red); `marketConfidence = "deep"` (vol≥50 AND spread≤4) / `"moderate"` / `"thin"` (vol<50 OR spread>8). All three fields included in plays output.

### preDropped vs dropped
- `preDropped`: filtered before main play loop (no ESPN info yet) — included in `?debug=1` response
- `dropped`: filtered inside play loop — included in `?debug=1` response
- **Game totals** go to `dropped[]` (not `preDropped`) when they fail the edge gate or have no simulation data (`truePct == null`). Reasons: `"edge_too_low"` or `"no_simulation_data"`. The market report combines `plays[]` + `dropped[]` — `preDropped` is NOT shown in the report.

### qualified:false plays
MLB strikeout markets that fail simScore gate (< 7 or finalSimScore < 11) are pushed to `plays[]` with `qualified: false` so the player card can show real simPct for all thresholds. The main plays list (`tonightPlays`) filters these out client-side: `.filter(p => p.qualified !== false)`.

The raw (unfiltered) array is stored in `allTonightPlays` and used to build `tonightPlayerMap` in the player card — this ensures `qualified: false` thresholds (e.g. 3+/4+ strikeouts with no edge bonus) get their simulation-based truePct rather than falling back to the raw formula.

### bestMap deduplication — which threshold shows in plays card
`bestMap` dedupes to one play per `playerName|sport|stat` for qualified plays. The winner is the play with the **lowest threshold** (`play.threshold < prev.threshold`) — most achievable outcome, highest truePct. Non-qualifying (`qualified: false`) plays use a threshold-inclusive key and don't compete. After bestMap, non-winning qualified thresholds are re-added as `qualified: false` for the player card.

---

## Frontend Architecture (`index.html`)

### State
- `tonightPlays` — qualified plays from `/api/tonight`, filtered `qualified !== false`
- `allTonightPlays` — raw (unfiltered) plays array from `/api/tonight`, includes `qualified: false` entries; used exclusively for building `tonightPlayerMap` in the player card so all strikeout thresholds get their simulation-based truePct instead of falling back to the raw formula
- `reportData` — full debug response from `/api/tonight?debug=1`, shown in Market Report overlay
- `player` — currently selected player for detail card
- `trackedPlays` — user's saved picks (localStorage or server)

### Market Report
Opened via "report" button. Shows ALL markets (plays + dropped) grouped by sport/stat. Columns vary by sport/stat via `XCOLS` map.
- **`fetchReport` syncs plays card**: After fetching `?debug=1`, `fetchReport` also updates `tonightPlays` and `allTonightPlays` from the fresh response. This keeps the plays card in sync with the report (avoids stale-cache discrepancy where plays card loaded at page open shows different results than the report fetched later).
- **HRR table**: shows threshold=1 rows only (2+/3+/etc. filtered client-side — too noisy)
- **Score > 10 highlight**: For MLB rows (strikeouts + HRR), the player name is white+bold only when `finalSimScore ?? hitterFinalSimScore > 10` (Alpha tier). Rows with score ≤ 10 get a dim gray name even if qualified. Non-MLB tables use the original `m.qualified` logic for name color.
- **Game totals table** (`mlb|totalRuns`, `nba|totalPoints`, `nhl|totalGoals`): section header shows **"[Sport] Totals"** (e.g. "NBA Totals") via `STAT_NAME` entries `totalRuns/totalPoints/totalGoals → "Totals"`. First column labelled "Matchup" (not "Player"), shows `AWY @ HME`. Opp column hidden. Line cell shows `O7.5` format. Score column uses `m.totalSimScore` (qual gate = 11); green ≥ 11, yellow = 7–10, gray < 7. XCOLS: MLB = H RPG / A RPG / H ERA / A ERA; NBA = H PPG / A PPG / H Def / A Def; NHL = H GPG / A GPG / H GAA / A GAA. Color for all PPG columns: higher = better for over (≥ threshold → green, near → yellow). **MLB ERA/RPG column colors**: ERA ≥4.5 → green (bad pitcher = over-favorable), ≥3.5 → yellow, <3.5 → gray; RPG ≥5.0 → green, ≥4.0 → yellow, <4.0 → gray. Dedup key for totals is `homeTeam|awayTeam|threshold` (not `playerName|threshold`).

### Toolbar
Right side: **bust** button (calls `?bust=1`, shows "busting…" while loading) + **mock** toggle + My Picks anchor.

**ⓘ info icon** (next to date, left side): toggles a tooltip showing universal play qualification criteria — three lines only: Implied prob ≥ 70%, Edge ≥ 3%, SimScore ≥ 11/14. No sport-specific detail. State: `showPlaysInfo`.

### Play Cards
Shows `untrackedPlays` (qualified plays not yet tracked). Each card has:
- True% bar (color = tierColor, odds = model-implied from truePct)
- Kalshi% bar (purple, odds = Kalshi americanOdds)
- Explanation card (varies by sport/stat)
- SimScore gate breakdown
- **Tier/unit row** — `tierUnits(americanOdds)`: ≤ -900 → 5u, ≤ -500 → 3u, else 1u. Stake = `bankroll × units / 100`.

**Total play cards** (`gameType: "total"`) render differently from player prop cards:
- Header: inline format `[44px away logo] AWY @ HME [44px home logo]` — away logo leads, home logo trails. Team abbreviations at `fontSize:12, fontWeight:600, color:#c9d1d9`. No sport emoji.
- Explanation: single prose block with colored stat values inline; SimScore badge (with hover tooltip) appended at end of prose (no separate SimScore row or checkboxes). Same `background:"#0d1117"` block as player cards.
- Prose includes model-projected expected total vs threshold (e.g. "Model projects 8.4 combined runs vs the 7.5 threshold"). NBA also shows pace adjustment.
- **Stat colors for NBA totals**: offensive PPG — ≥118 red, ≥113 yellow, else gray (high scoring = more risky for over). Defensive PPG allowed — ≥118 green, ≥113 yellow, else red (bad defense = good for over; good defense = bad for over).
- **Stat colors for MLB totals**: ERA — >4.5 green, >3.5 yellow, ≤3.5 red (high ERA = hittable pitcher = good for over). RPG — >5.0 green, >4.0 yellow, ≤4.0 gray (high run-scoring = good for over). Both directions: high value = good for over.
- **Stat colors for NHL totals**: GPG — ≥3.5 green, ≥3.0 yellow, <3.0 gray (high scoring = good for over). GAA — ≥3.5 green, ≥3.0 yellow, <3.0 gray (high GAA = bad defense = good for over). Both directions: high value = green = good for over.
- **SimScore tooltip for MLB totals**: shows actual values and earned points per component (e.g. `SD ERA (4.73): 3/3`, `SEA RPG (4.2): 1/2`). Points derived from same tiered formula as backend.
- **SimScore tooltip for NHL totals**: shows actual values and earned points per component (e.g. `LAK GPG (2.7): 1/3`, `CGY GAA (3.15): 1/2`). Points derived from same tiered formula as backend.
- No player card on click (`gameType === "total"` returns early from `navigateToPlay`).

### Player Card
Clicking a play opens the player card with:
- Historical rates per threshold
- Kalshi market prices
- truePct from `tonightPlayerMap` (keyed `stat|threshold`) — built from `allTonightPlays` (unfiltered) so `qualified: false` thresholds (e.g. 3+/4+ strikeouts with no edge bonus) use their simulation-based truePct
- Monotonicity enforced client-side: after building `_rawTruePctMap`, walks highest→lowest threshold tracking the running max and raises any value that dips below it. Safety net for any remaining non-monotonicity after backend sweep.
- **Per-game gamelog table** (bottom of card) — current season only, sortable columns with hover tooltips

#### Gamelog Table
Defined by `GAMELOG_COLS` constant (before `App()`), keyed by sport (`"baseball/mlb_pitcher"`, `"baseball/mlb_hitter"`, `"basketball/nba"`, `"hockey/nhl"`, `"football/nfl"`). Each column has `key`, `label`, `tooltip`, `align`. Sort state in `gamelogSort: { col, dir }`.

**Columns by sport (SimScore-relevant cols noted):**
- **MLB Pitcher**: Date, H/A, Opp, IP, H (hits allowed), ER, BB *(K-BB% gate)*, K *(CSW%/K% gate)*, PC *(avg pitches gate)*
- **MLB Hitter**: Date, H/A, Opp, AB, H, HR, R *(HRR component)*, RBI *(HRR component)*, BB, HRR *(combined Kalshi stat)*
- **NBA**: Date, H/A, Opp, PTS, REB, AST, 3P, MIN *(≥30=4pts, ≥25=2pts SimScore)*, Rest *(1=B2B gate)*
- **NHL**: Date, H/A, Opp, G, A, PTS, TOI *(≥18min=4pts, ≥15min=2pts SimScore)*, Rest *(1=B2B gate)*
- **NFL**: Date, H/A, Opp, CMP, ATT, PYds, RYds, REC, RecYds

**Data flow**: `parseGameLog` now threads `date`, `isHome`, `season` (derived from date year) into every `perGame` row. Additional stats extracted per sport: `er`/`pc` (pitcher), `ab`/`r`/`rbi`/`bb` (hitter), `min` (NBA), `g`/`a`/`toi` (NHL). `lvRaw` helper preserves TOI as a raw string (avoids `parseFloat("18:32")` = 18).

**Sort**: clicking a header toggles `desc→asc→desc`; new column resets to `desc`. Active sort shows `▲`/`▼`; inactive shows `⇅` (dim). TOI sorted by seconds (parses both `MM:SS` and decimal-minutes). Rest sorted numerically.

**Tooltips**: CSS-based — `.gl-th-wrap:hover .gl-tooltip { display: block }`. Tooltip is an absolutely-positioned `<span className="gl-tooltip">` inside `.gl-th-wrap`.

**Active stat column**: header turns `#58a6ff` and cells get `rgba(88,166,255,0.04)` bg. Mapped via `{ strikeouts→'strikeouts', hits→'hits', hrr→'hrr', points→'points', … }[safeTab]`.

**Rest = 1** (back-to-back) displayed in `#f78166` red as a visual B2B flag. Rest is computed without mutating `perGame` — uses a `restMap` (Map keyed to row object) built from date-ascending sort.

**Root cause of non-monotonic truePcts for strikeouts (fixed at backend):**
The deduplication step (`bestMap` keyed by `playerName|sport|stat`) collapsed all strikeout thresholds for a pitcher to the single highest-edge play (e.g. only 5+ survived). 3+ and 4+ were absent from `allTonightPlays`, so the player card used the fallback formula — giving values below the simulation's 5+ truePct, breaking monotonicity.

Fix: `qualified:false` plays use a threshold-inclusive key (`playerName|sport|stat|threshold`) so all thresholds survive deduplication. The post-loop monotonicity sweep then re-derives truePct for every threshold from the `pitcherKDistCache` distribution (if available), giving distinct monotonically-decreasing values (e.g. 3+≈99.5%, 4+≈99.0%, 5+=98.1%). Falls back to copy-up sweep if cache is unavailable.

### Explanation Cards (Play Card + Player Card)
Both play cards and player cards show an explanation block (`background:"#0d1117"`, `fontSize:11`, `lineHeight:1.65`).

**Player prop cards** (MLB/NBA/NHL player props): two sections:
1. **Narrative prose** — why the play is recommended, key stats with qualitative context. Highlighted numbers use colored `<span>`; descriptive phrases (e.g. "a key starter") use `color:"#484f58"` (dim).
2. **SimScore row** — `SimScore` label + `X/14 Tier` badge + stat checkboxes. All on one flex line (`display:"flex", alignItems:"center", gap:6`). Badge uses `whiteSpace:"nowrap"`. Checkboxes in an inner `display:"inline-flex", gap:4, flexWrap:"wrap"` span so whole items wrap as units.

**Total play cards** (MLB/NBA/NHL game totals): single prose block only — no separate SimScore row. SimScore badge appended inline at the end of the prose with `verticalAlign:"middle"`.

**SimScore checkbox helpers (player prop cards only):**
- MLB: `mk(meets, pts, label)` → `✓/✗ label(pts)` — no spaces around checkmark
- NBA: `mkGate(meets, pts, label)` → `✓/✗ label (pts)` — spaces, `whiteSpace:"nowrap"` per item

**Edge gate color (all sports):**
- `≥ 3%` → `#3fb950` green, ✓, opacity 1
- `0–2.9%` → `#e3b341` yellow, ✗, opacity 0.7
- negative → `#f78166` red, ✗, opacity 0.7

**Player card explanation** uses the same structure. Data sources by sport:
- MLB strikeouts: `h2h` object built from `tonightPlayerMap` (includes `edge`, `kpctMeets`, `kpctPts`, `kbbMeets`, `lkpMeets`, `pitchesPts`, `mlPts`, `parkMeets`)
- MLB hitters: `tonightHitPlay = Object.values(tonightPlayerMap).find(p => p.stat === safeTab)` (includes `hitterBa`, `hitterLineupSpot`, `pitcherWHIP`, `pitcherFIP`, `hitterWhipMeets`, `hitterPlatoonPts`, `hitterParkMeets`, `edge`)
- NBA: `tonightTabPlay` (includes `nbaOpportunity`, `nbaPaceAdj`, `isB2B`, `nbaSimScore`, `posDvpRank`, `posDvpValue`, `softPct`, `seasonPct`, `edge`)

**NBA DVP / softPct color logic** (play card + player card explanation, both locations):
- `rankColor` (opponent's DVP value): hard matchup → red; rank ≤ 10 → green (favorable, earns SimScore pts); rank 11–15 → yellow (soft but marginal); else → green via softPct fallback or gray
- `softPct` display (player's hit rate vs soft defenses): ≥ 70% → green; ≥ 60% → yellow; < 60% → red — tiered, NOT hardcoded green. High `posDvpValue` (e.g. 4.6 assists/game allowed) in green means soft matchup; low `softPct` in yellow/red means player under-performs vs soft teams.

### Color Tiers
```
tierColor(pct): >= 80% → #3fb950 (green), >= 65% → #e3b341 (yellow), else #f78166 (red)
```

### NBA AvgMin Tiers (report column)
- ≥ 30 min → green (4 SimScore pts)
- ≥ 25 min → yellow (2 SimScore pts)
- < 25 min → red (0 pts)

---

## Data Sources & Reliability

| Source | Used for | Reliability |
|---|---|---|
| Kalshi Trade API | Market prices, odds | ✅ Reliable |
| MLB Stats API (`statsapi.mlb.com`) | Schedule, lineups, pitcher stats, season aggregates | ✅ Reliable |
| ESPN APIs (`site.web.api.espn.com`) | Player info, gamelogs (all sports) | ✅ Reliable |
| Baseball Savant | Barrel% CSV | ⚠️ Slow (5s timeout), cached 6h |
| ESPN DVP endpoint | Defense vs Position data | ✅ Reliable |
| ESPN depth chart | NBA position lookup | ✅ Reliable, cached daily |
| ESPN `sports.core.api.espn.com` | NBA team pace (`paceFactor`) | ✅ Reliable, cached 12h |
| stats.nba.com | Pace/usage | ❌ Blocks server-side requests — not used |

---

## Deployment
- Platform: Vercel Edge Functions
- No build step — `index.html` served statically, `api/[...path].js` is the edge function
- Rewrites in `vercel.json`: `/api/:path*` → `/api/[...path]`
- CORS headers set in `vercel.json` (required for OPTIONS preflight through rewrite layer)
- Cron: `/api/keepalive` runs daily at noon UTC
- **Deploy**: `git push origin main` — Vercel auto-deploys on push. No `vercel` CLI installed.

---

## Testing

Unit tests cover simulation math and the player card truePct fix:
```
# Preferred — no Node required, uses macOS built-in JavaScriptCore:
osascript -l JavaScript api/lib/simulate.test.jxa.js

# If Node is installed:
node --test api/lib/simulate.test.js
```
Two test files kept in sync:
- `api/lib/simulate.test.jxa.js` — self-contained, runs via `osascript -l JavaScript` (no Node needed). Primary test runner.
- `api/lib/simulate.test.js` — Node `node:test` version (requires Node).

Both cover: `kDistPct` monotonicity, `simulateKsDist` validity, `buildNbaStatDist`, API monotonicity sweep, `allTonightPlays` player card fix, frontend `_rawTruePctMap` monotonicity enforcement, NBA simScore, and report filter logic.

---

## Common Debugging

### "Why is truePct wrong for 3+/4+ when 5+ looks correct?" (fixed)
Previously, `tonightPlayerMap` was built from `tonightPlays` (filtered: `qualified !== false`). Thresholds like 3+/4+ with no edge bonus (finalSimScore < 11) were `qualified: false` and omitted, so the player card used the raw fallback formula `(seasonPct + softPct) / 2` — breaking monotonicity (e.g. 4+ showed 76.8% while 5+ showed 97.9%).

**Fix**: `tonightPlayerMap` now uses `allTonightPlays` (unfiltered), which includes `qualified: false` entries with their API-computed, monotonicity-enforced simulation truePct.

If truePct still looks wrong: check `?debug=1` and look in `dropped` for the missing threshold — if it's there (not in `plays[]` at all), the fallback still applies. Check `reason`.

### "Why is truePct the same for 4+ and 5+?"
The `pitcherKDistCache` shares one `Int16Array` distribution across all thresholds for a pitcher — querying it at different thresholds guarantees P(K≥4) ≥ P(K≥5) by construction. If values are identical, it likely means the distribution is flat at that range (e.g. a dominant pitcher where nearly all sims exceed both thresholds).

### "Player appears in Kalshi but not in plays or dropped"
Check `preDropped` in `?debug=1` response. Common reasons: `no_soft_data`, `opp_not_soft`, `no_opp`, `insufficient_starts` (MLB strikeouts only).

Also check the date filter: the edge function runs UTC, so after midnight UTC (e.g. 8pm ET = midnight UTC), `gameDate:"2026-04-13"` is filtered if the server sees the next day. The cutoff is `Date.now() - 86400000` (yesterday) to handle this — but if a play was on a date 2+ days ago, it will still be filtered.

### "Market report shows — for Spot/Brrl%"
- Spot: lineup not confirmed yet (pre-game). Projected lineups from last 14 days are used as fallback. The spot map scans ALL games in the window most-recent-first and takes each player's most recent batting position — so if a player DNP'ed yesterday their prior-game spot is preserved. The primary lineup IDs (for K% stat fetching) still come from the single most recent game that has players.
- Brrl%: Baseball Savant fetch timed out or returned empty. Cached in KV for 6h — bust cache with `?bust=1`.
- After a cache bust: if `buildLineupKPct` or `buildPitcherKPct` hits an early-return (no games scheduled or all IDs empty), all destructured fields must be present in the return value — otherwise `lineupSpotByName` and `pitcherAvgPitches` come back `undefined`, causing `—` for every row. The early-return and catch blocks in `api/lib/mlb.js` include the full field set: `lineupSpotByName`, `lineupBatterKPctsOrdered`, etc. for lineup; `pitcherAvgPitches`, `pitcherEra`, `pitcherCSWPct` for pitchers.

### "P/GS all dashes"
Comes from gamelog starts-only (2026 primary) or season aggregate fallback `numberOfPitches / gamesStarted`. If a pitcher has 0 starts recorded yet in either source, will show `—`. Also check that `buildPitcherKPct` didn't hit the early-return path (see above).

### "P/GS shows wrong value for a confirmed starter (non-doubleheader)"
Two bugs can cause this:

**Bug A — stale KV cache with wrong probable:** The `byteam:mlb` KV cache (600s TTL) was built when a different pitcher was listed as the team's probable. The old `_pt()` team key lookup returned that wrong pitcher's avgPitches.

**Bug B — in-progress game poisons the average (UTC vs local date mismatch):** The pitcher has a game today (local date e.g. "2026-04-15") but the server's UTC clock already reads the next day ("2026-04-16"). The `_todayStr` filter (`new Date().toISOString().slice(0,10)`) = "2026-04-16", so "2026-04-15" != "2026-04-16" passes the filter. If the game is in progress at cache-build time (e.g. NP=2 after first pitch), the tiny partial NP poisons the average: `(91+83+92+2)/4 = 67` instead of 88.7.

**Fixes:**
- `mlb.js` `startSplits` filter now requires `(s.stat?.numberOfPitches || 0) >= 30` — catches in-progress games that slip through the date filter due to UTC/local mismatch. A legitimate start always has 30+ pitches.
- `_avgP` IIFE in `[...path].js` (strikeouts block) uses a priority chain:
  1. **Name-based** (`_ps?.avgPitches` from `pitcherStatsByName`) — correct when pitcher is in probables
  2. **ESPN gamelog starts-only** — `IP >= 3` as start proxy; pitcher-specific; ESPN uses column `"P"` (not `"PC"`) for pitches, code tries both labels
  3. **Team key fallback** — last resort; may return wrong pitcher if cache is stale

`_avgP` is hoisted (`let _avgP = null`) at the outer per-market declarations so all 4 output sites use it.

### "Wrong pitcher stats for a team on a doubleheader day"
When a team plays two games (e.g. a makeup game + a regular game), the schedule loop processes both games and `pitcherByTeam["SD"]` ends up pointing to whichever pitcher was processed last — not necessarily tonight's Kalshi pitcher.

**Different-opponent doubleheader** (e.g. SD vs OAK + SD vs SEA): matchup keys `"SD|OAK"` and `"SD|SEA"` are distinct — the `_pt()` helper tries `team|opp` first and gets the right pitcher.

**Same-opponent doubleheader** (e.g. SD vs SEA twice): both games share the same matchup key `"SD|SEA"`. The second game overwrites `pitcherByTeam["SD"]` AND `pitcherByTeam["SD|SEA"]`, and drops the first pitcher's ID from `allIds` entirely — so their stats are never fetched.

Fix (in place): `allScheduledPitcherIds` (a `Set`) collects ALL pitcher IDs encountered in the schedule loop, regardless of overwrite. `allIds` is built from this set so every pitcher's season stats and gamelog are always fetched. `pitcherAvgPitchesById` stores avg pitches per MLB ID (not just per abbr). `cswByMlbId` is declared outside the CSW% try block. `pitcherStatsByName` has a fallback path for IDs in `allScheduledPitcherIds` that have no abbr in `pitcherByTeam` — it computes K%, KBB%, ERA, CSW%, avgPitches, gs26, hasAnchor directly from the raw ID-keyed data.

### "API returning 504 / function stopped after 25s"
The CSW% play-by-play fetch in `buildPitcherKPct` fires one MLB Stats API request per game per pitcher. With 10–15 pitchers × multiple starts, this can exceed the 25s Vercel Edge limit. Mitigations in place: PBP limited to last 5 starts per pitcher; 8s AbortController aborts the whole PBP block and falls back to K% if slow. If 504s recur, check whether the PBP block is the bottleneck or if another fetch is slow.

### Cache busting
- `?bust=1` skips reads for `byteam:mlb` AND `gameTimes:v2:{date}` — forces fresh MLB data + fresh ESPN game times in one shot
- `mlb:barrelPct` is NOT busted — barrel% survives with its own 6h TTL
- If bust fires before lineups/probables are available, `byteam:mlb` is written with 60s TTL so next request retries
- Depth chart: no bust — expires daily

### "NBA report shows — for Pace/AvgMin/Rest on most rows"
Most NBA markets are dropped at `opp_not_soft` before the pre-sim block runs. Those drop records include `isB2B`, `nbaPaceAdj`, and `nbaOpportunity` computed inline from the gamelog at that drop site. `nbaPreSimScore` and `nbaSimScore` are also computed inline at the drop site so the Score column is populated for all NBA rows (not just qualifying plays).

### "NBA USG% is null / showing — in tooltip for all players"
`buildNbaUsageRate` fetches `sports.core.api.espn.com/v2/.../seasons/2026/types/2/athletes/{id}/statistics`. Common failure modes:

- **Wrong endpoint**: the `site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}/statistics` URL returns only season/league metadata — no `statistics` array. Always use `sports.core.api.espn.com`.
- **Wrong path**: ESPN `usageRate` is 0.0 (not populated by ESPN). The fallback uses `avgFGA`/`avgFTA`/`avgTO`/`avgMin` from `d.splits.categories`. If all four fields are 0 (e.g. player not found, wrong ID, 404), `avgFGA > 0` guard fails → no entry added → `null → 2pts` abstain.
- **Wrong ESPN ID**: `playerInfoMap` maps Kalshi player names to ESPN IDs via `warmPlayerInfoCache`. If the ESPN ID is wrong, the core API returns 404. Check `?debug=1` → `plays[].nbaUsage` for the affected player.
- **Season type**: `types/2` = Regular Season. If fetched during Playoffs (type=3) or Play-In (type=5), regular season stats still exist — type 2 is correct year-round for regular season averages.

### "NBA avgMin (nbaOpportunity) is null for all players"
ESPN returns two season types that both contain "regular" in their name: `"2025-26 Play In Regular Season"` (1 game) and `"2025-26 Regular Season"` (80 games). The old `.find("regular")` took the Play-In type first — `_minVals.length = 1 < 3` gate fails → `nbaOpportunity = null`. Fix: `parseEspnGamelog` now prefers season types with "regular" that do NOT contain "play". Gamelog cache key is `gl:v2|nba|player` — if you need to re-bust, bump the version prefix.

### "User picks not persisting / login works but picks disappear"
Most likely cause: **Upstash free tier exhausted** (500k commands/month). Symptoms: login succeeds, picks save without JS errors, but on reload picks are gone. The `makeCache()` Upstash wrapper silently returns null on all operations when Redis returns HTTP 400.

**Diagnosis:** `GET /api/auth/debug-redis?adminKey=sb-admin-2026` — check `match: true/false` and `setRaw` for the Upstash error message.

**Fix:** In Upstash console (`console.upstash.com`), either upgrade the database to Pay-As-You-Go or create a new free database and update `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` in Vercel → Environment Variables → Redeploy.

**Recovery:** Picks are always mirrored to `localStorage` as a backup (even when logged in). On next login after Redis is restored, the frontend detects server has 0 picks and auto-restores from localStorage, then pushes to server. For picks from before the localStorage backup was added (pre-2026-04-16): use `/api/auth/import-kalshi-picks` to recover from Kalshi fill history.

### "Need to recover picks from Kalshi fill history"
`POST /api/auth/import-kalshi-picks` with `{kalshiSession, adminKey, userId}` fetches the last 5 days of YES fills from Kalshi, maps each ticker to playerName/sport/stat/threshold, auto-populates `result: "won"/"lost"` for finalized markets, and merges into the user's server picks without duplicates.

**Getting `kalshiSession`:** Kalshi's public trading API no longer supports email/password login (removed). The web app uses a `session` cookie. In Chrome DevTools on kalshi.com → Application tab → Cookies → `api.elections.kalshi.com` → copy the `session` cookie value. Pass as `kalshiSession`.

**Note:** Kalshi's `session` cookie only authenticates against the web app's backend, not directly against `api.elections.kalshi.com/trade-api/v2/portfolio/fills` — the import endpoint forwards the cookie in the `Cookie:` header, which does work for the fills endpoint when the session is active.

### "Game time shows 1 hour off (e.g. 6:40 PT instead of 5:40 PT)"
`gameTimes:v2:{date}` is populated from ESPN's scoreboard `ev.date` (UTC ISO string). The display uses `timeZone:"America/Los_Angeles"` which is always PDT/PST-aware. If the displayed time is 1 hour late, ESPN returned a UTC timestamp that was computed using PST (UTC-8) instead of PDT (UTC-7) — effectively not applying daylight saving for that game.

**Fix**: `?bust=1` now skips the `gameTimes` cache read and forces a fresh fetch from ESPN. If ESPN has corrected the time in their data, the bust will pick it up. If ESPN consistently returns the wrong time for that game, the offset persists until ESPN fixes their data.

### "MLB game total SimScore badge shows 14/14 despite yellow ERA/RPG stats in explanation"
The explanation card colors (eraColor/rpgColor) use the **tiered** formula — yellow ERA means 2 pts (not max 3), yellow RPG means 1 pt (not max 2). If the badge shows 14/14 but stats are yellow, production is running **old code** where the formula was flat (3 pts for any non-null ERA, 2 pts for any non-null RPG, 2 pts for any non-neutral park including pitcher-friendly).

**Old formula (before `1966416`):**
```javascript
if (homeERA != null) totalSimScore += 3;   // flat — no tier
if (awayERA != null) totalSimScore += 3;
if (homeRPG != null) totalSimScore += 2;
if (awayRPG != null) totalSimScore += 2;
if (Math.abs(parkRF - 1) > 0.01) totalSimScore += 2;  // fires for pitcher-friendly parks too
```
This always gives 14/14 when all four data fields are present and park ≠ neutral (which includes SD, SEA, SF, etc. since their factors are 0.93–0.94, far from 1.0).

**Diagnosis:** `git log --oneline origin/main..HEAD` — if this shows unpushed commits, Vercel is running the old code. **Fix:** `git push origin main`.

### "NHL game total SimScore badge shows 14/14 despite gray GPG stats in explanation"
The explanation card `gpgColor`/`gaaColor` use the **tiered** formula — gray GPG means 1 pt (not max 3), gray GAA means 0 pts (not max 2). If the badge shows 14/14 but GPG stats are uncolored (gray), production is running **old code** where both GPG and GAA used flat scoring (3 pts for any non-null GPG, 2 pts for any non-null GAA regardless of value).

**Old formula (before `d7beade`):**
```javascript
if (homeGPG != null) totalSimScore += 3;   // flat — no tier
if (awayGPG != null) totalSimScore += 3;
if (homeGAA != null) totalSimScore += 2;
if (awayGAA != null) totalSimScore += 2;
```
This always gave 14/14 when all four fields were present (assuming SA ranks known), even for two teams averaging 2.5–2.7 GPG.

**Old color semantics (also pre-`d7beade`):** `gaaColor` had `< 3.0 → green` (inverted — low GAA = good defense was green, wrong direction for an over). `gpgColor` had `>= 3.5 → red` (also inverted). Now both use `>= 3.5 → green, >= 3.0 → yellow, < 3.0 → gray`, matching the market report table.

**Diagnosis:** `git log --oneline origin/main..HEAD` — if this shows unpushed commits, Vercel is running the old code. **Fix:** `git push origin main`.

### "SimScore shows yellow for strikeout players with score 7–9"
The qualifying gate for strikeouts is `finalSimScore >= 11` (Alpha tier). The report SimScore column uses `>= 10` as the yellow threshold, so scores 10 show yellow (near miss) and scores 7–9 show gray.

### "No MLB plays / all edge_too_low or empty response"
**Most likely cause: Kalshi markets haven't opened yet for today's slate.**

Kalshi only publishes MLB player prop markets a few hours before first pitch — they are NOT available overnight. If you check before ~late morning ET, the previous day's markets will be finalized and today's won't be live yet.

**How finalized markets appear in the data:**
- `status: "finalized"`, `yes_ask: None`, `price: 0`
- The `if (price === 0) continue` guard skips them silently
- `/api/tonight?debug=1` returns empty `plays[]`, empty `dropped[]` — not a bug

**How to decode Kalshi event tickers to confirm the date:**
- Format: `KXMLBKS-26APR152140SEASD` = series `KXMLBKS`, date `26APR15` (April 15 2026), game time `2140` ET, SEA @ SD
- If all tickers show yesterday's date → today's markets aren't open yet
- `close_time` ~04:55–05:00 UTC = game ended ~midnight–1am ET the night before

**Stale KV cache pattern:**
- `byteam:mlb` (600s TTL) may be built while yesterday's markets were still live, caching yesterday's pitcher data (e.g. Hancock for SEA when tonight's starter is Castillo)
- After all games end and markets finalize, the cache still holds stale pitcher stats until TTL expires
- Fix: `?bust=1` clears the KV cache; do this after markets open for today's slate

**Diagnosis steps:**
1. Call `/api/kalshi` directly — if it returns 0 markets or all `price=0`, markets aren't open yet
2. Check ticker date segments — `26APR15` = yesterday, `26APR16` = today
3. Check first pitch time — Kalshi typically publishes 2–4 hours before first pitch
4. If markets are open but plays are missing, check `/api/tonight?debug=1` → `preDropped` for `no_opp` / `opp_not_soft`

**MLB team ID reference** (MLB Stats API `teams.*.id` in schedule response):
- 133 = OAK (Athletics), 134 = PIT (Pirates), 135 = SD (Padres), 136 = SEA (Mariners)
- 120 = WSH (Nationals), 147 = NYY (Yankees), 121 = NYM (Mets), 111 = BOS (Red Sox)
- Full map in `MLB_ID_TO_ABBR` constant in `api/lib/mlb.js`

**ESPN as reliable fallback for today's probables:**
When the MLB Stats API has delays returning probables (occasionally), ESPN's scoreboard reliably has them:
`site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=YYYYMMDD`
The `buildPitcherKPct` function currently only uses MLB Stats API — if probables come back empty from there, all pitcher stats will be missing. No ESPN fallback implemented yet.

### "MLB/NHL game totals missing from market report" (fixed 2026-04-17)
Three bugs caused game totals to be invisible in the market report:

**Bug 1 — Edge calculation subtracted spreadAdj (affected all total sports):**
The totals loop used `edge = rawEdge - spreadAdj` instead of `edge = rawEdge`. A total with rawEdge=4% and kalshiSpread=4¢ → spreadAdj=2 → edge=2% → silently filtered. Fix: `edge = rawEdge` (same as player props).

**Bug 2 — Filtered totals not added to `dropped[]` in debug mode:**
When `truePct == null` or `edge < 3`, the total was `continue`-d without being pushed to `dropped[]`. So in debug mode (market report) those markets were completely invisible — not in `plays`, not in `dropped`. Fix: in `isDebug` mode, push to `dropped[]` with reason `"no_simulation_data"` or `"edge_too_low"`.

**Bug 3 — MLB `mlbRPGMap` always empty (ESPN column name mismatch):**
`mlbRPGMap` is built from ESPN's batting byteam API. The code searched for column names `"G"/"GP"` (games) and `"R"` (runs) but ESPN returns `"gamesPlayed"` and `"runs"`. Both `findIndex` calls returned -1, the guard `if (_gIdx !== -1 && _rIdx !== -1)` was always false, so `mlbRPGMap` was never populated. `homeRPG` and `awayRPG` were always null → lambda always null → `truePct == null` for every MLB total. Fix: accept both naming conventions (`"G" || "GP" || "gamesPlayed"` and `"R" || "runs"`).

**Symptoms before fix:** market report showed 0 rows for `mlb|totalRuns` and `nhl|totalGoals`; `nba|totalPoints` might show if rawEdge was large enough to survive the spread deduction.

**Diagnosis:** `GET /api/tonight?debug=1` → count `plays` and `dropped` items where `gameType === "total"` and `sport === "mlb"`. Before fix: 0. After fix: all thresholds appear in `plays` (edge ≥ 3%) or `dropped` (edge_too_low / no_simulation_data). Check `homeRPG`/`awayRPG` fields in dropped items — null means the batting API column names changed again.

### "NBA totals show dashes for awayOff/homeDef/awayDef — truePct null" (fixed 2026-04-17)
Two bugs caused NBA total sim data to be missing for certain teams:

**Bug 1 — Kalshi non-standard team code not in TEAM_NORM:**
Kalshi uses "WPH" for the Phoenix Suns (PHX) in their NBA tickers. `TEAM_NORM.nba` only had `PHO→PHX`; "WPH" fell through unchanged. `nbaOffPPGMap["WPH"]` and `nbaDefRank["WPH"]` returned null → `awayOff`/`awayDef` null → `truePct` null → score 2/14.
Fix: add `WPH: "PHX"` to `TEAM_NORM.nba`.

**Bug 2 — STAT_SOFT rankMap uses raw ESPN short codes:**
ESPN's general NBA byteam endpoint returns "GS" for Golden State (same short codes as the scoring endpoint). `buildTeamRankMap` stores them raw, so `nbaDefRank["GSW"]` didn't exist — `homeDef` was null for all GSW games.
Fix: after building `STAT_SOFT["nba|*"]`, a post-normalization loop adds long-form aliases: for each raw key in `rankMap`, if `TEAM_NORM.nba[raw]` exists and the long key isn't already present, copy the entry under the long key. Same for `softTeams`.

**How to spot:** `homeOff` present but `homeDef` null → Bug 2. `awayOff` null → Bug 1 (new Kalshi short code not in TEAM_NORM). If a new team abbreviation from Kalshi causes nulls, add it to `TEAM_NORM.nba` in `api/[...path].js` ~line 1036.

### "HRR card shows inflated softGames (300+), wrong AB count, wrong label" (fixed 2026-04-17)
Three bugs in the MLB hitter (hits/hrr) explanation cards:

**Bug 1 — H2H date collision inflating softGames and hitterAbVsPitcher:**
`softVals` for H2H path (`_pitcherDates.size > 0`) matched by date only: `gl.events.filter(ev => _pitcherDates.has(ev.date))`. If Walker faced ATL on 2022-07-15, and Olson (then with OAK) also played a game that day, Olson's OAK game was counted as a Walker H2H at-bat. Over a multi-season career gamelog this inflates softGames to 300+ and hitterAbVsPitcher to 1000+.
Fix: add `ev.oppAbbr === tonightOpp` guard to both paths. Also added `season === 2025 || 2026` filter to the `hitterAbVsPitcher` team-level fallback (was previously pulling all-career AB vs the team).

**Bug 2 — Hardcoded "against weak pitching matchups" label for all HRR:**
For strikeouts `softLabel` is the lineup K% bucket (correctly labelled). For hitters, `softLabel` is `"vs Taijuan Walker"` (H2H) or `"vs PHI"` (team fallback), but the play card and player card hardcoded "against weak pitching matchups" instead of using it.
Fix: added `hitterSoftLabel: softLabel` to play output; both card render sites now use `play.hitterSoftLabel ?? "against weak pitching matchups"`.

**Bug 3 — seasonG (game count) used blendGames (2025+2026) while seasonPct showed pct26 (2026-only):**
`seasonG = play.blendGames || play.seasonGames` — for a veteran like Olson this gives 182 (2025+2026 combined) even when `seasonPct` is the 2026-only rate. Label read "89.5% of games this season (182g)" but only ~19 2026 games existed.
Fix: `seasonG = play.pct26 != null ? play.pct26Games : (play.blendGames || play.seasonGames)`. Label changes to "2025-26" when pct26 is null (blended rate).

**Post-fix values for Matt Olson (example):** `softGames: 26` (was 344), `hitterAbVsPitcher: 105` (was 1300), `hitterSoftLabel: "vs Taijuan Walker"`, `seasonG: 19` (was 182).
