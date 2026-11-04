import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGEING_BANDS,
  ageingBand,
  attachOperators,
  buildOperatorIndex,
  describeTerms,
  domainList,
  emailDomain,
  identify,
  isConsumerDomain,
  nameFromDomain,
  paymentState,
  portfolioTotals,
  serialiseOperator,
  suggestOperators,
  summarise,
  summariseAll,
  toOperatorColumns,
  validateOperator,
} from '../src/lib/operators-domain.js';

const TODAY = '2026-04-01';

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
    deposit_due_days_before_play: null,
    balance_due_days_before_play: null,
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
    date: '2026-05-01',
    teeTime: '10:04 AM',
    players: 4,
    total: 1000,
    status: 'Booked',
    tourOperatorId: null,
    paymentStatus: 'Unpaid',
    amountPaid: 0,
    invoiceNumber: '',
    invoicedAt: null,
    depositDueDate: null,
    balanceDueDate: null,
    operatorStatusEmailSentAt: null,
    operatorPaymentEmailSentAt: null,
    ...overrides,
  };
}

// --- identification ---------------------------------------------------------

test('a domain is read off the address, including the awkward spellings', () => {
  assert.equal(emailDomain('ann@golfbreaks.com'), 'golfbreaks.com');
  assert.equal(emailDomain('  <Ann@GolfBreaks.COM> '), 'golfbreaks.com');
  assert.equal(emailDomain('mailto:ann@golfbreaks.com'), 'golfbreaks.com');
  assert.equal(emailDomain('ann@golfbreaks.com.'), 'golfbreaks.com');
  assert.equal(emailDomain('not an address'), null);
  assert.equal(emailDomain('ann@localhost'), null);
  assert.equal(emailDomain(''), null);
});

test('identification is ranked: an assignment beats a domain beats a name', () => {
  const golfbreaks = operator();
  const links = operator({ id: 2, name: 'Links Travel', email_domains: [] });
  const index = buildOperatorIndex([golfbreaks, links]);

  assert.deepEqual(pick(identify(booking({ tourOperatorId: 2 }), index)), { name: 'Links Travel', source: 'assigned' });
  assert.deepEqual(pick(identify(booking(), index)), { name: 'Golfbreaks', source: 'domain' });
  assert.deepEqual(pick(identify(booking({ guestEmail: 'ann@gmail.com', note: 'Booked via Links Travel' }), index)), {
    name: 'Links Travel',
    source: 'name',
  });
  assert.deepEqual(pick(identify(booking({ guestEmail: 'ann@gmail.com', note: 'A family trip' }), index)), {
    name: undefined,
    source: 'direct',
  });
});

test('a name match needs whole words, so it cannot fire on a fragment', () => {
  const index = buildOperatorIndex([operator({ id: 3, name: 'Links', email_domains: [] })]);
  const hit = (note) => identify(booking({ guestEmail: 'ann@gmail.com', note }), index).source;

  assert.equal(hit('travelling with Links this May'), 'name');
  assert.equal(hit('a set of cufflinks as a prize'), 'direct');
});

test('the longest operator name wins, so a parent brand cannot swallow a subsidiary', () => {
  const index = buildOperatorIndex([
    operator({ id: 1, name: 'Golfbreaks', email_domains: [] }),
    operator({ id: 2, name: 'Golfbreaks Ireland', email_domains: [] }),
  ]);

  const match = identify(booking({ guestEmail: 'ann@gmail.com', note: 'Golfbreaks Ireland group of 8' }), index);
  assert.equal(match.operator.name, 'Golfbreaks Ireland');
});

test('unrecognised business domains are proposed as accounts; personal ones never are', () => {
  const index = buildOperatorIndex([]);
  const bookings = [
    booking({ bookingId: 'A', guestEmail: 'tom@perrygolf.com', total: 4000 }),
    booking({ bookingId: 'B', guestEmail: 'sue@perrygolf.com', total: 2000 }),
    booking({ bookingId: 'C', guestEmail: 'one@haversham.co.uk' }),
    booking({ bookingId: 'D', guestEmail: 'someone@gmail.com' }),
    booking({ bookingId: 'E', guestEmail: 'another@gmail.com' }),
    booking({ bookingId: 'F', guestEmail: 'third@gmail.com' }),
  ];

  const suggestions = suggestOperators(bookings, index);
  assert.deepEqual(
    suggestions.map((s) => s.domain),
    ['perrygolf.com'],
  );
  assert.equal(suggestions[0].proposedName, 'Perrygolf');
  assert.equal(suggestions[0].bookings, 2);
  assert.equal(suggestions[0].gross, 6000);
  // One booking from a business domain is not yet a pattern.
  assert.equal(
    suggestions.some((s) => s.domain === 'haversham.co.uk'),
    false,
  );
});

