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
- `/api/auth/calibration` — outcome calibration stats (GET) — reads all users' finalized picks (result: won/lost), groups by truePct bucket (70–75, 75–80, …, 95+), returns `{totalPicks, finalizedPicks, overall:[{bucket, predicted, actual, n, delta}], byCategory:{sport|stat:{hitRate,n}}}`. Auth: `Authorization: Bearer <jwt>` (any logged-in user) OR `?adminKey=<ADMIN_KEY>` (curl/debug fallback — do not hardcode in frontend)
- `/api/user/picks` — GET/POST user picks (requires `Authorization: Bearer <token>`)
- `/api/team` — team page data (GET `?abbr=LAD&sport=mlb`) → `{teamAbbr, teamName, sport, record, wins, losses, gameLog, seasonStats:{avgTotal,gamesPlayed}, lineup, lineupConfirmed}`; cached `team:v2:{sport}:{abbr}:{today}` at 3600s TTL; `gameLog` entries: `{date, isHome, opp, teamScore, oppScore, total, result:"W"|"L"}`; lineup: NBA three-source fallback chain (see below), MLB two-source fallback chain: (1) MLB Stats API schedule `hydrate=lineups,probables` (PT date `Date.now()-7h`), confirmed lineup + probable SP → `{spot, name, position, playerId, isProbable?}`; (2) MLB Stats API active roster fallback when schedule returns no lineup/probable — non-pitcher position players up to 12, `spot:null`, `lineupConfirmed:false`

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
- `byteam:nhl` — 21600s (6h, NHL team stats: goalsAgainstPerGame + shotsAgainstPerGame). `NHL_ABBR_MAP` in `api/[...path].js` maps NHL Stats API teamIds → abbreviations; **UTA (Utah Mammoth) = teamId 68** (rebranded from Utah Hockey Club for 2025-26; old teamId 53 absent from 2025-26 API). If a new team's GPG/GAA/SA shows as `—`, check their teamId in the API and add it to `NHL_ABBR_MAP`.
- `gameTimes:v2:{date}` — 600s. Stores both `"sport:team:ptDate"` (PT-date-specific) and `"sport:team"` (bare fallback, first seen wins) keys. Built from **both yesterday and today's** ESPN scoreboard (fetched in parallel) so late-night PT games whose UTC date is already tomorrow are captured. Play loop looks up `sport:team:gameDate` first, falls back to bare key.
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
- **Edge gate**: `edge >= 5%` (same as player props); no soft matchup gate for totals
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
- 10000 sims if `simScore ≥ 12`, else 5000
- **SimScore** (max 14, no edge bonus — edge gates separately):
  - CSW%/K% tiered (1/2/3pts): CSW% > 30% = 3pts (green), CSW% > 26% to ≤ 30% = 2pts (yellow), CSW% ≤ 26% = 1pt (red). Falls back to regressed K% only if CSW% is unavailable (null): K% > 27% = 3pts, K% > 24% to ≤ 27% = 2pts, K% ≤ 24% = 1pt. Null CSW% + null K% = 1pt (abstain). Stored as `kpctPts` (1/2/3); `kpctMeets = kpctPts > 0` (boolean, always true now).
  - K-BB% tiered (`kbbPts`): > 18% → 2pts (green), > 12% → 1pt (yellow), ≤ 12% → 0pts (red); null → 1pt (abstain). `kbbMeets = kbbPts > 0` (boolean). Prose color in play card + player card matches: > 18% green, > 12% yellow, ≤ 12% red (`kbbColor`).
  - Lineup oK% tiered (`lkpPts`): > 24% → 3pts (green), > 16% → 2pt (yellow, avg/below-avg lineup), ≤ 16% → 0pts; null → 1pt (abstain). `lkpMeets = lkpPts > 0`. Hand-adjusted vs RHP/LHP.
  - Avg pitches/start tiered (`pitchesPts`): > 85 → 2pts (green), > 75 → 1pt (yellow), ≤ 75 → 0pts; null → 1pt (abstain). (uses 2026 data only if gs26 ≥ 4; else falls back to 2025)
  - **K-trend** (`kTrendPts`): `_recentKPct / _seasonKPct` ratio. ≥ 1.10 (trending up ≥10%) → 2pts; ≥ 0.90 (stable) → 1pt; < 0.90 (trending down) → 0pts; null (no recent data) → 1pt abstain. Replaces `mlPts` in simScore formula. `_recentKPct` from last 5 starts (A1 signal); ratio compares it directly to full-season K%.
  - O/U tier (`totalPts`): ≤ 8.5 → 2pts (low total = pitcher dominant), 8.5–10.5 → 1pt, >10.5 → 0pts; null → 1pt
  - Edge ≥ 3% required (gates play independently, not part of SimScore)
- `parkMeets` (`PARK_KFACTOR[homeTeam] > 1.0`) is still computed and included in debug output but no longer contributes to SimScore — park factor is applied inside `simulateKsDist` and affects truePct directly. `PARK_KFACTOR` values updated from FanGraphs 2024 SO column (multi-year rolling avg).
- `kpctPts`: 1/2/3 — CSW%/K% tier score. 3=green (CSW%>30% or K%>27%), 2=yellow (CSW% 26-30% or K% 24-27%), 1=red (≤26% CSW or ≤24% K, or null). Drives badge color and value in explanation cards. **Hard gate: `kpctPts < 2` drops play as `"low_pitcher_quality"` (qualified:false) before simulation**.
- `mlPts`: 0/1/2 — ML tier score, **display only** (no longer part of simScore). Drives ML column color in market report (≤-121 green, -120 to +120 yellow, >+120 red). Still included in all play output for the report.
- `kTrendPts`: 0/1/2 — K-trend score (replaces `mlPts` in simScore formula). Shown in SimScore tooltip as "K-Trend". 2=trending up, 1=stable/null, 0=trending down.
- `totalPts`: 0/1/2 — O/U tier score. Color in UI: 2=green, 1=yellow, 0=red. Drives O/U column color in market report (≤8.5 green, 8.5–10.5 yellow, >10.5 red). Low total = pitcher dominant = favorable for Ks.
- `pitcherGS26`: 2026 games started per team abbr, exported from `buildPitcherKPct`, used for small-sample guards. Included in `plays[]` output for debugging (alongside `pitcherHasAnchor`).
- **Gates**: (1) simScore ≥ 7 to enter play loop; (2) `kpctPts ≥ 2` hard gate — drops as `"low_pitcher_quality"` (qualified:false) if pitcher CSW%/K% is red tier (≤26% CSW or ≤24% K%); (3) threshold sanity gate — drops as `"threshold_too_high"` (qualified:false) when `threshold > ceil(expectedKs) + 2` (only when lineup confirmed and expectedKs is available); (4) finalSimScore ≥ 12 to qualify as a play (7–11 = qualified:false, shows in report but not plays card); insufficient_starts gate: if `hasAnchor !== true` (no reliable 2025 anchor, or null if not in data) requires `gs26 ≥ 8` (null gs26 treated as 0); if `hasAnchor === true` passes through regardless of gs26 — the 2025 anchor IS the reliability signal. Catches TJ-return / pure-reliever pitchers who have a few 2026 starts but no valid 2025 baseline (e.g. Detmers with 0 2025 GS — needs 8 starts before model trusts). **Important**: insufficient_starts is checked in BOTH the pre-filter loop AND the main play loop (because `?debug=1` bypasses the pre-filter and uses `qualifyingMarkets` directly). Main loop gate at `api/[...path].js` ~line 1713 uses corrected `playerTeam`; in debug mode pushes to `dropped[]` with reason `"insufficient_starts"` so they appear in the report but not in `plays[]`.
- `pitcherHasAnchor`: `true` if gs25 ≥ 5 AND bf25 ≥ 100 (reliable 2025 *starter* anchor). Included in `plays[]` output for debugging. A reliever-turned-starter has bf25 > 0 but gs25 = 0 — reliever K% is not a valid anchor. bf25 ≥ 100 also excludes injury-shortened seasons (e.g. TJ recovery with 5 starts but minimal workload).
- Pitchers fetched via `buildPitcherKPct(mlbSched)` — avg pitches per start from 2026 gamelog (starts-only filtered via `gamesStarted > 0`); falls back to 2025 season aggregate `numberOfPitches / gamesStarted` when no 2026 start data in gamelog
- **K% regression**: `trust = min(1.0, bf26 / 200)` — uses 2026 BF only (NOT combined 2026+2025). Full trust at ~33 starts. Blends 2026 actual K% with 2025 anchor (or league avg 22.2% if no 2025 data). KBB% regressed the same way.
- **A1 — Pitcher recent form**: `_recentKPct` from last 5 starts with ≥3 starts and 30+ BF. Effective K% = `recentKPct × 0.6 + seasonKPct × 0.4` when recent data meets the threshold; else uses season K% only. `pitcherRecentKPct` map exported from `buildPitcherKPct`, keyed by team abbr.
- **A2 — Pitcher rest/fatigue**: After truePct is computed, a fatigue multiplier is applied to the simulated pitcherKPct before re-querying the distribution. Days since last start ≤ 3 → `× 0.96`; days ≤ 3 AND last start pitch count ≥ 95 → `× 0.92` (short rest + heavy workload). `pitcherLastStartDate` and `pitcherLastStartPC` maps exported from `buildPitcherKPct`, keyed by team abbr.
- **E3a — Umpire K% adjustment**: `UMPIRE_KFACTOR` constant in `api/lib/simulate.js` maps ~50 active umpires to normalized K-rate factors (league avg = 1.0; range ≈ 0.89–1.12). Home plate umpire fetched from MLB Stats API via `hydrate=officials` on the schedule request; extracted into `umpireByGame["homeAbbr|awayAbbr"]` in `buildPitcherKPct` (mlb.js). In the play loop, factor is applied to `pitcherKPctOut` before simulation: `_pitcherKPctAdj = min(40, pitcherKPctOut × _umpireKFactor)`. Name lookup is ASCII-normalized to handle diacritics. Unknown umpires default to 1.0. `umpireName` and `umpireKFactor` (when ≠ 1.0) included in play output.
- **E3b — Expected batters faced**: `_expectedBF = clamp(round(_avgP / 3.85), 15, 27)` where `_avgP` is avg pitches/start and 3.85 is the MLB avg pitches/PA. Passed as 5th arg to `simulateKsDist` (which already accepts `totalPA`). Reduces truePct for pitch-limited starters (75pc → ~20 BF vs default 24); slightly increases for workhorses (105+pc → ~27 BF). `expectedBF` included in play output when ≠ 24.

