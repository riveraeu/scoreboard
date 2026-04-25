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
- **OVER plays**: `overEdge = truePct - kalshiPct >= 5%` → `direction: "over"`, uses `truePct`/`kalshiPct` directly
- **UNDER plays**: `underEdge = (100-truePct) - (100-kalshiPct) >= 5%` → `direction: "under"`, play object has `noTruePct` (UNDER model prob) and `noKalshiPct` (Kalshi NO price); `americanOdds` already set to NO-side odds. Play card badge shows red "Under X.X"; bars use `noTruePct`/`noKalshiPct`; prose colors inverted (low ERA/RPG = green for MLB under, etc.). Track ID: `total|sport|homeTeam|awayTeam|threshold|gameDate|under`
- **Deduplication**: one qualified play per game (homeTeam+awayTeam+sport) — best edge wins across OVER AND UNDER directions AND across game totals vs team totals. If a game total and a team total both qualify for the same game, only the highest-edge play shows as `qualified: true`. Non-winners pushed as `qualified: false` for report visibility.
- **Edge gate**: `edge >= 5%` (both directions); no soft matchup gate for totals
- **SimScore** (max 10): 5 stats × 2pts each; `qualified: totalSimScore >= 8`. OVER and UNDER use separate `totalSimScore`/`underSimScore` (inverted tiers for under).
- **Data maps** (`mlbRPGMap`, `nhlGPGMap/GAAMap`, `nbaOffPPGMap`) computed inline after `leagueAvgCache` block
- **Play card**: `gameType: "total"` triggers `TotalPlayCard` branch; dual team logos, matchup header, truePct/Kalshi bars, explanation prose, SimScore badge. UNDER plays shown in red badge, bars use no-side probabilities.
- **Expected total**: `homeExpected + awayExpected` (lambda sum for MLB/NHL, PPG-adjusted for NBA) shown in explanation prose; `_simData` includes `homeExpected`, `awayExpected`, `expectedTotal`, `gameOuLine`; NBA also includes `homePace`, `awayPace`, `leagueAvgPace` (pace still in `_simData` for prose, not SimScore)
- **SimScore tooltip**: hover the `X/10` badge to see per-component breakdown with actual values. NBA totals example: `CHA off PPG (116): 1/2`. NHL totals example: `LAK GPG (2.7): 1/2`, `CGY GAA (3.15): 1/2`.
- **Edge badge**: shows `+X%` only
- **Track ID format**: OVER: `total|sport|homeTeam|awayTeam|threshold|gameDate` · UNDER: same + `|under`

### Team Totals (MLB, NBA)
- **Stat**: `teamRuns` (MLB), `teamPoints` (NBA)
- **Kalshi series**: `KXMLBTEAMTOTAL`, `KXNBATEAMTOTAL` — `gameType: "teamTotal"` in SERIES_CONFIG. NHL/NFL team total series do not exist on Kalshi.
- **Scoring team extraction**: Ticker suffix after last `-` starts with the team abbreviation (e.g. `LAD8` → scoring team `LAD`). Game teams extracted via existing `parseGameTeams()`.
- **True%**: Monte Carlo simulation — `simulateTeamTotalDist(lambda)` (Poisson, MLB) or `simulateTeamPtsDist(mean, std=11)` (Normal, NBA) in `api/lib/simulate.js`.
  - MLB lambda: `teamRPG × (oppERA / 4.20) × parkRF`, clamped [0.5, 12]
  - NBA mean: `teamOffPPG × (oppDefPPG / leagueAvgDef)`
- **SimScore** (max 10 — 5 stats × 2pts each; `qualified: teamTotalSimScore >= 8`):
  - MLB: teamRPG (>5.0→2, >4.0→1, ≤4.0→0), oppERA (>4.5→2, >3.5→1, ≤3.5→0), oppRPG (same as teamRPG), parkRF (>1.05→2, >1.00→1, else 0), O/U line (≥9.5→2, ≥7.5→1, <7.5→0)
  - NBA: teamOffPPG (≥118→2, ≥113→1, else 0), oppDefPPG (≥118→2, ≥113→1, else 0), O/U line (≥235→2, ≥225→1), teamPace (>lgPace+2→2, >lgPace-2→1), spread (|spread|≤5→2, ≤10→1)
- **Play card**: `gameType: "teamTotal"` branch — single scoring team logo (44px), "{TEAM} vs {OPP}" header, prose shows teamRPG/oppERA for MLB or teamOff/oppDef for NBA, SimScore badge inline
- **Deduplication**: one play per `sport|scoringTeam|oppTeam`, best edge threshold wins
- **Track ID format**: `teamtotal|sport|scoringTeam|oppTeam|threshold|gameDate`

#### Total SimScore details (max 10 — 5 stats × 2pts each; `qualified: totalSimScore >= 8`)
- **MLB**: homeERA tiered (>4.5→2, >3.5→1, ≤3.5→0, null→1), awayERA (same), homeRPG tiered (>5.0→2, >4.0→1, ≤4.0→0, null→1), awayRPG (same), O/U line tiered (≥9.5→2, ≥7.5→1, <7.5→0, null→1). Park RF removed from scoring (still shown in env column in report). High ERA and high RPG score higher — both are over-favorable signals.
- **NBA**: off PPG tiered (≥118→2, ≥113→1, else 0, null→1) per team; def PPG allowed tiered (≥118→2, ≥113→1, else 0, null→1) per team; O/U line tiered (≥235→2, ≥225→1, <225→0, null→1). Pace still in `_simData` for prose display but not scored.
- **NHL**: homeGPG tiered (≥3.5→2, ≥3.0→1, <3.0→0, null→1), awayGPG (same), homeGAA tiered (≥3.5→2, ≥3.0→1, <3.0→0, null→1), awayGAA (same), O/U line tiered (≥7→2, ≥5.5→1, <5.5→0, null→1). ESPN NHL scoreboard fetched for odds via `sportByteam.nhlGameOdds` (normalized via TEAM_NORM.nhl).

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
- 10000 sims if `simScore ≥ 8`, else 5000
- **SimScore** (max 10, edge gate only — 5 stats × 2pts each):
  - CSW%/K% tiered (`kpctPts`): CSW% ≥ 30% = 2pts (green), CSW% > 26% to < 30% = 1pt (yellow), CSW% ≤ 26% = 0pts (red). Falls back to regressed K% only if CSW% unavailable: K% > 27% = 2pts, K% > 24% = 1pt, ≤ 24% = 0pts. Null CSW% + null K% = 1pt (abstain). `kpctMeets = kpctPts > 0` (boolean, always true now).
  - K-BB% tiered (`kbbPts`): > 18% → 2pts (green), > 12% → 1pt (yellow), ≤ 12% → 0pts (red); null → 1pt (abstain). `kbbMeets = kbbPts > 0`. Prose color matches: > 18% green, > 12% yellow, ≤ 12% red (`kbbColor`).
  - Lineup oK% tiered (`lkpPts`): > 24% → 2pts (green), > 22% → 1pt (yellow), ≤ 22% → 0pts; null → 1pt (abstain). `lkpMeets = lkpPts > 0`. Hand-adjusted vs RHP/LHP.
  - **Blended hit rate** (`blendedHitRatePts`): trust-weighted blend of 2026 observed hit rate and 2025 computed hit rate at threshold. `trust26 = min(1, vals26.length / 15)`. ≥ 90% → 2pts (green), ≥ 80% → 1pt (yellow), < 80% → 0pts; null → 1pt (abstain). Replaces `pitchesPts` + `kTrendPts` in simScore formula.
  - O/U tier (`totalPts`): ≤ 7.5 → 2pts (low total = pitcher dominant), < 10.5 → 1pt, ≥ 10.5 → 0pts; null → 1pt
  - Edge ≥ 5% required (gates play independently, not part of SimScore)
