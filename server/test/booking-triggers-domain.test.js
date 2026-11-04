import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONDITIONS,
  DEFAULT_SCHEDULE,
  STEP_IDS,
  conditionHolds,
  dueDateFor,
  flowFor,
  getStep,
  moneyState,
  parseTeeTime,
  planBooking,
  planBookings,
  postPlayDueAt,
  publicTriggerConfig,
  readTriggerConfig,
  recipientFor,
  chaseable,
  securedClockStart,
  stepsFor,
  summarisePlans,
  templateEnvFor,
  triggerReady,
  validateTriggerSettings,
  workflowProblem,
  clubOwnDomains,
  isClubsOwnAddress,
} from '../src/lib/booking-triggers-domain.js';
import { paymentState } from '../src/lib/operators-domain.js';

const TRACKED = { tracked: true, from: null };

function booking(overrides = {}) {
  return {
    bookingId: 'CL-100',
    club: 'teemail',
    guestEmail: 'ann.burke@example.com',
    guestName: 'Ann Burke',
    date: '2026-12-01',
    teeTime: '10:20',
    players: 4,
    total: 1200,
    amountPaid: 0,
    paymentStatus: 'Unpaid',
    status: 'Booked',
    bookedAt: '2026-10-20T09:00:00.000Z',
    timestamp: '2026-10-18T09:00:00.000Z',
    golfCourses: 'Championship Course',
    hotelRequired: false,
    ...overrides,
  };
}

/** The state of one step in a plan, for the assertions below to read. */
function stateOf(plan, step) {
  return plan.steps.find((entry) => entry.step === step);
}

// --- configuration ----------------------------------------------------------

test('the workflow is off until it is switched on', () => {
  const config = readTriggerConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.automatic, false);
  assert.equal(config.autoCancel, false);
  assert.equal(triggerReady(config), false);
});

test('both switches are needed before the schedule may send', () => {
  assert.equal(readTriggerConfig({ TRIGGER_WORKFLOW: 'true' }).automatic, false);
  assert.equal(readTriggerConfig({ TRIGGER_WORKFLOW_AUTO: 'true' }).automatic, false);
  assert.equal(readTriggerConfig({ TRIGGER_WORKFLOW: 'true', TRIGGER_WORKFLOW_AUTO: 'true' }).automatic, true);
});

test('a switched-on workflow still needs a sender before it can send', () => {
  const bare = readTriggerConfig({ TRIGGER_WORKFLOW: 'true' });
  assert.equal(triggerReady(bare), false);
  assert.deepEqual(bare.missing, ['SENDGRID_API_KEY', 'FROM_EMAIL']);

  const ready = readTriggerConfig({
    TRIGGER_WORKFLOW: 'true',
    SENDGRID_API_KEY: 'SG.key',
    FROM_EMAIL: 'golf@teemail.io',
  });
  assert.equal(triggerReady(ready), true);
});

test('the whole ladder moves when a deadline does', () => {
  const { schedule } = readTriggerConfig({ TRIGGER_DEPOSIT_DAYS: '14' });
  const steps = stepsFor(schedule);
  const byId = Object.fromEntries(steps.map((step) => [step.id, step.days]));

  assert.equal(byId.deposit_final_notice, 13, 'the 24-hour notice follows the window');
  assert.equal(byId.deposit_overdue, 14);
  assert.equal(byId.deposit_rescue_48h, 15);
  assert.equal(byId.deposit_lapsed, 17, 'the grace period still runs from the window closing');
});

// --- the club's own settings (migration 0027) -------------------------------

test('what the club saved wins over the environment, and what it did not inherits', () => {
  const env = { TRIGGER_WORKFLOW: 'true', TRIGGER_DEPOSIT_DAYS: '14', TRIGGER_CATCH_UP_DAYS: '5' };
  const config = readTriggerConfig(env, { enabled: false, depositDays: 10 });

  assert.equal(config.enabled, false, 'the club switched it off');
  assert.equal(config.schedule.depositDays, 10, 'the club moved the window');
  assert.equal(config.schedule.catchUpDays, 5, 'untouched, so the environment stands');
  assert.deepEqual(config.saved, ['enabled', 'depositDays']);

  const inherited = readTriggerConfig(env, {});
  assert.equal(inherited.enabled, true);
  assert.equal(inherited.schedule.depositDays, 14);
  assert.deepEqual(inherited.saved, []);
});

