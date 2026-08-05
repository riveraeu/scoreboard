// api/lib/polymarket-capture.js — Polymarket capture-all + resolver (2026-08-04).
//
// The Poly analog of shadow_plays: logs ONE model-free row per quoted side of every game-ML / total
// / first-five (F5) market, captured pre-game, and grades it off Poly's own UMA settlement. This is
// the quote+outcome substrate for the cross-venue "venue-vig per category×band" view — NOT the
// maker-fill instrument (that's a later layer). Failure-closed everywhere: a Poly hiccup must never
// break the shadow_plays snapshot or the resolver.
//
// CAPTURE DOCTRINE (mirrors CLAUDE.md's Kalshi capture, applied to the Poly CLOB):
//   - own ask per token — each side's OWN CLOB best ask, NEVER 1−yes (walk the book, don't synthesize)
//   - band gate     [CAPTURE_GATE 1, CAPTURE_CAP 99]¢ — a 0¢/100¢ ask is an absent quote, not a price
//   - liquidity gate capturableSpread ≤ CAPTURE_MAX_SPREAD 15¢ — a lone wide quote is an artifact ask
//   - pre-game only — Poly trades in-play, so already-commenced events are dropped (a live price is
//     not a pre-game reference; same class as normalizeEvent / sportsbook-deltas)
//   - model-free — no truePct, no edge, no bet flag; every row is `model_free = true`
//
// RESOLUTION: each closed market carries `umaResolutionStatus:"resolved"` + `outcomePrices` of
// exactly ["1","0"]/["0","1"] — the winner is the outcome that settled to "1". Grading is: refetch
// the row's market by its Gamma `market_id` (GET /markets/{id}), and won = (row.token_id === the
// "1"-priced token). Anything else (still pending, or a non-binary/scalar/void settlement) is left
// unresolved and retried, or voided terminally after 14 days — never guessed.

import { POLY_SERIES, fetchPolySeriesEvents, normPolyTeam } from "./polymarket.js";
import { fetchPolyOrderbook } from "./polymarket-book.js";
import { CAPTURE_GATE, CAPTURE_CAP, capturableSpread } from "./config.js";
import { pLimit } from "./utils.js";
import { PT_FMT } from "./pt.js";
import { neonQuery, neonBatchUpsert } from "./neon.js";
import { POLY_PLAYS_TABLE, POLY_PLAYS_COLUMNS } from "./handlers/shadow/common.js";

const GAMMA = "https://gamma-api.polymarket.com";

// Bounded CLOB walk budget per capture run (both sides of every in-band candidate market). A normal
// MLB+WNBA slate is a few hundred candidate sides; the cap is a runaway guard, NOT a silent trim —
// exceeding it is logged (capture doctrine: no silent caps).
export const POLY_CAPTURE_MAX_WALKS = 800;
const CLOB_CONCURRENCY = 8;

function _parseArr(s) {
  if (Array.isArray(s)) return s;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Gamma `gameStartTime` ("2026-08-06 01:40:00+00" or ISO) → epoch ms, or null. Scans markets[] — the
// event-level `startDate` is market CREATION time, useless as a game clock (see polymarket.js).
function _gameStartMs(event) {
  const gst = (event?.markets || []).find((m) => m?.gameStartTime)?.gameStartTime;
  if (!gst) return null;
  const t = Date.parse(String(gst).replace(" ", "T").replace(/\+00$/, "Z"));
  return Number.isFinite(t) ? t : null;
}

// Parse a Poly event ticker → { sport, awayPoly, homePoly, dateStr, family } or null. Unlike
// polymarket.js's strict parseGameTicker (game-ML only), this ALSO admits the `-first-five-winner`
// segment family. Player-props / futures / other suffixes are rejected (null). `family` is 'game'
// (base event: ML + totals live inside it) or 'f5'.
export function parseCaptureTicker(ticker) {
  const t = String(ticker || "");
  const base = /^(mlb|nba|nhl|wnba)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})$/.exec(t);
  if (base) return { sport: base[1], awayPoly: base[2], homePoly: base[3], dateStr: base[4], family: "game" };
  const f5 = /^(mlb|nba|nhl|wnba)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})-first-five-winner$/.exec(t);
  if (f5) return { sport: f5[1], awayPoly: f5[2], homePoly: f5[3], dateStr: f5[4], family: "f5" };
  return null;
}

