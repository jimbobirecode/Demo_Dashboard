import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/lib/brand.js';
import {
  ALLOWED_STATUSES,
  PIPELINE_STAGES,
  clubDisplayName,
  extractTeeTimeFromNote,
  normaliseStatus,
  serialiseBooking,
} from '../src/lib/bookings-domain.js';
import { buildAuditSet } from '../src/lib/schema.js';

test('extracts a tee time from a stored enquiry email', () => {
  assert.equal(extractTeeTimeFromNote('Time: 12:20 PM'), '12:20 PM');
  assert.equal(extractTeeTimeFromNote('tee time: 3:45 pm'), '3:45 PM');
  assert.equal(extractTeeTimeFromNote('Tee Time: 09:20'), '09:20', '24-hour tee sheet');
  assert.equal(extractTeeTimeFromNote('no time here'), null);
  assert.equal(extractTeeTimeFromNote(null), null);
});

test('serialises a row into the shape the SPA consumes', () => {
  const booking = serialiseBooking({
    id: 1,
    booking_id: 'RD-1',
    guest_email: 'a@b.com',
    club: 'royal_dornoch',
    date: new Date(2026, 2, 18),
    tee_time: null,
    note: 'Tee Time: 10:04 AM',
    players: '4',
    total: '1234.50',
    status: 'Pending',
    hotel_required: true,
    selected_tee_times: [{ course: 'Championship', time: '10:04' }],
    lodging_nights: null,
    lodging_cost: '0',
    timestamp: '2026-01-02T09:00:00Z',
  });

  assert.equal(booking.date, '2026-03-18', 'a local-midnight DATE keeps its calendar day');
  assert.equal(booking.teeTime, '10:04 AM', 'falls back to the note');
  assert.equal(booking.total, 1234.5, 'NUMERIC arrives as a string');
  assert.equal(booking.players, 4);
  assert.equal(booking.status, 'Inquiry', 'the legacy Pending spelling is normalised');
  assert.equal(typeof booking.selectedTeeTimes, 'string', 'JSONB has to render as text');
  assert.equal(booking.lodgingNights, null);
  assert.equal(booking.lodgingCost, 0, 'zero is not null');
});

test('a row with nothing but an id does not throw', () => {
  assert.equal(serialiseBooking({ booking_id: 'x' }).teeTime, 'Not Specified');
});

test('club ids are spelled for display', () => {
  // `customer_id` is data and is never renamed to follow the branding, so the
  // ids this install owns all spell as whatever it is currently branded as.
  // Asserted against BRAND rather than a literal: the next rebrand should not
  // break a test about display names.
  assert.equal(clubDisplayName('royal_dornoch'), BRAND.fullName);
  assert.equal(clubDisplayName('teemail'), BRAND.fullName);
  assert.equal(clubDisplayName(null), BRAND.fullName);

  // A club with a name of its own keeps it, and an unknown id is title-cased
  // rather than guessed at.
  assert.equal(clubDisplayName('pebble_beach'), 'Pebble Beach');
});

test('status vocabulary', () => {
  assert.equal(normaliseStatus('booked'), 'Booked');
  assert.equal(normaliseStatus('Pending'), 'Inquiry');
  assert.ok(ALLOWED_STATUSES.includes('Pending'), 'old rows still carry it');
  assert.equal(normaliseStatus('Confirmed'), 'Booked', 'the retired stage reads as Booked');
  assert.ok(ALLOWED_STATUSES.includes('Confirmed'), 'old rows still carry it');
  assert.deepEqual(PIPELINE_STAGES, ['Inquiry', 'Requested', 'Booked']);
});

test('audit placeholders line up with the caller’s parameters', () => {
  const audit = buildAuditSet(3, 'jane');

  assert.deepEqual(audit.clauses, ['updated_at = NOW()', 'updated_by = $3']);
  assert.deepEqual(audit.values, ['jane']);
  assert.equal(3 + audit.values.length, 4, 'club lands on $4');
});

test('without a username only the timestamp is stamped', () => {
  assert.deepEqual(buildAuditSet(3, null), { clauses: ['updated_at = NOW()'], values: [] });
});
