// api/lib/golf.js
// Golf (PGA) data + model — Phase 1: OWGR-rating single-round head-to-head (KXPGAH2H).
//
// Scope: single-round head-to-head only ("Will A beat B in round N?"), shadow-only (`golf|h2h`
// is intentionally NOT in the category gate). This is the golf analog of tennis match-winner:
// two players, a relative-skill comparison that is FIELD-INDEPENDENT (one round, one matchup).
//
// Model fidelity is deliberately minimal for Phase 1. A player's rating is derived from their
// Official World Golf Ranking average points; we map that to an expected strokes-vs-field skill,
// model the one-round score differential as Normal, and read P(A strictly beats B) off it with a
// half-stroke continuity tie band (golf rounds tie often, and a tie resolves NO for both sides).
// The single Phase-1 knobs are GOLF_STROKE_SCALE + GOLF_ROUND_SIGMA. Phase 2 = a strokes-gained
// rating + a 36-hole field simulation feeding make-cut + cut-line (the alt-line families).
//
// Data sources (no auth, ASCII names):
//   ratings : https://apiweb.owgr.com/api/owgr/rankings/getRankings (OWGR, market-independent)
//   results : https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=YYYYMMDD
// ESPN golf "events" are tournaments; each competitor carries per-round linescores[].value.

import { normCDF } from "./simulate.js";

const OWGR_URL = "https://apiweb.owgr.com/api/owgr/rankings/getRankings?regionId=0&pageSize=600&pageNumber=1&countryId=0&sortString=";
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/golf/pga";

// Strokes of skill spread per log10 unit of OWGR average points: the world #1 (~16.6 pts →
// log10≈1.25) sits ~1.8 strokes/round better than a field-average player (~0.5 pts → log10≈0.18),
// a ~1.07 log10 gap → ~1.7 strokes/log10. Per-round scoring std for a PGA pro ≈ 2.8 strokes.
// Both PROVISIONAL — anchored to published strokes-gained spreads, NOT to Kalshi prices.
export const GOLF_STROKE_SCALE = 1.7;
export const GOLF_ROUND_SIGMA = 2.8;

// Normalize a player name for matching: strip diacritics, lowercase, keep only letters/spaces.
export function normGolfName(name) {
  return (name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// OWGR average points → skill rating in STROKES (higher = better player = lower expected score).
// The log scale tames OWGR's heavy skew. Differences cancel the (unmodeled) field baseline, so
// only the A−B gap matters for head-to-head. This is the single Phase-1 tuning knob.
export function ratingFromPoints(pointsAverage) {
  return GOLF_STROKE_SCALE * Math.log10(Math.max(pointsAverage || 0, 0) + 1);
}

// Single-round head-to-head probabilities for players A vs B given their stroke ratings.
// Score differential D = score_A − score_B ~ Normal(rB − rA, √2·σ); A beats B iff D < 0, with a
// half-stroke continuity band so ties (D≈0) are excluded from both win probabilities.
// Returns { pA, pB, pTie } where pA = P(A strictly beats B). pA + pB + pTie = 1.
export function h2hWinProb(ratingA, ratingB) {
  const sigmaD = Math.SQRT2 * GOLF_ROUND_SIGMA;
  const meanD = ratingB - ratingA;
  const pA = normCDF(-0.5, meanD, sigmaD);           // P(D ≤ −0.5): A at least a stroke lower
  const pB = 1 - normCDF(0.5, meanD, sigmaD);        // P(D ≥ 0.5): B at least a stroke lower
  return { pA, pB, pTie: Math.max(0, 1 - pA - pB) };
}

// Build a name→rating index from the OWGR rankings payload. Returns plain objects (JSON-
// serializable for KV). byLast values are a record, or "AMBIG" when two players share a last
// name (forces a full-name match) — mirrors the tennis index.
export function buildRatingIndex(owgrJson) {
  const byFull = {};
  const byLast = {};
  for (const r of (owgrJson?.rankingsList || [])) {
    const p = r?.player || {};
    const display = (p.fullName || `${p.firstName || ""} ${p.lastName || ""}`).trim();
    const full = normGolfName(display);
    const pts = parseFloat(r?.pointsAverage) || 0;
    if (!full) continue;
    const rec = { name: display, points: pts, rank: r?.rank ?? null, rating: ratingFromPoints(pts) };
    if (!(full in byFull)) byFull[full] = rec;
    const last = normGolfName(p.lastName || full.split(" ").pop());
    if (last) byLast[last] = (last in byLast) ? "AMBIG" : rec;
  }
  return { byFull, byLast };
}

// Look up a player's rating record by name: full-name match first, unambiguous last-name
// fallback. Returns null when unmatched/ambiguous (unranked/amateur → caller abstains).
export function lookupRating(index, name) {
  if (!index) return null;
  const full = normGolfName(name);
  if (index.byFull?.[full]) return index.byFull[full];
  const last = full.split(" ").pop();
  const rec = last && index.byLast?.[last];
  if (rec && rec !== "AMBIG") return rec;
  return null;
}

// Fetch + KV-cache the OWGR rating index. Rankings update weekly, so a 12h TTL is safe. Returns
// null on fetch failure (caller drops the run's golf plays).
export async function getRatingIndex({ cache, isBustCache } = {}) {
  const key = "golf:ratings:owgr";
  if (cache && !isBustCache) {
    try {
      const hit = await cache.get(key);
      if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit;
    } catch {}
  }
  let json;
  try {
    const res = await fetch(OWGR_URL, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    json = await res.json();
  } catch { return null; }
  const index = buildRatingIndex(json);
  if (cache && Object.keys(index.byFull).length) {
    try { await cache.put(key, JSON.stringify(index), { expirationTtl: 43200 }); } catch {}
  }
  return index;
}

// Fetch a date's PGA leaderboard and return normName → per-round score array (linescores[].value).
// Used by the resolver: a completed round N is at index N-1. Round scores out of [55,100] are
// treated as not-yet-played artifacts (the scoreboard emits 0 / odd values for WD/MC rows).
export async function fetchRoundScores(dateStr) {
  let json;
  try {
    const url = `${ESPN_BASE}/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    json = await res.json();
  } catch { return {}; }
  const out = {};
  for (const ev of (json?.events || [])) {
    for (const c of (ev?.competitions || [])) {
      for (const cm of (c?.competitors || [])) {
        const name = (cm?.athlete || {}).displayName;
        if (!name) continue;
        const rounds = (cm?.linescores || []).map((ls) => {
          const v = parseFloat(ls?.value);
          return (v >= 55 && v <= 100) ? v : null;
        });
        out[normGolfName(name)] = rounds;
      }
    }
  }
  return out;
}
