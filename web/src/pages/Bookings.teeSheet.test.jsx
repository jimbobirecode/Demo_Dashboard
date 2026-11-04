/**
 * Bookings a payment booked, waiting to go on the club's tee sheet.
 *
 * A direct customer pays on the booking form and the payment books the round
 * with nobody at the club having touched it. What these guard: the page says
 * how many are waiting, across every date; one press shows just them; the
 * drawer says what to do and clears the flag; and a booking with nothing to
 * do shows nothing.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import Bookings from './Bookings.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: {
    bookings: vi.fn(),
    setStatus: vi.fn(),
    fixTeeTimes: vi.fn(),
    setTeeSheet: vi.fn(),
    // What the drawer loads beside the booking.
    bookingThread: vi.fn(),
    paymentConfig: vi.fn(),
  },
  exportUrl: () => '#',
}));

const booking = (over) => ({
  guestEmail: `${over.bookingId.toLowerCase()}@example.com`,
  guestName: '',
  date: '2027-06-10',
  teeTime: '09:10',
  players: 4,
  total: 1540,
  amountPaid: 0,
  status: 'Booked',
  operatorName: null,
  timestamp: '2026-11-01T09:00:00Z',
  teeSheetStatus: null,
  payment: { status: 'Unpaid', outstanding: 0, settled: true, tracked: true, stages: [] },
  ...over,
});

const PAID_ONLINE = booking({
  bookingId: 'FORM-1',
  guestName: 'Anne Kelly',
  amountPaid: 1540,
  stripePaidAt: '2026-11-03T10:15:00Z',
  // Next summer: outside any date range on screen, still to do today.
  date: '2027-08-20',
  teeSheetStatus: 'to_enter',
  payment: { status: 'Paid', outstanding: 0, settled: true, tracked: true, stages: [] },
});
const ON_THE_SHEET = booking({ bookingId: 'FORM-0', teeSheetStatus: 'entered', teeSheetEnteredBy: 'desk' });
const CONFIRMED = booking({ bookingId: 'DESK-1' });

const mount = () =>
  render(
    <MemoryRouter>
      <Bookings user={{ role: 'admin' }} />
    </MemoryRouter>,
  );

const rowRefs = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('td')?.textContent ?? '')
    .filter(Boolean);

beforeEach(() => {
  vi.resetAllMocks();
  api.bookings.mockResolvedValue({ bookings: [PAID_ONLINE, ON_THE_SHEET, CONFIRMED], operators: [] });
  api.bookingThread.mockResolvedValue({ messages: [] });
  api.paymentConfig.mockResolvedValue({ configured: false, missing: ['STRIPE_SECRET_KEY'] });
});

describe('paid online, to put on the tee sheet', () => {
  test('the page says how many are waiting, and one press shows just them', async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText('1 paid online — to put on the tee sheet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(rowRefs()).toEqual([expect.stringContaining('FORM-1')]));
    // Marked in the list as well.
    expect(screen.getByText('Put on tee sheet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show all bookings' }));
    await waitFor(() => expect(rowRefs().length).toBe(3));
  });

  test('the drawer says what to do, and the button clears it', async () => {
    const user = userEvent.setup();
    api.setTeeSheet.mockResolvedValue({
      booking: { ...PAID_ONLINE, teeSheetStatus: 'entered', teeSheetEnteredBy: 'desk@club.test' },
    });
    mount();
    await user.click(await screen.findByText(/FORM-1/));
    const drawer = screen.getByRole('dialog', { name: 'Booking FORM-1' });
    expect(within(drawer).getByText('Paid online — put it on the tee sheet')).toBeInTheDocument();
    expect(within(drawer).getByText(/Anne Kelly paid €1,540/)).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: /Done — it.s on the tee sheet/ }));
    expect(api.setTeeSheet).toHaveBeenCalledWith('FORM-1', true);
    expect(await within(drawer).findByText(/On the tee sheet · marked by desk@club\.test/)).toBeInTheDocument();
    // Nothing left waiting, so nothing is asked of anybody.
    expect(screen.queryByText(/paid online — to put on the tee sheet/)).not.toBeInTheDocument();
  });

  test('a booking with nothing to do shows nothing', async () => {
    const user = userEvent.setup();
    api.bookings.mockResolvedValue({ bookings: [CONFIRMED], operators: [] });
    mount();
    await user.click(await screen.findByText(/DESK-1/));
    expect(screen.queryByText('Paid online — put it on the tee sheet')).not.toBeInTheDocument();
    expect(screen.queryByText(/paid online — to put on the tee sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText('Put on tee sheet')).not.toBeInTheDocument();
  });
});
