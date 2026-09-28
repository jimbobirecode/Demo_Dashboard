import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  applyPaidSession,
  bookingRefFromSession,
  buildPaymentEmail,
  buildPaymentEmailData,
  buildReceiptEmail,
  buildReceiptEmailData,
  linkProblem,
  paidSessionFromEvent,
  paymentKey,
  publicPaymentLinkConfig,
  readPaymentLinkConfig,
} from '../src/lib/payment-link-domain.js';
import {
  createPaymentLink,
  formEncode,
  fromMinorUnits,
  paidSessionsForLink,
  prefilledLinkUrl,
  toMinorUnits,
  verifyWebhookSignature,
} from '../src/lib/stripe.js';
import { sendHtmlEmail } from '../src/lib/sendgrid.js';
import { PAYMENT_STATUSES } from '../src/lib/operators-domain.js';

const booking = (overrides = {}) => ({
  bookingId: 'TMG-1',
  club: 'royal_dornoch',
  guestEmail: 'guest@example.com',
  guestName: 'Tom Harris',
  status: 'Booked',
  date: '2027-05-12',
  teeTime: '9:30 AM',
  players: 4,
  total: 1440,
  amountPaid: 0,
  golfCourses: 'Championship Course',
  ...overrides,
});

const FULL_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_abc',
  STRIPE_WEBHOOK_SECRET: 'whsec_abc',
  SENDGRID_API_KEY: 'SG.x',
  FROM_EMAIL: 'bookings@club.teemail.io',
};

// --- configuration -----------------------------------------------------------

test('payment links need Stripe, its webhook secret, and SendGrid', () => {
  assert.equal(readPaymentLinkConfig(FULL_ENV).configured, true);
  const partial = readPaymentLinkConfig({ STRIPE_SECRET_KEY: 'sk_live_x' });
  assert.equal(partial.configured, false);
  assert.deepEqual(partial.missing, ['STRIPE_WEBHOOK_SECRET', 'SENDGRID_API_KEY', 'FROM_EMAIL']);
  assert.equal(partial.testMode, false);
  assert.equal(readPaymentLinkConfig(FULL_ENV).testMode, true);
});

test('the browser never sees a secret', () => {
  const shown = JSON.stringify(publicPaymentLinkConfig(readPaymentLinkConfig(FULL_ENV)));
  for (const secret of Object.values(FULL_ENV).filter((v) => !v.includes('@'))) {
    assert.ok(!shown.includes(secret), `leaked ${secret}`);
  }
});

test('Pending is a payment status the dashboard accepts', () => {
  assert.ok(PAYMENT_STATUSES.includes('Pending'));
});

// --- what may be sent ----------------------------------------------------------

test('a link needs a guest address, a live booking and a sensible amount', () => {
  assert.equal(linkProblem(booking(), 1440), null);
  assert.equal(linkProblem(booking(), 360.5), null);
  assert.match(linkProblem(booking({ guestEmail: '' }), 100), /no guest email/);
  assert.match(linkProblem(booking({ status: 'Cancelled' }), 100), /cancelled/);
  assert.match(linkProblem(booking(), 0), /more than zero/);
  assert.match(linkProblem(booking(), -5), /more than zero/);
  assert.match(linkProblem(booking(), 'abc'), /more than zero/);
  assert.match(linkProblem(booking(), 10.555), /two decimal places/);
  assert.match(linkProblem(booking(), 0.2), /at least/);
});

// --- Stripe plumbing -----------------------------------------------------------

test('money converts to and from Stripe minor units', () => {
  assert.equal(toMinorUnits(1440, 'GBP'), 144000);
  assert.equal(toMinorUnits(19.99, 'gbp'), 1999);
  assert.equal(toMinorUnits(5000, 'JPY'), 5000);
  assert.equal(fromMinorUnits(144000, 'gbp'), 1440);
});

test('nested params are form-encoded the way Stripe reads them', () => {
  const body = formEncode({ line_items: { 0: { price: 'price_1', quantity: 1 } }, metadata: { booking_id: 'A' } }).toString();
  assert.equal(decodeURIComponent(body), 'line_items[0][price]=price_1&line_items[0][quantity]=1&metadata[booking_id]=A');
});

