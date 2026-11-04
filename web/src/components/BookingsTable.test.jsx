import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingsTable from './BookingsTable.jsx';

const base = {
  date: '2027-06-10',
  teeTime: '09:10',
  players: 4,
  total: 600,
  status: 'Inquiry',
  timestamp: '2026-10-16T08:00:00Z',
};

/** The three shapes a County Louth booking's names come in. */
const bookings = [
  // An operator's booking: the address is theirs, the round is somebody else's.
  { ...base, bookingId: 'B-1', guestEmail: 'bookings@halcyongolftravel.com', guestName: 'Lori Corrion' },
  // An enquiry that never named anybody.
  { ...base, bookingId: 'B-2', guestEmail: 'neil.murphy@golfthepatch.com', guestName: '' },
  // A guest who booked their own round.
  { ...base, bookingId: 'B-3', guestEmail: 'normcook59@gmail.com', guestName: 'Adam Gordon' },
];

const renderTable = (rows = bookings) =>
  render(<BookingsTable bookings={rows} onSelect={() => {}} onAdvance={() => {}} busyId={null} />);

/** The Lead guest cell of each row, in the order the table shows them. */
function leadGuestColumn() {
  const headers = [...screen.getAllByRole('columnheader')].map((th) => th.textContent);
  const index = headers.findIndex((text) => text.includes('Lead guest'));
  return [...screen.getAllByRole('row')].slice(1).map((row) => row.querySelectorAll('td')[index]?.textContent ?? '');
}

describe('the Lead guest column', () => {
  test('names whose round it is, which the address on the row does not', () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: /Lead guest/ })).toBeInTheDocument();
    expect(screen.getByText('Lori Corrion')).toBeInTheDocument();
    // The address is still there, and is no longer run together with the name.
    expect(screen.getByText('bookings@halcyongolftravel.com')).toBeInTheDocument();
    expect(screen.queryByText(/Lori Corrion ·/)).not.toBeInTheDocument();
  });

  test('says when nobody was named, rather than leaving a blank', () => {
    // Around a third of bookings are like this. A blank cell reads as a broken
    // column; "Not given" reads as a thin enquiry, which is what it is.
    renderTable();
    expect(leadGuestColumn()[1]).toBe('Not given');
  });

  test('sorts by name, with the unnamed bookings last whichever way round', async () => {
    const user = userEvent.setup();
    renderTable();
    const header = screen.getByRole('columnheader', { name: /Lead guest/ });

    await user.click(header);
    expect(leadGuestColumn()).toEqual(['Adam Gordon', 'Lori Corrion', 'Not given']);

    await user.click(header);
    expect(leadGuestColumn()).toEqual(['Lori Corrion', 'Adam Gordon', 'Not given']);
  });
});
