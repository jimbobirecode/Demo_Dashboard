/**
 * The HTTP application: middleware, routes and error handling.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';

import authRoutes from './routes/auth.js';
import bookingRoutes from './routes/bookings.js';
import analyticsRoutes from './routes/analytics.js';
import emailRoutes from './routes/emails.js';
import operatorRoutes from './routes/operators.js';
import reminderRoutes from './routes/reminders.js';
import userRoutes from './routes/users.js';
import waitlistRoutes from './routes/waitlist.js';
import importRoutes from './routes/imports.js';
import changeRoutes from './routes/changes.js';
import paymentRoutes from './routes/payments.js';
import inboxRoutes from './routes/inbox.js';
import portalRoutes from './routes/portal.js';
import stripeWebhookRoutes from './routes/stripe-webhook.js';
import { pool } from './db.js';
import { contentSecurityDirectives, csrfProtection } from './lib/request-guard.js';
import { logger } from './lib/logger.js';

const log = logger.child('api');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The Express app, without listening: index.js boots it, tests drive it directly. */
export const app = express();

// Render puts exactly one proxy in front of the app. Trusting one hop makes
// req.ip the address that proxy saw — the real client — and makes anything a
// client writes into X-Forwarded-For itself irrelevant.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: { useDefaults: false, directives: contentSecurityDirectives() },
  strictTransportSecurity: { maxAge: 180 * 24 * 60 * 60, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Stripe signs the raw request body, so its webhook is mounted before the JSON
// parser can consume it — and before the CSRF check, which a server-to-server
// caller cannot satisfy (its signature is its proof instead).
app.use('/api/stripe/webhook', stripeWebhookRoutes);

// A tee sheet upload arrives base64-encoded in the body, which is about a
// third larger than the file; 12mb carries the importer's 8MB ceiling. Only
// the importer gets that: everything else is a form's worth of JSON, and a
// large ceiling everywhere is a cheap way to make the server parse megabytes.
app.use('/api/imports', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// Every state-changing API call must come from this dashboard's own pages.
app.use('/api', csrfProtection());

// The Vite dev server runs on its own origin; in production the API and the
// built SPA are served from the same one, so no CORS is needed there.
if (process.env.NODE_ENV !== 'production') {
  app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    // The reason stays in the log: a public health check should not describe
    // the database to whoever asks.
    log.error('health check failed:', err.message);
    res.status(503).json({ ok: false, status: 'degraded' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/emails', emailRoutes);
app.use('/api/operators', operatorRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/changes', changeRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/portal', portalRoutes);

const distDir = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // Client-side routing: anything that is not an API call renders the SPA.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  // A body over the size limit, or JSON that does not parse, is the client's
  // mistake: say so with its own status rather than as a server fault.
  const status = err.status ?? err.statusCode;
  if (status >= 400 && status < 500) {
    return res.status(status).json({
      error: err.type === 'entity.too.large' ? 'That request is too large' : 'The request could not be read',
    });
  }
  log.error(`${req.method} ${req.originalUrl.split('?')[0]} failed`, err);
  res.status(500).json({ error: 'Internal server error' });
});

