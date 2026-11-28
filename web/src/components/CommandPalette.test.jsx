import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CommandPalette, { MAX_BOOKING_RESULTS, searchCommands } from './CommandPalette.jsx';
import { api } from '../lib/api.js';

const PAGES = [
  { to: '/bookings', label: 'Bookings', icon: 'bookings' },
  { to: '/booking-status', label: 'Booking Status', icon: 'status' },
  { to: '/operators', label: 'Tour Operators', icon: 'operators' },
];

const BOOKINGS = [
  { bookingId: 'TMG-20270612-AAAA', guestName: 'Anna Lindqvist', guestEmail: 'anna@example.com', status: 'Booked' },
  {
    bookingId: 'TMG-20270618-BBBB',
    guestName: '',
    guestEmail: 'groups@harbourheath.example',
    operatorName: 'Harbour & Heath Golf Tours',
    status: 'Requested',
  },
  { bookingId: 'TMG-20270621-CCCC', guestName: 'Marcus Bell', guestEmail: 'marcus@example.com', status: 'Confirmed' },
];

describe('searchCommands', () => {
  test('with nothing typed it is a menu of pages, and lists no bookings', () => {
    const results = searchCommands('', { pages: PAGES, bookings: BOOKINGS });
    expect(results.map((r) => r.label)).toEqual(['Bookings', 'Booking Status', 'Tour Operators']);
  });

  test('finds a booking by guest, by address and by the operator who sent it', () => {
    const labels = (query) => searchCommands(query, { pages: [], bookings: BOOKINGS }).map((result) => result.label);
    expect(labels('lindqvist')).toEqual(['TMG-20270612-AAAA']);
    expect(labels('marcus@example')).toEqual(['TMG-20270621-CCCC']);
    expect(labels('harbour')).toEqual(['TMG-20270618-BBBB']);
  });

  test('every word has to match, so a second word narrows the search', () => {
    const results = searchCommands('heath golf', { pages: [], bookings: BOOKINGS });
    expect(results).toHaveLength(1);
    expect(searchCommands('heath marcus', { pages: [], bookings: BOOKINGS })).toHaveLength(0);
  });

  test('a reference that starts with what was typed comes before one that only contains it', () => {
    const bookings = [
      { bookingId: 'XX-TMG-1', guestName: 'Later' },
      { bookingId: 'TMG-1', guestName: 'Exact' },
      { bookingId: 'TMG-12', guestName: 'Prefix' },
    ];
    const order = searchCommands('tmg-1', { pages: [], bookings }).map((result) => result.label);
    expect(order).toEqual(['TMG-1', 'TMG-12', 'XX-TMG-1']);
  });

  test('a result links to the booking itself and shows the status it has today', () => {
    const [result] = searchCommands('marcus', { pages: [], bookings: BOOKINGS });
    expect(result.to).toBe('/bookings?booking=TMG-20270621-CCCC');
    // 'Confirmed' is a retired spelling of Booked.
    expect(result.status).toBe('Booked');
  });

  test('a long list is cut off rather than scrolled', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ bookingId: `TMG-${index}`, guestName: 'Same Name' }));
    expect(searchCommands('same', { pages: [], bookings: many })).toHaveLength(MAX_BOOKING_RESULTS);
  });
});

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

function renderPalette(props = {}) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/analytics']}>
      <CommandPalette open onClose={onClose} pages={PAGES} {...props} />
      <Where />
    </MemoryRouter>,
  );
  return { onClose };
}

describe('CommandPalette', () => {
  afterEach(() => vi.restoreAllMocks());

  test('typing a guest and pressing Enter opens their booking', async () => {
    vi.spyOn(api, 'bookings').mockResolvedValue({ bookings: BOOKINGS });
    const { onClose } = renderPalette();

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'lindqvist' } });
    await waitFor(() => expect(screen.getByText('TMG-20270612-AAAA')).toBeInTheDocument());

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/bookings?booking=TMG-20270612-AAAA');
  });

  test('the arrow keys move through the results and wrap', async () => {
    vi.spyOn(api, 'bookings').mockResolvedValue({ bookings: [] });
    renderPalette();
    const input = screen.getByRole('combobox');
    const selected = () =>
      screen.getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true');

    expect(selected()).toHaveTextContent('Bookings');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selected()).toHaveTextContent('Booking Status');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(selected()).toHaveTextContent('Tour Operators');
  });

  test('Escape closes it without going anywhere', () => {
    vi.spyOn(api, 'bookings').mockResolvedValue({ bookings: [] });
    const { onClose } = renderPalette();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/analytics');
  });

  test('pages still work when the bookings cannot be loaded, and it says why bookings are missing', async () => {
    vi.spyOn(api, 'bookings').mockRejectedValue(new Error('offline'));
    renderPalette();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'tour' } });

    expect(screen.getByText('Tour Operators')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/could not be loaded/)).toBeInTheDocument());
  });

  test('closed, it renders nothing and fetches nothing', () => {
    const spy = vi.spyOn(api, 'bookings').mockResolvedValue({ bookings: [] });
    render(
      <MemoryRouter>
        <CommandPalette open={false} onClose={() => {}} pages={PAGES} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});
