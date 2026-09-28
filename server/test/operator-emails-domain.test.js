import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/lib/brand.js';
import {
  OPERATOR_CAMPAIGNS,
  RESEND_GUARD_DAYS,
  buildReminderTemplateData,
  publicReminderConfig,
  readReminderConfig,
  reminderReady,
  selectReminders,
  validateReminder,
} from '../src/lib/operator-emails-domain.js';
import { serialiseOperator } from '../src/lib/operators-domain.js';

const TODAY = '2026-04-01';
const STATUS = OPERATOR_CAMPAIGNS.booking_status;
const PAYMENT = OPERATOR_CAMPAIGNS.payment_due;

const ENV = {
  SENDGRID_API_KEY: 'SG.key',
  FROM_EMAIL: 'bookings@royaldornoch.com',
  SENDGRID_TEMPLATE_OPERATOR_STATUS: 'd-status',
  SENDGRID_TEMPLATE_OPERATOR_PAYMENT: 'd-payment',
};

function operator(overrides = {}) {
  return serialiseOperator({
    id: 1,
    club: 'royal_dornoch',
    name: 'Golfbreaks',
    contact_name: 'Ellie Ross',
    contact_email: 'trade@golfbreaks.com',
    email_domains: ['golfbreaks.com'],
    payment_terms_days: 30,
    deposit_percent: 0,
    credit_limit: null,
    currency: 'GBP',
    on_hold: false,
    active: true,
    ...overrides,
  });
}

function booking(overrides = {}) {
  return {
    bookingId: 'RD-1',
    guestEmail: 'ann@golfbreaks.com',
    guestName: 'Ann McLeod',
    note: '',
    date: '2026-04-10',
    teeTime: '10:04 AM',
    players: 4,
    total: 1000,
    status: 'Booked',
    tourOperatorId: null,
    paymentStatus: 'Unpaid',
    amountPaid: 0,
    invoicedAt: null,
    depositDueDate: null,
    balanceDueDate: null,
    operatorStatusEmailSentAt: null,
    operatorPaymentEmailSentAt: null,
    ...overrides,
  };
}

const opts = (campaign, extra = {}) => ({
  campaign,
  days: campaign.defaultDays,
  today: TODAY,
  ...extra,
});

// --- configuration ----------------------------------------------------------

test('configuration reports exactly what is missing, and never the key itself', () => {
  const full = readReminderConfig(ENV);
  assert.equal(full.configured, true);
  assert.deepEqual(full.missing, []);
  assert.equal(reminderReady(full, 'payment_due'), true);
  assert.equal('apiKey' in publicReminderConfig(full), false);

  const bare = readReminderConfig({});
  assert.deepEqual(bare.missing, [
    'SENDGRID_API_KEY',
    'FROM_EMAIL',
    'SENDGRID_TEMPLATE_OPERATOR_STATUS',
    'SENDGRID_TEMPLATE_OPERATOR_PAYMENT',
  ]);
  assert.equal(reminderReady(bare, 'booking_status'), false);
});

test('reminder windows default to 21 days of tee sheet and 7 days of money', () => {
  const config = readReminderConfig(ENV);
  assert.equal(config.campaigns.booking_status.days, 21);
  assert.equal(config.campaigns.payment_due.days, 7);

  const tuned = readReminderConfig({
    ...ENV,
    OPERATOR_STATUS_REMINDER_DAYS: '30',
    OPERATOR_PAYMENT_REMINDER_DAYS: '0',
  });
  assert.equal(tuned.campaigns.booking_status.days, 30);
  assert.equal(tuned.campaigns.payment_due.days, 0);
});

// --- booking status reminders ----------------------------------------------

test('a status reminder lists what is unconfirmed inside the window, and nothing else', () => {
  const bookings = [
    booking({ bookingId: 'OPEN', status: 'Requested', date: '2026-04-10' }),
    booking({ bookingId: 'ASKD', status: 'Inquiry', date: '2026-04-12' }),
    booking({ bookingId: 'DONE', status: 'Booked', date: '2026-04-11' }),
    booking({ bookingId: 'FAR', status: 'Requested', date: '2026-09-01' }),
    booking({ bookingId: 'PAST', status: 'Requested', date: '2026-03-01' }),
    booking({ bookingId: 'GONE', status: 'Cancelled', date: '2026-04-09' }),
  ];

  const [reminder] = selectReminders([operator()], bookings, opts(STATUS));

  assert.deepEqual(reminder.bookings.map((line) => line.bookingId), ['OPEN', 'ASKD']);
  assert.equal(reminder.bookings[0].reason, 'Awaiting confirmation');
  assert.equal(reminder.bookings[1].reason, 'Awaiting confirmation');
  assert.equal(reminder.bookings[0].daysToPlay, 9);
});

