// api/lib/mma.js
// MMA / UFC data + model — Phase 1: weight-class finish-rate → fight-duration CDF (rounds O/U).
//
// Scope: the KXUFCROUNDS market only ("Will the fight end before round N?"), shadow-only
// (`fight|rounds` is intentionally NOT in the category gate). This is a pure fight-DURATION
// model — independent of who wins — so it needs no fighter ratings, sidestepping the thin MMA
// rating-data problem. The winner market (KXUFCFIGHT) is deferred to Phase 1b pending an
// independent fighter Elo (using sportsbook-implied odds would launder the market into the model).
//
// Model fidelity is deliberately minimal for Phase 1: the single knob is the weight class's
// per-fight finish rate. We convert that to a constant per-round finish hazard and read the
// "ends before round N" probability off the resulting geometric CDF. Phase 2 replaces the
// constant hazard with a per-round vector (finishes are front-loaded) + per-fighter durability.
//
// Data source (no auth, ASCII names):
//   scoreboard : https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=YYYYMMDD
// ESPN MMA "events" are fight cards; individual bouts live under event.competitions[]. Each bout
// carries competition.type.abbreviation = weight class, format.regulation.periods = scheduled
// rounds, status.period = the round the bout ended in, and competitor.winner booleans.

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc";

// Per-fight finish rate (P fight ends by stoppage) over a STANDARD 3-round fight, by weight
// class. PROVISIONAL — anchored to published UFC career finish-rate stats, NOT to Kalshi prices
// (fitting to the market would launder its edge into the model). Heavier classes finish more.
// Shadow-calibrated: these are the single Phase-1 tuning knob.
export const WEIGHT_CLASS_FINISH_RATE = {
  heavyweight:          0.62,
  lightheavyweight:     0.58,
  middleweight:         0.52,
  welterweight:         0.48,
  lightweight:          0.45,
  featherweight:        0.42,
  bantamweight:         0.40,
  flyweight:            0.35,
  womensbantamweight:   0.42,
  womensfeatherweight:  0.42,
  womensflyweight:      0.33,
  womensstrawweight:    0.30,
  catchweight:          0.45,
};
const DEFAULT_FINISH_RATE = 0.45; // unknown / open weight → middle of the pack

// Normalize an ESPN weight-class label ("Women's Strawweight", "Light Heavyweight") to a
// WEIGHT_CLASS_FINISH_RATE key (lowercase, letters only). Returns "" when absent.
export function normWeightClass(label) {
  return (label || "").toLowerCase().replace(/[^a-z]/g, "");
}

// Finish rate for a weight class, with the catch-all default for anything unmapped.
export function finishRateFor(weightClass) {
  const key = normWeightClass(weightClass);
  return WEIGHT_CLASS_FINISH_RATE[key] ?? DEFAULT_FINISH_RATE;
}

// Convert a standard 3-round finish rate F3 to a constant per-round finish hazard h
// (probability the fight ends in any round it reaches): going the distance over 3 rounds is
// (1-h)^3 = 1-F3, so h = 1 - (1-F3)^(1/3).
export function roundHazard(finishRate3) {
  const f = Math.min(Math.max(finishRate3 || 0, 0), 0.95);
  return 1 - Math.pow(1 - f, 1 / 3);
}

// P(fight ends before round N) for a constant per-round hazard h. The fight reaches round N
// iff it survived rounds 1..N-1 without a finish: P(reach N) = (1-h)^(N-1), so
// P(ends before N) = 1 - (1-h)^(N-1). N=2 → h (R1 finish); N=3 → 1-(1-h)^2; etc. Holds for
// 3- and 5-round fights off the same h.
export function pEndBeforeRound(h, n) {
  if (!(n >= 2)) return 0;
  return 1 - Math.pow(1 - h, n - 1);
}

