/**
 * The guest's side of their own booking, and the club's side of what they ask.
 *
 * The first three routes are **unauthenticated by necessity** — a guest has no
 * account. They are safe because a manage link only ever reaches one booking,
 * never signs anybody in, and every one of them verifies the signature before
 * reading anything. What comes back is deliberately thin: enough for somebody
 * to recognise their own booking, and nothing a stranger could mine.
 *
 * The rest are staff routes behind requireAuth, where requests are approved or
 * declined.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { serialiseBooking } from '../lib/bookings-domain.js';
import { BOOKING_SELECT } from '../lib/schema.js';
import { BRAND } from '../lib/brand.js';
import { sendHtmlEmail } from '../lib/sendgrid.js';
import { logEmail } from '../lib/email-log.js';
import {
  buildChangeEmail,
  describeOptions,
  linkSecret,
  manageLinkExpired,
  manageUrlFor,
  readChangePolicy,
  serialiseChangeRequest,
  validateChangeRequest,
  verifyBookingToken,
} from '../lib/change-request-domain.js';
import { createThrottle } from '../lib/password-reset-domain.js';
import { clientIp } from '../lib/request-guard.js';
import { logger } from '../lib/logger.js';

const log = logger.child('changes');

const router = Router();

/**
 * Tell the guest what happened to their request, and file the email on the
 * booking's conversation. Resolves true only when the email really went, so
 * nobody is told "a confirmation is on its way" when it is not.
 */
