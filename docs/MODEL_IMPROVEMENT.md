# Model Improvement Workflow

How to turn accumulated calibration data into model changes — safely, in the right
layer, at the right sample size. This is the canonical loop; the daily-status checklist
lives in the `project-model-report-workflow` memory, gate on/off decisions in
`project-gate-recommender`, and the historical backtest in `project-backtest-roadmap`.
This doc ties them together and adds the part none of them cover: **deciding which layer
to correct, and when a new raw input is needed.**

---

## First principle: what you are actually optimizing

**Calibration is a means, not the goal. The goal is ROI vs. the market.** A model can be
perfectly calibrated (predicted prob = observed frequency) and still lose money, because
the **Kalshi price is itself a strong probability estimate** — often a better one than the
model. The only thing that converts to profit is *beating that price*. Calibration is
necessary (a miscalibrated model can't have reliable edge) but not sufficient.

- **The market is the baseline every category must beat.** Before treating a category as
  a source of edge, check the model against "just bet the market price." Benchmark
  **model-Brier vs. market-Brier** (and CLV) head-to-head. If the market's probability
  estimate scores better than the model's, you have *negative alpha* there regardless of
  how well-calibrated the model looks internally — don't gate it, and don't tune it as if
  calibration alone will rescue it.
  - *Worked example (HRR, 2026-06-13):* model 72.5% < market ~77% < actual 80.6%. HRR is
    roughly calibrated yet sits **below** the market — the market is the better estimator,
    so HRR has no YES edge despite positive raw band ROI. Calibration looked fine; the
    edge was negative. This is the failure mode this principle exists to catch.
- **Don't ignore the market as an input.** `_propBlend` shrinks toward season rate, not
  toward the market price. Where the market beats the model, a model⊕market blend is a
  free accuracy gain (standard ensembling). Consider it before adding new raw features.

Everything below optimizes calibration because it's the tractable, decomposable target —
but a calibration win that doesn't move model-vs-market Brier (or CLV) is not a real win.

---

## The correction ladder

A miscalibration is fixed at the **lowest layer that explains it**. Higher layers are
heavier (more code, more failure modes, harder to unwind), so you climb only when the
layer below can't close the residual.

| Layer | What it is | Where | Fix when… |
|---|---|---|---|
| **L0 — new raw feature** | a signal the model can't see | `mlb-hitters.js`, `nba.js`, … (build → hydrate → consume) | a coherent miss **survives L1–L5** and correlates with an unmodeled dimension |
| **L1 — input bias / shrinkage** | a feature that's systematically off, or noisy small samples | feature builders; priors (`N_PRIOR`, `PLAYOFF_PRIOR_N`, BvP N) | the **whole curve** is shifted, or a feature is volatile at low n |
| **L2 — input weight** | how hard a feature pushes the output | the logit/λ assembly (e.g. `props.js` HRR `0.25·log(opsAdj)`) | one feature is over/under-weighted **vs. what the market already prices** |
| **L3 — anchor / clamp** | league reference + influence bounds | `_LG_OPS`, `_LG_WHIP`, `Math.max/min` clamps | the **reference environment** drifted, or one feature swings the output too far |
| **L4 — variance / form** | distribution spread | `K_FORM_SIGMA`, `stdBF`, NegBin `r`, Normal `σ` | **tails bent, core calibrated** (too-tight = overconfident tails) |
| **L5 — output cap / blend** | post-hoc compression of the final truePct | sigmoid caps (HRR knee), `_propBlend`, regime blend | **whole curve over/under-confident** and you can't pin the cause |

**Diagnose by signature, not by guesswork:**
- whole curve shifted up/down → **L1** (input bias) or **L3** (anchor)
- tails overconfident, middle fine → **L4** (variance too tight) — *the K_FORM_SIGMA 0.22→0.26 case, 2026-06-13*
- one feature double-counts what the market sees → **L2** — *the HRR OPS 0.4→0.25 case, 2026-06-10*
- can't localize, whole curve bent → **L5** (cap), but treat it as a symptom-clipper of last resort
- residual won't close after L1–L5 → **L0**, a missing input (see below)

> ⚠️ L5/automatic correctors (Platt/XGB) were tested on the backtest and **rejected for
> live use** (P5, `project-backtest-roadmap`): the MC sims are already well-calibrated;
> global scaling creates thin-tail artifacts and can't fix non-linear miscalibration.
> Prefer the surgical lower-layer fix. XGB remains deferred (~2000+ market-priced
> rows/category, est. fall 2026).

---

## When is it signal? (sample-size gates)

Calibration noise on an observed hit rate is `SE = √(p(1−p)/n)`. Read deltas against it.

| Decision | Bar | Rationale |
|---|---|---|
| **Gate a category on/off** (display toggle, reversible) | `n≥50` cumulative + band coherence | cheap to be wrong; `tune:gate` `MIN_N_PROMOTE` |
| **Change a model formula** (sticky, affects every future prediction) | **`n≥200` per band + \|Δ\| > 2·SE + coherent across adjacent bands** | at n=200, ±6pt CI on p≈0.75; below that a single-band miss is usually noise |
| **Small deltas (2–3pt)** | `n≥500+` | CI too wide below that |

**Coherence pools n.** A same-direction miss across 3+ adjacent bands is trustworthy
sooner than one isolated band, because adjacency rules out luck. This is how HRR
(2026-06-10) and the K high-tail were diagnosed — patterns, not single bands.

**Always filter to the current-formula window.** Every formula change stamps a
`trackedAt` cutoff (see the long list in `MEMORY.md` "Model changes"). Evaluating a fix
against rows generated by the *superseded* formula is the single most common analysis
trap — e.g. HRR's full-history −6% ROI is pre-fix data; post-cutoff it's +1%.

**Rule out contamination** before acting: multi-threshold mixing (e.g. HRR 1+ vs 2+/3+
rows share a band but have different base rates), outlier micro-bands (n<10), and
stale-formula rows.

---

## Validate the fix: backtest vs. shadow

Two roads, picked by whether the lever is **historically reconstructable**.

- **Backtest-reconstructable** (pure formula params: `K_FORM_SIGMA`, NegBin `r`, σ,
  sigmoid knees in the backtest's own sim): sweep on the 571k-row MLB / 522k NBA / 49k
  NHL backtest *today* — no waiting on shadow accumulation. **Two non-negotiables to
  avoid overfitting the param to noise:**
  1. **Train/test split — mandatory.** Sweep the param on one set of seasons (e.g.
     2022–23) and pick the optimum that *also* wins on a **held-out** season (2024). Never
     select and evaluate on the same data — that's in-sample tuning and it fits the
     parameter to that season's noise. (P5's Platt corrector did this; follow it.)
  2. **Score with a proper scoring rule (Brier or log-loss), not just `|Δ|`.** Minimizing
     calibration error alone is *gameable by under-sharpening* — pushing every prediction
     toward 50% lowers `|Δ|` while destroying the discrimination you bet on. Brier
     decomposes into calibration **+** refinement, so it prices the
     **calibration/sharpness tradeoff** automatically. Report `|Δ|` per band for
     interpretation, but **select on Brier.** Confirm the optimum is a genuine minimum
     (U-shape) and the core (5–70%) is untouched; trust aggregates over jittery single
     bands (each run is a fresh MC draw).
  - ⚠️ *Outstanding:* `K_FORM_SIGMA 0.26` (2026-06-13) was chosen by minimizing **2024
    `|Δ|`, evaluated on 2024** — both in-sample and on an improper metric. The U-shape was
    broad and shadow forward-validates it, so it's likely fine, but it should be
    re-confirmed by a 2022–23-train / 2024-test Brier sweep. Don't cite it as a clean
    example of the procedure — it predates this section.
- **Not reconstructable** (any live formula path the backtest approximates differently —
  e.g. the live **HRR** uses empirical gamelog rates while the backtest uses a logit
  path): no shortcut. Ship against shadow, set the cutoff, and wait for post-cutoff
  `n≥200`. Slower; this is the common case for prop models.

To sweep a module-level const on the backtest, temporarily make it env-overridable
(`Number(process.env.X_OVERRIDE) || <default>`), sweep, **then revert the shim** — don't
commit the override.

---

## Ship checklist

Every formula change does all of these in **one commit** (the project's standing rule):

1. Change the constant(s) in `api/lib/…`.
2. **Sync embedded copies** — e.g. `K_FORM_SIGMA` is duplicated in
   `simulate.test.jxa.js`; run `npm test` **and** `npm run test:jxa`.
3. **Stamp a `trackedAt` cutoff** — note it in MODEL.md + CLAUDE.md so future
   calibration queries filter pre-change rows.
4. Update `docs/MODEL.md` (formula detail) + `CLAUDE.md` (one-line model-row note).
5. Save a memory entry (joins the "each change sets a trackedAt cutoff" family).
6. `git push origin main`; confirm the Vercel deploy is `READY`.
7. **Verify post-deploy:** bust the cache (`/api/tonight?debug=1&bust=1`) and confirm
   truePcts moved in the predicted direction and the gated set changed as expected.
8. **Watch:** over the following weeks the targeted band should drift toward Δ≈0
   (filtered to the new cutoff).

---

## Layer 0 — identifying a *new* input (the weak link, semi-manual)

This is the one step that is **not yet mechanized**. The corrector layers (and any future
XGB) can only redistribute weight across features already plumbed in — none can recover a
signal the model never collected.

**WHEN a new input is warranted:** a coherent miss (n≥200, multi-band) **persists after
exhausting L1–L5** — you've reweighted, shrunk, anchored, capped, and a systematic
residual remains. That leftover residual is, by definition, variance the current input
set can't explain.

**WHAT input to add — residual slicing:** take resolved `shadow_plays` for the category,
compute per-play residual `(actual − predicted)`, and group by **dimensions the model
stores but does not (fully) model** — park, umpire, pitcher handedness, days-rest,
weather, B2B, lineup slot, game total, home/away. A flat residual gradient across a
dimension means it's already captured; a **steep gradient is the missing or
under-weighted input**, and the sign tells you over- vs. under-modeled. The same slice
distinguishes **L2** (dimension is in the formula but mis-weighted) from **L0** (dimension
is absent entirely).

> This residual-by-dimension slice is **not built yet** (deferred 2026-06-13 — no current
> category has a post-cutoff miss surviving L1–L5 that would justify it). When one does,
> build `scripts/tune/residual-by-dimension.js` as a `tune:gate` sibling: pull resolved
> rows, rank stored dimensions by |mean residual gradient| with per-bucket n, trustworthy
> per-dimension at the same n≥200 bar. Limitation it can't escape: it only tests
> dimensions already in the data — a genuinely novel signal (e.g. Statcast pitch-shape)
> still needs a domain hypothesis **and** new sourcing.

**WIRING a new input (the 4-step ritual,** worked example: barrel% added 2026-05-25):
1. **Build** a fetcher → per-entity map (`buildBarrelPct()` in `mlb-hitters.js`). Hard
   constraint: the signal must be fetchable **at prediction time** from an available
   source (ESPN / MLB Stats / NHL / Kalshi). Sourcing is the bottleneck, not the math —
   if no source exposes it pre-game, you can't add it (totalBases needed a statsapi merge
   because ESPN's box score has no TB).
2. **Hydrate** — into `byteam`, or its own cache key if it shouldn't be wiped by a bust
   (`mlb:barrelPct` lives separate so a bust can't bake an empty map).
3. **Consume** — pull it, then **anchor + clamp + weight** into the logit/λ
   (`_LG_BARREL=8.5`, `clamp(…, 0.92, 1.10)`, `0.25·log(barrelAdj)`).
4. **Degrade gracefully** — `null → neutral` (1.0 multiplier), with a `*Source` flag.
   A new feature with partial coverage must **never blank out a play**
   (`feedback-team-aggregate-fallback`).

Then: wire `dataConfidence` in **both emit paths** (the `project-mlbk-dc-emit-bug`
divergence exists because a dc rule was added to one path only), env-var wiring through
`api/[...path].js` if a new source needs a key, `trackedAt` cutoff, shadow validation
(forward-only if the feature isn't historically reconstructable).

---

## TL;DR loop

```
detect (report + tune:gate, filtered to current cutoff)
  → confirm (n≥200, |Δ|>2·SE, coherent, decontaminated; beats market-Brier?)
    → diagnose layer by signature (L1–L5; L0 if residual survives all)
      → validate (backtest: train/test split + select on Brier; else shadow-wait)
        → ship (sync tests, stamp cutoff, docs+memory, deploy, verify, watch drift)

Objective check at every step: a calibration win that doesn't move model-vs-market
Brier (or CLV) is not a real win.
```
