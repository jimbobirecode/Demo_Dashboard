import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { WRITTEN_RUNGS, buildLifecycleEmail, hasBuiltInEmail } from '../src/lib/lifecycle-emails.js';
import { buildLadder, moneyState, readTriggerConfig, sendableLadder } from '../src/lib/booking-triggers-domain.js';
import { formatMoney } from '../src/lib/payment-link-domain.js';

// The manage-booking link is signed, so without a secret there is no link
// to offer and the emails leave it out. Set before anything builds one.
process.env.BOOKING_LINK_SECRET ??= 'lifecycle-email-test-secret-0123456789';

function booking(overrides = {}) {
  return {
    bookingId: 'RD-4001',
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
    golfCourses: 'Championship',
    paymentLinkUrl: 'https://pay.example.com/abc',
    caddieRequirements: '2 caddies',
    ...overrides,
  };
}

const money = (book = booking(), today = '2026-01-08') => moneyState(book, null, today);

function build(rung, overrides = {}, dueOn = '2026-01-08') {
  const book = booking(overrides);
  return buildLifecycleEmail(rung, { booking: book, money: money(book), dueOn });
}

// ---------------------------------------------------------------------------
// Every rung on the ladder has something to say
// ---------------------------------------------------------------------------

test('every rung the ladder can send has copy written for it', () => {
  const ladder = sendableLadder(
    readTriggerConfig({ BOOKING_TRIGGERS_ENABLED: 'true', BOOKING_TRIGGERS_DEADLINES: 'true' }),
  );

  for (const rung of ladder) {
    assert.ok(hasBuiltInEmail(rung.key), `no email written for ${rung.key}`);
  }
  // And nothing is written for a rung that does not exist, which would be a
  // leftover nobody sends.
  const keys = new Set(buildLadder().map((rung) => rung.key));
  for (const written of WRITTEN_RUNGS) {
    assert.ok(keys.has(written), `copy written for ${written}, which is not a rung`);
  }
});

test('an unknown rung writes nothing rather than a blank email', () => {
  assert.equal(buildLifecycleEmail('not_a_rung', { booking: booking(), money: money() }), null);
  assert.equal(hasBuiltInEmail('not_a_rung'), false);
});

describe('every email', () => {
  for (const rung of WRITTEN_RUNGS) {
    test(`${rung} is complete and leaves nothing unfilled`, () => {
      const mail = build(rung);

      assert.ok(mail.subject.length > 5, 'needs a subject');
      assert.ok(mail.text.length > 80, 'needs a readable plain-text part');
      assert.ok(mail.html.startsWith('<!DOCTYPE html>'), 'needs a full HTML document');

      // The two parts must tell the same story.
      assert.ok(mail.text.includes('Ann'), 'greets the guest by name');
      assert.ok(mail.html.includes('Ann'), 'greets the guest by name in HTML too');

      // Nothing half-interpolated, and no stray template syntax.
      for (const smell of ['undefined', 'NaN', '[object Object]', '{{', '${']) {
        assert.equal(mail.subject.includes(smell), false, `subject contains ${smell}`);
        assert.equal(mail.text.includes(smell), false, `text contains ${smell}`);
        assert.equal(mail.html.includes(smell), false, `html contains ${smell}`);
      }
    });
  }
});

test('a booking with no name is still greeted, not addressed to nobody', () => {
  const mail = build('deposit_request', { guestName: '' });
  assert.match(mail.text, /^Hi there,/);
});

// ---------------------------------------------------------------------------
// What the chasing emails actually say
// ---------------------------------------------------------------------------

