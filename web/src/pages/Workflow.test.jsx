/**
 * The Workflow page.
 *
 * Three things on this page can quietly mislead a club, and they are what these
 * cover: a workflow that is switched off still draws a plan, and the page has to
 * say the plan is hypothetical; an empty Due list means something completely
 * different when the club records no payments, and the page has to name the
 * setting rather than leave somebody to conclude the ladder is broken; and a run
 * that would cancel somebody's tee time has to say so before it does it.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render as renderBare, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import Workflow from './Workflow.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: {
    triggerConfig: vi.fn(),
    triggersPending: vi.fn(),
    runTriggers: vi.fn(),
    clearTriggerSteps: vi.fn(),
  },
}));

const SCHEDULE = {
  depositDays: 7,
  depositReminderDay: 5,
  depositGraceDays: 3,
  balanceNoticeDays: 70,
  balanceDeadlineDays: 60,
  confirmationDays: 30,
  finalDetailsDays: 10,
  postPlayHours: 24,
  catchUpDays: 3,
};

const config = (over = {}) => ({
  enabled: true,
  automatic: false,
  autoCancel: false,
  ready: true,
  hasApiKey: true,
  missing: [],
  schedule: SCHEDULE,
  lastRun: null,
  steps: [
    { id: 'deposit_reminder', label: 'Deposit reminder, warning of cancellation', trigger: 'Trigger 1' },
    { id: 'deposit_lapsed', label: 'Cancellation issued, booking released', trigger: 'Trigger 3' },
  ],
  ...over,
});

const step = (over = {}) => ({
  step: 'deposit_reminder',
  label: 'Deposit reminder, warning of cancellation',
  trigger: 'Trigger 1',
  group: 'payment',
  action: 'email',
  condition: 'unpaid',
  dueOn: '2026-10-25',
  daysLate: 0,
  state: 'due',
  reason: 'Due today',
  ...over,
});

const row = (over = {}) => {
  const next = over.next === undefined ? step() : over.next;
  return {
    bookingId: 'CL-100',
    club: 'baltray',
    flow: 'visitor',
    guestName: 'Ann Burke',
    guestEmail: 'ann.burke@example.com',
    date: '2026-12-01',
    teeTime: '10:20',
    players: 4,
    status: 'Booked',
    operatorName: null,
    money: { gross: 1200, paid: 0, outstanding: 1200, tracked: true, secured: false, settled: false },
    blocker: null,
    steps: next ? [next] : [step({ state: 'sent', reason: 'Already done' })],
    superseded: [],
    ...over,
    next,
  };
};

const pending = (over = {}) => ({
  scope: 'due',
  today: '2026-10-25',
  schedule: SCHEDULE,
  enabled: true,
  automatic: false,
  autoCancel: false,
  ready: true,
  missing: [],
  paymentsTracked: true,
  trackedFrom: null,
  outsideLedger: 0,
  summary: { bookings: 1, emails: 1, cancellations: 0, counts: { due: 1 } },
  bookings: [row()],
  ...over,
});

/** The page links to Settings, so it needs a router around it. */
const render = (ui) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

