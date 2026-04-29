import React from 'react';
import PlaysColumn from './PlaysColumn.jsx';

function logoUrl(sport, abbr) {
  if (!abbr) return null;
  return `https://a.espncdn.com/i/teamlogos/${sport}/500/${abbr.toLowerCase()}.png`;
}

export default function GamePlayDrawer({
  game, plays, allTonightPlays,
  trackedPlays, trackPlay, untrackPlay,
  navigateToPlay, navigateToTeam, navigateToModel,
  onClose, expandedPlays, setExpandedPlays,
}) {
  const { sport, homeTeam, awayTeam } = game;

  // Auto-close ~500ms after a new pick is confirmed (trackedPlays grows while drawer is open)
  const pendingClose = React.useRef(false);
  const prevLen = React.useRef(trackedPlays.length);
  React.useEffect(() => {
    if (pendingClose.current && trackedPlays.length > prevLen.current) {
      pendingClose.current = false;
      setTimeout(onClose, 500);
    }
    prevLen.current = trackedPlays.length;
  }, [trackedPlays, onClose]);

  function handleTrackPlay(play, e) {
    pendingClose.current = true;
    trackPlay(play, e);
  }

  function handleNavigateToPlay(play, tab) {
    onClose();
    navigateToPlay(play, tab);
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 585 }}
      />

      {/* Bottom sheet */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        maxHeight: '78vh', overflowY: 'auto',
        background: '#161b22',
        borderTop: '1px solid #30363d',
        borderRadius: '12px 12px 0 0',
        zIndex: 586,
        boxShadow: '0 -4px 24px rgba(0,0,0,0.6)',
      }}>
        {/* Sticky header */}
        <div style={{
          display: 'flex', alignItems: 'center', padding: '14px 16px 12px',
          borderBottom: '1px solid #21262d',
          position: 'sticky', top: 0, background: '#161b22', zIndex: 1,
        }}>
          <img src={logoUrl(sport, awayTeam)} alt={awayTeam}
            style={{ width: 24, height: 24, objectFit: 'contain', marginRight: 6 }}
            onError={e => { e.target.style.display = 'none'; }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: '#c9d1d9' }}>{awayTeam}</span>
          <span style={{ fontSize: 12, color: '#484f58', margin: '0 8px' }}>@</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#c9d1d9' }}>{homeTeam}</span>
          <img src={logoUrl(sport, homeTeam)} alt={homeTeam}
            style={{ width: 24, height: 24, objectFit: 'contain', marginLeft: 6 }}
            onError={e => { e.target.style.display = 'none'; }} />
          <span style={{
            fontSize: 9, color: '#484f58', marginLeft: 10,
            textTransform: 'uppercase', letterSpacing: 0.7, fontWeight: 600,
          }}>{sport}</span>
          <button onClick={onClose} style={{
            marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
            color: '#8b949e', fontSize: 18, padding: '2px 6px', borderRadius: 4, lineHeight: 1,
          }}>✕</button>
        </div>

        {/* Play cards */}
        <div style={{ padding: '12px 16px 32px' }}>
          <PlaysColumn
            tonightPlays={plays}
            allTonightPlays={allTonightPlays}
            tonightLoading={false}
            trackedPlays={trackedPlays}
            trackPlay={handleTrackPlay}
            untrackPlay={untrackPlay}
            navigateToPlay={handleNavigateToPlay}
            navigateToTeam={navigateToTeam}
            navigateToModel={navigateToModel}
            expandedPlays={expandedPlays}
            setExpandedPlays={setExpandedPlays}
            hideHeader={true}
            gridColumns={1}
          />
        </div>
      </div>
    </>
  );
}
