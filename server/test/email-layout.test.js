import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMAIL_COLORS,
  brandTemplateData,
  brandedEmail,
  logoBoxFit,
  logoUrl,
  tintOfWhite,
} from '../src/lib/email-layout.js';

const EMAIL_COLORS_VALUES = Object.values(EMAIL_COLORS);
import {
  buildPaymentEmail,
  buildPaymentEmailData,
  buildReceiptEmail,
  buildReceiptEmailData,
} from '../src/lib/payment-link-domain.js';
import { buildReplyEmail } from '../src/lib/inbox-domain.js';
import { sendHtmlEmail } from '../src/lib/sendgrid.js';

const LOGO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/email-logo.png');

/** The shipped logo's real pixel size, read from the PNG header. */
function currentLogoPixels() {
  const bytes = fs.readFileSync(LOGO_PATH);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

const ENV = {
  APP_URL: 'https://dash.teemail.io/',
  FROM_EMAIL: 'bookings@club.teemail.io',
  CLUB_PHONE: '+44 1234 567890',
};

test("the logo comes from EMAIL_LOGO_URL, else the dashboard's own /logo.png", () => {
  assert.equal(
    logoUrl({ EMAIL_LOGO_URL: 'https://cdn.example/logo.png', APP_URL: 'https://x' }),
    'https://cdn.example/logo.png',
  );
  assert.equal(logoUrl({ APP_URL: 'https://dash.teemail.io/' }), 'https://dash.teemail.io/logo.png');
  assert.equal(logoUrl({}), 'https://democlub.teemail.io/logo.png', "this club's dashboard when APP_URL is unset");
});

test('a branded email carries its logo inside it, whatever APP_URL says', () => {
  const html = brandedEmail('<p>Hello</p>', { source: ENV });
  assert.match(html, /<img src="cid:club-logo"/);
  assert.ok(!html.includes('dash.teemail.io/logo.png'), 'not a link the reader may not reach');
  assert.match(html, /border-bottom:4px solid #1a5e58/, "TeeMail's teal, with nothing configured");
  assert.match(html, /Questions\? Email us at <a href="mailto:bookings@club\.teemail\.io"/);
  assert.match(html, /\+44 1234 567890/);
  assert.match(html, /Powered by TeeMail/);
  assert.match(html, /<p>Hello<\/p>/);
  // With no settings at all, the logo is still there.
  assert.match(brandedEmail('<p>Hi</p>', { source: {} }), /<img src="cid:club-logo"/);
});

test('the logo is sized in the tag, so Outlook cannot stretch it', () => {
  const html = brandedEmail('<p>Hello</p>', { source: ENV });
  // Outlook draws an image at its file's own height unless the tag says
  // otherwise, so both numbers have to be there, whatever the mark's shape.
  const fit = logoBoxFit(...currentLogoPixels());
  assert.match(html, new RegExp(`<img src="cid:club-logo"[^>]* width="${fit.width}" height="${fit.height}"`));
  assert.ok(fit.width <= 240 && fit.height <= 96, 'drawn inside the header box');
});

test('a mark of any shape is fitted to the header box, never blown up', () => {
  // The club's own mark decides this, and it is not always a wordmark.
  // A wide wordmark still fills the width: TeeMail's 480x108 is 240x54,
  // exactly what the header drew before the box existed.
  assert.deepEqual(logoBoxFit(480, 108), { width: 240, height: 54 });
  // County Louth's crest is square. At a fixed 240 wide it would be 238 tall
  // and bury the message under its own header; fitted, it is crest-sized.
  assert.deepEqual(logoBoxFit(243, 241), { width: 97, height: 96 });
  // A small file is left at its own size rather than upscaled into mush.
  assert.deepEqual(logoBoxFit(80, 20), { width: 80, height: 20 });
  // Nothing usable in, nothing out: the caller falls back to full width.
  assert.equal(logoBoxFit(0, 0), null);
  assert.equal(logoBoxFit(undefined, undefined), null);
});

test('the crest that ships is the club\u2019s, and small enough to send', () => {
  // It is base64'd into every email the dashboard writes, so its weight is
  // paid on each one. It is also the thing a club notices first.
  const [width, height] = currentLogoPixels();
  assert.ok(width > 0 && height > 0, 'server/assets/email-logo.png is a readable PNG');
  const bytes = fs.statSync(LOGO_PATH).size;
  assert.ok(bytes < 60_000, `email-logo.png is ${bytes} bytes; it rides on every email`);
});

test("EMAIL_LOGO_URL still overrides, for a logo served from the club's own site", () => {
  assert.match(
    brandedEmail('<p>Hi</p>', { source: { EMAIL_LOGO_URL: 'https://club.example/logo.png' } }),
    /<img src="https:\/\/club\.example\/logo\.png"/,
  );
});

test('an email that shows the logo is sent with the logo attached inline', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { status: 202 };
  };
  await sendHtmlEmail({
    apiKey: 'SG',
    fromEmail: 'a@b.com',
    fromName: 'Club',
    toEmail: 'g@x.com',
    subject: 'S',
    text: 'T',
    html: brandedEmail('<p>x</p>', { source: {} }),
    fetchImpl,
  });
  const [logo] = sent.attachments;
  assert.equal(logo.content_id, 'club-logo');
  assert.equal(logo.disposition, 'inline');
  assert.equal(logo.type, 'image/png');
  assert.ok(Buffer.from(logo.content, 'base64').subarray(1, 4).toString() === 'PNG', 'a real PNG');
  assert.ok(Buffer.from(logo.content, 'base64').length < 20_000, 'small enough for every email');

  await sendHtmlEmail({
    apiKey: 'SG',
    fromEmail: 'a@b.com',
    fromName: 'Club',
    toEmail: 'g@x.com',
    subject: 'S',
    text: 'T',
    html: '<p>no logo</p>',
    fetchImpl,
  });
  assert.equal(sent.attachments, undefined, 'nothing attached to an email that does not show it');
});

