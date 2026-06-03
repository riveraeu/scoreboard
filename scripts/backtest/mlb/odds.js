// Historical MLB closing-line loader for edge testing.
//
// Returns Map<"DATE|HOME|AWAY", OddsRecord> where DATE = "YYYY-MM-DD" and
// HOME/AWAY are MLB Stats API abbreviations (e.g. "BOS", "NYY", "CWS").
//
// ── Wiring up a data source ──────────────────────────────────────────────────
// Option A — CSV file (recommended):
//   Drop a CSV at scripts/backtest/data/mlb-odds-{season}.csv with columns:
//     date,homeAbbr,awayAbbr,mlHome,mlAway,total,overJuice,underJuice,rlHomeJuice,rlAwayJuice
//   All juice/ML values are American odds (e.g. -110, +130).
//   The loader auto-detects this file and imports it.
//
// Option B — The-Odds-API (paid plan):
//   Set ODDS_API_KEY in env, uncomment loadFromOddsAPI() below, call it from collectOdds().
//   Historical endpoint: GET /v4/historical/sports/baseball_mlb/odds/
//   Requires Pro/Ultra plan (~$79+/mo). Free tier is live-only.
//
// Option C — Kalshi shadow data (already accumulating since 2026-06-02):
//   For live edge testing on recent picks, query shadow_plays with kalshi_yes_price / kalshi_no_price.
//   This is the right source going forward; the historical backtest just can't use it.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir   = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dir, "../data");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Devigging ─────────────────────────────────────────────────────────────────

// Convert American odds to raw implied probability (includes vig).
function americanToRaw(american) {
  if (american == null || isNaN(american)) return null;
  return american < 0 ? (-american) / (-american + 100) : 100 / (american + 100);
}

// Devig a two-sided market → [fairA, fairB] summing to 1.0.
export function devigTwo(amA, amB) {
  const pA = americanToRaw(amA);
  const pB = americanToRaw(amB);
  if (pA == null || pB == null) return [null, null];
  const total = pA + pB;
  return [pA / total, pB / total];
}

// ── OddsRecord schema ─────────────────────────────────────────────────────────
// {
//   mlHome: number,        // Home ML (American, e.g. -135)
//   mlAway: number,        // Away ML (American, e.g. +115)
//   total: number,         // Posted game O/U line (e.g. 8.5)
//   overJuice: number,     // Over juice (American, typically -110)
//   underJuice: number,    // Under juice (American, typically -110)
//   rlHomeJuice: number,   // Home run-line -1.5 juice (American)
//   rlAwayJuice: number,   // Away run-line +1.5 juice (American)
// }

// ── CSV loader ─────────────────────────────────────────────────────────────────

function loadFromCSV(season) {
  const path = join(DATA_DIR, `mlb-odds-${season}.csv`);
  if (!existsSync(path)) return null;

  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = lines[0].split(",").map(s => s.trim());
  const map = new Map();

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",").map(s => s.trim());
    const rec = {};
    header.forEach((col, j) => { rec[col] = row[j]; });

    const key = `${rec.date}|${rec.homeAbbr}|${rec.awayAbbr}`;
    map.set(key, {
      mlHome:     parseFloat(rec.mlHome)     || null,
      mlAway:     parseFloat(rec.mlAway)     || null,
      total:      parseFloat(rec.total)      || null,
      overJuice:  parseFloat(rec.overJuice)  || null,
      underJuice: parseFloat(rec.underJuice) || null,
      rlHomeJuice: parseFloat(rec.rlHomeJuice) || null,
      rlAwayJuice: parseFloat(rec.rlAwayJuice) || null,
    });
  }

  console.log(`  [odds] Loaded ${map.size} games from ${path}`);
  return map;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function collectOdds(season) {
  // Try CSV first (manually downloaded or generated from any source).
  const csv = loadFromCSV(season);
  if (csv) return csv;

  // No data source configured.
  console.log(`  [odds] No odds file found for ${season}.`);
  console.log(`         To enable edge testing, place a CSV at:`);
  console.log(`         scripts/backtest/data/mlb-odds-${season}.csv`);
  console.log(`         Columns: date,homeAbbr,awayAbbr,mlHome,mlAway,total,overJuice,underJuice,rlHomeJuice,rlAwayJuice`);
  return new Map();
}

// ── Market probability helpers ─────────────────────────────────────────────────

// Given an OddsRecord for a game, return the devigged market probability for:
//   - mlb|ml home team win
//   - mlb|ml away team win
export function mlMarketPcts(rec) {
  if (!rec?.mlHome || !rec?.mlAway) return { home: null, away: null };
  const [h, a] = devigTwo(rec.mlHome, rec.mlAway);
  return { home: h != null ? parseFloat((h * 100).toFixed(2)) : null,
           away: a != null ? parseFloat((a * 100).toFixed(2)) : null };
}

// Devigged market probability for the game total OVER at the posted line.
// Returns { overPct, underPct, postedTotal } or nulls if no data.
export function totalMarketPcts(rec) {
  if (!rec?.total || !rec?.overJuice || !rec?.underJuice) return { overPct: null, underPct: null, postedTotal: null };
  const [o, u] = devigTwo(rec.overJuice, rec.underJuice);
  return {
    overPct:     o != null ? parseFloat((o * 100).toFixed(2)) : null,
    underPct:    u != null ? parseFloat((u * 100).toFixed(2)) : null,
    postedTotal: rec.total,
  };
}

// Devigged run-line market probability for home -1.5 / away +1.5.
export function spreadMarketPcts(rec) {
  if (!rec?.rlHomeJuice || !rec?.rlAwayJuice) return { home: null, away: null };
  const [h, a] = devigTwo(rec.rlHomeJuice, rec.rlAwayJuice);
  return { home: h != null ? parseFloat((h * 100).toFixed(2)) : null,
           away: a != null ? parseFloat((a * 100).toFixed(2)) : null };
}