test('an operator with nothing due does not get an empty email', () => {
  const reminders = selectReminders(
    [operator()],
    [booking({ status: 'Booked', date: '2026-04-10' })],
    opts(STATUS),
  );
  assert.deepEqual(reminders, []);
});

// --- payment reminders ------------------------------------------------------

test('a payment reminder takes what is late and what falls due inside the window', () => {
  const bookings = [
    booking({ bookingId: 'LATE', status: 'Booked', balanceDueDate: '2026-01-15' }),
    booking({ bookingId: 'SOON', status: 'Booked', balanceDueDate: '2026-04-05' }),
    booking({ bookingId: 'TODAY', status: 'Booked', balanceDueDate: TODAY }),
    booking({ bookingId: 'LATER', status: 'Booked', balanceDueDate: '2026-06-01' }),
    booking({ bookingId: 'PAID', status: 'Booked', balanceDueDate: '2026-01-15', amountPaid: 1000 }),
    booking({ bookingId: 'ENQ', status: 'Requested', balanceDueDate: '2026-01-15' }),
  ];

  const [reminder] = selectReminders([operator()], bookings, opts(PAYMENT));

  assert.deepEqual(reminder.bookings.map((line) => line.bookingId), ['LATE', 'TODAY', 'SOON']);
  assert.equal(reminder.bookings[0].reason, '76 days overdue');
  assert.equal(reminder.bookings[1].reason, 'Due today');
  assert.equal(reminder.bookings[2].reason, 'Due in 4 days');
  assert.equal(reminder.totalOutstanding, 3000);
  // Due today is due, not late — only the January invoice is overdue.
  assert.equal(reminder.totalOverdue, 1000);
  assert.equal(reminder.maxDaysOverdue, 76);
});

test('the loudest account is listed first: how late, then how much', () => {
  const accounts = [
    operator({ id: 1, name: 'Aaa', email_domains: ['aaa.com'], contact_email: 'a@aaa.com' }),
    operator({ id: 2, name: 'Bbb', email_domains: ['bbb.com'], contact_email: 'b@bbb.com' }),
  ];
  const bookings = [
    booking({ bookingId: 'A', guestEmail: 'x@aaa.com', status: 'Booked', balanceDueDate: '2026-03-30', total: 9000 }),
    booking({ bookingId: 'B', guestEmail: 'x@bbb.com', status: 'Booked', balanceDueDate: '2026-01-01', total: 100 }),
  ];

  const reminders = selectReminders(accounts, bookings, opts(PAYMENT));
  assert.deepEqual(reminders.map((r) => r.operatorName), ['Bbb', 'Aaa']);
});

// --- who is in the list, and who is not -------------------------------------

test('only assignment and a registered domain put a booking on an account', () => {
  const accounts = [operator({ name: 'Links Travel', email_domains: [], contact_email: 'a@links.com' })];
  const bookings = [
    booking({ bookingId: 'PROSE', guestEmail: 'ann@gmail.com', note: 'via Links Travel', status: 'Requested' }),
  ];

  assert.deepEqual(selectReminders(accounts, bookings, opts(STATUS)), []);

  const assigned = [{ ...bookings[0], tourOperatorId: 1 }];
  assert.equal(selectReminders(accounts, assigned, opts(STATUS)).length, 1);
});

test('a retired account is never chased', () => {
  const reminders = selectReminders(
    [operator({ active: false })],
    [booking({ status: 'Requested' })],
    opts(STATUS),
  );
  assert.deepEqual(reminders, []);
});

test('an account with no contact address is listed, but marked unsendable', () => {
  const [reminder] = selectReminders(
    [operator({ contact_email: null })],
    [booking({ status: 'Requested' })],
    opts(STATUS),
  );

  assert.equal(reminder.sendable, false);
  assert.equal(reminder.blocker, 'No contact email on the account');
  assert.match(validateReminder(reminder), /No contact email/);
});

// --- the resend guard -------------------------------------------------------

test('a booking chased this week is not chased again until the guard expires', () => {
  const justChased = booking({
    status: 'Requested',
    operatorStatusEmailSentAt: '2026-03-30T09:00:00.000Z',
  });

  // Nothing fresh on the account, so it drops out of the scheduled run.
  assert.deepEqual(selectReminders([operator()], [justChased], opts(STATUS)), []);

  // …but the deliberate catch-up still offers it, flagged.
  const [caughtUp] = selectReminders([operator()], [justChased], opts(STATUS, { scope: 'all' }));
  assert.equal(caughtUp.bookings[0].recentlyReminded, true);
  assert.equal(caughtUp.freshCount, 0);
});

