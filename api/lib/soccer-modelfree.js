// api/lib/soccer-modelfree.js
// Shared ESPN-scoreboard schedule/resolve engine for model-free maker soccer leagues (MLS,
// Brasileirão, NWSL, Chinese Super League, ...). Extracted 2026-07-23 when the 4th league
// (Chinese Super League) would have made this the 4th near-identical copy of the same ~90 lines
// (fetch/parse/schedule/resolve) — see project_nwsl_build_2026_07_23 memory, which flagged a
// 4th league as the threshold to stop copy-pasting. Each league's own thin file (mls.js,
// brasileirao.js, nwsl.js, chnsl.js) wraps this factory with its ESPN slug + canonical-team
// mapper + KV cache-key prefix, and re-exports under its OWN historical function names
// (fetchXSchedule/getXSchedule/fetchXResults/parseXEvents) — zero change to any external
// import (tonight.js emit modules, shadow.js resolver blocks) when a league gets refactored
// onto this shared engine.
//
// Deliberately NOT generalizing the tonight.js parse-branch/array or shadow.js resolver-block
// duplication in the same pass — those are short (~30 lines), mechanical, and arguably clearer
// to debug/grep per-league in an already-large file than a generic dispatch would be. Only the
// actual ESPN-fetch logic (the biggest, most error-prone duplication) is shared here.

// Every event on the scoreboard (played or not) → [{ date (PT), gameTime (ISO kickoff), home,
// away, homeScore, awayScore, completed }] canonical abbrs. Ties are kept (soccer allows draws)
// and incomplete games are kept too (the emit path needs an upcoming kickoff time).
//
// canonTeam(abbr, displayName) — displayName added 2026-07-24 for leagues where ESPN's OWN
// abbreviation isn't unique (Argentina Liga Profesional reuses "RIV" for both River Plate AND
// Independiente Rivadavia — confirmed via ESPN's own /teams endpoint, not a Kalshi-side issue).
// Every other league's canonTeam ignores the 2nd arg — backward compatible, no other wrapper
// needed to change.
function parseEvents(events, canonTeam) {
  const out = [];
  for (const ev of (events || [])) {
    const comp = ev?.competitions?.[0];
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    const hAbbr = canonTeam(home?.team?.abbreviation || "", home?.team?.displayName || "");
    const aAbbr = canonTeam(away?.team?.abbreviation || "", away?.team?.displayName || "");
    if (!hAbbr || !aAbbr) continue;
    const completed = !!comp?.status?.type?.completed;
    const hs = Number(home?.score), as = Number(away?.score);
    out.push({
      date: _ptDate(ev.date), gameTime: ev.date || null,
      home: hAbbr, away: aAbbr,
      homeScore: completed && hs >= 0 ? hs : null,
      awayScore: completed && as >= 0 ? as : null,
      completed,
    });
  }
  return out;
}

const _ptDate = (iso) => {
  try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
  catch { return null; }
};

