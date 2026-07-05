// Global outbound-fetch concurrency gate. Side-effect module — import once at the top
// of api/[...path].js before any handler code runs.
//
// Why: the function instance has a 1024 file-descriptor ceiling. Undici opens one socket
// per CONCURRENT request to an origin and keeps finished sockets pooled for keep-alive
// (server hints extend their idle lifetime past a whole request), so total open sockets
// ≈ the SUM of every module's peak Promise.all burst width — not total fetch count, and
// not visible in getActiveResourcesInfo (idle pooled sockets are unref'd). On 2026-07-05
// the byteam builders' combined bursts (WNBA per-player usage ~130, NBA mirrors, statsapi
// pitcher/PBP, per-player KV GETs, …) crossed the ceiling mid-/api/tonight: every later
// fetch in the run — ESPN and Upstash alike — failed with EMFILE/EBUSY and the dashboard
// showed "No games scheduled". Measured via the fdProbe milestones in handlers/tonight.js
// (30 fds after the Kalshi phase → 1024 after byteam).
//
// One chokepoint beats per-module caps: every fetch (ESPN, statsapi, Kalshi, Upstash cmd,
// Neon's serverless driver) shares the same FD budget, so the bound must be global. With
// at most N requests in flight, undici reuses its pooled sockets instead of opening new
// ones, keeping total sockets ≈ N × distinct-origins, far under the ceiling. Per-phase
// pLimits in tonight.js/mlb-pitchers.js remain as pacing, but this is the guarantee.
//
// The slot is held until response HEADERS arrive (fetch resolves); body streaming happens
// outside the gate, so momentary open sockets can exceed N slightly — bounded, fine.
// 64: high enough that a queued fetch never sits long enough to trip the 5-6s
// AbortSignal.timeout call sites use (~1000-fetch bust run drains in seconds), low enough
// to leave ~10× headroom to the 1024 fd ceiling even with concurrent requests on the
// shared Fluid instance.
import { pLimit } from "./utils.js";

const GLOBAL_FETCH_CONCURRENCY = 64;

// Idempotent across module re-evaluations (dev reload, test double-import).
if (!globalThis.__scoreboardFetchGate) {
  globalThis.__scoreboardFetchGate = true;
  const _origFetch = globalThis.fetch.bind(globalThis);
  const _gate = pLimit(GLOBAL_FETCH_CONCURRENCY);
  globalThis.fetch = (...args) => _gate(() => _origFetch(...args));
}
