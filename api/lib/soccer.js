// api/lib/soccer.js
// Soccer (World Cup) data + model — Phase 1: one Elo-derived goal-rate pair feeds a single
// Dixon–Coles-corrected Poisson score matrix, and EVERY market type is a projection off that
// one matrix: 1X2 (home/draw/away), game total, team total, spread (handicap), and BTTS.
//
// Scope: FIFA World Cup only, shadow-only (`soccer|*` is intentionally NOT in the category
// gate — rows log to shadow_plays for calibration but never show as UI plays). Mirrors the
// tennis Phase-1 pattern: a deliberately minimal model with a small set of provisional knobs
// that the first shadow week calibrates; Phase 2 swaps the Elo→λ mapping for something richer
// (per-team attack/defence ratings, host/home adjustment, club leagues via club Elo).
//
// Data sources (no auth):
//   ratings : https://www.eloratings.net/World.tsv  (national-team World Football Elo)
//   results : https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD
//
// Settlement (verified against Kalshi rules_primary): ALL WC markets resolve on 90 minutes +
// stoppage, EXCLUDING extra time / penalties. So the regulation-time score matrix is exactly
// the settlement object, and even a knockout 1X2 settles as a draw if level at 90'.

// ── Provisional model knobs (anchored to the Elo win-expectancy curve, NOT to market prices;
// calibrated from the first shadow week). With these, the model's 1X2 win-expectancy
// (P(home)+0.5·P(draw)) tracks the standard Elo formula 1/(10^(-Δ/400)+1) to within ~0.01
// across Δ ∈ [0,300]. ─────────────────────────────────────────────────────────────────────
export const SOCCER_MU_TOTAL = 2.7;  // baseline expected total goals (WC group-stage average)
export const SOCCER_ELO_DIV  = 160;  // Elo diff → goal-supremacy scale: supremacy = Δelo / 160
export const SOCCER_DC_RHO   = -0.13; // Dixon–Coles low-score dependence (draw/low-score mass)
// Knockout "to advance": a tie that's level after 90' goes to extra time + penalties. Penalty
// shootouts regress hard to ~50/50 regardless of favorite, while ET goals only mildly favor the
// better side — so the 90'-draw mass is split toward the regulation-stronger team but shrunk
// toward a coin flip. w = 0.5 + k·(winShare−0.5); k=0.5 anchors halfway between a pure coin flip
// (k=0) and full regulation dominance (k=1). Provisional, anchored to shootout intuition NOT the
// market — shadow-calibrated, same doctrine as μ/C/ρ.
export const WC_ADVANCE_ET_SHRINK = 0.5;
const MATRIX_N = 11;                  // goals 0..10 per team — captures >99.99% of WC mass

// ── Team registry + ESPN→canonical name resolution now live in soccer-wc-teams.js (extracted
// 2026-08-04 so they survive this file's deletion in the model teardown). Imported for this file's
// own internal use and re-exported so existing importers of soccer.js keep working until repointed.
import { WC_TEAMS, espnToCanonical } from "./soccer-wc-teams.js";
export { WC_TEAMS, espnToCanonical };

// ── Elo index ── fetch + parse World.tsv into { CODE: rating }. The TSV is rank-ordered rows;
// column 2 (0-based) is the 2-letter code, column 3 the current Elo. Returns a plain object
// (JSON-serializable for KV). Returns null on fetch failure (caller drops soccer plays).
export function parseEloTsv(text) {
  const out = {};
  for (const line of (text || "").split("\n")) {
    const f = line.split("\t");
    if (f.length > 3) {
      const code = f[2];
      const rating = parseFloat(f[3]);
      if (code && Number.isFinite(rating)) out[code] = rating;
    }
  }
  return out;
}

