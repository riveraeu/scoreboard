# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Scoreboard — Project Guide for Claude

## Commands

```bash
npm run dev        # Vite dev server — proxies /api to production (see vite.config.js)
npm run build      # Production build → dist/
npm test           # Node.js test runner on api/lib/simulate.test.js
npm run test:jxa   # osascript JXA version of the same tests (macOS only)
git push origin main  # Deploys to Vercel automatically
```

Admin/debug one-liners (pull ADMIN_KEY via `vercel env pull`):
```bash
# Verify tonight's play generation
curl -s "https://scoreboard-ivory-xi.vercel.app/api/tonight?debug=1" | jq '.plays | length'
# Trigger shadow snapshot manually
curl -s "https://scoreboard-ivory-xi.vercel.app/api/auth/shadow-stats?trigger=1" -H "Authorization: Bearer $ADMIN_KEY" | jq '.trigger'
# Trigger shadow resolver manually
curl -s "https://scoreboard-ivory-xi.vercel.app/api/auth/shadow-stats?resolvetrigger=1" -H "Authorization: Bearer $ADMIN_KEY" | jq '{resolved, skipped}'
```

---

## Workflow for New Features and Debugging

1. **Check memory and CLAUDE.md** — Read `MEMORY.md` and relevant memory files. Scan CLAUDE.md for the area being changed; load `docs/MODEL.md`, `docs/INFRA.md`, or `docs/FRONTEND.md` if the change touches those areas.
2. **Plan and get approval** — Present the full plan as text only (files to change, logic, edge cases). Wait for explicit user approval before editing any files.
3. **Implement** — Make the changes. If backend logic changed, confirm with `/api/tonight?debug=1` (or relevant endpoint) and print key fields proving the change is correct.
4. **Deploy and document** — `git push origin main` to deploy. Update CLAUDE.md (and the relevant `docs/*.md`) in the same commit. Save a memory entry for anything non-obvious future sessions should know.

---

## What This Is
Sports prop betting dashboard that pulls Kalshi prediction market prices, computes a model True%, and shows qualified plays with edge over the market. Vercel Edge runtime (Web Fetch + KV/Redis only — no Node APIs).

**Production**: `https://scoreboard-ivory-xi.vercel.app`
**Universal qualification**: Kalshi 67–91% · Edge ≥ 5% (client) / ≥ 3% (server, kept loose for calibration data). Game/team totals gate UNDERs by the same `noKalshiPct ∈ [67, 91]` window. SimScore is display-only since v1 was dropped 2026-05-26. Tunables live in **one source** at `api/lib/config.js` (`KALSHI_GATE` 67, `KALSHI_CAP` 91, `EDGE_GATE_SERVER` 3, `EDGE_GATE_CLIENT` 5); both server (tonight.js) and client (App.jsx, LineupsPage.jsx, TotalsBarChart.jsx) import from there. All client surfaces gate display at EDGE_GATE_CLIENT (5).

**Model version**: Universal client qualification is `dcQualified === true && edge >= 5 && passesCategoryGate`. `dcQualified` means dc≥7 (gate lowered from 10 on 2026-06-04; only `kalshiStale` −4 and `playerOut` −10 fail). Data-completeness dc=10 requirement removed after shadow calibration showed fallback paths (team WHIP, projected lineups, modest samples) are better calibrated than full-data paths. SimScore is display-only. Client `EDGE_GATE = 5`; server `EDGE_GATE = 3` for calibration continuity. `trackPlay` stamps `modelVersion: "v2"`. The `qualified` field carries only alt-line-demotion semantics now.

**Category gate (2026-06-01)**: UI display is further restricted to categories with confirmed positive ROI (n≥50, working signal). Gate lives in `passesCategoryGate()` in `src/lib/constants.js` — applied in both `App._qualifiedFilter` and `LineupsPage.passesGate`. Currently allows: `mlb|spread` (truePct ≥ 80% — bands below 80% showed −2.9% ROI N=19 Results + −10.5% shadow; 2026-06-03), `mlb|hrr` (truePct ≥ 75% — 70-75% band shadow N=26 ROI −10.3% vs 75-80% shadow N=28 ROI +7.0%; 2026-06-03). Tracked picks bypass the gate so existing bets stay visible. Add new categories here only when shadow calibration confirms ROI>0 at n≥200.

---

## Where to look

| Topic | File |
|---|---|
| Per-sport modeling internals (SimScore tiers, lambdas, miscAdj, gates, Kalshi parsing details, dedup logic) | `docs/MODEL.md` |
| Cache keys + TTLs, Upstash storage, env vars, deployment, testing, data sources | `docs/INFRA.md` |
| URL routing, App.jsx state shape, ReportPage internals (Market Report + calibration Results), live tracking mechanics, sizing, color doctrine + per-play-type explanation table | `docs/FRONTEND.md` |
| Common debugging recipes | `docs/DEBUGGING.md` |

The cross-cutting gotchas at the bottom of this file are kept inline because they bite during *any* change, not just modeling work.

---

## Architecture

### API: `api/[...path].js` (router) + `api/lib/handlers/*.js` (routes) + `api/lib/*.js` (sport modules)
Single Vercel Edge Function. `api/[...path].js` is a ~140-line thin router: handles CORS preflight, calls `makeCache`, dispatches to one handler per route family. Route handlers live in `api/lib/handlers/`:
- `api/lib/handlers/auth.js` — `/api/auth/*`
- `api/lib/handlers/player.js` — `/api/player`, `/api/gamelog`, `/api/headshot`
- `api/lib/handlers/sports.js` — `/api/team`, `/api/live`
- `api/lib/handlers/dvp.js` — `/api/dvp`, `/api/nba-depth`, `/api/dvp/debug-dc`
- `api/lib/handlers/kalshi.js` — `/api/kalshi`, `/api/kalshi-snapshot`, `/api/keepalive`, `/api/kalshi-order`, `/api/kalshi-balance`, `/api/kalshi-fills`
- `api/lib/handlers/tonight.js` — `/api/tonight` (~1857 lines after Phase B6). Owns Kalshi parse loop, byteam hydration, data-prep, emit calls, response assembly.

