import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKING_REF_PATTERN,
  bookingRefPrefix,
  datePart,
  mintBookingReference,
  randomCode,
} from '../src/lib/booking-ref.js';

// The core API's club_config.booking_ref_pattern, for its two profiles.
const CORE_PATTERN = /^(?:RDG|TMG)-\d{8}-[A-Z0-9]{4,16}(?![A-Z0-9])$/;

test('a minted reference has the core API shape and is recognised by its pattern', () => {
  const ref = mintBookingReference({ now: new Date('2026-09-23T23:30:00Z'), prefix: 'TMG', timeZone: 'Europe/London' });
  assert.match(ref, /^TMG-20260924-[A-Z0-9]{10}$/, 'date in the club time zone');
  assert.match(ref, CORE_PATTERN);
  assert.match(ref, BOOKING_REF_PATTERN);
  assert.match(mintBookingReference({ prefix: 'RDG' }), CORE_PATTERN);
});

test('the prefix comes from BOOKING_REF_PREFIX, validated, defaulting to TMG', () => {
  assert.equal(bookingRefPrefix({}), 'TMG');
  assert.equal(bookingRefPrefix({ BOOKING_REF_PREFIX: 'rdg' }), 'RDG');
  assert.equal(bookingRefPrefix({ BOOKING_REF_PREFIX: 'R-1; DROP' }), 'TMG');
});

test('the random part uses every character of the alphabet and comes from the CSPRNG', () => {
  assert.equal(
    randomCode(3, () => 0),
    'AAA',
  );
  assert.equal(
    randomCode(1, () => 35),
    '9',
  );
  const many = new Set(Array.from({ length: 200 }, () => mintBookingReference()));
  assert.equal(many.size, 200);
  assert.equal(datePart(new Date('2026-01-02T12:00:00Z'), 'UTC'), '20260102');
});