- `parkMeets` (`PARK_KFACTOR[homeTeam] > 1.0`) is still computed and included in debug output but no longer contributes to SimScore — park factor is applied inside `simulateKsDist` and affects truePct directly. `PARK_KFACTOR` values updated from FanGraphs 2024 SO column (multi-year rolling avg).
- `kpctPts`: 0/1/2 — CSW%/K% tier score. 2=green, 1=yellow, 0=red (or null). Drives badge color and value in explanation cards. Hard gate removed — kpctPts < 2 no longer drops play before simulation.
- `mlPts`: 0/1/2 — ML tier score, **display only** (not part of simScore). Still included in all play output for debugging.
- `kTrendPts`: 0/1/2 — K-trend score, **display only** (not part of simScore since blendedHitRatePts replaced it; not in market report columns since blendedHitRate replaced ktrend col). Explanation prose (play card + player card) shows the actual `pitcherRecentKPct` stat value with a directional arrow colored by tier. Silent when null. `pitcherRecentKPct` and `pitcherSeasonKPct` included in **all** play output.
- `pitchesPts`: computed for debug output only (not part of simScore since blendedHitRatePts replaced it).
- `totalPts`: 0/1/2 — O/U tier score. Color in UI: 2=green, 1=yellow, 0=red. Low total = pitcher dominant = favorable for Ks.
- `pitcherGS26`: 2026 games started per team abbr, exported from `buildPitcherKPct`, used for small-sample guards. Included in `plays[]` output for debugging (alongside `pitcherHasAnchor`).
- **Gates**: (1) threshold sanity gate — drops as `"threshold_too_high"` (qualified:false) when `threshold > ceil(expectedKs) + 2` (only when lineup confirmed and expectedKs is available); (2) finalSimScore ≥ 8 to qualify as a play (< 8 = qualified:false, shows in report but not plays card); (3) insufficient_starts gate: if `hasAnchor !== true` requires `gs26 ≥ 8`; if `hasAnchor === true` passes through regardless. Catches TJ-return / pure-reliever pitchers (e.g. Detmers with 0 2025 GS). **Important**: insufficient_starts checked in BOTH pre-filter loop AND main play loop. Main loop gate at `api/[...path].js` ~line 1713 uses corrected `playerTeam`; in debug mode pushes to `dropped[]` with reason `"insufficient_starts"`.
- `pitcherHasAnchor`: `true` if gs25 ≥ 5 AND bf25 ≥ 100 (reliable 2025 *starter* anchor). Included in `plays[]` output for debugging. A reliever-turned-starter has bf25 > 0 but gs25 = 0 — reliever K% is not a valid anchor. bf25 ≥ 100 also excludes injury-shortened seasons (e.g. TJ recovery with 5 starts but minimal workload).
- Pitchers fetched via `buildPitcherKPct(mlbSched)` — avg pitches per start from 2026 gamelog (starts-only filtered via `gamesStarted > 0`); falls back to 2025 season aggregate `numberOfPitches / gamesStarted` when no 2026 start data in gamelog
- **K% regression**: `trust = min(1.0, bf26 / 200)` — uses 2026 BF only (NOT combined 2026+2025). Full trust at ~33 starts. Blends 2026 actual K% with 2025 anchor (or league avg 22.2% if no 2025 data). KBB% regressed the same way.
- **A1 — Pitcher recent form**: `_recentKPct` from last 5 starts with ≥3 starts and 30+ total BF. Effective K% = `recentKPct × 0.6 + seasonKPct × 0.4` when recent data meets the threshold; else uses season K% only. `pitcherRecentKPct` map exported from `buildPitcherKPct`, keyed by team abbr. **A1 uses a separate `a1Splits` filter** (any completed start, `date !== today`, no NP minimum) — unlike `startSplits` which requires NP ≥ 30 to protect `avgPitches` from in-progress data. This allows pitch-count-limited starts (e.g. NP 25 on a strict limit after returning from injury) to count toward the recent K% window; the `r5BF >= 30` aggregate gate still ensures a meaningful sample before trusting the percentage.
- **A2 — Pitcher rest/fatigue**: After truePct is computed, a fatigue multiplier is applied to the simulated pitcherKPct before re-querying the distribution. Days since last start ≤ 3 → `× 0.96`; days ≤ 3 AND last start pitch count ≥ 95 → `× 0.92` (short rest + heavy workload). `pitcherLastStartDate` and `pitcherLastStartPC` maps exported from `buildPitcherKPct`, keyed by team abbr.
- **E3a — Umpire K% adjustment**: `UMPIRE_KFACTOR` constant in `api/lib/simulate.js` maps ~50 active umpires to normalized K-rate factors (league avg = 1.0; range ≈ 0.89–1.12). Home plate umpire fetched from MLB Stats API via `hydrate=officials` on the schedule request; extracted into `umpireByGame["homeAbbr|awayAbbr"]` in `buildPitcherKPct` (mlb.js). In the play loop, factor is applied to `pitcherKPctOut` before simulation: `_pitcherKPctAdj = min(40, pitcherKPctOut × _umpireKFactor)`. Name lookup is ASCII-normalized to handle diacritics. Unknown umpires default to 1.0. `umpireName` and `umpireKFactor` (when ≠ 1.0) included in play output.
- **E3b — Expected batters faced**: `_expectedBF = clamp(round(_avgP / 3.85), 15, 27)` where `_avgP` is avg pitches/start and 3.85 is the MLB avg pitches/PA. Passed as 5th arg to `simulateKsDist` (which already accepts `totalPA`). Reduces truePct for pitch-limited starters (75pc → ~20 BF vs default 24); slightly increases for workhorses (105+pc → ~27 BF). `expectedBF` included in play output when ≠ 24.

#### MLB Hitters (hits/hrr) Model
- **`hits` True%**: Monte Carlo simulation (`simulateHits`) using batter BA × pitcher BAA (log5), park-adjusted
- **`hrr` True%**: `(primaryPct + softPct) / 2 × parkFactor` (no Monte Carlo)
  - `primaryPct` = player's 2026 HRR 1+ rate (falls back to 2025+2026 blend, then career)
  - `softPct` = HRR 1+ rate vs tonight's pitcher (H2H gamelog dates) or vs tonight's team (2025+2026 fallback)
  - BA is NOT directly in the formula — it's implicit via the player's historical HRR rate
- **SimScore** (max 10, edge gate only — 5 stats × 2pts each):
  - Batter quality composite (`hitterBatterQualityPts`): spot ≤ 3 = "good spot"; barrel% ≥ 10% = "good barrel". Both → 2pts, either → 1pt, neither → 0pts, both null → 1pt (abstain). Replaces separate spot/barrel components.
  - Pitcher WHIP tiered (`hitterWhipPts`): > 1.35 → 2pts (green), > 1.20 → 1pt (yellow), ≤ 1.20 → 0pts (red); null → 1pt (abstain). Rescaled from 3/2/1.
  - Season hit rate (`hitterSeasonHitRatePts`): blended 2026/2025 HRR 1+ rate. ≥ 90% → 2pts, ≥ 80% → 1pt, < 80% → 0pts; null → 1pt (abstain). `trust26 = min(1, vals26.length / 30)`.
  - H2H hit rate (`hitterH2HHitRatePts`): rate vs tonight's pitcher from gamelog (H2H dates only, requires ≥ 3 games). ≥ 90% → 2pts, ≥ 80% → 1pt, < 80% → 0pts; null → 1pt (abstain). **No team fallback** — H2H only.
  - O/U total tier: ≥9.5 → 2pts, ≥7.5 → 1pt, <7.5 → 0pts, null → 1pt
  - Max: 2+2+2+2+2 = 10. Platoon (`hitterPlatoonPts`) still computed and displayed in prose but removed from SimScore. Park factor still shown in report env column.
