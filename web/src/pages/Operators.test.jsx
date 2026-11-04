/**
 * Finding one trade account among many.
 *
 * The club trades with 138 operators, and nearly every question about this
 * page is about one of them by name. Before this there was only scrolling.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const account = (over = {}) => ({
  bookings: 4,
  byStatus: { Booked: 1, Inquiry: 3, Requested: 0, Rejected: 0, Cancelled: 0 },
  unconfirmed: 3,
  committedGross: 4000,
  outstanding: 1000,
  overdueAmount: 0,
  overdueCount: 0,
  creditLimit: null,
  overLimit: false,
  onHold: false,
  ...over,
});

function operator(id, name, over = {}) {
  return {
    id,
    name,
    contactName: '',
    contactEmail: `info@${name.toLowerCase().replace(/[^a-z]/g, '')}.com`,
    contactPhone: '',
    accountCode: '',
    emailDomains: [],
    terms: '30 days',
    onHold: false,
    active: true,
    account: account(),
    ...over,
  };
}

const OPERATORS = [
  operator(14, 'Destination Golf Services', {
    accountCode: 'DGS-001',
    emailDomains: ['destinationgolfservices.com'],
    contactName: 'John Field',
  }),
  operator(2, 'Links Travel'),
  operator(3, 'Fairway Breaks', { contactEmail: 'trade@fairwaybreaks.ie' }),
];

beforeEach(() => {
  vi.resetAllMocks();
  api.operators.mockResolvedValue({
    today: '2026-10-14',
    ageingBands: [],
    paymentStatuses: [],
    operators: OPERATORS,
    direct: { bookings: 0, outstanding: 0 },
    totals: {
      operators: 3,
      bookings: 12,
      booked: 3,
      outstanding: 3000,
      overdueAmount: 0,
      overdueCount: 0,
      unconfirmed: 9,
      overLimit: 0,
      onHold: 0,
    },
  });
  api.operatorSuggestions.mockResolvedValue({ suggestions: [], needsConfirming: [] });
});

describe('Operators search', () => {
  test('typing a name narrows the accounts to it', async () => {
    const user = userEvent.setup();
    render(<Operators user={{ role: 'admin' }} />);

    expect(await screen.findByText('Links Travel')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search tour operators'), 'destination');

    expect(screen.getByText('Destination Golf Services')).toBeInTheDocument();
    expect(screen.queryByText('Links Travel')).not.toBeInTheDocument();
    expect(screen.queryByText('Fairway Breaks')).not.toBeInTheDocument();
    // The tab says what is being shown, so a narrowed list is never mistaken
    // for the whole book of accounts.
    expect(screen.getByText('Accounts (1 of 3)')).toBeInTheDocument();
  });

  test('an account is found by the things staff actually quote', async () => {
    const user = userEvent.setup();
    render(<Operators user={{ role: 'admin' }} />);
    const box = await screen.findByLabelText('Search tour operators');

    // Account code, sending domain, contact name, contact email — none of
    // which is the operator's name, and all of which identify them.
    for (const needle of ['DGS-001', 'destinationgolfservices.com', 'John Field']) {
      await user.clear(box);
      await user.type(box, needle);
      expect(screen.getByText('Destination Golf Services')).toBeInTheDocument();
      expect(screen.queryByText('Links Travel')).not.toBeInTheDocument();
    }

    await user.clear(box);
    await user.type(box, 'trade@fairwaybreaks.ie');
    expect(screen.getByText('Fairway Breaks')).toBeInTheDocument();
  });

  test('case and stray spaces do not matter, and clearing brings everyone back', async () => {
    const user = userEvent.setup();
    render(<Operators user={{ role: 'admin' }} />);
    const box = await screen.findByLabelText('Search tour operators');

    await user.type(box, '  LINKS  ');
    expect(screen.getByText('Links Travel')).toBeInTheDocument();

    await user.clear(box);
    await waitFor(() => expect(screen.getByText('Destination Golf Services')).toBeInTheDocument());
    expect(screen.getByText('Links Travel')).toBeInTheDocument();
    expect(screen.getByText('Fairway Breaks')).toBeInTheDocument();
  });

  test('a search matching nothing says so and offers the way back', async () => {
    const user = userEvent.setup();
    render(<Operators user={{ role: 'admin' }} />);
    await user.type(await screen.findByLabelText('Search tour operators'), 'nobody');

    // Not the "no trade accounts yet" state, which would read as though the
    // club had none at all.
    expect(screen.getByText(/No tour operator matching/)).toBeInTheDocument();
    expect(screen.queryByText(/No trade accounts yet/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show all 3' }));
    expect(screen.getByText('Links Travel')).toBeInTheDocument();
  });

  test('the box is not offered on the Unrecognised tab, which lists no accounts', async () => {
    const user = userEvent.setup();
    render(<Operators user={{ role: 'admin' }} />);
    await user.click(await screen.findByRole('button', { name: /Unrecognised/ }));
    expect(screen.queryByLabelText('Search tour operators')).not.toBeInTheDocument();
  });
});

describe('without payment tracking', () => {
  test('no balance is shown anywhere on the page, and what is booked is', async () => {
    // tracksPayments is false: the club records no payments, so outstanding
    // would be the whole value of every booking wearing the word owed.
    render(<Operators user={{ role: 'admin' }} />);
    expect(await screen.findByText('Links Travel')).toBeInTheDocument();

    for (const gone of ['Outstanding', 'Overdue', 'Credit terms', 'Credit limit', 'Accounts to watch']) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    // The ledger tab is nothing but balances.
    expect(screen.queryByRole('button', { name: /Debtor ageing/ })).not.toBeInTheDocument();

    // What the page is actually read for stays, and the value of the
    // bookings is named for what it is -- the same name whether or not
    // balances are kept, because it is the same number either way.
    expect(screen.getByText('Booked value')).toBeInTheDocument();
    expect(screen.getByText('Trade accounts')).toBeInTheDocument();
  });

  test('turning tracking on brings the ledger back', async () => {
    const payload = await api.operators();
    api.operators.mockResolvedValue({ ...payload, tracksPayments: true });
    render(<Operators user={{ role: 'admin' }} />);

    expect(await screen.findByRole('button', { name: /Debtor ageing/ })).toBeInTheDocument();
    expect(screen.getAllByText('Outstanding').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Overdue').length).toBeGreaterThan(0);
    expect(screen.getByText('Booked value')).toBeInTheDocument();
  });
});

describe('booked rounds and enquiries, counted apart', () => {
  test('each account shows what it has booked and what it has only asked about', async () => {
    render(<Operators user={{ role: 'admin' }} />);
    await screen.findByText('Links Travel');

    // One "Bookings" column of both read as the denominator of a value that
    // only ever counted the booked ones: 94 bookings, €65,745 — from 33.
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent.replace(/[▲▼\s]+$/, ''));
    expect(headers).toContain('Booked');
    expect(headers).toContain('Enquiries');
    expect(headers).not.toContain('Bookings');
  });

  test('the value column is called what it counts', async () => {
    render(<Operators user={{ role: 'admin' }} />);
    await screen.findByText('Links Travel');

    // "Committed" meant Booked and said so nowhere.
    expect(screen.getByRole('columnheader', { name: /Booked value/ })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Committed/ })).not.toBeInTheDocument();
  });

  test('the headline counts the two apart rather than adding them up', async () => {
    render(<Operators user={{ role: 'admin' }} />);
    expect(await screen.findByText('3 booked · 9 enquiries')).toBeInTheDocument();
  });

  test('accounts with nothing booked can be hidden, and the list says how many went', async () => {
    const user = userEvent.setup();
    api.operators.mockResolvedValue({
      ...(await api.operators.mock.results[0]?.value),
      today: '2026-10-14',
      ageingBands: [],
      paymentStatuses: [],
      operators: [
        OPERATORS[0],
        // An account that has only ever enquired.
        { ...OPERATORS[1], account: account({ byStatus: { Booked: 0 }, unconfirmed: 7, committedGross: 0 }) },
        OPERATORS[2],
      ],
      direct: { bookings: 0, outstanding: 0 },
      totals: {
        operators: 3,
        bookings: 12,
        booked: 3,
        outstanding: 0,
        overdueAmount: 0,
        overdueCount: 0,
        unconfirmed: 9,
        overLimit: 0,
        onHold: 0,
      },
    });
    render(<Operators user={{ role: 'admin' }} />);
    expect(await screen.findByText('Links Travel')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Accounts that have booked something'));

    expect(screen.queryByText('Links Travel')).not.toBeInTheDocument();
    expect(screen.getByText(/1 account hidden/)).toBeInTheDocument();
    // And the enquiry column goes with them: it is what was just filtered out.
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent.replace(/[▲▼\s]+$/, ''));
    expect(headers).not.toContain('Enquiries');
  });
});
