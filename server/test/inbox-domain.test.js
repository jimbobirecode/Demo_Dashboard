import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplyEmail,
  replyAddress,
  replyProblem,
  replySubject,
  serialiseMessage,
} from '../src/lib/inbox-domain.js';
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

test('a reply is addressed to the address, even when the row kept the whole header', () => {
  // Mail arrives through the bot's webhook, where From is 'Name <addr>'. A row
  // written before that was taken apart carries the header, and SendGrid will
  // not send to one -- so the address comes out of it rather than the reply
  // failing. The name is never what is sent to.
  assert.equal(replyAddress('Adam Gordon <adam@halcyongolftravel.com>'), 'adam@halcyongolftravel.com');
  assert.equal(replyAddress('"Bookings | Halcyon" <bookings@halcyongolftravel.com>'), 'bookings@halcyongolftravel.com');
  assert.equal(replyAddress('  adam@halcyongolftravel.com '), 'adam@halcyongolftravel.com');
  assert.equal(replyAddress(null), '');
  // And a header with no address in it is still refused, rather than guessed at.
  assert.equal(replyProblem({ to: replyAddress('Adam Gordon'), body: 'Hi' }), 'No valid address to reply to');
});

test('the sender, their own name and the booking lead come back as three separate things', () => {
  // One email, three names that are easy to mix up: the address that wrote,
  // the name on that address's own From header, and the lead guest on the
  // booking it is about. The Inbox used to have only the last, and used it to
  // head the email and address the reply -- so a reply to an operator's
  // booking desk opened "Hi Lori,", Lori being a guest in the party.
  const message = serialiseMessage({
    id: 9,
    direction: 'inbound',
    from_email: 'bookings@halcyongolftravel.com',
    from_name: 'Bookings | Halcyon Golf Travel',
    booking_guest_name: 'Lori Corrion',
    booking_guest_email: 'lori@example.com',
    created_at: '2026-10-16T08:19:05Z',
  });
  assert.equal(message.fromEmail, 'bookings@halcyongolftravel.com', 'who the reply goes to');
  assert.equal(message.fromName, 'Bookings | Halcyon Golf Travel', 'how they sign themselves');
  assert.equal(message.guestName, 'Lori Corrion', 'who the round is for');
  assert.equal(message.bookingGuestEmail, 'lori@example.com', 'and the address to tell them apart by');
});

