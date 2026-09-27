/**
 * Sends the two guest payment emails — the link and the receipt — through a
 * club's own SendGrid template when one is configured, and the built-in email
 * otherwise. Resolves to SendGrid's `{ ok, status, message }` outcome.
 */
import { sendHtmlEmail, sendTemplateEmail } from './sendgrid.js';

export function sendPaymentEmail(config, { toEmail, templateId, data, build }) {
  const sender = {
    apiKey: config.sendgridKey,
    fromEmail: config.fromEmail,
    fromName: config.fromName,
    toEmail,
  };
  return templateId
    ? sendTemplateEmail({ ...sender, templateId, data })
    : sendHtmlEmail({ ...sender, ...build(data) });
}
