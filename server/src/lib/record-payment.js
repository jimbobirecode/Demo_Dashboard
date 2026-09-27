/**
 * Recording a Stripe payment against its booking — the one step the webhook
 * and the drawer's "Check Stripe" button share, so a payment is counted the
 * same way whichever of them sees it first, and only once.
 */
import { query } from '../db.js';
import { serialiseBooking } from './bookings-domain.js';
import { getBookingColumns } from './schema.js';
import { applyPaidSession, bookingRefFromSession, paymentKey } from './payment-link-domain.js';

export class MigrationMissingError extends Error {}

export async function recordStripePayment(session) {
  const columns = await getBookingColumns();
  // Thrown rather than answered: the caller must not tell Stripe the payment
  // was handled, or Stripe stops retrying and it is lost once the migration runs.
  if (!columns.has('stripe_checkout_session_id')) {
    throw new MigrationMissingError('migration_add_stripe_payment_links.sql has not been run');
  }

  const ref = bookingRefFromSession(session);
  let rows = [];
  if (ref.bookingId && ref.club) {
    ({ rows } = await query(
      `SELECT ${columns.selectList} FROM public.bookings WHERE booking_id = $1 AND club = $2`,
      [ref.bookingId, ref.club],
    ));
  }
  if (!rows[0] && ref.paymentLinkId) {
    ({ rows } = await query(
      `SELECT ${columns.selectList} FROM public.bookings WHERE stripe_payment_link_id = $1`,
      [ref.paymentLinkId],
    ));
  }
  if (!rows[0] && ref.bookingId) {
    ({ rows } = await query(
      `SELECT ${columns.selectList} FROM public.bookings WHERE booking_id = $1`,
      [ref.bookingId],
    ));
  }
  // Not ours (another integration on the same Stripe account); nothing to retry.
  if (rows.length !== 1) {
    return { result: rows.length ? 'skipped: booking id is ambiguous' : 'skipped: no matching booking' };
  }

  const booking = serialiseBooking(rows[0]);
  const change = applyPaidSession(booking, session);
  if (!change) return { result: 'already recorded' };

  const key = paymentKey(session);
  const params = [change.amountPaid, change.paymentStatus, key, booking.bookingId, booking.club];
  const sets = ['amount_paid = $1', 'payment_status = $2', 'stripe_checkout_session_id = $3', 'stripe_paid_at = NOW()'];
  const add = (column, value) => {
    if (!columns.has(column)) return;
    params.push(value);
    sets.push(`"${column}" = $${params.length}`);
  };

  add('status', change.bookingStatus);
  add('stripe_payment_intent_id', change.reference);
  add('stripe_last_payment_amount', change.received);
  // A new payment needs a new receipt.
  if (columns.has('payment_receipt_sent_at')) sets.push('payment_receipt_sent_at = NULL');
  // Payment starts the pre-play emails; a later payment does not restart them.
  if (columns.has('pre_play_clock_started_at')) {
    sets.push('pre_play_clock_started_at = COALESCE(pre_play_clock_started_at, NOW())');
  }
  if (columns.has('updated_at')) sets.push('updated_at = NOW()');
  if (columns.has('updated_by')) {
    params.push('Stripe');
    sets.push(`updated_by = $${params.length}`);
  }

  // The payment's key is part of the WHERE clause as well, so two deliveries
  // racing each other (or the webhook racing a manual check) cannot both add
  // the money.
  const result = await query(
    `UPDATE public.bookings
        SET ${sets.join(', ')}
      WHERE booking_id = $4 AND club = $5
        AND stripe_checkout_session_id IS DISTINCT FROM $3
    RETURNING ${columns.selectList}`,
    params,
  );

  if (!result.rowCount) return { result: 'already recorded' };
  return {
    result: `${booking.bookingId} ${change.paymentStatus} (booking ${change.bookingStatus}), ${change.received} received`,
    booking: serialiseBooking(result.rows[0]),
  };
}

