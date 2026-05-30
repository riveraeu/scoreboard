// Response helpers, CORS, and team ranking utilities.

export const ALLOWED_ORIGIN = "*";

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

export function jsonResponse(data, opts = false) {
  const headers = { "Content-Type": "application/json", ...corsHeaders() };
  if (opts === true) headers["Cache-Control"] = "no-store";
  else if (typeof opts === "number" && opts > 0) headers["Cache-Control"] = `public, max-age=${opts}`;
  return new Response(JSON.stringify(data), { headers });
}

export function errorResponse(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

// Fetch with named error logging. Returns {} on any failure so callers get graceful
// degradation without silently swallowing the root cause.
export function fetchSafe(label, url, opts) {
  return fetch(url, opts)
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .catch(e => { console.error(`[${label}]`, e?.message ?? String(e), url.slice(0, 120)); return {}; });
}

// JSON response that also sets an HttpOnly cookie (used by auth login/register/logout).
export function cookieResponse(data, cookie) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...corsHeaders(), "Set-Cookie": cookie },
  });
}

// Maps NBA stat name → ESPN byteam category hint and value index.
export const SOFT_TEAM_METRIC = {
  points: { hint: "opponent offensive", idx: 0, label: "PPG allowed", unit: "PPG" },
  rebounds: { hint: "opponent general", idx: 1, label: "REB allowed/game", unit: "REB" },
  assists: { hint: "opponent offensive", idx: 13, label: "AST allowed/game", unit: "AST" },
  threePointers: { hint: "opponent offensive", idx: 8, label: "3PM allowed/game", unit: "3PM" }
};

export function parseGameOdds(events) {
  const gameOdds = {};
  for (const event of events || []) {
    for (const comp of event.competitions || []) {
      const odds = (comp.odds || [])[0];
      if (!odds) continue;
      const total = odds.overUnder != null ? parseFloat(odds.overUnder) : null;
      const homeMLRaw = odds.moneyline?.home?.close?.odds ?? odds.homeTeamOdds?.moneyLine ?? null;
      const awayMLRaw = odds.moneyline?.away?.close?.odds ?? odds.awayTeamOdds?.moneyLine ?? null;
      const homeML = homeMLRaw != null ? parseInt(homeMLRaw) : null;
      const awayML = awayMLRaw != null ? parseInt(awayMLRaw) : null;
      // C3: Extract spread (signed from each team's perspective: negative = favored)
      const spreadRaw = odds.spread ?? odds.homeTeamOdds?.spreadLine ?? null;
      const homeSpread = spreadRaw != null ? parseFloat(spreadRaw) : null;
      const awaySpread = homeSpread != null ? -homeSpread : null;
      for (const competitor of comp.competitors || []) {
        const abbr = competitor.team?.abbreviation;
        if (!abbr) continue;
        const ml = competitor.homeAway === "home" ? homeML : awayML;
        const spread = competitor.homeAway === "home" ? homeSpread : awaySpread;
        gameOdds[abbr] = { total, moneyline: ml, spread };
      }
    }
  }
  return gameOdds;
}

// Extract live/final scores from ESPN scoreboard events.
// normFn maps raw ESPN abbreviations to the canonical form (e.g. GS→GSW).
export function parseGameScores(events, normFn) {
  const scores = {};
  const ptFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
  for (const event of events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const homeComp = (comp.competitors || []).find(c => c.homeAway === "home");
    const awayComp = (comp.competitors || []).find(c => c.homeAway === "away");
    if (!homeComp || !awayComp) continue;
    const hA = normFn ? normFn(homeComp.team?.abbreviation) : homeComp.team?.abbreviation;
    const awA = normFn ? normFn(awayComp.team?.abbreviation) : awayComp.team?.abbreviation;
    if (!hA || !awA) continue;
    const gameDate = event.date ? ptFmt.format(new Date(event.date)) : null;
    const pickRecord = (recs) => {
      if (!Array.isArray(recs)) return null;
      const overall = recs.find(r => r?.type === "total" || r?.name === "overall");
      return overall?.summary ?? recs[0]?.summary ?? null;
    };
    // Key includes gameDate so today and tomorrow's same-home-team games don't collide,
    // and event.date (full ISO) so same-day doubleheaders (e.g. DET @ BAL twice) don't either.
    scores[`${hA}|${gameDate ?? ""}|${event.date ?? ""}`] = {
      homeTeam: hA, awayTeam: awA,
      state: comp.status?.type?.state ?? "pre",
      detail: comp.status?.type?.shortDetail || comp.status?.type?.detail || "",
      homeScore: parseInt(homeComp.score ?? 0) || 0,
      awayScore: parseInt(awayComp.score ?? 0) || 0,
      gameDate,
      gameTime: event.date || null,
      seriesSummary: comp.series?.summary || null,
      homeRecord: pickRecord(homeComp.records),
      awayRecord: pickRecord(awayComp.records),
      // ESPN convention: 1=preseason, 2=regular, 3=postseason. Captured for calibration
      // splits — lets /api/auth/calibration filter or bucket plays by season type. Null
      // when ESPN omits it (rare).
      seasonType: event.season?.type ?? null,
    };
  }
  return scores;
}

