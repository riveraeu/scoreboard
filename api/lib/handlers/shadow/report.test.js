// node --test api/lib/handlers/shadow/report.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { computeRobustCandidates, ROBUST_BAR, computeVenueVig, venueCategoryFromKalshiTicker } from "./report.js";

// computeRobustCandidates is the heatmap-robustness TRIPWIRE, not a shortlist. A cell must clear a
// strict STRUCTURAL bar — day-clustered CI already excludes zero (`reliable`), >= 8 days, >= 50 fills,
// top-day share <= 0.35 — before it is even a pre-registration candidate. These tests pin the bar so
// it can't silently loosen into the in-sample target-picker the doctrine forbids.

// A cell that clears every part of the bar. Reused as the base for the negative cases.
const ROBUST = { sport: "mlb", category: "f5total", band: "50-54", reliable: true,
  days: 10, fills: 120, perContract: 6.2, ciLo: 1.4, ciHi: 11.0, topDayShare: 0.28 };

const wrap = (cells) => computeRobustCandidates({ categoryBands: cells });

test("bar values are pinned (mirror the f5total pre-registration sample floor)", () => {
  assert.deepEqual(ROBUST_BAR, { minDays: 8, minFills: 50, maxTopDayShare: 0.35 });
});

test("empty / missing board → count 0, no candidates, does not throw", () => {
  for (const mb of [null, undefined, {}, { categoryBands: null }, { categoryBands: [] }]) {
    const r = computeRobustCandidates(mb);
    assert.equal(r.count, 0);
    assert.deepEqual(r.candidates, []);
    assert.match(r.note, /nothing to pre-register/);
  }
});

test("a genuinely robust cell surfaces (with the NOT-a-bet-list note)", () => {
  const r = wrap([ROBUST]);
  assert.equal(r.count, 1);
  assert.equal(r.candidates[0].cell, "mlb|f5total|50-54");
  assert.match(r.note, /NOT a bet list/);
  assert.match(r.note, /mechanism-first pre-registration/);
});

test("each part of the bar is load-bearing — a cell failing any ONE part is excluded", () => {
  assert.equal(wrap([{ ...ROBUST, reliable: false }]).count, 0, "reliable=false (CI does not clear zero)");
  assert.equal(wrap([{ ...ROBUST, days: 7 }]).count, 0, "< 8 days");
  assert.equal(wrap([{ ...ROBUST, fills: 49 }]).count, 0, "< 50 fills");
  assert.equal(wrap([{ ...ROBUST, topDayShare: 0.36 }]).count, 0, "top-day share > 0.35 (one slate)");
  assert.equal(wrap([{ ...ROBUST, topDayShare: null }]).count, 0, "unknown top-day share is not trusted");
});

test("boundary values are inclusive exactly as documented", () => {
  assert.equal(wrap([{ ...ROBUST, days: 8, fills: 50, topDayShare: 0.35 }]).count, 1);
});

test("a bright-but-thin cell (the selection-noise case) is refused", () => {
  // +42¢/ct looks like the best cell on the board, but 3 days / one slate / n=17 is exactly the
  // best-of-555 artifact the bar exists to reject.
  const bright = { sport: "wnba", category: "spread", band: "40-44", reliable: true,
    days: 3, fills: 17, perContract: 42.0, ciLo: 40, ciHi: 44, topDayShare: 0.57 };
  assert.equal(wrap([bright]).count, 0);
});

test("candidates are sorted by perContract desc; robust negatives never appear (excluded by reliable)", () => {
  const a = { ...ROBUST, category: "a", perContract: 3.1 };
  const b = { ...ROBUST, category: "b", perContract: 9.4 };
  const negRobust = { ...ROBUST, category: "c", perContract: -8.0, reliable: false }; // ciHi<0 side → reliable=false
  const r = wrap([a, b, negRobust]);
  assert.deepEqual(r.candidates.map((c) => c.category), ["b", "a"]);
});

// ── Cross-venue vig ───────────────────────────────────────────────────────────────────────────
// venueCategoryFromKalshiTicker maps a Kalshi series ticker onto Poly's three families. The
// startsWith(PREFIX + "-") rule must isolate the F5 WINNER from F5 total/spread and the full-game
// total from team-total — a drift here silently pools different market classes into one vig cell.
test("venueCategoryFromKalshiTicker: series prefixes isolate ml/total/f5, siblings reject", () => {
  assert.equal(venueCategoryFromKalshiTicker("KXMLBGAME-26AUG04LADCHC-LAD"), "ml");
  assert.equal(venueCategoryFromKalshiTicker("KXWNBAGAME-26AUG04TORGSV-GSV"), "ml");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBTOTAL-26AUG04LADCHC-8.5"), "total");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBF5-26AUG041940LADCHC-LAD"), "f5");
  // siblings that must NOT be miscategorized (out of Poly scope → null)
  assert.equal(venueCategoryFromKalshiTicker("KXMLBF5TOTAL-26AUG04LADCHC-4.5"), null);
  assert.equal(venueCategoryFromKalshiTicker("KXMLBF5SPREAD-26AUG04LADCHC-0.5"), null);
  assert.equal(venueCategoryFromKalshiTicker("KXMLBTEAMTOTAL-26AUG04LADCHC-LAD3.5"), null);
  assert.equal(venueCategoryFromKalshiTicker("KXMLBSPREAD-26AUG04LADCHC-1.5"), null);
  assert.equal(venueCategoryFromKalshiTicker(""), null);
});

test("computeVenueVig: vig = ask − win; Δ only when both venues present; reliability bar", () => {
  const k = (sport, category, band, n, days, avg_ask, win_pct) => ({ sport, category, band, n, days, avg_ask, win_pct });
  const kalshi = [
    k("mlb", "ml", "60-64", 200, 8, 62.0, 58.0),   // vig +4.0, reliable-eligible
    k("mlb", "total", "50-54", 10, 2, 52.0, 49.0),  // vig +3.0, below bar (n<50, days<3)
  ];
  const poly = [
    k("mlb", "ml", "60-64", 120, 6, 61.0, 59.0),    // vig +2.0
  ];
  const r = computeVenueVig(kalshi, poly);
  const ml = r.cells.find((c) => c.category === "ml");
  assert.equal(ml.kalshi.vig, 4);
  assert.equal(ml.poly.vig, 2);
  assert.equal(ml.deltaVig, 2);       // 4 − 2
  assert.equal(ml.reliable, true);    // both n≥50 and days≥3
  const tot = r.cells.find((c) => c.category === "total");
  assert.equal(tot.kalshi.vig, 3);
  assert.equal(tot.poly, null);
  assert.equal(tot.deltaVig, null);   // no Poly side → no Δ
  assert.equal(tot.reliable, false);  // thin + one-sided
  assert.deepEqual(r.venuesPresent, { kalshi: 210, poly: 120 });
  assert.match(r.note, /never a bet/);
});
