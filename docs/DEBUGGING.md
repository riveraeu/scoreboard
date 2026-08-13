# Common Debugging

Recipes for the live system: model-free Kalshi capture (`/api/tonight`), the maker board, and the resolver/settlement grading. The old model/taker recipes (SimScore, truePct, HRR/DVP/USG/pace/platoon cards, calibration tab, pick tracking, `index.html` line refs) are gone with that code.

## Token-efficient debug recipe (read first)
`/api/tonight?debug=1` is large (`plays` + `dropped`, each row ~100 fields). **NEVER dump it raw into context.** Stage once, project always:

```bash
curl -s "https://scoreboard-ivory-xi.vercel.app/api/tonight?debug=1" > /tmp/tonight.json   # fetch ONCE
wc -c /tmp/tonight.json
```

Re-query the file (no re-fetch) with small `jq` projections — never `cat`/`head` it:

```bash
# slate health — counts only
jq '{qualifying:.qualifyingCount, total:.totalMarketsCount, plays:(.plays|length), dropped:(.dropped|length)}' /tmp/tonight.json

# per-league market/play counts (the debug response carries them per sport)
jq 'to_entries | map(select(.key|test("MarketCount$"))) | from_entries' /tmp/tonight.json

# drop-reason histogram — current reasons: illiquid (spread >15¢), kalshi_out_of_window (outside
#   the capture band), no_opp/no_opponent/no_matchup/unresolved_teams (team parse), no_card/no_driver/no_fighter_match
jq -r '.dropped[].reason' /tmp/tonight.json | sort | uniq -c | sort -rn

# captured rows by sport+stat
jq -r '.plays[] | "\(.sport)|\(.stat)"' /tmp/tonight.json | sort | uniq -c | sort -rn

# inspect one market (every emitted row is model-free: truePct/edge null, modelFree true)
jq '.plays[] | select(.kalshiTicker|test("KXMLB")) | {sport,stat,kalshiTicker,kalshiPct,noKalshiPct,gameTime,dcQualified}' /tmp/tonight.json
```

The two capture gates are quote-sanity, not price-preference (CLAUDE.md § Capture doctrine): a row dropped `illiquid` had bid-ask > `CAPTURE_MAX_SPREAD` (15¢); `kalshi_out_of_window` means the ask was outside `[CAPTURE_GATE 1, CAPTURE_CAP 99]`.

---

## "No plays / empty response"
**Most likely: Kalshi hasn't opened today's markets yet.** Kalshi publishes most prop/game markets only a few hours before start; overnight, yesterday's are finalized and today's aren't live.

Finalized markets appear as `status:"finalized"`, `yes_ask:None`, `price:0` — the pipeline skips them (`if (pct <= 0) continue`), so `plays[]`/`dropped[]` come back empty. Not a bug.

Decode a ticker to confirm the date: `KXMLBKS-26APR152140SEASD` = series `KXMLBKS`, date `26APR15`, time `2140` ET, SEA @ SD. If every ticker shows yesterday's date, today's markets aren't open. Call `/api/kalshi` directly — 0 markets or all `price=0` confirms it.

## "Kalshi market visible on the web app but missing from our pipeline"
A market can show on kalshi.com (with odds) while `yes_ask_dollars` is `0`/null in the trading API — pre-market/preview state. The pipeline correctly skips `price=0`. Once Kalshi assigns an ask it appears on the next request (Kalshi data is always fetched fresh — no cache bust needed).

## "No maker fills for last night" — which subsystem actually failed

Read **`dataFreshness.quotePass`** on `/api/shadow-report` first. It is the maker quote pass's own per-day record (KV hash `maker:quotepass:{ptDate}`, 48h TTL) and it names the branch, which the bare `diagnosis` string could not:

| Reading | Means |
|---|---|
| `cycles: 0` | the kalshi-snapshot cron never fired |
| `skippedNoStaging` ≈ `cycles` | `shadow:staging:{ptDate}` was missing — the **tonight** cron didn't write it |
| `skippedNoSnaps` ≈ `cycles` | every Kalshi series fetch failed that cycle |
| `errors` ≈ `cycles` | the pass threw; `lastError` carries the message |
| `ran` high, `avgEligible: 0` | staging was present but nothing was quotable — check `lastStagingTickers` |
| `ran` high, `avgEligible` normal | quoting was fine; the failure is downstream in tape replay |

`diagnosis` restates whichever of these applies, so usually you can stop at that string. Fall back to the table when it says something generic — that means the key had expired (>48h) or the run predates this telemetry (shipped 2026-08-13).

**Postgres binds at most 65535 parameters per statement**, so any multi-row INSERT has a silent row ceiling of `65535 / columns` — and crossing it throws rather than degrading. This killed quoting for two days (2026-08-12/13): `maker_quotes` is 15 columns → 4369 rows, the slate grew past it, and the failure **deadlocked** (insert fails → no segments → next cycle rebuilds the same oversized batch). Through the Neon HTTP driver it surfaces only as `Database request failed`, naming neither the limit nor the statement. All multi-row inserts now go through `neonBatchInsert` (`api/lib/neon.js`), chunked at `PARAM_BUDGET / cols`. **If you add a bulk insert, use that helper** — the row count is usually the slate, which only grows, so an unbatched builder is a dated time bomb rather than a hypothetical.

