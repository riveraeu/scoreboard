# Pre-registration — MLB f5total 25-29¢ (2026-08-10)

Written and committed **before** any forward day exists. The criteria below are fixed as of
2026-08-10 and cannot be changed after seeing the forward result. The in-sample window runs through
2026-08-09; the forward window opens 2026-08-10, so this file predates every day it is tested on.
Moving any threshold post-hoc voids the pre-registration.

## Why this cell, and why it gets a forward test rather than a verdict

The 2026-08-09 morning `robustCandidates` tripwire surfaced `mlb|f5total|25-29` among the 17 cells
clearing the strict structural bar (`ROBUST_BAR` {minDays:8, minFills:50, maxTopDayShare:0.35}) —
`reliable` (day-clustered CI already excludes zero, positive side), 77 fills over 10 days, CI-lo
+3.65¢. This is the fifth cluster registered from the 8/09 board (alongside the WNBA totalPoints,
WNBA spread, and MLB spread clusters). The companion `mlb|f5spread|25-29` was evaluated and not
registered — its CI-lo (+1.16¢) was too thin and its two consecutive bad days (8/5, 8/6) reflected
real multi-day variance rather than a correlated single-slate event.

Multiplicity note: 17 cells cleared the bar on the 8/09 board. This is the 12th cell to receive a
pre-registration from that board. The forward test is what separates a real effect from draws on a
noisy grid.

## Hypothesis (stated before the forward data exists)

Selling positions priced **25-29¢** in Kalshi's MLB first-5-innings total market earns positive
per-contract PnL because **F5 total markets systematically overprice the longshot side** — the
same money-line-anchoring mechanism proposed for full-game MLB spreads (docs/MAKER_MLB_SP_PREREG.md)
applied to the F5 half-game slice. F5 prices derive from full-game lines; the overpricing of the
underdog/tail side propagates into F5 pricing as well.

Directional prediction: the sold (longshot) side should win materially **less** than its ~27¢ price
implies. The mechanism requires sideWon well below the band's avg ask.

## In-sample evidence (2026-07-10 → 2026-08-09, NOT part of the test)

77 fills, 506.4 contracts, 10 days, avg ask ~27¢:
- **+12.07¢/contract**, day-clustered CI **[+3.65, +20.48]**.
- **9 of 10 days positive**; topDayShare 0.23.
- sideWon by day: 0.136, 0, **1.000** (7/31), 0.260, 0, 0.162, 0, 0, 0, 0.250.
- **Fill-weighted aggregate sideWon ≈ 0.166** vs the ~27¢ price implied.

**7/31 tail event**: 1 fill, 3 contracts, sideWon = 1.000 → −73¢/ct. The sold side resolved 100%
against the maker. Tiny in dollar terms (3 contracts) and responsible for widening the CI-lo from
what would otherwise be a cleaner interval. F5 total markets can settle completely in one direction
when a team scores heavily in the first 5 innings — this is a named structural tail risk, not a
data artifact. It appears once in 10 days on 1 fill; the forward window will test whether it
recurs at a rate that offsets the otherwise positive signal.

Outside the 7/31 outlier: 9 days with sideWon 0–0.260, and 7 of those 9 have sideWon ≤ 0.162 —
consistently below the ~27¢ price.

In-sample only. Not evidence to bet on.

## Forward window

- **Out-of-sample = `game_date >= 2026-08-10`** (the first day fully after the in-sample set).
- **Checkpoint: 2026-08-24** (~2 weeks / ~13 MLB slate days).
- Evaluate with:
  `GET /api/shadow-report?makerCell=mlb|f5total|25-29&since=2026-08-10` (ADMIN)
  → read `totals.{perContract, ciLo, ciHi, days, fills, positiveDays}` and per-day `sideWon`.

Power note: this band fills ~7-8 per day, so ≥50 fills arrives in ~7 forward days — tight to the
≥8-day floor. The sample gate may bind at the checkpoint; the extend rule handles it.

## GREEN criteria — ALL must hold on the forward window (fixed 2026-08-10)

1. Forward day-clustered CI **lower bound > 0** (t-adjusted).
2. Forward mean **≥ +5¢/contract**.
3. **Positive on ≥ 60%** of forward days.
4. Forward **sideWon < 0.22** (in-sample 0.166; ~0.054 headroom; stays well below ~27¢ avg ask —
   requires the longshot cover rate to remain materially below the implied probability even when
   occasional full-resolver days like 7/31 occur).
