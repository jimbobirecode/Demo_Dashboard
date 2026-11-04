import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { BRAND } from './lib/brand.js';
import './theme.css';

// The <title> in index.html is static, so a build that sets VITE_CLUB_* would
// otherwise still show the name baked into that file.
document.title = `${BRAND.fullName} — ${BRAND.tagline}`;

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
