// Category-agnostic calibration aggregator.
// Consumes rows[] from any sport's simulate module and produces band-level summaries
// matching the shadow calibration system's byCategoryDetail format.
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
export const OUTPUT_DIR = join(__dir, "output");

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const BANDS = [
  [5, 10], [10, 15], [15, 20], [20, 25], [25, 30],
  [30, 35], [35, 40], [40, 45], [45, 50],
  [50, 55], [55, 60], [60, 65], [65, 70], [70, 75],
  [75, 80], [80, 85], [85, 90], [90, 95], [95, 100],
];

function bandFor(truePct) {
  for (const [lo, hi] of BANDS) {
    if (truePct >= lo && truePct < hi) return `${lo}-${hi}`;
  }
  return null;
}

// rows: array of { category, truePct, hit, threshold, ... }
export function summarize(rows) {
  const map = {}; // category → band → { n, hits, sumPct }
  for (const row of rows) {
    if (row.truePct == null || isNaN(row.truePct)) continue;
    const band = bandFor(row.truePct);
    if (!band) continue;
    if (!map[row.category]) map[row.category] = {};
    if (!map[row.category][band]) map[row.category][band] = { n: 0, hits: 0, sumPct: 0 };
    const b = map[row.category][band];
    b.n++;
    if (row.hit) b.hits++;
    b.sumPct += row.truePct;
  }

  const summary = {};
  for (const [cat, bands] of Object.entries(map)) {
    summary[cat] = {};
    for (const [band, b] of Object.entries(bands)) {
      const hitRate = b.n > 0 ? (b.hits / b.n) * 100 : 0;
      const avgPct = b.n > 0 ? b.sumPct / b.n : 0;
      summary[cat][band] = {
        n: b.n,
        hits: b.hits,
        hitRate: parseFloat(hitRate.toFixed(1)),
        avgPct: parseFloat(avgPct.toFixed(1)),
        delta: parseFloat((hitRate - avgPct).toFixed(1)),
      };
    }
  }
  return summary;
}

export function printTable(summary) {
  for (const [cat, bands] of Object.entries(summary)) {
    console.log(`\n── ${cat} ──`);
    console.log("Band       N       ActHit%  AvgPct   Delta");
    for (const band of BANDS.map(([l, h]) => `${l}-${h}`)) {
      const b = bands[band];
      if (!b || b.n < 3) continue;
      const delta = b.delta >= 0 ? `+${b.delta}` : `${b.delta}`;
      console.log(
        `${band.padEnd(10)} ${String(b.n).padEnd(7)} ${String(b.hitRate).padEnd(8)} ${String(b.avgPct).padEnd(8)} ${delta}`
      );
    }
  }
}

export function writeCsv(summary, filename) {
  const path = join(OUTPUT_DIR, filename);
  const lines = ["category,band,n,hits,hitRate,avgPct,delta"];
  for (const [cat, bands] of Object.entries(summary)) {
    for (const [band, b] of Object.entries(bands)) {
      lines.push(`${cat},${band},${b.n},${b.hits},${b.hitRate},${b.avgPct},${b.delta}`);
    }
  }
  writeFileSync(path, lines.join("\n"));
  console.log(`\nCalibration CSV → ${path}`);
}

export function writeRowsCsv(rows, filename) {
  const path = join(OUTPUT_DIR, filename);
  const keys = ["date", "category", "subject", "homeTeam", "awayTeam", "threshold", "truePct", "actualValue", "hit"];
  const chunks = [keys.join(",") + "\n"];
  // Build in 10k-row chunks to avoid a single massive string
  const CHUNK = 10000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    chunks.push(slice.map(r => keys.map(k => r[k] ?? "").join(",")).join("\n") + "\n");
  }
  writeFileSync(path, chunks.join(""));
  console.log(`Rows CSV → ${path}`);
}
