# Scoreboard — Infrastructure Reference

Storage, caching, deployment, env vars, testing, data sources.

---

## Storage: Upstash Redis
On Vercel, `env.CACHE` (Cloudflare KV binding) is unavailable — `makeCache()` falls through to Upstash REST client (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`).

**Free tier 500k commands/month** — when exceeded, all reads/writes silently return null (Upstash returns HTTP 400 but the `cmd()` wrapper only extracts `result`). Diagnose with `curl -H "Authorization: Bearer <ADMIN_KEY>" .../api/auth/debug-redis`.

User auth (`user:{email}`) and picks (`picks:{userId}`) live in the same Redis. JWT expires after 365 days. Picks also kept in `localStorage` as backup — restored to server if server returns 0 but local has data.

---

## Cache keys & TTLs

| Key | TTL | Notes |
|---|---|---|
| `byteam:mlb` | 600s | Probables, lineup K-rates, pitcher avg pitches/BF. **Excludes** `barrelPctMap` (separate). 60s short-TTL guard when any of `lineupSpotByName`, `pitcherAvgPitches`, `hitterOpsMap`, `pitcherH2HStarts` is empty — independent MLB Stats API calls fail silently (`.catch(() => ({}))`) so a successful lineup hydration alongside a failed OPS or gamelog fetch would otherwise bake partial data for 10min, starving HRR OPS / K H2H Hand / platoon / recent K% columns. |
| `byteam:nba` / `:scoring` | 1800s / 21600s | Defensive stats / offensive PPG |
| `byteam:wnba` / `:scoring` | 21600s | Defensive stats / offensive PPG (2025 season). Same `buildSoftTeamAbbrs` / `buildTeamRankMap` helpers as NBA. |
| `byteam:nhl` | 21600s | GAA + SA per team |
| `byteam:nfl` | 1800s | |
| `kalshi:snap:{ticker}` | 300s | Per-ticker snapshot written by `/api/kalshi-snapshot` cron every 2 min. Value: `{markets, writtenAt}`. `/api/tonight` reads via Upstash MGET; uses snaps only if all are within 180s freshness (all-or-nothing). Eliminates per-request Kalshi REST burst on warm path. Bypassed by `?bust=1`. |
| `kalshi:snap:_meta` | 600s | `{lastRunAt, successCount, failedTickers[], durationMs}` from the latest cron run. Surfaced in `/api/tonight?debug=1` as `kalshiSnap`. |
| `kalshi:bundle:{date}` | 600s | Legacy bundle (all 18 series in one JSON blob). Now a second-tier fallback below snaps; still populated by the cold REST path so manual `?bust=1` still works without the cron. Bypassed by `?bust=1`. |
| `kalshi:stale:{ticker}` | 1800s | Stale-while-revalidate per-ticker fallback for 429/empty in the REST path. TTL caps drift if Kalshi keeps 429-ing — series disappears from `/api/tonight` rather than serving 30+ min old prices. |
| `kalshi:KXMLBGAME` | 600s | Legacy MLB game-ML bundle. Tier-2 below `kalshi:snap:KXMLBGAME`, tier-1 above direct REST. |
| `gameTimes:v2:{date}` | 600s | Stores `sport:team:ptDate` AND bare `sport:team` (first wins). Built from yesterday + today + tomorrow ESPN scoreboards in parallel. Cleared by `?bust=1`. |
| `nba:pace:2526` | 12h | Pace + OffRtg/DefRtg + leagueAvg. Cleared by `?bust=1`. |
| `wnba:pace:2025` | 12h | Pace (avgEstimatedPossessions) + OffRtg/DefRtg/PPG. 2025 anchor. |
| `wnba:dvp:2025:{date}` | 12h | Stat-allowed DVP aggregated server-side from prior-season player gamelogs (no BettingPros equivalent). Flat (no per-position split). |
| `wnba:injuries:{date}` | 1800s | ESPN injuries (Out + GTD) |
| `wnba:usg:{playerId}:2025` | 6h | Per-player USG% — falls back to `(avgFGA + 0.44·avgFTA + avgTO) / (avgMin × 1.88)` when ESPN omits direct USG (1.88 = 2.255 × 40/48 rescales NBA formula to 40-min game). |
| `nba:depth:{date}` | daily | |
| `mlb:barrelPct` | 6h | Baseball Savant CSV |
| `mlbSchedTomorrow:{date}` | 600s | Tomorrow's MLB schedule (probables only) |
| `weather:mlb:{date}` | 600s | ESPN weather, refreshed independently of gameTimes |
| `teamschedule:v2:{sport}:{abbr}` | 3600s | H2H + season hit rates. Cleared by `?bust=1`. |
| `lineOpen:{ticker}:{gameDate}` | 2 days | E1 line-movement opening price |
| `team:v3:{sport}:{abbr}:{date}` | 3600s | `/api/team` data |
| `live:{sport}:{teams sorted}:{ptDate}` | 60s in / 300s post | `/api/live` boxscore |

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
- Crons (`vercel.json`):
  - `/api/keepalive` — daily at noon UTC. Keeps Upstash from idle-suspending.
  - `/api/kalshi-snapshot` — `*/2 * * * *` (every 2 min). Pre-warms `kalshi:snap:{ticker}` so `/api/tonight` skips per-request Kalshi REST. Bearer-auth via `CRON_SECRET` (Vercel auto-attaches when set). Returns `{ok, successCount, failedCount, failed[], durationMs}`. Throttled batches of 6 with 300ms delay; pipelined Upstash write (1 HTTP request for all SETs).

### Required env vars
Vercel dashboard AND wired via `env` object — see CLAUDE.md "Edge handler env-var wiring" gotcha.

| Variable | Purpose | Generate |
|---|---|---|
| `JWT_SECRET` | HMAC for auth tokens | `openssl rand -base64 32` |
| `ADMIN_KEY` | Admin endpoint shared secret | `openssl rand -base64 32` |
| `CRON_SECRET` | Vercel Cron bearer auth (currently `/api/kalshi-snapshot`) | `openssl rand -base64 32` |
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