Sport/utility modules under `api/lib/`:
- `api/lib/simulate.js` — park factors, all simulation functions (K/NBA/MLB/NHL/total dists), kelly/EV math
- `api/lib/mlb.js` — `buildMlbByteam` + `buildMlbInjuryReport`; re-exports from split modules below
  - `api/lib/mlb-shared.js` — `MLB_ID_TO_ABBR`, `_fs`
  - `api/lib/mlb-hitters.js` — `buildLineupKPct`, `buildBarrelPct`
  - `api/lib/mlb-pitchers.js` — `buildPitcherKPct` (regression, splits, gamelog batch)
- `api/lib/nba.js` — DVP, depth chart, pace, usage, injury, player-pos
- `api/lib/wnba.js` — pace, usage, injury, DVP; `WNBA_TEAM_IDS`; `WNBA_ESPN_TO_CANON`/`WNBA_CANON_TO_ESPN`
- `api/lib/nhl.js` — `buildNhlGoalieData`, `buildNhlInjuryReport`, `NHL_ABBR_MAP`
- `api/lib/utils.js` — CORS, `parseGameOdds`, `parseGameScores`, team rank helpers
- `api/lib/tonight/parse-teams.js` — `TEAM_NORM`, `normTeam`, `_VALID_TEAMS`, `parseGameTeams`
- `api/lib/tonight/props.js` — `emitPropPlays(ctx)` (~1667 LOC)
- `api/lib/tonight/game-totals.js` — `emitGameTotalPlays(ctx)` (~1225 LOC); returns `_*MlContext` maps
- `api/lib/tonight/ml-spread.js` — `emitAllMlAndSpread(ctx)` (~1231 LOC)

### Frontend: Vite + React (`src/`)
Entry: `index.html` → `src/main.jsx` → `src/App.jsx`. Vercel runs `npm run build` → `dist/` on push.

- `src/App.jsx` — top-level state, routing, data fetching, player card
- `src/lib/constants.js` — `TEAM_DB`, `TOTAL_THRESHOLDS`, `MOCK_PLAYS`, `GAMELOG_COLS`, sport/stat metadata
- `src/lib/utils.js` — `slugify`, `teamUrl`, `logoUrl(sport, abbr)` (ESPN CDN abbr fixes for NHL/NBA)
- `src/lib/liveStats.js` — live pick tracking helpers
- `src/lib/hooks.js` — `useIsMobile(threshold=600)`
- `src/lib/useReportData.js` — `reportDataBySport`, `calibData`/`fetchCalib`, `shadowCalibData`/`fetchShadowCalib(since?)`, `shadowAnalysisData`/`fetchShadowAnalysis(since?)` state + fetchers for ReportPage
- `src/components/` — `LineupsPage`, `MatchupCard`, `PlaysColumn`, `MyPicksColumn`, `ReportPage`, `TeamPage`, `TotalsBarChart`, `DayBar`, `AddPickModal`

**ReportPage tabs**: Market Report | Results | Shadow. Shadow tab renders `ShadowCalibModule` — category summary (N deduped/N raw / Hit% / ROI / Status) with click-to-expand band detail (55–60 through 95+). Since filter (30d/60d/All) re-fetches `/api/auth/shadow-calibration?bestThreshold=true` (always deduped: one prediction per player/matchup per group). Sport pills filter categories. `ACTIVE_CATS` Set inside `ShadowCalibModule` mirrors `passesCategoryGate()` — keep in sync when promoting a category. Status: Active (in gate) / Building (n≥50 ROI>0) / Losing (n≥30 ROI≤0) / Too few. **Correlation analysis** expandable (lazy-load) shows same-game pairwise φ table + alt-line unanimity table from `/api/auth/shadow-analysis`; auto-fetches when shadow tab opens.

**Dev proxy**: `vite.config.js` proxies `/api` to production so `npm run dev` works without local backend.

---

