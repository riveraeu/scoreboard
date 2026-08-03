# Pre-registration — mlb f5total 50-54¢ maker cell (2026-07-29)

> **OUTCOME — KILLED EARLY 2026-08-03 (day 3 of 8, before the 2026-08-13 checkpoint).**
> A discretionary stop-risk kill, not a checkpoint verdict. The forward window never reached the
> criterion-5 sample floor (3 days / 113 fills), but every *mechanism* and PnL criterion was failing
> and moving the wrong way: forward mean **−4.8¢/ct** (bar +5), **sideWon 0.565** vs the < 0.45 bar
> (the sold favorite was *winning* more than its price implied — the hypothesis inverted), day-
> clustered CI-lo **−14.7** (bar > 0), 1 of 3 days positive. Per the KILL rule below, a failed
> forward test is the answer — the cell is **not** re-sliced, widened, or extended. Removed from
> `PREREG_CELLS` the same day. The criteria below are left unchanged as the historical record; a
> future test on this cell would be a NEW id + a NEW doc, never an edit here.

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-07-29 and cannot be changed after seeing the forward result. Moving any threshold post-hoc
voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The category × band heatmap surfaced `mlb f5total 50-54` as the **only positive cell that cleared
the day-clustered reliability bar** — the other five reliable cells all lose. Its in-sample shape
is unusually clean (see below). But the whole point of this session's work is that a big-looking
cell picked from a grid is best-of-N selection: we scanned **280 cells**, and at 95% intervals
~**14** clear zero by chance even if every true edge is zero. One positive cell among 280 is
exactly what noise produces. The reliability bar is **not** multiplicity-corrected.

So the in-sample number cannot be acted on. What CAN resolve it is a **forward test on days that do
not yet exist** — the out-of-sample confirmation `docs/REENTRY.md` names as one of the only two
things that justify re-opening (a mechanism stated in advance, then tested). This file is that
mechanism and that bar, stated in advance.

## Hypothesis (stated before the forward data exists)

Selling the **favorite side** of MLB first-5-inning totals (`KXMLBF5TOTAL`) when the favorite ask
is in the near-coinflip zone **50-54¢** earns positive per-contract PnL, because the market
**overprices the barely-favorite side** of first-5 totals. Directional, mechanistic prediction:
the sold (favorite) side should win materially **less** than its ~52% price implies.

## In-sample evidence (2026-07-19 → 2026-07-28, NOT part of the test)

- +16.0¢/contract, 66 fills, 529 contracts, **8 days**.
- **sideWon 0.38** vs ~0.52 price-implied — the mechanism, present in-sample.
- Day-clustered CI (t-adjusted) **[+2.24, +29.76]** — clears zero.
- **6 of 8 days positive**; top-day share 0.29 (not one-slate). No anomaly flag.
- Every fill at ask 54 (a 55¢ book favorite quoted 1¢ inside) — the low edge of the favorite band,
  not the new underdog region.

Clean shape. Still 1-of-280. In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-07-30`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-13** (~2 weeks / ~14 MLB days).
- Evaluate with exactly:
  `GET /api/shadow-report?makerCell=mlb|f5total|50-54&since=2026-07-30` (ADMIN) → read
  `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and the per-day `sideWon`.

Power note (stated up front, not an escape hatch): ~14 forward days ≈ ~110 fills resolves an effect
of the in-sample size (+16) decisively. A genuinely marginal effect (say +5) would be borderline at
this n — which is **why criterion 2 sets a +5 floor**: an edge too small to confirm in two weeks is
also too small to be worth real money once variance drag and adverse selection are paid.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-07-29)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted, the same interval the report computes).
2. Forward mean **≥ +5¢/contract** (a floor, not just "positive" — must clear variance drag + fees +
   expected adverse selection to be worth capital).
3. **Positive on ≥ 60%** of forward days (consistency — not one slate carrying it).
4. Forward **sideWon < 0.45** (the *mechanism* must persist — the favorite side keeps
   underperforming its price, not just PnL landing positive by luck of magnitude).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not move a threshold, do not "give it another two weeks to recover." A failed forward
  test is the answer.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-08-27), then decide. Sample-thinness is the one
  reason to wait; a criterion failure never is.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell, and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**. It does NOT mean bet full size on day one,
because the shadow's 66 fills are **counterfactual** — `replayFills` assumes we win the queue and
cannot measure the one thing that decides a real maker's fate: whether a resting 54¢ f5total order
actually fills at the shadow rate, and whether the flow that hits it is informed (adverse
selection). That is measurable only with real capital. So GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to this
   cell only** — `KXMLBF5TOTAL`, favorite side, fill_ask ∈ [50,54] — not the current
   `MAKER_V2_BAND [80,84]`. This is a deliberate code change, authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end (start near the $30
   fallback, a few contracts per order), not the $500 cap.
3. The real-money trial is **itself the final test**: it measures real fill rate + adverse selection
   over its own window. Scale toward the cap **only** if the trial reproduces the edge on real fills
   (compare V2 realized ¢/ct against the shadow forward ¢/ct via `?makerQueueCheck=1`-style
   attribution). If real fills underperform the shadow — the standing risk with a resting maker —
   the trial kills it before size scales.

In one line: **green light = start real money, scoped to this cell and sized small; the trial is the
last confirmation, not a formality.**

## Immutability

Criteria, window, and green-light action are fixed as of 2026-07-29. This cell got here by being the
max of 280 noisy estimates; the forward test is the only thing standing between "looks green" and
"is real," so the rule that evaluates it must not be adjustable after the fact.