test('a domain already registered to an operator is never offered again', () => {
  const index = buildOperatorIndex([operator()]);
  const suggestions = suggestOperators([booking({ bookingId: 'A' }), booking({ bookingId: 'B' })], index);
  assert.deepEqual(suggestions, []);
});

test('attachOperators labels every booking with its account and the evidence', () => {
  const index = buildOperatorIndex([operator()]);
  const [trade, direct] = attachOperators(
    [booking(), booking({ bookingId: 'RD-2', guestEmail: 'a@gmail.com' })],
    index,
  );

  assert.equal(trade.operatorName, 'Golfbreaks');
  assert.equal(trade.operatorMatch, 'domain');
  assert.equal(direct.operatorName, null);
  assert.equal(direct.operatorMatch, 'direct');
});

// --- credit terms and payment state ----------------------------------------

test('with no lead-time rule, both due dates come off the invoice terms', () => {
  const state = paymentState(booking({ invoicedAt: '2026-03-10' }), operator(), { today: TODAY });

  assert.equal(state.depositDueDate, '2026-04-09');
  assert.equal(state.balanceDueDate, '2026-04-09');
  assert.equal(state.outstanding, 1000);
  assert.equal(state.stage, 'balance'); // a 0% deposit is already behind us
  assert.equal(state.overdue, false);
  assert.equal(state.daysUntilDue, 8);
});

test('an uninvoiced booking still has a date to chase against — the play date', () => {
  const state = paymentState(booking({ date: '2026-05-01' }), operator(), { today: TODAY });
  assert.equal(state.balanceDueDate, '2026-05-31');
});

test('a deposit is invoiced when the booking is taken, not when they play', () => {
  // Carr Golf, as the club found it: "30% deposit, balance due 60 days before
  // play, net 7 days". The deposit had no rule of its own, so it shared the
  // balance's fallback -- the play date -- and came out due a week AFTER the
  // round, ten weeks after the balance. The page read "Deposit outstanding ·
  // due in 346 days" on money that was already twelve days late.
  const terms = operator({
    deposit_percent: 30,
    deposit_due_days_before_play: null,
    balance_due_days_before_play: 60,
    payment_terms_days: 7,
  });
  const state = paymentState(
    booking({ total: 4620, date: '2027-09-25', timestamp: '2026-09-30T10:00:00.000Z' }),
    terms,
    { today: '2026-10-19' },
  );

  assert.equal(state.depositAmount, 1386);
  assert.equal(state.balanceAmount, 3234);
  // Seven days after the booking was taken, which is what the terms say.
  assert.equal(state.depositDueDate, '2026-10-07');
  assert.equal(state.balanceDueDate, '2027-07-27');
  assert.equal(state.stage, 'deposit');
  assert.equal(state.overdue, true);
  assert.equal(state.daysOverdue, 12);
});

test('the deposit clock starts when the booking is booked, not when the enquiry arrived', () => {
  // An enquiry that sits for three weeks before the club says yes. Counting
  // the terms from the enquiry makes the deposit overdue before anybody had
  // agreed to anything -- so it counts from the day it became Booked, which
  // migration 0025 stamps.
  const terms = operator({ deposit_percent: 30, balance_due_days_before_play: 60, payment_terms_days: 7 });
  const enquired = '2026-09-30T10:00:00.000Z';
  const state = paymentState(
    booking({ total: 4620, date: '2027-09-25', timestamp: enquired, bookedAt: '2026-10-21T09:00:00.000Z' }),
    terms,
    { today: '2026-10-25' },
  );

  assert.equal(state.depositDueDate, '2026-10-28', 'seven days after it was booked');
  assert.equal(state.overdue, false, 'and not yet late');

  // Without a stamp -- a booking confirmed before the column existed, or one
  // the bot wrote already Booked -- the enquiry date stands in.
  const unstamped = paymentState(booking({ total: 4620, date: '2027-09-25', timestamp: enquired }), terms, {
    today: '2026-10-25',
  });
  assert.equal(unstamped.depositDueDate, '2026-10-07');
});

test('a deposit is never due after the balance it is a deposit on', () => {
  // The stages are worked in order and what is paid fills the deposit first,
  // so a deposit dated later than the balance makes the NEXT milestone the
  // later of the two. Whatever the terms work out to, the deposit comes first.
  const terms = operator({
    deposit_percent: 30,
    deposit_due_days_before_play: 14,
    balance_due_days_before_play: 60,
    payment_terms_days: 7,
  });
  const state = paymentState(booking({ date: '2027-09-25', timestamp: '2026-09-30T10:00:00.000Z' }), terms, {
    today: '2026-10-19',
  });

  assert.equal(state.balanceDueDate, '2027-07-27');
  assert.equal(state.depositDueDate, '2027-07-27', 'pulled back to the balance rather than left after it');
  assert.ok(state.depositDueDate <= state.balanceDueDate);
});

