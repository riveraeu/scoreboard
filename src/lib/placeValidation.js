import { EDGE_GATE_CLIENT as EDGE_GATE } from '../../api/lib/config.js';

const SLIPPAGE_WARN_CENTS = 3; // paying ≥3¢ over top-of-book → warn

// Validate one Place All candidate. `sizing` is the { price, count, cost, side, ao } object from
// _placeAllSizing. Returns { hard: string[], soft: string[] }.
export function validateCandidate(play, sizing) {
  const hard = [], soft = [];

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
  } else if ((play.kalshiSpread ?? 0) > 8 || play.lowVolume === true) {
    soft.push('thin/wide market — fill may slip');
  }

  return { hard, soft };
}
