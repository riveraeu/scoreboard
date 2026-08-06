// Response helpers, CORS, and team ranking utilities.

export const ALLOWED_ORIGIN = "*";

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

export function jsonResponse(data, opts = false) {
  const headers = { "Content-Type": "application/json", ...corsHeaders() };
  if (opts === true) headers["Cache-Control"] = "no-store";
  else if (typeof opts === "number" && opts > 0) headers["Cache-Control"] = `public, max-age=${opts}`;
  else if (typeof opts === "string" && opts) headers["Cache-Control"] = opts;
  return new Response(JSON.stringify(data), { headers });
}

export function errorResponse(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

// Origin for server-side self-fetches (/api/live, /api/tonight from cron handlers).
// Cron invocations arrive on the deployment-generated URL (scoreboard-<hash>-…vercel.app),
// which sits behind Vercel Deployment Protection — a fetch to that origin 302s to the SSO
// HTML page, never JSON. Only the pinned production alias is public, so self-fetches must
// use it regardless of the incoming request's host. Localhost stays local (`vercel dev`).
const PROD_ORIGIN = "https://scoreboard-ivory-xi.vercel.app";

export function selfOrigin(request) {
  const origin = new URL(request.url).origin;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin) ? origin : PROD_ORIGIN;
}

// Fetch with named error logging. Returns {} on any failure so callers get graceful
// degradation without silently swallowing the root cause.
export function fetchSafe(label, url, opts) {
  return fetch(url, opts)
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .catch(e => { console.error(`[${label}]`, e?.message ?? String(e), url.slice(0, 120)); return {}; });
}

// Bounded-concurrency gate: pLimit(n) returns a wrapper that runs at most n tasks at
// once, queueing the rest. Unbounded Promise.all fetch fan-outs (player hydration,
// pitcher gamelogs/play-by-play) exhausted the function instance's file descriptors on
// big slates (EMFILE/EBUSY, 2026-07-05) — once exhausted, EVERY outbound fetch in the
// run (ESPN and Upstash alike) failed with "TypeError: fetch failed". Wrap the task,
// keep the Promise.all: `await Promise.all(keys.map(k => limit(() => work(k))))`.
export function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    active--;
    if (queue.length) queue.shift()();
  };
  return (fn) => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve().then(fn).then(
        (v) => { resolve(v); next(); },
        (e) => { reject(e); next(); },
      );
    };
    if (active < concurrency) run();
    else queue.push(run);
  });
}

// JSON response that also sets an HttpOnly cookie (used by auth login/register/logout).
export function cookieResponse(data, cookie) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...corsHeaders(), "Set-Cookie": cookie },
  });
}

// Extract live/final scores from ESPN scoreboard events.
// normFn maps raw ESPN abbreviations to the canonical form (e.g. GS→GSW).
export function parseGameScores(events, normFn) {
  const scores = {};
  const ptFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
  for (const event of events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const homeComp = (comp.competitors || []).find(c => c.homeAway === "home");
    const awayComp = (comp.competitors || []).find(c => c.homeAway === "away");
    if (!homeComp || !awayComp) continue;
    const hA = normFn ? normFn(homeComp.team?.abbreviation) : homeComp.team?.abbreviation;
    const awA = normFn ? normFn(awayComp.team?.abbreviation) : awayComp.team?.abbreviation;
    if (!hA || !awA) continue;
    const gameDate = event.date ? ptFmt.format(new Date(event.date)) : null;
    const pickRecord = (recs) => {
      if (!Array.isArray(recs)) return null;
      const overall = recs.find(r => r?.type === "total" || r?.name === "overall");
      return overall?.summary ?? recs[0]?.summary ?? null;
    };
    // Key includes gameDate so today and tomorrow's same-home-team games don't collide,
    // and event.date (full ISO) so same-day doubleheaders (e.g. DET @ BAL twice) don't either.
    scores[`${hA}|${gameDate ?? ""}|${event.date ?? ""}`] = {
      homeTeam: hA, awayTeam: awA,
      state: comp.status?.type?.state ?? "pre",
      detail: comp.status?.type?.shortDetail || comp.status?.type?.detail || "",
      homeScore: parseInt(homeComp.score ?? 0) || 0,
      awayScore: parseInt(awayComp.score ?? 0) || 0,
      gameDate,
      gameTime: event.date || null,
      seriesSummary: comp.series?.summary || null,
      homeRecord: pickRecord(homeComp.records),
      awayRecord: pickRecord(awayComp.records),
      // ESPN convention: 1=preseason, 2=regular, 3=postseason. Captured for calibration
      // splits — lets /api/auth/calibration filter or bucket plays by season type. Null
      // when ESPN omits it (rare).
      seasonType: event.season?.type ?? null,
    };
  }
  return scores;
}