#### MLB Hitters (hits/hrr) Model
- **`hits` True%**: Monte Carlo simulation (`simulateHits`) using batter BA × pitcher BAA (log5), park-adjusted
- **`hrr` True%**: `(primaryPct + softPct) / 2 × parkFactor` (no Monte Carlo)
  - `primaryPct` = player's 2026 HRR 1+ rate (falls back to 2025+2026 blend, then career)
  - `softPct` = HRR 1+ rate vs tonight's pitcher (H2H gamelog dates) or vs tonight's team (2025+2026 fallback)
  - BA is NOT directly in the formula — it's implicit via the player's historical HRR rate
- **SimScore** (max 14, edge gates separately — same pattern as strikeouts):
  - Lineup spot 1–3 → 3pts, spot 4 → 2pts
  - Pitcher WHIP tiered (`hitterWhipPts`): > 1.35 → 3pts (green), > 1.20 → 1pt (yellow), ≤ 1.20 → 0pts (red). Null → 0pts. Prose color binary: > 1.35 green, else red. Description only shown when > 1.35 ("a lot of baserunners"); suppressed for ≤ 1.35 — red color is sufficient signal.
  - B1 platoon tier (`hitterPlatoonPts`): `splitBA / seasonBA ≥ 1.10 → 2pts` (strong platoon advantage), `≥ 0.95 → 1pt` (neutral/slight), `< 0.95 → 0pts` (platoon disadvantage); null → 1pt (abstain). `batterSplitBA` from MLB Stats API `statSplits/sitCodes=vr|vl`, requires 30+ AB; replaces former Pitcher FIP > ERA pts.
  - Park hit factor > 1.02 → 1pt
  - Barrel% tier: ≥14% → 3pts, ≥10% → 2pts, ≥7% → 1pt, <7% → 0pts, null → 1pt (abstain)
  - O/U total tier (high total = more run-scoring): ≥9.5 → 2pts, ≥7.5 → 1pt, <7.5 → 0pts, null → 1pt
  - Max: 3+3+2+1+3+2 = 14
- **B2 — Batter recent form**: `hitterEffectiveBA = 0.6 × recentBA + 0.4 × seasonBA` when ≥20 AB in last 10 2026 games; else uses seasonBA. Fed directly into `simulateHits` as `batterBA`. `batterRecentBA` map built inline from ESPN gamelog in main play loop.
- **Gates**: lineup spot 1–4 required; hitterSimScore ≥ 11 (Alpha tier — same as strikeouts/NBA/NHL); edge ≥ 5% (gate only, not scored)
- Barrel% from Baseball Savant (`buildBarrelPct`) — cached 6h in KV; `hitterBarrelPts` stored in play output
- NBA game totals fetched from ESPN scoreboard (`sportByteam.nbaGameOdds`) — always fresh (not long-term cached)
- **Pitcher data fallback chain**: `hitterPitcherName` and `hitterPitcherEra` resolved from three sources in order: (1) `sportByteam.mlb.probables[tonightOpp]` (ESPN scoreboard — sometimes absent early in the day), (2) `sportByteam.mlb.pitcherInfoByTeam[tonightOpp]` (MLB Stats API — probables announced the day before, very reliable), (3) `pitcherGamelogs[tonightOpp].name` (if gamelog loaded = pitcher known). Pitcher gamelog loading (`pitcherGamelogs`) also merges both ESPN `probables` and MLB API `pitcherInfoByTeam`, so WHIP/FIP/BAA compute correctly even when ESPN hasn't announced probables. `hitterPitcherName` and `hitterPitcherEra` are included in all drop objects (edge_too_low, low_confidence) so the market report shows pitcher info for all HRR rows, not just qualified plays.

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
  - Pace: avg pace >0 vs league avg → 3pts, >-2 → 2pts, else → 1pt (slow game still scores 1 — not a disqualifier) — fetched from ESPN via `buildNbaPaceData()`, cached 12h
  - **C1 — stat-appropriate opportunity signal** (max 4pts, null → 2pts abstain). From `buildNbaUsageRate` (ESPN endpoint, extracts `avgAssists`/`avgRebounds`); 3PM/game from last-10-game gamelog (`3P` column) for threePointers:
    - **points**: USG% ≥28% → 4pts, ≥22% → 2pts, <22% → 0pts. (`USG% = (avgFGA + 0.44×avgFTA + avgTO) / (avgMin × 2.255) × 100` — ESPN `usageRate` is 0.0 so fallback always runs)
    - **threePointers**: 3PM/game (last 10 games) ≥3 → 4pts, ≥2 → 2pts, <2 → 0pts. USG% doesn't capture 3-point volume — a high-usage big man scores 4pts on USG% but may take 0 3s.
    - **assists**: APG ≥7 → 4pts, ≥5 → 2pts, <5 → 0pts. (USG% is inversely correlated with passing role)
    - **rebounds**: RPG ≥9 → 4pts, ≥7 → 2pts, <7 → 0pts. (USG% has no relation to rebounding)
  - Position-adjusted DVP ratio tiers: ratio ≥ 1.05 → 2pts (soft), ratio ≥ 1.02 → 1pt (borderline), else → 0pts. Pre-filter gate also uses ratio ≥ 1.02 (any position) — replaces the prior `softTeams` ratio ≥ 1.05 check. `dvpRatio` field included in all play/drop output.
  - Not B2B → 2pts
  - Game total tier: ≥235 → 3pts, ≥225 → 2pts, ≥215 → 1pt, <215 → 0pts, null → 1pt (abstain)
  - Max: 3+4+2+2+3 = 14
  - Game totals from `sportByteam.nbaGameOdds` (ESPN NBA scoreboard, fetched fresh each request alongside byteam stats)
- nSim scales with pre-edge simScore: ≥8 → 10k, ≥5 → 5k, else 2k
- **Gate**: edge ≥ 5% (gate only, not scored); **nbaSimScore ≥ 11** to qualify as a play (same Alpha tier as MLB strikeouts). No soft-matchup pre-filter — all NBA markets enter the play loop regardless of opponent DVP.
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
- **SimScore** (max 14; edge is gate only, not scored — same pattern as NBA/MLB):
  - Shots against tiered (`nhlSaRank`): SA rank ≤ 10 → 3pts (green), SA above league avg but rank > 10 → 1pt (yellow), SA ≤ league avg → 0pts (red). `nhlSaRank` stored in play output alongside `nhlShotsAdj`.
  - Avg TOI ≥ 18 min (last 10 games) → 4pts; ≥ 15 min → 2pts
  - Opponent GAA rank ≤ 10 → 2pts
  - Not B2B → 2pts
  - Player team GPG tiered (`nhlTeamGPG`): ≥ 3.5 → 3pts (green), ≥ 3.0 → 2pts, ≥ 2.5 → 1pt, < 2.5 → 0pts, null → 1pt (abstain). Stored as `nhlTeamGPG` in play output.
- nSim scales with pre-edge simScore: ≥8 → 10k, ≥5 → 5k, else 2k
- **B2B** detection: same as NBA — checks if last gamelog event was yesterday (UTC)
- TOI from ESPN gamelog `TOI` or `timeOnIce` column; parsed as `MM:SS` or decimal minutes
- Shots against rank from NHL API `shotsAgainstPerGame`, stored in `nhlSaRankMap`, league avg in `nhlLeagueAvgSa`
- **Gate**: edge ≥ 5%; nhlSimScore ≥ 11 (Alpha tier) — no soft team pre-filter (all NHL markets enter play loop)

### NFL
- **Stats**: `passingYards`, `rushingYards`, `receivingYards`, `receptions`, `completions`, `attempts`
- Gate: opp in soft teams; edge ≥ 5%

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
| `buildPitcherKPct(mlbSched)` | Pitcher season stats (K%, KBB%, ERA, P/GS, CSW%, GS26); also exports `pitcherRecentKPct`, `pitcherLastStartDate`, `pitcherLastStartPC` for A1/A2; exports `pitcherInfoByTeam` (`{[abbr]: {name, id}}`) as MLB Stats API fallback when ESPN probables absent |

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
| `buildNbaUsageRate(playerIds)` | Same ESPN endpoint → `{playerId: {usg, avgAst, avgReb, source}}` map; also extracts `avgAssists`/`avgRebounds` for stat-appropriate C1 scoring |
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
- **Polymarket + Kalshi fetched independently**: Both platforms are checked for every game total threshold. Polymarket fetched via `/events?series_id=X&closed=false&limit=50` (MLB=3, NBA=10345, NHL=10346) regardless of whether Kalshi has markets. After `polyPctMap` is built, thresholds present on Poly but absent from Kalshi are injected into `totalMarkets` with `kalshiPct: null, polyOnly: true`. These Poly-only entries enter the full play loop and qualify if `bestEdge >= 5%`. Gate changed from `edge < 5` to `bestEdge < 5` for all total plays — allows plays where Poly is the best venue even if Kalshi edge < 5%. `_displayAO` = `americanOdds ?? poly-derived odds` used for kelly/ev/stake in all play output. Play output includes `polyOnly: true` for Poly-only markets. UI: when `bestVenue === "polymarket"` (or `polyOnly === true`), the market bar shows Polymarket% in teal with odds derived from that price; when Kalshi wins, shows Kalshi% in purple with Kalshi-derived odds. No `[P]` pill — venue info is in the edge badge tooltip only. Tooltip: Poly-only → `"Polymarket: Xc (+Y% edge)"`; Poly-wins-over-Kalshi → `"Kalshi: Xc | Polymarket: Xc\nBest: Polymarket (+Y% edge)"`. Cached in Redis at `poly:totals:{date}` with 300s TTL; busted by `?bust=1`. Market report Kalshi column shows `—` for Poly-only rows. `lowVolume` guard null-safe (`kalshiVolume != null && < 20`).