// A real two-sided market (not an untraded 0.5/0.5 placeholder). Mirrors polymarket.js `_liquid`.
function _liquid(m) {
  const b = Number(m?.bestBid), a = Number(m?.bestAsk);
  if (!isFinite(b) || !isFinite(a)) return false;
  return b > 0.02 && a < 0.98;
}

// Top-of-book from a CLOB book { bids, asks } (each [{price,size}], strings 0–1) → { askC, bidC,
// spreadC } in cents, or null when either side is empty. Pure. The ask is this token's OWN best ask
// (band + spread gates read these), never a 1−yes synthesis.
export function topOfBook(book) {
  const asks = (book?.asks || []).map((a) => Number(a.price)).filter((p) => p > 0 && p < 1);
  const bids = (book?.bids || []).map((b) => Number(b.price)).filter((p) => p > 0 && p < 1);
  if (!asks.length || !bids.length) return null;
  const askC = +(Math.min(...asks) * 100).toFixed(1);
  const bidC = +(Math.max(...bids) * 100).toFixed(1);
  return { askC, bidC, spreadC: +(askC - bidC).toFixed(1) };
}

// Category ('ml' | 'total' | 'f5') for a market, or null to skip (spreads, unknown types). F5-family
// events carry their winner as a moneyline-typed market; everything under a base game event is
// keyed off sportsMarketType.
function _category(family, sportsMarketType) {
  if (family === "f5") return "f5";
  if (sportsMarketType === "moneyline") return "ml";
  if (sportsMarketType === "totals") return "total";
  return null;
}

// Best-effort normalized side label for the vig-by-category buckets. Grading never depends on this
// (the winner is decided by token id), so an unrecognized label is stored verbatim, not dropped.
function _side(category, outcome, idx) {
  const o = String(outcome || "");
  if (category === "total") return /over/i.test(o) ? "over" : /under/i.test(o) ? "under" : o.toLowerCase();
  if (category === "ml") return idx === 0 ? "away" : "home"; // Poly ordering is [away, home]
  return /yes/i.test(o) ? "yes" : /no/i.test(o) ? "no" : o.toLowerCase(); // f5
}

// Pure: raw Gamma event → array of pre-CLOB capture candidates (one per outcome of each ml/total/f5
// market). Drops in-play/finished events (Poly trades live) and non-liquid placeholder markets.
// Each candidate carries everything the row needs EXCEPT the walked ask/bid/spread.
export function buildCaptureCandidates(event, nowMs = Date.now()) {
  const tk = parseCaptureTicker(event?.ticker);
  if (!tk) return [];
  const startMs = _gameStartMs(event);
  if (startMs != null && startMs <= nowMs) return []; // in-play or finished — live odds, skip
  const gameDate = startMs != null ? PT_FMT.format(new Date(startMs)) : tk.dateStr;
  const away = normPolyTeam(tk.sport, tk.awayPoly);
  const home = normPolyTeam(tk.sport, tk.homePoly);
  const game = away && home ? `${away}@${home}` : null;

  const out = [];
  for (const m of (event?.markets || [])) {
    if (m?.closed || m?.active === false || !_liquid(m)) continue;
    const category = _category(tk.family, m.sportsMarketType);
    if (!category) continue;
    const outcomes = _parseArr(m.outcomes).map(String);
    const tokens = _parseArr(m.clobTokenIds).map(String);
    const prices = _parseArr(m.outcomePrices).map(Number);
    if (tokens.length !== 2 || outcomes.length !== 2) continue; // binary markets only
    const line = category === "total" && isFinite(Number(m.line)) ? Number(m.line) : null;
    for (let i = 0; i < 2; i++) {
      const gammaPriceC = isFinite(prices[i]) ? +(prices[i] * 100).toFixed(1) : null;
      out.push({
        sport: tk.sport, category, event_ticker: event.ticker, market_id: String(m.id),
        game, game_date: gameDate, token_id: tokens[i], outcome: outcomes[i],
        side: _side(category, outcomes[i], i), line, gammaPriceC,
      });
    }
  }
  return out;
}

