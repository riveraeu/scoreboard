// Player-related route handlers — headshot proxy, athlete search, ESPN gamelog fetch.
// All small, self-contained, share ESPN_BASE + warmPlayerInfoCache.
//
// Context: { path, method, request, params, env, CACHE2, ctx, warmFn, makeCacheFn,
//   ESPN_BASE, ESPN_CORE, ALLOWED_ORIGIN, jsonResponse, errorResponse }
//
// The caller injects warmFn / makeCacheFn / cors helpers rather than us importing them
// here, so the handler module stays free of cross-cutting dependencies.

export async function handlePlayerRoutes(ctx) {
  const { path, method, request, params, env, CACHE2, runtimeCtx, warmFn, makeCacheFn,
    ESPN_BASE, ESPN_CORE, ALLOWED_ORIGIN, jsonResponse, errorResponse } = ctx;

  if (path === "headshot") {
    const hsId = params.get("id");
    const hsLeague = params.get("sport") || "nba";
    const imgUrl = `https://a.espncdn.com/i/headshots/${hsLeague}/players/full/${hsId}.png`;
    const imgRes = await fetch(imgUrl, { headers: { "Referer": "https://www.espn.com/" } });
    if (!imgRes.ok) return errorResponse("Image not found", 404);
    const blob = await imgRes.arrayBuffer();
    return new Response(blob, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      },
    });
  }

  if (path === "debug-search") {
    const q = params.get("q") || "eric lauer";
    const sport = params.get("sport") || "mlb";
    const hdrs = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://www.espn.com/", "Accept": "application/json" };
    try {
      const r = await fetch(`${ESPN_BASE}/search/v2?query=${encodeURIComponent(q)}&lang=en&region=us&limit=5&type=player`, { headers: hdrs });
      const text = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      const players = (parsed?.results?.find((x) => x.type === "player")?.contents || []).filter((p) => p.defaultLeagueSlug === sport);
      return jsonResponse({ status: r.status, ok: r.ok, sport, rawLength: text.length, preview: text.slice(0, 500), playersFound: players.length, firstPlayer: players[0] || null });
    } catch (e) {
      return jsonResponse({ error: String(e) });
    }
  }

  if (path === "warm-cache") {
    runtimeCtx.waitUntil(warmFn(CACHE2 ? makeCacheFn(env) : null));
    return jsonResponse({ ok: true, message: "warmPlayerInfoCache started in background" });
  }

  if (path === "athletes") {
    const q = params.get("q") || "";
    const SUPPORTED = [
      { sport: "basketball", league: "nba" },
      { sport: "football", league: "nfl" },
      { sport: "baseball", league: "mlb" },
      { sport: "hockey", league: "nhl" },
    ];
    const searchUrl = `${ESPN_BASE}/search/v2?query=${encodeURIComponent(q)}&lang=en&region=us&limit=20&type=player`;
    const res = await fetch(searchUrl, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.espn.com/" } });
    if (!res.ok) return errorResponse(`ESPN returned ${res.status}`, res.status);
    const data = await res.json();
    const contents = (data.results?.find((r) => r.type === "player")?.contents || [])
      .filter((a) => SUPPORTED.some((s) => s.sport === a.sport && s.league === a.defaultLeagueSlug))
      .slice(0, 10);
    const items = await Promise.all(contents.map(async (a) => {
      const athleteId = a.uid?.split("~a:")?.[1] || a.id;
      const sportSlug = a.sport;
      const leagueSlug = a.defaultLeagueSlug;
      let teamId = "";
      let teamAbbr = "";
      try {
        const ar = await fetch(`${ESPN_CORE}/${sportSlug}/leagues/${leagueSlug}/athletes/${athleteId}`, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (ar.ok) {
          const ad = await ar.json();
          const ref = ad.team?.["$ref"] || "";
          const m = ref.match(/\/teams\/(\d+)/);
          if (m) teamId = m[1];
          if (ref) {
            const tr = await fetch(ref, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (tr.ok) { const td = await tr.json(); if (td.abbreviation) teamAbbr = td.abbreviation; }
          }
        }
      } catch {}
      if (!teamAbbr) {
        const rawSubtitle = a.subtitle || "";
        const firstWord = rawSubtitle.split(/[\s·\-]+/)[0].toUpperCase();
        teamAbbr = /^[A-Z]{2,4}$/.test(firstWord) ? firstWord : rawSubtitle;
      }
      return { id: athleteId, name: a.displayName, team: teamAbbr, teamId, league: leagueSlug, sportKey: `${sportSlug}/${leagueSlug}` };
    }));
    return jsonResponse({ items: items.filter((a) => a.id && a.name) });
  }

  if (path === "gamelog") {
    const sport = params.get("sport") || "basketball/nba";
    const athleteId = params.get("athleteId");
    if (!athleteId) return errorResponse("athleteId required");
    const leagueSlug = sport.split("/")[1];
    const year = params.get("season") || params.get("year") || "";
    const currentYear = new Date().getFullYear();
    const isPastSeason = year && parseInt(year) < currentYear;
    // MLB: use ESPN JSON API directly (same source as tonight endpoint) for full game history
    if (sport === "baseball/mlb") {
      const mlbApiUrl = `https://site.web.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes/${athleteId}/gamelog${year ? `?season=${year}` : ""}`;
      const mlbRes = await fetch(mlbApiUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.espn.com/",
          "Origin": "https://www.espn.com",
        },
      });
      if (!mlbRes.ok) return errorResponse(`ESPN MLB API returned ${mlbRes.status}`, mlbRes.status);
      const d = await mlbRes.json();
      const labels = d.labels || [];
      const seenIds = new Set();
      const allEvents = [];
      for (const st of d.seasonTypes || []) {
        const _stDn = (st.displayName || "").toLowerCase();
        if (_stDn.includes("pre") || _stDn.includes("spring") || _stDn.includes("exhibition")) continue;
        for (const cat of st.categories || []) {
          for (const ev of cat.events || []) {
            if (seenIds.has(ev.eventId)) continue;
            const meta = d.events?.[ev.eventId];
            if (!meta || meta.opponent?.isAllStar) continue;
            seenIds.add(ev.eventId);
            allEvents.push({
              eventId: ev.eventId,
              stats: ev.stats || [],
              date: meta.date || (meta.gameDate ? meta.gameDate.slice(0, 10) : null),
              oppAbbr: meta.opponent?.abbreviation || null,
              isHome: meta.atVs != null ? meta.atVs !== "@" : null,
            });
          }
        }
      }
      return jsonResponse({ labels, events: allEvents, totalGames: allEvents.length }, isPastSeason ? 86400 : 14400);
    }
    // ESPN JSON API for NBA/NHL/NFL (HTML scraping is WAF-blocked).
    const sportPath = { "basketball/nba": "basketball/nba", "hockey/nhl": "hockey/nhl", "football/nfl": "football/nfl" }[sport] || `${sport.split("/")[0]}/${leagueSlug}`;
    const jsonApiUrl = `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/athletes/${athleteId}/gamelog${year ? `?season=${year}` : ""}`;
    const jsonRes = await fetch(jsonApiUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": "https://www.espn.com/" },
    });
    if (!jsonRes.ok) return errorResponse(`ESPN API returned ${jsonRes.status}`, jsonRes.status);
    const d = await jsonRes.json();
    const labels = d.labels || [];
    const seenIds = new Set();
    const allEvents = [];
    for (const st of d.seasonTypes || []) {
      const _stDn = (st.displayName || "").toLowerCase();
      if (_stDn.includes("pre") || _stDn.includes("spring") || _stDn.includes("exhibition")) continue;
      for (const cat of st.categories || []) {
        for (const ev of cat.events || []) {
          if (seenIds.has(ev.eventId)) continue;
          const meta = d.events?.[ev.eventId];
          if (!meta || meta.opponent?.isAllStar) continue;
          seenIds.add(ev.eventId);
          allEvents.push({
            eventId: ev.eventId,
            stats: ev.stats || [],
            date: meta.gameDate ? meta.gameDate.slice(0, 10) : (meta.date || null),
            oppAbbr: meta.opponent?.abbreviation || null,
            isHome: meta.atVs != null ? meta.atVs !== "@" : null,
          });
        }
      }
    }
    return jsonResponse({ labels, events: allEvents, totalGames: allEvents.length }, isPastSeason ? 86400 : 14400);
  }

  return null;
}
