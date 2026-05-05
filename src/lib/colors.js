export const tierColor = pct =>
  pct >= 90 ? "#1a7f37"   // dark green
  : pct >= 80 ? "#3fb950" // medium green
  : pct >= 70 ? "#7ee787" // light green
  : pct >= 60 ? "#e3b341" // yellow
  : "#f78166";            // red

// Edge-pill badge color, mapped to unit-size bands (matches unitsForPlay in App.jsx).
// 1u (edge < 7) = light green, 3u (7–12) = medium, 5u (≥ 12) = dark.
// Missing/negative edge → light green (1u baseline). Keep these in sync with unitsForPlay.
export const edgeUnitColor = edge =>
  edge == null || edge < 7 ? "#7ee787"   // 1u — light green
  : edge < 12 ? "#3fb950"                 // 3u — medium green
  : "#1a7f37";                            // 5u — dark green
