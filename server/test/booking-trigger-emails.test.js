import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCHEDULE, STEP_IDS, getStep, planBooking } from '../src/lib/booking-triggers-domain.js';
import { buildTriggerEmail, buildTriggerTemplateData, hasBuiltInEmail } from '../src/lib/booking-trigger-emails.js';
import { paymentState } from '../src/lib/operators-domain.js';

const TRACKED = { tracked: true, from: null };

function booking(overrides = {}) {
  return {
    bookingId: 'CL-204',
    club: 'teemail',
    guestEmail: 'ann.burke@example.com',
    guestName: 'Ann Burke',
    date: '2026-12-01',
    teeTime: '10:20',
    players: 4,
    total: 1200,
    amountPaid: 360,
    paymentStatus: 'Deposit paid',
    status: 'Booked',
    bookedAt: '2026-10-20T09:00:00.000Z',
    timestamp: '2026-10-20T09:00:00.000Z',
    golfCourses: 'Championship Course',
    hotelRequired: false,
    caddieRequirements: '2 caddies',
    specialRequests: '',
    ...overrides,
  };
}

/** The rendered email for one step of one booking, as a run would render it. */
function render(stepId, row = booking(), { today = '2026-10-25', paymentUrl = null } = {}) {
  const step = getStep(stepId);
  const plan = planBooking(row, { today, tracking: TRACKED });
  const data = buildTriggerTemplateData(plan, step, row, {
    fromEmail: 'golf@teemail.io',
    schedule: DEFAULT_SCHEDULE,
    today,
    paymentUrl,
  });
  return { data, email: buildTriggerEmail(stepId, data) };
}

test('every step of the ladder has an email written for it', () => {
  for (const id of STEP_IDS) {
    assert.ok(hasBuiltInEmail(id), id);
    const { email } = render(id, booking(), { paymentUrl: 'https://pay.stripe.com/x' });
    assert.ok(email.subject, `${id} has a subject`);
    assert.ok(email.text.trim(), `${id} has a plain-text part`);
    assert.match(email.html, /<\/html>$/, `${id} renders a whole document`);
    assert.ok(email.text.includes('TeeMail Golf Club'), `${id} is signed by the club`);
  }
});

test('an unknown step is a programming mistake, not a blank email', () => {
  assert.throws(() => buildTriggerEmail('not_a_step', {}), /No email is written/);
});

test('the chase emails say what is owed, by when, and how to pay it', () => {
  const { email } = render('deposit_overdue', booking({ amountPaid: 0, paymentStatus: 'Unpaid' }), {
    paymentUrl: 'https://pay.stripe.com/test',
  });
  assert.match(email.subject, /due to be cancelled/);
  assert.ok(email.text.includes('€1,200.00'), 'the figure outstanding');
  assert.ok(email.text.includes('https://pay.stripe.com/test'), 'the link, in the plain-text part too');
  assert.ok(email.html.includes('https://pay.stripe.com/test'));
  assert.match(email.text, /7-day window/, 'the club’s own deadline, not a hard-coded one');
  assert.match(email.text, /next 3 days/, 'and the grace period it still has');
});

test('a chase with no link to pay asks them to reply instead of showing a dead button', () => {
  const { email } = render('deposit_reminder', booking({ amountPaid: 0, paymentStatus: 'Unpaid' }));
  assert.ok(!email.html.includes('href="https://pay.stripe.com'), 'no button');
  assert.match(email.text, /secure payment link/);
  assert.match(email.html, /secure payment link/);
});

test('the deadlines in the copy follow the configured schedule', () => {
  const step = getStep('deposit_overdue');
  const row = booking({ amountPaid: 0, paymentStatus: 'Unpaid' });
  const plan = planBooking(row, { today: '2026-10-25', tracking: TRACKED });
  const data = buildTriggerTemplateData(plan, step, row, {
    schedule: { ...DEFAULT_SCHEDULE, depositDays: 14, depositGraceDays: 5 },
  });
  const email = buildTriggerEmail('deposit_overdue', data);
  assert.match(email.text, /14-day window/);
  assert.match(email.text, /next 5 days/);
});