test('an invoiced booking still takes both dates off the invoice', () => {
  // Once there is an invoice, that is the date the terms run from -- for the
  // deposit as much as the balance. Nothing about this case changes.
  const terms = operator({ deposit_percent: 30, payment_terms_days: 30 });
  const state = paymentState(
    booking({ invoicedAt: '2026-03-10', date: '2026-05-01', timestamp: '2025-01-01T10:00:00.000Z' }),
    terms,
    { today: TODAY },
  );

  assert.equal(state.depositDueDate, '2026-04-09');
  assert.equal(state.balanceDueDate, '2026-04-09');
});

test('a due date typed onto the booking is left exactly as typed', () => {
  // Somebody deciding, rather than a rule misfiring: it is not pulled back to
  // the balance and not recalculated.
  const terms = operator({ deposit_percent: 30, balance_due_days_before_play: 60, payment_terms_days: 7 });
  const state = paymentState(
    booking({ date: '2027-09-25', timestamp: '2026-09-30T10:00:00.000Z', depositDueDate: '2027-09-01' }),
    terms,
    { today: '2026-10-19' },
  );

  assert.equal(state.depositDueDate, '2027-09-01');
  assert.equal(state.stages[0].overridden, true);
});

test('a days-before-play rule beats the invoice terms', () => {
  const terms = operator({
    deposit_percent: 25,
    deposit_due_days_before_play: 60,
    balance_due_days_before_play: 14,
  });
  const state = paymentState(booking({ invoicedAt: '2026-01-01' }), terms, { today: TODAY });

  assert.equal(state.depositAmount, 250);
  assert.equal(state.balanceAmount, 750);
  assert.equal(state.depositDueDate, '2026-03-02');
  assert.equal(state.balanceDueDate, '2026-04-17');
  // Nothing paid, so the deposit is the milestone — and it is already late.
  assert.equal(state.stage, 'deposit');
  assert.equal(state.dueAmount, 250);
  assert.equal(state.daysOverdue, 30);
  assert.equal(state.overdue, true);
});

test('paying the deposit moves the milestone on to the balance', () => {
  const terms = operator({
    deposit_percent: 25,
    deposit_due_days_before_play: 60,
    balance_due_days_before_play: 14,
  });
  const state = paymentState(booking({ amountPaid: 250, paymentStatus: 'Deposit paid' }), terms, { today: TODAY });

  assert.equal(state.stage, 'balance');
  assert.equal(state.dueDate, '2026-04-17');
  assert.equal(state.dueAmount, 750);
  assert.equal(state.overdue, false);
});

test('a booking-level due date overrides the account terms', () => {
  const state = paymentState(booking({ balanceDueDate: '2026-03-01', invoicedAt: '2026-03-10' }), operator(), {
    today: TODAY,
  });
  assert.equal(state.balanceDueDate, '2026-03-01');
  assert.equal(state.daysOverdue, 31);
});

test('being late is derived from the due date, never from the stored status', () => {
  const late = booking({ balanceDueDate: '2026-03-01', paymentStatus: 'Unpaid' });
  assert.equal(paymentState(late, operator(), { today: '2026-02-28' }).overdue, false);
  assert.equal(paymentState(late, operator(), { today: '2026-03-02' }).overdue, true);
});

test('written off and refunded owe nothing, whatever the arithmetic says', () => {
  for (const status of ['Written off', 'Refunded']) {
    const state = paymentState(booking({ paymentStatus: status }), operator(), { today: TODAY });
    assert.equal(state.outstanding, 0, status);
    assert.equal(state.settled, true, status);
    assert.equal(state.stage, null, status);
    assert.equal(state.chaseable, false, status);
  }
});

test('the derived status reports what the money says, beside what was typed', () => {
  const half = paymentState(booking({ amountPaid: 500, paymentStatus: 'Unpaid' }), operator({ deposit_percent: 50 }), {
    today: TODAY,
  });
  assert.equal(half.status, 'Unpaid');
  assert.equal(half.derivedStatus, 'Deposit paid');

  const full = paymentState(booking({ amountPaid: 1000 }), operator(), { today: TODAY });
  assert.equal(full.derivedStatus, 'Paid');
  assert.equal(full.settled, true);
});

test('money is only chased once the club has committed to the tee time', () => {
  for (const status of ['Inquiry', 'Requested', 'Rejected', 'Cancelled']) {
    assert.equal(paymentState(booking({ status }), operator(), { today: TODAY }).chaseable, false, status);
  }
  for (const status of ['Booked']) {
    assert.equal(paymentState(booking({ status }), operator(), { today: TODAY }).chaseable, true, status);
  }
});

test('a booking with no operator is read under the default terms', () => {
  const state = paymentState(booking({ invoicedAt: '2026-02-01' }), null, { today: TODAY });
  assert.equal(state.balanceDueDate, '2026-03-03');
  assert.equal(state.overdue, true);
});

