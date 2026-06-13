# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Scoreboard — Project Guide for Claude

## Commands

```bash
npm run dev        # Vite dev server — proxies /api to production (see vite.config.js)
npm run build      # Production build → dist/
npm test           # Node.js test runner: simulate, utils (parseGameScores keys), parse-teams, dedup, category gate
npm run test:jxa   # osascript JXA version of the simulate tests only (macOS only)
git push origin main  # Deploys to Vercel automatically
```

Admin/debug one-liners (pull ADMIN_KEY via `vercel env pull`):
```bash
# Verify tonight's play generation
curl -s "https://scoreboard-ivory-xi.vercel.app/api/tonight?debug=1" | jq '.plays | length'
# Trigger shadow snapshot manually (ADMIN_KEY bypasses CRON_SECRET)
curl -s "https://scoreboard-ivory-xi.vercel.app/api/shadow-snapshot" -H "Authorization: Bearer $ADMIN_KEY" | jq '{ok, snapshotDate, logged, durationMs}'
# Trigger shadow resolver manually
curl -s "https://scoreboard-ivory-xi.vercel.app/api/auth/shadow-stats?resolvetrigger=1" -H "Authorization: Bearer $ADMIN_KEY" | jq '{resolved, skipped}'
```

---

## Workflow for New Features and Debugging

1. **Check memory and CLAUDE.md** — Read `MEMORY.md` and relevant memory files. Scan CLAUDE.md for the area being changed; load `docs/MODEL.md`, `docs/INFRA.md`, or `docs/FRONTEND.md` if the change touches those areas. For any change driven by calibration data (tuning a formula, adding an input, adjusting a gate), read `docs/MODEL_IMPROVEMENT.md` first.
2. **Plan and get approval** — Present the full plan as text only (files to change, logic, edge cases). Wait for explicit user approval before editing any files.
3. **Implement** — Make the changes. If backend logic changed, confirm with `/api/tonight?debug=1` (or relevant endpoint) and print key fields proving the change is correct.
4. **Deploy and document** — `git push origin main` to deploy. Update CLAUDE.md (and the relevant `docs/*.md`) in the same commit. Save a memory entry for anything non-obvious future sessions should know.

---

## What This Is
Sports prop betting dashboard that pulls Kalshi prediction market prices, computes a model True%, and shows qualified plays with edge over the market. Vercel **Node runtime (Fluid Compute)** since 2026-06-11 (was Edge; maxDuration 300 via vercel.json `functions`) — handler code stays Web-API style (fetch/Request/Response/crypto.subtle), so don't introduce Node-only APIs casually.

**Production**: `https://scoreboard-ivory-xi.vercel.app`
**Universal qualification**: Kalshi 67–91% · Edge ≥ 5% (client) / ≥ 3% (server, kept loose for calibration data). Game/team totals gate UNDERs by the same `noKalshiPct ∈ [67, 91]` window. SimScore is display-only since v1 was dropped 2026-05-26. Tunables live in **one source** at `api/lib/config.js` (`KALSHI_GATE` 67, `KALSHI_CAP` 91, `EDGE_GATE_SERVER` 3, `EDGE_GATE_CLIENT` 5); both server (tonight.js) and client (App.jsx, LineupsPage.jsx, TotalsBarChart.jsx) import from there. All client surfaces gate display at EDGE_GATE_CLIENT (5).

**Model version**: Universal client qualification is `dcQualified === true && edge >= 5 && passesCategoryGate`. `dcQualified` means dc≥7 (gate lowered from 10 on 2026-06-04; only `kalshiStale` −4 and `playerOut` −10 fail). Data-completeness dc=10 requirement removed after shadow calibration showed fallback paths (team WHIP, projected lineups, modest samples) are better calibrated than full-data paths. SimScore is display-only. Client `EDGE_GATE = 5`; server `EDGE_GATE = 3` for calibration continuity. `trackPlay` stamps `modelVersion: "v2"`. The `qualified` field carries only alt-line-demotion semantics now.

