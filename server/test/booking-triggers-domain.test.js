import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LADDER_DEFAULTS,
  chaseable,
  depositDueOn,
  recipientFor,
  validateLifecycleSettings,
  balanceDueOn,
  buildLadder,
  evaluateLadder,
  hasPayment,
  moneyState,
  paidInFull,
  planForBooking,
  readTriggerConfig,
  sendableLadder,
} from '../src/lib/booking-triggers-domain.js';
import { addDays } from '../src/lib/email-domain.js';

const ON = { BOOKING_TRIGGERS_ENABLED: 'true', BOOKING_TRIGGERS_DEADLINES: 'true' };

/** A trade booking: £1000, nothing paid, playing in 100 days. */
function booking(overrides = {}) {
  return {
    bookingId: 'RD-2001',
    club: 'royal_dornoch',
    guestEmail: 'ann@example.com',
    guestName: 'Ann McLeod',
    status: 'Booked',
    date: '2026-06-01',
    teeTime: '08:40',
    players: 4,
    total: 1000,
    amountPaid: 0,
    paymentStatus: 'Unpaid',
    invoicedAt: null,
    depositDueDate: null,
    balanceDueDate: null,
    paymentLinkSentAt: null,
    prePlayClockStartedAt: null,
    stripePaidAt: null,
    preArrivalEmailSentAt: null,
    postPlayEmailSentAt: null,
    lifecycleStartedAt: null,
    ...overrides,
  };
}

/** A trade account with the sheet's own terms: 25% deposit, balance 60 days out. */
function operator(overrides = {}) {
  return {
    id: 7,
    name: 'Highland Golf Tours',
    depositPercent: 25,
    paymentTermsDays: 30,
    depositDueDaysBeforePlay: null,
    balanceDueDaysBeforePlay: 60,
    ...overrides,
  };
}

/** Walk the ladder for a booking on a given day and return it keyed by rung. */
function walk({ on, book = booking(), op = null, started = '2026-01-01', paidOn = null, already = new Map(), config }) {
  const cfg = readTriggerConfig(config ?? ON);
  const evaluated = evaluateLadder({
    booking: book,
    operator: op,
    ladder: sendableLadder(cfg),
    today: on,
    lifecycleStartedOn: started,
    paidOn,
    already,
    catchUpDays: cfg.catchUpDays,
    ladderConfig: cfg.ladder,
  });
  return { evaluated, byRung: new Map(evaluated.map((e) => [e.rung.key, e])), plan: planForBooking(evaluated) };
}

// ---------------------------------------------------------------------------
// The ladder as the sheet draws it
// ---------------------------------------------------------------------------

test("the deposit ladder runs on the sheet's own days", () => {
  // Counted from the deposit deadline now, so the check is the day each rung
  // lands on for a visitor booked on the 1st: the sheet's 0/5/6/7/8/9/10.
  const chosen = (on) => walk({ on, started: '2026-01-01' }).byRung;
  const day = (rung, n) => chosen('2026-01-01').get(rung).dueOn === addDays('2026-01-01', n);

  assert.ok(day('deposit_request', 0), '"payment link requesting payment within 7 days of booking"');
  assert.ok(day('deposit_reminder_1', 5), '"re-trigger payment reminder after 5 days of booking"');
  assert.ok(day('deposit_reminder_2', 6), '"an additional reminder 24 hours before" the 7-day deadline');
  assert.ok(day('deposit_overdue', 7), '"if no payment received after 7 day window"');
  assert.ok(day('deposit_rescue_48h', 8), '"another reminder 48 hours" before the second deadline');
  assert.ok(day('deposit_rescue_24h', 9), '"then 24 hours"');
  assert.ok(day('deposit_cancelled', 10), 'cancellation at the second deadline');
});

