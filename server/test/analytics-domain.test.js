import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TIME_BANDS,
  WEEK_ORDER,
  buildAccommodation,
  buildAnalytics,
  buildCaddieDemand,
  buildCourseMix,
  buildEmailCoverage,
  buildFunnel,
  buildGuestMix,
  buildLeadTime,
  buildLodging,
  buildPartySizes,
  buildPaymentHealth,
  buildSeries,
  buildRequestThemes,
  buildRequestUtilisation,
  buildResponseTimes,
  buildTotals,
  buildTradeMix,
  classifyCaddie,
  bucketDate,
  leadTimeDays,
  parseTeeHour,
} from '../src/lib/analytics-domain.js';

/** Four bookings spanning both courses, both months and a cancellation. */
const ROWS = [
  {
    status: 'Booked',
    total: 400,
    players: 4,
    date: '2026-03-18',
    teeTime: '10:04 AM',
    timestamp: '2026-02-01T09:00:00Z',
    golfCourses: 'Championship Course',
    hotelRequired: true,
  },
  {
    status: 'Booked',
    total: 200,
    players: 2,
    date: '2026-03-20',
    teeTime: '08:30',
    timestamp: '2026-03-18T09:00:00Z',
    golfCourses: 'Struie Course',
    hotelRequired: false,
  },
  {
    status: 'Inquiry',
    total: 150,
    players: 3,
    date: '2026-04-02',
    teeTime: 'Not Specified',
    timestamp: '2026-03-01T09:00:00Z',
    golfCourses: '',
    hotelRequired: false,
  },
  {
    status: 'Cancelled',
    total: 999,
    players: 2,
    date: '2026-04-05',
    teeTime: '14:15',
    timestamp: '2026-01-01T09:00:00Z',
    golfCourses: 'Championship Course and Struie Course',
    hotelRequired: true,
  },
];

test('parses every tee-time spelling in this database', () => {
  assert.equal(parseTeeHour('10:04 AM'), 10 + 4 / 60);
  assert.equal(parseTeeHour('1:30 PM'), 13.5);
  assert.equal(parseTeeHour('12:00 AM'), 0, 'midnight is hour 0, not 12');
  assert.equal(parseTeeHour('12:30 PM'), 12.5, 'noon stays 12');
  assert.equal(parseTeeHour('09:20'), 9 + 20 / 60, '24-hour tee sheet');
  assert.equal(parseTeeHour('7:30pm'), 19.5);
  assert.equal(parseTeeHour('Not Specified'), null);
  assert.equal(parseTeeHour('25:00'), null);
});

test('lead time ignores rows backfilled after the round', () => {
  assert.equal(leadTimeDays({ date: '2026-03-18', timestamp: '2026-03-01T09:00:00Z' }), 17);
  assert.equal(leadTimeDays({ date: '2026-03-18', timestamp: '2026-03-18T23:00:00Z' }), 0, 'same day');
  assert.equal(leadTimeDays({ date: '2026-03-01', timestamp: '2026-03-18T09:00:00Z' }), null);
});

test('weeks bucket to their Monday', () => {
  assert.equal(bucketDate('2026-03-18', 'month'), '2026-03-01');
  assert.equal(bucketDate('2026-03-18', 'week'), '2026-03-16', 'Wednesday');
  assert.equal(bucketDate('2026-03-16', 'week'), '2026-03-16', 'Monday is its own week');
  assert.equal(bucketDate('2026-03-22', 'week'), '2026-03-16', 'Sunday closes the week before');
});

test('revenue counts only committed bookings', () => {
  const totals = buildTotals(ROWS, [{ status: 'Booked', total: 300, players: 2 }]);

  assert.equal(totals.revenue, 600, 'the cancelled 999 and the open 150 are excluded');
  assert.equal(totals.averageValue, 300);
  assert.equal(totals.committed, 2);
  assert.equal(totals.lost, 1);
  assert.equal(totals.conversionRate, 50);
  assert.equal(totals.cancellationRate, 25);
  assert.equal(totals.delta.revenue, 100, '300 to 600 is +100%');
});

