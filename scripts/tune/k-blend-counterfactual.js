#!/usr/bin/env node
// K hit-rate blend counterfactual — L2 reweight validation for mlb|strikeouts.
//
// Motivation (2026-07-05 residual sweep): the hit-rate family (softPct/seasonPct/
// l10HitRate/blendedHitRate) shows the over-weighted signature at trusted n — high
// hit-rate buckets run ~-9pp overconfident, low buckets ~+12pp underconfident — and
// rawTruePct is overdispersed. Two rival explanations with different fixes:
//   A) the empirical hit-rate anchor in _propBlend (props.js) is over-weighted
//      → fix = lower capWeight for K only (RESULT: GO — 0.5→0.4 shipped 2026-07-06)
//   B) global overdispersion — the whole prediction spread is too wide
//      → fix = calibration shrink / sigma, NOT the blend
// This script re-scores every resolved K row under both counterfactual axes and picks
// on out-of-sample Brier. It is analysis-only: no production code paths change.
//
// Reconstruction (exactly inverts props.js): rawTruePct = (1-w)·simPct + w·kRef with
// kRef = (seasonPct+softPct)/2 (or seasonPct alone) and w = min(1, seasonGames/20)·cap,
// where cap = the production capWeight that generated the rows (--baseline-cap).
// simPct is recovered by inversion (stored features.simPct is integer-rounded → used as
// the round-trip validator, tolerance 1.5pp). Post-blend adjustments (fatigue multiplier,
// monotonicity locks) are preserved as the multiplicative ratio model_true_pct/rawTruePct
// — an approximation for lock-touched rows (locks could bind differently under a
// counterfactual weight); their share is reported.
//
// Discipline: rows ordered by snapshot_date; grid winner picked on the first 70%
// (train), reported on the last 30% (test) only. Bootstrap CI on the test ΔBrier is
// clustered by pitcher-start (playerTeam|game_date) — threshold rungs of one start are
// correlated. Shrink anchor = train base rate (mean won), fixed before test scoring.
//
// Usage:
//   npm run tune:kblend                       # rank-1 rungs, since the 6/13 K cutoff
//   npm run tune:kblend -- --rank any         # all threshold rungs (sensitivity)
//   npm run tune:kblend -- --since 2026-06-13 --train-frac 0.7 --boot 2000
//
// GO rule (pre-committed): held-out Brier improvement over baseline with the 95%
// bootstrap CI excluding zero. A GO justifies a forward-only L2 proposal (separate
// change, FORMULA_CUTOFFS stamp); it is NOT applied by this script.
//
// Requires: ADMIN_KEY (vercel env pull --environment=production .env.local).

import { readFileSync } from "fs";

const PROD_BASE = "https://scoreboard-ivory-xi.vercel.app";
const K_CUTOFF = "2026-07-06"; // capWeight 0.5→0.4 shipped (this study's GO) — earlier rows are a superseded formula
const CAPTURE_SEAM = "2026-07-03"; // capture-all doctrine shipped — row mix changes here

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

// ── Args ───────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  return {
    since:     get("--since") || K_CUTOFF,
    rank:      get("--rank"), // "any" or a number; default endpoint = 1
    trainFrac: parseFloat(get("--train-frac") || "0.7"),
    boot:      parseInt(get("--boot") || "2000", 10),
    seed:      parseInt(get("--seed") || "20260705", 10),
    baselineCap: parseFloat(get("--baseline-cap") || String(DEFAULT_BASELINE_CAP)),
  };
}

// ── Grids ──────────────────────────────────────────────────────────────────────
const CAP_GRID = [1.0, 0.75, 0.5, 0.4, 0.3, 0.25, 0.2, 0.1, 0];
const SHRINK_GRID = [1.0, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6];
// Production capWeight for the analyzed window — MUST match what generated the rows or the
// inversion is wrong (the round-trip check aborts loudly on mismatch). 0.4 since 2026-07-06;
// pass --baseline-cap 0.5 with --since before that to re-analyze the old-formula era.
const DEFAULT_BASELINE_CAP = 0.4;

