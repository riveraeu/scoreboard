// WNBA data fetchers — modeled on api/lib/nba.js but adapted for WNBA's
// shorter season (~40g vs 82g), smaller league (15 teams vs 30), and the
// fact that ESPN's /teams listing endpoint is broken for WNBA so team IDs
// are hardcoded. 2025 season is the historical anchor; 2026 trust ramps
// at trust26 = min(1, vals26.length / 10).
//
// Helpers exported:
//   buildWnbaPaceData    — pace + OffRtg/DefRtg keyed by canonical abbr
//   buildWnbaUsageRate   — per-player USG% (and avg ast/reb) from ESPN
//   buildWnbaInjuryReport— ESPN injury report (Out + GTD)
//   buildWnbaDvp         — server-side stat-allowed aggregate (option A)
//   WNBA_TEAM_IDS        — canonical abbr → ESPN team id
//   WNBA_ESPN_TO_CANON   — ESPN-returned abbr → canonical (e.g. CONNECTICU→CONN)

// Canonical WNBA abbreviations → ESPN team IDs.
// ESPN's /teams list endpoint is broken for WNBA, so IDs are pinned.
export const WNBA_TEAM_IDS = {
  ATL: 20, CHI: 19, CONN: 18, DAL: 3, GS: 129689,
  IND: 5, LV: 17, LA: 6, MIN: 8, NY: 9,
  PHX: 11, POR: 132052, SEA: 14, TOR: 131935, WSH: 16
};

// ESPN sometimes returns truncated/irregular forms — normalize to canonical
// (used in scoreboard/byteam responses; injuries; gamelogs).
export const WNBA_ESPN_TO_CANON = {
  CONNECTICU: "CONN",
  DALLAS: "DAL",
  WAS: "WSH",
  GSV: "GS",
  // ESPN sometimes uses these short forms for the LA team
  LAS: "LA"
};

// Reverse map (canonical → ESPN scoreboard abbr) for /api/live + team-route URLs.
// Only includes pairs where ESPN's abbr differs from the canonical short.
export const WNBA_CANON_TO_ESPN = {
  CONN: "CONNECTICU",
  DAL: "DALLAS"
};

export async function buildWnbaPaceData(cache, season = 2025) {
  try {
    const hdrs = { "User-Agent": "Mozilla/5.0" };
    const teamPace = {}, teamOffRtg = {}, teamDefRtg = {}, teamAvgPts = {}, teamAvgPtsAllowed = {};
    await Promise.all(Object.entries(WNBA_TEAM_IDS).map(async ([abbr, id]) => {
      try {
        const r = await fetch(
          `https://sports.core.api.espn.com/v2/sports/basketball/leagues/wnba/seasons/${season}/types/2/teams/${id}/statistics`,
          { headers: hdrs, signal: AbortSignal.timeout(6000) }
        );
        if (!r.ok) return;
        const d = await r.json();
        let pace = null, avgPts = null, avgPtsAllowed = null, pPerPoss = null;
        for (const cat of d.splits?.categories || []) {
          for (const s of cat.stats || []) {
            const v = parseFloat(s.value);
            if (s.name === "avgEstimatedPossessions" && v > 0) pace = v;
            if (s.name === "avgPoints" && v > 0) avgPts = v;
            if (s.name === "avgPointsAllowed" && v > 0) avgPtsAllowed = v;
            if (s.name === "pointsPerEstimatedPossessions" && v > 0) pPerPoss = v;
          }
        }
        if (pace != null) teamPace[abbr] = pace;
        if (avgPts != null) teamAvgPts[abbr] = avgPts;
        if (avgPtsAllowed != null) teamAvgPtsAllowed[abbr] = avgPtsAllowed;
        if (pPerPoss != null) {
          teamOffRtg[abbr] = parseFloat((pPerPoss * 100).toFixed(1));
        } else if (avgPts != null && pace != null) {
          teamOffRtg[abbr] = parseFloat((avgPts / pace * 100).toFixed(1));
        }
        if (avgPtsAllowed != null && pace != null) {
          teamDefRtg[abbr] = parseFloat((avgPtsAllowed / pace * 100).toFixed(1));
        }
      } catch {}
    }));
    if (Object.keys(teamPace).length === 0) return null;
    const paces = Object.values(teamPace);
    const leagueAvgPace = paces.reduce((a, b) => a + b, 0) / paces.length;
    const offRtgs = Object.values(teamOffRtg).filter(v => v > 0);
    const leagueAvgOffRtg = offRtgs.length >= 8 ? parseFloat((offRtgs.reduce((a, b) => a + b, 0) / offRtgs.length).toFixed(2)) : 92.7;
    const defRtgs = Object.values(teamDefRtg).filter(v => v > 0);
    const leagueAvgDefRtg = defRtgs.length >= 8 ? parseFloat((defRtgs.reduce((a, b) => a + b, 0) / defRtgs.length).toFixed(2)) : 92.7;
    const ppgs = Object.values(teamAvgPts).filter(v => v > 0);
    const leagueAvgOffPPG = ppgs.length >= 8 ? parseFloat((ppgs.reduce((a, b) => a + b, 0) / ppgs.length).toFixed(2)) : 83.6;
    const result = {
      teamPace, teamOffRtg, teamDefRtg, teamAvgPts, teamAvgPtsAllowed,
      leagueAvgPace: parseFloat(leagueAvgPace.toFixed(2)),
      leagueAvgOffRtg, leagueAvgDefRtg, leagueAvgOffPPG,
      season
    };
    if (cache) await cache.put(`wnba:pace:${season}`, JSON.stringify(result), { expirationTtl: 43200 }).catch(() => {});
    return result;
  } catch (e) {
    console.log("[wnba-pace] error:", String(e));
    return null;
  }
}