test('growth from a zero baseline is undefined, not infinite', () => {
  const totals = buildTotals(ROWS, [{ status: 'Inquiry', total: 0, players: 0 }]);
  assert.equal(totals.delta.revenue, null);
});

test('the time series is zero-filled across the whole span', () => {
  const daily = buildSeries(ROWS, 'day');

  assert.equal(daily[0].date, '2026-03-18');
  assert.equal(daily.at(-1).date, '2026-04-05');
  assert.equal(daily.length, 19, 'every day exists');
  assert.ok(
    daily.some((day) => day.count === 0),
    'quiet days read as troughs',
  );
  assert.equal(
    daily.reduce((n, day) => n + day.count, 0),
    4,
  );
  assert.equal(
    daily.reduce((n, day) => n + day.revenue, 0),
    600,
  );
});

test('coarser granularities roll up', () => {
  assert.deepEqual(
    buildSeries(ROWS, 'month').map((m) => m.date),
    ['2026-03-01', '2026-04-01'],
  );
  assert.deepEqual(
    buildSeries(ROWS, 'month').map((m) => m.count),
    [2, 2],
  );
  assert.ok(
    buildSeries(ROWS, 'week').every((w) => new Date(`${w.date}T00:00:00Z`).getUTCDay() === 1),
    'every week starts on a Monday',
  );
});

test('the funnel narrows and says where enquiries were lost', () => {
  const funnel = buildFunnel(ROWS);

  assert.equal(funnel[0].count, 3, 'the cancellation is excluded');
  assert.ok(
    funnel.every((s, i) => i === 0 || s.count <= funnel[i - 1].count),
    'monotonic',
  );
  assert.equal(funnel[0].conversionFromPrevious, 100, 'the top stage has no predecessor');
  assert.equal(funnel[1].droppedHere, 1, 'the open enquiry never advanced');
  assert.equal(funnel.at(-1).stage, 'Booked');
});

test('lead time distribution and median', () => {
  const lead = buildLeadTime(ROWS);

  assert.equal(
    lead.distribution.reduce((n, b) => n + b.count, 0),
    4,
  );
  assert.equal(lead.distribution[0].key, '0–7 days');
  assert.equal(lead.distribution[0].count, 1, 'the two-day booking');
  assert.equal(lead.median, 39, 'median of [2, 32, 45, 94] is 38.5, rounded');
  assert.equal(buildLeadTime([]).median, null);
});

test('party size buckets keep their empty rows', () => {
  const sizes = buildPartySizes(ROWS);

  assert.equal(sizes.find((b) => b.key === '4-ball').count, 1);
  assert.equal(sizes.find((b) => b.key === 'Pair').count, 2);
  assert.equal(sizes.find((b) => b.key === '9+').count, 0, 'the axis keeps its shape');
});

test('a booking naming both courses counts toward both', () => {
  const courses = buildCourseMix(ROWS);

  assert.equal(courses.find((c) => c.key === 'Championship').count, 2);
  assert.equal(courses.find((c) => c.key === 'Struie').count, 2);
  assert.equal(courses.find((c) => c.key === 'Not specified').count, 1);
  assert.ok(
    courses.every((c) => c.count > 0),
    'courses nobody booked are dropped',
  );
});

test('accommodation attach rate and basket size', () => {
  const stay = buildAccommodation(ROWS);

  assert.equal(stay.withAccommodation, 2);
  assert.equal(stay.attachRate, 50);
  assert.equal(stay.averageWith, 400, 'only the committed stay counts');
  assert.equal(stay.averageWithout, 200);
});

