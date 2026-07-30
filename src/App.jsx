import React from 'react';
import { WORKER, SPORTS, GAMELOG_COLS, EDGE_HIGHLIGHT } from './lib/constants.js';
import { useIsMobile } from './lib/hooks.js';
import { useTonight } from './lib/useTonight.js';
import { useAuth } from './lib/useAuth.js';
import { useRouting } from './lib/useRouting.js';
import { usePlayerSearch } from './lib/usePlayerSearch.js';
import { useReportData } from './lib/useReportData.js';
import { useAuthFlow } from './lib/useAuthFlow.js';
import { usePlayerLoad } from './lib/usePlayerLoad.js';
import { useKalshiOdds } from './lib/useKalshiOdds.js';
import { usePlayerCardState } from './lib/usePlayerCardState.js';
import InputList from './components/InputList.jsx';
import { buildLambdaInputs, buildModelOutput } from './lib/lambdaInputs.js';
import { tierColor } from './lib/colors.js';
import { STAT_CONFIGS } from './lib/statConfigs.js';
import MakerBoardPage from './components/MakerBoardPage.jsx';

// MakerBoardPage is the default landing view and is eager-imported. TeamPage (and TotalsBarChart,
// which rides in its chunk) is the one route-gated heavy component still code-split. The taker
// LineupsPage / picks route was removed 2026-07-30.
const TeamPage = React.lazy(() => import('./components/TeamPage.jsx'));

