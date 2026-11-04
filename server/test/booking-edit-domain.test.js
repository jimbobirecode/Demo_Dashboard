/**
 * Changing a booking by hand, and taking one by hand.
 *
 * What these guard: an edit writes only what changed; a new party size is
 * repriced at the price per player the booking was taken at, unless a total
 * comes with it; the consequences of an edit are said before the guest finds
 * them; a booking taken by phone can be reached and is priced; and its
 * reference is one the email bot will recognise in a reply.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITABLE_FIELDS,
  mintDeskReference,
  pricePerPlayer,
  validateBookingEdit,
  validateNewBooking,
} from '../src/lib/booking-edit-domain.js';

// Carr Golf's party of eight at the 2027 tour-operator rate.
const current = {
  bookingId: 'BOOK-20261028-5527FBF6',
  date: '2027-08-26',
  teeTime: '10:20',
  players: 8,
  total: 2600,
  guestName: 'Harris Turer',
  guestEmail: 'timmy.kenna@carrgolf.com',
  contactPhone: '',
  specialRequests: '',
  amountPaid: 0,
  paymentLinkUrl: null,
  paymentLinkAmount: null,
};

test('an edit writes only what changed', () => {
  // The drawer sends the whole form back; only the date moved.
  const result = validateBookingEdit({ ...pick(current, EDITABLE_FIELDS), date: '2027-08-27' }, current);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes, { date: '2027-08-27' });
});

test('nothing changed is said, not saved', () => {
  const result = validateBookingEdit(pick(current, EDITABLE_FIELDS), current);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['Nothing has changed']);
});

test('eight who become twelve are twelve at the price the eight were taken at', () => {
  const result = validateBookingEdit({ players: 12 }, current);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes, { players: 12, total: 3900 });
  assert.deepEqual(result.repriced, { pricePerPlayer: 325, from: 2600, to: 3900 });
});

test('a total sent with the new party size stands as typed', () => {
  // The desk agreed a price for the bigger group; the arithmetic does not
  // overrule it.
  const result = validateBookingEdit({ players: 12, total: 3600 }, current);
  assert.deepEqual(result.changes, { players: 12, total: 3600 });
  assert.equal(result.repriced, null);
});

test('what is wrong with the form is said, and nothing is written', () => {
  const result = validateBookingEdit(
    { date: '2027-02-30', players: 0, total: -5, guestEmail: 'not an address', bookingId: 'X' },
    current,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.changes, {});
  assert.ok(result.errors.includes('Date must be a real date, as YYYY-MM-DD'), '30 February is not a date');
  assert.ok(result.errors.some((error) => error.startsWith('Players')));
  assert.ok(result.errors.some((error) => error.startsWith('Total')));
  assert.ok(result.errors.includes('That email address does not look right'));
  assert.ok(result.errors.includes('bookingId cannot be changed here'), 'the reference is not editable');
});

test('a booking cannot be left with no way to reach anybody', () => {
  const result = validateBookingEdit({ guestEmail: '' }, current);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['A booking needs an email address or a phone number']);
  // With a phone number it can.
  assert.equal(validateBookingEdit({ guestEmail: '', contactPhone: '+353 41 982 2329' }, current).ok, true);
});

test('the consequences of an edit are said before the guest finds them', () => {
  const linked = { ...current, paymentLinkUrl: 'https://pay.stripe.com/x', paymentLinkAmount: 780 };
  const repriced = validateBookingEdit({ players: 12 }, linked);
  assert.match(repriced.warnings.join(' '), /payment link already sent asks for €780\.00/);

  const overpaid = validateBookingEdit({ total: 500 }, { ...current, amountPaid: 780 });
  assert.match(overpaid.warnings.join(' '), /€780\.00 has already been paid, which is more than the new total/);

  const moved = validateBookingEdit({ date: '2027-09-01' }, current);
  assert.match(moved.warnings.join(' '), /follow the new date/);
});

test('the price per player is the booking’s own', () => {
  assert.equal(pricePerPlayer(current), 325);
  assert.equal(pricePerPlayer({ players: 0, total: 100 }), null);
});

// --- taking a booking -------------------------------------------------------

const PHONE = {
  date: '2027-06-12',
  teeTime: '09:40',
  players: 4,
  pricePerPlayer: 325,
  guestName: 'Michael Byrne',
  contactPhone: '+353 87 123 4567',
  source: 'phone',
};

test('a phone booking is priced from the price per player, and taken as Booked', () => {
  const result = validateNewBooking(PHONE, { today: '2026-11-02' });
  assert.equal(result.ok, true);
  assert.equal(result.value.total, 1300);
  assert.equal(result.value.status, 'Booked');
  assert.equal(result.value.source, 'phone');
});

test('a total given outright stands', () => {
  const result = validateNewBooking({ ...PHONE, total: 1200 }, { today: '2026-11-02' });
  assert.equal(result.value.total, 1200);
});

test('a booking taken needs a date to come, a party, a price and a way to reach them', () => {
  const result = validateNewBooking({ date: '2026-10-01', source: 'phone' }, { today: '2026-11-02' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('That date has already passed'));
  assert.ok(result.errors.includes('The number of players is required'));
  assert.ok(result.errors.includes('A price per player, or a total, is required'));
  assert.ok(result.errors.includes('An email address or a phone number is required'));
});

test('it is never taken as Rejected or Cancelled, and only on one of the club’s own accounts', () => {
  const operators = [{ id: 3, name: 'Carr Golf' }];
  const cancelled = validateNewBooking({ ...PHONE, status: 'Cancelled' }, { today: '2026-11-02', operators });
  assert.ok(cancelled.errors.includes('A booking cannot be taken as Cancelled'));

  const foreign = validateNewBooking({ ...PHONE, operatorId: 99 }, { today: '2026-11-02', operators });
  assert.ok(foreign.errors.includes('That tour operator is not one of this club’s accounts'));

  const carr = validateNewBooking({ ...PHONE, operatorId: '3' }, { today: '2026-11-02', operators });
  assert.equal(carr.value.operatorId, 3);
});

test('its reference is one the email bot will find in a reply', () => {
  // The bot links a reply to its booking by this pattern and no other.
  const BOT = /^BOOK-\d{8}-[A-F0-9]{8}$/;
  const reference = mintDeskReference({ now: new Date('2026-11-02T10:00:00Z') });
  assert.match(reference, BOT);
  assert.ok(reference.startsWith('BOOK-20261102-'));
  // And they are not all the same.
  const many = new Set(Array.from({ length: 200 }, () => mintDeskReference()));
  assert.equal(many.size, 200);
});

function pick(source, keys) {
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}
