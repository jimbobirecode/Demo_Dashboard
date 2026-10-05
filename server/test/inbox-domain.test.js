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

test('a deleted email is out of the mailbox, and says who took it out', async () => {
  const { notDeletedSql, serialiseMessage } = await import('../src/lib/inbox-domain.js');

  assert.equal(notDeletedSql('m'), 'm.deleted_at IS NULL');
  assert.equal(notDeletedSql(), 'deleted_at IS NULL');

  const live = serialiseMessage({ id: 1, direction: 'inbound' });
  assert.equal(live.deletedAt, null);
  assert.equal(live.deletedBy, null);

  const gone = serialiseMessage({
    id: 2,
    direction: 'inbound',
    deleted_at: '2026-10-05T09:30:00Z',
    deleted_by: 'alice@club-a.test',
  });
  assert.equal(gone.deletedAt, '2026-10-05T09:30:00.000Z');
  assert.equal(gone.deletedBy, 'alice@club-a.test');
});

test('a note is for the team, stamped with who wrote it', async () => {
  const { NOTE_MAX, noteProblem, serialiseNote } = await import('../src/lib/inbox-domain.js');

  assert.equal(noteProblem({ note: 'Called her back, happy with the Tuesday' }), null);
  assert.equal(noteProblem({ note: '   ' }), 'The note is empty');
  assert.equal(noteProblem({ note: undefined }), 'The note is empty');
  assert.match(noteProblem({ note: 'x'.repeat(NOTE_MAX + 1) }), /at most 2000/);
  assert.equal(noteProblem({ note: 'x'.repeat(NOTE_MAX) }), null);

  assert.deepEqual(
    serialiseNote({
      id: 5,
      message_id: 9,
      note: 'Called her back',
      created_by: 'alice@club-a.test',
      created_at: '2026-10-05T09:30:00Z',
    }),
    {
      id: 5,
      messageId: 9,
      note: 'Called her back',
      createdBy: 'alice@club-a.test',
      createdAt: '2026-10-05T09:30:00.000Z',
    },
  );
});

test('membership email is labelled as such, and belongs to the Membership page not the Inbox', async () => {
  const { ROUTES_READ_ELSEWHERE, belongsInInboxSql, serialiseMessage } = await import('../src/lib/inbox-domain.js');
  const message = serialiseMessage({
    id: 2,
    direction: 'inbound',
    intent: 'membership_enquiry',
    routed_to: 'membership',
  });
  assert.equal(message.intentLabel, 'Membership enquiry');
  assert.equal(message.routeLabel, 'Sent to Membership');

  // Correspondence about an application is read beside the application. Only
  // a membership fault that produced no application is routed to 'inbox',
  // and that one is not excluded here.
  assert.deepEqual(ROUTES_READ_ELSEWHERE, ['membership']);
  assert.equal(belongsInInboxSql('m'), "COALESCE(m.routed_to, '') NOT IN ('membership')");
  assert.equal(belongsInInboxSql(), "COALESCE(routed_to, '') NOT IN ('membership')");
});
