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
| `kalshi:snap:{ticker}` | 300s | Per-ticker snapshot written by `/api/kalshi-snapshot` cron every 2 min. Value: `{markets, writtenAt}`; in-window markets carry a `_depth` orderbook snapshot for slippage blending. `/api/tonight` reads via Upstash MGET; uses snaps only if all are within 180s freshness (all-or-nothing). Eliminates per-request Kalshi REST burst on warm path. Bypassed by `?bust=1`. Written in **two phases** — snaps first (always), then re-written for series that gained depth (see cron note below). |
| `kalshi:snap:_meta` | 600s | `{lastRunAt, successCount, failedTickers[], durationMs, depthOk, depthFail, depthTargets, depthPending?}` from the latest cron run. Surfaced in `/api/tonight?debug=1` as `kalshiSnap`. **`null` meta = no cron completed in the last 10 min → cron-side failure.** |
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
| `nba:starters:{date}` | 600s | Per-game ESPN boxscore starters parsed for tonight's NBA slate. Shape: `{confirmedTeams: [abbr], startersByTeam: {abbr: [playerId]}}`. Feeds the dataConfidence `lineupConf` component for NBA player props. Empty pre-game when ESPN hasn't populated starters yet (correct signal — lineup unknown). Cleared by `?bust=1`. |
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
- Vercel Node runtime / Fluid Compute (since 2026-06-11; was Edge with a 60s wall — the cause of the 2026-06-10 pregame-snap 504s). `maxDuration: 300` via the `functions` block in vercel.json. `runtimeCtx.waitUntil` is the real `@vercel/functions` waitUntil, so backgrounded work (DvP rebuilds) survives the response. Auto-deploys on `git push origin main` (no `vercel` CLI). Frontend built by Vercel via `npm run build`.
- Rewrites in `vercel.json`: `/api/:path*` → `/api/[...path]`. CORS headers also there (required for OPTIONS preflight through rewrite layer).
- Crons (`vercel.json`):
  - `/api/keepalive` — daily at noon UTC. Keeps Upstash from idle-suspending.
  - `/api/kalshi-snapshot` — `*/2 * * * *` (every 2 min). Pre-warms `kalshi:snap:{ticker}` so `/api/tonight` skips per-request Kalshi REST. Bearer-auth via `CRON_SECRET` (Vercel auto-attaches when set). Returns `{ok, successCount, failedCount, failed[], durationMs, snapWriteSent, snapWriteFailed, depthWriteFailed, writeErrors[], depthOk, depthFail, depthTargets, depthBudgeted, touchedSeries}`. Series fetched in throttled batches of 3 with 700ms delay; pipelined Upstash write. **Two-phase write (2026-05-31):** snaps written first (so they always land within the ~25s Edge ceiling), then orderbook depth fetched best-effort under a 21s wall-clock deadline and only the touched series re-written. Before the split, the depth phase ran before the only write and timed the cron out on full slates → no snaps at all. **Chunked pipeline write (2026-06-12):** Upstash rejects any HTTP request over 10MB; the single-request pipeline body hit ~11MB after KXMLBTB + the KXMLBHIT ticker fix added ~4.2MB of markets, and the bare `fetch` (no `res.ok` check) swallowed the 413s silently — snaps expired while `_meta` (written in the small phase-2 request) stayed fresh, making the meta diagnostic lie. `_pipeWrite` now chunks commands at 7MB serialized, checks `res.ok` + per-command errors, never throws, and returns `{sent, failed, errors}`. Meta is written in its own tiny request *after* the snap chunks and carries `snapWriteFailed`/`snapWriteError`, so fresh meta once again implies the snap phase ran — check `snapWriteFailed > 0` when diagnosing `usedSnaps:false`. Response `ok` is false if any phase-1 chunk failed.

### Cron schedule, dependencies & DST policy

Vercel cron schedules are **UTC-pinned**; all timing intent in this project is **Pacific wall-clock** (game schedules, lineup confirmation, "morning after" resolution). When DST ends, every cron fires one hour earlier in PT terms. **Policy (decided 2026-06-11): re-pin in November** — see checklist below. Relative offsets between paired crons are preserved automatically (all UTC), so only the absolute PT anchoring drifts.