// Extract a "top player" per team from ESPN scoreboard competitors[].leaders.
// NBA/WNBA: use RAT (Rating) leader; parse displayValue ("X PPG, Y RPG, Z APG, ...") into "X PPG · Y RPG · Z APG".
// NHL: no RAT; use Points leader and derive G/A from same-player Goals leader entry when available.
// Returns { abbr → { name, id, headshot, stats } }. normFn maps raw ESPN abbreviations to canonical.
export function parseTopPlayers(events, normFn, sport) {
  const result = {};
  const cdnLeague = sport === "wnba" ? "wnba" : sport === "nhl" ? "nhl" : "nba";
  for (const event of events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    for (const c of (comp.competitors || [])) {
      const rawAbbr = c.team?.abbreviation;
      const abbr = normFn ? normFn(rawAbbr) : rawAbbr;
      if (!abbr) continue;
      const leaders = c.leaders || [];
      let entry = null;
      if (sport === "nba" || sport === "wnba") {
        const rat = leaders.find(l => (l.shortDisplayName || l.name) === "RAT") || leaders.find(l => /rating/i.test(l.displayName || ""));
        const top = rat?.leaders?.[0];
        if (!top?.athlete) continue;
        const dv = top.displayValue || "";
        // Pull leading numeric values for PPG/RPG/APG; skip anything beyond.
        const pick = (label) => {
          const m = dv.match(new RegExp(`([0-9]+(?:\\.[0-9])?)\\s*${label}`, "i"));
          return m ? m[1] : null;
        };
        const ppg = pick("PPG"), rpg = pick("RPG"), apg = pick("APG");
        const parts = [ppg && `${ppg} PPG`, rpg && `${rpg} RPG`, apg && `${apg} APG`].filter(Boolean);
        entry = {
          name: top.athlete.displayName || top.athlete.fullName || null,
          id: top.athlete.id || null,
          headshot: top.athlete.headshot?.href || (top.athlete.id ? `https://a.espncdn.com/i/headshots/${cdnLeague}/players/full/${top.athlete.id}.png` : null),
          stats: parts.length ? parts.join(" · ") : null,
        };
      } else if (sport === "nhl") {
        const pts = leaders.find(l => /^points$/i.test(l.displayName || "") || (l.shortDisplayName || "").toLowerCase() === "points");
        const top = pts?.leaders?.[0];
        if (!top?.athlete) continue;
        const pVal = parseInt(top.displayValue, 10);
        // Derive the other leg from whichever same-athlete category we can find.
        const goals = leaders.find(l => /^goals$/i.test(l.displayName || ""));
        const assists = leaders.find(l => /^assists$/i.test(l.displayName || ""));
        const gTop = goals?.leaders?.[0];
        const aTop = assists?.leaders?.[0];
        let gVal = null, aVal = null;
        if (gTop?.athlete?.id === top.athlete.id) {
          gVal = parseInt(gTop.displayValue, 10);
          if (!isNaN(gVal) && !isNaN(pVal)) aVal = pVal - gVal;
        } else if (aTop?.athlete?.id === top.athlete.id) {
          aVal = parseInt(aTop.displayValue, 10);
          if (!isNaN(aVal) && !isNaN(pVal)) gVal = pVal - aVal;
        }
        const parts = [
          gVal != null && !isNaN(gVal) ? `${gVal} G` : null,
          aVal != null && !isNaN(aVal) ? `${aVal} A` : null,
          !isNaN(pVal) ? `${pVal} PTS` : null,
        ].filter(Boolean);
        entry = {
          name: top.athlete.displayName || top.athlete.fullName || null,
          id: top.athlete.id || null,
          headshot: top.athlete.headshot?.href || (top.athlete.id ? `https://a.espncdn.com/i/headshots/${cdnLeague}/players/full/${top.athlete.id}.png` : null),
          stats: parts.length ? parts.join(" · ") : null,
        };
      }
      if (entry?.name) result[abbr] = entry;
    }
  }
  return result;
}

export function buildSoftTeamAbbrs(teams, stat = "points", n = 10) {
  try {
    const { hint, idx } = SOFT_TEAM_METRIC[stat] || SOFT_TEAM_METRIC.points;
    const getCatVal = (team) => {
      const cat = (team.categories || []).find((c) => c.displayName?.toLowerCase().includes(hint));
      return parseFloat(cat?.values?.[idx] ?? 0);
    };
    return [...teams].sort((a, b) => getCatVal(b) - getCatVal(a)).slice(0, n).map((t) => t.team?.abbreviation).filter(Boolean);
  } catch {
    return [];
  }
}

export function buildHardTeamAbbrs(teams, stat = "points") {
  try {
    const { hint, idx } = SOFT_TEAM_METRIC[stat] || SOFT_TEAM_METRIC.points;
    const getCatVal = (team) => {
      const cat = (team.categories || []).find((c) => c.displayName?.toLowerCase().includes(hint));
      return parseFloat(cat?.values?.[idx] ?? 0);
    };
    const vals = teams.map(getCatVal).filter((v) => v > 0);
    if (!vals.length) return [];
    const leagueAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return teams.filter((t) => getCatVal(t) / leagueAvg <= 0.95).map((t) => t.team?.abbreviation).filter(Boolean);
  } catch {
    return [];
  }
}

export function buildTeamRankMap(teams, stat = "points") {
  const { hint, idx, label, unit } = SOFT_TEAM_METRIC[stat] || SOFT_TEAM_METRIC.points;
  const getCatVal = (team) => {
    const cat = (team.categories || []).find((c) => c.displayName?.toLowerCase().includes(hint));
    return parseFloat(cat?.values?.[idx] ?? 0);
  };
  const map = {};
  [...teams].sort((a, b) => getCatVal(b) - getCatVal(a)).forEach((t, i) => {
    const abbr = t.team?.abbreviation;
    if (abbr) map[abbr] = { rank: i + 1, value: parseFloat(getCatVal(t).toFixed(1)), label, unit };
  });
  return map;
}
