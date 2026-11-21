import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { VerifyPage } from './pages/Verify';
import { PhonePage } from './pages/Phone';
import './styles.css';

// Tiny path-based routing: two public pages + the staff app.
function Root() {
  const path = window.location.pathname;
  if (path.startsWith('/verify')) return <VerifyPage />;
  if (path.startsWith('/phone')) return <PhonePage />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