test('a club can turn the schedule on without the deployer', () => {
  const config = readTriggerConfig({}, { enabled: true, automatic: true, autoCancel: true });
  assert.equal(config.enabled, true);
  assert.equal(config.automatic, true);
  assert.equal(config.autoCancel, true);
  assert.equal(config.locked, false);
  // ...but scheduled sending never outlives chasing itself.
  assert.equal(readTriggerConfig({}, { enabled: false, automatic: true }).automatic, false);
});

test('an explicit TRIGGER_WORKFLOW=false is a kill switch no club setting can lift', () => {
  const config = readTriggerConfig({ TRIGGER_WORKFLOW: 'false' }, { enabled: true, automatic: true });
  assert.equal(config.locked, true);
  assert.equal(config.enabled, false);
  assert.equal(config.automatic, false);
  // Unset is not the same as false: unset leaves it to the club.
  assert.equal(readTriggerConfig({}, { enabled: true }).locked, false);
});

test('a saved value that is not a usable number is ignored rather than trusted', () => {
  const config = readTriggerConfig({}, { depositDays: 'ten', catchUpDays: -1, enabled: 'yes' });
  assert.equal(config.schedule.depositDays, DEFAULT_SCHEDULE.depositDays);
  assert.equal(config.schedule.catchUpDays, DEFAULT_SCHEDULE.catchUpDays);
  assert.equal(config.enabled, false);
});

test('settings are validated as a patch over what is already saved', () => {
  const ok = validateTriggerSettings({ depositDays: 10, enabled: true, unknown: 1 }, { current: DEFAULT_SCHEDULE });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { enabled: true, depositDays: 10 }, 'unknown keys are dropped, not refused');

  // Moving the window under the reminder is refused, with the reminder named.
  const under = validateTriggerSettings({ depositDays: 4 }, { current: DEFAULT_SCHEDULE });
  assert.equal(under.ok, false);
  assert.match(under.errors[0], /reminder must come before/);

  // Moving both together is fine.
  assert.equal(
    validateTriggerSettings({ depositDays: 4, depositReminderDay: 2 }, { current: DEFAULT_SCHEDULE }).ok,
    true,
  );

  assert.match(validateTriggerSettings({ depositGraceDays: 1 }).errors[0], /between 2 and 365/);
  assert.match(validateTriggerSettings({ balanceNoticeDays: 60 }).errors[0], /balance notice must go out before/);
  assert.match(validateTriggerSettings({ finalDetailsDays: 30 }).errors[0], /arrival details must go out after/);
  assert.match(validateTriggerSettings({ depositDays: 7.5 }).errors[0], /whole number of days/);
  assert.match(validateTriggerSettings({ postPlayHours: 'soon' }).errors[0], /whole number of hours/);
  assert.match(validateTriggerSettings({ enabled: 'true' }).errors[0], /must be true or false/);
  assert.equal(validateTriggerSettings([]).ok, false);
  assert.equal(validateTriggerSettings(undefined).ok, true);
});

// --- trade accounts ---------------------------------------------------------

const CARR = {
  id: 3,
  name: 'Carr Golf',
  contactEmail: 'accounts@carrgolf.test',
  depositDueDaysBeforePlay: null,
  balanceDueDaysBeforePlay: null,
  active: true,
  autoChase: true,
};

test('money goes to the account, the round-up to the tee goes to the guest', () => {
  const link = getStep('deposit_request');
  const details = getStep('final_details');
  assert.equal(recipientFor(link, booking(), CARR), 'accounts@carrgolf.test');
  assert.equal(recipientFor(details, booking(), CARR), 'ann.burke@example.com');
  assert.equal(recipientFor(link, booking()), 'ann.burke@example.com', 'a visitor pays for themselves');
  // An account with no address of its own falls back to the guest rather than to nobody.
  assert.equal(recipientFor(link, booking(), { ...CARR, contactEmail: '' }), 'ann.burke@example.com');
});

