// /api/shadow-snapshot — daily cron that logs ALL model predictions to Neon for
// unbiased shadow calibration. No edge gate, no dc gate — captures the full distribution.
// Auth: CRON_SECRET (same pattern as kalshi-snapshot).
// Cron: 0 22 * * * (3pm PT — after most lineup confirmations, before first pitch).

import { neonQuery, neonBatchUpsert, neonBatchResolve, neonExec } from "../neon.js";
import { errorResponse, jsonResponse } from "../utils.js";

const SHADOW_TABLE = "shadow_plays";
const COLUMNS = [
  "id", "snapshot_date", "sport", "stat", "game_type",
  "player_name", "player_id", "home_team", "away_team",
  "scoring_team", "pick_team", "pick_line", "threshold", "direction",
  "model_true_pct", "kalshi_pct", "no_kalshi_pct", "edge",
  "dc", "dc_qualified", "game_date", "game_time",
  "group_id", "group_size", "threshold_rank", "is_best_edge",
  "snapshot_model_version", "season_type", "features",
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

// Stable deterministic ID for a play — unique per player/teams + stat/line + date.
function shadowId(p) {
  return [
    p.sport || "",
    p.gameDate || "",
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
function groupId(p) {
  if (p.playerName) {
    return `pp|${p.sport}|${p.playerId || p.playerName}|${p.gameDate || ""}`;
  }
  return `tm|${p.sport}|${p.gameType || p.stat}|${p.homeTeam}|${p.awayTeam}|${p.gameDate || ""}`;
}

// Annotate each play with threshold_rank (1 = closest to 50% — most information) and
// is_best_edge within its group. Mutates the plays in-place.
function annotateGroups(plays) {
  const groups = new Map();
  for (const p of plays) {
    const gid = groupId(p);
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

function _findPlayer(players, name) {
  if (!players || !name) return undefined;
  if (players[name] !== undefined) return players[name];
  const target = _normName(name);
  for (const k in players) {
    if (_normName(k) === target) return players[k];
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
      case "points":        actual = ps.points ?? 0; break;
      case "rebounds":      actual = ps.rebounds ?? 0; break;
      case "assists":       actual = ps.assists ?? 0; break;
      case "threePointers": actual = ps.threePointers ?? 0; break;
      default: return null;
    }
    return { won: actual >= th, actualValue: actual };
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
  const rows = await neonQuery(
    `SELECT id, sport, stat, game_type, player_name, home_team, away_team,
            scoring_team, pick_team, pick_line, threshold, direction,
            game_date, game_time, features
     FROM shadow_plays
     WHERE resolved = FALSE
       AND game_date < $1
       AND home_team IS NOT NULL
       AND away_team IS NOT NULL
     LIMIT 2000`,
    [today],
    env
  );

  if (!rows.length) {
    return jsonResponse({ ok: true, resolved: 0, skipped: 0, noData: 0, durationMs: Date.now() - t0 });
  }

  // Build unique game keys per date. Key: sport:away:home[@gameTime] — matches /api/live format.
  const keysByDate = new Map(); // game_date → Set<rawKey>
  const rowToKey = new Map();   // row.id → rawKey

  for (const row of rows) {
    const { sport, home_team, away_team, game_date, game_time } = row;
    let rawKey = `${sport}:${away_team}:${home_team}`;
    if (game_time) rawKey += `@${game_time}`;
    rowToKey.set(row.id, rawKey);
    if (!keysByDate.has(game_date)) keysByDate.set(game_date, new Set());
    keysByDate.get(game_date).add(rawKey);
  }

  // Fetch final boxscores from /api/live (one call per distinct game_date).
  const liveByKey = new Map(); // `rawKey|game_date` → game object

  const origin = new URL(request.url).origin;
  await Promise.all([...keysByDate.entries()].map(async ([game_date, keys]) => {
    const gamesParam = [...keys].join(",");
    try {
      const res = await fetch(`${origin}/api/live?games=${encodeURIComponent(gamesParam)}&date=${game_date}`, {
        headers: { "User-Agent": "shadow-resolver/1.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const [k, v] of Object.entries(data)) {
        liveByKey.set(`${k}|${game_date}`, v);
      }
    } catch {}
  }));

  // Resolve each row.
  const updates = [];
  let skipped = 0;
  let noData = 0;

  for (const row of rows) {
    const rawKey = rowToKey.get(row.id);
    const game = liveByKey.get(`${rawKey}|${row.game_date}`);
    if (!game) { noData++; continue; } // game not found in ESPN — leave unresolved
    const result = _resolveRow(row, game);
    if (result === null) { skipped++; continue; }
    updates.push({ id: row.id, won: result.won, actualValue: result.actualValue });
  }

  if (updates.length) await neonBatchResolve(updates, env);

  return jsonResponse({ ok: true, resolved: updates.length, skipped, noData, durationMs: Date.now() - t0 });
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function handleShadowRoutes({ path, request, env }) {
  const shadowResolverResp = await handleShadowResolver({ path, request, env });
  if (shadowResolverResp) return shadowResolverResp;

  if (path !== "shadow-snapshot") return null;

  // Auth: Vercel cron runner attaches Authorization: Bearer ${CRON_SECRET}.
  if (!env?.CRON_SECRET) return errorResponse("CRON_SECRET not set", 500);
  const cronAuth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/, "");
  if (cronAuth !== env.CRON_SECRET) return errorResponse("Forbidden", 403);

  if (!env?.POSTGRES_URL && !env?.NEON_DATABASE_URL) return errorResponse("POSTGRES_URL not set", 500);

  const snapshotDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const t0 = Date.now();

  // Ensure table exists (no-op if already created). DDL uses neonExec (no prepared stmt).
  await neonExec(CREATE_TABLE_SQL, env);
  // One-time: drop debug table left from initial Neon wiring session (2026-06-01).
  await neonQuery("DROP TABLE IF EXISTS _shadow_init_test", [], env).catch(() => {});

  // Fetch tonight debug response — uses cached Kalshi snaps, doesn't bust external APIs.
  const origin = new URL(request.url).origin;
  const tonightResp = await fetch(`${origin}/api/tonight?debug=1`, {
    headers: { "x-shadow-internal": "1" },
  });
  if (!tonightResp.ok) {
    return errorResponse(`tonight fetch failed: ${tonightResp.status}`, 502);
  }
  const tonight = await tonightResp.json();

  // Combine qualified plays + dc-dropped plays. preDropped plays often lack truePct.
  const rawPlays = [...(tonight.plays || []), ...(tonight.dropped || [])];

  // Filter: must have a computed truePct, and game must be on today's PT date.
  const plays = rawPlays.filter(p =>
    typeof p.truePct === "number" && !isNaN(p.truePct) &&
    (p.gameDate === snapshotDate || !p.gameDate)
  );

  if (!plays.length) {
    return jsonResponse({ ok: true, snapshotDate, logged: 0, durationMs: Date.now() - t0 });
  }

  annotateGroups(plays);

  const rows = plays.map(p => ({
    id: shadowId(p),
    snapshot_date: snapshotDate,
    sport: p.sport || null,
    stat: p.stat || null,
    game_type: p.gameType || null,
    player_name: p.playerName || null,
    player_id: String(p.playerId || ""),
    home_team: p.homeTeam || null,
    away_team: p.awayTeam || null,
    scoring_team: p.scoringTeam || null,
    pick_team: p.pickTeam || null,
    pick_line: p.pickLine ?? null,
    threshold: p.threshold ?? null,
    direction: p.direction || null,
    model_true_pct: p.truePct,
    kalshi_pct: p.kalshiPct ?? null,
    no_kalshi_pct: p.noKalshiPct ?? null,
    edge: p.edge ?? null,
    dc: p.dataConfidence ?? null,
    dc_qualified: p.dcQualified ?? null,
    game_date: p.gameDate || null,
    game_time: p.gameTime || null,
    group_id: p._gid,
    group_size: p._groupSize,
    threshold_rank: p._rank,
    is_best_edge: p._isBestEdge ?? false,
    snapshot_model_version: p.modelVersion || "v2",
    season_type: p.seasonType ?? null,
    features: extractFeatures(p),
  }));

  await neonBatchUpsert(SHADOW_TABLE, COLUMNS, rows, env);

  return jsonResponse({
    ok: true,
    snapshotDate,
    logged: rows.length,
    qualified: tonight.plays?.length ?? 0,
    dropped: tonight.dropped?.length ?? 0,
    durationMs: Date.now() - t0,
  });
}
