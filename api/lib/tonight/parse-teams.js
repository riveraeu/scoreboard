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
  // "CR" + everything else 3-char; nwsl: KC's 2-char code + everything else 3-char; argprem:
  // Central Córdoba's 2-char "CC" + Instituto's 4-char "IACC" + everything else 3-char;
  // copadobrasil: Remo's 2-char "CR" like brasileirao; ligue1: OL (Lyon) and OM (Marseille)
  // are 2-char, making TFCOL/OMLIL etc. 5-char pairs; nfl: EIGHT 2-char abbrs — GB/KC/LA/LV/
  // NE/NO/SF/TB — so both 2+2 (GBKC) and 2+3 (GBSEA) pairs occur. NFL was added 2026-08-10 with
  // the KXNFLGAME build, and it was already broken for KXNFLTOTAL: only "LA" has a TEAM_NORM
  // entry (LAR's kalshi alias), so has2charPrefix was false for the other seven and GBKC fell
  // past every branch to [null,null] while GBSEA hit the unvalidated 3+2 fallback and returned
  // ["GBS","EA"] — a SILENT wrong parse of the exact class _VALID_TEAMS exists to stop; kbo joins
  // for the same reason on LG Twins' 2-char "LG", which has no TEAM_NORM alias to be seen by).
  // dimayor joined 2026-08-10 on Once Caldas' 2-char "OC" (`OCALI` was parsing to ["OCA","LI"]) —
  // note its comment above once claimed dimayor was uniform-3-char and needed no entry. **Adding a
  // league here is only safe once its registry is COMPLETE**: this path validates both halves, so a
  // partial registry converts parses that previously survived on the unvalidated fallback into
  // nulls, dropping rows that used to work.
  // Try every (i, len-i) split and accept
  // the first one where both halves validate. Prefer longer left-side first so e.g. CONNIN parses
  // as CONN+IND (not CO+NNIN), NYRBCLT as NYRB+CLT (not NY+RBCLT), CRUCHA as CRU+CHA (not CR+UCHA)
  // while CRSAN still parses as CR+SAN. Uses _VALID_TEAMS (not TEAM_NORM), so registries with no
  // kalshi aliases (copadobrasil) are covered where the generic has2charPrefix path is not.
  // leaguescup joined 2026-08-11: it INHERITS mls's mixed lengths (SD is 2-char, LAFC is 4-char)
  // through its derived mls ∪ ligamx registry, so it needs this path for the same reason mls does.
  // Live event segments confirm the split is unambiguous under longest-left-first: SDPUE → SD|PUE,
  // LAFCQUE → LAFC|QUE, everything else 3+3. SD is the only 2-char and LAFC the only 4-char code in
  // the tournament's 36, which is what keeps every split unique.
  // eerstediv joined 2026-08-14: "AZ" (Jong AZ Alkmaar) is a 2-char Kalshi code, everything else
  // 3-char — GRAAZ (5 chars) needs the validated 2+3 fallback here, not the unvalidated one below.
  // belgianpl joined 2026-08-17: "RAFC" (Antwerp) and "RAAL" (La Louvière) are 4-char, everything
  // else 3-char — RAFCGEN/STARAAL etc (7 chars) need this path the same reason mls/leaguescup need
  // it for LAFC/NYRB. No 2-char codes in this registry.
  if ((sport === "wnba" || sport === "mls" || sport === "brasileirao" || sport === "nwsl" || sport === "argprem" || sport === "copadobrasil" || sport === "ligue1" || sport === "usl" || sport === "copalib" || sport === "nfl" || sport === "kbo"
       || sport === "dimayor" || sport === "leaguescup" || sport === "eerstediv" || sport === "belgianpl") && valid) {
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
