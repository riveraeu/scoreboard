// /api/shadow-snapshot — daily cron that logs ALL model predictions to Neon for
// unbiased shadow calibration. No edge gate, no dc gate — captures the full distribution.
// Auth: CRON_SECRET (same pattern as kalshi-snapshot).
// Cron: 0 22 * * * (3pm PT — after most lineup confirmations, before first pitch).

import { neonQuery, neonBatchUpsert, neonBatchResolve, neonBatchPrePriceUpdate, neonExec } from "../neon.js";
import { fetchTradeFlow } from "../kalshi-flow.js";
import { errorResponse, jsonResponse, selfOrigin } from "../utils.js";
import { verifyJWT } from "../auth-utils.js";
import { fetchCompletedMatches } from "../tennis.js";
import { fetchWcFinals, fetchWcHalfFinals, fetchWcAdvance } from "../soccer.js";
import { fetchFightResults, matchFightByCodes, normFighterName } from "../mma.js";
import { fetchRoundScores, normGolfName } from "../golf.js";
import { fetchRaceResults } from "../nascar.js";
import { fetchSlResults } from "../nba-summer.js";
import { KALSHI_GATE, KALSHI_CAP, EDGE_GATE_SERVER } from "../config.js";
import { passesCategoryGate } from "../category-gate.js";
import { INPUT_SEARCH_EXHAUSTED, stillExhausted } from "../model-holds.js";
import { POLY_SERIES, POLY_DISMISSED_SPORTS, fetchPolySportsCatalog, fetchPolySeriesEvents } from "../polymarket.js";
import {
  MIN_N_WINDOW as _MIN_N_WINDOW,
  MIN_N_PROMOTE as _MIN_N_PROMOTE,
  priceWindowBins as _priceWindowBins,
  discoverPriceWindow as _discoverPriceWindow,
  windowQuality as _windowQuality,
} from "../price-window.js";

const SHADOW_TABLE = "shadow_plays";
const COLUMNS = [
  "id", "snapshot_date", "sport", "stat", "game_type",
  "player_name", "player_id", "home_team", "away_team",
  "scoring_team", "pick_team", "pick_line", "threshold", "direction",
  "model_true_pct", "kalshi_pct", "no_kalshi_pct", "edge",
  "dc", "dc_qualified", "game_date", "game_time",
  "group_id", "group_size", "threshold_rank", "is_best_edge",
  "snapshot_model_version", "season_type", "features",
  "kalshi_yes_price", "kalshi_no_price",
];

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${SHADOW_TABLE} (
  id TEXT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  sport TEXT NOT NULL,
  stat TEXT,
  game_type TEXT,
  player_name TEXT,
  player_id TEXT,
  home_team TEXT,
  away_team TEXT,
  scoring_team TEXT,
  pick_team TEXT,
  pick_line NUMERIC,
  threshold NUMERIC,
  direction TEXT,
  model_true_pct NUMERIC NOT NULL,
  kalshi_pct NUMERIC,
  no_kalshi_pct NUMERIC,
  edge NUMERIC,
  dc INTEGER,
  dc_qualified BOOLEAN,
  game_date TEXT,
  game_time TEXT,
  group_id TEXT,
  group_size INTEGER,
  threshold_rank INTEGER,
  is_best_edge BOOLEAN,
  resolved BOOLEAN DEFAULT FALSE,
  won BOOLEAN,
  actual_value NUMERIC,
  resolved_at TIMESTAMPTZ,
  snapshot_model_version TEXT DEFAULT 'v2',
  season_type INTEGER,
  features JSONB
);
CREATE INDEX IF NOT EXISTS shadow_plays_date_idx ON ${SHADOW_TABLE} (snapshot_date, resolved);
CREATE INDEX IF NOT EXISTS shadow_plays_cat_idx ON ${SHADOW_TABLE} (sport, stat, game_type, model_true_pct);
CREATE INDEX IF NOT EXISTS shadow_plays_group_idx ON ${SHADOW_TABLE} (group_id);
`;

// P0: add decimal price columns for clean ROI math. IF NOT EXISTS makes this idempotent.
const ADD_KALSHI_PRICE_COLS_SQL = `
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS kalshi_yes_price NUMERIC;
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS kalshi_no_price NUMERIC
`;

// Pre-game price columns for CLV / line-movement tracking.
const ADD_PRE_PRICE_COLS_SQL = `
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS kalshi_yes_price_pre NUMERIC;
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS kalshi_no_price_pre NUMERIC;
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS price_pre_at TIMESTAMPTZ
`;

// Polymarket cross-venue ML deltas (Phase 1a observatory). Its own table so the 4-daily snapshots
// accumulate into a multi-day Kalshi-vs-Polymarket divergence distribution (the kill-gate read).
// One row per game-side per day: id = `${date}|${sport}|${game}|${market}|${side}`, ON CONFLICT
// DO NOTHING keeps the first snapshot of the day. No resolution — this measures price divergence,
// not outcomes (ESPN scores are venue-independent; the model honesty lives in shadow_plays).
const POLY_DELTAS_TABLE = "polymarket_deltas";
const POLY_DELTAS_COLUMNS = [
  "id", "snapshot_date", "sport", "game", "game_date", "market", "side",
  "kalshi_pct", "poly_pct", "delta_cents", "model_true_pct",
  // Phase 1b: executable Poly buy price (book-walked at a $30 ref) — only the bettable [67,91]
  // sides carry these; exec_delta_cents = poly_vwap_pct − kalshi_pct (negative = surviving edge).
  "poly_vwap_pct", "poly_slip_cents", "exec_delta_cents",
];
const CREATE_POLY_DELTAS_SQL = `
CREATE TABLE IF NOT EXISTS ${POLY_DELTAS_TABLE} (
  id TEXT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  sport TEXT NOT NULL,
  game TEXT NOT NULL,
  game_date TEXT,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  kalshi_pct NUMERIC,
  poly_pct NUMERIC,
  delta_cents NUMERIC,
  model_true_pct NUMERIC,
  poly_vwap_pct NUMERIC,
  poly_slip_cents NUMERIC,
  exec_delta_cents NUMERIC,
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS polymarket_deltas_date_idx ON ${POLY_DELTAS_TABLE} (snapshot_date);
CREATE INDEX IF NOT EXISTS polymarket_deltas_sport_idx ON ${POLY_DELTAS_TABLE} (sport);
`;
// Executable-price columns added 2026-06-23 (Phase 1b) — ALTER for the table created earlier today.
const ADD_POLY_EXEC_COLS_SQL = `
ALTER TABLE ${POLY_DELTAS_TABLE} ADD COLUMN IF NOT EXISTS poly_vwap_pct NUMERIC;
ALTER TABLE ${POLY_DELTAS_TABLE} ADD COLUMN IF NOT EXISTS poly_slip_cents NUMERIC;
ALTER TABLE ${POLY_DELTAS_TABLE} ADD COLUMN IF NOT EXISTS exec_delta_cents NUMERIC
`;

// Sportsbook-reference deltas (Phase 1a, 2026-06-29) — de-vigged sharp-book ML fair value vs the
// Kalshi price. One row per game-side per day. delta_cents = book_fair_pct − kalshi_pct (+ = Kalshi
// cheap vs the sharp book = lagging = edge to BUY). No resolution — measures price divergence, not
// outcomes (the kill-gate is "does Kalshi systematically lag the book?"). `book` = source bookmaker.
const SB_DELTAS_TABLE = "sportsbook_deltas";
const SB_DELTAS_COLUMNS = [
  "id", "snapshot_date", "sport", "game", "game_date", "market", "side",
  "kalshi_pct", "book_fair_pct", "delta_cents", "book", "model_true_pct",
];
const CREATE_SB_DELTAS_SQL = `
CREATE TABLE IF NOT EXISTS ${SB_DELTAS_TABLE} (
  id TEXT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  sport TEXT NOT NULL,
  game TEXT NOT NULL,
  game_date TEXT,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  kalshi_pct NUMERIC,
  book_fair_pct NUMERIC,
  delta_cents NUMERIC,
  book TEXT,
  model_true_pct NUMERIC,
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sportsbook_deltas_date_idx ON ${SB_DELTAS_TABLE} (snapshot_date);
CREATE INDEX IF NOT EXISTS sportsbook_deltas_sport_idx ON ${SB_DELTAS_TABLE} (sport);
`;

// Stable deterministic ID for a play — unique per player/teams + stat/line + date.
// fallbackDate (the PT snapshot date) scopes plays whose gameDate is null: without it,
// date-less ids collide across days — a next-day Kalshi pre-listing logged yesterday
// permanently blocked today's row via ON CONFLICT DO NOTHING, and a rematch weeks later
// with the same threshold could never log at all (found via 17 noData rows, 2026-06-11).
// Same-day re-snapshots (8:05am vs 3:05pm) still dedup since fallbackDate is equal.
function shadowId(p, fallbackDate = "") {
  return [
    p.sport || "",
    p.gameDate || fallbackDate || "",
    p.homeTeam || "",
    p.awayTeam || "",
    p.playerName || "",
    p.stat || p.gameType || "",
    String(p.threshold ?? p.pickLine ?? ""),
    p.direction || "",
    p.pickTeam || "",
  ].join("|");
}

// group_id links all threshold variants for the same player/matchup on the same game.
// Same fallbackDate scoping as shadowId — date-less group_ids would merge different
// days' alt-line groups in the DB-side analyses (intraGroupCorr, threshold_rank ROI).
// Team rows key stat-first to mirror the analyses' COALESCE(stat, game_type): gameType-first
// merged the whole ML family (ml/f3ml/f5ml/f7ml all carry gameType "ml") into ONE rank group,
// making threshold_rank=1 a cross-category lottery — f5ml's rank-1 population starved when
// f3/f7 capture started 2026-07-01. Historical rows were re-ranked under this key on
// 2026-07-13 (?rerankgroups=1 backfill below), so stored ranks are uniform stat-first.
function groupId(p, fallbackDate = "") {
  if (p.playerName) {
    return `pp|${p.sport}|${p.playerId || p.playerName}|${p.gameDate || fallbackDate || ""}`;
  }
  return `tm|${p.sport}|${p.stat || p.gameType}|${p.homeTeam}|${p.awayTeam}|${p.gameDate || fallbackDate || ""}`;
}

// Annotate each play with threshold_rank (1 = closest to 50% — most information) and
// is_best_edge within its group. Mutates the plays in-place.
function annotateGroups(plays, fallbackDate = "") {
  const groups = new Map();
  for (const p of plays) {
    const gid = groupId(p, fallbackDate);
    p._gid = gid;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(p);
  }

  for (const [, group] of groups) {
    // Sort by distance from 50% (ascending = rank 1 closest to 50%)
    const sorted = [...group].sort((a, b) =>
      Math.abs((a.truePct ?? 50) - 50) - Math.abs((b.truePct ?? 50) - 50)
    );
    const bestEdge = group.reduce((best, p) =>
      (p.edge ?? 0) > (best.edge ?? 0) ? p : best
    , group[0]);

    for (let i = 0; i < sorted.length; i++) {
      sorted[i]._rank = i + 1;
    }
    for (const p of group) {
      p._groupSize = group.length;
      p._isBestEdge = p === bestEdge;
    }
  }
}

// Extract only the feature fields useful for future meta-model training.
// Excludes fields already stored in dedicated columns.
const DEDICATED = new Set([
  "sport", "stat", "gameType", "playerName", "playerId", "homeTeam", "awayTeam",
  "scoringTeam", "pickTeam", "pickLine", "threshold", "direction",
  "truePct", "kalshiPct", "noKalshiPct", "edge", "dataConfidence", "dcQualified",
  "gameDate", "gameTime", "modelVersion", "seasonType",
]);

// Standardized exogenous-signal namespace. The catch-all below logs whatever each emit
// path happened to hang on the play (rich for props, sparse for game/new-sport markets),
// so coverage is by-accident and naming drifts (props "lineupConfirmed" vs game markets
// "lineupsConfirmed" — same signal, two keys, never aggregated). This folds the raw,
// EXOGENOUS dimensions a market-mispricing signal is most likely to live in onto ONE
// uniform x* set, present across EVERY category. tune:residual ranks these first (they're
// market-independent, so slicing model-residual on them isn't circular, unlike the model
// intermediates the catch-all also logs). Pure capture — no formula consumes it.
export function exogenousSignals(p) { // exported for unit tests only
  const x = {};
  const set = (k, v) => { if (v != null) x[k] = v; };
  set("xVolume", p.kalshiVolume);   // Kalshi traded/resting volume — liquidity proxy
  set("xSpread", p.kalshiSpread);   // yes/no spread (¢) — thinness proxy
  set("xLineMove", p.lineMove);     // price drift since open — latency signal (props today)
  const lc = p.lineupConfirmed ?? p.lineupsConfirmed; // unify the two historical keys
  if (lc != null) x.xLineupConfirmed = lc;
  set("xRestDays", p.pitcherDaysRest); // MLB pitcher days rest
  set("xWindOutMph", p.windOutMph);    // signed out-to-CF wind (MLB, when hydrated)
  set("xTempF", p.tempF);
  // Kalshi taker-flow features (xFlow*) — stamped as p._flow by the snapshot handler
  // from the public trade tape (kalshi-flow.js). Underscore-prefixed so the catch-all
  // below never double-logs it; folding here keeps xFlow* inside the uniform x* set.
  if (p._flow) for (const [k, v] of Object.entries(p._flow)) set(k, v);
  return x;
}

// Coverage KV merge: within a day the distinct-game count is monotonic in the same sense
// as the resolution count — a later run seeing FEWER games means staging decayed (games
// started/settled out, next-day pre-listings dominate), not that capture un-happened. So
// per-sport games/scheduled max-merge over the union of sports, and the warning recomputes
// from the merged numbers. Keeps a manual evening snapshot run (deploy verification) from
// clobbering the healthy cron stamp — the 2026-07-06 false "slate under-logged" banner.
export function mergeCoverage(prev, curr) { // exported for unit tests only
  const merged = {};
  for (const src of [prev, curr]) {
    for (const [sp, c] of Object.entries(src || {})) {
      const m = merged[sp] ??= { games: 0, scheduled: 0 };
      m.games = Math.max(m.games, Number(c?.games) || 0);
      m.scheduled = Math.max(m.scheduled, Number(c?.scheduled) || 0);
    }
  }
  const warning = Object.values(merged).some(c => c.scheduled > 0 && c.games / c.scheduled < 0.8);
  return { coverage: merged, coverageWarning: warning };
}

function extractFeatures(p) {
  const features = { ...exogenousSignals(p) };
  for (const [k, v] of Object.entries(p)) {
    if (!DEDICATED.has(k) && !k.startsWith("_") && v !== undefined && v !== null) {
      features[k] = v;
    }
  }
  return Object.keys(features).length > 0 ? JSON.stringify(features) : null;
}

// ── Shadow Resolver ──────────────────────────────────────────────────────────

// Strip diacritics so ESPN's ASCII names ("Jokic") match accented player_name values.
function _normName(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Fuzzy-normalize: on top of _normName, remove periods (C.J.→CJ), apostrophes,
// Jr/Sr/II/III/IV suffixes, and collapse whitespace. Catches the most common
// Kalshi-vs-ESPN name format divergences without a fuzzy library.
function _fuzzyName(s) {
  return _normName(s)
    .replace(/\./g, "")
    .replace(/'/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein edit distance — O(m·n) time, O(n) space. Fine for short name strings.
function _editDist(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function _findPlayer(players, name) {
  if (!players || !name) return undefined;
  // 1. Exact key match
  if (players[name] !== undefined) return players[name];
  // 2. Diacritic-stripped + lowercase (handles accented chars)
  const norm = _normName(name);
  for (const k in players) {
    if (_normName(k) === norm) return players[k];
  }
  // 3. Period/suffix stripped (handles C.J.→CJ, Jr./Sr., etc.)
  const fuzzy = _fuzzyName(name);
  for (const k in players) {
    if (_fuzzyName(k) === fuzzy) return players[k];
  }
  // 4. Edit distance ≤ 2 on fuzzy names — catches spelling variants like Zach/Zack,
  //    Cristian/Christian. Only applied for names long enough that ≤2 edits is meaningful.
  if (fuzzy.length >= 8) {
    let best = null, bestDist = 3;
    for (const k in players) {
      const fk = _fuzzyName(k);
      if (Math.abs(fk.length - fuzzy.length) > 2) continue;
      const d = _editDist(fuzzy, fk);
      if (d < bestDist) { bestDist = d; best = k; }
    }
    if (best) return players[best];
  }
  return undefined;
}

// Determine won/actualValue for one shadow row given a game object from /api/live.
// Returns { won: boolean|null, actualValue: number|null }, or null to skip (game not final).
// won=null means DNP or void (excluded from calibration; resolved=TRUE, won=NULL).
function _resolveRow(row, game) {
  if (!game || game.state !== "post") return null;

  const { game_type, stat, direction, threshold, player_name, home_team, scoring_team, pick_team, features } = row;
  const th = parseFloat(threshold);
  const isUnder = direction === "under";
  const pickLine = parseFloat(row.pick_line ?? 0);

  let segment = null;
  if (features) {
    try {
      const f = typeof features === "string" ? JSON.parse(features) : features;
      segment = f?.segment || null;
    } catch {}
  }

  // Segment plays (F5 / NBA-WNBA halves / WNBA quarters) — must come before full-game branches.
  const _isQtr = /^[1-4]q$/.test(segment || "");
  if (segment === "f3" || segment === "f5" || segment === "f7" || segment === "1h" || segment === "2h" || _isQtr) {
    let segDone, segHome, segAway;
    if (segment === "f3") {
      segDone = game.f3Complete === true;
      segHome = game.f3HomeScore ?? 0;
      segAway = game.f3AwayScore ?? 0;
    } else if (segment === "f5") {
      segDone = game.f5Complete === true;
      segHome = game.f5HomeScore ?? 0;
      segAway = game.f5AwayScore ?? 0;
    } else if (segment === "f7") {
      segDone = game.f7Complete === true;
      segHome = game.f7HomeScore ?? 0;
      segAway = game.f7AwayScore ?? 0;
    } else if (segment === "1h") {
      segDone = game.h1Complete === true;
      segHome = game.h1HomeScore ?? 0;
      segAway = game.h1AwayScore ?? 0;
    } else if (segment === "2h") {
      segDone = game.h2Complete === true;
      segHome = game.h2HomeScore ?? 0;
      segAway = game.h2AwayScore ?? 0;
    } else {
      const n = segment[0]; // "1".."4" — quarter
      segDone = game[`q${n}Complete`] === true;
      segHome = game[`q${n}HomeScore`] ?? 0;
      segAway = game[`q${n}AwayScore`] ?? 0;
    }
    if (!segDone) return { won: null, actualValue: null }; // game ended before segment completed → void
    if (game_type === "total") {
      const total = segHome + segAway;
      return { won: isUnder ? total < th : total >= th, actualValue: total };
    }
    if (game_type === "spread") {
      const pickIsHome = game.homeTeam === pick_team;
      const pickSeg = pickIsHome ? segHome : segAway;
      const oppSeg  = pickIsHome ? segAway  : segHome;
      return { won: (pickSeg - oppSeg) + pickLine > 0, actualValue: pickSeg - oppSeg };
    }
    if (game_type === "ml") {
      const winner = segHome > segAway ? game.homeTeam : segAway > segHome ? game.awayTeam : null;
      return { won: winner != null ? winner === pick_team : null, actualValue: null };
    }
    return null;
  }

  if (game_type === "ml") {
    const winner = (game.homeScore ?? 0) > (game.awayScore ?? 0) ? game.homeTeam
                 : (game.awayScore ?? 0) > (game.homeScore ?? 0) ? game.awayTeam
                 : null;
    return { won: winner != null ? winner === pick_team : null, actualValue: null };
  }

  if (game_type === "spread") {
    const pickIsHome = game.homeTeam === pick_team;
    const pickFinal = pickIsHome ? (game.homeScore ?? 0) : (game.awayScore ?? 0);
    const oppFinal  = pickIsHome ? (game.awayScore ?? 0) : (game.homeScore ?? 0);
    return { won: (pickFinal - oppFinal) + pickLine > 0, actualValue: pickFinal - oppFinal };
  }

  if (game_type === "total") {
    const current = (game.homeScore ?? 0) + (game.awayScore ?? 0);
    return { won: isUnder ? current < th : current >= th, actualValue: current };
  }

  if (game_type === "teamTotal") {
    const isHome = game.homeTeam === scoring_team;
    const current = isHome ? (game.homeScore ?? 0) : (game.awayScore ?? 0);
    return { won: isUnder ? current < th : current >= th, actualValue: current };
  }

  // Player prop — gameType is null/undefined on prop plays.
  if (player_name) {
    const ps = _findPlayer(game.players, player_name);
    if (!ps) return { won: null, actualValue: null }; // DNP
    let actual;
    switch (stat) {
      case "strikeouts":    actual = ps.strikeouts ?? 0; break;
      // Pitcher outs recorded = IP×3 (MLB "5.2" = 5⅔ IP = 17 outs). ps.ip from /api/live pitching
      // line. Absent or 0.0 ⇒ no pitching line yet / scratch → null (retry, never mis-resolve UNDER).
      case "outs": {
        if (ps.ip == null) return null;
        const ipNum = parseFloat(ps.ip);
        if (isNaN(ipNum) || ipNum <= 0) return null;
        const whole = Math.trunc(ipNum);
        const frac = Math.round((ipNum - whole) * 10); // .0/.1/.2 → 0/1/2 outs
        actual = whole * 3 + frac;
        break;
      }
      case "hrr":           actual = ps.hrr ?? ((ps.hits ?? 0) + (ps.runs ?? 0) + (ps.rbi ?? 0)); break;
      case "hits":          actual = ps.hits ?? 0; break;
      // totalBases comes from the statsapi merge (/api/live?tb=1) — ESPN's box score has
      // no TB. Absent value means the merge failed (statsapi outage / name mismatch), NOT
      // 0 TB: return null → skipped → retried next run, never mis-resolved as an UNDER win.
      case "totalBases":    if (ps.totalBases == null) return null; actual = ps.totalBases; break;
      case "points":        actual = ps.points ?? 0; break;
      case "rebounds":      actual = ps.rebounds ?? 0; break;
      case "assists":       actual = ps.assists ?? 0; break;
      case "threePointers": actual = ps.threePointers ?? 0; break;
      default: return null;
    }
    // Under-direction props (totalBases NO side, 2026-06-12) win when actual stays below.
    return { won: isUnder ? actual < th : actual >= th, actualValue: actual };
  }

  return null; // unknown type — skip
}

// Fetch final boxscores from /api/live for one game_date into liveByKey.
// On the early-morning resolver crons (2am/3:05am PT) the function is COLD, so the first
// internal fetch to /api/live (itself a cold function + ESPN round-trip) can blow past the
// timeout and abort. That abort used to be swallowed by an empty `catch {}`, leaving every
// row noData (resolved≈0) until something warmed the stack hours later. So: a generous
// timeout, one retry on abort/non-OK (the failed first call warms /api/live → the retry
// lands), and errors are logged, never swallowed.
async function fetchLiveInto(liveByKey, origin, game_date, gamesParam, tbParam, timeoutMs) {
  const url = `${origin}/api/live?games=${encodeURIComponent(gamesParam)}&date=${game_date}${tbParam}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "shadow-resolver/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.error(`[shadow-resolver] live fetch ${res.status} (attempt ${attempt + 1}, date ${game_date})`);
        continue; // retry once on non-OK
      }
      // Non-JSON = we were served an interstitial (Vercel SSO / challenge page), not /api/live.
      // Name the host so the misroute is obvious in logs instead of a JSON parse error.
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("json")) {
        console.error(`[shadow-resolver] live fetch non-JSON (${ctype || "no content-type"}) from ${new URL(url).host} (attempt ${attempt + 1}, date ${game_date})`);
        continue;
      }
      const data = await res.json();
      for (const [k, v] of Object.entries(data)) liveByKey.set(`${k}|${game_date}`, v);
      return;
    } catch (e) {
      console.error(`[shadow-resolver] live fetch failed (attempt ${attempt + 1}, date ${game_date}): ${e?.message}`);
    }
  }
}