| UTC (current) | PDT intent | PST if unshifted | Path | Pairing constraint |
|---|---|---|---|---|
| `0 15` | 8:00am tonight | 7:00am | `/api/tonight` | — |
| `5 15` / `10 15` | 8:05/8:10am snapshot | 7:05/7:10am | `/api/shadow-snapshot` | must trail the `0 15` tonight by 5–10 min |
| `30 16` | 9:30am report | 8:30am | `/api/shadow-report` | after morning snapshot |
| `55 16` | 9:55am tonight | 8:55am | `/api/tonight` | — |
| `0 17` | 10:00am pregame | 9:00am | `/api/shadow-pregame-snap` | must trail the `55 16` tonight by ~5 min (fresh staging) |
| `0 22` | 3:00pm tonight | 2:00pm | `/api/tonight` | — |
| `5 22` / `35 22` | 3:05/3:35pm snapshot | 2:05/2:35pm | `/api/shadow-snapshot` | must trail the `0 22` tonight |
| `10 22` | 3:10pm pregame | 2:10pm | `/api/shadow-pregame-snap` | must trail the `0 22` tonight |
| `55 2` | 7:55pm tonight | 6:55pm | `/api/tonight` | — |
| `0 3` | 8:00pm pregame | 7:00pm | `/api/shadow-pregame-snap` | must trail the `55 2` tonight |
| `0 9` / `5 10` / `0 14` | 2am/3:05am/7am resolver | 1am/2:05am/6am | `/api/shadow-resolver` | after all games final; 7am retry needs warm Neon |
| `0 12` keepalive · `*/2` kalshi-snapshot | — | — | | DST-exempt, never shift |

**November 1, 2026 checklist (DST ends):** add +1 hour UTC to every row above except the DST-exempt line (e.g. `0 15` → `0 16`, `55 2` → `55 3`, `0 9` → `0 10`), keeping minute offsets identical so pairings hold. Reverse (−1h) when DST returns on 2027-03-14 (second Sunday of March). Update this table's UTC column in the same commit.

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

---

## Route Contracts

### `/api/tonight`
Main play generation. `?debug=1` returns `dropped[]`, `preDropped[]`, and debug fields. `?bust=1` bypasses all caches. 2-min polling loop in `App.jsx` (`POLL_MS=120_000`), paused when tab hidden. Manual ↻ button is the only `?bust=1` path.

### `/api/kalshi-order`
`POST`, authenticated (bearer JWT). Body: `{ ticker, side: "yes"|"no", price: int (1–99), count: int }`. Signs via **RSA-PSS / SHA-256 / saltLength=32** with `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY`. Signature message: `timestamp_ms + "POST" + "/trade-api/v2/portfolio/orders"` (ms timestamp, path only, no body). Supports PKCS#1 and PKCS#8 PEM. Returns full Kalshi `order`; frontend reads `taker_fill_count`/`taker_fill_cost`, stamps pick with real fill (`kalshiCount`/`kalshiAvgCents`/`kalshiRestingCount`).

**"Place All" batch (⚡ button in LineupsPage toolbar):** sequential POSTs (await each). Candidate set = qualified minus tracked minus started minus null-sizing. Sizing (`_placeAllSizing` in App.jsx): ⅛-Kelly on bet side (UNDER uses `noTruePct`+`noKalshiPct`), $500 cap / $30 fallback. **Flow A validation:** `validateCandidate(play, sizing)` in `src/lib/placeValidation.js` → `{ hard, soft }`. Hard failures exclude (✗ greyed); soft annotate (⚠). `placeAllPlaceable` (hard.length===0) is the **single source of truth for all four count surfaces** (toolbar badge, tab badges, card badges, modal). Hard checks: dcQualified+edge≥5, ticker present, count≥1, price in range, distinct teams. Soft: slippage ≥3¢ over `rawKalshiPct`/`rawNoKalshiPct` (emitted by tonight.js as pre-blend top-of-book). `placeAllPlaceableIds` + `placeAllCountByDay` passed to LineupsPage; 5th param to `playsForGame` filters card display. `activeDayTab` lifted to App.jsx (shared by modal + page). **Modal is today-only** (PT date of gameTime; 2026-06-12) — tomorrow's pre-listings qualify on the page but don't appear in the modal until their slate day. Rows show side-aware True% / Mkt% (price as percent) / Edge%; American odds removed from rows. The toolbar ⚡ badge is also today-only (`placeAllCountByDay[todayPT]`), matching the modal; the button hides entirely when today's count is 0 even if tomorrow pre-listings qualify. **Prop dedup:** highest-edge per `playerId|sport|stat|gameDate`; tracked-pick suppression uses the same day-scoped key and only ACTIVE picks (`!p.result`) — an unscoped key built from full pick history hid every previously-bet player from Place All and the Lineups page for 3 days (6/09–6/12, fixed 2026-06-12). **Phi-scaled sizing:** `placeAllGrouped` groups by game key, `avgPosPhi` from module-level `_SAME_GAME_PHI` Map (App.jsx, φ from shadow analysis), `effectivePlays = 1 + (n-1)×(1-avgPosPhi)`, proportionally rescales counts. Update `_SAME_GAME_PHI` when shadow-analysis reports new strong pairs (n≥50).

