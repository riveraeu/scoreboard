// api/lib/tonight/golf-modelfree.js
// emitGolfModelFreePlays — PGA single-round H2H (KXPGAH2H), model-free maker.
//
// No probability model: captures Kalshi's own quoted prices as model-free rows (truePct/edge
// null). Both YES and NO sides of each market are captured independently when within the
// capture band [CAPTURE_GATE, CAPTURE_CAP].
//
// gameTime: ESPN PGA scoreboard `events[0].competitions[0].date` for the round's scheduled
// start — tournament-level (same for all pairings in one round), sufficient for the pre-game
// gate. Cache key `golf:schedule:{dateStr}` (YYYYMMDD), 2h TTL.
//
// Resolution: settlement-authoritative (golf in SETTLEMENT_AUTHORITATIVE_SPORTS). YES row has
// kalshiSide:"yes", NO row has kalshiSide:"no" — both share the same kalshiTicker.
// wonFromKalshiResult(settlement, side) grades each correctly: "yes"==="yes" → player won;
// "no"==="no" → opponent won (or tie — Kalshi voids both sides on a tie via "scalar", which
// wonFromKalshiResult returns null for, leaving the row pending until the 14d sweep).

import { CAPTURE_GATE, CAPTURE_CAP } from "../config.js";

async function getGolfRoundTime({ dateStr, cache, isBustCache }) {
  const key = `golf:schedule:${dateStr}`;
  if (!isBustCache) {
    try {
      const hit = await cache.get(key);
      if (hit) return JSON.parse(hit);
    } catch {}
  }
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${dateStr}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const gameTime = data?.events?.[0]?.competitions?.[0]?.date ?? null;
    const result = { gameTime };
    await cache.put(key, JSON.stringify(result), { expirationTtl: 7200 });
    return result;
  } catch {
    return null;
  }
}

export async function emitGolfModelFreePlays({ markets, plays, cutoffStr, cache, isBustCache }) {
  if (!markets || markets.length === 0) return;

  // One ESPN fetch per distinct round date.
  const dates = [...new Set(markets.map(m => m.gameDate).filter(Boolean))];
  const schedByDate = new Map();
  await Promise.all(dates.map(async (d) => {
    schedByDate.set(d, await getGolfRoundTime({ dateStr: d.replace(/-/g, ""), cache, isBustCache }));
  }));

  for (const m of markets) {
    if (m.gameDate && cutoffStr && m.gameDate < cutoffStr) continue;
    const gameTime = schedByDate.get(m.gameDate)?.gameTime ?? null;

    const base = {
      sport: "golf", stat: "h2h", gameType: "h2h",
      modelVersion: "golf-modelfree-v1",
      homeTeam: m.player, awayTeam: m.opponent,
      threshold: null, direction: null,
      truePct: null, edge: null,
      dataConfidence: null, dcQualified: false, qualified: false, modelFree: true,
      gameDate: m.gameDate, gameTime, eventTicker: m.eventTicker,
      kalshiVolume: m.kalshiVolume ?? null, kalshiTicker: m._ticker ?? null,
    };

    // YES side: player beats opponent
    if (m.yesPct >= CAPTURE_GATE && m.yesPct <= CAPTURE_CAP) {
      plays.push({ ...base,
        pickTeam: m.player, kalshiPct: m.yesPct, noKalshiPct: m.noPct || null,
        americanOdds: null, kalshiSide: "yes",
      });
    }

    // NO side: opponent beats player (or tie — Kalshi settles "scalar"/void on a tie)
    if (m.noPct >= CAPTURE_GATE && m.noPct <= CAPTURE_CAP) {
      plays.push({ ...base,
        pickTeam: m.opponent, kalshiPct: m.noPct, noKalshiPct: m.yesPct || null,
        americanOdds: null, kalshiSide: "no",
      });
    }
  }
}
