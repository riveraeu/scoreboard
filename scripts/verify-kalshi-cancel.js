#!/usr/bin/env node
// One-time verification for the shadow-maker V2 cancel endpoint (see
// api/lib/kalshi-order-client.js — the cancel schema is unverified against a live call).
// Places ONE deliberately-unfillable test order (price defaults to 1c — a bid so far below
// any real market that it should never fill) on a ticker YOU choose, prints the raw response,
// then immediately cancels it and prints that raw response too. Requires a typed "yes"
// confirmation before either call fires — this places and cancels a REAL order on your funded
// Kalshi account, so it must be run by you directly, not by an agent.
//
// Usage:
//   node scripts/verify-kalshi-cancel.js --ticker=KXSOMETICKER-26JUL21-YES
//   node scripts/verify-kalshi-cancel.js --ticker=... --side=yes --price=1 --count=1
//
// Find a valid ticker first: curl -s "https://scoreboard-ivory-xi.vercel.app/api/kalshi?..." or
// look up any currently-listed market on kalshi.com and copy its ticker.

import { readFileSync } from "fs";
import readline from "readline";
import { placeKalshiOrder, cancelKalshiOrder } from "../api/lib/kalshi-order-client.js";

function loadEnvFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnvFile(".env.local");
loadEnvFile(".env.production.local");
loadEnvFile(".env.production");
loadEnvFile(".env");

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));

const ticker = args.ticker;
const side = args.side || "yes";
const price = args.price ? parseInt(args.price, 10) : 1;
const count = args.count ? parseInt(args.count, 10) : 1;

if (!ticker) {
  console.error("Error: --ticker=<TICKER> is required (no auto-picked market — you choose it).");
  console.error("Example: node scripts/verify-kalshi-cancel.js --ticker=KXSOMETICKER-26JUL21-YES");
  process.exit(1);
}
if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_PRIVATE_KEY) {
  console.error("Error: KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not set.");
  console.error("  Run: vercel env pull --environment=production .env.local");
  process.exit(1);
}

const env = { KALSHI_API_KEY_ID: process.env.KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY: process.env.KALSHI_PRIVATE_KEY };

console.log("This will place a REAL order on your funded Kalshi account:");
console.log(`  ticker:  ${ticker}`);
console.log(`  side:    ${side}  (${side === "yes" ? "buy YES" : "buy NO"})`);
console.log(`  price:   ${price}c/contract`);
console.log(`  count:   ${count}`);
console.log(`  max exposure if filled: $${((price * count) / 100).toFixed(2)}`);
if (price <= 5) console.log("  (price this low should rest unfilled on any real two-sided book — that's the point.)");
console.log("Then it will immediately cancel that order and print both raw responses.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Type "yes" to proceed: ', async (answer) => {
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("Aborted — nothing was placed.");
    process.exit(0);
  }

  console.log("\n--- Placing order ---");
  const placed = await placeKalshiOrder({ ticker, side, price, count }, env);
  console.log(JSON.stringify(placed, null, 2));
  if (!placed.ok) {
    console.error("\nOrder placement failed — nothing to cancel. Fix the error above before re-running.");
    process.exit(1);
  }
  if ((placed.fillCount || 0) > 0) {
    console.warn(`\nWARNING: ${placed.fillCount} contract(s) filled immediately — the market's real price is at or below your test price. Check your Kalshi portfolio.`);
  }
  if ((placed.remainingCount || 0) === 0) {
    console.log("\nNothing left resting (fully filled or already gone) — there is no order to cancel. Verify manually in your Kalshi portfolio.");
    process.exit(0);
  }

  console.log("\n--- Canceling order ---");
  const canceled = await cancelKalshiOrder({ orderId: placed.orderId }, env);
  console.log(JSON.stringify(canceled, null, 2));

  console.log("\n--- Done ---");
  console.log("Check your Kalshi portfolio/orders page directly to confirm nothing is left resting.");
  console.log(canceled.ok
    ? "Cancel call reported success — if that matches what you see in your portfolio, the schema in kalshi-order-client.js is verified."
    : "Cancel call FAILED — this confirms the schema guess in kalshi-order-client.js needs fixing before maker-live.js is ever armed. Paste this output back so it can be corrected.");
});
