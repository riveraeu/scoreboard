export const tierColor = pct =>
  pct >= 90 ? "#1a7f37"   // dark green
  : pct >= 80 ? "#3fb950" // medium green
  : pct >= 70 ? "#7ee787" // light green
  : pct >= 60 ? "#e3b341" // yellow
  : "#f78166";            // red
