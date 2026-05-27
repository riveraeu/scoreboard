import React from 'react';

// Stake sizing — flat ⅛-Kelly for every play, 1u ($30) when Kelly can't compute,
// $500 hard cap to bound tail risk on rare huge-Kelly recommendations. Exported so the
// AddPickModal's live "suggested stake" can mirror the same math against the user-entered
// odds (lives in App.jsx since it consumes pendingTrackPlay / pendingOdds state).
export const UNIT_DOLLARS = 30;
export const STAKE_CAP = 500;

// Pick state + handlers, extracted from App.jsx 2026-05-27.
//
// Owns: trackedPlays, bankroll (with localStorage init), mirror refs that useSavePicks
// reads via its `getCurrent` callback. Picks are server-authoritative — initial state
// is empty and App.jsx fills it via the /api/user/picks load effect; bankroll persists
// in localStorage as a fallback only.
//
// `trackPlay` accepts a play object (from /api/tonight, AddPickModal, or wherever) and
// constructs a fully-resolvable pick row: recomputes implied%/edge from the saved odds,
// backfills team/opponent/gameTime from gameScores (so manual picks are live-trackable),
// and stamps modelVersion:"v2" for calibration bucketing.
export function usePicks({ mlbMeta, nbaMeta, wnbaMeta, nhlMeta }) {
  const [trackedPlays, setTrackedPlays] = React.useState([]);
  const [bankroll, setBankrollState] = React.useState(() => {
    return parseFloat(localStorage.getItem("scoreboard_bankroll") || "1000");
  });

  // Mirror refs so the useSavePicks retry path reads the latest values, not stale closures.
  const trackedPlaysRef = React.useRef([]);
  const bankrollRef = React.useRef(null);
  React.useEffect(() => { trackedPlaysRef.current = trackedPlays; }, [trackedPlays]);
  React.useEffect(() => { bankrollRef.current = bankroll; }, [bankroll]);

  const unitsForPlay = React.useCallback((play) => {
    const e = play?.edge ?? null;
    // Kelly inputs. UNDER direction uses noTruePct so the probability matches the side taken.
    const truePct = play?.direction === "under" ? (play?.noTruePct ?? play?.truePct) : play?.truePct;
    const ao = play?.americanOdds;
    const kFrac = e == null ? null : 0.125;
    if (kFrac != null && truePct != null && ao != null && ao !== 0) {
      const b = ao > 0 ? ao / 100 : 100 / Math.abs(ao);
      const p = truePct / 100;
      const f = Math.max(0, (b * p - (1 - p)) / b);
      const stake = bankroll * f * kFrac;
      if (stake > 0) return Math.round(Math.min(stake, STAKE_CAP));
    }
    return Math.round(Math.min(UNIT_DOLLARS, STAKE_CAP));
  }, [bankroll]);

  function setBankroll(val) {
    const n = Math.max(1, parseFloat(val) || 0);
    setBankrollState(n);
    localStorage.setItem("scoreboard_bankroll", String(n));
  }

  const trackPlay = React.useCallback((play) => {
    const id = play.gameType === "teamTotal"
      ? `teamtotal|${play.sport}|${play.scoringTeam}|${play.oppTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
      : play.gameType === "total"
      ? `total|${play.sport}|${play.homeTeam}|${play.awayTeam}|${play.threshold}|${play.gameDate || ""}${play.direction === "under" ? "|under" : ""}`
      : play.gameType === "ml"
      ? `ml|${play.sport}|${play.pickTeam}|${play.homeTeam}|${play.awayTeam}|${play.gameDate || ""}`
      : play.gameType === "spread"
      ? `spread|${play.sport}|${play.pickTeam}|${play.homeTeam}|${play.awayTeam}|${play.pickLine}|${play.gameDate || ""}`
      : `${play.sport || "nba"}|${play.playerName}|${play.stat}|${play.threshold}|${play.gameDate || ""}`;
    const savedOdds = play.americanOdds ?? -110;
    // Recompute implied%, edge, and units from savedOdds. When the user overrides odds
    // via the pendingOdds dialog (e.g. takes -250 at sportsbook vs -350 at Kalshi),
    // the saved pick's edge/kalshiPct must reflect the price actually taken — otherwise
    // unitsForPlay reads the stale Kalshi edge and the bet is sized for the wrong band.
    const impliedFromOdds = savedOdds < 0
      ? Math.abs(savedOdds) / (Math.abs(savedOdds) + 100) * 100
      : 100 / (savedOdds + 100) * 100;
    const newKalshiPct = parseFloat(impliedFromOdds.toFixed(1));
    const truePct = play.direction === "under" ? (play.noTruePct ?? play.truePct) : play.truePct;
    const newEdge = truePct != null ? parseFloat((truePct - newKalshiPct).toFixed(1)) : (play.edge ?? null);
    // Stamp modelVersion:"v2" so /api/auth/calibration can split historical (pre-v2-drop)
    // vs current outcomes. Without the stamp, post-drop picks would be treated as v1.
    // Live tracking requires { playerTeam, opponent } (or for totals: { homeTeam, awayTeam } /
    // { scoringTeam, oppTeam }) to build a `sport:team:opp` key for /api/live, and the pick
    // card's live progress bar is gated on pick.gameTime. /api/tonight-derived picks have
    // these; manual picks from AddPickModal don't — backfill from gameScores here so the
    // pick is fully resolvable from the moment it's saved.
    let extras = {};
    const scoresMap = play.sport === "mlb" ? mlbMeta?.gameScores
                    : play.sport === "nba" ? nbaMeta?.gameScores
                    : play.sport === "wnba" ? wnbaMeta?.gameScores
                    : play.sport === "nhl" ? nhlMeta?.gameScores
                    : null;
    if (scoresMap) {
      let matchedGame = null;
      if ((play.gameType === "total" || play.gameType === "ml" || play.gameType === "spread") && play.homeTeam) {
        matchedGame = scoresMap[play.homeTeam] ||
          Object.values(scoresMap).find(g => g?.homeTeam === play.homeTeam && g?.awayTeam === play.awayTeam) ||
          null;
      } else if (play.gameType === "teamTotal" && play.scoringTeam) {
        matchedGame = scoresMap[play.scoringTeam] ||
          Object.values(scoresMap).find(g =>
            (g?.homeTeam === play.scoringTeam && g?.awayTeam === play.oppTeam) ||
            (g?.awayTeam === play.scoringTeam && g?.homeTeam === play.oppTeam)
          ) || null;
      } else if (!play.gameType && play.playerTeam) {
        for (const g of Object.values(scoresMap)) {
          if (g?.homeTeam === play.playerTeam || g?.awayTeam === play.playerTeam) { matchedGame = g; break; }
        }
        if (matchedGame && !play.opponent) {
          extras.opponent = matchedGame.homeTeam === play.playerTeam ? matchedGame.awayTeam : matchedGame.homeTeam;
        }
      }
      if (matchedGame) {
        if (!play.gameTime && matchedGame.gameTime) extras.gameTime = matchedGame.gameTime;
        if (play.gameType === "teamTotal") {
          if (!play.homeTeam && matchedGame.homeTeam) extras.homeTeam = matchedGame.homeTeam;
          if (!play.awayTeam && matchedGame.awayTeam) extras.awayTeam = matchedGame.awayTeam;
        }
      }
    }
    const enriched = { ...play, ...extras, americanOdds: savedOdds, kalshiPct: newKalshiPct, edge: newEdge, modelVersion: "v2" };
    setTrackedPlays(prev => {
      if (prev.find(p => p.id === id)) return prev;
      return [{ ...enriched, id, trackedAt: Date.now(), result: null,
        units: unitsForPlay(enriched),
      }, ...prev];
    });
  }, [mlbMeta, nbaMeta, wnbaMeta, nhlMeta, unitsForPlay]);

  const untrackPlay = React.useCallback((id) => {
    setTrackedPlays(prev => prev.filter(p => p.id !== id));
  }, []);

  const setPlayResult = React.useCallback((id, result) => {
    setTrackedPlays(prev => prev.map(p => p.id === id ? { ...p, result } : p));
  }, []);

  const setPickUnits = React.useCallback((id, units) => {
    const u = Math.max(0, parseFloat(units) || 0);
    setTrackedPlays(prev => prev.map(p => p.id === id ? { ...p, units: u } : p));
  }, []);

  return {
    trackedPlays, setTrackedPlays,
    bankroll, setBankrollState, setBankroll,
    unitsForPlay,
    trackPlay, untrackPlay, setPlayResult, setPickUnits,
    trackedPlaysRef, bankrollRef,
  };
}
