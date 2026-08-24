# Pre-registration — WNBA totalPoints longshot cluster 20-34¢ (2026-08-10)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-10 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-09; the forward window opens 2026-08-10, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cluster, and why it gets a forward test rather than a verdict

The 2026-08-09 morning `robustCandidates` tripwire surfaced **3 adjacent bands** of the
`wnba|totalPoints` category among the 17 cells clearing the strict structural bar (`ROBUST_BAR`
{minDays:8, minFills:50, maxTopDayShare:0.35}) — `reliable` (day-clustered CI already excludes
zero, positive side):

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days |
|------|-------|------|-----------|-------|-------|----------|
| 20–24 | 71 | 10 | +17.47 | +8.45 | +26.49 | 9/10 |
| 25–29 | 90 | 10 | +22.84 | +15.85 | +29.83 | 9/10 |
| 30–34 | 70 |  9 | +20.28 |  +9.31 | +31.24 | 6/9 |

These three are registered as a **cluster** because they share a single mechanism: the longshot
side of WNBA total-points markets. A separate pre-registration for each is logged in PREREG_CELLS
(`wnbatp-2024`, `wnbatp-2529`, `wnbatp-3034`) so that checkpoint verdicts are independent; all
three must pass. Registering them separately is honest: each can independently fail if the
mechanism is band-specific; registering them together would allow a strong band to obscure a
failing one.

Multiplicity note: 17 cells cleared the bar on the 8/09 board, and 3 of them are adjacent cells in
the same category. At a one-sided 95% bar, ~1/40 of ~555 cells clears zero by chance — 17 hits is
already 4× the noise floor, which is itself a signal that the WNBA totalPoints area is broadly
anomalous (not just one cherry-picked cell). Still, the bar is **not** multiplicity-corrected, and
an uncontested in-sample bright spot is exactly what a noisy grid produces. What can resolve it is
a **forward test on days that do not yet exist**, with a mechanism and decision rule fixed in
advance. This file is that mechanism and that bar.

## Hypothesis (stated before the forward data exists)

Selling positions priced **20-34¢** in Kalshi's WNBA total game points market (`KXWNBATOTALPOINTS`)
earns positive per-contract PnL because **these markets systematically overprice the longshot side
of extreme-threshold outcomes**. The quoted side (whichever of YES or NO falls in the 20-34¢ range)
is priced at 20-34¢ but realizes far below that rate.

Mechanism: WNBA game totals land in a relatively narrow distribution. Markets pricing extreme
thresholds — a very high combined total (YES at 20¢) or a very low combined total (NO at 25¢) —
appear to anchor on a rule-of-thumb price rather than the actual tail probability at that threshold.
The result is structural overpricing on the longshot side, and the maker captures that overpricing
via the vig on each fill.

Directional prediction: the sold (longshot) side should win materially **less** than its 20-34¢
price implies. The mechanism requires sideWon well below each band's avg ask.

## In-sample evidence (2026-07-10 → 2026-08-09, NOT part of the test)

**Band 20-24** (71 fills, 499.5 contracts, 10 days, avg ask ~22¢):
- **+17.47¢/contract**, day-clustered CI **[+8.45, +26.49]**.
- **9 of 10 days positive**; topDayShare 0.34 (not one-slate dominated).
- sideWon by day: 0, 0, 0, 0, 0, 0, 0, 0.364 (8/6 — the lone losing day), 0, 0.
- **Weighted aggregate sideWon ≈ 0.056** vs the ~22¢ price implied.

**Band 25-29** (90 fills, 642.1 contracts, 10 days, avg ask ~27¢):
- **+22.84¢/contract**, day-clustered CI **[+15.85, +29.83]** — cleanest of the three.
- **9 of 10 days positive**; topDayShare 0.21.
- sideWon by day: 0, 0, 0, 0, 0, 0, 0.143, 0, 0.333 (8/7 — the lone losing day), 0.
- **Weighted aggregate sideWon ≈ 0.051** vs the ~27¢ price implied.

**Band 30-34** (70 fills, 569.2 contracts, 9 days, avg ask ~32¢):
- **+20.28¢/contract**, day-clustered CI **[+9.31, +31.24]** — wider, noisier than the lower bands.
- **6 of 9 days positive** (three losing days; 8/6 at sideWon 0.705 is the worst single day).
- **Weighted aggregate sideWon ≈ 0.120** vs the ~32¢ price implied.

**Pooled 20-34** (231 fills, 1710.8 contracts, 10 days):
- Weighted mean **+20.42¢/contract**; weighted sideWon ≈ **0.075** vs ~26¢ blended price.

