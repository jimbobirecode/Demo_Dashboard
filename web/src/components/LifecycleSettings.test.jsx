import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LifecycleSettings, { modeFor } from './LifecycleSettings.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { lifecycleSettings: vi.fn(), saveLifecycleSettings: vi.fn() },
}));

const DAYS = {
  depositWindowDays: 7,
  depositReminderDay: 5,
  depositRescueDay: 10,
  balanceDueDaysBeforePlay: 60,
  balanceNoticeLeadDays: 10,
  confirmationDaysBeforePlay: 30,
  finalDetailsDaysBeforePlay: 10,
  postPlayDaysAfterPlay: 1,
};

/** The flags for each of the five steps, as the server stores them. */
const FLAGS = {
  off: { enabled: false, deadlines: false, scheduled: false, autoCancel: false },
  preview: { enabled: true, deadlines: false, scheduled: false, autoCancel: false },
  chase_forever: { enabled: true, deadlines: false, scheduled: true, autoCancel: false },
  chase_and_ask: { enabled: true, deadlines: true, scheduled: true, autoCancel: false },
  cancel: { enabled: true, deadlines: true, scheduled: true, autoCancel: true },
};

function payload(mode = 'chase_and_ask', overrides = {}) {
  return {
    settings: { ...FLAGS[mode], visitorDunning: true, catchUpDays: 3, ...DAYS },
    saved: [],
    inherited: {},
    defaults: DAYS,
    bounds: {},
    canEdit: true,
    everyMinutes: 15,
    ...overrides,
  };
}

const option = (name) => screen.getByRole('radio', { name: new RegExp(name, 'i') });

beforeEach(() => {
  vi.clearAllMocks();
  api.lifecycleSettings.mockResolvedValue(payload());
  api.saveLifecycleSettings.mockResolvedValue({ saved: [], settings: {} });
});

// ---------------------------------------------------------------------------
// One choice, named by what the guest gets
// ---------------------------------------------------------------------------

