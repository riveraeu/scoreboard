import { test } from "node:test";
import assert from "node:assert";
import { insertChunkSize, neonBatchInsert, PARAM_BUDGET } from "./neon.js";

// Postgres' hard ceiling. The bug this guards against is not a slowdown — crossing it throws, and
// for maker_quotes it threw on a retry loop that rebuilt the same oversized batch every 2 minutes,
// so quoting stayed dead for two days (2026-08-12/13) with no segment written.
const PG_MAX_PARAMS = 65535;

test("insertChunkSize never lets a chunk exceed the Postgres bind-parameter limit", () => {
  // The invariant, over every column count a caller could plausibly have.
  for (let cols = 1; cols <= 80; cols++) {
    const size = insertChunkSize(cols);
    assert.ok(size >= 1, `cols=${cols} must allow at least one row per chunk`);
    assert.ok(size * cols <= PG_MAX_PARAMS,
      `cols=${cols}: ${size} rows × ${cols} = ${size * cols} exceeds ${PG_MAX_PARAMS}`);
  }
});

test("insertChunkSize leaves headroom below the hard limit", () => {
  // 60000, not 65535, so adding one column to a caller can't land it exactly on the edge.
  assert.ok(PARAM_BUDGET < PG_MAX_PARAMS);
  assert.equal(insertChunkSize(15), 4000); // maker_quotes
  assert.equal(insertChunkSize(6), 10000); // maker_fills
});

test("insertChunkSize rejects a non-positive column count instead of returning Infinity", () => {
  for (const bad of [0, -1, 1.5, null, undefined, "6"]) {
    assert.throws(() => insertChunkSize(bad), /positive integer/);
  }
});

// ── neonBatchInsert ──
// It executes through neonQuery, which needs a real connection, so the network-touching path is
// covered by the chunk math below rather than mocked. What IS asserted here is everything that
// happens before the first query: batching decisions and row validation.

test("the historical failure would now split into chunks, none over the limit", () => {
  const cols = 15, ROWS = 5486;
  const size = insertChunkSize(cols);
  const chunks = Math.ceil(ROWS / size);
  assert.ok(chunks > 1, "5486 rows × 15 cols must not go out as one statement");
  assert.equal(chunks, 2);
  // Every chunk, including the remainder, stays under the ceiling.
  for (let i = 0; i < ROWS; i += size) {
    assert.ok(Math.min(size, ROWS - i) * cols <= PG_MAX_PARAMS);
  }
  // And the pre-fix single statement would NOT have.
  assert.ok(ROWS * cols > PG_MAX_PARAMS, "the bug being fixed must actually exceed the limit");
});

test("neonBatchInsert is a no-op on an empty batch", async () => {
  assert.equal(await neonBatchInsert({ table: "t", cols: ["a"], rows: [], env: {} }), 0);
  assert.equal(await neonBatchInsert({ table: "t", cols: ["a"], rows: null, env: {} }), 0);
});

test("neonBatchInsert rejects a row of the wrong width rather than shifting placeholders", async () => {
  // A short row would slide every later value onto the wrong column and write plausible garbage.
  await assert.rejects(
    () => neonBatchInsert({ table: "t", cols: ["a", "b", "c"], rows: [[1, 2, 3], [4, 5]], env: {} }),
    /row 1 has 2 values, expected 3/);
});
