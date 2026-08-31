# Live trial — sub-50 one-sided quoting, `wnba|points` + `mlb|f5total|10-14` (2026-08-24)

## Bug 2026-08-31: `wnba-points` placed ZERO real orders for its entire post-8/27 ledger — cell-matching picked by array order, not band

Found during a daily-report follow-up (not the screenshot-vs-API method that caught the prior
three bugs): five of the trial's seven groups had gone quiet for several days, two of them
(`wnbasp-onesided`, `mlb-hrr-negctrl`) with literally zero fills since inception on 8/26. Cross-
checking `wnbasp-onesided`'s and `mlb-hrr-negctrl`'s bands against the passive shadow capture
(`wnba|spread|20-24`: 245 fills/21 days; `mlb|hrr|30-34`: 339 fills/23 days — both liquid, real
markets) ruled out "the market is just thin" for those two, but didn't explain the pattern on its
own. Reading the actual matching code did: `matchLiveCell` (`api/lib/maker-live.js`) selected a
`MAKER_V2_LIVE_CELLS` entry by `sport`+`category` alone via `cells.find(...)`, returning the FIRST
array match — never checking band. `wnbapts-1014` (`band [10,14]`) was added to the array ahead of
`wnba-points`'s two entries (`[20,24]`, `[25,29]`) on 2026-08-27 (see § Addition 2026-08-27 below).
From that commit forward, EVERY `wnba|points` staging row — regardless of its actual price —
resolved to `wnbapts-1014`'s cell, so `computeMakerQuote(m, row, nowMs, [10,14], true)` ran against
every wnba-points row including 20-29¢ asks, which fail the `[10,14]` band check and are silently
dropped. Confirmed directly by calling `matchLiveCell` against the live production config: it
returned `wnbapts-1014` for a synthetic `{sport:"wnba", stat:"points"}` row unconditionally.
Cross-checked against real fill history (`/api/kalshi-fills`, 200-fill account history back to
7/23): every `KXWNBAPTS` fill in the window fell in the pre-8/27 price range (20-23¢, the group's
OLD pre-halt band), none since — `wnba-points`'s 8/27 "re-arm" (§ Re-arm 2026-08-27 below) had
produced zero real trading evidence the entire time, silently.

**Not a capital-safety bug** — the opposite failure mode from the prior three (which overexposed
or misattributed real capital): this one just meant the group traded nothing, so no money was ever
at risk from it. But it means `wnba-points`' checkpoint clock should be read from **2026-08-31**
forward, not 8/27 — 4 days of the group's post-halt ledger produced no real signal at all.

**Fix** (`api/lib/maker-live.js`, commit `00481b4`): added `candidateLiveCells(row, cells)`,
returning EVERY cell matching a row's sport+category (not just the first). `computeWantedMakerQuotes`
now loops over all candidates for a row and picks whichever one's band actually contains the
market's ask, using the existing `computeMakerQuote` band gate directly rather than duplicating
that logic — so band disambiguation can never drift from the real eligibility check. `matchLiveCell`
stays exported as an explicitly non-band-aware convenience (first-candidate only) for the — still
common — case of a sport+category with exactly one live cell; a comment on it names this exact
incident as the reason it must never be used to disambiguate a multi-band category. 372/372 tests
pass, 2 new: one reproducing the 3-cell collision with synthetic cells, one running
`computeWantedMakerQuotes` against the **real, unmodified `MAKER_V2_LIVE_CELLS`** proving a 22¢
wnba-points row now resolves to `wnba-points`, not `wnbapts-1014`.

**This is the trial's 4th real-capital-adjacent bug** (after 8/24 exposure-cap basis, 8/25
expiration duty-cycle, 8/26 multi-piece-fill tracking) — every one found in the live-cell machinery
itself, not in a market read. Consistent with the trial's own "what each outcome changes" framing
(§ below): live execution infrastructure has proven harder to get right than the market question
it's trying to answer, four times running.

## Re-arm 2026-08-27: `wnba-points` (bands 20-24, 25-29) — re-armed at HALVED sizing

