# Pre-registration — maker lead-time hypothesis (2026-07-28)

The pre-registration (hypothesis, metric, decision rule) was committed **before** the code that computes it and before any lead-time number was seen — the integrity of that lives in the git history (this commit predates the result commit), not in the current file state. Kept as the worked example REENTRY.md cites: a mechanism stated in advance, tested once, with no partial credit. It differs from the [six dissolved maker findings](REENTRY.md) in exactly one way — it makes a directional prediction in advance rather than searching the same ~9 days for a pattern — which is the only reason it earned one test.

## Hypothesis
**H1.** A resting maker quote is adversely selected in proportion to its time at risk — a quote rested 14h before first pitch sees far more information arrival than one rested 30 min before, so seller edge should **decline as lead time increases**. **H0.** Seller edge is unrelated to lead time. Directional prediction fixed in advance: **near-dated quotes outperform far-dated ones.**

## Metric & data
Seller edge = `avgAsk − 100·sideWonRate` (mean of `pnl_cents = fill_ask − 100·side_won`), contract-weighted. Lead time measured at the **fill** (`lead_h = game_time − traded_at`) — when the position is actually taken on. Data: `maker_fills ⋈ maker_quotes`, **`source='live'` only** (replayed segments excluded), graded fills, `game_time IS NOT NULL`, all series. No backfill needed.

## Decision rule — all three must pass
Buckets `0-1h / 1-3h / 3-6h / 6-12h / 12h+`; primary contrast **near (<3h)** vs **far (≥6h)** (3–6h is a buffer, excluded from the contrast, kept for monotonicity). **Mix adjustment mandatory** — edge swings ±7¢ across price bands and this board has been bitten by Simpson's paradox three times, so near-vs-far is computed **within band** (`_makerBandCase`) and re-weighted onto a common contract distribution; the raw contrast is reported but is not the test.

1. **PRIMARY (day-clustered).** Mix-adjusted (near − far) per day, mean across days, se = sd/√m; the 95% CI must lie **entirely above zero**. Day is the cluster unit (fills within a day share one slate).
2. **COHERENCE.** Daily difference positive in **≥7 of 9** days (a result carried by one or two days is what killed the previous findings).
3. **MONOTONICITY.** Spearman ρ between bucket order and bucket edge **≤ −0.5**.

**Inconclusive** if fewer than 6 days yield a computable difference. **Any single criterion failing kills the hypothesis** — no partial credit, no "gather more data", no re-slicing on a different boundary. If it *passes* it is a strategy change (restrict V2 to the near window), needing its own validation before capital — not an arm signal.

---

# RESULT — 2026-07-28: **H1 REJECTED** (all three failed)

14,161 graded live fills across 8 usable days (7/19 dropped: 33 fills, no band with both arms). `/api/shadow-report?makerLeadTime=1`.

| bucket | fills | contracts | avgAsk | sideWon | edge |
|---|---|---|---|---|---|
| 0-1h | 3,564 | 24,311 | 69.26 | 0.680 | +1.30¢ |
| 1-3h | 3,352 | 22,717 | 69.33 | 0.674 | +1.93¢ |
| 3-6h | 3,207 | 19,830 | 70.46 | 0.688 | +1.66¢ |
| 6-12h | 2,591 | 15,422 | 68.49 | 0.685 | 0.00¢ |
| 12h+ | 1,447 | 9,249 | 68.64 | 0.643 | +4.35¢ |

| criterion | required | actual | |
|---|---|---|---|
| PRIMARY | day-clustered CI > 0 | mean +1.93, se 1.54, CI [−1.08, +4.95] | ✗ |
| COHERENCE | ≥7 of 9 days positive | 4 of 8 | ✗ |
| MONOTONICITY | Spearman ρ ≤ −0.5 | ρ = +0.30 | ✗ |

Unadjusted near−far: **−0.03¢** (near +1.60, far +1.63).

**Reading.** No lead-time effect — the unadjusted contrast (−0.03¢) is absent, not small, and Spearman +0.30 is the wrong sign (if anything the *farthest* bucket is best, the opposite of H1). Not confounded: avgAsk spans only 68.49–70.46 (<2¢), so the mix adjustment mattered little — a trustworthy null, not a Simpson's artifact. The +1.93¢ mix-adjusted mean is a **two-day artifact** — daily differences −2.34, −0.76, −0.35, **+6.04**, **+10.48**, +2.98, −0.93, +0.34; strip 7/23 and 7/24 and it is flat-to-negative (the same two-days-carry-everything signature seen in the aggregate PnL, band ladder, and adverse-selection metric; 7/24 is also the day whose live +8.05¢ didn't reproduce under replay). It also retires the finding that motivated the test — the replay's indicative ~−5¢ for early fills was a coverage-mismatch artifact, not visible in the live book's own lead-time structure.

**Consequence, per the rule.** No partial credit, no re-slicing. **The maker measurement program is finished** — the decision is shelve-vs-arm-small on the evidence already in hand (→ shelved, see REENTRY.md / INFRA.md § Maker V2).
