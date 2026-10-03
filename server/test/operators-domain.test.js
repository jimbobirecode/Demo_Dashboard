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

  assert.deepEqual(
    pick(identify(booking({ tourOperatorId: 2 }), index)),
    { name: 'Links Travel', source: 'assigned' },
  );
  assert.deepEqual(
    pick(identify(booking(), index)),
    { name: 'Golfbreaks', source: 'domain' },
  );
  assert.deepEqual(
    pick(identify(booking({ guestEmail: 'ann@gmail.com', note: 'Booked via Links Travel' }), index)),
    { name: 'Links Travel', source: 'name' },
  );
  assert.deepEqual(
    pick(identify(booking({ guestEmail: 'ann@gmail.com', note: 'A family trip' }), index)),
    { name: undefined, source: 'direct' },
  );
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

  const match = identify(
    booking({ guestEmail: 'ann@gmail.com', note: 'Golfbreaks Ireland group of 8' }),
    index,
  );
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
  assert.deepEqual(suggestions.map((s) => s.domain), ['perrygolf.com']);
  assert.equal(suggestions[0].proposedName, 'Perrygolf');
  assert.equal(suggestions[0].bookings, 2);
  assert.equal(suggestions[0].gross, 6000);
  // One booking from a business domain is not yet a pattern.
  assert.equal(suggestions.some((s) => s.domain === 'haversham.co.uk'), false);
});

test('a domain already registered to an operator is never offered again', () => {
  const index = buildOperatorIndex([operator()]);
  const suggestions = suggestOperators(
    [booking({ bookingId: 'A' }), booking({ bookingId: 'B' })],
    index,
  );
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
  const state = paymentState(
    booking({ amountPaid: 250, paymentStatus: 'Deposit paid' }),
    terms,
    { today: TODAY },
  );

  assert.equal(state.stage, 'balance');
  assert.equal(state.dueDate, '2026-04-17');
  assert.equal(state.dueAmount, 750);
  assert.equal(state.overdue, false);
});

test('a booking-level due date overrides the account terms', () => {
  const state = paymentState(
    booking({ balanceDueDate: '2026-03-01', invoicedAt: '2026-03-10' }),
    operator(),
    { today: TODAY },
  );
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
  const half = paymentState(
    booking({ amountPaid: 500, paymentStatus: 'Unpaid' }),
    operator({ deposit_percent: 50 }),
    { today: TODAY },
  );
  assert.equal(half.status, 'Unpaid');
  assert.equal(half.derivedStatus, 'Deposit paid');

  const full = paymentState(booking({ amountPaid: 1000 }), operator(), { today: TODAY });
  assert.equal(full.derivedStatus, 'Paid');
  assert.equal(full.settled, true);
});

test('money is only chased once the club has committed to the tee time', () => {
  for (const status of ['Inquiry', 'Requested', 'Rejected', 'Cancelled']) {
    assert.equal(
      paymentState(booking({ status }), operator(), { today: TODAY }).chaseable,
      false,
      status,
    );
  }
  for (const status of ['Booked']) {
    assert.equal(
      paymentState(booking({ status }), operator(), { today: TODAY }).chaseable,
      true,
      status,
    );
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
  const summary = summarise(
    operator({ credit_limit: 500 }),
    [booking({ status: 'Booked' })],
    { today: TODAY },
  );
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

test('the portfolio roll-up adds the accounts up and counts the problems', () => {
  const totals = portfolioTotals([
    summarise(operator({ credit_limit: 100 }), [booking({ status: 'Booked' })], { today: TODAY }),
    summarise(operator({ id: 2, on_hold: true }), [booking({ status: 'Inquiry' })], { today: TODAY }),
  ]);

  assert.equal(totals.operators, 2);
  assert.equal(totals.bookings, 2);
  assert.equal(totals.outstanding, 1000);
  assert.equal(totals.overLimit, 1);
  assert.equal(totals.onHold, 1);
  assert.equal(totals.unconfirmed, 1);
});

// --- input handling ---------------------------------------------------------

test('domains are accepted however they are typed, and de-duplicated', () => {
  assert.deepEqual(
    domainList(' @Golfbreaks.com, https://perrygolf.com/trade ; GOLFBREAKS.COM '),
    ['golfbreaks.com', 'perrygolf.com'],
  );
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
    describeTerms(operator({ deposit_percent: 25, deposit_due_days_before_play: 60, balance_due_days_before_play: 14, credit_limit: 20000 })),
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
    'gmail.com', 'proton.me', 'protonmail.com', 'gmx.de', 'gmx.net', 'mail.com', 'yandex.ru',
    'zoho.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'live.ie', 'live.com.au', 'msn.com',
    'yahoo.fr', 'yahoo.co.jp', 'hotmail.it', 'hotmail.co.uk', 'outlook.de', 'outlook.com.br',
    'googlemail.com', 'fastmail.com', 'tutanota.com', 'hey.com', 'qq.com', '163.com', 'web.de',
    't-online.de', 'orange.fr', 'free.fr', 'btinternet.com', 'sky.com', 'virginmedia.com',
    'eircom.net', 'GMAIL.COM',
  ]) {
    assert.equal(isConsumerDomain(domain), true, domain);
  }
});

test('isConsumerDomain leaves business domains alone', () => {
  for (const domain of [
    'linkstours.com', 'golfbreaks.com', 'live.golfbreaks.com', 'yahootours.com', 'outlookgolf.ie',
    'mailchimp.com', 'webgolf.co.uk', 'gmx.example.com',
  ]) {
    assert.equal(isConsumerDomain(domain), false, domain);
  }
  assert.equal(isConsumerDomain(null), false);
});