// ── Small utils ────────────────────────────────────────────────────────────────
const num = (v) => (v == null ? null : Number(v));
const clampP = (p) => Math.min(0.995, Math.max(0.005, p));
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Counterfactual re-scoring ──────────────────────────────────────────────────
// Returns the bet-side probability (0..1) for one row under (capWeight, shrink, anchor).
function rescore(row, capWeight, shrink, anchor) {
  let rawPrime;
  if (row.invariant) {
    rawPrime = row.rawTruePct; // sim-fallback row: blend never ran, capWeight is moot
  } else {
    const w = Math.min(1, row.seasonGames / 20) * capWeight;
    rawPrime = (1 - w) * row.simPct + w * row.kRef;
  }
  let p = clampP((rawPrime * row.postAdjRatio) / 100);
  if (shrink !== 1.0) p = clampP(anchor + shrink * (p - anchor));
  return p;
}

const brier = (rows, pFn) => rows.reduce((s, r) => s + (pFn(r) - r.won) ** 2, 0) / rows.length;

// Cluster bootstrap: resample pitcher-starts with replacement, compute mean ΔBrier
// (baseline − candidate; >0 = candidate better) per resample. Returns [lo, hi] 95% CI.
function bootstrapDelta(rows, basePFn, candPFn, nBoot, rand) {
  const clusters = new Map();
  for (const r of rows) {
    if (!clusters.has(r.cluster)) clusters.set(r.cluster, []);
    clusters.get(r.cluster).push(r);
  }
  const keys = [...clusters.keys()];
  const deltas = [];
  for (let b = 0; b < nBoot; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < keys.length; i++) {
      const cl = clusters.get(keys[Math.floor(rand() * keys.length)]);
      for (const r of cl) {
        sum += (basePFn(r) - r.won) ** 2 - (candPFn(r) - r.won) ** 2;
        n++;
      }
    }
    deltas.push(sum / n);
  }
  deltas.sort((a, b) => a - b);
  return [deltas[Math.floor(0.025 * nBoot)], deltas[Math.floor(0.975 * nBoot)]];
}

