/**
 * The "Who this booking is with" card, which a long email address used to
 * paint straight through.
 *
 * A grid item's min-width is its content by default, so an address wider than
 * its 130px column rendered over the field beside it: at County Louth,
 * "bookings@halcyongolftravel.com" ran through "LEAD GUEST IN THE PARTY" and
 * neither could be read.
 */
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import BookingDrawer from './BookingDrawer.jsx';

vi.mock('../lib/api.js', () => ({
  api: { bookingThread: vi.fn().mockResolvedValue({ thread: [] }), emailPreview: vi.fn() },
}));

const booking = {
  bookingId: 'BOOK-1',
  status: 'Booked',
  date: '2027-09-23',
  teeTime: '09:10 AM',
  players: 4,
  total: 4620,
  guestEmail: 'bookings@halcyongolftravel.com',
  guestName: 'Lori Corrion',
  contactPhone: '+44 7547192579',
  caddieRequirements: 'Single Caddie (€80 + Gratuity each)',
  specialRequests: '',
  selectedTeeTimes: '',
  golfCourses: '',
};

const cellOf = (labelText) => screen.getByText(labelText).parentElement;

describe('who this booking is with', () => {
  test('the address we reply to gets a row of its own, so it cannot run over the field beside it', () => {
    render(<BookingDrawer booking={booking} onClose={() => {}} />);

    const email = cellOf('Email we reply to');
    expect(email).toHaveStyle({ gridColumn: '1 / -1' });
    // The one beside it does not, or every field would be a row.
    expect(cellOf('Lead guest')).not.toHaveStyle({ gridColumn: '1 / -1' });
  });

  test('the lead guest is labelled in two words, which fit on one line', () => {
    // "Lead guest in the party" wrapped to two lines in a 130px column, and
    // the wrapped half landed where the address beside it was overflowing.
    render(<BookingDrawer booking={booking} onClose={() => {}} />);
    expect(screen.getByText('Lead guest')).toBeInTheDocument();
    expect(screen.queryByText(/in the party/)).not.toBeInTheDocument();
    // Still said as what it is, beside the address it is not.
    expect(screen.getByText('Email we reply to')).toBeInTheDocument();
  });
});
