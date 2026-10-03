import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Portal from './Portal.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  portalStatementUrl: '/api/portal/statement.csv',
  api: {
    portalMe: vi.fn(),
    portalBookings: vi.fn(),
    portalLogin: vi.fn(),
    portalRedeem: vi.fn(),
  },
}));

function signedOut() {
  const err = Object.assign(new Error('Not signed in'), { status: 401 });
  api.portalMe.mockRejectedValue(err);
  api.portalBookings.mockRejectedValue(err);
}

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Portal />
    </MemoryRouter>,
  );
}

describe('Portal sign-in', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signedOut();
  });

  test('a signed-out visitor gets the email form, which sends the trimmed address', async () => {
    const user = userEvent.setup();
    api.portalLogin.mockResolvedValue({ ok: true, message: 'If that address has an account, a link is on its way.' });
    renderAt('/portal');

    const input = await screen.findByLabelText(/work email address/i);
    const submit = screen.getByRole('button', { name: /email me a sign-in link/i });
    expect(submit).toBeDisabled();

    await user.type(input, '  accounts@first-tours.test ');
    await user.click(submit);

    expect(api.portalLogin).toHaveBeenCalledWith('accounts@first-tours.test');
    expect(await screen.findByRole('status')).toHaveTextContent('If that address has an account');
    // The same neutral reply either way; the form is replaced by a way back.
    expect(screen.queryByLabelText(/work email address/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use a different address/i })).toBeInTheDocument();
  });

  test('a failed request shows the error and keeps the form', async () => {
    const user = userEvent.setup();
    api.portalLogin.mockRejectedValue(new Error('Too many requests'));
    renderAt('/portal');

    await user.type(await screen.findByLabelText(/work email address/i), 'a@b.test');
    await user.click(screen.getByRole('button', { name: /email me a sign-in link/i }));

    expect(await screen.findByRole('status')).toHaveTextContent('Too many requests');
    expect(screen.getByLabelText(/work email address/i)).toBeInTheDocument();
  });

  test('a sign-in link without a token says so instead of calling the server', async () => {
    renderAt('/portal/sign-in');
    expect(await screen.findByRole('status')).toHaveTextContent(/link is incomplete/i);
    expect(api.portalRedeem).not.toHaveBeenCalled();
  });
});