describe('chasing a deposit', () => {
  test('the first ask names the amount, the deadline and how to pay', () => {
    const mail = build('deposit_request', {}, '2026-01-08');
    assert.match(mail.subject, /secure your booking/i);
    assert.ok(mail.text.includes(formatMoney(1000)), 'names what is owed');
    assert.ok(mail.text.includes('8 January'), 'names the deadline');
    assert.ok(mail.text.includes('https://pay.example.com/abc'), 'gives the link that does it');
    assert.ok(mail.html.includes('https://pay.example.com/abc'));
  });

  test('each step towards cancelling is plainer than the one before it', () => {
    const subjects = [
      'deposit_reminder_1',
      'deposit_reminder_2',
      'deposit_overdue',
      'deposit_rescue_48h',
      'deposit_rescue_24h',
    ].map((rung) => build(rung).subject);

    assert.match(subjects[0], /reminder/i);
    assert.match(subjects[1], /24 hours left/i);
    assert.match(subjects[2], /at risk/i);
    assert.match(subjects[3], /48 hours/i);
    assert.match(subjects[4], /final notice/i);
  });

  test('every warning offers a way out, not just a complaint', () => {
    for (const rung of ['deposit_overdue', 'deposit_rescue_48h', 'deposit_rescue_24h']) {
      const mail = build(rung);
      assert.ok(mail.text.includes('https://pay.example.com/abc'), `${rung} gives no way to pay`);
      assert.match(mail.html, /Pay now and keep my booking/, `${rung} has no call to action`);
    }
  });

  test('the cancellation says it is done, asks for nothing, and leaves a door open', () => {
    const mail = build('deposit_cancelled');
    assert.match(mail.subject, /has been cancelled/i);
    assert.match(mail.text, /nothing is owed and there is nothing further to do/i);
    assert.match(mail.text, /please reply/i);
    // Asking a cancelled guest to pay would be absurd.
    assert.equal(mail.text.includes('https://pay.example.com/abc'), false);
  });

  test('a booking with no payment link still sends, without a dead button', () => {
    const mail = build('deposit_request', { paymentLinkUrl: null });
    assert.ok(mail.subject.length > 5);
    assert.equal(mail.html.includes('Pay now'), false, 'no button with nowhere to go');
    assert.ok(mail.text.includes(formatMoney(1000)), 'still says what is owed');
  });
});

describe('the receipt', () => {
  test('a part payment says what is left, and when', () => {
    const part = booking({ amountPaid: 250, paymentStatus: 'Deposit paid', balanceDueDate: '2026-04-02' });
    const mail = buildLifecycleEmail('deposit_receipt', { booking: part, money: money(part), dueOn: '2026-01-08' });

    assert.match(mail.subject, /payment received/i);
    assert.ok(mail.text.includes(formatMoney(250)), 'what arrived');
    assert.ok(mail.text.includes(formatMoney(750)), 'what is left');
    assert.ok(mail.text.includes('2 April'), 'when the rest is due');
  });

  test('a payment in full says so and promises nothing further to pay', () => {
    const paid = booking({ amountPaid: 1000, paymentStatus: 'Paid' });
    const mail = buildLifecycleEmail('deposit_receipt', { booking: paid, money: money(paid) });

    assert.match(mail.text, /paid in full/i);
    assert.equal(/A balance of/.test(mail.text), false);
  });
});

describe('the run-up to the tee', () => {
  test('the confirmation carries the round, and the caddie answer where there is one', () => {
    const mail = build('confirmation');
    assert.ok(mail.text.includes('RD-4001'));
    assert.ok(mail.text.includes('Monday, 1 June 2026'));
    assert.ok(mail.text.includes('08:40'));
    assert.ok(mail.text.includes('2 caddies'), 'tells them what we have them down for');
  });

  test('a booking with no caddie answer simply does not mention caddies', () => {
    const mail = build('confirmation', { caddieRequirements: '' });
    assert.equal(/caddie/i.test(mail.text), false);
  });

  test('the thank you names the course played', () => {
    const mail = build('post_play');
    assert.match(mail.subject, /thank you for playing championship/i);
  });

  test('every guest email offers a way to change or cancel the booking', () => {
    for (const rung of ['confirmation', 'final_details', 'deposit_request']) {
      assert.match(build(rung).text, /change or cancel/i, `${rung} offers no way to manage the booking`);
    }
  });
});

