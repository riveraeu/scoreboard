import React from 'react';
import { WORKER } from './constants.js';

// ReportPage data fetching, extracted from App.jsx (E-9).
//
// fetchReport hits `/tonight?debug=1&sport=X` and memoizes the result per-sport in
// reportDataBySport so revisiting the page for a sport is instant.
// fetchCalib hits `/auth/calibration` (bearer-optional — works without auth via the
// shared admin-key path, but uses the user's token when present).
//
// Pure data-fetching glue — no refs, no circular deps. ReportPage destructures the
// outputs and drives its own (sport, play-type, tab) selection on top of them.
export function useReportData() {
  const [reportSort, setReportSort] = React.useState({"mlb|teamRuns":{col:"sim",dir:"desc"},"nba|teamPoints":{col:"sim",dir:"desc"}});
  const [reportDataBySport, setReportDataBySport] = React.useState({});
  const [reportLoadingSport, setReportLoadingSport] = React.useState(null); // "mlb"|"nba"|"wnba"|"nhl"|null
  const [reportSport, setReportSport] = React.useState("mlb");
  const [calibData, setCalibData] = React.useState(null);
  const [calibLoading, setCalibLoading] = React.useState(false);

  const fetchReport = React.useCallback(async (sport) => {
    if (!sport) return;
    setReportSport(sport);
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
      const r = await fetch(`${WORKER}/auth/calibration`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setCalibData(await r.json());
    } catch(e) {
      setCalibData({ error: e.message });
    }
    setCalibLoading(false);
  }, []);

  return {
    reportSort, setReportSort,
    reportDataBySport,
    reportLoadingSport,
    reportSport, setReportSport,
    calibData, calibLoading,
    fetchReport, fetchCalib,
  };
}
