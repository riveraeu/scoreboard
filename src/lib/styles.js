// Design tokens + shared style recipes. See docs/STYLEGUIDE.md for usage rules.
// Adopt in NEW code (and opportunistically when touching old code) — no big-bang migration.
// tierColor(pct) stays in src/lib/colors.js (single source of truth for the tier ladder).

export const C = {
  // Surfaces (GitHub-dark derived)
  bg: "#0d1117",      // page background, input fields
  card: "#161b22",    // cards, modals, column panels
  tooltip: "#1c2128", // tooltips, popovers
  inset: "#21262d",   // inset chips, table header rows, image placeholders
  border: "#30363d",  // primary border
  borderSubtle: "#21262d", // row dividers, quiet table borders
  // Text
  text: "#c9d1d9",    // primary
  dim: "#8b949e",     // secondary labels
  faint: "#6e7681",   // table headers, timestamps
  muted: "#484f58",   // disabled / empty / sub-threshold
  // Semantic (tier ladder = tierColor() in colors.js)
  green: "#3fb950",   // good tier / win / filled
  yellow: "#e3b341",  // mid tier / warning / resting
  red: "#f78166",     // bad tier / loss / error
  blue: "#58a6ff",    // interactive: links, active tabs, info, placing
  kalshi: "#6e40c9",  // Kalshi market price — exclusively
  cta: "#238636",     // solid primary-action buttons
  warn: "#f87171",    // status warning chips (Out, B2B)
};

// rgba tint for chip/badge backgrounds (pass a C.* hex, alpha 0.10–0.15 typical)
export const tint = (hex, a = 0.12) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// --- Recipes (spread, then override) ---
export const cardStyle = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 6 };

export const chipStyle = (color) => ({
  fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
  color, background: tint(color, 0.15), border: `1px solid ${color}`,
});

export const tooltipStyle = {
  background: C.tooltip, border: `1px solid ${C.border}`, borderRadius: 6,
  padding: "6px 10px", fontSize: 11, color: C.text,
  boxShadow: "0 4px 12px rgba(0,0,0,0.5)", zIndex: 9999,
};

export const modalStyle = {
  background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
  boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
};

export const inputStyle = {
  background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text,
};

export const btnPrimary = {
  background: C.cta, border: "none", borderRadius: 8, color: "#fff",
  fontSize: 14, fontWeight: 600, cursor: "pointer",
};

export const btnSecondary = {
  background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6,
  color: C.dim, fontSize: 12, fontWeight: 600, cursor: "pointer",
};
