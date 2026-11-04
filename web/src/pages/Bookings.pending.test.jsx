/**
 * The money view on the Bookings page.
 *
 * "Booked" and "paid for" are two different questions, and the page could only
 * answer the first. A club chasing what it is owed had to open the Tour
 * Operators ledger, which is organised by account rather than by booking, or
 * read down a page of 549 booked rounds looking at a column.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render as renderBare, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Bookings from './Bookings.jsx';
import { api } from '../lib/api.js';
import { MemoryRouter } from 'react-router-dom';

// The page reads ?booking= from the address, so it needs a router around it.
const render = (ui) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

vi.mock('../lib/api.js', () => ({
  api: { bookings: vi.fn(), setStatus: vi.fn(), fixTeeTimes: vi.fn() },
  exportUrl: () => '#',
}));

const booking = (over) => ({
  bookingId: over.bookingId,
  guestEmail: `${over.bookingId.toLowerCase()}@operator.test`,
  guestName: '',
  date: '2027-06-10',
  teeTime: '09:10',
  players: 4,
  total: 1000,
  status: 'Booked',
  operatorName: null,
  timestamp: '2026-10-01T09:00:00Z',
  ...over,
});

const payment = (over = {}) => ({
  status: 'Unpaid',
  outstanding: 0,
  overdue: false,
  daysOverdue: 0,
  dueDate: null,
  settled: true,
  tracked: true,
  stages: [],
  ...over,
});

const BOOKINGS = [
  // Owed for, and late.
  booking({
    bookingId: 'LATE-1',
    payment: payment({ outstanding: 400, overdue: true, daysOverdue: 12, dueDate: '2026-10-07', settled: false }),
  }),
  // Owed for, not yet late, a link already sent.
  booking({
    bookingId: 'SOON-1',
    payment: payment({ status: 'Pending', outstanding: 600, dueDate: '2027-04-01', settled: false }),
  }),
  // Booked and paid: not in this view.
  booking({ bookingId: 'PAID-1', payment: payment({ status: 'Paid' }) }),
  // Owes money, but nobody has booked it: not in this view either.
  booking({ bookingId: 'ENQ-1', status: 'Inquiry', payment: payment({ outstanding: 999, settled: false }) }),
];

const rowRefs = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('td')?.textContent ?? '')
    .filter(Boolean);

beforeEach(() => {
  vi.resetAllMocks();
  api.bookings.mockResolvedValue({ bookings: BOOKINGS, operators: [] });
});

describe('Booked · pending payment', () => {
  test('the stage counts what is booked and still owed for, and what that comes to', async () => {
    render(<Bookings user={{ role: 'admin' }} />);
    const tile = await screen.findByRole('button', { name: /Booked · pending payment/ });

    // Two of the four: the paid one and the enquiry are not pending payment.
    expect(within(tile).getByText('2')).toBeInTheDocument();
    expect(within(tile).getByText(/€1,000 owed/)).toBeInTheDocument();
  });

  test('pressing it narrows the list to those bookings, and pressing again puts them back', async () => {
    const user = userEvent.setup();
    render(<Bookings user={{ role: 'admin' }} />);
    const tile = await screen.findByRole('button', { name: /Booked · pending payment/ });

    await user.click(tile);
    await waitFor(() => expect(rowRefs().join(' ')).toContain('LATE-1'));
    const shown = rowRefs().join(' ');
    expect(shown).toContain('SOON-1');
    expect(shown).not.toContain('PAID-1');
    expect(shown).not.toContain('ENQ-1');

    await user.click(tile);
    await waitFor(() => expect(rowRefs().join(' ')).toContain('PAID-1'));
  });

  test('the payment filter appears with the view, and not before it', async () => {
    const user = userEvent.setup();
    render(<Bookings user={{ role: 'admin' }} />);
    await screen.findByRole('button', { name: /Booked · pending payment/ });

    // A payment filter over every booking would filter by a balance most of
    // them do not have.
    expect(screen.queryByLabelText('Payment state')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Booked · pending payment/ }));
    expect(screen.getByLabelText('Payment state')).toBeInTheDocument();
  });

  test('the list can be narrowed again to the ones that are late', async () => {
    const user = userEvent.setup();
    render(<Bookings user={{ role: 'admin' }} />);
    await user.click(await screen.findByRole('button', { name: /Booked · pending payment/ }));

    await user.selectOptions(screen.getByLabelText('Payment state'), 'overdue');
    await waitFor(() => expect(rowRefs().join(' ')).not.toContain('SOON-1'));
    expect(rowRefs().join(' ')).toContain('LATE-1');
  });

  test('and by a payment status that shares a word with the booking pipeline', async () => {
    const user = userEvent.setup();
    render(<Bookings user={{ role: 'admin' }} />);
    await user.click(await screen.findByRole('button', { name: /Booked · pending payment/ }));

    // 'Pending' is a payment link sent, not the old spelling of 'Inquiry'.
    await user.selectOptions(screen.getByLabelText('Payment state'), 'status:Pending');
    await waitFor(() => expect(rowRefs().join(' ')).not.toContain('LATE-1'));
    expect(rowRefs().join(' ')).toContain('SOON-1');
  });

  test('the money columns are shown even though nothing here has been paid', async () => {
    // The table hides them when no booking has an operator or a payment past
    // "Unpaid" -- which is exactly what a page of unpaid bookings looks like.
    const user = userEvent.setup();
    render(<Bookings user={{ role: 'admin' }} />);
    await user.click(await screen.findByRole('button', { name: /Booked · pending payment/ }));

    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent.replace(/[▲▼\s]+$/, ''));
    expect(headers).toContain('Payment');
    expect(headers).toContain('Outstanding');
  });
});

describe('the booking flow', () => {
  const stageNames = () =>
    screen
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((text) => /Inquiry|Requested|Booked/.test(text));

  test('the stages read in the order a booking moves through them', async () => {
    render(<Bookings user={{ role: 'admin' }} />);
    await screen.findByRole('button', { name: /Booked · pending payment/ });

    const order = stageNames().slice(0, 4);
    expect(order[0]).toMatch(/^Inquiry\d/);
    expect(order[1]).toMatch(/^Requested\d/);
    expect(order[2]).toMatch(/^Booked · pending payment\d/);
    expect(order[3]).toMatch(/^Booked\d/);
  });

  test('the stages carry no arrows between them', async () => {
    const { container } = render(<Bookings user={{ role: 'admin' }} />);
    await screen.findByRole('button', { name: /Booked · pending payment/ });

    // The order is the order on the screen; arrows between four boxes were
    // three more things to read for something already plain.
    expect(container.querySelectorAll('.flow-arrow')).toHaveLength(0);
  });

  test('rejected and cancelled are a line of text, not stages', async () => {
    const user = userEvent.setup();
    render(<Bookings user={{ role: 'admin' }} />);
    await screen.findByRole('button', { name: /Booked · pending payment/ });

    // Nothing passes through them on the way to playing golf, so they carry
    // no stage of their own -- but the counts are still reachable.
    expect(screen.getByText(/not stages, and left out of the flow above/)).toBeInTheDocument();
    const rejected = screen.getByRole('button', { name: /rejected/ });
    await user.click(rejected);
    await waitFor(() => expect(screen.getByText(/0 of 4 bookings/)).toBeInTheDocument());
  });

  test('the booked value is not on this page -- it belongs to Analytics', async () => {
    const { container } = render(<Bookings user={{ role: 'admin' }} />);
    await screen.findByRole('button', { name: /Booked · pending payment/ });

    // A money total is not something anybody works from this list, and the
    // Analytics page already carries it under the same name.
    expect(container.querySelector('.flow-summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Booked value')).not.toBeInTheDocument();
  });

  test('the Booked stage says how much of it is still owed for', async () => {
    render(<Bookings user={{ role: 'admin' }} />);
    const booked = await screen.findByRole('button', { name: /^Booked 3/ });
    expect(booked.textContent).toContain('Including 2 not yet paid');
  });
});
