// MLB hitter data fetchers: lineups/batting-order, split BA, HRR splits, barrel%.
// Split out of mlb.js Phase C (2026-05-29). Zero behavior change.
import { _fs, MLB_ID_TO_ABBR } from "./mlb-shared.js";

export async function buildLineupKPct(mlbSched) {
  try {
    const teamLineups = {};
    const projectedLineupTeams = new Set();
    const gameHomeTeams = {};
    const teamsInTodayGames = {};
    // Name-based batting order (normalized lowercase, accent-stripped) → spot (1-indexed)
    const lineupSpotByName = {};
    const _normPlayerName = n => n ? n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    const _addLineupNames = (abbr, players) => {
      lineupSpotByName[abbr] = {};
      players.forEach((p, i) => {
        if (p.fullName) lineupSpotByName[abbr][_normPlayerName(p.fullName)] = i + 1;
      });
    };
    for (const date of mlbSched.dates || []) {
      for (const game of date.games || []) {
        const homeTeamId = game.teams?.home?.team?.id;
        const awayTeamId = game.teams?.away?.team?.id;
        const homeAbbr = MLB_ID_TO_ABBR[homeTeamId] || game.teams?.home?.team?.abbreviation;
        const awayAbbr = MLB_ID_TO_ABBR[awayTeamId] || game.teams?.away?.team?.abbreviation;
        const homePlayers = game.lineups?.homePlayers || [];
        const awayPlayers = game.lineups?.awayPlayers || [];
        if (homeAbbr) teamsInTodayGames[homeAbbr] = homeTeamId;
        if (awayAbbr) teamsInTodayGames[awayAbbr] = awayTeamId;
        if (homeAbbr && homePlayers.length > 0) {
          teamLineups[homeAbbr] = homePlayers.map((p) => p.id).filter(Boolean);
          _addLineupNames(homeAbbr, homePlayers);
        }
        if (awayAbbr && awayPlayers.length > 0) {
          teamLineups[awayAbbr] = awayPlayers.map((p) => p.id).filter(Boolean);
          _addLineupNames(awayAbbr, awayPlayers);
        }
        if (homeAbbr && awayAbbr) {
          gameHomeTeams[homeAbbr] = homeAbbr;
          gameHomeTeams[awayAbbr] = homeAbbr;
        }
      }
    }
    const teamsNeedingProjection = Object.keys(teamsInTodayGames).filter((abbr) => !teamLineups[abbr]);
    if (teamsNeedingProjection.length > 0) {
      const today = new Date();
      const end = new Date(today.getTime() - 864e5).toISOString().slice(0, 10);
      const start = new Date(today.getTime() - 14 * 864e5).toISOString().slice(0, 10);
      const recentSched = await _fs("recent-sched",
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=lineups`,
        { headers: { "User-Agent": "Mozilla/5.0" } });
      // recentLineups: most recent game with players, used for K% stat fetching
      const recentLineups = {};
      // recentPlayerSpots: per-player most recent batting spot across all scanned games.
      // Scanning in reverse (most recent first) means the first time we see a player we get
      // their most recent batting position — handles DNP games where a player is absent from
      // the latest lineup (e.g. Bellinger DNP one game still projects his usual spot from the
      // prior game, while players who DID play yesterday get their yesterday position).
      const recentPlayerSpots = {};
      for (const date of [...recentSched.dates || []].reverse()) {
        for (const game of date.games || []) {
          const hAbbr = MLB_ID_TO_ABBR[game.teams?.home?.team?.id] || game.teams?.home?.team?.abbreviation;
          const aAbbr = MLB_ID_TO_ABBR[game.teams?.away?.team?.id] || game.teams?.away?.team?.abbreviation;
          const hPlayers = game.lineups?.homePlayers || [];
          const aPlayers = game.lineups?.awayPlayers || [];
          const hIds = hPlayers.map((p) => p.id).filter(Boolean);
          const aIds = aPlayers.map((p) => p.id).filter(Boolean);
          // Primary lineup for K% calc: take the most recent game with actual players
          if (hAbbr && !recentLineups[hAbbr] && hIds.length > 0) { recentLineups[hAbbr] = hIds; }
          if (aAbbr && !recentLineups[aAbbr] && aIds.length > 0) { recentLineups[aAbbr] = aIds; }
          // Spot map: accumulate per-player batting positions from all games.
          // Since we iterate most-recent-first, the first encounter per player = most recent spot.
          const _addToSpotMap = (abbr, players) => {
            if (!abbr || !teamsNeedingProjection.includes(abbr) || players.length === 0) return;
            if (!recentPlayerSpots[abbr]) recentPlayerSpots[abbr] = {};
            players.forEach((p, i) => {
              const name = _normPlayerName(p.fullName);
              if (name && !(name in recentPlayerSpots[abbr])) recentPlayerSpots[abbr][name] = i + 1;
            });
          };
          _addToSpotMap(hAbbr, hPlayers);
          _addToSpotMap(aAbbr, aPlayers);
        }
      }
      for (const abbr of teamsNeedingProjection) {
        if (recentLineups[abbr]) {
          teamLineups[abbr] = recentLineups[abbr];
          projectedLineupTeams.add(abbr);
          if (recentPlayerSpots[abbr]) lineupSpotByName[abbr] = recentPlayerSpots[abbr];
        }
      }
    }
    const allIds = [...new Set(Object.values(teamLineups).flat())];
    if (allIds.length === 0) return { lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {}, lineupBatterKPctsOrdered: {}, lineupBatterKPctsVROrdered: {}, lineupBatterKPctsVLOrdered: {}, lineupSpotByName: {}, gameHomeTeams, projectedLineupTeams: [], batterSplitBA: {}, hitterOpsMap: {}, batterHandByName: {}, batterHRRSplits: {} };
    const idStr = allIds.join(",");
    const H = { headers: { "User-Agent": "Mozilla/5.0" } };
    const [res25, res26, resSplitVR, resSplitVL, resSplitVR25, resSplitVL25, resBatSideOps] = await Promise.all([
      _fs("bat-stats-2025",   `https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2025,gameType=R)`, H),
      _fs("bat-stats-2026",   `https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2026,gameType=R)`, H),
      _fs("bat-split-vr-26",  `https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2026,sitCodes=vr,gameType=R)`, H),
      _fs("bat-split-vl-26",  `https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2026,sitCodes=vl,gameType=R)`, H),
      _fs("bat-split-vr-25",  `https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2025,sitCodes=vr,gameType=R)`, H),
      _fs("bat-split-vl-25",  `https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2025,sitCodes=vl,gameType=R)`, H),
      _fs("bat-side-ops-26",  `https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2026,gameType=R)&fields=people,id,fullName,batSide,code,stats,splits,stat,ops`, H),
    ]);
    const playerStats25 = {}, playerStats26 = {};
    for (const person of (res25.people || [])) {
      const pid = person.id; if (!pid) continue;
      const split = person.stats?.[0]?.splits?.[0]?.stat; if (!split) continue;
      playerStats25[pid] = { so: split.strikeOuts || 0, pa: split.plateAppearances || 0, g: split.gamesPlayed || 0 };
    }
    for (const person of (res26.people || [])) {
      const pid = person.id; if (!pid) continue;
      const split = person.stats?.[0]?.splits?.[0]?.stat; if (!split) continue;
      playerStats26[pid] = { so: split.strikeOuts || 0, pa: split.plateAppearances || 0, g: split.gamesPlayed || 0 };
    }
    // Per-batter: prefer 2026 (20+ PA in current season), fall back to 2025
    const playerStats = {};
    const allBatterIds = [...new Set([...Object.keys(playerStats25), ...Object.keys(playerStats26)].map(Number))];
    for (const pid of allBatterIds) {
      const s26 = playerStats26[pid], s25 = playerStats25[pid];
      playerStats[pid] = (s26 && s26.pa >= 15) ? s26 : (s25 || s26 || { so: 0, pa: 0 });
    }
    const playerSplits = {};
    // B1: Build 2025 raw split AB/H and HRR/G keyed by player ID for platoon blend and handedness hit rate
    const splitRaw25 = {};
    const splitRawHRR25 = {};
    const _bsNorm = n => n ? n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : "";
    for (const [code, res] of [["vr", resSplitVR25], ["vl", resSplitVL25]]) {
      for (const person of res.people || []) {
        const pid = person.id; if (!pid) continue;
        const splits = person.stats?.[0]?.splits || [];
        const s = splits.find((x) => x.split?.code === code) || splits[0];
        if (!s?.stat) continue;
        if (!splitRaw25[pid]) splitRaw25[pid] = {};
        splitRaw25[pid][code] = { ab: s.stat.atBats || 0, h: s.stat.hits || 0 };
        if (!splitRawHRR25[pid]) splitRawHRR25[pid] = {};
        splitRawHRR25[pid][code] = {
          hrr: (s.stat.hits || 0) + (s.stat.runs || 0) + (s.stat.rbi || 0),
          g: s.stat.gamesPlayed || 0
        };
      }
    }
    // B1: Also track split BA and HRR splits per player (keyed by normalized name)
    const batterSplitBA = {};
    const batterHRRSplits = {};
    for (const [code, res] of [["vr", resSplitVR], ["vl", resSplitVL]]) {
      for (const person of res.people || []) {
        const pid = person.id;
        if (!pid) continue;
        const splits = person.stats?.[0]?.splits || [];
        const s = splits.find((x) => x.split?.code === code) || splits[0];
        if (!s?.stat) continue;
        if (!playerSplits[pid]) playerSplits[pid] = {};
        playerSplits[pid][code] = { so: s.stat.strikeOuts || 0, pa: s.stat.plateAppearances || 0 };
        // B1: Combine 2026 + 2025 AB/H for platoon BA (raw combined, consistent with hitterBa blend)
        if (person.fullName) {
          const name = _bsNorm(person.fullName);
          if (!batterSplitBA[name]) batterSplitBA[name] = {};
          const ab26 = s.stat.atBats || 0;
          const h26 = s.stat.hits || 0;
          const s25 = splitRaw25[pid]?.[code];
          const ab = ab26 + (s25?.ab || 0);
          const h = h26 + (s25?.h || 0);
          const baKey = code === "vr" ? "vsR" : "vsL";
          const paKey = code === "vr" ? "vsRPA" : "vsLPA";
          batterSplitBA[name][baKey] = ab >= 20 ? parseFloat((h / ab).toFixed(3)) : null;
          batterSplitBA[name][paKey] = ab;
          // HRR splits: combine 2026 + 2025 H+R+RBI and gamesPlayed for Poisson hit rate estimate
          if (!batterHRRSplits[name]) batterHRRSplits[name] = {};
          const hrr26 = (s.stat.hits || 0) + (s.stat.runs || 0) + (s.stat.rbi || 0);
          const g26 = s.stat.gamesPlayed || 0;
          const s25hrr = splitRawHRR25[pid]?.[code];
          const totalHRR = hrr26 + (s25hrr?.hrr || 0);
          const totalG = g26 + (s25hrr?.g || 0);
          if (totalG >= 1) batterHRRSplits[name][baKey] = { hrr: totalHRR, g: totalG };
        }
      }
    }
    // OPS (2026 season) + batting side per batter
    const hitterOpsMap = {};
    const batterHandByName = {};
    const batterHandById = {};
    // Per-hitter typical PAs/game from this season's batting stats — the empirical baseline
    // for HRR PA-aware adjustment (2026-05-25 retry). Uses 2026 only when GP ≥ 20 (full
    // sample); falls back to 2026 + 2025 combined when 2026 GP < 20 to avoid early-season
    // single-game outliers. Indexed by normalized name (consumed via _bsNorm on the player
    // name at pick time).
    const hitterTypicalPA = {};
    for (const person of (resBatSideOps.people || [])) {
      if (!person.fullName) continue;
      const name = _bsNorm(person.fullName);
      if (person.batSide?.code) {
        batterHandByName[name] = person.batSide.code;
        if (person.id) batterHandById[person.id] = person.batSide.code;
      }
      const ops = person.stats?.[0]?.splits?.[0]?.stat?.ops;
      if (ops != null) hitterOpsMap[name] = parseFloat(parseFloat(ops).toFixed(3));
      const pid = person.id;
      const s26 = pid ? playerStats26[pid] : null;
      const s25 = pid ? playerStats25[pid] : null;
      const pa = (s26?.g >= 20) ? s26.pa : ((s26?.pa ?? 0) + (s25?.pa ?? 0));
      const g  = (s26?.g >= 20) ? s26.g  : ((s26?.g  ?? 0) + (s25?.g  ?? 0));
      if (g >= 20 && pa > 0) hitterTypicalPA[name] = parseFloat((pa / g).toFixed(2));
    }
    const LEAGUE_K = 0.222; // MLB average K rate fallback
    // Regression-to-mean: blend 2026 with 2025 anchor weighted by PA
    // At 100+ PA trust 2026 fully; below that blend proportionally toward 2025 (or league avg)
    const regressBatterK = (id, code) => {
      const sp26 = code ? playerSplits[id]?.[code] : null;
      const s26 = playerStats26[id];
      const s25 = playerStats25[id];
      // Best 2026 estimate: use hand split if 10+ PA, else overall 2026
      const k26 = (sp26 && sp26.pa >= 10) ? sp26.so / sp26.pa : (s26 && s26.pa > 0) ? s26.so / s26.pa : null;
      const pa26 = (sp26 && sp26.pa >= 10) ? sp26.pa : (s26?.pa || 0);
      // Anchor: 2025 overall if 50+ PA, else league avg
      const anchor = (s25 && s25.pa >= 50) ? s25.so / s25.pa : LEAGUE_K;
      const trust = Math.min(1.0, pa26 / 100);
      return k26 !== null ? k26 * trust + anchor * (1 - trust) : anchor;
    };
    const lineupKPct = {}, lineupBatterKPcts = {}, lineupKPctVR = {}, lineupKPctVL = {};
    const lineupBatterKPctsOrdered = {}, lineupBatterKPctsVROrdered = {}, lineupBatterKPctsVLOrdered = {};
    // Per-team lineup hand composition (count of L/R/S bats among tonight's projected lineup).
    // Consumed by the totals lambda to weight pitcher vs-L/vs-R split modifiers by the actual
    // platoon mix the starter will face. Switch hitters' contribution resolves at consumer site
    // based on the opposing starter's hand.
    const lineupHandByTeam = {};
    for (const [abbr, ids] of Object.entries(teamLineups)) {
      const soTotal = ids.reduce((s, id) => s + (playerStats[id]?.so || 0), 0);
      const paTotal = ids.reduce((s, id) => s + (playerStats[id]?.pa || 0), 0);
      if (paTotal > 0) lineupKPct[abbr] = parseFloat((soTotal / paTotal * 100).toFixed(1));
      // Unordered (used for log5Avg gate): regressed K% per qualified batter
      const batterKPcts = ids.filter(id => (playerStats26[id]?.pa || playerStats25[id]?.pa || 0) >= 20)
        .map(id => regressBatterK(id, null));
      if (batterKPcts.length >= 3) lineupBatterKPcts[abbr] = batterKPcts;
      for (const [code, out] of [["vr", lineupKPctVR], ["vl", lineupKPctVL]]) {
        const so = ids.reduce((s, id) => s + (playerSplits[id]?.[code]?.so || 0), 0);
        const pa = ids.reduce((s, id) => s + (playerSplits[id]?.[code]?.pa || 0), 0);
        if (pa >= 100) out[abbr] = parseFloat((so / pa * 100).toFixed(1));
      }
      // Ordered per-batter regressed K% arrays for Monte Carlo simulation
      if (ids.length >= 8) {
        lineupBatterKPctsOrdered[abbr]   = ids.map(id => regressBatterK(id, null));
        lineupBatterKPctsVROrdered[abbr] = ids.map(id => regressBatterK(id, "vr"));
        lineupBatterKPctsVLOrdered[abbr] = ids.map(id => regressBatterK(id, "vl"));
      }
      // Hand mix for split-modifier consumers.
      let _l = 0, _r = 0, _s = 0;
      for (const id of ids) {
        const h = batterHandById[id];
        if (h === "L") _l++;
        else if (h === "R") _r++;
        else if (h === "S") _s++;
      }
      if (_l + _r + _s >= 6) lineupHandByTeam[abbr] = { l: _l, r: _r, s: _s };
    }
    // Fallback: for any team playing today that still has no lineupKPct (e.g. MLB API returned
    // empty lineup hydration for recent games), fetch team-level batting stats as a proxy.
    const teamsWithNoData = Object.keys(teamsInTodayGames).filter((abbr) => lineupKPct[abbr] == null);
    if (teamsWithNoData.length > 0) {
      const teamStatsRes = await fetch(
        "https://statsapi.mlb.com/api/v1/teams/stats?season=2026&group=batting&gameType=R&sportId=1",
        { headers: { "User-Agent": "Mozilla/5.0" } }
      ).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
      // Response shape: { stats: [{ splits: [{ team: { id }, stat: { strikeOuts, plateAppearances } }] }] }
      for (const split of teamStatsRes.stats?.[0]?.splits || []) {
        const abbr = MLB_ID_TO_ABBR[split.team?.id];
        if (abbr && teamsWithNoData.includes(abbr)) {
          const so = split.stat?.strikeOuts || 0;
          const pa = split.stat?.plateAppearances || 0;
          if (pa >= 50) lineupKPct[abbr] = parseFloat((so / pa * 100).toFixed(1));
        }
      }
    }
    return { lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered, lineupSpotByName, gameHomeTeams, projectedLineupTeams: [...projectedLineupTeams], batterSplitBA, hitterOpsMap, batterHandByName, batterHRRSplits, lineupHandByTeam, hitterTypicalPA };
  } catch (err) {
    console.error("[buildLineupKPct] failed:", err?.message || err);
    return { lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {}, lineupBatterKPctsOrdered: {}, lineupBatterKPctsVROrdered: {}, lineupBatterKPctsVLOrdered: {}, lineupSpotByName: {}, gameHomeTeams: {}, projectedLineupTeams: [], batterSplitBA: {}, hitterOpsMap: {}, batterHandByName: {}, batterHRRSplits: {}, lineupHandByTeam: {}, hitterTypicalPA: {} };
  }
}

export async function buildBarrelPct() {
  try {
    const url = "https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=2026&position=&team=&min=1&csv=true";
    const ac = new AbortController();
    const _t = setTimeout(() => ac.abort(), 5000);
    const text = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ac.signal }).then(r => { clearTimeout(_t); return r.ok ? r.text() : ""; }).catch(() => "");
    if (!text) return {};
    const _norm = n => n ? n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : "";
    // Simple CSV tokenizer that respects double-quoted fields
    const parseRow = row => {
      const fields = []; let cur = "", inQ = false;
      for (const ch of row) {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === "," && !inQ) { fields.push(cur); cur = ""; continue; }
        cur += ch;
      }
      fields.push(cur);
      return fields;
    };
    const lines = text.replace(/^\ufeff/, "").split("\n");
    const header = parseRow(lines[0]);
    const nameIdx = header.indexOf("last_name, first_name");
    const brlIdx = header.indexOf("brl_percent");
    if (nameIdx === -1 || brlIdx === -1) return {};
    const result = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = parseRow(line);
      const rawName = fields[nameIdx]; // "Last, First"
      const brl = parseFloat(fields[brlIdx]);
      if (!rawName || isNaN(brl)) continue;
      const comma = rawName.indexOf(",");
      if (comma === -1) continue;
      const last = rawName.slice(0, comma).trim();
      const first = rawName.slice(comma + 1).trim();
      result[_norm(`${first} ${last}`)] = brl;
    }
    return result;
  } catch (e) {
    return {};
  }
}