test('the balance ladder is measured from the balance deadline, not from play', () => {
  const byKey = new Map(buildLadder(LADDER_DEFAULTS).map((r) => [r.key, r]));

  // "70 day out, reminder that 10 days remaining ... ahead of 60 day before
  // booking": ten days before a deadline that is itself 60 days before play.
  assert.equal(byKey.get('balance_notice').offset, -10);
  assert.equal(byKey.get('balance_reminder_48h').offset, -2);
  assert.equal(byKey.get('balance_reminder_24h').offset, -1);
  assert.equal(byKey.get('balance_cancelled').offset, 0);
  for (const key of ['balance_notice', 'balance_cancelled']) {
    assert.equal(byKey.get(key).anchor, 'balanceDue');
  }
});

test('the communication phase sits on the play date', () => {
  const byKey = new Map(buildLadder(LADDER_DEFAULTS).map((r) => [r.key, r]));
  assert.equal(byKey.get('confirmation').offset, -30);
  assert.equal(byKey.get('final_details').offset, -10);
  // "Post play 24 hours after tee time of play day."
  assert.equal(byKey.get('post_play').offset, 1);
});

test('the balance phase is trade only, because a visitor pays once', () => {
  for (const rung of buildLadder(LADDER_DEFAULTS).filter((r) => r.phase === 'balance')) {
    assert.deepEqual(rung.flows, ['operator'], rung.key);
  }
});

// ---------------------------------------------------------------------------
// The balance deadline
// ---------------------------------------------------------------------------

test("the operator's own term wins over the sheet's 60 days", () => {
  assert.equal(balanceDueOn(booking(), operator({ balanceDueDaysBeforePlay: 30 }), LADDER_DEFAULTS), '2026-05-02');
  assert.equal(balanceDueOn(booking(), operator({ balanceDueDaysBeforePlay: 60 }), LADDER_DEFAULTS), '2026-04-02');
});

test('a date on the booking itself wins over everything', () => {
  const book = booking({ balanceDueDate: '2026-03-15' });
  assert.equal(balanceDueOn(book, operator({ balanceDueDaysBeforePlay: 60 }), LADDER_DEFAULTS), '2026-03-15');
});

test("an account with no term of its own falls back to the sheet's 60 days, never to invoice terms", () => {
  // paymentState would answer play + 30 here, which for billing is right and
  // for a deadline is a month after the round was played.
  const book = booking({ invoicedAt: '2026-05-01' });
  const noTerm = operator({ balanceDueDaysBeforePlay: null });
  assert.equal(balanceDueOn(book, noTerm, LADDER_DEFAULTS), '2026-04-02');

  const money = moneyState(book, noTerm, '2026-03-01');
  assert.equal(money.balanceDueDate, '2026-05-31', 'paymentState still bills on invoice terms');
});

test('a booking with no play date has no balance deadline, and no balance rung ever falls due', () => {
  assert.equal(balanceDueOn(booking({ date: null }), operator(), LADDER_DEFAULTS), null);

  const { byRung } = walk({ on: '2026-04-02', book: booking({ date: null, amountPaid: 250 }), op: operator() });
  assert.equal(byRung.get('balance_notice').state, 'undated');
  assert.equal(byRung.get('balance_cancelled').state, 'undated');
});

// ---------------------------------------------------------------------------
// The branch: paid and not paid
// ---------------------------------------------------------------------------

test('an unpaid booking climbs the cancellation ladder, a rung a day', () => {
  // What it would send on each day, run daily. More than one rung can be due
  // at once — yesterday's is still unsent — so this is the chosen one, which
  // is the booking's actual situation.
  const started = '2026-01-01';
  const chosen = (on) => walk({ on, started }).plan.send?.rung.key ?? null;

  assert.equal(chosen('2026-01-01'), 'deposit_request');
  assert.equal(chosen('2026-01-06'), 'deposit_reminder_1');
  assert.equal(chosen('2026-01-07'), 'deposit_reminder_2');
  assert.equal(chosen('2026-01-08'), 'deposit_overdue');
  assert.equal(chosen('2026-01-09'), 'deposit_rescue_48h');
  assert.equal(chosen('2026-01-10'), 'deposit_rescue_24h');
  assert.equal(chosen('2026-01-11'), 'deposit_cancelled');
});

