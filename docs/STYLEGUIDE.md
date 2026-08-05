# Scoreboard Style Guide

The visual language of the surviving UI (`App.jsx` + `MakerBoardPage.jsx`). Everything is styled **inline in JSX with hard-coded hex** — the token file `src/lib/styles.js` and `colors.js` were deleted 2026-08-04 with the model teardown; the two components inline their own styles. No CSS framework, no CSS modules — don't introduce Tailwind/styled-components. GitHub-dark derived, **dark mode only**. Copy an existing value from those two files rather than inventing one.

---

## Palette

### Surfaces
| Hex | Use |
|---|---|
| `#0d1117` | Page background, input fields |
| `#161b22` | Cards, modals |
| `#21262d` | Inset elements: chips, table header rows, bar tracks |
| `#30363d` | Default 1px border for cards/inputs/modals |

### Text
| Hex | Use |
|---|---|
| `#c9d1d9` | Primary text, values |
| `#8b949e` | Secondary labels, decorative stats |
| `#484f58` | Disabled, empty states, sub-threshold/pending values |

### Semantic — do not repurpose
| Hex | Meaning |
|---|---|
| `#3fb950` green | Good, win, positive PnL |
| `#e3b341` yellow | Mid, warning |
| `#f78166` red | Bad, loss, negative PnL, error |
| `#58a6ff` blue | Interactive: links, active tab, submit |

Heatmap cells derive their fill from the value's sign/magnitude (`_cellBg` in `MakerBoardPage.jsx`); thin/low-sample cells grey out. Translucent fills for chips/badges use `rgba(...)` of the semantic color at ~0.10–0.15 alpha.

---

## Typography
- **Family**: `'Segoe UI', sans-serif`, set once on `body` (`src/index.css`). No per-element families, no monospace.
- **Sizes** (px): workhorses **10 / 11 / 12 / 13**. 9 = micro-labels/chips · 14 = section heads/buttons · 16–20 = titles/hero (sparingly).
- **Weights**: only **400 / 600 / 700** (600 = labels/buttons, 700 = values/titles). Never 500 or lighter.

---

## Shape, depth & spacing
- **Radius**: 4 (chips, bars) · 6 (cards, buttons) · 8 (inputs, primary buttons) · 12–14 (modals) · 50% (avatars).
- **Shadows only on floating layers** (modals) — never on in-flow cards. Modal `0 8px 24px rgba(0,0,0,0.6)`.
- **Gap scale**: 4 / 6 / 8 / 10 / 12 (8 is the default flex gap). Flexbox-first, inline `display:flex` — no grid system.
- **Padding recipes**: chips `1px 5px` · buttons `2px 6px`–`5px 10px` · table cells `5px 10px` · card bodies `10px 14px` · modals `20px 28px`.

---

## z-index
- In-card stacking: 1–10.
- Auth modal / overlays: 700–1000 (the modal in `App.jsx` uses 1000).

---

## Checklist for new UI
1. Reuse a hex already in `App.jsx`/`MakerBoardPage.jsx`. A genuinely new color is a design decision — add it here in the same commit.
2. Is the color meaningful? green/yellow/red = good/mid/bad; blue = interactive.
3. Font size from {9…14}, weight from {400, 600, 700}.
4. Radius from {4, 6, 8, 12}; shadow only if the element floats.
