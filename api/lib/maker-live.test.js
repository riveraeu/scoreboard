import { test } from "node:test";
import assert from "node:assert";
import { isArmed, setArmed, gameKeyFor } from "./maker-live.js";

// Fake KV — just enough of the { get, put } contract used by isArmed/setArmed.
function fakeCache(initial = null) {
  let store = initial;
  return {
    get: async () => store,
    put: async (_key, val) => { store = val; },
  };
}

test("isArmed: fail-closed when env var is missing", async () => {
  const cache = fakeCache({ armed: true });
  assert.equal(await isArmed({}, cache), false);
  assert.equal(await isArmed({ MAKER_V2_ARMED: "false" }, cache), false);
});

test("isArmed: fail-closed when KV flag is missing or false", async () => {
  const env = { MAKER_V2_ARMED: "true" };
  assert.equal(await isArmed(env, fakeCache(null)), false);
  assert.equal(await isArmed(env, fakeCache({ armed: false })), false);
});

test("isArmed: fail-closed when no cache client at all", async () => {
  assert.equal(await isArmed({ MAKER_V2_ARMED: "true" }, null), false);
});

test("isArmed: true only when BOTH env var and KV flag are true", async () => {
  const env = { MAKER_V2_ARMED: "true" };
  const cache = fakeCache({ armed: true });
  assert.equal(await isArmed(env, cache), true);
});

test("setArmed round-trips through isArmed", async () => {
  const env = { MAKER_V2_ARMED: "true" };
  const cache = fakeCache(null);
  assert.equal(await isArmed(env, cache), false);
  await setArmed(cache, true);
  assert.equal(await isArmed(env, cache), true);
  await setArmed(cache, false);
  assert.equal(await isArmed(env, cache), false);
});

test("gameKeyFor: order-independent on home/away (ticker order != ESPN order)", () => {
  const a = { sport: "mlb", gameDate: "2026-07-21", homeTeam: "NYY", awayTeam: "BOS" };
  const b = { sport: "mlb", gameDate: "2026-07-21", homeTeam: "BOS", awayTeam: "NYY" };
  assert.equal(gameKeyFor(a), gameKeyFor(b));
});

test("gameKeyFor: different games produce different keys", () => {
  const a = { sport: "mlb", gameDate: "2026-07-21", homeTeam: "NYY", awayTeam: "BOS" };
  const b = { sport: "mlb", gameDate: "2026-07-21", homeTeam: "LAD", awayTeam: "SF" };
  assert.notEqual(gameKeyFor(a), gameKeyFor(b));
});

test("gameKeyFor: missing team fields don't throw", () => {
  assert.doesNotThrow(() => gameKeyFor({}));
  assert.doesNotThrow(() => gameKeyFor(null));
});