- **B2 — Batter recent form**: `hitterEffectiveBA = 0.6 × recentBA + 0.4 × seasonBA` when ≥20 AB in last 10 2026 games; else uses seasonBA. Fed directly into `simulateHits` as `batterBA`. `batterRecentBA` map built inline from ESPN gamelog in main play loop.
- **Gates**: lineup spot 1–4 required; hitterFinalSimScore ≥ 8 (Alpha tier); edge ≥ 5% (gate only, not scored)
- Barrel% from Baseball Savant (`buildBarrelPct`) — cached 6h in KV; `hitterBarrelPts` stored in play output
- NBA game totals fetched from ESPN scoreboard (`sportByteam.nbaGameOdds`) — always fresh (not long-term cached)
- NHL game odds fetched from ESPN NHL scoreboard (`sportByteam.nhlGameOdds`) — extracted from existing `gameTimes` scoreboard events when fresh; fallback fetch when gameTimes loaded from cache. Keyed by normalized abbreviation via `normTeam("nhl", abbr)`. Only populated for today's games (ESPN doesn't include odds for future dates).
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
- **SimScore** (max 10, edge gate only — 5 stats × 2pts each):
  - **C1 — stat-appropriate opportunity signal** (max 2pts, null → 1pt abstain). From `buildNbaUsageRate`:
    - **points/assists/threePointers**: USG% ≥28% → 2pts, ≥22% → 1pt, <22% → 0pts. (`USG% = (avgFGA + 0.44×avgFTA + avgTO) / (avgMin × 2.255) × 100` — ESPN `usageRate` is 0.0 so fallback always runs)
    - **rebounds**: avgMin ≥30 → 2pts, ≥25 → 1pt, <25 → 0pts.
  - Position-adjusted DVP ratio tiers: ratio ≥ 1.05 → 2pts (soft), ratio ≥ 1.02 → 1pt (borderline), else → 0pts. `dvpRatio` field included in all play/drop output.
  - Season hit rate (`nbaSeasonHitRatePts`): `primaryPct` (blended 2026/2025/career) at threshold. ≥ 90% → 2pts, ≥ 80% → 1pt, < 80% → 0pts.
  - Soft matchup hit rate (`nbaSoftHitRatePts`): `softPct` (hit rate vs soft defensive teams) at threshold. ≥ 90% → 2pts, ≥ 80% → 1pt, < 80% → 0pts; null → 1pt (abstain).
  - Combined pace + total (`nbaTotalPts`): both favorable (pace > 0 AND total ≥ 225) → 2pts; one favorable → 1pt; neither → 0pts; both null → 1pt abstain. Pace from `buildNbaPaceData()`, cached 12h. Game totals from `sportByteam.nbaGameOdds`.
  - Max: 2+2+2+2+2 = 10. Spread and standalone pace no longer scored separately.
- nSim scales with pre-edge simScore: ≥8 → 10k, ≥5 → 5k, else 2k
- **Gate**: edge ≥ 5% (gate only, not scored); **nbaSimScore ≥ 8** to qualify as a play. No soft-matchup pre-filter — all NBA markets enter the play loop regardless of opponent DVP.
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
- **SimScore** (max 10, edge gate only — 5 stats × 2pts each):
  - Avg TOI tiered (`nhlOpportunity`, last 10 games): ≥ 18 min → 2pts; ≥ 15 min → 1pt; < 15 min → 0pts; null → 0pts. Rescaled from 4/2/0.
  - Opponent GAA rank (`_gaaRank`): ≤ 10 → 2pts; ≤ 15 → 1pt; else → 0pts. Middle tier added (was binary ≤10=2). null → 0pts.
  - Season hit rate (`nhlSeasonHitRatePts`): rate at threshold across all career games. ≥ 90% → 2pts, ≥ 80% → 1pt, < 80% → 0pts.
  - DVP hit rate (`nhlDvpHitRatePts`): games vs teams with GAA > league avg, hit rate at threshold (≥ 3 qualifying games required). ≥ 90% → 2pts, ≥ 80% → 1pt, < 80% → 0pts; null → 1pt (abstain).
  - Game total (`nhlGameTotal`): ≥ 7 → 2pts, ≥ 5.5 → 1pt, < 5.5 → 0pts; null → 1pt (abstain). Replaces B2B (2pts) and SA rank (3pts).
  - Max: 2+2+2+2+2 = 10. SA rank (`nhlSaRank`) and team GPG (`nhlTeamGPG`) still computed and stored for display but no longer scored.
- nSim scales with pre-edge simScore: ≥8 → 10k, ≥5 → 5k, else 2k
- **B2B** detection: same as NBA — checks if last gamelog event was yesterday (UTC)
- TOI from ESPN gamelog `TOI` or `timeOnIce` column; parsed as `MM:SS` or decimal minutes
- Shots against rank from NHL API `shotsAgainstPerGame`, stored in `nhlSaRankMap`, league avg in `nhlLeagueAvgSa`
- **Gate**: edge ≥ 5%; nhlSimScore ≥ 8 (Alpha tier) — no soft team pre-filter (all NHL markets enter play loop)

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
| `buildLineupKPct(mlbSched)` | Lineup batter K-rates, lineup spots, ordered arrays; also exports `batterSplitBA` (vsR/vsL BA, 2025+2026 blended, 20+ combined AB) for B1 platoon |
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
- **Polymarket disabled (commit be7b2ad)**: Polymarket fetch, Poly-only injection, and derived prices are all commented out — prices were not accurate enough. Edge gate reverts to Kalshi-only `edge < 5`. `polyPct/polyVol/bestVenue` are always null in play output. Frontend handles null gracefully (teal Poly bar hidden, tooltips simplified). To re-enable, uncomment the two `/* ... */` blocks in `api/[...path].js` around `polyPctMap` and `polyDerivedMap`, restore the poly lookup in the play loop, and change the gate back to `bestEdge < 5`.

### preDropped vs dropped
- `preDropped`: filtered before main play loop (no ESPN info yet) — included in `?debug=1` response
- `dropped`: filtered inside play loop — included in `?debug=1` response
- **Game totals** go to `dropped[]` (not `preDropped`) when they fail the edge gate or have no simulation data (`truePct == null`). Reasons: `"edge_too_low"` or `"no_simulation_data"`. The market report combines `plays[]` + `dropped[]` — `preDropped` is NOT shown in the report.
- **`nbaDropped`**: NBA `opp_not_soft` drops always go here (not just in debug mode) and are included in the regular `/api/tonight` response. Each entry has the full player-card fields: `seasonPct`, `seasonGames`, `softPct`, `softGames`, `nbaOpportunity`, `nbaPaceAdj`, `isB2B`, `nbaSimScore`, `nbaGameTotal`, `nbaTotalPts`, `nbaUsage`, `nbaAvgAst`, `nbaAvgReb`, `nba3pMPG`. The frontend uses these to populate `tonightPlayerMap` as a fallback so the player card explanation renders fully even when the matchup didn't qualify.

### qualified:false plays
All player prop sports push dropped plays to `plays[]` with `qualified: false` so the player card explanation renders even when a play fails a gate. The main plays list (`tonightPlays`) filters these out client-side: `.filter(p => p.qualified !== false)`.

The raw (unfiltered) array is stored in `allTonightPlays` and used to build `tonightPlayerMap` in the player card — this ensures all players visible in the market report also have explanation data on their player page.

**Which gates push `qualified: false` to `plays[]`:**
- **MLB strikeouts**: edge gate, threshold_too_high gate, finalSimScore < 8 gate — all thresholds included so the player card shows monotonically decreasing truePct across 3+/4+/5+
- **MLB HRR**: edge gate (`edge < 5` or `kalshiPct < 70`), hitterFinalSimScore < 8 gate — includes all explanation fields (`hitterBa`, `hitterBatterQualityPts`, `hitterSeasonHitRatePts`, `hitterH2HHitRatePts`, `hitterSoftLabel`, `hitterGameTotal`, etc.)
- **NBA**: edge gate, nbaSimScore < 8 gate — includes `nbaGameTotal`, `nbaUsage/Ast/Reb`, `nba3pMPG`, `nbaPaceAdj`, `posDvpRank/Value`, `nbaBlowoutAdj`, `nbaSeasonHitRatePts`, `nbaSoftHitRatePts`
- **NHL**: edge gate, nhlSimScore < 8 gate — includes `nhlOpportunity`, `nhlShotsAdj`, `nhlTeamGPG`, `nhlSaRank`, `nhlSeasonHitRatePts`, `nhlDvpHitRatePts`

