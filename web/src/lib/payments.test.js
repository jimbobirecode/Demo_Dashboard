import { describe, expect, test } from 'vitest';
import {
  defaultAmount,
  nextStage,
  stageChoices,
  awaitingPayment,
  matchesPaymentView,
  paymentRank,
  paymentStatusOf,
} from './payments.js';

/**
 * What the payment-link panel offers to ask for.
 *
 * The account's terms already say the deposit is 25% and when it falls due.
 * Staff were reading that off the Tour Operators page and doing the sum into
 * the amount box, which is both a waste and a way to email a guest the wrong
 * figure.
 */
const booking = (payment) => ({ bookingId: 'B-1', total: 1000, payment });

const unpaid = {
  gross: 1000,
  outstanding: 1000,
  stage: 'deposit',
  stages: [
    {
      id: 'deposit',
      label: 'Deposit (25%)',
      amount: 250,
      paid: 0,
      outstanding: 250,
      dueDate: '2027-03-02',
      settled: false,
    },
    { id: 'balance', label: 'Balance', amount: 750, paid: 0, outstanding: 750, dueDate: '2027-04-17', settled: false },
  ],
};

const depositPaid = {
  gross: 1000,
  outstanding: 750,
  stage: 'balance',
  stages: [
    {
      id: 'deposit',
      label: 'Deposit (25%)',
      amount: 250,
      paid: 250,
      outstanding: 0,
      dueDate: '2027-03-02',
      settled: true,
    },
    { id: 'balance', label: 'Balance', amount: 750, paid: 0, outstanding: 750, dueDate: '2027-04-17', settled: false },
  ],
};

describe('what the panel asks for', () => {
  test('opens on the deposit, not on the whole booking', () => {
    expect(defaultAmount(booking(unpaid))).toBe('250');
    expect(nextStage(booking(unpaid)).label).toBe('Deposit (25%)');
  });

  test('once the deposit is paid, the balance takes over by itself', () => {
    expect(defaultAmount(booking(depositPaid))).toBe('750');
    expect(nextStage(booking(depositPaid)).id).toBe('balance');
  });

  test('every amount worth a click is offered by name', () => {
    expect(stageChoices(booking(unpaid))).toEqual([
      { id: 'deposit', label: 'Deposit (25%)', amount: 250, dueDate: '2027-03-02' },
      { id: 'balance', label: 'Balance', amount: 750, dueDate: '2027-04-17' },
      { id: 'full', label: 'Everything outstanding', amount: 1000, dueDate: null },
    ]);

    // A settled stage is not offered, and "everything" is not repeated when
    // the one remaining stage already is everything.
    expect(stageChoices(booking(depositPaid))).toEqual([
      { id: 'balance', label: 'Balance', amount: 750, dueDate: '2027-04-17' },
    ]);
  });

  test('a booking with no stages still offers something sensible', () => {
    // Direct booking, no deposit terms, or one outside the payment ledger.
    expect(defaultAmount(booking({ gross: 400, outstanding: 400, stage: null, stages: [] }))).toBe('400');
    expect(defaultAmount(booking({ gross: 400, outstanding: 0, stage: null, stages: [] }))).toBe('1000');
    expect(defaultAmount({ bookingId: 'B-2', total: 500 })).toBe('500');
    expect(stageChoices({ bookingId: 'B-2', total: 500 })).toEqual([]);
  });
});

describe('a booking from before payments were tracked', () => {
  // It has a plan and no ledger position: `stage` is null and nothing is
  // "outstanding", but the club can still take the deposit — and doing so is
  // what brings the booking into the ledger.
  const untracked = {
    tracked: false,
    gross: 1300,
    outstanding: 0,
    stage: null,
    stages: [
      { id: 'deposit', label: 'Deposit (30%)', amount: 390, paid: 0, outstanding: 390, dueDate: null, settled: false },
      { id: 'balance', label: 'Balance', amount: 910, paid: 0, outstanding: 910, dueDate: null, settled: false },
    ],
  };

  test('the box still opens on the deposit, not on the whole booking', () => {
    expect(defaultAmount(booking(untracked))).toBe('390');
    expect(nextStage(booking(untracked)).label).toBe('Deposit (30%)');
  });

  test('and the full value is offered as well, since nothing is "outstanding" yet', () => {
    expect(stageChoices(booking(untracked))).toEqual([
      { id: 'deposit', label: 'Deposit (30%)', amount: 390, dueDate: null },
      { id: 'balance', label: 'Balance', amount: 910, dueDate: null },
      { id: 'full', label: 'Everything outstanding', amount: 1300, dueDate: null },
    ]);
  });
});

