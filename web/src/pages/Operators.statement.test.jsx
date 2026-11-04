/**
 * One account's statement.
 *
 * Perry Golf's had thirty-three bookings among sixty-three open enquiries,
 * two enquiries marked "7d late" for a deposit nobody had asked for, the
 * contact address printed twice, and the money columns off the edge of a
 * table that scrolled sideways. What these guard: booked rounds first and
 * enquiries a click away; an enquiry never shown as owing; every column
 * sortable; a row that opens to show deposit and balance apiece; and a way
 * into the booking itself.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import Operators from './Operators.jsx';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: {
    operators: vi.fn(),
    operator: vi.fn(),
    operatorSuggestions: vi.fn(),
    createOperator: vi.fn(),
    updateOperator: vi.fn(),
    deleteOperator: vi.fn(),
    assignOperator: vi.fn(),
  },
}));

const PERRY = {
  id: 47,
  name: 'Perry Golf',
  contactName: 'carol.bennie@perrygolf.com',
  contactEmail: 'carol.bennie@perrygolf.com',
  emailDomains: ['perrygolf.com'],
  terms: '30% deposit, balance due 60 days before play, net 7 days',
  onHold: false,
  active: true,
  account: {
    bookings: 4,
    byStatus: { Booked: 3, Inquiry: 1, Requested: 0, Rejected: 0, Cancelled: 0 },
    unconfirmed: 1,
    committedGross: 7800,
    paid: 780,
    outstanding: 7020,
    overdueAmount: 780,
    overdueCount: 1,
    headroom: 42980,
    creditLimit: 50000,
  },
};

const stage = (id, label, amount, paid, dueDate, over = {}) => ({
  id,
  label,
  amount,
  paid,
  outstanding: amount - paid,
  dueDate,
  settled: amount - paid === 0,
  overdue: false,
  daysOverdue: 0,
  ...over,
});

const booked = (bookingId, date, guestName, players, paid, payment = {}) => ({
  bookingId,
  date,
  guestName,
  players,
  total: players * 325,
  status: 'Booked',
  teeTime: '10:20',
  guestEmail: 'carol.bennie@perrygolf.com',
  payment: {
    tracked: true,
    status: paid ? 'Deposit paid' : 'Unpaid',
    outstanding: players * 325 - paid,
    dueDate: '2027-07-01',
    daysUntilDue: 240,
    settled: false,
    overdue: false,
    stages: [
      stage('deposit', 'Deposit (30%)', players * 97.5, Math.min(paid, players * 97.5), '2026-10-06'),
      stage('balance', 'Balance', players * 227.5, 0, '2027-07-06'),
    ],
    ...payment,
  },
});

const BOOKINGS = [
  booked('BOOK-20260929-20353C74', '2027-09-04', 'Zed Adams', 8, 0, {
    overdue: true,
    daysOverdue: 27,
    dueDate: '2026-10-06',
    status: 'Pending',
  }),
  booked('BOOK-20260922-144C86BC', '2027-09-17', 'Anna Byrne', 8, 780),
  booked('BOOK-20261001-503F4A11', '2027-09-11', 'Mark Cole', 8, 2600, {
    outstanding: 0,
    settled: true,
    status: 'Paid',
  }),
  {
    bookingId: 'BOOK-20261019-59F131EE',
    date: '2028-06-30',
    guestName: 'Enquirer',
    players: 4,
    total: 1300,
    status: 'Inquiry',
    // What the server sends for an enquiry: the arithmetic of a booking
    // that does not exist yet, overdue and all.
    payment: { tracked: true, status: 'Unpaid', outstanding: 1300, overdue: true, daysOverdue: 7, stages: [] },
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  api.operators.mockResolvedValue({
    today: '2026-11-02',
    tracksPayments: true,
    ageingBands: [],
    paymentStatuses: [],
    operators: [PERRY],
    direct: { bookings: 0, outstanding: 0 },
    totals: { operators: 1, bookings: 4, booked: 3, outstanding: 7020, overdueAmount: 780, unconfirmed: 1 },
  });
  api.operatorSuggestions.mockResolvedValue({ suggestions: [], needsConfirming: [] });
  api.operator.mockResolvedValue({
    today: '2026-11-02',
    tracksPayments: true,
    operator: PERRY,
    account: PERRY.account,
    bookings: BOOKINGS,
  });
});

async function openPerry() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <Operators user={{ role: 'admin' }} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByText('Perry Golf'));
  const drawer = await screen.findByRole('dialog', { name: 'Perry Golf statement' });
  return { user, drawer };
}

const bookingIds = (drawer) =>
  within(drawer)
    .getAllByRole('row')
    .map((row) => row.querySelector('td.mono')?.textContent)
    .filter(Boolean);

describe("an account's statement", () => {
  test('opens on the booked rounds, with the enquiries a click away', async () => {
    const { user, drawer } = await openPerry();
    expect(bookingIds(drawer)).toHaveLength(3);
    expect(bookingIds(drawer)).not.toContain('BOOK-20261019-59F131EE');

    await user.click(within(drawer).getByRole('button', { name: 'Enquiries (1)' }));
    expect(bookingIds(drawer)).toEqual(['BOOK-20261019-59F131EE']);
  });

  test('an enquiry is never shown as owing, or as late', async () => {
    const { user, drawer } = await openPerry();
    await user.click(within(drawer).getByRole('button', { name: 'Enquiries (1)' }));
    expect(within(drawer).queryByText(/late/)).not.toBeInTheDocument();
    expect(within(drawer).getByText('Not booked')).toBeInTheDocument();
  });

  test('the owing and overdue views say what they hold', async () => {
    const { user, drawer } = await openPerry();
    await user.click(within(drawer).getByRole('button', { name: 'Owing (2)' }));
    expect(bookingIds(drawer)).not.toContain('BOOK-20261001-503F4A11'); // paid in full
    await user.click(within(drawer).getByRole('button', { name: 'Overdue (1)' }));
    expect(bookingIds(drawer)).toEqual(['BOOK-20260929-20353C74']);
  });

  test('every column sorts', async () => {
    const { user, drawer } = await openPerry();
    // Opens soonest first.
    expect(bookingIds(drawer)).toEqual(['BOOK-20260929-20353C74', 'BOOK-20261001-503F4A11', 'BOOK-20260922-144C86BC']);
    await user.click(within(drawer).getByRole('columnheader', { name: /Lead guest/ }));
    const byGuest = bookingIds(drawer);
    await user.click(within(drawer).getByRole('columnheader', { name: /Lead guest/ }));
    expect(bookingIds(drawer)).toEqual([...byGuest].reverse());

    // Money opens largest first; paid in full owes nothing and sits last.
    await user.click(within(drawer).getByRole('columnheader', { name: /Outstanding/ }));
    expect(bookingIds(drawer)).toEqual(['BOOK-20260929-20353C74', 'BOOK-20260922-144C86BC', 'BOOK-20261001-503F4A11']);
  });

  test('a row opens to show deposit and balance apiece, and a way into the booking', async () => {
    const { user, drawer } = await openPerry();
    await user.click(within(drawer).getByRole('button', { name: 'Show BOOK-20260922-144C86BC' }));

    expect(within(drawer).getByText('Deposit (30%)')).toBeInTheDocument();
    expect(within(drawer).getByText('Balance')).toBeInTheDocument();
    // 780 of a 780 deposit: the stage reads Settled.
    expect(within(drawer).getByRole('cell', { name: 'Settled' })).toBeInTheDocument();
    const link = within(drawer).getByRole('link', { name: /Open booking/ });
    expect(link).toHaveAttribute('href', '/bookings?booking=BOOK-20260922-144C86BC');
  });

  test('an address is not printed twice where the name field holds it', async () => {
    const { drawer } = await openPerry();
    expect(within(drawer).getByText(/Payment emails go to/).textContent).toBe(
      'Payment emails go to carol.bennie@perrygolf.com',
    );
  });
});