test('a retired account, or one switched off, is not chased — but its guest is still welcomed', () => {
  assert.equal(chaseable(null), true);
  assert.equal(chaseable(CARR), true);
  assert.equal(chaseable({ ...CARR, active: false }), false);
  assert.equal(chaseable({ ...CARR, autoChase: false }), false);

  const plan = planBooking(booking({ tourOperatorId: 3 }), {
    today: '2026-10-25',
    tracking: TRACKED,
    operator: { ...CARR, autoChase: false },
    source: 'assignment',
  });
  assert.equal(plan.chased, false);
  assert.equal(stateOf(plan, 'deposit_reminder').state, 'skipped');
  assert.equal(stateOf(plan, 'deposit_reminder').reason, 'This account is not chased');
  assert.equal(plan.next, null, 'nothing to send today');
  assert.equal(stateOf(plan, 'post_play').state, 'upcoming', 'the round-up to the tee still runs');
});

test("an account's own deposit lead time slides the whole deposit ladder onto its date", () => {
  // Play 2026-12-01, deposit due 40 days before: 2026-10-22. The club's
  // default window is 7 days, so the deadline rung (deposit_overdue, day 7)
  // lands on the 22nd and the others keep their distance from it.
  const operator = { ...CARR, depositDueDaysBeforePlay: 40 };
  const row = booking({ bookedAt: '2026-10-01T09:00:00.000Z' });
  const on = (id) => dueDateFor(getStep(id), row, { operator });

  assert.equal(on('deposit_overdue'), '2026-10-22');
  assert.equal(on('deposit_final_notice'), '2026-10-21');
  assert.equal(on('deposit_reminder'), '2026-10-20');
  assert.equal(on('deposit_lapsed'), '2026-10-25');
  // The request itself would fall before the window; it is never asked for
  // before the booking was made.
  assert.equal(on('deposit_request'), '2026-10-15');
  assert.equal(
    dueDateFor(getStep('deposit_request'), booking({ bookedAt: '2026-10-18T09:00:00.000Z' }), { operator }),
    '2026-10-18',
  );
  // With no lead time of its own the account is still chased by its own
  // credit terms, not by the club's visitor window: CARR has no payment terms
  // set, so it is net 30 from the day the booking was taken.
  assert.equal(dueDateFor(getStep('deposit_overdue'), row, { operator: CARR }), '2026-10-31');
  // An account on the same terms as the club's own window lands where the
  // club's window would have put it -- which is every live account here.
  assert.equal(
    dueDateFor(getStep('deposit_overdue'), row, { operator: { ...CARR, paymentTermsDays: 7 } }),
    '2026-10-08',
  );
  // A date typed onto the booking by hand beats both.
  assert.equal(
    dueDateFor(getStep('deposit_overdue'), { ...row, depositDueDate: '2026-11-05' }, { operator: CARR }),
    '2026-11-05',
  );
  // A visitor, with no account at all, keeps the club's window.
  assert.equal(dueDateFor(getStep('deposit_overdue'), row, { operator: null }), '2026-10-08');
});

test('the ladder dates its deposit rungs from the same rule the payment columns do', () => {
  // These were two separate calculations and agreed only by coincidence --
  // the club's deposit window and every account's payment terms were both
  // seven days. A club that changed either would have had the ladder
  // cancelling bookings on a date no screen showed.
  const row = booking({ bookedAt: '2026-10-01T09:00:00.000Z' });
  for (const terms of [
    { paymentTermsDays: 7 },
    { paymentTermsDays: 14 },
    { paymentTermsDays: 45 },
    { depositDueDaysBeforePlay: 40 },
  ]) {
    const operator = { ...CARR, ...terms };
    const ledger = paymentState(row, operator, { today: '2026-10-05' });
    assert.equal(
      dueDateFor(getStep('deposit_overdue'), row, { operator }),
      ledger.depositDueDate,
      `the deadline rung and the payment columns agree on ${JSON.stringify(terms)}`,
    );
  }
});

test("an account's own balance lead time moves the balance rungs, and the confirmation they open", () => {
  // Default deadline 60 days out; this account settles 45 days out.
  const operator = { ...CARR, balanceDueDaysBeforePlay: 45 };
  const on = (id) => dueDateFor(getStep(id), booking(), { operator });

  assert.equal(on('balance_lapsed'), '2026-10-17', '45 days before 2026-12-01');
  assert.equal(on('balance_rescue_24h'), '2026-10-16');
  assert.equal(on('balance_notice'), '2026-10-07', 'still ten days ahead of the deadline');
  assert.equal(on('booking_confirmed'), '2026-10-17', 'the thank-you follows the deadline it closes');
  // The round-up to the tee is about the round, not the bill.
  assert.equal(on('pre_arrival_confirmation'), '2026-11-01');
  assert.equal(on('final_details'), '2026-11-21');
});

