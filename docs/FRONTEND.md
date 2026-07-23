# Scoreboard — Frontend Reference

Routing, state shape, the Report page, live tracking mechanics, sizing, color doctrine.

> **Adding new UI?** Read `docs/STYLEGUIDE.md` first (palette, typography, spacing, component patterns). Design tokens + shared style recipes: `src/lib/styles.js` — use in new code instead of hard-coded hex values.

---

## URL Routing
History.pushState + popstate. Routes:
- `/` (default) → **MakerBoardPage** — shadow maker monitoring (arm progress, live orders, sport utilization). Promoted to the landing page 2026-07-21.
- `/picks` → LineupsPage — the taker-picks matchup-card flow (demoted from default 2026-07-21; see below)
- `/:ABBR` → team page (uppercase, e.g. `/LAD`, `/GSW`)
- `/:ABBR?sport=nhl` → disambiguate multi-sport abbrs (`_multiSportAbbrs` Set)
- `/:SlugName` → player page (CamelCase via `slugify`)

`/model` (ReportPage, the daily model report) was **deprecated and removed 2026-07-22** — `DoThisBanner` (the only piece still in daily use) moved into `MakerBoardPage`; `StatusStrip`/`DataHealth`/the rest of the page were not migrated. See `project_do_this_banner` memory.

`vercel.json` `/:slug` rewrite serves `index.html` for cold loads. `resolveSlug` (`useRouting.js`) checks `"picks"`, then `TEAM_DB`, else stores `pendingSlug` for async ESPN athlete search.

