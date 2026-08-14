// node --test api/lib/handlers/shadow/report.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { computeRobustCandidates, ROBUST_BAR, ROBUST_ONE_SIDED_RATE, computeVenueVig, venueCategoryFromKalshiTicker, computePolymarketTracking, pVigSportCaseSql } from "./report.js";

// computeRobustCandidates is the heatmap-robustness TRIPWIRE, not a shortlist. A cell must clear a
// strict STRUCTURAL bar — day-clustered CI already excludes zero (`reliable`), >= 8 days, >= 50 fills,
// top-day share <= 0.35 — before it is even a pre-registration candidate. These tests pin the bar so
// it can't silently loosen into the in-sample target-picker the doctrine forbids.
//
// They ALSO pin the three properties added 2026-08-11, each of which exists to stop the payload from
// reading as a shortlist: the denominator + noise floor (so `count` is never read bare), the NEGATIVE
// arm (so a price-monotone book can't light one side and look like 23 discoveries), and cell-name
// ordering (so the array itself ranks nothing). See docs/MAKER_LADDER_ARTIFACT.md.

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

test("candidates are ordered by cell NAME, never by perContract (ordering must rank nothing)", () => {
  // The brightest cell must not float to the top: a perContract-sorted array is a ranked shortlist
  // however the note is worded, which is the same objection that killed the "best-green" heatmap shade.
  const a = { ...ROBUST, category: "a", perContract: 3.1 };
  const z = { ...ROBUST, category: "z", perContract: 99.0 };
  const r = wrap([z, a]);
  assert.deepEqual(r.candidates.map((c) => c.category), ["a", "z"]);
});

test("the NEGATIVE arm is reported alongside, not dropped", () => {
  // A robustly-negative cell is the mirror of a robustly-positive one. Reporting only the positive
  // arm is what let a near-symmetric board (23 up / 26 down on 2026-08-11) read as 23 discoveries.
  const up = { ...ROBUST, category: "up", perContract: 9.4 };
  const down = { ...ROBUST, category: "down", perContract: -8.0, reliable: false, ciLo: -14.2, ciHi: -1.9 };
  const r = wrap([up, down]);
  assert.equal(r.count, 1, "positive arm unchanged — negatives still never become candidates");
  assert.deepEqual(r.candidates.map((c) => c.category), ["up"]);
  assert.equal(r.negativeCount, 1);
  assert.deepEqual(r.negatives.map((c) => c.category), ["down"]);
});

test("a straddling cell counts toward eligible but toward neither arm", () => {
  const straddle = { ...ROBUST, category: "s", perContract: 0.4, reliable: false, ciLo: -3.0, ciHi: 4.1 };
  const r = wrap([straddle]);
  assert.equal(r.eligible, 1);
  assert.equal(r.count, 0);
  assert.equal(r.negativeCount, 0);
});

test("eligible is the sample bar ALONE — the denominator count must be read against", () => {
  // Cells failing the sample bar are not eligible at all, so they must not inflate the noise floor.
  const r = wrap([ROBUST, { ...ROBUST, category: "thin", days: 3, fills: 17, reliable: false, ciLo: null, ciHi: null }]);
  assert.equal(r.eligible, 1, "the thin cell is not part of the denominator");
  assert.equal(r.noiseFloor, parseFloat((1 * ROBUST_ONE_SIDED_RATE).toFixed(1)));
});

test("the note states the null and never reads as a shortlist", () => {
  assert.equal(ROBUST_ONE_SIDED_RATE, 0.05);
  // Populated board: the null and the asymmetry travel with the payload.
  const r = wrap([ROBUST]);
  assert.match(r.note, /idle state is NOT zero/);
  assert.match(r.note, /1 positive vs 0 negative of 1 eligible/);
  assert.match(r.note, /ASYMMETRY/);
  assert.doesNotMatch(r.note, /top pick|best|ranked/i);
  // Eligible cells but nothing lit — still "nothing to pre-register", now with the denominator.
  const quiet = wrap([{ ...ROBUST, reliable: false, ciLo: -3.0, ciHi: 4.1 }]);
  assert.equal(quiet.count, 0);
  assert.match(quiet.note, /nothing to pre-register/);
  assert.match(quiet.note, /of 1 eligible/);
});

