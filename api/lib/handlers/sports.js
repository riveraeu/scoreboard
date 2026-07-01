// Sports-data endpoints: /api/live (boxscore polling), /api/plays/history,
// /api/leagues, /api/team. All self-contained — depend on ESPN site/scoreboard
// API and CACHE2 only.

import { PT_FMT } from "../pt.js";
import { jsonResponse, errorResponse } from "../utils.js";
import { CANONICAL_TO_ESPN as CANONICAL_TO_ESPN_ALL, MLB_ID_TO_ABBR } from "../teams.js";

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
    // ?tb=1 — merge MLB total bases from statsapi (ESPN's box score has no TB/2B/3B).
    // Opt-in: only the shadow resolver sends it (KXMLBTB), so frontend live polling
    // pays zero extra fetches. Cache slots are suffixed so the two shapes don't mix.
    const wantTB = params.get("tb") === "1";
    const SPORT_PATHS = { mlb: "baseball/mlb", nba: "basketball/nba", wnba: "basketball/wnba", nhl: "hockey/nhl" };

    const gameTuples = gamesParam.split(",").map(g => {
      // Format: `sport:team1:team2` or `sport:team1:team2@gameTimeISO`. gameTime is
      // optional; when present, used to disambiguate same-day doubleheaders so the
      // pick resolves against the correct ESPN event rather than always the first match.
      const atIdx = g.indexOf("@");
      const base = atIdx >= 0 ? g.slice(0, atIdx) : g;
      const gameTime = atIdx >= 0 ? g.slice(atIdx + 1) : null;
      const [sport, ...teams] = base.split(":");
      return { sport, key: g, teams: teams.map(t => t.toUpperCase()), gameTime };
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
        // Cache key includes gameTime so same-day doubleheader games don't share a slot
        // (would otherwise return game 1's boxscore for a pick on game 2 and vice versa).
        const _gtSuffix = tuple.gameTime ? `:${tuple.gameTime}` : "";
        const _tbSuffix = wantTB && sport === "mlb" ? ":tb" : "";
        const cacheKey = `live:${sport}:${tuple.teams.slice().sort().join(":")}:${ptDate}${_gtSuffix}${_tbSuffix}`;
        const cached = CACHE2 ? await CACHE2.get(cacheKey, "json").catch(() => null) : null;
        if (cached) { liveResult[tuple.key] = cached; }
        else uncached.push({ ...tuple, cacheKey });
      }
      if (!uncached.length) return;

      // ESPN scoreboard fetch. A timeout/non-OK here used to be swallowed silently
      // (catch {}), leaving sbEvents=[] so every game fell to state:"unknown" — which
      // returns early BEFORE the KV cache put, so it never caches and every retry
      // re-fails. That silently zeroed out whole resolver passes on cold start (the
      // 5s budget is easily blown when the function is cold or ESPN is briefly slow).
      // So: 8s timeout, one retry on abort/non-OK (the failed first call warms the
      // connection → the retry lands), and the failure is logged, never swallowed.
      // A genuine 200-with-empty-events (no games that date) is NOT retried/logged.
      let sbEvents = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const sbRes = await fetch(
            `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/scoreboard?dates=${ptDateStr}`,
            { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
          );
          if (!sbRes.ok) {
            console.error(`[live] scoreboard ${sbRes.status} (${sport} ${ptDateStr}, attempt ${attempt + 1})`);
            continue; // retry once on non-OK
          }
          sbEvents = (await sbRes.json()).events || [];
          break;
        } catch (e) {
          console.error(`[live] scoreboard fetch failed (${sport} ${ptDateStr}, attempt ${attempt + 1}): ${e?.message}`);
        }
      }

      // ESPN scoreboard returns different abbrs from our canonical for some teams.
      // Translate inputs → ESPN when matching events; translate ESPN's response → canonical
      // so downstream consumers (auto-resolver, totals/team-totals lookups keyed by pick.homeTeam)
      // see the same abbr the pick was tracked with.
      // Canonical → ESPN scoreboard abbr, derived from the team registry (api/lib/teams.js).
      // Add new scoreboard mismatches to the registry's `espnScore` field, not here.
      const CANONICAL_TO_ESPN = CANONICAL_TO_ESPN_ALL[sport] || {};
      const ESPN_TO_CANONICAL = Object.fromEntries(
        Object.entries(CANONICAL_TO_ESPN).map(([k, v]) => [v, k])
      );
      const toEspn = a => CANONICAL_TO_ESPN[a] || a;
      const toCanonical = a => ESPN_TO_CANONICAL[a] || a;

      // Lazy statsapi schedule for the TB merge — fetched at most once per request,
      // and only when an MLB tuple actually reaches the merge step below.
      let _tbSchedPromise = null;
      const getStatsapiSchedule = () => {
        if (!_tbSchedPromise) {
          const fetchSched = (attempt) => fetch(
            `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${ptDate}`,
            { signal: AbortSignal.timeout(8000) }
          ).then(r => r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)))
            .then(j => j?.dates?.[0]?.games || [])
            .catch((e) => {
              console.error(`[live] statsapi schedule failed (${ptDate}, attempt ${attempt}): ${e?.message}`);
              return attempt < 2 ? fetchSched(attempt + 1) : [];
            });
          _tbSchedPromise = fetchSched(1);
        }
        return _tbSchedPromise;
      };

      await Promise.all(uncached.map(async ({ key, teams, cacheKey, gameTime }) => {
        const [t1, t2] = teams.map(toEspn);

        // Match by teams first; when a gameTime is supplied (doubleheader disambiguation),
        // also require the event's date to match. ESPN uses `2026-05-24T16:35Z` (no seconds);
        // tolerate either form by comparing the first 16 chars (`YYYY-MM-DDTHH:MM`).
        // No fallback if a gameTime was supplied but doesn't match — falling back would
        // reintroduce the bug where a pick on game 2 resolves against game 1's final.
        const _gtPrefix = gameTime ? gameTime.slice(0, 16) : null;
        const event = sbEvents.find(ev => {
          const abbrs = (ev.competitions?.[0]?.competitors || [])
            .map(c => c.team?.abbreviation?.toUpperCase());
          if (!(abbrs.includes(t1) && abbrs.includes(t2))) return false;
          if (_gtPrefix && (ev.date || "").slice(0, 16) !== _gtPrefix) return false;
          return true;
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

        // MLB First-N-Innings breakdowns (F3/F5/F7) — used by segment ML picks to resolve
        // mid-game once the bottom of inning N completes (instead of waiting on state==="post").
        // ESPN's linescores array appends an entry per half-inning played; both teams reaching
        // length≥N means each has batted N full innings (top+bottom of N complete). Home always
        // bats in the bottom even when leading, so the criterion is symmetric. Segment picks
        // void client-side if state==="post" but !fNComplete (rainout / called game before N).
        let f3HomeScore = null, f3AwayScore = null, f3Complete = false;
        let f5HomeScore = null, f5AwayScore = null, f5Complete = false;
        let f7HomeScore = null, f7AwayScore = null, f7Complete = false;
        if (sport === "mlb") {
          const hLs = homeComp?.linescores || [];
          const aLs = awayComp?.linescores || [];
          const _segRuns = (ls, n) => ls.slice(0, n).reduce((s, x) => s + (parseFloat(x?.value) || 0), 0);
          if (hLs.length >= 3 && aLs.length >= 3) { f3HomeScore = _segRuns(hLs, 3); f3AwayScore = _segRuns(aLs, 3); f3Complete = true; }
          if (hLs.length >= 5 && aLs.length >= 5) { f5HomeScore = _segRuns(hLs, 5); f5AwayScore = _segRuns(aLs, 5); f5Complete = true; }
          if (hLs.length >= 7 && aLs.length >= 7) { f7HomeScore = _segRuns(hLs, 7); f7AwayScore = _segRuns(aLs, 7); f7Complete = true; }
        }
        // NBA / WNBA half breakdown — linescores array has one entry per played quarter.
        // 1H = Q1+Q2 (linescores indices 0,1); 2H = Q3+Q4+OT (indices 2..N) = total - 1H.
        // h1Complete = both teams have ≥2 entries (Q1+Q2 played). h2Complete = state==="post"
        // (2H includes OT, locked at game end). Picks resolve to "void" if state==="post"
        // but !h1Complete (game called before halftime — extremely rare in NBA/WNBA).
        let h1HomeScore = null, h1AwayScore = null, h1Complete = false;
        let h2HomeScore = null, h2AwayScore = null, h2Complete = false;
        const qScores = {}; // { "1": {home, away}, ... } — populated for completed quarters
        if (sport === "nba" || sport === "wnba") {
          const hLs = homeComp?.linescores || [];
          const aLs = awayComp?.linescores || [];
          if (hLs.length >= 2 && aLs.length >= 2) {
            h1HomeScore = hLs.slice(0, 2).reduce((s, x) => s + (parseFloat(x?.value) || 0), 0);
            h1AwayScore = aLs.slice(0, 2).reduce((s, x) => s + (parseFloat(x?.value) || 0), 0);
            h1Complete = true;
          }
          if (state === "post" && h1Complete) {
            h2HomeScore = homeScore - h1HomeScore;
            h2AwayScore = awayScore - h1AwayScore;
            h2Complete = true;
          }
          // Per-quarter scores: linescores[n-1].value = points in quarter n. A quarter is final
          // once a later period has an entry (or the game is over). OT (index 4+) is not a quarter.
          for (let n = 1; n <= 4; n++) {
            const done = hLs.length >= n && aLs.length >= n && (state === "post" || hLs.length > n);
            if (done) qScores[n] = { home: parseFloat(hLs[n - 1]?.value) || 0, away: parseFloat(aLs[n - 1]?.value) || 0 };
          }
        }

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

                  // Track team's pitchers in appearance order so we can flag the most recent
                  // one as "currently in" (ESPN lists chronologically: starter/opener →
                  // reliever → reliever). The pitcher-K early-resolve uses this flag instead
                  // of an IP-vs-inning heuristic that breaks for bulk pitchers behind openers.
                  const teamPitchers = [];
                  for (const ath of statsSection.athletes || []) {
                    const name = ath.athlete?.fullName || ath.athlete?.displayName;
                    if (!name) continue;
                    const s = ath.stats || [];
                    if (hasPitching && kIdx !== -1) {
                      players[name] = { strikeouts: parseInt(s[kIdx]) || 0, ip: s[ipIdx] ?? "0.0", isCurrentPitcher: false };
                      teamPitchers.push(name);
                    } else if (hasBatting && hIdx !== -1) {
                      const h = parseInt(s[hIdx]) || 0;
                      const r = parseInt(s[rIdx]) || 0;
                      const rbi = parseInt(s[rbiIdx]) || 0;
                      players[name] = { hits: h, runs: r, rbi, hrr: h + r + rbi };
                    }
                  }
                  // Mark the last pitcher in this team's list as current.
                  if (teamPitchers.length > 0) {
                    const lastP = teamPitchers[teamPitchers.length - 1];
                    if (players[lastP]) players[lastP].isCurrentPitcher = true;
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

        // TB merge (2026-06-12): statsapi boxscore carries totalBases per batter directly.
        // Match the statsapi game by canonical home/away abbrs; doubleheaders disambiguate
        // by closest start time to the ESPN event. Batters are merged by diacritic-stripped
        // name onto the ESPN players map; statsapi-only names get a standalone entry so the
        // resolver's fuzzy lookup can still find them. Failures leave totalBases absent
        // (undefined — never 0), which the resolver treats as noData/retry.
        if (sport === "mlb" && wantTB) {
          try {
            const sched = await getStatsapiSchedule();
            const evTime = Date.parse(event.date || "") || 0;
            const game = sched
              .filter(g => MLB_ID_TO_ABBR[g.teams?.home?.team?.id] === homeTeam
                        && MLB_ID_TO_ABBR[g.teams?.away?.team?.id] === awayTeam)
              .sort((x, y) => Math.abs(Date.parse(x.gameDate) - evTime) - Math.abs(Date.parse(y.gameDate) - evTime))[0];
            if (game?.gamePk) {
              const boxRes = await fetch(
                `https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`,
                { signal: AbortSignal.timeout(5000) }
              );
              if (boxRes.ok) {
                const box = await boxRes.json();
                const _tbNorm = s => s ? s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() : "";
                const espnByNorm = {};
                for (const k of Object.keys(players)) espnByNorm[_tbNorm(k)] = k;
                for (const side of ["home", "away"]) {
                  for (const pl of Object.values(box.teams?.[side]?.players || {})) {
                    const tb = pl?.stats?.batting?.totalBases;
                    const nm = pl?.person?.fullName;
                    if (tb == null || !nm) continue;
                    const espnKey = espnByNorm[_tbNorm(nm)];
                    if (espnKey) players[espnKey].totalBases = tb;
                    else players[nm] = { ...(players[nm] || {}), totalBases: tb };
                  }
                }
              }
            }
          } catch {}
        }

        const gameData = { state, detail, players, homeTeam, awayTeam, homeScore, awayScore };
        if (sport === "mlb" && f3Complete) {
          gameData.f3HomeScore = f3HomeScore;
          gameData.f3AwayScore = f3AwayScore;
          gameData.f3Complete = true;
        }
        if (sport === "mlb" && f5Complete) {
          gameData.f5HomeScore = f5HomeScore;
          gameData.f5AwayScore = f5AwayScore;
          gameData.f5Complete = true;
        }
        if (sport === "mlb" && f7Complete) {
          gameData.f7HomeScore = f7HomeScore;
          gameData.f7AwayScore = f7AwayScore;
          gameData.f7Complete = true;
        }
        if ((sport === "nba" || sport === "wnba") && h1Complete) {
          gameData.h1HomeScore = h1HomeScore;
          gameData.h1AwayScore = h1AwayScore;
          gameData.h1Complete = true;
          if (h2Complete) {
            gameData.h2HomeScore = h2HomeScore;
            gameData.h2AwayScore = h2AwayScore;
            gameData.h2Complete = true;
          }
          for (const n of Object.keys(qScores)) {
            gameData[`q${n}HomeScore`] = qScores[n].home;
            gameData[`q${n}AwayScore`] = qScores[n].away;
            gameData[`q${n}Complete`] = true;
          }
        }
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
    const cacheKey = `team:v4:${sport}:${abbr}:${today}`;
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
      // Projected batting order — if today's lineup isn't posted yet, fall back to the
      // most-recent posted batting order from the team's past 10 days. The MLB Stats API
      // exposes pre-game `lineups` only briefly (it gets replaced once the game starts);
      // for completed games we read `battingOrder` off the boxscore instead. Two-fetch
      // path: 1) past-10-day schedule for gamePks, 2) boxscore for the most-recent Final.
      if (lineup.filter(p => !p.isProbable).length === 0 && mlbId) {
        try {
          const today = new Date(Date.now() - 7 * 3600 * 1000);
          const endDate = today.toISOString().slice(0, 10);
          const startDate = new Date(today.getTime() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
          const histRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?startDate=${startDate}&endDate=${endDate}&sportId=1&teamId=${mlbId}`, { headers: H });
          if (histRes.ok) {
            const histData = await histRes.json();
            const finals = (histData.dates || []).flatMap(d => d.games || [])
              .filter(g => g.status?.abstractGameState === "Final")
              .sort((a, b) => (b.gameDate || "").localeCompare(a.gameDate || ""));
            for (const game of finals) {
              const boxRes = await fetch(`https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`, { headers: H });
              if (!boxRes.ok) continue;
              const box = await boxRes.json();
              const isHome = game.teams?.home?.team?.id === mlbId;
              const teamBox = isHome ? box.teams?.home : box.teams?.away;
              const battingOrder = teamBox?.battingOrder || [];
              if (battingOrder.length >= 9) {
                const players = teamBox.players || {};
                const hitterEntries = battingOrder.slice(0, 9).map((pid, i) => {
                  const p = players[`ID${pid}`];
                  return {
                    spot: i + 1,
                    name: p?.person?.fullName || "Unknown",
                    position: p?.position?.abbreviation || "?",
                    playerId: String(pid),
                  };
                });
                // Preserve probable pitcher entry (added above) and slot hitters before it
                const probables = lineup.filter(p => p.isProbable);
                lineup = [...hitterEntries, ...probables];
                lineupConfirmed = false;
                break;
              }
            }
          }
        } catch(e) {}
      }
      if (lineup.filter(p => !p.isProbable).length === 0 && mlbId) {
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
