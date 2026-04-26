# Common Debugging

### "Player card explanation is blank / missing prose (stats present in market report)"
A player visible in the market report has their play in `dropped[]` (debug-only), which means `tonightPlayerMap` has no entry for them → `tonightHitPlay` / `tonightTabPlay` is null → explanation renders blank.

**When this can still happen**: only for the MLB HRR pre-gates (`low_lineup_spot` spot ≥ 5, or `hitterSimScore < 5`). All other gates (edge, simScore < 8) now push to `plays[]` with `qualified: false`.

**Diagnosis**: check `?debug=1` → `dropped[]` for the player. If `reason` is `"low_lineup_spot"` or `"low_confidence"` with `hitterSimScore < 7`, they hit a pre-gate before truePct was computed — no explanation data exists. Any other reason means a gap in the qualified:false push logic.

### "Non-MLB player card shows 'No game data found' or 'Could not load game log'"
The `/api/gamelog` endpoint for non-MLB sports (NBA, NHL, NFL) scrapes ESPN HTML pages (`www.espn.com/{sport}/player/gamelog/...`) and parses the `window['__espnfitt__']` JavaScript variable. **Vercel Edge Functions are frequently served a bot-detection page by ESPN** that does not contain `__espnfitt__` → the endpoint returns `{error: "Could not find __espnfitt__ data in page"}` with HTTP 500.

**Before fix (commit 9452812)**: `loadPlayer` had no `.ok` check — it called `.json()` on a 500 response, got `{error: "..."}`, passed it to `parseGameLog` which returned empty data → silently showed "No game data found" with no explanation.

**After fix**: `if (!gameRes.ok) throw new Error('Could not load game log')` → catch block shows "Could not load game log: Could not load game log" in the player card error state — honest failure, not misleading empty state.

**Root cause is unfixable on our side**: ESPN blocks server-side requests to their HTML gamelog pages from Vercel's IP ranges. The JSON API (`site.web.api.espn.com/apis/common/v3/sports/...`) used by the main play loop works fine (different domain). A full fix would require switching `/api/gamelog` to use the same JSON API endpoint, but parsing is different and player card gamelog tables would need updating. The HTML scraper works fine from a browser/local machine.

### "Why is truePct wrong for 3+/4+ when 5+ looks correct?" (fixed)
Previously, `tonightPlayerMap` was built from `tonightPlays` (filtered: `qualified !== false`). Thresholds like 3+/4+ with no edge bonus (finalSimScore < 8) were `qualified: false` and omitted, so the player card used the raw fallback formula `(seasonPct + softPct) / 2` — breaking monotonicity (e.g. 4+ showed 76.8% while 5+ showed 97.9%).

**Fix**: `tonightPlayerMap` now uses `allTonightPlays` (unfiltered), which includes `qualified: false` entries with their API-computed, monotonicity-enforced simulation truePct.

If truePct still looks wrong: check `?debug=1` and look in `dropped` for the missing threshold — if it's there (not in `plays[]` at all), the fallback still applies. Check `reason`. Current gate reasons: `"threshold_too_high"` (threshold > ceil(expectedKs) + 2), `"insufficient_starts"`, `"simScore_too_low"` (finalSimScore < 8).

### "Why is truePct the same for 4+ and 5+?"
The `pitcherKDistCache` shares one `Int16Array` distribution across all thresholds for a pitcher — querying it at different thresholds guarantees P(K≥4) ≥ P(K≥5) by construction. If values are identical, it likely means the distribution is flat at that range (e.g. a dominant pitcher where nearly all sims exceed both thresholds).

### "Player appears in Kalshi but not in plays or dropped"
Check `preDropped` in `?debug=1` response. Common reasons: `no_opp`, `insufficient_starts` (MLB strikeouts only). NBA no longer has an `opp_not_soft` pre-filter — all NBA markets enter the play loop.

Also check the date filter: the edge function runs UTC, so after midnight UTC (e.g. 8pm ET = midnight UTC), `gameDate:"2026-04-13"` is filtered if the server sees the next day. The cutoff is `Date.now() - 86400000` (yesterday) to handle this — but if a play was on a date 2+ days ago, it will still be filtered.

### "Market report shows — for Spot/Brrl%"
- Spot: lineup not confirmed yet (pre-game). Projected lineups from last 14 days are used as fallback. The spot map scans ALL games in the window most-recent-first and takes each player's most recent batting position — so if a player DNP'ed yesterday their prior-game spot is preserved. The primary lineup IDs (for K% stat fetching) still come from the single most recent game that has players.
- Brrl%: Baseball Savant fetch timed out or returned empty. Cached in KV for 6h — bust cache with `?bust=1`.
- After a cache bust: if `buildLineupKPct` or `buildPitcherKPct` hits an early-return (no games scheduled or all IDs empty), all destructured fields must be present in the return value — otherwise `lineupSpotByName` and `pitcherAvgPitches` come back `undefined`, causing `—` for every row. The early-return and catch blocks in `api/lib/mlb.js` include the full field set: `lineupSpotByName`, `lineupBatterKPctsOrdered`, etc. for lineup; `pitcherAvgPitches`, `pitcherEra`, `pitcherCSWPct` for pitchers.

### "P/GS all dashes"
Comes from gamelog starts-only (2026 primary) or season aggregate fallback `numberOfPitches / gamesStarted`. If a pitcher has 0 starts recorded yet in either source, will show `—`. Also check that `buildPitcherKPct` didn't hit the early-return path (see above).

### "P/GS shows wrong value for a confirmed starter (non-doubleheader)"
Two bugs can cause this:

**Bug A — stale KV cache with wrong probable:** The `byteam:mlb` KV cache (600s TTL) was built when a different pitcher was listed as the team's probable. The old `_pt()` team key lookup returned that wrong pitcher's avgPitches.

**Bug B — in-progress game poisons the average (UTC vs local date mismatch):** The pitcher has a game today (local date e.g. "2026-04-15") but the server's UTC clock already reads the next day ("2026-04-16"). The `_todayStr` filter (`new Date().toISOString().slice(0,10)`) = "2026-04-16", so "2026-04-15" != "2026-04-16" passes the filter. If the game is in progress at cache-build time (e.g. NP=2 after first pitch), the tiny partial NP poisons the average: `(91+83+92+2)/4 = 67` instead of 88.7.

