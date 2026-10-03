import test from 'node:test';
import assert from 'node:assert/strict';
import { brandTemplateData, brandedEmail, logoUrl } from '../src/lib/email-layout.js';
import {
  buildPaymentEmail,
  buildPaymentEmailData,
  buildReceiptEmail,
  buildReceiptEmailData,
} from '../src/lib/payment-link-domain.js';
import { buildReplyEmail } from '../src/lib/inbox-domain.js';
import { sendHtmlEmail } from '../src/lib/sendgrid.js';

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
  assert.equal(logoUrl({}), 'https://democlub.teemail.io/logo.png', 'the TeeMail dashboard when APP_URL is unset');
});

test('a branded email carries its logo inside it, whatever APP_URL says', () => {
  const html = brandedEmail('<p>Hello</p>', { source: ENV });
  assert.match(html, /<img src="cid:club-logo"/);
  assert.ok(!html.includes('dash.teemail.io/logo.png'), 'not a link the reader may not reach');
  assert.match(html, /border-bottom:4px solid #1a5e58/);
  assert.match(html, /Questions\? Email us at <a href="mailto:bookings@club\.teemail\.io"/);
  assert.match(html, /\+44 1234 567890/);
  assert.match(html, /Powered by TeeMail/);
  assert.match(html, /<p>Hello<\/p>/);
  // With no settings at all, the logo is still there.
  assert.match(brandedEmail('<p>Hi</p>', { source: {} }), /<img src="cid:club-logo"/);
});

test('the logo is sized in the tag, so Outlook cannot stretch it', () => {
  const html = brandedEmail('<p>Hello</p>', { source: ENV });
  // email-logo.png is 480x108: 240 wide is 54 high.
  assert.match(html, /<img src="cid:club-logo"[^>]* width="240" height="54"/);
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
  assert.equal(data.club_email, 'bookings@club.teemail.io');
});
