# Pre-registration — mlb hrr 70-74¢ maker cell (2026-08-05)

> ## ☠️ OUTCOME: **KILLED 2026-08-11** — hypothesis INVERTED. Do not re-open.
>
> Removed from `PREREG_CELLS`. Everything below this box is the original pre-registration, preserved
> **unedited** — it is the record of what was committed before the forward window, and editing it
> after the fact would destroy the only thing that made the test worth running. The result is
> appended at the end of the file, never merged into the criteria.



Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-05 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-04; the forward window opens 2026-08-05, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-05 morning `robustCandidates` tripwire surfaced `mlb hrr 70-74` as the **only** cell on
the category × band heatmap to clear the strict structural bar (`ROBUST_BAR` {minDays:8, minFills:50,
maxTopDayShare:0.35}) — `reliable` (day-clustered CI already excludes zero, positive side), 66 fills
over 10 days, top-day share 0.25. Expected output of that tripwire is NONE; one hit is exactly what a
grid of ~555 noisy cells produces at a one-sided 95% bar (~1/40 clear zero with zero true edge). The
bar is **not** multiplicity-corrected.

So the in-sample number cannot be acted on — that is the in-sample target-picker the REENTRY doctrine
has gone 0-for-6 on. What CAN resolve it is a **forward test on days that do not yet exist**, with a
mechanism and a decision rule fixed in advance. This file is that mechanism and that bar. It follows
`docs/MAKER_F5TOTAL_PREREG.md` exactly in form (that cell was clean in-sample and inverted forward —
the standing reminder that robustness is necessary, not sufficient).

## Hypothesis (stated before the forward data exists)

Selling the **favorite side** of MLB Hits+Runs+RBIs player props (`KXMLBHRR`, the NO side) when the
favorite ask is **70-74¢** earns positive per-contract PnL, because the market **overprices that
favorite side**. Directional, mechanistic prediction: the sold (favorite) side should win materially
**less** than its ~72% price implies.

The mechanism story here is weaker than f5total's coinflip-overpricing one — a player-prop favorite
priced 70-74¢ overshooting by ~20 points is a large claim, and HRR settlement depends on line
placement this file cannot audit. That weakness is a reason to hold the forward bar strictly, not to
soften it.

## In-sample evidence (2026-07-21 → 2026-08-04, NOT part of the test)

- **+20.29¢/contract**, 66 fills, 472.3 contracts, **10 days**.
- Weighted **sideWon ≈ 0.52** vs the ~0.72 price implied — the mechanism, present in-sample
  (sold favorite wins ~20 points less than priced; avg fill ask ~72.3¢).
- Day-clustered CI (t-adjusted) **[+4.39, +36.18]** — clears zero.
- **6 of 10 days positive**; top-day share 0.25 (not one-slate). Reliable, no anomaly flag.
- **Volume is recent-heavy**: 8/03 + 8/04 alone are 29 of 66 fills and carry the two lowest sideWon
  days (0.254, 0.412). The single-fill days (7/21, 7/24, 7/29) are all-or-nothing noise. This is the
  brightest of a noisy grid — treat every in-sample statistic as descriptive, not evidence to bet on.

Clean shape by the structural bar. Still 1-of-~555. In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-05`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-19** (~2 weeks / ~14 MLB slates).
- Evaluate with exactly:
  `GET /api/shadow-report?makerCell=mlb|hrr|70-74&since=2026-08-05` (ADMIN) → read
  `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and the per-day `sideWon`.

Power note (stated up front, not an escape hatch): ~14 forward days at this cell's fill rate resolves
an effect of the in-sample size (+20¢) decisively. A genuinely marginal effect (say +5) would be
borderline at this n — which is **why criterion 2 sets a +5 floor**: an edge too small to confirm in
two weeks is also too small to be worth real money once variance drag and adverse selection are paid.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-05)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted, the same interval the report computes).
2. Forward mean **≥ +5¢/contract** (a floor, not just "positive" — must clear variance drag + fees +
   expected adverse selection to be worth capital).
3. **Positive on ≥ 60%** of forward days (consistency — not one slate carrying it).
4. Forward **sideWon < 0.60** (the *mechanism* must persist — the sold ~72¢ favorite keeps
   underperforming its price by a material margin, not just PnL landing positive by luck of
   magnitude). Set at 0.60 rather than f5total's 0.45 because this cell's favorite is priced ~72%,
   not a coinflip: 0.60 is ~12 points below price, still well short of fair, consistent with the
   in-sample ~0.52.
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell. (Criteria 1-5 are the five checks `evaluatePrereg` enforces;
   robustCandidates already excludes anomaly-flagged cells by construction, so this is a re-check at
   the checkpoint, not an independent gate.)

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not widen the
  band, do not move a threshold, do not "give it another two weeks to recover." A failed forward
  test is the answer.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to a single further checkpoint (2026-09-02), then decide. Sample-thinness is the one reason
  to wait; a criterion failure never is.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell, and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**. It does NOT mean bet full size on day one,
