# Scoreboard — Project Guide for Claude

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

**Model version**: Universal client qualification is `dcQualified === true && edge >= 5`. SimScore is display-only. Client `EDGE_GATE = 5`; server `EDGE_GATE = 3` for calibration continuity. `trackPlay` stamps `modelVersion: "v2"`. The `qualified` field carries only alt-line-demotion semantics now.

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
- `src/components/` — `LineupsPage`, `MatchupCard`, `PlaysColumn`, `MyPicksColumn`, `ReportPage`, `TeamPage`, `TotalsBarChart`, `DayBar`, `AddPickModal`

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
- `/api/kalshi-order` — `POST`, authenticated. Body: `{ ticker, side: "yes"|"no", price: int (1–99), count: int }`. Signs via **RSA-PSS / SHA-256 / saltLength=32** with `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY`. **Signature message: `timestamp_ms + "POST" + "/trade-api/v2/portfolio/orders"`** (ms timestamp, path only, no body). Supports PKCS#1 and PKCS#8 PEM. Returns the full Kalshi `order` object; the frontend reads `taker_fill_count`/`taker_fill_cost` and stamps the tracked pick with the real fill (cost→`units`, avg price→`americanOdds`, plus `kalshiCount`/`kalshiAvgCents`/`kalshiRestingCount`). Filled cost/odds verified to match Kalshi to the penny 27/27 picks (2026-05-30 via `/api/kalshi-fills`); resting (0-fill) orders track at intended size with a note.
- `/api/kalshi-balance` — `GET`, authenticated. Returns `{ balanceCents, balanceDollars }` from Kalshi live portfolio. Same RSA-PSS signing (message: `timestamp_ms + "GET" + "/trade-api/v2/portfolio/balance"`). No caching.
- `/api/kalshi-snapshot` — cron-only (`*/2 * * * *`). Writes per-ticker `kalshi:snap:{ticker}` for all 26 tickers. **Hardcoded ticker list MUST stay in sync** with `SERIES_CONFIG` inside `/api/tonight`.
- `/api/auth/calibration` — outcome stats. Returns `overall`, `byCategory`, `byCategoryDetail`, `kStrikeouts`.
- `/api/user/picks` — GET/POST picks (bearer JWT). POST accepts delta `{upserts, deletes, bankroll}` or legacy `{picks, bankroll}`.
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
| Team Totals | Poisson (MLB), Normal (NBA) | regime blend (conservative cap for MLB), seasonHitRate blend |
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

**NBA/WNBA injury OffRtg shrink — piecewise (2026-05-28), MPG-weighted (2026-05-30)**: `_injuryOffRtgAdj` is piecewise on USG-out share: ≤20% × 0.15, 20-35% × 0.22, 35-50% × 0.30, >50% × 0.35, floor 0.70. **Each out player's USG% is now weighted by `avgMin/48` (cap 1.0; missing avgMin → weight 1.0)** — raw-summing over-counted low-minutes players (OKC WCF Game 7: J-Williams 26.8 + Mitchell 22.3 + 0-min rookie Sorber summed to 49.1 → 36-50% tier ×0.30, vs 27.8 weighted → 21-35% tier ×0.22). Companion `_injuryBlendDamp(usageOut) = max(0, min(1, (42 − usageOut) / 21))` (range rescaled ×0.7 from 60/30 to match the weighted scale) scales regime and seasonHitRate blends to 0 as USG-out rises. See `docs/MODEL.md`; filter `trackedAt < 2026-05-30` from NBA/WNBA total/teamTotal/ml/spread calibration. **Latent bug (unfixed, flagged 2026-05-30):** the `dc.js` heavy-injury gate is `homeUsageOut >= 0.30` but `usageOut` is a 0–100 value → fires on essentially every NBA/WNBA ml/spread with any injury; almost certainly should be `>= 30` (both NBA ~L69 and WNBA ~L79 branches).

**Regime-aware lambda blend**: All game/team totals blend recency-weighted recent-score means into rating-based expected (21d half-life NBA/WNBA/NHL, 14d MLB). Cap 0.85/denom 8 for game totals + NBA team totals; MLB team totals use 0.50/denom 12. See `docs/MODEL.md`; calibration cutoffs: `< 2026-05-21` NBA/WNBA/NHL total+teamTotal, `< 2026-05-25` MLB total/ML/spread, `< 2026-05-27` MLB teamTotal.

