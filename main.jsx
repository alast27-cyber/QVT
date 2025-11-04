import React from 'react';
import ReactDOM from 'react-dom/client';
import NexusQChat from './QuantumCallInterface.jsx';

// Since the application component already loads Tailwind via a script tag,
// we don't need a separate CSS file for a minimal setup.

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <NexusQChat />
  </React.StrictMode>,
);
