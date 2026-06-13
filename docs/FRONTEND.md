# Scoreboard — Frontend Reference

Routing, state shape, Market Report, live tracking mechanics, sizing, color doctrine.

> **Adding new UI?** Read `docs/STYLEGUIDE.md` first (palette, typography, spacing, component patterns). Design tokens + shared style recipes: `src/lib/styles.js` — use in new code instead of hard-coded hex values.

---

## URL Routing
History.pushState + popstate. Routes:
- `/:ABBR` → team page (uppercase, e.g. `/LAD`, `/GSW`)
- `/:ABBR?sport=nhl` → disambiguate multi-sport abbrs (`_multiSportAbbrs` Set)
- `/:SlugName` → player page (CamelCase via `slugify`)
- `/model` → Research page (Market Report + calibration Results tabs)

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
- `reportData` — full debug response for ReportPage
- `player`, `teamPage`, `teamPageData`, `pendingSlug`, `trackedPlays`

---

## ReportPage (Market Report + Results)
Single full-page route at `/model` (merged 2026-05-29; Model Reference prose dropped 2026-05-29 — see below). Homepage entry point: the **Research** button — lands on the Market Report tab with MLB pre-seeded. Direct `/model` URL visits (paste, back/forward) default to the Results tab. Entry passes through `useRouting.navigateToModel(opts)` which writes `modelEntryOpts = {tab, sport}` so `ReportPage` can seed its initial selection.

**Selectors** (top of the page): a 4-button sport pill row (MLB / NBA / WNBA / NHL) and a play-type dropdown filtered by sport. The play-type catalog lives in `PLAY_TYPES` in `ReportPage.jsx` — each entry has `{ id, label, statKeys }`. `id` is the calibration category key (e.g. `mlb-k`, `nba-1htotal`); `statKeys` is the array of `m.stat` values that belong to this play type. NBA "Props" rolls four stats (`points/rebounds/assists/threePointers`) into a single entry to mirror calibration's merged bucket.

**Tab bar** (under the selectors): two tabs — Market Report and Results. The selected (sport, play type) drives both.

### Market Report tab
Filters the `/tonight?debug=1&sport=X` payload down to plays whose `m.sport === sport && playType.statKeys.includes(m.stat)`. Totals/teamTotals further split into Over and Under sub-groups within the same play type. `MarketGroupSection` renders one group: header + sortable table. Columns vary by sport/stat via the `xcols` array; `COL_TIPS` dictionary supplies hover tooltips. The `xcell` switch in `MarketGroupSection` is authoritative for column color tiers — match SimScore tiers (yellow = middle tier, gray = abstain or lowest, red = 0pts).

`fetchReport(sport)` (in `useReportData.js`) memoizes the debug response per-sport in `reportDataBySport`, so switching play types within a sport never refetches.

**SimScore tooltip** (hover any `X/10` badge): `buildSimTooltip(m)` is the canonical helper for all play types. Per-component breakdown with actual values.

**Sort defaults**: team totals = Score desc. HRR table: threshold=1 only (others filtered client-side).

**Score>7 highlight**: MLB rows show white+bold name only when `finalSimScore ?? hitterFinalSimScore > 7` (Alpha tier). Other rows use `m.qualified`.

### Results tab
Renders the qualification-summary box (Kalshi gate · edge gate · DC gate · edge calc) followed by `CalibModule` — the per-bucket truePct calibration table for the selected play type. `TAB_CAT` maps each tab id to the calibration category keys it covers; multi-key entries (e.g. `nba`) merge buckets via `mergeBuckets`. The MLB-K tab additionally shows per-feature breakdown tables (by SimScore, by K% tier, by K-Trend, by stdBF).

**Why no prose Model Reference**: prior versions hand-wrote True%/SimScore explanations for ~9 of the 32 play types and they kept drifting out of sync with the rapidly-evolving model (`MODEL_CONTENT` const, dropped 2026-05-29). Authoritative model spec lives in `docs/MODEL.md` and `CLAUDE.md`. The in-app tab is now reserved for calibration-driven outcomes, which stay fresh automatically.

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

---

## Color tiers (utility)
```
tierColor(pct): ≥70 → #3fb950 green, ≥60 → #e3b341 yellow, <60 → #f78166 red.
Single source of truth in src/lib/colors.js. Drives True% bars in App player card, PlaysColumn (truePct + season + soft bars), TotalsBarChart, TeamPage. NOT applied to ReportPage Market-tab SimScore-component cells (Ssn HR%, H2H HR%, Hit Rate %, K H2H Hand, etc.) — those map to the points actually awarded (2/1/0 → green/yellow/red), and per-component % thresholds vary by stat (e.g. NBA Ssn HR ≥90→2 vs MLB HRR Ssn HR ≥80→2), so a universal ladder would visually misrepresent SimScore.
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

## Shadow Calibration Tab

Shadow tab in ReportPage renders `ShadowCalibModule` — category summary (N deduped/N raw / Hit% / ROI / Status) with click-to-expand band detail (55–60 through 95+). Since filter (30d/60d/All) re-fetches `/api/auth/shadow-calibration?bestThreshold=true` (always deduped: one prediction per player/matchup per group). Sport pills filter categories.

`ACTIVE_CATS` Set inside `ShadowCalibModule` mirrors `passesCategoryGate()` in `src/lib/constants.js` — **keep in sync when promoting a category**. Status labels: Active (in gate) / Building (n≥50 ROI>0) / Losing (n≥30 ROI≤0) / Too few.

**Correlation analysis** (expandable, lazy-load): same-game pairwise φ table + alt-line unanimity table from `/api/auth/shadow-analysis`; auto-fetches when shadow tab opens.

---

## Spread alt-line dedup + category gate display logic (2026-06-05)

`passesGate` (LineupsPage.jsx) and `_qualifiedFilter` (App.jsx) apply: `_altLineDemoted && !passesCategoryGate(p) → false`. Demoted plays that **pass** the category gate are shown. Opposite-side truePcts are complementary (~sum to 100%), so both sides of the same line can never show simultaneously (one side ≥80% forces the other ≤20%). Market Report symptom: bold play visible but absent from LineupsPage card → the dedup winner fails the category gate, allowing the demoted loser through.

---

## `/api/live` doubleheader disambiguation

Wire format: `sport:t1:t2@gameTimeISO`. Client appends `@${pick.gameTime}` when present. Server filters scoreboard events by `ev.date.slice(0,16) === gameTime.slice(0,16)`. No fallback when gameTime is supplied but doesn't match — would reintroduce the game-1/game-2 settlement bug.

---

## MLB pitchers per-game (`mlbMeta.pitchersByGame`)

Keyed `${team}|${gameKey}` (ESPN-style ISO, no seconds). `MatchupCard.featureFor` reads this first, falls back to per-team `pitchers[abbr]` map. Without the per-game map, both DH cards show the same pitcher.
