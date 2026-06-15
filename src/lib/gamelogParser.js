import { STAT_CONFIGS } from './statConfigs.js';

// ESPN gamelog parser — transforms a raw `{labels, events}` payload into:
//   - aggregated: { [statKey]: number[] }  per-stat arrays for the player-card bars
//   - perGame:    [{ oppId, oppAbbr, date, isHome, season, ...gs }]  for DvP scatter / table
//   - isPitcher:  bool (MLB only; derived from presence of an IP column in labels)
//
// Pure function — no React state, no side effects. Moved out of App.jsx (E-12) so the
// player-card subsystem extraction in a later phase has a cleaner starting point.
export function parseGameLog(data, sport) {
  const result = {};
  const statConfigs = STAT_CONFIGS[sport] || {};
  Object.keys(statConfigs).forEach(k => result[k] = []);

  const labels = data.labels || [];
  const events = data.events || [];
  const ul = labels.map(l => (l || "").toUpperCase());

  // Helper: get numeric value at first occurrence of a label
  const byLabel = (stats, lbl) => {
    const i = ul.indexOf(lbl);
    if (i === -1) return undefined;
    const v = parseFloat(stats[i]);
    return isNaN(v) ? undefined : v;
  };

  // NFL: YDS appears multiple times — pre-compute indices by context
  const nflCols = {};
  if (sport === "football/nfl") {
    ul.forEach((lbl, i) => {
      const prev = i > 0 ? ul[i - 1] : "";
      if (lbl === "CMP")                       nflCols.cmp     = i;
      if (lbl === "ATT")                       nflCols.att     = i;
      if (lbl === "YDS" && prev === "ATT")     nflCols.passYds = i;
      if (lbl === "YDS" && prev === "CAR")     nflCols.rushYds = i;
      if (lbl === "REC")                       nflCols.rec     = i;
      if (lbl === "TGTS")                      nflCols.tgts    = i;
      if (lbl === "YDS" && prev === "TGTS")    nflCols.recYds  = i;
    });
  }

  // MLB: pitcher vs hitter determined by presence of IP column
  const isPitcher = sport === "baseball/mlb" && ul.includes("IP");
  if (isPitcher) { result.bb = []; result.ip = []; result.hitsAllowed = []; }

  const perGame = [];

  events.forEach(ev => {
    const stats = ev.stats || [];
    const col = key => {
      const i = nflCols[key];
      if (i === undefined) return undefined;
      const v = parseFloat(stats[i]);
      return isNaN(v) ? undefined : v;
    };
    const lv = lbl => byLabel(stats, lbl);
    const gs = {}; // per-game stats for DvP

    if (sport === "basketball/nba" || sport === "basketball/wnba") {
      const pts = lv("PTS"), reb = lv("REB"), ast = lv("AST");
      if (pts !== undefined) { result.points?.push(pts); gs.points = pts; }
      if (reb !== undefined) { result.rebounds?.push(reb); gs.rebounds = reb; }
      if (ast !== undefined) { result.assists?.push(ast); gs.assists = ast; }

      const tpm = lv("3PT");
      if (tpm !== undefined) { result.threePointers?.push(tpm); gs.threePointers = tpm; }
      const min = lv("MIN");
      if (min !== undefined) { gs.min = min; }
    }

    if (sport === "football/nfl") {
      if (col("passYds") !== undefined) { result.passingYards?.push(col("passYds")); gs.passingYards = col("passYds"); }
      if (col("cmp")     !== undefined) { result.completions?.push(col("cmp")); gs.completions = col("cmp"); }
      if (col("att")     !== undefined) { result.attempts?.push(col("att")); gs.attempts = col("att"); }
      if (col("rushYds") !== undefined) { result.rushingYards?.push(col("rushYds")); gs.rushingYards = col("rushYds"); }
      if (col("recYds")  !== undefined) { result.receivingYards?.push(col("recYds")); gs.receivingYards = col("recYds"); }
      if (col("rec")     !== undefined) { result.receptions?.push(col("rec")); gs.receptions = col("rec"); }
    }

    if (sport === "baseball/mlb") {
      if (isPitcher) {
        const k = lv("K");
        const bb = lv("BB");
        const ip = lv("IP");
        const ha = lv("H"); // hits allowed
        const er = lv("ER");
        const pc = lv("P"); // ESPN uses "P" for pitch count (not "PC")
        if (k  !== undefined) { result.strikeouts?.push(k);  gs.strikeouts = k; }
        if (bb !== undefined) { result.bb?.push(bb); gs.bb = bb; }
        if (ip !== undefined) { result.ip?.push(ip); gs.ip = ip; }
        if (ha !== undefined) { result.hitsAllowed?.push(ha); gs.hitsAllowed = ha; }
        if (er !== undefined) { gs.er = er; }
        if (pc !== undefined) { gs.pc = pc; }
      } else {
        const h = lv("H"), hr = lv("HR"), rbi = lv("RBI"), r = lv("R"), b2 = lv("2B"), b3 = lv("3B");
        const ab = lv("AB"), bb = lv("BB");
        if (h   !== undefined) { result.hits?.push(h); gs.hits = h; }
        if (hr  !== undefined) { gs.homeRuns = hr; }
        if (ab  !== undefined) { gs.ab = ab; }
        if (r   !== undefined) { gs.r = r; }
        if (rbi !== undefined) { gs.rbi = rbi; }
        if (bb  !== undefined) { gs.bb = bb; }
        // H+R+RBI combined stat
        if (h !== undefined && r !== undefined && rbi !== undefined) {
          const hrr = h + r + rbi; result.hrr?.push(hrr); gs.hrr = hrr;
        }
        // Total bases: H + 2B + 2*3B + 3*HR
        if (h !== undefined && hr !== undefined && b2 !== undefined && b3 !== undefined) {
          const tb = h + b2 + 2*b3 + 3*hr;
          result.totalBases?.push(tb); gs.totalBases = tb;
        }
      }
    }

    if (sport === "hockey/nhl") {
      const sog = lv("SOG") ?? lv("S"), pts = lv("PTS"), sv = lv("SV");
      const g = lv("G"), a = lv("A");
      const toiIdx = ul.indexOf("TOI");
      const toi = toiIdx !== -1 && stats[toiIdx] != null ? stats[toiIdx] : undefined; // raw string — parseFloat("18:32") would truncate to 18
      if (sog !== undefined) { result.shotsOnGoal?.push(sog); gs.shotsOnGoal = sog; }
      if (pts !== undefined) { result.points?.push(pts); gs.points = pts; }
      if (sv  !== undefined) { result.saves?.push(sv); gs.saves = sv; }
      if (g   !== undefined) { gs.g = g; }
      if (a   !== undefined) { gs.a = a; }
      if (toi !== undefined) { gs.toi = toi; }
    }

    // Derive season from date (ev.season is never set by the API)
    const evDate = ev.date || null;
    const evSeason = evDate ? parseInt(evDate.slice(0, 4)) : null;
    perGame.push({ oppId: ev.oppId || null, oppAbbr: ev.oppAbbr || null,
      date: evDate, isHome: ev.isHome ?? null, season: evSeason, ...gs });
  });

  return { aggregated: result, perGame, isPitcher };
}
