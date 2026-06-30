// MLB data fetchers: injury report + the byteam hydration orchestrator.
// Pitcher/hitter builders moved to mlb-pitchers.js / mlb-hitters.js (Phase C, 2026-05-29).
// MLB_ID_TO_ABBR + _fs live in mlb-shared.js. Re-exported below so existing
// `import { ... } from "../mlb.js"` call sites keep working unchanged.
import { MLB_ID_TO_ABBR } from "./mlb-shared.js";
import { buildLineupKPct } from "./mlb-hitters.js";
import { buildPitcherKPct } from "./mlb-pitchers.js";
import { buildBallparkWeather } from "./mlb-weather.js";
// Re-export so existing `import { ... } from "../mlb.js"` call sites keep working.
export { MLB_ID_TO_ABBR } from "./mlb-shared.js";
export { buildLineupKPct, buildBarrelPct } from "./mlb-hitters.js";
export { buildBallparkWeather } from "./mlb-weather.js";
export { buildPitcherKPct } from "./mlb-pitchers.js";

// Full MLB byteam hydration pipeline. Single call that fetches every MLB upstream we need for
// /api/tonight and returns the consolidated byteam:mlb object. Also writes to cache with a
// partial-data guard (60s TTL when key fields are empty, 600s otherwise).
//
// Args:
//   cache  — Vercel KV / Upstash cache (CACHE2)
//   PT_FMT — Intl.DateTimeFormat for PT date strings (passed in to avoid re-importing pt.js)
//   parseGameOdds — utils helper (passed in to avoid cross-lib cycles)
import { parseGameOdds as _parseGameOdds } from "./utils.js";
import { PT_FMT } from "./pt.js";
import { gzipToString, gunzipFromString } from "./kv-compress.js";

// byteam:mlb is the largest single KV value (~40 maps incl. historical per-team H2H/splits) and
// grew past Upstash's 10MB request cap, so its un-chunked SET was failing silently. Compress it
// at this chokepoint (used by buildMlbByteam + the /api/dvp MLB fallback). gzip gives ~6-10×
// headroom; failure-closed — a compress error just skips the write (the in-memory object is the
// source of truth for the current request).
export async function putMlbByteam(cache, byteam, ttlSec) {
  if (!cache) return;
  try {
    const packed = await gzipToString(JSON.stringify(byteam));
    await cache.put("byteam:mlb", packed, { expirationTtl: ttlSec });
  } catch (e) {
    console.error("[byteam:mlb] cache write skipped:", String(e?.message || e));
  }
}

export async function getMlbByteam(cache) {
  if (!cache) return null;
  try {
    const raw = await cache.get("byteam:mlb"); // raw string: may be gz:-prefixed or legacy JSON
    if (!raw) return null;
    return JSON.parse(await gunzipFromString(raw));
  } catch {
    return null;
  }
}