The § Incident re-arm criterion below ("a live order that fills in more than one piece must be
observed post-fix with `filled_count` correctly reflecting the full total") was met the same day
the fix deployed: the exact Johnson order that triggered the 2026-08-26 halt
(`KXWNBAPTS-26AUG26TORSEA-SEAFJOHNSON4-20`) now shows `filled_count: 25` (was the stale `4`),
corrected by the first post-fix `shadow-resolver` cron pass (`gradedAt: 2026-08-27T04:30:49Z`) —
confirmed by cross-checking `/api/maker-v2-board`'s `orders[]` against `/api/kalshi-fills`, the same
method that caught the original bug.

**Sizing decision**: re-armed at the **halved $15 cap / $7.50 stop-loss** (25 contracts/fill), not
restored to the pre-halt $30/$15. The 8/25 re-arm (after the 1st/2nd bugs) DID restore full size —
that precedent existed, but this group's own fill-tracking bug is exactly why the halving
discipline was introduced for every cell added since 8/26 (`mlb-hrr-negctrl`, `wnba3p-killdiag`,
`wnbasp-onesided`, `wnbapts-1014`). Re-arming this group at full size while every other live cell
sits at half would be inconsistent with that standing caution, and this group specifically is the
one that has now caused a real-capital bug — asked and confirmed with the user 2026-08-27 rather
than assumed.

Fresh ledger: `MAKER_V2_WNBA_POINTS_REARM = "2026-08-27"` (new `resumeFrom`, both bands) — the
pre-halt track record was earned at the old $30/$15 sizing and doesn't carry over cleanly to a
resized group, same reasoning as the 8/25 re-arm's fresh ledger for the exposure-cap-bug era.
`MAKER_V2_WNBA_POINTS_RESUME` (the 8/25 ledger-start constant) was already deleted with the halt;
this is a new constant, not a revival of that one.

Global cap unaffected: `MAKER_V2_GLOBAL_CAP_CENTS` stays $60, still binds against the new $120 sum
of all 7 groups' per-group caps. Pinned in `maker-live.test.js`. 367/367 tests pass, clean build.

## Addition 2026-08-27: `wnbapts-1014` — first cell to clear both free gates since the process change

Added via the 2026-08-26 process change (see § Expansion below): a cell clearing the structural
robustness bar AND the netting screen goes straight into a small live cell instead of a new
`docs/MAKER_*_PREREG.md` shadow forward test. This is the first cell added under that rule that is
**not diagnostic** — it is a normal candidate, tracked here rather than a new prereg doc.

**Gate 1 — structural robustness bar** (`ROBUST_BAR`, `robustCandidates`): `wnba|points|10-14`
crossed `ciLo > 0` for the first time in the 2026-08-27 daily report (+7.65¢/ct, CI
`[+0.39, +14.91]`, 133 fills / 16 days — up from CI `[-0.07,+14.98]` on 2026-08-26). Margin is thin.

**Gate 2 — netting screen** (`docs/MAKER_LADDER_ARTIFACT.md`, run 2026-08-27 off
`makerBoard.categoryBands`, `since:2026-07-28`): pooling the whole `wnba|points` ladder
contracts-weighted at the 50¢ split gives sub-50 **+1.41¢/ct** (10,125 ct), 50+ **+4.71¢/ct**
(12,182 ct), whole book **+3.21¢/ct** (22,307 ct) — both halves positive, the cleanest
classification in the ladder-artifact framework (not the mirrored price-level artifact). This is
the **same shape already measured 3 times** at this category's prior registrations
(`docs/MAKER_WNBA_PTS_PREREG.md` for `wnbapts-2529`: +1.81/+3.81/+2.97 as of 2026-08-16;
`docs/MAKER_WNBA_PTS8084_PREREG.md` for `wnbapts-8084`: +0.64/+4.82/+2.93 as of 2026-08-25) — the
category has now cleared this screen identically 4 times running. The ladder itself is
non-monotone/wiggly band-to-band (not a steep price curve), the signature the doc associates with
"no exploitable price-level offset."

**Mechanism** (same class as the sibling `wnbapts-*` cells, per `docs/MAKER_WNBA_PTS_PREREG.md`'s
hypothesis): Kalshi's individual-player-points threshold markets anchor on a coarser statistic
(season-average points per game) without adequately widening for game-to-game variance, so the
extreme-longshot side (a low-usage or role player scoring under 15) is systematically overpriced
on the NO side / underpriced on the YES ask. `10-14` extends this to the deepest longshot band
tested yet in this category (prior registrations covered `20-24`, `25-29`, and the favorite-side
`80-84`).

**Sizing**: `wnbapts-1014` group, `wnba|points|10-14`, 25 contracts/fill, **$15 cap / $7.50
stop-loss** (`MAKER_V2_WNBAPTS1014_START = "2026-08-27"`, `api/lib/config.js`) — the halved
discipline from the 2026-08-26 diagnostic cells, not the original $30/$15, because the live-cell
machinery itself has produced 3 real-capital bugs in 3 days (8/24 cap-basis, 8/25 duty-cycle, 8/26
fill-tracking) and hasn't gone a clean stretch at n>4 groups yet. Checkpoint
**2026-09-10** (`MAKER_V2_WNBAPTS1014_CHECKPOINT`, 2 weeks from `resumeFrom`) — unlike the
diagnostic cells, this one DOES gate a real allocation decision (whether to scale it toward the
standard $30/$15 sizing), so the no-extend-on-thin-sample discipline applies same as any other live
cell's checkpoint, not the diagnostics' relaxed one.

Pinned in `maker-live.test.js`: exact cell config, plus the existing global-cap invariant test
(sum of per-group caps rises to $90 with this addition; `MAKER_V2_GLOBAL_CAP_CENTS` stays $60,
still binding, no re-tune needed).

## Addition 2026-08-27 (second): `wnbareb-6569` — a re-screen, not a fresh find

`wnba|rebounds|65-69` was **rejected 2026-08-21** as an ISLAND (`docs/MAKER_LADDER_ARTIFACT.md`
class — the whole `rebounds` book lost money on both halves even excluding the candidate cell,
"ordinary multiplicity noise," no nameable mechanism). That rejection doc explicitly named its own
re-open condition: *"if it recurs with a materially different profile... that would be new
evidence worth re-screening, not a reason to ignore this entry."*

Re-screened 2026-08-27 as part of a full backlog scan across every category's whole-book netting
(prompted by the user asking whether new candidates were being discovered efficiently). The cell
still clears the robustness bar (ciLo +1.34, 85 fills/14 days, up from 82/13 on 8/21) — what
changed is the category shape:

| | 8/21 | 8/27 |
|---|---|---|
| 50+ half, excluding the candidate | −1.88¢/ct | **+2.80¢/ct** |
| Whole book, excluding candidate | −1.27¢/ct | **+0.08¢/ct** |

The sign flipped. This is no longer the ISLAND pattern — it's now a MIRROR whose favorite side
(where the candidate sits) genuinely wins on its own, with the candidate excluded. Same "inverted
mirror" shape that let `wnba3p-6064` survive the original 2026-08-11 screen and that
`wnbasp-onesided` already tests live: a 50+ cell in a book whose 50+ half independently wins is
NOT explained by the standard favorite-longshot-bias mirror (which predicts the opposite sign).

**Sizing**: `wnbareb-6569` group, `wnba|rebounds|65-69`, 25 contracts/fill, $15 cap / $7.50
stop-loss (`MAKER_V2_WNBAREB6569_START = "2026-08-27"`), same halved discipline as every cell
added since 8/26. Checkpoint **2026-09-10** (`MAKER_V2_WNBAREB6569_CHECKPOINT`).

Trial now at **8 groups**. Pinned in `maker-live.test.js`; global cap sum now $135, `$60` still
binds, no re-tune needed.

## Incident 2026-08-26: `wnba-points` HALTED — multi-piece fills silently understated exposure

Found via the same detection method as the 8/24 exposure-cap bug: a real Kalshi-app screenshot of
open positions checked against `/api/maker-v2-board`. Two `wnba-points` positions were open on the
TOR@SEA game — Flau'jae Johnson (20+ points, cost $19.25) and Dominique Malonga (25+ points, cost
$19.80) — summing to **$39.05 real dollars committed against a $30 group cap (~29% over)**, while
`/api/maker-v2-board` reported the group's tracked exposure at only $22.58. The cap check itself
never saw this — it enforces against `groupExposureCents`, which was reading a wrong number.

