# Pre-registration — WNBA threePointers moderate-favorite 60-64¢ (2026-08-10)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-10 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-09; the forward window opens 2026-08-10, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-10 morning `robustCandidates` tripwire surfaced `wnba|threePointers|60-64` among 19
cells clearing the strict structural bar (`ROBUST_BAR` {minDays:8, minFills:50,
maxTopDayShare:0.35}) — `reliable` (day-clustered CI already excludes zero, positive side):

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days |
|------|-------|------|-----------|-------|-------|----------|
| 60–64 | 55 | 8 | +29.20 | +13.45 | +44.95 | 6/8 |

This is a new category (threePointers), first time the tripwire has fired for WNBA 3-point props.
Registered as a single cell (no adjacent bands in the candidates; the 60-64¢ band stands alone).

Multiplicity note: 19 cells cleared the bar today. At a one-sided 95% bar, ~1/40 cells clears zero
by chance — 19 hits across ~555 cells is 4-5× the noise floor. Many of those 19 are already
registered (wnbatp, wnbasp, mlbsp, totalruns clusters); this is a genuinely new category with a
distinct mechanism, not an extension of an existing cluster.

## Hypothesis (stated before the forward data exists)

Selling positions priced **60-64¢** in Kalshi's WNBA three-pointers made prop market
(`KXWNBATHREEPOINTERS` or equivalent) earns positive per-contract PnL because **these markets
systematically overprice the moderate-favorite side of WNBA team 3-point made props**. The quoted
side (YES or NO, whichever falls in 60-64¢) is priced as if the team has a 60-64% chance of
reaching/clearing the threshold, but realizes materially lower than that rate.

Mechanism: WNBA 3-point made totals are volatile game-to-game. Team-level 3PM rates depend on
shot selection, defense, pace, and individual form — all of which vary substantially across games.
A market anchoring on a team's season-average 3PM rate will systematically underestimate this
variance, placing too much probability on outcomes near the mean and mispricing extremes. The
moderate-favorite band (60-64¢) is particularly susceptible: it represents a threshold just above
or near the mean, where anchoring noise is largest and the market's confidence (62%) is not
supported by the actual distribution's tail probability. The maker captures the overpricing via the
quote-side vig on each fill.

This mechanism is distinct from but related to the already-registered WNBA spread and totalPoints
overpricing: both are ML-anchor effects (market prices anchored on coarser statistics ignoring
game-to-game variance), applied to different prop markets.

Directional prediction: the sold (60-64¢) side should win materially **less** than its price
implies. The mechanism requires sideWon well below the 60-64¢ band's avg ask.

## In-sample evidence (through 2026-08-09, NOT part of the test)

**Band 60-64** (55 fills, 392.3 contracts, 8 days, avg ask ~62¢):
- **+29.20¢/contract**, day-clustered CI **[+13.45, +44.95]** — very wide (8 days only).
- **6 of 8 days positive**; topDayShare 0.31 (not one-slate dominated).
- Per-day sideWon: 0.200, 0.234, 0.345, 0.500, 0.000, 0.683, 0.875, 0.512.
- **Weighted aggregate sideWon ≈ 0.327** vs ~62¢ priced — a large structural gap.
- Bad days: 8/03 (sideWon 0.683) and 8/06 (sideWon 0.875). The 8/06 bad day is shared with
  the wnbasp cluster, suggesting a single upset-heavy slate drove concurrent losses.

In-sample only. Not evidence to bet on. The forward test is the binding evaluation.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-10`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-24** (~2 weeks; WNBA typically plays 4-5 games/slate, and 3-point props
  are offered on each; expect ~5-8 fills/WNBA day, so ≥50 fills reachable in ≥8-10 days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=wnba|threePointers|60-64&since=2026-08-10` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: the in-sample effect is large (+29¢), but 8 days of forward data at ~5-8 fills/day is a
thin confirmation window. A smaller effect (+5-10¢) is borderline — criterion 2 sets a +5¢ floor
to exclude effects too small to confirm at this sample size.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-10)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted, same interval the report computes).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days (consistency).
4. Forward **sideWon < 0.40** (mechanism must persist — the sold ~62¢ side keeps winning
   less than priced; 0.40 is above in-sample 0.327, leaves headroom for forward variance,
   stays well below the ~62¢ avg ask).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell.

ALL six criteria must hold. A partial pass (e.g. 5/6) is a KILL.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL**. Cell is not re-sliced.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass →
  **extend once** to 2026-09-07 (WNBA regular season expected to be active).
- A kill from this test does NOT affect the already-registered wnbatp or wnbasp clusters.

## What GREEN triggers

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell and flips
`AWAITING_VALIDATED_EDGE` for this cell only. GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to
   this cell** — `KXWNBATHREEPOINTERS` (or whichever is the 3-point made series), longshot side
   in [60,64]. A deliberate code change, authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end ($30 fallback).
3. The real-money trial is **itself the final test**: scale toward cap only if trial reproduces
   the edge on real fills.

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-10. Moving any threshold
post-hoc, or combining this verdict with another cell's verdict, voids the pre-registration.
