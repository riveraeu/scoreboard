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
| Per-sport modeling internals (SimScore tiers, lambdas, miscAdj, gates, calibration filter cutoffs) | `docs/MODEL.md` |
| Cache keys + TTLs, Upstash, env vars, deployment, testing, route contracts, data-plumbing gotchas | `docs/INFRA.md` |
| URL routing, App.jsx state shape, ReportPage (Market Report + Results + Shadow tabs), live tracking, sizing, color doctrine | `docs/FRONTEND.md` |
| Common debugging recipes | `docs/DEBUGGING.md` |

The cross-cutting gotchas below bite during *any* change regardless of area. Sport/model-specific calibration cutoffs live in MODEL.md; data-pipeline gotchas in INFRA.md; display gotchas in FRONTEND.md.

---

## Architecture

### API: `api/[...path].js` (router) + `api/lib/handlers/*.js` (routes) + `api/lib/*.js` (sport modules)
Single Vercel Edge Function. `api/[...path].js` is a ~140-line thin router: handles CORS preflight, calls `makeCache`, dispatches to one handler per route family. Route handlers live in `api/lib/handlers/`:
- `api/lib/handlers/auth.js` — `/api/auth/*`, `/api/user/picks`
- `api/lib/handlers/player.js` — `/api/player`, `/api/gamelog`, `/api/headshot`
- `api/lib/handlers/sports.js` — `/api/team`, `/api/live`
- `api/lib/handlers/dvp.js` — `/api/dvp`, `/api/nba-depth`, `/api/dvp/debug-dc`
- `api/lib/handlers/kalshi.js` — `/api/kalshi`, `/api/kalshi-snapshot`, `/api/keepalive`, `/api/kalshi-order`, `/api/kalshi-balance`, `/api/kalshi-fills`
- `api/lib/handlers/tonight.js` — `/api/tonight` (~1857 lines after Phase B6). Owns Kalshi parse loop, byteam hydration, data-prep, emit calls, response assembly.
- `api/lib/handlers/shadow.js` — `/api/shadow-snapshot`, `/api/shadow-resolver`, `/api/shadow-pregame-snap`

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

**Dev proxy**: `vite.config.js` proxies `/api` to production so `npm run dev` works without local backend.

---

## Routes

See `docs/INFRA.md` for full request/response contracts, auth patterns, cron details, and Place All mechanics.

| Route | Handler | Purpose |
|---|---|---|
| `/api/tonight` | `handlers/tonight.js` | Main play gen. `?debug=1` adds drops/debug. `?bust=1` bypasses caches. |
| `/api/kalshi` | `handlers/kalshi.js` | Raw Kalshi market data |
| `/api/kalshi-snapshot` | `handlers/kalshi.js` | Cron (`*/2 * * * *`) — pre-warms `kalshi:snap:{ticker}` (two-phase write) |
| `/api/kalshi-order` | `handlers/kalshi.js` | POST — place a Kalshi order (RSA-PSS signed); includes Place All batch |
| `/api/kalshi-balance` | `handlers/kalshi.js` | GET — cash + open-position cost basis |
| `/api/kalshi-fills` | `handlers/kalshi.js` | GET — filled orders (pick recovery) |
| `/api/player`, `/api/gamelog`, `/api/headshot` | `handlers/player.js` | ESPN player info + gamelogs |
| `/api/team` | `handlers/sports.js` | Team page data (gameLog, lineup, season stats) |
| `/api/live` | `handlers/sports.js` | In-game boxscore for pick tracking |
| `/api/dvp`, `/api/nba-depth`, `/api/dvp/debug-dc` | `handlers/dvp.js` | DVP/depth chart |
| `/api/auth/{register,login,reset,…}` | `handlers/auth.js` | Auth + admin (calibration, shadow-stats, clear-kalshi-stale) |
| `/api/auth/shadow-calibration` | `handlers/auth.js` | Shadow calib stats from Neon (`?since`, `?bestThreshold`, `?sport`) |
| `/api/auth/shadow-analysis` | `handlers/auth.js` | Five analyses: thresholdRankRoi, intraGroupCorr, sameGamePairs, concentration, clvAnalysis |
| `/api/shadow-snapshot` | `handlers/shadow.js` | Cron (3pm PT) — logs all plays+drops to Neon `shadow_plays` |
| `/api/shadow-resolver` | `handlers/shadow.js` | Cron (2am PT) — resolves shadow plays via ESPN live scores (4-pass name lookup) |
| `/api/shadow-pregame-snap` | `handlers/shadow.js` | Cron (7pm PT) — captures pre-game Kalshi prices for CLV |
| `/api/user/picks` | `handlers/auth.js` | GET/POST picks (bearer JWT, delta `{upserts, deletes, bankroll}`) |
| `/api/keepalive` | `handlers/kalshi.js` | Daily cron — keeps Upstash alive |

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

**Qualification**: `dcQualified === true && edge >= EDGE_GATE`. `dcQualified` means dc≥7 (only `kalshiStale`/`playerOut` fail; all other dc penalties are informational since 2026-06-04).

---

## Key Gotchas

**Spread alt-line dedup + category gate interaction (updated 2026-06-05)**: The dedup key is `sp|sport|seg|sortedTeams|line|gameDate`. Different alt lines (e.g. +2.5 vs +3.5) compete independently. Both sides of the same line (MIN +3.5 vs KC -3.5) share one key; the higher-edge side wins. The edge case: if the dedup winner fails the category gate (truePct < 80%) while the demoted loser passes it, `passesGate` (LineupsPage.jsx) and `_qualifiedFilter` (App.jsx) allow the demoted play through — `_altLineDemoted && !passesCategoryGate(p) → false` rather than a blanket block. Opposite-side truePcts are complementary (~sum to 100%), so you can never show both sides simultaneously. Market Report symptom: bold play visible but absent from LineupsPage card.

