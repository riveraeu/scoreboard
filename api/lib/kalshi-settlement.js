// api/lib/kalshi-settlement.js
// Kalshi-settlement-based shadow_plays grading — DRY-RUN ONLY as of 2026-07-23 (see
// project_kalshi_settlement_grading_2026_07_23 memory). Every Kalshi market carries its own
// `result` ("yes"/"no", or "scalar" for a void/postponement) once settled — this lets grading
// skip the whole zoo of per-sport ESPN/statsapi resolvers (team-name matching, date-window
// fuzzing) in favor of one universal lookup by the row's own kalshi_ticker. Not yet authoritative
// — see handlers/shadow.js's dry-run comparison pass.

const KALSHI_MARKETS = "https://api.elections.kalshi.com/trade-api/v2/markets";
const TICKER_BATCH_SIZE = 200; // comfortably under the empirically-confirmed-OK ~300 batch size

// Which yes/no side of the row's OWN kalshi_ticker counts as a win for this row. Computed once
// at shadow-snapshot write time (chokepoint: handlers/shadow.js row-mapping) from fields already
// present on the in-memory play object — never re-touches the 13 emit modules.
//   - kalshiSide already set explicitly (game-totals.js/ml-spread.js/props.js, incl. the tricky
//     spread case, where it's the only reliable signal — spread rows don't store a plain
//     direction) → use it directly.
//   - direction "over"/"under" (soccer.js/fight.js/mlb-outs.js, which don't set kalshiSide) →
//     "under" means we captured the NO price, "over" the YES price.
//   - direction null (every one-ticker-per-outcome family: ml/game/advance/h2h/top10/tennis/
//     nba-summer/lmb/soccer's game family/club-soccer-ml) → the captured ticker IS the outcome
//     we picked, so "yes" is trivially correct.
export function deriveKalshiSide({ kalshiSide, direction } = {}) {
  if (kalshiSide === "yes" || kalshiSide === "no") return kalshiSide;
  if (direction === "under") return "no";
  if (direction === "over") return "yes";
  return "yes";
}

// Did the row's bet win, given Kalshi's raw settlement result for its own ticker? Returns null
// (don't grade) when the market isn't settled cleanly yes/no yet — either still open, or a
// genuine void (result: "scalar", seen across every family checked: MLB props/outs, tennis
// retirements, golf withdrawals, LMB/MLS postponements — mechanism varies by family, e.g. PGA
// voids at exactly 0.50 while MLB props void at the last traded price, but it never means a real
// win/loss either way).
export function wonFromKalshiResult(result, side) {
  if (result !== "yes" && result !== "no") return null;
  return result === side;
}

// Batch-fetch settlement status for a list of tickers. Sequential chunks (not parallel) —
// Kalshi rate-limits wide parallel bursts (same caution as kalshi-flow.js). Returns
// { settlements: Map(ticker -> { status, result }), meta }. Failure-closed: a chunk that fails
// all its attempts just leaves those tickers absent from the map (caller treats missing as
// "not resolvable this pass").
//
// Why the retries and the meta (2026-07-26): the original single-attempt version dropped a whole
// 200-ticker chunk on any non-ok/throw with NO signal that it had done so. Four back-to-back runs
// of /api/kalshi-dryrun-check over an identical 5510-row input returned settlementsFound of
// 2200/2000/2600/2600 — whole chunks vanishing at random — and the 2200 run reported a clean
// `disagree: 0` purely because the chunk holding the one known bad settlement
// (KXMLBTEAMTOTAL-26JUL242215LAASF-SF8, see project_kalshi_missettlement_watch_2026_07_25) had
// been silently skipped. A tripwire that reports "all clear" when it simply failed to look is
// worse than no tripwire. Grading itself was never wrong — a missing ticker classifies as
// "pending" and retries next pass — but the resolver under-grades invisibly, so `chunksFailed`
// now travels with the data and callers surface it.
//
// The cause turned out to be HTTP 414 (URI Too Long) on over-long chunks — see
// MAX_TICKER_QUERY_CHARS below, which is the real fix. The retries stay because the telemetry also
// showed genuinely transient failures recovering on attempt 2 (chunksRetried was 9/18 on the first
// live run); each attempt gets a fresh AbortSignal so a retry has a full budget rather than the
// remains of the first one's.
const SETTLEMENT_FETCH_ATTEMPTS = 3;
const SETTLEMENT_FETCH_TIMEOUT_MS = 10_000;
const SETTLEMENT_RETRY_BACKOFF_MS = [250, 750];
// Cap the `tickers=` query string well under the ~8KB URL ceiling. THE ACTUAL CAUSE of the silent
// drops (named by this module's own telemetry on the first deploy, 2026-07-26): a 200-ticker chunk
// is ~7.5KB of query string at ~37 chars/ticker, so any chunk holding longer-than-average tickers
// tipped over and came back HTTP 414. Deterministic per chunk — but WHICH tickers land in a given
// chunk shifts as the row set grows, which is exactly why it presented as random flakiness across
// runs. Chunk by URL length, not by count, and TICKER_BATCH_SIZE becomes just an upper bound.
const MAX_TICKER_QUERY_CHARS = 6000;

// 414 is a property of the request, not a transient condition — retrying one is pure latency.
// Same for the other 4xx except 429 (rate limit, genuinely worth a retry).
const isRetryableStatus = (status) => status === 429 || status >= 500;