export async function getEloIndex({ cache, isBustCache } = {}) {
  const key = "soccer:elo:world";
  if (cache && !isBustCache) {
    try {
      const hit = await cache.get(key);
      if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit;
    } catch {}
  }
  let text;
  try {
    const res = await fetch("https://www.eloratings.net/World.tsv", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    text = await res.text();
  } catch { return null; }
  const index = parseEloTsv(text);
  if (!index || Object.keys(index).length < 50) return null; // sanity: TSV has ~240 nations
  if (cache) {
    try { await cache.put(key, JSON.stringify(index), { expirationTtl: 43200 }); } catch {} // 12h
  }
  return index;
}

// Elo rating for a canonical FIFA code, or null if either the code or its Elo entry is missing.
export function eloForTeam(index, canon) {
  const elo = WC_TEAMS[canon]?.elo;
  if (!elo || !index) return null;
  const r = index[elo];
  return Number.isFinite(r) ? r : null;
}

// ── Model core ──────────────────────────────────────────────────────────────────────────

// Elo difference → per-team goal rates. home_adv = 0 (WC 2026 is on neutral fields except host
// nations — a host bump is deferred to Phase 2). Supremacy is split symmetrically around the
// baseline total, then each λ is floored to a small positive so the Poisson stays well-defined
// even for extreme mismatches.
export function lambdasFromElo(eloHome, eloAway, { muTotal = SOCCER_MU_TOTAL, eloDiv = SOCCER_ELO_DIV, homeAdv = 0 } = {}) {
  const supremacy = (eloHome - eloAway + homeAdv) / eloDiv;
  const lambdaHome = Math.max((muTotal + supremacy) / 2, 0.15);
  const lambdaAway = Math.max((muTotal - supremacy) / 2, 0.15);
  return { lambdaHome, lambdaAway };
}

function poissonPmf(k, lambda) {
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

// Dixon–Coles low-score correction τ on the four cells {0-0,0-1,1-0,1-1} (h = home goals,
// a = away goals), with λ=home rate, μ=away rate.
function dcTau(h, a, lambda, mu, rho) {
  if (h === 0 && a === 0) return 1 - lambda * mu * rho;
  if (h === 0 && a === 1) return 1 + lambda * rho;
  if (h === 1 && a === 0) return 1 + mu * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

// Build the normalized score matrix M[h][a] = P(home scores h, away scores a) under
// independent Poisson with a Dixon–Coles low-score correction. Rows = home goals.
export function buildScoreMatrix(lambdaHome, lambdaAway, rho = SOCCER_DC_RHO, N = MATRIX_N) {
  const M = [];
  let sum = 0;
  for (let h = 0; h < N; h++) {
    const row = [];
    const ph = poissonPmf(h, lambdaHome);
    for (let a = 0; a < N; a++) {
      const v = ph * poissonPmf(a, lambdaAway) * dcTau(h, a, lambdaHome, lambdaAway, rho);
      row.push(v);
      sum += v;
    }
    M.push(row);
  }
  for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) M[h][a] /= sum;
  return M;
}

// ── Market projections off one matrix ── all return a probability in [0,1]. ─────────────────

// 1X2: P(home win) / P(draw) / P(away win).
export function prob1x2(M) {
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h < M.length; h++) {
    for (let a = 0; a < M.length; a++) {
      if (h > a) home += M[h][a];
      else if (h === a) draw += M[h][a];
      else away += M[h][a];
    }
  }
  return { home, draw, away };
}

// Knockout "to advance" probability for the side with (pWin, pLoss) in regulation and a shared
// draw mass pDraw: P(advance) = pWin + pDraw·w, where w = P(win ET/penalties | 90' draw). The
// draw mass is allocated by the regulation win-share, shrunk toward a coin flip by k (see
// WC_ADVANCE_ET_SHRINK). winShare falls back to 0.5 when both teams are shut out in regulation.
export function advanceProb(pWin, pDraw, pLoss, k = WC_ADVANCE_ET_SHRINK) {
  const nonDraw = pWin + pLoss;
  const winShare = nonDraw > 0 ? pWin / nonDraw : 0.5;
  const w = 0.5 + k * (winShare - 0.5);
  return pWin + pDraw * w;
}

// Game total OVER: P(home + away > line). `line` is the X.5 floor_strike.
export function probTotalOver(M, line) {
  let p = 0;
  for (let h = 0; h < M.length; h++)
    for (let a = 0; a < M.length; a++)
      if (h + a > line) p += M[h][a];
  return p;
}

// Team total OVER: P(team goals > line). isHome picks the matrix axis (rows = home).
export function probTeamOver(M, line, isHome) {
  let p = 0;
  for (let h = 0; h < M.length; h++)
    for (let a = 0; a < M.length; a++)
      if ((isHome ? h : a) > line) p += M[h][a];
  return p;
}

// Spread / handicap: P(favored team wins by more than `line` goals). favIsHome picks the sign.
export function probSpreadCover(M, line, favIsHome) {
  let p = 0;
  for (let h = 0; h < M.length; h++)
    for (let a = 0; a < M.length; a++) {
      const margin = favIsHome ? h - a : a - h;
      if (margin > line) p += M[h][a];
    }
  return p;
}

// BTTS: P(home ≥ 1 AND away ≥ 1).
export function probBtts(M) {
  let p = 0;
  for (let h = 1; h < M.length; h++)
    for (let a = 1; a < M.length; a++)
      p += M[h][a];
  return p;
}

// ── Resolver source ── fetch completed/in-progress WC games for a date (YYYYMMDD) and return
// [{ codes: {CANON: goals,...}, final: bool }]. `final` is regulation full-time (90'+stoppage).
// Note (knockout caveat, ~Jul 4+): for knockout ties ESPN's competitor `.score` is the 90'
// score; if a future ESPN payload reports a post-ET aggregate here, this read must switch to the
// regulation line score. Group stage (through ~Jul 2) is unambiguous.
export async function fetchWcFinals(dateStr) {
  let json;
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    json = await res.json();
  } catch { return []; }
  const out = [];
  for (const ev of (json?.events || [])) {
    const comp = (ev?.competitions || [])[0];
    if (!comp) continue;
    const status = comp?.status?.type;
    const final = status?.completed === true && status?.name === "STATUS_FULL_TIME";
    const codes = {};
    let ok = true;
    for (const c of (comp?.competitors || [])) {
      const t = c?.team || {};
      const canon = espnToCanonical(t.abbreviation, t.displayName);
      const goals = parseInt(c?.score, 10);
      if (!canon || !Number.isFinite(goals)) { ok = false; break; }
      codes[canon] = goals;
    }
    if (ok && Object.keys(codes).length === 2) out.push({ codes, final });
  }
  return out;
}