test('the request grid is complete and drops untimed rows', () => {
  const grid = buildRequestUtilisation(ROWS);
  const at = (band, day) => grid.cells.find((c) => c.band === band && c.day === day);

  assert.equal(grid.cells.length, TIME_BANDS.length * 7, 'every cell exists, even at zero');
  assert.equal(grid.placed, 3, 'the Not Specified row carries no slot to ask for');
  assert.equal(grid.unplaced, 1);
  assert.equal(at('09:00–11:59', 'Wednesday').requests, 1);
  assert.equal(at('Before 09:00', 'Friday').requests, 1);
  assert.equal(at('14:00–16:59', 'Sunday').requests, 1);
  assert.deepEqual(grid.days, WEEK_ORDER);
  assert.equal(grid.days[0], 'Monday', 'a tee sheet is read Monday-first');
});

test('the request grid separates what was asked for from what was booked', () => {
  const grid = buildRequestUtilisation(ROWS);
  const at = (band, day) => grid.cells.find((c) => c.band === band && c.day === day);

  const converted = at('09:00–11:59', 'Wednesday');
  assert.equal(converted.converted, 1);
  assert.equal(converted.missed, 0);
  assert.equal(converted.conversion, 100);
  assert.equal(converted.bookings, 1, 'asked for and played in the same band');
  assert.equal(converted.revenue, 400);

  const cancelled = at('14:00–16:59', 'Sunday');
  assert.equal(cancelled.requests, 1);
  assert.equal(cancelled.converted, 0);
  assert.equal(cancelled.declined, 1);
  assert.equal(cancelled.missed, 1, 'demand that walked away');
  assert.equal(cancelled.conversion, 0);
  assert.equal(cancelled.bookings, 0, 'a cancellation never occupies the sheet');

  assert.equal(grid.totals.requests, 3);
  assert.equal(grid.totals.converted, 2);
  assert.equal(grid.totals.declined, 1);
  assert.equal(grid.totals.open, 0, 'the open enquiry has no slot to sit in');
  assert.equal(grid.totals.missed, 1);
  assert.equal(grid.totals.conversion, 66.7);
  assert.equal(grid.totals.bookings, 2);
});

test('the form selection is the ask, the tee sheet is the booking', () => {
  const moved = [
    {
      status: 'Booked',
      total: 400,
      players: 4,
      date: '2026-03-18',
      teeTime: '02:30 PM',
      selectedTeeTimes: 'course: Championship, time: 08:10 AM',
      timestamp: '2026-02-01T09:00:00Z',
    },
  ];
  const grid = buildRequestUtilisation(moved);
  const at = (band) => grid.cells.find((c) => c.band === band && c.day === 'Wednesday');

  assert.equal(at('Before 09:00').requests, 1, 'the ask sits where they asked');
  assert.equal(at('Before 09:00').bookings, 0);
  assert.equal(at('Before 09:00').movedOut, 1);
  assert.equal(at('14:00–16:59').bookings, 1, 'the booking sits where they play');
  assert.equal(at('14:00–16:59').requests, 0);
  assert.equal(at('14:00–16:59').movedIn, 1);

  assert.equal(grid.totals.moved, 1);
  assert.deepEqual(
    grid.shifts.map((s) => [s.from, s.to, s.count]),
    [['Before 09:00', '14:00–16:59', 1]],
  );
});

test('gaps rank the slots people ask for and walk away from', () => {
  const rows = [
    // Two asked for Saturday morning, neither booked; one booked Monday morning.
    { status: 'Cancelled', players: 4, date: '2026-03-21', teeTime: '09:30' },
    { status: 'Inquiry', players: 2, date: '2026-03-21', teeTime: '10:30' },
    { status: 'Booked', players: 2, total: 200, date: '2026-03-16', teeTime: '09:30' },
  ];
  const grid = buildRequestUtilisation(rows);

  assert.equal(grid.gaps[0].key, 'Saturday · 09:00–11:59');
  assert.equal(grid.gaps[0].requests, 2);
  assert.equal(grid.gaps[0].missed, 2);
  assert.equal(grid.gaps[0].declined, 1);
  assert.equal(grid.gaps[0].open, 1, 'still live counts as not booked yet, separately');
  assert.equal(grid.gaps[0].conversion, 0);
  assert.equal(grid.gaps.length, 1, 'a fully converted slot is not a gap');
});