### `/api/kalshi-balance`
`GET`, authenticated. Returns `{ cashCents, positionsCents, balanceCents, balanceDollars }`. `balanceDollars` = cash + open-position cost basis (sum of `market_exposure_dollars` over unsettled positions). Two signed RSA-PSS GETs: `/trade-api/v2/portfolio/balance` then positions endpoint. Positions call degrades to `positionsCents=0` on failure. Cost basis, not mark-to-market. No caching.

### `/api/kalshi-snapshot`
Cron-only (`*/2 * * * *`). **Two-phase write:** (1) fetch all series → write snaps immediately with `_meta.depthPending:true`; (2) fetch orderbook depth for in-window markets best-effort under 21s wall-clock deadline (`DEPTH_DEADLINE_MS`, cap `DEPTH_FETCH_CAP=90`, volume-prioritized) → re-write only touched series. Snaps always land regardless of the depth phase. `_meta` carries `depthOk`/`depthFail`/`depthTargets`/`durationMs`. Ticker list derived from `[...Object.keys(SERIES_CONFIG), ...CRON_ONLY_TICKERS]` in `api/lib/series-config.js`.

### `/api/auth/calibration`
Returns `overall`, `byCategory`, `byCategoryDetail`, `kStrikeouts` — tracked pick outcome stats.

### `/api/auth/shadow-calibration`
`GET`, bearer JWT or `?adminKey=`. Queries Neon `shadow_plays`. Optional filters: `?since=YYYY-MM-DD` (default 30d), `?bestThreshold=true` (dedup to one play per group), `?dcQualified=true`, `?minDc=N`, `?sport=mlb`, `?thresholdRank=1`, `?seasonType=2|3`. Returns `overall`, `byCategory` (with `nRaw`/`avgGroupSize`), `byCategoryDetail` plus `roi` and `avgEdge` per cell. Bands 55–60 through 95+ (bet-side probability — UNDERs flip to `1 − model_true_pct`).

### `/api/auth/shadow-analysis`
`GET`, bearer JWT or `Authorization: Bearer $ADMIN_KEY`. Five analyses on `shadow_plays` (since=30d default): (1) `thresholdRankRoi`; (2) `intraGroupCorr` — alt-line group unanimity; (3) `sameGamePairs` — pairwise φ (threshold_rank=1, n≥10); (4) `concentration`; (5) `clvAnalysis` — per-category CLV, edge at snap vs close, hit rate. Requires `price_pre_at IS NOT NULL` rows.

### `/api/auth/shadow-stats`
`GET`, admin bearer. Row counts by date/category/dc + `unresolvedByCategory`. `?trigger=1` also runs shadow-snapshot inline; `?resolvetrigger=1` runs shadow-resolver.

### `/api/auth/clear-kalshi-stale`
`POST ?ticker=KXMLBTEAMTOTAL` with `Authorization: Bearer <ADMIN_KEY>`. Deletes `kalshi:stale:{ticker}`. Does **not** affect `kalshi:snap:{ticker}`.