async function handleShadowResolver({ path, request, env, cache }) {
  if (path !== "shadow-resolver") return null;

  if (!env?.CRON_SECRET) return errorResponse("CRON_SECRET not set", 500);
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  if (auth !== env.CRON_SECRET) return errorResponse("Forbidden", 403);

  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const t0 = Date.now();

  // Only resolve rows from prior days (today's games may not be finished).
  // COALESCE(game_date, snapshot_date::varchar) handles early-dropped prop rows
  // that lack game_date — snapshot_date (3pm PT) is the same calendar day as the game.
  // write:true — must read the pooled primary. The unpooled conn may be a read-only
  // replica that returns 0 rows on cold wake (2026-06-11: both morning crons missed
  // all 1051 of the prior day's rows).
  // Abandon rows that have sat unresolved for 14+ days (postponed games, unparseable
  // teams — permanent noData). resolved=TRUE with won=NULL exits them from this scan
  // without polluting calibration (which filters won IS NOT NULL). Without this they
  // accumulate (~17/day) and, since the SELECT below is LIMIT-bounded, could eventually
  // starve fresh rows.
  const abandoned = await neonQuery(
    `UPDATE shadow_plays SET resolved = TRUE, resolved_at = NOW()
     WHERE resolved = FALSE
       AND COALESCE(game_date, snapshot_date::varchar) < $1
     RETURNING id`,
    [new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)],
    env,
    { write: true }
  ).catch((e) => {
    console.error(`[shadow-resolver] abandon UPDATE failed: ${e?.message}`);
    return [];
  });
  if (abandoned.length) console.log(`[shadow-resolver] abandoned=${abandoned.length} (unresolved >14d)`);

  // ORDER BY newest first: if backlog ever exceeds the LIMIT, fresh rows (still
  // resolvable) win over old strays rather than Postgres picking arbitrarily.
  const rows = await neonQuery(
    `SELECT id, sport, stat, game_type, player_name, home_team, away_team,
            scoring_team, pick_team, pick_line, threshold, direction,
            game_date, game_time, features, snapshot_date
     FROM shadow_plays
     WHERE resolved = FALSE
       AND COALESCE(game_date, snapshot_date::varchar) < $1
       AND home_team IS NOT NULL
       AND away_team IS NOT NULL
     ORDER BY snapshot_date DESC
     LIMIT 2000`,
    [today],
    env,
    { write: true }
  );

  console.log(`[shadow-resolver] rows=${rows.length} selectMs=${Date.now() - t0}`);

  if (!rows.length) {
    return jsonResponse({ ok: true, resolved: 0, skipped: 0, noData: 0, durationMs: Date.now() - t0 });
  }

  // Tennis match-winner + soccer rows resolve via their own ESPN scoreboards (not the team-based
  // /api/live path, which doesn't know tennis players or soccer's 5 market families + draws), so
  // split them out of teamRows below.
  const tennisRows = rows.filter(r => r.sport === "tennis");
  const _isSoccerHalf = (r) => /^(1h|2h)(game|total|spread|btts)$/.test(r.stat || "");
  const soccerRows = rows.filter(r => r.sport === "soccer" && r.stat !== "advance" && !_isSoccerHalf(r));
  const soccerHalfRows = rows.filter(r => r.sport === "soccer" && _isSoccerHalf(r));
  const soccerAdvanceRows = rows.filter(r => r.sport === "soccer" && r.stat === "advance");
  const fightRows = rows.filter(r => r.sport === "fight");
  const golfRows = rows.filter(r => r.sport === "golf");
  const nascarRows = rows.filter(r => r.sport === "nascar");
  const nbaslRows = rows.filter(r => r.sport === "nbasl");
  const teamRows = rows.filter(r => r.sport !== "tennis" && r.sport !== "soccer" && r.sport !== "fight" && r.sport !== "golf" && r.sport !== "nascar" && r.sport !== "nbasl");

  // Build unique game keys per date. Key: sport:away:home[@gameTime] — matches /api/live format.
  const keysByDate = new Map(); // game_date → Set<rawKey>
  const rowToKey = new Map();   // row.id → rawKey

  for (const row of teamRows) {
    const { sport, home_team, away_team, game_time } = row;
    // Prefer game_date when set. When null (Kalshi ticker date unparseable), extract the
    // PT calendar date from game_time (ISO string like 2026-06-03T23:00:00Z) — that gives
    // the correct date even when the snapshot was taken the day before the game. Only fall
    // back to snapshot_date when neither is available (early-dropped rows without game_time).
    // snapshot_date is a DATE column; Neon may return JS Date or ISO string — both safe via toISOString().
    const effectiveDate = row.game_date
      || (row.game_time ? new Date(row.game_time).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) : null)
      || (row.snapshot_date ? new Date(row.snapshot_date).toISOString().slice(0, 10) : null);
    let rawKey = `${sport}:${away_team}:${home_team}`;
    if (game_time) rawKey += `@${game_time}`;
    rowToKey.set(row.id, { rawKey, effectiveDate });
    if (!keysByDate.has(effectiveDate)) keysByDate.set(effectiveDate, new Set());
    keysByDate.get(effectiveDate).add(rawKey);
  }

  // Fetch final boxscores from /api/live (one call per distinct game_date).
  const liveByKey = new Map(); // `rawKey|game_date` → game object

  // totalBases rows need the statsapi TB merge in /api/live (?tb=1 — ESPN box has no TB).
  // Request it only when the batch actually contains such rows so regular runs keep the
  // cheap ESPN-only path and its unsuffixed cache slots.
  const tbParam = teamRows.some(r => r.stat === "totalBases") ? "&tb=1" : "";

  const origin = selfOrigin(request);
  await Promise.all([...keysByDate.entries()].map(([game_date, keys]) =>
    fetchLiveInto(liveByKey, origin, game_date, [...keys].join(","), tbParam, 30_000)
  ));

  // Second pass: rows whose primary lookup returned state:"unknown" (event not found, likely
  // because a wrong game_time was stored when gameDate was null on the Kalshi ticker) get a
  // retry with the time-stripped base key. This lets /api/live match any event for those
  // teams on that date without a time-prefix filter.
  const retryByDate = new Map(); // effectiveDate → Set<baseKey (no @gameTime)>
  for (const { rawKey, effectiveDate } of rowToKey.values()) {
    const atIdx = rawKey.indexOf("@");
    if (atIdx === -1) continue; // no game_time — already time-agnostic
    const primary = liveByKey.get(`${rawKey}|${effectiveDate}`);
    if (primary?.state !== "unknown") continue; // primary found OK
    const baseKey = rawKey.slice(0, atIdx);
    if (liveByKey.has(`${baseKey}|${effectiveDate}`)) continue; // already have base lookup
    if (!retryByDate.has(effectiveDate)) retryByDate.set(effectiveDate, new Set());
    retryByDate.get(effectiveDate).add(baseKey);
  }
  if (retryByDate.size > 0) {
    await Promise.all([...retryByDate.entries()].map(([game_date, keys]) =>
      fetchLiveInto(liveByKey, origin, game_date, [...keys].join(","), tbParam, 15_000)
    ));
  }

  // Third pass: rows where game_date AND game_time were both null get effectiveDate=snapshot_date,
  // which may be a day early when the game is actually the next day (Kalshi markets open before
  // the ESPN schedule publishes for the following day). Retry with snapshot_date+1 and +2 for
  // these rows when the primary lookup is still unknown.
  const nullDateRows = teamRows.filter(r => !r.game_date && !r.game_time);
  if (nullDateRows.length > 0) {
    const offsetByDate = new Map(); // offsetDate → Set<baseKey>
    for (const row of nullDateRows) {
      const { rawKey, effectiveDate } = rowToKey.get(row.id);
      const primary = liveByKey.get(`${rawKey}|${effectiveDate}`);
      if (primary && primary.state !== "unknown") continue; // already resolved
      const baseKey = rawKey.includes("@") ? rawKey.slice(0, rawKey.indexOf("@")) : rawKey;
      const base = new Date(effectiveDate);
      for (const deltaDays of [1, 2, 3, 4, 5]) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() + deltaDays);
        const offsetDate = d.toISOString().slice(0, 10);
        if (offsetDate >= today) continue; // don't look up future dates
        if (liveByKey.has(`${baseKey}|${offsetDate}`)) continue;
        if (!offsetByDate.has(offsetDate)) offsetByDate.set(offsetDate, new Set());
        offsetByDate.get(offsetDate).add(baseKey);
      }
    }
    if (offsetByDate.size > 0) {
      await Promise.all([...offsetByDate.entries()].map(([game_date, keys]) =>
        fetchLiveInto(liveByKey, origin, game_date, [...keys].join(","), tbParam, 12_000)
      ));
    }
  }

  // Resolve each row.
  const updates = [];
  let skipped = 0;
  let noData = 0;

  for (const row of teamRows) {
    const { rawKey, effectiveDate } = rowToKey.get(row.id);
    let game = liveByKey.get(`${rawKey}|${effectiveDate}`);
    // If primary lookup was unknown (wrong stored game_time), try base key fallback.
    if (game?.state === "unknown") {
      const atIdx = rawKey.indexOf("@");
      if (atIdx !== -1) {
        const baseKey = rawKey.slice(0, atIdx);
        game = liveByKey.get(`${baseKey}|${effectiveDate}`) ?? game;
      }
    }
    // Third-pass fallback: for null-date rows (no game_date or game_time), the effective date
    // may be several days early. Try offsets +1 through +5 using the base key.
    if ((!game || game.state === "unknown") && !row.game_date && !row.game_time) {
      const baseKey = rawKey.includes("@") ? rawKey.slice(0, rawKey.indexOf("@")) : rawKey;
      const base = new Date(effectiveDate);
      for (const deltaDays of [1, 2, 3, 4, 5]) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() + deltaDays);
        const offsetDate = d.toISOString().slice(0, 10);
        const candidate = liveByKey.get(`${baseKey}|${offsetDate}`);
        if (candidate && candidate.state !== "unknown") { game = candidate; break; }
      }
    }
    if (!game || game.state === "unknown") { noData++; continue; } // game not found in ESPN — leave unresolved
    const result = _resolveRow(row, game);
    if (result === null) { skipped++; continue; }
    updates.push({ id: row.id, won: result.won, actualValue: result.actualValue });
  }

  // ── Tennis resolution ── grade match-winner rows off the ESPN tennis scoreboard. We fetch
  // completed matches once per (date, tour) and match the pick player by fuzzy name. won =
  // (the pick player is the match winner). actualValue is null (binary outcome).
  if (tennisRows.length) {
    const tourOf = (r) => {
      try { const f = typeof r.features === "string" ? JSON.parse(r.features) : r.features; return f?.tour || "atp"; }
      catch { return "atp"; }
    };
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byKey = new Map(); // `${date}|${tour}` → rows
    for (const r of tennisRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      const key = `${date}|${tourOf(r)}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    const matchesByKey = new Map();
    await Promise.all([...byKey.keys()].map(async (key) => {
      const [date, tour] = key.split("|");
      matchesByKey.set(key, await fetchCompletedMatches(tour, date.replace(/-/g, "")));
    }));
    for (const [key, rws] of byKey) {
      const matches = matchesByKey.get(key) || [];
      for (const r of rws) {
        const pick = _fuzzyName(r.player_name || r.pick_team || "");
        const sameName = (a, b) => a === b || (a.length >= 8 && _editDist(a, b) <= 2);
        const found = matches.find(mt => mt.players.some(p => sameName(_fuzzyName(p), pick)));
        if (!found || !found.winner) { noData++; continue; } // match not final / pick not found yet
        updates.push({ id: r.id, won: sameName(_fuzzyName(found.winner), pick), actualValue: null });
      }
    }
  }

  // ── Soccer (World Cup) resolution ── grade all 5 families off the ESPN fifa.world scoreboard
  // at the 90'+stoppage final (matches Kalshi settlement — excludes ET/penalties). We read the
  // goal map per game (canonical FIFA code → goals) and resolve alignment-independently: totals,
  // team totals, spreads, BTTS, and the 3-way 1X2 (a draw is a real settled outcome).
  if (soccerRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map(); // date → rows
    for (const r of soccerRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const finalsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      finalsByDate.set(date, await fetchWcFinals(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const finals = finalsByDate.get(date) || [];
      for (const r of rws) {
        // Find the game by the unordered {home,away} pair, then read goals per canonical code.
        const game = finals.find(g => g.codes[r.home_team] != null && g.codes[r.away_team] != null);
        if (!game || !game.final) { noData++; continue; } // not played / not final yet
        const gh = game.codes[r.home_team], ga = game.codes[r.away_team];
        const th = parseFloat(r.threshold);
        const isUnder = r.direction === "under";
        let won = null, actual = null;
        if (r.stat === "game") {
          // 1X2 — pick_team is a FIFA code or "TIE". Settles on the 90' result.
          if (r.pick_team === "TIE") won = gh === ga;
          else won = game.codes[r.pick_team] != null && game.codes[r.pick_team] > (r.pick_team === r.home_team ? ga : gh);
        } else if (r.stat === "total") {
          actual = gh + ga;
          won = isUnder ? actual < th : actual >= th;
        } else if (r.stat === "teamTotal") {
          actual = game.codes[r.scoring_team];
          if (actual == null) { noData++; continue; }
          won = isUnder ? actual < th : actual >= th;
        } else if (r.stat === "spread") {
          // "favored team wins by more than `threshold` goals" — over = covers, under = doesn't.
          const fav = r.pick_team;
          if (game.codes[fav] == null) { noData++; continue; }
          const margin = game.codes[fav] - (fav === r.home_team ? ga : gh);
          actual = margin;
          const covered = margin > th;
          won = isUnder ? !covered : covered;
        } else if (r.stat === "btts") {
          const btts = gh >= 1 && ga >= 1;
          won = isUnder ? !btts : btts;
        } else { noData++; continue; }
        updates.push({ id: r.id, won, actualValue: actual });
      }
    }
  }

  // ── Soccer half resolution (1H / 2H × game/total/spread/btts) ── grade off per-team per-half
  // goals from the event summary (fetchWcHalfFinals). stat = "<half><family>" (e.g. "1htotal");
  // family logic mirrors the full-game soccer block, applied to the chosen half's goal map.
  if (soccerHalfRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map();
    for (const r of soccerHalfRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const finalsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      finalsByDate.set(date, await fetchWcHalfFinals(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const finals = finalsByDate.get(date) || [];
      for (const r of rws) {
        const half = (r.stat || "").slice(0, 2);  // "1h" | "2h"
        const fam = (r.stat || "").slice(2);       // game | total | spread | btts
        const game = finals.find(g => g.h1[r.home_team] != null && g.h1[r.away_team] != null);
        if (!game || !game.final) { noData++; continue; }
        const goals = half === "1h" ? game.h1 : game.h2;
        const gh = goals[r.home_team], ga = goals[r.away_team];
        if (gh == null || ga == null) { noData++; continue; }
        const th = parseFloat(r.threshold);
        const isUnder = r.direction === "under";
        let won = null, actual = null;
        if (fam === "game") {
          if (r.pick_team === "TIE") won = gh === ga;
          else won = goals[r.pick_team] != null && goals[r.pick_team] > (r.pick_team === r.home_team ? ga : gh);
        } else if (fam === "total") {
          actual = gh + ga;
          won = isUnder ? actual < th : actual >= th;
        } else if (fam === "spread") {
          const fav = r.pick_team;
          if (goals[fav] == null) { noData++; continue; }
          const margin = goals[fav] - (fav === r.home_team ? ga : gh);
          actual = margin;
          const covered = margin > th;
          won = isUnder ? !covered : covered;
        } else if (fam === "btts") {
          const btts = gh >= 1 && ga >= 1;
          won = isUnder ? !btts : btts;
        } else { noData++; continue; }
        updates.push({ id: r.id, won, actualValue: actual });
      }
    }
  }

  // ── Soccer knockout "to advance" resolution ── grade the per-tie binary off who advanced
  // (the ET/penalties outcome via fetchWcAdvance, NOT the 90' score). Find the tie by the unordered
  // {home,away} pair; the row wins iff the advancing side equals pick_team. A tie that's completed
  // but not yet flagged (advancer null) records noData rather than a wrong grade.
  if (soccerAdvanceRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map(); // date → rows
    for (const r of soccerAdvanceRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const advByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      advByDate.set(date, await fetchWcAdvance(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const ties = advByDate.get(date) || [];
      for (const r of rws) {
        const game = ties.find(g => g.codes[r.home_team] != null && g.codes[r.away_team] != null);
        if (!game || !game.final || !game.advancer) { noData++; continue; } // not played / not settled yet
        updates.push({ id: r.id, won: game.advancer === r.pick_team, actualValue: null });
      }
    }
  }

  // ── Fighting (UFC rounds O/U) resolution ── grade "ends before round N" rows off the ESPN MMA
  // scoreboard. We fetch each date's card once and match the bout by the stored fighter last
  // names (home_team/away_team), falling back to the event code segment in features. A finish in
  // round k sets status.period=k; a decision leaves period=scheduled. "ends before round N" wins
  // iff the bout finished before round N (period < N) — which also handles decisions, since no
  // threshold exceeds scheduled rounds. direction "under" (reaches round N) is the complement.
  if (fightRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map(); // date → rows
    for (const r of fightRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const cardByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      cardByDate.set(date, await fetchFightResults(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const fights = cardByDate.get(date) || [];
      for (const r of rws) {
        const a = normFighterName(r.home_team), b = normFighterName(r.away_team);
        let fight = fights.find(f => {
          const set = (f.lastNames || []).map(normFighterName);
          return set.includes(a) && set.includes(b);
        });
        if (!fight) {
          let codeSeg = null;
          try { const ff = typeof r.features === "string" ? JSON.parse(r.features) : r.features; codeSeg = ff?.eventCodes || null; } catch {}
          if (codeSeg) fight = matchFightByCodes(codeSeg, fights);
        }
        if (!fight || !fight.final || fight.finishRound == null) { noData++; continue; } // not fought / not final yet
        const n = parseFloat(r.threshold);
        const endsBefore = fight.finishRound < n;
        const won = r.direction === "under" ? !endsBefore : endsBefore;
        updates.push({ id: r.id, won, actualValue: fight.finishRound });
      }
    }
  }

  // ── Golf (PGA single-round head-to-head) resolution ── grade off the ESPN PGA leaderboard for
  // the round's date. We read each player's per-round scores and compare the bet round: the pick
  // wins iff their round-N strokes are strictly lower than the opponent's (a tie resolves NO,
  // matching Kalshi's "beats" settlement). Round comes from features; both names from home/away.
  if (golfRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const roundOf = (r) => {
      try { const f = typeof r.features === "string" ? JSON.parse(r.features) : r.features; return parseInt(f?.round) || null; }
      catch { return null; }
    };
    const byDate = new Map(); // date → rows
    for (const r of golfRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const scoresByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      scoresByDate.set(date, await fetchRoundScores(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const scores = scoresByDate.get(date) || {};
      // Match a player to a scores key: exact normGolfName, then fuzzy/edit-distance fallback.
      const findScores = (name) => {
        const key = normGolfName(name || "");
        if (scores[key]) return scores[key];
        const fz = _fuzzyName(name || "");
        for (const k in scores) { if (_fuzzyName(k) === fz) return scores[k]; }
        if (fz.length >= 8) {
          let best = null, bd = 3;
          for (const k in scores) { const fk = _fuzzyName(k); if (Math.abs(fk.length - fz.length) > 2) continue; const d = _editDist(fz, fk); if (d < bd) { bd = d; best = k; } }
          if (best) return scores[best];
        }
        return null;
      };
      for (const r of rws) {
        const n = roundOf(r);
        if (!n) { noData++; continue; }
        const ps = findScores(r.player_name || r.home_team);
        const os = findScores(r.away_team);
        const pa = ps && ps[n - 1], ob = os && os[n - 1];
        if (pa == null || ob == null) { noData++; continue; } // round not complete / player not found
        updates.push({ id: r.id, won: pa < ob, actualValue: pa }); // strictly lower wins; tie → NO
      }
    }
  }

  // ── NASCAR (Cup H2H + Top-10) resolution ── grade off the ESPN core-API race results for the
  // race's date. Each play stores the pick (and, for H2H, opponent) ESPN athlete id in features,
  // so we match by id off the competitor list — no name matching. H2H: pick wins iff its finishing
  // order is strictly lower than the opponent's. Top-10: pick wins iff order ≤ 10.
  if (nascarRows.length) {
    const dateOf = (r) => r.game_date
      || (r.game_time ? new Date(r.game_time).toISOString().slice(0, 10) : null)
      || (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const featOf = (r) => { try { return typeof r.features === "string" ? JSON.parse(r.features) : (r.features || {}); } catch { return {}; } };
    const byDate = new Map();
    for (const r of nascarRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const resultsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      resultsByDate.set(date, await fetchRaceResults(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const results = resultsByDate.get(date) || {};
      if (!Object.keys(results).length) { noData += rws.length; continue; } // race not run / not found yet
      for (const r of rws) {
        const f = featOf(r);
        const pickOrder = f.pickId != null ? results[String(f.pickId)] : null;
        if (pickOrder == null) { noData++; continue; }
        if (r.stat === "top10") {
          updates.push({ id: r.id, won: pickOrder <= (r.threshold || 10), actualValue: pickOrder });
        } else { // h2h
          const oppOrder = f.oppId != null ? results[String(f.oppId)] : null;
          if (oppOrder == null) { noData++; continue; }
          updates.push({ id: r.id, won: pickOrder < oppOrder, actualValue: pickOrder }); // strictly lower wins
        }
      }
    }
  }

  // ── NBA Summer League resolution ── grade game-winner rows off the ESPN SL scoreboard.
  // Games are matched on the sorted canonical team pair (Kalshi ticker order ≠ ESPN home/away).
  if (nbaslRows.length) {
    const dateOf = (r) => r.game_date
      ? new Date(r.game_date).toISOString().slice(0, 10)
      : (r.snapshot_date ? new Date(r.snapshot_date).toISOString().slice(0, 10) : null);
    const byDate = new Map();
    for (const r of nbaslRows) {
      const date = dateOf(r);
      if (!date) { noData++; continue; }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(r);
    }
    const resultsByDate = new Map();
    await Promise.all([...byDate.keys()].map(async (date) => {
      resultsByDate.set(date, await fetchSlResults(date.replace(/-/g, "")));
    }));
    for (const [date, rws] of byDate) {
      const results = resultsByDate.get(date) || {};
      for (const r of rws) {
        const g = results[[r.home_team, r.away_team].sort().join("|")];
        if (!g) { noData++; continue; } // game not played / not final yet
        const pickScore = g.home === r.pick_team ? g.homeScore : (g.away === r.pick_team ? g.awayScore : null);
        const oppScore = g.home === r.pick_team ? g.awayScore : g.homeScore;
        if (pickScore == null) { noData++; continue; }
        updates.push({ id: r.id, won: g.winner === r.pick_team, actualValue: pickScore - oppScore });
      }
    }
  }

  if (updates.length) await neonBatchResolve(updates, env);

  // Replica-proof resolution floor for the morning report. This pass's own writes are read-after-
  // write consistent on the pooled primary, and max-merge across the overnight passes (2am/3am/
  // 5:50am) locks in yesterday's true resolved count in KV — which the 6am report reads instead of
  // trusting a cold-instance SQL read that lags the replica (the recurring "not yet generated" miss).
  //
  // 2026-06-30 hardening: the SQL re-COUNT below is ITSELF subject to read-your-own-write replica
  // lag on a cold instance (the >1min instance-pinned lag from the 6/26 miss) — so the decisive late
  // pass that resolves the bulk of yesterday's games can stamp a stale-LOW floor (90 while 990 truly
  // resolved), and since earlier passes legitimately resolved fewer, the max-merge never captures the
  // truth before the 6am report. Defense: derive a lag-IMMUNE lower bound from this pass's own ground
  // truth — prevKvFloor.resolved (Upstash, read-after-write consistent) + the rows we KNOW we just
  // resolved for yesterday (in-memory) — and floor `resolved` at it. Only `resolved` needs this (the
  // just-written, lag-prone field that drives the report's incomplete/TTL gate); `total` is settled
  // (rows inserted hours ago) and clv is written by a different path.
  try {
    const yesterday = new Date(new Date(today).getTime() - 86400_000).toISOString().slice(0, 10);
    const _y10 = (g) => { try { return new Date(g).toISOString().slice(0, 10); } catch { return null; } };
    const yesterdayIds = new Set(
      rows.filter(r => r.game_date && _y10(r.game_date) === yesterday).map(r => r.id)
    );
    const newResolvedYesterday = updates.reduce((n, u) => n + (yesterdayIds.has(u.id) ? 1 : 0), 0);
    const prevFloor = cache
      ? await cache.get(`${_RESOLUTION_KV_PREFIX}${yesterday}`, "json").catch(() => null)
      : null;
    const yRow = _parseResolutionRow(
      (await neonQuery(_RESOLUTION_SQL, [yesterday], env, { write: true }).catch(() => null))?.[0]
    );
    if (yRow) {
      // Lag-immune lower bound; max so the SQL read still self-corrects total/abandons upward.
      const sqlResolved = yRow.resolved;
      const bound = (Number(prevFloor?.resolved) || 0) + newResolvedYesterday;
      yRow.resolved = Math.max(sqlResolved, bound);
      const stamped = await _stampResolutionFloor(yesterday, yRow, cache);
      console.log(`[shadow-resolver] floor ${yesterday} stamped resolved=${stamped?.resolved}/${stamped?.total} (sql=${sqlResolved} bound=${bound} newY=${newResolvedYesterday})`);
    }
  } catch (e) {
    console.error(`[shadow-resolver] resolution floor stamp failed: ${e?.message}`);
  }

  console.log(`[shadow-resolver] resolved=${updates.length} skipped=${skipped} noData=${noData} games=${liveByKey.size} durationMs=${Date.now() - t0}`);
  return jsonResponse({ ok: true, resolved: updates.length, skipped, noData, durationMs: Date.now() - t0 });
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

// ── Shadow Pre-game Price Snap ────────────────────────────────────────────────
// Crons: 0 17, 10 22, 0 3 * * * — each trails a /api/tonight cron by 5–10 min.
// Reads today's plays (with current Kalshi prices) from the shadow:staging KV key
// written by tonight, and stamps them onto today's shadow_plays rows, enabling
// CLV / line-movement analysis in shadow-analysis. Staging older than 15 min is
// rejected (CLV prices must reflect now); falls back to an HTTP fetch of
// /api/tonight, which risks the 60s wall on cold rebuilds (the 2026-06-10 failure
// mode that motivated the KV-first read). `?dry=1` skips the DB write — safe
// verification without stamping mid-game prices as "pregame".

const PREGAME_STAGING_MAX_AGE_MS = 15 * 60_000;

// Per-run breadcrumb so an intermittent CLV-capture dip is root-cause-visible without log
// archaeology (the 2026-06-28 Mode-A failure: the 10am run got a degraded staging priceMap and
// captured 63 vs the ~1000 a healthy run gets — but we couldn't see WHY a day later). Appends
// {ranAt, source, stagingAgeMs, priceMapSize, unstampedRows, captured} to shadow:pregame:{date};
// a run with priceMapSize≪unstampedRows = degraded staging, a low captured with full priceMap =
// late-listing/already-settled markets. Read back via GET ?runs=1[&date=]. Best-effort.
const _PREGAME_BREADCRUMB_TTL = 30 * 3600;
async function _recordPregameRun(cache, date, rec) {
  if (!cache) return;
  const key = `shadow:pregame:${date}`;
  try {
    const prev = await cache.get(key, "json").catch(() => null);
    const list = Array.isArray(prev) ? prev : [];
    list.push(rec);
    await cache.put(key, JSON.stringify(list.slice(-12)), { expirationTtl: _PREGAME_BREADCRUMB_TTL });
  } catch { /* breadcrumb is best-effort — never block a capture on it */ }
}

async function handleShadowPregameSnap({ path, request, env, cache }) {
  if (path !== "shadow-pregame-snap") return null;

  const cronAuth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isAdmin = env?.ADMIN_KEY && cronAuth === env.ADMIN_KEY;
  const isCron  = env?.CRON_SECRET && cronAuth === env.CRON_SECRET;
  if (!isAdmin && !isCron) return errorResponse("Forbidden", 403);

  const _params = new URL(request.url).searchParams;
  const snapshotDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  // Read-only breadcrumb inspector — which runs fired today + how each did.
  if (_params.get("runs") === "1") {
    const rd = _params.get("date") || snapshotDate;
    const runs = cache ? await cache.get(`shadow:pregame:${rd}`, "json").catch(() => null) : null;
    return jsonResponse({ date: rd, runs: Array.isArray(runs) ? runs : [] });
  }

  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const t0 = Date.now();
  const isDry = _params.get("dry") === "1";

  const _preSchemaKey = "shadow:pregame-schema:v1";
  const _preSchemaOk = cache ? await cache.get(_preSchemaKey).catch(() => null) : null;
  if (!_preSchemaOk) {
    await neonExec(ADD_PRE_PRICE_COLS_SQL, env);
    if (cache) cache.put(_preSchemaKey, "1", { expirationTtl: 86400 * 30 }).catch(() => {});
  }

  // KV staging first — written on every tonight recompute from ≤2-min-old Kalshi snaps, so
  // fresh staging carries current prices. Staleness gate matters here (unlike shadow-snapshot):
  // CLV prices stamped now must reflect now, not whenever tonight last ran.
  let rawPlays = null;
  let source = "kv-staging";
  let stagingAgeMs = null;
  if (cache) {
    const _staged = await cache.get(`shadow:staging:${snapshotDate}`, "json").catch(() => null);
    if (_staged?.plays && _staged.writtenAt) {
      stagingAgeMs = Date.now() - _staged.writtenAt;
      if (stagingAgeMs <= PREGAME_STAGING_MAX_AGE_MS) {
        rawPlays = [..._staged.plays, ...(_staged.dropped || [])];
        console.log(`[shadow-pregame-snap] KV staging hit plays=${_staged.plays.length} dropped=${_staged.dropped?.length ?? 0} ageMs=${stagingAgeMs}`);
      } else {
        console.log(`[shadow-pregame-snap] KV staging stale ageMs=${stagingAgeMs} — falling back to HTTP fetch`);
      }
    }
  }

  if (!rawPlays) {
    source = "http";
    const origin = selfOrigin(request);
    let tonightResp;
    try {
      tonightResp = await fetch(`${origin}/api/tonight`, {
        headers: { "x-shadow-internal": "1" },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (fetchErr) {
      console.error(`[shadow-pregame-snap] tonight fetch failed: ${fetchErr?.message} ${Date.now() - t0}ms`);
      return errorResponse(`tonight fetch timed out — re-run manually: ${fetchErr?.message}`, 504);
    }
    if (!tonightResp.ok) return errorResponse(`tonight fetch failed: ${tonightResp.status}`, 502);
    const tonight = await tonightResp.json();
    rawPlays = [...(tonight.plays || []), ...(tonight.dropped || [])];
  }

  // Build priceMap: shadowId(play) → { yes, no } using same deterministic ID as snapshot.
  const priceMap = new Map();
  for (const p of rawPlays) {
    if (p.kalshiPct == null && p.noKalshiPct == null) continue;
    priceMap.set(shadowId(p, snapshotDate), {
      yes: p.kalshiPct  != null ? p.kalshiPct  / 100 : null,
      no:  p.noKalshiPct != null ? p.noKalshiPct / 100 : null,
    });
  }

  if (priceMap.size === 0) {
    if (!isDry) await _recordPregameRun(cache, snapshotDate, {
      ranAt: new Date().toISOString(), source, stagingAgeMs, priceMapSize: 0, unstampedRows: null, captured: 0,
    });
    return jsonResponse({ ok: true, dry: isDry, source, stagingAgeMs, priceMapSize: 0, updated: 0, skipped: 0, durationMs: Date.now() - t0 });
  }

  // Fetch today's rows that haven't been stamped yet.
  // write:true — read-after-write of rows the snapshot cron inserted earlier today; the
  // unpooled replica can return 0 rows on cold wake (03:00 UTC run is ~4.4h after the last
  // Neon touch). Errors are logged, not swallowed — a silent [] here means CLV quietly
  // vanishes for the day.
  const rows = await neonQuery(
    `SELECT id FROM shadow_plays WHERE snapshot_date = $1 AND price_pre_at IS NULL`,
    [snapshotDate], env, { write: true }
  ).catch((e) => {
    console.error(`[shadow-pregame-snap] rows SELECT failed: ${e?.message}`);
    return [];
  });
  console.log(`[shadow-pregame-snap] unstamped rows=${rows.length} priceMap=${priceMap.size}`);

  let skipped = 0;
  const updates = [];
  for (const row of rows) {
    const prices = priceMap.get(row.id);
    if (!prices) { skipped++; continue; }
    updates.push({ id: row.id, yes: prices.yes, no: prices.no });
  }

  if (isDry) {
    return jsonResponse({
      ok: true,
      dry: true,
      snapshotDate,
      source,
      stagingAgeMs,
      priceMapSize: priceMap.size,
      unstampedRows: rows.length,
      wouldUpdate: updates.length,
      skipped,
      durationMs: Date.now() - t0,
    });
  }

  await neonBatchPrePriceUpdate(updates, env);

  await _recordPregameRun(cache, snapshotDate, {
    ranAt: new Date().toISOString(), source, stagingAgeMs,
    priceMapSize: priceMap.size, unstampedRows: rows.length, captured: updates.length,
  });

  return jsonResponse({
    ok: true,
    snapshotDate,
    source,
    stagingAgeMs,
    priceMapSize: priceMap.size,
    unstampedRows: rows.length,
    updated: updates.length,
    skipped,
    durationMs: Date.now() - t0,
  });
}

// ── Shadow Morning Report ─────────────────────────────────────────────────────
// GET /api/shadow-report
// Cron: 0 13 * * * (6:00am PT, moved from 9:30am on 2026-06-21). The final shadow-resolver
// pass was pulled to 5:50am PT (50 12 UTC) the same day so resolution completes ~10 min
// before this report → it's born complete. INCOMPLETE_REPORT_TTL (15min) still guards an
// early ?bust=1/Refresh that lands before resolution is ≥90%.
// Auth: CRON_SECRET (generate + cache) or ADMIN_KEY / JWT (read).
// Queries 5 parallel Neon aggregations and caches in KV (25h).
// ?bust=1 forces regeneration even when a cached report exists.

const REPORT_CACHE_KEY_PREFIX = "shadow:report:";
const REPORT_TTL = 60 * 60 * 25; // 25 hours
// Short TTL when yesterday's resolution is meaningfully incomplete (<90% resolved).
// Without this, a pre-7am-resolver refresh freezes a partial "3/487 resolved" snapshot
// into the full-day cache; the 0.9 threshold ignores a few permanently-stuck noData rows.
const INCOMPLETE_REPORT_TTL = 60 * 15; // 15 minutes

// Mirror passesCategoryGate() from api/lib/category-gate.js — kept in sync manually.
// Whether a category key (`sport|stat-or-gameType`) is currently in the live truePct gate.
// Derived from passesCategoryGate (the single source of truth in category-gate.js) by probing the
// truePct axis — NOT a hardcoded list, which drifted out of sync when gates were paused/demoted
// 2026-06-19 (the report kept showing demoted cats as live). Returns true if ANY truePct is gated.
function _isGatedCategory(key) {
  const [sport, cat] = key.split("|");
  // Probe with and without direction:'under' — direction-conditional gates (mlb|hrr NO-side,
  // 2026-07-11) never match a direction-less probe, which read the live gate as empty.
  for (let tp = 1; tp < 100; tp++) {
    if (passesCategoryGate({ sport, stat: cat, truePct: tp })) return true;
    if (passesCategoryGate({ sport, stat: cat, truePct: tp, direction: "under" })) return true;
  }
  return false;
}
// SQL fragment that mirrors passesCategoryGate() for use in the top-picks query — kept in
// sync manually; update BOTH when the gate changes (this list drifted 6/19→7/13, surfacing
// demoted categories and missing hrr). passesCategoryGate() keys on p.truePct (always the
// YES/over-side probability), NOT the bet side; the stored model_true_pct IS the bet side,
// so direction='under' rows reconstruct truePct as 100 - model_true_pct (hrr NO-side flips
// a YES-framed prob; spread cover probs are complementary — same arithmetic either way).
const _CATEGORY_GATE_SQL = `(
  (sport='mlb' AND stat='hrr' AND direction='under' AND
     (100 - model_true_pct) >= 63 AND (100 - model_true_pct) < 73)
)`;
const _BAND_MID = { "55-60":57.5,"60-65":62.5,"65-70":67.5,"70-75":72.5,"75-80":77.5,"80-85":82.5,"85-90":87.5,"90-95":92.5,"95+":97.5 };
const _BAND_ORDER = Object.keys(_BAND_MID); // low → high, for adjacency/coherence

// Per-category current-formula cutoffs — calibration before these dates was produced by a
// SUPERSEDED formula and must not be mixed in (the #1 analysis trap, docs/MODEL_IMPROVEMENT.md).
// Keyed by `${sport}|${COALESCE(stat,game_type)}`. Keep in sync with MEMORY.md "Model changes".
// Only cutoffs within the trailing window actually trim; older ones are harmless.
const FORMULA_CUTOFFS = {
  "mlb|strikeouts": "2026-07-06", // blend capWeight 0.5→0.4 (tune:kblend); prior: K_FORM_SIGMA 0.26 @ 2026-06-13
  "mlb|hrr":        "2026-06-22", // FIP-over-WHIP split + game-time weather (was 2026-06-10: OPS 0.4→0.25, knee 72→68)
  "mlb|hits":       "2026-06-12", // ticker fix — data starts here
  "mlb|totalBases": "2026-06-30", // capture liquidity gate (2b67064) — pre-fix rows contaminated by lone-quote 94¢ artifacts (was 2026-06-12)
  "mlb|outs":       "2026-06-23", // pitcher outs-recorded O/U Phase 1 — data starts here
  "mlb|totalRuns":  "2026-06-01", // totalRuns market-line anchor
  "mlb|teamRuns":   "2026-05-27", // MLB teamTotal regime blend
  "nhl|totalGoals": "2026-05-29", // NHL NegBin + spread dampener
  "nhl|spread":     "2026-05-29",
  "nhl|ml":         "2026-05-29",
  "tennis|match":   "2026-06-13",
  "soccer|game":      "2026-06-21", // WC Phase 1 — Elo→λ→DC-Poisson matrix, data starts here
  "soccer|total":     "2026-06-21",
  "soccer|teamTotal": "2026-06-21",
  "soccer|spread":    "2026-06-21",
  "soccer|btts":      "2026-06-21",
  "soccer|1hgame":  "2026-06-21", // WC half markets — half-scaled matrix, data starts here
  "soccer|1htotal": "2026-06-21",
  "soccer|1hspread":"2026-06-21",
  "soccer|1hbtts":  "2026-06-21",
  "soccer|2hgame":  "2026-06-21",
  "soccer|2htotal": "2026-06-21",
  "soccer|2hspread":"2026-06-21",
  "soccer|2hbtts":  "2026-06-21",
  "soccer|advance": "2026-06-25", // WC knockout to-advance — Elo matrix + ET/pens draw allocation
  "fight|rounds":   "2026-06-21", // UFC Phase 1 — weight-class finish-rate → duration CDF
  "golf|h2h":       "2026-06-21", // PGA Phase 1 — OWGR rating → one-round score differential
  "nascar|h2h":     "2026-06-22", // NASCAR Cup Phase 1 — recent-form finishing-position model
  "nascar|top10":   "2026-06-22",
  "nbasl|ml":       "2026-07-13", // NBA Summer League Phase 1 — within-tournament Elo, data starts here
  "wnba|points":    "2026-05-28", // injury OffRtg piecewise (last broad λ change)
  "wnba|rebounds":  "2026-05-28",
  "wnba|assists":   "2026-05-28",
  "wnba|spread":    "2026-05-28",
  // B2B one-sided→transfer (2026-06-22): only the TOTAL axis changed (margin preserved → ML/spread
  // un-cutoff). NBA is offseason (forward-only Oct); WNBA accrues now.
  "nba|total":      "2026-06-22",
  "nba|teamTotal":  "2026-06-22",
  "wnba|total":     "2026-06-22",
  "wnba|teamTotal": "2026-06-22",
  // Game-row capture liquidity gate (2026-07-11) — pre-fix rows for in-play-only segment
  // markets are dead-book quote garbage (both-side ~95¢ asks logged as fake favorites;
  // f3/f7ml overround ~1.6, WNBA Q2-Q4/H2 up to ~1.9). f5 family + full-game categories
  // deliberately NOT bumped: their books were always real, so their history is clean.
  "mlb|f3ml":       "2026-07-11",
  "mlb|f7ml":       "2026-07-11",
  "wnba|q1total":   "2026-07-11", "wnba|q1spread": "2026-07-11", "wnba|q1ml": "2026-07-11",
  "wnba|q2total":   "2026-07-11", "wnba|q2spread": "2026-07-11", "wnba|q2ml": "2026-07-11",
  "wnba|q3total":   "2026-07-11", "wnba|q3spread": "2026-07-11", "wnba|q3ml": "2026-07-11",
  "wnba|q4total":   "2026-07-11", "wnba|q4spread": "2026-07-11", "wnba|q4ml": "2026-07-11",
  "wnba|h1total":   "2026-07-11", "wnba|h1spread": "2026-07-11", "wnba|h1ml": "2026-07-11",
  "wnba|h2total":   "2026-07-11", "wnba|h2spread": "2026-07-11", "wnba|h2ml": "2026-07-11",
  "nba|h1total":    "2026-07-11", "nba|h1spread":  "2026-07-11", "nba|h1ml":  "2026-07-11",
  "nba|h2total":    "2026-07-11", "nba|h2spread":  "2026-07-11", "nba|h2ml":  "2026-07-11",
};

// SQL: GREATEST(30d-floor, per-category formula cutoff) so each category's window is
// current-formula only. Category key mirrors the queries' COALESCE(stat, game_type).
function _formulaFloorSql(paramRef = "$1") {
  const whens = Object.entries(FORMULA_CUTOFFS).map(([key, date]) => {
    const [sport, cat] = key.split("|");
    return `WHEN sport='${sport}' AND COALESCE(stat, game_type)='${cat}' THEN '${date}'`;
  }).join("\n          ");
  return `GREATEST(${paramRef}::date, (CASE\n          ${whens}\n          ELSE '2000-01-01' END)::date)`;
}

// Significance verdict from a hit rate + sample. SE on the proportion = √(p(1−p)/n).
// kind='gate' → display-toggle bar (n≥50). kind='band' → formula bar (n≥200 + |Δ|>2·SE).
function _calibSig({ n, hitRate, predicted, kind }) {
  if (!n || hitRate == null) return { se: null, ci95: null, verdict: "too_few" };
  const p = Math.max(0, Math.min(1, hitRate / 100));
  const se = Math.sqrt(p * (1 - p) / n) * 100; // percentage points
  const ci95 = [parseFloat((hitRate - 1.96 * se).toFixed(1)), parseFloat((hitRate + 1.96 * se).toFixed(1))];
  let verdict;
  if (kind === "gate") {
    verdict = n >= 50 ? "gate_ready" : "building";
  } else {
    const delta = predicted != null ? hitRate - predicted : null;
    if (n < 200) verdict = "needs_n200";
    else if (delta != null && Math.abs(delta) > 2 * se) verdict = "actionable";
    else verdict = "within_noise";
  }
  return { se: parseFloat(se.toFixed(2)), ci95, verdict };
}

// Coherence: a same-direction miss across ≥3 adjacent bands pools n and is trustworthy
// sooner than one isolated band. Mutates each band row in-place, setting `coherent`.
function _markBandCoherence(bands) {
  const byCat = {};
  for (const b of bands) (byCat[`${b.sport}|${b.category}`] ??= []).push(b);
  for (const arr of Object.values(byCat)) {
    arr.sort((a, b) => _BAND_ORDER.indexOf(a.band) - _BAND_ORDER.indexOf(b.band));
    let runStart = 0;
    for (let i = 1; i <= arr.length; i++) {
      const adjacent = i < arr.length
        && _BAND_ORDER.indexOf(arr[i].band) === _BAND_ORDER.indexOf(arr[i - 1].band) + 1
        && Math.sign(arr[i].delta ?? 0) === Math.sign(arr[i - 1].delta ?? 0)
        && (arr[i].delta ?? 0) !== 0;
      if (!adjacent) {
        if (i - runStart >= 3) for (let j = runStart; j < i; j++) arr[j].coherent = true;
        runStart = i;
      }
    }
  }
}

// Per-category calibration summary from the band rows (the model-honesty axis). Picks the most
// significant ACTIONABLE band (proven over/under-confident) as the headline; falls back to a
// status of "honest" (some band has n≥200 and is within noise) or "insufficient" (not enough
// data to judge yet). direction: "over" = model too confident (Δ<0), "under" = too shy (Δ>0).
function _calibSummaryByCat(allBands) {
  const byCat = {};
  for (const b of allBands) (byCat[`${b.sport}|${b.category}`] ??= []).push(b);
  const out = {};
  for (const [key, arr] of Object.entries(byCat)) {
    const actionable = arr.filter(b => b.verdict === "actionable" && b.delta != null);
    let summary;
    if (actionable.length) {
      const top = actionable.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
      summary = { status: "actionable", direction: top.delta < 0 ? "over" : "under", delta: top.delta, band: top.band, n: top.n };
    } else if (arr.some(b => b.n >= 200)) {
      summary = { status: "honest", direction: null, delta: null, band: null, n: null };
    } else {
      summary = { status: "insufficient", direction: null, delta: null, band: null, n: null };
    }
    out[key] = summary;
  }
  return out;
}

// Fuse the profitability verdict + calibration signal + gate state into a single recommendation.
// The trap this guards: a model can be provably under-confident (Δ>0) AND still unprofitable (the
// market beats it) — de-shrinking would only bet more into a loss. So "underconfident" never maps
// to "tune up" unless there is actually a profitable window. Returns { action, tone, why }.
// Two-board split (2026-06-22): model ACCURACY (Layer 1) and BETTING (Layer 2 — price/ROI, gated by
// accuracy). Refocused 2026-06-23: Layer 1 now scores PURE accuracy vs reality (calibration: model%
// vs actual hit%, no price), not "beats the price". The price comparison (Brier skill) is kept as a
// secondary "vs market" signal and is what bridges to betting (eligible = skill CI lo > 0), computed
// directly from the Brier row — NOT from the accuracy verdict anymore.

// ── Layer 1: model ACCURACY (calibration vs reality) — no price, no gate ──────
// Scored on the truePct calibration summary (model% vs actual hit% per band). "actionable" already
// requires n≥200 or a coherent multi-band run, so CALIBRATED/miscalibrated stay conservative.
// |skillTrend| below this reads "flat"/saturated — mirror of the frontend _LEARN_FLAT.
const _LEARN_FLAT = 0.003;
function _accuracyVerdict(calib, brier, learning) {
  const c = calib || {};
  if (c.status === "actionable") return c.direction === "over" ? "OVERCONFIDENT" : "UNDERCONFIDENT";
  if (c.status === "honest")     return "CALIBRATED";   // some band hit n≥200 and lands within noise
  // Calibration insufficient — but "can't judge calibration yet" is NOT "no verdict possible". Two
  // Brier-skill outcomes are already TERMINAL and shouldn't hide behind a hopeful "BUILDING":
  //   • market TRUSTABLY sharper (skill<0 at n≥BRIER_MIN_N) AND not recovering (trend reliable + flat
  //     or falling) → MARKET_SHARPER: a settled negative — filling calibration bands can't rescue a
  //     model the price out-predicts; stop accruing. (A negative skill that's still RISING stays
  //     BUILDING — it may cross.)
  //   • model already beats the price (skill>0 at n≥BRIER_MIN_N) → PROMISING: near-eligible, just thin
  //     calibration — accrue toward eligibility, not "accruing from zero".
  // Everything else (skillN<BRIER_MIN_N, or skill≈0) is genuinely undecided → BUILDING.
  const skill = brier?.skill, skillN = brier?.n || 0;
  if (skill != null && skillN >= BRIER_MIN_N) {
    if (skill < 0 && learning?.reliable && learning.skillTrend != null && learning.skillTrend <= _LEARN_FLAT)
      return "MARKET_SHARPER";
    if (skill > 0) return "PROMISING";
  }
  return "BUILDING";
}
// `skill`/`skillN` = Brier skill (market−model) over the honesty population + its n. They fork the
// PRESCRIPTION for a miscalibrated category (not the verdict, which stays calibration-based) into THREE
// states, because "market out-predicts you" (the only justification for an L0 input hunt) requires the
// market's Brier to be TRUSTABLY better — a non-negative skill is the opposite of that:
//   • model sharper by sign (skill>0, any n) → the miss is pure SCALING → RECALIBRATE (L2 de-shrink).
//     A thin (skillN<BRIER_MIN_N) +skill is provisional — labeled so, and held off the daily banner
//     frontend-side until the n≥200 ripe-recalibrate bar (RECAL_MIN_N).
//   • market TRUSTABLY sharper (skill<0 AND skillN≥BRIER_MIN_N) → the model is missing a signal the
//     market prices → IMPROVE INPUTS (L0 new input, the only state that nags "run tune:residual").
//   • undecided (skill≈0, null, or a too-thin skill<0) → ACCRUING — don't claim the market is sharper
//     off a noisy Brier; no banner nag either way.
// (2026-06-24: the Recalibrate fork fixed mlb|totalBases/hits — underconfident AND beating the price —
// being told "find a new input." 2026-06-25: split out the thin/undecided cases so a model-sharper-but-
// thin category like wnba|threePointers (skill +0.045, n≈33) stops being mislabeled "needs a NEW input"
// just because its Brier n is below 100. See [[project-accuracy-recalibrate-fork]].)
function _accuracyAction(verdict, calib, skill, skillN) {
  const c = calib || { status: "insufficient" };
  const trusted       = (skillN || 0) >= BRIER_MIN_N;          // Brier reliable
  const beatsPrice    = skill != null && skill > 0;            // model sharper by SIGN (any n)
  const marketSharper = skill != null && skill < 0 && trusted; // market TRUSTABLY sharper
  const provNote      = trusted ? "" : ` (provisional, n<${BRIER_MIN_N})`;
  const deltaTxt = c.delta != null ? `${Math.abs(c.delta)}pts ` : "";
  switch (verdict) {
    case "CALIBRATED":
      return { action: "Calibrated", tone: "green",
        why: "model% matches actual outcomes within noise — well-calibrated to reality" };
    case "MARKET_SHARPER":
      // The market out-predicts the model and calibration won't rescue it — but "stop" isn't the
      // FIRST move: a globally-negative skill can still hide a sharp sub-slice (the totalBases
      // above-91¢ shape) or an unmodeled exogenous L0 input. So the next step is a ONE-TIME
      // diagnostic, not a blind stop. The frontend collapses this to "Stop — search exhausted" once
      // the category is in INPUT_SEARCH_EXHAUSTED (diagnostic already run, came up empty).
      return { action: "Diagnose then stop", tone: "red",
        why: `market out-predicts the model (negative Brier skill at n≥${BRIER_MIN_N}, trend not recovering) — calibration can't rescue it. Next: run tune:residual ONCE for a sharp sub-slice (price×threshold) or an unmodeled L0 input; if empty, park it and redirect effort to a less-efficient market` };
    case "PROMISING":
      return { action: "Promising — accrue", tone: "green",
        why: `model already beats the price (positive Brier skill at n≥${BRIER_MIN_N}) but calibration bands are still thin — accrue toward eligibility, not an input change` };
    case "OVERCONFIDENT":
      if (marketSharper)
        return { action: "Improve inputs", tone: "amber",
          why: `model is overconfident AND the market out-predicts it — says ${deltaTxt}more than it delivers in the ${c.band ?? ""}% band; needs a NEW input, run tune:residual` };
      if (beatsPrice)
        return { action: "Recalibrate", tone: "amber",
          why: `model beats the price${provNote} but over-claims (${deltaTxt}too high in the ${c.band ?? ""}% band) — scale down / de-shrink (L2 reweight), NOT a new input` };
      return { action: "Accruing", tone: "dim",
        why: `model over-claims (${deltaTxt}too high in the ${c.band ?? ""}% band) but model-vs-market is undecided at n<${BRIER_MIN_N} — accruing, not a new-input case yet` };
    case "UNDERCONFIDENT":
      if (marketSharper)
        return { action: "Improve inputs", tone: "amber",
          why: `model is underconfident AND the market out-predicts it — delivers ${deltaTxt}more than it claims in the ${c.band ?? ""}% band; needs a NEW input, run tune:residual` };
      if (beatsPrice)
        return { action: "Recalibrate", tone: "amber",
          why: `model beats the price${provNote} but under-claims (+${deltaTxt}in the ${c.band ?? ""}% band) — de-shrink / scale up (L2 reweight), NOT a new input` };
      return { action: "Accruing", tone: "dim",
        why: `model under-claims (+${deltaTxt}in the ${c.band ?? ""}% band) but model-vs-market is undecided at n<${BRIER_MIN_N} — accruing, not a new-input case yet` };
    default:
      return { action: "Accruing", tone: "dim", why: "not enough resolved plays to judge calibration yet" };
  }
}

