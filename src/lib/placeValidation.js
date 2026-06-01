import { EDGE_GATE_CLIENT as EDGE_GATE } from '../../api/lib/config.js';

// Pre-flight validation for the "Place All" batch (Flow A). Each candidate runs through
// deterministic guards + a live calibration lookup BEFORE its Kalshi order is placed.
//   - HARD failures exclude the pick from the batch (shown ✗, not placed).
//   - SOFT failures annotate the pick (shown ⚠) but it still places.
// This is a guardrail, not a verdict — it re-asserts qualification against the freshest data and
// flags fragile/known-overconfident picks. Deep per-pick judgment (Flow B, an LLM auditor) layers
// on later. See CLAUDE.md "Place All" + the Flow A design discussion.

// Calibration buckets — MIRROR `_buckets` in api/lib/handlers/auth.js. Keep in sync if either
// moves. Buckets start at 70, so UNDER candidates (stored over-side `truePct` < 70) fall outside
// every bucket and skip the calibration check — which is correct, because the calibration store
// buckets uniformly by the over-side `truePct` (see trackPlay in usePicks.js), so its
// byCategoryDetail is a clean over/yes-side measure and can't soundly score an UNDER's bet side.
const CALIB_BUCKETS = [
  { label: '70-75', min: 70, max: 75 },
  { label: '75-80', min: 75, max: 80 },
  { label: '80-85', min: 80, max: 85 },
  { label: '85-90', min: 85, max: 90 },
  { label: '90-95', min: 90, max: 95 },
  { label: '95+',   min: 95, max: 101 },
];

// Tunable gating thresholds. `delta` = actual win% − predicted bucket midpoint (negative = the
// model ran hot / overconfident in that band).
const CALIB_BLOCK_DELTA = -10, CALIB_BLOCK_N = 30; // strong, well-sampled overconfidence → block
const CALIB_WARN_DELTA  = -5,  CALIB_WARN_N  = 10; // milder overconfidence → warn
const SLIPPAGE_WARN_CENTS = 3;                     // paying ≥3¢ over top-of-book → warn

// Live calibration entry for a play's bet-side truePct bucket, or null. `truePct` is the field
// the calibration store keys on (over/yes side); UNDER candidates (truePct < 70) return null.
function calibEntryFor(play, calibData) {
  if (!calibData || calibData.error || !calibData.byCategoryDetail) return null;
  const tp = play.truePct;
  if (tp == null) return null;
  const b = CALIB_BUCKETS.find(bk => tp >= bk.min && tp < bk.max);
  if (!b) return null; // < 70 (e.g. unders) or out of range
  const arr = calibData.byCategoryDetail[`${play.sport || '?'}|${play.stat || '?'}`];
  return arr ? (arr.find(e => e.bucket === b.label) || null) : null;
}

// Validate one Place All candidate. `sizing` is the { price, count, cost, side, ao } object from
// _placeAllSizing. `calibData` is the /api/auth/calibration payload (may be null while loading —
// the calibration check is simply skipped). Returns { hard: string[], soft: string[] }.
export function validateCandidate(play, sizing, calibData) {
  const hard = [], soft = [];

  // ── HARD: re-assert qualification against the freshest tonightPlays data (catches slate drift
  // since the modal opened — a pick can fall out of qualification between open and confirm). ──
  if ((play.dataConfidence ?? 0) !== 10) hard.push('data confidence dropped below 10');
  if (play.dcQualified !== true) hard.push('no longer dc-qualified');
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

  // ── HARD: calibration overconfidence (#1) — strong, well-sampled negative delta in the bet's
  // truePct band. Non-UNDER only (see calibEntryFor). ──
  const ce = calibEntryFor(play, calibData);
  if (ce && ce.delta != null && ce.n != null) {
    if (ce.delta <= CALIB_BLOCK_DELTA && ce.n >= CALIB_BLOCK_N) {
      hard.push(`calibration: ${play.sport}|${play.stat} ${ce.bucket}% band runs ${ce.delta} (n=${ce.n})`);
    } else if (ce.delta <= CALIB_WARN_DELTA && ce.n >= CALIB_WARN_N) {
      soft.push(`calibration: ${ce.bucket}% band ${ce.delta} vs predicted (n=${ce.n})`);
    }
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
