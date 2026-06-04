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
  // COALESCE(game_date, snapshot_date::varchar) handles early-dropped prop rows
  // that lack game_date — snapshot_date (3pm PT) is the same calendar day as the game.
  const rows = await neonQuery(
    `SELECT id, sport, stat, game_type, player_name, home_team, away_team,
            scoring_team, pick_team, pick_line, threshold, direction,
            game_date, game_time, features, snapshot_date
     FROM shadow_plays
     WHERE resolved = FALSE
       AND COALESCE(game_date, snapshot_date::varchar) < $1
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
        const res = await fetch(`${origin}/api/live?games=${encodeURIComponent(gamesParam)}&date=${game_date}`, {
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
  }

  // Third pass: rows where game_date AND game_time were both null get effectiveDate=snapshot_date,
  // which may be a day early when the game is actually the next day (Kalshi markets open before
  // the ESPN schedule publishes for the following day). Retry with snapshot_date+1 and +2 for
  // these rows when the primary lookup is still unknown.
  const nullDateRows = rows.filter(r => !r.game_date && !r.game_time);
  if (nullDateRows.length > 0) {
    const offsetByDate = new Map(); // offsetDate → Set<baseKey>
    for (const row of nullDateRows) {
      const { rawKey, effectiveDate } = rowToKey.get(row.id);
      const primary = liveByKey.get(`${rawKey}|${effectiveDate}`);
      if (primary && primary.state !== "unknown") continue; // already resolved
      const baseKey = rawKey.includes("@") ? rawKey.slice(0, rawKey.indexOf("@")) : rawKey;
      const base = new Date(effectiveDate);
      for (const deltaDays of [1, 2]) {
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
          const res = await fetch(`${origin}/api/live?games=${encodeURIComponent(gamesParam)}&date=${game_date}`, {
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
    }
  }

  // Resolve each row.
  const updates = [];
  let skipped = 0;
  let noData = 0;

  for (const row of rows) {
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
    // may be a day early. Try offset dates +1 and +2 using the base key.
    if ((!game || game.state === "unknown") && !row.game_date && !row.game_time) {
      const baseKey = rawKey.includes("@") ? rawKey.slice(0, rawKey.indexOf("@")) : rawKey;
      const base = new Date(effectiveDate);
      for (const deltaDays of [1, 2]) {
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
  // P0: add kalshi_yes_price / kalshi_no_price decimal price columns (idempotent).
  await neonExec(ADD_KALSHI_PRICE_COLS_SQL, env).catch(() => {});
  // One-time: drop debug table left from initial Neon wiring session (2026-06-01).
  await neonQuery("DROP TABLE IF EXISTS _shadow_init_test", [], env).catch(() => {});
  // Idempotent backfill: fix prop rows with null home_team/away_team.
  // First pass (2026-06-02): used playerTeam/opponent — missed early-dropped plays.
  // Second pass (2026-06-02): also covers early drops that only have gameTeam1/gameTeam2.
  // The resolver only needs two team identifiers to find the ESPN game; order doesn't matter.
  await neonQuery(
    `UPDATE shadow_plays
     SET home_team = COALESCE(features->>'playerTeam', features->>'gameTeam1'),
         away_team = COALESCE(features->>'opponent',   features->>'gameTeam2')
     WHERE home_team IS NULL AND away_team IS NULL
       AND features IS NOT NULL
       AND (features::jsonb) ?| array['playerTeam', 'gameTeam1']`,
    [], env
  ).catch(() => {});
  // P0 backfill: populate decimal price columns for existing rows (idempotent — WHERE IS NULL).
  await neonQuery(
    `UPDATE shadow_plays
     SET kalshi_yes_price = kalshi_pct / 100,
         kalshi_no_price  = no_kalshi_pct / 100
     WHERE kalshi_yes_price IS NULL
       AND (kalshi_pct IS NOT NULL OR no_kalshi_pct IS NOT NULL)`,
    [], env
  ).catch(() => {});

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
    model_true_pct: p.truePct,
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