test('an email whose header carried no name says so, rather than borrowing one', () => {
  const message = serialiseMessage({ id: 10, direction: 'inbound', from_email: 'norm@example.com' });
  assert.equal(message.fromName, null);
  assert.equal(message.guestName, null);
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

test('a fresh email about a booking goes to whoever the club has been emailing, not the lead guest', async () => {
  const { bookingRecipient } = await import('../src/lib/inbox-domain.js');
  const thread = [
    { direction: 'inbound', fromEmail: 'groups@tours.test', toEmail: 'golf@club.test' },
    { direction: 'outbound', fromEmail: 'golf@club.test', toEmail: 'groups@tours.test' },
  ];
  const bookingEmail = 'lead.guest@example.com';

  // The operator made the booking and has carried every email on it. The lead
  // guest named on the booking has never written to the club.
  assert.equal(bookingRecipient({ thread, bookingEmail }), 'groups@tours.test');

  // Nobody has emailed about it yet: the booking's own address is all there is.
  assert.equal(bookingRecipient({ thread: [], bookingEmail }), bookingEmail);

  // The composer's address is honoured where it is part of the conversation -
  // including the lead guest's, when staff choose to write to them - and
  // ignored where it is not, so the route cannot be aimed at a stranger.
  assert.equal(bookingRecipient({ thread, bookingEmail, requested: 'Lead.Guest@example.com' }), bookingEmail);
  assert.equal(bookingRecipient({ thread, bookingEmail, requested: 'golf@club.test' }), 'golf@club.test');
  assert.equal(bookingRecipient({ thread, bookingEmail, requested: 'someone@else.test' }), 'groups@tours.test');

  assert.equal(bookingRecipient({}), '');
});

test('an operator mailbox is named as the operator, never as the golfer on one of its bookings', async () => {
  const { describeCorrespondent } = await import('../src/lib/inbox-domain.js');

  // The real shape of the problem: one agency address on six bookings, each
  // under a different lead golfer. Reading a name off any one of them puts a
  // stranger's name at the top of a reply to the agent.
  const operator = describeCorrespondent({
    email: 'John@DestinationGolfServices.com',
    operator: { id: 14, name: 'Destination Golf Services' },
    guestNames: ['Daniel De Mot', 'Fredric Karen', 'Logan Swineheart'],
  });
  assert.equal(operator.kind, 'operator');
  assert.equal(operator.label, 'Destination Golf Services');
  assert.equal(operator.email, 'john@destinationgolfservices.com', 'the address is kept, lowercased');
  assert.match(operator.note, /books on behalf of their clients/);

  // No operator account, but the address still books for several people: it is
  // nobody's name to be greeted by, so it is shown as the address.
  const shared = describeCorrespondent({
    email: 'trips@someagency.com',
    guestNames: ['Robert Stup', "John O'Leary"],
  });
  assert.equal(shared.kind, 'shared');
  assert.equal(shared.name, '');
  assert.equal(shared.label, 'trips@someagency.com');
  assert.match(shared.note, /Robert Stup/);

  // One address, one person, over however many bookings: that is them.
  const guest = describeCorrespondent({
    email: 'isla@example.com',
    guestNames: ['Isla Byrne', 'Isla Byrne', ' '],
  });
  assert.deepEqual(guest, {
    email: 'isla@example.com',
    kind: 'guest',
    name: 'Isla Byrne',
    label: 'Isla Byrne',
    note: '',
  });

  // Nothing known: named by address, never guessed at.
  assert.deepEqual(describeCorrespondent({ email: 'Stranger@nowhere.com' }), {
    email: 'stranger@nowhere.com',
    kind: 'unknown',
    name: '',
    label: 'stranger@nowhere.com',
    note: '',
  });
  assert.equal(describeCorrespondent({}).label, '');
});

test('an address with no account and no booking is named from how it signs itself', async () => {
  const { describeCorrespondent } = await import('../src/lib/inbox-domain.js');

  // Nearly every enquiry is this case: a new address, nothing recorded about
  // it, and a perfectly good name on the From header its mail arrived with.
  // "adam@halcyongolftravel.com" in a list tells the club very little;
  // "Adam Gordon" tells them who to ask for.
  const wrote = describeCorrespondent({ email: 'adam@halcyongolftravel.com', headerName: 'Adam Gordon' });
  assert.equal(wrote.kind, 'self-named');
  assert.equal(wrote.name, 'Adam Gordon');
  assert.equal(wrote.label, 'Adam Gordon');

  // It never outranks the club's own records: anyone can write anything in
  // that header, and the account and the booking are what the club knows.
  const operator = describeCorrespondent({
    email: 'bookings@halcyongolftravel.com',
    operator: { id: 3, name: 'Halcyon Golf Travel' },
    headerName: 'Totally Different Agency',
  });
  assert.equal(operator.label, 'Halcyon Golf Travel');
  const guest = describeCorrespondent({
    email: 'isla@example.com',
    guestNames: ['Isla Byrne'],
    headerName: 'isla',
  });
  assert.equal(guest.label, 'Isla Byrne');

  // A desk that books for several people takes the header as a label, so the
  // list reads as something -- but stays nameless, because a reply must not
  // greet whoever happened to write last time.
  const shared = describeCorrespondent({
    email: 'info@fairwaysandfundays.com',
    guestNames: ['Nick Norrad', 'Tom Pell'],
    headerName: 'Fairways and FunDays',
  });
  assert.equal(shared.kind, 'shared');
  assert.equal(shared.label, 'Fairways and FunDays');
  assert.equal(shared.name, '', 'nobody to be greeted by');

  // And a header with nothing in it changes nothing.
  assert.equal(describeCorrespondent({ email: 'norm@example.com', headerName: '  ' }).label, 'norm@example.com');
});

test('the operator account beats the booking, because the club recorded it on purpose', async () => {
  const { describeCorrespondent } = await import('../src/lib/inbox-domain.js');
  // Even where every booking on the address agrees on one name, an operator
  // account for it wins: a sole trader booking for one regular client is
  // still the agent, not the client.
  const who = describeCorrespondent({
    email: 'john@destinationgolfservices.com',
    operator: { id: 14, name: 'Destination Golf Services' },
    guestNames: ['Daniel De Mot'],
  });
  assert.equal(who.name, 'Destination Golf Services');
});