## Routes
- `/api/tonight` — main play generation. `?debug=1` returns dropped/preDropped + debug fields. `?bust=1` bypasses caches. Initial fetch is plain (snap-first path, ~few hundred ms). 2-min polling loop in `App.jsx` (`POLL_MS=120_000`); polling pauses when tab hidden. Manual ↻ button is the only `?bust=1` path.
- `/api/kalshi` — raw Kalshi market data
- `/api/player`, `/api/gamelog` — ESPN player info + gamelog
- `/api/team` — team page data (gameLog, lineup, season stats, nextGame)
- `/api/live` — in-game boxscore for pick tracking (`?games=mlb:LAD:SD,nba:GSW:LAL`). Wire format `sport:t1:t2@gameTimeISO` for DH disambiguation.
- `/api/dvp`, `/api/nba-depth`, `/api/dvp/debug-dc` — DVP/depth chart. Branches: `basketball/nba`, `basketball/wnba`, `football/nfl`, `hockey/nhl`, `baseball/mlb`.
- `/api/auth/{register,login,reset,list-users,debug-redis,calibration,clear-kalshi-stale}` — auth + admin. Password min 8 chars. Admin endpoints fail-closed if `ADMIN_KEY` missing.
- `/api/auth/clear-kalshi-stale` — `POST ?ticker=KXMLBTEAMTOTAL` with `Authorization: Bearer <ADMIN_KEY>`. Deletes `kalshi:stale:{ticker}` to force a fresh fetch on next cold build. Does **not** affect `kalshi:snap:{ticker}`.
- `/api/kalshi-order` — `POST`, authenticated. Body: `{ ticker, side: "yes"|"no", price: int (1–99), count: int }`. Signs via **RSA-PSS / SHA-256 / saltLength=32** with `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY`. **Signature message: `timestamp_ms + "POST" + "/trade-api/v2/portfolio/orders"`** (ms timestamp, path only, no body). Supports PKCS#1 and PKCS#8 PEM. Returns the full Kalshi `order` object; the frontend reads `taker_fill_count`/`taker_fill_cost` and stamps the tracked pick with the real fill (cost→`units`, avg price→`americanOdds`, plus `kalshiCount`/`kalshiAvgCents`/`kalshiRestingCount`). Filled cost/odds verified to match Kalshi to the penny 27/27 picks (2026-05-30 via `/api/kalshi-fills`); resting (0-fill) orders track at intended size with a note. **"Place All" batch (2026-05-31):** a ⚡ button in the `LineupsPage` toolbar (leftmost action button, before Picks; muted Research-style styling — `#30363d` border / transparent bg / `#484f58` text; shown only when `authEmail` + ≥1 candidate) opens a confirm modal and, on confirm, POSTs `/api/kalshi-order` sequentially (await each — avoids 429s) for every candidate, tracking each pick with its real fill via the same override shape as the single flow. Candidate set = `tonightPlays` (qualified) minus already-tracked (`trackIdFor` exported from `LineupsPage.jsx`) minus started games (`gameTime ≤ now`) minus unplaceable (no `kalshiTicker` / `count < 1`). Sizing (`_placeAllSizing` in App.jsx) mirrors the track-confirm modal's ⅛-Kelly on the **side actually bet** (UNDER uses `noTruePct` + `noKalshiPct`), $500 cap / $30 fallback. Modal warns on cash shortfall (`kalshiBalance`) but still allows placement — Kalshi rejects underfunded orders individually (row marked ✗).
  - **Pre-flight validation (Flow A, 2026-06-01):** every candidate runs through `validateCandidate(play, sizing, calibData)` in `src/lib/placeValidation.js` → `{ hard, soft }`. **HARD** failures exclude the pick from the batch (shown ✗ greyed, never ordered); **SOFT** failures annotate it (⚠) but it still places. `placeAllCandidates` keeps all rows (for display) + attaches `validation`; `placeAllPlaceable` = `hard.length === 0` and is what `runPlaceAll` orders + what the toolbar badge counts. Modal header summarizes `N ready · M flagged · K blocked`; totals/cost/button reflect placeable only. **Hard checks:** re-assert `dataConfidence===10 && dcQualified && edge>=EDGE_GATE_CLIENT` (catches slate drift since modal open), `kalshiTicker` present, `count>=1`, price in range, distinct matchup teams, **strong calibration overconfidence** (`byCategoryDetail` delta ≤ −10 with n ≥ 30 in the bet's truePct band). **Soft checks:** mild calibration overconfidence (delta ≤ −5, n ≥ 10), slippage ≥ 3¢ over top-of-book (#4, from `rawKalshiPct`/`rawNoKalshiPct`) or thin/wide-market proxy. `homeAwayResolved` removed — bet side is ticker-derived so the fallback only perturbs park factor/home-field slightly; not actionable at placement time. **Calibration lookup** reuses the already-loaded `calibData` (`useReportData`, bearer-optional); `onPlaceAll` triggers `fetchCalib()` if unloaded. Buckets start at 70, so UNDER candidates (stored over-side `truePct` < 70) skip the calibration check — the store buckets by over-side `truePct` (see `trackPlay`), so its `byCategoryDetail` is a clean over/yes-side measure that can't soundly score an UNDER's bet side. `CALIB_BUCKETS` in `placeValidation.js` mirrors `_buckets` in `auth.js` — keep in sync. New `/api/tonight` emits for this: `rawKalshiPct`/`rawNoKalshiPct` (pre-orderbook-blend top-of-book, stashed before the blend overwrite in `tonight.js`) and `homeAwayResolved` (`authoritative`|`fallback`|null, stamped in the post-emit play loop via `_homeAwayResolved`). Flow B (LLM auditor on passed-but-flagged picks) is the planned next layer. **Today-only filter (2026-06-01):** modal has a "Today's picks only" checkbox (default checked, resets to checked each time the modal opens). When on, `placeAllCandidates`/`placeAllPlaceable` are filtered to plays whose PT game date (`gameTime` → `toLocaleDateString("en-CA", {timeZone:"America/Los_Angeles"})`, fallback `gameDate`) matches today's PT date — list, cost, button count, and the candidates actually ordered all reflect the filtered set. Unchecking reveals all days. Checkbox is hidden once placement completes. `runPlaceAll` now takes `cands` as a parameter (no longer closes over `placeAllPlaceable`); toolbar badge still counts the full unfiltered `placeAllPlaceable`.
  - **Prop dedup + correlation-adjusted sizing (2026-06-04):** `placeAllCandidates` dedups multi-threshold player props to the highest-edge candidate per `playerId|sport|stat` (same prop at K6.5 and K7.5 = one bet). `placeAllGrouped` memo groups `placeAllPlaceable` by game key (sorted team pair + gameDate), computes `avgPosPhi` from `_SAME_GAME_PHI` (module-level Map in App.jsx, φ from shadow analysis) for all bet pairs in the group, then phi-scales: `effectivePlays = 1 + (n-1)×(1-avgPosPhi)`, `groupTotal = anchorCost × effectivePlays`, each play's `count` rescaled proportionally. Negative phi pairs clamped to 0 (hedges don't reduce). `_catDir(play) = "${stat||gameType}|${direction||''}"`. Modal renders groups with header `"label · N bets · φ≈X · $Y"` (orange φ≥0.6, yellow otherwise); `runPlaceAll` receives rescaled candidates from `scopedGroups.flatMap(g => g.rescaled)`. Update `_SAME_GAME_PHI` when shadow-analysis reports new strong pairs (n≥50 threshold).