// ESPN MLB injury report. Returns Map<teamAbbr, [{name, id, status}]> for Out / GTD players.
// Mirrors buildNhlInjuryReport / buildNbaInjuryReport — ESPN omits athlete.id but embeds it in
// playercard link href. ESPN uses CHW for Chicago White Sox; normalize to canonical CWS.
// Cached at mlb:injuries:{date} for 1800s (30 min).
export async function buildMlbInjuryReport(cache) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const cacheKey = `mlb:injuries:v4:${date}`;
    if (cache) {
      const cached = await cache.get(cacheKey, "json").catch(() => null);
      if (cached) {
        const m = new Map();
        for (const [k, v] of Object.entries(cached)) m.set(k, v);
        return m;
      }
    }
    const r = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries",
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return new Map();
    const d = await r.json().catch(() => ({}));
    const injMap = {};
    for (const teamEntry of d.injuries || []) {
      const outPlayers = [];
      let abbr = null;
      for (const inj of teamEntry.injuries || []) {
        const statusRaw = (inj.status || "").toLowerCase();
        // Only count FRESH absences — players whose unavailability is not already absorbed into
        // season RPG. EXCLUDES X-Day-IL stays (10-Day-IL / 15-Day-IL / 60-Day-IL): those players
        // have been replaced on the roster for weeks/months, and the team's road RPG already
        // reflects life without them.
        const isIl = statusRaw.includes("-day-il") || statusRaw.includes("60-day") || statusRaw.includes("15-day") || statusRaw.includes("10-day");
        if (isIl) continue;
        const isOut = statusRaw === "out";
        const isGtd = statusRaw === "day-to-day" || statusRaw === "questionable" || statusRaw === "doubtful" || statusRaw.includes("game-time");
        if (!isOut && !isGtd) continue;
        // SECOND filter: stale Day-To-Day. ESPN keeps backup IF/C guys on "Day-To-Day" for weeks
        // with a far-out expectedReturn while the team plays a replacement. If returnDate is more
        // than 3 days away, treat as long-term (already absorbed into team RPG, same as IL).
        // 3-day cutoff: real day-of scratches return within 1-2 days; "DTD with 4+ day return"
        // is effectively a soft IL stint.
        const returnDate = inj.details?.returnDate || inj.details?.expectedReturn || null;
        if (returnDate) {
          const retMs = Date.parse(returnDate);
          if (!isNaN(retMs) && (retMs - Date.now()) > 3 * 86400 * 1000) continue;
        }
        if (!abbr) abbr = inj.athlete?.team?.abbreviation || null;
        const name = inj.athlete?.displayName || "";
        let id = inj.athlete?.id ? String(inj.athlete.id) : null;
        if (!id) {
          for (const lk of (inj.athlete?.links || [])) {
            const m = (lk.href || "").match(/\/id\/(\d+)\//);
            if (m) { id = m[1]; break; }
          }
        }
        const pos = inj.athlete?.position?.abbreviation || null;
        if (name) outPlayers.push({ name, id, status: isOut ? "out" : "gtd", pos });
      }
      // ESPN MLB uses CHW for Chicago White Sox; canonical is CWS.
      const NORM = { CHW: "CWS" };
      const canon = abbr ? (NORM[abbr] || abbr) : null;
      if (canon && outPlayers.length) injMap[canon] = outPlayers;
    }
    if (cache && Object.keys(injMap).length > 0) {
      await cache.put(cacheKey, JSON.stringify(injMap), { expirationTtl: 1800 }).catch(() => {});
    }
    const m = new Map();
    for (const [k, v] of Object.entries(injMap)) m.set(k, v);
    return m;
  } catch {
    return new Map();
  }
}

