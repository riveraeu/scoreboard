// NHL data fetchers — currently focused on starting-goalie SV% to feed the
// game-total lambda. Team-aggregate GAA (already hydrated inline in
// api/[...path].js as nhl:gaa) treats every goalie as the average; this
// builder identifies each team's primary starter and surfaces their
// season SV% so the lambda can shift toward "tonight's actual goaltender".
//
// Helpers exported:
//   buildNhlGoalieData — { goalieByTeam: {abbr: {starterName, starterId,
//                         starterSV, starterGS, source: "starter"|"team"}},
//                         leagueAvgSV } cached at nhl:goaliepool:2526.
//
// "Source" is "starter" when we have a goalie with >= MIN_STARTS regular-
// season starts; "team" means no qualifying starter and the caller should
// fall back to team GAA. NHL doesn't reliably expose pre-game starting
// goalies via its public endpoints (gamecenter/landing populates near
// puck-drop only), so "starter" here means the team's season-leading
// starter — true ~75%+ of nights in regular season and ~90% in playoffs.

const MIN_STARTS = 5;       // goalie needs at least this many GS for SV% trust
const SEASON = "20252026";  // bumped each season

// NHL Stats API teamId → canonical abbreviation. Derived from the team registry
// (api/lib/teams.js) since 2026-06-11; re-exported here for the historical import path.
// UTA = Utah Mammoth (teamId 68, rebranded from Utah Hockey Club for 2025-26; old
// teamId 53 absent). Add new teamIds to the registry as they appear.
import { NHL_ABBR_MAP } from "./teams.js";
export { NHL_ABBR_MAP };

// Per-goalie season stats. Single REST call covers every qualifying goalie
// in the league, then we pick max-GS per team.
async function fetchGoalieSummary() {
  const url =
    `https://api.nhle.com/stats/rest/en/goalie/summary` +
    `?isAggregate=false&isGame=false` +
    `&sort=%5B%7B%22property%22:%22gamesStarted%22,%22direction%22:%22DESC%22%7D%5D` +
    `&start=0&limit=200` +
    `&cayenneExp=seasonId%3D${SEASON}%20and%20gameTypeId%3D2%20and%20gamesPlayed%3E%3D${MIN_STARTS}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return j.data || [];
}

export async function buildNhlGoalieData(cache) {
  const CACHE_KEY = `nhl:goaliepool:${SEASON}`;
  const CACHE_TTL = 6 * 3600; // 6h
  if (cache) {
    try {
      const hit = await cache.get(CACHE_KEY);
      if (hit) return JSON.parse(hit);
    } catch {}
  }

  const rows = await fetchGoalieSummary();
  const goalieByTeam = {};

  // Pick primary goalie per team = max gamesStarted. teamAbbrevs can be a
  // comma-separated list for mid-season trades; take the last (current) team.
  for (const g of rows) {
    const teams = String(g.teamAbbrevs || "").split(",").map(s => s.trim()).filter(Boolean);
    const team = teams[teams.length - 1];
    if (!team) continue;
    const sv = typeof g.savePct === "number" ? g.savePct : null;
    const gs = typeof g.gamesStarted === "number" ? g.gamesStarted : 0;
    if (sv == null || gs < MIN_STARTS) continue;
    const prev = goalieByTeam[team];
    if (!prev || gs > prev.starterGS) {
      goalieByTeam[team] = {
        starterName: g.goalieFullName || null,
        starterId: g.playerId || null,
        starterSV: parseFloat(sv.toFixed(4)),
        starterGS: gs,
        source: "starter",
      };
    }
  }

  // League-average SV%, weighted by gamesStarted across qualifying goalies.
  let weighted = 0, weights = 0;
  for (const g of rows) {
    const sv = typeof g.savePct === "number" ? g.savePct : null;
    const gs = typeof g.gamesStarted === "number" ? g.gamesStarted : 0;
    if (sv == null || gs < MIN_STARTS) continue;
    weighted += sv * gs;
    weights += gs;
  }
  const leagueAvgSV = weights > 0 ? parseFloat((weighted / weights).toFixed(4)) : 0.905;

  const out = { goalieByTeam, leagueAvgSV };
  if (cache) {
    try { await cache.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: CACHE_TTL }); } catch {}
  }
  return out;
}

// Team-level power-play and penalty-kill rates. Two REST calls (one each for the
// powerplay and penaltykill team-stat groups), keyed by teamId in the NHL Stats API.
// Caller passes a `teamIdToAbbr` map (NHL_ABBR_MAP lives in api/[...path].js).
// Returns:
//   {
//     byTeam: { abbr: { ppPct, pkPct, ppOppPerGame, penaltiesPerGame } },
//     leaguePPPct, leaguePKPct
//   }
// All rates are 0–1. `penaltiesPerGame` here = `timesShorthandedPerGame` (penalties drawn
// against this team, i.e. PP opportunities given to opponents). Cached at
// `nhl:specialteams:{season}` for 6h.
export async function buildNhlSpecialTeams(cache, teamIdToAbbr) {
  const CACHE_KEY = `nhl:specialteams:${SEASON}`;
  const CACHE_TTL = 6 * 3600;
  if (cache) {
    try {
      const hit = await cache.get(CACHE_KEY);
      if (hit) return JSON.parse(hit);
    } catch {}
  }
  const base = `https://api.nhle.com/stats/rest/en/team`;
  const cay = `?cayenneExp=seasonId=${SEASON}%20and%20gameTypeId=2`;
  const [ppRes, pkRes] = await Promise.all([
    fetch(`${base}/powerplay${cay}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }).catch(() => null),
    fetch(`${base}/penaltykill${cay}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }).catch(() => null),
  ]);
  const ppRows = ppRes?.ok ? (await ppRes.json().catch(() => ({}))).data || [] : [];
  const pkRows = pkRes?.ok ? (await pkRes.json().catch(() => ({}))).data || [] : [];

  const byTeam = {};
  let lgPpNum = 0, lgPpDen = 0, lgPkNum = 0, lgPkDen = 0;
  for (const r of ppRows) {
    const abbr = teamIdToAbbr?.[r.teamId];
    if (!abbr) continue;
    const ppPct = typeof r.powerPlayPct === "number" ? r.powerPlayPct : null;
    const ppOpp = typeof r.ppOpportunitiesPerGame === "number" ? r.ppOpportunitiesPerGame : null;
    byTeam[abbr] = byTeam[abbr] || {};
    if (ppPct != null) byTeam[abbr].ppPct = parseFloat(ppPct.toFixed(4));
    if (ppOpp != null) byTeam[abbr].ppOppPerGame = parseFloat(ppOpp.toFixed(3));
    if (ppPct != null && r.ppOpportunities) { lgPpNum += ppPct * r.ppOpportunities; lgPpDen += r.ppOpportunities; }
  }
  for (const r of pkRows) {
    const abbr = teamIdToAbbr?.[r.teamId];
    if (!abbr) continue;
    const pkPct = typeof r.penaltyKillPct === "number" ? r.penaltyKillPct : null;
    const sh   = typeof r.timesShorthandedPerGame === "number" ? r.timesShorthandedPerGame : null;
    byTeam[abbr] = byTeam[abbr] || {};
    if (pkPct != null) byTeam[abbr].pkPct = parseFloat(pkPct.toFixed(4));
    if (sh != null)    byTeam[abbr].penaltiesPerGame = parseFloat(sh.toFixed(3));
    if (pkPct != null && r.timesShorthanded) { lgPkNum += pkPct * r.timesShorthanded; lgPkDen += r.timesShorthanded; }
  }
  const out = {
    byTeam,
    leaguePPPct: lgPpDen > 0 ? parseFloat((lgPpNum / lgPpDen).toFixed(4)) : 0.21,
    leaguePKPct: lgPkDen > 0 ? parseFloat((lgPkNum / lgPkDen).toFixed(4)) : 0.79,
  };
  if (cache && (ppRows.length || pkRows.length)) {
    try { await cache.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: CACHE_TTL }); } catch {}
  }
  return out;
}

