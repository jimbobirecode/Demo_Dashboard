import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChangeEmail, manageUrlFor, verifyBookingToken } from '../src/lib/change-request-domain.js';
import {
  buildPaymentEmail,
  buildPaymentEmailData,
  buildReceiptEmail,
  buildReceiptEmailData,
} from '../src/lib/payment-link-domain.js';
import { buildReplyEmail } from '../src/lib/inbox-domain.js';

const booking = {
  bookingId: 'TMG-20261018-AB12',
  club: 'royal_dornoch',
  guestName: 'Tom Harris',
  guestEmail: 'tom@example.com',
  date: '2026-10-18',
  teeTime: '10:30 AM',
  players: 2,
  total: 860,
};
const ENV = { APP_URL: 'https://democlub.teemail.io/', BOOKING_LINK_SECRET: 'secret' };

test('a manage link is issued only when the install can sign one, and the manage page accepts it', () => {
  const url = manageUrlFor(booking, ENV);
  assert.match(url, /^https:\/\/democlub\.teemail\.io\/manage-booking\?ref=TMG-20261018-AB12&token=/);
  const token = new URL(url).searchParams.get('token');
  assert.ok(
    verifyBookingToken(booking.bookingId, token, 'secret', booking.club),
    'the page verifies what the email carries',
  );
  assert.match(
    manageUrlFor(booking, { BOOKING_LINK_SECRET: 'secret' }),
    /^https:\/\/democlub\.teemail\.io\/manage-booking\?/,
    'no APP_URL: the TeeMail dashboard',
  );
  assert.equal(manageUrlFor(booking, { APP_URL: 'https://x' }), null, 'no secret');
});

test('the guest is told plainly what happened to their request', () => {
  const received = buildChangeEmail({
    outcome: 'received',
    booking,
    request: { kind: 'cancel' },
    manageUrl: 'https://m',
  });
  assert.match(received.subject, /cancellation request/);
  assert.match(received.text, /Your booking is not cancelled yet/);
  assert.ok(!received.text.includes('https://m'));

  const cancelled = buildChangeEmail({ outcome: 'cancelled', booking, manageUrl: 'https://m' });
  assert.match(cancelled.subject, /cancelled/);
  assert.match(
    cancelled.text,
    /Your cancellation has been confirmed: we have cancelled booking TMG-20261018-AB12 for Sunday 18 October 2026 at 10:30 AM/,
  );
  assert.ok(!cancelled.text.includes('https://m'), 'no manage link on a cancelled booking');

  const declined = buildChangeEmail({
    outcome: 'declined',
    booking,
    note: 'No Sunday times that month.',
    manageUrl: 'https://m',
  });
  assert.match(declined.text, /not able to make the change/);
  assert.match(declined.text, /No Sunday times that month\./);
  assert.match(declined.text, /stays as it is/);
  assert.match(declined.html, /Manage your booking/);

  const approved = buildChangeEmail({ outcome: 'approved', booking });
  assert.match(approved.text, /we can make the change/);
  assert.match(approved.text, /confirm the new details to you shortly/);
});

test('payment emails, receipts and staff replies carry the manage link when there is one', () => {
  const saved = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    const payment = buildPaymentEmail(
      buildPaymentEmailData(booking, { amount: 860, currency: 'EUR', url: 'https://buy.stripe.com/x' }),
    );
    assert.match(payment.html, /Manage your booking/);
    assert.match(payment.text, /Need to change or cancel\? https:\/\/democlub/);
    const receipt = buildReceiptEmail(
      buildReceiptEmailData(booking, { received: 860, currency: 'EUR', reference: 'pi_1' }),
    );
    assert.match(receipt.html, /Manage your booking/);
  } finally {
    process.env = saved;
  }
  const reply = buildReplyEmail({
    body: 'Hi Tom,\n\nAll set.',
    manageUrl: 'https://democlub.teemail.io/manage-booking?ref=X&token=Y',
  });
  assert.match(reply.text, /Manage your booking: https:\/\/democlub/);
  assert.match(reply.html, /Manage your booking<\/a>/);
  assert.ok(!buildReplyEmail({ body: 'Hi' }).html.includes('Manage your booking'), 'no link without a booking');
});
