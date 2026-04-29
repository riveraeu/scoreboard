import React from 'react';
import { createPortal } from 'react-dom';

export default function SimBadge({ sc, scTitle, scColor, customStyle, style, onClick }) {
  const [tipPos, setTipPos] = React.useState(null);
  if (sc == null) return null;
  const label = sc >= 8 ? 'Alpha' : sc >= 5 ? 'Mid' : 'Low';
  return (
    <span style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
      onMouseEnter={e => { if (scTitle) setTipPos({ x: e.clientX, y: e.clientY }); }}
      onMouseMove={e => { if (tipPos) setTipPos({ x: e.clientX, y: e.clientY }); }}
      onMouseLeave={() => setTipPos(null)}
      onClick={onClick}>
      <span style={{ background: '#161b22', borderRadius: 4, padding: '1px 5px', color: scColor,
        fontWeight: 700, fontSize: 10, cursor: scTitle ? 'help' : 'default', ...customStyle }}>
        {sc}/10 {label}
      </span>
      {tipPos && scTitle && createPortal(
        <div style={{
          position: 'fixed',
          left: tipPos.x + 14,
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
        }}, scTitle),
        document.body
      )}
    </span>
  );
}
