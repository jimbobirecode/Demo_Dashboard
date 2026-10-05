/**
 * The Inbox and booking conversations.
 *
 *   GET  /api/inbox?status=open|replied|dismissed|deleted|all   inbound emails for review
 *   GET  /api/inbox/booking/:bookingId                  a booking's whole conversation
 *   POST /api/inbox/booking/:bookingId/send             email the guest from the drawer
 *   GET  /api/inbox/:id                                 one email, its thread and its notes
 *   POST /api/inbox/:id/reply                           reply to any guest email (closes it if in the Inbox)
 *   POST /api/inbox/:id/status                          dismiss or reopen
 *   POST /api/inbox/:id/link                            attach it to a booking
 *   POST /api/inbox/:id/notes                           add a note, stamped with the user
 *   DELETE /api/inbox/:id                               delete it from the mailbox (recoverable)
 *   POST /api/inbox/:id/restore                         put a deleted one back
 *
 * Deleting is recoverable and the row is kept — other things point at it (see
 * migration 0010). A deleted email is in no list or count but the `deleted`
 * filter, and the only thing that can be done to it is restore.
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
import { logEmail } from '../lib/email-log.js';
import { LOGO_CID, inlineLogoAttachment } from '../lib/email-layout.js';
import { manageUrlFor } from '../lib/change-request-domain.js';
import {
  DELETED_FILTER,
  IN_FLIGHT_ROUTES,
  REVIEW_STATUSES,
  belongsInInboxSql,
  buildReplyEmail,
  noteProblem,
  notDeletedSql,
  notInFlightSql,
  replyProblem,
  replySubject,
  serialiseMessage,
  serialiseNote,
} from '../lib/inbox-domain.js';

const router = Router();
router.use(requireAuth);

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
  // a conversation often arrives before there is a reference to quote. An
  // email deleted from the mailbox is left out: it is gone from the
  // conversation too, until somebody restores it.
  const { rows } = await query(
    `SELECT * FROM public.email_messages
      WHERE club = $1 AND ${notDeletedSql()}
        AND (($2::text IS NOT NULL AND booking_id = $2)
          OR ($3::text IS NOT NULL AND booking_id IS NULL
              AND (lower(from_email) = lower($3) OR lower(to_email) = lower($3))))
      ORDER BY created_at ASC, id ASC
      LIMIT 200`,
    [club, bookingId ?? null, guestEmail ?? null],
  );
  return rows.map(serialiseMessage);
}

/** The team's notes on one email, oldest first. */
async function loadNotes(club, messageId) {
  const { rows } = await query(
    `SELECT * FROM public.email_notes WHERE club = $1 AND message_id = $2 ORDER BY created_at ASC, id ASC`,
    [club, messageId],
  );
  return rows.map(serialiseNote);
}

async function sendAndRecord(req, { to, subject, body, bookingId = null, original = null }) {
  const config = mailConfig();
  if (!config.apiKey || !config.fromEmail) {
    return { ok: false, status: 409, error: 'SendGrid is not configured (SENDGRID_API_KEY, FROM_EMAIL)' };
  }
  const problem = replyProblem({ to, body });
  if (problem) return { ok: false, status: 400, error: problem };

  // A reply about a booking tells the guest where to change or cancel it.
  const manageUrl = bookingId ? manageUrlFor({ bookingId, club: req.user.customerId }) : null;
  const email = buildReplyEmail({ body, original, manageUrl });
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
    const status = String(req.query.status ?? 'open');
    const club = req.user.customerId;

    // Membership correspondence is read on the Membership page, so it is not
    // in the Inbox under any status — including 'all' — nor in the counts.
    const inbound = `m.direction = 'inbound' AND ${belongsInInboxSql('m')}`;
    // A deleted email is only ever listed by the filter of its own; every
    // other filter, 'all' included, shows what is still in the mailbox.
    const live = `${inbound} AND ${notDeletedSql('m')}`;
    const where =
      status === DELETED_FILTER
        ? `${inbound} AND NOT ${notDeletedSql('m')}`
        : status === 'all'
          ? live
          : REVIEW_STATUSES.includes(status)
            ? `${live} AND m.review_status = '${status}' AND ${notInFlightSql('m')}`
            : `${live} AND m.review_status = 'open' AND ${notInFlightSql('m')}`;
    // The guest's name from their booking, so the list reads as people rather
    // than addresses.

    const [list, counts] = await Promise.all([
      query(
        `SELECT m.*, b.guest_name AS booking_guest_name
           FROM public.email_messages m
           LEFT JOIN public.bookings b ON b.booking_id = m.booking_id AND b.club = m.club
          WHERE m.club = $1 AND ${where}
          ORDER BY m.created_at DESC LIMIT 200`,
        [club],
      ),
      // One pass for every count the filter bar shows: a deleted email counts
      // as deleted and nothing else, whatever review status it kept.
      query(
        `SELECT CASE WHEN ${notDeletedSql()} THEN review_status ELSE '${DELETED_FILTER}' END AS review_status,
                COUNT(*)::int AS n
           FROM public.email_messages
          WHERE club = $1 AND direction = 'inbound' AND ${notInFlightSql()} AND ${belongsInInboxSql()}
          GROUP BY 1`,
        [club],
      ),
    ]);

    res.json({
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
    const club = req.user.customerId;
    const { rows } = await query('SELECT guest_email FROM public.bookings WHERE booking_id = $1 AND club = $2', [
      req.params.bookingId,
      club,
    ]);
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });
    const thread = await loadThread(club, { bookingId: req.params.bookingId, guestEmail: rows[0].guest_email });
    res.json({ thread });
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
  return { message, thread, booking, notes: await loadNotes(req.user.customerId, message.id) };
}

