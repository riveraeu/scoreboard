# Scoreboard — Project Guide for Claude

## What This Is
A sports prop betting dashboard that pulls Kalshi prediction market prices, computes a model True%, and shows qualified plays with an edge over the market. Deployed on Vercel Edge (no Node.js APIs — Web Fetch/KV only).

**Production URL**: `https://scoreboard-ivory-xi.vercel.app`

---

## Architecture

### Single-file API: `api/[...path].js`
Handles all server logic as a Vercel Edge Function. Routes via `pathname`:
- `/api/tonight` — main play generation endpoint
- `/api/tonight?debug=1` — returns all markets including dropped/preDropped + debug fields
- `/api/tonight?bust=1` — bypasses KV cache
- `/api/kalshi` — raw Kalshi market data
- `/api/player` — ESPN player info + gamelog
- `/api/dvp` — Defense vs Position data
- `/api/nba-depth` — NBA depth chart from ESPN
- `/api/keepalive` — cron ping (daily)
- `/api/dvp/debug-dc` — inspect depth chart cache

### Frontend: `index.html`
Single HTML file with JSX compiled via Babel standalone (no build step). All React components inline.

### Storage: Cloudflare KV (`CACHE2`)
Used for caching expensive fetches. Key TTLs:
- `byteam:mlb` — 600s (MLB team stats, probables, lineup K-rates). **Does NOT include `barrelPctMap`** — that lives in `mlb:barrelPct`. Uses 60s TTL if lineupSpotByName or pitcherAvgPitches come back empty (e.g. bust before lineups confirmed), so next request retries quickly.
- `byteam:nba` — 1800s
- `byteam:nfl` — 1800s
- `gameTimes:v2:{date}` — 600s
- `nbaStatus:{date}` — 600s
- `nba:pace:2526` — 43200s (12h, fetched via ESPN `sports.core.api.espn.com` team stats, `buildNbaPaceData()`)
- `mlb:barrelPct` — 21600s (6h, Baseball Savant barrel%)
- `nba:depth:{date}` — daily

---

## Sports & Stats

### MLB
- **Stats**: `hits`, `hrr` (H+R+RBI), `strikeouts`
- **Kalshi series**: `KXMLBHITS`, `KXMLBHRR`, `KXMLBKS`
- **Data sources**: MLB Stats API (schedule, lineups, probables, pitcher gamelogs), ESPN gamelogs, Baseball Savant (barrel%)

#### MLB Strikeouts Model
True% = Monte Carlo simulation (`simulateKsDist` + `kDistPct`)
- Shared distribution per pitcher (keyed `playerTeam|pitcherHand`) — guarantees P(K≥4) ≥ P(K≥5)
- `pitcherKDistCache` built before play loop
- 10000 sims if `simScore ≥ 11`, else 5000
- **SimScore** (max 11 pre-edge, 14 with edge bonus):
  - CSW% > 30% → 3pts (falls back to K% > 24%)
  - K-BB% > 15% → 2pts
  - Lineup oK% > 24% → 3pts (hand-adjusted vs RHP/LHP)
  - Avg pitches/start > 85 → 2pts
  - Park factor > 1.0 → 1pt
  - Edge > 5% → 3pts (bonus, added after simulation)
- **Gates**: simScore ≥ 7 to enter play loop; finalSimScore ≥ 10 to qualify as a play (7–9 = qualified:false, shows in report but not plays card)
- Pitchers fetched via `buildPitcherKPct(mlbSched)` — avg pitches per start from season aggregate `numberOfPitches / gamesStarted`
- Park factors in `PARK_KFACTOR` map

#### MLB Hitters (hits/hrr) Model
True% = Monte Carlo simulation (`simulateHits`) using batter BA × pitcher BAA (log5)
- **SimScore** (max 11 pre-edge, 14 with edge bonus):
  - Lineup spot 1–2 → 3pts, spot 3–4 → 2pts
  - Pitcher WHIP > 1.35 → 3pts (from pitcher gamelog)
  - Pitcher FIP > ERA → 2pts
  - Park hit factor > 1.02 → 1pt
  - Edge > 5% → 3pts
