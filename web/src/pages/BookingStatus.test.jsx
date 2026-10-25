import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import BookingStatus from './BookingStatus.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: {
    lifecycleConfig: vi.fn(),
    lifecycleHeld: vi.fn(),
    lifecyclePreview: vi.fn(),
    lifecycleRun: vi.fn(),
    reminderConfig: vi.fn(),
    remindersPending: vi.fn(),
    sendReminders: vi.fn(),
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

describe('the headline', () => {
  test('says in one line that nobody is being chased, offers a preview but no run', async () => {
    api.lifecycleConfig.mockResolvedValue(
      config({ switches: { enabled: false, deadlines: false, scheduled: false, autoCancel: false } }),
    );
    render(<BookingStatus />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByRole('heading', { name: /nobody is being chased/i })).toBeInTheDocument());
    // A dry run sends nothing, so it is how a club reads the ladder before
    // switching it on.
    expect(screen.getByRole('button', { name: /preview today/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled();
  });

  test('says that nothing goes out unless somebody presses Run now', async () => {
    render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /nothing goes out unless you press run now/i })).toBeInTheDocument(),
    );
    // Which is exactly the state in which running it by hand is the point.
    expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled();
  });

  test('distinguishes stopping for a person from cancelling automatically', async () => {
    api.lifecycleConfig.mockResolvedValue(
      config({ switches: { enabled: true, deadlines: true, scheduled: true, autoCancel: false } }),
    );
    const { unmount } = render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByRole('heading', { name: /stop here for you/i })).toBeInTheDocument());
    unmount();

    api.lifecycleConfig.mockResolvedValue(
      config({ switches: { enabled: true, deadlines: true, scheduled: true, autoCancel: true } }),
    );
    render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByRole('heading', { name: /cancelled automatically/i })).toBeInTheDocument());
  });

  test('says when nothing will ever be cancelled', async () => {
    api.lifecycleConfig.mockResolvedValue(
      config({ switches: { enabled: true, deadlines: false, scheduled: true, autoCancel: false } }),
    );
    render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /nothing is ever cancelled/i })).toBeInTheDocument(),
    );
  });

  test('offers one way to change it, and names no environment variable', async () => {
    render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByRole('link', { name: /change this/i })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /change this/i })).toHaveAttribute('href', '/settings');
    expect(screen.queryByText(/BOOKING_TRIGGERS_/)).not.toBeInTheDocument();
  });

  test('an email with nothing to send is flagged as something to report', async () => {
    // Every rung now has copy written for it, so this state means a rung was
    // added to the ladder and nobody wrote its email — a bug, not a setting.
    render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByText(/nothing is lost/i)).toBeInTheDocument());
    expect(screen.getByText(/worth reporting/i)).toBeInTheDocument();
  });
});

describe('what is waiting on a person', () => {
  test('a held booking is surfaced with the reason in plain words', async () => {
    api.lifecycleHeld.mockResolvedValue({ held: [HELD] });
    render(<BookingStatus />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Waiting on you' })).toBeInTheDocument());
    expect(screen.getByText('RD-2001')).toBeInTheDocument();
    expect(screen.getByText('Ann McLeod')).toBeInTheDocument();
    expect(screen.getByText('No deposit arrived within the payment window')).toBeInTheDocument();
    // The reference opens the booking, so "open one and decide" is actionable.
    expect(screen.getByRole('link', { name: 'RD-2001' })).toHaveAttribute('href', '/bookings?ref=RD-2001');
    // And it is said again at the top, where somebody scanning will see it.
    expect(screen.getByText(/needs your decision/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was emailed to/i)).toBeInTheDocument();
  });

  test('the table is absent when nothing is waiting, rather than an empty frame', async () => {
    render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByRole('link', { name: /change this/i })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Waiting on you' })).not.toBeInTheDocument();
    // The tile still reports it, which is where a glance goes.
    expect(screen.getByText('Waiting on you')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs your call')).toBeInTheDocument();
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
    render(<BookingStatus />, { wrapper: MemoryRouter });
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
    render(<BookingStatus />, { wrapper: MemoryRouter });
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
    render(<BookingStatus />, { wrapper: MemoryRouter });
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
    render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => expect(screen.getByText(/sent 3 email\(s\), 1 waiting on a decision/i)).toBeInTheDocument());
    // Twice: once on mount, once after the run.
    expect(api.lifecycleHeld).toHaveBeenCalledTimes(2);
  });

  test('running is refused while SendGrid is unconfigured, and the button says why', async () => {
    api.lifecycleConfig.mockResolvedValue(config({ emailReady: false }));
    render(<BookingStatus />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByRole('link', { name: /change this/i })).toBeInTheDocument());
    const run = screen.getByRole('button', { name: /run now/i });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', 'SendGrid is not configured');
    // A dry run still works, so a club can read the ladder before wiring email.
    expect(screen.getByRole('button', { name: /preview today/i })).toBeEnabled();
  });
});

describe('the ladder', () => {
  test('is drawn in phases, with each rung timed in words', async () => {
    render(<BookingStatus />, { wrapper: MemoryRouter });

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
    render(<BookingStatus />, { wrapper: MemoryRouter });

    await waitFor(() => expect(screen.getByText('cancels')).toBeInTheDocument());
    expect(screen.getByText('trade only')).toBeInTheDocument();
    expect(screen.getByText(/nothing written for this one, so it is skipped/i)).toBeInTheDocument();
  });

  test('says the branch needs no step pressed', async () => {
    render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() => expect(screen.getByText(/there is no step to press/i)).toBeInTheDocument());
  });
});

test('an API failure is shown rather than an empty page', async () => {
  api.lifecycleConfig.mockRejectedValue(new Error('Could not reach the server. Check your connection.'));
  api.lifecycleHeld.mockRejectedValue(new Error('Could not reach the server. Check your connection.'));
  render(<BookingStatus />, { wrapper: MemoryRouter });

  await waitFor(() =>
    expect(screen.getByText('Could not reach the server. Check your connection.')).toBeInTheDocument(),
  );
});

test('the held banner agrees with itself when more than one booking is waiting', async () => {
  api.lifecycleHeld.mockResolvedValue({ held: [HELD, { ...HELD, bookingId: 'RD-2002' }] });
  render(<BookingStatus />, { wrapper: MemoryRouter });

  await waitFor(() => expect(screen.getByText(/2 bookings stopped here/i)).toBeInTheDocument());
  expect(screen.getByText(/need your decision/i)).toBeInTheDocument();
  expect(screen.getByText(/nothing was emailed to any of them/i)).toBeInTheDocument();
});

describe('tour operator reminders', () => {
  test('live on this page as a tab, reached by the old /reminders address', async () => {
    api.reminderConfig.mockResolvedValue({
      configured: true,
      hasApiKey: true,
      fromEmail: 'b@example.com',
      campaigns: {},
    });
    api.remindersPending.mockResolvedValue({ reminders: [] });
    render(
      <MemoryRouter initialEntries={['/booking-status?tab=operators']}>
        <BookingStatus />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: /tour operator reminders/i })).toBeInTheDocument());
    // The overview is not drawn underneath it.
    expect(screen.queryByRole('heading', { name: /nothing goes out unless/i })).not.toBeInTheDocument();
    // And it says the automatic chasing already covers the balance.
    expect(screen.getByText(/balance reminders already go to each account automatically/i)).toBeInTheDocument();
  });

  test('the overview tab is the default', async () => {
    render(<BookingStatus />, { wrapper: MemoryRouter });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(api.reminderConfig).not.toHaveBeenCalled();
  });
});
