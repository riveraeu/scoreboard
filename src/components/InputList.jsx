import React from 'react';

// v2 lambda-input display. Renders a compact label/value grid for each input that fed truePct,
// plus an optional "Model output" mini-section above. Auto-suppresses null inputs. Color per
// input is computed by the builder (lambdaInputs.js) — this component is purely presentational.
//
// Input shape: { label: string, value: string, color?: string, tooltip?: string }
// Output shape: { expected: string, sigma?: string, prob: string }
export default function InputList({ inputs, output, compact = true }) {
  const visible = (inputs || []).filter(i => i && i.value != null);
  const itemStyle = { display: 'flex', justifyContent: 'space-between', gap: 8,
    fontSize: 11, padding: '2px 0', borderBottom: '1px dashed #21262d' };
  const labelStyle = { color: '#8b949e' };
  return (
    <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5 }}>
      {output && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '6px 8px',
          background: '#0d1117', border: '1px solid #21262d', borderRadius: 6, marginBottom: 8 }}>
          <div style={{ color: '#8b949e', fontSize: 10, fontWeight: 600, letterSpacing: 0.5 }}>MODEL OUTPUT</div>
          {output.expected && <span><span style={labelStyle}>Expected:</span> <span style={{ color: '#c9d1d9', fontWeight: 600 }}>{output.expected}</span></span>}
          {output.sigma && <span><span style={labelStyle}>σ:</span> <span style={{ color: '#c9d1d9' }}>{output.sigma}</span></span>}
          {output.prob && <span><span style={labelStyle}>P:</span> <span style={{ color: '#c9d1d9', fontWeight: 600 }}>{output.prob}</span></span>}
        </div>
      )}
      <div style={{ color: '#8b949e', fontSize: 10, fontWeight: 600, letterSpacing: 0.5, marginBottom: 4 }}>LAMBDA INPUTS</div>
      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr 1fr' : '1fr', columnGap: 16 }}>
        {visible.map((i, idx) => (
          <div key={idx} style={itemStyle} title={i.tooltip}>
            <span style={labelStyle}>{i.label}</span>
            <span style={{ color: i.color || '#c9d1d9', fontWeight: 500 }}>{i.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
