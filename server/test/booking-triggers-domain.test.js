import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LADDER_DEFAULTS,
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
  const byKey = new Map(buildLadder(LADDER_DEFAULTS).map((r) => [r.key, r]));

  // "Payment link requesting payment within 7 days of booking."
  assert.equal(byKey.get('deposit_request').offset, 0);
  // "Re-trigger payment reminder after 5 days of booking."
  assert.equal(byKey.get('deposit_reminder_1').offset, 5);
  // "an additional reminder 24 hours before" the 7-day deadline.
  assert.equal(byKey.get('deposit_reminder_2').offset, 6);
  // "If no payment received after 7 day window after booking."
  assert.equal(byKey.get('deposit_overdue').offset, 7);
  // "another reminder 48 hours then 24 hours" before the second deadline.
  assert.equal(byKey.get('deposit_rescue_48h').offset, 8);
  assert.equal(byKey.get('deposit_rescue_24h').offset, 9);
  assert.equal(byKey.get('deposit_cancelled').offset, 10);
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
  const config = readTriggerConfig({
    ...ON,
    BOOKING_DEPOSIT_WINDOW_DAYS: '14',
    BOOKING_DEPOSIT_REMINDER_DAY: '10',
    BOOKING_DEPOSIT_RESCUE_DAY: '21',
    BOOKING_CONFIRMATION_DAYS: '45',
  });
  const byKey = new Map(sendableLadder(config).map((r) => [r.key, r]));

  assert.equal(byKey.get('deposit_reminder_1').offset, 10);
  assert.equal(byKey.get('deposit_reminder_2').offset, 13, '24 hours before the wider window');
  assert.equal(byKey.get('deposit_overdue').offset, 14);
  assert.equal(byKey.get('deposit_rescue_48h').offset, 19);
  assert.equal(byKey.get('deposit_cancelled').offset, 21);
  assert.equal(byKey.get('confirmation').offset, -45);
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
