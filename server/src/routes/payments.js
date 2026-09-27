/**
 * Stripe payment links, sent from the booking drawer.
 *
 *   GET  /api/payments/config                      what is configured, secrets stripped
 *   POST /api/payments/bookings/:bookingId/link    create a link, email it, mark Pending
 *   POST /api/payments/bookings/:bookingId/receipt resend the receipt for the last payment
 *   POST /api/payments/bookings/:bookingId/check   ask Stripe whether the link has been paid
 *
 * The webhook that records the payment lives in `stripe-webhook.js`: it is
 * called by Stripe, not by a signed-in user, and needs the raw request body.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { serialiseBooking } from '../lib/bookings-domain.js';
import { buildAuditSet, getBookingColumns } from '../lib/schema.js';
import { BRAND } from '../lib/brand.js';
import { sendPaymentEmail } from '../lib/payment-mailer.js';
import { createPaymentLink, deactivatePaymentLink, paidSessionsForLink, prefilledLinkUrl } from '../lib/stripe.js';
import { recordStripePayment } from '../lib/record-payment.js';
import { recentWebhooks } from '../lib/webhook-log.js';
import {
  PENDING_PAYMENT_STATUS,
  buildPaymentEmail,
  buildPaymentEmailData,
  buildReceiptEmail,
  buildReceiptEmailData,
  formatMoney,
  linkProblem,
  publicPaymentLinkConfig,
  readPaymentLinkConfig,
} from '../lib/payment-link-domain.js';
import { withAccount } from './bookings.js';

const router = Router();
router.use(requireAuth);

const MIGRATION = 'migration_add_stripe_payment_links.sql';

router.get('/config', async (req, res, next) => {
  try {
    const columns = await getBookingColumns();
    res.json({
      ...publicPaymentLinkConfig(readPaymentLinkConfig()),
      migrated: columns.has('stripe_payment_link_id'),
      migration: MIGRATION,
      webhooks: recentWebhooks(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/bookings/:bookingId/link', async (req, res, next) => {
  const config = readPaymentLinkConfig();
  if (!config.configured) {
    return res.status(409).json({
      error: `Payment links are not set up. Missing: ${config.missing.join(', ')}`,
      missing: config.missing,
    });
  }

  try {
    const columns = await getBookingColumns();
    if (!columns.has('stripe_payment_link_id')) {
      return res.status(409).json({
        error: `Run ${MIGRATION} first — the dashboard picks it up within 30 seconds, with no restart.`,
        migration: MIGRATION,
      });
    }

    const club = req.user.customerId;
    const { rows } = await query(
      `SELECT ${columns.selectList} FROM public.bookings WHERE booking_id = $1 AND club = $2`,
      [req.params.bookingId, club],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });

    const booking = await withAccount(serialiseBooking(rows[0]), club);
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const problem = linkProblem(booking, amount);
    if (problem) return res.status(400).json({ error: problem });

    const link = await createPaymentLink({
      secretKey: config.secretKey,
      amount,
      currency: config.currency,
      productName: `${BRAND.fullName} – booking ${booking.bookingId}`,
      bookingId: booking.bookingId,
      club,
      confirmationMessage: `Thank you — your payment for booking ${booking.bookingId} has been received. ${BRAND.fullName}`,
    });
    const url = prefilledLinkUrl(link.url, { email: booking.guestEmail, bookingId: booking.bookingId });

    const data = buildPaymentEmailData(booking, { amount, currency: config.currency, url });
    const outcome = await sendPaymentEmail(config, {
      toEmail: booking.guestEmail,
      templateId: config.templateId,
      data,
      build: buildPaymentEmail,
      record: { club, bookingId: booking.bookingId, kind: 'payment_link', sentBy: req.user.username },
    });

    if (!outcome.ok) {
      // Nobody has the link, so it must not stay payable.
      await deactivatePaymentLink({ secretKey: config.secretKey, linkId: link.id }).catch((err) =>
        console.error('[payments] could not deactivate unsent link', link.id, err.message),
      );
      return res.status(502).json({ error: `The email was not sent: ${outcome.message}` });
    }

    // The previous link asked for a different amount; switch it off so the
    // guest cannot pay both. Best effort — the new link is already out.
    if (booking.paymentLinkId && booking.paymentLinkId !== link.id) {
      await deactivatePaymentLink({ secretKey: config.secretKey, linkId: booking.paymentLinkId }).catch(
        (err) => console.error('[payments] could not deactivate previous link', booking.paymentLinkId, err.message),
      );
    }

    const updates = {
      stripe_payment_link_id: link.id,
      stripe_payment_link_url: url,
      payment_link_amount: amount,
      payment_link_sent_by: req.user.username,
      payment_status: PENDING_PAYMENT_STATUS,
    };
    const names = Object.keys(updates).filter((name) => columns.has(name));
    const params = names.map((name) => updates[name]);
    const sets = names.map((name, index) => `"${name}" = $${index + 1}`);
    if (columns.has('payment_link_sent_at')) sets.push('payment_link_sent_at = NOW()');

    const audit = buildAuditSet(columns, params.length + 1, req.user.username);
    params.push(...audit.values, booking.bookingId, club);

    const updated = await query(
      `UPDATE public.bookings
          SET ${[...sets, ...audit.clauses].join(', ')}
        WHERE booking_id = $${params.length - 1} AND club = $${params.length}
      RETURNING ${columns.selectList}`,
      params,
    );

    res.json({
      booking: await withAccount(serialiseBooking(updated.rows[0]), club),
      message: `Payment link for ${formatMoney(amount, config.currency)} emailed to ${booking.guestEmail}`,
    });
  } catch (err) {
    if (/^Stripe /.test(err.message)) return res.status(502).json({ error: err.message });
    next(err);
  }
});

/**
 * Email the guest a receipt for the last Stripe payment on this booking and
 * stamp when it went. Shared by the webhook, which sends it the moment the
 * payment lands, and the drawer's resend button.
 *
 * Resolves to the SendGrid outcome; never throws for a failed send, because a
 * receipt that did not go out must not undo a payment that did.
 */
