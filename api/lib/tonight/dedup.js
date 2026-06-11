// api/lib/tonight/dedup.js
// Per-matchup alt-line dedup (added 2026-05-18, extended to player props 2026-05-19) for
// every play type that has multiple alt thresholds/lines per logical bet:
//   - total: same matchup × direction (correlated by game outcome)
//   - teamTotal: same scoring team × direction
//   - spread: same pickTeam × opponent
//   - player props: same player × stat (alt thresholds sample one distribution)
// ML is excluded (each side is its own play, no alt lines). Keeps highest-edge line per
// group; demoted lines carry reason "altLineDedup" + `_altLineDemoted: true`.
// Extracted from api/lib/handlers/tonight.js (2026-06-11). Zero behavior change.

// Dedup group key for a play, or null when the play type has no alt lines (ML).
export function dedupKey(p) {
  // Segment qualifier: F5 (first-5-innings) and full-game markets on the same matchup
  // are *independent* bets — different outcomes resolve them — so they must not dedup
  // against each other. Default to "full" when absent.
  const _seg = p.segment || "full";
  if (p.gameType === "total") return `gt|${p.sport}|${_seg}|${p.homeTeam}|${p.awayTeam}|${p.gameDate}|${p.direction || 'over'}`;
  if (p.gameType === "teamTotal") return `tt|${p.sport}|${_seg}|${p.scoringTeam}|${p.oppTeam}|${p.gameDate}|${p.direction || 'over'}`;
  // Spread: matchup-symmetric + line-specific key. Deduplicates both sides of the
  // same line (MIN +3.5 vs KC -3.5 are the same bet). Different alt lines (MIN +2.5
  // vs MIN +3.5) get independent groups so each survives the category-gate pass.
  if (p.gameType === "spread") {
    const teams = [p.pickTeam, p.oppTeam].sort().join('|');
    // Include line so different alt lines (e.g. +2.5 vs +3.5) compete independently.
    // Still deduplicates both sides of the same line (MIN +3.5 vs KC -3.5).
    return `sp|${p.sport}|${_seg}|${teams}|${p.line}|${p.gameDate}`;
  }
  // Player props (no gameType): same player × stat across alt thresholds are sampling the
  // same underlying random variable (Tucker 1+/2+/3+ HRR draws from his HRR distribution).
  // Keep highest-edge threshold per player×stat — reverses the 2026-05-16 "see all alts"
  // decision since correlation is too strong to size independently.
  if (!p.gameType && p.playerName && p.stat) return `pp|${p.sport}|${p.playerName}|${p.stat}|${p.gameDate}`;
  return null;
}

// Pure dedup pass: returns { kept, demoted }. Caller owns reassembling the plays array
// (tonight.js splices kept + demoted back in place and pushes demoted to dropped[] in debug).
export function dedupAltLines(plays) {
  const _bestByKey = {};
  for (const p of plays) {
    const k = dedupKey(p);
    if (!k) continue;
    if (!_bestByKey[k] || (p.edge ?? 0) > (_bestByKey[k].edge ?? 0)) _bestByKey[k] = p;
  }
  const kept = [];
  const demoted = [];
  for (const p of plays) {
    const k = dedupKey(p);
    if (!k || _bestByKey[k] === p) kept.push(p);
    // Mark with `_altLineDemoted: true` — separate from dcQualified because the
    // dataConfidence pass in tonight.js overwrites dcQualified per-play and would otherwise
    // restore the demoted alt to qualified. _altLineDemoted is the dedup-stable marker
    // the client filter uses to exclude (unless the user has the pick tracked).
    else demoted.push({ ...p, reason: "altLineDedup", _altLineDemoted: true });
  }
  return { kept, demoted };
}
