import { EDGE_GATE_CLIENT as EDGE_GATE } from '../../api/lib/config.js';

const SLIPPAGE_WARN_CENTS = 3; // paying ≥3¢ over top-of-book → warn

// Validate one Place All candidate. `sizing` is the { price, count, cost, side, ao } object from
// _placeAllSizing. Returns { hard: string[], soft: string[], risk: string[] }.
//   hard → not placeable (blocked).  soft → warn, stays checked.
//   risk → placeable but auto-UNCHECKED in Place All so it can't be bet by accident.
export function validateCandidate(play, sizing) {
  const hard = [], soft = [], risk = [];

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

  // ── RISK: illiquid / untested market — auto-unchecked in Place All. A large edge against an
  // untraded price is usually a stale-quote artifact, not alpha, and the fill is uncertain.
  // Independent of the slippage branch above so it fires for every play type, not just ML. ──
  if (play.kalshiVolume === 0) {
    risk.push('no market volume — price untested; edge may be a stale-quote artifact and fill is uncertain');
  } else if (play.lowVolume === true || play.thinMarket === true) {
    risk.push('thin market (low volume) — edge less reliable and fill may slip');
  }

  // ── SOFT: lineup not yet confirmed (player props) — the opposing lineup drives contact/K props.
  // Warn only (stays checked): a confirmed starter can be liquid + high-dc while its opponent's
  // card is still pending, so this shouldn't bench the play on its own. ──
  if (play.playerName && play.lineupConfirmed === false) soft.push('lineup not confirmed yet');

  return { hard, soft, risk };
}
