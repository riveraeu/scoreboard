// Deterministic shadow_plays row identity — THE join key between a play object and its
// Neon row. Extracted from handlers/shadow.js (2026-07-19) so the maker engine can stamp
// `shadow_row_id` on quote segments without a handler→handler import cycle. Any change here
// changes row identity for NEW rows only (ids are stable per play shape) — never reorder or
// re-key fields casually; historical rows keep their ids.
//
// `scoringTeam` added 2026-07-22: team-total plays never populate `pickTeam` (that's an ML/
// spread field), so two different teams' team-total lines on the SAME game with the SAME
// threshold previously produced IDENTICAL keys — e.g. CHC's "team total over 2" and DET's
// "team total over 2" for one CHC@DET game collided into one shadow_plays row. Whichever
// logged first silently won; the other's real order (in maker_orders_v2) joined to the wrong
// row and inherited the wrong team's outcome — found via a real-money PnL discrepancy audit
// against Kalshi's own settlements. Forward-only fix (see comment above) — does not re-key
// historical rows already logged under the collided identity.
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
    p.scoringTeam || "",
  ].join("|");
}
