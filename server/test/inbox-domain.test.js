import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyEmail, replyProblem, replySubject, serialiseMessage } from '../src/lib/inbox-domain.js';
import { htmlToText } from '../src/lib/email-log.js';

test('a reply subject says Re: once and carries the booking reference', () => {
  assert.equal(replySubject('Buggies?', null), 'Re: Buggies?');
  assert.equal(replySubject('RE: Buggies?', null), 'RE: Buggies?');
  assert.equal(replySubject('Buggies?', 'RDG-20270512-AB12'), 'Re: Buggies? [RDG-20270512-AB12]');
  assert.equal(
    replySubject('Re: Booking RDG-20270512-AB12', 'RDG-20270512-AB12'),
    'Re: Booking RDG-20270512-AB12',
    'no second copy of a reference already there',
  );
  assert.match(replySubject('', null), /^Re: Your message to /);
});

test('a reply needs an address and some words', () => {
  assert.equal(replyProblem({ to: 'a@b.com', body: 'Hello' }), null);
  assert.match(replyProblem({ to: '', body: 'Hello' }), /address/);
  assert.match(replyProblem({ to: 'not-an-email', body: 'Hello' }), /address/);
  assert.match(replyProblem({ to: 'a@b.com', body: '   ' }), /empty/);
});

test('a reply quotes the email it answers, and escapes both', () => {
  const email = buildReplyEmail({
    body: 'Yes, buggies are available.\n\nKind regards,\nBookings',
    original: { createdAt: '2026-09-27T10:00:00Z', fromEmail: 'tom@example.com', body: 'Do you have <buggies>?' },
  });
  assert.match(email.text, /^Yes, buggies are available\./);
  assert.match(email.text, /> Do you have <buggies>\?/);
  assert.match(email.html, /Kind regards,<br>Bookings/);
  assert.match(email.html, /Do you have &lt;buggies&gt;\?/);
  assert.ok(!email.html.includes('<buggies>'));
});

test('a stored row reads back with labels, and a JSON extraction is parsed', () => {
  const message = serialiseMessage({
    id: 7,
    direction: 'inbound',
    booking_id: null,
    from_email: 'tom@example.com',
    subject: 'Buggies?',
    body_text: 'Do you have buggies?',
    intent: 'question',
    routed_to: 'inbox',
    review_status: 'open',
    review_reason: 'A question for the team',
    draft_reply: 'Yes…',
    extraction: '{"intent":"question","source":"claude"}',
    created_at: '2026-09-27T10:00:00Z',
  });
  assert.equal(message.intentLabel, 'Question');
  assert.equal(message.routeLabel, 'Held for the team');
  assert.equal(message.extraction.source, 'claude');
  assert.equal(message.reviewStatus, 'open');
});

test('an HTML email reads back as text', () => {
  assert.equal(htmlToText('<p>Hi&nbsp;Tom</p><p>See <b>you</b> soon</p><style>x{}</style>'), 'Hi Tom\nSee you soon');
});

test('emails the core API is still working on are labelled and kept out of the Inbox', async () => {
  const { IN_FLIGHT_ROUTES, ROUTE_LABELS, notInFlightSql, serialiseMessage } =
    await import('../src/lib/inbox-domain.js');
  assert.deepEqual(IN_FLIGHT_ROUTES, ['queued', 'processing']);
  assert.equal(ROUTE_LABELS.queued, 'Queued');
  assert.equal(ROUTE_LABELS.processing, 'Being processed');
  assert.equal(
    serialiseMessage({ id: 1, routed_to: 'processing', direction: 'inbound' }).routeLabel,
    'Being processed',
  );
  assert.equal(notInFlightSql('m'), "COALESCE(m.routed_to, '') NOT IN ('queued', 'processing')");
});

test('membership enquiries read as such in the Inbox', async () => {
  const { serialiseMessage } = await import('../src/lib/inbox-domain.js');
  const message = serialiseMessage({
    id: 2,
    direction: 'inbound',
    intent: 'membership_enquiry',
    routed_to: 'membership',
  });
  assert.equal(message.intentLabel, 'Membership enquiry');
  assert.equal(message.routeLabel, 'Sent to Membership');
});
