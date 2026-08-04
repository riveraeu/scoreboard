// NBA/DVP data fetchers: depth charts, pace, DvP builders, player cache warmer.
import { fetchSafe } from "./utils.js";
const _fs = (label, url, opts) => fetchSafe(`nba:${label}`, url, opts);

export async function warmPlayerInfoCache(cache) {
  if (!cache) return;
  const SERIES = ["KXNBAPTS", "KXNBAREB", "KXNBAAST", "KXNBA3PT", "KXNHLPTS", "KXMLBHIT", "KXMLBHRR", "KXMLBKS"];
  const SERIES_SPORT = { KXNBAPTS: "nba", KXNBAREB: "nba", KXNBAAST: "nba", KXNBA3PT: "nba", KXNHLPTS: "nhl", KXMLBHIT: "mlb", KXMLBHRR: "mlb", KXMLBKS: "mlb" };
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


// Full NBA byteam hydration. Fetches defensive + scoring stats + today/tomorrow scoreboards,
// builds gameOdds/gameScores/topPlayers, and writes byteam:nba + byteam:nba:scoring caches.
// Returns { nba, nbaScoring, nbaGameOdds, nbaGameScores, nbaTopPlayers }.
import { parseGameOdds as _pgo, parseGameScores as _pgs, parseTopPlayers as _ptp } from "./utils.js";

export async function buildNbaByteam(cache, normTeamFn) {
  const _H = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
  const [d, scoringData, sbData] = await Promise.all([
    _fs("byteam-def",  "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=defensive&seasontype=2", { headers: _H }),
    _fs("byteam-scor", "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=scoring&seasontype=2", { headers: _H }),
    (() => {
      // PT-aware today + tomorrow scoreboard fetch. gameOdds = today only; gameScores = both days.
      const _nd0 = new Date(Date.now() - 7 * 3600 * 1000); const _nd1 = new Date(_nd0); _nd1.setDate(_nd1.getDate() + 1);
      const _nfmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
      return Promise.all([
        _fs("scoreboard-today",    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_nfmt(_nd0)}`, { headers: _H }),
        _fs("scoreboard-tomorrow", `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_nfmt(_nd1)}`, { headers: _H }),
      ]).then(([sb0, sb1]) => ({ events: sb0.events || [], eventsAll: [...(sb0.events || []), ...(sb1.events || [])] }));
    })()
  ]);
  const nba = d.teams || [];
  const nbaScoring = scoringData.teams || [];
  const out = {
    nba, nbaScoring,
    nbaGameOdds: _pgo(sbData.events || []),
    nbaGameScores: _pgs(sbData.eventsAll || sbData.events || [], a => normTeamFn("nba", a)),
    nbaTopPlayers: _ptp(sbData.eventsAll || sbData.events || [], a => normTeamFn("nba", a), "nba"),
  };
  if (cache) {
    await cache.put("byteam:nba", JSON.stringify(nba), { expirationTtl: 21600 });
    await cache.put("byteam:nba:scoring", JSON.stringify(nbaScoring), { expirationTtl: 21600 });
  }
  return out;
}
