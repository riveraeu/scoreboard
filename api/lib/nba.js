// NBA/DVP data fetchers: depth charts, pace, DvP builders, player cache warmer.

// Only map unambiguous ESPN roster position abbreviations to 5-pos DvP keys.
// "G" and "F" are omitted — ESPN uses these generically and we can't distinguish
// PG from SG or SF from PF, so we skip them rather than guess wrong.
const _ROSTER_POS_MAP = {
  "C": "C",
  "C/PF": "C",
  "PF/C": "C",
  "PF": "PF",
  "PF/SF": "PF",
  "SF": "SF",
  "SF/PF": "SF",
  "SF/SG": "SF",
  "SG": "SG",
  "SG/SF": "SG",
  "SG/PG": "SG",
  "PG": "PG",
  "PG/SG": "PG"
};

const _GL_TEAM_NORM = {
  "GS": "GSW",
  "SA": "SAS",
  "NY": "NYK",
  "NJ": "BKN",
  "NO": "NOP",
  "PHO": "PHX",
  "UTAH": "UTA"
};

export async function warmPlayerInfoCache(cache) {
  if (!cache) return;
  const SERIES = ["KXNBAPTS", "KXNBAREB", "KXNBAAST", "KXNBA3PT", "KXNHLPTS", "KXMLBHITS", "KXMLBHRR", "KXMLBKS"];
  const SERIES_SPORT = { KXNBAPTS: "nba", KXNBAREB: "nba", KXNBAAST: "nba", KXNBA3PT: "nba", KXNHLPTS: "nhl", KXMLBHITS: "mlb", KXMLBHRR: "mlb", KXMLBKS: "mlb" };
  const hdrs = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://www.espn.com/", "Accept": "application/json" };
  const playerKeys = new Set();
  for (const ticker of SERIES) {
    try {
      const url = `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${ticker}&limit=1000&status=open`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
      if (!r.ok) continue;
      const data = await r.json();
      const sport = SERIES_SPORT[ticker];
      for (const m of data.markets || []) {
        const raw = m.event_title || m.title || "";
        let name = raw.replace(/\s*:\s*\d.*$/, "").replace(/\s+(Points?|Rebounds?|Assists?|3-Pointers?|Goals?|Shots on Goal|Hits?|Home Runs?|Strikeouts?|Total Bases?)\b.*/i, "").replace(/\s+Over\s+\d.*$/i, "").replace(/\s*\(.*\)\s*$/, "").trim();
        if (!name || name.length < 4) continue;
        name = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        playerKeys.add(`${sport}|${name}`);
      }
      await new Promise((res) => setTimeout(res, 200));
    } catch {
    }
  }
  for (const key of playerKeys) {
    try {
      const existing = await cache.get(`pinfo:${key}`, "json");
      if (existing?.id && existing.position !== null) continue;
      if (existing?.id && !key.startsWith("nba|")) continue;
      const [sport, ...parts] = key.split("|");
      const playerName = parts.join("|");
      const r = await fetch(`https://site.web.api.espn.com/apis/search/v2?query=${encodeURIComponent(playerName)}&lang=en&region=us&limit=5&type=player`, { headers: hdrs });
      if (!r.ok) {
        await new Promise((res) => setTimeout(res, 300));
        continue;
      }
      const d = await r.json();
      const players = (d.results?.find((x) => x.type === "player")?.contents || []).filter((p2) => p2.defaultLeagueSlug === sport);
      if (!players.length) continue;
      const p = players[0];
      const id = p.uid?.split("~a:")?.[1];
      if (!id) continue;
      const posMatch = (p.description || p.subtitle || "").match(/\b(QB|RB|WR|TE|PG|SG|SF|PF|Center|Forward|Guard|C|G|F|SP|RP|OF|1B|2B|3B|SS|LW|RW|D)\b/i);
      const rawPos = posMatch ? posMatch[1].toUpperCase() : null;
      const POS_NORM = { CENTER: "C", FORWARD: "F", GUARD: "G" };
      await cache.put(`pinfo:${key}`, JSON.stringify({ id, teamAbbr: "", position: rawPos ? POS_NORM[rawPos] || rawPos : null }), { expirationTtl: 604800 });
      await new Promise((res) => setTimeout(res, 200));
    } catch {
    }
  }
}