test('the guard expires, and a new booking pulls the account back in on its own', () => {
  const longAgo = booking({
    bookingId: 'OLD',
    status: 'Requested',
    operatorStatusEmailSentAt: `2026-03-${String(31 - RESEND_GUARD_DAYS).padStart(2, '0')}T09:00:00.000Z`,
  });
  const [expired] = selectReminders([operator()], [longAgo], opts(STATUS));
  assert.equal(expired.bookings[0].recentlyReminded, false);

  const mixed = [
    booking({ bookingId: 'CHASED', status: 'Requested', operatorStatusEmailSentAt: '2026-03-30T09:00:00.000Z' }),
    booking({ bookingId: 'NEW', status: 'Requested' }),
  ];
  const [reminder] = selectReminders([operator()], mixed, opts(STATUS));
  assert.equal(reminder.bookings.length, 2);
  assert.equal(reminder.freshCount, 1);
});

// --- the email itself -------------------------------------------------------

test('the template data carries the account, the totals and every line twice', () => {
  const [reminder] = selectReminders(
    [operator({ credit_limit: 5000, balance_due_days_before_play: 14 })],
    [
      booking({ bookingId: 'RD-1', status: 'Booked', balanceDueDate: '2026-03-01' }),
      booking({ bookingId: 'RD-2', status: 'Booked', balanceDueDate: '2026-04-03', total: 500 }),
    ],
    opts(PAYMENT),
  );

  const data = buildReminderTemplateData(reminder, {
    campaign: PAYMENT,
    fromEmail: 'bookings@royaldornoch.com',
    days: 7,
    today: TODAY,
  });

  assert.equal(data.operator_name, 'Golfbreaks');
  assert.equal(data.contact_name, 'Ellie Ross');
  assert.equal(data.account_reference, 'OP-1');
  assert.equal(data.booking_count, '2');
  assert.equal(data.player_count, '8');
  assert.equal(data.total_outstanding, '€1,500.00');
  assert.equal(data.has_overdue, true);
  assert.equal(data.days_overdue, '31');
  assert.equal(data.credit_limit, '€5,000.00');
  assert.equal(data.club_name, BRAND.fullName, 'the club this install is branded as');
  assert.match(data.credit_terms, /Balance due 14 days before play/);

  // The array a handlebars {{#each}} walks…
  assert.equal(data.bookings.length, 2);
  assert.equal(data.bookings[0].booking_reference, 'RD-1');
  assert.equal(data.bookings[0].booking_date, 'Friday 10 April 2026');
  assert.equal(data.bookings[0].outstanding, '€1,000.00');
  assert.equal(data.bookings[0].note, '31 days overdue');

  // …and the same content as a preformatted block, for a plain-text part.
  assert.equal(data.booking_lines.split('\n').length, 2);
  assert.match(data.booking_lines, /RD-1 · Friday 10 April 2026 10:04 AM · 4 players · €1,000.00 outstanding · 31 days overdue/);
});

test('a deposit still outstanding is chased on the deposit date, not the balance date', () => {
  const account = operator({ deposit_percent: 25, deposit_due_days_before_play: 60 });
  const unpaid = booking({ status: 'Booked', date: '2026-04-10', balanceDueDate: '2026-04-03' });

  // The balance date is inside the window, but the money is still sitting at
  // the deposit — which was due on 9 February and is 51 days late.
  const [reminder] = selectReminders([account], [unpaid], opts(PAYMENT));
  assert.equal(reminder.bookings[0].reason, '51 days overdue');
  assert.equal(reminder.bookings[0].dueDate, '2026-02-09');

  // Once the deposit is in, the balance date is what is chased.
  const settled = [{ ...unpaid, amountPaid: 250, paymentStatus: 'Deposit paid' }];
  const [next] = selectReminders([account], settled, opts(PAYMENT));
  assert.equal(next.bookings[0].dueDate, '2026-04-03');
  assert.equal(next.bookings[0].reason, 'Due in 2 days');
  assert.equal(next.bookings[0].outstanding, 750);
});

test('a status reminder writes the stage, not the money, on each line', () => {
  const [reminder] = selectReminders(
    [operator()],
    [booking({ bookingId: 'RD-9', status: 'Requested' })],
    opts(STATUS),
  );
  const data = buildReminderTemplateData(reminder, { campaign: STATUS, days: 21, today: TODAY });

  assert.match(data.booking_lines, /RD-9 · Friday 10 April 2026 10:04 AM · 4 players · Requested · Awaiting confirmation/);
  assert.equal(data.campaign, 'booking_status');
  assert.equal(data.reminder_date, 'Wednesday 01 April 2026');
});