**MLB lineup-aware lambda (2026-05-18)**: Game-total/team-total/ML/spread λ multiplied by hitter-out tier (0/1/2/3+ → ×1.0/0.98/0.96/0.93). Probable pitcher on IL nulls starter → bullpen-only ERA fallback. dc penalties: -1 at topOut ≥ 2, -2 at pitcherOnIL. Filter `trackedAt < 2026-05-18` for total/teamTotal/ML/spread calibration.

**TEAM_NORM (Kalshi → ESPN)**: NBA `{ GS→GSW, SA→SAS, NY→NYK, NJ→BKN, NO→NOP, PHO→PHX, WPH→PHX, KAT→ATL }`. WNBA `{ CONNECTICU→CONN, CON→CONN, DALLAS→DAL, WAS→WSH, GSV→GS, LAS→LA }`. After building `STAT_SOFT` rankMaps, a post-normalization loop adds the long-form key so `nbaDefRank["GSW"]` resolves.

**WNBA `parseGameTeams` — variable-length abbrs**: WNBA mixes 2-, 3-, and 4-char canonical abbrs. The WNBA branch tries every (i, len−i) split 2–4 chars each half, preferring longer left-side first (`CONNIN` → `CONN+IND`). `_VALID_TEAMS["wnba"]` is the 15-team canonical set.

**`parseGameTeams` validation via `_VALID_TEAMS`**: Without validation a 2-char Kalshi prefix steals the parse (`NYKPHI` → `NY`+`KPH`). The parser tries 3+3 first when length≥6 and only commits if both halves validate; falls back to 2+3 (also validated). Symptom of breakage: duplicate matchup cards. Maintain `_VALID_TEAMS` when teams rebrand (e.g. OAK→ATH).

**Kalshi ticker home/away order doesn't match ESPN.** `parseGameTeams` returns ticker order, not home/away. Each play loop must look up the actual home team and swap if needed: MLB uses `sportByteam.mlb.gameHomeTeams[gameTeam2]`; NBA/NHL scan `sportByteam.{nba,nhl}GameScores`. Two enforcement sites: game-total loop and team-total loop.

**NHL_ABBR_MAP**: NHL Stats API teamIds → abbreviations. **UTA (Utah Mammoth) = teamId 68** (rebranded 2025-26; old teamId 53 absent). New teams showing `—` need their teamId added.

**ESPN scoreboard abbr mismatch**: `/api/live` translates at the ESPN boundary via `CANONICAL_TO_ESPN` / `ESPN_TO_CANONICAL` (sport-keyed). Symptom of unmapped team: `state:"unknown"`, pick never resolves.
- **MLB**: `CWS↔CHW` · **NBA**: `GSW↔GS`, `SAS↔SA`, `NYK↔NY`, `NOP↔NO`, `UTA↔UTAH`, `WAS↔WSH`
- **WNBA**: `CONN↔CON` · **NHL**: `TBL↔TB`, `NJD↔NJ`, `LAK↔LA`, `SJS↔SJ`

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
};
```
Symptom of missing wire-up: `env?.VAR` is `undefined` even though Vercel dashboard shows it set.

**Kalshi UNDER pricing — use `no_ask_dollars`, not `1 - yes_ask_dollars`**: YES and NO order books are independent — typical spread is 3–7 cents. Synthesizing UNDER price as `1 - yes_ask` inflates measured edge by 3–7%. Fix landed 2026-05-15: parse loop reads `m.no_ask_dollars` and propagates `noKalshiPct` + `noKalshiAO`. Filter UNDER calibration by `trackedAt ≥ 2026-05-15`.

**Kalshi snap-first read chain (`/api/tonight`)**:
1. **`kalshi:snap:{ticker}`** — written every 2 min by cron. All-or-nothing: all fresh (`writtenAt` within 180s) → skip Kalshi REST entirely.
2. **`kalshi:bundle:{date}`** — legacy 600s bundle fallback.
3. **REST + `kalshi:stale:{ticker}`** — per-ticker fetch with 30-min stale fallback.

`KXMLBGAME` has the same 3-tier chain. The all-or-nothing snap gate is intentional — mixed-source recovery adds complexity without reducing failure modes.
