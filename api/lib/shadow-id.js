// Deterministic shadow_plays row identity — THE join key between a play object and its
// Neon row. Extracted from handlers/shadow.js (2026-07-19) so the maker engine can stamp
// `shadow_row_id` on quote segments without a handler→handler import cycle. Any change here
// changes row identity for NEW rows only (ids are stable per play shape) — never reorder or
// re-key fields casually; historical rows keep their ids.
export function shadowId(p, fallbackDate = "") {
  return [
    p.sport || "",
    p.gameDate || fallbackDate || "",
    p.homeTeam || "",
    p.awayTeam || "",
    p.playerName || "",
    p.stat || p.gameType || "",
    String(p.threshold ?? p.pickLine ?? ""),
    p.direction || "",
    p.pickTeam || "",
  ].join("|");
}