test('paying mid-dunning moves the booking to the if-paid ladder, with no jump anywhere', () => {
  // The sheet's "if payment made revert to the if Paid process". Day 8 would
  // have been the overdue warning; the deposit landed on day 6 instead.
  const paid = booking({
    amountPaid: 250,
    paymentStatus: 'Deposit paid',
    prePlayClockStartedAt: '2026-01-07T09:00:00Z',
  });
  const { byRung } = walk({
    on: '2026-01-08',
    book: paid,
    op: operator(),
    started: '2026-01-01',
    paidOn: '2026-01-07',
  });

  assert.equal(byRung.get('deposit_overdue').state, 'skipped', 'the warning no longer applies');
  assert.equal(byRung.get('deposit_cancelled').state, 'waiting');
  assert.equal(byRung.get('deposit_receipt').state, 'due', 'the receipt is what is owed now');
});

test('a part payment is a payment: the unpaid ladder stops at the first penny', () => {
  const money = (amountPaid) => moneyState(booking({ amountPaid }), operator(), '2026-01-08');
  assert.equal(hasPayment(booking({ amountPaid: 0 }), money(0)), false);
  assert.equal(hasPayment(booking({ amountPaid: 1 }), money(1)), true);
  assert.equal(hasPayment(booking({ amountPaid: 250 }), money(250)), true);
});

test('a written-off booking is not chased', () => {
  const book = booking({ paymentStatus: 'Written off' });
  const money = moneyState(book, operator(), '2026-01-08');
  assert.equal(hasPayment(book, money), true);
  assert.equal(paidInFull(money), true);
});

test('the balance ladder runs only once a deposit is in and something is still owed', () => {
  const deposited = booking({ amountPaid: 250, paymentStatus: 'Deposit paid' });
  const settled = booking({ amountPaid: 1000, paymentStatus: 'Paid' });

  // Balance due 2026-04-02; the notice falls ten days before it.
  const chasing = walk({ on: '2026-03-23', book: deposited, op: operator() }).byRung;
  assert.equal(chasing.get('balance_notice').state, 'due');

  const paid = walk({ on: '2026-03-23', book: settled, op: operator() }).byRung;
  assert.equal(paid.get('balance_notice').state, 'skipped');

  // On the deadline itself the two branches are mutually exclusive.
  const lapsing = walk({ on: '2026-04-02', book: deposited, op: operator() }).byRung;
  assert.equal(lapsing.get('balance_cancelled').state, 'due');
  assert.equal(lapsing.get('balance_receipt').state, 'skipped');

  const closing = walk({ on: '2026-04-02', book: settled, op: operator() }).byRung;
  assert.equal(closing.get('balance_cancelled').state, 'skipped');
  assert.equal(closing.get('balance_receipt').state, 'due', 'the rung that closes the payment phase');
});

test('an unpaid booking never reaches the arrival emails, but everyone who played is thanked', () => {
  const unpaid = booking({ date: '2026-06-01' });
  assert.equal(walk({ on: '2026-05-02', book: unpaid, op: operator() }).byRung.get('confirmation').state, 'skipped');
  // Post-play asks nothing about the money: chasing an invoice is not a
  // reason to skip the thank you.
  assert.equal(walk({ on: '2026-06-02', book: unpaid, op: operator() }).byRung.get('post_play').state, 'due');
});

test('a part-paid booking still gets its arrival information', () => {
  const part = booking({ amountPaid: 250, paymentStatus: 'Deposit paid' });
  assert.equal(walk({ on: '2026-05-02', book: part, op: operator() }).byRung.get('confirmation').state, 'due');
  assert.equal(walk({ on: '2026-05-22', book: part, op: operator() }).byRung.get('final_details').state, 'due');
});

