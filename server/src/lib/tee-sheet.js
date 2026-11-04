/**
 * Putting a booking that paid online on the tee sheet.
 *
 * A direct customer pays on the booking form and the payment books the round
 * by itself: Requested becomes Booked with nobody at the club having touched
 * it. The tee sheet lives in the club's own system, which the dashboard
 * cannot write to, so the booking is flagged 'to_enter' the moment a payment
 * books it, and the desk clears the flag once it is on the sheet.
 *
 * Only a booking the payment *moved* to Booked is flagged. One the club had
 * already confirmed was put on the sheet when they confirmed it; a later
 * payment against it is money, not a new tee time.
 *
 * Nothing here can stop a payment being recorded. The flag is written after
 * the payment, separately, and a failure is logged and left -- money in the
 * bank and a booking marked paid matter more than the reminder about it.
 */
import { query } from '../db.js';
import { BRAND } from './brand.js';
import { logger } from './logger.js';
import { sendHtmlEmail } from './sendgrid.js';

const log = logger.child('tee-sheet');

/** Whether a payment that took a booking from `before` to `after` should flag it. */
export function paymentBooked(before, after) {
  return after === 'Booked' && before !== 'Booked';
}

/** Flag a booking for the tee sheet. Resolves true when it was flagged. */
export async function flagForTeeSheet(bookingId, club) {
  try {
    const { rowCount } = await query(
      `UPDATE public.bookings
          SET tee_sheet_status = 'to_enter', tee_sheet_entered_at = NULL, tee_sheet_entered_by = NULL
        WHERE booking_id = $1 AND club = $2 AND tee_sheet_status IS DISTINCT FROM 'entered'`,
      [bookingId, club],
    );
    return rowCount > 0;
  } catch (err) {
    log.error(`could not flag ${bookingId} for the tee sheet:`, err.message);
    return false;
  }
}

/**
 * Tell the team, where the club has said where to.
 *
 * Off unless TEAM_NOTIFY_EMAIL is set: the flag on the Bookings page is the
 * record, and an email to an inbox that may be wired back into the bot is
 * not something to send by default.
 */
export async function notifyTeam(booking, env = process.env) {
  const to = String(env.TEAM_NOTIFY_EMAIL ?? '').trim();
  if (!to || !env.SENDGRID_API_KEY || !env.FROM_EMAIL) return { ok: false, message: 'not configured' };

  const email = teeSheetEmail(booking, env);
  try {
    const outcome = await sendHtmlEmail({
      apiKey: env.SENDGRID_API_KEY,
      fromEmail: env.FROM_EMAIL,
      fromName: env.FROM_NAME ?? BRAND.fromName,
      toEmail: to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    if (!outcome.ok) log.warn(`team not told about ${booking.bookingId}: ${outcome.message}`);
    return outcome;
  } catch (err) {
    log.warn(`team not told about ${booking.bookingId}: ${err.message}`);
    return { ok: false, message: err.message };
  }
}

/** The email to the team: what to put on the sheet, and where to clear it. */
export function teeSheetEmail(booking, env = process.env) {
  const when = [formatDay(booking.date), booking.teeTime && booking.teeTime !== 'Not Specified' ? booking.teeTime : '']
    .filter(Boolean)
    .join(' at ');
  const who = booking.guestName || booking.guestEmail || 'a guest';
  const players = `${booking.players} player${booking.players === 1 ? '' : 's'}`;
  const paid = money(booking.amountPaid);
  const link = env.APP_URL
    ? `${String(env.APP_URL).replace(/\/$/, '')}/bookings?booking=${encodeURIComponent(booking.bookingId)}`
    : '';

  const subject = `Paid online — put on the tee sheet: ${when}, ${players} (${booking.bookingId})`;
  const lines = [
    `${who} has paid ${paid} online, and the booking is now Booked.`,
    '',
    `Booking   ${booking.bookingId}`,
    `When      ${when || 'no date'}`,
    `Players   ${players}`,
    `Email     ${booking.guestEmail || '—'}`,
    booking.contactPhone ? `Phone     ${booking.contactPhone}` : null,
    '',
    'Please put it on the tee sheet, then mark it done on the booking in the dashboard.',
    link || null,
  ].filter((line) => line !== null);

  const escape = (value) =>
    String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<p>${escape(lines[0])}</p><table>${[
    ['Booking', booking.bookingId],
    ['When', when || 'no date'],
    ['Players', players],
    ['Email', booking.guestEmail || '—'],
    ...(booking.contactPhone ? [['Phone', booking.contactPhone]] : []),
  ]
    .map(([k, v]) => `<tr><td style="padding-right:12px;color:#666">${escape(k)}</td><td><b>${escape(v)}</b></td></tr>`)
    .join('')}</table><p>Please put it on the tee sheet, then mark it done on the booking in the dashboard.</p>${
    link ? `<p><a href="${escape(link)}">Open the booking</a></p>` : ''
  }`;

  return { subject, text: lines.join('\n'), html };
}

function formatDay(date) {
  if (!date) return '';
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? String(date)
    : new Intl.DateTimeFormat(BRAND.locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(parsed);
}

function money(amount) {
  return new Intl.NumberFormat(BRAND.locale, { style: 'currency', currency: BRAND.currency }).format(
    Number(amount) || 0,
  );
}
