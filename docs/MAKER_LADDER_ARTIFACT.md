# The band-ladder artifact — why a lit sub-50¢ maker cell is usually not an edge (2026-08-11)

Written 2026-08-11 while scoping a pre-registration for `mlb totalRuns 20-39`. The doc that scoping
produced is this one instead: the four cells turned out to be the winning half of a two-sided book
that nets slightly negative, and the same structure explains most of the `robustCandidates` board.

This is a **screen**, not a verdict on any individual cell. It gives `robustCandidates` the
denominator it has never had.

## The mechanism of the artifact

Since 2026-07-29 the V1 paper engine quotes **both sides** of every market across
`MAKER_FULL_BAND = [1,97]` (`api/lib/config.js`). Before that it quoted only the favorite
(`MAKER_BAND = [55,97]`), so no fill data existed below ~50¢. The heatmap's `band` is the
`f.fill_ask` bucket (`_makerBandCase` in `api/lib/handlers/shadow/report.js`), which means:

- **sub-50 bands = underdog-side sells**
- **50+ bands = favorite-side sells**
- **of the same markets.**

For a maker selling at price `p`, per-contract PnL is mechanically `p − 100 × sideWon`. So a cell's
`perContract` is not an independent measurement — it is a restatement of how far that band's realized
frequency sits from its price. Read down a category's ladder and you are reading one curve.

## The signature: mlb|totalRuns, 2026-07-12 → 2026-08-10

| band | sideWon | ¢/ct | | band | sideWon | ¢/ct |
|---|---|---|---|---|---|---|
| 0-4 | 0.000 | +3.55 | | 45-49 | 0.455 | +1.07 |
| 5-9 | 0.053 | +1.75 | | 50-54 | 0.571 | −4.46 |
| 10-14 | 0.075 | +4.59 | | 55-59 | 0.683 | −11.16 |
| 15-19 | 0.072 | +9.96 | | 60-64 | 0.706 | −8.44 |
| 20-24 | 0.130 | +8.82 | | 65-69 | 0.769 | −9.92 |
| 25-29 | 0.175 | +9.67 | | 70-74 | 0.798 | −7.86 |
| 30-34 | 0.236 | +8.47 | | 75-79 | 0.846 | −7.46 |
| 35-39 | 0.274 | +9.47 | | 80-84 | 0.903 | −8.47 |
| 40-44 | 0.312 | +10.60 | | 90-96 | 0.949 | −2.03 |

Check the arithmetic: 20-24 → 22 − 13.0 = +9.0 (reported +8.82). 80-84 → 82 − 90.3 = −8.3 (reported
−8.47). The curve is monotone in price and crosses zero at ~45-50¢.

**Contracts-weighted, the whole book is −0.28¢/ct**: sub-50 earns +148,367¢ over 18,960 contracts,
50+ loses −159,894¢ over 22,463. Seven bands clear the `ROBUST_BAR`; the book they live in loses money.

"Longshots are overpriced" and "favorites are underpriced" are the same sentence — **favorite–longshot
bias**, one statement, measured twice from opposite sides. Slicing to the half where the sign is
favorable is exactly the in-sample target-picker `docs/REENTRY.md` has gone 0-for-6 on.

## It is not a per-category mechanism

Contracts-weighted ¢/ct by half, all categories above 3,000 contracts:

| category | sub-50 | 50+ | **whole book** |
|---|---|---|---|
| wnba\|totalPoints | +17.93 | −12.43 | +2.75 |
| wnba\|spread | +13.91 | −14.11 | **−1.77** |
| mlb\|f3ml | +9.54 | −3.22 | **−2.34** |
| mlb\|spread | +8.85 | −10.12 | **−4.46** |
| mlb\|totalRuns | +7.83 | −7.12 | **−0.28** |
| argprem\|total | +3.50 | −6.50 | **−3.05** |
| wnba\|points | +2.65 | +5.19 | +4.16 |
| mlb\|f5total | +1.88 | +0.45 | +0.94 |
| mlb\|f5spread | +1.76 | −1.91 | **−1.25** |
| mlb\|strikeouts | +1.62 | +0.17 | +0.58 |
| mlb\|totalBases | +1.12 | −2.10 | **−1.65** |
| mlb\|outs | −0.02 | −2.34 | **−1.34** |
| wnba\|assists | −0.18 | +2.23 | +1.13 |
| wnba\|threePointers | −1.04 | +6.41 | +3.77 |
| mlb\|hrr | −1.27 | −1.63 | **−1.50** |
| mlb\|f5ml | −1.92 | −4.24 | **−3.80** |
| mlb\|teamRuns | −1.95 | −0.28 | **−0.70** |
| mlb\|hits | −2.14 | −1.19 | **−1.51** |
| wnba\|rebounds | −3.61 | −4.36 | **−4.05** |
| mlb\|f7ml | −8.88 | +0.69 | **−1.67** |
| tennis\|match | −7.97 | +4.03 | **−1.76** |