test('a trade booking with no guest address can still be chased at the account', () => {
  const plan = planBooking(booking({ guestEmail: '', tourOperatorId: 3 }), {
    today: '2026-10-25',
    tracking: TRACKED,
    operator: CARR,
    source: 'assignment',
  });
  assert.equal(plan.blocker, null);
  assert.equal(plan.contactEmail, 'accounts@carrgolf.test');
  assert.equal(stateOf(plan, 'deposit_reminder').to, 'accounts@carrgolf.test');
  assert.equal(stateOf(plan, 'final_details').state, 'blocked', 'nobody to welcome');
  assert.equal(stateOf(plan, 'final_details').reason, 'No guest email address');
});

test('the config handed to the browser carries no API key', () => {
  const config = publicTriggerConfig(readTriggerConfig({ SENDGRID_API_KEY: 'SG.secret' }));
  assert.equal('apiKey' in config, false);
  assert.equal(config.hasApiKey, true);
  assert.equal(JSON.stringify(config).includes('SG.secret'), false);
});

test('every step is listed for the browser with a template name of its own', () => {
  const config = publicTriggerConfig(readTriggerConfig({}));
  assert.equal(config.steps.length, STEP_IDS.length);
  assert.equal(templateEnvFor('final_details'), 'SENDGRID_TEMPLATE_TRIGGER_FINAL_DETAILS');
  for (const step of config.steps) {
    assert.ok(step.label, `${step.id} has a label`);
    assert.ok(CONDITIONS[step.condition], `${step.id} has a known condition`);
    assert.equal(step.templateEnv, templateEnvFor(step.id));
  }
});

// --- which ladder -----------------------------------------------------------

test('an attributed booking is on the operator ladder, everything else is a visitor', () => {
  assert.equal(flowFor(booking()), 'visitor');
  assert.equal(flowFor(booking(), { operator: { id: 3, name: 'Carr Golf' }, source: 'assignment' }), 'tour_operator');
  assert.equal(flowFor(booking({ tourOperatorId: 3 })), 'tour_operator');
});

test('a name found in an email body is not enough to put a guest on the trade ladder', () => {
  // The same bar the operator reminders apply: the two ladders have different
  // deadlines, and guessing puts a guest on a trade partner's one.
  assert.equal(flowFor(booking(), { operator: { id: 3, name: 'Carr Golf' }, source: 'name' }), 'visitor');
});

test('the balance ladder belongs to trade bookings only', () => {
  const visitor = stepsFor(DEFAULT_SCHEDULE, 'visitor').map((step) => step.id);
  const trade = stepsFor(DEFAULT_SCHEDULE, 'tour_operator').map((step) => step.id);

  assert.equal(visitor.includes('balance_notice'), false);
  assert.equal(visitor.includes('balance_lapsed'), false);
  assert.ok(trade.includes('balance_notice'));
  // Both ladders still climb to the tee and back.
  for (const shared of ['deposit_request', 'pre_arrival_confirmation', 'final_details', 'post_play']) {
    assert.ok(visitor.includes(shared), shared);
    assert.ok(trade.includes(shared), shared);
  }
});

// --- dates ------------------------------------------------------------------

test('the payment clock starts the day the booking was confirmed', () => {
  assert.equal(securedClockStart(booking()), '2026-10-20');
});

test('a booking confirmed before the booked_at column existed counts from its enquiry', () => {
  assert.equal(securedClockStart(booking({ bookedAt: null })), '2026-10-18');
  assert.equal(securedClockStart(booking({ bookedAt: null, timestamp: null })), null);
});

