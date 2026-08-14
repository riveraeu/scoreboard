# src/ — frontend map

Loads when working under `src/`. Routing/state detail → `docs/FRONTEND.md`. (The design-token file `src/lib/styles.js` was deleted 2026-08-04 — unimported; `MakerBoardPage` inlines its own styles.)

### Frontend: Vite + React (`src/`)

**Taker UI removed 2026-07-30; player/team stat browser removed 2026-08-04 (model teardown Phase 3).** The taker teardown deleted `LineupsPage`/`MatchupCard`/`PlaysColumn`/`MyPicksColumn`/`DayBar`/`SimBadge` + their pick/live hooks. The model teardown then deleted the **entire player/team browser**: `TeamPage`, `TotalsBarChart`, `InputList`, and the hooks/libs `usePlayerLoad`, `usePlayerCardState`, `usePlayerSearch`, `useRouting`, `useKalshiOdds`, `useTonight`, `lambdaInputs`, `statConfigs`, `gamelogParser`, `colors`, `hooks`, `utils` — all model-display UI (True%/edge/lambda/DvP/soft-matchup/gamelog). `constants.js` collapsed to just `WORKER`. **`MakerBoardPage` is now the ONLY view; `App.jsx` is just the auth modal + the board + a read-only Kalshi-balance fetch.**

- `lib/useReportData.js` — shadow-report state + fetchers; MakerBoardPage's only data source
- `lib/useAuth.js` / `lib/useAuthFlow.js` — login/logout for the board header chip
- `components/MakerBoardPage.jsx` — **the landing (and only) page** (self-contained: React only, inline styles). **Rewritten 2026-08-14 as a terse monospace text digest** (superseding the 2026-08-13 full-mirror rewrite, which rendered every report field as its own grid/table and was too long — user feedback: make it read like the CLI daily-report output). Same priority order the report workflow uses (robust candidates → preregistrations → discovery → cross-venue → category economics → report meta), each section now a handful of summary lines instead of a row dump. Full section list + doctrine → `docs/FRONTEND.md`. Deliberately omits the V1/V2 fill-PnL instruments (`makerBoard.fills`/`live`/`adverseSelection`/`crossChecks`) per `feedback_morning_report_omit_maker_instruments`. **Both category×band heatmap grids (PnL and cross-venue vig) are gone from the UI** — replaced by `CategoryEconomics` (aggregate counts + named anomalies only, never a per-cell ranking — `feedback_no_insample_target_picker_ui`) and folded into `CrossVenue` (reads `polymarketTracking`, whose own `vig` summary already derives from `venueVig` server-side) respectively. The raw grid data still ships in `/api/shadow-report`, just isn't rendered visually anymore.

**Dev proxy**: `vite.config.js` proxies `/api` to production so `npm run dev` works without a local backend.
