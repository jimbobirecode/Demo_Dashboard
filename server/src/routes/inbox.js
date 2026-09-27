/**
 * The Inbox and booking conversations.
 *
 *   GET  /api/inbox?status=open|replied|dismissed|all   inbound emails for review
 *   GET  /api/inbox/booking/:bookingId                  a booking's whole conversation
 *   POST /api/inbox/booking/:bookingId/send             email the guest from the drawer
 *   GET  /api/inbox/:id                                 one email and its thread
 *   POST /api/inbox/:id/reply                           send a reply, close it
 *   POST /api/inbox/:id/status                          dismiss or reopen
 *   POST /api/inbox/:id/link                            attach it to a booking
 *
 * Every query is scoped to the signed-in user's club. The core API writes the
 * inbound rows (with what Claude understood and a drafted reply); this only
 * reads them, and sends and records what staff write.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { BRAND } from '../lib/brand.js';
import { sendHtmlEmail } from '../lib/sendgrid.js';
import { hasEmailLog, logEmail } from '../lib/email-log.js';
import {
  REVIEW_STATUSES,
  buildReplyEmail,
  replyProblem,
  replySubject,
  serialiseMessage,
} from '../lib/inbox-domain.js';

const router = Router();
router.use(requireAuth);

const MIGRATION = 'migration_add_email_inbox.sql';

function unavailable(res) {
  return res.json({ available: false, migration: MIGRATION, messages: [], counts: {} });
}

function mailConfig() {
  return {
    apiKey: process.env.SENDGRID_API_KEY ?? null,
    fromEmail: process.env.FROM_EMAIL ?? null,
    fromName: process.env.FROM_NAME ?? BRAND.fromName,
    replyTo: process.env.REPLY_TO_EMAIL ?? process.env.FROM_EMAIL ?? null,
  };
}

async function loadThread(club, { bookingId, guestEmail }) {
  // A booking's thread is everything filed against it, plus anything from the
  // guest's address that was never attached to a booking — the first email in
  // a conversation often arrives before there is a reference to quote.
  const { rows } = await query(
    `SELECT * FROM public.email_messages
      WHERE club = $1
        AND (($2::text IS NOT NULL AND booking_id = $2)
          OR ($3::text IS NOT NULL AND booking_id IS NULL
              AND (lower(from_email) = lower($3) OR lower(to_email) = lower($3))))
      ORDER BY created_at ASC, id ASC
      LIMIT 200`,
    [club, bookingId ?? null, guestEmail ?? null],
  );
  return rows.map(serialiseMessage);
}

async function sendAndRecord(req, { to, subject, body, bookingId = null, original = null }) {
  const config = mailConfig();
  if (!config.apiKey || !config.fromEmail) {
    return { ok: false, status: 409, error: 'SendGrid is not configured (SENDGRID_API_KEY, FROM_EMAIL)' };
  }
  const problem = replyProblem({ to, body });
  if (problem) return { ok: false, status: 400, error: problem };

  const email = buildReplyEmail({ body, original });
  const outcome = await sendHtmlEmail({
    apiKey: config.apiKey,
    fromEmail: config.fromEmail,
    fromName: config.fromName,
    replyTo: config.replyTo,
    toEmail: to,
    subject,
    text: email.text,
    html: email.html,
  });
  if (!outcome.ok) return { ok: false, status: 502, error: `The email was not sent: ${outcome.message}` };

  const id = await logEmail({
    club: req.user.customerId,
    direction: 'outbound',
    booking_id: bookingId,
    from_email: config.fromEmail,
    to_email: to,
    subject,
    body_text: email.text,
    sent_by: req.user.username,
    kind: 'reply',
    in_reply_to: original?.id ?? null,
  });
  return { ok: true, id };
}

router.get('/', async (req, res, next) => {
  try {
    if (!(await hasEmailLog())) return unavailable(res);
    const status = String(req.query.status ?? 'open');
    const club = req.user.customerId;

    const where =
      status === 'all'
        ? `direction = 'inbound'`
        : REVIEW_STATUSES.includes(status)
          ? `direction = 'inbound' AND review_status = '${status}'`
          : `direction = 'inbound' AND review_status = 'open'`;

    const [list, counts] = await Promise.all([
      query(
        `SELECT * FROM public.email_messages WHERE club = $1 AND ${where}
          ORDER BY created_at DESC LIMIT 200`,
        [club],
      ),
      query(
        `SELECT review_status, COUNT(*)::int AS n FROM public.email_messages
          WHERE club = $1 AND direction = 'inbound' GROUP BY review_status`,
        [club],
      ),
    ]);

    res.json({
      available: true,
      status,
      counts: Object.fromEntries(counts.rows.map((row) => [row.review_status, row.n])),
      messages: list.rows.map(serialiseMessage),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/booking/:bookingId', async (req, res, next) => {
  try {
    if (!(await hasEmailLog())) return res.json({ available: false, migration: MIGRATION, thread: [] });
    const club = req.user.customerId;
    const { rows } = await query(
      'SELECT guest_email FROM public.bookings WHERE booking_id = $1 AND club = $2',
      [req.params.bookingId, club],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });
    const thread = await loadThread(club, { bookingId: req.params.bookingId, guestEmail: rows[0].guest_email });
    res.json({ available: true, thread });
  } catch (err) {
    next(err);
  }
});

router.post('/booking/:bookingId/send', async (req, res, next) => {
  try {
    const club = req.user.customerId;
    const { rows } = await query(
      'SELECT booking_id, guest_email FROM public.bookings WHERE booking_id = $1 AND club = $2',
      [req.params.bookingId, club],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });
    const booking = rows[0];

    const subject = String(req.body?.subject ?? '').trim()
      ? replySubject(req.body.subject, booking.booking_id).replace(/^Re: /i, '')
      : `Your booking ${booking.booking_id} – ${BRAND.fullName}`;
    const result = await sendAndRecord(req, {
      to: booking.guest_email,
      subject,
      body: req.body?.body,
      bookingId: booking.booking_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    const thread = await loadThread(club, { bookingId: booking.booking_id, guestEmail: booking.guest_email });
    res.json({ message: `Email sent to ${booking.guest_email}`, thread });
  } catch (err) {
    next(err);
  }
});

async function loadMessage(req, res) {
  if (!(await hasEmailLog())) {
    res.status(409).json({ error: `Run ${MIGRATION} first`, migration: MIGRATION });
    return null;
  }
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Bad message id' });
    return null;
  }
  const { rows } = await query('SELECT * FROM public.email_messages WHERE id = $1 AND club = $2', [
    id,
    req.user.customerId,
  ]);
  if (!rows[0]) {
    res.status(404).json({ error: 'Message not found' });
    return null;
  }
  return serialiseMessage(rows[0]);
}

async function withThread(req, message) {
  const guestEmail = message.direction === 'inbound' ? message.fromEmail : message.toEmail;
  const thread = await loadThread(req.user.customerId, { bookingId: message.bookingId, guestEmail });
  let booking = null;
  if (message.bookingId) {
    const { rows } = await query(
      `SELECT booking_id, status, date, tee_time, players, total, guest_name, guest_email
         FROM public.bookings WHERE booking_id = $1 AND club = $2`,
      [message.bookingId, req.user.customerId],
    );
    if (rows[0]) {
      booking = {
        bookingId: rows[0].booking_id,
        status: rows[0].status,
        date: rows[0].date ? new Date(rows[0].date).toISOString().slice(0, 10) : null,
        teeTime: rows[0].tee_time,
        players: rows[0].players,
        total: Number(rows[0].total) || 0,
        guestName: rows[0].guest_name,
      };
    }
  }
  return { message, thread, booking };
}

router.get('/:id', async (req, res, next) => {
  try {
    const message = await loadMessage(req, res);
    if (!message) return;
    res.json(await withThread(req, message));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reply', async (req, res, next) => {
  try {
    const message = await loadMessage(req, res);
    if (!message) return;
    if (message.direction !== 'inbound') return res.status(400).json({ error: 'Only a received email can be replied to' });

    const subject = replySubject(req.body?.subject || message.subject, message.bookingId);
    const result = await sendAndRecord(req, {
      to: message.fromEmail,
      subject,
      body: req.body?.body,
      bookingId: message.bookingId,
      original: message,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    await query(
      `UPDATE public.email_messages
          SET review_status = 'replied', handled_at = NOW(), handled_by = $1
        WHERE id = $2 AND club = $3`,
      [req.user.username, message.id, req.user.customerId],
    );
    const updated = await loadMessage(req, res);
    res.json({ ...(await withThread(req, updated)), notice: `Reply sent to ${message.fromEmail}` });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/status', async (req, res, next) => {
  try {
    const message = await loadMessage(req, res);
    if (!message) return;
    const status = req.body?.status;
    if (!['dismissed', 'open'].includes(status)) {
      return res.status(400).json({ error: 'Status must be dismissed or open' });
    }
    await query(
      `UPDATE public.email_messages
          SET review_status = $1,
              handled_at = CASE WHEN $1 = 'open' THEN NULL ELSE NOW() END,
              handled_by = CASE WHEN $1 = 'open' THEN NULL ELSE $2 END
        WHERE id = $3 AND club = $4`,
      [status, req.user.username, message.id, req.user.customerId],
    );
    const updated = await loadMessage(req, res);
    res.json(await withThread(req, updated));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/link', async (req, res, next) => {
  try {
    const message = await loadMessage(req, res);
    if (!message) return;
    const bookingId = String(req.body?.bookingId ?? '').trim().toUpperCase();
    const { rows } = await query('SELECT 1 FROM public.bookings WHERE booking_id = $1 AND club = $2', [
      bookingId,
      req.user.customerId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: `No booking ${bookingId}` });
    await query('UPDATE public.email_messages SET booking_id = $1 WHERE id = $2 AND club = $3', [
      bookingId,
      message.id,
      req.user.customerId,
    ]);
    const updated = await loadMessage(req, res);
    res.json(await withThread(req, updated));
  } catch (err) {
    next(err);
  }
});

export default router;
