// api/lib/tonight/sportsbook-deltas.js — sharp-book vs Kalshi divergence (Phase 1a, 2026-06-29).
//
// emitSportsbookDeltas compares the de-vigged sharp-book MONEYLINE fair value (from
// api/lib/sportsbook.js) against OUR Kalshi price for the same game/side, one delta per matched
// side. It reads the Kalshi price straight off the emitted plays/dropped rows (the same chokepoint
// emitPolymarketDeltas uses — those rows ARE the price we'd act on), so it reuses buildKalshiMlIndex
// rather than re-deriving the index. Pure (no HTTP/KV) → unit-testable.
//
// THE SIGN MATTERS: deltaCents = bookFairPct − kalshiPct.
//   • POSITIVE = the sharp book implies a HIGHER fair probability than Kalshi is pricing → Kalshi is
//     CHEAP on that side → edge to BUY it (Kalshi is lagging the book).
//   • Magnitude + persistence over time = the kill-gate: does Kalshi systematically lag the sharp
//     book enough to act before the price corrects?
// Shadow-only — never sent to the client. ML-only (Phase 1a), same rationale as polymarket-deltas.

import { buildKalshiMlIndex } from "./polymarket-deltas.js";

// Liquidity gate: only compare against a TRADED Kalshi line. A 0-volume side is an untraded resting
// quote — too likely stale/wide to trust for divergence measurement (it's what produced the noisy
// ~15¢ tail in the first live read: book vs a vol=0 coinflip row). Start permissive (drop only pure
// zero); raise if the gated tail still looks stale. The cross-sectional median is robust either way.
const MIN_KALSHI_VOL = 1;

function _median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(2);
}

// Compare sharp-book games to the Kalshi ML index, pushing delta rows into `deltas`. Returns a
// decision-grade summary. `bookGames` from fetchSportsbookGames; `plays`/`dropped` the emitted rows.
export function emitSportsbookDeltas({ bookGames, plays = [], dropped = [], deltas = [] }) {
  const ml = buildKalshiMlIndex([...plays, ...dropped]);
  let matchedGames = 0;
  let illiquidSkipped = 0; // sides dropped by the volume gate (untraded Kalshi line)
  const _usedKeys = new Set(); // a Kalshi game matched once — a 2nd book game on the same key is a DH/dup

  for (const g of (bookGames || [])) {
    const { sport, away, home, gameDate } = g;
    // Exact PT-date match ONLY. Book gameDate is now PT (sportsbook.js). The old ±1-day fuzz +
    // UTC dates paired tonight's (sometimes live) book odds with tomorrow's Kalshi market whenever
    // the same teams played consecutive days — the entire fake ≥5¢ delta tail (2026-07-01 audit).
    const mlKey = `${sport}|${away}|${home}|${gameDate}`;
    const ke = ml[mlKey];
    if (!ke) continue;
    if (ke._ambiguous || _usedKeys.has(mlKey)) continue; // doubleheader / duplicate — can't disambiguate
    _usedKeys.add(mlKey);
    const md = gameDate;
    let matchedThisGame = false;
    for (const side of ["away", "home"]) {
      if (g.ml[side] == null || !ke[side]) continue;
      // Liquidity gate — skip an untraded Kalshi side (stale quote → unreliable for divergence).
      if (!((ke[side].vol || 0) >= MIN_KALSHI_VOL)) { illiquidSkipped++; continue; }
      const bookFairPct = +(g.ml[side] * 100).toFixed(1);
      const kalshiPct = ke[side].pct;
      deltas.push({
        sport, game: `${away}@${home}`, gameDate: md, market: "ml", side,
        kalshiPct, bookFairPct, deltaCents: +(bookFairPct - kalshiPct).toFixed(1),
        book: g.book || "pinnacle", modelTruePct: ke[side].truePct,
      });
      matchedThisGame = true;
    }
    if (matchedThisGame) matchedGames++;
  }

  const abs = deltas.map((d) => Math.abs(d.deltaCents));
  const signed = deltas.map((d) => d.deltaCents);
  const bySport = {};
  for (const d of deltas) bySport[d.sport] = (bySport[d.sport] || 0) + 1;
  return {
    n: deltas.length,
    market: "ml",
    bookGames: (bookGames || []).length,
    matchedGames,
    illiquidSkipped,
    medianAbsDeltaCents: _median(abs),
    maxAbsDeltaCents: abs.length ? Math.max(...abs) : null,
    meanSignedCents: signed.length ? +(signed.reduce((a, b) => a + b, 0) / signed.length).toFixed(2) : null,
    bySport,
  };
}
