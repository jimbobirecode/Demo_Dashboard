import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGNS,
  addDays,
  buildTemplateData,
  campaignReady,
  cleanEmail,
  publicEmailConfig,
  readEmailConfig,
  selectCandidates,
  countAwaitingPayment,
  targetDate,
  todayInClubZone,
  validateRecipient,
} from '../src/lib/email-domain.js';
import { sendTemplateEmail } from '../src/lib/sendgrid.js';

const ENV = {
  SENDGRID_API_KEY: 'SG.key',
  FROM_EMAIL: 'bookings@royaldornoch.com',
  SENDGRID_TEMPLATE_PRE_ARRIVAL: 'd-pre',
  SENDGRID_TEMPLATE_POST_PLAY: 'd-post',
};

function booking(overrides = {}) {
  return {
    bookingId: 'RD-1',
    guestEmail: 'ann.mcleod@example.com',
    guestName: 'Ann McLeod',
    date: '2026-03-18',
    teeTime: '10:04 AM',
    players: 4,
    total: 1292,
    status: 'Booked',
    paymentStatus: 'Paid',
    prePlayClockStartedAt: '2026-03-01T10:00:00.000Z',
    golfCourses: '',
    hotelRequired: false,
    hotelCheckin: null,
    hotelCheckout: null,
    lodgingNights: null,
    lodgingRooms: null,
    lodgingRoomType: '',
    lodgingCost: null,
    preArrivalEmailSentAt: null,
    postPlayEmailSentAt: null,
    ...overrides,
  };
}

test('configuration reports exactly what is missing, and never the key itself', () => {
  const full = readEmailConfig(ENV);
  assert.equal(full.configured, true);
  assert.deepEqual(full.missing, []);
  assert.equal(campaignReady(full, 'pre_arrival'), true);

  const partial = readEmailConfig({ FROM_EMAIL: ENV.FROM_EMAIL, SENDGRID_TEMPLATE_PRE_ARRIVAL: 'd-pre' });
  assert.deepEqual(partial.missing, ['SENDGRID_API_KEY', 'SENDGRID_TEMPLATE_POST_PLAY']);
  assert.equal(campaignReady(partial, 'pre_arrival'), false, 'no API key, so nothing can send');

  assert.equal('apiKey' in publicEmailConfig(full), false, 'the key must not cross the wire');
  assert.equal(publicEmailConfig(full).hasApiKey, true);
});

test('campaign timing follows the environment, defaulting to 3 days before and 2 after', () => {
  const config = readEmailConfig(ENV);
  assert.equal(config.campaigns.pre_arrival.days, 3);
  assert.equal(config.campaigns.post_play.days, 2);

  assert.equal(targetDate(CAMPAIGNS.pre_arrival, 3, '2026-03-15'), '2026-03-18');
  assert.equal(targetDate(CAMPAIGNS.post_play, 2, '2026-03-20'), '2026-03-18');

  const tuned = readEmailConfig({ ...ENV, PRE_ARRIVAL_DAYS: '7' });
  assert.equal(tuned.campaigns.pre_arrival.days, 7);
  assert.equal(readEmailConfig({ ...ENV, PRE_ARRIVAL_DAYS: 'soon' }).campaigns.pre_arrival.days, 3);
});

test('a welcome falls due days before play and stays due until play', () => {
  const bookings = [
    booking({ bookingId: 'RD-DUE', date: '2026-03-18' }),
    booking({ bookingId: 'RD-MISSED', date: '2026-03-17', prePlayClockStartedAt: '2026-03-16T09:00:00Z' }),
    booking({ bookingId: 'RD-TODAY', date: '2026-03-15' }),
    booking({ bookingId: 'RD-LATE', date: '2026-03-19' }),
    booking({ bookingId: 'RD-PLAYED', date: '2026-03-14' }),
  ];

  const due = selectCandidates(bookings, {
    campaign: CAMPAIGNS.pre_arrival,
    days: 3,
    today: '2026-03-15',
  });

  assert.deepEqual(
    due.map((b) => b.bookingId),
    ['RD-TODAY', 'RD-MISSED', 'RD-DUE'],
  );
});