describe('how far this goes', () => {
  test('is a single choice, not a set of switches to work out', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('How far should this go?')).toBeInTheDocument());

    expect(screen.getAllByRole('radio')).toHaveLength(5);
    // Nothing is greyed out waiting for something else to be ticked first.
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled();
  });

  test('each step is named by what happens, not by which flag it sets', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('How far should this go?')).toBeInTheDocument());

    expect(option('send me what you would send|show me what you would send')).toBeInTheDocument();
    expect(option('never cancel')).toBeInTheDocument();
    expect(option('stop and ask me')).toBeInTheDocument();
    expect(option('cancel it for me')).toBeInTheDocument();
  });

  test('the safe one is the recommended one', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('recommended')).toBeInTheDocument());

    const label = screen.getByText('recommended').closest('label');
    expect(within(label).getByText(/stop and ask me/i)).toBeInTheDocument();
  });

  test('the saved flags decide which step is shown as current', async () => {
    api.lifecycleSettings.mockResolvedValue(payload('chase_forever'));
    render(<LifecycleSettings />);

    await waitFor(() => expect(option('never cancel')).toBeChecked());
    expect(option('stop and ask me')).not.toBeChecked();
  });

  test('every combination of the underlying flags maps to exactly one step', () => {
    for (const [mode, flags] of Object.entries(FLAGS)) {
      assertMode(modeFor({ ...flags }), mode);
    }
    function assertMode(actual, expected) {
      expect(actual).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// The timings, as sentences
// ---------------------------------------------------------------------------

describe('the timings', () => {
  test('say what the number means, with its units, in a sentence', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('When')).toBeInTheDocument());

    expect(screen.getByText(/ask for the deposit within/i)).toBeInTheDocument();
    expect(screen.getByText(/days of the booking/i)).toBeInTheDocument();
    expect(screen.getByText(/send the first reminder/i)).toBeInTheDocument();
    expect(screen.getByText(/tour operators owe the balance/i)).toBeInTheDocument();
  });

  test('each number still has a name a screen reader can say', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('When')).toBeInTheDocument());

    expect(screen.getByLabelText('Days to pay the deposit')).toHaveValue(7);
    expect(screen.getByLabelText('Days before the first reminder')).toHaveValue(5);
    expect(screen.getByLabelText('Day the booking stops')).toHaveValue(10);
  });

  test('an order that cannot work is explained in plain words and blocks saving', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('When')).toBeInTheDocument());

    const reminder = screen.getByLabelText('Days before the first reminder');
    await userEvent.clear(reminder);
    await userEvent.type(reminder, '9');

    await waitFor(() =>
      expect(screen.getByText(/before the deadline it is reminding them about/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  test('leaving no room for the 48- and 24-hour warnings is caught', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('When')).toBeInTheDocument());

    const stops = screen.getByLabelText('Day the booking stops');
    await userEvent.clear(stops);
    await userEvent.type(stops, '8');

    await waitFor(() => expect(screen.getByText(/at least two days after the deadline/i)).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// The picture
// ---------------------------------------------------------------------------

describe('what a guest gets', () => {
  test('is drawn out as two stories, paid and unpaid', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('What a guest gets')).toBeInTheDocument());

    expect(screen.getByText('If they do not pay')).toBeInTheDocument();
    expect(screen.getByText('If they pay')).toBeInTheDocument();
    expect(screen.getByText(/the chasing stops the moment any money arrives/i)).toBeInTheDocument();
  });

  test('follows the numbers as they are edited', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('Day 5')).toBeInTheDocument());

    const reminder = screen.getByLabelText('Days before the first reminder');
    await userEvent.clear(reminder);
    await userEvent.type(reminder, '3');

    await waitFor(() => expect(screen.getByText('Day 3')).toBeInTheDocument());
  });

  test('ends where the chosen step ends: waiting for a person', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('Stops here')).toBeInTheDocument());

    expect(screen.getByText(/we wait for you to decide. nothing is emailed/i)).toBeInTheDocument();
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
  });

  test('ends in a cancellation when that is what was chosen', async () => {
    api.lifecycleSettings.mockResolvedValue(payload('cancel'));
    render(<LifecycleSettings />);

    await waitFor(() => expect(screen.getByText('Cancelled')).toBeInTheDocument());
    expect(screen.getByText(/the booking is cancelled and they are told/i)).toBeInTheDocument();
  });

  test('shows no warnings or ending at all where the club never cancels', async () => {
    api.lifecycleSettings.mockResolvedValue(payload('chase_forever'));
    render(<LifecycleSettings />);

    await waitFor(() => expect(screen.getByText('If they do not pay')).toBeInTheDocument());
    expect(screen.queryByText('Stops here')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
    expect(screen.queryByText('Final notice')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Turning it off, and turning on the dangerous one
// ---------------------------------------------------------------------------

test('choosing Off hides the timings rather than leaving dead controls on screen', async () => {
  render(<LifecycleSettings />);
  await waitFor(() => expect(screen.getByText('When')).toBeInTheDocument());

  await userEvent.click(option('^off'));

  expect(screen.queryByText('When')).not.toBeInTheDocument();
  expect(screen.queryByText('What a guest gets')).not.toBeInTheDocument();
});

test('cancelling automatically asks a second time, and will not save until answered', async () => {
  render(<LifecycleSettings />);
  await waitFor(() => expect(screen.getByText('How far should this go?')).toBeInTheDocument());

  await userEvent.click(option('cancel it for me'));

  expect(screen.getByText(/the first anyone here knows of a cancellation/i)).toBeInTheDocument();
  const save = screen.getByRole('button', { name: /^save$/i });
  expect(save).toBeDisabled();

  await userEvent.click(screen.getByLabelText(/i understand/i));
  expect(save).toBeEnabled();
});

test('a club already cancelling automatically is not asked again', async () => {
  api.lifecycleSettings.mockResolvedValue(payload('cancel'));
  render(<LifecycleSettings />);
  await waitFor(() => expect(option('cancel it for me')).toBeChecked());

  expect(screen.queryByLabelText(/i understand/i)).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

describe('saving', () => {
  test('sends the flags the chosen step stands for', async () => {
    api.lifecycleSettings.mockResolvedValue(payload('preview'));
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('How far should this go?')).toBeInTheDocument());

    await userEvent.click(option('never cancel'));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.saveLifecycleSettings).toHaveBeenCalledWith({ scheduled: true }));
  });

  test('sends only what changed', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('When')).toBeInTheDocument());

    const reminder = screen.getByLabelText('Days before the first reminder');
    await userEvent.clear(reminder);
    await userEvent.type(reminder, '3');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.saveLifecycleSettings).toHaveBeenCalledWith({ depositReminderDay: 3 }));
  });

  test('says when there is nothing to save', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('Everything here is saved')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  test('discard puts it back', async () => {
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('Everything here is saved')).toBeInTheDocument());

    await userEvent.click(option('never cancel'));
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.getByText('Everything here is saved')).toBeInTheDocument();
    expect(option('stop and ask me')).toBeChecked();
  });

  test('a refusal from the server is shown as it is', async () => {
    api.saveLifecycleSettings.mockRejectedValue(new Error('The final details must go out after the confirmation'));
    render(<LifecycleSettings />);
    await waitFor(() => expect(screen.getByText('Everything here is saved')).toBeInTheDocument());

    await userEvent.click(option('never cancel'));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(screen.getByText('The final details must go out after the confirmation')).toBeInTheDocument(),
    );
  });

  test('a reader who cannot edit gets no controls to press', async () => {
    api.lifecycleSettings.mockResolvedValue(payload('chase_and_ask', { canEdit: false }));
    render(<LifecycleSettings />);

    await waitFor(() => expect(screen.getByText(/an administrator changes them/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});