### preDropped vs dropped
- `preDropped`: filtered before main play loop (no ESPN info yet) — included in `?debug=1` response
- `dropped`: filtered inside play loop — included in `?debug=1` response
- **Game totals** go to `dropped[]` (not `preDropped`) when they fail the edge gate or have no simulation data (`truePct == null`). Reasons: `"edge_too_low"` or `"no_simulation_data"`. The market report combines `plays[]` + `dropped[]` — `preDropped` is NOT shown in the report.
- **`nbaDropped`**: NBA `opp_not_soft` drops always go here (not just in debug mode) and are included in the regular `/api/tonight` response. Each entry has the full player-card fields: `seasonPct`, `seasonGames`, `softPct`, `softGames`, `nbaOpportunity`, `nbaPaceAdj`, `isB2B`, `nbaSimScore`, `nbaGameTotal`, `nbaTotalPts`, `nbaUsage`, `nbaAvgAst`, `nbaAvgReb`, `nba3pMPG`. The frontend uses these to populate `tonightPlayerMap` as a fallback so the player card explanation renders fully even when the matchup didn't qualify.

### qualified:false plays
All player prop sports push dropped plays to `plays[]` with `qualified: false` so the player card explanation renders even when a play fails a gate. The main plays list (`tonightPlays`) filters these out client-side: `.filter(p => p.qualified !== false)`.

The raw (unfiltered) array is stored in `allTonightPlays` and used to build `tonightPlayerMap` in the player card — this ensures all players visible in the market report also have explanation data on their player page.

**Which gates push `qualified: false` to `plays[]`:**
- **MLB strikeouts**: edge gate, threshold_too_high gate, finalSimScore < 12 gate, kpctPts < 2 gate — all thresholds included so the player card shows monotonically decreasing truePct across 3+/4+/5+
- **MLB HRR**: edge gate (`edge < 5` or `kalshiPct < 70`), hitterFinalSimScore < 11 gate — includes all explanation fields (`hitterBa`, `hitterPlatoonPts`, `hitterSplitBA`, `hitterSoftLabel`, `hitterGameTotal`, etc.)
- **NBA**: edge gate, nbaSimScore < 11 gate — includes `nbaGameTotal`, `nbaUsage/Ast/Reb`, `nba3pMPG`, `nbaPaceAdj`, `posDvpRank/Value`, `nbaBlowoutAdj`
- **NHL**: edge gate, nhlSimScore < 11 gate — includes `nhlOpportunity`, `nhlShotsAdj`, `nhlTeamGPG`, `nhlSaRank`

**Pre-gates that do NOT push to `plays[]`** (inside the sport block, before truePct is computed):
- MLB HRR `low_lineup_spot` (spot ≥ 5) — player doesn't merit an explanation card
- MLB HRR `hitterSimScore < 7` — very poor quality, no explanation shown

### bestMap deduplication — which threshold shows in plays card
`bestMap` dedupes to one play per `playerName|sport|stat` for qualified plays. The winner is the play with the **highest edge** (`play.edge > prev.edge`) — best market value. Non-qualifying (`qualified: false`) plays use a threshold-inclusive key and don't compete. After bestMap, non-winning qualified thresholds are re-added as `qualified: false` for the player card.

---

## Frontend Architecture (`index.html`)

### URL Routing
Single-page app uses `history.pushState` + `popstate` for client-side navigation with real URLs:
- `/:ABBR` → team page (e.g. `/LAD`, `/GSW`) — uppercase abbreviation
- `/:ABBR?sport=nhl` → disambiguate multi-sport abbreviations (e.g. `/BOS?sport=nhl` for Bruins vs `/BOS` for Red Sox); `_multiSportAbbrs` Set lists the conflicting ones
- `/:SlugName` → player page (e.g. `/GavinWilliams`) — CamelCase slugification via `slugify(name)` = remove accents + collapse spaces
- `vercel.json` `/:slug` rewrite serves `index.html` for all single-segment paths so deep links work on cold load
- `resolveSlug(slug, sportOverride)` — on mount, reads `window.location.pathname`, checks `TEAM_DB` first, else stores as `pendingSlug` for async ESPN athlete search
- `navigateToTeam(abbr, sport)` — pushState + `loadTeamPage` + scroll to top
- `navigateToPlayer(p, tab)` — pushState with slugified name + `selectPlayer` + scroll
- `goBack()` — pushState("/") + clear player/team state
- Back button in both player card and team page header calls `goBack()`

### Team Page
`TeamPage({ abbr, sport, teamPageData, tonightPlays, allTonightPlays, onBack, navigateToTeam, trackedPlays, trackPlay, untrackPlay })` component:
- **Independent page** — plays/picks grid is gated `!player && !teamPage`, so it hides completely when a team page is active (same behavior as the player card)
- **Same template as player card**: Back button → header (logo + name + stat boxes) → content card (`background:#161b22, border:1px solid #30363d, borderRadius:12, padding:20px 22px`)
- Header: team logo (ESPN CDN), name, sport/record, W/L/Avg stat boxes; game time shown as third line (`"Today · 7:40 PM PT"` or `"Tomorrow · 1:10 PM PT"`). Source: `data.nextGame.gameTime` (from `/api/team` ESPN schedule) preferred over `tonightPlay.gameTime` (from Kalshi plays) — `nextGame` is reliable even when today's Kalshi market is closed (game in progress).
- `nextGame` — first non-completed event from ESPN team schedule where `eventDate >= UTC today`; returned by `/api/team` as `{date, isHome, opp, gameTime}`. The date guard (`evDateStr >= todayUtc`) prevents stale "non-completed" historical events from being captured.
- **Content card** contains (in order): explanation block → `TotalsBarChart` → lineup (when available) → game log
- Tonight's game explanation block (if matching total plays exist in `allTonightPlays`): matchup header (opp logo + `AWY @ HME`) integrated at top, then sport-specific ERA/RPG prose (MLB), PPG/pace prose (NBA), or GPG/GAA prose (NHL). Rendered inside the content card with `background:#0d1117, border:1px solid #21262d` (same style as player card explanation).
- `tonightTotalMap` keyed by threshold: built from `allTonightPlays` filtered to this team/sport; contains all Kalshi-published thresholds (edge ≥ 3%). `tonightPlay` = best (qualified:true, highest edge) entry from the earliest `gameDate` in the set (today before tomorrow when API returns both).
- **No tabs** — all content shown inline: TotalsBarChart, then lineup (if `lineup.length > 0`), then sortable game log (Date, H/A, Opp, Us, Opp, Total, W/L)
- **Lineup** (shown inline above game log when `lineup.length > 0`): NBA → position + player photo + name; MLB → batting order + probable SP, each with 32×32 headshot from `img.mlbstatic.com` (uses MLB Stats API player ID, generic silhouette fallback). NHL lineup not shown (depth chart structure differs).
- **Lineup player links + inline play cards** (commit `3582700`): every lineup row is clickable → `navigateToPlayer`. Player object passed uses play data from `allTonightPlays` when available (`playerId`, `playerTeam`, `opponent`, stat context) so the player card loads fully without an extra ESPN search. If the player has entries in `allTonightPlays` (any stat, any threshold), compact mini play cards render below their row — showing stat+threshold badge, edge badge, true%/Kalshi% bars. Qualified plays sort first, then by threshold ascending. Mini cards have `stopPropagation` so tapping them doesn't trigger player navigation. Players with plays get `fontWeight:600` on their name. `renderLineupRow` is a shared helper used for both NBA and MLB (hitters + SP).
- **NBA lineup source chain**: (1) ESPN depth chart (`/teams/{abbr}/depthchart`) — works during regular season, returns `{}` during playoffs; (2) ESPN scoreboard → game summary boxscore starters (`/summary?event={gameId}`) — actual starters for today's game, `lineupConfirmed:true`; (3) ESPN team roster (`/teams/{abbr}/roster`) — one player per position group up to 8, `lineupConfirmed:false`. ESPN uses non-standard codes in scoreboard/boxscore (NY=NYK, GS=GSW, SA=SAS, NO=NOP) — normalized via `_nbaEspnNorm` map in the team route.
- Opp names in game log are clickable → `navigateToTeam(g.opp, sport)`
- Total cells color-coded green/red vs tonight's threshold

**`TotalsBarChart({ gameLog, sport, tonightTotalMap, tonightPlay, trackedPlays, onTrack, onUntrack })`**:
- `TOTAL_THRESHOLDS` = `{ mlb:[5..11], nba:[200..250], nhl:[3..8] }`
- **2 bars per row** (same as player card): primary bar (model truePct when Kalshi data exists, else hist%) + Kalshi purple bar (when `kalshiPct != null`)
- Row layout: `label(width:40) → flex column of bars` — label has `paddingTop:2`, outer row `alignItems:"flex-start"`, matches player card exactly
- Primary bar row right side (`width:110`): `count/Ng` count label + edge badge (when `hasTonightData`) + pick button (☆/★) — **pick button is next to edge, not next to odds**
- Kalshi bar row right side: `(americanOdds)` label only
- All threshold bars use `tierColor(primaryPct)` — no blue "best threshold" highlight. Tracked plays (☆→★) are the only special-state indicator.
- Pick button (☆/★) shown when `kalshiPct ≥ 70` AND `edge ≥ 3%`; edge colored green ≥3%, yellow 0-2.9%, red negative
- `oddsStr` computed from `tp.americanOdds` (same formula as player card)