// ---------------------------------------------------------------------------
// Collapsing and the catch-up horizon
// ---------------------------------------------------------------------------

test('at most one email per booking per run, and it is the furthest-along rung', () => {
  // Nothing has run for days: the reminder, the warning and the first rescue
  // are all behind us. Sending all three would deliver a nudge, a warning and
  // a final notice in the same breath.
  const { plan } = walk({ on: '2026-01-09', started: '2026-01-01' });

  assert.equal(plan.send.rung.key, 'deposit_rescue_48h', "the booking's actual situation");
  assert.ok(plan.superseded.length >= 1);
  assert.equal(
    plan.superseded.some((e) => e.rung.key === 'deposit_rescue_48h'),
    false,
    'the chosen rung is not also written off',
  );
});

test('an expired warning is written off rather than arriving a day late', () => {
  const { plan } = walk({ on: '2026-01-09', started: '2026-01-01' });
  const written = plan.superseded.map((e) => e.rung.key);
  assert.ok(written.includes('deposit_overdue') || written.includes('deposit_reminder_1'));
});

test('the catch-up horizon keeps a first run from emailing a year of history', () => {
  // Switched on today, against a booking taken last March. Without the
  // horizon every rung would be due at once and the guest would be cancelled.
  const { plan, byRung } = walk({ on: '2026-10-25', started: '2026-03-01' });

  assert.equal(plan.send, null, 'nothing is sent');
  assert.equal(byRung.get('deposit_cancelled').state, 'stale');
  assert.ok(
    plan.superseded.some((e) => e.rung.key === 'deposit_cancelled'),
    'but it is recorded, not silently dropped',
  );
});

test('the horizon is configurable, and a rung inside it still sends', () => {
  // The same booking as above, with the horizon widened past its age. The
  // play date is kept in the future so the only rungs in play are the
  // deposit ones.
  const wide = { ...ON, BOOKING_TRIGGERS_CATCH_UP_DAYS: '400' };
  const { plan } = walk({
    on: '2026-10-25',
    book: booking({ date: '2027-06-01' }),
    started: '2026-03-01',
    config: wide,
  });
  assert.equal(plan.send.rung.key, 'deposit_cancelled');
});

test('a round that has been played is never cancelled over an unpaid deposit', () => {
  // Both are due on a wide horizon: the cancellation that should have gone
  // out in March, and the thank you for a round played in June. The later day
  // wins, which is the only sane reading — cancelling a played round is not a
  // thing the club can do.
  const wide = { ...ON, BOOKING_TRIGGERS_CATCH_UP_DAYS: '400' };
  const { plan } = walk({ on: '2026-10-25', started: '2026-03-01', config: wide });

  assert.equal(plan.send.rung.key, 'post_play');
  assert.ok(
    plan.superseded.some((e) => e.rung.key === 'deposit_cancelled'),
    'the cancellation is written off, not carried out',
  );
});

test('a rung already in the ledger is settled and never acted on again', () => {
  const already = new Map([['deposit_overdue', { rung: 'deposit_overdue', outcome: 'sent' }]]);
  const { byRung, plan } = walk({ on: '2026-01-08', started: '2026-01-01', already });

  assert.equal(byRung.get('deposit_overdue').state, 'settled');
  // The run falls back to the rung behind it rather than re-sending the one
  // already on the ledger.
  assert.notEqual(plan.send?.rung.key, 'deposit_overdue');
  assert.equal(
    plan.superseded.some((e) => e.rung.key === 'deposit_overdue'),
    false,
    'a settled rung is not written off a second time either',
  );
});

test('a run with every due rung settled sends nothing', () => {
  const already = new Map(
    ['deposit_request', 'deposit_reminder_1', 'deposit_reminder_2', 'deposit_overdue'].map((rung) => [
      rung,
      { rung, outcome: 'sent' },
    ]),
  );
  const { plan } = walk({ on: '2026-01-08', started: '2026-01-01', already });
  assert.equal(plan.send, null);
});