test('the receipt says what is left to pay, or that nothing is', () => {
  const part = render('deposit_receipt').email;
  assert.ok(part.text.includes('€840.00'), 'the balance remaining');
  assert.match(part.text, /balance is payable no later than 60 days before play/);

  const full = render('deposit_receipt', booking({ amountPaid: 1200, paymentStatus: 'Paid' })).email;
  assert.match(full.text, /paid in full and confirmed/);
  assert.equal(full.text.includes('Balance remaining'), false);
});

test('the arrival emails carry what the guest asked for and the stay they booked', () => {
  const row = booking({
    amountPaid: 1200,
    paymentStatus: 'Paid',
    hotelRequired: true,
    lodgingRooms: 2,
    lodgingNights: 3,
    hotelCheckin: '2026-11-30',
    hotelCheckout: '2026-12-03',
    specialRequests: 'One vegetarian',
  });
  const { email } = render('final_details', row, { today: '2026-11-21' });
  assert.match(email.text, /2 room\(s\), 3 night\(s\)/);
  assert.match(email.text, /Monday 30 November 2026/);
  assert.match(email.text, /One vegetarian/);
  assert.match(email.text, /2 caddies/);
  assert.match(email.text, /45 minutes before your tee time/);
});

test('a booking with no accommodation does not show an empty stay', () => {
  const { email } = render('final_details', booking({ amountPaid: 1200, paymentStatus: 'Paid' }));
  assert.equal(email.text.includes('Check in'), false);
  assert.equal(email.text.includes('Accommodation'), false);
});

test('the cancellation email does not ask for money it is no longer owed', () => {
  const { email } = render('deposit_lapsed', booking({ amountPaid: 0, paymentStatus: 'Unpaid' }));
  assert.match(email.subject, /has been cancelled/);
  assert.equal(email.text.includes('Pay securely online'), false);
  assert.equal(email.text.includes('Amount due'), false);
});

test('the merge fields a SendGrid template would use carry the same figures', () => {
  const { data } = render('balance_notice');
  assert.equal(data.booking_reference, 'CL-204');
  assert.equal(data.play_date, 'Tuesday 01 December 2026');
  assert.equal(data.amount_outstanding, '€840.00');
  assert.equal(data.booking_total, '€1,200.00');
  assert.equal(data.tee_time, '10:20');
  assert.equal(data.course_name, 'Championship Course');
  assert.equal(data.step, 'balance_notice');
  assert.equal(data.trigger_label, 'Trigger 2');
  assert.equal(data.balance_deadline_days, '60');
});

test('a booking with no course named falls back to the club’s own', () => {
  const { data } = render('final_details', booking({ golfCourses: '', amountPaid: 1200, paymentStatus: 'Paid' }));
  assert.equal(data.course_name, 'Championship Course');
});

test('a guest with no name is greeted without one rather than with a blank', () => {
  const { email } = render('post_play', booking({ guestName: '' }));
  assert.match(email.text, /^Hi there,/);
});

test('the figures are emphasised in HTML and plain in the text part', () => {
  const { email } = render('balance_rescue_24h');
  assert.ok(email.html.includes('<strong>€840.00</strong>'));
  assert.equal(email.text.includes('<strong>'), false);
});

// --- the trade-account voice -------------------------------------------------

const CARR = {
  id: 3,
  name: 'Carr Golf',
  contactName: 'Mairéad Byrne',
  contactEmail: 'accounts@carrgolf.test',
  depositDueDaysBeforePlay: null,
  balanceDueDaysBeforePlay: 45,
  active: true,
  autoChase: true,
};

/** Rendered as a run would render it for a trade booking: to the account. */
function renderForAccount(stepId, row = booking({ tourOperatorId: 3 }), { operator = CARR, toEmail } = {}) {
  const step = getStep(stepId);
  const plan = planBooking(row, { today: '2026-10-25', tracking: TRACKED, operator, source: 'assignment' });
  const data = buildTriggerTemplateData(plan, step, row, {
    fromEmail: 'golf@teemail.io',
    schedule: DEFAULT_SCHEDULE,
    today: '2026-10-25',
    paymentUrl: 'https://pay.stripe.com/test',
    operator,
    toEmail: toEmail ?? operator.contactEmail,
  });
  return { data, email: buildTriggerEmail(stepId, data) };
}