test('the deposit ladder is counted forward from the booking, the rest back from play', () => {
  const row = booking();
  const dates = Object.fromEntries(
    STEP_IDS.map((id) => [id, dueDateFor(getStep(id), row, { schedule: DEFAULT_SCHEDULE })]),
  );

  // Booked 20 Oct: the window closes on the 27th, cancellation on the 30th.
  assert.equal(dates.deposit_request, '2026-10-20');
  assert.equal(dates.deposit_reminder, '2026-10-25');
  assert.equal(dates.deposit_final_notice, '2026-10-26');
  assert.equal(dates.deposit_overdue, '2026-10-27');
  assert.equal(dates.deposit_rescue_48h, '2026-10-28');
  assert.equal(dates.deposit_rescue_24h, '2026-10-29');
  assert.equal(dates.deposit_lapsed, '2026-10-30');

  // Playing 1 Dec: 70, 62, 61, 60, 30 and 10 days before it.
  assert.equal(dates.balance_notice, '2026-09-22');
  assert.equal(dates.balance_rescue_48h, '2026-09-30');
  assert.equal(dates.balance_rescue_24h, '2026-10-01');
  assert.equal(dates.balance_lapsed, '2026-10-02');
  assert.equal(dates.booking_confirmed, '2026-10-02');
  assert.equal(dates.pre_arrival_confirmation, '2026-11-01');
  assert.equal(dates.final_details, '2026-11-21');
});

test('the thank you falls due 24 hours after the tee time, so the day after play', () => {
  assert.equal(dueDateFor(getStep('post_play'), booking(), {}), '2026-12-02');
  assert.deepEqual(postPlayDueAt(booking(), 24), new Date('2026-12-02T10:20:00.000Z'));
});

test('a round with no usable tee time is counted from midday', () => {
  assert.deepEqual(postPlayDueAt(booking({ teeTime: 'Not Specified' }), 24), new Date('2026-12-02T12:00:00.000Z'));
});

test('tee times are read however the tee sheet wrote them', () => {
  assert.equal(parseTeeTime('14:30'), 870);
  assert.equal(parseTeeTime('2:30 PM'), 870);
  assert.equal(parseTeeTime('9.10am'), 550);
  assert.equal(parseTeeTime('12:00 AM'), 0);
  assert.equal(parseTeeTime('12:00 PM'), 720);
  assert.equal(parseTeeTime('9AM'), 540);
  assert.equal(parseTeeTime('Not Specified'), null);
  assert.equal(parseTeeTime('TBD'), null);
  assert.equal(parseTeeTime(''), null);
  assert.equal(parseTeeTime('25:00'), null);
  assert.equal(parseTeeTime('10:99'), null);
});

// --- the money --------------------------------------------------------------

test('the conditions read a booking with nothing paid as the chase ladder', () => {
  const money = moneyState(booking(), { tracking: TRACKED });
  assert.equal(money.empty, true);
  assert.equal(money.secured, false);
  assert.equal(conditionHolds('unpaid', money), true);
  assert.equal(conditionHolds('part_paid', money), false);
  assert.equal(conditionHolds('settled', money), false);
  assert.equal(conditionHolds('any', money), true);
});

test('a deposit paid moves it onto the balance ladder', () => {
  const money = moneyState(booking({ amountPaid: 360, paymentStatus: 'Deposit paid' }), { tracking: TRACKED });
  assert.equal(conditionHolds('unpaid', money), false);
  assert.equal(conditionHolds('part_paid', money), true);
  assert.equal(conditionHolds('secured', money), true);
  assert.equal(conditionHolds('settled', money), false);
});

test('paid in full satisfies settled and nothing else', () => {
  const money = moneyState(booking({ amountPaid: 1200, paymentStatus: 'Paid' }), { tracking: TRACKED });
  assert.equal(conditionHolds('settled', money), true);
  assert.equal(conditionHolds('part_paid', money), false);
  assert.equal(conditionHolds('unpaid', money), false);
});

test('a status staff typed in counts as money arriving even with no figure recorded', () => {
  // 'Paid' with amount_paid 0 is somebody saying it is settled, and the ladder
  // must not chase it.
  const money = moneyState(booking({ paymentStatus: 'Paid', amountPaid: 0 }), { tracking: TRACKED });
  assert.equal(money.secured, true);
  assert.equal(conditionHolds('unpaid', money), false);
});

test('a written-off booking is not chased', () => {
  const money = moneyState(booking({ paymentStatus: 'Written off' }), { tracking: TRACKED });
  assert.equal(money.outstanding, 0);
  assert.equal(conditionHolds('unpaid', money), false);
});

