// api/lib/nascar.js
// NASCAR (Cup) data + model — Phase 1: recent-form finishing-position model for the binary
// head-to-head (KXNASCARH2H) and Top-10 (KXNASCARTOP10) markets. Shadow-only — `nascar|h2h`
// and `nascar|top10` are intentionally NOT in the category gate.
//
// The single Phase-1 knob is a per-driver finishing-position distribution: a driver's expected
// finish μ is their mean finishing position over the last NASCAR_FORM_RACES Cup races, and the
// race-to-race spread is a league-wide Normal with σ = NASCAR_FINISH_SIGMA. From that:
//   H2H  : P(A beats B)  = Φ( (μ_B − μ_A) / (√2·σ) )   (lower finish wins; positions strictly
//                                                        ordered so P(A)+P(B)=1, no tie band)
//   TOP10: P(finish ≤ 10) = Φ( (10.5 − μ) / σ )         (half-position continuity correction)
// Both σ and the form window are PROVISIONAL — anchored to NASCAR finishing-spread intuition,
// NOT fit to Kalshi prices (fitting to market would launder the market's edge into the model).
// Phase 2 = per-track/surface form, qualifying position, manufacturer, recency weighting.
//
// Data source — ESPN core API (no auth, market-independent):
//   schedule : sports.core.api.espn.com/v2/sports/racing/leagues/nascar-premier/seasons/{Y}/types/2/events
//              (the league `events` endpoint returns only the active race; the season type-2 list
//               is the full ~40-race schedule. Event id prefix = YYYYMMDD, so dates need no fetch.)
//   results  : each event → competitions[0].competitors[] = inline { id (athlete id), order (finish) }
//   names    : sports.core.api.espn.com/v2/sports/racing/athletes/{id} → fullName (index build ONLY;
//              results resolution matches by athlete id, so it needs no name fetches)
// Cup-only by construction: the rating index is built from the Cup (`nascar-premier`) schedule,
// so Truck/Xfinity-only drivers never get a rating and their markets drop out at emit (no_rating).

import { normCDF } from "./simulate.js";

const CORE = "https://sports.core.api.espn.com/v2/sports/racing/leagues/nascar-premier";
const ATHLETE_BASE = "https://sports.core.api.espn.com/v2/sports/racing/athletes";

// League-wide race-to-race finishing-position std (positions), the rolling form window (races)
// that defines a driver's expected finish μ, and the minimum starts in that window to rate a
// driver (fewer = too noisy; also drops part-timers, reinforcing Cup-only scoping). PROVISIONAL.
export const NASCAR_FINISH_SIGMA = 9;
export const NASCAR_FORM_RACES = 10;
export const NASCAR_MIN_RACES = 3;

