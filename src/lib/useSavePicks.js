import React from 'react';
import { WORKER } from './constants.js';

// Delta-save bookkeeping for /api/user/picks. Extracted from App.jsx 2026-05-27.
//
// `lastSyncedPicks` is the last server-confirmed state, keyed pick.id → serialized JSON.
// `savePicks` diffs the current picks against this map and POSTs only the upserts/deletes
// + bankroll-if-changed. Saves serialize via `inflightSave`; if a save fires while one is
// in flight, `pendingSave` is set and a follow-up runs after the current one with the
// latest state from `getCurrent()`.
//
// Caller responsibility:
//   - `getCurrent` must return the latest { picks, bankroll } — used by the retry path
//     after an in-flight save completes. Typically backed by refs that mirror state.
//   - Call `primeSync(picks, bankroll)` once after the initial server pick load so the
//     first save after mount is a true diff, not a full re-upload.
//   - Call `resetSync()` on logout to clear the baseline.
export function useSavePicks({ getCurrent }) {
  const [syncStatus, setSyncStatus] = React.useState(null); // "saving" | "saved" | "error"
  const lastSyncedPicks = React.useRef(new Map());
  const lastSyncedBankroll = React.useRef(null);
  const inflightSave = React.useRef(false);
  const pendingSave = React.useRef(false);
  const getCurrentRef = React.useRef(getCurrent);
  React.useEffect(() => { getCurrentRef.current = getCurrent; }, [getCurrent]);

  const savePicks = React.useCallback(async function savePicks(picks, roll) {
    if (inflightSave.current) { pendingSave.current = true; return; }
    inflightSave.current = true;
    try {
      const upserts = [];
      const currentIds = new Set();
      for (const p of picks) {
        if (!p || !p.id) continue;
        currentIds.add(p.id);
        const serialized = JSON.stringify(p);
        if (lastSyncedPicks.current.get(p.id) !== serialized) upserts.push(p);
      }
      const deletes = [];
      for (const id of lastSyncedPicks.current.keys()) {
        if (!currentIds.has(id)) deletes.push(id);
      }
      const bankrollChanged = roll !== lastSyncedBankroll.current;

      if (upserts.length === 0 && deletes.length === 0 && !bankrollChanged) {
        setSyncStatus("saved");
        return;
      }

      const body = { upserts, deletes };
      if (bankrollChanged) body.bankroll = roll;
      const bodyStr = JSON.stringify(body);
      // keepalive has a 64 KiB cumulative body cap (per Fetch spec). Opt in only when the
      // delta fits comfortably so tab-close / visibility-hidden flushes have a chance to
      // land. Larger deltas (rare with delta saves — would need ~40+ picks changing at
      // once) fall back to plain fetch and rely on the active tab to keep it alive.
      const fetchOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
      };
      if (bodyStr.length < 60 * 1024) fetchOpts.keepalive = true;
      const res = await fetch(`${WORKER}/user/picks`, fetchOpts);

      if (res.ok) {
        for (const p of upserts) lastSyncedPicks.current.set(p.id, JSON.stringify(p));
        for (const id of deletes) lastSyncedPicks.current.delete(id);
        if (bankrollChanged) lastSyncedBankroll.current = roll;
        setSyncStatus("saved");
      } else {
        setSyncStatus("error");
      }
    } catch {
      setSyncStatus("error");
    } finally {
      inflightSave.current = false;
      if (pendingSave.current) {
        pendingSave.current = false;
        // Re-run with the latest state to catch changes made during the in-flight save.
        const current = getCurrentRef.current?.();
        if (current) setTimeout(() => savePicks(current.picks, current.bankroll), 0);
      }
    }
  }, []);

  // Seed baseline from a server-authoritative pick set (called once after initial load).
  const primeSync = React.useCallback((picks, bankroll) => {
    lastSyncedPicks.current = new Map(
      (picks || []).filter(p => p && p.id).map(p => [p.id, JSON.stringify(p)])
    );
    lastSyncedBankroll.current = bankroll != null ? bankroll : null;
  }, []);

  // Clear baseline on logout so a re-login doesn't diff against a prior user's snapshot.
  const resetSync = React.useCallback(() => {
    lastSyncedPicks.current = new Map();
    lastSyncedBankroll.current = null;
  }, []);

  return { savePicks, syncStatus, setSyncStatus, primeSync, resetSync };
}