**TEAM_NORM (Kalshi → ESPN)**: NBA `{ GS→GSW, SA→SAS, NY→NYK, NJ→BKN, NO→NOP, PHO→PHX, WPH→PHX, KAT→ATL }`. WNBA `{ CONNECTICU→CONN, CON→CONN, DALLAS→DAL, WAS→WSH, GSV→GS, LAS→LA }`. After building `STAT_SOFT` rankMaps, a post-normalization loop adds the long-form key so `nbaDefRank["GSW"]` resolves.

**WNBA `parseGameTeams` — variable-length abbrs**: WNBA mixes 2-, 3-, and 4-char canonical abbrs. The WNBA branch tries every (i, len−i) split 2–4 chars each half, preferring longer left-side first (`CONNIN` → `CONN+IND`). `_VALID_TEAMS["wnba"]` is the 15-team canonical set.

**`parseGameTeams` validation via `_VALID_TEAMS`**: Without validation a 2-char Kalshi prefix steals the parse (`NYKPHI` → `NY`+`KPH`). The parser tries 3+3 first when length≥6 and only commits if both halves validate; falls back to 2+3 (also validated). Symptom of breakage: duplicate matchup cards. Maintain `_VALID_TEAMS` when teams rebrand (e.g. OAK→ATH).

**Kalshi ticker home/away order doesn't match ESPN.** `parseGameTeams` returns ticker order, not home/away. Each play loop must look up the actual home team and swap if needed: MLB uses `sportByteam.mlb.gameHomeTeams[gameTeam2]`; NBA/NHL scan `sportByteam.{nba,nhl}GameScores`. Two enforcement sites: game-total loop and team-total loop.

**ESPN scoreboard abbr mismatch**: `/api/live` translates at the ESPN boundary via `CANONICAL_TO_ESPN` / `ESPN_TO_CANONICAL` (sport-keyed). Symptom of unmapped team: `state:"unknown"`, pick never resolves.
- **MLB**: `CWS↔CHW` · **NBA**: `GSW↔GS`, `SAS↔SA`, `NYK↔NY`, `NOP↔NO`, `UTA↔UTAH`, `WAS↔WSH`
- **WNBA**: `CONN↔CON`, `DAL↔DALLAS`, `WSH↔WAS`, `LA↔LAS` · **NHL**: `TBL↔TB`, `NJD↔NJ`, `LAK↔LA`, `SJS↔SJ`

Add new mismatches to `CANONICAL_TO_ESPN` in the `/api/live` handler — `ESPN_TO_CANONICAL` is auto-derived.

**`gameScores` today + tomorrow merge**: Each scoreboard fetch that produces `gameScores` fetches today AND tomorrow in parallel and merges into `parseGameScores`. Key shape: `${hA}|${gameDate}|${event.date}` — prevents today's Final from being wiped after midnight UTC, and prevents DH game 2 from overwriting game 1. The inline duplicate in `api/lib/mlb.js` (~line 952) must mirror the same key shape. Frontend `LineupsPage.buildGames` keys by `${sortedPair}|${gameDate}|${gameTime}` for the same reason.

**Kalshi UNDER pricing — use `no_ask_dollars`, not `1 - yes_ask_dollars`**: YES and NO order books are independent — typical spread is 3–7 cents. Synthesizing UNDER price as `1 - yes_ask` inflates measured edge by 3–7%. Fix landed 2026-05-15: parse loop reads `m.no_ask_dollars` and propagates `noKalshiPct` + `noKalshiAO`. Filter UNDER calibration by `trackedAt ≥ 2026-05-15`.

**Kalshi snap-first read chain (`/api/tonight`)**:
1. **`kalshi:snap:{ticker}`** — written every 2 min by cron. All-or-nothing: all fresh (`writtenAt` within 180s) → skip Kalshi REST entirely.
2. **`kalshi:bundle:{date}`** — legacy 600s bundle fallback.
3. **REST + `kalshi:stale:{ticker}`** — per-ticker fetch with 30-min stale fallback.

`KXMLBGAME` has the same 3-tier chain. **Diagnosing `usedSnaps:false`:** check `kalshiSnap.meta` in `/api/tonight?debug=1` — `null` meta means no cron completed in the last 10 min, pointing at a cron-side failure rather than a freshness race. See `docs/INFRA.md` for the two-phase cron write design.

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

**Neon HTTP SQL API (`api/lib/neon.js`) — four gotchas**:
1. Uses `@neondatabase/serverless` (Edge-compatible). Raw fetch to the Neon hostname fails with "missing authentication credentials" — the Vercel-managed host doesn't accept manual `Authorization: Basic` headers.
2. `neon().query(sql, params)` returns the rows array **directly** (not `{ rows: [...] }`). Do NOT do `result.rows ?? []`.
3. DDL must go through `neonExec()` which splits on `;` and runs each statement separately. Multi-statement DDL in a single `query()` call fails with "cannot insert multiple commands into a prepared statement". `sql.unsafe()` is a raw-value marker, NOT an executor.
4. **DATE columns come back as JS Date objects.** `String(row.date_col).slice(0,10)` gives locale format. Always use `new Date(row.date_col).toISOString().slice(0,10)`.
