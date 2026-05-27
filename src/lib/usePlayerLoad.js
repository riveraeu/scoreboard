import React from 'react';
import { WORKER } from './constants.js';
import { parseGameLog } from './gamelogParser.js';

// Player gamelog + DvP loader, extracted from App.jsx (E-13). Owns the player-card's
// load-side state (player, logs, perGame, dvpData, mlbIsPitcher, loading, error) and the
// `loadPlayer(p, sport)` async fetcher that populates it.
//
// MLB hitters/pitchers need 3-season blending: 2026 is the live season, but small samples
// early in the year make 2025 useful for truePct blending and 2024 helps with h2h depth.
// `logs` carries the primary aggregated bars (2026 alone if ≥5 games in any stat, else
// 2025+2026 blend); `logs25` carries the secondary bar (2025+2026 blend when there's
// enough 2026 data, otherwise the bare 2026 aggregate). Non-MLB sports just load one
// season and `logs25` stays null.
//
// fetchRef is a cancellation token — each call stamps a fresh id and bails on any setter
// when current id moved on. Prevents an in-flight load from stomping a newer player.
//
// setShowBreakdown is the only external dep — passed in so the hook can collapse the
// breakdown panel on every fresh player load.
export function usePlayerLoad({ setShowBreakdown }) {
  const [player, setPlayer] = React.useState(null);
  const [perGame, setPerGame] = React.useState([]);
  const [dvpData, setDvpData] = React.useState(null);
  const [mlbIsPitcher, setMlbIsPitcher] = React.useState(null); // null = unknown, true/false for MLB
  const [logs25, setLogs25] = React.useState(null);
  const [logs, setLogs] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const fetchRef = React.useRef(null);

  const loadPlayer = React.useCallback(async (p, sp) => {
    setPlayer(p); setLogs(null); setLogs25(null); setPerGame([]); setDvpData(null); setError(null); setLoading(true); setShowBreakdown(false);
    const id = Date.now(); fetchRef.current = id;
    try {
      // Resolve ESPN athlete ID by name search when ID is missing
      let resolvedId = p.id;
      if (!resolvedId && p.name) {
        try {
          const r = await fetch(`${WORKER}/athletes?q=${encodeURIComponent(p.name)}`);
          const d = await r.json();
          const items = d.items || [];
          const m = items.find(a => a.name.toLowerCase() === p.name.toLowerCase()) || items[0];
          if (m) { resolvedId = m.id; setPlayer(prev => ({ ...prev, id: m.id })); }
        } catch {}
        if (fetchRef.current !== id) return;
        if (!resolvedId) { setError('Player not found'); setLoading(false); return; }
      }
      const teamParam = p.team ? `&team=${encodeURIComponent(p.team)}` : "";
      if (sp === "baseball/mlb") {
        // Fetch 3 seasons in parallel for full h2h history, plus dvp for tonight's matchup
        const [d26, d25, d24, dv] = await Promise.all([
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${resolvedId}&season=2026`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${resolvedId}&season=2025`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${resolvedId}&season=2024`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`${WORKER}/dvp?sport=${sp}&athleteId=${resolvedId}${teamParam}`),
        ]);
        if (fetchRef.current !== id) return;
        // Merged gamelog for perGame (h2h filtering needs all career data)
        const base = d26 || d25 || d24;
        const mergedEvents = [
          ...(d26?.events || []).map(ev => ({ ...ev, season: 2026 })),
          ...(d25?.events || []).map(ev => ({ ...ev, season: 2025 })),
          ...(d24?.events || []).map(ev => ({ ...ev, season: 2024 })),
        ];
        const mergedData = base ? { labels: base.labels, events: mergedEvents, totalGames: mergedEvents.length } : { labels: [], events: [], totalGames: 0 };
        const { perGame: pg, isPitcher: isP } = parseGameLog(mergedData, sp);
        // Season-specific aggregates for truePct (2026 = main bar, 2025 = secondary)
        const { aggregated: agg26 } = d26 ? parseGameLog(d26, sp) : { aggregated: null };
        const { aggregated: agg25 } = d25 ? parseGameLog(d25, sp) : { aggregated: null };
        // Blend 2025+2026 events as primary season rate; individual years as breakdown bars
        const blendEvents = [...(d25?.events || []), ...(d26?.events || [])];
        const blendBase = d25 || d26;
        const { aggregated: aggBlend } = blendBase && blendEvents.length > 0
          ? parseGameLog({ labels: blendBase.labels, events: blendEvents }, sp)
          : { aggregated: null };
        const has2026 = agg26 && Object.values(agg26).some(arr => Array.isArray(arr) && arr.length >= 5);
        setLogs(has2026 ? agg26 : (aggBlend || agg25 || agg26));
        setLogs25(has2026 ? aggBlend : agg26);
        setPerGame(pg);
        setMlbIsPitcher(isP);
        if (dv.ok) {
          const dvJson = await dv.json();
          if (fetchRef.current !== id) return;
          setDvpData(dvJson);
        }
      } else {
        const season = sp === "football/nfl" ? "2025" : "2026";
        const [gameRes, dv] = await Promise.all([
          fetch(`${WORKER}/gamelog?sport=${sp}&athleteId=${resolvedId}&season=${season}`),
          fetch(`${WORKER}/dvp?sport=${sp}&athleteId=${resolvedId}${teamParam}`),
        ]);
        if (fetchRef.current !== id) return;
        if (!gameRes.ok) throw new Error('Could not load game log');
        const data = await gameRes.json();
        const { aggregated, perGame: pg } = parseGameLog(data, sp);
        setLogs(aggregated);
        setPerGame(pg);
        if (dv.ok) {
          const dvJson = await dv.json();
          if (fetchRef.current !== id) return;
          setDvpData(dvJson);
        }
      }
    } catch(e) {
      if (fetchRef.current !== id) return;
      setError("Could not load game log: " + e.message);
    }
    setLoading(false);
  }, [setShowBreakdown]);

  return {
    player, setPlayer,
    perGame,
    dvpData,
    mlbIsPitcher,
    logs, logs25,
    loading, error,
    loadPlayer,
  };
}
