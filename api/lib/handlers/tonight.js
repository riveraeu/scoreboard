// api/lib/handlers/tonight.js
// Extracted from api/[...path].js during Phase A (2026-05-26). Zero behavior change —
// imports + helpers needed only by the tonight pipeline moved with the block. The
// outer indentation level (8 spaces) is preserved from the original nesting; future
// phases will reformat.
import { jsonResponse, parseGameScores } from "../utils.js";
import { buildMlbByteam } from "../mlb.js";
import { MLB_ID_TO_ABBR } from "../teams.js";
import { buildNbaByteam } from "../nba.js";
import { buildWnbaByteam } from "../wnba.js";
import { SERIES_CONFIG } from "../series-config.js";
import { PT_FMT } from "../pt.js";
import { computeDataConfidence } from "../tonight/dc.js";
import { fetchKalshiMarkets } from "../tonight/kalshi-pipeline.js";
import { blendMarketPrice } from "../tonight/blend-fill.js";
import { CAPTURE_GATE, CAPTURE_CAP, capturableSpread } from "../config.js";
import { TEAM_NORM, normTeam, parseGameTeams } from "../tonight/parse-teams.js";
import { emitAllMlAndSpread } from "../tonight/ml-spread.js";
import { emitGameTotalPlays } from "../tonight/game-totals.js";
import { emitPropPlays } from "../tonight/props.js";
import { emitTennisMatchPlays } from "../tonight/tennis-match.js";
import { emitFightPlays } from "../tonight/fight.js";
import { emitNascarPlays } from "../tonight/nascar.js";
import { emitLmbPlays } from "../tonight/lmb-ml.js";
import { emitModelFreeMlPlays } from "../tonight/model-free-ml.js";
import { MODEL_FREE_LEAGUE_KEYS } from "../model-free-leagues.js";
import { emitClubSoccerThresholdPlays } from "../tonight/club-soccer-threshold.js";
import { emitScoCupPlays } from "../tonight/scocup.js";
import { emitGolfModelFreePlays } from "../tonight/golf-modelfree.js";
import { emitDota2ModelFreePlays } from "../tonight/dota2-modelfree.js";
import { emitTickerMlModelFreePlays } from "../tonight/ticker-ml-modelfree.js";
import { emitFightMlModelFreePlays } from "../tonight/fight-ml-modelfree.js";
import { kalshiTickerDate, kalshiTickerGameTime } from "../kalshi-ticker.js";
import { emitMlbOutsPlays } from "../tonight/mlb-outs.js";
import { fetchPolymarketGames } from "../polymarket.js";
import { emitPolymarketDeltas } from "../tonight/polymarket-deltas.js";
import { enrichDeltasWithExec } from "../polymarket-book.js";
import { fetchSportsbookGames } from "../sportsbook.js";
import { emitSportsbookDeltas } from "../tonight/sportsbook-deltas.js";

