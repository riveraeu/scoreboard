# Pre-registration — mlb totalRuns 15-19¢ maker cell (2026-08-10)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-10 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-09; the forward window opens 2026-08-10, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-09 morning `robustCandidates` tripwire surfaced `mlb totalRuns 15-19` as one of the
cells on the category × band heatmap to clear the strict structural bar (`ROBUST_BAR` {minDays:8,
minFills:50, maxTopDayShare:0.35}) — `reliable` (day-clustered CI already excludes zero, positive
side), 333 fills over 11 days, top-day share 0.25. Expected output of that tripwire is NONE; a hit
is exactly what a grid of ~555 noisy cells produces at a one-sided 95% bar (~1/40 clear zero with
zero true edge). The bar is **not** multiplicity-corrected.

The cell also passes an additional check that the other candidates on the 8/09 board did not: the
mechanism is articulable from first principles without knowing the in-sample result, and the
in-sample sideWon (7.7%) is so far below the avg ask (~17¢) that it represents a structural
overpricing pattern, not within-noise variation.

So the in-sample number cannot be acted on — that is the in-sample target-picker the REENTRY doctrine
has gone 0-for-6 on. What CAN resolve it is a **forward test on days that do not yet exist**, with a
mechanism and a decision rule fixed in advance. This file is that mechanism and that bar.

## Hypothesis (stated before the forward data exists)

Selling positions priced **15-19¢** in the Kalshi MLB game total runs market (`KXMLBTOTAL`) earns
positive per-contract PnL because **Kalshi's total runs markets overprice extreme-tail outcomes on
both sides of the run distribution.**

Specifically, the cell captures two symmetric configurations:

1. **NO side at low thresholds** (selling "under 5-6 total runs" at ~17¢): The "low-scoring game"
   outcome is overpriced — in the normal 7-14 run range the NO fill wins.
2. **YES side at high thresholds** (selling "over 11-14 total runs" at ~17-18¢): The "high-scoring
   game" outcome is overpriced — in the normal 7-14 run range the YES fill wins.

Both sides land in the 15-19¢ band simultaneously. When the actual game total falls in the normal
7-10 run range, BOTH fills on that game win — the same game contributes fills at both tails. This
is **not** arbitrary band-chasing; it is the same effect (extreme tail overpricing) captured twice
per game from opposite directions.

Directional prediction: the sold (tail) side should win materially **less** than its ~17¢ price
implies. The mechanism requires sideWon well below 0.17 (the avg price) on a per-contract basis.

## In-sample evidence (2026-07-10 → 2026-08-09, NOT part of the test)

- **+9.37¢/contract**, 333 fills, 2300.6 contracts, **11 days**.
- Day-clustered CI (t-adjusted) **[+5.03, +13.72]** — clears zero with meaningful margin.
- **9 of 11 days positive**; top-day share 0.25 (not one-slate dominated).
- Weighted **sideWon ≈ 0.077** vs the ~17¢ price implied — the mechanism, present in-sample
  (sold tail wins ~7.7%, 9.3 points below price; the distribution of per-day sideWon spans 0–0.23).
- Reliable, no anomaly flag. The two losing days (sideWon 0.222 and 0.23) were days when the actual
  game totals hit the tails; the nine winning days spread across the full calendar.
- Two worst individual tickers (from per-ticker analysis): low-threshold NO fills on games that
  scored ≤5 runs (e.g., TOR@HOU, LAA@BAL) — each one a ~82¢/ct loss at 40-30 contracts, the tail
  risk that is also the mechanism's boundary condition.

Clean shape by the structural bar. Still 1-of-~555, the in-sample target-picker risk applies. In-
sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-10`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-23** (~2 weeks / ~14 MLB slates; total runs markets appear on most days).
- Evaluate with exactly:
  `GET /api/shadow-report?makerCell=mlb|totalRuns|15-19&since=2026-08-10` (ADMIN) → read
  `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and the per-day `sideWon`.

