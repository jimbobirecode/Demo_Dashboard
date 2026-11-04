/**
 * The schedule that keeps the Inbox triaged.
 *
 * The rows it works on are written by a database trigger (migration 0019),
 * which the server never hears about -- so this polls rather than reacting.
 * Email is not a feed: a message that waits a minute to gain a summary has
 * cost nobody anything, and the alternative (LISTEN/NOTIFY on a held
 * connection) is more moving parts than a golf club's mailbox earns.
 *
 * Built like payment-sync, which solves the same problem: off entirely
 * without its key, one run shortly after boot, then every few minutes, and a
 * last-run record so a quiet failure can be found without shell access.
 */
import { query } from '../db.js';
import { logger } from './logger.js';
import { triageConfig, triageEmail } from './inbox-triage.js';

const log = logger.child('triage');

/** How many attempts before an email is left for a person. Matches 0021's index. */
export const MAX_ATTEMPTS = 3;

let lastRun = null;
export function lastTriageRun() {
  return lastRun;
}

/**
 * Emails waiting to be read. Oldest first, so a backlog clears in the order
 * it arrived rather than newest-first.
 */
export async function pendingForTriage(limit = 5) {
  const { rows } = await query(
    `SELECT m.id, m.club, m.from_email, m.subject, m.body_text, m.created_at,
            m.booking_id, m.review_status,
            b.guest_name, b.guest_email, b.status AS booking_status, b.date AS booking_date,
            b.tee_time, b.players
       FROM public.email_messages m
       LEFT JOIN public.bookings b
         ON b.club = m.club AND b.booking_id = m.booking_id
      WHERE m.direction = 'inbound'
        AND m.triaged_at IS NULL
        AND m.triage_attempts < $1
        AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC
      LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );
  return rows;
}

/** The shape triageEmail wants, out of the row the sweep selected. */
export function emailFromRow(row) {
  return {
    fromEmail: row.from_email,
    subject: row.subject,
    bodyText: row.body_text,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

export function bookingFromRow(row) {
  if (!row.booking_id) return null;
  return {
    bookingId: row.booking_id,
    guestName: row.guest_name,
    // Told apart from the sender's address, so a draft answering a tour
    // operator does not open by greeting the guest they booked for.
    guestEmail: row.guest_email,
    status: row.booking_status,
    date: row.booking_date,
    teeTime: row.tee_time,
    players: row.players,
  };
}

/**
 * Store what the model made of one email.
 *
 * review_status is deliberately not touched. Whether an email still needs
 * answering is the club's business and the bot's; this pass only says what
 * the email is. review_reason IS replaced, because the line it replaces --
 * "the bot did not classify this one" -- describes the software rather than
 * the email, and it is the first thing the club reads.
 */
export async function recordTriage(id, result) {
  await query(
    `UPDATE public.email_messages
        SET intent = $2,
            summary = $3,
            draft_reply = NULLIF($4, ''),
            review_reason = CASE WHEN review_status = 'open' THEN $5 ELSE review_reason END,
            triaged_at = NOW(),
            triage_attempts = triage_attempts + 1,
            triage_error = NULL
      WHERE id = $1`,
    [id, result.intent, result.summary, result.draftReply, result.reason],
  );
}

/** Count an attempt that failed, so a poisonous message is not retried for ever. */
export async function recordTriageFailure(id, message) {
  await query(
    `UPDATE public.email_messages
        SET triage_attempts = triage_attempts + 1,
            triage_error = $2
      WHERE id = $1`,
    [id, String(message).slice(0, 500)],
  );
}

/** One pass. Returns what it did, and never throws. */
export async function triagePending({ limit = 5, reason = 'manual', client, env = process.env } = {}) {
  const result = { reason, startedAt: new Date().toISOString(), triaged: [], errors: [], finishedAt: null };
  try {
    const config = triageConfig(env);
    if (!client && !config.configured) {
      result.skipped = 'ANTHROPIC_API_KEY is not set';
      return result;
    }

    const rows = await pendingForTriage(limit);
    for (const row of rows) {
      try {
        const triaged = await triageEmail({
          email: emailFromRow(row),
          booking: bookingFromRow(row),
          client,
          env,
        });
        await recordTriage(row.id, triaged);
        result.triaged.push({ id: row.id, intent: triaged.intent, hasDraft: Boolean(triaged.draftReply) });
        log.info(`#${row.id}: ${triaged.intent}${triaged.draftReply ? ', drafted a reply' : ', no draft'}`);
      } catch (err) {
        // One bad email must not stop the rest of the batch.
        await recordTriageFailure(row.id, err.message).catch(() => {});
        result.errors.push({ id: row.id, error: err.message });
        log.warn(`#${row.id}: ${err.message}`);
      }
    }
    return result;
  } catch (err) {
    result.errors.push({ id: null, error: err.message });
    log.error('run failed:', err.message);
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    lastRun = result;
  }
}

/** Start the background schedule. Returns a function that stops it. */
export function startInboxTriage({ env = process.env } = {}) {
  const config = triageConfig(env);
  if (!config.configured) {
    log.info('ANTHROPIC_API_KEY is not set, so inbound email will not be summarised or drafted');
    return () => {};
  }
  const minutes = Math.max(Number.parseFloat(env.INBOX_TRIAGE_MINUTES ?? '2') || 2, 0.5);
  const first = setTimeout(() => triagePending({ reason: 'startup', env }), 20_000);
  const every = setInterval(() => triagePending({ reason: 'schedule', env }), minutes * 60_000);
  first.unref?.();
  every.unref?.();
  log.info(`reading new inbound email with ${config.model} every ${minutes} min`);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
