# Pre-registration — maker lead-time hypothesis (2026-07-28)

Written and committed **before** the code that computes it, and before any lead-time number has
been looked at. The point of this file is that the decision rule cannot be adjusted after seeing
the result.

## Why this test exists, and why it gets exactly one shot

Five separate maker "findings" have now dissolved under better measurement: the 7/21 ARM-MET
reading (grading bugs), "the edge lives only in 80-84" (post-fix bands alternate sign), adverse
selection at ~1.4¢ (broken settlement fetch + mix-confounded population → +0.51¢ and band-
incoherent, and it inverted), the aggregate fill CI (day-clustering widened it 4.5× back across
zero), and 7/24's +8.05¢ (a fuller replay of the same markets gives −0.01¢).

The common failure mode is re-slicing the same ~9 days along a new dimension until something looks
significant. This hypothesis is worth one test **only** because it differs from those five in one
respect: it is a mechanism stated in advance that makes a directional prediction, not a pattern
found by searching.

## Hypothesis

**H1.** A resting maker quote is adversely selected in proportion to its time at risk. A quote
rested 14 hours before first pitch is exposed to far more information arrival than one rested 30
minutes before, so the seller's realized edge should **decline as lead time increases**.

**H0.** Seller edge is unrelated to lead time.

Directional prediction fixed in advance: **near-dated quotes outperform far-dated ones.**

## Metric

Seller edge in cents per contract, contract-weighted:

    edge = avgAsk − 100 · sideWonRate      (equivalently, mean of pnl_cents = fill_ask − 100·side_won)

Lead time is measured at the **fill**, not the quote: `lead_h = game_time − traded_at`. The fill is
when the position is actually taken on, which is what the mechanism is about.

## Data

- `maker_fills` joined to `maker_quotes`, **`source = 'live'` only** — the replayed segments are
  unvalidated and excluded. This test needs no backfill; `traded_at` and `game_time` are already
  stored for all 9 live days and 14,974 fills.
- Graded fills only (`graded_at IS NOT NULL`), `game_time IS NOT NULL`.
- All series, not just the MLB props the backfill is scoped to.

## Buckets

`0-1h`, `1-3h`, `3-6h`, `6-12h`, `12h+` by lead time. For the primary contrast:
**near = lead < 3h**, **far = lead ≥ 6h**. The 3–6h band is deliberately excluded from the contrast
(it is a buffer, not a data cut) but is reported and used in the monotonicity check.

## Mix adjustment — mandatory

Seller edge swings by ±7¢ across price bands, and this board has been bitten by Simpson's paradox
three times. Any near-vs-far difference must therefore be computed **within price band** (the
existing `_makerBandCase`) and re-weighted onto a common pooled contract distribution. A raw
unadjusted comparison is reported alongside for transparency but is **not** the test.

## Decision rule — all three must pass

1. **PRIMARY — day-clustered.** Compute the mix-adjusted (near − far) difference per day; take the
   mean across days with se = sd/√m. The 95% CI must lie **entirely above zero**. The day is the
   cluster unit for the same reason it is in `armCriterion`: fills within a day share one slate.
2. **COHERENCE.** The sign of the daily difference must be positive in **≥7 of 9** days. A result
   carried by one or two days is exactly what killed the previous five findings.
3. **MONOTONICITY.** Spearman ρ between bucket order (increasing lead time) and bucket seller edge
   must be **≤ −0.5** across the five buckets.

**Inconclusive** (not a pass) if fewer than 6 days yield a computable mix-adjusted difference.

**Any single criterion failing kills the hypothesis.** There is no partial credit, no "promising,
gather more data", and no re-slicing on a different bucket boundary afterwards. If H1 fails, the
maker measurement program is finished and the decision is shelve-vs-arm-small on the evidence
already in hand.

## If it passes

It is a strategy change, not an arm signal: restrict V2 quoting to the near window. That would need
its own validation before any capital, since the arm gate is unchanged by this test.

---

# RESULT — 2026-07-28: **H1 REJECTED** (all three criteria failed)

Run against 14,161 graded live fills across 8 usable days (7/19 drops: 33 fills, no band with both
arms). `/api/shadow-report?makerLeadTime=1`.

## Seller edge by lead time

| bucket | fills | contracts | avgAsk | sideWon | **edge** |
|---|---|---|---|---|---|
| 0-1h | 3,564 | 24,311 | 69.26 | 0.680 | **+1.30¢** |
| 1-3h | 3,352 | 22,717 | 69.33 | 0.674 | **+1.93¢** |
| 3-6h | 3,207 | 19,830 | 70.46 | 0.688 | **+1.66¢** |
| 6-12h | 2,591 | 15,422 | 68.49 | 0.685 | **0.00¢** |
| 12h+ | 1,447 | 9,249 | 68.64 | 0.643 | **+4.35¢** |

## Criteria

| | required | actual | |
|---|---|---|---|
| PRIMARY | day-clustered CI > 0 | mean +1.93, se 1.54, **CI [−1.08, +4.95]** | ✗ |
| COHERENCE | ≥7 of 9 days positive | **4 of 8** | ✗ |
| MONOTONICITY | Spearman ρ ≤ −0.5 | **ρ = +0.30** | ✗ |

Unadjusted near−far: **−0.03¢** (near +1.60, far +1.63).

## Reading

**There is no lead-time effect.** The unadjusted contrast is −0.03¢ — not a small effect, an absent
one. Spearman is +0.30, the wrong sign: if anything the farthest bucket is the best, which is the
direct opposite of the mechanism H1 proposed.

**The test was not confounded.** avgAsk across the five buckets spans 68.49–70.46 — under 2¢. The
mix adjustment mattered little here, which is what makes the null trustworthy rather than
ambiguous: this is not a Simpson's artifact hiding a real effect.

**The mix-adjusted mean of +1.93¢ is a two-day artifact.** Daily: −2.34, −0.76, −0.35, **+6.04**,
**+10.48**, +2.98, −0.93, +0.34. Strip 7/23 and 7/24 and it is flat-to-negative. That is the same
two-days-carry-everything signature that has now appeared in the aggregate PnL, the band ladder,
and the adverse-selection metric. 7/24 is also the day whose live +8.05¢ did not reproduce under
the tape replay.

**It also retires the finding that motivated the test.** The replay's indicative arithmetic (early
fills winning ~79.3%, so ~−5¢) is not visible in the live book's own lead-time structure. That
inference was an artifact of the replay's coverage mismatch, not evidence of a lead-time effect.

## Consequence, per the rule written above

No partial credit and no re-slicing on different boundaries. **The maker measurement program is
finished.** The decision is shelve-vs-arm-small on the evidence already in hand.