**Root cause, confirmed against Kalshi's own fills feed**: the Johnson order filled in two separate
pieces on Kalshi's side — 4.12 contracts at 16:01:32 UTC, then 20.88 more at 16:05:26 UTC, same
`order_id`, four minutes apart, 25 total. `updateLiveMakerOrders`' fill-poller (and
`reconcileLiveMakerFills`'s nightly counterpart) detected the FIRST partial fill, immediately
flipped the row to `'executed'` with `filled_count=4`, and **removed it from every future
fills-poll** (both call sites only ever re-checked rows still `status='resting'`). The second fill
— 84% of the position — landed on a Kalshi order our system had already stopped watching, and was
never applied. `groupExposureCents` correctly computes `(100-price) × filled_count`, but
`filled_count` itself was stale by ~21 contracts (~$16) on this one order.

**Fix** (`api/lib/maker-live.js`, both fill-polling sites): a matching order is now a candidate for
as long as `filled_count < size` and it isn't `canceled`, regardless of current status — an
`'executed'` row can still be short of its real total. `filled_count` is recomputed each poll as
the **sum of every matching fill event** seen in that poll's window (`reconciledFilledCount`, a
pure helper pinned directly in `maker-live.test.js` against the exact 4→25 incident numbers),
floored at whatever was already recorded and capped at the order's own size — never a single fill
event's own count overwriting the total. A 15-minute lookback (quote-pass) fully covers any one
order's fillable lifetime, since `MAKER_V2_EXPIRATION_SEC` (9 min) bounds how long an order can
receive fills before Kalshi auto-cancels the remainder.

