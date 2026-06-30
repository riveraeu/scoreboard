// api/lib/tonight/polymarket-deltas.js — cross-venue price observatory (Phase 1a, 2026-06-23).
//
// emitPolymarketDeltas compares Polymarket MONEYLINE prices (from api/lib/polymarket.js) against
// OUR Kalshi prices for the same game/side, and produces one delta row per matched side. It reads
// the Kalshi price straight off the already-emitted plays/dropped rows (canonical teams,
// kalshiPct) rather than the scattered internal Kalshi market maps — those rows ARE the Kalshi
// price we'd act on. Pure (no HTTP/KV) so it's unit-testable.
//
// The kill-gate question this exists to answer: do Kalshi and Polymarket diverge enough to matter?
// The returned summary (median/max |delta|, counts) is the read. Shadow-only — never sent to the
// client. deltaCents = polyPct − kalshiPct (signed; + = Polymarket implies a higher probability).
//
// MONEYLINE-ONLY by design (Phase 1a). Totals were trialed and pulled: the integer↔half-point line
// mapping is correct (Kalshi over@N = P(≥N), so Poly over L.5 ⇔ Kalshi threshold ceil(L)), but the
// emitted Kalshi *alt-line* total rows carry stale/illiquid prices (e.g. over@8=67 vs over@9=24 is
// mathematically impossible — no real book) AND the dropped total rows omit gameDate + volume, so
// they can't be liquidity-gated here. The result was garbage 60¢ "deltas". ML is the liquid main
// market — unambiguous and clean (~0.5¢ median). Totals return in Phase 1a.1 once game-totals.js
// emits volume on dropped rows so we can gate to the liquid main line on both venues.

// YYYY-MM-DD shifted by n days (UTC-safe string math).
function _shiftDate(d, n) {
  const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 86400000;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}

function _median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(2);
}

// Build the Kalshi moneyline index from the emitted rows. ML rows carry gameDate on both the plays
// and dropped pushes, so the key is date-specific. `${sport}|${away}|${home}|${date}` →
// { home:{pct,truePct}, away:{pct,truePct} }.
export function buildKalshiMlIndex(rows) {
  const ml = {};
  for (const r of rows) {
    if (!r || r.gameType !== "ml" || r.stat !== "ml") continue;
    if (!r.sport || !r.homeTeam || !r.awayTeam || !r.gameDate) continue;
    if (r.side !== "home" && r.side !== "away") continue;
    if (r.kalshiPct == null) continue;
    const k = `${r.sport}|${r.awayTeam}|${r.homeTeam}|${r.gameDate}`;
    const slot = (ml[k] ||= {});
    // Conflicting price for the same side+pair+date = a DOUBLEHEADER (or duplicate market) we can't
    // disambiguate without game-time — flag it so the matchers skip the whole key. Without this, a
    // DH game-2 book line matches game-1's Kalshi row → a spurious double-digit "delta" (observed
    // 2026-06-29: CIN@MIL book 93.5% vs the wrong Kalshi 62¢ row → fake 31.5¢ gap). 2¢ tolerance
    // ignores trivial cross-emit-path jitter.
    if (slot[r.side] && Math.abs(slot[r.side].pct - r.kalshiPct) > 2) slot._ambiguous = true;
    slot[r.side] = { pct: r.kalshiPct, truePct: r.truePct ?? null };
  }
  return ml;
}

// Compare Polymarket games to the Kalshi ML index, pushing delta rows into `deltas`. Returns a
// decision-grade summary. `polyGames` from fetchPolymarketGames; `plays`/`dropped` the emitted rows.
export function emitPolymarketDeltas({ polyGames, plays = [], dropped = [], deltas = [] }) {
  const ml = buildKalshiMlIndex([...plays, ...dropped]);
  let matchedGames = 0;
  const _usedKeys = new Set(); // a Kalshi game matched once — a 2nd venue game on the same key is a DH/dup

  for (const g of (polyGames || [])) {
    const { sport, away, home, gameDate } = g;
    // Poly ticker date is UTC; our gameDate is PT — try ±1 day so the UTC rollover lines up.
    const cands = [gameDate, _shiftDate(gameDate, -1), _shiftDate(gameDate, 1)];
    const mlKey = cands.map((d) => `${sport}|${away}|${home}|${d}`).find((k) => ml[k]);
    if (!mlKey) continue;
    const ke = ml[mlKey];
    if (ke._ambiguous || _usedKeys.has(mlKey)) continue; // doubleheader / duplicate — can't disambiguate
    _usedKeys.add(mlKey);
    const md = mlKey.split("|")[3];
    let matchedThisGame = false;
    for (const side of ["away", "home"]) {
      if (g.ml[side] == null || !ke[side]) continue;
      const polyPct = +(g.ml[side] * 100).toFixed(1);
      const kalshiPct = ke[side].pct;
      deltas.push({
        sport, game: `${away}@${home}`, gameDate: md, market: "ml", side,
        kalshiPct, polyPct, deltaCents: +(polyPct - kalshiPct).toFixed(1),
        modelTruePct: ke[side].truePct,
      });
      matchedThisGame = true;
    }
    if (matchedThisGame) matchedGames++;
  }

  const abs = deltas.map((d) => Math.abs(d.deltaCents));
  const bySport = {};
  for (const d of deltas) bySport[d.sport] = (bySport[d.sport] || 0) + 1;
  return {
    n: deltas.length,
    market: "ml",
    polyGames: (polyGames || []).length,
    matchedGames,
    medianAbsDeltaCents: _median(abs),
    maxAbsDeltaCents: abs.length ? Math.max(...abs) : null,
    bySport,
  };
}