**Pre-gates that do NOT push to `plays[]`** (inside the sport block, before truePct is computed):
- MLB HRR `low_lineup_spot` (spot ≥ 5) — player doesn't merit an explanation card
- MLB HRR `hitterSimScore < 5` — very poor quality, no explanation shown

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
All threshold plays that pass the edge gate (≥ 3%) are pushed to `plays[]`. Best threshold per game is `qualified: totalSimScore >= 8`; others are `qualified: false`. Mirrors strikeout threshold behavior — `tonightPlays` (filtered) shows only the best, `allTonightPlays` (unfiltered) has all thresholds for the team page bar chart.

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
Opened via "report" button. Shows ALL markets (plays + dropped) grouped by sport/stat. Columns vary by sport/stat via `XCOLS` map. Sport tabs: **ALL / MLB / NBA / NHL / CALIBRATION**. Column header tooltips defined in `COL_TIPS` dictionary (keyed by XCOLS `k` value) — hover any column header to see description + color tier thresholds. Totals-specific keys (`homeRPG`, `awayERA`, `homeOff`, `awayDef`, `totalOu`, `homeGPG`, `awayGAA`, etc.) all have entries.
- **First column navigation**: Player name spans are clickable (`cursor:pointer`) — clicking closes the report (`setShowReport(false)`) and navigates to that player's card via `navigateToPlayer({ id: m.playerId, name: m.playerName, sportKey: SPORT_KEY[m.sport] }, m.stat)`. For game total rows, each team abbreviation (`awayTeam` and `homeTeam`) is separately clickable and navigates to that team's page via `navigateToTeam`. No underline styling.
- **`fetchReport` syncs plays card**: After fetching `?debug=1`, `fetchReport` also updates `tonightPlays` and `allTonightPlays` from the fresh response. This keeps the plays card in sync with the report (avoids stale-cache discrepancy where plays card loaded at page open shows different results than the report fetched later).
- **HRR table**: shows threshold=1 rows only (2+/3+/etc. filtered client-side — too noisy)
- **Score > 7 highlight**: For MLB rows (strikeouts + HRR), the player name is white+bold only when `finalSimScore ?? hitterFinalSimScore > 7` (Alpha tier). Rows with score ≤ 7 get a dim gray name even if qualified. Non-MLB tables use the original `m.qualified` logic for name color.
- **SimScore tooltip (market report)**: hover any `X/10` score badge to see per-component breakdown. Computed inline in `xcell k==="sim"` from available play fields:
  - **Strikeouts**: CSW%/K%: X/2, K-BB%: X/2, Lineup K%: X/2, Hit Rate: X/2, O/U: X/2
  - **HRR**: Quality: X/2, WHIP: X/2, Season HR: X/2, H2H HR: X/2, O/U: X/2
  - **NBA**: C1 (USG%/AvgMin): X/2, DVP: X/2, Season HR: X/2, Soft HR: X/2, Pace+Total: X/2
  - **NHL**: TOI Xm: X/2, GAA rank: X/2, Season HR: X/2, DVP HR: X/2, O/U X: X/2
  - **MLB totals**: Home/Away ERA (>4.5→2, >3.5→1, ≤3.5→0), Home/Away RPG (>5.0→2, >4.0→1, ≤4.0→0), O/U (≥9.5→2, ≥7.5→1)
  - **NBA totals**: Home/Away off PPG (≥118→2, ≥113→1, else 0), Home/Away def allowed (≥118→2, ≥113→1, else 0), O/U line (≥235→2, ≥225→1)
  - **NHL totals**: Home/Away GPG (≥3.5→2, ≥3.0→1, <3.0→0), Home/Away GAA (same), O/U line (≥7→2, ≥5.5→1)
  - Cursor changes to `help` when tooltip is available. Detection: `m.totalSimScore != null` → total play; otherwise sport-specific score fields.
- **Market report column color tiers** — colors match SimScore tiers exactly (yellow = middle tier earns points, gray = earns 1pt but lowest tier, red = 0pts):
  - `lkp`: >24% green, >22% yellow, ≤22% red
  - `kbb`: >18% green, >12% yellow, ≤12% red
  - `plat`: platoonPts=2 green, platoonPts=1 yellow, platoonPts=0 red
  - `whip`: >1.35 green, >1.20 yellow, ≤1.20 red (2/1/0pts; null=1pt abstain)
  - `brrl`: ≥14% green, ≥10% yellow, <10% gray — shown in report env column but no longer in SimScore directly (now part of `hitterBatterQualityPts`)
  - `nhlgaa`: ≤10 green, ≤15 yellow, >15 red (3-tier — ≤10=2pts, ≤15=1pt, >15=0pts)
  - `nbapace`: >0 green, >-2 yellow, ≤-2 gray (slow pace earns 1pt, not 0; gray not red)
  - `homeOff`/`awayOff` (NBA totals Off PPG): ≥115 green, ≥108 yellow, else gray — high offense = good for over = green (playoff-appropriate; regular season SimScore tiers 118/113 differ)
  - `homeDef`/`awayDef` (NBA totals Def PPG allowed): ≥112 green, ≥105 yellow, else gray — high allowed = bad defense = good for over = green; no red floor (good defense is just gray)
  - `totalOu` (NBA/NHL totals O/U column): NBA: ≥215 green, ≥205 yellow, else gray; NHL: ≥6 green, ≥5 yellow, else gray — shows threshold as `O{line}` (e.g. `O214.5`)
  - `plat` sort: keyed on `hitterSplitBA` ascending
- **Team totals table** (`mlb|teamRuns`, `nba|teamPoints`): section header shows **"MLB Team Runs"** / **"NBA Team Points"** via `STAT_NAME` entries. First column labelled "Matchup", shows `scoringTeam vs oppTeam`. Score column uses `m.teamTotalSimScore` (qual gate = 8); hover tooltip shows per-component breakdown. XCOLS: MLB = Team RPG / Opp ERA / Opp RPG / Park / O/U; NBA = Team PPG / Opp Def / O/U / Pace / Spread. **Colors** match SimScore tiers: RPG >5.0 green / >4.0 yellow; ERA >4.5 green / >3.5 yellow; Park >+5% green / >0% yellow; NBA PPG ≥118 green / ≥113 yellow; O/U sport-specific thresholds. `ttPace` shows team pace delta from league avg. `ttSpread` shows absolute spread (≤5 green, ≤10 yellow, >10 red). New `k` keys: `ttTeamRPG`, `ttOppERA`, `ttOppRPG`, `ttPark`, `ttOu`, `ttTeamOff`, `ttOppDef`, `ttPace`, `ttSpread` — all in `xcell` handler and `COL_TIPS`.

- **Game totals table** (`mlb|totalRuns`, `nba|totalPoints`, `nhl|totalGoals`): section header shows **"[Sport] Totals"** (e.g. "NBA Totals") via `STAT_NAME` entries `totalRuns/totalPoints/totalGoals → "Totals"`. First column labelled "Matchup" (not "Player"), shows `AWY @ HME`. Opp column hidden. Line cell shows `O7.5` format. Score column uses `m.totalSimScore` (qual gate = 8); green ≥ 8, yellow = 5–7, gray < 5. XCOLS: MLB = H RPG / A RPG / H ERA / A ERA / O/U; NBA = H PPG / A PPG / H Def / A Def / O/U; NHL = H GPG / A GPG / H GAA / A GAA / O/U. **MLB ERA/RPG column colors**: ERA ≥4.5 → green (bad pitcher = over-favorable), ≥3.5 → yellow, <3.5 → gray; RPG ≥5.0 → green, ≥4.0 → yellow, <4.0 → gray. **NBA column colors**: Off PPG ≥115 green (high offense = favorable for over), Def PPG allowed ≥112 green (bad defense = favorable), O/U ≥215 green — all use playoff-appropriate tiers. **NHL column colors**: GPG/GAA ≥3.5 green, ≥3.0 yellow, else gray; O/U ≥6 green, ≥5 yellow. Dedup key for totals is `homeTeam|awayTeam|threshold` (not `playerName|threshold`).

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