test('buildAnalytics composes every section', () => {
  const analytics = buildAnalytics(ROWS, { granularity: 'nonsense' });

  assert.equal(analytics.granularity, 'day', 'an unknown granularity falls back');
  for (const key of [
    'totals',
    'byStatus',
    'series',
    'funnel',
    'leadTime',
    'partySizes',
    'courses',
    'accommodation',
    'requestUtilisation',
    'popularTeeTimes',
    'busiestDays',
  ]) {
    assert.ok(analytics[key] !== undefined, `missing ${key}`);
  }
  assert.equal(analytics.byStatus.length, 5);
  assert.ok(!analytics.popularTeeTimes.some((e) => e.key === 'Not Specified'));
});

test('an empty period does not throw', () => {
  const analytics = buildAnalytics([]);
  assert.equal(analytics.totals.bookings, 0);
  assert.equal(analytics.series.length, 0);
  assert.equal(analytics.leadTime.median, null);
});

/* ---------- the sections built on the later migrations ---------- */

/** Two committed bookings with real payment state, one of them overdue. */
const MONEY = [
  {
    status: 'Booked',
    total: 1200,
    players: 4,
    date: '2026-03-18',
    paymentStatus: 'Deposit paid',
    amountPaid: 300,
    invoiceNumber: 'INV-1',
    balanceDueDate: '2026-02-01',
  },
  { status: 'Booked', total: 400, players: 2, date: '2026-03-20', paymentStatus: 'Paid', amountPaid: 400 },
  { status: 'Booked', total: 500, players: 2, date: '2026-03-22', paymentStatus: 'Written off', amountPaid: 0 },
  { status: 'Inquiry', total: 999, players: 2, date: '2026-04-02', paymentStatus: 'Unpaid', amountPaid: 0 },
];

test('payment health counts only what the club has committed to', () => {
  const money = buildPaymentHealth(MONEY, { today: '2026-03-01' });

  assert.equal(money.tracked, true);
  assert.equal(money.bookings, 3, 'the open enquiry is not money the club is owed');
  assert.equal(money.gross, 2100);
  assert.equal(money.paid, 700);
  assert.equal(money.outstanding, 900, 'the written-off 500 owes nothing');
  assert.equal(money.collectionRate, 33.3);
  assert.equal(money.invoicedRate, 33.3);
  assert.equal(money.overdue, 1);
  assert.equal(money.overdueAmount, 900);
  assert.equal(money.ageing.find((b) => b.key === '1–30 days').count, 1, '28 days late');
  assert.equal(money.byStatus.find((b) => b.key === 'Written off').outstanding, 0);
});

test('an install that never records payments is not shown a wall of zeroes', () => {
  const untracked = buildPaymentHealth(
    [{ status: 'Booked', total: 400, players: 2, paymentStatus: 'Unpaid', amountPaid: 0 }],
    { today: '2026-03-01' },
  );
  assert.equal(untracked.tracked, false);
});

test('a due date in the future is outstanding but not overdue', () => {
  const money = buildPaymentHealth(MONEY, { today: '2026-01-01' });
  assert.equal(money.outstanding, 900);
  assert.equal(money.overdue, 0);
});

test('trade and direct are split by the operator a booking is matched to', () => {
  const rows = [
    { status: 'Booked', total: 1200, players: 4, tourOperatorId: 7 },
    { status: 'Inquiry', total: 800, players: 4, tourOperatorId: 7 },
    { status: 'Booked', total: 400, players: 2, tourOperatorId: null },
    { status: 'Cancelled', total: 999, players: 2 },
  ];
  const trade = buildTradeMix(rows, { names: new Map([[7, 'Haversham Golf Tours']]) });

  const [direct, agency] = trade.channels;
  assert.equal(direct.count, 2, 'a booking with no operator, and one with none recorded');
  assert.equal(agency.count, 2);
  assert.equal(agency.revenue, 1200, 'the open enquiry carries no revenue yet');
  assert.equal(agency.conversion, 50);
  assert.equal(trade.tradeShare, 50);
  assert.equal(trade.operators[0].key, 'Haversham Golf Tours');
  assert.equal(
    buildTradeMix(rows).operators[0].key,
    'Account 7',
    'an install with no operators table still reports the id',
  );
});

