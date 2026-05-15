# SimScore Audit — Phase 5.B

Each SimScore component classified as:
- **(L)** Already in lambda — the underlying continuous variable feeds truePct directly; the tier scoring is redundant attribution that can be dropped once SimScore is gone
- **(M)** Matchup-only signal not in lambda — candidate to move OR drop
- **(G)** Gate signal (e.g., lineup spot threshold) — affects which plays push, not truePct

The goal is for every SimScore component to be either L (already redundant) or G (gate-only, separate concern), leaving SimScore with no unique signal to contribute and clearing the path for removal.

---

## MLB Strikeouts — `simScore = kpctPts + lkpPts + kHitRatePts + kH2HHandPts + totalPts`

| Component | Source variable | Lambda use? | Classification |
|---|---|---|---|
| `kpctPts` | `pitcherCSWPct` / `pitcherKPct` | `pitcherKPct` IS the core lambda K rate. CSW is fallback only — not in lambda. | **L** (K%) + tiny **M** sliver for CSW-only case. Effectively L. |
| `lkpPts` | `lineupKPct` (per-batter ordered) | `orderedKPcts` is a direct sim input (every simulated batter draws from this lineup) | **L** |
| `kHitRatePts` | `_blendedHR` (pitcher's K hit rate at this threshold, blend of 2026 + 2025) | Used as `_kHandAdj`-style multiplier in lambda; also informs the seasonHitRate-style blend | **L** |
| `kH2HHandPts` | `_kH2HHandRate` (pitcher vs handedness-majority opponents) | Phase 1: used as `_kHandAdj = clamp(rate/70, 0.90, 1.10)` multiplier in lambda | **L** |
| `totalPts` | Game O/U (market consensus) | NOT in lambda. Pure market gut-check. | **M** |

**Net**: 4 of 5 components are already in lambda. Only `totalPts` is genuinely SimScore-only. Game O/U is a market signal — blending the model with the market reduces measured edge by definition (we'd be regressing toward the line we're trying to beat). **Recommend: drop `totalPts` rather than move; let truePct stand on its own model inputs.**

---

## MLB Hitters (HRR) — `hitterSimScore = hitterOpsPts + hitterWhipPts + hitterSeasonHitRatePts + hitterH2HHitRatePts + hitterTotalPts`

| Component | Source | Lambda use? | Classification |
|---|---|---|---|
| `hitterOpsPts` | `_hitterOps` (season OPS) | Phase 1: moved into lambda | **L** |
| `hitterWhipPts` | `pitcherWHIP` | Phase 1: moved into lambda | **L** |
| `hitterSeasonHitRatePts` | `_hrrBlendedSeasonHR` | Phase 1: moved into lambda via seasonHitRate blend | **L** |
| `hitterH2HHitRatePts` | `_effectiveHitRate` (BvP rate, hand-fallback) | Phase 1: moved into lambda | **L** |
| `hitterTotalPts` | Game O/U | NOT in lambda | **M** |
| `hitterLineupSpot` (separate gate) | Batter's lineup position | Gate at ≤ 5 drops play before SimScore | **G** |
| `hitterBarrelPts` (not in formula above, but emitted) | `hitterBarrelPct` | In lambda via barrel multiplier | **L** — attribution only |
| `hitterPlatoonPts` (not in formula, but emitted) | `hitterPlatoonRatio` | In lambda | **L** |

**Net**: 4 of 5 formal components are L. Same pattern as MLB-K — `hitterTotalPts` is the only matchup-only signal. **Recommend: drop `hitterTotalPts`.**

---

## NBA Player Props — `nbaSimScore = usagePts + dvpPts + nbaSoftHitRatePts + nbaSeasonHitRatePts + nbaTotalPts`

| Component | Source | Lambda use? | Classification |
|---|---|---|---|
| `usagePts` | `nbaUsage` (USG%) or `avgMin` for REB | USG/AvgMin is a direct input to `buildNbaStatDist` lambda projection | **L** |
| `dvpPts` | `dvpRatio` (opponent's allowed rate at this position) | `dvpRatio` is a multiplier in the lambda | **L** |
| `nbaSoftHitRatePts` | `softPct` (player vs soft-defense rate) | Used in pre-sim blend | **L** |
| `nbaSeasonHitRatePts` | `seasonPct` | Used in pre-sim blend | **L** |
| `nbaTotalPts` | NBA game O/U | NOT in lambda | **M** |

**Net**: 4 of 5 are L. Same pattern. **Recommend: drop `nbaTotalPts`.**

---

## WNBA Player Props — same shape as NBA

| Component | Lambda use? | Classification |
|---|---|---|
| `usagePts` | USG in lambda | **L** |
| `dvpPts` | WNBA DvP is flat (no per-position) but stat-allowed rate is in lambda | **L** |
| `wnbaSoftHitRatePts` | softPct blend | **L** |
| `wnbaSeasonHitRatePts` | seasonPct blend | **L** |
| `wnbaTotalPts` | WNBA game O/U | **M** |

**Recommend: drop `wnbaTotalPts`.**

---

## NHL Points — same general shape

| Component | Lambda use? | Classification |
|---|---|---|
| `toiPts` (TOI) | TOI is sim input | **L** |
| `gaaPts` (opp GAA rank) | GAA in lambda | **L** |
| `seasonHRPts` | seasonPct blend | **L** |
| `softHRPts` | softPct blend | **L** |
| `nhlTotalPts` | NHL game O/U | **M** |

**Recommend: drop `nhlTotalPts`.**

---

## Game Totals (MLB/NBA/WNBA/NHL) — `totalSimScore`

All components per sport are sourced from lambda inputs (RPG, WHIP, FIP, OffRtg, DefRtg, pace, GPG, GAA) — the lambda already uses these continuous variables. SimScore components for game totals are 100% attribution / **L**, except:

- **MLB**: `mlbOuPts` (game O/U tier) — **M**
- **NBA**: `nbaOuPts` (game O/U tier) — **M**
- **WNBA**: `wnbaOuPts` — **M**
- **NHL**: `nhlOuPts` — **M**

Same game O/U pattern across the board.

---

## Team Totals (MLB, NBA) — `teamTotalSimScore`

| Sport | (L) components | (M) components |
|---|---|---|
| MLB | `ttSeasonHitRatePts`, `ttWhipPts`, `ttL10Pts`, `h2hHitRatePts` (all in lambda via Phase 1) | `ttOuPts` (game O/U) |
| NBA | `ttOffRtgPts`, `ttDefRtgPts`, `ttNbaSeasonHitRatePts`, `h2hHitRatePts` | `ttNbaOuPts` |

Same pattern.

---

## Cross-cutting finding

**The only consistent (M) signal across every play type is "Game O/U line (market consensus)".** Everything else is already in lambda after Phase 1.

Three options for handling game O/U:

1. **Drop it** — let truePct stand on its data-driven inputs. The seasonHitRate blend already provides historical anchoring without market contamination. **Cleanest, recommended.**
2. **Move it into lambda as a market prior** — blend lambda toward market (e.g., `blendedLambda = 0.9 * modelLambda + 0.1 * marketImpliedLambda`). Tightens edges; reduces measured edge by design.
3. **Keep it in SimScore-as-attribution** — show the tier on the play card but don't gate. SimScore becomes a 1-component "is the market with us?" check.

---

## Conclusion: SimScore can be dropped almost entirely after Phase 1

The bulk of SimScore's signal is already in lambda. The only remaining matchup-only signal is the market O/U tier, and even that is arguably better left out of the model (market blending reduces edge).

**Phase 5.C path: drop all `*TotalPts` / `*OuPts` SimScore components AND drop SimScore as a metric.** truePct + dataConfidence are then the complete pair: truePct is the model's belief (with all matchup signals folded into lambda), dataConfidence is the input-trust gate.

`hitterLineupSpot` (G) stays as a gate, independent of SimScore — it's already separate code.

---

## Recommended sequencing

1. **Phase 5.C.1** — Drop `*OuPts` from SimScore formulas. Replace each with 0 contribution (or remove the component entirely). Watch for what changes in qualified-plays count under v1 (should drop minor; some plays will lose 1-2 SimScore points and fall below 8).

2. **Phase 5.C.2** — Drop the SimScore ≥ 8 gate on the server side (the `qualified: false` flag based on SimScore). v1 frontend filter then only checks `dataConfidence`-or-edge naturally.

3. **Phase 5.C.3** — Remove SimScore computation entirely from `api/[...path].js`. Remove the SimBadge component from the UI. Remove `*Pts` fields from play emissions (or keep a single `attributionPoints` field if still useful for debugging).

4. **Phase 5.D / 2026-05-27 review** — validate that truePct calibration didn't degrade after SimScore left the picture.

Each step is a separate PR. Step 1 is small (~30 lines across 5 sites). Step 2 is small. Step 3 is the most invasive (touches play emit sites, UI components, calibration endpoint).

---

## What this changes about today's v2 toggle

The v2 toggle currently filters on `dcQualified === true && edge ≥ 3`, with the v1 filter still on SimScore. Once Phase 5.C runs, v1 and v2 converge — both become "dcQualified AND edge ≥ 3" — and the toggle can be removed.
