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
**Universal qualification**: Kalshi 67–91% · Edge ≥ 3% · SimScore ≥ 8/10. Game/team totals gate UNDERs by the same `noKalshiPct ∈ [67, 91]` window. Tunables live as module-level constants `KALSHI_GATE` (67, ~-200 floor) / `KALSHI_CAP` (91, ~-1000 cap) / `EDGE_GATE` / `SIMSCORE_GATE` in both `api/[...path].js` and `src/App.jsx` — change in both places.

---

## Where to look

| Topic | File |
|---|---|
| Per-sport modeling internals (SimScore tiers, lambdas, miscAdj, gates, Kalshi parsing details, dedup logic) | `docs/MODEL.md` |
| Cache keys + TTLs, Upstash storage, env vars, deployment, testing, data sources | `docs/INFRA.md` |
| URL routing, App.jsx state shape, Market Report internals, live tracking mechanics, sizing, color doctrine + per-play-type explanation table | `docs/FRONTEND.md` |
| Common debugging recipes | `docs/DEBUGGING.md` |

The cross-cutting gotchas at the bottom of this file are kept inline because they bite during *any* change, not just modeling work.

---

## Architecture

### API: `api/[...path].js` + `api/lib/`
Single Vercel Edge Function. Imports four ES module lib files:
- `api/lib/simulate.js` — park factors + simulation functions (`log5K`, `simulateKsDist`, `buildNbaStatDist`, `simulateHits`, `simulateMLBTotalDist/NBATotalDist/NHLTotalDist`, `simulateTeamTotalDist`, `simulateTeamPtsDist`, `kDistPct/nbaDistPct/totalDistPct`, kelly/EV math), `TTO_DECAY_FACTOR`, `UMPIRE_KFACTOR`
- `api/lib/mlb.js` — `buildLineupKPct` (also exports `batterSplitBA`, `batterHRRSplits`), `buildBarrelPct`, `buildPitcherKPct` (also exports `pitcherRecentKPct`, `pitcherLastStartDate`, `pitcherLastStartPC`, `pitcherInfoByTeam`, `pitcherAvgBF`, `pitcherStdBF`, `umpireByGame`), `MLB_ID_TO_ABBR`. Pitcher gamelog batch uses `Promise.allSettled`.
- `api/lib/nba.js` — `buildNbaDvpStage1/FromBettingPros/Stage3FG`, `buildNbaDepthChartPos`, `buildNbaPaceData`, `buildNbaPlayerPosFromSleeper`, `warmPlayerInfoCache`, `buildNbaUsageRate`, `buildNbaInjuryReport`
- `api/lib/wnba.js` — `buildWnbaPaceData`, `buildWnbaUsageRate`, `buildWnbaInjuryReport`, `buildWnbaDvp` (server-side stat-allowed aggregate — BettingPros has no WNBA page), `WNBA_TEAM_IDS` (15 hardcoded; ESPN `/teams` list endpoint is broken for WNBA), `WNBA_ESPN_TO_CANON`/`WNBA_CANON_TO_ESPN` (CONNECTICU↔CONN, DALLAS↔DAL). WNBA model anchors on 2025 season data.
- `api/lib/utils.js` — CORS helpers, `parseGameOdds` (returns `{total, moneyline, spread}`), `parseGameScores` (returns `{state, detail, homeScore, awayScore, gameDate, gameTime, seriesSummary}` keyed by home abbr; `seriesSummary` non-null in NBA/NHL playoffs), team rank helpers (`buildSoftTeamAbbrs`, `buildHardTeamAbbrs`, `buildTeamRankMap`)

### Frontend: Vite + React (`src/`)
Entry: `index.html` → `src/main.jsx` → `src/App.jsx`. Vercel runs `npm run build` → `dist/` on push.

