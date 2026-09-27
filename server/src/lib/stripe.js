/**
 * The slice of the Stripe API the payment-link flow uses: make a one-off price,
 * wrap it in a Payment Link, switch a superseded link off, and check that a
 * webhook really came from Stripe.
 *
 * Like `sendgrid.js`, this is plain `fetch` rather than the SDK — four form
 * POSTs and one HMAC do not justify the dependency.
 *
 * A Payment Link rather than a Checkout Session, because the link is emailed:
 * a Checkout Session expires after 24 hours at most, and a guest may not open
 * the email for a week. The link is limited to one completed payment, so it
 * cannot be paid twice.
 */
import crypto from 'node:crypto';

const API = 'https://api.stripe.com/v1';
const TIMEOUT_MS = 20_000;

/** A Stripe-Signature older than this is refused, so a captured one cannot be replayed. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Currencies Stripe takes in whole units rather than hundredths. */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

export function toMinorUnits(amount, currency) {
  const factor = ZERO_DECIMAL.has(String(currency).toLowerCase()) ? 1 : 100;
  return Math.round(Number(amount) * factor);
}

export function fromMinorUnits(amount, currency) {
  const factor = ZERO_DECIMAL.has(String(currency).toLowerCase()) ? 1 : 100;
  return Math.round(Number(amount)) / factor;
}

/** Stripe's form encoding: nested objects become `a[b][c]=value`. */
export function formEncode(value, prefix = '', out = new URLSearchParams()) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      formEncode(inner, prefix ? `${prefix}[${key}]` : key, out);
    }
  } else {
    out.append(prefix, String(value));
  }
  return out;
}

async function call(secretKey, path, params, fetchImpl, method = 'POST') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const encoded = formEncode(params).toString();
  try {
    const response = await fetchImpl(method === 'GET' && encoded ? `${API}${path}?${encoded}` : `${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      ...(method === 'GET' ? {} : { body: encoded }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Stripe error ${response.status}: ${payload?.error?.message ?? 'request rejected'}`);
    }
    return payload;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Stripe timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A payable link for one booking. The booking id and club ride along as
 * metadata on the link, on the Checkout Session Stripe creates from it, and on
 * the payment itself, so the webhook can find the booking again.
 */
export async function createPaymentLink({
  secretKey,
  amount,
  currency,
  productName,
  bookingId,
  club,
  confirmationMessage,
  fetchImpl = fetch,
}) {
  const metadata = { booking_id: bookingId, club };

  const price = await call(
    secretKey,
    '/prices',
    {
      currency: currency.toLowerCase(),
      unit_amount: toMinorUnits(amount, currency),
      product_data: { name: productName, metadata },
    },
    fetchImpl,
  );

  const link = await call(
    secretKey,
    '/payment_links',
    {
      line_items: { 0: { price: price.id, quantity: 1 } },
      metadata,
      payment_intent_data: { metadata },
      restrictions: { completed_sessions: { limit: 1 } },
      after_completion: {
        type: 'hosted_confirmation',
        hosted_confirmation: { custom_message: confirmationMessage },
      },
    },
    fetchImpl,
  );

  return { id: link.id, url: link.url };
}

/** Switch a link off so a superseded amount cannot still be paid. */
export async function deactivatePaymentLink({ secretKey, linkId, fetchImpl = fetch }) {
  return call(secretKey, `/payment_links/${encodeURIComponent(linkId)}`, { active: false }, fetchImpl);
}

/**
 * The completed, paid Checkout Sessions a payment link has produced — how the
 * dashboard finds a payment for itself when the webhook has not delivered it.
 */
export async function paidSessionsForLink({ secretKey, linkId, fetchImpl = fetch }) {
  const page = await call(
    secretKey,
    '/checkout/sessions',
    { payment_link: linkId, status: 'complete', limit: 10 },
    fetchImpl,
    'GET',
  );
  return (page?.data ?? []).filter((session) => session.payment_status === 'paid');
}

/**
 * The link as it is emailed: the guest's address filled in, and the booking id
 * as the session's client reference — a second way back to the booking should
 * the metadata ever be missing.
 */
export function prefilledLinkUrl(url, { email, bookingId }) {
  const target = new URL(url);
  if (email) target.searchParams.set('prefilled_email', email);
  if (bookingId) target.searchParams.set('client_reference_id', bookingId);
  return target.toString();
}

/**
 * Whether `rawBody` was signed by Stripe with this endpoint's secret.
 *
 * The header is `t=<unix>,v1=<hex>[,v1=<hex>…]`; the signature is an HMAC of
 * `<t>.<body>`. The body must be the exact bytes Stripe sent — which is why
 * the webhook route reads it raw, ahead of the JSON parser.
 */
export function verifyWebhookSignature(rawBody, header, secret, { now = Date.now() / 1000 } = {}) {
  if (!header || !secret) return { ok: false, reason: 'Missing signature or secret' };

  const parts = String(header).split(',').map((part) => part.split('='));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isFinite(timestamp) || !signatures.length) {
    return { ok: false, reason: 'Malformed signature header' };
  }
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'Signature timestamp outside tolerance' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  const matched = signatures.some((signature) => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expectedBuffer.length && crypto.timingSafeEqual(given, expectedBuffer);
  });

  return matched ? { ok: true } : { ok: false, reason: 'Signature mismatch' };
}
