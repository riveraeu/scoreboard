# Scoreboard — Frontend Reference

Routing, state shape, the Report page, live tracking mechanics, sizing, color doctrine.

> **Adding new UI?** Read `docs/STYLEGUIDE.md` first (palette, typography, spacing, component patterns). Design tokens + shared style recipes: `src/lib/styles.js` — use in new code instead of hard-coded hex values.

---

## URL Routing
History.pushState + popstate. Routes:
- `/:ABBR` → team page (uppercase, e.g. `/LAD`, `/GSW`)
- `/:ABBR?sport=nhl` → disambiguate multi-sport abbrs (`_multiSportAbbrs` Set)
- `/:SlugName` → player page (CamelCase via `slugify`)
- `/model` → Report page (daily model report / MorningBriefing)

`vercel.json` `/:slug` rewrite serves `index.html` for cold loads. `resolveSlug` checks `"model"` first, then `TEAM_DB`, else stores `pendingSlug` for async ESPN athlete search.

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

## ReportPage (daily model report)
Single full-page route at `/model` (stripped to the model report 2026-06-16 — the Market Report, calibration Results, and Shadow Calibration tabs were all removed). Homepage entry point: the **Report** button (`LineupsPage.jsx`) → `useRouting.navigateToModel()` (no opts). Direct `/model` URL visits (paste, back/forward) resolve the same single view.

`ReportPage` is now a thin wrapper: header (`Report` / "Daily model report") + `MorningBriefing`. It auto-fetches `fetchShadowReport()` once on mount when logged in, and renders a "Log in to view the model report." fallback otherwise (the briefing payload is JWT-scoped). No sport pills, no play-type dropdown, no tab bar.

