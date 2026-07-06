#!/usr/bin/env node
// Bet-window recommender — derive a per-category price window from shadow data (docs/MODEL_IMPROVEMENT.md).
//
// The `qualified` bet flag defaults to the global [67,91] window for every category. Capture
// de-blinding (config.js CAPTURE_GATE/CAP = [55,97]) means shadow now logs the FULL favorite curve,
// so a category's real profitable price band can be MEASURED instead of assumed — tune:residual
// showed mlb|totalBases' edge lives ABOVE the 91¢ cap. This tool reads the captured band and, at
// n≥200, recommends whether to override the global window with a data-derived one.
//
// It is the GATE before editing CATEGORY_BET_WINDOWS in api/lib/config.js — recommends, never
// applies (mirrors tune:gate). GO requires ALL of:
//   1. total n ≥ --min-n (200 — window-grade),
//   2. in-sample discovered window passes the report's checklist (n≥MIN_N_PROMOTE, ROI CI-lo>0, coherent),
//   3. OUT-OF-SAMPLE: the window discovered on the earlier rows is still profitable (ROI CI-lo>0) on
//      the held-out later rows — the selection-bias guard the report can't do (its discovered ROI is
//      maximized over candidate ranges → upward-biased),
//   4. Brier-eligible: skill CI-lo>0 at n≥100 (the model provably beats the price — a profitable
//      window on a model the market out-predicts is a price artifact, not edge).
//
// Usage:
//   node scripts/tune/window-recommender.js --category mlb|totalBases
//   node scripts/tune/window-recommender.js --category mlb|hits --holdout 0.4 --min-n 200
//   ADMIN_KEY=<key> node scripts/tune/window-recommender.js --category mlb|totalBases --since 2026-06-30
//
// Requires: ADMIN_KEY (vercel env pull --environment=production .env.local) and, on the corporate
// network, NODE_EXTRA_CA_CERTS=~/.local/node/extra-ca.pem (set in ~/.zshrc).

import { readFileSync } from "fs";
import {
  discoverPriceWindow, windowQuality, playsToCells, MIN_N_PROMOTE,
} from "../../api/lib/price-window.js";
import { CAPTURE_GATE, CAPTURE_CAP } from "../../api/lib/config.js";

const PROD_BASE = "https://scoreboard-ivory-xi.vercel.app";

// Per-category formula cutoff — calibration before this date is against a superseded formula.
// Mirrors FORMULA_CUTOFFS in api/lib/handlers/shadow.js + residual-by-dimension.js; --since overrides.
const FORMULA_CUTOFFS = {
  "mlb|strikeouts": "2026-07-06", // blend capWeight 0.5→0.4
  "mlb|hrr":        "2026-06-22",
  "mlb|hits":       "2026-06-12",
  "mlb|totalBases": "2026-06-30", // capture liquidity gate — pre-fix rows contaminated by 94¢ artifacts
  "mlb|totalRuns":  "2026-06-01",
  "mlb|teamRuns":   "2026-05-27",
};
const DEFAULT_SINCE = "2026-05-01";
const MIN_N_WINDOW_GRADE = 200; // total resolved n to trust a window-grade read (MODEL_IMPROVEMENT.md)
const BRIER_MIN_N = 100;        // mirrors shadow.js — min n before Brier skill can gate eligibility
const DEFAULT_HOLDOUT = 0.4;    // fraction of most-recent rows held out for out-of-sample validation

// ── Env loading (mirrors residual-by-dimension.js) ───────────────────────────────
function loadEnvFile(path) {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
[".env.local", ".env.production.local", ".env.prod.local", ".env.production", ".env.prod", ".env"]
  .forEach(loadEnvFile);

// ── Args ─────────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const category = get("--category");
  return {
    category,
    since:   get("--since") || FORMULA_CUTOFFS[category] || DEFAULT_SINCE,
    minN:    parseInt(get("--min-n") || String(MIN_N_WINDOW_GRADE), 10),
    holdout: parseFloat(get("--holdout") || String(DEFAULT_HOLDOUT)),
    rank:    get("--rank"),   // "any" or a number; default endpoint = 1
    dcQual:  get("--dc") !== "0",
  };
}