// ── Layer 2: BETTING action (price/ROI), gated by Layer-1 eligibility ─────────
function _bettingAction(verdict, gated, eligible, hint) {
  if (!eligible)
    return { action: "Don't bet", tone: "dim",
      why: "model doesn't beat the price — no edge to bet regardless of window" };
  switch (verdict) {
    case "PROMOTE":       return { action: "Add to gate", tone: "green", why: "eligible + validated profitable window — start betting" };
    case "HOLD":          return { action: "Keep betting", tone: "gray", why: "gated and still profitable" };
    case "DEMOTE":        return { action: "Pull from gate", tone: "red", why: "window went significantly negative" };
    case "STRENGTHENING": return { action: "Build", tone: "blue", why: hint || "eligible + positive but window not yet validated — accruing" };
    case "NEGATIVE":
      // eligible ⇒ skillLoCI>0 already, so the old "Look deeper" guard is satisfied by construction:
      // a provably-sharper model that still loses the bettable window is a real selection/sizing puzzle.
      return gated
        ? { action: "Pull from gate", tone: "red", why: "eligible but no longer has a profitable window" }
        : { action: "Look deeper", tone: "blue", why: "model beats the price but the bettable window still loses — selection/sizing puzzle (Phase 2 residual slicer)" };
    default:              return { action: "Build", tone: "dim", why: "too few bettable plays yet — accruing" };
  }
}