**Fixes:**
- `mlb.js` `startSplits` filter now requires `(s.stat?.numberOfPitches || 0) >= 30` — catches in-progress games that slip through the date filter due to UTC/local mismatch. A legitimate start always has 30+ pitches.
- `_avgP` IIFE in `[...path].js` (strikeouts block) uses a priority chain:
  1. **Name-based** (`_ps?.avgPitches` from `pitcherStatsByName`) — correct when pitcher is in probables
  2. **ESPN gamelog starts-only** — `IP >= 3` as start proxy; pitcher-specific; ESPN uses column `"P"` (not `"PC"`) for pitches, code tries both labels
  3. **Team key fallback** — last resort; may return wrong pitcher if cache is stale

`_avgP` is hoisted (`let _avgP = null`) at the outer per-market declarations so all 4 output sites use it.

### "Wrong pitcher stats for a team on a doubleheader day"
When a team plays two games (e.g. a makeup game + a regular game), the schedule loop processes both games and `pitcherByTeam["SD"]` ends up pointing to whichever pitcher was processed last — not necessarily tonight's Kalshi pitcher.

**Different-opponent doubleheader** (e.g. SD vs OAK + SD vs SEA): matchup keys `"SD|OAK"` and `"SD|SEA"` are distinct — the `_pt()` helper tries `team|opp` first and gets the right pitcher.

**Same-opponent doubleheader** (e.g. SD vs SEA twice): both games share the same matchup key `"SD|SEA"`. The second game overwrites `pitcherByTeam["SD"]` AND `pitcherByTeam["SD|SEA"]`, and drops the first pitcher's ID from `allIds` entirely — so their stats are never fetched.

Fix (in place): `allScheduledPitcherIds` (a `Set`) collects ALL pitcher IDs encountered in the schedule loop, regardless of overwrite. `allIds` is built from this set so every pitcher's season stats and gamelog are always fetched. `pitcherAvgPitchesById` stores avg pitches per MLB ID (not just per abbr). `cswByMlbId` is declared outside the CSW% try block. `pitcherStatsByName` has a fallback path for IDs in `allScheduledPitcherIds` that have no abbr in `pitcherByTeam` — it computes K%, KBB%, ERA, CSW%, avgPitches, gs26, hasAnchor directly from the raw ID-keyed data.

### "API returning 504 / function stopped after 25s"
The CSW% play-by-play fetch in `buildPitcherKPct` fires one MLB Stats API request per game per pitcher. With 10–15 pitchers × multiple starts, this can exceed the 25s Vercel Edge limit. Mitigations in place: PBP limited to last 5 starts per pitcher; **5s** AbortController aborts the whole PBP block and falls back to K% if slow (reduced from 8s in commit `c5d5b14`).

Secondary cache fetches (DVP, NBA depth chart, barrel%, NBA pace) are now fired in two parallel `Promise.all` rounds instead of four sequential awaits — saves up to ~10s on cold cache (commit `c5d5b14`). On a full Sunday slate (15 games) the function now returns in ~14s.

