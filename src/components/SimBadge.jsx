import React from 'react';
import { createPortal } from 'react-dom';

export default function SimBadge({ sc, scTitle, scColor, customStyle, style, onClick }) {
  const [tipPos, setTipPos] = React.useState(null);
  const [pinned, setPinned] = React.useState(false);
  const ref = React.useRef(null);

  // Pinned (tap-to-show) closes on outside tap or scroll.
  React.useEffect(() => {
    if (!pinned) return;
    const close = (e) => {
      if (!ref.current || !e || !ref.current.contains(e.target)) {
        setPinned(false); setTipPos(null);
      }
    };
    const closeOnScroll = () => { setPinned(false); setTipPos(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    window.addEventListener('scroll', closeOnScroll, { passive: true });
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      window.removeEventListener('scroll', closeOnScroll);
    };
  }, [pinned]);

  if (sc == null) return null;
  const label = sc >= 8 ? 'Alpha' : sc >= 5 ? 'Mid' : 'Low';

  function handleClick(e) {
    e.stopPropagation();
    if (scTitle) {
      if (pinned) {
        setPinned(false); setTipPos(null);
      } else {
        // Anchor below the badge so it works the same regardless of cursor/touch position.
        const r = ref.current?.getBoundingClientRect();
        if (r) setTipPos({ x: r.left + r.width / 2, y: r.bottom });
        setPinned(true);
      }
    }
    onClick?.(e);
  }

  return (
    <span ref={ref} style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      onMouseEnter={e => { if (!pinned && scTitle) setTipPos({ x: e.clientX, y: e.clientY }); }}
      onMouseMove={e => { if (!pinned && tipPos) setTipPos({ x: e.clientX, y: e.clientY }); }}
      onMouseLeave={() => { if (!pinned) setTipPos(null); }}
      onClick={handleClick}>
      <span style={{ background: '#161b22', borderRadius: 4, padding: '1px 5px', color: scColor,
        fontWeight: 700, fontSize: 10, cursor: scTitle ? 'pointer' : 'default', ...customStyle }}>
        {sc}/10 {label}
      </span>
      {tipPos && scTitle && createPortal(
        <div style={{
          position: 'fixed',
          // Clamp so pinned tip doesn't fall off the right edge on narrow screens.
          left: Math.min(tipPos.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 220),
          top: tipPos.y + 14,
          background: '#1c2128',
          border: '1px solid #30363d',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 11,
          color: '#c9d1d9',
          whiteSpace: 'pre',
          zIndex: 9999,
          pointerEvents: 'none',
          lineHeight: 1.6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>{scTitle}</div>,
        document.body
      )}
    </span>
  );
}