**ⓘ info icon** (next to date, left side): toggles a tooltip showing universal play qualification criteria — three lines only: Implied prob ≥ 70%, Edge ≥ 5%, SimScore ≥ 8/10. No sport-specific detail. State: `showPlaysInfo`.

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
- **Lineup badges** in play card subtitle: `play.lineupConfirmed === true` → green `✓ Lineup`; `play.lineupConfirmed === false` → gray `Proj. Lineup`. The `Proj. Lineup` badge is suppressed when `gameTime` is within 30 minutes of now or has passed (`Date.now() >= new Date(gameTime).getTime() - 30*60*1000`) — at that point the game is imminent and the warning is no longer actionable.
- **Date grouping**: plays are grouped by `gameDate` with "Today" / "Tomorrow" section headers. When the API returns plays for multiple dates (e.g. UTC has already flipped to tomorrow), today's plays appear first under "Today" and tomorrow's under "Tomorrow".

**Team total play cards** (`gameType: "teamTotal"`) — rendered before game total cards in play card map:
- Header: `[44px scoring team logo] {TEAM} vs {OPP}` — single team logo, scoring team name links to team page
- Bars: `truePct` (model OVER probability) and `kalshiPct`
- Explanation: sport-specific prose (MLB: teamRPG + oppERA; NBA: teamOff + oppDef + teamExpected); SimScore badge inline
- Track ID: `teamtotal|sport|scoringTeam|oppTeam|threshold|gameDate`

**Total play cards** (`gameType: "total"`) render differently from player prop cards:
- Header: inline format `[44px away logo] AWY @ HME [44px home logo]` — away logo leads, home logo trails. Team abbreviations at `fontSize:12, fontWeight:600, color:#c9d1d9`. No sport emoji.
- **OVER plays** (`direction: "over"`): blue "Over X.X" badge; bars use `truePct`/`kalshiPct`; prose colors: high ERA/RPG = green (good for over)
- **UNDER plays** (`direction: "under"`): red "Under X.X" badge; bars use `noTruePct`/`noKalshiPct`; `displayTruePct`/`displayKalshiPct` locals set to no-side values; prose colors inverted (low ERA = green, high RPG = bad for under); `isUnder` flag drives all conditional logic; scTitle tooltip prefixed with `[Under SimScore]`
- Explanation: single prose block with colored stat values inline; SimScore badge (with hover tooltip) appended at end of prose (no separate SimScore row or checkboxes). Same `background:"#0d1117"` block as player cards.
- Prose includes model-projected expected total vs threshold (e.g. "Model projects 8.4 combined runs vs the 7.5 threshold"). NBA also shows pace adjustment.
- **Stat colors for NBA totals** (play card prose only — market report uses different tiers, see below): offensive PPG — ≥118 red, ≥113 yellow, else gray (high scoring = already efficiently priced). Defensive PPG allowed — ≥118 green, ≥113 yellow, else red (bad defense = good for over). **Market report columns use playoff-appropriate tiers**: Off PPG ≥115 green / ≥108 yellow / else gray; Def PPG allowed ≥112 green / ≥105 yellow / else gray — green always means "favorable for over" in the report.
- **Stat colors for MLB totals**: ERA — >4.5 green, >3.5 yellow, ≤3.5 red (high ERA = hittable pitcher = good for over). RPG — >5.0 green, >4.0 yellow, ≤4.0 gray (high run-scoring = good for over). Both directions: high value = good for over.
- **Stat colors for NHL totals**: GPG — ≥3.5 green, ≥3.0 yellow, <3.0 gray (high scoring = good for over). GAA — ≥3.5 green, ≥3.0 yellow, <3.0 gray (high GAA = bad defense = good for over). Both directions: high value = green = good for over.
- **SimScore tooltip for MLB totals**: shows actual values and earned points per component (e.g. `SD ERA (4.73): 3/3`, `SEA RPG (4.2): 1/2`). Points derived from same tiered formula as backend.
- **SimScore tooltip for NHL totals**: shows actual values and earned points per component (e.g. `LAK GPG (2.7): 1/3`, `CGY GAA (3.15): 1/2`, `O/U (5.5): 2/4`). Points derived from same tiered formula as backend.
- **SimScore tooltip for NBA totals**: shows actual values and earned points (e.g. `GSW off PPG (118): 2/2`, `LAL def allowed (108): 1/2`, `O/U (225): 1/2`). Both play card badge (hover `scTitle`) and market report `xcell k==="sim"` show the same breakdown.
- No player card on click (`gameType === "total"` returns early from `navigateToPlay`).

### Player Card
MLB tabs: pitchers see **Strikeouts** only; hitters see **H+R+RBI** only. The standalone "Hits" tab was removed (HRR encompasses hits). `allStatCfgs["baseball/mlb"]` no longer includes `hits`; `hitterTabs = ["hrr"]`. During loading (`mlbIsPitcher === null`), all `allStatCfgs` tabs show — now just HRR + Strikeouts.

Clicking a play opens the player card with:
- Historical rates per threshold
- Kalshi market prices
- truePct from `tonightPlayerMap` (keyed `stat|threshold`) — built from `allTonightPlays` (unfiltered) so `qualified: false` thresholds (e.g. 3+/4+ strikeouts with no edge bonus) use their simulation-based truePct
- Monotonicity enforced client-side: after building `_rawTruePctMap`, walks highest→lowest threshold tracking the running max and raises any value that dips below it. Safety net for any remaining non-monotonicity after backend sweep.
- **Game time** shown as third line under player name/team in header (`"Today · 7:40 PM PT"` or `"Tomorrow · 1:10 PM PT"`). Looks up `gameTime` from `allTonightPlays` filtered to this player, sorted by `gameDate` ascending so today's game is preferred when multiple dates exist. Day label uses browser local date comparison against `gameDate`.
- **Pick button (☆/★)** on the player card: shown when `qualifies === true` (`k.pct >= 70 && edge >= 3`). `existingPick` is found by matching `sport|name|stat|threshold` ignoring gameDate, but **only for today/future** picks (`pd >= today`; empty legacy `pd` always matches). `untrackPlay` uses `existingPick.id` (the actual stored ID) so old picks with empty gameDate are correctly removed. `trackPlay` call includes `gameDate: tonightPlay?.gameDate || ""` so the stored ID matches the `isTracked` check.
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
2. **SimScore row** — `SimScore` label + `X/10 Tier` badge + stat checkboxes. All on one flex line (`display:"flex", alignItems:"center", gap:6`). Badge uses `whiteSpace:"nowrap"`. Checkboxes in an inner `display:"inline-flex", gap:4, flexWrap:"wrap"` span so whole items wrap as units. **Exception: MLB hitter (HRR) and NHL player cards use inline badge at end of prose (no separate row), matching game total card style.**