export async function buildMlbByteam(cache) {
  const [pitchData, batData, roadBatData, bullpenData, sbData, mlbSched] = await Promise.all([
    fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=pitching", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    fetch("https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/statistics/byteam?region=us&lang=en&contentorigin=espn&isqualified=true&page=1&limit=50&category=batting", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    fetch("https://statsapi.mlb.com/api/v1/teams/stats?season=2026&group=batting&gameType=R&sportId=1&sitCodes=A", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    // Bullpen-only pitching aggregates (relievers, season). Lets MLB game-total lambda separate
    // the 40% rest-of-game share from the starter who's double-counted in teamERA.
    fetch("https://statsapi.mlb.com/api/v1/teams/stats?season=2026&group=pitching&gameType=R&sportId=1&playerPool=bullpen", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    (() => {
      // Always fetch today + tomorrow in parallel. sbData.events = today (probables/gameOdds);
      // sbData.eventsAll = today+tomorrow (gameScores, so both day tabs see scheduled/finished games).
      const _td0 = new Date(Date.now() - 7 * 3600 * 1000); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
      const _tfmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
      const _h = { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" };
      return Promise.all([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_tfmt(_td0)}`, { headers: _h }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
        fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${_tfmt(_td1)}`, { headers: _h }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      ]).then(([sb0, sb1]) => ({ events: sb0.events || [], eventsTomorrow: sb1.events || [], eventsAll: [...(sb0.events || []), ...(sb1.events || [])] }));
    })(),
    (() => {
      const _td0 = new Date(Date.now() - 7 * 3600 * 1000); const _td1 = new Date(_td0); _td1.setDate(_td1.getDate() + 1);
      const _tfmt2 = (d) => d.toISOString().slice(0, 10);
      return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td0)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})).then((s0) => {
        const allFinal = (s0.dates || []).flatMap((d) => d.games || []).every((g) => g.status?.abstractGameState === "Final");
        if ((s0.dates || []).length === 0 || allFinal) {
          return fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${_tfmt2(_td1)}&hydrate=lineups,probablePitcher,officials`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
        }
        return s0;
      });
    })(),
  ]);

  // ESPN uses different abbreviations than Kalshi for some MLB teams
  const MLB_ESPN_NORM = { CHW: "CWS", KCR: "KC", SFG: "SF", SDP: "SD", TBR: "TB", AZ: "ARI", OAK: "ATH", WSN: "WSH", WAS: "WSH" };
  const normMlbAbbr = (a) => MLB_ESPN_NORM[a] || a;

  const probables = {};
  for (const event of sbData.events || []) {
    for (const comp of event.competitions || []) {
      const gameAbbrs = (comp.competitors || []).map((c) => normMlbAbbr(c.team?.abbreviation)).filter(Boolean);
      for (const competitor of comp.competitors || []) {
        const abbr = normMlbAbbr(competitor.team?.abbreviation);
        const probable = (competitor.probables || [])[0];
        if (!abbr || !probable) continue;
        const stats = probable.statistics || [];
        const eraStat = stats.find((s) => s.abbreviation === "ERA");
        const era = eraStat ? parseFloat(eraStat.displayValue) : null;
        const whipStat = stats.find((s) => s.abbreviation === "WHIP");
        const whip = whipStat ? parseFloat(whipStat.displayValue) : null;
        const name = probable.athlete?.displayName || probable.athlete?.fullName || null;
        const id = probable.athlete?.id || null;
        const opp = gameAbbrs.find((a) => a !== abbr) || null;
        probables[abbr] = { name, era, whip, id, opp };
      }
    }
  }
  const gameOddsRaw = _parseGameOdds(sbData.events);
  const gameOdds = Object.fromEntries(Object.entries(gameOddsRaw).map(([k, v]) => [normMlbAbbr(k), v]));
  const gameOddsTomorrowRaw = _parseGameOdds(sbData.eventsTomorrow || []);
  const gameOddsTomorrow = Object.fromEntries(Object.entries(gameOddsTomorrowRaw).map(([k, v]) => [normMlbAbbr(k), v]));
  // Game scores for matchup cards (includes finished games with no active Kalshi markets).
  // Iterate today+tomorrow merged events so both day tabs see scheduled/finished games.
  // Key includes gameDate (today vs tomorrow collision) AND event.date (same-day
  // doubleheader collision, e.g. DET @ BAL twice).
  const gameScores = {};
  for (const event of sbData.eventsAll || sbData.events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const homeComp = (comp.competitors || []).find(c => c.homeAway === "home");
    const awayComp = (comp.competitors || []).find(c => c.homeAway === "away");
    if (!homeComp || !awayComp) continue;
    const hA = normMlbAbbr(homeComp.team?.abbreviation), awA = normMlbAbbr(awayComp.team?.abbreviation);
    if (!hA || !awA) continue;
    const gsDate = event.date ? PT_FMT.format(new Date(event.date)) : null;
    const pickRecord = (recs) => {
      if (!Array.isArray(recs)) return null;
      const overall = recs.find(r => r?.type === "total" || r?.name === "overall");
      return overall?.summary ?? recs[0]?.summary ?? null;
    };
    gameScores[`${hA}|${gsDate ?? ""}|${event.date ?? ""}`] = {
      homeTeam: hA, awayTeam: awA,
      state: comp.status?.type?.state ?? "pre",
      detail: comp.status?.type?.shortDetail || comp.status?.type?.detail || "",
      homeScore: parseInt(homeComp.score ?? 0) || 0,
      awayScore: parseInt(awayComp.score ?? 0) || 0,
      gameDate: gsDate,
      gameTime: event.date || null,
      homeRecord: pickRecord(homeComp.records),
      awayRecord: pickRecord(awayComp.records),
      seasonType: event.season?.type ?? null,
    };
  }
  // gameScores is ready above; weather fetches in parallel with the lineup/pitcher builds.
  const _todayPT = PT_FMT.format(new Date());
  const [lineupResult, pitcherResult, weatherByTeam] = await Promise.all([
    buildLineupKPct(mlbSched), buildPitcherKPct(mlbSched),
    buildBallparkWeather(gameScores, _todayPT).catch(() => ({})),
  ]);
  const { lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL, lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered, lineupSpotByName, gameHomeTeams, projectedLineupTeams, batterSplitBA, hitterOpsMap, batterHandByName, batterHRRSplits, lineupHandByTeam, hitterTypicalPA } = lineupResult;
  const { pitcherKPct, pitcherKBBPct, pitcherCSWPct, pitcherAvgPitches, pitcherAvgBF, pitcherStdBF, pitcherGS26, pitcherHasAnchor, pitcherHand, pitcherEra: pitcherEraByTeam, pitcherWHIP: pitcherWHIPByTeam, pitcherFIP: pitcherFIPByTeam, pitcherBAA: pitcherBAAByTeam, pitcherWins: pitcherWinsByTeam, pitcherLosses: pitcherLossesByTeam, pitcherStatsByName, pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC, umpireByGame, pitcherInfoByTeam, pitcherH2HStarts, pitcherIdByGame, pitcherEraById, pitcherWinsById, pitcherLossesById, pitcherNameById, pitcherSplitsByTeam, pitcherSplitsById } = pitcherResult;
  // barrelPctMap is NOT stored in byteam:mlb — it lives in mlb:barrelPct with its own 6h TTL.
  // This prevents a bust (which deletes byteam:mlb) from baking an empty barrelPctMap
  // into the cache when Baseball Savant is slow.

  // Road RPG (away-only batting) — strips home park bias before applying parkRF in lambda
  const roadRPGMap = {};
  for (const split of (roadBatData?.stats?.[0]?.splits || [])) {
    const _ra = MLB_ESPN_NORM[split.team?.abbreviation] || split.team?.abbreviation;
    if (!_ra) continue;
    const gp = split.stat?.gamesPlayed ?? 0;
    const runs = split.stat?.runs ?? 0;
    if (gp > 0 && runs > 0) roadRPGMap[_ra] = parseFloat((runs / gp).toFixed(2));
  }

  // Team platoon ratio (BA-proxy). MLB Stats API /teams/stats does not support pitcher-handedness
  // sitCodes (only A/H), so derived from individual batter splits in batterSplitBA.
  const _bsNormKey = (n) => n ? n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() : "";
  const teamPlatoonRPGMap = {};
  for (const [abbr, spotMap] of Object.entries(lineupResult.lineupSpotByName || {})) {
    let hL = 0, abL = 0, hR = 0, abR = 0;
    for (const name of Object.keys(spotMap)) {
      const splits = batterSplitBA[_bsNormKey(name)];
      if (!splits) continue;
      const aL = splits.vsLPA ?? 0, aR = splits.vsRPA ?? 0;
      if (splits.vsL != null && aL >= 10) { hL += splits.vsL * aL; abL += aL; }
      if (splits.vsR != null && aR >= 10) { hR += splits.vsR * aR; abR += aR; }
    }
    const totalAB = abL + abR;
    if (totalAB < 80) continue;
    const overallBA = (hL + hR) / totalAB;
    if (overallBA === 0) continue;
    teamPlatoonRPGMap[abbr] = {
      vl: abL >= 25 ? parseFloat(((hL / abL) / overallBA).toFixed(3)) : 1.0,
      vr: abR >= 25 ? parseFloat(((hR / abR) / overallBA).toFixed(3)) : 1.0,
    };
  }

  // Team ERA + WHIP (staff-wide). teamERA is the 60/40 bullpen-proxy fallback;
  // teamWHIP backs up SimScore when starter WHIP is missing (debut / late-announcement).
  const teamERAMap = {};
  const teamWHIPMap = {};
  const _ptCat = (pitchData?.categories || []).find(c => c.name === "pitching");
  const _eraIdx = (_ptCat?.names || []).findIndex(n => n === "ERA" || n === "era");
  const _whipIdx = (_ptCat?.names || []).findIndex(n => n === "WHIP" || n === "whip");
  if (_eraIdx !== -1 || _whipIdx !== -1) {
    for (const team of (pitchData?.teams || [])) {
      const _ta = MLB_ESPN_NORM[team.team?.abbreviation] || team.team?.abbreviation;
      if (!_ta) continue;
      const tc = (team.categories || []).find(c => c.name === "pitching");
      if (_eraIdx !== -1) {
        const era = parseFloat(tc?.values?.[_eraIdx] ?? NaN);
        if (!isNaN(era) && era > 0) teamERAMap[_ta] = era;
      }
      if (_whipIdx !== -1) {
        const whip = parseFloat(tc?.values?.[_whipIdx] ?? NaN);
        if (!isNaN(whip) && whip > 0) teamWHIPMap[_ta] = parseFloat(whip.toFixed(2));
      }
    }
  }

  // Bullpen-only ERA + WHIP per team (relievers, season). Replaces whole-staff teamERA in the
  // 40% rest-of-game share of game-total + team-total lambdas. MLB Stats API returns team by
  // `id` (no abbreviation), so we translate via MLB_ID_TO_ABBR.
  const bullpenERAMap = {};
  const bullpenWHIPMap = {};
  for (const split of (bullpenData?.stats?.[0]?.splits || [])) {
    const _abbr = MLB_ID_TO_ABBR[split.team?.id];
    if (!_abbr) continue;
    const era = parseFloat(split.stat?.era ?? NaN);
    if (!isNaN(era) && era > 0) bullpenERAMap[_abbr] = parseFloat(era.toFixed(2));
    const whip = parseFloat(split.stat?.whip ?? NaN);
    if (!isNaN(whip) && whip > 0) bullpenWHIPMap[_abbr] = parseFloat(whip.toFixed(2));
  }

  // staticTeamHandMajority: majority batting hand per team using natural side (S=0.5R+0.5L).
  // Used to filter pitcher's historical starts by opposing lineup handedness composition.
  // Switch hitters counted as neutral (0.5/0.5) here since we don't know each historical pitcher hand;
  // tonight's matchup uses the full per-pitcher adjustment in the K play loop.
  const staticTeamHandMajority = {};
  for (const [abbr, spotMap] of Object.entries(lineupSpotByName || {})) {
    let rCount = 0, lCount = 0;
    for (const name of Object.keys(spotMap)) {
      const hand = batterHandByName[_bsNormKey(name)];
      if (hand === 'R') rCount++;
      else if (hand === 'L') lCount++;
      else if (hand === 'S') { rCount += 0.5; lCount += 0.5; }
    }
    if (rCount + lCount > 0) staticTeamHandMajority[abbr] = rCount >= lCount ? 'R' : 'L';
  }

  const byteam = {
    pitching: pitchData, batting: batData, probables,
    lineupKPct, lineupBatterKPcts, lineupKPctVR, lineupKPctVL,
    lineupBatterKPctsOrdered, lineupBatterKPctsVROrdered, lineupBatterKPctsVLOrdered,
    lineupSpotByName, gameHomeTeams,
    pitcherKPct, pitcherKBBPct, pitcherCSWPct, pitcherAvgPitches, pitcherAvgBF, pitcherStdBF,
    pitcherGS26, pitcherHasAnchor, pitcherHand,
    pitcherEra: pitcherEraByTeam, pitcherWHIPByTeam, pitcherFIPByTeam, pitcherBAAByTeam, pitcherWinsByTeam, pitcherLossesByTeam,
    projectedLineupTeams, gameOdds, gameOddsTomorrow, pitcherStatsByName,
    batterSplitBA, hitterOpsMap, batterHandByName, batterHRRSplits, pitcherH2HStarts,
    staticTeamHandMajority,
    pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC,
    umpireByGame, pitcherInfoByTeam,
    pitcherIdByGame, pitcherEraById, pitcherWinsById, pitcherLossesById, pitcherNameById,
    pitcherSplitsByTeam, pitcherSplitsById, lineupHandByTeam, hitterTypicalPA,
    roadRPGMap, teamERAMap, teamWHIPMap, bullpenERAMap, bullpenWHIPMap,
    teamPlatoonRPGMap, gameScores, weatherByTeam,
  };

  // Use short TTL (60s) if key data is missing — lineup/probables not confirmed yet, or
  // independent MLB Stats API hydrations (OPS, pitcher gamelogs) silently returned empty.
  // Prevents partial data from baking into cache for the full 600s and starving downstream
  // SimScore columns (HRR OPS, K H2H Hand, platoon, recent K%).
  const _mlbDataReady = Object.keys(lineupSpotByName || {}).length > 0
    && Object.keys(pitcherAvgPitches || {}).length > 0
    && Object.keys(hitterOpsMap || {}).length > 0
    && Object.keys(pitcherH2HStarts || {}).length > 0;
  await putMlbByteam(cache, byteam, _mlbDataReady ? 600 : 60);

  return byteam;
}