// ---------------------------------------------------------------------------
// The three switches
// ---------------------------------------------------------------------------

test('everything is off by default', () => {
  const config = readTriggerConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.deadlines, false);
  assert.equal(config.unattended, false);
  assert.equal(config.autoCancel, false);
});

test('the switches nest: none of them does anything on its own', () => {
  // Deadlines without the ladder, a schedule without deadlines, auto-cancel
  // without deadlines. Each must stay off.
  assert.equal(readTriggerConfig({ BOOKING_TRIGGERS_DEADLINES: 'true' }).deadlines, false);
  assert.equal(readTriggerConfig({ ...ON, BOOKING_TRIGGERS_SCHEDULE: 'true' }).unattended, true);
  assert.equal(
    readTriggerConfig({ BOOKING_TRIGGERS_ENABLED: 'true', BOOKING_TRIGGERS_SCHEDULE: 'true' }).unattended,
    false,
    'a schedule without deadlines runs nothing',
  );
  assert.equal(
    readTriggerConfig({ BOOKING_TRIGGERS_ENABLED: 'true', BOOKING_TRIGGERS_AUTO_CANCEL: 'true' }).autoCancel,
    false,
    'auto-cancel without deadlines cancels nothing',
  );
});

test('with deadlines off, no rung that cancels a booking is in the ladder at all', () => {
  const reporting = sendableLadder(readTriggerConfig({ BOOKING_TRIGGERS_ENABLED: 'true' }));
  assert.equal(
    reporting.some((rung) => rung.cancels),
    false,
  );
  // The rest of the ladder is still there, so a club can read what it would do.
  assert.ok(reporting.some((rung) => rung.key === 'deposit_overdue'));
  assert.ok(reporting.some((rung) => rung.key === 'confirmation'));
});

test('the visitor dunning can be declined without losing the visitor their receipt or details', () => {
  const off = readTriggerConfig({ ...ON, BOOKING_TRIGGERS_VISITOR_DUNNING: 'false' });
  const ladder = sendableLadder(off);
  const visitorRungs = ladder.filter((rung) => rung.flows.includes('visitor')).map((rung) => rung.key);

  // The extrapolated half of the sheet: gone for visitors.
  for (const chased of ['deposit_reminder_1', 'deposit_overdue', 'deposit_cancelled']) {
    assert.equal(visitorRungs.includes(chased), false, chased);
  }
  // What the sheet does spell out for them: kept.
  for (const kept of ['deposit_receipt', 'confirmation', 'final_details', 'post_play']) {
    assert.ok(visitorRungs.includes(kept), kept);
  }
  // And a trade booking is still chased.
  assert.ok(ladder.find((rung) => rung.key === 'deposit_cancelled').flows.includes('operator'));
});

test("the sheet's numbers are all overridable", () => {
  const config = {
    ...ON,
    BOOKING_DEPOSIT_WINDOW_DAYS: '14',
    BOOKING_DEPOSIT_REMINDER_DAY: '10',
    BOOKING_DEPOSIT_RESCUE_DAY: '21',
    BOOKING_CONFIRMATION_DAYS: '45',
  };
  const byRung = walk({ on: '2026-01-01', started: '2026-01-01', config }).byRung;
  const on = (rung) => byRung.get(rung).dueOn;

  assert.equal(on('deposit_reminder_1'), addDays('2026-01-01', 10));
  assert.equal(on('deposit_reminder_2'), addDays('2026-01-01', 13), '24 hours before the wider window');
  assert.equal(on('deposit_overdue'), addDays('2026-01-01', 14));
  assert.equal(on('deposit_rescue_48h'), addDays('2026-01-01', 19));
  assert.equal(on('deposit_cancelled'), addDays('2026-01-01', 21));
  assert.equal(on('confirmation'), addDays('2026-06-01', -45));
});