// Normalize a fighter name for code/name matching: strip diacritics, lowercase, letters only.
export function normFighterName(name) {
  return (name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Build the per-fight index for a card payload. Returns
//   [{ lastNames:[a,b], names:[A,B], weightClass, scheduledRounds, finishRound, final }]
// where lastNames are normalized last names (for Kalshi-code matching), finishRound = the round
// the bout ended in (status.period; = scheduled on a decision), and final = the bout completed.
function parseCard(json) {
  const out = [];
  for (const ev of (json?.events || [])) {
    for (const c of (ev?.competitions || [])) {
      const comps = c?.competitors || [];
      const names = comps.map((cm) => (cm?.athlete || {}).displayName).filter(Boolean);
      if (names.length < 2) continue;
      const lastNames = names.map((n) => {
        const parts = normFighterName(n).split(" ");
        return parts[parts.length - 1] || "";
      });
      out.push({
        names,
        lastNames,
        weightClass: c?.type?.abbreviation || c?.type?.text || "",
        scheduledRounds: c?.format?.regulation?.periods ?? 3,
        finishRound: c?.status?.period ?? null,
        final: c?.status?.type?.completed === true,
        winner: (comps.find((cm) => cm?.winner === true)?.athlete || {}).displayName || null,
        // Card start time (ISO) — not the individual bout's exact walkout time (ESPN doesn't
        // expose per-bout start), so all bouts on one card share it. Coarse but real; enough for
        // computeMakerQuote's pre-game gate (found 2026-07-23 — this was never captured despite
        // getFightCardIndex already fetching future cards, just not this field).
        eventDate: ev?.date || c?.date || null,
      });
    }
  }
  return out;
}

// Fetch the UFC fight card(s) for a single date (YYYYMMDD). Returns the parsed-fight array
// (empty on failure). Used by both hydration (weight class) and resolution (finish round).
async function fetchCard(dateStr) {
  try {
    const url = `${ESPN_BASE}/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    return parseCard(await res.json());
  } catch { return []; }
}

// Build + KV-cache a fight-card index spanning today + the next `days` days, keyed by date
// (YYYY-MM-DD) → parsed-fight array. UFC runs ~weekly so a 6h TTL is safe. Returns {} on total
// failure (caller drops the run's fight plays). Hydration path.
export async function getFightCardIndex({ cache, isBustCache, days = 8 } = {}) {
  const key = "mma:card:index";
  if (cache && !isBustCache) {
    try {
      const hit = await cache.get(key);
      if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit;
    } catch {}
  }
  const today = new Date();
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  const index = {};
  await Promise.all(dates.map(async (ds) => {
    const fights = await fetchCard(ds);
    if (fights.length) index[`${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`] = fights;
  }));
  if (cache && Object.keys(index).length) {
    try { await cache.put(key, JSON.stringify(index), { expirationTtl: 21600 }); } catch {}
  }
  return index;
}

// Match a Kalshi fighter-code segment (last-name-based, e.g. "COLTAN" = Collins+Tanzilovi,
// usually 3+3) to a parsed fight from the card. Returns the fight or null. We require both
// fighters' first-3 last-name letters to appear in the segment (order-independent) — robust to
// the variable-length codes Kalshi uses when names collide.
export function matchFightByCodes(codeSegment, fights) {
  const seg = (codeSegment || "").toLowerCase();
  if (!seg) return null;
  for (const f of fights) {
    const [a, b] = f.lastNames;
    if (!a || !b) continue;
    const pa = a.slice(0, 3), pb = b.slice(0, 3);
    if (pa.length === 3 && pb.length === 3 && seg.includes(pa) && seg.includes(pb)) return f;
  }
  return null;
}

// Resolution helper: fetch the card for a date and return matched-by-codes fights, so the
// resolver can read finishRound / final per Kalshi event. Thin wrapper kept symmetric with
// soccer's fetchWcFinals / tennis's fetchCompletedMatches.
export async function fetchFightResults(dateStr) {
  return fetchCard(dateStr);
}
