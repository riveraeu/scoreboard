// Neon database client using @neondatabase/serverless — Edge-compatible (uses fetch, not TCP).
// The package handles auth, connection string parsing, and HTTP endpoint routing automatically.
// Supports Vercel's Neon Marketplace integration (DATABASE_URL_UNPOOLED preferred for HTTP SQL).

import { neon as _neon } from "@neondatabase/serverless";

function _getConnStr(env) {
  // Prefer direct (non-pooled) connection for the HTTP SQL API.
  return (
    env?.DATABASE_URL_UNPOOLED ||
    env?.POSTGRES_URL_NON_POOLING ||
    env?.NEON_DATABASE_URL ||
    env?.POSTGRES_URL
  );
}

// For DDL and writes: prefer the pooled URL (primary write endpoint).
// DATABASE_URL_UNPOOLED may connect to a read-only replica on Vercel's Neon integration.
function _getWriteConnStr(env) {
  return (
    env?.POSTGRES_URL ||
    env?.DATABASE_URL_UNPOOLED ||
    env?.POSTGRES_URL_NON_POOLING ||
    env?.NEON_DATABASE_URL
  );
}

// opts.write: route the read through the pooled primary (write conn). Use for reads that
// need read-after-write consistency — DATABASE_URL_UNPOOLED may be a read-only replica that
// serves stale/empty results on cold wake (2026-06-11 resolver incident: 0 unresolved rows
// at 10:05 UTC vs 1051 on the primary).
export async function neonQuery(sql, params = [], env, opts = {}) {
  const connStr = opts.write ? _getWriteConnStr(env) : _getConnStr(env);
  if (!connStr) throw new Error("No Neon connection string available (DATABASE_URL_UNPOOLED not set)");
  const sql_fn = _neon(connStr);
  // sql.query() resolves to the rows array directly (not { rows: [...] }).
  return sql_fn.query(sql, params);
}

// For DDL: splits multi-statement SQL on semicolons and runs each via sql.query().
// Uses write connection string (pooled primary) — unpooled may be a read-only replica.
export async function neonExec(ddl, env) {
  const connStr = _getWriteConnStr(env);
  if (!connStr) throw new Error("No Neon write connection string available");
  const sql_fn = _neon(connStr);
  const stmts = ddl.split(";").map(s => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    await sql_fn.query(stmt, []);
  }
}

// ── Multi-row INSERT, chunked by BIND-PARAMETER count ────────────────────────────────────────
// Postgres binds at most 65535 parameters per statement. A multi-row INSERT of N rows × C columns
// sends N·C of them, so every unbatched builder carries a silent row ceiling of 65535/C — and
// crossing it does not degrade, it throws ("Database request failed" through the Neon HTTP driver,
// which names neither the limit nor the statement).
//
// `maker_quotes` (15 cols → 4369 rows) crossed its ceiling on 2026-08-12, when the Leagues Cup +
// Eredivisie builds added ~400 quote sides to a slate already near it, and then DEADLOCKED: the
// INSERT failed, so no segments were written, so the next cycle rebuilt the same oversized batch and
// failed identically. Quoting was dead for two days — the whole maker instrument, silently, while
// capture and grading looked fine — and the daily report's canned diagnosis blamed "tape replay or
// quoting did not run". It took the quote-pass telemetry to name it. Structurally the same failure as
// the HTTP 414 in kalshi-settlement.js: a request built from an unbounded collection with no size gate.
//
// Postgres' 65535 is NOT the binding limit here — Neon's HTTP transport gives out first. Measured
// 2026-08-13: a 4000-row × 15-col chunk (60000 params, ~1.7MB of SQL text + JSON params) still failed
// with the same opaque "Database request failed", while a 31-row insert on the same connection
// succeeded. So the budget is set by REQUEST SIZE, not the parameter ceiling: 8000 params keeps a
// chunk near ~200KB. The extra round-trips are a few per cron cycle and cost nothing that matters.
// Do not raise this to "use the real limit" — the real limit is not the one that was hit.
//
// `table`/`cols` are trusted identifiers from call sites, never user input (same convention as
// _makerBandCase's `col`); only the VALUES are ever parameterized.
export const PARAM_BUDGET = 8000;

export function insertChunkSize(colCount, budget = PARAM_BUDGET) {
  if (!Number.isInteger(colCount) || colCount <= 0) {
    throw new Error(`insertChunkSize: colCount must be a positive integer, got ${colCount}`);
  }
  return Math.max(1, Math.floor(budget / colCount));
}