**MLB hitter (HRR) explanation prose order** (play card + player card, both locations):
1. Batting spot (e.g. "Shohei, batting #1 — top of the order"). BA tier and BA value removed — not a SimScore component.
2. Pitcher name — WHIP always shown; color binary: `> 1.35 → green` (3pts, + "a lot of baserunners" description), `≤ 1.35 → red` (0pt — no description, color is sufficient). FIP removed from prose — not a SimScore component.
3. Season rate + soft rate (vs pitcher H2H or vs team)
4. ERA rank / no-H2H context — **only shown when `softPct === null` (no H2H data)**. When H2H exists, the soft rate already explains the matchup. ERA rank color is `#c9d1d9` (neutral, not bold red) since it's contextual, not a SimScore component.
5. Park factor (when |pf − 1.0| ≥ 0.03) — sourced from `tonightHitPlay?.parkFactor ?? tonightHitPlay?.hitterParkKF` (fallback needed because HRR plays store park factor as `hitterParkKF`, not `parkFactor`)
6. Game total (color: ≥9.5 green, ≥7.5 yellow, <7.5 gray)
7. Barrel rate (color: ≥14% green/"elite hard contact", ≥10% yellow/"strong contact quality", ≥7% gray/"average contact", <7% dim — from `hitterBarrelPct`)
8. Platoon edge/disadvantage: stat highlighted, label dimmed — "Hits `.310` vs RHP — platoon edge." or "Hits `.229` vs LHP — platoon disadvantage (`.281` season).". Split BA in green (edge ≥+15%) or red (disadvantage); season BA in `#c9d1d9` neutral. Silent when 1pt (neutral/abstain, ratio 0.95–1.15).
9. SimScore badge inline
10. **Lineup badge** — `✓ Lineup` (green) when `lineupConfirmed === true`; `Proj. Lineup` (gray) when `lineupConfirmed === false` and game is not imminent (same 30-minute rule as play card subtitle). `lineupConfirmed` and `gameTime` sourced from `tonightHitPlay` (HRR) or `h2h` (strikeouts, via `tp.lineupConfirmed/gameTime` added to h2h object). `verticalAlign:"middle"` so badge sits inline with SimScore badge.

**HRR market report columns:** `XCOLS["mlb|hrr"]` = Score / **Quality** / WHIP / **Ssn HR%** / **H2H HR%** / Park / **O/U**. Old Spot / Plat / Brrl% columns replaced with new SimScore components. `Quality` shows `#spot barrel%` (e.g. `#3 12%`) colored by `hitterBatterQualityPts` (2=green, 1=yellow, 0=red). `Ssn HR%` shows `m.seasonPct` colored by value tiers (≥80% green, ≥70% yellow, <70% red — wider than SimScore scoring tiers for easier scanning). `H2H HR%` shows `m.softPct` colored by `hitterH2HHitRatePts`. Park still shown as env column (context, not scored). SimScore tooltip: `Quality: N/2`, `WHIP: N/2`, `Season HR: N/2`, `H2H HR: N/2`, `O/U: N/2`. Null-abstain shows `1` not `—`.

**Strikeout market report columns:** `XCOLS["mlb|strikeouts"]` = Score / CSW% / K-BB% / Lineup K% / P/GS / **Hit Rate** / O/U. K-Trend column replaced with **Hit Rate** (`blendedHitRate` field, colored by `blendedHitRatePts` tiers: ≥90% green, ≥80% yellow, <80% red). `blendedHitRate` is a new field added to all strikeout play/drop output — the actual trust-weighted blended rate value (not just the pts). `_blendedHR` hoisted to outer `let` scope so it's accessible in the main plays push for all stats.

**NHL player prop explanation** (play card + player card, both locations): single prose block — SimScore badge inline at end (no separate row, no checkboxes). SimScore tooltip on hover shows component breakdown: `TOI Xm: N/2`, `GAA rank: N/2`, `Season HR: N/2`, `DVP HR: N/2`, `O/U X: N/2`.

**Total play cards** (MLB/NBA/NHL game totals): single prose block only — no separate SimScore row. SimScore badge appended inline at the end of the prose with `verticalAlign:"middle"`.

**SimScore checkbox helpers (NBA player prop cards only):**
- NBA: `mkGate(meets, pts, label)` → `✓/✗ label (pts)` — spaces, `whiteSpace:"nowrap"` per item

**Edge gate color (all sports):**
- `≥ 3%` → `#3fb950` green, ✓, opacity 1
- `0–2.9%` → `#e3b341` yellow, ✗, opacity 0.7
- negative → `#f78166` red, ✗, opacity 0.7

**Player card explanation** uses the same structure. Data sources by sport:
- MLB strikeouts: `h2h` object built from `tonightPlayerMap` (includes `edge`, `kpctMeets`, `kpctPts`, `kbbMeets`, `lkpMeets`, `pitchesPts`, `mlPts`, `parkMeets`, `lineupConfirmed`, `gameTime`)
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

**When this can still happen**: only for the MLB HRR pre-gates (`low_lineup_spot` spot ≥ 5, or `hitterSimScore < 5`). All other gates (edge, simScore < 8) now push to `plays[]` with `qualified: false`.

**Diagnosis**: check `?debug=1` → `dropped[]` for the player. If `reason` is `"low_lineup_spot"` or `"low_confidence"` with `hitterSimScore < 7`, they hit a pre-gate before truePct was computed — no explanation data exists. Any other reason means a gap in the qualified:false push logic.

### "Non-MLB player card shows 'No game data found' or 'Could not load game log'"
The `/api/gamelog` endpoint for non-MLB sports (NBA, NHL, NFL) scrapes ESPN HTML pages (`www.espn.com/{sport}/player/gamelog/...`) and parses the `window['__espnfitt__']` JavaScript variable. **Vercel Edge Functions are frequently served a bot-detection page by ESPN** that does not contain `__espnfitt__` → the endpoint returns `{error: "Could not find __espnfitt__ data in page"}` with HTTP 500.

**Before fix (commit 9452812)**: `loadPlayer` had no `.ok` check — it called `.json()` on a 500 response, got `{error: "..."}`, passed it to `parseGameLog` which returned empty data → silently showed "No game data found" with no explanation.

**After fix**: `if (!gameRes.ok) throw new Error('Could not load game log')` → catch block shows "Could not load game log: Could not load game log" in the player card error state — honest failure, not misleading empty state.

**Root cause is unfixable on our side**: ESPN blocks server-side requests to their HTML gamelog pages from Vercel's IP ranges. The JSON API (`site.web.api.espn.com/apis/common/v3/sports/...`) used by the main play loop works fine (different domain). A full fix would require switching `/api/gamelog` to use the same JSON API endpoint, but parsing is different and player card gamelog tables would need updating. The HTML scraper works fine from a browser/local machine.

### "Why is truePct wrong for 3+/4+ when 5+ looks correct?" (fixed)
Previously, `tonightPlayerMap` was built from `tonightPlays` (filtered: `qualified !== false`). Thresholds like 3+/4+ with no edge bonus (finalSimScore < 8) were `qualified: false` and omitted, so the player card used the raw fallback formula `(seasonPct + softPct) / 2` — breaking monotonicity (e.g. 4+ showed 76.8% while 5+ showed 97.9%).

**Fix**: `tonightPlayerMap` now uses `allTonightPlays` (unfiltered), which includes `qualified: false` entries with their API-computed, monotonicity-enforced simulation truePct.

If truePct still looks wrong: check `?debug=1` and look in `dropped` for the missing threshold — if it's there (not in `plays[]` at all), the fallback still applies. Check `reason`. Current gate reasons: `"threshold_too_high"` (threshold > ceil(expectedKs) + 2), `"insufficient_starts"`, `"simScore_too_low"` (finalSimScore < 8).

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
- `?bust=1` skips reads for `byteam:mlb`, `byteam:nhl`, `byteam:nba`, `byteam:nba:scoring`, `gameTimes:v2:{date}`, AND `nba:pace:2526` — forces fresh MLB + NHL + NBA data, ESPN game times, and NBA pace in one shot
- `mlb:barrelPct` is NOT busted — barrel% survives with its own 6h TTL
- If bust fires before lineups/probables are available, `byteam:mlb` is written with 60s TTL so next request retries
- Depth chart: no bust — expires daily

### "NBA totals show massive UNDER edges during playoffs (false positives)"
During the NBA playoffs, ESPN's `byteam?category=scoring` and `?category=defensive` endpoints return playoff stats — often only 1-3 games of sample. Teams scoring 96-104 PPG vs actual regular season 115-120 PPG causes model to compute `expectedTotal=183` while market O/U is 213+, creating false UNDER edges of 60-70%.

**Fix (in place)**: Both endpoints add `&seasontype=2` to force regular season averages year-round. This is the same approach used for `buildNbaUsageRate` (player stats with `types/2`).