// --- accounts ---------------------------------------------------------------

test('ageing puts each outstanding balance in exactly one band', () => {
  assert.equal(ageingBand(0), 'current');
  assert.equal(ageingBand(1), 'd1_30');
  assert.equal(ageingBand(30), 'd1_30');
  assert.equal(ageingBand(31), 'd31_60');
  assert.equal(ageingBand(90), 'd61_90');
  assert.equal(ageingBand(91), 'd90_plus');
  assert.equal(ageingBand(4000), 'd90_plus');
});

test('exposure counts committed bookings only, so an enquiry cannot breach a limit', () => {
  const account = operator({ credit_limit: 1500 });
  const summary = summarise(
    account,
    [
      booking({ bookingId: 'A', status: 'Booked', balanceDueDate: '2026-03-01' }),
      booking({ bookingId: 'B', status: 'Inquiry', total: 5000 }),
    ],
    { today: TODAY },
  );

  assert.equal(summary.bookings, 2);
  assert.equal(summary.committedGross, 1000);
  assert.equal(summary.outstanding, 1000);
  assert.equal(summary.headroom, 500);
  assert.equal(summary.overLimit, false);
  assert.equal(summary.creditUsedPercent, 67);
  assert.equal(summary.unconfirmed, 1);
  assert.equal(summary.overdueAmount, 1000);
  // Due 1 March, read on 1 April: 31 days late, so the second band.
  assert.equal(summary.ageing.d31_60, 1000);
  assert.equal(summary.ageing.current, 0);
});

test('an account past its limit says so', () => {
  const summary = summarise(operator({ credit_limit: 500 }), [booking({ status: 'Booked' })], { today: TODAY });
  assert.equal(summary.headroom, -500);
  assert.equal(summary.overLimit, true);
});

test('the ageing bands add up to the outstanding balance', () => {
  const summary = summarise(
    operator(),
    [
      booking({ bookingId: 'A', status: 'Booked', balanceDueDate: '2026-05-01' }),
      booking({ bookingId: 'B', status: 'Booked', balanceDueDate: '2026-03-20', total: 500 }),
      booking({ bookingId: 'C', status: 'Booked', balanceDueDate: '2025-11-01', total: 250 }),
    ],
    { today: TODAY },
  );

  const banded = AGEING_BANDS.reduce((sum, band) => sum + summary.ageing[band.id], 0);
  assert.equal(banded, summary.outstanding);
  assert.equal(summary.ageing.current, 1000);
  assert.equal(summary.ageing.d1_30, 500);
  assert.equal(summary.ageing.d90_plus, 250);
});

test('a name-only match stays with the direct bookings until somebody assigns it', () => {
  const account = operator({ name: 'Links Travel', email_domains: [] });
  const { operators: summaries, direct } = summariseAll(
    [account],
    [booking({ guestEmail: 'ann@gmail.com', note: 'Booked through Links Travel' })],
    { today: TODAY },
  );

  assert.equal(summaries[0].bookings, 0);
  assert.equal(direct.bookings, 1);
});

test('an overdue deposit makes the deposit overdue, not the whole round', () => {
  // The account summary used to add the booking's entire outstanding to
  // Overdue the moment any milestone passed. A €4,620 round with an unpaid
  // €1,386 deposit and a balance not due until next July reported €4,620
  // overdue -- three times the money anybody was actually owed.
  const terms = operator({
    deposit_percent: 30,
    balance_due_days_before_play: 60,
    payment_terms_days: 7,
    credit_limit: 10000,
  });
  const account = summarise(
    terms,
    [booking({ total: 4620, date: '2027-09-25', timestamp: '2026-09-30T10:00:00.000Z' })],
    { today: '2026-10-19' },
  );

  assert.equal(account.outstanding, 4620, 'the account is still owed the lot');
  assert.equal(account.overdueAmount, 1386, 'but only the deposit is late');
  assert.equal(account.overdueCount, 1);
  // The ageing table still sums across to the outstanding balance.
  assert.equal(
    Object.values(account.ageing).reduce((sum, value) => sum + value, 0),
    4620,
  );
});

test('the portfolio roll-up adds the accounts up and counts the problems', () => {
  const totals = portfolioTotals([
    summarise(operator({ credit_limit: 100 }), [booking({ status: 'Booked' })], { today: TODAY }),
    summarise(operator({ id: 2, on_hold: true }), [booking({ status: 'Inquiry' })], { today: TODAY }),
  ]);

  assert.equal(totals.operators, 2);
  assert.equal(totals.bookings, 2, 'every row on every account');
  // Counted apart, because they are not the same thing and the value only
  // ever counted the booked one. At County Louth the two differ by a factor
  // of three: 1,302 rows on account, 476 of them actually booked.
  assert.equal(totals.booked, 1, 'and the ones the club has committed to');
  assert.equal(totals.unconfirmed, 1, 'and the ones still only asked for');
  assert.equal(totals.outstanding, 1000);
  assert.equal(totals.overLimit, 1);
  assert.equal(totals.onHold, 1);
});