// Normalize a driver name for Kalshi↔ESPN matching: strip diacritics, lowercase, letters/spaces.
export function normNascarName(name) {
  return (name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// H2H: P(A strictly beats B) given expected finishes μ_A, μ_B. Finish differential
// D = finish_A − finish_B ~ Normal(μ_A − μ_B, √2·σ); A wins iff D < 0. Positions are strictly
// ordered (no ties), so P(A)+P(B)=1 with no continuity band.
export function pBeats(muA, muB) {
  const sigmaD = Math.SQRT2 * NASCAR_FINISH_SIGMA;
  return normCDF(0, muA - muB, sigmaD); // P(D < 0)
}

// TOP-N: P(finish ≤ n) for a driver with expected finish μ. Continuity-corrected (finish ≤ 10
// ⟺ the continuous finishing draw < 10.5).
export function pTopN(mu, n = 10) {
  return normCDF(n + 0.5, mu, NASCAR_FINISH_SIGMA);
}

// ── ESPN core API helpers ─────────────────────────────────────────────────────
async function _getJson(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

const _eventIdFromRef = (ref) => (String(ref || "").match(/\/events\/(\d+)/) || [])[1] || null;
const _ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
const _dateDiffDays = (a, b) => {
  const d = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((d(a) - d(b)) / 86400000);
};

// Season schedule → [{ id, date:YYYYMMDD }] chronological. Date is parsed from the event id, so
// the full schedule (incl. unrun future races) is one fetch with no per-event date lookups.
async function _seasonEvents(year) {
  const json = await _getJson(`${CORE}/seasons/${year}/types/2/events?limit=60`);
  return (json?.items || [])
    .map((it) => { const id = _eventIdFromRef(it?.$ref); return id ? { id, date: id.slice(0, 8) } : null; })
    .filter(Boolean);
}

// One event's finishing order: competitors carry athlete id + finishing order inline.
async function _eventOrders(eventId) {
  const json = await _getJson(`${CORE}/events/${eventId}/competitions/${eventId}`);
  const out = [];
  for (const c of (json?.competitors || [])) {
    const id = String(c?.id || "");
    const order = Number(c?.order);
    if (id && order >= 1) out.push({ id, order });
  }
  return out;
}

// athlete id → display name (index build only).
async function _athleteName(id) {
  const json = await _getJson(`${ATHLETE_BASE}/${id}`);
  return (json?.fullName || json?.displayName || "").trim() || null;
}

// Aggregate finishing positions across a set of per-event order lists into id → number[].
// Pure (testable without HTTP): callers pass already-fetched order lists.
export function aggregateFinishes(orderLists) {
  const agg = new Map();
  for (const list of (orderLists || [])) {
    for (const { id, order } of (list || [])) {
      if (!id || !(order >= 1)) continue;
      if (!agg.has(id)) agg.set(id, []);
      agg.get(id).push(order);
    }
  }
  return agg;
}

// Build a name→record index from an id→finishes aggregate + an id→name map. Pure / testable.
// Record = { name, id, avgFinish, nRaces }. Drops drivers under NASCAR_MIN_RACES starts.
export function buildDriverIndexFrom(agg, nameById) {
  const byFull = {}, byLast = {};
  for (const [id, finishes] of agg) {
    if (finishes.length < NASCAR_MIN_RACES) continue;
    const display = (nameById[id] || "").trim();
    if (!display) continue;
    const full = normNascarName(display);
    if (!full) continue;
    const avgFinish = +(finishes.reduce((s, x) => s + x, 0) / finishes.length).toFixed(2);
    const rec = { name: display, id, avgFinish, nRaces: finishes.length };
    if (!(full in byFull)) byFull[full] = rec;
    const last = normNascarName(display.split(" ").pop());
    if (last) byLast[last] = (last in byLast) ? "AMBIG" : rec;
  }
  return { byFull, byLast };
}

// Build the Cup driver index from the last NASCAR_FORM_RACES completed races. Returns plain
// objects (KV-serializable) or null when the schedule / results can't be fetched.
export async function buildDriverIndex({ now = new Date() } = {}) {
  const year = now.getUTCFullYear();
  const todayYmd = _ymd(now);
  const events = await _seasonEvents(year);
  if (!events.length) return null;
  const past = events
    .filter((e) => e.date < todayYmd)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, NASCAR_FORM_RACES);
  if (!past.length) return null;
  const orderLists = await Promise.all(past.map((e) => _eventOrders(e.id)));
  const agg = aggregateFinishes(orderLists);
  if (!agg.size) return null;
  const ids = [...agg.keys()];
  const names = await Promise.all(ids.map(_athleteName));
  const nameById = {};
  ids.forEach((id, i) => { if (names[i]) nameById[id] = names[i]; });
  const index = buildDriverIndexFrom(agg, nameById);
  return Object.keys(index.byFull).length ? index : null;
}

// Look up a driver by name: full match first, unambiguous last-name fallback (mirrors golf).
export function lookupDriver(index, name) {
  if (!index) return null;
  const full = normNascarName(name);
  if (index.byFull?.[full]) return index.byFull[full];
  const last = full.split(" ").pop();
  const rec = last && index.byLast?.[last];
  if (rec && rec !== "AMBIG") return rec;
  return null;
}

// Fetch + KV-cache the Cup driver index (12h TTL; recent-form only changes after a race).
export async function getDriverIndex({ cache, isBustCache } = {}) {
  const key = "nascar:drivers:cup";
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const index = await buildDriverIndex();
  if (cache && index && Object.keys(index.byFull).length) {
    try { await cache.put(key, JSON.stringify(index), { expirationTtl: 43200 }); } catch {}
  }
  return index;
}

// ── Real green-flag time (for gameTime) ───────────────────────────────────────
// _seasonEvents only derives `date` from the event id's YYYYMMDD prefix (no time-of-day) — the
// list endpoint doesn't carry it, but the per-event resource does. Found 2026-07-23:
// computeMakerQuote (maker.js) requires a real future stagingRow.gameTime, but this module was
// hardcoding gameTime:null; ~1 Cup race per weekend keeps this to one extra targeted fetch per
// run, not a full-schedule fetch. Mirrors fetchRaceResults' nearest-event-within-±1-day matching
// so it finds the same race the ticker's gameDate refers to.
async function _eventDate(eventId) {
  const json = await _getJson(`${CORE}/events/${eventId}`);
  return json?.date || null;
}

export async function fetchRaceGameTime(dateStr) {
  if (!dateStr || dateStr.length !== 8) return null;
  const events = await _seasonEvents(dateStr.slice(0, 4));
  if (!events.length) return null;
  let best = null, bestDiff = 2;
  for (const e of events) {
    const diff = Math.abs(_dateDiffDays(e.date, dateStr));
    if (diff <= 1 && diff < bestDiff) { best = e; bestDiff = diff; }
  }
  return best ? _eventDate(best.id) : null;
}

// Fetch + KV-cache one date's race green-flag time (6h TTL — race schedules are set well in
// advance and don't change intra-day).
export async function getRaceGameTime(dateStr, { cache, isBustCache } = {}) {
  if (!dateStr) return null;
  const key = `nascar:gametime:${dateStr}`;
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const gameTime = await fetchRaceGameTime(dateStr);
  if (cache && gameTime) {
    try { await cache.put(key, JSON.stringify(gameTime), { expirationTtl: 21600 }); } catch {}
  }
  return gameTime;
}

// ── Resolution ──────────────────────────────────────────────────────────────
// A race's finishing order as { athleteId: order }. Matches the Cup event whose date is closest
// to dateStr (YYYYMMDD) within ±1 day — a night race rolls the close_time UTC date one day past
// the ESPN event date. ~1 Cup race per weekend, so the nearest in-window match is unambiguous.
export async function fetchRaceResults(dateStr) {
  if (!dateStr || dateStr.length !== 8) return {};
  const events = await _seasonEvents(dateStr.slice(0, 4));
  if (!events.length) return {};
  let best = null, bestDiff = 2;
  for (const e of events) {
    const diff = Math.abs(_dateDiffDays(e.date, dateStr));
    if (diff <= 1 && diff < bestDiff) { best = e; bestDiff = diff; }
  }
  if (!best) return {};
  const out = {};
  for (const { id, order } of await _eventOrders(best.id)) out[id] = order;
  return out;
}