If 504s recur: check whether PBP block is the bottleneck (add `console.time` around it in a debug branch) or if BettingPros DVP fetch is slow (it's the most expensive cold fallback at ~5-10s).

### Cache busting
- `?bust=1` skips reads for `byteam:mlb`, `byteam:nhl`, `byteam:nba`, `byteam:nba:scoring`, `gameTimes:v2:{date}`, AND `nba:pace:2526` — forces fresh MLB + NHL + NBA data, ESPN game times, and NBA pace in one shot
- `mlb:barrelPct` is NOT busted — barrel% survives with its own 6h TTL
- If bust fires before lineups/probables are available, `byteam:mlb` is written with 60s TTL so next request retries
- Depth chart: no bust — expires daily

### "NBA totals show massive UNDER edges during playoffs (false positives)"
During the NBA playoffs, ESPN's `byteam?category=scoring` and `?category=defensive` endpoints return playoff stats — often only 1-3 games of sample. Teams scoring 96-104 PPG vs actual regular season 115-120 PPG causes model to compute `expectedTotal=183` while market O/U is 213+, creating false UNDER edges of 60-70%.

**Fix (in place)**: Both endpoints add `&seasontype=2` to force regular season averages year-round. This is the same approach used for `buildNbaUsageRate` (player stats with `types/2`).

**Symptom to watch for**: If NBA UNDER plays appear with `noTruePct > 70%` (high UNDER model confidence) but `gameOuLine` is 210+, suspect playoff stat distortion. Check `homeOff`/`awayOff` fields — values < 110 indicate the endpoint may be returning playoff data again. Fix: verify `&seasontype=2` is present in both URLs.

### "NBA report shows — for Pace/AvgMin/Rest on most rows"
All NBA markets now go through the full simulation loop (no opp_not_soft pre-filter). Every market computes pace, C1, DVP, B2B, and game total in the main block. If most rows show `—`, the ESPN gamelog or pace data fetch likely failed for that player — check `_debug` field in dropped entries.

### "NBA 3P SimScore C1 shows — or seems wrong"
For `threePointers`, C1 is now scored on **USG%** (same as points and assists). `nba3pMPG` is still computed and stored in play output for display but no longer drives the score. Check `?debug=1` → `plays[].nbaUsage` for the raw value. If null, falls back to 2pt abstain.

### "NBA USG% is null / showing — in tooltip for all players"
`buildNbaUsageRate` fetches `sports.core.api.espn.com/v2/.../seasons/2026/types/2/athletes/{id}/statistics`. Common failure modes:

- **Wrong endpoint**: the `site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}/statistics` URL returns only season/league metadata — no `statistics` array. Always use `sports.core.api.espn.com`.
- **Wrong path**: ESPN `usageRate` is 0.0 (not populated by ESPN). The fallback uses `avgFGA`/`avgFTA`/`avgTO`/`avgMin` from `d.splits.categories`. If all four fields are 0 (e.g. player not found, wrong ID, 404), `avgFGA > 0` guard fails → no entry added → `null → 2pts` abstain.
- **Wrong ESPN ID**: `playerInfoMap` maps Kalshi player names to ESPN IDs via `warmPlayerInfoCache`. If the ESPN ID is wrong, the core API returns 404. Check `?debug=1` → `plays[].nbaUsage` for the affected player — note this is only relevant for `points` plays; assists use `nbaAvgAst`, rebounds use `nbaAvgReb`, 3-pointers use `nba3pMPG`.
- **Season type**: `types/2` = Regular Season. If fetched during Playoffs (type=3) or Play-In (type=5), regular season stats still exist — type 2 is correct year-round for regular season averages.

### "NBA pace shows — for New Orleans (NOP) players"
`buildNbaPaceData` stores pace under ESPN's team abbreviation. ESPN returns "NO" for New Orleans, but `playerTeam` is normalized to "NOP" via `TEAM_NORM`. Fix already in place: `buildNbaPaceData` adds long-form aliases (`NO→NOP`, `GS→GSW`, etc.) after building `teamPace`. If pace is null for another team, check `TEAM_NORM` in `api/[...path].js` — the ESPN short code may need a new alias in `buildNbaPaceData`'s `_shortToLong` map.

### "NBA avgMin (nbaOpportunity) is null for all players"
ESPN returns two season types that both contain "regular" in their name: `"2025-26 Play In Regular Season"` (1 game) and `"2025-26 Regular Season"` (80 games). The old `.find("regular")` took the Play-In type first — `_minVals.length = 1 < 3` gate fails → `nbaOpportunity = null`. Fix: `parseEspnGamelog` now prefers season types with "regular" that do NOT contain "play". Gamelog cache key is `gl:v2|nba|player` — if you need to re-bust, bump the version prefix.

### "NBA player markets missing during playoffs" (resolved — DVP gate removed)

The opp_not_soft pre-filter was removed (commit 1a3357e). All NBA markets now enter the play loop unconditionally. If NBA plays are missing, check `preDropped` for `no_opp` (team extraction failed) or inspect `dropped` for `edge_too_low` / `simScore_too_low`. DVP ratio still affects SimScore (0/1/2 pts) but is no longer a gate.

### "Kalshi market visible on app but missing from our pipeline"

**Root cause**: A market can be visible on the Kalshi web app (showing odds like -382) but have `yes_ask_dollars = 0` or null in the trading API — it's in a pre-market or preview state. The pipeline skips `price = 0` markets with `if (pct <= 0) continue`. This is correct behavior — the market isn't yet open for trading.

**How to confirm**: If a player has only one stat/threshold showing in `preDropped` (e.g. Jokic threePointers only, no assists), the missing stat's market is not yet in the Kalshi trading API. Once Kalshi opens the market for trading (assigns an ask price), it will appear in the pipeline on the next request — no cache bust needed (Kalshi data is always fetched fresh).

**What happens when it goes live** (Jokic assists vs MIN example):
1. Pre-filter: MIN is in `C.softTeams.assists` → passes ✓
2. Main loop: DVP ratio ≥ 1.05 → 2pts SimScore; C1 (USG%/AvgMin) → up to 2pts; season HR, soft HR, pace+total → additional pts
3. truePct computed via Monte Carlo simulation
4. If edge ≥ 5% AND simScore ≥ 8 → qualifies as a play

### "User picks not persisting / login works but picks disappear"
Most likely cause: **Upstash free tier exhausted** (500k commands/month). Symptoms: login succeeds, picks save without JS errors, but on reload picks are gone. The `makeCache()` Upstash wrapper silently returns null on all operations when Redis returns HTTP 400.

**Diagnosis:** `GET /api/auth/debug-redis?adminKey=<ADMIN_KEY>` — check `match: true/false` and `setRaw` for the Upstash error message.

**Fix:** In Upstash console (`console.upstash.com`), either upgrade the database to Pay-As-You-Go or create a new free database and update `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` in Vercel → Environment Variables → Redeploy.

**Recovery:** Picks are always mirrored to `localStorage` as a backup (even when logged in). On next login after Redis is restored, the frontend detects server has 0 picks and auto-restores from localStorage, then pushes to server. For picks from before the localStorage backup was added (pre-2026-04-16): use `/api/auth/import-kalshi-picks` to recover from Kalshi fill history.

### "Calibration tab throws TypeError: Cannot read properties of undefined (reading 'filter')"
**Root cause**: Two separate issues that compound:

1. **API returns `{error:"Forbidden"}` instead of calibration data** — the frontend `fetchCalib()` had `adminKey=sb-admin-2026` hardcoded; if the Vercel `ADMIN_KEY` env var is different, the API returns a 403. `calibData` becomes `{error:"Forbidden"}` which passes the `calibData && !calibLoading` guard, so the IIFE fires and destructures `overall = undefined` → `.filter()` crash.

2. **Missing `!calibData.error` guard** — the IIFE condition was `calibData && !calibLoading` without excluding error responses. Fix: added `&& !calibData.error` so the IIFE only runs when the response has the expected shape.

**Auth fix**: calibration endpoint now accepts `Authorization: Bearer <jwt>` (any logged-in user). Frontend sends the stored auth token — no hardcoded key needed. `?adminKey=<ADMIN_KEY>` still works as a curl/debug fallback. **Never hardcode the admin key in the frontend.**

### "Need to recover picks from Kalshi fill history"
`POST /api/auth/import-kalshi-picks` with `{kalshiSession, adminKey, userId}` fetches the last 5 days of YES fills from Kalshi, maps each ticker to playerName/sport/stat/threshold, auto-populates `result: "won"/"lost"` for finalized markets, and merges into the user's server picks without duplicates.

**Getting `kalshiSession`:** Kalshi's public trading API no longer supports email/password login (removed). The web app uses a `session` cookie. In Chrome DevTools on kalshi.com → Application tab → Cookies → `api.elections.kalshi.com` → copy the `session` cookie value. Pass as `kalshiSession`.

**Note:** Kalshi's `session` cookie only authenticates against the web app's backend, not directly against `api.elections.kalshi.com/trade-api/v2/portfolio/fills` — the import endpoint forwards the cookie in the `Cookie:` header, which does work for the fills endpoint when the session is active.

### "Game time shows 1 hour off (e.g. 6:40 PT instead of 5:40 PT)"
`gameTimes:v2:{date}` is populated from ESPN's scoreboard `ev.date` (UTC ISO string). The display uses `timeZone:"America/Los_Angeles"` which is always PDT/PST-aware. If the displayed time is 1 hour late, ESPN returned a UTC timestamp that was computed using PST (UTC-8) instead of PDT (UTC-7) — effectively not applying daylight saving for that game.

**Fix**: `?bust=1` now skips the `gameTimes` cache read and forces a fresh fetch from ESPN. If ESPN has corrected the time in their data, the bust will pick it up. If ESPN consistently returns the wrong time for that game, the offset persists until ESPN fixes their data.

### "Game time shows completely wrong time (e.g. 12:45 PM instead of 7:15 PM)"
**Root cause**: The `gameTimes` date-specific key (`sport:team:ptDate`) was unconditionally overwritten on every event encountered. ESPN scoreboards return yesterday's and today's events combined — if an earlier game's event (different game, wrong time) was processed after the correct game for the same team+date, it silently overwrote the correct time.

**Fix (commit 9452812)**: Changed the date-specific key from always-overwrite to latest-UTC-time-wins: `if (!_existDt || ev.date > _existDt) gameTimes[key:ptDate] = ev.date`. The most chronologically recent event for a team+date wins, which is the correct current game.

### "Play card or player card shows 'Tomorrow' for a game that's today"
**Root cause**: `gameTimes["mlb:TOR"]` was keyed only by team, not by PT date. When the backend fetched only UTC-today's ESPN scoreboard, a game at 5:10 PM PT on Apr 18 returned as `2026-04-19T00:10Z` (UTC Apr 19). The bare key was set from that Apr 19 entry → `gameTime` pointed to tomorrow.

**Fix (in place)**:
1. Backend now fetches **both yesterday and today** ESPN scoreboards in parallel per sport (`Promise.all([yesterday, today])`), merging events from both.
2. `gameTimes` now stores entries keyed by **PT date** (`"sport:team:ptDate"`) alongside the bare fallback. A game at 2026-04-18 PT is stored under `"mlb:TOR:2026-04-18"` even if its UTC time is Apr 19.
3. Play loop lookup: `gameTimes["sport:team:gameDate"]` first (PT-date-specific), falls back to bare `"sport:team"`. **This applies to player props, game totals, AND team totals** — all three use the date-specific key first.
4. Day label in play card and player card uses `play.gameDate` directly for the Today/Tomorrow comparison — not re-derived from `gameTime` — so even if `gameTime` is UTC-tomorrow, the label still says "Today" when Kalshi's `gameDate` is today.

**Multi-game series bug (commit ba25af4)**: When a team plays consecutive days (series), yesterday's game at 7:15 PM PT has UTC time `T02:15Z` of tomorrow's UTC date. The bare fallback key `gameTimes["mlb:LAD"]` was set to the yesterday game's time (first-seen-wins) and never updated. Game totals and team totals didn't use the date-specific key — they only used the bare key. Fix: game totals and team totals now use `gameTimes["sport:team:gameDate"]` first, matching player props. The date-specific key correctly has the today game's time.

**Team page game time**: uses `data.nextGame.gameTime` (from `/api/team`) as the primary source, independent of Kalshi market state. Reliable even when today's market is closed (game in progress or finalized). Falls back to `tonightPlay.gameTime` if `nextGame` is null.

### "Star (☆/★) not highlighted on player card or team page after navigating from My Picks"
Two separate bugs caused this:

**Player card bug (commit 9452812)**: `_today` was computed as `new Date().toISOString().slice(0,10)` — UTC date. After 5 PM PDT (midnight UTC), `_today` becomes tomorrow's UTC date while picks have today's PT `gameDate` → `pd >= _today` = false → `isTracked = false` → star shows ☆ instead of ★.
**Fix**: compute `_today` using local date: `` `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` ``

**TotalsBarChart bug (commit 9452812)**: Used direct string equality `p.id === trackId` where `trackId` was built from `tp.gameDate`. If `tp` was null (threshold not in `allTonightPlays`) or `tp.gameDate` mismatched the stored pick's `gameDate`, `isTracked` was always false.
**Fix**: Replaced with `existingPick` find pattern — matches by `sport|homeTeam|awayTeam|threshold` with local date guard (`pd >= _localToday`), using `tp ?? tonightPlay` as the anchor. Stores the actual matched pick's `id` in `_untrackId` so untracking works correctly too.

### "MLB game total SimScore badge shows 10/10 despite yellow ERA/RPG stats in explanation"
The explanation card colors (eraColor/rpgColor) use the **tiered** formula — yellow ERA means 1 pt (not max 2), yellow RPG means 1 pt (not max 2). If the badge shows 10/10 when stats are yellow, production is running **old code**. Current formula: `> 4.5 → 2pts, > 3.5 → 1pt, ≤ 3.5 → 0pts` for ERA; `> 5.0 → 2pts, > 4.0 → 1pt, ≤ 4.0 → 0pts` for RPG. Park RF removed from scoring entirely (was previously 2pts for |RF-1|>0.01).

**Diagnosis:** `git log --oneline origin/main..HEAD` — if this shows unpushed commits, Vercel is running the old code. **Fix:** `git push origin main`.

### "NHL game total SimScore badge shows 10/10 despite gray GPG stats in explanation"
The explanation card `gpgColor`/`gaaColor` use the tiered formula — gray GPG means 0 pts (< 3.0), green means 2pts (≥ 3.5), yellow means 1pt (≥ 3.0). Current formula: `≥ 3.5 → 2pts, ≥ 3.0 → 1pt, < 3.0 → 0pts` for both GPG and GAA. O/U tier (max 2pts) replaced SA rank. If badge shows 10/10 for gray stats, check for unpushed commits.

**Diagnosis:** `git log --oneline origin/main..HEAD` — if this shows unpushed commits, Vercel is running the old code. **Fix:** `git push origin main`.

### "SimScore shows yellow for strikeout players with score 5–7"
The qualifying gate for all sports is `finalSimScore >= 8` (Alpha tier). The report SimScore column uses `>= 5` as the yellow threshold, so scores 5–7 show yellow (near miss) and scores < 5 show gray.

### "No MLB plays / all edge_too_low or empty response"
**Most likely cause: Kalshi markets haven't opened yet for today's slate.**

Kalshi only publishes MLB player prop markets a few hours before first pitch — they are NOT available overnight. If you check before ~late morning ET, the previous day's markets will be finalized and today's won't be live yet.

**How finalized markets appear in the data:**
- `status: "finalized"`, `yes_ask: None`, `price: 0`
- The `if (price === 0) continue` guard skips them silently
- `/api/tonight?debug=1` returns empty `plays[]`, empty `dropped[]` — not a bug

**How to decode Kalshi event tickers to confirm the date:**
- Format: `KXMLBKS-26APR152140SEASD` = series `KXMLBKS`, date `26APR15` (April 15 2026), game time `2140` ET, SEA @ SD
- If all tickers show yesterday's date → today's markets aren't open yet
- `close_time` ~04:55–05:00 UTC = game ended ~midnight–1am ET the night before

**Stale KV cache pattern:**
- `byteam:mlb` (600s TTL) may be built while yesterday's markets were still live, caching yesterday's pitcher data (e.g. Hancock for SEA when tonight's starter is Castillo)
- After all games end and markets finalize, the cache still holds stale pitcher stats until TTL expires
- Fix: `?bust=1` clears the KV cache; do this after markets open for today's slate

**Diagnosis steps:**
1. Call `/api/kalshi` directly — if it returns 0 markets or all `price=0`, markets aren't open yet
2. Check ticker date segments — `26APR15` = yesterday, `26APR16` = today
3. Check first pitch time — Kalshi typically publishes 2–4 hours before first pitch
4. If markets are open but plays are missing, check `/api/tonight?debug=1` → `preDropped` for `no_opp` / `opp_not_soft`

**MLB team ID reference** (MLB Stats API `teams.*.id` in schedule response):
- 133 = OAK (Athletics), 134 = PIT (Pirates), 135 = SD (Padres), 136 = SEA (Mariners)
- 120 = WSH (Nationals), 147 = NYY (Yankees), 121 = NYM (Mets), 111 = BOS (Red Sox)
- Full map in `MLB_ID_TO_ABBR` constant in `api/lib/mlb.js`

**ESPN as reliable fallback for today's probables:**
When the MLB Stats API has delays returning probables (occasionally), ESPN's scoreboard reliably has them:
`site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=YYYYMMDD`
The `buildPitcherKPct` function currently only uses MLB Stats API — if probables come back empty from there, all pitcher stats will be missing. No ESPN fallback implemented yet.

### "MLB/NHL game totals missing from market report" (fixed 2026-04-17)
Three bugs caused game totals to be invisible in the market report:

**Bug 1 — Edge calculation subtracted spreadAdj (affected all total sports):**
The totals loop used `edge = rawEdge - spreadAdj` instead of `edge = rawEdge`. A total with rawEdge=4% and kalshiSpread=4¢ → spreadAdj=2 → edge=2% → silently filtered. Fix: `edge = rawEdge` (same as player props).

**Bug 2 — Filtered totals not added to `dropped[]` in debug mode:**
When `truePct == null` or `edge < 3`, the total was `continue`-d without being pushed to `dropped[]`. So in debug mode (market report) those markets were completely invisible — not in `plays`, not in `dropped`. Fix: in `isDebug` mode, push to `dropped[]` with reason `"no_simulation_data"` or `"edge_too_low"`.

**Bug 3 — MLB `mlbRPGMap` always empty (ESPN column name mismatch):**
`mlbRPGMap` is built from ESPN's batting byteam API. The code searched for column names `"G"/"GP"` (games) and `"R"` (runs) but ESPN returns `"gamesPlayed"` and `"runs"`. Both `findIndex` calls returned -1, the guard `if (_gIdx !== -1 && _rIdx !== -1)` was always false, so `mlbRPGMap` was never populated. `homeRPG` and `awayRPG` were always null → lambda always null → `truePct == null` for every MLB total. Fix: accept both naming conventions (`"G" || "GP" || "gamesPlayed"` and `"R" || "runs"`).

**Symptoms before fix:** market report showed 0 rows for `mlb|totalRuns` and `nhl|totalGoals`; `nba|totalPoints` might show if rawEdge was large enough to survive the spread deduction.

**Diagnosis:** `GET /api/tonight?debug=1` → count `plays` and `dropped` items where `gameType === "total"` and `sport === "mlb"`. Before fix: 0. After fix: all thresholds appear in `plays` (edge ≥ 3%) or `dropped` (edge_too_low / no_simulation_data). Check `homeRPG`/`awayRPG` fields in dropped items — null means the batting API column names changed again.

### "NBA totals show dashes for awayOff/homeDef/awayDef — truePct null" (fixed 2026-04-17)
Two bugs caused NBA total sim data to be missing for certain teams:

**Bug 1 — Kalshi non-standard team code not in TEAM_NORM:**
Kalshi uses "WPH" for the Phoenix Suns (PHX) in their NBA tickers. `TEAM_NORM.nba` only had `PHO→PHX`; "WPH" fell through unchanged. `nbaOffPPGMap["WPH"]` and `nbaDefRank["WPH"]` returned null → `awayOff`/`awayDef` null → `truePct` null → low score.
Fix: add `WPH: "PHX"` to `TEAM_NORM.nba`.

**Bug 2 — STAT_SOFT rankMap uses raw ESPN short codes:**
ESPN's general NBA byteam endpoint returns "GS" for Golden State (same short codes as the scoring endpoint). `buildTeamRankMap` stores them raw, so `nbaDefRank["GSW"]` didn't exist — `homeDef` was null for all GSW games.
Fix: after building `STAT_SOFT["nba|*"]`, a post-normalization loop adds long-form aliases: for each raw key in `rankMap`, if `TEAM_NORM.nba[raw]` exists and the long key isn't already present, copy the entry under the long key. Same for `softTeams`.

**How to spot:** `homeOff` present but `homeDef` null → Bug 2. `awayOff` null → Bug 1 (new Kalshi short code not in TEAM_NORM). If a new team abbreviation from Kalshi causes nulls, add it to `TEAM_NORM.nba` in `api/[...path].js` ~line 1036.

### "HRR card shows inflated softGames (300+), wrong AB count, wrong label" (fixed 2026-04-17)
Three bugs in the MLB hitter (hits/hrr) explanation cards:

**Bug 1 — H2H date collision inflating softGames and hitterAbVsPitcher:**
`softVals` for H2H path (`_pitcherDates.size > 0`) matched by date only: `gl.events.filter(ev => _pitcherDates.has(ev.date))`. If Walker faced ATL on 2022-07-15, and Olson (then with OAK) also played a game that day, Olson's OAK game was counted as a Walker H2H at-bat. Over a multi-season career gamelog this inflates softGames to 300+ and hitterAbVsPitcher to 1000+.
Fix: add `ev.oppAbbr === tonightOpp` guard to both paths. Also added `season === 2025 || 2026` filter to the `hitterAbVsPitcher` team-level fallback (was previously pulling all-career AB vs the team).

**Bug 2 — Hardcoded "against weak pitching matchups" label for all HRR:**
For strikeouts `softLabel` is the lineup K% bucket (correctly labelled). For hitters, `softLabel` is `"vs Taijuan Walker"` (H2H) or `"vs PHI"` (team fallback), but the play card and player card hardcoded "against weak pitching matchups" instead of using it.
Fix: added `hitterSoftLabel: softLabel` to play output; both card render sites now use `play.hitterSoftLabel ?? "against weak pitching matchups"`.

**Bug 3 — seasonG (game count) used blendGames (2025+2026) while seasonPct showed pct26 (2026-only):**
`seasonG = play.blendGames || play.seasonGames` — for a veteran like Olson this gives 182 (2025+2026 combined) even when `seasonPct` is the 2026-only rate. Label read "89.5% of games this season (182g)" but only ~19 2026 games existed.
Fix: `seasonG = play.pct26 != null ? play.pct26Games : (play.blendGames || play.seasonGames)`. Label changes to "2025-26" when pct26 is null (blended rate).
Applied in the top explanation block (line ~2930) AND the no-H2H branch (line ~3074) — both are render sites for this count. The no-H2H branch was missed in the original fix (commit f782fcf).

**Post-fix values for Matt Olson (example):** `softGames: 26` (was 344), `hitterAbVsPitcher: 105` (was 1300), `hitterSoftLabel: "vs Taijuan Walker"`, `seasonG: 19` (was 182).

**Diagnosis tip — fix appears deployed but screenshot still shows old values:**
If the API returns correct data (e.g. `pct26Games: 18`) and the source code at the render site is correct, but the UI still shows the old behavior (e.g. "126 games this season"), the browser is running a cached `index.html`. The old code for this bug had `games this season` hardcoded; the new code conditionally shows `"this season"` vs `"in 2025-26"` — making it easy to distinguish. Fix: **Cmd+Shift+R** (hard refresh) to bypass browser cache.

**MLB hitter play card — one explanation box (commit ae29862):**
Previously MLB hitters (hits/hrr) rendered two separate gray boxes: (1) player/pitcher stats + season rate, (2) opponent ERA rank + no-H2H. The second box was redundant — it repeated the season rate in the no-H2H path. Fix: ERA rank sentence and no-H2H line merged into the first box (after the season/soft rate line). Second box condition now excludes `play.sport !== "mlb"` so it only fires for NFL. Single box flow: lineup → pitcher WHIP/FIP → season rate [+ soft pct if H2H] → ERA rank + no-H2H → park factor → game total → SimScore.

### "/api/team returns 0 scores and 0-0 record"
Two ESPN response shape mismatches discovered after initial deployment (fixed in commit `eff1a4f`):

**Bug 1 — Score is an object, not a number:**
`comp.competitors[n].score` returns `{value: 8.0, displayValue: "8"}` — not a raw number. `parseFloat({...})` = `NaN → 0`.
Fix: `parseFloat(comp.score?.value ?? comp.score?.displayValue ?? comp.score) || 0`.

**Bug 2 — Record field is `recordSummary`, not `record.items[0].summary`:**
The ESPN team schedule response uses `sched.team.recordSummary` (e.g. `"15-4"`). The `record` key is null.
Fix: `sched.team?.recordSummary || sched.team?.record?.items?.[0]?.summary`.

**Expected empty lineup states (not bugs):**
- MLB: if schedule returns no lineup AND roster fetch also fails → `lineup = []` → lineup section hidden (rare)
- NBA: depth chart empty during playoffs → falls through to boxscore starters (game day) or roster fallback (no game today); lineup section only hidden if all three sources return nothing
Both are handled gracefully by the `lineup.length > 0` guard on the inline lineup section.

### "Platoon disadvantage not showing in prose even when tooltip shows Platoon: 0/2" (fixed 779c354)
**Root cause**: `oppPitcherHand` was never added to the final play object in the `plays[]` push (only to `_hlCommon` which is spread into `dropped[]` entries). In the frontend, the prose condition `platoonPts === 0 && pitcherHand` always failed because `play.oppPitcherHand` was `undefined` → `pitcherHand = null` (falsy).

`hitterPlatoonPts === 0` requires `_oppPitcherHand !== null` to be computed (else stays at 1 abstain), so the tooltip could show `0/2` while `oppPitcherHand` was absent from the play object — the two fields came from different code paths.

**Fix**: promoted `_oppPitcherHand` to `hitterOppPitcherHand` at outer scope (alongside `hitterPlatoonPts` declaration), assigned after the const inside the MLB hitter block, and added `oppPitcherHand: hitterOppPitcherHand` to the plays push (~line 3018).

### "WHIP shows yellow in prose but tooltip shows 0/3" (fixed 779c354)
**Root cause**: `whipColor` used a 3-tier scale (>1.35 green, >1.20 yellow, ≤1.20 red) but the SimScore formula is binary — only >1.35 earns 3pts, everything else earns 0pts. A WHIP of 1.32 rendered yellow, implying 2nd-tier points, while the SimScore tooltip correctly showed 0/3.

**Fix**: changed middle tier from `#e3b341` (yellow) to `#c9d1d9` (neutral). Yellow is now reserved exclusively for tiers that actually earn SimScore points. The descriptive text ("some traffic on base") still provides informational context in gray.

**Further fix**: `whipColor` is now binary — `> 1.35 → green` (earns 3pts), `≤ 1.35 → red` (earns 0pts). WHIP always shows in prose; red signals it's a non-contributing factor. Users see color as a quick signal rather than having to check the tooltip.

### "ERA rank sentence dominates HRR card even when H2H data exists"
**Root cause**: The `oppRank` sentence ("LAA ranks 5th-worst in ERA allowed") fired whenever `play.oppRank` was present, regardless of whether H2H soft rate was already available. This was visually misleading — ERA is NOT a SimScore component, but got a prominent bold sentence while WHIP (an actual SimScore component) was suppressed to a sub-clause.

**Fix**: ERA rank sentence now only renders when `play.softPct === null` (no H2H data). When H2H data exists, the soft rate sentence already explains the matchup — the ERA rank sentence is redundant and confusing. The rank color was also changed from `#f78166` (red) to `#c9d1d9` (neutral) since ERA rank is contextual, not scored.

### "Platoon prose shows no stat to explain the advantage/disadvantage"
**Root cause**: The platoon prose showed "Platoon disadvantage vs LHP" with no numbers — users couldn't see why the model flagged it or how severe the disadvantage was.

**Fix**: Added `hitterSplitBA: _splitBA` to the play output (`_hlCommon` and plays push in `api/[...path].js`). The prose now highlights the split BA stat instead of the label words — "Hits `.229` vs LHP — platoon disadvantage (`.281` season)". The split BA is colored red (disadvantage) or green (edge); season BA neutral. Label text is always gray (`#8b949e`). Sentence structure: `Hits [splitBA] vs [hand] — platoon [edge|disadvantage][( [seasonBA] season)].`

### "Mock plays disappear a few seconds after toggling mock on"
**Root cause**: Race condition — toggling mock while an in-flight API fetch was pending. The `useEffect` set mock plays immediately, but when the stale fetch resolved, its `.then()` callback still fired and overwrote mock plays with API data.

**Fix**: Added `let cancelled = false` flag + `return () => { cancelled = true; }` cleanup to the `useEffect`. The `.then()` and `.catch()` callbacks guard with `if (cancelled) return` before setting any state.

### "Mock player card shows broken headshot image"
**Root cause**: `MOCK_PLAYS` entry used the MLB Stats API player ID (6-digit, e.g. `660271` for Shohei) instead of the ESPN player ID. `navigateToPlay` passes `play.playerId` as `player.id`, which is used to build the ESPN headshot URL (`a.espncdn.com/i/headshots/mlb/players/full/{id}.png`). MLB Stats API IDs are not ESPN IDs and produce a broken image.

**Fix**: use the ESPN player ID in `playerId` for all `MOCK_PLAYS` entries (e.g. `39832` for Shohei Ohtani). ESPN IDs for MLB players are typically in the 28000–50000 range; NBA players in the 3000000–6000000 range.

### "MLB HRR market report shows — for Opp pitcher early in the day"
**Root cause**: ESPN's `probables` (from the scoreboard `hydrate=lineups,probables`) is absent in the morning hours before teams announce their starters. `hitterPitcherName` resolved from `probables[tonightOpp]` only → null for all HRR entries.

**Fallback chain** (in order):
1. `sportByteam.mlb.probables[tonightOpp].name` — ESPN scoreboard (available ~2–3h before first pitch)
2. `sportByteam.mlb.pitcherInfoByTeam[tonightOpp].name` — MLB Stats API people response; probables announced previous day, very reliable. Built in `buildPitcherKPct` from the same people fetch used for season stats.
3. `pitcherGamelogs[tonightOpp].name` — if pitcher gamelog was loaded (i.e. pitcher is known from either source), the name is stored on the gamelog entry. Guarantees: if WHIP/FIP/BAA computed → pitcher name known.

**Why HRR rows in the report still show `—` for pitcher even after fix**: Most HRR entries are `dropped` (edge_too_low / low_confidence), not in `plays[]`. `hitterPitcherName` must be included in all drop objects (not just the plays push) for the report to show it. Check `_dropObj` and `low_confidence` drop in `api/[...path].js` hitter block.

**`pitcherInfoByTeam` map** (in `api/lib/mlb.js`): Built from `res26.people` and `res25.people` — the same MLB Stats API season stats fetch. Keys are team abbreviations (bare abbrs only; `"SD|SEA"` matchup keys excluded). Available whenever `buildPitcherKPct` returns, regardless of ESPN state.

### Strikeout SimScore component calibration history

SimScore thresholds have been tuned against settled pick outcomes. When win rates diverge from model predictions, the analysis steps are:

1. Pull settled picks via `/api/user/picks` (requires auth token from login)
2. Group by component value and compute actual win rate per tier
3. If a middle tier shows win rate < 70%, tighten it or eliminate it — a 61% win-rate tier scoring 2pts is giving too much credit
4. If win rate doesn't track the O/U line boundary assumed by scoring, move the cliff

**Calibration results (46 settled strikeout picks, April 2026) — informed Apr 2026 SimScore refactor:**

| Component | Original | After recal. | Current (post-refactor) | Rationale |
|---|---|---|---|---|
| `kpctPts` (CSW%/K%) | 3/2/1pts | 3/2/1pts | 2/1/0pts (rescaled) | Apr 2026 refactor: max-10 system; top tier was over-valued (62% win rate vs 88% for mid tier) |
| `lkpPts` (lineup oK%) | >24%→3, >16%→2, ≤16%→0 | >24%→3, >22%→2, ≤22%→0 | >24%→2, >22%→1, ≤22%→0 (rescaled) | Middle tier threshold raised to 22%; rescaled to max 2pts in refactor |
| `totalPts` (O/U tier) | ≤8.5→2, ≤10.5→1, >10.5→0 | ≤7.5→2, <10.5→1, ≥10.5→0 | ≤7.5→2, <10.5→1, ≥10.5→0 (unchanged) | Moved 2pt cliff from 8.5 → 7.5; max 2pts unchanged |
| `blendedHitRatePts` | (new) | (new) | ≥90%→2, ≥80%→1, <80%→0 | Replaces pitchesPts + kTrendPts; trust-weighted 2026/2025 observed hit rate |

**Calibration results (15 settled HRR picks, April 2026) — historical (pre-refactor):**

| Component | Previous | Status |
|---|---|---|
| `hitterPlatoonPts` (platoon advantage) | ≥1.08→2pts, ≥0.95→1pt, <0.95→0pts | Removed from SimScore in Apr 2026 refactor (still computed + displayed in prose) |

**Other patterns noted:**
- `historicalHitRate` < 65% with large model gap (e.g. Hancock: 14.3% hist vs 89.8% model) correlated with losses — now partly addressed by `blendedHitRatePts` and `hitterSeasonHitRatePts`
- When adding new SimScore components, run this analysis after 40+ settled picks; small samples produce misleading tier win rates

### "Strikeout player card K-trend prose is silent even though kTrendPts shows in tooltip"
**Root cause**: The player card builds its `h2h` object from `tonightPlayerMap` entries, but `pitcherRecentKPct` and `pitcherSeasonKPct` were not included in that object — only `kTrendPts` was. So `recK = h2h?.pitcherRecentKPct` was always null and the prose branch silently skipped.

**Fix**: Added `pitcherRecentKPct: tp.pitcherRecentKPct, pitcherSeasonKPct: tp.pitcherSeasonKPct` to the `h2h` object construction in the player card strikeout block (`index.html` ~line 2747). The K-trend prose renders `26.9% recent K% ↑ (24.1% season)` colored by `kTrendPts` tier.

### "SimScore tooltip shows — for Lineup K% even though prose shows a value"
**Root cause**: `lkpPts` is null when lineup wasn't confirmed at API run time (model counts this as 1pt abstain). The prose uses `h2h.lineupKPct` which may be filled from the DVP fallback, so the value appears in prose. But the tooltip used `h2h?.lkpPts ?? "—"` — null became `—` instead of showing the abstain point value.

**Fix**: Tooltip now uses `h2h?.lkpPts ?? 1` (and same for `blendedHitRatePts`), showing `1/2` to reflect the abstain scoring rather than `—`. Applied to both player card and play card `scTitle` strings.

**Same issue in market report SimScore tooltip**: the `xcell k==="sim"` block in `index.html` has its own tooltip string — separate from the player/play card `scTitle`. All null-abstain components use `?? 1` there too: strikeouts (`kbbPts`, `lkpPts`, `blendedHitRatePts`, `totalPts`) and HRR (`hitterBatterQualityPts`, `hitterWhipPts`, `hitterSeasonHitRatePts`, `hitterH2HHitRatePts`, `hitterTotalPts`).

### "Platoon column shows — in market report for players with low 2026 AB count"
`hitterSplitBA` is null when the player has < 20 combined AB vs that pitcher hand across 2025+2026. `batterSplitBA` is built in `buildLineupKPct` (`api/lib/mlb.js`) by fetching `statSplits` for both 2026 and 2025 in parallel, then summing raw AB/H before computing BA. Minimum: 20 combined AB (same as `hitterBa` floor). Previously 2026-only with 30 AB minimum — most early-season players failed this gate.

**Remaining null cases** (< 20 combined AB vs one hand): platoon-heavy bench players or genuinely hand-neutral players who face very few pitchers of one handedness across two seasons. `hitterPlatoonPts` stays null → SimScore counts 1pt abstain via `?? 1`.

### "NHL SimScore tooltip shows Edge ±X% instead of Team GPG"
**Root cause**: Before commit removing the edge bonus from NHL SimScore, the 6th component was `Edge ±X%: N/3`. After converting to `nhlTeamGPG`, the tooltip still showed the old label if `index.html` was cached.

**Fix**: Hard-refresh (`Cmd+Shift+R`) — the tooltip is computed client-side in `index.html`. If production still shows old label, check if `nhlTeamGPG` is present in play output (`?debug=1` → any NHL play → `nhlTeamGPG` field). If null, the backend variable wasn't added to the plays push.

### "ALL routes return FUNCTION_INVOCATION_FAILED (500) after a backend deploy"
**Root cause**: `await` in a bare block at `async fetch()` function scope causes the Vercel Edge Runtime to fail to initialize the function — making every route, including simple ones like `/api/keepalive`, return 500.

**Pattern that breaks it:**
```js
async fetch(request, env, ctx) {
  ...
  const _map = {};
  {
    await Promise.all([..._set].map(async key => { ... }));  // bare block with await
  }
  const _helper = (...) => { ... };
  {
    for (const tm of items) { ... }  // team total processing
  }
}
```

**Fix**: Move the `await` and any helpers that depend on it INSIDE the existing `{...}` block that processes team totals — no new bare blocks at function scope:
```js
{
  const _map = {};
  await Promise.all([...]);   // inside the existing block
  const _helper = (...) => { ... };
  for (const tm of items) { ... }
}
```

**Diagnosis**: If `/api/keepalive` returns 500 and no code changes touch the keepalive handler, it's a function initialization failure. Check for bare-block `await` at function scope in recently changed sections. Revert the backend file and push to confirm — if keepalive recovers, the issue is in the reverted changes.

### "/api/tonight returns {error: 'X is not defined'}" after adding team schedule cache block
New code blocks that reference `CACHE2` and `isBustCache` must use those exact variable names. Two typos introduced in the H2H team schedule feature:
- `isBust` instead of `isBustCache` → `ReferenceError: isBust is not defined`
- `cache.get` / `cache.set` instead of `CACHE2?.get` / `CACHE2.put` → `ReferenceError: cache is not defined`

`CACHE2` is the Upstash-backed cache object built by `makeCache(env)` at line ~128. Cache reads use `.get(key, "json")` and writes use `.put(key, value, { expirationTtl: N })` — NOT `.set()`.

**Symptom**: `/api/keepalive` returns `{ok:true}` (function initializes fine) but `/api/tonight` returns `{error:"isBust is not defined"}` — the error is thrown at runtime inside the route handler, not at parse/init time.

### "MLB strikeout and HRR plays missing from plays card (NBA/NHL/totals still show)"
**Root cause**: Frontend `tonightPlays` filter had a stale gate condition from the old max-15 SimScore system:
```js
p.finalSimScore == null || p.finalSimScore > 10
```
After the April 2026 refactor to max-10 with gate ≥ 8, `finalSimScore > 10` is always false (max is 10). All MLB plays with `finalSimScore` set are silently excluded. NBA/NHL/total plays are unaffected because they use different score fields (`nbaSimScore`, `nhlSimScore`, `totalSimScore`) — `finalSimScore` and `hitterFinalSimScore` are null for them, so `null == null` passes.

**Fix**: Change to `p.finalSimScore >= 8` (and same for `hitterFinalSimScore`). Applied in 3 places in `index.html`: initial fetch `.then()`, bust fetch `.then()`, and `fetchReport` sync block (~lines 1320, 1331, 1526).
