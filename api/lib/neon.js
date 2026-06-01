// Pure-fetch HTTP client for Neon's serverless SQL API (Edge-compatible, no Node APIs).
// Mirrors the pattern used for Upstash Redis — direct HTTP, no npm driver.
// Neon HTTP endpoint: POST https://{host}/sql with Basic auth.
// NEON_DATABASE_URL format: postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname

export async function neonQuery(sql, params = [], env) {
  const connStr = env?.POSTGRES_URL || env?.NEON_DATABASE_URL;
  if (!connStr) throw new Error("POSTGRES_URL not set");

  const parsed = new URL(connStr.replace(/^postgresql:\/\//, "https://"));
  const host = parsed.hostname;
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);

  const resp = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${user}:${pass}`)}`,
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
