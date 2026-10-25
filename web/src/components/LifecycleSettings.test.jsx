import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LifecycleSettings from './LifecycleSettings.jsx';
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

const ON = { enabled: true, deadlines: true, scheduled: true, autoCancel: false };
const OFF = { enabled: false, deadlines: false, scheduled: false, autoCancel: false };

function payload(flags = ON, overrides = {}) {
  return {
    settings: { ...flags, visitorDunning: true, catchUpDays: 3, ...DAYS },
    saved: [],
    inherited: {},
    defaults: DAYS,
    bounds: {},
    trade: { accounts: 4, ownDepositTerm: 1, ownBalanceTerm: 3, notChased: 1, noContactEmail: 0 },
    canEdit: true,
    everyMinutes: 15,
    ...overrides,
  };
}

const show = () => render(<LifecycleSettings />, { wrapper: MemoryRouter });
const chasing = () => screen.getByLabelText(/chase unpaid bookings/i);
const save = () => screen.getByRole('button', { name: /^save$/i });

beforeEach(() => {
  vi.clearAllMocks();
  api.lifecycleSettings.mockResolvedValue(payload());
  api.saveLifecycleSettings.mockResolvedValue({ saved: [], settings: {} });
});

describe('the switch', () => {
  test('one switch turns chasing on, and the rest of the page appears under it', async () => {
    api.lifecycleSettings.mockResolvedValue(payload(OFF));
    show();
    await waitFor(() => expect(chasing()).not.toBeChecked());
    expect(screen.queryByText('Visitors')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /preview today/i })).toHaveAttribute('href', '/booking-status');

    await userEvent.click(chasing());

    expect(screen.getByText('Visitors')).toBeInTheDocument();
    expect(screen.getByText('Tour operators')).toBeInTheDocument();
  });

  test('turning it on sets every underlying flag the server needs, in one save', async () => {
    api.lifecycleSettings.mockResolvedValue(payload(OFF));
    show();
    await waitFor(() => expect(chasing()).not.toBeChecked());

    await userEvent.click(chasing());
    await userEvent.click(save());

    await waitFor(() =>
      expect(api.saveLifecycleSettings).toHaveBeenCalledWith({ enabled: true, deadlines: true, scheduled: true }),
    );
  });

  test('turning it off clears them together', async () => {
    show();
    await waitFor(() => expect(chasing()).toBeChecked());

    await userEvent.click(chasing());
    await userEvent.click(save());

    await waitFor(() =>
      expect(api.saveLifecycleSettings).toHaveBeenCalledWith({ enabled: false, deadlines: false, scheduled: false }),
    );
  });
});

describe('when a booking never pays', () => {
  test('stopping to ask is the default and the recommended one', async () => {
    show();
    await waitFor(() => expect(screen.getByRole('radio', { name: /stop and ask me/i })).toBeChecked());
    expect(screen.getByText('recommended')).toBeInTheDocument();
  });

  test('choosing to cancel asks once more, and will not save until answered', async () => {
    show();
    await waitFor(() => expect(screen.getByRole('radio', { name: /cancel it and tell them/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('radio', { name: /cancel it and tell them/i }));

    expect(screen.getByText(/before anyone here sees it/i)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/i understand/i));
    expect(save()).toBeEnabled();

    await userEvent.click(save());
    await waitFor(() => expect(api.saveLifecycleSettings).toHaveBeenCalledWith({ autoCancel: true }));
  });

  test('a club already cancelling is not asked again', async () => {
    api.lifecycleSettings.mockResolvedValue(payload({ ...ON, autoCancel: true }));
    show();
    await waitFor(() => expect(screen.getByRole('radio', { name: /cancel it and tell them/i })).toBeChecked());
    expect(screen.queryByLabelText(/i understand/i)).not.toBeInTheDocument();
  });

  test('the picture ends where the choice ends', async () => {
    show();
    await waitFor(() => expect(screen.getByText('Stops here')).toBeInTheDocument());
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /cancel it and tell them/i }));

    await waitFor(() => expect(screen.getByText('Cancelled')).toBeInTheDocument());
    expect(screen.queryByText('Stops here')).not.toBeInTheDocument();
  });
});

