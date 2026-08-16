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
// `hrr-7074` (docs/MAKER_HRR_PREREG.md) was added 2026-08-05 and KILLED EARLY on 2026-08-11 — day 6
// of 8, below the sample floor but failing all four substantive criteria (mean −8.73¢, day-clustered
// CI [−19.91, +2.44], 1 of 6 days positive, sideWon 0.801 vs the < 0.60 bar). Second discretionary
// stop-risk kill after f5total, and the stronger case of the two: the mechanism did not merely fail
// to appear, it INVERTED. The hypothesis was that a 70-74¢ favorite is overpriced — in-sample it won
// ~0.52 against ~0.72 priced, 20 points below. Forward it won 0.801 against ~71.7¢ priced, ~8 points
// ABOVE. Three of the six days ran sideWon exactly 1.0. Selling that favorite is the losing side of
// the trade, so no amount of remaining sample makes the pre-registered direction right.
// Per the KILL rule it is NOT in this registry and is NOT re-sliced: a new forward test is a new id
// + a new doc. The in-sample +20.29¢/ct is now the second worked example of the standing lesson that
// robustness is necessary and not sufficient — it was the ONLY cell of ~555 to clear the structural
// bar on 8/05 and it still inverted.
//
// `ks-1519` (docs/MAKER_KS_PREREG.md) added 2026-08-06, KILLED EARLY on 2026-08-16 — day 9 of the
// 8-day floor (sample floor was already met: 284 forward fills), failing 3 of 4 substantive criteria
// (mean −2.76¢, day-clustered CI [−9.98, +4.47], sideWon 0.2004 vs the < 0.14 bar). Third mechanism
// inversion after f5total-5054 and hrr-7074: in-sample the longshot side won ~0.114 against ~0.165
// priced (favorable, 5.1pp below price); forward it won 0.2004 against ~0.172 priced (unfavorable,
// 2.9pp ABOVE price) — 6 of 9 forward days ran hot (sideWon > priced ask), not one bad slate. Per the
// KILL rule it is NOT in this registry and is NOT re-sliced: a new forward test on KXMLBKS longshots
// is a new id + a new doc.
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
//
// `mlbsp-2529/3539` (docs/MAKER_MLB_SP_PREREG.md) added 2026-08-10 — 2-band cluster from the same 8/09
// tripwire (mlb|spread); in-sample sideWon ~0.149/0.227 vs ~27/37¢ priced. Different character from
// WNBA spread: sideWon genuinely fluctuates (0–0.305 non-outlier), not near-zero — underdogs cover
// sometimes, just less than priced. Shared bad day: 8/8 (sideWon 0.565/0.580). Same ML-anchor mechanism
// as WNBA spread, now cross-sport. 25-29 CI-lo is thin (+4.92¢, close to the +5¢ meanFloor).
// sideWonBelow 0.22/0.30. Both must pass GREEN; partial cluster pass does not authorize capital.
//
// `mlbf5t-2529` (docs/MAKER_MLB_F5T_PREREG.md) added 2026-08-10 — single cell from the 8/09 tripwire
// (mlb|f5total|25-29); in-sample sideWon ~0.166 vs ~27¢ priced, +12.07¢/ct, CI [+3.65, +20.48],
// 9/10 positive. Tail event: 7/31 sideWon=1.0 on 1 fill (3 contracts; named structural risk). ML-anchor
// mechanism applied to F5 half-game slice. Companion f5spread|25-29 NOT registered (CI-lo +1.16¢, two
// consecutive bad days 8/5-8/6). sideWonBelow 0.22.
//
// `wnba3p-6064` (docs/MAKER_WNBA_3P_PREREG.md) added 2026-08-10 — first threePointers hit on the 8/10
// tripwire (19 total hits, 9 already registered); in-sample sideWon ~0.327 vs ~62¢ priced, +29.20¢/ct,
// CI [+13.45, +44.95], 6/8 positive. Bad days 8/03 (sideWon 0.683) and 8/06 (0.875 — shared with wnbasp
// cluster). Mechanism: WNBA 3-point made prop at moderate-favorite price anchors on season avg without
// accounting for game-to-game 3PM variance. sideWonBelow 0.40.
//
// `wnbatp-1519` (docs/MAKER_WNBA_TP1519_PREREG.md) added 2026-08-10 — extends the wnbatp cluster to the
// more-extreme 15-19¢ tier; in-sample sideWon = **exactly 0** on all 8 days (54 fills, 275.2 contracts),
// +16.80¢/ct, CI [+16.42, +17.17] (mechanically tight — zero variance when every day has sideWon=0). The
// priced threshold is so far into the tail that no game crossed it across the entire sample. Same mechanism
// as wnbatp 20-34 but categorical: not merely underperformance, genuine non-occurrence. sideWonBelow 0.05.
// Separate registration (not appended to the existing cluster) because all-three-must-pass applies only to
// the cells registered together; adding a fourth post-hoc would change the cluster's decision rule.
//
// `mlbf5sp-2529` (docs/MAKER_MLB_F5SP_PREREG.md) added 2026-08-10 — companion to mlbf5t-2529 (F5 total);
// this is the F5 spread (run line) underdog. Was NOT registered 8/09 (CI-lo +1.16¢, two consecutive bad
// days 8/5-8/6); now cleared bar on 8/10 with 72 fills / 10 days, CI-lo +2.88¢ (wide: +2.88 to +21.71).
// Weighted sideWon ≈ 0.150 vs ~27¢ priced; bad days 8/05 (0.409) and 8/06 (0.588) are a structural risk.
// Same ML-anchor mechanism as mlbsp cluster, applied to F5 half-game. sideWonBelow 0.22.
//
// `wnbapts-2529` (docs/MAKER_WNBA_PTS_PREREG.md) added 2026-08-16 — new category (individual player
// points, first tripwire hit for this market). In-sample sideWon ~0.172 vs ~26.4¢ priced, +9.28¢/ct,
// CI [+1.37, +17.19], 11/13 positive, topDayShare 0.13 (lowest in its category). Netting screen: both
// halves of wnba|points are positive (+1.81/+3.81, whole +2.97) — not the mirrored price-ladder
// artifact. Same season-average-anchor mechanism as wnba3p/wnbatp, applied to individual scoring.
// sideWonBelow 0.22.
//
// `wnba3p-5559` (docs/MAKER_WNBA_3P5559_PREREG.md) added 2026-08-16 — direct sibling of wnba3p-6064,
// one band below. In-sample sideWon ~0.406 vs ~56.9¢ priced, +16.34¢/ct, CI [+1.25, +31.43], only
// 8/16 positive days (50% — its weakest point, named explicitly in the doc). Netting screen: same
// inverted shape that let wnba3p-6064 survive (sub-50 −6.92, 50+ +7.53, whole +2.18). Same mechanism
// as wnba3p-6064, one tier closer to the mean. sideWonBelow 0.48.
//
// `wnbatp-4044` (docs/MAKER_WNBA_TP4044_PREREG.md) added 2026-08-16 — extends the wnbatp longshot
// mechanism to a less-extreme tier. In-sample sideWon ~0.272 vs ~41.7¢ priced, +14.54¢/ct, CI
// [+1.46, +27.62], 12/15 positive. Netting screen: mirrored book, same shape as the registered
// cluster (sub-50 +15.0, 50+ −13.0, whole +1.66); the sub-50 band sequence decays coherently toward
// zero approaching 50¢ (15-19 +16.83 → … → 40-44 +14.54 → 45-49 +2.15), which is why 45-49 was NOT
// registered (near-pick'em price, no mechanism story — same reasoning that rejected mlb|f5total|45-49
// the same day). Separate registration from the wnbatp cluster/wnbatp-1519 (post-hoc cluster edits
// change the existing all-must-pass verdict). sideWonBelow 0.35.
export const PREREG_CELLS = [
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
  {
    id: "mlbsp-2529", sport: "mlb", category: "spread", band: "25-29",
    doc: "docs/MAKER_MLB_SP_PREREG.md", label: "MLB spread underdog 25-29¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.22, minDays: 8, minFills: 50 },
  },
  {
    id: "mlbsp-3539", sport: "mlb", category: "spread", band: "35-39",
    doc: "docs/MAKER_MLB_SP_PREREG.md", label: "MLB spread underdog 35-39¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.30, minDays: 8, minFills: 50 },
  },
  {
    id: "mlbf5t-2529", sport: "mlb", category: "f5total", band: "25-29",
    doc: "docs/MAKER_MLB_F5T_PREREG.md", label: "MLB F5 total longshot 25-29¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.22, minDays: 8, minFills: 50 },
  },
  {
    id: "wnba3p-6064", sport: "wnba", category: "threePointers", band: "60-64",
    doc: "docs/MAKER_WNBA_3P_PREREG.md", label: "WNBA threePointers moderate-favorite 60-64¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.40, minDays: 8, minFills: 50 },
  },
  {
    id: "wnbatp-1519", sport: "wnba", category: "totalPoints", band: "15-19",
    doc: "docs/MAKER_WNBA_TP1519_PREREG.md", label: "WNBA total points extreme longshot 15-19¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.05, minDays: 8, minFills: 50 },
  },
  {
    id: "mlbf5sp-2529", sport: "mlb", category: "f5spread", band: "25-29",
    doc: "docs/MAKER_MLB_F5SP_PREREG.md", label: "MLB F5 spread underdog 25-29¢",
    forwardStart: "2026-08-10", checkpoint: "2026-08-24",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.22, minDays: 8, minFills: 50 },
  },
  {
    id: "wnbapts-2529", sport: "wnba", category: "points", band: "25-29",
    doc: "docs/MAKER_WNBA_PTS_PREREG.md", label: "WNBA points longshot 25-29¢",
    forwardStart: "2026-08-16", checkpoint: "2026-08-30",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.22, minDays: 8, minFills: 50 },
  },
  {
    id: "wnba3p-5559", sport: "wnba", category: "threePointers", band: "55-59",
    doc: "docs/MAKER_WNBA_3P5559_PREREG.md", label: "WNBA threePointers moderate-favorite 55-59¢",
    forwardStart: "2026-08-16", checkpoint: "2026-08-30",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.48, minDays: 8, minFills: 50 },
  },
  {
    id: "wnbatp-4044", sport: "wnba", category: "totalPoints", band: "40-44",
    doc: "docs/MAKER_WNBA_TP4044_PREREG.md", label: "WNBA total points longshot 40-44¢",
    forwardStart: "2026-08-16", checkpoint: "2026-08-30",
    criteria: { ciLoAbove: 0, meanFloorC: 5, positiveDayFrac: 0.60, sideWonBelow: 0.35, minDays: 8, minFills: 50 },
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