// --- input handling ---------------------------------------------------------

test('domains are accepted however they are typed, and de-duplicated', () => {
  assert.deepEqual(domainList(' @Golfbreaks.com, https://perrygolf.com/trade ; GOLFBREAKS.COM '), [
    'golfbreaks.com',
    'perrygolf.com',
  ]);
  assert.deepEqual(domainList(null), []);
  assert.deepEqual(domainList(['a.com', 'a.com']), ['a.com']);
});

test('nameFromDomain proposes a starting point', () => {
  assert.equal(nameFromDomain('golfbreaks.com'), 'Golfbreaks');
  assert.equal(nameFromDomain('your-golf-travel.co.uk'), 'Your Golf Travel');
});

test('validation names the one thing that is wrong', () => {
  assert.equal(validateOperator({ name: 'Golfbreaks' }), null);
  assert.match(validateOperator({ name: '  ' }), /Name is required/);
  assert.match(validateOperator({ name: 'A', contactEmail: 'nope' }), /not an address/);
  assert.match(validateOperator({ name: 'A', depositPercent: 120 }), /between 0 and 100/);
  assert.match(validateOperator({ name: 'A', paymentTermsDays: 2.5 }), /whole number of days/);
  assert.match(validateOperator({ name: 'A', creditLimit: -1 }), /cannot be negative/);
  assert.match(validateOperator({ name: 'A', emailDomains: 'not a domain' }), /is not a domain name/);
  assert.equal(validateOperator({ name: 'A', creditLimit: '' }), null);
  assert.equal(validateOperator({ name: 'A', depositDueDaysBeforePlay: '' }), null);
});

test('form input is normalised into the column shapes the table wants', () => {
  const columns = toOperatorColumns({
    name: '  Golfbreaks ',
    contactEmail: 'Trade@Golfbreaks.COM',
    emailDomains: 'golfbreaks.com, @golfbreaks.ie',
    paymentTermsDays: '45',
    depositPercent: '25',
    depositDueDaysBeforePlay: '',
    creditLimit: '15000',
    currency: 'gbp',
    notes: '   ',
  });

  assert.equal(columns.name, 'Golfbreaks');
  assert.equal(columns.contact_email, 'trade@golfbreaks.com');
  assert.deepEqual(columns.email_domains, ['golfbreaks.com', 'golfbreaks.ie']);
  assert.equal(columns.payment_terms_days, 45);
  assert.equal(columns.deposit_percent, 25);
  assert.equal(columns.deposit_due_days_before_play, null);
  assert.equal(columns.credit_limit, 15000);
  assert.equal(columns.currency, 'GBP');
  assert.equal(columns.notes, null);
  assert.equal(columns.active, true);
});

test('terms are written out as a sentence for the screen and the email', () => {
  assert.equal(describeTerms(operator()), 'Net 30 days');
  assert.equal(
    describeTerms(
      operator({
        deposit_percent: 25,
        deposit_due_days_before_play: 60,
        balance_due_days_before_play: 14,
        credit_limit: 20000,
      }),
    ),
    '25% deposit due 60 days before play, balance due 14 days before play, net 30 days, credit limit £20,000',
  );
  assert.equal(describeTerms(operator({ payment_terms_days: 0 })), 'Payable on invoice');
  assert.equal(describeTerms(null), 'No account terms');
});

function pick(match) {
  return { name: match.operator?.name, source: match.source };
}

test('isConsumerDomain knows free mail across providers and countries', () => {
  for (const domain of [
    'gmail.com',
    'proton.me',
    'protonmail.com',
    'gmx.de',
    'gmx.net',
    'mail.com',
    'yandex.ru',
    'zoho.com',
    'icloud.com',
    'me.com',
    'mac.com',
    'aol.com',
    'live.ie',
    'live.com.au',
    'msn.com',
    'yahoo.fr',
    'yahoo.co.jp',
    'hotmail.it',
    'hotmail.co.uk',
    'outlook.de',
    'outlook.com.br',
    'googlemail.com',
    'fastmail.com',
    'tutanota.com',
    'hey.com',
    'qq.com',
    '163.com',
    'web.de',
    't-online.de',
    'orange.fr',
    'free.fr',
    'btinternet.com',
    'sky.com',
    'virginmedia.com',
    'eircom.net',
    'GMAIL.COM',
  ]) {
    assert.equal(isConsumerDomain(domain), true, domain);
  }
});

