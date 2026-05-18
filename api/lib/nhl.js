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
