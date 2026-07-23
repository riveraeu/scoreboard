// api/lib/tennis.js
// Tennis (ATP + WTA) data + model — Phase 1: ESPN-rankings logistic match-winner.
//
// Scope: match-winner only, shadow-only (`tennis|match` is intentionally NOT in the
// category gate — it logs to shadow_plays for calibration but never shows as a UI play).
//
// Model fidelity is deliberately minimal for Phase 1: a player's "rating" is derived from
// their ATP/WTA ranking points, and match win prob is a logistic on the rating difference.
// Phase 2 replaces `ratingFromPoints` with surface-weighted Elo (Sackmann match logs) —
// nothing else in this module or the emit/resolve path needs to change.
//
// Data sources (no auth, ASCII names):
//   rankings : https://site.api.espn.com/apis/site/v2/sports/tennis/{atp|wta}/rankings
//   results  : https://site.api.espn.com/apis/site/v2/sports/tennis/{atp|wta}/scoreboard?dates=YYYYMMDD
// ESPN tennis "events" are tournaments; individual matches live under event.groupings[].competitions[].

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/tennis";

// Normalize a player name for matching: strip diacritics, lowercase, keep only letters/spaces.
export function normTennisName(name) {
  return (name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ATP/WTA ranking points → Elo-scale rating. With the logistic base used by
// tennisMatchProb (10^(Δ/400)), rating = 400·log10(points) collapses to a clean points-ratio
// model: P(A) = ptsA / (ptsA + ptsB). This is the single Phase-1 tuning knob and the only
// thing Phase 2 (surface Elo) swaps out. Provisional — calibrate from shadow data.
export function ratingFromPoints(points) {
  return 400 * Math.log10(Math.max(points || 0, 1));
}

// Logistic match win probability for player A vs B given their ratings.
export function tennisMatchProb(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// Build a name→rating index from an ESPN rankings payload. Returns plain objects (not Maps)
// so the index is JSON-serializable for KV caching. byLast values are a record, or the
// sentinel "AMBIG" when two ranked players share a last name (forces a full-name match).
export function buildRatingIndex(rankingsJson) {
  const byFull = {};
  const byLast = {};
  for (const g of (rankingsJson?.rankings || [])) {
    for (const r of (g?.ranks || [])) {
      const ath = r?.athlete || {};
      const display = (ath.displayName || `${ath.firstName || ""} ${ath.lastName || ""}`).trim();
      const full = normTennisName(display);
      const pts = parseFloat(r?.points) || 0;
      if (!full || pts <= 0) continue;
      const rec = { name: display, points: pts, rank: r?.current ?? null, rating: ratingFromPoints(pts) };
      if (!(full in byFull)) byFull[full] = rec;
      const last = normTennisName(ath.lastName || full.split(" ").pop());
      if (last) byLast[last] = (last in byLast) ? "AMBIG" : rec;
    }
  }
  return { byFull, byLast };
}

// Look up a player's rating record by name. Full-name match first; unambiguous last-name
// fallback (handles "M. Giron" vs "Marcos Giron"). Returns null when unmatched or ambiguous
// (unranked qualifiers / colliding last names) — caller abstains rather than guessing.
export function lookupRating(index, name) {
  if (!index) return null;
  const full = normTennisName(name);
  if (index.byFull?.[full]) return index.byFull[full];
  const last = full.split(" ").pop();
  const rec = last && index.byLast?.[last];
  if (rec && rec !== "AMBIG") return rec;
  return null;
}

// Fetch + KV-cache the rating index for a tour ("atp"/"wta"). Rankings change weekly, so a
// 12h TTL is safe. Returns null on fetch failure (caller drops the tour's plays for this run).
export async function getRatingIndex(tour, { cache, isBustCache } = {}) {
  const key = `tennis:ratings:${tour}`;
  if (cache && !isBustCache) {
    try {
      const hit = await cache.get(key);
      if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit;
    } catch {}
  }
  let json;
  try {
    const res = await fetch(`${ESPN_BASE}/${tour}/rankings`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    json = await res.json();
  } catch { return null; }
  const index = buildRatingIndex(json);
  if (cache) {
    try { await cache.put(key, JSON.stringify(index), { expirationTtl: 43200 }); } catch {}
  }
  return index;
}

// Fetch completed matches for a tour on a given date (YYYYMMDD). Returns
// [{ players: [rawName, rawName], winner: rawName|null, date: "YYYYMMDD"|"" }]. Names are raw
// ESPN displayNames; the resolver normalizes both sides with its own fuzzy matcher.
// CAUTION (2026-07-19): ESPN tennis "events" are TOURNAMENTS — `?dates=` selects which
// tournaments are live, and groupings[].competitions[] contains EVERY completed match of the
// tournament to date (singles + doubles + qualifying), not one day's slate. Callers must
// disambiguate (the resolver requires both row players in one match + the per-competition
// `date` carried here); a single-name lookup grades picks off the wrong match.
export async function fetchCompletedMatches(tour, dateStr) {
  let json;
  try {
    const url = `${ESPN_BASE}/${tour}/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    json = await res.json();
  } catch { return []; }
  const out = [];
  for (const ev of (json?.events || [])) {
    for (const grp of (ev?.groupings || [])) {
      for (const c of (grp?.competitions || [])) {
        if (c?.status?.type?.completed !== true) continue;
        const comps = c?.competitors || [];
        const players = comps.map((cm) => (cm?.athlete || {}).displayName).filter(Boolean);
        const win = comps.find((cm) => cm?.winner === true);
        const winner = win ? (win.athlete || {}).displayName || null : null;
        const date = (c?.date || "").slice(0, 10).replace(/-/g, "");
        if (players.length >= 2) out.push({ players, winner, date });
      }
    }
  }
  return out;
}

// ── Schedule (any status, for a real gameTime) ───────────────────────────────
// Every match on the tour's scoreboard for a tournament window (played or not) → keyed by
// sorted normalized player-pair "a|b", { gameTime (ISO) }. Unlike fetchCompletedMatches above
// (which requires `completed`), this keeps not-yet-played matches since the emit path needs an
// upcoming start time before the result exists. Found 2026-07-23: computeMakerQuote (maker.js)
// requires a real future stagingRow.gameTime, but the tennis emit path was hardcoding
// gameTime:null despite c.date carrying exactly that on the same scoreboard fetch.
export async function fetchTennisSchedule(tour, dateStr) {
  let json;
  try {
    const url = `${ESPN_BASE}/${tour}/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    json = await res.json();
  } catch { return {}; }
  const out = {};
  for (const ev of (json?.events || [])) {
    for (const grp of (ev?.groupings || [])) {
      for (const c of (grp?.competitions || [])) {
        const comps = c?.competitors || [];
        const players = comps.map((cm) => normTennisName((cm?.athlete || {}).displayName || "")).filter(Boolean);
        if (players.length !== 2) continue;
        const key = [...players].sort().join("|");
        if (!out[key]) out[key] = { gameTime: c?.date || null };
      }
    }
  }
  return out;
}

// Fetch + KV-cache one (tour, date)'s schedule (30min TTL — same idiom as mls.js's getMlsSchedule).
export async function getTennisSchedule(tour, dateStr, { cache, isBustCache } = {}) {
  if (!dateStr) return {};
  const key = `tennis:schedule:${tour}:${dateStr}`;
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const schedule = await fetchTennisSchedule(tour, dateStr);
  if (cache && schedule) {
    try { await cache.put(key, JSON.stringify(schedule), { expirationTtl: 1800 }); } catch {}
  }
  return schedule;
}
