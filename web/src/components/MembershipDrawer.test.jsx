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

  test('shows every applicant detail, with the postcode beside the address', async () => {
    api.membershipApplication.mockResolvedValue(
      detail('submitted', ['under_review'], {
        firstName: 'Isla',
        lastName: 'Munro',
        dateOfBirth: '1986-04-12',
        phone: '+44 7700 900101',
        address: '4 Castle Street, Dornoch',
        postcode: 'IV25 3SN',
        homeClub: 'Tain Golf Club',
        otherClubs: 'Brora Golf Club',
        handicap: '11.2',
        cdhNumber: '1000000101',
      }),
    );
    render(<MembershipDrawer applicationId={7} enabled onClose={vi.fn()} onChanged={vi.fn()} />);

    const details = await screen.findByRole('region', { name: 'Applicant details' });
    expect(details).toHaveTextContent(/Permanent address\s*4 Castle Street, Dornoch\s+IV25 3SN/);
    for (const text of ['+44 7700 900101', 'Tain Golf Club', 'Brora Golf Club', '11.2', '1000000101', 'Munro']) {
      expect(details).toHaveTextContent(text);
    }
    expect(details).toHaveTextContent('CDH number');
    expect(details).toHaveTextContent('Other clubs');
  });

  test('the conversation with the applicant is here, and says what the team still owes them', async () => {
    // Membership email is not in the Inbox, so an unanswered reply has to be
    // visible on the application itself.
    api.membershipApplication.mockResolvedValue({
      ...detail('submitted', ['under_review']),
      needsReply: 'Reply about membership application MEM-20261004-ABCD1234 (submitted) - for the team to answer.',
      thread: [
        {
          id: 3,
          direction: 'inbound',
          fromEmail: 'isla@example.com',
          subject: 'Joining',
          body: 'I would like to join.',
          createdAt: '2026-10-01T08:00:00Z',
        },
        {
          id: 4,
          direction: 'inbound',
          fromEmail: 'isla@example.com',
          subject: 'Re: Joining',
          body: 'Any news on my application?',
          createdAt: '2026-10-03T08:00:00Z',
        },
      ],
    });
    render(<MembershipDrawer applicationId={7} enabled onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText(/for the team to answer/)).toBeInTheDocument();
    expect(screen.getByText('2 emails with isla@example.com')).toBeInTheDocument();
    expect(screen.getByText('Any news on my application?')).toBeInTheDocument();
    expect(screen.getByText('I would like to join.')).toBeInTheDocument();
  });
});
