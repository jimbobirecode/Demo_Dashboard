/**
 * The tour operator portal: the rules, none of the plumbing.
 *
 * A tour operator signs in with an emailed one-time link - no password - and
 * sees every booking on their account, what each owes and when, and can ask
 * for a change, a cancellation or new tee times, or pay a balance.
 *
 * Who may sign in is decided by the operator's own account: its contact
 * address, or any address on one of its email domains (the same domains the
 * dashboard already uses to recognise their bookings). Nothing an operator
 * does changes a booking by itself: requests go to the club's Guest Requests
 * and Inbox, and only staff approve them.
 */
import { BRAND } from './brand.js';
import { brandedEmail, escapeHtml } from './email-layout.js';
import { cleanAddress, describeMinutes } from './password-reset-domain.js';
import { emailDomain, isConsumerDomain } from './operators-domain.js';
import { csvLine } from './csv.js';

/** How long an emailed sign-in link works for. */
export const PORTAL_LINK_TTL_MINUTES = 30;

/** How long a portal session lasts once signed in. */
export const PORTAL_SESSION_HOURS = 12;

/** What the sign-in form is told, whether or not the address belongs to anyone. */
export const PORTAL_NEUTRAL_REPLY =
  'If that address belongs to one of our tour operator accounts, a sign-in link is on its way. It works once, for 30 minutes.';

/**
 * The operator account an address may sign in to, or null.
 *
 * Its contact address always may; so may any address on one of its email
 * domains - but never a personal-mail domain (gmail.com and the like), which
 * would let anybody with a free address in. A retired account, or one that
 * has no way to recognise its people, lets nobody in.
 */
export function operatorForEmail(email, operators) {
  const address = cleanAddress(email);
  if (!address) return null;
  const domain = emailDomain(address);

  for (const operator of operators ?? []) {
    if (operator.active === false) continue;
    const contact = cleanAddress(operator.contactEmail);
    if (contact && contact === address) return operator;
  }
  if (!domain || isConsumerDomain(domain)) return null;
  for (const operator of operators ?? []) {
    if (operator.active === false) continue;
    const domains = (operator.emailDomains ?? []).map((d) => String(d).toLowerCase());
    if (domains.includes(domain)) return operator;
  }
  return null;
}

export function portalSignInLink(appUrl, token) {
  return `${String(appUrl).replace(/\/+$/, '')}/portal/sign-in?token=${encodeURIComponent(token)}`;
}

/** The sign-in email. Built here rather than in SendGrid: nothing to configure. */
export function buildPortalSignInEmail({ operatorName, link, ttlMinutes = PORTAL_LINK_TTL_MINUTES }) {
  const subject = `Your sign-in link for the ${BRAND.fullName} tour operator portal`;
  const expires = describeMinutes(ttlMinutes);
  const text = [
    'Hello,',
    '',
    `Here is your link to sign in to the ${BRAND.fullName} portal for ${operatorName}:`,
    link,
    '',
    `It works once and expires in ${expires}. If you did not ask for it, you can ignore this email.`,
    '',
    BRAND.fullName,
  ].join('\n');
  const html = brandedEmail(
    `<p style="margin:0 0 14px;">Hello,</p>` +
      `<p style="margin:0 0 20px;">Here is your link to sign in to the ${escapeHtml(BRAND.fullName)} portal for <strong>${escapeHtml(operatorName)}</strong>, where you can see all your bookings, what is due, and send us requests.</p>` +
      `<div style="text-align:center;padding:4px 0 24px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1a5e58;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:6px;">Sign in to the portal</a></div>` +
      `<p style="margin:0 0 14px;font-size:13px;color:#5b6b63;">It works once and expires in ${escapeHtml(expires)}. If you did not ask for it, you can ignore this email.</p>`,
  );
  return { subject, text, html };
}

/**
 * One booking as an operator may see it: their own trade details and what
 * they owe - nothing about how the club runs its desk (notes, who changed
 * what, internal links).
 */
