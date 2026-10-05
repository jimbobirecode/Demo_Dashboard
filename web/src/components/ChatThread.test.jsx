import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatThread from './ChatThread.jsx';

const guest = {
  id: 1,
  direction: 'inbound',
  fromEmail: 'isla@example.com',
  body: 'Can we move to the Tuesday?',
  createdAt: '2026-10-01T08:00:00Z',
};

describe('ChatThread', () => {
  test('a club email is stamped with the user who sent it, the same for everybody', () => {
    // It used to read "You (alice)" whoever was looking, which told bob he
    // had written alice's reply.
    render(
      <ChatThread
        guestName="Isla Munro"
        thread={[
          guest,
          {
            id: 2,
            direction: 'outbound',
            sentBy: 'alice@club.test',
            body: 'Of course.',
            createdAt: '2026-10-01T09:00:00Z',
          },
        ]}
      />,
    );
    expect(screen.getByText('alice@club.test')).toBeInTheDocument();
    expect(screen.queryByText(/^You \(/)).not.toBeInTheDocument();
  });

  test('the bot and Stripe are named for what they are, and an unattributed email is the club', () => {
    render(
      <ChatThread
        thread={[
          {
            id: 3,
            direction: 'outbound',
            sentBy: 'bot',
            body: 'Here are the times.',
            createdAt: '2026-10-01T09:00:00Z',
          },
          { id: 4, direction: 'outbound', sentBy: 'Stripe', body: 'Receipt.', createdAt: '2026-10-01T10:00:00Z' },
          { id: 5, direction: 'outbound', sentBy: null, body: 'Older email.', createdAt: '2026-10-01T11:00:00Z' },
        ]}
      />,
    );
    expect(screen.getByText('Sent automatically')).toBeInTheDocument();
    expect(screen.getByText('Sent on payment')).toBeInTheDocument();
    expect(screen.getByText('The club')).toBeInTheDocument();
  });

  test('the guest is named from their booking, and an empty thread says so', () => {
    const { unmount } = render(<ChatThread thread={[guest]} guestName="Isla Munro" />);
    expect(screen.getByText('Isla Munro')).toBeInTheDocument();
    unmount();

    render(<ChatThread thread={[]} />);
    expect(screen.getByText('No emails yet.')).toBeInTheDocument();
  });
});
