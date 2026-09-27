/**
 * The last few Stripe webhook deliveries, kept in memory so the drawer can say
 * whether Stripe is reaching this dashboard at all — and if it is, what
 * happened. That is the question every "I paid and nothing changed" starts
 * with, and without this it can only be answered from the server logs.
 *
 * In memory on purpose: it is a diagnostic, not a record (the booking row is
 * the record). A restart empties it, and the drawer says "since the server
 * started" for that reason.
 */
const LIMIT = 20;
const entries = [];
export const startedAt = new Date().toISOString();

export function logWebhook({ outcome, type = null, bookingId = null, detail = null }) {
  entries.unshift({ at: new Date().toISOString(), outcome, type, bookingId, detail });
  entries.length = Math.min(entries.length, LIMIT);
}

export function recentWebhooks() {
  return { startedAt, entries: entries.slice() };
}
