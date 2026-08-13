# CLAUDE.md

Navigation layer, not the encyclopedia. Detail lives in `docs/*.md` and memory files. Don't add history, post-mortems, or dated narratives here — those belong in git/memory.

## Commands

```bash
npm run dev        # Vite dev server — proxies /api to production (vite.config.js)
npm run build      # Production build → dist/
npm test           # Node test runner: simulate, utils, parse-teams, dedup, category gate
git push origin main  # Deploys to Vercel automatically
```

Admin/debug (pull `ADMIN_KEY` via `vercel env pull`):
```bash
curl -s "https://scoreboard-ivory-xi.vercel.app/api/tonight?debug=1" | jq '.plays | length'
curl -s "https://scoreboard-ivory-xi.vercel.app/api/auth/shadow-stats?resolvetrigger=1" -H "Authorization: Bearer $ADMIN_KEY" | jq '{resolved, skipped}'
```

## Workflow for New Features and Debugging

1. **Check memory + CLAUDE.md** — read `MEMORY.md` + relevant memory files; load `docs/INFRA.md`/`docs/FRONTEND.md` if the change touches those.
2. **Plan and get explicit approval** (text only — files, logic, edge cases) before editing. Greenfield check: ask "what would this look like from scratch?" and name any divergence as tech debt or a load-bearing constraint. Check the plan against these principles:
   1. Single source of truth — edit `config.js`/`teams.js`/shared helpers, don't duplicate.
   2. DRY/chokepoint — one upstream point, not N call sites.
   3. Least change / YAGNI.
   4. Don't break contracts — additive over destructive; forward-only formula changes via `FORMULA_CUTOFFS`.
   5. Failure-closed — new external/data paths degrade to empty/null, never throw into the hot path.
   6. Separation of concerns — model / storage / display split.
   7. Match surrounding idiom — Web-API style, no Node-only APIs casually.
   8. Delete on the way past — remove superseded code (dead branches, orphaned helpers/imports/params, obsolete comments) in the SAME commit.
3. **Implement** — delete whatever the change orphans as you go. If backend logic changed, confirm via `/api/tonight?debug=1` (or the relevant endpoint) and print fields proving correctness.
4. **Cross-venue check (any NEW Kalshi market or league)** — does Polymarket list the same thing? Record the answer either way: a `POLY_MARKETS` row/category in `api/lib/polymarket.js` (+ its Kalshi prefix in `KALSHI_VENUE_CATEGORY_PREFIXES`), or an explicit note that there's no counterpart. Three traps: (a) **the `/sports` catalog's `series` id is unreliable** — verify it returns events, discover the real one via `tag_slug` (arg 10285→10312, nfl 10187→12185); (b) `POLY_DISMISSED_SPORTS` is **never auto-revived**, so a league dismissed before its Kalshi build must be removed by hand (`uslc`/`sclc` sat stale this way); (c) the shape must be **like-for-like** — Poly lists PGA/NASCAR as event-winner/top-5 against Kalshi's H2H, and a Δ across different products is worse than no data. NOT a gate: a missing counterpart never blocks the Kalshi build.
5. **Deploy and document** — `git push origin main`. Update CLAUDE.md + relevant `docs/*.md` in the same commit. Save a memory entry for anything non-obvious.

## What This Is

**Model-free Kalshi prop-market capture instrument.** Pulls Kalshi prices across many sports/markets and logs **every quoted side** to Neon `shadow_plays` as a model-free row (`truePct`/`edge` null, `qualified` false, `modelFree` true) — no model, no bet. A shadow **maker** engine quotes against the captured books and detects fills (simulated / measurement-only). The **maker board** (`MakerBoardPage`, reading `/api/shadow-report`) is the only UI. Vercel Node runtime (Fluid Compute), maxDuration 300 — keep handler code Web-API style (fetch/Request/Response/crypto.subtle).

Production: `https://scoreboard-ivory-xi.vercel.app`