test('every payment step is written a second time, to the account that pays', () => {
  const payment = STEP_IDS.filter((id) => getStep(id).group === 'payment');
  assert.equal(payment.length, 12);
  for (const id of payment) {
    const { data, email } = renderForAccount(id);
    assert.equal(data.audience, 'operator', id);
    assert.match(email.text, /^Dear Mairéad,/, `${id} is addressed to the contact`);
    assert.match(email.text, /Ann Burke/, `${id} names the guest`);
    assert.match(email.text, /Account: Carr Golf/, `${id} names the account`);
    assert.doesNotMatch(email.text, /your tee time|Hi Ann/, `${id} does not talk to the account as a guest`);
    assert.doesNotMatch(email.text, /Need to change or cancel/, `${id} carries no manage-booking link`);
  }
});

test("the trade voice quotes the account's own due date, not the club's default window", () => {
  // Balance due 45 days before 2026-12-01: 2026-10-17.
  const { data, email } = renderForAccount('balance_notice');
  assert.equal(data.balance_due_date, 'Saturday 17 October 2026');
  assert.match(email.subject, /Balance due Saturday 17 October 2026/);
  assert.match(email.text, /payable by Saturday 17 October 2026/);
  assert.doesNotMatch(email.text, /60 days before/);
});

test('the receipt to an account states the balance and its date as terms', () => {
  const { email } = renderForAccount('deposit_receipt');
  assert.match(email.text, /received €360.00 against the booking below for Ann Burke/);
  assert.match(email.text, /balance of €840.00 is payable by Saturday 17 October 2026/);
  assert.match(email.text, /The guest will receive the confirmation/);
});

test('the communication steps go to the guest in one voice, whoever pays', () => {
  for (const id of ['booking_confirmed', 'pre_arrival_confirmation', 'final_details', 'post_play']) {
    const row = booking({ tourOperatorId: 3, amountPaid: 1200, paymentStatus: 'Paid' });
    const { data, email } = renderForAccount(id, row, { toEmail: row.guestEmail });
    assert.equal(data.audience, 'guest', id);
    assert.match(email.text, /^Hi Ann,/, id);
  }
});

test('an account with no contact email is written to as a guest, because the guest is who gets it', () => {
  const quiet = { ...CARR, contactEmail: '', contactName: '' };
  const { data, email } = renderForAccount('deposit_request', booking({ tourOperatorId: 3 }), {
    operator: quiet,
    toEmail: 'ann.burke@example.com',
  });
  assert.equal(data.audience, 'guest');
  assert.match(email.text, /^Hi Ann,/);
  assert.match(email.text, /Thank you for booking with/);
});

test('an account with no named contact is addressed by its name', () => {
  const { data } = renderForAccount('deposit_reminder', booking({ tourOperatorId: 3 }), {
    operator: { ...CARR, contactName: '' },
  });
  assert.equal(data.salutation, 'Dear Carr Golf,');
});

/**
 * A trade account holds a round on a percentage, and the rest falls due before
 * they travel. The chase emails were asking for the whole round from the first
 * rung: Carr Golf's EUR 3,080 booking got "a deposit of EUR 3,080 is payable",
 * while the Stripe link beside it was correctly made out for EUR 924. The
 * sentence and the button have to be the same figure.
 */
const ON_THIRTY = {
  id: 7,
  name: 'Carr Golf',
  contactEmail: 'accounts@carrgolf.com',
  depositPercent: 30,
  balanceDueDaysBeforePlay: 60,
  paymentTermsDays: 30,
  active: true,
};

/** As `render`, with the booking on a trade account. */
function renderForOperator(stepId, row, { today = '2026-10-25', paymentUrl = null, operator = ON_THIRTY } = {}) {
  const step = getStep(stepId);
  const plan = planBooking(row, { today, tracking: TRACKED, operator });
  const data = buildTriggerTemplateData(plan, step, row, {
    fromEmail: 'golf@teemail.io',
    schedule: DEFAULT_SCHEDULE,
    today,
    paymentUrl,
    operator,
  });
  return { data, plan, email: buildTriggerEmail(stepId, data) };
}

const unpaid = booking({ total: 3080, amountPaid: 0, paymentStatus: 'Unpaid', date: '2027-09-25' });