describe('the timings', () => {
  test('are sentences with their units in them', async () => {
    show();
    await waitFor(() => expect(screen.getByText(/payment due within/i)).toBeInTheDocument());
    expect(screen.getByText(/days of booking/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Days to pay')).toHaveValue(7);
    expect(screen.getByLabelText('Day the booking stops')).toHaveValue(10);
  });

  test('an order that cannot work is explained and blocks saving', async () => {
    show();
    await waitFor(() => expect(screen.getByLabelText('Days before the first reminder')).toBeInTheDocument());

    const reminder = screen.getByLabelText('Days before the first reminder');
    await userEvent.clear(reminder);
    await userEvent.type(reminder, '9');

    await waitFor(() => expect(screen.getByText(/reminder must come before the deadline/i)).toBeInTheDocument());
    expect(save()).toBeDisabled();
  });

  test('the picture follows the numbers', async () => {
    show();
    await waitFor(() => expect(screen.getByText('Day 5')).toBeInTheDocument());
    const reminder = screen.getByLabelText('Days before the first reminder');
    await userEvent.clear(reminder);
    await userEvent.type(reminder, '3');
    await waitFor(() => expect(screen.getByText('Day 3')).toBeInTheDocument());
  });

  test('turning visitor chasing off hides the visitor timings only', async () => {
    show();
    await waitFor(() => expect(screen.getByLabelText('Days to pay')).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText(/chase visitors for payment/i));

    expect(screen.queryByLabelText('Days to pay')).not.toBeInTheDocument();
    expect(screen.getByText('Tour operators')).toBeInTheDocument();
    expect(screen.getByLabelText('Days before play to confirm')).toBeInTheDocument();
  });
});

describe('tour operators', () => {
  test('are summarised in one line, with a link to their own module', async () => {
    show();
    await waitFor(() => expect(screen.getByText(/4 active accounts/i)).toBeInTheDocument());
    expect(
      screen.getByText(/1 with own deposit date · 1 on the default balance date · 1 not chased/i),
    ).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: /tour operators/i })) {
      expect(link).toHaveAttribute('href', '/operators');
    }
  });

  test('a missing contact email is flagged in red', async () => {
    api.lifecycleSettings.mockResolvedValue(
      payload(ON, { trade: { accounts: 2, ownDepositTerm: 0, ownBalanceTerm: 0, notChased: 0, noContactEmail: 2 } }),
    );
    show();
    await waitFor(() => expect(screen.getByText(/2 accounts have no contact email/i)).toBeInTheDocument());
  });

  test('no accounts at all offers to add one', async () => {
    api.lifecycleSettings.mockResolvedValue(
      payload(ON, { trade: { accounts: 0, ownDepositTerm: 0, ownBalanceTerm: 0, notChased: 0, noContactEmail: 0 } }),
    );
    show();
    await waitFor(() => expect(screen.getByRole('link', { name: /add one/i })).toHaveAttribute('href', '/operators'));
  });
});

describe('saving', () => {
  test('sends only what changed', async () => {
    show();
    await waitFor(() => expect(screen.getByLabelText('Days before the first reminder')).toBeInTheDocument());
    const reminder = screen.getByLabelText('Days before the first reminder');
    await userEvent.clear(reminder);
    await userEvent.type(reminder, '3');
    await userEvent.click(save());
    await waitFor(() => expect(api.saveLifecycleSettings).toHaveBeenCalledWith({ depositReminderDay: 3 }));
  });

  test('nothing to save means nothing to press', async () => {
    show();
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(save()).toBeDisabled();
  });

  test('discard puts it back', async () => {
    show();
    await waitFor(() => expect(chasing()).toBeChecked());
    await userEvent.click(chasing());
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(chasing()).toBeChecked();
  });

  test("the server's refusal is shown as it is", async () => {
    api.saveLifecycleSettings.mockRejectedValue(new Error('The final details must go out after the confirmation'));
    show();
    await waitFor(() => expect(chasing()).toBeChecked());
    await userEvent.click(chasing());
    await userEvent.click(save());
    await waitFor(() =>
      expect(screen.getByText('The final details must go out after the confirmation')).toBeInTheDocument(),
    );
  });

  test('a reader who cannot edit gets no controls to press', async () => {
    api.lifecycleSettings.mockResolvedValue(payload(ON, { canEdit: false }));
    show();
    await waitFor(() => expect(screen.getByText(/only an administrator/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(chasing()).toBeDisabled();
  });
});
