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
      const start = new Date(today.getTime() - 7 * 864e5).toISOString().slice(0, 10);
      const recentSched = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=lineups`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      ).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
      const recentLineups = {};
      const recentLineupPlayers = {};
      for (const date of [...recentSched.dates || []].reverse()) {
        for (const game of date.games || []) {
          const hAbbr = MLB_ID_TO_ABBR[game.teams?.home?.team?.id] || game.teams?.home?.team?.abbreviation;
          const aAbbr = MLB_ID_TO_ABBR[game.teams?.away?.team?.id] || game.teams?.away?.team?.abbreviation;
          const hPlayers = game.lineups?.homePlayers || [];
          const aPlayers = game.lineups?.awayPlayers || [];
          const hIds = hPlayers.map((p) => p.id).filter(Boolean);
          const aIds = aPlayers.map((p) => p.id).filter(Boolean);
          if (hAbbr && !recentLineups[hAbbr] && hIds.length > 0) { recentLineups[hAbbr] = hIds; recentLineupPlayers[hAbbr] = hPlayers; }
          if (aAbbr && !recentLineups[aAbbr] && aIds.length > 0) { recentLineups[aAbbr] = aIds; recentLineupPlayers[aAbbr] = aPlayers; }
        }
        if (teamsNeedingProjection.every((abbr) => recentLineups[abbr])) break;
      }
      for (const abbr of teamsNeedingProjection) {
        if (recentLineups[abbr]) {
          teamLineups[abbr] = recentLineups[abbr];
          projectedLineupTeams.add(abbr);
          if (recentLineupPlayers[abbr]) _addLineupNames(abbr, recentLineupPlayers[abbr]);
        }
      }
    }
    const allIds = [...new Set(Object.values(teamLineups).flat())];
    if (allIds.length === 0) return { lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {}, lineupBatterKPctsOrdered: {}, lineupBatterKPctsVROrdered: {}, lineupBatterKPctsVLOrdered: {}, lineupSpotByName: {}, gameHomeTeams, projectedLineupTeams: [] };
    const idStr = allIds.join(",");
    const [res25, res26, resSplitVR, resSplitVL] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2025,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2026,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2026,sitCodes=vr,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=statSplits,season=2026,sitCodes=vl,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
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
    for (const [code, res] of [["vr", resSplitVR], ["vl", resSplitVL]]) {
      for (const person of res.people || []) {
        const pid = person.id;
        if (!pid) continue;
        const splits = person.stats?.[0]?.splits || [];
        const s = splits.find((x) => x.split?.code === code) || splits[0];
        if (!s?.stat) continue;
        if (!playerSplits[pid]) playerSplits[pid] = {};
        playerSplits[pid][code] = { so: s.stat.strikeOuts || 0, pa: s.stat.plateAppearances || 0 };
      }
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
    return { lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered, lineupSpotByName, gameHomeTeams, projectedLineupTeams: [...projectedLineupTeams] };
  } catch {
    return { lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {}, lineupBatterKPctsOrdered: {}, lineupBatterKPctsVROrdered: {}, lineupBatterKPctsVLOrdered: {}, lineupSpotByName: {}, gameHomeTeams: {}, projectedLineupTeams: [] };
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
    for (const date of mlbSched.dates || []) {
      for (const game of date.games || []) {
        const homeAbbr = MLB_ID_TO_ABBR[game.teams?.home?.team?.id] || game.teams?.home?.team?.abbreviation;
        const awayAbbr = MLB_ID_TO_ABBR[game.teams?.away?.team?.id] || game.teams?.away?.team?.abbreviation;
        const homeId = game.teams?.home?.probablePitcher?.id;
        const awayId = game.teams?.away?.probablePitcher?.id;
        const homeHand = game.teams?.home?.probablePitcher?.pitchHand?.code || null;
        const awayHand = game.teams?.away?.probablePitcher?.pitchHand?.code || null;
        if (homeAbbr && homeId) {
          pitcherByTeam[homeAbbr] = homeId;
          pitcherHand[homeAbbr] = homeHand;
        }
        if (awayAbbr && awayId) {
          pitcherByTeam[awayAbbr] = awayId;
          pitcherHand[awayAbbr] = awayHand;
        }
      }
    }
    const allIds = [...new Set(Object.values(pitcherByTeam))];
    if (allIds.length === 0) return { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherCSWPct: {}, pitcherAvgPitches: {}, pitcherGS26: {}, pitcherHasAnchor: {} };
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
      pitcherStats25[pid] = { so: split.strikeOuts || 0, bf: split.battersFaced || 0, bb: split.baseOnBalls || 0, era: safeEra(split.era), gs: split.gamesStarted || 0, np: split.numberOfPitches || 0 };
    }
    for (const person of (res26.people || [])) {
      const pid = person.id;
      if (!pid) continue;
      if (person.pitchHand?.code) pitcherHandById[pid] = person.pitchHand.code;
      const split = person.stats?.[0]?.splits?.[0]?.stat;
      if (!split) continue;
      pitcherStats26[pid] = { so: split.strikeOuts || 0, bf: split.battersFaced || 0, bb: split.baseOnBalls || 0, era: safeEra(split.era), gs: split.gamesStarted || 0, np: split.numberOfPitches || 0 };
    }
    // Fill in pitcherHand from People API for any missing entries
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      if (!pitcherHand[abbr] && pitcherHandById[id]) pitcherHand[abbr] = pitcherHandById[id];
    }
    const LEAGUE_PITCHER_K = 0.222;
    const pitcherKPct = {}, pitcherKBBPct = {}, pitcherEra = {}, pitcherHasAnchor = {};
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      const s26 = pitcherStats26[id];
      const s25 = pitcherStats25[id];
      // Regression-to-mean: blend 2026 actual with 2025 anchor weighted by 2026 BF only
      // trust = 2026 BF / 200 (full trust at 200 BF; ~33 starts in current season)
      const bf26 = s26?.bf || 0;
      const bf25 = s25?.bf || 0;
      const gs25 = s25?.gs || 0;
      // A reliever-turned-starter has bf25 > 0 but gs25 = 0 — reliever K% is not a valid starter anchor
      pitcherHasAnchor[abbr] = gs25 >= 5; // true = reliable 2025 starter anchor (5+ starts)
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
      // ERA: prefer 2026 if available (any starts), fall back to 2025
      const era26 = s26?.era ?? null;
      const era25 = s25?.era ?? null;
      if (era26 != null) pitcherEra[abbr] = era26;
      else if (era25 != null) pitcherEra[abbr] = era25;
    }
    // Avg pitches per start from season aggregates (already fetched above)
    const pitcherCSWPct = {};
    const pitcherAvgPitches = {};
    const pitcherGS26 = {};
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      const s26 = pitcherStats26[id];
      if (s26 && s26.gs > 0) pitcherGS26[abbr] = s26.gs;
      // Require >= 4 GS in 2026 for avg pitches to be reliable; fall back to 2025 if not
      if (s26 && s26.gs >= 4 && s26.np > 0) {
        pitcherAvgPitches[abbr] = parseFloat((s26.np / s26.gs).toFixed(1));
      } else {
        const s25 = pitcherStats25[id];
        if (s25 && s25.gs >= 1 && s25.np > 0) {
          pitcherAvgPitches[abbr] = parseFloat((s25.np / s25.gs).toFixed(1));
        }
      }
    }
    // Step 1: fetch game logs (needed for CSW% play-by-play gamePk lookup)
    let glFetch = [];
    try {
      glFetch = await Promise.all(
        allIds.map(id =>
          fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=2026&gameType=R`, { headers: { "User-Agent": "Mozilla/5.0" } })
            .then(r => r.ok ? r.json() : {}).catch(() => ({}))
            .then(d => ({ id, splits: d.stats?.[0]?.splits || [] }))
        )
      );
    } catch { /* game log fetch failed */ }
    // Fallback: compute pitcherAvgPitches from game logs for any pitcher where season aggregate lacked numberOfPitches
    for (const { id, splits } of glFetch) {
      const abbr = Object.keys(pitcherByTeam).find(a => pitcherByTeam[a] === id);
      if (!abbr || pitcherAvgPitches[abbr] != null) continue;
      const startSplits = splits.filter(s => (s.stat?.gamesStarted || 0) > 0);
      if (startSplits.length === 0) continue;
      const totalNP = startSplits.reduce((sum, s) => sum + (s.stat?.numberOfPitches || 0), 0);
      if (totalNP > 0) pitcherAvgPitches[abbr] = parseFloat((totalNP / startSplits.length).toFixed(1));
    }
    // Step 2: fetch play-by-play for CSW% (many concurrent requests, may time out on edge)
    try {
      const allGamePks = new Set();
      const pitcherGamePks = {};
      for (const { id, splits } of glFetch) {
        const gks = splits.map(s => s.game?.gamePk).filter(Boolean);
        pitcherGamePks[id] = gks;
        gks.forEach(gk => allGamePks.add(gk));
      }
      const PBP_FIELDS = "allPlays,matchup,pitcher,id,playEvents,isPitch,details,code";
      const pbpFetch = await Promise.all(
        [...allGamePks].map(gk =>
          fetch(`https://statsapi.mlb.com/api/v1/game/${gk}/playByPlay?fields=${PBP_FIELDS}`, { headers: { "User-Agent": "Mozilla/5.0" } })
            .then(r => r.ok ? r.json() : {}).catch(() => ({}))
            .then(d => ({ gk, plays: d.allPlays || [] }))
        )
      );
      const playsByGk = Object.fromEntries(pbpFetch.map(({ gk, plays }) => [gk, plays]));
      const CSW_CODES = new Set(["C", "S", "T", "W", "M", "Q"]);
      const cswByMlbId = {};
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
    return { pitcherKPct, pitcherKBBPct, pitcherHand, pitcherEra, pitcherCSWPct, pitcherAvgPitches, pitcherGS26, pitcherHasAnchor };
  } catch {
    return { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherCSWPct: {}, pitcherAvgPitches: {}, pitcherGS26: {}, pitcherHasAnchor: {} };
  }
}