test('a deposit chase asks for the deposit, not the whole round', () => {
  for (const stepId of [
    'deposit_request',
    'deposit_reminder',
    'deposit_final_notice',
    'deposit_overdue',
    'deposit_rescue_48h',
    'deposit_rescue_24h',
  ]) {
    const { data, email } = renderForOperator(stepId, unpaid, { paymentUrl: 'https://pay.stripe.com/x' });
    assert.equal(data.amount_due, '€924.00', `${stepId} asks for 30%`);
    assert.equal(data.due_raw, 924, `${stepId} carries the figure the Stripe link is made out for`);
    assert.ok(email.text.includes('€924.00'), `${stepId} says it in the email`);
    assert.ok(
      !email.text.includes('€3,080.00 is payable') && !email.text.includes('payment of €3,080.00'),
      `${stepId} does not demand the whole round`,
    );
    // The round's value is still on the email, as the total the deposit is
    // part of -- it is the demand that was wrong, not the information.
    assert.ok(email.text.includes('€3,080.00'), `${stepId} still shows the booking total`);
    assert.ok(email.html.includes('Pay €924.00'), `${stepId}'s button matches its sentence`);
  }
});

test('the first ask shows its working, so the account can check the percentage', () => {
  const { email } = renderForOperator('deposit_request', unpaid, { paymentUrl: 'https://pay.stripe.com/x' });
  assert.match(email.text, /deposit of €924\.00 \(30% of €3,080\.00\)/);
});

test('once the deposit is in, the balance chase asks for what is left', () => {
  const paidDeposit = booking({
    total: 3080,
    amountPaid: 924,
    paymentStatus: 'Deposit paid',
    date: '2027-09-25',
  });
  const { data, email } = renderForOperator('balance_rescue_48h', paidDeposit);
  assert.equal(data.amount_due, '€2,156.00');
  assert.ok(email.text.includes('€2,156.00'));
});

test('a direct guest has one milestone, and is asked for all of it', () => {
  // No operator, so no deposit percentage: nothing about this changed.
  const { data } = render('deposit_request', booking({ total: 1200, amountPaid: 0, paymentStatus: 'Unpaid' }));
  assert.equal(data.amount_due, '€1,200.00');
  assert.equal(data.amount_due, data.amount_outstanding);
  assert.equal(data.deposit_of_total, '', 'nothing to show the working of');
});

/**
 * The whole ladder for one real trade booking, rung by rung.
 *
 * Carr Golf's BOOK-20261019-2EDF663B as the club actually holds it: EUR 4,620
 * over twelve players, taken on 19 October 2026 for 23 September 2027, on a
 * 30% deposit with net-7 terms and the balance 60 days before play.
 *
 * Every money rung has to ask for the deposit, every date has to be the one
 * the payment columns show, and every money email has to go to the account
 * while the round-up to the tee goes to the booker. This is the audit that
 * was not there when the deposit emails started asking for the whole round.
 */
const CARR_TERMS = {
  id: 9,
  name: 'Carr Golf',
  contactName: 'Tom Geraghty',
  contactEmail: 'alison@carrgolf.com',
  depositPercent: 30,
  paymentTermsDays: 7,
  balanceDueDaysBeforePlay: 60,
  depositDueDaysBeforePlay: null,
  active: true,
  autoChase: true,
};

const CARR_BOOKING = {
  bookingId: 'BOOK-20261019-2EDF663B',
  club: 'teemail',
  guestEmail: 'timmy.kenna@carrgolf.com',
  guestName: 'Brian McNulty',
  date: '2027-09-23',
  teeTime: '10:20',
  players: 12,
  total: 4620,
  amountPaid: 0,
  paymentStatus: 'Unpaid',
  status: 'Booked',
  bookedAt: '2026-10-19T09:00:00.000Z',
  timestamp: '2026-10-19T09:00:00.000Z',
  golfCourses: 'Championship Course',
};

