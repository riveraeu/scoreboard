# Pre-registration — WNBA spread longshot cluster 10-24¢ (2026-08-10)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-10 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-09; the forward window opens 2026-08-10, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cluster, and why it gets a forward test rather than a verdict

The 2026-08-09 morning `robustCandidates` tripwire surfaced **3 adjacent bands** of the
`wnba|spread` category among the 17 cells clearing the strict structural bar (`ROBUST_BAR`
{minDays:8, minFills:50, maxTopDayShare:0.35}) — `reliable` (day-clustered CI already excludes
zero, positive side):

| Band | Fills | Days | Mean ¢/ct | CI-lo | CI-hi | Pos days |
|------|-------|------|-----------|-------|-------|----------|
| 10–14 | 66 | 10 | +9.24 | +2.37 | +16.11 | 9/10 |
| 15–19 | 63 | 10 | +11.37 | +2.79 | +19.94 | 9/10 |
| 20–24 | 85 | 10 | +21.74 | +21.43 | +22.05 | 10/10 |

These three are registered as a **cluster** sharing one mechanism. Separate PREREG_CELLS entries
(`wnbasp-1014`, `wnbasp-1519`, `wnbasp-2024`) allow independent checkpoint verdicts; all three
must pass. This file is registered on the same morning as the `wnba|totalPoints` 20-34¢ cluster
(docs/MAKER_WNBA_TP_PREREG.md), with both sharing the broader theme of WNBA longshot overpricing —
they are independent mechanisms (spread-cover vs total-points outcome) and are tested independently.

Multiplicity note: 17 cells cleared the bar on the 8/09 board (4× the ~4-cell noise floor). Two
clusters of 3 in the same sport (WNBA) emerging together is itself a signal that WNBA longshot
pricing is broadly anomalous — not just cherry-picked single cells. The bar remains not
multiplicity-corrected, and the in-sample count cannot be acted on. The forward test resolves it.

## Hypothesis (stated before the forward data exists)

Selling positions priced **10-24¢** in Kalshi's WNBA spread market earns positive per-contract
PnL because **WNBA underdog spread markets systematically overprice the cover probability** at
longshot prices. The quoted side (the underdog covering the spread) is priced at 10-24¢ but
realizes far below that rate.

Mechanism: WNBA market makers anchor spread prices primarily off the money-line probability, which
overstates the underdog's cover probability. A team priced at 22¢ to cover is implicitly a heavy
underdog — teams at that probability tend to lose by large margins, not just barely. The spread
market's longshot side thus inherits the money-line's probability estimate without accounting for
the additional hurdle of actually covering the number.

Directional prediction: the sold (underdog cover) side should win materially **less** than its
10-24¢ price implies. The mechanism requires sideWon well below each band's avg ask.

## In-sample evidence (2026-07-10 → 2026-08-09, NOT part of the test)

**Band 10-14** (66 fills, 298.5 contracts, 10 days, avg ask ~12¢):
- **+9.24¢/contract**, day-clustered CI **[+2.37, +16.11]**.
- **9 of 10 days positive**; topDayShare 0.21.
- sideWon by day: 0, 0, 0, 0, 0, 0, 0, 0.500 (8/6 — the lone losing day, 2 fills), 0, 0.
- **Weighted aggregate sideWon ≈ 0.015** vs the ~12¢ price implied.

**Band 15-19** (63 fills, 494.9 contracts, 10 days, avg ask ~17¢):
- **+11.37¢/contract**, day-clustered CI **[+2.79, +19.94]**.
- **9 of 10 days positive**; topDayShare 0.19.
- sideWon by day: 0, 0, 0, 0, 0.154, 0, 0, 0.500 (8/6), 0, 0.
- **Weighted aggregate sideWon ≈ 0.072** vs the ~17¢ price implied.

**Band 20-24** (85 fills, 551.8 contracts, 10 days, avg ask ~22¢):
- **+21.74¢/contract**, day-clustered CI **[+21.43, +22.05]** — note the near-zero inter-day
  variance: this arises because sideWon = 0 on every single day, so perContract ≈ avgAsk each day
  with minimal variation. This is not a data artifact; it is a literal statement that the underdog
  cover never resolved in favor of the taker across 85 fills and 10 WNBA slate days.
- **10 of 10 days positive** (sideWon 0 every day); topDayShare 0.31.
- **Weighted aggregate sideWon = 0.000** vs the ~22¢ price implied.

**Correlated bad day — 8/6**: The one losing day for 10-14 and 15-19 is the same calendar date.
This is one WNBA upset (an underdog covering at 10-19¢ odds), not two independent failures. The
20-24 band had 2 fills on 8/6 and neither covered. The correlation is reassuring — it names the
risk: one unexpected underdog cover hits all three bands simultaneously on the same game.

**Pooled 10-24** (214 fills, 1345.2 contracts, 10 days):
- Weighted mean **+13.89¢/contract**; aggregate sideWon ≈ **0.032** vs ~17¢ blended price.

