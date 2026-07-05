# CLAUDE.md

Guidance for Claude Code when working in this repo. **Detail lives in `docs/*.md` and memory files — this is the navigation layer, not the encyclopedia.** Don't re-add history, post-mortems, or dated narratives here; those belong in git/memory.

## Commands

```bash
npm run dev        # Vite dev server — proxies /api to production (see vite.config.js)
npm run build      # Production build → dist/
npm test           # Node test runner: simulate, utils, parse-teams, dedup, category gate
npm run test:jxa   # osascript JXA version of the simulate tests (macOS only)
git push origin main  # Deploys to Vercel automatically
```

Admin/debug one-liners (pull ADMIN_KEY via `vercel env pull`):
```bash
curl -s "https://scoreboard-ivory-xi.vercel.app/api/tonight?debug=1" | jq '.plays | length'
curl -s "https://scoreboard-ivory-xi.vercel.app/api/shadow-snapshot" -H "Authorization: Bearer $ADMIN_KEY" | jq '{ok, snapshotDate, logged, durationMs}'
curl -s "https://scoreboard-ivory-xi.vercel.app/api/auth/shadow-stats?resolvetrigger=1" -H "Authorization: Bearer $ADMIN_KEY" | jq '{resolved, skipped}'
```

## Workflow for New Features and Debugging