test('every email the dashboard builds itself is in the branded frame', () => {
  const booking = { bookingId: 'TMG-1', guestName: 'Tom', total: 100, amountPaid: 100, date: '2027-05-12' };
  const emails = [
    buildPaymentEmail(buildPaymentEmailData(booking, { amount: 100, currency: 'GBP', url: 'https://buy.stripe.com/x' }))
      .html,
    buildReceiptEmail(buildReceiptEmailData(booking, { received: 100, currency: 'GBP', reference: 'pi_1' })).html,
    buildReplyEmail({
      body: 'Thanks',
      original: { createdAt: '2026-09-27T10:00:00Z', fromEmail: 'a@b.com', body: 'Hi' },
    }).html,
  ];
  for (const html of emails) {
    assert.match(html, /Powered by TeeMail/);
    assert.match(html, /border-bottom:4px solid #1a5e58/);
  }
});

test('SendGrid templates are given the same branding to use', () => {
  const data = brandTemplateData(ENV);
  assert.equal(data.logo_url, 'https://dash.teemail.io/logo.png');
  assert.equal(data.club_name, 'TeeMail Golf Club');
  assert.equal(data.brand_color, '#1a5e58');
  assert.equal(data.accent_color, '#3a8030', 'a template gets the readable green, not the on-screen one');
  assert.equal(data.club_email, 'bookings@club.teemail.io');
});

test('a staff reply carries the club’s colours all the way through, not just round the edge', () => {
  // The bug this guards: the frame read EMAIL_BRAND_COLOR / EMAIL_ACCENT_COLOR
  // while every body hardcoded TeeMail's teal. A club that set its own colours
  // got a rebranded header and footer with a teal link in the middle of the
  // message — the one part a guest actually reads.
  const reply = buildReplyEmail({
    body: 'We can hold four for Saturday.',
    manageUrl: 'https://dash.example/manage/abc',
    original: { createdAt: '2026-10-01T09:00:00Z', fromEmail: 'guest@example.com', body: 'Any room Saturday?' },
  });

  // Every colour in the rendered reply is one of the club's, not a stray.
  // With nothing configured these ARE TeeMail's, so the value alone proves
  // nothing — what matters is that each came from EMAIL_COLORS.
  const used = reply.html.match(/#[0-9a-f]{6}/gi) ?? [];
  const allowed = new Set([...EMAIL_COLORS_VALUES, '#ffffff'].map((c) => c.toLowerCase()));
  for (const colour of used) {
    assert.ok(allowed.has(colour.toLowerCase()), `${colour} in a reply is not one of the club's colours`);
  }

  // The link a guest clicks is the club's accent, the same one the footer uses.
  assert.ok(
    reply.html.includes(`<a href="https://dash.example/manage/abc" style="color:${EMAIL_COLORS.accent}`),
    'the manage-booking link is drawn in the club accent',
  );
  // And it is inside the branded frame, not a bare fragment.
  assert.match(reply.html, /<!DOCTYPE html>/);
  assert.match(reply.html, /cid:club-logo/);
});

test('the accent is readable: it is a link colour on white, not a screen colour', () => {
  // A brand colour picked for a dark screen usually fails on white: County
  // Louth's gold is #D4AF37 on its dark charts and 2.10:1 on the white of an
  // email — a smudge. Anything set here has to clear WCAG AA for body text,
  // or every link in every email is unreadable.
  const luminance = (hex) => {
    const parts = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  // The shipped default, then the worked example that justifies the rule.
  assert.ok(contrast(EMAIL_COLORS.accent, '#ffffff') >= 4.5, 'the accent must clear 4.5:1 on white');
  assert.ok(contrast('#3a8030', '#ffffff') >= 4.5, "TeeMail's deepened green clears it");
  assert.ok(contrast('#8A6D1F', '#ffffff') >= 4.5, "County Louth's deepened gold clears it too");
  assert.ok(contrast('#D4AF37', '#ffffff') < 4.5, 'the on-screen gold does not, which is why it is deepened');

  // primary carries white text on it (the portal button) and draws the rule.
  assert.ok(contrast(EMAIL_COLORS.primary, '#ffffff') >= 4.5, 'white text must be legible on the brand colour');
  assert.ok(contrast('#1a5e58', '#ffffff') >= 4.5, "TeeMail's teal carries white text");
  assert.ok(contrast('#002855', '#ffffff') >= 4.5, "and so does County Louth's navy");
});

test('no email body writes a colour of its own', () => {
  // The guard that actually holds the line. Every builder below renders into
  // the branded frame, so a hex typed into one of them is a colour that
  // ignores the club's settings — which is exactly how TeeMail's teal survived
  // a rebrand. Colours come from EMAIL_COLORS; email-layout.js is where they
  // are allowed to be literals.
  const builders = ['inbox-domain.js', 'change-request-domain.js', 'portal-domain.js', 'payment-link-domain.js'];
  for (const file of builders) {
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lib', file),
      'utf8',
    );
    const literals = source.match(/#[0-9a-f]{6}\b/gi) ?? [];
    // White is the one exception: it is the page, not a brand decision.
    const offenders = literals.filter((c) => c.toLowerCase() !== '#ffffff');
    assert.deepEqual(offenders, [], `${file} hardcodes ${offenders.join(', ')} instead of using EMAIL_COLORS`);
  }
});

test('the page and its rules are the club’s colour, not the last club’s', () => {
  // These were fixed values of TeeMail's pale green, so a club that set navy
  // got a navy header floating on somebody else's green page.
  assert.equal(tintOfWhite('#1a5e58', 0), '#ffffff', 'nothing of the brand is pure white');
  assert.equal(tintOfWhite('#1a5e58', 1), '#1a5e58', 'all of it is the brand colour');

  // TeeMail's own look is preserved: the derived tints land on its greens.
  assert.equal(tintOfWhite('#1a5e58', 0.05), '#f4f7f7'); // was #f3f8f4
  // County Louth's navy gives a cool off-white instead of a green one.
  assert.equal(tintOfWhite('#002855', 0.05), '#f2f4f7');

  // A tint is a background, so text has to stay readable on it.
  const luminance = (hex) => {
    const parts = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const brand of ['#1a5e58', '#002855', '#7a1020']) {
    const page = tintOfWhite(brand, 0.05);
    assert.ok(contrast(EMAIL_COLORS.text, page) >= 4.5, `body text is readable on a ${brand} page`);
    assert.ok(contrast(EMAIL_COLORS.muted, page) >= 4.5, `the footer grey is readable on a ${brand} page`);
  }

  // A value that is not a colour must not produce a broken style.
  assert.equal(tintOfWhite('not-a-hex', 0.05), '#ffffff');
});

test('an email is complete even when the service was given nothing', () => {
  // The real failure this came from: a booking confirmation reached a guest
  // signed "TeeMail Golf Club", in TeeMail's teal, because the Render service
  // had none of the CLUB_* or EMAIL_* values set. Nothing was broken — every
  // fallback simply named the vendor.
  //
  // On THIS install that is the correct answer: it is the demo, so the vendor
  // is the sender and brand.js defaults to TeeMail deliberately. What is
  // asserted here is therefore that the frame is COMPLETE with an empty
  // environment — a name, a title, a rule, a contact line, a logo — rather
  // than which club it names. A single-club install should also change those
  // defaults to its own club and assert the name here, the way
  // Dashboard_Beta does; see server/src/lib/brand.js.
  const html = brandedEmail('<p>Hello</p>', { source: {} });

  assert.match(html, /TeeMail Golf Club/, 'the footer names the sender');
  assert.match(html, /<title>TeeMail Golf Club<\/title>/);
  assert.match(html, /border-bottom:4px solid #1a5e58/, "TeeMail's teal");
  assert.match(html, /TeeMail Golf Club, London/, 'the contact line is there at all');
  assert.match(html, /\+44 20 7946 0000/);
  assert.match(html, /cid:club-logo/, 'the logo, embedded');

  // The part that must hold whichever club this is: no gap where a value was
  // meant to be. An unset variable has to drop a detail, never the line.
  assert.ok(!/undefined|null|\[object/.test(html), 'no unset value reaches the reader');
});