// ── Price-band profitability (the Model board) ───────────────────────────────
// Price-window math (MIN_N_WINDOW/MIN_N_PROMOTE, priceWindowBins, discoverPriceWindow,
// windowQuality) lives in ../price-window.js — imported above, shared with the tune:window CLI.
// Brier skill (= marketBrier − modelBrier; >0 = model sharper than the price). No longer drives the
// accuracy verdict (that's calibration-based now) — it's the secondary "vs market" signal and the
// betting board's `eligible` gate: skill CI lo > 0 AND n ≥ BRIER_MIN_N. Only trusted above
// BRIER_MIN_N resolved plays (Brier is a mean of squared errors → lower variance than a tail
// hit-rate, but still noisy at small n, where the CI can read misleadingly positive).
const BRIER_MIN_N = 100; // min resolved n before Brier skill can gate betting eligibility

function _extractReportToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
  if (m?.[1]) return m[1];
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
}

// Cold-wake guard for the resolution-completeness read. The 6am report cron spins up a fresh
// function instance whose first Neon read can hit a just-woken read replica that lags the overnight
// resolver writes — returning a low resolved count (caught live: 105/935 then 935/935 two minutes
// later with ZERO rows resolved in between). That false-incomplete read trips the 15-min
// INCOMPLETE_REPORT_TTL, so the report expires minutes after 6am and the user sees "not yet
// generated" at 7am. The staleness is NOT pinned to one endpoint ({write:true}/POSTGRES_URL was the
// stale one on 2026-06-25 while the default conn was fresh), so we read BOTH and (if still <90%)
// retry once after a short settle. resolved/scored/clv are MONOTONIC (resolutions only ever ADD), so
// a stale read can only under-count — taking the MAX across reads is always the truth.
const _RESOLUTION_SQL = `
  SELECT COUNT(*) AS total, SUM(resolved::int) AS resolved,
    SUM((won IS NOT NULL)::int) AS scored,
    SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS clv_captured
  FROM shadow_plays WHERE game_date = $1`;

function _parseResolutionRow(row) {
  if (!row) return null;
  return {
    total: Number(row.total ?? 0),
    resolved: Number(row.resolved ?? 0),
    scored: Number(row.scored ?? 0),
    clvCaptured: Number(row.clv_captured ?? 0),
  };
}

function _mergeResolution(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    total: Math.max(a.total, b.total),
    resolved: Math.max(a.resolved, b.resolved),
    scored: Math.max(a.scored, b.scored),
    clvCaptured: Math.max(a.clvCaptured, b.clvCaptured),
  };
}

// KV-backed resolution high-water mark. Upstash is read-after-write consistent and immune to the
// Postgres read-replica lag that makes a cold-instance SQL read under-count (resolved=101/718 →
// falsely "incomplete" → 15-min TTL → report vanishes by 6:15am). total/resolved/scored/clv are
// MONOTONIC (resolutions only ADD; rows never un-resolve or get deleted), so we max-merge the SQL
// read with the KV stamp and write the floor back — whichever caller (overnight resolver pass, 6am
// report cron, or a warm user bust) reads the true count locks it in for everyone after.
const _RESOLUTION_KV_PREFIX = "shadow:resolution:";
const _RESOLUTION_KV_TTL = 30 * 3600; // 30h — survives overnight resolver → 6am report → daytime reads

async function _stampResolutionFloor(date, row, cache) {
  if (!cache) return row;
  const key = `${_RESOLUTION_KV_PREFIX}${date}`;
  const prev = await cache.get(key, "json").catch(() => null); // {total,resolved,scored,clvCaptured}
  const merged = _mergeResolution(row, prev);
  if (merged && merged.total > 0) {
    cache.put(key, JSON.stringify(merged), { expirationTtl: _RESOLUTION_KV_TTL }).catch(() => {});
  }
  return merged || row;
}

async function _readResolutionRobust(yesterday, env, seedRow, cache) {
  const read = async (write) => {
    try {
      const r = await neonQuery(_RESOLUTION_SQL, [yesterday], env, write ? { write: true } : {});
      return _parseResolutionRow(r?.[0]);
    } catch { return null; }
  };
  // Seed with Q6's already-run {write:true} read; cross-check against the default conn (the endpoint
  // that was fresh on 2026-06-25). On the happy path this is a single extra COUNT query.
  let best = _mergeResolution(_parseResolutionRow(seedRow), await read(false));
  // Authoritative replica-proof floor: the resolver stamps yesterday's true count to KV. Merging it
  // means a cold instance whose every SQL read is replica-stale still sees the real resolved count
  // (the 2026-06-26 miss: all in-instance SQL reads returned 101/718 for >1min; KV held 717).
  if (cache) {
    const kv = await cache.get(`${_RESOLUTION_KV_PREFIX}${yesterday}`, "json").catch(() => null);
    best = _mergeResolution(best, kv);
  }
  // Still incomplete? Give a lagging just-woken replica time to catch up, then re-read both + max.
  if (best && best.total > 0 && best.resolved / best.total < 0.9) {
    await new Promise(r => setTimeout(r, 1500));
    const [w, d] = await Promise.all([read(true), read(false)]);
    best = _mergeResolution(best, _mergeResolution(w, d));
  }
  // Persist the merged high-water mark so a warm read raises the floor for every later read.
  if (cache && best && best.total > 0) await _stampResolutionFloor(yesterday, best, cache);
  return best || { total: 0, resolved: 0, scored: 0, clvCaptured: 0 };
}


// ── Daily brief — deterministic prose over the assembled report ───────────────
// The readable replacement for scanning the accuracy grid: every sentence is templated straight
// from numbers the report already computed (no free text, no model call), so the brief can never
// drift from the boards it summarizes. Sections (reader order, 2026-07-04 format): health (is the
// data trustworthy?) · headline · what changed vs yesterday (null when no prior exists — first run
// or a post-expiry mid-day regen) · model state (notable categories only, the rest collapsed to a
// count) · betting accrual clocks (eligible rows: in-window read + discovered window vs the promote
// bar) · pricing findings (both cross-venue observatories) · takeaway (the one-line "so what").
const _briefSkill = s => s == null ? "—" : `${s >= 0 ? "+" : ""}${Number(s).toFixed(3)}`;
const _briefRoi = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${(Number(v) * 100).toFixed(1)}%`;
const _briefVerdict = v => String(v || "").toLowerCase().replace(/_/g, " ");
function _buildDailyBrief(r, prior) {
  const acc = r.accuracyBoard || [];
  const bet = r.bettingBoard || [];
  const name = k => String(k || "").replace("|", " ");

  // Health — one sentence answering "can I trust the numbers below?" before showing any of them.
  // Mirrors dataHealth exactly: clean → the trust line; warned → the warnings verbatim (they're
  // already sentences); tone carries clean/caution/action so the client can color without re-deriving.
  const dh = r.dataHealth;
  let health = null;
  if (dh?.resolution?.total > 0) {
    if (dh.warnings?.length) {
      health = { tone: dh.actionable ? "action" : "caution", text: dh.warnings.join(" ") };
    } else {
      const res = dh.resolution;
      const clvTxt = dh.clvCapture?.pct != null ? `, ${dh.clvCapture.pct}% CLV capture` : "";
      health = {
        tone: "clean",
        text: `Pipeline health clean — ${res.ratePct}% of yesterday's plays resolved (${res.pending} pending, mostly next-day pre-listings)${clvTxt}, no coverage warning — the readings below are trustworthy.`,
      };
    }
  }

  // Headline — the one-sentence answer to "can we bet anything yet?".
  const eligibleRows = bet.filter(b => b.eligible);
  const gatedN = bet.filter(b => b.gated).length;
  const trusted = acc.filter(a => a.skill != null && (a.n || 0) >= BRIER_MIN_N);
  const best = trusted.slice().sort((a, b) => b.skill - a.skill)[0] || null;
  const headline = eligibleRows.length
    ? `${eligibleRows.length} categor${eligibleRows.length === 1 ? "y" : "ies"} provably beat${eligibleRows.length === 1 ? "s" : ""} the market (${eligibleRows.map(b => name(b.key)).join(", ")}); ${gatedN ? `${gatedN} in the live gate` : "the live gate is empty"}.`
    : `No category beats the market with confidence yet; the gate is ${gatedN ? `running ${gatedN}` : "empty"}.` +
      (best ? ` Closest: ${name(best.key)} at skill ${_briefSkill(best.skill)} (n=${best.n}).` : "");

  // Model state — one sentence per NOTABLE category (verdict beyond BUILDING); the categories
  // closest to bettable lead (PROMISING/CALIBRATED — the rows the headline names must appear here,
  // not get crowded out by the amber pile), then prescriptive actions, then by data weight.
  // Everything else collapses to a single count line.
  const model = [];
  // A row whose tune:residual diagnostic already ran empty (dated INPUT_SEARCH_EXHAUSTED, shared
  // with the Do-this banner via model-holds.js) must read as PARKED, not re-nag the diagnostic —
  // the brief and the banner have to agree on what's already been done. Auto-un-parks when a
  // FORMULA_CUTOFF postdates the exhaustion (stillExhausted), same as the banner.
  const _parked = a => (a.honest?.action === "Improve inputs" || a.honest?.action === "Diagnose then stop")
    && stillExhausted(INPUT_SEARCH_EXHAUSTED, a.key, a.formulaCutoff);
  const _parkedTxt = a => `parked — input search exhausted ${INPUT_SEARCH_EXHAUSTED[a.key]} (tune:residual found nothing addable); re-opens on a formula reset or its scheduled checkpoint`;
  const _verdictRank = { PROMISING: 0, CALIBRATED: 0 };
  const _actRank = { "Diagnose then stop": 1, "Improve inputs": 2, "Recalibrate": 3 };
  const _rank = a => _verdictRank[a.verdict] ?? (_parked(a) ? 8 : (_actRank[a.honest?.action] ?? 9));
  const notable = acc.filter(a => a.verdict && a.verdict !== "BUILDING")
    .sort((a, b) => _rank(a) - _rank(b) || (b.n || 0) - (a.n || 0));
  for (const a of notable.slice(0, 6)) {
    const skillTxt = `skill ${_briefSkill(a.skill)} vs market, n=${a.n}`;
    const c = a.calib || {};
    const dTxt = c.delta != null ? `${Math.abs(c.delta)}pts` : "";
    const act = _parked(a) ? _parkedTxt(a) : (a.honest?.action || "review");
    // Decay caution — a positive-skill category whose reliable learning trend is materially
    // negative is real-but-eroding (the market is closing the gap); say so on its own bullet so
    // the green verdict doesn't read as static. Threshold −0.05 ≈ well past trend noise.
    const decayTxt = (a.skill > 0 && a.learning?.reliable && (a.learning?.skillTrend ?? 0) <= -0.05)
      ? ` One caution: its skill trend is ${_briefSkill(a.learning.skillTrend)} — the edge is real but the market is closing the gap.` : "";
    switch (a.verdict) {
      case "CALIBRATED":     model.push(`${name(a.key)} is calibrated — model% matches outcomes within noise (${skillTxt}).${decayTxt}`); break;
      case "PROMISING":      model.push(`${name(a.key)} beats the market (${skillTxt}) but calibration bands are still thin — closest to betting-eligible.${decayTxt}`); break;
      case "MARKET_SHARPER": model.push(`${name(a.key)}: the market out-predicts the model and the trend isn't recovering (${skillTxt}) — ${act}.`); break;
      case "OVERCONFIDENT":  model.push(`${name(a.key)} is overconfident — claims ${dTxt} more than it delivers in the ${c.band ?? "?"}% band (${skillTxt}) — ${act}.`); break;
      case "UNDERCONFIDENT": model.push(`${name(a.key)} is underconfident — delivers ${dTxt} more than it claims in the ${c.band ?? "?"}% band (${skillTxt}) — ${act}.`); break;
      default:               model.push(`${name(a.key)}: ${_briefVerdict(a.verdict)} (${skillTxt}).`);
    }
  }
  const buildingN = acc.length - notable.length;
  if (buildingN > 0) model.push(`${buildingN} other categor${buildingN === 1 ? "y is" : "ies are"} still accruing data — nothing to act on there.`);

  // Betting accrual clocks — one bullet per eligible category: the in-window read (flagged when
  // too thin to mean anything), and the discovered window's distance from the n≥MIN_N_PROMOTE
  // promote bar. Gate-level changes (rare, important) lead the section.
  const betting = [];
  for (const b of bet) {
    if (b.verdict === "PROMOTE")            betting.push(`${name(b.key)} is ready to gate — ${b.hint || "validated profitable window"}.`);
    else if (b.verdict === "DEMOTE")        betting.push(`Pull ${name(b.key)} from the gate — its window went significantly negative.`);
    else if (b.gated && b.verdict === "HOLD") betting.push(`${name(b.key)} stays in the gate — still profitable.`);
  }
  for (const b of bet) {
    if (!b.eligible || b.verdict === "PROMOTE" || b.verdict === "DEMOTE") continue;
    const parts = [];
    const sw = b.subWindow;
    if (sw?.n) parts.push(`in the current ${b.currentWindow?.[0]}–${b.currentWindow?.[1]}¢ window ROI ${_briefRoi(sw.roi)} (n=${sw.n}${sw.n < 30 ? " — too thin to read yet" : ""})`);
    const dw = b.discoveredWindow;
    if (dw?.lo != null)
      parts.push(`discovered ${dw.lo}–${dw.hi}¢ window ROI ${_briefRoi(dw.roi)} (CI-lo ${_briefRoi(dw.roiLoCI)}, n=${dw.n}/${_MIN_N_PROMOTE} toward the promote bar${dw.coherent === false ? ", bands not coherent" : ""})`);
    if (parts.length) betting.push(`${name(b.key)}: ${parts.join("; ")}.`);
  }

  // Pricing findings — one sentence per cross-venue observatory, verdict in plain words.
  const pricing = [];
  // BOTH kill-gates CLOSED 2026-07-04 (Polymarket + sportsbook: zero surviving executable edge on
  // clean post-date-fix data; Phase-1b builds killed). The observatories stay as reference/tripwire
  // feeds, so the template reads accordingly: GAP = regime change vs the closed gate (or an
  // artifact — both prior ≥5¢ tails were fake, audit first), never a build prompt; the exec clause
  // still rides on every Poly verdict but as tripwire context, not a go/no-go.
  const venue = (v, label, extra) => {
    if (!v) return;
    if (v.verdict === "ACCRUING")  pricing.push(`${label}: thin window (n=${v.n} sides over ${v.days}d).${extra || ""}`);
    else if (v.verdict === "GAP")  pricing.push(`${label}: Kalshi shows cheap — ${Math.round((v.fracBuyEdge3 || 0) * 100)}% of traded sides ≥3¢ under the reference (median |Δ| ${v.medianAbs}¢, n=${v.n}/${v.days}d) — regime change vs the closed 7/04 kill-gate or an artifact: audit the ?minAbs=3 tail before acting.${extra || ""}`);
    else if (v.verdict === "TIGHT") pricing.push(`${label}: venues track — only ${Math.round((v.fracBuyEdge3 || 0) * 100)}% of sides ≥3¢ cheap (median |Δ| ${v.medianAbs}¢, n=${v.n}/${v.days}d) — no liquid lag edge (kill-gate closed 7/04).${extra || ""}`);
  };
  venue(r.sportsbookValidation, "Sharp book (de-vigged)");
  const pm = r.polymarketValidation;
  venue(pm, "Polymarket", pm?.execN ? ` Executable read: ${Math.round((pm.execFracEdge3 || 0) * 100)}% of bettable sides stay ≥3¢ cheaper after walking the Poly book (exec n=${pm.execN}) — tripwire only; the Phase-1b build was killed at the 7/04 gate.` : "");
  if (!pricing.length) pricing.push("No cross-venue pricing data captured yet (observatory feeds not populated).");

  // What changed vs yesterday's report — verdict flips, trusted-skill moves, n crossings,
  // eligibility flips, freshly-detected series. Omitted entirely (null) when no prior exists.
  let changes = null;
  if (prior?.accuracyBoard) {
    changes = [];
    const pAcc = Object.fromEntries((prior.accuracyBoard || []).map(a => [a.key, a]));
    for (const a of acc) {
      const p = pAcc[a.key];
      if (!p) continue;
      if (p.verdict !== a.verdict) changes.push(`${name(a.key)}: ${_briefVerdict(p.verdict)} → ${_briefVerdict(a.verdict)}.`);
      if (p.skill != null && a.skill != null && (a.n || 0) >= BRIER_MIN_N && Math.abs(a.skill - p.skill) >= 0.01)
        changes.push(`${name(a.key)} skill moved ${_briefSkill(p.skill)} → ${_briefSkill(a.skill)} (n=${a.n}).`);
      if ((p.n || 0) < BRIER_MIN_N && (a.n || 0) >= BRIER_MIN_N)
        changes.push(`${name(a.key)} crossed n=${BRIER_MIN_N} — its vs-market skill is now trusted.`);
    }
    const pBet = Object.fromEntries((prior.bettingBoard || []).map(b => [b.key, b]));
    for (const b of bet) {
      const p = pBet[b.key];
      if (p && !!p.eligible !== !!b.eligible)
        changes.push(`${name(b.key)} ${b.eligible ? "became betting-eligible" : "lost betting eligibility"}.`);
    }
    const pNew = new Set((prior.newMarkets || []).map(m => m.ticker));
    const fresh = (r.newMarkets || []).filter(m => !pNew.has(m.ticker));
    if (fresh.length) changes.push(`${fresh.length} new Kalshi series detected: ${fresh.map(m => m.ticker).join(", ")}.`);
    if (!changes.length) changes.push("No material change since yesterday's report.");
  }

  // Takeaway — the one-line "so what": actions if any exist (data-health fix, gate moves),
  // otherwise name the accrual clocks that matter (discovered windows short of the promote bar,
  // eligible categories whose in-window sample is still too thin). Capped at 3 clocks.
  const actions = [];
  if (dh?.actionable) actions.push("fix data health (see the health line)");
  for (const b of bet) {
    if (b.verdict === "PROMOTE") actions.push(`add ${name(b.key)} to the gate`);
    else if (b.verdict === "DEMOTE") actions.push(`pull ${name(b.key)} from the gate`);
  }
  let takeaway;
  if (actions.length) {
    takeaway = `Action needed today: ${actions.join("; ")}.`;
  } else {
    const clocks = [];
    for (const b of bet.filter(x => x.eligible)) {
      const dw = b.discoveredWindow;
      if (dw?.lo != null && (dw.n || 0) < _MIN_N_PROMOTE) clocks.push(`${name(b.key)}'s ${dw.lo}–${dw.hi}¢ window (n ${dw.n}/${_MIN_N_PROMOTE})`);
      else if ((b.subWindow?.n || 0) < 30) clocks.push(`${name(b.key)}'s calibration bands`);
    }
    takeaway = clocks.length
      ? `Nothing needs action today — the clocks that matter are ${clocks.slice(0, 3).join(", ")}.`
      : "Nothing needs action today.";
  }

  return { health, headline, changes, model, betting, pricing, takeaway };
}

