/**
 * One booking's ladder.
 *
 * It was eleven rows of six columns: a trigger number, the step, a date, a
 * state, a sentence explaining the state, and a button. Four of the eleven
 * said "Not applicable" about steps that will never fire for that booking, and
 * most of the explanations repeated the state beside them — "Done · Already
 * done".
 */
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingLadder from './BookingLadder.jsx';

const step = (over) => ({
  step: over.step,
  label: over.label ?? over.step,
  trigger: over.trigger ?? 'Trigger 1',
  dueOn: over.dueOn ?? '2026-10-25',
  reason: over.reason ?? '',
  state: over.state ?? 'upcoming',
});

// County Louth's BOOK-20261020-5B07AD77, as the page found it.
const STEPS = [
  step({
    step: 'link',
    label: 'Payment link to secure the booking',
    state: 'missed',
    dueOn: '2026-10-20',
    reason: '9 days past its date — too late to send unprompted',
  }),
  step({ step: 'warn', label: 'Deposit reminder, warning of cancellation', state: 'sent', reason: 'Already done' }),
  step({
    step: 'last',
    label: 'Deposit reminder, 24 hours before the window closes',
    state: 'sent',
    reason: 'Already done',
  }),
  step({ step: 'closed', label: 'Deposit window closed', state: 'sent', reason: 'Already done' }),
  step({
    step: 'rescue48',
    label: 'Rescue reminder, 48 hours before cancellation',
    state: 'sent',
    reason: 'Already done',
  }),
  step({
    step: 'rescue24',
    label: 'Rescue reminder, 24 hours before cancellation',
    state: 'due',
    dueOn: '2026-10-29',
    reason: 'Due today',
  }),
  step({
    step: 'cancel',
    label: 'Cancellation issued, booking released',
    state: 'upcoming',
    dueOn: '2026-10-30',
    reason: 'Due 2026-10-30',
  }),
  step({ step: 'thanks', label: 'Thank you for the payment', state: 'skipped', reason: 'Secured by a payment' }),
  step({
    step: 'ten',
    label: 'Ten days left to settle the balance',
    state: 'skipped',
    reason: 'Deposit paid, balance outstanding',
  }),
  step({
    step: 'bal48',
    label: 'Balance reminder, 48 hours before the deadline',
    state: 'skipped',
    reason: 'Deposit paid, balance outstanding',
  }),
];

const ladder = (steps = STEPS, onClear = vi.fn()) => ({
  ...render(<BookingLadder steps={steps} busy={false} onClear={onClear} />),
  onClear,
});

const rungs = () =>
  [...document.querySelectorAll('.ladder-step')].map((el) => el.querySelector('.ladder-label').textContent);

describe("a booking's ladder", () => {
  test('shows the steps in play and folds away the ones that will never fire', async () => {
    const user = userEvent.setup();
    ladder();

    // Seven in play, three that do not apply to this booking.
    expect(rungs()).toHaveLength(7);
    expect(rungs()).not.toContain('Ten days left to settle the balance');

    await user.click(screen.getByRole('button', { name: /Show 3 steps that do not apply/ }));
    expect(rungs()).toHaveLength(10);
    expect(rungs()).toContain('Ten days left to settle the balance');
  });

  test('the rungs carry no arrows between them', () => {
    // The order is the order on the screen; an arrow in every gap was six
    // more things to read on a row that is already a sequence.
    const { container } = ladder();
    expect(container.querySelectorAll('.flow-arrow')).toHaveLength(0);
  });

  test('says its state in words, never by colour alone', () => {
    ladder();
    const states = [...document.querySelectorAll('.ladder-state')].map((el) => el.textContent);
    expect(states).toContain('Missed');
    expect(states).toContain('Done');
    expect(states).toContain('Due');
    expect(states).toContain('Upcoming');
  });

  test('a reason that only repeats the state is not said twice', () => {
    ladder();
    // "Done · Already done" was five of the eleven rows.
    expect(screen.queryByText('Already done')).not.toBeInTheDocument();
    // One that adds something stays.
    expect(screen.getByText(/9 days past its date/)).toBeInTheDocument();
  });

  test('only the rungs still in play can be cleared', async () => {
    const user = userEvent.setup();
    const { onClear } = ladder();

    // Missed, due and upcoming — not the five already done.
    const clears = screen.getAllByRole('button', { name: /^Clear / });
    expect(clears).toHaveLength(3);

    // Each one says which step it clears, so three buttons are not three
    // identical "Clear"s to anybody reading the page aloud.
    expect(clears.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Clear Payment link to secure the booking',
      'Clear Rescue reminder, 24 hours before cancellation',
      'Clear Cancellation issued, booking released',
    ]);

    await user.click(screen.getByRole('button', { name: 'Clear Rescue reminder, 24 hours before cancellation' }));
    expect(onClear).toHaveBeenCalledWith('rescue24');
  });

  test('a booking whose steps all apply offers nothing to unfold', () => {
    ladder(STEPS.filter((entry) => entry.state !== 'skipped'));
    expect(screen.queryByRole('button', { name: /do not apply/ })).not.toBeInTheDocument();
  });
});