// USG% from ESPN per-player stats endpoint. Mirrors buildNbaUsageRate.
export async function buildWnbaUsageRate(playerIds, cache, season = 2025) {
  const hdrs = { "User-Agent": "Mozilla/5.0" };
  const result = {};
  const cacheKeys = playerIds.map(id => `wnba:usg:${id}:${season}`);
  const cached = cache ? await Promise.all(cacheKeys.map(k => cache.get(k, "json").catch(() => null))) : playerIds.map(() => null);
  const toFetch = [];
  for (let i = 0; i < playerIds.length; i++) {
    if (cached[i]) result[String(playerIds[i])] = cached[i];
    else toFetch.push(playerIds[i]);
  }
  await Promise.all(toFetch.map(async id => {
    try {
      const r = await fetch(
        `https://sports.core.api.espn.com/v2/sports/basketball/leagues/wnba/seasons/${season}/types/2/athletes/${id}/statistics`,
        { headers: hdrs, signal: AbortSignal.timeout(6000) }
      );
      if (!r.ok) return;
      const d = await r.json();
      const cats = d.splits?.categories || [];
      let usg = null, avgFGA = 0, avgFTA = 0, avgTO = 0, avgMin = 0, avgAst = 0, avgReb = 0;
      for (const cat of cats) {
        for (const s of cat.stats || []) {
          const v = parseFloat(s.value) || 0;
          if (s.name === "usageRate" && v > 0) usg = v;
          if (s.name === "avgFieldGoalsAttempted") avgFGA = v;
          if (s.name === "avgFreeThrowsAttempted") avgFTA = v;
          if (s.name === "avgTurnovers") avgTO = v;
          if (s.name === "avgMinutes") avgMin = v;
          if (s.name === "avgAssists") avgAst = v;
          if (s.name === "avgRebounds" || s.name === "avgTotalRebounds") avgReb = v;
        }
      }
      const _avgAst = avgAst > 0 ? parseFloat(avgAst.toFixed(1)) : null;
      const _avgReb = avgReb > 0 ? parseFloat(avgReb.toFixed(1)) : null;
      let entry = null;
      if (usg != null) {
        entry = { usg, avgAst: _avgAst, avgReb: _avgReb, source: "espn" };
      } else if (avgMin > 8 && avgFGA > 0) {
        // 40-min game → minutes coefficient is 2.255 × (40/48) = 1.88 vs NBA's 2.255.
        // Using 2.255 directly would inflate WNBA USG by ~20%; rescale to a 40-min game.
        const est = (avgFGA + 0.44 * avgFTA + avgTO) / (avgMin * 1.88) * 100;
        entry = { usg: parseFloat(Math.min(50, Math.max(0, est)).toFixed(1)), avgAst: _avgAst, avgReb: _avgReb, source: "estimated" };
      }
      if (entry) {
        result[String(id)] = entry;
        if (cache) cache.put(`wnba:usg:${id}:${season}`, JSON.stringify(entry), { expirationTtl: 21600 }).catch(() => {});
      }
    } catch {}
  }));
  return result;
}

