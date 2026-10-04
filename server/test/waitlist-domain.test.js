import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_STATUSES,
  WAITLIST_STATUSES,
  buildWaitlistConversion,
  buildWaitlistDemand,
  daysToConvert,
  mintWaitlistId,
  normaliseWaitlistStatus,
  serialiseWaitlistEntry,
  suggestConversions,
  validateWaitlistEntry,
} from '../src/lib/waitlist-domain.js';

/** Two open, one converted, one that gave up. */
const ENTRIES = [
  {
    status: 'Waiting',
    players: 4,
    requestedDate: '2026-05-15',
    open: true,
    notificationSent: false,
    createdAt: '2026-01-01T09:00:00Z',
    convertedAt: null,
    convertedBookingId: null,
  },
  {
    status: 'Notified',
    players: 2,
    requestedDate: '2026-05-15',
    open: true,
    notificationSent: true,
    createdAt: '2026-01-02T09:00:00Z',
    convertedAt: null,
    convertedBookingId: null,
  },
  {
    status: 'Converted',
    players: 4,
    requestedDate: '2026-05-16',
    open: false,
    notificationSent: true,
    createdAt: '2026-01-01T09:00:00Z',
    convertedAt: '2026-01-11T09:00:00Z',
    convertedBookingId: 'BOOK-1',
  },
  {
    status: 'Cancelled',
    players: 2,
    requestedDate: '2026-05-16',
    open: false,
    notificationSent: true,
    createdAt: '2026-01-01T09:00:00Z',
    convertedAt: null,
    convertedBookingId: null,
  },
];

const BOOKINGS = [{ bookingId: 'BOOK-1', status: 'Booked', total: 1440 }];

test('the status vocabulary is the one the Streamlit waitlist used', () => {
  assert.deepEqual(WAITLIST_STATUSES, ['Waiting', 'Notified', 'Converted', 'Cancelled']);
  assert.deepEqual(OPEN_STATUSES, ['Waiting', 'Notified']);
  assert.equal(normaliseWaitlistStatus('converted'), 'Converted');
  assert.equal(normaliseWaitlistStatus('nonsense'), 'Waiting', 'an unknown state is still open');
  assert.equal(normaliseWaitlistStatus(null), 'Waiting');
});

test('a serialised entry carries the conversion link and says whether it is open', () => {
  const entry = serialiseWaitlistEntry({
    waitlist_id: 'WL-1',
    guest_email: 'a@b.co',
    requested_date: new Date('2026-05-15T00:00:00'),
    players: '4',
    status: 'Converted',
    converted_booking_id: 'BOOK-9',
    converted_at: new Date('2026-01-11T09:00:00Z'),
    club: 'teemail',
  });

  assert.equal(entry.requestedDate, '2026-05-15');
  assert.equal(entry.players, 4, 'a text column still arrives as a number');
  assert.equal(entry.convertedBookingId, 'BOOK-9');
  assert.equal(entry.convertedAt, '2026-01-11T09:00:00.000Z');
  assert.equal(entry.open, false);
  assert.equal(serialiseWaitlistEntry({ waitlist_id: 'x', status: 'Waiting' }).open, true);
});

test('conversion is measured against entries that reached an ending', () => {
  const stats = buildWaitlistConversion(ENTRIES, BOOKINGS);

  assert.equal(stats.entries, 4);
  assert.equal(stats.open, 2);
  assert.equal(stats.converted, 1);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.settled, 2, 'the two still waiting have not finished');
  assert.equal(stats.conversionRate, 50, 'one of the two that ended became a booking');
  assert.equal(
    stats.conversionRateOfAll,
    25,
    'against every entry the same list reads half as good — both numbers are reported',
  );
  assert.equal(stats.playersWaiting, 6);
  assert.equal(stats.playersConverted, 4);
  assert.equal(stats.revenue, 1440);
  assert.equal(stats.medianDaysToConvert, 10);
});

test('an open list is never reported as a failure', () => {
  const allWaiting = [
    { status: 'Waiting', players: 4, open: true, createdAt: '2026-01-01T09:00:00Z' },
    { status: 'Waiting', players: 2, open: true, createdAt: '2026-01-01T09:00:00Z' },
  ];
  const stats = buildWaitlistConversion(allWaiting);

  assert.equal(stats.settled, 0);
  assert.equal(stats.conversionRate, 0, 'nothing has converted, but nothing has failed either');
  assert.equal(stats.open, 2);
  assert.equal(buildWaitlistConversion([]).entries, 0, 'an empty list does not throw');
});

