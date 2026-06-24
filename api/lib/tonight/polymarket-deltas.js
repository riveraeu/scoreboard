// api/lib/tonight/polymarket-deltas.js — cross-venue price observatory (Phase 1a, 2026-06-23).
//
// emitPolymarketDeltas compares Polymarket game prices (from api/lib/polymarket.js) against OUR
// Kalshi prices for the same game/outcome, and produces one delta row per matched side. It reads
// the Kalshi price straight off the already-emitted plays/dropped rows (canonical teams,
// kalshiPct) rather than the scattered internal Kalshi market maps — those rows ARE the Kalshi
// price we'd act on. Pure (no HTTP/KV) so it's unit-testable.
//
// The kill-gate question this exists to answer: do Kalshi and Polymarket diverge enough to matter?
// The returned summary (median/max |delta|, counts) is the read. Shadow-only — never sent to the
// client. deltaCents = polyPct − kalshiPct (signed; + = Polymarket implies a higher probability).

const _fullGameTotal = (row) =>
  row.gameType === "total" && !row.segment && !/f5|1h|2h|q[1-4]/i.test(String(row.stat || ""));

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

// Build the Kalshi price indices from the emitted rows.
//   ml:     `${sport}|${away}|${home}|${date}` → { home:{pct,truePct}, away:{pct,truePct} }
//   totals: `${sport}|${away}|${home}|${date}|${line}` → { over, under, overTrue }
function buildKalshiIndex(rows) {
  const ml = {}, totals = {};
  for (const r of rows) {
    if (!r || !r.sport || !r.homeTeam || !r.awayTeam || !r.gameDate) continue;
    if (r.gameType === "ml" && r.stat === "ml") {
      const k = `${r.sport}|${r.awayTeam}|${r.homeTeam}|${r.gameDate}`;
      const e = (ml[k] ||= {});
      if (r.side === "home" || r.side === "away") {
        if (r.kalshiPct != null) e[r.side] = { pct: r.kalshiPct, truePct: r.truePct ?? null };
      }
    } else if (_fullGameTotal(r) && r.threshold != null) {
      const k = `${r.sport}|${r.awayTeam}|${r.homeTeam}|${r.gameDate}|${r.threshold}`;
      const e = (totals[k] ||= {});
      if (r.kalshiPct != null && e.over == null) { e.over = r.kalshiPct; e.overTrue = r.truePct ?? null; }
      if (r.noKalshiPct != null && e.under == null) e.under = r.noKalshiPct;
    }
  }
  return { ml, totals };
}

// Compare Polymarket games to the Kalshi index, pushing delta rows into `deltas`. Returns a
// decision-grade summary. `polyGames` from fetchPolymarketGames; `plays`/`dropped` the emitted rows.
export function emitPolymarketDeltas({ polyGames, plays = [], dropped = [], deltas = [] }) {
  const idx = buildKalshiIndex([...plays, ...dropped]);
  let matchedGames = 0;

  for (const g of (polyGames || [])) {
    const { sport, away, home, gameDate } = g;
    // Poly ticker date is UTC; our gameDate is PT — try ±1 day so the UTC rollover lines up.
    const cands = [gameDate, _shiftDate(gameDate, -1), _shiftDate(gameDate, 1)];
    let matchedThisGame = false;

    // Moneyline
    const mlKey = cands.map((d) => `${sport}|${away}|${home}|${d}`).find((k) => idx.ml[k]);
    if (mlKey) {
      const ke = idx.ml[mlKey];
      const md = mlKey.split("|")[3];
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
    }

    // Totals. Polymarket uses half-point O/U lines (7.5); Kalshi MLB/NBA/NHL totals are INTEGER
    // "N+" thresholds. Over L.5 ⇔ total ≥ ceil(L.5) = Kalshi threshold ceil(L); Poly under ⇔ the
    // Kalshi NO side at that threshold. Try the exact line first (in case a venue ever lists .5),
    // then the ceil mapping for fractional lines.
    for (const t of (g.totals || [])) {
      const thr = [t.line, Number.isInteger(t.line) ? null : Math.ceil(t.line)].filter((x) => x != null);
      const tKey = cands.flatMap((d) => thr.map((n) => `${sport}|${away}|${home}|${d}|${n}`)).find((k) => idx.totals[k]);
      if (!tKey) continue;
      const te = idx.totals[tKey];
      const td = tKey.split("|")[3];
      if (t.over != null && te.over != null) {
        const polyPct = +(t.over * 100).toFixed(1);
        deltas.push({
          sport, game: `${away}@${home}`, gameDate: td, market: "total", side: "over", line: t.line,
          kalshiPct: te.over, polyPct, deltaCents: +(polyPct - te.over).toFixed(1), modelTruePct: te.overTrue,
        });
        matchedThisGame = true;
      }
      if (t.under != null && te.under != null) {
        const polyPct = +(t.under * 100).toFixed(1);
        deltas.push({
          sport, game: `${away}@${home}`, gameDate: td, market: "total", side: "under", line: t.line,
          kalshiPct: te.under, polyPct, deltaCents: +(polyPct - te.under).toFixed(1), modelTruePct: null,
        });
        matchedThisGame = true;
      }
    }
    if (matchedThisGame) matchedGames++;
  }

  // Summary
  const abs = deltas.map((d) => Math.abs(d.deltaCents));
  const mlAbs = deltas.filter((d) => d.market === "ml").map((d) => Math.abs(d.deltaCents));
  const totAbs = deltas.filter((d) => d.market === "total").map((d) => Math.abs(d.deltaCents));
  const bySport = {};
  for (const d of deltas) bySport[d.sport] = (bySport[d.sport] || 0) + 1;
  return {
    n: deltas.length,
    polyGames: (polyGames || []).length,
    matchedGames,
    medianAbsDeltaCents: _median(abs),
    maxAbsDeltaCents: abs.length ? Math.max(...abs) : null,
    byMarket: {
      ml: { n: mlAbs.length, medianAbs: _median(mlAbs) },
      total: { n: totAbs.length, medianAbs: _median(totAbs) },
    },
    bySport,
  };
}
