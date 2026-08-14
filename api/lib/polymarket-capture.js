// api/lib/polymarket-capture.js — Polymarket capture-all + resolver (2026-08-04).
//
// The Poly analog of shadow_plays: logs ONE model-free row per quoted side of every market family
// listed in that league's `POLY_MARKETS.categories` (polymarket.js) — the registry is the single
// source for which leagues and families are captured. Rows are captured pre-game and graded off
// Poly's own UMA settlement. This is
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

import { POLY_MARKETS, POLY_SPORTS_RE, POLY_SERIES, fetchPolySeriesEvents, normPolyTeam } from "./polymarket.js";
import { fetchPolyOrderbook } from "./polymarket-book.js";
import { CAPTURE_GATE, CAPTURE_CAP, capturableSpread } from "./config.js";
import { pLimit } from "./utils.js";
import { PT_FMT } from "./pt.js";
import { neonQuery, neonBatchUpsert } from "./neon.js";
import { POLY_PLAYS_TABLE, POLY_PLAYS_COLUMNS } from "./handlers/shadow/common.js";

const GAMMA = "https://gamma-api.polymarket.com";

// Bounded CLOB walk budget per capture run (both sides of every in-band candidate market). The cap
// is a runaway guard, NOT a silent trim — exceeding it is logged (capture doctrine: no silent caps).
// Raised 800 → 2000 on 2026-08-13 with the spread/f5total/f5spread categories: 800 was sized for
// ml+total+f5 on MLB+WNBA (~286 sides) and the three new families add ~336 sides on MLB alone,
// before NBA/NHL come back in season.
export const POLY_CAPTURE_MAX_WALKS = 2000;
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