Power note (stated up front, not an escape hatch): 14 forward days at this cell's fill rate (~30
fills/day) resolves a real effect of the in-sample size (+9¢) at high power. A smaller true effect
(say +5¢) is borderline at this n — **which is why criterion 2 sets a +5¢ floor**: an edge too
small to confirm in two weeks is also too small to be worth real money once variance drag, adverse
selection, and the asymmetric tail risk are accounted for.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-10)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted, the same interval the report computes).
2. Forward mean **≥ +5¢/contract** (a floor — must clear variance drag + fees + tail risk premium +
   expected adverse selection; "positive CI" is necessary but not sufficient for real capital).
3. **Positive on ≥ 60%** of forward days (consistency — not one outsized slate carrying the result).
4. Forward **sideWon < 0.13** (the *mechanism* must persist — the sold ~17¢ tail keeps
   underperforming its price by a material margin, not just PnL landing positive by luck). Set at
   0.13 rather than 0.10 to leave variance headroom (in-sample 0.077 ± normal forward noise); set
   well below 0.17 (the avg ask) to require the overpricing to be demonstrably present.
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell. (Criteria 1-5 are the five checks `evaluatePrereg` enforces;
   `robustCandidates` already excludes anomaly-flagged cells by construction — this is a re-check at
   the checkpoint, not an independent gate.)

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not restrict to one configuration (NO-only or YES-only), do not move a threshold, do not
  "give it two more weeks." A failed forward test is the answer.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-09-06), then decide. Sample-thinness is the one reason
  to wait; a criterion failure never is.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell, and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**. It does NOT mean bet full size immediately:
the shadow fills are counterfactual (no adverse selection, no real queue position). GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to this
   cell only** — `KXMLBTOTAL`, tail sides (YES at high thresholds, NO at low thresholds), fill_ask
   ∈ [15,19]. A deliberate code change, authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end (start near the $30
   fallback, a few contracts per order), not the $500 cap. The tail risk (a single low-scoring game
   loses ~82¢/ct on the NO side) makes small sizing especially important at first.
3. The real-money trial is **itself the final test**: it measures real fill rate + adverse selection
   + actual tail outcomes over its own window. Scale toward the cap **only** if the trial reproduces
   the edge on real fills. If real fills underperform the shadow, the trial ends before size scales.

In one line: **green light = start real money, scoped to this cell and sized small; the trial is the
last confirmation, not a formality.**

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-10. This cell got here by being the
one cell of ~555 with a clean structural bar AND an articulable first-principles mechanism; the
forward test is the only thing standing between "looks green" and "is real," so the rule that
evaluates it must not be adjustable after the fact.

## Checkpoint result (2026-08-23) — KILL

Forward window `2026-08-10` → checkpoint `2026-08-23`, 8 days / 390 fills / 2259.8 contracts.

| # | Criterion | Bar | Actual | Met? |
|---|---|---|---|---|
| 1 | CI-lo > 0 | > 0 | +0.41 | ✅ |
| 2 | Mean ≥ +5¢/ct | ≥ 5.00 | +4.59 | ❌ |
| 3 | ≥ 60% days positive | ≥ 0.60 | 0.75 (6/8) | ✅ |
| 4 | sideWon < 0.13 | < 0.13 | 0.1248 | ✅ |
| 5 | Sample floor | ≥8d & ≥50 fills | 8d/390 | ✅ |

Criterion 2 (mean ≥ +5¢/ct) fails — sample floor is already cleared, so this is not an
extend-eligible case (rule reserves EXTEND for criterion 5 alone). Per the KILL rule: any of
1-4/6 failing → KILL, no re-slice, no band widening, no side restriction.

**Verdict: KILL.** Forward mean landed at +4.59¢/ct, just under the +5¢ floor that was set to
absorb variance drag + fees + tail risk premium + adverse selection. The other four criteria
passed — the direction and mechanism (sideWon 0.1248, close to in-sample 0.077) held up — but the
per-contract edge itself was too thin to clear the bar this window sets deliberately above
"merely positive." Re-entry for this cell requires new data, not a re-slice of this window.
