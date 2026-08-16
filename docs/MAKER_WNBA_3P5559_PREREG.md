# Pre-registration — WNBA threePointers moderate-favorite 55-59¢ (2026-08-16)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-16 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-15; the forward window opens 2026-08-16, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-16 morning `robustCandidates` tripwire surfaced `wnba|threePointers|55-59` among 23
cells clearing the structural bar (`ROBUST_BAR` {minDays:8, minFills:50, maxTopDayShare:0.35}):

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days | topDayShare |
|------|-------|------|-----------|-------|-------|----------|-------------|
| 55–59 | 105 | 16 | +16.34 | +1.25 | +31.43 | 8/16 | 0.35 |

Not anomaly-flagged (`ladderResidual` −0.09, small). This is the direct sibling, one band below,
of the already-registered `wnba3p-6064` (60-64¢) — same category, same mechanism, adjacent tier.
Per doctrine (the `wnbatp-1519` precedent), a related-but-separate band gets its own registration
rather than folding into an existing single-cell registration, which would change what that cell's
own verdict means.

**Netting screen** ([[docs/MAKER_LADDER_ARTIFACT.md]] doctrine): pooling the full
`wnba|threePointers` ladder contracts-weighted at the 50¢ split gives sub-50 **−6.92¢/ct**, 50+
**+7.53¢/ct**, whole book **+2.18¢/ct**. This is the same **inverted** shape that let `wnba3p-6064`
survive the screen originally — the favorite (50+) half wins, the underdog (sub-50) half loses,
opposite of the typical price-ladder artifact direction. 55-59 sits in the winning half of that
inverted book, not merely riding the book's overall price level.

`topDayShare` 0.35 is at the boundary of what the daily heatmap-investigation protocol treats as
still-robust (the "fragile, ignore" threshold is ≥0.5) — worth naming as this cell's weakest point
relative to the other two registered today; it is the least-distributed of the three.

## Hypothesis (stated before the forward data exists)

Selling positions priced **55-59¢** in Kalshi's WNBA three-pointers made prop market
(`KXWNBATHREEPOINTERS` or equivalent) earns positive per-contract PnL because **these markets
systematically overprice the moderate-favorite side of WNBA team 3-point made props** — the same
mechanism already hypothesized for `wnba3p-6064`, one tier closer to the mean.

Mechanism (identical to `wnba3p-6064`'s registered hypothesis): WNBA 3-point made totals are
volatile game-to-game — team-level 3PM rates depend on shot selection, defense, pace, and individual
form. A market anchoring on a team's season-average 3PM rate underestimates this variance,
overpricing thresholds near but above the mean. 55-59¢ is one band closer to fair odds than 60-64¢;
the in-sample gap here (56.9¢ priced vs 40.6% realized, ~16pp) is smaller than 60-64's (~62¢ vs
32.7%, ~29pp), consistent with the mechanism weakening as price approaches 50/50 rather than being
a fresh, unrelated signal.

Directional prediction: the sold (55-59¢) side should win materially **less** than its ~56.9¢ price
implies.

## In-sample evidence (2026-07-22 → 2026-08-15, NOT part of the test)

**Band 55-59** (105 fills, 806.1 contracts, 16 days, avg ask ~56.9¢):
- **+16.34¢/contract**, day-clustered CI **[+1.25, +31.43]** — wide but clears zero.
- **8 of 16 days positive** (50%); topDayShare 0.35.
- **Weighted aggregate sideWon ≈ 0.406** vs ~56.9¢ priced — a ~16pp structural gap.

| day | fills | contracts | ¢/ct | sideWon | avgAsk |
|---|---|---|---|---|---|
| 2026-07-22 | 8 | 70.0 | +28.43 | 0.286 | 56.9 |
| 2026-07-28 | 18 | 120.0 | +7.08 | 0.500 | 57.4 |
| 2026-07-29 | 10 | 80.0 | −6.88 | 0.625 | 55.5 |
| 2026-07-30 | 2 | 10.0 | −44.00 | 1.000 | 56.0 |
| 2026-08-02 | 2 | 11.0 | −33.73 | 0.909 | 58.0 |
| 2026-08-03 | 2 | 16.0 | +58.63 | 0.000 | 58.5 |
| 2026-08-04 | 11 | 72.0 | −1.61 | 0.583 | 56.7 |
| 2026-08-05 | 4 | 24.0 | −1.92 | 0.583 | 56.3 |
| 2026-08-06 | 3 | 30.0 | −10.67 | 0.667 | 56.0 |
| 2026-08-07 | 1 | 10.0 | +56.00 | 0.000 | 56.0 |
| 2026-08-08 | 1 | 1.0 | −41.00 | 1.000 | 59.0 |
| 2026-08-09 | 3 | 20.0 | +59.00 | 0.000 | 59.0 |
| 2026-08-10 | 14 | 111.0 | +56.71 | 0.000 | 56.5 |
| 2026-08-13 | 9 | 80.0 | −5.63 | 0.625 | 56.7 |
| 2026-08-14 | 4 | 40.0 | +58.25 | 0.000 | 58.3 |
| 2026-08-15 | 13 | 111.1 | +12.25 | 0.450 | 57.1 |

Eight of sixteen days are negative — genuinely mixed, not a lopsided win streak. The mean is carried
by a few high-contract positive days (08-10, 08-03, 08-14, 08-09) outweighing several small negative
ones. Worth naming as a risk explicitly: this cell is closer to a coin flip on daily sign than any
other currently registered cell. In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-16`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-30** (~2 weeks; WNBA plays 4-5 games/slate, 3-point props on each, expect
  ~6-8 fills/day, so ≥50 fills reachable in ≥8-10 days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=wnba|threePointers|55-59&since=2026-08-16` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: with only 50% of in-sample days positive, criterion 3 (≥60% positive days) is the one
most likely to bind — the in-sample record itself falls short of it (8/16 = 50%). The forward window
needs a materially better day-to-day hit rate than in-sample showed, not just a similar mean.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-16)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days (consistency — stricter than the in-sample 50% rate).
4. Forward **sideWon < 0.48** (mechanism must persist — the sold ~56.9¢ side keeps winning below
   priced; 0.48 is above in-sample 0.406, leaves headroom for forward variance, stays below the
   ~56.9¢ avg ask).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell at the checkpoint.

ALL six criteria must hold. A partial pass is a KILL.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not move a threshold. A kill here does NOT affect the already-registered `wnba3p-6064`.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-09-13), then decide.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**.

1. **Un-shelve V2** and **re-scope it to this cell only** — `KXWNBATHREEPOINTERS` (or whichever is
   the real 3-point made series), moderate-favorite side in [55,59].
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end ($30 fallback).
3. The real-money trial is **itself the final test**; scale only if it reproduces the edge on real
   fills.

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-16. This cell's weakest point
(50% in-sample positive-day rate, closer to a coin flip than any other currently registered cell)
is recorded here on purpose — it does not lower the bar, it names the risk in advance.
