# Pre-registration — WNBA totalPoints longshot 35-39¢ (2026-08-17)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-17 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-16; the forward window opens 2026-08-17, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-17 morning `robustCandidates` tripwire surfaced `wnba|totalPoints|35-39` among 28 cells
clearing the structural bar (`ROBUST_BAR` {minDays:8, minFills:50, maxTopDayShare:0.35}):

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days | topDayShare |
|------|-------|------|-----------|-------|-------|----------|-------------|
| 35–39 | 174 | 16 | +12.40 | +0.15 | +24.65 | 12/16 | 0.12 |

Not anomaly-flagged (`ladderResidual` +0.04). This is the **last unregistered gap** in the
`wnbatp` longshot ladder: `wnbatp-1519` (15-19¢), the cluster `wnbatp-2024/2529/3034` (20-34¢),
and `wnbatp-4044` (40-44¢) already cover every band from 15¢ to 44¢ except this one. Per doctrine
(the `wnbatp-1519`/`wnbatp-4044` precedent), this is registered **separately**, not folded into
the existing cluster — adding a cell post-hoc would change what the cluster's own all-must-pass
verdict means.

**Netting screen** ([[docs/MAKER_LADDER_ARTIFACT.md]] doctrine): pooling the full
`wnba|totalPoints` ladder contracts-weighted at the 50¢ split gives sub-50 **+15.11¢/ct**, 50+
**−13.02¢/ct**, whole book **+1.79¢/ct** — the classic mirrored price-ladder shape (same shape
every already-registered cell in this category sits inside), net positive when pooled. 35-39 sits
in the winning (sub-50, longshot) half.

The band sequence across the whole sub-50 half reads as a coherent decay, not noise: 15-19 (+16.88)
→ 20-24 (+19.54) → 25-29 (+19.58) → 30-34 (+17.57) → **35-39 (+12.40)** → 40-44 (+16.14, a bump,
already registered) → 45-49 (+2.58, near-vanished, correctly NOT registered). 35-39 is a genuine
dip within an otherwise-decaying sequence rather than the smooth midpoint the neighboring bands
would predict — disclosed here rather than smoothed over.

## Hypothesis (stated before the forward data exists)

Selling positions priced **35-39¢** in Kalshi's WNBA total game points market earns positive
per-contract PnL because these markets systematically overprice the longshot side of game total
thresholds — the same mechanism already registered for the `wnbatp` cluster, `wnbatp-1519`, and
`wnbatp-4044`, filling the gap between the 30-34 and 40-44 registrations.

Mechanism (identical to the registered `wnbatp` cells): WNBA game totals cluster around a typical
range; a market anchoring on season-average scoring rather than the actual tail probability at a
given threshold overprices thresholds away from the mean.

Directional prediction: the sold (35-39¢) side should win materially **less** than its ~36.9¢ price
implies.

## In-sample evidence (2026-07-29 → 2026-08-16, NOT part of the test)

**Band 35-39** (174 fills, 1262.3 contracts, 16 days, avg ask ~36.9¢):
- **+12.40¢/contract**, day-clustered CI **[+0.15, +24.65]** — clears zero, thinly.
- **12 of 16 days positive**; topDayShare 0.12 (well distributed, the lowest topDayShare of any
  registered `wnbatp` cell).
- **Weighted aggregate sideWon ≈ 0.246** vs ~36.9¢ priced — a ~12.3pp structural gap.

| day | fills | contracts | ¢/ct | sideWon | avgAsk |
|---|---|---|---|---|---|
| 2026-07-29 | 16 | 87.0 | −33.05 | 0.690 | 36.4 |
| 2026-07-30 | 12 | 80.0 | +36.13 | 0.000 | 36.0 |
| 2026-08-02 | 17 | 114.5 | −16.09 | 0.524 | 36.1 |
| 2026-08-03 | 14 | 90.0 | +36.89 | 0.000 | 36.9 |
| 2026-08-04 | 4 | 40.0 | +38.50 | 0.000 | 38.5 |
| 2026-08-05 | 14 | 90.0 | +15.11 | 0.222 | 37.1 |
| 2026-08-06 | 6 | 30.0 | +35.33 | 0.000 | 35.2 |
| 2026-08-07 | 7 | 60.0 | −11.17 | 0.500 | 38.9 |
| 2026-08-08 | 1 | 10.0 | +35.00 | 0.000 | 35.0 |
| 2026-08-09 | 13 | 90.0 | +36.89 | 0.000 | 36.8 |
| 2026-08-10 | 6 | 50.0 | +37.40 | 0.000 | 37.5 |
| 2026-08-11 | 1 | 10.0 | +36.00 | 0.000 | 36.0 |
| 2026-08-13 | 16 | 133.1 | −6.82 | 0.451 | 38.0 |
| 2026-08-14 | 11 | 90.0 | +36.44 | 0.000 | 36.3 |
| 2026-08-15 | 21 | 190.0 | +4.89 | 0.316 | 36.4 |
| 2026-08-16 | 15 | 97.7 | +17.12 | 0.205 | 37.8 |

Two notably bad days: 07-29 (87 contracts, sideWon 0.690, −33.05¢/ct) and 08-02 (114.5 contracts,
sideWon 0.524, −16.09¢/ct) — both meaningful volume, not tiny-sample outliers, and both are the
two largest negative swings in the window. This is a real named risk rather than a smoothed-over
detail: 4 of 16 days (07-29, 08-02, 08-07, 08-13) ran sideWon above 0.35, materially above the
~0.246 weighted average. In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-17`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-31** (~2 weeks; WNBA plays 4-5 games/slate, expect ~11 fills/day at this
  band, so ≥50 fills reachable in ≥5 days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=wnba|totalPoints|35-39&since=2026-08-17` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: the in-sample CI-lo (+0.15) is thin, and this cell has the most day-to-day variance of
any `wnbatp` band registered so far (two substantial bad days out of sixteen, not one). Criterion 3's
60% bar is the binding test of whether this variance stays occasional or becomes the pattern.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-17)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days.
4. Forward **sideWon < 0.32** (in-sample 0.246; headroom for variance, stays below the ~36.9¢
   avg ask).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell at the checkpoint.

ALL six criteria must hold. A partial pass is a KILL.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not move a threshold. A kill here does NOT affect the already-registered `wnbatp`
  cluster, `wnbatp-1519`, or `wnbatp-4044`.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-09-14), then decide.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**.

1. **Un-shelve V2** and **re-scope it to this cell only** — `KXWNBATOTALPOINTS`, longshot side
   in [35,39].
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end ($30 fallback).
3. The real-money trial is **itself the final test**; scale only if it reproduces the edge on real
   fills.

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-17. Moving any threshold post-hoc,
or combining this verdict with the `wnbatp` cluster's, `wnbatp-1519`'s, or `wnbatp-4044`'s, voids
the pre-registration.
