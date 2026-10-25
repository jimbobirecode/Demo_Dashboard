import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import Lifecycle from './Lifecycle.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: {
    lifecycleConfig: vi.fn(),
    lifecycleHeld: vi.fn(),
    lifecyclePreview: vi.fn(),
    lifecycleRun: vi.fn(),
  },
}));

const LADDER = [
  {
    key: 'deposit_request',
    phase: 'payment',
    label: 'Deposit request',
    anchor: 'lifecycle',
    offset: 0,
    flows: ['operator', 'visitor'],
    cancels: false,
    configured: true,
  },
  {
    key: 'deposit_overdue',
    phase: 'payment',
    label: 'Deposit window closed — cancellation warning',
    anchor: 'lifecycle',
    offset: 7,
    flows: ['operator', 'visitor'],
    cancels: false,
    configured: true,
  },
  {
    key: 'deposit_cancelled',
    phase: 'payment',
    label: 'Cancellation',
    anchor: 'lifecycle',
    offset: 10,
    flows: ['operator', 'visitor'],
    cancels: true,
    configured: false,
  },
  {
    key: 'balance_notice',
    phase: 'balance',
    label: 'Balance due — polite reminder',
    anchor: 'balanceDue',
    offset: -10,
    flows: ['operator'],
    cancels: false,
    configured: true,
  },
  {
    key: 'post_play',
    phase: 'communication',
    label: 'Post-play thank you',
    anchor: 'play',
    offset: 1,
    flows: ['operator', 'visitor'],
    cancels: false,
    configured: true,
  },
];

function config(overrides = {}) {
  return {
    switches: { enabled: true, deadlines: true, scheduled: false, autoCancel: false, visitorDunning: true },
    catchUpDays: 3,
    everyMinutes: 15,
    days: {},
    ladder: LADDER,
    unconfigured: ['deposit_cancelled'],
    emailReady: true,
    lastRun: null,
    ...overrides,
  };
}

const HELD = {
  bookingId: 'RD-2001',
  rung: 'deposit_cancelled',
  phase: 'payment',
  dueOn: '2026-01-11',
  detail: 'a person has to decide: auto-cancel is off',
  heldAt: '2026-01-11T09:00:00Z',
  guestName: 'Ann McLeod',
  guestEmail: 'ann@tours.example',
  playDate: '2026-06-01',
  status: 'Booked',
  paymentStatus: 'Unpaid',
  total: 1000,
  amountPaid: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.lifecycleConfig.mockResolvedValue(config());
  api.lifecycleHeld.mockResolvedValue({ held: [] });
});

describe('the set-up card', () => {
  test('says plainly when the ladder is off, and no run is offered', async () => {
    api.lifecycleConfig.mockResolvedValue(
      config({ switches: { enabled: false, deadlines: false, scheduled: false, autoCancel: false } }),
    );
    render(<Lifecycle />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText(/nothing is being chased/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /preview today/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled();
  });

  test('says that nothing runs by itself when the schedule is off', async () => {
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByText(/nothing runs by itself/i)).toBeInTheDocument());
    // But it can still be run by hand, which is the point of that state.
    expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled();
  });

  test('counts how far through the four steps the club has got', async () => {
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByText('Step 2 of 4')).toBeInTheDocument());
  });

  test('sends you to Settings to change any of it, rather than naming a variable', async () => {
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Settings' }).length).toBeGreaterThan(0));
    for (const link of screen.getAllByRole('link', { name: 'Settings' })) {
      expect(link).toHaveAttribute('href', '/settings');
    }
    // The switches are the club's own now, so no environment variable is named.
    expect(screen.queryByText(/BOOKING_TRIGGERS_/)).not.toBeInTheDocument();
  });

  test('explains that rungs without a template are skipped rather than lost', async () => {
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByText(/nothing is lost in the meantime/i)).toBeInTheDocument());
    expect(screen.getAllByText(/have no email template/i).length).toBeGreaterThan(0);
  });

  test('explains the visitor switch when it is off, including why it is a judgement call', async () => {
    api.lifecycleConfig.mockResolvedValue(
      config({
        switches: { enabled: true, deadlines: true, scheduled: true, autoCancel: false, visitorDunning: false },
      }),
    );
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByText(/visitor chasing is switched off/i)).toBeInTheDocument());
    expect(screen.getByText(/left the visitor chasing columns blank/i)).toBeInTheDocument();
  });
});

