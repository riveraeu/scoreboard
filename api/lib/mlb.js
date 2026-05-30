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
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=batting,type=season,season=2026,gameType=R)&fields=people,id,fullName,batSide,code,stats,splits,stat,ops`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
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

export async function buildPitcherKPct(mlbSched) {
  try {
    const pitcherByTeam = {};
    const pitcherHand = {};
    // Track ALL scheduled pitcher IDs — pitcherByTeam can be overwritten in same-matchup
    // doubleheaders (SD vs SEA twice), dropping the earlier pitcher's ID from allIds.
    // This set collects every ID seen so their stats are always fetched.
    const allScheduledPitcherIds = new Set();
    // pitcherIdByGame: per-game pitcher id keyed "{team}|{gameKey}" where gameKey is the
    // ESPN-style ISO (no seconds) — lets the frontend show the right pitcher per DH card.
    // MLB Stats API gameDate is "2026-05-24T16:35:00Z"; ESPN's event.date is "2026-05-24T16:35Z".
    // Trim seconds so the two sources line up on the same key.
    const _trimSec = (iso) => (iso ? iso.replace(/:\d{2}Z$/, "Z") : null);
    const pitcherIdByGame = {};
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
        const gameKey = _trimSec(game.gameDate);
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
          if (gameKey) pitcherIdByGame[`${homeAbbr}|${gameKey}`] = homeId;
        }
        if (awayAbbr && awayId) {
          pitcherByTeam[awayAbbr] = awayId;
          pitcherHand[awayAbbr] = awayHand;
          if (homeAbbr) { pitcherByTeam[`${awayAbbr}|${homeAbbr}`] = awayId; pitcherHand[`${awayAbbr}|${homeAbbr}`] = awayHand; }
          if (gameKey) pitcherIdByGame[`${awayAbbr}|${gameKey}`] = awayId;
        }
        if (homeId) allScheduledPitcherIds.add(homeId);
        if (awayId) allScheduledPitcherIds.add(awayId);
      }
    }
    const allIds = [...allScheduledPitcherIds];
    if (allIds.length === 0) return { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherWins: {}, pitcherLosses: {}, pitcherCSWPct: {}, pitcherAvgPitches: {}, pitcherAvgBF: {}, pitcherStdBF: {}, pitcherGS26: {}, pitcherHasAnchor: {}, pitcherRecentKPct: {}, pitcherLastStartDate: {}, pitcherLastStartPC: {}, umpireByGame, pitcherIdByGame, pitcherEraById: {}, pitcherWinsById: {}, pitcherLossesById: {}, pitcherNameById: {} };
    const idStr = allIds.join(",");
    const [res25, res26, resVL26, resVR26, resVL25, resVR25] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=season,season=2025,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=season,season=2026,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      // vs-L / vs-R splits for pitcher run-rate side. ERA isn't exposed on these endpoints (returns null),
      // but K/BB/HR/IP are — enough to compute split-FIP. WHIP is also exposed. We treat splits as a
      // multiplicative modifier on the regressed overall FIP/WHIP rather than standalone rates.
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=statSplits,season=2026,sitCodes=vl,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=statSplits,season=2026,sitCodes=vr,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=statSplits,season=2025,sitCodes=vl,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=statSplits,season=2025,sitCodes=vr,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
    ]);
    const pitcherStats25 = {}, pitcherStats26 = {};
    const pitcherSplits = {}; // pitcherSplits[id] = { vl26, vr26, vl25, vr25 } each with {so, bb, hbp, hr, ip, whip, bf}
    const _ingestSplit = (jres, side, year) => {
      for (const person of (jres.people || [])) {
        const pid = person.id;
        if (!pid) continue;
        const s = person.stats?.[0]?.splits?.[0]?.stat;
        if (!s || !s.battersFaced) continue;
        if (!pitcherSplits[pid]) pitcherSplits[pid] = {};
        pitcherSplits[pid][`${side}${year}`] = {
          so: s.strikeOuts || 0, bb: s.baseOnBalls || 0, hbp: s.hitByPitch || 0, hr: s.homeRuns || 0,
          ip: parseIP(s.inningsPitched), bf: s.battersFaced || 0, whip: parseFloat(s.whip) || null,
        };
      }
    };
    const pitcherHandById = {};
    const safeEra = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    // MLB Stats API returns inningsPitched as "45.2" meaning 45 ⅔ innings (NOT decimal).
    // ".0" → +0, ".1" → +1/3, ".2" → +2/3.
    const parseIP = (v) => {
      if (v == null || v === "") return 0;
      const s = String(v);
      const dot = s.indexOf(".");
      if (dot < 0) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }
      const whole = parseInt(s.slice(0, dot), 10) || 0;
      const frac = s.slice(dot + 1);
      return whole + (frac === "1" ? 1/3 : frac === "2" ? 2/3 : 0);
    };
    for (const person of (res25.people || [])) {
      const pid = person.id;
      if (!pid) continue;
      if (person.pitchHand?.code) pitcherHandById[pid] = person.pitchHand.code;
      const split = person.stats?.[0]?.splits?.[0]?.stat;
      if (!split) continue;
      pitcherStats25[pid] = { so: split.strikeOuts || 0, bf: split.battersFaced || 0, bb: split.baseOnBalls || 0, hbp: split.hitByPitch || 0, hr: split.homeRuns || 0, ip: parseIP(split.inningsPitched), era: safeEra(split.era), whip: safeEra(split.whip), gs: split.gamesStarted || 0, np: split.numberOfPitches || 0, w: split.wins || 0, l: split.losses || 0 };
    }
    for (const person of (res26.people || [])) {
      const pid = person.id;
      if (!pid) continue;
      if (person.pitchHand?.code) pitcherHandById[pid] = person.pitchHand.code;
      const split = person.stats?.[0]?.splits?.[0]?.stat;
      if (!split) continue;
      pitcherStats26[pid] = { so: split.strikeOuts || 0, bf: split.battersFaced || 0, bb: split.baseOnBalls || 0, hbp: split.hitByPitch || 0, hr: split.homeRuns || 0, ip: parseIP(split.inningsPitched), era: safeEra(split.era), whip: safeEra(split.whip), gs: split.gamesStarted || 0, np: split.numberOfPitches || 0, w: split.wins || 0, l: split.losses || 0 };
    }
    _ingestSplit(resVL26, "vl", "26");
    _ingestSplit(resVR26, "vr", "26");
    _ingestSplit(resVL25, "vl", "25");
    _ingestSplit(resVR25, "vr", "25");
    // Fill in pitcherHand from People API for any missing entries
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      if (!pitcherHand[abbr] && pitcherHandById[id]) pitcherHand[abbr] = pitcherHandById[id];
    }
    const LEAGUE_PITCHER_K = 0.222;
    const pitcherKPct = {}, pitcherKBBPct = {}, pitcherEra = {}, pitcherWHIP = {}, pitcherFIP = {}, pitcherHasAnchor = {};
    // Per-pitcher vs-L/vs-R split modifier vs overall. `pitcherSplitsByTeam[abbr] = { vlFipMod, vrFipMod,
    // vlWhipMod, vrWhipMod, vlBf, vrBf }` — modifier 1.0 means "no platoon effect"; > 1.0 means worse
    // vs that hand. Consumers compute lineup-weighted effective FIP/WHIP for the totals lambda.
    const pitcherSplitsByTeam = {}, pitcherSplitsById = {};
    const pitcherHasAnchorById = {};
    const pitcherWins = {}, pitcherLosses = {};
    // FIP constant aligns FIP onto the same numeric scale as ERA (~4.20 league baseline).
    // Slightly varies per season; 3.10 is a stable approximation for 2025–2026.
    const _FIP_CONST = 3.10;
    const _seasonFIP = (s) => {
      if (!s || !s.ip || s.ip < 1) return null;
      const raw = ((13 * s.hr) + (3 * (s.bb + s.hbp)) - (2 * s.so)) / s.ip + _FIP_CONST;
      return parseFloat(raw.toFixed(2));
    };
    // Two-step regression: (1) blend 2026↔2025 by trust26=min(1, gs26/15), (2) shrink the
    // blended estimate toward league mean with priorIP weight (Bayesian-style). Used for
    // ERA/WHIP (PRIOR_IP=50) and FIP (PRIOR_IP=30, since FIP stabilizes faster). The blended
    // sample size = full 2026 IP + (1−trust26) × 2025 IP so the league anchor pulls harder
    // on early-season pitchers without flattening true talent at full sample.
    const _regressedRate = (val26, ip26, val25, ip25, gs26, lgMean, priorIP) => {
      const has26 = val26 != null && ip26 >= 1;
      const has25 = val25 != null && ip25 >= 1;
      let blendedVal, blendedIp;
      if (has26 && has25) {
        const trust26 = Math.min(1, gs26 / 15);
        blendedVal = trust26 * val26 + (1 - trust26) * val25;
        blendedIp = ip26 + (1 - trust26) * ip25;
      } else if (has26) {
        blendedVal = val26; blendedIp = ip26;
      } else if (has25) {
        blendedVal = val25; blendedIp = ip25;
      } else {
        return null;
      }
      const shrunk = (blendedIp * blendedVal + priorIP * lgMean) / (blendedIp + priorIP);
      return parseFloat(shrunk.toFixed(2));
    };
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
      pitcherHasAnchorById[id] = pitcherHasAnchor[abbr]; // also key by ID so pitcherStatsByName can recover overwritten pitchers
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
      // ERA + WHIP: two-step regression (26↔25 sample-weighted blend, then league-anchor shrink).
      const _eraReg = _regressedRate(s26?.era ?? null, s26?.ip ?? 0, s25?.era ?? null, s25?.ip ?? 0, s26?.gs ?? 0, 4.20, 50);
      if (_eraReg != null) pitcherEra[abbr] = _eraReg;
      const _whipReg = _regressedRate(s26?.whip ?? null, s26?.ip ?? 0, s25?.whip ?? null, s25?.ip ?? 0, s26?.gs ?? 0, 1.30, 50);
      if (_whipReg != null) pitcherWHIP[abbr] = _whipReg;
      // W-L: prefer 2026 if pitcher has any 2026 starts, else 2025
      if ((s26?.gs ?? 0) > 0 || (s26?.w ?? 0) + (s26?.l ?? 0) > 0) {
        pitcherWins[abbr] = s26.w; pitcherLosses[abbr] = s26.l;
      } else if (s25 && ((s25.gs ?? 0) > 0 || (s25.w ?? 0) + (s25.l ?? 0) > 0)) {
        pitcherWins[abbr] = s25.w; pitcherLosses[abbr] = s25.l;
      }
      // FIP: same two-step regression as ERA/WHIP, with PRIOR_IP=30 (FIP stabilizes faster).
      // Computed per-season from raw HR/BB/HBP/K/IP, then blended + shrunk toward league mean.
      const fip26 = _seasonFIP(s26);
      const fip25 = _seasonFIP(s25);
      const _fipReg = _regressedRate(fip26, s26?.ip ?? 0, fip25, s25?.ip ?? 0, s26?.gs ?? 0, 4.20, 30);
      if (_fipReg != null) pitcherFIP[abbr] = _fipReg;
      // vs-L / vs-R modifiers (2026-05-25). For each side compute split FIP from raw count stats,
      // shrink toward the overall (not league mean) so the modifier reflects only the marginal
      // platoon signal. WHIP is exposed directly per split and gets the same shrinkage treatment.
      // Skip when overall FIP/WHIP is missing — modifier defaults to 1.0 (no adjustment).
      const splits = pitcherSplits[id];
      if (splits && pitcherFIP[abbr] != null && pitcherWHIP[abbr] != null) {
        const _SPLIT_PRIOR_IP = 20;  // pulls split values toward the overall FIP/WHIP
        const _splitFip = (s) => _seasonFIP(s);
        const _splitFipMod = (vl26, vl25) => {
          const f26 = _splitFip(vl26), f25 = _splitFip(vl25);
          const reg = _regressedRate(f26, vl26?.ip ?? 0, f25, vl25?.ip ?? 0, s26?.gs ?? 0, pitcherFIP[abbr], _SPLIT_PRIOR_IP);
          return reg != null ? parseFloat((reg / pitcherFIP[abbr]).toFixed(3)) : 1.0;
        };
        const _splitWhipMod = (vl26, vl25) => {
          const reg = _regressedRate(vl26?.whip ?? null, vl26?.ip ?? 0, vl25?.whip ?? null, vl25?.ip ?? 0, s26?.gs ?? 0, pitcherWHIP[abbr], _SPLIT_PRIOR_IP);
          return reg != null ? parseFloat((reg / pitcherWHIP[abbr]).toFixed(3)) : 1.0;
        };
        const entry = {
          vlFipMod: _splitFipMod(splits.vl26, splits.vl25),
          vrFipMod: _splitFipMod(splits.vr26, splits.vr25),
          vlWhipMod: _splitWhipMod(splits.vl26, splits.vl25),
          vrWhipMod: _splitWhipMod(splits.vr26, splits.vr25),
          vlBf: (splits.vl26?.bf ?? 0) + (splits.vl25?.bf ?? 0),
          vrBf: (splits.vr26?.bf ?? 0) + (splits.vr25?.bf ?? 0),
        };
        pitcherSplitsByTeam[abbr] = entry;
        pitcherSplitsById[id] = entry;
      }
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
    const pitcherGS26ById = {};
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      const s26 = pitcherStats26[id];
      if (s26 && s26.gs > 0) {
        pitcherGS26[abbr] = s26.gs;
        pitcherGS26ById[id] = s26.gs;
      }
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
      // Sample-weighted blend with 2025 anchor when 2026 sample is light.
      // trust26 = min(1, gs26/15) — fully trusts 2026 at 15+ starts (half-season).
      // Stabilizes early-season workload swings (e.g. Skenes 2026 avgP=81 ramp-up
      // vs 2025 ace baseline ~95) where the raw 2026 number drags expectedBF
      // below his actual outing length and tanks truePct on K markets.
      const _gs26 = s26?.gs ?? 0;
      const _trust26 = Math.min(1, _gs26 / 15);
      let avgP_2026 = null;
      if (startSplits.length > 0 && totalNP > 0) {
        avgP_2026 = totalNP / startSplits.length;
      } else if (s26 && s26.gs >= 1 && s26.np > 0) {
        avgP_2026 = s26.np / s26.gs;
      }
      const avgP_2025 = (s25 && s25.gs >= 1 && s25.np > 0) ? s25.np / s25.gs : null;
      let avgP = null;
      if (avgP_2026 !== null && avgP_2025 !== null) {
        avgP = parseFloat((_trust26 * avgP_2026 + (1 - _trust26) * avgP_2025).toFixed(1));
      } else if (avgP_2026 !== null) {
        avgP = parseFloat(avgP_2026.toFixed(1));
      } else if (avgP_2025 !== null) {
        avgP = parseFloat(avgP_2025.toFixed(1));
      }
      if (avgP !== null) {
        pitcherAvgPitchesById[id] = avgP; // per-ID: used in pitcherStatsByName for overwritten pitchers
        for (const a of abbrs) pitcherAvgPitches[a] = avgP;
      }
      // avgBF: empirical batters faced per start — direct measure of pitcher volume,
      // avoids the 3.85 pitches/PA league-average constant used in expectedBF.
      // Same trust26 blend as avgP so the two stay consistent.
      let avgBF_2026 = null;
      if (startSplits.length > 0 && totalBF > 0) {
        avgBF_2026 = totalBF / startSplits.length;
      } else if (s26 && s26.gs >= 1 && s26.bf > 0) {
        avgBF_2026 = s26.bf / s26.gs;
      }
      const avgBF_2025 = (s25 && s25.gs >= 1 && s25.bf > 0) ? s25.bf / s25.gs : null;
      let avgBF = null;
      if (avgBF_2026 !== null && avgBF_2025 !== null) {
        avgBF = parseFloat((_trust26 * avgBF_2026 + (1 - _trust26) * avgBF_2025).toFixed(1));
      } else if (avgBF_2026 !== null) {
        avgBF = parseFloat(avgBF_2026.toFixed(1));
      } else if (avgBF_2025 !== null) {
        avgBF = parseFloat(avgBF_2025.toFixed(1));
      }
      if (avgBF !== null) {
        pitcherAvgBFById[id] = avgBF;
        for (const a of abbrs) pitcherAvgBF[a] = avgBF;
      }
      // stdBF: standard deviation of BF per start — captures "all-or-nothing" vs "steady" arms.
      // Single-pass sum-of-squares is safe: BF values in [15,35], n ≤ 35 starts, no precision risk.
      // Requires countBF >= 3 to avoid hallucinating variance from 1–2 starts. Store 0 (rather
      // than skipping) when variance is 0 — distinguishes "consistent arm" from "no data" at
      // the downstream dataConfidence check.
      if (startSplits.length >= 3 && totalBF > 0) {
        const n = startSplits.length;
        const sqSum = startSplits.reduce((s, sp) => s + (sp.stat?.battersFaced || 0) ** 2, 0);
        const mean = totalBF / n;
        const variance = Math.max(0, sqSum / n - mean * mean);
        const stdBFVal = parseFloat(Math.sqrt(variance).toFixed(2));
        pitcherStdBFById[id] = stdBFVal;
        for (const a of abbrs) pitcherStdBF[a] = stdBFVal;
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
        return s + (Math.floor(ip) * 3 + Math.round(ip * 10) % 10);
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
        // For fields with a per-ID map, PREFER the ById lookup. The per-team maps overwrite when
        // multiple pitchers share a team key (NYM has Senga + Manaea + Megill + McLean — last one
        // wins). The ID-keyed map is per-pitcher so it always returns the correct value for the
        // person we're stamping. Without this, McLean (and any pitcher who isn't "last processed"
        // for their team) loses stdBF/gs26/hasAnchor/recentKPct/lastStart* even when their data
        // is computed and stored — they just can't be retrieved.
        pitcherStatsByName[name] = {
          hand: pitcherHandById[id] ?? pitcherHand[a] ?? null,
          kPct: pitcherKPct[a] ?? null,
          kbbPct: pitcherKBBPct[a] ?? null,
          era: pitcherEra[a] ?? null,
          cswPct: pitcherCSWPct[a] ?? null,
          avgPitches: pitcherAvgPitchesById[id] ?? pitcherAvgPitches[a] ?? null,
          avgBF: pitcherAvgBFById[id] ?? pitcherAvgBF[a] ?? null,
          stdBF: pitcherStdBFById[id] ?? pitcherStdBF[a] ?? null,
          gs26: pitcherGS26ById[id] ?? pitcherGS26[a] ?? null,
          hasAnchor: pitcherHasAnchorById[id] ?? pitcherHasAnchor[a] ?? null,
          recentKPct: pitcherRecentKPctById[id] ?? pitcherRecentKPct[a] ?? null,
          lastStartDate: pitcherLastStartDateById[id] ?? pitcherLastStartDate[a] ?? null,
          lastStartPC: pitcherLastStartPCById[id] ?? pitcherLastStartPC[a] ?? null,
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
    // Per-id ERA/W-L/name. The team-keyed pitcherEra/Wins/Losses above only iterate
    // pitcherByTeam, which holds one id per team — so for doubleheaders the earlier
    // pitcher's regressed values are never stored. This loop covers every scheduled
    // pitcher (including DH game-1 starters) so the API meta build can serve per-game
    // pitcher attribution via pitcherIdByGame → id → stats.
    const pitcherEraById = {};
    const pitcherWinsById = {};
    const pitcherLossesById = {};
    const pitcherNameById = {};
    for (const person of [...(res26.people || []), ...(res25.people || [])]) {
      if (person.id && person.fullName && !pitcherNameById[person.id]) {
        pitcherNameById[person.id] = person.fullName;
      }
    }
    for (const id of allScheduledPitcherIds) {
      const s26 = pitcherStats26[id];
      const s25 = pitcherStats25[id];
      const _eraReg = _regressedRate(s26?.era ?? null, s26?.ip ?? 0, s25?.era ?? null, s25?.ip ?? 0, s26?.gs ?? 0, 4.20, 50);
      if (_eraReg != null) pitcherEraById[id] = _eraReg;
      if ((s26?.gs ?? 0) > 0 || (s26?.w ?? 0) + (s26?.l ?? 0) > 0) {
        pitcherWinsById[id] = s26.w; pitcherLossesById[id] = s26.l;
      } else if (s25 && ((s25.gs ?? 0) > 0 || (s25.w ?? 0) + (s25.l ?? 0) > 0)) {
        pitcherWinsById[id] = s25.w; pitcherLossesById[id] = s25.l;
      }
    }
    return { pitcherKPct, pitcherKBBPct, pitcherHand, pitcherEra, pitcherWHIP, pitcherFIP, pitcherWins, pitcherLosses, pitcherCSWPct, pitcherAvgPitches, pitcherAvgBF, pitcherStdBF, pitcherGS26, pitcherHasAnchor, pitcherStatsByName, pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC, umpireByGame, pitcherInfoByTeam, pitcherH2HStarts, pitcherIdByGame, pitcherEraById, pitcherWinsById, pitcherLossesById, pitcherNameById, pitcherSplitsByTeam, pitcherSplitsById };
  } catch (err) {
    console.error("[buildPitcherKPct] failed:", err?.message || err);
    return { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherWHIP: {}, pitcherFIP: {}, pitcherWins: {}, pitcherLosses: {}, pitcherCSWPct: {}, pitcherAvgPitches: {}, pitcherAvgBF: {}, pitcherStdBF: {}, pitcherGS26: {}, pitcherHasAnchor: {}, pitcherRecentKPct: {}, pitcherLastStartDate: {}, pitcherLastStartPC: {}, umpireByGame: {}, pitcherInfoByTeam: {}, pitcherH2HStarts: {}, pitcherIdByGame: {}, pitcherEraById: {}, pitcherWinsById: {}, pitcherLossesById: {}, pitcherNameById: {} };
  }
}

// Full MLB byteam hydration pipeline. Single call that fetches every MLB upstream we need for
// /api/tonight and returns the consolidated byteam:mlb object. Also writes to cache with a
// partial-data guard (60s TTL when key fields are empty, 600s otherwise).
//
// Args:
//   cache  — Vercel KV / Upstash cache (CACHE2)
//   PT_FMT — Intl.DateTimeFormat for PT date strings (passed in to avoid re-importing pt.js)
//   parseGameOdds — utils helper (passed in to avoid cross-lib cycles)
import { parseGameOdds as _parseGameOdds } from "./utils.js";
import { PT_FMT } from "./pt.js";

// ESPN MLB injury report. Returns Map<teamAbbr, [{name, id, status}]> for Out / GTD players.
// Mirrors buildNhlInjuryReport / buildNbaInjuryReport — ESPN omits athlete.id but embeds it in
// playercard link href. ESPN uses CHW for Chicago White Sox; normalize to canonical CWS.
// Cached at mlb:injuries:{date} for 1800s (30 min).
export async function buildMlbInjuryReport(cache) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const cacheKey = `mlb:injuries:v4:${date}`;
    if (cache) {
      const cached = await cache.get(cacheKey, "json").catch(() => null);
      if (cached) {
        const m = new Map();
        for (const [k, v] of Object.entries(cached)) m.set(k, v);
        return m;
      }
    }
    const r = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries",
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
        // Only count FRESH absences — players whose unavailability is not already absorbed into
        // season RPG. EXCLUDES X-Day-IL stays (10-Day-IL / 15-Day-IL / 60-Day-IL): those players
        // have been replaced on the roster for weeks/months, and the team's road RPG already
        // reflects life without them.
        const isIl = statusRaw.includes("-day-il") || statusRaw.includes("60-day") || statusRaw.includes("15-day") || statusRaw.includes("10-day");
        if (isIl) continue;
        const isOut = statusRaw === "out";
        const isGtd = statusRaw === "day-to-day" || statusRaw === "questionable" || statusRaw === "doubtful" || statusRaw.includes("game-time");
        if (!isOut && !isGtd) continue;
        // SECOND filter: stale Day-To-Day. ESPN keeps backup IF/C guys on "Day-To-Day" for weeks
        // with a far-out expectedReturn while the team plays a replacement. If returnDate is more
        // than 3 days away, treat as long-term (already absorbed into team RPG, same as IL).
        // 3-day cutoff: real day-of scratches return within 1-2 days; "DTD with 4+ day return"
        // is effectively a soft IL stint.
        const returnDate = inj.details?.returnDate || inj.details?.expectedReturn || null;
        if (returnDate) {
          const retMs = Date.parse(returnDate);
          if (!isNaN(retMs) && (retMs - Date.now()) > 3 * 86400 * 1000) continue;
        }
        if (!abbr) abbr = inj.athlete?.team?.abbreviation || null;
        const name = inj.athlete?.displayName || "";
        let id = inj.athlete?.id ? String(inj.athlete.id) : null;
        if (!id) {
          for (const lk of (inj.athlete?.links || [])) {
            const m = (lk.href || "").match(/\/id\/(\d+)\//);
            if (m) { id = m[1]; break; }
          }
        }
        const pos = inj.athlete?.position?.abbreviation || null;
        if (name) outPlayers.push({ name, id, status: isOut ? "out" : "gtd", pos });
      }
      // ESPN MLB uses CHW for Chicago White Sox; canonical is CWS.
      const NORM = { CHW: "CWS" };
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

export async function buildMlbByteam(cache) {
  const [pitchData, batData, roadBatData, bullpenData, sbData, mlbSched] = await Promise.all([
    fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=pitching", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=batting", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    fetch("https://statsapi.mlb.com/api/v1/teams/stats?season=2026&group=batting&gameType=R&sportId=1&sitCodes=A", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    // Bullpen-only pitching aggregates (relievers, season). Lets MLB game-total lambda separate
    // the 40% rest-of-game share from the starter who's double-counted in teamERA.
    fetch("https://statsapi.mlb.com/api/v1/teams/stats?season=2026&group=pitching&gameType=R&sportId=1&playerPool=bullpen", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    (() => {
      // Always fetch today + tomorrow in parallel. sbData.events = today (probables/gameOdds);
      // sbData.eventsAll = today+tomorrow (gameScores, so both day tabs see scheduled/finished games).
      const _td0 = new Date(Date.now() - 7 * 3600 * 1000); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
      const _tfmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
      const _h = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
      return Promise.all([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_tfmt(_td0)}`, { headers: _h }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
        fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_tfmt(_td1)}`, { headers: _h }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      ]).then(([sb0, sb1]) => ({ events: sb0.events || [], eventsTomorrow: sb1.events || [], eventsAll: [...(sb0.events || []), ...(sb1.events || [])] }));
    })(),
    (() => {
      const _td0 = new Date(Date.now() - 7 * 3600 * 1000); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
      const _tfmt2 = (d) => d.toISOString().slice(0, 10);
      return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td0)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((s0) => {
        const allFinal = (s0.dates || []).flatMap((d) => d.games || []).every((g) => g.status?.abstractGameState === "Final");
        if ((s0.dates || []).length === 0 || allFinal) {
          return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td1)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
        }
        return s0;
      });
    })(),
  ]);

  // ESPN uses different abbreviations than Kalshi for some MLB teams
  const MLB_ESPN_NORM = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
  const normMlbAbbr = (a) => MLB_ESPN_NORM[a] || a;

  const probables = {};
  for (const event of sbData.events || []) {
    for (const comp of event.competitions || []) {
      const gameAbbrs = (comp.competitors || []).map((c) => normMlbAbbr(c.team?.abbreviation)).filter(Boolean);
      for (const competitor of comp.competitors || []) {
        const abbr = normMlbAbbr(competitor.team?.abbreviation);
        const probable = (competitor.probables || [])[0];
        if (!abbr || !probable) continue;
        const stats = probable.statistics || [];
        const eraStat = stats.find((s) => s.abbreviation === "ERA");
        const era = eraStat ? parseFloat(eraStat.displayValue) : null;
        const whipStat = stats.find((s) => s.abbreviation === "WHIP");
        const whip = whipStat ? parseFloat(whipStat.displayValue) : null;
        const name = probable.athlete?.displayName || probable.athlete?.fullName || null;
        const id = probable.athlete?.id || null;
        const opp = gameAbbrs.find((a) => a !== abbr) || null;
        probables[abbr] = { name, era, whip, id, opp };
      }
    }
  }
  const gameOddsRaw = _parseGameOdds(sbData.events);
  const gameOdds = Object.fromEntries(Object.entries(gameOddsRaw).map(([k, v]) => [normMlbAbbr(k), v]));
  const gameOddsTomorrowRaw = _parseGameOdds(sbData.eventsTomorrow || []);
  const gameOddsTomorrow = Object.fromEntries(Object.entries(gameOddsTomorrowRaw).map(([k, v]) => [normMlbAbbr(k), v]));
  // Game scores for matchup cards (includes finished games with no active Kalshi markets).
  // Iterate today+tomorrow merged events so both day tabs see scheduled/finished games.
  // Key includes gameDate (today vs tomorrow collision) AND event.date (same-day
  // doubleheader collision, e.g. DET @ BAL twice).
  const gameScores = {};
  for (const event of sbData.eventsAll || sbData.events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const homeComp = (comp.competitors || []).find(c => c.homeAway === "home");
    const awayComp = (comp.competitors || []).find(c => c.homeAway === "away");
    if (!homeComp || !awayComp) continue;
    const hA = normMlbAbbr(homeComp.team?.abbreviation), awA = normMlbAbbr(awayComp.team?.abbreviation);
    if (!hA || !awA) continue;
    const gsDate = event.date ? PT_FMT.format(new Date(event.date)) : null;
    const pickRecord = (recs) => {
      if (!Array.isArray(recs)) return null;
      const overall = recs.find(r => r?.type === "total" || r?.name === "overall");
      return overall?.summary ?? recs[0]?.summary ?? null;
    };
    gameScores[`${hA}|${gsDate ?? ""}|${event.date ?? ""}`] = {
      homeTeam: hA, awayTeam: awA,
      state: comp.status?.type?.state ?? "pre",
      detail: comp.status?.type?.shortDetail || comp.status?.type?.detail || "",
      homeScore: parseInt(homeComp.score ?? 0) || 0,
      awayScore: parseInt(awayComp.score ?? 0) || 0,
      gameDate: gsDate,
      gameTime: event.date || null,
      homeRecord: pickRecord(homeComp.records),
      awayRecord: pickRecord(awayComp.records),
      seasonType: event.season?.type ?? null,
    };
  }
  const [lineupResult, pitcherResult] = await Promise.all([buildLineupKPct(mlbSched), buildPitcherKPct(mlbSched)]);
  const { lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered, lineupSpotByName, gameHomeTeams, projectedLineupTeams, batterSplitBA, hitterOpsMap, batterHandByName, batterHRRSplits, lineupHandByTeam, hitterTypicalPA } = lineupResult;
  const { pitcherKPct, pitcherKBBPct, pitcherCSWPct, pitcherAvgPitches, pitcherAvgBF, pitcherStdBF, pitcherGS26, pitcherHasAnchor, pitcherHand, pitcherEra: pitcherEraByTeam, pitcherWHIP: pitcherWHIPByTeam, pitcherFIP: pitcherFIPByTeam, pitcherWins: pitcherWinsByTeam, pitcherLosses: pitcherLossesByTeam, pitcherStatsByName, pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC, umpireByGame, pitcherInfoByTeam, pitcherH2HStarts, pitcherIdByGame, pitcherEraById, pitcherWinsById, pitcherLossesById, pitcherNameById, pitcherSplitsByTeam, pitcherSplitsById } = pitcherResult;
  // barrelPctMap is NOT stored in byteam:mlb — it lives in mlb:barrelPct with its own 6h TTL.
  // This prevents a bust (which deletes byteam:mlb) from baking an empty barrelPctMap
  // into the cache when Baseball Savant is slow.

  // Road RPG (away-only batting) — strips home park bias before applying parkRF in lambda
  const roadRPGMap = {};
  for (const split of (roadBatData?.stats?.[0]?.splits || [])) {
    const _ra = MLB_ESPN_NORM[split.team?.abbreviation] || split.team?.abbreviation;
    if (!_ra) continue;
    const gp = split.stat?.gamesPlayed ?? 0;
    const runs = split.stat?.runs ?? 0;
    if (gp > 0 && runs > 0) roadRPGMap[_ra] = parseFloat((runs / gp).toFixed(2));
  }

  // Team platoon ratio (BA-proxy). MLB Stats API /teams/stats does not support pitcher-handedness
  // sitCodes (only A/H), so derived from individual batter splits in batterSplitBA.
  const _bsNormKey = (n) => n ? n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() : "";
  const teamPlatoonRPGMap = {};
  for (const [abbr, spotMap] of Object.entries(lineupResult.lineupSpotByName || {})) {
    let hL = 0, abL = 0, hR = 0, abR = 0;
    for (const name of Object.keys(spotMap)) {
      const splits = batterSplitBA[_bsNormKey(name)];
      if (!splits) continue;
      const aL = splits.vsLPA ?? 0, aR = splits.vsRPA ?? 0;
      if (splits.vsL != null && aL >= 10) { hL += splits.vsL * aL; abL += aL; }
      if (splits.vsR != null && aR >= 10) { hR += splits.vsR * aR; abR += aR; }
    }
    const totalAB = abL + abR;
    if (totalAB < 80) continue;
    const overallBA = (hL + hR) / totalAB;
    if (overallBA === 0) continue;
    teamPlatoonRPGMap[abbr] = {
      vl: abL >= 25 ? parseFloat(((hL / abL) / overallBA).toFixed(3)) : 1.0,
      vr: abR >= 25 ? parseFloat(((hR / abR) / overallBA).toFixed(3)) : 1.0,
    };
  }

  // Team ERA + WHIP (staff-wide). teamERA is the 60/40 bullpen-proxy fallback;
  // teamWHIP backs up SimScore when starter WHIP is missing (debut / late-announcement).
  const teamERAMap = {};
  const teamWHIPMap = {};
  const _ptCat = (pitchData?.categories || []).find(c => c.name === "pitching");
  const _eraIdx = (_ptCat?.names || []).findIndex(n => n === "ERA" || n === "era");
  const _whipIdx = (_ptCat?.names || []).findIndex(n => n === "WHIP" || n === "whip");
  if (_eraIdx !== -1 || _whipIdx !== -1) {
    for (const team of (pitchData?.teams || [])) {
      const _ta = MLB_ESPN_NORM[team.team?.abbreviation] || team.team?.abbreviation;
      if (!_ta) continue;
      const tc = (team.categories || []).find(c => c.name === "pitching");
      if (_eraIdx !== -1) {
        const era = parseFloat(tc?.values?.[_eraIdx] ?? NaN);
        if (!isNaN(era) && era > 0) teamERAMap[_ta] = era;
      }
      if (_whipIdx !== -1) {
        const whip = parseFloat(tc?.values?.[_whipIdx] ?? NaN);
        if (!isNaN(whip) && whip > 0) teamWHIPMap[_ta] = parseFloat(whip.toFixed(2));
      }
    }
  }

  // Bullpen-only ERA + WHIP per team (relievers, season). Replaces whole-staff teamERA in the
  // 40% rest-of-game share of game-total + team-total lambdas. MLB Stats API returns team by
  // `id` (no abbreviation), so we translate via MLB_ID_TO_ABBR.
  const bullpenERAMap = {};
  const bullpenWHIPMap = {};
  for (const split of (bullpenData?.stats?.[0]?.splits || [])) {
    const _abbr = MLB_ID_TO_ABBR[split.team?.id];
    if (!_abbr) continue;
    const era = parseFloat(split.stat?.era ?? NaN);
    if (!isNaN(era) && era > 0) bullpenERAMap[_abbr] = parseFloat(era.toFixed(2));
    const whip = parseFloat(split.stat?.whip ?? NaN);
    if (!isNaN(whip) && whip > 0) bullpenWHIPMap[_abbr] = parseFloat(whip.toFixed(2));
  }

  // staticTeamHandMajority: majority batting hand per team using natural side (S=0.5R+0.5L).
  // Used to filter pitcher's historical starts by opposing lineup handedness composition.
  // Switch hitters counted as neutral (0.5/0.5) here since we don't know each historical pitcher hand;
  // tonight's matchup uses the full per-pitcher adjustment in the K play loop.
  const staticTeamHandMajority = {};
  for (const [abbr, spotMap] of Object.entries(lineupSpotByName || {})) {
    let rCount = 0, lCount = 0;
    for (const name of Object.keys(spotMap)) {
      const hand = batterHandByName[_bsNormKey(name)];
      if (hand === 'R') rCount++;
      else if (hand === 'L') lCount++;
      else if (hand === 'S') { rCount += 0.5; lCount += 0.5; }
    }
    if (rCount + lCount > 0) staticTeamHandMajority[abbr] = rCount >= lCount ? 'R' : 'L';
  }

  const byteam = {
    pitching: pitchData, batting: batData, probables,
    lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL,
    lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered,
    lineupSpotByName, gameHomeTeams,
    pitcherKPct, pitcherKBBPct, pitcherCSWPct, pitcherAvgPitches, pitcherAvgBF, pitcherStdBF,
    pitcherGS26, pitcherHasAnchor, pitcherHand,
    pitcherEra: pitcherEraByTeam, pitcherWHIPByTeam, pitcherFIPByTeam, pitcherWinsByTeam, pitcherLossesByTeam,
    projectedLineupTeams, gameOdds, gameOddsTomorrow, pitcherStatsByName,
    batterSplitBA, hitterOpsMap, batterHandByName, batterHRRSplits, pitcherH2HStarts,
    staticTeamHandMajority,
    pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC,
    umpireByGame, pitcherInfoByTeam,
    pitcherIdByGame, pitcherEraById, pitcherWinsById, pitcherLossesById, pitcherNameById,
    pitcherSplitsByTeam, pitcherSplitsById, lineupHandByTeam, hitterTypicalPA,
    roadRPGMap, teamERAMap, teamWHIPMap, bullpenERAMap, bullpenWHIPMap,
    teamPlatoonRPGMap, gameScores,
  };

  // Use short TTL (60s) if key data is missing — lineup/probables not confirmed yet, or
  // independent MLB Stats API hydrations (OPS, pitcher gamelogs) silently returned empty.
  // Prevents partial data from baking into cache for the full 600s and starving downstream
  // SimScore columns (HRR OPS, K H2H Hand, platoon, recent K%).
  const _mlbDataReady = Object.keys(lineupSpotByName || {}).length > 0
    && Object.keys(pitcherAvgPitches || {}).length > 0
    && Object.keys(hitterOpsMap || {}).length > 0
    && Object.keys(pitcherH2HStarts || {}).length > 0;
  if (cache) await cache.put("byteam:mlb", JSON.stringify(byteam), { expirationTtl: _mlbDataReady ? 600 : 60 });

  return byteam;
}
