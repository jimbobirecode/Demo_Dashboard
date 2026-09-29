import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';

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
import paymentRoutes, { sendReceipt } from './routes/payments.js';
import { startPaymentSync } from './lib/payment-sync.js';
import inboxRoutes from './routes/inbox.js';
import portalRoutes from './routes/portal.js';
import stripeWebhookRoutes from './routes/stripe-webhook.js';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 3001);

// Stripe signs the raw request body, so its webhook is mounted before the JSON
// parser can consume it.
app.use('/api/stripe/webhook', stripeWebhookRoutes);

// A tee sheet upload arrives base64-encoded in the body, which is about a
// third larger than the file; 12mb carries the importer's 8MB ceiling.
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());

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
    res.status(503).json({ ok: false, database: 'unavailable', error: err.message });
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
  console.error('[api]', err);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Log what the database actually holds, so an empty dashboard can be told
 * apart from a club mismatch without shell access.
 */
async function reportContents() {
  try {
    const users = await pool.query(
      `SELECT customer_id, COUNT(*)::int AS users
         FROM public.dashboard_users GROUP BY customer_id ORDER BY users DESC`,
    );
    const bookings = await pool.query(
      `SELECT club, COUNT(*)::int AS bookings
         FROM public.bookings GROUP BY club ORDER BY bookings DESC`,
    );

    console.log('[api] dashboard users by club:',
      users.rows.map((r) => `${r.customer_id}=${r.users}`).join(', ') || 'none');
    console.log('[api] bookings by club:',
      bookings.rows.map((r) => `${r.club}=${r.bookings}`).join(', ') || 'none');

    const clubsWithUsers = new Set(users.rows.map((r) => r.customer_id));
    const clubsWithBookings = new Set(bookings.rows.map((r) => r.club));
    const orphaned = [...clubsWithUsers].filter((club) => !clubsWithBookings.has(club));
    if (orphaned.length && clubsWithBookings.size) {
      console.warn(
        `[api] WARNING: users on ${orphaned.join(', ')} have no bookings — ` +
        `bookings exist only on ${[...clubsWithBookings].join(', ')}. ` +
        'The dashboard will look empty for those users.',
      );
    }
  } catch (err) {
    console.warn('[api] could not inspect database contents:', err.message);
  }
}

/**
 * SEED_ON_START fills an empty dashboard at boot, for hosts with no shell.
 * It never touches a database that already has bookings unless
 * SEED_ON_START=force, which rebuilds the sample rows.
 */
async function maybeSeedOnStart() {
  const mode = process.env.SEED_ON_START;
  if (!mode || mode === 'false') return;

  const force = mode === 'force';
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT COUNT(*)::int AS count FROM public.bookings WHERE booking_id NOT LIKE 'RD-DEMO-%'",
    ).catch(() => ({ rows: [{ count: 0 }] }));

    if (rows[0].count > 0 && !force) {
      console.log(`[seed] skipped — ${rows[0].count} real booking(s) already present.`);
      return;
    }

    const { seed } = await import('../../scripts/seed.mjs');
    const result = await seed({ client, reset: force });
    console.log(`[seed] club "${result.club}": ${result.inserted} booking(s) inserted.`);
    if (result.password) {
      console.log(`[seed] sign in with ${process.env.SEED_USERNAME ?? 'demo'} / ${result.password}`);
    }
  } catch (err) {
    // Seeding must never stop the dashboard from coming up.
    console.error('[seed] failed:', err.message);
  } finally {
    client.release();
  }
}

app.listen(PORT, async () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
  await maybeSeedOnStart();
  await reportContents();
  // Stripe payments are fetched, not only waited for: see lib/payment-sync.js.
  startPaymentSync({ sendReceipt });
});