/**
 * A deleted email is out of the mailbox: the one thing that can be done to it
 * is restore. Returns true when it has already been answered with a 409.
 */
function refusedBecauseDeleted(res, message) {
  if (!message.deletedAt) return false;
  res.status(409).json({ error: 'This email was deleted. Restore it first.' });
  return true;
}

/**
 * The email exactly as it would go out, for the composer's Preview: the same
 * branded frame and, for a reply, the same quoted original. Nothing is sent.
 */
router.post('/preview', async (req, res, next) => {
  try {
    const body = String(req.body?.body ?? '');
    let original = null;
    const replyToId = Number.parseInt(req.body?.replyToId, 10);
    if (Number.isFinite(replyToId)) {
      const { rows } = await query('SELECT * FROM public.email_messages WHERE id = $1 AND club = $2', [
        replyToId,
        req.user.customerId,
      ]);
      if (rows[0] && rows[0].direction === 'inbound') original = serialiseMessage(rows[0]);
    }
    const email = buildReplyEmail({ body: body.trim() ? body : ' ', original });
    // The sent email carries its logo as an attachment (cid:club-logo), which a
    // browser cannot resolve, so the preview carries it inline instead.
    const logo = inlineLogoAttachment(email.html);
    const html = logo
      ? email.html.replaceAll(`cid:${LOGO_CID}`, `data:${logo.type};base64,${logo.content}`)
      : email.html;
    res.json({ html, text: email.text });
  } catch (err) {
    next(err);
  }
});

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
    if (message.direction !== 'inbound')
      return res.status(400).json({ error: 'Only a received email can be replied to' });
    if (refusedBecauseDeleted(res, message)) return;

    const subject = replySubject(req.body?.subject || message.subject, message.bookingId);
    const result = await sendAndRecord(req, {
      to: message.fromEmail,
      subject,
      body: req.body?.body,
      bookingId: message.bookingId,
      original: message,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    // Answering an Inbox email closes it. A reply from the booking drawer to
    // an email the bot already answered (an ordinary tee-time request) is
    // just part of the conversation, and does not turn up in the Inbox.
    await query(
      `UPDATE public.email_messages
          SET review_status = 'replied', handled_at = NOW(), handled_by = $1
        WHERE id = $2 AND club = $3 AND review_status IN ('open', 'dismissed')`,
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
    if (refusedBecauseDeleted(res, message)) return;
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
    if (refusedBecauseDeleted(res, message)) return;
    const bookingId = String(req.body?.bookingId ?? '')
      .trim()
      .toUpperCase();
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

/**
 * A note on an email: what the team wants the next person reading it to know.
 * Stamped with the user who wrote it, and never editable afterwards — a stamp
 * that can be rewritten says nothing.
 */
router.post('/:id/notes', async (req, res, next) => {
  try {
    const message = await loadMessage(req, res);
    if (!message) return;
    if (refusedBecauseDeleted(res, message)) return;
    const problem = noteProblem({ note: req.body?.note });
    if (problem) return res.status(400).json({ error: problem });

    await query(`INSERT INTO public.email_notes (club, message_id, note, created_by) VALUES ($1, $2, $3, $4)`, [
      req.user.customerId,
      message.id,
      String(req.body.note).trim(),
      req.user.username,
    ]);
    res.json({ ...(await withThread(req, message)), notice: 'Note added' });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete an email from the mailbox. Recoverable: the row is kept (other
 * things point at it — see migration 0010), marked with who deleted it and
 * when, and it leaves every list and count but the `deleted` filter.
 *
 * Refused while the core API still has the email in hand: it re-processes one
 * left `queued` by a worker that died, and would answer a guest whose email
 * the club had just deleted.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const message = await loadMessage(req, res);
    if (!message) return;
    if (IN_FLIGHT_ROUTES.includes(message.routedTo)) {
      return res.status(409).json({
        error: 'The bot is still working on this email. Try again in a moment.',
      });
    }
    // Already deleted: say so and change nothing, rather than moving the stamp.
    if (!message.deletedAt) {
      await query(
        `UPDATE public.email_messages SET deleted_at = NOW(), deleted_by = $1
          WHERE id = $2 AND club = $3 AND deleted_at IS NULL`,
        [req.user.username, message.id, req.user.customerId],
      );
    }
    const updated = await loadMessage(req, res);
    res.json({ ...(await withThread(req, updated)), notice: 'Deleted from the mailbox' });
  } catch (err) {
    next(err);
  }
});

/** Put a deleted email back in the mailbox, with the status it had. */
router.post('/:id/restore', async (req, res, next) => {
  try {
    const message = await loadMessage(req, res);
    if (!message) return;
    await query(`UPDATE public.email_messages SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND club = $2`, [
      message.id,
      req.user.customerId,
    ]);
    const updated = await loadMessage(req, res);
    res.json({ ...(await withThread(req, updated)), notice: 'Back in the mailbox' });
  } catch (err) {
    next(err);
  }
});

export default router;