export async function buildWnbaInjuryReport(cache) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const cacheKey = `wnba:injuries:v2:${date}`;
    if (cache) {
      const cached = await cache.get(cacheKey, "json").catch(() => null);
      if (cached) {
        const m = new Map();
        for (const [k, v] of Object.entries(cached)) m.set(k, v);
        return m;
      }
    }
    const r = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/injuries",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!r.ok) return new Map();
    const d = await r.json();
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
        // ESPN injury endpoint omits athlete.id but embeds it in the playercard link.
        let id = null;
        for (const lk of (inj.athlete?.links || [])) {
          const m = (lk.href || "").match(/\/id\/(\d+)\//);
          if (m) { id = m[1]; break; }
        }
        if (name) outPlayers.push({ name, id, status: isOut ? "out" : "gtd" });
      }
      if (abbr && outPlayers.length) {
        const canon = WNBA_ESPN_TO_CANON[abbr] || abbr;
        injMap[canon] = outPlayers;
      }
    }
    if (cache && Object.keys(injMap).length > 0) {
      await cache.put(cacheKey, JSON.stringify(injMap), { expirationTtl: 1800 }).catch(() => {});
    }
    const m = new Map();
    for (const [k, v] of Object.entries(injMap)) m.set(k, v);
    return m;
  } catch (e) {
    console.log("[wnba-injuries] error:", String(e));
    return new Map();
  }
}

