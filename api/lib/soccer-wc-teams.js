// api/lib/soccer-wc-teams.js
// World Cup team registry + ESPN→canonical name resolution, extracted from soccer.js (2026-08-04)
// so it survives the model-code teardown: the WC Dixon–Coles model is being deleted, but the
// model-free WC emit path (tonight/soccer.js, soccer-advance.js) still needs WC_TEAMS for team
// display names and gameTime/identity resolution. Pure data + name-norm — no model math.
//
// canonical = Kalshi FIFA 3-letter code. `elo` was the 2-letter eloratings.net code (kept for
// reference/debug; no longer consumed once the Elo model is gone). `name` is the Kalshi display
// name.
export const WC_TEAMS = {
  ARG: { name: "Argentina",              elo: "AR" },
  AUS: { name: "Australia",              elo: "AU" },
  AUT: { name: "Austria",                elo: "AT" },
  BEL: { name: "Belgium",                elo: "BE" },
  BIH: { name: "Bosnia and Herzegovina", elo: "BA" },
  BRA: { name: "Brazil",                 elo: "BR" },
  CAN: { name: "Canada",                 elo: "CA" },
  CIV: { name: "Ivory Coast",            elo: "CI" },
  COD: { name: "Congo DR",               elo: "CD" },
  COL: { name: "Colombia",               elo: "CO" },
  CPV: { name: "Cape Verde",             elo: "CV" },
  CRO: { name: "Croatia",                elo: "HR" },
  CUW: { name: "Curacao",                elo: "CW" },
  CZE: { name: "Czechia",                elo: "CZ" },
  DZA: { name: "Algeria",                elo: "DZ" },
  ECU: { name: "Ecuador",                elo: "EC" },
  EGY: { name: "Egypt",                  elo: "EG" },
  ENG: { name: "England",                elo: "EN" },
  ESP: { name: "Spain",                  elo: "ES" },
  FRA: { name: "France",                 elo: "FR" },
  GER: { name: "Germany",                elo: "DE" },
  GHA: { name: "Ghana",                  elo: "GH" },
  HTI: { name: "Haiti",                  elo: "HT" },
  IRI: { name: "IR Iran",                elo: "IR" },
  IRQ: { name: "Iraq",                   elo: "IQ" },
  JOR: { name: "Jordan",                 elo: "JO" },
  JPN: { name: "Japan",                  elo: "JP" },
  KOR: { name: "Korea Republic",         elo: "KR" },
  KSA: { name: "Saudi Arabia",           elo: "SA" },
  MAR: { name: "Morocco",                elo: "MA" },
  MEX: { name: "Mexico",                 elo: "MX" },
  NED: { name: "Netherlands",            elo: "NL" },
  NOR: { name: "Norway",                 elo: "NO" },
  NZL: { name: "New Zealand",            elo: "NZ" },
  PAN: { name: "Panama",                 elo: "PA" },
  PAR: { name: "Paraguay",               elo: "PY" },
  POR: { name: "Portugal",               elo: "PT" },
  QAT: { name: "Qatar",                  elo: "QA" },
  RSA: { name: "South Africa",           elo: "ZA" },
  SCO: { name: "Scotland",               elo: "SQ" }, // eloratings uses SQ — "SC" is Seychelles (ISO-2)
  SEN: { name: "Senegal",                elo: "SN" },
  SUI: { name: "Switzerland",            elo: "CH" },
  SWE: { name: "Sweden",                 elo: "SE" },
  TUN: { name: "Tunisia",                elo: "TN" },
  TUR: { name: "Turkiye",                elo: "TR" },
  URU: { name: "Uruguay",                elo: "UY" },
  USA: { name: "USA",                    elo: "US" },
  UZB: { name: "Uzbekistan",             elo: "UZ" },
};

// ESPN scoreboard abbreviations that differ from the canonical FIFA code. Everything not listed
// here matches (ESPN uses the FIFA 3-letter code for most teams). Group/bracket placeholder
// slots ("1B", "2A", "RD32", "3RD") have no canonical mapping and naturally fail to match any
// concrete Kalshi market, so they're skipped without a special case.
const ESPN_ABBR_TO_CANON = { ALG: "DZA", HAI: "HTI", IRN: "IRI" };

// Normalize a team name for the resolver's name-fallback match: strip diacritics, lowercase,
// drop non-letters. Catches ESPN-vs-Kalshi name divergences the abbr map misses.
function normTeamName(s) {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z]/g, "");
}
const NAME_TO_CANON = (() => {
  const m = {};
  for (const [code, rec] of Object.entries(WC_TEAMS)) m[normTeamName(rec.name)] = code;
  // Common ESPN display-name variants → canonical.
  Object.assign(m, {
    iran: "IRI", southkorea: "KOR", korearepublic: "KOR", czechrepublic: "CZE",
    turkey: "TUR", drcongo: "COD", congodr: "COD", cotedivoire: "CIV", ivorycoast: "CIV",
    caboverde: "CPV", capeverde: "CPV", curacao: "CUW",
    bosniaandherzegovina: "BIH", bosniaherzegovina: "BIH", unitedstates: "USA", usa: "USA",
  });
  return m;
})();

// Map an ESPN competitor (abbreviation + displayName) to a canonical FIFA code, or null.
export function espnToCanonical(abbr, displayName) {
  if (abbr && ESPN_ABBR_TO_CANON[abbr]) return ESPN_ABBR_TO_CANON[abbr];
  if (abbr && WC_TEAMS[abbr]) return abbr;
  const n = normTeamName(displayName);
  return NAME_TO_CANON[n] || null;
}
