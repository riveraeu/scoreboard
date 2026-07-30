# src/ — frontend map

Loads when working under `src/`. Design system → `docs/STYLEGUIDE.md` (tokens: `src/lib/styles.js`); routing/state/live-tracking detail → `docs/FRONTEND.md`.

### Frontend: Vite + React (`src/`)

- `lib/qualify.js` — `qualifiesForDisplay(p)` (shared qualification core: dc + edge + category gate + demotion exception) and `trackIdFor(p)`. App `_qualifiedFilter` and LineupsPage `passesGate` both delegate here; only their tracked-pick bypass differs
- `lib/useReportData.js` — shadow-report state + fetchers; MakerBoardPage's only consumer since `/model`/ReportPage was deprecated 2026-07-22
- `lib/scheduledCheckpoints.js` — `SCHEDULED_CHECKPOINTS` dated re-check list, used by MakerBoardPage's `DoThisBanner` (moved in 2026-07-22) and `MakerProgress` "next clock" tile
- `components/` — `MakerBoardPage` (**landing page**, 2026-07-21 — stripped to the category × band heatmap 2026-07-29; a `PreregTracker` block above it (2026-07-30) renders the report's `preregistrations[]` — pre-registered forward-test cards with a checkpoint countdown + the fixed GREEN criteria, the ONLY cell-level "arm target" surface, see `api/lib/maker-prereg.js`), `LineupsPage` (taker picks, demoted to `/picks`, now lazy), `MatchupCard`, `PlaysColumn`, `MyPicksColumn`, `TeamPage`, `TotalsBarChart`, `DayBar` (`AddPickModal` removed 2026-07-23 — dead since its trigger button was pulled 2026-06-14, confirmed unreachable, never a real placement surface)

**Dev proxy**: `vite.config.js` proxies `/api` to production so `npm run dev` works without a local backend.
