# Scoreboard — Model Reference

Per-sport modeling internals. CLAUDE.md has the architecture map and load-bearing gotchas; this file is the deep reference for play-generation logic.

---

## Universal definitions
- **SimScore**: 5 components × 2pts each → max 10. Qualifies at ≥ 8. Null component → 1pt abstain (unless noted otherwise).
- **Edge gate**: `edge = truePct − kalshiPct ≥ 3%`. `kalshiPct` is already the slippage-honest fill price — re-priced to the cost of sweeping a unit-sized position through the cached orderbook (`blend-fill.js`), not just top-of-book ask. Applies to **all** surfaces as of 2026-05-31 (props + totals/teamTotal/spread, both YES and NO sides); markets without cached depth keep top-of-book. `spreadAdj` is computed but **not** subtracted.
- **`pct ∈ [67, 91]` filter**: universal qualification window for player props, game totals, and team totals. UNDER discovery uses `noKalshiPct ∈ [67, 91]`. Tunables `KALSHI_GATE` / `KALSHI_CAP` / `EDGE_GATE` / `SIMSCORE_GATE` live in both `api/[...path].js` and `src/App.jsx` — change in both places.
- **UNDER plays** (totals only): `underEdge = (100−truePct) − (100−kalshiPct) ≥ 3%` AND `noKalshiPct ∈ [67, 91]`. `direction:"under"`, badge red, bars use `noTruePct`/`noKalshiPct`, prose colors inverted, track ID appends `|under`.
- **dataConfidence** (0–10, penalty-based since 2026-05-15 refactor): score of input-data trust, separate from SimScore (which scores matchup favorability). Starts at 10, subtracts penalties for issues, clamps `[0, 10]`. Computed centrally in `_computeDataConfidence` in `/api/tonight`; emitted as `dataConfidence`, `dcPenalties: {reason: -cost}` (only non-zero entries), `dcQualified: bool` (= `dataConfidence >= DC_GATE[sport]`), and `dcGate` (per-sport threshold). Per-sport AND per-play-type gates: **player props — MLB/NBA 9, WNBA/NHL 8**; **totals/teamTotals — MLB/NBA 10, WNBA/NHL 9**; **ml — MLB 8** (loosened from 10 on 2026-05-18; ML-only gate). Totals get a stricter gate because they don't accumulate the per-player penalties props do (lineup confirmation, softGames, etc.), so a flat gate would let totals dominate the qualified feed. WNBA/NHL get -1 across the board for structural data gaps. `dcQualified` is **emitted but not actively filtering**; the v2 model toggle adopts it as the gate in Phase B. Penalty table:
  - **Market quality**: `_kalshiStale` → -4 · `lowVolume` → -2 · ~~`kalshiSpread ≥ 5` → -1~~ (`wideSpread` **dropped 2026-05-31** — it was a proxy for "this market costs more to fill than top-of-book shows"; now that every surface re-prices through the orderbook-depth blend, slippage is in `kalshiPct`/`noKalshiPct` directly and penalizing the spread again double-counts. Raw `kalshiSpread` still emitted for display.)
  - **Lineup**: MLB `lineupConfirmed/lineupsConfirmed === false` (or undefined) → -3 · NBA/WNBA confirmed bench (lineup posted AND player isn't in it) → -2. **No NBA/WNBA "not posted" penalty** (dropped 2026-05-26): ESPN's pre-game starter feed is empty by default, so the prior -2 would cap every pre-game NBA/WNBA prop at dc=8 and block them from the strict dc=10 home filter — sport-wide data gap, documented not penalized (same precedent NHL set). NHL has no lineup penalty at all (no exposed lineup data).
  - **Availability** (player props): `playerStatus` `"out"/"inactive"` → -10 (effective drop) · `"questionable"/"doubtful"/"GTD"` → -2
  - **Sample size**:
    - MLB-K: `stdBF == null` → -3 · stdBF > 2.5 → -1
    - MLB-Hitter: `softGames < 5` (or null) → -3 · 5–9 → -2 · 10–15 → -1
    - NBA/WNBA/NHL prop: `softGames < 5` → -2 · 5–9 → -1 · absent → -1
    - Game total: `gtSsnSample == null` → -3 · <10 → -2 · 10–29 → -1
    - Team total: `h2hGames == null` → -3 · <3 → -2 · 3–5 → -1
  - **Opp data**:
    - MLB-K: `lineupKPct == null` → -3 · opp lineup projected (not confirmed) → -1
    - MLB-Hitter: `hitterH2HSource == null` → -3 · `"hand"` (handedness only) → -1
    - NBA prop: both `dvpRatio` AND `oppRank` null → -3 · `dvpRatio` null only → -1
    - WNBA prop: `oppRank == null` → -3 · `dvpRatio` structural (always null) → -1
    - NHL prop: `oppMetricValue == null` → -3
    - Game totals: `gameOuLine == null` → -2
    - MLB teamTotal: `oppWHIPSource == null` → -3 · `"team"` (fallback) → -1
    - NBA teamTotal: `oppDefRtg == null` → -3
  - **Threshold-distance from O/U line** (totals & team totals only): tail probabilities are noisier than central ones. Per-sport buckets — for team totals, half-line heuristic uses `gameOuLine / 2`:
    - MLB total: dist ≥ 3 → -1, ≥ 5 → -2 · teamTotal: ≥ 2 → -1, ≥ 3 → -2
    - NBA total: ≥ 10 → -1, ≥ 20 → -2 · teamTotal: ≥ 5 → -1, ≥ 10 → -2
    - WNBA total: ≥ 10 → -1, ≥ 20 → -2 · teamTotal: ≥ 5 → -1, ≥ 10 → -2
    - NHL total: ≥ 2 → -1, ≥ 3 → -2 · teamTotal: ≥ 1 → -1, ≥ 2 → -2
  - **Season-rate divergence** (game + team totals): when the rate-inverted implied mean/lambda diverges from the model mean/lambda (`teamExpected` for team totals) by more than the per-sport cap, the blend math is clamped in the simulate path and the resulting truePct is built on softened evidence. Game-total caps `_GT_IMPLIED_CAP`: NBA pts ≥ 8, WNBA ≥ 6, MLB runs ≥ 1.5, NHL goals ≥ 1.0. Team-total caps `_TT_IMPLIED_CAP` (tighter — single-team std is smaller): NBA pts ≥ 6, MLB runs ≥ 1.0. Trigger → `seasonRateDivergent` -2. The cap itself stops runaway inversions at far-from-line thresholds where seasonHitRate is near 0/100; the dataConfidence penalty stops the dampened pick from passing the v2 dcGate.
  - **MLB game total — both starters via starter source**: pitcher quality is the primary lambda input, so a team-WHIP fallback is a real trust hit. Per-side check — worst case -4 (both unknown).
    - `homeWHIPSource == null` → -2 · `"team"` (fallback) → -1
    - `awayWHIPSource == null` → -2 · `"team"` (fallback) → -1
  - **MLB game/team total — bullpen ERA source**: 40% rest-of-game share prefers bullpen-only ERA; whole-staff fallback is tolerable but double-counts the starter. -1 per side (game total max -2, team total max -1).
    - Game total: `homeBullpenSource === "team"` → -1 · `awayBullpenSource === "team"` → -1
    - Team total: `oppBullpenSource === "team"` → -1
  - **NHL game total — starting goalie SV%**: opponent factor is keyed off tonight's goalie when known; team-GAA fallback is a smaller trust hit. Per-side check — worst case -2 (both unknown).
    - `homeGoalieSource === "team"` → -1
    - `awayGoalieSource === "team"` → -1

---

## Category gate (display restriction, 2026-06-01)
UI display + the `push/notify` cron are restricted to categories with confirmed positive shadow ROI. Gate: `passesCategoryGate()` in `api/lib/category-gate.js` (moved from `src/lib/constants.js` 2026-06-13, re-exported there for unchanged frontend imports), applied in `App._qualifiedFilter` / `LineupsPage.passesGate` (display) and the `push/notify` cron (alerts). Tracked picks bypass it so existing bets stay visible.

**Promotion bar**: add a category only when `npm run tune:gate` shows ROI>0 at cumulative n≥50 (`MIN_N_PROMOTE`) **and** the per-band detail is coherent (no in-window band flipping negative). All current gates were promoted at per-band n of 10–56 — well under the once-stated "n≥200" (corrected 2026-06-13). Band coherence, not raw n, is the real guard against overconfidence.

**Currently allowed: NONE — the gate is EMPTY as of 2026-07-18** (four pulled 6/19 after formula-clean validation; the `mlb|hrr` NO-side provisional pulled 7/18). Re-enable a category only after `tune:gate` confirms a coherent +ROI band at n≥50 + non-negative Brier skill (`?brier=1`).
- `mlb|hrr` NO-side — **PULLED 2026-07-18** (provisional 2026-07-11: `direction='under' && truePct [63,73)`, paired with the `[24,33]` NO-price bet window). The 7/11 derivation showed NO ROI ≈ +8.8% (n=187) — but the parse loop never propagated `noKalshiPct` for hrr until 2026-07-17, so both the band and the window rested on YES-ask complements (synthesized NO pricing, which the UNDER-pricing doctrine rejects: independent books, 3–7¢ spread) with **zero real NO-quote captures**. Live 7/18 quotes mildly support the thesis (~6¢ YES overpricing on a 1¢-overround book), but it's unvalidated. Shadow capture continues gate-independently; re-enable after `tune:gate` confirms +ROI at n≥50 on post-7/17 real-NO-quote rows (~1 week at ~10–15 in-band rows/day).
- `mlb|strikeouts` — **DEMOTED 2026-06-19.** Formula-clean in-gate [80,85) bet set (since 6/13, edge≥5 + rank1) was n=5, ROI −13%, overconfident (pred 82.5 → won 60); Brier skill −0.007 (market sharper). Demoting is a GATE change, not a formula change — the K_FORM_SIGMA freeze (don't touch the K formula until ~6/26) still holds and shadow data keeps accruing for a possible re-enable at n≥50. (Was 80–85%, capped 90→85 on 6/17 after the 85–90 band bled −35%; originally 80–90, promoted on n=55/56 both bands positive 2026-06-08 — pre-formula-clean.)
- `wnba|points` — **PAUSED 2026-06-19.** Formula-clean validation (since 5/28: dcQual + edge≥5 + rank1) found the [70,80) gate mis-placed: the in-gate band caught only n=3 (33% hit, −36% ROI) while the model's profitable plays sit at [80,85) (n=10, 90% hit, +14%) ABOVE the cap and were being excluded — the model is underconfident (board +17.5), so its high-truePct picks over-deliver. Also negative Brier skill (−0.003 @ n=132) → market sharper. Re-enable only after `tune:gate` confirms the right band (likely [80,85)) at n≥50 + coherence. (Was 70–80%, promoted on n=10/16 both bands positive 2026-06-08 — that promotion was pre-5/28-formula and on thin n.)
- `wnba|rebounds` — **PAUSED 2026-06-19.** Formula-clean validation (since 5/28): the [70,85) gate caught only n=1; the actual bet plays land at 85-90 (n=13, ABOVE the cap) and are only ~breakeven (ROI −0.003), Brier skill −0.028 @ n=96 (market sharper). No coherent +ROI band. Re-enable only after `tune:gate` confirms a band at n≥50 + coherence. (Was 70–85%, promoted 2026-06-09.)
- `wnba|spread` — **PAUSED 2026-06-19.** Formula-clean validation (since 5/28): bet set (dcQual + edge≥5 + rank1) n=15 hit only 20% / ROI −15.5% while the model claimed +13.8% avg edge (severe overconfidence); unfiltered Brier skill −0.032 @ n=237 confirms the market is much sharper on the FULL distribution (not small-n). No profitable band to shift to. Re-enable only after `tune:gate` shows a coherent +ROI band at n≥50. (Was 65–85%, promoted on n=39 ~+11% weighted 2026-06-11 — pre-formula-clean, didn't hold up.)

**Shadow-only categories** (emit to `shadow_plays`, intentionally NOT in the gate):
- `mlb|hits` — re-added 2026-06-11; shipped with wrong series ticker `KXMLBHITS`, real ticker `KXMLBHIT` (fixed 2026-06-12, so shadow data starts 6/12); check `tune:gate` ~mid July.
- `mlb|totalBases` — added 2026-06-12, `KXMLBTB`; `tbTailPct` compound-binomial extension of the hits model; **the only UNDER-direction player prop** (Kalshi lists 2+..6+ only so the YES side never reaches [67,91] — plays bet the NO side, stored over-framed with `direction:"under"` per the totals convention); resolves via statsapi merge `/api/live?tb=1` because ESPN's box score has no TB; check `tune:gate` ~late July.
- `tennis|match` — ATP+WTA match-winner, added 2026-06-13, `KXATPMATCH`/`KXWTAMATCH`; Phase-1 ESPN-rankings logistic model; resolves off the ESPN tennis scoreboard, NOT `/api/live`; coverage limited to players in ESPN's ~top-150 rankings (unranked either side → abstain, the main argument for Phase 2 surface Elo); tennis books fill near match time so live capture is sparse; check `tune:gate` once volume accrues.
- `soccer|{game,total,teamTotal,spread,btts}` — FIFA World Cup, added 2026-06-21, `KXWC{GAME,TOTAL,SPREAD,TEAMTOTAL,BTTS}`; Phase-1 one-matrix model (see § Soccer below); resolves off the ESPN `fifa.world` scoreboard, NOT `/api/live`; coverage limited to the 48 WC nations (Elo-rated); check `tune:gate` per category once volume accrues.
- `soccer|advance` — FIFA World Cup knockout "to advance" (`KXWCADVANCE`), added 2026-06-25; per-tie binary off the SAME Elo matrix (see § Soccer below); resolves off ESPN `competitors[].advance` (the ET/penalties outcome), NOT `/api/live`.

---

## Soccer (World Cup) — Phase 1, shadow-only (2026-06-21)

`api/lib/soccer.js` + `api/lib/tonight/soccer.js`. The whole thesis: **one per-game goal-rate pair → one score matrix → every market.** Mirrors tennis Phase 1 (minimal model, a few provisional knobs the first shadow week calibrates, richer Phase 2).

**λ from Elo.** National-team World Football Elo (`eloratings.net/World.tsv`, 12h KV cache). `supremacy = (eloHome − eloAway + homeAdv) / SOCCER_ELO_DIV`; `λ_home = (μ + supremacy)/2`, `λ_away = (μ − supremacy)/2`, each floored at 0.15. Constants `SOCCER_MU_TOTAL=2.7` (WC group-stage baseline total), `SOCCER_ELO_DIV=160`, `homeAdv=0` (WC 2026 neutral fields; host bump deferred). **C=160 was anchored to reproduce the standard Elo win-expectancy curve `1/(10^(-Δ/400)+1)` — NOT fit to Kalshi prices** (fitting to market would launder the market's edge into the model). Model `We = P(home)+0.5·P(draw)` tracks the Elo curve to within ~0.01 over Δ∈[0,300].

**Score matrix.** `buildScoreMatrix(λ_home, λ_away, ρ)` — independent Poisson(λ_home)×Poisson(λ_away) over goals 0..10, with a **Dixon–Coles** low-score correction (`SOCCER_DC_RHO=-0.13`) on the four cells {0-0,0-1,1-0,1-1} so draw/low-score mass is right; then normalized. `ρ` is the one extra knob beyond λ.

**Five projections off the one matrix:** `prob1x2` (lower-tri/diag/upper-tri → home/draw/away), `probTotalOver(line)`, `probTeamOver(line,isHome)`, `probSpreadCover(line,favIsHome)` ("wins by more than line"), `probBtts`.

**Emit (`emitSoccerPlays`).** Groups priced sides by `event_ticker`, builds the matrix once, emits every side priced in [67,91] into a dedicated `soccerPlays` array (bypasses dedup/gameTime-filter/card-builder; merged into `shadow:staging` only). The 1X2 is a 3-way pick (`direction:null`, one row per in-window side incl. a real draw side); total/teamTotal/spread/btts follow game-totals' OVER/UNDER convention (`truePct` always the OVER prob, UNDER row adds `noTruePct`).

**Parse (tonight.js soccer branch).** Event segment encodes date + the two FIFA codes (3+3), e.g. `KXWCTOTAL-26JUN21BELIRI` → 2026-06-21, home `BEL` / away `IRI` (Kalshi lists home first). game/btts are binary (side / yes-no); total/teamTotal/spread carry `floor_strike`; teamTotal/spread team comes from the ticker suffix (`BEL2` → `BEL`).

**Settlement & resolution.** Verified against Kalshi `rules_primary`: **all WC markets settle on 90 minutes + stoppage, excluding ET/penalties** — so the regulation score matrix IS the settlement object, and a knockout 1X2 settles as a draw if level at 90'. The resolver (`fetchWcFinals` → ESPN `fifa.world` 90' final, `STATUS_FULL_TIME`) reads a `{canonicalCode: goals}` map per game and resolves alignment-independently. `espnToCanonical` maps ESPN abbrs (overrides ALG→DZA, HAI→HTI, IRN→IRI; name fallback for the rest). Knockout caveat (~Jul 4+): confirm ESPN's FT field is the 90' score, not a post-ET aggregate.

**Knockout "to advance" (`soccer|advance`, 2026-06-25).** `KXWCADVANCE` is a per-tie binary ("X advances") — one event per knockout tie (`KXWCADVANCE-26JUN28RSACAN-{RSA,CAN}`), two sides. Settles on who **advances** (the ET/penalties outcome, NOT the 90' score — distinct from the 5 families above). The model reuses the SAME regulation Elo matrix: take 90' `{pWin,pDraw,pLoss}` for the priced side, then fold the draw mass — `advanceProb` = `pWin + pDraw·w`, `w = 0.5 + k·(winShare−0.5)`, `winShare = pWin/(pWin+pLoss)`, `k = WC_ADVANCE_ET_SHRINK = 0.5`. Rationale: penalty shootouts regress hard toward 50/50 regardless of favorite while ET goals mildly favor the better side, so the draw mass tilts to the regulation-stronger team but is shrunk toward a coin flip (`k=1` = full regulation dominance, `k=0` = pure coin flip). Knob provisional, anchored to shootout intuition NOT the market. `emitSoccerAdvancePlays` emits only the favorite side (Kalshi YES in [67,91]) into a dedicated `soccerAdvancePlays` array (`direction:null`). Resolver: `fetchWcAdvance` reads ESPN `competitors[].advance` (falls back to `winner`; requires exactly one flagged side, else records noData) and grades `won = advancer === pick_team`. **Phase-1 limitation:** `homeAdv=0`, but CAN/USA/MEX are 2026 hosts — host bump deferred to Phase 2.

**Phase 2** (parked): per-team attack/defence ratings (vs a single national Elo), host/home advantage, surface for club leagues via club Elo (`clubelo.com`), and the offseason club series (EPL/LaLiga/SerieA/Bundesliga/MLS — listed but offseason now).

---

## MLB Strikeouts
**True%**: `simulateKsDist(orderedKPcts, pitcherKPct, parkFactor, nSim, totalPA, earlyExitProb, stdBF)` → `kDistPct(dist, threshold)`. Shared distribution per pitcher (key `team|hand`) guarantees monotonicity. nSim 10k if simScore ≥ 8 else 5k.

**Adjustments inside `simulateKsDist`**:
- TTO decay: K% × `TTO_DECAY_FACTOR (0.88)` for BF ≥ 19
- Blowout hook: `_earlyExitProb` from pitcher team ML (`+150→8%, +200→12%, +250+→18%`); each trial may pull pitcher early (BF = rand[10,15])
- stdBF variance: each trial samples `trialPA ~ Normal(totalPA, stdBF)` clamped [10,27] via scoped Box-Muller (function-scoped to prevent cross-request races). 0 if <3 qualified starts. **Upside fix (2026-06-10)**: the PA loop now cycles the batting order (`bf % n`) until `trialPA`. The old loop pre-allocated exactly `totalPA` PAs consecutively per batter, silently truncating upside `trialPA` draws — stdBF acted as a downside-only haircut (K mean ~0.5 low, over truePcts ~3pts low on stdBF>0 plays; e.g. P(K≥7) 45.8→49.7 at stdBF=5, totalPA=24). Cycling also makes early exits cut later trips through the order instead of dropping the bottom of the lineup entirely. `stdBF=0` distributions are unchanged. Filter `mlb|strikeouts` calibration `trackedAt < 2026-06-10`. Caught by the (formerly flaky) `stdBF=5 widens` test in simulate.test.js — its premise was right, the code was wrong.
- **Between-game form variance (added 2026-06-01)**: each sim draws one mean-1 lognormal multiplier `formMult = exp(K_FORM_SIGMA·Z − K_FORM_SIGMA²/2)` (`K_FORM_SIGMA = 0.26`) and scales every batter's K prob by it. The per-batter Bernoulli loop only captures within-game randomness — it treated the pitcher's true K ability as fixed nightly, under-dispersing the K-count distribution. The 6/1 calibration showed strikeouts Δ −17.9 (n=38), concentrated in the 80–90% truePct band (act ~54%). `E[formMult] = 1` so the **mean K count is preserved** (verified — TTO mean still ≈6.9); only the spread widens, pulling extreme tail (over) truePcts toward 50%. **σ retuned 0.22→0.26 on 2026-06-13** after a 2024-backtest σ-sweep (n≈2000 over the 70–90% bands): 0.26 minimizes n-weighted calibration error in the gated 80–90% window (w\|Δ\| 2.88→1.30) and the broader 70–85% overconfident zone (w\|Δ\| 1.05), core (5–70%) untouched. **The 90–95%+ extreme tail is NOT a σ problem** — raising σ makes it *worse* (−10→−18) because a mean-preserving symmetric form multiplier can't reproduce the asymmetric early-hook/rain/ejection downside that caps realized extreme-K rates; that tail needs a downside-shock lever (`earlyExitProb`/disaster mass) and sits outside the gate anyway. Filter `mlb|strikeouts` calibration `trackedAt < 2026-06-13` (σ=0.26 cutoff; supersedes the `< 2026-06-01` σ=0.22 cutoff).

**Pre-sim adjustments**:
- A1 recent form: effective K% = `recentKPct × 0.6 + seasonKPct × 0.4` when ≥3 starts and 30+ BF in last 5 (uses `a1Splits` filter, no NP minimum)
- A2 rest/fatigue: × 0.96 if days since last start ≤ 3; × 0.92 if also last PC ≥ 95
- E3a umpire: `pitcherKPctAdj = min(40, pitcherKPctOut × umpireKFactor)`; lookup is ASCII-normalized
- K% regression: `trust = min(1, bf26/200)` blends 2026 actual with 2025 anchor (or league avg 22.2%)
- E3b expectedBF: `clamp(round(_avgBF), 15, 27)`. Fallback chain: `pitcherStatsByName.avgBF` → `sportByteam.mlb.pitcherAvgBF` (team key) → `clamp(round(avgP/3.85), 15, 27)`. Default 24. Both `avgP` and `avgBF` are sample-weighted blends of 2026 and 2025 anchors: `trust26 = min(1, gs26/15)`, blended = `trust26 × val26 + (1 − trust26) × val25`. Stabilizes early-season ramp-up workloads (e.g. Skenes 2026 avgP=81 with ~7 starts blended toward his 2025 ace baseline ~95) where raw 2026 sample alone would tank expectedBF and the K-market truePct. Pitchers with only one season's data use it as-is.
  - **Pitch-limited start cap**: when `pitcherLastStartPC ≤ 70` AND `gs26 < 5`, the pitcher is on a build-up (e.g., spot starter coming up from bullpen). The 2025 anchor still dominates the blend (`1 − trust26 ≥ 80%`), over-projecting volume relative to recent reality. Cap `_expectedBF = min(blended, round(lastStartPC / 3.85 + 3))` — last start's pitch count converted to BF at league-average 3.85 P/PA, plus a 3-BF cushion for moderate progression to the next outing. Floor stays at 15. Only fires when the cap is *below* the blend, so normal starters are unaffected.

**SimScore**:
- `kpctPts` — CSW% (≥30→2, >26→1, ≤26→0); falls back to regressed K% (>27/>24/≤24)
- `lkpPts` — Lineup oK% hand-adjusted (>24→2, >22→1, ≤22→0)
- `kHitRatePts` — Trust-weighted blend of 2026 observed and 2025 computed K-threshold hit rate (≥90→2, ≥80→1, <80→0). `trust26 = min(1, vals26.length/15)`. `blendedHitRate` is the value. **Pitcher gamelog is filtered to starts only** (`IP ≥ 3.0 AND TBF ≥ 12`) — ESPN gamelog returns all appearances incl. relief stints; mixing them in would tank per-threshold hit rate (e.g. Ashcraft 2025: 8 starts but 26 total appearances → unfiltered hit rate at ≥4 K was ~31%, start-only is ~95%). Filter applied once at `playerColCache` build (`_evtPool`); all downstream pitcher-K consumers (`vals25`/`vals26`/`_bf26`/`seasonPct`/soft-bucket history) operate on starter-only data.
- `kH2HHandPts` — Pitcher's K hit rate vs opponents whose lineup hand majority matches tonight's. Tonight uses full switch-hitter adjustment (S vs RHP→L); historical uses `staticTeamHandMajority` (S = 0.5R + 0.5L). ≥5 starts required (≥80→2, ≥65→1, <65→0). **Folded into K lambda 2026-05-13**: `_kHandAdj = clamp(h2hHandRate / 70, [0.90, 1.10])` multiplies into `_pitcherKPctAdj` before `simulateKsDist`. Was SimScore-only.
- `totalPts` — O/U tier (≤7.5→2, <10.5→1, ≥10.5→0)

**Display-only fields** (not in SimScore, kept for debug/calibration): `kbbPts`, `parkMeets`, `mlPts`, `kTrendPts` (calibration breakdown only — no longer shown in prose), `pitchesPts`. Recent K% still drives the A1 effective-K blend in the model; just removed from explanations to declutter.

**Gates** (in addition to SimScore ≥ 8):
1. Threshold sanity: `threshold > ceil(expectedKs) + 2` → `qualified:false` (only when lineup confirmed and expectedKs available)
2. Insufficient_starts: if `pitcherHasAnchor !== true` (gs25 ≥ 5 AND bf25 ≥ 100) requires `gs26 ≥ 8`. Catches TJ-return / pure-reliever cases. Checked in pre-filter AND main loop.

---

## MLB Hitters (HRR)
**True%**: logit-sigmoid base-rate adjustment with park, hitter OPS, and pitcher WHIP shifts (no Monte Carlo for HRR; the separate hits stat — dropped 2026-05-16, re-added 2026-06-11 — has its own binomial model, next section). **PA-aware adjustment (since 2026-05-25)**: convert per-game seasonPct + softPct to per-PA via inversion, re-compose at tonight's PA count from `hitterLineupSpot`, then continue the existing pipeline.
```
# PA-aware adjustment (retry 2026-05-25 with per-hitter baseline)
paFromSpot(spot)  = max(3.5, 4.7 - 0.13·(spot - 1))             # spot 1 → 4.7, spot 4 → 4.31, spot 9 → 3.66
nPAtonight        = paFromSpot(hitterLineupSpot)
hitterTypicalPA   = season_PA / season_GP                        # from buildLineupKPct, requires GP ≥ 20
# Gate: only adjust when |tonight − typical| ≥ 0.3 PAs. Hitters at their normal spot get no
# adjustment (correct — their seasonPct already reflects games at this PA load). Bumped-up or
# bumped-down hitters get the real opportunity delta.
paAdjust(pctGame) =
    let perPA = 1 - (1 - pctGame/100)^(1/hitterTypicalPA)
    in   (1 - (1 - perPA)^nPAtonight) × 100
primaryPctAdj = paAdjust(primaryPct)   # only when gate passes
softPctAdj    = paAdjust(softPct)      # only when gate passes

# BvP shrinkage (2026-05-16) — only when hitterH2HSource === "bvp" (now over PA-adjusted values)
N = 20                                                        # prior weight in games
shrunkSoftPct = (softGames·softPctAdj + N·primaryPctAdj) / (softGames + N)
rawMlbPct = (primaryPctAdj + shrunkSoftPct) / 2
opsAdj    = clamp(hitterOPS / 0.720, [0.85, 1.15])            # weight 0.25 in logit (0.4→0.25 2026-06-10)
whipAdj   = clamp((pitcherWHIP / 1.30)^0.5, [0.92, 1.08])     # weight 0.30→0.15 in logit (FIP split 2026-06-22)
fipAdj    = clamp((pitcherFIP / 4.20)^0.5, [0.92, 1.10])      # weight 0.18 in logit (added 2026-06-22)
barrelAdj = clamp(hitterBarrelPct / 8.5, [0.92, 1.10])        # weight 0.25 in logit (added 2026-05-25)
weatherAdj= clamp(1 + windOutMph·0.010 + (tempF−70)·0.006, [0.93, 1.10])  # weight 0.20 (added 2026-06-22, shadow-only)
truePct = sigmoid(
    logit(rawMlbPct/100) + ln(parkFactor)
    + 0.25·ln(opsAdj) + 0.15·ln(whipAdj) + 0.18·ln(fipAdj) + 0.25·ln(barrelAdj) + 0.20·ln(weatherAdj)
) × 100
```
- **FIP-over-WHIP split (added 2026-06-22)**: WHIP is a baserunner/traffic stat — wrong for HRR's HR component, yet it carried the *highest* pitcher weight (0.30). Split the pitcher term: WHIP→0.15 (contact/traffic, since HRR = H+R+RBI) + **FIP 0.18** (HR/run allowance; `_LG_FIP=4.20`, already hydrated as `pitcherFIPByTeam` for totals — no new sourcing). WHIP weight dropped to avoid double-counting traffic. Emits `hitterFipAdj` when ≠ 1.0. **Honesty fix, not a market-beater**: the residual slicer (2026-06-22) showed pitcher-quality residuals are already priced by the market — expect ~parity, not `BEATS_MARKET`. Sets the `mlb|hrr` FORMULA_CUTOFF to 2026-06-22.
- **Game-time weather (added 2026-06-22, shadow-only)**: wind out to CF + temperature lift HR/run carry — signal the static `parkFactor` can't see, and structurally underweighted on hitter props (lines set hours ahead; books weather-adjust totals more than props). `api/lib/mlb-weather.js`: `BALLPARKS` (per-park lat/lon + home→CF azimuth + dome flag) + `buildBallparkWeather(gameScores, todayPT)` → Open-Meteo (free, no key) at first-pitch hour → signed `windOutMph` (`−windMph·cos(windDir−cfAz)`, + = blowing out) + `tempF`. Hydrated as `sportByteam.mlb.weatherByTeam[homeTeam]` (in byteam, refreshed each cycle). Dome/retractable parks → neutral (all retractables treated as closed — can't know roof state pre-game). Coeffs (`_W_WIND=0.010/mph`, `_W_TEMP=0.006/°F`) **anchored to published HR sensitivities, NOT Kalshi** — provisional, shadow-validated. Emits `hitterWeatherAdj`/`windOutMph`/`tempF` so a future `tune:residual` can slice by weather (the input that was *absent* when the 2026-06-22 slice ran). **The one HRR change with a real shot at `modelBrier < marketBrier`.** Phase 2: refine park azimuths. (NOTE: extending weather to **game/team/F5 run totals was tested and rejected 2026-06-23** — `scripts/backtest/weather-runs-study.js` found wind+temp ~flat on total runs, r≈0; the older ESPN-parse `weatherFactor` on those λ was *removed* the same day. Weather is HR-specific, not a general run-scoring lever.)
- **PA-aware adjustment (retry 2026-05-25)**: HRR ≥1 is built from per-PA Bernoulli outcomes. Adjustment first shipped with a flat 4.0 PA baseline and was reverted same day (pushed predictions UP for every qualifying spot since all spots 1-5 sit above 4.0 PAs). Retry uses per-hitter typical PA from season GP. **Gate**: only fires when `|tonight − typical| ≥ 0.3 PAs`, so hitters at their normal spot get no adjustment. Requires `gamesPlayed ≥ 20` for the baseline to populate. Emits `hitterPaFromSpot`, `hitterTypicalPA`, `seasonPctAdj`, `softPctAdj` when adjustment fires (often empty when most picks are hitters at their typical spot). Filter `trackedAt < 2026-05-25` for HRR calibration across the retry.
- **Barrel% adjustment (added 2026-05-25)**: quality-of-contact signal beyond OPS. Top barrel hitters (~14%) lift truePct ~1.5pt; weakest contact (~5%) drops ~1.5pt. Weight 0.25 in the logit (lower than OPS's 0.4 since barrel rate is per-batted-ball and noisier per game). Replaces barrel-as-SimScore-only with a real lambda input. Emits `hitterBarrelAdj` on the pick when ≠ 1.0.
- **BvP shrinkage added 2026-05-16**: small-sample BvP rates (10 games at 100%) were dominating the 50/50 blend. Bayesian-style: at softGames=20 the blend is 50/50 BvP/season-prior; at softGames=10, BvP gets ~33% weight. Hand-source `softPct` skips shrinkage (handedness samples are large by definition).
- OPS folded into lambda 2026-05-13 (was SimScore-only). Top-quartile (~.850) lifts truePct ~1.5–2pt.
- WHIP folded into lambda 2026-05-13 (was SimScore-only). Lower weight than OPS; high-WHIP pitcher → more contact → higher HRR base rate beyond what BvP captures.
- `primaryPct` = 2026 HRR 1+ rate (fallback: 2025+2026 blend, then career)
- `softPct` = HRR ≥threshold rate vs tonight's pitcher (BvP, ≥10 games). **Handedness fallback** when BvP <10: `batterHRRSplits[name][vsR/vsL]` (MLB Stats API, 2025+2026 combined), Poisson tail `1 − poissonCDF(threshold−1, lambda)` where `lambda = totalHRR/games`; ≥10 games vs that hand required. `softLabel` set to `"vs RHP"`/`"vs LHP"`. **Threshold-aware since 2026-06-12** — was hardwired to `1 − e^(−lambda)` = P(≥1), which would emit a garbage softPct on 2+/3+ overs; at threshold 1 it still reduces to `1 − e^(−lambda)` (no change for 1+). Caveat: HRR is lumpy (a solo HR is instantly 3 HRR), so Poisson understates the upper tail for power bats — this is last-resort only; empirical season/BvP rates stay primary.
- **All thresholds logged to shadow since 2026-06-12** (commit adde21e). HRR is YES/over-side only at every threshold on Kalshi (the 1+ over is the bread-and-butter bet; unlike `totalBases`, there's no NO/under play). The parse-time `threshold > 1` skip was dropped so 2+/3+ overs that organically price into `[67,91]` flow to `shadow_plays` (with the `threshold` column) for calibration. Thin inventory — ~10–15 rows/day vs the ~50 at 1+. `mlb|hrr` stays out of `passesCategoryGate` for the higher lines; **band shadow analysis by threshold** — the 6/10 HRR recalibration (OPS 0.4→0.25, knee 68) was fit on 1+ rows only, and early 2+/3+ data shows large negative model edges vs Kalshi (likely the lumpiness understatement above). Don't promote a 2+/3+ band until threshold-banded ROI confirms at n≥200.
- B2 batter recent form: `hitterEffectiveBA = 0.3 × recentBA + 0.7 × seasonBA` when ≥20 AB in last 10 (used by the hits binomial model below, not the HRR formula)

**SimScore**:
- `hitterOpsPts` — 2026 OPS (≥.850→2, ≥.720→1, <.720→0). Fetched via 7th parallel request in `buildLineupKPct`.
- `hitterWhipPts` — Pitcher WHIP (>1.35→2, >1.20→1, ≤1.20→0)
- `hitterSeasonHitRatePts` — Blended season HRR rate (≥80→2, ≥70→1, <70→0). `trust26 = min(1, vals26.length/30)`.
- `hitterH2HHitRatePts` — BvP path (≥10g): ≥80→2, ≥70→1; or handedness path (<10 BvP, hand known, ≥10g vs hand): same tiers. `hitterH2HSource` = `"bvp"|"hand"|"abstain"`.
- O/U tier (≥9.5→2, ≥7.5→1, <7.5→0)

**Gates**: lineup spot 1–5 required (6+ dropped); `low_lineup_spot` and `hitterSimScore < 5` are pre-gates that do NOT push to `plays[]`.

**Pitcher data fallback chain** (for `hitterPitcherName`/`hitterPitcherEra`, also for gamelog loading):
1. `sportByteam.mlb.probables[oppAbbr]` (ESPN scoreboard)
2. `sportByteam.mlb.pitcherInfoByTeam[oppAbbr]` (MLB Stats API — announced day before, very reliable)
3. `pitcherGamelogs[oppAbbr].name` (if gamelog loaded)

Included in **all** drop objects so the market report renders pitcher info for non-qualified rows.

---

## MLB Hitters (Hits)
**Re-added 2026-06-11, shadow-only** (`KXMLBHIT` — singular; shipped 6/11 with the wrong ticker `KXMLBHITS`, fixed 6/12, so shadow data starts 2026-06-12. Previously dropped 2026-05-16 because the user only bet HRR — not a calibration failure). `mlb|hits` is NOT in `passesCategoryGate`, so no UI exposure until shadow ROI confirms at n≥200. Server emits at edge≥3 into `shadow_plays` automatically.

**True%**: exact binomial tail over expected ABs — `binomTailPct(nAB, pHit, threshold)` in `simulate.js` (deterministic, monotonic across alt thresholds by construction; replaces the v0 MC `simulateHits` which assumed a fixed 4 PA).
```
pHit = clamp( hitterEffectiveBA × platoonAdj × (pitcherBAA / 0.248) × parkHitFactor, [0.08, 0.50] )
  hitterEffectiveBA = 0.3·recentBA + 0.7·seasonBA          # B2 recent form (≥20 AB in last 10)
  platoonAdj        = clamp(splitBA / overallBA, [0.88, 1.12])   # batterSplitBA vs opp pitcher hand
  pitcherBAA        = regressed statsapi BAA (matchup key `OPP|TEAM` first — doubleheader-safe)
                      → fallback: opp gamelog H/TBF × 1.12 (TBF deflates BAA ~11%) → league .248
nAB  = own AB/game from blended '25+'26 gamelog (≥15 games)
       × (paFromSpot / hitterTypicalPA)  when both known and |Δ| ≥ 0.3 PA   # same gate as HRR PA-adjust
       fallback: paFromSpot × 0.89, then 3.9
simPct = binomTailPct(nAB, pHit, threshold)
truePct = blend(simPct, ref, capWeight=0.5)                # ref = (primaryPct + softPct)/2, like other sim props
truePct = truePct ≤ 80 ? truePct : 80 + 5·(1 − e^(−0.4·(truePct−80)))   # conservative cap, max ≈85
```
- **Pitcher BAA** (added 2026-06-11): `pitcherBAA[abbr]` in `mlb-pitchers.js`, same two-step `_regressedRate` as WHIP (lgMean .248, priorIP 50) but regressed in ×1000 "points" since `_regressedRate` rounds to 2 decimals. Exported as `sportByteam.mlb.pitcherBAAByTeam` (team + `TEAM|OPP` matchup keys).
- **Cap rationale**: P(≥1 hit) for a good hitter legitimately sits in the mid-70s — the HRR 68-knee cap would crush hits truePcts and fabricate UNDER edges, so hits has its own rawTruePct branch (knee 80, max ≈85; aggressive-shrink doctrine for unproven markets).
- **HRR-λ softPct override is gated to `stat === "hrr"`**: the `batterHRRSplits` Poisson hand-fallback uses λ = (H+R+RBI)/G ≈ 2× a hits rate and would inflate the hits soft ref. Hits gets its platoon signal via `batterSplitBA` inside `pHit` instead.
- **Shares the HRR scaffolding**: Stage-1 lineup-spot 1–5 gate, `hitterSimScore ≥ 5` gate (HRR-flavored components — acceptable proxies), `_mlbLineupConf` (own lineup confirmed + opp pitcher known), dc rules (stat-agnostic), all `hitter*` emit fields.
- **No-sim fallback** (`hitterEffectiveBA` null): rate-based `(primaryPct + softPct)/2` with the hits cap — never the HRR logit path.
- Resolution: shadow resolver `case "hits"` (`ps.hits` from `/api/live`); frontend `liveStats.js` already handled hits.

---

## MLB Hitters (Total Bases)
**Added 2026-06-12, shadow-only** (`KXMLBTB` — ticker verified against the live Kalshi series list; ~200 open markets/day, alt thresholds 2+..6+). `mlb|totalBases` is NOT in `passesCategoryGate` — no UI exposure until shadow ROI confirms at n≥200. `tune:gate` checkpoint ~late July.

**True%**: generalizes the hits binomial — each AB yields 0/1/2/3/4 bases, tail via `tbTailPct(nAB, pHit, shares, threshold)` in `simulate.js` (exact DP convolution; reduces to `binomTailPct` when shares = all-singles, pinned by tests).
```
pHit, nAB  = identical to the hits model (shared computation in the props.js branch)
shares     = [1B, 2B, 3B, HR] per-hit split from blended '25+'26 gamelog (1B = H−2B−3B−HR),
             shrunk toward league [.635, .199, .017, .149] with a 40-hit prior
             (w = hits / (hits + 40)) — small samples don't fabricate or erase power
simPct  = tbTailPct(nAB, pHit, shares, threshold)
truePct = same blend + conservative cap branch as hits (capWeight 0.5, knee 80, max ≈85)
```
- Season/soft threshold rates come free: the `col === "TB"` getStat branch in props.js derives per-game TB = H + 2B + 2·3B + 3·HR from the ESPN gamelog (dormant plumbing from the pre-5/16 era, reactivated).
- `STAT_SOFT["mlb|totalBases"]` shares the hitter soft-teams map (opp starter ERA) with hits/hrr (handlers/tonight.js).
- Shares the full hits/HRR scaffolding: Stage-1 lineup-spot 1–5 gate, simScore ≥5, `_mlbLineupConf`, hitter emit fields. HRR-λ softPct override stays hrr-only (would inflate the TB ref too).
- **UNDER-side market — the only under-direction player prop** (2026-06-12): Kalshi lists TB thresholds 2+..6+ only (no 1+), and P(2+ TB) never prices ≥67, so the YES side can never reach the [67,91] window — all in-window prices are NO ("under 2 TB" ~70–85). The prop parse loop (handlers/tonight.js) admits totalBases when `noPct ∈ [67,91]` and stamps `direction:"under"` + `noKalshiPct`/`noKalshiAO` (both sides depth-blended). **Storage follows the totals convention**: `truePct`/`kalshiPct` stay over-framed on the play and in `shadow_plays`; only the bet-side values flip — props.js computes `edge = (100 − truePct) − noKalshiPct` and gates the window on the NO price; the shadow report SQL flips under rows at read time (`1 − model_true_pct`, `no_kalshi_pct`). `americanOdds` mirrors the bought side (noKalshiAO). All other prop series remain YES-only.

## MLB Pitcher Outs Recorded
**Added 2026-06-23, shadow-only** (`KXMLBOUTS`, `gameType:"mlbOuts"` → `api/lib/tonight/mlb-outs.js`, NOT props.js — props.js is K-coupled, treating any non-strikeouts MLB prop as a hitter). `mlb|outs` is NOT in `passesCategoryGate`. The thesis: outs recorded is a **smoother, more tractable target than the K-count tail** — it's dominated by the manager's batters-faced leash (pitch count / effectiveness), which we already hydrate, rather than a per-PA tail event.

**True%**: a plain Normal workload model.
```
outRate = clamp(1 − (BAA + 0.06), 0.60, 0.74)     # outs per batter faced ≈ 1 − OBP-against
                                                   # (0.685 league fallback when BAA missing)
μ (eOuts) = avgBF × outRate                        # avgBF/stdBF/baa from pitcherStatsByName (name-keyed)
σ         = 0.90 × max(stdBF × outRate, 3.5)       # 0.90×4.5 default when stdBF 0/missing; min 3 GS to rate
truePct("N+ outs") = outsTailPct(μ, σ, N) = (1 − Φ((N − 0.5 − μ)/σ)) × 100   # continuity-corrected
```
- **Emit**: each KXMLBOUTS market is a threshold YES = "N+ outs" (N from `floor_strike + 0.5`). Emits the FAVORITE side — over if YES ∈ [67,91], under (truePct = 100 − over) if NO ∈ [67,91]. Prop-shaped rows (`playerName`/`stat:"outs"`/`threshold`/`direction`) into a dedicated `outsPlays` array → `shadow:staging` only. Alt thresholds compete independently (suffix = threshold), same as spreads.
- **Resolution**: reuses the player-prop path — `shadow.js` `case "outs"` reads `ps.ip` from `/api/live` and converts IP→outs (`"5.2"` = 5⅔ IP = 17 outs); `ps.ip` null/≤0 returns null (retry, never mis-resolve an UNDER as a win on a not-yet-pitched line).
- **σ calibrated against history** (`npm run backtest:outs` → `scripts/backtest/outs-tail-study.js`, 2257 starts 2025-04..06): pooled standardized residual `std(z)=0.897` ⇒ `stdBF×outRate` over-states the start-to-start spread by ~11%, which *under-predicts both favorites* in the [67,91] window (the S-shape: predOver 65%→act 72%, predOver 25%→act 20%). Fixed with `SIGMA_SCALE=0.90`. **The feared early-hook / blowup LEFT tail was disproven** — `P(z≤−2σ)=2.7%` ≈ Normal's 2.3% (mild skew −0.43 lives only in the deep tails we don't bet), so NO skew knob was added. This is an accuracy pre-filter (calibration is backtestable; market edge isn't) — applied before shadow data accrued so it logs under the calibrated σ from day one.
- **Knobs otherwise provisional** (anchored to workload intuition, not Kalshi). Forward-validate before any gate: `tune:gate` +ROI at n≥50 AND non-negative Brier (modelBrier < marketBrier) at n≥200. Next refinement candidate via `tune:residual`: pitcher-specific OBP (vs the league walk constant) + opponent/park.
- **Resolution — statsapi, not ESPN**: ESPN's box score has no TB/2B/3B. `/api/live?tb=1` (opt-in; cache slots suffixed `:tb`) fetches the statsapi schedule once + boxscore per matched MLB game (`MLB_ID_TO_ABBR` match, doubleheaders by closest start time) and merges `totalBases` per batter by diacritic-stripped name. Shadow resolver sends `tb=1` only when the batch has totalBases rows; `case "totalBases"` returns **null when `ps.totalBases` is absent** (merge failure ⇒ skip/retry, never mis-resolved as 0). Prop resolution is direction-aware: `won = isUnder ? actual < th : actual >= th`.
- No frontend: not in AddPickModal/liveStats — add live tracking only if the category is ever promoted.

---

## NBA player props
**True%**: `buildNbaStatDist(gameValues, dvpFactor, paceAdj, isB2B, nSim, miscAdj, paceFactor, recentVals)` → `nbaDistPct`. Dist cached per `playerId|stat` so all thresholds share one distribution. Mean from last 10 with **exponential-decay recency weighting** (added 2026-05-26): `w_i = exp(-ln(2)/HALF_LIFE × i)` where `i` is games-back from most recent. HALF_LIFE=5: game 0 weight 1.0, game 5 weight 0.50, game 10 weight 0.25. Surfaces sustained slumps/hot streaks that flat-10 averaging would hide. Std/variance still use the full sample for stability — exp-decaying variance over-fits to noise. Adjusted: `× teamDefFactor × paceFactor (clamp [0.92, 1.08]) × 0.93 if B2B × miscAdj`. nSim scales with pre-edge simScore (≥8 → 10k, ≥5 → 5k, else 2k).

**Playoff-aware with Bayesian shrinkage (added 2026-05-26)**: when tonight's game is `seasonType === 3` AND the player has ≥5 playoff games, the caller passes `recentVals` = playoff-only gameValues. Both `meanPlayoff` and `meanMixed` are computed with the same exp-decay weighting; `meanRecent = meanPlayoff × w + meanMixed × (1 - w)` where `w = n_playoff / (n_playoff + 10)`. Anchors small playoff samples toward the mixed slice — 7 games → w=0.41, 20 games → w=0.67. Falls back to mixed-only when playoff sample <5. Each gamelog event carries `isPlayoff` boolean (parsed from ESPN `seasonTypes[].displayName`). Same logic mirrors to WNBA and NHL prop branches below.

**SeasonRate blend (added 2026-05-26)**: post-sim, `truePct` is blended toward the empirical threshold hit rate from the player's own gamelog. `truePct = (1-w) × simPct + w × refRate` where `refRate = (seasonPct + softPct) / 2` (soft-tier rate folded in when present, matching the no-sim fallback formula) and `w = min(1, sample/20) × capWeight`. Per-play-type cap weights:
- **NBA / WNBA / NHL player props**: `capWeight = 0.5` (max 50% anchor at 20+ games). Counters pure-sim drift from empirical hit rate at the threshold.
- **MLB strikeouts**: `capWeight = 0.4` (lowered 0.5→0.4 **2026-07-06** via `npm run tune:kblend` — the 7/05 residual sweep flagged the hit-rate family as over-weighted at trusted n; counterfactual re-scoring of resolved shadow rows gave held-out ΔBrier +2.24m at 0.4 with pitcher-start-clustered CI-lo>0, seam-stable, while the rival global-shrink axis failed out-of-sample. The held-out curve kept improving below 0.4, but 0.4 was the train-picked winner — re-run `tune:kblend` at post-cutoff n≥200 before walking it lower). Filter `mlb|strikeouts` calibration `trackedAt < 2026-07-06` (supersedes the 6/13 σ cutoff).
- **MLB HRR**: `capWeight = 0.25` (max 25% anchor). HRR's logit-sigmoid is already rate-based at its core; the blend is a sanity check against multiplicative stacking of park × OPS × WHIP × barrel drift, not a real damper. Preserves most of the matchup signal.

**Pace (since 2026-05-25)**: `paceFactor = (teamPace × oppPace) / (leagueAvgPace²)` — matches the NBA totals math. Replaces the prior linear-delta path `(1 + paceAdj × 0.002)` capped at ±3%, which severely under-projected the ±10% possession swings real matchups exhibit. NHL props still use `paceAdj` (linear shots-against delta — different semantics, kept on the legacy pathway). Emits `nbaPaceFactor`/`wnbaPaceFactor` alongside the existing display-only `nbaPaceAdj`/`wnbaPaceAdj`. Filter `trackedAt < 2026-05-25` for NBA/WNBA player prop calibration across this change.

**`miscAdj` = C2 × C3 × C4**:
- C2 injury boost: `1.08` per Out player on own team, capped 1.15× (from `buildNbaInjuryReport`)
- C3 blowout risk: `max(0.85, 1 − (|spread|−10) × 0.007)` when `|spread| > 10`
- C4 home/away split: `splitMean / overallMean` weighted (0.7 home / 0.3 away)

`teamDefFactor` = general team defense (`rankMap[opp].value / leagueAvg`), NOT position-adjusted. Falls back to `avg(seasonPct, softPct) − 4% if B2B` when sim returns null (<5 game values).

**SimScore**:
- C1 stat-specific opportunity (from `buildNbaUsageRate`):
  - points/assists/threePointers: USG% ≥28→2, ≥22→1, <22→0 (USG% formula: `(avgFGA + 0.44×avgFTA + avgTO) / (avgMin × 2.255) × 100` — ESPN `usageRate` is 0.0 so fallback always runs)
  - rebounds: avgMin ≥30→2, ≥25→1, <25→0
- DVP ratio (`dvpRatio`): ≥1.05→2, ≥1.02→1, else 0
- `nbaSeasonHitRatePts` — `primaryPct` at threshold (≥90→2, ≥80→1, <80→0)
- `nbaSoftHitRatePts` — `softPct` = hit rate vs teams in **same DVP tier** as tonight's opp (rank 1–10 soft, 11–20 neutral, 21–30 hard). ≥90→2, ≥80→1, <80→0.
- `nbaTotalPts` — Game O/U (≥215→2, <215→0). Game totals from `sportByteam.nbaGameOdds`. Pace applied to sim mean but NOT scored.

**Gates**: edge ≥ 3%, nbaSimScore ≥ 8. No soft-matchup pre-filter — all NBA markets enter the play loop.

---

## WNBA player props
Kalshi series: `KXWNBAPTS`, `KXWNBAREB`, `KXWNBAAST`, `KXWNBA3PT`. No team totals on Kalshi (mirrors NHL/NFL).

**True%**: reuses `buildNbaStatDist` + `nbaDistPct`. Cache key `wnbaPlayerDistCache[playerId|stat]`. Same formula as NBA: `× teamDefFactor × (1 + paceAdj×0.002) × 0.93 if B2B × wnbaMiscAdj`. nSim scales with pre-edge simScore.

**Anchor**: 2025 season as base; 2026 trust ramps `vals26.length/10` (vs NBA's `/15`) because the WNBA season is ~40g vs 82g, so equivalent trust accumulates faster relative to season length.

**SimScore — calibrated to WNBA scoring environment**:
- C1 opportunity (from `buildWnbaUsageRate`):
  - points/assists/threePointers: USG% ≥27→2, ≥22→1, <22→0 (vs NBA 28/22 — slightly compressed)
  - rebounds: avgMin ≥27→2, ≥22→1, <22→0 (vs NBA 30/25 — 40-min game vs 48)
- DVP ratio (`dvpRatio`): ≥1.05→2, ≥1.02→1, else 0 (same tiers as NBA, single-tier from `buildWnbaDvp` aggregate — no per-position split, no BettingPros equivalent)
- `wnbaSeasonHitRatePts` — `primaryPct` at threshold (≥90/≥80, same as NBA)
- `wnbaSoftHitRatePts` — same DVP-tier matching as NBA
- `wnbaTotalPts` — Game O/U: ≥168→2, ≥158→1, <158→0 (vs NBA 215/215; WNBA totals run 150–175)

**USG fallback formula adjustment**: `(avgFGA + 0.44·avgFTA + avgTO) / (avgMin × 1.88) × 100` — coefficient 1.88 = NBA's 2.255 × (40/48) to rescale for 40-min game. Without this rescale, WNBA USG would be ~20% inflated relative to NBA tiers.

**Gates**: edge ≥ 3%, wnbaSimScore ≥ 8.

---

## NHL Points
**True%**: reuses `buildNbaStatDist` + `nbaDistPct`. Cache key `nhlPlayerDistCache[playerId|stat]`. Adjusted: `× teamDefFactor × (1 + shotsAdj×0.002) × 0.93 if B2B × nhlToiTrendAdj`. `teamDefFactor` = opp GAA / league avg.

**D3 TOI trend** (passed as `miscAdj`): `clamp(recent3TOI / last10TOI, 0.92, 1.08)`. Only applied when ratio >1.05 or <0.95.

**SimScore**:
- `nhlOpportunity` — Avg TOI last 10 (≥18min→2, ≥15min→1, <15→0)
- `_gaaRank` — Opp GAA rank (≤10→2, ≤15→1, else 0)
- `nhlSeasonHitRatePts` — Career rate at threshold (≥90→2, ≥80→1, <80→0)
- `nhlDvpHitRatePts` — Rate vs teams with GAA > league avg (≥3 qualifying games; ≥90→2, ≥80→1, <80→0)
- `nhlGameTotal` — O/U line (≥7→2, ≥5.5→1, <5.5→0)

Display-only: `nhlSaRank`, `nhlTeamGPG`. **B2B detection**: last gamelog event was yesterday UTC.

---

## NFL
Stats: `passingYards`, `rushingYards`, `receivingYards`, `receptions`, `completions`, `attempts`. Gate: opp in soft teams; edge ≥ 3%.

---

## Game Totals (MLB/NBA/WNBA/NHL/NFL)
Kalshi series: `KXMLBTOTAL`, `KXNBATOTAL`, `KXWNBATOTAL`, `KXNHLTOTAL`, `KXNFLTOTAL`. `gameType: "total"`. Market format: `floor_strike = N` means YES = total ≥ N (i.e. "over N−0.5").

**WNBA totals**: same possession-based projection as NBA but with `wnbaPaceData` (2025 anchor). Per-team std=11 (WNBA scoring variance roughly NBA × (40/48); empirical game-total std ~13–15). **SimScore tiers retuned**: Comb OffRtg/DefRtg ≥98/≥93 (vs NBA 118/113), Pace > leagueAvg+1 (vs +2), O/U ≥168/≥158 (vs 225/215). Pace data from ESPN `avgEstimatedPossessions` (no separate `paceFactor` field for WNBA). Sample-weighted seasonHitRate blend via `_ssnBlendWeight`, same as NBA/MLB/NHL. Same injury-adjusted OffRtg as NBA (2026-05-17, 0.15 replacement factor, cap 0.85) — WNBA rosters are smaller and stars carry larger usage shares, but starting with the same factor for calibration parity (adjust later if data shows under-correction).

**True%**: NegBin MC for MLB (added 2026-05-24), Poisson MC for NHL, Normal for NBA/WNBA. `_simData` includes per-team expected and `expectedTotal`. **All four sports blend `gtSeasonHitRate` into the lambda PRE-sim** (changed 2026-05-13 from post-sim truePct blend) — for the threshold being predicted, solve for the rate that would produce the observed seasonHitRate, then sample-weighted blend with model lambda.
- **MLB (NegBin since 2026-05-24)**: `impliedLambda = muForNegBinTail(threshold, ssnRate/100, r)`; `blendedLambda = (1-w) × modelLambda + w × impliedLambda`; `truePct = (1 - negBinCDF(threshold-1, blendedLambda, r)) × 100`. Per-team draws via `negBinSample(λ, r)` (Poisson-Gamma mixture). `r` = league-wide pooled MoM dispersion fit from `_gtScheduleMap` per request — pooled per-team residuals → `r = pooled_mean² / (pooled_var − pooled_mean)`, clamped [3, 50], fallback `r=8` when `nGames < 100`. Real MLB game totals are ~2× overdispersed vs Poisson (fat-tail big-inning behavior + thin no-hit left tail); the prior Poisson sim systematically overstated tail probabilities at far-from-line alt thresholds (May 2026 audit: 79% predicted, 54% actual on n=24 alt totalRuns). `_simData.mlbDispR` records the fit value per pick for audit. Filter MLB total / ML / spread calibration by `trackedAt < 2026-05-24`.
- **NHL (still Poisson)**: `impliedLambda = lambdaForPoissonTail(threshold, ssnRate/100)`; `blendedLambda = (1-w) × modelLambda + w × impliedLambda`; `truePct = (1 - poissonCDF(threshold-1, blendedLambda)) × 100`. NHL hasn't been audited for overdispersion yet; phase 2.
- Normal sports: `impliedMean = meanForNormalTail(threshold, ssnRate/100, totalStd)` (closed form via inverse Φ); `blendedMean = (1-w) × modelMean + w × impliedMean`; `truePct = (1 - normCDF(threshold - 0.5, blendedMean, totalStd)) × 100` (with 0.5 continuity correction).
- Total std (Normal): `sqrt(homeStd² + awayStd²)` — NBA std=13 per team → ~18.4 total; WNBA std=11 per team → ~15.6 total.
- Why pre-sim: clean attribution. seasonHitRate is now an upstream lambda input, comparable to FIP/ERA/WHIP/RPG via counterfactual Δ rather than a separate post-hoc correction.
- `_gtSeasonHitRate(sport, home, away, thr)` helper returns `{ rate, sample }` — average of home + away team's season rate of games where combined score ≥ threshold; requires ≥5 schedule games per team. Sample = `min(home games, away games)`. `_ssnBlendWeight(sample) = min(1, sample/40) × 0.7` — observations earn up to 70% weight at N≥40, model retains a 30% minimum for tonight-specific factors.
- Saves `modelTruePct` (pre-blend), `gtSeasonHitRate`, `gtSsnSample`, `modelLambda`/`impliedLambda`/`blendedLambda` (or `modelMean`/`impliedMean`/`blendedMean` for Normal) in `_simData`.
- `_gtScheduleMap` populates both teams for every sport that has game totals; `_SCHED_TO_ESPN` translates canonical → ESPN team-route slug for MLB CWS→CHW and NHL TBL→TB / NJD→NJ / LAK→LA / SJS→SJ.

**MLB edge dampener — REMOVED 2026-05-15**: previously when `|threshold − gameOuLine| ≥ 3`, `overEdge`/`underEdge` were multiplied by 0.7. Removed because (1) it was a pre-calibration heuristic, (2) dataConfidence's threshold-distance penalty now handles tail-skepticism at the gate level (one signal instead of two), (3) MLB getting a tail dampener while NBA didn't biased calibration audits. Re-introduce only if the 2026-05-27 calibration audit shows MLB tails systematically over-hit. See `project-mlb-tail-dampener-removal`.

**Schedule fetch abbr translation**: `_gtScheduleMap` (game totals) and `_ttScheduleMap` (team totals) translate canonical → ESPN team-route slug before building the schedule URL — mirrors `CANONICAL_TO_ESPN` in `/api/live`. `_SCHED_TO_ESPN` covers MLB `CWS → CHW` and NHL `TBL → TB / NJD → NJ / LAK → LA / SJS → SJ`. Cache keys keep the canonical form so cached reads are consistent. Without this, schedules for affected teams silently fetched as empty arrays, breaking H2H and game-total seasonHitRate blends for any matchup involving them.

**ESPN schedule event abbrs are NOT canonical** — they're whatever ESPN puts on each competitor (e.g. `c.abbr === "CHW"` in the events even when fetched via the `chw` slug). **Any consumer of `_gtScheduleMap` / `_ttScheduleMap` events that filters by team abbr must normalize via `normTeam(sport, c.abbr)` before comparing to canonical scoringTeam/oppTeam values.** Three sites had silent bugs where this was missing: `_gtH2HRate`, `_ttRunVals` (teamL10RPG), `_ttSeasonHits` (ttSeasonHitRate) — all caused CWS team-total picks to read `ttSeasonHitRate=0` because filters didn't match `CHW`-form abbrs. NBA equivalents (`_nbaGtH2HRate`, `_ttNbaSeasonHits`) already used `normTeam`. This is the third instance of the canonical-vs-ESPN-abbr divergence (after live-API translation and schedule URL slugs); always normalize when filtering ESPN-sourced events.

**Lambda / projection formulas**:

*MLB*:
```
whipAdj(whip)         = clamp((whip/1.30)^0.5, [0.90, 1.10])
ttoBump(expectedBF)  = 1 + clamp((expectedBF − 22)/22 × 0.30, [0, 0.10])           # 3rd-TTO penalty on FIP+ERA (since 2026-05-25)
restBump(calDays)    = calDays ≤ 4 ? 1.08 : calDays === 5 ? 1.04 : 1.0              # days-rest penalty (calendar diff: 4=3-days-rest short, 5=4-days-rest, 6+=normal)
# Pitcher vs-L/vs-R split modifiers (since 2026-05-25). Switch hitters bat opposite the starter's hand.
lFrac(oppLineup, starterHand) = (oppLineup.l + (starterHand=="R" ? oppLineup.s : 0)) / total
fipMod(starter, lFrac) = lFrac × splits[starter].vlFipMod + (1-lFrac) × splits[starter].vrFipMod   # 1.0 = no platoon
whipMod analogous; fipEff = fip × fipMod; whipEff = whip × whipMod
starterMult(fipEff, era, whipEff, tto, rest)
                      = (0.5×(fipEff×tto×rest/4.20) + 0.5×(era×tto×rest/4.20)) × whipAdj(whipEff)   # ERA not split-exposed
restERA(team)        = bullpenERA[team] ?? teamERA[team]                          # bullpen preferred (cleaner rest-of-game proxy)
awayMult = 0.6 × starterMult(awayFipEff, awayERA, awayWhipEff, ttoBump(awayBF), restBump(awayDaysRest)) + 0.4 × (restERA(away)/4.20)
homeMult = 0.6 × starterMult(homeFipEff, homeERA, homeWhipEff, ttoBump(homeBF), restBump(homeDaysRest)) + 0.4 × (restERA(home)/4.20)
homeLambda₀ = homeRoadRPG × awayMult × parkRF × homePlatoonFactor × umpireRunFactor × homeLineupFactor   # clamped [1,12]  (weather removed 2026-06-23)
awayLambda₀ = awayRoadRPG × homeMult × parkRF × awayPlatoonFactor × umpireRunFactor × awayLineupFactor   # clamped [1,12]  (weather removed 2026-06-23)
# Regime-aware blend (since 2026-05-25, 14-day half-life via _MLB_HALF_LIFE_DAYS):
homeLambda = (1 − w) × homeLambda₀ + w × homeRecentMean
awayLambda = (1 − w) × awayLambda₀ + w × awayRecentMean
# w = _regimeBlendWeight(min(homeSample, awaySample)) — caps at 0.85
```
- **Bullpen-only ERA folded into the 40% rest-of-game share 2026-05-17** (was whole-staff teamERA). Whole-staff ERA includes the starter who's already counted in the 60% term — double-count. Bullpen-only (`playerPool=bullpen` on MLB Stats API team-stats endpoint, one extra fetch in the MLB hydration Promise.all) is the clean rest-of-game proxy and typically runs 0.10–0.40 ERA below whole-staff. `_simData` adds `homeBullpenERA`/`awayBullpenERA` (value used) and `homeBullpenSource`/`awayBullpenSource` (`"bullpen" | "team" | null`). Same swap applied to team-total lambda via `oppBullpenERA`/`oppBullpenSource`. dataConfidence penalty -1 per side when source is `"team"` (game total max -2; team total max -1).
- 60/40 weights unchanged — workload-weighted starter share (`starterShare = expectedBF/38`) is the natural follow-up tunable but kept fixed for now so calibration can isolate the bullpen-separation impact alone.
- WHIP folded into lambda 2026-05-13 (was SimScore-only). Exponent 0.5 dampens overlap with FIP/ERA. Same adjustment applied to team-total `oppMult`.
- **FIP** (`api/lib/mlb.js` `_seasonFIP`): `((13×HR) + (3×(BB+HBP)) − (2×K)) / IP + 3.10` per season. Constant 3.10 aligns FIP onto the ~4.20 ERA scale. IP parsed from MLB Stats API string format ("45.2" = 45 ⅔). Strips fielding/sequencing luck from the starter signal — a "lucky" starter (low ERA / high FIP) gets penalized, an "unlucky" one (high ERA / low FIP) gets credit. ERA stays as the second half of the starter blend so observed run prevention still counts. `pitcherFIPByTeam` exported from `buildPitcherKPct` and surfaced as `homeFIP`/`awayFIP` in `_simData`.
- **Two-step pitcher rate regression (ERA / WHIP / FIP, added 2026-05-18)** — `_regressedRate` helper in `api/lib/mlb.js`: (1) blend 2026↔2025 by `trust26 = min(1, gs26/15)`, (2) shrink the blended estimate toward league mean by `priorIP` weight. Effective sample = `ip26 + (1−trust26)×ip25`; final = `(ip × blended + priorIP × lgMean) / (ip + priorIP)`. Constants: **ERA** lgMean=4.20, priorIP=50; **WHIP** lgMean=1.30, priorIP=50; **FIP** lgMean=4.20, priorIP=30 (FIP stabilizes faster — ~100 IP vs ~150 for ERA). Replaces the prior raw-2026-or-fall-back-to-2025 lookup for ERA/WHIP, and adds the league-anchor step to FIP (was only doing step 1). The lambda code at `api/[...path].js` (game-total ~3244, team-total ~3807, HRR ~2091) was separately patched to prefer `sportByteam.mlb.pitcherEra[t]` (regressed) over `sportByteam.mlb.probables[t].era` (raw schedule hydrate) — without this, the lambda would still see raw probables ERA even with the regression in place. FIP/WHIP go through `pitcherFIPByTeam`/`pitcherWHIPByTeam` so they pick up the regression directly. Net effect: extreme small-sample seasons pull meaningfully toward 4.20/1.30 while full-season ace/scrub gaps survive. MLB-K unaffected (uses regressed `pitcherKPct`/`pitcherCSWPct`, not ERA/WHIP). Pre-2026-05-18 MLB total/team-total/ML calibration data used raw rates — filter `trackedAt < 2026-05-18` when comparing lambda accuracy.
- **Platoon factor**: `(lineup composite BA vs starter's hand) / (lineup composite overall BA)` from `batterSplitBA`. Falls back to 1.0 when hand unknown or sample <80 AB. **Note**: MLB Stats API `/teams/stats` does NOT support pitcher-handedness sitCodes (`vl/vr` returns empty) — handedness splits are individual-only. Same factor applied to team total lambda.
- **Weather factor — REMOVED 2026-06-23 (model-honesty fix).** Was `1 + windOutMph × 0.013 + (tempF − 72) × 0.001`, clamped [0.85, 1.15], applied to game/team/F5 run λ. The historical pre-filter (`scripts/backtest/weather-runs-study.js`) found wind-out r≈−0.02 and temp r≈0.00 on **total runs** (vs r≈+0.12 on HR) — the HR weather signal dilutes ~8:1 in total scoring, so the factor carried no run-scoring support; it was carried over from the HR result. Weather stays in **HRR** (`props.js`, validated on HR). The ESPN `displayValue` parse (`_parseWind`) still populates the debug `mlbMeta.weather`. **Filter `mlb` totalRuns/teamRuns/ml/spread/f5* calibration `trackedAt < 2026-06-23` when comparing λ accuracy.**
- **Road RPG**: from MLB Stats API `sitCodes=A`, stored as `mlbRoadRPGMap`.
- `umpireRunFactor = 1 / UMPIRE_KFACTOR` applied to both lambdas (and team total lambda).
- **Pitcher vs-L/vs-R split modifiers (added 2026-05-25)**: `buildPitcherKPct` fetches `statSplits` with `sitCodes=vl,vr` for every scheduled pitcher in 2026 + 2025. ERA isn't exposed on these endpoints (returns null), but K/BB/HR/IP and WHIP are — enough to compute split-FIP and use exposed split WHIP. Each split rate is shrunk toward the overall regressed value with `PRIOR_IP=20` (see `_regressedRate`); the resulting ratio (`splitRate / overallRate`) is a multiplicative modifier, 1.0 means no platoon. `pitcherSplitsByTeam[abbr] = { vlFipMod, vrFipMod, vlWhipMod, vrWhipMod, vlBf, vrBf }`. `buildLineupKPct` returns `lineupHandByTeam[abbr] = { l, r, s }` (counts of L/R/Switch bats in tonight's projected lineup, ≥6 required). Effective rates: `effFIP = overallFIP × (lFrac × vlFipMod + (1−lFrac) × vrFipMod)`; same for WHIP. ERA stays at overall (not split-exposed). Falls back to overall when split or lineup data missing. ML/spread inherit. `_simData` adds `home/awayOppLFrac`, `home/awayFipMod`, `home/awayWhipMod`, `home/awayFipEff`, `home/awayWhipEff` when present. Filter `trackedAt < 2026-05-25` from MLB total/team-total/ML/spread calibration for this change.
- **Days-rest bump on starter (added 2026-05-25)**: short rest costs ~0.30 ERA on 3-days-rest (calendar diff 4), ~0.15 on 4-days-rest (calendar 5); 5+ days rest (calendar 6+, the normal 5-day rotation) is unbumped. Multiplier (1.08 / 1.04 / 1.0) applied alongside `ttoBump` to FIP+ERA inputs. MLB convention: "X days rest" = X full off-days between starts, so calendar diff = MLB-days-rest + 1. Skips when `pitcherLastStartDate` is unavailable. ML/spread inherit. `_simData` adds `homeDaysRest`/`awayDaysRest` + `homeRestBump`/`awayRestBump` when bump > 1.0. Filter `trackedAt < 2026-05-25` for MLB total/team-total/ML/spread calibration.
- **TTO penalty on starter (added 2026-05-25)**: 3rd-time-through-order PAs run ~0.50 ERA / 15% wOBA higher than 1st. When `pitcherAvgBF[team] > 22`, the starter's FIP and ERA inputs are multiplied by `ttoBump = 1 + clamp((expectedBF − 22)/22 × 0.30, [0, 0.10])` — ramps from 1.0 at BF=22 to 1.10 at BF≥29. WHIP is a traffic measure (not run-rate) so it stays untouched. ML/spread inherit via `_mlbMlContext`. `_simData` adds `homeExpectedBF`/`awayExpectedBF` + `homeTtoBump`/`awayTtoBump` when bump > 1.0. Filter `trackedAt < 2026-05-25` from MLB total/team-total/ML/spread calibration for this change.
- **Regime-aware lambda blend (added 2026-05-25)**: parallels the 2026-05-21 NBA/WNBA/NHL change with a 14-day half-life (MLB plays daily; faster turnover). `_recentTeamScoreMean(_gtScheduleMap, "mlb", team, _MLB_HALF_LIFE_DAYS)` computes the team's recency-weighted recent-runs mean and blends with the pitcher-matchup-derived λ via `_regimeBlendWeight` (cap 0.85, denom 8). ML/spread inherit. `_simData` adds `regimeBlendW`, `homeRecentMean`, `awayRecentMean` when blend fires. Same calibration cutoff as TTO.
- **Market-line anchor + tighter blend clamp (added 2026-06-01)**: the 6/1 calibration found MLB totalRuns overs +17 overconfident (Δ −26.5 side-aware, n=21; ROI −6.2%). Root cause: the regime blend and the seasonHitRate→implied-λ blend both push λ **upward**, and at low thresholds (over far below the mean) the season hit rate ≈ 100% so the solved implied λ is high — the ±1.5 clamp didn't contain it (live example `modelLambda 8.76 → blendedLambda 9.81`). `mlbDispR` was healthy (~3.4), so this is a **mean** bias, not variance. Two **game-total-only** fixes (teamRuns + F5 untouched): **(A)** the seasonHitRate blend clamp `_cap` is hardcoded **0.75** (was `_GT_IMPLIED_CAP.mlb` = 1.5) — decoupled from the `dc.js` `seasonRateDivergent` penalty (still keyed on 1.5), so the same plays qualify/drop and only the blend math softens. **(B)** `_anchorTotalLam(λ) = 0.75·λ + 0.25·gameOuLine` (gated to lines ∈ [5,14]) pulls the final total λ toward the market O/U line — the sharpest mean prior. Applied to the no-season joint sim via `_lamScale = _anchorTotalLam(_hLam+_aLam)/(_hLam+_aLam)` on each team λ, and to the season-blend `_blendedLambda`. **Local to the total truePct only**: `_mlbMlContext` keeps the RAW λ, so the healthy (+11% ROI) ML/spread surfaces are untouched. Self-targeting — biggest pull where the model diverges most from the market, negligible on games already near the line. Filter `trackedAt < 2026-06-01` from MLB totalRuns calibration.
- **Lineup / pitcher-injury adjustment (added 2026-05-18)**: each team's λ is multiplied by `lineupFactor(topOut)` — `0/1/2/3+ → 1.0/0.98/0.96/0.93` — where `topOut` counts FRESH hitter absences (status `out` / `day-to-day` / `questionable` / `doubtful` / `game-time`) from `sportByteam.mlb.injuryByTeam[team]`, excluding pitchers (by `pos` ∈ {P, SP, RP} OR by ID match against `pitcherInfoByTeam[team].id`). **Long-IL stays (10/15/60-Day-IL) are EXCLUDED** — those players are replaced on the roster and team RPG already reflects life without them. Probable pitcher on IL (ID match) → starter inputs nulled → existing fallback uses bullpen-only ERA (catches lag between IL announcement and ESPN probable update). Same logic mirrors to team-total λ via `scoringLineupFactor` + `oppPitcherOnIL`. ML + spread inherit via `_mlbMlContext`. `buildMlbInjuryReport` in `api/lib/mlb.js` (ESPN endpoint, `mlb:injuries:v2:{date}` 30min cache, CHW→CWS normalization). dataConfidence: -1 per side at `topOut ≥ 2`, -2 per side at `pitcherOnIL`. Player props are NOT affected (HRR uses `hitterLineupSpot`; K uses `lineupKPct` — both already lineup-aware). Filter `trackedAt < 2026-05-18` for total/teamTotal/ML/spread calibration across this change.

*NHL*:
```
# Opponent factor prefers tonight's goalie SV% when known; falls back to team GAA.
goalieFactor(goalieSV, teamGAA) = goalieSV != null
  ? (1 - goalieSV) / (1 - leagueAvgSV)   # goals-allowed-per-shot, league-normalized
  : (teamGAA / leagueAvgGAA)              # fallback when no qualified starter
# Special-teams adjustment (since 2026-05-25): own PP advantage + opp PK weakness.
# 0.20 weight ≈ PP+PK goals as a share of all NHL scoring.
stAdj(ownPP, lgPP, oppPK, lgPK) = clamp(1 + ((ownPP − lgPP) + (lgPK − oppPK)) × 0.20, [0.90, 1.10])
homeLambda = homeGPG × goalieFactor(awayGoalieSV, awayGAA) × stAdj(homePP, lgPP, awayPK, lgPK)  # clamped [0.5, 8]
awayLambda = awayGPG × goalieFactor(homeGoalieSV, homeGAA) × stAdj(awayPP, lgPP, homePK, lgPK)  # clamped [0.5, 8]
```
- **PP/PK adjustment (added 2026-05-25)**: PP+PK goals are ~20% of NHL scoring; team aggregates (GPG / GAA / SV%) flatten ST advantage. `buildNhlSpecialTeams` (`api/lib/nhl.js`) fetches `stats/rest/en/team/powerplay` + `team/penaltykill` once per request (cache `nhl:specialteams:20252026`, 6h TTL) and stores `{ ppPct, pkPct, ppOppPerGame, penaltiesPerGame }` per abbr on `sportByteam.nhl.specialTeams.byTeam`. Net-ST factor clamped at ±10%. Missing data on either side → factor = 1.0 (no adjustment, fail-soft). ML/spread inherit via `_nhlMlContext`. `_simData` adds `homePPPct`, `awayPPPct`, `homePKPct`, `awayPKPct`, `homeSTAdj`/`awaySTAdj` when non-trivial. Filter `trackedAt < 2026-05-25` from NHL total/ML/spread calibration.
- **Goalie SV% source**: `buildNhlGoalieData` (`api/lib/nhl.js`) hits `stats/rest/en/goalie/summary` once per hydration (cache `nhl:goaliepool:20252026`, 6h TTL), filters to goalies with ≥5 regular-season starts, picks the team's max-GS goalie as the "primary starter". League-avg SV% is the GS-weighted mean of the same pool. NHL's pre-game endpoints don't reliably expose tonight's confirmed starter, so we treat each team's season-leading starter as the goalie of record — true ~75%+ of nights in regular season and ~90% in playoffs. When the backup actually starts, team-GAA fallback would have been equally biased (it averages across both), so swapping to primary-goalie-SV% nets ahead in expectation.
- **Why SV% not GAA per goalie**: SV% is per-shot and independent of team shot-allowed volume (already captured in `homeGPG`/`awayGPG`). GAA conflates the two.
- `_simData` for NHL game totals adds: `homeGoalie`, `awayGoalie`, `homeGoalieSV`, `awayGoalieSV`, `homeGoalieSource`/`awayGoalieSource` (`"starter"|"team"`), `leagueAvgSV`. dataConfidence penalty -1 per side when source is `"team"` (max -2).

*NBA* (possession-based):
```
projPace = (homePace × awayPace) / leagueAvgPace                        # geometric mean
# Injury-adjusted OffRtg: reduce by sum-of-Out-player-USG × replacement penalty (0.15), cap [0.85, 1.00].
offRtgAdj(team)    = clamp(1 - Σ(usg[Out players on team])/100 × 0.15, [0.85, 1.00])
homeOffRtgAdj      = homeOffRtg × offRtgAdj(home)
awayOffRtgAdj      = awayOffRtg × offRtgAdj(away)
homeExpected = (homeOffRtgAdj × awayDefRtg / leagueAvgOffRtg²) × projPace
awayExpected = (awayOffRtgAdj × homeDefRtg / leagueAvgOffRtg²) × projPace
# Playoff scoring boost when seriesSummary non-null on either team:
#   homeExpected *= _PLAYOFF_OFF_BOOST  (1.04)
#   awayExpected *= _PLAYOFF_OFF_BOOST
```
OffRtg/DefRtg from same ESPN team-stats call as pace. `nba:pace:2526` stores `teamOffRtg`, `teamDefRtg`, `leagueAvgOffRtg`, `leagueAvgDefRtg`. `_PLAYOFF_OFF_BOOST` is a single tunable at the top of the tonight handler — RS-aggregate ratings systematically under-projected playoff totals (LAL/OKC G3 = 232 vs model 199 vs market 210.5); +4% closes most of the model-vs-market gap. Surfaced as `playoffBoost: 1.04` in `_simData` when applied. Same boost applied to NBA team totals (`_teamExpected *= _PLAYOFF_OFF_BOOST`).
- **Injury OffRtg adjustment added 2026-05-17**: previously totals lambda used season-to-date OffRtg unchanged regardless of who's Out tonight. Now we sum the USG% of every Out player (via `nbaInjuryMap` × `nbaUsageMap`) and apply a 0.15 replacement-penalty factor. Empirical calibration: losing LeBron (28% USG) drops Lakers ~4.2% OffRtg, matching real-world LAL-without-LeBron data. Cap at 0.85 prevents multi-star scenarios from cratering lambda. DefRtg intentionally NOT adjusted — losing a defensive specialist has no clean usage proxy. Supplementary `buildNbaUsageRate` call after the parallel hydration backfills usage for injured players who don't have Kalshi prop markets tonight (e.g., 7th-man bench star out). `_simData` adds `homeOffRtgAdj`, `awayOffRtgAdj`, `homeUsageOut`, `awayUsageOut`, and `homeOffRtgFactor`/`awayOffRtgFactor` (omitted when factor = 1.0). Same swap applied to NBA team-total lambda via `teamOffRtgAdj`/`scoringUsageOut`/`scoringOffRtgFactor`. **No dataConfidence penalty** — adjustment makes lambda more accurate, not less.
- **B2B dampener added 2026-05-17**: B2B = most-recent completed schedule event's PT date == yesterday's PT date (via `_isTeamB2B(sport, team)` reading `_gtScheduleMap` event dates). Per-sport multiplier folded into the offense path (NBA/WNBA) or into the opponent goalie factor (NHL):
  - NBA / WNBA total: **TRANSFER model (2026-06-22, was one-sided ×0.975).** The historical study (`scripts/backtest/nba-rest-study.js`, 2024-25) found B2B drops **margin** ~3.1 pts (−3.12 ± 0.75) but the **game total ~0** (−0.37, n.s.) — a tired team scores less AND defends worse, so the rested opponent compensates. The old one-sided cut (tired team only) correctly shifted margin but wrongly dropped the total ~2.8. Now each team's OffRtg = `(selfB2B ? B2B_*_SELF=0.988 : 1) × (oppB2B ? B2B_*_OPP=1.012 : 1)` → margin preserved (~−2.7), total nets ≈ 0. Since totals + ML + spread + halves all read the same per-team λ (`_homeExpRaw`/`_awayExpRaw` → `_nbaMlContext`), one change fixes every surface. NBA team total adds the opp-B2B term (`_ttOppB2B`) for the "score more vs a tired defense" lift. WNBA inherits the NBA magnitude (structure is sport-agnostic; WNBA magnitude unvalidated → flag a `backtest:wnbarest`). FORMULA_CUTOFF 2026-06-22 on `nba|total`/`nba|teamTotal`/`wnba|total`/`wnba|teamTotal` (margin-preserving → ML/spread NOT cut off).
  - NHL total: `_homeFactor *= 1.05 if away B2B`, `_awayFactor *= 1.05 if home B2B` (B2B team gives up ~3–5% more goals — goalie fatigue, occasional backup start). Partial counter to the Tier-1 #1 primary-goalie SV% assumption on B2B nights.
  - MLB: skipped — every day is "B2B"; concept doesn't apply.
  - `_simData` emits `homeB2B`/`awayB2B` (true) and `homeB2BFactor`/`awayB2BFactor` when fired (omitted otherwise). NBA team total emits `scoringB2B`/`scoringB2BFactor`.
  - Schedule parse (`_parseSchedEvts`) now keeps event `date`. Cache key bumped `teamschedule:v2 → v3` to evict date-less entries.

**SimScore — MLB**: homeWHIP, awayWHIP (>1.35→2, >1.20→1, ≤1.20→0), combinedRPG (`homeRPG+awayRPG`; ≥10.5→2, ≥8.5→1), H2H combined hit rate% (homeScore+awayScore ≥ threshold last 10 H2H; ≥3 games required), O/U line (≥9.5→2, ≥7.5→1). WHIP fallback: `pitcherWHIPByTeam[abbr]` → `teamWHIPMap[abbr]` → 1pt abstain. `homeWHIPSource`/`awayWHIPSource` = `"starter"|"team"|null` flags which path fired (covers debut/late-announcement starters).

**SimScore — NBA**: combined pace (both > lgAvg+2 → 2, one > lgAvg → 1), `combOffRtg = (home+away)/2` (≥118→2, ≥113→1), `combDefRtg` (same), `nbaGtH2HRate` (combined score ≥ threshold last 10 H2H; ≥3 games), O/U (≥225→2, ≥215→1).

**SimScore — NHL**: homeGPG, awayGPG, homeGAA, awayGAA (all ≥3.5→2, ≥3.0→1, <3.0→0), O/U (≥7→2, ≥5.5→1).

**UNDER inverted tiers** (representative): MLB WHIP ≤1.10→2, ≤1.25→1; NBA OffRtg/DefRtg <113→2, <118→1; NHL GPG/GAA <3.0→2, <3.5→1; H2H ≤30→2, ≤50→1; O/U inverts thresholds.

**Component point fields are direction-correct** (game totals + team totals): every play stores per-component `*Pts` fields (`homeWhipPts`, `combOffRtgPts`, `ttSeasonHitRatePts`, etc.) reflecting the bet direction. OVER picks store OVER-tier point values; UNDER picks override the same field names with UNDER-tier values via `_underComponents` / `_ttUnderComponents` / `_nttUnderComponents` spread last. **Pre-2026-05-08 UNDER picks have OVER-tier values stored** — calibration analysis on `direction === "under"` rows must filter by `trackedAt >= 1778270400000` (epoch ms for 2026-05-08T16:00Z) to trust per-component fields. Umpire is **not** a SimScore component (the run factor is applied to lambda directly); `ttUmpirePts` was dropped from the API response on 2026-05-08.

**Dedup**: one play per game (homeTeam+awayTeam+sport) — best edge wins across OVER+UNDER AND across game total vs team total. Track ID: `total|sport|home|away|threshold|gameDate[|under]`.

**`Kalshi O/U fallback (NBA + MLB + NHL)`**: Built via `_buildKalshiOuMap(sport, ticker)` from all KX{SPORT}TOTAL markets (unfiltered pct). Highest threshold where YES ≥ 50%, set `total = threshold − 0.5`. Three call sites populate `sportByteam.nbaGameOdds`, `sportByteam.mlb.gameOdds`, `sportByteam.nhlGameOdds` for any team missing a `total`. Originally NBA-only (ESPN omits odds for live/imminent games); MLB+NHL added 2026-05-07 because today's ESPN scoreboard never carries tomorrow's odds and `mlbMetaTomorrow.gameOdds` is intentionally empty — without the fallback, every tomorrow MLB/NHL game total play renders with O/U "—".

---

## Team Totals (MLB, NBA only)
Kalshi series `KXMLBTEAMTOTAL`, `KXNBATEAMTOTAL`. `gameType: "teamTotal"`. NHL/NFL absent on Kalshi. Scoring team extracted from ticker suffix (e.g. `LAD8` → LAD).

**True%**:
- MLB: `simulateTeamTotalDist(lambda)` Poisson. `oppMult = 0.6 × starterMult(oppFIP, oppERA, oppWHIP) + 0.4 × (oppTeamERA/4.20)` (FIP/ERA/WHIP starter blend, same as game totals). `lambda = teamRPG × oppMult × parkRF × platoonFactor × umpireRunFactor`, clamped [0.5, 12]  (weather removed 2026-06-23 — see game-total Weather factor note). **Pre-sim lambda blend**: `impliedLambda = lambdaForPoissonTail(threshold, ttSeasonHitRate/100)`; `blendedLambda = (1-w) × lambda + w × impliedLambda` where `w = min(1, sample/40) × 0.7`. truePct from analytical `1 - poissonCDF(threshold-1, blendedLambda)`. `modelTruePct`, `ttImpliedLambda`, `ttBlendedLambda` stored in debug output.
- NBA: `simulateTeamPtsDist(mean, std=11)` Normal. `mean = (teamOffRtg × oppDefRtg / lgOffRtg²) × projPace`. `oppDefRtg = oppDefPPG/oppPace × 100`. **Pre-sim mean blend**: `impliedMean = meanForNormalTail(threshold, ttNbaSeasonHitRate/100, 11)`; `blendedMean = (1-w) × mean + w × impliedMean`. truePct from analytical `1 - normCDF(threshold - 0.5, blendedMean, 11)`. `modelTruePct`, `ttNbaImpliedMean`, `ttNbaBlendedMean` stored in debug output.

**SimScore — MLB OVER**: seasonHitRate% (≥80→2, ≥60→1), oppWHIP (>1.35→2, >1.20→1), teamL10RPG (>5.0→2, >4.0→1), H2H HR% (≥80→2, ≥60→1), O/U (≥9.5→2, ≥7.5→1). `oppWHIP` uses same starter→team fallback as game totals; `oppWHIPSource` flag indicates path.
**SimScore — NBA OVER**: teamOffRtg, oppDefRtg (≥118→2, ≥113→1), Season HR%, H2H HR% (≥80→2, ≥60→1), O/U (≥225→2, ≥215→1).

**NBA team total truePct also blends sample-weighted with `ttNbaSeasonHitRate`** when available (≥5 schedule games) — same `_ssnBlendWeight` helper as game totals. Saves `modelTruePct` (pre-blend Normal sim) in the play when blend changed the value. Without this, NBA team totals were over-confident on far-from-mean thresholds.

**H2H HR%** (team total): scoring team's hit rate ≥ threshold in last 10 H2H vs opp. **Season HR%** (MLB team total): full-season rate from `_ttScheduleMap`. Both from ESPN team schedule cached at `teamschedule:v2:{sport}:{abbr}`. Requires ≥3 H2H or ≥5 season games; null = 1pt abstain.

**Dedup**: one play per `sport|scoringTeam|oppTeam`, best edge across OVER/UNDER. `_ttBestMap` rule: qualified wins over non-qualified even if edge is lower (commit 4903d5c).

---

## MLB Moneyline (v1, shipped 2026-05-18)
Kalshi series `KXMLBGAME` (same series that powers the MLB game-odds fallback). `gameType: "ml"`, `stat: "ml"`. MLB-only in v1; other sports waiting on confirmed Kalshi tickers.

**True%**: `simulateMLBJoint(homeLambda, awayLambda, 10000)` draws each team's runs as independent Poissons (same lambdas the game-total sim uses — captured in `_mlbMlContext` during the totals loop). `mlPctFromJoint(home, away)` counts `home[i] > away[i]` over non-tie sims; tied sims are dropped, not split 50/50, since real MLB resolves in extras and the Poisson model has no notion of extra-inning scoring. `awayTruePct = 100 − homeTruePct` once ties are out of the denominator.

**Kalshi pricing**: each ML side is its own market on Kalshi (one YES per team), so each side's `kalshiPct = own yes_ask_dollars × 100`. The totals UNDER `no_ask_dollars` workaround **doesn't apply here** because we never have to synthesize the opposite side from `1 − yes_ask`. Overround stays in the price the user actually pays (typical: 3–5% combined, identical to existing OVER kalshiPct convention).

**Gate**: standard `dcQualified === true && edge ≥ 5` (client) / `edge ≥ 3` (server, for calibration continuity). Kalshi window 67–91 same as totals. No SimScore — display-only attribution lives in the InputList factor breakdown (`buildMlbMlInputs` in `src/lib/lambdaInputs.js`).

**dataConfidence**: shares the MLB game-total starter/bullpen-source penalty table (homeWHIPSource/awayWHIPSource, homeBullpenSource/awayBullpenSource) plus the both-sides-lineup-confirmed signal. `DC_GATE("mlb", "ml") = 8` (loosened from 10 on 2026-05-18 — 10 was effectively unreachable given typical penalties; combined with universal Kalshi 67-91 window, qualified ML plays remain rare by design). No threshold-distance or seasonRateDivergent penalty (no threshold; no season-rate blend in v1).

**No correlation shrinkage in v1**: MLB park/umpire are already shared per-game inputs, so independent Poissons don't over-disperse the margin much. Revisit if calibration shows tail bias on heavy favorites/dogs.

**Live resolution**: reads `meta.gameScores[homeTeam][gameDate]`. `pickTeam` wins iff its final score is higher. Resolves only at `state === "post"` (unlike OVER totals, which can win mid-game when the threshold is crossed — for ML, in-game leads have plenty of variance left).

**Emission**: one pass after team-total cross-dedup. For each `_mlbMlContext` entry with a matching `_mlbMlMarkets` ML pair, run the joint sim once (cached per `homeTeam|awayTeam`), then emit a play per qualifying side. Both sides can in theory pass the Kalshi 67–91 window if the dog is priced near 30c (= no_ask ~70c); in practice the favorite side is what we usually see.

---

## MLB Spread / Run-line v1 (2026-05-18)

**Series**: `KXMLBSPREAD`. Per-market title: "Team X wins by over Y runs?" Ticker: `KXMLBSPREAD-{eventTicker}-{team}{N}` where the suffix decodes to `marginTeam` (the side on the win-by question) and `line = floor_strike = N − 0.5`. Half-lines only — integer lines would allow pushes; not modeled in v1 (parse skips them via `strike === Math.floor(strike)` check).

**True%**: `spreadPctFromJoint(home, away, line, side)` reuses the joint Poisson draws cached in `_mlJointCache` (hoisted out of the ML emission block so ML + spread share the same 10k draws per game). Side = "home"/"away" indicates which team is on the margin question. YES = `P(side − opp > line)`; NO = complement (no pushes). Same per-team lambdas as MLB game totals + ML.

**Kalshi pricing**: each spread market is an independent YES/NO book. YES side pays `yes_ask_dollars × 100` for the margin team (`-line`); NO side pays `no_ask_dollars × 100` for the cover team (`+line`) — **must use real `no_ask`, not `1 − yes_ask`** (same gotcha as totals UNDER, since YES/NO books are independent and typical spread is 3–7c).

**Lines emitted**: ALL Kalshi-listed alt lines per game. Typical: ±1.5, ±2.5, ±3.5; sometimes ±4.5+ for big mismatches. Both sides of each line are independent Kalshi markets (e.g. "LAD wins by 1.5+" AND "SD wins by 1.5+" are both listed for LAD@SD), so the parser handles both orientations via `parseGameTeams` + `marginTeam` decode. `pickLine` field is signed from the pick's perspective: `-1.5` for margin side, `+1.5` for cover side.

**Gate**: standard `dcQualified === true && edge ≥ 5` (client) / `edge ≥ 3` (server). Kalshi window 67-91. `DC_GATE("mlb", "spread") = 8` — same as ML, since spread reuses identical lambda inputs (FIP/ERA/WHIP/bullpen sources, lineup confirmation). The `gameType === "spread"` clause is added to all MLB ml branches in `api/lib/tonight/dc.js` (gate, lineup-confirmation penalty, starter-source penalty).

**No correlation shrinkage in v1**: park/umpire are shared per-game inputs so independent Poissons don't over-disperse margins much. Heavy-favorite alt lines (e.g. -3.5 or worse) are the highest-variance corner — watch calibration there first.

**Live resolution (frontend, not yet wired)**: at `state === "post"`, pickTeam covers if `(pickTeamFinal − oppFinal) > line` for YES picks, or `(oppFinal − pickTeamFinal) ≤ line` for NO picks. Half-lines only → no pushes. Same `meta.gameScores[homeTeam][gameDate]` lookup as ML.

**Asymmetry vs ML (observed 2026-05-18 deploy)**: tonight has 0 qualifying ML plays (no MLB ML favorite hits 67% Kalshi) but 43 qualifying spread plays. Reason: spread `no_ask` for moderate underdog +X.5 covers naturally lands in 67-91 (favorite -X.5 priced 10-30% → cover 70-90%). If 43/night turns out to be too many on real calibration, consider tightening with a `kalshiVolume` floor or restricting to ±1.5 only.

---

## MLB First-N-Innings — F5 (2026-05-28), F3/F7 (2026-06-30)

**Series**: `KXMLBF5TOTAL`, `KXMLBF5SPREAD` (total/spread) and `KXMLBF5` (3-way ML w/ tie). Added 2026-06-30: `KXMLBF3` and `KXMLBF7` — **ML-only** (Kalshi lists no F3/F7 total/spread; those series return 0 markets). All share the full-game ticker date+team segment; same `parseGameTeams` handles them. The 3-way inning-winner series (`KXMLBF3/F5/F7`) live in `CRON_ONLY_TICKERS` so the snap cron warms them.

**Lambda**: per-side F5 lambda computed alongside full-game λ in the MLB total loop and stashed in `_mlbMlContext` as `f5HomeLambda` / `f5AwayLambda`:

```
λ_F5_side = teamRPG × (5/9) × oppStarterMult_F5 × parkRF × platoonFactor × umpRunFactor × lineupOutFactor   # weather removed 2026-06-23
```

where `oppStarterMult_F5 = _starterMult(fipEff × restBump, era × restBump, whipEff)` — i.e. `_starterMult` called with restBump applied but **without** the TTO bump (which kicks in past BF=22, after F5). The 60/40 starter/bullpen blend is replaced by 100% starter — F5 assumes the starter goes the distance. Clamped to `[0.3, 8]` runs.

**Differences from full-game λ**:
- No TTO bump on starter inputs (F5 ≈ 1st time through + part of 2nd; 3rd TTO doesn't happen yet)
- No bullpen 40% share (no bullpen in F5 under starter-goes-5 assumption)
- No regime blend (no per-game F5 runs in `_gtScheduleMap`; would require schedule cache extension)
- Same days-rest, vs-L/R splits, park, platoon, umpire, lineup-out adjustments (weather removed 2026-06-23)

**Joint sim**: `simulateMLBJoint(f5HomeLambda, f5AwayLambda, dispR, 10000)` — same NegBin per-team draws as full-game, sharing the same `dispR` from `_fitMlbDispersion`. F5 is structurally slightly less overdispersed than full-game (no bullpen-variance source), so reusing full-game `r` under-disperses F5 tails marginally. Acceptable v1 bias; revisit if calibration shows systematic miss on far-from-line F5 alt thresholds.

**Total True%**: build combined-runs Int16Array as `home[i] + away[i]` from the joint draws, then `totalDistPct(dist, threshold)` for OVER prob; `1 − overPct` for UNDER. Cached per game in `_mlbF5TotalDistCache` for monotonicity across thresholds.

**Spread True%**: reuse `spreadPctFromJoint(joint.home, joint.away, line, marginSide)` — sport-agnostic since the math is identical to full-game.

**Emission**: F5 picks carry `segment: "f5"` and `stat: "f5total"` / `"f5spread"` so calibration groups them under `mlb|f5total` / `mlb|f5spread` (auto-derived from `${sport}|${stat}`). PlaysColumn renders through the existing `gameType === "total"` / `"spread"` branches with an "F5" pill in the header; segment-aware `playKey` / `trackId` prevent collisions with full-game picks at the same threshold/line.

**Gates**: same as full-game — `DC_GATE("mlb", "total") = 10` for F5 total, `DC_GATE("mlb", "spread") = 8` for F5 spread. Server `EDGE_GATE = 3`, client `EDGE_GATE_CLIENT = 5`. Kalshi window 67–91. Same penalty table since F5 reuses the same lambda inputs (starter source, lineup confirmed, bullpen source — even though F5 doesn't use bullpen ERA, the penalty plumbing shares the field).

**dc carve-out**: `noSeasonSample` / `tinySeasonSample` / `smallSeasonSample` are skipped when `p.segment === "f5"`. F5 has no per-game F5-runs season-hit-rate data in v1, so the sample-size penalty would auto-fire (-3) and block every F5 pick. Threshold-distance penalty (`farFromLine` / `modestlyFromLine`) does still apply, anchored against a synthesized F5 OU line = `fullGameOuLine × 5/9`. The full-game mlb buckets `[3, 5]` translate to effective `[1.7, 2.8]` against the F5 distribution — slightly tighter than ideal but workable v1.

**Live resolution (2026-05-28)**: F5 picks lock as soon as the bottom of the 5th completes — independent of full-game state. `/api/live` reads ESPN's per-half-inning `linescores` array on the MLB scoreboard event; when both home and away have ≥5 entries, the response includes `f5HomeScore`, `f5AwayScore`, and `f5Complete: true`. `useLiveStats.js` has a dedicated F5 resolution branch (placed before the existing total/spread/ml branches) that maps:
- F5 total OVER: `f5Home + f5Away ≥ threshold` → won
- F5 total UNDER: `f5Home + f5Away < threshold` → won
- F5 spread: `(pickF5 − oppF5) + pickLine > 0` → covered/won
- F5 ML home/away: F5 leader wins; tied through 5 → home/away picks lose
- F5 ML tie: `f5Home === f5Away` → won

**Rainout / called-game**: if `state === "post"` and `f5Complete !== true`, the game ended before the 5th was complete. Kalshi voids these markets (per their rules), so the resolver returns `result: "void"`.

### F3 / F7 3-way ML (2026-06-30, shadow-only)

`KXMLBF3` ("wins first 3 innings") and `KXMLBF7` ("first 7 innings") reuse the F5 ML stack via one parameterized emitter, `_emitMlbSegmentMl({segment, seriesTicker, statName, lamHomeKey, lamAwayKey, ouFrac, jointCache})` in `ml-spread.js` (F3/F5/F7 all route through it; F5 output is unchanged because it still shares `_mlbF5JointCache` with F5 total/spread). Categories `mlb|f3ml` / `mlb|f7ml`, shadow-only (not in the category gate). No F3/F7 total or spread — those Kalshi series don't exist.

**Lambdas** (stashed on `_mlbMlContext` beside `f5*`, computed in the MLB total loop):
- **F3** = starter-only × **3/9** — reuses the same `oppStarterMult_F5` (first 3 innings = pure starter, first time through the order; the F5 no-TTO/no-bullpen rationale applies *more* cleanly). Clamp `[0.2, 6]`.
- **F7** = **full-game** λ (`_hLam`/`_aLam`) × **7/9** — *not* starter-only. By inning 7 the starter has taken the 3rd-time-order (TTO) penalty and the bullpen has appeared; the full-game λ already carries both, so scale it rather than the starter mult. Clamp `[0.4, 9]`. (Starter-only×7/9 would bias F7 low; documented v1 tradeoff.)

**Tie rate is the sanity check**: fewer innings → more ties, so `P(tie)` should grade F3 (highest, ~25-30%) > F5 (~15-17%) > F7 (lowest, ~10%), all off the same `joint3WayPct` on the scaled lambdas.

**Live resolution**: `/api/live` emits `f3{Home,Away}Score/f3Complete` (linescores[0:3], both ≥3) and `f7*` (both ≥7), mirroring the f5 block; the resolver's segment branch grades `f3`/`f7` off those. ML grading is segment-generic (`segHome > segAway → winner`, equal → tie).

**Live cache window**: `/api/live` caches in-progress games for 60s, post-state for 300s. F5 fields populate as soon as ESPN's scoreboard reflects 5 completed half-innings — typically 30-60s after the bottom of 5 ends, depending on ESPN's update cadence. After 5 min post-game, the cache expires; F5 picks tracked but never auto-resolved would need a manual re-trigger.

**Display caveat (not fixed in v1)**: `buildLiveProgress` continues to use full-game `homeScore` / `awayScore` for the progress bar during innings 6+, so a locked F5 pick may show full-game runs accumulating past the F5 threshold. The `result` field is authoritative; the display is cosmetic. Fix is a one-line F5 override in `buildLiveProgress` to use `f5*` scores when `f5Complete` — punted to a future commit.

**F5 ML 3-way (added 2026-05-28)**: `KXMLBF5` series — Kalshi lists three independent markets per event (home / away / TIE). Unlike full-game `KXMLBGAME` which is 2-way (ties resolve in extras), F5 ties are a real settlement outcome and priced 15-17% in typical samples. New sim helper `mlbF5MlPct(home, away, side)` in `api/lib/simulate.js` counts home/away/tie probabilities over the joint draws **without dropping ties** — denominator is the full 10k sim count. Reuses `_mlbF5JointCache` built by F5 total/spread emission so all three F5 markets share one joint sim per game. Series fetched inline via snap → 600s legacy → REST (mirror of `KXMLBGAME`, not via SERIES_CONFIG because it's a 3-way ticket-suffix-as-team-or-"TIE" market). Emission loop iterates `["home", "away", "tie"]` sides — each independent on `dcQualified + edge ≥ 5`. Tie picks carry `pickTeam: "TIE"`, `oppTeam: null`, `side: "tie"`. PlaysColumn ML card renders these specially: stacked away/home logos, "Tie F5 ML (away @ home)" headline, no team-page navigation on click. Same DC gate (`DC_GATE("mlb", "ml") = 8`) and penalty table as full-game ML since F5 ML reuses identical lambda inputs. Calibration bucket: `mlb|f5ml`, tab: `mlb-f5ml`.

**Deferred to v2 (not in this commit)**:
- F5-specific regime blend — requires extending `_gtScheduleMap` to capture per-game `linescore.innings[0..4]` from MLB Stats API.
- `f5StarterShortLeash` dc penalty (-1 when `pitcherAvgBF < 18`) — only adds if calibration shows the low-BF subgroup misses systematically.
- Live mid-game resolution — fire when bottom of 5 finishes (currently picks resolve at `state === "post"`). Requires `/api/live` to expose `f5HomeScore`/`f5AwayScore`/`f5Complete` from ESPN per-inning linescore, plus a resolution branch in `App.jsx`/`liveStats.js`.

---

## NBA + WNBA Halves v1 (2026-05-28)

**Series**: `KXNBA1HTOTAL`, `KXNBA1HSPREAD`, `KXNBA1HWINNER` (3-way), `KXNBA2HTOTAL`, `KXNBA2HSPREAD`, `KXNBA2HWINNER` (3-way), plus WNBA equivalents. 12 series total.

**Lambda decomposition (v1)**: `λ_half_team = full_λ_team × 0.5` for both 1H and 2H. Stashed on `_nbaMlContext` / `_wnbaMlContext` per game alongside full-game lambdas (`h1HomeLambda`, `h1AwayLambda`, `h2HomeLambda`, `h2AwayLambda`). Reality is ~49.5%/50.5% with ~6% OT contribution to 2H — refinement comes after calibration data accumulates. Variance: half σ = full σ × `sqrt(0.5)` ≈ 9.2 NBA, 7.8 WNBA.

**Joint sim**: independent per-half via `simulateNBAJoint(λ_half_home, λ_half_away, halfσ, halfσ, 10000)`. Cache keyed by `${sport}|${homeTeam}|${awayTeam}|${half}` so 1H and 2H draws don't collide. **v1 limitation**: 1H and 2H drawn independently — full-game team-strength correlation across halves isn't preserved. A team that overperforms in 1H tends to also overperform in 2H, so independent draws slightly over-disperse the full-game implication. Single-half picks aren't affected; this matters only if cross-half stacking proves an edge worth modeling.

**Three reductions per half**:
- **Total**: combined-runs Int16Array = `home[i] + away[i]`, query with `totalDistPct`. Cached per game+half in `_halfTotalDistCache`.
- **Spread**: existing `spreadPctFromJoint(home, away, line, side)` works unchanged.
- **Winner (3-way)**: `joint3WayPct(home, away, side)` — renamed from `mlbF5MlPct` since the math is sport-agnostic. Counts home/away/tie without dropping ties (winner markets resolve TIE explicitly).

**Winner-market fetch**: `KX..1HWINNER` and `KX..2HWINNER` go through inline fetch (snap → 600s legacy → REST), parallel to KXMLBF5 / KXMLBGAME pattern. The unified SERIES_CONFIG parse loop handles only total/teamTotal/spread branches. Loop over `[["nba","1h","KXNBA1HWINNER"], ...]` builds 4 winner-market lookup tables.

**Same gates as full-game**: `DC_GATE("nba","total") = 10`, `("nba","spread") = 8`, `("nba","ml") = 8`; same for WNBA. Half picks share DC carve-outs with F5 — `noSeasonSample`/`tinySeasonSample`/`smallSeasonSample` are skipped when `p.segment && p.segment !== "full"` (no per-half season-hit-rate data). Synthesized half OU line = `full_OU × 0.5` for threshold-distance penalty anchor.

**Calibration**: 12 buckets — `{nba,wnba}|{h1,h2}{total,spread,ml}`. Tabs in ModelPage: `nba-1htotal` through `wnba-2hml`.

**Live resolution**:
- `/api/live` NBA + WNBA branch reads ESPN per-quarter `linescores`. 1H = Q1+Q2 (indices 0,1). 2H = full − 1H (includes OT).
- `h1Complete: true` once both teams have ≥2 linescore entries → 1H picks lock at halftime
- `h2Complete: true` when `state === "post"` AND h1 was completed → 2H picks lock at game end (including any OT)
- Game called before halftime (rare in NBA/WNBA) → `state === "post" && !h1Complete` → both 1H and 2H picks resolve to `result: "void"`
- `useLiveStats.js` segment branch generalized from F5-only to handle any segmented pick (`pick.segment === "f5" | "1h" | "2h"`) via a switch on segment name

**Frontend**: PlaysColumn uses shared `segmentPillLabel` helper returning "F5" / "1H" / "2H" / null. Total card `tLabel` mapping extended: `h1total → "Pts (1H)"`, `h2total → "Pts (2H)"`. Same segment-aware playKey/trackId from F5 work prevents collision with full-game picks.

**Deferred to v2**:
- NBA quarter markets (Q1-Q4) — pace isn't quarter-resolved in our pre-game data (Q1 slow, Q4 garbage-time fast).
- 1H/2H correlation in joint sim — would require sampling full-game then splitting, or modeling shared team-strength factor explicitly.
- 2H lambda OT adjustment — minor (~6% × small OT scoring).
- Half-specific dc threshold-distance buckets — full-game buckets translate to ~half-scale workable v1.

---

## Kalshi Market Parsing
- Series in `SERIES_CONFIG` (18 tickers across all sports/stats)
- Player props, game totals, team totals: `pct ∈ [KALSHI_GATE, KALSHI_CAP] = [67, 91]` (constants in `api/[...path].js`). Markets outside this band aren't fetched/parsed at all.
- **Rate limiting**:
  - Bundle cache `kalshi:bundle:{date}` (600s TTL) — all 18 series as one blob, cache hit = zero calls. Bypassed by `?bust=1`.
  - Cold: **3 series at a time with 700ms delay** between batches, **shuffled order**. 6+300ms still left ~6/18 series falling back to stale per `?bust=1` (KXMLBTEAMTOTAL was always last-in-line). Shuffling distributes rate-limit pain across categories instead of starving the same tickers. Cost: ~3.6s on cold builds; bundle hits unaffected. 429 → fall through to `kalshi:stale:{ticker}` (no retry). The per-ticker stale fallback fires on both bust and non-bust — it holds the last successful fetch, and is preferable to empty even on bust. (Briefly tried skipping stale on bust to dodge "yesterday's residue", but that strands the 600s bundle once any rate-limited bust call writes empty entries; preserving stale is the safer trade.)
  - **Bundle preserves prior entries on partial failure**: when a follow-up bundle fetch returns empty for a series due to rate-limit/failure, the prior bundle's entry for that ticker is reused before writing the new bundle. Stops a rapid-bust race from blanking healthy categories (KXMLBTEAMTOTAL was getting blanked between `?bust=1` calls because it was the most rate-limit-prone).
  - **Staleness surfacing**: any series served from per-ticker stale fallback OR prior-bundle preservation marks each affected market `_kalshiStale: true`. Two consumer paths: (1) `/api/tonight` response (debug + production) returns `staleKalshiSeries: ["KXMLBTOTAL", ...]` listing tickers that fell back this request — at-a-glance signal for diagnosing drift like "Kalshi shows -968 but UI shows -669". (2) Each affected play has `_kalshiStale: true` (derived via `(sport, stat, gameType)` → ticker reverse lookup against the stale set). The flag is omitted on fresh plays.
  - Orderbooks (thin markets): 8 at a time with 200ms delay. 429 silently skipped.
- Blended fill price via orderbook walk for thin markets
- **Stale-ask fallback**: when `yes_ask ≥ $0.98` AND `yes_bid == 0` AND `last_price > 0`, use `last_price_dollars` instead. Handles maxed-ask illiquid markets.
- **Capture liquidity gate (`CAPTURE_MAX_SPREAD` 15¢)**: a captured side with bid-ask spread > 15¢ has no real book — its quote isn't a price and is rejected at parse. Prop rungs (2026-06-30, totalBases 94¢ artifact), game total/teamTotal/spread branches (2026-07-11, `min(yesSpreadC,noSpreadC)` — Kalshi's unified book means both sides share one spread when both asks exist), and ML legs (2026-07-11, `_kMlLegProb` in ml-spread.js — shared by all 7 ML parse blocks; one rejected leg drops the whole event via the 2-way/3-way completeness check). Motivating data: in-play-only segments captured pre-game (WNBA Q2–Q4/halves ~95¢ both sides, f3/f7ml ~55¢×3 legs) logged as fake favorites with Brier "skill" up to +0.39 vs quote-garbage. Overround (avgMarket × sides ≈ 1) is the per-category diagnostic. Stale-ask path exempt everywhere; mlb-outs parse deliberately ungated (cutoff bump would auto-un-park it).
- `kalshiSpread` = bid-ask in cents. Kept as liquidity signal but **not** subtracted from edge.
- E1 line movement: opening yesAsk stored at `lineOpen:{ticker}:{gameDate}` (2-day TTL). `lineMove = current − opening`. Badge `▲/▼ Xc` when `|lineMove| ≥ 3`.
- E2 market depth: `lowVolume = vol < 50`, `thinMarket = spread > 8`, `marketConfidence = "deep" (vol≥50 && spread≤4) | "moderate" | "thin"`.

### Time-based filters
- **Date cutoff** (`cutoffStr`, ~`[...path].js:3492`): drops plays with `gameDate < yesterday`. Applied to player props pre-merge; game/team totals do an inline `gameDate < cutoffStr` skip in their loops.
- **Game-start cutoff** (post-dedup, after cross-dedup loop): drops any play whose `gameTime` is already in the past (pre-game market closed; model truePct built on pre-game inputs is no longer valid in-game). Plays missing `gameTime` are kept (already gated by gameDate).

### preDropped vs dropped vs qualified:false
- `preDropped[]` — filtered before main play loop (no ESPN info yet). Debug-only.
- `dropped[]` — filtered inside play loop. Debug-only. **Includes game totals** that fail edge or have no sim data (`reason: "edge_too_low"` or `"no_simulation_data"`).
- `nbaDropped[]` — always present in regular `/api/tonight` response (now empty after pre-filter removed; kept as fallback for `tonightPlayerMap` building).
- **`qualified:false` plays** — pushed to `plays[]` so player card explanation renders. `tonightPlays` filters them out client-side; `allTonightPlays` keeps them (used to build `tonightPlayerMap`).
  - MLB strikeouts: edge gate, threshold_too_high, simScore<8 — all thresholds pushed for monotonicity
  - MLB HRR: edge gate, simScore<8 — `low_lineup_spot` and `hitterSimScore<5` are pre-gates that do NOT push
  - NBA, NHL: edge gate, simScore<8

### bestMap deduplication
Dedupe to one play per `playerName|sport|stat`. Winner = highest edge. Non-qualifying plays use threshold-inclusive key and don't compete. After bestMap, non-winning qualified thresholds are re-added as `qualified:false`.

**WNBA pre-pass**: before bestMap, qualified WNBA plays are deduped to one per **player** (across all stats), highest edge wins. Losing stats are mutated to `qualified:false` so allTonightPlays still has them for the player card, but the homepage Plays card only shows the per-player winner. Tighter than NBA/NHL because WNBA slates are small and a player's points/rebounds/assists markets often correlate — showing all of them was clutter.

For totals: dedup key is `homeTeam|awayTeam|threshold` (game) or `sport|scoringTeam|oppTeam` (team). All threshold plays passing edge gate (≥3%) are pushed; best per game is qualified, rest are `qualified:false` (used by team-page bar chart).

### Backend monotonicity for player card
Strikeout truePct is enforced via:
1. `qualified:false` plays in `plays[]` keep all thresholds (key `playerName|sport|stat|threshold` so no dedup collision)
2. Post-loop sweep re-derives truePct for every threshold from `pitcherKDistCache` distribution
3. Frontend `_rawTruePctMap` walks highest→lowest tracking running max across API thresholds as safety net (fallback values excluded so noisy fallbacks can't lift API values)
4. Frontend cap pass: walks low→high, and any fallback threshold above an API anchor is capped at the anchor's truePct (P(X≥t) cannot exceed P(X≥t') for t > t'). Needed because the player card hits `/api/kalshi` directly — bypasses the [67,91] gate — so thresholds outside the band render with `(seasonHitRate + softPct) / 2` fallback that can otherwise exceed the in-band API anchor.

---

## Calibration Filter Cutoffs & Behavioral Gotchas

Quick reference for calibration audits. Filter data before each cutoff date when the modeling change affects the surface.

**NBA/WNBA spread model-vs-market divergence gate (2026-06-01)**: `dc.js` adds `spreadModelMarketDivergent` (−1 dc) when `|homeLambda − awayLambda − homeMarketMargin| > 10` for NBA/WNBA spread plays (full-game and half-game). `homeMarketMargin = pickTeam===homeTeam ? −pickLine : pickLine`. Fires when the OffRtg/DefRtg model diverges >10 pts from the Kalshi market spread — signals the model missed something (injuries, form, extreme mismatch). Filter NBA/WNBA spread calibration `trackedAt < 2026-06-01`.

**NBA/WNBA injury OffRtg shrink (filter cutoffs)**: piecewise tiers (≤20%×0.15, 20-35%×0.22, 35-50%×0.30, >50%×0.35, floor 0.70) with MPG-weighted USG (`avgMin/48`). Filter `trackedAt < 2026-05-30` (weighting fix), `< 2026-05-31` (dc heavy-injury threshold: was `>= 0.30` bug that fired on any injury; fixed to `>= 30` on the 0–100 scale).

**Regime-aware lambda blend (filter cutoffs)**: `< 2026-05-21` NBA/WNBA/NHL total+teamTotal, `< 2026-05-25` MLB total/ML/spread, `< 2026-05-27` MLB teamTotal.

**MLB strikeouts between-game form variance (2026-06-01, retuned 2026-06-13)**: `K_FORM_SIGMA = 0.26` in `simulateKsDist` (was 0.22; sweep-optimized — see line 56). The embedded copy in `simulate.test.jxa.js` **must stay in sync** with any σ change — run `osascript -l JavaScript api/lib/simulate.test.jxa.js` after editing. Filter `mlb|strikeouts` calibration `trackedAt < 2026-06-13` (σ=0.26 cutoff).

**MLB teamRuns NegBin fix (2026-06-02)**: `simulateTeamTotalDist` accepts optional `r` param (null → Poisson for NHL backward compat); `game-totals.js` passes `_mlbDispR`. Filter `mlb|teamRuns` calibration `trackedAt < 2026-06-02`.

**MLB teamRuns market-line anchor + NegBin season blend (2026-06-03)**: `_anchorTeamLam(lam)` pulls final λ 25% toward `gameOuLine/2` (gated to lines ∈ [5,14]); season blend cap 1.0→0.50 (decoupled from `_TT_IMPLIED_CAP.mlb`=1.0 used by dc.js); season blend uses NegBin. Filter `mlb|teamRuns` calibration `trackedAt < 2026-06-03`.

**MLB HRR sigmoid cap (2026-06-02)**: `pct ≤ 72 ? pct : 72 + 3*(1 - exp(-0.5*(pct-72)))` applied after `_propBlend` in `props.js` and after `hrrLogitTruePct()` in `scripts/backtest/mlb/simulate.js`. Compresses above 72% toward a 75% ceiling. Filter `mlb|hrr` calibration `trackedAt < 2026-06-02`.

**MLB totalRuns market-line anchor + tighter blend clamp (2026-06-01)**: game-total only (teamRuns/F5 untouched). (1) seasonHitRate blend clamp `_cap` hardcoded 0.75 (dc.js still reads `_GT_IMPLIED_CAP.mlb`=1.5 — same plays qualify/drop, only blend softens). (2) `_anchorTotalLam(λ)` pulls 25% toward `gameOuLine` — `_mlbMlContext` keeps raw λ so ML/spread surfaces are untouched. Filter MLB totalRuns calibration `trackedAt < 2026-06-01`.

**MLB lineup-aware lambda (2026-05-18)**: hitter-out tier (0/1/2/3+ → ×1.0/0.98/0.96/0.93). Filter `trackedAt < 2026-05-18` for total/teamTotal/ML/spread calibration.

**Orderbook-depth blend (2026-05-31)**: all surfaces — blends `kalshiPct`/`noKalshiPct` through the cached orderbook depth before any edge computation. Filter totals/spread/teamTotal by `trackedAt ≥ 2026-05-31`.

**Kalshi UNDER pricing (2026-05-15)**: filter UNDER calibration by `trackedAt ≥ 2026-05-15`.
