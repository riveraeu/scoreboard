# Re-entry conditions — what would justify betting again

Written 2026-07-28 (the day the last open strategy closed), for whoever next thinks the numbers look interesting — including a future me — to read **before** any work starts. The failure mode it exists to prevent has already happened six times: re-slicing the same days along a new dimension until something clears a threshold, then acting on it. Every one looked like a finding at the time.

---

## What is established

Five strategy families, each with its own data, each closed:

| family | the claim | verdict |
|---|---|---|
| **taker** | our model predicts better than the price | 57 categories, 0 with Brier-skill CI-lo > 0 at n≥100. Gate empty since 2026-07-18. |
| **maker** | we capture the vig on the favorite ask | No fillable edge. Six hypotheses, six dissolutions. |
| **cross-venue** | Kalshi and Polymarket disagree exploitably | Killed 2026-07-04, execution edge 0. |
| **lead-lag** | we see the sharp-book move before Kalshi | Killed 2026-07-04, Kalshi tracks de-vigged Pinnacle to ~1¢. |
| **path** | we exploit price movement before settlement | Killed 2026-07-28, negative at every exit threshold. |

For a single-venue binary-contract dataset that taxonomy is close to exhaustive: any strategy is some version of predict-better, capture-spread, arb-across-venues, exploit-lead-lag, or exploit-the-path.

**The vig "edge" was an artifact (corrected 2026-07-29).** The "+1.5-1.6¢ across 100k+ segments" reading came from the shadow maker's simulated fills, and `replayFills` matched taker trades to the WRONG side for the engine's whole life (`t.taker_side === s.quote_side`; the taker who fills a resting offer is on the OPPOSITE side). Rebuilt over all 10 days the V1 book is **−1.02¢/contract** — it flipped sign. What still stands: the independent n=44.5k pooled calibration did find the favorite ask sits above realized frequency, but that is the market's spread against a *taker*, and the maker rebuild shows capturing it doesn't survive adverse selection to a fill. The one untainted money figure agrees — V2 real orders made **+$6.65 on 361 fills** (~zero), graded straight off Kalshi settlement. **Conclusion:** Kalshi prices the sports we model at least as well as we do, the spread takes what's left on the taker side, and the maker side has no demonstrated edge. **Method lesson:** the maker "edge" survived six dissolutions because every measurement ran through the same wrong-side simulator (and three unit tests pinned the same wrong convention). A cross-check that keeps disagreeing (V2 real ≈ 0 vs V1 paper +1.5¢) is a bug report, not two populations.

---

## What does NOT justify re-opening

Each has already produced a finding that dissolved. Recognising the shape is the point.

- **A new slice of the same days** — a different price band, near/far cut, bucket boundary, per-category/per-sport breakout. Slicing is **0-for-6**.
- **A number that clears the fill-level CI.** Every fill-level interval on this book crossed zero once clustered on the DAY. Read `dayClustered`, never `weighted`, never `need`.
- **A high win rate.** Take-profit rules raise win rate while moving the mean the wrong way. Win rate is not evidence.
- **A result carried by one or two days.** This signature appeared in the aggregate PnL, the band ladder, the adverse-selection metric, and the lead-time test. Check the day-level series before the aggregate, every time.
- **Positive Brier skill alone.** Brier skill is not bettable ROI.
- **"More data will fix it."** Invoked for the maker book and wrong: days, not fills, were the binding constraint, and the tape backfill built to supply days failed its own validation.

---

## What WOULD justify re-opening

Both require **new data**, not new analysis of the existing dataset. That is the dividing line.

**1. A new market class with real books** — not a new stat family in a league already modelled, a class nobody prices well. Required before any modelling: real two-sided books (bid-ask within `CAPTURE_MAX_SPREAD`, overround `avgMarket × sides` ≈ 1 — thin ≠ exploitable; the dead-book artifacts `totalBases` 94¢ and segment overround manufactured up to +0.39 of fake Brier skill); a resolvable settlement source (Kalshi settlement grading removed the ESPN dependency, unblocking the KBO/NPB/CFL class); and enough volume to matter at the size actually traded. **The natural catalyst is NFL in September** — the vetted-but-unbuilt `KXNFLTSPEC` bundle (~14 stat families), liquid books, a season never measured here.

**2. A model change with a stated mechanism** — not a correction found by searching residuals, a mechanism named in advance that predicts *where* and *in which direction* the model should improve. The two measured calibration defects (`mlb|hrr` underconfident 20pp at n=365, `lmb|ml` 15.8pp at n=116) are the only leads of this shape — and fixing them plausibly moves skill from slightly negative to ~0, not to profit.

---

## The method any re-entry must use

Each exists because its absence produced a wrong answer here.

1. **Pre-register** — hypothesis, metric, decision rule committed **before** the computing code exists. `docs/MAKER_LEADTIME_PREREG.md` is the worked example.
2. **Cluster on the day** — fills/picks/segments within a day share one slate. Day-clustering widened one interval 4.5× back across zero.
3. **Split out of sample** — in-sample discovered windows are upward-biased by construction; a PROMOTE verdict is a screen, not a decision.
4. **Check the price mix before comparing two populations** — edge swings ±7¢ across bands, so two populations at different average prices differ mostly by mix. This Simpson's shape has bitten three times.
5. **Verify the estimator with a known-answer test** — the adverse-selection diagnostic was wrong twice while it was untested inline SQL.
6. **Read the completeness flags before any headline number** — `chunksFailed`, `incomplete`, `guessedDateRows`. A tripwire once reported a clean `disagree: 0` purely because it had failed to look.

---

## What is still running, and why

Kept because it is what makes any future claim testable rather than a hunch:

- **Shadow logging** (`shadow-snapshot`, `shadow-pregame-snap`, `shadow-resolver`) — the measurement instrument; settlement-authoritative for the 14 shadow-only sports. Also captures `polymarket_plays` inline (the cross-venue vig substrate, rebuilt 2026-08-04 — quote+outcome capture, not a re-opened strategy).
- **`kalshi-series-scan`** — the only sensor pointed at condition #1.
- **`shadow-report`** — the daily readout.
- **V1 maker quoting + nightly tape replay + grading** — free (the snapshot cron already holds the books). Tape replay was switched off 7/28 then **re-enabled 2026-07-29**: it is the only thing that writes `maker_fills`, and a cold instrument going into the NFL catalyst is worse than the ~600 fetches/night it costs. Instruments stay running; only the actions stopped.

Removed rather than kept: **`push/notify`** (deleted with the taker teardown 2026-07-30 — endpoints + web-push + sw.js gone) and the **`polymarket-scan` cron** (schedule dropped; the endpoint is still reachable with `ADMIN_KEY`).

---

## The honest prior

Six weeks of increasingly careful measurement found no edge, and caught **three separate false "ARM CRITERION MET" readings** that would have put real money on noise. That is the return: not a strategy, but a set of instruments trustworthy enough to say no with confidence. Expect the answer to be no again. Re-open only when something on this page is actually satisfied — and if it is, the instruments are all still here.