// Parse a Poly event ticker → { sport, awayPoly, homePoly, dateStr } or null. Unlike polymarket.js's
// strict parseGameTicker (bare game tickers only), this ALSO admits the `-first-five-winner` event.
// Player-props / futures / other suffixes are rejected (null).
//
// `segment` is 'f5' for the `-first-five-winner` event, else null. Category is otherwise decided by
// `sportsMarketType` alone (2026-08-13) — the F5 winner carries its own type
// (`baseball_team_first_five_winner`), verified live, so the old `family` plumbing is gone. The flag
// survives ONLY as a guard: the 2026-08-04 build observed that event's winner as a `moneyline`-typed
// market, and if Poly ever types it that way again, an F5 winner would silently land in the `ml`
// bucket — corrupting the exact population the venue-vig compares rather than failing visibly.
export function parseCaptureTicker(ticker) {
  const m = new RegExp(
    `^(${POLY_SPORTS_RE})-([a-z0-9]+)-([a-z0-9]+)-(\\d{4}-\\d{2}-\\d{2})(-first-five-winner)?$`
  ).exec(String(ticker || ""));
  if (!m) return null;
  return { sport: m[1], awayPoly: m[2], homePoly: m[3], dateStr: m[4], segment: m[5] ? "f5" : null };
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

// Categories carrying a threshold/handicap. Their `line` is part of the market's identity — a
// spread row without it is indistinguishable from the opposite alt line, the same unrecoverable-
// column class as a dropped row missing its ticker.
const _LINED = new Set(["total", "spread", "f5total", "f5spread"]);
// Categories whose two outcomes are the two TEAMS by display name ("Tampa Bay Rays"), not Over/Under
// or Yes/No. **Their outcome order is NOT away-first** — measured 2026-08-13 over 78 live MLB spread
// markets: 38 matched the moneyline's away-first order and 40 did not, and outcome[0] is not the
// favorite either (0 of 78). So these MUST resolve their side by NAME, never by index.
const _NAME_SIDED = new Set(["spread", "f5spread"]);
// …and their `line` is stated from outcome[0]'s perspective: one event carries BOTH "TB −1.5" and
// "NYY −1.5" as separate markets with flipped orderings. Each row therefore stores the line from its
// OWN side's perspective, so a row is self-describing instead of needing the ordering convention.
const _SIGNED_LINE = _NAME_SIDED;

// Best-effort normalized side label for the vig-by-category buckets. Grading never depends on this
// (the winner is decided by token id), so an unrecognized label is stored verbatim, not dropped —
// and an unmatched team name yields the verbatim name rather than a coin-flip away/home claim.
function _side(category, outcome, idx, nameToSide) {
  const o = String(outcome || "");
  if (category === "ml") return idx === 0 ? "away" : "home"; // ml IS the away-first reference
  if (_NAME_SIDED.has(category)) return nameToSide?.[o] || o.toLowerCase();
  if (/over/i.test(o)) return "over";
  if (/under/i.test(o)) return "under";
  if (/yes/i.test(o)) return "yes";
  if (/no/i.test(o)) return "no";
  return o.toLowerCase();
}

// Soccer's 3-way winner shape (Phase 2, 2026-08-14): unlike every other league here, a soccer game
// event carries THREE separate "moneyline"-typed markets — "Will X win?", "Will X vs Y end in a
// draw?", "Will Y win?" — each with generic outcomes ["Yes","No"], not one market with two
// team-named outcomes. Structurally isomorphic to Kalshi's own soccer capture (three separate YES
// markets per game, model-free-ml.js) — the only new work is parsing team/draw identity out of
// `question` text and capturing ONLY the YES token per market (the No side is a redundant
// complement, same reasoning as the YES-only Dota2/UFC captures). Verified live against MLS + EPL
// only — a new soccer league needs its own phrasing check before flipping on `winnerShape`.
const _SOCCER_DRAW_RE = /end in a draw\??$/i;
const _SOCCER_WIN_RE = /^Will\s+(.+?)\s+win\s+on\s+\d{4}-\d{2}-\d{2}\??$/i;

// question -> {side, outcome} or null (unrecognized phrasing — dropped, never guessed). No team
// registry backs soccer capture (game stays null, see buildCaptureCandidates below), so the name
// is stored verbatim rather than resolved to a canonical code — same fallback doctrine as
// _NAME_SIDED when there's no moneyline reference to resolve against.
function _soccerMlSide(question) {
  const q = String(question || "");
  if (_SOCCER_DRAW_RE.test(q)) return { side: "tie", outcome: "Draw" };
  const m = _SOCCER_WIN_RE.exec(q);
  if (!m) return null;
  const name = m[1].trim();
  return { side: name.toLowerCase(), outcome: name };
}

// Display-name → 'away'/'home', read off the event's OWN moneyline market (the one market whose
// order is reliably [away, home]). Empty when the event has no live moneyline — the F5-winner event,
// or the occasional game event without one — in which case name-sided rows keep the verbatim name.
function _nameToSide(event) {
  const ml = (event?.markets || []).find(
    (m) => m?.sportsMarketType === "moneyline" && !m?.closed && m?.active !== false
  );
  const o = _parseArr(ml?.outcomes).map(String);
  return o.length === 2 ? { [o[0]]: "away", [o[1]]: "home" } : {};
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

  const categories = POLY_MARKETS[tk.sport]?.categories || {};
  const nameToSide = _nameToSide(event);
  const out = [];
  for (const m of (event?.markets || [])) {
    if (m?.closed || m?.active === false || !_liquid(m)) continue;
    // On the F5 event, a plain moneyline IS the first-five winner (see parseCaptureTicker).
    const category = tk.segment === "f5" && categories[m.sportsMarketType] === "ml"
      ? "f5" : categories[m.sportsMarketType];
    if (!category) continue;
    const outcomes = _parseArr(m.outcomes).map(String);
    const tokens = _parseArr(m.clobTokenIds).map(String);
    const prices = _parseArr(m.outcomePrices).map(Number);
    if (tokens.length !== 2 || outcomes.length !== 2) continue; // binary markets only

    // Soccer 3-way: one row per market (the YES token only), not two — see _soccerMlSide above.
    if (category === "ml" && POLY_MARKETS[tk.sport]?.winnerShape === "3wayYesNo") {
      const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(o));
      if (yesIdx === -1) continue; // not actually Yes/No — shouldn't happen for this shape
      const parsed = _soccerMlSide(m.question);
      if (!parsed) continue; // unrecognized question phrasing — drop rather than guess
      const gammaPriceC = isFinite(prices[yesIdx]) ? +(prices[yesIdx] * 100).toFixed(1) : null;
      out.push({
        sport: tk.sport, category, event_ticker: event.ticker, market_id: String(m.id),
        game, game_date: gameDate, token_id: tokens[yesIdx], outcome: parsed.outcome,
        side: parsed.side, line: null, gammaPriceC,
      });
      continue;
    }

    const line = _LINED.has(category) && isFinite(Number(m.line)) ? Number(m.line) : null;
    for (let i = 0; i < 2; i++) {
      const gammaPriceC = isFinite(prices[i]) ? +(prices[i] * 100).toFixed(1) : null;
      out.push({
        sport: tk.sport, category, event_ticker: event.ticker, market_id: String(m.id),
        game, game_date: gameDate, token_id: tokens[i], outcome: outcomes[i],
        side: _side(category, outcomes[i], i, nameToSide),
        line: line != null && i === 1 && _SIGNED_LINE.has(category) ? -line : line,
        gammaPriceC,
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
