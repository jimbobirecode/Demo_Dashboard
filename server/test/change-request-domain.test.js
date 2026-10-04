import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANAGEABLE_STATUSES,
  daysUntilPlay,
  describeOptions,
  describeRequest,
  MANAGE_LINK_GRACE_DAYS,
  manageLink,
  manageLinkExpired,
  readChangePolicy,
  serialiseChangeRequest,
  signBooking,
  validateChangeRequest,
  verifyBookingToken,
} from '../src/lib/change-request-domain.js';

const SECRET = 'a-test-secret';
const OPEN = { canCancel: true, canAmend: true, autoCancel: false, reason: 'The club will confirm' };

test('a manage link is signed, and scoped to its booking and club', () => {
  const token = signBooking('RDG-1', SECRET, 'teemail');

  assert.equal(token.length, 32);
  assert.equal(verifyBookingToken('RDG-1', token, SECRET, 'teemail'), true);
  assert.equal(verifyBookingToken('RDG-2', token, SECRET, 'teemail'), false, 'not another booking');
  assert.equal(verifyBookingToken('RDG-1', token, SECRET, 'other'), false, 'not another club');
  assert.equal(verifyBookingToken('RDG-1', token, 'different-secret', 'teemail'), false);
  assert.equal(verifyBookingToken('RDG-1', '', SECRET, 'teemail'), false);
  assert.equal(verifyBookingToken('RDG-1', token, null, 'teemail'), false, 'no secret means no access');
  assert.equal(signBooking('RDG-1', null), null);

  // A token of the wrong length must be refused rather than throw, which is
  // what a naive timingSafeEqual would do.
  assert.equal(verifyBookingToken('RDG-1', 'short', SECRET, 'teemail'), false);
});

test('the link is absolute and escapes what it carries', () => {
  assert.equal(
    manageLink('https://dash.teemail.io/', 'RDG/1', 'tok+en'),
    'https://dash.teemail.io/manage-booking?ref=RDG%2F1&token=tok%2Ben',
  );
});

test('a guest can only ever ask: every cancellation and change waits for the club', () => {
  const policy = readChangePolicy({});
  assert.equal(policy.cancelNeedsApproval, true);
  assert.equal(policy.amendNeedsApproval, true, 'an amendment is a conversation about availability');

  // The old self-cancel setting no longer does anything.
  const oldSetting = readChangePolicy({ BOOKING_SELF_CANCEL_DAYS: '0' });
  const booking = { status: 'Booked', date: '2026-06-01' };
  for (const today of ['2026-01-01', '2026-05-01', '2026-05-31']) {
    const options = describeOptions(booking, oldSetting, today);
    assert.equal(options.canCancel, true);
    assert.equal(options.autoCancel, false, today);
    assert.match(options.reason, /nothing changes until/);
  }
});

test('a finished booking offers nothing, and says why', () => {
  const policy = readChangePolicy({});

  const cancelled = describeOptions({ status: 'Cancelled', date: '2026-06-01' }, policy, '2026-05-01');
  assert.equal(cancelled.canCancel, false);
  assert.match(cancelled.reason, /already been cancelled/);

  const played = describeOptions({ status: 'Booked', date: '2026-04-01' }, policy, '2026-05-01');
  assert.equal(played.canAmend, false);
  assert.match(played.reason, /already been played/);

  assert.equal(describeOptions(null, policy, '2026-05-01').canCancel, false);
  assert.deepEqual(MANAGEABLE_STATUSES, ['Inquiry', 'Requested', 'Booked']);
});

test('days until play counts from today, and goes negative afterwards', () => {
  assert.equal(daysUntilPlay('2026-06-01', '2026-05-01'), 31);
  assert.equal(daysUntilPlay('2026-05-01', '2026-05-01'), 0);
  assert.equal(daysUntilPlay('2026-04-01', '2026-05-01'), -30);
  assert.equal(daysUntilPlay('nonsense', '2026-05-01'), null);
});

