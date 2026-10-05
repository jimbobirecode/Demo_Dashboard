import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Inbox from './Inbox.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: {
    inbox: vi.fn(),
    inboxMessage: vi.fn(),
    inboxReply: vi.fn(),
    inboxStatus: vi.fn(),
    inboxLink: vi.fn(),
    inboxNote: vi.fn(),
    inboxDelete: vi.fn(),
    inboxRestore: vi.fn(),
    emailPreview: vi.fn(),
  },
}));

const EMAIL = {
  id: 7,
  direction: 'inbound',
  fromEmail: 'isla@example.com',
  subject: 'Tee times in May',
  body: 'Can we play on the Tuesday?',
  reviewStatus: 'open',
  reviewReason: 'A question for the team',
  createdAt: '2026-10-01T08:00:00Z',
  deletedAt: null,
  deletedBy: null,
};

function list(message = EMAIL, counts = { open: 1 }) {
  return { messages: [message], counts };
}

function detail(message = EMAIL, notes = []) {
  return { message, thread: [message], booking: null, notes };
}

function renderInbox() {
  return render(
    <MemoryRouter>
      <Inbox />
    </MemoryRouter>,
  );
}

describe('Inbox', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.inbox.mockResolvedValue(list());
    api.inboxMessage.mockResolvedValue(detail());
  });

  test('an email can be deleted from the mailbox, after one question, and put back again', async () => {
    const user = userEvent.setup();
    const gone = { ...EMAIL, deletedAt: '2026-10-05T09:30:00Z', deletedBy: 'alice@club.test' };
    api.inboxDelete.mockResolvedValue({ ...detail(gone), notice: 'Deleted from the mailbox' });
    api.inboxRestore.mockResolvedValue({ ...detail(EMAIL), notice: 'Back in the mailbox' });
    renderInbox();

    // Nothing is deleted on a mis-click that the question catches.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(api.inboxDelete).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.inboxDelete).toHaveBeenCalledWith(7));

    // It now reads as deleted, by whom and when, and offers only to come back.
    expect(await screen.findByText(/Deleted by alice@club\.test/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send reply' })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be replied to/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Put it back in the mailbox' }));
    await waitFor(() => expect(api.inboxRestore).toHaveBeenCalledWith(7));
    expect(await screen.findByText('Needs a reply')).toBeInTheDocument();
  });

  test('the Deleted filter is its own list, with its own count', async () => {
    const user = userEvent.setup();
    api.inbox.mockResolvedValue(list(EMAIL, { open: 1, deleted: 3 }));
    renderInbox();

    const deleted = await screen.findByRole('button', { name: 'Deleted (3)' });
    await user.click(deleted);
    await waitFor(() => expect(api.inbox).toHaveBeenCalledWith('deleted'));
  });

  test('a note is shown with the user who wrote it and when, and never sent to the guest', async () => {
    const user = userEvent.setup();
    api.inboxMessage.mockResolvedValue(
      detail(EMAIL, [
        {
          id: 1,
          note: 'Called her back, happy to move.',
          createdBy: 'alice@club.test',
          createdAt: '2026-10-02T09:00:00Z',
        },
      ]),
    );
    api.inboxNote.mockResolvedValue({ ...detail(EMAIL, []), notice: 'Note added' });
    renderInbox();

    expect(await screen.findByText('Called her back, happy to move.')).toBeInTheDocument();
    expect(screen.getByText(/alice@club\.test ·/)).toBeInTheDocument();

    const box = screen.getByLabelText('Add a note for the team');
    const add = screen.getByRole('button', { name: 'Add note' });
    expect(add).toBeDisabled();

    await user.type(box, '  Left a voicemail  ');
    await user.click(add);
    await waitFor(() => expect(api.inboxNote).toHaveBeenCalledWith(7, 'Left a voicemail'));
  });

  test('a deleted email takes no new notes', async () => {
    api.inboxMessage.mockResolvedValue(
      detail({ ...EMAIL, deletedAt: '2026-10-05T09:30:00Z', deletedBy: 'alice@club.test' }),
    );
    renderInbox();

    expect(await screen.findByText(/No notes yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Add a note for the team')).not.toBeInTheDocument();
  });
});