// `rows` is an array of value arrays, each the same length as `cols`. Returns the row count sent.
export async function neonBatchInsert({ table, cols, rows, suffix = "", env, budget = PARAM_BUDGET }) {
  if (!rows?.length) return 0;
  const size = insertChunkSize(cols.length, budget);
  let sent = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const values = [];
    const tuples = chunk.map((r, ri) => {
      // A row of the wrong width silently shifts every subsequent placeholder onto the wrong value,
      // which writes plausible garbage rather than failing — worth one cheap check per row.
      if (r.length !== cols.length) {
        throw new Error(`neonBatchInsert(${table}): row ${i + ri} has ${r.length} values, expected ${cols.length}`);
      }
      values.push(...r);
      const base = ri * cols.length;
      return `(${cols.map((_, j) => `$${base + j + 1}`).join(", ")})`;
    });
    // Annotate with the CHUNK's own size, not the batch total. The caller's label reports the whole
    // batch, which cannot distinguish "the batch is too big" from "chunking is not working" — the
    // exact ambiguity that cost a deploy cycle on 2026-08-13.
    try {
      await neonQuery(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")}${suffix ? ` ${suffix}` : ""}`,
        values, env, { write: true });
    } catch (e) {
      e.message = `chunk ${Math.floor(i / size) + 1}/${Math.ceil(rows.length / size)} `
        + `(${chunk.length} rows, ${values.length} params): ${e?.message || e}`;
      throw e;
    }
    sent += chunk.length;
  }
  return sent;
}

// Batch-resolve helper. Updates resolved/won/actual_value/resolved_at on existing rows.
// Uses UPDATE FROM (VALUES ...) so each chunk is one round-trip.
export async function neonBatchResolve(updates, env, chunkSize = 100) {
  if (!updates.length) return;
  const connStr = _getWriteConnStr(env);
  if (!connStr) throw new Error("No Neon write connection string available");
  const sql = _neon(connStr);

  const chunks = [];
  for (let i = 0; i < updates.length; i += chunkSize) chunks.push(updates.slice(i, i + chunkSize));

  for (const chunk of chunks) {
    const placeholders = chunk.map((_, ri) =>
      `($${ri * 3 + 1}, $${ri * 3 + 2}::boolean, $${ri * 3 + 3}::numeric)`
    ).join(", ");
    const values = chunk.flatMap(u => [u.id, u.won ?? null, u.actualValue ?? null]);
    await sql.query(
      `UPDATE shadow_plays AS t SET resolved=TRUE, won=v.won, actual_value=v.actual_value, resolved_at=NOW()
       FROM (VALUES ${placeholders}) AS v(id, won, actual_value)
       WHERE t.id = v.id`,
      values
    );
  }
}

// Batch pre-game price update. Updates kalshi_yes_price_pre / kalshi_no_price_pre / price_pre_at
// only on rows that haven't been stamped yet (price_pre_at IS NULL guard in the WHERE).
export async function neonBatchPrePriceUpdate(updates, env, chunkSize = 100) {
  if (!updates.length) return;
  const connStr = _getWriteConnStr(env);
  if (!connStr) throw new Error("No Neon write connection string available");
  const sql = _neon(connStr);

  const chunks = [];
  for (let i = 0; i < updates.length; i += chunkSize) chunks.push(updates.slice(i, i + chunkSize));

  for (const chunk of chunks) {
    const placeholders = chunk.map((_, ri) =>
      `($${ri * 3 + 1}, $${ri * 3 + 2}::numeric, $${ri * 3 + 3}::numeric)`
    ).join(", ");
    const values = chunk.flatMap(u => [u.id, u.yes ?? null, u.no ?? null]);
    await sql.query(
      `UPDATE shadow_plays AS t
       SET kalshi_yes_price_pre = v.yes_price,
           kalshi_no_price_pre  = v.no_price,
           price_pre_at         = NOW()
       FROM (VALUES ${placeholders}) AS v(id, yes_price, no_price)
       WHERE t.id = v.id AND t.price_pre_at IS NULL`,
      values
    );
  }
}

// Batch-insert helper. Builds a single parameterized INSERT for up to `chunkSize` rows.
// ON CONFLICT (id) DO NOTHING for idempotent re-runs. Pass `updateOnConflict` (an array of column
// names) to instead DO UPDATE SET those = EXCLUDED — for tables where a later write should refresh
// an existing row (e.g. polymarket_deltas backfilling book-walked exec columns onto an earlier
// snapshot of the same day). shadow_plays keeps the default DO NOTHING (resolution is separate).
export async function neonBatchUpsert(table, columns, rows, env, chunkSize = 100, updateOnConflict = null) {
  if (!rows.length) return;
  const connStr = _getWriteConnStr(env);
  if (!connStr) throw new Error("No Neon write connection string available");
  const sql = _neon(connStr);

  const onConflict = (Array.isArray(updateOnConflict) && updateOnConflict.length)
    ? `ON CONFLICT (id) DO UPDATE SET ${updateOnConflict.map(c => `${c} = EXCLUDED.${c}`).join(", ")}`
    : "ON CONFLICT (id) DO NOTHING";

  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) chunks.push(rows.slice(i, i + chunkSize));

  for (const chunk of chunks) {
    const placeholders = chunk.map((_, ri) =>
      `(${columns.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(", ")})`
    ).join(", ");
    const values = chunk.flatMap(row => columns.map(col => row[col] ?? null));
    const insertSql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders} ${onConflict}`;
    await sql.query(insertSql, values);
  }
}
