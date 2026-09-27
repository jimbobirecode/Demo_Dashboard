/**
 * POST /api/stripe/webhook — Stripe telling us a payment link was paid.
 *
 * Mounted ahead of the JSON body parser with a raw parser of its own, because
 * the signature is computed over the exact bytes Stripe sent; parsed and
 * re-serialised JSON would never verify.
 *
 * Every verified event is answered 2xx, including ones we ignore: anything
 * else makes Stripe retry for three days. The one exception is a database
 * failure, which is answered 500 on purpose so that Stripe does retry it.
 */
import express, { Router } from 'express';
import { query } from '../db.js';
import { serialiseBooking } from '../lib/bookings-domain.js';
import { getBookingColumns } from '../lib/schema.js';
import { verifyWebhookSignature } from '../lib/stripe.js';
import { sendReceipt } from './payments.js';
import {
  applyPaidSession,
  bookingRefFromSession,
  paidSessionFromEvent,
  readPaymentLinkConfig,
} from '../lib/payment-link-domain.js';

const router = Router();

router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const { webhookSecret } = readPaymentLinkConfig();
  if (!webhookSecret) {
    console.error('[stripe] webhook received but STRIPE_WEBHOOK_SECRET is not set');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const check = verifyWebhookSignature(req.body, req.get('stripe-signature'), webhookSecret);
  if (!check.ok) {
    console.warn('[stripe] rejected webhook:', check.reason);
    return res.status(400).json({ error: check.reason });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Body is not JSON' });
  }

  const session = paidSessionFromEvent(event);
  if (!session) return res.json({ received: true, ignored: event.type });

  let recorded;
  try {
    recorded = await recordPayment(session);
    console.log(`[stripe] ${event.type} ${session.id}: ${recorded.result}`);
  } catch (err) {
    console.error('[stripe] could not record payment', session.id, err);
    return res.status(500).json({ error: 'Could not record the payment' });
  }

  // The payment is safely recorded before the receipt is attempted, and a
  // failed receipt is still answered 200: a retry would find the payment
  // already counted and send nothing. The drawer offers a resend instead.
  let receipt = null;
  if (recorded.booking) {
    const outcome = await sendReceipt(recorded.booking, readPaymentLinkConfig()).catch((err) => ({
      ok: false,
      message: err.message,
    }));
    receipt = outcome.ok ? 'sent' : `not sent: ${outcome.message}`;
    console.log(`[stripe] receipt for ${recorded.booking.bookingId}: ${receipt}`);
  }

  res.json({ received: true, result: recorded.result, receipt });
});

async function recordPayment(session) {
  const columns = await getBookingColumns();
  if (!columns.has('stripe_checkout_session_id')) return { result: 'skipped: migration not run' };

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

  const params = [change.amountPaid, change.paymentStatus, session.id, booking.bookingId, booking.club];
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

  // The session id is part of the WHERE clause as well, so two deliveries of
  // the same event racing each other cannot both add the money.
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

export default router;
