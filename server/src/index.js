/**
 * Boot: configuration, error reporting, migrations, then listen.
 *
 * Migrations run before the server accepts a request, so every route can
 * assume the schema in db/migrations. A failed migration stops the process
 * with the reason in the log rather than serving against a half-known schema.
 */
import './env.js';
import { initErrorReporting } from './lib/error-reporting.js';
import { logger } from './lib/logger.js';
import { app } from './app.js';
import { pool } from './db.js';
import { migrate } from './db/migrate.js';
import { hashLegacyTempPasswords } from './auth.js';
import { sendReceipt } from './routes/payments.js';
import { startPaymentSync } from './lib/payment-sync.js';
import { appBaseUrl } from './lib/brand.js';
import { bookingLinkSecret, describeLinkSecret } from './lib/change-request-domain.js';

const logSeed = logger.child('seed');

const PORT = Number(process.env.PORT ?? 3001);
const log = logger.child('api');

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

    log.info('dashboard users by club:', users.rows.map((r) => `${r.customer_id}=${r.users}`).join(', ') || 'none');
    log.info('bookings by club:', bookings.rows.map((r) => `${r.club}=${r.bookings}`).join(', ') || 'none');

    const clubsWithUsers = new Set(users.rows.map((r) => r.customer_id));
    const clubsWithBookings = new Set(bookings.rows.map((r) => r.club));
    const orphaned = [...clubsWithUsers].filter((club) => !clubsWithBookings.has(club));
    if (orphaned.length && clubsWithBookings.size) {
      log.warn(
        `users on ${orphaned.join(', ')} have no bookings — ` +
          `bookings exist only on ${[...clubsWithBookings].join(', ')}. ` +
          'The dashboard will look empty for those users.',
      );
    }
  } catch (err) {
    log.warn('could not inspect database contents:', err.message);
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
    const { rows } = await client
      .query("SELECT COUNT(*)::int AS count FROM public.bookings WHERE booking_id NOT LIKE 'RD-DEMO-%'")
      .catch(() => ({ rows: [{ count: 0 }] }));

    if (rows[0].count > 0 && !force) {
      logSeed.info(`skipped — ${rows[0].count} real booking(s) already present.`);
      return;
    }

    const { seed } = await import('../../scripts/seed.mjs');
    const result = await seed({ client, reset: force });
    logSeed.info(`club "${result.club}": ${result.inserted} booking(s) inserted.`);
    if (result.password) {
      // Never the password itself: hosted logs are kept, and shared.
      logSeed.info(
        `created user "${process.env.SEED_USERNAME ?? 'demo'}". Its password is SEED_PASSWORD if set; ` +
          'otherwise give it an email address and use "Forgot password" to set one.',
      );
    }
  } catch (err) {
    // Seeding must never stop the dashboard from coming up.
    logSeed.error('failed:', err.message);
  } finally {
    client.release();
  }
}

/** Configuration that works, but less safely than it should; said once at boot. */
function warnAboutConfiguration() {
  // Compare with the core API's own line: different fingerprints mean the two
  // services sign membership and manage links with different keys.
  log.info(describeLinkSecret());
  if (process.env.NODE_ENV === 'production' && !process.env.APP_URL && !process.env.PUBLIC_URL) {
    // The CSRF origin check then trusts only the request's own host (see
    // allowedOriginsFor); emailed links fall back to the default address.
    log.error(
      `APP_URL is not set — reset, invitation, portal and manage-booking emails will link to ${appBaseUrl()} ` +
        "instead of this dashboard. Set APP_URL to the dashboard's public https:// address.",
    );
  }
  if (process.env.NODE_ENV === 'production' && !bookingLinkSecret()) {
    log.warn(
      'BOOKING_LINK_SECRET is not set — manage-booking links are signed with JWT_SECRET, ' +
        'and the booking service cannot issue links at all. Set the same BOOKING_LINK_SECRET on both services.',
    );
  }
}

async function start() {
  await initErrorReporting();

  try {
    await migrate({ pool });
  } catch (err) {
    logger.child('migrate').error(`could not bring the database schema up to date — not starting. ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  app.listen(PORT, async () => {
    log.info(`listening on http://localhost:${PORT}`);
    warnAboutConfiguration();
    await hashLegacyTempPasswords()
      .then((count) => count && logger.child('auth').info(`hashed ${count} plaintext temporary password(s)`))
      .catch((err) => logger.child('auth').warn('could not check temporary passwords:', err.message));
    await maybeSeedOnStart();
    await reportContents();
    // Stripe payments are fetched, not only waited for: see lib/payment-sync.js.
    startPaymentSync({ sendReceipt });
  });
}

start();