### MorningBriefing (rewritten 2026-06-17 — priority-ordered sections)
Renders the `/api/shadow-report` payload (cron 9:30am PT, KV-cached 25h; `↻ Refresh` forces `?bust=1` regen). The prose `buildBriefing` blob and the truePct category-scoreboard table are gone; structure is now, top to bottom:
1. **Data health** (`DataHealth`) — green/amber banner; renders first because it qualifies everything below.
2. **MODEL NEXT** (`ModelNext`) — static editorial build roadmap (a frontend constant `MODEL_NEXT`, NOT report data), default-open card right under Data health. Priority-ordered sports we plan to model next; **alt-line markets (totals/spreads/rounds — `ALT` green badge) rank above single-line ones (`1-LINE`: 1X2 result, outright, H2H)** because more thresholds + two-sided yes/no pricing = more chances at edge than a one-shot ML, and one per-team rate feeds totals/team-totals/spread/result off a shared joint sim. Each sport names its **"first knob"** (the single v1 input, per `docs/MODEL_IMPROVEMENT.md` minimum-viable-input doctrine). Current order: 1 Soccer, 2 Fighting (UFC rounds is the alt-line market), 3 Golf (thinnest on alt lines). Edit the constant to re-prioritize.
3. **OPS** (`OpsSection`) — leads with `OpsSummary`, a **four-line daily playbook** (one sentence per point, not one combined sentence): same-game cap (`optimalPerGameCap`, default 2), picks/day (`optimalDailyPicks.bucket` + confidence + `stopAt`), best time to bet (derived from CLV sign — +CLV categories ⇒ line drifts our way ⇒ bet early at lineup-confirm; −CLV ⇒ no rush; CLV's 3pm→7pm window is the only timing signal we have, no finer per-hour data), and new Kalshi markets — the `newMarkets` line + detail table now render the **actual Kalshi market title** (`m.title || m.sampleSubtitle || m.ticker`) with the raw ticker as dim secondary, not bare tickers. The four detail tables (picks/game, picks/day, CLV, new markets) collapse behind a "show detail tables" toggle, default closed.
4. **MODEL BOARD** — led by `GateDigest`, a one-line **GATE** digest of the board's per-category `doThis.action`: counts only the three *change* actions (`Add to gate`/`Pull from gate`/`Tune down`) and ignores steady-state ones, so the common day reads "No changes today — keep betting the N live categories." Below it, `ModelBoard` — the gate-decision surface, driven by `modelBoard`. Per-category **price-band validation ladder**: verdict (`PROMOTE`/`STRENGTHENING`/`HOLD`/`DEMOTE`/`NEGATIVE`/`BUILDING`), discovered window, ROI + 95% CI, n, and a `{n / CI / coh}` checklist (✓/✗). Rows sort by verdict priority; BUILDING rows collapse behind a "show" toggle; clicking a row expands its adaptive `priceBands` curve (in-window bins shaded). Below it, a **calibration check** strip (`topBands` truePct→actual Δ) labeled *honesty check, not profitability* — the separate axis, never the bet decision.

(Removed 2026-06-17: the **TODAY** plays-to-bet table — the live lineup/cards already drive what to bet — and the **DISCIPLINE** section — yesterday recap + `disciplineFlags` (flagged-band/over-cap/neg-CLV) — because those guardrails are now enforced in the order flow itself, making a backward-looking 30-day flag table redundant. Backend `buildYesterdayRecap`/`buildDisciplineFlags` and the `yesterdayRecap`/`disciplineFlags` payload fields were dropped too.)

Key doctrine baked in (see `docs/MODEL_IMPROVEMENT.md`): the board's profitability is on the **price axis** (ROI = hitRate − price); PROMOTE requires all three of n≥50, ROI-CI-lo>0, coherence (selection-bias-proof, since the window is ROI-maximized over candidates). truePct calibration is a separate model-honesty check. The current truePct `passesCategoryGate` is still fed by `npm run tune:gate`; acting on a discovered *price* window needs per-category price windows (Phase 2, parked behind the first PROMOTE). Self-contained component; `useReportData.js` exposes only `shadowReportData / shadowReportLoading / fetchShadowReport`.

---

## Live Pick Tracking
- `App.jsx` polls `/api/live` every 60s when any active pick has `gameDate ∈ {yesterday, today, tomorrow}` — including totals/team-totals. Yesterday's window catches games that ended after midnight UTC and didn't auto-resolve before the page closed; once they settle, polling auto-stops.
- `fetchLiveStats` groups game keys by `gameDate` and fans out one `/api/live` call per distinct date (today omits the date param, others pass `&date=YYYY-MM-DD`). `/api/live` accepts `date=YYYY-MM-DD` or `YYYYMMDD`; cache key segregates by date so each date's slate is cached independently.
- **Client liveStats key is date-scoped**: server response is keyed by raw matchup (`mlb:NYY:BAL`); `fetchLiveStats` re-keys each per-date response to `${rawKey}|${gameDate}` before merging into `liveStats`. Without this, the same matchup recurring on consecutive days collides during `Object.assign(...responses)` and last-write-wins — caused a 5/4 Bellinger HRR pick to settle "won" against 5/3's final box (commit fixing this on 2026-05-04). `buildLiveGameKey(pick)` in `liveStats.js` produces the date-scoped form; `buildLiveGameKeyRaw(pick)` is the server-facing form.
- `/api/live` returns `{ state, detail, players, homeTeam, awayTeam, homeScore, awayScore }` per game key. Player props read `players` for current stat; totals read `homeScore`/`awayScore` directly.
- Player props: auto-resolve on threshold met (`won`), state==="post" + stat<threshold (`lost`), or player absent from boxscore after game end (`DNP`).
- Totals/team totals auto-resolve in a separate effect on `[mlbMeta, nbaMeta, nhlMeta]` change (not from /api/live polling). Display falls back to `mlbMeta.gameScores` when /api/live hasn't populated yet — `resolveTotalGameScore(pick, liveStats, gameScores)` in `liveStats.js` encapsulates the prefer-live-fall-back-to-meta lookup.
- `fetchLiveStats` requires `pick.opponent` to build the `sport:team1:team2` game key. Picks tracked from the **player card** include `opponent: tonightPlay?.opponent` (App.jsx track button); the play card's `trackPlay` already spreads it from the API. For older picks lacking `opponent`, `fetchLiveStats` resolves it from `currentMeta.{sport}Meta.gameScores` by `playerTeam` and backfills it on the pick (one-time mutation persisted via `setTrackedPlays`). `AddPickModal` does NOT collect opponent for **player props** — manual player picks stay unresolved unless the user enters the result by hand. Manual **game-total** and **team-total** picks include the full team pair (`homeTeam`/`awayTeam` or `scoringTeam`/`oppTeam`) so they resolve via the standard total-resolver path.
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

`AddPickModal` (manual ad-hoc entry) keeps its own odds-based ladder (`<= -900 ? 5 : <= -400 ? 4 : <= -200 ? 3 : <= -110 ? 2 : 1`) — manual entries don't typically have an `edge` field to band against.

**AddPickModal supports three pick types** via a top-level toggle: Player Prop, Game Total, Team Total. Game-total form collects `homeTeam`/`awayTeam` (canonical abbrs) and submits `gameType: "total"`. Team-total form collects `scoringTeam`/`oppTeam` and submits `gameType: "teamTotal"`. **Line semantics**: for player props the input IS the threshold (20.5 stored as 20.5); for totals the input is the half-integer line shown on the sportsbook (7.5) and `threshold = Math.round(line + 0.5)` (matches API convention so `buildLiveProgress` renders `(threshold - 0.5).toFixed(1)`). Game-total sport options: NBA/WNBA/MLB/NHL/NFL. Team-total sport options: NBA/MLB only (no Kalshi team-total series for the others). Stat is derived from sport per `TOTAL_STAT`/`TEAM_TOTAL_STAT` maps.

**Note (2026-06-14):** AddPickModal is still rendered in `App.jsx` (`showAddPick`) but no longer has a trigger — the **+ Add** button was removed from the tracking drawer (`MyPicksColumn`). Manual ad-hoc entry is effectively retired from the UI; the modal/code stays in place in case the entry point is reinstated.

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
