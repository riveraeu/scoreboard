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
//   npm run tune:kblend                       # mlb|strikeouts, rank-1 rungs, since its cutoff
//   npm run tune:kblend -- --category wnba|points   # any CATEGORY_CONFIG category
//   npm run tune:kblend -- --rank any         # all threshold rungs (sensitivity)
//   npm run tune:kblend -- --since 2026-06-13 --train-frac 0.7 --boot 2000
//   npm run tune:kblend -- --since 2026-05-26 --until 2026-06-13 --baseline-cap 0.5   # era-isolated, old formula
//
// GO rule (pre-committed): held-out Brier improvement over baseline with the 95%
// bootstrap CI excluding zero. A GO justifies a forward-only L2 proposal (separate
// change, FORMULA_CUTOFFS stamp); it is NOT applied by this script.
//
// Requires: ADMIN_KEY (vercel env pull --environment=production .env.local).

import { readFileSync } from "fs";

const PROD_BASE = "https://scoreboard-ivory-xi.vercel.app";
const CAPTURE_SEAM = "2026-07-03"; // capture-all doctrine shipped — row mix changes here

// Categories sharing the invertible _propBlend stage (props.js rawTruePct). since = the
// category's FORMULA_CUTOFFS date; cap = the production capWeight that generated the rows
// (--baseline-cap / --since override). sigmoid80 = hits/TB conservative cap branch
// (80 + 5·(1−e^(−0.4·(x−80)))) applied AFTER the blend — inverted before, re-applied after.
// K rows uniquely store an integer simPct (round-trip validator); the rest validate on
// implied-sim bounds only (weaker — the code-read carries more of the burden).
// mlb|hrr is deliberately ABSENT: different core (logit stack, capWeight 0.25, PA/BvP
// adjustments) with no stored intermediate to validate an inversion against.
const CATEGORY_CONFIG = {
  "mlb|strikeouts": { since: "2026-07-06", cap: 0.4, simStored: true }, // 0.5→0.4 shipped 7/06 (this study's GO); pre-cutoff rows need --baseline-cap 0.5
  "mlb|hits":       { since: "2026-06-30", cap: 0.5, sigmoid80: true },
  "mlb|totalBases": { since: "2026-06-30", cap: 0.5, sigmoid80: true },
  "wnba|points":    { since: "2026-05-28", cap: 0.5 },
  "wnba|rebounds":  { since: "2026-05-28", cap: 0.5 },
  "wnba|assists":   { since: "2026-05-28", cap: 0.5 },
  "nba|points":     { since: "2026-05-26", cap: 0.5 },
  "nba|rebounds":   { since: "2026-05-26", cap: 0.5 },
  "nba|assists":    { since: "2026-05-26", cap: 0.5 },
};

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
  const category = get("--category") || "mlb|strikeouts";
  const cfg = CATEGORY_CONFIG[category];
  if (!cfg) {
    console.error(`Error: unknown --category "${category}". Known: ${Object.keys(CATEGORY_CONFIG).join(", ")}`);
    process.exit(1);
  }
  return {
    category, cfg,
    since:     get("--since") || cfg.since,
    until:     get("--until"), // exclusive snapshot_date ceiling (client-side) — for era-isolated runs
    rank:      get("--rank"), // "any" or a number; default endpoint = 1
    trainFrac: parseFloat(get("--train-frac") || "0.7"),
    boot:      parseInt(get("--boot") || "2000", 10),
    seed:      parseInt(get("--seed") || "20260705", 10),
    baselineCap: parseFloat(get("--baseline-cap") || String(cfg.cap)),
  };
}