- `/api/kalshi-balance` — `GET`, authenticated. Returns `{ cashCents, positionsCents, balanceCents, balanceDollars }`. `balanceCents`/`balanceDollars` = cash + **open-position cost basis** (sum of `market_exposure_dollars` (dollar string, parsed ×100) over unsettled `market_positions`), so the frontend bankroll (`App.jsx` reads `balanceDollars`) reflects total deployed capital. Two signed RSA-PSS GETs (message: `timestamp_ms + "GET" + path`): `/trade-api/v2/portfolio/balance` then `/trade-api/v2/portfolio/positions?settlement_status=unsettled&limit=1000` (signature covers path only, no query). Positions call degrades to `positionsCents=0` on failure — bankroll still shows cash. Cost basis, not mark-to-market: a winning open position shows at what was paid until settlement. No caching.
- `/api/kalshi-snapshot` — cron-only (`*/2 * * * *`). Writes per-ticker `kalshi:snap:{ticker}` for every series. Ticker list is **derived** from `[...Object.keys(SERIES_CONFIG), ...CRON_ONLY_TICKERS]` in `api/lib/series-config.js` (no longer a hardcoded list to keep in sync). **Two-phase write (decoupled 2026-05-31):** (1) fetch all series → **write snaps immediately** with `_meta` (`depthPending:true`, depthOk 0); (2) fetch orderbook depth for in-window markets best-effort under a **21s wall-clock deadline** (`DEPTH_DEADLINE_MS`, cap `DEPTH_FETCH_CAP=90`, volume-prioritized) → **re-write only the touched series snaps** + real `_meta`. The depth phase used to run *before* the only write, so on a full slate it blew past the ~25s Edge ceiling and the cron died mid-flight → **no snaps written at all** (`usedSnaps` stuck false, `_depth` never flowed). Snaps now always land regardless of the depth phase; depth is purely additive. `_meta` carries `depthOk`/`depthFail`/`depthTargets`/`durationMs` for monitoring.
- `/api/auth/calibration` — outcome stats. Returns `overall`, `byCategory`, `byCategoryDetail`, `kStrikeouts`.
- `/api/auth/shadow-calibration` — `GET`, bearer JWT or `?adminKey=`. Queries Neon `shadow_plays` for unbiased full-distribution calibration stats (no edge/dc gate). Returns `overall`, `byCategory` (with `nRaw`/`avgGroupSize`), `byCategoryDetail` in same shape as `/api/auth/calibration` plus `roi` (hitRate/100 − avg market price) and `avgEdge` per cell. Bands 55–60 through 95+ (bet-side probability — UNDERs flip to `1 − model_true_pct`). Optional filters: `?since=YYYY-MM-DD` (default 30d), `?bestThreshold=true` (dedup to one play per group — default from UI), `?dcQualified=true`, `?minDc=N`, `?sport=mlb`, `?thresholdRank=1`, `?seasonType=2|3`. `byCategory[key].n` = deduped count; `byCategory[key].nRaw` = sum of raw plays in those groups. Single CTE round-trip: `overall_band UNION by_cat UNION by_cat_band`. Handler: `api/lib/handlers/auth.js`.
- `/api/auth/shadow-analysis` — `GET`, bearer JWT or `Authorization: Bearer $ADMIN_KEY`. Five analyses on `shadow_plays` (since=30d default): (1) `thresholdRankRoi` — ROI by threshold_rank (rank 1 = closest to 50% BSP); (2) `intraGroupCorr` — alt-line group unanimity by sport/category (% of groups that all-win or all-lose); (3) `sameGamePairs` — pairwise φ for every (cat_a × cat_b) co-occurring in same game (threshold_rank=1 only, n≥10, ordered by |φ|); (4) `concentration` — plays-per-game distribution + hit rate; (5) `clvAnalysis` — per-category CLV (avg market move 3pm→7pm PT, positive = market confirmed model), edge at snap vs close, hit rate. Requires `price_pre_at IS NOT NULL` rows from shadow-pregame-snap cron. Handler: `api/lib/handlers/auth.js`. Auto-fetched by ReportPage when shadow tab opens.
- `/api/shadow-pregame-snap` — cron-only (`0 3 * * *` UTC = 7pm PT). Auth: `CRON_SECRET`. Fetches `/api/tonight?debug=1` (uses cached Kalshi snaps), matches current prices to today's `shadow_plays` rows by `shadowId`, batch-upserts `kalshi_yes_price_pre`/`kalshi_no_price_pre`/`price_pre_at` (only on rows where `price_pre_at IS NULL`). Returns `{ ok, updated, skipped, durationMs }`. CLV = bet-side `price_pre - price_snap` per row; positive CLV means the market moved toward the model prediction between snapshot and game time.
- `/api/auth/shadow-stats` — `GET`, admin (`Authorization: Bearer <ADMIN_KEY>`). Returns row counts from `shadow_plays` by date/category/dc, plus `unresolvedByCategory` (per sport/category/snapshot_date breakdown of unresolved rows). Add `?trigger=1` to also run the shadow-snapshot inline; add `?resolvetrigger=1` to also run the shadow-resolver inline (uses `CRON_SECRET` internally, no external secret needed from caller). Handler: `api/lib/handlers/auth.js`.
- `/api/user/picks` — GET/POST picks (bearer JWT). POST accepts delta `{upserts, deletes, bankroll}` or legacy `{picks, bankroll}`.
- `/api/shadow-resolver` — cron-only (`0 9 * * *` UTC = 2am PT). Auth: `Authorization: Bearer <CRON_SECRET>`. Queries Neon for unresolved `shadow_plays` rows from prior days, self-calls `/api/live?games=...&date=YYYY-MM-DD` per distinct game_date to get final ESPN boxscores, applies resolution logic (props, totals, teamTotal, ML, spread, F5, NBA halves), batch-updates `resolved/won/actual_value/resolved_at`. `won=null` = DNP or void. Calibration filter: `WHERE resolved AND won IS NOT NULL`. Resolver WHERE uses `COALESCE(game_date, snapshot_date::varchar) < today` — handles early-dropped prop rows where game_date was null (fixed in props.js 2026-06-02 to include gameDate). Player name lookup: 4-pass `_findPlayer` — exact → diacritic-strip → period/suffix-strip (C.J.→CJ, Jr.) → Levenshtein ≤2 on fuzzy names (catches Zach/Zack etc). `home_team`/`away_team` fallback: `homeTeam || playerTeam || gameTeam1` so props and early-drops all resolve. Returns `{ok, resolved, skipped, noData, durationMs}`. Manual trigger: `GET /api/auth/shadow-stats?resolvetrigger=1`. **effectiveDate resolution order (2026-06-04):** `game_date` → PT date from `game_time` ISO → `snapshot_date`. **Third pass (2026-06-04):** for rows where both `game_date` and `game_time` are null (Kalshi markets opened before ESPN published the schedule), retries team lookup against `snapshot_date+1` through `+5` (offset skipped if `>= today` to avoid incomplete games).
- `/api/shadow-snapshot` — cron-only (`0 22 * * *` UTC = 3pm PT). Auth: `Authorization: Bearer <CRON_SECRET>`. Fetches `/api/tonight?debug=1`, combines `plays + dropped`, annotates `group_id`/`threshold_rank` (rank 1 = closest to 50% truePct), batch-upserts to Neon `shadow_plays` table. Table auto-created on first run. `home_team`/`away_team` stored as `homeTeam || playerTeam || gameTeam1` so props are resolvable. Early-drop plays include `gameDate` (fixed 2026-06-02) so `game_date` is populated for all rows. **Full Kalshi price range (2026-06-02):** `dropped` now includes game/team total OVERs and all ML/spread plays whose Kalshi price falls outside [67, 91] — `reason: "kalshi_out_of_window"`. Qualifying gate (67–91% + edge ≥ 3%) is unchanged; only the shadow path is widened. Props were already unaffected. **Decimal Kalshi price columns (2026-06-02, P0):** `kalshi_yes_price` = `kalshiPct/100`, `kalshi_no_price` = `noKalshiPct/100` stored alongside the existing percent columns — enables clean `roi = hit − price` SQL without inline division. Handler: `api/lib/handlers/shadow.js`. Neon client: `api/lib/neon.js` (`@neondatabase/serverless`). See Neon gotchas below.
- `/api/keepalive` — daily cron

