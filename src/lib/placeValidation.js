import { EDGE_GATE_CLIENT as EDGE_GATE } from '../../api/lib/config.js';

const SLIPPAGE_WARN_CENTS = 3; // paying ≥3¢ over top-of-book → warn

// A market we can't trust enough to act on yet: untraded (vol 0 → a big edge is likely a
// stale-quote artifact and the fill is uncertain) or thin (low volume / wide). Single source of
// truth for both the Place All `risk` tier AND the notification gate (useTonight.js) — a play is
// pinged only once its market clears this, matching Place All's default-checked state.
export function isMarketUntrusted(play) {
  return play.kalshiVolume === 0 || play.lowVolume === true || play.thinMarket === true;
}

// Validate one Place All candidate. `sizing` is the { price, count, cost, side, ao } object from
// _placeAllSizing. `liveFill` (optional) is the result of walking the LIVE orderbook for the
// suggested count — { vwapCents, filledCount, exhausted, slipCents } — used by the order modals to
// replace the blunt traded-volume heuristic with a real fill-quality check (vol 0 ≠ illiquid: a
// market can have zero trades yet a deep resting book). When absent (loading / fetch failed / no
// ticker) we fall back to the conservative cached check, so we are never *less* safe than before.
// Returns { hard: string[], soft: string[], risk: string[], info: string[] }.
//   hard → not placeable (blocked).  soft → warn, stays checked.
//   risk → placeable but auto-UNCHECKED in Place All so it can't be bet by accident.
//   info → neutral confirmation (e.g. live liquidity verified on a 0-trade market).
export function validateCandidate(play, sizing, liveFill = null) {
  const hard = [], soft = [], risk = [], info = [];

  // ── HARD: re-assert qualification against the freshest tonightPlays data (catches slate drift
  // since the modal opened — a pick can fall out of qualification between open and confirm). ──
  if (play.dcQualified !== true) hard.push('no longer dc-qualified (stale market or player out)');
  if ((play.edge ?? 0) < EDGE_GATE) hard.push(`edge ${play.edge ?? '—'}% under ${EDGE_GATE}% gate`);

  // ── HARD: structural placeability ──
  if (!play.kalshiTicker) hard.push('no Kalshi ticker');
  if (!sizing || sizing.count < 1) hard.push('size rounds to 0 contracts');
  else if (sizing.price <= 0 || sizing.price >= 100) hard.push('price out of range');

  // ── HARD: distinct, present matchup (game plays only) ──
  if (play.gameType) {
    const t1 = play.gameType === 'teamTotal' ? play.scoringTeam : play.homeTeam;
    const t2 = play.gameType === 'teamTotal' ? play.oppTeam : play.awayTeam;
    if (t1 && t2 && t1 === t2) hard.push('matchup resolves to one team');
  }

  // ── SOFT: slippage (#4) — how far the depth-blended fill sits above top-of-book. Exact when the
  // pre-blend raw price is present (totals/teamTotal/spread/props); ML omits it and falls back to
  // the bid-ask spread / low-volume proxy. Side-aware. ──
  const side = play.kalshiSide;
  const blended = side === 'no' ? play.noKalshiPct : play.kalshiPct;
  const raw = side === 'no' ? play.rawNoKalshiPct : play.rawKalshiPct;
  if (raw != null && blended != null) {
    const slip = Math.round(blended - raw);
    if (slip >= SLIPPAGE_WARN_CENTS) soft.push(`slippage: paying ~${slip}¢ over top-of-book`);
  } else if ((play.kalshiSpread ?? 0) > 8) {
    soft.push('wide bid-ask — fill may slip');
  }

  // ── Liquidity / untested-market check. When a LIVE orderbook walk is available it decides from
  // the real fill of our suggested size (volume 0 ≠ illiquid — the book can be deep). Otherwise we
  // fall back to the cached traded-volume / spread heuristic (conservative; auto-unchecks). ──
  const cnt = sizing?.count ?? 0;
  if (liveFill) {
    if (liveFill.exhausted) {
      // Book can't fill the full size near the quote — partial fill / size-down. Auto-unchecked.
      risk.push(`only ${liveFill.filledCount} of ${cnt} contracts available near quote — size down or expect a partial fill`);
    } else if (liveFill.slipCents >= SLIPPAGE_WARN_CENTS) {
      soft.push(`filling ${cnt} would avg ~${liveFill.vwapCents}¢ (${liveFill.slipCents}¢ over top-of-book)`);
    } else if (play.kalshiVolume === 0) {
      // Clean fill on a market with no trades yet — confirm we verified it, don't silently drop.
      info.push(`fills ${cnt} @ ~${liveFill.vwapCents}¢ from resting book (0 trades — verified live)`);
    }
  } else if (isMarketUntrusted(play)) {
    // No live walk — cached heuristic. A large edge against an untested price may be a stale quote.
    const spr = play.kalshiSpread;
    if (play.kalshiVolume === 0) {
      if (spr != null && spr <= 2) {
        risk.push(`no trades yet — actively quoted (${spr}¢ spread); likely fillable, but verify orderbook depth as quotes can be pulled`);
      } else {
        risk.push(`no trades${spr != null ? ` and ${spr}¢-wide quote` : ''} — likely illiquid; fill uncertain`);
      }
    } else if (play.lowVolume === true) {
      risk.push(`thin market (only ${play.kalshiVolume} traded) — edge less reliable and fill may slip`);
    } else {
      risk.push('thin market — edge less reliable and fill may slip');
    }
  }

  // ── SOFT: lineup not yet confirmed (player props) — the opposing lineup drives contact/K props.
  // Warn only (stays checked): a confirmed starter can be liquid + high-dc while its opponent's
  // card is still pending, so this shouldn't bench the play on its own. ──
  if (play.playerName && play.lineupConfirmed === false) soft.push('lineup not confirmed yet');

  return { hard, soft, risk, info };
}