test('a booking with no price is not chased for money it was never asked for', () => {
  const money = moneyState(booking({ total: 0 }), { tracking: TRACKED });
  assert.equal(money.empty, false);
  assert.equal(conditionHolds('unpaid', money), false);
});

test('a booking outside the payment ledger is left alone by the money steps', () => {
  // Taken before the club started recording payments: "unpaid" there is the
  // arithmetic talking, and the email would demand money that may have arrived
  // by bank transfer a year ago.
  const money = moneyState(booking(), { tracking: { tracked: true, from: '2026-11-01' } });
  assert.equal(money.tracked, false);
  assert.equal(conditionHolds('unpaid', money), false);
  assert.equal(conditionHolds('any', money), true, 'the communication ladder is about the round, not the bill');
});

// --- planning ---------------------------------------------------------------

test('an unpaid booking five days in is due its first chase', () => {
  const plan = planBooking(booking(), { today: '2026-10-25', tracking: TRACKED });
  assert.equal(plan.next.step, 'deposit_reminder');
  assert.equal(plan.next.reason, 'Due today');
  assert.equal(stateOf(plan, 'deposit_final_notice').state, 'upcoming');
  assert.equal(stateOf(plan, 'booking_confirmed').state, 'skipped');
});

test('a rung already in the ledger is never climbed twice', () => {
  const plan = planBooking(booking(), {
    today: '2026-10-25',
    tracking: TRACKED,
    sent: new Set(['deposit_reminder']),
  });
  assert.equal(stateOf(plan, 'deposit_reminder').state, 'sent');
  assert.equal(plan.next, null);
});

test('a post-play email the Guest Emails page already sent is read as climbed', () => {
  const plan = planBooking(booking({ postPlayEmailSentAt: '2026-12-02T11:00:00.000Z' }), {
    today: '2026-12-03',
    now: new Date('2026-12-03T09:00:00.000Z'),
    tracking: TRACKED,
  });
  assert.equal(stateOf(plan, 'post_play').state, 'sent');
  assert.match(stateOf(plan, 'post_play').reason, /predates the workflow/);
});

test('a receipt the Stripe webhook already sent is read as climbed', () => {
  const plan = planBooking(
    booking({ amountPaid: 360, paymentStatus: 'Deposit paid', paymentReceiptSentAt: '2026-10-21T09:00:00.000Z' }),
    { today: '2026-10-25', tracking: TRACKED },
  );
  assert.equal(stateOf(plan, 'deposit_receipt').state, 'sent');
});

test('a rung whose date went past long ago is missed, never sent unprompted', () => {
  // The guard that matters on the first run after switching the workflow on:
  // without it, a year of history would be emailed its own deadlines.
  const plan = planBooking(booking(), { today: '2026-11-15', tracking: TRACKED });
  for (const step of ['deposit_request', 'deposit_reminder', 'deposit_overdue', 'deposit_lapsed']) {
    assert.equal(stateOf(plan, step).state, 'missed', step);
  }
  assert.equal(plan.next, null);
});

test('a rung a day or two late still goes out', () => {
  const plan = planBooking(booking(), { today: '2026-10-27', tracking: TRACKED });
  assert.equal(plan.next.step, 'deposit_overdue');
  assert.equal(stateOf(plan, 'deposit_overdue').daysLate, 0);
});

test('only the furthest-advanced due rung is sent; the ones it passed are superseded', () => {
  // Booked 20 Oct, read on the 28th: the 25th, 26th, 27th and 28th are all
  // inside the catch-up horizon, and a guest must not receive four emails.
  const plan = planBooking(booking(), { today: '2026-10-28', tracking: TRACKED });
  assert.equal(plan.next.step, 'deposit_rescue_48h');
  assert.deepEqual(
    plan.superseded.map((entry) => entry.step),
    ['deposit_reminder', 'deposit_final_notice', 'deposit_overdue'],
  );
  assert.match(plan.superseded[0].reason, /Passed by/);
});

