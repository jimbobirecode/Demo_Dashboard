/**
 * Writing to `email_messages` — the conversation log both services share. The
 * core API records what the bot sends and
 * receives; this records what is sent from the dashboard.
 *
 * Best effort by design: an email that has gone out has gone out, and failing
 * to write it down must never turn a successful send into an error. So every
 * function here resolves, logging rather than throwing.
 */
import { query } from '../db.js';
import { logger } from './logger.js';

const log = logger.child('email-log');

const COLUMNS = [
  'club',
  'direction',
  'booking_id',
  'from_email',
  'to_email',
  'subject',
  'body_text',
  'sent_by',
  'kind',
  'in_reply_to',
  'routed_to',
  'review_status',
];

/** Record one email. Resolves to the new row's id, or null. */
export async function logEmail(fields) {
  try {
    const names = COLUMNS.filter((name) => fields[name] !== undefined && fields[name] !== null);
    const { rows } = await query(
      `INSERT INTO public.email_messages (${names.join(', ')})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      names.map((name) => (name === 'body_text' ? String(fields[name]).slice(0, 100_000) : fields[name])),
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    log.warn('could not record email:', err.message);
    return null;
  }
}

/** Plain text from an email body we wrote as HTML, for reading back in the drawer. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
