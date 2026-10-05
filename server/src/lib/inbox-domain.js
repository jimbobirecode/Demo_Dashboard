/**
 * The Inbox and a booking's conversation, as rules rather than queries.
 *
 * Inbound emails the core API could not (or should not) answer by itself are
 * held here with what Claude understood and a drafted reply; a person edits the
 * draft and sends it. Everything here is pure so it can be tested without a
 * database or SendGrid.
 */
import { BRAND } from './brand.js';
import { brandedEmail } from './email-layout.js';

export const REVIEW_STATUSES = ['open', 'replied', 'dismissed'];

/**
 * Filters the Inbox list understands. `deleted` is not a review status — an
 * email keeps whatever it had when it was deleted — so it is a filter of its
 * own, and every other filter shows live emails only.
 */
export const DELETED_FILTER = 'deleted';

/** Longest note we store. Long enough for a phone call, short enough to read. */
export const NOTE_MAX = 2000;

export const INTENT_LABELS = {
  new_enquiry: 'Enquiry',
  booking_reply: 'Reply to our email',
  change_request: 'Change request',
  cancellation: 'Cancellation',
  question: 'Question',
  complaint: 'Complaint',
  operator_request: 'Tour operator',
  membership_enquiry: 'Membership enquiry',
  not_booking: 'Not a booking',
  other: 'Other',
};

export const ROUTE_LABELS = {
  received: 'Received',
  auto_reply: 'Answered automatically',
  booking_request: 'Booking request',
  inbox: 'Held for the team',
  change_request: 'Filed as a Guest Request',
  ignored: 'Ignored',
  // A membership enquiry, answered by the core API with the categories (or the
  // waitlist when applications are closed) and filed on the Membership page.
  membership: 'Sent to Membership',
  // The core API records an inbound email before it answers SendGrid and
  // claims it while a worker handles it. Neither needs a person yet: an email
  // stuck there is handed to the Inbox ('inbox', review open) by the core
  // API's recovery sweep.
  queued: 'Queued',
  processing: 'Being processed',
};

/** Routes of inbound emails the core API has not finished with. */
export const IN_FLIGHT_ROUTES = ['queued', 'processing'];

/**
 * Routes whose emails are read somewhere other than the Inbox.
 *
 * Membership correspondence belongs on the Membership page, beside the
 * application, its timeline and the club's decisions — an answered enquiry,
 * a reply from the enquirer, an email that could not be sent. The core API
 * only leaves a membership email for the Inbox when it produced no
 * application at all (membership misconfigured, database unreachable), and
 * that one is routed to 'inbox' like anything else needing a person.
 */
export const ROUTES_READ_ELSEWHERE = ['membership'];

/** SQL: this row is not one the core API is still working on. `alias` is the table alias, if any. */
export function notInFlightSql(alias = '') {
  return excludedRoutesSql(IN_FLIGHT_ROUTES, alias);
}

/** SQL: this row belongs in the Inbox at all — see ROUTES_READ_ELSEWHERE. `alias` is the table alias, if any. */
export function belongsInInboxSql(alias = '') {
  return excludedRoutesSql(ROUTES_READ_ELSEWHERE, alias);
}

/**
 * SQL: this email is still in the mailbox (not deleted). `alias` is the table
 * alias, if any.
 *
 * Deleting is recoverable: the row stays, because a membership application, a
 * guest request and a reply's own thread all point at it. Everything that
 * reads the mailbox — the lists, the counts, a booking's conversation, an
 * application's thread — has to say so, or a deleted email comes back.
 */
export function notDeletedSql(alias = '') {
  return `${alias ? `${alias}.` : ''}deleted_at IS NULL`;
}

/** Why this note cannot be saved, or null. */
export function noteProblem({ note }) {
  const text = String(note ?? '').trim();
  if (!text) return 'The note is empty';
  if (text.length > NOTE_MAX) return `A note can be at most ${NOTE_MAX} characters`;
  return null;
}

/** One note on an email, as the dashboard reads it. */
export function serialiseNote(row) {
  return {
    id: row.id,
    messageId: row.message_id,
    note: row.note ?? '',
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at),
  };
}