// DVP option A — server-side aggregate. Iterate every team's roster, pull each
// active player's gamelog, normalize by player's per-game average, then group
// by opponent. Result mirrors the NBA all-positions DVP shape but is flat
// (single tier, no per-position split — WNBA has no BettingPros equivalent and
// per-position rotation data isn't reliable from ESPN's depth-chart API).
//
// Cache key: wnba:dvp:{season}:{date}, 12h TTL.
//
// Output shape:
//   { rankings: { points: [{abbr, avgPts, ratio, gp, rank}, ...], rebounds: [...], assists: [...], threePointers: [...] },
//     softTeams: { points: ["ATL", ...], rebounds: [...], ... },
//     leagueAvg: { pts, reb, ast, tpm },
//     builtAt: iso }
export async function buildWnbaDvp(cache, season = 2025) {
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const cacheKey = `wnba:dvp:${season}:${dateStr}`;
    if (cache) {
      const cached = await cache.get(cacheKey, "json").catch(() => null);
      if (cached) return cached;
    }
    const hdrs = { "User-Agent": "Mozilla/5.0" };
    // Step 1: collect 8 most-played athlete IDs per team from current roster
    const teamIds = Object.entries(WNBA_TEAM_IDS);
    const rosters = await Promise.all(teamIds.map(async ([abbr, id]) => {
      try {
        const r = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/${id}/roster`,
          { headers: hdrs, signal: AbortSignal.timeout(6000) }
        );
        if (!r.ok) return { abbr, athletes: [] };
        const d = await r.json();
        const athletes = (d.athletes || []).map(a => a.id).filter(Boolean).slice(0, 10);
        return { abbr, athletes };
      } catch { return { abbr, athletes: [] }; }
    }));
    const allPlayerIds = [...new Set(rosters.flatMap(r => r.athletes))];
    // Step 2: fetch each player's prior-season gamelog (season anchor — 2025
    // is the most-complete signal available when 2026 season just started)
    const PARALLEL = 12;
    const playerData = {};
    for (let off = 0; off < allPlayerIds.length; off += PARALLEL) {
      const batch = allPlayerIds.slice(off, off + PARALLEL);
      const results = await Promise.all(batch.map(async id => {
        try {
          const r = await fetch(
            `https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/${id}/gamelog?season=${season}`,
            { headers: hdrs, signal: AbortSignal.timeout(6000) }
          );
          if (!r.ok) return null;
          const d = await r.json();
          const ul = (d.labels || []).map(l => (l || "").toUpperCase());
          const ptsIdx = ul.indexOf("PTS");
          const rebIdx = ul.indexOf("REB");
          const astIdx = ul.indexOf("AST");
          const tpmIdx = ul.indexOf("3PT");
          if (ptsIdx < 0) return null;
          const reg = (d.seasonTypes || []).find(st => st.displayName?.toLowerCase().includes("regular")) || d.seasonTypes?.[0];
          const seen = new Set();
          const events = [];
          for (const cat of reg?.categories || []) {
            for (const ev of cat.events || []) {
              if (seen.has(ev.eventId)) continue;
              const meta = d.events?.[ev.eventId];
              if (!meta || meta.opponent?.isAllStar) continue;
              seen.add(ev.eventId);
              events.push({ meta, stats: ev.stats || [] });
            }
          }
          if (events.length < 15) return null;
          const sumPts = events.reduce((s, e) => s + (parseFloat(e.stats[ptsIdx]) || 0), 0);
          if (sumPts / events.length < 5) return null;
          return { id, ptsIdx, rebIdx, astIdx, tpmIdx, events };
        } catch { return null; }
      }));
      for (const r of results) {
        if (r) playerData[r.id] = r;
      }
    }
    // Step 3: aggregate stat-allowed per opponent, normalized by player's own avg
    const teamDvp = {};
    const totalRaw = { pts: 0, reb: 0, ast: 0, tpm: 0, n: 0 };
    for (const { ptsIdx, rebIdx, astIdx, tpmIdx, events } of Object.values(playerData)) {
      const sumPts = events.reduce((s, e) => s + (parseFloat(e.stats[ptsIdx]) || 0), 0);
      const pAvg = {
        pts: sumPts / events.length,
        reb: rebIdx >= 0 ? events.reduce((s, e) => s + (parseFloat(e.stats[rebIdx]) || 0), 0) / events.length : 1,
        ast: astIdx >= 0 ? events.reduce((s, e) => s + (parseFloat(e.stats[astIdx]) || 0), 0) / events.length : 1,
        tpm: tpmIdx >= 0 ? events.reduce((s, e) => s + (parseInt(String(e.stats[tpmIdx]).split("-")[0]) || 0), 0) / events.length : 1
      };
      if (pAvg.reb < 0.5) pAvg.reb = 0.5;
      if (pAvg.ast < 0.5) pAvg.ast = 0.5;
      if (pAvg.tpm < 0.1) pAvg.tpm = 0.1;
      for (const { meta, stats } of events) {
        const rawOpp = meta.opponent?.abbreviation || "";
        if (!rawOpp) continue;
        const opp = WNBA_ESPN_TO_CANON[rawOpp] || rawOpp;
        const pts = parseFloat(stats[ptsIdx]) || 0;
        const reb = rebIdx >= 0 ? parseFloat(stats[rebIdx]) || 0 : 0;
        const ast = astIdx >= 0 ? parseFloat(stats[astIdx]) || 0 : 0;
        const tpm = tpmIdx >= 0 ? parseInt(String(stats[tpmIdx]).split("-")[0]) || 0 : 0;
        if (pts === 0 && reb === 0 && ast === 0) continue;
        if (!teamDvp[opp]) teamDvp[opp] = { pts: [], reb: [], ast: [], tpm: [] };
        teamDvp[opp].pts.push(pts / pAvg.pts);
        teamDvp[opp].reb.push(reb / pAvg.reb);
        teamDvp[opp].ast.push(ast / pAvg.ast);
        teamDvp[opp].tpm.push(tpm / pAvg.tpm);
        totalRaw.pts += pts; totalRaw.reb += reb; totalRaw.ast += ast; totalRaw.tpm += tpm; totalRaw.n++;
      }
    }
    const leagueAvg = totalRaw.n > 0
      ? { pts: totalRaw.pts / totalRaw.n, reb: totalRaw.reb / totalRaw.n, ast: totalRaw.ast / totalRaw.n, tpm: totalRaw.tpm / totalRaw.n }
      : { pts: 9, reb: 4, ast: 2.5, tpm: 0.8 };
    const STAT_KEYS = { points: "pts", rebounds: "reb", assists: "ast", threePointers: "tpm" };
    const rankings = {}, softTeams = {};
    for (const [stat, key] of Object.entries(STAT_KEYS)) {
      const la = leagueAvg[key] || 1;
      const teamRanks = [];
      for (const [abbr, data] of Object.entries(teamDvp)) {
        const vals = data[key] || [];
        if (vals.length < 5) continue;
        const ratio = vals.reduce((a, b) => a + b, 0) / vals.length;
        teamRanks.push({ abbr, avgPts: parseFloat((ratio * la).toFixed(2)), ratio: parseFloat(ratio.toFixed(3)), gp: vals.length });
      }
      teamRanks.sort((a, b) => b.ratio - a.ratio);
      teamRanks.forEach((t, i) => t.rank = i + 1);
      rankings[stat] = teamRanks;
      const soft = teamRanks.filter(t => t.ratio >= 1.05).map(t => t.abbr);
      softTeams[stat] = soft.length >= 3 ? soft : teamRanks.slice(0, 5).map(t => t.abbr);
    }
    const result = { rankings, softTeams, leagueAvg, season, builtAt: new Date().toISOString() };
    if (cache) await cache.put(cacheKey, JSON.stringify(result), { expirationTtl: 43200 }).catch(() => {});
    return result;
  } catch (e) {
    console.log("[wnba-dvp] error:", String(e));
    return null;
  }
}
