/**
 * The booked-customer handover, as rules rather than as a network call.
 *
 * A club's other systems - a CRM, a starter's sheet, a group's own back
 * office - mostly want one thing from this dashboard: who is actually coming
 * to play. Not the enquiries, not the ones still being negotiated. So the
 * handover is tied to the one moment that answers it, the booking reaching
 * 'Booked', and carries one customer per POST.
 *
 * Everything here is pure, for the same reason `vero-domain.js` is: the
 * decisions worth being sure about - is it configured, what exactly is sent
 * about a guest - should be readable and testable without an API key and
 * without a receiver on the other end.
 */

/** The header the key travels in, absent an override. */
const DEFAULT_AUTH_HEADER = 'x-webhook-key';

/** The partner name the receiver files these customers under, absent an override. */
const DEFAULT_SOURCE = 'dornoch';

/**
 * The integration as the environment has it, with the key reduced to a
 * yes/no — this shape is handed to the browser, so it must never carry the
 * key.
 *
 * Absent `BOOKED_WEBHOOK_URL` and `BOOKED_WEBHOOK_KEY` the whole thing is off
 * and nothing about a booking leaves this dashboard. That is the important
 * default: a half-configured integration must not quietly start posting a
 * club's guests somewhere.
 *
 * The key is required, not optional. The body carries a name, an email
 * address and a phone number, and an endpoint that will accept it from
 * anybody who finds the URL is not somewhere to send that.
 */
export function readBookedWebhookConfig(env = process.env) {
  const url = (env.BOOKED_WEBHOOK_URL || '').trim();
  const apiKey = env.BOOKED_WEBHOOK_KEY ?? null;

  const missing = [];
  if (!url) missing.push('BOOKED_WEBHOOK_URL');
  if (!apiKey) missing.push('BOOKED_WEBHOOK_KEY');

  // An http:// endpoint would put the guest's details on the wire in clear.
  // Localhost is let through so the integration can be tried against a
  // receiver on the developer's own machine.
  const insecure = Boolean(url) && !isSecureUrl(url);

  return {
    enabled: missing.length === 0 && !insecure,
    url,
    apiKey,
    authHeader: (env.BOOKED_WEBHOOK_AUTH_HEADER || DEFAULT_AUTH_HEADER).trim().toLowerCase(),
    source: (env.BOOKED_WEBHOOK_SOURCE || DEFAULT_SOURCE).trim().toLowerCase(),
    missing,
    insecure,
  };
}

/** Strips the key, for anything that crosses the wire. */
export function publicBookedWebhookConfig(config) {
  const { apiKey, ...rest } = config;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

/** https, or http on a loopback address for local development. */
function isSecureUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
}

/**
 * What is sent about one booked customer.
 *
 * Deliberately narrow: who they are, and the round they are booked on. No
 * money, no lodging, no caddie or special-request free text. Those are the
 * club's commercial terms and the guest's own words, they are not needed to
 * identify a customer or a tee time, and the cheapest way to keep them out of
 * somebody else's database is never to send them.
 *
 * `bookedAt` is when this dashboard saw the booking reach 'Booked', which is
 * what a receiver reconciling its own records needs; `sentAt` is when this
 * POST was made, and the two differ on a retry or a backfill.
 */
export function buildBookedCustomerPayload(booking, { source, sentAt = new Date() } = {}) {
  return {
    source: source ?? null,
    event: 'booking.booked',
    sentAt: sentAt.toISOString(),
    club: booking.club ?? null,
    bookingRef: booking.bookingId,
    status: booking.status,
    bookedAt: booking.updatedAt ?? null,
    customer: {
      name: booking.guestName || null,
      email: booking.guestEmail || null,
      phone: booking.contactPhone || null,
    },
    round: {
      date: booking.date ?? null,
      teeTime: booking.teeTime ?? null,
      players: booking.players ?? null,
      course: booking.golfCourses || null,
    },
  };
}

/**
 * Whether this booking is one to hand over.
 *
 * A booking with no email address and no phone number is not a customer any
 * receiver can do anything with — an imported tee-sheet row is often just a
 * name and a time — so it is left unsent rather than posted as a near-empty
 * record. It is not an error, and nothing retries it; adding contact details
 * later makes it sendable, and the sweep will find it then.
 */
export function shouldSendBooked(booking) {
  if (!booking || booking.status !== 'Booked') return false;
  if (booking.bookedWebhookSentAt) return false;
  return Boolean(booking.guestEmail || booking.contactPhone);
}