---

## Models (summary)
See `docs/MODEL.md` for all formula details, SimScore tiers, lambda formulas, gates, dedup, and calibration filter cutoffs.

| Model | Approach | Key inputs |
|---|---|---|
| MLB Strikeouts | `simulateKsDist` Monte Carlo (10k/5k) | K% regression, umpire, expectedBF, lineup oK%, TTO decay |
| MLB Hitters (HRR) | logit-sigmoid base-rate | park, OPS, WHIP, barrel%, PA-aware adjustment, BvP shrinkage |
| NBA props | `buildNbaStatDist` Normal MC | paceFactor, recency-weighted mean, playoff Bayesian shrink, DVP |
| WNBA props | same as NBA | retuned tiers (USG 27/22, O/U 168/158), 2025 anchor |
| NHL props | same as NBA | TOI, GAA rank, playoff-aware shrink |
| NFL props | hit-rate | opp in soft teams gate |
| Game Totals | NegBin (MLB), Poisson (NHL), Normal (NBA/WNBA) | regime blend, starter λ, seasonHitRate blend |
| Team Totals | NegBin (MLB), Normal (NBA) | regime blend (conservative cap for MLB), seasonHitRate blend |
| MLB ML | `simulateMLBJoint`, ties dropped | same per-team λ as game totals |
| MLB Spread | `spreadPctFromJoint`, all alt lines | shared `_mlJointCache` with ML |
| NBA/WNBA ML | `simulateNBAJoint` Normal (σ=13/11) | piecewise injury OffRtg shrink |
| NBA/WNBA Spread | `spreadPctFromJoint` | shared `_nbaJointCache` with ML |
| NBA/WNBA Halves | λ × 0.5, Normal (σ=9.2/7.8) | 1H/2H independent draws, `_halfJointCache` |
| NHL ML/Spread | `simulateMLBJoint` NegBin (r from residuals) | spread dampener 0.80×sim+0.20×65 while calibrating |
| MLB F5 | same machinery as full-game | no TTO, no bullpen share, no regime blend; `λ_F5 = teamRPG × 5/9 × …` |

**Qualification**: `dcQualified === true && edge >= EDGE_GATE`. DC gates: props MLB/NBA 9, WNBA/NHL 8; totals/teamTotals MLB/NBA 10, WNBA/NHL 9; ML 8.

---

## Key Gotchas

**Spread alt-line dedup + category gate interaction (2026-06-04)**: The alt-line dedup in `tonight.js` groups spread plays by matchup + line (since 2026-06-04). Before this fix it grouped all lines for a matchup together — if the highest-edge line (e.g. MIN +2.5 at 9.2%) won the dedup but failed the `mlb|spread` category gate (truePct < 80%), the next-best line that *would* pass (MIN +3.5 at 7.4%, truePct 85%) was silently dropped with `_altLineDemoted: true`. Symptom: Market Report shows a bold play at DC 10/10 but it never appears on LineupsPage. The dedup key is now `sp|sport|seg|sortedTeams|line|gameDate` — different alt lines compete independently; both sides of the same line still deduplicate.

**NBA/WNBA spread model-vs-market divergence gate (2026-06-01)**: `dc.js` adds `spreadModelMarketDivergent` (−1 dc) when `|homeLambda − awayLambda − homeMarketMargin| > 10` for NBA/WNBA spread plays (full-game and half-game, both use `gameType="spread"`). `homeMarketMargin = pickTeam===homeTeam ? −pickLine : pickLine`. Fires when the OffRtg/DefRtg rating system's expected margin diverges more than 10 pts from the Kalshi market spread — a signal the model missed something (injuries, form, extreme mismatch). Drops dc=10 → 9, filtering the play. Inciting case: SEA @ DAL WNBA tonight, model −4.7 vs market −18.5 (13.7-pt divergence, team at +470 ML). Filter NBA/WNBA spread calibration `trackedAt < 2026-06-01`.

**NBA/WNBA injury OffRtg shrink — piecewise (2026-05-28), MPG-weighted (2026-05-30)**: `_injuryOffRtgAdj` is piecewise on USG-out share: ≤20% × 0.15, 20-35% × 0.22, 35-50% × 0.30, >50% × 0.35, floor 0.70. **Each out player's USG% is now weighted by `avgMin/48` (cap 1.0; missing avgMin → weight 1.0)** — raw-summing over-counted low-minutes players (OKC WCF Game 7: J-Williams 26.8 + Mitchell 22.3 + 0-min rookie Sorber summed to 49.1 → 36-50% tier ×0.30, vs 27.8 weighted → 21-35% tier ×0.22). Companion `_injuryBlendDamp(usageOut) = max(0, min(1, (42 − usageOut) / 21))` (range rescaled ×0.7 from 60/30 to match the weighted scale) scales regime and seasonHitRate blends to 0 as USG-out rises. See `docs/MODEL.md`; filter `trackedAt < 2026-05-30` from NBA/WNBA total/teamTotal/ml/spread calibration. **dc heavy-injury threshold fixed 2026-05-31:** the `dc.js` gate was `homeUsageOut >= 0.30` but `usageOut` is a 0–100 value → it fired on essentially every NBA/WNBA ml/spread with any injury (knocking them to dc=9, which the strict dc=10 client filter then dropped). Now `>= 30` (both NBA + WNBA branches) so the −1 fires only on genuinely heavy (≥30 MPG-weighted USG-out) injury. Effect: lightly-injured teams now reach dc=10 and qualify. `DC_GATE` ml/spread stays 8 — the client `_passesCleanData` dc=10 strict filter is the real user-facing gate. Filter `trackedAt < 2026-05-31` for NBA/WNBA ml/spread heavy-injury calibration.