5. Minimum sample: **≥ 8 forward days AND ≥ 50 forward fills.**
6. **No anomaly flag** on the cell.

## KILL / EXTEND rules

- Any of criteria 1-4 or 6 fails at the checkpoint → **KILL.** Do not re-slice, do not move a
  threshold, do not "give it two more weeks." A failed forward test is the answer.
- **Only** criterion 5 (insufficient sample) unmet, with 1-4/6 otherwise trending pass → **extend
  once** to 2026-09-07, then decide.

## What GREEN triggers — real money, scoped and small first

A clean forward pass satisfies the `REENTRY.md` re-entry bar for this cell and flips the
`AWAITING_VALIDATED_EDGE` posture **for this cell only**. GREEN triggers:

1. **Un-shelve V2** (`SHELVED = true` → false in `api/lib/maker-live.js`) and **re-scope it to
   this cell** — MLB F5 total markets, longshot side, fill_ask ∈ [25,29]. A deliberate code change,
   authorized by this document.
2. **Size small** per the standing bankroll doctrine — ⅛-Kelly at the low end (start near the $30
   fallback), not the $500 cap.
3. The real-money trial is **itself the final test**. Scale toward the cap **only** if the trial
   reproduces the edge on real fills.

In one line: **green light = start real money, scoped to this cell and sized small; the trial is
the last confirmation, not a formality.**

## Immutability

Criteria, window, and green-light action are fixed as of 2026-08-10. The forward test is the only
thing standing between "looks green" and "is real," so the rule that evaluates it must not be
adjustable after the fact.

## RESULT — KILLED EARLY 2026-08-17 (day 5 of the 8-day floor, fill floor already met)

**Forward** (`game_date >= 2026-08-10`, 5 days / 69 fills — fill floor cleared, day floor is not)
— 0 of 5 substantive criteria met: mean **−16.67¢/ct** (bar ≥+5) · day-clustered CI **[−46.25,
+12.91]** (bar lo>0) · 2 of 5 days positive (bar ≥60%) · **sideWon 0.4369** (bar <0.22).

Per-day:

| day | fills | contracts | avgAsk | sideWon | ¢/ct |
|---|---|---|---|---|---|
| 2026-08-10 | 14 | 110.0 | 27.3 | 0.455 | −18.18 |
| 2026-08-13 | 10 | 80.0 | 27.3 | 0.500 | −22.88 |
| 2026-08-14 | 20 | 125.3 | 26.8 | **0.840** | −57.13 |
| 2026-08-15 | 4 | 40.0 | 27.0 | 0.250 | +2.00 |
| 2026-08-16 | 21 | 175.9 | 26.9 | 0.152 | +11.69 |

### Direction, not power — fourth worked example

The hypothesis staked that the sold longshot side (25-29¢) is overpriced and should win materially
**less** than its price. In-sample it won **0.166 vs ~27¢ priced** (10.4pp favorable). Forward,
contract-weighted, it won **0.4369 vs ~27¢ priced** — **16.7pp UNFAVORABLE**, the opposite sign and
the largest single-cell inversion of the four kills to date. Three of the five forward days
(08-10, 08-13, 08-14) ran the sold side at 0.455-0.840 — well above even the in-sample tail event
(7/31, sideWon=1.0 on 1 fill) that was already named as a structural risk in the original doc.
08-14 alone (125 contracts, sideWon 0.84) is the single largest-volume day in the window and it is
the worst one — this is not a thin outlier riding on a tiny fill, the way the in-sample 7/31 event
was.

Killed on day 5 of an 8-day floor, but the 50-fill sample floor was already cleared (69 fills) two
days in. Per the early-kill bar set at the `hrr-7074` kill ("a DIRECTION across multiple days, not
one bad slate"): 3 of 5 days independently show the same-sign inversion, including the two
highest-volume days in the window, and all 5 of 5 substantive criteria fail — the clearest case of
the two killed today.

Fourth mechanism inversion after `f5total-5054`, `hrr-7074`, and `ks-1519` — and the second one
(after `f5total-5054`) to invert on the SAME hypothesis family (F5 markets, ML-anchor longshot
overpricing) that the `mlbsp`/`mlbf5sp` cluster still shares. Re-entry record now **0-for-10**.