**Landing page flip (2026-07-21)**: the category gate has been empty since 7/18 and the pooled market-calibration scan (7/19) found taker edge structurally negative venue-wide, while shadow maker V2 has a concrete verified result (`[80,84]¢`, +11.17¢/contract) with real capital armed — see `project_taker_ui_demotion_2026_07_21` memory. `MakerBoardPage` (new, eager import — it's now the default) replaces `LineupsPage` (now `React.lazy`, moved behind `/picks` via `navigateToPicks()`) as what renders when `!player && !teamPage && !picksPage`. `goBack()` (resets to `/`) now lands on the maker board, not LineupsPage — LineupsPage's own "← Maker" button calls it to return. A scheduled reminder exists to revisit removing the taker UI once the V2 trial resolves (n≥50 graded, CI-lo>0 — see `MAKER_V2_TRIAL_N` in `MakerBoardPage.jsx`'s `_doThisCandidates`).

`navigateToPlayer` accepts player objects without `id`; `loadPlayer` resolves ESPN athlete ID via `/athletes?q={name}` when missing.

---

## State (App.jsx)
- `tonightPlays` — qualified plays (filtered `qualified !== false`)
- `allTonightPlays` — raw including `qualified:false`. Used to build `tonightPlayerMap` so all market-report players have explanation data.
- `mlbMeta` — `{ pitchers, gameOdds, umpires, weather }` — pitchers merged from ESPN probables + MLB API. `gameOdds` includes total+spread (from ESPN MLB scoreboard, today OR tomorrow if today complete; no date gate in MatchupCard). `projectedLineupTeams`/`teamsWithLineup` removed 2026-06-10 with the matchup-card lineup badge.
- `mlbMetaTomorrow` — same shape from tomorrow's MLB API schedule. Pitchers only (era null); gameOdds/weather always empty.
- `nbaMeta` — `{ gameOdds, gameScores, topPlayers }`. `gameScores` from `parseGameScores`, includes `seriesSummary` in playoffs. `injuries` removed 2026-06-10 with the matchup-card injury badge (injury maps stay server-side for lambda/dc use).
- `nhlMeta` — `{ gameScores, gameOdds }`. Same shape.
- `player`, `teamPage`, `teamPageData`, `pendingSlug`, `trackedPlays`

---

## MakerBoardPage (the landing page, `src/components/MakerBoardPage.jsx`)
New 2026-07-21, the app's default view. Top to bottom:
- **DoThisBanner** (+ its full `_doThisCandidates` dependency chain, `MODEL_NEXT` roadmap data, etc.) — ported verbatim into this file 2026-07-22 when `/model`/`ReportPage.jsx` was deprecated and deleted (see `project_do_this_banner` memory). The fall-through priority ladder, tiers 1 → 5: (1) actionable data health, (1.6) maker adverse-selection red flag, (1.8) shadow maker V2 lifecycle (renumbered from 2.05 on 2026-07-22 to rank above the taker-side tiers below, since real capital is now on the line and maker is the primary strategy), (2) taker betting-board changes, (2.2) accuracy changes, (2.5) validate ripe shadow models, (3/3.2) build-next roadmap (currently inert — every `MODEL_NEXT` entry is shipped or infra-blocked, self-advances when a new one is added), (3.15) derive a per-category bet window, (3.25) vet shortlisted markets, (3.5) triage detected markets, (3.6) sportsbook regime-change tripwire, (4) `SCHEDULED_CHECKPOINTS` dated follow-ups, (5) quiet-day floor. Reads the full `shadowReportData` payload (`accuracyBoard`/`bettingBoard`/`makerBoard`/`newMarkets`/`shortlistedMarkets`/`sportsbookValidation`/`dataHealth`) — those boards are no longer displayed anywhere, but the server still produces them and the banner still reads them.
- **MakerProgress** (+ `ArmTile`/`EquityCurve`/`BandLadder`/`Tile` helpers) — Shadow V1's arm-progress meter, cumulative paper-PnL curve, and per-band ladder. Same `shadowReportData.makerBoard` field, same `fetchShadowReport`/`isLoggedIn` plumbing.
- **MakerLiveOrders** — a monitoring table (not a picks list) of individual `maker_orders_v2` rows: sport, ticker/category, side, price, size, status badge, PnL once graded. Resting-first sort. Status colors: resting=blue, executed graded=signed by `sideWon` (green=we kept the premium, red=we paid out), canceled/expired=dim.
- **MakerUtilization** — per-sport eligible-vs-resting bars (reuses `BandLadder`'s visual pattern), flags when eligible tickers exceed the `MAKER_V2_MAX_CONCURRENT` cap (a real situation: 73 eligible vs. 20 slots on a typical MLB+WNBA night).

Backed by `GET /api/maker-v2-board` (`useMakerBoardData` hook in the same file) — a separate, near-real-time fetch, NOT the 25h-cached `shadow-report`. `eligibleBySport` is computed live via `computeWantedMakerQuotes` (`api/lib/maker-live.js`), the same eligibility function the real order-placement cron uses — one source of truth for "what's eligible," not a second hand-rolled band check.

This page is the app's only eager import (no more `React.lazy` ReportPage to defer against, since it's gone) — `MODEL_NEXT` + `_doThisCandidates` are part of the eager bundle now. `C`/`sectionHead`/`SCHEDULED_CHECKPOINTS` live here (the latter still shared via `src/lib/scheduledCheckpoints.js` in case a future page needs the same checkpoint list).

Legacy display note (historical, from when this content lived on `/model`): the fused accuracy/betting board table, `AccuracyBoard`, `BettingBoard`, `ModelNext` (as a rendered table), `GateDigest`, `CrossVenueValidation`, `PriceBands`, `CalibBandsTable` were removed from display 2026-07-19 (strategy pivot — no taker edge exists venue-wide) and the whole `/model` page they lived on was deleted 2026-07-22. The SERVER payload is untouched: `accuracyBoard`/`bettingBoard`/`brief` still generate (the banner tiers and tune CLIs read them). Category-level model drill-downs live in the CLIs (`tune:gate`, `tune:residual`, `?brier=1`).

Key doctrine baked in (see `docs/MODEL_IMPROVEMENT.md`): the (server-side, no-longer-displayed) board's profitability is on the **price axis** (ROI = hitRate − price); PROMOTE requires all three of n≥50, ROI-CI-lo>0, coherence. truePct calibration is a separate model-honesty check, still fed by `npm run tune:gate`. `useReportData.js` exposes only `shadowReportData / shadowReportLoading / fetchShadowReport` — `MakerBoardPage` is its only consumer now.

---

## Live Pick Tracking
- `App.jsx` polls `/api/live` every 60s when any active pick has `gameDate ∈ {yesterday, today, tomorrow}` — including totals/team-totals. Yesterday's window catches games that ended after midnight UTC and didn't auto-resolve before the page closed; once they settle, polling auto-stops.
- `fetchLiveStats` groups game keys by `gameDate` and fans out one `/api/live` call per distinct date (today omits the date param, others pass `&date=YYYY-MM-DD`). `/api/live` accepts `date=YYYY-MM-DD` or `YYYYMMDD`; cache key segregates by date so each date's slate is cached independently.
- **Client liveStats key is date-scoped**: server response is keyed by raw matchup (`mlb:NYY:BAL`); `fetchLiveStats` re-keys each per-date response to `${rawKey}|${gameDate}` before merging into `liveStats`. Without this, the same matchup recurring on consecutive days collides during `Object.assign(...responses)` and last-write-wins — caused a 5/4 Bellinger HRR pick to settle "won" against 5/3's final box (commit fixing this on 2026-05-04). `buildLiveGameKey(pick)` in `liveStats.js` produces the date-scoped form; `buildLiveGameKeyRaw(pick)` is the server-facing form.
- `/api/live` returns `{ state, detail, players, homeTeam, awayTeam, homeScore, awayScore }` per game key. Player props read `players` for current stat; totals read `homeScore`/`awayScore` directly.
- Player props: auto-resolve is **side-aware** (`pick.direction === "under"` flips it — counting stats are monotonic, so a mid-game threshold cross locks over `won` / under `lost`; surviving to state==="post" below threshold is over `lost` / under `won`; the pulled-pitcher K early-resolve flips the same way). Player absent from boxscore after game end → `DNP` for both directions. The over-only version of this logic mis-graded the first live NO-side HRR pick as `won` on 2026-07-17.
- Totals/team totals auto-resolve in a separate effect on `[mlbMeta, nbaMeta, nhlMeta]` change (not from /api/live polling). Display falls back to `mlbMeta.gameScores` when /api/live hasn't populated yet — `resolveTotalGameScore(pick, liveStats, gameScores)` in `liveStats.js` encapsulates the prefer-live-fall-back-to-meta lookup.
- `fetchLiveStats` requires `pick.opponent` to build the `sport:team1:team2` game key. Picks tracked from the **player card** include `opponent: tonightPlay?.opponent` (App.jsx track button); the play card's `trackPlay` already spreads it from the API. For older picks lacking `opponent`, `fetchLiveStats` resolves it from `currentMeta.{sport}Meta.gameScores` by `playerTeam` and backfills it on the pick (one-time mutation persisted via `setTrackedPlays`). The now-removed `AddPickModal` (see "Stake / pick units" below) never collected opponent for **player props** — any surviving manual player picks tracked through it before removal stay unresolved unless the user enters the result by hand. Manual **game-total** and **team-total** picks include the full team pair (`homeTeam`/`awayTeam` or `scoringTeam`/`oppTeam`) so they resolve via the standard total-resolver path.
- Polling effect must read meta from `liveMetaRef.current` (not closure). The polling `useEffect` deps are `[unresolvedCount, fetchLiveStats]` so it does NOT re-run when meta loads asynchronously — without the ref, the 60s `setInterval` callback would forever close over the empty initial meta and the backfill path would never fire. A separate effect on `[mlbMeta, nbaMeta, nhlMeta]` updates the ref and triggers an immediate poll the first time `gameScores` becomes available.
- Player-name lookup must be diacritic-tolerant via `findLivePlayer(players, name)` in `liveStats.js`. ESPN's scoreboard returns ASCII names (`"Nikola Jokic"`) while the player profile/search returns the original (`"Nikola Jokić"`). Picks tracked from the player card store the diacritic form, so a direct `players[pick.playerName]` lookup misses. The helper does an exact-key check first (cheap), then falls back to NFD-normalized scan. Used in both `buildLiveProgress` and the auto-resolve path in `App.jsx fetchLiveStats`.
- **Pick-card progress bar** (`buildLiveProgress(pick, liveGame, totalGameScore)` in `liveStats.js`): replaces the old text "Top 2nd · 2/4" panel. Fill = `current/threshold`; color is **pace-based**, not just progress: `pace = (current/threshold) / elapsed`. OVER ≥1 → green, ≥0.66 → yellow, else red. UNDER inverted: <0.85 → green, <1.1 → yellow, else red. `gameElapsedFrac(sport, state, detail)` parses ESPN status strings — MLB `Top|Bot|Mid|End N` over 9 innings, NBA `Q[1-4] MM:SS` over 4×12min (OT→0.97), NHL `[1-3](st|nd|rd) MM:SS` over 3×20min (OT/SO→0.97). Pre-game bar is empty/gray and shows formatted `gameTime`; post collapses to met/not-met green/red.

---

## Game time
- Play card subtitle: `"Today · 7:40 PM PT"` / `"Tomorrow · 1:10 PM PT"` from `play.gameTime`.
- **Duplicate matchup cards (gameTime-null cause, 2026-06-13)**: `buildGames` (LineupsPage.jsx) keys cards on `sortedPair|gameDate|gameTime`. When the backend `gameTimes` map transiently returns empty (ESPN scoreboard hiccup — affects `?bust=1` too, so it's not a cache miss), every play emits with `gameTime:null` and seeds a timeless card that can't merge with the gameScores-seeded card (which has the real time) → every game with a play renders twice. Visible symptom is usually just the *earliest* game duplicating: empty gameTime sorts first, so the timed duplicate of the earliest start lands above the fold while the rest scroll off-screen. Defended client-side: `buildGames` backfills a null play `gameTime` from the matching gameScores `pair|date` entry (skips doubleheaders). This is distinct from the parseGameTeams duplicate-card cause (bad team-split). If dups recur, check whether plays in `/api/tonight` carry `gameTime` — if null, the backend `gameTimes` ESPN fetch is the real culprit.
- No lineup badges anywhere anymore: play-card `✓ Lineup`/`Proj. Lineup` removed 2026-05-16; matchup-card lineup + injury badges removed 2026-06-10. `play.lineupConfirmed` still exists (stamped in props.js) and surfaces only as the `(proj)` suffix on Lineup K% in lambda tooltips and TeamPage's projected-lineup note.

---

## Stake / pick units
**Edge-tiered sizing** (`unitsForPlay(play)` in App.jsx, "Scheme B"):
- edge < 7%   → 1u
- edge 7–12%  → 3u
- edge ≥ 12%  → 5u
- missing edge → 1u baseline

`UNIT_DOLLARS = 30` (one-line tunable in App.jsx); stake in dollars = `unitsForPlay(play)`. Stored on tracked picks as `units` (in dollars). User can override odds at track time via the pending-track confirm dialog (`pendingOdds`); the sportsbook odds change but the stake stays edge-tiered. Picks editor has `$` input for manual override.

**Existing picks pre-2026-05-02 use the older `|americanOdds|/10` ladder** — not retroactively migrated. The `units` field is whatever was stored at track time.

**`AddPickModal` (manual ad-hoc entry) removed 2026-07-23** — its `+ Add` trigger button was already removed from the tracking drawer on 2026-06-14 with the modal/code deliberately left in place "in case the entry point is reinstated"; a taker-side dead-code audit confirmed no code path could ever open it (no `setShowAddPick(true)` call existed anywhere) and it was fully deleted. Its own odds-based stake ladder and three-pick-type form (Player Prop/Game Total/Team Total) no longer exist. Any picks tracked through it before removal remain in a user's saved list unaffected — this only removed the (already-unreachable) entry point, not historical data.

## Tracking drawer (`MyPicksColumn`) header
- Top of the drawer is a **Month / Year** view toggle (local `viewMode` state, Month default) — it replaced the old all-time `N active · N finished · W–L · P&L · ROI` summary line (lifetime totals no longer shown). Bankroll/Kalshi-balance block stays on the right.
- Stats cards (Record / Net P&L / ROI / Avg odds) and the calendar bar chart both scope to a shared `periodPrefix`: `YYYY` in year view, `YYYY-MM` in month view — switching tabs re-derives both together.
- Chart granularity follows the tab: **month** = one bar per day of the selected month (empty days = zero bar, consistent x-scale); **year** = 12 bars Jan–Dec, each month's tooltip summarized as `{W}W–{L}L` + net (labeled e.g. "June 2026") rather than listing every pick. Both reuse `DayBar` unchanged.
- Dropdowns: the **Month** `<select>` is hidden on the Year tab; the **Year** `<select>` drives the year chart/stats. Both write back to `chartMonth` (`YYYY-MM`).

---

## Color tiers (utility)
```
tierColor(pct): ≥70 → #3fb950 green, ≥60 → #e3b341 yellow, <60 → #f78166 red.
Single source of truth in src/lib/colors.js. Drives True% bars in App player card, PlaysColumn (truePct + season + soft bars), TotalsBarChart, TeamPage. (Historically also excluded the ReportPage Market-tab SimScore-component cells, which mapped to the points actually awarded (2/1/0 → green/yellow/red) rather than a universal ladder — that tab was removed 2026-06-16.)
```

---

## Explanation text — color parity with SimScore
Play-card and player-card narrative text colors **must map to the play type's 5 SimScore components** (one color per metric matching the 2/1/0 point tiers). Decorative non-SimScore stats render in gray (`#8b949e` or `#c9d1d9` for opponent/labels). Established tier-per-component:

| Play type | C1 opportunity | C2 | C3 | C4 | C5 |
|---|---|---|---|---|---|
| **MLB K** | CSW%/K% (≥30/>26 CSW; ≥27/≥24 K%) | Lineup K% (>24/>22) | Hit Rate % (≥90/≥80, blended) | H2H Hand (≥80/≥65) | O/U (≤7.5/<10.5) |
| **MLB HRR** | OPS (≥.850/≥.720) | Pitcher WHIP (>1.35/>1.20) | Season HR (≥80/≥70) | H2H HR (≥80/≥70, BvP or hand) | O/U (≥9.5/≥7.5) |
| **NBA** | USG% for pts/3PT/AST (≥28/≥22) or AvgMin for REB (≥30/≥25) | DVP rank/ratio (≤10/≤15) | Season HR (≥90/≥80) | Soft/Tier HR (≥90/≥80) | Game Total (`nbaTotalPts`) |
| **WNBA** | USG% (≥27/≥22) or AvgMin REB (≥27/≥22) | DVP ratio (≥1.05/≥1.02) | Season HR (≥90/≥80) | Soft/Tier HR (≥90/≥80) | Game Total (`wnbaTotalPts`) |
| **NHL** | TOI (≥18/≥15) | GAA rank (≤10/≤15) | Season HR (≥90/≥80) | DVP HR (≥90/≥80) | O/U (≥7/≥5.5) |
| **Team total MLB** | Season HR | Opp WHIP | L10 RPG | H2H HR | O/U |
| **Game total MLB** | Home/Away WHIP | Combined road RPG | H2H HR | O/U | — |
| **Game total NBA** | Combined pace | OffRtg/DefRtg | Season HR | H2H HR | O/U |

**Always gray** (non-SimScore decoration): batting spot, pitcher avgPitches/start, NHL shots-against adjustment, NBA/WNBA pace adjustment (applied to sim but not scored), game-total / team-total model-projected expected runs/pts (truePct already conveys the result; the projection is internal). Penalty chips (back-to-back red, blowout-risk red) stay red as warnings, not measurements.

If you add a new metric to the explanation text, ask: is this stat directly assigned points by the SimScore engine for this play type? If no, render it gray. If yes, color it with the tier that matches the points awarded (2pt = green, 1pt = yellow, 0pt = red).

---

## Shadow calibration (UI removed 2026-06-16)

The in-app Shadow Calibration tab (`ShadowCalibModule`) and the correlation-analysis panel were removed with the ReportPage strip-down. The underlying endpoints still exist (`/api/auth/shadow-calibration?bestThreshold=true`, `/api/auth/shadow-analysis`) and the data is now consumed via CLI: `npm run tune:gate` for the gate recommender, and the model report's category scoreboard for the at-a-glance view. `ACTIVE_CATS` is gone from the frontend; `passesCategoryGate()` in `api/lib/category-gate.js` (re-exported by `src/lib/constants.js`) is the single source of truth for active categories.

---

## Place All same-game grouping + cap (2026-06-16)

`placeAllGrouped` (App.jsx) buckets candidates by `gameKey` = `sport|sorted(teams)|gameDate`. **`gameKey` falls back to `playerTeam`/`opponent` for props** (their `homeTeam`/`awayTeam` are null) so same-game props group with each other *and* with the same-game spread/total under one header. Each candidate carries `_gameRank` (1 = highest edge in its game) + `_gameN`.

- **Cap (`SAME_GAME_CAP = 2`)**: the first-open default selection (`safeIds`) excludes any pick with `_gameRank > 2` — the 3rd+ highest-edge pick of a game stays visible + selectable but **unchecked**. From shadow `capRoi` (Kalshi 67–91 window, n=144): within a multi-pick game the 1st/2nd picks run +5.5%/+3.1% ROI, the 3rd −11%. Rows render an amber "⚠ same-game pick #k of N" note.
- **Sizing**: groups with a **measured** φ (`_SAME_GAME_PHI`, MLB only) shrink toward one Kelly slot as before. Groups at **φ=0** (e.g. all WNBA same-game) are **not** rescaled — full ⅛-Kelly on the kept picks; concentration is handled by the cap + visual flag, not by trimming stake. Header shows `φ≈X` when measured, else `⚠ same game`.

To raise/lower the cap, edit `SAME_GAME_CAP`. Graduate WNBA from cap→φ-sizing only once `_SAME_GAME_PHI` gets WNBA pairs (shadow n≥200).

---

## Spread alt-line dedup + category gate display logic (2026-06-05)

`passesGate` (LineupsPage.jsx) and `_qualifiedFilter` (App.jsx) apply: `_altLineDemoted && !passesCategoryGate(p) → false`. Demoted plays that **pass** the category gate are shown. Opposite-side truePcts are complementary (~sum to 100%), so both sides of the same line can never show simultaneously (one side ≥80% forces the other ≤20%). Symptom: a demoted loser surfaces on the LineupsPage card → the dedup winner fails the category gate, allowing the demoted loser through.

---

## `/api/live` doubleheader disambiguation

Wire format: `sport:t1:t2@gameTimeISO`. Client appends `@${pick.gameTime}` when present. Server filters scoreboard events by `ev.date.slice(0,16) === gameTime.slice(0,16)`. No fallback when gameTime is supplied but doesn't match — would reintroduce the game-1/game-2 settlement bug.

---

## MLB pitchers per-game (`mlbMeta.pitchersByGame`)

Keyed `${team}|${gameKey}` (ESPN-style ISO, no seconds). `MatchupCard.featureFor` reads this first, falls back to per-team `pitchers[abbr]` map. Without the per-game map, both DH cards show the same pitcher.
