# Live trial — sub-50 one-sided quoting, `wnba|points` + `mlb|f5total|10-14` (2026-08-24)

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