- **Gates**: lineup spot 1–4 required; hitterSimScore ≥ 7; BA ≥ .270 (good/elite tier only); edge ≥ 3%
- Barrel% from Baseball Savant (`buildBarrelPct`) — cached 6h in KV

### NBA
- **Stats**: `points`, `rebounds`, `assists`, `threePointers`
- **Kalshi series**: various per stat
- True% = Monte Carlo simulation (`buildNbaStatDist` + `nbaDistPct`) — normal distribution over per-game values
  - `nbaPlayerDistCache` keyed `playerId|stat` — all thresholds (3+, 4+, 5+) share one distribution, guaranteeing monotonicity
  - Mean from last 10 games (recency), std from full season (stability)
  - Adjusted mean: `× teamDefFactor × (1 + paceAdj×0.002) × 0.93 if B2B`
  - `teamDefFactor` = general team defense (`rankMap[opp].value / leagueAvg`) — NOT position-adjusted DVP
  - Falls back to avg(seasonPct, softPct) − 4% if B2B when simulation returns null (<5 game values)
- **SimScore** (max 11 pre-edge, 14 with edge bonus):
  - Pace (avg game pace above league avg) → 3pts — fetched from ESPN via `buildNbaPaceData()`, cached 12h
  - Avg minutes ≥ 32 (last 10 games) → 4pts; ≥ 25 → 2pts
  - Position-adjusted DVP rank ≤ 10 → 2pts
  - Not B2B → 2pts
  - Edge > 5% → 3pts (added after simulation)
- nSim scales with pre-edge simScore: ≥8 → 10k, ≥5 → 5k, else 2k
- **Gate**: opp in soft DVP teams; edge ≥ 3%
- Avg minutes from ESPN gamelog `MIN` column (last 10 games), no external API needed
- Depth chart position via `nbaDepthChartPos` (ESPN depth chart API, cached daily)

### NHL
- **Stats**: `goals`, `assists`, `points`
- True% = avg(seasonPct, dvpAdjustedPct, vSoftPct) with B2B -4%, DVP adjustment × 1.06
- Gate: opp in soft GAA teams; edge ≥ 3%

### NFL
- **Stats**: `passingYards`, `rushingYards`, `receivingYards`, `receptions`, `completions`, `attempts`
- Gate: opp in soft teams; edge ≥ 3%

---

## Key Functions & Code Locations

### `api/[...path].js`
| Function | What it does |
|---|---|
| `simulateKsDist(orderedKPcts, pitcherKPct, parkFactor, nSim)` | Runs shared Monte Carlo, returns `Int16Array` of K counts |
| `kDistPct(dist, threshold)` | Queries shared distribution — guarantees monotonicity |
| `simulateHits(batterBA, pitcherBAA, parkFactor, threshold, nSim)` | Monte Carlo for hitter hits/HRR |
| `buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim)` | Builds shared `Float32Array` of simulated NBA per-game values |
| `nbaDistPct(dist, threshold)` | Queries shared dist for any threshold — guarantees monotonicity |
| `log5K(pitcherKPct, batterKPct)` | Log5 formula for K probability |
| `buildPitcherKPct(mlbSched)` | Fetches pitcher season stats (K%, KBB%, ERA, P/GS, CSW%) |
| `buildLineupKPct(mlbSched)` | Fetches lineup batter K-rates, lineup spots, ordered arrays |
| `buildBarrelPct()` | Fetches Baseball Savant barrel% CSV, 5s timeout, cached 6h |
| `buildNbaDepthChartPos()` | ESPN depth chart → `{espnPlayerId: "PG"|"SG"|...}` |
| `buildNbaPaceData(cache)` | ESPN team stats → `{teamPace, leagueAvgPace}`, cached 12h in KV |

