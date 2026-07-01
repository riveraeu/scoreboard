#!/usr/bin/env node
// Learning-curve tracker — "is this model still learning, and how big a step is justified?"
//
// Reach for this to decide whether a category is worth tuning at all. It pulls resolved
// shadow_plays for ONE category in chronological order (snapshot_date) and walks an EXPANDING
// window, recomputing cumulative Brier SKILL (market − model, paired) at each checkpoint. The
// SLOPE of that curve answers the only question that matters before you spend a correction step:
//
//   slope > 0  & skill → +        →  still learning — keep accruing, the model is converging on edge
//   slope ≈ 0  & |skill| < 0.005  →  converged to PARITY — a tie within noise; no edge, no step (the wnba|points case)
//   slope ≈ 0  & skill < 0        →  saturated + market-sharper — no step helps; only a NEW INPUT (L0)
//   slope ≈ 0  & skill > 0.005    →  converged WITH edge — set the L2 de-shrink step to β*·Δ
//
// We trend SKILL, not raw model-Brier: the market baseline drifts game-to-game, so only the
// paired per-play difference is comparable across time. The window is current-formula only
// (FORMULA_CUTOFFS / --since) — a formula change resets learning, so the curve can't span a cutoff.
//
// β* = n/(n+200) is the credibility weight on the calibration gap (200 = the formula-change n
// threshold from MODEL_IMPROVEMENT.md). It IS the optimal step size: move truePct by β*·Δ, not
// the full gap — small n ⇒ β*→0 ⇒ don't move (you can't tell the gap from sampling noise).
//
// Usage:
//   node scripts/tune/learning-curve.js --category mlb|totalBases
//   node scripts/tune/learning-curve.js --category mlb|hrr --step 25 --since 2026-06-22
//   ADMIN_KEY=<key> node scripts/tune/learning-curve.js --category wnba|points --rank any
//
// Requires: ADMIN_KEY (vercel env pull --environment=production .env.local) and, on the
// corporate network, NODE_EXTRA_CA_CERTS=~/.local/node/extra-ca.pem (set in ~/.zshrc).

import { readFileSync } from "fs";

const PROD_BASE = "https://scoreboard-ivory-xi.vercel.app";

// Per-category formula cutoff — mirrors FORMULA_CUTOFFS in api/lib/handlers/shadow.js; --since overrides.
const FORMULA_CUTOFFS = {
  "mlb|strikeouts": "2026-06-13",
  "mlb|hrr":        "2026-06-22",
  "mlb|hits":       "2026-06-12",
  "mlb|totalBases": "2026-06-30", // capture liquidity gate — pre-fix rows contaminated by 94¢ artifacts
  "mlb|totalRuns":  "2026-06-01",
  "mlb|teamRuns":   "2026-05-27",
  "nhl|totalGoals": "2026-05-29",
  "nhl|spread":     "2026-05-29",
  "nhl|ml":         "2026-05-29",
  "tennis|match":   "2026-06-13",
  "wnba|points":    "2026-05-28",
  "wnba|rebounds":  "2026-05-28",
  "wnba|assists":   "2026-05-28",
  "wnba|spread":    "2026-05-28",
  "nba|total":      "2026-06-22",
  "nba|teamTotal":  "2026-06-22",
  "wnba|total":     "2026-06-22",
  "wnba|teamTotal": "2026-06-22",
};
const DEFAULT_SINCE = "2026-05-01";

const MIN_N_TRUST = 200; // total resolved n to trust a formula-grade slope
const STEP_N      = 25;  // expanding-window checkpoint spacing
const CRED_K      = 200; // β* = n/(n+k); k = the formula-change n threshold

// ── Env loading (mirrors residual-by-dimension.js) ─────────────────────────────
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

// ── Args ────────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const category = get("--category");
  return {
    category,
    since:  get("--since") || FORMULA_CUTOFFS[category] || DEFAULT_SINCE,
    minN:   parseInt(get("--min-n") || String(MIN_N_TRUST), 10),
    step:   parseInt(get("--step") || String(STEP_N), 10),
    rank:   get("--rank"),    // "any" or a number; default endpoint = 1
    dcQual: get("--dc") !== "0",
  };
}

const num = (v) => (v == null ? null : Number(v));
const fmtSkill = (x) => (x == null ? "  n/a  " : `${x >= 0 ? "+" : ""}${x.toFixed(4)}`);

