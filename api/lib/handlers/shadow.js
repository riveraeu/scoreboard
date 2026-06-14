// /api/shadow-snapshot — daily cron that logs ALL model predictions to Neon for
// unbiased shadow calibration. No edge gate, no dc gate — captures the full distribution.
// Auth: CRON_SECRET (same pattern as kalshi-snapshot).
// Cron: 0 22 * * * (3pm PT — after most lineup confirmations, before first pitch).

import { neonQuery, neonBatchUpsert, neonBatchResolve, neonBatchPrePriceUpdate, neonExec } from "../neon.js";
import { errorResponse, jsonResponse } from "../utils.js";
import { verifyJWT } from "../auth-utils.js";
import { fetchCompletedMatches } from "../tennis.js";

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

  // Segment plays (F5 / NBA halves) — must come before full-game branches.
  if (segment === "f5" || segment === "1h" || segment === "2h") {
    let segDone, segHome, segAway;
    if (segment === "f5") {
      segDone = game.f5Complete === true;
      segHome = game.f5HomeScore ?? 0;
      segAway = game.f5AwayScore ?? 0;
    } else if (segment === "1h") {
      segDone = game.h1Complete === true;
      segHome = game.h1HomeScore ?? 0;
      segAway = game.h1AwayScore ?? 0;
    } else {
      segDone = game.h2Complete === true;
      segHome = game.h2HomeScore ?? 0;
      segAway = game.h2AwayScore ?? 0;
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

  // Tennis match-winner rows resolve via the ESPN tennis scoreboard (player-vs-player, no
  // home/away team key), so split them out of the team-based /api/live path below.
  const tennisRows = rows.filter(r => r.sport === "tennis");
  const teamRows = rows.filter(r => r.sport !== "tennis");

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
  await Promise.all([...keysByDate.entries()].map(async ([game_date, keys]) => {
    const gamesParam = [...keys].join(",");
    try {
      const res = await fetch(`${origin}/api/live?games=${encodeURIComponent(gamesParam)}&date=${game_date}${tbParam}`, {
        headers: { "User-Agent": "shadow-resolver/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const [k, v] of Object.entries(data)) {
        liveByKey.set(`${k}|${game_date}`, v);
      }
    } catch {}
  }));

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
    await Promise.all([...retryByDate.entries()].map(async ([game_date, keys]) => {
      const gamesParam = [...keys].join(",");
      try {
        const res = await fetch(`${origin}/api/live?games=${encodeURIComponent(gamesParam)}&date=${game_date}${tbParam}`, {
          headers: { "User-Agent": "shadow-resolver/1.0" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return;
        const data = await res.json();
        for (const [k, v] of Object.entries(data)) {
          liveByKey.set(`${k}|${game_date}`, v);
        }
      } catch {}
    }));
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
      await Promise.all([...offsetByDate.entries()].map(async ([game_date, keys]) => {
        const gamesParam = [...keys].join(",");
        try {
          const res = await fetch(`${origin}/api/live?games=${encodeURIComponent(gamesParam)}&date=${game_date}${tbParam}`, {
            headers: { "User-Agent": "shadow-resolver/1.0" },
            signal: AbortSignal.timeout(4_000),
          });
          if (!res.ok) return;
          const data = await res.json();
          for (const [k, v] of Object.entries(data)) {
            liveByKey.set(`${k}|${game_date}`, v);
          }
        } catch {}
      }));
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
// Cron: 30 16 * * * (9:30am PT) — after shadow-snapshot (8:05am PT) has run.
// Auth: CRON_SECRET (generate + cache) or ADMIN_KEY / JWT (read).
// Queries 5 parallel Neon aggregations (+ yesterdayRecap from tracked picks) and caches in KV (25h).
// ?bust=1 forces regeneration even when a cached report exists.

const REPORT_CACHE_KEY_PREFIX = "shadow:report:";
const REPORT_TTL = 60 * 60 * 25; // 25 hours

// Mirror passesCategoryGate() from api/lib/category-gate.js — kept in sync manually.
const _ACTIVE_CATS = new Set(["mlb|strikeouts", "wnba|points", "wnba|rebounds", "wnba|spread"]);
// SQL fragment that mirrors passesCategoryGate() for use in the top-picks query.
// passesCategoryGate() keys on p.truePct (always the YES/over-side probability), NOT the
// bet side. For props (OVER-only) truePct == model_true_pct. For spread, both sides of a
// line carry the same truePct (the favorite-cover prob); the stored model_true_pct is the
// bet side, so for direction='under' rows truePct == 100 - model_true_pct (cover probs are
// complementary). Hence the CASE — it reconstructs p.truePct to mirror the gate exactly.
const _CATEGORY_GATE_SQL = `(
  (sport='mlb'  AND stat='strikeouts' AND model_true_pct >= 80 AND model_true_pct < 90) OR
  (sport='wnba' AND stat='points'     AND model_true_pct >= 70 AND model_true_pct < 80) OR
  (sport='wnba' AND stat='rebounds'   AND model_true_pct >= 70 AND model_true_pct < 85) OR
  (sport='wnba' AND game_type='spread' AND
     (CASE WHEN direction='under' THEN 100 - model_true_pct ELSE model_true_pct END) >= 65 AND
     (CASE WHEN direction='under' THEN 100 - model_true_pct ELSE model_true_pct END) <  85)
)`;
const _BAND_MID = { "55-60":57.5,"60-65":62.5,"65-70":67.5,"70-75":72.5,"75-80":77.5,"80-85":82.5,"85-90":87.5,"90-95":92.5,"95+":97.5 };

function _extractReportToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)sb_token=([^;]+)/);
  if (m?.[1]) return m[1];
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
}

// Build the yesterday recap from TRACKED account picks (Upstash `picks:{userId}`), not the model's
// gated shadow set — so it reflects what was actually bet and how it resolved. When `userId` is set
// (JWT read) scope to that account; otherwise pick the most-active picks:* key (solo app). ROI is
// units-weighted from stored fields only: units = ⅛-Kelly $ stake, kalshiAvgCents = displayed entry
// for the side taken, result = won|lost|push. Recommendation-based (fill slippage not captured).
async function buildYesterdayRecap(env, cache, userId, date) {
  const empty = { date, account: null, n: 0, wins: 0, losses: 0, pushes: 0, pending: 0,
    hitRatePct: null, staked: 0, profit: 0, roi: null, picks: [] };
  const upUrl = env?.UPSTASH_REDIS_REST_URL;
  if (!upUrl || !cache) return empty;

  // Resolve the target picks blob.
  let picks = null, account = userId || null;
  if (userId) {
    const blob = await cache.get(`picks:${userId}`, "json").catch(() => null);
    picks = blob?.picks || null;
  } else {
    const keysRes = await fetch(upUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${env?.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["KEYS", "picks:*"]),
    });
    const { result: keys } = await keysRes.json();
    if (keys?.length) {
      const blobs = await Promise.all(keys.map(async k => ({
        k, picks: (await cache.get(k, "json").catch(() => null))?.picks || [],
      })));
      // Most-active account = most picks (solo-app heuristic).
      const best = blobs.reduce((a, b) => (b.picks.length > a.picks.length ? b : a), { k: null, picks: [] });
      picks = best.picks;
      account = best.k ? best.k.replace(/^picks:/, "") : null;
    }
  }
  if (!picks?.length) return { ...empty, account };

  // Filter to games played on `date` (pick.gameDate is the game's PT date).
  const dayPicks = picks.filter(p => p.gameDate === date);

  let wins = 0, losses = 0, pushes = 0, pending = 0, staked = 0, profit = 0;
  const out = dayPicks.map(p => {
    const units = Number(p.units) || 0;
    // Entry price for the side taken: kalshiAvgCents is the displayed avg (already side-aware);
    // fall back to the side's quoted price.
    const entryCents = p.kalshiAvgCents != null ? Number(p.kalshiAvgCents)
      : (p.kalshiSide === "no" && p.noKalshiPct != null) ? Number(p.noKalshiPct)
      : p.kalshiPct != null ? Number(p.kalshiPct) : null;
    const pPrice = entryCents != null && entryCents > 0 && entryCents < 100 ? entryCents / 100 : null;
    let pl = null;
    if (p.result === "won")       { wins++;   pl = pPrice != null ? units * (1 - pPrice) / pPrice : null; staked += units; }
    else if (p.result === "lost") { losses++; pl = -units; staked += units; }
    else if (p.result === "push") { pushes++; pl = 0; }
    else                          { pending++; }
    if (pl != null) profit += pl;
    const trueBet = p.direction === "under" ? (p.noTruePct ?? p.truePct) : p.truePct;
    return {
      sport: p.sport ?? null,
      category: p.stat || p.gameType || null,
      label: p.playerName || p.pickTeam || null,
      line: p.threshold ?? p.pickLine ?? null,
      side: p.direction || p.kalshiSide || null,
      truePct: trueBet != null ? parseFloat(Number(trueBet).toFixed(1)) : null,
      entryPct: entryCents != null ? parseFloat(Number(entryCents).toFixed(1)) : null,
      units: parseFloat(units.toFixed(2)),
      result: p.result || "pending",
      pl: pl != null ? parseFloat(pl.toFixed(2)) : null,
    };
  }).sort((a, b) => b.units - a.units);

  const settled = wins + losses;
  return {
    date,
    account,
    n: settled,
    wins, losses, pushes, pending,
    hitRatePct: settled > 0 ? parseFloat((wins / settled * 100).toFixed(1)) : null,
    staked: parseFloat(staked.toFixed(2)),
    profit: parseFloat(profit.toFixed(2)),
    roi: staked > 0 ? parseFloat((profit / staked).toFixed(4)) : null,
    picks: out,
  };
}

async function handleShadowReport({ path, request, env, cache }) {
  if (path !== "shadow-report") return null;

  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  const isCron  = env?.CRON_SECRET && bearer === env.CRON_SECRET;
  const isAdmin = env?.ADMIN_KEY && bearer === env.ADMIN_KEY;

  let isUser = false;
  let reqUserId = null; // when read with a JWT, scope yesterdayRecap to this user's picks
  if (!isCron && !isAdmin && env?.JWT_SECRET) {
    const token = _extractReportToken(request);
    const payload = token ? await verifyJWT(token, env.JWT_SECRET) : null;
    isUser = !!payload;
    reqUserId = payload?.userId ?? null;
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
  // 9:30am PT, well clear of the midnight boundary, so a flat 24h subtraction is safe.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  let catRows, bandRows, clvRows, volRows, picksRows;
  try {
    [catRows, bandRows, clvRows, volRows, picksRows] = await Promise.all([
      // Q1: Category overview — one row per player/game (threshold_rank=1 dedup).
      neonQuery(`
        SELECT sport, COALESCE(stat, game_type) AS category,
          COUNT(*) AS n, SUM(won::int) AS wins,
          ROUND(AVG(CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END)/100.0, 4) AS avg_bet_pct,
          ROUND(AVG(edge), 2) AS avg_edge
        FROM shadow_plays
        WHERE resolved AND won IS NOT NULL AND snapshot_date >= $1 AND threshold_rank = 1
        GROUP BY sport, COALESCE(stat, game_type)
        ORDER BY n DESC LIMIT 20
      `, [since], env),

      // Q2: Band distribution (55–100%, n≥5) — where is there most data + biggest gap?
      neonQuery(`
        WITH src AS (
          SELECT sport, COALESCE(stat, game_type) AS category,
            CASE WHEN direction='under' THEN (1 - model_true_pct) ELSE model_true_pct END AS bsp,
            won::int AS w,
            CASE WHEN direction='under' THEN no_kalshi_pct ELSE kalshi_pct END AS bet_pct
          FROM shadow_plays
          WHERE resolved AND won IS NOT NULL AND snapshot_date >= $1 AND threshold_rank = 1
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
        ORDER BY n DESC LIMIT 30
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
    ]);
  } catch (e) {
    console.error("[shadow-report] query failed:", e?.message);
    return errorResponse(`query failed: ${e?.message}`, 500);
  }

  // Process category overview.
  const categories = catRows.map(r => {
    const n = Number(r.n ?? 0);
    const wins = Number(r.wins ?? 0);
    const hitRate = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
    const avgBetPct = r.avg_bet_pct != null ? parseFloat(Number(r.avg_bet_pct).toFixed(4)) : null;
    const roi = hitRate != null && avgBetPct != null ? parseFloat((hitRate / 100 - avgBetPct).toFixed(4)) : null;
    const key = `${r.sport}|${r.category}`;
    const status = _ACTIVE_CATS.has(key) ? "active"
      : n >= 50 && (roi ?? -1) > 0 ? "building"
      : n >= 30 && (roi ?? 0) <= 0 ? "losing"
      : "too_few";
    return {
      key, sport: r.sport, category: r.category, n, hitRate,
      roi, avgEdge: r.avg_edge != null ? parseFloat(Number(r.avg_edge).toFixed(2)) : null, status,
    };
  });

  // Process top opportunity bands — most data + biggest calibration gap.
  const topBands = bandRows.map(r => {
    const n = Number(r.n ?? 0);
    const wins = Number(r.wins ?? 0);
    const actual = n > 0 ? parseFloat((wins / n * 100).toFixed(1)) : null;
    const predicted = _BAND_MID[r.band] ?? null;
    const delta = actual != null && predicted != null ? parseFloat((actual - predicted).toFixed(1)) : null;
    const avgBetPct = r.avg_bet_pct != null ? parseFloat(Number(r.avg_bet_pct).toFixed(4)) : null;
    const roi = actual != null && avgBetPct != null ? parseFloat((actual / 100 - avgBetPct).toFixed(4)) : null;
    return {
      key: `${r.sport}|${r.category}|${r.band}`,
      sport: r.sport, category: r.category, band: r.band,
      n, actual, predicted, delta, roi,
    };
  // Sort: most data first; within same n, largest |delta| first.
  }).sort((a, b) => b.n !== a.n ? b.n - a.n : Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 15);

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

  // Yesterday's recap — sourced from the user's TRACKED account picks (not the model's gated
  // shadow set), so it reflects what was actually bet and resolved. ROI is units-weighted from
  // stored fields: units = ⅛-Kelly $ stake, kalshiAvgCents = displayed entry price for the side
  // taken, result = won|lost|push. Recommendation-based (slippage from actual fills not captured).
  let yesterdayRecap = null;
  try {
    yesterdayRecap = await buildYesterdayRecap(env, cache, reqUserId, yesterday);
  } catch (e) {
    console.error("[shadow-report] yesterdayRecap skipped:", e?.message);
  }

  // Newly-listed Kalshi markets we don't consume yet (status='new' in kalshi_series_seen,
  // populated by the /api/kalshi-series-scan cron). Separate try/catch — the table may not
  // exist yet on first deploy, and a discovery miss must never break the briefing.
  let newMarkets = [];
  try {
    const nmRows = await neonQuery(`
      SELECT ticker, title, tags, frequency, sample_market, sample_subtitle, first_seen
      FROM kalshi_series_seen WHERE status = 'new'
      ORDER BY first_seen DESC, ticker LIMIT 25
    `, [], env);
    newMarkets = nmRows.map(r => ({
      ticker: r.ticker,
      title: r.title ?? null,
      tags: r.tags ?? null,
      frequency: r.frequency ?? null,
      sampleMarket: r.sample_market ?? null,
      sampleSubtitle: r.sample_subtitle ?? null,
      firstSeen: r.first_seen ? new Date(r.first_seen).toISOString().slice(0, 10) : null,
    }));
  } catch (e) {
    console.error("[shadow-report] newMarkets query skipped:", e?.message);
  }

  const report = {
    reportDate,
    generatedAt: new Date().toISOString(),
    since,
    topPicks,
    yesterdayRecap,
    categories,
    topBands,
    clv,
    dailyVolumeRoi,
    optimalDailyPicks,
    newMarkets,
    durationMs: Date.now() - t0,
  };

  if (cache) cache.put(cacheKey, JSON.stringify(report), { expirationTtl: REPORT_TTL }).catch(() => {});
  return jsonResponse(report);
}

export async function handleShadowRoutes({ path, request, env, cache }) {
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
