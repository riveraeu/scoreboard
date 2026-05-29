import React from 'react';
import { WORKER } from './constants.js';
import { getPickCurrentStat, findLivePlayer, resolveTotalGameScore, pitcherIsOut } from './liveStats.js';

// Used by the player-prop DNP check: a player still missing from the boxscore past this
// point of the game is overwhelmingly a coach's decision / IL, not a late check-in.
const pastMidpoint = (sport, detail) => {
  if (!detail) return false;
  if (sport === "nba" || sport === "wnba") return /(3rd|4th|OT|End of 2nd|Halftime)/i.test(detail);
  if (sport === "nhl")                     return /(3rd|OT|SO|End of 2nd)/i.test(detail);
  return false;
};

// Live-stat polling + auto-resolve for tracked picks. Extracted from App.jsx 2026-05-27.
//
// Owns: liveStats state, the polling interval ref, the meta ref (for closure-fresh meta
// reads inside the long-lived polling closure).
//
// Behavior:
//   - Polls /api/live every 60s while there are unresolved picks for today / tomorrow /
//     yesterday (yesterday covers games that ended after midnight UTC).
//   - Fans out one /api/live call per distinct gameDate so cross-day matchups don't
//     collide (e.g. NYY:BAL on consecutive days).
//   - Player-prop picks resolve from /api/live boxscores. Totals/teamTotals/ML/spread
//     picks resolve from liveStats first, then fall back to {sport}Meta.gameScores from
//     /api/tonight.
//   - When sport meta first becomes available, fires an immediate poll so picks tracked
//     without `opponent` can backfill from gameScores without waiting up to 60s.
export function useLiveStats({ trackedPlays, setTrackedPlays, mlbMeta, nbaMeta, wnbaMeta, nhlMeta }) {
  const [liveStats, setLiveStats] = React.useState({});
  const liveIntervalRef = React.useRef(null);
  const liveMetaRef = React.useRef({ mlbMeta: null, nbaMeta: null, wnbaMeta: null, nhlMeta: null });

  const fetchLiveStats = React.useCallback(async (currentPicks, currentMeta) => {
    const today = new Date().toLocaleDateString("en-CA");
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString("en-CA"); })();
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA"); })();
    // Include yesterday's unresolved picks so games that ended after midnight UTC still get auto-settled.
    // Aging cap: ignore picks older than yesterday — at that point manual resolution.
    const activePicks = currentPicks.filter(p => !p.result && (p.gameDate === today || p.gameDate === tomorrow || p.gameDate === yesterday));
    if (!activePicks.length) return;

    // Resolve playerTeam + opponent from gameScores when one or both are missing on the pick.
    // Older picks may have empty playerTeam ("") or null opponent; backfill from whichever is present.
    // Also treat any value containing "|" as invalid (legacy bug saved opponent as "STL|date").
    const resolveTeams = (pick) => {
      const has = (v) => typeof v === "string" && v.length > 0 && !v.includes("|");
      let playerTeam = has(pick.playerTeam) ? pick.playerTeam : null;
      let opponent = has(pick.opponent) ? pick.opponent : null;
      if (playerTeam && opponent) return { playerTeam, opponent };
      const scores = pick.sport === "mlb" ? currentMeta?.mlbMeta?.gameScores
                   : pick.sport === "nba" ? currentMeta?.nbaMeta?.gameScores
                   : pick.sport === "wnba" ? currentMeta?.wnbaMeta?.gameScores
                   : pick.sport === "nhl" ? currentMeta?.nhlMeta?.gameScores
                   : null;
      if (!scores) return { playerTeam, opponent };
      for (const g of Object.values(scores)) {
        if (playerTeam && !opponent) {
          if (g.homeTeam === playerTeam) { opponent = g.awayTeam; break; }
          if (g.awayTeam === playerTeam) { opponent = g.homeTeam; break; }
        } else if (opponent && !playerTeam) {
          if (g.homeTeam === opponent) { playerTeam = g.awayTeam; break; }
          if (g.awayTeam === opponent) { playerTeam = g.homeTeam; break; }
        }
      }
      return { playerTeam, opponent };
    };

    // Collect unique game keys for ALL active picks (player props + totals + team totals),
    // grouped by gameDate so we can hit /api/live with the right date for each batch.
    // Yesterday's picks need yesterday's ESPN scoreboard, today's need today's.
    // pickKeyMap stores DATE-SCOPED keys (`raw|gameDate`); the same matchup recurring
    // across days would otherwise alias and let one day's response settle another's pick.
    const pickKeyMap = new Map(); // pick.id → `${rawKey}|${gameDate}`
    const keysByDate = new Map(); // gameDate → Set<rawKey>  (raw is what /api/live expects)
    for (const p of activePicks) {
      let rawKey = null;
      if (p.gameType === "total") {
        if (p.homeTeam && p.awayTeam) rawKey = `${p.sport}:${p.awayTeam}:${p.homeTeam}`;
      } else if (p.gameType === "teamTotal") {
        if (p.scoringTeam && p.oppTeam) rawKey = `${p.sport}:${p.scoringTeam}:${p.oppTeam}`;
      } else if (p.gameType === "ml" || p.gameType === "spread") {
        if (p.homeTeam && p.awayTeam) rawKey = `${p.sport}:${p.awayTeam}:${p.homeTeam}`;
      } else {
        const { playerTeam, opponent } = resolveTeams(p);
        if (playerTeam && opponent) rawKey = `${p.sport}:${playerTeam}:${opponent}`;
      }
      if (!rawKey || !p.gameDate) continue;
      // Append @gameTime when present so /api/live can disambiguate same-day doubleheaders.
      if (p.gameTime) rawKey = `${rawKey}@${p.gameTime}`;
      pickKeyMap.set(p.id, `${rawKey}|${p.gameDate}`);
      if (!keysByDate.has(p.gameDate)) keysByDate.set(p.gameDate, new Set());
      keysByDate.get(p.gameDate).add(rawKey);
    }
    if (!keysByDate.size) return;

    try {
      // Fan out one /api/live call per distinct gameDate. Today omits the date param
      // (default behavior); other dates pass `&date=YYYY-MM-DD`. Server response is keyed by
      // the raw matchup; we re-scope to `raw|gameDate` before merging so cross-day collisions
      // can't overwrite each other (e.g. NYY:BAL on consecutive days).
      const fetches = [...keysByDate.entries()].map(([gd, keys]) => {
        const games = [...keys].join(",");
        const dateQs = gd === today ? "" : `&date=${gd}`;
        return fetch(`${WORKER}/live?games=${games}${dateQs}`)
          .then(r => r.ok ? r.json() : {})
          .catch(() => ({}))
          .then(resp => {
            const scoped = {};
            for (const [k, v] of Object.entries(resp)) scoped[`${k}|${gd}`] = v;
            return scoped;
          });
      });
      const responses = await Promise.all(fetches);
      const data = Object.assign({}, ...responses);
      setLiveStats(prev => ({ ...prev, ...data }));

      // Auto-resolve: check each active player-prop pick against live data
      setTrackedPlays(prev => prev.map(pick => {
        if (pick.result) return pick; // already settled
        if (pick.gameType === "total" || pick.gameType === "teamTotal" || pick.gameType === "ml" || pick.gameType === "spread") return pick; // handled separately
        const gameKey = pickKeyMap.get(pick.id);
        if (!gameKey) return pick;
        // gameKey is `sport:team:opp|gameDate` (date-scoped) — strip the `|date` from the opp
        // segment so backfilled `opponent` is the clean team abbr. Previously this set
        // opponent="STL|2026-05-16", breaking subsequent live polls (split key never matched).
        const parts = gameKey.split(":");
        const resolvedTeam = parts[1];
        const resolvedOpp = parts[2]?.split("|")[0];
        const has = (v) => typeof v === "string" && v.length > 0 && !v.includes("|");
        const backfill = {};
        if (!has(pick.playerTeam) && resolvedTeam) backfill.playerTeam = resolvedTeam;
        if (!has(pick.opponent) && resolvedOpp) backfill.opponent = resolvedOpp;
        const hasBackfill = Object.keys(backfill).length > 0;
        const liveGame = data[gameKey];
        if (!liveGame || liveGame.state === "pre" || liveGame.state === "unknown") {
          return hasBackfill ? { ...pick, ...backfill } : pick;
        }

        const playerStats = findLivePlayer(liveGame.players, pick.playerName);
        const current = getPickCurrentStat(pick, playerStats);

        if (current !== null && current >= pick.threshold) {
          return { ...pick, ...backfill, result: "won" };
        }
        // Mid-game DNP: player not in boxscore + game has passed the midpoint = coach's
        // decision / IL. Resolve "dnp" without waiting for game end. Conservative — only
        // fires past halftime (NBA/WNBA) / 2nd-period end (NHL) so a starter who's late
        // checking in early game isn't false-positive resolved. MLB skipped (pitcherIsOut
        // handles K-prop DNP via explicit isCurrentPitcher flag).
        if (playerStats === undefined && liveGame.state === "in" && pastMidpoint(pick.sport, liveGame.detail)) {
          return { ...pick, ...backfill, result: "dnp" };
        }
        // MLB strikeouts: once the pitcher is pulled, their K count is final. Resolve "lost"
        // without waiting for the game to end so the pick card stops showing as in-progress.
        // Uses isCurrentPitcher flag from /api/live (correct for bulk pitchers behind openers).
        if (pick.sport === "mlb" && pick.stat === "strikeouts"
            && liveGame.state === "in"
            && pitcherIsOut(playerStats)) {
          return { ...pick, ...backfill, result: "lost" };
        }
        if (liveGame.state === "post") {
          if (playerStats === undefined && pick.stat !== "strikeouts") {
            return { ...pick, ...backfill, result: "dnp" }; // player not in boxscore after game ended
          }
          return { ...pick, ...backfill, result: "lost" };
        }
        return hasBackfill ? { ...pick, ...backfill } : pick;
      }));
    } catch { /* network error — silently skip */ }
  }, [setTrackedPlays]);

  // Auto-resolve totals/team-totals/ML/spread picks. Reads from liveStats first (fresh,
  // includes yesterday's settled games when polled with date param), falls back to
  // mlbMeta/nbaMeta/wnbaMeta/nhlMeta gameScores for today's games loaded via /api/tonight.
  React.useEffect(() => {
    if (!trackedPlays.length) return;
    const today = new Date().toLocaleDateString("en-CA");
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA"); })();
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString("en-CA"); })();
    const allScores = {
      ...(mlbMeta?.gameScores || {}),
      ...(nbaMeta?.gameScores || {}),
      ...(wnbaMeta?.gameScores || {}),
      ...(nhlMeta?.gameScores || {}),
    };
    const hasAnyData = Object.keys(allScores).length > 0 || Object.keys(liveStats).length > 0;
    if (!hasAnyData) return;

    setTrackedPlays(prev => prev.map(pick => {
      if (pick.result) return pick;
      if (pick.gameType !== "total" && pick.gameType !== "teamTotal" && pick.gameType !== "ml" && pick.gameType !== "spread") return pick;
      if (pick.gameDate !== today && pick.gameDate !== yesterday && pick.gameDate !== tomorrow) return pick;

      const gameScore = resolveTotalGameScore(pick, liveStats, allScores);
      if (!gameScore || (gameScore.state !== "post" && gameScore.state !== "in")) return pick;

      // F5 (First-5-Innings) picks resolve as soon as the bottom of the 5th completes,
      // independent of full-game state. /api/live stamps f5Complete + f5HomeScore +
      // f5AwayScore on the MLB live response once both teams have ≥5 innings batted.
      // If state==="post" but f5Complete is false, the game was called before the 5th
      // (rainout) — Kalshi voids these, so we mark "void".
      if (pick.segment === "f5") {
        const f5Done = gameScore.f5Complete === true;
        if (!f5Done) {
          if (gameScore.state === "post") return { ...pick, result: "void" };
          return pick;
        }
        const f5Home = gameScore.f5HomeScore ?? 0;
        const f5Away = gameScore.f5AwayScore ?? 0;
        if (pick.gameType === "total") {
          const total = f5Home + f5Away;
          const isUnder = pick.direction === "under";
          const met = isUnder ? total < pick.threshold : total >= pick.threshold;
          return { ...pick, result: met ? "won" : "lost" };
        }
        if (pick.gameType === "spread") {
          const pickIsHome = gameScore.homeTeam === pick.pickTeam;
          const pickF5 = pickIsHome ? f5Home : f5Away;
          const oppF5 = pickIsHome ? f5Away : f5Home;
          const covered = (pickF5 - oppF5) + (pick.pickLine ?? 0) > 0;
          return { ...pick, result: covered ? "won" : "lost" };
        }
        if (pick.gameType === "ml") {
          // F5 ML is 3-way: home/away/tie. Tie is a legitimate winning side.
          if (pick.side === "tie") {
            return { ...pick, result: f5Home === f5Away ? "won" : "lost" };
          }
          const winner = f5Home > f5Away ? gameScore.homeTeam
                       : f5Away > f5Home ? gameScore.awayTeam
                       : null;
          // If tied through 5 and pick was on a team (not tie), pick loses.
          if (winner == null) return { ...pick, result: "lost" };
          return { ...pick, result: winner === pick.pickTeam ? "won" : "lost" };
        }
        return pick;
      }

      if (pick.gameType === "ml") {
        // ML resolves only at Final — no early "winning at half" win-locking. The pre-game
        // model truePct is based on full 9-inning outcomes; in-game leads have plenty of
        // variance left.
        if (gameScore.state !== "post") return pick;
        const winningTeam = (gameScore.homeScore ?? 0) > (gameScore.awayScore ?? 0)
          ? gameScore.homeTeam
          : (gameScore.awayScore ?? 0) > (gameScore.homeScore ?? 0)
            ? gameScore.awayTeam
            : null;
        if (winningTeam == null) return pick; // tie shouldn't happen in MLB regulation; defensive
        return { ...pick, result: winningTeam === pick.pickTeam ? "won" : "lost" };
      }

      if (pick.gameType === "spread") {
        // Spread resolves only at Final. Half-line markets only (no push handling). Pick covers
        // when (pickTeamFinal - oppFinal) > line for YES picks (negative pickLine) or
        // (pickTeamFinal - oppFinal) > -|line| for NO picks (positive pickLine) — equivalently
        // (pickFinal - oppFinal) + pickLine > 0 in both directions.
        if (gameScore.state !== "post") return pick;
        const pickIsHome = gameScore.homeTeam === pick.pickTeam;
        const pickFinal = pickIsHome ? (gameScore.homeScore ?? 0) : (gameScore.awayScore ?? 0);
        const oppFinal = pickIsHome ? (gameScore.awayScore ?? 0) : (gameScore.homeScore ?? 0);
        const covered = (pickFinal - oppFinal) + (pick.pickLine ?? 0) > 0;
        return { ...pick, result: covered ? "won" : "lost" };
      }

      const isHome = gameScore.homeTeam === (pick.gameType === "total" ? pick.homeTeam : pick.scoringTeam);
      const current = pick.gameType === "total"
        ? (gameScore.homeScore ?? 0) + (gameScore.awayScore ?? 0)
        : (isHome ? (gameScore.homeScore ?? 0) : (gameScore.awayScore ?? 0));

      const isUnder = pick.direction === "under";
      // Totals are monotonic — scores only go up. Once the threshold is crossed mid-game,
      // OVER is locked won and UNDER is locked lost; neither can recover. Resolve both
      // immediately rather than waiting for `state === "post"`.
      if (gameScore.state === "in") {
        if (!isUnder && current >= pick.threshold) return { ...pick, result: "won" };
        if ( isUnder && current >= pick.threshold) return { ...pick, result: "lost" };
        return pick;
      }
      const met = isUnder ? current < pick.threshold : current >= pick.threshold;
      return { ...pick, result: met ? "won" : "lost" };
    }));
  }, [mlbMeta, nbaMeta, wnbaMeta, nhlMeta, liveStats, trackedPlays, setTrackedPlays]);

  // Keep latest meta in a ref so the polling interval reads fresh values (effect dep array
  // can't include meta without re-creating the interval). When meta first becomes available,
  // fire an immediate poll so picks tracked without `opponent` can resolve via the
  // gameScores backfill without waiting up to 60s.
  React.useEffect(() => {
    const prev = liveMetaRef.current;
    liveMetaRef.current = { mlbMeta, nbaMeta, wnbaMeta, nhlMeta };
    const becameAvailable = (k) => !prev?.[k]?.gameScores && liveMetaRef.current[k]?.gameScores;
    if ((becameAvailable("mlbMeta") || becameAvailable("nbaMeta") || becameAvailable("wnbaMeta") || becameAvailable("nhlMeta")) && liveIntervalRef.current) {
      setTrackedPlays(current => { fetchLiveStats(current, liveMetaRef.current); return current; });
    }
  }, [mlbMeta, nbaMeta, wnbaMeta, nhlMeta, fetchLiveStats, setTrackedPlays]);

  // Start/stop background polling every 60s
  React.useEffect(() => {
    const today = new Date().toLocaleDateString("en-CA");
    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString("en-CA"); })();
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA"); })();
    // Include totals/team-totals so they also poll /api/live, and include yesterday's
    // unresolved picks so games that ended after midnight UTC still get auto-settled.
    const hasTodayActivePicks = trackedPlays.some(p =>
      !p.result && (p.gameDate === today || p.gameDate === tomorrow || p.gameDate === yesterday)
    );

    if (liveIntervalRef.current) {
      clearInterval(liveIntervalRef.current);
      liveIntervalRef.current = null;
    }
    if (!hasTodayActivePicks) return;

    // Fire immediately, then every 60s. Meta read from ref so polls always see latest.
    fetchLiveStats(trackedPlays, liveMetaRef.current);
    liveIntervalRef.current = setInterval(() => {
      setTrackedPlays(current => {
        fetchLiveStats(current, liveMetaRef.current);
        return current;
      });
    }, 60000);
    return () => { clearInterval(liveIntervalRef.current); liveIntervalRef.current = null; };
  }, [trackedPlays.filter(p => !p.result).length, fetchLiveStats, setTrackedPlays]);

  return { liveStats };
}
