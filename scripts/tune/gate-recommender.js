#!/usr/bin/env node
// Shadow-data gate recommender — reads resolved shadow_plays and proposes
// passesCategoryGate() changes in src/lib/constants.js.
//
// Usage:
//   node scripts/tune/gate-recommender.js               # uses .env.local for ADMIN_KEY
//   ADMIN_KEY=<key> node scripts/tune/gate-recommender.js
//   node scripts/tune/gate-recommender.js --since 2026-05-15
//   node scripts/tune/gate-recommender.js --since 2026-05-01 --min-n 30
//
// Requires: NODE_EXTRA_CA_CERTS=~/.local/node/extra-ca.pem (Netskope env — set in ~/.zshrc)

import { readFileSync } from "fs";

// ── Config ────────────────────────────────────────────────────────────────────

const PROD_BASE = "https://scoreboard-ivory-xi.vercel.app";

// Model finalization date — pre-May data is against superseded formulas.
const DEFAULT_SINCE = "2026-05-01";

const MIN_N_PROMOTE = 50;    // n≥50 required to promote a category
const MIN_N_WATCH   = 20;    // n≥20 worth flagging as approaching threshold
const DEMOTE_ROI    = -0.05; // ROI < -5% to flag a demotion

// ── Current gate (mirrors src/lib/constants.js passesCategoryGate) ────────────
// Update this when you apply a recommendation so next run sees the new baseline.
// max: upper-bound cap (exclusive), null = no cap.
const CURRENT_GATE = {
  "mlb|strikeouts": { min: 80, max: 90 },
  "wnba|points":    { min: 70, max: 80 },
  "wnba|rebounds":  { min: 70, max: null },
};

// ── Env loading ───────────────────────────────────────────────────────────────

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
loadEnvFile(".env.prod.local");
loadEnvFile(".env.production");
loadEnvFile(".env.prod");
loadEnvFile(".env");

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  return {
    since:  get("--since")  || DEFAULT_SINCE,
    minN:   parseInt(get("--min-n") || String(MIN_N_PROMOTE), 10),
  };
}

function bandMin(label) {
  if (label === "95+") return 95;
  return parseInt(label.split("-")[0], 10);
}

function fmtRoi(roi) {
  if (roi == null) return "  n/a  ";
  const pct = (roi * 100).toFixed(1);
  return `${roi >= 0 ? "+" : ""}${pct}%`;
}

// Produces the truePct guard expression for passesCategoryGate codegen.
function gateExpr(min, max) {
  const lo = `(p.truePct ?? 0) >= ${min}`;
  return max != null ? `${lo} && (p.truePct ?? 0) < ${max}` : lo;
}

// Cumulative ROI+n for plays with bsp ≥ threshold.
// `bands` is the scByCategoryDetail array for one category.
function thresholdSweep(bands) {
  const thresholds = [50, 55, 60, 65, 70, 75, 80, 85, 90];
  return thresholds.map(T => {
    const relevant = bands.filter(b => bandMin(b.band) >= T && b.n > 0 && b.roi != null);
    const n = relevant.reduce((s, b) => s + b.n, 0);
    if (n === 0) return { threshold: T, n: 0, roi: null };
    const roi = relevant.reduce((s, b) => s + b.roi * b.n, 0) / n;
    return { threshold: T, n, roi };
  });
}