test('the whole ladder, rung by rung, for a booking on 30% terms', () => {
  const plan = planBooking(CARR_BOOKING, { today: '2026-10-20', tracking: TRACKED, operator: CARR_TERMS });
  const rung = (id) => plan.steps.find((entry) => entry.step === id);

  // The deposit ladder, dated from the account's net-7 terms: taken on the
  // 19th, due on the 26th, released three days after that.
  assert.equal(rung('deposit_request').dueOn, '2026-10-19', 'asked for on the day it was taken');
  assert.equal(rung('deposit_reminder').dueOn, '2026-10-24');
  assert.equal(rung('deposit_final_notice').dueOn, '2026-10-25');
  assert.equal(rung('deposit_overdue').dueOn, '2026-10-26', 'the deadline the payment columns show');
  assert.equal(rung('deposit_rescue_48h').dueOn, '2026-10-27');
  assert.equal(rung('deposit_rescue_24h').dueOn, '2026-10-28');
  assert.equal(rung('deposit_lapsed').dueOn, '2026-10-29');

  // The balance ladder, 60 days before play.
  assert.equal(rung('balance_lapsed').dueOn, '2027-07-25');
  assert.equal(rung('balance_rescue_24h').dueOn, '2027-07-24');
  assert.equal(rung('balance_rescue_48h').dueOn, '2027-07-23');
  assert.equal(rung('balance_notice').dueOn, '2027-07-15', 'ten days ahead of the deadline');

  // Money to the account; the round-up to the tee to whoever booked it.
  for (const id of ['deposit_request', 'deposit_overdue', 'balance_notice']) {
    assert.equal(rung(id).to, 'alison@carrgolf.com', `${id} goes to the account`);
  }
  for (const id of ['pre_arrival_confirmation', 'final_details', 'post_play']) {
    assert.equal(rung(id).to, 'timmy.kenna@carrgolf.com', `${id} goes to the booker`);
  }

  // And the money, which is the thing that was wrong.
  assert.equal(plan.money.depositAmount, 1386);
  assert.equal(plan.money.balanceAmount, 3234);
  assert.equal(plan.money.dueAmount, 1386, '30% of 4,620, and nothing of the balance yet');
  assert.equal(plan.money.outstanding, 4620);
});

test('no money rung ever quotes more than the booking owes at that moment', () => {
  // The whole class of the bug, rather than the one email it was found in:
  // whatever the step and whatever has been paid, the figure in the email is
  // the figure the ledger says is due now.
  for (const paid of [0, 500, 1386, 2000, 4620]) {
    const row = { ...CARR_BOOKING, amountPaid: paid, paymentStatus: paid === 0 ? 'Unpaid' : 'Deposit paid' };
    const plan = planBooking(row, { today: '2026-10-20', tracking: TRACKED, operator: CARR_TERMS });
    const ledger = paymentState(row, CARR_TERMS, { today: '2026-10-20' });

    for (const entry of plan.steps) {
      const step = getStep(entry.step);
      if (step.group !== 'payment') continue;
      const data = buildTriggerTemplateData(plan, step, row, {
        fromEmail: 'golf@teemail.io',
        money: plan.money,
        schedule: DEFAULT_SCHEDULE,
        today: '2026-10-20',
        operator: CARR_TERMS,
        toEmail: entry.to,
      });
      assert.equal(
        data.due_raw,
        ledger.dueAmount,
        `${entry.step} with ${paid} paid: the email and the ledger must agree`,
      );
      assert.ok(data.due_raw <= plan.money.outstanding + 0.005, `${entry.step} never asks for more than is owed`);
    }
  }
});

test('a booking whose deposit is marked paid is not chased for a deposit', () => {
  // 8 x EUR 97.50 against a round the account's 30% makes EUR 924 of: the
  // club took its deposit in full and somebody recorded it. Chasing the
  // EUR 144 difference is the dashboard arguing with the people who can see
  // the invoice.
  const row = { ...CARR_BOOKING, total: 3080, players: 8, amountPaid: 780, paymentStatus: 'Deposit paid' };
  const plan = planBooking(row, { today: '2026-10-30', tracking: TRACKED, operator: CARR_TERMS });

  for (const id of [
    'deposit_request',
    'deposit_reminder',
    'deposit_final_notice',
    'deposit_overdue',
    'deposit_rescue_48h',
    'deposit_rescue_24h',
    'deposit_lapsed',
  ]) {
    const entry = plan.steps.find((line) => line.step === id);
    assert.equal(entry.state, 'skipped', `${id} is not this booking's rung`);
  }
  assert.equal(plan.money.stage, 'balance');
  assert.equal(plan.money.dueAmount, 2300, 'the balance, when it falls due -- not a deposit shortfall');

  // And nothing is due today: the balance notice is ten days before its own
  // deadline, 60 days before play.
  assert.equal(plan.next, null);
});