test('a link is a price plus a single-use payment link, carrying the booking', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    const payload = url.endsWith('/prices') ? { id: 'price_1' } : { id: 'plink_1', url: 'https://buy.stripe.com/test_1' };
    return { ok: true, json: async () => payload };
  };
  const link = await createPaymentLink({
    secretKey: 'sk_test', amount: 360, currency: 'GBP', productName: 'Booking', bookingId: 'TMG-1', club: 'rd',
    confirmationMessage: 'Thanks', fetchImpl,
  });

  assert.deepEqual(link, { id: 'plink_1', url: 'https://buy.stripe.com/test_1' });
  assert.equal(calls[0].body.get('unit_amount'), '36000');
  assert.equal(calls[0].body.get('currency'), 'gbp');
  assert.equal(calls[1].body.get('line_items[0][price]'), 'price_1');
  assert.equal(calls[1].body.get('metadata[booking_id]'), 'TMG-1');
  assert.equal(calls[1].body.get('payment_intent_data[metadata][club]'), 'rd');
  assert.equal(calls[1].body.get('restrictions[completed_sessions][limit]'), '1');
});

test('a Stripe refusal surfaces its own message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid currency' } }) });
  await assert.rejects(
    createPaymentLink({ secretKey: 'sk', amount: 1, currency: 'GBP', productName: 'x', bookingId: 'a', club: 'b', fetchImpl }),
    /Stripe error 400: Invalid currency/,
  );
});

test('the emailed link carries the guest address and booking reference', () => {
  const url = new URL(prefilledLinkUrl('https://buy.stripe.com/test_1', { email: 'a@b.com', bookingId: 'TMG-1' }));
  assert.equal(url.searchParams.get('prefilled_email'), 'a@b.com');
  assert.equal(url.searchParams.get('client_reference_id'), 'TMG-1');
});

// --- webhook signature -----------------------------------------------------------

function sign(body, secret, t) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

test('a webhook signed with the endpoint secret verifies', () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  assert.deepEqual(verifyWebhookSignature(Buffer.from(body), sign(body, 'whsec_1', now), 'whsec_1', { now }), { ok: true });
});

test('a forged, altered, stale or unsigned webhook is refused', () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  assert.equal(verifyWebhookSignature(body, sign(body, 'whsec_other', now), 'whsec_1', { now }).ok, false);
  assert.equal(verifyWebhookSignature('{"id":"evt_2"}', sign(body, 'whsec_1', now), 'whsec_1', { now }).ok, false);
  assert.equal(verifyWebhookSignature(body, sign(body, 'whsec_1', now - 3600), 'whsec_1', { now }).ok, false);
  assert.equal(verifyWebhookSignature(body, undefined, 'whsec_1', { now }).ok, false);
  assert.equal(verifyWebhookSignature(body, 'garbage', 'whsec_1', { now }).ok, false);
});

// --- recording the payment -------------------------------------------------------

const session = (overrides = {}) => ({
  object: 'checkout.session',
  id: 'cs_1',
  payment_status: 'paid',
  amount_total: 144000,
  currency: 'gbp',
  metadata: { booking_id: 'TMG-1', club: 'royal_dornoch' },
  payment_link: 'plink_1',
  ...overrides,
});

test('only events that mean money arrived are acted on', () => {
  assert.ok(paidSessionFromEvent({ type: 'checkout.session.completed', data: { object: session() } }));
  assert.equal(
    paidSessionFromEvent({ type: 'checkout.session.completed', data: { object: session({ payment_status: 'unpaid' }) } }),
    null,
    'a bank debit completes before it pays',
  );
  assert.ok(paidSessionFromEvent({ type: 'checkout.session.async_payment_succeeded', data: { object: session({ payment_status: 'unpaid' }) } }));
  assert.equal(paidSessionFromEvent({ type: 'payment_intent.created', data: { object: { object: 'payment_intent' } } }), null);
});