describe('what is waiting on a person', () => {
  test('a held booking is surfaced with the reason in plain words', async () => {
    api.lifecycleHeld.mockResolvedValue({ held: [HELD] });
    render(<Lifecycle />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Waiting on you' })).toBeInTheDocument());
    expect(screen.getByText('RD-2001')).toBeInTheDocument();
    expect(screen.getByText('Ann McLeod')).toBeInTheDocument();
    expect(screen.getByText('No deposit arrived within the payment window')).toBeInTheDocument();
    // The reference opens the booking, so "open one and decide" is actionable.
    expect(screen.getByRole('link', { name: 'RD-2001' })).toHaveAttribute('href', '/bookings?ref=RD-2001');
    // And it is said again at the top, where somebody scanning will see it.
    expect(screen.getByText(/needs a decision/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was emailed to/i)).toBeInTheDocument();
  });

  test('the table is absent when nothing is waiting, rather than an empty frame', async () => {
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByText('Set-up')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Waiting on you' })).not.toBeInTheDocument();
    // The tile still reports it, which is where a glance goes.
    expect(screen.getByText('Waiting on you')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs a decision')).toBeInTheDocument();
  });
});

describe('the dry run', () => {
  test('shows what would be sent, and says nothing was', async () => {
    api.lifecyclePreview.mockResolvedValue({
      preview: {
        today: '2026-01-08',
        considered: 12,
        sent: 1,
        held: 0,
        failed: 0,
        superseded: 2,
        skipped: 4,
        cancelled: 0,
        actions: [{ bookingId: 'RD-2001', rung: 'deposit_overdue', outcome: 'would send', dueOn: '2026-01-08' }],
      },
    });
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByRole('button', { name: /preview today/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /preview today/i }));

    await waitFor(() => expect(screen.getByText('What would happen today')).toBeInTheDocument());
    expect(screen.getByText(/nothing was sent and nothing was recorded/i)).toBeInTheDocument();
    expect(screen.getByText('Would send')).toBeInTheDocument();
    expect(screen.getAllByText('Deposit window closed — cancellation warning').length).toBeGreaterThan(1);
    expect(api.lifecycleRun).not.toHaveBeenCalled();
  });

  test('a rung that would only wait for a person is labelled as such, not as a send', async () => {
    api.lifecyclePreview.mockResolvedValue({
      preview: {
        today: '2026-01-11',
        considered: 1,
        sent: 0,
        held: 1,
        failed: 0,
        superseded: 0,
        skipped: 0,
        cancelled: 0,
        actions: [{ bookingId: 'RD-2001', rung: 'deposit_cancelled', outcome: 'held', dueOn: '2026-01-11' }],
      },
    });
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByRole('button', { name: /preview today/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /preview today/i }));

    await waitFor(() => expect(screen.getByText('Would wait for a person')).toBeInTheDocument());
  });

  test('an empty day says so, and explains the catch-up limit', async () => {
    api.lifecyclePreview.mockResolvedValue({
      preview: {
        today: '2026-01-02',
        considered: 9,
        sent: 0,
        held: 0,
        failed: 0,
        superseded: 3,
        skipped: 0,
        cancelled: 0,
        actions: [],
      },
    });
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByRole('button', { name: /preview today/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /preview today/i }));

    await waitFor(() => expect(screen.getByText(/nothing is due today/i)).toBeInTheDocument());
    expect(screen.getByText(/too old to send/i)).toBeInTheDocument();
  });
});

describe('running it for real', () => {
  test('reports what it did and reloads the held list', async () => {
    api.lifecycleRun.mockResolvedValue({
      run: { considered: 12, sent: 3, held: 1, failed: 0, cancelled: 0, superseded: 0, skipped: 2 },
    });
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => expect(screen.getByText(/sent 3 email\(s\), 1 waiting on a decision/i)).toBeInTheDocument());
    // Twice: once on mount, once after the run.
    expect(api.lifecycleHeld).toHaveBeenCalledTimes(2);
  });

  test('running is refused while SendGrid is unconfigured, and the button says why', async () => {
    api.lifecycleConfig.mockResolvedValue(config({ emailReady: false }));
    render(<Lifecycle />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('Set-up')).toBeInTheDocument());
    const run = screen.getByRole('button', { name: /run now/i });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', 'SendGrid is not configured');
    // A dry run still works, so a club can read the ladder before wiring email.
    expect(screen.getByRole('button', { name: /preview today/i })).toBeEnabled();
  });
});

describe('the ladder', () => {
  test('is drawn in phases, with each rung timed in words', async () => {
    render(<Lifecycle />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('The ladder')).toBeInTheDocument());
    expect(screen.getByText('Payment')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.getByText('Run-up to the tee')).toBeInTheDocument();

    expect(screen.getByText('Straight away')).toBeInTheDocument();
    expect(screen.getByText('Day 7')).toBeInTheDocument();
    expect(screen.getByText('10 days before the balance deadline')).toBeInTheDocument();
    expect(screen.getByText('1 day after play')).toBeInTheDocument();
  });

  test('marks the rungs that cancel, the trade-only ones, and the ones with no template', async () => {
    render(<Lifecycle />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('cancels')).toBeInTheDocument());
    expect(screen.getByText('trade only')).toBeInTheDocument();
    expect(screen.getByText(/no email template yet, so it is skipped/i)).toBeInTheDocument();
  });

  test('says the branch needs no step pressed', async () => {
    render(<Lifecycle />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByText(/there is no step to press/i)).toBeInTheDocument());
  });
});

test('an API failure is shown rather than an empty page', async () => {
  api.lifecycleConfig.mockRejectedValue(new Error('Could not reach the server. Check your connection.'));
  api.lifecycleHeld.mockRejectedValue(new Error('Could not reach the server. Check your connection.'));
  render(<Lifecycle />, { wrapper: MemoryRouter });

  await waitFor(() =>
    expect(screen.getByText('Could not reach the server. Check your connection.')).toBeInTheDocument(),
  );
});

test('the held banner agrees with itself when more than one booking is waiting', async () => {
  api.lifecycleHeld.mockResolvedValue({ held: [HELD, { ...HELD, bookingId: 'RD-2002' }] });
  render(<Lifecycle />, { wrapper: MemoryRouter });

  await waitFor(() => expect(screen.getByText(/2 bookings ran out of road/i)).toBeInTheDocument());
  expect(screen.getByText(/need a decision/i)).toBeInTheDocument();
  expect(screen.getByText(/nothing was emailed to any of them/i)).toBeInTheDocument();
});