// OLS slope of y vs x.
function olsSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxx === 0 ? null : sxy / sxx;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { category, since, minN, step, rank, dcQual } = parseArgs();
  if (!category || !category.includes("|")) {
    console.error("Error: --category <sport|stat> required, e.g. --category mlb|totalBases");
    process.exit(1);
  }
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    console.error("Error: ADMIN_KEY not set.");
    console.error("  vercel env pull --environment=production .env.local");
    process.exit(1);
  }

  const qs = new URLSearchParams({ residual: category, since });
  if (rank) qs.set("thresholdRank", rank);
  if (!dcQual) qs.set("dcQualified", "0");
  const url = `${PROD_BASE}/api/auth/shadow-analysis?${qs}`;

  console.log(`\nLearning curve — ${category}  (since=${since}, rank=${rank || "1"}, dc=${dcQual ? "qual" : "any"})\n`);

  let data;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${adminKey}` } });
    if (!resp.ok) { console.error(`API ${resp.status}: ${await resp.text()}`); process.exit(1); }
    data = await resp.json();
  } catch (e) {
    console.error(`Fetch failed: ${e.message}`);
    console.error("  If on corporate network: source ~/.zshrc (sets NODE_EXTRA_CA_CERTS)");
    process.exit(1);
  }

  // Rows already arrive ORDER BY snapshot_date, so array index IS chronological.
  const rows = (data.rows || []).map((r) => {
    const under = r.direction === "under";
    const betPct = under ? num(r.no_kalshi_pct) : num(r.kalshi_pct);
    return {
      won: r.won ? 1 : 0,
      modelP: num(r.model_true_pct) / 100, // stored bet-side → predicts won directly
      mktP: betPct == null ? null : betPct / 100,
      date: r.snapshot_date ? String(r.snapshot_date).slice(0, 10) : null,
    };
  });

  if (rows.length === 0) { console.log("No resolved rows for this category/window.\n"); return; }

  // Expanding-window cumulative Brier skill at each checkpoint.
  const N = rows.length;
  let sumMB = 0, sumKB = 0, mktCount = 0;
  const checkpoints = [];
  for (let i = 0; i < N; i++) {
    const r = rows[i];
    sumMB += (r.modelP - r.won) ** 2;
    if (r.mktP != null) { sumKB += (r.mktP - r.won) ** 2; mktCount++; }
    const atCheckpoint = (i + 1) % step === 0 || i === N - 1;
    if (atCheckpoint && mktCount > 0) {
      const n = i + 1;
      const modelBrier = sumMB / n;
      const marketBrier = sumKB / mktCount;
      checkpoints.push({ n, date: r.date, modelBrier, marketBrier, skill: marketBrier - modelBrier });
    }
  }

  if (checkpoints.length === 0) { console.log("No priced rows to score skill.\n"); return; }

  const final = checkpoints[checkpoints.length - 1];
  const betaStar = N / (N + CRED_K);
  // Slope of cumulative skill vs n, reported per +100 plays. Drop the earliest checkpoint pair
  // worth of warm-up noise by fitting over all checkpoints (cumulative skill is already smoothed).
  const slopePerPlay = olsSlope(checkpoints.map((c) => c.n), checkpoints.map((c) => c.skill));
  const slope100 = slopePerPlay == null ? null : slopePerPlay * 100;

  // ── Print curve ────────────────────────────────────────────────────────────
  const skills = checkpoints.map((c) => c.skill);
  const lo = Math.min(...skills, 0), hi = Math.max(...skills, 0);
  const span = hi - lo || 1;
  const W = 40;
  const zeroCol = Math.round(((0 - lo) / span) * W);
  console.log("cumulative Brier skill (market − model) vs sample size");
  console.log("  >0 = model sharper than the price\n");
  for (const c of checkpoints) {
    const col = Math.round(((c.skill - lo) / span) * W);
    let bar = "";
    for (let k = 0; k <= W; k++) bar += k === zeroCol ? "|" : k === col ? (c.skill >= 0 ? "●" : "○") : " ";
    console.log(`  n=${String(c.n).padStart(4)} ${c.date || "          "}  ${fmtSkill(c.skill)}  ${bar}`);
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(74));
  const trustNote = N >= minN ? "" : `  ⚠ n<${minN} — slope is noisy below a formula-grade sample`;
  console.log(`\nfinal: n=${N}  skill ${fmtSkill(final.skill)}  (model ${final.modelBrier.toFixed(4)} vs market ${final.marketBrier.toFixed(4)})${trustNote}`);
  console.log(`slope: ${slope100 == null ? "n/a" : `${slope100 >= 0 ? "+" : ""}${slope100.toFixed(4)} skill per +100 plays`}`);
  console.log(`β*:    ${betaStar.toFixed(3)}   (= n/(n+${CRED_K}) — credibility on the calibration gap; the L2 step is β*·Δ)\n`);

  const FLAT = 0.002;   // |slope per 100| below this = saturated
  const PARITY = 0.005; // |final skill| below this = a tie within noise (mirrors BRIER_SKILL_FLOOR); the sign is noise, NOT edge
  let verdict, advice;
  if (slope100 == null) { verdict = "—"; advice = "too few checkpoints to fit a slope."; }
  else if (slope100 > FLAT && final.skill >= 0) {
    verdict = "STILL LEARNING";
    advice = "skill is climbing and at/above the price — keep accruing; it's converging on edge.";
  } else if (slope100 > FLAT && final.skill < 0) {
    verdict = "STILL LEARNING (below price)";
    advice = "skill is climbing but still under the price — accrue more before judging; don't kill yet.";
  } else if (Math.abs(final.skill) < PARITY) {
    // Flat AND within noise of the price — a tie, regardless of the sign of a sub-0.005 gap.
    verdict = "CONVERGED · NO EDGE";
    advice = "flat and tied with the price (skill within noise) — no edge to harvest and no step to take. Keep shadow-only; don't de-shrink toward a market you've converged to.";
  } else if (final.skill < 0) {
    verdict = "SATURATED · MARKET-SHARPER";
    advice = "flat and below the price — no step helps. Only a NEW INPUT (L0) can move it; run tune:residual.";
  } else {
    verdict = "CONVERGED · HAS EDGE";
    advice = `flat and above the price — learning is done. Lock the L2 de-shrink step at β*·Δ (β*=${betaStar.toFixed(2)}).`;
  }
  console.log(`VERDICT: ${verdict}`);
  console.log(`  → ${advice}\n`);
  console.log("Reading it:");
  console.log("  • Trend SKILL not raw Brier — the market baseline drifts, only the paired diff compares.");
  console.log("  • Rising curve = the model is still extracting signal from accruing data.");
  console.log("  • Flat curve = reweighting (L2) is tapped out; flat+below-price ⇒ you need a new input.");
  console.log("  • β* is the honest step size: move truePct by β*·(hitRate − truePct), never the full gap.\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
