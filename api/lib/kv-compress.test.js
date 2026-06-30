import { test } from "node:test";
import assert from "node:assert";
import { gzipToString, gunzipFromString, GZ_PREFIX } from "./kv-compress.js";

test("roundtrips an object through gzip", async () => {
  const obj = { a: 1, b: "hello", nested: { arr: [1, 2, 3], s: "café señor" } };
  const packed = await gzipToString(JSON.stringify(obj));
  assert.ok(packed.startsWith(GZ_PREFIX), "stored value carries the gz: marker");
  assert.deepStrictEqual(JSON.parse(await gunzipFromString(packed)), obj);
});

test("compresses a large repetitive payload well under its raw size", async () => {
  const big = JSON.stringify({ teams: Array.from({ length: 2000 }, (_, i) => ({ id: i, splits: [0.1, 0.2, 0.3], name: "Pitcher Name " + i })) });
  const packed = await gzipToString(big);
  assert.ok(packed.length < big.length / 2, "gzip+base64 is < half the raw JSON size");
  assert.strictEqual(await gunzipFromString(packed), big);
});

test("passes through legacy raw (non-gz) values unchanged", async () => {
  const raw = JSON.stringify({ legacy: true });
  assert.strictEqual(await gunzipFromString(raw), raw, "a value without the gz: marker is returned as-is");
});

test("handles multi-megabyte input (chunked base64, no stack overflow)", async () => {
  const big = "x".repeat(3 * 1024 * 1024) + "é"; // ~3MB + a multi-byte char
  const packed = await gzipToString(big);
  assert.strictEqual(await gunzipFromString(packed), big);
});
