/**
 * The settings form for chasing unpaid bookings.
 *
 * What these guard: switching chasing on does not switch scheduled sending on
 * with it, and switching it off takes sending with it; cancelling needs a
 * second click before it can be saved; an
 * impossible ordering is refused before the round trip; and a page the
 * environment has locked, or a reader who is not an administrator, can look
 * but not touch.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import TriggerSettings from './TriggerSettings.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { triggerSettings: vi.fn(), saveTriggerSettings: vi.fn() },
}));

const SETTINGS = {
  enabled: false,
  automatic: false,
  autoCancel: false,
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

const BOUNDS = {
  depositDays: { min: 1, max: 365, label: 'Days to pay the deposit' },
  depositReminderDay: { min: 0, max: 364, label: 'Day of the first deposit reminder' },
  depositGraceDays: { min: 2, max: 365, label: 'Days between the deadline and cancellation' },
};

const payload = (over = {}) => ({
  saved: [],
  locked: false,
  inherited: SETTINGS,
  defaults: SETTINGS,
  bounds: BOUNDS,
  trade: { accounts: 2, ownDepositTerm: 1, ownBalanceTerm: 1, notChased: 1, noContactEmail: 0 },
  ready: true,
  missing: [],
  canEdit: true,
  ...over,
  settings: { ...SETTINGS, ...(over.settings ?? {}) },
});

const mount = () =>
  render(
    <MemoryRouter>
      <TriggerSettings />
    </MemoryRouter>,
  );

describe('the chasing settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.triggerSettings.mockResolvedValue(payload());
    api.saveTriggerSettings.mockImplementation(async (patch) => ({
      saved: Object.keys(patch),
      locked: false,
      settings: { ...SETTINGS, ...patch },
    }));
  });

  test('switching chasing on leaves sending to a person, and saves only what changed', async () => {
    mount();
    const toggle = await screen.findByRole('checkbox', { name: 'Chase unpaid bookings' });
    expect(screen.getByText(/Nothing is sent/)).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(screen.getByRole('radio', { name: /Stop and ask me/ })).toBeChecked();
    // Sending on its own is a separate decision, and the default is not to.
    const schedule = screen.getByRole('checkbox', { name: /Send on a schedule/ });
    expect(schedule).not.toBeChecked();
    expect(screen.getByText(/Nothing goes out by itself/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveTriggerSettings).toHaveBeenCalledWith({ enabled: true }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  test('scheduled sending is its own switch, and goes off with chasing', async () => {
    const live = { ...SETTINGS, enabled: true, automatic: true };
    api.triggerSettings.mockResolvedValue(payload({ settings: live }));
    api.saveTriggerSettings.mockImplementation(async (patch) => {
      Object.assign(live, patch);
      return { saved: Object.keys(patch), locked: false, settings: { ...live } };
    });
    mount();
    const schedule = await screen.findByRole('checkbox', { name: /Send on a schedule/ });
    expect(schedule).toBeChecked();
    expect(screen.getByText(/goes out each morning by itself/)).toBeInTheDocument();

    await userEvent.click(schedule);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveTriggerSettings).toHaveBeenCalledWith({ automatic: false }));

    // Chasing off takes sending with it: a club cannot be sending emails it
    // is not working out.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Chase unpaid bookings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveTriggerSettings).toHaveBeenLastCalledWith({ enabled: false }));
  });

  test('cancelling automatically needs a second click before it can be saved', async () => {
    api.triggerSettings.mockResolvedValue(payload({ settings: { enabled: true, automatic: true } }));
    mount();
    await userEvent.click(await screen.findByRole('radio', { name: 'Cancel it and tell them' }));

    expect(screen.getByText(/emailed that the booking is cancelled/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'I understand' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    // The timeline follows the choice.
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  test('an impossible ordering is refused before it reaches the server', async () => {
    api.triggerSettings.mockResolvedValue(payload({ settings: { enabled: true, automatic: true } }));
    mount();
    const window = await screen.findByRole('spinbutton', { name: 'Days to pay the deposit' });
    await userEvent.clear(window);
    await userEvent.type(window, '4');

    expect(screen.getByText('The reminder must come before the deadline.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(api.saveTriggerSettings).not.toHaveBeenCalled();
  });

  test('the trade book is summarised, with the accounts that are not chased counted', async () => {
    api.triggerSettings.mockResolvedValue(payload({ settings: { enabled: true, automatic: true } }));
    mount();
    expect(
      await screen.findByText(/2 active accounts · 1 with own deposit date · 1 on the default/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 not chased/)).toBeInTheDocument();
  });

  test('a reader who is not an administrator can look but not change', async () => {
    api.triggerSettings.mockResolvedValue(payload({ canEdit: false }));
    mount();
    expect(await screen.findByText('Only an administrator can change these.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Chase unpaid bookings' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  test('a workflow the environment has switched off says so and cannot be turned on here', async () => {
    api.triggerSettings.mockResolvedValue(payload({ locked: true }));
    mount();
    expect(await screen.findByText('TRIGGER_WORKFLOW=false')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Chase unpaid bookings' })).toBeDisabled();
  });
});