test('isConsumerDomain leaves business domains alone', () => {
  for (const domain of [
    'linkstours.com',
    'golfbreaks.com',
    'live.golfbreaks.com',
    'yahootours.com',
    'outlookgolf.ie',
    'mailchimp.com',
    'webgolf.co.uk',
    'gmx.example.com',
  ]) {
    assert.equal(isConsumerDomain(domain), false, domain);
  }
  assert.equal(isConsumerDomain(null), false);
});

test('balances are shown only where the club says it records payments', async () => {
  const { tracksPayments } = await import('../src/lib/operators-domain.js');

  // Off unless asked for: outstanding is total minus paid, so a club that
  // records no payments reads as owing its whole book — County Louth's 1,867
  // migrated bookings showed €4.2m outstanding and the same again overdue,
  // which is arithmetic, not debt.
  assert.equal(tracksPayments({}), false);
  assert.equal(tracksPayments({ TRACK_PAYMENTS: '' }), false);
  assert.equal(tracksPayments({ TRACK_PAYMENTS: 'false' }), false);
  assert.equal(tracksPayments({ TRACK_PAYMENTS: 'nonsense' }), false);

  // And back the moment payments are recorded, with the whole history.
  assert.equal(tracksPayments({ TRACK_PAYMENTS: 'true' }), true);
  assert.equal(tracksPayments({ TRACK_PAYMENTS: ' YES ' }), true);
  assert.equal(tracksPayments({ TRACK_PAYMENTS: '1' }), true);
});

test('payments are tracked from a start date, so switching on does not invent a year of debt', async () => {
  const { paymentTracking, inPaymentLedger } = await import('../src/lib/operators-domain.js');

  assert.deepEqual(paymentTracking({ PAYMENTS_TRACKED_FROM: '2026-10-15' }), { tracked: true, from: '2026-10-15' });
  assert.deepEqual(paymentTracking({ PAYMENTS_TRACKED_FROM: 'all' }), { tracked: true, from: null });
  assert.deepEqual(paymentTracking({}), { tracked: false, from: null });
  // A typo must not quietly switch a ledger on, or off: it falls back to the
  // plain flag rather than being read as a date.
  assert.deepEqual(paymentTracking({ PAYMENTS_TRACKED_FROM: '15/10/2026' }), { tracked: false, from: null });
  assert.deepEqual(paymentTracking({ PAYMENTS_TRACKED_FROM: 'nonsense', TRACK_PAYMENTS: 'true' }), {
    tracked: true,
    from: null,
  });

  const tracking = { tracked: true, from: '2026-10-15' };
  const before = { timestamp: '2026-08-01T10:00:00Z', amountPaid: 0 };
  assert.equal(inPaymentLedger(before, tracking), false, 'the back catalogue has no balance');
  assert.equal(inPaymentLedger({ timestamp: '2026-10-15T00:01:00Z' }, tracking), true, 'from the start date on');

  // A real payment pulls an older booking in: taking a card payment on it is
  // a fact about that booking, and it belongs in the figures it now affects.
  assert.equal(inPaymentLedger({ ...before, amountPaid: 250 }, tracking), true);
  assert.equal(inPaymentLedger({ ...before, stripePaidAt: '2026-10-16T09:00:00Z' }, tracking), true);
  assert.equal(inPaymentLedger({ ...before, paymentLinkSentAt: '2026-10-16T09:00:00Z' }, tracking), true);

  // Tracking off means nothing is in the ledger, whatever its date.
  assert.equal(inPaymentLedger({ timestamp: '2027-01-01T00:00:00Z' }, { tracked: false, from: null }), false);
});

test('a booking outside the ledger has a value but no balance, and is never chased', async () => {
  const { paymentState, summarise } = await import('../src/lib/operators-domain.js');
  const tracking = { tracked: true, from: '2026-10-15' };
  const operator = { id: 1, name: 'Links Travel', paymentTermsDays: 30, depositPercent: 50 };
  const old = {
    bookingId: 'OLD-1',
    status: 'Booked',
    date: '2026-09-01',
    total: 1000,
    amountPaid: 0,
    timestamp: '2026-06-01T09:00:00Z',
  };
  const fresh = { ...old, bookingId: 'NEW-1', date: '2027-05-01', timestamp: '2026-10-20T09:00:00Z' };

  const before = paymentState(old, operator, { today: '2026-10-20', tracking });
  assert.equal(before.tracked, false);
  assert.equal(before.gross, 1000, 'the round is still worth what it is worth');
  assert.equal(before.outstanding, 0);
  assert.equal(before.overdue, false);
  assert.equal(before.dueDate, null);
  assert.equal(before.chaseable, false, 'nobody is chased for money that was never recorded');

  const after = paymentState(fresh, operator, { today: '2026-10-20', tracking });
  assert.equal(after.tracked, true);
  assert.equal(after.outstanding, 1000);

  // The totals every page reads are summed from those states, so the old
  // booking's value counts and its phantom balance does not.
  const account = summarise(operator, [old, fresh], { today: '2026-10-20', tracking });
  assert.equal(account.bookings, 2);
  assert.equal(account.committedGross, 2000);
  assert.equal(account.outstanding, 1000, 'only the tracked booking is owed');
  assert.equal(account.overdueAmount, 0);

  // With no cutover at all, nothing is filtered: this is the old behaviour.
  const everything = summarise(operator, [old, fresh], {
    today: '2026-10-20',
    tracking: { tracked: true, from: null },
  });
  assert.equal(everything.outstanding, 2000);
});

