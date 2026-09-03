import { test } from "node:test";
import assert from "node:assert";
import { isArmed, setArmed, gameKeyFor, sellAsBuy, matchLiveCell, candidateLiveCells,
  computeWantedMakerQuotes, groupExposureCents, groupRealizedCents, haltedGroups,
  totalExposureCents, reconciledFilledCount,
  liveOrderPassTelemetryCommands, MAKER_V2_QUOTEPASS_KEY_PREFIX, MAKER_V2_QUOTEPASS_TTL_S } from "./maker-live.js";
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

test("candidateLiveCells: returns every cell for a sport + category (row.stat, falling back to row.gameType — same expression maker.js uses for the category column), not just one", () => {
  assert.deepEqual(candidateLiveCells({ sport: "wnba", stat: "points" }, TEST_CELLS).map(c => c.band), [[20, 24], [25, 29]]);
  assert.deepEqual(candidateLiveCells({ sport: "mlb", gameType: "f5total" }, TEST_CELLS).map(c => c.band), [[10, 14]]);
  assert.deepEqual(candidateLiveCells({ sport: "mlb", stat: "spread" }, TEST_CELLS), [], "no live cell for this category");
  assert.deepEqual(candidateLiveCells({ sport: "wnba", stat: "spread" }, TEST_CELLS), [], "wrong category, same sport");
});

test("candidateLiveCells: never throws on a missing/malformed row", () => {
  assert.doesNotThrow(() => candidateLiveCells(null, TEST_CELLS));
  assert.doesNotThrow(() => candidateLiveCells({}, TEST_CELLS));
});

// matchLiveCell is a thin, NOT-band-aware convenience (first candidate only) — kept for the common
// single-cell-per-category case. It must never be used to pick a cell for a sport+category with
// more than one band (see the regression tests below) — computeWantedMakerQuotes uses
// candidateLiveCells directly for exactly that reason.
test("matchLiveCell: single-cell categories still resolve correctly", () => {
  assert.deepEqual(matchLiveCell({ sport: "mlb", gameType: "f5total" }, TEST_CELLS)?.band, [10, 14]);
  assert.equal(matchLiveCell({ sport: "mlb", stat: "spread" }, TEST_CELLS), null, "no live cell for this category");
});

test("matchLiveCell: never throws on a missing/malformed row", () => {
  assert.doesNotThrow(() => matchLiveCell(null, TEST_CELLS));
  assert.doesNotThrow(() => matchLiveCell({}, TEST_CELLS));
});

// ── Regression: 2026-08-27..31 bug — a sport+category with >1 band-distinct cell silently starved
// every cell but the array's first, because matching used to stop at sport+category alone. Fixed
// version must pick the candidate whose band actually contains the market's ask, not array order. ──

function _market(ticker, { yesAsk, yesBid, noAsk, noBid }) {
  return { ticker, yes_ask: yesAsk, yes_bid: yesBid, no_ask: noAsk, no_bid: noBid };
}
function _stagingRow(ticker, sport, stat) {
  return { kalshiTicker: ticker, sport, stat, direction: "over", gameTime: new Date(Date.now() + 3600_000).toISOString() };
}