**Response, in order**: (1) `wnba-points`' two cells were **removed from `MAKER_V2_LIVE_CELLS`
entirely** (not just capped to 0) — the existing open positions can't be un-filled, so this stops
NEW placements while leaving Johnson/Malonga to settle and grade normally (grading reads Kalshi's
own settlement cost directly, `fetchKalshiSettlements`, not our `filled_count` — so the PnL that
eventually posts for these two positions will be correct regardless of this bug; only the
mid-flight *exposure/cap* accounting was wrong). (2) The fix above shipped in the same commit.
(3) `MAKER_V2_GLOBAL_CAP_CENTS` was re-tuned $75→$60 — with `wnba-points`' $30 cap gone, the
remaining per-group caps sum to exactly $75, which would have made the portfolio backstop a no-op
(caught by its own invariant test failing). `wnba-points` gets a **new** `resumeFrom` when it's
re-added, not its old 2026-08-25 one — this incident's exposure shouldn't count toward whatever
ledger it resumes on. 365/365 tests pass.

**Re-arm criteria for `wnba-points`** (MET 2026-08-27, see § Re-arm 2026-08-27 above): a live order
that fills in more than one piece must be observed post-fix with `filled_count` correctly reflecting
the full total (cross-check `/api/maker-v2-board` against a Kalshi-app screenshot or
`/api/kalshi-fills` directly, same method that caught both this bug and the 8/24 one) before
re-adding its cells.

## Expansion 2026-08-26: three diagnostic cells + a global exposure cap

