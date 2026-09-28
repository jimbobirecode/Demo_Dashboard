/**
 * The frame every email the dashboard writes itself is sent in: the payment
 * link, the receipt, and staff replies from the Inbox and the booking drawer.
 *
 * It mirrors the core API's guest emails (get_email_header / get_email_footer
 * in Conolidated.py) — the logo on a white header with a teal rule beneath it,
 * and the club's footer — so a guest sees one brand whichever service sent
 * the email.
 *
 * The logo must be a public URL: mail clients do not load images from the
 * email itself reliably. It comes from EMAIL_LOGO_URL, or else the dashboard's
 * own /logo.png under APP_URL. With neither set, the header falls back to the
 * club's name in the brand colour rather than a broken image.
 */
import { BRAND } from './brand.js';

const env = process.env;

/** TeeMail's colours, taken from the logo; overridable for another club. */
export const EMAIL_COLORS = {
  primary: env.EMAIL_BRAND_COLOR ?? '#1a5e58', // TeeMail teal
  accent: env.EMAIL_ACCENT_COLOR ?? '#3a8030', // TeeMail green, deepened for text on white
  page: '#f3f8f4',
  rule: '#e3ebe6',
  text: '#1f2d27',
  muted: '#5b6b63',
};

export function logoUrl(source = env) {
  if (source.EMAIL_LOGO_URL) return source.EMAIL_LOGO_URL;
  const app = String(source.APP_URL ?? source.PUBLIC_URL ?? '').replace(/\/+$/, '');
  return app ? `${app}/logo.png` : null;
}

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Merge fields for SendGrid templates, so a template can use the same branding. */
export function brandTemplateData(source = env) {
  return {
    logo_url: logoUrl(source) ?? '',
    club_name: BRAND.fullName,
    brand_color: EMAIL_COLORS.primary,
    accent_color: EMAIL_COLORS.accent,
    club_email: source.REPLY_TO_EMAIL ?? source.FROM_EMAIL ?? '',
    club_phone: source.CLUB_PHONE ?? '',
    club_address: source.CLUB_ADDRESS ?? '',
    club_website: source.CLUB_WEBSITE ?? '',
  };
}

/**
 * A complete email. `content` is HTML the caller has already escaped.
 */
export function brandedEmail(content, { source = env } = {}) {
  const c = EMAIL_COLORS;
  const logo = logoUrl(source);
  const contactEmail = source.REPLY_TO_EMAIL ?? source.FROM_EMAIL ?? '';
  const contactLine = [source.CLUB_ADDRESS, source.CLUB_PHONE].filter(Boolean).map(escapeHtml).join(' · ');

  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(BRAND.fullName)}" width="240" style="display:block;max-width:240px;width:100%;height:auto;margin:0 auto;border:0;outline:none;text-decoration:none;">`
    : `<div style="font-size:22px;font-weight:700;color:${c.primary};">${escapeHtml(BRAND.fullName)}</div>`;

  return `<!DOCTYPE html>
<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(BRAND.fullName)}</title></head>
<body style="margin:0;padding:0;background:${c.page};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${c.text};">
<table width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${c.page}"><tr><td align="center" style="padding:20px 10px;">
<table width="600" border="0" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="max-width:600px;width:100%;">
<tr><td align="center" bgcolor="#ffffff" style="padding:14px 15px;border-bottom:4px solid ${c.primary};">${header}</td></tr>
<tr><td style="padding:32px 30px;font-size:15px;line-height:1.6;color:${c.text};">${content}</td></tr>
<tr><td bgcolor="${c.page}" style="padding:26px 30px;text-align:center;font-size:13px;color:${c.muted};">
<div style="font-size:15px;font-weight:700;color:${c.text};padding-bottom:8px;">${escapeHtml(BRAND.fullName)}</div>
${contactLine ? `<div style="padding-bottom:8px;">${contactLine}</div>` : ''}
${contactEmail ? `<div style="padding-bottom:12px;">Questions? Email us at <a href="mailto:${escapeHtml(contactEmail)}" style="color:${c.accent};font-weight:600;text-decoration:none;">${escapeHtml(contactEmail)}</a></div>` : ''}
<div style="font-size:12px;">Powered by TeeMail · Automated Visitor Booking</div>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
