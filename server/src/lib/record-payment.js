/**
 * Recording a Stripe payment against its booking — the one step the webhook
 * and the drawer's "Check Stripe" button share, so a payment is counted the
 * same way whichever of them sees it first, and only once.
 */
import { query } from '../db.js';
import { serialiseBooking } from './bookings-domain.js';
import { BOOKING_SELECT } from './schema.js';
import { applyPaidSession, bookingRefFromSession, paymentKey } from './payment-link-domain.js';

export async function recordStripePayment(session) {
  const ref = bookingRefFromSession(session);
  let rows = [];
  if (ref.bookingId && ref.club) {
    ({ rows } = await query(`SELECT ${BOOKING_SELECT} FROM public.bookings WHERE booking_id = $1 AND club = $2`, [
      ref.bookingId,
      ref.club,
    ]));
  }
  if (!rows[0] && ref.paymentLinkId) {
    ({ rows } = await query(`SELECT ${BOOKING_SELECT} FROM public.bookings WHERE stripe_payment_link_id = $1`, [
      ref.paymentLinkId,
    ]));
  }
  if (!rows[0] && ref.bookingId) {
    ({ rows } = await query(`SELECT ${BOOKING_SELECT} FROM public.bookings WHERE booking_id = $1`, [ref.bookingId]));
  }
  // Not ours (another integration on the same Stripe account); nothing to retry.
  if (rows.length !== 1) {
    return { result: rows.length ? 'skipped: booking id is ambiguous' : 'skipped: no matching booking' };
  }

  const booking = serialiseBooking(rows[0]);
  const change = applyPaidSession(booking, session);
  if (!change) return { result: 'already recorded' };

  const key = paymentKey(session);
  const params = [
    change.amountPaid,
    change.paymentStatus,
    key,
    booking.bookingId,
    booking.club,
    change.bookingStatus,
    change.reference,
    change.received,
  ];
  const sets = [
    'amount_paid = $1',
    'payment_status = $2',
    'stripe_checkout_session_id = $3',
    'stripe_paid_at = NOW()',
    'status = $6',
    'stripe_payment_intent_id = $7',
    'stripe_last_payment_amount = $8',
    // A new payment needs a new receipt.
    'payment_receipt_sent_at = NULL',
    // Payment starts the pre-play emails; a later payment does not restart them.
    'pre_play_clock_started_at = COALESCE(pre_play_clock_started_at, NOW())',
    'updated_at = NOW()',
    "updated_by = 'Stripe'",
  ];

  // The payment's key is part of the WHERE clause as well, so two deliveries
  // racing each other (or the webhook racing a manual check) cannot both add
  // the money.
  const result = await query(
    `UPDATE public.bookings
        SET ${sets.join(', ')}
      WHERE booking_id = $4 AND club = $5
        AND stripe_checkout_session_id IS DISTINCT FROM $3
    RETURNING ${BOOKING_SELECT}`,
    params,
  );

  if (!result.rowCount) return { result: 'already recorded' };
  return {
    result: `${booking.bookingId} ${change.paymentStatus} (booking ${change.bookingStatus}), ${change.received} received`,
    booking: serialiseBooking(result.rows[0]),
  };
}
