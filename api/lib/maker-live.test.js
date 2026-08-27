import { test } from "node:test";
import assert from "node:assert";
import { isArmed, setArmed, gameKeyFor, sellAsBuy, matchLiveCell, groupExposureCents,
  groupRealizedCents, haltedGroups, totalExposureCents, reconciledFilledCount } from "./maker-live.js";
import { MAKER_V2_LIVE_CELLS, MAKER_V2_GLOBAL_CAP_CENTS } from "./config.js";

const TEST_CELLS = [
  { group: "wnba-points", sport: "wnba", category: "points", band: [20, 24], sizeContracts: 25, capCents: 3000, stopLossCents: -1500, resumeFrom: "2026-08-10" },
  { group: "wnba-points", sport: "wnba", category: "points", band: [25, 29], sizeContracts: 25, capCents: 3000, stopLossCents: -1500, resumeFrom: "2026-08-10" },
  { group: "mlb-f5total", sport: "mlb", category: "f5total", band: [10, 14], sizeContracts: 40, capCents: 3000, stopLossCents: -1500, resumeFrom: "2026-08-10" },
];

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

// SHELVED 2026-07-28 → UN-SHELVED 2026-08-24, scoped to the sub-50 trial only
// (docs/MAKER_V2_SUBFIFTY_TRIAL.md — see maker-live.js's SHELVED comment for the full history).
// Until 2026-08-24 these two tests asserted FALSE even with both gates true, because the SHELVED
// constant short-circuited ahead of them — that was the deliberate tripwire: it failed loudly if
// anyone flipped SHELVED without also updating this file, forcing the flip to be reviewed rather
// than silent. Now that SHELVED is deliberately false, the same tests run the other direction and
// serve the same purpose symmetrically: if SHELVED is ever reverted to true without updating
// these assertions back, THIS pair fails loudly instead.
test("isArmed: true when both gates are true and V2 is not shelved", async () => {
  const env = { MAKER_V2_ARMED: "true" };
  const cache = fakeCache({ armed: true });
  assert.equal(await isArmed(env, cache), true,
    "V2 is un-shelved (2026-08-24, sub-50 trial) — if this fails, SHELVED was reverted to true without updating this test");
});

