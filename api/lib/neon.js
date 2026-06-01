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

export async function neonQuery(sql, params = [], env) {
  const connStr = _getConnStr(env);
  if (!connStr) throw new Error("No Neon connection string available (DATABASE_URL_UNPOOLED not set)");
  const sql_fn = _neon(connStr);
  // neon() tagged template doesn't support positional params directly.
  // Use the unsafe() helper for parameterized queries.
  const result = await sql_fn.query(sql, params);
  return result.rows ?? [];
}

// Batch-insert helper. Builds a single parameterized INSERT for up to `chunkSize` rows.
// Uses ON CONFLICT DO NOTHING for idempotent re-runs.
export async function neonBatchUpsert(table, columns, rows, env, chunkSize = 100) {
  if (!rows.length) return;
  const connStr = _getConnStr(env);
  if (!connStr) throw new Error("No Neon connection string available");
  const sql = _neon(connStr);

  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) chunks.push(rows.slice(i, i + chunkSize));

  for (const chunk of chunks) {
    const placeholders = chunk.map((_, ri) =>
      `(${columns.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(", ")})`
    ).join(", ");
    const values = chunk.flatMap(row => columns.map(col => row[col] ?? null));
    const insertSql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders} ON CONFLICT (id) DO NOTHING`;
    const result = await sql.query(insertSql, values);
    // neon.query returns a result object; errors throw automatically.
    void result;
  }
}