test('the booking is found from metadata, or the client reference, or the link', () => {
  assert.deepEqual(bookingRefFromSession(session()), { bookingId: 'TMG-1', club: 'royal_dornoch', paymentLinkId: 'plink_1' });
  assert.deepEqual(
    bookingRefFromSession(session({ metadata: {}, client_reference_id: 'TMG-9' })),
    { bookingId: 'TMG-9', club: null, paymentLinkId: 'plink_1' },
  );
});

test('a payment covering the total marks the booking Paid', () => {
  assert.deepEqual(applyPaidSession(booking({ paymentStatus: 'Pending' }), session({ payment_intent: 'pi_1' })), {
    received: 1440, amountPaid: 1440, paymentStatus: 'Paid', bookingStatus: 'Booked', reference: 'pi_1',
  });
});

test('payment moves an open enquiry to Booked, and never revives a cancelled one', () => {
  assert.equal(applyPaidSession(booking({ status: 'Inquiry' }), session()).bookingStatus, 'Booked');
  assert.equal(applyPaidSession(booking({ status: 'Requested' }), session()).bookingStatus, 'Booked');
  assert.equal(applyPaidSession(booking({ status: 'Cancelled' }), session()).bookingStatus, 'Cancelled');
  assert.equal(applyPaidSession(booking({ status: 'Rejected' }), session()).bookingStatus, 'Rejected');
});

test('a part payment adds to what was paid and reads Deposit paid', () => {
  assert.deepEqual(applyPaidSession(booking(), session({ amount_total: 36000 })), {
    received: 360, amountPaid: 360, paymentStatus: 'Deposit paid', bookingStatus: 'Booked', reference: 'cs_1',
  });
  assert.equal(applyPaidSession(booking({ amountPaid: 360 }), session({ amount_total: 108000 })).paymentStatus, 'Paid');
});

test('the same payment delivered twice is only counted once', () => {
  assert.equal(applyPaidSession(booking({ stripeCheckoutSessionId: 'cs_1' }), session()), null);
});

// --- the email -----------------------------------------------------------------------

test('the email names the amount, the booking and the link', () => {
  const data = buildPaymentEmailData(booking(), { amount: 1440, currency: 'GBP', url: 'https://buy.stripe.com/x?a=1&b=2' });
  assert.equal(data.first_name, 'Tom');
  assert.equal(data.amount, '£1,440.00');
  assert.equal(data.play_date, 'Wednesday 12 May 2027');

  const email = buildPaymentEmail(data);
  assert.match(email.subject, /TMG-1/);
  assert.match(email.text, /https:\/\/buy\.stripe\.com\/x\?a=1&b=2/);
  assert.match(email.html, /href="https:\/\/buy\.stripe\.com\/x\?a=1&amp;b=2"/);
  assert.match(email.html, /Pay £1,440\.00/);
});

test('the receipt states what was paid, the running total and any balance', () => {
  const part = buildReceiptEmailData(booking({ amountPaid: 360 }), {
    received: 360, currency: 'GBP', paidAt: '2026-09-27T10:00:00Z', reference: 'pi_1',
  });
  assert.equal(part.amount_received, '£360.00');
  assert.equal(part.total_paid, '£360.00');
  assert.equal(part.balance_due, '£1,080.00');
  assert.equal(part.paid_in_full, false);
  assert.equal(part.paid_on, '27 September 2026');
  const partEmail = buildReceiptEmail(part);
  assert.match(partEmail.subject, /Payment received – booking TMG-1/);
  assert.match(partEmail.text, /A balance of £1,080\.00 remains/);
  assert.match(partEmail.html, /pi_1/);

  const full = buildReceiptEmailData(booking({ amountPaid: 1440 }), { received: 1080, currency: 'GBP', reference: 'pi_2' });
  assert.equal(full.paid_in_full, true);
  const fullEmail = buildReceiptEmail(full);
  assert.match(fullEmail.text, /paid in full and confirmed/);
  assert.ok(!fullEmail.text.includes('Balance remaining'));
});

test('guest-supplied text is escaped in the email', () => {
  const data = buildPaymentEmailData(booking({ guestName: '<script>x</script>' }), { amount: 1, currency: 'GBP', url: 'https://x' });
  assert.ok(!buildPaymentEmail(data).html.includes('<script>'));
});

