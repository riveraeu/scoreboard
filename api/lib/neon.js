// Pure-fetch HTTP client for Neon's serverless SQL API (Edge-compatible, no Node APIs).
// Auth: Neon-Connection-String header only — matches how @neondatabase/serverless works.
// Do NOT add Authorization: Basic; Neon derives credentials from the connection string header.
// NEON_DATABASE_URL format: postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname

export async function neonQuery(sql, params = [], env) {
  // Vercel's Neon Marketplace integration sets DATABASE_URL_UNPOOLED for the direct endpoint.
  // The HTTP SQL API requires a direct (non-pooled) compute endpoint.
  const connStr =
    env?.DATABASE_URL_UNPOOLED ||
    env?.POSTGRES_URL_NON_POOLING ||
    env?.NEON_DATABASE_URL ||
    env?.POSTGRES_URL;
  if (!connStr) throw new Error("No Neon connection string available");

  const parsed = new URL(connStr.replace(/^postgresql:\/\//, "https://"));
  const host = parsed.hostname;

  const resp = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": connStr,
    },
    body: JSON.stringify({ query: sql, params }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => resp.statusText);
    throw new Error(`Neon ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  return data.rows ?? [];
}

// Batch-insert helper. Builds a single parameterized INSERT for up to `chunkSize` rows.
// Uses ON CONFLICT DO NOTHING for idempotent re-runs.
export async function neonBatchUpsert(table, columns, rows, env, chunkSize = 100) {
  if (!rows.length) return;
  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) chunks.push(rows.slice(i, i + chunkSize));

  for (const chunk of chunks) {
    const placeholders = chunk.map((_, ri) =>
      `(${columns.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(", ")})`
    ).join(", ");
    const values = chunk.flatMap(row => columns.map(col => row[col] ?? null));
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders} ON CONFLICT (id) DO NOTHING`;
    await neonQuery(sql, values, env);
  }
}
