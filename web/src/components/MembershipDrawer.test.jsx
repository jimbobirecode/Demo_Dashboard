import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MembershipDrawer from './MembershipDrawer.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: {
    membershipApplication: vi.fn(),
    setMembershipStatus: vi.fn(),
    inviteMembershipApplicant: vi.fn(),
    addMembershipNote: vi.fn(),
  },
}));

function detail(status, nextStatuses, extra = {}) {
  return {
    application: {
      id: 7,
      reference: 'MEM-20261004-ABCD1234',
      kind: 'application',
      status,
      statusLabel: status,
      nextStatuses,
      name: 'Isla Munro',
      email: 'isla@example.com',
      createdAt: '2026-10-01T09:00:00Z',
      recommendedCategoryIds: [],
      staffNotes: '',
      ...extra,
    },
    category: { id: 1, name: 'Full', joiningFee: 2500, annualFee: 1850, active: true, eligibility: '' },
    recommendedCategories: [],
    events: [
      {
        id: 1,
        event: 'submitted',
        label: 'Application submitted',
        actor: 'guest',
        note: '',
        createdAt: '2026-10-01T10:00:00Z',
      },
    ],
    sourceEmail: {
      id: 3,
      fromEmail: 'isla@example.com',
      subject: 'Joining',
      body: 'I would like to join.',
      createdAt: '2026-10-01T08:00:00Z',
    },
    emailConfigured: true,
  };
}

describe('MembershipDrawer', () => {
  beforeEach(() => vi.resetAllMocks());

  test('offers only the valid next moves, and says which email goes before confirming', async () => {
    const user = userEvent.setup();
    api.membershipApplication.mockResolvedValue(detail('under_review', ['approved', 'declined']));
    api.setMembershipStatus.mockResolvedValue({
      application: { statusLabel: 'Declined' },
      emailed: true,
      emailKind: 'membership_declined',
    });
    const onChanged = vi.fn();
    render(<MembershipDrawer applicationId={7} enabled onClose={vi.fn()} onChanged={onChanged} />);

    expect(await screen.findByText('Isla Munro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send welcome' })).not.toBeInTheDocument();
    expect(screen.getByText('Application submitted')).toBeInTheDocument();
    expect(screen.getByText('I would like to join.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/The applicant will receive:.*courteous decline/);
    expect(api.setMembershipStatus).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: /Reason or message/ }), 'The list is full.');
    await user.click(screen.getByRole('button', { name: 'Confirm: Decline' }));
    expect(api.setMembershipStatus).toHaveBeenCalledWith(7, 'declined', 'The list is full.');
    expect(await screen.findByText(/Moved to Declined\. The applicant has been emailed\./)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  test('a waitlisted applicant cannot be invited while applications are closed', async () => {
    api.membershipApplication.mockResolvedValue(detail('waitlisted', ['invited', 'withdrawn'], { kind: 'waitlist' }));
    render(<MembershipDrawer applicationId={7} enabled={false} onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Invite to apply' })).toBeDisabled();
    expect(screen.getByText(/Applications are closed/)).toBeInTheDocument();
  });

  test('a finished application has no moves left', async () => {
    api.membershipApplication.mockResolvedValue(detail('welcomed', []));
    render(<MembershipDrawer applicationId={7} enabled onClose={vi.fn()} />);
    expect(await screen.findByText(/nothing more to do/)).toBeInTheDocument();
  });
});
