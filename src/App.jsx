import React from 'react';
import { WORKER } from './lib/constants.js';
import { useAuth } from './lib/useAuth.js';
import { useReportData } from './lib/useReportData.js';
import { useAuthFlow } from './lib/useAuthFlow.js';
import MakerBoardPage from './components/MakerBoardPage.jsx';

// MakerBoardPage is the ONLY landing view. The player/team stat browser (player card, TeamPage,
// TotalsBarChart, InputList + their hooks) was the model-display UI and was deleted with the model
// teardown (2026-08-04, Phase 3) — the taker UI had already gone 2026-07-30. App is now just the
// auth modal + the maker board + a read-only Kalshi-balance fetch for the board header chip.
function App() {
  // Kalshi balance + committed maker capital — read-only, shown on the maker board header chip.
  const [kalshiBalance, setKalshiBalance] = React.useState(null); // dollars, null = not fetched
  const [makerCommitted, setMakerCommitted] = React.useState(0);  // dollars tied up in resting maker V2 orders
  const {
    authEmail,
    authMode, setAuthMode,
    authForm, setAuthForm,
    authError, setAuthError, authLoading,
    authenticate, logout: authLogout,
  } = useAuth();
  const {
    shadowReportData, shadowReportLoading, fetchShadowReport,
  } = useReportData();
  const { showAuthModal, setShowAuthModal, authSubmit, logout } = useAuthFlow({
    authenticate, authMode, authLogout,
  });

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
  React.useEffect(() => { fetchKalshiBalance(); }, [fetchKalshiBalance]);

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

      <div style={{color:"#484f58",fontSize:11,marginTop:12,textAlign:"center"}}>
        Powered by ESPN API · Vercel Edge
      </div>

    </div>
  );
}

export default App;