**Backend total deduplication (commit aba2183)**:
All threshold plays that pass the edge gate (≥ 3%) are pushed to `plays[]`. Best threshold per game is `qualified: totalSimScore >= 11`; others are `qualified: false`. Mirrors strikeout threshold behavior — `tonightPlays` (filtered) shows only the best, `allTonightPlays` (unfiltered) has all thresholds for the team page bar chart.

**`TEAM_DB`** — 90+ entries `{abbr, sport, name, short}` for MLB/NBA/NHL; first entry per abbr is the default (MLB > NBA > NHL priority); `teamUrl(abbr, sport)` generates `/{abbr}` or `/{abbr}?sport={sport}` only when disambiguation is needed.

**Linked from**:
- `TotalPlayCard`: team logo + abbr spans are `cursor:pointer` → `navigateToTeam`
- Player card: opponent abbreviation → `navigateToTeam`
- Picks row: total picks away/home team spans → `navigateToTeam`
- Search dropdown: team rows above player rows, matched by `name/short/abbr` client-side via `React.useMemo` (no API call)

### State
- `tonightPlays` — qualified plays from `/api/tonight`, filtered `qualified !== false`
- `allTonightPlays` — raw (unfiltered) plays array from `/api/tonight`, includes `qualified: false` entries; used to build `tonightPlayerMap` so all players visible in the market report have explanation data on their player page (MLB/NBA/NHL drops are all included)
- `nbaDropped` — array always present in `/api/tonight` response (now always empty; previously held `opp_not_soft` drops); frontend still checks it as a fallback for `tonightPlayerMap`
- `reportData` — full debug response from `/api/tonight?debug=1`, shown in Market Report overlay
- `player` — currently selected player for detail card
- `teamPage` — currently selected team `{abbr, sport}` for team page
- `teamPageData` — fetched data from `/api/team`
- `pendingSlug` — CamelCase player slug awaiting ESPN athlete search resolution on cold load
- `trackedPlays` — user's saved picks (localStorage or server)

### Market Report
Opened via "report" button. Shows ALL markets (plays + dropped) grouped by sport/stat. Columns vary by sport/stat via `XCOLS` map. Sport tabs: **ALL / MLB / NBA / NHL / CALIBRATION**.
- **`fetchReport` syncs plays card**: After fetching `?debug=1`, `fetchReport` also updates `tonightPlays` and `allTonightPlays` from the fresh response. This keeps the plays card in sync with the report (avoids stale-cache discrepancy where plays card loaded at page open shows different results than the report fetched later).
- **HRR table**: shows threshold=1 rows only (2+/3+/etc. filtered client-side — too noisy)
- **Score > 10 highlight**: For MLB rows (strikeouts + HRR), the player name is white+bold only when `finalSimScore ?? hitterFinalSimScore > 10` (Alpha tier). Rows with score ≤ 10 get a dim gray name even if qualified. Non-MLB tables use the original `m.qualified` logic for name color.
- **Game totals table** (`mlb|totalRuns`, `nba|totalPoints`, `nhl|totalGoals`): section header shows **"[Sport] Totals"** (e.g. "NBA Totals") via `STAT_NAME` entries `totalRuns/totalPoints/totalGoals → "Totals"`. First column labelled "Matchup" (not "Player"), shows `AWY @ HME`. Opp column hidden. Line cell shows `O7.5` format. Score column uses `m.totalSimScore` (qual gate = 11); green ≥ 11, yellow = 7–10, gray < 7. XCOLS: MLB = H RPG / A RPG / H ERA / A ERA; NBA = H PPG / A PPG / H Def / A Def; NHL = H GPG / A GPG / H GAA / A GAA. Color for all PPG columns: higher = better for over (≥ threshold → green, near → yellow). **MLB ERA/RPG column colors**: ERA ≥4.5 → green (bad pitcher = over-favorable), ≥3.5 → yellow, <3.5 → gray; RPG ≥5.0 → green, ≥4.0 → yellow, <4.0 → gray. Dedup key for totals is `homeTeam|awayTeam|threshold` (not `playerName|threshold`).

#### Calibration Tab
Fetches `GET /api/auth/calibration` with `Authorization: Bearer <authToken>` on first click (+ Refresh button to re-fetch). Requires the user to be logged in — sends the stored JWT token, no hardcoded admin key. Shows:
- **Dynamic analysis block**: overall win rate vs avg predicted; per-bucket sentence describing delta magnitude ("large positive edge of +9%", "well-calibrated", etc.) with data quality label ("significant data" N≥20, "moderate" N≥10, "limited" N<10) and implication ("model is conservative / overconfident"); best/worst category line (filtered to N≥5).
- **Overall Calibration table**: Bucket | N | Predicted | Actual | Delta | bar chart. Bar = actual win rate; blue marker = predicted rate. N < 10 shown dim.
- **By Category table**: sport/stat | N | hit rate | bar. Sorted by N descending.
- **MLB Strikeouts Breakdown** (when K picks exist): three sub-tables — by SimScore, by kpctPts (K% tier), by kTrendPts. Use these to tune feature gates/weights.
- Delta color: green ≥+3%, yellow −2 to +2%, red ≤−3%. Delta = actual − predicted (positive = model conservative, negative = model overconfident).

### Toolbar
Right side: **bust** button (calls `?bust=1`, shows "busting…" while loading) + **mock** toggle + My Picks anchor.

**Plays section header**: Shows `Plays — Week of Apr 20` (Monday of current week) when plays exist, or just `Plays` when empty. Previously listed individual non-today dates (`Wed, Apr 22 · Thu, Apr 23`); replaced with week label for cleaner display.

**`MOCK_PLAYS`** — static array in `index.html` used when the mock toggle is on. Each entry must use **ESPN player IDs** (not MLB Stats API IDs) for `playerId` — `navigateToPlay` passes `play.playerId` as `player.id`, which drives both the ESPN headshot URL (`a.espncdn.com/i/headshots/{sport}/players/full/{id}.png`) and the `tonightPlayerMap` lookup (`p.playerId === player.id`). MLB Stats API IDs (6-digit, e.g. 660271 for Shohei) will produce a broken headshot; use the ESPN ID instead (e.g. 39832 for Shohei). `gameDate` fields use the `TODAY` constant (dynamic) — no hardcoded dates needed. HRR entries must use `stat:"hrr"` (not `"hits"`, which is deprecated). All hitter-specific fields (`oppPitcherHand`, `hitterBarrelPts`, `hitterTotalPts`, `hitterGameTotal`, `hitterBa`, `hitterSoftLabel`, `pitcherName`) should be populated so the explanation prose renders fully.

### My Picks Header
Shows: **"My Picks"** label → total count badge → `X active · Y finished` breakdown (active = no result yet, green; finished = won/lost excluding DNP, gray). No "clear settled" button — picks are managed per-row only.

**ⓘ info icon** (next to date, left side): toggles a tooltip showing universal play qualification criteria — three lines only: Implied prob ≥ 70%, Edge ≥ 5%, SimScore ≥ 11/14 (strikeouts 12/14). No sport-specific detail. State: `showPlaysInfo`.

**`DayBar` — P&L bar chart** (below P&L summary, above pick cards): Each bar column renders **two independent bars**: green above the midline (total $ won) and red below (total $ lost). Both bars can appear simultaneously on a mixed day. `maxAbs = max(maxDailyWins, maxDailyLosses)` — shared scale for both directions. Tooltip shows each play's individual P&L plus a net row.

**Group by dropdown**: `chartGroupBy` state on `App` (default `"day"`). Options: Day / Week / Month / Year. Week buckets start on Monday. Labels: day = "Apr 20", week = "Apr 14" (Monday), month = "Apr '26", year = "2026". Dropdown sits flush-right in the P&L stats row with a "Group by" label above it.

**P&L stats row** shows: Record · Net P&L · ROI · Avg odds · Group by dropdown. "Total staked" and "Bankroll now" removed.

**Pick list — two-tier collapsible grouping**: picks are organized week → day. State: `openPickWeeks` (Set of Monday ISO date keys) and `openPickDays` (Set of date keys). Both default to the current week/today open; older groups start collapsed.
- **Week header** (`"Week of Apr 14"`): bold, `#161b22` background, `#30363d` border. Shows total pick count, active count (green), weekly net P&L. Clicking toggles `openPickWeeks`.
- **Day header** (`"Today"` / `"Yesterday"` / `"Apr 19"`): lighter, `#0d1117` background, `#21262d` border, nested inside expanded week. Shows pick count, active count, daily net P&L. Clicking toggles `openPickDays`.
- Week key = Monday of the week (`(d.getDay() + 6) % 7` offset, same as chart week bucketing). Sort order within each day: open picks first, then by `trackedAt` descending.
- Date is removed from the pick card subtitle (shown in the day header instead).

**Pick card layout** (compact, `padding:"7px 10px"`, `borderRadius:8`, `marginBottom:5`):
- **Photo slot** (36×36, left edge, `flexShrink:0`): player props → ESPN headshot circle (`a.espncdn.com/i/headshots/{sport}/players/full/{playerId}.png`), fallback = first initial in gray circle; game totals → two stacked team logos (19×19, away on top / home on bottom) from ESPN CDN.
- **Row 1** (right of photo): player/matchup name + result badge + P&L amount (when settled) + `flex:1` spacer → ↺ undo button (settled only) + ✎ edit button + × remove button. All row 1 buttons use `padding:"2px 6px", fontSize:10/11, borderRadius:5`.
- **Row 2**: subtitle (stat · threshold · odds · truePct · `$[stake input]`) + (active only) ✓/✗/– outcome buttons flush-right. P&L is shown on row 1 only — not repeated on row 2. Outcome buttons use identical style to row 1: `padding:"2px 6px", fontSize:10, borderRadius:5` — en dash (–) used for DNP (narrower than em dash). `stake input width:46px` to avoid truncation of values like `$40.5`.
- **Edit form** (inline, shown when ✎ active): 2×3 grid — Stat + Stake($) / Line + Odds / True Prob% + Date. Stake field uses `onBlur` to commit value via `setPickUnits`.