// Lowest threshold with n≥minN and roi>0.
function bestThreshold(sweep, minN) {
  return sweep.find(s => s.n >= minN && s.roi != null && s.roi > 0) ?? null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { since, minN } = parseArgs();

  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    console.error("Error: ADMIN_KEY not set.");
    console.error("  1. Run: vercel env pull --environment=production .env.local");
    console.error("  2. Retry: node scripts/tune/gate-recommender.js");
    process.exit(1);
  }

  const url = `${PROD_BASE}/api/auth/shadow-calibration?since=${since}`;
  console.log(`\nFetching shadow calibration — since=${since} minN=${minN}\n`);

  let data;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${adminKey}` } });
    if (!resp.ok) {
      console.error(`API ${resp.status}: ${await resp.text()}`);
      process.exit(1);
    }
    data = await resp.json();
  } catch (e) {
    console.error(`Fetch failed: ${e.message}`);
    console.error("  If on corporate network: source ~/.zshrc (sets NODE_EXTRA_CA_CERTS)");
    process.exit(1);
  }

  const { byCategory = {}, byCategoryDetail = {} } = data;
  console.log(`Total resolved plays: ${data.n}  (window: ${since} → today)\n`);
  console.log("=".repeat(72));

  const promotionLines = [];  // new lines to add to passesCategoryGate
  const changeLines    = [];  // replacement lines for existing entries
  const removals       = [];  // keys to remove from CURRENT_GATE
  const holds          = [];  // keys confirmed correct

  for (const key of Object.keys({ ...CURRENT_GATE, ...byCategory }).sort()) {
    const cat     = byCategory[key];
    const bands   = byCategoryDetail[key] ?? [];
    const sweep   = thresholdSweep(bands);
    const gate       = CURRENT_GATE[key] ?? null;
    const current    = gate?.min ?? null;  // lower-bound threshold for sweep lookups
    const currentMax = gate?.max ?? null;  // upper-bound cap (null = no cap)
    const inGate     = gate != null;

    const rec = bestThreshold(sweep, minN);

    let status, note;

    if (inGate) {
      const atCurrent = sweep.find(s => s.threshold === current);
      const betterT   = rec && rec.threshold > current ? rec : null;

      if (atCurrent && atCurrent.n >= minN && atCurrent.roi < DEMOTE_ROI) {
        status = "DEMOTE ";
        note   = `Gate ≥${current}% → ROI ${fmtRoi(atCurrent.roi)} (n=${atCurrent.n}) below -5%`;
        removals.push(key);
      } else if (betterT) {
        status = "RAISE  ";
        note   = `Raise ≥${current}→${betterT.threshold}%  ROI ${fmtRoi(betterT.roi)} (n=${betterT.n})`;
        changeLines.push(`  if (key === '${key}') return ${gateExpr(betterT.threshold, currentMax)};`);
      } else {
        const check = sweep.find(s => s.threshold === current);
        status = "HOLD   ";
        note   = check && check.n > 0
          ? `≥${current}%  ROI ${fmtRoi(check.roi)} (n=${check.n}) — confirmed`
          : `≥${current}%  n=${cat?.n ?? 0} total resolved`;
        holds.push({ key, threshold: current, max: currentMax });
      }
    } else {
      if (!cat) {
        continue; // not in gate and no data — skip silently
      }
      if (rec) {
        status = "PROMOTE";
        note   = `≥${rec.threshold}%  ROI ${fmtRoi(rec.roi)} (n=${rec.n})`;
        promotionLines.push(`  if (key === '${key}') return (p.truePct ?? 0) >= ${rec.threshold};`);
      } else {
        const watch = sweep.find(s => s.n >= MIN_N_WATCH && s.roi != null && s.roi > 0);
        if (watch) {
          status = "WATCH  ";
          note   = `≥${watch.threshold}%  ROI ${fmtRoi(watch.roi)} (n=${watch.n}) — need ${minN - watch.n} more`;
        } else {
          if ((cat?.n ?? 0) < 10) continue; // too thin to print
          const best = [...sweep].filter(s => s.n > 0 && s.roi != null).sort((a, b) => b.roi - a.roi)[0];
          status = "NEGATIVE";
          note   = best ? `best ROI ${fmtRoi(best.roi)} at ≥${best.threshold}% (n=${best.n})` : `n=${cat.n} total`;
        }
      }
    }

    console.log(`${status.padEnd(9)} ${key.padEnd(22)} ${note}`);

    // Band detail for actionable statuses
    if (["PROMOTE", "DEMOTE ", "RAISE  ", "WATCH  "].includes(status)) {
      const active = bands.filter(b => b.n > 0);
      for (const b of active) {
        const tick = b.roi != null && b.roi > 0 ? "✓" : "✗";
        const delta = b.delta != null ? `Δ${b.delta > 0 ? "+" : ""}${b.delta.toFixed(1)}`.padStart(7) : "       ";
        console.log(
          `           ${tick} ${String(b.band + "%").padStart(7)}` +
          `  n=${String(b.n).padStart(4)}` +
          `  ROI ${fmtRoi(b.roi).padStart(7)}` +
          `  ${delta}`
        );
      }
      console.log("");
    }
  }

  // ── Suggested code diff ───────────────────────────────────────────────────

  const hasChanges = promotionLines.length > 0 || changeLines.length > 0 || removals.length > 0;

  console.log("\n" + "=".repeat(72));
  console.log("\nSUGGESTED src/lib/constants.js — passesCategoryGate():\n");

  if (!hasChanges) {
    console.log("  No changes recommended — current gate is correct.\n");
    return;
  }

  console.log("export function passesCategoryGate(p) {");
  console.log("  const key = `${p.sport}|${p.stat || p.gameType}`;");

  // Unchanged existing gates
  for (const { key, threshold, max } of holds) {
    console.log(`  if (key === '${key}') return ${gateExpr(threshold, max)};`);
  }
  // Raised existing gates
  for (const line of changeLines) console.log(line);
  // New promotions
  for (const line of promotionLines) console.log(line);
  // Removals annotated
  for (const key of removals) {
    console.log(`  // REMOVED: '${key}' (ROI below threshold — demoted)`);
  }

  console.log("  return false;");
  console.log("}\n");

  if (promotionLines.length > 0) {
    console.log(`NOTE: Apply promotions only after reviewing band detail above.`);
    console.log(`      Update CURRENT_GATE in this script after applying.\n`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
