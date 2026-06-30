// /api/dvp + all dvp/* debug endpoints. Self-contained — imports its own helpers.
// /api/dvp itself is the main play-card "defense vs position" lookup; /dvp/rebuild* and
// /dvp/debug* are operator/cron endpoints used to inspect or rebuild the DvP cache.
//
// Context: { path, method, params, env, CACHE2, runtimeCtx, ESPN_CORE,
//   jsonResponse, errorResponse }

import {
  buildNbaDvpStage1, buildNbaDvpFromBettingPros, buildNbaDepthChartPos,
  buildNbaDvpStage3FG,
} from "../nba.js";
import { WNBA_ESPN_TO_CANON } from "../wnba.js";
import { buildSoftTeamAbbrs, buildHardTeamAbbrs, buildTeamRankMap, parseGameOdds } from "../utils.js";
import { PARK_KFACTOR, log5K } from "../simulate.js";
import { buildLineupKPct, buildPitcherKPct } from "../mlb.js";

export async function handleDvpRoutes(ctx) {
  const { path, params, CACHE2, runtimeCtx, ESPN_CORE, jsonResponse, errorResponse } = ctx;

  if (path === "dvp/rebuild-pos") {
    const stage = params.get("stage") || "2";
    if (stage === "1") {
      runtimeCtx.waitUntil(Promise.all([buildNbaDvpStage1(CACHE2), buildNbaDepthChartPos(CACHE2)]));
      return jsonResponse({ ok: true, message: "Stage 1 (teams+rosters + depth charts) queued. Check /dvp/debug-players in ~30s." });
    } else if (stage === "dc") {
      const dcResult = await buildNbaDepthChartPos(CACHE2);
      return jsonResponse({ ok: true, message: "Depth chart pos rebuild complete.", count: dcResult ? Object.keys(dcResult).length : 0 });
    } else if (stage === "2") {
      runtimeCtx.waitUntil(buildNbaDvpFromBettingPros(CACHE2));
      return jsonResponse({ ok: true, message: "Stage 2 (BettingPros DvP) queued. Check /dvp/debug in ~30s." });
    } else if (stage === "3") {
      runtimeCtx.waitUntil(buildNbaDvpFromBettingPros(CACHE2).then((r) => r || buildNbaDvpStage3FG(CACHE2)));
      return jsonResponse({ ok: true, message: "Stage 3 (BP retry + gamelog fallback) queued. Check /dvp/debug in ~30s." });
    }
    return errorResponse("Invalid stage. Use ?stage=1, ?stage=2, or ?stage=3", 400);
  }

  if (path === "dvp/debug-players") {
    const sel = await CACHE2.get("dvp:nba:selected-players", "json").catch(() => null);
    if (!sel) return jsonResponse({ error: "no stage-1 data cached yet" });
    const counts = {};
    for (const pos of ["PG", "SG", "SF", "PF", "C"]) counts[pos] = sel[pos]?.length ?? 0;
    return jsonResponse({ builtAt: sel.builtAt, ...counts });
  }

  if (path === "dvp/test-bp") {
    const result = await buildNbaDvpFromBettingPros(null);
    if (!result) return jsonResponse({ error: "BettingPros fetch failed — check worker logs" });
    const summary = {};
    for (const pos of ["PG", "SG", "SF", "PF", "C"]) {
      summary[pos] = {
        ptsSoftTeams: result[pos]?.softTeams?.points || [],
        rebSoftTeams: result[pos]?.softTeams?.rebounds || [],
      };
    }
    return jsonResponse({ builtAt: result.builtAt, source: result.source, summary });
  }

  if (path === "dvp/debug-dc") {
    const dcPos = await CACHE2.get("dvp:nba:depth-chart-pos", "json").catch(() => null);
    if (!dcPos) return jsonResponse({ error: "no depth chart cache" });
    const counts = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 };
    for (const v of Object.values(dcPos)) if (counts[v] != null) counts[v]++;
    const query = params.get("id");
    const entry = query ? { id: query, pos: dcPos[query] || "not found" } : null;
    return jsonResponse({ total: Object.keys(dcPos).length, counts, ...(entry ? { lookup: entry } : {}) });
  }

  if (path === "dvp/debug") {
    const pos = (params.get("pos") || "C").toUpperCase();
    const stat = params.get("stat") || "rebounds";
    const team = (params.get("team") || "ATL").toUpperCase();
    const all = await CACHE2.get("dvp:nba:all-positions", "json").catch(() => null);
    if (!all) return jsonResponse({ error: "no dvp data cached" });
    const rankings = all[pos]?.rankings?.[stat] || [];
    const teamEntry = rankings.find((t) => t.abbr === team);
    const softTeams = all[pos]?.softTeams?.[stat] || [];
    return jsonResponse({
      pos, stat, team,
      builtAt: all.builtAt, source: all.source,
      totalTeams: rankings.length,
      softTeams,
      entry: teamEntry || null,
      top10: rankings.slice(0, 10).map((t) => ({ rank: t.rank, abbr: t.abbr, avg: t.avgPts, ratio: t.ratio, gp: t.gp })),
    });
  }

  if (path === "dvp/gamelog") {
    // NOTE: fetchNbaGamelog is undefined here — this debug endpoint was already broken
    // when modularizing. Preserved as-is rather than silently fixing scope.
    const id = params.get("id");
    if (!id) return errorResponse("id required", 400);
    const gl = await fetchNbaGamelog(id);
    if (!gl) return jsonResponse({ error: "fetch failed or no data", id });
    const atlGames = gl.filter((e) => e.oppAbbr === "ATL" || e.oppAbbr === "ATL ");
    return jsonResponse({ id, total: gl.length, atlGames, first5: gl.slice(0, 5) });
  }

  if (path === "dvp/test-boxscore") {
    const gameIds = ["401810997", "401810995", "401810993"];
    const POS_MAP = { "Center": "C", "Forward-Center": "C", "Center-Forward": "C", "Forward": "F", "Guard-Forward": "F", "Guard": "G", "Forward-Guard": "G" };
    const teamDvp = {};
    const teamAbbrs = {};
    for (const gameId of gameIds) {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!r.ok) continue;
        const game = await r.json();
        const comps = game.header?.competitions?.[0]?.competitors || [];
        if (comps.length !== 2) continue;
        for (const c of comps) teamAbbrs[String(c.team?.id)] = c.team?.abbreviation || "";
        const teamIds = comps.map((c) => String(c.team?.id));
        for (const teamData of game.boxscore?.players || []) {
          const offTeamId = String(teamData.team?.id || "");
          const defTeamId = teamIds.find((id) => id !== offTeamId);
          if (!defTeamId) continue;
          const stats = teamData.statistics?.[0];
          if (!stats) continue;
          const labels = (stats.labels || []).map((l) => l.toUpperCase());
          const ptsIdx = labels.indexOf("PTS"), rebIdx = labels.indexOf("REB");
          const posTotals = {};
          for (const athlete of stats.athletes || []) {
            const athleteStats = athlete.stats || [];
            if (!athleteStats.length) continue;
            const pos = POS_MAP[athlete.athlete?.position?.displayName || ""];
            if (!pos) continue;
            if (!posTotals[pos]) posTotals[pos] = { pts: 0, reb: 0 };
            posTotals[pos].pts += parseFloat(athleteStats[ptsIdx]) || 0;
            posTotals[pos].reb += parseFloat(athleteStats[rebIdx]) || 0;
          }
          if (!teamDvp[defTeamId]) teamDvp[defTeamId] = { abbr: teamAbbrs[defTeamId] };
          for (const [pos, t] of Object.entries(posTotals)) {
            if (!teamDvp[defTeamId][pos]) teamDvp[defTeamId][pos] = [];
            teamDvp[defTeamId][pos].push(t);
          }
        }
      } catch {}
    }
    return jsonResponse({ teamDvp, teamAbbrs });
  }

  if (path === "dvp/rebuild") {
    let testWriteErr = null;
    try { await CACHE2.put("dvp:write-test", "ok", { expirationTtl: 60 }); }
    catch (e) { testWriteErr = String(e); }
    const testRead = await CACHE2.get("dvp:write-test").catch((e) => `READ_ERR:${e}`);
    const tableResult = await buildNbaDvpFromBettingPros(CACHE2);
    if (!tableResult) return errorResponse("BettingPros fetch failed — check logs", 500);
    const serialized = JSON.stringify(tableResult);
    const positions = Object.keys(tableResult).filter((k) => k !== "builtAt" && k !== "source");
    return jsonResponse({ ok: true, positions, builtAt: tableResult.builtAt, source: tableResult.source, payloadBytes: serialized.length, testWriteErr, testRead });
  }

  if (path === "dvp") {
    const sport = params.get("sport") || "basketball/nba";
    const athleteId = params.get("athleteId");
    const [sportSlug, leagueSlug] = sport.split("/");
    let position = params.get("position") || null;
    if (!position && athleteId && sport === "basketball/nba") {
      const dcPos = CACHE2 ? await CACHE2.get("dvp:nba:depth-chart-pos", "json").catch(() => null) : null;
      if (dcPos) position = dcPos[String(athleteId)] || null;
    }
    if (!position && athleteId) {
      try {
        const ar = await fetch(`${ESPN_CORE}/${sportSlug}/leagues/${leagueSlug}/athletes/${athleteId}`, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (ar.ok) {
          const ad = await ar.json();
          position = ad.position?.abbreviation || null;
        }
      } catch {}
    }
    if (sport === "basketball/nba") {
      let nbaByteam = CACHE2 ? await CACHE2.get("byteam:nba", "json").catch(() => null) : null;
      if (!nbaByteam || nbaByteam.length === 0) {
        const r = await fetch(
          "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=defensive&seasontype=2",
          { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }
        ).catch(() => null);
        if (r?.ok) {
          const d = await r.json();
          nbaByteam = d.teams || [];
          if (CACHE2 && nbaByteam.length > 0) CACHE2.put("byteam:nba", JSON.stringify(nbaByteam), { expirationTtl: 21600 }).catch(() => {});
        }
      }
      if (nbaByteam && nbaByteam.length > 0) {
        const STATS = ["points", "rebounds", "assists", "threePointers"];
        const softTeams = Object.fromEntries(STATS.map((s) => [s, buildSoftTeamAbbrs(nbaByteam, s)]));
        const hardTeams = Object.fromEntries(STATS.map((s) => [s, buildHardTeamAbbrs(nbaByteam, s)]));
        const rankMaps = Object.fromEntries(STATS.map((s) => [s, buildTeamRankMap(nbaByteam, s)]));
        const teams = Object.entries(rankMaps.points).map(([abbr, { rank, value }]) => ({ abbr, rank, avgPts: value })).sort((a, b) => a.rank - b.rank);
        return jsonResponse({ position, metric: "pts", teams, softTeams, hardTeams, rankMaps, source: "byteam" }, 21600);
      }
      return errorResponse("NBA byteam data unavailable", 500);
    }
    if (sport === "basketball/wnba") {
      let wnbaByteam = CACHE2 ? await CACHE2.get("byteam:wnba", "json").catch(() => null) : null;
      if (!wnbaByteam || wnbaByteam.length === 0) {
        const r = await fetch(
          "https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=20&category=defensive&seasontype=2&season=2025",
          { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }
        ).catch(() => null);
        if (r?.ok) {
          const d = await r.json();
          wnbaByteam = d.teams || [];
          if (CACHE2 && wnbaByteam.length > 0) CACHE2.put("byteam:wnba", JSON.stringify(wnbaByteam), { expirationTtl: 21600 }).catch(() => {});
        }
      }
      if (wnbaByteam && wnbaByteam.length > 0) {
        const STATS = ["points", "rebounds", "assists", "threePointers"];
        const softTeams = Object.fromEntries(STATS.map((s) => [s, buildSoftTeamAbbrs(wnbaByteam, s)]));
        const hardTeams = Object.fromEntries(STATS.map((s) => [s, buildHardTeamAbbrs(wnbaByteam, s)]));
        const rankMaps = Object.fromEntries(STATS.map((s) => [s, buildTeamRankMap(wnbaByteam, s)]));
        for (const s of STATS) {
          const rm = rankMaps[s];
          for (const [raw, val] of Object.entries(rm)) {
            const norm = WNBA_ESPN_TO_CANON[raw];
            if (norm && !rm[norm]) rm[norm] = val;
          }
          const st = softTeams[s];
          const ht = hardTeams[s];
          for (const raw of [...st]) {
            const norm = WNBA_ESPN_TO_CANON[raw];
            if (norm && !st.includes(norm)) st.push(norm);
          }
          for (const raw of [...ht]) {
            const norm = WNBA_ESPN_TO_CANON[raw];
            if (norm && !ht.includes(norm)) ht.push(norm);
          }
        }
        const teams = Object.entries(rankMaps.points).map(([abbr, { rank, value }]) => ({ abbr, rank, avgPts: value })).sort((a, b) => a.rank - b.rank);
        return jsonResponse({ position, metric: "pts", teams, softTeams, hardTeams, rankMaps, source: "byteam" }, 21600);
      }
      return errorResponse("WNBA byteam data unavailable", 500);
    }
    if (sport === "football/nfl") {
      const NFL_POS_CAT = {
        QB: { catName: "Opponent Passing", valIdx: 8, metric: "oppPassingYardsPerGame" },
        RB: { catName: "Opponent Rushing", valIdx: 1, metric: "oppRushingYardsPerGame" },
        HB: { catName: "Opponent Rushing", valIdx: 1, metric: "oppRushingYardsPerGame" },
        FB: { catName: "Opponent Rushing", valIdx: 1, metric: "oppRushingYardsPerGame" },
        WR: { catName: "Opponent Receiving", valIdx: 3, metric: "oppReceivingYardsPerGame" },
        TE: { catName: "Opponent Receiving", valIdx: 3, metric: "oppReceivingYardsPerGame" },
      };
      const posKey = position || "QB";
      const { catName, valIdx, metric } = NFL_POS_CAT[posKey] || NFL_POS_CAT.QB;
      const byteamUrl = `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byteam?region=us&lang=en&isqualified=true&page=1&limit=32&category=passing`;
      let teams = [];
      try {
        const r = await fetch(byteamUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (r.ok) {
          const data = await r.json();
          const rawTeams = data.teams || [];
          teams = rawTeams.map((t) => {
            const abbr = t.team?.abbreviation || "";
            const id = String(t.team?.id || "");
            let val = null, gp = 0;
            for (const cat of t.categories || []) {
              if (cat.displayName === catName) val = cat.values?.[valIdx] ?? null;
              if (cat.displayName === "Own General") gp = cat.values?.[0] ?? 0;
            }
            return { id, abbr, val, gp };
          }).filter((t) => t.abbr && t.val !== null && t.gp >= 4).sort((a, b) => b.val - a.val).map((t, i) => ({ id: t.id, abbr: t.abbr, avgPts: parseFloat(t.val.toFixed(2)), gp: t.gp, rank: i + 1 }));
        }
      } catch {}
      return jsonResponse({ position: posKey, metric, teams }, 21600);
    }
    if (sport === "hockey/nhl") {
      const NHL_ABBR = { 1:"NJD",2:"NYI",3:"NYR",4:"PHI",5:"PIT",6:"BOS",7:"BUF",8:"MTL",9:"OTT",10:"TOR",12:"CAR",13:"FLA",14:"TBL",15:"WSH",16:"CHI",17:"DET",18:"NSH",19:"STL",20:"CGY",21:"COL",22:"EDM",23:"VAN",24:"ANA",25:"DAL",26:"LA",28:"SJ",29:"CBJ",30:"MIN",52:"WPG",53:"UTA",54:"VGK",55:"SEA" };
      const isGoalie = position === "G";
      const sortStat = isGoalie ? "shotsForPerGame" : "shotsAgainstPerGame";
      let teams = [];
      try {
        const nhlUrl = `https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=${sortStat}&start=0&limit=50&cayenneExp=seasonId%3D20252026%20and%20gameTypeId%3D2`;
        const r = await fetch(nhlUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
        if (r.ok) {
          const data = await r.json();
          teams = [...(data.data || [])].sort((a, b) => b[sortStat] - a[sortStat]).map((t, i) => ({
            id: String(t.teamId),
            abbr: NHL_ABBR[t.teamId] || "",
            avgPts: parseFloat((t[sortStat] || 0).toFixed(2)),
            gp: t.gamesPlayed || 0,
            rank: i + 1,
          })).filter((t) => t.abbr);
        }
      } catch {}
      return jsonResponse({ position, metric: sortStat, teams }, 21600);
    }
    if (sport === "baseball/mlb") {
      const playerTeam = params.get("team") || null;
      let mlbByteam = CACHE2 ? await CACHE2.get("byteam:mlb", "json").catch(() => null) : null;
      if (!mlbByteam) {
        const _hd0 = new Date(Date.now() - 7 * 3600 * 1000); const _hd1 = new Date(_hd0); _hd1.setDate(_hd1.getDate() + 1);
        const _hfmt = (d) => d.toISOString().slice(0, 10);
        const _hfmtE = (d) => _hfmt(d).replace(/-/g, "");
        const [pitchRes, batRes, sbRes, mlbSched] = await Promise.all([
          fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=pitching", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
          fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=batting", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
          (() => {
            const _h = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
            return Promise.all([
              fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_hfmtE(_hd0)}`, { headers: _h }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
              fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_hfmtE(_hd1)}`, { headers: _h }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
            ]).then(([sb0, sb1]) => ({ events: sb0.events || [], eventsAll: [...(sb0.events || []), ...(sb1.events || [])] }));
          })(),
          fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_hfmt(_hd0)}&hydrate=lineups,probablePitcher`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((s0) => {
            const allFinal = (s0.dates || []).flatMap((d) => d.games || []).every((g) => g.status?.abstractGameState === "Final");
            if ((s0.dates || []).length === 0 || allFinal) {
              return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_hfmt(_hd1)}&hydrate=lineups,probablePitcher`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
            }
            return s0;
          }),
        ]);
        const _mlbNorm2 = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
        const normMlbAbbr2 = (a) => _mlbNorm2[a] || a;
        const probables2 = {};
        for (const event of sbRes.events || []) {
          for (const comp of event.competitions || []) {
            const gameAbbrs = (comp.competitors || []).map((c) => normMlbAbbr2(c.team?.abbreviation)).filter(Boolean);
            for (const competitor of comp.competitors || []) {
              const abbr = normMlbAbbr2(competitor.team?.abbreviation);
              const probable = (competitor.probables || [])[0];
              if (!abbr || !probable) continue;
              const stats = probable.statistics || [];
              const eraStat = stats.find((s) => s.abbreviation === "ERA");
              const era = eraStat ? parseFloat(eraStat.displayValue) : null;
              const name = probable.athlete?.displayName || probable.athlete?.fullName || null;
              const id = probable.athlete?.id || null;
              const opp = gameAbbrs.find((a) => a !== abbr) || null;
              probables2[abbr] = { name, era, id, opp };
            }
          }
        }
        const gameOddsRaw2 = parseGameOdds(sbRes.events);
        const gameOdds = Object.fromEntries(Object.entries(gameOddsRaw2).map(([k, v]) => [normMlbAbbr2(k), v]));
        const [lineupResult, pitcherResult] = await Promise.all([buildLineupKPct(mlbSched), buildPitcherKPct(mlbSched)]);
        const { lineupKPct: lineupKPct2, lineupBatterKPcts: lineupBatterKPcts2, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered: lineupBatterKPctsOrdered2, lineupBatterKPctsVROrdered: lineupBatterKPctsVROrdered2, lineupBatterKPctsVLOrdered: lineupBatterKPctsVLOrdered2, lineupSpotByName: lineupSpotByName2, gameHomeTeams: gameHomeTeams2, projectedLineupTeams: projectedLineupTeams2 } = lineupResult;
        const { pitcherKPct: pitcherKPct2, pitcherKBBPct: pitcherKBBPct2, pitcherHand, pitcherEra: pitcherEraByTeam2, pitcherCSWPct: pitcherCSWPct2, pitcherAvgPitches: pitcherAvgPitches2, pitcherGS26: pitcherGS262, pitcherHasAnchor: pitcherHasAnchor2 } = pitcherResult;
        mlbByteam = { pitching: pitchRes, batting: batRes, probables: probables2, lineupKPct: lineupKPct2, lineupBatterKPcts: lineupBatterKPcts2, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered: lineupBatterKPctsOrdered2, lineupBatterKPctsVROrdered: lineupBatterKPctsVROrdered2, lineupBatterKPctsVLOrdered: lineupBatterKPctsVLOrdered2, lineupSpotByName: lineupSpotByName2, gameHomeTeams: gameHomeTeams2, pitcherKPct: pitcherKPct2, pitcherKBBPct: pitcherKBBPct2, pitcherCSWPct: pitcherCSWPct2, pitcherAvgPitches: pitcherAvgPitches2, pitcherGS26: pitcherGS262, pitcherHasAnchor: pitcherHasAnchor2, pitcherHand, pitcherEra: pitcherEraByTeam2, projectedLineupTeams: projectedLineupTeams2, gameOdds };
        if (CACHE2) await CACHE2.put("byteam:mlb", JSON.stringify(mlbByteam), { expirationTtl: 600 });
      }
      const probables = mlbByteam.probables || {};
      const playerEntry = playerTeam ? probables[playerTeam] : null;
      const tonightOpp = playerEntry?.opp || null;
      const oppEntry = tonightOpp ? probables[tonightOpp] : null;
      const lineupKPct = mlbByteam.lineupKPct || {};
      const lineupBatterKPcts = mlbByteam.lineupBatterKPcts || {};
      const pitcherKPct = mlbByteam.pitcherKPct || {};
      const pitcherKBBPct = mlbByteam.pitcherKBBPct || {};
      const gameHomeTeams = mlbByteam.gameHomeTeams || {};
      const _ptDvp = (m) => (tonightOpp ? (m?.[`${playerTeam}|${tonightOpp}`] ?? null) : null) ?? m?.[playerTeam] ?? null;
      const pKPct = _ptDvp(pitcherKPct);
      const _dvpPitcherHandEarly = _ptDvp(mlbByteam.pitcherHand);
      const ordAllDvp = mlbByteam.lineupBatterKPctsOrdered?.[tonightOpp] ?? null;
      const ordVRDvp = mlbByteam.lineupBatterKPctsVROrdered?.[tonightOpp] ?? null;
      const ordVLDvp = mlbByteam.lineupBatterKPctsVLOrdered?.[tonightOpp] ?? null;
      const orderedKPctsDvp = _dvpPitcherHandEarly === "R" ? (ordVRDvp ?? ordAllDvp) : _dvpPitcherHandEarly === "L" ? (ordVLDvp ?? ordAllDvp) : ordAllDvp;
      const batterKPcts = orderedKPctsDvp ?? (lineupBatterKPcts[tonightOpp] ?? []);
      let log5Avg = null, expectedKs = null, parkFactor = null;
      if (pKPct !== null && batterKPcts.length >= 3) {
        const homeTeam = gameHomeTeams[playerTeam] || tonightOpp;
        parkFactor = PARK_KFACTOR[homeTeam] ?? 1;
        const scores = batterKPcts.map((b) => log5K(pKPct, b * 100));
        log5Avg = parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length * 100).toFixed(1));
        expectedKs = parseFloat((log5Avg / 100 * 27 * parkFactor).toFixed(1));
      }
      const projectedLineupTeams = mlbByteam.projectedLineupTeams || [];
      const _dvpGameOdds = mlbByteam.gameOdds?.[playerTeam] ?? null;
      const _dvpPkpMeets = pKPct != null ? pKPct > 25 : null;
      const _dvpPitcherHand = _ptDvp(mlbByteam.pitcherHand);
      const _dvpLkpVR = mlbByteam.lineupKPctVR?.[tonightOpp] ?? null;
      const _dvpLkpVL = mlbByteam.lineupKPctVL?.[tonightOpp] ?? null;
      const _dvpLkpAll = lineupKPct[tonightOpp] ?? null;
      const _dvpLkp = _dvpPitcherHand === "R" ? _dvpLkpVR ?? _dvpLkpAll : _dvpPitcherHand === "L" ? _dvpLkpVL ?? _dvpLkpAll : _dvpLkpAll;
      const _dvpLkpMeets = _dvpLkp != null ? _dvpLkp > 23 : null;
      const _dvpGameLineMeets = _dvpGameOdds?.total != null && _dvpGameOdds?.moneyline != null ? _dvpGameOdds.total < 8.5 && _dvpGameOdds.moneyline <= -140 : null;
      const _dvpStrongTrue = [_dvpPkpMeets, _dvpLkpMeets, _dvpGameLineMeets].filter(v => v === true).length;
      const _dvpStrongKnown = [_dvpPkpMeets, _dvpLkpMeets, _dvpGameLineMeets].filter(v => v !== null).length;
      const _dvpIsStrong = _dvpStrongKnown >= 2 ? _dvpStrongTrue >= 2 : _dvpStrongTrue >= 1;
      return jsonResponse({
        position,
        metric: "h2h",
        teams: [],
        h2h: tonightOpp ? {
          opp: tonightOpp,
          pitcherName: oppEntry?.name || null,
          pitcherEra: oppEntry?.era ?? null,
          lineupKPct: _dvpLkp,
          lineupKPctProjected: projectedLineupTeams.includes(tonightOpp),
          pitcherKPct: pKPct,
          pitcherKBBPct: _ptDvp(pitcherKBBPct),
          log5Avg, expectedKs, parkFactor,
          pitcherHand: _dvpPitcherHand,
          isStrongMatchup: _dvpIsStrong,
          pkpMeets: _dvpPkpMeets,
          lkpMeets: _dvpLkpMeets,
          gameLineMeets: _dvpGameLineMeets,
          gameTotal: _dvpGameOdds?.total ?? null,
          gameMoneyline: _dvpGameOdds?.moneyline ?? null,
        } : null,
        allLineupKPct: _dvpPitcherHand === "R"
          ? Object.fromEntries(Object.entries(lineupKPct).map(([t, v]) => [t, mlbByteam.lineupKPctVR?.[t] ?? v]).filter(([, v]) => v != null))
          : _dvpPitcherHand === "L"
          ? Object.fromEntries(Object.entries(lineupKPct).map(([t, v]) => [t, mlbByteam.lineupKPctVL?.[t] ?? v]).filter(([, v]) => v != null))
          : lineupKPct,
      }, 600);
    }
    return jsonResponse({ position, teams: [] }, 21600);
  }

  return null;
}