In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-10`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-24** (~2 weeks / expected ~10 WNBA slate days).
- Evaluate each band with:
  `GET /api/shadow-report?makerCell=wnba|spread|{band}&since=2026-08-10` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: the 20-24 band's in-sample sideWon = 0 makes its forward CI mechanically tight only
while sideWon stays near zero. The first day the cover lands, the CI widens substantially — this
is expected and does not void the pre-registration. The question the forward test asks is whether
the cover rate stays materially below 22% over the full forward window, not whether it stays at 0%.

## GREEN criteria — ALL must hold on the forward window, PER BAND (fixed 2026-08-10)

**For band 10-14 (sideWonBelow 0.08):**
1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days.
4. Forward **sideWon < 0.08** (mechanism must persist — in-sample 0.015 vs ~12¢ priced; 0.08
   allows ~5 cover days out of 60 fills, still well below the 12% implied rate).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell.

**For band 15-19 (sideWonBelow 0.12):**
1–3, 5–6: same as above.
4. Forward **sideWon < 0.12** (in-sample 0.072; 0.05 headroom; stays well below ~17¢ avg ask).

**For band 20-24 (sideWonBelow 0.12):**
1–3, 5–6: same as above.
4. Forward **sideWon < 0.12** (in-sample 0.000; generous headroom for the first real covers to
   land; still well below the ~22¢ avg ask — requires the cover rate to stay materially below
   the implied probability even when the zero-variance in-sample record breaks forward).

**GREEN requires ALL THREE bands to individually clear all six criteria.** A pass on two with a
kill on one is a partial kill: the mechanism applies to all three price levels or it does not hold.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails for ANY band at the checkpoint → **KILL that band.**
- A cluster where some bands pass and some fail: **do not advance the passing bands to real
  capital** — same doctrine as the totalPoints cluster pre-registered this same morning.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to 2026-09-07 (WNBA regular season should still be active). Sample-thinness is the one
  reason to wait; a criterion failure never is.

## What GREEN triggers — real money, scoped and small first

A clean forward pass on all three bands satisfies the `REENTRY.md` re-entry bar for this cluster
and flips the `AWAITING_VALIDATED_EDGE` posture **for this cluster only**. GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to
   this cluster** — WNBA spread markets, longshot (underdog) side, fill_ask ∈ [10,24]. A
   deliberate code change, authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end (start near the $30
   fallback), not the $500 cap.
3. The real-money trial is **itself the final test**: it measures real fill rate + adverse selection
   over its own window. Scale toward the cap **only** if the trial reproduces the edge on real fills.

In one line: **green light = start real money, scoped to this cluster and sized small; the trial is
the last confirmation, not a formality.**

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-10. All three bands cleared a
structural bar and share an articulable first-principles mechanism; the forward test is the only
thing standing between "looks green" and "is real," so the rule that evaluates it must not be
adjustable after the fact.

## Checkpoint result (2026-08-24) — KILL

Forward window `2026-08-10` → checkpoint `2026-08-24`, 7 WNBA slate days materialized (of the ~10
expected at typical cadence).

| band | days | fills | mean | bar | CI-lo | bar | posDays | bar | sideWon | bar | sample | met? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10-14 | 7 | 66 | +12.54 | ≥5 ✅ | +12.07 | >0 ✅ | 7/7 | ≥0.6 ✅ | 0.000 | <0.08 ✅ | 7d/66 | ❌ (7d<8) |
| 15-19 | 7 | 113 | +14.61 | ≥5 ✅ | +10.88 | >0 ✅ | 7/7 | ≥0.6 ✅ | 0.026 | <0.12 ✅ | 7d/113 | ❌ (7d<8) |
| 20-24 | 7 | 98 | +13.40 | ≥5 ✅ | +1.72 | >0 ✅ | 6/7 | ≥0.6 ✅ | 0.089 | <0.12 ✅ | 7d/98 | ❌ (7d<8) |

All three bands: criteria 1-4 pass cleanly, criterion 5 is the only miss and only its days
component — all three already cleared their 50-fill floors (66/113/98), but only 7 of the required
8 WNBA slate days had landed by the fixed 2026-08-24 checkpoint.

**This document's own text (§ KILL / EXTEND rules) describes exactly this case as extend-eligible.**
That clause is not being invoked, for the same reason recorded in `docs/MAKER_WNBA_TP_PREREG.md`'s
checkpoint result: `api/lib/maker-prereg.js:259-262` has no EXTEND verdict in the running system,
this was confirmed intentional on 2026-08-24 (checkpoint fixed before the window opens so it can't
move after seeing the data), and the call here is to evaluate on the data in hand rather than set a
second future checkpoint.

Corroborating context, not new evidence: the netting screen (`docs/MAKER_LADDER_ARTIFACT.md`, run
2026-08-11) classified this category's whole book as **ARTIFACT** — sub-50 +13.91¢/ct against 50+
−14.11¢/ct, whole book −1.77¢/ct, a near-perfect mirror. A same-day independent recheck on the
current window reproduces the shape: sub-50 +13.21¢/ct, 50+ −12.33¢/ct, whole book **−0.23¢/ct on
16,741 contracts** — still net negative pooled. The three cells reaching checkpoint here are the
winning half of that same mirrored, money-losing book.

**Verdict: KILL.** Cluster does not advance to real capital. Per the KILL rule, not re-sliced.