const _ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

// Capture pass: fetch Poly events for all modeled leagues, build candidates, walk each in-band
// candidate's CLOB book for its own ask/spread, apply the capture gates, and upsert model-free rows
// into polymarket_plays. Failure-closed → returns { logged, candidates, walked, dropped }.
export async function capturePolymarketPlays({ env, snapshotDate, now = new Date(), maxWalks = POLY_CAPTURE_MAX_WALKS } = {}) {
  const nowMs = now.getTime();
  const lo = _ymd(new Date(nowMs - 86400000));
  const hi = _ymd(new Date(nowMs + 2 * 86400000));
  const inWindow = (d) => d >= lo && d <= hi;

  const lists = await Promise.all(Object.values(POLY_SERIES).map((s) => fetchPolySeriesEvents(s, 200)));
  let candidates = [];
  for (const list of lists) {
    for (const ev of (list || [])) {
      for (const c of buildCaptureCandidates(ev, nowMs)) {
        if (inWindow(c.game_date)) candidates.push(c);
      }
    }
  }
  // Pre-filter before spending CLOB fetches: the market's Gamma quote must sit in the capture band.
  const walkable = candidates.filter((c) => c.gammaPriceC != null && c.gammaPriceC >= CAPTURE_GATE && c.gammaPriceC <= CAPTURE_CAP);
  if (walkable.length > maxWalks) {
    console.warn(`[poly-capture] ${walkable.length} in-band candidates > maxWalks ${maxWalks} — capping (some sides not walked this run)`);
  }
  const targets = walkable.slice(0, maxWalks);

  const limit = pLimit(CLOB_CONCURRENCY);
  const rows = [];
  let walked = 0, dropped = 0;
  await Promise.all(targets.map((c) => limit(async () => {
    const book = await fetchPolyOrderbook(c.token_id);
    walked++;
    const tob = book ? topOfBook(book) : null;
    if (!tob) { dropped++; return; }
    // Real-book gates (own ask, not the Gamma pre-filter): band + capturableSpread.
    if (tob.askC < CAPTURE_GATE || tob.askC > CAPTURE_CAP || !capturableSpread(tob.spreadC)) { dropped++; return; }
    rows.push({
      id: `${snapshotDate}|${c.token_id}`,
      snapshot_date: snapshotDate,
      sport: c.sport,
      event_ticker: c.event_ticker,
      market_id: c.market_id,
      category: c.category,
      game: c.game,
      game_date: c.game_date,
      token_id: c.token_id,
      outcome: c.outcome,
      side: c.side,
      line: c.line,
      ask_c: tob.askC,
      bid_c: tob.bidC,
      spread_c: tob.spreadC,
      gamma_price_c: c.gammaPriceC,
      model_free: true,
      won: null,
      resolved: false,
    });
  })));

  let logged = 0;
  if (rows.length) {
    // DO UPDATE (latest snapshot of the day wins) so a re-price late in the day refreshes ask/spread.
    await neonBatchUpsert(POLY_PLAYS_TABLE, POLY_PLAYS_COLUMNS, rows, env, 100, [
      "ask_c", "bid_c", "spread_c", "gamma_price_c",
    ]);
    logged = rows.length;
    console.log(`[poly-capture] logged=${logged} candidates=${candidates.length} walked=${walked} dropped=${dropped}`);
  } else {
    console.log(`[poly-capture] logged=0 candidates=${candidates.length} walked=${walked} dropped=${dropped}`);
  }
  return { logged, candidates: candidates.length, walked, dropped };
}

// Pure: a refetched Gamma market → { status: 'resolved'|'pending'|'void', winningTokenId }.
// 'resolved' with clean ["1","0"]/["0","1"] prices names the winner; any other settled shape (scalar,
// tie, malformed) is a terminal 'void'; anything not yet settled is 'pending' (retry next pass).
export function gradePolyMarket(market) {
  if (String(market?.umaResolutionStatus || "").toLowerCase() !== "resolved") return { status: "pending" };
  const prices = _parseArr(market.outcomePrices).map(Number);
  const tokens = _parseArr(market.clobTokenIds).map(String);
  if (prices.length !== 2 || tokens.length !== 2) return { status: "void" };
  const ones = prices.filter((p) => p === 1).length;
  const zeros = prices.filter((p) => p === 0).length;
  if (ones !== 1 || zeros !== 1) return { status: "void" }; // not a clean binary settlement
  return { status: "resolved", winningTokenId: tokens[prices[0] === 1 ? 0 : 1] };
}