**`mlb|f3ml` is the case that settles it.** First-3-innings moneyline has no thresholds and no run
distribution — the "extreme tail overpricing" story that `docs/MAKER_TOTALRUNS_PREREG.md` articulates
*cannot apply to it*. It shows +9.54 / −3.22 anyway. The premium tracks price level, not any
category's mechanism.

This also contradicts the prior recorded in the `MAKER_FULL_BAND` comment ("the n=44.5k pooled scan
says longshot asks are ~fair; expect ~0 edge down there") — but it contradicts it *uniformly across
every book*, which reads as structure in the measurement, not as a discovery in any one market.

## The netting screen

Before a sub-50 cell earns a pre-registration, it must answer: **is the category's whole book positive
once both halves are pooled contracts-weighted?**

- **Whole book ≤ 0 with mirrored halves** → the cell is the ladder artifact. No prereg.
- **Whole book > 0** → something survives pooling. A prereg may be warranted, but the mechanism must
  explain why *this band* and not the price level.
- **Cell on the same side as the winning half of a book that is positive on BOTH halves** → cleanest
  case; the ladder does not explain it.
- **Cell's sign is opposite the artifact direction** (a lit 50+ cell in a book whose 50+ half wins) →
  the artifact predicts the opposite, so the ladder is not the explanation.

This screen is cheap, runs entirely off `makerBoard.categoryBands`, and needs no forward day.

## Audit of the 15 live pre-registrations (2026-08-11)

Applying the screen to `PREREG_CELLS` as it stands. **No thresholds are changed by this document** —
those are immutable once written, and a screen applied after the fact cannot retire a forward test.
This records what each cell will have to overcome, so the checkpoint reading is honest.

| id | cell | cell ¢/ct | sub-50 | 50+ | whole | screen |
|---|---|---|---|---|---|---|
| totalruns-1519 | mlb\|totalRuns\|15-19 | +9.96 | +7.83 | −7.12 | −0.28 | **ARTIFACT** |
| wnbasp-1014 | wnba\|spread\|10-14 | +10.11 | +13.91 | −14.11 | −1.77 | **ARTIFACT** |
| wnbasp-1519 | wnba\|spread\|15-19 | +10.70 | +13.91 | −14.11 | −1.77 | **ARTIFACT** |
| wnbasp-2024 | wnba\|spread\|20-24 | +19.02 | +13.91 | −14.11 | −1.77 | **ARTIFACT** |
| mlbsp-2529 | mlb\|spread\|25-29 | +14.12 | +8.85 | −10.12 | −4.46 | **ARTIFACT** |
| mlbsp-3539 | mlb\|spread\|35-39 | +14.30 | +8.85 | −10.12 | −4.46 | **ARTIFACT** |
| mlbf5sp-2529 | mlb\|f5spread\|25-29 | +10.61 | +1.76 | −1.91 | −1.25 | **ARTIFACT** |
| wnbatp-1519 | wnba\|totalPoints\|15-19 | +16.62 | +17.93 | −12.43 | +2.75 | MIRRORED, net + |
| wnbatp-2024 | wnba\|totalPoints\|20-24 | +18.00 | +17.93 | −12.43 | +2.75 | MIRRORED, net + |
| wnbatp-2529 | wnba\|totalPoints\|25-29 | +23.35 | +17.93 | −12.43 | +2.75 | MIRRORED, net + |
| wnbatp-3034 | wnba\|totalPoints\|30-34 | +22.03 | +17.93 | −12.43 | +2.75 | MIRRORED, net + |
| ks-1519 | mlb\|strikeouts\|15-19 | +4.22 | +1.62 | +0.17 | +0.58 | CLEAN |
| mlbf5t-2529 | mlb\|f5total\|25-29 | +2.84 | +1.88 | +0.45 | +0.94 | CLEAN |
| wnba3p-6064 | wnba\|threePointers\|60-64 | +29.97 | −1.04 | +6.41 | +3.77 | CLEAN (inverted) |
| hrr-7074 | mlb\|hrr\|70-74 | +6.50 | −1.27 | −1.63 | −1.50 | ISLAND |

Three findings worth stating plainly:

1. **Seven of fifteen cells sit on books that lose money when both halves are pooled.** The three
   `wnbasp` cells and the two `mlbsp` cells are near-perfect mirrors (+13.91/−14.11, +8.85/−10.12).
   These are the ones the ladder most fully explains. Note the two clusters are **all-must-pass**, so
   a mirrored book weighs on the cluster, not just the cell.
2. **`wnba3p-6064` is the only cell whose direction is opposite the artifact** — it sits at 60-64¢ in
   a book whose 50+ half is the winning half (+6.41) and whose sub-50 half loses (−1.04). The ladder
   predicts the reverse, so it survives this screen most convincingly. It is also the highest ¢/ct on
   the board (+29.97) on the thinnest sample (55 fills), so sample-thinness, not the ladder, is its
   binding risk.
3. **`hrr-7074` fails differently.** Its book loses on *both* halves (−1.27 / −1.63, whole −1.50), so
   the ladder does not explain it — it is a lone +6.50 island in a uniformly negative category, which
   is the ordinary 1-in-N multiplicity story. Its forward window independently agrees: −8.73¢/ct over
   6 days with `sideWon` 0.801 against a 0.60 bar.

`ks-1519` and `mlbf5t-2529` are the two cells whose books are positive on both halves. They are also
the two lowest in-sample ¢/ct on the list (+4.22, +2.84) — which is the point: the screen removes the
cells whose size came from the price level, and what is left is small.

## What this changes

- **No pre-registration for `mlb totalRuns 20-39`.** The cells are real numbers and a false mechanism;
  30-34 and 35-39 are near-coinflips, not tails, and show the same premium as 15-19.
- **`robustCandidates` should be read through this screen** before any cell is promoted. Of the 19
  hits on the 2026-08-11 board, the uncovered ones (`mlb|totalRuns` 20-39, `wnba|totalPoints|40-44`,
  `wnba|spread|25-29`, `mlb|totalRuns|0-4`) all sit on mirrored or negative books.
- **The open question the ladder does NOT answer** is whether the sub-50 premium survives *one-sided*
  quoting. Pooling both halves is the right screen for "is this cell an independent edge"; it is not
  the same question as "would quoting only the underdog side make money," because a one-sided book
  changes fill dynamics and adverse selection. That question deserves its own pre-registration,
  scoped across categories rather than to one band, with the netting criterion built into its GREEN
  bar. It is not registered here.

## Method note

Every number above is contracts-weighted from `makerBoard.categoryBands` in
`/api/shadow-report?bust=1` (report window `since` 2026-07-12, generated 2026-08-11T14:10Z, 710 cells,
283,265 quote segments over 41 days, avgAsk 51.8). Regenerate rather than hand-editing; the halves are
`band` split at 50 and pooled as `Σ(perContract × contracts) / Σ(contracts)`.

## Addendum — the anomaly detector was the same mistake (2026-08-11)

The heatmap's anomaly flag ran the identical error and was fixed the same day. Its test was
`tail = (1−p)^fills < 0.001` with `p` = the band midpoint — i.e. its null was **price equals realized
frequency**, exactly what this document falsifies. Consequences:

- **6 of 6 flagged cells were false positives.** Each sat within 0.07 of its own ladder while sitting
  0.12–0.28 from its price. They were the tops and bottoms of steep ladders, nothing more.
- **It could not see the bug it was named for.** It only evaluated cells whose `sideWon` was *exactly*
  0 or 1. A wrong-side fill does not pin an outcome, it INVERTS one — a 15-19¢ cell grading ~0.85
  where ~0.07 belongs. That is a colossal departure from the ladder and the old test never looked.
- Two unit bugs alongside: `sideWon` is contract-weighted but the tail used `fills` as its binomial n,
  and there was no day-clustering at all.

Replaced by `ladderAnomalies` (`api/lib/maker-stats.js`): the null is now the category's own monotone
price→outcome curve (weighted isotonic fit, leave-one-out), and a cell flags when its residual is
significant against the **combined** day-clustered uncertainty of cell *and* reference, and exceeds a
0.15 practical floor. A category-level check catches the wholesale side-flip that per-cell testing
structurally cannot see. Validated by replaying 13 days of real per-day data: **43 flags** with the
reference treated as exact and no day-variance → **27** with real day-variance → **14** once the
reference's own uncertainty was propagated. Every reduction came from fixing a real statistical error;
none came from moving a threshold.

**The redefinition and the pre-registrations.** `anomaly` appears as documentary criterion 6 in 11
`docs/MAKER_*_PREREG.md` files ("No anomaly flag on the cell"). It is **not** machine-enforced —
`evaluatePrereg` runs five checks and `maker-prereg.js` never reads the field — so no running forward
test changes behaviour, and no threshold in any pre-registration moved. But the *meaning* of criterion
6 did change mid-flight, and that is recorded here rather than by editing 11 immutable documents. One
consequence worth stating: `wnba|totalPoints|15-19`, the flagged cell behind live prereg
`wnbatp-1519`, is **not** anomalous under the corrected test — its `sideWon` of 0 is the smooth
continuation of its neighbours (0 at 10-14, 0.041 at 20-24), never a grading fault.