async function handleShadowReport({ path, request, env, cache }) {
  if (path !== "shadow-report") return null;

  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isCron  = env?.CRON_SECRET && bearer === env.CRON_SECRET;
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;

  let isUser = false;
  if (!isCron && !isAdmin && env?.JWT_SECRET) {
    const token = _extractReportToken(request);
    const payload = token ? await verifyJWT(token, env.JWT_SECRET) : null;
    isUser = !!payload;
  }

  if (!isCron && !isAdmin && !isUser) return errorResponse("Forbidden", 403);
  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("No Neon connection", 500);

  const reportDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const cacheKey = `${REPORT_CACHE_KEY_PREFIX}${reportDate}`;
  const bust = new URL(request.url).searchParams.get("bust") === "1";

  // Serve cached report for non-cron reads (cron always regenerates).
  if (!isCron && !bust) {
    const cached = cache ? await cache.get(cacheKey, "json").catch(() => null) : null;
    if (cached) return jsonResponse(cached);
    // No cached report. Past the 6am cron hour, an empty cache almost always means a cold-replica
    // read flagged the cron's report "incomplete" → 15-min TTL → it expired (the recurring 6:35am
    // miss). Rather than show the dead "not yet generated" state, regenerate once on this read — by
    // now the instance is warm so the resolution read is fresh. A short KV lock avoids a stampede;
    // before the cron hour there genuinely is no report yet, so keep the friendly stub.
    const ptHour = Number(new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false,
    })) % 24;
    if (cache && ptHour >= 6) {
      const lockKey = `shadow:report:lock:${reportDate}`;
      const locked = await cache.get(lockKey).catch(() => null);
      if (locked) return jsonResponse({ notYet: true, reportDate, regenerating: true });
      cache.put(lockKey, "1", { expirationTtl: 60 }).catch(() => {});
      // fall through to regenerate
    } else {
      return jsonResponse({ notYet: true, reportDate });
    }
  }

  const t0 = Date.now();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  // Yesterday in PT — the recap scopes to games played yesterday (pick.gameDate). Report runs
  // 6am PT, well clear of the midnight boundary, so a flat 24h subtraction is safe.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  let catRows, bandRows, clvRows, volRows, picksRows, healthRows, perGameRows, priceHistRows, brierRows, learnRows;
  try {
    [catRows, bandRows, clvRows, volRows, picksRows, healthRows, perGameRows, priceHistRows, brierRows, learnRows] = await Promise.all([
      // Q1: Category overview — one row per player/game (threshold_rank=1 dedup).
      // Window floored per-category at the current-formula cutoff (no superseded-formula mixing).
      neonQuery(`
        SELECT sport, COALESCE(stat, game_type) AS category,
          COUNT(*) AS n, SUM(won::int) AS wins,
          ROUND(AVG(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0, 4) AS avg_bet_pct,
          ROUND(AVG(edge), 2) AS avg_edge,
          MIN(snapshot_date) AS first_date
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND snapshot_date >= ${_formulaFloorSql("$1")} AND threshold_rank = 1
        GROUP BY sport, COALESCE(stat, game_type)
        ORDER BY n DESC LIMIT 20
      `, [since], env, { write: true }),

      // Q2: Band distribution (55–100%, n≥5) — where is there most data + biggest gap?
      neonQuery(`
        WITH src AS (
          SELECT sport, COALESCE(stat, game_type) AS category,
            model_true_pct AS bsp, -- bet-side 0–100 (shadow.js:1571); no under-flip (fixed 2026-06-19)
            won::int AS w,
            CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END AS bet_pct
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL AND snapshot_date >= ${_formulaFloorSql("$1")} AND threshold_rank = 1
        )
        SELECT sport, category,
          CASE
            WHEN bsp >= 95 THEN '95+' WHEN bsp >= 90 THEN '90-95' WHEN bsp >= 85 THEN '85-90'
            WHEN bsp >= 80 THEN '80-85' WHEN bsp >= 75 THEN '75-80' WHEN bsp >= 70 THEN '70-75'
            WHEN bsp >= 65 THEN '65-70' WHEN bsp >= 60 THEN '60-65' ELSE '55-60'
          END AS band,
          COUNT(*) AS n, SUM(w) AS wins,
          ROUND(AVG(bsp), 1) AS avg_bsp,
          ROUND(AVG(bet_pct)/100.0, 4) AS avg_bet_pct
        FROM src WHERE bsp >= 55
        GROUP BY sport, category, band HAVING COUNT(*) >= 5
        ORDER BY n DESC
      `, [since], env, { write: true }),

      // Q3: CLV — per-category avg line movement (3pm snapshot → 7pm pre-game stamp).
      neonQuery(`
        SELECT sport, COALESCE(stat, game_type) AS category,
          COUNT(*) AS n,
          ROUND(AVG(CASE WHEN direction='under'
            THEN (kalshi_no_price_pre - kalshi_no_price) * 100
            ELSE (kalshi_yes_price_pre - kalshi_yes_price) * 100 END), 2) AS avg_clv_pct,
          ROUND(AVG(CASE WHEN direction='under'
            THEN (model_true_pct/100.0 - 1 + kalshi_no_price_pre) * -100
            ELSE (model_true_pct/100.0 - kalshi_yes_price_pre) * 100 END), 2) AS avg_edge_at_close,
          ROUND(AVG(CASE WHEN direction='under'
            THEN (model_true_pct/100.0 - 1 + kalshi_no_price) * -100
            ELSE (model_true_pct/100.0 - kalshi_yes_price) * 100 END), 2) AS avg_edge_at_snap,
          ROUND(AVG(won::int) * 100, 1) AS hit_rate_pct
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND snapshot_date >= $1
          AND threshold_rank = 1 AND kalshi_yes_price_pre IS NOT NULL
        GROUP BY sport, COALESCE(stat, game_type) HAVING COUNT(*) >= 5
        ORDER BY n DESC
      `, [since], env, { write: true }),

      // Q4: Daily volume ROI — plays/day bucket vs realized ROI.
      neonQuery(`
        WITH daily AS (
          SELECT snapshot_date,
            COUNT(*) AS n_plays, SUM(won::int) AS wins,
            AVG(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 AS avg_price
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL AND snapshot_date >= $1 AND threshold_rank = 1
          GROUP BY snapshot_date
        )
        SELECT
          CASE WHEN n_plays<=2 THEN '1-2' WHEN n_plays<=4 THEN '3-4'
               WHEN n_plays<=6 THEN '5-6' WHEN n_plays<=9 THEN '7-9' ELSE '10+' END AS picks_bucket,
          CASE WHEN n_plays<=2 THEN 1 WHEN n_plays<=4 THEN 2
               WHEN n_plays<=6 THEN 3 WHEN n_plays<=9 THEN 4 ELSE 5 END AS bucket_order,
          COUNT(*) AS n_days, SUM(n_plays) AS total_plays,
          ROUND(AVG(n_plays), 1) AS avg_plays,
          ROUND(SUM(wins)::numeric / SUM(n_plays) * 100, 1) AS hit_rate_pct,
          ROUND(AVG(avg_price) * 100, 1) AS avg_price_pct,
          ROUND((SUM(wins)::numeric / SUM(n_plays)) - AVG(avg_price), 4) AS roi
        FROM daily
        GROUP BY picks_bucket, bucket_order ORDER BY bucket_order
      `, [since], env, { write: true }),

      // Q5: Today's top picks — qualified plays from this morning's snapshot.
      // Category gate is replicated from passesCategoryGate() in src/lib/constants.js.
      neonQuery(`
        SELECT sport, COALESCE(stat, game_type) AS category, stat, game_type,
          player_name, home_team, away_team, pick_team,
          direction, threshold, pick_line,
          ROUND(model_true_pct, 1) AS model_true_pct,
          ROUND(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END, 1) AS market_pct,
          ROUND(edge, 2) AS edge,
          game_time
        FROM shadow_plays
        WHERE snapshot_date = $1
          AND dc_qualified = TRUE
          AND edge >= 5
          AND is_best_edge = TRUE
          AND ${_CATEGORY_GATE_SQL}
        ORDER BY edge DESC LIMIT 5
      `, [reportDate], env, { write: true }),

      // Q6: Data health — yesterday's resolution + CLV capture (garbage-in guard).
      neonQuery(`
        SELECT
          COUNT(*) AS total,
          SUM(resolved::int) AS resolved,
          SUM((won IS NOT NULL)::int) AS scored,
          SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS clv_captured
        FROM shadow_plays
        WHERE game_date = $1
      `, [yesterday], env, { write: true }),

      // Q7: Picks-per-game calibration — among the gated bet set (dc_qualified, edge≥5,
      // Kalshi 67–91), rank picks within a game by edge and report ROI per within-game rank.
      // rnk=0 is the solo-game baseline; multi rows reveal whether the 2nd/3rd pick adds ROI.
      neonQuery(`
        WITH gated AS (
          SELECT edge, won::int AS w,
            CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END AS bet_pct,
            sport || '|' || LEAST(home_team, away_team) || '|' || GREATEST(home_team, away_team)
              || '|' || COALESCE(game_date, snapshot_date::text) AS game_key
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL AND dc_qualified AND edge >= 5
            AND threshold_rank = 1 AND home_team IS NOT NULL AND away_team IS NOT NULL
            AND snapshot_date >= $1
            AND (CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END) BETWEEN 67 AND 91
        ),
        ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY game_key ORDER BY edge DESC, bet_pct ASC) AS rnk,
            COUNT(*)     OVER (PARTITION BY game_key) AS game_n
          FROM gated
        )
        SELECT
          (game_n > 1) AS multi,
          CASE WHEN game_n > 1 THEN rnk ELSE 0 END AS rnk,
          COUNT(*) AS n,
          ROUND(100.0 * AVG(w), 1) AS hit_rate,
          ROUND(AVG(bet_pct), 1) AS avg_price,
          ROUND(100.0 * AVG(w) - AVG(bet_pct), 2) AS roi_pct
        FROM ranked
        GROUP BY 1, 2 ORDER BY 1, 2
      `, [since], env, { write: true }),

      // Q8: Price-band profitability — fine 5¢ grid of model-positive plays (dc_qualified,
      // edge ≥ server gate) across the FULL Kalshi price range. No 67–91 window and no truePct
      // category gate are applied — those are the assumptions under test, so the data shows where
      // the profitable window actually is. The server edge gate (looser than the client 5) is
      // the documented calibration bar and the loosest "model sees value" filter — maximizes
      // usable signal. Formula-windowed + threshold_rank=1 deduped like the other model Qs.
      neonQuery(`
        WITH bp AS (
          SELECT sport, COALESCE(stat, game_type) AS category,
            (CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END) AS price,
            won::int AS w
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL
            AND snapshot_date >= ${_formulaFloorSql("$1")}
            AND threshold_rank = 1 AND dc_qualified = TRUE AND edge >= ${EDGE_GATE_SERVER}
        )
        SELECT sport, category, (FLOOR(price/5)*5)::int AS price_lo,
          COUNT(*) AS n, SUM(w) AS wins, ROUND(AVG(price), 2) AS avg_price
        FROM bp WHERE price >= 1 AND price <= 99
        GROUP BY sport, category, price_lo
        ORDER BY sport, category, price_lo
      `, [since], env, { write: true }),

      // Q9: Proper-score head-to-head — model-Brier vs market-Brier per category over the
      // honesty population (all resolved formula-clean rows, threshold_rank=1; no edge/price
      // gate). `model_true_pct` is bet-side so it predicts `won` directly; the market bet-side
      // price is the no-side for UNDERs. skill = market − model (>0 = model sharper than price).
      // Same math as /api/auth/shadow-calibration?brier=1, surfaced live on the model board.
      neonQuery(`
        SELECT sport, COALESCE(stat, game_type) AS category,
          COUNT(*) AS n,
          AVG(POWER(model_true_pct/100.0 - (won)::int, 2)) AS model_brier,
          AVG(POWER((CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 - (won)::int, 2)) AS market_brier,
          -- Paired per-play skill difference (market_se − model_se); its mean IS the skill, its
          -- stddev gives the SE for a CI lower bound. >0 per play = model sharper on that play.
          STDDEV_SAMP(
            POWER((CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 - (won)::int, 2)
            - POWER(model_true_pct/100.0 - (won)::int, 2)
          ) AS skill_sd
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND snapshot_date >= ${_formulaFloorSql("$1")} AND threshold_rank = 1
        GROUP BY sport, COALESCE(stat, game_type)
      `, [since], env, { write: true }),

      // Q10: Learning curve (coarse) — is the model still LEARNING, or saturated? Splits each
      // category's current-formula population at its median snapshot_date (NTILE(2) chronological)
      // and computes paired Brier skill (market − model) in each half. skillTrend = recent − early:
      // >0 = skill rising as data accrues (still extracting signal → keep accruing), ≈0 = saturated
      // (reweighting tapped out; flat+below-price ⇒ needs a new input). Fine-grained per-checkpoint
      // curve + the β* step size live in `npm run tune:learncurve`; this is the board headline.
      neonQuery(`
        WITH halved AS (
          SELECT sport, COALESCE(stat, game_type) AS category,
            NTILE(2) OVER (PARTITION BY sport, COALESCE(stat, game_type) ORDER BY snapshot_date) AS half,
            POWER((CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0 - (won)::int, 2)
              - POWER(model_true_pct/100.0 - (won)::int, 2) AS skill_i
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL AND snapshot_date >= ${_formulaFloorSql("$1")} AND threshold_rank = 1
        )
        SELECT sport, category,
          COUNT(*) FILTER (WHERE half = 1) AS n_early,
          COUNT(*) FILTER (WHERE half = 2) AS n_recent,
          AVG(skill_i) FILTER (WHERE half = 1) AS skill_early,
          AVG(skill_i) FILTER (WHERE half = 2) AS skill_recent
        FROM halved
        GROUP BY sport, category
      `, [since], env, { write: true }),
    ]);
  } catch (e) {
    console.error("[shadow-report] query failed:", e?.message);
    return errorResponse(`query failed: ${e?.message}`, 500);
  }

  // Process category overview. Window is current-formula only (Q1 floor); annotate the cutoff,
  // how many days the sample spans, and a significance verdict (gate-sample readiness).
  const _MS_DAY = 86400 * 1000;
  const categories = catRows.map(r => {
    const n = Number(r.n ?? 0);
    const wins = Number(r.wins ?? 0);
    const hitRate = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
    const avgBetPct = r.avg_bet_pct != null ? parseFloat(Number(r.avg_bet_pct).toFixed(4)) : null;
    const roi = hitRate != null && avgBetPct != null ? parseFloat((hitRate / 100 - avgBetPct).toFixed(4)) : null;
    const key = `${r.sport}|${r.category}`;
    const status = _isGatedCategory(key) ? "active"
      : n >= 50 && (roi ?? -1) > 0 ? "building"
      : n >= 30 && (roi ?? 0) <= 0 ? "losing"
      : "too_few";
    const formulaCutoff = FORMULA_CUTOFFS[key] ?? null;
    const effFloor = formulaCutoff && formulaCutoff > since ? formulaCutoff : since;
    const windowTrimmed = !!(formulaCutoff && formulaCutoff > since);
    const daysInWindow = Math.max(1, Math.round((Date.parse(reportDate) - Date.parse(effFloor)) / _MS_DAY));
    const sig = _calibSig({ n, hitRate, predicted: null, kind: "gate" });
    return {
      key, sport: r.sport, category: r.category, n, hitRate,
      roi, avgEdge: r.avg_edge != null ? parseFloat(Number(r.avg_edge).toFixed(2)) : null, status,
      formulaCutoff, windowTrimmed, daysInWindow, ...sig,
    };
  });

  // Process opportunity bands — calibration gap (actual vs predicted) with a formula-bar
  // verdict. Coherence is marked across ALL bands per category before the display slice, so a
  // 3+-adjacent-band same-direction miss is trusted even when individual bands are < n200.
  const allBands = bandRows.map(r => {
    const n = Number(r.n ?? 0);
    const wins = Number(r.wins ?? 0);
    const actual = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
    const predicted = _BAND_MID[r.band] ?? null;
    const delta = actual != null && predicted != null ? parseFloat((actual - predicted).toFixed(1)) : null;
    const avgBetPct = r.avg_bet_pct != null ? parseFloat(Number(r.avg_bet_pct).toFixed(4)) : null;
    const roi = actual != null && avgBetPct != null ? parseFloat((actual / 100 - avgBetPct).toFixed(4)) : null;
    const sig = _calibSig({ n, hitRate: actual, predicted, kind: "band" });
    return {
      key: `${r.sport}|${r.category}|${r.band}`,
      sport: r.sport, category: r.category, band: r.band,
      n, actual, predicted, delta, roi, coherent: false, ...sig,
    };
  });
  _markBandCoherence(allBands);
  // A coherent run is actionable even below n200 (coherence pools n, per doctrine).
  for (const b of allBands) if (b.coherent && b.verdict === "needs_n200" && Math.abs(b.delta ?? 0) > (b.se ?? 99)) b.verdict = "actionable";
  // Per-category calibration headline (model-honesty axis) + that category's own bands, for the
  // consolidated model board (each row fuses profitability + honesty into one "Do this" action).
  const _calibByCat = _calibSummaryByCat(allBands);
  const _bandsByCat = {};
  for (const b of allBands) (_bandsByCat[`${b.sport}|${b.category}`] ??= []).push(b);
  for (const arr of Object.values(_bandsByCat)) arr.sort((a, b) => _BAND_ORDER.indexOf(a.band) - _BAND_ORDER.indexOf(b.band));
  // Sort: most data first; within same n, largest |delta| first.
  const topBands = allBands
    .sort((a, b) => b.n !== a.n ? b.n - a.n : Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 15);

  // Model board — per-category price-band profitability. This is the single gate-decision
  // surface: it slices BETTABLE plays by market price (where ROI actually lives) across the
  // full range, derives the profitable window from data, and compares it to the current 67–91.
  // The truePct calibration (categories/topBands above) is the separate "is the model honest?"
  // check — NOT a competing profitability axis (calibration ≠ profit, the totalRuns lesson).
  const _catByKey = Object.fromEntries(categories.map(c => [c.key, c]));
  // Brier head-to-head per category (Q9) — model-vs-market probability quality. skill>0 = model
  // sharper than the price; the NEGATIVE verdict forks on it (market-sharper → Stay out).
  const _brierByCat = {};
  for (const r of (brierRows || [])) {
    const mb = r.model_brier != null ? parseFloat(Number(r.model_brier).toFixed(4)) : null;
    const kb = r.market_brier != null ? parseFloat(Number(r.market_brier).toFixed(4)) : null;
    const n = Number(r.n ?? 0);
    const skill = mb != null && kb != null ? parseFloat((kb - mb).toFixed(4)) : null;
    // 95% CI lower bound on skill (paired t, normal approx). >0 = model PROVABLY sharper than
    // the price, not just a Brier tie. Gates the "Look deeper" verdict so a tie reads "no edge".
    const sd = r.skill_sd != null ? Number(r.skill_sd) : null;
    const skillSe = sd != null && n > 1 ? sd / Math.sqrt(n) : null;
    const skillLoCI = skill != null && skillSe != null ? parseFloat((skill - 1.96 * skillSe).toFixed(4)) : null;
    _brierByCat[`${r.sport}|${r.category}`] = { n, modelBrier: mb, marketBrier: kb, skill, skillLoCI };
  }
  // Learning trend (Q10) — recent-half minus early-half paired Brier skill. >0 = still learning,
  // ≈0 = saturated. `reliable` once each half clears BRIER_MIN_N (Brier is noisy below that). β* is
  // the credibility weight on the calibration gap = the honest L2 de-shrink step (200 = formula-n).
  const _LEARN_K = 200;
  const _learnByCat = {};
  for (const r of (learnRows || [])) {
    const nE = Number(r.n_early ?? 0), nR = Number(r.n_recent ?? 0);
    const sE = r.skill_early != null ? Number(r.skill_early) : null;
    const sR = r.skill_recent != null ? Number(r.skill_recent) : null;
    const trend = sE != null && sR != null ? parseFloat((sR - sE).toFixed(4)) : null;
    const total = nE + nR;
    _learnByCat[`${r.sport}|${r.category}`] = {
      skillTrend: trend,
      betaStar: total > 0 ? parseFloat((total / (total + _LEARN_K)).toFixed(3)) : null,
      reliable: Math.min(nE, nR) >= BRIER_MIN_N,
    };
  }
  const _histByCat = {};
  for (const r of (priceHistRows || [])) {
    const key = `${r.sport}|${r.category}`;
    (_histByCat[key] ??= []).push({ lo: Number(r.price_lo), n: Number(r.n), wins: Number(r.wins), avgPrice: Number(r.avg_price) });
  }
  const bettingBoard = Object.keys(_histByCat).map(key => {
    const cells = _histByCat[key];
    const [sport, category] = key.split("|");
    const totalN = cells.reduce((s, c) => s + c.n, 0);
    const bins = _priceWindowBins(cells);
    const win = _discoverPriceWindow(cells);
    const gated = _isGatedCategory(key);
    const cat = _catByKey[key];
    // Sub-window opportunity: bettable plays priced BELOW the current 67¢ floor.
    const sub = cells.filter(c => c.lo < KALSHI_GATE);
    const subN = sub.reduce((s, c) => s + c.n, 0);
    const subWins = sub.reduce((s, c) => s + c.wins, 0);
    const subPSum = sub.reduce((s, c) => s + c.avgPrice * c.n, 0);
    const subRoi = subN > 0 ? subWins / subN - (subPSum / subN) / 100 : null;
    // Over-window: bettable plays priced ABOVE the current 91¢ cap.
    const hi = cells.filter(c => c.lo >= KALSHI_CAP);
    const hiN = hi.reduce((s, c) => s + c.n, 0);
    const hiWins = hi.reduce((s, c) => s + c.wins, 0);
    const hiPSum = hi.reduce((s, c) => s + c.avgPrice * c.n, 0);
    const hiRoi = hiN > 0 ? hiWins / hiN - (hiPSum / hiN) / 100 : null;

    // Validation ladder — three explicit promotion criteria so "act now" vs "still cooking" is
    // unambiguous and selection-bias-proof (the discovered window is ROI-maximized over many
    // candidate ranges, so the aggregate ROI is upward-biased; the CI + coherence gates are what
    // make it trustworthy). PROMOTE only when ALL pass.
    const q = win ? _windowQuality(cells, win) : null;
    const checklist = win && q ? {
      nOk: win.n >= _MIN_N_PROMOTE,          // enough bettable resolved plays
      ciOk: q.roiLoCI > 0,                    // ROI 95%-CI lower bound clears 0 (beats noise + price)
      coherentOk: q.coherent,                 // both price-halves non-negative (not a lucky slice)
    } : null;
    const allReady = checklist && checklist.nOk && checklist.ciOk && checklist.coherentOk;

    let verdict, hint = null, action = null;
    if (totalN < 20 || !win) {
      verdict = "BUILDING"; hint = `n=${totalN} bettable — accruing`;
    } else if (win.roi <= 0 || (q && q.roiHiCI < 0)) {
      verdict = "NEGATIVE"; hint = "no profitable price window — stay out";
    } else if (gated) {
      // Already bet. Pull only on a SIGNIFICANTLY negative window (CI upper bound < 0).
      verdict = (q && q.roiHiCI < 0) ? "DEMOTE" : "HOLD";
    } else if (allReady) {
      verdict = "PROMOTE";
      action = `add ${category} @ ${win.lo}–${win.hi}¢ window`;
      hint = `bet ${win.lo}–${win.hi}¢ · ROI ${(win.roi * 100).toFixed(1)}% (worst case still +${(q.roiLoCI * 100).toFixed(1)}%) · n=${win.n} · profitable across the range`;
    } else {
      // Positive but not yet validated — name exactly what's missing, in plain words.
      verdict = "STRENGTHENING";
      const missing = [];
      if (!checklist.nOk) missing.push(`more bets (${win.n}/${_MIN_N_PROMOTE})`);
      if (!checklist.ciOk) missing.push("edge not proven yet — could still be luck");
      if (!checklist.coherentOk) missing.push("profit too concentrated in one price slice");
      hint = `${win.lo}–${win.hi}¢ ROI ${(win.roi * 100).toFixed(1)}% — needs: ${missing.join("; ")}`;
    }

    // The bridge: a category is bettable only if the model provably beats the price (Brier skill CI
    // lo > 0). Computed straight from the Brier row — the accuracy verdict is now calibration-based.
    const _b = _brierByCat[key];
    const eligible = _b?.skillLoCI != null && _b.skillLoCI > 0 && (_b.n || 0) >= BRIER_MIN_N;
    const doThis = _bettingAction(verdict, gated, eligible, hint);

    return {
      key, sport, category, gated, eligible, n: totalN,
      currentWindow: [KALSHI_GATE, KALSHI_CAP],
      discoveredWindow: win ? { ...win, roiLoCI: q?.roiLoCI ?? null, roiHiCI: q?.roiHiCI ?? null, coherent: q?.coherent ?? null } : null,
      checklist,
      subWindow: subRoi != null ? { roi: parseFloat(subRoi.toFixed(4)), n: subN } : null,
      overWindow: hiRoi != null ? { roi: parseFloat(hiRoi.toFixed(4)), n: hiN } : null,
      priceBands: bins,
      verdict, hint, action, doThis,
      roi: cat?.roi ?? null,
      formulaCutoff: cat?.formulaCutoff ?? null,
      daysInWindow: cat?.daysInWindow ?? null,
    };
  }).sort((a, b) => b.n - a.n);

  // ── Model ACCURACY board (Layer 1) — calibration vs reality, NO price ──
  // Verdict scored on truePct calibration (model% vs actual hit%). Brier skill is carried as the
  // secondary "vs market" signal + the betting bridge (eligible above). Keyed on the UNION of the
  // Brier and calibration populations (a category can have calib bands but no Brier row, or vice-versa).
  const _accKeys = new Set([...Object.keys(_brierByCat), ...Object.keys(_bandsByCat)]);
  const accuracyBoard = [..._accKeys].map(key => {
    const [sport, category] = key.split("|");
    const brier = _brierByCat[key] ?? { n: 0, modelBrier: null, marketBrier: null, skill: null, skillLoCI: null };
    const calib = _calibByCat[key] ?? { status: "insufficient", direction: null, delta: null, band: null, n: null };
    const verdict = _accuracyVerdict(calib, brier, _learnByCat[key]);
    const honest = _accuracyAction(verdict, calib, brier.skill, brier.n);
    // `active` = this truePct slice is in the live category gate right now. Bands are 5-wide and
    // aligned to the gate's 5-boundaries, so the band midpoint membership-tests the gate exactly.
    const calibBands = (_bandsByCat[key] || []).map(b => ({
      band: b.band, n: b.n, predicted: b.predicted, actual: b.actual, delta: b.delta, verdict: b.verdict, coherent: b.coherent,
      active: passesCategoryGate({ sport, stat: category, truePct: b.predicted }),
    }));
    return {
      key, sport, category, gated: _isGatedCategory(key),
      // Stamped so the frontend's exhaustion maps (INPUT_SEARCH_EXHAUSTED et al.) can auto-un-suppress
      // a category whose formula reset AFTER its search was exhausted (clean data re-opens the search).
      formulaCutoff: FORMULA_CUTOFFS[key] ?? null,
      n: brier.n, skill: brier.skill, skillLoCI: brier.skillLoCI,
      modelBrier: brier.modelBrier, marketBrier: brier.marketBrier,
      learning: _learnByCat[key] ?? null,
      verdict, honest, calib, calibBands,
    };
  }).sort((a, b) => (b.skill ?? -9) - (a.skill ?? -9));

  // Process CLV analysis.
  const clv = clvRows.map(r => ({
    key: `${r.sport}|${r.category}`,
    sport: r.sport, category: r.category,
    n: Number(r.n ?? 0),
    avgClvPct: r.avg_clv_pct != null ? parseFloat(Number(r.avg_clv_pct).toFixed(2)) : null,
    avgEdgeAtSnap: r.avg_edge_at_snap != null ? parseFloat(Number(r.avg_edge_at_snap).toFixed(2)) : null,
    avgEdgeAtClose: r.avg_edge_at_close != null ? parseFloat(Number(r.avg_edge_at_close).toFixed(2)) : null,
    hitRatePct: r.hit_rate_pct != null ? parseFloat(Number(r.hit_rate_pct).toFixed(1)) : null,
  }));

  // Process picks-per-game calibration + derive the optimal same-game cap.
  const perGameRoi = (perGameRows || []).map(r => ({
    multi: r.multi === true || r.multi === "t",
    rnk: Number(r.rnk ?? 0),
    n: Number(r.n ?? 0),
    hitRate: r.hit_rate != null ? parseFloat(Number(r.hit_rate).toFixed(1)) : null,
    avgPrice: r.avg_price != null ? parseFloat(Number(r.avg_price).toFixed(1)) : null,
    roiPct: r.roi_pct != null ? parseFloat(Number(r.roi_pct).toFixed(2)) : null,
  }));
  // Cap = highest within-game rank where each rank 1..k still has positive ROI (n≥10 each).
  let optimalPerGameCap = null;
  const multiRanks = perGameRoi.filter(r => r.multi && r.rnk >= 1).sort((a, b) => a.rnk - b.rnk);
  for (const r of multiRanks) {
    if (r.n >= 10 && (r.roiPct ?? -1) > 0) optimalPerGameCap = r.rnk;
    else break;
  }

  // Process data health — coverage (KV from snapshot cron) + yesterday's resolution/CLV capture.
  let dataHealth = null;
  try {
    const covKV = cache ? await cache.get(`shadow:coverage:${yesterday}`, "json").catch(() => null) : null;
    // Robust resolution read — seeded with Q6 (healthRows), cross-checked + retried against cold-wake
    // replica lag so a stale-low count can't false-flag the report incomplete (→ 15-min TTL → vanish).
    const rr = await _readResolutionRobust(yesterday, env, healthRows?.[0], cache);
    const total = rr.total, resolved = rr.resolved, scored = rr.scored;
    // CLV capture is a per-snapshot_date operation: pregame-snap stamps kalshi_yes_price_pre on the
    // rows it processed THAT day (matched against that day's live staging). Measuring it over
    // game_date=yesterday is the wrong cohort — it mixes in rows snapshotted on OTHER days (whose CLV
    // was attempted by those days' pipelines) and counts markets that never had a live pre-game window,
    // dragging the rate misleadingly low. Scope to snapshot_date=yesterday = exactly the plays
    // yesterday's pregame-snap targeted (complete by report time — the last pregame cron for game_date
    // T runs 03:00 UTC = 8pm PT on day T). Failure-closed → no CLV warning rather than a false one.
    let clvCaptured = 0, clvEligible = 0;
    try {
      const cr = await neonQuery(
        `SELECT COUNT(*) AS eligible, SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS captured
           FROM shadow_plays WHERE snapshot_date = $1`,
        [yesterday], env, { write: true }
      );
      clvEligible = Number(cr?.[0]?.eligible ?? 0);
      clvCaptured = Number(cr?.[0]?.captured ?? 0);
    } catch (e) { console.error("[shadow-report] CLV cohort read failed:", e?.message); }
    const warnings = [];
    const covWarned = !!covKV?.coverageWarning;
    if (covWarned) {
      const covStr = Object.entries(covKV.coverage || {}).map(([sp, c]) => `${sp} ${c.games}/${c.scheduled}`).join(", ");
      warnings.push(`Slate under-logged yesterday (${covStr}) — model numbers may be incomplete.`);
    }
    // Re-runnable gate (2026-06-30). A day-1 report ALWAYS shows a resolution shortfall that re-running
    // the resolver right now can't close: shadow-only soccer/tennis resolve late (event-summary / name-
    // lookup) and totals age out of the today+tomorrow live window — those rows self-heal over the next
    // 1-2 days of scheduled passes (prior days mature to ~100%), and an immediate re-run resolves ~0 of
    // them (confirmed live: trigger → resolved 0-2). So flagging `actionable` on a flat `<0.9` nagged
    // "Fix data health" every morning with nothing to DO. (A trailing-baseline anomaly check is wrong
    // too — it compares today at 1-day maturity against prior days at full maturity, so it over-flags.)
    // The ONLY case re-running now recovers is a catastrophic pass failure — a cron swallow / cold-start
    // abort (the 6/18 7/889 ≈ 0.8%) where games ARE final but the pass processed ~nothing. That lands an
    // order of magnitude below the normal ~87% day-1 floor, so a low ABSOLUTE threshold separates them
    // cleanly with wide margin. `pending` stays exposed; the warning + actionable both gate on it.
    const todayRate = total > 0 ? resolved / total : 1;
    const ACTIONABLE_RESOLVE_FLOOR = 0.5; // < this = catastrophic pass failure, not normal day-1 lag
    const resolutionFailed = total > 0 && todayRate < ACTIONABLE_RESOLVE_FLOOR;
    // Caution strip warns only on a real failure now (a normal day-1 floor is not "ROI partial").
    if (resolutionFailed) warnings.push(`Only ${resolved}/${total} of yesterday's plays resolved — re-run the resolver (ROI partial).`);
    const clvWarned = clvEligible > 0 && clvCaptured / clvEligible < 0.5;
    if (clvWarned) warnings.push(`CLV captured for only ${clvCaptured}/${clvEligible} of yesterday's snapshotted plays.`);
    // Streak escalation (2026-07-01): ONE day's coverage under-log / CLV dip is caution-only — that
    // yesterday is closed and unrecoverable, nothing to do (the rationale above). But the SAME warning
    // ≥2 days running is a different animal: a live pipeline bug (the 6/10 pregame-snap-502 shape)
    // that a fix TODAY stops from eating tonight's slate — so a streak flips `actionable`. Counter is
    // a per-report-date KV breadcrumb: read the prior day's counts, extend or reset, write under
    // today's key only when warned (a missing day-key naturally reads as a reset). Keying by report
    // date makes ?bust=1 regens idempotent. Failure-closed: a KV error just skips escalation.
    let healthStreak = null;
    try {
      if (cache) {
        const dayBefore = new Date(Date.parse(`${yesterday}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
        const prev = await cache.get(`shadow:healthstreak:${dayBefore}`, "json").catch(() => null);
        healthStreak = {
          coverage: covWarned ? 1 + Number(prev?.coverage || 0) : 0,
          clv: clvWarned ? 1 + Number(prev?.clv || 0) : 0,
        };
        if (covWarned || clvWarned)
          await cache.put(`shadow:healthstreak:${yesterday}`, JSON.stringify(healthStreak), { expirationTtl: 86400 * 4 }).catch(() => {});
      }
    } catch (e) { console.error("[shadow-report] health-streak read skipped:", e?.message); }
    const streakParts = [];
    if ((healthStreak?.coverage || 0) >= 2) streakParts.push(`coverage under-log ${healthStreak.coverage} days running`);
    if ((healthStreak?.clv || 0) >= 2) streakParts.push(`CLV capture failing ${healthStreak.clv} days running`);
    if (streakParts.length) warnings.push(`Repeated data-health failure (${streakParts.join("; ")}) — a live pipeline bug, not one-day noise. Investigate the ${(healthStreak?.coverage || 0) >= 2 ? "snapshot/coverage" : "pregame-snap"} path today.`);
    // `actionable` = is there a data-health issue you can DO something about today? A catastrophic
    // resolution failure qualifies (a warm re-run recovers it), and so does a ≥2-day coverage/CLV
    // streak (a live bug a fix today stops from repeating). A single day-1 self-healing lag, coverage
    // under-log, or CLV dip is about a now-closed yesterday and unrecoverable-by-action, so it stays
    // caution-only (the ⚠ strip), NOT a "Do this today" action. The frontend's tier-1 banner fires only
    // when this is true so it never promotes an unfixable/self-healing caution into the day's primary to-do.
    dataHealth = {
      coverage: covKV?.coverage ?? null,
      coverageWarning: covKV?.coverageWarning ?? null,
      resolution: {
        total, resolved, scored, pending: Math.max(0, total - resolved),
        ratePct: total > 0 ? parseFloat((todayRate * 100).toFixed(0)) : null,
        failed: resolutionFailed,
      },
      clvCapture: { captured: clvCaptured, eligible: clvEligible, pct: clvEligible > 0 ? parseFloat((clvCaptured / clvEligible * 100).toFixed(0)) : null },
      streak: healthStreak,
      warnings,
      actionable: resolutionFailed || streakParts.length > 0,
    };
  } catch (e) {
    console.error("[shadow-report] dataHealth skipped:", e?.message);
  }

  // Process daily volume ROI + derive optimal picks/day recommendation.
  const dailyVolumeRoi = volRows.map(r => ({
    picksBucket: r.picks_bucket,
    nDays: Number(r.n_days ?? 0),
    totalPlays: Number(r.total_plays ?? 0),
    avgPlays: r.avg_plays != null ? parseFloat(Number(r.avg_plays).toFixed(1)) : null,
    hitRatePct: r.hit_rate_pct != null ? parseFloat(Number(r.hit_rate_pct).toFixed(1)) : null,
    avgPricePct: r.avg_price_pct != null ? parseFloat(Number(r.avg_price_pct).toFixed(1)) : null,
    roi: r.roi != null ? parseFloat(Number(r.roi).toFixed(4)) : null,
  }));

  // Derive optimal picks/day from buckets with at least 3 sample days.
  let optimalDailyPicks = null;
  const eligible = dailyVolumeRoi.filter(r => r.nDays >= 3);
  if (eligible.length > 0) {
    const best = eligible.reduce((a, b) => ((b.roi ?? -Infinity) > (a.roi ?? -Infinity) ? b : a));
    // First bucket (sorted ascending) where ROI turns negative — stop before it.
    const firstNeg = dailyVolumeRoi.find(r => r.nDays >= 3 && (r.roi ?? 0) < 0);
    optimalDailyPicks = {
      bucket: best.picksBucket,
      roi: best.roi,
      nDays: best.nDays,
      stopAt: firstNeg?.picksBucket ?? null,
      confidence: eligible.some(r => r.nDays >= 10) ? "medium" : "low",
    };
  }

  // Process today's top picks.
  const topPicks = picksRows.map(r => ({
    sport: r.sport,
    category: r.category,
    playerName: r.player_name ?? null,
    homeTeam: r.home_team ?? null,
    awayTeam: r.away_team ?? null,
    pickTeam: r.pick_team ?? null,
    direction: r.direction ?? null,
    threshold: r.threshold != null ? parseFloat(Number(r.threshold).toFixed(1)) : null,
    pickLine: r.pick_line != null ? parseFloat(Number(r.pick_line).toFixed(1)) : null,
    modelTruePct: r.model_true_pct != null ? parseFloat(Number(r.model_true_pct).toFixed(1)) : null,
    marketPct: r.market_pct != null ? parseFloat(Number(r.market_pct).toFixed(1)) : null,
    edge: r.edge != null ? parseFloat(Number(r.edge).toFixed(2)) : null,
    gameTime: r.game_time ?? null,
  }));

  // Newly-listed Kalshi markets we don't consume yet (status='new' in kalshi_series_seen,
  // populated by the /api/kalshi-series-scan cron). Separate try/catch — the table may not
  // exist yet on first deploy, and a discovery miss must never break the briefing.
  // `new` = detected (un-triaged); `shortlisted` = promoted, being vetted. Both carry the
  // triage-hint columns (live_market_count + window_fit) the series-scan cron refreshes daily.
  const queryDiscovered = async (status) => {
    try {
      const rows = await neonQuery(`
        SELECT ticker, title, tags, frequency, sample_market, sample_subtitle,
               live_market_count, window_fit, first_seen
        FROM kalshi_series_seen WHERE status = $1
        ORDER BY first_seen DESC, ticker LIMIT 25
      `, [status], env, { write: true });
      return rows.map(r => ({
        ticker: r.ticker,
        title: r.title ?? null,
        tags: r.tags ?? null,
        frequency: r.frequency ?? null,
        sampleMarket: r.sample_market ?? null,
        sampleSubtitle: r.sample_subtitle ?? null,
        liveMarketCount: r.live_market_count ?? null,
        windowFit: r.window_fit ?? null,
        firstSeen: r.first_seen ? new Date(r.first_seen).toISOString().slice(0, 10) : null,
      }));
    } catch (e) {
      console.error(`[shadow-report] ${status} markets query skipped:`, e?.message);
      return [];
    }
  };
  // Polymarket league funnel (polymarket_sports_seen, populated by /api/polymarket-scan) merges
  // into the SAME newMarkets/shortlistedMarkets arrays: `ticker` = Gamma sport slug (can't collide
  // with KX* series tickers or SERIES_CONFIG), venue:"polymarket". One display chokepoint — the
  // ReportPage triage/shortlist banners and the brief's fresh-detection diff (both keyed on
  // m.ticker / m.title) pick these up with no frontend change.
  const queryPolyDiscovered = async (status) => {
    try {
      const rows = await neonQuery(`
        SELECT sport, series_id, sample_event, live_event_count, market_types, first_seen
        FROM polymarket_sports_seen WHERE status = $1
        ORDER BY first_seen DESC, sport LIMIT 25
      `, [status], env, { write: true });
      return rows.map(r => ({
        venue: "polymarket",
        ticker: r.sport,
        title: `Polymarket league: ${r.sport}`,
        tags: r.market_types ?? null,
        frequency: null,
        sampleMarket: r.series_id != null ? `series ${r.series_id}` : null,
        sampleSubtitle: r.sample_event ?? null,
        liveMarketCount: r.live_event_count ?? null,
        windowFit: null,
        firstSeen: r.first_seen ? new Date(r.first_seen).toISOString().slice(0, 10) : null,
      }));
    } catch (e) {
      console.error(`[shadow-report] poly ${status} markets query skipped:`, e?.message);
      return [];
    }
  };
  const [kNewMarkets, kShortlistedMarkets, pNewMarkets, pShortlistedMarkets] = await Promise.all([
    queryDiscovered("new"),
    queryDiscovered("shortlisted"),
    queryPolyDiscovered("new"),
    queryPolyDiscovered("shortlisted"),
  ]);
  const newMarkets = [...kNewMarkets, ...pNewMarkets];
  const shortlistedMarkets = [...kShortlistedMarkets, ...pShortlistedMarkets];

  // Cross-venue kill-gate (sportsbook reference): does Kalshi systematically LAG the de-vigged sharp
  // book? Live read of the sportsbook_deltas accrual over the bettable in-window [67,91] band, so
  // /model + the Do-This banner reflect the actual answer (not a static date reminder). delta_cents =
  // bookFair − kalshi, so mean_signed > 0 = Kalshi cheap vs the book = the lag edge. Failure-closed.
  let sportsbookValidation = null;
  try {
    const _SB_DAYS = 7;
    // The kill-gate metric is the BUY-EDGE FREQUENCY: how often a Kalshi side is CHEAP vs the
    // de-vigged sharp book (delta_cents = bookFair − kalshi ≥ +3 = a ≥3¢ buy). NOT mean(delta): both
    // sides of a game are mirror images, so mean(delta) ≈ −(Kalshi overround), not lag. NOT |delta|:
    // that counts the expensive side you'd never buy. No [67,91] restriction — the cross-venue edge
    // is "buy the cheap side", not bounded by the prop model window. All rows are liquidity-gated at
    // emit, so this is the traded-line population.
    const [agg] = await neonQuery(`
      SELECT count(*)::int AS n, count(distinct snapshot_date)::int AS days,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        avg(CASE WHEN delta_cents >= 3 THEN 1.0 ELSE 0 END) AS frac_buy3,
        avg(CASE WHEN delta_cents >= 5 THEN 1.0 ELSE 0 END) AS frac_buy5
      FROM ${SB_DELTAS_TABLE}
      WHERE snapshot_date >= CURRENT_DATE - $1::int`, [_SB_DAYS], env, { write: true });
    const n = Number(agg?.n || 0), days = Number(agg?.days || 0);
    const medianAbs = agg?.median_abs != null ? parseFloat(Number(agg.median_abs).toFixed(2)) : null;
    const fracBuyEdge3 = agg?.frac_buy3 != null ? parseFloat(Number(agg.frac_buy3).toFixed(3)) : null;
    const fracBuyEdge5 = agg?.frac_buy5 != null ? parseFloat(Number(agg.frac_buy5).toFixed(3)) : null;
    // Verdict ladder (kill-gate CLOSED 2026-07-04 — TIGHT confirmed on clean data, Phase 1b
    // killed; the ladder now feeds the tripwire readouts, not a build decision):
    //   ACCRUING — too little to read (n<60 sides ≈ <30 games, or <3 days).
    //   GAP      — Kalshi is cheap vs the book ≥3¢ on ≥10% of traded sides → post-kill this means
    //              regime change OR artifact — audit the ?minAbs=3 tail first (both prior fat
    //              tails were fake), don't resurrect Phase 1b off one window.
    //   TIGHT    — venues track → no liquid lag edge (the confirmed steady state).
    let verdict;
    if (n < 60 || days < 3) verdict = "ACCRUING";
    else if ((fracBuyEdge3 ?? 0) >= 0.10) verdict = "GAP";
    else verdict = "TIGHT";
    sportsbookValidation = { n, days, windowDays: _SB_DAYS, medianAbs, fracBuyEdge3, fracBuyEdge5, verdict };
  } catch (e) { console.error("[shadow-report] sportsbook validation skipped:", e?.message); }

  // Cross-venue kill-gate (Polymarket): same read over polymarket_deltas, so the daily brief covers
  // BOTH observatories (before this the report only carried the sportsbook one — the Poly answer
  // lived solely in /api/polymarket-deltas). Adds the Phase-1b executable read: exec_delta_cents =
  // polyVWAP − kalshi, so ≤−3 = still ≥3¢ cheaper to BUY on Poly after walking the book = the
  // surviving edge. Verdict ladder mirrors the sportsbook one. Failure-closed.
  let polymarketValidation = null;
  try {
    const _PM_DAYS = 7;
    const [agg] = await neonQuery(`
      SELECT count(*)::int AS n, count(distinct snapshot_date)::int AS days,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        avg(CASE WHEN delta_cents >= 3 THEN 1.0 ELSE 0 END) AS frac_buy3,
        avg(CASE WHEN delta_cents >= 5 THEN 1.0 ELSE 0 END) AS frac_buy5,
        count(exec_delta_cents)::int AS exec_n,
        avg(CASE WHEN exec_delta_cents <= -3 THEN 1.0 ELSE 0 END)
          FILTER (WHERE exec_delta_cents IS NOT NULL) AS exec_frac3
      FROM ${POLY_DELTAS_TABLE}
      WHERE snapshot_date >= CURRENT_DATE - $1::int`, [_PM_DAYS], env, { write: true });
    const n = Number(agg?.n || 0), days = Number(agg?.days || 0);
    const medianAbs = agg?.median_abs != null ? parseFloat(Number(agg.median_abs).toFixed(2)) : null;
    const fracBuyEdge3 = agg?.frac_buy3 != null ? parseFloat(Number(agg.frac_buy3).toFixed(3)) : null;
    const fracBuyEdge5 = agg?.frac_buy5 != null ? parseFloat(Number(agg.frac_buy5).toFixed(3)) : null;
    const execN = Number(agg?.exec_n || 0);
    const execFracEdge3 = agg?.exec_frac3 != null ? parseFloat(Number(agg.exec_frac3).toFixed(3)) : null;
    let verdict;
    if (n < 60 || days < 3) verdict = "ACCRUING";
    else if ((fracBuyEdge3 ?? 0) >= 0.10) verdict = "GAP";
    else verdict = "TIGHT";
    polymarketValidation = { n, days, windowDays: _PM_DAYS, medianAbs, fracBuyEdge3, fracBuyEdge5, execN, execFracEdge3, verdict };
  } catch (e) { console.error("[shadow-report] polymarket validation skipped:", e?.message); }

  const report = {
    reportDate,
    generatedAt: new Date().toISOString(),
    since,
    dataHealth,
    topPicks,
    accuracyBoard,
    bettingBoard,
    categories,
    topBands,
    clv,
    perGameRoi,
    optimalPerGameCap,
    dailyVolumeRoi,
    optimalDailyPicks,
    newMarkets,
    shortlistedMarkets,
    sportsbookValidation,
    polymarketValidation,
    durationMs: Date.now() - t0,
  };

  // Daily brief — deterministic prose synthesis of the boards + both cross-venue observatories,
  // diffed against yesterday's cached report (still alive at cron time: 25h TTL, cron 6am). Additive
  // + failure-closed: any error → brief stays null and the page falls back to the raw boards.
  report.brief = null;
  try {
    const prior = cache ? await cache.get(`${REPORT_CACHE_KEY_PREFIX}${yesterday}`, "json").catch(() => null) : null;
    report.brief = _buildDailyBrief(report, prior);
  } catch (e) { console.error("[shadow-report] brief skipped:", e?.message); }

  const res = dataHealth?.resolution;
  const incomplete = res && res.total > 0 && (res.resolved / res.total) < 0.9;
  const ttl = incomplete ? INCOMPLETE_REPORT_TTL : REPORT_TTL;
  if (cache) cache.put(cacheKey, JSON.stringify(report), { expirationTtl: ttl }).catch(() => {});
  return jsonResponse(report);
}

// ── /api/routine-note ───────────────────────────────────────────────────────
// A tiny KV scratchpad so cloud routines (claude.ai code triggers) can hand their
// summary back to a dev box that CANNOT reach Kalshi/Neon directly but CAN reach
// this production API. WRITE is gated by a dedicated low-privilege ROUTINE_NOTE_TOKEN
// (so a routine's prompt config never carries ADMIN_KEY); READ is gated by ADMIN_KEY/JWT.
// Stores `routine:note:{slug}` = {text, writtenAt} for 14d.
async function handleRoutineNote({ path, request, env, cache }) {
  if (path !== "routine-note") return null;
  if (!cache) return errorResponse("No KV", 500);
  const method = (request.method || "GET").toUpperCase();
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const NOTE_TTL = 14 * 24 * 3600;

  if (method === "POST") {
    if (!env?.ROUTINE_NOTE_TOKEN || bearer !== env.ROUTINE_NOTE_TOKEN) return errorResponse("Forbidden", 403);
    let body;
    try { body = await request.json(); } catch { return errorResponse("Bad JSON", 400); }
    const slug = String(body?.slug || "").trim().replace(/[^\w.-]/g, "").slice(0, 80);
    const text = typeof body?.text === "string" ? body.text.slice(0, 100_000) : null;
    if (!slug || text == null) return errorResponse("slug + text required", 400);
    const writtenAt = new Date().toISOString();
    await cache.put(`routine:note:${slug}`, { text, writtenAt }, { expirationTtl: NOTE_TTL });
    return jsonResponse({ ok: true, slug, writtenAt, bytes: text.length });
  }

  // GET — read one note (ADMIN_KEY/JWT).
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;
  let isUser = false;
  if (!isAdmin && env?.JWT_SECRET) {
    try { isUser = !!(await verifyJWT(bearer, env.JWT_SECRET)); } catch { isUser = false; }
  }
  if (!isAdmin && !isUser) return errorResponse("Forbidden", 403);
  const slug = String(new URL(request.url).searchParams.get("slug") || "").trim().replace(/[^\w.-]/g, "");
  if (!slug) return errorResponse("slug required", 400);
  const note = await cache.get(`routine:note:${slug}`, "json").catch(() => null);
  if (!note) return jsonResponse({ ok: true, slug, found: false, text: null });
  return jsonResponse({ ok: true, slug, found: true, ...note });
}

// ── /api/polymarket-scan ─────────────────────────────────────────────────────
// Daily cron. Diffs Polymarket's Gamma league catalog (GET /sports, ~300 rows) against the
// leagues the observatory consumes (POLY_SERIES) and records unknown ones in Neon
// (polymarket_sports_seen) — the Polymarket mirror of /api/kalshi-series-scan, same status
// funnel (baseline → new → shortlisted → adopted/dismissed). The FIRST run baseline-seeds every
// currently-listed league (silently acknowledged); only leagues Gamma adds AFTER today surface
// as 'new'. Per-league enrichment records the distinct sportsMarketType families seen in live
// events — that's where a new market family (e.g. total-corners) shows up, not a new funnel.
// Auth: CRON_SECRET (cron) or ADMIN_KEY (manual). ?dry=1 skips all DB writes.
// ?dismiss= / ?undismiss= / ?promote= / ?unpromote= (admin) triage by Gamma sport slug.
const POLY_SPORTS_TABLE = "polymarket_sports_seen";
async function handlePolymarketScan({ path, request, env }) {
  if (path !== "polymarket-scan") return null;
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isCron  = env?.CRON_SECRET && bearer === env.CRON_SECRET;
  const isAdmin = env?.ADMIN_KEY  && bearer === env.ADMIN_KEY;
  if (!isCron && !isAdmin) return errorResponse("Forbidden", 403);
  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);
  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";

  await neonExec(`
    CREATE TABLE IF NOT EXISTS ${POLY_SPORTS_TABLE} (
      sport            TEXT PRIMARY KEY,
      series_id        TEXT,
      tags             TEXT,
      sample_event     TEXT,
      live_event_count INT,
      market_types     TEXT,
      status           TEXT NOT NULL DEFAULT 'new',
      first_seen       DATE NOT NULL,
      last_seen        DATE NOT NULL
    )
  `, env);

  // Admin triage shortcuts (mirror of kalshi-series-scan; keyed by Gamma sport slug).
  const dismiss = url.searchParams.get("dismiss");
  const undismiss = url.searchParams.get("undismiss");
  const promote = url.searchParams.get("promote");
  const unpromote = url.searchParams.get("unpromote");
  if (dismiss || undismiss || promote || unpromote) {
    if (!isAdmin) return errorResponse("Admin only", 403);
    if (dismiss) await neonQuery(`UPDATE ${POLY_SPORTS_TABLE} SET status='dismissed' WHERE sport = $1`, [dismiss], env, { write: true });
    if (undismiss) await neonQuery(`UPDATE ${POLY_SPORTS_TABLE} SET status='new' WHERE sport = $1 AND status='dismissed'`, [undismiss], env, { write: true });
    if (promote) await neonQuery(`UPDATE ${POLY_SPORTS_TABLE} SET status='shortlisted' WHERE sport = $1 AND status IN ('new','dismissed','baseline')`, [promote], env, { write: true });
    if (unpromote) await neonQuery(`UPDATE ${POLY_SPORTS_TABLE} SET status='new' WHERE sport = $1 AND status='shortlisted'`, [unpromote], env, { write: true });
    return jsonResponse({ ok: true, dismissed: dismiss || null, undismissed: undismiss || null, promoted: promote || null, unpromoted: unpromote || null });
  }

  // 1. League catalog (single call; module is failure-closed to []).
  const catalog = await fetchPolySportsCatalog();
  if (!catalog.length) return errorResponse("Empty Gamma sports catalog", 502);

  // 2. Leagues the observatory consumes (slug or Gamma series id — both count as known).
  const knownSlugs = new Set(Object.keys(POLY_SERIES));
  const knownSeriesIds = new Set(Object.values(POLY_SERIES).map(String));

  // 3. Slugs already recorded. {write:true} → pooled primary for read-after-create consistency.
  const existingRows = await neonQuery(`SELECT sport FROM ${POLY_SPORTS_TABLE}`, [], env, { write: true });
  const existing = new Set(existingRows.map(r => r.sport));
  const isFirstRun = existing.size === 0;

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  // 4. Classify slugs new to the table (the catalog can repeat a slug — first row wins).
  const seen = new Set();
  const toInsert = [];
  const enrichTargets = [];
  for (const s of catalog) {
    const slug = String(s.sport || "").toLowerCase();
    if (!slug || seen.has(slug) || existing.has(slug)) continue;
    seen.add(slug);
    const isKnown = knownSlugs.has(slug) || knownSeriesIds.has(String(s.series ?? ""));
    const status = isKnown ? "adopted" : (isFirstRun ? "baseline" : "new");
    const row = {
      sport: slug,
      series_id: s.series != null ? String(s.series) : null,
      tags: s.tags != null ? String(s.tags) : null,
      sample_event: null, live_event_count: null, market_types: null,
      status, first_seen: today, last_seen: today,
    };
    toInsert.push(row);
    if (status === "new") enrichTargets.push(row);
  }

  // Enrich one league: sample event + live event count + distinct market families. Best-effort;
  // null on fetch failure (never overwrites a prior read with a fake zero).
  const enrichPolySport = async (seriesId) => {
    if (!seriesId) return null;
    const events = await fetchPolySeriesEvents(seriesId, 25);
    if (!events) return null;
    const types = new Set();
    for (const ev of events) for (const m of (ev?.markets || [])) if (m?.sportsMarketType) types.add(m.sportsMarketType);
    return {
      sample_event: events[0]?.title ?? null,
      live_event_count: events.length,
      market_types: types.size ? [...types].sort().join(",") : null,
    };
  };
  const mapPool = async (items, concurrency, fn) => {
    let i = 0;
    const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  };

  // 5. Enrich genuinely-new rows (capped, parallel, best-effort).
  const ENRICH_CAP = 25;
  await mapPool(enrichTargets.slice(0, ENRICH_CAP), 3, async (row) => {
    const e = await enrichPolySport(row.series_id);
    if (e) Object.assign(row, e);
  });

  if (dry) {
    return jsonResponse({
      ok: true, dry: true, isFirstRun,
      catalogCount: catalog.length, existingCount: existing.size,
      toInsertCount: toInsert.length, newCount: enrichTargets.length,
      newMarkets: enrichTargets.slice(0, ENRICH_CAP).map(r => ({ sport: r.sport, sampleEvent: r.sample_event, marketTypes: r.market_types })),
    });
  }

  // 6a. Batch-insert new-to-table rows.
  const COLS = ["sport","series_id","tags","sample_event","live_event_count","market_types","status","first_seen","last_seen"];
  for (let i = 0; i < toInsert.length; i += 100) {
    const chunk = toInsert.slice(i, i + 100);
    const placeholders = chunk.map((_, ri) =>
      `(${COLS.map((_, ci) => `$${ri * COLS.length + ci + 1}`).join(", ")})`
    ).join(", ");
    const values = chunk.flatMap(row => COLS.map(c => row[c] ?? null));
    await neonQuery(
      `INSERT INTO ${POLY_SPORTS_TABLE} (${COLS.join(", ")}) VALUES ${placeholders} ON CONFLICT (sport) DO NOTHING`,
      values, env, { write: true }
    );
  }

  // 6b. Reconcile: slug since added to POLY_SERIES → adopted; vetted-and-rejected in code
  // (POLY_DISMISSED_SPORTS) → dismissed. Same self-clearing funnel as the Kalshi scan.
  const knownArr = [...knownSlugs];
  const knownPh = knownArr.map((_, i) => `$${i + 1}`).join(", ");
  await neonQuery(
    `UPDATE ${POLY_SPORTS_TABLE} SET status='adopted' WHERE status IN ('new','shortlisted') AND sport IN (${knownPh})`,
    knownArr, env, { write: true }
  );
  if (POLY_DISMISSED_SPORTS.length) {
    const dismPh = POLY_DISMISSED_SPORTS.map((_, i) => `$${i + 1}`).join(", ");
    await neonQuery(
      `UPDATE ${POLY_SPORTS_TABLE} SET status='dismissed' WHERE status IN ('new','shortlisted') AND sport IN (${dismPh})`,
      [...POLY_DISMISSED_SPORTS], env, { write: true }
    );
  }

  // 6c. Refresh enrichment for existing new/shortlisted rows so triage hints track current
  // liquidity, not first-seen (first_seen DESC matches the report's display order). Best-effort.
  const refreshRows = await neonQuery(
    `SELECT sport, series_id FROM ${POLY_SPORTS_TABLE} WHERE status IN ('new','shortlisted')
     ORDER BY first_seen DESC, sport LIMIT 60`,
    [], env, { write: true }
  );
  await mapPool(refreshRows, 3, async (r) => {
    const e = await enrichPolySport(r.series_id);
    if (e) await neonQuery(
      `UPDATE ${POLY_SPORTS_TABLE} SET sample_event=$2, live_event_count=$3, market_types=$4 WHERE sport = $1`,
      [r.sport, e.sample_event, e.live_event_count, e.market_types], env, { write: true }
    );
  });

  return jsonResponse({
    ok: true, isFirstRun, catalogCount: catalog.length,
    inserted: toInsert.length, newCount: enrichTargets.length, refreshed: refreshRows.length,
    newSports: enrichTargets.map(r => r.sport),
  });
}

// GET /api/polymarket-deltas — multi-day Kalshi-vs-Polymarket ML divergence distribution (Phase 1a
// observatory read). The kill-gate surface: does the gap persist + cluster, or is it noise? Auth:
// ADMIN_KEY or valid JWT. Params: ?days=N (default 30) ?sport=. Returns overall + in-window [67,91]
// + per-sport + a daily series. delta_cents = poly − kalshi (mean_signed = systematic venue bias).
async function handlePolymarketDeltas({ path, request, env }) {
  if (path !== "polymarket-deltas") return null;
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;
  let isUser = false;
  if (!isAdmin && bearer) { try { isUser = !!(await verifyJWT(bearer, env?.JWT_SECRET)); } catch {} }
  if (!isAdmin && !isUser) return errorResponse("Forbidden", 403);
  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1), 365);
  const sport = url.searchParams.get("sport");
  const sportFilter = sport ? " AND sport = $2" : "";
  const params = sport ? [days, sport] : [days];
  const num = (x) => x == null ? null : Number(Number(x).toFixed(3));

  const aggSql = (extra) => `
    SELECT count(*)::int AS n, count(distinct snapshot_date)::int AS days,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(delta_cents)) AS p90_abs,
      max(abs(delta_cents)) AS max_abs, avg(delta_cents) AS mean_signed,
      avg(CASE WHEN abs(delta_cents) >= 5 THEN 1.0 ELSE 0 END) AS frac_ge5,
      avg(CASE WHEN abs(delta_cents) >= 3 THEN 1.0 ELSE 0 END) AS frac_ge3
    FROM ${POLY_DELTAS_TABLE}
    WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}${extra}`;
  const fmtAgg = (r) => r ? {
    n: r.n, days: r.days, medianAbs: num(r.median_abs), p90Abs: num(r.p90_abs), maxAbs: num(r.max_abs),
    meanSigned: num(r.mean_signed), fracGe5c: num(r.frac_ge5), fracGe3c: num(r.frac_ge3),
  } : null;

  try {
    const [overall] = await neonQuery(aggSql(""), params, env, { write: true });
    const [inWindow] = await neonQuery(aggSql(" AND kalshi_pct >= 67 AND kalshi_pct <= 91"), params, env, { write: true });
    const bySport = await neonQuery(`
      SELECT sport, count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        max(abs(delta_cents)) AS max_abs, avg(delta_cents) AS mean_signed
      FROM ${POLY_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
      GROUP BY sport ORDER BY n DESC`, params, env, { write: true });
    const daily = await neonQuery(`
      SELECT snapshot_date, count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs
      FROM ${POLY_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
      GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 30`, params, env, { write: true });
    // Executable read (book-walked bettable sides). exec_delta = poly_vwap − kalshi; ≤−3 means
    // Polymarket is still ≥3¢ cheaper to BUY after slippage = surviving edge. THIS is the kill-gate.
    const [exec] = await neonQuery(`
      SELECT count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(exec_delta_cents)) AS median_abs,
        avg(exec_delta_cents) AS mean_signed,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY poly_slip_cents) AS median_slip,
        avg(CASE WHEN exec_delta_cents <= -3 THEN 1.0 ELSE 0 END) AS frac_edge3,
        avg(CASE WHEN exec_delta_cents <= -5 THEN 1.0 ELSE 0 END) AS frac_edge5
      FROM ${POLY_DELTAS_TABLE}
      WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter} AND exec_delta_cents IS NOT NULL`, params, env, { write: true });

    // ?execrows=1 (ADMIN) — raw exec-row tail + per-day walk coverage, for auditing the executable
    // read (mirrors sportsbook-deltas' ?minAbs= row dump). inBandTargets counts the rows
    // enrichDeltasWithExec would target ([67,91] on either venue) so cap/token/book losses show.
    let execRows = null, execDaily = null;
    if (url.searchParams.get("execrows") && isAdmin) {
      execRows = (await neonQuery(`
        SELECT snapshot_date, sport, game, side, kalshi_pct, poly_pct, delta_cents,
               poly_vwap_pct, poly_slip_cents, exec_delta_cents
        FROM ${POLY_DELTAS_TABLE}
        WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter} AND exec_delta_cents IS NOT NULL
        ORDER BY exec_delta_cents ASC LIMIT 200`, params, env, { write: true }))
        .map(r => ({
          date: new Date(r.snapshot_date).toISOString().slice(0, 10), sport: r.sport, game: r.game,
          side: r.side, kalshiPct: num(r.kalshi_pct), polyPct: num(r.poly_pct),
          deltaCents: num(r.delta_cents), polyVwapPct: num(r.poly_vwap_pct),
          polySlipCents: num(r.poly_slip_cents), execDeltaCents: num(r.exec_delta_cents),
        }));
      execDaily = (await neonQuery(`
        SELECT snapshot_date, count(*)::int AS inband, count(exec_delta_cents)::int AS walked
        FROM ${POLY_DELTAS_TABLE}
        WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter} AND market = 'ml'
          AND ((kalshi_pct BETWEEN 67 AND 91) OR (poly_pct BETWEEN 67 AND 91)) AND poly_pct > 0
        GROUP BY snapshot_date ORDER BY snapshot_date DESC`, params, env, { write: true }))
        .map(r => ({
          date: new Date(r.snapshot_date).toISOString().slice(0, 10),
          inBandTargets: r.inband, walked: r.walked,
        }));
    }

    return jsonResponse({
      ok: true, days, sport: sport || "all",
      overall: fmtAgg(overall),
      inWindow6791: fmtAgg(inWindow),
      exec: exec ? {
        n: exec.n, medianAbs: num(exec.median_abs), meanSigned: num(exec.mean_signed),
        medianSlipCents: num(exec.median_slip), fracEdgeGe3c: num(exec.frac_edge3), fracEdgeGe5c: num(exec.frac_edge5),
      } : null,
      bySport: bySport.map(r => ({ sport: r.sport, n: r.n, medianAbs: num(r.median_abs), maxAbs: num(r.max_abs), meanSigned: num(r.mean_signed) })),
      daily: daily.map(r => ({ date: new Date(r.snapshot_date).toISOString().slice(0, 10), n: r.n, medianAbs: num(r.median_abs) })),
      ...(execRows ? { execRows, execDaily } : {}),
    });
  } catch (e) {
    return errorResponse(`polymarket-deltas query failed: ${e?.message}`, 500);
  }
}

// GET /api/sportsbook-deltas — multi-day Kalshi-vs-sharp-book ML divergence distribution (Phase 1a
// observatory read). THE kill-gate surface: does Kalshi systematically LAG the de-vigged sharp book
// (a timeable edge), or track it (no edge)? Auth: ADMIN_KEY or JWT. Params: ?days=N (default 30)
// ?sport=. ?minAbs=N adds a `rows` tail dump (|delta| ≥ N¢, biggest first, LIMIT 200) for auditing
// outliers — a huge delta on a liquid ML is either a game-matching bug or a real thin-market signal.
// ?purge=all (ADMIN only) wipes the table for a clean re-baseline after a data-quality fix.
// delta_cents = book_fair − kalshi; mean_signed > 0 = Kalshi systematically cheap vs the
// book (the directional edge); frac_ge3c/5c = how often the gap is actionable-sized.
async function handleSportsbookDeltas({ path, request, env }) {
  if (path !== "sportsbook-deltas") return null;
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;
  let isUser = false;
  if (!isAdmin && bearer) { try { isUser = !!(await verifyJWT(bearer, env?.JWT_SECRET)); } catch {} }
  if (!isAdmin && !isUser) return errorResponse("Forbidden", 403);
  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const url = new URL(request.url);

  // ?purge=all — wipe the observatory table for a clean re-baseline (ADMIN key only, not JWT).
  // Used 2026-07-01: the first 3 days were contaminated by the UTC-date/±1-day series mismatch.
  if (url.searchParams.get("purge") === "all") {
    if (!isAdmin) return errorResponse("Forbidden", 403);
    try {
      await neonQuery(`DELETE FROM ${SB_DELTAS_TABLE}`, [], env, { write: true });
      return jsonResponse({ ok: true, purged: true });
    } catch (e) { return errorResponse(`purge failed: ${e?.message}`, 500); }
  }

  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1), 365);
  const sport = url.searchParams.get("sport");
  const sportFilter = sport ? " AND sport = $2" : "";
  const params = sport ? [days, sport] : [days];
  const num = (x) => x == null ? null : Number(Number(x).toFixed(3));

  const aggSql = (extra) => `
    SELECT count(*)::int AS n, count(distinct snapshot_date)::int AS days,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(delta_cents)) AS p90_abs,
      max(abs(delta_cents)) AS max_abs, avg(delta_cents) AS mean_signed,
      avg(CASE WHEN abs(delta_cents) >= 5 THEN 1.0 ELSE 0 END) AS frac_ge5,
      avg(CASE WHEN abs(delta_cents) >= 3 THEN 1.0 ELSE 0 END) AS frac_ge3
    FROM ${SB_DELTAS_TABLE}
    WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}${extra}`;
  const minAbsRaw = parseFloat(url.searchParams.get("minAbs"));
  const minAbs = Number.isFinite(minAbsRaw) && minAbsRaw >= 0 ? minAbsRaw : null;
  const fmtAgg = (r) => r ? {
    n: r.n, days: r.days, medianAbs: num(r.median_abs), p90Abs: num(r.p90_abs), maxAbs: num(r.max_abs),
    meanSigned: num(r.mean_signed), fracGe5c: num(r.frac_ge5), fracGe3c: num(r.frac_ge3),
  } : null;

  try {
    const [overall] = await neonQuery(aggSql(""), params, env, { write: true });
    const [inWindow] = await neonQuery(aggSql(" AND kalshi_pct >= 67 AND kalshi_pct <= 91"), params, env, { write: true });
    const bySport = await neonQuery(`
      SELECT sport, count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        max(abs(delta_cents)) AS max_abs, avg(delta_cents) AS mean_signed
      FROM ${SB_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
      GROUP BY sport ORDER BY n DESC`, params, env, { write: true });
    const daily = await neonQuery(`
      SELECT snapshot_date, count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(delta_cents)) AS median_abs,
        avg(delta_cents) AS mean_signed
      FROM ${SB_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
      GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 30`, params, env, { write: true });
    const tailRows = minAbs == null ? null : await neonQuery(`
      SELECT snapshot_date, sport, game, game_date, market, side,
        kalshi_pct, book_fair_pct, delta_cents, book, model_true_pct
      FROM ${SB_DELTAS_TABLE} WHERE snapshot_date >= CURRENT_DATE - $1::int${sportFilter}
        AND abs(delta_cents) >= $${params.length + 1}
      ORDER BY abs(delta_cents) DESC LIMIT 200`, [...params, minAbs], env, { write: true });

    return jsonResponse({
      ok: true, days, sport: sport || "all",
      overall: fmtAgg(overall),
      inWindow6791: fmtAgg(inWindow),
      bySport: bySport.map(r => ({ sport: r.sport, n: r.n, medianAbs: num(r.median_abs), maxAbs: num(r.max_abs), meanSigned: num(r.mean_signed) })),
      daily: daily.map(r => ({ date: new Date(r.snapshot_date).toISOString().slice(0, 10), n: r.n, medianAbs: num(r.median_abs), meanSigned: num(r.mean_signed) })),
      ...(tailRows ? { minAbs, rows: tailRows.map(r => ({
        date: new Date(r.snapshot_date).toISOString().slice(0, 10), sport: r.sport, game: r.game,
        gameDate: r.game_date, market: r.market, side: r.side, kalshiPct: num(r.kalshi_pct),
        bookFairPct: num(r.book_fair_pct), deltaCents: num(r.delta_cents), book: r.book,
        modelTruePct: num(r.model_true_pct),
      })) } : {}),
    });
  } catch (e) {
    return errorResponse(`sportsbook-deltas query failed: ${e?.message}`, 500);
  }
}

export async function handleShadowRoutes({ path, request, env, cache }) {
  const polyScanResp = await handlePolymarketScan({ path, request, env });
  if (polyScanResp) return polyScanResp;

  const polyDeltaResp = await handlePolymarketDeltas({ path, request, env });
  if (polyDeltaResp) return polyDeltaResp;

  const sbDeltaResp = await handleSportsbookDeltas({ path, request, env });
  if (sbDeltaResp) return sbDeltaResp;

  const noteResp = await handleRoutineNote({ path, request, env, cache });
  if (noteResp) return noteResp;

  const reportResp = await handleShadowReport({ path, request, env, cache });
  if (reportResp) return reportResp;

  const shadowResolverResp = await handleShadowResolver({ path, request, env, cache });
  if (shadowResolverResp) return shadowResolverResp;

  const pregameResp = await handleShadowPregameSnap({ path, request, env, cache });
  if (pregameResp) return pregameResp;

  if (path !== "shadow-snapshot") return null;

  // Auth: CRON_SECRET (Vercel cron runner) or ADMIN_KEY (manual trigger).
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;
  const isCron  = env?.CRON_SECRET && bearer === env.CRON_SECRET;
  if (!isAdmin && !isCron) return errorResponse("Forbidden", 403);

  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  // ?rerankgroups=1 (ADMIN only) — one-shot backfill: recompute group_id/threshold_rank/
  // group_size/is_best_edge for ALL team rows under the stat-first key (2026-07-13 groupId fix).
  // Legit to backfill because ranks are pure annotation over stored values — no superseded
  // formula output is mixed (unlike FORMULA_CUTOFFS). Player rows (pp| groups) untouched.
  // model_true_pct is bet-side while annotateGroups ranks yes-side truePct, but distance from
  // 50 is symmetric under complement, so the ranks are identical. ?dry=1 = report only.
  if (new URL(request.url).searchParams.get("rerankgroups") === "1") {
    if (!isAdmin) return errorResponse("Forbidden", 403);
    const dry = new URL(request.url).searchParams.get("dry") === "1";
    const partition = `PARTITION BY sport, COALESCE(stat, game_type), home_team, away_team, COALESCE(game_date, snapshot_date::varchar)`;
    const rankedCte = `
      SELECT id, sport, COALESCE(stat, game_type) AS category, threshold_rank AS old_rank,
        'tm|' || sport || '|' || COALESCE(stat, game_type, '') || '|' || COALESCE(home_team,'') || '|' || COALESCE(away_team,'') || '|' || COALESCE(game_date, snapshot_date::varchar, '') AS gid,
        ROW_NUMBER() OVER (${partition} ORDER BY ABS(COALESCE(model_true_pct, 50) - 50), id) AS new_rank,
        (COUNT(*) OVER (${partition}))::int AS gs,
        (ROW_NUMBER() OVER (${partition} ORDER BY COALESCE(edge, 0) DESC, id) = 1) AS best
      FROM ${SHADOW_TABLE}
      WHERE player_name IS NULL`;
    try {
      let summary;
      if (dry) {
        summary = await neonQuery(`
          WITH ranked AS (${rankedCte})
          SELECT sport, category, COUNT(*)::int AS n,
            SUM((old_rank = 1)::int)::int AS rank1_old,
            SUM((new_rank = 1)::int)::int AS rank1_new,
            SUM((old_rank IS DISTINCT FROM new_rank)::int)::int AS changed
          FROM ranked GROUP BY 1, 2 ORDER BY changed DESC`, [], env, { write: true });
      } else {
        summary = await neonQuery(`
          WITH ranked AS (${rankedCte}),
          upd AS (
            UPDATE ${SHADOW_TABLE} sp
            SET group_id = r.gid, threshold_rank = r.new_rank, group_size = r.gs, is_best_edge = r.best
            FROM ranked r
            WHERE sp.id = r.id
              AND (sp.threshold_rank IS DISTINCT FROM r.new_rank OR sp.group_size IS DISTINCT FROM r.gs
                   OR sp.group_id IS DISTINCT FROM r.gid OR sp.is_best_edge IS DISTINCT FROM r.best)
            RETURNING sp.sport, COALESCE(sp.stat, sp.game_type) AS category, (r.new_rank = 1) AS is_rank1
          )
          SELECT sport, category, COUNT(*)::int AS changed, SUM(is_rank1::int)::int AS rank1_after
          FROM upd GROUP BY 1, 2 ORDER BY changed DESC`, [], env, { write: true });
        console.log(`[shadow-snapshot] rerankgroups applied: ${summary.reduce((s, r) => s + r.changed, 0)} rows changed`);
      }
      return jsonResponse({ ok: true, dry, byCategory: summary });
    } catch (e) { return errorResponse(`rerankgroups failed: ${e?.message}`, 500); }
  }

  const snapshotDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const t0 = Date.now();

  try {
    // DDL is skipped after first successful run (flag cached in Upstash for 30 days).
    // Avoids 4 cold-Neon round-trips that push the Edge Function past its timeout.
    const _schemaKey = "shadow:schema:v7";
    const _schemaOk = cache ? await cache.get(_schemaKey).catch(() => null) : null;
    if (!_schemaOk) {
      console.log("[shadow-snapshot] starting neonExec DDL");
      await neonExec(CREATE_TABLE_SQL, env);
      await neonExec(CREATE_POLY_DELTAS_SQL, env);
      await neonExec(ADD_POLY_EXEC_COLS_SQL, env);
      await neonExec(CREATE_SB_DELTAS_SQL, env);
      console.log(`[shadow-snapshot] DDL done ${Date.now() - t0}ms`);
    }

    // Try KV staging written by tonight cron — avoids the 55s re-fetch that hits the 60s wall-clock.
    let rawPlays = null;
    let _qualifiedCount = 0, _droppedCount = 0;
    let _schedule = null; // per-sport ESPN game counts stamped by tonight (coverage check)
    let _polyDeltas = null; // Polymarket cross-venue ML deltas (Phase 1a observatory)
    let _sbDeltas = null;   // Sportsbook-reference ML deltas (Phase 1a observatory)
    if (cache) {
      const _staged = await cache.get(`shadow:staging:${snapshotDate}`, "json").catch(() => null);
      if (_staged?.plays) {
        _qualifiedCount = _staged.plays.length;
        _droppedCount = _staged.dropped?.length ?? 0;
        _schedule = _staged.schedule || null;
        _polyDeltas = _staged.polymarketDeltas || null;
        _sbDeltas = _staged.sportsbookDeltas || null;
        console.log(`[shadow-snapshot] KV staging hit plays=${_qualifiedCount} dropped=${_droppedCount} ${Date.now() - t0}ms`);
        rawPlays = [..._staged.plays, ...(_staged.dropped || [])];
      }
    }
    if (!rawPlays) {
      const origin = selfOrigin(request);
      console.log(`[shadow-snapshot] fetching ${origin}/api/tonight`);
      let tonightResp;
      try {
        tonightResp = await fetch(`${origin}/api/tonight?debug=1`, {
          headers: { "x-shadow-internal": "1" },
          signal: AbortSignal.timeout(55_000),
        });
      } catch (fetchErr) {
        console.error(`[shadow-snapshot] tonight fetch failed: ${fetchErr?.message} ${Date.now() - t0}ms`);
        return errorResponse(`tonight fetch timed out — re-run manually: ${fetchErr?.message}`, 504);
      }
      console.log(`[shadow-snapshot] tonight status=${tonightResp.status} ${Date.now() - t0}ms`);
      if (!tonightResp.ok) return errorResponse(`tonight fetch failed: ${tonightResp.status}`, 502);
      const tonight = await tonightResp.json();
      _qualifiedCount = tonight.plays?.length ?? 0;
      _droppedCount = tonight.dropped?.length ?? 0;
      _polyDeltas = tonight.polymarketDeltas || null;
      _sbDeltas = tonight.sportsbookDeltas || null;
      console.log(`[shadow-snapshot] tonight parsed plays=${_qualifiedCount} dropped=${_droppedCount} ${Date.now() - t0}ms`);
      rawPlays = [...(tonight.plays || []), ...(tonight.dropped || [])];
    }

    // Filter: must have a computed truePct, and game must be on today's PT date.
    const plays = rawPlays.filter(p =>
      typeof p.truePct === "number" && !isNaN(p.truePct) &&
      (p.gameDate === snapshotDate || !p.gameDate)
    );

    if (!plays.length) {
      return jsonResponse({ ok: true, snapshotDate, logged: 0, durationMs: Date.now() - t0 });
    }

    annotateGroups(plays, snapshotDate);

    // Taker-flow stamp (xFlow* via p._flow → exogenousSignals): one public trades fetch
    // per distinct ticker. Failure-closed — any error logs and the snapshot proceeds
    // unstamped; this block must never break the shadow_plays write.
    let flowMeta = { tickers: 0, stamped: 0, ms: 0 };
    try {
      const _ft = Date.now();
      const _tickerOf = (p) => p.kalshiTicker ?? p._ticker ?? null;
      const flowTickers = [...new Set(plays.map(_tickerOf).filter(Boolean))];
      const flowMap = await fetchTradeFlow(flowTickers);
      let stamped = 0;
      for (const p of plays) {
        const f = flowMap.get(_tickerOf(p));
        if (f) { p._flow = f; stamped++; }
      }
      flowMeta = { tickers: flowTickers.length, stamped, rateLimited: flowMap.rateLimited === true, ms: Date.now() - _ft };
      console.log(`[shadow-snapshot] flow stamp tickers=${flowMeta.tickers} stamped=${stamped} rateLimited=${flowMeta.rateLimited} ${flowMeta.ms}ms`);
    } catch (e) {
      console.log(`[shadow-snapshot] flow stamp failed: ${e?.message ?? e}`);
    }

    const rows = plays.map(p => ({
      id: shadowId(p, snapshotDate),
      snapshot_date: snapshotDate,
      sport: p.sport || null,
      stat: p.stat || null,
      game_type: p.gameType || null,
      player_name: p.playerName || null,
      player_id: String(p.playerId || ""),
      // Game-type plays have homeTeam/awayTeam; qualified props have playerTeam/opponent;
      // early-dropped props only have gameTeam1/gameTeam2 from the Kalshi ticker.
      // The resolver only needs two team identifiers to find the ESPN game; order doesn't matter.
      home_team: p.homeTeam || p.playerTeam || p.gameTeam1 || null,
      away_team: p.awayTeam || p.opponent   || p.gameTeam2 || null,
      scoring_team: p.scoringTeam || null,
      pick_team: p.pickTeam || null,
      pick_line: p.pickLine ?? null,
      threshold: p.threshold ?? null,
      direction: p.direction || null,
      model_true_pct: p.direction === "under" ? (p.noTruePct ?? parseFloat((100 - p.truePct).toFixed(1))) : p.truePct,
      kalshi_pct: p.kalshiPct ?? null,
      no_kalshi_pct: p.noKalshiPct ?? null,
      edge: p.edge ?? null,
      dc: p.dataConfidence ?? null,
      dc_qualified: p.dcQualified ?? null,
      game_date: p.gameDate || null,
      // Null game_time when gameDate is unknown (Kalshi ticker null-date issue) for game-type
      // plays — the bare-fallback gameTimes value may point to a different day's game,
      // causing the resolver's /api/live time-prefix match to fail. Without a stored
      // game_time the resolver does a time-agnostic team lookup instead.
      game_time: (p.gameDate || !p.gameType) ? (p.gameTime || null) : null,
      group_id: p._gid,
      group_size: p._groupSize,
      threshold_rank: p._rank,
      is_best_edge: p._isBestEdge ?? false,
      snapshot_model_version: p.modelVersion || "v2",
      season_type: p.seasonType ?? null,
      features: extractFeatures(p),
      kalshi_yes_price: p.kalshiPct != null ? p.kalshiPct / 100 : null,
      kalshi_no_price: p.noKalshiPct != null ? p.noKalshiPct / 100 : null,
    }));

    console.log(`[shadow-snapshot] upserting ${rows.length} rows`);
    await neonBatchUpsert(SHADOW_TABLE, COLUMNS, rows, env);
    console.log(`[shadow-snapshot] upsert done ${Date.now() - t0}ms`);

    // Persist Polymarket cross-venue ML deltas into their own table (own try/catch — a poly
    // failure must never break the shadow_plays snapshot). One row per game-side per day.
    let polymarketLogged = 0;
    if (Array.isArray(_polyDeltas) && _polyDeltas.length) {
      try {
        const _pRows = _polyDeltas
          .filter(d => d && d.sport && d.game && d.side && d.market)
          .map(d => ({
            id: `${snapshotDate}|${d.sport}|${d.game}|${d.market}|${d.side}`,
            snapshot_date: snapshotDate,
            sport: d.sport,
            game: d.game,
            game_date: d.gameDate || null,
            market: d.market,
            side: d.side,
            kalshi_pct: d.kalshiPct ?? null,
            poly_pct: d.polyPct ?? null,
            delta_cents: d.deltaCents ?? null,
            model_true_pct: d.modelTruePct ?? null,
            poly_vwap_pct: d.polyVwapPct ?? null,
            poly_slip_cents: d.polySlipCents ?? null,
            exec_delta_cents: d.execDeltaCents ?? null,
          }));
        // Dedup by id WITHIN the batch — a matchup listed under two Poly ticker-dates collapses to
        // the same id, and ON CONFLICT DO UPDATE errors ("cannot affect row a second time") if one
        // INSERT carries the same conflict key twice. Prefer the row that carries exec (book-walked).
        const _byId = new Map();
        for (const r of _pRows) {
          const prev = _byId.get(r.id);
          if (!prev || (r.exec_delta_cents != null && prev.exec_delta_cents == null)) _byId.set(r.id, r);
        }
        const _pDedup = [..._byId.values()];
        // DO UPDATE (latest snapshot wins) so a later book-walk backfills exec onto an earlier row.
        await neonBatchUpsert(POLY_DELTAS_TABLE, POLY_DELTAS_COLUMNS, _pDedup, env, 100, [
          "kalshi_pct", "poly_pct", "delta_cents", "model_true_pct",
          "poly_vwap_pct", "poly_slip_cents", "exec_delta_cents",
        ]);
        polymarketLogged = _pDedup.length;
        console.log(`[shadow-snapshot] polymarket deltas upserted ${polymarketLogged}`);
      } catch (e) { console.error("[shadow-snapshot] polymarket deltas failed:", e?.message); }
    }

    // Persist sportsbook-reference ML deltas into their own table (own try/catch — a book failure
    // must never break the shadow_plays snapshot). One row per game-side per day.
    let sportsbookLogged = 0;
    if (Array.isArray(_sbDeltas) && _sbDeltas.length) {
      try {
        const _sRows = _sbDeltas
          .filter(d => d && d.sport && d.game && d.side && d.market)
          .map(d => ({
            id: `${snapshotDate}|${d.sport}|${d.game}|${d.market}|${d.side}`,
            snapshot_date: snapshotDate,
            sport: d.sport,
            game: d.game,
            game_date: d.gameDate || null,
            market: d.market,
            side: d.side,
            kalshi_pct: d.kalshiPct ?? null,
            book_fair_pct: d.bookFairPct ?? null,
            delta_cents: d.deltaCents ?? null,
            book: d.book || null,
            model_true_pct: d.modelTruePct ?? null,
          }));
        // Dedup by id within the batch (a matchup under two ticker-dates collapses to one id) before
        // the upsert, mirroring the poly path.
        const _sById = new Map();
        for (const r of _sRows) if (!_sById.has(r.id)) _sById.set(r.id, r);
        const _sDedup = [..._sById.values()];
        await neonBatchUpsert(SB_DELTAS_TABLE, SB_DELTAS_COLUMNS, _sDedup, env, 100, [
          "kalshi_pct", "book_fair_pct", "delta_cents", "book", "model_true_pct",
        ]);
        sportsbookLogged = _sDedup.length;
        console.log(`[shadow-snapshot] sportsbook deltas upserted ${sportsbookLogged}`);
      } catch (e) { console.error("[shadow-snapshot] sportsbook deltas failed:", e?.message); }
    }

    // Coverage check: distinct games per sport in the logged rows vs the ESPN slate stamped
    // into staging by tonight. Warn-only at <80% — not every ESPN game has Kalshi markets,
    // and doubleheaders collapse to one game on the rows side (sorted-pair keying).
    // Catches whole-game gaps: parse bugs, Kalshi outages, emit-path regressions.
    // Only rows dated to the snapshot day count — null game_date rows are next-day
    // pre-listings or dateless module rows, not evidence today's game was captured.
    let coverage = null;
    let coverageWarning = false;
    if (_schedule) {
      const _gamesBySport = {};
      for (const r of rows) {
        if (!r.sport || !r.home_team || !r.away_team || r.game_date !== snapshotDate) continue;
        const pair = [r.home_team, r.away_team].sort().join(":");
        (_gamesBySport[r.sport] ??= new Set()).add(pair);
      }
      const _runCov = {};
      for (const [sp, scheduled] of Object.entries(_schedule)) {
        _runCov[sp] = { games: _gamesBySport[sp]?.size ?? 0, scheduled };
      }
      // Max-merge with the day's existing stamp (see mergeCoverage) so late/manual runs
      // over decayed staging can only add coverage, never erase it. Read failure → merge
      // with nothing, i.e. today's run stands alone (previous behavior).
      const _prevCov = cache ? await cache.get(`shadow:coverage:${snapshotDate}`, "json").catch(() => null) : null;
      ({ coverage, coverageWarning } = mergeCoverage(_prevCov?.coverage, _runCov));
      const _covStr = Object.entries(coverage).map(([sp, c]) => `${sp}=${c.games}/${c.scheduled}`).join(" ");
      if (coverageWarning) console.warn(`[shadow-snapshot] COVERAGE WARNING ${_covStr}`);
      else console.log(`[shadow-snapshot] coverage ${_covStr}`);
      // Persist for the model report's data-health header (read by date the morning after).
      if (cache) cache.put(`shadow:coverage:${snapshotDate}`, JSON.stringify({ coverage, coverageWarning, at: Date.now() }),
        { expirationTtl: 86400 * 3 }).catch(() => {});
    }

    // Refresh schema flag so next cron run skips DDL (30-day TTL, renewed on each success).
    if (cache) cache.put("shadow:schema:v7", "1", { expirationTtl: 86400 * 30 }).catch(() => {});

    return jsonResponse({
      ok: true,
      snapshotDate,
      logged: rows.length,
      polymarketLogged,
      sportsbookLogged,
      qualified: _qualifiedCount,
      dropped: _droppedCount,
      flow: flowMeta,
      coverage,
      coverageWarning,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    console.error("[shadow-snapshot] ERROR:", e?.message, e?.stack);
    return errorResponse(`snapshot failed: ${e?.message}`, 500);
  }
}
