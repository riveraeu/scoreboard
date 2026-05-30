// api/lib/tonight/parse-teams.js
// Kalshi → ESPN team-abbreviation normalization tables + Kalshi event-ticker parser.
// Extracted from api/lib/handlers/tonight.js Phase B (2026-05-29). Zero behavior change.

// Kalshi ticker abbreviation → canonical ESPN abbreviation, per sport.
// See CLAUDE.md "TEAM_NORM" for the full gotcha list.
export const TEAM_NORM = {
  nba: { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX", WPH: "PHX", KAT: "ATL" },
  // WNBA: Kalshi uses CONN/DAL but ESPN scoreboard returns CONNECTICU/DALLAS — translate via parallel
  // map (WNBA_CANON_TO_ESPN) when fetching ESPN; canonical (short) lives here.
  wnba: { CONNECTICU: "CONN", CON: "CONN", DALLAS: "DAL", WAS: "WSH", GSV: "GS", LAS: "LA" },
  nhl: { NJ: "NJD", TB: "TBL", LA: "LAK", SJ: "SJS", VGK: "VGK" },
  mlb: { KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", CHW: "CWS", AZ: "ARI", KC: "KC", SD: "SD", SF: "SF", TB: "TB", OAK: "ATH", WSN: "WSH", WAS: "WSH" },
  nfl: { LA: "LAR" },
};

export const normTeam = (sport, a) => TEAM_NORM[sport]?.[a] || a;

// Hardcoded valid team abbreviations per sport — used to disambiguate Kalshi tickers
// where a 2-char prefix (e.g. "NY" → NYK) is a substring of a 3-char team code starting
// the same way (e.g. "NYK" itself). Without validation, "NYKPHI" was parsing as NY+KPH
// instead of NYK+PHI; same for SASMIN→SA+SMI. Try 3+3 first, validate, fall back to 2+3.
export const _VALID_TEAMS = {
  nba: new Set(["ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GSW","HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NOP","NYK","OKC","ORL","PHI","PHX","POR","SAC","SAS","TOR","UTA","WAS"]),
  // WNBA has multiple 2-char abbrs (GS/LV/LA/NY/DA) and pairs like LVNY/LANY/GSLA/LVGS hit 2+2
  // splits. Validation guards against 2-char-prefix stealing the parse from a 3-char team.
  wnba: new Set(["ATL","CHI","CONN","DAL","GS","IND","LV","LA","MIN","NY","PHX","POR","SEA","TOR","WSH"]),
  nhl: new Set(["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","STL","SJS","SEA","TBL","TOR","UTA","VAN","VGK","WSH","WPG"]),
  mlb: new Set(["ARI","ATL","ATH","BAL","BOS","CHC","CIN","CLE","COL","CWS","DET","HOU","KC","LAA","LAD","MIA","MIL","MIN","NYM","NYY","PHI","PIT","SD","SEA","SF","STL","TB","TEX","TOR","WSH"]),
  nfl: new Set(["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SEA","SF","TB","TEN","WSH"]),
};

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
  // WNBA has 2-, 3-, and 4-char canonical abbrs (LV/NY/GS/LA + ATL/IND/DAL + CONN).
  // Try every (i, len-i) split and accept the first one where both halves validate.
  // Prefer longer left-side first so e.g. CONNIN parses as CONN+IND, not CO+NNIN.
  if (sport === "wnba" && valid) {
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
