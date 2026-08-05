# Scoreboard — Frontend Reference

The taker UI was removed 2026-07-30 and the entire player/team stat browser 2026-08-04 (model teardown). The surviving frontend is **only** the maker board + auth — no routing, no pick tracking, no play cards, no model dashboards. Everything those older sections documented is deleted; this file describes what's left. Component map → `src/CLAUDE.md`.

---

## App.jsx (~100 lines)
Auth modal + `MakerBoardPage` + a read-only Kalshi-balance fetch for the board header chip. No router — `MakerBoardPage` is the only view. `WORKER` (API base) from `src/lib/constants.js` (collapsed to just that export). Hooks: `useAuth`/`useAuthFlow` (login/logout), `useReportData` (the board's only data source). `fetchKalshiBalance` populates `kalshiBalance` + `makerCommitted` (dollars in resting V2 orders) for the header chip; fails silently.

---

## MakerBoardPage (`src/components/MakerBoardPage.jsx`)
The landing (and only) page. Self-contained — React only, inline styles (the design-token file `src/lib/styles.js` was deleted 2026-08-04). Data from `useReportData` → `/api/shadow-report` (25h-cached; `fetchShadowReport(true)` busts). Header: login/logout + read-only Kalshi-balance/committed-capital chip. Three content blocks:

- **`PreregTracker`** — renders the report's `preregistrations[]` (the forward pre-registered tests; see `docs/REENTRY.md`).
- **`CategoryBandHeatmap`** — category × price-band **PnL** grid over `makerBoard.categoryBands`. Bands are 5¢ buckets (`_BANDS`, `0-4 … 40-44`). Thin cells (below the report's sample bar) greyed.
- **`VenueVigHeatmap`** — a SECOND grid over `venueVig`, cell = favorite-ask **VIG** in ¢ (a different quantity from the PnL grid). `[ Kalshi | Polymarket | Δ(K−P) ]` toggle; defaults to Kalshi (live day one), Poly/Δ read "collecting" until Poly rows resolve (~1 day after capture). A divergence monitor — **not a ranking; pre-register, never bet** (legend says so). Reuses `_BANDS`/`_cellBg`.

**Doctrine:** the heatmaps are measurement surfaces, not a bet list. Never rank/advance a category×band cell into an action — forward pre-registration is the only path to a target (`feedback_no_insample_target_picker_ui`, `feedback_heatmap_investigation_protocol`).

The removed banners/tiles (DoThisBanner data-health + checkpoints, the V1↔V2 / model↔market cross-check strip, MakerProgress) are **endpoint-only** now, reachable on demand: `/api/shadow-report?makerQueueCheck=1` (V1 vs V2), `?makerSideAudit=`, `?makerDay=YYYY-MM-DD` (single-day V1 drilldown).

---

## Dev proxy
`vite.config.js` proxies `/api` to production, so `npm run dev` works without a local backend. (Dev renders against prod data; verify production behavior via `npm run preview` after a build.)
