import React from 'react';
import { WORKER } from './constants.js';

// Shadow-report data fetching, extracted from App.jsx (E-9). Originally scoped to the /model
// ReportPage; that page was deprecated 2026-07-22 (DoThisBanner moved into MakerBoardPage,
// which is this hook's only consumer now — see project_do_this_banner memory).
//
// fetchShadowReport hits `/shadow-report` (bearer-optional — uses the user's cookie session
// when present so yesterdayRecap is scoped to their tracked picks). `bust=1` forces a fresh regen.
export function useReportData() {
  const [shadowReportData, setShadowReportData] = React.useState(null);
  const [shadowReportLoading, setShadowReportLoading] = React.useState(false);

  const fetchShadowReport = React.useCallback(async (bust) => {
    setShadowReportLoading(true);
    const url = `${WORKER}/shadow-report` + (bust ? '?bust=1' : '');
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setShadowReportData(await r.json());
    } catch(e) {
      setShadowReportData({ error: e.message });
    }
    setShadowReportLoading(false);
  }, []);

  return {
    shadowReportData, shadowReportLoading, fetchShadowReport,
  };
}
