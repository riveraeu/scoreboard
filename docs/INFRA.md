# Scoreboard — Infrastructure Reference

Storage, caching, deployment, env vars, testing, data sources, route contracts. Reference layer — dated post-mortems live in git/memory. Route purpose/auth also in the `api-routes` skill.

---

## Storage: Upstash Redis
On Vercel, `env.CACHE` (Cloudflare KV binding) is unavailable — `makeCache()` falls through to the Upstash REST client (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`).

**Free tier 500k commands/month** — when exceeded, reads/writes silently return null (`cmd()` extracts only `result`). Diagnose: `curl -H "Authorization: Bearer <ADMIN_KEY>" .../api/auth/debug-redis`.

User auth (`user:{email}`) and picks (`picks:{userId}`) share this Redis. JWT expires after 365 days. Picks also mirrored to `localStorage`, restored to server if server returns 0 but local has data.

---

## Cache keys & TTLs

| Key | TTL | Notes |
|---|---|---|
| `byteam:mlb` | 600s | Probables, lineup K-rates, pitcher avg pitches/BF. Excludes `barrelPctMap`. 60s short-TTL guard when any of `lineupSpotByName`/`pitcherAvgPitches`/`hitterOpsMap`/`pitcherH2HStarts` is empty (independent MLB Stats API calls fail silently via `.catch(() => ({}))`; the guard stops partial data baking for 10 min). |
| `byteam:nba` / `:scoring` | 1800s / 21600s | Defensive stats / offensive PPG |
| `byteam:wnba` / `:scoring` | 21600s | 2025 season. Same `buildSoftTeamAbbrs`/`buildTeamRankMap` helpers as NBA. |
| `byteam:nhl` | 21600s | GAA + SA per team |
| `byteam:nfl` | 1800s | |
| `kalshi:snap:{ticker}` | 300s | Per-ticker snapshot from `/api/kalshi-snapshot` cron (every 10 min since 2026-08-17, was every 2 min). Value `{markets, writtenAt}`. `/api/tonight` reads via MGET, uses snaps only if all within 900s (all-or-nothing). Bypassed by `?bust=1`. (Carried a top-3 `_depth` orderbook snapshot until 2026-08-13 — deleted, see below.) |
| `kalshi:snap:_meta` | 600s | `{lastRunAt, successCount, failedTickers[], durationMs, snapWriteFailed}`. Surfaced as `kalshiSnap` in `?debug=1`. **`null` meta = no cron in ~20 min → cron-side failure** (was 10 min at the old 2-min cadence). Overwritten every 10 min, so it can only ever answer "is the cron alive now" — anything that must survive the night needs its own key (see `maker:quotepass:{ptDate}`). |
| `maker:quotepass:{ptDate}` | 48h | Redis **HASH**, the maker quote pass's durable per-day record (`quotePassTelemetryCommands`, `api/lib/maker.js`). Counters `cycles`/`ran`/`skippedNoStaging`/`skippedNoSnaps`/`errors`/`sumEligible`/`sumOpened`/`sumClosed` + `last*` fields. Written every cron cycle via `HINCRBY` (**never GET/SET** — overlapping cycles must not clobber each other). Read by `/api/shadow-report` into `dataFreshness.quotePass`. **48h, not 600s like `_meta`**: the whole point is to survive the night so the 6am report can explain an overnight collapse. |
| `kalshi:bundle:{date}` | 600s | Legacy all-series bundle; second-tier fallback below snaps. Bypassed by `?bust=1`. |
| `kalshi:stale:{ticker}` | 1800s | Stale-while-revalidate per-ticker fallback for 429/empty. Series disappears rather than serving 30+ min old prices. |
| `kalshi:KXMLBGAME` | 600s | Legacy MLB game-ML bundle; tier-2. |
| `gameTimes:v2:{date}` | 600s | `sport:team:ptDate` AND bare `sport:team` (first wins). Built from yesterday+today+tomorrow ESPN scoreboards. Cleared by `?bust=1`. |
| `nba:pace:2526` / `wnba:pace:2025` | 12h | Pace + OffRtg/DefRtg (+ leagueAvg / PPG). Cleared by `?bust=1`. |
| `wnba:dvp:2025:{date}` | 12h | Stat-allowed DVP, server-aggregated from prior-season gamelogs. Flat (no per-position split). |
| `wnba:injuries:{date}` | 1800s | ESPN injuries (Out + GTD) |
| `wnba:usg:{playerId}:2025` | 6h | Per-player USG%, falls back to `(avgFGA + 0.44·avgFTA + avgTO)/(avgMin×1.88)`. |
| `nba:depth:{date}` | daily | |
| `nba:starters:{date}` | 600s | Per-game ESPN boxscore starters; `{confirmedTeams, startersByTeam}`. Feeds `lineupConf`. Empty pre-game (correct signal). Cleared by `?bust=1`. |
| `mlb:barrelPct` | 6h | Baseball Savant CSV |
| `mlbSchedTomorrow:{date}` | 600s | Tomorrow's MLB probables |
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
| MLB Stats API | Schedule, lineups, pitcher stats, aggregates, splits | ✅ |
| ESPN APIs (`site.web.api.espn.com`) | Player info, gamelogs (all sports) | ✅ |
| ESPN scoreboard | Probables, game odds, weather, scores, series | ✅ |
| Baseball Savant | Barrel% CSV | ⚠️ 5s timeout, cached 6h |
| ESPN DVP, depth chart | DVP, NBA position | ✅ |
| ESPN `sports.core.api.espn.com` | NBA pace + OffRtg/DefRtg | ✅ cached 12h |
| stats.nba.com | — | ❌ blocks server-side |

---

## Deployment
- Vercel Node runtime / Fluid Compute. `maxDuration: 300` via the `functions` block in vercel.json. `runtimeCtx.waitUntil` is the real `@vercel/functions` waitUntil (backgrounded work survives the response). Auto-deploys on `git push origin main`; frontend built via `npm run build`.
- Rewrites in `vercel.json`: `/api/:path*` → `/api/[...path]`. CORS headers there too (required for OPTIONS preflight).

### Crons

Full schedule with pairing constraints below. Handlers:
- `/api/keepalive` — daily noon UTC; keeps Upstash from idle-suspending. DST-exempt.
- `/api/kalshi-snapshot` — `*/10 * * * *` (widened from `*/2` 2026-08-17 — see Neon compute-cost note below); pre-warms `kalshi:snap:{ticker}` (~29s for 120 series at 3/700ms), then runs the maker quote pass. Chunked pipeline (7MB). Bearer `CRON_SECRET`. DST-exempt.
- `/api/kalshi-series-scan` — `45 12` (5:45am PT, 15 min before the report). Diffs Kalshi's `series?category=Sports` catalog against `SERIES_CONFIG`∪`CRON_ONLY_TICKERS`; records unknowns in Neon `kalshi_series_seen` (status funnel new→shortlisted→adopted/dismissed/baseline). Screens + auto-dismisses dead books; sweeps baseline backlog. `?dry=1`, `?dismiss=`/`?promote=`. Detail → `api-routes` skill.
- `/api/polymarket-scan` — **no cron** (schedule dropped 2026-07-28); endpoint still reachable with `ADMIN_KEY`. Polymarket capture (`polymarket_plays`) runs inline in `shadow-snapshot`, not here.

### Cron schedule, dependencies & DST policy

Vercel crons are **UTC-pinned**; all timing intent is **Pacific wall-clock**. When DST ends every cron fires one hour earlier in PT. **Policy: re-pin in November** (checklist below). Relative offsets between paired crons are UTC and preserved automatically.

| UTC (current) | PDT intent | Path | Pairing constraint |
|---|---|---|---|
| `0 15` | 8:00am | `/api/tonight` | — |
| `5 15` / `10 15` | 8:05/8:10am | `/api/shadow-snapshot` | trails the `0 15` tonight by 5–10 min |
| `45 12` | 5:45am | `/api/kalshi-series-scan` | BEFORE the `0 13` report (15 min ahead) |
| `0 13` | 6:00am | `/api/shadow-report` | trails the `50 12` resolver by 10 min; runs after the `45 12` scan |
| `55 16` | 9:55am | `/api/tonight` | — |
| `0 17` | 10:00am | `/api/shadow-pregame-snap` | trails the `55 16` tonight by ~5 min |
| `25 19` | 12:25pm | `/api/tonight` | fills the 10am→3:10pm pregame gap (day games) |
| `30 19` | 12:30pm | `/api/shadow-pregame-snap` | trails the `25 19` tonight; morning-staging recovery |
| `0 22` | 3:00pm | `/api/tonight` | — |
| `5 22` / `35 22` | 3:05/3:35pm | `/api/shadow-snapshot` | trails the `0 22` tonight |
| `10 22` | 3:10pm | `/api/shadow-pregame-snap` | trails the `0 22` tonight |
| `25 0` | 5:25pm | `/api/tonight` | pre-evening-game freshness |
| `30 0` | 5:30pm | `/api/shadow-pregame-snap` | trails the `25 0` tonight; late-listed markets |
| `55 2` | 7:55pm | `/api/tonight` | — |
| `0 3` | 8:00pm | `/api/shadow-pregame-snap` | trails the `55 2` tonight |
| `0 9` / `5 10` / `50 12` | 2am / 3:05am / 5:50am | `/api/shadow-resolver` | after games final; `50 12` is the final sweep, 10 min before the report |
| `0 12` keepalive · `*/10` kalshi-snapshot | — | | DST-exempt, never shift |

**November 1, 2026 checklist (DST ends):** add +1h UTC to every row except the DST-exempt line, keeping minute offsets identical so pairings hold. Reverse (−1h) when DST returns 2027-03-14. Update this table's UTC column in the same commit.

### Required env vars
Set in the Vercel dashboard AND wired via the explicit `env` object in `api/[...path].js` (CLAUDE.md "env-var wiring" gotcha).

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | HMAC for auth tokens (`openssl rand -base64 32`) |
| `ADMIN_KEY` | Admin endpoint shared secret |
| `CRON_SECRET` | Vercel Cron bearer auth |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Upstash REST endpoint + token |

No hardcoded fallbacks. Missing `JWT_SECRET` → 500 on auth; missing `ADMIN_KEY` → 403 on admin (fail-closed). Redeploy after rotating.

---

## Testing
```
osascript -l JavaScript api/lib/simulate.test.jxa.js   # no Node — macOS JavaScriptCore
node --test api/lib/simulate.test.js                    # if Node installed
```
Both kept in sync. `npm test` runs the Node suite (simulate, utils, parse-teams, dedup, config bounds, settlement, etc.).

---

## Route Contracts

### `/api/tonight`
Main play generation. `?debug=1` returns `plays[]`/`dropped[]` + per-league market counts, `qualifyingCount`/`totalMarketsCount`, `fdProbe`, `kalshiSnap`; `?bust=1` bypasses caches. 2-min poll in `App.jsx` (`POLL_MS=120_000`), paused when hidden; manual ↻ is the only `?bust=1` path. **Edge SWR:** the normal response sets `Cache-Control: public, s-maxage=120, stale-while-revalidate=86400` so the CDN serves fresh for 2 min then instant-stale up to 24h while revalidating — removes the ~7s synchronous assembly from most loads. `?bust=1`/`?debug=1` stay `no-store`.

### `/api/kalshi-order`
`POST`, bearer JWT. Body `{ ticker, side, price(1–99), count }`. Signs RSA-PSS / SHA-256 / saltLength=32 with `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY`; message `timestamp_ms + "POST" + path` (no body). **V2 event-order endpoint** `external-api.kalshi.com/trade-api/v2/portfolio/events/orders` — one book quoted in YES terms (`side:"bid"` = buy YES; `side:"ask"` = buy NO at the complement). Handler is the translation chokepoint: client body unchanged, V2 response normalized back to the legacy `order` shape. Reads (markets/orderbook/balance/fills) stay on legacy `api.elections.kalshi.com` paths.

### `/api/kalshi-balance`
`GET`, authenticated. `{ cashCents, positionsCents, balanceCents, balanceDollars }`. `balanceDollars` = cash + open-position cost basis (sum of `market_exposure_dollars`). Cost basis, not mark-to-market. No caching.

### `/api/kalshi-snapshot`
Cron-only. Fetches all series (3 parallel / 700ms, ~29s for 120) → writes snaps + `_meta` → runs the V1 maker quote pass and its telemetry. Ticker list from `[...Object.keys(SERIES_CONFIG), ...CRON_ONLY_TICKERS]`.

**Neon compute-cost note (2026-08-14, widened 2026-08-17):** Neon's autosuspend timeout (5 min, fixed on Free/Launch) never fires while anything pings faster than that, so this cron running at `*/2` kept compute continuously awake at the 0.25 CU floor (~$20/mo). The V1 quote pass here is the dominant ping (V2's resolve/grade pass was cadence-gated to `getMinutes() % 10 === 0` on 8/14, which alone didn't cross the 5-min threshold). Widened to `*/10` on 8/17 after the account hit its actual monthly compute+storage allowance — this crosses the autosuspend threshold (should collapse the floor toward single dollars) but widens V1 quote/fill-detection lag from ~2 min to ~10 min for the live prereg wave (checkpoints 8/20-8/24), accepted knowingly rather than left to run the account out of compute.

**Orderbook-depth phase DELETED 2026-08-13.** It attached a cached top-3 `_depth` per in-window market for `blend-fill.js` to re-price against. It had **never executed a single fetch**: `DEPTH_DEADLINE_MS` (21s) was measured from a clock the series walk had already spent ~29s of, so the loop broke on iteration 0 every cycle — `depthFail: 0` proved no fetch was even attempted. Deleted rather than repaired, because `blendMarketPrice` **mutated the captured price** (`m.kalshiPct = blended.pct`) at the parse site: making depth work again would have silently shifted every `shadow_plays` price mid-window, under 14 live pre-registrations. Slippage is still measurable via the live full-book walk (`/api/kalshi-orderbook` → `walkFill`), which is the honest version.

### `/api/auth/shadow-stats`
`GET`, admin bearer. Row counts by date/category/dc + `unresolvedByCategory`. `?trigger=1` runs shadow-snapshot inline; `?resolvetrigger=1` runs shadow-resolver.

### `/api/auth/clear-kalshi-stale`
`POST ?ticker=…` (ADMIN_KEY). Deletes `kalshi:stale:{ticker}`; does not touch `kalshi:snap:{ticker}`.

### `/api/shadow-snapshot`
Cron-only. Reads `shadow:staging:{date}` from KV first (written by tonight on every recompute, TTL 6h, payload `{plays, dropped, schedule, writtenAt}`), falls back to `/api/tonight?debug=1` (55s). Combines `plays + dropped`, annotates `group_id`/`threshold_rank` (rank 1 = closest to 50% truePct; team rows key **stat-first** = `p.stat || p.gameType`, matching `COALESCE(stat, game_type)`), batch-upserts to Neon `shadow_plays`. **Coverage check:** compares distinct logged games (`sport|sortedPair`, only `game_date === snapshotDate` rows) against ESPN's stamped game count; returns `coverage`/`coverageWarning` (warn-only below 80%), persisted to KV `shadow:coverage:{date}` via **max-merge** (`mergeCoverage`) so late/manual runs can't clobber the cron stamp. `?rerankgroups=1` (ADMIN, `&dry=1`) re-ranks all team-row groups (idempotent). `?backfillgamedate=1` (ADMIN, `&dry=1`) repairs NULL-`game_date` rows off the ticker.

### `/api/shadow-resolver`
Cron-only (2am/3:05am/5:50am PT). Queries Neon for unresolved prior-day rows via the pooled primary (`neonQuery {write:true}` — read-after-write). Self-calls `/api/live` per distinct game_date via `fetchLiveInto()` (30/15/12s timeouts + one retry on abort/non-OK + `console.error` on failure — a cold-start abort must never be swallowed into 0 games). Applies resolution (props, totals, teamTotal, ML, spread, F5, NBA halves), batch-updates. Uses `selfOrigin(request)` (pins `PROD_ORIGIN`; deployment URLs 302 to SSO). 4-pass name lookup (exact → diacritic-strip → period/suffix-strip → Levenshtein ≤2). Date ladder: `game_date` → ticker date → PT from `game_time` → `snapshot_date`. **Abandonment:** rows unresolved 14+ days → `resolved=TRUE, won=NULL`. Settlement grading applied at one reconcile chokepoint (below).

### `/api/shadow-pregame-snap`
Cron-only (5 passes). Reads `shadow:staging:{date}` (rejects if `writtenAt` > 15 min old — CLV prices must reflect now); falls back to `/api/tonight` HTTP (45s, the fragile path — pair each pass with a tonight write 5 min ahead). Matches prices to today's `shadow_plays` by `shadowId` (rows with `price_pre_at IS NULL`), stamps `kalshi_yes_price_pre`/`kalshi_no_price_pre`/`price_pre_at`. CLV = bet-side `price_pre − price_snap` (positive = market confirmed direction). Per-run breadcrumb → KV `shadow:pregame:{date}` (`?runs=1`). `?dry=1` skips the write. Capture health measured over the `snapshot_date` cohort (`dataHealth.clvCapture`, ~95%/day).

### `/api/shadow-report`
Cron (6am PT). Morning briefing → `dataHealth` (coverage + resolution + CLV), `brief` (deterministic daily prose diffed vs yesterday's KV report), `makerBoard`. Cached `shadow:report:{date}` 25h (15 min when resolution <90%). Resolution read is cold-wake-hardened (KV floor + robust cross-conn max; resolved is monotonic). Auth CRON_SECRET/ADMIN/JWT; `?bust=1` regen. `?makerDay=YYYY-MM-DD` returns a single-day V1 maker drilldown and short-circuits before the report cache. Heavy — read `docs/FRONTEND.md` + memory before touching.

---

## Shadow maker engine (`api/lib/maker.js`)

Simulated maker quoting — **V1 is measurement-only, no real orders**. Thesis: the venue's vig sits on the favorite ask (2–8¢ above realized frequency at 80–97¢); maker fees are zero on every configured series except the four `*GAME` series (`MAKER_FEE_SERIES`). Three phases:
- **Quote** — tail of `/api/kalshi-snapshot` (books already in hand). Eligibility (`computeMakerQuote`): fee-free series, all four book quotes present, unified spread ≤ `CAPTURE_MAX_SPREAD`, neither ask ≥98, known future `gameTime` (pre-game only), favorite ask ∈ `MAKER_BAND`. Quote = sell at ask − `MAKER_INSIDE_C` (1¢), size `MAKER_SIZE` (10). Segments in Neon `maker_quotes` (open row/ticker; price change closes `valid_to` + opens new). Each stamps `shadow_row_id` (`shadowId` from `shadow-id.js`).
- **Fill** — nightly in `/api/shadow-resolver` (`detectAndGradeMakerFills`, failure-closed): replays the public trade tape; a taker trade on our sold side at price ≥ our ask inside a segment window is a simulated fill. Idempotent via `UNIQUE(quote_id, trade_id)` in `maker_fills`.
- **Grade** — joins ungraded fills → `maker_quotes.shadow_row_id` → resolved `shadow_plays`; `pnl_cents = fill_ask − 100·side_won`.

`shadowId()` (`shadow-id.js`) keys on `sport|gameDate|homeTeam|awayTeam|playerName|stat|threshold|direction|pickTeam|scoringTeam` — `scoringTeam` is load-bearing (team-total plays don't set `pickTeam`, so two teams' same-threshold totals collided without it). Forward-only re-keying — historical rows not re-keyed.

**`computeSideWon()` (exported)** is the single shared win-derivation. For `game_type='spread'` it checks `pick_team` against `marginTeamOf(ticker)` before flipping `won` (the emit-side edge-dominance pick and the maker-side price-based `quote_side` are independent selections that can diverge); every other game_type uses `direction`-based logic. Used by fill grading and the `quotedOutcomes` diagnostic.

**Arm criterion for V2** (`armCriterion.met`): n≥200 fills AND ≥14 days AND `dayClustered.loCI > 0`. The **day-clustered CI** (`dayClusteredPnl`, `maker-stats.js`) uses the DAY as the cluster, not the fill — V1 sells favorites, so a day's PnL is essentially one correlated bet on whether favorites underperformed; the honest sample size is days, not fills. It widens the fill-level CI ~4.5×. The old fill-level `pnlLoCI_fillLevel_SUPERSEDED` is NOT the gate (it produced false greens) — the one legitimate consumer is the adverse-selection banner's negative-interval check.

**Adverse selection** (`makerBoard.adverseSelection` + `quotedOutcomes.byBand`) is measured within band over **every segment**, grouped `(band, ticker, quote_side)` and segment-weighted. Band `CASE` lives in `_makerBandCase()` — both sides must bucket identically. `quotedOutcomes.n` is **segments**, not ticker-days (use `.tickers` for a market count).

### Maker V2 — SHELVED
The measurement program concluded: **no demonstrated fillable edge.** The only effect that replicated every time is the **quote-side vig** (~+1.5¢ over 100k+ segments) — it has never been shown to survive to a *fill*. `SHELVED = true` in `api/lib/maker-live.js` short-circuits `isArmed()`; `/api/maker-v2-arm` 409s. Enforced in code, not config (the KV/env arm flags stay intact so un-shelving is a one-line change; `maker-live.test.js` pins the shelved state). **Do not re-open by re-slicing the same days — slicing is 0-for-6.** Re-entry needs genuinely new data or a mechanism specified in advance (`docs/REENTRY.md`, `docs/MAKER_LEADTIME_PREREG.md`).

V2 (`maker-live.js`, `armed=false`) is real resting orders scoped to `MAKER_V2_BAND [80,84]`, via shared `kalshi-order-client.js`. Two independent gates (`env.MAKER_V2_ARMED === "true"` AND KV `maker:v2:armed`); `/api/maker-v2-kill` disarms + cancels all resting orders. `/api/maker-v2-board` reads the ledger + live positions. Not deleted — `kalshi-order-client.js` is shared with the manual `/api/kalshi-order` path.

**What still runs (2026-07-28):**

| half | state | why |
|---|---|---|
| V1 **quoting** (snapshot cron) | **ON** | Free — cron holds the books; the vig is the one replicated effect. |
| V1 **tape replay** (nightly) | **ON** (`TAPE_REPLAY_ENABLED`, re-enabled 7/29) | The ONLY thing that writes `maker_fills`; instruments stay running so the record isn't frozen going into the NFL re-entry catalyst. Gap repair: `/api/shadow-snapshot?makerDetectDay=YYYY-MM-DD` (takes `force`). |
| V1 **grading** (nightly) | **ON, self-limiting** | Drains the ungraded backlog, then one cheap Neon query/night. |
| `?makerBackfill=YYYY-MM-DD` | on-demand | Replays historical MLB-prop days (`&offset=`-resumable; `&validate=1` compares vs the live cron). One day is live OR replayed, never both (`maker_quotes.source` + a 409 guard). |

---

## Settlement grading — AUTHORITATIVE for shadow-only sports

Every Kalshi market carries its own `result` (`"yes"`/`"no"`, or `"scalar"` = void) once settled. Gate cleared at 99.92% agreement (n=2560); the residual is Kalshi's own operational accuracy, not our matching error (a disagreement does NOT imply Kalshi erred — **only settlement knows the paid outcome**).

`shadow_plays` carries `kalshi_ticker` + `kalshi_side` (populated at the shadow-snapshot chokepoint via `deriveKalshiSide(p)`). Grading merges at **one chokepoint** in the resolver (`reconcileGrades`, `settlement-reconcile.js`) immediately before `neonBatchResolve`:

- **Settlement authoritative** for the 14 `SETTLEMENT_AUTHORITATIVE_SPORTS` (tennis, soccer, fight, golf, nascar, nbasl, lmb, mls, brasileirao, nwsl, chnsl, ligamx, scocup, argprem) — ROI is the only thing these rows measure, and settlement IS what a position was paid.
- **Calibrated `teamRows`** (MLB/NBA/WNBA/NHL/NFL) stay ESPN-graded; settlement runs as the `kalshiDryRun` comparison. For model accuracy, physical reality is ground truth.
- **Void (`result:"scalar"`)** → `won=NULL`, resolved immediately; **overrides even a real ESPN grade** (a voided market contributes nothing to ROI).
- Everything else passes through as ESPN graded it (strict no-op for calibrated families).

Phase B (2026-07-30) deleted the 11 per-sport ESPN resolution blocks — shadow-only sports grade off settlement ONLY. Pre-2026-07-23 tickerless shadow-only rows lose their grading path and abandon to `won=NULL` (low-volume, no money).

**Fetch telemetry is load-bearing.** `fetchKalshiSettlementsWithMeta` batches tickers by encoded query length (`MAX_TICKER_QUERY_CHARS` 6000, not count — a 200-ticker chunk can cross the ~8KB URL ceiling → HTTP 414) with 3 retries per chunk (fresh `AbortSignal` each, fail-fast on deterministic 4xx). **Read `incomplete` before any agreement number** — `true` means denominators are a floor and `disagree:0` proves nothing. Circularity guard: authoritative-sport rows resolved on/after `SETTLEMENT_CUTOVER_DATE` are excluded from `agree`/`disagree` (their `won` was written by settlement). Failure-closed: a fetch throw drops every row to the ESPN path unchanged.

**Tripwires** on the resolver response: `kalshiGrading.{graded, voided, voidedOverridingEspn, agreedWithEspn, disagreed, espnCouldNotGrade, incomplete}`, `noDataNetOfSettlement` (= `noData − espnAbsent`, the real "still unresolved"), `guessedDateRows` (must be 0 for rows after 2026-07-23), `postponedMakeup.*`. On-demand check: `/api/kalshi-dryrun-check` (ADMIN).

**Postponed/makeup + cross-day guards** (`settlement-reconcile.js`, unit-tested): `isNonFinalTerminal(game)` (ESPN reports POSTPONED/CANCELED as `state:"post"`, `completed:false`, 0-0) and `isMakeupReattributed(row)` flag rows the ESPN feed can't resolve correctly; they drop from the ESPN loop and settlement is authoritative for them. `completed === false` must never be relaxed to falsiness; the makeup test stays strictly forward. Repairs: `/api/shadow-snapshot?regradepostponed=1` / `?backfillgamedate=1` (`&dry=1`, `&days=N`).

---

## Data Plumbing Gotchas

**Global fetch concurrency gate (`api/lib/fetch-limit.js`).** The instance has a 1024-fd ceiling; total open sockets ≈ the sum of every module's peak `Promise.all` burst width (idle pooled sockets linger, invisible to `getActiveResourcesInfo`). Crossing it makes EVERY outbound fetch fail (`TypeError: fetch failed`, cause `EMFILE`/`EBUSY`) while single-fetch routes stay healthy (that asymmetry is the diagnostic). A 64-slot `pLimit` wraps `globalThis.fetch`, side-effect-imported as the FIRST line of `api/[...path].js`. On top: `pLimit(n)` (`utils.js`, n≈16–20) for wide loops, `cache.getMany` (chunked MGET) for per-key KV reads. **Don't add a fetch path that bypasses global `fetch`.** Diagnose via `?debug=1` → `fdProbe` milestones.

**gameTimes lookup chain** (play loop): `sport:team:gameDate` → `sport:team:tomorrowISOStr` → bare `sport:team`.

**gameTimes from a DEDICATED scoreboard fetch + gameScores backfill.** The `gameTimes` map is its own ESPN fetch, separate from per-sport `gameScores`. A silent 429/timeout (`.then(r => r.ok ? r.json() : {})`) → empty map → every play `gameTime:null` → duplicate cards + started-game drop no-ops. Self-heals next request (cache not written when empty). A backfill loop before `emitPropPlays` fills absent keys from `gameScores`. Diagnose: `curl .../api/tonight | jq '[.plays[]|.gameTime]|unique'` — all-null means BOTH fetches were empty.

**`gameTimes` horizon = yesterday…D+2.** D+2 events return as a SEPARATE `eventsDayAfter` array read ONLY by the gameTimes loop — every other `events` consumer keys by TEAM with last-event-wins, so folding D+2 in would overwrite nearer games.

**`_mlbMlContext` null-gameDate fallback.** KXMLBTOTAL tickers routinely have unparseable date segments; context stored as `_mlbMlContext["HOME|AWAY|null"]`; lookups chain `?? "t1|t2|null" ?? "t2|t1|null"`. Symptom if broken: F5/spread/ML absent, totalRuns present with `gameDate:null`.

**Kalshi MLB postponed-ticker reattribution.** Rained-out games reuse the ticker. `_mlbNextGameByTeams` (from `state==='pre'` gameScores) + `_reattrMlbGameDate` overwrite stale dates; resolved markets (extreme prices) skipped so yesterday's settled prices aren't misattributed.

**Closing-line snapshots** (`{sport}ClosingOdds`). ESPN empties `odds` once a game is in/post. Per-sport Redis key holds the last pre-game line; `state==='pre'` writes, `in`/`post` overlays back (36h TTL). No snapshot for an in/post game → odds **cleared**, not shown (model-derived mid-game prices mislead).

**Kalshi-derived MLB odds fallback.** ESPN posts tomorrow's lines late; already-fetched `KXMLBGAME`/`KXMLBTOTAL` fill missing fields on `_mlbGameOdds*` only — ESPN stays authoritative when present.

**byteam:mlb partial-cache trap.** MLB byteam hydrates several calls in parallel, each `.catch(() => ({}))`. 60s short-TTL guard fires when any of `lineupSpotByName`/`pitcherAvgPitches`/`hitterOpsMap`/`pitcherH2HStarts` is empty. Symptom: ReportPage Market columns null; diff cached vs `?bust=1`.

**Two-way players** (MLB strikeouts). ESPN gamelog defaults to batting; the K-market loop appends `&category=pitching`. Separate cache keys (`gl:mlb…p…`) prevent batting/pitching collision — without it two-way players drop `col_not_found`.

**ESPN gamelog endpoint.** ESPN blocks server-side HTML (AWS WAF). Use the JSON API (`site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog`) for ALL sports.

**NBA lineup source chain:** ESPN scoreboard boxscore starters (`lineupConfirmed:true`) → most recent playoff game (`seasontype=3`) → last RS `lastGameId` → team roster. Depth chart returns `{}` in playoffs. Prefer playoff over RS (RS finals rest starters).

**MLB lineup** (`/api/team`): MLB Stats API `hydrate=lineups,probables` today (`lineupConfirmed:true`) → most-recent posted lineup (past-10-day) → active roster. Probable pitcher preserved across fallback.

**`mlbMeta.pitchers[abbr]`** = `{ name, id, era, wins, losses }`. `era` is the two-step-regressed value, not raw season ERA. Merged from pitcherInfoByTeam → probables fallback.

**NHL_ABBR_MAP.** NHL Stats API teamIds → abbreviations. **UTA (Utah Mammoth) = teamId 68** (rebranded 2025-26; old 53 absent). New teams showing `—` need their teamId added.
