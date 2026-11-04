/**
 * The frame every email the dashboard writes itself is sent in: the payment
 * link, the receipt, and staff replies from the Inbox and the booking drawer.
 *
 * It mirrors the core API's guest emails (get_email_header / get_email_footer
 * in Conolidated.py) — the logo on a white header with a teal rule beneath it,
 * and the club's footer — so a guest sees one brand whichever service sent
 * the email.
 *
 * The logo travels inside the email as an inline attachment (cid:club-logo),
 * read from server/assets/email-logo.png — for this deployment, the TeeMail
 * logo. A linked image only shows if the reader's mail client will fetch it,
 * and most block remote images by default, which is how a club's email ends up
 * arriving with no logo on it at all. An embedded one always shows, whatever
 * APP_URL or the host is doing. sendgrid.js attaches it to any email that
 * references it. EMAIL_LOGO_URL still overrides, for a club that would rather
 * serve its logo from its own site and accept that.
 *
 * Replacing that file is how a club is rebranded; it does not have to be a
 * wordmark, because the header fits whatever shape it is (see logoBoxFit).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, appBaseUrl } from './brand.js';
import { logger } from './logger.js';

const log = logger.child('email');

export const LOGO_CID = 'club-logo';

const LOGO_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/email-logo.png');
/** The box the header logo is drawn inside, whatever shape the mark is. */
export const LOGO_BOX = { width: 240, height: 96 };

/**
 * The size a mark of `width` x `height` is drawn at: scaled down to fit inside
 * LOGO_BOX, never scaled up.
 *
 * Both dimensions are capped, not just the width, because a club's mark is not
 * always a wordmark. A round crest at a fixed 240px wide comes out 238px tall
 * and swamps the message under a third of a screen of header — County Louth's
 * did exactly that, which is what this function was written for. Fitting it to
 * the box instead draws it at 97x96, the size a crest is meant to be read at,
 * while a wide wordmark still comes out full width: the TeeMail logo this
 * deployment ships is 480x108, so it is still drawn at exactly 240x54.
 *
 * Outlook ignores `height: auto` and draws an image at its file's own height
 * unless the tag says otherwise, so both numbers go in the <img>.
 */
export function logoBoxFit(width, height, box = LOGO_BOX) {
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(box.width / width, box.height / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

let logoBase64 = null;
let logoSize = null;
try {
  const bytes = fs.readFileSync(LOGO_FILE);
  logoBase64 = bytes.toString('base64');
  // The PNG header carries width and height at bytes 16-24.
  logoSize = logoBoxFit(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
} catch (err) {
  log.warn(`${LOGO_FILE} not readable (${err.message}); emails will link to the logo instead`);
}

/** The inline attachment for an email whose HTML uses cid:club-logo, or null. */
export function inlineLogoAttachment(html) {
  if (!logoBase64 || !String(html ?? '').includes(`cid:${LOGO_CID}`)) return null;
  return { content: logoBase64, filename: 'logo.png', type: 'image/png', disposition: 'inline', content_id: LOGO_CID };
}

const env = process.env;

/**
 * The colours every email the dashboard writes is drawn in: this frame, and
 * the bodies the domain modules build to go inside it.
 *
 * One source for both. They used to disagree: the frame read these two
 * settings while every body hardcoded TeeMail's teal, so a club that set its
 * own colours got its header and footer rebranded and a teal link in the
 * middle of the message. Nothing below may be written as a literal in a body
 * builder — import these instead.
 *
 * `accent` is a LINK AND TEXT colour on white, so it has to clear 4.5:1
 * against it. A brand colour picked for a dark screen usually does not: the
 * club gold this dashboard uses on its own charts is 2.10:1 on white, which is
 * all but invisible in an email. Deepen the brand colour until it passes and
 * set that as EMAIL_ACCENT_COLOR, rather than reusing the on-screen value.
 * TeeMail's own green is deepened from the on-screen value for exactly this
 * reason, and County Louth's gold goes from #D4AF37 to #8A6D1F on its install.
 */

/** A hex colour laid over white at `amount` (0..1). */
export function tintOfWhite(hex, amount) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (channels.some(Number.isNaN)) return '#ffffff';
  return `#${channels
    .map((v) =>
      Math.round(255 + (v - 255) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const primary = env.EMAIL_BRAND_COLOR ?? '#1a5e58'; // TeeMail teal

export const EMAIL_COLORS = {
  primary,
  // TeeMail green, deepened to clear 4.5:1 as text on white.
  accent: env.EMAIL_ACCENT_COLOR ?? '#3a8030',
  // The page behind the message and the rules on it are the brand colour laid
  // over white, rather than fixed values. They used to be fixed at TeeMail's
  // pale green, so a club that set navy got a navy header floating on somebody
  // else's green. Derived, they follow whatever the club sets — and for
  // TeeMail itself they come out at that same pale green to within a point.
  page: tintOfWhite(primary, 0.05),
  rule: tintOfWhite(primary, 0.12),
  /** The rule down a quoted reply: the same tint, a shade stronger. */
  quoteRule: tintOfWhite(primary, 0.18),
  // Body text and its quieter grey are near-black and mid-grey: at that
  // darkness a hue cast is invisible, and neutrals stay legible whatever the
  // club's colour is. These are not brand decisions, so they do not move.
  text: '#1f2327',
  muted: '#5b6169',
  quoteText: '#6b7179',
};

/** A public address for the logo — used by SendGrid templates, which cannot use the embedded copy. */
export function logoUrl(source = env) {
  if (source.EMAIL_LOGO_URL) return source.EMAIL_LOGO_URL;
  return `${appBaseUrl(source)}/logo.png`;
}

/** What an email's <img> points at: an override URL, else the embedded copy, else a public URL. */
function headerLogoSrc(source) {
  if (source.EMAIL_LOGO_URL) return source.EMAIL_LOGO_URL;
  if (logoBase64) return `cid:${LOGO_CID}`;
  return logoUrl(source);
}

export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

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
export function brandedEmail(content, { source = env, contactEmail: contactOverride } = {}) {
  const c = EMAIL_COLORS;
  const logo = headerLogoSrc(source);
  // A caller with its own address (membership mail) passes contactEmail.
  const contactEmail = contactOverride ?? source.REPLY_TO_EMAIL ?? source.FROM_EMAIL ?? '';
  // Unset means the club's own details, not a missing line: a footer with no
  // address under the name is how an email stops looking like it came from a
  // golf club. An explicit empty string still drops that detail.
  const address = source.CLUB_ADDRESS ?? BRAND.address;
  const phone = source.CLUB_PHONE ?? BRAND.phone;
  const contactLine = [address, phone].filter(Boolean).map(escapeHtml).join(' · ');

  // Only the embedded copy's shape is known. An override URL is some other
  // club's file of some other shape, so it keeps the old full-width treatment.
  const fit = (logo === `cid:${LOGO_CID}` && logoSize) || { width: LOGO_BOX.width, height: null };
  const height = fit.height ? ` height="${fit.height}"` : '';
  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(BRAND.fullName)}" width="${fit.width}"${height} style="display:block;width:${fit.width}px;max-width:${fit.width}px;height:auto;margin:0 auto;border:0;outline:none;text-decoration:none;">`
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
