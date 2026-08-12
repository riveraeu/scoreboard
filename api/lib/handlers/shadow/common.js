// api/lib/handlers/shadow/common.js
// Shared surface for the shadow-* route handlers. Extracted from handlers/shadow.js during the
// handler split (zero behavior change) — table names + column lists + CREATE/ALTER DDL (referenced
// by the snapshot writer, the resolver/pregame updaters, the report reader, and the delta handlers)
// plus the resolution-count high-water-mark helpers shared by the resolver and the report.

import { isNonFinalTerminal } from "../../settlement-reconcile.js";

export const SHADOW_TABLE = "shadow_plays";

export const COLUMNS = [
  "id", "snapshot_date", "sport", "stat", "game_type",
  "player_name", "player_id", "home_team", "away_team",
  "scoring_team", "pick_team", "pick_line", "threshold", "direction",
  "model_true_pct", "model_free", "kalshi_pct", "no_kalshi_pct", "edge",
  "dc", "dc_qualified", "game_date", "game_time", "kalshi_ticker", "kalshi_side",
  "group_id", "group_size", "threshold_rank", "is_best_edge",
  "snapshot_model_version", "season_type", "features",
  "kalshi_yes_price", "kalshi_no_price",
];

export const CREATE_TABLE_SQL = `
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
  model_true_pct NUMERIC,
  model_free BOOLEAN NOT NULL DEFAULT FALSE,
  kalshi_pct NUMERIC,
  no_kalshi_pct NUMERIC,
  edge NUMERIC,
  dc INTEGER,
  dc_qualified BOOLEAN,
  game_date TEXT,
  game_time TEXT,
  kalshi_ticker TEXT,
  kalshi_side TEXT,
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

// Pre-game price columns for CLV / line-movement tracking.
export const ADD_PRE_PRICE_COLS_SQL = `
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS kalshi_yes_price_pre NUMERIC;
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS kalshi_no_price_pre NUMERIC;
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS price_pre_at TIMESTAMPTZ
`;

// Model-free maker markets (2026-07-23): a market can be maker-quoted purely off Kalshi's own
// favorite-ask mispricing, with no probability model behind it (see project_maker_modelfree_
// clubsoccer_2026_07_23 memory). model_true_pct was NOT NULL, which silently blocked any such
// row from ever reaching shadow_plays — gradeMakerFills needs the row here to grade a fill.
// model_free flags these rows so Brier/calibration queries (which assume every row has a real
// truePct) can explicitly exclude them instead of corrupting n-vs-average counts.
export const ADD_MODEL_FREE_COLS_SQL = `
ALTER TABLE shadow_plays ALTER COLUMN model_true_pct DROP NOT NULL;
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS model_free BOOLEAN NOT NULL DEFAULT FALSE
`;

// Kalshi-settlement-based grading (2026-07-23, DRY-RUN ONLY — see kalshi-settlement.js and
// project_kalshi_settlement_grading_2026_07_23 memory). kalshi_ticker is the row's own market;
// kalshi_side ("yes"/"no") is which side of that ticker counts as a win for this row, derived
// once at write time (deriveKalshiSide) from fields already on the in-memory play object.
export const ADD_KALSHI_SETTLEMENT_COLS_SQL = `
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS kalshi_ticker TEXT;
ALTER TABLE shadow_plays ADD COLUMN IF NOT EXISTS kalshi_side TEXT
`;

// Polymarket cross-venue ML deltas (Phase 1a observatory). Its own table so the 4-daily snapshots
// accumulate into a multi-day Kalshi-vs-Polymarket divergence distribution (the kill-gate read).
// One row per game-side per day: id = `${date}|${sport}|${game}|${market}|${side}`, ON CONFLICT
// DO NOTHING keeps the first snapshot of the day. No resolution — this measures price divergence,
// not outcomes (ESPN scores are venue-independent; the model honesty lives in shadow_plays).
export const POLY_DELTAS_TABLE = "polymarket_deltas";
export const POLY_DELTAS_COLUMNS = [
  "id", "snapshot_date", "sport", "game", "game_date", "market", "side",
  "kalshi_pct", "poly_pct", "delta_cents", "model_true_pct",
  // Phase 1b: executable Poly buy price (book-walked at a $30 ref) — only the bettable [67,91]
  // sides carry these; exec_delta_cents = poly_vwap_pct − kalshi_pct (negative = surviving edge).
  "poly_vwap_pct", "poly_slip_cents", "exec_delta_cents",
];
export const CREATE_POLY_DELTAS_SQL = `
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
export const ADD_POLY_EXEC_COLS_SQL = `
ALTER TABLE ${POLY_DELTAS_TABLE} ADD COLUMN IF NOT EXISTS poly_vwap_pct NUMERIC;
ALTER TABLE ${POLY_DELTAS_TABLE} ADD COLUMN IF NOT EXISTS poly_slip_cents NUMERIC;
ALTER TABLE ${POLY_DELTAS_TABLE} ADD COLUMN IF NOT EXISTS exec_delta_cents NUMERIC
`;