test('an HTML email posts subject and both bodies to SendGrid', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { status: 202 };
  };
  const outcome = await sendHtmlEmail({
    apiKey: 'SG', fromEmail: 'a@b.com', fromName: 'Club', toEmail: 'g@x.com', subject: 'S', text: 'T', html: '<p>H</p>', fetchImpl,
  });
  assert.equal(outcome.ok, true);
  assert.equal(sent.subject, 'S');
  assert.deepEqual(sent.content.map((c) => c.type), ['text/plain', 'text/html']);
  assert.equal(sent.template_id, undefined);
});

// --- PaymentIntent events, and one payment seen twice -------------------------------

test('a payment_intent.succeeded event is read as the same payment', () => {
  const payment = paidSessionFromEvent({
    type: 'payment_intent.succeeded',
    data: { object: { object: 'payment_intent', id: 'pi_9', amount_received: 72000, currency: 'gbp', metadata: { booking_id: 'TMG-1', club: 'royal_dornoch' } } },
  });
  assert.equal(payment.amount_total, 72000);
  assert.equal(paymentKey(payment), 'pi_9');
  assert.deepEqual(bookingRefFromSession(payment), { bookingId: 'TMG-1', club: 'royal_dornoch', paymentLinkId: null });
  assert.equal(paidSessionFromEvent({ type: 'payment_intent.created', data: { object: { object: 'payment_intent', id: 'pi_9' } } }), null);
});

test('the Checkout and PaymentIntent events for one payment count it once', () => {
  const fromCheckout = session({ payment_intent: 'pi_9' });
  assert.equal(paymentKey(fromCheckout), 'pi_9');
  const fromIntent = paidSessionFromEvent({
    type: 'payment_intent.succeeded',
    data: { object: { object: 'payment_intent', id: 'pi_9', amount_received: 144000, currency: 'gbp', metadata: {} } },
  });
  // Whichever arrived first stored pi_9; the other is recognised.
  assert.equal(applyPaidSession(booking({ stripeCheckoutSessionId: 'pi_9' }), fromCheckout), null);
  assert.equal(applyPaidSession(booking({ stripeCheckoutSessionId: 'pi_9' }), fromIntent), null);
  // A payment recorded before keys moved to the PaymentIntent is still recognised by its session id.
  assert.equal(applyPaidSession(booking({ stripeCheckoutSessionId: 'cs_1' }), fromCheckout), null);
});

test('checking a link asks Stripe for its completed sessions and keeps the paid ones', async () => {
  let asked;
  const fetchImpl = async (url, init) => {
    asked = { url, method: init.method, body: init.body };
    return {
      ok: true,
      json: async () => ({ data: [session({ id: 'cs_paid' }), session({ id: 'cs_unpaid', payment_status: 'unpaid' })] }),
    };
  };
  const paid = await paidSessionsForLink({ secretKey: 'sk_test', linkId: 'plink_1', fetchImpl });
  assert.deepEqual(paid.map((s) => s.id), ['cs_paid']);
  assert.equal(asked.method, 'GET');
  assert.equal(asked.body, undefined);
  const query = new URL(asked.url).searchParams;
  assert.equal(query.get('payment_link'), 'plink_1');
  assert.equal(query.get('status'), 'complete');
});

test('the setup check reads Stripe\'s webhook endpoints as they are registered', async () => {
  const { listWebhookEndpoints } = await import('../src/lib/stripe.js');
  let asked;
  const fetchImpl = async (url, init) => {
    asked = { url, method: init.method };
    return {
      ok: true,
      json: async () => ({
        data: [{ id: 'we_1', url: 'https://dash.example.com/api/stripe/webhook', status: 'enabled', enabled_events: ['checkout.session.completed'], livemode: false }],
      }),
    };
  };
  const endpoints = await listWebhookEndpoints({ secretKey: 'sk_test', fetchImpl });
  assert.equal(asked.method, 'GET');
  assert.match(asked.url, /\/v1\/webhook_endpoints\?limit=100$/);
  assert.deepEqual(endpoints, [
    { id: 'we_1', url: 'https://dash.example.com/api/stripe/webhook', status: 'enabled', events: ['checkout.session.completed'], livemode: false },
  ]);
});
