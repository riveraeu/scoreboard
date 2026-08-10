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
// `f5total-5054` (docs/MAKER_F5TOTAL_PREREG.md) was KILLED EARLY on 2026-08-03 — day 3 of 8, below
// the sample floor but failing every mechanism/PnL criterion (mean −4.8¢, sideWon 0.565 vs the < 0.45
// bar, day-clustered CI-lo −14.7). A discretionary stop-risk kill, not a checkpoint verdict; per the
// KILL rule a failed forward test is the answer and the cell is not re-sliced. It is NOT in this
// registry — a new forward test is a new id + a new doc, never a re-open.
//
// `hrr-7074` (docs/MAKER_HRR_PREREG.md) added 2026-08-05 — the only cell to clear the robustCandidates
// structural bar on the 8/05 tripwire (in-sample +20.29¢/ct, 66 fills / 10 days, day-clustered CI
// [+4.39, +36.18], sideWon ~0.52 vs ~0.72 priced). Criteria fixed before the 2026-08-05 forward window
// opened; sideWonBelow is 0.60 not 0.45 because this favorite is priced ~72¢, not a coinflip.
//
// `ks-1519` (docs/MAKER_KS_PREREG.md) added 2026-08-06 — second cell on the 8/06 tripwire (in-sample
// +5.47¢/ct, 221 fills / 8 days, day-clustered CI [+0.08, +10.86], weighted sideWon ~0.114 vs ~0.165
// priced). Longshot-side mechanism (whichever of YES/NO on KXMLBKS is in the 15-19¢ range).
// sideWonBelow is 0.14 — materially below the ~16.5¢ avg ask, room for forward variance.
//
// `totalruns-1519` (docs/MAKER_TOTALRUNS_PREREG.md) added 2026-08-10 — 8/09 tripwire hit (in-sample
// +9.37¢/ct, 333 fills / 11 days, day-clustered CI [+5.03, +13.72], weighted sideWon ~0.077 vs ~0.17
// priced). Symmetric tail-overpricing mechanism: NO side on low thresholds (under 5-6 runs) and YES
// side on high thresholds (over 11-14 runs) both land in 15-19¢; same game contributes both when the
// actual total is normal (7-10 runs). sideWonBelow is 0.13 — well below ~17¢ avg ask, above in-sample
// 0.077 for variance headroom.
//
// `wnbatp-2024/2529/3034` (docs/MAKER_WNBA_TP_PREREG.md) added 2026-08-10 — 3-band cluster from the
// 8/09 tripwire (17 hits, 3 adjacent in wnba|totalPoints): in-sample sideWon ~0.056/0.051/0.120 vs
// ~22/27/32¢ priced — near-zero on 9/10 days for the lower two bands. Mechanism: extreme-threshold
// WNBA total-points markets overprice the longshot side; the quoted side wins far less than priced.
// sideWonBelow 0.15/0.15/0.22 (per-band; headroom above in-sample, materially below each avg ask).
// All three must pass GREEN; partial cluster pass does not authorize capital.
//
// `wnbasp-1014/1519/2024` (docs/MAKER_WNBA_SP_PREREG.md) added 2026-08-10 — 3-band cluster from the
// same 8/09 tripwire (wnba|spread); in-sample sideWon ~0.015/0.072/0.000 vs ~12/17/22¢ priced. The
// 20-24 band has sideWon=0 across all 10 days (CI mechanically tight; not a data artifact). Mechanism:
// WNBA underdog spread markets overprice the cover probability — market makers anchor off money-line
// without accounting for the additional hurdle of covering the number. Shared bad day: 8/6 is the sole
// losing day for 10-14 and 15-19 (same upset game); 20-24 had fills that day and still didn't cover.
// sideWonBelow 0.08/0.12/0.12. All three must pass GREEN; partial cluster pass does not authorize capital.
export const PREREG_CELLS = [
  {
    id: "hrr-7074", sport: "mlb", category: "hrr", band: "70-74",
    doc: "docs/MAKER_HRR_PREREG.md", label: "MLB HRR favorite 70-74¢",
    forwardStart: "2026-08-05", checkpoint: "2026-08-19",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.60, minDays: 8, minFills: 50 },
  },
  {
    id: "ks-1519", sport: "mlb", category: "strikeouts", band: "15-19",
    doc: "docs/MAKER_KS_PREREG.md", label: "MLB strikeouts longshot 15-19¢",
    forwardStart: "2026-08-06", checkpoint: "2026-08-20",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.14, minDays: 8, minFills: 50 },
  },
  {
    id: "totalruns-1519", sport: "mlb", category: "totalRuns", band: "15-19",
    doc: "docs/MAKER_TOTALRUNS_PREREG.md", label: "MLB total runs tail 15-19¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-23",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.13, minDays: 8, minFills: 50 },
  },
  {
    id: "wnbatp-2024", sport: "wnba", category: "totalPoints", band: "20-24",
    doc: "docs/MAKER_WNBA_TP_PREREG.md", label: "WNBA total points longshot 20-24¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.15, minDays: 8, minFills: 50 },
  },
  {
    id: "wnbatp-2529", sport: "wnba", category: "totalPoints", band: "25-29",
    doc: "docs/MAKER_WNBA_TP_PREREG.md", label: "WNBA total points longshot 25-29¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.15, minDays: 8, minFills: 50 },
  },
  {
    id: "wnbatp-3034", sport: "wnba", category: "totalPoints", band: "30-34",
    doc: "docs/MAKER_WNBA_TP_PREREG.md", label: "WNBA total points longshot 30-34¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.22, minDays: 8, minFills: 50 },
  },
  {
    id: "wnbasp-1014", sport: "wnba", category: "spread", band: "10-14",
    doc: "docs/MAKER_WNBA_SP_PREREG.md", label: "WNBA spread underdog 10-14¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.08, minDays: 8, minFills: 50 },
  },
  {
    id: "wnbasp-1519", sport: "wnba", category: "spread", band: "15-19",
    doc: "docs/MAKER_WNBA_SP_PREREG.md", label: "WNBA spread underdog 15-19¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.12, minDays: 8, minFills: 50 },
  },
  {
    id: "wnbasp-2024", sport: "wnba", category: "spread", band: "20-24",
    doc: "docs/MAKER_WNBA_SP_PREREG.md", label: "WNBA spread underdog 20-24¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.12, minDays: 8, minFills: 50 },
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