test('a thank you is due on the single play date the campaign targets', () => {
  const bookings = [
    booking({ bookingId: 'RD-DUE', date: '2026-03-13' }),
    booking({ bookingId: 'RD-EARLIER', date: '2026-03-12' }),
    booking({ bookingId: 'RD-LATER', date: '2026-03-14' }),
  ];
  const due = selectCandidates(bookings, { campaign: CAMPAIGNS.post_play, days: 2, today: '2026-03-15' });
  assert.deepEqual(
    due.map((b) => b.bookingId),
    ['RD-DUE'],
  );
});

test('payment starts the pre-play clock; an unpaid booking is not welcomed', () => {
  const bookings = [
    booking({ bookingId: 'RD-PAID' }),
    booking({ bookingId: 'RD-DEPOSIT', paymentStatus: 'Deposit paid', prePlayClockStartedAt: null }),
    booking({ bookingId: 'RD-UNPAID', paymentStatus: 'Unpaid', prePlayClockStartedAt: null }),
    booking({ bookingId: 'RD-PENDING', paymentStatus: 'Pending', prePlayClockStartedAt: null }),
  ];
  const options = { campaign: CAMPAIGNS.pre_arrival, days: 3, today: '2026-03-15' };

  const due = selectCandidates(bookings, options);
  assert.deepEqual(due.map((b) => b.bookingId).sort(), ['RD-DEPOSIT', 'RD-PAID']);
  assert.equal(due.find((b) => b.bookingId === 'RD-PAID').clockStartedAt, '2026-03-01T10:00:00.000Z');
  assert.equal(countAwaitingPayment(bookings, options), 2);

  const ungated = selectCandidates(bookings, { ...options, requirePayment: false });
  assert.equal(ungated.length, 4, 'PRE_ARRIVAL_REQUIRES_PAYMENT=false restores the old list');
  assert.equal(countAwaitingPayment(bookings, { ...options, requirePayment: false }), 0);

  const thanks = selectCandidates(
    [booking({ date: '2026-03-13', paymentStatus: 'Unpaid', prePlayClockStartedAt: null })],
    { campaign: CAMPAIGNS.post_play, days: 2, today: '2026-03-15' },
  );
  assert.equal(thanks.length, 1, 'the thank you is not gated on payment');
});

test('requiring payment is on unless switched off', () => {
  assert.equal(readEmailConfig(ENV).requirePayment, true);
  assert.equal(readEmailConfig({ ...ENV, PRE_ARRIVAL_REQUIRES_PAYMENT: 'false' }).requirePayment, false);
  assert.equal(readEmailConfig({ ...ENV, PRE_ARRIVAL_REQUIRES_PAYMENT: 'true' }).requirePayment, true);
});

test('only committed bookings are ever emailed', () => {
  const bookings = [
    booking({ bookingId: 'RD-C', status: 'Booked' }),
    booking({ bookingId: 'RD-B', status: 'Booked' }),
    booking({ bookingId: 'RD-I', status: 'Inquiry' }),
    booking({ bookingId: 'RD-X', status: 'Cancelled' }),
    booking({ bookingId: 'RD-NODATE', date: null }),
  ];

  const due = selectCandidates(bookings, {
    campaign: CAMPAIGNS.pre_arrival,
    days: 3,
    today: '2026-03-15',
  });

  assert.deepEqual(due.map((b) => b.bookingId).sort(), ['RD-B', 'RD-C']);
});

test('the catch-up window looks forward for welcomes and back for thank yous', () => {
  const today = '2026-03-18';
  const bookings = [
    booking({ bookingId: 'RD-PAST', date: '2026-03-10' }),
    booking({ bookingId: 'RD-TODAY', date: today }),
    booking({ bookingId: 'RD-SOON', date: '2026-04-01' }),
    booking({ bookingId: 'RD-ANCIENT', date: '2026-01-01' }),
  ];

  const welcomes = selectCandidates(bookings, {
    campaign: CAMPAIGNS.pre_arrival,
    days: 3,
    today,
    scope: 'all',
  });
  assert.deepEqual(
    welcomes.map((b) => b.bookingId),
    ['RD-TODAY', 'RD-SOON'],
    'earliest first',
  );

  const thanks = selectCandidates(bookings, {
    campaign: CAMPAIGNS.post_play,
    days: 2,
    today,
    scope: 'all',
  });
  assert.deepEqual(
    thanks.map((b) => b.bookingId),
    ['RD-TODAY', 'RD-PAST'],
    'most recent first, and nothing older than 30 days',
  );
});

