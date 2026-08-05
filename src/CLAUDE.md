# src/ — frontend map

Loads when working under `src/`. Routing/state detail → `docs/FRONTEND.md`. (The design-token file `src/lib/styles.js` was deleted 2026-08-04 — unimported; `MakerBoardPage` inlines its own styles.)

### Frontend: Vite + React (`src/`)

**Taker UI removed 2026-07-30; player/team stat browser removed 2026-08-04 (model teardown Phase 3).** The taker teardown deleted `LineupsPage`/`MatchupCard`/`PlaysColumn`/`MyPicksColumn`/`DayBar`/`SimBadge` + their pick/live hooks. The model teardown then deleted the **entire player/team browser**: `TeamPage`, `TotalsBarChart`, `InputList`, and the hooks/libs `usePlayerLoad`, `usePlayerCardState`, `usePlayerSearch`, `useRouting`, `useKalshiOdds`, `useTonight`, `lambdaInputs`, `statConfigs`, `gamelogParser`, `colors`, `hooks`, `utils` — all model-display UI (True%/edge/lambda/DvP/soft-matchup/gamelog). `constants.js` collapsed to just `WORKER`. **`MakerBoardPage` is now the ONLY view; `App.jsx` is just the auth modal + the board + a read-only Kalshi-balance fetch.**

- `lib/useReportData.js` — shadow-report state + fetchers; MakerBoardPage's only data source
- `lib/useAuth.js` / `lib/useAuthFlow.js` — login/logout for the board header chip
- `components/MakerBoardPage.jsx` — **the landing (and only) page** (self-contained: React only, inline styles): category × band **PnL** heatmap + a `PreregTracker` block rendering the report's `preregistrations[]`; login/logout + read-only Kalshi-balance/committed-capital chip in its header. **`VenueVigHeatmap` added 2026-08-04, merged to paired cells 2026-08-05** — a SECOND grid below the PnL one, reading the report's `venueVig`; cell = favorite-ask **VIG** (¢), a DIFFERENT quantity from the PnL grid above (reuses `_BANDS`/`_cellBg`). NO toggle: each populated cell stacks Kalshi vig (top) over Poly vig (bottom) and the cell **color is the Δ (K−P)** — so a lit cell is the divergence itself. Kalshi is live day one; Poly reads "—"/uncolored until rows resolve ~1 day after capture. A divergence monitor — the legend says "not a ranking, pre-register never bet"; thin cells (below the report's sample bar, `c.reliable` false) are greyed

**Dev proxy**: `vite.config.js` proxies `/api` to production so `npm run dev` works without a local backend.
