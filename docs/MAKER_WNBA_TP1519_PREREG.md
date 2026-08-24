# Pre-registration — WNBA totalPoints extreme longshot 15-19¢ (2026-08-10)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-10 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-09; the forward window opens 2026-08-10, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-10 morning `robustCandidates` tripwire surfaced `wnba|totalPoints|15-19` among 19
cells clearing the structural bar. The already-registered `wnbatp-2024/2529/3034` cluster covers
20-34¢; this cell is the more extreme lower end (15-19¢) — a different regime, same mechanism.

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days |
|------|-------|------|-----------|-------|-------|----------|
| 15–19 | 54 | 8 | +16.80 | +16.42 | +17.17 | 8/8 |

The CI width (0.75¢) is exceptionally narrow because sideWon = **exactly 0** on every one of the 8
days — the CI mechanically converges to the avg ask when there is zero variance in outcomes. This
is not a data artifact; it reflects a genuine structural extreme: the priced threshold is so far
out of the WNBA total-points distribution that no game in the in-sample set crossed it.

Registered as a single cell, separate from the existing wnbatp cluster (per doctrine: a new cell
here is a new id + doc, not an edit of the existing cluster's threshold).

## Hypothesis (stated before the forward data exists)

Selling positions priced **15-19¢** in Kalshi's WNBA total game points market
(`KXWNBATOTALPOINTS`) earns positive per-contract PnL because **these markets systematically
overprice the extreme-longshot side of game total thresholds**. The fill (whichever of YES or NO
falls in 15-19¢) is priced at 15-19¢ but the actual realization rate is near zero.

Mechanism: WNBA game totals cluster tightly around a typical range (e.g., 150-180 combined points
for most games). A 15-19¢ price corresponds to a threshold so far into the tail that the market
is overpricing it — likely by anchoring on season-average scoring rather than computing the
actual tail probability at an extreme threshold. At 15-19¢, the market implies 15-19% chance of
the event occurring; the true probability appears close to 0% (consistent with sideWon=0 on all 8
in-sample days). The maker captures this structural gap.

This is the same mechanism as wnbatp-2024/2529/3034 (extreme threshold overpricing), applied at
a more extreme price tier. The near-zero sideWon signals a categorical rather than gradual effect:
the threshold is simply never reached, not merely rarely reached.

Directional prediction: forward sideWon should remain near zero. The mechanism predicts near-
categorical non-occurrence of the filled side, not merely underperformance.

## In-sample evidence (through 2026-08-09, NOT part of the test)

**Band 15-19** (54 fills, 275.2 contracts, 8 days, avg ask ~16-18¢):
- **+16.80¢/contract**, day-clustered CI **[+16.42, +17.17]** — mechanically tight (zero variance).
- **8 of 8 days positive**; topDayShare 0.32 (not dominated by one slate).
- Per-day sideWon: **0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000** — zero wins across
  all 54 fills / 8 days.
- Per-day avgAsk: 16.5, 16.6, 16.4, 16.9, 17.0, 18.0, 18.0, 15.0¢.
- **Weighted aggregate sideWon = 0.000** — the sold side has not won a single fill.

The tight CI is a mathematical consequence of sideWon=0 (PnL ≈ avgAsk each day → very low
day-to-day variance). It does not indicate a distribution anomaly; it indicates a systematic effect.
In-sample only. Not evidence to bet on. The forward test is the binding evaluation.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-10`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-24** (~2 weeks; 15-19¢ fills are thinner than the 20-34 cluster — expect
  ~5-8 fills/WNBA day, so ≥50 fills reachable in ≥8-10 days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=wnba|totalPoints|15-19&since=2026-08-10` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: the in-sample effect is structural (sideWon=0), not noisy. Even one forward day with
sideWon ≈ 0.05-0.10 would still pass the bar. A regime change — where the threshold suddenly
becomes reachable — would produce sideWon ≥ 0.10-0.15 and likely a KILL.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-10)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days (consistency — allows a few rare-win days).
4. Forward **sideWon < 0.05** (mechanism must persist — the sold 15-19¢ extreme longshot keeps
   not winning; 0.05 is well above in-sample 0.000, provides variance headroom, while still
   enforcing the near-categorical prediction; stays far below the ~17¢ avg ask).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell.

ALL six criteria must hold. sideWonBelow 0.05 is deliberately strict: if this extreme longshot
begins winning even 1 in 20 fills, the "categorical non-occurrence" mechanism has failed. A partial
pass is a KILL.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL**. Cell is not re-sliced, and
  the regime-change hypothesis (threshold moved into range) becomes the operative theory.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass →
  **extend once** to 2026-09-07.
- A kill here does NOT affect the wnbatp-2024/2529/3034 cluster, which covers a less-extreme range.

## What GREEN triggers

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell and flips
`AWAITING_VALIDATED_EDGE` for this cell only. GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to
   this cell** — `KXWNBATOTALPOINTS`, extreme-longshot side in [15,19].
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end ($30 fallback).
3. The real-money trial is **itself the final test**.

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-10. Moving any threshold
post-hoc voids the pre-registration.

## Checkpoint result (2026-08-24) — KILL

Forward window `2026-08-10` → checkpoint `2026-08-24`. Only 5 WNBA slate days materialized in this
window (this cell was registered slightly later in the 8/10 tripwire batch than the wnbatp
20-34¢ cluster, so its forward clock effectively started thinner).

| criterion | bar | actual | met? |
|---|---|---|---|
| CI-lo > 0 | >0 | +16.42 | ✅ |
| mean ≥ +5¢/ct | ≥5 | +17.19 | ✅ |
| ≥60% days positive | ≥0.6 | 5/5 = 1.0 | ✅ |
| sideWon < 0.05 | <0.05 | 0.000 | ✅ |
| sample | ≥8d & ≥50 fills | 5d/34 | ❌ |

Criteria 1-4 pass cleanly — sideWon stayed at exactly 0 across all 5 forward days, consistent with
the in-sample "categorical non-occurrence" read. Criterion 5 is the only miss, on both its
components this time (5d<8, 34<50 fills).

**This document's own text (§ KILL / EXTEND rules) describes exactly this shape as extend-eligible**
("only criterion 5 unmet, with 1-4/6 otherwise trending pass → extend once to 2026-09-07"). That
clause is not being invoked, for the same reason recorded across the other three WNBA checkpoint
results dated today: `api/lib/maker-prereg.js:259-262` has no EXTEND verdict in the running system
(confirmed intentional 2026-08-24), and the decision here is to evaluate on the data already
collected rather than push to a second future checkpoint.

**Verdict: KILL.** Not re-sliced. Does not affect the wnbatp-2024/2529/3034 cluster's independent
verdict (recorded separately in `docs/MAKER_WNBA_TP_PREREG.md`).