// ── Schedule (any status, for a real gameTime) ───────────────────────────────
// Every event on the scoreboard (played or not) → keyed by sorted canonical pair "A|B",
// { gameTime (ISO kickoff) }. Unlike fetchWcFinals above (which requires both scores to be
// parseable, so future games silently fall out), this keeps not-yet-played games since the
// emit path needs an upcoming kickoff time before the result exists. Found 2026-07-23:
// computeMakerQuote (maker.js) requires a real future stagingRow.gameTime, but the soccer emit
// path was hardcoding gameTime:null despite ev.date carrying exactly that on the same fetch.
export async function fetchWcSchedule(dateStr) {
  let json;
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    json = await res.json();
  } catch { return {}; }
  const out = {};
  for (const ev of (json?.events || [])) {
    const comp = (ev?.competitions || [])[0];
    if (!comp) continue;
    const codes = [];
    let ok = true;
    for (const c of (comp?.competitors || [])) {
      const t = c?.team || {};
      const canon = espnToCanonical(t.abbreviation, t.displayName);
      if (!canon) { ok = false; break; }
      codes.push(canon);
    }
    if (!ok || codes.length !== 2) continue;
    const key = [...codes].sort().join("|");
    if (!out[key]) out[key] = { gameTime: ev.date || null };
  }
  return out;
}

// Fetch + KV-cache one date's schedule (30min TTL — same idiom as mls.js's getMlsSchedule).
export async function getWcSchedule({ dateStr, cache, isBustCache } = {}) {
  if (!dateStr) return {};
  const key = `soccer:schedule:${dateStr}`;
  if (cache && !isBustCache) {
    try { const hit = await cache.get(key); if (hit) return typeof hit === "string" ? JSON.parse(hit) : hit; } catch {}
  }
  const schedule = await fetchWcSchedule(dateStr);
  if (cache && schedule) {
    try { await cache.put(key, JSON.stringify(schedule), { expirationTtl: 1800 }); } catch {}
  }
  return schedule;
}