async function emailGuest(booking, outcome, { note = '', sentBy = 'bot', request = null } = {}) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.FROM_EMAIL;
  if (!apiKey || !fromEmail || !booking?.guestEmail) return false;
  try {
    const email = buildChangeEmail({ outcome, booking, request, note, manageUrl: manageUrlFor(booking) });
    const outcomeOf = await sendHtmlEmail({
      apiKey,
      fromEmail,
      fromName: process.env.FROM_NAME ?? BRAND.fromName,
      replyTo: process.env.REPLY_TO_EMAIL ?? fromEmail,
      toEmail: booking.guestEmail,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    if (!outcomeOf.ok) {
      log.error('guest email failed:', outcomeOf.message);
      return false;
    }
    await logEmail({
      club: booking.club,
      direction: 'outbound',
      booking_id: booking.bookingId,
      from_email: fromEmail,
      to_email: booking.guestEmail,
      subject: email.subject,
      body_text: email.text,
      sent_by: sentBy,
      kind: 'change_decision',
    });
    return true;
  } catch (err) {
    log.error('guest email failed:', err.message);
    return false;
  }
}

async function loadBooking(bookingId, club) {
  const { rows } = await query(`SELECT ${BOOKING_SELECT} FROM public.bookings WHERE booking_id = $1 AND club = $2`, [
    bookingId,
    club,
  ]);
  return rows[0] ? serialiseBooking(rows[0]) : null;
}

/** An unauthenticated surface; one client should not be able to hammer it. */
const lookupThrottle = createThrottle({ limit: 30, windowMs: 15 * 60_000 });
const submitThrottle = createThrottle({ limit: 10, windowMs: 60 * 60_000 });
// The same limits per booking reference, so guessing at one booking's token
// from many addresses runs out as quickly as from one.
const lookupRefThrottle = createThrottle({ limit: 30, windowMs: 15 * 60_000 });
const submitRefThrottle = createThrottle({ limit: 10, windowMs: 60 * 60_000 });

const refKey = (ref) =>
  String(ref ?? '')
    .trim()
    .toUpperCase();

/* ---------- the guest ---------- */

/**
 * The booking behind a manage link.
 *
 * Returns only what the holder of the link already knows, plus what they are
 * allowed to do about it. No note, no phone number, no payment state: this
 * answers to anyone holding the URL, including whoever the email was forwarded
 * to.
 */
router.get('/booking', async (req, res, next) => {
  try {
    const refAllowed = lookupRefThrottle.check(refKey(req.query.ref));
    if (!lookupThrottle.check(clientIp(req)) || !refAllowed) {
      return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
    }

    const found = await findByToken(req.query.ref, req.query.token);
    if (!found.ok) return res.status(found.status).json({ error: found.error });

    const { booking } = found;
    const policy = readChangePolicy();
    const options = describeOptions(booking, policy, today());

    res.json({
      booking: {
        bookingId: booking.bookingId,
        guestName: booking.guestName,
        date: booking.date,
        teeTime: booking.teeTime,
        players: booking.players,
        golfCourses: booking.golfCourses,
        status: booking.status,
        total: booking.total,
      },
      options,
      pending: found.pending.map((row) => ({
        kind: row.kind,
        status: row.status,
        createdAt: row.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Ask for a change, or cancel where policy allows it. */
router.post('/request', async (req, res, next) => {
  try {
    const refAllowed = submitRefThrottle.check(refKey(req.body?.ref));
    if (!submitThrottle.check(clientIp(req)) || !refAllowed) {
      return res.status(429).json({ error: 'Too many requests. Please ring the club.' });
    }
    const found = await findByToken(req.body?.ref, req.body?.token);
    if (!found.ok) return res.status(found.status).json({ error: found.error });

    const { booking } = found;
    const policy = readChangePolicy();
    const options = describeOptions(booking, policy, today());

    const check = validateChangeRequest(req.body, options);
    if (!check.ok) return res.status(400).json({ error: check.errors.join('. ') });

    // One open request at a time: a guest who clicks twice has not asked for
    // two things, and the club should not have to work out which to answer.
    if (found.pending.length) {
      return res.status(409).json({
        error: 'You already have a request with the club. They will be in touch.',
      });
    }

    // A guest only ever asks. The request waits for the club; the booking
    // itself is not touched until somebody approves it.
    const { rows } = await query(
      `INSERT INTO public.booking_change_requests
         (booking_id, club, kind, message, requested_date, requested_time, requested_players,
          status, auto_applied, days_before_play, guest_email, requested_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending',FALSE,$8,$9,$10)
       RETURNING *`,
      [
        booking.bookingId,
        booking.club,
        check.value.kind,
        check.value.message,
        check.value.requestedDate,
        check.value.requestedTime,
        check.value.requestedPlayers,
        options.daysUntilPlay,
        booking.guestEmail,
        clientIp(req),
      ],
    );

    const emailed = await emailGuest(booking, 'received', { request: { kind: check.value.kind } });

    res.status(201).json({
      ok: true,
      applied: false,
      emailed,
      message:
        check.value.kind === 'cancel'
          ? 'Thank you — your cancellation request is with the club. Your booking stays in place until they confirm it' +
            (emailed ? ', and we have emailed you a copy of your request.' : '.')
          : 'Thank you — the club has your request and will be in touch.',
      request: serialiseChangeRequest(rows[0]),
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- the club ---------- */

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.*, b.date AS play_date, b.tee_time, b.players AS booked_players, b.guest_name
         FROM public.booking_change_requests r
         LEFT JOIN public.bookings b ON b.booking_id = r.booking_id AND b.club = r.club
        WHERE r.club = $1
        ORDER BY (r.status = 'Pending') DESC, r.created_at DESC
        LIMIT 200`,
      [req.user.customerId],
    );

    res.json({
      policy: readChangePolicy(),
      requests: rows.map((row) => ({
        ...serialiseChangeRequest(row),
        playDate: row.play_date ? new Date(row.play_date).toISOString().slice(0, 10) : null,
        teeTime: row.tee_time ?? null,
        bookedPlayers: row.booked_players ?? null,
        guestName: row.guest_name ?? '',
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Approve or decline.
 *
 * Approving a cancellation cancels the booking. Approving an *amendment* does
 * not rewrite the tee sheet — what the guest asked for may not be available,
 * and picking a slot for them is the club's job. It marks the request answered
 * and leaves the booking to be edited on the bookings page, which is where the
 * availability actually is.
 */
router.post('/:id/:decision', requireAuth, async (req, res, next) => {
  try {
    const decision = req.params.decision;
    if (!['approve', 'decline'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approve or decline' });
    }

    const { rows: found } = await query('SELECT * FROM public.booking_change_requests WHERE id = $1 AND club = $2', [
      Number(req.params.id),
      req.user.customerId,
    ]);
    const request = found[0];
    if (!request) return res.status(404).json({ error: 'No such request' });
    if (request.status !== 'Pending') {
      return res.status(409).json({ error: `That request was already ${request.status.toLowerCase()}` });
    }

    const approving = decision === 'approve';
    const cancelling = approving && request.kind === 'cancel';

    if (cancelling) {
      await query(
        `UPDATE public.bookings SET status = 'Cancelled', updated_at = NOW(), updated_by = $3
         WHERE booking_id = $1 AND club = $2`,
        [request.booking_id, req.user.customerId, req.user.username],
      );
    }

    const { rows } = await query(
      `UPDATE public.booking_change_requests
          SET status = $1, resolved_at = NOW(), resolved_by = $2, resolution_note = $3
        WHERE id = $4 AND club = $5
        RETURNING *`,
      [
        cancelling ? 'Applied' : approving ? 'Approved' : 'Declined',
        req.user.username,
        String(req.body?.note ?? '').trim(),
        request.id,
        req.user.customerId,
      ],
    );

    const booking = await loadBooking(request.booking_id, req.user.customerId);
    const note = String(req.body?.note ?? '').trim();
    const guestEmailed = booking
      ? await emailGuest(booking, cancelling ? 'cancelled' : approving ? 'approved' : 'declined', {
          note,
          sentBy: req.user.username,
        })
      : false;

    res.json({
      request: serialiseChangeRequest(rows[0]),
      bookingCancelled: cancelling,
      guestEmailed,
      guestEmail: booking?.guestEmail ?? null,
      // An approved amendment is an instruction to a person, not a state change.
      needsEditing: approving && request.kind === 'amend',
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- helpers ---------- */

/**
 * The booking a signed link points at.
 *
 * Every failure answers the same way — an unreadable link is not told apart
 * from an unknown reference, or the URL becomes a way to test which booking
 * references exist.
 */
async function findByToken(ref, token) {
  const bookingId = String(ref ?? '').trim();
  const secret = linkSecret();
  const refused = { ok: false, status: 404, error: 'That link is not valid. Please ring the club.' };

  if (!bookingId || !secret) return refused;

  const { rows } = await query(`SELECT ${BOOKING_SELECT} FROM public.bookings WHERE booking_id = $1`, [bookingId]);

  // The token is scoped to the club, so it picks out the one row it was
  // signed for even if two clubs happen to share a reference.
  const booking = rows
    .map(serialiseBooking)
    .find((candidate) => verifyBookingToken(bookingId, token, secret, candidate.club ?? ''));
  if (!booking) return refused;
  if (manageLinkExpired(booking, today())) {
    return {
      ok: false,
      status: 410,
      error: 'This booking has finished, so it can no longer be managed online. Please contact the club.',
    };
  }

  const pending = (
    await query(
      `SELECT * FROM public.booking_change_requests
        WHERE booking_id = $1 AND club = $2 AND status = 'Pending'`,
      [bookingId, booking.club],
    )
  ).rows.map(serialiseChangeRequest);

  return { ok: true, booking, pending };
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BRAND.timeZone }).format(new Date());
}

export default router;
