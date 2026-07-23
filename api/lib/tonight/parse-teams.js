// api/lib/tonight/parse-teams.js
// Kalshi event-ticker parser. TEAM_NORM (Kalshi abbr → canonical) and _VALID_TEAMS
// (canonical sets used for split validation) are derived from the team registry in
// api/lib/teams.js since 2026-06-11 and re-exported here for the historical import
// path. See CLAUDE.md "TEAM_NORM" for the gotcha list; teams.test.js pins the values.
// Note: identity entries in TEAM_NORM (mlb KC→KC etc.) are functional — membership
// marks 2-char prefixes for the validated 2+3 split below.

import { TEAM_NORM, _VALID_TEAMS } from "../teams.js";
export { TEAM_NORM, _VALID_TEAMS };

export const normTeam = (sport, a) => TEAM_NORM[sport]?.[a] || a;

// Parse Kalshi event ticker segment into canonical [team1, team2] pair.
// Ticker format: KXSPORT-YYMMDDHHMMTEAM1TEAM2-SUFFIX
// Prefers 3+3 split (validated), falls back to 2+3 (for 2-char Kalshi prefix teams like GS, NY).
// WNBA requires special handling for mixed 2/3/4-char canonical abbrs (see CLAUDE.md).
export function parseGameTeams(eventTicker, sport) {
  const seg = (eventTicker || "").split("-")[1] || "";
  let rest = seg.slice(7);
  if (/^\d{4}[A-Z]/.test(rest)) rest = rest.slice(4);
  if (rest.length < 4) return [null, null];
  const valid = _VALID_TEAMS[sport];
  // Sports with 2/3/4-char canonical abbrs mixed in one registry (WNBA: LV/NY/GS/LA +
  // ATL/IND/DAL + CONN; MLS: NE/SD/SJ + most 3-char + LAFC/NYRB; brasileirao: Remo's 2-char
  // "CR" + everything else 3-char; nwsl: KC's 2-char code + everything else 3-char). Try every
  // (i, len-i) split and accept the first one where both halves validate. Prefer longer
  // left-side first so e.g. CONNIN parses as CONN+IND (not CO+NNIN), NYRBCLT as NYRB+CLT (not
  // NY+RBCLT).
  if ((sport === "wnba" || sport === "mls" || sport === "brasileirao" || sport === "nwsl") && valid) {
    for (let i = Math.min(4, rest.length - 2); i >= 2; i--) {
      const a = normTeam(sport, rest.slice(0, i));
      for (let j = Math.min(4, rest.length - i); j >= 2; j--) {
        const b = normTeam(sport, rest.slice(i, i + j));
        if (valid.has(a) && valid.has(b)) return [a, b];
      }
    }
    return [null, null];
  }
  // Try 3+3 first when length >= 6: only commit if both halves are recognized teams.
  if (rest.length >= 6) {
    const a3 = normTeam(sport, rest.slice(0, 3));
    const b3 = normTeam(sport, rest.slice(3, 6));
    if (valid && valid.has(a3) && valid.has(b3)) return [a3, b3];
  }
  const has2charPrefix = TEAM_NORM[sport]?.[rest.slice(0, 2)] !== undefined;
  // Validated 2+3 split — covers Kalshi tickers using 2-char shorthand for first team.
  if (rest.length >= 5 && has2charPrefix) {
    const a2 = normTeam(sport, rest.slice(0, 2));
    const b3 = normTeam(sport, rest.slice(2, 5));
    if (valid && valid.has(a2) && valid.has(b3)) return [a2, b3];
  }
  // Unvalidated fallbacks (legacy ordering preserved for sports without _VALID_TEAMS).
  if (rest.length >= 6 && !has2charPrefix) return [normTeam(sport, rest.slice(0, 3)), normTeam(sport, rest.slice(3, 6))];
  if (rest.length >= 5 && has2charPrefix) return [normTeam(sport, rest.slice(0, 2)), normTeam(sport, rest.slice(2, 5))];
  if (rest.length >= 5) return [normTeam(sport, rest.slice(0, 3)), normTeam(sport, rest.slice(3, 5))];
  if (rest.length >= 4 && has2charPrefix) return [normTeam(sport, rest.slice(0, 2)), normTeam(sport, rest.slice(2, 4))];
  if (rest.length >= 6) return [normTeam(sport, rest.slice(0, 3)), normTeam(sport, rest.slice(3, 6))];
  return [null, null];
}
