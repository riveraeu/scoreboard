// api/lib/maker-prereg.js
// Pre-registered maker forward tests — the ONE doctrine-sanctioned "when will we know" surface.
//
// A cell picked off the category × band heatmap for being the brightest is best-of-N selection: at
// a one-sided 95% bar ~1/40 of cells clear zero by chance with zero real edge, so the bright cells
// are (mostly) noise and putting a data-extrapolated "ETA to arm" on them would be the re-slicing
// the REENTRY doctrine has gone 0-for-6 on. The only honest countdown is a CALENDAR checkpoint on a
// cell whose bar was fixed BEFORE the forward window opened. Each entry here mirrors a committed
// docs/MAKER_*_PREREG.md; changing any threshold voids that pre-registration, so maker-prereg.test.js
// pins every value. Adding a pre-registered cell is a new array entry + a new PREREG doc.
//
// Currently EMPTY. The one entry, `f5total-5054` (docs/MAKER_F5TOTAL_PREREG.md), was KILLED EARLY on
// 2026-08-03 — day 3 of 8, below the sample floor but failing every mechanism/PnL criterion (mean
// −4.8¢, sideWon 0.565 vs the < 0.45 bar, day-clustered CI-lo −14.7). A discretionary stop-risk
// kill, not a checkpoint verdict; per the KILL rule a failed forward test is the answer and the cell
// is not re-sliced. The next forward test is a new id + a new doc, not a re-open of this one.
export const PREREG_CELLS = [];

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
