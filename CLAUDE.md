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
- `/api/gamelog` — ESPN player gamelog (GET `?sport=basketball/nba&athleteId=X&season=2026`); uses ESPN JSON API (`site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog`) for all sports including NBA/NHL — **not** the HTML page scraper (ESPN now blocks server-side page fetches with AWS WAF). MLB uses same JSON API endpoint. Response: `{labels, events:[{eventId, stats, date, oppAbbr, isHome}], totalGames}`
- `/api/dvp` — Defense vs Position data
- `/api/nba-depth` — NBA depth chart from ESPN
- `/api/keepalive` — cron ping (daily)
- `/api/dvp/debug-dc` — inspect depth chart cache
- `/api/auth/register` — create account (POST `{email, password}`)
- `/api/auth/login` — login (POST `{email, password}`) → `{token, userId, email}`
- `/api/auth/reset` — admin password reset (POST `{email, newPassword, adminKey}`)
- `/api/auth/list-users` — list all user keys in Redis (GET `?adminKey=`)
- `/api/auth/debug-redis` — raw Upstash SET+GET diagnostic (GET `?adminKey=`) — returns `{setStatus, setRaw, getStatus, getRaw, match}` to confirm Redis is writable
- `/api/auth/calibration` — outcome calibration stats (GET) — reads all users' finalized picks (result: won/lost), returns:
  - `overall` — all-sport truePct bucket breakdown: `[{bucket, predicted, actual, n, delta}]` (6 buckets: 70-75, 75-80, 80-85, 85-90, 90-95, 95+)
  - `byCategory` — per `sport|stat` aggregate: `{sport|stat: {hitRate, n}}`
  - `byCategoryDetail` — per `sport|stat` truePct bucket breakdown: `{sport|stat: [{bucket, predicted, actual, n, delta}]}` — same 6 buckets as `overall`, filtered to that category. Used by `CalibModule` in `ModelPage` to show per-tab calibration curves.
  - `kStrikeouts` — MLB K-specific feature breakdowns: `{bySimScore, byKpctPts, byKTrendPts, byStdBF, n}`. `byStdBF` buckets: `none` (stdBF=0, <3 starts), `low` (≤2.5), `high` (>2.5 — will be empty going forward after gate added in commit 567b6b8).
  - Auth: `Authorization: Bearer <jwt>` (any logged-in user) OR `?adminKey=<ADMIN_KEY>` (curl/debug — do not hardcode in frontend)
- `/api/user/picks` — GET/POST user picks (requires `Authorization: Bearer <token>`)
- `/api/team` — team page data (GET `?abbr=LAD&sport=mlb`) → `{teamAbbr, teamName, sport, record, wins, losses, gameLog, seasonStats:{avgTotal,gamesPlayed}, lineup, lineupConfirmed}`; cached `team:v3:{sport}:{abbr}:{today}` at 3600s TTL; `gameLog` entries: `{date, isHome, opp, teamScore, oppScore, total, result:"W"|"L"}`; lineup: NBA three-source fallback chain (see below), MLB two-source fallback chain: (1) MLB Stats API schedule `hydrate=lineups,probables` (PT date `Date.now()-7h`), confirmed lineup + probable SP → `{spot, name, position, playerId, isProbable?}`; (2) MLB Stats API active roster fallback when schedule returns no lineup/probable — non-pitcher position players up to 12, `spot:null`, `lineupConfirmed:false`

### Frontend: Vite + React (`src/`)
Built with Vite + `@vitejs/plugin-react`. Entry point is `index.html` → `src/main.jsx` → `src/App.jsx`. Output goes to `dist/` (built by Vercel on deploy via `npm run build`).

**Source layout:**
- `src/main.jsx` — ReactDOM root mount
- `src/App.jsx` — top-level state, routing, data fetching, player card
- `src/index.css` — global styles (body background, grid, gamelog tooltip CSS)
- `src/lib/constants.js` — `WORKER`, `SPORTS`, `STAT_FULL`, `MLB_TEAM`, `TEAM_DB`, `TOTAL_THRESHOLDS`, `STAT_LABEL`, `SPORT_KEY`, `TODAY`, `MOCK_PLAYS`, `SPORT_BADGE_COLOR`, `GAMELOG_COLS`
- `src/lib/utils.js` — `lsGet`, `lsSet`, `ordinal`, `slugify`, `teamUrl`
- `src/lib/colors.js` — `getColor`, `matchupColor`, `tierColor`
- `src/components/TotalsBarChart.jsx` — bar chart shown on team page
- `src/components/TeamPage.jsx` — team page; also exports `STAT_CONFIGS`
- `src/components/DayBar.jsx` — P&L bar chart in My Picks
- `src/components/AddPickModal.jsx` — manual pick entry modal; also exports `useDebounce`
- `src/components/ModelPage.jsx` — Model Reference page with calibration
- `src/components/MarketReport.jsx` — full market report overlay
- `src/components/LineupsPage.jsx` — homepage tab layout (MLB/NBA/NHL/My Picks tabs); `buildGames()` groups `allTonightPlays` by sorted team pair + gameDate, anchors home/away from total plays; for MLB also seeds game entries from `mlbMeta.gameScores` so finished games (whose Kalshi markets have settled) remain visible with scores; date section headers ("TODAY" / "TOMORROW" / "Mon, Apr 28") group by `gameTime` PT date (not `gameDate`) to avoid Kalshi's market-open date incorrectly placing tomorrow's games under "Today"; **two-section layout**: matchup cards grid first (responsive `minmax(480px,1fr)`), then qualified play cards below via `PlaysColumn` with `hideHeader=true`/`gridColumns=2`; plays already in My Picks are shown in the play cards section with a ★ star (not hidden); date group header inside `PlaysColumn` is suppressed when `hideHeader=true` and only one date exists, avoiding a duplicate "Today" label
- `src/components/MatchupCard.jsx` — per-game card: team logos, center stats, MLB pitcher row (from `mlbMeta`/`mlbMetaTomorrow`), MLB umpire + weather row, NBA/MLB lineup in collapsible drawer (lazy-fetched on first open); NBA injury badges (OUT red / GTD yellow) from `nbaMeta.injuries` always visible outside the drawer (two-column, home right-aligned); home team lineup right-aligned inside drawer to mirror header layout. **Center header** is state-aware: `pre` → game time + O/U + ML + spread; `in` → score (`awayScore – homeScore`) + inning/status in yellow; `post` → score + "Final" in gray. Score data comes from `game.gameState/gameDetail/homeScore/awayScore` (seeded by `mlbMeta.gameScores` via `buildGames`). **No play badge logic** — play cards are handled by `PlaysColumn` below the matchup grid. Props: `{ game, mlbMeta, mlbMetaTomorrow, nbaMeta, navigateToPlayer, navigateToTeam }`. **Date-aware meta selection**: `activeMlbMeta = isToday ? mlbMeta : mlbMetaTomorrow` — prevents today's confirmed starters from bleeding onto tomorrow's cards. **Lineup confirmed/expected badge** hidden when `gameState === 'in' || gameState === 'post'` (game in progress or finished).
- `src/components/PlaysColumn.jsx` — play cards list with date grouping; supports `hideHeader` prop (omits title/filter/bust header) and `gridColumns` prop (renders plays in an N-column CSS grid using `display:contents` on per-date wrappers and `gridColumn:1/-1` on date headers); `sportFilter`/`statFilter` default to `[]` so the component works without those props
- `src/components/MyPicksColumn.jsx` — right column (P&L, pick cards)

**Dev proxy:** `vite.config.js` proxies `/api` to production (`https://scoreboard-ivory-xi.vercel.app`) so `npm run dev` works without a local backend.