**Segments are not recoverable.** `maker_quotes` rows are written at quote time from a book that existed at that instant; nothing reconstructs them. `?makerDetectDay=` only re-derives *fills* from segments that already exist, and `?makerBackfill=` is blocked on any day that has live segments (409), writes `source='backfill'` which every board query filters out, and covers 5 MLB prop series. A day that lost its quoting lost it permanently — which is why the telemetry above matters more than any repair path.

**Watch `newFills`**: it is the count the replay *detected*, not rows inserted (the insert is `ON CONFLICT DO NOTHING`). A large `newFills` on a re-run is almost always re-detection of rows already present — confirm against `makerBoard.daily[].fills` before concluding anything was recovered.

## Cache busting
`?bust=1` skips reads for the byteam maps (`byteam:{mlb,nhl,nba,nba:scoring}`), `gameTimes:v2:{date}`, and `nba:pace:2526` — forcing fresh ESPN game times + team data. (The byteam maps are now **infra-only** — home/away resolution, weather, lineups — not a model.) `mlb:barrelPct` is NOT busted (own 6h TTL). If bust fires before lineups/probables exist, `byteam:mlb` is written with a 60s TTL so the next request retries.

## "Game time shows the wrong time / 'Tomorrow' for a today game"
`gameTimes:v2:{date}` keys on `sport:team:ptDate` (PT-derived) with a bare `sport:team` fallback, built from yesterday+today+tomorrow ESPN scoreboards. Two failure shapes: a UTC-vs-PT date mismatch pushing a 5:10pm-PT game to tomorrow's UTC date (fixed by the PT-date key), and last-UTC-time-wins overwriting the right event on a doubleheader date. `?bust=1` forces a fresh ESPN fetch; if ESPN itself returns the wrong time the offset persists until they fix it. If ALL plays have `gameTime:null` (`jq '[.plays[]|.gameTime]|unique'`), the dedicated `gameTimes` ESPN fetch 429'd/timed out — self-heals next request (empty maps aren't cached). Detail → INFRA.md § gameTimes.

---

## "User login works but picks/data don't persist" — Upstash exhausted
Free tier is 500k commands/month; when exceeded, `makeCache()` silently returns null on every op (Upstash returns HTTP 400, `cmd()` only reads `result`). **Diagnose:** `GET /api/auth/debug-redis?adminKey=<ADMIN_KEY>` — check `match` and `setRaw` for the Upstash error. **Fix:** in the Upstash console, upgrade to Pay-As-You-Go or create a new free DB and update `UPSTASH_REDIS_REST_URL` + `_TOKEN` in Vercel → redeploy.

## "Kalshi and ESPN disagree on a whole MLB series" — postponed / makeup doubleheader
**Symptom:** `/api/kalshi-dryrun-check` reports a burst of `disagree` rows sharing one matchup, tickers dated a day behind `gameDate`. **Cause:** a postponed game made up as a doubleheader — Kalshi settles against the makeup game the ticker can't identify, ESPN grades the wrong event (or grades a still-`STATUS_POSTPONED` game as a 0–0 final, since ESPN reports postponed as `state:"post"`, `completed:false`, 0-0). **Kalshi is right; a disagreement never implies Kalshi erred — check the physical game.** The ticker cannot break the tie (`26JUL271910` matches makeup game 2's wall clock and a date no game was played); only settlement knows. Handled by `isNonFinalTerminal`/`isMakeupReattributed` (`settlement-reconcile.js`) — flagged rows drop from the ESPN loop and settlement is authoritative for them. **Repair:** `/api/shadow-snapshot?regradepostponed=1` (`?dry=1`, `?days=N`) — scoped structurally (every row of a re-attributed matchup), never "regrade what disagrees". Full detail → INFRA.md § Settlement grading + CLAUDE.md gotcha.

---

## Backend init / deploy gotchas
- **ALL routes return 500 `FUNCTION_INVOCATION_FAILED` after a deploy** — usually a bare-block `await` at `async fetch()` function scope, which fails function init so even `/api/keepalive` 500s. Move the `await` (and helpers depending on it) inside an existing `{...}` block; don't create bare blocks at function scope. Diagnose: if `/api/keepalive` 500s with no change to its handler, revert the last backend change and push to confirm.
- **`/api/tonight` returns `{error:"X is not defined"}` while `/api/keepalive` is fine** — a runtime `ReferenceError` inside the route handler. Cache reads/writes use `CACHE2?.get(key,"json")` / `CACHE2.put(key,value,{expirationTtl:N})` (NOT `.set()`) and the bust flag is `isBustCache` — check for a typo'd name.
- **Fix appears deployed but prod still shows old behavior** — check `git log --oneline origin/main..HEAD` for unpushed commits (`git push origin main` deploys). For a 504/timeout class issue, see the FD-exhaustion gate (`fdProbe` in `?debug=1`) → INFRA.md.