test('paying mid-chase moves the booking back onto the paid ladder', () => {
  const paid = booking({ amountPaid: 1200, paymentStatus: 'Paid', stripePaidAt: '2026-10-26T12:00:00.000Z' });
  const plan = planBooking(paid, { today: '2026-10-28', tracking: TRACKED });

  assert.equal(plan.next.step, 'deposit_receipt', 'the thank you, not the next warning');
  for (const step of ['deposit_overdue', 'deposit_rescue_48h', 'deposit_lapsed']) {
    assert.equal(stateOf(plan, step).state, 'skipped', step);
  }
});

test('a booking with no guest address is blocked rather than silently skipped', () => {
  const plan = planBooking(booking({ guestEmail: '' }), { today: '2026-10-25', tracking: TRACKED });
  assert.equal(plan.blocker, 'No guest email address');
  assert.equal(plan.next, null);
  assert.equal(stateOf(plan, 'deposit_reminder').state, 'blocked');
});

test('only a booked booking is on the ladder', () => {
  assert.equal(workflowProblem(booking({ status: 'Inquiry' })), 'A inquiry booking is not on the ladder');
  assert.equal(workflowProblem(booking({ status: 'Cancelled' })), 'A cancelled booking is not on the ladder');
  assert.equal(workflowProblem(booking({ date: null })), 'No play date');
  assert.equal(workflowProblem(booking()), null);
});

test('the thank you waits until the round has actually finished', () => {
  const played = booking({ date: '2026-10-25', amountPaid: 1200, paymentStatus: 'Paid' });

  const sameDay = planBooking(played, {
    today: '2026-10-25',
    now: new Date('2026-10-25T18:00:00.000Z'),
    tracking: TRACKED,
  });
  assert.equal(stateOf(sameDay, 'post_play').state, 'upcoming');
  assert.equal(stateOf(sameDay, 'post_play').reason, 'The round has not finished');

  const nextDay = planBooking(played, {
    today: '2026-10-26',
    now: new Date('2026-10-26T11:00:00.000Z'),
    tracking: TRACKED,
  });
  assert.equal(stateOf(nextDay, 'post_play').state, 'due');
});

test('a trade booking with its deposit in is due the 70-day balance notice', () => {
  const trade = booking({ date: '2026-12-01', amountPaid: 360, paymentStatus: 'Deposit paid' });
  const plan = planBooking(trade, {
    today: '2026-09-22',
    tracking: TRACKED,
    operator: { id: 7, name: 'Carr Golf' },
    source: 'assignment',
  });
  assert.equal(plan.flow, 'tour_operator');
  assert.equal(plan.next.step, 'balance_notice');
});

test('a trade booking still owing at the deadline is due cancellation', () => {
  const trade = booking({ date: '2026-12-01', amountPaid: 360, paymentStatus: 'Deposit paid' });
  const plan = planBooking(trade, {
    today: '2026-10-02',
    tracking: TRACKED,
    operator: { id: 7, name: 'Carr Golf' },
    source: 'assignment',
    sent: new Set(['balance_notice', 'balance_rescue_48h', 'balance_rescue_24h', 'deposit_receipt']),
  });
  assert.equal(plan.next.step, 'balance_lapsed');
  assert.equal(plan.next.action, 'cancel');
});

test('a booking paid in full at the deadline is confirmed rather than cancelled', () => {
  const trade = booking({ date: '2026-12-01', amountPaid: 1200, paymentStatus: 'Paid' });
  const plan = planBooking(trade, {
    today: '2026-10-02',
    tracking: TRACKED,
    operator: { id: 7, name: 'Carr Golf' },
    source: 'assignment',
    sent: new Set(['deposit_receipt']),
  });
  assert.equal(plan.next.step, 'booking_confirmed');
  assert.equal(stateOf(plan, 'balance_lapsed').state, 'skipped');
});

// --- the whole table --------------------------------------------------------

test('the table is planned down to the bookings a run would touch', () => {
  const rows = [
    booking({ bookingId: 'CL-1' }),
    // Playing tomorrow and long since paid: nothing falls due today.
    booking({ bookingId: 'CL-2', date: '2026-10-26', amountPaid: 1200, paymentStatus: 'Paid' }),
    booking({ bookingId: 'CL-3', status: 'Cancelled' }),
  ];
  const options = { today: '2026-10-25', tracking: TRACKED };

  const due = planBookings(rows, { ...options, scope: 'due' });
  assert.deepEqual(
    due.map((plan) => plan.bookingId),
    ['CL-1'],
  );

  const all = planBookings(rows, { ...options, scope: 'all' });
  assert.equal(all.length, 3, 'every booking is drawn, cancelled ones included');
  assert.equal(all.find((plan) => plan.bookingId === 'CL-3').blocker, 'A cancelled booking is not on the ladder');
});