test('lodging reads nights, rooms and what the stay is worth', () => {
  const rows = [
    {
      status: 'Booked',
      total: 1200,
      players: 4,
      hotelRequired: true,
      lodgingNights: 3,
      lodgingRooms: 2,
      lodgingRoomType: 'Twin',
      lodgingCost: 600,
      resortFeeTotal: 40,
    },
    {
      status: 'Booked',
      total: 400,
      players: 2,
      hotelRequired: true,
      lodgingNights: 1,
      lodgingRooms: 1,
      lodgingRoomType: 'Double',
      lodgingCost: 150,
    },
    { status: 'Booked', total: 300, players: 2, hotelRequired: false },
  ];
  const stay = buildLodging(rows);

  assert.equal(stay.detailed, true);
  assert.equal(stay.parties, 2);
  assert.equal(stay.nightsTotal, 4);
  assert.equal(stay.averageNights, 2);
  assert.equal(stay.roomNights, 7, '3 nights × 2 rooms, plus 1 × 1');
  assert.deepEqual(
    stay.revenueMix.map((r) => [r.key, r.value]),
    [
      ['Golf', 1110],
      ['Lodging', 750],
      ['Resort fees', 40],
    ],
  );
  assert.equal(stay.roomTypes[0].key, 'Twin');
  assert.equal(stay.nightsDistribution.find((b) => b.key === '3 nights').count, 1);
  assert.equal(buildLodging([{ status: 'Booked', hotelRequired: false }]).detailed, false);
});

test('caddie demand reads a field nobody fills in the same way twice', () => {
  assert.equal(classifyCaddie('Caddies for all players'), 'Requested');
  assert.equal(classifyCaddie('No caddies required'), 'Not required');
  assert.equal(classifyCaddie('not required'), 'Not required');
  assert.equal(classifyCaddie(''), 'Not specified');
  assert.equal(classifyCaddie('n/a'), 'Not specified');
  assert.equal(classifyCaddie('No. of caddies: 4'), 'Requested', 'an abbreviation is not a refusal');

  const demand = buildCaddieDemand([
    { players: 4, caddieRequirements: 'Caddies for all players' },
    { players: 2, caddieRequirements: '2 caddies please' },
    { players: 2, caddieRequirements: 'No caddies' },
    { players: 3, caddieRequirements: '' },
  ]);

  assert.equal(demand.requested, 2);
  assert.equal(demand.attachRate, 50);
  assert.equal(demand.estimatedCaddies, 6, 'four for the whole party, plus the two asked for');
  assert.equal(demand.recorded, 3);
});

test('request themes count a booking toward every theme it mentions', () => {
  const themes = buildRequestThemes([
    { specialRequests: 'Birthday trip — please can we have buggies and a table for 8' },
    { specialRequests: '', caddieRequirements: 'Caddies for all' },
    { specialRequests: '   ' },
  ]);

  assert.equal(themes.withRequests, 2);
  assert.equal(themes.rate, 66.7);
  const keys = themes.themes.map((row) => row.key);
  assert.ok(keys.includes('Celebration'));
  assert.ok(keys.includes('Buggy or cart'));
  assert.ok(keys.includes('Dining'));
  assert.ok(keys.includes('Caddies'));
  assert.ok(
    themes.themes.every((row) => row.count > 0),
    'themes nobody mentioned are dropped',
  );
});