- `src/App.jsx` — top-level state, routing, data fetching, player card
- `src/lib/constants.js` — `TEAM_DB`, `TOTAL_THRESHOLDS`, `MOCK_PLAYS`, `GAMELOG_COLS`, sport/stat metadata
- `src/lib/utils.js` — `slugify`, `teamUrl`, `logoUrl(sport, abbr)` (handles ESPN CDN abbr mismatches NHL `tbl→tb, njd→nj, lak→la, sjs→sj`; NBA `kat→atl`)
- `src/lib/liveStats.js` — live pick tracking helpers
- `src/lib/hooks.js` — `useIsMobile(threshold=600)`: resize+orientation-aware boolean. Use this for responsive layouts (e.g. `LineupsPage` toolbar wraps to 2 rows on mobile). `SimBadge`/`DayBar` tooltips also support tap-to-pin so SimScore breakdowns are accessible on touch devices.
- `src/components/` — `LineupsPage` (homepage tab layout), `MatchupCard` (per-game card; MLB renders a starting-pitcher row + game total/ML center column, NBA/WNBA/NHL render a "top player" row with the scoreboard Rating/Points leader and their stats), `PlaysColumn` (per-sport explanation branches: MLB-K, MLB-hitter, NBA, WNBA, NHL + generic fallback; WNBA mirrors NBA with retuned tiers and reads `play.wnba*` fields), `MyPicksColumn`, `MarketReport`, `ModelPage`, `TeamPage`, `TotalsBarChart`, `DayBar`, `AddPickModal`

**Dev proxy**: `vite.config.js` proxies `/api` to production so `npm run dev` works without local backend.

See `docs/INFRA.md` for storage and cache details.

---

## Routes
- `/api/tonight` — main play generation. `?debug=1` returns dropped/preDropped + debug fields. `?bust=1` bypasses caches. **Frontend always passes `?bust=1` on the initial page-load fetch** (`App.jsx` ~line 230). The previous client-side sessionStorage cache (`tonight_v1_${date}`, 2-min TTL) was removed for absolute freshness — every browser tab session now pays the cold cost (~5–8s) once on entry. App is a SPA so this useEffect fires once per tab session, not per in-app navigation. Manual ↻ button (`bustCache()`) also fetches `?bust=1`.
- `/api/kalshi` — raw Kalshi market data
- `/api/player`, `/api/gamelog` — ESPN player info + gamelog
- `/api/team` — team page data (gameLog, lineup, season stats, nextGame)
- `/api/live` — in-game boxscore for pick tracking (`?games=mlb:LAD:SD,nba:GSW:LAL`); player props poll this; total/team-total picks resolve from existing `meta.gameScores` (no extra fetch)
- `/api/dvp`, `/api/nba-depth`, `/api/dvp/debug-dc` — DVP/depth chart. Branches: `basketball/nba`, `basketball/wnba` (returns `position`, `rankMaps`/`softTeams`/`hardTeams` for points/rebounds/assists/threePointers from `byteam:wnba`; canonical aliases added via `WNBA_ESPN_TO_CANON` so lookups by ticker abbr resolve), `football/nfl`, `hockey/nhl`, `baseball/mlb`.
- `/api/auth/{register,login,reset,list-users,debug-redis,calibration,clear-kalshi-stale}` — auth + admin. Password min 8 chars. Admin endpoints fail-closed if `ADMIN_KEY` missing.
- `/api/auth/clear-kalshi-stale` — `POST ?ticker=KXMLBTEAMTOTAL` with `Authorization: Bearer <ADMIN_KEY>`. Deletes `kalshi:stale:{ticker}` so the next cold bundle build attempts Kalshi fresh instead of serving the stale entry. Use when a series has been rate-limit-stuck on stale data past the 30-min TTL window. Ticker validated against `/^KX[A-Z0-9]+$/`. Does **not** affect `kalshi:snap:{ticker}` — those refresh on the 2-min cron.
- `/api/kalshi-snapshot` — cron-only (`*/2 * * * *` in vercel.json). Fetches all 24 Kalshi series tickers (18 SERIES_CONFIG + game totals + KXMLBGAME) and writes per-ticker `kalshi:snap:{ticker}` keys via Upstash pipeline. Bearer-auth: `CRON_SECRET`. Returns `{ok, successCount, failedCount, failed[], durationMs}`. **Hardcoded ticker list MUST stay in sync** with `SERIES_CONFIG` inside `/api/tonight` — add new series to both places.
- `/api/auth/calibration` — outcome stats. Auth: bearer JWT (any user) or `?adminKey=`. Returns `overall`, `byCategory`, `byCategoryDetail` (per-category truePct buckets, used by `CalibModule` per ModelPage tab), `kStrikeouts` (K-feature breakdowns).
- `/api/user/picks` — GET/POST user picks (bearer JWT)
- `/api/keepalive` — daily cron

---

## Models (summary)
See `docs/MODEL.md` for SimScore tiers, lambda formulas, gates, dedup, and Kalshi parsing details.