async function _fetchMarket(id) {
  try {
    const res = await fetch(`${GAMMA}/markets/${id}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Batch-set resolution on polymarket_plays rows. Own helper because neonBatchResolve hardcodes
// shadow_plays. `won` may be true/false (graded) or null (void).
async function _resolvePolyRows(updates, env, chunkSize = 100) {
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, ri) => `($${ri * 2 + 1}, $${ri * 2 + 2}::boolean)`).join(", ");
    const values = chunk.flatMap((u) => [u.id, u.won ?? null]);
    await neonQuery(
      `UPDATE ${POLY_PLAYS_TABLE} AS t SET resolved = TRUE, won = v.won, resolved_at = NOW()
       FROM (VALUES ${placeholders}) AS v(id, won)
       WHERE t.id = v.id`,
      values, env, { write: true },
    );
  }
}

// Resolve pass: grade unresolved polymarket_plays rows off Poly's UMA settlement. Dedups by
// market_id (both sides of a market grade from one refetch), leaves still-pending markets for the
// next run, and voids rows sitting unresolved >14 days (postponed/never-settled) so the scan can't
// starve. Failure-closed → returns counts.
export async function resolvePolymarketPlays({ env, now = new Date(), limit = 3000 } = {}) {
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  // Abandon rows unresolved for 14+ days (won = NULL, terminal) — mirrors the shadow_plays sweep.
  const cutoff = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
  const abandoned = await neonQuery(
    `UPDATE ${POLY_PLAYS_TABLE} SET resolved = TRUE, resolved_at = NOW()
     WHERE resolved = FALSE AND COALESCE(game_date, snapshot_date::varchar) < $1 RETURNING id`,
    [cutoff], env, { write: true },
  ).catch((e) => { console.error(`[poly-resolve] abandon failed: ${e?.message}`); return []; });

  // Only grade rows whose game day has passed (markets settle shortly after game end).
  const rows = await neonQuery(
    `SELECT id, market_id, token_id FROM ${POLY_PLAYS_TABLE}
     WHERE resolved = FALSE AND COALESCE(game_date, snapshot_date::varchar) < $1
     ORDER BY snapshot_date DESC LIMIT $2`,
    [today, limit], env, { write: true },
  ).catch((e) => { console.error(`[poly-resolve] select failed: ${e?.message}`); return []; });
  if (!rows.length) return { graded: 0, voided: 0, pending: 0, abandoned: abandoned.length, markets: 0 };

  const byMarket = new Map();
  for (const r of rows) {
    if (!byMarket.has(r.market_id)) byMarket.set(r.market_id, []);
    byMarket.get(r.market_id).push(r);
  }

  const limitFetch = pLimit(CLOB_CONCURRENCY);
  const updates = [];
  let pending = 0, voided = 0, graded = 0;
  await Promise.all([...byMarket.entries()].map(([marketId, marketRows]) => limitFetch(async () => {
    const market = await _fetchMarket(marketId);
    if (!market) { pending += marketRows.length; return; }
    const verdict = gradePolyMarket(market);
    if (verdict.status === "pending") { pending += marketRows.length; return; }
    for (const r of marketRows) {
      if (verdict.status === "void") { updates.push({ id: r.id, won: null }); voided++; }
      else { updates.push({ id: r.id, won: r.token_id === verdict.winningTokenId }); graded++; }
    }
  })));

  if (updates.length) await _resolvePolyRows(updates, env);
  console.log(`[poly-resolve] graded=${graded} voided=${voided} pending=${pending} abandoned=${abandoned.length} markets=${byMarket.size}`);
  return { graded, voided, pending, abandoned: abandoned.length, markets: byMarket.size };
}
