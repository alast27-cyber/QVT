import React from 'react';

const GlassPanel = ({ title, children }) => (
  <div style={{
    background: 'rgba(255, 255, 255, 0.7)',
    borderRadius: '1rem',
    boxShadow: '0 2px 16px rgba(0,0,0,0.15)',
    padding: '2rem',
    margin: '2rem 0'
  }}>
    <h2 style={{ marginBottom: '1rem' }}>{title}</h2>
    <div>{children}</div>
  </div>
);

export default GlassPanel;
