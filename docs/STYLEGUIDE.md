# Scoreboard Style Guide

Extracted from the live design 2026-06-11. **Read this before adding any new UI element.**
Tokens and shared recipes live in `src/lib/styles.js` — import from there in new code instead of
hard-coding hex values. The tier ladder (`tierColor`) stays in `src/lib/colors.js`.

The app styles everything inline in JSX (no CSS framework, no CSS modules). That is deliberate:
most colors are data-driven per render (tier colors, pace colors, bar widths). This guide keeps
the *static* choices consistent. Do not introduce Tailwind/styled-components/etc.

---

## Palette

GitHub-dark derived. Dark mode only.

### Surfaces

| Token | Hex | Use |
|---|---|---|
| `C.bg` | `#0d1117` | Page background, input fields, image letterbox |
| `C.card` | `#161b22` | Cards, modals, column panels, badges-on-cards |
| `C.tooltip` | `#1c2128` | Tooltips and popovers only |
| `C.inset` | `#21262d` | Inset elements on cards: chips, table header rows, placeholders |
| `C.border` | `#30363d` | Default 1px border for cards/inputs/tooltips |
| `C.borderSubtle` | `#21262d` | Quiet row dividers inside tables |

### Text

| Token | Hex | Use |
|---|---|---|
| `C.text` | `#c9d1d9` | Primary text, values |
| `C.dim` | `#8b949e` | Secondary labels, decorative (non-SimScore) stats |
| `C.faint` | `#6e7681` | Table column headers, timestamps |
| `C.muted` | `#484f58` | Disabled, empty states, sub-threshold values, pending |

### Semantic colors

| Token | Hex | Meaning — **do not repurpose** |
|---|---|---|
| `C.green` | `#3fb950` | Good tier (≥70%), win, filled order, met threshold |
| `C.yellow` | `#e3b341` | Mid tier (60–70%), warning pace, resting order |
| `C.red` | `#f78166` | Bad tier (<60%), loss, error |
| `C.blue` | `#58a6ff` | Interactive: links, active tab, selected count, info stats, "placing" |
| `C.kalshi` | `#6e40c9` | **Kalshi market price exclusively** — bars, %, odds strings. Never for anything else; nothing else may be purple. |
| `C.cta` | `#238636` | Solid background of primary-action buttons (Add Pick, submit) |
| `C.warn` | `#f87171` | Status warning chips: Out, B2B |

- Tier ladder: `tierColor(pct)` in `src/lib/colors.js` — ≥70 green / ≥60 yellow / <60 red.
  Single source of truth; see FRONTEND.md "Color tiers" for where it does and does NOT apply
  (ReportPage SimScore-component cells map to points awarded, not the universal ladder).
- Explanation text colors must follow the SimScore color-parity doctrine in FRONTEND.md —
  non-SimScore decoration is always gray (`C.dim`).
- One-off chart accents on ReportPage (orange `#f97316`, violet `#a855f7`, etc.) are
  chart-series colors only — don't let them leak into cards/chips.

### Tinted fills

Chips, badges, and highlighted rows use a translucent fill of their semantic color:
`tint(C.green, 0.12)` → `rgba(63,185,80,0.12)`. Alpha 0.10–0.15 for backgrounds, 0.3 for
borders when a softer outline is wanted. Solid 1px border of the full-strength color for
status chips (`chipStyle(C.warn)`).

---

## Typography

- **Family**: `'Segoe UI', sans-serif` set once on `body` (src/index.css). No per-element
  font families, no monospace.
- **Sizes** (px): the workhorses are **10 / 11 / 12 / 13**.
  - 9 — status chips, micro-labels
  - 10 — badge text, odds strings, sub-labels
  - 11 — table cells, tooltips, secondary values
  - 12 — body, labels, buttons
  - 13 — emphasized values, primary card text
  - 14 — CTA buttons, section heads
  - 16–20 — page/modal titles, hero stats (sparingly)