// ── Grids ──────────────────────────────────────────────────────────────────────
const CAP_GRID = [1.0, 0.75, 0.5, 0.4, 0.3, 0.25, 0.2, 0.1, 0];
const SHRINK_GRID = [1.0, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6];

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
// hits/TB conservative cap branch — applied AFTER the blend in props.js.
const cap80 = (x) => (x <= 80 ? x : 80 + 5 * (1 - Math.exp(-0.4 * (x - 80))));
// Returns the bet-side probability (0..1) for one row under (capWeight, shrink, anchor).
function rescore(row, capWeight, shrink, anchor, sigmoid80) {
  let rawPrime;
  if (row.invariant) {
    rawPrime = row.rawUncapped; // sim-fallback row: blend never ran, capWeight is moot
  } else {
    const w = Math.min(1, row.seasonGames / 20) * capWeight;
    rawPrime = (1 - w) * row.simPct + w * row.kRef;
  }
  if (sigmoid80) rawPrime = cap80(rawPrime);
  const pOver = clampP((rawPrime * row.postAdjRatio) / 100);
  let p = row.under ? 1 - pOver : pOver;
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
  const { category, cfg, since, until, rank, trainFrac, boot, seed, baselineCap } = parseArgs();
  const BASELINE_CAP = baselineCap;
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    console.error("Error: ADMIN_KEY not set.");
    console.error("  vercel env pull --environment=production .env.local");
    process.exit(1);
  }

  const qs = new URLSearchParams({ residual: category, since });
  if (rank) qs.set("thresholdRank", rank);
  const url = `${PROD_BASE}/api/auth/shadow-analysis?${qs}`;
  console.log(`\nBlend counterfactual — ${category}  (since=${since}${until ? `, until<${until}` : ""}, rank=${rank || "1"}, baselineCap=${BASELINE_CAP}${cfg.sigmoid80 ? ", sigmoid80" : ""})\n`);

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
  const drops = { missing: 0, badRoundTrip: 0 };
  let lockTouched = 0, invariants = 0, unders = 0;
  const rows = [];
  for (const r of data.rows || []) {
    if (until && String(r.snapshot_date).slice(0, 10) >= until) continue; // era-isolated runs
    const under = r.direction === "under";
    const f = r.features || {};
    const rawStored = num(f.rawTruePct); // over-framed, post-cap
    const seasonPct = num(f.seasonPct);
    const softPct = num(f.softPct);
    const seasonGames = num(f.seasonGames);
    const betModel = num(r.model_true_pct); // bet-side
    if (rawStored == null || seasonPct == null || seasonGames == null || betModel == null || rawStored <= 0) {
      drops.missing++; continue;
    }
    // Invert the hits/TB sigmoid cap zone; ≥84.5 is numerically uninvertible (asymptote ≈85,
    // 0.1-rounding blows up the inverse there) — any rawStored ≥85 is a formula mismatch anyway.
    let rawUncapped = rawStored;
    if (cfg.sigmoid80 && rawStored > 80) {
      if (rawStored > 84.5) { drops.badRoundTrip++; continue; }
      rawUncapped = 80 - Math.log(1 - (rawStored - 80) / 5) / 0.4;
    }
    const kRef = softPct != null ? (seasonPct + softPct) / 2 : seasonPct;
    const w = Math.min(1, seasonGames / 20) * BASELINE_CAP;
    const storedSim = num(f.simPct);

    let simPct, invariant = false;
    if (w >= 1) { drops.missing++; continue; } // impossible with cap ≤0.5, defensive
    const simInv = (rawUncapped - w * kRef) / (1 - w);
    if (storedSim != null) {
      // Round-trip validation (K only stores simPct): inverted sim must match the stored
      // (integer-rounded) value.
      if (Math.abs(simInv - storedSim) > 1.5) { drops.badRoundTrip++; continue; }
      simPct = simInv;
    } else if (Math.abs(rawUncapped - kRef) <= 0.15) {
      invariant = true; invariants++; simPct = null; // sim-fallback path (or sim≈ref): blend-invariant either way
    } else if (cfg.simStored) {
      // This category normally stores simPct — a non-invariant row without one is off-formula
      // (e.g. the K 6/05–6/06 anomaly days). Bounds-only acceptance would launder those in.
      drops.badRoundTrip++; continue;
    } else if (simInv < -2 || simInv > 102) {
      drops.badRoundTrip++; continue; // implied sim outside probability bounds — formula mismatch
    } else {
      simPct = simInv; // no stored sim to validate against — bounds check is the only per-row guard
    }

    const overModel = under ? 100 - betModel : betModel;
    const postAdjRatio = overModel / rawStored;
    if (Math.abs(postAdjRatio - 1) > 0.001) lockTouched++;
    if (under) unders++;
    const betPct = under ? num(r.no_kalshi_pct) : num(r.kalshi_pct);
    rows.push({
      snapshotDate: String(r.snapshot_date).slice(0, 10),
      gameDate: String(r.game_date).slice(0, 10),
      cluster: `${f.playerTeam ?? r.pick_team ?? r.home_team}|${String(r.game_date).slice(0, 10)}`,
      won: r.won ? 1 : 0,
      marketP: betPct == null ? null : betPct / 100,
      rawUncapped, kRef, seasonGames, simPct, invariant, postAdjRatio, under,
    });
  }

  const N = rows.length;
  const dropTotal = drops.missing + drops.badRoundTrip;
  console.log(`rows fetched ${data.rows?.length ?? 0}   usable ${N}   dropped ${dropTotal} (missing ${drops.missing}, round-trip ${drops.badRoundTrip})`);
  console.log(`sim-fallback (blend-invariant) ${invariants}   post-blend-adjusted (ratio≠1) ${lockTouched}   under-side ${unders}`);
  if (N === 0) { console.log("\nNo usable rows.\n"); return; }
  // Abort on round-trip failure share only — missing-field rows are unanalyzable (pre-stamp
  // era), not evidence the inversion is wrong; badRoundTrip rows are that evidence.
  if (drops.badRoundTrip / (N + drops.badRoundTrip) > 0.10) {
    console.error(`\nABORT: ${(100 * drops.badRoundTrip / (N + drops.badRoundTrip)).toFixed(1)}% of component-complete rows failed reconstruction — inversion assumptions are wrong; investigate before trusting any number above.`);
    process.exit(1);
  }

  // ── Train/test split by snapshot_date ──────────────────────────────────────
  rows.sort((a, b) => a.snapshotDate < b.snapshotDate ? -1 : a.snapshotDate > b.snapshotDate ? 1 : 0);
  const cut = Math.floor(N * trainFrac);
  const train = rows.slice(0, cut), test = rows.slice(cut);
  const anchor = train.reduce((s, r) => s + r.won, 0) / train.length; // shrink target = train base rate
  console.log(`train ${train.length} (${train[0].snapshotDate} → ${train[train.length - 1].snapshotDate})   test ${test.length} (${test[0].snapshotDate} → ${test[test.length - 1].snapshotDate})   anchor (train base rate) ${(100 * anchor).toFixed(1)}%\n`);

  const pAt = (c, s) => (r) => rescore(r, c, s, anchor, cfg.sigmoid80);
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

  console.log(`\nHeld-out test set (n=${test.length}, ${new Set(test.map((r) => r.cluster)).size} clusters [playerTeam|date]) — winners picked on train only`);
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
