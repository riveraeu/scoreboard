// /api/shadow-snapshot — daily cron that logs ALL model predictions to Neon for
// unbiased shadow calibration. No edge gate, no dc gate — captures the full distribution.
// Auth: CRON_SECRET (same pattern as kalshi-snapshot).
// Cron: 0 22 * * * (3pm PT — after most lineup confirmations, before first pitch).

import { neonQuery, neonBatchUpsert, neonBatchResolve, neonBatchPrePriceUpdate, neonExec } from "../neon.js";
import { errorResponse, jsonResponse } from "../utils.js";
import { verifyJWT } from "../auth-utils.js";
import { fetchCompletedMatches } from "../tennis.js";
import { fetchWcFinals, fetchWcHalfFinals } from "../soccer.js";
import { fetchFightResults, matchFightByCodes, normFighterName } from "../mma.js";
import { fetchRoundScores, normGolfName } from "../golf.js";
import { fetchRaceResults } from "../nascar.js";
import { KALSHI_GATE, KALSHI_CAP, EDGE_GATE_SERVER } from "../config.js";
import { passesCategoryGate } from "../category-gate.js";

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
function groupId(p, fallbackDate = "") {
  if (p.playerName) {
    return `pp|${p.sport}|${p.playerId || p.playerName}|${p.gameDate || fallbackDate || ""}`;
  }
  return `tm|${p.sport}|${p.gameType || p.stat}|${p.homeTeam}|${p.awayTeam}|${p.gameDate || fallbackDate || ""}`;
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

function extractFeatures(p) {
  const features = {};
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
  if (segment === "f5" || segment === "1h" || segment === "2h" || _isQtr) {
    let segDone, segHome, segAway;
    if (segment === "f5") {
      segDone = game.f5Complete === true;
      segHome = game.f5HomeScore ?? 0;
      segAway = game.f5AwayScore ?? 0;
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
      const data = await res.json();
      for (const [k, v] of Object.entries(data)) liveByKey.set(`${k}|${game_date}`, v);
      return;
    } catch (e) {
      console.error(`[shadow-resolver] live fetch failed (attempt ${attempt + 1}, date ${game_date}): ${e?.message}`);
    }
  }
}

async function handleShadowResolver({ path, request, env }) {
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
  const soccerRows = rows.filter(r => r.sport === "soccer" && !_isSoccerHalf(r));
  const soccerHalfRows = rows.filter(r => r.sport === "soccer" && _isSoccerHalf(r));
  const fightRows = rows.filter(r => r.sport === "fight");
  const golfRows = rows.filter(r => r.sport === "golf");
  const nascarRows = rows.filter(r => r.sport === "nascar");
  const teamRows = rows.filter(r => r.sport !== "tennis" && r.sport !== "soccer" && r.sport !== "fight" && r.sport !== "golf" && r.sport !== "nascar");

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

  const origin = new URL(request.url).origin;
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

  if (updates.length) await neonBatchResolve(updates, env);

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

async function handleShadowPregameSnap({ path, request, env, cache }) {
  if (path !== "shadow-pregame-snap") return null;

  const cronAuth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isAdmin = env?.ADMIN_KEY && cronAuth === env.ADMIN_KEY;
  const isCron  = env?.CRON_SECRET && cronAuth === env.CRON_SECRET;
  if (!isAdmin && !isCron) return errorResponse("Forbidden", 403);

  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const t0 = Date.now();
  const isDry = new URL(request.url).searchParams.get("dry") === "1";
  const snapshotDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

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
    const origin = new URL(request.url).origin;
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
    return jsonResponse({ ok: true, dry: isDry, source, stagingAgeMs, updated: 0, skipped: 0, durationMs: Date.now() - t0 });
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
      wouldUpdate: updates.length,
      skipped,
      durationMs: Date.now() - t0,
    });
  }

  await neonBatchPrePriceUpdate(updates, env);

  return jsonResponse({
    ok: true,
    snapshotDate,
    source,
    stagingAgeMs,
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
  for (let tp = 50; tp < 100; tp++) {
    if (passesCategoryGate({ sport, stat: cat, truePct: tp })) return true;
  }
  return false;
}
// SQL fragment that mirrors passesCategoryGate() for use in the top-picks query.
// passesCategoryGate() keys on p.truePct (always the YES/over-side probability), NOT the
// bet side. For props (OVER-only) truePct == model_true_pct. For spread, both sides of a
// line carry the same truePct (the favorite-cover prob); the stored model_true_pct is the
// bet side, so for direction='under' rows truePct == 100 - model_true_pct (cover probs are
// complementary). Hence the CASE — it reconstructs p.truePct to mirror the gate exactly.
const _CATEGORY_GATE_SQL = `(
  (sport='mlb'  AND stat='strikeouts' AND model_true_pct >= 80 AND model_true_pct < 85) OR
  (sport='wnba' AND stat='points'     AND model_true_pct >= 70 AND model_true_pct < 80) OR
  (sport='wnba' AND stat='rebounds'   AND model_true_pct >= 70 AND model_true_pct < 85) OR
  (sport='wnba' AND game_type='spread' AND
     (CASE WHEN direction='under' THEN 100 - model_true_pct ELSE model_true_pct END) >= 65 AND
     (CASE WHEN direction='under' THEN 100 - model_true_pct ELSE model_true_pct END) <  85)
)`;
const _BAND_MID = { "55-60":57.5,"60-65":62.5,"65-70":67.5,"70-75":72.5,"75-80":77.5,"80-85":82.5,"85-90":87.5,"90-95":92.5,"95+":97.5 };
const _BAND_ORDER = Object.keys(_BAND_MID); // low → high, for adjacency/coherence

// Per-category current-formula cutoffs — calibration before these dates was produced by a
// SUPERSEDED formula and must not be mixed in (the #1 analysis trap, docs/MODEL_IMPROVEMENT.md).
// Keyed by `${sport}|${COALESCE(stat,game_type)}`. Keep in sync with MEMORY.md "Model changes".
// Only cutoffs within the trailing window actually trim; older ones are harmless.
const FORMULA_CUTOFFS = {
  "mlb|strikeouts": "2026-06-13", // K_FORM_SIGMA 0.22→0.26
  "mlb|hrr":        "2026-06-22", // FIP-over-WHIP split + game-time weather (was 2026-06-10: OPS 0.4→0.25, knee 72→68)
  "mlb|hits":       "2026-06-12", // ticker fix — data starts here
  "mlb|totalBases": "2026-06-12",
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
  "fight|rounds":   "2026-06-21", // UFC Phase 1 — weight-class finish-rate → duration CDF
  "golf|h2h":       "2026-06-21", // PGA Phase 1 — OWGR rating → one-round score differential
  "nascar|h2h":     "2026-06-22", // NASCAR Cup Phase 1 — recent-form finishing-position model
  "nascar|top10":   "2026-06-22",
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
function _accuracyVerdict(calib) {
  const c = calib || {};
  if (c.status === "actionable") return c.direction === "over" ? "OVERCONFIDENT" : "UNDERCONFIDENT";
  if (c.status === "honest")     return "CALIBRATED";   // some band hit n≥200 and lands within noise
  return "BUILDING";                                    // insufficient — can't judge calibration yet
}
function _accuracyAction(verdict, calib) {
  const c = calib || { status: "insufficient" };
  switch (verdict) {
    case "CALIBRATED":
      return { action: "Calibrated", tone: "green",
        why: "model% matches actual outcomes within noise — well-calibrated to reality" };
    case "OVERCONFIDENT":
      return { action: "Improve inputs", tone: "amber",
        why: `model is overconfident — says ${c.delta != null ? `${Math.abs(c.delta)}pts ` : ""}more than it delivers in the ${c.band ?? ""}% band; needs a NEW input or recalibration, run tune:residual` };
    case "UNDERCONFIDENT":
      return { action: "Improve inputs", tone: "amber",
        why: `model is underconfident — delivers ${c.delta != null ? `${Math.abs(c.delta)}pts ` : ""}more than it claims in the ${c.band ?? ""}% band; recalibrate, run tune:residual` };
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
// Profit is realized against the PRICE paid, not the model's number: ROI = hitRate − price.
// So the betting-window question ("is 67–91 right?") is a price-axis question. These helpers
// work a per-category 5¢ price histogram of bettable plays (dc_qualified + edge≥5, NO price
// window, NO truePct gate — those are the assumptions under test) so the data sets the bounds.
const _MIN_N_WINDOW  = 30; // min n to trust a discovered price window
const _MIN_N_PROMOTE = 50; // min n in the window to promote an ungated category
// Brier skill (= marketBrier − modelBrier; >0 = model sharper than the price). No longer drives the
// accuracy verdict (that's calibration-based now) — it's the secondary "vs market" signal and the
// betting board's `eligible` gate: skill CI lo > 0 AND n ≥ BRIER_MIN_N. Only trusted above
// BRIER_MIN_N resolved plays (Brier is a mean of squared errors → lower variance than a tail
// hit-rate, but still noisy at small n, where the CI can read misleadingly positive).
const BRIER_MIN_N = 100; // min resolved n before Brier skill can gate betting eligibility

// Adaptive-merge adjacent 5¢ cells until each display bin clears `target` n — bin WIDTHS come
// from where the data actually is, not from fixed guesses. Trailing remainder folds left.
function _priceWindowBins(cells, target = 15) {
  const sorted = [...cells].sort((a, b) => a.lo - b.lo);
  const out = [];
  let cur = null;
  for (const c of sorted) {
    if (!cur) cur = { lo: c.lo, hi: c.lo + 5, n: 0, wins: 0, pSum: 0 };
    cur.hi = c.lo + 5; cur.n += c.n; cur.wins += c.wins; cur.pSum += c.avgPrice * c.n;
    if (cur.n >= target) { out.push(cur); cur = null; }
  }
  if (cur) {
    if (out.length) { const l = out[out.length - 1]; l.hi = cur.hi; l.n += cur.n; l.wins += cur.wins; l.pSum += cur.pSum; }
    else out.push(cur);
  }
  return out.map(b => {
    const avgPrice = b.pSum / b.n;
    return { lo: b.lo, hi: b.hi, n: b.n,
      hitRate: parseFloat((100 * b.wins / b.n).toFixed(1)),
      avgPrice: parseFloat(avgPrice.toFixed(1)),
      roi: parseFloat((b.wins / b.n - avgPrice / 100).toFixed(4)) };
  });
}

// Best contiguous price window by ROI, subject to n ≥ minN — the data-derived betting range.
function _discoverPriceWindow(cells, minN = _MIN_N_WINDOW) {
  const s = [...cells].sort((a, b) => a.lo - b.lo);
  let best = null;
  for (let i = 0; i < s.length; i++) {
    let n = 0, wins = 0, pSum = 0;
    for (let j = i; j < s.length; j++) {
      n += s[j].n; wins += s[j].wins; pSum += s[j].avgPrice * s[j].n;
      if (n < minN) continue;
      const roi = wins / n - (pSum / n) / 100;
      if (!best || roi > best.roi) best = { lo: s[i].lo, hi: s[j].lo + 5, n, wins, pSum, roi };
    }
  }
  if (!best) return null;
  const avgPrice = best.pSum / best.n;
  return { lo: best.lo, hi: best.hi, n: best.n,
    roi: parseFloat(best.roi.toFixed(4)),
    hitRate: parseFloat((100 * best.wins / best.n).toFixed(1)),
    avgPrice: parseFloat(avgPrice.toFixed(1)) };
}

// Promotion validation for a discovered window: 95% CI on ROI (binomial SE on the hit rate,
// since ROI = hitRate − ~fixed price) + a half-split coherence test (both price-halves of the
// window non-negative — guards against a single lucky bin masquerading as a profitable regime,
// the selection-bias hazard of maximizing ROI over candidate windows). `cells` are the window's
// component 5¢ bins.
function _windowQuality(cells, win) {
  if (!win) return null;
  const p = win.hitRate / 100;
  const se = Math.sqrt(Math.max(0, p * (1 - p) / win.n));
  const roiLoCI = parseFloat((win.roi - 1.96 * se).toFixed(4));
  const roiHiCI = parseFloat((win.roi + 1.96 * se).toFixed(4));
  const inWin = cells.filter(c => c.lo >= win.lo && c.lo < win.hi).sort((a, b) => a.lo - b.lo);
  const _roiOf = arr => {
    const N = arr.reduce((s, c) => s + c.n, 0); if (!N) return null;
    const W = arr.reduce((s, c) => s + c.wins, 0);
    const P = arr.reduce((s, c) => s + c.avgPrice * c.n, 0);
    return W / N - (P / N) / 100;
  };
  let coherent = false;
  if (inWin.length >= 2) {
    const mid = win.lo + (win.hi - win.lo) / 2;
    const lo = _roiOf(inWin.filter(c => c.lo < mid));
    const up = _roiOf(inWin.filter(c => c.lo >= mid));
    coherent = (lo == null || lo >= -0.02) && (up == null || up >= -0.02);
  }
  return { roiLoCI, roiHiCI, coherent };
}

function _extractReportToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
  if (m?.[1]) return m[1];
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
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
    // No cached report yet — return a stub so the UI can show a friendly message.
    return jsonResponse({ notYet: true, reportDate });
  }

  const t0 = Date.now();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  // Yesterday in PT — the recap scopes to games played yesterday (pick.gameDate). Report runs
  // 6am PT, well clear of the midnight boundary, so a flat 24h subtraction is safe.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  let catRows, bandRows, clvRows, volRows, picksRows, healthRows, perGameRows, priceHistRows, brierRows;
  try {
    [catRows, bandRows, clvRows, volRows, picksRows, healthRows, perGameRows, priceHistRows, brierRows] = await Promise.all([
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
      `, [since], env),

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
      `, [since], env),

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
      `, [since], env),

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
      `, [since], env),

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
      `, [reportDate], env),

      // Q6: Data health — yesterday's resolution + CLV capture (garbage-in guard).
      neonQuery(`
        SELECT
          COUNT(*) AS total,
          SUM(resolved::int) AS resolved,
          SUM((won IS NOT NULL)::int) AS scored,
          SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS clv_captured
        FROM shadow_plays
        WHERE game_date = $1
      `, [yesterday], env),

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
      `, [since], env),

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
      `, [since], env),

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
      `, [since], env),
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
    const verdict = _accuracyVerdict(calib);
    const honest = _accuracyAction(verdict, calib);
    // `active` = this truePct slice is in the live category gate right now. Bands are 5-wide and
    // aligned to the gate's 5-boundaries, so the band midpoint membership-tests the gate exactly.
    const calibBands = (_bandsByCat[key] || []).map(b => ({
      band: b.band, n: b.n, predicted: b.predicted, actual: b.actual, delta: b.delta, verdict: b.verdict, coherent: b.coherent,
      active: passesCategoryGate({ sport, stat: category, truePct: b.predicted }),
    }));
    return {
      key, sport, category, gated: _isGatedCategory(key),
      n: brier.n, skill: brier.skill, skillLoCI: brier.skillLoCI,
      modelBrier: brier.modelBrier, marketBrier: brier.marketBrier,
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
    const h = healthRows?.[0] || {};
    const total = Number(h.total ?? 0), resolved = Number(h.resolved ?? 0);
    const scored = Number(h.scored ?? 0), clvCaptured = Number(h.clv_captured ?? 0);
    const warnings = [];
    if (covKV?.coverageWarning) {
      const covStr = Object.entries(covKV.coverage || {}).map(([sp, c]) => `${sp} ${c.games}/${c.scheduled}`).join(", ");
      warnings.push(`Slate under-logged yesterday (${covStr}) — model numbers may be incomplete.`);
    }
    if (total > 0 && resolved / total < 0.9) warnings.push(`Only ${resolved}/${total} of yesterday's plays resolved — ROI partial.`);
    if (total > 0 && clvCaptured / total < 0.5) warnings.push(`CLV captured for only ${clvCaptured}/${total} of yesterday's plays.`);
    dataHealth = {
      coverage: covKV?.coverage ?? null,
      coverageWarning: covKV?.coverageWarning ?? null,
      resolution: { total, resolved, scored, pending: Math.max(0, total - resolved) },
      clvCapture: { captured: clvCaptured, total, pct: total > 0 ? parseFloat((clvCaptured / total * 100).toFixed(0)) : null },
      warnings,
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
      `, [status], env);
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
  const [newMarkets, shortlistedMarkets] = await Promise.all([
    queryDiscovered("new"),
    queryDiscovered("shortlisted"),
  ]);

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
    durationMs: Date.now() - t0,
  };

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

export async function handleShadowRoutes({ path, request, env, cache }) {
  const noteResp = await handleRoutineNote({ path, request, env, cache });
  if (noteResp) return noteResp;

  const reportResp = await handleShadowReport({ path, request, env, cache });
  if (reportResp) return reportResp;

  const shadowResolverResp = await handleShadowResolver({ path, request, env });
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

  const snapshotDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const t0 = Date.now();

  try {
    // DDL is skipped after first successful run (flag cached in Upstash for 30 days).
    // Avoids 4 cold-Neon round-trips that push the Edge Function past its timeout.
    const _schemaKey = "shadow:schema:v4";
    const _schemaOk = cache ? await cache.get(_schemaKey).catch(() => null) : null;
    if (!_schemaOk) {
      console.log("[shadow-snapshot] starting neonExec DDL");
      await neonExec(CREATE_TABLE_SQL, env);
      console.log(`[shadow-snapshot] DDL done ${Date.now() - t0}ms`);
    }

    // Try KV staging written by tonight cron — avoids the 55s re-fetch that hits the 60s wall-clock.
    let rawPlays = null;
    let _qualifiedCount = 0, _droppedCount = 0;
    let _schedule = null; // per-sport ESPN game counts stamped by tonight (coverage check)
    if (cache) {
      const _staged = await cache.get(`shadow:staging:${snapshotDate}`, "json").catch(() => null);
      if (_staged?.plays) {
        _qualifiedCount = _staged.plays.length;
        _droppedCount = _staged.dropped?.length ?? 0;
        _schedule = _staged.schedule || null;
        console.log(`[shadow-snapshot] KV staging hit plays=${_qualifiedCount} dropped=${_droppedCount} ${Date.now() - t0}ms`);
        rawPlays = [..._staged.plays, ...(_staged.dropped || [])];
      }
    }
    if (!rawPlays) {
      const origin = new URL(request.url).origin;
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

    // Coverage check: distinct games per sport in the logged rows vs the ESPN slate stamped
    // into staging by tonight. Warn-only at <80% — not every ESPN game has Kalshi markets,
    // and doubleheaders collapse to one game on the rows side (sorted-pair|date keying).
    // Catches whole-game gaps: parse bugs, Kalshi outages, emit-path regressions.
    let coverage = null;
    let coverageWarning = false;
    if (_schedule) {
      const _gamesBySport = {};
      for (const r of rows) {
        if (!r.sport || !r.home_team || !r.away_team) continue;
        const pair = [r.home_team, r.away_team].sort().join(":");
        (_gamesBySport[r.sport] ??= new Set()).add(`${pair}|${r.game_date || snapshotDate}`);
      }
      coverage = {};
      for (const [sp, scheduled] of Object.entries(_schedule)) {
        const games = _gamesBySport[sp]?.size ?? 0;
        coverage[sp] = { games, scheduled };
        if (scheduled > 0 && games / scheduled < 0.8) coverageWarning = true;
      }
      const _covStr = Object.entries(coverage).map(([sp, c]) => `${sp}=${c.games}/${c.scheduled}`).join(" ");
      if (coverageWarning) console.warn(`[shadow-snapshot] COVERAGE WARNING ${_covStr}`);
      else console.log(`[shadow-snapshot] coverage ${_covStr}`);
      // Persist for the model report's data-health header (read by date the morning after).
      if (cache) cache.put(`shadow:coverage:${snapshotDate}`, JSON.stringify({ coverage, coverageWarning, at: Date.now() }),
        { expirationTtl: 86400 * 3 }).catch(() => {});
    }

    // Refresh schema flag so next cron run skips DDL (30-day TTL, renewed on each success).
    if (cache) cache.put("shadow:schema:v4", "1", { expirationTtl: 86400 * 30 }).catch(() => {});

    return jsonResponse({
      ok: true,
      snapshotDate,
      logged: rows.length,
      qualified: _qualifiedCount,
      dropped: _droppedCount,
      coverage,
      coverageWarning,
      durationMs: Date.now() - t0,
    });
  } catch (e) {
    console.error("[shadow-snapshot] ERROR:", e?.message, e?.stack);
    return errorResponse(`snapshot failed: ${e?.message}`, 500);
  }
}
