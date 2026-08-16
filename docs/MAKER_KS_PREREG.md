# Pre-registration — mlb strikeouts 15-19¢ maker cell (2026-08-06)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-06 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-05; the forward window opens 2026-08-06, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-06 morning `robustCandidates` tripwire surfaced two cells clearing the strict structural
bar (`ROBUST_BAR` {minDays:8, minFills:50, maxTopDayShare:0.35}). `mlb|hrr|70-74` was already
pre-registered (2026-08-05, `docs/MAKER_HRR_PREREG.md`). `mlb|strikeouts|15-19` is the second —
221 fills over 8 days, day-clustered CI **[+0.08, +10.86]**, topDayShare 0.30.

Two cells clearing the bar in a grid of ~555 is still within the range of noise (~1/40 × 555 ≈ 14
expected false positives at a one-sided 95% bar). This is NOT evidence that either cell is real, and
it is NOT a validation that the two hits corroborate each other — they are independent hypotheses
with different mechanisms that need separate forward tests. The bar is **not** multiplicity-corrected.

The in-sample CI barely clears zero (lo = +0.08¢). That is the weakest in-sample signal of any cell
that has reached the forward stage. It is the most important reason to treat the forward test as the
deciding evidence, not the in-sample observation.

## Hypothesis (stated before the forward data exists)

Selling the **longshot side** of MLB pitcher strikeout props (`KXMLBKS`) when that side's ask is
**15–19¢** earns positive per-contract PnL, because the market **overprices low-probability
strikeout outcomes**. "Longshot side" means whichever of YES or NO is in the 15–19¢ range:

- **YES** side when the threshold is high (e.g. pitcher gets 8+ Ks) — YES at ~16¢, NO at ~84¢;
  maker sells YES (the unlikely event).
- **NO** side when the threshold is low (e.g. pitcher gets 3+ Ks) — YES at ~84¢, NO at ~16¢;
  maker sells NO (the unlikely failure).

The directional prediction: the sold longshot side should win materially **less** than its ~16–17¢
price implies. In-sample, the weighted sideWon was ~11.4% vs ~16.5% priced — an apparent ~5pp
overpricing. The mechanism story (longshot bias in prediction markets) is plausible and
well-documented in sports betting. It is also compatible with purely structural causes — Kalshi
line-setting places one side near 15–19¢ when the game-level over/under is obvious, and the
market simply hasn't been corrected to a tighter price. Either interpretation predicts the same
forward outcome: longshots should continue to win at a rate below their price.

The mechanism weakness: the in-sample gap between priced (~16.5¢) and observed (~11.4%) is large
enough to be suspicious. Fat-tail settlement days — where the longshot side all goes right
simultaneously — produce the worst-case loss (sideWon=1.0 on 7/31, perContract=−84.5¢) and the
tail is real. The forward bar is set to require the mechanism to persist, not just PnL to be positive.

## In-sample evidence (2026-07-29 → 2026-08-05, NOT part of the test)

- **+5.47¢/contract**, 221 fills, 1,293 contracts, **8 days**.
- Weighted **sideWon ≈ 0.114** vs ~0.165 price implied.
- Day-clustered CI (t-adjusted) **[+0.08, +10.86]** — barely clears zero.
- **6 of 8 days positive**; topDayShare 0.30.
- **One severe day (7/31)**: 3 fills, all sideWon=1.0, perContract=−84.5¢. A 3-fill day where
  every longshot won against the maker. The smallest-n day in the set — pure or near-pure noise,
  but it illustrates the tail loss this strategy carries when the unlikely side runs hot.
- **Volume is the strongest structural attribute here**: 221 fills in 8 days is substantially
  higher than hrr's fill rate, giving a narrower CI despite the marginal lower bound.

Barely clears the structural bar. Still 1-of-2 cells of ~555. In-sample only. Not evidence to bet on.

| day | fills | contracts | ¢/ct | sideWon | avgAsk |
|---|---|---|---|---|---|
| 2026-07-29 | 23 | 132.3 | +8.92 | 0.076 | 16.4 |
| 2026-07-30 | 29 | 191.0 | +6.20 | 0.105 | 17.0 |
| 2026-07-31 | 3 | 20.0 | −84.5 | 1.000 | 15.7 |
| 2026-08-01 | 9 | 52.0 | −1.50 | 0.192 | 17.7 |
| 2026-08-02 | 47 | 298.5 | +0.04 | 0.175 | 17.6 |
| 2026-08-03 | 44 | 251.4 | +12.87 | 0.040 | 17.1 |
| 2026-08-04 | 39 | 199.1 | +11.32 | 0.053 | 16.7 |
| 2026-08-05 | 27 | 149.1 | +6.58 | 0.099 | 16.4 |

## Forward window

