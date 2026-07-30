import React from 'react';

// Player-card UI state, extracted from App.jsx (E-15). Pure useState bundle — no effects,
// no fetches, no refs. Each piece controls one piece of the player-card view chrome:
//
//   - activeTab           Selected stat tab (points / hits / strikeouts / ...). Resets to
//                         the first available tab when the player loads.
//   - selectedThreshold   Per-threshold drill-in on the active stat tab (e.g. 5+ pts).
//                         null means "default to first available". App.jsx resets this
//                         whenever activeTab or direction changes.
//   - showBreakdown       Toggles the season-split breakdown panel under the bars. Also
//                         driven by usePlayerLoad which collapses it on every fresh load
//                         (setShowBreakdown is passed in there).
//   - direction           "over" | "under" — flips hit-rate signs and threshold labels.
//   - gamelogSort         { col, dir } — column + direction for the per-game log table.
//
// showBreakdown's setter is consumed by usePlayerLoad's reset path — that's why the
// `setShowBreakdown` value returned here must exist BEFORE usePlayerLoad is called.
export function usePlayerCardState() {
  const [activeTab, setActiveTab] = React.useState("points");
  const [selectedThreshold, setSelectedThreshold] = React.useState(null);
  const [showBreakdown, setShowBreakdown] = React.useState(false);
  const [direction, setDirection] = React.useState("over");
  const [gamelogSort, setGamelogSort] = React.useState({ col: 'date', dir: 'desc' });

  return {
    activeTab, setActiveTab,
    selectedThreshold, setSelectedThreshold,
    showBreakdown, setShowBreakdown,
    direction, setDirection,
    gamelogSort, setGamelogSort,
  };
}