**Category gate (2026-06-01)**: UI display is further restricted to categories with confirmed positive ROI (n≥50, working signal). Gate lives in `passesCategoryGate()` in `src/lib/constants.js` — applied in both `App._qualifiedFilter` and `LineupsPage.passesGate`. Currently allows: `mlb|strikeouts` (80–90% — shadow n=55/56 both bands positive; 2026-06-08), `wnba|points` (70–80% — shadow n=10/16 both bands positive; 2026-06-08), `wnba|rebounds` (70–85% — 85–90% band n=17 ROI −8.6% capped 2026-06-09), `wnba|spread` (65–85% — shadow n=39 in-window ~+11% weighted, 65–85 bands all positive, 85–90 −4.8% capped to match WNBA high-band overconfidence pattern; 2026-06-11). Tracked picks bypass the gate so existing bets stay visible. Add new categories here only when `npm run tune:gate` shows ROI>0 at cumulative n≥50 (`MIN_N_PROMOTE`) **and** the per-band detail is coherent (no in-window band flipping negative). This is the bar actually applied to every gate above — all four were promoted at per-band n of 10–56, well under the once-stated "n≥200" (corrected 2026-06-13). Band coherence, not raw n, is the real guard against overconfidence. **Shadow-only categories** (emitting to `shadow_plays` but intentionally NOT in the gate): `mlb|hits` (re-added 2026-06-11 but shipped with wrong series ticker `KXMLBHITS` — real ticker is `KXMLBHIT`, fixed 2026-06-12, so shadow data starts 6/12; check `npm run tune:gate` ~mid July) · `mlb|totalBases` (added 2026-06-12, `KXMLBTB` — `tbTailPct` compound-binomial extension of the hits model; **the only UNDER-direction player prop**: Kalshi lists 2+..6+ only so the YES side never reaches [67,91] — plays bet the NO side, stored over-framed with `direction:"under"` per the totals convention; resolves via statsapi merge `/api/live?tb=1` because ESPN's box score has no TB; check `tune:gate` ~late July).

---

## Where to look

| Topic | File |
|---|---|
| Per-sport modeling internals (SimScore tiers, lambdas, miscAdj, gates, calibration filter cutoffs) | `docs/MODEL.md` |
| **How to improve the model from calibration data** — correction-layer ladder (L0–L5), n thresholds (gate 50 / formula 200), backtest-vs-shadow validation, ship checklist, identifying when a new input is needed | `docs/MODEL_IMPROVEMENT.md` |
| Cache keys + TTLs, Upstash, env vars, deployment, testing, route contracts, data-plumbing gotchas, **cron table + DST re-pin checklist (due Nov 1, 2026)** | `docs/INFRA.md` |
| URL routing, App.jsx state shape, ReportPage (Market Report + Results + Shadow tabs), live tracking, sizing, color doctrine | `docs/FRONTEND.md` |
| Design system: palette, typography, spacing, component patterns — read before adding any UI element | `docs/STYLEGUIDE.md` (tokens: `src/lib/styles.js`) |
| Common debugging recipes | `docs/DEBUGGING.md` |

The cross-cutting gotchas below bite during *any* change regardless of area. Sport/model-specific calibration cutoffs live in MODEL.md; data-pipeline gotchas in INFRA.md; display gotchas in FRONTEND.md.

---

## Architecture

### API: `api/[...path].js` (router) + `api/lib/handlers/*.js` (routes) + `api/lib/*.js` (sport modules)
Single Vercel Edge Function. `api/[...path].js` is a thin router: handles CORS preflight, calls `makeCache`, dispatches to one handler per route family. (A dead Cloudflare-style `scheduled()` DvP handler was removed 2026-06-11 — NBA DvP relies on the lazy build in tonight.js + `/api/dvp/rebuild-pos?stage=N`; consider real vercel.json crons for it before NBA season in Oct.) Route handlers live in `api/lib/handlers/`:
- `api/lib/handlers/auth.js` — `/api/auth/*`, `/api/user/picks`
- `api/lib/handlers/player.js` — `/api/player`, `/api/gamelog`, `/api/headshot`
- `api/lib/handlers/sports.js` — `/api/team`, `/api/live`
- `api/lib/handlers/dvp.js` — `/api/dvp`, `/api/nba-depth`, `/api/dvp/debug-dc`
- `api/lib/handlers/kalshi.js` — `/api/kalshi`, `/api/kalshi-snapshot`, `/api/kalshi-series-scan`, `/api/keepalive`, `/api/kalshi-order`, `/api/kalshi-balance`, `/api/kalshi-fills`
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
- `api/lib/teams.js` — **team identity registry** (2026-06-11): per-sport records with canonical abbr + per-surface aliases (kalshi / espnScore / espnStats / numeric ids). Derives `TEAM_NORM`, `_VALID_TEAMS`, `CANONICAL_TO_ESPN`, `WNBA_*`, `NHL_ABBR_MAP`, `MLB_ID_TO_ABBR` — all re-exported from their historical modules, so import paths are unchanged. Team rebrands/aliases: edit the registry ONLY; `teams.test.js` pins derived values. Still inline (out of registry): `_mlbNorm2` in handlers/dvp.js, dvp's NHL_ABBR copy, frontend `logoUrl` fixes.
- `api/lib/tonight/parse-teams.js` — `TEAM_NORM`, `normTeam`, `_VALID_TEAMS`, `parseGameTeams`
- `api/lib/tonight/dedup.js` — `dedupKey` + `dedupAltLines` (alt-line dedup, extracted 2026-06-11; tonight.js owns the splice + debug push). Unit tests pin the key semantics — change tests and code together.
- `api/lib/tonight/props.js` — `emitPropPlays(ctx)` (~1667 LOC)
- `api/lib/tonight/game-totals.js` — `emitGameTotalPlays(ctx)` (~1225 LOC); returns `_*MlContext` maps
- `api/lib/tonight/ml-spread.js` — `emitAllMlAndSpread(ctx)` (~1231 LOC)

### Frontend: Vite + React (`src/`)
Entry: `index.html` → `src/main.jsx` → `src/App.jsx`. Vercel runs `npm run build` → `dist/` on push.

- `src/App.jsx` — top-level state, routing, data fetching, player card
- `src/lib/constants.js` — `TEAM_DB`, `TOTAL_THRESHOLDS`, `MOCK_PLAYS`, `GAMELOG_COLS`, sport/stat metadata
- `src/lib/qualify.js` — `qualifiesForDisplay(p)` (shared untracked qualification core: dc + edge + category gate + demotion exception) and `trackIdFor(p)` (pick identity). App `_qualifiedFilter` and LineupsPage `passesGate` both delegate here; only their tracked-pick bypasses differ (App enforces dc+edge on tracked picks, LineupsPage always shows them — intentional).
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
| `/api/kalshi-series-scan` | `handlers/kalshi.js` | Cron (`15 16 * * *`, 9:15am PT) — discovers new Kalshi Sports series. Diffs the catalog against `SERIES_CONFIG`∪`CRON_ONLY_TICKERS`; records unknowns in Neon `kalshi_series_seen`. First run baseline-seeds (~2200 series) silently; only later additions surface as `status='new'` in the morning report. `?dry=1` no-write; `?dismiss=KX..`/`?undismiss=KX..` (admin) triage noise. |
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
| `/api/shadow-snapshot` | `handlers/shadow.js` | Crons: 8:05am PT (primary), 8:10am PT (backup), 3:05pm PT, 3:35pm PT — logs plays+drops to Neon `shadow_plays`. Reads `shadow:staging:{date}` from KV first (written by tonight cron); falls back to HTTP fetch of `/api/tonight?debug=1`. Response carries `coverage` (distinct games logged vs ESPN slate per sport, from staging `schedule`) + `coverageWarning` below 80% — check it when auditing cron health. |
| `/api/shadow-resolver` | `handlers/shadow.js` | Crons: 2am, 3:05am, 7am PT — resolves shadow plays via ESPN live scores (4-pass name lookup). SELECT goes through the pooled primary (`neonQuery {write:true}`) — unpooled replica served a stale-empty read on cold wake 2026-06-11. A few `noData` rows each run are next-day Kalshi pre-listings (null `game_date`, yesterday's snapshot_date) — they resolve the morning after their game; not a failure. `shadowId`/`groupId` day-scope null-gameDate plays with snapshot_date (2026-06-11) so pre-listings can't permanently block day-of or rematch rows via `ON CONFLICT DO NOTHING`. |
| `/api/shadow-pregame-snap` | `handlers/shadow.js` | Crons: 17:00, 22:10, 03:00 UTC (each trails a tonight cron by 5–10 min) — captures pre-game Kalshi prices for CLV. Reads `shadow:staging:{date}` from KV first (rejected if `writtenAt` > 15 min old — CLV needs current prices); falls back to HTTP fetch of `/api/tonight`. `?dry=1` skips the DB write. |
| `/api/shadow-report` | `handlers/shadow.js` | Cron (9:30am PT) — generates morning briefing: top picks, category scoreboard, opportunity bands, CLV, optimal picks/day. Cached in KV 25h. Auth: CRON_SECRET or ADMIN_KEY/JWT. `?bust=1` forces regen. |
| `/api/user/picks` | `handlers/auth.js` | GET/POST picks (bearer JWT, delta `{upserts, deletes, bankroll}`) |
| `/api/keepalive` | `handlers/kalshi.js` | Daily cron — keeps Upstash alive |

---

## Models (summary)
See `docs/MODEL.md` for all formula details, SimScore tiers, lambda formulas, gates, dedup, and calibration filter cutoffs.

| Model | Approach | Key inputs |
|---|---|---|
| MLB Strikeouts | `simulateKsDist` Monte Carlo (10k/5k) | K% regression, umpire, expectedBF, lineup oK%, TTO decay, between-game form variance `K_FORM_SIGMA=0.26` (retuned from 0.22 on 6/13; filter shadow `trackedAt < 2026-06-13`) |
| MLB Hitters (HRR) | logit-sigmoid base-rate | park, OPS (w=0.25), WHIP (w=0.30), barrel% (w=0.25), PA-aware adjustment, BvP shrinkage, sigmoid cap knee=68 max=71 |
| MLB Hitters (Hits) | `binomTailPct` exact binomial tail — **shadow-only since 2026-06-11** (not in category gate) | pHit = effBA × platoon × pitcherBAA ratio × park; nAB = own AB/G × lineup-spot PA scaling; seasonRate blend 0.5; cap knee=80 max≈85 |
| MLB Hitters (Total Bases) | `tbTailPct` compound binomial (per-AB bases pmf) — **shadow-only since 2026-06-12** | same pHit/nAB as hits; per-hit [1B,2B,3B,HR] shares from gamelog, league-shrunk (40-hit prior); resolves via statsapi (`/api/live?tb=1`) |
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

**TEAM_NORM (Kalshi → ESPN)**: NBA `{ GS→GSW, SA→SAS, NY→NYK, NJ→BKN, NO→NOP, PHO→PHX, WPH→PHX, KAT→ATL }`. WNBA `{ CONNECTICU→CONN, CON→CONN, DALLAS→DAL, WAS→WSH, GSV→GS, LAS→LA }`. After building `STAT_SOFT` rankMaps, a post-normalization loop adds the long-form key so `nbaDefRank["GSW"]` resolves. Since 2026-06-11 TEAM_NORM is derived from `api/lib/teams.js` (`kalshi` aliases) — edit the registry, not parse-teams.js. Identity entries (mlb `KC→KC` etc.) are functional: membership marks 2-char prefixes for the 2+3 ticker split.

**WNBA `parseGameTeams` — variable-length abbrs**: WNBA mixes 2-, 3-, and 4-char canonical abbrs. The WNBA branch tries every (i, len−i) split 2–4 chars each half, preferring longer left-side first (`CONNIN` → `CONN+IND`). `_VALID_TEAMS["wnba"]` is the 15-team canonical set.

**`parseGameTeams` validation via `_VALID_TEAMS`**: Without validation a 2-char Kalshi prefix steals the parse (`NYKPHI` → `NY`+`KPH`). The parser tries 3+3 first when length≥6 and only commits if both halves validate; falls back to 2+3 (also validated). Symptom of breakage: duplicate matchup cards. Maintain `_VALID_TEAMS` when teams rebrand (e.g. OAK→ATH).

**Kalshi ticker home/away order doesn't match ESPN.** `parseGameTeams` returns ticker order, not home/away. Each play loop must look up the actual home team and swap if needed: MLB uses `sportByteam.mlb.gameHomeTeams[gameTeam2]`; NBA/NHL scan `sportByteam.{nba,nhl}GameScores`. Two enforcement sites: game-total loop and team-total loop.

**ESPN scoreboard abbr mismatch**: `/api/live` translates at the ESPN boundary via `CANONICAL_TO_ESPN` / `ESPN_TO_CANONICAL` (sport-keyed). Symptom of unmapped team: `state:"unknown"`, pick never resolves.
- **MLB**: `CWS↔CHW` · **NBA**: `GSW↔GS`, `SAS↔SA`, `NYK↔NY`, `NOP↔NO`, `UTA↔UTAH`, `WAS↔WSH`
- **WNBA**: `CONN↔CON` (scoreboard only — all other WNBA abbrs match canonical) · **NHL**: `TBL↔TB`, `NJD↔NJ`, `LAK↔LA`, `SJS↔SJ`

Add new scoreboard mismatches to the `espnScore` field in `api/lib/teams.js` (CANONICAL_TO_ESPN is derived from it since 2026-06-11). Note: `WNBA_CANON_TO_ESPN` is for a *different* ESPN endpoint (stats/injuries) and uses different forms (CONNECTICU, DALLAS, WAS, LAS — the registry's `espnStats` field) — do NOT use it for the `/api/live` scoreboard map.

**`gameScores` today + tomorrow merge**: Each scoreboard fetch that produces `gameScores` fetches today AND tomorrow in parallel and merges into `parseGameScores`. Key shape: `${hA}|${gameDate}|${event.date}` — prevents today's Final from being wiped after midnight UTC, and prevents DH game 2 from overwriting game 1. The inline duplicate in `api/lib/mlb.js` (~line 952) must mirror the same key shape. Frontend `LineupsPage.buildGames` keys by `${sortedPair}|${gameDate}|${gameTime}` for the same reason.

**Kalshi UNDER pricing — use `no_ask_dollars`, not `1 - yes_ask_dollars`**: YES and NO order books are independent — typical spread is 3–7 cents. Synthesizing UNDER price as `1 - yes_ask` inflates measured edge by 3–7%. Fix landed 2026-05-15: parse loop reads `m.no_ask_dollars` and propagates `noKalshiPct` + `noKalshiAO`. Filter UNDER calibration by `trackedAt ≥ 2026-05-15`.

**Kalshi snap-first read chain (`/api/tonight`)**:
1. **`kalshi:snap:{ticker}`** — written every 2 min by cron. All-or-nothing: all fresh (`writtenAt` within 180s) → skip Kalshi REST entirely.
2. **`kalshi:bundle:{date}`** — legacy 600s bundle fallback.
3. **REST + `kalshi:stale:{ticker}`** — per-ticker fetch with 30-min stale fallback.

`KXMLBGAME` has the same 3-tier chain. **Diagnosing `usedSnaps:false`:** check `kalshiSnap.meta` in `/api/tonight?debug=1` — `null` meta means no cron completed in the last 10 min, pointing at a cron-side failure rather than a freshness race; non-zero `meta.snapWriteFailed` (2026-06-12) means Upstash rejected pipeline chunks. The snapshot pipeline write is size-chunked at 7MB because Upstash caps any HTTP request at 10MB — the full-slate body hit ~11MB once KXMLBTB/KXMLBHIT shipped, and the previously-unchecked fetch swallowed the 413s silently. See `docs/INFRA.md` for the two-phase cron write design.

**API handler env-var wiring**: ALL env vars must be passed through `process.env` to the explicit `env` object at the bottom of `api/[...path].js` (handlers receive `env`, never read `process.env` directly). If you add a new env var, add it here too:
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

**Shadow-snapshot KV staging (2026-06-07, fixed 2026-06-10)**: Tonight handler writes `shadow:staging:{date}` to Upstash (TTL 6h) immediately after DC computation, before the isDebug return. Shadow-snapshot reads this key first (~100ms) instead of re-fetching `/api/tonight?debug=1` (40-55s), keeping it well under the 60s edge wall-clock. `plays` contains all prop plays (qualified + non-qualified) and all qualified game-total/ML/spread plays. `dropped` contains all non-qualifying game-total, team-total, ML/spread, F5/halves plays with computed truePct (edge_too_low + kalshi_out_of_window). Pre-fix (2026-06-07 to 2026-06-09) `dropped` was always empty (all game-total/ML-spread edge_too_low branches were guarded by `else if (isDebug)`) — fix changed them to unconditional `else { dropped.push() }`. Shadow calibration data for game-totals/ML/spread from those 3 days is incomplete. Props (which used a separate `plays` path in non-debug) were always captured. Diagnosing: check shadow-snapshot response for `dropped > 0` to confirm the fix is working. Since 2026-06-10 the payload also carries `writtenAt` and `shadow-pregame-snap` reads the same key with a 15-min staleness gate (HTTP-fetching `/api/tonight` 504'd all three pregame runs on 2026-06-10 — 6/10 CLV data is missing); each pregame cron is scheduled 5–10 min after a tonight cron so staging is fresh.

**Neon HTTP SQL API (`api/lib/neon.js`) — four gotchas**:
1. Uses `@neondatabase/serverless` (Edge-compatible). Raw fetch to the Neon hostname fails with "missing authentication credentials" — the Vercel-managed host doesn't accept manual `Authorization: Basic` headers.
2. `neon().query(sql, params)` returns the rows array **directly** (not `{ rows: [...] }`). Do NOT do `result.rows ?? []`.
3. DDL must go through `neonExec()` which splits on `;` and runs each statement separately. Multi-statement DDL in a single `query()` call fails with "cannot insert multiple commands into a prepared statement". `sql.unsafe()` is a raw-value marker, NOT an executor.
4. **DATE columns come back as JS Date objects.** `String(row.date_col).slice(0,10)` gives locale format. Always use `new Date(row.date_col).toISOString().slice(0,10)`.