### Storage: Upstash Redis (`CACHE2`)
On Vercel, `env.CACHE` (Cloudflare KV binding) is unavailable — `makeCache()` falls through to the Upstash Redis REST client using `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` env vars. The Upstash free tier caps at **500k commands/month** — when exceeded, all reads/writes silently return null (Upstash returns HTTP 400 `{"error":"ERR max requests limit exceeded..."}` but the `cmd()` wrapper only extracts `result`, so errors are invisible). Use `/api/auth/debug-redis?adminKey=` to confirm Redis is writable. If the limit is hit: create a new free Upstash database or upgrade to Pay-As-You-Go in the Upstash console, then update `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Vercel Environment Variables.

User auth data (`user:{email}`) and picks (`picks:{userId}`) are stored in the same Redis instance. JWT tokens expire after **365 days**. Picks are also kept in `localStorage` as a live backup — if server returns 0 picks on load but localStorage has data, the frontend restores from local and pushes it back to the server.

Used for caching expensive fetches. Key TTLs:
- `byteam:mlb` — 600s (MLB team stats, probables, lineup K-rates). **Does NOT include `barrelPctMap`** — that lives in `mlb:barrelPct`. Uses 60s TTL if lineupSpotByName or pitcherAvgPitches come back empty (e.g. bust before lineups confirmed), so next request retries quickly.
- `byteam:nba` — 1800s (defensive stats)
- `byteam:nba:scoring` — 21600s (6h, NBA team offensive PPG; used for total simulation)
- `kalshi:bundle:{date}` — 90s (all 18 Kalshi series responses cached as one JSON blob; avoids making any Kalshi calls on cache-hit requests; bypassed by `?bust=1`). `kalshi:stale:{ticker}` — no TTL (stale-while-revalidate fallback per-ticker; used when Kalshi returns 429 or empty).
- `nba:injuries:{date}` — 1800s (ESPN NBA injury report: Out + GTD players per team; abbr from `inj.athlete.team.abbreviation`; short-codes normalized GS→GSW, NO→NOP, SA→SAS before caching)
- `byteam:nfl` — 1800s
- `byteam:nhl` — 21600s (6h, NHL team stats: goalsAgainstPerGame + shotsAgainstPerGame). `NHL_ABBR_MAP` in `api/[...path].js` maps NHL Stats API teamIds → abbreviations; **UTA (Utah Mammoth) = teamId 68** (rebranded from Utah Hockey Club for 2025-26; old teamId 53 absent from 2025-26 API). If a new team's GPG/GAA/SA shows as `—`, check their teamId in the API and add it to `NHL_ABBR_MAP`.
- `gameTimes:v2:{date}` — 600s. Stores both `"sport:team:ptDate"` (PT-date-specific) and `"sport:team"` (bare fallback, first seen wins) keys. Built from **yesterday + today + tomorrow's** ESPN scoreboard (fetched in parallel) so late-night PT games whose UTC date is already tomorrow are captured. Play loop looks up `sport:team:gameDate` first, then `sport:team:tomorrowISOStr` (handles Kalshi encoding tomorrow's games under today's event ticker date), then bare key.
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
- **UNDER plays**: `underEdge = (100-truePct) - (100-kalshiPct) >= 5%` → `direction: "under"`, play object has `noTruePct` (UNDER model prob) and `noKalshiPct` (Kalshi NO price); `americanOdds` already set to NO-side odds. Play card badge shows red "Under X.X"; bars use `noTruePct`/`noKalshiPct`; prose colors inverted (low ERA/RPG = green for MLB under, etc.). Track ID: `total|sport|homeTeam|awayTeam|threshold|gameDate|under`. **Gate**: `noKalshiPct >= 70%` (i.e. Kalshi YES ≤ 30%) — mirrors the OVER filter; only qualifies UNDERs the market also considers likely. Debug drops with `reason: "under_no_price_too_low"`.
- **Deduplication**: one qualified play per game (homeTeam+awayTeam+sport) — best edge wins across OVER AND UNDER directions AND across game totals vs team totals. If a game total and a team total both qualify for the same game, only the highest-edge play shows as `qualified: true`. Non-winners pushed as `qualified: false` for report visibility.
- **Edge gate**: `edge >= 5%` (both directions); no soft matchup gate for totals
- **SimScore** (max 10): 5 stats × 2pts each; `qualified: totalSimScore >= 8`. OVER and UNDER use separate `totalSimScore`/`underSimScore` (inverted tiers for under).
- **Data maps** (`mlbRPGMap`, `nhlGPGMap/GAAMap`, `nbaOffPPGMap`) computed inline after `leagueAvgCache` block
- **Play card**: `gameType: "total"` triggers `TotalPlayCard` branch; dual team logos, matchup header, truePct/Kalshi bars, explanation prose, SimScore badge. UNDER plays shown in red badge, bars use no-side probabilities.
- **Expected total**: `homeExpected + awayExpected` (lambda sum for MLB/NHL, possession-based for NBA) shown in explanation prose; `_simData` includes `homeExpected`, `awayExpected`, `expectedTotal`, `gameOuLine`; NBA also includes `homeOffRtg`, `awayOffRtg`, `homeDefRtg`, `awayDefRtg`, `homePace`, `awayPace`, `leagueAvgPace`, `projPace`, `homeOut`, `awayOut`
- **SimScore tooltip**: hover the `X/10` badge to see per-component breakdown with actual values. NBA totals example: `Pace (proj 100.2): 2/2`, `GSW OffRtg (118.5): 2/2`, `Injuries (0 out): 2/2`. NHL totals example: `LAK GPG (2.7): 1/2`, `CGY GAA (3.15): 1/2`.
- **Edge badge**: shows `+X%` only
- **Track ID format**: OVER: `total|sport|homeTeam|awayTeam|threshold|gameDate` · UNDER: same + `|under`

### Team Totals (MLB, NBA)
- **Stat**: `teamRuns` (MLB), `teamPoints` (NBA)
- **Kalshi series**: `KXMLBTEAMTOTAL`, `KXNBATEAMTOTAL` — `gameType: "teamTotal"` in SERIES_CONFIG. NHL/NFL team total series do not exist on Kalshi.
- **Scoring team extraction**: Ticker suffix after last `-` starts with the team abbreviation (e.g. `LAD8` → scoring team `LAD`). Game teams extracted via existing `parseGameTeams()`.
- **True%**: Monte Carlo simulation — `simulateTeamTotalDist(lambda)` (Poisson, MLB) or `simulateTeamPtsDist(mean, std=11)` (Normal, NBA) in `api/lib/simulate.js`.
  - MLB lambda: `teamRPG × (oppERA / 4.20) × parkRF`, clamped [0.5, 12]
  - NBA mean: `teamOffPPG × (oppDefPPG / leagueAvgDef)`
- **OVER plays**: `edge = truePct - kalshiPct >= 5%` → `direction: "over"`, uses `truePct`/`kalshiPct`. **UNDER plays**: `underEdge = (100-truePct) - (100-kalshiPct) >= 5%` AND `noKalshiPct >= 70` → `direction: "under"`, play has `noTruePct`/`noKalshiPct`/`americanOdds` (NO-side). Badge: red "Under X.X"; bars use no-side probs; prose colors inverted. Track ID appends `|under`. `reason: "under_no_price_too_low"` when Kalshi YES > 30%.
- **SimScore** (max 10 — 5 stats × 2pts each; `qualified: teamTotalSimScore >= 8`):
  - MLB OVER: umpireRunFactor (≥1.05→2, ≥0.97→1, else 0, null→1), oppWHIP (>1.35→2, >1.20→1, ≤1.20→0, null→1), teamL10RPG (>5.0→2, >4.0→1, ≤4.0→0, null→1), H2H HR% (≥80%→2, ≥60%→1, <60%→0, null→1), O/U (≥9.5→2, ≥7.5→1, <7.5→0)
  - MLB UNDER (inverted): umpireRunFactor (≤0.95→2, ≤1.03→1), oppWHIP (≤1.10→2, ≤1.25→1, >1.25→0), teamL10RPG (≤3.5→2, ≤4.5→1, >4.5→0), H2H HR% (≤30%→2, ≤50%→1, >50%→0), O/U (<7.5→2, <9.5→1, ≥9.5→0)
  - NBA OVER: teamOffPPG (≥118→2, ≥113→1, else 0), oppDefPPG (≥118→2, ≥113→1, else 0), O/U (≥225→2, ≥215→1), teamPace (>lgPace+2→2, >lgPace-2→1), H2H HR% (≥80%→2, ≥60%→1, <60%→0, null→1)
  - NBA UNDER (inverted): teamOffPPG (<113→2, <118→1), oppDefPPG (<113→2, <118→1), O/U (<225→2, <235→1), teamPace (≤lgPace−2→2, ≤lgPace+2→1), H2H HR% (≤30%→2, ≤50%→1, >50%→0)
- **H2H HR%**: scoring team's hit rate (scored ≥ threshold) in last 10 H2H games vs opponent. Fetched from ESPN team schedule (`site.api.espn.com/.../teams/{abbr}/schedule`), cached `teamschedule:v2:{sport}:{abbr}` at 3600s TTL. Requires ≥3 H2H games; null = 1pt abstain. `isBust` clears this cache. MLB replaces oppRPG; NBA replaces spread.
- **Play card**: `gameType: "teamTotal"` branch — single scoring team logo (44px), "{TEAM} vs {OPP}" header, prose shows teamRPG/oppERA for MLB or teamOff/oppDef for NBA, SimScore badge inline. UNDER plays: red badge, inverted prose colors (low ERA/RPG = green), H2H prose flipped ("stayed under X% of meetings")
- **Deduplication**: one play per `sport|scoringTeam|oppTeam`, best edge wins across OVER and UNDER directions
- **Track ID format**: OVER: `teamtotal|sport|scoringTeam|oppTeam|threshold|gameDate` · UNDER: same + `|under`
- **`umpireRunFactor`** stored in all team total play/drop objects (alongside `ttUmpirePts`) so market report tooltip can correctly invert pts for UNDER plays

#### Total SimScore details (max 10 — 5 stats × 2pts each; `qualified: totalSimScore >= 8`)
- **MLB**: homeERA tiered (>4.5→2, >3.5→1, ≤3.5→0, null→1), awayERA (same), combinedRPG (road homeRPG+awayRPG; ≥10.5→2, ≥9.0→1, <9.0→0, null→1), umpireRunFactor (1/UMPIRE_KFACTOR; ≥1.05→2, ≥0.97→1, <0.97→0, null→1), O/U line tiered (≥9.5→2, ≥7.5→1, <7.5→0, null→1). **Road RPG** from MLB Stats API `sitCodes=A` (stored as `mlbRoadRPGMap`). **60/40 ERA blend**: `0.6×(starterERA/4.20)+0.4×(teamERA/4.20)` where teamERA from ESPN pitching byteam (stored as `mlbTeamERAMap`) acts as bullpen proxy and regresses small-sample starters toward team reality. UNDER inverted: ERA ≤3.5→2, ≤4.5→1; combinedRPG ≤8.5→2, ≤10.0→1; umpireRunFactor ≤0.95→2, ≤1.03→1.
- **NBA**: 5 independent validators — combined pace (both>lgAvg+2→2, one>lgAvg→1, else→0, null→1), homeOffRtg tiered (≥118→2, ≥113→1, <113→0, null→1), awayOffRtg (same), combined injuries `homeOut+awayOut` (0→2, 1-2→1, 3+→0, null→1), O/U line (≥225→2, ≥215→1, <215→0, null→1). UNDER inverted: pace (both<lgAvg-2→2, one<lgAvg→1), OffRtg (<113→2, <118→1), injuries (3+→2, 1-2→1, 0→0), O/U (<215→2, <225→1). `homeOut`/`awayOut` from `nbaInjuryMap` in `_simData`, available in play card and market report.
- **NHL**: homeGPG tiered (≥3.5→2, ≥3.0→1, <3.0→0, null→1), awayGPG (same), homeGAA tiered (≥3.5→2, ≥3.0→1, <3.0→0, null→1), awayGAA (same), O/U line tiered (≥7→2, ≥5.5→1, <5.5→0, null→1). ESPN NHL scoreboard fetched for odds via `sportByteam.nhlGameOdds` (normalized via TEAM_NORM.nhl).

#### Lambda computation (MLB)
`awayMult = 0.6×(awayERA/4.20) + 0.4×(awayTeamERA/4.20)` (away staff vs home offense)
`homeMult = 0.6×(homeERA/4.20) + 0.4×(homeTeamERA/4.20)` (home staff vs away offense)
`homeLambda = homeRoadRPG × awayMult × parkRF × homePlatoonFactor × weatherFactor`, clamped [1, 12]
`awayLambda = awayRoadRPG × homeMult × parkRF × awayPlatoonFactor × weatherFactor`, clamped [1, 12]

**Platoon factor** (`homePlatoonFactor`/`awayPlatoonFactor`): adjusts each team's offensive baseline for the opposing starter's handedness. `platoonFactor = (lineup composite BA vs starter's hand) / (lineup composite overall BA)` — a dimensionless ratio derived from `batterSplitBA` (individual batter vsL/vsR splits from `buildLineupKPct`). Falls back to 1.0 when starter hand is unknown or lineup sample < 80 AB. MLB Stats API `/teams/stats` does **not** support pitcher handedness sitCodes (`sitCodes=vl/vr` returns empty) — only situation splits (A/H) work at the team level; handedness splits are individual-player-only. Same platoon factor applied to team totals lambda. Debug output includes `homeStarterHand`, `awayStarterHand`, `homePlatoonFactor` (omitted when 1.0), `awayPlatoonFactor` (omitted when 1.0).

**Weather factor** (`weatherFactor`): `1 + windOutMph × 0.013 + (tempF − 72) × 0.001`, clamped [0.85, 1.15]. Applied to both lambdas (and team total lambda). `windOutMph` parsed from ESPN scoreboard `displayValue` string: "Out to LF/CF/RF" → positive (more scoring), "In from CF/RF/LF" → negative (fewer runs), "L to R" / "R to L" → 0 (crosswind). Skipped for domed stadiums (`_MLB_DOMED`: TB/TOR/HOU/MIA/SEA/ARI/TEX/MIL). Falls back to 1.0 when no weather data. Stored in `_simData` as `weatherFactor` + `windOutMph` when non-1.0. Weather refreshed independently when gameTimes are cached but weather cache is stale. MatchupCard shows "14 mph Out" (green) / "8 mph In" (red) / "↔" (crosswind, gray).

#### Lambda computation (NHL)
`homeLambda = homeGPG × (awayGAA / leagueAvgGAA)`, clamped [0.5, 8]
`awayLambda = awayGPG × (homeGAA / leagueAvgGAA)`, clamped [0.5, 8]

#### Possession-based projection (NBA)
`projPace = (homePace × awayPace) / leagueAvgPace` (geometric mean — captures compounding of two extreme-pace teams)
`homeExpected = (homeOffRtg × awayDefRtg / leagueAvgOffRtg²) × projPace`
`awayExpected = (awayOffRtg × homeDefRtg / leagueAvgOffRtg²) × projPace`

OffRtg/DefRtg = pts per 100 possessions; extracted from same ESPN team stats API call as pace (`offensiveRating` + `defensiveRating` stat names). Fallback to old PPG formula when OffRtg not yet cached. `teamOffRtg`, `teamDefRtg`, `leagueAvgOffRtg`, `leagueAvgDefRtg` stored in `nba:pace:2526` (12h TTL).

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
- **Gates**: (1) threshold sanity gate — drops as `"threshold_too_high"` (qualified:false) when `threshold > ceil(expectedKs) + 2` (only when lineup confirmed and expectedKs is available); (2) finalSimScore ≥ 8 to qualify as a play (< 8 = qualified:false, shows in report but not plays card); (3) insufficient_starts gate: if `hasAnchor !== true` requires `gs26 ≥ 8`; if `hasAnchor === true` passes through regardless. Catches TJ-return / pure-reliever pitchers (e.g. Detmers with 0 2025 GS). **Important**: insufficient_starts checked in BOTH pre-filter loop AND main play loop. Main loop gate at `api/[...path].js` ~line 1713 uses corrected `playerTeam`; in debug mode pushes to `dropped[]` with reason `"insufficient_starts"`; (4) **stdBF variance gate** — `_stdBF > 2.5` drops as `"high_bf_variance"` (qualified:false). `_stdBF === 0` (fewer than 3 qualified starts, no std dev computable) passes through. Excludes high-variance arms whose BF-per-start spread widens the K-total distribution enough to undermine simulation confidence.
- `pitcherHasAnchor`: `true` if gs25 ≥ 5 AND bf25 ≥ 100 (reliable 2025 *starter* anchor). Included in `plays[]` output for debugging. A reliever-turned-starter has bf25 > 0 but gs25 = 0 — reliever K% is not a valid anchor. bf25 ≥ 100 also excludes injury-shortened seasons (e.g. TJ recovery with 5 starts but minimal workload).
- Pitchers fetched via `buildPitcherKPct(mlbSched)` — avg pitches per start from 2026 gamelog (starts-only filtered via `gamesStarted > 0`); falls back to 2025 season aggregate `numberOfPitches / gamesStarted` when no 2026 start data in gamelog
- **K% regression**: `trust = min(1.0, bf26 / 200)` — uses 2026 BF only (NOT combined 2026+2025). Full trust at ~33 starts. Blends 2026 actual K% with 2025 anchor (or league avg 22.2% if no 2025 data). KBB% regressed the same way.
- **A1 — Pitcher recent form**: `_recentKPct` from last 5 starts with ≥3 starts and 30+ total BF. Effective K% = `recentKPct × 0.6 + seasonKPct × 0.4` when recent data meets the threshold; else uses season K% only. `pitcherRecentKPct` map exported from `buildPitcherKPct`, keyed by team abbr. **A1 uses a separate `a1Splits` filter** (any completed start, `date !== today`, no NP minimum) — unlike `startSplits` which requires NP ≥ 30 to protect `avgPitches` from in-progress data. This allows pitch-count-limited starts (e.g. NP 25 on a strict limit after returning from injury) to count toward the recent K% window; the `r5BF >= 30` aggregate gate still ensures a meaningful sample before trusting the percentage.
- **A2 — Pitcher rest/fatigue**: After truePct is computed, a fatigue multiplier is applied to the simulated pitcherKPct before re-querying the distribution. Days since last start ≤ 3 → `× 0.96`; days ≤ 3 AND last start pitch count ≥ 95 → `× 0.92` (short rest + heavy workload). `pitcherLastStartDate` and `pitcherLastStartPC` maps exported from `buildPitcherKPct`, keyed by team abbr.
- **E3a — Umpire K% adjustment**: `UMPIRE_KFACTOR` constant in `api/lib/simulate.js` maps ~50 active umpires to normalized K-rate factors (league avg = 1.0; range ≈ 0.89–1.12). Home plate umpire fetched from MLB Stats API via `hydrate=officials` on the schedule request; extracted into `umpireByGame["homeAbbr|awayAbbr"]` in `buildPitcherKPct` (mlb.js). In the play loop, factor is applied to `pitcherKPctOut` before simulation: `_pitcherKPctAdj = min(40, pitcherKPctOut × _umpireKFactor)`. Name lookup is ASCII-normalized to handle diacritics. Unknown umpires default to 1.0. `umpireName` and `umpireKFactor` (when ≠ 1.0) included in play output.
- **E3b — Expected batters faced**: `_expectedBF = clamp(round(_avgBF), 15, 27)` using the pitcher's empirical avg batters faced per start. `_avgBF` priority chain: (1) `_ps.avgBF` from `pitcherStatsByName` (name-based), (2) `_pt(sportByteam.mlb?.pitcherAvgBF, "avgBF")` team-key map. Both computed in `buildPitcherKPct` from `startSplits` per-game `battersFaced` (same NP≥30 filter as avgPitches): `totalBF / startSplits.length`, falling back to 2026 season aggregate `bf/gs`, then 2025 `bf/gs`. When `_avgBF` is null (MLB Stats API returns empty for that pitcher), falls back to `clamp(round(_avgP / 3.85), 15, 27)`. Default: 24. Captures pitch-efficiency variance: high-walk/deep-count pitchers (e.g. Springs −5 BF) get lower expectedBF than the league constant implies. `pitcherAvgBF` exported from `buildPitcherKPct` and stored in `sportByteam.mlb`. `expectedBF` included in all K play/drop output when ≠ 24.
- **TTO Decay** (commit 011da15): Inside `simulateKsDist`, K% for BF 19+ is multiplied by `TTO_DECAY_FACTOR = 0.88` (league-average ~12% drop on 3rd pass through order due to batter familiarity). Applied at PA level inside the MC loop — no array allocation, no signature-visible constant at callsite. Effect: −0.15 to −0.25 projected Ks for workhorses with avgBF ≥ 22; negligible for pitchers clipped at ≤ 18 BF.
- **Blowout Hook** (commit 011da15): `_earlyExitProb` derived from pitcher team ML — `+150→8%, +200→12%, +250+→18%`. Each trial independently rolls whether the pitcher is "pulled early" (BF = rand[10,15]). Uses `bf >= trialPA` break on precomputed `paArr` — no per-trial array allocation. `earlyExitProb` included in play output (omitted when 0). ML source: `sportByteam.mlb.gameOdds[playerTeam].moneyline`.
- **stdBF Variance** (commit c304c28): `buildPitcherKPct` exports `pitcherStdBF` (single-pass sum-of-squares over NP≥30 `startSplits`, requires ≥3 starts — 0 otherwise). `simulateKsDist` 7th param `stdBF = 0`: each trial samples `trialPA ~ Normal(totalPA, stdBF)` clamped [10,27] via scoped Box-Muller with cached spare Z1 (halves log+cos calls; function-scoped to prevent cross-request race conditions). Logic hierarchy: blowout hook first → stdBF → deterministic `totalPA`. `stdBF` included in play output when non-zero. Pitchers with <3 qualified starts get `stdBF=0` → no change in behavior.

#### MLB Hitters (hits/hrr) Model
- **`hits` True%**: Monte Carlo simulation (`simulateHits`) using batter BA × pitcher BAA (log5), park-adjusted
- **`hrr` True%**: logit-sigmoid park adjustment applied to blended base rate (no Monte Carlo). `rawMlbPct = (primaryPct + softPct) / 2`; park factor applied via log-odds: `logOddsAdj = logit(rawMlbPct/100) + ln(parkFactor)`; `truePct = sigmoid(logOddsAdj) × 100`. Replaces old direct multiplication (`rawMlbPct × parkFactor`) which could exceed 100% for elite rates at hitter-friendly parks.
  - `primaryPct` = player's 2026 HRR 1+ rate (falls back to 2025+2026 blend, then career)
  - `softPct` = HRR 1+ rate vs tonight's pitcher (H2H gamelog dates, ≥ 5 games) — falls back to **platoon-adjusted rate** when pitcher H2H yields < 5 games: `softPct = primaryPct × (splitBA / seasonBA)` where `splitBA` is batter's BA vs that pitcher's handedness (vsR/vsL from `batterSplitBA`); `softLabel` updates to `"vs RHP"` or `"vs LHP"`. Falls back to team-level rate only when `splitBA` or `seasonBA` is unavailable. `hitterH2HHitRatePts` uses **only** pitcher H2H (no fallback).
  - BA is NOT directly in the formula — it's implicit via the player's historical HRR rate
- **SimScore** (max 10, edge gate only — 5 stats × 2pts each):
  - Batter quality composite (`hitterBatterQualityPts`): spot ≤ 5 = "good spot" (top-5 captures both PA equity and RBI equity — cleanup/5-hole sluggers now included); barrel% ≥ 10% = "good barrel". Both → 2pts, either → 1pt, neither → 0pts, both null → 1pt (abstain). Replaces separate spot/barrel components.
  - Pitcher WHIP tiered (`hitterWhipPts`): > 1.35 → 2pts (green), > 1.20 → 1pt (yellow), ≤ 1.20 → 0pts (red); null → 1pt (abstain). Rescaled from 3/2/1.
  - Season hit rate (`hitterSeasonHitRatePts`): blended 2026/2025 HRR 1+ rate. ≥ 80% → 2pts, ≥ 70% → 1pt, < 70% → 0pts; null → 1pt (abstain). `trust26 = min(1, vals26.length / 30)`.
  - **Matchup Rate** (`hitterH2HHitRatePts`): BvP used only when `_pitcherVals.length >= 12` (~35+ PAs — mature signal); platoon-adjusted rate is the primary path for ~90% of matchups. **BvP path (≥12 games)**: ≥80% hit rate → 2pts (requires ≥8 games; 8–11 caps at 1pt max); ≥70% → 1pt; else → 0pt. **Platoon path** (`_hrrUsingTeamFallback = true`): full `hitterPlatoonPts` scale — advantage (ratio ≥1.08) → 2pts, neutral (≥0.95) → 1pt, disadvantage → 0pts. `MIN_H2H = 12`.
  - O/U total tier: ≥9.5 → 2pts, ≥7.5 → 1pt, <7.5 → 0pts, null → 1pt
  - Max: 2+2+2+2+2 = 10. `hitterPlatoonPts` is the SimScore value for the Matchup Rate component in the platoon path (no longer display-only). Park factor still shown in report env column.
- **B2 — Batter recent form**: `hitterEffectiveBA = 0.3 × recentBA + 0.7 × seasonBA` when ≥20 AB in last 10 2026 games; else uses seasonBA. Weight reduced from 0.6/0.4 — 40 PAs is deep in BABIP noise territory; 0.3/0.7 still captures true slumps/streaks without letting a bad week hijack a season baseline. Fed directly into `simulateHits` as `batterBA`. `batterRecentBA` map built inline from ESPN gamelog in main play loop.
- **Gates**: lineup spot 1–5 required (spots 6–9 dropped); hitterFinalSimScore ≥ 8 (Alpha tier); edge ≥ 5% (gate only, not scored)
- Barrel% from Baseball Savant (`buildBarrelPct`) — cached 6h in KV; `hitterBarrelPts` stored in play output
- NBA game totals fetched from ESPN scoreboard (`sportByteam.nbaGameOdds`) — always fresh (not long-term cached). **Kalshi fallback**: ESPN omits odds for live/imminent games. After ESPN fetch, `kalshiNbaOuMap` (built from all KXNBATOTAL markets, unfiltered pct range) fills any missing entries: for each game, finds the highest threshold where YES ≥ 50% and sets `total = threshold − 0.5`. Applied before all downstream consumers (player prop `nbaTotalPts`, game total `_nbaOuLine`, team totals, `nbaMeta.gameOdds`).
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
    - **C2 — Injury boost**: `1.08` per Out player on the player's own team (teammate absences create usage vacuums; capped at `1.15x`). Out players from `buildNbaInjuryReport` (ESPN NBA injuries endpoint, cached 1800s).
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
  - O/U line (`nbaTotalPts`): ≥ 215 → 2pts; null → 1pt (abstain); < 215 → 0pts. Game totals from `sportByteam.nbaGameOdds`. Pace is still applied to the simulation mean via `buildNbaStatDist` but is no longer scored separately (was redundant with truePct).
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
| `TTO_DECAY_FACTOR` | 0.88 — K% multiplier for BF 19+ (3rd time through order) |
| `simulateKsDist(orderedKPcts, pitcherKPct, parkFactor, nSim, totalPA, earlyExitProb, stdBF)` | Shared Monte Carlo, returns `Int16Array` of K counts; TTO decay at BF≥19; blowout hook via `earlyExitProb`; `stdBF` widens trialPA via scoped Box-Muller |
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
| `buildNbaInjuryReport(cache)` | ESPN NBA injuries → `Map<teamAbbr, [{name, status}]>` (Out + GTD); team abbr from `inj.athlete.team.abbreviation` (NOT outer `teamEntry.team` which doesn't exist); short-codes normalized post-loop; cached 1800s in `nba:injuries:{date}` |

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
- Series tickers in `SERIES_CONFIG` (18 tickers across all sports/stats)
- Filter: `pct >= 70` AND `pct <= 97`
- **Rate limiting mitigation**: all Kalshi fetches are batched, not all-parallel:
  - **Bundle cache**: `kalshi:bundle:{date}` (90s TTL in Redis) stores all 18 series responses as one JSON blob — a cache hit requires zero Kalshi calls. Bypassed by `?bust=1`.
  - **Series batches**: when cache cold, fetches 6 series at a time with 300ms delay between batches. On HTTP 429, falls through to `kalshi:stale:{ticker}` immediately (no retry that would block the function).
  - **Orderbook batches**: thin-market orderbook fetches done 8 at a time with 200ms delay between batches. 429 responses silently skipped.
- Blended fill price via orderbook walk for thin markets
- **Stale-ask fallback**: when `yes_ask >= $0.98` AND `yes_bid == 0` AND `last_price > 0`, use `last_price_dollars` as fill price instead of the stale ask. Handles illiquid markets where market maker has maxed the ask with no real bid — last traded price reflects actual market activity.
- `kalshiSpread` = bid-ask spread in cents (`round((yesAsk − yesBid) × 100)`); kept in output as a liquidity signal (shown as badge when wide)
- `rawEdge = truePct − kalshiPct`; `edge = rawEdge` — `kalshiPct` is already the fill price (ask or blended orderbook walk), so no further spread deduction is applied. `spreadAdj` is computed and stored but not subtracted from edge. This rule applies to **both player props and game totals**.
- Edge badge on play cards shows `+X%` with no tooltip — the old "Raw − spread = net" tooltip was removed since spread is no longer subtracted.
- **E1 — Line movement tracking**: Opening yesAsk stored in KV at `lineOpen:{ticker}:{gameDate}` (TTL 172800s / 2 days) on first encounter. `lineMove = current yesAsk − opening yesAsk` (positive = line moved up / market became more expensive). Shown as badge `▲ Xc` or `▼ Xc` when `|lineMove| ≥ 3`. Included in plays output.
- **E2 — Market depth thresholds**: `lowVolume = kalshiVolume < 50` (raised from 20); `thinMarket = kalshiSpread > 8` (cents, shown as "Wide Spread" badge in red); `marketConfidence = "deep"` (vol≥50 AND spread≤4) / `"moderate"` / `"thin"` (vol<50 OR spread>8). All three fields included in plays output.
- **Polymarket removed (commit afa2c30)**: All Polymarket code deleted from `api/[...path].js` (`POLY_NAME_TO_ABBR`, `POLY_SERIES`, both commented-out blocks, poly fields in play/dropped objects) and `index.html` (price bars, tooltip logic, COL_TIPS entry). Edge gate is Kalshi-only `edge >= 5`. Play objects no longer include `polyPct`, `polyVol`, `polyDerived`, `bestVenue`, `bestEdge`, or `polyOnly`.

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

## Frontend Architecture (`src/`)

### URL Routing
Single-page app uses `history.pushState` + `popstate` for client-side navigation with real URLs:
- `/:ABBR` → team page (e.g. `/LAD`, `/GSW`) — uppercase abbreviation
- `/:ABBR?sport=nhl` → disambiguate multi-sport abbreviations (e.g. `/BOS?sport=nhl` for Bruins vs `/BOS` for Red Sox); `_multiSportAbbrs` Set lists the conflicting ones
- `/:SlugName` → player page (e.g. `/GavinWilliams`) — CamelCase slugification via `slugify(name)` = remove accents + collapse spaces
- `/model` → Model Reference page — static, no API calls
- `vercel.json` `/:slug` rewrite serves `index.html` (Vite build entry) for all single-segment paths so deep links work on cold load
- `resolveSlug(slug, sportOverride)` — on mount, reads `window.location.pathname`; checks literal `"model"` first, then `TEAM_DB`, else stores as `pendingSlug` for async ESPN athlete search
- `navigateToTeam(abbr, sport)` — pushState + `loadTeamPage` + scroll to top
- `navigateToPlayer(p, tab)` — pushState with slugified name + `selectPlayer` + scroll. Accepts player objects without `id` (e.g. pitcher links from MatchupCard); `loadPlayer` resolves the ESPN athlete ID via `/athletes?q={name}` search when `p.id` is missing, then updates the player state with the resolved ID.
- `navigateToModel()` — pushState("/model") + `setModelPage(true)` + clear player/teamPage + scroll to top
- `goBack()` — pushState("/") + clear player/team/modelPage state
- Back button in player card, team page, and model page header calls `goBack()`

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
- **NBA lineup source chain**: (1) ESPN scoreboard → game summary boxscore starters (`/summary?event={gameId}`) — actual starters for today's game, `lineupConfirmed:true`; (2) most recent completed game from **playoff schedule first** (`seasontype=3`), falling back to regular season `lastGameId` only if no playoff games found — boxscore starters, `lineupConfirmed:false`; (3) ESPN team roster (`/teams/{abbr}/roster`) — one player per position group up to 8, `lineupConfirmed:false`. ESPN depth chart (`/teams/{abbr}/depthchart`) removed — returns `{}` during playoffs. ESPN uses non-standard codes in scoreboard/boxscore (NY=NYK, GS=GSW, SA=SAS, NO=NOP) — normalized via `_nbaEspnNorm` map in the team route. **Important**: always prefer playoff schedule over regular season — regular season final games often feature rested/bench starters that don't reflect playoff rotations.
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
- `mlbMeta` — object in `/api/tonight` response: `{ pitchers: {abbr: {name, era}}, gameOdds: {abbr: {ml}}, umpires: {"home|away": name}, weather: {"home|away": {temp, condition, windSpeed, windOutMph}}, projectedLineupTeams: string[], teamsWithLineup: string[] }`. `pitchers` merged from ESPN probables + MLB Stats API pitcherInfoByTeam. `weather` extracted from ESPN scoreboard events and cached separately at `weather:mlb:{date}` (600s TTL); if gameTimes cache hit (weather cache stale), a dedicated MLB scoreboard fetch refreshes it independently. `windOutMph` parsed from ESPN `displayValue` string ("Out to LF" → positive, "In from CF" → negative, crosswind → 0). `projectedLineupTeams` / `teamsWithLineup` drive the ✓ Confirmed / Expected badge in pitcher row without a drawer fetch. Pitcher names and lineup drawer batters link to player page via `navigateToPlayer`; ID resolved by ESPN athlete name search in `loadPlayer` when missing. `DOMED_STADIUMS` constant lists teams with retractable roofs — shows 🏟 Dome instead of weather conditions. **Today-only** — all fields are keyed by team abbr with no date context; do not use for tomorrow's games.
- `mlbMetaTomorrow` — object in `/api/tonight` response: same shape as `mlbMeta` but built from tomorrow's PT-date MLB Stats API schedule (`hydrate=probablePitcher,officials`). `pitchers` has tomorrow's announced probables (name only, `era: null` — ESPN doesn't serve future-game ERA). `umpires` populated if assigned early (usually empty until day-of). `gameOdds`, `weather`, `projectedLineupTeams`, `teamsWithLineup` always empty — not available for future games. Cached at `mlbSchedTomorrow:{tomorrowDateStr}` (600s TTL). `MatchupCard` selects `mlbMetaTomorrow` when `gameDate !== todayPT`.
- `nbaMeta` — object in `/api/tonight` response: `{ gameOdds: {abbr: {ml, total, spread}}, injuries: {abbr: [{name, status}]} }`. `gameOdds` built from `sportByteam.nbaGameOdds` with short-code normalization (GS→GSW etc.). `injuries` from `nbaInjuryMap` (already built for C2 injury boost). Used by `MatchupCard` to populate NBA center header (O/U / ML / spread) and show Out/GTD players always-visible outside the lineup drawer.
- `reportData` — full debug response from `/api/tonight?debug=1`, shown in Market Report overlay
- `player` — currently selected player for detail card
- `teamPage` — currently selected team `{abbr, sport}` for team page
- `teamPageData` — fetched data from `/api/team`
- `pendingSlug` — CamelCase player slug awaiting ESPN athlete search resolution on cold load
- `trackedPlays` — user's saved picks (localStorage or server)

### Market Report
Opened via "report" button. Shows ALL markets (plays + dropped) grouped by sport/stat. Columns vary by sport/stat via `XCOLS` map. Sport tabs: **ALL / MLB / NBA / NHL** (calibration tab removed — calibration now lives on Model Reference page, one module per play tab). Column header tooltips defined in `COL_TIPS` dictionary (keyed by XCOLS `k` value) — hover any column header to see description + color tier thresholds. Totals-specific keys (`homeRPG`, `awayERA`, `homeOff`, `awayDef`, `totalOu`, `homeGPG`, `awayGAA`, etc.) all have entries.
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
  - **NBA totals**: Pace (both>+2→2, one>0→1), Home/Away OffRtg (≥118→2, ≥113→1), Injuries (0→2, 1-2→1, 3+→0), O/U (≥225→2, ≥215→1)
  - **NHL totals**: Home/Away GPG (≥3.5→2, ≥3.0→1, <3.0→0), Home/Away GAA (same), O/U line (≥7→2, ≥5.5→1)
  - Cursor changes to `help` when tooltip is available. Detection: `m.totalSimScore != null` → total play; otherwise sport-specific score fields.
- **Market report column color tiers** — colors match SimScore tiers exactly (yellow = middle tier earns points, gray = earns 1pt but lowest tier, red = 0pts):
  - `lkp`: >24% green, >22% yellow, ≤22% red
  - `kbb`: >18% green, >12% yellow, ≤12% red
  - `plat`: platoonPts=2 green, platoonPts=1 yellow, platoonPts=0 red
  - `whip`: >1.35 green, >1.20 yellow, ≤1.20 red (2/1/0pts; null=1pt abstain)
  - `brrl`: ≥14% green, ≥10% yellow, <10% gray — shown in report env column but no longer in SimScore directly (now part of `hitterBatterQualityPts`)
  - `nhlgaa`: ≤10 green, ≤15 yellow, >15 red (3-tier — ≤10=2pts, ≤15=1pt, >15=0pts) — **now 3-tier in xcell** (was binary green/red)
  - `nhlSeasonHR`: ≥90% green, ≥80% yellow, <80% red — career season hit rate; `nhlSeasonHitRatePts` drives color
  - `nhlDvpHR`: ≥90% green, ≥80% yellow, <80% red — hit rate vs teams with GAA above avg; null = DASH (1pt abstain); `nhlDvpHitRatePts` drives color
  - `nhlGameTotalOu`: ≥7 green, ≥5.5 yellow, <5.5 red — game O/U line
  - `nbapace`: not a column in NBA player prop tables (replaced by `nbaPaceTotal`)
  - `nbaSeasonHR`: ≥90% green, ≥80% yellow, <80% red — Season hit rate at threshold (blended 2026/2025); `nbaSeasonHitRatePts` drives color
  - `nbaSoftHR`: ≥90% green, ≥80% yellow, <80% red — hit rate vs soft teams; null = DASH (1pt abstain in SimScore); `nbaSoftHitRatePts` drives color
  - `nbaPaceTotal`: shows O/U line only (e.g. `231`); colored by `nbaTotalPts` (2=green/≥215, 1=yellow/null abstain, 0=gray/<215)
  - `homeOff`/`awayOff` (NBA totals Off PPG): ≥115 green, ≥108 yellow, else gray — high offense = good for over = green (playoff-appropriate; regular season SimScore tiers 118/113 differ)
  - `homeDef`/`awayDef` (NBA totals Def PPG allowed): ≥112 green, ≥105 yellow, else gray — high allowed = bad defense = good for over = green; no red floor (good defense is just gray)
  - `totalOu` (NBA/NHL totals O/U column): NBA: ≥225 green, ≥215 yellow, else gray; NHL: ≥6 green, ≥5 yellow, else gray — shows **ESPN game O/U line** (`m.gameOuLine`, consistent across all Kalshi thresholds for the same game) for NBA; shows Kalshi threshold as `O{line}` for NHL
  - `plat` sort: keyed on `hitterSplitBA` ascending
- **Team totals table** (`mlb|teamRuns`, `nba|teamPoints`): section header shows **"MLB Team Runs"** / **"NBA Team Points"** via `STAT_NAME` entries. First column labelled **"Team"** (shows `scoringTeam` only, clickable → team page); last XCOLS column **"Opp"** (`ttOpp` key) shows `oppTeam` as clickable span. Default sort: Score descending (seeded in `reportSort` initial state). Score column uses `m.teamTotalSimScore` (qual gate = 8); hover tooltip shows per-component breakdown. XCOLS: MLB = Score / **Umpire** / **Opp WHIP** / **L10 RPG** / **H2H HR%** / O/U / Opp; NBA = Score / Team PPG / Opp Def / O/U / Pace / **H2H HR%** / Opp. **H2H HR%** (`ttH2HHR` key): scoring team's hit rate ≥ threshold in last 10 H2H games vs opp (≥80% green, ≥60% yellow, <60% red; null=DASH; game count shown as hover title). **MLB SimScore component colors**: Umpire (`ttUmpire`): ≥1.05 green / ≥0.97 yellow / else gray; Opp WHIP (`ttWhip`): >1.35 green / >1.20 yellow / ≤1.20 gray; L10 RPG (`ttL10RPG`): >5.0 green / >4.0 yellow / ≤4.0 gray; null=DASH (1pt abstain). NBA PPG ≥118 green / ≥113 yellow; O/U sport-specific thresholds. `ttPace` shows team pace delta from league avg. `k` keys: `ttUmpire`, `ttWhip`, `ttL10RPG`, `ttH2HHR`, `ttOu`, `ttTeamOff`, `ttOppDef`, `ttPace`, `ttOpp` — all in `xcell` handler and `COL_TIPS`.

- **Game totals table** (`mlb|totalRuns`, `nba|totalPoints`, `nhl|totalGoals`): section header shows **"[Sport] Totals"** (e.g. "NBA Totals") via `STAT_NAME` entries `totalRuns/totalPoints/totalGoals → "Totals"`. First column labelled "Matchup" (not "Player"), shows `AWY @ HME`. Opp column hidden. Line cell shows `O7.5` format. Score column uses `m.totalSimScore` (qual gate = 8); green ≥ 8, yellow = 5–7, gray < 5. XCOLS: MLB = Comb RPG / Umpire / H ERA / A ERA / O/U; **NBA = Pace / H OffRtg / A OffRtg / Injuries / O/U**; NHL = H GPG / A GPG / H GAA / A GAA / O/U. **NBA column colors**: Pace delta green (both teams fast), OffRtg ≥118 green / ≥113 yellow; Injuries 0-out green / 3+-out red; O/U ≥225 green / ≥215 yellow (shows ESPN game line, not Kalshi threshold). **MLB ERA/RPG column colors**: ERA ≥4.5 → green (bad pitcher = over-favorable), ≥3.5 → yellow, <3.5 → gray; RPG ≥5.0 → green, ≥4.0 → yellow, <4.0 → gray. **NHL column colors**: GPG/GAA ≥3.5 green, ≥3.0 yellow, else gray; O/U ≥6 green, ≥5 yellow. Dedup key for totals is `homeTeam|awayTeam|threshold` (not `playerName|threshold`).

### Model Reference Page
`ModelPage({ onBack, calibData, calibLoading, fetchCalib, authToken })` component at `/model`. Fetches calibration on mount when logged in.

- **Entry point**: "model" link in the plays section header (next to "report" link)
- **9 tabs**: MLB Strikeouts · MLB H+R+RBI · NBA Props · NHL Points · MLB Game Total · NBA Game Total · NHL Game Total · MLB Team Total · NBA Team Total
- **Each tab contains**:
  - **True% formula** — exact computation (Monte Carlo variant, lambda/mean formula, or blended rate formula)
  - **Model inputs** — every input with a plain-language explanation of why that statistic was chosen over alternatives
  - **SimScore breakdown** — each component's tier thresholds (0/1/2 pts) and the reasoning behind each boundary
  - **CalibModule** — at the bottom of every tab. Fetches `GET /api/auth/calibration` on mount when logged in (lazy otherwise — shows Load button). Displays: pick count badge + hit rate summary, truePct bucket table (`byCategoryDetail[catKey]`) with bar chart, plus the 4 K-feature sub-tables (bySimScore/byKpctPts/byKTrendPts/byStdBF) on the MLB Strikeouts tab only. NBA Props tab aggregates all `nba|*` categories. Not logged in → "Log in to see calibration data". Delta color: green ≥+3%, yellow −2 to +2%, red ≤−3%.
- **Qualification summary bar** at top: Kalshi ≥ 70% · Edge ≥ 5% · SimScore ≥ 8/10
- **`TAB_CAT` map** in `ModelPage` maps each tab id to its `sport|stat` calibration key(s)
- **`byCategoryDetail`** returned by `/api/auth/calibration` — per-category truePct bucket breakdown (same 6 buckets as `overall`, filtered per `sport|stat`)
- **State**: `modelPage` boolean on `App`. Gated same as TeamPage — plays/picks grid hides when active (`!player && !teamPage && !modelPage`)
- `resolveSlug` handles `"model"` before TEAM_DB lookup; `goBack()` also clears `setModelPage(false)`

### Toolbar
Right side: **bust** button (calls `?bust=1`, shows "busting…" while loading) + **mock** toggle + My Picks anchor. Left side of header (next to plays title): **report** link + **model** link (opens Model Reference page).

**Plays section header**: Shows `Plays — Week of Apr 20` (Monday of current week) when plays exist, or just `Plays` when empty. Previously listed individual non-today dates (`Wed, Apr 22 · Thu, Apr 23`); replaced with week label for cleaner display.

**`MOCK_PLAYS`** — static array in `src/lib/constants.js` used when the mock toggle is on. Each entry must use **ESPN player IDs** (not MLB Stats API IDs) for `playerId` — `navigateToPlay` passes `play.playerId` as `player.id`, which drives both the ESPN headshot URL (`a.espncdn.com/i/headshots/{sport}/players/full/{id}.png`) and the `tonightPlayerMap` lookup (`p.playerId === player.id`). MLB Stats API IDs (6-digit, e.g. 660271 for Shohei) will produce a broken headshot; use the ESPN ID instead (e.g. 39832 for Shohei). `gameDate` fields use the `TODAY` constant (dynamic) — no hardcoded dates needed. HRR entries must use `stat:"hrr"` (not `"hits"`, which is deprecated). All hitter-specific fields (`oppPitcherHand`, `hitterBarrelPts`, `hitterTotalPts`, `hitterGameTotal`, `hitterBa`, `hitterSoftLabel`, `pitcherName`) should be populated so the explanation prose renders fully.

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
Shows all qualified plays (both tracked and untracked). `untrackedPlays` is filtered only by sport/stat tab — tracked plays remain visible with ★ star; card border is always `#30363d` (no green border for tracked state). Date group header suppressed when `hideHeader=true` and `sortedDates.length === 1` (avoids duplicate "Today" below the LineupsPage matchup grid header). Each card has:
- True% bar (color = tierColor, odds = model-implied from truePct; `truePct >= 100` clamps to -99999 to avoid -Infinity)
- Kalshi% bar (purple, odds = Kalshi americanOdds)
- Explanation card (varies by sport/stat)
- SimScore gate breakdown
- **Stake** — `tierUnits(americanOdds)`: returns `|americanOdds| / 10` as a dollar stake (e.g. -257 → $25.7). Not displayed on play cards. Stored on tracked picks as `units` when the star is clicked. **Implied probability calculator override**: if a valid odds value is entered in the implied probability calculator widget at the time of tracking, `savedOdds = calcOverride ?? finalOdds` is used for **both** `americanOdds` and `units` on the stored pick — overrides both the stake and the displayed implied probability. Applies to all play types (player props, game totals, team totals). P&L uses `p.units` directly as stake. Picks editor shows a `$` input to override the default. Legacy picks stored with old integer unit values (1/3/5) will be treated as dollar amounts.
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
- **SimScore tooltip for NBA totals**: shows actual values and earned points (e.g. `Pace (proj 100.2): 2/2`, `GSW OffRtg (118.5): 2/2`, `Injuries (0 out): 2/2`, `O/U (228): 1/2`). Both play card badge (hover `scTitle`) and market report `xcell k==="sim"` show the same breakdown.
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
1. Batting spot + barrel rate — same sentence group since both drive `hitterBatterQualityPts`. e.g. "Shohei, batting #1 — top of the order. Barrel rate 14.2% — elite hard contact." Barrel color: ≥14% green, ≥10% yellow, ≥7% gray, <7% dim. BA tier removed — not a SimScore component.
2. Pitcher name — WHIP always shown; color binary: `> 1.35 → green` ("a lot of baserunners"), `> 1.20 → yellow` ("some traffic on base"), `≤ 1.20 → red` (no description). FIP removed from prose.
3. Season rate + soft rate (vs pitcher H2H or platoon fallback). When platoon fallback active (`softLabel = "vs RHP"/"vs LHP"`): soft rate sentence shows split BA inline — e.g. `"and 78.4% vs RHP (hits .237 vs RHP)"`; color is red when platoon disadvantage (`platoonPts === 0`), green otherwise. Separate platoon sentence suppressed when fallback active (already covered inline). Non-fallback H2H: shows game count `(Ng)` as before.
4. ERA rank / no-H2H context — **only shown when `softPct === null` (no H2H data)**.
5. Park factor (when |pf − 1.0| ≥ 0.03) — sourced from `tonightHitPlay?.parkFactor ?? tonightHitPlay?.hitterParkKF`
6. Game total (color: ≥9.5 green, ≥7.5 yellow, <7.5 gray)
7. Platoon edge/disadvantage (non-fallback only): "Hits `.310` vs RHP — platoon edge." or "Hits `.229` vs LHP — platoon disadvantage (`.281` season).". Silent when 1pt (neutral/abstain). Suppressed when `isPlatoonFallback` — split BA already shown in soft rate sentence.
8. SimScore badge inline
9. **Lineup badge** — `✓ Lineup` (green) when `lineupConfirmed === true`; `Proj. Lineup` (gray) when `lineupConfirmed === false` and game is not imminent (same 30-minute rule as play card subtitle). `lineupConfirmed` and `gameTime` sourced from `tonightHitPlay` (HRR) or `h2h` (strikeouts, via `tp.lineupConfirmed/gameTime` added to h2h object). `verticalAlign:"middle"` so badge sits inline with SimScore badge.

**HRR market report columns:** `XCOLS["mlb|hrr"]` = Score / **Quality** / WHIP / **Ssn HR%** / **H2H HR%** / **O/U**. Park column removed. `Quality` shows `#spot barrel%` (e.g. `#3 12%`) colored by `hitterBatterQualityPts` (2=green, 1=yellow, 0=red). `Ssn HR%` shows `m.seasonPct` colored by `hitterSeasonHitRatePts` (≥80% green, ≥70% yellow, <70% red). `H2H HR%` shows `m.softPct` colored by `hitterH2HHitRatePts` (≥80% green, ≥70% yellow, <70% red). SimScore tooltip: `Quality: N/2`, `WHIP: N/2`, `Season HR: N/2`, `H2H HR: N/2`, `O/U: N/2`. Null-abstain shows `1` not `—`.

**NBA player prop market report columns:** `XCOLS["nba|*"]` = Score / **C1** / DVP / **Ssn HR%** / **Soft HR%** / **O/U**. `Ssn HR%` shows `m.seasonPct` colored by `nbaSeasonHitRatePts` (≥90% green, ≥80% yellow, <80% red). `Soft HR%` shows `m.softPct` colored by `nbaSoftHitRatePts`; null = DASH. `O/U` (`nbaPaceTotal` key) shows game O/U line colored by `nbaTotalPts` (2=green/≥215, 1=yellow/null, 0=gray/<215). C1 label is "Usage" for pts/ast/3pt, "AvgMin" for rebounds. **Opp column flex=1** (was 2) to reduce whitespace.

**NHL player prop market report columns:** `XCOLS["nhl|points"]` = Score / **AvgTOI** / **GAA Rank** / **Ssn HR%** / **DVP HR%** / **O/U**. Replaced old Ssn% / vSoft% / SA Adj / Rest columns with the five SimScore components. `Ssn HR%` uses `nhlSeasonHR` key (m.seasonPct + nhlSeasonHitRatePts coloring). `DVP HR%` uses `nhlDvpHR` key (m.softPct + nhlDvpHitRatePts; null=DASH). `O/U` uses `nhlGameTotalOu` key (m.nhlGameTotal; ≥7 green, ≥5.5 yellow). `nhlgaa` fixed to 3-tier (was binary ≤10 green / else red).

**Strikeout market report columns:** `XCOLS["mlb|strikeouts"]` = Score / CSW% / K-BB% / Lineup K% / **Hit Rate** / O/U. P/GS column removed. K-Trend column was replaced with **Hit Rate** (`blendedHitRate` field, colored by `blendedHitRatePts` tiers: ≥90% green, ≥80% yellow, <80% red). `blendedHitRate` is a new field added to all strikeout play/drop output — the actual trust-weighted blended rate value (not just the pts). `_blendedHR` hoisted to outer `let` scope so it's accessible in the main plays push for all stats.

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
- Frontend: Vite build (`npm run build` → `dist/`), triggered automatically by Vercel on push
- Backend: `api/[...path].js` is the Vercel Edge Function (unchanged — no build step for API)
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

Both cover: `kDistPct` monotonicity, `simulateKsDist` validity, `buildNbaStatDist`, API monotonicity sweep, `allTonightPlays` player card fix, frontend `_rawTruePctMap` monotonicity enforcement, NBA simScore, report filter logic, `_parseWind` ESPN display string parsing (all direction variants + edge cases), and `weatherFactor` formula (clamp bounds, wind/temp contributions, null handling). 55 tests total.

---


## Common Debugging

See [docs/DEBUGGING.md](docs/DEBUGGING.md) for the full debugging reference.