// ── Knockout-advance resolver source ── who advanced past a knockout tie (the ET/penalties
// outcome, NOT the 90' score). ESPN flags the advancing competitor with `advance:true`; for ties
// decided inside 90' that field can be absent, so fall back to `winner:true`. A match counts as
// resolvable only when completed AND exactly one side is flagged. Returns
// [{ codes:{CANON:bool}, advancer:CANON|null, final }] — mirrors fetchWcFinals' shape so the
// resolver can find a tie by the unordered {home,away} pair.
export async function fetchWcAdvance(dateStr) {
  let json;
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    json = await res.json();
  } catch { return []; }
  const out = [];
  for (const ev of (json?.events || [])) {
    const comp = (ev?.competitions || [])[0];
    if (!comp) continue;
    const final = comp?.status?.type?.completed === true;
    const codes = {};
    let advancer = null, advCount = 0, ok = true;
    for (const c of (comp?.competitors || [])) {
      const t = c?.team || {};
      const canon = espnToCanonical(t.abbreviation, t.displayName);
      if (!canon) { ok = false; break; }
      const adv = c?.advance === true || (c?.advance == null && c?.winner === true);
      codes[canon] = adv;
      if (adv) { advancer = canon; advCount++; }
    }
    // Exactly one advancer — a knockout tie can't end level, so two-flagged/none-flagged means the
    // data isn't settled yet (treat as not-final so the resolver records noData, not a wrong grade).
    if (ok && Object.keys(codes).length === 2) out.push({ codes, advancer: advCount === 1 ? advancer : null, final });
  }
  return out;
}

// ── Half resolver source ── per-team per-half goals for a date (YYYYMMDD). The scoreboard has no
// per-half breakdown (linescores:null), so for each FINAL game we fetch the event summary, whose
// header competitors carry linescores [0]=1st-half goals, [1]=2nd-half goals (verified: FRA [0,3]
// / SEN [0,1] = 3-1, all 2nd half). Returns [{ h1:{CANON:goals}, h2:{CANON:goals}, final }].
// 2H is the 2nd-half segment only (matches Kalshi "2nd Half" settlement); ET periods (index 2+)
// are ignored. ~4-8 summary fetches per WC day, run in parallel.
export async function fetchWcHalfFinals(dateStr) {
  let sb;
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard${dateStr ? `?dates=${dateStr}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    sb = await res.json();
  } catch { return []; }
  const events = sb?.events || [];
  const out = await Promise.all(events.map(async (ev) => {
    const comp = (ev?.competitions || [])[0];
    const status = comp?.status?.type;
    const final = status?.completed === true && status?.name === "STATUS_FULL_TIME";
    if (!final || !ev?.id) return { h1: {}, h2: {}, final: false };
    let sum;
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${ev.id}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { h1: {}, h2: {}, final: false };
      sum = await r.json();
    } catch { return { h1: {}, h2: {}, final: false }; }
    const hdrComp = (sum?.header?.competitions || [])[0];
    const h1 = {}, h2 = {};
    let ok = true;
    for (const c of (hdrComp?.competitors || [])) {
      const t = c?.team || {};
      const canon = espnToCanonical(t.abbreviation, t.displayName);
      const ls = c?.linescores || [];
      const g1 = parseInt(ls[0]?.displayValue ?? ls[0]?.value, 10);
      const g2 = parseInt(ls[1]?.displayValue ?? ls[1]?.value, 10);
      if (!canon || !Number.isFinite(g1) || !Number.isFinite(g2)) { ok = false; break; }
      h1[canon] = g1; h2[canon] = g2;
    }
    return (ok && Object.keys(h1).length === 2) ? { h1, h2, final: true } : { h1: {}, h2: {}, final: false };
  }));
  return out;
}