// Factory: returns { parseEvents, fetchSchedule, getSchedule, fetchResults } bound to one
// league's ESPN slug + canonical-team mapper + KV cache-key prefix.
export function makeSoccerModelFreeSource({ espnSlug, canonTeam, cacheKeyPrefix }) {
  const SCOREBOARD = `https://site.api.espn.com/apis/site/v2/sports/soccer/${espnSlug}/scoreboard`;

  async function _scoreboard(datesParam) {
    try {
      const res = await fetch(`${SCOREBOARD}?dates=${datesParam}&limit=100`, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      return (await res.json())?.events || [];
    } catch { return []; }
  }

  const boundParseEvents = (events) => parseEvents(events, canonTeam);

  // Games (any status) on a PT date (dateStr YYYYMMDD), keyed by sorted canonical pair "A|B"
  // (Kalshi ticker order ≠ ESPN home/away). Fetches a 2-day UTC window so evening kickoffs that
  // roll past midnight UTC still land on their PT date.
  async function fetchSchedule(dateStr) {
    if (!dateStr || dateStr.length !== 8) return {};
    const target = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    const next = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8) + 1));
    const nextYmd = `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, "0")}${String(next.getUTCDate()).padStart(2, "0")}`;
    const games = boundParseEvents(await _scoreboard(`${dateStr}-${nextYmd}`));
    const out = {};
    for (const g of games) {
      if (g.date !== target) continue;
      out[[g.home, g.away].sort().join("|")] = g;
    }
    return out;
  }

  // Fetch + KV-cache one date's schedule (30min TTL). Used by the emit path for a real
  // gameTime; fetchResults below re-fetches directly (uncached — resolution runs a few times a
  // night, not worth the KV round-trip).
  async function getSchedule({ dateStr, cache, isBustCache } = {}) {
    if (!dateStr) return {};
    const key = `${cacheKeyPrefix}:schedule:${dateStr}`;
    if (cache && !isBustCache) {
      try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
    }
    const schedule = await fetchSchedule(dateStr);
    if (cache && schedule) {
      try { await cache.put(key, JSON.stringify(schedule), { expirationTtl: 1800 }); } catch {}
    }
    return schedule;
  }

  // Completed games only, same sorted-pair key. Ties resolve with homeScore === awayScore.
  async function fetchResults(dateStr) {
    const all = await fetchSchedule(dateStr);
    const out = {};
    for (const [k, g] of Object.entries(all)) if (g.completed) out[k] = g;
    return out;
  }

  // Half-time scores for finished games on a PT date (dateStr YYYYMMDD), sorted-pair keyed —
  // same idiom as fetchWcHalfFinals (soccer.js): the scoreboard endpoint carries no per-half
  // breakdown, so each finished game needs a second `summary?event={id}` fetch, whose header
  // competitors carry `linescores[0]`=1st-half goals, `[1]`=2nd-half goals. Returns
  // { home, away, h1HomeScore, h1AwayScore, homeScore, awayScore (derived h1+h2), completed }
  // per game — the derived full-game score means callers needing BOTH half and full data (e.g.
  // a full-game team-total resolver sharing this fetch with a 1H-family resolver) don't need a
  // second call to fetchResults above.
  async function fetchHalfResults(dateStr) {
    if (!dateStr || dateStr.length !== 8) return {};
    const events = await _scoreboard(dateStr);
    const out = {};
    await Promise.all(events.map(async (ev) => {
      const comp = ev?.competitions?.[0];
      if (comp?.status?.type?.completed !== true || !ev?.id) return;
      let sum;
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${espnSlug}/summary?event=${ev.id}`, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return;
        sum = await r.json();
      } catch { return; }
      const hdrComp = (sum?.header?.competitions || [])[0];
      const h1 = {}, h2 = {};
      let home = null, away = null;
      for (const c of (hdrComp?.competitors || [])) {
        const canon = canonTeam(c?.team?.abbreviation || "", c?.team?.displayName || "");
        if (!canon) return;
        const ls = c?.linescores || [];
        const g1 = parseInt(ls[0]?.displayValue ?? ls[0]?.value, 10);
        const g2 = parseInt(ls[1]?.displayValue ?? ls[1]?.value, 10);
        if (!Number.isFinite(g1) || !Number.isFinite(g2)) return;
        h1[canon] = g1; h2[canon] = g2;
        if (c.homeAway === "home") home = canon; else if (c.homeAway === "away") away = canon;
      }
      if (!home || !away || Object.keys(h1).length !== 2) return;
      out[[home, away].sort().join("|")] = {
        home, away,
        h1HomeScore: h1[home], h1AwayScore: h1[away],
        homeScore: h1[home] + h2[home], awayScore: h1[away] + h2[away],
        completed: true,
      };
    }));
    return out;
  }

  // `canonTeam` is echoed back (2026-07-28) so the per-league shims can re-export the exact mapper
  // this source was built with, instead of each rebuilding an identical one from CANONICAL_TO_ESPN.
  return { parseEvents: boundParseEvents, fetchSchedule, getSchedule, fetchResults, fetchHalfResults, canonTeam };
}
