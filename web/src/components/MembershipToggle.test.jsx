import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MembershipToggle from './MembershipToggle.jsx';

describe('MembershipToggle', () => {
  test('staff see the state and what guests receive, but cannot flip it', () => {
    render(<MembershipToggle enabled={false} canEdit={false} onChange={vi.fn()} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Closed – enquiries are offered the waitlist')).toBeInTheDocument();
    expect(screen.getByText(/link to join the waitlist/)).toBeInTheDocument();
    expect(screen.getByText('Only an administrator can change this.')).toBeInTheDocument();
  });

  test('an admin confirms before applications open, and is told what guests will get', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<MembershipToggle enabled={false} canEdit onChange={onChange} updatedBy="sec" />);

    await user.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Start accepting applications?');
    expect(dialog).toHaveTextContent(/membership categories and fees/);

    await user.click(screen.getByRole('button', { name: 'Yes, accept applications' }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  test('cancelling changes nothing; a failure is shown and the panel stays', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockRejectedValue(new Error('Administrator access is required'));
    render(<MembershipToggle enabled canEdit onChange={onChange} />);
    expect(screen.getByText('Accepting applications')).toBeInTheDocument();

    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Yes, close applications' }));
    expect(onChange).toHaveBeenCalledWith(false);
    expect(await screen.findByText('Administrator access is required')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