export function portalBooking(booking, { pendingRequest = null, payable = false } = {}) {
  const p = booking.payment ?? {};
  return {
    bookingId: booking.bookingId,
    date: booking.date,
    teeTime: booking.teeTime && booking.teeTime !== 'Not Specified' ? booking.teeTime : null,
    teeTimes: booking.selectedTeeTimes || null,
    players: booking.players,
    course: booking.golfCourses || null,
    guestName: booking.guestName || null,
    status: booking.status,
    total: Number(booking.total) || 0,
    paid: p.paid ?? 0,
    outstanding: p.outstanding ?? 0,
    dueDate: p.dueDate ?? null,
    dueAmount: p.dueAmount ?? 0,
    stage: p.stage ?? null,
    overdue: Boolean(p.overdue),
    daysOverdue: p.daysOverdue ?? 0,
    invoiceNumber: booking.invoiceNumber ?? null,
    paymentStatus: p.status ?? booking.paymentStatus ?? null,
    pendingRequest: pendingRequest
      ? { kind: pendingRequest.kind, createdAt: pendingRequest.createdAt }
      : null,
    // A balance can be paid online when it is owed on a booking the club has
    // confirmed - never on an enquiry it has not accepted yet.
    canPay: payable && (p.outstanding ?? 0) >= 0.5 && PAYABLE_STATUSES.includes(booking.status),
  };
}

/** Bookings the club has confirmed, and so may be paid for. */
const PAYABLE_STATUSES = ['Booked', 'Confirmed'];

/** Which bookings a portal list shows by default: anything not yet played or still owing. */
export function isCurrent(booking, today) {
  return (booking.date && booking.date >= today) || (booking.outstanding ?? 0) > 0;
}

/** The operator's statement: one row per booking, for their accounts team. */
export function statementCsv(bookings, { currency = BRAND.currency } = {}) {
  const header = [
    'Booking reference', 'Invoice', 'Play date', 'Tee time', 'Players', 'Course', 'Status',
    `Total (${currency})`, `Paid (${currency})`, `Outstanding (${currency})`, 'Due date', 'Overdue days',
  ];
  const rows = bookings.map((b) => [
    b.bookingId, b.invoiceNumber, b.date, b.teeTime, b.players, b.course, b.status,
    b.total.toFixed(2), Number(b.paid).toFixed(2), Number(b.outstanding).toFixed(2), b.dueDate, b.daysOverdue || '',
  ]);
  return [header, ...rows].map(csvLine).join('\r\n') + '\r\n';
}

/**
 * A new tee-time request from the portal, as the email it becomes in the
 * club's Inbox. Returns { error } or { subject, body, summary }.
 */
export function buildEnquiry(input, operator, email) {
  const date = String(input?.date ?? '').trim();
  const players = Number.parseInt(input?.players, 10);
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('Choose a date');
  if (!Number.isInteger(players) || players < 1 || players > 200) errors.push('Enter how many players (1 to 200)');
  const notes = String(input?.notes ?? '').trim().slice(0, 4000);
  const course = String(input?.course ?? '').trim().slice(0, 200);
  const timing = String(input?.timing ?? '').trim().slice(0, 200);
  const groupName = String(input?.groupName ?? '').trim().slice(0, 200);
  if (errors.length) return { error: errors.join('. ') };

  const lines = [
    `New tee time request from ${operator.name} (tour operator portal).`,
    '',
    `Requested by: ${email}`,
    groupName && `Group / lead guest: ${groupName}`,
    `Date: ${date}`,
    `Players: ${players}`,
    course && `Course: ${course}`,
    timing && `Preferred time: ${timing}`,
    notes && `\nNotes:\n${notes}`,
  ].filter(Boolean);
  return {
    subject: `Tee time request: ${players} players on ${date} - ${operator.name}`,
    body: lines.join('\n'),
    summary: `${operator.name} asks for tee times for ${players} on ${date}${course ? ` (${course})` : ''}`,
  };
}
