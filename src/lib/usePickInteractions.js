import React from 'react';

// Pick-tracking UI orchestration, extracted from App.jsx (E-10). Three loosely-related
// subsystems bundled into one hook because they're all UI state for the picks flow:
//
//   1. Add-Pick modal entry (pendingTrackPlay / pendingOdds) — `initiateTrack` opens it
//      from a star click on a play card, capturing the star's screen position for the
//      fly animation.
//
//   2. Star→FAB fly animation (starClickOrigin / flyingPick / fabRef) — `triggerFlyAnimation`
//      reads the star origin + FAB position and pushes a `flyingPick` frame; the JSX renders
//      one absolutely-positioned ★ that animates origin → FAB and clears on animationEnd.
//
//   3. Picks drawer accordion (openPickDays / openPickWeeks / openPickMonths) — `openPickDate`
//      ensures the day + containing week are expanded when a fresh pick is added so the user
//      can see what they just tracked. Month-open is independent (set by MyPicksColumn).
export function usePickInteractions() {
  const [pendingTrackPlay, setPendingTrackPlay] = React.useState(null);
  const [pendingOdds, setPendingOdds] = React.useState("-110");
  const [openPickDays, setOpenPickDays] = React.useState(() => new Set([new Date().toLocaleDateString("en-CA")]));
  const [openPickWeeks, setOpenPickWeeks] = React.useState(() => {
    const d = new Date(); const dow = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - ((dow + 6) % 7));
    return new Set([mon.toLocaleDateString("en-CA")]);
  });
  const [openPickMonths, setOpenPickMonths] = React.useState(() => new Set([new Date().toLocaleDateString("en-CA").slice(0, 7)]));
  const [showAddPick, setShowAddPick] = React.useState(false);
  const [showPicksDrawer, setShowPicksDrawer] = React.useState(false);
  const [flyingPick, setFlyingPick] = React.useState(null);
  const [starClickOrigin, setStarClickOrigin] = React.useState(null);
  const fabRef = React.useRef(null);

  const initiateTrack = React.useCallback((play, event) => {
    if (event) {
      const rect = event.currentTarget.getBoundingClientRect();
      setStarClickOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    } else {
      setStarClickOrigin(null);
    }
    const odds = play.americanOdds;
    const defaultOdds = odds != null ? (odds > 0 ? `+${odds}` : `${odds}`) : "-110";
    setPendingOdds(defaultOdds);
    setPendingTrackPlay(play);
  }, []);

  const triggerFlyAnimation = React.useCallback(() => {
    if (!starClickOrigin || !fabRef.current) return;
    const fabRect = fabRef.current.getBoundingClientRect();
    setFlyingPick({
      x: starClickOrigin.x,
      y: starClickOrigin.y,
      destX: fabRect.left + fabRect.width / 2,
      destY: fabRect.top + fabRect.height / 2,
      key: Date.now(),
    });
    setStarClickOrigin(null);
  }, [starClickOrigin]);

  const openPickDate = React.useCallback((gameDate) => {
    const dk = gameDate || new Date().toLocaleDateString("en-CA");
    const [yr, mo, dy] = dk.split("-").map(Number);
    const d = new Date(yr, mo - 1, dy);
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const wk = mon.toLocaleDateString("en-CA");
    setOpenPickDays(prev => new Set([...prev, dk]));
    setOpenPickWeeks(prev => new Set([...prev, wk]));
  }, []);

  return {
    pendingTrackPlay, setPendingTrackPlay,
    pendingOdds, setPendingOdds,
    openPickDays, setOpenPickDays,
    openPickWeeks, setOpenPickWeeks,
    openPickMonths, setOpenPickMonths,
    showAddPick, setShowAddPick,
    showPicksDrawer, setShowPicksDrawer,
    flyingPick, setFlyingPick,
    fabRef,
    initiateTrack, triggerFlyAnimation, openPickDate,
  };
}
