#!/usr/bin/env node
// Platt scaling calibration corrector.
// Per-category logistic regression: P_cal = sigmoid(A * logit(truePct/100) + B)
// Train: 2022-2023 rows CSVs.  Eval: 2024 rows CSV.
//
// Usage:
//   node scripts/backtest/calibration-corrector.js
//   node scripts/backtest/calibration-corrector.js --train 2022,2023 --test 2024
//
// Outputs:
//   scripts/backtest/output/platt-coefficients.json  — {category: {A, B}} for live use
//   scripts/backtest/output/platt-report.csv         — per-category Brier + calibration stats

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir    = dirname(fileURLToPath(import.meta.url));
const OUT_DIR  = join(__dir, "output");

// ── Math helpers ──────────────────────────────────────────────────────────────

const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = x  => 1 / (1 + Math.exp(-clamp(x, -50, 50)));
const logit   = p  => { p = clamp(p, 1e-7, 1 - 1e-7); return Math.log(p / (1 - p)); };
const fmt1    = n  => n == null ? "—" : n.toFixed(1);
const fmt3    = n  => n == null ? "—" : n.toFixed(3);
const fmtPct  = n  => n == null ? "—" : (n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

// ── CSV loader ────────────────────────────────────────────────────────────────

function loadRows(filename) {
  const path = join(OUT_DIR, filename);
  if (!existsSync(path)) {
    console.error(`Missing: ${path}. Run: node scripts/backtest/run.js --sport mlb --seasons 2022,2023,2024`);
    process.exit(1);
  }
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  const idxTp  = header.indexOf("truePct");
  const idxHit = header.indexOf("hit");
  const idxCat = header.indexOf("category");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",");
    const truePct = parseFloat(vals[idxTp]);
    const hit     = parseInt(vals[idxHit]);
    const category = vals[idxCat];
    if (isNaN(truePct) || (hit !== 0 && hit !== 1)) continue;
    rows.push({ truePct, hit, category });
  }
  return rows;
}

// ── Platt fitting via gradient descent ───────────────────────────────────────
// Maximises log-likelihood of hit ~ Bernoulli(sigmoid(A*logit(p) + B)).
// Equivalent to minimising cross-entropy loss (logistic regression on logit(p)).

function fitPlatt(rows, { lr = 0.5, epochs = 3000, tol = 1e-7 } = {}) {
  let A = 1.0, B = 0.0;
  const n = rows.length;
  // Pre-compute logit scores once
  const scores = rows.map(r => logit(r.truePct / 100));
  let prevLoss = Infinity;

  for (let epoch = 0; epoch < epochs; epoch++) {
    let gradA = 0, gradB = 0, loss = 0;
    for (let i = 0; i < rows.length; i++) {
      const s   = scores[i];
      const p   = sigmoid(A * s + B);
      const hit = rows[i].hit;
      const err = p - hit;
      gradA += err * s;
      gradB += err;
      loss  -= hit * Math.log(p + 1e-15) + (1 - hit) * Math.log(1 - p + 1e-15);
    }
    A -= (lr / n) * gradA;
    B -= (lr / n) * gradB;
    if (Math.abs(prevLoss - loss) < tol) break;
    prevLoss = loss;
  }
  return { A: parseFloat(A.toFixed(6)), B: parseFloat(B.toFixed(6)) };
}

// ── Evaluation helpers ────────────────────────────────────────────────────────

function plattCorrect(truePct, A, B) {
  return sigmoid(A * logit(truePct / 100) + B) * 100;
}

function brierScore(rows, A = null, B = null) {
  let sum = 0;
  for (const { truePct, hit } of rows) {
    const p = A != null ? plattCorrect(truePct, A, B) / 100 : truePct / 100;
    sum += (p - hit) ** 2;
  }
  return rows.length > 0 ? sum / rows.length : null;
}

// Band-level calibration delta (same bands as calibration.js)
const BANDS = [
  [5,10],[10,15],[15,20],[20,25],[25,30],
  [30,35],[35,40],[40,45],[45,50],
  [50,55],[55,60],[60,65],[65,70],[70,75],
  [75,80],[80,85],[85,90],[90,95],[95,100],
];

function bandFor(pct) {
  for (const [lo, hi] of BANDS) if (pct >= lo && pct < hi) return `${lo}-${hi}`;
  return null;
}

