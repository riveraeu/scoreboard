// api/lib/mma-card.js
// UFC fight-card identity + gameTime helper, extracted from mma.js (2026-08-04) so it survives the
// model teardown. The weight-class finish-rate → duration-CDF model was deleted; fight|rounds is now
// model-free maker capture, but the emit path still needs the ESPN card to resolve fighter names
// (row identity) and the card start time (computeMakerQuote's pre-game gate). Pure fetch/parse — no
// model math.
//
// ESPN MMA "events" are fight cards; individual bouts live under event.competitions[].

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc";

// Normalize a fighter name for code/name matching: strip diacritics, lowercase, letters only.
export function normFighterName(name) {
  return (name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse a card payload → [{ names:[A,B], lastNames:[a,b], eventDate }]. lastNames are normalized
// last names (for Kalshi-code matching); eventDate is the card start time (all bouts share it —
// ESPN doesn't expose per-bout walkout times, coarse but real for the pre-game gate).
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
      out.push({ names, lastNames, eventDate: ev?.date || c?.date || null });
    }
  }
  return out;
}

async function fetchCard(dateStr) {
  try {
    const url = `${ESPN_BASE}/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    return parseCard(await res.json());
  } catch { return []; }
}

// Build + KV-cache a fight-card index spanning today + the next `days` days, keyed by date
// (YYYY-MM-DD) → parsed-fight array. UFC runs ~weekly so a 6h TTL is safe.
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

// Match a Kalshi fighter-code segment (last-name-based, e.g. "COLTAN", usually 3+3) to a parsed
// fight. Both fighters' first-3 last-name letters must appear in the segment (order-independent).
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