### Kalshi Market Parsing
- Series tickers in `SERIES_CONFIG`
- Filter: `pct >= 70` AND `pct <= 97`
- Blended fill price via orderbook walk for thin markets

### preDropped vs dropped
- `preDropped`: filtered before main play loop (no ESPN info yet) — included in `?debug=1` response
- `dropped`: filtered inside play loop — included in `?debug=1` response

### qualified:false plays
MLB strikeout markets that fail simScore gate (< 7 or finalSimScore < 10) are pushed to `plays[]` with `qualified: false` so the player card can show real simPct for all thresholds. The main plays list (`tonightPlays`) filters these out client-side: `.filter(p => p.qualified !== false)`.

---

## Frontend Architecture (`index.html`)

### State
- `tonightPlays` — qualified plays from `/api/tonight`, filtered `qualified !== false`
- `reportData` — full debug response from `/api/tonight?debug=1`, shown in Market Report overlay
- `player` — currently selected player for detail card
- `trackedPlays` — user's saved picks (localStorage or server)

### Market Report
Opened via "report" button. Shows ALL markets (plays + dropped) grouped by sport/stat. Columns vary by sport/stat via `XCOLS` map.

### Play Cards
Shows `untrackedPlays` (qualified plays not yet tracked). Each card has:
- True% bar (color = tierColor, odds = model-implied from truePct)
- Kalshi% bar (purple, odds = Kalshi americanOdds)
- Explanation card (varies by sport/stat)
- SimScore gate breakdown

### Player Card
Clicking a play opens the player card with:
- Historical rates per threshold
- Kalshi market prices
- truePct from `tonightPlayerMap` (keyed `stat|threshold`)
- Monotonicity enforced client-side: lower threshold truePct ≥ higher threshold

### Color Tiers
```
tierColor(pct): >= 80% → #3fb950 (green), >= 65% → #e3b341 (yellow), else #f78166 (red)
```

### NBA AvgMin Tiers (report column)
- ≥ 32 min → green (4 SimScore pts)  
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

---

## Common Debugging

### "Why is truePct the same for 4+ and 5+?"
The `pitcherKDistCache` shares one `Int16Array` distribution across all thresholds for a pitcher. If a threshold isn't in `plays[]` (or `qualified:false` plays), the player card falls back to the raw formula. Check `?debug=1` response for the specific player — look in `dropped` for the missing threshold and check `reason`.

### "Player appears in Kalshi but not in plays or dropped"
Check `preDropped` in `?debug=1` response. Common reasons: `no_soft_data`, `opp_not_soft`, `no_opp`.

### "Market report shows — for Spot/Brrl%"
- Spot: lineup not confirmed yet (pre-game). Projected lineups from last 7 days are used as fallback.
- Brrl%: Baseball Savant fetch timed out or returned empty. Cached in KV for 6h — bust cache with `?bust=1`.

### "P/GS all dashes"
Comes from `split.numberOfPitches / split.gamesStarted` in season aggregate stats. If a pitcher has 0 starts recorded yet, will show `—`.

### Cache busting
- `?bust=1` deletes `byteam:mlb` and forces a fresh MLB data rebuild
- `mlb:barrelPct` is NOT deleted on bust — barrel% survives busts with its own 6h TTL
- If bust fires before lineups/probables are available, `byteam:mlb` is written with 60s TTL so next request retries
- Depth chart: no bust — expires daily

### "NBA report shows — for Pace/AvgMin/Rest on most rows"
Most NBA markets are dropped at `opp_not_soft` before the pre-sim block runs. Those drop records now include `isB2B`, `nbaPaceAdj`, and `nbaOpportunity` computed inline from the gamelog at that drop site.

### "SimScore shows yellow for strikeout players with score 7–9"
The qualifying gate for strikeouts is `finalSimScore >= 10`. The report SimScore column uses `>= 10` as the yellow threshold when `finalSimScore` is present, so scores 7–9 show gray (not qualifying).
