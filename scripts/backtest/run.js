#!/usr/bin/env node
// MLB/NBA/NHL backtest calibration pipeline.
// Usage:
//   node scripts/backtest/run.js --sport mlb --season 2024
//   node scripts/backtest/run.js --sport mlb --seasons 2022,2023,2024
//   node scripts/backtest/run.js --sport nba --season 2024
//   node scripts/backtest/run.js --sport nba --seasons 2023,2024
//   node scripts/backtest/run.js --sport nhl --season 2024   (Phase 3 — not yet built)
//
// Output files written to scripts/backtest/output/
import { collectMLBSeason } from "./mlb/collect.js";
import { collectOdds }      from "./mlb/odds.js";
import { simulateAllMLB }   from "./mlb/simulate.js";
import { collectNBASeason, simulateAllNBA } from "./nba/index.js";
import { collectNHLSeason, simulateAllNHL } from "./nhl/index.js";
import { summarize, printTable, writeCsv, writeRowsCsv } from "./calibration.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const get  = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const sport   = get("--sport")   || "mlb";
  const seasonsArg = get("--seasons") || get("--season") || "2024";
  const seasons = seasonsArg.split(",").map(Number).filter(Boolean);
  return { sport, seasons };
}

async function runMLB(seasons) {
  const allRows = [];

  for (const season of seasons) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`MLB Backtest — ${season}`);
    console.log("=".repeat(60));

    const data    = await collectMLBSeason(season);
    const oddsMap = await collectOdds(season);
    const rows    = simulateAllMLB(data, oddsMap);
    for (const r of rows) allRows.push(r);

    // Per-season output
    const seasonSummary = summarize(rows);
    printTable(seasonSummary);
    writeCsv(seasonSummary, `calibration-mlb-${season}.csv`);
    writeRowsCsv(rows, `rows-mlb-${season}.csv`);
  }

  // Combined output if multiple seasons
  if (seasons.length > 1) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`MLB Combined — ${seasons.join(", ")}`);
    console.log("=".repeat(60));
    const combinedSummary = summarize(allRows);
    printTable(combinedSummary);
    writeCsv(combinedSummary, `calibration-mlb-combined.csv`);
    writeRowsCsv(allRows, `rows-mlb-combined.csv`);
  }

  return allRows;
}

async function runNBA(seasons) {
  const allRows = [];
  for (const season of seasons) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`NBA Backtest — ${season}`);
    console.log("=".repeat(60));
    const data = await collectNBASeason(season);
    const rows = simulateAllNBA(data);
    for (const r of rows) allRows.push(r);
    const summary = summarize(rows);
    printTable(summary);
    writeCsv(summary, `calibration-nba-${season}.csv`);
    writeRowsCsv(rows, `rows-nba-${season}.csv`);
  }
  if (seasons.length > 1) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`NBA Combined — ${seasons.join(", ")}`);
    console.log("=".repeat(60));
    const combined = summarize(allRows);
    printTable(combined);
    writeCsv(combined, `calibration-nba-combined.csv`);
    writeRowsCsv(allRows, `rows-nba-combined.csv`);
  }
  return allRows;
}

async function main() {
  const { sport, seasons } = parseArgs();
  console.log(`\nBacktest: sport=${sport} seasons=${seasons.join(",")}`);
  console.log("Note: MLB lambda excludes regime blend — expect some delta vs live model on totals/ML.");
  console.log("      Calibration curve shape and K model results are directly comparable.\n");

  const t0 = Date.now();

  if (sport === "mlb") {
    await runMLB(seasons);
  } else if (sport === "nba") {
    await runNBA(seasons);
  } else if (sport === "nhl") {
    console.log("NHL Phase 3 not yet implemented. Run with --sport mlb.");
    process.exit(1);
  } else {
    console.error(`Unknown sport: ${sport}. Use mlb, nba, or nhl.`);
    process.exit(1);
  }

  console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
