/**
 * Fetching payments from Stripe, rather than waiting to be told.
 *
 * The webhook is the fast path, but it cannot be the only one: if a delivery
 * does not arrive or is refused — no endpoint registered in the right Stripe
 * mode, a wrong signing secret, a deploy or outage at the moment Stripe calls
 * — a paid booking would otherwise sit at Pending.
 *
 * So the dashboard also asks Stripe itself, for every booking whose link is
 * out and unpaid:
 *   - shortly after the server starts,
 *   - every PAYMENT_SYNC_MINUTES while it runs (default 2),
 *   - when the bookings list is loaded (at most every 10 seconds).
 *
 * It records a payment exactly as the webhook would (recordStripePayment is
 * idempotent, so whichever sees a payment first counts it) and sends the
 * receipt.
 */
import { query } from '../db.js';
import { serialiseBooking } from './bookings-domain.js';
import { getBookingColumns } from './schema.js';
import { paidSessionsForLink } from './stripe.js';
import { readPaymentLinkConfig } from './payment-link-domain.js';
import { recordStripePayment } from './record-payment.js';

/** Links older than this are no longer polled; the drawer can still check one by hand. */
const LOOKBACK_DAYS = 60;
const MAX_PER_RUN = 50;

let running = null;
let lastRun = null;
let defaultSendReceipt = null;

/** The receipt sender (routes/payments.js sendReceipt), registered at boot. */
export function setReceiptSender(fn) {
  defaultSendReceipt = fn;
}

export function lastSync() {
  return lastRun;
}

/**
 * One pass over every pending link. Concurrent callers share the run in
 * progress rather than starting a second one.
 */
export function syncPendingPayments({ reason = 'manual', sendReceipt = null } = {}) {
  if (running) return running;
  running = runSync(reason, sendReceipt ?? defaultSendReceipt).finally(() => {
    running = null;
  });
  return running;
}

/** Sync if the last run is older than `maxAgeMs`; resolves quickly otherwise. */
export function syncIfStale({ maxAgeMs = 60_000, reason, sendReceipt } = {}) {
  if (lastRun && Date.now() - Date.parse(lastRun.finishedAt) < maxAgeMs) return Promise.resolve(lastRun);
  return syncPendingPayments({ reason, sendReceipt });
}

async function runSync(reason, sendReceipt) {
  const startedAt = new Date().toISOString();
  const config = readPaymentLinkConfig();
  const result = { reason, startedAt, checked: 0, recorded: [], errors: [], skipped: null };

  try {
    if (!config.secretKey) {
      result.skipped = 'STRIPE_SECRET_KEY is not set';
      return result;
    }
    const columns = await getBookingColumns();
    if (!columns.has('stripe_payment_link_id') || !columns.has('stripe_checkout_session_id')) {
      result.skipped = 'migration_add_stripe_payment_links.sql has not been run';
      return result;
    }

    const sentFilter = columns.has('payment_link_sent_at')
      ? `AND (payment_link_sent_at IS NULL OR payment_link_sent_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days')`
      : '';
    const { rows } = await query(
      `SELECT booking_id, club, stripe_payment_link_id FROM public.bookings
        WHERE stripe_payment_link_id IS NOT NULL AND payment_status = 'Pending' ${sentFilter}
        ORDER BY ${columns.has('payment_link_sent_at') ? 'payment_link_sent_at DESC NULLS LAST' : 'booking_id'}
        LIMIT ${MAX_PER_RUN}`,
    );

    for (const row of rows) {
      result.checked += 1;
      try {
        const sessions = await paidSessionsForLink({ secretKey: config.secretKey, linkId: row.stripe_payment_link_id });
        for (const session of sessions) {
          const recorded = await recordStripePayment(session);
          if (!recorded.booking) continue;
          let receipt = 'not attempted';
          if (sendReceipt) {
            const outcome = await sendReceipt(recorded.booking, config).catch((err) => ({ ok: false, message: err.message }));
            receipt = outcome.ok ? 'sent' : `not sent: ${outcome.message}`;
          }
          result.recorded.push({ bookingId: row.booking_id, result: recorded.result, receipt });
          console.log(`[payment-sync] ${row.booking_id}: ${recorded.result}; receipt ${receipt}`);
        }
      } catch (err) {
        result.errors.push({ bookingId: row.booking_id, error: err.message });
        console.warn(`[payment-sync] ${row.booking_id}: ${err.message}`);
      }
    }
    return result;
  } catch (err) {
    result.errors.push({ bookingId: null, error: err.message });
    console.error('[payment-sync] run failed:', err.message);
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    lastRun = result;
  }
}

/** Start the background schedule. Returns a function that stops it. */
export function startPaymentSync({ sendReceipt, env = process.env } = {}) {
  if (sendReceipt) setReceiptSender(sendReceipt);
  if (!env.STRIPE_SECRET_KEY) return () => {};
  const minutes = Math.max(Number.parseFloat(env.PAYMENT_SYNC_MINUTES ?? '2') || 2, 0.5);
  const first = setTimeout(() => syncPendingPayments({ reason: 'startup', sendReceipt }), 15_000);
  const every = setInterval(() => syncPendingPayments({ reason: 'schedule', sendReceipt }), minutes * 60_000);
  first.unref?.();
  every.unref?.();
  console.log(`[payment-sync] checking Stripe for pending payments every ${minutes} min`);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
