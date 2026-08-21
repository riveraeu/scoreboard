// api/lib/tonight/ml-spread.js
// ML / spread / segment-total / halves / quarters capture — all sports.
//
// Model-free (2026-08-04, model teardown): every joint-simulation model (simulateMLBJoint /
// simulateNBAJoint → mlPctFromJoint / joint3WayPct / spreadPctFromJoint / totalDistPct) was
// deleted. No truePct/edge is computed — each quoted Kalshi side becomes one model-free row for
// the maker instrument. `truePct`/`edge` are null, `qualified` is false, `modelFree` is true. No
// window/edge gate (capture-all-sides): ML legs are still liquidity-gated at read via `_kMlLegProb`
// (the `capturableSpread` doctrine — a dead one-sided book is not a price), and totals/spreads
// were already CAPTURE-band + `capturableSpread` gated at parse in tonight.js.
//
// What stays: the self-contained Kalshi fetch + event grouping for the WINNER series that are NOT
// pre-parsed into totalMarkets/spreadMarkets (KXMLBGAME/NBAGAME/WNBAGAME/NHLGAME, the F3/F5/F7
// segment 3-way, the NBA/WNBA halves + WNBA quarter winners); the spread loops over spreadMarkets;
// the segment-total loops over totalMarkets; the postponed-ticker reattribution; and — critically —
// the home/away resolution, which comes from the `_*MlContext` maps game-totals.js built (Kalshi
// ticker order != ESPN home/away, and MLB/NBA/WNBA/NHL grade off ESPN /api/live where a wrong
// home/away silently mis-grades). ML/spread/segment coverage is therefore the set of games that
// have a full-game total market — the same coupling as the model era.

import { capturableSpread } from "../config.js";
import { PT_FMT } from "../pt.js";
import { normTeam } from "./parse-teams.js";

// Implied YES prob (dollars, 0..1) for one ML leg, or null when the leg has no real two-sided book.
// Same liquidity gate as the model era — dead segment books (F3/F7 inning winners, WNBA
// quarter/half winners) list ~95¢ asks on every leg pre-game; a rejected leg fails the event's
// 2-way/3-way completeness check downstream, dropping the whole event. Stale-ask path (ask maxed
// ≥98¢, no bid, real `last`) stays exempt and prices off `last`.
const _kMlLegProb = (m) => {
  const a = parseFloat(m.yes_ask_dollars) || 0;
  const l = parseFloat(m.last_price_dollars) || 0;
  const b = parseFloat(m.yes_bid_dollars) || 0;
  if (a >= 0.98 && b === 0 && l > 0) return l; // stale-ask path
  if (a > 0 && !capturableSpread(Math.round((a - b) * 100))) return null; // dead book
  return a > 0 ? a : l;
};

const _kGameDate = (m) => m?.expected_expiration_time ? PT_FMT.format(new Date(m.expected_expiration_time)) : null;
const _toAO = (p) => p == null ? null : p >= 50 ? Math.round(-(p / (100 - p)) * 100) : Math.round((100 - p) / p * 100);
// Common model-free markers spread onto every emitted row.
const _MF = { truePct: null, edge: null, dataConfidence: null, dcQualified: false, qualified: false, modelFree: true };