**Regime-aware lambda blend**: All game/team totals blend recency-weighted recent-score means into rating-based expected (21d half-life NBA/WNBA/NHL, 14d MLB). Cap 0.85/denom 8 for game totals + NBA team totals; MLB team totals use 0.50/denom 12. See `docs/MODEL.md`; calibration cutoffs: `< 2026-05-21` NBA/WNBA/NHL total+teamTotal, `< 2026-05-25` MLB total/ML/spread, `< 2026-05-27` MLB teamTotal.

**MLB strikeouts between-game form variance (2026-06-01)**: The 6/1 calibration found `mlb|strikeouts` Δ −17.9 (n=38), overconfidence concentrated in the 80–90% truePct band (act ~54%; 90%+ already calibrated). Cause: `simulateKsDist` (`simulate.js`) treated pitcher K-rate as fixed per game — only within-game Bernoulli variance, so the K-count distribution was under-dispersed. Fix: each sim draws one mean-1 lognormal `formMult = exp(K_FORM_SIGMA·Z − K_FORM_SIGMA²/2)` (`K_FORM_SIGMA = 0.22`) scaling every batter's K prob. **Mean K count preserved** (E[formMult]=1, verified by tests); only spread widens → pulls extreme tail truePcts toward 50%. **σ is the retune knob, conservative at 0.22** (closes ~⅓ of the −17.9 gap). The embedded copy in `simulate.test.jxa.js` must stay in sync (run `osascript -l JavaScript api/lib/simulate.test.jxa.js`). Filter `mlb|strikeouts` calibration `trackedAt < 2026-06-01`.

**MLB teamRuns NegBin fix (2026-06-02)**: `simulateTeamTotalDist` was using Poisson for MLB team totals while `simulateMLBTotalDist` (game totals) used NegBin — same overdispersion problem. Backtest confirmed -10 to -13 delta across all bands with Poisson; within ±2 after fix. `simulateTeamTotalDist` now accepts optional `r` param (null → Poisson for NHL backward compat). `game-totals.js` now passes `_mlbDispR`. Filter `mlb|teamRuns` calibration `trackedAt < 2026-06-02`.

**MLB teamRuns market-line anchor + NegBin season blend (2026-06-03)**: Shadow calibration (rank-1 ROI −17.7%, n=29) + live picks (Δ −11.3, n=43) confirmed same mean-λ bias as totalRuns. Three fixes in `game-totals.js` MLB team total branch: (1) `_anchorTeamLam(lam)` pulls final λ **25% toward `gameOuLine/2`** (team-share prior; gated to lines ∈ [5,14]) — applied after regime blend and again to `_ttBlendedLambda`. (2) Season blend cap tightened **1.0 → 0.50** (decoupled from `_TT_IMPLIED_CAP.mlb` which stays 1.0 for the `seasonRateDivergent` dc penalty). (3) Season blend **Poisson → NegBin**: `lambdaForPoissonTail` → `muForNegBinTail`, `poissonCDF` → `negBinCDF` — fixes inconsistency with the no-season sim path. `ttRawLam` emitted in debug fields for diagnosability. Filter `mlb|teamRuns` calibration `trackedAt < 2026-06-03`.

**MLB HRR sigmoid cap (2026-06-02)**: 3-season backtest (571k rows, 2022-2024) found actual hit rate plateaus at ~72% (70-75% model band) then *declines* to 71→67→61% in the 75-80→80-85→85-90 model bands. Cause: logit factor stacking (park × OPS × WHIP × barrel%) generates spuriously high outputs that don't reflect reality. Fix: sigmoid cap `pct ≤ 72 ? pct : 72 + 3*(1 - exp(-0.5*(pct-72)))` applied after the `_propBlend` return in `props.js` (live model) and after `hrrLogitTruePct()` in `scripts/backtest/mlb/simulate.js` (backtest). Cap compresses above 72% toward a 75% ceiling; the 80-85 and 85-90 overconfident bands are eliminated. Residual 75-80 band (n=161 at exactly 75% ceiling, actual 65.8%) self-filters via the ≥5% edge gate since Kalshi prices these matchups at 71-75%. Filter `mlb|hrr` calibration `trackedAt < 2026-06-02`.

**MLB totalRuns market-line anchor + tighter blend clamp (2026-06-01)**: The 6/1 calibration found MLB totalRuns overs +17 overconfident (Δ −26.5 side-aware; the regime blend + seasonHitRate blend stack λ upward, worst at low thresholds where season hit rate ≈ 100% → high implied λ). Two fixes in `game-totals.js` MLB total branch, **game-total only** (teamRuns/F5 untouched): (1) **Plan A** — the seasonHitRate blend clamp `_cap` is hardcoded **0.75** (was `_GT_IMPLIED_CAP.mlb` = 1.5). Decoupled on purpose: `dc.js` still reads `_GT_IMPLIED_CAP.mlb` = 1.5 for the `seasonRateDivergent` penalty, so the **same plays qualify/drop** — only the blend math softens. (2) **Plan C** — `_anchorTotalLam(λ)` pulls the final total λ **25% toward `gameOuLine`** (gated to lines ∈ [5,14]); applied to both the no-season sim (via `_lamScale` on `_hLam`/`_aLam`) and the season-blend `_blendedLambda`. **Local to the total truePct only** — `_mlbMlContext` keeps the RAW λ so the healthy (+11% ROI) ML/spread surfaces are untouched. Self-targeting: biggest pull where model diverges most from market. Filter MLB totalRuns calibration `trackedAt < 2026-06-01`.

**MLB lineup-aware lambda (2026-05-18)**: Game-total/team-total/ML/spread λ multiplied by hitter-out tier (0/1/2/3+ → ×1.0/0.98/0.96/0.93). Probable pitcher on IL nulls starter → bullpen-only ERA fallback. dc penalties: -1 at topOut ≥ 2, -2 at pitcherOnIL. Filter `trackedAt < 2026-05-18` for total/teamTotal/ML/spread calibration.

**TEAM_NORM (Kalshi → ESPN)**: NBA `{ GS→GSW, SA→SAS, NY→NYK, NJ→BKN, NO→NOP, PHO→PHX, WPH→PHX, KAT→ATL }`. WNBA `{ CONNECTICU→CONN, CON→CONN, DALLAS→DAL, WAS→WSH, GSV→GS, LAS→LA }`. After building `STAT_SOFT` rankMaps, a post-normalization loop adds the long-form key so `nbaDefRank["GSW"]` resolves.

