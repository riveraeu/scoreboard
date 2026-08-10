# Pre-registration — MLB F5 spread underdog 25-29¢ (2026-08-10)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-10 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-09; the forward window opens 2026-08-10, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-10 morning `robustCandidates` tripwire surfaced `mlb|f5spread|25-29` among 19 cells
clearing the structural bar. This is the F5 **spread** (run line) underdog, the companion to the
already-registered `mlbf5t-2529` (F5 **total**). The prior note on mlbf5t-2529 said "Companion
f5spread NOT registered (CI-lo +1.16¢, two consecutive bad days 8/5-8/6)" — as of today the
dataset has grown (72 fills / 10 days) and ciLo has improved to +2.88¢, crossing the structural bar.

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days |
|------|-------|------|-----------|-------|-------|----------|
| 25–29 | 72 | 10 | +12.30 | +2.88 | +21.71 | 8/10 |

The CI is wide (18.83¢) reflecting genuine volatility: two consecutive bad days (8/05-8/06)
with sideWon 0.409 and 0.588. The ciLo (+2.88¢) barely clears the bar; this is the weakest
of the three new registrations today, and the forward test is the appropriate response.

## Hypothesis (stated before the forward data exists)

Selling positions priced **25-29¢** in Kalshi's MLB F5 spread market earns positive per-contract
PnL because **the F5 run-line underdog is overpriced for the same ML-anchor reason as the full-game
spread** (mlbsp-2529/3539). Market makers price F5 spreads anchored off the F5 money-line without
fully adjusting for the additional hurdle of covering the run line — the same mechanism cross-applied
to the first 5 innings.

A team priced as a 25-29¢ underdog on the run line has been implicitly assigned ~27% chance of
winning by 2+ runs (for a -1.5 spread) or losing by fewer than 1.5 (for a +1.5 spread). If the
ML-anchor mechanism misprices the spread cover probability at the F5 horizon (fewer innings =
higher variance = harder to cover), the actual cover rate should be materially below 27%.

Mechanism is the same as mlbsp-2529/3539 (cross-sport MLB spread underdog overpricing), now
applied to the F5 half-game slice. The F5 framing may amplify the effect: starter vs reliever
transitions create additional uncertainty not captured in a simple ML-anchor calculation.

Directional prediction: forward sideWon should remain below the sideWonBelow bar. The mechanism
predicts structural underperformance of the sold 25-29¢ side.

## In-sample evidence (through 2026-08-09, NOT part of the test)

**Band 25-29** (72 fills, 515 contracts, 10 days, avg ask ~27¢):
- **+12.30¢/contract**, day-clustered CI **[+2.88, +21.71]** — wide; 8/10 days positive.
- topDayShare 0.20 (not dominated by one slate).
- Per-day sideWon: 0.000, 0.143, 0.000, 0.094, 0.227, 0.000, 0.409, 0.588, 0.000, 0.000.
- **Weighted aggregate sideWon ≈ 0.150** vs ~27¢ priced.
- Shared bad days: 8/05 (sideWon 0.409, −13.22¢/ct) and 8/06 (sideWon 0.588, −31.47¢/ct) —
  consecutive, the same pair flagged when this cell was excluded from the 8/09 registration.

In-sample only. The consecutive bad days are a structural risk: if 8/05-8/06 represent a
recurring pattern (certain game contexts systematically break the anchor mechanism), the forward
test will catch it. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-10`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-24** (~2 weeks; MLB schedules 15 games/day, F5 spread fills ~7-10/day;
  ≥50 fills reachable in ≥8 days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=mlb|f5spread|25-29&since=2026-08-10` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: the in-sample ciLo (+2.88¢) is thin. The forward test has power to confirm an effect
of +10-12¢ (observed mean) but not to confirm a smaller effect of +2-3¢ in two weeks. That is
by design: if the real edge is only 2¢, criterion 2 (+5¢ floor) kills it, and an edge too small
to confirm in two weeks is too small to justify real capital.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-10)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days (consistency).
4. Forward **sideWon < 0.22** (mechanism must persist; 0.22 is above in-sample 0.150, leaves
   headroom for forward variance, stays well below the ~27¢ avg ask; matches mlbsp-2529).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell.

ALL six criteria must hold. A partial pass is a KILL.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL**. Cell is not re-sliced.
- The consecutive-bad-days risk (8/05-8/06) is the primary monitoring concern: if two or more
  consecutive forward days both show sideWon > 0.40, that is a leading KILL indicator even
  before the checkpoint.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass →
  **extend once** to 2026-09-07. Sample-thinness is the one reason to wait.
- A kill here does NOT affect `mlbf5t-2529` (F5 total) or the `mlbsp-2529/3539` cluster.

## What GREEN triggers

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell and flips
`AWAITING_VALIDATED_EDGE` for this cell only. GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to
   this cell** — F5 spread market, underdog side in [25,29].
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end ($30 fallback).
3. The real-money trial is **itself the final test**.

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-10. Moving any threshold
post-hoc voids the pre-registration.