Key state flags (context in memory + `docs/REENTRY.md`):
- **`AWAITING_VALIDATED_EDGE`** (`api/lib/config.js`) — no strategy family has cleared validation; suppresses the imperative mood only, never a measurement. Instruments (boards, quoting, fills, series scan) keep running.
- **Maker V2 SHELVED** — `SHELVED = true` in `api/lib/maker-live.js`. V1 quoting, nightly tape replay, and grading stay ON.
- **Model + taker teardown COMPLETE** — all model/taker/push code deleted; capture-all is the only path.

## Capture doctrine

Two gates at collection, both quote-sanity (not price-preference): (1) **band** `[CAPTURE_GATE 1, CAPTURE_CAP 99]` — a 0¢/100¢ ask is an absent quote; (2) **liquidity** `capturableSpread` / `CAPTURE_MAX_SPREAD 15¢` — a lone wide quote (bid-ask > 15¢) is an artifact ask, rejected at parse. Applied through one `capturableSpread()` (config.js) at three sites: prop parse, total/teamTotal/spread branches, and `_kMlLegProb`. Both YES and NO use their OWN ask (`no_ask_dollars`, never `1−yes_ask`). Stale-ask path (`yesAsk≥0.98` off `last`) is exempt. `config.test.js` pins the bounds.

## Where to look

| Topic | File |
|---|---|
| Cache keys/TTLs, Upstash, env vars, deployment, testing, route contracts, cron table + DST re-pin | `docs/INFRA.md` |
| App.jsx + MakerBoardPage (the only view): heatmaps, prereg tracker, auth | `docs/FRONTEND.md` |
| Design system: palette, typography, spacing, component patterns | `docs/STYLEGUIDE.md` (MakerBoardPage inlines its own styles) |
| Common debugging recipes | `docs/DEBUGGING.md` |
| What would justify betting again (re-entry conditions + required method) | `docs/REENTRY.md` — read before any work premised on a new edge |
| Why a lit sub-50¢ maker cell is usually not an edge (band-ladder artifact, netting screen, prereg audit) | `docs/MAKER_LADDER_ARTIFACT.md` — read before promoting any `robustCandidates` hit |

## Architecture

Per-module maps are lazy-loaded:
- **`api/CLAUDE.md`** — router, route handlers, every `api/lib/*` + `api/lib/tonight/*` module. Auto-loads under `api/`.
- **`src/CLAUDE.md`** — frontend module map. Auto-loads under `src/`.
- **`api-routes` skill** — full route table + per-model summary. Invoke when adding/debugging any `/api/*` endpoint.

## Key Gotchas

These bite during *any* change. Each links to detail in `docs/*.md` or memory.

**Dropped rows are logged rows.** Under capture-all, `dropped` goes to `shadow_plays`, so a field missing from a `dropped.push` is a permanently corrupt column. Build play and drop from ONE shared base object; a missing `kalshiTicker` makes a row unrecoverable. Repair history via `/api/shadow-snapshot?backfillgamedate=1` (rows from 2026-07-23 on).

**`state:"post"` ≠ game finished.** ESPN reports POSTPONED/CANCELED/SUSPENDED as `state:"post"`, `completed:false`, 0-0. `isNonFinalTerminal`/`isMakeupReattributed` (`settlement-reconcile.js`) flag these; flagged rows drop from the ESPN resolve loop and settlement is authoritative for them. `completed === false` must never be relaxed to falsiness; the makeup test must stay strictly forward. Repair: `/api/shadow-snapshot?regradepostponed=1`. Detail → `docs/DEBUGGING.md`.

**A resolver disagreement does NOT imply Kalshi erred — only settlement knows the true outcome.**

**Spread alt-line dedup key** `sp|sport|seg|sortedTeams|line|gameDate`. Alt lines compete independently; both sides of one line share a key (higher-edge side wins). Demoted loser passes the gate if the winner fails it.

**TEAM_NORM (Kalshi → ESPN)** derived from `teams.js` `kalshi` aliases — edit the registry, not parse-teams.js. Identity entries (mlb `KC→KC`) mark 2-char prefixes for the 2+3 ticker split.