**WNBA `parseGameTeams` — variable-length abbrs**: WNBA mixes 2-, 3-, and 4-char canonical abbrs. The WNBA branch tries every (i, len−i) split 2–4 chars each half, preferring longer left-side first (`CONNIN` → `CONN+IND`). `_VALID_TEAMS["wnba"]` is the 15-team canonical set.

**`parseGameTeams` validation via `_VALID_TEAMS`**: Without validation a 2-char Kalshi prefix steals the parse (`NYKPHI` → `NY`+`KPH`). The parser tries 3+3 first when length≥6 and only commits if both halves validate; falls back to 2+3 (also validated). Symptom of breakage: duplicate matchup cards. Maintain `_VALID_TEAMS` when teams rebrand (e.g. OAK→ATH).

**Kalshi ticker home/away order doesn't match ESPN.** `parseGameTeams` returns ticker order, not home/away. Each play loop must look up the actual home team and swap if needed: MLB uses `sportByteam.mlb.gameHomeTeams[gameTeam2]`; NBA/NHL scan `sportByteam.{nba,nhl}GameScores`. Two enforcement sites: game-total loop and team-total loop.

**NHL_ABBR_MAP**: NHL Stats API teamIds → abbreviations. **UTA (Utah Mammoth) = teamId 68** (rebranded 2025-26; old teamId 53 absent). New teams showing `—` need their teamId added.

**ESPN scoreboard abbr mismatch**: `/api/live` translates at the ESPN boundary via `CANONICAL_TO_ESPN` / `ESPN_TO_CANONICAL` (sport-keyed). Symptom of unmapped team: `state:"unknown"`, pick never resolves.
- **MLB**: `CWS↔CHW` · **NBA**: `GSW↔GS`, `SAS↔SA`, `NYK↔NY`, `NOP↔NO`, `UTA↔UTAH`, `WAS↔WSH`
- **WNBA**: `CONN↔CON`, `DAL↔DALLAS`, `WSH↔WAS`, `LA↔LAS` · **NHL**: `TBL↔TB`, `NJD↔NJ`, `LAK↔LA`, `SJS↔SJ`

Add new mismatches to `CANONICAL_TO_ESPN` in the `/api/live` handler — `ESPN_TO_CANONICAL` is auto-derived.

**gameTimes lookup chain** (in play loop): `sport:team:gameDate` → `sport:team:tomorrowISOStr` → bare `sport:team`.

**`gameScores` today + tomorrow merge**: Each scoreboard fetch that produces `gameScores` fetches today AND tomorrow in parallel and merges into `parseGameScores`. Key shape: `${hA}|${gameDate}|${event.date}` — prevents today's Final from being wiped after midnight UTC, and prevents DH game 2 from overwriting game 1. The inline duplicate in `api/lib/mlb.js` (~line 952) must mirror the same key shape. Frontend `LineupsPage.buildGames` keys by `${sortedPair}|${gameDate}|${gameTime}` for the same reason.

**`/api/live` doubleheader disambiguation**: Wire format `sport:t1:t2@gameTimeISO`. Client appends `@${pick.gameTime}` when present. Server filters scoreboard events by `ev.date.slice(0,16) === gameTime.slice(0,16)`. No fallback when gameTime is supplied but doesn't match — would reintroduce the game-1/game-2 settlement bug.

**`_mlbMlContext` null-gameDate fallback (2026-05-29)**: KXMLBTOTAL tickers routinely have unparseable date segments (all 15 games were null on 2026-05-29). Context stored as `_mlbMlContext["HOME|AWAY|null"]`. All context lookups chain `?? _mlbMlContext["t1|t2|null"] ?? _mlbMlContext["t2|t1|null"]` fallback. Symptom if broken: F5/spread/ML plays absent; totalRuns plays present with `gameDate: null`.

**Kalshi MLB postponed-ticker reattribution**: When a game is rained out Kalshi reuses the original ticker. After `sportByteam.mlb` hydrates, `_mlbNextGameByTeams` is built from `state === 'pre'` gameScores entries; `_reattrMlbGameDate` overwrites stale dates on market arrays. Resolved markets (extreme prices) are skipped to prevent yesterday's settled prices from being misattributed.

**MLB pitchers per-game (`mlbMeta.pitchersByGame`)**: Keyed `${team}|${gameKey}` (ESPN-style ISO, no seconds). `MatchupCard.featureFor` reads this first, falls back to per-team `pitchers[abbr]` map. Without the per-game map both DH cards show the same pitcher.

**Closing-line snapshots** (`mlbClosingOdds` / `nbaClosingOdds` / etc.): ESPN returns empty `odds` once a game is in/post. Redis key per sport holds the last-seen pre-game line. `state==='pre'` writes; `state==='in'|'post'` overlays back. 36h TTL. If no snapshot exists for an in/post game, odds entries are **cleared** rather than shown (model-derived mid-game prices look like real lines but mislead).

**`mlbMeta.gameOdds` vs `mlbMetaTomorrow.gameOdds`**: Today's odds from `parseGameOdds(sbData.events)`; tomorrow's from `parseGameOdds(sbData.eventsTomorrow)`. Both normalized through `MLB_ESPN_NORM`. `MatchupCard` selects by `game.gameDate` vs PT today.

**Kalshi-derived MLB odds fallback**: ESPN doesn't post tomorrow's lines until close to first pitch. Before the closing-odds snapshot, already-fetched `KXMLBGAME`/`KXMLBTOTAL` arrays fill missing fields on `_mlbGameOdds`/`_mlbGameOddsTomorrow` only — ESPN stays authoritative when present.

**`{sport}Meta.topPlayers[abbr]` (NBA/WNBA/NHL)**: `{ name, id, headshot, stats }` from ESPN scoreboard `competitions[].competitors[].leaders` by `parseTopPlayers` in `api/lib/utils.js`. NBA/WNBA: `RAT` leader; NHL: `Points` leader (derives G or A from secondary leaders when present).

**byteam:mlb partial-cache trap**: MLB byteam hydrates several API calls in parallel and each `.catch(() => ({}))` silently. Short-TTL guard (60s) fires when any of `lineupSpotByName`, `pitcherAvgPitches`, `hitterOpsMap`, `pitcherH2HStarts` is empty. Symptom: ReportPage Market tab columns null; diff cached vs `?bust=1` to confirm.

