export const getColor = () => "#8b949e";
export const matchupColor = (softPct, pct) =>
  softPct != null ? (softPct >= pct + 5 ? "#3fb950" : softPct <= pct - 5 ? "#f78166" : "#8b949e") : "#8b949e";
export const tierColor = pct => pct >= 80 ? "#3fb950" : pct >= 60 ? "#e3b341" : "#f78166";
