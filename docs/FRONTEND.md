# Scoreboard — Frontend Reference

The taker UI was removed 2026-07-30 and the entire player/team stat browser 2026-08-04 (model teardown). The surviving frontend is **only** the maker board + auth — no routing, no pick tracking, no play cards, no model dashboards. Everything those older sections documented is deleted; this file describes what's left. Component map → `src/CLAUDE.md`.

---

## App.jsx (~100 lines)
Auth modal + `MakerBoardPage` + a read-only Kalshi-balance fetch for the board header chip. No router — `MakerBoardPage` is the only view. `WORKER` (API base) from `src/lib/constants.js` (collapsed to just that export). Hooks: `useAuth`/`useAuthFlow` (login/logout), `useReportData` (the board's only data source). `fetchKalshiBalance` populates `kalshiBalance` + `makerCommitted` (dollars in resting V2 orders) for the header chip; fails silently.

---

## MakerBoardPage (`src/components/MakerBoardPage.jsx`)
The landing (and only) page. Self-contained — React only, inline styles (the design-token file `src/lib/styles.js` was deleted 2026-08-04). Data from `useReportData` → `/api/shadow-report` (25h-cached; `fetchShadowReport(true)` busts). **Rewritten 2026-08-13 to render the FULL report payload**, in the same priority order the daily-report workflow itself uses (`project_model_report_workflow`): robust candidates → preregistrations → heatmap → discovery → polymarket coverage parity → venue-vig → report meta. Header: login/logout + read-only Kalshi-balance/committed-capital chip.

Sections top to bottom:

- **`DataFreshnessBanner`** — reads `dataFreshness`; silent-ish green when `makerTableCurrent`, otherwise shows `daysBehind` + the `diagnosis` string (pipeline currency, distinct from `uiHealth` below).
- **`RobustCandidatesTripwire`** — reads `robustCandidates`. Framed as a TRIPWIRE, never a ranked target list (`feedback_no_insample_target_picker_ui`): shows the structural bar, the positive/negative arm counts side by side (read the asymmetry, not the count alone — `project_ladder_artifact_2026_08_11`), and both arms as tables sorted by `perContract` magnitude.
- **`PreregTracker`** (inline summary strip) — renders the report's `preregistrations[]` (the forward pre-registered tests; see `docs/REENTRY.md`).
- **`CategoryBandHeatmap`** — category × price-band **PnL** grid over `makerBoard.categoryBands`. Bands are 5¢ buckets (`_BANDS`, `0-4 … 40-44`). Thin cells (below the report's sample bar) greyed.
- **`DiscoveryOverview`** — reads `discovery` (Kalshi series-vet queue) + `discovery.polymarket` (per-league Poly vet queue). Stat tiles for counts (adopted/shortlisted/baseline/new/dismissed) + `toVet` tables. No hand-authored verdicts — a `REAL_BOOK` screen proves liquidity, never buildability, so this section shows what was screened, not a build recommendation.
- **`PolymarketTrackingHealth`** — reads `polymarketTracking`: capture accrual (rows/day, `recentBySport`), resolution health (graded/voided/pending), and the cross-venue vig divergence summary (`topDivergences` — a MONITOR, never a bet list, same doctrine as venue-vig below).
- **`VenueVigHeatmap`** — a SECOND grid over `venueVig`, cell = favorite-ask **VIG** in ¢ (a different quantity from the PnL grid). Stacks Kalshi vig (top) over Poly vig (bottom) per cell; color = Δ(K−P). Kalshi is live day one, Poly reads "—" until rows resolve (~1 day after capture). A divergence monitor — **not a ranking; pre-register, never bet** (legend says so). Reuses `_BANDS`/`_cellBg`.
- **`ReportFooter`** — `reportDate`/`generatedAt`/`since`/`durationMs` + a compact `uiHealth` line (render self-check: cell/row counts, prereg card count, any warnings).

**Deliberately NOT rendered:** `makerBoard.fills`/`live`/`adverseSelection`/`crossChecks` (the V1/V2 real-fill-PnL instruments) — dropped from the daily readout 2026-08-03 (`feedback_morning_report_omit_maker_instruments`): those instruments run continuously but are un-arm-able and produce nothing actionable, so they're noise on the board too. The instruments themselves keep running server-side (closure doctrine — instruments never stop, only actions do).

**Doctrine:** the heatmaps (and `robustCandidates`/`polymarketTracking.vig`) are measurement surfaces, not a bet list. Never rank/advance a category×band cell into an action — forward pre-registration is the only path to a target (`feedback_no_insample_target_picker_ui`, `feedback_heatmap_investigation_protocol`).

Reusable primitives added for this rewrite: `_StatTile`/`_StatRow` (labeled number tiles) and `_Table` (generic `{columns, rows}` renderer) — one chokepoint feeding all five new tables/tile-rows instead of five hand-rolled markups.

Endpoint-only diagnostics (not surfaced in the UI): `/api/shadow-report?makerQueueCheck=1` (V1 vs V2), `?makerSideAudit=`, `?makerDay=YYYY-MM-DD` (single-day V1 drilldown).

---

## Dev proxy
`vite.config.js` proxies `/api` to production, so `npm run dev` works without a local backend. (Dev renders against prod data; verify production behavior via `npm run preview` after a build.)
