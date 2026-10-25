import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LifecycleSettings from './LifecycleSettings.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { lifecycleSettings: vi.fn(), saveLifecycleSettings: vi.fn() },
}));

const DEFAULTS = {
  depositWindowDays: 7,
  depositReminderDay: 5,
  depositRescueDay: 10,
  balanceDueDaysBeforePlay: 60,
  balanceNoticeLeadDays: 10,
  confirmationDaysBeforePlay: 30,
  finalDetailsDaysBeforePlay: 10,
  postPlayDaysAfterPlay: 1,
};

const BOUNDS = {
  depositWindowDays: { min: 1, max: 120, label: 'Deposit window' },
  depositReminderDay: { min: 1, max: 120, label: 'First deposit reminder' },
  depositRescueDay: { min: 2, max: 180, label: 'Final deadline' },
};

function payload(overrides = {}) {
  return {
    settings: {
      enabled: true,
      deadlines: true,
      scheduled: false,
      autoCancel: false,
      visitorDunning: true,
      catchUpDays: 3,
      ...DEFAULTS,
    },
    saved: ['enabled', 'deadlines'],
    inherited: { enabled: false, deadlines: false, ...DEFAULTS },
    defaults: DEFAULTS,
    bounds: BOUNDS,
    canEdit: true,
    everyMinutes: 15,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.lifecycleSettings.mockResolvedValue(payload());
  api.saveLifecycleSettings.mockResolvedValue({ saved: ['enabled', 'deadlines', 'depositReminderDay'], settings: {} });
});

describe('what the club has chosen', () => {
  test('marks the fields it is inheriting rather than passing them off as decisions', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('Booking lifecycle')).toBeInTheDocument());

    // enabled and deadlines are saved; everything else is inherited.
    const inherited = screen.getAllByText('inherited');
    expect(inherited.length).toBeGreaterThan(5);
  });

  test('a reader who is not an admin is told so and cannot save', async () => {
    api.lifecycleSettings.mockResolvedValue(payload({ canEdit: false }));
    render(<LifecycleSettings />);

    await waitFor(() => expect(screen.getByText(/only an administrator can change them/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /save settings/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('First reminder')).toBeDisabled();
  });
});

describe('the switches nest', () => {
  test('a switch below one that is off cannot be set, and says why', async () => {
    api.lifecycleSettings.mockResolvedValue(
      payload({ settings: { ...payload().settings, enabled: false, deadlines: false } }),
    );
    render(<LifecycleSettings />);

    await waitFor(() => expect(screen.getByText('Booking lifecycle')).toBeInTheDocument());
    expect(screen.getByLabelText(/let deadlines count/i)).toBeDisabled();
    expect(screen.getAllByText('Needs the setting above').length).toBeGreaterThan(0);
  });

  test('turning the ladder on frees the switch beneath it immediately', async () => {
    api.lifecycleSettings.mockResolvedValue(
      payload({ settings: { ...payload().settings, enabled: false, deadlines: false } }),
    );
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByLabelText(/let deadlines count/i)).toBeDisabled());

    await userEvent.click(screen.getByLabelText(/work out where each booking stands/i));

    expect(screen.getByLabelText(/let deadlines count/i)).toBeEnabled();
  });
});

describe('auto-cancel', () => {
  test('asks a second time, and will not save until it is confirmed', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('Booking lifecycle')).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText(/cancel a booking that runs out of road/i));

    expect(screen.getByText(/cancelled and told so by/i)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: /save settings/i });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByLabelText(/i understand/i));
    expect(save).toBeEnabled();
  });

  test('turning it off again asks nothing', async () => {
    api.lifecycleSettings.mockResolvedValue(payload({ settings: { ...payload().settings, autoCancel: true } }));
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('Booking lifecycle')).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText(/cancel a booking that runs out of road/i));

    expect(screen.queryByLabelText(/i understand/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save settings/i })).toBeEnabled();
  });
});

describe('the deposit cadence', () => {
  test('is written out as a sequence, not left as three numbers', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText(/Day 0: payment link/)).toBeInTheDocument());

    const cadence = screen.getByText(/Day 0: payment link/).textContent;
    expect(cadence).toContain('Day 5: reminder');
    expect(cadence).toContain('Day 7: window closed');
    expect(cadence).toContain('Day 10: cancelled');
  });

  test('follows the numbers as they are edited', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText(/Day 0: payment link/)).toBeInTheDocument());

    // 8 still leaves the two days the 48- and 24-hour notices need before the
    // final deadline on day 10.
    const window = screen.getByLabelText('Window closes');
    await userEvent.clear(window);
    await userEvent.type(window, '8');

    await waitFor(() => expect(screen.getByText(/Day 8: window closed/)).toBeInTheDocument());
    expect(screen.getByText(/Day 7: 24 hours left/)).toBeInTheDocument();
  });

  test('widening the window without moving the deadline is caught as it is typed', async () => {
    // The window would swallow the final deadline, leaving no room for the
    // 48- and 24-hour notices. Worth catching here rather than at the server.
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText(/Day 0: payment link/)).toBeInTheDocument());

    const window = screen.getByLabelText('Window closes');
    await userEvent.clear(window);
    await userEvent.type(window, '14');

    await waitFor(() => expect(screen.getByText(/that order does not work/i)).toBeInTheDocument());
  });

  test('says so when the order stops making sense, before anything is saved', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText(/Day 0: payment link/)).toBeInTheDocument());

    // A reminder after the window it is reminding about.
    const reminder = screen.getByLabelText('First reminder');
    await userEvent.clear(reminder);
    await userEvent.type(reminder, '9');

    await waitFor(() => expect(screen.getByText(/that order does not work/i)).toBeInTheDocument());
  });
});

describe('saving', () => {
  test('sends only what changed', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('Booking lifecycle')).toBeInTheDocument());

    const reminder = screen.getByLabelText('First reminder');
    await userEvent.clear(reminder);
    await userEvent.type(reminder, '3');
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(api.saveLifecycleSettings).toHaveBeenCalledWith({ depositReminderDay: 3 }));
    expect(screen.getByText(/the next run uses these/i)).toBeInTheDocument();
  });

  test('nothing to save means nothing to press', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('No changes')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
  });

  test('counts the unsaved changes so nothing is left half-edited by accident', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('No changes')).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText(/run by itself/i));
    expect(screen.getByText('1 change not saved')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/chase visitors/i));
    expect(screen.getByText('2 changes not saved')).toBeInTheDocument();
  });

  test('discard puts everything back', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('No changes')).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText(/run by itself/i));
    await userEvent.click(screen.getByRole('button', { name: /discard/i }));

    expect(screen.getByText('No changes')).toBeInTheDocument();
    expect(screen.getByLabelText(/run by itself/i)).not.toBeChecked();
  });

  test("the server's refusal is shown as it is, not swallowed", async () => {
    api.saveLifecycleSettings.mockRejectedValue(
      new Error('The first deposit reminder must come before the deposit window closes'),
    );
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('No changes')).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText(/run by itself/i));
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() =>
      expect(
        screen.getByText('The first deposit reminder must come before the deposit window closes'),
      ).toBeInTheDocument(),
    );
  });
});