test('the ledger is read per booking, so one guest being done does not silence another', () => {
  const rows = [booking({ bookingId: 'CL-1' }), booking({ bookingId: 'CL-2' })];
  const plans = planBookings(rows, {
    today: '2026-10-25',
    tracking: TRACKED,
    sent: new Map([['CL-1', new Set(['deposit_reminder'])]]),
  });
  assert.deepEqual(
    plans.map((plan) => plan.bookingId),
    ['CL-2'],
  );
});

test('the missed scope is the list to read after switching the workflow on', () => {
  const rows = [booking({ bookingId: 'CL-1' })];
  const missed = planBookings(rows, { today: '2026-11-15', tracking: TRACKED, scope: 'missed' });
  assert.equal(missed.length, 1);
  assert.ok(missed[0].steps.some((entry) => entry.state === 'missed'));
});

test('the summary counts what a run would actually do', () => {
  const plans = planBookings([booking({ bookingId: 'CL-1' })], { today: '2026-10-25', tracking: TRACKED });
  const summary = summarisePlans(plans);
  assert.equal(summary.bookings, 1);
  assert.equal(summary.emails, 1);
  assert.equal(summary.cancellations, 0);
  assert.equal(summary.counts.due, 1);
});

test('the soonest round comes first: a delayed email hurts it most', () => {
  const rows = [
    booking({ bookingId: 'CL-LATE', date: '2027-05-01' }),
    booking({ bookingId: 'CL-SOON', date: '2026-11-10' }),
  ];
  const plans = planBookings(rows, { today: '2026-10-25', tracking: TRACKED });
  assert.deepEqual(
    plans.map((plan) => plan.bookingId),
    ['CL-SOON', 'CL-LATE'],
  );
});

test("nothing on the ladder is sent to the club's own inbox", () => {
  // Lorraine Hughes's round, filed under the office's address because that is
  // where the request came from. The ladder sent reservations@ five deposit
  // reminders and a cancellation warning about it.
  const own = clubOwnDomains({
    FROM_EMAIL: 'Reservations@CountyLouthGolfClub.com',
    REPLY_TO_EMAIL: 'golf@countylouthgolfclub.com',
    CLUB_EMAIL_DOMAINS: 'baltray.ie, @clgc.ie',
  });
  assert.deepEqual([...own].sort(), ['baltray.ie', 'clgc.ie', 'countylouthgolfclub.com']);
  assert.equal(isClubsOwnAddress('reservations@countylouthgolfclub.com', own), true);
  assert.equal(isClubsOwnAddress('guest@example.com', own), false);
  assert.equal(isClubsOwnAddress('', own), false);

  const plan = planBooking(
    booking({ guestEmail: 'reservations@countylouthgolfclub.com', amountPaid: 0, paymentStatus: 'Unpaid' }),
    { today: '2026-10-25', tracking: TRACKED, ownDomains: own },
  );
  for (const entry of plan.steps) {
    assert.notEqual(entry.state, 'due', `${entry.step} is not sent to the club`);
  }
  const request = plan.steps.find((entry) => entry.step === 'deposit_request');
  assert.equal(request.state, 'blocked');
  assert.match(request.reason, /club's own inbox/);
  assert.equal(plan.next, null);

  // On an account, the money goes to the account and is not held up; only
  // the rungs addressed to the club are.
  const traded = planBooking(
    booking({
      guestEmail: 'reservations@countylouthgolfclub.com',
      tourOperatorId: 3,
      amountPaid: 0,
      paymentStatus: 'Unpaid',
    }),
    { today: '2026-10-25', tracking: TRACKED, operator: CARR, ownDomains: own },
  );
  const money = traded.steps.find((entry) => entry.step === 'deposit_request');
  assert.notEqual(money.state, 'blocked', 'the deposit request goes to the account');
  const arrival = traded.steps.find((entry) => entry.step === 'final_details');
  assert.equal(arrival.to, 'reservations@countylouthgolfclub.com');
  assert.equal(arrival.state, 'blocked');
});