**`parseGameTeams` validation via `_VALID_TEAMS`** — without it a 2-char prefix steals the parse (`NYKPHI`→`NY`+`KPH`). Tries 3+3 first (length≥6), falls back to validated 2+3. Symptom of breakage: duplicate matchup cards. Maintain `_VALID_TEAMS` on rebrands. **A registry with ANY 2-char abbr needs its sport in the variable-length allowlist** — the generic path keys `has2charPrefix` on `TEAM_NORM`, which only carries *aliases*, so a canonical 2-char code with no alias is invisible to it. NFL (eight 2-char abbrs) was broken this way until 2026-08-10: `GBKC`→`[null,null]`, `GBSEA`→`["GBS","EA"]` — a silent invention.

**Kalshi ticker home/away order ≠ ESPN.** `parseGameTeams` returns ticker order; each play loop must look up the real home team and swap (game-total loop + team-total loop). **`nfl` is the one deliberate exception** — its ticker IS away+home (verified 29/29), and it must stay ticker-derived: NFL lists ~5 weeks out, far past the D+2 scoreboard window, so an ESPN swap would return ticker order early and the real order later, and since `shadowId` keys on home/away that flip mints a DUPLICATE row rather than correcting one. Any sport listed beyond the scoreboard horizon has this hazard.

