# Pre-registration — WNBA points longshot 20-24¢ (2026-08-17)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-17 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-16; the forward window opens 2026-08-17, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-17 morning `robustCandidates` tripwire surfaced `wnba|points|20-24` among 28 cells
clearing the structural bar (`ROBUST_BAR` {minDays:8, minFills:50, maxTopDayShare:0.35}):

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days | topDayShare |
|------|-------|------|-----------|-------|-------|----------|-------------|
| 20–24 | 128 | 14 | +8.67 | +0.06 | +17.28 | 9/14 | 0.30 |

Sibling of the already-registered `wnbapts-2529` — same category (individual player points), one
band closer to fair odds. Not anomaly-flagged (`ladderResidual` −0.04, small).

**Netting screen** ([[docs/MAKER_LADDER_ARTIFACT.md]] doctrine, run before registering any
robustCandidates hit): pooling the full `wnba|points` ladder contracts-weighted at the 50¢ split
gives sub-50 **+2.93¢/ct**, 50+ **+3.14¢/ct**, whole book **+3.05¢/ct** — both halves positive
(the same shape that cleared `wnbapts-2529`), so this is NOT the mirrored price-ladder artifact.
The 20-24 band's premium is not a restatement of the book's price level.

Registered as a second cell in this category, alongside `wnbapts-2529` (25-29¢) — not folded into
a cluster, since the two were registered on different dates with different windows; each gets its
own independent checkpoint verdict.

## Hypothesis (stated before the forward data exists)

Selling positions priced **20-24¢** in Kalshi's WNBA individual player points market earns
positive per-contract PnL because these markets systematically overprice the longshot side of
individual player scoring thresholds — the same mechanism already registered for `wnbapts-2529`,
one band closer to fair odds.

Mechanism (identical to `wnbapts-2529`): a market anchoring a player-prop threshold on a coarser
statistic (season-average points per game) without adequately widening for game-to-game variance.
For an individual player, that variance is driven by opponent defensive matchup, pace, foul
trouble, and blowout-shortened minutes — all of which push the realized distribution wider than a
season-average anchor implies.

Directional prediction: the sold (20-24¢) side should win materially **less** than its ~22.3¢ price
implies. In-sample the weighted sideWon was ~0.136 vs ~22.3¢ priced — an apparent ~9pp overpricing,
similar in magnitude to `wnbapts-2529`'s ~9pp gap.

## In-sample evidence (2026-07-29 → 2026-08-16, NOT part of the test)

**Band 20-24** (128 fills, 719.4 contracts, 14 days, avg ask ~22.3¢):
- **+8.67¢/contract**, day-clustered CI **[+0.06, +17.28]** — barely clears zero (thinner CI-lo
  than `wnbapts-2529`'s +1.37, honestly disclosed).
- **9 of 14 days positive**; topDayShare 0.30.
- **Weighted aggregate sideWon ≈ 0.136** vs ~22.3¢ priced.

| day | fills | contracts | ¢/ct | sideWon | avgAsk |
|---|---|---|---|---|---|
| 2026-07-29 | 5 | 36.4 | +21.68 | 0.000 | 22.2 |
| 2026-07-30 | 6 | 36.0 | −5.11 | 0.278 | 22.0 |
| 2026-08-02 | 5 | 40.0 | +23.00 | 0.000 | 23.0 |
| 2026-08-03 | 6 | 60.0 | +5.50 | 0.167 | 22.2 |
| 2026-08-04 | 12 | 70.0 | −7.14 | 0.286 | 21.7 |
| 2026-08-06 | 7 | 40.0 | +22.75 | 0.000 | 22.7 |
| 2026-08-08 | 4 | 10.0 | −78.00 | 1.000 | 22.0 |
| 2026-08-09 | 13 | 83.1 | +10.65 | 0.120 | 22.9 |
| 2026-08-10 | 4 | 20.0 | +22.00 | 0.000 | 23.0 |
| 2026-08-11 | 1 | 0.6 | +22.00 | 0.000 | 22.0 |
| 2026-08-13 | 13 | 45.0 | −6.81 | 0.287 | 21.5 |
| 2026-08-14 | 16 | 79.7 | −5.92 | 0.278 | 21.8 |
| 2026-08-15 | 16 | 58.6 | +16.80 | 0.044 | 21.2 |
| 2026-08-16 | 20 | 140.0 | +22.93 | 0.000 | 23.1 |

One severe day (08-08): 4 fills, 10 contracts, sideWon=1.0, −78¢/ct — the smallest-volume day in
the set (10 contracts, the minimum in the window) driving a large per-contract swing on a tiny
base, the same tail-risk shape named in every other registered longshot cell. Five days ran cool
(07-30, 08-04, 08-13, 08-14 at 0.278-0.287) which is materially above the ~0.223 avgAsk-implied
level but still not a coordinated inversion — no single day drives the aggregate the way 08-08's
tiny sample might suggest. In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-17`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-31** (~2 weeks; WNBA plays 4-5 games/slate, expect ~9 fills/day at this
  band, so ≥50 fills reachable in ≥6 days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=wnba|points|20-24&since=2026-08-17` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: the in-sample CI-lo (+0.06) is the thinnest of any cell registered to date — this is
disclosed, not softened. A modest forward deterioration immediately fails criterion 1, which is
the correct outcome if the in-sample effect is smaller than it appears or an artifact of the four
cool days named above.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-17)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days.
4. Forward **sideWon < 0.20** (in-sample 0.136; headroom for variance, stays below the ~22.3¢
   avg ask).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell at the checkpoint.

ALL six criteria must hold. A partial pass is a KILL.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not move a threshold. A kill here does NOT affect `wnbapts-2529`.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-09-14), then decide.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**.

1. **Un-shelve V2** and **re-scope it to this cell only** — WNBA individual player points market,
   longshot side in [20,24].
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end ($30 fallback).
3. The real-money trial is **itself the final test**; scale only if it reproduces the edge on real
   fills.

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-17. Moving any threshold post-hoc,
or combining this verdict with `wnbapts-2529`'s, voids the pre-registration.
