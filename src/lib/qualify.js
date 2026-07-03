// src/lib/qualify.js
// Shared client-side qualification predicate + pick identity. Extracted 2026-06-11 from
// App.jsx (_qualifiedFilter) and LineupsPage.jsx (passesGate), which had drifted into
// fix-it-twice territory (the 2026-06-05 spread-dedup fix had to land in both).
//
// The tracked-pick bypass is NOT shared on purpose — the two surfaces diverge:
//   - App plays column: tracked picks still require dcQualified + edge (stale/out picks drop)
//   - LineupsPage matchup cards: tracked picks always show (it's the user's actual bet)
// Each call site applies its own bypass before delegating here.

import { EDGE_GATE_CLIENT as EDGE_GATE } from '../../api/lib/config.js';
import { passesCategoryGate } from './constants.js';

// Core display qualification for an UNTRACKED play:
// dcQualified (dc≥7 — only kalshiStale/playerOut fail since 2026-06-04), edge ≥ 5,
// and the shadow-calibration category gate.
export function qualifiesForDisplay(p) {
  // Prop rows carry an explicit bet-window verdict from props.js (`qualified:false` = out of
  // betWindowFor window, or a non-winning dedup threshold kept for the player card). Under
  // full-curve capture (2026-07-03) the server logs props at ANY price, so display must honor
  // the flag or sub-window longshots with big nominal edge would surface once a category is
  // gated. Scoped to prop-shaped rows (no gameType): game rows use `qualified` differently
  // (ML pushes qualified:false by convention and window-gates at emit).
  if (p.qualified === false && !p.gameType) return false;
  // Demoted by server-side alt-line dedup in favor of a higher-edge alt. Allow through when
  // the winner itself fails the category gate — demotion is spurious if the winner can't
  // qualify (see CLAUDE.md "Spread alt-line dedup + category gate interaction").
  if (p._altLineDemoted === true && !passesCategoryGate(p)) return false;
  if (p.dcQualified !== true || (p.edge ?? 0) < EDGE_GATE) return false;
  return passesCategoryGate(p);
}

// Stable pick identity — mirrors the trackId construction in PlaysColumn / usePicks.trackPlay.
// Moved from LineupsPage.jsx (2026-06-11); shape unchanged.
export function trackIdFor(p) {
  const gd = p.gameDate || '';
  const seg = p.segment && p.segment !== 'full' ? `|${p.segment}` : '';
  if (p.gameType === 'teamTotal') return `teamtotal|${p.sport}|${p.scoringTeam}|${p.oppTeam}|${p.threshold}|${gd}${p.direction === 'under' ? '|under' : ''}`;
  if (p.gameType === 'total') return `total|${p.sport}${seg}|${p.homeTeam}|${p.awayTeam}|${p.threshold}|${gd}${p.direction === 'under' ? '|under' : ''}`;
  if (p.gameType === 'ml') return `ml|${p.sport}${seg}|${p.pickTeam}|${p.homeTeam}|${p.awayTeam}|${gd}`;
  if (p.gameType === 'spread') return `spread|${p.sport}${seg}|${p.pickTeam}|${p.homeTeam}|${p.awayTeam}|${p.pickLine}|${gd}`;
  return `${p.sport || 'nba'}|${p.playerName}|${p.stat}|${p.threshold}|${gd}`;
}
