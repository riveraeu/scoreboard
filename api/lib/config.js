// Shared universal-qualification tunables. Single source of truth — imported by both
// the server (api/lib/handlers/tonight.js) and the client (src/App.jsx, LineupsPage.jsx).
//
// Server and client use different EDGE gates intentionally: server stores every pick at
// edge≥3 to preserve calibration data continuity, client filters display to ≥5 (the
// tighter regime per feedback_totals_aggressive_corrections). See CLAUDE.md "Universal
// qualification" for context.

export const KALSHI_GATE = 67;        // ~-200 American odds floor (66.67% rounded up)
export const KALSHI_CAP  = 91;        // ~-1000 American odds cap (90.91% rounded up)
export const EDGE_GATE_SERVER = 3;    // server-side filter, preserved for calibration analysis
export const EDGE_GATE_CLIENT = 5;    // client-side filter for display + tracking gate