- **Weights**: only **400 / 600 / 700**. 600 = labels and buttons, 700 = values and titles.
  Never 500, never light weights.

---

## Shape & depth

| Radius | Use |
|---|---|
| 4 | Chips, badges, progress/percent bars |
| 6 | Cards, tooltips, secondary buttons |
| 8 | Inputs, primary buttons |
| 12–14 | Modals, drawers |
| 50% | Avatars/headshots (22×22 circle) |

Shadows **only on floating layers** (tooltips, modals, drawers) — never on in-flow cards:
- Tooltip: `0 4px 12px rgba(0,0,0,0.5)`
- Modal: `0 8px 24px rgba(0,0,0,0.6)`
- Side drawer: `-4px 0 32px rgba(0,0,0,0.6)`

---

## Spacing

- **Gap scale**: 4 / 6 / 8 / 10 / 12 (8 is the default flex gap).
- **Padding recipes**: chips `1px 5px` · small buttons `2px 6px`–`5px 10px` ·
  table cells `5px 10px` · card bodies `10px 14px`–`14px 16px` · modals `20px 22px`+.
- Layout is flexbox-first with inline `display:flex`; no grid system.

---

## z-index layers

| Range | Layer |
|---|---|
| 1–10 | In-card stacking (bars over fills, sticky headers) |
| 50–100 | Column-level overlays, FAB |
| 585–598 | Player card overlay stack (App.jsx) |
| 700–1000 | Modals, drawers, auth |
| 9999 | Tooltips (always on top, portaled to body) |

New floating UI: tooltips → 9999 via `createPortal` (see `SimBadge.jsx` for the canonical
pattern — fixed position, clamped to viewport, closes on outside tap/scroll); modal-ish →
700–1000.

---

## Component patterns (canonical examples)

| Pattern | Reference | Notes |
|---|---|---|
| Card | `cardStyle` | `#161b22` + `1px solid #30363d` + radius 6 |
| Status chip | `chipStyle(color)` / MyPicksColumn "Out"/"B2B" | 9px 700, tinted bg, solid border |
| Score badge | `SimBadge.jsx` | inset bg `#161b22`, radius 4, 10px 700, tap-to-pin tooltip |
| Percent bar | PlaysColumn truePct bars | track `#21262d` radius 4, fill = `tierColor(pct)` or `C.kalshi`, `transition: width 0.5s ease`, `minWidth: 2–3` when >0 |
| Tooltip | `tooltipStyle` / SimBadge portal | `#1c2128`, 11px, `whiteSpace:"pre"` for multiline |
| Modal | `modalStyle` / AddPickModal | radius 12–14, padding 20–28 |
| Input | `inputStyle` | page-bg `#0d1117` on card bg — inputs are *darker* than their container |
| Primary button | `btnPrimary` | solid `#238636`, white text. Blue `#58a6ff` bg + `#0d1117` text for auth submit |
| Order-state colors | AddPickModal `stateColor` | filled green · resting yellow · error red · placing blue · pending muted |

---

## Checklist for new UI elements

1. Import tokens from `src/lib/styles.js`; never hard-code a new hex. If the color isn't in
   the palette, that's a design decision — add it to the tokens + this doc in the same commit.
2. Is the color *meaningful*? Green/yellow/red must mean good/mid/bad. Blue must mean
   interactive/info. Purple = Kalshi price, full stop.
3. Coloring narrative/explanation text? Follow the SimScore color-parity doctrine
   (FRONTEND.md) — gray unless the metric is SimScore-pointed.
4. Font size from {9…14}, weight from {400, 600, 700}.
5. Radius from {4, 6, 8, 12}; shadow only if the element floats.
6. Floating element? Portal + z-index per the layer table; mobile needs tap-to-pin
   (hover doesn't exist) — copy SimBadge.
7. Check mobile: `useIsMobile(600)` is the breakpoint hook.