Added three more cells to `MAKER_V2_LIVE_CELLS`, each at half the standard sizing ($15 cap / $7.50
stop-loss vs. the original $30/$15), and a new portfolio-level backstop
(`MAKER_V2_GLOBAL_CAP_CENTS`, $75, `api/lib/maker-live.js`'s `totalExposureCents`) checked at
placement time alongside each group's own cap. None of the three was added because it looks
profitable — all three are diagnostic, testing the TRIAL MECHANISM itself rather than searching for
more edge:

- **`mlb-hrr-negctrl`** (`mlb|hrr|30-34`, $15 cap) — a **negative control**. The same-day netting
  screen (see the 2026-08-26 daily report memory) found this cell's sub-50 half confidently LOSES
  in shadow (−1.30¢/ct over 15,348 contracts, island pattern — book loses on both halves, same
  shape as the already-killed `hrr-7074`). It is expected to lose live too. If it does, that is
  real evidence the sim-vs-real fill-matching assumption (the same assumption that was silently
  wrong for years on V1's original vig read) holds for this mechanism. If it does NOT lose live,
  that is a materially bigger finding — it would mean live one-sided execution behaves differently
  enough from shadow's two-sided read that every prior promote/kill decision needs to be treated as
  less certain than it currently is.
- **`wnba3p-killdiag`** (`wnba|threePointers|60-64`, $15 cap) — an explicit, one-time **exception**
  to "killed cells are never re-added." `wnba3p-6064` inverted forward in shadow (+29.20¢/ct
  in-sample → CI-lo −2.85 at its 2026-08-24 checkpoint, see
  `docs/MAKER_WNBA_3P_PREREG.md`). Re-quoting it live at reduced size tests whether that inversion
  was a real mechanism failure or an artifact of shadow's fill assumption. **This does NOT reopen
  the shadow kill** — `wnba3p-6064` stays permanently absent from `PREREG_CELLS`
  (`maker-prereg.test.js`'s absence tripwire is unchanged), and this cell's result is tracked
  separately from that registry's promote/kill ledger so it can never be misread as "the kill was
  undone."
- **`wnbasp-onesided`** (`wnba|spread|20-24`, $15 cap) — tests the question
  `docs/MAKER_LADDER_ARTIFACT.md` explicitly left open: *"whether the sub-50 premium survives
  one-sided quoting."* `wnba|spread` is a near-perfect MIRROR book (sub-50 wins big, 50+ loses big,
  pooled whole-book nets ~zero — the `wnbasp` shadow-prereg cluster was killed on this basis). The
  sub-50 half alone still clears the robustness bar cleanly on its own (band 20-24: +16.36¢/ct, CI
  [10.19, 22.53], 19 days, `topDayShare` 0.14 as of 2026-08-26) — this cell tests whether that
  individually-clean reading is real when actually quoted one-sided for real, or whether it's a
  two-sided-pooling artifact that a real maker never has to net against (a real maker never has to
  also eat the losing 50+ half the way the pooled shadow measurement does).

All three cells use their own `resumeFrom` (`2026-08-26`, a fresh ledger — no prior history to
inherit) and are otherwise governed by the exact same mechanics as the original two cells
(self-expiring orders, `sellAsBuy`, per-group `haltedGroups`). Pinned in `maker-live.test.js`: each
cell's exact config, and a structural test that `MAKER_V2_GLOBAL_CAP_CENTS` stays below the summed
per-group caps (otherwise the portfolio backstop would be a no-op). 361/361 tests pass.

**Why sizing was halved rather than matched to the original two cells**: both real bugs found in
this trial so far (the 8.4x exposure-cap miscalculation, the 75%-duty-cycle expiration bug) were in
this exact live-cell machinery, discovered at n=2 groups. Adding cells at full size before that
machinery is proven at n>2 would multiply the blast radius of a third, not-yet-found bug in the
same class.

### Evaluation criteria (fixed 2026-08-26, before any of the three has a fill)

Checkpoint: **2026-09-09** (`MAKER_V2_DIAGNOSTIC_CHECKPOINT`, 2 weeks — matches the original trial's
cadence). Unlike a shadow prereg or the original two live cells, these three gate no
capital-allocation decision of their own — their sizing doesn't change based on the result, they
exist purely to produce information about the trial mechanism. So the no-extend discipline that
protects prereg checkpoints from re-slicing doesn't apply the same way here: if a cell's sample is
too thin to say anything at the checkpoint, it's fine to extend the window once rather than forcing
a premature read — extending doesn't bias any future bet, because there isn't one riding on it.
Fixed in advance anyway, so a real result can't be read whichever way is convenient after the fact:

| Cell | Expected result | CONFIRMS (what we already believe) | FLAGS a real problem |
|---|---|---|---|
| `mlb-hrr-negctrl` | Negative or flat | Realized PnL ≤ 0, or too few fills (<10) to conclude anything | Clearly positive: mean ≥ +3¢/ct across ≥10 fills |
| `wnba3p-killdiag` | Negative or flat (reconfirms the shadow kill) | Realized PnL ≤ 0, or too few fills (<10) to conclude anything | Clearly positive: mean ≥ +5¢/ct across ≥10 fills |
| `wnbasp-onesided` | Positive (tests whether the sub-50 half's shadow reading survives live) | Mean ≥ +5¢/ct across ≥10 fills | Flat or negative across ≥10 fills — would mean the individually-clean sub-50 reading does NOT survive one-sided execution |

A "FLAGS a real problem" result on either `mlb-hrr-negctrl` or `wnba3p-killdiag` is the same class of
finding either way: live one-sided execution is producing results the shadow simulation would not
have predicted, which means every prior promote/kill call made from shadow data alone should be
treated as less certain until the discrepancy is understood — not treated as "great, a new edge
found." A "FLAGS" result on `wnbasp-onesided` (i.e., it does NOT show the expected positive) answers
the open question from `docs/MAKER_LADDER_ARTIFACT.md` directly: the sub-50 premium in mirror books
does not survive one-sided quoting, closing that door for every other mirror-book category too
(`mlb|totalRuns`, `mlb|spread`, `wnbatp`), not just this one cell.

## Addendum 2026-08-25: `MAKER_V2_EXPIRATION_SEC` was stale, cutting fill opportunity ~75%

Cross-checked a `wnba-points` position from a Kalshi-app screenshot against `/api/maker-v2-board`'s
`orders` log: today's 8 quote attempts on the two eligible tickers (KIRIAFEN 20+, SCITRON 10+) had
6 expire with 0 fill and only 2 partial-fill (7/25 each). `MAKER_V2_EXPIRATION_SEC` was still 150s
(2.5min), sized for the `kalshi-snapshot` cron's ORIGINAL `*/2min` cadence — but that cron widened
to `*/10min` on 2026-08-17 (Neon compute-cost fix; unrelated decision at the time). Nobody re-tuned
the expiration to match, so each resting order lived 150s of every ~600s between requotes (~25%
duty cycle) and then sat unquoted — nothing on the book for a counterparty to hit — until the next
cron tick placed a replacement. Raised to 540s (9min, just under the cron interval) so an order
stays continuously resting between quote passes instead of going dark most of the cycle, while
staying bounded below the cron interval as the safety net it was always meant to be. This is a
mechanical fix, not evidence about the trial's edge — read future fill-rate readings against a
board that was actually quoting most of the time, not the ~25%-duty-cycle history above.

## Status: RE-ARMED 2026-08-25 — `mlb-f5total` continues its original window, `wnba-points` gets a fresh ledger

Pre-kill positions settled naturally (per the KILLED account below) before re-arming: `mlb-f5total`
realized **+$28.00** (never breached its stop-loss) and `wnba-points` realized **−$60.75** (4x its
own −$15 stop-loss, entirely accrued under the exposure-cap bug's oversized real positions). Both
groups showed `exposureCents: 0` at re-arm time — nothing left open.

`groupExposureCents`/`groupRealizedCents`/`haltedGroups` (`api/lib/maker-live.js`) had no time or
attempt scoping — they summed every historical graded row for a `live_group` forever. Under the
original code, re-arming as-is would have permanently halted `wnba-points` on its very first tick
(−$60.75 ≤ −$15 stop-loss, unconditionally, regardless of how much time had passed or how the fix
had already changed the cap math) — it would never place another order. Decided 2026-08-25: give
`wnba-points` a fresh ledger rather than leave it permanently retired on bug-era losses. Each cell
in `MAKER_V2_LIVE_CELLS` now carries its own `resumeFrom` date (`api/lib/config.js`); the three
group functions above filter rows to `game_date >= resumeFrom` before summing, per-group — see
`MAKER_V2_WNBA_POINTS_RESUME` ("2026-08-25", fresh ledger) vs. `MAKER_V2_TRIAL_START`
("2026-08-24", unchanged — `mlb-f5total` never breached its stop-loss so its original window
stays intact and its cumulative track record isn't discarded). `/api/maker-v2-board`'s `groups[]`
rollup query dropped its single global `WHERE game_date >= $1` bound (now fetches unfiltered and
relies on the same per-group-scoped pure functions `updateLiveMakerOrders` uses, so display and
live trading logic can't read different windows). Pinned in `maker-live.test.js` (2 new tests:
a pre-resumeFrom loss must not count toward a reset group's realized PnL/halt state, and pre-
resumeFrom resting exposure must not count either).

Re-armed via: `env.MAKER_V2_ARMED` set to `"true"` in Vercel production (was not `"true"` before
this), then `POST /api/maker-v2-arm`. `MAKER_V2_SHELVED` was already `false` (set 2026-08-24) and
the Kalshi trading-capable key pair was already present — neither blocked this re-arm.

## Prior status (2026-08-24): KILLED (exposure-cap bug, real capital ~5x intended caps)

Same day the trial went live, `groupExposureCents`/`costCents` (`api/lib/maker-live.js`) were found
to compute the per-group $30 cap off the SOLD side's price (`price`/`q.ask`), not the real dollar
cost of the complementary BUY order `sellAsBuy()` actually places (`100 − price`). Real capital
committed was `(100−price)/price` times the tracked figure — worse the cheaper the sold side,
which is exactly this trial's sub-50 target range. By the time this was caught (via a Kalshi
account-app screenshot vs. `/api/maker-v2-board` cross-check), real cost basis was **$60.84**
against a **$30** `wnba-points` cap (2x) and **$252.88** against a **$30** `mlb-f5total` cap
(8.4x) — total real exposure ~$313 vs. a combined $60 intended ceiling. Side/mechanism were
correct throughout (`sellAsBuy` executed as designed); only the safety-cap arithmetic was wrong.
Killed via `POST /api/maker-v2-kill` (0 orders were resting at kill time; both groups' positions
were already `executed`, left to settle naturally). Fix shipped same day (`100 − price` in both
`groupExposureCents` and the per-placement `costCents`); `maker-live.test.js` updated to match.
**Not re-armed as of this writing** — re-arming is a deliberate follow-up per the "Arming" section
below, now additionally conditioned on re-verifying `/api/maker-v2-board`'s `groups[].exposureCents`
against `/api/kalshi-balance`'s `makerCommittedCents` (which used the correct `100 − price` basis
throughout and was the tell) before trusting the cap again.

Written before this trial goes live. Unlike every other `docs/MAKER_*_PREREG.md` in this repo,
this is **not a shadow forward test** — it is a small REAL-money trial, entered deliberately
without a preceding shadow checkpoint, per an explicit 2026-08-24 decision to evaluate the
candidate cells on data already in hand rather than defer to another future shadow checkpoint.
That means the usual "in-sample vs. forward" split does not apply here the same way; what this
document fixes in advance instead is **what real trading is being asked to teach us**, and the
decision rule for each answer, so the result can't be read whichever way is convenient after the
fact.

## Why real money, not another shadow checkpoint

Three things shadow data cannot tell us, laid out before the trial starts so the outcome is judged
against them rather than against "did it make money":

1. **Whether the simulated fill/matching assumption is even correct.** This project's own history
   contains a case where it wasn't — `replayFills` matched the wrong side for V1's entire life,
   reading +1.5¢/ct in shadow while a real V2 trial returned ≈0 (`docs/REENTRY.md` § "The vig
   'edge' was an artifact"). The disagreement, not either number alone, is what caught the bug.
2. **Whether one-sided quoting changes who trades against you.** `docs/MAKER_LADDER_ARTIFACT.md`
   names this as the one question the netting screen cannot answer — shadow data is generated by
   watching a two-sided real market, not by being a one-sided participant in it.
3. **Real execution friction** — fees, partial fills, latency around game-time volume, whether the
   sizing below is even practically expressible in real order counts.

## Candidates and why these two

Selected from the full sub-50 breadth scan (2026-08-24, `makerBoard.categoryBands`, `since`
2026-07-25) as the only cells that are BOTH adequately sampled (excludes every 3-6 day/single-digit
to teens-fill cell — see the degenerate-day finding below) AND not explained by the favorite-
longshot mirror artifact:

| group | sport\|category\|band | whole-book ¢/ct (both halves pooled) | why not the mirror artifact |
|---|---|---|---|
| `wnba-points` | wnba\|points\|20-24 and 25-29 | **+3.48** | Sub-50 (+0.67) AND 50+ (+5.78) both positive — not a mirror. Never previously pre-registered. |
| `mlb-f5total` | mlb\|f5total\|10-14 | **+0.75** | Mildly positive pooled. Caution: the same category's 25-29 band (`mlbf5t-2529`) already failed forward with a large inversion (sideWon 0.4369 vs required <0.22, 2026-08-17) — this is a DIFFERENT band in the same category, so the mechanism being category-wide rather than band-specific is unverified, not confirmed. |

Every WNBA totalPoints/spread band tested this session (`wnbatp-*`, `wnbasp-*`) was excluded —
those clusters are ARTIFACT/MIRRORED-net-small by the netting screen and were independently killed
at their 2026-08-24 shadow checkpoint the same day this trial was scoped
(`docs/MAKER_WNBA_TP_PREREG.md`, `docs/MAKER_WNBA_SP_PREREG.md`). Betting them here would
contradict a verdict already on record from the same data. Every degenerate 3-6 day / single-digit-
to-teens-fill cell (`mlb|outs`, `mlb|teamRuns`, `mlb|totalBases`, `wnba|h1ml`, `wnba|h1spread`,
`wnba|q1ml`, `wnba|q1total`, `wnba|assists`) was excluded after checking actual per-day fill
history: the sparse dates are spread evenly across the whole capture window, not clustered at a
recent start — i.e. genuine market rarity, not a catching-up sample. At the observed rate
(~1 fill/8-9 days for `mlb|outs|25-29`) these cells would take months, not weeks, to reach a
trustworthy sample, so they are not "almost ready," they are structurally unsuited to this trial's
timeframe.

## Mechanism (stated before the trial, both cells one-sided/longshot-side only)

Selling ONLY the sub-50 (longshot) side of these two specific bands earns positive expected value
net of one-sided-quoting execution risk, because the underlying markets overprice this side and
that overpricing survives being a real, visible, one-sided resting order — not just a passive
observer of a two-sided book. **This trial never quotes the 50+ side of either category, by design
— that is exactly the condition shadow data could not evaluate.**

## Scope, sizing, and stop conditions (fixed 2026-08-24, `api/lib/config.js` `MAKER_V2_LIVE_CELLS`)

| | `wnba-points` | `mlb-f5total` |
|---|---|---|
| Bands | 20-24¢ and 25-29¢ | 10-14¢ |
| Contracts per order | 25 | 40 |
| Dollar cap (outstanding, not cumulative-ever) | $30 | $30 |
| Stop-loss (realized) | −$15 (50% of cap) | −$15 (50% of cap) |
| Ledger start (`resumeFrom`) | 2026-08-25 (reset — see Status) | 2026-08-24 (original, unchanged) |
| Checkpoint | 2026-09-07 (2 weeks) | 2026-09-07 (2 weeks) |

The dollar cap is **outstanding exposure**, not a one-shot budget — it is the cost basis of
everything not yet graded (resting + executed-but-ungraded) in that group at any instant, so
capital frees up and can be redeployed as positions settle across the 2-week window
(`groupExposureCents`, `api/lib/maker-live.js`). The stop-loss is **realized** PnL only
(`groupRealizedCents`) — a breach halts new placement for that group AND actively cancels its
resting orders (`haltedGroups`, checked every quote-pass tick), rather than waiting out the
2-week checkpoint. The two groups are independent: a `wnba-points` stop-loss does not touch
`mlb-f5total`, and vice versa.

Mechanics reused from the existing (previously-shelved) V2 engine unchanged: self-expiring resting
orders (`MAKER_V2_EXPIRATION_SEC`), the fail-closed `MAKER_V2_ARMED` env + KV double gate, the
`sellAsBuy` sell-as-complementary-buy translation (Kalshi has no sell-to-open), and
`MAKER_V2_MAX_CONCURRENT`/`MAKER_V2_SAME_GAME_CAP` as an additional correlation guard alongside
the new per-group dollar caps.

## What each outcome changes going forward

This is the actual point of the trial — read the result against this table, not just "did it make
money":

- **Real numbers land close to shadow-predicted `sideWon`/fill rate** (first time that's happened
  in this project) → the shadow simulator becomes trustworthy as a leading indicator; future
  candidates can lean more on a shadow checkpoint alone, live trials reserved for scaling rather
  than every validation.
- **Real `sideWon` comes in materially higher than shadow-predicted** → confirms the adverse-
  selection concern this trial exists to test; rules out one-sided quoting as a strategy class
  (not just these two cells), redirects effort to `docs/REENTRY.md`'s other open door (a new
  market class with real books — NFL, September).
- **Real fill rate is much lower than the shadow-simulated fill assumption** → every historical
  ¢/ct number in this project has been overstated by an unmeasured amount; forces a fill-rate
  discount into every future GREEN bar, not just this one.
- **Live and shadow disagree with no obvious mechanism** → treat as a measurement-pipeline bug
  report first, per the standing lesson from the `replayFills` wrong-side bug, before treating it
  as a market finding either way.
- **Stop-loss triggers before the checkpoint** → that group is done for this trial (not re-armed,
  not re-sliced); the OTHER group keeps running independently to its own checkpoint.

## Immutability

Scope, sizing, caps, stop-losses, and checkpoint are fixed as of 2026-08-24. A change to any of
them is a new trial (new doc), not an edit of this one — same discipline as every shadow
pre-registration in this repo.

## Arming — DONE 2026-08-25 (re-arm; original arming was 2026-08-24)

`MAKER_V2_SHELVED` is `false` (set 2026-08-24). Re-arm steps taken 2026-08-25:

1. Trading-capable Kalshi API key already present in `env` from the original 2026-08-24 arming.
2. `MAKER_V2_SHELVED` already `false`.
3. `env.MAKER_V2_ARMED` set to `"true"` in Vercel production (was not `"true"` after the 8/24 kill
   left the KV flag false — the env var itself was not `"true"` either at re-arm time; both needed
   setting).
4. `POST /api/maker-v2-arm`.

Before step 4, `/api/maker-v2-board`'s `groups[].exposureCents` was re-verified against
`/api/kalshi-balance`'s `makerCommittedCents` (both 0 — clean) per the exposure-cap-bug follow-up
requirement, and the `wnba-points` permanent-halt issue (see Status above) was fixed first.
