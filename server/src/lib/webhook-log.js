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

export function logWebhook({ outcome, type = null, bookingId = null, club = null, detail = null }) {
  entries.unshift({ at: new Date().toISOString(), outcome, type, bookingId, club, detail });
  entries.length = Math.min(entries.length, LIMIT);
}

/**
 * The deliveries one club may see.
 *
 * One process can serve several clubs, and an entry names a booking, so a
 * club sees its own entries and the ones that belong to no club (a refused
 * signature, an event type we ignore) — those say whether Stripe is reaching
 * the server at all, and carry no booking reference.
 */
export function recentWebhooks(club) {
  const visible = entries
    .filter((entry) => entry.club === club || entry.club === null)
    .map(({ club: owner, ...entry }) => (owner === null ? { ...entry, bookingId: null } : entry));
  return { startedAt, entries: visible };
}