const num = (v) => (v == null ? null : Number(v));
const pct = (x) => (x == null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const YN = (b) => (b ? "✓" : "✗");

// Realized ROI + 95% CI of a FIXED [lo,hi) window evaluated over a set of {_betPct,_won} rows.
// Same binomial-SE-on-hit-rate CI as windowQuality (ROI = hitRate − ~fixed price).
function evalWindow(win, rows) {
  if (!win) return null;
  const inWin = rows.filter((r) => r._betPct != null && r._betPct >= win.lo && r._betPct < win.hi);
  const n = inWin.length;
  if (n === 0) return { lo: win.lo, hi: win.hi, n: 0, roi: null, roiLoCI: null, hitRate: null, avgPrice: null };
  const wins = inWin.reduce((s, r) => s + r._won, 0);
  const avgPrice = inWin.reduce((s, r) => s + r._betPct, 0) / n;
  const p = wins / n;
  const roi = p - avgPrice / 100;
  const se = Math.sqrt(Math.max(0, p * (1 - p) / n));
  return {
    lo: win.lo, hi: win.hi, n,
    hitRate: parseFloat((100 * p).toFixed(1)),
    avgPrice: parseFloat(avgPrice.toFixed(1)),
    roi: parseFloat(roi.toFixed(4)),
    roiLoCI: parseFloat((roi - 1.96 * se).toFixed(4)),
  };
}

// Paired-difference Brier skill (market − model) + one-sided 95% CI lower bound.
function brierSkill(rows) {
  const mkt = rows.filter((r) => r._mktP != null);
  const n = mkt.length;
  if (n === 0) return { n: 0, skill: null, skillLoCI: null, modelBrier: null, marketBrier: null };
  const diffs = mkt.map((r) => (r._mktP - r._won) ** 2 - (r._modelP - r._won) ** 2);
  const skill = diffs.reduce((s, d) => s + d, 0) / n;
  const varD = diffs.reduce((s, d) => s + (d - skill) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(varD / n);
  return {
    n,
    skill: parseFloat(skill.toFixed(4)),
    skillLoCI: parseFloat((skill - 1.96 * se).toFixed(4)),
    modelBrier: parseFloat((mkt.reduce((s, r) => s + (r._modelP - r._won) ** 2, 0) / n).toFixed(4)),
    marketBrier: parseFloat((mkt.reduce((s, r) => s + (r._mktP - r._won) ** 2, 0) / n).toFixed(4)),
  };
}

async function main() {
  const { category, since, minN, holdout, rank, dcQual } = parseArgs();
  if (!category || !category.includes("|")) {
    console.error("Error: --category <sport|stat> required, e.g. --category mlb|totalBases");
    process.exit(1);
  }
  const [sport, stat] = category.split("|");
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    console.error("Error: ADMIN_KEY not set.\n  vercel env pull --environment=production .env.local");
    process.exit(1);
  }

  const qs = new URLSearchParams({ residual: category, since });
  if (rank) qs.set("thresholdRank", rank);
  if (!dcQual) qs.set("dcQualified", "0");

  console.log(`\nBet-window recommender — ${category}  (since=${since}, holdout=${holdout}, min-n=${minN})\n`);

  let data;
  try {
    const resp = await fetch(`${PROD_BASE}/api/auth/shadow-analysis?${qs}`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    if (!resp.ok) { console.error(`API ${resp.status}: ${await resp.text()}`); process.exit(1); }
    data = await resp.json();
  } catch (e) {
    console.error(`Fetch failed: ${e.message}`);
    console.error("  If on corporate network: source ~/.zshrc (sets NODE_EXTRA_CA_CERTS)");
    process.exit(1);
  }

  // Rows are snapshot_date-ordered by the endpoint. betPct + model% are stored BET-SIDE.
  const rows = (data.rows || []).map((r) => {
    const under = r.direction === "under";
    const betPct = under ? num(r.no_kalshi_pct) : num(r.kalshi_pct);
    return {
      snapshot_date: r.snapshot_date,
      _won: r.won ? 1 : 0,
      _modelP: num(r.model_true_pct) / 100, // stored bet-side → predicts won directly
      _mktP: betPct == null ? null : betPct / 100,
      _betPct: betPct,
    };
  }).filter((r) => r._betPct != null);

  const N = rows.length;
  if (N === 0) { console.log("No resolved rows for this category/window.\n"); return; }

  // ── Brier eligibility (whole population) ──
  const b = brierSkill(rows);
  const brierEligible = b.n >= BRIER_MIN_N && b.skillLoCI != null && b.skillLoCI > 0;

  // ── In-sample discovered window ──
  const cells = playsToCells(rows.map((r) => ({ betPct: r._betPct, won: r._won })));
  const win = discoverPriceWindow(cells);
  const q = win ? windowQuality(cells, win) : null;
  const inNok = !!win && win.n >= MIN_N_PROMOTE;
  const inCiOk = !!q && q.roiLoCI > 0;
  const inCoherentOk = !!q && q.coherent;

  // ── Out-of-sample: discover on the earlier rows, evaluate on the held-out later rows ──
  const split = Math.floor((1 - holdout) * N);
  const train = rows.slice(0, split);
  const test = rows.slice(split);
  const trainWin = discoverPriceWindow(playsToCells(train.map((r) => ({ betPct: r._betPct, won: r._won }))));
  const oos = evalWindow(trainWin, test);
  const oosOk = !!oos && oos.n > 0 && oos.roiLoCI != null && oos.roiLoCI > 0;

  // ── Report ──
  console.log(`n=${N}   Brier: model ${b.modelBrier ?? "n/a"}  market ${b.marketBrier ?? "n/a"}  skill ${b.skill ?? "n/a"} (CI-lo ${b.skillLoCI ?? "n/a"})`);
  console.log("=".repeat(78));
  if (win) {
    console.log(`IN-SAMPLE window   ${win.lo}–${win.hi}¢   n=${win.n}   ROI ${pct(win.roi)} (CI-lo ${pct(q?.roiLoCI)})   hit ${win.hitRate}% @ ${win.avgPrice}¢`);
  } else {
    console.log(`IN-SAMPLE window   none (fewer than the min-n floor of bettable rows in any range)`);
  }
  if (trainWin && oos) {
    console.log(`OUT-OF-SAMPLE      train→${trainWin.lo}–${trainWin.hi}¢ discovered on first ${train.length}; realized on last ${test.length}: n=${oos.n}  ROI ${pct(oos.roi)} (CI-lo ${pct(oos.roiLoCI)})`);
  } else {
    console.log(`OUT-OF-SAMPLE      insufficient rows to split (need enough in both halves)`);
  }
  console.log("=".repeat(78));
  console.log("Checklist:");
  console.log(`  ${YN(N >= minN)} n ≥ ${minN}                         (${N})`);
  console.log(`  ${YN(inNok)} in-sample window n ≥ ${MIN_N_PROMOTE}          (${win?.n ?? 0})`);
  console.log(`  ${YN(inCiOk)} in-sample ROI CI-lo > 0            (${pct(q?.roiLoCI)})`);
  console.log(`  ${YN(inCoherentOk)} in-sample coherent (both halves +) (${q?.coherent ? "yes" : "no"})`);
  console.log(`  ${YN(oosOk)} out-of-sample ROI CI-lo > 0        (${pct(oos?.roiLoCI)})`);
  console.log(`  ${YN(brierEligible)} Brier-eligible (skill CI-lo>0, n≥${BRIER_MIN_N})  (CI-lo ${b.skillLoCI ?? "n/a"}, n=${b.n})`);

  const go = N >= minN && inNok && inCiOk && inCoherentOk && oosOk && brierEligible;
  console.log("\n" + "=".repeat(78));
  if (go) {
    const lo = Math.max(CAPTURE_GATE, win.lo);
    const hi = Math.min(CAPTURE_CAP, win.hi);
    console.log(`VERDICT: GO — override the global [67,91] window for ${category}.`);
    console.log(`Paste into CATEGORY_BET_WINDOWS in api/lib/config.js:`);
    console.log(`\n  "${category}": [${lo}, ${hi}],\n`);
    console.log(`(Then confirm behavior via /api/tonight?debug=1 and re-check the report's bettingBoard.)`);
  } else {
    const why = [];
    if (N < minN) why.push(`accruing — n=${N}/${minN}`);
    if (N >= minN && !inNok) why.push("no in-sample window clears the promote-n floor");
    if (N >= minN && !inCiOk) why.push("in-sample edge not proven (ROI CI-lo ≤ 0 — could be luck)");
    if (N >= minN && !inCoherentOk) why.push("in-sample profit concentrated in one price half");
    if (N >= minN && !oosOk) why.push("does NOT hold out-of-sample (the window is overfit)");
    if (!brierEligible) why.push(`not Brier-eligible (model doesn't provably beat the price)`);
    console.log(`VERDICT: NO-GO — ${why.join("; ") || "criteria not met"}.`);
    console.log(`Leave CATEGORY_BET_WINDOWS[${category}] unset; it keeps betting the global [67,91].`);
  }
  console.log("=".repeat(78) + "\n");
}

main();