### `/api/shadow-snapshot`
Cron-only (`5 15`, `10 15`, `5 22`, `35 22 * * *` UTC). Reads `shadow:staging:{date}` from KV first (written by the tonight handler on every recompute, TTL 6h, payload `{plays, dropped, schedule, writtenAt}`); falls back to fetching `/api/tonight?debug=1` (55s timeout). **Coverage check:** `schedule` carries today's ESPN game count per sport (stamped by tonight from gameScores); snapshot compares distinct games in the logged rows (`sport|sortedPair|game_date`) against it and returns `coverage: {sport: {games, scheduled}}` + `coverageWarning: true` below 80% (warn-only — catches whole-game gaps from parse bugs/Kalshi outages/emit regressions; legitimate <100% from games without Kalshi markets and DH collapse). `coverage: null` on the HTTP-fallback path. Combines `plays + dropped`, annotates `group_id`/`threshold_rank` (rank 1 = closest to 50% truePct), batch-upserts to Neon `shadow_plays`. Stores `home_team`/`away_team` as `homeTeam || playerTeam || gameTeam1`. **Full Kalshi price range:** `dropped` includes game/team total OVERs and ML/spread outside [67,91] (`reason: "kalshi_out_of_window"`). Decimal price columns: `kalshi_yes_price = kalshiPct/100`, `kalshi_no_price = noKalshiPct/100`.

### `/api/shadow-resolver`
Cron-only (`0 9`, `5 10`, `0 14 * * *` UTC = 2am/3:05am/7am PT — the 7am retry exists because Neon is cold at 2–3am PT: on 2026-06-11 the 9:00 run hung in the SELECT past the Edge 25s wall (504) and the 10:05 backup got a stale-empty read from the unpooled replica conn, returning 200 with 0 rows; by 7am morning traffic has warmed Neon). Queries Neon for unresolved rows from prior days **via the pooled primary (`neonQuery` `{write:true}`)** — the unpooled conn may be a read-only replica without read-after-write consistency. Logs `[shadow-resolver] rows=N selectMs=` and a completion line, so a zero-row run is visible in cron logs. **Abandonment rule:** rows unresolved for 14+ days (postponed games, unparseable teams) are marked `resolved=TRUE, won=NULL` at the top of each run — exits them from the scan without polluting calibration (which filters `won IS NOT NULL`). SELECT is `ORDER BY snapshot_date DESC LIMIT 2000` so fresh rows win if backlog ever exceeds the limit. Self-calls `/api/live` per distinct game_date, applies resolution logic (props, totals, teamTotal, ML, spread, F5, NBA halves), batch-updates `resolved/won/actual_value/resolved_at`. **4-pass player name lookup:** exact → diacritic-strip → period/suffix-strip (C.J.→CJ, Jr.) → Levenshtein ≤2. **effectiveDate resolution order:** `game_date` → PT date from `game_time` ISO → `snapshot_date`. **Third pass:** for rows where both are null, retries team lookup against `snapshot_date+1` through `+5`.

### `/api/shadow-pregame-snap`
Cron-only (`0 17`, `10 22`, `0 3 * * *` UTC — each trails a `/api/tonight` cron by 5–10 min). Reads `shadow:staging:{date}` from KV first; the staging payload's `writtenAt` must be ≤15 min old (CLV prices stamped now must reflect now — stale staging is rejected, unlike shadow-snapshot which tolerates any age). Falls back to an HTTP fetch of `/api/tonight` (45s timeout) — this path 504'd all three runs on 2026-06-10 when cold tonight rebuilds blew the 60s Edge wall, which is why KV-first landed; 2026-06-10 CLV data is permanently missing. Matches prices to today's `shadow_plays` by `shadowId` (only rows with `price_pre_at IS NULL`), batch-upserts `kalshi_yes_price_pre`/`kalshi_no_price_pre`/`price_pre_at`. The unstamped-rows SELECT goes through the pooled primary (`{write:true}` — read-after-write of rows the snapshot cron inserted earlier today; the 03:00 UTC run is the coldest Neon touch of the day) and logs `unstamped rows=N` — a Neon failure is logged, not silently swallowed into `updated:0`. `?dry=1` runs everything except the DB write and returns `{source, stagingAgeMs, wouldUpdate, skipped}` — use it to verify without stamping mid-game prices as "pregame". CLV = bet-side `price_pre - price_snap`; positive = market confirmed the model direction.

---

## Data Plumbing Gotchas

**gameTimes lookup chain** (in play loop): `sport:team:gameDate` → `sport:team:tomorrowISOStr` → bare `sport:team`.