test('a conversion whose booking was cancelled still converted, but is not revenue', () => {
  const stats = buildWaitlistConversion(ENTRIES, [{ bookingId: 'BOOK-1', status: 'Cancelled', total: 1440 }]);

  assert.equal(stats.converted, 1, 'the waitlist did its job');
  assert.equal(stats.revenue, 0, 'the same rule the rest of the reports follow');
  assert.equal(stats.unlinked, 0);
});

test('a conversion the backfill could not value is counted and flagged', () => {
  // The note-parsing backfill can link an entry to a booking that no longer
  // exists; the conversion is real, the revenue is simply unknown.
  const stats = buildWaitlistConversion(ENTRIES, []);
  assert.equal(stats.converted, 1);
  assert.equal(stats.unlinked, 1, 'so the revenue figure is a floor, not a total');
  assert.equal(stats.revenue, 0);
});

test('notification effectiveness is its own number', () => {
  const stats = buildWaitlistConversion(ENTRIES, BOOKINGS);
  // Three entries were told about an opening; one took it.
  assert.equal(stats.notified, 3);
  assert.equal(stats.notifiedConversionRate, 33.3);
});

test('time to convert ignores a clock that runs backwards', () => {
  assert.equal(daysToConvert({ createdAt: '2026-01-01T09:00:00Z', convertedAt: '2026-01-11T09:00:00Z' }), 10);
  assert.equal(daysToConvert({ createdAt: '2026-01-11T09:00:00Z', convertedAt: '2026-01-01T09:00:00Z' }), null);
  assert.equal(daysToConvert({ createdAt: null, convertedAt: '2026-01-01T09:00:00Z' }), null);
  assert.equal(buildWaitlistConversion([]).medianDaysToConvert, null);
});

test('demand ranks the dates people ask for and do not get', () => {
  const demand = buildWaitlistDemand(ENTRIES);

  const busiest = demand[0];
  assert.equal(busiest.date, '2026-05-15');
  assert.equal(busiest.players, 6);
  assert.equal(busiest.entries, 2);
  assert.equal(busiest.converted, 0);
  assert.equal(busiest.unmet, 2);
  assert.equal(busiest.conversion, 0);

  const other = demand.find((row) => row.date === '2026-05-16');
  assert.equal(other.conversion, 50);
  assert.equal(buildWaitlistDemand([]).length, 0);
});

test('a new entry needs an address, a date and a sane party size', () => {
  const good = validateWaitlistEntry({ guestEmail: ' A@B.co ', requestedDate: '2026-05-15', players: 4 });
  assert.equal(good.ok, true);
  assert.equal(good.value.guestEmail, 'a@b.co');
  assert.equal(good.value.priority, 5, 'the middle of the scale by default');

  assert.match(validateWaitlistEntry({ requestedDate: '2026-05-15', players: 4 }).errors[0], /email/);
  assert.match(validateWaitlistEntry({ guestEmail: 'a@b.co', players: 4 }).errors[0], /requested date/);
  assert.match(
    validateWaitlistEntry({ guestEmail: 'a@b.co', requestedDate: '2026-05-15', players: 0 }).errors[0],
    /Players/,
  );
  assert.match(
    validateWaitlistEntry({ guestEmail: 'a@b.co', requestedDate: '15/05/2026', players: 4 }).errors[0],
    /requested date/,
  );
  assert.match(
    validateWaitlistEntry({ guestEmail: 'a@b.co', requestedDate: '2026-05-15', players: 4, priority: 99 }).errors[0],
    /Priority/,
  );
});

test('a minted id is dated and unique enough to read', () => {
  const id = mintWaitlistId(new Date('2026-09-23T10:00:00Z'), () => 0);
  assert.equal(id, 'WL-20260923-AAAAAA');
  assert.match(mintWaitlistId(), /^WL-\d{8}-[A-Z0-9]{6}$/);
  assert.notEqual(mintWaitlistId(), mintWaitlistId());
});

/* ---------- conversions that happened somewhere else ---------- */

const OPEN = [
  {
    waitlistId: 'WL-A',
    guestEmail: 'alan@x.com',
    guestName: 'Alan',
    requestedDate: '2026-05-15',
    players: 4,
    open: true,
    status: 'Waiting',
    createdAt: '2026-01-01T09:00:00Z',
    convertedBookingId: null,
  },
  {
    waitlistId: 'WL-B',
    guestEmail: 'petra@x.se',
    requestedDate: '2026-05-20',
    players: 2,
    open: true,
    status: 'Notified',
    createdAt: '2026-01-01T09:00:00Z',
    convertedBookingId: null,
  },
];