// Polymarket capture-all plays (2026-08-04) — the Poly analog of shadow_plays: ONE model-free row
// per quoted side of every game-ML / total / first-five (F5) market, captured pre-game with its own
// CLOB best-ask + spread (same capture doctrine as Kalshi: band [1,99]¢, capturableSpread ≤15¢, own
// ask never 1−yes). Separate from polymarket_deltas (that's ML-only Kalshi-vs-Poly price deltas with
// NO resolution); this table CARRIES resolution — `won` is graded off Poly's own UMA settlement
// (winner = the outcome that settles to $1). Substrate for the venue-vig cross-venue view; NOT the
// maker-fill instrument. id = `${snapshot_date}|${token_id}` (one capture per side per day, latest
// snapshot wins). market_id = the Gamma market id, the resolver's per-market refetch key.
export const POLY_PLAYS_TABLE = "polymarket_plays";
export const POLY_PLAYS_COLUMNS = [
  "id", "snapshot_date", "sport", "event_ticker", "market_id", "category", "game", "game_date",
  "token_id", "outcome", "side", "line", "ask_c", "bid_c", "spread_c", "gamma_price_c",
  "model_free", "won", "resolved",
];
export const CREATE_POLY_PLAYS_SQL = `
CREATE TABLE IF NOT EXISTS ${POLY_PLAYS_TABLE} (
  id TEXT PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  sport TEXT NOT NULL,
  event_ticker TEXT NOT NULL,
  market_id TEXT NOT NULL,
  category TEXT NOT NULL,
  game TEXT,
  game_date TEXT,
  token_id TEXT NOT NULL,
  outcome TEXT,
  side TEXT,
  line NUMERIC,
  ask_c NUMERIC,
  bid_c NUMERIC,
  spread_c NUMERIC,
  gamma_price_c NUMERIC,
  model_free BOOLEAN DEFAULT TRUE,
  won BOOLEAN,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS polymarket_plays_date_idx ON ${POLY_PLAYS_TABLE} (snapshot_date);
CREATE INDEX IF NOT EXISTS polymarket_plays_sport_idx ON ${POLY_PLAYS_TABLE} (sport);
CREATE INDEX IF NOT EXISTS polymarket_plays_unresolved_idx ON ${POLY_PLAYS_TABLE} (resolved) WHERE resolved = FALSE;
`;

// Sportsbook-reference deltas (Phase 1a, 2026-06-29) — de-vigged sharp-book ML fair value vs the
// Kalshi price. One row per game-side per day. delta_cents = book_fair_pct − kalshi_pct (+ = Kalshi
// cheap vs the sharp book = lagging = edge to BUY). No resolution — measures price divergence, not
// outcomes (the kill-gate is "does Kalshi systematically lag the book?"). `book` = source bookmaker.
export const SB_DELTAS_TABLE = "sportsbook_deltas";
export const SB_DELTAS_COLUMNS = [
  "id", "snapshot_date", "sport", "game", "game_date", "market", "side",
  "kalshi_pct", "book_fair_pct", "delta_cents", "book", "model_true_pct",
];
export const CREATE_SB_DELTAS_SQL = `
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

// ── Resolution-count high-water mark ──────────────────────────────────────────
// Shared by the resolver (stamps yesterday's true count) and the report (reads it, replica-lag
// immune). total/resolved/scored/clv are MONOTONIC (resolutions only ADD; rows never un-resolve
// or get deleted), so the SQL read is max-merged with the KV stamp and the floor written back.
export const _RESOLUTION_SQL = `
  SELECT COUNT(*) AS total, SUM(resolved::int) AS resolved,
    SUM((won IS NOT NULL)::int) AS scored,
    SUM((kalshi_yes_price_pre IS NOT NULL)::int) AS clv_captured
  FROM shadow_plays WHERE game_date = $1`;

export function _parseResolutionRow(row) {
  if (!row) return null;
  return {
    total: Number(row.total ?? 0),
    resolved: Number(row.resolved ?? 0),
    scored: Number(row.scored ?? 0),
    clvCaptured: Number(row.clv_captured ?? 0),
  };
}

export function _mergeResolution(a, b) {
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
export const _RESOLUTION_KV_PREFIX = "shadow:resolution:";
export const _RESOLUTION_KV_TTL = 30 * 3600; // 30h — survives overnight resolver → 6am report → daytime reads

export async function _stampResolutionFloor(date, row, cache) {
  if (!cache) return row;
  const key = `${_RESOLUTION_KV_PREFIX}${date}`;
  const prev = await cache.get(key, "json").catch(() => null); // {total,resolved,scored,clvCaptured}
  const merged = _mergeResolution(row, prev);
  if (merged && merged.total > 0) {
    cache.put(key, JSON.stringify(merged), { expirationTtl: _RESOLUTION_KV_TTL }).catch(() => {});
  }
  return merged || row;
}

// ── ESPN resolution helpers (name matching + per-row win/actualValue) ──────────
// Shared by the resolver, resolveOpenMakerPositions, the tennis grader, and the snapshot body.
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
  // `state === "post"` alone is NOT "the game finished" — ESPN reports POSTPONED / CANCELED /
  // SUSPENDED with state:"post", completed:false and 0-0 scores. Grading that as a final is
  // silently catastrophic on totals (every under wins, every over loses) and was exactly what
  // happened to the 2026-07-27 CLE@CIN rows. `isNonFinalTerminal` owns the `=== false` test so
  // the cached-payload rule lives in one place.
  if (!game || game.state !== "post" || isNonFinalTerminal(game)) return null;

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

export { _normName, _fuzzyName, _editDist, _findPlayer, _resolveRow };