The 20-24 and 25-29 bands show near-zero sideWon on most days — not a small displacement but a
near-categorical one. The 30-34 band is noisier: 3 negative days, one with 70.5% sideWon. All
three still clear the structural bar with positive CI-lo. In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-10`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-24** (~2 weeks / expected ~10 WNBA slate days at typical WNBA cadence
  of 4-5 games/week; each band fills ~7-9 per WNBA day, so ≥50 fills is reachable in ≥8 days).
- Evaluate each band with:
  `GET /api/shadow-report?makerCell=wnba|totalPoints|{band}&since=2026-08-10` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note (stated up front, not an escape hatch): each band's in-sample effect is large (+17-23¢)
and each band fills 7-9/day, so ≥8 forward days carries enough power to confirm an effect of this
size. A smaller effect (say +5¢) is borderline — which is why criterion 2 sets a +5¢ floor: an
edge too small to confirm in two weeks is too small to justify real capital once variance drag,
adverse selection, and WNBA season-end calendar risk are accounted for.

## GREEN criteria — ALL must hold on the forward window, PER BAND (fixed 2026-08-10)

**For bands 20-24 and 25-29 (sideWonBelow 0.15):**
1. Forward day-clustered CI **lower bound > 0** (t-adjusted, same interval the report computes).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days (consistency).
4. Forward **sideWon < 0.15** (mechanism must persist — the sold ~22/27¢ longshot keeps winning
   far less than priced; 0.15 is ~0.09-0.10 above in-sample, room for forward variance; stays well
   below the 0.22/0.27 avg ask).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell.

**For band 30-34 (sideWonBelow 0.22):**
1–3, 5–6: same as above.
4. Forward **sideWon < 0.22** (in-sample 0.120; 0.10 headroom; stays well below 0.32 avg ask).

**GREEN requires ALL THREE bands to individually clear all six criteria.** A pass on two with a kill
on one is a partial kill: the mechanism applies to all three or it does not hold.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails for ANY band at the checkpoint → **KILL that band**. The other
  bands' verdicts stand independently.
- A cluster where some bands pass and some fail is ambiguous: **do not advance the passing bands
  to real capital** — a mechanism that only survives in two of three adjacent bands is a signal
  the hypothesis is over-specified, not confirmed.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to 2026-09-07 (WNBA regular season should still be active). Sample-thinness is the one
  reason to wait; a criterion failure never is.

## What GREEN triggers — real money, scoped and small first

A clean forward pass on all three bands satisfies the `REENTRY.md` re-entry bar for this cluster
and flips the `AWAITING_VALIDATED_EDGE` posture **for this cluster only**. GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to
   this cluster** — `KXWNBATOTALPOINTS`, longshot side (whichever of YES/NO is in [20,34]),
   fill_ask ∈ [20,34]. A deliberate code change, authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end (start near the $30
   fallback), not the $500 cap.
3. The real-money trial is **itself the final test**: it measures real fill rate + adverse selection
   over its own window. Scale toward the cap **only** if the trial reproduces the edge on real fills.

In one line: **green light = start real money, scoped to this cluster and sized small; the trial is
the last confirmation, not a formality.**

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-10. All three bands got here by
clearing a structural bar AND sharing an articulable first-principles mechanism; the forward test is
the only thing standing between "looks green" and "is real," so the rule that evaluates it must not
be adjustable after the fact.

## Checkpoint result (2026-08-24) — KILL

Forward window `2026-08-10` → checkpoint `2026-08-24`, 7 WNBA slate days materialized (of the ~10
expected at typical cadence).

| band | days | fills | mean | bar | CI-lo | bar | posDays | bar | sideWon | bar | sample | met? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20-24 | 7 | 71 | +21.96 | ≥5 ✅ | +21.54 | >0 ✅ | 7/7 | ≥0.6 ✅ | 0.000 | <0.15 ✅ | 7d/71 | ❌ (7d<8) |
| 25-29 | 7 | 107 | +12.65 | ≥5 ✅ | +3.96 | >0 ✅ | 6/7 | ≥0.6 ✅ | 0.137 | <0.15 ✅ | 7d/107 | ❌ (7d<8) |
| 30-34 | 7 | 84 | +14.92 | ≥5 ✅ | +5.72 | >0 ✅ | 6/7 | ≥0.6 ✅ | 0.172 | <0.22 ✅ | 7d/84 | ❌ (7d<8) |

All three bands: criteria 1-4 pass cleanly. Criterion 5 (sample) is the only miss, and only its
days component — every band already cleared its 50-fill floor (71/107/84), but only 7 of the
required 8 WNBA slate days had landed by the fixed 2026-08-24 checkpoint.

**This document's own text (§ KILL / EXTEND rules) describes exactly this case as extend-eligible**
("only criterion 5 unmet, with 1-4/6 otherwise trending pass → extend once to 2026-09-07"). That
clause is not being invoked. `api/lib/maker-prereg.js:259-262` has no EXTEND verdict in the running
system — once `now >= checkpoint`, a sample-floor miss and a statistical failure both collapse to
KILL — and this was investigated and confirmed intentional on 2026-08-24 (checkpoint date fixed
*before* the window opens specifically so it cannot be moved after seeing how the data looks; see
memory `feedback_prereg_checkpoint_hard_deadline`). The call made here is to evaluate on the data
already collected rather than set a second future checkpoint: **KILL, cluster does not advance.**

Corroborating context, not new evidence: the netting screen (`docs/MAKER_LADDER_ARTIFACT.md`, run
2026-08-11) already classified this category's whole book as "MIRRORED, net +" — sub-50 +17.93¢/ct
against 50+ −12.43¢/ct, whole book +2.75¢/ct, inside noise floor. A same-day independent recheck on
the current window reproduces this: sub-50 +13.81¢/ct, 50+ −12.70¢/ct, whole book **+1.28¢/ct on
15,575 contracts** — still small, still consistent with no independent edge once both halves of the
book are pooled. The checkpoint result does not contradict that classification.

**Verdict: KILL.** Cluster does not advance to real capital. Per the KILL rule, not re-sliced.