const fmtB = (x) => x.toFixed(4);
const fmtD = (x) => `${x >= 0 ? "+" : ""}${(x * 1000).toFixed(2)}`; // ΔBrier in milli-units

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const { since, rank, trainFrac, boot, seed, baselineCap } = parseArgs();
  const BASELINE_CAP = baselineCap;
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    console.error("Error: ADMIN_KEY not set.");
    console.error("  vercel env pull --environment=production .env.local");
    process.exit(1);
  }

  const qs = new URLSearchParams({ residual: "mlb|strikeouts", since });
  if (rank) qs.set("thresholdRank", rank);
  const url = `${PROD_BASE}/api/auth/shadow-analysis?${qs}`;
  console.log(`\nK blend counterfactual — mlb|strikeouts  (since=${since}, rank=${rank || "1"})\n`);

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

  // ── Build + validate rows ──────────────────────────────────────────────────
  const drops = { missing: 0, badRoundTrip: 0, underSide: 0 };
  let lockTouched = 0, invariants = 0;
  const rows = [];
  for (const r of data.rows || []) {
    if (r.direction === "under") { drops.underSide++; continue; } // over-framed math only; none exist today
    const f = r.features || {};
    const rawTruePct = num(f.rawTruePct);
    const seasonPct = num(f.seasonPct);
    const softPct = num(f.softPct);
    const seasonGames = num(f.seasonGames);
    const modelPct = num(r.model_true_pct);
    if (rawTruePct == null || seasonPct == null || seasonGames == null || modelPct == null || rawTruePct <= 0) {
      drops.missing++; continue;
    }
    const kRef = softPct != null ? (seasonPct + softPct) / 2 : seasonPct;
    const w = Math.min(1, seasonGames / 20) * BASELINE_CAP;
    const storedSim = num(f.simPct);

    let simPct, invariant = false;
    if (w >= 1) { drops.missing++; continue; } // impossible with cap 0.5, defensive
    const simInv = (rawTruePct - w * kRef) / (1 - w);
    if (storedSim != null) {
      // Round-trip validation: inverted sim must match the stored (integer-rounded) sim.
      if (Math.abs(simInv - storedSim) > 1.5) { drops.badRoundTrip++; continue; }
      simPct = simInv;
    } else if (Math.abs(rawTruePct - kRef) <= 0.15) {
      invariant = true; invariants++; simPct = null; // sim-fallback path: rawTruePct = kRef
    } else {
      drops.badRoundTrip++; continue;
    }

    const postAdjRatio = modelPct / rawTruePct;
    if (Math.abs(postAdjRatio - 1) > 0.001) lockTouched++;
    const under = false;
    const betPct = under ? num(r.no_kalshi_pct) : num(r.kalshi_pct);
    rows.push({
      snapshotDate: String(r.snapshot_date).slice(0, 10),
      gameDate: String(r.game_date).slice(0, 10),
      cluster: `${f.playerTeam ?? r.pick_team ?? r.home_team}|${String(r.game_date).slice(0, 10)}`,
      won: r.won ? 1 : 0,
      marketP: betPct == null ? null : betPct / 100,
      rawTruePct, kRef, seasonGames, simPct, invariant, postAdjRatio,
    });
  }

  const N = rows.length;
  const dropTotal = drops.missing + drops.badRoundTrip + drops.underSide;
  console.log(`rows fetched ${data.rows?.length ?? 0}   usable ${N}   dropped ${dropTotal} (missing ${drops.missing}, round-trip ${drops.badRoundTrip}, under ${drops.underSide})`);
  console.log(`sim-fallback (blend-invariant) ${invariants}   post-blend-adjusted (fatigue/locks, ratio≠1) ${lockTouched}`);
  if (N === 0) { console.log("\nNo usable rows.\n"); return; }
  if (dropTotal / (N + dropTotal) > 0.10) {
    console.error(`\nABORT: ${(100 * dropTotal / (N + dropTotal)).toFixed(1)}% of rows failed reconstruction — inversion assumptions are wrong; investigate before trusting any number above.`);
    process.exit(1);
  }

  // ── Train/test split by snapshot_date ──────────────────────────────────────
  rows.sort((a, b) => a.snapshotDate < b.snapshotDate ? -1 : a.snapshotDate > b.snapshotDate ? 1 : 0);
  const cut = Math.floor(N * trainFrac);
  const train = rows.slice(0, cut), test = rows.slice(cut);
  const anchor = train.reduce((s, r) => s + r.won, 0) / train.length; // shrink target = train base rate
  console.log(`train ${train.length} (${train[0].snapshotDate} → ${train[train.length - 1].snapshotDate})   test ${test.length} (${test[0].snapshotDate} → ${test[test.length - 1].snapshotDate})   anchor (train base rate) ${(100 * anchor).toFixed(1)}%\n`);

  const pAt = (c, s) => (r) => rescore(r, c, s, anchor);
  const baseP = pAt(BASELINE_CAP, 1.0);

  // ── Axis A: capWeight grid (s=1) ───────────────────────────────────────────
  console.log(`Axis A — capWeight (hit-rate anchor weight; baseline = ${BASELINE_CAP})`);
  console.log("   cap    trainBrier  testBrier");
  let bestCap = BASELINE_CAP, bestCapTrain = Infinity;
  for (const c of CAP_GRID) {
    const tb = brier(train, pAt(c, 1.0));
    if (tb < bestCapTrain) { bestCapTrain = tb; bestCap = c; }
    console.log(`  ${String(c).padStart(4)}     ${fmtB(tb)}     ${fmtB(brier(test, pAt(c, 1.0)))}${c === BASELINE_CAP ? "   ← baseline" : ""}`);
  }

  // ── Axis B: global shrink toward train base rate (cap=0.5) ─────────────────
  console.log("\nAxis B — global shrink toward base rate (cap fixed at 0.5)");
  console.log("   s      trainBrier  testBrier");
  let bestS = 1.0, bestSTrain = Infinity;
  for (const s of SHRINK_GRID) {
    const tb = brier(train, pAt(BASELINE_CAP, s));
    if (tb < bestSTrain) { bestSTrain = tb; bestS = s; }
    console.log(`  ${s.toFixed(2)}     ${fmtB(tb)}     ${fmtB(brier(test, pAt(BASELINE_CAP, s)))}${s === 1.0 ? "   ← baseline" : ""}`);
  }

  // ── Joint grid ─────────────────────────────────────────────────────────────
  let joint = { c: BASELINE_CAP, s: 1.0, tb: Infinity };
  for (const c of CAP_GRID) for (const s of SHRINK_GRID) {
    const tb = brier(train, pAt(c, s));
    if (tb < joint.tb) joint = { c, s, tb };
  }

  // ── Held-out comparison + clustered bootstrap ──────────────────────────────
  const rand = mulberry32(seed);
  const baseTest = brier(test, baseP);
  const mktRows = test.filter((r) => r.marketP != null);
  const mktTest = mktRows.length ? brier(mktRows, (r) => r.marketP) : null;

  console.log(`\nHeld-out test set (n=${test.length}, ${new Set(test.map((r) => r.cluster)).size} pitcher-starts) — winners picked on train only`);
  console.log(`  baseline (cap ${BASELINE_CAP})              Brier ${fmtB(baseTest)}`);
  if (mktTest != null) console.log(`  market                          Brier ${fmtB(mktTest)}   (reference)`);

  const candidates = [
    { name: `A winner  cap=${bestCap}`, fn: pAt(bestCap, 1.0), skip: bestCap === BASELINE_CAP },
    { name: `B winner  s=${bestS.toFixed(2)}`, fn: pAt(BASELINE_CAP, bestS), skip: bestS === 1.0 },
    { name: `joint     cap=${joint.c} s=${joint.s.toFixed(2)}`, fn: pAt(joint.c, joint.s), skip: joint.c === BASELINE_CAP && joint.s === 1.0 },
  ];
  const verdicts = [];
  for (const cand of candidates) {
    if (cand.skip) { console.log(`  ${cand.name.padEnd(30)}  = baseline on train (no candidate)`); continue; }
    const cb = brier(test, cand.fn);
    const [lo, hi] = bootstrapDelta(test, baseP, cand.fn, boot, rand);
    const go = lo > 0;
    verdicts.push({ name: cand.name, go, delta: baseTest - cb });
    console.log(`  ${cand.name.padEnd(30)}  Brier ${fmtB(cb)}   ΔBrier ${fmtD(baseTest - cb)}m  95% CI [${fmtD(lo)}, ${fmtD(hi)}]m  ${go ? "→ GO" : "→ CI straddles 0"}`);
  }

  // ── Capture-band seam stability (7/03 capture-all changed the row mix) ─────
  const winner = candidates.find((c) => !c.skip);
  if (winner) {
    const pre = test.filter((r) => r.snapshotDate < CAPTURE_SEAM);
    const post = test.filter((r) => r.snapshotDate >= CAPTURE_SEAM);
    if (pre.length >= 20 && post.length >= 20) {
      console.log(`\nSeam check (${winner.name.trim()} vs baseline across the ${CAPTURE_SEAM} capture-all change):`);
      console.log(`  pre  (n=${pre.length})  ΔBrier ${fmtD(brier(pre, baseP) - brier(pre, winner.fn))}m`);
      console.log(`  post (n=${post.length})  ΔBrier ${fmtD(brier(post, baseP) - brier(post, winner.fn))}m`);
    } else {
      console.log(`\nSeam check skipped — test split doesn't span ${CAPTURE_SEAM} with n≥20 on both sides (pre ${pre.length}, post ${post.length}).`);
    }
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(74));
  const anyGo = verdicts.some((v) => v.go);
  if (!verdicts.length) {
    console.log("VERDICT: NO-GO — train picked the production baseline on every axis; no counterfactual to test.");
  } else if (anyGo) {
    console.log("VERDICT: GO candidates above (CI-lo > 0). Interpretation:");
    console.log("  • If A (capWeight) wins and joint adds nothing → the hit-rate anchor is the noise carrier; propose the K capWeight change (forward-only, FORMULA_CUTOFFS stamp).");
    console.log("  • If B (shrink) wins and A adds nothing beyond it → global overdispersion; the fix is sigma/calibration, NOT the blend.");
    console.log("  Ship path: separate L2 proposal per docs/MODEL_IMPROVEMENT.md — nothing is applied by this script.");
  } else {
    console.log("VERDICT: NO-GO — no candidate's held-out CI excludes zero. Overdispersion may be real but the sample can't pick the fix; re-run as n grows (~10 rank-1 rows/day).");
  }
  console.log("Ceiling reminder: model trails market Brier here — this closes toward parity (accuracy fix), it does not mint edge.\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