test("a trade booking carries its operator's terms, stage by stage", async () => {
  const { paymentState } = await import('../src/lib/operators-domain.js');
  const operator = {
    id: 1,
    name: 'Golfbreaks',
    paymentTermsDays: 30,
    depositPercent: 25,
    depositDueDaysBeforePlay: 60,
    balanceDueDaysBeforePlay: 14,
    creditLimit: null,
  };
  const booking = {
    bookingId: 'B-1',
    status: 'Booked',
    date: '2027-05-01',
    total: 1000,
    amountPaid: 250,
    paymentStatus: 'Deposit paid',
  };

  const state = paymentState(booking, operator, { today: '2026-10-20' });

  // The rule behind the figures travels with them, so the booking can say
  // whose terms produced its dates rather than showing bare numbers.
  assert.equal(state.terms.source, 'operator');
  assert.equal(state.terms.operatorName, 'Golfbreaks');
  assert.equal(state.terms.depositPercent, 25);
  assert.match(state.terms.summary, /25% deposit due 60 days before play/);
  assert.match(state.terms.summary, /balance due 14 days before play/);

  const [deposit, balance] = state.stages;
  assert.equal(deposit.label, 'Deposit (25%)');
  assert.equal(deposit.amount, 250);
  assert.equal(deposit.dueDate, '2027-03-02', '60 days before play');
  assert.equal(deposit.settled, true, 'the 250 paid covers it');
  assert.equal(deposit.outstanding, 0);

  assert.equal(balance.label, 'Balance');
  assert.equal(balance.amount, 750);
  assert.equal(balance.paid, 0, 'what was paid filled the deposit first');
  assert.equal(balance.outstanding, 750);
  assert.equal(balance.dueDate, '2027-04-17', '14 days before play');
  assert.equal(state.stage, 'balance', 'the deposit is behind us');
});

test('a deposit somebody has marked paid is paid, whatever the percentage works out to', async () => {
  // The percentage on an account is a default, and the club's real deposit is
  // not always it: County Louth's accounts all read 30% while the deposits
  // actually taken are EUR 97.50 a head, which on a EUR 385 round is 25.3%.
  // Every such booking computed as short of its deposit, which is how an
  // account that had paid in full came to be chased for the difference.
  const { paymentState } = await import('../src/lib/operators-domain.js');
  const operator = { id: 2, name: 'Links Travel', paymentTermsDays: 7, depositPercent: 30 };
  const booking = {
    bookingId: 'B-3',
    status: 'Booked',
    date: '2027-08-23',
    players: 8,
    total: 3080,
    amountPaid: 780, // 8 x 97.50, the club's own deposit
    paymentStatus: 'Deposit paid',
    bookedAt: '2026-10-19T09:00:00.000Z',
  };

  const state = paymentState(booking, operator, { today: '2026-10-30' });
  const [deposit, balance] = state.stages;
  assert.equal(deposit.amount, 924, 'the account still reads 30%');
  assert.equal(deposit.outstanding, 0, 'but the deposit is settled, because the club says it is');
  assert.equal(deposit.settled, true);
  assert.equal(state.stage, 'balance', 'so the next thing owed is the balance');
  assert.equal(state.dueAmount, 2300, 'what is left to pay');
  assert.equal(state.dueDate, balance.dueDate, 'and it falls due with the balance, not now');

  // Nothing is forgiven: the booking still owes everything it owed.
  assert.equal(state.outstanding, 2300);

  // Without that word, the arithmetic stands and the shortfall is real.
  const unsaid = paymentState({ ...booking, paymentStatus: 'Pending' }, operator, { today: '2026-10-30' });
  assert.equal(unsaid.stage, 'deposit');
  assert.equal(unsaid.dueAmount, 144);
});