function excludedRoutesSql(routes, alias) {
  const column = alias ? `${alias}.routed_to` : 'routed_to';
  return `COALESCE(${column}, '') NOT IN (${routes.map((route) => `'${route}'`).join(', ')})`;
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

export function serialiseMessage(row) {
  let extraction = row.extraction ?? null;
  if (typeof extraction === 'string') {
    try {
      extraction = JSON.parse(extraction);
    } catch {
      extraction = null;
    }
  }
  return {
    id: row.id,
    direction: row.direction,
    bookingId: row.booking_id ?? null,
    fromEmail: row.from_email ?? '',
    // Only the Inbox list query supplies it (from the linked booking).
    guestName: row.booking_guest_name ?? null,
    toEmail: row.to_email ?? '',
    subject: row.subject ?? '',
    body: row.body_text ?? '',
    intent: row.intent ?? null,
    intentLabel: row.intent ? (INTENT_LABELS[row.intent] ?? row.intent) : null,
    summary: row.summary ?? '',
    extraction,
    routedTo: row.routed_to ?? null,
    routeLabel: row.routed_to ? (ROUTE_LABELS[row.routed_to] ?? row.routed_to) : null,
    changeRequestId: row.change_request_id ?? null,
    reviewStatus: row.review_status ?? 'none',
    reviewReason: row.review_reason ?? '',
    draftReply: row.draft_reply ?? '',
    handledAt: iso(row.handled_at),
    handledBy: row.handled_by ?? null,
    deletedAt: iso(row.deleted_at),
    deletedBy: row.deleted_by ?? null,
    sentBy: row.sent_by ?? null,
    kind: row.kind ?? null,
    inReplyTo: row.in_reply_to ?? null,
    createdAt: iso(row.created_at),
  };
}

/**
 * The subject a reply goes out under: "Re: …" once, and the booking reference
 * in it when there is one — that is what threads the guest's next email back
 * onto the booking.
 */
export function replySubject(subject, bookingId) {
  let base = String(subject ?? '').trim() || `Your message to ${BRAND.fullName}`;
  if (!/^re:/i.test(base)) base = `Re: ${base}`;
  if (bookingId && !base.toUpperCase().includes(String(bookingId).toUpperCase())) {
    base = `${base} [${bookingId}]`;
  }
  return base;
}

/** Why a reply cannot be sent, or null. */
export function replyProblem({ to, body }) {
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) return 'No valid address to reply to';
  if (!String(body ?? '').trim()) return 'The reply is empty';
  if (String(body).length > 20_000) return 'The reply is too long';
  return null;
}

/** When the guest wrote, in the club's own time — as the dashboard shows it. */
function wroteAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(BRAND.locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: BRAND.timeZone,
  }).format(date);
}

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * A staff reply as it is sent: the text they typed, as plain text and as
 * simple HTML, with the guest's original quoted underneath so the guest (and
 * whoever reads the reply next) sees what is being answered.
 */
export function buildReplyEmail({ body, original = null, manageUrl = null }) {
  const typed =
    String(body).trim() + (manageUrl ? `\n\nNeed to change or cancel? Manage your booking: ${manageUrl}` : '');
  const quote = original
    ? `\n\n----\nOn ${wroteAt(original.createdAt)}, ${original.fromEmail} wrote:\n` +
      String(original.body ?? '')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : '';
  const text = typed + quote;

  const paragraphs =
    String(body)
      .trim()
      .split(/\n{2,}/)
      .map((para) => `<p style="margin:0 0 14px;">${escape(para).replace(/\n/g, '<br>')}</p>`)
      .join('') +
    (manageUrl
      ? `<p style="margin:0 0 14px;font-size:13px;color:#5b6b63;">Need to change or cancel? <a href="${escape(manageUrl)}" style="color:#1a5e58;font-weight:600;">Manage your booking</a></p>`
      : '');
  const quoted = original
    ? `<div style="margin-top:24px;padding-left:12px;border-left:3px solid #d6dfda;color:#6b7a72;font-size:13px;">` +
      `<div style="margin-bottom:6px;">On ${escape(wroteAt(original.createdAt))}, ${escape(original.fromEmail)} wrote:</div>` +
      `${escape(original.body).replace(/\n/g, '<br>')}</div>`
    : '';
  const html = brandedEmail(`${paragraphs}${quoted}`);

  return { text, html };
}
