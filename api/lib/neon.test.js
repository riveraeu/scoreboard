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

test("the budget is sized by Neon's REQUEST limit, far below the param ceiling", () => {
  // Measured 2026-08-13: a 4000×15 chunk (60000 params, well under 65535) still failed against
  // Neon's HTTP transport. The binding constraint is request SIZE, so the budget is deliberately
  // an order of magnitude below the Postgres limit. A future "optimization" back toward 65535
  // reintroduces the outage — this assertion is the guard, not a style preference.
  assert.ok(PARAM_BUDGET <= 16000,
    `budget ${PARAM_BUDGET} is too close to the param ceiling; Neon fails on request size first`);
  assert.equal(insertChunkSize(15), 533);  // maker_quotes
  assert.equal(insertChunkSize(6), 1333);  // maker_fills
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

test("the real failing batch splits into chunks that each stay inside the budget", () => {
  // 5698×15 is the batch the live telemetry caught failing ([insert(5698x15)]), after an earlier
  // 4000-row chunking attempt had ALSO failed — so the test pins the observed batch, not a
  // hypothetical one.
  const cols = 15, ROWS = 5698;
  const size = insertChunkSize(cols);
  assert.ok(Math.ceil(ROWS / size) > 1, "must not go out as one statement");
  for (let i = 0; i < ROWS; i += size) {
    const params = Math.min(size, ROWS - i) * cols;
    assert.ok(params <= PARAM_BUDGET, `chunk at ${i} sends ${params} params, over budget`);
    assert.ok(params <= PG_MAX_PARAMS);
  }
  // Both prior states must be excluded: the unbatched statement AND the 4000-row chunk.
  assert.ok(ROWS * cols > PG_MAX_PARAMS, "unbatched exceeded even the Postgres ceiling");
  assert.ok(4000 * cols > PARAM_BUDGET, "the 4000-row chunk that still failed is now excluded");
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