- **Out-of-sample = `game_date >= 2026-08-06`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-20** (~2 weeks / ~14 MLB slates).
- Evaluate with exactly:
  `GET /api/shadow-report?makerCell=mlb|strikeouts|15-19&since=2026-08-06` (ADMIN) → read
  `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and the per-day `sideWon`.

Power note (stated up front, not an escape hatch): at the in-sample fill rate (~27 fills/day),
14 forward days gives ~380 fills. That is enough to resolve an effect of the in-sample magnitude
(+5.47¢) with reasonable power, but the CI is so marginal that any material noise — a run of
high-sideWon days — will kill it. A mean too small to confirm in two weeks is also too small to
be worth real money once variance drag and adverse selection are paid.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-06)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted, the same interval the report computes).
2. Forward mean **≥ +5¢/contract** (a floor, not just "positive" — must clear variance drag +
   expected adverse selection to be worth capital).
3. **Positive on ≥ 60%** of forward days (consistency — not one slate carrying it).
4. Forward **sideWon < 0.14** (the *mechanism* must persist — the sold longshot keeps winning at
   a rate materially below its ~16–17¢ price). Set at 0.14 rather than the in-sample ~0.11: gives
   meaningful forward room while still requiring the longshot to underperform its price by at least
   2–3pp. A forward sideWon of 0.15+ with a priced ~0.165 would say the mechanism has closed.
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell at the checkpoint. (Criteria 1-5 are the five checks
   `evaluatePrereg` enforces; robustCandidates already excludes anomaly-flagged cells by
   construction, so this is a re-check at the checkpoint, not an independent gate.)

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not move a threshold, do not "give it another two weeks to recover." A failed forward
  test is the answer.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-09-03), then decide. Sample-thinness is the one reason
  to wait; a criterion failure never is.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell, and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**. It does NOT mean bet full size on day one.

The shadow fills are **counterfactual** — `replayFills` assumes queue priority and cannot measure
whether a resting 15–19¢ longshot order actually fills at the shadow rate, or whether the flow
hitting it is informed. That is measurable only with real capital. So GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to this
   cell only** — `KXMLBKS`, longshot side, fill_ask ∈ [15,19] — not the current `MAKER_V2_BAND`.
   A deliberate code change, authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end (start near the $30
   fallback, a few contracts per order), not the $500 cap. At 15–19¢ per contract, position sizing
   is in number of contracts; keep total exposure per prop small until real fills confirm the rate.
3. The real-money trial is **itself the final test**: it measures real fill rate + adverse selection
   over its own window. Scale toward the cap **only** if the trial reproduces the edge on real fills.

In one line: **green light = start real money, scoped to this cell and sized small; the trial is the
last confirmation, not a formality.**

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-06. This cell got here by being one
of two cells of ~555 to clear a structural bar; the forward test is the only thing standing between
"looks green" and "is real," so the rule that evaluates it must not be adjustable after the fact.

## RESULT — KILLED EARLY 2026-08-16 (day 9 of the 8-day floor)

**Forward** (`game_date >= 2026-08-06`, 9 days / 284 fills — sample floor already met) — 3 of 4
substantive criteria failed: mean **−2.76¢/ct** (bar ≥+5) · day-clustered CI **[−9.98, +4.47]** (bar
lo>0) · 3 of 9 days positive (bar ≥60%) · **sideWon 0.2004** (bar <0.14). Criterion 3 (positive-day
fraction) was the only one of the four to pass (33% — also below the 60% bar, so it failed too; all
four substantive criteria failed).

Per-day (fills / contracts / avgAsk¢ / sideWon / ¢-per-contract):

| day | fills | contracts | avgAsk | sideWon | ¢/ct |
|---|---|---|---|---|---|
| 2026-08-06 | 9 | 29.7 | 18.2 | 0.321 | −13.71 |
| 2026-08-07 | 23 | 120.0 | 17.3 | 0.333 | −16.58 |
| 2026-08-08 | 13 | 94.2 | 16.2 | 0.013 | +14.89 |
| 2026-08-09 | 8 | 56.2 | 16.6 | 0.356 | −18.83 |
| 2026-08-10 | 48 | 276.8 | 17.4 | 0.072 | +10.34 |
| 2026-08-11 | 23 | 91.6 | 16.7 | 0.197 | −2.63 |
| 2026-08-13 | 47 | 215.0 | 17.2 | 0.315 | −14.16 |
| 2026-08-14 | 67 | 371.2 | 17.3 | 0.167 | +0.75 |
| 2026-08-15 | 46 | 290.6 | 17.3 | 0.245 | −7.09 |

### The kill is on DIRECTION, not power — third worked example of the pattern

The hypothesis staked that the sold longshot side (15-19¢) is overpriced and should win materially
LESS than its price. In-sample it won **0.114 vs ~0.165 priced** (5.1pp favorable). Forward,
contract-weighted, it won **0.2004 vs ~0.172 priced** — **2.9pp UNFAVORABLE**, the opposite sign.
6 of 9 forward days ran hot (sideWon above the day's own priced ask), including four days
(08-06/07/09/13) at 32-36% against a ~17¢ ask — roughly double the priced rate — with no shared bad
ticker or settlement anomaly behind them (checked: the two largest single-position losses, both
sideWon=1.0 outlier props, land on 08-14 and 08-15, days that were NOT among the four worst by rate;
the inversion is broad-based across the window, not a couple of outlier settlements dragging the mean).

Killed on day 9 of an 8-day floor — after the pre-registered minimum sample was already met, ahead of
the 2026-08-20 calendar checkpoint. A discretionary stop-risk kill under the early-kill bar set at the
`hrr-7074` kill ("an early kill needs a DIRECTION across multiple days, not one bad slate") — this one
clears that bar with room: multiple non-adjacent days independently show the same-sign inversion, and
three of four substantive criteria fail, not just one.

Third mechanism inversion after `f5total-5054` and `hrr-7074`. Re-entry record now **0-for-8**
across all pre-registered cells that have reached a terminal PASS/KILL verdict.