### Play Cards
Shows `untrackedPlays` (qualified plays not yet tracked). For game totals, once any threshold for a game is tracked (e.g. O5.5), all other thresholds for that same game are also suppressed — `trackedGameKeys` set built from `trackedPlays` with `total|` prefix, keyed `sport|homeTeam|awayTeam|gameDate`. Each card has:
- True% bar (color = tierColor, odds = model-implied from truePct; `truePct >= 100` clamps to -99999 to avoid -Infinity)
- Kalshi% bar (purple, odds = Kalshi americanOdds)
- Explanation card (varies by sport/stat)
- SimScore gate breakdown
- **Stake row** — `tierUnits(americanOdds)`: returns `|americanOdds| / 10` as a dollar stake (e.g. -257 → $25.7). Stored directly on tracked picks as `units` (dollar amount, not bankroll %). P&L uses `p.units` directly as stake. Picks editor shows a `$` input to override the default. Legacy picks stored with old integer unit values (1/3/5) will be treated as dollar amounts.
- **Game time** shown in card subtitle as `"Today · 7:40 PM PT"` or `"Tomorrow · 1:10 PM PT"` using `play.gameTime` (UTC ISO string from `gameTimes` cache). Day label computed from browser local date vs `play.gameDate`.
- **Date grouping**: plays are grouped by `gameDate` with "Today" / "Tomorrow" section headers. When the API returns plays for multiple dates (e.g. UTC has already flipped to tomorrow), today's plays appear first under "Today" and tomorrow's under "Tomorrow".

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
MLB tabs: pitchers see **Strikeouts** only; hitters see **H+R+RBI** only. The standalone "Hits" tab was removed (HRR encompasses hits). `allStatCfgs["baseball/mlb"]` no longer includes `hits`; `hitterTabs = ["hrr"]`. During loading (`mlbIsPitcher === null`), all `allStatCfgs` tabs show — now just HRR + Strikeouts.

Clicking a play opens the player card with:
- Historical rates per threshold
- Kalshi market prices
- truePct from `tonightPlayerMap` (keyed `stat|threshold`) — built from `allTonightPlays` (unfiltered) so `qualified: false` thresholds (e.g. 3+/4+ strikeouts with no edge bonus) use their simulation-based truePct
- Monotonicity enforced client-side: after building `_rawTruePctMap`, walks highest→lowest threshold tracking the running max and raises any value that dips below it. Safety net for any remaining non-monotonicity after backend sweep.
- **Game time** shown as third line under player name/team in header (`"Today · 7:40 PM PT"` or `"Tomorrow · 1:10 PM PT"`). Looks up `gameTime` from `allTonightPlays` filtered to this player, sorted by `gameDate` ascending so today's game is preferred when multiple dates exist. Day label uses browser local date comparison against `gameDate`.
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
2. **SimScore row** — `SimScore` label + `X/14 Tier` badge + stat checkboxes. All on one flex line (`display:"flex", alignItems:"center", gap:6`). Badge uses `whiteSpace:"nowrap"`. Checkboxes in an inner `display:"inline-flex", gap:4, flexWrap:"wrap"` span so whole items wrap as units. **Exception: MLB hitter (HRR) and NHL player cards use inline badge at end of prose (no separate row), matching game total card style.**

**MLB hitter (HRR) explanation prose order** (play card + player card, both locations):
1. Batting spot (e.g. "Shohei, batting #1 — top of the order"). BA tier and BA value removed — not a SimScore component.
2. Pitcher name — WHIP always shown; color binary: `> 1.35 → green` (3pts, + "a lot of baserunners" description), `≤ 1.35 → red` (0pt — no description, color is sufficient). FIP removed from prose — not a SimScore component. FIP column still shown in market report.
3. Season rate + soft rate (vs pitcher H2H or vs team)
4. ERA rank / no-H2H context — **only shown when `softPct === null` (no H2H data)**. When H2H exists, the soft rate already explains the matchup. ERA rank color is `#c9d1d9` (neutral, not bold red) since it's contextual, not a SimScore component.
5. Park factor (when |pf − 1.0| ≥ 0.03)
6. Game total (color: ≥9.5 green, ≥7.5 yellow, <7.5 gray)
7. Barrel rate (color: ≥14% green/"elite hard contact", ≥10% yellow/"strong contact quality", ≥7% gray/"average contact", <7% dim — from `hitterBarrelPct`)
8. Platoon edge/disadvantage: stat highlighted, label dimmed — "Hits `.310` vs RHP — platoon edge." or "Hits `.229` vs LHP — platoon disadvantage (`.281` season).". Split BA in green (edge) or red (disadvantage); season BA in `#c9d1d9` neutral. Silent when 1pt (neutral/abstain).
9. SimScore badge inline

**FIP color rule (market report only):** FIP column in market report still uses absolute tiers — FIP > 4.5 → green (bad pitcher, batter-favorable), FIP > 3.5 → yellow (average), else gray. FIP is NOT shown in the play card or player card explanation prose (removed — not a SimScore component).

**NHL player prop explanation** (play card + player card, both locations): single prose block — SimScore badge inline at end (no separate row, no checkboxes). SimScore tooltip on hover shows component breakdown: `SA ±X: N/3`, `TOI Xm: N/4`, `GAA #X: N/2`, `Rested/B2B: N/2`, `Team GPG X.X: N/3`.

**Total play cards** (MLB/NBA/NHL game totals): single prose block only — no separate SimScore row. SimScore badge appended inline at the end of the prose with `verticalAlign:"middle"`.

**SimScore checkbox helpers (NBA player prop cards only):**
- NBA: `mkGate(meets, pts, label)` → `✓/✗ label (pts)` — spaces, `whiteSpace:"nowrap"` per item

**Edge gate color (all sports):**
- `≥ 3%` → `#3fb950` green, ✓, opacity 1
- `0–2.9%` → `#e3b341` yellow, ✗, opacity 0.7
- negative → `#f78166` red, ✗, opacity 0.7

**Player card explanation** uses the same structure. Data sources by sport:
- MLB strikeouts: `h2h` object built from `tonightPlayerMap` (includes `edge`, `kpctMeets`, `kpctPts`, `kbbMeets`, `lkpMeets`, `pitchesPts`, `mlPts`, `parkMeets`)
- MLB hitters: `tonightHitPlay = Object.values(tonightPlayerMap).find(p => p.stat === safeTab)` (includes `hitterBa`, `hitterLineupSpot`, `pitcherWHIP`, `pitcherFIP`, `hitterWhipMeets`, `hitterPlatoonPts`, `hitterSplitBA`, `hitterParkMeets`, `hitterBarrelPct`, `hitterBarrelPts`, `oppPitcherHand`, `edge`)
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

### Required Environment Variables (Vercel → Settings → Environment Variables)
| Variable | Purpose | How to generate |
|---|---|---|
| `JWT_SECRET` | Signs and verifies auth tokens (HMAC key) | `openssl rand -base64 32` |
| `ADMIN_KEY` | Shared secret for admin endpoints (`?adminKey=`) | `openssl rand -base64 32` |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint | Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis auth token | Upstash console |

**No hardcoded fallbacks** — if `JWT_SECRET` is missing, auth routes return 500. If `ADMIN_KEY` is missing, all admin endpoints return 403 (fail-closed). After adding or rotating either variable, redeploy.

**Critical: all env vars must be wired through `process.env` in the `handler` function** at the bottom of `api/[...path].js`. The Vercel Edge handler builds an explicit `env` object and passes it to `worker_default.fetch` — env vars set in Vercel are NOT automatically available on `env`. If you add a new env var, add it here too:
```js
const env = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_KEY: process.env.ADMIN_KEY,
};
```
Symptom of a missing wire-up: `env?.VAR` is `undefined` inside the handler even though the Vercel dashboard shows the var is set. For JWT_SECRET specifically: `TextEncoder.encode(undefined)` = 0 bytes → `"Imported HMAC key length (0)"` 500 error on login.

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

### "Player card explanation is blank / missing prose (stats present in market report)"
A player visible in the market report has their play in `dropped[]` (debug-only), which means `tonightPlayerMap` has no entry for them → `tonightHitPlay` / `tonightTabPlay` is null → explanation renders blank.

**When this can still happen**: only for the MLB HRR pre-gates (`low_lineup_spot` spot ≥ 5, or `hitterSimScore < 7`). All other gates (edge, simScore < 11) now push to `plays[]` with `qualified: false`.

**Diagnosis**: check `?debug=1` → `dropped[]` for the player. If `reason` is `"low_lineup_spot"` or `"low_confidence"` with `hitterSimScore < 7`, they hit a pre-gate before truePct was computed — no explanation data exists. Any other reason means a gap in the qualified:false push logic.

### "Why is truePct wrong for 3+/4+ when 5+ looks correct?" (fixed)
Previously, `tonightPlayerMap` was built from `tonightPlays` (filtered: `qualified !== false`). Thresholds like 3+/4+ with no edge bonus (finalSimScore < 11) were `qualified: false` and omitted, so the player card used the raw fallback formula `(seasonPct + softPct) / 2` — breaking monotonicity (e.g. 4+ showed 76.8% while 5+ showed 97.9%).

**Fix**: `tonightPlayerMap` now uses `allTonightPlays` (unfiltered), which includes `qualified: false` entries with their API-computed, monotonicity-enforced simulation truePct.

If truePct still looks wrong: check `?debug=1` and look in `dropped` for the missing threshold — if it's there (not in `plays[]` at all), the fallback still applies. Check `reason`. New gate reasons: `"low_pitcher_quality"` (kpctPts < 2), `"threshold_too_high"` (threshold > ceil(expectedKs) + 2).