test('an already-emailed booking stays listed, carrying when it was sent', () => {
  const [candidate] = selectCandidates([booking({ preArrivalEmailSentAt: '2026-03-15T09:00:00.000Z' })], {
    campaign: CAMPAIGNS.pre_arrival,
    days: 3,
    today: '2026-03-15',
  });

  assert.equal(candidate.sentAt, '2026-03-15T09:00:00.000Z');
});

test('template data matches the field names the SendGrid templates use', () => {
  const data = buildTemplateData(booking({ hotelRequired: true, hotelCheckin: '2026-03-17', lodgingNights: 2 }), {
    fromEmail: ENV.FROM_EMAIL,
    now: new Date('2026-01-01T00:00:00Z'),
  });

  assert.equal(data.guest_name, 'Ann McLeod');
  assert.equal(data.booking_date, 'Wednesday 18 March 2026');
  assert.equal(data.course_name, 'Championship Course', 'falls back to the club default');
  assert.equal(data.tee_time, '10:04 AM');
  assert.equal(data.player_count, '4');
  assert.equal(data.booking_reference, 'RD-1');
  assert.equal(data.current_year, '2026');
  assert.match(data.total, /^€1,292/, 'money is spelled in the club currency');
  assert.equal(data.hotel_required, 'Yes');
  assert.equal(data.hotel_checkin, 'Tuesday 17 March 2026');
  assert.equal(data.lodging_nights, '2');

  // The Streamlit-era templates read these spellings; both sets ship.
  assert.equal(data.play_date, data.booking_date);
  assert.equal(data.booking_ref, data.booking_reference);
  assert.equal(data.players, data.player_count);
});

test('a missing guest name is derived from the address', () => {
  const data = buildTemplateData(booking({ guestName: '' }), { fromEmail: ENV.FROM_EMAIL });
  assert.equal(data.guest_name, 'Ann Mcleod');
});

test('scraped addresses are cleaned, and unusable ones rejected', () => {
  assert.equal(cleanEmail('mailto:ann@example.com'), 'ann@example.com');
  assert.equal(cleanEmail(' <ann@example.com> '), 'ann@example.com');
  assert.equal(cleanEmail('not an address'), null);
  assert.equal(cleanEmail(''), null);

  assert.equal(validateRecipient(booking()), null);
  assert.equal(validateRecipient(booking({ guestEmail: 'nope' })), 'No guest email address');
  assert.equal(validateRecipient(booking({ date: null })), 'No play date');
});

test('date helpers work in the club time zone', () => {
  assert.equal(addDays('2026-03-18', 3), '2026-03-21');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.match(todayInClubZone(new Date('2026-06-30T23:30:00Z')), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(
    todayInClubZone(new Date('2026-06-30T23:30:00Z')),
    '2026-07-01',
    'British Summer Time is an hour ahead of UTC',
  );
});

test('a SendGrid rejection is reported, not thrown', async () => {
  const fetchImpl = async () => ({
    status: 403,
    json: async () => ({ errors: [{ message: 'The from address does not match a verified Sender Identity.' }] }),
  });

  const outcome = await sendTemplateEmail({
    apiKey: 'SG.key',
    fromEmail: 'nope@example.com',
    fromName: 'Royal Dornoch Golf Club',
    toEmail: 'ann@example.com',
    templateId: 'd-pre',
    data: {},
    fetchImpl,
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /verified Sender Identity/);
});

test('a successful send posts the template and the one recipient', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, body: JSON.parse(options.body), headers: options.headers };
    return { status: 202, json: async () => ({}) };
  };

  const outcome = await sendTemplateEmail({
    apiKey: 'SG.key',
    fromEmail: ENV.FROM_EMAIL,
    fromName: 'Royal Dornoch Golf Club',
    toEmail: 'ann@example.com',
    templateId: 'd-pre',
    data: { guest_name: 'Ann' },
    fetchImpl,
  });

  assert.equal(outcome.ok, true);
  assert.equal(request.headers.Authorization, 'Bearer SG.key');
  assert.equal(request.body.template_id, 'd-pre');
  assert.deepEqual(request.body.personalizations[0].to, [{ email: 'ann@example.com' }]);
  assert.equal(request.body.personalizations[0].dynamic_template_data.guest_name, 'Ann');
});