**ESPN scoreboard abbr mismatch** — `/api/live` translates via `CANONICAL_TO_ESPN`/`ESPN_TO_CANONICAL` (sport-keyed). Unmapped → `state:"unknown"`, never resolves. Add new mismatches to the `espnScore` field in `teams.js`. (`WNBA_CANON_TO_ESPN` is a *different* endpoint — stats/injuries — don't use it for the scoreboard map.)

**`gameTime: null` is the silent-killer field** — the row logs and grades fine but is never maker-quotable. It has caused this bug five times (9 Phase-1 modules, Argentina's `datesBySport` omission, CANPL, scocup where ESPN hasn't published the League Cup's Round-2 fixtures, and lmb 2026-08-11). `gameTimeNullBySport` in `/api/tonight?debug=1` is the tripwire — read it as a **delta**, since a date-only-ticker league like `kleague` sits at 100% by design. **lmb was a NEW cause: the wiring was correct and the feed was incomplete** — statsapi `sportId=23` carried 4 of the 6 matchups Kalshi had listed for the date, so a schedule-only lookup returned null for two real games. A schedule feed is not a guarantee of coverage; where the ticker carries `HHMM`, chain `kalshiTickerGameTime()` behind the schedule (schedule first — it reflects a moved start; the ticker is frozen at listing).

**`gameTimes` horizon = yesterday…D+2.** D+2 events return as a SEPARATE `eventsDayAfter` array read ONLY by the gameTimes loop — every other `events` consumer keys by TEAM with last-event-wins, so folding D+2 in would overwrite nearer games. **A sport missing from `SPORT_SB_PATH` gets no `gameTimes` at all** → every row logs `gameTime:null` → never maker-quotable, silently. Check it whenever a new sport's ticker is date-only (no `HHMM` for `kalshiTickerGameTime` to fall back on).

**`gameScores` today+tomorrow merge** — key shape `${hA}|${gameDate}|${event.date}` prevents post-midnight wipe + DH game-2 overwrite. The inline duplicate in `mlb.js` must mirror it.

**Kalshi UNDER pricing — use `no_ask_dollars`, not `1 - yes_ask_dollars`.** YES/NO books are independent (3–7¢ spread).

**Polymarket outcome order is away-first ONLY for moneyline.** Spread/F5-spread markets print both outcomes as team display names in arbitrary order — measured over 78 live MLB spreads: 38 away-first, 40 not, and outcome[0] isn't the favorite either (0/78). Index-derived sides are a coin flip, so `polymarket-capture.js` resolves them by NAME against the event's own moneyline market (`_nameToSide`), falling back to the verbatim name rather than guessing. The signed `line` belongs to **outcome[0]** — one event carries both "TB −1.5" and "NYY −1.5" as separate markets — so each row stores the line from its own side's perspective. Poly market families are registry-driven (`POLY_MARKETS`); adding one there without its `KALSHI_VENUE_CATEGORY_PREFIXES` twin captures rows whose Δ is silently always empty.

**Traded volume ≠ resting liquidity** — a `volume_fp:0` market can have a deep book, so volume is not a liquidity proxy. Slippage is measured by walking the live full book (`/api/kalshi-orderbook` → `walkFill`, `api/lib/kalshi-book.js`) for real VWAP. The snapshot cron's cached top-3 `_depth` + `blend-fill.js` were deleted 2026-08-13: the depth phase had never once run, and its blend silently **rewrote captured prices**, so repairing it would have moved the measured quantity under live pre-registrations.

**Kalshi snap-first read chain (`/api/tonight`)** — 2-tier (`api/lib/tonight/kalshi-pipeline.js`): `kalshi:snap:{ticker}` (cron every 2 min, all-or-nothing 180s freshness) → REST + `kalshi:stale:{ticker}` (30-min fallback). `KXMLBGAME` uses the same chain. Diagnose `usedSnaps:false` via `kalshiSnap.meta` in `?debug=1`.

**Server self-fetches: `selfOrigin(request)`, never `new URL(request.url).origin`** — cron URLs 302 to the SSO page. `selfOrigin` (`api/lib/utils.js`) pins `PROD_ORIGIN` except on localhost. Symptom: `noData≈all, games=0` on cron but manual trigger works.

**Outbound fetch is globally concurrency-gated (`api/lib/fetch-limit.js`, 64-slot).** Crossing the fd ceiling makes ALL outbound fetches fail (`EMFILE`/`EBUSY`). Side-effect import, FIRST line of the router — don't add a fetch path that bypasses global `fetch`. Diagnose via `?debug=1` → `fdProbe`. Detail → `docs/INFRA.md`.

**Upstash 10MB request cap** — multi-key writes go through `pipeWriteChunked` (7MB chunks); single SET values gzip above 256KB (`kv-compress.js`, `gz:`-prefixed, auto-decompressed). `kalshi:snap:*` bypass `makeCache`.

**API handler env-var wiring** — handlers receive `env`, never read `process.env`. Wire ALL env vars into the explicit `env` object at the bottom of `api/[...path].js`. Symptom of missing wire-up: `env?.VAR` undefined though Vercel shows it set.

**Shadow-snapshot KV staging** — tonight handler writes `shadow:staging:{date}` (TTL 6h) after DC computation; shadow-snapshot/pregame-snap read it first (~100ms) instead of re-fetching `/api/tonight?debug=1`. `dropped > 0` confirms the dropped-capture path is live.

**Bulk INSERTs must go through `neonBatchInsert` (`api/lib/neon.js`)** — never hand-roll one; the row count is usually the slate, and the slate only grows. `maker_quotes` sent one statement per cycle and **deadlocked quoting for two days** (2026-08-12/13): the insert threw, so no segments existed, so every later cycle rebuilt the same oversized batch. **The binding limit is Neon's HTTP request SIZE, not Postgres' 65535 bind parameters** — measured, after a first fix chunked to 60000 params and failed identically; `PARAM_BUDGET` is 8000 for that reason and a test pins it there. Neon reports all of this as a bare `Database request failed` with no PG error fields, so **label your DB round-trips** — localizing this took three deploys without labels.

**Neon HTTP SQL API (`api/lib/neon.js`):**
1. Uses `@neondatabase/serverless` — raw fetch fails with "missing authentication credentials".
2. `neon().query(sql, params)` returns the rows array **directly** (not `{ rows }`).
3. DDL must go through `neonExec()` (splits on `;`). `sql.unsafe()` is a raw-value marker, NOT an executor.
4. DATE columns come back as JS Date objects — `new Date(row.d).toISOString().slice(0,10)`, never `String(...)`.

**Cold-wake replica lag** — a cold Neon replica can serve stale/empty reads. Freshness-gated read paths use `{write:true}` + KV floor + cross-conn max (safe because counts are monotonic).