function calibStats(rows, A = null, B = null) {
  // Returns band → { n, hits, avgModel, hitRate, delta }
  const map = {};
  for (const { truePct, hit } of rows) {
    const corrected = A != null ? plattCorrect(truePct, A, B) : truePct;
    const band = bandFor(corrected); // band on the corrected score
    if (!band) continue;
    if (!map[band]) map[band] = { n: 0, hits: 0, sumModel: 0 };
    map[band].n++;
    if (hit) map[band].hits++;
    map[band].sumModel += corrected;
  }
  const out = {};
  for (const [band, b] of Object.entries(map)) {
    const hitRate = b.hits / b.n * 100;
    const avgModel = b.sumModel / b.n;
    out[band] = { n: b.n, hitRate, avgModel, delta: hitRate - avgModel };
  }
  return out;
}

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get  = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : null; };
  const trainArg = get("--train") || "2022,2023";
  const testArg  = get("--test")  || "2024";
  return {
    trainSeasons: trainArg.split(",").map(Number),
    testSeason:   Number(testArg),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const { trainSeasons, testSeason } = parseArgs();
  console.log(`\nPlatt Scaling Calibration Corrector`);
  console.log(`  Train: ${trainSeasons.join(", ")} | Test: ${testSeason}\n`);

  // Load data
  const trainRows = trainSeasons.flatMap(s => loadRows(`rows-mlb-${s}.csv`));
  const testRows  = loadRows(`rows-mlb-${testSeason}.csv`);

  console.log(`  Train rows: ${trainRows.length.toLocaleString()} | Test rows: ${testRows.length.toLocaleString()}`);

  // Group by category
  const categories = [...new Set(trainRows.map(r => r.category))].sort();

  const coefficients = {};
  const reportRows   = [];

  console.log(`\n${"=".repeat(80)}`);
  console.log(`Category Results (train → test)`);
  console.log("=".repeat(80));

  for (const cat of categories) {
    const train = trainRows.filter(r => r.category === cat);
    const test  = testRows.filter(r => r.category === cat);
    if (train.length < 100 || test.length < 10) continue;

    const { A, B } = fitPlatt(train);
    coefficients[cat] = { A, B };

    const brierRaw    = brierScore(test);
    const brierPlatt  = brierScore(test, A, B);
    const improvement = brierRaw != null && brierPlatt != null
      ? ((brierRaw - brierPlatt) / brierRaw * 100)
      : null;

    // Calibration on test — raw vs Platt
    const rawCalib   = calibStats(test);
    const plattCalib = calibStats(test, A, B);

    console.log(`\n── ${cat} ── (train n=${train.length.toLocaleString()}, test n=${test.length.toLocaleString()})`);
    console.log(`   A=${fmt3(A)}  B=${fmt3(B)}`);
    console.log(`   Brier: raw=${brierRaw?.toFixed(4)} → platt=${brierPlatt?.toFixed(4)}  (${improvement != null ? (improvement >= 0 ? "+" : "") + improvement.toFixed(1) + "%" : "—"})`);
    console.log(`\n   Band       N_test  Raw Δ    Platt Δ  Δ-shift`);

    for (const [lo, hi] of BANDS) {
      const band = `${lo}-${hi}`;
      const raw   = rawCalib[band];
      const platt = plattCalib[band];
      if (!raw || raw.n < 5) continue;
      const rawDelta   = raw.delta;
      const plattDelta = platt?.delta ?? null;
      const shift      = plattDelta != null ? plattDelta - rawDelta : null;
      console.log(
        `   ${band.padEnd(10)} ${String(raw.n).padEnd(7)} ${fmtPct(rawDelta).padEnd(8)} ${fmtPct(plattDelta).padEnd(8)} ${shift != null ? (shift >= 0 ? "+" : "") + shift.toFixed(1) : "—"}`
      );
    }

    reportRows.push({ category: cat, trainN: train.length, testN: test.length, A, B, brierRaw, brierPlatt, improvement });
  }

  // ── Summary table ──────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Summary`);
  console.log("=".repeat(80));
  console.log(`Category           N_train   N_test   A       B        Brier raw  Brier cal  Δ%`);
  for (const r of reportRows) {
    const imp = r.improvement;
    console.log(
      `${r.category.padEnd(18)} ${String(r.trainN).padEnd(9)} ${String(r.testN).padEnd(8)} ` +
      `${fmt3(r.A).padEnd(7)} ${fmt3(r.B).padEnd(8)} ` +
      `${r.brierRaw?.toFixed(4).padEnd(10)} ${r.brierPlatt?.toFixed(4).padEnd(10)} ` +
      `${imp != null ? (imp >= 0 ? "+" : "") + imp.toFixed(1) + "%" : "—"}`
    );
  }

  // ── Outputs ────────────────────────────────────────────────────────────────
  const coeffPath = join(OUT_DIR, "platt-coefficients.json");
  writeFileSync(coeffPath, JSON.stringify(coefficients, null, 2));
  console.log(`\nCoefficients → ${coeffPath}`);

  const csvPath = join(OUT_DIR, "platt-report.csv");
  const csvLines = ["category,trainN,testN,A,B,brierRaw,brierPlatt,improvementPct"];
  for (const r of reportRows) {
    csvLines.push([r.category, r.trainN, r.testN, r.A, r.B,
      r.brierRaw?.toFixed(6), r.brierPlatt?.toFixed(6),
      r.improvement?.toFixed(2)].join(","));
  }
  writeFileSync(csvPath, csvLines.join("\n"));
  console.log(`Report CSV → ${csvPath}`);

  // ── Interpretation guide ───────────────────────────────────────────────────
  console.log(`\n── Interpretation ──`);
  console.log(`  A < 1.0  : model over-confident (logit compressed → probabilities pulled toward 50%)`);
  console.log(`  A > 1.0  : model under-confident (logit stretched → sharper predictions)`);
  console.log(`  B < 0.0  : model systematically predicts too high (intercept pulled down)`);
  console.log(`  B > 0.0  : model systematically predicts too low`);
  console.log(`  Brier Δ% > 0 : Platt correction improves calibration on held-out 2024 data`);
  console.log(`\n  To apply in the live model, import platt-coefficients.json and apply:`);
  console.log(`  P_cal = sigmoid(A * logit(truePct/100) + B) * 100`);
}

main();
