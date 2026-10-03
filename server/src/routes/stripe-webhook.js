/**
 * POST /api/stripe/webhook — Stripe telling us a payment link was paid.
 * GET  /api/stripe/webhook — answers { ok: true }, so the URL can be checked in a browser.
 *
 * Mounted ahead of the JSON body parser with a raw parser of its own, because
 * the signature is computed over the exact bytes Stripe sent; parsed and
 * re-serialised JSON would never verify.
 *
 * A verified event we have handled, or have no use for, is answered 2xx.
 * Anything that means the payment could not be recorded yet — the secret
 * missing, the database down — is answered 5xx on purpose, so Stripe
 * keeps retrying (for up to three days) until it can be.
 *
 * Every delivery is noted in the webhook log the drawer shows.
 */
import express, { Router } from 'express';
import { verifyWebhookSignature } from '../lib/stripe.js';
import { paidSessionFromEvent, readPaymentLinkConfig } from '../lib/payment-link-domain.js';
import { recordStripePayment } from '../lib/record-payment.js';
import { logWebhook } from '../lib/webhook-log.js';
import { sendReceipt } from './payments.js';

const router = Router();

// Says only that the route exists. Whether a signing secret is configured is
// shown to administrators in the payments diagnostics, not to anybody.
router.get('/', (req, res) => {
  res.json({ ok: true });
});

router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const { webhookSecret } = readPaymentLinkConfig();
  if (!webhookSecret) {
    console.error('[stripe] webhook received but STRIPE_WEBHOOK_SECRET is not set');
    logWebhook({ outcome: 'rejected', detail: 'STRIPE_WEBHOOK_SECRET is not set on the server' });
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const check = verifyWebhookSignature(req.body, req.get('stripe-signature'), webhookSecret);
  if (!check.ok) {
    console.warn('[stripe] rejected webhook:', check.reason);
    logWebhook({
      outcome: 'rejected',
      detail:
        check.reason === 'Signature mismatch'
          ? 'Signature mismatch: STRIPE_WEBHOOK_SECRET is not this endpoint\'s signing secret (test and live mode have different ones)'
          : check.reason,
    });
    return res.status(400).json({ error: check.reason });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Body is not JSON' });
  }

  const session = paidSessionFromEvent(event);
  if (!session) {
    logWebhook({ outcome: 'ignored', type: event.type, detail: 'Not a completed payment' });
    return res.json({ received: true, ignored: event.type });
  }

  let recorded;
  try {
    recorded = await recordStripePayment(session);
    console.log(`[stripe] ${event.type} ${session.id}: ${recorded.result}`);
  } catch (err) {
    const detail = `Database error: ${err.message}`;
    console.error('[stripe] could not record payment', session.id, err);
    logWebhook({ outcome: 'failed', type: event.type, bookingId: session.metadata?.booking_id ?? null, detail });
    return res.status(503).json({ error: 'Could not record the payment yet' });
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

  logWebhook({
    outcome: recorded.booking ? 'recorded' : 'skipped',
    type: event.type,
    bookingId: recorded.booking?.bookingId ?? session.metadata?.booking_id ?? null,
    detail: receipt ? `${recorded.result}; receipt ${receipt}` : recorded.result,
  });
  res.json({ received: true, result: recorded.result, receipt });
});

export default router;
