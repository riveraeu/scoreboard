#!/usr/bin/env node
// Residual-by-dimension slicer — Phase 2 of model triage (docs/MODEL_IMPROVEMENT.md L0).
//
// Reach for this when a category has a coherent post-cutoff miss that survives L1–L5 and
// you need to know WHICH input is missing/under-weighted. Pulls resolved shadow_plays for
// one category, computes per-play residual r = won − model%, and slices by every stored
// dimension (native columns + features JSONB). A flat residual gradient across a dimension
// means it's already captured; a STEEP gradient is the missing or under-weighted input, and
// the sign tells over- vs under-modeled. Per-bucket Brier skill (market − model) flags
// whether a residual is actually exploitable — a miss the market also prices is not edge.
//
// Usage:
//   node scripts/tune/residual-by-dimension.js --category mlb|strikeouts
//   node scripts/tune/residual-by-dimension.js --category mlb|teamRuns --since 2026-05-27
//   node scripts/tune/residual-by-dimension.js --category wnba|points --min-n 200 --bucket-n 30
//   ADMIN_KEY=<key> node scripts/tune/residual-by-dimension.js --category mlb|hrr --rank any
//
// Requires: ADMIN_KEY (vercel env pull --environment=production .env.local) and, on the
// corporate network, NODE_EXTRA_CA_CERTS=~/.local/node/extra-ca.pem (set in ~/.zshrc).

import { readFileSync } from "fs";

const PROD_BASE = "https://scoreboard-ivory-xi.vercel.app";

// Per-category formula cutoff — calibration before this date is against a superseded formula.
// Mirrors FORMULA_CUTOFFS in api/lib/handlers/shadow.js; --since overrides.
const FORMULA_CUTOFFS = {
  "mlb|strikeouts": "2026-06-13",
  "mlb|hrr":        "2026-06-22",
  "mlb|hits":       "2026-06-12",
  "mlb|totalBases": "2026-06-12",
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
};
const DEFAULT_SINCE = "2026-05-01";

const MIN_N_TRUST = 200; // total resolved n to trust a formula-grade read (MODEL_IMPROVEMENT.md)
const BUCKET_N    = 30;  // per-bucket floor — buckets below this don't count toward a gradient

// Feature keys that are identifiers / high-cardinality, not modelable dimensions.
const FEATURE_DENYLIST = new Set([
  "opponent", "playerTeam", "umpire", "umpireName", "ticker", "eventTicker",
  "gameId", "kalshiTicker", "marketTicker", "tour", "starterId", "opposingPitcher",
]);

// ── Env loading (mirrors gate-recommender.js) ──────────────────────────────────
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
  const category = get("--category");
  return {
    category,
    since:   get("--since") || FORMULA_CUTOFFS[category] || DEFAULT_SINCE,
    minN:    parseInt(get("--min-n") || String(MIN_N_TRUST), 10),
    bucketN: parseInt(get("--bucket-n") || String(BUCKET_N), 10),
    rank:    get("--rank"),     // "any" or a number; default endpoint = 1
    dcQual:  get("--dc") !== "0",
    top:     parseInt(get("--top") || "12", 10),
  };
}