// ---------------------------------------------------------------------------
// Visitors
// ---------------------------------------------------------------------------

test('a visitor runs the same ladder, minus the balance phase', () => {
  const { byRung } = walk({ on: '2026-01-08', op: null });
  assert.equal(byRung.get('deposit_overdue').state, 'due');
  assert.equal(byRung.has('balance_notice'), false, 'no balance rung is even evaluated');
});

test('a booking already asked for payment by hand is not asked again', () => {
  const asked = booking({ paymentLinkSentAt: '2026-01-01T10:00:00Z' });
  const { byRung } = walk({ on: '2026-01-01', book: asked, started: '2026-01-01' });
  assert.equal(byRung.get('deposit_request').state, 'skipped');
});

// ---------------------------------------------------------------------------
// Settings a club saves for itself
// ---------------------------------------------------------------------------

test("a club's saved settings beat the environment, which beats the defaults", () => {
  // Nothing saved: exactly the environment the deployment was already running.
  const inherited = readTriggerConfig({ ...ON, BOOKING_DEPOSIT_WINDOW_DAYS: '14' });
  assert.equal(inherited.ladder.depositWindowDays, 14);
  assert.deepEqual(inherited.saved, []);

  // Saved: the club's own number, whatever the environment says.
  const chosen = readTriggerConfig({ ...ON, BOOKING_DEPOSIT_WINDOW_DAYS: '14' }, { depositWindowDays: 21 });
  assert.equal(chosen.ladder.depositWindowDays, 21);
  assert.deepEqual(chosen.saved, ['depositWindowDays']);

  // Neither: the sheet's own number.
  assert.equal(readTriggerConfig(ON).ladder.depositWindowDays, LADDER_DEFAULTS.depositWindowDays);
});

test('a club can switch the ladder on without the environment having been set', () => {
  const config = readTriggerConfig({}, { enabled: true, deadlines: true, scheduled: true });
  assert.equal(config.enabled, true);
  assert.equal(config.deadlines, true);
  assert.equal(config.unattended, true);
});

test('a club can switch it off even where the environment switched it on', () => {
  const config = readTriggerConfig({ ...ON, BOOKING_TRIGGERS_SCHEDULE: 'true' }, { enabled: false });
  assert.equal(config.enabled, false);
  // And the nesting still holds, so nothing below it survives either.
  assert.equal(config.deadlines, false);
  assert.equal(config.unattended, false);
  assert.equal(config.autoCancel, false);
});

test('the switches still nest when they come from saved settings', () => {
  const config = readTriggerConfig({}, { enabled: true, deadlines: false, autoCancel: true, scheduled: true });
  assert.equal(config.autoCancel, false, 'auto-cancel without deadlines cancels nothing');
  assert.equal(config.unattended, false, 'a schedule without deadlines runs nothing');
});

test('how hard a run leans on the database is not a club setting', () => {
  // batch and minutes belong to whoever runs the server, so a saved value for
  // them is ignored rather than honoured.
  const config = readTriggerConfig({ BOOKING_TRIGGERS_BATCH: '50' }, { batch: 99999, minutes: 0.01 });
  assert.equal(config.batch, 50);
  assert.equal(config.minutes, 15);
});