describe('the Workflow page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.triggerConfig.mockResolvedValue(config());
    api.triggersPending.mockResolvedValue(pending());
  });

  test('lists what falls due today, with the step and its date', async () => {
    render(<Workflow />);
    expect(await screen.findByText('CL-100')).toBeInTheDocument();
    expect(screen.getByText('Deposit reminder, warning of cancellation')).toBeInTheDocument();
    expect(screen.getByText(/Due today/)).toBeInTheDocument();
  });

  test('a switched-off workflow says the plan is hypothetical, and where to switch it on', async () => {
    api.triggerConfig.mockResolvedValue(config({ enabled: false, ready: false }));
    render(<Workflow />);
    expect(await screen.findByText(/Chasing is switched off/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  test('a workflow the environment has locked off says so, rather than sending people to Settings', async () => {
    api.triggerConfig.mockResolvedValue(config({ enabled: false, ready: false, locked: true }));
    render(<Workflow />);
    expect(await screen.findByText('TRIGGER_WORKFLOW=false')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  test('an empty list with no payment ledger says which setting is missing', async () => {
    // Otherwise this reads as a broken workflow rather than one that has
    // nothing to chase because nothing is recorded as owed.
    api.triggersPending.mockResolvedValue(
      pending({
        paymentsTracked: false,
        outsideLedger: 42,
        bookings: [],
        summary: { bookings: 0, emails: 0, cancellations: 0, counts: {} },
      }),
    );
    render(<Workflow />);
    expect(await screen.findByText(/not recording payments/)).toBeInTheDocument();
    expect(screen.getByText('PAYMENTS_TRACKED_FROM')).toBeInTheDocument();
    expect(screen.getByText(/42 booked bookings are/)).toBeInTheDocument();
  });

  test('a preview sends nothing', async () => {
    api.runTriggers.mockResolvedValue({ dryRun: true, sent: 0, failed: 0, skipped: 0, needsReview: 0, results: [] });
    render(<Workflow />);
    await screen.findByText('CL-100');

    await userEvent.click(screen.getByRole('button', { name: /^Preview/ }));
    await waitFor(() => expect(api.runTriggers).toHaveBeenCalledWith({ bookingIds: ['CL-100'], dryRun: true }));
  });

  test('a run that would cancel a tee time says so before it does it', async () => {
    api.triggersPending.mockResolvedValue(
      pending({
        bookings: [row({ next: step({ step: 'deposit_lapsed', label: 'Cancellation issued', action: 'cancel' }) })],
        summary: { bookings: 1, emails: 0, cancellations: 1, counts: { due: 1 } },
      }),
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Workflow />);
    await screen.findByText('CL-100');

    await userEvent.click(screen.getByRole('button', { name: /Send next step/ }));
    expect(confirm.mock.calls[0][0]).toMatch(/would be CANCELLED/);
    expect(api.runTriggers).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  test('a booking with nothing due cannot be picked for a run', async () => {
    api.triggersPending.mockResolvedValue(
      pending({
        scope: 'all',
        bookings: [row({ next: null })],
        summary: { bookings: 1, emails: 0, cancellations: 0, counts: { sent: 1 } },
      }),
    );
    render(<Workflow />);
    await screen.findByText('CL-100');
    expect(screen.getByRole('checkbox', { name: 'Select CL-100' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Send next step/ })).toBeDisabled();
  });

  test('the ladder opens to show where a booking has got to', async () => {
    render(<Workflow />);
    await screen.findByText('CL-100');

    await userEvent.click(screen.getByRole('button', { name: 'Ladder' }));
    // The step, said in the club's words rather than by its trigger number:
    // "Trigger 1" is how the workflow is wired, not what anybody is waiting on.
    // (The row above the ladder names the next step too, hence two of them.)
    expect(document.querySelector('.ladder-label').textContent).toBe('Deposit reminder, warning of cancellation');
    expect(document.querySelector('.ladder-state').textContent).toBe('Due');
    expect(screen.getByRole('button', { name: 'Clear Deposit reminder, warning of cancellation' })).toBeInTheDocument();
  });

  test('a step can be taken off the list without emailing anybody', async () => {
    api.clearTriggerSteps.mockResolvedValue({
      bookingId: 'CL-100',
      results: [{ step: 'deposit_reminder', status: 'cleared', message: 'Cleared without emailing' }],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Workflow />);
    await screen.findByText('CL-100');

    await userEvent.click(screen.getByRole('button', { name: 'Ladder' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear Deposit reminder, warning of cancellation' }));

    await waitFor(() => expect(api.clearTriggerSteps).toHaveBeenCalledWith('CL-100', ['deposit_reminder']));
    expect(await screen.findByText(/Cleared without emailing/)).toBeInTheDocument();
    window.confirm.mockRestore();
  });

  test('a database behind on migrations is reported, not swallowed into a blank page', async () => {
    // The API answers 409 with the table, the migration and the command. It has
    // to reach the screen: this is the feature's normal first state on a real
    // install, and "Internal server error" sent nobody anywhere.
    const message =
      'The booking trigger workflow needs a database table it cannot find ' +
      '(public.booking_trigger_sends, from migration 0026_booking_trigger_workflow.sql). ' +
      'Run "npm run migrate" against this database, then reload this page.';
    api.triggersPending.mockRejectedValue(Object.assign(new Error(message), { status: 409 }));

    render(<Workflow />);
    expect(await screen.findByText(/npm run migrate/)).toBeInTheDocument();
    expect(screen.getByText(/0026_booking_trigger_workflow\.sql/)).toBeInTheDocument();
  });

  test('a workflow that cannot send says what is missing and refuses to try', async () => {
    api.triggerConfig.mockResolvedValue(config({ ready: false, hasApiKey: false, missing: ['SENDGRID_API_KEY'] }));
    render(<Workflow />);
    expect(await screen.findByText(/SENDGRID_API_KEY/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send next step/ })).toBeDisabled();
  });
});