describe('booked, and still owed for', () => {
  const booked = (payment) => ({ status: 'Booked', payment });

  test('a booked round with a balance is pending payment', () => {
    expect(awaitingPayment(booked({ outstanding: 1386 }))).toBe(true);
  });

  test('a settled one is not, and neither is an enquiry that happens to owe', () => {
    expect(awaitingPayment(booked({ outstanding: 0 }))).toBe(false);
    expect(awaitingPayment({ status: 'Inquiry', payment: { outstanding: 1386 } })).toBe(false);
  });

  test('the back catalogue stays out of it on its own', () => {
    // A booking taken before the club started recording payments comes back
    // settled with nothing outstanding -- a value, not a balance -- so this
    // needs to know nothing about the cutover.
    expect(awaitingPayment(booked({ outstanding: 0, tracked: false, settled: true }))).toBe(false);
  });

  test('a booking with no payment state at all is not claimed as owing', () => {
    expect(awaitingPayment({ status: 'Booked' })).toBe(false);
    expect(awaitingPayment(null)).toBe(false);
  });
});

describe('payment status, which shares a word with the booking pipeline', () => {
  test("'Pending' here is a payment link sent, not the old spelling of an enquiry", () => {
    // status.js reads 'Pending' as the Streamlit-era 'Inquiry'. Running a
    // payment status through that would file every sent payment link under a
    // booking stage.
    expect(paymentStatusOf('Pending')).toBe('Pending');
    expect(paymentRank('Pending')).toBe(1);
    expect(matchesPaymentView({ payment: { status: 'Pending' } }, 'status:Pending')).toBe(true);
  });

  test('statuses rank in the order money moves, not alphabetically', () => {
    // Sorted by the word, "Deposit paid" lands above "Unpaid" and says nothing.
    expect(paymentRank('Unpaid')).toBeLessThan(paymentRank('Deposit paid'));
    expect(paymentRank('Deposit paid')).toBeLessThan(paymentRank('Paid'));
    expect(paymentRank('something else')).toBeGreaterThan(paymentRank('Written off'));
  });
});

describe('narrowing a list of what is owed', () => {
  const booking = (payment) => ({ status: 'Booked', payment });

  test('no view at all keeps everything', () => {
    expect(matchesPaymentView(booking({ status: 'Unpaid' }), '')).toBe(true);
  });

  test('overdue, and due but not yet late, are told apart', () => {
    const late = booking({ status: 'Unpaid', overdue: true, dueDate: '2026-10-07' });
    const soon = booking({ status: 'Unpaid', overdue: false, dueDate: '2027-07-27' });
    expect(matchesPaymentView(late, 'overdue')).toBe(true);
    expect(matchesPaymentView(soon, 'overdue')).toBe(false);
    expect(matchesPaymentView(soon, 'due-soon')).toBe(true);
    expect(matchesPaymentView(late, 'due-soon')).toBe(false);
  });

  test('a booking with no due date is its own case, not "due soon"', () => {
    const undated = booking({ status: 'Unpaid', overdue: false, dueDate: null });
    expect(matchesPaymentView(undated, 'no-due-date')).toBe(true);
    expect(matchesPaymentView(undated, 'due-soon')).toBe(false);
  });

  test('an unknown view is ignored rather than hiding the lot', () => {
    expect(matchesPaymentView(booking({ status: 'Unpaid' }), 'nonsense')).toBe(true);
  });
});
