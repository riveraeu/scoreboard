# Pre-registration — WNBA points longshot 25-29¢ (2026-08-16)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-16 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-15; the forward window opens 2026-08-16, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-16 morning `robustCandidates` tripwire surfaced `wnba|points|25-29` among 23 cells
clearing the structural bar (`ROBUST_BAR` {minDays:8, minFills:50, maxTopDayShare:0.35}):

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days | topDayShare |
|------|-------|------|-----------|-------|-------|----------|-------------|
| 25–29 | 111 | 13 | +9.28 | +1.37 | +17.19 | 11/13 | 0.13 |

This is a new category (individual player points, distinct from the already-registered team
`totalPoints`/`spread` families) — first time the tripwire has fired for WNBA player points. Not
anomaly-flagged (`ladderResidual` −0.07, small). `topDayShare` 0.13 is the lowest of any band in
this entire category, so the signal is not one hot slate.

**Netting screen** ([[docs/MAKER_LADDER_ARTIFACT.md]] doctrine, run before registering any
robustCandidates hit): pooling the full `wnba|points` ladder contracts-weighted at the 50¢ split
gives sub-50 **+1.81¢/ct**, 50+ **+3.81¢/ct**, whole book **+2.97¢/ct** — both halves positive, so
this is NOT the mirrored price-ladder artifact (which would show one half positive, the other
negative, netting near zero). The 25-29 band's premium is not a restatement of the book's price
level.

Registered as a single cell — first cell in this category, no cluster to extend.

## Hypothesis (stated before the forward data exists)

Selling positions priced **25-29¢** in Kalshi's WNBA individual player points market
(`KXWNBAPTS` or equivalent) earns positive per-contract PnL because **these markets systematically
overprice the longshot side of individual player scoring thresholds**. The fill (whichever of YES
or NO falls in 25-29¢) is priced at ~26.4¢ but realizes below that rate.

Mechanism: same class as the already-registered `wnba3p-6064`/`wnbatp` families — a market anchoring
a player-prop threshold on a coarser statistic (season-average points per game) without adequately
widening for game-to-game variance. For an individual player, that variance is driven by opponent
defensive matchup, pace, foul trouble, and blowout-shortened minutes — all of which push the
realized distribution wider than a season-average anchor implies, so the market misprices a tail
threshold like 25-29¢ more than the middle of the distribution.

Directional prediction: the sold (25-29¢) side should win materially **less** than its ~26.4¢ price
implies. In-sample the weighted sideWon was ~0.172 vs ~26.4¢ priced — an apparent ~9pp overpricing.

## In-sample evidence (2026-07-29 → 2026-08-15, NOT part of the test)

**Band 25-29** (111 fills, 598.9 contracts, 13 days, avg ask ~26.4¢):
- **+9.28¢/contract**, day-clustered CI **[+1.37, +17.19]** — clears zero.
- **11 of 13 days positive**; topDayShare 0.13 (well distributed, not one-slate driven).
- **Weighted aggregate sideWon ≈ 0.172** vs ~26.4¢ priced.

| day | fills | contracts | ¢/ct | sideWon | avgAsk |
|---|---|---|---|---|---|
| 2026-07-29 | 5 | 30.0 | +26.00 | 0.000 | 26.2 |
| 2026-07-30 | 22 | 112.3 | −1.03 | 0.276 | 26.1 |
| 2026-08-02 | 14 | 80.1 | +1.91 | 0.250 | 27.1 |
| 2026-08-03 | 15 | 91.5 | −7.58 | 0.334 | 25.6 |
| 2026-08-04 | 5 | 20.0 | +27.00 | 0.000 | 26.4 |
| 2026-08-06 | 5 | 21.0 | +26.43 | 0.000 | 25.6 |
| 2026-08-08 | 1 | 10.0 | +28.00 | 0.000 | 28.0 |
| 2026-08-09 | 7 | 31.0 | +24.10 | 0.032 | 27.6 |
| 2026-08-10 | 12 | 65.2 | +13.94 | 0.121 | 26.3 |
| 2026-08-11 | 3 | 20.0 | +25.50 | 0.000 | 25.7 |
| 2026-08-13 | 7 | 34.0 | +26.59 | 0.000 | 27.1 |
| 2026-08-14 | 13 | 72.8 | +11.22 | 0.156 | 26.5 |
| 2026-08-15 | 2 | 11.0 | +16.00 | 0.091 | 25.5 |

Two bad days (07-30, 08-03) are the only negatives, both mid-sized (22 and 15 fills), not
outlier-driven by a single position. In-sample only. Not evidence to bet on. The forward test is
the binding evaluation.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-16`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-30** (~2 weeks; WNBA plays 4-5 games/slate, expect ~7-10 fills/day at this
  band, so ≥50 fills reachable in ≥8-10 days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=wnba|points|25-29&since=2026-08-16` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: the in-sample effect (+9.28¢) is moderate, not extreme. 8-10 forward days at ~9
fills/day gives 70-90 fills — enough to resolve an effect of this magnitude, but not enough margin
to survive a bad slate or two without the CI recrossing zero.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-16)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted, the same interval the report computes).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days (consistency).
4. Forward **sideWon < 0.22** (mechanism must persist — the sold ~26.4¢ side keeps winning below
   priced; 0.22 is above in-sample 0.172, leaves headroom for forward variance, stays materially
   below the ~26.4¢ avg ask).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell at the checkpoint.

ALL six criteria must hold. A partial pass is a KILL.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not move a threshold, do not give it another window. A failed forward test is the answer.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-09-13), then decide.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**. It does NOT mean bet full size on day one.

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to this
   cell only** — `KXWNBAPTS` (or whichever is the real points-prop series), longshot side in
   [25,29]. A deliberate code change, authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end (start near the $30
   fallback), not the $500 cap.
3. The real-money trial is **itself the final test**: it measures real fill rate + adverse selection
   over its own window. Scale toward the cap **only** if the trial reproduces the edge on real fills.

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-16. This cell got here by clearing
both the structural robustness bar AND the netting screen — the forward test is the only thing
standing between "looks green" and "is real," so the rule that evaluates it must not be adjustable
after the fact.
