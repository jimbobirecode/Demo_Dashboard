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
  test('an operator writing about a booking is answered as the operator, not as the lead guest', async () => {
    // The booking is in the lead guest's name; the email is from the tour
    // operator who made it. Nothing on screen may call the operator by the
    // guest's name - that is how a reply ends up written to the wrong person.
    const fromOperator = {
      ...EMAIL,
      fromEmail: 'groups@tours.test',
      guestName: 'Isla Byrne',
      bookingGuestEmail: 'isla@example.com',
    };
    const booking = {
      bookingId: 'TMG-1',
      status: 'Requested',
      date: '2026-05-12',
      teeTime: '09:00 AM',
      players: 4,
      total: 400,
      guestName: 'Isla Byrne',
      guestEmail: 'isla@example.com',
    };
    api.inbox.mockResolvedValue(list(fromOperator));
    api.inboxMessage.mockResolvedValue({ message: fromOperator, thread: [fromOperator], booking, notes: [] });
    renderInbox();

    // No name is borrowed from the booking: the address is what is shown, and
    // the composer is titled for a reply to nobody in particular.
    expect(await screen.findByText('Reply')).toBeInTheDocument();
    expect(screen.getAllByText('groups@tours.test').length).toBeGreaterThan(0);
    expect(screen.getByText('Lead guest: Isla Byrne')).toBeInTheDocument();
    expect(screen.queryByText(/Reply to Isla/)).not.toBeInTheDocument();
  });

  test('the lead guest writing in is answered by name', async () => {
    const booking = {
      bookingId: 'TMG-1',
      status: 'Requested',
      date: '2026-05-12',
      teeTime: '09:00 AM',
      players: 4,
      total: 400,
      guestName: 'Isla Byrne',
      guestEmail: 'isla@example.com',
    };
    api.inboxMessage.mockResolvedValue({ message: EMAIL, thread: [EMAIL], booking, notes: [] });
    renderInbox();

    expect(await screen.findByText('Reply to Isla Byrne')).toBeInTheDocument();
    expect(screen.queryByText(/Lead guest:/)).not.toBeInTheDocument();
  });
  test('an address the club knows as a tour operator is named as the operator, not as a golfer', async () => {
    // One agency mailbox books for a different golfer every time, so the name
    // on any one booking says nothing about who owns the address. The server
    // names it from the operator account; the screen must not undo that.
    const message = { ...EMAIL, fromEmail: 'john@destinationgolfservices.com', guestName: 'Daniel De Mot' };
    const booking = {
      bookingId: 'BOOK-1',
      status: 'Requested',
      date: '2027-09-13',
      teeTime: '09:00 AM',
      players: 4,
      total: 400,
      guestName: 'Daniel De Mot',
      guestEmail: 'john@destinationgolfservices.com',
    };
    const correspondent = {
      email: 'john@destinationgolfservices.com',
      kind: 'operator',
      name: 'Destination Golf Services',
      label: 'Destination Golf Services',
      note: 'Tour operator. This address books on behalf of their clients, so it is not any one guest’s.',
    };
    api.inbox.mockResolvedValue(list({ ...message, correspondent }));
    api.inboxMessage.mockResolvedValue({ message, thread: [message], booking, notes: [], correspondent });
    renderInbox();

    expect(await screen.findByText('Reply to Destination Golf Services')).toBeInTheDocument();
    expect(screen.getAllByText('Tour operator').length).toBeGreaterThan(0);
    // The golfer is named as what the booking is about, never as the addressee.
    expect(screen.getByText(/the round is for Daniel De Mot, who is not who this email goes to/)).toBeInTheDocument();
    expect(screen.queryByText('Reply to Daniel De Mot')).not.toBeInTheDocument();
  });
});