// ── Stats helpers ──────────────────────────────────────────────────────────────
const num = (v) => (v == null ? null : Number(v));
const fmtPts = (x) => (x == null ? "  n/a " : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`);
const fmtSkill = (x) => (x == null ? "  n/a  " : `${x >= 0 ? "+" : ""}${x.toFixed(4)}`);

function quartileCuts(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return [at(0.25), at(0.5), at(0.75)];
}

// Build per-bucket stats for one dimension.
// bucketFn(row) → label|null (null skips the row for this dimension). order map keeps display order.
function sliceDimension(rows, bucketFn) {
  const buckets = new Map();
  for (const row of rows) {
    const label = bucketFn(row);
    if (label == null) continue;
    if (!buckets.has(label)) buckets.set(label, { label, n: 0, sumR: 0, sumMB: 0, sumKB: 0 });
    const b = buckets.get(label);
    const mp = row._modelP, mkt = row._mktP, w = row._won;
    b.n++; b.sumR += w - mp;
    b.sumMB += (mp - w) ** 2;
    if (mkt != null) b.sumKB += (mkt - w) ** 2;
  }
  return [...buckets.values()].map((b) => ({
    label: b.label,
    n: b.n,
    meanR: b.sumR / b.n,
    modelBrier: b.sumMB / b.n,
    marketBrier: b.sumKB / b.n,
    skill: b.sumKB / b.n - b.sumMB / b.n,
  }));
}

// Gradient = spread of mean residual across buckets that clear the per-bucket floor.
function gradient(buckets, bucketN) {
  const ok = buckets.filter((b) => b.n >= bucketN);
  if (ok.length < 2) return { grad: null, qualBuckets: ok.length };
  const means = ok.map((b) => b.meanR);
  return { grad: Math.max(...means) - Math.min(...means), qualBuckets: ok.length };
}

// ── Dimension builders ─────────────────────────────────────────────────────────
function band5(p) { return p == null ? null : `${Math.floor(p / 5) * 5}-${Math.floor(p / 5) * 5 + 5}`; }
function edgeBand(e) {
  if (e == null) return null;
  if (e < 0) return "<0"; if (e < 3) return "0-3"; if (e < 5) return "3-5";
  if (e < 7) return "5-7"; if (e < 10) return "7-10"; if (e < 15) return "10-15"; return "15+";
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dowOf(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00Z`);
  return isNaN(d) ? null : DOW[d.getUTCDay()];
}

// Native dimensions present on every category.
function nativeDimensions(rows) {
  const dims = {};
  dims.betPrice = (r) => band5(r._betPct);
  dims.edge = (r) => edgeBand(num(r.edge));
  dims.dayOfWeek = (r) => dowOf(r.game_date);
  // pick side (home/away) — only meaningful when pick_team is stored (game-type plays)
  const hasSide = rows.some((r) => r.pick_team && (r.home_team || r.away_team));
  if (hasSide) {
    dims.pickSide = (r) => {
      if (!r.pick_team) return null;
      if (r.pick_team === r.home_team) return "home";
      if (r.pick_team === r.away_team) return "away";
      return null;
    };
  }
  // threshold — categorical if few distinct values, else quartiles
  const ths = [...new Set(rows.map((r) => num(r.threshold)).filter((v) => v != null))];
  if (ths.length >= 2) {
    if (ths.length <= 10) dims.threshold = (r) => (r.threshold == null ? null : `=${num(r.threshold)}`);
    else {
      const [q1, q2, q3] = quartileCuts(rows.map((r) => num(r.threshold)).filter((v) => v != null));
      dims.threshold = (r) => {
        const v = num(r.threshold); if (v == null) return null;
        return v <= q1 ? `≤${q1}` : v <= q2 ? `(${q1},${q2}]` : v <= q3 ? `(${q2},${q3}]` : `>${q3}`;
      };
    }
  }
  return dims;
}