1. **Check memory and CLAUDE.md** — Read `MEMORY.md` + relevant memory files. Scan CLAUDE.md for the area; load `docs/MODEL.md`, `docs/INFRA.md`, or `docs/FRONTEND.md` if the change touches those. For any calibration-driven change (tuning a formula, adding an input, adjusting a gate), read `docs/MODEL_IMPROVEMENT.md` first.
2. **Plan and get approval** — Present the full plan as text only (files, logic, edge cases). **Greenfield check:** for plans that build on existing code, ask "what would this look like from scratch?" — name any divergence as either real tech debt to pay down now or a load-bearing constraint to keep. **Core principles to check the plan against:** (1) single source of truth (edit `config.js`/`teams.js`/shared helpers, don't duplicate), (2) DRY/chokepoint (one upstream point, not N call sites), (3) least change / YAGNI, (4) don't break contracts (additive over destructive; forward-only formula changes via `FORMULA_CUTOFFS`), (5) failure-closed (new external/data paths degrade to empty/null, never throw into the hot path), (6) separation of concerns (model / storage / display split), (7) match surrounding idiom (Web-API style, no Node-only APIs casually). Wait for explicit approval before editing.
3. **Implement** — Make changes. If backend logic changed, confirm via `/api/tonight?debug=1` (or the relevant endpoint) and print fields proving correctness.
4. **Deploy and document** — `git push origin main`. Update CLAUDE.md + the relevant `docs/*.md` in the same commit. Save a memory entry for anything non-obvious.

## What This Is

Sports prop betting dashboard: pulls Kalshi prediction-market prices, computes a model True%, shows qualified plays with edge over the market. Vercel **Node runtime (Fluid Compute)**, maxDuration 300 (vercel.json `functions`) — handler code stays Web-API style (fetch/Request/Response/crypto.subtle), so don't introduce Node-only APIs casually.

**Production**: `https://scoreboard-ivory-xi.vercel.app`

**Qualification**: client `dcQualified === true && edge >= 5 && passesCategoryGate`. `dcQualified` = dc≥7 (only `kalshiStale`/`playerOut` fail; all other dc penalties informational). SimScore is display-only. Tunables live in **one source** at `api/lib/config.js`: `KALSHI_GATE` 67, `KALSHI_CAP` 91, `EDGE_GATE_SERVER` 3, `EDGE_GATE_CLIENT` 5 — server (tonight.js) and client (App.jsx, LineupsPage.jsx, TotalsBarChart.jsx) import from there.

**Capture vs bet window**: `[KALSHI_GATE, KALSHI_CAP]` = the `qualified` *bet* flag; shadow LOGGING captures the **full curve** — `[CAPTURE_GATE 1, CAPTURE_CAP 99]` is quote-sanity only (0/100¢ asks are absent quotes, not prices). Doctrine (2026-07-03): track ALL picks, price filtering happens at analysis/bet-window time, never collection — the earlier `[55,97]` favorite band blinded the coin-flip zone (WNBA half/quarter spreads were nearly unlogged) and its floor made sub-55 derived windows unshippable via `betWindowFor`'s bounds check. ML paths never had a band (both sides, any price); Phase-1 mirror modules (tennis/golf/nascar/advance) now log both quoted sides — same idiom as ML home/away. mlb-outs keeps one row per rung (favorite = higher-priced side); the totalBases under-flip triggers on `noPct > pct` (NO is the favorite). Client display of props honors the server `qualified` flag (`qualifiesForDisplay` hides prop-shaped `qualified:false` rows — game rows exempt, ML uses `qualified:false` by convention). `config.test.js` pins `CAPTURE ⊃ [KALSHI_GATE, KALSHI_CAP]`. **Per-category derived windows (`CATEGORY_BET_WINDOWS` in `config.js`, `betWindowFor(sport,stat)`)**: an empty-by-default map that overrides the global `[67,91]` for one `sport|stat` when a category's edge sits outside it (tune:residual found `mlb|totalBases` above the 91¢ cap). Applied at the PROP emit chokepoint (`tonight/props.js`); the ML/spread/total paths still use the global window inline. Populate a category ONLY after `npm run tune:window -- --category <sport|stat>` returns GO at n≥200 (in-sample checklist + **out-of-sample** ROI CI-lo>0 + Brier-eligible — the OOS split guards the report's upward-biased in-sample `discoveredWindow`). Window math lives in the shared `api/lib/price-window.js` (imported by both shadow.js's bettingBoard and the CLI). Forward-only, human-applied (like the gate/`FORMULA_CUTOFFS`); no auto-tuning. **Capture liquidity gate (`CAPTURE_MAX_SPREAD` 15¢, props only)**: a prop rung whose captured side has no real two-sided book (bet-side bid-ask spread > 15¢) is rejected at the `tonight.js` prop parse — a lone NO bid at ~6¢ implies `yes_ask=94¢`, so high-threshold totalBases longshots were logging as 94¢ "favorites" and inflating the accuracy board's Brier skill (fake +0.15 → real +0.004 parity). Volume does **not** separate these (real rungs are also 0-volume); spread does. Stale-ask path (`yesAsk≥0.98` priced off `last`) is exempt.

**Category gate**: UI display + the `push/notify` cron are restricted to categories with confirmed positive shadow ROI. Lives in `passesCategoryGate()` in `api/lib/category-gate.js` (re-exported by `src/lib/constants.js`); applied in `App._qualifiedFilter` / `LineupsPage.passesGate` and the cron. Tracked picks bypass it. **The gate is currently EMPTY.** Add a category only when `npm run tune:gate` shows ROI>0 at cumulative n≥50 (`MIN_N_PROMOTE`) AND per-band detail is coherent (no in-window band flipping negative) — band coherence is the real guard. Shadow-only categories + per-band history → `docs/MODEL.md` § Category gate.

## Where to look

| Topic | File |
|---|---|
| Per-sport modeling internals (SimScore tiers, lambdas, gates, calibration cutoffs) | `docs/MODEL.md` |
| How to improve the model from calibration data (correction ladder L0–L5, n thresholds, ship checklist) | `docs/MODEL_IMPROVEMENT.md` |
| Cache keys/TTLs, Upstash, env vars, deployment, testing, route contracts, cron table + DST re-pin | `docs/INFRA.md` |
| URL routing, App.jsx state, ReportPage, live tracking, sizing, color doctrine | `docs/FRONTEND.md` |
| Design system: palette, typography, spacing, component patterns | `docs/STYLEGUIDE.md` (tokens: `src/lib/styles.js`) |
| Common debugging recipes | `docs/DEBUGGING.md` |

## Architecture

### API: `api/[...path].js` (router) + `api/lib/handlers/*.js` (routes) + `api/lib/*.js` (modules)

`api/[...path].js` is a thin router: CORS preflight, `makeCache`, dispatch to one handler per route family.

Route handlers (`api/lib/handlers/`):
- `auth.js` — `/api/auth/*`, `/api/user/picks`
- `player.js` — `/api/player`, `/api/gamelog`, `/api/headshot`
- `sports.js` — `/api/team`, `/api/live`
- `dvp.js` — `/api/dvp`, `/api/nba-depth`, `/api/dvp/debug-dc`
- `kalshi.js` — `/api/kalshi`, `/api/kalshi-orderbook`, `/api/kalshi-snapshot`, `/api/kalshi-series-scan`, `/api/keepalive`, `/api/kalshi-order`, `/api/kalshi-balance`, `/api/kalshi-fills`
- `tonight.js` — `/api/tonight`. Owns the Kalshi parse loop, byteam hydration, data-prep, emit calls, response assembly.
- `shadow.js` — `/api/shadow-snapshot`, `/api/shadow-resolver`, `/api/shadow-pregame-snap`, `/api/shadow-report`, `/api/{polymarket,sportsbook}-deltas`, `/api/polymarket-scan`, `/api/routine-note`
- `push.js` — `/api/push/{vapid,subscribe,unsubscribe,notify,test}` (Web Push / PWA; web-push is the only Node-only dep, dynamic-imported in the send path)

Sport/utility modules (`api/lib/`):
- `simulate.js` — park factors, all simulation functions (K/NBA/MLB/NHL/total dists), kelly/EV math
- `mlb.js` — `buildMlbByteam` + `buildMlbInjuryReport`; re-exports the split modules: `mlb-shared.js` (`MLB_ID_TO_ABBR`, `_fs`), `mlb-hitters.js` (`buildLineupKPct`, `buildBarrelPct`), `mlb-pitchers.js` (`buildPitcherKPct`), `mlb-weather.js` (`BALLPARKS` + `buildBallparkWeather` → Open-Meteo game-time wind/temp; hydrated as `byteam.weatherByTeam`, consumed **only** in the HRR logit)
- `nba.js` — DVP, depth chart, pace, usage, injury, player-pos
- `wnba.js` — pace, usage, injury, DVP; `WNBA_TEAM_IDS`, `WNBA_ESPN_TO_CANON`/`WNBA_CANON_TO_ESPN`
- `nhl.js` — `buildNhlGoalieData`, `buildNhlInjuryReport`, `NHL_ABBR_MAP`
- `tennis.js` — ATP+WTA match-winner (shadow-only). ESPN-rankings → `tennisMatchProb` logistic; `fetchCompletedMatches` for the resolver
- `soccer.js` — World Cup (shadow-only). National-team Elo → one Dixon–Coles Poisson score matrix per game; all market families (`prob1x2`/`probTotalOver`/`probTeamOver`/`probSpreadCover`/`probBtts`) project off it; `advanceProb` for knockout to-advance. `WC_TEAMS` registry; `fetchWcFinals`/`fetchWcHalfFinals`/`fetchWcAdvance` resolvers
- `mma.js` — UFC rounds O/U (shadow-only). Weight-class finish-rate → per-round hazard → `pEndBeforeRound` (winner-independent). ESPN MMA scoreboard for hydration; `fetchFightResults` resolver
- `golf.js` — PGA single-round H2H (shadow-only). OWGR rating → `h2hWinProb` one-round Normal differential. OWGR API rating source; `fetchRoundScores` resolver
- `nascar.js` — NASCAR Cup H2H + Top-10 (shadow-only). Recent-form finishing-position model (`pBeats`/`pTopN`). ESPN core-API season schedule; `fetchRaceResults` resolver, grades by athlete id. Cup-only by construction
- `polymarket.js` — Polymarket price feed (Gamma API, shadow-only). `fetchPolymarketGames` normalizes game events (gameDate = **PT** date of `markets[].gameStartTime`, ticker-date fallback; already-commenced games dropped — Poly trades in-play); `POLY_TO_CANON` from teams.js. Also the discovery surface: `fetchPolySportsCatalog` (Gamma `GET /sports` league catalog) + `POLY_DISMISSED_SPORTS` (code-side dismissals) feed `/api/polymarket-scan`. Failure-closed
- `polymarket-book.js` — Polymarket CLOB book walk. `fetchPolyOrderbook` + `walkPolyFill` + `enrichDeltasWithExec` (attaches exec deltas after slippage)
- `sportsbook.js` — sharp-book reference feed (The Odds API / Pinnacle, shadow-only). `fetchSportsbookGames` (no key → clean `[]` no-op), `devigTwoWay`, `normalizeOddsEvent` (gameDate = **PT** date of commence_time; already-commenced events dropped — live odds ≠ pre-game reference)
- `utils.js` — CORS, `parseGameOdds`, `parseGameScores`, team rank helpers
- `teams.js` — **team identity registry**. Per-sport records (canonical abbr + per-surface aliases: kalshi / polymarket / espnScore / espnStats / numeric ids). Derives `TEAM_NORM`, `_VALID_TEAMS`, `CANONICAL_TO_ESPN`, `POLY_TO_CANON`, `WNBA_*`, `NHL_ABBR_MAP`, `MLB_ID_TO_ABBR`, all re-exported from their historical modules (import paths unchanged). **Team rebrands/aliases: edit the registry ONLY**; `teams.test.js` pins derived values
- `tonight/parse-teams.js` — `TEAM_NORM`, `normTeam`, `_VALID_TEAMS`, `parseGameTeams`
- `tonight/dedup.js` — `dedupKey` + `dedupAltLines`; tonight.js owns the splice. Unit tests pin key semantics
- `tonight/props.js` — `emitPropPlays(ctx)`
- `tonight/game-totals.js` — `emitGameTotalPlays(ctx)`; returns `_*MlContext` maps
- `tonight/ml-spread.js` — `emitAllMlAndSpread(ctx)`
- `tonight/{tennis-match,soccer,soccer-advance,golf-h2h,mlb-outs,nascar,fight}.js` — the Phase-1 emit modules. Each groups its Kalshi series, emits the favorite side (Kalshi YES in window), and pushes into a **dedicated array** (e.g. `tennisPlays`, `soccerPlays`) merged into `shadow:staging` ONLY — never the client response. They bypass prop dedup / gameTime filter / card builder
- `tonight/polymarket-deltas.js` — `emitPolymarketDeltas`: ML-only cross-venue divergence. Builds a Kalshi ML index off emitted `plays`/`dropped`, matches Poly games (exact PT date), pushes delta rows (`deltaCents = polyPct − kalshiPct`). **Also stamps `polyPct`/`polyDeltaCents` onto matched Kalshi play rows** and tonight.js builds `polyMlByGame` for the **client** (renders a Polymarket line on ML cards; reference-only, ML-only). Shadow rows stay in `shadow:staging` + `?debug=1` only
- `tonight/sportsbook-deltas.js` — `emitSportsbookDeltas`: de-vigged sharp-book ML vs Kalshi (`deltaCents = bookFairPct − kalshiPct`, + = Kalshi cheap = lagging). Liquidity-gated (drops untraded sides); **exact PT-date match only** (a ±1-day fuzz paired tonight's live odds with tomorrow's same-series Kalshi market — the fake ≥5¢ tail, purged 7/01). Shadow + `?debug=1` only

### Frontend: Vite + React (`src/`)
Entry: `index.html` → `src/main.jsx` → `src/App.jsx`. Vercel runs `npm run build` → `dist/` on push.

- `App.jsx` — top-level state, routing, data fetching, player card
- `lib/constants.js` — `TEAM_DB`, `TOTAL_THRESHOLDS`, `MOCK_PLAYS`, `GAMELOG_COLS`, sport/stat metadata
- `lib/qualify.js` — `qualifiesForDisplay(p)` (shared qualification core: dc + edge + category gate + demotion exception) and `trackIdFor(p)`. App `_qualifiedFilter` and LineupsPage `passesGate` both delegate here; only their tracked-pick bypass differs
- `lib/utils.js` — `slugify`, `teamUrl`, `logoUrl(sport, abbr)`
- `lib/liveStats.js` — live pick tracking helpers
- `lib/hooks.js` — `useIsMobile(threshold=600)`
- `lib/useReportData.js` — report/calib/shadow state + fetchers for ReportPage
- `components/` — `LineupsPage`, `MatchupCard`, `PlaysColumn`, `MyPicksColumn`, `ReportPage`, `TeamPage`, `TotalsBarChart`, `DayBar`, `AddPickModal`

**Dev proxy**: `vite.config.js` proxies `/api` to production so `npm run dev` works without a local backend.

## Routes

Full request/response contracts, auth patterns, cron schedules, and Place All mechanics → `docs/INFRA.md`.

| Route | Handler | Purpose |
|---|---|---|
| `/api/tonight` | `tonight.js` | Main play gen. `?debug=1` adds drops/debug. `?bust=1` bypasses caches |
| `/api/kalshi` | `kalshi.js` | Raw Kalshi market data |
| `/api/kalshi-orderbook` | `kalshi.js` | GET `?ticker=` — live full resting book for one ticker (walked for real VWAP slippage). Public, uncached |
| `/api/kalshi-snapshot` | `kalshi.js` | Cron — pre-warms `kalshi:snap:{ticker}` (two-phase write) |
| `/api/kalshi-series-scan` | `kalshi.js` | Cron — discovers new Kalshi Sports series; diffs catalog vs `SERIES_CONFIG`∪`CRON_ONLY_TICKERS`; records unknowns in Neon `kalshi_series_seen`. Status funnel `new`→`shortlisted`→`adopted`/`dismissed`; auto-reconciles against `SERIES_CONFIG` and `DISMISSED_SERIES`. `?dry=1`, `?dismiss=`/`?promote=` triage |
| `/api/kalshi-order` | `kalshi.js` | POST — place a Kalshi order (RSA-PSS signed); includes Place All batch |
| `/api/kalshi-balance` | `kalshi.js` | GET — cash + open-position cost basis |
| `/api/kalshi-fills` | `kalshi.js` | GET — filled orders (pick recovery) |
| `/api/player`, `/api/gamelog`, `/api/headshot` | `player.js` | ESPN player info + gamelogs |
| `/api/team` | `sports.js` | Team page data (gameLog, lineup, season stats) |
| `/api/live` | `sports.js` | In-game boxscore for pick tracking |
| `/api/dvp`, `/api/nba-depth`, `/api/dvp/debug-dc` | `dvp.js` | DVP/depth chart |
| `/api/auth/{register,login,reset,…}` | `auth.js` | Auth + admin (calibration, shadow-stats) |
| `/api/auth/shadow-calibration` | `auth.js` | Shadow calib stats from Neon (`?since`, `?sport`, `?category`, `?dcQualified`, `?thresholdRank=1`, etc). `?brier=1` adds per-category model-Brier vs market-Brier head-to-head (`skill = marketBrier − modelBrier`; >0 = model sharper). Act only at n≥200 |
| `/api/auth/shadow-analysis` | `auth.js` | Analyses (thresholdRankRoi, clvAnalysis, capRoi, edgeBucketRoi, …). `?residual=<sport\|stat>` dumps raw rows for `npm run tune:residual` + `npm run tune:window` (the bet-window recommender — snapshot_date-ordered rows feed its out-of-sample split). `?clvCaptureHistory=1` / `?clvDay=` for CLV forensics. `extractFeatures` folds a uniform `x*` exogenous namespace + `snapshot_date` onto every play (feeds `tune:residual` / `tune:learncurve`) |
| `/api/shadow-snapshot` | `shadow.js` | Crons — logs plays+drops to Neon `shadow_plays` (reads `shadow:staging:{date}` from KV first, falls back to HTTP). Carries `coverage`/`coverageWarning`. Also persists `polymarket_deltas` + `sportsbook_deltas` |
| `/api/polymarket-scan` | `shadow.js` | Cron — discovers new Polymarket leagues; diffs the Gamma `GET /sports` catalog vs `POLY_SERIES`; records unknowns in Neon `polymarket_sports_seen` (slug PK, same status funnel as the Kalshi scan; `market_types` enrichment catches new market families). New/shortlisted rows merge into the report's `newMarkets`/`shortlistedMarkets` with `venue:"polymarket"`. `?dry=1`, `?dismiss=`/`?promote=` triage by slug |
| `/api/polymarket-deltas` | `shadow.js` | GET (ADMIN/JWT) — multi-day Kalshi-vs-Polymarket ML divergence. `?days=` `?sport=`. `exec` = book-walked surviving edge after slippage; `?execrows=1` (ADMIN) adds the raw exec-row tail + per-day walk coverage for audits |
| `/api/sportsbook-deltas` | `shadow.js` | GET (ADMIN/JWT) — multi-day Kalshi-vs-sharp-book ML divergence. `meanSigned>0` = Kalshi systematically cheap = lag edge (kill-gate CLOSED 2026-07-04: TIGHT, no lag edge — feed stays as truth anchor/regime tripwire). `?minAbs=N` adds a `rows` tail dump (\|Δ\|≥N¢, LIMIT 200) for outlier audits; `?purge=all` (ADMIN) wipes for re-baseline. Requires `THE_ODDS_API_KEY` (provisioned) |
| `/api/shadow-resolver` | `shadow.js` | Crons (2am, 3:05am, 5:50am PT) — resolves shadow plays via ESPN live scores (4-pass name lookup). SELECT uses pooled primary (`neonQuery {write:true}`). Self-fetch to `/api/live` via `fetchLiveInto()` (timeouts + retry + logging — cold-start aborts must not be swallowed). `noData` rows are usually next-day pre-listings (resolve T+1) |
| `/api/shadow-pregame-snap` | `shadow.js` | Crons (5 passes) — captures pre-game Kalshi prices for CLV. Reads `shadow:staging:{date}` (rejects if >15 min old); falls back to HTTP. Per-run breadcrumb → KV `shadow:pregame:{date}`, read via `?runs=1`. `?dry=1` skips DB write |
| `/api/shadow-report` | `shadow.js` | Cron (6am PT) — morning briefing. Produces `dataHealth` (coverage + resolution + CLV-capture; `actionable` on catastrophic resolution `<0.5` OR a ≥2-day coverage/CLV warning streak, KV `shadow:healthstreak:{date}`), `accuracyBoard` (Layer 1 — calibration verdict + Brier-skill vs market + Learning trend), `bettingBoard` (Layer 2 — price-band profitability, discovered window, validation-ladder verdict, `eligible = skillLoCI>0 && n≥100`), `polymarketValidation` (mirror of `sportsbookValidation` over `polymarket_deltas`, + exec read), `brief` (deterministic daily prose — health/headline/changes/model/betting/pricing/takeaway reader order, diffed vs yesterday's KV report; /model's primary readout, accuracy grid collapsed behind it). Cached `shadow:report:{date}` 25h (15min when resolution <90%). Resolution read is cold-wake-hardened (KV floor + robust cross-conn max — resolved is monotonic). Auth: CRON_SECRET/ADMIN/JWT; `?bust=1` regen. **Heavy logic — read `docs/FRONTEND.md` + memory before touching.** |
| `/api/user/picks` | `auth.js` | GET/POST picks (JWT, delta `{upserts, deletes, bankroll}`) |
| `/api/push/{vapid,subscribe,unsubscribe,notify,test}` | `push.js` | Web Push: VAPID key, sub store/drop (Neon `push_subscriptions`), notify cron (model-gates + live-book-trusts + dedups), test send |
| `/api/keepalive` | `kalshi.js` | Daily cron — keeps Upstash alive |
| `/api/routine-note` | `shadow.js` | KV scratchpad bridging cloud routines → dev box. `POST {slug,text}` (`ROUTINE_NOTE_TOKEN`-gated), `GET ?slug=` (ADMIN/JWT). Routines end with a curl POST of their summary |

## Models (summary)
Formula details, SimScore tiers, lambda formulas, gates, dedup, calibration cutoffs → `docs/MODEL.md`.

| Model | Approach | Key inputs |
|---|---|---|
| MLB Strikeouts | `simulateKsDist` Monte Carlo | K% regression, umpire, expectedBF, lineup oK%, TTO decay, `K_FORM_SIGMA=0.26` |
| MLB Hitters (HRR) | logit-sigmoid base-rate | park, OPS, WHIP+FIP, barrel%, game-time weather (shadow-only), PA-aware adj, BvP shrinkage |
| MLB Hitters (Hits) | `binomTailPct` binomial tail — shadow-only | pHit × nAB; seasonRate blend 0.5 |
| MLB Hitters (Total Bases) | `tbTailPct` compound binomial — shadow-only | same pHit/nAB as hits; per-hit bases shares league-shrunk; resolves via statsapi |
| MLB Pitcher Outs | `projectOuts` + `outsTailPct` Normal — shadow-only | μ=avgBF×outRate, σ=0.90×max(stdBF×outRate, 3.5); resolves off `ps.ip`→outs |
| NBA/WNBA/NHL props | `buildNbaStatDist` Normal MC | paceFactor, recency-weighted mean, playoff shrink, DVP (WNBA/NHL retuned tiers) |
| NFL props | hit-rate | opp in soft-teams gate |
| Game/Team Totals | NegBin (MLB), Poisson (NHL), Normal (NBA/WNBA) | regime blend, starter λ, seasonHitRate blend. NBA/WNBA B2B = **transfer** (tired λ↓ + opp λ↑) |
| MLB ML/Spread | `simulateMLBJoint` / `spreadPctFromJoint`, shared `_mlJointCache` | per-team λ as game totals |
| NBA/WNBA ML/Spread/Halves | `simulateNBAJoint` Normal, shared joint caches | piecewise injury OffRtg shrink |
| WNBA Quarters | λ×0.25 Normal — shadow-only | 1Q–4Q, 3-way TIE; resolves off per-quarter linescores |
| NHL ML/Spread | NegBin (r from residuals) | spread dampener while calibrating |
| MLB F3/F5/F7 | full-game machinery; inning-segment ML (3-way w/ tie) + F5 total/spread. F3/F5 = starter-only×(3\|5)/9, F7 = full-game λ×7/9 | F3/F5 drop TTO/bullpen; F7 keeps them (starter tires past inning 5) |
| Tennis / Soccer / Fight / Golf / NASCAR | Phase-1 models — shadow-only | see the `api/lib/*.js` module notes above |

## Key Gotchas

These bite during *any* change. Sport/model cutoffs → MODEL.md; data-pipeline → INFRA.md; display → FRONTEND.md.

**Spread alt-line dedup + category gate**: dedup key `sp|sport|seg|sortedTeams|line|gameDate`. Different alt lines compete independently; both sides of one line share a key (higher-edge side wins). Edge case: if the dedup winner fails the category gate while the demoted loser passes, `passesGate`/`_qualifiedFilter` allow the demoted play through (`_altLineDemoted && !passesCategoryGate(p)`). Opposite-side truePcts are complementary, so both sides never show at once.

**TEAM_NORM (Kalshi → ESPN)**: NBA `{GS→GSW, SA→SAS, NY→NYK, NJ→BKN, NO→NOP, PHO→PHX, WPH→PHX, KAT→ATL}`. WNBA `{CONNECTICU→CONN, CON→CONN, DALLAS→DAL, WAS→WSH, GSV→GS, LAS→LA}`. Derived from `teams.js` (`kalshi` aliases) — edit the registry, not parse-teams.js. Identity entries (mlb `KC→KC`) mark 2-char prefixes for the 2+3 ticker split.

**`parseGameTeams` validation via `_VALID_TEAMS`**: without it a 2-char prefix steals the parse (`NYKPHI` → `NY`+`KPH`). Parser tries 3+3 first when length≥6, commits only if both halves validate; falls back to validated 2+3. WNBA mixes 2/3/4-char abbrs — tries every split, longer left-side first. Symptom of breakage: duplicate matchup cards. Maintain `_VALID_TEAMS` on team rebrands.

**Kalshi ticker home/away order ≠ ESPN.** `parseGameTeams` returns ticker order. Each play loop must look up the real home team and swap: MLB `sportByteam.mlb.gameHomeTeams[gameTeam2]`; NBA/NHL scan `{nba,nhl}GameScores`. Two sites: game-total loop and team-total loop.

**ESPN scoreboard abbr mismatch**: `/api/live` translates via `CANONICAL_TO_ESPN`/`ESPN_TO_CANONICAL` (sport-keyed). Unmapped → `state:"unknown"`, pick never resolves. MLB `CWS↔CHW`; NBA `GSW↔GS, SAS↔SA, NYK↔NY, NOP↔NO, UTA↔UTAH, WAS↔WSH`; WNBA `CONN↔CON`; NHL `TBL↔TB, NJD↔NJ, LAK↔LA, SJS↔SJ`. Add new mismatches to the `espnScore` field in `teams.js`. (`WNBA_CANON_TO_ESPN` is a *different* endpoint — stats/injuries, `espnStats` field — don't use it for the `/api/live` scoreboard map.)

**`gameScores` today+tomorrow merge**: each scoreboard fetch fetches today AND tomorrow in parallel; key shape `${hA}|${gameDate}|${event.date}` prevents post-midnight wipe + DH game-2 overwrite. The inline duplicate in `mlb.js` must mirror the key shape. Frontend `LineupsPage.buildGames` keys by `${sortedPair}|${gameDate}|${gameTime}`.

**Kalshi UNDER pricing — use `no_ask_dollars`, not `1 - yes_ask_dollars`**: YES/NO books are independent (3–7¢ spread). Synthesizing UNDER as `1 - yes_ask` inflates measured edge. Parse loop reads `m.no_ask_dollars`, propagates `noKalshiPct`/`noKalshiAO`.

**Traded volume ≠ resting liquidity**: a market with `volume_fp:0` can still have a deep resting book. Cached `_depth` is top-3-only + often absent on 0-vol markets → reported slippage is a **false 0** (never measured). Order modals + Place All + push cron walk the live full book (`/api/kalshi-orderbook` → `walkFill`) for real VWAP (slip <3¢ checked even at 0 trades; ≥3¢ soft-warn; can't fill → uncheck). Shared: `api/lib/kalshi-book.js`, re-exported by `src/lib/orderbook.js`.

**Kalshi snap-first read chain (`/api/tonight`)** — 2-tier (`api/lib/tonight/kalshi-pipeline.js`):
1. `kalshi:snap:{ticker}` — written every 2 min by cron. All-or-nothing: all fresh (within 180s) → skip Kalshi REST.
2. REST + `kalshi:stale:{ticker}` — per-ticker throttled fetch (3 parallel / 700ms, shuffled), 30-min stale fallback. Fresh non-empty fetches written back to `kalshi:snap` (chunked via `pipeWriteChunked`); stale/failed series not re-stamped.

`KXMLBGAME` has the same chain. Diagnosing `usedSnaps:false`: check `kalshiSnap.meta` in `?debug=1` — `null` meta = no cron in 10 min (cron-side failure); non-zero `meta.snapWriteFailed` = Upstash rejected chunks.

**Server self-fetches: `selfOrigin(request)`, never `new URL(request.url).origin`**: cron invocations arrive on the deployment-generated URL, which Deployment Protection 302s to the SSO HTML page — the overnight resolver's `/api/live` self-fetch died every night with `Unexpected token '<'` (found 7/02). `selfOrigin` (`api/lib/utils.js`) pins `PROD_ORIGIN` except on localhost; used by resolver, shadow-snapshot/pregame-snap HTTP fallbacks, and shadow-stats `?trigger`/`?resolvetrigger`. Symptom: `noData≈all, games=0` on cron runs but a manual daytime trigger works.

**Outbound fetch is globally concurrency-gated (`api/lib/fetch-limit.js`)**: the instance has a 1024-fd ceiling and total open sockets ≈ the SUM of every module's peak `Promise.all` burst width (idle keep-alive sockets linger, invisible to `getActiveResourcesInfo`) — crossing it makes ALL outbound fetches fail (`TypeError: fetch failed`, cause `EMFILE`/`EBUSY`, ESPN and Upstash alike) while single-fetch routes stay healthy. `fetch-limit.js` wraps `globalThis.fetch` in a 64-slot gate (side-effect import, FIRST line of the router) — that's the guarantee; per-phase `pLimit(n)` (`api/lib/utils.js`) and batched KV reads via `cache.getMany` (chunked MGET; feature-test + parallel-GET fallback) are pacing on top. Don't add a fetch path that bypasses global `fetch`. Diagnose with `?debug=1` → `fdProbe` milestones. Details → `docs/INFRA.md` § Data Plumbing Gotchas.

**Upstash 10MB request cap**: any single HTTP request to Upstash >10MB 413s. Two mechanisms: (1) multi-key writes go through `pipeWriteChunked` (`api/lib/kv-pipeline.js`), size-chunked at 7MB; (2) single `cache.put` (SET) values are transparently gzipped above `KV_COMPRESS_THRESHOLD` (256KB) via `api/lib/kv-compress.js` (`gz:`-prefixed, auto-decompressed on get — zero caller changes). `kalshi:snap:*` bypass `makeCache` (raw MGET, already chunked). `cmd()` logs `[upstash] HTTP <status>` on non-OK so an oversize surfaces.

**API handler env-var wiring**: handlers receive `env`, never read `process.env`. ALL env vars must be wired into the explicit `env` object at the bottom of `api/[...path].js`. Add new ones here too:
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
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,      // Web Push (handlers/push.js)
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  VAPID_SUBJECT: process.env.VAPID_SUBJECT,            // mailto: or https URL
  ROUTINE_NOTE_TOKEN: process.env.ROUTINE_NOTE_TOKEN,  // routine-note write gate (handlers/shadow.js)
  THE_ODDS_API_KEY: process.env.THE_ODDS_API_KEY,      // sharp-book feed (api/lib/sportsbook.js)
};
```
Symptom of missing wire-up: `env?.VAR` is `undefined` even though Vercel shows it set.

**Web Push / PWA**: background push for the installed PWA. **iOS 16.4+ delivers push ONLY to a Home-Screen-installed PWA** — a Safari tab silently no-ops, so the bell button shows an "Add to Home Screen" hint when `isIOS() && !isStandalone()` (`src/lib/push.js`). Static PWA files (`public/{manifest.json,sw.js,icon-*.png}`) serve from `dist/` before the SPA rewrite. Requires VAPID env vars. The category gate lives in `api/lib/category-gate.js` so the cron applies the identical gate the UI shows.

**Shadow-snapshot KV staging**: tonight handler writes `shadow:staging:{date}` to Upstash (TTL 6h) right after DC computation. Shadow-snapshot/pregame-snap read it first (~100ms) instead of re-fetching `/api/tonight?debug=1` (40-55s). `plays` = all prop + qualified game-total/ML/spread; `dropped` = non-qualifying total/teamTotal/ML/spread/F5/halves with computed truePct. Carries `writtenAt` (pregame-snap enforces a 15-min staleness gate). Diagnose: `dropped > 0` confirms the dropped-capture path is live.

**Neon HTTP SQL API (`api/lib/neon.js`) — four gotchas**:
1. Uses `@neondatabase/serverless`. Raw fetch to the Neon host fails with "missing authentication credentials".
2. `neon().query(sql, params)` returns the rows array **directly** (not `{ rows }`). Don't do `result.rows ?? []`.
3. DDL must go through `neonExec()` (splits on `;`, runs each separately). Multi-statement DDL in one `query()` fails. `sql.unsafe()` is a raw-value marker, NOT an executor.
4. **DATE columns come back as JS Date objects.** Always `new Date(row.date_col).toISOString().slice(0,10)`, never `String(...).slice(0,10)`.

**Cold-wake replica lag**: on a cold function wake the unpooled Neon replica (and even the pooled primary on a fresh instance) can serve stale/empty reads. Read paths that gate on freshness (e.g. shadow-report resolution count) use `{write:true}` + a KV floor + cross-conn max. Safe because the counts are monotonic (only ADD) → max can only under-count when stale.