export async function sendReceipt(booking, config, sentBy = 'Stripe') {
  const columns = await getBookingColumns();
  if (!booking.guestEmail) return { ok: false, message: 'No guest email address' };
  if (!config.sendgridKey || !config.fromEmail) return { ok: false, message: 'SendGrid is not configured' };

  const data = buildReceiptEmailData(booking, {
    received: booking.lastPaymentAmount ?? booking.amountPaid,
    currency: config.currency,
    paidAt: booking.stripePaidAt,
    reference: booking.stripePaymentIntentId,
  });
  const outcome = await sendPaymentEmail(config, {
    toEmail: booking.guestEmail,
    templateId: config.receiptTemplateId,
    data,
    build: buildReceiptEmail,
    record: { club: booking.club, bookingId: booking.bookingId, kind: 'receipt', sentBy },
  });

  if (outcome.ok && columns.has('payment_receipt_sent_at')) {
    await query(
      `UPDATE public.bookings SET payment_receipt_sent_at = NOW() WHERE booking_id = $1 AND club = $2`,
      [booking.bookingId, booking.club],
    );
  }
  return outcome;
}

router.post('/bookings/:bookingId/receipt', async (req, res, next) => {
  const config = readPaymentLinkConfig();
  try {
    const columns = await getBookingColumns();
    const club = req.user.customerId;
    const { rows } = await query(
      `SELECT ${columns.selectList} FROM public.bookings WHERE booking_id = $1 AND club = $2`,
      [req.params.bookingId, club],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });

    const booking = serialiseBooking(rows[0]);
    if (!booking.stripePaidAt) {
      return res.status(400).json({ error: 'There is no Stripe payment on this booking to send a receipt for' });
    }

    const outcome = await sendReceipt(booking, config, req.user.username);
    if (!outcome.ok) return res.status(502).json({ error: `The receipt was not sent: ${outcome.message}` });

    const fresh = await query(
      `SELECT ${columns.selectList} FROM public.bookings WHERE booking_id = $1 AND club = $2`,
      [booking.bookingId, club],
    );
    res.json({
      booking: await withAccount(serialiseBooking(fresh.rows[0]), club),
      message: `Receipt emailed to ${booking.guestEmail}`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Ask Stripe directly whether this booking's link has been paid, and record
 * the payment if so — the same recording the webhook does, so whichever sees
 * a payment first counts it and the other finds it already counted.
 *
 * The drawer calls this when it opens on a booking still awaiting payment, so
 * a payment whose webhook never arrived (endpoint not set up, wrong secret,
 * server asleep) still lands the moment somebody looks.
 */
router.post('/bookings/:bookingId/check', async (req, res, next) => {
  const config = readPaymentLinkConfig();
  if (!config.secretKey) return res.status(409).json({ error: 'STRIPE_SECRET_KEY is not set' });

  try {
    const columns = await getBookingColumns();
    const club = req.user.customerId;
    const load = async () =>
      (await query(`SELECT ${columns.selectList} FROM public.bookings WHERE booking_id = $1 AND club = $2`, [
        req.params.bookingId,
        club,
      ])).rows[0];

    const row = await load();
    if (!row) return res.status(404).json({ error: 'Booking not found' });
    const booking = serialiseBooking(row);
    if (!booking.paymentLinkId) {
      return res.status(400).json({ error: 'No payment link has been sent for this booking' });
    }

    const sessions = await paidSessionsForLink({ secretKey: config.secretKey, linkId: booking.paymentLinkId });
    let found = 0;
    let receipt = null;
    for (const session of sessions) {
      const recorded = await recordStripePayment(session);
      if (!recorded.booking) continue;
      found += 1;
      const outcome = await sendReceipt(recorded.booking, config).catch((err) => ({ ok: false, message: err.message }));
      receipt = outcome.ok ? 'receipt emailed' : `receipt not sent: ${outcome.message}`;
    }

    const message = found
      ? `Payment found in Stripe and recorded; ${receipt}`
      : sessions.length
        ? 'Stripe shows this link paid, and the payment is already recorded'
        : 'No payment yet — Stripe has no completed payment for this link';

    res.json({ booking: await withAccount(serialiseBooking(await load()), club), found, message });
  } catch (err) {
    if (/^Stripe /.test(err.message)) return res.status(502).json({ error: err.message });
    next(err);
  }
});

export default router;