function App() {
  const isMobile = useIsMobile();
  const [sport, setSport] = React.useState("basketball/nba"); // derived from selected player
  // player / perGame / dvpData / mlbIsPitcher / logs / logs25 / loading / error
  // + loadPlayer live in usePlayerLoad() below.
  // query / suggestions / showDrop / activeIdx / searching live in usePlayerSearch() below.
  // activeTab / selectedThreshold / showBreakdown / direction / gamelogSort live in
  // usePlayerCardState() below.
  // kalshiOdds + kalshiCache live in useKalshiOdds() below (called after safeTab is derived).
  // tonight fetch/poll/visibility state lives in useTonight() below.
  // teamPage / teamPageData / pendingSlug live in useRouting() below.
  // report* state lives in useReportData() below.
  const {
    activeTab, setActiveTab,
    selectedThreshold, setSelectedThreshold,
    showBreakdown, setShowBreakdown,
    direction, setDirection,
    gamelogSort, setGamelogSort,
  } = usePlayerCardState();
  // Kalshi balance + committed maker capital — read-only, shown on the maker board header chip.
  const [kalshiBalance, setKalshiBalance] = React.useState(null); // dollars, null = not fetched
  const [makerCommitted, setMakerCommitted] = React.useState(0); // dollars tied up in resting maker V2 orders
  const {
    authEmail,
    authMode, setAuthMode,
    authForm, setAuthForm,
    authError, setAuthError, authLoading,
    authenticate, logout: authLogout,
  } = useAuth();
  // showAuthModal + authSubmit + logout live in useAuthFlow() below.

  const selectPlayerRef = React.useRef(null);
  const {
    query, setQuery,
    suggestions, setSuggestions,
    showDrop, setShowDrop,
    activeIdx, setActiveIdx,
    searching,
    teamSuggestions,
    handleKeyDown,
    dropRef, inputRef,
  } = usePlayerSearch({ selectPlayerRef });
  const {
    player, setPlayer,
    perGame,
    dvpData,
    mlbIsPitcher,
    logs, logs25,
    loading, error,
    loadPlayer,
  } = usePlayerLoad({ setShowBreakdown });
  const {
    teamPage, setTeamPage,
    teamPageData,
    navigateToTeam, navigateToPlayer, goBack,
  } = useRouting({ setPlayer, setQuery, selectPlayerRef });
  const {
    shadowReportData, shadowReportLoading, fetchShadowReport,
  } = useReportData();

  const { tonightPlays, allTonightPlays, nbaDropped, tonightLoading } = useTonight();

  const { showAuthModal, setShowAuthModal, authSubmit, logout } = useAuthFlow({
    authenticate, authMode, authLogout,
  });

  // Read-only Kalshi balance + committed maker capital for the maker-board header chip.
  const fetchKalshiBalance = React.useCallback(async () => {
    if (!authEmail) return;
    try {
      const r = await fetch(`${WORKER}/kalshi-balance`, { credentials: "include" });
      if (!r.ok) return;
      const data = await r.json().catch(() => ({}));
      if (data.balanceDollars != null) setKalshiBalance(data.balanceDollars);
      if (data.makerCommittedDollars != null) setMakerCommitted(data.makerCommittedDollars);
    } catch {}
  }, [authEmail]);

  // Fetch on login
  React.useEffect(() => { fetchKalshiBalance(); }, [fetchKalshiBalance]);

  const selectPlayer = (p, tab = null) => {
    const newSport = p.sportKey || sport;
    setSport(newSport);
    setTeamPage(null);
    setActiveTab(tab || Object.keys(STAT_CONFIGS[newSport] || {})[0] || "points");
    setQuery(""); setSuggestions([]); setShowDrop(false); setActiveIdx(-1);
    loadPlayer(p, newSport);
  };
  // Bridge for useRouting — navigateToPlayer + pendingSlug resolution call through this ref
  // so the hook doesn't have to re-create callbacks each time selectPlayer's identity changes.
  selectPlayerRef.current = selectPlayer;

  const highlight = (name, q) => {
    const i = name.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return <span>{name}</span>;
    return (
      <span>
        {name.slice(0, i)}
        <strong style={{color:"#fff"}}>{name.slice(i, i + q.length)}</strong>
        {name.slice(i + q.length)}
      </span>
    );
  };

  const allStatCfgs = STAT_CONFIGS[sport] || {};
  // For MLB, only show tabs relevant to the player's role once we know pitcher/hitter
  const statCfgs = (() => {
    if (sport !== "baseball/mlb" || mlbIsPitcher === null) return allStatCfgs;
    const pitcherTabs = ["strikeouts"];
    const hitterTabs  = ["hrr"];
    const allowed = mlbIsPitcher ? pitcherTabs : hitterTabs;
    return Object.fromEntries(Object.entries(allStatCfgs).filter(([k]) => allowed.includes(k)));
  })();
  const tabs = Object.keys(statCfgs);
  const safeTab = tabs.includes(activeTab) ? activeTab : tabs[0];
  const cfg = statCfgs[safeTab];
  const activeLogs = logs?.[safeTab] ?? [];
  const totalGames = activeLogs.length;
  const avg = totalGames > 0 ? (activeLogs.reduce((a,b)=>a+b,0)/totalGames).toFixed(1) : "—";
  const hi  = totalGames > 0 ? Math.max(...activeLogs) : "—";
  const rates = (cfg?.thresholds || []).map(t => {
    const count = activeLogs.filter(v => v >= t).length;
    return { t, count, pct: totalGames > 0 ? (count/totalGames)*100 : 0 };
  });
  // MLB 2025 season rates (secondary bar for truePct blending)
  const isMLB = sport === "baseball/mlb";
  const activeLogs25 = isMLB ? (logs25?.[safeTab] ?? []) : [];
  const totalGames25 = activeLogs25.length;
  const rates25Map = isMLB ? Object.fromEntries((cfg?.thresholds || []).map(t => {
    const count = activeLogs25.filter(v => v >= t).length;
    return [t, totalGames25 > 0 ? (count / totalGames25) * 100 : null];
  })) : {};

  // Kalshi player-prop odds fetch — called after safeTab is derived above.
  const { kalshiOdds } = useKalshiOdds({ player, sport, safeTab });

  return (
    <div style={{maxWidth:1280,margin:"0 auto",padding:"24px 16px"}}>

      {/* Auth modal */}
      {showAuthModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
          onClick={e => { if (e.target === e.currentTarget) setShowAuthModal(false); }}>
          <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:14,padding:"28px 28px 24px",width:"100%",maxWidth:360}}>
            <div style={{display:"flex",marginBottom:20,gap:0,border:"1px solid #30363d",borderRadius:8,overflow:"hidden"}}>
              {["login","register"].map(m => (
                <button key={m} onClick={() => { setAuthMode(m); setAuthError(""); }}
                  style={{flex:1,padding:"8px 0",fontSize:13,fontWeight:600,cursor:"pointer",border:"none",
                    background: authMode===m ? "rgba(88,166,255,0.15)" : "transparent",
                    color: authMode===m ? "#58a6ff" : "#8b949e"}}>
                  {m === "login" ? "Log in" : "Create account"}
                </button>
              ))}
            </div>
            <form onSubmit={authSubmit} style={{display:"flex",flexDirection:"column",gap:12}}>
              <input type="email" placeholder="Email" required value={authForm.email}
                onChange={e => setAuthForm(f => ({...f, email:e.target.value}))}
                style={{background:"#0d1117",border:"1px solid #30363d",borderRadius:8,color:"#c9d1d9",
                  fontSize:14,padding:"10px 14px",outline:"none",width:"100%"}}/>
              <input type="password" placeholder="Password (min 6 chars)" required value={authForm.password}
                onChange={e => setAuthForm(f => ({...f, password:e.target.value}))}
                style={{background:"#0d1117",border:"1px solid #30363d",borderRadius:8,color:"#c9d1d9",
                  fontSize:14,padding:"10px 14px",outline:"none",width:"100%"}}/>
              {authError && <div style={{color:"#f78166",fontSize:12}}>{authError}</div>}
              <button type="submit" disabled={authLoading}
                style={{background:"#58a6ff",border:"none",borderRadius:8,color:"#0d1117",
                  fontSize:14,fontWeight:700,padding:"10px 0",cursor:"pointer",opacity:authLoading?0.6:1}}>
                {authLoading ? "…" : authMode === "login" ? "Log in" : "Create account"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Search + player card — constrained width */}
      <div style={{maxWidth:1280,margin:"0 auto"}}>
      {/* Full-width top row: search */}
      <div style={{marginBottom:22}}>
      <div style={{position:"relative"}}>
        <span style={{position:"absolute",left:13,top:"50%",transform:"translateY(-50%)",fontSize:15,pointerEvents:"none",zIndex:1}}>
          {searching ? "⏳" : "🔍"}
        </span>
        <input ref={inputRef} value={query}
          onChange={e => { setQuery(e.target.value); setActiveIdx(-1); }}
          onKeyDown={handleKeyDown}
          onFocus={() => (suggestions.length > 0 || (query.trim().length >= 2 && teamSuggestions.length > 0)) && setShowDrop(true)}
          placeholder={player ? `Search player… (${player.name})` : teamPage ? `Search team or player… (${teamPage.abbr})` : "Search teams, NFL, NBA, MLB, NHL players…"}
          style={{width:"100%",background:"#161b22",border:"1px solid #30363d",borderRadius:10,
            color:"#fff",fontSize:14,padding:"12px 14px 12px 40px",outline:"none"}}
        />
        {showDrop && (suggestions.length > 0 || teamSuggestions.length > 0) && (
          <div ref={dropRef} style={{position:"absolute",top:"calc(100% + 6px)",left:0,right:0,
            background:"#161b22",border:"1px solid #30363d",borderRadius:10,overflow:"hidden",
            zIndex:100,boxShadow:"0 8px 24px rgba(0,0,0,0.6)"}}>
            {teamSuggestions.map((t, i) => (
              <div key={`team-${t.abbr}-${t.sport}`}
                onMouseDown={() => { setShowDrop(false); navigateToTeam(t.abbr, t.sport); }}
                onMouseEnter={() => setActiveIdx(-(i+1))}
                style={{padding:"10px 16px",cursor:"pointer",fontSize:14,color:"#c9d1d9",
                  borderBottom:"1px solid #21262d",
                  background: activeIdx===-(i+1)?"rgba(88,166,255,0.12)":"transparent",
                  display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <img src={`https://a.espncdn.com/i/teamlogos/${t.sport}/500/${t.abbr.toLowerCase()}.png`}
                    alt={t.abbr} onError={e=>e.target.style.visibility="hidden"}
                    style={{width:28,height:28,borderRadius:6,objectFit:"contain",background:"#21262d",flexShrink:0,padding:2}}/>
                  <span>{highlight(t.name, query)}</span>
                </div>
                <span style={{color:"#484f58",fontSize:11}}>{t.sport.toUpperCase()} · {t.abbr}</span>
              </div>
            ))}
            {suggestions.map((p,i) => (
              <div key={p.id} onMouseDown={() => { setShowDrop(false); navigateToPlayer(p, null); }}
                onMouseEnter={() => setActiveIdx(i)}
                style={{padding:"10px 16px",cursor:"pointer",fontSize:14,color:"#c9d1d9",
                  borderBottom: i<suggestions.length-1?"1px solid #21262d":"none",
                  background: activeIdx===i?"rgba(88,166,255,0.12)":"transparent",
                  display:"flex",alignItems:"center",justifyContent:"space-between"}}
              >
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <img
                    src={`https://a.espncdn.com/i/headshots/${p.league || sport.split("/")[1]}/players/full/${p.id}.png`}
                    alt={p.name}
                    onError={e => {
                      e.target.onerror = null;
                      if (p.teamId && p.league) {
                        e.target.src = `https://a.espncdn.com/i/teamlogos/${p.league}/500/${p.teamId}.png`;
                      }
                    }}
                    style={{width:28,height:28,borderRadius:6,objectFit:"cover",background:"#21262d",flexShrink:0}}
                  />
                  {highlight(p.name, query)}
                </div>
                <span style={{color:"#484f58",fontSize:11}}>{p.team}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>{/* end top row */}

      {/* Team page */}
      {teamPage && (
        <React.Suspense fallback={<div style={{textAlign:'center',padding:52,color:'#8b949e',fontSize:13}}>Loading…</div>}>
        <TeamPage
          abbr={teamPage.abbr} sport={teamPage.sport}
          teamPageData={teamPageData}
          tonightPlays={tonightPlays}
          tonightLoading={tonightLoading}
          allTonightPlays={allTonightPlays}
          onBack={goBack}
          navigateToTeam={navigateToTeam}
          navigateToPlayer={navigateToPlayer}
        />
        </React.Suspense>
      )}

      {/* Player loading state — when accessed via direct URL, tonightPlays is null while the
          initial /api/tonight fetch is in-flight. Show a centered loader instead of an empty page. */}
      {player && !teamPage && tonightLoading && !tonightPlays && (
        <div style={{textAlign:'center',padding:52,color:'#8b949e',fontSize:13}}>Loading {player.name}…</div>
      )}

      {/* Player header */}
              {player && !teamPage && !(tonightLoading && !tonightPlays) && (
        <div style={{marginBottom:20}}>
        <button onClick={goBack}
          style={{background:"none",border:"none",color:"#8b949e",fontSize:13,cursor:"pointer",
            padding:"0 0 12px 0",display:"flex",alignItems:"center",gap:4}}>
          ← Back
        </button>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <img
            key={player.id}
            src={`https://a.espncdn.com/i/headshots/${sport.split("/")[1]}/players/full/${player.id}.png`}
            alt={player.name}
            style={{width:50,height:50,borderRadius:12,objectFit:"cover",background:"#161b22",flexShrink:0}}
          />
          <div style={{minWidth:0,flex:1}}>
            <h1 style={{color:"#fff",margin:0,fontSize:19,fontWeight:700}}>{player.name}</h1>
            <div style={{color:"#8b949e",fontSize:12}}>{player.team}{(() => { const opp = player.opponent || (tonightPlays || []).find(p => (p.playerId && p.playerId === player.id) || p.playerName?.toLowerCase() === player.name?.toLowerCase())?.opponent; const oppSport = (player.sportKey||sport).split("/")[1]; return opp ? <> · <span style={{color:"#58a6ff",cursor:"pointer",textDecoration:"underline",textDecorationColor:"rgba(88,166,255,0.4)"}} onClick={()=>navigateToTeam(opp,oppSport)}>vs {opp}</span></> : ""; })()} · {SPORTS.find(s=>s.value===(player.sportKey||sport))?.label} 2025-26</div>
            {(() => {
              const _pp = (allTonightPlays || tonightPlays || []).filter(p => (p.playerId && p.playerId === player.id) || p.playerName?.toLowerCase() === player.name?.toLowerCase()).sort((a,b) => (a.gameDate||"").localeCompare(b.gameDate||""));
              const gt = _pp[0]?.gameTime;
              if (!gt) return null;
              const d = new Date(gt);
              const ptFmt = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"});
              const gamePT = ptFmt.format(d), todayPT = ptFmt.format(new Date()), tmrwPT = ptFmt.format(new Date(Date.now()+86400000));
              const dayLabel = gamePT === todayPT ? "Today" : gamePT === tmrwPT ? "Tomorrow" : new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric"}).format(d);
              const timePart = new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",minute:"2-digit",hour12:true}).format(d);
              return <div style={{color:"#6e7681",fontSize:11,marginTop:2}}>{dayLabel} · {timePart} PT</div>;
            })()}
          </div>
          {!isMobile && (
            <div style={{marginLeft:"auto",display:"flex",gap:8}}>
              {[["AVG",avg],["HIGH",hi],["GP",totalGames]].map(([l,v]) => (
                <div key={l} style={{background:"#161b22",border:"1px solid #30363d",borderRadius:8,padding:"7px 11px",textAlign:"center"}}>
                  <div style={{color:"#58a6ff",fontSize:16,fontWeight:700}}>{loading?"…":v}</div>
                  <div style={{color:"#8b949e",fontSize:10}}>{l}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {isMobile && (
          <div style={{display:"flex",gap:8,marginTop:12}}>
            {[["AVG",avg],["HIGH",hi],["GP",totalGames]].map(([l,v]) => (
              <div key={l} style={{flex:1,background:"#161b22",border:"1px solid #30363d",borderRadius:8,padding:"7px 11px",textAlign:"center"}}>
                <div style={{color:"#58a6ff",fontSize:16,fontWeight:700}}>{loading?"…":v}</div>
                <div style={{color:"#8b949e",fontSize:10}}>{l}</div>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {/* Stat tabs */}
      {player && !teamPage && !(tonightLoading && !tonightPlays) && (
        <div style={{display:"flex",gap:6,marginBottom:18}}>
          {tabs.map(k => (
            <button key={k} onClick={() => { setActiveTab(k); setDirection("over"); setSelectedThreshold(null); }} style={{flex:1,padding:"9px 0",borderRadius:8,
              border:"1px solid",cursor:"pointer",fontSize:13,
              borderColor: safeTab===k?"#58a6ff":"#30363d",
              background: safeTab===k?"rgba(88,166,255,0.12)":"#161b22",
              color: safeTab===k?"#58a6ff":"#8b949e",
              fontWeight: safeTab===k?700:400}}>
              {statCfgs[k].label}
            </button>
          ))}
        </div>
      )}

      {/* Combined chart: Season + Soft Matchup + True Probability */}
      {player && !teamPage && !(tonightLoading && !tonightPlays) && (() => {
        const hasDvp = dvpData && perGame.length > 0 && !loading && totalGames > 0;
        const isMLB = sport === "baseball/mlb";
        const WEAK_N = 10;
        let dvpMap = {}, wTotal = 0, weakTeamList = [];
        let mlbH2HOpp = isMLB ? (dvpData?.h2h?.opp || null) : null;
        let isLastMatchupFallback = false;
        // MLB: resolve matchup opponent — tonight's opp first, then cascade to most recent game with h2h data
        if (isMLB && perGame.length > 0) {
          const findLastOpp = () => [...perGame].reverse().find(g => g.oppAbbr && g[safeTab] !== undefined)?.oppAbbr ?? null;
          if (!mlbH2HOpp) {
            mlbH2HOpp = findLastOpp();
            if (mlbH2HOpp) isLastMatchupFallback = true;
          } else {
            // Tonight's opponent set — check if we actually have h2h history; if not, fall back to most recent
            const hasH2H = perGame.some(g => g.oppAbbr === mlbH2HOpp && g[safeTab] !== undefined);
            if (!hasH2H) {
              mlbH2HOpp = findLastOpp();
              if (mlbH2HOpp) isLastMatchupFallback = true;
            }
          }
        }
        if (hasDvp) {
          if (!isMLB) {
            // NBA/NHL/NFL: soft team ranking mode
            const softAbbrs = dvpData.softTeams?.[safeTab]?.length
              ? new Set(dvpData.softTeams[safeTab])
              : new Set((dvpData.teams || []).filter(t => t.rank <= WEAK_N).map(t => t.abbr));
            const weakGames = perGame.filter(g => softAbbrs.has(g.oppAbbr));
            wTotal = weakGames.length;
            weakTeamList = (dvpData.teams || [])
              .filter(t => softAbbrs.has(t.abbr))
              .filter(t => perGame.some(g => g.oppAbbr === t.abbr));
            if (wTotal > 0) {
              (cfg?.thresholds || []).forEach(t => {
                const wCount = weakGames.filter(g => (g[safeTab] ?? -1) >= t).length;
                dvpMap[t] = { wCount, wPct: (wCount / wTotal) * 100 };
              });
            }
          } else if (isMLB) {
            const allLkp = dvpData?.allLineupKPct || {};
            const tonightLkp = dvpData?.h2h?.lineupKPct
              ?? (tonightPlays || []).find(p => (p.playerId === player?.id || p.playerName === player?.name) && p.stat === "strikeouts")?.lineupKPct
              ?? null;
            if (safeTab === "strikeouts" && tonightLkp !== null && Object.keys(allLkp).length > 0) {
              // Pitcher strikeouts: bucket by tonight's opponent K rate (low/avg/high)
              const lkpBucket = tonightLkp >= 24 ? "high" : tonightLkp >= 20 ? "avg" : "low";
              const similarKAbbrs = new Set(
                Object.entries(allLkp)
                  .filter(([, k]) => lkpBucket === "high" ? k >= 24 : lkpBucket === "avg" ? (k >= 20 && k < 24) : k < 20)
                  .map(([a]) => a)
              );
              const _bucketFilter = g => g.oppAbbr && similarKAbbrs.has(g.oppAbbr) && g[safeTab] !== undefined;
              const bucketGames26 = perGame.filter(g => g.season === 2026 && _bucketFilter(g));
              const bucketGames25 = perGame.filter(g => g.season === 2025 && _bucketFilter(g));
              const bucketGamesAll = perGame.filter(g => _bucketFilter(g));
              // Prefer 2026 (15+ BF proxy: 3+ starts), fall back to 25+26 (3+), then all career
              const bucketGames = bucketGames26.length >= 3 ? bucketGames26
                : (bucketGames26.length + bucketGames25.length) >= 3 ? [...bucketGames25, ...bucketGames26]
                : bucketGamesAll;
              wTotal = bucketGames.length;
              if (wTotal >= 1) {
                (cfg?.thresholds || []).forEach(t => {
                  const wCount = bucketGames.filter(g => (g[safeTab] ?? -1) >= t).length;
                  dvpMap[t] = { wCount, wPct: (wCount / wTotal) * 100 };
                });
              } else {
                wTotal = 0; // no data
              }
            }
            // If bucket mode found no games, fall back to h2h vs resolved opponent (min 1)
            if (wTotal === 0 && mlbH2HOpp) {
              const h2hGames = perGame.filter(g => g.oppAbbr === mlbH2HOpp && g[safeTab] !== undefined);
              if (h2hGames.length >= 1) {
                wTotal = h2hGames.length;
                (cfg?.thresholds || []).forEach(t => {
                  const wCount = h2hGames.filter(g => (g[safeTab] ?? -1) >= t).length;
                  dvpMap[t] = { wCount, wPct: (wCount / wTotal) * 100 };
                });
              }
            }
          }
        }

        // Tonight plays for this player — keyed by "stat|threshold" for consistent truePct/Kalshi.
        // Uses allTonightPlays (unfiltered) so qualified:false plays (e.g. 3+/4+ strikeouts with no edge)
        // still provide their simulation-based truePct rather than falling back to the raw formula.
        const tonightPlayerMap = {};
        if (allTonightPlays && player) {
          for (const p of allTonightPlays) {
            if (p.playerId === player.id || p.playerName === player.name) {
              tonightPlayerMap[`${p.stat}|${p.threshold}`] = p;
            }
          }
        }
        // Fill in NBA opp_not_soft drops (have pace/minutes/B2B/SimScore data) without overwriting real plays
        if (nbaDropped && player) {
          for (const p of nbaDropped) {
            if (p.playerId === player.id || p.playerName === player.name) {
              const key = `${p.stat}|${p.threshold}`;
              if (!tonightPlayerMap[key]) tonightPlayerMap[key] = p;
            }
          }
        }
        const hasTonightData = Object.values(tonightPlayerMap).some(p => p.stat === safeTab);
        const showTriple = (hasDvp && (wTotal > 0 || (isMLB && totalGames25 >= 5))) || hasTonightData;
        // Fallback: if dvpData.h2h is missing (team not found in probables), use tonight play data
        if (isMLB && !mlbH2HOpp && safeTab === "strikeouts") {
          const anyStrikeoutsPlay = Object.values(tonightPlayerMap).find(p => p.stat === "strikeouts");
          if (anyStrikeoutsPlay?.opponent) mlbH2HOpp = anyStrikeoutsPlay.opponent;
        }
        // Explanation shows whenever dvp data is loaded — even for pitchers with 0 starts this season
        // Fallback opponent for non-MLB sports when no tonight's game
        const tonightOpp = Object.values(tonightPlayerMap).find(p => p.opponent)?.opponent ?? null;
        const lastPerGameOpp = !player.opponent && !tonightOpp && !isMLB && perGame.length > 0
          ? ([...perGame].reverse().find(g => g.oppAbbr)?.oppAbbr ?? null)
          : null;
        const effectiveOpp = player.opponent || tonightOpp || lastPerGameOpp;
        const isOppFallback = !player.opponent && !tonightOpp && !!lastPerGameOpp;
        const showExplanation = !loading && !error && (dvpData && (mlbH2HOpp || dvpData.position));
        // Tab-specific opponent rank from dvpData.rankMaps (NBA only)
        const tabRankEntry = (!isMLB && dvpData?.rankMaps?.[safeTab] && effectiveOpp)
          ? (dvpData.rankMaps[safeTab][effectiveOpp] || null)
          : null;
        const tabOppRank = tabRankEntry?.rank ?? player?.oppRank ?? null;
        const tabOppMetricValue = tabRankEntry?.value ?? player?.oppMetricValue ?? null;
        const tabOppMetricLabel = tabRankEntry?.label ?? player?.oppMetricLabel ?? null;

        return (
          <div style={{background:"#161b22",border:"1px solid #30363d",borderRadius:12,padding:"20px 22px"}}>
            {loading ? (
              <div style={{color:"#8b949e",textAlign:"center",padding:48,fontSize:13}}>⏳ Loading game log…</div>
            ) : error ? (
              <div style={{color:"#f78166",textAlign:"center",padding:48,fontSize:13}}>⚠️ {error}</div>
            ) : totalGames === 0 ? (
              <div style={{color:"#8b949e",textAlign:"center",padding:48,fontSize:13}}>No game data found.</div>
            ) : (
              <>
                {/* Explanation at top — follows the active threshold tab (selectedThreshold).
                    Default = first qualified threshold for the stat, else lowest-numbered.
                    Falls through when no tonight play exists for the active stat. */}
                {showExplanation && (() => {
                  const _hasK = Object.keys(kalshiOdds).length > 0;
                  const _allRates = _hasK ? rates.filter(({t}) => kalshiOdds[t]) : rates;
                  const _qm = {};
                  for (const {t} of _allRates) {
                    const tp = tonightPlayerMap[`${safeTab}|${t}`];
                    _qm[t] = !!tp && (tp.edge ?? 0) >= EDGE_HIGHLIGHT;
                  }
                  const _defaultT = _allRates.find(({t}) => _qm[t])?.t ?? _allRates[0]?.t ?? null;
                  const _activeT = selectedThreshold != null && _allRates.some(r => r.t === selectedThreshold)
                    ? selectedThreshold : _defaultT;
                  const activePlay = _activeT != null
                    ? tonightPlayerMap[`${safeTab}|${_activeT}`]
                    : (Object.values(tonightPlayerMap).find(p => p.stat === safeTab) || null);
                  if (!activePlay) return null;
                  return (
                    <div style={{background:"#0d1117",borderRadius:8,padding:"8px 12px",marginBottom:12}}>
                      <InputList inputs={buildLambdaInputs({ ...activePlay, direction })} output={buildModelOutput(activePlay)} />
                    </div>
                  );
                })()}

                {showTriple && !isMLB && (
                  <div style={{color:"#8b949e",fontSize:11,marginBottom:14}}>
                    Soft matchup teams <span style={{color:"#484f58"}}>({wTotal}/{totalGames}g)</span>: {weakTeamList.map(t => t.abbr).join(" · ")}
                  </div>
                )}

                {/* Per-threshold tab strip — show one tab per available threshold (ones where the
                    model's edge ≥ EDGE_HIGHLIGHT get a green highlight). Click to drill into that
                    threshold's row + lambda inputs. No-op when only one threshold is available. */}
                {(() => {
                  const hasK = Object.keys(kalshiOdds).length > 0;
                  const tabRates = hasK ? rates.filter(({t}) => kalshiOdds[t]) : rates;
                  if (tabRates.length <= 1) return null;
                  const qualMap = {};
                  for (const {t} of tabRates) {
                    const tp = tonightPlayerMap[`${safeTab}|${t}`];
                    qualMap[t] = !!tp && (tp.edge ?? 0) >= EDGE_HIGHLIGHT;
                  }
                  const defaultT = tabRates.find(({t}) => qualMap[t])?.t ?? tabRates[0]?.t ?? null;
                  const activeT = selectedThreshold != null && tabRates.some(r => r.t === selectedThreshold)
                    ? selectedThreshold : defaultT;
                  return (
                    <div style={{display:"flex",gap:4,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
                      {tabRates.map(({t}) => {
                        const active = t === activeT;
                        const q = qualMap[t];
                        const label = direction === "under" ? `<${t}` : `${t}+`;
                        return (
                          <button key={t} onClick={() => setSelectedThreshold(t)}
                            style={{padding:"5px 10px",borderRadius:6,
                              border:`1px solid ${active ? "#58a6ff" : q ? "#3fb950" : "#30363d"}`,
                              background: active ? "rgba(88,166,255,0.12)" : q ? "rgba(63,185,80,0.08)" : "#161b22",
                              color: active ? "#58a6ff" : q ? "#3fb950" : "#8b949e",
                              fontSize:11,fontWeight: active ? 700 : 500,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Threshold rows — filter to Kalshi thresholds when available, then drill into
                    selectedThreshold (single-row render). Lambda InputList rendered after the row. */}
                {(() => {
                  const hasKalshi = Object.keys(kalshiOdds).length > 0;
                  const allRates = hasKalshi ? rates.filter(({t}) => kalshiOdds[t]) : rates;
                  // Default to first qualified threshold, fall back to first available
                  const _qm = {};
                  for (const {t} of allRates) {
                    const tp = tonightPlayerMap[`${safeTab}|${t}`];
                    _qm[t] = !!tp && (tp.edge ?? 0) >= EDGE_HIGHLIGHT;
                  }
                  const _defaultT = allRates.find(({t}) => _qm[t])?.t ?? allRates[0]?.t ?? null;
                  const _activeT = selectedThreshold != null && allRates.some(r => r.t === selectedThreshold)
                    ? selectedThreshold : _defaultT;
                  const displayRates = allRates.filter(({t}) => t === _activeT);
                  // Pre-compute raw truePct per threshold. Track which thresholds have API truePct
                  // so the monotonicity walk doesn't let a noisy fallback value lift an API value.
                  const _rawTruePctMap = {};
                  const _apiThresholds = new Set();
                  for (const {t, pct: pctOver} of displayRates) {
                    const _tp = tonightPlayerMap[`${safeTab}|${t}`];
                    const _pct = pctOver;
                    const _dvp = dvpMap[t];
                    const _softPctRaw = isMLB ? (_dvp?.wPct ?? null) : (_tp?.softPct != null ? _tp.softPct : (_dvp?.wPct ?? null));
                    const _truePctRaw = (_tp && _tp.truePct != null) ? _tp.truePct : (_softPctRaw !== null ? (_pct + _softPctRaw) / 2 : null);
                    _rawTruePctMap[t] = _truePctRaw;
                    if (_tp && _tp.truePct != null) _apiThresholds.add(t);
                  }
                  // Enforce monotonicity only across API-sourced thresholds (P(X>=3) >= P(X>=4) >= ...).
                  // Fallback-derived values (e.g. naive (season+soft)/2 for thresholds outside the
                  // 70–97% Kalshi band) are left untouched so they can't lift the model's API values.
                  { const _mts = [..._apiThresholds].filter(t => _rawTruePctMap[t] != null).sort((a,b) => b-a);
                    let _mx = 0;
                    for (const _t of _mts) { if (_rawTruePctMap[_t] < _mx) _rawTruePctMap[_t] = _mx; else _mx = _rawTruePctMap[_t]; } }
                  // Cap fallback thresholds above an API anchor: P(X>=t) cannot exceed P(X>=t') for t > t'.
                  // Walk low→high; once an API value is seen, every later (higher-threshold) fallback is capped at it.
                  { const _ts = [...new Set(displayRates.map(r => r.t))].sort((a,b) => a-b);
                    let _apiCap = null;
                    for (const _t of _ts) {
                      if (_apiThresholds.has(_t)) { _apiCap = _rawTruePctMap[_t]; }
                      else if (_apiCap != null && _rawTruePctMap[_t] != null && _rawTruePctMap[_t] > _apiCap) {
                        _rawTruePctMap[_t] = _apiCap;
                      }
                    } }
                  return displayRates.map(({t, count: countOver, pct: pctOver}) => {
                    // Use exact threshold's tonight play — never cross-contaminate softPct from a different threshold
                    const tonightPlay = tonightPlayerMap[`${safeTab}|${t}`];
                    // A server-flipped under play (hrr NO-side, totalBases) renders as an under row
                    // regardless of the card's over/under browse toggle — the bet side IS under.
                    const _tpUnder = tonightPlay?.direction === "under";
                    const isUnder = direction === "under" || _tpUnder;
                    // Flip all hit-rate values for "under" direction
                    const count = isUnder ? (totalGames - countOver) : countOver;
                    const pct   = isUnder ? 100 - pctOver : pctOver;
                    const dvp = dvpMap[t];
                    // MLB: always use dvpMap h2h rate for consistency across all thresholds
                    // Non-MLB: prefer tonight play's pre-computed soft rate, fall back to dvpMap
                    const softPctRaw = isMLB
                      ? (dvp?.wPct ?? null)
                      : (tonightPlay?.softPct != null ? tonightPlay.softPct : (dvp?.wPct ?? null));
                    const _lkpBucketLabel = (() => {
                      if (!isMLB || safeTab !== "strikeouts") return null;
                      const lkp = dvpData?.h2h?.lineupKPct ?? Object.values(tonightPlayerMap).find(p => p.stat === "strikeouts")?.lineupKPct ?? null;
                      if (lkp == null) return null;
                      return lkp >= 24 ? "high" : lkp >= 20 ? "avg" : "low";
                    })();
                    const _pitcherHandLabel = (() => {
                      const hand = dvpData?.h2h?.pitcherHand ?? null;
                      return hand === "R" ? " vs RHP" : hand === "L" ? " vs LHP" : "";
                    })();
                    const softGamesLabel = isMLB
                      ? (_lkpBucketLabel
                          ? (dvp ? `${_lkpBucketLabel}-K lineups${_pitcherHandLabel} (${dvp.wCount}/${wTotal}g)` : "")
                          : (dvp ? `vs ${mlbH2HOpp} (${dvp.wCount}/${wTotal}g)` :
                             (tonightTabPlay?.matchupPct != null ? `${(tonightTabPlay.oppMetricLabel || "").replace(/\s*\(\d+g\)\s*$/, "")}${tonightTabPlay.matchupGames ? ` (${tonightTabPlay.matchupGames}g)` : ""}` : "")))
                      : (tonightPlay?.softPct != null
                          ? (tonightPlay.opponent ? `vs ${tonightPlay.opponent}${tonightPlay.softGames ? ` (${tonightPlay.softGames}g)` : ""}` : (tonightPlay.softGames ? `${tonightPlay.softGames}g` : ""))
                          : (dvp ? `${dvp.wCount}/${wTotal}g` : ""));
                    const softPct = isUnder ? (softPctRaw !== null ? 100 - softPctRaw : null) : softPctRaw;
                    // truePct = avg(seasonPct, matchupPct) — use monotonicity-enforced pre-computed value
                    const truePct = (() => {
                      // Server-flipped rows: the model's under-side true% (noTruePct, else complement).
                      if (isUnder && _tpUnder && tonightPlay.truePct != null)
                        return tonightPlay.noTruePct ?? parseFloat((100 - tonightPlay.truePct).toFixed(1));
                      if (!isUnder && _rawTruePctMap[t] != null) return _rawTruePctMap[t];
                      return softPct !== null ? (pct + softPct) / 2 : null;
                    })();
                    // Prefer tonight endpoint's Kalshi data when its framing matches the row.
                    // Flipped rows carry the REAL NO book (noKalshiPct + NO-side americanOdds) —
                    // use it directly; the synthetic 100−yes complement is a browse-only fallback
                    // (YES/NO books are independent, complement ≠ fill price — see CLAUDE.md).
                    const kRawLocal = kalshiOdds[t];
                    const kTonightRaw = tonightPlay && (isUnder === _tpUnder)
                      ? (_tpUnder
                          ? { pct: Math.round(tonightPlay.noKalshiPct ?? (100 - tonightPlay.kalshiPct)), americanOdds: tonightPlay.americanOdds }
                          : { pct: tonightPlay.kalshiPct, americanOdds: tonightPlay.americanOdds })
                      : null;
                    const kRaw = kTonightRaw || kRawLocal;
                    const k = (kRaw && isUnder && !kTonightRaw) ? { ...kRaw, pct: 100 - kRaw.pct, americanOdds: kRaw.pct >= 50 ? Math.round(((kRaw.pct) / (100 - kRaw.pct)) * 100) : -Math.round(((100 - kRaw.pct) / kRaw.pct) * 100) } : kRaw;
                    const oddsStr = k ? (k.americanOdds >= 0 ? `+${k.americanOdds}` : `${k.americanOdds}`) : null;
                    // Use API net edge when its framing matches the row (flipped rows' edge is
                    // already bet-side); fallback recomputes raw edge from the row's own framing
                    const edge = (tonightPlay?.edge != null && isUnder === _tpUnder) ? tonightPlay.edge : (truePct !== null && k) ? truePct - k.pct : null;
                    const edgeColor = edge === null ? null : edge >= EDGE_HIGHLIGHT ? "#3fb950" : edge >= 0 ? "#e3b341" : "#f78166";
                    const edgeStr = edge === null ? null : (edge >= 0 ? `+${edge.toFixed(1)}%` : `${edge.toFixed(1)}%`);

                    if (!showTriple) {
                      // Non-NBA / no DvP: season bar + optional Kalshi + matchup
                      const color = tierColor(pct);
                      return (
                        <div key={t} style={{display:"flex",gap:10,marginBottom:14,alignItems:"flex-start"}}>
                          <div style={{color:"#8b949e",fontSize:13,width:40,textAlign:"right",flexShrink:0,paddingTop:2}}>{isUnder ? `<${t}` : `${t}+`}</div>
                          <div style={{flex:1,display:"flex",flexDirection:"column",gap:5}}>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <div style={{flex:1,background:"#21262d",borderRadius:5,height:18,overflow:"hidden"}}>
                                <div style={{width:`${pct}%`,background:color,height:"100%",borderRadius:5,transition:"width 0.5s ease",minWidth:pct>0?4:0}}/>
                              </div>
                              <div style={{color,fontSize:13,fontWeight:700,width:42,textAlign:"right",flexShrink:0}}>{pct.toFixed(1)}%</div>
                              {!isMobile && <div style={{color:"#8b949e",fontSize:11,width:80,flexShrink:0}}>{count}/{totalGames}g</div>}
                            </div>
                            {k && (
                              <div style={{display:"flex",alignItems:"center",gap:8}}>
                                <div style={{flex:1,background:"#21262d",borderRadius:4,height:13,overflow:"hidden"}}>
                                  <div style={{width:`${k.pct}%`,background:tierColor(k.pct),height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:k.pct>0?3:0}}/>
                                </div>
                                <div style={{color:tierColor(k.pct),fontSize:11,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{k.pct}%</div>
                                <div style={{flexShrink:0,width:80,display:"flex",alignItems:"center",gap:4}}>
                                  <div style={{color:"#6e40c9",fontSize:10,flex:1}}>({oddsStr})</div>
                                </div>
                              </div>
                            )}
                            {softPct !== null && (
                              <div style={{display:"flex",alignItems:"center",gap:8}}>
                                {(() => {
                                  const mc = tierColor(softPct);
                                  return <>
                                    <div style={{flex:1,background:"#21262d",borderRadius:4,height:13,overflow:"hidden"}}>
                                      <div style={{width:`${softPct}%`,background:mc,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:softPct>0?3:0}}/>
                                    </div>
                                    <div style={{color:mc,fontSize:11,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{softPct.toFixed(1)}%</div>
                                    {!isMobile && <div title={softGamesLabel} style={{color:"#8b949e",fontSize:10,width:80,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{softGamesLabel}</div>}
                                  </>;
                                })()}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }

                    // Triple mode: True probability + Kalshi primary, season/soft in drawer
                    return (
                      <div key={t} style={{marginBottom:14}}>
                        <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                          <div style={{color:"#8b949e",fontSize:13,width:40,textAlign:"right",flexShrink:0,paddingTop:2}}>{isUnder ? `<${t}` : `${t}+`}</div>
                          <div style={{flex:1,display:"flex",flexDirection:"column",gap:5}}>
                            {/* True probability — primary */}
                            {(() => {
                              const displayPct = truePct != null ? truePct : (hasKalshi ? null : pct);
                              const displayColor = tierColor(displayPct ?? 0);
                              return (
                                <div style={{display:"flex",flexDirection:"column",gap:5}}>
                                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                                    <div style={{flex:1,background:"#21262d",borderRadius:4,height:16,overflow:"hidden"}}>
                                      {displayPct != null && <div style={{width:`${displayPct}%`,background:displayColor,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:displayPct>0?3:0}}/>}
                                    </div>
                                    <div style={{color:displayPct != null ? displayColor : "#8b949e",fontSize:13,fontWeight:700,width:42,textAlign:"right",flexShrink:0}}>{displayPct != null ? `${displayPct.toFixed(1)}%` : "—"}</div>
                                    <div style={{width:90,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"flex-start",paddingLeft:2,gap:4}}>
                                      {edgeStr && (
                                        <span style={{background:edgeColor+"22",border:`1px solid ${edgeColor}`,borderRadius:4,padding:"1px 5px",fontSize:10,fontWeight:700,color:edgeColor,whiteSpace:"nowrap"}}>
                                          {edgeStr}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  {/* Odds bar */}
                                  {k && (
                                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:11,overflow:"hidden"}}>
                                        <div style={{width:`${k.pct}%`,background:"#6e40c9",height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:k.pct>0?2:0}}/>
                                      </div>
                                      <div style={{color:"#6e40c9",fontSize:11,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{k.pct.toFixed(1)}%</div>
                                      <div style={{color:"#6e40c9",fontSize:10,width:90,flexShrink:0,paddingLeft:2}}>({oddsStr})</div>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            {/* Drawer: season rate + matchup rate + odds */}
                            {showBreakdown && !isMLB && (
                              <div style={{borderLeft:"2px solid #30363d",paddingLeft:10,marginTop:2,display:"flex",flexDirection:"column",gap:4}}>
                                {/* Season hit rate */}
                                <div style={{display:"flex",alignItems:"center",gap:8}}>
                                  <div style={{flex:1,background:"#21262d",borderRadius:4,height:11,overflow:"hidden"}}>
                                    <div style={{width:`${pct}%`,background:tierColor(pct),height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:pct>0?2:0}}/>
                                  </div>
                                  <div style={{color:tierColor(pct),fontSize:10,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{pct.toFixed(1)}%</div>
                                  {!isMobile && <div style={{color:"#8b949e",fontSize:10,width:80,flexShrink:0}}>{isMLB ? `'25+'26 (${totalGames}g)` : `${count}/${totalGames}g`}</div>}
                                </div>
                                {/* Matchup rate */}
                                {softPct !== null && (() => {
                                  const mc = tierColor(softPct);
                                  return (
                                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                                      <div style={{flex:1,background:"#21262d",borderRadius:4,height:11,overflow:"hidden"}}>
                                        <div style={{width:`${softPct}%`,background:mc,height:"100%",borderRadius:4,transition:"width 0.5s ease",minWidth:softPct>0?2:0}}/>
                                      </div>
                                      <div style={{color:mc,fontSize:10,fontWeight:600,width:42,textAlign:"right",flexShrink:0}}>{softPct.toFixed(1)}%</div>
                                      {!isMobile && <div title={softGamesLabel} style={{color:"#8b949e",fontSize:10,width:80,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{softGamesLabel}</div>}
                                    </div>
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}

                {/* Footer */}
                <div style={{marginTop:8,paddingTop:12,borderTop:"1px solid #21262d",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                  {showTriple && !isMLB && (
                    <button onClick={() => setShowBreakdown(b => !b)}
                      style={{background:"transparent",border:"1px solid #30363d",borderRadius:6,
                        color:"#8b949e",fontSize:11,padding:"3px 10px",cursor:"pointer"}}>
                      {showBreakdown ? "▲ Hide breakdown" : "▼ Show breakdown"}
                    </button>
                  )}
                  <div style={{display:"flex",gap:12,flexWrap:"wrap",fontSize:11,color:"#484f58",marginLeft:"auto"}}>
                    {showTriple
                      ? <><span><span style={{color:"#58a6ff",fontWeight:600}}>Color</span> = ≥90% green · ≥80% blue · ≥70% yellow · else red</span>
                          {Object.keys(kalshiOdds).length > 0 && <span><span style={{color:"#3fb950",fontWeight:600}}>+edge</span> / <span style={{color:"#f78166",fontWeight:600}}>−edge</span> vs market</span>}</>
                      : Object.keys(kalshiOdds).length > 0
                        ? <span>Color = ≥90% green · ≥80% blue · ≥70% yellow · else red</span>
                        : <span style={{color:"#8b949e"}}>Season hit rate</span>
                    }
                  </div>
                </div>

                {/* Gamelog table */}
                {(() => {
                  const glKey = sport === "baseball/mlb"
                    ? (mlbIsPitcher ? "baseball/mlb_pitcher" : "baseball/mlb_hitter")
                    : sport;
                  const cols = GAMELOG_COLS[glKey];
                  if (!cols || perGame.length === 0) return null;

                  // Filter to current season (derived from date year)
                  const seasons = perGame.map(r => r.season).filter(s => s != null);
                  const currentSeason = seasons.length > 0 ? Math.max(...seasons) : null;
                  const seasonRows = currentSeason != null
                    ? perGame.filter(r => r.season === currentSeason)
                    : perGame;
                  if (seasonRows.length === 0) return null;

                  // Compute rest days (days since prior game) without mutating perGame
                  const byDateAsc = [...seasonRows].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
                  const restMap = new Map();
                  byDateAsc.forEach((row, i) => {
                    const rest = (i > 0 && row.date && byDateAsc[i-1].date)
                      ? Math.round((new Date(row.date) - new Date(byDateAsc[i-1].date)) / 86400000)
                      : null;
                    restMap.set(row, rest);
                  });

                  // TOI: parse "MM:SS" or decimal-minutes → total seconds for sorting
                  const toiToSec = v => {
                    if (v == null) return -1;
                    const s = String(v);
                    if (s.includes(':')) { const [m, sec] = s.split(':').map(Number); return m * 60 + (sec || 0); }
                    const f = parseFloat(s); return isNaN(f) ? -1 : Math.round(f * 60);
                  };
                  // Format TOI for display
                  const fmtToi = v => {
                    if (v == null) return '—';
                    const s = String(v);
                    if (s.includes(':')) return s;
                    const f = parseFloat(s);
                    if (isNaN(f)) return s;
                    return `${Math.floor(f)}:${String(Math.round((f % 1) * 60)).padStart(2, '0')}`;
                  };

                  // Sort
                  const { col: sCol, dir: sDir } = gamelogSort;
                  const sorted = [...seasonRows].sort((a, b) => {
                    let av, bv;
                    if (sCol === 'rest') { av = restMap.get(a); bv = restMap.get(b); }
                    else if (sCol === 'toi') { av = toiToSec(a.toi); bv = toiToSec(b.toi); }
                    else { av = a[sCol] ?? null; bv = b[sCol] ?? null; }
                    if (av === null && bv === null) return 0;
                    if (av === null) return 1;
                    if (bv === null) return -1;
                    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
                    return sDir === 'asc' ? cmp : -cmp;
                  });

                  const handleSort = key => setGamelogSort(prev => ({
                    col: key,
                    dir: prev.col === key ? (prev.dir === 'desc' ? 'asc' : 'desc') : 'desc',
                  }));

                  // Active stat column highlight: maps safeTab → column key
                  const activeColKey = {
                    strikeouts: 'strikeouts', hits: 'hits', hrr: 'hrr',
                    points: 'points', rebounds: 'rebounds', assists: 'assists', threePointers: 'threePointers',
                  }[safeTab] ?? null;

                  return (
                    <div style={{marginTop:16,borderTop:"1px solid #21262d",paddingTop:14}}>
                      <div style={{fontSize:11,color:"#484f58",marginBottom:8}}>
                        {currentSeason ? `${currentSeason} season` : "Season"} · {seasonRows.length} games
                      </div>
                      <div style={{overflowX:"auto",overflowY:"auto",maxHeight:280,borderRadius:6,border:"1px solid #21262d"}}>
                        <table style={{width:"100%",minWidth:520,borderCollapse:"collapse",fontSize:11}}>
                          <thead>
                            <tr style={{position:"sticky",top:0,background:"#1c2128",zIndex:2}}>
                              {cols.map(c => {
                                const isSortActive = c.key === sCol;
                                const isStatCol = c.key === activeColKey;
                                return (
                                  <th key={c.key} onClick={() => handleSort(c.key)} style={{
                                    padding:"5px 8px",
                                    textAlign: c.align || 'right',
                                    color: isStatCol ? "#58a6ff" : isSortActive ? "#c9d1d9" : "#8b949e",
                                    fontWeight: isSortActive ? 700 : 500,
                                    cursor:"pointer",
                                    whiteSpace:"nowrap",
                                    userSelect:"none",
                                    borderBottom:"1px solid #30363d",
                                  }}>
                                    <span className="gl-th-wrap">
                                      {c.label}
                                      <span style={{marginLeft:3,opacity:isSortActive?1:0.35,fontSize:9}}>
                                        {isSortActive ? (sDir === 'asc' ? '▲' : '▼') : '⇅'}
                                      </span>
                                      <span className="gl-tooltip" style={{
                                        display:"none",
                                        position:"absolute",
                                        top:"calc(100% + 4px)",
                                        left:"50%",
                                        transform:"translateX(-50%)",
                                        background:"#1c2128",
                                        border:"1px solid #30363d",
                                        borderRadius:4,
                                        padding:"3px 8px",
                                        fontSize:10,
                                        color:"#c9d1d9",
                                        whiteSpace:"nowrap",
                                        pointerEvents:"none",
                                        zIndex:50,
                                        boxShadow:"0 2px 8px rgba(0,0,0,0.5)",
                                      }}>{c.tooltip}</span>
                                    </span>
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {sorted.map((row, i) => (
                              <tr key={i} style={{background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)"}}>
                                {cols.map(c => {
                                  const isStatCol = c.key === activeColKey;
                                  let display;
                                  if (c.key === 'date') {
                                    display = row.date ? row.date.slice(5, 10).replace('-', '/') : '—';
                                  } else if (c.key === 'isHome') {
                                    display = row.isHome === false
                                      ? <span style={{color:"#8b949e"}}>@</span>
                                      : row.isHome === true ? '' : '—';
                                  } else if (c.key === 'rest') {
                                    const r = restMap.get(row);
                                    display = r === null ? '—'
                                      : r === 1 ? <span style={{color:"#f78166",fontWeight:600}}>1</span>
                                      : r;
                                  } else if (c.key === 'toi') {
                                    display = fmtToi(row.toi);
                                  } else if (c.key === 'ip') {
                                    display = row.ip != null ? row.ip.toFixed(1) : '—';
                                  } else {
                                    const v = row[c.key];
                                    display = v != null ? v : '—';
                                  }
                                  return (
                                    <td key={c.key} style={{
                                      padding:"3px 8px",
                                      textAlign: c.align || 'right',
                                      color: isStatCol && row[c.key] != null ? "#c9d1d9" : "#8b949e",
                                      background: isStatCol ? "rgba(88,166,255,0.04)" : "transparent",
                                      borderBottom:"1px solid #161b22",
                                      whiteSpace:"nowrap",
                                    }}>{display}</td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        );
      })()}

      </div>{/* end constrained search/player section */}

      {/* Maker board — the default landing page (2026-07-21). The taker /picks route + tracking
          drawer were removed 2026-07-30 with the taker strategy. */}
      {!player && !teamPage && (
        <MakerBoardPage
          shadowReportData={shadowReportData}
          shadowReportLoading={shadowReportLoading}
          fetchShadowReport={fetchShadowReport}
          isLoggedIn={!!authEmail}
          kalshiBalance={kalshiBalance}
          makerCommitted={makerCommitted}
          onLoginClick={() => { setShowAuthModal(true); setAuthMode("login"); setAuthError(""); }}
          onLogout={logout}
        />
      )}

      <div style={{color:"#484f58",fontSize:11,marginTop:12,textAlign:"center"}}>
        Powered by ESPN API · Vercel Edge
      </div>

    </div>
  );
}


export default App;
