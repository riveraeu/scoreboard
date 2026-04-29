// MLB data fetchers: lineups, barrel%, pitcher stats.

export const MLB_ID_TO_ABBR = {
  108: "LAA",
  109: "ARI",
  110: "BAL",
  111: "BOS",
  112: "CHC",
  113: "CIN",
  114: "CLE",
  115: "COL",
  116: "DET",
  117: "HOU",
  118: "KC",
  119: "LAD",
  120: "WSH",
  121: "NYM",
  133: "ATH",
  134: "PIT",
  135: "SD",
  136: "SEA",
  137: "SF",
  138: "STL",
  139: "TB",
  140: "TEX",
  141: "TOR",
  142: "MIN",
  143: "PHI",
  144: "ATL",
  145: "CWS",
  146: "MIA",
  147: "NYY",
  158: "MIL"
};

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
      const recentSched = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=lineups`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      ).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
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
    const [res25, res26, resSplitVR, resSplitVL, resSplitVR25, resSplitVL25, resBatSideOps] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2025,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2026,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2026,sitCodes=vr,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2026,sitCodes=vl,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2025,sitCodes=vr,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2025,sitCodes=vl,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2026,gameType=R)&fields=people,id,fullName,batSide,stats,splits,stat,ops`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
    ]);
    const playerStats25 = {}, playerStats26 = {};
    for (const person of (res25.people || [])) {
      const pid = person.id; if (!pid) continue;
      const split = person.stats?.[0]?.splits?.[0]?.stat; if (!split) continue;
      playerStats25[pid] = { so: split.strikeOuts || 0, pa: split.plateAppearances || 0 };
    }
    for (const person of (res26.people || [])) {
      const pid = person.id; if (!pid) continue;
      const split = person.stats?.[0]?.splits?.[0]?.stat; if (!split) continue;
      playerStats26[pid] = { so: split.strikeOuts || 0, pa: split.plateAppearances || 0 };
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
    for (const person of (resBatSideOps.people || [])) {
      if (!person.fullName) continue;
      const name = _bsNorm(person.fullName);
      if (person.batSide?.code) batterHandByName[name] = person.batSide.code;
      const ops = person.stats?.[0]?.splits?.[0]?.stat?.ops;
      if (ops != null) hitterOpsMap[name] = parseFloat(parseFloat(ops).toFixed(3));
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
    return { lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered, lineupSpotByName, gameHomeTeams, projectedLineupTeams: [...projectedLineupTeams], batterSplitBA, hitterOpsMap, batterHandByName, batterHRRSplits };
  } catch (err) {
    console.error("[buildLineupKPct] failed:", err?.message || err);
    return { lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {}, lineupBatterKPctsOrdered: {}, lineupBatterKPctsVROrdered: {}, lineupBatterKPctsVLOrdered: {}, lineupSpotByName: {}, gameHomeTeams: {}, projectedLineupTeams: [], batterSplitBA: {}, hitterOpsMap: {}, batterHandByName: {}, batterHRRSplits: {} };
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

export async function buildPitcherKPct(mlbSched) {
  try {
    const pitcherByTeam = {};
    const pitcherHand = {};
    // Track ALL scheduled pitcher IDs — pitcherByTeam can be overwritten in same-matchup
    // doubleheaders (SD vs SEA twice), dropping the earlier pitcher's ID from allIds.
    // This set collects every ID seen so their stats are always fetched.
    const allScheduledPitcherIds = new Set();
    // umpireByGame: home plate umpire name keyed "homeAbbr|awayAbbr"
    // Populated from game.officials when hydrate=officials is included in the schedule fetch.
    const umpireByGame = {};
    for (const date of mlbSched.dates || []) {
      for (const game of date.games || []) {
        const homeAbbr = MLB_ID_TO_ABBR[game.teams?.home?.team?.id] || game.teams?.home?.team?.abbreviation;
        const awayAbbr = MLB_ID_TO_ABBR[game.teams?.away?.team?.id] || game.teams?.away?.team?.abbreviation;
        const homeId = game.teams?.home?.probablePitcher?.id;
        const awayId = game.teams?.away?.probablePitcher?.id;
        const homeHand = game.teams?.home?.probablePitcher?.pitchHand?.code || null;
        const awayHand = game.teams?.away?.probablePitcher?.pitchHand?.code || null;
        // Extract home plate umpire (populated when hydrate=officials is in schedule request)
        const _hp = (game.officials || []).find(o => o.officialType === "Home Plate");
        if (_hp?.official?.fullName && homeAbbr && awayAbbr) {
          umpireByGame[`${homeAbbr}|${awayAbbr}`] = _hp.official.fullName;
        }
        if (homeAbbr && homeId) {
          pitcherByTeam[homeAbbr] = homeId;
          pitcherHand[homeAbbr] = homeHand;
          // Also key by matchup so doubleheaders don't overwrite each other
          if (awayAbbr) { pitcherByTeam[`${homeAbbr}|${awayAbbr}`] = homeId; pitcherHand[`${homeAbbr}|${awayAbbr}`] = homeHand; }
        }
        if (awayAbbr && awayId) {
          pitcherByTeam[awayAbbr] = awayId;
          pitcherHand[awayAbbr] = awayHand;
          if (homeAbbr) { pitcherByTeam[`${awayAbbr}|${homeAbbr}`] = awayId; pitcherHand[`${awayAbbr}|${homeAbbr}`] = awayHand; }
        }
        if (homeId) allScheduledPitcherIds.add(homeId);
        if (awayId) allScheduledPitcherIds.add(awayId);
      }
    }
    const allIds = [...allScheduledPitcherIds];
    if (allIds.length === 0) return { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherCSWPct: {}, pitcherAvgPitches: {}, pitcherAvgBF: {}, pitcherStdBF: {}, pitcherGS26: {}, pitcherHasAnchor: {}, pitcherRecentKPct: {}, pitcherLastStartDate: {}, pitcherLastStartPC: {}, umpireByGame };
    const idStr = allIds.join(",");
    const [res25, res26] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=season,season=2025,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=season,season=2026,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
    ]);
    const pitcherStats25 = {}, pitcherStats26 = {};
    const pitcherHandById = {};
    const safeEra = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    for (const person of (res25.people || [])) {
      const pid = person.id;
      if (!pid) continue;
      if (person.pitchHand?.code) pitcherHandById[pid] = person.pitchHand.code;
      const split = person.stats?.[0]?.splits?.[0]?.stat;
      if (!split) continue;
      pitcherStats25[pid] = { so: split.strikeOuts || 0, bf: split.battersFaced || 0, bb: split.baseOnBalls || 0, era: safeEra(split.era), whip: safeEra(split.whip), gs: split.gamesStarted || 0, np: split.numberOfPitches || 0 };
    }
    for (const person of (res26.people || [])) {
      const pid = person.id;
      if (!pid) continue;
      if (person.pitchHand?.code) pitcherHandById[pid] = person.pitchHand.code;
      const split = person.stats?.[0]?.splits?.[0]?.stat;
      if (!split) continue;
      pitcherStats26[pid] = { so: split.strikeOuts || 0, bf: split.battersFaced || 0, bb: split.baseOnBalls || 0, era: safeEra(split.era), whip: safeEra(split.whip), gs: split.gamesStarted || 0, np: split.numberOfPitches || 0 };
    }
    // Fill in pitcherHand from People API for any missing entries
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      if (!pitcherHand[abbr] && pitcherHandById[id]) pitcherHand[abbr] = pitcherHandById[id];
    }
    const LEAGUE_PITCHER_K = 0.222;
    const pitcherKPct = {}, pitcherKBBPct = {}, pitcherEra = {}, pitcherWHIP = {}, pitcherHasAnchor = {};
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      const s26 = pitcherStats26[id];
      const s25 = pitcherStats25[id];
      // Regression-to-mean: blend 2026 actual with 2025 anchor weighted by 2026 BF only
      // trust = 2026 BF / 200 (full trust at 200 BF; ~33 starts in current season)
      const bf26 = s26?.bf || 0;
      const bf25 = s25?.bf || 0;
      const gs25 = s25?.gs || 0;
      // A reliever-turned-starter has bf25 > 0 but gs25 = 0 — reliever K% is not a valid starter anchor.
      // Also require bf25 >= 100 to exclude injury-shortened seasons (e.g. TJ recovery with 5 starts but minimal workload)
      pitcherHasAnchor[abbr] = gs25 >= 5 && bf25 >= 100; // true = reliable 2025 starter anchor (5+ starts, 100+ BF)
      const k26 = (s26 && bf26 > 0) ? s26.so / bf26 : null;
      const anchor = (s25 && bf25 >= 50) ? s25.so / bf25 : LEAGUE_PITCHER_K;
      const trust = Math.min(1.0, bf26 / 200);
      if (k26 !== null || bf25 >= 50) {
        const kRegressed = k26 !== null ? k26 * trust + anchor * (1 - trust) : anchor;
        pitcherKPct[abbr] = parseFloat((kRegressed * 100).toFixed(1));
        // KBB%: regress same way
        const kbb26 = (s26 && bf26 > 0) ? (s26.so - s26.bb) / bf26 : null;
        const anchorKBB = (s25 && bf25 >= 50) ? (s25.so - s25.bb) / bf25 : LEAGUE_PITCHER_K * 0.6;
        const kbbRegressed = kbb26 !== null ? kbb26 * trust + anchorKBB * (1 - trust) : anchorKBB;
        pitcherKBBPct[abbr] = parseFloat((kbbRegressed * 100).toFixed(1));
      }
      // ERA + WHIP: prefer 2026 if available (any starts), fall back to 2025
      const era26 = s26?.era ?? null;
      const era25 = s25?.era ?? null;
      if (era26 != null) pitcherEra[abbr] = era26;
      else if (era25 != null) pitcherEra[abbr] = era25;
      const whip26 = s26?.whip ?? null;
      const whip25 = s25?.whip ?? null;
      if (whip26 != null) pitcherWHIP[abbr] = whip26;
      else if (whip25 != null) pitcherWHIP[abbr] = whip25;
    }
    const pitcherCSWPct = {};
    const pitcherAvgPitches = {};
    const pitcherAvgPitchesById = {}; // per-ID version — used for overwritten pitchers in pitcherStatsByName
    const pitcherAvgBF = {};
    const pitcherAvgBFById = {};
    const pitcherStdBF = {};
    const pitcherStdBFById = {};
    const pitcherGS26 = {};
    // A1: Recent form (last 5 starts K%)
    const pitcherRecentKPct = {};
    const pitcherRecentKPctById = {};
    // A2: Rest (last start date + pitch count)
    const pitcherLastStartDate = {};
    const pitcherLastStartDateById = {};
    const pitcherLastStartPC = {};
    const pitcherLastStartPCById = {};
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      const s26 = pitcherStats26[id];
      if (s26 && s26.gs > 0) pitcherGS26[abbr] = s26.gs;
    }
    // Step 1: fetch game logs (2026 for avgP/avgBF/stdBF/recentK; also 2025 for H2H hand component)
    let glFetch = [], glFetch25 = [];
    try {
      const settle = arr => Promise.allSettled(arr).then(rs => rs.map((r, i) => r.status === 'fulfilled' ? r.value : { id: allIds[i], splits: [] }));
      [glFetch, glFetch25] = await Promise.all([
        settle(allIds.map(id =>
          fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=2026&gameType=R`, { headers: { "User-Agent": "Mozilla/5.0" } })
            .then(r => r.ok ? r.json() : {}).catch(() => ({}))
            .then(d => ({ id, splits: d.stats?.[0]?.splits || [] }))
        )),
        settle(allIds.map(id =>
          fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=2025&gameType=R`, { headers: { "User-Agent": "Mozilla/5.0" } })
            .then(r => r.ok ? r.json() : {}).catch(() => ({}))
            .then(d => ({ id, splits: d.stats?.[0]?.splits || [] }))
        ))
      ]);
    } catch (err) { console.error("[buildPitcherKPct] gamelog fetch failed:", err?.message || err); }
    // Avg pitches per start from 2026 game logs (starts-only — accurate for pitchers with mixed starter/reliever roles)
    // Falls back to 2025 season aggregate only when no 2026 start data exists in the gamelog.
    // Exclude today's date: the gamelog API includes in-progress game entries with gamesStarted=1
    // and partial pitch counts (e.g. gs=1, np=11 after 1 IP), which poisons the avg.
    const _todayStr = new Date().toISOString().slice(0, 10);
    for (const { id, splits } of glFetch) {
      // Find ALL keys (team key + matchup keys) that map to this pitcher id.
      // Using filter() instead of find() ensures doubleheader matchup keys all get
      // the correct value (e.g. "SD|SEA" = Vasquez's avg even if "SD" was overwritten
      // by a makeup-game pitcher that processed later in the schedule loop).
      const abbrs = Object.keys(pitcherByTeam).filter(a => pitcherByTeam[a] === id);
      // Note: do NOT skip if abbrs is empty — overwritten pitchers still need pitcherAvgPitchesById set.
      // NP >= 30 guards against in-progress games where the date filter fails due to UTC vs local
      // date mismatch (e.g. game is "2026-04-15" local but server UTC reads "2026-04-16" as today,
      // so date !== _todayStr passes and a 2-pitch partial start poisons the average).
      const startSplits = splits.filter(s => (s.stat?.gamesStarted || 0) > 0 && s.date !== _todayStr && (s.stat?.numberOfPitches || 0) >= 30);
      const totalNP = startSplits.reduce((sum, s) => sum + (s.stat?.numberOfPitches || 0), 0);
      const totalBF = startSplits.reduce((sum, s) => sum + (s.stat?.battersFaced || 0), 0);
      const s26 = pitcherStats26[id];
      const s25 = pitcherStats25[id];
      let avgP = null;
      if (startSplits.length > 0 && totalNP > 0) {
        avgP = parseFloat((totalNP / startSplits.length).toFixed(1));
      } else if (s26 && s26.gs >= 1 && s26.np > 0) {
        // Gamelog NP missing or zero → fall back to 2026 season aggregate
        avgP = parseFloat((s26.np / s26.gs).toFixed(1));
      } else if (s25 && s25.gs >= 1 && s25.np > 0) {
        // No 2026 data → fall back to 2025 season aggregate
        avgP = parseFloat((s25.np / s25.gs).toFixed(1));
      }
      if (avgP !== null) {
        pitcherAvgPitchesById[id] = avgP; // per-ID: used in pitcherStatsByName for overwritten pitchers
        for (const a of abbrs) pitcherAvgPitches[a] = avgP;
      }
      // avgBF: empirical batters faced per start — direct measure of pitcher volume,
      // avoids the 3.85 pitches/PA league-average constant used in expectedBF.
      let avgBF = null;
      if (startSplits.length > 0 && totalBF > 0) {
        avgBF = parseFloat((totalBF / startSplits.length).toFixed(1));
      } else if (s26 && s26.gs >= 1 && s26.bf > 0) {
        avgBF = parseFloat((s26.bf / s26.gs).toFixed(1));
      } else if (s25 && s25.gs >= 1 && s25.bf > 0) {
        avgBF = parseFloat((s25.bf / s25.gs).toFixed(1));
      }
      if (avgBF !== null) {
        pitcherAvgBFById[id] = avgBF;
        for (const a of abbrs) pitcherAvgBF[a] = avgBF;
      }
      // stdBF: standard deviation of BF per start — captures "all-or-nothing" vs "steady" arms.
      // Single-pass sum-of-squares is safe: BF values in [15,35], n ≤ 35 starts, no precision risk.
      // Requires countBF >= 3 to avoid hallucinating variance from 1–2 starts.
      if (startSplits.length >= 3 && totalBF > 0) {
        const n = startSplits.length;
        const sqSum = startSplits.reduce((s, sp) => s + (sp.stat?.battersFaced || 0) ** 2, 0);
        const mean = totalBF / n;
        const variance = sqSum / n - mean * mean;
        if (variance > 0) {
          const stdBFVal = parseFloat(Math.sqrt(variance).toFixed(2));
          pitcherStdBFById[id] = stdBFVal;
          for (const a of abbrs) pitcherStdBF[a] = stdBFVal;
        }
      }
      // A1: Recent form — last 5 starts K% (min 30 total BF to trust the sample).
      // Uses a looser filter than avgPitches: any completed start regardless of NP.
      // Date guard already prevents in-progress games; r5BF >= 30 ensures enough total sample.
      // This allows pitch-count-limited starts (e.g. NP 25) to count toward the recent window.
      const a1Splits = splits.filter(s => (s.stat?.gamesStarted || 0) > 0 && s.date !== _todayStr);
      const recent5 = a1Splits.slice(-5);
      const r5K = recent5.reduce((s, sp) => s + (sp.stat?.strikeOuts || 0), 0);
      const r5BF = recent5.reduce((s, sp) => {
        if (sp.stat?.battersFaced) return s + sp.stat.battersFaced;
        const ip = parseFloat(sp.stat?.inningsPitched || 0);
        return s + (Math.floor(ip) * 3 + Math.round((ip % 1) * 10));
      }, 0);
      const _recentKPct = (recent5.length >= 3 && r5BF >= 30) ? parseFloat((r5K / r5BF * 100).toFixed(1)) : null;
      if (_recentKPct !== null) {
        pitcherRecentKPctById[id] = _recentKPct;
        for (const a of abbrs) pitcherRecentKPct[a] = _recentKPct;
      }
      // A2: Rest — last start date + pitch count
      const _lastSplit = startSplits.length > 0 ? startSplits[startSplits.length - 1] : null;
      const _lastStartDate = _lastSplit?.date ?? null;
      const _lastStartPC = _lastSplit?.stat?.numberOfPitches ?? null;
      if (_lastStartDate) {
        pitcherLastStartDateById[id] = _lastStartDate;
        for (const a of abbrs) pitcherLastStartDate[a] = _lastStartDate;
      }
      if (_lastStartPC != null) {
        pitcherLastStartPCById[id] = _lastStartPC;
        for (const a of abbrs) pitcherLastStartPC[a] = _lastStartPC;
      }
    }
    // Step 2: fetch play-by-play for CSW% (many concurrent requests, may time out on edge)
    // Limit to last 5 starts per pitcher to cap the number of PBP requests.
    // AbortController gives the entire block an 8s budget — if slow, CSW% falls back to K%.
    // Declared outside the try so pitcherStatsByName can access it for overwritten pitchers.
    const cswByMlbId = {};
    try {
      const allGamePks = new Set();
      const pitcherGamePks = {};
      for (const { id, splits } of glFetch) {
        const gks = splits.slice(0, 5).map(s => s.game?.gamePk).filter(Boolean);
        pitcherGamePks[id] = gks;
        gks.forEach(gk => allGamePks.add(gk));
      }
      const PBP_FIELDS = "allPlays,matchup,pitcher,id,playEvents,isPitch,details,code";
      const _pbpAc = new AbortController();
      const _pbpTimer = setTimeout(() => _pbpAc.abort(), 5000);
      const pbpFetch = await Promise.all(
        [...allGamePks].map(gk =>
          fetch(`https://statsapi.mlb.com/api/v1/game/${gk}/playByPlay?fields=${PBP_FIELDS}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: _pbpAc.signal })
            .then(r => r.ok ? r.json() : {}).catch(() => ({}))
            .then(d => ({ gk, plays: d.allPlays || [] }))
        )
      );
      clearTimeout(_pbpTimer);
      const playsByGk = Object.fromEntries(pbpFetch.map(({ gk, plays }) => [gk, plays]));
      const CSW_CODES = new Set(["C", "S", "T", "W", "M", "Q"]);
      for (const { id, splits } of glFetch) {
        let totalCSW = 0, totalPitches = 0;
        for (const s of splits) {
          const gk = s.game?.gamePk;
          const plays = gk ? (playsByGk[gk] || []) : [];
          for (const play of plays) {
            if (play.matchup?.pitcher?.id !== id) continue;
            for (const ev of play.playEvents || []) {
              if (!ev.isPitch) continue;
              totalPitches++;
              if (CSW_CODES.has(ev.details?.code)) totalCSW++;
            }
          }
        }
        if (totalPitches >= 30) cswByMlbId[id] = parseFloat((totalCSW / totalPitches * 100).toFixed(1));
      }
      for (const [abbr, id] of Object.entries(pitcherByTeam)) {
        if (cswByMlbId[id] != null) pitcherCSWPct[abbr] = cswByMlbId[id];
      }
    } catch { /* CSW% unavailable — filter falls back to K% */ }
    // pitcherH2HStarts: combined 2025+2026 completed starts with oppAbbr + strikeouts per game.
    // Used for K H2H hand component — needs game-level opponent to filter by hand majority.
    // No NP filter (unlike startSplits); any completed start qualifies.
    const pitcherH2HStartsById = {};
    for (const { id, splits } of [...glFetch25, ...glFetch]) {
      if (!pitcherH2HStartsById[id]) pitcherH2HStartsById[id] = [];
      const starts = splits
        .filter(s => (s.stat?.gamesStarted || 0) > 0 && s.date !== _todayStr)
        .map(s => ({
          oppAbbr: s.opponent?.abbreviation ?? null,
          strikeouts: s.stat?.strikeOuts ?? 0,
        }));
      pitcherH2HStartsById[id].push(...starts);
    }
    const pitcherH2HStarts = {};
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      if (pitcherH2HStartsById[id]?.length) pitcherH2HStarts[abbr] = pitcherH2HStartsById[id];
    }
    // Name-keyed map: for MLB strikeout plays the player IS the pitcher.
    // Primary path: abbrs found in pitcherByTeam — uses per-abbr stats directly.
    // Fallback path: overwritten pitcher (same-matchup doubleheader, e.g. SD vs SEA twice) —
    //   pitcherByTeam["SD"] and ["SD|SEA"] both point to the second game's pitcher, so the
    //   first game's pitcher has no abbr entry. We detect this via allScheduledPitcherIds and
    //   compute stats directly from the raw ID-keyed data (pitcherStats26/25, cswByMlbId, etc.).
    const pitcherStatsByName = {};
    const _nn = n => (n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    for (const person of [...(res26.people || []), ...(res25.people || [])]) {
      const id = person.id;
      if (!id || !person.fullName) continue;
      const name = _nn(person.fullName);
      if (pitcherStatsByName[name]) continue; // prefer res26 (iterated first)
      const abbrs = Object.keys(pitcherByTeam).filter(a => pitcherByTeam[a] === id);
      if (abbrs.length > 0) {
        const a = abbrs[0]; // stats are same regardless of which abbr we pick
        pitcherStatsByName[name] = {
          hand: pitcherHand[a] ?? null,
          kPct: pitcherKPct[a] ?? null,
          kbbPct: pitcherKBBPct[a] ?? null,
          era: pitcherEra[a] ?? null,
          cswPct: pitcherCSWPct[a] ?? null,
          avgPitches: pitcherAvgPitches[a] ?? null,
          avgBF: pitcherAvgBF[a] ?? null,
          gs26: pitcherGS26[a] ?? null,
          hasAnchor: pitcherHasAnchor[a] ?? null,
          recentKPct: pitcherRecentKPct[a] ?? null,     // A1
          lastStartDate: pitcherLastStartDate[a] ?? null, // A2
          lastStartPC: pitcherLastStartPC[a] ?? null,    // A2
        };
      } else if (allScheduledPitcherIds.has(id)) {
        // Overwritten pitcher — compute stats directly from raw ID-keyed data
        const s26 = pitcherStats26[id];
        const s25 = pitcherStats25[id];
        if (!s26 && !s25) continue;
        const bf26 = s26?.bf || 0;
        const bf25 = s25?.bf || 0;
        const gs25 = s25?.gs || 0;
        const k26 = (s26 && bf26 > 0) ? s26.so / bf26 : null;
        const anchor = (s25 && bf25 >= 50) ? s25.so / bf25 : LEAGUE_PITCHER_K;
        const trust = Math.min(1.0, bf26 / 200);
        let kPct = null, kbbPct = null;
        if (k26 !== null || bf25 >= 50) {
          const kRegressed = k26 !== null ? k26 * trust + anchor * (1 - trust) : anchor;
          kPct = parseFloat((kRegressed * 100).toFixed(1));
          const kbb26 = (s26 && bf26 > 0) ? (s26.so - s26.bb) / bf26 : null;
          const anchorKBB = (s25 && bf25 >= 50) ? (s25.so - s25.bb) / bf25 : LEAGUE_PITCHER_K * 0.6;
          const kbbRegressed = kbb26 !== null ? kbb26 * trust + anchorKBB * (1 - trust) : anchorKBB;
          kbbPct = parseFloat((kbbRegressed * 100).toFixed(1));
        }
        pitcherStatsByName[name] = {
          hand: pitcherHandById[id] ?? null,
          kPct,
          kbbPct,
          era: (s26?.era ?? null) ?? (s25?.era ?? null),
          cswPct: cswByMlbId[id] ?? null,
          avgPitches: pitcherAvgPitchesById[id] ?? null,
          avgBF: pitcherAvgBFById[id] ?? null,
          stdBF: pitcherStdBFById[id] ?? 0,
          gs26: (s26?.gs > 0 ? s26.gs : null),
          hasAnchor: gs25 >= 5 && bf25 >= 100,
          recentKPct: pitcherRecentKPctById[id] ?? null,     // A1
          lastStartDate: pitcherLastStartDateById[id] ?? null, // A2
          lastStartPC: pitcherLastStartPCById[id] ?? null,    // A2
        };
      }
    }
    // pitcherInfoByTeam: team abbr → {name, id} from MLB Stats API probables
    // Used as a fallback when ESPN scoreboard hasn't announced probables yet.
    const pitcherInfoByTeam = {};
    for (const person of [...(res26.people || []), ...(res25.people || [])]) {
      const id = person.id;
      if (!id || !person.fullName) continue;
      const abbrs = Object.keys(pitcherByTeam).filter(a => pitcherByTeam[a] === id && !a.includes('|'));
      for (const a of abbrs) {
        if (!pitcherInfoByTeam[a]) pitcherInfoByTeam[a] = { name: person.fullName, id };
      }
    }
    return { pitcherKPct, pitcherKBBPct, pitcherHand, pitcherEra, pitcherWHIP, pitcherCSWPct, pitcherAvgPitches, pitcherAvgBF, pitcherStdBF, pitcherGS26, pitcherHasAnchor, pitcherStatsByName, pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC, umpireByGame, pitcherInfoByTeam, pitcherH2HStarts };
  } catch (err) {
    console.error("[buildPitcherKPct] failed:", err?.message || err);
    return { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherCSWPct: {}, pitcherAvgPitches: {}, pitcherAvgBF: {}, pitcherStdBF: {}, pitcherGS26: {}, pitcherHasAnchor: {}, pitcherRecentKPct: {}, pitcherLastStartDate: {}, pitcherLastStartPC: {}, umpireByGame: {}, pitcherInfoByTeam: {}, pitcherH2HStarts: {} };
  }
}
