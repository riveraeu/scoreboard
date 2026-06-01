// Pure-fetch HTTP client for Neon's serverless SQL API (Edge-compatible, no Node APIs).
// Neon HTTP endpoint: POST https://{host}/sql
// Auth: tries Neon-Connection-String header first (how @neondatabase/serverless works),
//       falls back to Basic auth from PG component vars if available.
// NEON_DATABASE_URL format: postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname

function _parseConnStr(connStr) {
  // Normalise protocol so URL constructor accepts it.
  const safe = connStr.replace(/^postgres(ql)?:\/\//, "https://");
  try {
    const u = new URL(safe);
    return {
      host: u.hostname,
      user: decodeURIComponent(u.username),
      pass: decodeURIComponent(u.password),
    };
  } catch {
    return null;
  }
}

export async function neonQuery(sql, params = [], env) {
  // Prefer unpooled (direct compute) URLs; HTTP SQL API requires a non-pooler endpoint.
  const connStr =
    env?.DATABASE_URL_UNPOOLED ||
    env?.POSTGRES_URL_NON_POOLING ||
    env?.NEON_DATABASE_URL ||
    env?.POSTGRES_URL;

  // PG component vars (also provided by Vercel's Neon integration).
  const pgHost = env?.PGHOST_UNPOOLED || env?.PGHOST;
  const pgUser = env?.PGUSER;
  const pgPass = env?.PGPASSWORD;
  const pgDb   = env?.PGDATABASE;

  if (!connStr && !pgHost) throw new Error("No Neon connection string or PG vars available");

  // Determine endpoint host and credentials.
  let host, user, pass, fullConnStr;
  if (pgHost && pgUser && pgPass && pgDb) {
    // Use component vars — no URL-parsing ambiguity with special chars in password.
    host = pgHost;
    user = pgUser;
    pass = pgPass;
    fullConnStr = connStr || `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/${pgDb}`;
  } else {
    const parsed = _parseConnStr(connStr);
    if (!parsed) throw new Error("Could not parse Neon connection string");
    ({ host, user, pass } = parsed);
    fullConnStr = connStr;
  }

  const resp = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": fullConnStr,
      "Authorization": `Basic ${btoa(`${user}:${pass}`)}`,
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