// Feature (JSONB) dimensions — auto-discovered. Numeric → quartiles; low-card categorical → group.
function featureDimensions(rows) {
  const dims = {};
  const keys = new Set();
  for (const r of rows) if (r.features) for (const k of Object.keys(r.features)) keys.add(k);

  for (const key of keys) {
    if (FEATURE_DENYLIST.has(key)) continue;
    const vals = rows.map((r) => r.features?.[key]).filter((v) => v !== undefined && v !== null);
    if (vals.length < BUCKET_N) continue; // too sparse to slice
    const allNum = vals.every((v) => typeof v === "number" || (typeof v === "string" && v !== "" && !isNaN(Number(v))));
    if (allNum) {
      const nv = vals.map(Number);
      if (new Set(nv).size < 4) {
        // few distinct numbers → treat as categorical
        dims[`f:${key}`] = (r) => { const v = r.features?.[key]; return v == null ? null : `=${Number(v)}`; };
      } else {
        const [q1, q2, q3] = quartileCuts(nv);
        if (q1 === q3) continue; // degenerate
        dims[`f:${key}`] = (r) => {
          const raw = r.features?.[key]; if (raw == null) return null;
          const v = Number(raw);
          return v <= q1 ? `≤${q1}` : v <= q2 ? `(${q1},${q2}]` : v <= q3 ? `(${q2},${q3}]` : `>${q3}`;
        };
      }
    } else {
      const distinct = new Set(vals.map((v) => String(v)));
      if (distinct.size < 2 || distinct.size > 8) continue; // constant or id-like
      dims[`f:${key}`] = (r) => { const v = r.features?.[key]; return v == null ? null : String(v); };
    }
  }
  return dims;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const { category, since, minN, bucketN, rank, dcQual, top } = parseArgs();
  if (!category || !category.includes("|")) {
    console.error("Error: --category <sport|stat> required, e.g. --category mlb|strikeouts");
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

  console.log(`\nResidual-by-dimension — ${category}  (since=${since}, rank=${rank || "1"}, dc=${dcQual ? "qual" : "any"})\n`);

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

  const rows = (data.rows || []).map((r) => {
    const under = r.direction === "under";
    const betPct = under ? num(r.no_kalshi_pct) : num(r.kalshi_pct);
    return {
      ...r,
      _won: r.won ? 1 : 0,
      _modelP: num(r.model_true_pct) / 100, // stored bet-side → predicts won directly
      _mktP: betPct == null ? null : betPct / 100,
      _betPct: betPct,
    };
  });

  if (rows.length === 0) { console.log("No resolved rows for this category/window.\n"); return; }

  // Overall headline
  const N = rows.length;
  const meanR = rows.reduce((s, r) => s + (r._won - r._modelP), 0) / N;
  const modelBrier = rows.reduce((s, r) => s + (r._modelP - r._won) ** 2, 0) / N;
  const mktRows = rows.filter((r) => r._mktP != null);
  const marketBrier = mktRows.length ? mktRows.reduce((s, r) => s + (r._mktP - r._won) ** 2, 0) / mktRows.length : null;
  const skill = marketBrier == null ? null : marketBrier - modelBrier;
  const trustNote = N >= minN ? "" : `  ⚠ n<${minN} — formula-grade reads need ${minN}`;
  console.log(`n=${N}   mean residual ${fmtPts(meanR)}pp  (>0 underconfident, <0 overconfident)${trustNote}`);
  console.log(`model Brier ${modelBrier.toFixed(4)}   market Brier ${marketBrier == null ? "n/a" : marketBrier.toFixed(4)}   skill ${fmtSkill(skill)}  (>0 = model sharper than price)\n`);
  if (skill != null && skill < 0) {
    console.log("NOTE: overall skill < 0 — the market is the sharper estimator here. A residual the");
    console.log("      market also prices is not edge; weight steep gradients below accordingly.\n");
  }
  console.log("=".repeat(74));

  // Slice every dimension, rank by |gradient|.
  const dims = { ...nativeDimensions(rows), ...featureDimensions(rows) };
  const results = [];
  for (const [name, fn] of Object.entries(dims)) {
    const buckets = sliceDimension(rows, fn).sort((a, b) => a.meanR - b.meanR);
    const { grad, qualBuckets } = gradient(buckets, bucketN);
    results.push({ name, buckets, grad, qualBuckets });
  }
  results.sort((a, b) => (Math.abs(b.grad ?? -1)) - (Math.abs(a.grad ?? -1)));

  for (const res of results.slice(0, top)) {
    const trust = res.grad != null && N >= minN && res.qualBuckets >= 2;
    const gradStr = res.grad == null ? "n/a (need 2 buckets ≥ floor)" : `${fmtPts(res.grad)}pp spread`;
    const flag = res.grad == null ? "" : trust ? "  [trust]" : "  [thin]";
    console.log(`\n${res.name.padEnd(20)} gradient ${gradStr}${flag}`);
    for (const b of res.buckets) {
      const thin = b.n < bucketN ? " ·" : "  ";
      console.log(
        `   ${String(b.label).padStart(12)}${thin}n=${String(b.n).padStart(4)}` +
        `   resid ${fmtPts(b.meanR).padStart(6)}pp` +
        `   skill ${fmtSkill(b.skill)}`
      );
    }
  }

  console.log("\n" + "=".repeat(74));
  console.log("\nReading it:");
  console.log("  • Steep residual gradient + per-bucket n≥floor = the dimension the model mis-handles.");
  console.log("    Sign: residual>0 in a bucket = model underconfident there; <0 = overconfident.");
  console.log("  • If the dimension is already a model INPUT → L2 reweight (MODEL_IMPROVEMENT.md).");
  console.log("    If it's NOT an input → L0, add it (build → hydrate → consume → degrade).");
  console.log("  • Only act on a bucket whose skill > 0 — a miss the market also prices isn't edge.");
  console.log("  • Trust at total n≥" + minN + " AND ≥2 buckets each n≥" + bucketN + ".\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
