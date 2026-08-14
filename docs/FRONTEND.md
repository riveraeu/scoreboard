# Scoreboard — Frontend Reference

The taker UI was removed 2026-07-30 and the entire player/team stat browser 2026-08-04 (model teardown). The surviving frontend is **only** the maker board + auth — no routing, no pick tracking, no play cards, no model dashboards. Everything those older sections documented is deleted; this file describes what's left. Component map → `src/CLAUDE.md`.

---

## App.jsx (~100 lines)
Auth modal + `MakerBoardPage` + a read-only Kalshi-balance fetch for the board header chip. No router — `MakerBoardPage` is the only view. `WORKER` (API base) from `src/lib/constants.js` (collapsed to just that export). Hooks: `useAuth`/`useAuthFlow` (login/logout), `useReportData` (the board's only data source). `fetchKalshiBalance` populates `kalshiBalance` + `makerCommitted` (dollars in resting V2 orders) for the header chip; fails silently.

---

## MakerBoardPage (`src/components/MakerBoardPage.jsx`)
The landing (and only) page. Self-contained — React only, inline styles (the design-token file `src/lib/styles.js` was deleted 2026-08-04). Data from `useReportData` → `/api/shadow-report` (25h-cached; `fetchShadowReport(true)` busts). **Rewritten 2026-08-14 as a terse monospace text digest** — replaces the 2026-08-13 full-mirror rewrite (which rendered every report field as its own stat-tile grid + bordered table, including two large category×band grids and 50+ row robust-candidate tables; user feedback: too long, "make it read like the CLI daily-report output"). Same priority order the daily-report workflow itself uses (`project_model_report_workflow`): robust candidates → preregistrations → discovery → cross-venue → category economics → report meta. Header: login/logout + read-only Kalshi-balance/committed-capital chip (unchanged).

Sections top to bottom, each a handful of summary lines, not a row dump:

- **Freshness line** — reads `dataFreshness`; green dot when `makerTableCurrent`, amber + `daysBehind`/`diagnosis` when not (pipeline currency, distinct from `uiHealth` below).
- **`RobustCandidates`** — reads `robustCandidates`. Framed as a TRIPWIRE, never a ranked target list (`feedback_no_insample_target_picker_ui`): bar + eligible-count line, positive/negative arm counts (read the asymmetry, not the count alone — `project_ladder_artifact_2026_08_11`), top 5 per arm by `perContract` magnitude inline with a "+N more" tail. Ranking WITHIN this field's two arms is doctrine-approved (the structural bar qualifies the cell, not the sort) — unlike the raw heatmap below.
- **`Preregistrations`** — verdict-count summary line + one compact line per entry (`VERDICT label — Nd/Nf · M/5 checks · checkpoint`); see `docs/REENTRY.md`.
- **`Discovery`** — reads `discovery` (Kalshi series-vet queue) + `discovery.polymarket` (per-league Poly vet queue). One counts line per venue + a capped ticker/league list (top 8, "+N more"). No hand-authored verdicts — a `REAL_BOOK` screen proves liquidity, never buildability.
- **`CrossVenue`** — reads `polymarketTracking` (capture accrual, resolution health, both-venue cell counts) — its own `vig` summary already derives from `venueVig` server-side, so this is the only place that data renders; a separate grid would just restate it. `topDivergences` (top 5, from the report's own already-computed list) is a MONITOR, never a bet list, same doctrine as below.
- **`CategoryEconomics`** — replaces both removed heatmap grids. **Aggregates only, no per-cell ranking**: total cells, reliable-count (clears zero, day-clustered), anomaly-count, total contracts graded. Anomaly-flagged cells ARE named (up to 8) — a structural wrong-side-fill flag, not a magnitude ranking, so listing them doesn't violate the no-target-picker doctrine the way a "top movers" list would.
- **Footer** — `reportDate`/`generatedAt`/`since`/`durationMs` + a compact `uiHealth` ok/warn line.

**Deliberately NOT rendered:** `makerBoard.fills`/`live`/`adverseSelection`/`crossChecks` (the V1/V2 real-fill-PnL instruments) — dropped from the daily readout 2026-08-03 (`feedback_morning_report_omit_maker_instruments`): those instruments run continuously but are un-arm-able and produce nothing actionable, so they're noise on the board too. The instruments themselves keep running server-side (closure doctrine — instruments never stop, only actions do).

**Doctrine:** the report fields (and `robustCandidates`/`polymarketTracking.vig`) are measurement surfaces, not a bet list. Never rank/advance a category×band cell into an action — forward pre-registration is the only path to a target (`feedback_no_insample_target_picker_ui`, `feedback_heatmap_investigation_protocol`). The two category×band **grids** (PnL, cross-venue vig) are gone from the UI entirely as of 2026-08-14 — their underlying data still ships in the raw `/api/shadow-report` payload, just not rendered as a visual grid; the page now optimizes for a quick read, not full-fidelity exploration.

Reusable primitives: `_Head` (section caps header), `_L` (one text line, `dim` prop mutes secondary lines), `_more(n)` ("+N more" tail).

Endpoint-only diagnostics (not surfaced in the UI): `/api/shadow-report?makerQueueCheck=1` (V1 vs V2), `?makerSideAudit=`, `?makerDay=YYYY-MM-DD` (single-day V1 drilldown).

---

## Dev proxy
`vite.config.js` proxies `/api` to production, so `npm run dev` works without a local backend. (Dev renders against prod data; verify production behavior via `npm run preview` after a build.)