test('a part payment is split across the stages, and a date set on the booking says so', async () => {
  const { paymentState, DEFAULT_TERMS } = await import('../src/lib/operators-domain.js');
  const operator = { id: 2, name: 'Links Travel', paymentTermsDays: 30, depositPercent: 50 };
  const booking = {
    bookingId: 'B-2',
    status: 'Booked',
    date: '2027-05-01',
    total: 1000,
    amountPaid: 300,
    // Pending, not "Deposit paid": nobody has said the deposit is settled, so
    // the arithmetic is all there is to go on. See the test below for what
    // happens when somebody does say so.
    paymentStatus: 'Pending',
    balanceDueDate: '2027-01-31',
  };

  const [deposit, balance] = paymentState(booking, operator, { today: '2027-02-10' }).stages;
  assert.equal(deposit.amount, 500);
  assert.equal(deposit.paid, 300, 'the deposit is filled first');
  assert.equal(deposit.outstanding, 200);
  assert.equal(balance.paid, 0, 'and nothing spills into the balance until it is covered');
  assert.equal(balance.outstanding, 500);

  // A date agreed for this booking alone is flagged, so nobody "corrects" it
  // back to what the account's terms would have produced.
  assert.equal(balance.overridden, true);
  assert.equal(balance.dueDate, '2027-01-31');
  assert.equal(balance.overdue, true);
  assert.equal(deposit.overridden, false);

  // A direct booking still says which terms it is being read under.
  const direct = paymentState(booking, null, { today: '2027-02-10' });
  assert.equal(direct.terms.source, 'default');
  assert.equal(direct.terms.operatorName, null);
  assert.equal(direct.terms.paymentTermsDays, DEFAULT_TERMS.paymentTermsDays);
  // No deposit percentage, so there is one stage and it is the whole amount.
  assert.deepEqual(
    direct.stages.map((stage) => stage.label),
    ['Full amount'],
  );
});

test('a booking outside the ledger carries a plan, not a balance', async () => {
  const { paymentState } = await import('../src/lib/operators-domain.js');
  const tracking = { tracked: true, from: '2026-10-15' };
  const old = {
    bookingId: 'OLD-1',
    status: 'Booked',
    date: '2026-12-01',
    total: 1300,
    amountPaid: 0,
    timestamp: '2026-05-01T09:00:00Z',
  };
  const state = paymentState(
    old,
    { id: 1, name: 'Grasshopper Golf', paymentTermsDays: 7, depositPercent: 30, balanceDueDaysBeforePlay: 60 },
    { today: '2026-10-14', tracking },
  );

  // Nothing is owed in ledger terms...
  assert.equal(state.tracked, false);
  assert.equal(state.outstanding, 0);
  assert.equal(state.chaseable, false);

  // ...but the club can still take the deposit on an older booking, and the
  // link panel has to know what to ask for. Sending it is what brings the
  // booking in, so the stages are kept as a plan.
  assert.deepEqual(
    state.stages.map((stage) => [stage.label, stage.amount]),
    [
      ['Deposit (30%)', 390],
      ['Balance', 910],
    ],
  );

  // Nothing sums the stages, so this cannot leak back into the figures: the
  // account's totals come from `outstanding`, which is zero.
  const { summarise } = await import('../src/lib/operators-domain.js');
  const account = summarise({ id: 1, name: 'Grasshopper Golf', paymentTermsDays: 7, depositPercent: 30 }, [old], {
    today: '2026-10-14',
    tracking,
  });
  assert.equal(account.outstanding, 0);
  assert.equal(account.committedGross, 1300);

  // The terms are still named: the account has not changed, only whether the
  // club is counting money against it.
  assert.equal(state.terms.operatorName, 'Grasshopper Golf');
});

test('money actually received is never hidden by a switch', async () => {
  const { inPaymentLedger, paymentState } = await import('../src/lib/operators-domain.js');
  const operator = { id: 1, name: 'Grasshopper Golf', paymentTermsDays: 7, depositPercent: 30 };
  const legacy = { timestamp: '2026-05-01T09:00:00Z', total: 1300 };

  // A club with tracking off still takes the odd card payment, and a
  // dashboard that says nothing is paid while the money is in the bank is
  // worse than any phantom balance the switches exist to suppress.
  for (const tracking of [
    { tracked: false, from: null },
    { tracked: true, from: '2026-10-15' },
  ]) {
    assert.equal(inPaymentLedger({ ...legacy, amountPaid: 390 }, tracking), true);
    assert.equal(inPaymentLedger({ ...legacy, stripePaidAt: '2026-10-15T10:00:00Z' }, tracking), true);
    // A link that is out and awaiting payment counts too: the reply lands
    // against a booking that is already in the ledger.
    assert.equal(inPaymentLedger({ ...legacy, paymentLinkSentAt: '2026-10-15T09:00:00Z' }, tracking), true);
    // ...while a booking nobody has ever paid or billed stays out.
    assert.equal(inPaymentLedger({ ...legacy, amountPaid: 0 }, tracking), false);
  }

  const state = paymentState(
    { bookingId: 'X', status: 'Booked', date: '2027-06-01', total: 1300, amountPaid: 390, ...legacy },
    operator,
    { today: '2026-10-16', tracking: { tracked: false, from: null } },
  );
  assert.equal(state.tracked, true);
  assert.equal(state.paid, 390);
  assert.equal(state.outstanding, 910, 'and the balance that follows from it is owed');
});
