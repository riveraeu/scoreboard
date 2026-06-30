// Web-API gzip helpers for Upstash values that would otherwise blow the 10MB request cap.
//
// Upstash rejects any HTTP request over 10MB ("Max Request Size"). Most KV values are small,
// but a few consolidated blobs (byteam:mlb — ~40 maps incl. historical per-team H2H/splits)
// grew past 10MB and their single un-chunked SET started failing SILENTLY (makeCache's cmd()
// swallows the rejection), so the key never persisted and the alert fired on every write.
// JSON gzips ~6-10×, so compressing the value at the read/write chokepoint keeps the request
// well under the cap with one logical key and no contract change for callers.
//
// Stored form is `gz:` + base64(gzip(utf8(str))). The `gz:` marker lets readers distinguish a
// compressed value from a legacy raw-JSON value (raw falls through to JSON.parse), so rollout is
// safe even if an old uncompressed value is still present. Web-API only (CompressionStream is
// global in the Node 18+/Fluid runtime) — no Node-only deps, matching the repo idiom.

const GZ_PREFIX = "gz:";

// base64 in chunks so a multi-MB byte array never overflows the call stack.
function _bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function _base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Compress a string → `gz:`-prefixed base64. Throws only on a genuinely broken runtime
// (no CompressionStream); callers wrap and fall back to a raw write.
export async function gzipToString(str) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(str));
  writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return GZ_PREFIX + _bytesToBase64(new Uint8Array(ab));
}

// Decompress a value produced by gzipToString. If the value is NOT `gz:`-prefixed it is
// returned unchanged (legacy raw JSON), so callers can JSON.parse the result either way.
export async function gunzipFromString(stored) {
  if (typeof stored !== "string" || !stored.startsWith(GZ_PREFIX)) return stored;
  const bytes = _base64ToBytes(stored.slice(GZ_PREFIX.length));
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const ab = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(ab);
}

export { GZ_PREFIX };