describe('validating what a club tries to save', () => {
  test('a patch of one field leaves the rest alone', () => {
    const check = validateLifecycleSettings({ depositReminderDay: 3 });
    assert.equal(check.ok, true);
    assert.deepEqual(check.value, { depositReminderDay: 3 });
  });

  test('a day count must be a whole number within its bounds', () => {
    assert.equal(validateLifecycleSettings({ depositWindowDays: 0 }).ok, false);
    assert.equal(validateLifecycleSettings({ depositWindowDays: 2.5 }).ok, false);
    assert.equal(validateLifecycleSettings({ depositWindowDays: 1000 }).ok, false);
    assert.equal(validateLifecycleSettings({ depositWindowDays: '7' }).ok, false, 'text is not a number');
    assert.equal(validateLifecycleSettings({ depositWindowDays: 7 }).ok, true);
  });

  test('a switch must be a boolean', () => {
    assert.equal(validateLifecycleSettings({ autoCancel: 'yes' }).ok, false);
    assert.equal(validateLifecycleSettings({ autoCancel: true }).ok, true);
  });

  test('a reminder cannot fall after the deadline it is reminding about', () => {
    const check = validateLifecycleSettings({ depositReminderDay: 9, depositWindowDays: 7 });
    assert.equal(check.ok, false);
    assert.match(check.errors.join(' '), /before the deposit window closes/i);
  });

  test('the final deadline cannot fall before the window it is rescuing', () => {
    const check = validateLifecycleSettings({ depositWindowDays: 14, depositRescueDay: 10 });
    assert.equal(check.ok, false);
    assert.match(check.errors.join(' '), /after the deposit window closes/i);
  });

  test('there has to be room for the 48- and 24-hour notices', () => {
    const tight = validateLifecycleSettings({ depositWindowDays: 7, depositRescueDay: 8 });
    assert.equal(tight.ok, false);
    assert.match(tight.errors.join(' '), /at least two days/i);
    assert.equal(validateLifecycleSettings({ depositWindowDays: 7, depositRescueDay: 9 }).ok, true);
  });

  test('the final details cannot go out before the confirmation', () => {
    const check = validateLifecycleSettings({ confirmationDaysBeforePlay: 10, finalDetailsDaysBeforePlay: 30 });
    assert.equal(check.ok, false);
    assert.match(check.errors.join(' '), /after the confirmation/i);
  });

  test('an ordering is checked against the settings as they would end up, not the patch alone', () => {
    // The club already has a 21-day window saved; moving the reminder to day
    // 9 is fine against that, and would be rejected against the default 7.
    const check = validateLifecycleSettings(
      { depositReminderDay: 9 },
      { current: { depositWindowDays: 21, depositRescueDay: 28 } },
    );
    assert.equal(check.ok, true);

    // And a change that breaks the sequence from the other end is caught.
    const broken = validateLifecycleSettings(
      { depositWindowDays: 5 },
      { current: { depositReminderDay: 9, depositRescueDay: 28 } },
    );
    assert.equal(broken.ok, false);
  });

  test('nothing offered is not an error, it just changes nothing', () => {
    assert.deepEqual(validateLifecycleSettings(undefined), { ok: true, errors: [], value: {} });
    assert.deepEqual(validateLifecycleSettings({}).value, {});
  });

  test('anything that is not an object is refused outright', () => {
    assert.equal(validateLifecycleSettings([1, 2]).ok, false);
    assert.equal(validateLifecycleSettings('enabled').ok, false);
  });

  test('unknown keys are dropped rather than stored', () => {
    const check = validateLifecycleSettings({ depositWindowDays: 7, somethingElse: 'hello', batch: 99 });
    assert.equal(check.ok, true);
    assert.deepEqual(Object.keys(check.value), ['depositWindowDays']);
  });
});

test("a club's own days actually move the ladder", () => {
  const config = readTriggerConfig(ON, { depositWindowDays: 21, depositReminderDay: 14, depositRescueDay: 28 });
  const evaluated = evaluateLadder({
    booking: booking(),
    operator: null,
    ladder: sendableLadder(config),
    today: '2026-01-01',
    lifecycleStartedOn: '2026-01-01',
    catchUpDays: 3,
    ladderConfig: config.ladder,
  });
  const on = (key) => evaluated.find((e) => e.rung.key === key).dueOn;

  assert.equal(on('deposit_reminder_1'), addDays('2026-01-01', 14));
  assert.equal(on('deposit_reminder_2'), addDays('2026-01-01', 20), '24 hours before the wider window');
  assert.equal(on('deposit_overdue'), addDays('2026-01-01', 21));
  assert.equal(on('deposit_rescue_48h'), addDays('2026-01-01', 26));
  assert.equal(on('deposit_cancelled'), addDays('2026-01-01', 28));
});