// ESPN NHL injury report. Returns Map<teamAbbr, [{name, id, status}]> for Out / GTD players.
// Mirrors buildNbaInjuryReport — ESPN omits athlete.id but embeds it in playercard link href.
// Cached at nhl:injuries:{date} for 1800s (30 min).
export async function buildNhlInjuryReport(cache) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const cacheKey = `nhl:injuries:${date}`;
    if (cache) {
      const cached = await cache.get(cacheKey, "json").catch(() => null);
      if (cached) {
        const m = new Map();
        for (const [k, v] of Object.entries(cached)) m.set(k, v);
        return m;
      }
    }
    const r = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries",
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return new Map();
    const d = await r.json().catch(() => ({}));
    const injMap = {};
    for (const teamEntry of d.injuries || []) {
      const outPlayers = [];
      let abbr = null;
      for (const inj of teamEntry.injuries || []) {
        const statusRaw = (inj.status || "").toLowerCase();
        const isOut = statusRaw === "out";
        const isGtd = statusRaw.includes("day") || statusRaw.includes("game-time") || statusRaw === "questionable" || statusRaw === "doubtful";
        if (!isOut && !isGtd) continue;
        if (!abbr) abbr = inj.athlete?.team?.abbreviation || null;
        const name = inj.athlete?.displayName || "";
        let id = null;
        for (const lk of (inj.athlete?.links || [])) {
          const m = (lk.href || "").match(/\/id\/(\d+)\//);
          if (m) { id = m[1]; break; }
        }
        if (name) outPlayers.push({ name, id, status: isOut ? "out" : "gtd" });
      }
      // ESPN NHL uses short forms (TB/NJ/LA/SJ) on some endpoints. Normalize to canonical.
      const NORM = { TB: "TBL", NJ: "NJD", LA: "LAK", SJ: "SJS" };
      const canon = abbr ? (NORM[abbr] || abbr) : null;
      if (canon && outPlayers.length) injMap[canon] = outPlayers;
    }
    if (cache && Object.keys(injMap).length > 0) {
      await cache.put(cacheKey, JSON.stringify(injMap), { expirationTtl: 1800 }).catch(() => {});
    }
    const m = new Map();
    for (const [k, v] of Object.entries(injMap)) m.set(k, v);
    return m;
  } catch {
    return new Map();
  }
}
