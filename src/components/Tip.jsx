import React from 'react';
import { createPortal } from 'react-dom';

// Pinnable tooltip wrapper. Hover shows on desktop; tap pins on touch.
// Outside tap or scroll dismisses pinned. Tip content is plain text (\n preserved).
//
// Usage:
//   <Tip tip="Some explanation">{children}</Tip>
//   <Tip tip={...} stopPropagation>{children}</Tip>   // when wrapping inside a clickable parent (e.g. sortable header)
//
// `stopPropagation` prevents the click from reaching parent handlers — useful when a
// sortable column header has its own onClick.
export default function Tip({ tip, children, style, stopPropagation = false, anchor = 'below' }) {
  const [tipPos, setTipPos] = React.useState(null);
  const [pinned, setPinned] = React.useState(false);
  const ref = React.useRef(null);

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

  if (!tip) return <span ref={ref} style={style}>{children}</span>;

  function handleClick(e) {
    if (stopPropagation) e.stopPropagation();
    if (pinned) {
      setPinned(false); setTipPos(null);
    } else {
      const r = ref.current?.getBoundingClientRect();
      if (r) setTipPos({ x: r.left + r.width / 2, y: anchor === 'above' ? r.top : r.bottom });
      setPinned(true);
    }
  }

  return (
    <span ref={ref} style={{ display: 'inline-block', ...style }}
      onMouseEnter={e => { if (!pinned) setTipPos({ x: e.clientX, y: e.clientY }); }}
      onMouseMove={e => { if (!pinned && tipPos) setTipPos({ x: e.clientX, y: e.clientY }); }}
      onMouseLeave={() => { if (!pinned) setTipPos(null); }}
      onClick={handleClick}>
      {children}
      {tipPos && createPortal(
        <div style={{
          position: 'fixed',
          left: Math.min(tipPos.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 240),
          top: anchor === 'above' ? tipPos.y - 14 : tipPos.y + 14,
          transform: anchor === 'above' ? 'translateY(-100%)' : undefined,
          background: '#1c2128',
          border: '1px solid #30363d',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 11,
          color: '#c9d1d9',
          whiteSpace: 'pre-wrap',
          maxWidth: 240,
          zIndex: 9999,
          pointerEvents: 'none',
          lineHeight: 1.5,
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>{tip}</div>,
        document.body
      )}
    </span>
  );
}
