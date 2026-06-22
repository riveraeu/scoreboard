// Shared Upstash pipeline writer, chunked by serialized size.
//
// Upstash rejects any HTTP request over 10MB ("Max Request Size"). A single-request
// write of the full Kalshi slate started failing 2026-06-12 (snapshot cron) and again
// via the legacy read-path bundle (2026-06-22) once soccer/fight/golf/nascar/WNBA-quarters
// shipped — and both bare fetches swallowed the 413s silently. Chunking at 7MB keeps every
// request well under the cap (largest single snap ≈ 2.5MB, so every command fits a chunk).
// Upstash bills per command, not per request, so chunking costs nothing extra.
//
// Never throws; returns { sent, failed, errors } so callers can surface failures into
// meta/response instead of losing them.
const PIPE_CHUNK_MAX_BYTES = 7 * 1024 * 1024;

export async function pipeWriteChunked({ url, token, cmds, maxBytes = PIPE_CHUNK_MAX_BYTES, label = "kv-pipeline" }) {
  const out = { sent: 0, failed: 0, errors: [] };
  if (!cmds || !cmds.length || !url || !token) return out;
  const chunks = [];
  let cur = [], curBytes = 2; // "[]"
  for (const c of cmds) {
    const n = JSON.stringify(c).length + 1; // +1 comma separator
    if (cur.length && curBytes + n > maxBytes) { chunks.push(cur); cur = []; curBytes = 2; }
    cur.push(c); curBytes += n;
  }
  if (cur.length) chunks.push(cur);
  for (const chunk of chunks) {
    try {
      const r = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(chunk),
      });
      if (!r.ok) {
        out.failed += chunk.length;
        out.errors.push(`HTTP ${r.status}`);
        continue;
      }
      const body = await r.json().catch(() => null);
      const errs = Array.isArray(body) ? body.filter(x => x?.error) : [];
      out.sent += chunk.length - errs.length;
      out.failed += errs.length;
      if (errs.length) out.errors.push(String(errs[0].error));
    } catch (e) {
      out.failed += chunk.length;
      out.errors.push(String(e?.message || e));
    }
  }
  if (out.errors.length) console.error(`[${label}] pipeline write failed:`, out.failed, "cmds —", out.errors[0]);
  return out;
}