**Symptom to watch for**: If NBA UNDER plays appear with `noTruePct > 70%` (high UNDER model confidence) but `gameOuLine` is 210+, suspect playoff stat distortion. Check `homeOff`/`awayOff` fields — values < 110 indicate the endpoint may be returning playoff data again. Fix: verify `&seasontype=2` is present in both URLs.

### "NBA report shows — for Pace/AvgMin/Rest on most rows"
All NBA markets now go through the full simulation loop (no opp_not_soft pre-filter). Every market computes pace, C1, DVP, B2B, and game total in the main block. If most rows show `—`, the ESPN gamelog or pace data fetch likely failed for that player — check `_debug` field in dropped entries.

### "NBA 3P SimScore C1 shows — or seems wrong"
For `threePointers`, C1 is now scored on **USG%** (same as points and assists). `nba3pMPG` is still computed and stored in play output for display but no longer drives the score. Check `?debug=1` → `plays[].nbaUsage` for the raw value. If null, falls back to 2pt abstain.

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
2. Main loop: DVP ratio ≥ 1.05 → 2pts SimScore; C1 (USG%/AvgMin) → up to 2pts; season HR, soft HR, pace+total → additional pts
3. truePct computed via Monte Carlo simulation
4. If edge ≥ 5% AND simScore ≥ 8 → qualifies as a play

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

### "Game time shows completely wrong time (e.g. 12:45 PM instead of 7:15 PM)"
**Root cause**: The `gameTimes` date-specific key (`sport:team:ptDate`) was unconditionally overwritten on every event encountered. ESPN scoreboards return yesterday's and today's events combined — if an earlier game's event (different game, wrong time) was processed after the correct game for the same team+date, it silently overwrote the correct time.

**Fix (commit 9452812)**: Changed the date-specific key from always-overwrite to latest-UTC-time-wins: `if (!_existDt || ev.date > _existDt) gameTimes[key:ptDate] = ev.date`. The most chronologically recent event for a team+date wins, which is the correct current game.

### "Play card or player card shows 'Tomorrow' for a game that's today"
**Root cause**: `gameTimes["mlb:TOR"]` was keyed only by team, not by PT date. When the backend fetched only UTC-today's ESPN scoreboard, a game at 5:10 PM PT on Apr 18 returned as `2026-04-19T00:10Z` (UTC Apr 19). The bare key was set from that Apr 19 entry → `gameTime` pointed to tomorrow.

**Fix (in place)**:
1. Backend now fetches **both yesterday and today** ESPN scoreboards in parallel per sport (`Promise.all([yesterday, today])`), merging events from both.
2. `gameTimes` now stores entries keyed by **PT date** (`"sport:team:ptDate"`) alongside the bare fallback. A game at 2026-04-18 PT is stored under `"mlb:TOR:2026-04-18"` even if its UTC time is Apr 19.
3. Play loop lookup: `gameTimes["sport:team:gameDate"]` first (PT-date-specific), falls back to bare `"sport:team"`. **This applies to player props, game totals, AND team totals** — all three use the date-specific key first.
4. Day label in play card and player card uses `play.gameDate` directly for the Today/Tomorrow comparison — not re-derived from `gameTime` — so even if `gameTime` is UTC-tomorrow, the label still says "Today" when Kalshi's `gameDate` is today.

**Multi-game series bug (commit ba25af4)**: When a team plays consecutive days (series), yesterday's game at 7:15 PM PT has UTC time `T02:15Z` of tomorrow's UTC date. The bare fallback key `gameTimes["mlb:LAD"]` was set to the yesterday game's time (first-seen-wins) and never updated. Game totals and team totals didn't use the date-specific key — they only used the bare key. Fix: game totals and team totals now use `gameTimes["sport:team:gameDate"]` first, matching player props. The date-specific key correctly has the today game's time.

**Team page game time**: uses `data.nextGame.gameTime` (from `/api/team`) as the primary source, independent of Kalshi market state. Reliable even when today's market is closed (game in progress or finalized). Falls back to `tonightPlay.gameTime` if `nextGame` is null.

### "Star (☆/★) not highlighted on player card or team page after navigating from My Picks"
Two separate bugs caused this:

**Player card bug (commit 9452812)**: `_today` was computed as `new Date().toISOString().slice(0,10)` — UTC date. After 5 PM PDT (midnight UTC), `_today` becomes tomorrow's UTC date while picks have today's PT `gameDate` → `pd >= _today` = false → `isTracked = false` → star shows ☆ instead of ★.
**Fix**: compute `_today` using local date: `` `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` ``

**TotalsBarChart bug (commit 9452812)**: Used direct string equality `p.id === trackId` where `trackId` was built from `tp.gameDate`. If `tp` was null (threshold not in `allTonightPlays`) or `tp.gameDate` mismatched the stored pick's `gameDate`, `isTracked` was always false.
**Fix**: Replaced with `existingPick` find pattern — matches by `sport|homeTeam|awayTeam|threshold` with local date guard (`pd >= _localToday`), using `tp ?? tonightPlay` as the anchor. Stores the actual matched pick's `id` in `_untrackId` so untracking works correctly too.

### "MLB game total SimScore badge shows 10/10 despite yellow ERA/RPG stats in explanation"
The explanation card colors (eraColor/rpgColor) use the **tiered** formula — yellow ERA means 1 pt (not max 2), yellow RPG means 1 pt (not max 2). If the badge shows 10/10 when stats are yellow, production is running **old code**. Current formula: `> 4.5 → 2pts, > 3.5 → 1pt, ≤ 3.5 → 0pts` for ERA; `> 5.0 → 2pts, > 4.0 → 1pt, ≤ 4.0 → 0pts` for RPG. Park RF removed from scoring entirely (was previously 2pts for |RF-1|>0.01).

**Diagnosis:** `git log --oneline origin/main..HEAD` — if this shows unpushed commits, Vercel is running the old code. **Fix:** `git push origin main`.

### "NHL game total SimScore badge shows 10/10 despite gray GPG stats in explanation"
The explanation card `gpgColor`/`gaaColor` use the tiered formula — gray GPG means 0 pts (< 3.0), green means 2pts (≥ 3.5), yellow means 1pt (≥ 3.0). Current formula: `≥ 3.5 → 2pts, ≥ 3.0 → 1pt, < 3.0 → 0pts` for both GPG and GAA. O/U tier (max 2pts) replaced SA rank. If badge shows 10/10 for gray stats, check for unpushed commits.

**Diagnosis:** `git log --oneline origin/main..HEAD` — if this shows unpushed commits, Vercel is running the old code. **Fix:** `git push origin main`.

### "SimScore shows yellow for strikeout players with score 5–7"
The qualifying gate for all sports is `finalSimScore >= 8` (Alpha tier). The report SimScore column uses `>= 5` as the yellow threshold, so scores 5–7 show yellow (near miss) and scores < 5 show gray.

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
Kalshi uses "WPH" for the Phoenix Suns (PHX) in their NBA tickers. `TEAM_NORM.nba` only had `PHO→PHX`; "WPH" fell through unchanged. `nbaOffPPGMap["WPH"]` and `nbaDefRank["WPH"]` returned null → `awayOff`/`awayDef` null → `truePct` null → low score.
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
If the first deploy has a bug that produces `polyPctMap = {}` (empty), that empty object gets cached in Redis at `poly:totals:{date}` with 60s TTL. A subsequent correct deploy will still serve the empty cache until it expires. Fix: `?bust=1` skips the `poly:totals:{date}` cache read. Always test the Polymarket block with `?bust=1` after a deploy that changes the Polymarket fetch logic.

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

**Poly-only injection filter**: Uses `polyPct >= 30 && polyPct <= 97` (matching the Kalshi game total filter). Do NOT raise back to 70 — Poly consensus O/U lines are near 50/50, so all game total markets would be excluded.

