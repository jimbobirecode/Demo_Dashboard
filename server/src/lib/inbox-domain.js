/**
 * The Inbox and a booking's conversation, as rules rather than queries.
 *
 * Inbound emails the core API could not (or should not) answer by itself are
 * held here with what Claude understood and a drafted reply; a person edits the
 * draft and sends it. Everything here is pure so it can be tested without a
 * database or SendGrid.
 */
import { BRAND } from './brand.js';
import { EMAIL_COLORS, brandedEmail } from './email-layout.js';

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
    // The name on their own From header, where their mail client put a real
    // one there. Not evidence of who owns the address -- anyone can write
    // anything in that header -- but it is how they sign themselves, and it is
    // the only name the club has for an address with no account and no booking
    // of its own.
    fromName: row.from_name ?? null,
    // Only the Inbox list query supplies these (from the linked booking), and
    // the name is the booking's lead guest - who is not always the person who
    // wrote, so it is given here with the address to tell them apart by.
    guestName: row.booking_guest_name ?? null,
    bookingGuestEmail: row.booking_guest_email ?? null,
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

/**
 * Who an address belongs to, and what to call them.
 *
 * The club's trade arrives through tour operators, and an operator's mailbox
 * is not a person. `john@destinationgolfservices.com` is on six bookings here
 * under six different golfers' names: it is the agent who books them, and the
 * name on any one booking is a client of theirs, not the owner of the address.
 * Reading a name off the booking and putting it at the top of a reply is how
 * the club writes "Hi Daniel," to a travel agent about somebody else's round.
 *
 * So an address is identified in this order:
 *
 *   1. A tour operator account that owns it (its contact address, or its own
 *      sending domain). The club already recorded who they are; that record
 *      beats anything inferred from a booking.
 *   2. A booking address that belongs to exactly ONE person. One name on one
 *      address is a guest writing from their own mailbox.
 *   3. The name on their own From header, which the club's mail keeps. It is
 *      not evidence of who owns an address, so it never outranks the club's
 *      own records -- but "Adam Gordon" is a great deal more use on screen
 *      than adam@halcyongolftravel.com, and it is what he calls himself.
 *   4. Anything else is shown as the address. An unknown correspondent is
 *      named by their address, never by a guess.
 *
 * An address several bookings share under different names stays unnamed for
 * the purpose of being greeted, header or no header: it is a desk, and
 * whoever is at it today is not whoever wrote last week. It still takes the
 * header as a LABEL, because "Fairways and FunDays" is a clearer thing to see
 * in a list than info@fairwaysandfundays.com.
 */
export function describeCorrespondent({ email = '', operator = null, guestNames = [], headerName = '' } = {}) {
  const signed = String(headerName ?? '').trim();
  const address = String(email ?? '')
    .trim()
    .toLowerCase();
  const none = { email: address, kind: 'unknown', name: '', label: address, note: '' };
  if (!address) return { ...none, label: '' };

  if (operator?.name) {
    return {
      email: address,
      kind: 'operator',
      name: operator.name,
      label: operator.name,
      operatorId: operator.id ?? null,
      note: 'Tour operator. This address books on behalf of their clients, so it is not any one guest’s.',
    };
  }

  const names = [...new Set(guestNames.map((name) => String(name ?? '').trim()).filter(Boolean))];
  if (names.length === 1) return { email: address, kind: 'guest', name: names[0], label: names[0], note: '' };
  if (names.length > 1) {
    const shown = names.slice(0, 3).join(', ');
    return {
      email: address,
      kind: 'shared',
      name: '',
      label: signed || address,
      note: `This address books for more than one person (${shown}${names.length > 3 ? ', and others' : ''}), so it is nobody’s name to be greeted by.`,
    };
  }
  if (signed) {
    return {
      email: address,
      kind: 'self-named',
      name: signed,
      label: signed,
      note: '',
    };
  }
  return none;
}

/**
 * Who a fresh email about a booking goes to.
 *
 * Not the lead guest by default. Most of a club's trade comes in through tour
 * operators: the booking carries the lead guest's name and address, but every
 * email on it has been with the operator who made it, and an answer sent to
 * the lead guest goes to somebody who never wrote and leaves the operator
 * waiting. So the conversation decides — whoever last wrote in is who the club
 * is talking to — and the booking's own address is the fallback for a booking
 * nobody has emailed about yet.
 *
 * `requested` is the address the composer showed the person writing: honoured
 * when it is already part of this conversation (either end of any email on it)
 * or the booking's own, and ignored otherwise, so this route cannot be used to
 * post a booking's details to an address of somebody's choosing.
 */
export function bookingRecipient({ thread = [], bookingEmail = '', requested = '' } = {}) {
  const booked = address(bookingEmail);
  const known = new Set(booked ? [booked] : []);
  for (const message of thread) {
    for (const party of [message?.fromEmail, message?.toEmail]) {
      const one = address(party);
      if (one) known.add(one);
    }
  }
  const asked = address(requested);
  if (asked && known.has(asked)) return asked;

  const lastInbound = [...thread].reverse().find((message) => message?.direction === 'inbound');
  return address(lastInbound?.fromEmail) || booked || '';
}

const address = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * The address to send to, out of whatever the row holds.
 *
 * Mail reaches this database through the bot's webhook, where the From header
 * arrives as 'Name <addr>', and a row written before that was taken apart
 * carries the whole header. SendGrid will not send to one, so the address is
 * taken out of it here rather than the reply failing. The one thing never read
 * off a From header is the name: that is not an address, and not where a reply
 * goes.
 */
export function replyAddress(value) {
  const text = String(value ?? '').trim();
  return (text.match(/<([^<>]+)>/)?.[1] ?? text).trim();
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
      ? `<p style="margin:0 0 14px;font-size:13px;color:${EMAIL_COLORS.muted};">Need to change or cancel? <a href="${escape(manageUrl)}" style="color:${EMAIL_COLORS.accent};font-weight:600;">Manage your booking</a></p>`
      : '');
  const quoted = original
    ? `<div style="margin-top:24px;padding-left:12px;border-left:3px solid ${EMAIL_COLORS.quoteRule};color:${EMAIL_COLORS.quoteText};font-size:13px;">` +
      `<div style="margin-bottom:6px;">On ${escape(wroteAt(original.createdAt))}, ${escape(original.fromEmail)} wrote:</div>` +
      `${escape(original.body).replace(/\n/g, '<br>')}</div>`
    : '';
  const html = brandedEmail(`${paragraphs}${quoted}`);

  return { text, html };
}
