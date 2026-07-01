// api/lib/tonight/polymarket-deltas.js — cross-venue price observatory (Phase 1a, 2026-06-23).
//
// emitPolymarketDeltas compares Polymarket MONEYLINE prices (from api/lib/polymarket.js) against
// OUR Kalshi prices for the same game/side, and produces one delta row per matched side. It reads
// the Kalshi price straight off the already-emitted plays/dropped rows (canonical teams,
// kalshiPct) rather than the scattered internal Kalshi market maps — those rows ARE the Kalshi
// price we'd act on. Pure (no HTTP/KV) so it's unit-testable.
//
// The kill-gate question this exists to answer: do Kalshi and Polymarket diverge enough to matter?
// The returned summary (median/max |delta|, counts) is the read. The delta ROWS + summary stay
// shadow-only (never sent to the client), but as of 2026-06-30 the matched Poly price is ALSO
// stamped onto the Kalshi play row (`polyPct`/`polyDeltaCents`) so the client can show a per-bet
// cross-venue comparison. deltaCents = polyPct − kalshiPct (signed; + = Polymarket implies a higher
// probability ⇒ Poly is the pricier side to BUY; − = Poly cheaper to BUY).
//
// MONEYLINE-ONLY by design (Phase 1a). Totals were trialed and pulled: the integer↔half-point line
// mapping is correct (Kalshi over@N = P(≥N), so Poly over L.5 ⇔ Kalshi threshold ceil(L)), but the
// emitted Kalshi *alt-line* total rows carry stale/illiquid prices (e.g. over@8=67 vs over@9=24 is
// mathematically impossible — no real book) AND the dropped total rows omit gameDate + volume, so
// they can't be liquidity-gated here. The result was garbage 60¢ "deltas". ML is the liquid main
// market — unambiguous and clean (~0.5¢ median). Totals return in Phase 1a.1 once game-totals.js
// emits volume on dropped rows so we can gate to the liquid main line on both venues.

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
    // Keep the MOST-TRADED row for the side — when a game has several Kalshi ML rows (a stale 0-vol
    // quote alongside a traded line, or two series snapshots), the traded price is the reliable one
    // to compare against. `vol` travels with the slot so a consumer can liquidity-gate (the
    // sportsbook matcher does; the poly matcher leaves it for back-compat). Defaults to 0 when the
    // emit path omits volume (poly fixtures, older rows) → back-compatible last-wins-by-default.
    const vol = Number(r.kalshiVolume) || 0;
    if (!slot[r.side] || vol > (slot[r.side].vol || 0)) {
      // `row` is kept so the poly matcher can stamp the cross-venue price back onto the play for
      // client display (additive; the sportsbook matcher that shares this index ignores it).
      slot[r.side] = { pct: r.kalshiPct, truePct: r.truePct ?? null, vol, row: r };
    }
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
    // Exact PT-date match ONLY. Poly gameDate is now PT (polymarket.js normalizeEvent). The old
    // ±1-day fuzz let a still-open yesterday game (live prices) match TODAY's same-series Kalshi
    // market — the fake delta tail class found in the 2026-07-01 sportsbook-deltas audit.
    const mlKey = `${sport}|${away}|${home}|${gameDate}`;
    const ke = ml[mlKey];
    if (!ke) continue;
    if (ke._ambiguous || _usedKeys.has(mlKey)) continue; // doubleheader / duplicate — can't disambiguate
    _usedKeys.add(mlKey);
    const md = gameDate;
    let matchedThisGame = false;
    for (const side of ["away", "home"]) {
      if (g.ml[side] == null || !ke[side]) continue;
      const polyPct = +(g.ml[side] * 100).toFixed(1);
      const kalshiPct = ke[side].pct;
      const deltaCents = +(polyPct - kalshiPct).toFixed(1);
      deltas.push({
        sport, game: `${away}@${home}`, gameDate: md, market: "ml", side,
        kalshiPct, polyPct, deltaCents,
        modelTruePct: ke[side].truePct,
      });
      // Stamp the matched Kalshi play row so the cross-venue price rides along to the client
      // (tonight.js passes `plays` straight through). Display-only; the shadow delta row above is
      // unchanged. Harmless if the row is a `dropped` row (those aren't sent to the client).
      if (ke[side].row) { ke[side].row.polyPct = polyPct; ke[side].row.polyDeltaCents = deltaCents; }
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