**"NHL polyPct seems too low compared to Kalshi (e.g., 60% vs 96%)" — stale 1-min cache or outcomePrices lag:**
The `poly:totals:{date}` cache (60s TTL) can hold pre-game prices. `?bust=1` skips it and fetches fresh. Additionally, `outcomePrices` reflects the **last traded price**, which lags live order book during active games (e.g. last trade at 71% when current book is 87%). Fix (commit `aa43334`): the gamma events API market objects include `bestBid` and `bestAsk` fields for the live order book. `polyPct` is now computed as `round(((bestBid + bestAsk) / 2) × 100)` for index-0 (Over) markets; `1 - mid` for index-1 markets. Falls back to `outcomePrices` when bestBid/bestAsk are null. No extra API calls needed — the data is already in the events response. **Do NOT attempt CLOB API (`clob.polymarket.com/midpoints`) from Vercel Edge** — the token IDs from gamma events are numeric (~20-digit) rather than ERC-1155 256-bit hex, and the CLOB API returns 400 "Invalid payload" regardless of request format (GET repeated params, GET comma-separated, POST JSON body). Regular season live NHL Poly prices for O4.5 typically range 74–87%. **During NHL playoffs, Poly prices for O4.5 are structurally lower (~52–56%)** — tighter defense and lower expected scoring make this reasonable, but our model uses regular season GPG/GAA data and scores ~85% truePct, creating apparent 25–30% edges. These edges may not be real if the model overstates playoff scoring.

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

### Strikeout SimScore component calibration history

SimScore thresholds have been tuned against settled pick outcomes. When win rates diverge from model predictions, the analysis steps are:

1. Pull settled picks via `/api/user/picks` (requires auth token from login)
2. Group by component value and compute actual win rate per tier
3. If a middle tier shows win rate < 70%, tighten it or eliminate it — a 61% win-rate tier scoring 2pts is giving too much credit
4. If win rate doesn't track the O/U line boundary assumed by scoring, move the cliff

**Calibration results (46 settled strikeout picks, April 2026) — informed Apr 2026 SimScore refactor:**

| Component | Original | After recal. | Current (post-refactor) | Rationale |
|---|---|---|---|---|
| `kpctPts` (CSW%/K%) | 3/2/1pts | 3/2/1pts | 2/1/0pts (rescaled) | Apr 2026 refactor: max-10 system; top tier was over-valued (62% win rate vs 88% for mid tier) |
| `lkpPts` (lineup oK%) | >24%→3, >16%→2, ≤16%→0 | >24%→3, >22%→2, ≤22%→0 | >24%→2, >22%→1, ≤22%→0 (rescaled) | Middle tier threshold raised to 22%; rescaled to max 2pts in refactor |
| `totalPts` (O/U tier) | ≤8.5→2, ≤10.5→1, >10.5→0 | ≤7.5→2, <10.5→1, ≥10.5→0 | ≤7.5→2, <10.5→1, ≥10.5→0 (unchanged) | Moved 2pt cliff from 8.5 → 7.5; max 2pts unchanged |
| `blendedHitRatePts` | (new) | (new) | ≥90%→2, ≥80%→1, <80%→0 | Replaces pitchesPts + kTrendPts; trust-weighted 2026/2025 observed hit rate |

**Calibration results (15 settled HRR picks, April 2026) — historical (pre-refactor):**

| Component | Previous | Status |
|---|---|---|
| `hitterPlatoonPts` (platoon advantage) | ≥1.08→2pts, ≥0.95→1pt, <0.95→0pts | Removed from SimScore in Apr 2026 refactor (still computed + displayed in prose) |

**Other patterns noted:**
- `historicalHitRate` < 65% with large model gap (e.g. Hancock: 14.3% hist vs 89.8% model) correlated with losses — now partly addressed by `blendedHitRatePts` and `hitterSeasonHitRatePts`
- When adding new SimScore components, run this analysis after 40+ settled picks; small samples produce misleading tier win rates

### "MLB totals market report shows only 2 games (fixed eb21787)"
**Root cause**: Poly-only injection had `polyPct < 70` filter (copied from player prop path). Poly O/U game total markets are priced near 50/50 by design — the line is set at consensus. Every MLB, NBA, and NHL Poly market was always below 70%, so the injection loop silently skipped every Poly-only game. Zero games were ever added from Poly when Kalshi had no market for them.

**Fix**: Changed `polyPct < 70` to `polyPct < 30` in the injection filter (`api/[...path].js` line ~3335), matching the Kalshi game total filter range (30–97%). The edge gate (`bestEdge >= 5%`) still filters out plays with no real model edge.

**Symptom**: Market report shows only Kalshi-published totals (may be 0–2 games for MLB early in the day). `?debug=1&bust=1` → `totalMarketsCount` matches only Kalshi rows, no `polyOnly:true` entries anywhere in plays/dropped.

**How to diagnose**: Check `polyDerivedMap` behavior — if `polyDerived:true` appears on a Kalshi total row but no `polyOnly:true` rows exist, `polyPctMap` has MLB entries but injection is being filtered. Confirm by checking the injection filter at line ~3335.

### "Strikeout player card K-trend prose is silent even though kTrendPts shows in tooltip"
**Root cause**: The player card builds its `h2h` object from `tonightPlayerMap` entries, but `pitcherRecentKPct` and `pitcherSeasonKPct` were not included in that object — only `kTrendPts` was. So `recK = h2h?.pitcherRecentKPct` was always null and the prose branch silently skipped.

**Fix**: Added `pitcherRecentKPct: tp.pitcherRecentKPct, pitcherSeasonKPct: tp.pitcherSeasonKPct` to the `h2h` object construction in the player card strikeout block (`index.html` ~line 2747). The K-trend prose renders `26.9% recent K% ↑ (24.1% season)` colored by `kTrendPts` tier.

### "SimScore tooltip shows — for Lineup K% even though prose shows a value"
**Root cause**: `lkpPts` is null when lineup wasn't confirmed at API run time (model counts this as 1pt abstain). The prose uses `h2h.lineupKPct` which may be filled from the DVP fallback, so the value appears in prose. But the tooltip used `h2h?.lkpPts ?? "—"` — null became `—` instead of showing the abstain point value.

**Fix**: Tooltip now uses `h2h?.lkpPts ?? 1` (and same for `blendedHitRatePts`), showing `1/2` to reflect the abstain scoring rather than `—`. Applied to both player card and play card `scTitle` strings.

**Same issue in market report SimScore tooltip**: the `xcell k==="sim"` block in `index.html` has its own tooltip string — separate from the player/play card `scTitle`. All null-abstain components use `?? 1` there too: strikeouts (`kbbPts`, `lkpPts`, `blendedHitRatePts`, `totalPts`) and HRR (`hitterBatterQualityPts`, `hitterWhipPts`, `hitterSeasonHitRatePts`, `hitterH2HHitRatePts`, `hitterTotalPts`).

### "Platoon column shows — in market report for players with low 2026 AB count"
`hitterSplitBA` is null when the player has < 20 combined AB vs that pitcher hand across 2025+2026. `batterSplitBA` is built in `buildLineupKPct` (`api/lib/mlb.js`) by fetching `statSplits` for both 2026 and 2025 in parallel, then summing raw AB/H before computing BA. Minimum: 20 combined AB (same as `hitterBa` floor). Previously 2026-only with 30 AB minimum — most early-season players failed this gate.

**Remaining null cases** (< 20 combined AB vs one hand): platoon-heavy bench players or genuinely hand-neutral players who face very few pitchers of one handedness across two seasons. `hitterPlatoonPts` stays null → SimScore counts 1pt abstain via `?? 1`.

### "NHL SimScore tooltip shows Edge ±X% instead of Team GPG"
**Root cause**: Before commit removing the edge bonus from NHL SimScore, the 6th component was `Edge ±X%: N/3`. After converting to `nhlTeamGPG`, the tooltip still showed the old label if `index.html` was cached.

**Fix**: Hard-refresh (`Cmd+Shift+R`) — the tooltip is computed client-side in `index.html`. If production still shows old label, check if `nhlTeamGPG` is present in play output (`?debug=1` → any NHL play → `nhlTeamGPG` field). If null, the backend variable wasn't added to the plays push.
