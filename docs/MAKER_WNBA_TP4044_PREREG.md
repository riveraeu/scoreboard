# Pre-registration — WNBA totalPoints longshot 40-44¢ (2026-08-16)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-16 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-15; the forward window opens 2026-08-16, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-16 morning `robustCandidates` tripwire surfaced `wnba|totalPoints|40-44` among 23 cells
clearing the structural bar (`ROBUST_BAR` {minDays:8, minFills:50, maxTopDayShare:0.35}):

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days | topDayShare |
|------|-------|------|-----------|-------|-------|----------|-------------|
| 40–44 | 133 | 15 | +14.54 | +1.46 | +27.62 | 12/15 | 0.23 |

Not anomaly-flagged (`ladderResidual` −0.08). The already-registered `wnbatp` cluster
(`wnbatp-2024/2529/3034`, 20-34¢) plus the separately-registered `wnbatp-1519` (15-19¢) cover the
more-extreme longshot tiers of this same category; 40-44 extends the same mechanism to a band
closer to fair odds. Per doctrine (the `wnbatp-1519` precedent), this is registered **separately**,
not folded into the existing cluster — adding a cell post-hoc would change what the cluster's own
all-must-pass verdict means.

**Netting screen** ([[docs/MAKER_LADDER_ARTIFACT.md]] doctrine): pooling the full
`wnba|totalPoints` ladder contracts-weighted at the 50¢ split gives sub-50 **+15.0¢/ct**, 50+
**−13.0¢/ct**, whole book **+1.66¢/ct** — the classic mirrored price-ladder shape (same shape the
already-registered `wnbatp` cluster sits inside), net positive when pooled. 40-44 sits in the
winning (sub-50, longshot) half, same side as every already-registered cell in this category.

The band sequence across the whole sub-50 half reads as a coherent decay, not noise: 15-19 (+16.83)
→ 20-24 (+19.36) → 25-29 (+20.03) → 30-34 (+18.05) → 35-39 (+12.01, a dip) → **40-44 (+14.54)** →
45-49 (+2.15, near-vanished). The effect fades toward zero as price approaches 50/50, exactly as the
"extreme-threshold overpricing" mechanism predicts — this is why 40-44 is registered and 45-49 is
not (45-49's near-pick'em price has no comparable mechanism story; see the same-day investigation
that rejected `mlb|f5total|45-49` on identical grounds).

## Hypothesis (stated before the forward data exists)

Selling positions priced **40-44¢** in Kalshi's WNBA total game points market
(`KXWNBATOTALPOINTS`) earns positive per-contract PnL because **these markets systematically
overprice the longshot side of game total thresholds** — the same mechanism already registered for
the `wnbatp` cluster and `wnbatp-1519`, at a less-extreme tier.

Mechanism (identical to the registered `wnbatp` cells): WNBA game totals cluster around a typical
range; a market anchoring on season-average scoring rather than the actual tail probability at a
given threshold overprices thresholds away from the mean. 40-44¢ is the closest-to-fair-odds band
in the family with a still-material in-sample gap (~41.7¢ priced vs 27.2% realized, ~14.5pp) —
smaller than the more-extreme registered cells' gaps, consistent with a single mechanism weakening
gradually rather than several unrelated coincidences.

Directional prediction: the sold (40-44¢) side should win materially **less** than its ~41.7¢ price
implies.

## In-sample evidence (2026-07-29 → 2026-08-15, NOT part of the test)

**Band 40-44** (133 fills, 1023.2 contracts, 15 days, avg ask ~41.7¢):
- **+14.54¢/contract**, day-clustered CI **[+1.46, +27.62]** — clears zero.
- **12 of 15 days positive**; topDayShare 0.23.
- **Weighted aggregate sideWon ≈ 0.272** vs ~41.7¢ priced — a ~14.5pp structural gap.

| day | fills | contracts | ¢/ct | sideWon | avgAsk |
|---|---|---|---|---|---|
| 2026-07-29 | 4 | 40.0 | +16.75 | 0.250 | 41.8 |
| 2026-07-30 | 5 | 50.0 | +1.80 | 0.400 | 41.8 |
| 2026-07-31 | 2 | 20.0 | +41.50 | 0.000 | 41.5 |
| 2026-08-02 | 23 | 200.0 | +16.65 | 0.250 | 41.6 |
| 2026-08-03 | 5 | 31.0 | +41.61 | 0.000 | 41.2 |
| 2026-08-04 | 8 | 41.0 | +40.49 | 0.000 | 40.6 |
| 2026-08-05 | 7 | 40.0 | +18.25 | 0.250 | 43.6 |
| 2026-08-06 | 4 | 30.5 | +42.66 | 0.000 | 42.5 |
| 2026-08-07 | 9 | 50.0 | −58.40 | 1.000 | 42.0 |
| 2026-08-08 | 5 | 40.0 | +40.50 | 0.000 | 40.4 |
| 2026-08-09 | 4 | 30.0 | +41.67 | 0.000 | 41.5 |
| 2026-08-11 | 1 | 10.0 | +42.00 | 0.000 | 42.0 |
| 2026-08-13 | 16 | 120.0 | −0.25 | 0.417 | 41.4 |
| 2026-08-14 | 15 | 120.0 | +41.92 | 0.000 | 41.8 |
| 2026-08-15 | 25 | 200.7 | −1.97 | 0.440 | 42.0 |

One severe day (08-07): 9 fills, sideWon=1.0, −58.40¢/ct — every longshot won that slate. The
smallest concentrated loss in the set, but worth naming as the tail-risk day, structurally similar
to the tail days named in every other registered longshot cell (`ks-1519`'s 7/31, `mlbf5t-2529`'s
7/31). In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-16`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-30** (~2 weeks; WNBA plays 4-5 games/slate, expect ~8-9 fills/day at this
  band, so ≥50 fills reachable in ≥8-10 days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=wnba|totalPoints|40-44&since=2026-08-16` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: the in-sample effect (+14.54¢) is solid, and 12/15 days positive is a good hit rate.
The main forward risk is a repeat of an 08-07-style tail day (sideWon=1.0 on a whole slate),
which the mechanism itself predicts will recur occasionally — criterion 3's 60% bar tolerates that
as long as it stays occasional.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-16)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days (consistency).
4. Forward **sideWon < 0.35** (mechanism must persist — the sold ~41.7¢ side keeps winning below
   priced; 0.35 is above in-sample 0.272, leaves headroom for forward variance, stays below the
   ~41.7¢ avg ask).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell at the checkpoint.

ALL six criteria must hold. A partial pass is a KILL.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not move a threshold. A kill here does NOT affect the already-registered `wnbatp`
  cluster or `wnbatp-1519`.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-09-13), then decide.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**.

1. **Un-shelve V2** and **re-scope it to this cell only** — `KXWNBATOTALPOINTS`, longshot side
   in [40,44].
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end ($30 fallback).
3. The real-money trial is **itself the final test**; scale only if it reproduces the edge on real
   fills.

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-16. Moving any threshold post-hoc,
or combining this verdict with the `wnbatp` cluster's or `wnbatp-1519`'s, voids the pre-registration.
