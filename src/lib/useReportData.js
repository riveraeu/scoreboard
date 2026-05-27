import React from 'react';
import { WORKER } from './constants.js';

// MarketReport + ModelPage calibration data fetching, extracted from App.jsx (E-9).
//
// fetchReport hits `/tonight?debug=1&sport=X` and memoizes the result per-sport in
// reportDataBySport so opening the overlay for a sport a second time is instant.
// fetchCalib hits `/auth/calibration` (bearer-optional — works without auth via the
// shared admin-key path, but uses the user's token when present).
//
// Pure data-fetching glue — no refs, no circular deps. The render destructures everything
// it needs and passes it straight through to MarketReport / ModelPage / LineupsPage.
export function useReportData({ authToken }) {
  const [showReport, setShowReport] = React.useState(false);
  const [reportSort, setReportSort] = React.useState({"mlb|teamRuns":{col:"sim",dir:"desc"},"nba|teamPoints":{col:"sim",dir:"desc"}});
  const [reportDataBySport, setReportDataBySport] = React.useState({});
  const [reportLoadingSport, setReportLoadingSport] = React.useState(null); // "mlb"|"nba"|"nhl"|null
  const [reportSport, setReportSport] = React.useState("mlb");
  const [calibData, setCalibData] = React.useState(null);
  const [calibLoading, setCalibLoading] = React.useState(false);

  const fetchReport = React.useCallback(async (sport) => {
    if (!sport) return;
    setReportSport(sport);
    setShowReport(true);
    // Read from latest state via the functional setter form so a quickly-repeated call
    // sees the in-flight cache; the early-return below still handles the steady-state hit.
    if (reportDataBySport[sport]) return;
    setReportLoadingSport(sport);
    try {
      const r = await fetch(`${WORKER}/tonight?debug=1&sport=${sport}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setReportDataBySport(prev => ({ ...prev, [sport]: d }));
    } catch(e) {
      setReportDataBySport(prev => ({ ...prev, [sport]: { error: e.message } }));
    }
    setReportLoadingSport(null);
  }, [reportDataBySport]);

  const fetchCalib = React.useCallback(async () => {
    setCalibLoading(true);
    setCalibData(null);
    try {
      const r = await fetch(`${WORKER}/auth/calibration`, { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setCalibData(await r.json());
    } catch(e) {
      setCalibData({ error: e.message });
    }
    setCalibLoading(false);
  }, [authToken]);

  return {
    showReport, setShowReport,
    reportSort, setReportSort,
    reportDataBySport,
    reportLoadingSport,
    reportSport, setReportSport,
    calibData, calibLoading,
    fetchReport, fetchCalib,
  };
}