- **MLB Strikeouts** — `simulateKsDist` Monte Carlo (10k/5k), shared distribution per `team|hand` for monotonicity. Pre-sim: A1 recent form, A2 rest, E3a umpire, K% regression, E3b expectedBF blended 2026/2025. SimScore: CSW%, lineup oK%, blended hit rate (starts-only), H2H Hand, O/U.
- **MLB Hitters (HRR)** — logit-sigmoid park adjustment on `(primaryPct + softPct)/2`. softPct = BvP rate or handedness fallback. Gates: lineup spot 1–5.
- **NBA player props** — `buildNbaStatDist`, `miscAdj = injuryBoost × blowoutRisk × homeAwaySplit`. SimScore: USG% (or AvgMin for REB), DVP ratio, Season HR, Soft/Tier HR, game O/U.
- **WNBA player props** — same engine, retuned tiers (USG 27/22, MIN 27/22, game O/U 168/158). 2025 anchor.
- **NHL Points** — same engine. SimScore: TOI, GAA rank, Season HR, DVP HR, O/U.
- **NFL** — passing/rushing/receiving yards, receptions, completions, attempts. Gate: opp in soft teams.
- **Game Totals** — Poisson MC for MLB/NHL, Normal for NBA/WNBA; sample-weighted blend with seasonHitRate. MLB edge dampener when `|threshold − OU| ≥ 3`.
- **Team Totals (MLB, NBA only)** — MLB Poisson with 50/50 ttSeasonHitRate blend; NBA Normal with sample-weighted blend.

---

## Key Gotchas

**TEAM_NORM (Kalshi → ESPN)**: NBA `{ GS→GSW, SA→SAS, NY→NYK, NJ→BKN, NO→NOP, PHO→PHX, WPH→PHX, KAT→ATL }`. WNBA `{ CONNECTICU→CONN, CON→CONN, DALLAS→DAL, WAS→WSH, GSV→GS, LAS→LA }` — ESPN returns Connecticut as either `CON` (current byteam) or `CONNECTICU` (older scoreboard); both alias to canonical `CONN`. Kalshi tickers use canonical (`CONN`, `DAL`). After building `STAT_SOFT["nba|*"]` / `STAT_SOFT["wnba|*"]` rankMaps from ESPN byteam (which also returns short codes), a post-normalization loop adds the long-form key so `nbaDefRank["GSW"]` resolves.

**WNBA `parseGameTeams` — variable-length abbrs**: WNBA mixes 2-, 3-, and 4-char canonical abbrs (`LV/NY/GS/LA` + `ATL/IND/DAL` + `CONN`). NBA's 3+3-first / 2+3-fallback parser doesn't handle 2+2 (`LVNY`, `GSLA`) or 4-char halves (`CONNIN`, `LVCONN`). The WNBA branch in `parseGameTeams` tries every (i, len−i) split with both halves length 2–4, preferring longer left-side first (so `CONNIN` → `CONN+IND`, not `CO+NNIN`). `_VALID_TEAMS["wnba"]` is the 15-team canonical set; tickers also use this set, so the longest-prefix-wins heuristic is safe.