export async function buildNbaDvpStage1(cache) {
  try {
    const hdrs = { "User-Agent": "Mozilla/5.0" };
    const teamsRes = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=32", { headers: hdrs });
    if (!teamsRes.ok) {
      console.log("[dvp-s1] teams fetch failed:", teamsRes.status);
      return null;
    }
    const teamsData = await teamsRes.json();
    const nbaTeams = (teamsData.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team);
    if (!nbaTeams.length) {
      console.log("[dvp-s1] no teams");
      return null;
    }
    const rosterResults = await Promise.all(
      nbaTeams.map(
        (t) => fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${t.id}/roster`, { headers: hdrs }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
      )
    );
    const posMap = {};
    const selectedByPos = { PG: [], SG: [], SF: [], PF: [], C: [] };
    for (let i = 0; i < nbaTeams.length; i++) {
      const athletes = rosterResults[i]?.athletes || [];
      const byPos = { PG: [], SG: [], SF: [], PF: [], C: [] };
      for (const athlete of athletes) {
        const pos = _ROSTER_POS_MAP[athlete.position?.abbreviation || ""];
        if (!pos || !athlete.id) continue;
        posMap[String(athlete.id)] = pos;
        if (byPos[pos].length < 2) byPos[pos].push(String(athlete.id));
      }
      for (const pos of Object.keys(selectedByPos)) selectedByPos[pos].push(...byPos[pos]);
    }
    const payload = { ...selectedByPos, builtAt: new Date().toISOString() };
    if (cache) {
      await cache.put("dvp:nba:selected-players", JSON.stringify(payload), { expirationTtl: 9e4 }).catch(() => {
      });
      await cache.put("dvp:nba:player-positions", JSON.stringify(posMap), { expirationTtl: 86400 }).catch(() => {
      });
    }
    return payload;
  } catch (e) {
    console.log("[dvp-s1] error:", String(e));
    return null;
  }
}

async function _fetchAndAggregateDvp(playerIds) {
  const hdrs = { "User-Agent": "Mozilla/5.0" };
  const glUrl = (id) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog?season=2026`;
  const results = await Promise.all(
    playerIds.map(
      (id) => fetch(glUrl(id), { headers: hdrs }).then((r) => r.ok ? r.json() : null).catch(() => null)
    )
  );
  const teamDvp = {};
  const totalRaw = { pts: 0, reb: 0, ast: 0, tpm: 0, n: 0 };
  for (const d of results) {
    if (!d) continue;
    const ul = (d.labels || []).map((l) => (l || "").toUpperCase());
    const ptsIdx = ul.indexOf("PTS");
    const rebIdx = ul.indexOf("REB");
    const astIdx = ul.indexOf("AST");
    const tpmIdx = ul.indexOf("3PT");
    if (ptsIdx < 0) continue;
    const reg = (d.seasonTypes || []).find((st) => st.displayName?.toLowerCase().includes("regular")) || d.seasonTypes?.[0];
    const seenIds = new Set();
    const allEvents = [];
    for (const cat of reg?.categories || []) {
      for (const ev of cat.events || []) {
        if (seenIds.has(ev.eventId)) continue;
        const meta = d.events?.[ev.eventId];
        if (!meta || meta.opponent?.isAllStar) continue;
        seenIds.add(ev.eventId);
        allEvents.push({ meta, stats: ev.stats || [] });
      }
    }
    if (allEvents.length < 35) continue;
    const sumPts = allEvents.reduce((s, e) => s + (parseFloat(e.stats[ptsIdx]) || 0), 0);
    if (sumPts / allEvents.length < 7) continue;
    const pAvg = {
      pts: sumPts / allEvents.length,
      reb: rebIdx >= 0 ? allEvents.reduce((s, e) => s + (parseFloat(e.stats[rebIdx]) || 0), 0) / allEvents.length : 1,
      ast: astIdx >= 0 ? allEvents.reduce((s, e) => s + (parseFloat(e.stats[astIdx]) || 0), 0) / allEvents.length : 1,
      tpm: tpmIdx >= 0 ? allEvents.reduce((s, e) => s + (parseInt(String(e.stats[tpmIdx]).split("-")[0]) || 0), 0) / allEvents.length : 1
    };
    if (pAvg.reb < 0.5) pAvg.reb = 0.5;
    if (pAvg.ast < 0.5) pAvg.ast = 0.5;
    if (pAvg.tpm < 0.1) pAvg.tpm = 0.1;
    for (const { meta, stats } of allEvents) {
      const rawOpp = meta.opponent?.abbreviation || "";
      if (!rawOpp) continue;
      const opp = _GL_TEAM_NORM[rawOpp] || rawOpp;
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
      totalRaw.pts += pts;
      totalRaw.reb += reb;
      totalRaw.ast += ast;
      totalRaw.tpm += tpm;
      totalRaw.n++;
    }
  }
  const leagueAvg = totalRaw.n > 0 ? { pts: totalRaw.pts / totalRaw.n, reb: totalRaw.reb / totalRaw.n, ast: totalRaw.ast / totalRaw.n, tpm: totalRaw.tpm / totalRaw.n } : { pts: 10, reb: 5, ast: 3, tpm: 1 };
  return { teamDvp, leagueAvg };
}

function _buildPosRankings({ teamDvp, leagueAvg }) {
  const STAT_KEYS = { points: "pts", rebounds: "reb", assists: "ast", threePointers: "tpm" };
  const rankings = {};
  for (const [stat, key] of Object.entries(STAT_KEYS)) {
    const la = leagueAvg[key] || 1;
    const teamRanks = [];
    for (const [abbr, data] of Object.entries(teamDvp)) {
      const vals = data[key] || [];
      if (vals.length < 5) continue;
      const avgRatio = vals.reduce((a, b) => a + b, 0) / vals.length;
      teamRanks.push({ abbr, avgPts: parseFloat((avgRatio * la).toFixed(2)), ratio: parseFloat(avgRatio.toFixed(3)), gp: vals.length });
    }
    teamRanks.sort((a, b) => b.ratio - a.ratio);
    teamRanks.forEach((t, i) => t.rank = i + 1);
    rankings[stat] = teamRanks;
  }
  const softTeams = Object.fromEntries(
    Object.entries(rankings).map(([stat, ranked]) => {
      const soft = ranked.filter((t) => t.ratio >= 1.05).map((t) => t.abbr);
      return [stat, soft.length >= 5 ? soft : ranked.slice(0, 5).map((t) => t.abbr)];
    })
  );
  return { rankings, softTeams };
}

export async function buildNbaDvpFromBettingPros(cache) {
  try {
    let buildBpRankings = function(teamVals) {
      const rankings = {};
      for (const stat of Object.keys(BP_STAT_MAP)) {
        const allVals = Object.values(teamVals).map((v) => v[stat]).filter((v) => v != null && !isNaN(v));
        if (!allVals.length) continue;
        const leagueAvg = allVals.reduce((a, b) => a + b, 0) / allVals.length;
        const teamRanks = [];
        for (const [abbr, vals] of Object.entries(teamVals)) {
          const v = vals[stat];
          if (v == null || isNaN(v)) continue;
          const ratio = leagueAvg > 0 ? v / leagueAvg : 1;
          teamRanks.push({ abbr, avgPts: parseFloat(v.toFixed(2)), ratio: parseFloat(ratio.toFixed(3)), gp: avgGamesPlayed });
        }
        teamRanks.sort((a, b) => b.ratio - a.ratio);
        teamRanks.forEach((t, idx) => t.rank = idx + 1);
        rankings[stat] = teamRanks;
      }
      const softTeams = Object.fromEntries(
        Object.entries(rankings).map(([stat, ranked]) => {
          const soft = ranked.filter((t) => t.ratio >= 1.05).map((t) => t.abbr);
          return [stat, soft.length >= 5 ? soft : ranked.slice(0, 5).map((t) => t.abbr)];
        })
      );
      return { rankings, softTeams };
    };
    const hdrs = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    };
    const res = await fetch("https://www.bettingpros.com/nba/defense-vs-position/", { headers: hdrs });
    if (!res.ok) {
      console.log("[dvp-bp] fetch failed:", res.status);
      return null;
    }
    const html = await res.text();
    const varIdx = html.indexOf("bpDefenseVsPositionStats");
    if (varIdx < 0) {
      console.log("[dvp-bp] bpDefenseVsPositionStats not found in HTML");
      return null;
    }
    const snippet = html.slice(varIdx, varIdx + 300);
    const gpMatch = snippet.match(/avgGamesPlayed\s*:\s*(\d+)/);
    const avgGamesPlayed = gpMatch ? parseInt(gpMatch[1]) : 82;
    const tsIdx = html.indexOf("teamStats:", varIdx);
    if (tsIdx < 0) {
      console.log("[dvp-bp] teamStats not found");
      return null;
    }
    const tsStart = html.indexOf("{", tsIdx);
    if (tsStart < 0) {
      console.log("[dvp-bp] teamStats brace not found");
      return null;
    }
    let depth = 0, i = tsStart;
    for (; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") {
        if (--depth === 0) break;
      }
    }
    let teamStats;
    try {
      teamStats = JSON.parse(html.slice(tsStart, i + 1));
    } catch (e) {
      console.log("[dvp-bp] JSON parse failed:", String(e));
      return null;
    }
    if (!teamStats || !Object.keys(teamStats).length) {
      console.log("[dvp-bp] no teamStats in response");
      return null;
    }
    const _BP_TEAM_NORM = { WAS: "WSH", NOR: "NOP", UTH: "UTA", PHO: "PHX", SA: "SAS", GS: "GSW", NY: "NYK", NO: "NOP" };
    const normalizeTeam = (abbr) => _BP_TEAM_NORM[abbr] || abbr;
    const BP_STAT_MAP = { points: "points", rebounds: "rebounds", assists: "assists", threePointers: "three_points_made" };
    const BP_POSITIONS = ["PG", "SG", "SF", "PF", "C"];
    const posData = {};
    for (const pos of BP_POSITIONS) posData[pos] = {};
    for (const [rawAbbr, positions] of Object.entries(teamStats)) {
      const teamAbbr = normalizeTeam(rawAbbr);
      for (const pos of BP_POSITIONS) {
        const pd = positions[pos];
        if (!pd) continue;
        const vals = {};
        for (const [ourKey, bpKey] of Object.entries(BP_STAT_MAP)) {
          const v = parseFloat(pd[bpKey]);
          if (!isNaN(v)) vals[ourKey] = v;
        }
        if (Object.keys(vals).length) posData[pos][teamAbbr] = vals;
      }
    }
    const finalResult = {
      builtAt: new Date().toISOString(),
      source: "bettingpros",
      PG: buildBpRankings(posData.PG),
      SG: buildBpRankings(posData.SG),
      SF: buildBpRankings(posData.SF),
      PF: buildBpRankings(posData.PF),
      C: buildBpRankings(posData.C)
    };
    if (cache) await cache.put("dvp:nba:all-positions", JSON.stringify(finalResult), { expirationTtl: 86400 }).catch(() => {
    });
    return finalResult;
  } catch (e) {
    console.log("[dvp-bp] error:", String(e));
    return null;
  }
}

export async function buildNbaDepthChartPos(cache) {
  try {
    const hdrs = { "User-Agent": "Mozilla/5.0" };
    const teamsRes = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=32", { headers: hdrs });
    if (!teamsRes.ok) return null;
    const teamsData = await teamsRes.json();
    const teams = (teamsData.sports?.[0]?.leagues?.[0]?.teams || []).map(t => t.team);
    const POS_VALID = new Set(["PG","SG","SF","PF","C"]);
    const idToPos = {};
    await Promise.all(teams.map(async t => {
      try {
        const r = await fetch(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/teams/${t.id}/depthcharts`, { headers: hdrs });
        if (!r.ok) return;
        const d = await r.json();
        const item = d.items?.[0];
        if (!item) return;
        // Sort C→PF→SF→SG→PG so first write wins (prefer the "bigger" position for dual-listed players)
        const POS_ORDER = ["C","PF","SF","SG","PG"];
        const sortedPositions = Object.values(item.positions || {}).sort((a, b) =>
          POS_ORDER.indexOf(a.position?.abbreviation?.toUpperCase()) - POS_ORDER.indexOf(b.position?.abbreviation?.toUpperCase())
        );
        for (const posData of sortedPositions) {
          const posAbbr = posData.position?.abbreviation?.toUpperCase();
          if (!POS_VALID.has(posAbbr)) continue;
          for (const a of posData.athletes || []) {
            const id = a.athlete?.id || (a.athlete?.["$ref"] || "").split("/").pop().split("?")[0];
            if (id && !idToPos[String(id)]) idToPos[String(id)] = posAbbr;
          }
        }
      } catch {}
    }));
    if (cache && Object.keys(idToPos).length > 0) {
      await cache.put("dvp:nba:depth-chart-pos", JSON.stringify(idToPos), { expirationTtl: 86400 }).catch(() => {});
    }
    return idToPos;
  } catch (e) {
    console.log("[depth-chart-pos] error:", String(e));
    return null;
  }
}

export async function buildNbaPaceData(cache) {
  try {
    const hdrs = { "User-Agent": "Mozilla/5.0" };
    // Step 1: get all 30 teams (id + abbreviation)
    const teamsRes = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=32", { headers: hdrs });
    if (!teamsRes.ok) return null;
    const teamsData = await teamsRes.json();
    const teams = (teamsData.sports?.[0]?.leagues?.[0]?.teams || []).map(t => t.team);
    // Step 2: fetch team stats in parallel — extract paceFactor + avgPoints to derive OffRtg
    // ESPN doesn't expose offensiveRating/defensiveRating directly; derive OffRtg = avgPoints / paceFactor * 100
    const teamPace = {}, teamOffRtg = {};
    await Promise.all(teams.map(async t => {
      try {
        const r = await fetch(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/types/2/teams/${t.id}/statistics`, { headers: hdrs });
        if (!r.ok) return;
        const d = await r.json();
        let pace = null, avgPts = null;
        for (const cat of d.splits?.categories || []) {
          for (const s of cat.stats || []) {
            if (s.name === "paceFactor" && s.value > 0) pace = s.value;
            if (s.name === "avgPoints" && s.value > 0) avgPts = s.value;
          }
        }
        if (pace != null) teamPace[t.abbreviation] = pace;
        if (pace != null && avgPts != null) teamOffRtg[t.abbreviation] = parseFloat((avgPts / pace * 100).toFixed(1));
      } catch {}
    }));
    if (Object.keys(teamPace).length === 0) return null;
    // Add long-form aliases for ESPN short codes so playerTeam lookups always resolve
    // e.g. ESPN returns "NO" but playerTeam is normalized to "NOP" via TEAM_NORM
    const _shortToLong = { GS: "GSW", SA: "SAS", NY: "NYK", NJ: "BKN", NO: "NOP", PHO: "PHX" };
    for (const [s, l] of Object.entries(_shortToLong)) {
      if (teamPace[s] != null && teamPace[l] == null) teamPace[l] = teamPace[s];
      if (teamOffRtg[s] != null && teamOffRtg[l] == null) teamOffRtg[l] = teamOffRtg[s];
    }
    const paces = Object.values(teamPace);
    const leagueAvgPace = paces.reduce((a, b) => a + b, 0) / paces.length;
    const offRtgs = Object.values(teamOffRtg).filter(v => v > 0);
    const leagueAvgOffRtg = offRtgs.length >= 15 ? parseFloat((offRtgs.reduce((a, b) => a + b, 0) / offRtgs.length).toFixed(2)) : 113.0;
    const result = { teamPace, leagueAvgPace: parseFloat(leagueAvgPace.toFixed(2)), teamOffRtg, leagueAvgOffRtg };
    if (cache) await cache.put("nba:pace:2526", JSON.stringify(result), { expirationTtl: 43200 }).catch(() => {});
    return result;
  } catch (e) {
    console.log("[nba-pace] error:", String(e));
    return null;
  }
}

export async function buildNbaPlayerPosFromSleeper(cache) {
  try {
    const r = await fetch("https://api.sleeper.app/v1/players/nba", { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const players = await r.json();
    // Build name→position map for active players with a primary fantasy position
    const POS_VALID = new Set(["PG","SG","SF","PF","C"]);
    const nameToPos = {};
    for (const p of Object.values(players)) {
      if (!p.active) continue;
      const pos = p.fantasy_positions?.[0];
      if (!POS_VALID.has(pos)) continue;
      const name = (p.full_name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
      if (name) nameToPos[name] = pos;
    }
    if (cache) await cache.put("dvp:nba:player-pos-by-name", JSON.stringify(nameToPos), { expirationTtl: 86400 * 7 }).catch(() => {});
    return nameToPos;
  } catch (e) {
    console.log("[sleeper-pos] error:", String(e));
    return null;
  }
}

// C1: Fetch per-player usage rate from ESPN stats API.
// Returns { [espnId]: { usg, source } } — source "espn" if direct, "estimated" if computed.
// Estimated from avgPTS + avgAST × 1.5 over avgMin × 0.42 (FTA-inclusive approximation).
export async function buildNbaUsageRate(playerIds) {
  const hdrs = { "User-Agent": "Mozilla/5.0" };
  const result = {};
  const batches = [];
  for (let i = 0; i < playerIds.length; i += 10) batches.push(playerIds.slice(i, i + 10));
  for (const batch of batches) {
    await Promise.all(batch.map(async id => {
      try {
        // sports.core.api.espn.com returns d.splits.categories (same shape as buildNbaPaceData)
        const r = await fetch(
          `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/types/2/athletes/${id}/statistics`,
          { headers: hdrs }
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
        if (usg != null) {
          result[String(id)] = { usg, avgAst: _avgAst, avgReb: _avgReb, source: "espn" };
          return;
        }
        if (avgMin > 10 && avgFGA > 0) {
          const est = (avgFGA + 0.44 * avgFTA + avgTO) / (avgMin * 2.255) * 100;
          result[String(id)] = { usg: parseFloat(Math.min(50, Math.max(0, est)).toFixed(1)), avgAst: _avgAst, avgReb: _avgReb, source: "estimated" };
        }
      } catch {}
    }));
  }
  return result;
}

// C2: Fetch ESPN NBA injury report. Returns Map<teamAbbr, [{name, status}]> for "Out" players.
// Cached at nba:injuries:{date} for 1800s (30 min).
export async function buildNbaInjuryReport(cache) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const cacheKey = `nba:injuries:${date}`;
    if (cache) {
      const cached = await cache.get(cacheKey, "json").catch(() => null);
      if (cached) {
        // Return as Map
        const m = new Map();
        for (const [k, v] of Object.entries(cached)) m.set(k, v);
        return m;
      }
    }
    const r = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries",
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
        // Team abbreviation lives inside athlete.team, not teamEntry.team
        if (!abbr) abbr = inj.athlete?.team?.abbreviation || null;
        const name = inj.athlete?.displayName || "";
        if (name) outPlayers.push({ name, status: isOut ? "out" : "gtd" });
      }
      if (abbr && outPlayers.length) injMap[abbr] = outPlayers;
    }
    // Normalize ESPN short-form abbrs to canonical form (deduplicate GS/GSW, NO/NOP, SA/SAS etc.)
    const NORM = { GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK", NJ: "BKN", PHO: "PHX" };
    for (const [short, canon] of Object.entries(NORM)) {
      if (injMap[short]) {
        if (!injMap[canon]) injMap[canon] = injMap[short];
        delete injMap[short];
      }
    }
    if (cache && Object.keys(injMap).length > 0) {
      await cache.put(cacheKey, JSON.stringify(injMap), { expirationTtl: 1800 }).catch(() => {});
    }
    const m = new Map();
    for (const [k, v] of Object.entries(injMap)) m.set(k, v);
    return m;
  } catch (e) {
    console.log("[nba-injuries] error:", String(e));
    return new Map();
  }
}

export async function buildNbaDvpStage3FG(cache) {
  try {
    const [selected, cPartial] = await Promise.all([
      cache ? cache.get("dvp:nba:selected-players", "json").catch(() => null) : null,
      cache ? cache.get("dvp:nba:c-partial", "json").catch(() => null) : null
    ]);
    if (!selected?.F?.length) {
      console.log("[dvp-s3] no selected players — run stage 1 first");
      return null;
    }
    const fIds = selected.F.slice(0, 25);
    const gIds = selected.G.slice(0, 20);
    const [fAgg, gAgg] = await Promise.all([
      _fetchAndAggregateDvp(fIds),
      _fetchAndAggregateDvp(gIds)
    ]);
    const finalResult = {
      builtAt: new Date().toISOString(),
      C: cPartial || { rankings: {}, softTeams: {}, _debug: { error: "stage2 not run" } },
      F: _buildPosRankings(fAgg),
      G: _buildPosRankings(gAgg)
    };
    finalResult.F._debug = { players: fIds.length, teams: Object.keys(fAgg.teamDvp).length, leagueAvg: fAgg.leagueAvg };
    finalResult.G._debug = { players: gIds.length, teams: Object.keys(gAgg.teamDvp).length, leagueAvg: gAgg.leagueAvg };
    if (cache) await cache.put("dvp:nba:all-positions", JSON.stringify(finalResult), { expirationTtl: 86400 }).catch(() => {
    });
    return finalResult;
  } catch (e) {
    console.log("[dvp-s3] error:", String(e));
    return null;
  }
}