test('guests are counted by address, and a business address is told from a personal one', () => {
  const guests = buildGuestMix([
    { guestEmail: 'A@Gmail.com', guestName: 'Ann', players: 2, total: 400, status: 'Booked' },
    { guestEmail: 'a@gmail.com', guestName: 'Ann', players: 2, total: 300, status: 'Inquiry' },
    { guestEmail: 'ops@tourco.com', guestName: 'Tour Co', players: 4, total: 1200, status: 'Booked' },
    { guestEmail: '', players: 2, total: 100, status: 'Inquiry' },
  ]);

  assert.equal(guests.guests, 2, 'the same address in two spellings is one guest');
  assert.equal(guests.anonymous, 1);
  assert.equal(guests.returning, 1);
  assert.equal(guests.repeatRate, 50);
  assert.equal(guests.business, 1, 'gmail is a person, tourco.com is a business');
  assert.equal(guests.top[0].count, 2);
  assert.equal(guests.top[0].revenue, 400, 'the open enquiry is not revenue');
});

test('response time stops at the confirmation, and never runs backwards', () => {
  const times = buildResponseTimes([
    { status: 'Booked', formSubmittedAt: '2026-02-01T09:00:00Z', customerConfirmedAt: '2026-02-01T11:30:00Z' },
    { status: 'Booked', timestamp: '2026-02-01T09:00:00Z', updatedAt: '2026-02-03T09:00:00Z' },
    { status: 'Inquiry', timestamp: '2026-02-01T09:00:00Z', updatedAt: '2026-02-02T09:00:00Z' },
    { status: 'Booked', formSubmittedAt: '2026-02-05T09:00:00Z', customerConfirmedAt: '2026-02-01T09:00:00Z' },
  ]);

  assert.equal(times.answered, 2, 'the open enquiry and the backwards row are not response times');
  assert.equal(times.unanswered, 2);
  assert.equal(times.medianHours, 25.3, 'median of 2.5 and 48 hours');
  assert.equal(times.distribution.find((b) => b.key === '1–4 hours').count, 1);
  assert.equal(times.distribution.find((b) => b.key === '1–3 days').count, 1);
  assert.equal(times.withinDay, 50);
});

test('email coverage does not count a future round as a missed thank you', () => {
  const coverage = buildEmailCoverage(
    [
      {
        status: 'Booked',
        date: '2026-03-01',
        preArrivalEmailSentAt: '2026-02-26T08:00:00Z',
        postPlayEmailSentAt: '2026-03-03T08:00:00Z',
      },
      { status: 'Booked', date: '2026-03-02' },
      { status: 'Booked', date: '2026-12-24' },
      { status: 'Inquiry', date: '2026-03-01' },
    ],
    { today: '2026-03-16' },
  );

  const [pre, post] = coverage.campaigns;
  assert.equal(coverage.tracked, true);
  assert.equal(pre.eligible, 3, 'every committed booking is owed a welcome');
  assert.equal(pre.sent, 1);
  assert.equal(post.eligible, 2, 'the Christmas Eve round has not been played');
  assert.equal(post.rate, 50);
  assert.equal(buildEmailCoverage([{ status: 'Booked', date: '2026-03-01' }], { today: '2026-03-16' }).tracked, false);
});

test('buildAnalytics carries every new section, and survives an empty period', () => {
  const analytics = buildAnalytics(MONEY, { today: '2026-03-01' });
  for (const key of [
    'payments',
    'trade',
    'lodging',
    'caddies',
    'requestThemes',
    'guests',
    'responseTimes',
    'emailCoverage',
  ]) {
    assert.ok(analytics[key] !== undefined, `missing ${key}`);
  }

  const empty = buildAnalytics([]);
  assert.equal(empty.payments.outstanding, 0);
  assert.equal(empty.guests.guests, 0);
  assert.equal(empty.responseTimes.medianHours, null);
  assert.equal(empty.lodging.detailed, false);
  assert.equal(empty.trade.channels[0].count, 0);
});
