# Pre-registration — MLB spread underdog cluster 25-39¢ (2026-08-10)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-10 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-09; the forward window opens 2026-08-10, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cluster, and why it gets a forward test rather than a verdict

The 2026-08-09 morning `robustCandidates` tripwire surfaced **2 bands** of the `mlb|spread`
category among the 17 cells clearing the strict structural bar (`ROBUST_BAR` {minDays:8,
minFills:50, maxTopDayShare:0.35}) — `reliable` (day-clustered CI already excludes zero, positive
side):

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days |
|------|-------|------|-----------|-------|-------|----------|
| 25–29 | 163 | 10 | +12.59 | +4.92 | +20.26 | 9/10 |
| 35–39 | 151 | 10 | +14.90 | +9.06 | +20.74 | 8/10 |

These two are registered as a **cluster** sharing one mechanism. Separate PREREG_CELLS entries
(`mlbsp-2529`, `mlbsp-3539`) allow independent checkpoint verdicts; both must pass. This is the
third cluster registered on 2026-08-10 (alongside the WNBA totalPoints and WNBA spread clusters)
and extends the same money-line-anchoring hypothesis to MLB — a cross-sport validation, not a new
claim.

Multiplicity note: 17 cells cleared the bar on the 8/09 board. This is the fourth and fifth cell
from that board to receive a pre-registration (after the six WNBA cells registered earlier the same
morning). The forward test is what separates a real effect from 17 draws on a noisy grid.

## Hypothesis (stated before the forward data exists)

Selling positions priced **25-39¢** in Kalshi's MLB spread market earns positive per-contract PnL
because **MLB underdog spread markets systematically overprice the cover probability** at these
longshot prices. The quoted side (the underdog covering the run-line spread) is priced at 25-39¢
but the actual cover rate is materially lower.

Mechanism: Kalshi spread prices for MLB underdogs are anchored off the money-line probability,
which overstates the cover probability. A team priced at 30¢ to cover is typically a sizable
underdog — such teams lose more often than they win, and when they do lose they tend to lose by
more than the spread. The money-line anchor does not fully account for the additional hurdle of
covering the number. This is the same mechanism proposed for WNBA underdog spreads
(docs/MAKER_WNBA_SP_PREREG.md); registering it in MLB is a cross-sport test of the same claim.

Directional prediction: the sold (underdog cover) side should win materially **less** than its
25-39¢ price implies. The mechanism requires sideWon well below each band's avg ask.

## In-sample evidence (2026-07-10 → 2026-08-09, NOT part of the test)

**Band 25-29** (163 fills, 995.3 contracts, 10 days, avg ask ~27¢):
- **+12.59¢/contract**, day-clustered CI **[+4.92, +20.26]** — thinner than the 35-39 band.
- **9 of 10 days positive**; topDayShare 0.32.
- sideWon by day: 0.09, 0, 0.17, 0.269, 0, 0.174, 0.144, 0.255, 0, 0.565 (8/8 — the bad day).
- **Fill-weighted aggregate sideWon ≈ 0.149** vs the ~27¢ price implied.
- The CI-lo of +4.92¢ sits close to the +5¢ meanFloor criterion — this is honestly stated and not
  softened. A modest forward deterioration would immediately fail criterion 2, which is the correct
  outcome if the in-sample effect is smaller than it appears.

**Band 35-39** (151 fills, 1077.4 contracts, 10 days, avg ask ~37¢):
- **+14.90¢/contract**, day-clustered CI **[+9.06, +20.74]** — the cleaner of the two.
- **8 of 10 days positive** (two negative days: 7/31 sideWon 0.385 at −2.27¢; 8/8 sideWon 0.580
  at −20¢); topDayShare 0.25.
- sideWon by day: 0.167, 0, 0.385, 0.259, 0.167, 0.235, 0.125, 0.305, 0, 0.580 (8/8).
- **Fill-weighted aggregate sideWon ≈ 0.227** vs the ~37¢ price implied.

**Character note — different from WNBA spread:** Unlike the WNBA spread cluster where sideWon was
near-zero on most days, here sideWon genuinely fluctuates (0–0.305 on non-outlier days). MLB
underdogs DO cover sometimes — the mechanism is overpricing, not near-zero probability. This is a
real but smaller displacement from fair value compared to WNBA spread.

**Correlated bad day — 8/8**: Both bands had their worst day on 8/8 (sideWon 0.565 and 0.580
respectively), the same MLB slate. An MLB day with multiple underdog covers hits both bands
simultaneously — the named tail risk.

In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-10`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-24** (~2 weeks / ~13 MLB slate days at typical cadence).
- Evaluate each band with:
  `GET /api/shadow-report?makerCell=mlb|spread|{band}&since=2026-08-10` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: both bands fill 15+ per day (~20+ for 25-29), so ≥50 fills arrives within ~3-4 forward
days. The constraining gate is ≥8 days, not fills. An effect of the in-sample size (+12-15¢)
resolves clearly in 2 weeks; a smaller real effect (+5¢) is borderline — which is why the meanFloor
is set at +5¢ and the 25-29 band's CI-lo proximity to that floor is disclosed above.

## GREEN criteria — ALL must hold on the forward window, PER BAND (fixed 2026-08-10)

**For band 25-29 (sideWonBelow 0.22):**
1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days.
4. Forward **sideWon < 0.22** (in-sample 0.149; ~0.07 headroom; stays well below ~27¢ avg ask —
   requires the cover rate to remain materially below the implied probability).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell.

**For band 35-39 (sideWonBelow 0.30):**
1–3, 5–6: same as above.
4. Forward **sideWon < 0.30** (in-sample 0.227; ~0.07 headroom; stays well below ~37¢ avg ask).

**GREEN requires BOTH bands to individually clear all six criteria.** A pass on one with a kill on
the other is a partial kill: the mechanism applies to both price levels or it does not hold.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails for either band at the checkpoint → **KILL that band.**
- A cluster where one band passes and one fails: **do not advance the passing band to real
  capital** — same doctrine as the WNBA clusters.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to 2026-09-07, then decide. Sample-thinness is the one reason to wait.

## What GREEN triggers — real money, scoped and small first

A clean forward pass on both bands satisfies the `REENTRY.md` re-entry bar for this cluster and
flips the `AWAITING_VALIDATED_EDGE` posture **for this cluster only**. GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to
   this cluster** — MLB spread markets, underdog side, fill_ask ∈ [25,39]. A deliberate code
   change, authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end (start near the $30
   fallback), not the $500 cap.
3. The real-money trial is **itself the final test**. Scale toward the cap **only** if the trial
   reproduces the edge on real fills.

In one line: **green light = start real money, scoped to this cluster and sized small; the trial is
the last confirmation, not a formality.**

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-10. Both bands cleared a
structural bar and share an articulable mechanism; the forward test is the only thing standing
between "looks green" and "is real," so the rule that evaluates it must not be adjustable after
the fact.
