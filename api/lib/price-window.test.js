// Pins the price-window math extracted from shadow.js (2026-07-01) into the shared module that
// both the report (bettingBoard) and the tune:window CLI consume. The report's discoveredWindow +
// PROMOTE ladder ride on discoverPriceWindow/windowQuality, so a regression here silently moves
// every category's derived betting range.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverPriceWindow, windowQuality, priceWindowBins, playsToCells,
  MIN_N_WINDOW, MIN_N_PROMOTE,
} from "./price-window.js";

// Helper: a 5¢ cell.
const cell = (lo, n, hitRate, avgPrice) => ({ lo, n, wins: Math.round(n * hitRate), avgPrice });

test("playsToCells buckets bet-side prices into 5¢ cells with wins + avg price", () => {
  const cells = playsToCells([
    { betPct: 72, won: 1 }, { betPct: 74, won: 0 }, { betPct: 71, won: 1 }, // → lo 70
    { betPct: 88, won: 1 }, { betPct: 89, won: 1 },                          // → lo 85
  ]);
  const c70 = cells.find((c) => c.lo === 70);
  const c85 = cells.find((c) => c.lo === 85);
  assert.equal(c70.n, 3); assert.equal(c70.wins, 2);
  assert.ok(Math.abs(c70.avgPrice - (72 + 74 + 71) / 3) < 1e-9);
  assert.equal(c85.n, 2); assert.equal(c85.wins, 2);
});

test("playsToCells drops out-of-range / non-finite prices", () => {
  const cells = playsToCells([
    { betPct: 80, won: 1 }, { betPct: 120, won: 1 }, { betPct: -5, won: 0 }, { betPct: null, won: 1 },
  ]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].lo, 80);
});

test("discoverPriceWindow finds the highest-ROI contiguous band clearing minN", () => {
  // A losing low band + a clearly profitable high band, each ≥ MIN_N_WINDOW.
  const cells = [
    cell(60, 40, 0.55, 62), // ROI ≈ -0.07
    cell(85, 40, 0.95, 88), // ROI ≈ +0.07
    cell(90, 40, 0.97, 91), // ROI ≈ +0.06
  ];
  const win = discoverPriceWindow(cells);
  assert.ok(win, "should find a window");
  assert.ok(win.lo >= 85, `window should start in the profitable high band, got ${win.lo}`);
  assert.ok(win.roi > 0, `window ROI should be positive, got ${win.roi}`);
});

test("discoverPriceWindow returns null when no contiguous range clears minN", () => {
  const cells = [cell(70, 5, 0.9, 72), cell(85, 5, 0.9, 88)]; // 10 total < MIN_N_WINDOW (30)
  assert.equal(discoverPriceWindow(cells), null);
  assert.ok(MIN_N_WINDOW > 10);
});

test("windowQuality: CI lower bound < point ROI, and coherence flags a one-sided fluke", () => {
  // discoverPriceWindow only returns a MULTI-bin window when neither bin alone clears MIN_N_WINDOW
  // (combined ROI is a weighted avg of the singles → never beats the best single). Use sub-floor
  // bins so the two-bin window is forced, which is what exercises the coherence half-split.
  const half = Math.ceil(MIN_N_WINDOW * 0.7); // < MIN_N_WINDOW alone, ≥ it combined

  // Coherent: both halves profitable.
  const coherentCells = [cell(85, half, 0.95, 88), cell(90, half, 0.96, 91)];
  const cWin = discoverPriceWindow(coherentCells);
  assert.ok(cWin.hi - cWin.lo > 5, "expected a forced two-bin window");
  const cQ = windowQuality(coherentCells, cWin);
  assert.ok(cQ.roiLoCI < cWin.roi, "CI-lo must sit below the point estimate");
  assert.equal(cQ.coherent, true);

  // One lucky high bin dragging a clearly losing lower half → not coherent.
  const flukeCells = [cell(85, half, 0.55, 88), cell(90, half, 0.99, 91)];
  const fWin = discoverPriceWindow(flukeCells);
  assert.ok(fWin.hi - fWin.lo > 5, "expected a forced two-bin window");
  const fQ = windowQuality(flukeCells, fWin);
  assert.equal(fQ.coherent, false, "a losing lower half must fail coherence");
});

test("priceWindowBins adaptive-merges thin cells up to the target n", () => {
  const bins = priceWindowBins([cell(70, 5, 0.8, 72), cell(75, 5, 0.8, 77), cell(80, 20, 0.8, 82)], 15);
  // First two thin cells merge; the fat one stands alone → 2 bins, all n ≥ target-ish.
  assert.ok(bins.length <= 2);
  assert.ok(bins.every((b) => b.n >= 10));
});

test("promote floor is at least the window-trust floor", () => {
  assert.ok(MIN_N_PROMOTE >= MIN_N_WINDOW);
});