**Two-way players** (MLB strikeouts): ESPN gamelog defaults to batting stats. The play loop appends `&category=pitching` for K-market players. Separate cache keys (`gl:mlb242526pv1`, `gl:mlb2025p|`, `gl:mlb2026p|`) prevent batting/pitching collision. Without this, two-way players drop with `col_not_found`.

**ESPN gamelog endpoint**: ESPN blocks server-side HTML fetches with AWS WAF. Use the JSON API (`site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog`) for ALL sports.

**NBA lineup source chain**: (1) ESPN scoreboard → game summary boxscore starters (`lineupConfirmed:true`); (2) most recent **playoff** game first (`seasontype=3`), fallback to last regular-season `lastGameId`; (3) ESPN team roster. ESPN depth chart returns `{}` during playoffs — removed. Prefer playoff over RS — RS finals can have rested/bench starters.

**MLB lineup** (`/api/team`): (1) MLB Stats API `hydrate=lineups,probables` today → `lineupConfirmed:true`; (2) most-recent posted lineup from past-10-day schedule → `lineupConfirmed:false`; (3) active roster fallback. Probable-pitcher entry is preserved across (2).

**`mlbMeta.pitchers[abbr]` shape**: `{ name, id, era, wins, losses }`. `pitcherEra` is the two-step-regressed value (same as the lambda math uses), not raw season ERA. Sources merged in `api/[...path].js` ~line 4890: name/id/era from pitcherInfoByTeam → probables fallback.

**Edge handler env-var wiring**: ALL env vars must be passed through `process.env` to the explicit `env` object at the bottom of `api/[...path].js`. Vercel doesn't auto-attach them. If you add a new env var, add it here too:
```js
const env = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_KEY: process.env.ADMIN_KEY,
  CRON_SECRET: process.env.CRON_SECRET,
  KALSHI_API_KEY_ID: process.env.KALSHI_API_KEY_ID,
  KALSHI_PRIVATE_KEY: process.env.KALSHI_PRIVATE_KEY,
  POSTGRES_URL: process.env.POSTGRES_URL,
  NEON_DATABASE_URL: process.env.NEON_DATABASE_URL,
  DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING,
};
```
Symptom of missing wire-up: `env?.VAR` is `undefined` even though Vercel dashboard shows it set.

**Neon HTTP SQL API (`api/lib/neon.js`) — four gotchas (2026-06-01/02)**:
1. Uses `@neondatabase/serverless` (Edge-compatible). Raw fetch to `ep-*.c-7.us-east-1.aws.neon.tech/sql` fails with "missing authentication credentials" — the Vercel-managed Neon hostname doesn't accept the manual `Authorization: Basic` or `Neon-Connection-String` header approach.
2. `neon().query(sql, params)` returns the rows array **directly** (not `{ rows: [...] }`). Do NOT do `result.rows ?? []` — just `return await sql_fn.query(sql, params)`.
3. DDL (`CREATE TABLE`, `CREATE INDEX`) must go through `neonExec()` which splits on `;` and runs each statement separately via `sql_fn.query(stmt, [])`. Multi-statement DDL in a single `query()` call fails with "cannot insert multiple commands into a prepared statement". `sql.unsafe()` is a raw-value marker (used inside template literals), NOT an executor.
4. **DATE columns come back as JS Date objects, not strings.** `String(row.date_col).slice(0,10)` gives locale format `"Mon Jun 01"` instead of `"2026-06-01"`. Always use `new Date(row.date_col).toISOString().slice(0,10)` to extract "YYYY-MM-DD" safely from both Date objects and ISO strings.

**Kalshi UNDER pricing — use `no_ask_dollars`, not `1 - yes_ask_dollars`**: YES and NO order books are independent — typical spread is 3–7 cents. Synthesizing UNDER price as `1 - yes_ask` inflates measured edge by 3–7%. Fix landed 2026-05-15: parse loop reads `m.no_ask_dollars` and propagates `noKalshiPct` + `noKalshiAO`. Filter UNDER calibration by `trackedAt ≥ 2026-05-15`.

**Kalshi snap-first read chain (`/api/tonight`)**:
1. **`kalshi:snap:{ticker}`** — written every 2 min by cron. All-or-nothing: all fresh (`writtenAt` within 180s) → skip Kalshi REST entirely.
2. **`kalshi:bundle:{date}`** — legacy 600s bundle fallback.
3. **REST + `kalshi:stale:{ticker}`** — per-ticker fetch with 30-min stale fallback.

`KXMLBGAME` has the same 3-tier chain. The all-or-nothing snap gate is intentional — mixed-source recovery adds complexity without reducing failure modes. **Diagnosing `usedSnaps:false`:** the gate requires *every* series snap fresh within 180s, so a single missing/stale snap drops to the bundle/REST tier. The most likely culprit is the cron failing to write (see `/api/kalshi-snapshot` two-phase note) — check `kalshiSnap.meta` in `/api/tonight?debug=1`: `null` meta means no cron run completed in the last 10 min (the `_meta` TTL), pointing at a cron-side failure rather than a freshness race.

**Orderbook-depth blend — slippage-honest edges (2026-05-31, all surfaces):** every play's displayed `kalshiPct` is re-priced to the cost of sweeping a unit-sized position through the cached orderbook (`_depth` from the snapshot cron), not just top-of-book ask — so a thin/wide market can't show a juicier edge than you'll realize. Pure pricing in `api/lib/tonight/blend-fill.js` (`blendMarketPrice(depth, side, topPct)`); only ever de-biases a price *upward* (never optimistically improves it). Markets without cached depth keep top-of-book. **Player props** blend at their dedicated loop in `tonight.js` (YES side). **Totals / teamTotal / spread** blend at the **PARSE site** (the loop right after the props blend in `tonight.js`), re-pricing BOTH `kalshiPct`/`americanOdds` (YES) and `noKalshiPct`/`noKalshiAO` (NO) before the arrays reach `game-totals.js`/`ml-spread.js` — so those emit modules need zero changes. Because slippage is now priced directly, the `wideSpread` dc penalty was **dropped** (it was only a proxy for the missing depth check); the raw `kalshiSpread` is still emitted for display. Calibration: filter totals/spread/teamTotal surfaces by `trackedAt ≥ 2026-05-31` (edges shifted with the blend).
