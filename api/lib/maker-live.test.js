import { test } from "node:test";
import assert from "node:assert";
import { isArmed, setArmed, gameKeyFor, sellAsBuy } from "./maker-live.js";

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

// SHELVED 2026-07-28 (no demonstrated fillable edge; see docs/MAKER_LEADTIME_PREREG.md). The two
// tests below were "isArmed is true when both gates are true" and "setArmed round-trips" — both now
// assert FALSE, because the SHELVED constant in maker-live.js short-circuits ahead of both gates.
// Deliberately kept as inverted assertions rather than deleted: they are the tripwire that fails
// loudly if anyone flips SHELVED without also making that an explicit, reviewed decision.
test("isArmed: SHELVED overrides both gates being true", async () => {
  const env = { MAKER_V2_ARMED: "true" };
  const cache = fakeCache({ armed: true });
  assert.equal(await isArmed(env, cache), false,
    "V2 is shelved — if this fails, SHELVED was flipped in maker-live.js; that must be a deliberate, reviewed change");
});

test("setArmed cannot re-arm a shelved engine", async () => {
  const env = { MAKER_V2_ARMED: "true" };
  const cache = fakeCache(null);
  assert.equal(await isArmed(env, cache), false);
  await setArmed(cache, true);
  assert.equal(await isArmed(env, cache), false, "KV round-trip still cannot arm while shelved");
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

test("sellAsBuy: flips side and complements price", () => {
  assert.deepEqual(sellAsBuy("yes", 83), { side: "no", price: 17 });
  assert.deepEqual(sellAsBuy("no", 80), { side: "yes", price: 20 });
});

test("sellAsBuy: settlement-equivalent to actually selling `side` at `askCents` (2026-07-21 bug — V2 was buying the side computeMakerQuote meant to sell)", () => {
  for (const [side, ask] of [["yes", 83], ["no", 80], ["yes", 97], ["no", 55]]) {
    const buy = sellAsBuy(side, ask);
    // Sell `side`@ask: side wins -> ask-100 (owe the payout), side loses -> +ask (keep premium).
    const sellPnlIfSideWon = ask - 100;
    const sellPnlIfSideLost = ask;
    // Buy buy.side@buy.price: wins (buy.side happens, i.e. `side` LOST) -> 100-price, loses -> -price.
    const buyPnlIfBuySideWon = 100 - buy.price;
    const buyPnlIfBuySideLost = -buy.price;
    assert.equal(buyPnlIfBuySideWon, sellPnlIfSideLost, `${side}@${ask}: side loses <-> complementary buy wins`);
    assert.equal(buyPnlIfBuySideLost, sellPnlIfSideWon, `${side}@${ask}: side wins <-> complementary buy loses`);
  }
});