### "Why is truePct the same for 4+ and 5+?"
The `pitcherKDistCache` shares one `Int16Array` distribution across all thresholds for a pitcher — querying it at different thresholds guarantees P(K≥4) ≥ P(K≥5) by construction. If values are identical, it likely means the distribution is flat at that range (e.g. a dominant pitcher where nearly all sims exceed both thresholds).

### "Player appears in Kalshi but not in plays or dropped"
Check `preDropped` in `?debug=1` response. Common reasons: `no_opp`, `insufficient_starts` (MLB strikeouts only). NBA no longer has an `opp_not_soft` pre-filter — all NBA markets enter the play loop.

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
The CSW% play-by-play fetch in `buildPitcherKPct` fires one MLB Stats API request per game per pitcher. With 10–15 pitchers × multiple starts, this can exceed the 25s Vercel Edge limit. Mitigations in place: PBP limited to last 5 starts per pitcher; **5s** AbortController aborts the whole PBP block and falls back to K% if slow (reduced from 8s in commit `c5d5b14`).

Secondary cache fetches (DVP, NBA depth chart, barrel%, NBA pace) are now fired in two parallel `Promise.all` rounds instead of four sequential awaits — saves up to ~10s on cold cache (commit `c5d5b14`). On a full Sunday slate (15 games) the function now returns in ~14s.