**`_mlbMlContext` null-gameDate fallback (2026-05-29)**: KXMLBTOTAL tickers routinely have unparseable date segments. Context stored as `_mlbMlContext["HOME|AWAY|null"]`. All context lookups chain `?? _mlbMlContext["t1|t2|null"] ?? _mlbMlContext["t2|t1|null"]` fallback. Symptom if broken: F5/spread/ML plays absent; totalRuns plays present with `gameDate: null`.

**Kalshi MLB postponed-ticker reattribution**: When a game is rained out Kalshi reuses the original ticker. After `sportByteam.mlb` hydrates, `_mlbNextGameByTeams` is built from `state === 'pre'` gameScores entries; `_reattrMlbGameDate` overwrites stale dates on market arrays. Resolved markets (extreme prices) are skipped to prevent yesterday's settled prices from being misattributed.

**Closing-line snapshots** (`mlbClosingOdds` / `nbaClosingOdds` / etc.): ESPN returns empty `odds` once a game is in/post. Redis key per sport holds the last-seen pre-game line. `state==='pre'` writes; `state==='in'|'post'` overlays back. 36h TTL. If no snapshot exists for an in/post game, odds entries are **cleared** rather than shown (model-derived mid-game prices look like real lines but mislead).

**`mlbMeta.gameOdds` vs `mlbMetaTomorrow.gameOdds`**: Today's odds from `parseGameOdds(sbData.events)`; tomorrow's from `parseGameOdds(sbData.eventsTomorrow)`. Both normalized through `MLB_ESPN_NORM`. `MatchupCard` selects by `game.gameDate` vs PT today.

**Kalshi-derived MLB odds fallback**: ESPN doesn't post tomorrow's lines until close to first pitch. Already-fetched `KXMLBGAME`/`KXMLBTOTAL` arrays fill missing fields on `_mlbGameOdds`/`_mlbGameOddsTomorrow` only — ESPN stays authoritative when present.

**`{sport}Meta.topPlayers[abbr]`**: `{ name, id, headshot, stats }` from ESPN scoreboard `competitions[].competitors[].leaders` by `parseTopPlayers` in `api/lib/utils.js`. NBA/WNBA: `RAT` leader; NHL: `Points` leader (derives G or A from secondary leaders when present).

**byteam:mlb partial-cache trap**: MLB byteam hydrates several API calls in parallel and each `.catch(() => ({}))` silently. Short-TTL guard (60s) fires when any of `lineupSpotByName`, `pitcherAvgPitches`, `hitterOpsMap`, `pitcherH2HStarts` is empty. Symptom: ReportPage Market tab columns null; diff cached vs `?bust=1` to confirm.

**Two-way players** (MLB strikeouts): ESPN gamelog defaults to batting stats. The play loop appends `&category=pitching` for K-market players. Separate cache keys (`gl:mlb242526pv1`, `gl:mlb2025p|`, `gl:mlb2026p|`) prevent batting/pitching collision. Without this, two-way players drop with `col_not_found`.

**ESPN gamelog endpoint**: ESPN blocks server-side HTML fetches with AWS WAF. Use the JSON API (`site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog`) for ALL sports.

**NBA lineup source chain**: (1) ESPN scoreboard → game summary boxscore starters (`lineupConfirmed:true`); (2) most recent **playoff** game first (`seasontype=3`), fallback to last regular-season `lastGameId`; (3) ESPN team roster. ESPN depth chart returns `{}` during playoffs — removed. Prefer playoff over RS — RS finals can have rested/bench starters.

**MLB lineup** (`/api/team`): (1) MLB Stats API `hydrate=lineups,probables` today → `lineupConfirmed:true`; (2) most-recent posted lineup from past-10-day schedule → `lineupConfirmed:false`; (3) active roster fallback. Probable-pitcher entry is preserved across (2).

**`mlbMeta.pitchers[abbr]` shape**: `{ name, id, era, wins, losses }`. `pitcherEra` is the two-step-regressed value (same as the lambda math uses), not raw season ERA. Sources merged in `api/[...path].js` ~line 4890: name/id/era from pitcherInfoByTeam → probables fallback.

**NHL_ABBR_MAP**: NHL Stats API teamIds → abbreviations. **UTA (Utah Mammoth) = teamId 68** (rebranded 2025-26; old teamId 53 absent). New teams showing `—` need their teamId added.