const __defProp = Object.defineProperty;
const __name = (target, value) => __defProp(target, "name", { value, configurable: true });
// Production sport set (sports with active play generation + matchup cards). NFL is
// supported in code but not currently in any active Kalshi market lookup paths.
const PROD_SPORTS = new Set(["mlb", "nba", "nhl", "wnba"]);
// B2B_*, _isB2B, and injury helpers moved to api/lib/tonight/game-totals.js (Phase B5, 2026-05-29).
const normName = /* @__PURE__ */ __name((s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(), "normName");
const ESPN_BASE = "https://site.web.api.espn.com/apis";

// ── Module-level pure helpers ─────────────────────────────────────────────────────────────────
// Hoisted from handleTonightRoute body (Phase B, 2026-05-29). No closure deps — safe at module
// scope. These replace the old inline `let x = function...` chain.


// nhlSoftTeams / mlbSoftTeams (soft-matchup rank maps) + glCacheKey (gamelog cache key) were
// model-only helpers — deleted with the model teardown (2026-08-04, slice 4).

// (_parseWind / _extractMlbWeather + the weatherByGame map they fed were deleted 2026-08-04 —
// they only populated the now-removed mlbMeta.weather. The game-total team-total weather stamp
// uses sportByteam.mlb.weatherByTeam from buildBallparkWeather, which is untouched.)

export async function handleTonightRoute({ path, params, request, env, CACHE2 }) {
  if (path !== "tonight") return null;
        const isDebugMode = params.get("debug") === "1";
        // FD/socket pressure probe (EMFILE/EBUSY hunt 2026-07-05): snapshot open-FD count and
        // active libuv resource types at run start + response time. Debug-only, failure-closed.
        const _fdProbe = async () => {
          const out = {};
          try {
            const fs = await import("node:fs");
            const names = fs.readdirSync("/proc/self/fd");
            out.fds = names.length;
            // Classify each fd by its readlink target: socket:/pipe:/anon_inode:<type>/file path.
            const byKind = {};
            for (const n of names) {
              let kind = "?";
              try {
                const t = fs.readlinkSync(`/proc/self/fd/${n}`);
                kind = t.startsWith("socket:") ? "socket"
                  : t.startsWith("pipe:") ? "pipe"
                  : t.startsWith("anon_inode:") ? t.slice(0, 24)
                  : t.slice(0, 24);
              } catch { /* raced a close */ }
              byKind[kind] = (byKind[kind] || 0) + 1;
            }
            out.byKind = Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 8));
          } catch (e) { out.fds = null; out.fdErr = String(e?.code || e?.message || e).slice(0, 60); }
          try {
            const res = typeof process?.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
            const byType = {};
            for (const t of res) byType[t] = (byType[t] || 0) + 1;
            out.resources = byType;
          } catch { out.resources = null; }
          return out;
        };
        const _fdMilestones = [];
        const _fdMark = async (label) => { if (isDebugMode) { try { _fdMilestones.push({ label, ...(await _fdProbe()) }); } catch { /* probe never breaks the run */ } } };
        await _fdMark("start");
        const isBustCache = params.get("bust") === "1";
        const reportSportFilter = params.get("sport") || null;
        // SERIES_CONFIG imported from api/lib/series-config.js; TEAM_NORM / normTeam / weather
        // helpers / injury helpers — module-level (Phase B, 2026-05-29).
        const seriesTickers = Object.keys(SERIES_CONFIG);
        // 3-tier Kalshi read chain (snap → bundle → REST + stale). See lib/tonight/kalshi-pipeline.js.
        const { kalshiResults, staleKalshiSeries, kalshiSnapMeta, kalshiUsedSnaps } =
          await fetchKalshiMarkets({ seriesTickers, cache: CACHE2, env, isBustCache });
        await _fdMark("afterKalshi");
        const _staleKalshiSet = new Set(staleKalshiSeries);
        const _findKalshiTicker = (sport, stat, gameType) => {
          for (const [ticker, cfg] of Object.entries(SERIES_CONFIG)) {
            if (cfg.sport === sport && cfg.stat === stat && (cfg.gameType || null) === (gameType || null)) return ticker;
          }
          return null;
        };
        const qualifyingMarkets = [];
        const totalMarkets = []; // game total markets (pct 70–97); under plays computed from same markets
        const teamTotalMarkets = []; // single-team score markets (KXMLBTEAMTOTAL, KXNBATEAMTOTAL)
        const spreadMarkets = []; // MLB run-line / spread markets (KXMLBSPREAD) — line = strike, marginTeam = win-by side
        const tennisMatchMarkets = []; // ATP/WTA match-winner — every priced side (favorite + dog), grouped by event in emit
        const fightMarkets = []; // UFC rounds O/U — every priced threshold, grouped by event in emit
        const nascarMarkets = []; // NASCAR Cup H2H + Top-10 — each priced side carries its own driver(s)
        const lmbMarkets = []; // LMB (Mexican League) game winner — each priced side carries its own pick + opponent
        const golfH2hMarkets = []; // PGA H2H (KXPGAH2H) — one object per market; emit handles YES + NO sides
        // Model-free soccer game winners, keyed by league (was six separate hand-declared arrays).
        // Each priced side (home/away/tie) lands in its league's bucket and is grouped by event in
        // the emit path; the buckets stay separate because each league resolves gameTime/results
        // off a different ESPN league endpoint.
        const modelFreeMarkets = {};
        const clubSoccerThresholdMarkets = []; // MLS/Liga MX/Argentina spread/total/BTTS + team-total (model-free, threshold shape) — one shared array, sport-tagged per row
        const scocupSpreadMarkets = []; // Scottish League Cup spread (model-free, threshold shape) — each priced threshold carries its team's subtitle name
        const scocupTotalMarkets = []; // Scottish League Cup total (model-free, threshold shape) — no team identity, joined to spread siblings by event segment
        const outsMarkets = []; // MLB pitcher outs-recorded O/U (KXMLBOUTS) — each priced threshold carries its pitcher
        const dota2Markets = []; // Dota 2 (KXDOTA2GAME) match-winner — one market per team per match
        const kleagueMarkets = []; // K League 1 (KXKLEAGUEGAME) match-winner — 3 markets per game (home/away/tie)
        const kboMarkets = [];     // KBO (KXKBOGAME) match-winner — 2 markets per game, ticker carries HHMM
        const fightMlMarkets = []; // UFC (KXUFCFIGHT) + Boxing (KXBOXING) match-winner — one YES market per fighter
        const globalSeen = /* @__PURE__ */ new Set();
        for (let i = 0; i < seriesTickers.length; i++) {
          const ticker = seriesTickers[i];
          const cfg = SERIES_CONFIG[ticker];
          const { sport, stat, col } = cfg;
          const segment = cfg.segment || "full"; // "f5" for segmented markets, "full" otherwise
          for (const m of kalshiResults[i].markets || []) {
            // ── Tennis match-winner branch ── binary markets have no floor_strike, so handle
            // before strike parsing. Collect EVERY priced side (favorite + underdog) keyed by
            // event_ticker; emitTennisMatchPlays groups them so each side knows its opponent and
            // emits only the favorite (Kalshi in [67,91]). Not team-based → skips parseGameTeams.
            if (cfg.gameType === "tennisMatch") {
              const _tYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _tLast = parseFloat(m.last_price_dollars) || 0;
              const _tYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _tPrice = (_tYesAsk >= 0.98 && _tYesBid === 0 && _tLast > 0) ? _tLast : (_tYesAsk > 0 ? _tYesAsk : _tLast);
              if (_tPrice === 0) continue; // no live book — skip (tennis books fill near match time; sparse is expected)
              const _tPct = Math.round(_tPrice * 100);
              const _tVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _tTitle = m.title || m.event_title || "";
              // Pick player full name: yes_sub_title is exact; fall back to the title's subject.
              let _tPick = (m.yes_sub_title || "").trim();
              if (!_tPick) { const _mm = _tTitle.match(/^Will\s+(.+?)\s+win the\b/i); if (_mm) _tPick = _mm[1].trim(); }
              if (!_tPick) continue;
              // Opponent last name + matchup label from "... win the <A> vs <B>: <round> match?".
              let _tOpp = null, _tMatchup = null;
              const _mvs = _tTitle.match(/win the\s+(.+?)\s+vs\s+([^:]+?)\s*:/i);
              if (_mvs) {
                const _a = _mvs[1].trim(), _b = _mvs[2].trim();
                _tMatchup = `${_a} vs ${_b}`;
                _tOpp = _tPick.toLowerCase().includes(_a.toLowerCase()) ? _b : _a;
              }
              // gameDate from event_ticker date segment (e.g. KXATPMATCH-26JUN14HIJGIR → 2026-06-14).
              const _tDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _tGameDate = null;
              if (_tDateSeg.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _tMo = _KMONT[_tDateSeg.slice(2, 5).toUpperCase()];
                if (_tMo) _tGameDate = `20${_tDateSeg.slice(0, 2)}-${_tMo}-${_tDateSeg.slice(5, 7)}`;
              }
              const _tAO = _tPct >= 50 ? Math.round(-(_tPct / (100 - _tPct)) * 100) : Math.round((100 - _tPct) / _tPct * 100);
              tennisMatchMarkets.push({ gameType: "tennisMatch", sport, tour: cfg.tour, eventTicker: m.event_ticker, player: _tPick, opponentRaw: _tOpp, matchup: _tMatchup, kalshiPct: _tPct, americanOdds: _tAO, kalshiVolume: _tVol, gameDate: _tGameDate, _ticker: m.ticker, _yesAsk: _tYesAsk, _depth: m._depth });
              continue;
            }
            // ── Golf PGA H2H branch ── binary "A beats B in the Nth Round" markets (KXPGAH2H).
            // Player names parsed from yes_sub_title (no team registry — players are arbitrary
            // strings). gameDate from close_time (the round date). capturableSpread gates on the
            // tighter of the two side spreads; the emit module then checks each side's price
            // independently against CAPTURE_GATE/CAPTURE_CAP. One object per market (emit handles
            // YES + NO). Rows go into golfH2hMarkets → emitGolfModelFreePlays → shadow:staging.
            if (cfg.gameType === "golfH2h") {
              const _gYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _gNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _gLast = parseFloat(m.last_price_dollars) || 0;
              const _gYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _gNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _gStale = _gYesAsk >= 0.98 && _gYesBid === 0 && _gLast > 0;
              const _gYesPrice = _gStale ? _gLast : _gYesAsk;
              if (_gYesPrice === 0 && _gNoAsk === 0) continue; // no book on either side
              const _gYesSpreadC = _gYesAsk > 0 ? Math.round((_gYesAsk - _gYesBid) * 100) : 999;
              const _gNoSpreadC = _gNoAsk > 0 ? Math.round((_gNoAsk - _gNoBid) * 100) : 999;
              if (!_gStale && !capturableSpread(Math.min(_gYesSpreadC, _gNoSpreadC))) continue;
              const _gYesPct = _gYesPrice > 0 ? Math.round(_gYesPrice * 100) : 0;
              const _gNoPct = _gNoAsk > 0 ? Math.round(_gNoAsk * 100) : 0;
              const _gVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              // "Scottie Scheffler beats Wyndham Clark in the 4th Round"
              const _gSub = m.yes_sub_title || m.subtitle || "";
              const _gNameMatch = _gSub.match(/^(.+?)\s+beats\s+(.+?)\s+in\s+the\s+\d/i);
              if (!_gNameMatch) continue; // unparseable subtitle — skip
              const _gGameDate = m.close_time ? m.close_time.slice(0, 10) : null;
              golfH2hMarkets.push({
                eventTicker: m.event_ticker,
                player: _gNameMatch[1].trim(), opponent: _gNameMatch[2].trim(),
                yesPct: _gYesPct, noPct: _gNoPct,
                kalshiVolume: _gVol, gameDate: _gGameDate, _ticker: m.ticker,
              });
              continue;
            }
            // ── Dota 2 match-winner (KXDOTA2GAME) branch ── one YES market per team per match.
            // teamCode from ticker suffix (last `-` segment); gameDate/gameTime from ticker date
            // segment (YYMONDDHHMMM, ET→UTC, same format as MLB props). YES-side only — Kalshi
            // lists one market per team, so both teams are covered by their own YES market.
            if (cfg.gameType === "dota2Game") {
              const _d2YesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _d2NoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _d2YesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _d2NoBid = parseFloat(m.no_bid_dollars) || 0;
              if (_d2YesAsk === 0 && _d2NoAsk === 0) continue;
              const _d2YesSpreadC = _d2YesAsk > 0 ? Math.round((_d2YesAsk - _d2YesBid) * 100) : 999;
              const _d2NoSpreadC = _d2NoAsk > 0 ? Math.round((_d2NoAsk - _d2NoBid) * 100) : 999;
              if (!capturableSpread(Math.min(_d2YesSpreadC, _d2NoSpreadC))) continue;
              const _d2TeamCode = (m.ticker || "").split("-").pop();
              if (!_d2TeamCode) continue;
              dota2Markets.push({
                eventTicker: m.event_ticker, teamCode: _d2TeamCode,
                gameDate: kalshiTickerDate(m.ticker), gameTime: kalshiTickerGameTime(m.ticker),
                yesPct: Math.round(_d2YesAsk * 100), noPct: Math.round(_d2NoAsk * 100),
                kalshiVolume: parseInt(m.volume_fp) || parseInt(m.volume) || 0, _ticker: m.ticker,
              });
              continue;
            }
            // ── K League 1 match-winner (KXKLEAGUEGAME) branch ── 3-way binary markets
            // (homeTeam / awayTeam / TIE). homeTeam/awayTeam from the 6-char team segment
            // after YYMONDD; side from ticker suffix. gameDate from kalshiTickerDate,
            // gameTime=null (occurrence_datetime is post-game expiration, not kickoff).
            // Ticker-parsed model-free ML (K League, KBO) — no ESPN feed; identity, date and (where
            // the ticker carries HHMM) kickoff all come from the ticker. One branch for both since
            // they differ only by cfg.sport; emit goes through the shared
            // tonight/ticker-ml-modelfree.js. gameTime is real for kbo (ticker has HHMM) and null
            // for kleague (date-only) — kalshiTickerGameTime returns null on its own for the latter,
            // so no per-sport special case is needed here.
            if (cfg.gameType === "tickerMl") {
              const _tmYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _tmNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _tmYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _tmNoBid = parseFloat(m.no_bid_dollars) || 0;
              if (_tmYesAsk === 0 && _tmNoAsk === 0) continue;
              const _tmYesSpreadC = _tmYesAsk > 0 ? Math.round((_tmYesAsk - _tmYesBid) * 100) : 999;
              const _tmNoSpreadC = _tmNoAsk > 0 ? Math.round((_tmNoAsk - _tmNoBid) * 100) : 999;
              if (!capturableSpread(Math.min(_tmYesSpreadC, _tmNoSpreadC))) continue;
              const [_tmHome, _tmAway] = parseGameTeams(m.event_ticker, cfg.sport);
              if (!_tmHome || !_tmAway) continue;
              const _tmSide = (m.ticker || "").split("-").pop();
              if (!_tmSide) continue;
              (cfg.sport === "kbo" ? kboMarkets : kleagueMarkets).push({
                eventTicker: m.event_ticker, homeTeam: _tmHome, awayTeam: _tmAway, side: _tmSide,
                gameDate: kalshiTickerDate(m.ticker), gameTime: kalshiTickerGameTime(m.ticker),
                yesPct: Math.round(_tmYesAsk * 100), noPct: Math.round(_tmNoAsk * 100),
                kalshiVolume: parseInt(m.volume_fp) || parseInt(m.volume) || 0, _ticker: m.ticker,
              });
              continue;
            }
            // ── Fighting (UFC rounds O/U) branch ── binary "ends before round N" markets, grouped
            // by event_ticker. The threshold N is the ticker suffix (-2..-5); the event segment
            // encodes date + a fighter-code segment (last-name-based, e.g. 26JUN20COLTAN). Collect
            // every priced threshold; emitFightPlays matches codes→ESPN weight class and projects
            // the fight-duration CDF off it.
            if (cfg.gameType === "fight") {
              const _fN = parseInt((m.ticker || "").split("-").pop());
              if (!(_fN >= 2)) continue; // not a round threshold
              const _fYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _fNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _fLast = parseFloat(m.last_price_dollars) || 0;
              const _fYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _fPrice = (_fYesAsk >= 0.98 && _fYesBid === 0 && _fLast > 0) ? _fLast : (_fYesAsk > 0 ? _fYesAsk : _fLast);
              if (_fPrice === 0) continue; // no live book — skip (books fill near the event)
              const _fYesPct = Math.round(_fPrice * 100);
              const _fNoPct = _fNoAsk > 0 ? Math.round(_fNoAsk * 100) : (100 - _fYesPct);
              const _fVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _fSeg = (m.event_ticker || "").split("-")[1] || "";
              const _fDateSeg = _fSeg.slice(0, 7);
              let _fGameDate = null;
              if (_fDateSeg.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _fMo = _KMONT[_fDateSeg.slice(2, 5).toUpperCase()];
                if (_fMo) _fGameDate = `20${_fDateSeg.slice(0, 2)}-${_fMo}-${_fDateSeg.slice(5, 7)}`;
              }
              const _fCodeSeg = _fSeg.slice(7); // fighter codes (last-name based, usually 3+3)
              if (!_fCodeSeg) continue;
              const _fAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              fightMarkets.push({ eventTicker: m.event_ticker, codeSegment: _fCodeSeg, gameDate: _fGameDate, threshold: _fN, yesPct: _fYesPct, noPct: _fNoPct, yesAO: _fAO(_fYesPct), noAO: _fAO(_fNoPct), kalshiVolume: _fVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── UFC/Boxing match-winner (KXUFCFIGHT + KXBOXING) branch ── one YES market per fighter.
            // fighterCode from ticker suffix (last `-` segment); gameDate/gameTime from close_time
            // (per-bout fight start time — the YYMONDD ticker date is unrelated to the fight date).
            // YES-side only (Dota2 pattern): both directions covered by each fighter's own YES market.
            if (cfg.gameType === "fightMl") {
              const _fmYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _fmNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _fmYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _fmNoBid = parseFloat(m.no_bid_dollars) || 0;
              if (_fmYesAsk === 0 && _fmNoAsk === 0) continue;
              const _fmYesSpreadC = _fmYesAsk > 0 ? Math.round((_fmYesAsk - _fmYesBid) * 100) : 999;
              const _fmNoSpreadC = _fmNoAsk > 0 ? Math.round((_fmNoAsk - _fmNoBid) * 100) : 999;
              if (!capturableSpread(Math.min(_fmYesSpreadC, _fmNoSpreadC))) continue;
              const _fmFighterCode = (m.ticker || "").split("-").pop();
              if (!_fmFighterCode) continue;
              fightMlMarkets.push({
                sport: cfg.sport, eventTicker: m.event_ticker, fighterCode: _fmFighterCode,
                gameDate: (m.close_time || "").slice(0, 10) || null,
                gameTime: m.close_time || null,
                yesPct: Math.round(_fmYesAsk * 100), noPct: Math.round(_fmNoAsk * 100),
                kalshiVolume: parseInt(m.volume_fp) || parseInt(m.volume) || 0, _ticker: m.ticker,
              });
              continue;
            }
            // ── NASCAR (Cup head-to-head + Top-10) branch ── binary markets. H2H yes_sub_title =
            // "<A> beats <B>"; Top-10 yes_sub_title = "<driver>". The event segment is the race
            // code (H2H also appends the two driver codes); emitNascarPlays groups nothing — each
            // priced side is its own candidate (favorite side in [67,91]). gameDate from close_time
            // (the race start ≈ close; the resolver tolerates a ±1-day UTC roll on night races).
            if (cfg.gameType === "nascar") {
              const _nYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _nLast = parseFloat(m.last_price_dollars) || 0;
              const _nYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _nPrice = (_nYesAsk >= 0.98 && _nYesBid === 0 && _nLast > 0) ? _nLast : (_nYesAsk > 0 ? _nYesAsk : _nLast);
              if (_nPrice === 0) continue; // no live book — skip (books fill near the green flag)
              const _nPct = Math.round(_nPrice * 100);
              const _nVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _nDate = (m.close_time || "").slice(0, 10) || null;
              const _nRace = (m.event_ticker || "").split("-")[1] || "";
              const _nAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              let _nPlayer = null, _nOpp = null;
              if (cfg.subtype === "h2h") {
                const _nm = (m.yes_sub_title || "").match(/^(.+?)\s+beats\s+(.+?)\s*$/i);
                if (!_nm) continue;
                _nPlayer = _nm[1].trim(); _nOpp = _nm[2].trim();
              } else { // top10
                _nPlayer = (m.yes_sub_title || "").trim();
                if (!_nPlayer) continue;
              }
              nascarMarkets.push({ subtype: cfg.subtype, eventTicker: m.event_ticker, raceCode: _nRace, player: _nPlayer, opponent: _nOpp, gameDate: _nDate, kalshiPct: _nPct, americanOdds: _nAO(_nPct), kalshiVolume: _nVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── LMB (Mexican League) game-winner branch ── binary, two markets per event (one per
            // team). Event segment = date + game time + team abbrs (KXLMBGAME-26JUL152030DIATDQ) —
            // parseGameTeams strips the 4-digit time and does the validated 3+3 split against the
            // lmb registry; the ticker suffix is the pick team's Kalshi abbr. Liquidity-gated at
            // parse (same doctrine as game rows 2026-07-11): only game-day books are real — far-out
            // listings quote ~48¢ placeholder spreads on both sides.
            if (cfg.gameType === "lmbGame") {
              const _lmYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _lmNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _lmLast = parseFloat(m.last_price_dollars) || 0;
              const _lmYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _lmNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _lmStale = _lmYesAsk >= 0.98 && _lmYesBid === 0 && _lmLast > 0;
              const _lmPrice = _lmStale ? _lmLast : (_lmYesAsk > 0 ? _lmYesAsk : _lmLast);
              if (_lmPrice === 0) continue; // no live book — skip (books seed near game time)
              const _lmYesSpreadC = _lmYesAsk > 0 ? Math.round((_lmYesAsk - _lmYesBid) * 100) : 999;
              const _lmNoSpreadC = _lmNoAsk > 0 ? Math.round((_lmNoAsk - _lmNoBid) * 100) : 999;
              if (!_lmStale && !capturableSpread(Math.min(_lmYesSpreadC, _lmNoSpreadC))) continue;
              const _lmPct = Math.round(_lmPrice * 100);
              const _lmVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const [_lmT1, _lmT2] = parseGameTeams(m.event_ticker, "lmb");
              if (!_lmT1 || !_lmT2) continue;
              const _lmPick = normTeam("lmb", (m.ticker || "").split("-").pop() || "");
              if (_lmPick !== _lmT1 && _lmPick !== _lmT2) continue;
              const _lmDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _lmGameDate = null;
              if (_lmDateSeg.length >= 7) {
                const _KMONS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _lmMo = _KMONS[_lmDateSeg.slice(2, 5).toUpperCase()];
                if (_lmMo) _lmGameDate = `20${_lmDateSeg.slice(0, 2)}-${_lmMo}-${_lmDateSeg.slice(5, 7)}`;
              }
              const _lmAO = _lmPct >= 50 ? Math.round(-(_lmPct / (100 - _lmPct)) * 100) : Math.round((100 - _lmPct) / _lmPct * 100);
              lmbMarkets.push({ eventTicker: m.event_ticker, gameTeam1: _lmT1, gameTeam2: _lmT2, pickTeam: _lmPick, opponent: _lmPick === _lmT1 ? _lmT2 : _lmT1, gameDate: _lmGameDate, kalshiPct: _lmPct, americanOdds: _lmAO, kalshiVolume: _lmVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── MODEL-FREE SOCCER game-winner branch (3-way home/away/tie) ────────────────────
            // ONE branch for every league in MODEL_FREE_LEAGUES, replacing six copies of this
            // same ~35 lines that differed only in their local variable prefix and target array
            // (2026-07-28). Each league still needs its own bucket — the emit path resolves
            // gameTime/results off a DIFFERENT ESPN league endpoint per league — but the bucket
            // is now a key in `modelFreeMarkets`, not a separate hand-declared array.
            //
            // Event segment = date + team abbrs (KXMLSGAME-26JUL25SJLAG); `parseGameTeams` does
            // the validated variable-length split against that league's registry, which is what
            // handles the mixed 2-to-4-char abbrs (MLS NE/SD/SJ vs LAFC/NYRB, Brasileirão's CR).
            // Liquidity-gated at parse (same doctrine as game rows 2026-07-11): far-out listings
            // quote placeholder-wide spreads until books seed near kickoff.
            // `cfg.half` ("1h" or unset) tags which score the emit path resolves against.
            if (cfg.gameType === "modelFreeMl") {
              const _mfYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _mfNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _mfLast = parseFloat(m.last_price_dollars) || 0;
              const _mfYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _mfNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _mfStale = _mfYesAsk >= 0.98 && _mfYesBid === 0 && _mfLast > 0;
              const _mfPrice = _mfStale ? _mfLast : (_mfYesAsk > 0 ? _mfYesAsk : _mfLast);
              if (_mfPrice === 0) continue; // no live book — skip (books fill near kickoff)
              const _mfYesSpreadC = _mfYesAsk > 0 ? Math.round((_mfYesAsk - _mfYesBid) * 100) : 999;
              const _mfNoSpreadC = _mfNoAsk > 0 ? Math.round((_mfNoAsk - _mfNoBid) * 100) : 999;
              if (!_mfStale && !capturableSpread(Math.min(_mfYesSpreadC, _mfNoSpreadC))) continue;
              const _mfYesPct = Math.round(_mfPrice * 100);
              const _mfNoPct = _mfNoAsk > 0 ? Math.round(_mfNoAsk * 100) : (100 - _mfYesPct);
              const _mfVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const [_mfHome, _mfAway] = parseGameTeams(m.event_ticker, cfg.league);
              if (!_mfHome || !_mfAway) continue;
              const _mfSuffix = (m.ticker || "").split("-").pop();
              let _mfSide, _mfSideCode;
              if (_mfSuffix === "TIE") { _mfSide = "tie"; _mfSideCode = "TIE"; }
              else if (_mfSuffix === _mfHome) { _mfSide = "home"; _mfSideCode = _mfHome; }
              else if (_mfSuffix === _mfAway) { _mfSide = "away"; _mfSideCode = _mfAway; }
              else continue;
              const _mfDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _mfGameDate = null;
              if (_mfDateSeg.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _mfMo = _KMONT[_mfDateSeg.slice(2, 5).toUpperCase()];
                if (_mfMo) _mfGameDate = `20${_mfDateSeg.slice(0, 2)}-${_mfMo}-${_mfDateSeg.slice(5, 7)}`;
              }
              const _mfAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              (modelFreeMarkets[cfg.league] ||= []).push({ eventTicker: m.event_ticker, homeTeam: _mfHome, awayTeam: _mfAway, side: _mfSide, sideCode: _mfSideCode, gameDate: _mfGameDate, kalshiPct: _mfYesPct, noKalshiPct: _mfNoPct, americanOdds: _mfAO(_mfYesPct), kalshiVolume: _mfVol, _ticker: m.ticker, _depth: m._depth, half: cfg.half || null });
              continue;
            }
            // ── MLS/Liga MX threshold branch (1H spread/total/BTTS + full-game team-total) ──
            // model-free, one shared array+branch for both leagues (adopted 2026-07-23, see
            // project_mls_ligamx_threshold_2026_07_23 memory) — unlike scocup, MLS/LigaMX have
            // no team-abbr collision, so `parseGameTeams` + ticker-suffix extraction (the
            // existing generic teamTotal branch's own idiom, below) work directly; no
            // subtitle-based team resolution needed. Threshold parsed from subtitle text per
            // subtype (same rationale as scocup: floor_strike's raw/displayed-value offset
            // convention wasn't independently verifiable). `cfg.subtype` routes the shape;
            // `cfg.half` ("1h" or unset) tags which score the emit path resolves against.
            if (cfg.gameType === "clubSoccerThreshold") {
              const _ctYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _ctNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _ctLast = parseFloat(m.last_price_dollars) || 0;
              const _ctYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _ctNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _ctStale = _ctYesAsk >= 0.98 && _ctYesBid === 0 && _ctLast > 0;
              const _ctPrice = _ctStale ? _ctLast : (_ctYesAsk > 0 ? _ctYesAsk : _ctLast);
              if (_ctPrice === 0) continue; // no live book — skip (books fill near kickoff)
              const _ctYesSpreadC = _ctYesAsk > 0 ? Math.round((_ctYesAsk - _ctYesBid) * 100) : 999;
              const _ctNoSpreadC = _ctNoAsk > 0 ? Math.round((_ctNoAsk - _ctNoBid) * 100) : 999;
              if (!_ctStale && !capturableSpread(Math.min(_ctYesSpreadC, _ctNoSpreadC))) continue;
              const _ctYesPct = Math.round(_ctPrice * 100);
              const _ctNoPct = _ctNoAsk > 0 ? Math.round(_ctNoAsk * 100) : (100 - _ctYesPct);
              const _ctVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _ctSub = m.subtitle || m.yes_sub_title || "";
              const [_ctHome, _ctAway] = parseGameTeams(m.event_ticker, sport);
              if (!_ctHome || !_ctAway) continue;
              let _ctThreshold = null, _ctPickTeam = null;
              if (cfg.subtype === "spread") {
                const _ctMatch = _ctSub.match(/by more than\s+([\d.]+)\s+goals/i);
                if (!_ctMatch) continue;
                _ctThreshold = parseFloat(_ctMatch[1]);
                const _ctTm = ((m.ticker || "").split("-").pop() || "").match(/^([A-Z]+)/);
                if (!_ctTm) continue;
                _ctPickTeam = normTeam(sport, _ctTm[1]);
              } else if (cfg.subtype === "total") {
                const _ctMatch = _ctSub.match(/Over\s+([\d.]+)\s+(?:1H\s+)?goals scored/i);
                if (!_ctMatch) continue;
                _ctThreshold = parseFloat(_ctMatch[1]);
              } else if (cfg.subtype === "teamTotal") {
                const _ctMatch = _ctSub.match(/over\s+([\d.]+)\s+goals$/i);
                if (!_ctMatch) continue;
                _ctThreshold = parseFloat(_ctMatch[1]);
                const _ctTm = ((m.ticker || "").split("-").pop() || "").match(/^([A-Z]+)/);
                if (!_ctTm) continue;
                _ctPickTeam = normTeam(sport, _ctTm[1]);
              } else if (cfg.subtype !== "btts") {
                continue;
              }
              if (cfg.subtype !== "btts" && isNaN(_ctThreshold)) continue;
              const _ctSegment = (m.event_ticker || "").split("-")[1] || "";
              let _ctGameDate = null;
              if (_ctSegment.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _ctMo = _KMONT[_ctSegment.slice(2, 5).toUpperCase()];
                if (_ctMo) _ctGameDate = `20${_ctSegment.slice(0, 2)}-${_ctMo}-${_ctSegment.slice(5, 7)}`;
              }
              const _ctAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              clubSoccerThresholdMarkets.push({ sport, subtype: cfg.subtype, half: cfg.half || null, eventTicker: m.event_ticker, segment: _ctSegment, gameDate: _ctGameDate, homeTeam: _ctHome, awayTeam: _ctAway, threshold: _ctThreshold, pickTeam: _ctPickTeam, kalshiPct: _ctYesPct, noKalshiPct: _ctNoPct, americanOdds: _ctAO(_ctYesPct), noAmericanOdds: _ctAO(_ctNoPct), kalshiVolume: _ctVol, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── Scottish League Cup spread branch ── threshold market ("<team> wins by more
            // than N.5 goals"), model-free (see tonight/scocup.js). Team identity comes from the
            // market's subtitle text, NOT the 3-char ticker code — Kalshi reuses "DUN" for two
            // different clubs across events (see the scocup registry comment in teams.js), so
            // resolving from the human-readable subtitle sidesteps the collision entirely. The
            // segment (date + team-code pair, e.g. "26JUL26MIRDUN") is shared with the sibling
            // KXSCOCUPTOTAL series and used to join them in the emit path.
            if (cfg.gameType === "scocupSpread") {
              // Threshold parsed from the subtitle text ("<team> wins by more than 2.5 goals"),
              // not floor_strike — the raw/displayed-value offset convention for this series
              // wasn't independently verifiable (Kalshi's public API isn't reachable from every
              // environment this runs in), and the subtitle states the number directly.
              const _scsSub = m.subtitle || m.yes_sub_title || "";
              const _scsMatch = _scsSub.match(/wins by more than\s+([\d.]+)\s+goals/i);
              if (!_scsMatch) continue;
              const _scsStrike = parseFloat(_scsMatch[1]);
              if (isNaN(_scsStrike)) continue;
              const _scsYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _scsNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _scsLast = parseFloat(m.last_price_dollars) || 0;
              const _scsYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _scsNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _scsStale = _scsYesAsk >= 0.98 && _scsYesBid === 0 && _scsLast > 0;
              const _scsPrice = _scsStale ? _scsLast : (_scsYesAsk > 0 ? _scsYesAsk : _scsLast);
              if (_scsPrice === 0) continue; // no live book — skip (books fill near kickoff)
              // Liquidity gating happens in the emit path (tonight/scocup.js), NOT here — team
              // identity for an event is derived from every subtitled market seen, regardless of
              // that specific line's own liquidity. Gating here caused a real bug (found live
              // 2026-07-23): when only the favorite's lines had a real book, the underdog's name
              // never made it into scocupSpreadMarkets, so the event's team pair could never
              // resolve to 2 names and EVERY row silently dropped as "unresolved_teams".
              const _scsYesSpreadC = _scsYesAsk > 0 ? Math.round((_scsYesAsk - _scsYesBid) * 100) : 999;
              const _scsNoSpreadC = _scsNoAsk > 0 ? Math.round((_scsNoAsk - _scsNoBid) * 100) : 999;
              const _scsYesPct = Math.round(_scsPrice * 100);
              const _scsNoPct = _scsNoAsk > 0 ? Math.round(_scsNoAsk * 100) : (100 - _scsYesPct);
              const _scsVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _scsTeamName = _scsSub.split(" wins by")[0].trim();
              if (!_scsTeamName) continue;
              const _scsSegment = (m.event_ticker || "").split("-")[1] || "";
              let _scsGameDate = null;
              if (_scsSegment.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _scsMo = _KMONT[_scsSegment.slice(2, 5).toUpperCase()];
                if (_scsMo) _scsGameDate = `20${_scsSegment.slice(0, 2)}-${_scsMo}-${_scsSegment.slice(5, 7)}`;
              }
              const _scsAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              scocupSpreadMarkets.push({ segment: _scsSegment, gameDate: _scsGameDate, teamName: _scsTeamName, threshold: _scsStrike, line: _scsStrike, kalshiPct: _scsYesPct, noKalshiPct: _scsNoPct, americanOdds: _scsAO(_scsYesPct), noAmericanOdds: _scsAO(_scsNoPct), kalshiVolume: _scsVol, eventTicker: m.event_ticker, _ticker: m.ticker, _depth: m._depth, _stale: _scsStale, _yesSpreadC: _scsYesSpreadC, _noSpreadC: _scsNoSpreadC });
              continue;
            }
            // ── Scottish League Cup total branch ── threshold market ("Over N.5 goals scored"),
            // model-free, same doctrine as the spread branch above. No team subtitle — joined to
            // its spread siblings by the shared event segment in the emit path.
            if (cfg.gameType === "scocupTotal") {
              // Threshold parsed from the subtitle text ("Over 2.5 goals scored") — same
              // rationale as the spread branch above (floor_strike offset unverified).
              const _sctSub = m.subtitle || m.yes_sub_title || "";
              const _sctMatch = _sctSub.match(/Over\s+([\d.]+)\s+goals\s+scored/i);
              if (!_sctMatch) continue;
              const _sctStrike = parseFloat(_sctMatch[1]);
              if (isNaN(_sctStrike)) continue;
              const _sctYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _sctNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _sctLast = parseFloat(m.last_price_dollars) || 0;
              const _sctYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _sctNoBid = parseFloat(m.no_bid_dollars) || 0;
              const _sctStale = _sctYesAsk >= 0.98 && _sctYesBid === 0 && _sctLast > 0;
              const _sctPrice = _sctStale ? _sctLast : (_sctYesAsk > 0 ? _sctYesAsk : _sctLast);
              if (_sctPrice === 0) continue; // no live book — skip (books fill near kickoff)
              const _sctYesSpreadC = _sctYesAsk > 0 ? Math.round((_sctYesAsk - _sctYesBid) * 100) : 999;
              const _sctNoSpreadC = _sctNoAsk > 0 ? Math.round((_sctNoAsk - _sctNoBid) * 100) : 999;
              if (!_sctStale && !capturableSpread(Math.min(_sctYesSpreadC, _sctNoSpreadC))) continue;
              const _sctYesPct = Math.round(_sctPrice * 100);
              const _sctNoPct = _sctNoAsk > 0 ? Math.round(_sctNoAsk * 100) : (100 - _sctYesPct);
              const _sctVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _sctSegment = (m.event_ticker || "").split("-")[1] || "";
              let _sctGameDate = null;
              if (_sctSegment.length >= 7) {
                const _KMONT = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _sctMo = _KMONT[_sctSegment.slice(2, 5).toUpperCase()];
                if (_sctMo) _sctGameDate = `20${_sctSegment.slice(0, 2)}-${_sctMo}-${_sctSegment.slice(5, 7)}`;
              }
              const _sctAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              scocupTotalMarkets.push({ segment: _sctSegment, gameDate: _sctGameDate, threshold: _sctStrike, line: _sctStrike, kalshiPct: _sctYesPct, noKalshiPct: _sctNoPct, americanOdds: _sctAO(_sctYesPct), noAmericanOdds: _sctAO(_sctNoPct), kalshiVolume: _sctVol, eventTicker: m.event_ticker, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            // ── MLB pitcher outs-recorded branch ── threshold ladder per starter ("Senga: 15+").
            // yes_sub_title = "<pitcher>: N+"; floor_strike = N−0.5. Both YES(over)/NO(under) priced;
            // emitMlbOutsPlays picks the favorite side in [67,91]. Team-based (need home/away for the
            // resolver's /api/live lookup), so parse teams here + resolve home via gameHomeTeams.
            if (cfg.gameType === "mlbOuts") {
              const _oStrike = parseFloat(m.floor_strike);
              if (isNaN(_oStrike)) continue;
              const _oThreshold = Math.round(_oStrike + 0.5); // "N+" over threshold
              const _oYesAsk = parseFloat(m.yes_ask_dollars) || 0;
              const _oNoAsk = parseFloat(m.no_ask_dollars) || 0;
              const _oLast = parseFloat(m.last_price_dollars) || 0;
              const _oYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _oYesPrice = (_oYesAsk >= 0.98 && _oYesBid === 0 && _oLast > 0) ? _oLast : (_oYesAsk > 0 ? _oYesAsk : _oLast);
              if (_oYesPrice === 0) continue; // no live book — skip (books fill near first pitch)
              const _oYesPct = Math.round(_oYesPrice * 100);
              const _oNoPct = _oNoAsk > 0 ? Math.round(_oNoAsk * 100) : (100 - _oYesPct);
              const _oVol = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
              const _oName = (m.yes_sub_title || "").split(":")[0].trim();
              if (!_oName) continue;
              // gameDate from the YYMMMDD ticker segment (the ET game date; avoids the UTC roll that
              // close_time has on night games). Fallback to close_time.
              const _oEvSeg = (m.event_ticker || "").split("-")[1] || "";
              const _oMd = _oEvSeg.match(/^(\d{2})([A-Z]{3})(\d{2})/);
              const _oMonths = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
              const _oDate = _oMd ? `20${_oMd[1]}-${_oMonths[_oMd[2]] || "01"}-${_oMd[3]}` : ((m.close_time || "").slice(0, 10) || null);
              // Parse teams in ticker order; the home/away swap (needs gameHomeTeams) is deferred to
              // emitMlbOutsPlays — sportByteam isn't initialized yet here (TDZ in the parse loop).
              const [_oT1, _oT2] = parseGameTeams(m.event_ticker, "mlb");
              // Pitcher's team = leading abbr of the market-ticker suffix (after the event segment).
              const _oMktSuffix = (m.ticker || "").slice((m.event_ticker || "").length + 1);
              let _oPitTeam = null;
              if (_oT1 && _oMktSuffix.startsWith(_oT1)) _oPitTeam = _oT1;
              else if (_oT2 && _oMktSuffix.startsWith(_oT2)) _oPitTeam = _oT2;
              const _oAO = (pct) => pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              outsMarkets.push({ player: _oName, threshold: _oThreshold, gameTeam1: _oT1, gameTeam2: _oT2, pitcherTeam: _oPitTeam, yesPct: _oYesPct, noPct: _oNoPct, yesAO: _oAO(_oYesPct), noAO: _oAO(_oNoPct), kalshiVolume: _oVol, gameDate: _oDate, _ticker: m.ticker, _depth: m._depth });
              continue;
            }
            const strike = parseFloat(m.floor_strike);
            if (isNaN(strike)) continue;
            const threshold = Math.round(strike + 0.5);
            const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
            const noAsk = parseFloat(m.no_ask_dollars) || 0;
            const last = parseFloat(m.last_price_dollars) || 0;
            const volume = parseInt(m.volume_fp) || parseInt(m.volume) || 0;
            const yesBidEarly = parseFloat(m.yes_bid_dollars) || 0;
            const noBidEarly = parseFloat(m.no_bid_dollars) || 0;
            // Bet-side bid-ask spread (cents) — the CAPTURE_MAX_SPREAD gate below rejects a rung
            // whose captured side is a lone-quote artifact (no real two-sided book). No ask on a
            // side → 999 so that side can never be captured. See config.js CAPTURE_MAX_SPREAD.
            const yesSpreadC = yesAsk > 0 ? Math.round((yesAsk - yesBidEarly) * 100) : 999;
            const noSpreadC  = noAsk  > 0 ? Math.round((noAsk  - noBidEarly)  * 100) : 999;
            // Stale ask: market maker maxed ask at 99¢ with no bid — use last traded price instead
            const _staleAskPath = yesAsk >= 0.98 && yesBidEarly === 0 && last > 0;
            const price = _staleAskPath ? last : (yesAsk > 0 ? yesAsk : last);
            const pct = Math.round(price * 100);
            // Real NO-side ask (cost to actually buy the UNDER). Kalshi's YES and NO books are
            // independent — `1 - yes_ask` is the *fair* synthetic NO price, but the real fill
            // is no_ask, which can be 3–7 cents higher due to spread. Using 1 - pct here would
            // systematically underprice UNDERs (e.g. yes_ask=0.17 → fake NO=-488 vs real NO=-720).
            // Fall back to 1 - pct only when no_ask is missing.
            const noPct = noAsk > 0 ? Math.round(noAsk * 100) : (100 - pct);
            if (price === 0) continue;

            // ── Game total branch (wider pct filter; team-based, not player-based) ──
            if (cfg.gameType === "total") {
              // Capture markets where EITHER side (YES/OVER or NO/UNDER) sits in the wide
              // [CAPTURE_GATE, CAPTURE_CAP] favorite curve — wider than the [67,91] bet window so
              // calibration sees the full curve (2026-06-29 de-blinding). The `qualified` bet flag
              // is re-applied downstream at [67,91]. The OVER push gates on YES (yesAsk), the UNDER
              // push gates on NO (noAsk = real ask, not synthetic 1-yesAsk), so we don't bet OVERs
              // against an UNDER-favored line and vice versa.
              if ((pct < CAPTURE_GATE || pct > CAPTURE_CAP) && (noPct < CAPTURE_GATE || noPct > CAPTURE_CAP)) continue;
              // Liquidity gate (2026-07-11, game rows — same doctrine as the prop gate below):
              // Kalshi's book is unified (NO ask ≡ YES bid), so bid-ask spread ≈ overround and
              // both sides share it when both asks exist; min() lets a real one-sided book carry
              // the market when the other ask is absent (999). In-play-only segments (WNBA Q2-Q4,
              // halves) captured pre-game list ~95¢ asks on BOTH sides — quotes, not prices.
              if (!_staleAskPath && !capturableSpread(Math.min(yesSpreadC, noSpreadC))) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              const dedupeKey = `total|${sport}|${segment}|${gameTeam1}|${gameTeam2}|${threshold}`;
              if (globalSeen.has(dedupeKey)) continue;
              globalSeen.add(dedupeKey);
              const _toAO = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              const _tNoAO = noPct >= 50 ? Math.round(-(noPct / (100 - noPct)) * 100) : Math.round((100 - noPct) / noPct * 100);
              const _tDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _tGameDate = null;
              if (_tDateSeg.length >= 7) {
                const _KMON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _tYr = "20" + _tDateSeg.slice(0, 2);
                const _tMo = _KMON[_tDateSeg.slice(2, 5).toUpperCase()];
                const _tDy = _tDateSeg.slice(5, 7);
                if (_tMo) _tGameDate = `${_tYr}-${_tMo}-${_tDy}`;
              }
              const _tYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _tSpread = yesAsk > 0 && _tYesBid > 0 ? Math.round((yesAsk - _tYesBid) * 100) : null;
              totalMarkets.push({ gameType: "total", sport, stat, col, segment, threshold, kalshiPct: pct, americanOdds: _toAO, noKalshiPct: noPct, noKalshiAO: _tNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, gameDate: _tGameDate, kalshiSpread: _tSpread, _ticker: m.ticker, _yesAsk: yesAsk, _yesBid: _tYesBid, _noAsk: noAsk, _depth: m._depth });
              continue;
            }

            // ── Team total branch (single team's score vs opposing defense) ──
            if (cfg.gameType === "teamTotal") {
              // Same wide capture gate as game totals — accept either OVER-side or UNDER-side alt
              // lines across the [CAPTURE_GATE, CAPTURE_CAP] favorite curve; the OVER/UNDER push
              // paths apply their own [67,91] kalshiPct/noKalshiPct bet gate downstream.
              // UNDER side uses real noAsk (not 1-yesAsk) since YES/NO books are independent.
              if ((pct < CAPTURE_GATE || pct > CAPTURE_CAP) && (noPct < CAPTURE_GATE || noPct > CAPTURE_CAP)) continue;
              // Liquidity gate — see the game-total branch above (2026-07-11).
              if (!_staleAskPath && !capturableSpread(Math.min(yesSpreadC, noSpreadC))) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              // Extract scoring team from ticker suffix (e.g. "LAD8" → "LAD", "PHI97" → "PHI")
              const _ttSuffix = (m.ticker || "").split("-").pop() || "";
              const _ttMatch = _ttSuffix.match(/^([A-Z]+)/);
              if (!_ttMatch) continue;
              const scoringTeam = normTeam(sport, _ttMatch[1]);
              const dedupeKey = `teamtotal|${sport}|${scoringTeam}|${gameTeam1}|${gameTeam2}|${threshold}`;
              if (globalSeen.has(dedupeKey)) continue;
              globalSeen.add(dedupeKey);
              const _ttAO = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              const _ttNoAO = noPct >= 50 ? Math.round(-(noPct / (100 - noPct)) * 100) : Math.round((100 - noPct) / noPct * 100);
              const _ttDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _ttGameDate = null;
              if (_ttDateSeg.length >= 7) {
                const _KMON2 = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _ttYr = "20" + _ttDateSeg.slice(0, 2);
                const _ttMo = _KMON2[_ttDateSeg.slice(2, 5).toUpperCase()];
                const _ttDy = _ttDateSeg.slice(5, 7);
                if (_ttMo) _ttGameDate = `${_ttYr}-${_ttMo}-${_ttDy}`;
              }
              const _ttYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _ttSpread = yesAsk > 0 && _ttYesBid > 0 ? Math.round((yesAsk - _ttYesBid) * 100) : null;
              teamTotalMarkets.push({ gameType: "teamTotal", sport, stat, col, threshold, kalshiPct: pct, americanOdds: _ttAO, noKalshiPct: noPct, noKalshiAO: _ttNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, scoringTeam, gameDate: _ttGameDate, kalshiSpread: _ttSpread, _ticker: m.ticker, _yesAsk: yesAsk, _noAsk: noAsk, _depth: m._depth });
              continue;
            }

            // ── Spread branch (MLB run-line: "Team X wins by over Y runs?") ──
            // Suffix `{team}{N}` where line = strike (== N - 0.5). YES = the margin side; NO = the
            // cover side (handled identically to totals UNDER via real no_ask, not 1 - yes_ask).
            // Same wide capture gate as totals: keep if either side sits in the favorite curve
            // [CAPTURE_GATE, CAPTURE_CAP]; emission re-gates `qualified` at [67,91].
            if (cfg.gameType === "spread") {
              if ((pct < CAPTURE_GATE || pct > CAPTURE_CAP) && (noPct < CAPTURE_GATE || noPct > CAPTURE_CAP)) continue;
              // Liquidity gate — see the game-total branch above (2026-07-11).
              if (!_staleAskPath && !capturableSpread(Math.min(yesSpreadC, noSpreadC))) continue;
              const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
              if (!gameTeam1 || !gameTeam2) continue;
              const _spSuffix = (m.ticker || "").split("-").pop() || "";
              const _spMatch = _spSuffix.match(/^([A-Z]+)(\d+)$/);
              if (!_spMatch) continue;
              const marginTeam = normTeam(sport, _spMatch[1]);
              // Trust the parsed strike (floor_strike) as the line; suffix N is a sanity-check tier.
              if (isNaN(strike) || strike <= 0 || strike === Math.floor(strike)) continue;
              const dedupeKey = `spread|${sport}|${segment}|${marginTeam}|${gameTeam1}|${gameTeam2}|${strike}`;
              if (globalSeen.has(dedupeKey)) continue;
              globalSeen.add(dedupeKey);
              const _spAO = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
              const _spNoAO = noPct >= 50 ? Math.round(-(noPct / (100 - noPct)) * 100) : Math.round((100 - noPct) / noPct * 100);
              const _spDateSeg = (m.event_ticker || "").split("-")[1] || "";
              let _spGameDate = null;
              if (_spDateSeg.length >= 7) {
                const _KMON3 = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
                const _spYr = "20" + _spDateSeg.slice(0, 2);
                const _spMo = _KMON3[_spDateSeg.slice(2, 5).toUpperCase()];
                const _spDy = _spDateSeg.slice(5, 7);
                if (_spMo) _spGameDate = `${_spYr}-${_spMo}-${_spDy}`;
              }
              const _spYesBid = parseFloat(m.yes_bid_dollars) || 0;
              const _spSpread = yesAsk > 0 && _spYesBid > 0 ? Math.round((yesAsk - _spYesBid) * 100) : null;
              spreadMarkets.push({ gameType: "spread", sport, stat, col, segment, line: strike, marginTeam, kalshiPct: pct, americanOdds: _spAO, noKalshiPct: noPct, noKalshiAO: _spNoAO, kalshiVolume: volume, gameTeam1, gameTeam2, gameDate: _spGameDate, kalshiSpread: _spSpread, _ticker: m.ticker, _yesAsk: yesAsk, _noAsk: noAsk, _depth: m._depth });
              continue;
            }

            // Player props are YES-side by default. Total bases is the exception (2026-06-12):
            // Kalshi lists TB thresholds 2+ and up only, and P(2+ TB) never prices ≥67, so the
            // YES side can't reach the window — the tradeable side is the NO ("under 2 TB" ~70-85).
            // Push those as under-direction props priced at no_ask. Scoped to totalBases; every
            // other prop series keeps YES-only behavior.
            // Capture band is the wide [CAPTURE_GATE, CAPTURE_CAP] favorite curve, NOT the [67,91]
            // bet window — so calibration sees the favorite tail above 91¢ (the 2026-06-29 finding:
            // totalBases' Brier edge lives above the cap, but we were capping capture at it). The
            // `qualified` bet flag is still applied at [67,91] downstream in props.js.
            // Liquidity gate (2026-06-30): a rung whose captured side is a lone-quote artifact
            // (no real two-sided book) reports a bet-side ask that isn't tradeable — e.g. a lone
            // NO bid at ~6¢ implies yes_ask=94¢, so high-threshold totalBases longshots masquerade
            // as 94¢ favorites and poison calibration. Reject when the captured side's bid-ask
            // spread exceeds CAPTURE_MAX_SPREAD. Under captures on NO, over on YES — gate the side
            // we'd actually buy. Real favorites are ≤7¢; artifacts ~94¢. See config.js.
            let propDirection = null; // null = YES/over (legacy field shape on all other props)
            // Full-curve capture (2026-07-03): the flip used to trigger on "YES out of the
            // favorite band, NO in it"; with the band now quote-sanity-wide that condition is
            // dead, so flip on the equivalent semantics directly — NO is the favorite side.
            // Preserves row continuity: every rung that logged as an under keeps logging as one.
            if (stat === "totalBases" && noPct > pct
                && noPct >= CAPTURE_GATE && noPct <= CAPTURE_CAP) {
              if (!capturableSpread(noSpreadC)) continue;
              propDirection = "under";
            } else {
              if (pct < CAPTURE_GATE) continue;
              if (pct > CAPTURE_CAP) continue;
              // Exempt the stale-ask path (priced off a real `last` trade, not the maxed ask) —
              // its wide book is expected and it deliberately captures the near-cert tail. The 94¢
              // artifacts sit below 0.98 so take the normal path and are still rejected here.
              if (!_staleAskPath && !capturableSpread(yesSpreadC)) continue;
            }
            // HRR is YES/over-side only at EVERY threshold (unlike totalBases, which lists no 1+
            // line and is bet as a NO/under). The 1+ over is the bread-and-butter play; 2+/3+ overs
            // only reach the [67,91] window for elite bats and pass the YES gate above organically.
            // 2026-06-12: dropped the `threshold > 1` skip so those higher-line overs flow to shadow
            // for calibration (mlb|hrr is shadow-only, not in the category gate). Band shadow
            // analysis by threshold — the 6/10 recalibration was fit on 1+ rows only.
            const raw = m.event_title || m.title || "";
            let playerName = raw.replace(/\s*:\s*\d.*$/, "").replace(/\s+(Points?|Rebounds?|Assists?|3-Pointers?|Three Pointers?|Made Threes?|Goals?|Shots on Goal|Hits?|Home Runs?|RBIs?|Strikeouts?|Total Bases?|Passing Yards?|Rushing Yards?|Receiving Yards?|Touchdowns?)\b.*/i, "").replace(/\s+Over\s+\d.*$/i, "").replace(/\s+Under\s+\d.*$/i, "").replace(/\s*\(.*\)\s*$/, "").replace(/\s*-\s*$/, "").trim();
            if (!playerName || playerName.length < 4) continue;
            const playerNameDisplay = playerName;
            playerName = normName(playerName);
            const dedupeKey = `${sport}|${playerName}|${stat}|${threshold}`;
            if (globalSeen.has(dedupeKey)) continue;
            globalSeen.add(dedupeKey);
            const americanOdds = pct >= 50 ? Math.round(-(pct / (100 - pct)) * 100) : Math.round((100 - pct) / pct * 100);
            // Under props follow the totals convention: kalshiPct/truePct stay over-framed,
            // the NO side rides in noKalshiPct/noKalshiAO, and consumers flip on direction.
            const noKalshiAO = noPct >= 50 ? Math.round(-(noPct / (100 - noPct)) * 100) : Math.round((100 - noPct) / noPct * 100);
            const [gameTeam1, gameTeam2] = parseGameTeams(m.event_ticker, sport);
            const tickerSegs = (m.ticker || "").split("-");
            let kalshiPlayerTeam = null;
            if (tickerSegs.length >= 3) {
              const seg3 = tickerSegs[2];
              if (gameTeam1 && seg3.startsWith(gameTeam1)) kalshiPlayerTeam = gameTeam1;
              else if (gameTeam2 && seg3.startsWith(gameTeam2)) kalshiPlayerTeam = gameTeam2;
              else {
                // Kalshi sometimes appends player initial to a 2-char team prefix (e.g. "SJM" for SJS + Macklin Celebrini)
                const norm2 = normTeam(sport, seg3.slice(0, 2));
                if (norm2 && (norm2 === gameTeam1 || norm2 === gameTeam2)) kalshiPlayerTeam = norm2;
                else kalshiPlayerTeam = normTeam(sport, seg3.slice(0, 3));
              }
            }
            const dateSeg = (m.event_ticker || "").split("-")[1] || "";
            let gameDate = null;
            if (dateSeg.length >= 7) {
              const KMON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
              const yr = "20" + dateSeg.slice(0, 2);
              const mo = KMON[dateSeg.slice(2, 5).toUpperCase()];
              const dy = dateSeg.slice(5, 7);
              if (mo) gameDate = `${yr}-${mo}-${dy}`;
            }
            const yesBid = parseFloat(m.yes_bid_dollars) || 0;
            const yesAskSize = parseFloat(m.yes_ask_size_fp) || 0;
            const noBid = parseFloat(m.no_bid_dollars) || 0;
            const kalshiSpread = propDirection === "under"
              ? (noAsk > 0 && noBid > 0 ? Math.round((noAsk - noBid) * 100) : null)
              : (yesAsk > 0 && yesBid > 0 ? Math.round((yesAsk - yesBid) * 100) : null);
            // HRR: attach the NO quote (no direction — the row stays YES-framed) so the props.js
            // NO-side flip (2026-07-11) can evaluate it. Only when the NO book is real: noAsk
            // absent → noPct is the synthetic 100-pct fallback (never a fill price), and a
            // one-sided NO book (spread > CAPTURE_MAX_SPREAD, incl. stale-ask books via noBid=0)
            // would redirect the bet to an untradeable artifact price. Absent field = flip can't
            // fire, failure-closed.
            const _hrrNoQuote = stat === "hrr" && noAsk > 0 && capturableSpread(noSpreadC)
              ? { noKalshiPct: noPct, noKalshiAO } : {};
            qualifyingMarkets.push({ playerName, playerNameDisplay, sport, stat, col, threshold, kalshiPct: pct, americanOdds, kalshiVolume: volume, gameTeam1, gameTeam2, kalshiPlayerTeam, gameDate, kalshiSpread, ...(propDirection ? { direction: propDirection, noKalshiPct: noPct, noKalshiAO } : _hrrNoQuote), _ticker: m.ticker, _yesAsk: yesAsk, _yesBid: yesBid, _yesAskSize: yesAskSize, _depth: m._depth });
          }
        }
        if (qualifyingMarkets.length === 0 && totalMarkets.length === 0) {
          return jsonResponse({ plays: [], note: "no qualifying kalshi markets (implied pct >= 60)" });
        }
        // Derive implied NBA game O/U line from Kalshi KXNBATOTAL markets.
        // Uses ALL pcts (no 70-97 filter) to find the 50% YES crossing per game.
        // Falls back into nbaGameOdds for teams ESPN doesn't include in today's scoreboard odds.
        // Same fallback applied for MLB + NHL below — ESPN scoreboard only carries today's odds,
        // so tomorrow's games render with O/U "—" without a Kalshi-derived backfill.
        // Blended fill price (player props): re-price kalshiPct to the true cost of sweeping a
        // unit-sized position, not just top-of-book ask. Depth comes from the snapshot cron's
        // cached `_depth` (kalshi:snap:{ticker}) — NO live orderbook fetch on the hot path
        // (replaced the prior live walk 2026-05-31; see blend-fill.js). Player props are always
        // a YES buy. Markets without cached depth keep top-of-book (blendMarketPrice → null).
        for (const m of qualifyingMarkets) {
          const blended = blendMarketPrice(m._depth, "yes", m.kalshiPct);
          if (blended) { m.kalshiPct = blended.pct; m.americanOdds = blended.americanOdds; }
          // Under props (totalBases) actually buy the NO side — re-price it from the NO book
          // too, mirroring the totals/spreads loop below. HRR rows carry noKalshiPct without a
          // direction (props.js decides the flip) — their NO price needs the same re-price so
          // the flip compares blended fills on both sides.
          if (m.noKalshiPct != null) {
            const nb = blendMarketPrice(m._depth, "no", m.noKalshiPct);
            if (nb) { m.noKalshiPct = nb.pct; m.noKalshiAO = nb.americanOdds; }
          }
        }
        // Blended fill price (totals / team totals / spreads): same cached-depth blend, but each
        // of these has TWO tradeable sides — the OVER/margin (YES buy) and the UNDER/cover (NO
        // buy) — so we re-price both. Done here at the PARSE site (before game-totals.js and
        // ml-spread.js read these arrays) so the emit modules need zero changes; they consume
        // already-slippage-adjusted kalshiPct/noKalshiPct. YES re-prices kalshiPct+americanOdds;
        // NO re-prices noKalshiPct+noKalshiAO. Markets without cached depth keep top-of-book.
        for (const m of [...totalMarkets, ...teamTotalMarkets, ...spreadMarkets]) {
          const yb = blendMarketPrice(m._depth, "yes", m.kalshiPct);
          if (yb) { m.kalshiPct = yb.pct; m.americanOdds = yb.americanOdds; }
          const nb = blendMarketPrice(m._depth, "no", m.noKalshiPct);
          if (nb) { m.noKalshiPct = nb.pct; m.noKalshiAO = nb.americanOdds; }
        }
        // E1: Line movement tracking — record opening price the first time we see each ticker.
        // lineMove = current yesAsk (after blend) - openYesAsk (first seen today).
        // KV key: lineOpen:{ticker}:{gameDate} → openYesAsk (cents, 0-100)
        if (CACHE2) {
          const _allTrackedMarkets = [...qualifyingMarkets, ...totalMarkets];
          await Promise.all(_allTrackedMarkets.map(async m => {
            if (!m._ticker || !m.gameDate) return;
            const _lmKey = `lineOpen:${m._ticker}:${m.gameDate}`;
            try {
              const _existing = await CACHE2.get(_lmKey);
              if (_existing != null) {
                const _openAsk = parseFloat(_existing);
                if (!isNaN(_openAsk)) m.lineMove = parseFloat((m.kalshiPct - _openAsk).toFixed(1));
              } else {
                // First time — write opening price; TTL = 48h (covers game day + settlement)
                await CACHE2.put(_lmKey, String(m.kalshiPct), { expirationTtl: 172800 });
                m.lineMove = 0;
              }
            } catch {}
          }));
        }
        // E2: Market depth flags — thinMarket and marketConfidence
        for (const m of [...qualifyingMarkets, ...totalMarkets, ...teamTotalMarkets]) {
          m.thinMarket = m.kalshiSpread != null && m.kalshiSpread > 8;
          m.marketConfidence = m.kalshiVolume >= 100 ? "deep" : m.kalshiVolume >= 50 ? "moderate" : "thin";
        }
        const sportsNeeded = new Set([...qualifyingMarkets.map((m) => m.sport), ...totalMarkets.map((m) => m.sport)]);
        const sportByteam = {};
        if (CACHE2) {
          await Promise.all([...sportsNeeded].map(async (sport) => {
            // When busting, skip the cache read for MLB so fresh computation is forced.
            // Deleting + reading in the same request is unreliable due to KV eventual consistency.
            if (isBustCache && PROD_SPORTS.has(sport)) return;
            const cached = await CACHE2.get(`byteam:${sport}`, "json").catch(() => null);
            if (cached) sportByteam[sport] = cached;
          }));
        }
        const sportsNeedingFetch = new Set([...sportsNeeded].filter((s) => !sportByteam[s]));
        if (sportsNeedingFetch.size > 0) {
          await Promise.all([
            sportsNeedingFetch.has("nba") && buildNbaByteam(CACHE2, normTeam).then(r => Object.assign(sportByteam, r)),
            sportsNeedingFetch.has("wnba") && buildWnbaByteam(CACHE2, normTeam).then(r => Object.assign(sportByteam, r)),
            // NHL byteam (goalie/injury/special-teams/GAA) was model-only hydration — deleted with
            // the model teardown (2026-08-04, slice 4). NHL home/away + odds + top players come from
            // the scoreboard parse (parseGameScores fallbacks / nhlGameScores etc.), not from here.
            // NFL byteam was a passing-statistics fetch writing `sportByteam.nfl`, which nothing
            // ever read — a model-era orphan the 2026-08-04 teardown missed. Deleted 2026-08-10
            // with the KXNFLGAME build; NFL home/away now comes from nflGameScores, extracted
            // below from the scoreboard the gameTimes loop already fetches (same as NHL).
            sportsNeedingFetch.has("mlb") && buildMlbByteam(CACHE2).then((d) => { sportByteam.mlb = d || {}; })
          ].filter(Boolean));
        }
        await _fdMark("afterByteam");
        // Kalshi MLB postponed-ticker reattribution: when a game is rained out, Kalshi
        // keeps the original ticker (date segment + expected_expiration_time both stale)
        // and reuses it for the makeup game. The market parse loop above stamps gameDate
        // from the ticker segment, so a postponed-but-played-today market would otherwise
        // get filtered out as "yesterday's game". Look up the actual next-scheduled game
        // between the two teams in ESPN's schedule and overwrite gameDate in place.
        // _mlbNextGameByTeams + _reattrMlbGameDate are hoisted out so the ML/spread
        // emission loops below can reattribute using the same logic (their expected_
        // expiration_time-derived gameDate hits the same staleness).
        const _todayForReattr = PT_FMT.format(new Date());
        const _mlbNextGameByTeams = {};
        if (sportByteam.mlb?.gameScores) {
          for (const gs of Object.values(sportByteam.mlb.gameScores)) {
            if (gs?.state !== "pre" || !gs.gameDate || gs.gameDate < _todayForReattr) continue;
            if (!gs.homeTeam || !gs.awayTeam) continue;
            const k = [gs.homeTeam, gs.awayTeam].sort().join("|");
            const existing = _mlbNextGameByTeams[k];
            if (!existing || (gs.gameTime && existing.gameTime && gs.gameTime < existing.gameTime) || (gs.gameDate < existing.gameDate)) {
              _mlbNextGameByTeams[k] = { gameDate: gs.gameDate, gameTime: gs.gameTime };
            }
          }
        }
        const _reattrMlbGameDate = (parsedGameDate, teamA, teamB, isResolved) => {
          if (!parsedGameDate || parsedGameDate >= _todayForReattr) return parsedGameDate;
          if (isResolved) return parsedGameDate;
          if (!teamA || !teamB) return parsedGameDate;
          const next = _mlbNextGameByTeams[[teamA, teamB].sort().join("|")];
          return next?.gameDate ?? parsedGameDate;
        };
        const _isMlbResolvedMarket = (m) => {
          const ya = m._yesAsk ?? 0;
          const na = m._noAsk ?? 0;
          const _atFloor = (v) => v > 0 && v <= 0.02;
          const _atCeil = (v) => v >= 0.99;
          return (_atFloor(ya) || _atCeil(ya)) && (_atFloor(na) || _atCeil(na));
        };
        for (const arr of [totalMarkets, teamTotalMarkets, spreadMarkets]) {
          for (const m of arr) {
            if (m.sport !== "mlb") continue;
            m.gameDate = _reattrMlbGameDate(m.gameDate, m.gameTeam1, m.gameTeam2, _isMlbResolvedMarket(m));
          }
        }
        // Fetch game start times + NBA player availability for tonight's games
        const todayDateStr = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
        // Today's PT date in ISO (YYYY-MM-DD) — used by lineupConfirmed checks to refuse
        // crediting today's lineup data toward tomorrow's games (sportByteam.mlb.lineupSpotByName
        // is a team-level map without date scoping; without this guard, a team playing
        // back-to-back days would inherit today's confirmation for tomorrow's game).
        const _todayPT = PT_FMT.format(new Date());
        // Single source of truth for "both teams have a confirmed (non-projected) lineup posted
        // for this game's date". Used by game-total / team-total / ML / spread emission. Player
        // props use the asymmetric _mlbLineupConf helper (per stat: K = opp only, hitter = own +
        // opp-pitcher-known). DO NOT inline this check — duplicate definitions drift (see
        // 187f9f3 where I missed two sites updating just one). teamA/teamB are interchangeable.
        const _mlbBothTeamsConfirmed = (teamA, teamB, gameDate) => {
          if (gameDate !== _todayPT) return false;
          const _spotMap = sportByteam.mlb?.lineupSpotByName || {};
          const _proj = sportByteam.mlb?.projectedLineupTeams || [];
          const _ok = (t) => _spotMap[t] != null && !_proj.includes(t);
          return _ok(teamA) && _ok(teamB);
        };
        // nbaStarters loaded in parallel with nbaPlayerStatus since the fetch that populates
        // them shares the same ESPN summary URL — same lifecycle (600s TTL).
        let nbaStarters = (sportsNeeded.has("nba") && CACHE2 && !isBustCache)
          ? await CACHE2.get(`nba:starters:${todayDateStr}`, "json").catch(() => null)
          : null;
        let wnbaStarters = (sportsNeeded.has("wnba") && CACHE2 && !isBustCache)
          ? await CACHE2.get(`wnba:starters:${todayDateStr}`, "json").catch(() => null)
          : null;
        let [gameTimes, nbaPlayerStatus] = await Promise.all([
          CACHE2 && !isBustCache ? CACHE2.get(`gameTimes:v2:${todayDateStr}`, "json").catch(() => null) : null,
          CACHE2 ? CACHE2.get(`nbaStatus:${todayDateStr}`, "json").catch(() => null) : null,
        ]);
        const needGameTimes = !gameTimes;
        const needNbaStatus = !nbaPlayerStatus && sportsNeeded.has("nba");
        const needNbaStarters = !nbaStarters && sportsNeeded.has("nba");
        const needWnbaStarters = !wnbaStarters && sportsNeeded.has("wnba");
        const needNbaSummaries = needNbaStatus || needNbaStarters;
        const needAnySummary = needNbaSummaries || needWnbaStarters;
        if (needGameTimes || needAnySummary) {
          gameTimes = gameTimes || {};
          nbaPlayerStatus = nbaPlayerStatus || {};
          // nfl added 2026-08-10 (KXNFLGAME build). This map is what populates `gameTimes`, and the
          // NFL event ticker is date-only — so without an entry here every NFL row logs with
          // gameTime:null and is silently never maker-quotable, the CANPL/Phase-1 defect.
          const SPORT_SB_PATH = { nba: "basketball/nba", wnba: "basketball/wnba", nhl: "hockey/nhl", mlb: "baseball/mlb", nfl: "football/nfl" };
          // When game times are already cached we still need scoreboards for any sport that
          // needs summary data (NBA + WNBA both fetch starters via per-event summary endpoints).
          const sportsToFetch = needGameTimes
            ? [...sportsNeeded].filter(s => SPORT_SB_PATH[s])
            : [
                ...(needNbaSummaries ? ["nba"] : []),
                ...(needWnbaStarters ? ["wnba"] : []),
              ];
          const yesterdayDateStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, "");
          const tomorrowDateStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10).replace(/-/g, "");
          // +2 days (2026-07-27). Kalshi lists markets further out than ESPN's old today+tomorrow
          // window, so rows for D+2 games were captured with gameTime:null — which silently blocks
          // maker quoting. 98 WNBA rows/day sat in that gap.
          const dayAfterDateStr = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
          const sbResults = await Promise.all(sportsToFetch.map(async s => {
            try {
              const H2 = { "User-Agent": "Mozilla/5.0" };
              const base = `https://site.api.espn.com/apis/site/v2/sports/${SPORT_SB_PATH[s]}/scoreboard`;
              const [r1, r2, r3, r4] = await Promise.all([
                fetch(`${base}?dates=${yesterdayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${todayDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${tomorrowDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch(`${base}?dates=${dayAfterDateStr}`, { headers: H2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
              ]);
              // The D+2 events are deliberately kept OUT of `events` and exposed separately.
              // `parseGameScores` is keyed by TEAM with last-event-wins, so folding D+2 in would let
              // a further-out game overwrite a nearer game's scores. Only the gameTimes map — which
              // keys by `sport:team:ptDate` and so cannot collide across dates — reads this.
              return {
                sport: s,
                events: [...(r1.events || []), ...(r2.events || []), ...(r3.events || [])],
                eventsDayAfter: [...(r4.events || [])],
              };
            } catch { return { sport: s, events: [], eventsDayAfter: [] }; }
          }));
          if (needGameTimes) {
            for (const { sport, events, eventsDayAfter } of sbResults) {
              // D+2 events appended LAST so the bare `gameTimes[key]` fallback (first-seen-wins)
              // still prefers the nearest game; the dated keys can't collide across days anyway.
              for (const ev of [...events, ...(eventsDayAfter || [])]) {
                const abbrs = (ev.competitions?.[0]?.competitors || []).map(c => c.team?.abbreviation).filter(Boolean);
                if (ev.date && abbrs.length === 2) {
                  const ptDate = PT_FMT.format(new Date(ev.date));
                  for (const abbr of abbrs) {
                    const key = `${sport}:${normTeam(sport, abbr)}`;
                    const _existDt = gameTimes[`${key}:${ptDate}`];
                    if (!_existDt || ev.date > _existDt) gameTimes[`${key}:${ptDate}`] = ev.date; // latest UTC time wins
                    if (!gameTimes[key]) gameTimes[key] = ev.date; // bare fallback (first seen wins)
                  }
                }
              }
            }
            if (CACHE2 && Object.keys(gameTimes).length > 0) await CACHE2.put(`gameTimes:v2:${todayDateStr}`, JSON.stringify(gameTimes), { expirationTtl: 600 }).catch(() => {});
            // Extract NHL game scores from already-fetched ESPN events (no extra request)
            const _nhlSbResult = sbResults.find(r => r.sport === "nhl");
            if (_nhlSbResult?.events.length > 0) {
              sportByteam.nhlGameScores = parseGameScores(_nhlSbResult.events, a => normTeam("nhl", a));
            }
            // No nflGameScores: NFL home/away comes from the ticker (AWAY+HOME), not the
            // scoreboard — see game-totals.js. NFL is still in SPORT_SB_PATH above because
            // `gameTimes` needs it: the NFL event ticker carries no HHMM.
            // Extract NBA game scores from already-fetched ESPN events
            const _nbaSbResult = sbResults.find(r => r.sport === "nba");
            if (_nbaSbResult?.events.length > 0 && !sportByteam.nbaGameScores) {
              sportByteam.nbaGameScores = parseGameScores(_nbaSbResult.events, a => normTeam("nba", a));
            }
            // Extract WNBA game scores from already-fetched ESPN events
            const _wnbaSbResult = sbResults.find(r => r.sport === "wnba");
            if (_wnbaSbResult?.events.length > 0) {
              if (!sportByteam.wnbaGameScores) sportByteam.wnbaGameScores = parseGameScores(_wnbaSbResult.events, a => normTeam("wnba", a));
            }
          }
          if (needNbaSummaries) {
            // One fetch per game serves BOTH injuries (nbaPlayerStatus) and boxscore starters
            // (nbaStarters). Both feed downstream consumers with 600s TTL on the same cycle.
            const nbaEvents = sbResults.find(r => r.sport === "nba")?.events || [];
            const _starterConfirmedTeams = [];
            const _starterByTeam = {};
            await Promise.all(nbaEvents.map(async ev => {
              try {
                const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${ev.id}`, { headers: { "User-Agent": "Mozilla/5.0" } });
                if (!r.ok) return;
                const d = await r.json();
                if (needNbaStatus) {
                  for (const teamInj of d.injuries || []) {
                    for (const inj of teamInj.injuries || []) {
                      const aid = inj.athlete?.id;
                      if (aid) nbaPlayerStatus[String(aid)] = (inj.status || "Out").toLowerCase();
                    }
                  }
                }
                if (needNbaStarters) {
                  for (const tp of d.boxscore?.players || []) {
                    const abbr = normTeam("nba", tp.team?.abbreviation || "");
                    if (!abbr) continue;
                    const athletes = tp.statistics?.[0]?.athletes || [];
                    const starterIds = athletes.filter(a => a.starter).map(a => String(a.athlete?.id || "")).filter(Boolean);
                    if (starterIds.length > 0) {
                      _starterConfirmedTeams.push(abbr);
                      _starterByTeam[abbr] = starterIds;
                    }
                  }
                }
              } catch {}
            }));
            if (needNbaStatus && CACHE2) await CACHE2.put(`nbaStatus:${todayDateStr}`, JSON.stringify(nbaPlayerStatus), { expirationTtl: 600 }).catch(() => {});
            if (needNbaStarters) {
              nbaStarters = { confirmedTeams: _starterConfirmedTeams, startersByTeam: _starterByTeam };
              if (CACHE2) await CACHE2.put(`nba:starters:${todayDateStr}`, JSON.stringify(nbaStarters), { expirationTtl: 600 }).catch(() => {});
            }
          }
          if (needWnbaStarters) {
            // Mirror the NBA starter detection for WNBA. Boxscore shape is identical at the
            // basketball/wnba/summary endpoint. Same 600s cache TTL.
            const wnbaEvents = sbResults.find(r => r.sport === "wnba")?.events || [];
            const _wStarterConfirmedTeams = [];
            const _wStarterByTeam = {};
            await Promise.all(wnbaEvents.map(async ev => {
              try {
                const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event=${ev.id}`, { headers: { "User-Agent": "Mozilla/5.0" } });
                if (!r.ok) return;
                const d = await r.json();
                for (const tp of d.boxscore?.players || []) {
                  const abbr = normTeam("wnba", tp.team?.abbreviation || "");
                  if (!abbr) continue;
                  const athletes = tp.statistics?.[0]?.athletes || [];
                  const starterIds = athletes.filter(a => a.starter).map(a => String(a.athlete?.id || "")).filter(Boolean);
                  if (starterIds.length > 0) {
                    _wStarterConfirmedTeams.push(abbr);
                    _wStarterByTeam[abbr] = starterIds;
                  }
                }
              } catch {}
            }));
            wnbaStarters = { confirmedTeams: _wStarterConfirmedTeams, startersByTeam: _wStarterByTeam };
            if (CACHE2) await CACHE2.put(`wnba:starters:${todayDateStr}`, JSON.stringify(wnbaStarters), { expirationTtl: 600 }).catch(() => {});
          }
        }
        nbaPlayerStatus = nbaPlayerStatus || {};
        // sportByteam.{nba,wnba}Starters are the single sources the dataConfidence helper reads.
        // Always assign — populated either by the summary fetch block above (cache miss path)
        // or by the parallel cache load at the top of this section (warm path).
        sportByteam.nbaStarters = nbaStarters || { confirmedTeams: [], startersByTeam: {} };
        sportByteam.wnbaStarters = wnbaStarters || { confirmedTeams: [], startersByTeam: {} };
        // Fetch NHL game scores if nhl byteam was loaded from cache (scoreboard not fetched above)
        if (sportsNeeded.has("nhl") && !sportByteam.nhlGameScores) {
          const _nd3a = new Date(Date.now() - 7 * 3600 * 1000); const _nd3b = new Date(_nd3a); _nd3b.setDate(_nd3b.getDate() + 1);
          const _ns3fmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
          const _nh3 = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
          const [_nhlFbSb0, _nhlFbSb1] = await Promise.all([
            fetch(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${_ns3fmt(_nd3a)}`, { headers: _nh3 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch(`https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${_ns3fmt(_nd3b)}`, { headers: _nh3 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
          ]);
          const _nhlFbAll = [...(_nhlFbSb0.events || []), ...(_nhlFbSb1.events || [])];
          if (!sportByteam.nhlGameScores) sportByteam.nhlGameScores = parseGameScores(_nhlFbAll, a => normTeam("nhl", a));
        }
        // Fetch WNBA game scores if wnba byteam was loaded from cache (scoreboard not fetched above)
        if (sportsNeeded.has("wnba") && !sportByteam.wnbaGameScores) {
          const _wd2a = new Date(Date.now() - 7 * 3600 * 1000); const _wd2b = new Date(_wd2a); _wd2b.setDate(_wd2b.getDate() + 1);
          const _ws2fmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
          const _wh2 = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
          const [_wnbaFbSb0, _wnbaFbSb1] = await Promise.all([
            fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${_ws2fmt(_wd2a)}`, { headers: _wh2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${_ws2fmt(_wd2b)}`, { headers: _wh2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
          ]);
          const _wnbaFbAll = [...(_wnbaFbSb0.events || []), ...(_wnbaFbSb1.events || [])];
          if (!sportByteam.wnbaGameScores) sportByteam.wnbaGameScores = parseGameScores(_wnbaFbAll, a => normTeam("wnba", a));
        }
        // Fetch NBA game scores if nba byteam was loaded from cache (scoreboard not fetched above)
        if (sportsNeeded.has("nba") && !sportByteam.nbaGameScores) {
          const _nd2a = new Date(Date.now() - 7 * 3600 * 1000); const _nd2b = new Date(_nd2a); _nd2b.setDate(_nd2b.getDate() + 1);
          const _ns2fmt = (d) => d.toISOString().slice(0,10).replace(/-/g,'');
          const _nh2 = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
          const [_nbaFbSb0, _nbaFbSb1] = await Promise.all([
            fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_ns2fmt(_nd2a)}`, { headers: _nh2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${_ns2fmt(_nd2b)}`, { headers: _nh2 }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
          ]);
          const _nbaFbAll = [...(_nbaFbSb0.events || []), ...(_nbaFbSb1.events || [])];
          if (!sportByteam.nbaGameScores) sportByteam.nbaGameScores = parseGameScores(_nbaFbAll, a => normTeam("nba", a));
        }
        await _fdMark("afterScoreboards");
        // Model-free capture (2026-08-04, teardown slice 4): emit every captured prop market — the
        // full curve. The STAT_SOFT soft-matchup maps, the NBA/WNBA DVP/pace + MLB barrel caches, and
        // the player-data preFilter loop were all model-only and are gone (there is no model to skip
        // data-less markets for). loopMarkets is just the parsed qualifying markets.
        const loopMarkets = qualifyingMarkets;
        const isDebug = isDebugMode || params.get("debug") === "true";
        // ── Player prop plays — all sports (model-free capture) ──────────────────────────
        // api/lib/tonight/props.js. Consumes only the parsed markets + gameTimes; all model
        // hydration (gamelogs, player info, DVP/pace/usage/injury maps) was deleted 2026-08-04.
        const { plays, dropped, nbaDropped } = await emitPropPlays({ loopMarkets, gameTimes, isDebug });
        // Filter out plays from old dates (yesterday cutoff handles UTC/local differences
        // for late games: a 9:40pm ET game = 1:40am UTC next day).
        const cutoffStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        // ── Game Total + Team Total plays — all sports ───────────────────────────────────
        // Extracted to api/lib/tonight/game-totals.js (Phase B5, 2026-05-29).
        const { _mlbMlContext, _nbaMlContext, _wnbaMlContext, _nhlMlContext, _nflMlContext } =
          await emitGameTotalPlays({
            plays, dropped, isDebug, cutoffStr, gameTimes,
            totalMarkets, teamTotalMarkets,
            mlbBothTeamsConfirmed: _mlbBothTeamsConfirmed,
            sportByteam,
          });
        // ── ML / Spread / F5 / Halves emission — all sports ──────────────────────────────
        // Extracted to api/lib/tonight/ml-spread.js (Phase B, 2026-05-29).
        await emitAllMlAndSpread({
          plays, dropped, isDebug, cutoffStr, gameTimes, _todayPT,
          CACHE2, isBustCache,
          _mlbMlContext, _nbaMlContext, _wnbaMlContext, _nhlMlContext, _nflMlContext,
          spreadMarkets, totalMarkets,
          mlbBothTeamsConfirmed: _mlbBothTeamsConfirmed,
          reattrMlbGameDate: _reattrMlbGameDate,
        });
        // ── Tennis match-winner (ATP/WTA) — Phase 1, shadow-only ─────────────────────────
        // Emits into a separate tennisPlays array (NOT `plays`) so tennis rows bypass the prop
        // dedup, gameTime filter, and frontend card builder. Merged into shadow:staging only.
        const tennisPlays = [];
        await emitTennisMatchPlays({
          tennisMatchMarkets, tennisPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Fighting (UFC rounds O/U) — Phase 1, shadow-only. Like tennis/soccer, emits into its
        // own array (NOT `plays`) so fight rows bypass dedup/gameTime-filter/card-builder; merged
        // into shadow:staging only. One weight-class finish-rate CDF per bout feeds all thresholds.
        const fightPlays = [];
        await emitFightPlays({
          fightMarkets, fightPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── NASCAR (Cup H2H + Top-10) — Phase 1, shadow-only. Like tennis/golf, emits into its own
        // array (NOT `plays`) so NASCAR rows bypass dedup/gameTime-filter/card-builder; merged into
        // shadow:staging only. Recent-form finishing-position model, favorite side. Cup-only.
        const nascarPlays = [];
        await emitNascarPlays({
          nascarMarkets, nascarPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── LMB (Mexican League) game winner — Phase 1, shadow-only. Same dedicated-array idiom;
        // merged into shadow:staging only. Standings run-rate λ pair → NegBin joint, both sides.
        const lmbPlays = [];
        await emitLmbPlays({
          lmbMarkets, lmbPlays, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Golf PGA H2H — model-free maker (KXPGAH2H). Both YES and NO sides captured per
        // market; gameTime from ESPN PGA scoreboard round date. Merged into shadow:staging only.
        const golfPlays = [];
        await emitGolfModelFreePlays({
          markets: golfH2hMarkets, plays: golfPlays, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Dota 2 (KXDOTA2GAME) match-winner — model-free maker. YES-side only; gameTime from
        // ticker (no external fetch). Merged into shadow:staging only.
        const dota2Plays = [];
        emitDota2ModelFreePlays({ markets: dota2Markets, plays: dota2Plays, cutoffStr });
        // ── Ticker-parsed model-free ML (no ESPN feed) — one shared emitter, two leagues.
        // K League 1 (KXKLEAGUEGAME): 3-way home/away/tie, gameTime=null (ticker is date-only).
        // KBO (KXKBOGAME, 2026-08-10): 2-way, gameTime REAL (ticker carries HHMM).
        const kleaguePlays = [];
        emitTickerMlModelFreePlays({ markets: kleagueMarkets, plays: kleaguePlays, cutoffStr, sport: "kleague" });
        const kboPlays = [];
        emitTickerMlModelFreePlays({ markets: kboMarkets, plays: kboPlays, cutoffStr, sport: "kbo" });
        // ── UFC/Boxing (KXUFCFIGHT + KXBOXING) match-winner — model-free maker. YES-side only;
        // gameTime from close_time (per-bout). Merged into shadow:staging only.
        const fightMlPlays = [];
        emitFightMlModelFreePlays({ markets: fightMlMarkets, plays: fightMlPlays, cutoffStr });
        // ── Model-free soccer game winners (MLS, Brasileirão, NWSL, Chinese Super League,
        // Liga MX, Argentina Liga Profesional) — Phase 1, no probability model at all; see
        // project_maker_modelfree_clubsoccer_2026_07_23. One loop over MODEL_FREE_LEAGUES
        // replaces six near-identical emit calls (2026-07-28). Per-league play buckets are kept
        // (each league's rows carry their own sport tag and resolve off their own ESPN endpoint)
        // and merged into shadow:staging only. Real gameTime fetched from ESPN per league.
        const modelFreePlays = {};
        for (const _lg of MODEL_FREE_LEAGUE_KEYS) {
          const _mkts = modelFreeMarkets[_lg];
          if (!_mkts || !_mkts.length) { modelFreePlays[_lg] = []; continue; }
          const _out = [];
          await emitModelFreeMlPlays({
            league: _lg, markets: _mkts, plays: _out, cutoffStr,
            cache: CACHE2, isBustCache,
          });
          modelFreePlays[_lg] = _out;
        }
        // Flat list for the staging merge; the per-league buckets stay addressable for ?debug=1.
        const modelFreeAllPlays = MODEL_FREE_LEAGUE_KEYS.flatMap(k => modelFreePlays[k] || []);
        // ── MLS/Liga MX 1H spread/total/BTTS + full-game team-total — Phase 1, model-free,
        // threshold shape, one shared array+module for both leagues (see
        // project_mls_ligamx_threshold_2026_07_23 memory). Merged into shadow:staging only.
        const clubSoccerThresholdPlays = [];
        await emitClubSoccerThresholdPlays({
          clubSoccerThresholdMarkets, clubSoccerThresholdPlays, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── Scottish League Cup spread + total — Phase 1, model-free, threshold shape (first
        // maker module of this shape — see project_scocup_spread_total_2026_07_23 memory). Same
        // dedicated-array idiom; merged into shadow:staging only. Real gameTime fetched from
        // ESPN sco.cis (api/lib/scocup.js) — despite the "SCOCUP" ticker prefix, the real
        // competition is the Scottish LEAGUE Cup, not the Scottish Cup proper (verified live).
        const scocupPlays = [];
        await emitScoCupPlays({
          scocupSpreadMarkets, scocupTotalMarkets, scocupPlays, dropped, isDebug, cutoffStr,
          cache: CACHE2, isBustCache,
        });
        // ── MLB pitcher outs-recorded (KXMLBOUTS) — Phase 1, shadow-only. Prop-shaped rows in a
        // dedicated array (NOT `plays`) so they bypass dedup/gameTime-filter/card-builder; merged
        // into shadow:staging only. Normal workload model off pitcherStatsByName, favorite side.
        const outsPlays = [];
        emitMlbOutsPlays({ outsMarkets, outsPlays, dropped, isDebug, cutoffStr, sportByteam, gameTimes });
        // Drop plays whose scheduled gameTime has already passed — pre-game market is closed,
        // and our model truePct is built on pre-game inputs so it's no longer valid in-game.
        // Plays without gameTime are kept (we already gate by gameDate earlier).
        {
          const _nowMs = Date.now();
          plays.splice(0, plays.length, ...plays.filter(p => {
            if (!p.gameTime) return true;
            const t = new Date(p.gameTime).getTime();
            return isNaN(t) || t > _nowMs;
          }));
        }
        // Alt-line dedup removed with the model teardown (2026-08-04): capture-all-sides means
        // every alt threshold/line + both sides are their own model-free rows, so there is no
        // "best edge" to keep or demote. (Was api/lib/tonight/dedup.js — deleted.)
        // Mark plays whose source kalshi series fell back to per-ticker stale (or prior-bundle
        // preservation) this request. Single pass keeps the per-play push sites untouched.
        if (_staleKalshiSet.size) {
          for (const p of plays) {
            const ticker = _findKalshiTicker(p.sport, p.stat, p.gameType);
            if (ticker && _staleKalshiSet.has(ticker)) p._kalshiStale = true;
          }
        }
        // ── seasonType stamping (added 2026-05-26) — ESPN convention: 2=RS, 3=postseason.
        // Pulled from gameScores. Lets /api/auth/calibration bucket plays by seasonType
        // without changing emission sites. Single lookup table keyed by `sport|home|gameDate`
        // (lowest-cost denominator that's stable across pipelines — gameTime varies between
        // play-emission and the ESPN event ISO with seconds precision differences).
        {
          const _seasonTypeMap = {};
          const _addSrc = (sport, gsObj) => {
            for (const v of Object.values(gsObj || {})) {
              if (v?.homeTeam && v?.gameDate && v?.seasonType != null) {
                _seasonTypeMap[`${sport}|${v.homeTeam}|${v.gameDate}`] = v.seasonType;
              }
            }
          };
          _addSrc("mlb", sportByteam.mlb?.gameScores);
          _addSrc("nba", sportByteam.nbaGameScores);
          _addSrc("wnba", sportByteam.wnbaGameScores);
          _addSrc("nhl", sportByteam.nhlGameScores);
          const _stampSeasonType = (p) => {
            const home = p.homeTeam || p.scoringTeam || p.playerTeam;
            const st = _seasonTypeMap[`${p.sport}|${home}|${p.gameDate || ""}`];
            if (st != null) p.seasonType = st;
          };
          for (const p of plays) _stampSeasonType(p);
          for (const p of dropped) _stampSeasonType(p);
        }
        // ── dataConfidence (0-10) — penalty-based score starting at 10, subtracting for input-data
        // issues. Strict by design: only plays with zero or one minor issue reach the gate. NOT
        // YET an active filter — `dcQualified` is computed and emitted but the v1 frontend still
        // ignores it. The v2 model toggle (Phase B) is where this becomes the gate.
        //
        // Spec + full penalty table live in api/lib/tonight/dc.js. Must run AFTER the
        // _kalshiStale propagation above and BEFORE the isDebug return below so debug-mode plays
        // carry the field too.
        for (const _p of plays) {
          const dc = computeDataConfidence(_p, { sportByteam });
          _p.dataConfidence = dc.dataConfidence;
          _p.dcPenalties = dc.dcPenalties;
          _p.dcQualified = dc.dcQualified;
          _p.dcGate = dc.dcGate;
        }
        // Also compute DC for `dropped` plays so the debug Market Report shows DC columns for
        // every row (otherwise pre-DC drops like edge_too_low / no_simulation_data render DC=—).
        for (const _p of dropped) {
          const dc = computeDataConfidence(_p, { sportByteam });
          _p.dataConfidence = dc.dataConfidence;
          _p.dcPenalties = dc.dcPenalties;
          _p.dcQualified = dc.dcQualified;
          _p.dcGate = dc.dcGate;
        }
        // ── Polymarket cross-venue price deltas — Phase 1a observatory (shadow-only). Fetches
        // Polymarket game prices (Gamma, public/no-auth) for the leagues we model and compares them
        // to our Kalshi prices in plays/dropped. Runs after the gameTime splice + DC loops so the
        // rows are final. Merged into shadow:staging + ?debug only; NEVER the client response.
        // Failure-closed: a Polymarket outage must not affect the main response.
        const polymarketDeltas = [];
        let polymarketDeltaSummary = null;
        try {
          // Don't bust the poly cache — `?bust=1` is for refreshing Kalshi/model data, and a cold
          // poly fetch under heavy bust load is flaky (starved → empty). The 120s cache is fine for
          // a shadow observatory; decoupling keeps deltas reliable on bust runs + the cron.
          const _polyGames = await fetchPolymarketGames({ cache: CACHE2 });
          polymarketDeltaSummary = emitPolymarketDeltas({ polyGames: _polyGames, plays, dropped, deltas: polymarketDeltas });
          // Sharpen the kill-gate: walk the Poly CLOB book for the bettable [67,91] sides so the
          // delta is EXECUTABLE (real VWAP after slippage), not just mid-price. Bounded + failure-
          // closed — leaves the mid delta intact on any book miss.
          const _tokensByGame = {};
          for (const g of _polyGames) if (g.mlTokens) _tokensByGame[`${g.sport}|${g.away}@${g.home}`] = g.mlTokens;
          await enrichDeltasWithExec({ deltas: polymarketDeltas, tokensByGame: _tokensByGame });
        } catch (e) { console.error("[tonight] polymarket deltas failed:", e?.message); }

        // ── Sportsbook-reference deltas — Phase 1a observatory (shadow-only). De-vigs the sharp
        // book (Pinnacle via The Odds API) and compares its fair ML prob to our Kalshi price. The
        // kill-gate: does Kalshi LAG the sharp book (a timeable edge)? deltaCents = bookFairPct −
        // kalshiPct (+ = Kalshi cheap = edge to BUY). Fetches ONLY the sports present in tonight's
        // Kalshi ML set (credit-conserving). Merged into shadow:staging + ?debug only; never the
        // client. Failure-closed: no key / book outage → []. Requires env.THE_ODDS_API_KEY.
        const sportsbookDeltas = [];
        let sportsbookDeltaSummary = null;
        try {
          const _bookSports = [...new Set([...plays, ...dropped].filter(r => r?.gameType === "ml" && r?.sport).map(r => r.sport))];
          const _bookGames = await fetchSportsbookGames({ cache: CACHE2, apiKey: env?.THE_ODDS_API_KEY, sports: _bookSports });
          sportsbookDeltaSummary = emitSportsbookDeltas({ bookGames: _bookGames, plays, dropped, deltas: sportsbookDeltas });
        } catch (e) { console.error("[tonight] sportsbook deltas failed:", e?.message); }
        // Stage plays for shadow-snapshot — eliminates the 55s internal re-fetch.
        // `schedule` = today's ESPN game count per sport, so shadow-snapshot can compare
        // distinct games in the logged rows against the actual slate (coverage check).
        // gameScores keys are `${home}|${gameDate}|${eventISO}` with today+tomorrow merged,
        // so filter on the gameDate segment.
        if (CACHE2) {
          const _schedCounts = {};
          const _schedSources = {
            mlb: sportByteam.mlb?.gameScores,
            nba: sportByteam.nbaGameScores,
            wnba: sportByteam.wnbaGameScores,
            nhl: sportByteam.nhlGameScores,
          };
          for (const [_sp, _gs] of Object.entries(_schedSources)) {
            if (!_gs) continue;
            const _n = Object.keys(_gs).filter(k => k.split("|")[1] === _todayPT).length;
            if (_n > 0) _schedCounts[_sp] = _n;
          }
          // Tennis plays live in their own array (kept out of `plays` to bypass dedup/frontend);
          // merge them into the staging `plays` so shadow-snapshot logs them like any other play.
          CACHE2.put(`shadow:staging:${_todayPT}`, JSON.stringify({ plays: [...plays, ...tennisPlays, ...fightPlays, ...nascarPlays, ...lmbPlays, ...golfPlays, ...dota2Plays, ...kleaguePlays, ...kboPlays, ...fightMlPlays, ...modelFreeAllPlays, ...clubSoccerThresholdPlays, ...scocupPlays, ...outsPlays], dropped, schedule: _schedCounts, polymarketDeltas, polymarketDeltaSummary, sportsbookDeltas, sportsbookDeltaSummary, writtenAt: Date.now() }), { expirationTtl: 21600 }).catch(() => {});
        }
        if (isDebug) {
          const sf = reportSportFilter;
          const debugPlays = sf ? plays.filter(m => m.sport === sf) : plays;
          const debugDropped = sf ? dropped.filter(m => m.sport === sf) : dropped;
          // gameTime tripwire (2026-08-10). A row with gameTime:null still logs and still grades,
          // but is silently never maker-quotable — the defect that left nine Phase-1 modules
          // useless, that makes CANPL unbuildable, and that scocup is sitting in right now because
          // ESPN has not published the League Cup's Round-2 fixtures (see api/lib/scocup.js).
          // Every one of those was found by accident. This counts it per sport across EVERY emitted
          // array, so "an upstream schedule went quiet" is a number you can look at instead of a
          // discovery. Counts only — nothing is gated on it, and a league whose ticker is date-only
          // by design (kleague) is expected to sit at 100%, so read it as a DELTA over time.
          const _gtNull = {};
          for (const _arr of [plays, tennisPlays, fightPlays, nascarPlays, lmbPlays, golfPlays,
                              dota2Plays, kleaguePlays, kboPlays, fightMlPlays, modelFreeAllPlays,
                              clubSoccerThresholdPlays, scocupPlays, outsPlays]) {
            for (const p of _arr || []) {
              const s = p?.sport; if (!s) continue;
              const e = (_gtNull[s] ??= { rows: 0, nullGameTime: 0 });
              e.rows++; if (p.gameTime == null) e.nullGameTime++;
            }
          }
          const gameTimeNullBySport = Object.fromEntries(
            Object.entries(_gtNull).filter(([, v]) => v.nullGameTime > 0)
              .map(([s, v]) => [s, { ...v, pct: Math.round(v.nullGameTime / v.rows * 100) }])
              .sort((a, b) => b[1].nullGameTime - a[1].nullGameTime)
          );
          const _kalshiSnapDebug = {
            usedSnaps: kalshiUsedSnaps,
            meta: kalshiSnapMeta,
            ageMs: kalshiSnapMeta?.lastRunAt ? Date.now() - kalshiSnapMeta.lastRunAt : null,
          };
          return jsonResponse({ fdProbe: { milestones: _fdMilestones, atEnd: await _fdProbe() }, plays: debugPlays, dropped: debugDropped, tennisPlays, tennisMarketCount: tennisMatchMarkets.length, fightPlays, fightMarketCount: fightMarkets.length, nascarPlays, nascarMarketCount: nascarMarkets.length, lmbPlays, lmbMarketCount: lmbMarkets.length, golfPlays, golfMarketCount: golfH2hMarkets.length, dota2Plays, dota2MarketCount: dota2Markets.length, kleaguePlays, kleagueMarketCount: kleagueMarkets.length, kboPlays, kboMarketCount: kboMarkets.length, fightMlPlays, fightMlMarketCount: fightMlMarkets.length, clubSoccerPlays: modelFreePlays.mls, clubSoccerMarketCount: (modelFreeMarkets.mls || []).length, brasileiraoPlays: modelFreePlays.brasileirao, brasileiraoMarketCount: (modelFreeMarkets.brasileirao || []).length, nwslPlays: modelFreePlays.nwsl, nwslMarketCount: (modelFreeMarkets.nwsl || []).length, chnslPlays: modelFreePlays.chnsl, chnslMarketCount: (modelFreeMarkets.chnsl || []).length, ligamxPlays: modelFreePlays.ligamx, ligamxMarketCount: (modelFreeMarkets.ligamx || []).length, argPremPlays: modelFreePlays.argprem, argPremMarketCount: (modelFreeMarkets.argprem || []).length, modelFreePlays, modelFreeMarketCounts: Object.fromEntries(MODEL_FREE_LEAGUE_KEYS.map(k => [k, (modelFreeMarkets[k] || []).length])), modelFreePlayCounts: Object.fromEntries(MODEL_FREE_LEAGUE_KEYS.map(k => [k, (modelFreePlays[k] || []).length])), clubSoccerThresholdPlays, clubSoccerThresholdMarketCount: clubSoccerThresholdMarkets.length, scocupPlays, scocupSpreadMarketCount: scocupSpreadMarkets.length, scocupTotalMarketCount: scocupTotalMarkets.length, outsPlays, outsMarketCount: outsMarkets.length, polymarketDeltas, polymarketDeltaSummary, sportsbookDeltas, sportsbookDeltaSummary, staleKalshiSeries, kalshiSnap: _kalshiSnapDebug, gameTimeNullBySport, qualifyingCount: qualifyingMarkets.length, totalMarketsCount: totalMarkets.length }, true);
        }
        // mlbMeta/nbaMeta/wnbaMeta/nhlMeta were deleted 2026-08-04 (Tier 3b) — the frontend no
        // longer fetches this response (shadow reads KV staging / the ?debug path, both of which
        // consume only plays/dropped), so the model-era matchup meta had no consumer.
        const playsResult = { plays, nbaDropped, staleKalshiSeries, qualifyingCount: qualifyingMarkets.length };
        const sportsInPlays = new Set(plays.map((p) => p.sport));
        if (CACHE2 && sportsInPlays.size >= 2) {
          const summary = {
            date: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
            count: plays.length,
            sports: plays.reduce((acc, p) => {
              acc[p.sport] = (acc[p.sport] || 0) + 1;
              return acc;
            }, {}),
            avgEdge: plays.length ? parseFloat((plays.reduce((s, p) => s + (p.edge || 0), 0) / plays.length).toFixed(1)) : 0,
            avgTruePct: plays.length ? parseFloat((plays.reduce((s, p) => s + (p.truePct || 0), 0) / plays.length).toFixed(1)) : 0
          };
          await CACHE2.put(`plays:daily:${summary.date}`, JSON.stringify(summary), { expirationTtl: 7776e3 }).catch(() => {
          });
        }
        // Edge SWR: the snap-first assembly is ~7s, so serve a CDN-cached copy fresh for 2 min
        // (matching the snap cron + client poll cadence, so the displayed set is no staler than
        // the 2-min poll already allowed), then serve the instant stale copy for up to 24h while
        // revalidating in the background. The long SWR window matters for the solo-user cold-open
        // case: opening the app after hours idle still gets an instant response (a possibly-stale
        // play SET that self-heals on the next 2-min poll) instead of paying the 7s on a fully
        // evicted edge cache. Display-price staleness is harmless since the order modal walks the
        // live book at placement (2026-06-15). `?bust=1` (manual ↻) and debug stay no-store so
        // neither serves nor populates the shared cache.
        return jsonResponse(playsResult, isBustCache ? true : "public, s-maxage=120, stale-while-revalidate=86400");
}
