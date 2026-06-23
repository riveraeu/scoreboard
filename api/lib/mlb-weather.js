// MLB ballpark weather — game-time wind + temperature for the HRR model (shadow-only, 2026-06-22).
//
// The static PARK_HITFACTOR can't see game-day conditions; wind blowing out to CF and warm air
// both lift HR/run carry, and the prop market is structurally slow to price them on individual
// hitter lines (lines set hours ahead, books weather-adjust totals more than props). This builds a
// per-home-park {windOutMph, tempF} map from Open-Meteo (free, no API key) at first-pitch hour.
//
// windOutMph is the SIGNED out-to-CF wind component: + = blowing out toward center (HR boost),
// − = blowing in. Dome / retractable-roof parks are weather-neutral (we can't know roof state
// pre-game, so all retractables are treated as closed to avoid false signal — Phase 1 conservatism).
//
// Coefficients that CONSUME this (in props.js HRR logit) are anchored to published HR-vs-wind/temp
// sensitivities, NOT to Kalshi prices. Shadow-validated forward; promote to the gate only if
// modelBrier < marketBrier at n≥200.

// Canonical home-team abbr → { lat, lon, cfAz (home-plate→CF compass bearing °), dome }.
// Keyset mirrors PARK_HITFACTOR. Azimuths are APPROXIMATE (v1) — refine in Phase 2; the sign of the
// crosswind projection is what matters for a provisional knob. ATH plays at Sutter Health Park
// (West Sacramento) in 2026.
// Signed out-to-CF wind component (mph): + = blowing out toward center (HR boost), − = in.
// Wind direction is "from", so the velocity vector points toward (dir+180); project onto cfAz.
// Shared by the live builder and the historical backtest so both use the identical transform.
export function windOutComponent(windMph, windDir, cfAz) {
  return parseFloat((-windMph * Math.cos((windDir - cfAz) * Math.PI / 180)).toFixed(1));
}

export const BALLPARKS = {
  ARI: { lat: 33.4455, lon: -112.0667, cfAz: 0,  dome: true  },
  ATL: { lat: 33.8907, lon: -84.4677,  cfAz: 28, dome: false },
  BAL: { lat: 39.2839, lon: -76.6217,  cfAz: 32, dome: false },
  BOS: { lat: 42.3467, lon: -71.0972,  cfAz: 45, dome: false },
  CHC: { lat: 41.9484, lon: -87.6553,  cfAz: 30, dome: false },
  CWS: { lat: 41.8300, lon: -87.6339,  cfAz: 30, dome: false },
  CIN: { lat: 39.0975, lon: -84.5069,  cfAz: 30, dome: false },
  CLE: { lat: 41.4962, lon: -81.6852,  cfAz: 0,  dome: false },
  COL: { lat: 39.7559, lon: -104.9942, cfAz: 0,  dome: false },
  DET: { lat: 42.3390, lon: -83.0485,  cfAz: 30, dome: false },
  HOU: { lat: 29.7572, lon: -95.3554,  cfAz: 20, dome: true  },
  KC:  { lat: 39.0517, lon: -94.4803,  cfAz: 0,  dome: false },
  LAA: { lat: 33.8003, lon: -117.8827, cfAz: 45, dome: false },
  LAD: { lat: 34.0739, lon: -118.2400, cfAz: 25, dome: false },
  MIA: { lat: 25.7780, lon: -80.2197,  cfAz: 30, dome: true  },
  MIL: { lat: 43.0280, lon: -87.9712,  cfAz: 0,  dome: true  },
  MIN: { lat: 44.9817, lon: -93.2776,  cfAz: 0,  dome: false },
  NYM: { lat: 40.7571, lon: -73.8458,  cfAz: 30, dome: false },
  NYY: { lat: 40.8296, lon: -73.9262,  cfAz: 10, dome: false },
  ATH: { lat: 38.5800, lon: -121.5169, cfAz: 0,  dome: false },
  PHI: { lat: 39.9061, lon: -75.1665,  cfAz: 10, dome: false },
  PIT: { lat: 40.4469, lon: -80.0057,  cfAz: 90, dome: false },
  SD:  { lat: 32.7073, lon: -117.1566, cfAz: 0,  dome: false },
  SF:  { lat: 37.7786, lon: -122.3893, cfAz: 90, dome: false },
  SEA: { lat: 47.5914, lon: -122.3325, cfAz: 0,  dome: true  },
  STL: { lat: 38.6226, lon: -90.1928,  cfAz: 60, dome: false },
  TB:  { lat: 27.7683, lon: -82.6534,  cfAz: 0,  dome: true  },
  TEX: { lat: 32.7473, lon: -97.0838,  cfAz: 0,  dome: true  },
  TOR: { lat: 43.6414, lon: -79.3894,  cfAz: 0,  dome: true  },
  WSH: { lat: 38.8730, lon: -77.0074,  cfAz: 30, dome: false },
};

// gameScores (keyed by home abbr, carries gameTime ISO + gameDate PT) + today's PT date →
// { [homeTeam]: {dome:true} | {dome:false, windOutMph, tempF, source} }. Graceful empty on any
// failure — a missing entry degrades to a neutral 1.0 multiplier downstream (never blanks a play).
export async function buildBallparkWeather(gameScores, todayPT) {
  try {
    // Today's games → home park + first-pitch ISO, deduped by home team (DH: first wins, same park).
    const seen = new Set();
    const parks = [];
    for (const g of Object.values(gameScores || {})) {
      const home = g?.homeTeam;
      if (!home || seen.has(home) || g.gameDate !== todayPT) continue;
      const bp = BALLPARKS[home];
      if (!bp) continue;
      seen.add(home);
      parks.push({ home, bp, gameTime: g.gameTime });
    }
    if (!parks.length) return {};
    const out = {};
    const open = [];
    for (const p of parks) {
      if (p.bp.dome) out[p.home] = { dome: true, source: "dome" };
      else open.push(p);
    }
    if (!open.length) return out;
    const lats = open.map(p => p.bp.lat).join(",");
    const lons = open.map(p => p.bp.lon).join(",");
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}`
      + `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT&forecast_days=2`;
    const ac = new AbortController();
    const _t = setTimeout(() => ac.abort(), 5000);
    const json = await fetch(url, { signal: ac.signal })
      .then(r => { clearTimeout(_t); return r.ok ? r.json() : null; })
      .catch(() => null);
    if (!json) return out; // non-dome parks fall through to neutral downstream
    const arr = Array.isArray(json) ? json : [json];
    for (let i = 0; i < open.length; i++) {
      const loc = arr[i], p = open[i];
      const h = loc?.hourly;
      if (!h?.time?.length) continue;
      // Match first-pitch hour (UTC) against the GMT hourly grid; fall back to ~7pm local-ish.
      const hr = p.gameTime ? new Date(p.gameTime).toISOString().slice(0, 13) : null;
      let idx = hr ? h.time.findIndex(t => String(t).slice(0, 13) === hr) : -1;
      if (idx === -1) idx = Math.min(h.time.length - 1, 23);
      const tempF = h.temperature_2m?.[idx];
      const wMph = h.wind_speed_10m?.[idx];
      const wDir = h.wind_direction_10m?.[idx];
      if (tempF == null || wMph == null || wDir == null) continue;
      const windOutMph = windOutComponent(wMph, wDir, p.bp.cfAz);
      out[p.home] = { dome: false, windOutMph, tempF: Math.round(tempF), source: "open-meteo" };
    }
    return out;
  } catch {
    return {};
  }
}
