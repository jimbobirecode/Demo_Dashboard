/**
 * The guard that would have caught the deposit bug on its first run.
 *
 * The figure in the sentence and the figure on the button came from two
 * computations, and for five days they disagreed: every deposit email asked a
 * 30% account for the whole round while the Stripe link beside it charged the
 * deposit. Twenty-nine emails went out, because nothing compared them.
 *
 * They are compared now, on every send of a money rung, and a disagreement
 * stops the email rather than posting it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyDisagreement } from '../src/lib/booking-trigger-runner.js';
import { getStep } from '../src/lib/booking-triggers-domain.js';

const chase = getStep('deposit_reminder');
const arrival = getStep('pre_arrival_confirmation');

test('agreement is silence', () => {
  assert.equal(moneyDisagreement(chase, { due_raw: 924 }, { dueAmount: 924, tracked: true }), '');
  // Both sides round to cents; a float comparison that demanded exactness
  // would refuse perfectly good emails.
  assert.equal(moneyDisagreement(chase, { due_raw: 924.001 }, { dueAmount: 924, tracked: true }), '');
});

test('the bug as it happened is refused, and says both figures', () => {
  const refusal = moneyDisagreement(chase, { due_raw: 3080 }, { dueAmount: 924, tracked: true });
  assert.match(refusal, /3080\.00/);
  assert.match(refusal, /924\.00/);
  assert.match(refusal, /Nothing was sent/);
  assert.match(refusal, /fault in the dashboard/, 'the club is told where the fault is, not left guessing');
});

test('a missing figure is refused too, rather than emailed as a blank or a NaN', () => {
  assert.match(moneyDisagreement(chase, {}, { dueAmount: 924, tracked: true }), /could not work out/);
  assert.match(moneyDisagreement(chase, { due_raw: 924 }, {}), /could not work out/);
  assert.match(moneyDisagreement(chase, { due_raw: 'nine' }, { dueAmount: 924, tracked: true }), /could not work out/);
});

test('the rungs that quote no figure are not held up by it', () => {
  // The round-up to the tee is about the round, not the bill.
  assert.equal(moneyDisagreement(arrival, { due_raw: 3080 }, { dueAmount: 924, tracked: true }), '');
  // Outside the payment ledger there is no balance to disagree about.
  assert.equal(moneyDisagreement(chase, { due_raw: 3080 }, { dueAmount: 0, tracked: false }), '');
});
