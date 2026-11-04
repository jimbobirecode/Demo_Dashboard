/**
 * The switch for what goes to a guest without anybody pressing a button.
 *
 * Two things here could mislead a club: the desk being shown a control it
 * cannot use, and a half-made change looking saved. Both are covered.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render as renderBare, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import GuestEmailSettings from './GuestEmailSettings.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { guestEmailSettings: vi.fn(), saveGuestEmailSettings: vi.fn() },
}));

const render = (ui) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);
const toggle = () => screen.getByRole('checkbox', { name: /Acknowledge/ });

describe('emailing guests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.guestEmailSettings.mockResolvedValue({
      settings: { requestReceived: false },
      defaults: { requestReceived: false },
      canEdit: true,
    });
  });

  test('a club that has not turned it on is told nothing goes out', async () => {
    render(<GuestEmailSettings />);
    expect(await screen.findByText(/Nothing is sent when a request arrives/)).toBeInTheDocument();
    expect(toggle()).not.toBeChecked();
  });

  test('the desk can see the setting but not change it', async () => {
    api.guestEmailSettings.mockResolvedValue({
      settings: { requestReceived: true },
      defaults: { requestReceived: false },
      canEdit: false,
    });
    render(<GuestEmailSettings />);
    await waitFor(() => expect(toggle()).toBeChecked());
    expect(toggle()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  test('turning it on is not saved until Save is pressed, and only the change is sent', async () => {
    const user = userEvent.setup();
    api.saveGuestEmailSettings.mockResolvedValue({ settings: { requestReceived: true } });
    render(<GuestEmailSettings />);
    await waitFor(() => expect(toggle()).not.toBeChecked());

    // Nothing to save yet.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(toggle());
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    expect(api.saveGuestEmailSettings).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveGuestEmailSettings).toHaveBeenCalledWith({ requestReceived: true }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();
  });

  test('a save that fails says so, and leaves the change on screen', async () => {
    const user = userEvent.setup();
    api.saveGuestEmailSettings.mockRejectedValue(new Error('Run "npm run migrate" against this database'));
    render(<GuestEmailSettings />);
    await waitFor(() => expect(toggle()).not.toBeChecked());

    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/npm run migrate/)).toBeInTheDocument();
    expect(toggle()).toBeChecked();
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });
});
