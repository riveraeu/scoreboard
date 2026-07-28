# Re-entry conditions — what would justify betting again

Written 2026-07-28, the day the last open strategy was closed. Its purpose is to be read by whoever
next thinks the numbers look interesting — including a future me — **before** any work starts.

The failure mode this exists to prevent is specific and has already happened six times: re-slicing
the same days along a new dimension until something clears a threshold, then acting on it. Every
one of those six looked like a finding at the time.

---

## What is established

Five strategy families, each with its own data, each closed:

| family | the claim | verdict |
|---|---|---|
| **taker** | our model predicts better than the price | 57 categories, **0 with Brier skill CI-lo > 0** at n≥100. Gate empty since 2026-07-18. |
| **maker** | we capture the vig on the favorite ask | No fillable edge. Six hypotheses, six dissolutions. |
| **cross-venue** | Kalshi and Polymarket disagree exploitably | Killed 2026-07-04, execution edge 0. |
| **lead-lag** | we see the sharp-book move before Kalshi | Killed 2026-07-04, Kalshi tracks de-vigged Pinnacle to ~1¢. |
| **path** | we exploit price movement before settlement | Killed 2026-07-28, negative at every exit threshold. |

For a single-venue binary-contract dataset that taxonomy is close to exhaustive. Any strategy is
some version of predict-better, capture-spread, arb-across-venues, exploit-lead-lag, or
exploit-the-path.

**The one finding that has replicated every time**: the vig sits on the favorite ask (+1.5-1.6¢
across 100k+ segments, and in the original n=44.5k pooled calibration). It has **never** been shown
to survive to a fill. Sold side wins within 0.04pp of the price sold at, reproduced independently by
a tape replay.

**Conclusion**: Kalshi prices the sports we model at least as well as we do, and the spread takes
what is left.

---

## What does NOT justify re-opening

Each of these has already produced a finding that dissolved. Recognising the shape is the point.

- **A new slice of the same days.** A different price band, a different near/far cut, a new bucket
  boundary, a per-category or per-sport breakout. Slicing is **0-for-6**.
- **A number that clears a threshold on the fill-level CI.** Every fill-level interval on this book
  crossed zero once clustered on the DAY. Read `dayClustered`, never `weighted`, never `need`.
- **A high win rate.** Take-profit and similar rules raise the win rate while moving the mean the
  wrong way. Win rate is not evidence.
- **A strong result carried by one or two days.** This signature appeared in the aggregate PnL, the
  band ladder, the adverse-selection metric, and the lead-time test. Check the day-level series
  before the aggregate, every time.
- **Positive Brier skill alone.** Brier skill is not bettable ROI; that distinction has its own
  history here.
- **"More data will fix it."** It was invoked for the maker book and was wrong: days, not fills,
  were the binding constraint, and the tape backfill built to supply days failed its own validation.

---

## What WOULD justify re-opening

Both of these require **new data**, not new analysis of the existing dataset. That is the dividing
line.

### 1. A new market class with real books

Not a new stat family in a league already modelled — a class nobody is pricing well. Required
before any modelling work:

- **Real two-sided books.** Bid-ask within `CAPTURE_MAX_SPREAD`, and overround (`avgMarket × sides`)
  ≈ 1. Thin is not the same as exploitable: the dead-book artifacts (`totalBases` 94¢, segment
  overround) manufactured up to +0.39 of fake Brier skill. Illiquidity is where the traps live, not
  where free money lives.
- **A resolvable settlement source.** Kalshi settlement grading removed the ESPN dependency, which
  is what unblocks the KBO/NPB/CFL class.
- **Enough volume to matter** at the size actually traded.

**The natural catalyst is NFL in September** — new market types (the vetted-but-unbuilt
`KXNFLTSPEC` bundle, ~14 stat families), liquid books, and a season never measured here.

### 2. A model change with a stated mechanism

Not a correction discovered by searching residuals — a mechanism named in advance that predicts
*where* and *in which direction* the model should improve. The two measured calibration defects
(`mlb|hrr` underconfident by 20pp at n=365, `lmb|ml` by 15.8pp at n=116) are the only leads of this
shape on the board, and note that fixing them plausibly moves skill from slightly negative to ~0,
not to profit.

---

## The method any re-entry must use

These are not optional, and each exists because its absence produced a wrong answer here.

1. **Pre-register.** Hypothesis, metric, and decision rule committed **before** the computing code
   exists. `docs/MAKER_LEADTIME_PREREG.md` is the worked example — it turned what would have been a
   seventh ambiguous slice into a clean null in one afternoon.
2. **Cluster on the day.** Fills, picks, and segments within a day share one slate. Day-clustering
   widened one interval 4.5× and moved it back across zero.
3. **Split out of sample.** In-sample discovered windows are upward-biased by construction; the
   `bettingBoard` PROMOTE verdict is a screen, not a decision.
4. **Check the price mix before comparing two populations.** Edge swings ±7¢ across bands, so any
   two populations at different average prices differ mostly by mix. This Simpson's shape has bitten
   this board three times.
5. **Verify the estimator with a test that has a known answer.** The adverse-selection diagnostic
   was wrong twice while it was untested inline SQL.
6. **Read the completeness flags before any headline number** — `chunksFailed`, `incomplete`,
   `guessedDateRows`. A tripwire reported a clean `disagree: 0` purely because it had failed to look.

---

## What is still running, and why

Kept deliberately, because it is what makes any future claim testable rather than a hunch:

- **shadow logging** (`shadow-snapshot`, `shadow-pregame-snap`, `shadow-resolver`) — the measurement
  instrument. Settlement-authoritative for the 14 shadow-only sports.
- **`kalshi-series-scan`** — the only sensor pointed at condition #1 above.
- **`shadow-report`** — the daily readout.
- **V1 maker quoting** — free (the snapshot cron already holds the books), and it keeps measuring
  the one effect that is real.

Switched off 2026-07-28 because it could not act:

- **maker V1 tape replay** — ~600 Kalshi fetches/night with no consumer once V2 was shelved.
- **`push/notify`** (4 crons) — filtered through an empty category gate; could not send.
- **`polymarket-scan`** — wrote `polymarket_sports_seen`, which nothing reads, for a venue killed
  2026-07-04.

All three endpoints still exist and are reachable with `ADMIN_KEY`. Only the schedules were removed,
so re-enabling any of them is a `vercel.json` edit, not a rebuild.

---

## The honest prior

Six weeks of increasingly careful measurement found no edge, and caught **three separate false
"ARM CRITERION MET" readings** that would have put real money on noise. That is the return on this
work: not a strategy, but a set of instruments trustworthy enough to say no with confidence.

Expect the answer to be no again. Re-open only when something on this page is actually satisfied —
and if it is, the instruments are all still here.