test('a request has to say enough for the club to act on it', () => {
  assert.equal(validateChangeRequest({ kind: 'cancel' }, OPEN).ok, true, 'a cancellation needs no words');
  assert.equal(validateChangeRequest({ kind: 'amend', message: 'Move to Sunday' }, OPEN).ok, true);
  assert.equal(
    validateChangeRequest({ kind: 'amend', requestedDate: '2026-06-02' }, OPEN).ok,
    true,
    'a date is enough on its own',
  );

  assert.match(validateChangeRequest({ kind: 'amend' }, OPEN).errors[0], /what you would like to change/);
  assert.match(validateChangeRequest({ kind: 'move' }, OPEN).errors[0], /amend or cancel/);
  assert.match(
    validateChangeRequest({ kind: 'amend', requestedDate: '02/06/2026', message: 'x' }, OPEN).errors[0],
    /date is not valid/,
  );
  assert.match(
    validateChangeRequest({ kind: 'amend', message: 'x', requestedPlayers: 99 }, OPEN).errors[0],
    /Players must be/,
  );
  assert.match(validateChangeRequest({ kind: 'amend', message: 'x'.repeat(2001) }, OPEN).errors[0], /2000/);

  // The policy's refusal is the error, so the page never offers what the API
  // will reject.
  const closed = { canCancel: false, canAmend: false, reason: 'This round has already been played.' };
  assert.deepEqual(validateChangeRequest({ kind: 'cancel' }, closed).errors, [closed.reason]);
});

test('a request reads as a sentence in the club’s list', () => {
  assert.equal(describeRequest({ kind: 'cancel', autoApplied: false }), 'Asks to cancel');
  assert.equal(describeRequest({ kind: 'cancel', autoApplied: true }), 'Cancelled by the guest');
  assert.equal(
    describeRequest({ kind: 'amend', requestedDate: '2026-06-02', requestedTime: 'Morning' }),
    'Asks to move to 2026-06-02, at Morning',
  );
  assert.equal(describeRequest({ kind: 'amend' }), 'Asks for a change');
});

test('a stored request serialises without surprises', () => {
  const request = serialiseChangeRequest({
    id: 3,
    booking_id: 'RDG-1',
    kind: 'cancel',
    message: null,
    status: 'Pending',
    auto_applied: false,
    days_before_play: 31,
    created_at: new Date('2026-05-01T09:00:00Z'),
    requested_date: new Date('2026-06-02T00:00:00'),
  });

  assert.equal(request.message, '', 'a null message is empty text, not "null"');
  assert.equal(request.requestedDate, '2026-06-02');
  assert.equal(request.open, true);
  assert.equal(request.createdAt, '2026-05-01T09:00:00.000Z');
  assert.equal(serialiseChangeRequest({ id: 1, status: 'Applied' }).open, false);
});

test('a manage link stops opening a month after the round', () => {
  assert.equal(MANAGE_LINK_GRACE_DAYS, 30);
  const today = '2026-10-03';
  assert.equal(manageLinkExpired({ date: '2026-11-01' }, today), false, 'upcoming');
  assert.equal(manageLinkExpired({ date: '2026-09-03' }, today), false, 'exactly 30 days ago');
  assert.equal(manageLinkExpired({ date: '2026-09-02' }, today), true, '31 days ago');
  assert.equal(manageLinkExpired({ date: null }, today), false, 'undated bookings are left to the club');
  assert.equal(manageLinkExpired({ date: '2026-09-25' }, today, { graceDays: 7 }), true);
});

test('the link format is unchanged — the booking service mints the same one', () => {
  // Same value the booking service's test expects for this booking and secret.
  assert.equal(signBooking('TMG-20261018-AB12', 'secret', 'royal_dornoch'), 'cd-7OB3iyxwKtt_lDyMPgmM7UK1P86nJ');
});