// Split tickers into chunks bounded by BOTH count and encoded query length.
function chunkTickers(unique) {
  const chunks = [];
  let cur = [], curLen = 0;
  for (const t of unique) {
    const addLen = encodeURIComponent(t).length + 1; // +1 for the joining comma
    if (cur.length && (cur.length >= TICKER_BATCH_SIZE || curLen + addLen > MAX_TICKER_QUERY_CHARS)) {
      chunks.push(cur); cur = []; curLen = 0;
    }
    cur.push(t); curLen += addLen;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export async function fetchKalshiSettlementsWithMeta(tickers) {
  const settlements = new Map();
  const unique = [...new Set((tickers || []).filter(Boolean))];
  const chunks = chunkTickers(unique);
  const meta = {
    tickersRequested: unique.length,
    tickersFound: 0,
    chunksTotal: chunks.length,
    chunksFailed: 0,
    chunksRetried: 0,
    failures: [], // up to 5 {chunkIndex, size, reason} — enough to name the failure mode
  };

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    let reason = null;

    for (let attempt = 0; attempt < SETTLEMENT_FETCH_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        meta.chunksRetried++;
        const backoff = SETTLEMENT_RETRY_BACKOFF_MS[attempt - 1] ?? 750;
        await new Promise(r => setTimeout(r, backoff));
      }
      try {
        const res = await fetch(`${KALSHI_MARKETS}?tickers=${chunk.join(",")}`, {
          signal: AbortSignal.timeout(SETTLEMENT_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          reason = `HTTP ${res.status}`;
          if (!isRetryableStatus(res.status)) break; // deterministic (e.g. 414) — retrying is futile
          continue;
        }
        const data = await res.json();
        for (const m of (data?.markets || [])) {
          if (m?.ticker) settlements.set(m.ticker, { status: m.status, result: m.result });
        }
        reason = null;
        break;
      } catch (e) {
        reason = e?.name === "TimeoutError" ? "timeout" : (e?.message || "fetch failed");
      }
    }

    if (reason) {
      meta.chunksFailed++;
      if (meta.failures.length < 5) meta.failures.push({ chunkIndex, size: chunk.length, reason });
    }
  }

  meta.tickersFound = settlements.size;
  if (meta.chunksFailed) {
    console.warn(`[kalshi-settlement] ${meta.chunksFailed}/${meta.chunksTotal} chunks failed after ${SETTLEMENT_FETCH_ATTEMPTS} attempts — ${meta.tickersFound}/${meta.tickersRequested} tickers resolved; sample=${JSON.stringify(meta.failures)}`);
  }
  return { settlements, meta };
}

// Back-compat wrapper — callers that don't surface fetch health (maker.js V1 grading,
// shadow-report's quotedOutcomes) keep getting the plain Map.
export async function fetchKalshiSettlements(tickers) {
  return (await fetchKalshiSettlementsWithMeta(tickers)).settlements;
}

// Pure: three-state classification of one ticker+side against the settlements map.
//   { state: "pending" }  — not finalized yet (or fetch missed it). Retry next pass.
//   { state: "void", result } — finalized, but the result isn't a clean yes/no ("scalar").
//   { state: "graded", won } — finalized binary; `won` is whether OUR side took it.
//
// Why this exists alongside the two null-returning helpers below: they collapse "pending" and
// "void" into one `null`, which is exactly right for maker PnL grading (both mean "don't book
// anything yet") but wrong for shadow_plays resolution. A void is TERMINAL — the market will never
// settle yes/no, so the row should be marked resolved with won=NULL immediately (the abandon
// idiom) rather than being retried for 14 days until the abandonment sweep catches it. Callers
// that need to tell those apart use this; callers that don't keep using the wrappers.
export function classifyTickerSide(ticker, side, settlements) {
  if (!ticker) return { state: "pending" };
  const m = settlements.get(ticker);
  if (!m || m.status !== "finalized") return { state: "pending" };
  const won = wonFromKalshiResult(m.result, side);
  if (won === null) return { state: "void", result: m.result };
  return { state: "graded", won };
}

// Pure: same as classifyTickerSide but for a shadow_plays row carrying kalshi_ticker/kalshi_side.
export function classifyRowViaKalshi(row, settlements) {
  return classifyTickerSide(row?.kalshi_ticker, row?.kalshi_side, settlements);
}

// Pure: given a specific ticker + which side ("yes"/"no") we care about, what would Kalshi's
// settlement say? Returns null when not resolvable this pass (not finalized yet, or void).
// Shared by resolveRowViaKalshi (shadow_plays taker rows, which carry kalshi_ticker/kalshi_side)
// and maker.js's V1 grading (maker_quotes/maker_fills rows, which use ticker/quote_side directly
// and have no shadow_plays row to read from — see project_maker_v1_settlement_grading memory).
export function resolveTickerSideViaKalshi(ticker, side, settlements) {
  return classifyTickerSide(ticker, side, settlements).won ?? null;
}

// Pure: given a row (with kalshi_ticker/kalshi_side already on it) and the settlements map,
// what WOULD Kalshi-based grading conclude? Returns null when not resolvable this pass (not yet
// settled, or void) — same meaning as wonFromKalshiResult's null.
export function resolveRowViaKalshi(row, settlements) {
  return resolveTickerSideViaKalshi(row?.kalshi_ticker, row?.kalshi_side, settlements);
}