**`parseGameTeams` validation via `_VALID_TEAMS`**: The Kalshi event ticker's team segment is parsed by trying splits in order. Without validation, a 2-char Kalshi prefix that's *also* the first 2 chars of the actual 3-char team would steal the parse — e.g. `NYKPHI` would split as `NY`(→NYK) + `KPH` (garbage), turning a PHI vs NYK matchup into NYK vs KPH. Same for `SASMIN`→`SA`+`SMI`. Symptom: duplicate matchup cards on the home page (one keyed by the Kalshi-corrupted abbrs, one by ESPN's correct gameScores entry). Fix: hardcoded `_VALID_TEAMS` set per sport — the parser tries 3+3 first when length≥6 and only commits if both halves validate; falls back to 2+3 (also validated) only if 3+3 fails. Affected pairings: NBA SAS/SAC/NYK/NOP, NHL NJD/TBL/LAK/SJS, MLB ARI (via "AZ" prefix). Maintain `_VALID_TEAMS` when teams rebrand (e.g. OAK→ATH).

**Kalshi ticker home/away order doesn't match ESPN.** `parseGameTeams` returns `[team1, team2]` in ticker order, which is *not* necessarily home/away. Each play loop's homeTeam/awayTeam assignment must look up the actual home team and swap if needed: MLB uses `sportByteam.mlb.gameHomeTeams[gameTeam2]`; NBA/NHL scan `sportByteam.{nba,nhl}GameScores` values for a matching `homeTeam == gameTeam2 AND awayTeam == gameTeam1` pair. Without this, matchup cards display the inverted "AWAY @ HOME" string for any game where Kalshi's ticker order disagrees with ESPN's home assignment. Two sites enforce this: the game-total loop and the team-total loop (NBA team total is the only non-MLB team total in production today; NHL has no team totals).

**NHL_ABBR_MAP**: NHL Stats API teamIds → abbreviations. **UTA (Utah Mammoth) = teamId 68** (rebranded from Utah Hockey Club for 2025-26; old teamId 53 absent). New teams showing `—` for GPG/GAA/SA need their teamId added.

**ESPN scoreboard abbr mismatch**: ESPN scoreboard's `team.abbreviation` differs from our canonical for several teams. `/api/live` translates at the ESPN boundary via `CANONICAL_TO_ESPN` / `ESPN_TO_CANONICAL` (sport-keyed) so picks tracked with the canonical abbr still match the ESPN event, and the response's `homeTeam`/`awayTeam` come back canonical (matching `pick.homeTeam` etc.). Symptom of an unmapped team: `/api/live` returns `state:"unknown"` and the pick never auto-resolves. Current map:
- **MLB**: `CWS↔CHW` (Chicago White Sox; canonical from `MLB_ID_TO_ABBR[145]`)
- **NBA**: `GSW↔GS`, `SAS↔SA`, `NYK↔NY`, `NOP↔NO`, `UTA↔UTAH`, `WAS↔WSH`
- **WNBA**: `CONN↔CON` (live scoreboard returns short `CON`; older byteam returns `CONNECTICU`; `DAL` matches canonical on the scoreboard so no `/api/live` translation needed)
- **NHL**: `TBL↔TB`, `NJD↔NJ`, `LAK↔LA`, `SJS↔SJ`

If a team rebrands or a new mismatch surfaces, add it to `CANONICAL_TO_ESPN` in the `/api/live` handler — `ESPN_TO_CANONICAL` is auto-derived. Same canonical-vs-ESPN-abbr divergence applies when filtering ESPN-sourced schedule events — see `docs/MODEL.md` for `_gtScheduleMap`/`_ttScheduleMap` `normTeam` requirement.

**gameTimes lookup chain** (in play loop): `sport:team:gameDate` → `sport:team:tomorrowISOStr` (handles Kalshi encoding tomorrow's games under today's ticker date) → bare `sport:team`.

**`gameScores` today + tomorrow merge**: Each ESPN scoreboard fetch that produces `gameScores` (MLB tonight, NBA tonight, NBA fallback, NHL fallback) fetches **today AND tomorrow in parallel** (PT date, `Date.now() - 7h`) and passes merged events to `parseGameScores`. Today's events alone go to `parseGameOdds`/probables (so tomorrow doesn't overwrite today's pitcher/odds). `parseGameScores` keys by `${hA}|${gameDate}` so today's NYY and tomorrow's NYY don't collide. Without this, when today's MLB is all `state==="post"` (or after midnight UTC for NBA/NHL using UTC date), today's "Final" data is wiped and the today-tab matchup cards have no `gameState` to seed.

**Two-way players** (MLB strikeouts): ESPN gamelog defaults to **batting** stats. The play loop appends `&category=pitching` for all MLB K-market players and pitcher gamelog fetches. Separate Redis cache keys (`gl:mlb242526pv1`, `gl:mlb2025p|`, `gl:mlb2026p|`) prevent batting/pitching collision. Without this, two-way players (e.g. Ohtani) drop with `col_not_found` because the K column is absent from batting gamelog.

**ESPN gamelog endpoint**: ESPN now blocks server-side HTML page fetches with AWS WAF. Use the JSON API (`site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog`) for ALL sports including NBA/NHL.

**NBA lineup source chain**: (1) ESPN scoreboard → game summary boxscore starters (today's actual, `lineupConfirmed:true`); (2) most recent **playoff** schedule game first (`seasontype=3`), fallback to regular season `lastGameId` only if no playoff games — boxscore starters; (3) ESPN team roster (one player per position group, up to 8). ESPN depth chart (`/teams/{abbr}/depthchart`) returns `{}` during playoffs — removed. Always prefer playoff over regular season — RS finals often have rested/bench starters that don't reflect playoff rotations.

**MLB lineup**: (1) MLB Stats API schedule `hydrate=lineups,probables` (PT date `Date.now()-7h`); (2) active roster fallback (non-pitchers, up to 12, `spot:null`, `lineupConfirmed:false`).

**`mlbMeta.pitchers[abbr]` shape**: `{ name, id, era, wins, losses }`. `id` is the MLB Stats API personId (used for `midfield.mlbstatic.com/v1/people/{id}/spots/120` headshots — preferred over ESPN). Sources are merged in `api/[...path].js` ~line 4890: `name` from probables→pitcherInfoByTeam; `id` from pitcherInfoByTeam→probables; `era` from `pitcherEra` (MLB Stats API)→probables; `wins`/`losses` from `pitcherWinsByTeam`/`pitcherLossesByTeam` (2026 if any starts/decisions, else 2025). `mlbMetaTomorrow.pitchers` parallel-fetches the `personIds=...&hydrate=stats(group=pitching,type=season,season=2026)` endpoint once per `_tmrDateStr` (cache key `mlbTmrPitcherStats:{date}`, 10min TTL) to populate ERA/W-L for next-day probables. Any field may be null; `MatchupCard` only renders the pieces present.

**Closing-line snapshots (`mlbClosingOdds` / `nbaClosingOdds` / `wnbaClosingOdds` / `nhlClosingOdds`)**: ESPN scoreboard returns empty `odds` once a game is in/post, so live odds maps would lose entries mid-day. One Redis key per sport holds `{"home|away|gameDate": {home, away}}`. NBA/WNBA/NHL share an inline `_applyClosingSnapshot(snapKey, scoresMap, oddsMap)` helper; MLB uses a parallel block (it must run *before* the Kalshi fill, and after `_mlbGameOddsTomorrow` is computed). For each game in `gameScores`: `state==='pre'` writes the live odds to the snapshot (live odds map chosen by gameDate vs today's PT — MLB today's games use `_mlbGameOdds`, tomorrow's use `_mlbGameOddsTomorrow`); `state==='in'|'post'` overlays the snapshot back so the matchup card displays the *closing* line. 36h TTL refreshes on each write; keys aren't date-prefixed so they survive midnight rollover. **If no snapshot exists for an in/post game** (e.g., the service was first deployed mid-game), live odds entries are **cleared** rather than left visible — in-progress prices look like real lines but are model-derived mid-game values, so we hide them rather than mislead.

**`mlbMeta.gameOdds` vs `mlbMetaTomorrow.gameOdds`**: Today's odds come from `parseGameOdds(sbData.events)` (today-only ESPN scoreboard fetch); tomorrow's from `parseGameOdds(sbData.eventsTomorrow)` (also fetched in the same `Promise.all` at the byteam:mlb build site). Both are normalized through `MLB_ESPN_NORM` and persisted on `sportByteam.mlb` as `gameOdds`/`gameOddsTomorrow`. `MatchupCard` selects between today and tomorrow by `game.gameDate` vs PT today so a team playing on both days doesn't show today's line on the tomorrow tab.

**Kalshi-derived MLB odds fallback**: ESPN doesn't post tomorrow's lines until close to first pitch. Right before the closing-odds snapshot, we walk the already-fetched `KXMLBGAME` and `KXMLBTOTAL` market arrays. For ML: take both teams' yes-prices, normalize to remove overround, convert to American odds. For total: same "highest threshold where yes≥50%" heuristic used elsewhere. Keyed by `{abbrA}|{abbrB}|{gameDate}` (gameDate parsed from `expected_expiration_time` → PT) and only fills *missing* fields on `_mlbGameOdds` / `_mlbGameOddsTomorrow`. ESPN remains authoritative when it has data. The Kalshi fill runs before the snapshot block, so pre-game writes to `mlbClosingOdds` capture whichever source supplied the line, and in/post overlays still display the closing snapshot rather than live Kalshi.

**`{sport}Meta.topPlayers[abbr]` (NBA/WNBA/NHL)**: `{ name, id, headshot, stats }` extracted from ESPN scoreboard `competitions[].competitors[].leaders` by `parseTopPlayers` in `api/lib/utils.js`. NBA/WNBA use the `RAT` (Rating) category leader and parse `displayValue` (`"X PPG, Y RPG, Z APG, …"`) into `"X PPG · Y RPG · Z APG"`. NHL uses the `Points` leader; derives the missing leg whichever way it can — if the same athlete also leads Goals, computes `A = P − G`; if they also lead Assists, computes `G = P − A`; otherwise falls back to just `"PTS"`. Headshot prefers `athlete.headshot.href`, falls back to `https://a.espncdn.com/i/headshots/{league}/players/full/{id}.png`. Today-only — `MatchupCard` looks up by raw `homeTeam`/`awayTeam` abbr without a date-based selector (NBA/NHL/WNBA tabs are typically single-day).

**byteam:mlb partial-cache trap**: MLB byteam hydrates several MLB Stats API calls in parallel and each `.catch(() => ({}))` silently. A successful lineup fetch alongside a failed OPS or gamelog fetch would otherwise bake partial data for 10min — short-TTL guard (60s) fires when any of `lineupSpotByName`, `pitcherAvgPitches`, `hitterOpsMap`, `pitcherH2HStarts` is empty. Symptom: MarketReport columns null across many rows; diff cached vs `?bust=1` to confirm.

**Edge handler env-var wiring**: ALL env vars must be passed through `process.env` to the explicit `env` object at the bottom of `api/[...path].js`. Vercel doesn't auto-attach them. If you add a new env var, add it here too:
```js
const env = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_KEY: process.env.ADMIN_KEY,
  CRON_SECRET: process.env.CRON_SECRET,
};
```
Symptom of missing wire-up: `env?.VAR` is `undefined` even though Vercel dashboard shows it set. JWT_SECRET specifically: `TextEncoder.encode(undefined)` = 0 bytes → `"Imported HMAC key length (0)"` 500 on login.

**Kalshi UNDER pricing — use `no_ask_dollars`, not `1 - yes_ask_dollars`**: Kalshi binary markets have **independent** YES and NO order books. `yes_ask` is the cost to buy YES; `no_ask` is the cost to buy NO. They are NOT mirrors — typical spread is 3–7 cents (e.g. yes_ask=0.17, no_ask=0.87 instead of the "fair" 0.83). Synthesizing the UNDER price as `1 - yes_ask` systematically underprices UNDERs and inflates their measured edge by 3–7%. **Fix landed 2026-05-15**: the parse loop now reads `m.no_ask_dollars` alongside `yes_ask_dollars` and propagates `noKalshiPct` + `noKalshiAO` through `totalMarkets`/`teamTotalMarkets` push payloads. Emission sites (game total ~4684, team total MLB ~4882, team total NBA ~4969) consume the passed-through fields with a `?? (100 - kalshiPct)` fallback for the missing-data case. Player-prop UNDERs are not affected (Kalshi doesn't list player-prop UNDER alt lines as separate markets). Pre-fix UNDER picks tracked before 2026-05-15 have wrong `kalshiPct`/`americanOdds`/`edge` values — filter them out of calibration.

**Kalshi snap-first read chain (`/api/tonight`)**: Layered fallback so a cron-down or 429-spiked Kalshi doesn't blank the page:
1. **`kalshi:snap:{ticker}`** — written every 2 min by `/api/kalshi-snapshot` cron. All-or-nothing: if every series snap is fresh (`writtenAt` within 180s, i.e. 1.5 cron cycles) we use them and skip Kalshi REST entirely. Read via single Upstash MGET so each `/api/tonight` invocation is 1 Upstash command for snap data + 1 for meta.
2. **`kalshi:bundle:{date}`** — legacy 600s bundle. Used if snap-first fails (cron down, partial snap miss).
3. **REST + `kalshi:stale:{ticker}`** — existing per-ticker fetch with throttled batches and 30-min stale fallback. Kicks in for cold-start and full-snap-miss cases.

`KXMLBGAME` (MLB game ML, not in `SERIES_CONFIG` but used for tomorrow's odds fallback) has the same 3-tier chain: `kalshi:snap:KXMLBGAME` → `kalshi:KXMLBGAME` (600s legacy) → direct REST.

The all-or-nothing snap gate is intentional. Mixed-source recovery (some snaps fresh, some REST) adds complexity without meaningfully reducing failure modes — the bundle/REST fallback already handles a partial snap miss correctly.
