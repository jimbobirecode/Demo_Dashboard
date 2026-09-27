/**
 * Sends the two guest payment emails — the link and the receipt — through a
 * club's own SendGrid template when one is configured, and the built-in email
 * otherwise. Resolves to SendGrid's `{ ok, status, message }` outcome.
 */
import { sendHtmlEmail, sendTemplateEmail } from './sendgrid.js';
import { logEmail } from './email-log.js';

/**
 * `record` ({ club, bookingId, kind, sentBy }) writes the sent email onto the
 * booking's conversation. A template's text lives in SendGrid, so it is
 * recorded as the built-in email would have read — close enough to show staff
 * what went out and when.
 */
export async function sendPaymentEmail(config, { toEmail, templateId, data, build, record = null }) {
  const sender = {
    apiKey: config.sendgridKey,
    fromEmail: config.fromEmail,
    fromName: config.fromName,
    toEmail,
  };
  const built = build(data);
  const outcome = templateId
    ? await sendTemplateEmail({ ...sender, templateId, data })
    : await sendHtmlEmail({ ...sender, ...built });

  if (outcome.ok && record) {
    await logEmail({
      club: record.club,
      direction: 'outbound',
      booking_id: record.bookingId,
      from_email: config.fromEmail,
      to_email: toEmail,
      subject: built.subject,
      body_text: built.text,
      sent_by: record.sentBy,
      kind: record.kind,
    });
  }
  return outcome;
}