// Context: plays (mutated), cutoffStr, gameTimes, _todayPT, CACHE2/isBustCache,
//          _*MlContext maps, spreadMarkets, totalMarkets,
//          mlbBothTeamsConfirmed / reattrMlbGameDate (closures from handleTonightRoute).
export async function emitAllMlAndSpread({
  plays, dropped, isDebug, cutoffStr, gameTimes, _todayPT,
  CACHE2, isBustCache,
  _mlbMlContext, _nbaMlContext, _wnbaMlContext, _nhlMlContext, _nflMlContext,
  spreadMarkets, totalMarkets,
  mlbBothTeamsConfirmed: _mlbBothTeamsConfirmed,
  reattrMlbGameDate: _reattrMlbGameDate,
}) {
  // Self-contained snap → 600s cache → REST fetch for a Kalshi winner series (same read chain as
  // the kalshi-snapshot cron). One helper for all winner series (replaces ~7 inline copies).
  const _fetchSeries = async (seriesTicker) => {
    const _snapKey = `kalshi:snap:${seriesTicker}`;
    const _legKey = `kalshi:${seriesTicker}`;
    let _data = null;
    if (CACHE2 && !isBustCache) {
      const _snap = await CACHE2.get(_snapKey, 'json').catch(() => null);
      if (_snap && Array.isArray(_snap.markets) && _snap.markets.length > 0 &&
          (Date.now() - (_snap.writtenAt || 0) <= 180_000)) {
        _data = { markets: _snap.markets };
      }
    }
    if (!_data && CACHE2 && !isBustCache) _data = await CACHE2.get(_legKey, 'json').catch(() => null);
    if (!_data) {
      const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}&limit=1000&status=open`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }).catch(() => null);
      if (r?.ok) {
        _data = await r.json().catch(() => null);
        if (_data && CACHE2) CACHE2.put(_legKey, JSON.stringify(_data), { expirationTtl: 600 }).catch(() => {});
      }
    }
    return _data?.markets || [];
  };

  const _gt = (sport, homeTeam, awayTeam, gameDate) =>
    gameTimes[`${sport}:${homeTeam}:${gameDate}`] ?? gameTimes[`${sport}:${awayTeam}:${gameDate}`]
    ?? gameTimes[`${sport}:${homeTeam}`] ?? gameTimes[`${sport}:${awayTeam}`] ?? null;

  // ── 2-way ML winner maps (home/away). Grouped by event → { yesByTeam, tickerByTeam }, keyed
  // both orientations. MLB applies postponed-ticker reattribution to gameDate. ────────────────
  const _build2WayMl = async (seriesTicker, sport, { reattr = false } = {}) => {
    const out = {};
    try {
      const raw = await _fetchSeries(seriesTicker);
      const byEvent = {};
      for (const m of raw) {
        const tk = m.ticker || '';
        const lastDash = tk.lastIndexOf('-');
        if (lastDash < 0) continue;
        const abbr = normTeam(sport, tk.slice(lastDash + 1));
        const eventT = m.event_ticker;
        if (!eventT || !abbr) continue;
        const p = _kMlLegProb(m);
        if (!p || p <= 0 || p >= 1) continue;
        if (!byEvent[eventT]) byEvent[eventT] = { probs: {}, tickers: {}, gameDate: _kGameDate(m) };
        byEvent[eventT].probs[abbr] = p;
        byEvent[eventT].tickers[abbr] = tk;
      }
      for (const info of Object.values(byEvent)) {
        const teams = Object.keys(info.probs);
        if (teams.length !== 2 || !info.gameDate) continue;
        const [t1, t2] = teams;
        let date = info.gameDate;
        if (reattr) {
          const resolved = Math.min(info.probs[t1], info.probs[t2]) <= 0.02 || Math.max(info.probs[t1], info.probs[t2]) >= 0.99;
          date = _reattrMlbGameDate(info.gameDate, t1, t2, resolved);
        }
        const payload = { yesByTeam: { [t1]: info.probs[t1], [t2]: info.probs[t2] }, tickerByTeam: { [t1]: info.tickers?.[t1], [t2]: info.tickers?.[t2] } };
        out[`${t1}|${t2}|${date}`] = payload;
        out[`${t2}|${t1}|${date}`] = payload;
      }
    } catch { /* non-fatal — no ML rows if fetch/parse blows up */ }
    return out;
  };

  // Emit both ML sides for every game in a sport's context that has a matching 2-way market.
  const _emit2WayMl = (ctxMap, sport, stat, marketMap, { dateFallback = false, lineupsConfirmed = false } = {}) => {
    for (const ctx of Object.values(ctxMap)) {
      const { homeTeam, awayTeam, gameDate, kalshiVolume, kalshiSpread, lowVolume } = ctx;
      if (gameDate && gameDate < cutoffStr) continue;
      const mlMarket = marketMap[`${homeTeam}|${awayTeam}|${gameDate}`]
        ?? (dateFallback && gameDate == null ? (marketMap[`${homeTeam}|${awayTeam}|${_todayPT}`] ?? marketMap[`${awayTeam}|${homeTeam}|${_todayPT}`]) : null);
      if (!mlMarket?.yesByTeam) continue;
      const homeYesAsk = mlMarket.yesByTeam[homeTeam];
      const awayYesAsk = mlMarket.yesByTeam[awayTeam];
      if (homeYesAsk == null || awayYesAsk == null) continue;
      const _gameTime = _gt(sport, homeTeam, awayTeam, gameDate);
      const _lc = lineupsConfirmed ? _mlbBothTeamsConfirmed(homeTeam, awayTeam, gameDate ?? _todayPT) : void 0;
      for (const side of ["home", "away"]) {
        const pickTeam = side === "home" ? homeTeam : awayTeam;
        const oppTeam = side === "home" ? awayTeam : homeTeam;
        const kalshiPct = parseFloat(((side === "home" ? homeYesAsk : awayYesAsk) * 100).toFixed(1));
        plays.push({
          gameType: "ml", sport, stat,
          homeTeam, awayTeam, pickTeam, oppTeam, side, gameDate,
          kalshiPct, americanOdds: _toAO(kalshiPct), ..._MF,
          kalshiVolume, kalshiSpread, lowVolume,
          gameTime: _gameTime, ...(lineupsConfirmed ? { lineupsConfirmed: _lc } : {}),
          kalshiTicker: mlMarket.tickerByTeam?.[pickTeam] ?? null, kalshiSide: "yes",
          modelVersion: `${sport}-modelfree-v1`,
        });
      }
    }
  };

  // Emit both spread sides (YES = margin side covers -line, NO = other team covers +line) for every
  // spreadMarket of `sport`+`segment` whose game is in context. Prices come from the market itself.
  const _emitSpreads = (ctxMap, sport, statName, segment, { lineupsConfirmed = false, mlbNullFallback = false } = {}) => {
    for (const m of spreadMarkets) {
      if (m.sport !== sport) continue;
      const _seg = m.segment || "full";
      if (_seg !== segment) continue;
      if (m.gameDate && m.gameDate < cutoffStr) continue;
      const { gameTeam1, gameTeam2, gameDate, marginTeam, line, kalshiPct: yesKalshi, americanOdds: yesAO, noKalshiPct: noKalshi, noKalshiAO: noAO, kalshiVolume, kalshiSpread } = m;
      let ctx = ctxMap[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? ctxMap[`${gameTeam2}|${gameTeam1}|${gameDate}`];
      if (!ctx && mlbNullFallback) ctx = ctxMap[`${gameTeam1}|${gameTeam2}|null`] ?? ctxMap[`${gameTeam2}|${gameTeam1}|null`];
      if (!ctx) continue;
      const { homeTeam, awayTeam } = ctx;
      if (marginTeam !== homeTeam && marginTeam !== awayTeam) continue;
      const _gameTime = _gt(sport, homeTeam, awayTeam, gameDate);
      const _lc = lineupsConfirmed ? _mlbBothTeamsConfirmed(homeTeam, awayTeam, ctx.gameDate ?? _todayPT) : void 0;
      for (const dir of ["yes", "no"]) {
        const pickTeam = dir === "yes" ? marginTeam : (marginTeam === homeTeam ? awayTeam : homeTeam);
        const oppTeam = dir === "yes" ? (marginTeam === homeTeam ? awayTeam : homeTeam) : marginTeam;
        const pickSide = pickTeam === homeTeam ? "home" : "away";
        const kalshiPct = dir === "yes" ? yesKalshi : noKalshi;
        if (kalshiPct == null) continue; // only emit a side with a real ask
        plays.push({
          gameType: "spread", sport, stat: statName, ...(segment !== "full" ? { segment } : {}),
          homeTeam, awayTeam, pickTeam, oppTeam, side: pickSide, gameDate,
          line, pickLine: dir === "yes" ? -line : line, marginTeam,
          kalshiPct, americanOdds: dir === "yes" ? yesAO : noAO, ..._MF,
          kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
          gameTime: _gameTime, ...(lineupsConfirmed ? { lineupsConfirmed: _lc } : {}),
          kalshiTicker: m._ticker ?? null, kalshiSide: dir,
          modelVersion: `${sport}-modelfree-v1`,
        });
      }
    }
  };

  // Emit both total sides (over = YES, under = real NO ask) for every segment total of
  // `sport`+`segment` whose game is in context.
  const _emitSegmentTotals = (ctxMap, sport, statName, segment, { lineupsConfirmed = false, mlbNullFallback = false } = {}) => {
    for (const tm of totalMarkets) {
      if (tm.sport !== sport || tm.segment !== segment) continue;
      if (tm.gameDate && tm.gameDate < cutoffStr) continue;
      const { threshold, kalshiPct, americanOdds, noKalshiPct, noKalshiAO, gameTeam1, gameTeam2, gameDate, kalshiSpread, kalshiVolume } = tm;
      let ctx = ctxMap[`${gameTeam1}|${gameTeam2}|${gameDate}`] ?? ctxMap[`${gameTeam2}|${gameTeam1}|${gameDate}`];
      if (!ctx && mlbNullFallback) ctx = ctxMap[`${gameTeam1}|${gameTeam2}|null`] ?? ctxMap[`${gameTeam2}|${gameTeam1}|null`];
      if (!ctx) continue;
      const { homeTeam, awayTeam } = ctx;
      const _gameTime = _gt(sport, homeTeam, awayTeam, gameDate);
      const _lc = lineupsConfirmed ? _mlbBothTeamsConfirmed(homeTeam, awayTeam, ctx.gameDate ?? _todayPT) : void 0;
      const _base = {
        gameType: "total", sport, stat: statName, segment,
        homeTeam, awayTeam, gameDate, threshold, ..._MF,
        kalshiVolume, kalshiSpread, lowVolume: ctx.lowVolume,
        gameTime: _gameTime, ...(lineupsConfirmed ? { lineupsConfirmed: _lc } : {}),
        kalshiTicker: tm._ticker ?? null,
        modelVersion: `${sport}-modelfree-v1`,
      };
      plays.push({ ..._base, direction: "over", kalshiPct, americanOdds, kalshiSide: "yes" });
      if (noKalshiPct != null) plays.push({ ..._base, direction: "under", kalshiPct, noKalshiPct, americanOdds: noKalshiAO ?? null, kalshiSide: "no" });
    }
  };

  // ── MLB full-game ML + spread ──────────────────────────────────────────────────────────
  const _mlbMlMarkets = await _build2WayMl("KXMLBGAME", "mlb", { reattr: true });
  _emit2WayMl(_mlbMlContext, "mlb", "ml", _mlbMlMarkets, { dateFallback: true, lineupsConfirmed: true });
  _emitSpreads(_mlbMlContext, "mlb", "spread", "full", { lineupsConfirmed: true, mlbNullFallback: true });

  // ── MLB segments: F5 totals + F5 spreads + F3/F5/F7 3-way winners ─────────────────────────
  _emitSegmentTotals(_mlbMlContext, "mlb", "f5total", "f5", { lineupsConfirmed: true, mlbNullFallback: true });
  _emitSpreads(_mlbMlContext, "mlb", "f5spread", "f5", { lineupsConfirmed: true, mlbNullFallback: true });
  for (const [segment, seriesTicker, statName] of [
    ["f3", "KXMLBF3", "f3ml"], ["f5", "KXMLBF5", "f5ml"], ["f7", "KXMLBF7", "f7ml"],
  ]) {
    const mkt = await _build3WayWinner(seriesTicker, "mlb", { reattr: true });
    _emit3WayWinner(_mlbMlContext, "mlb", statName, segment, mkt, (homeTeam, awayTeam, gameDate) => `${homeTeam}|${awayTeam}|${gameDate}`, { dateFallback: true, lineupsConfirmed: true });
  }

  // ── NBA full-game ML + spread ──────────────────────────────────────────────────────────
  const _nbaMlMarkets = await _build2WayMl("KXNBAGAME", "nba");
  _emit2WayMl(_nbaMlContext, "nba", "ml", _nbaMlMarkets, { dateFallback: true });
  _emitSpreads(_nbaMlContext, "nba", "spread", "full");

  // ── WNBA full-game ML + spread ─────────────────────────────────────────────────────────
  const _wnbaMlMarkets = await _build2WayMl("KXWNBAGAME", "wnba");
  _emit2WayMl(_wnbaMlContext, "wnba", "ml", _wnbaMlMarkets, { dateFallback: true });
  _emitSpreads(_wnbaMlContext, "wnba", "spread", "full");

  // ── NBA + WNBA halves (1h/2h × total / spread / ml) ─────────────────────────────────────
  const _halfWinner = {}; // keyed `${sport}|${t1}|${t2}|${date}|${half}`
  for (const [_sportH, _halfH, _seriesH] of [
    ["nba", "1h", "KXNBA1HWINNER"], ["nba", "2h", "KXNBA2HWINNER"],
    ["wnba", "1h", "KXWNBA1HWINNER"], ["wnba", "2h", "KXWNBA2HWINNER"],
  ]) {
    Object.assign(_halfWinner, await _build3WayWinner(_seriesH, _sportH, { keyPrefix: `${_sportH}|`, keySuffix: `|${_halfH}` }));
  }
  for (const _segH of ["1h", "2h"]) {
    for (const [_sportH, _ctxMap] of [["nba", _nbaMlContext], ["wnba", _wnbaMlContext]]) {
      _emitSegmentTotals(_ctxMap, _sportH, _segH === "1h" ? "h1total" : "h2total", _segH);
      _emitSpreads(_ctxMap, _sportH, _segH === "1h" ? "h1spread" : "h2spread", _segH);
      _emit3WayWinner(_ctxMap, _sportH, _segH === "1h" ? "h1ml" : "h2ml", _segH, _halfWinner, (homeTeam, awayTeam, gameDate) => `${_sportH}|${homeTeam}|${awayTeam}|${gameDate}|${_segH}`);
    }
  }

  // ── WNBA quarters (1q–4q × total / spread / ml) ─────────────────────────────────────────
  const _qtrWinner = {}; // keyed `wnba|${t1}|${t2}|${date}|${seg}`
  for (const [_segQ, _seriesQ] of [
    ["1q", "KXWNBA1QWINNER"], ["2q", "KXWNBA2QWINNER"], ["3q", "KXWNBA3QWINNER"], ["4q", "KXWNBA4QWINNER"],
  ]) {
    Object.assign(_qtrWinner, await _build3WayWinner(_seriesQ, "wnba", { keyPrefix: "wnba|", keySuffix: `|${_segQ}` }));
  }
  for (const _segQ of ["1q", "2q", "3q", "4q"]) {
    const _qn = _segQ[0];
    _emitSegmentTotals(_wnbaMlContext, "wnba", `q${_qn}total`, _segQ);
    _emitSpreads(_wnbaMlContext, "wnba", `q${_qn}spread`, _segQ);
    _emit3WayWinner(_wnbaMlContext, "wnba", `q${_qn}ml`, _segQ, _qtrWinner, (homeTeam, awayTeam, gameDate) => `wnba|${homeTeam}|${awayTeam}|${gameDate}|${_segQ}`);
  }

  // ── NHL full-game ML + spread ──────────────────────────────────────────────────────────
  const _nhlMlMarkets = await _build2WayMl("KXNHLGAME", "nhl");
  _emit2WayMl(_nhlMlContext, "nhl", "ml", _nhlMlMarkets);
  _emitSpreads(_nhlMlContext, "nhl", "spread", "full");

  // ── NFL full-game ML (KXNFLGAME, adopted 2026-08-10) ───────────────────────────────────
  // No _emitSpreads: Kalshi lists no KXNFLSPREAD series, so there is nothing to point it at.
  // Home/away comes from _nflMlContext, which game-totals.js populates off KXNFLTOTAL — so ML
  // coverage is bounded by the games carrying a full-game total, the same coupling every other
  // sport here has.
  const _nflMlMarkets = await _build2WayMl("KXNFLGAME", "nfl");
  _emit2WayMl(_nflMlContext, "nfl", "ml", _nflMlMarkets);

  // ── NFL 1st-quarter winner (KXNFL1Q, 3-way: home/away/tie, adopted 2026-08-21) ─────────
  // Same _build3WayWinner/_emit3WayWinner machinery as MLB's F3/F5/F7 and WNBA's half/quarter
  // winners — already handles a "TIE" ticker suffix generically. Reuses _nflMlContext (same
  // ticker-derived home/away as the full-game ML above), so coverage is bounded to games that
  // also carry a KXNFLTOTAL, the same coupling the full-game ML already has.
  const _nfl1qWinner = await _build3WayWinner("KXNFL1Q", "nfl");
  _emit3WayWinner(_nflMlContext, "nfl", "1qml", "1q", _nfl1qWinner,
    (homeTeam, awayTeam, gameDate) => `${homeTeam}|${awayTeam}|${gameDate}`);

  void dropped; void isDebug; // model-free capture routes every row to `plays`.

  // ── 3-way winner helpers (home/away/tie). Defined here (hoisted) so the sport blocks above
  // read top-to-bottom; each 3-way market must have all three legs pass `_kMlLegProb`. ────────
  async function _build3WayWinner(seriesTicker, sport, { reattr = false, keyPrefix = "", keySuffix = "" } = {}) {
    const out = {};
    try {
      const raw = await _fetchSeries(seriesTicker);
      const byEvent = {};
      for (const m of raw) {
        const tk = m.ticker || '';
        const lastDash = tk.lastIndexOf('-');
        if (lastDash < 0) continue;
        const sfx = tk.slice(lastDash + 1);
        const key = sfx === "TIE" ? "TIE" : normTeam(sport, sfx);
        const eventT = m.event_ticker;
        if (!eventT || !key) continue;
        const p = _kMlLegProb(m);
        if (!p || p <= 0 || p >= 1) continue;
        if (!byEvent[eventT]) byEvent[eventT] = { probs: {}, tickers: {}, gameDate: _kGameDate(m) };
        byEvent[eventT].probs[key] = p;
        byEvent[eventT].tickers[key] = tk;
      }
      for (const info of Object.values(byEvent)) {
        const keys = Object.keys(info.probs);
        if (keys.length !== 3 || !info.gameDate || !keys.includes("TIE")) continue;
        const [t1, t2] = keys.filter(k => k !== "TIE");
        let date = info.gameDate;
        if (reattr) {
          const resolved = Math.min(...keys.map(k => info.probs[k])) <= 0.02 || Math.max(...keys.map(k => info.probs[k])) >= 0.99;
          date = _reattrMlbGameDate(info.gameDate, t1, t2, resolved);
        }
        const payload = { probs: { ...info.probs }, tickersByKey: { ...info.tickers } };
        out[`${keyPrefix}${t1}|${t2}|${date}${keySuffix}`] = payload;
        out[`${keyPrefix}${t2}|${t1}|${date}${keySuffix}`] = payload;
      }
    } catch { /* non-fatal */ }
    return out;
  }

  function _emit3WayWinner(ctxMap, sport, stat, segment, marketMap, keyOf, { dateFallback = false, lineupsConfirmed = false } = {}) {
    for (const ctx of Object.values(ctxMap)) {
      const { homeTeam, awayTeam, gameDate, kalshiVolume, kalshiSpread, lowVolume } = ctx;
      if (gameDate && gameDate < cutoffStr) continue;
      const wMarket = marketMap[keyOf(homeTeam, awayTeam, gameDate)]
        ?? (dateFallback && gameDate == null ? (marketMap[keyOf(homeTeam, awayTeam, _todayPT)] ?? marketMap[keyOf(awayTeam, homeTeam, _todayPT)]) : null);
      if (!wMarket?.probs) continue;
      const homeYes = wMarket.probs[homeTeam], awayYes = wMarket.probs[awayTeam], tieYes = wMarket.probs["TIE"];
      if (homeYes == null || awayYes == null || tieYes == null) continue;
      const _gameTime = _gt(sport, homeTeam, awayTeam, gameDate);
      const _lc = lineupsConfirmed ? _mlbBothTeamsConfirmed(homeTeam, awayTeam, gameDate ?? _todayPT) : void 0;
      const _sides = [
        { side: "home", pickTeam: homeTeam, oppTeam: awayTeam, yesAsk: homeYes },
        { side: "away", pickTeam: awayTeam, oppTeam: homeTeam, yesAsk: awayYes },
        { side: "tie", pickTeam: "TIE", oppTeam: null, yesAsk: tieYes },
      ];
      for (const s of _sides) {
        const kalshiPct = parseFloat((s.yesAsk * 100).toFixed(1));
        plays.push({
          gameType: "ml", sport, stat, segment,
          homeTeam, awayTeam, pickTeam: s.pickTeam, oppTeam: s.oppTeam, side: s.side, gameDate,
          kalshiPct, americanOdds: _toAO(kalshiPct), ..._MF,
          kalshiVolume, kalshiSpread, lowVolume,
          gameTime: _gameTime, ...(lineupsConfirmed ? { lineupsConfirmed: _lc } : {}),
          kalshiTicker: wMarket.tickersByKey?.[s.pickTeam] ?? null, kalshiSide: "yes",
          modelVersion: `${sport}-modelfree-v1`,
        });
      }
    }
  }
}
