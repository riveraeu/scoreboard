// Sports-data endpoints: /api/live (boxscore polling), /api/plays/history,
// /api/leagues, /api/team. All self-contained — depend on ESPN site/scoreboard
// API and CACHE2 only.

import { PT_FMT } from "../pt.js";
import { jsonResponse, errorResponse } from "../utils.js";

export async function handleSportsRoutes(ctx) {
  const { path, method, params, env, CACHE2, VALID_SPORTS } = ctx;

  if (path === "live") {
    // Live in-game player stats for pick card tracking
    // ?games=mlb:LAD:SD,nba:GSW:LAL (sport:team1:team2, either home/away order)
    const gamesParam = (params.get("games") || "").trim();
    if (!gamesParam) return jsonResponse({});
    const dateParamRaw = (params.get("date") || "").trim();
    const ptDate = dateParamRaw
      ? (dateParamRaw.length === 8 ? `${dateParamRaw.slice(0,4)}-${dateParamRaw.slice(4,6)}-${dateParamRaw.slice(6,8)}` : dateParamRaw)
      : PT_FMT.format(new Date());
    const ptDateStr = ptDate.replace(/-/g, "");
    const SPORT_PATHS = { mlb: "baseball/mlb", nba: "basketball/nba", wnba: "basketball/wnba", nhl: "hockey/nhl" };

    const gameTuples = gamesParam.split(",").map(g => {
      const [sport, ...teams] = g.split(":");
      return { sport, key: g, teams: teams.map(t => t.toUpperCase()) };
    }).filter(g => SPORT_PATHS[g.sport] && g.teams.length >= 2);

    const bySport = {};
    for (const t of gameTuples) {
      if (!bySport[t.sport]) bySport[t.sport] = [];
      bySport[t.sport].push(t);
    }

    const liveResult = {};

    await Promise.all(Object.entries(bySport).map(async ([sport, tuples]) => {
      const sportPath = SPORT_PATHS[sport];

      const uncached = [];
      for (const tuple of tuples) {
        const cacheKey = `live:${sport}:${tuple.teams.slice().sort().join(":")}:${ptDate}`;
        const cached = CACHE2 ? await CACHE2.get(cacheKey, "json").catch(() => null) : null;
        if (cached) { liveResult[tuple.key] = cached; }
        else uncached.push({ ...tuple, cacheKey });
      }
      if (!uncached.length) return;

      let sbEvents = [];
      try {
        const sbRes = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/scoreboard?dates=${ptDateStr}`,
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
        );
        if (sbRes.ok) sbEvents = (await sbRes.json()).events || [];
      } catch {}

      // ESPN scoreboard returns different abbrs from our canonical for some teams.
      // Translate inputs → ESPN when matching events; translate ESPN's response → canonical
      // so downstream consumers (auto-resolver, totals/team-totals lookups keyed by pick.homeTeam)
      // see the same abbr the pick was tracked with.
      const CANONICAL_TO_ESPN = {
        mlb: { CWS: "CHW" },
        nba: { GSW: "GS", SAS: "SA", NYK: "NY", NOP: "NO", UTA: "UTAH", WAS: "WSH" },
        wnba: { CONN: "CON" },
        nhl: { TBL: "TB", NJD: "NJ", LAK: "LA", SJS: "SJ" },
      }[sport] || {};
      const ESPN_TO_CANONICAL = Object.fromEntries(
        Object.entries(CANONICAL_TO_ESPN).map(([k, v]) => [v, k])
      );
      const toEspn = a => CANONICAL_TO_ESPN[a] || a;
      const toCanonical = a => ESPN_TO_CANONICAL[a] || a;

      await Promise.all(uncached.map(async ({ key, teams, cacheKey }) => {
        const [t1, t2] = teams.map(toEspn);

        const event = sbEvents.find(ev => {
          const abbrs = (ev.competitions?.[0]?.competitors || [])
            .map(c => c.team?.abbreviation?.toUpperCase());
          return abbrs.includes(t1) && abbrs.includes(t2);
        });

        if (!event) { liveResult[key] = { state: "unknown" }; return; }

        const comp = event.competitions?.[0];
        const state = comp?.status?.type?.state ?? "pre";
        const detail = comp?.status?.type?.shortDetail || comp?.status?.type?.detail || "";
        const homeComp = (comp?.competitors || []).find(c => c.homeAway === "home");
        const awayComp = (comp?.competitors || []).find(c => c.homeAway === "away");
        const homeTeam = toCanonical(homeComp?.team?.abbreviation?.toUpperCase()) || null;
        const awayTeam = toCanonical(awayComp?.team?.abbreviation?.toUpperCase()) || null;
        const homeScore = parseInt(homeComp?.score) || 0;
        const awayScore = parseInt(awayComp?.score) || 0;

        if (state === "pre") {
          liveResult[key] = { state: "pre", detail, homeTeam, awayTeam, homeScore: 0, awayScore: 0 };
          return;
        }

        let players = {};
        try {
          const sumRes = await fetch(
            `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/summary?event=${event.id}`,
            { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
          );
          if (sumRes.ok) {
            const sum = await sumRes.json();

            if (sport === "mlb") {
              for (const teamData of sum.boxscore?.players || []) {
                for (const statsSection of teamData.statistics || []) {
                  const labels = (statsSection.labels || []).map(l => l.toUpperCase());
                  const hasPitching = labels.includes("IP");
                  const hasBatting = labels.includes("RBI") || labels.includes("AB");
                  const kIdx = labels.indexOf("K");
                  const ipIdx = labels.indexOf("IP");
                  const hIdx = labels.indexOf("H");
                  const rIdx = labels.indexOf("R");
                  const rbiIdx = labels.indexOf("RBI");

                  for (const ath of statsSection.athletes || []) {
                    const name = ath.athlete?.fullName || ath.athlete?.displayName;
                    if (!name) continue;
                    const s = ath.stats || [];
                    if (hasPitching && kIdx !== -1) {
                      players[name] = { strikeouts: parseInt(s[kIdx]) || 0, ip: s[ipIdx] ?? "0.0" };
                    } else if (hasBatting && hIdx !== -1) {
                      const h = parseInt(s[hIdx]) || 0;
                      const r = parseInt(s[rIdx]) || 0;
                      const rbi = parseInt(s[rbiIdx]) || 0;
                      players[name] = { hits: h, runs: r, rbi, hrr: h + r + rbi };
                    }
                  }
                }
              }
            } else if (sport === "nba" || sport === "wnba") {
              for (const teamData of sum.boxscore?.players || []) {
                const stats = teamData.statistics?.[0];
                if (!stats) continue;
                const labels = (stats.labels || []).map(l => l.toUpperCase());
                const ptsIdx = labels.indexOf("PTS");
                const rebIdx = labels.indexOf("REB");
                const astIdx = labels.indexOf("AST");
                const fg3Idx = ["3PM","3FG","3PT"].reduce((found, k) => found !== -1 ? found : labels.indexOf(k), -1);
                for (const ath of stats.athletes || []) {
                  const name = ath.athlete?.fullName || ath.athlete?.displayName;
                  if (!name) continue;
                  const s = ath.stats || [];
                  if (!s.length) continue;
                  players[name] = {
                    points:        parseInt(s[ptsIdx]) || 0,
                    rebounds:      parseInt(s[rebIdx]) || 0,
                    assists:       parseInt(s[astIdx]) || 0,
                    threePointers: fg3Idx !== -1 ? (parseInt(s[fg3Idx]) || 0) : 0,
                  };
                }
              }
            } else if (sport === "nhl") {
              for (const teamData of sum.boxscore?.players || []) {
                for (const stats of teamData.statistics || []) {
                  const labels = (stats.labels || []).map(l => l.toUpperCase());
                  const gIdx   = labels.indexOf("G");
                  if (gIdx === -1) continue;
                  const aIdx   = labels.indexOf("A");
                  const ptsIdx = labels.indexOf("PTS");
                  const toiIdx = labels.indexOf("TOI");
                  for (const ath of stats.athletes || []) {
                    const name = ath.athlete?.fullName || ath.athlete?.displayName;
                    if (!name) continue;
                    const s = ath.stats || [];
                    if (!s.length) continue;
                    const goals      = parseInt(s[gIdx]) || 0;
                    const assistsNhl = aIdx !== -1 ? (parseInt(s[aIdx]) || 0) : 0;
                    players[name] = {
                      goals, assistsNhl,
                      points: ptsIdx !== -1 ? (parseInt(s[ptsIdx]) || 0) : goals + assistsNhl,
                      toi: toiIdx !== -1 ? (s[toiIdx] ?? "0:00") : "0:00",
                    };
                  }
                }
              }
            }
          }
        } catch {}

        const gameData = { state, detail, players, homeTeam, awayTeam, homeScore, awayScore };
        liveResult[key] = gameData;
        if (CACHE2) {
          const ttl = state === "post" ? 300 : 60;
          await CACHE2.put(cacheKey, JSON.stringify(gameData), { expirationTtl: ttl }).catch(() => {});
        }
      }));
    }));

    return jsonResponse(liveResult);
  }

  if (path === "plays/history") {
    if (!CACHE2) return jsonResponse({ history: [] });
    const today = new Date();
    const dates = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const results = await Promise.all(dates.map(
      (d) => CACHE2.get(`plays:daily:${d}`, "json").catch(() => null)
    ));
    const history = results.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
    return jsonResponse({ history }, 300);
  }

  if (path === "leagues") {
    return jsonResponse({ leagues: VALID_SPORTS });
  }

  if (path === "team") {
    const abbr = (params.get("abbr") || "").toUpperCase();
    const sport = params.get("sport");
    if (!abbr || !["mlb","nba","nhl"].includes(sport)) return errorResponse("abbr and sport (mlb|nba|nhl) required", 400);
    const bust = params.get("bust") === "1";
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `team:v3:${sport}:${abbr}:${today}`;
    if (CACHE2 && !bust) {
      const cached = await CACHE2.get(cacheKey, "json").catch(() => null);
      if (cached) return jsonResponse(cached);
    }
    const sportLeague = { mlb:"baseball/mlb", nba:"basketball/nba", nhl:"hockey/nhl" }[sport];
    const abbrLower = abbr.toLowerCase();
    const H = { "User-Agent":"Mozilla/5.0" };
    let gameLog = [], teamName = abbr, wins = 0, losses = 0, nextGame = null, lastGameId = null;
    try {
      const schedRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sportLeague}/teams/${abbrLower}/schedule?season=2026&seasontype=2`, { headers: H });
      if (schedRes.ok) {
        const sched = await schedRes.json();
        teamName = sched.team?.displayName || sched.team?.name || abbr;
        const recSummary = sched.team?.recordSummary || sched.team?.record?.items?.[0]?.summary;
        if (recSummary) { const p = recSummary.split("-"); wins = parseInt(p[0]) || 0; losses = parseInt(p[1]) || 0; }
        for (const event of sched.events || []) {
          const comp = event.competitions?.[0];
          if (!comp?.status?.type?.completed) {
            const evDateStr = (event.date || "").slice(0, 10);
            const todayUtc = new Date().toISOString().slice(0, 10);
            if (!nextGame && evDateStr >= todayUtc) {
              const homeComp = comp.competitors?.find(c => c.homeAway === "home");
              const awayComp = comp.competitors?.find(c => c.homeAway === "away");
              if (homeComp && awayComp) {
                const hAbbr = (homeComp.team?.abbreviation || "").toUpperCase();
                const isHome = hAbbr === abbr;
                const oppComp = isHome ? awayComp : homeComp;
                nextGame = { date: evDateStr, isHome, opp: (oppComp.team?.abbreviation || "").toUpperCase(), gameTime: event.date };
              }
            }
            continue;
          }
          const homeComp = comp.competitors?.find(c => c.homeAway === "home");
          const awayComp = comp.competitors?.find(c => c.homeAway === "away");
          if (!homeComp || !awayComp) continue;
          const homeAbbr = (homeComp.team?.abbreviation || "").toUpperCase();
          const teamIsHome = homeAbbr === abbr;
          const teamComp = teamIsHome ? homeComp : awayComp;
          const oppComp  = teamIsHome ? awayComp  : homeComp;
          const teamScore = parseFloat(teamComp.score?.value ?? teamComp.score?.displayValue ?? teamComp.score) || 0;
          const oppScore  = parseFloat(oppComp.score?.value  ?? oppComp.score?.displayValue  ?? oppComp.score)  || 0;
          const winner = teamComp.winner === true;
          const loser  = oppComp.winner  === true;
          if (!winner && !loser) continue;
          const result = winner ? "W" : "L";
          const opp  = (teamIsHome ? (awayComp.team?.abbreviation || "").toUpperCase() : (homeComp.team?.abbreviation || "").toUpperCase()) || "?";
          const date = (event.date || "").slice(0, 10);
          if (!date) continue;
          lastGameId = event.id;
          gameLog.push({ date, isHome: teamIsHome, opp, teamScore, oppScore, total: teamScore + oppScore, result });
        }
      }
    } catch(e) {}
    gameLog.sort((a, b) => b.date.localeCompare(a.date));
    const avgTotal = gameLog.length > 0
      ? parseFloat((gameLog.reduce((s, g) => s + g.total, 0) / gameLog.length).toFixed(1))
      : null;
    let lineup = [], lineupConfirmed = false;
    if (sport === "nba") {
      const _nbaEspnNorm = { NY:"NYK", GS:"GSW", SA:"SAS", NO:"NOP", PHO:"PHX" };
      const _normNba = a => _nbaEspnNorm[a?.toUpperCase()] || a?.toUpperCase() || "";

      async function _getStartersFromGame(gameId) {
        const sumRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`, { headers: H });
        if (!sumRes.ok) return [];
        const sum = await sumRes.json();
        for (const tp of sum.boxscore?.players || []) {
          if (_normNba(tp.team?.abbreviation) !== abbr) continue;
          return (tp.statistics?.[0]?.athletes || [])
            .filter(a => a.starter)
            .map(a => ({ position: a.athlete?.position?.abbreviation || "?", name: a.athlete?.displayName || "Unknown", playerId: String(a.athlete?.id || "") }));
        }
        return [];
      }

      try {
        const sbRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard`, { headers: H });
        if (sbRes.ok) {
          const sb = await sbRes.json();
          for (const ev of sb.events || []) {
            if (ev.competitions?.[0]?.competitors?.some(c => _normNba(c.team?.abbreviation) === abbr)) {
              const starters = await _getStartersFromGame(ev.id);
              if (starters.length > 0) { lineup = starters; lineupConfirmed = true; }
              break;
            }
          }
        }
      } catch(e) {}

      if (lineup.length === 0) {
        let _lastGameId = null;
        try {
          const pSched = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${abbrLower}/schedule?season=2026&seasontype=3`, { headers: H });
          if (pSched.ok) {
            const ps = await pSched.json();
            for (const ev of ps.events || []) {
              if (ev.competitions?.[0]?.status?.type?.completed) _lastGameId = ev.id;
            }
          }
        } catch(e) {}
        if (!_lastGameId) _lastGameId = lastGameId;
        if (_lastGameId) {
          try {
            const starters = await _getStartersFromGame(_lastGameId);
            if (starters.length > 0) { lineup = starters; lineupConfirmed = false; }
          } catch(e) {}
        }
      }

      if (lineup.length === 0) {
        try {
          const rosRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${abbrLower}/roster`, { headers: H });
          if (rosRes.ok) {
            const ros = await rosRes.json();
            const seen = new Set();
            for (const a of ros.athletes || []) {
              const pos = a.position?.abbreviation;
              if (!pos || seen.has(pos)) continue;
              seen.add(pos);
              lineup.push({ position: pos, name: a.displayName || "Unknown", playerId: String(a.id || "") });
              if (lineup.length >= 8) break;
            }
          }
        } catch(e) {}
      }
    } else if (sport === "mlb") {
      const MLB_ABR_TO_ID = { ARI:109,ATL:144,BAL:110,BOS:111,CHC:112,CWS:145,CIN:113,CLE:114,COL:115,DET:116,HOU:117,KC:118,LAA:108,LAD:119,MIA:146,MIL:158,MIN:142,NYM:121,NYY:147,OAK:133,PHI:143,PIT:134,SD:135,SEA:136,SF:137,STL:138,TB:139,TEX:140,TOR:141,WSH:120 };
      const mlbId = MLB_ABR_TO_ID[abbr];
      if (mlbId) {
        try {
          const ptDate = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
          const sRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?date=${ptDate}&hydrate=lineups,probablePitcher&sportId=1&teamId=${mlbId}`, { headers: H });
          if (sRes.ok) {
            const sd = await sRes.json();
            const game = sd.dates?.[0]?.games?.[0];
            if (game) {
              const isHome = game.teams?.home?.team?.id === mlbId;
              const lp = isHome ? (game.lineups?.homePlayers || []) : (game.lineups?.awayPlayers || []);
              if (lp.length > 0) {
                lineupConfirmed = true;
                lineup = lp.map((p, i) => ({ spot: i + 1, name: p.fullName || "Unknown", position: p.primaryPosition?.abbreviation || "?", playerId: String(p.id || "") }));
              }
              const probable = (isHome ? game.teams?.home : game.teams?.away)?.probablePitcher;
              if (probable) lineup.push({ spot: null, name: probable.fullName || "Unknown", position: "SP", playerId: String(probable.id || ""), isProbable: true });
            }
          }
        } catch(e) {}
      }
      if (lineup.length === 0 && mlbId) {
        try {
          const rosRes = await fetch(`https://statsapi.mlb.com/api/v1/teams/${mlbId}/roster?season=2026&rosterType=active`, { headers: H });
          if (rosRes.ok) {
            const ros = await rosRes.json();
            (ros.roster || [])
              .filter(r => r.position?.type !== "Pitcher" && r.position?.abbreviation !== "TWP")
              .slice(0, 12)
              .forEach(r => lineup.push({ spot: null, name: r.person?.fullName || "Unknown", position: r.position?.abbreviation || "?", playerId: String(r.person?.id || "") }));
          }
        } catch(e) {}
      }
    }
    const teamResult = { teamAbbr: abbr, teamName, sport, record: `${wins}-${losses}`, wins, losses, gameLog, seasonStats: { avgTotal, gamesPlayed: gameLog.length }, lineup, lineupConfirmed, nextGame };
    if (CACHE2) await CACHE2.put(cacheKey, JSON.stringify(teamResult), { expirationTtl: 3600 }).catch(() => {});
    return jsonResponse(teamResult);
  }

  return null;
}