// ── Cross-venue vig ───────────────────────────────────────────────────────────────────────────
// venueCategoryFromKalshiTicker maps a Kalshi series ticker onto Poly's three families. The
// startsWith(PREFIX + "-") rule must isolate the F5 WINNER from F5 total/spread and the full-game
// total from team-total — a drift here silently pools different market classes into one vig cell.
test("venueCategoryFromKalshiTicker: series prefixes isolate ml/total/spread/f5 families", () => {
  assert.equal(venueCategoryFromKalshiTicker("KXMLBGAME-26AUG04LADCHC-LAD"), "ml");
  assert.equal(venueCategoryFromKalshiTicker("KXWNBAGAME-26AUG04TORGSV-GSV"), "ml");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBTOTAL-26AUG04LADCHC-8.5"), "total");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBF5-26AUG041940LADCHC-LAD"), "f5");
  // Added to Poly scope 2026-08-13 — each must land in its OWN category, never pooled into the
  // shorter prefix it shares a stem with (KXMLBF5-, KXMLBTOTAL-).
  assert.equal(venueCategoryFromKalshiTicker("KXMLBSPREAD-26AUG04LADCHC-1.5"), "spread");
  assert.equal(venueCategoryFromKalshiTicker("KXWNBASPREAD-26AUG04TORGSV-5.5"), "spread");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBF5TOTAL-26AUG04LADCHC-4.5"), "f5total");
  assert.equal(venueCategoryFromKalshiTicker("KXMLBF5SPREAD-26AUG04LADCHC-0.5"), "f5spread");
  // still out of Poly scope → null
  assert.equal(venueCategoryFromKalshiTicker("KXMLBTEAMTOTAL-26AUG04LADCHC-LAD3.5"), null);
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

test("pVigSportCaseSql: derived from vigSport, never a hand-maintained list", () => {
  assert.equal(pVigSportCaseSql({}), "sport");
  assert.equal(pVigSportCaseSql({ mlb: { series: "3" } }), "sport"); // no vigSport anywhere -> no CASE
  const sql = pVigSportCaseSql({
    atp: { vigSport: "tennis" }, wta: { vigSport: "tennis" },
    bra: { vigSport: "brasileirao" }, nwsl: {}, mlb: { series: "3" },
  });
  assert.match(sql, /^CASE .* ELSE sport END$/);
  assert.match(sql, /WHEN sport = 'atp' THEN 'tennis'/);
  assert.match(sql, /WHEN sport = 'wta' THEN 'tennis'/);
  assert.match(sql, /WHEN sport = 'bra' THEN 'brasileirao'/);
  // no vigSport -> no WHEN clause for that slug (falls through to the ELSE, passthrough unchanged)
  assert.doesNotMatch(sql, /WHEN sport = 'nwsl'/);
  assert.doesNotMatch(sql, /WHEN sport = 'mlb'/);
});

test("computePolymarketTracking: capture/resolution rollup + venueVig divergence summary", () => {
  const venueVig = {
    venuesPresent: { kalshi: 300, poly: 180 },
    cells: [
      { sport: "mlb", category: "ml", band: "60-64", kalshi: { vig: 4 }, poly: { vig: 2 }, deltaVig: 2, reliable: true },
      { sport: "mlb", category: "total", band: "50-54", kalshi: { vig: 3 }, poly: { vig: -3 }, deltaVig: 6, reliable: false },
      { sport: "mlb", category: "f5", band: "55-59", kalshi: { vig: 1 }, poly: null, deltaVig: null, reliable: false }, // one-sided
    ],
  };
  const agg = { total: 900, graded: 300, voided: 12, pending: 588, capture_days: 3, last_capture: "2026-08-06" };
  const recentBySport = [{ sport: "mlb", n: 240, graded: 0 }, { sport: "wnba", n: 60, graded: 0 }];
  const r = computePolymarketTracking({ agg, recentBySport, venueVig });

  assert.equal(r.capture.total, 900);
  assert.equal(r.capture.captureDays, 3);
  assert.equal(r.capture.lastCapture, "2026-08-06");
  assert.equal(r.capture.lastCaptureRows, 300); // 240 + 60
  assert.deepEqual(r.resolution, { graded: 300, voided: 12, pending: 588 });
  assert.deepEqual(r.vig.venuesPresent, { kalshi: 300, poly: 180 });
  assert.equal(r.vig.bothVenueCells, 2);   // ml + total (f5 is one-sided)
  assert.equal(r.vig.reliableCells, 1);    // only ml
  // top divergence sorted by |deltaVig|: total (|6|) before ml (|2|); one-sided cell excluded
  assert.deepEqual(r.vig.topDivergences.map((d) => d.cell), ["mlb|total|50-54", "mlb|ml|60-64"]);
  assert.match(r.note, /never a bet list/);
});

test("computePolymarketTracking: empty/early state is well-formed, not null", () => {
  const r = computePolymarketTracking({ agg: {}, recentBySport: [], venueVig: null });
  assert.equal(r.capture.total, 0);
  assert.equal(r.capture.lastCapture, null);
  assert.deepEqual(r.vig.topDivergences, []);
  assert.deepEqual(r.vig.venuesPresent, { kalshi: 0, poly: 0 });
});
