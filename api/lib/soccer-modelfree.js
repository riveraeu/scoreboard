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

// Sorted-pair map over a DATE WINDOW, keeping the fixture nearest `target` (YYYY-MM-DD) for each
// pair. Pure + exported so the tie-break is pinned by a test — it is the only non-obvious part of
// the widened gameTime lookup, and getting it wrong would attach a row to the wrong fixture's
// kickoff rather than merely leaving it null.
export function nearestByPair(games, target) {
  const out = {};
  const t = new Date(target).getTime();
  const dist = (g) => Math.abs(new Date(g.date).getTime() - t);
  for (const g of games || []) {
    if (!g?.date || !g.home || !g.away) continue;
    const k = [g.home, g.away].sort().join("|");
    if (!out[k] || dist(g) < dist(out[k])) out[k] = g;
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

  // Same sorted-pair map, but tolerant of a ticker date that disagrees with the real kickoff
  // date (2026-08-10). Kalshi's event ticker encodes a date that can sit -1 to +2 days off the
  // fixture ESPN actually lists — a rescheduled kickoff, or just a ticker minted before the slate
  // firmed up. `fetchSchedule` filters on an EXACT PT-date match, so those fixtures found no
  // schedule entry and the rows logged `gameTime: null`, i.e. silently un-maker-quotable. Live
  // examples: dimayor PER@JUN ticker 08-10 / ESPN 08-12, argprem BAN@RAC ticker 08-15 / ESPN
  // 08-14 (note the NEGATIVE offset — the window has to look backwards too).
  //
  // Deliberately scoped to the gameTime path only. `fetchSchedule`/`fetchResults` keep their
  // strict exact-date semantics because a RESULT matched to a neighbouring day's fixture would
  // grade a row against the wrong game — a far worse failure than a missing kickoff time.
  //
  // One ranged request covers the whole window, so this costs no extra ESPN round-trips. When a
  // pair somehow appears more than once in the window, the fixture NEAREST the ticker date wins;
  // league soccer never repeats a pairing inside five days, and nearest-wins keeps it
  // deterministic if a cup ever does.
  const _WINDOW_DAYS = 2;
  async function fetchScheduleNearest(dateStr) {
    if (!dateStr || dateStr.length !== 8) return {};
    const target = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    const shift = (n) => {
      const d = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8) + n));
      return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    };
    // +1 on the upper bound for the same reason fetchSchedule used a 2-day window: an evening
    // kickoff can roll past midnight UTC and still belong to the earlier PT date.
    const games = boundParseEvents(await _scoreboard(`${shift(-_WINDOW_DAYS)}-${shift(_WINDOW_DAYS + 1)}`));
    return nearestByPair(games, target);
  }

  // Fetch + KV-cache one date's schedule (30min TTL). Used by the emit path for a real
  // gameTime; fetchResults below re-fetches directly (uncached — resolution runs a few times a
  // night, not worth the KV round-trip).
  // Cache key bumped to :schedule2: with the widened window — the old key holds exact-date-only
  // maps, and silently serving those for 30 minutes after deploy is exactly the stale-cache
  // confusion that made the registry sweep look like it had not worked.
  async function getSchedule({ dateStr, cache, isBustCache } = {}) {
    if (!dateStr) return {};
    const key = `${cacheKeyPrefix}:schedule2:${dateStr}`;
    if (cache && !isBustCache) {
      try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
    }
    const schedule = await fetchScheduleNearest(dateStr);
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