describe('chasing a trade balance', () => {
  test('the notice names the balance and its date', () => {
    const trade = booking({ amountPaid: 250, paymentStatus: 'Deposit paid' });
    const mail = buildLifecycleEmail('balance_notice', {
      booking: trade,
      money: money(trade, '2026-03-23'),
      dueOn: '2026-04-02',
    });

    assert.match(mail.subject, /balance due 2 April/i);
    assert.ok(mail.text.includes(formatMoney(750)));
    assert.ok(mail.text.includes(formatMoney(1000)), 'and the total it is part of');
  });

  test('the cancellation explains what happens to money already paid', () => {
    const trade = booking({ amountPaid: 250, paymentStatus: 'Deposit paid' });
    const mail = buildLifecycleEmail('balance_cancelled', { booking: trade, money: money(trade) });
    assert.match(mail.text, /deposit already paid will be dealt with/i);
  });
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

test('anything a guest typed is escaped before it reaches the HTML', () => {
  const nasty = booking({
    guestName: '<script>alert(1)</script>Ann',
    caddieRequirements: '2 caddies & a <b>forecaddie</b>',
  });
  const mail = buildLifecycleEmail('confirmation', { booking: nasty, money: money(nasty) });

  assert.equal(mail.html.includes('<script>'), false, 'a script tag reached the email body');
  assert.ok(mail.html.includes('&lt;script&gt;'));
  assert.ok(mail.html.includes('&amp;'), 'an ampersand from the guest is escaped');
});

describe('what the money is called', () => {
  test('a part payment is a deposit', () => {
    // A trade account owing 25% up front.
    const trade = booking();
    const quarter = { ...money(trade), depositAmount: 250, gross: 1000, dueAmount: 250, outstanding: 1000 };
    const mail = buildLifecycleEmail('deposit_request', { booking: trade, money: quarter, dueOn: '2026-01-08' });

    assert.match(mail.text, /we need a deposit of/i);
  });

  test('the whole amount is a payment, not a deposit', () => {
    // A visitor with no deposit percentage owes all of it, and being asked for
    // "a deposit of €1,000" on a €1,000 round reads as a mistake.
    const mail = build('deposit_request');
    assert.match(mail.text, /we need a payment of/i);
    assert.equal(/deposit/i.test(mail.text), false, 'nothing here should call it a deposit');
  });

  test('the reminders agree with the first ask', () => {
    for (const rung of ['deposit_reminder_1', 'deposit_reminder_2', 'deposit_overdue', 'deposit_rescue_48h']) {
      assert.equal(/deposit/i.test(build(rung).text), false, `${rung} still calls it a deposit`);
    }
  });
});

describe('who gets greeted', () => {
  test('a guest is greeted by their first name', () => {
    assert.match(build('deposit_request').text, /^Hi Ann,/);
  });

  test('a trade account is not greeted by the first word of its company name', () => {
    // "Highland Golf Tours" split on whitespace reads "Hi Highland," which is
    // nobody's name and sounds like a mailshot.
    const trade = booking({ guestName: 'Highland Golf Tours' });
    const account = { name: 'Highland Golf Tours', contactName: '' };
    const mail = buildLifecycleEmail('balance_notice', { booking: trade, money: money(trade), operator: account });

    assert.match(mail.text, /^Hi Highland Golf Tours,/);
  });

  test("an account's named contact is greeted as a person", () => {
    const trade = booking({ guestName: 'Highland Golf Tours' });
    const account = { name: 'Highland Golf Tours', contactName: 'Fiona Ross' };
    const mail = buildLifecycleEmail('balance_notice', { booking: trade, money: money(trade), operator: account });

    assert.match(mail.text, /^Hi Fiona,/);
  });
});
