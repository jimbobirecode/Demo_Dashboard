/**
 * A guest amending or cancelling their own booking.
 *
 * Two ideas, both pure and both tested here rather than discovered in
 * production.
 *
 * **The link is stateless.** A "manage your booking" link carries the booking
 * reference and an HMAC of it, so nothing is stored and there is no token
 * table to leak. The trade is that such a link cannot be revoked individually
 * — rotating the secret revokes every one at once — which is the right trade
 * for a link that only ever reaches one booking and never signs anybody in.
 *
 * **The club decides, not the software.** A tee time is scarce and usually
 * inside a charging window, so the default is that nothing moves until
 * somebody at the club approves it. A club that would rather let guests cancel
 * freely while it is still far enough out sets a cut-off, and only
 * cancellations outside that window apply themselves.
 */
import crypto from 'node:crypto';

export const REQUEST_KINDS = ['cancel', 'amend'];
export const REQUEST_STATUSES = ['Pending', 'Approved', 'Declined', 'Applied'];

/** Statuses a guest may still act on. A played or cancelled round is finished. */
export const MANAGEABLE_STATUSES = ['Inquiry', 'Requested', 'Booked'];

/**
 * Read the self-service policy.
 *
 * `BOOKING_SELF_CANCEL_DAYS` unset means every request goes to the club, which
 * is the safe default: a club that has not thought about this should not
 * discover its policy by having a tee time vanish.
 */
export function readChangePolicy(env = process.env) {
  const raw = env.BOOKING_SELF_CANCEL_DAYS;
  const days = Number.parseInt(raw, 10);

  return {
    // Cancellations this many days or more before play apply immediately.
    selfCancelDays: Number.isFinite(days) && days >= 0 ? days : null,
    selfCancelEnabled: Number.isFinite(days) && days >= 0,
    // Amendments are never automatic: "could we move to Sunday" is a
    // conversation about availability, not a state change.
    amendNeedsApproval: true,
    secretConfigured: Boolean(env.JWT_SECRET || env.BOOKING_LINK_SECRET),
  };
}

/** The key the manage links are signed with. */
export function linkSecret(env = process.env) {
  return env.BOOKING_LINK_SECRET || env.JWT_SECRET || null;
}

/**
 * The signature on a manage link.
 *
 * Scoped to the club as well as the booking so a reference reused across two
 * installs of this dashboard cannot be opened with the wrong one's link.
 */
export function signBooking(bookingId, secret, club = '') {
  if (!secret) return null;
  return crypto
    .createHmac('sha256', String(secret))
    .update(`${club}|${bookingId}`)
    .digest('base64url')
    .slice(0, 32);
}

/** Constant-time comparison, so a wrong token cannot be found a byte at a time. */
export function verifyBookingToken(bookingId, token, secret, club = '') {
  const expected = signBooking(bookingId, secret, club);
  if (!expected || !token) return false;

  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(token));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function manageLink(appUrl, bookingId, token) {
  const base = String(appUrl ?? '').replace(/\/+$/, '');
  return `${base}/manage-booking?ref=${encodeURIComponent(bookingId)}&token=${encodeURIComponent(token)}`;
}

/** Whole days from today to the round. Negative once it has been played. */
export function daysUntilPlay(date, today) {
  const play = Date.parse(`${date}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(play) || Number.isNaN(now)) return null;
  return Math.round((play - now) / 86_400_000);
}

/**
 * What this guest may do with this booking, right now.
 *
 * Returned as reasons rather than booleans, because the page has to tell
 * somebody *why* they cannot cancel online — and "ring the club" is a worse
 * answer when it does not say what happened.
 */
export function describeOptions(booking, policy, today) {
  const days = booking?.date ? daysUntilPlay(booking.date, today) : null;

  if (!booking || !MANAGEABLE_STATUSES.includes(booking.status)) {
    return {
      canCancel: false,
      canAmend: false,
      autoCancel: false,
      daysUntilPlay: days,
      reason: booking?.status === 'Cancelled'
        ? 'This booking has already been cancelled.'
        : 'This booking can no longer be changed online.',
    };
  }

  if (days !== null && days < 0) {
    return {
      canCancel: false,
      canAmend: false,
      autoCancel: false,
      daysUntilPlay: days,
      reason: 'This round has already been played.',
    };
  }

  const autoCancel = policy.selfCancelEnabled && days !== null && days >= policy.selfCancelDays;

  return {
    canCancel: true,
    canAmend: true,
    autoCancel,
    daysUntilPlay: days,
    // Said plainly, so nobody is surprised by what the button did.
    reason: autoCancel
      ? 'Cancelling now takes effect immediately.'
      : 'The club will confirm your request — nothing changes until they do.',
  };
}

/** What a request has to carry before it is worth storing. */
export function validateChangeRequest(input, options) {
  const errors = [];

  const kind = String(input?.kind ?? '').trim().toLowerCase();
  if (!REQUEST_KINDS.includes(kind)) errors.push('Choose whether to amend or cancel');

  if (kind === 'cancel' && !options.canCancel) errors.push(options.reason);
  if (kind === 'amend' && !options.canAmend) errors.push(options.reason);

  const message = String(input?.message ?? '').trim();
  // An amendment with no words is a request the club cannot act on.
  if (kind === 'amend' && !message && !input?.requestedDate) {
    errors.push('Tell us what you would like to change');
  }
  if (message.length > 2000) errors.push('Please keep the message under 2000 characters');

  const requestedDate = String(input?.requestedDate ?? '').trim();
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    errors.push('That date is not valid');
  }

  const players = input?.requestedPlayers === undefined || input?.requestedPlayers === ''
    ? null
    : Number(input.requestedPlayers);
  if (players !== null && (!Number.isInteger(players) || players < 1 || players > 40)) {
    errors.push('Players must be a whole number between 1 and 40');
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      kind,
      message,
      requestedDate: requestedDate || null,
      requestedTime: String(input?.requestedTime ?? '').trim() || null,
      requestedPlayers: players,
    },
  };
}

/** A stored request as the dashboard wants it. */
export function serialiseChangeRequest(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    kind: row.kind,
    message: row.message ?? '',
    requestedDate: dateOnly(row.requested_date),
    requestedTime: row.requested_time ?? null,
    requestedPlayers: row.requested_players ?? null,
    status: row.status,
    autoApplied: Boolean(row.auto_applied),
    daysBeforePlay: row.days_before_play ?? null,
    guestEmail: row.guest_email ?? '',
    createdAt: iso(row.created_at),
    resolvedAt: iso(row.resolved_at),
    resolvedBy: row.resolved_by ?? null,
    resolutionNote: row.resolution_note ?? '',
    open: row.status === 'Pending',
    // 'email' when it was read out of a guest's email rather than asked for
    // on the manage-booking page (migration_add_email_inbox.sql).
    source: row.source ?? 'link',
    emailMessageId: row.email_message_id ?? null,
  };
}

/** How the request reads in a list, without opening it. */
export function describeRequest(request) {
  if (request.kind === 'cancel') {
    return request.autoApplied ? 'Cancelled by the guest' : 'Asks to cancel';
  }
  const parts = [];
  if (request.requestedDate) parts.push(`move to ${request.requestedDate}`);
  if (request.requestedTime) parts.push(`at ${request.requestedTime}`);
  if (request.requestedPlayers) parts.push(`${request.requestedPlayers} players`);
  return parts.length ? `Asks to ${parts.join(', ')}` : 'Asks for a change';
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
