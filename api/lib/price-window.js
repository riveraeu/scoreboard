// Price-window math — the data-derived betting range for a category.
//
// Profit is realized against the PRICE paid, not the model's number: ROI = hitRate − price.
// So the betting-window question ("is 67–91 right?") is a price-axis question. These helpers
// work a per-category 5¢ price histogram of bettable plays (dc_qualified + edge≥5, NO price
// window, NO truePct gate — those are the assumptions under test) so the data sets the bounds.
//
// A `cell` is a 5¢ price bucket: { lo, n, wins, avgPrice }. Extracted from shadow.js so the
// report (api/lib/handlers/shadow.js) and the CLI recommender (scripts/tune/window-recommender.js)
// share ONE implementation.

export const MIN_N_WINDOW  = 30; // min n to trust a discovered price window
export const MIN_N_PROMOTE = 50; // min n in the window to promote an ungated category

// Adaptive-merge adjacent 5¢ cells until each display bin clears `target` n — bin WIDTHS come
// from where the data actually is, not from fixed guesses. Trailing remainder folds left.
export function priceWindowBins(cells, target = 15) {
  const sorted = [...cells].sort((a, b) => a.lo - b.lo);
  const out = [];
  let cur = null;
  for (const c of sorted) {
    if (!cur) cur = { lo: c.lo, hi: c.lo + 5, n: 0, wins: 0, pSum: 0 };
    cur.hi = c.lo + 5; cur.n += c.n; cur.wins += c.wins; cur.pSum += c.avgPrice * c.n;
    if (cur.n >= target) { out.push(cur); cur = null; }
  }
  if (cur) {
    if (out.length) { const l = out[out.length - 1]; l.hi = cur.hi; l.n += cur.n; l.wins += cur.wins; l.pSum += cur.pSum; }
    else out.push(cur);
  }
  return out.map(b => {
    const avgPrice = b.pSum / b.n;
    return { lo: b.lo, hi: b.hi, n: b.n,
      hitRate: parseFloat((100 * b.wins / b.n).toFixed(1)),
      avgPrice: parseFloat(avgPrice.toFixed(1)),
      roi: parseFloat((b.wins / b.n - avgPrice / 100).toFixed(4)) };
  });
}

// Best contiguous price window by ROI, subject to n ≥ minN — the data-derived betting range.
export function discoverPriceWindow(cells, minN = MIN_N_WINDOW) {
  const s = [...cells].sort((a, b) => a.lo - b.lo);
  let best = null;
  for (let i = 0; i < s.length; i++) {
    let n = 0, wins = 0, pSum = 0;
    for (let j = i; j < s.length; j++) {
      n += s[j].n; wins += s[j].wins; pSum += s[j].avgPrice * s[j].n;
      if (n < minN) continue;
      const roi = wins / n - (pSum / n) / 100;
      if (!best || roi > best.roi) best = { lo: s[i].lo, hi: s[j].lo + 5, n, wins, pSum, roi };
    }
  }
  if (!best) return null;
  const avgPrice = best.pSum / best.n;
  return { lo: best.lo, hi: best.hi, n: best.n,
    roi: parseFloat(best.roi.toFixed(4)),
    hitRate: parseFloat((100 * best.wins / best.n).toFixed(1)),
    avgPrice: parseFloat(avgPrice.toFixed(1)) };
}

// Promotion validation for a discovered window: 95% CI on ROI (binomial SE on the hit rate,
// since ROI = hitRate − ~fixed price) + a half-split coherence test (both price-halves of the
// window non-negative — guards against a single lucky bin masquerading as a profitable regime,
// the selection-bias hazard of maximizing ROI over candidate windows). `cells` are the window's
// component 5¢ bins.
export function windowQuality(cells, win) {
  if (!win) return null;
  const p = win.hitRate / 100;
  const se = Math.sqrt(Math.max(0, p * (1 - p) / win.n));
  const roiLoCI = parseFloat((win.roi - 1.96 * se).toFixed(4));
  const roiHiCI = parseFloat((win.roi + 1.96 * se).toFixed(4));
  const inWin = cells.filter(c => c.lo >= win.lo && c.lo < win.hi).sort((a, b) => a.lo - b.lo);
  const _roiOf = arr => {
    const N = arr.reduce((s, c) => s + c.n, 0); if (!N) return null;
    const W = arr.reduce((s, c) => s + c.wins, 0);
    const P = arr.reduce((s, c) => s + c.avgPrice * c.n, 0);
    return W / N - (P / N) / 100;
  };
  let coherent = false;
  if (inWin.length >= 2) {
    const mid = win.lo + (win.hi - win.lo) / 2;
    const lo = _roiOf(inWin.filter(c => c.lo < mid));
    const up = _roiOf(inWin.filter(c => c.lo >= mid));
    coherent = (lo == null || lo >= -0.02) && (up == null || up >= -0.02);
  }
  return { roiLoCI, roiHiCI, coherent };
}

// Roll an array of bettable plays into 5¢ cells keyed on the floored bet-side price.
// Each play: { betPct (0–100), won (0/1 or bool) }. Prices outside [0,100] are dropped.
export function playsToCells(plays) {
  const byLo = new Map();
  for (const p of plays) {
    const price = p.betPct == null ? NaN : Number(p.betPct); // Number(null)===0 would slip through
    if (!Number.isFinite(price) || price < 0 || price > 100) continue;
    const lo = Math.floor(price / 5) * 5;
    const cell = byLo.get(lo) || { lo, n: 0, wins: 0, pSum: 0 };
    cell.n += 1;
    cell.wins += (p.won === true || p.won === 1) ? 1 : 0;
    cell.pSum += price;
    byLo.set(lo, cell);
  }
  return [...byLo.values()].map(c => ({ lo: c.lo, n: c.n, wins: c.wins, avgPrice: c.pSum / c.n }));
}
