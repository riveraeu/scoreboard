// Per-sport stat config for the team page (labels, alt-line thresholds, units).
// Extracted from TeamPage.jsx 2026-06-15 so App.jsx and gamelogParser.js can read it
// without statically importing TeamPage — which would pull the (lazy-loaded) team page
// back into the main bundle and defeat code-splitting.
export const STAT_CONFIGS = {
  'basketball/nba': {
    points:   { label: 'Points',   thresholds: [10,15,20,25,30,35,40],    unit: 'PTS' },
    rebounds: { label: 'Rebounds', thresholds: [2,4,6,8,10,12,14,16],     unit: 'REB' },
    assists:  { label: 'Assists',  thresholds: [2,3,4,5,6,7,8,9,10],      unit: 'AST' },
    threePointers: { label: '3-Pointers', thresholds: [1,2,3,4,5,6,7], unit: '3PM' },
  },
  'basketball/wnba': {
    points:   { label: 'Points',   thresholds: [10,15,20,25,30],          unit: 'PTS' },
    rebounds: { label: 'Rebounds', thresholds: [2,4,6,8,10,12],           unit: 'REB' },
    assists:  { label: 'Assists',  thresholds: [2,3,4,5,6,7,8],           unit: 'AST' },
    threePointers: { label: '3-Pointers', thresholds: [1,2,3,4,5],        unit: '3PM' },
  },
  'football/nfl': {
    passingYards:   { label: 'Pass Yds',    thresholds: [150,200,250,300,350,400], unit: 'YDS' },
    completions:    { label: 'Completions', thresholds: [10,15,20,25,30,35],       unit: 'CMP' },
    attempts:       { label: 'Attempts',    thresholds: [20,25,30,35,40,45],       unit: 'ATT' },
    rushingYards:   { label: 'Rush Yds',    thresholds: [25,50,75,100,125,150],    unit: 'YDS' },
    receivingYards: { label: 'Rec Yds',     thresholds: [25,50,75,100,125,150],    unit: 'YDS' },
    receptions:     { label: 'Receptions',  thresholds: [2,3,4,5,6,7,8],          unit: 'REC' },
  },
  'baseball/mlb': {
    hrr:        { label: 'H+R+RBI',     thresholds: [1,2,3,4,5,6],       unit: 'HRR'},
    strikeouts: { label: 'Strikeouts',  thresholds: [3,4,5,6,7,8,9,10], unit: 'K'  },
  },
  'hockey/nhl': {
    shotsOnGoal: { label: 'Shots on Goal', thresholds: [2,3,4,5,6,7,8],     unit: 'SOG' },
    points:      { label: 'Points',        thresholds: [1,2,3,4],            unit: 'PTS' },
    saves:       { label: 'Saves',         thresholds: [20,25,30,35,40,45],  unit: 'SV'  },
  },
};