because the shadow's fills are **counterfactual** — `replayFills` assumes we win the queue and cannot
measure the one thing that decides a real maker's fate: whether a resting 70-74¢ HRR order actually
fills at the shadow rate, and whether the flow that hits it is informed (adverse selection). That is
measurable only with real capital. So GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to this
   cell only** — `KXMLBHRR`, favorite (NO) side, fill_ask ∈ [70,74] — not the current
   `MAKER_V2_BAND [80,84]`. A deliberate code change, authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end (start near the $30
   fallback, a few contracts per order), not the $500 cap.
3. The real-money trial is **itself the final test**: it measures real fill rate + adverse selection
   over its own window. Scale toward the cap **only** if the trial reproduces the edge on real fills.
   If real fills underperform the shadow — the standing risk with a resting maker — the trial kills
   it before size scales.

In one line: **green light = start real money, scoped to this cell and sized small; the trial is the
last confirmation, not a formality.**

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-05. This cell got here by being the
one cell of ~555 to clear a structural bar; the forward test is the only thing standing between
"looks green" and "is real," so the rule that evaluates it must not be adjustable after the fact.

---

# RESULT — KILLED 2026-08-11 (appended after the fact; nothing above was edited)

Killed on day **6 of the 8-day sample floor**, before the 2026-08-19 checkpoint. A discretionary
stop-risk kill, the same call as `f5total-5054` on 2026-08-03 — the doc's KILL rule is written for the
checkpoint, so stopping early is a deviation, and it is recorded as one rather than dressed up as a
checkpoint verdict.

## Forward result (`game_date >= 2026-08-05`, read exactly as §"Forward window" specifies)

`GET /api/shadow-report?makerCell=mlb|hrr|70-74&since=2026-08-05`

| | forward | criterion | met |
|---|---|---|---|
| mean ¢/contract | **−8.73** | ≥ +5 | ✗ |
| day-clustered CI | **[−19.91, +2.44]** | lo > 0 | ✗ |
| positive days | **1 of 6 (17%)** | ≥ 60% | ✗ |
| **sideWon** | **0.801** | < 0.60 | ✗ |
| sample | 6d / 71 fills | ≥ 8d & ≥ 50 | ✗ |

Per-day: `08-05` −27.5¢ (sideWon 1.00) · `08-06` −28.0¢ (1.00) · `08-07` **+5.94¢** (0.656) ·
`08-08` −28.95¢ (1.00) · `08-09` −6.26¢ (0.769) · `08-10` −8.53¢ (0.800). Avg ask held ~70.6-72.3¢
throughout, so the cell was quoting the intended price the whole window.

## Why this is a kill and not "wait for the sample floor"

**The mechanism inverted.** §Hypothesis staked a directional claim: the sold ~72¢ favorite should win
**materially less** than its price. In-sample it did — 0.52 against 0.72 priced, 20 points below.
Forward it won **0.801 against ~71.7¢ priced, ~8 points ABOVE**. Three of the six days ran sideWon
exactly 1.0.

That is not an underpowered version of the hypothesis, it is the opposite sign. Selling this favorite
is the losing side of the trade, and no amount of additional sample makes the pre-registered direction
correct. §KILL/EXTEND allows a single extension **only** when criterion 5 alone is unmet with 1-4
otherwise trending pass; here 1-4 all fail, so the extension clause explicitly does not apply.

§Hypothesis also flagged in advance that this mechanism story was the weak one — "a player-prop
favorite priced 70-74¢ overshooting by ~20 points is a large claim" — and said that weakness was a
reason to hold the bar strictly. Held.

## What this cell cost, and what it bought

Nothing in capital: `AWAITING_VALIDATED_EDGE` held throughout, V2 stayed `SHELVED`, and no real order
was ever placed on it. What it bought is the **second worked example** of the standing lesson, now
demonstrated rather than argued: `hrr|70-74` was the **only** cell of ~555 to clear the strict
structural bar on the 8/05 tripwire, with a +20.29¢/ct in-sample point estimate and a day-clustered CI
of [+4.39, +36.18] — and it still inverted forward. Robustness is necessary, not sufficient. The
`robustCandidates` tripwire is doing its job when it produces a candidate that dies here; that is the
forward test working, not the tripwire failing.

Re-entry record: **0-for-7**.