If 504s recur: check whether PBP block is the bottleneck (add `console.time` around it in a debug branch) or if BettingPros DVP fetch is slow (it's the most expensive cold fallback at ~5-10s).

### Cache busting
- `?bust=1` skips reads for `byteam:mlb`, `byteam:nhl`, `gameTimes:v2:{date}`, AND `nba:pace:2526` — forces fresh MLB + NHL data, ESPN game times, and NBA pace in one shot
- `mlb:barrelPct` is NOT busted — barrel% survives with its own 6h TTL
- If bust fires before lineups/probables are available, `byteam:mlb` is written with 60s TTL so next request retries
- Depth chart: no bust — expires daily

### "NBA report shows — for Pace/AvgMin/Rest on most rows"
All NBA markets now go through the full simulation loop (no opp_not_soft pre-filter). Every market computes pace, C1, DVP, B2B, and game total in the main block. If most rows show `—`, the ESPN gamelog or pace data fetch likely failed for that player — check `_debug` field in dropped entries.

### "NBA 3P SimScore C1 shows — or seems wrong"
For `threePointers`, C1 is scored on **3PM/game** from the last 10 gamelog games (`3P` column), not USG%. Check `?debug=1` → `plays[].nba3pMPG` for the raw value. If null, the gamelog has fewer than 3 valid game values — falls back to 2pt abstain. The SimScore tooltip in both play card and player card shows `3PM/g: X.X → Y/4`.

USG% is still used for `points` only. Do not confuse `nbaUsage` (points C1) with `nba3pMPG` (threePointers C1).

### "NBA USG% is null / showing — in tooltip for all players"
`buildNbaUsageRate` fetches `sports.core.api.espn.com/v2/.../seasons/2026/types/2/athletes/{id}/statistics`. Common failure modes:

- **Wrong endpoint**: the `site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}/statistics` URL returns only season/league metadata — no `statistics` array. Always use `sports.core.api.espn.com`.
- **Wrong path**: ESPN `usageRate` is 0.0 (not populated by ESPN). The fallback uses `avgFGA`/`avgFTA`/`avgTO`/`avgMin` from `d.splits.categories`. If all four fields are 0 (e.g. player not found, wrong ID, 404), `avgFGA > 0` guard fails → no entry added → `null → 2pts` abstain.
- **Wrong ESPN ID**: `playerInfoMap` maps Kalshi player names to ESPN IDs via `warmPlayerInfoCache`. If the ESPN ID is wrong, the core API returns 404. Check `?debug=1` → `plays[].nbaUsage` for the affected player — note this is only relevant for `points` plays; assists use `nbaAvgAst`, rebounds use `nbaAvgReb`, 3-pointers use `nba3pMPG`.
- **Season type**: `types/2` = Regular Season. If fetched during Playoffs (type=3) or Play-In (type=5), regular season stats still exist — type 2 is correct year-round for regular season averages.

### "NBA pace shows — for New Orleans (NOP) players"
`buildNbaPaceData` stores pace under ESPN's team abbreviation. ESPN returns "NO" for New Orleans, but `playerTeam` is normalized to "NOP" via `TEAM_NORM`. Fix already in place: `buildNbaPaceData` adds long-form aliases (`NO→NOP`, `GS→GSW`, etc.) after building `teamPace`. If pace is null for another team, check `TEAM_NORM` in `api/[...path].js` — the ESPN short code may need a new alias in `buildNbaPaceData`'s `_shortToLong` map.

### "NBA avgMin (nbaOpportunity) is null for all players"
ESPN returns two season types that both contain "regular" in their name: `"2025-26 Play In Regular Season"` (1 game) and `"2025-26 Regular Season"` (80 games). The old `.find("regular")` took the Play-In type first — `_minVals.length = 1 < 3` gate fails → `nbaOpportunity = null`. Fix: `parseEspnGamelog` now prefers season types with "regular" that do NOT contain "play". Gamelog cache key is `gl:v2|nba|player` — if you need to re-bust, bump the version prefix.

### "NBA player markets missing during playoffs" (resolved — DVP gate removed)

The opp_not_soft pre-filter was removed (commit 1a3357e). All NBA markets now enter the play loop unconditionally. If NBA plays are missing, check `preDropped` for `no_opp` (team extraction failed) or inspect `dropped` for `edge_too_low` / `simScore_too_low`. DVP ratio still affects SimScore (0/1/2 pts) but is no longer a gate.

### "Kalshi market visible on app but missing from our pipeline"

**Root cause**: A market can be visible on the Kalshi web app (showing odds like -382) but have `yes_ask_dollars = 0` or null in the trading API — it's in a pre-market or preview state. The pipeline skips `price = 0` markets with `if (pct <= 0) continue`. This is correct behavior — the market isn't yet open for trading.

**How to confirm**: If a player has only one stat/threshold showing in `preDropped` (e.g. Jokic threePointers only, no assists), the missing stat's market is not yet in the Kalshi trading API. Once Kalshi opens the market for trading (assigns an ask price), it will appear in the pipeline on the next request — no cache bust needed (Kalshi data is always fetched fresh).

**What happens when it goes live** (Jokic assists vs MIN example):
1. Pre-filter: MIN is in `C.softTeams.assists` → passes ✓
2. Main loop: DVP rank ≤ 10 → 2pts SimScore; C1 (APG ≥ 7) → 4pts; pace, B2B, game total → additional pts
3. truePct computed via Monte Carlo simulation
4. If edge ≥ 5% AND simScore ≥ 11 → qualifies as a play

### "User picks not persisting / login works but picks disappear"
Most likely cause: **Upstash free tier exhausted** (500k commands/month). Symptoms: login succeeds, picks save without JS errors, but on reload picks are gone. The `makeCache()` Upstash wrapper silently returns null on all operations when Redis returns HTTP 400.

**Diagnosis:** `GET /api/auth/debug-redis?adminKey=<ADMIN_KEY>` — check `match: true/false` and `setRaw` for the Upstash error message.

**Fix:** In Upstash console (`console.upstash.com`), either upgrade the database to Pay-As-You-Go or create a new free database and update `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` in Vercel → Environment Variables → Redeploy.

**Recovery:** Picks are always mirrored to `localStorage` as a backup (even when logged in). On next login after Redis is restored, the frontend detects server has 0 picks and auto-restores from localStorage, then pushes to server. For picks from before the localStorage backup was added (pre-2026-04-16): use `/api/auth/import-kalshi-picks` to recover from Kalshi fill history.

### "Calibration tab throws TypeError: Cannot read properties of undefined (reading 'filter')"
**Root cause**: Two separate issues that compound:

1. **API returns `{error:"Forbidden"}` instead of calibration data** — the frontend `fetchCalib()` had `adminKey=sb-admin-2026` hardcoded; if the Vercel `ADMIN_KEY` env var is different, the API returns a 403. `calibData` becomes `{error:"Forbidden"}` which passes the `calibData && !calibLoading` guard, so the IIFE fires and destructures `overall = undefined` → `.filter()` crash.

2. **Missing `!calibData.error` guard** — the IIFE condition was `calibData && !calibLoading` without excluding error responses. Fix: added `&& !calibData.error` so the IIFE only runs when the response has the expected shape.

**Auth fix**: calibration endpoint now accepts `Authorization: Bearer <jwt>` (any logged-in user). Frontend sends the stored auth token — no hardcoded key needed. `?adminKey=<ADMIN_KEY>` still works as a curl/debug fallback. **Never hardcode the admin key in the frontend.**

### "Need to recover picks from Kalshi fill history"
`POST /api/auth/import-kalshi-picks` with `{kalshiSession, adminKey, userId}` fetches the last 5 days of YES fills from Kalshi, maps each ticker to playerName/sport/stat/threshold, auto-populates `result: "won"/"lost"` for finalized markets, and merges into the user's server picks without duplicates.

**Getting `kalshiSession`:** Kalshi's public trading API no longer supports email/password login (removed). The web app uses a `session` cookie. In Chrome DevTools on kalshi.com → Application tab → Cookies → `api.elections.kalshi.com` → copy the `session` cookie value. Pass as `kalshiSession`.

**Note:** Kalshi's `session` cookie only authenticates against the web app's backend, not directly against `api.elections.kalshi.com/trade-api/v2/portfolio/fills` — the import endpoint forwards the cookie in the `Cookie:` header, which does work for the fills endpoint when the session is active.

### "Game time shows 1 hour off (e.g. 6:40 PT instead of 5:40 PT)"
`gameTimes:v2:{date}` is populated from ESPN's scoreboard `ev.date` (UTC ISO string). The display uses `timeZone:"America/Los_Angeles"` which is always PDT/PST-aware. If the displayed time is 1 hour late, ESPN returned a UTC timestamp that was computed using PST (UTC-8) instead of PDT (UTC-7) — effectively not applying daylight saving for that game.

**Fix**: `?bust=1` now skips the `gameTimes` cache read and forces a fresh fetch from ESPN. If ESPN has corrected the time in their data, the bust will pick it up. If ESPN consistently returns the wrong time for that game, the offset persists until ESPN fixes their data.

### "Play card or player card shows 'Tomorrow' for a game that's today"
**Root cause**: `gameTimes["mlb:TOR"]` was keyed only by team, not by PT date. When the backend fetched only UTC-today's ESPN scoreboard, a game at 5:10 PM PT on Apr 18 returned as `2026-04-19T00:10Z` (UTC Apr 19). The bare key was set from that Apr 19 entry → `gameTime` pointed to tomorrow.

**Fix (in place)**:
1. Backend now fetches **both yesterday and today** ESPN scoreboards in parallel per sport (`Promise.all([yesterday, today])`), merging events from both.
2. `gameTimes` now stores entries keyed by **PT date** (`"sport:team:ptDate"`) alongside the bare fallback. A game at 2026-04-18 PT is stored under `"mlb:TOR:2026-04-18"` even if its UTC time is Apr 19.
3. Play loop lookup: `gameTimes["sport:team:gameDate"]` first (PT-date-specific), falls back to bare `"sport:team"`.
4. Day label in play card and player card uses `play.gameDate` directly for the Today/Tomorrow comparison — not re-derived from `gameTime` — so even if `gameTime` is UTC-tomorrow, the label still says "Today" when Kalshi's `gameDate` is today.

**Team page game time**: uses `data.nextGame.gameTime` (from `/api/team`) as the primary source, independent of Kalshi market state. Reliable even when today's market is closed (game in progress or finalized). Falls back to `tonightPlay.gameTime` if `nextGame` is null.

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

### "SimScore shows yellow for strikeout players with score 9–11"
The qualifying gate for strikeouts is `finalSimScore >= 12` (Alpha tier). The report SimScore column uses `>= 9` as the yellow threshold, so scores 9–11 show yellow (near miss) and scores < 9 show gray.

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
Applied in the top explanation block (line ~2930) AND the no-H2H branch (line ~3074) — both are render sites for this count. The no-H2H branch was missed in the original fix (commit f782fcf).

**Post-fix values for Matt Olson (example):** `softGames: 26` (was 344), `hitterAbVsPitcher: 105` (was 1300), `hitterSoftLabel: "vs Taijuan Walker"`, `seasonG: 19` (was 182).

**Diagnosis tip — fix appears deployed but screenshot still shows old values:**
If the API returns correct data (e.g. `pct26Games: 18`) and the source code at the render site is correct, but the UI still shows the old behavior (e.g. "126 games this season"), the browser is running a cached `index.html`. The old code for this bug had `games this season` hardcoded; the new code conditionally shows `"this season"` vs `"in 2025-26"` — making it easy to distinguish. Fix: **Cmd+Shift+R** (hard refresh) to bypass browser cache.

**MLB hitter play card — one explanation box (commit ae29862):**
Previously MLB hitters (hits/hrr) rendered two separate gray boxes: (1) player/pitcher stats + season rate, (2) opponent ERA rank + no-H2H. The second box was redundant — it repeated the season rate in the no-H2H path. Fix: ERA rank sentence and no-H2H line merged into the first box (after the season/soft rate line). Second box condition now excludes `play.sport !== "mlb"` so it only fires for NFL. Single box flow: lineup → pitcher WHIP/FIP → season rate [+ soft pct if H2H] → ERA rank + no-H2H → park factor → game total → SimScore.

### "/api/team returns 0 scores and 0-0 record"
Two ESPN response shape mismatches discovered after initial deployment (fixed in commit `eff1a4f`):

**Bug 1 — Score is an object, not a number:**
`comp.competitors[n].score` returns `{value: 8.0, displayValue: "8"}` — not a raw number. `parseFloat({...})` = `NaN → 0`.
Fix: `parseFloat(comp.score?.value ?? comp.score?.displayValue ?? comp.score) || 0`.

**Bug 2 — Record field is `recordSummary`, not `record.items[0].summary`:**
The ESPN team schedule response uses `sched.team.recordSummary` (e.g. `"15-4"`). The `record` key is null.
Fix: `sched.team?.recordSummary || sched.team?.record?.items?.[0]?.summary`.

**Expected empty lineup states (not bugs):**
- MLB: if schedule returns no lineup AND roster fetch also fails → `lineup = []` → lineup section hidden (rare)
- NBA: depth chart empty during playoffs → falls through to boxscore starters (game day) or roster fallback (no game today); lineup section only hidden if all three sources return nothing
Both are handled gracefully by the `lineup.length > 0` guard on the inline lineup section.

### "Polymarket polyPct showing null for all total plays"

**Root cause: wrong Polymarket API endpoint.**
The flat `gamma-api.polymarket.com/markets?closed=false&limit=200` endpoint returns general prediction markets (GTA VI release dates, celebrity gossip) — it ignores all filtering parameters (`tag_slug`, `tag_id`, `q=`, `search=`). Game total markets are NOT accessible via this endpoint.

**Correct endpoint: `/events?series_id=X`**
Game totals are organized into sport-specific series. Fetch events, then parse the nested `markets[]` array on each event:
- MLB series_id = 3
- NBA series_id = 10345
- NHL series_id = 10346

```
GET gamma-api.polymarket.com/events?closed=false&series_id=3&limit=50
```
Response: array of event objects with `title` ("Tampa Bay Rays vs. Colorado Rockies") and `markets[]` (each market has `question`, `outcomes`, `outcomePrices`). O/U markets identified by `question.includes("O/U")`. Skip half-game markets (`"1H"` or `"2H"` in question).

**Team name format differences by sport:**
- MLB: full nickname only, no city — `"Rays"`, `"Rockies"`, `"Blue Jays"` (NOT "Tampa Bay Rays")
- NBA: short nickname — `"Warriors"`, `"Suns"`, `"Trail Blazers"`
- NHL: short nickname — `"Flyers"`, `"Golden Knights"`, `"Blue Jackets"`
Event title format: `"[Away Team] vs. [Home Team]"` — away team is first. Title split uses `/ vs\.? /` regex to handle both `"vs."` and `"vs"` separators. Outcome regex uses `/^over\b/i` to match both bare `"Over"` and `"Over 7.5"` labels.

**Threshold alignment:**
Polymarket lists `"O/U 8.5"` → Kalshi threshold = `Math.round(8.5 + 0.5) = 9` (YES if total ≥ 9).

**Why matches are rare:**
Kalshi qualifies markets at 70–97% probability — for MLB this means low thresholds (O3.5, O4.5, O5.5) where the probability of reaching them is high. Polymarket carries the game's main O/U line (typically 7.5–8.5 for MLB) and some alt lines. A Polymarket match only occurs when Kalshi's qualifying threshold aligns with a line Polymarket has listed. High-scoring venues (Coors Field COL, Globe Life TEX) produce matches more often. Example: LAD @ COL O8.5 — Kalshi 73% (this threshold passes the 70-97% gate), Polymarket 60% → `bestVenue=polymarket`, `bestEdge=+13%`.

**Stale cache pattern after a broken deploy:**
If the first deploy has a bug that produces `polyPctMap = {}` (empty), that empty object gets cached in Redis at `poly:totals:{date}` with 300s TTL. A subsequent correct deploy will still serve the empty cache until it expires. Fix: `?bust=1` skips the `poly:totals:{date}` cache read. Always test the Polymarket block with `?bust=1` after a deploy that changes the Polymarket fetch logic.

**"Poly shows — for all rows in market report" (fixed 84a80e4):**
`polyPctMap` lookup was after the edge gate — `dropped` plays (edge_too_low / no_simulation_data) never got `polyPct`. Fix: lookup moved before edge check so all total rows in the report carry `polyPct`/`polyVol`/`bestVenue`/`bestEdge`.

**Diagnosis steps:**
1. `GET /api/tonight?debug=1&bust=1` — check `plays[].polyPct` and `dropped[].polyPct` on total rows
2. If `polyPct` is null for all total plays: check that today's sport (MLB/NBA/NHL) has a corresponding series in `POLY_SERIES` and that `totalMarkets.length > 0` (Kalshi must have published totals first)
3. If `polyPct` is null for one team: the team name in Polymarket's event title doesn't match any key in `POLY_NAME_TO_ABBR[sport]`. Add the missing nickname.
4. If `polyPct` exists but `bestEdge` seems wrong: check threshold alignment — Polymarket "O/U 7.5" maps to Kalshi threshold 8 (not 7). Log `_ouLine` and `_thresh` from the fetch block.
5. Finalized Polymarket markets are filtered by `overPrice < 0.02 || overPrice > 0.98` — if a market just settled, this guard drops it.

**Poly derived prices for MLB/NBA/NHL (commit 84fe9a7):**
Polymarket only carries consensus O/U lines (MLB: 7.5–8.5; NBA: 216–232; NHL: 4.5–7.5) — all near 50/50. Kalshi qualifies at lower alt-lines. To show a meaningful comparison, the pipeline derives Poly's implied probability at any threshold using the consensus price as an anchor:
- **MLB/NHL**: Fit Poisson λ from `P(X ≥ anchor_threshold) = poly_pct`, then compute `P(X ≥ threshold)`. The Polymarket app shows identical Poisson-derived prices via its slider UI.
- **NBA**: Fit Normal μ from the same anchor using fixed σ = √2 × 11 ≈ 15.6 (from simulation per-team std).
Derived prices stored in `polyDerivedMap` (separate from `polyPctMap`). Key: `sport|t1|t2|threshold`. Shown as `~X%` (italic) in market report Poly column. **NOT used for `bestEdge`/`bestVenue`/edge gate** — only real Poly prices affect play qualification. Poly-only injection also skips derived entries. `polyDerived: true` flag included in all play/dropped output.

**Bug: Poisson binary search condition was inverted (fixed 84fe9a7):** `if (1 - cdf < p) hi = mid` converged to λ=60 (max), giving ~100% probabilities skipped by `v > 99` guard. Fixed to `if (1 - cdf > p) hi = mid`.

**"NHL polyPct seems too low compared to Kalshi (e.g., 60% vs 96%)" — stale 5-min cache:**
The `poly:totals:{date}` cache (300s TTL) can be populated with pre-game Polymarket prices. As a game progresses, Kalshi updates every request and moves to 96%+ on a high-probability outcome; Poly stays at the cached pre-game value (~60%) for up to 5 minutes. Fix: `?bust=1` skips the poly cache and fetches current prices. Regular season live NHL Poly prices for O4.5 typically range 74–86%. **During NHL playoffs, Poly prices for O4.5 are structurally lower (~52–56%)** — tighter defense and lower expected scoring make this reasonable, but our model uses regular season GPG/GAA data and scores ~85% truePct, creating apparent 25–30% edges. These edges may not be real if the model overstates playoff scoring. The Kalshi–Poly gap on NHL O4.5 reflects Kalshi being overpriced during both regular season and playoffs.

**"Many NHL plays qualifying via Poly edge in playoffs" (post-6ef98f7 behavior):**
Since the gate changed from `edge < 5` to `bestEdge < 5`, plays where Kalshi edge is negative but Poly edge is ≥5% now qualify. During playoffs (~April–June) expect 15–20 NHL plays per day where `rawEdge < 0` (Kalshi overpriced) but `bestEdge >= 5` (Poly underpriced vs model). To check: `?debug=1` → count `plays` where `sport=nhl && rawEdge < 0`. If this looks excessive, consider a secondary guard like requiring `rawEdge > -15` for Poly-best plays, or recalibrating NHL truePct for playoff scoring pace.

**"Polymarket app shows O5.5/O6.5 slider prices for MLB — are these real markets?":**
The Polymarket app shows a slider with prices at multiple thresholds (e.g., O5.5 at -355 ≈ 78% for HOU@CLE). These are NOT separate tradeable markets — they are Poisson-derived prices computed by the app from the single real O/U 8.5 market. The `/events?series_id=3` API only exposes the consensus market. Our `polyDerivedMap` computes the same Poisson-derived prices server-side and shows them as `~X%` in the report. Derived prices are NOT used for edge gates or bestVenue routing.

**NHL Polymarket market format (confirmed live 2026-04-20):**
- Series_id=10346 returns NHL game events, e.g. "Ducks vs. Oilers" with 4 O/U lines: 4.5, 5.5, 6.5, 7.5
- Market question format: `"Ducks vs. Oilers: O/U 4.5"` (includes team names — handled by `/O\/U\s+([\d.]+)/` regex)
- Outcomes: `["Over", "Under"]` — `_oIdx` detection by `/^over\b/i` works correctly
- Player prop markets in the same NBA series (e.g. "Scottie Barnes: Points O/U 4.5") have `["Yes","No"]` outcomes — `_oIdx = -1` → skipped correctly

### "Platoon disadvantage not showing in prose even when tooltip shows Platoon: 0/2" (fixed 779c354)
**Root cause**: `oppPitcherHand` was never added to the final play object in the `plays[]` push (only to `_hlCommon` which is spread into `dropped[]` entries). In the frontend, the prose condition `platoonPts === 0 && pitcherHand` always failed because `play.oppPitcherHand` was `undefined` → `pitcherHand = null` (falsy).

`hitterPlatoonPts === 0` requires `_oppPitcherHand !== null` to be computed (else stays at 1 abstain), so the tooltip could show `0/2` while `oppPitcherHand` was absent from the play object — the two fields came from different code paths.

**Fix**: promoted `_oppPitcherHand` to `hitterOppPitcherHand` at outer scope (alongside `hitterPlatoonPts` declaration), assigned after the const inside the MLB hitter block, and added `oppPitcherHand: hitterOppPitcherHand` to the plays push (~line 3018).

### "WHIP shows yellow in prose but tooltip shows 0/3" (fixed 779c354)
**Root cause**: `whipColor` used a 3-tier scale (>1.35 green, >1.20 yellow, ≤1.20 red) but the SimScore formula is binary — only >1.35 earns 3pts, everything else earns 0pts. A WHIP of 1.32 rendered yellow, implying 2nd-tier points, while the SimScore tooltip correctly showed 0/3.

**Fix**: changed middle tier from `#e3b341` (yellow) to `#c9d1d9` (neutral). Yellow is now reserved exclusively for tiers that actually earn SimScore points. The descriptive text ("some traffic on base") still provides informational context in gray.

**Further fix**: `whipColor` is now binary — `> 1.35 → green` (earns 3pts), `≤ 1.35 → red` (earns 0pts). WHIP always shows in prose; red signals it's a non-contributing factor. Users see color as a quick signal rather than having to check the tooltip.

### "ERA rank sentence dominates HRR card even when H2H data exists"
**Root cause**: The `oppRank` sentence ("LAA ranks 5th-worst in ERA allowed") fired whenever `play.oppRank` was present, regardless of whether H2H soft rate was already available. This was visually misleading — ERA is NOT a SimScore component, but got a prominent bold sentence while WHIP (an actual SimScore component) was suppressed to a sub-clause.

**Fix**: ERA rank sentence now only renders when `play.softPct === null` (no H2H data). When H2H data exists, the soft rate sentence already explains the matchup — the ERA rank sentence is redundant and confusing. The rank color was also changed from `#f78166` (red) to `#c9d1d9` (neutral) since ERA rank is contextual, not scored.

### "Platoon prose shows no stat to explain the advantage/disadvantage"
**Root cause**: The platoon prose showed "Platoon disadvantage vs LHP" with no numbers — users couldn't see why the model flagged it or how severe the disadvantage was.

**Fix**: Added `hitterSplitBA: _splitBA` to the play output (`_hlCommon` and plays push in `api/[...path].js`). The prose now highlights the split BA stat instead of the label words — "Hits `.229` vs LHP — platoon disadvantage (`.281` season)". The split BA is colored red (disadvantage) or green (edge); season BA neutral. Label text is always gray (`#8b949e`). Sentence structure: `Hits [splitBA] vs [hand] — platoon [edge|disadvantage][( [seasonBA] season)].`

### "Mock plays disappear a few seconds after toggling mock on"
**Root cause**: Race condition — toggling mock while an in-flight API fetch was pending. The `useEffect` set mock plays immediately, but when the stale fetch resolved, its `.then()` callback still fired and overwrote mock plays with API data.

**Fix**: Added `let cancelled = false` flag + `return () => { cancelled = true; }` cleanup to the `useEffect`. The `.then()` and `.catch()` callbacks guard with `if (cancelled) return` before setting any state.

### "Mock player card shows broken headshot image"
**Root cause**: `MOCK_PLAYS` entry used the MLB Stats API player ID (6-digit, e.g. `660271` for Shohei) instead of the ESPN player ID. `navigateToPlay` passes `play.playerId` as `player.id`, which is used to build the ESPN headshot URL (`a.espncdn.com/i/headshots/mlb/players/full/{id}.png`). MLB Stats API IDs are not ESPN IDs and produce a broken image.

**Fix**: use the ESPN player ID in `playerId` for all `MOCK_PLAYS` entries (e.g. `39832` for Shohei Ohtani). ESPN IDs for MLB players are typically in the 28000–50000 range; NBA players in the 3000000–6000000 range.

### "MLB HRR market report shows — for Opp pitcher early in the day"
**Root cause**: ESPN's `probables` (from the scoreboard `hydrate=lineups,probables`) is absent in the morning hours before teams announce their starters. `hitterPitcherName` resolved from `probables[tonightOpp]` only → null for all HRR entries.

**Fallback chain** (in order):
1. `sportByteam.mlb.probables[tonightOpp].name` — ESPN scoreboard (available ~2–3h before first pitch)
2. `sportByteam.mlb.pitcherInfoByTeam[tonightOpp].name` — MLB Stats API people response; probables announced previous day, very reliable. Built in `buildPitcherKPct` from the same people fetch used for season stats.
3. `pitcherGamelogs[tonightOpp].name` — if pitcher gamelog was loaded (i.e. pitcher is known from either source), the name is stored on the gamelog entry. Guarantees: if WHIP/FIP/BAA computed → pitcher name known.

**Why HRR rows in the report still show `—` for pitcher even after fix**: Most HRR entries are `dropped` (edge_too_low / low_confidence), not in `plays[]`. `hitterPitcherName` must be included in all drop objects (not just the plays push) for the report to show it. Check `_dropObj` and `low_confidence` drop in `api/[...path].js` hitter block.

**`pitcherInfoByTeam` map** (in `api/lib/mlb.js`): Built from `res26.people` and `res25.people` — the same MLB Stats API season stats fetch. Keys are team abbreviations (bare abbrs only; `"SD|SEA"` matchup keys excluded). Available whenever `buildPitcherKPct` returns, regardless of ESPN state.

### "NHL SimScore tooltip shows Edge ±X% instead of Team GPG"
**Root cause**: Before commit removing the edge bonus from NHL SimScore, the 6th component was `Edge ±X%: N/3`. After converting to `nhlTeamGPG`, the tooltip still showed the old label if `index.html` was cached.

**Fix**: Hard-refresh (`Cmd+Shift+R`) — the tooltip is computed client-side in `index.html`. If production still shows old label, check if `nhlTeamGPG` is present in play output (`?debug=1` → any NHL play → `nhlTeamGPG` field). If null, the backend variable wasn't added to the plays push.
