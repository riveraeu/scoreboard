# src/ — frontend map

Loads when working under `src/`. Design system → `docs/STYLEGUIDE.md` (tokens: `src/lib/styles.js`); routing/state/live-tracking detail → `docs/FRONTEND.md`.

### Frontend: Vite + React (`src/`)

**Taker UI removed 2026-07-30 (Phase 1 of the taker-strategy teardown).** Deleted: `LineupsPage`, `MatchupCard`, `PlaysColumn`, `MyPicksColumn`, `DayBar`, `SimBadge`, and the hooks/libs `usePicks`, `usePickInteractions`, `useSavePicks`, `useAuthPickSync`, `useLiveStats`, `liveStats`, `orderbook`, `qualify` (`qualifiesForDisplay`/`trackIdFor`), `placeValidation`, `push`. The two inline order modals (Confirm-pick + Place All), the ⅛-Kelly sizing/phi memos, the tracked-pick drawer, and the ★ track buttons (player card + TotalsBarChart) all went with them. The maker board is now the ONLY non-player/team landing (the `/picks` route is gone). Backend taker gates/endpoints (category-gate, `/api/kalshi-order`, push-notify cron, config tunables) are removed in later phases. The player/team pages keep their analytical display (True%/Kalshi/edge); edge is colored via the display-only `EDGE_HIGHLIGHT` (`constants.js`), NOT a bet gate.

- `lib/useReportData.js` — shadow-report state + fetchers; MakerBoardPage's only consumer since `/model`/ReportPage was deprecated 2026-07-22
- `lib/scheduledCheckpoints.js` — `SCHEDULED_CHECKPOINTS` dated re-check list, used by MakerBoardPage's `DoThisBanner` (moved in 2026-07-22) and `MakerProgress` "next clock" tile
- `components/` — `MakerBoardPage` (**landing page**, 2026-07-21 — category × band heatmap + a `PreregTracker` block (2026-07-30) rendering the report's `preregistrations[]`; login/logout + read-only Kalshi-balance/committed-capital chip relocated into its header 2026-07-30 when the taker drawer was deleted), `TeamPage`, `TotalsBarChart`

**Dev proxy**: `vite.config.js` proxies `/api` to production so `npm run dev` works without a local backend.
