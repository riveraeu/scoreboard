// simulate.test.fixtures.js — shared test data for simulate.test.js
// The JXA version (simulate.test.jxa.js) inlines the same data since it cannot import modules.

// --- Lineup arrays ---

export const LINEUP_SMALL   = [0.22, 0.25, 0.20];
export const LINEUP_MED     = [0.22, 0.25, 0.20, 0.18, 0.21];
export const LINEUP_9_21    = Array(9).fill(0.21); // Cardinals/Williams-like (K% 21%)
export const LINEUP_9_22    = Array(9).fill(0.22); // backend sweep pitcher (K% 22%)

// --- NBA game values ---

export const NBA_GAME_VALUES = [22, 18, 25, 30, 19, 27, 24, 21, 28, 20]; // 10-game sample

// --- Plays fixtures (factory functions — callers mutate these in-place) ---

export const makeSweepPlays = () => [
  { sport: 'mlb', stat: 'strikeouts', playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 3, truePct: 92.6, qualified: false },
  { sport: 'mlb', stat: 'strikeouts', playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 4, truePct: 76.8, qualified: false }, // was fallback formula
  { sport: 'mlb', stat: 'strikeouts', playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 5, truePct: 97.9, qualified: true  }, // from simulation
];

export const makeAllTonightPlays = () => [
  { playerId: 42, playerName: 'Gavin Williams', stat: 'strikeouts', threshold: 3, truePct: 97.9, simPct: 97.9, qualified: false },
  { playerId: 42, playerName: 'Gavin Williams', stat: 'strikeouts', threshold: 4, truePct: 97.9, simPct: 97.9, qualified: false },
  { playerId: 42, playerName: 'Gavin Williams', stat: 'strikeouts', threshold: 5, truePct: 97.9, simPct: 97.9, qualified: true  },
];

export const makeDedupPlays = () => [
  { playerName: 'Gavin Williams', sport: 'mlb', stat: 'strikeouts', threshold: 3, edge: -0.4,  kalshiPct: 93, truePct: 92.6, qualified: false },
  { playerName: 'Gavin Williams', sport: 'mlb', stat: 'strikeouts', threshold: 4, edge: -16.9, kalshiPct: 87, truePct: 70.1, qualified: false },
  { playerName: 'Gavin Williams', sport: 'mlb', stat: 'strikeouts', threshold: 5, edge:  24.1, kalshiPct: 74, truePct: 98.1, qualified: true  },
];

export const makeBackendSweepPlays = () => [
  { playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 3, kalshiPct: 93, truePct: 92.6, simPct: null,  qualified: false },
  { playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 4, kalshiPct: 87, truePct: 70.1, simPct: null,  qualified: false },
  { playerTeam: 'CLE', gameDate: '2026-04-13', threshold: 5, kalshiPct: 74, truePct: 98.1, simPct: 98.1,  qualified: true  },
];

export const makeRawTruePctMap = () => ({ 3: 92.6, 4: 70.1, 5: 98.1, 6: 44.6, 7: 35.8, 8: 32.8, 9: 15.7, 10: 12.7 });

// --- HRR filter rows ---

export const HRR_ROWS = [
  { stat: 'hrr',        threshold: 1, playerName: 'A' },
  { stat: 'hrr',        threshold: 2, playerName: 'A' },
  { stat: 'hrr',        threshold: 3, playerName: 'B' },
  { stat: 'strikeouts', threshold: 3, playerName: 'C' },
  { stat: 'strikeouts', threshold: 5, playerName: 'C' },
];

// --- Early-return shapes for mlb.js ---

export const LINEUP_EARLY_RETURN = {
  lineupKPct: {}, lineupBatterKPcts: {}, lineupKPctVR: {}, lineupKPctVL: {},
  lineupBatterKPctsOrdered: {}, lineupBatterKPctsVROrdered: {}, lineupBatterKPctsVLOrdered: {},
  lineupSpotByName: {}, gameHomeTeams: {}, projectedLineupTeams: [],
};

export const PITCHER_EARLY_RETURN = {
  pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherCSWPct: {}, pitcherAvgPitches: {},
};
