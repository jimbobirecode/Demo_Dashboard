import test from 'node:test';
import assert from 'node:assert/strict';
import { brandTemplateData, brandedEmail, logoUrl } from '../src/lib/email-layout.js';
import { buildPaymentEmail, buildPaymentEmailData, buildReceiptEmail, buildReceiptEmailData } from '../src/lib/payment-link-domain.js';
import { buildReplyEmail } from '../src/lib/inbox-domain.js';

const ENV = { APP_URL: 'https://dash.teemail.io/', FROM_EMAIL: 'bookings@club.teemail.io', CLUB_PHONE: '+44 1234 567890' };

test('the logo comes from EMAIL_LOGO_URL, else the dashboard\'s own /logo.png', () => {
  assert.equal(logoUrl({ EMAIL_LOGO_URL: 'https://cdn.example/logo.png', APP_URL: 'https://x' }), 'https://cdn.example/logo.png');
  assert.equal(logoUrl({ APP_URL: 'https://dash.teemail.io/' }), 'https://dash.teemail.io/logo.png');
  assert.equal(logoUrl({}), null);
});

test('a branded email has the logo header, the teal rule and the club footer', () => {
  const html = brandedEmail('<p>Hello</p>', { source: ENV });
  assert.match(html, /<img src="https:\/\/dash\.teemail\.io\/logo\.png"/);
  assert.match(html, /border-bottom:4px solid #1a5e58/);
  assert.match(html, /Questions\? Email us at <a href="mailto:bookings@club\.teemail\.io"/);
  assert.match(html, /\+44 1234 567890/);
  assert.match(html, /Powered by TeeMail/);
  assert.match(html, /<p>Hello<\/p>/);
});

test('without a logo URL the header is the club name, never a broken image', () => {
  const html = brandedEmail('<p>Hi</p>', { source: {} });
  assert.ok(!html.includes('<img'));
  assert.match(html, /font-weight:700;color:#1a5e58;">TeeMail Golf Club</);
});

test('every email the dashboard builds itself is in the branded frame', () => {
  const booking = { bookingId: 'TMG-1', guestName: 'Tom', total: 100, amountPaid: 100, date: '2027-05-12' };
  const emails = [
    buildPaymentEmail(buildPaymentEmailData(booking, { amount: 100, currency: 'GBP', url: 'https://buy.stripe.com/x' })).html,
    buildReceiptEmail(buildReceiptEmailData(booking, { received: 100, currency: 'GBP', reference: 'pi_1' })).html,
    buildReplyEmail({ body: 'Thanks', original: { createdAt: '2026-09-27T10:00:00Z', fromEmail: 'a@b.com', body: 'Hi' } }).html,
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