const on = (date, over = {}) => ({
  bookingId: 'B',
  guestEmail: 'alan@x.com',
  date,
  players: 4,
  total: 1440,
  status: 'Booked',
  timestamp: '2026-02-01T09:00:00Z',
  ...over,
});

test('a booking on the requested date is an exact suggestion', () => {
  const [match, ...rest] = suggestConversions(OPEN, [on('2026-05-15', { bookingId: 'B-1' })]);

  assert.equal(rest.length, 0);
  assert.equal(match.waitlistId, 'WL-A');
  assert.equal(match.bookingId, 'B-1');
  assert.equal(match.confidence, 'exact');
  assert.equal(match.playersMatch, true);
  assert.match(match.because, /the date they asked for/);
});

test('a booking near the requested date is likely, and says how near', () => {
  const [match] = suggestConversions(OPEN, [
    on('2026-05-22', { bookingId: 'B-2', guestEmail: 'petra@x.se', players: 4 }),
  ]);

  assert.equal(match.confidence, 'likely');
  assert.equal(match.dayGap, 2);
  assert.match(match.because, /2 days after/);
  assert.equal(match.playersMatch, false, 'a different party size is the usual reason a match is wrong');
});

test('nothing is suggested that cannot be the conversion', () => {
  const noise = [
    on('2026-09-01', { bookingId: 'far' }), // a different trip
    on('2026-05-15', { bookingId: 'gone', status: 'Cancelled' }), // converted nobody
    on('2026-05-15', { bookingId: 'old', timestamp: '2025-06-01T09:00:00Z' }), // predates the entry
    on('2026-05-15', { bookingId: 'else', guestEmail: 'somebody@x.com' }), // a different guest
    on('2026-05-15', { bookingId: 'blank', guestEmail: '' }),
  ];
  assert.deepEqual(suggestConversions(OPEN, noise), []);
});

test('a booking already recorded as somebody else’s conversion is not offered again', () => {
  const entries = [
    ...OPEN,
    {
      waitlistId: 'WL-C',
      guestEmail: 'alan@x.com',
      requestedDate: '2026-05-15',
      players: 4,
      open: false,
      status: 'Converted',
      createdAt: '2026-01-01T09:00:00Z',
      convertedBookingId: 'B-1',
    },
  ];
  assert.deepEqual(
    suggestConversions(entries, [on('2026-05-15', { bookingId: 'B-1' })]),
    [],
    'one booking cannot be two conversions, or the play is counted twice',
  );
});

test('a closed entry is never offered a match, and an empty list is quiet', () => {
  const closed = [
    {
      waitlistId: 'WL-X',
      guestEmail: 'alan@x.com',
      requestedDate: '2026-05-15',
      players: 4,
      open: false,
      status: 'Cancelled',
      createdAt: '2026-01-01T09:00:00Z',
      convertedBookingId: null,
    },
  ];
  assert.deepEqual(suggestConversions(closed, [on('2026-05-15', { bookingId: 'B-1' })]), []);
  assert.deepEqual(suggestConversions([], [on('2026-05-15')]), []);
  assert.deepEqual(suggestConversions(OPEN, []), []);
});

test('exact matches sort above likely ones, and matching party sizes above not', () => {
  const entries = [
    OPEN[0],
    {
      waitlistId: 'WL-D',
      guestEmail: 'dee@x.com',
      requestedDate: '2026-05-15',
      players: 2,
      open: true,
      status: 'Waiting',
      createdAt: '2026-01-01T09:00:00Z',
      convertedBookingId: null,
    },
  ];
  const bookings = [
    on('2026-05-17', { bookingId: 'near' }),
    on('2026-05-15', { bookingId: 'spot-on' }),
    on('2026-05-15', { bookingId: 'wrong-size', guestEmail: 'dee@x.com', players: 8 }),
  ];

  assert.deepEqual(
    suggestConversions(entries, bookings).map((row) => row.bookingId),
    ['spot-on', 'wrong-size', 'near'],
  );
});

test('the window is configurable, because flexibility differs by club', () => {
  const bookings = [on('2026-05-20', { bookingId: 'five-days-out' })];
  assert.equal(suggestConversions(OPEN, bookings).length, 0, 'outside the default three days');
  assert.equal(suggestConversions(OPEN, bookings, { windowDays: 7 }).length, 1);
});