// ---------------------------------------------------------------------------
// Agreeing with the tour operator module
// ---------------------------------------------------------------------------

test("a trade account is chased towards its own deposit deadline, not the sheet's window", () => {
  // Deposit agreed at 90 days before play, booked long before that: the
  // reminders sit two days and one day before *that* date, as the operator
  // module shows it in the drawer.
  const terms = operator({ depositDueDaysBeforePlay: 90 });
  const byRung = walk({
    on: '2026-01-01',
    book: booking({ date: '2026-06-01' }),
    op: terms,
    started: '2026-01-01',
  }).byRung;

  assert.equal(depositDueOn(booking({ date: '2026-06-01' }), terms, LADDER_DEFAULTS, '2026-01-01'), '2026-03-03');
  assert.equal(byRung.get('deposit_overdue').dueOn, '2026-03-03');
  assert.equal(byRung.get('deposit_reminder_1').dueOn, '2026-03-01');
  assert.equal(byRung.get('deposit_reminder_2').dueOn, '2026-03-02');
  assert.equal(byRung.get('deposit_cancelled').dueOn, '2026-03-06');
});

test('an account with no deposit term falls back to the window from the booking', () => {
  assert.equal(
    depositDueOn(booking(), operator({ depositDueDaysBeforePlay: null }), LADDER_DEFAULTS, '2026-01-01'),
    '2026-01-08',
  );
});

test('a date on the booking wins over the account term', () => {
  assert.equal(
    depositDueOn(
      booking({ depositDueDate: '2026-02-14' }),
      operator({ depositDueDaysBeforePlay: 90 }),
      LADDER_DEFAULTS,
      '2026-01-01',
    ),
    '2026-02-14',
  );
});

test('money goes to the account, the run-up to the tee goes to the guest', () => {
  const book = booking({ guestEmail: 'guest@example.com' });
  const account = operator({ contactEmail: 'accounts@tours.example' });
  const rung = (key) => buildLadder().find((r) => r.key === key);

  assert.equal(recipientFor(rung('deposit_overdue'), book, account), 'accounts@tours.example');
  assert.equal(recipientFor(rung('balance_notice'), book, account), 'accounts@tours.example');
  assert.equal(recipientFor(rung('confirmation'), book, account), 'guest@example.com');
  assert.equal(recipientFor(rung('post_play'), book, account), 'guest@example.com');
  // A visitor is their own account.
  assert.equal(recipientFor(rung('deposit_overdue'), book, null), 'guest@example.com');
  // An account with no contact email falls back to the booking rather than
  // chasing nobody.
  assert.equal(recipientFor(rung('deposit_overdue'), book, operator({ contactEmail: '' })), 'guest@example.com');
});

test('an account switched off for chasing keeps the confirmations and loses the reminders', () => {
  const quiet = operator({ autoChase: false });
  const byRung = walk({
    on: '2026-01-08',
    book: booking({ amountPaid: 250, paymentStatus: 'Deposit paid' }),
    op: quiet,
  }).byRung;

  assert.equal(byRung.has('deposit_overdue'), false, 'not even evaluated');
  assert.equal(byRung.has('balance_notice'), false);
  assert.ok(byRung.has('confirmation'), 'the round-up to the tee is about the round, not the invoice');
  assert.ok(byRung.has('post_play'));
});

test('a retired account is never chased, as the operator module promises', () => {
  assert.equal(chaseable(operator({ active: false })), false);
  assert.equal(chaseable(operator({ active: true, autoChase: true })), true);
  assert.equal(chaseable(null), true, 'a visitor has no account to say otherwise');
});
