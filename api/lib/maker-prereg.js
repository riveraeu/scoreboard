// api/lib/maker-prereg.js
// Pre-registered maker forward tests — the ONE doctrine-sanctioned "when will we know" surface.
//
// A cell picked off the category × band heatmap for being the brightest is best-of-N selection: at
// a one-sided 95% bar ~1/40 of cells clear zero by chance with zero real edge, so the bright cells
// are (mostly) noise and putting a data-extrapolated "ETA to arm" on them would be the re-slicing
// the REENTRY doctrine has gone 0-for-6 on. The only honest countdown is a CALENDAR checkpoint on a
// cell whose bar was fixed BEFORE the forward window opened. Each entry here mirrors a committed
// docs/MAKER_*_PREREG.md; changing any threshold voids that pre-registration, so maker-prereg.test.js
// pins every value. Adding a second pre-registered cell is a new array entry + a new PREREG doc.

export const PREREG_CELLS = [
  {
    id: "f5total-5054",
    sport: "mlb", category: "f5total", band: "50-54",
    doc: "docs/MAKER_F5TOTAL_PREREG.md",
    label: "mlb f5total 50-54",
    hypothesis: "market overprices the barely-favorite side of first-5 totals — the sold (favorite) "
      + "side should win materially less than its ~52% price implies",
    forwardStart: "2026-07-30", // OOS = game_date >= this (first day fully after the in-sample set)
    checkpoint: "2026-08-13",   // ~2 weeks / ~14 MLB days
    // GREEN criteria — ALL must hold on the forward window (fixed 2026-07-29, docs/MAKER_F5TOTAL_PREREG.md).
    criteria: {
      ciLoAbove: 0,          // 1. day-clustered CI lower bound > 0
      meanFloorC: 5,         // 2. mean >= +5¢/contract (clears variance drag + fees + adverse selection)
      positiveDayFrac: 0.60, // 3. positive on >= 60% of forward days (not one slate carrying it)
      sideWonBelow: 0.45,    // 4. sold side wins < 45% (the mechanism must persist, not just PnL)
      minDays: 8,            // 5a. sample floor — days
      minFills: 50,          // 5b. sample floor — fills
    },
  },
];

// Pure evaluation of a forward result against a spec's fixed criteria. `result` carries exactly the
// fields the report's makerCell aggregation produces for the forward window (so the verdict matches
// `GET /api/shadow-report?makerCell=<cell>&since=<forwardStart>` by construction). `nowPT` is today's
// PT date as YYYY-MM-DD — string comparison is safe on that format.
//
// Verdict ladder: COLLECTING until the sample floor is met; then ON_TRACK / FAILING while still
// before the checkpoint (provisional — the forward result can still move); PASS / KILL only once the
// checkpoint date has arrived, which is the point the pre-registration says the decision is made.
export function evaluatePrereg(spec, result, nowPT) {
  const c = spec.criteria;
  const { days = 0, fills = 0, mean = null, ciLo = null, positiveDays = 0, sideWon = null } = result || {};
  const sampleMet = days >= c.minDays && fills >= c.minFills;
  const posFrac = days > 0 ? positiveDays / days : null;

  const checks = [
    { key: "ciLo",    label: `day-clustered CI-lo > ${c.ciLoAbove}`,           actual: ciLo,
      met: ciLo != null && ciLo > c.ciLoAbove },
    { key: "mean",    label: `mean ≥ +${c.meanFloorC}¢/ct`,                    actual: mean,
      met: mean != null && mean >= c.meanFloorC },
    { key: "posDays", label: `≥ ${Math.round(c.positiveDayFrac * 100)}% days positive`,
      actual: posFrac != null ? Math.round(posFrac * 100) / 100 : null,
      met: posFrac != null && posFrac >= c.positiveDayFrac },
    { key: "sideWon", label: `sideWon < ${c.sideWonBelow}`,                    actual: sideWon,
      met: sideWon != null && sideWon < c.sideWonBelow },
    { key: "sample",  label: `≥ ${c.minDays}d & ≥ ${c.minFills} fills`,        actual: `${days}d/${fills}`,
      met: sampleMet },
  ];

  const allMet = checks.every((x) => x.met);
  const pastCheckpoint = nowPT != null && nowPT >= spec.checkpoint;
  const verdict = pastCheckpoint
    ? (allMet ? "PASS" : "KILL")
    : (!sampleMet ? "COLLECTING" : (allMet ? "ON_TRACK" : "FAILING"));

  return { checks, allMet, sampleMet, pastCheckpoint, verdict,
    metCount: checks.filter((x) => x.met).length, totalCount: checks.length };
}