test("computeWantedMakerQuotes: disambiguates same-sport-category cells by which band the market's ask actually falls in", () => {
  const cells = [
    { group: "wnbapts-1014", sport: "wnba", category: "points", band: [10, 14], sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-27" },
    { group: "wnba-points", sport: "wnba", category: "points", band: [20, 24], sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-27" },
    { group: "wnba-points", sport: "wnba", category: "points", band: [25, 29], sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-27" },
  ];
  const rows = [
    _stagingRow("T-1014", "wnba", "points"),
    _stagingRow("T-2024", "wnba", "points"),
    _stagingRow("T-2529", "wnba", "points"),
  ];
  const staging = { plays: rows, dropped: [] };
  const snapResults = {
    KXWNBAPTS: {
      markets: [
        _market("T-1014", { yesAsk: 12, yesBid: 8, noAsk: 90, noBid: 86 }),  // belongs to wnbapts-1014
        _market("T-2024", { yesAsk: 22, yesBid: 18, noAsk: 80, noBid: 76 }), // belongs to wnba-points [20,24]
        _market("T-2529", { yesAsk: 27, yesBid: 23, noAsk: 75, noBid: 71 }), // belongs to wnba-points [25,29]
      ],
    },
  };
  const want = computeWantedMakerQuotes({ snapResults, staging, cells });
  assert.equal(want.get("T-1014")?.cell.group, "wnbapts-1014");
  assert.equal(want.get("T-2024")?.cell.group, "wnba-points", "20-24c row must NOT fall through to wnbapts-1014 just because that cell is listed first");
  assert.equal(want.get("T-2024")?.cell.band[0], 20);
  assert.equal(want.get("T-2529")?.cell.group, "wnba-points");
  assert.equal(want.get("T-2529")?.cell.band[0], 25);
});

test("computeWantedMakerQuotes: against the REAL production MAKER_V2_LIVE_CELLS, a wnba|points row at 22c resolves to wnba-points, not wnbapts-1014 (pins the exact 2026-08-27..31 incident)", () => {
  const staging = { plays: [_stagingRow("REAL-T-2024", "wnba", "points")], dropped: [] };
  const snapResults = {
    KXWNBAPTS: { markets: [_market("REAL-T-2024", { yesAsk: 22, yesBid: 18, noAsk: 80, noBid: 76 })] },
  };
  const want = computeWantedMakerQuotes({ snapResults, staging }); // default cells = MAKER_V2_LIVE_CELLS
  assert.equal(want.get("REAL-T-2024")?.cell.group, "wnba-points",
    "before the fix this resolved to wnbapts-1014 (band [10,14]) via array order, so a 22c row never matched any band and was silently dropped");
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

// 2026-08-27 addition (docs/MAKER_V2_SUBFIFTY_TRIAL.md § Addition 2026-08-27, second entry) —
// a re-screen of an 8/21 REJECT whose profile flipped from ISLAND to inverted-mirror. Halved sizing.
test("2026-08-27 wnbareb-6569 cell is present with the documented reduced sizing", () => {
  const wnbareb6569 = MAKER_V2_LIVE_CELLS.find(c => c.group === "wnbareb-6569");
  assert.deepEqual(wnbareb6569, { group: "wnbareb-6569", sport: "wnba", category: "rebounds", band: [65, 69],
    sizeContracts: 25, capCents: 1500, stopLossCents: -750, resumeFrom: "2026-08-27" });
});

// liveOrderPassTelemetryCommands — the V2 real-order placement pass's own durable per-day record
// (2026-09-03), mirroring quotePassTelemetryCommands (maker.js) exactly: same blind spot (the
// pass's return value otherwise lives only in the discarded cron HTTP response), same shape, found
// after mlb-hrr-negctrl went 2+ days with zero orders against a live in-band real book and there
// was no durable trace to diagnose why.
const V2_AT = "2026-09-03T16:45:00.000Z";
const V2_KEY = `${MAKER_V2_QUOTEPASS_KEY_PREFIX}2026-09-03`;
const v2CmdFor = (cmds, verb, field) =>
  cmds.find(c => c[0] === verb && (field === undefined || c[2] === field));

test("liveOrderPassTelemetryCommands: a healthy cycle increments ran + the sums", () => {
  const cmds = liveOrderPassTelemetryCommands("2026-09-03",
    { eligible: 3, opened: 1, capped: 0, canceled: 0, errors: 0, halted: [] }, V2_AT);
  assert.deepEqual(v2CmdFor(cmds, "HINCRBY", "cycles"), ["HINCRBY", V2_KEY, "cycles", 1]);
  assert.deepEqual(v2CmdFor(cmds, "HINCRBY", "ran"), ["HINCRBY", V2_KEY, "ran", 1]);
  assert.deepEqual(v2CmdFor(cmds, "HINCRBY", "sumEligible"), ["HINCRBY", V2_KEY, "sumEligible", 3]);
  assert.deepEqual(v2CmdFor(cmds, "HINCRBY", "sumOpened"), ["HINCRBY", V2_KEY, "sumOpened", 1]);
  assert.deepEqual(v2CmdFor(cmds, "HINCRBY", "sumCapped"), ["HINCRBY", V2_KEY, "sumCapped", 0]);
  assert.deepEqual(v2CmdFor(cmds, "HINCRBY", "sumCanceled"), ["HINCRBY", V2_KEY, "sumCanceled", 0]);
  assert.deepEqual(v2CmdFor(cmds, "HINCRBY", "sumPlaceErrors"), ["HINCRBY", V2_KEY, "sumPlaceErrors", 0]);
  for (const f of ["skippedDisarmed", "skippedNoStaging", "skippedNoSnaps", "errors"]) {
    assert.equal(v2CmdFor(cmds, "HINCRBY", f), undefined, `${f} must not increment`);
  }
  const hset = v2CmdFor(cmds, "HSET");
  assert.equal(hset[hset.indexOf("lastOutcome") + 1], "ran");
  assert.equal(hset[hset.indexOf("lastEligible") + 1], "3");
  assert.equal(hset[hset.indexOf("lastOpened") + 1], "1");
  assert.deepEqual(cmds.at(-1), ["EXPIRE", V2_KEY, MAKER_V2_QUOTEPASS_TTL_S]);
  assert.ok(MAKER_V2_QUOTEPASS_TTL_S >= 86400, "TTL must survive at least one night");
});

test("liveOrderPassTelemetryCommands: every skip branch (incl. disarmed) increments its OWN counter, never ran", () => {
  for (const [skipped, field] of [["disarmed", "skippedDisarmed"], ["no_staging", "skippedNoStaging"], ["no_snaps", "skippedNoSnaps"]]) {
    const cmds = liveOrderPassTelemetryCommands("2026-09-03", { skipped }, V2_AT);
    assert.deepEqual(v2CmdFor(cmds, "HINCRBY", field), ["HINCRBY", V2_KEY, field, 1]);
    assert.deepEqual(v2CmdFor(cmds, "HINCRBY", "cycles"), ["HINCRBY", V2_KEY, "cycles", 1]);
    assert.equal(v2CmdFor(cmds, "HINCRBY", "ran"), undefined, "a skipped cycle never counts as ran");
    assert.equal(v2CmdFor(cmds, "HINCRBY", "sumEligible"), undefined);
    const hset = v2CmdFor(cmds, "HSET");
    assert.equal(hset[hset.indexOf("lastOutcome") + 1], skipped);
  }
});

test("liveOrderPassTelemetryCommands: an error cycle records the message", () => {
  const cmds = liveOrderPassTelemetryCommands("2026-09-03", { error: "boom" }, V2_AT);
  assert.deepEqual(v2CmdFor(cmds, "HINCRBY", "errors"), ["HINCRBY", V2_KEY, "errors", 1]);
  assert.equal(v2CmdFor(cmds, "HINCRBY", "ran"), undefined);
  const hset = v2CmdFor(cmds, "HSET");
  assert.equal(hset[hset.indexOf("lastOutcome") + 1], "error");
  assert.equal(hset[hset.indexOf("lastError") + 1], "boom");
});

test("liveOrderPassTelemetryCommands: halted groups are recorded as a joined list", () => {
  const cmds = liveOrderPassTelemetryCommands("2026-09-03",
    { eligible: 1, opened: 0, capped: 0, canceled: 2, errors: 0, halted: ["wnba3p-killdiag", "wnbareb-6569"] }, V2_AT);
  const hset = v2CmdFor(cmds, "HSET");
  assert.equal(hset[hset.indexOf("lastHalted") + 1], "wnba3p-killdiag,wnbareb-6569");
});

test("liveOrderPassTelemetryCommands: counters are HINCRBY, never a read-modify-write GET/SET", () => {
  const cmds = liveOrderPassTelemetryCommands("2026-09-03",
    { eligible: 1, opened: 0, capped: 0, canceled: 0, errors: 0, halted: [] }, V2_AT);
  const verbs = new Set(cmds.map(c => c[0]));
  assert.ok(!verbs.has("GET") && !verbs.has("SET"), "no read-modify-write on the counter key");
  assert.deepEqual([...verbs].sort(), ["EXPIRE", "HINCRBY", "HSET"]);
});

test("liveOrderPassTelemetryCommands: absent fields are omitted, not stringified to 'null'", () => {
  const cmds = liveOrderPassTelemetryCommands("2026-09-03", { skipped: "no_staging" }, V2_AT);
  const hset = v2CmdFor(cmds, "HSET");
  assert.ok(!hset.includes("null") && !hset.includes("undefined"));
  assert.equal(hset.indexOf("lastEligible"), -1);
  assert.equal(hset.indexOf("lastHalted"), -1);
});
