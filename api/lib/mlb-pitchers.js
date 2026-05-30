// MLB pitcher data fetcher: buildPitcherKPct — K%, KBB%, hand, ERA/WHIP/FIP (2-step
// regressed), vs-L/vs-R splits, CSW%, avg/std batters-faced, recent K%, last-start info,
// umpire-by-game, H2H starts, per-game pitcher IDs. The dense pitcher lambda-input math.
// Split out of mlb.js Phase C (2026-05-29). Zero behavior change.
import { MLB_ID_TO_ABBR } from "./mlb-shared.js";

export async function buildPitcherKPct(mlbSched) {
  try {
    const pitcherByTeam = {};
    const pitcherHand = {};
    // Track ALL scheduled pitcher IDs — pitcherByTeam can be overwritten in same-matchup
    // doubleheaders (SD vs SEA twice), dropping the earlier pitcher's ID from allIds.
    // This set collects every ID seen so their stats are always fetched.
    const allScheduledPitcherIds = new Set();
    // pitcherIdByGame: per-game pitcher id keyed "{team}|{gameKey}" where gameKey is the
    // ESPN-style ISO (no seconds) — lets the frontend show the right pitcher per DH card.
    // MLB Stats API gameDate is "2026-05-24T16:35:00Z"; ESPN's event.date is "2026-05-24T16:35Z".
    // Trim seconds so the two sources line up on the same key.
    const _trimSec = (iso) => (iso ? iso.replace(/:\d{2}Z$/, "Z") : null);
    const pitcherIdByGame = {};
    // umpireByGame: home plate umpire name keyed "homeAbbr|awayAbbr"
    // Populated from game.officials when hydrate=officials is included in the schedule fetch.
    const umpireByGame = {};
    for (const date of mlbSched.dates || []) {
      for (const game of date.games || []) {
        const homeAbbr = MLB_ID_TO_ABBR[game.teams?.home?.team?.id] || game.teams?.home?.team?.abbreviation;
        const awayAbbr = MLB_ID_TO_ABBR[game.teams?.away?.team?.id] || game.teams?.away?.team?.abbreviation;
        const homeId = game.teams?.home?.probablePitcher?.id;
        const awayId = game.teams?.away?.probablePitcher?.id;
        const homeHand = game.teams?.home?.probablePitcher?.pitchHand?.code || null;
        const awayHand = game.teams?.away?.probablePitcher?.pitchHand?.code || null;
        const gameKey = _trimSec(game.gameDate);
        // Extract home plate umpire (populated when hydrate=officials is in schedule request)
        const _hp = (game.officials || []).find(o => o.officialType === "Home Plate");
        if (_hp?.official?.fullName && homeAbbr && awayAbbr) {
          umpireByGame[`${homeAbbr}|${awayAbbr}`] = _hp.official.fullName;
        }
        if (homeAbbr && homeId) {
          pitcherByTeam[homeAbbr] = homeId;
          pitcherHand[homeAbbr] = homeHand;
          // Also key by matchup so doubleheaders don't overwrite each other
          if (awayAbbr) { pitcherByTeam[`${homeAbbr}|${awayAbbr}`] = homeId; pitcherHand[`${homeAbbr}|${awayAbbr}`] = homeHand; }
          if (gameKey) pitcherIdByGame[`${homeAbbr}|${gameKey}`] = homeId;
        }
        if (awayAbbr && awayId) {
          pitcherByTeam[awayAbbr] = awayId;
          pitcherHand[awayAbbr] = awayHand;
          if (homeAbbr) { pitcherByTeam[`${awayAbbr}|${homeAbbr}`] = awayId; pitcherHand[`${awayAbbr}|${homeAbbr}`] = awayHand; }
          if (gameKey) pitcherIdByGame[`${awayAbbr}|${gameKey}`] = awayId;
        }
        if (homeId) allScheduledPitcherIds.add(homeId);
        if (awayId) allScheduledPitcherIds.add(awayId);
      }
    }
    const allIds = [...allScheduledPitcherIds];
    if (allIds.length === 0) return { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherWins: {}, pitcherLosses: {}, pitcherCSWPct: {}, pitcherAvgPitches: {}, pitcherAvgBF: {}, pitcherStdBF: {}, pitcherGS26: {}, pitcherHasAnchor: {}, pitcherRecentKPct: {}, pitcherLastStartDate: {}, pitcherLastStartPC: {}, umpireByGame, pitcherIdByGame, pitcherEraById: {}, pitcherWinsById: {}, pitcherLossesById: {}, pitcherNameById: {} };
    const idStr = allIds.join(",");
    const [res25, res26, resVL26, resVR26, resVL25, resVR25] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=season,season=2025,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=season,season=2026,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      // vs-L / vs-R splits for pitcher run-rate side. ERA isn't exposed on these endpoints (returns null),
      // but K/BB/HR/IP are — enough to compute split-FIP. WHIP is also exposed. We treat splits as a
      // multiplicative modifier on the regressed overall FIP/WHIP rather than standalone rates.
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=statSplits,season=2026,sitCodes=vl,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=statSplits,season=2026,sitCodes=vr,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=statSplits,season=2025,sitCodes=vl,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${idStr}&hydrate=stats(group=pitching,type=statSplits,season=2025,sitCodes=vr,gameType=R)`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.ok ? r.json() : {}).catch(() => ({}))
    ]);
    const pitcherStats25 = {}, pitcherStats26 = {};
    const pitcherSplits = {}; // pitcherSplits[id] = { vl26, vr26, vl25, vr25 } each with {so, bb, hbp, hr, ip, whip, bf}
    const _ingestSplit = (jres, side, year) => {
      for (const person of (jres.people || [])) {
        const pid = person.id;
        if (!pid) continue;
        const s = person.stats?.[0]?.splits?.[0]?.stat;
        if (!s || !s.battersFaced) continue;
        if (!pitcherSplits[pid]) pitcherSplits[pid] = {};
        pitcherSplits[pid][`${side}${year}`] = {
          so: s.strikeOuts || 0, bb: s.baseOnBalls || 0, hbp: s.hitByPitch || 0, hr: s.homeRuns || 0,
          ip: parseIP(s.inningsPitched), bf: s.battersFaced || 0, whip: parseFloat(s.whip) || null,
        };
      }
    };
    const pitcherHandById = {};
    const safeEra = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    // MLB Stats API returns inningsPitched as "45.2" meaning 45 ⅔ innings (NOT decimal).
    // ".0" → +0, ".1" → +1/3, ".2" → +2/3.
    const parseIP = (v) => {
      if (v == null || v === "") return 0;
      const s = String(v);
      const dot = s.indexOf(".");
      if (dot < 0) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }
      const whole = parseInt(s.slice(0, dot), 10) || 0;
      const frac = s.slice(dot + 1);
      return whole + (frac === "1" ? 1/3 : frac === "2" ? 2/3 : 0);
    };
    for (const person of (res25.people || [])) {
      const pid = person.id;
      if (!pid) continue;
      if (person.pitchHand?.code) pitcherHandById[pid] = person.pitchHand.code;
      const split = person.stats?.[0]?.splits?.[0]?.stat;
      if (!split) continue;
      pitcherStats25[pid] = { so: split.strikeOuts || 0, bf: split.battersFaced || 0, bb: split.baseOnBalls || 0, hbp: split.hitByPitch || 0, hr: split.homeRuns || 0, ip: parseIP(split.inningsPitched), era: safeEra(split.era), whip: safeEra(split.whip), gs: split.gamesStarted || 0, np: split.numberOfPitches || 0, w: split.wins || 0, l: split.losses || 0 };
    }
    for (const person of (res26.people || [])) {
      const pid = person.id;
      if (!pid) continue;
      if (person.pitchHand?.code) pitcherHandById[pid] = person.pitchHand.code;
      const split = person.stats?.[0]?.splits?.[0]?.stat;
      if (!split) continue;
      pitcherStats26[pid] = { so: split.strikeOuts || 0, bf: split.battersFaced || 0, bb: split.baseOnBalls || 0, hbp: split.hitByPitch || 0, hr: split.homeRuns || 0, ip: parseIP(split.inningsPitched), era: safeEra(split.era), whip: safeEra(split.whip), gs: split.gamesStarted || 0, np: split.numberOfPitches || 0, w: split.wins || 0, l: split.losses || 0 };
    }
    _ingestSplit(resVL26, "vl", "26");
    _ingestSplit(resVR26, "vr", "26");
    _ingestSplit(resVL25, "vl", "25");
    _ingestSplit(resVR25, "vr", "25");
    // Fill in pitcherHand from People API for any missing entries
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      if (!pitcherHand[abbr] && pitcherHandById[id]) pitcherHand[abbr] = pitcherHandById[id];
    }
    const LEAGUE_PITCHER_K = 0.222;
    const pitcherKPct = {}, pitcherKBBPct = {}, pitcherEra = {}, pitcherWHIP = {}, pitcherFIP = {}, pitcherHasAnchor = {};
    // Per-pitcher vs-L/vs-R split modifier vs overall. `pitcherSplitsByTeam[abbr] = { vlFipMod, vrFipMod,
    // vlWhipMod, vrWhipMod, vlBf, vrBf }` — modifier 1.0 means "no platoon effect"; > 1.0 means worse
    // vs that hand. Consumers compute lineup-weighted effective FIP/WHIP for the totals lambda.
    const pitcherSplitsByTeam = {}, pitcherSplitsById = {};
    const pitcherHasAnchorById = {};
    const pitcherWins = {}, pitcherLosses = {};
    // FIP constant aligns FIP onto the same numeric scale as ERA (~4.20 league baseline).
    // Slightly varies per season; 3.10 is a stable approximation for 2025–2026.
    const _FIP_CONST = 3.10;
    const _seasonFIP = (s) => {
      if (!s || !s.ip || s.ip < 1) return null;
      const raw = ((13 * s.hr) + (3 * (s.bb + s.hbp)) - (2 * s.so)) / s.ip + _FIP_CONST;
      return parseFloat(raw.toFixed(2));
    };
    // Two-step regression: (1) blend 2026↔2025 by trust26=min(1, gs26/15), (2) shrink the
    // blended estimate toward league mean with priorIP weight (Bayesian-style). Used for
    // ERA/WHIP (PRIOR_IP=50) and FIP (PRIOR_IP=30, since FIP stabilizes faster). The blended
    // sample size = full 2026 IP + (1−trust26) × 2025 IP so the league anchor pulls harder
    // on early-season pitchers without flattening true talent at full sample.
    const _regressedRate = (val26, ip26, val25, ip25, gs26, lgMean, priorIP) => {
      const has26 = val26 != null && ip26 >= 1;
      const has25 = val25 != null && ip25 >= 1;
      let blendedVal, blendedIp;
      if (has26 && has25) {
        const trust26 = Math.min(1, gs26 / 15);
        blendedVal = trust26 * val26 + (1 - trust26) * val25;
        blendedIp = ip26 + (1 - trust26) * ip25;
      } else if (has26) {
        blendedVal = val26; blendedIp = ip26;
      } else if (has25) {
        blendedVal = val25; blendedIp = ip25;
      } else {
        return null;
      }
      const shrunk = (blendedIp * blendedVal + priorIP * lgMean) / (blendedIp + priorIP);
      return parseFloat(shrunk.toFixed(2));
    };
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      const s26 = pitcherStats26[id];
      const s25 = pitcherStats25[id];
      // Regression-to-mean: blend 2026 actual with 2025 anchor weighted by 2026 BF only
      // trust = 2026 BF / 200 (full trust at 200 BF; ~33 starts in current season)
      const bf26 = s26?.bf || 0;
      const bf25 = s25?.bf || 0;
      const gs25 = s25?.gs || 0;
      // A reliever-turned-starter has bf25 > 0 but gs25 = 0 — reliever K% is not a valid starter anchor.
      // Also require bf25 >= 100 to exclude injury-shortened seasons (e.g. TJ recovery with 5 starts but minimal workload)
      pitcherHasAnchor[abbr] = gs25 >= 5 && bf25 >= 100; // true = reliable 2025 starter anchor (5+ starts, 100+ BF)
      pitcherHasAnchorById[id] = pitcherHasAnchor[abbr]; // also key by ID so pitcherStatsByName can recover overwritten pitchers
      const k26 = (s26 && bf26 > 0) ? s26.so / bf26 : null;
      const anchor = (s25 && bf25 >= 50) ? s25.so / bf25 : LEAGUE_PITCHER_K;
      const trust = Math.min(1.0, bf26 / 200);
      if (k26 !== null || bf25 >= 50) {
        const kRegressed = k26 !== null ? k26 * trust + anchor * (1 - trust) : anchor;
        pitcherKPct[abbr] = parseFloat((kRegressed * 100).toFixed(1));
        // KBB%: regress same way
        const kbb26 = (s26 && bf26 > 0) ? (s26.so - s26.bb) / bf26 : null;
        const anchorKBB = (s25 && bf25 >= 50) ? (s25.so - s25.bb) / bf25 : LEAGUE_PITCHER_K * 0.6;
        const kbbRegressed = kbb26 !== null ? kbb26 * trust + anchorKBB * (1 - trust) : anchorKBB;
        pitcherKBBPct[abbr] = parseFloat((kbbRegressed * 100).toFixed(1));
      }
      // ERA + WHIP: two-step regression (26↔25 sample-weighted blend, then league-anchor shrink).
      const _eraReg = _regressedRate(s26?.era ?? null, s26?.ip ?? 0, s25?.era ?? null, s25?.ip ?? 0, s26?.gs ?? 0, 4.20, 50);
      if (_eraReg != null) pitcherEra[abbr] = _eraReg;
      const _whipReg = _regressedRate(s26?.whip ?? null, s26?.ip ?? 0, s25?.whip ?? null, s25?.ip ?? 0, s26?.gs ?? 0, 1.30, 50);
      if (_whipReg != null) pitcherWHIP[abbr] = _whipReg;
      // W-L: prefer 2026 if pitcher has any 2026 starts, else 2025
      if ((s26?.gs ?? 0) > 0 || (s26?.w ?? 0) + (s26?.l ?? 0) > 0) {
        pitcherWins[abbr] = s26.w; pitcherLosses[abbr] = s26.l;
      } else if (s25 && ((s25.gs ?? 0) > 0 || (s25.w ?? 0) + (s25.l ?? 0) > 0)) {
        pitcherWins[abbr] = s25.w; pitcherLosses[abbr] = s25.l;
      }
      // FIP: same two-step regression as ERA/WHIP, with PRIOR_IP=30 (FIP stabilizes faster).
      // Computed per-season from raw HR/BB/HBP/K/IP, then blended + shrunk toward league mean.
      const fip26 = _seasonFIP(s26);
      const fip25 = _seasonFIP(s25);
      const _fipReg = _regressedRate(fip26, s26?.ip ?? 0, fip25, s25?.ip ?? 0, s26?.gs ?? 0, 4.20, 30);
      if (_fipReg != null) pitcherFIP[abbr] = _fipReg;
      // vs-L / vs-R modifiers (2026-05-25). For each side compute split FIP from raw count stats,
      // shrink toward the overall (not league mean) so the modifier reflects only the marginal
      // platoon signal. WHIP is exposed directly per split and gets the same shrinkage treatment.
      // Skip when overall FIP/WHIP is missing — modifier defaults to 1.0 (no adjustment).
      const splits = pitcherSplits[id];
      if (splits && pitcherFIP[abbr] != null && pitcherWHIP[abbr] != null) {
        const _SPLIT_PRIOR_IP = 20;  // pulls split values toward the overall FIP/WHIP
        const _splitFip = (s) => _seasonFIP(s);
        const _splitFipMod = (vl26, vl25) => {
          const f26 = _splitFip(vl26), f25 = _splitFip(vl25);
          const reg = _regressedRate(f26, vl26?.ip ?? 0, f25, vl25?.ip ?? 0, s26?.gs ?? 0, pitcherFIP[abbr], _SPLIT_PRIOR_IP);
          return reg != null ? parseFloat((reg / pitcherFIP[abbr]).toFixed(3)) : 1.0;
        };
        const _splitWhipMod = (vl26, vl25) => {
          const reg = _regressedRate(vl26?.whip ?? null, vl26?.ip ?? 0, vl25?.whip ?? null, vl25?.ip ?? 0, s26?.gs ?? 0, pitcherWHIP[abbr], _SPLIT_PRIOR_IP);
          return reg != null ? parseFloat((reg / pitcherWHIP[abbr]).toFixed(3)) : 1.0;
        };
        const entry = {
          vlFipMod: _splitFipMod(splits.vl26, splits.vl25),
          vrFipMod: _splitFipMod(splits.vr26, splits.vr25),
          vlWhipMod: _splitWhipMod(splits.vl26, splits.vl25),
          vrWhipMod: _splitWhipMod(splits.vr26, splits.vr25),
          vlBf: (splits.vl26?.bf ?? 0) + (splits.vl25?.bf ?? 0),
          vrBf: (splits.vr26?.bf ?? 0) + (splits.vr25?.bf ?? 0),
        };
        pitcherSplitsByTeam[abbr] = entry;
        pitcherSplitsById[id] = entry;
      }
    }
    const pitcherCSWPct = {};
    const pitcherAvgPitches = {};
    const pitcherAvgPitchesById = {}; // per-ID version — used for overwritten pitchers in pitcherStatsByName
    const pitcherAvgBF = {};
    const pitcherAvgBFById = {};
    const pitcherStdBF = {};
    const pitcherStdBFById = {};
    const pitcherGS26 = {};
    // A1: Recent form (last 5 starts K%)
    const pitcherRecentKPct = {};
    const pitcherRecentKPctById = {};
    // A2: Rest (last start date + pitch count)
    const pitcherLastStartDate = {};
    const pitcherLastStartDateById = {};
    const pitcherLastStartPC = {};
    const pitcherLastStartPCById = {};
    const pitcherGS26ById = {};
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      const s26 = pitcherStats26[id];
      if (s26 && s26.gs > 0) {
        pitcherGS26[abbr] = s26.gs;
        pitcherGS26ById[id] = s26.gs;
      }
    }
    // Step 1: fetch game logs (2026 for avgP/avgBF/stdBF/recentK; also 2025 for H2H hand component)
    let glFetch = [], glFetch25 = [];
    try {
      const settle = arr => Promise.allSettled(arr).then(rs => rs.map((r, i) => r.status === 'fulfilled' ? r.value : { id: allIds[i], splits: [] }));
      [glFetch, glFetch25] = await Promise.all([
        settle(allIds.map(id =>
          fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=2026&gameType=R`, { headers: { "User-Agent": "Mozilla/5.0" } })
            .then(r => r.ok ? r.json() : {}).catch(() => ({}))
            .then(d => ({ id, splits: d.stats?.[0]?.splits || [] }))
        )),
        settle(allIds.map(id =>
          fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=2025&gameType=R`, { headers: { "User-Agent": "Mozilla/5.0" } })
            .then(r => r.ok ? r.json() : {}).catch(() => ({}))
            .then(d => ({ id, splits: d.stats?.[0]?.splits || [] }))
        ))
      ]);
    } catch (err) { console.error("[buildPitcherKPct] gamelog fetch failed:", err?.message || err); }
    // Avg pitches per start from 2026 game logs (starts-only — accurate for pitchers with mixed starter/reliever roles)
    // Falls back to 2025 season aggregate only when no 2026 start data exists in the gamelog.
    // Exclude today's date: the gamelog API includes in-progress game entries with gamesStarted=1
    // and partial pitch counts (e.g. gs=1, np=11 after 1 IP), which poisons the avg.
    const _todayStr = new Date().toISOString().slice(0, 10);
    for (const { id, splits } of glFetch) {
      // Find ALL keys (team key + matchup keys) that map to this pitcher id.
      // Using filter() instead of find() ensures doubleheader matchup keys all get
      // the correct value (e.g. "SD|SEA" = Vasquez's avg even if "SD" was overwritten
      // by a makeup-game pitcher that processed later in the schedule loop).
      const abbrs = Object.keys(pitcherByTeam).filter(a => pitcherByTeam[a] === id);
      // Note: do NOT skip if abbrs is empty — overwritten pitchers still need pitcherAvgPitchesById set.
      // NP >= 30 guards against in-progress games where the date filter fails due to UTC vs local
      // date mismatch (e.g. game is "2026-04-15" local but server UTC reads "2026-04-16" as today,
      // so date !== _todayStr passes and a 2-pitch partial start poisons the average).
      const startSplits = splits.filter(s => (s.stat?.gamesStarted || 0) > 0 && s.date !== _todayStr && (s.stat?.numberOfPitches || 0) >= 30);
      const totalNP = startSplits.reduce((sum, s) => sum + (s.stat?.numberOfPitches || 0), 0);
      const totalBF = startSplits.reduce((sum, s) => sum + (s.stat?.battersFaced || 0), 0);
      const s26 = pitcherStats26[id];
      const s25 = pitcherStats25[id];
      // Sample-weighted blend with 2025 anchor when 2026 sample is light.
      // trust26 = min(1, gs26/15) — fully trusts 2026 at 15+ starts (half-season).
      // Stabilizes early-season workload swings (e.g. Skenes 2026 avgP=81 ramp-up
      // vs 2025 ace baseline ~95) where the raw 2026 number drags expectedBF
      // below his actual outing length and tanks truePct on K markets.
      const _gs26 = s26?.gs ?? 0;
      const _trust26 = Math.min(1, _gs26 / 15);
      let avgP_2026 = null;
      if (startSplits.length > 0 && totalNP > 0) {
        avgP_2026 = totalNP / startSplits.length;
      } else if (s26 && s26.gs >= 1 && s26.np > 0) {
        avgP_2026 = s26.np / s26.gs;
      }
      const avgP_2025 = (s25 && s25.gs >= 1 && s25.np > 0) ? s25.np / s25.gs : null;
      let avgP = null;
      if (avgP_2026 !== null && avgP_2025 !== null) {
        avgP = parseFloat((_trust26 * avgP_2026 + (1 - _trust26) * avgP_2025).toFixed(1));
      } else if (avgP_2026 !== null) {
        avgP = parseFloat(avgP_2026.toFixed(1));
      } else if (avgP_2025 !== null) {
        avgP = parseFloat(avgP_2025.toFixed(1));
      }
      if (avgP !== null) {
        pitcherAvgPitchesById[id] = avgP; // per-ID: used in pitcherStatsByName for overwritten pitchers
        for (const a of abbrs) pitcherAvgPitches[a] = avgP;
      }
      // avgBF: empirical batters faced per start — direct measure of pitcher volume,
      // avoids the 3.85 pitches/PA league-average constant used in expectedBF.
      // Same trust26 blend as avgP so the two stay consistent.
      let avgBF_2026 = null;
      if (startSplits.length > 0 && totalBF > 0) {
        avgBF_2026 = totalBF / startSplits.length;
      } else if (s26 && s26.gs >= 1 && s26.bf > 0) {
        avgBF_2026 = s26.bf / s26.gs;
      }
      const avgBF_2025 = (s25 && s25.gs >= 1 && s25.bf > 0) ? s25.bf / s25.gs : null;
      let avgBF = null;
      if (avgBF_2026 !== null && avgBF_2025 !== null) {
        avgBF = parseFloat((_trust26 * avgBF_2026 + (1 - _trust26) * avgBF_2025).toFixed(1));
      } else if (avgBF_2026 !== null) {
        avgBF = parseFloat(avgBF_2026.toFixed(1));
      } else if (avgBF_2025 !== null) {
        avgBF = parseFloat(avgBF_2025.toFixed(1));
      }
      if (avgBF !== null) {
        pitcherAvgBFById[id] = avgBF;
        for (const a of abbrs) pitcherAvgBF[a] = avgBF;
      }
      // stdBF: standard deviation of BF per start — captures "all-or-nothing" vs "steady" arms.
      // Single-pass sum-of-squares is safe: BF values in [15,35], n ≤ 35 starts, no precision risk.
      // Requires countBF >= 3 to avoid hallucinating variance from 1–2 starts. Store 0 (rather
      // than skipping) when variance is 0 — distinguishes "consistent arm" from "no data" at
      // the downstream dataConfidence check.
      if (startSplits.length >= 3 && totalBF > 0) {
        const n = startSplits.length;
        const sqSum = startSplits.reduce((s, sp) => s + (sp.stat?.battersFaced || 0) ** 2, 0);
        const mean = totalBF / n;
        const variance = Math.max(0, sqSum / n - mean * mean);
        const stdBFVal = parseFloat(Math.sqrt(variance).toFixed(2));
        pitcherStdBFById[id] = stdBFVal;
        for (const a of abbrs) pitcherStdBF[a] = stdBFVal;
      }
      // A1: Recent form — last 5 starts K% (min 30 total BF to trust the sample).
      // Uses a looser filter than avgPitches: any completed start regardless of NP.
      // Date guard already prevents in-progress games; r5BF >= 30 ensures enough total sample.
      // This allows pitch-count-limited starts (e.g. NP 25) to count toward the recent window.
      const a1Splits = splits.filter(s => (s.stat?.gamesStarted || 0) > 0 && s.date !== _todayStr);
      const recent5 = a1Splits.slice(-5);
      const r5K = recent5.reduce((s, sp) => s + (sp.stat?.strikeOuts || 0), 0);
      const r5BF = recent5.reduce((s, sp) => {
        if (sp.stat?.battersFaced) return s + sp.stat.battersFaced;
        const ip = parseFloat(sp.stat?.inningsPitched || 0);
        return s + (Math.floor(ip) * 3 + Math.round(ip * 10) % 10);
      }, 0);
      const _recentKPct = (recent5.length >= 3 && r5BF >= 30) ? parseFloat((r5K / r5BF * 100).toFixed(1)) : null;
      if (_recentKPct !== null) {
        pitcherRecentKPctById[id] = _recentKPct;
        for (const a of abbrs) pitcherRecentKPct[a] = _recentKPct;
      }
      // A2: Rest — last start date + pitch count
      const _lastSplit = startSplits.length > 0 ? startSplits[startSplits.length - 1] : null;
      const _lastStartDate = _lastSplit?.date ?? null;
      const _lastStartPC = _lastSplit?.stat?.numberOfPitches ?? null;
      if (_lastStartDate) {
        pitcherLastStartDateById[id] = _lastStartDate;
        for (const a of abbrs) pitcherLastStartDate[a] = _lastStartDate;
      }
      if (_lastStartPC != null) {
        pitcherLastStartPCById[id] = _lastStartPC;
        for (const a of abbrs) pitcherLastStartPC[a] = _lastStartPC;
      }
    }
    // Step 2: fetch play-by-play for CSW% (many concurrent requests, may time out on edge)
    // Limit to last 5 starts per pitcher to cap the number of PBP requests.
    // AbortController gives the entire block an 8s budget — if slow, CSW% falls back to K%.
    // Declared outside the try so pitcherStatsByName can access it for overwritten pitchers.
    const cswByMlbId = {};
    try {
      const allGamePks = new Set();
      const pitcherGamePks = {};
      for (const { id, splits } of glFetch) {
        const gks = splits.slice(0, 5).map(s => s.game?.gamePk).filter(Boolean);
        pitcherGamePks[id] = gks;
        gks.forEach(gk => allGamePks.add(gk));
      }
      const PBP_FIELDS = "allPlays,matchup,pitcher,id,playEvents,isPitch,details,code";
      const _pbpAc = new AbortController();
      const _pbpTimer = setTimeout(() => _pbpAc.abort(), 5000);
      const pbpFetch = await Promise.all(
        [...allGamePks].map(gk =>
          fetch(`https://statsapi.mlb.com/api/v1/game/${gk}/playByPlay?fields=${PBP_FIELDS}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: _pbpAc.signal })
            .then(r => r.ok ? r.json() : {}).catch(() => ({}))
            .then(d => ({ gk, plays: d.allPlays || [] }))
        )
      );
      clearTimeout(_pbpTimer);
      const playsByGk = Object.fromEntries(pbpFetch.map(({ gk, plays }) => [gk, plays]));
      const CSW_CODES = new Set(["C", "S", "T", "W", "M", "Q"]);
      for (const { id, splits } of glFetch) {
        let totalCSW = 0, totalPitches = 0;
        for (const s of splits) {
          const gk = s.game?.gamePk;
          const plays = gk ? (playsByGk[gk] || []) : [];
          for (const play of plays) {
            if (play.matchup?.pitcher?.id !== id) continue;
            for (const ev of play.playEvents || []) {
              if (!ev.isPitch) continue;
              totalPitches++;
              if (CSW_CODES.has(ev.details?.code)) totalCSW++;
            }
          }
        }
        if (totalPitches >= 30) cswByMlbId[id] = parseFloat((totalCSW / totalPitches * 100).toFixed(1));
      }
      for (const [abbr, id] of Object.entries(pitcherByTeam)) {
        if (cswByMlbId[id] != null) pitcherCSWPct[abbr] = cswByMlbId[id];
      }
    } catch { /* CSW% unavailable — filter falls back to K% */ }
    // pitcherH2HStarts: combined 2025+2026 completed starts with oppAbbr + strikeouts per game.
    // Used for K H2H hand component — needs game-level opponent to filter by hand majority.
    // No NP filter (unlike startSplits); any completed start qualifies.
    const pitcherH2HStartsById = {};
    for (const { id, splits } of [...glFetch25, ...glFetch]) {
      if (!pitcherH2HStartsById[id]) pitcherH2HStartsById[id] = [];
      const starts = splits
        .filter(s => (s.stat?.gamesStarted || 0) > 0 && s.date !== _todayStr)
        .map(s => ({
          oppAbbr: s.opponent?.abbreviation ?? null,
          strikeouts: s.stat?.strikeOuts ?? 0,
        }));
      pitcherH2HStartsById[id].push(...starts);
    }
    const pitcherH2HStarts = {};
    for (const [abbr, id] of Object.entries(pitcherByTeam)) {
      if (pitcherH2HStartsById[id]?.length) pitcherH2HStarts[abbr] = pitcherH2HStartsById[id];
    }
    // Name-keyed map: for MLB strikeout plays the player IS the pitcher.
    // Primary path: abbrs found in pitcherByTeam — uses per-abbr stats directly.
    // Fallback path: overwritten pitcher (same-matchup doubleheader, e.g. SD vs SEA twice) —
    //   pitcherByTeam["SD"] and ["SD|SEA"] both point to the second game's pitcher, so the
    //   first game's pitcher has no abbr entry. We detect this via allScheduledPitcherIds and
    //   compute stats directly from the raw ID-keyed data (pitcherStats26/25, cswByMlbId, etc.).
    const pitcherStatsByName = {};
    const _nn = n => (n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    for (const person of [...(res26.people || []), ...(res25.people || [])]) {
      const id = person.id;
      if (!id || !person.fullName) continue;
      const name = _nn(person.fullName);
      if (pitcherStatsByName[name]) continue; // prefer res26 (iterated first)
      const abbrs = Object.keys(pitcherByTeam).filter(a => pitcherByTeam[a] === id);
      if (abbrs.length > 0) {
        const a = abbrs[0]; // stats are same regardless of which abbr we pick
        // For fields with a per-ID map, PREFER the ById lookup. The per-team maps overwrite when
        // multiple pitchers share a team key (NYM has Senga + Manaea + Megill + McLean — last one
        // wins). The ID-keyed map is per-pitcher so it always returns the correct value for the
        // person we're stamping. Without this, McLean (and any pitcher who isn't "last processed"
        // for their team) loses stdBF/gs26/hasAnchor/recentKPct/lastStart* even when their data
        // is computed and stored — they just can't be retrieved.
        pitcherStatsByName[name] = {
          hand: pitcherHandById[id] ?? pitcherHand[a] ?? null,
          kPct: pitcherKPct[a] ?? null,
          kbbPct: pitcherKBBPct[a] ?? null,
          era: pitcherEra[a] ?? null,
          cswPct: pitcherCSWPct[a] ?? null,
          avgPitches: pitcherAvgPitchesById[id] ?? pitcherAvgPitches[a] ?? null,
          avgBF: pitcherAvgBFById[id] ?? pitcherAvgBF[a] ?? null,
          stdBF: pitcherStdBFById[id] ?? pitcherStdBF[a] ?? null,
          gs26: pitcherGS26ById[id] ?? pitcherGS26[a] ?? null,
          hasAnchor: pitcherHasAnchorById[id] ?? pitcherHasAnchor[a] ?? null,
          recentKPct: pitcherRecentKPctById[id] ?? pitcherRecentKPct[a] ?? null,
          lastStartDate: pitcherLastStartDateById[id] ?? pitcherLastStartDate[a] ?? null,
          lastStartPC: pitcherLastStartPCById[id] ?? pitcherLastStartPC[a] ?? null,
        };
      } else if (allScheduledPitcherIds.has(id)) {
        // Overwritten pitcher — compute stats directly from raw ID-keyed data
        const s26 = pitcherStats26[id];
        const s25 = pitcherStats25[id];
        if (!s26 && !s25) continue;
        const bf26 = s26?.bf || 0;
        const bf25 = s25?.bf || 0;
        const gs25 = s25?.gs || 0;
        const k26 = (s26 && bf26 > 0) ? s26.so / bf26 : null;
        const anchor = (s25 && bf25 >= 50) ? s25.so / bf25 : LEAGUE_PITCHER_K;
        const trust = Math.min(1.0, bf26 / 200);
        let kPct = null, kbbPct = null;
        if (k26 !== null || bf25 >= 50) {
          const kRegressed = k26 !== null ? k26 * trust + anchor * (1 - trust) : anchor;
          kPct = parseFloat((kRegressed * 100).toFixed(1));
          const kbb26 = (s26 && bf26 > 0) ? (s26.so - s26.bb) / bf26 : null;
          const anchorKBB = (s25 && bf25 >= 50) ? (s25.so - s25.bb) / bf25 : LEAGUE_PITCHER_K * 0.6;
          const kbbRegressed = kbb26 !== null ? kbb26 * trust + anchorKBB * (1 - trust) : anchorKBB;
          kbbPct = parseFloat((kbbRegressed * 100).toFixed(1));
        }
        pitcherStatsByName[name] = {
          hand: pitcherHandById[id] ?? null,
          kPct,
          kbbPct,
          era: (s26?.era ?? null) ?? (s25?.era ?? null),
          cswPct: cswByMlbId[id] ?? null,
          avgPitches: pitcherAvgPitchesById[id] ?? null,
          avgBF: pitcherAvgBFById[id] ?? null,
          stdBF: pitcherStdBFById[id] ?? 0,
          gs26: (s26?.gs > 0 ? s26.gs : null),
          hasAnchor: gs25 >= 5 && bf25 >= 100,
          recentKPct: pitcherRecentKPctById[id] ?? null,     // A1
          lastStartDate: pitcherLastStartDateById[id] ?? null, // A2
          lastStartPC: pitcherLastStartPCById[id] ?? null,    // A2
        };
      }
    }
    // pitcherInfoByTeam: team abbr → {name, id} from MLB Stats API probables
    // Used as a fallback when ESPN scoreboard hasn't announced probables yet.
    const pitcherInfoByTeam = {};
    for (const person of [...(res26.people || []), ...(res25.people || [])]) {
      const id = person.id;
      if (!id || !person.fullName) continue;
      const abbrs = Object.keys(pitcherByTeam).filter(a => pitcherByTeam[a] === id && !a.includes('|'));
      for (const a of abbrs) {
        if (!pitcherInfoByTeam[a]) pitcherInfoByTeam[a] = { name: person.fullName, id };
      }
    }
    // Per-id ERA/W-L/name. The team-keyed pitcherEra/Wins/Losses above only iterate
    // pitcherByTeam, which holds one id per team — so for doubleheaders the earlier
    // pitcher's regressed values are never stored. This loop covers every scheduled
    // pitcher (including DH game-1 starters) so the API meta build can serve per-game
    // pitcher attribution via pitcherIdByGame → id → stats.
    const pitcherEraById = {};
    const pitcherWinsById = {};
    const pitcherLossesById = {};
    const pitcherNameById = {};
    for (const person of [...(res26.people || []), ...(res25.people || [])]) {
      if (person.id && person.fullName && !pitcherNameById[person.id]) {
        pitcherNameById[person.id] = person.fullName;
      }
    }
    for (const id of allScheduledPitcherIds) {
      const s26 = pitcherStats26[id];
      const s25 = pitcherStats25[id];
      const _eraReg = _regressedRate(s26?.era ?? null, s26?.ip ?? 0, s25?.era ?? null, s25?.ip ?? 0, s26?.gs ?? 0, 4.20, 50);
      if (_eraReg != null) pitcherEraById[id] = _eraReg;
      if ((s26?.gs ?? 0) > 0 || (s26?.w ?? 0) + (s26?.l ?? 0) > 0) {
        pitcherWinsById[id] = s26.w; pitcherLossesById[id] = s26.l;
      } else if (s25 && ((s25.gs ?? 0) > 0 || (s25.w ?? 0) + (s25.l ?? 0) > 0)) {
        pitcherWinsById[id] = s25.w; pitcherLossesById[id] = s25.l;
      }
    }
    return { pitcherKPct, pitcherKBBPct, pitcherHand, pitcherEra, pitcherWHIP, pitcherFIP, pitcherWins, pitcherLosses, pitcherCSWPct, pitcherAvgPitches, pitcherAvgBF, pitcherStdBF, pitcherGS26, pitcherHasAnchor, pitcherStatsByName, pitcherRecentKPct, pitcherLastStartDate, pitcherLastStartPC, umpireByGame, pitcherInfoByTeam, pitcherH2HStarts, pitcherIdByGame, pitcherEraById, pitcherWinsById, pitcherLossesById, pitcherNameById, pitcherSplitsByTeam, pitcherSplitsById };
  } catch (err) {
    console.error("[buildPitcherKPct] failed:", err?.message || err);
    return { pitcherKPct: {}, pitcherKBBPct: {}, pitcherHand: {}, pitcherEra: {}, pitcherWHIP: {}, pitcherFIP: {}, pitcherWins: {}, pitcherLosses: {}, pitcherCSWPct: {}, pitcherAvgPitches: {}, pitcherAvgBF: {}, pitcherStdBF: {}, pitcherGS26: {}, pitcherHasAnchor: {}, pitcherRecentKPct: {}, pitcherLastStartDate: {}, pitcherLastStartPC: {}, umpireByGame: {}, pitcherInfoByTeam: {}, pitcherH2HStarts: {}, pitcherIdByGame: {}, pitcherEraById: {}, pitcherWinsById: {}, pitcherLossesById: {}, pitcherNameById: {} };
  }
}
