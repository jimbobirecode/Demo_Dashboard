/**
 * Emailing a guest a Stripe payment link, and recording the payment when
 * Stripe reports it.
 *
 * The lifecycle on the booking's payment status:
 *
 *   send link   -> 'Pending'  (a link is out; nothing has been received)
 *   webhook     -> 'Paid' when the money now covers the total,
 *                  'Deposit paid' when it covers part of it
 *
 * Everything here is pure: the routes do the I/O.
 */
import { BRAND } from './brand.js';
import { fromMinorUnits } from './stripe.js';
import { EMAIL_COLORS, brandTemplateData, brandedEmail } from './email-layout.js';

/** The payment status a booking carries while a link is out and unpaid. */
export const PENDING_PAYMENT_STATUS = 'Pending';

/**
 * What the environment provides. Stripe and SendGrid are both needed to send;
 * the webhook secret is needed for payments to be recorded, and a link sent
 * without it would sit at Pending forever, so it is required too.
 */
export function readPaymentLinkConfig(env = process.env) {
  const missing = [];
  if (!env.STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY');
  if (!env.STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!env.SENDGRID_API_KEY) missing.push('SENDGRID_API_KEY');
  if (!env.FROM_EMAIL) missing.push('FROM_EMAIL');
  const useTemplates = /^(1|true|yes|on)$/i.test(String(env.USE_SENDGRID_PAYMENT_TEMPLATES ?? ''));

  return {
    secretKey: env.STRIPE_SECRET_KEY ?? null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    sendgridKey: env.SENDGRID_API_KEY ?? null,
    fromEmail: env.FROM_EMAIL ?? null,
    fromName: env.FROM_NAME ?? BRAND.fromName,
    // The built-in link and receipt carry the club's current name and logo. A
    // SendGrid template is a copy of the branding kept in SendGrid, and the
    // ones set up earlier still carry the previous club's, so a template is
    // used only when USE_SENDGRID_PAYMENT_TEMPLATES says it has been checked.
    templateId: useTemplates ? env.SENDGRID_TEMPLATE_PAYMENT_LINK ?? null : null,
    receiptTemplateId: useTemplates ? env.SENDGRID_TEMPLATE_PAYMENT_RECEIPT ?? null : null,
    currency: (env.STRIPE_CURRENCY ?? BRAND.currency).toUpperCase(),
    testMode: String(env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_'),
    missing,
    configured: missing.length === 0,
  };
}

/** The config with every secret stripped, for the browser. */
export function publicPaymentLinkConfig(config) {
  return {
    configured: config.configured,
    missing: config.missing,
    currency: config.currency,
    testMode: config.testMode,
    usesTemplate: Boolean(config.templateId),
  };
}

/** Why a link cannot be sent for this booking and amount, or null if it can. */
export function linkProblem(booking, amount) {
  if (!booking) return 'Booking not found';
  if (!booking.guestEmail) return 'This booking has no guest email address';
  if (['Rejected', 'Cancelled'].includes(booking.status)) {
    return `A ${booking.status.toLowerCase()} booking cannot be sent a payment link`;
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 'The amount must be more than zero';
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    return 'The amount can have at most two decimal places';
  }
  // Stripe's own floor is about 30p/50c; below it the link would be refused.
  if (value < 0.5) return 'The amount must be at least 0.50';
  return null;
}

/** The amount the dashboard offers by default: whatever is still owed. */
export function suggestedAmount(booking) {
  const outstanding = booking?.payment?.outstanding;
  if (Number.isFinite(outstanding) && outstanding > 0) return outstanding;
  const total = Number(booking?.total) || 0;
  const paid = Number(booking?.amountPaid) || 0;
  return Math.max(Math.round((total - paid) * 100) / 100, 0);
}

export function formatMoney(amount, currency = BRAND.currency) {
  return new Intl.NumberFormat(BRAND.locale, { style: 'currency', currency }).format(Number(amount) || 0);
}

function formatPlayDate(date) {
  if (!date) return '';
  const value = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(value.getTime())) return String(date);
  return new Intl.DateTimeFormat(BRAND.locale, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(value).replace(',', ''); // 'Wednesday 12 May 2027', as the other guest emails write it
}

function firstName(booking) {
  const name = String(booking.guestName ?? '').trim();
  if (name) return name.split(/\s+/)[0];
  return 'there';
}

/** What a dynamic template is given, and what the built-in email is written from. */
export function buildPaymentEmailData(booking, { amount, currency, url }) {
  return {
    ...brandTemplateData(),
    first_name: firstName(booking),
    guest_name: booking.guestName ?? '',
    booking_id: booking.bookingId,
    club_name: BRAND.fullName,
    play_date: formatPlayDate(booking.date),
    tee_time: booking.teeTime && booking.teeTime !== 'Not Specified' ? booking.teeTime : '',
    players: booking.players ?? '',
    course: booking.golfCourses ?? '',
    amount: formatMoney(amount, currency),
    booking_total: formatMoney(booking.total, currency),
    payment_url: url,
  };
}

const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The email sent when no SendGrid template is configured: plain, branded by
 * name, and readable with images off. A club that wants its own design sets
 * SENDGRID_TEMPLATE_PAYMENT_LINK and this is never used.
 */
export function buildPaymentEmail(data) {
  const subject = `Payment for your booking ${data.booking_id} – ${data.club_name}`;
  const details = [
    ['Booking reference', data.booking_id],
    ['Date', data.play_date],
    ['Tee time', data.tee_time],
    ['Course', data.course],
    ['Players', data.players],
    ['Amount due', data.amount],
  ].filter(([, value]) => value !== '' && value != null);

  const text = [
    `Hi ${data.first_name},`,
    '',
    `Thank you for booking with ${data.club_name}. You can pay ${data.amount} securely online here:`,
    data.payment_url,
    '',
    ...details.map(([label, value]) => `${label}: ${value}`),
    '',
    'If you have any questions, just reply to this email.',
    '',
    data.club_name,
  ].join('\n');

  const html = emailShell({
    clubName: data.club_name,
    paragraphs: [
      `Hi ${escape(data.first_name)},`,
      `Thank you for booking with ${escape(data.club_name)}. You can pay <strong>${escape(data.amount)}</strong> securely online using the button below.`,
    ],
    button: { href: data.payment_url, label: `Pay ${data.amount}` },
    details,
    footer:
      'Payments are processed securely by Stripe. If the button does not work, copy this link into your browser:<br>' +
      `<a href="${escape(data.payment_url)}" style="color:#1a5e58;word-break:break-all;">${escape(data.payment_url)}</a><br><br>` +
      'Questions? Just reply to this email.',
  });

  return { subject, text, html };
}

/**
 * The frame both built-in emails share. `paragraphs` and `footer` are HTML the
 * caller has already escaped; `details` and the button are escaped here.
 */
function emailShell({ clubName, paragraphs, button = null, details = [], footer = '' }) {
  const c = EMAIL_COLORS;
  const rows = details
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 0;color:${c.muted};">${escape(label)}</td>` +
        `<td style="padding:6px 0;text-align:right;font-weight:600;color:${c.text};">${escape(value)}</td></tr>`,
    )
    .join('');

  const content =
    paragraphs.map((p, i) => `<p style="margin:0 0 ${i === paragraphs.length - 1 ? 20 : 12}px;">${p}</p>`).join('\n') +
    (button
      ? `<div style="text-align:center;padding:4px 0 24px;"><a href="${escape(button.href)}" style="display:inline-block;background:${c.primary};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:6px;">${escape(button.label)}</a></div>`
      : '') +
    (rows ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${c.rule};font-size:14px;">${rows}</table>` : '') +
    (footer ? `<div style="padding-top:16px;font-size:13px;line-height:1.6;color:${c.muted};">${footer}</div>` : '');

  // clubName is carried by the shared header and footer.
  void clubName;
  return brandedEmail(content);
}

/**
 * What a receipt template is given, and what the built-in receipt is written
 * from. `received` is this payment; the booking already carries the new
 * running total, so the balance is what is left after it.
 */
export function buildReceiptEmailData(booking, { received, currency, paidAt, reference }) {
  const total = Number(booking.total) || 0;
  const paid = Number(booking.amountPaid) || 0;
  const balance = Math.max(Math.round((total - paid) * 100) / 100, 0);

  return {
    ...brandTemplateData(),
    first_name: firstName(booking),
    guest_name: booking.guestName ?? '',
    booking_id: booking.bookingId,
    club_name: BRAND.fullName,
    play_date: formatPlayDate(booking.date),
    tee_time: booking.teeTime && booking.teeTime !== 'Not Specified' ? booking.teeTime : '',
    players: booking.players ?? '',
    course: booking.golfCourses ?? '',
    amount_received: formatMoney(received, currency),
    paid_on: formatPaidOn(paidAt),
    payment_reference: reference ?? '',
    booking_total: formatMoney(total, currency),
    total_paid: formatMoney(paid, currency),
    balance_due: formatMoney(balance, currency),
    paid_in_full: balance === 0,
  };
}

function formatPaidOn(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(BRAND.locale, {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: BRAND.timeZone,
  }).format(date);
}

/** The receipt sent when no SendGrid receipt template is configured. */
export function buildReceiptEmail(data) {
  const subject = `Payment received – booking ${data.booking_id} – ${data.club_name}`;
  const details = [
    ['Amount received', data.amount_received],
    ['Paid on', data.paid_on],
    ['Payment reference', data.payment_reference],
    ['Booking reference', data.booking_id],
    ['Date', data.play_date],
    ['Tee time', data.tee_time],
    ['Course', data.course],
    ['Players', data.players],
    ['Booking total', data.booking_total],
    ['Paid to date', data.total_paid],
    ...(data.paid_in_full ? [] : [['Balance remaining', data.balance_due]]),
  ].filter(([, value]) => value !== '' && value != null);

  const status = data.paid_in_full
    ? 'Your booking is paid in full and confirmed.'
    : `Your booking is confirmed. A balance of ${data.balance_due} remains.`;

  const text = [
    `Hi ${data.first_name},`,
    '',
    `Thank you — we have received your payment of ${data.amount_received}. ${status}`,
    '',
    ...details.map(([label, value]) => `${label}: ${value}`),
    '',
    'Please keep this email as your receipt. We look forward to welcoming you.',
    '',
    data.club_name,
  ].join('\n');

  const html = emailShell({
    clubName: data.club_name,
    paragraphs: [
      `Hi ${escape(data.first_name)},`,
      `Thank you — we have received your payment of <strong>${escape(data.amount_received)}</strong>. ${escape(status)}`,
    ],
    details,
    footer: 'Please keep this email as your receipt. We look forward to welcoming you.<br><br>Questions? Just reply to this email.',
  });

  return { subject, text, html };
}

/**
 * The Stripe events that mean money has arrived, as one shape.
 *
 * A Checkout Session event and a PaymentIntent event both describe the same
 * payment, and a Stripe endpoint may be subscribed to either or both. Both
 * carry the booking in their metadata (the link sets it on each), and both are
 * reduced to the same fields here — including the PaymentIntent id, which is
 * what makes the two count as one payment rather than two.
 *
 * A card payment completes paid; a bank debit completes unpaid and succeeds
 * later, asynchronously.
 */
export const PAYMENT_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'payment_intent.succeeded',
];

export function paidSessionFromEvent(event) {
  const object = event?.data?.object;
  if (!object) return null;

  if (object.object === 'checkout.session') {
    if (event.type === 'checkout.session.completed' && object.payment_status === 'paid') return object;
    if (event.type === 'checkout.session.async_payment_succeeded') return object;
    return null;
  }

  if (object.object === 'payment_intent' && event.type === 'payment_intent.succeeded') {
    return {
      object: 'payment_intent',
      id: object.id,
      amount_total: object.amount_received ?? object.amount,
      currency: object.currency,
      metadata: object.metadata ?? {},
      payment_intent: object.id,
      payment_link: null,
      client_reference_id: null,
    };
  }
  return null;
}

/**
 * The id a payment is counted under: its PaymentIntent where there is one, so
 * the Checkout Session event and the PaymentIntent event for the same payment
 * are recognised as one.
 */
export function paymentKey(session) {
  return typeof session?.payment_intent === 'string' && session.payment_intent ? session.payment_intent : session.id;
}

/** Which booking a paid session belongs to, from whatever it carries. */
export function bookingRefFromSession(session) {
  return {
    bookingId: session?.metadata?.booking_id || session?.client_reference_id || null,
    club: session?.metadata?.club || null,
    paymentLinkId: typeof session?.payment_link === 'string' ? session.payment_link : null,
  };
}

/**
 * What the booking's payment columns become once this session is counted.
 * Returns null when the session has already been counted, so a webhook Stripe
 * delivers twice (it retries until it gets a 2xx) never adds the money twice.
 */
export function applyPaidSession(booking, session) {
  const key = paymentKey(session);
  const counted = booking.stripeCheckoutSessionId;
  if (counted && (counted === key || counted === session.id)) return null;

  const received = fromMinorUnits(session.amount_total ?? 0, session.currency ?? BRAND.currency);
  const total = Number(booking.total) || 0;
  const amountPaid = Math.round(((Number(booking.amountPaid) || 0) + received) * 100) / 100;

  return {
    received,
    amountPaid,
    paymentStatus: total > 0 && amountPaid + 0.005 < total ? 'Deposit paid' : 'Paid',
    // Money received means the tee time is taken: an open enquiry becomes
    // Booked. A booking the club has rejected or cancelled is left alone for a
    // person to sort out (usually a refund), never silently revived.
    bookingStatus: ADVANCES_ON_PAYMENT.includes(booking.status) ? 'Booked' : booking.status,
    reference: typeof session.payment_intent === 'string' ? session.payment_intent : session.id,
  };
}

/** Statuses a payment moves on to Booked. */
const ADVANCES_ON_PAYMENT = ['Inquiry', 'Requested'];
