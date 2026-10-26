import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const shellBootMs = Number(performance.now().toFixed(1));
const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root container');
}

createRoot(container).render(
  <React.StrictMode>
    <App shellBootMs={shellBootMs} />
  </React.StrictMode>,
);
