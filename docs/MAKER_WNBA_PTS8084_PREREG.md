# Pre-registration — WNBA points moderate-favorite 80-84¢ (2026-08-25)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-25 and cannot be changed after seeing the forward result. The in-sample window runs
through 2026-08-24; the forward window opens 2026-08-25, so this file predates every day it is
tested on.

## Why this cell, and why it needs extra scrutiny before a verdict

Surfaced while digging into the 2026-08-25 morning `robustCandidates` list at the user's request —
`wnba|points|80-84` clears the structural bar (`ROBUST_BAR` {minDays:8, minFills:50,
maxTopDayShare:0.35}):

| Band | Fills | Contracts | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days | topDayShare |
|------|-------|-----------|------|-----------|-------|-------|----------|-------------|
| 80-84 | 153 | 1,009.6 | 16 | +10.66 | +0.52 | +20.80 | 8/16 | 0.23 |

This is a **favorite-side band** (avg ask ~82¢, backed out from the seller identity
`perContract = avgAsk − 100·sideWon`), not a longshot band — every other `wnba|points` cell
registered so far (`wnbapts-2024`, `wnbapts-2529`) is sub-30¢. That distinction matters: `80-84`
was the exact price range of the **original, broadly-scoped V2 hypothesis this project already
shelved** (2026-07-21 → 2026-07-28, six dissolutions, no demonstrated fillable edge — see
`api/CLAUDE.md`'s `maker-live.js` history and `docs/MAKER_LEADTIME_PREREG.md`). That hypothesis
pooled EVERY sport/category at 80-84¢ with no per-category mechanism; this registration is
deliberately narrower — one specific category, with its own stated mechanism (below) — which is
exactly the kind of specificity the broad hypothesis never had and the netting-screen doctrine
demands ("the mechanism must explain why *this band*, not the price level").

**Netting screen** (`docs/MAKER_LADDER_ARTIFACT.md`, run before registering any `robustCandidates`
hit): pooling the full `wnba|points` ladder contracts-weighted at the 50¢ split gives sub-50
**+0.64¢/ct** (9,660 ct), 50+ **+4.82¢/ct** (11,668 ct), whole book **+2.93¢/ct** (21,328 ct) —
both halves positive, the same shape that already cleared `wnbapts-2024`/`wnbapts-2529`. Not the
mirrored price-ladder artifact. Not anomaly-flagged (`ladderResidual` −0.12, small).

**Day-level check (the scrutiny this band's history earns it)**: per-day results were pulled via
`?makerDay=` across the full window rather than trusting the pooled figure alone —

| day | fills | contracts | ¢/ct | sideWon | avgAsk |
|---|---|---|---|---|---|
| 2026-07-28 | 14 | 114.0 | +11.33 | 0.7105 | 82.4 |
| 2026-07-29 | 11 | 77.0 | +55.47 | 0.2727 | 82.7 |
| 2026-07-30 | 26 | 94.0 | −6.78 | 0.8936 | 82.6 |
| 2026-08-02 | 12 | 100.0 | +22.20 | 0.6000 | 82.2 |
| 2026-08-03 | 3 | 20.0 | −17.50 | 1.0000 | 82.5 |
| 2026-08-04 | 9 | 80.0 | +5.88 | 0.7500 | 80.9 |
| 2026-08-06 | 7 | 37.1 | −18.02 | 1.0000 | 82.0 |
| 2026-08-09 | 1 | 10.0 | −20.00 | 1.0000 | 80.0 |
| 2026-08-10 | 1 | 4.0 | −16.00 | 1.0000 | 84.0 |
| 2026-08-13 | 19 | 110.5 | +17.81 | 0.6337 | 81.2 |
| 2026-08-14 | 2 | 15.0 | −16.67 | 1.0000 | 83.3 |
| 2026-08-15 | 11 | 102.0 | +10.90 | 0.7059 | 81.5 |
| 2026-08-16 | 13 | 76.0 | −16.96 | 0.9868 | 81.7 |
| 2026-08-17 | 14 | 70.0 | +25.43 | 0.5714 | 82.6 |
| 2026-08-20 | 3 | 30.0 | −19.00 | 1.0000 | 81.0 |
| 2026-08-24 | 7 | 70.0 | +24.00 | 0.5714 | 81.1 |

Exactly **8 positive / 8 negative days — a 50% split**, already below the ≥60%-positive-days GREEN
bar this cell will be held to forward. Disclosed, not softened: the pooled positive mean survives
only because positive days carry more volume (723.5 ct) than negative days (286.1 ct), not because
positive days are more frequent. That asymmetry is real (checked): dropping the single
largest-contract day (07-28, 114 ct) moves the pooled figure only +10.66 → +10.58¢/ct, and
dropping the top two (07-28 + 08-13) only to +9.56¢/ct — this is **not** a one-day artifact the way
the original 7/21 "edge lives only in 80-84" reading was (that one inverted once the founding bug
was fixed). Still, an exactly-50%-positive in-sample day count is a real weakness, not a rounding
error, and is why this cell gets a forward test rather than a verdict.

## Hypothesis (stated before the forward data exists)

Selling positions priced **80-84¢** in Kalshi's WNBA individual player points market earns
positive per-contract PnL — i.e. the sold side wins **less** than its ~82¢ price implies (in-sample
weighted sideWon ≈ 0.7123 vs ~82¢ priced, an apparent ~10pp overpricing).

**Mechanism (deliberately NOT the shelved cross-category "sell the 80-84 favorite" hypothesis)**:
a WNBA player-points threshold near a player's likely output still has asymmetric downside risk the
threshold-setting doesn't price — foul trouble, blowout-shortened fourth quarters, and coach's-
decision rest in a decided game all truncate a player's counting stats on the SAME side (under),
regardless of how comfortably they were tracking to clear the line. A player "on pace" to clear 80-
84% of the time by pure scoring-rate projection still loses some of that probability mass to
playing-time risk the projection doesn't model — pushing realized frequency below the nominal
price specifically for moderate-favorite (not extreme-favorite, where there's more cushion) player
props. This is a claim about *this market* (individual playing-time truncation), not a generic
"high-priced things are overpriced" claim, which is why it does not reduce to the broadly-pooled
hypothesis that already failed.

Directional prediction: the sold (80-84¢) side should win materially **less** than its ~82¢ price
implies, continuing the in-sample ~10pp gap.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-25`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-09-08** (~2 weeks; WNBA plays 4-5 games/slate, expect ~9-10 fills/day at this
  band per the in-sample rate, so ≥50 fills reachable in ≥6 slate days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=wnba|points|80-84&since=2026-08-25` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: in-sample day-positivity is exactly 50%, below the 60% GREEN bar — this cell needs the
forward window to genuinely improve on in-sample, not just replicate it, which is a real and
disclosed handicap relative to every other cell registered so far.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-25)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days.
4. Forward **sideWon < 0.76** (in-sample 0.7123; headroom for variance, stays below the ~82¢ avg
   ask).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell at the checkpoint.

ALL six criteria must hold. A partial pass is a KILL.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not move a threshold.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-09-22), then decide. (Per `feedback_prereg_checkpoint_
  hard_deadline` this clause has never actually been invoked in this repo's history — every prior
  sample-floor miss at checkpoint collapsed to KILL per the running system, `api/lib/maker-
  prereg.js:259-262`. Recorded per the doc template; do not expect it to fire differently here.)

## What GREEN triggers

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell specifically. Unlike the
cells registered while V2 was shelved, **V2 is currently ARMED** (the sub-50 one-sided live trial,
`docs/MAKER_V2_SUBFIFTY_TRIAL.md`) — so a GREEN here does not require un-shelving anything. It does
require a deliberate scoping decision at that time: this is a favorite-side band on a mechanism
distinct from the trial's current sub-50/longshot cells, so it should get **its own new group** in
`MAKER_V2_LIVE_CELLS` (own `capCents`/`stopLossCents`/`resumeFrom`), not be folded into the existing
`wnba-points` group whose risk budget is sized and reasoned about for the longshot mechanism alone.
Sizing follows the standing bankroll doctrine (⅛-Kelly at the low end, $30 fallback) — the real-
money trial is itself the final test; scale only if it reproduces the edge on real fills.

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-25. Moving any threshold post-hoc
voids the pre-registration.