test("setArmed round-trips now that V2 is un-shelved", async () => {
  const env = { MAKER_V2_ARMED: "true" };
  const cache = fakeCache(null);
  assert.equal(await isArmed(env, cache), false, "starts disarmed (KV flag not yet set)");
  await setArmed(cache, true);
  assert.equal(await isArmed(env, cache), true, "KV round-trip arms it");
  await setArmed(cache, false);
  assert.equal(await isArmed(env, cache), false, "KV round-trip disarms it again");
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

// ── Sub-50 one-sided live trial (2026-08-24, docs/MAKER_V2_SUBFIFTY_TRIAL.md) ──────────────────

test("matchLiveCell: matches on sport + category (row.stat, falling back to row.gameType — same expression maker.js uses for the category column)", () => {
  assert.deepEqual(matchLiveCell({ sport: "wnba", stat: "points" }, TEST_CELLS)?.band, [20, 24]);
  assert.deepEqual(matchLiveCell({ sport: "mlb", gameType: "f5total" }, TEST_CELLS)?.band, [10, 14]);
  assert.equal(matchLiveCell({ sport: "mlb", stat: "spread" }, TEST_CELLS), null, "no live cell for this category");
  assert.equal(matchLiveCell({ sport: "wnba", stat: "spread" }, TEST_CELLS), null, "wrong category, same sport");
});

test("matchLiveCell: never throws on a missing/malformed row", () => {
  assert.doesNotThrow(() => matchLiveCell(null, TEST_CELLS));
  assert.doesNotThrow(() => matchLiveCell({}, TEST_CELLS));
});

test("groupExposureCents: sums REAL cost basis (100 - price) x contracts for not-yet-graded rows only, per group — `price` is the SOLD side/price, the real order Kalshi executes is the complementary buy at (100 - price)", () => {
  const rows = [
    { live_group: "wnba-points", game_date: "2026-08-11", status: "resting", price: 22, size: 25, filled_count: 0, graded_at: null },
    { live_group: "wnba-points", game_date: "2026-08-11", status: "executed", price: 21, size: 25, filled_count: 25, graded_at: null },
    { live_group: "wnba-points", game_date: "2026-08-11", status: "executed", price: 20, size: 25, filled_count: 25, graded_at: "2026-08-25" }, // graded — excluded
    { live_group: "mlb-f5total", game_date: "2026-08-11", status: "resting", price: 12, size: 40, filled_count: 0, graded_at: null },
    { live_group: "wnba-points", game_date: "2026-08-11", status: "canceled", price: 23, size: 25, filled_count: 0, graded_at: null }, // canceled — excluded
  ];
  assert.equal(groupExposureCents(rows, "wnba-points", TEST_CELLS), (100 - 22) * 25 + (100 - 21) * 25);
  assert.equal(groupExposureCents(rows, "mlb-f5total", TEST_CELLS), (100 - 12) * 40);
  assert.equal(groupExposureCents(rows, "nonexistent-group", TEST_CELLS), 0);
});

test("groupRealizedCents: sums pnl_cents × filled_count for graded rows only, per group", () => {
  const rows = [
    { live_group: "wnba-points", game_date: "2026-08-11", graded_at: "2026-08-25", pnl_cents: -20, filled_count: 25 },
    { live_group: "wnba-points", game_date: "2026-08-11", graded_at: "2026-08-26", pnl_cents: 5, filled_count: 25 },
    { live_group: "wnba-points", game_date: "2026-08-11", status: "resting", graded_at: null, pnl_cents: null, filled_count: 0 }, // ungraded — excluded
    { live_group: "mlb-f5total", game_date: "2026-08-11", graded_at: "2026-08-25", pnl_cents: -10, filled_count: 40 },
  ];
  assert.equal(groupRealizedCents(rows, "wnba-points", TEST_CELLS), -20 * 25 + 5 * 25);
  assert.equal(groupRealizedCents(rows, "mlb-f5total", TEST_CELLS), -10 * 40);
});

test("haltedGroups: a group's realized PnL at or below its own stopLossCents halts ONLY that group", () => {
  // wnba-points stopLossCents is -1500; -20¢ x 100 contracts = -2000, breaches it.
  const rows = [
    { live_group: "wnba-points", game_date: "2026-08-11", graded_at: "2026-08-25", pnl_cents: -20, filled_count: 100 },
    { live_group: "mlb-f5total", game_date: "2026-08-11", graded_at: "2026-08-25", pnl_cents: -5, filled_count: 40 }, // -200, does not breach
  ];
  const halted = haltedGroups(rows, TEST_CELLS);
  assert.equal(halted.has("wnba-points"), true);
  assert.equal(halted.has("mlb-f5total"), false);
});

test("haltedGroups: empty/no history halts nothing", () => {
  assert.equal(haltedGroups([], TEST_CELLS).size, 0);
});

// ── Per-group ledger reset (2026-08-25, docs/MAKER_V2_SUBFIFTY_TRIAL.md re-arm) ─────────────────
// wnba-points breached its real stop-loss under the pre-fix exposure-cap bug; re-arming gives it a
// fresh ledger via a later `resumeFrom` rather than staying permanently halted against bug-era rows.

test("groupRealizedCents / haltedGroups: rows before a group's own resumeFrom are excluded — a ledger reset actually resets", () => {
  const RESET_CELLS = [
    { group: "wnba-points", sport: "wnba", category: "points", band: [20, 24], sizeContracts: 25, capCents: 3000, stopLossCents: -1500, resumeFrom: "2026-08-25" },
    { group: "mlb-f5total", sport: "mlb", category: "f5total", band: [10, 14], sizeContracts: 40, capCents: 3000, stopLossCents: -1500, resumeFrom: "2026-08-24" },
  ];
  const rows = [
    // Pre-reset wnba-points loss — breaches stop-loss on its own, but predates resumeFrom.
    { live_group: "wnba-points", game_date: "2026-08-24", graded_at: "2026-08-24", pnl_cents: -60, filled_count: 100 },
    // Post-reset wnba-points result — small win, should count.
    { live_group: "wnba-points", game_date: "2026-08-25", graded_at: "2026-08-25", pnl_cents: 3, filled_count: 25 },
    // mlb-f5total's resumeFrom is unchanged (2026-08-24) — its pre-existing history still counts.
    { live_group: "mlb-f5total", game_date: "2026-08-24", graded_at: "2026-08-24", pnl_cents: 28, filled_count: 40 },
  ];
  assert.equal(groupRealizedCents(rows, "wnba-points", RESET_CELLS), 3 * 25,
    "the pre-reset -6000 loss must not be summed once resumeFrom moves past it");
  assert.equal(groupRealizedCents(rows, "mlb-f5total", RESET_CELLS), 28 * 40);
  const halted = haltedGroups(rows, RESET_CELLS);
  assert.equal(halted.has("wnba-points"), false, "reset ledger is a small win, not halted");
  assert.equal(halted.has("mlb-f5total"), false);
});

test("groupExposureCents: rows before a group's own resumeFrom are excluded from exposure too", () => {
  const RESET_CELLS = [
    { group: "wnba-points", sport: "wnba", category: "points", band: [20, 24], sizeContracts: 25, capCents: 3000, stopLossCents: -1500, resumeFrom: "2026-08-25" },
  ];
  const rows = [
    { live_group: "wnba-points", game_date: "2026-08-24", status: "resting", price: 22, size: 25, filled_count: 0, graded_at: null },
    { live_group: "wnba-points", game_date: "2026-08-25", status: "resting", price: 21, size: 25, filled_count: 0, graded_at: null },
  ];
  assert.equal(groupExposureCents(rows, "wnba-points", RESET_CELLS), (100 - 21) * 25,
    "only the post-resumeFrom resting order counts");
});

test("totalExposureCents: sums groupExposureCents across every distinct group in cells", () => {
  const rows = [
    { live_group: "wnba-points", game_date: "2026-08-10", status: "resting", price: 22, size: 25, filled_count: 0, graded_at: null },
    { live_group: "mlb-f5total", game_date: "2026-08-10", status: "resting", price: 12, size: 40, filled_count: 0, graded_at: null },
    // Graded rows must not count toward exposure (same rule groupExposureCents enforces per group).
    { live_group: "mlb-f5total", game_date: "2026-08-10", status: "executed", price: 12, size: 40, filled_count: 40, graded_at: "2026-08-11T00:00:00Z" },
  ];
  assert.equal(totalExposureCents(rows, TEST_CELLS), (100 - 22) * 25 + (100 - 12) * 40,
    "sums the two groups' outstanding exposure only, ignoring the already-graded row");
});

test("totalExposureCents: zero on empty history", () => {
  assert.equal(totalExposureCents([], TEST_CELLS), 0);
});

// 2026-08-26 fix — a real order (KXWNBAPTS-...-SEAFJOHNSON4-20) filled 4.12 contracts then 20.88
// more four minutes later, same order_id, on a 25-count resting order. The pre-fix code recorded
// only the first piece (filled_count=4), flipped the row to 'executed', and never saw the second
// fill. reconciledFilledCount is the arithmetic that closes this: reproduces the exact incident,
// then the boundary cases around it.
test("reconciledFilledCount: reproduces the 2026-08-26 incident — a multi-piece fill sums correctly", () => {
  assert.equal(reconciledFilledCount(4, 25, 25), 25,
    "the order's true total (4.12+20.88, rounded to 25) must replace the stale first-piece-only value");
});

test("reconciledFilledCount: never regresses below what was already recorded", () => {
  assert.equal(reconciledFilledCount(25, 25, 4), 25,
    "a partial-window read that only sees the smaller/earlier fill must not erase a real later one");
});

test("reconciledFilledCount: never exceeds the order's own size", () => {
  assert.equal(reconciledFilledCount(0, 25, 40), 25,
    "a duplicate or misattributed fill event must not overcount past 100% of the order");
});

test("reconciledFilledCount: takes the fresh window sum when it's the larger, still-valid figure", () => {
  assert.equal(reconciledFilledCount(4, 25, 21), 21);
});

// 2026-08-26 expansion (docs/MAKER_V2_SUBFIFTY_TRIAL.md § Expansion) — a portfolio-level backstop
// only means something if it's actually tighter than what the per-group caps would allow combined;
// this pins that invariant so a future cap bump can't silently make the global cap a no-op.
test("MAKER_V2_GLOBAL_CAP_CENTS is below the sum of all live cells' per-group caps", () => {
  const groups = [...new Set(MAKER_V2_LIVE_CELLS.map(c => c.group))];
  const sumOfCaps = groups.reduce((sum, g) => sum + MAKER_V2_LIVE_CELLS.find(c => c.group === g).capCents, 0);
  assert.ok(MAKER_V2_GLOBAL_CAP_CENTS < sumOfCaps,
    `global cap ${MAKER_V2_GLOBAL_CAP_CENTS} must stay below the summed per-group caps ${sumOfCaps} to bind`);
});

test("2026-08-26 diagnostic cells are present with the documented reduced sizing", () => {
  const negctrl = MAKER_V2_LIVE_CELLS.find(c => c.group === "mlb-hrr-negctrl");
  assert.deepEqual(negctrl, { group: "mlb-hrr-negctrl", sport: "mlb", category: "hrr", band: [30, 34],
    sizeContracts: 20, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-26" });

  const killdiag = MAKER_V2_LIVE_CELLS.find(c => c.group === "wnba3p-killdiag");
  assert.deepEqual(killdiag, { group: "wnba3p-killdiag", sport: "wnba", category: "threePointers", band: [60, 64],
    sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-26" });

  const onesided = MAKER_V2_LIVE_CELLS.find(c => c.group === "wnbasp-onesided");
  assert.deepEqual(onesided, { group: "wnbasp-onesided", sport: "wnba", category: "spread", band: [20, 24],
    sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-26" });
});

// 2026-08-27 addition (docs/MAKER_V2_SUBFIFTY_TRIAL.md § Addition 2026-08-27) — NOT diagnostic,
// a normal candidate cleared both free gates (robustness bar + netting screen) and went straight
// to a live cell per the 2026-08-26 process change. Still halved sizing pending the machinery
// proving clean at n>4 groups.
test("2026-08-27 wnbapts-1014 cell is present with the documented reduced sizing", () => {
  const wnbapts1014 = MAKER_V2_LIVE_CELLS.find(c => c.group === "wnbapts-1014");
  assert.deepEqual(wnbapts1014, { group: "wnbapts-1014", sport: "wnba", category: "points", band: [10, 14],
    sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-27" });
});

// 2026-08-27 re-arm (docs/MAKER_V2_SUBFIFTY_TRIAL.md § Incident) — re-armed at the HALVED sizing,
// not restored to its pre-halt $30/$15, since this group's own bug is why the halving discipline
// exists. Fresh resumeFrom, both bands.
test("2026-08-27 wnba-points is re-armed at halved sizing with a fresh resumeFrom", () => {
  const cells = MAKER_V2_LIVE_CELLS.filter(c => c.group === "wnba-points");
  assert.equal(cells.length, 2);
  assert.deepEqual(cells.find(c => c.band[0] === 20),
    { group: "wnba-points", sport: "wnba", category: "points", band: [20, 24],
      sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-27" });
  assert.deepEqual(cells.find(c => c.band[0] === 25),
    { group: "wnba-points", sport: "wnba", category: "points", band: [25, 29],
      sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-27" });
});
