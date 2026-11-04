/**
 * The waitlist's "duplicates", which are not duplicates.
 *
 * A party that will take any of three days is three entries under one name.
 * Scattered down a list in date order that reads as the same enquiry recorded
 * three times — and the club asked twice why the list was full of duplicates.
 */
import { describe, expect, test } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import Waitlist from './Waitlist.jsx';
import { api } from '../lib/api.js';
import { vi } from 'vitest';

vi.mock('../lib/api.js', () => ({
  api: {
    waitlist: vi.fn(),
    addWaitlistEntry: vi.fn(),
    updateWaitlistEntry: vi.fn(),
    convertWaitlistEntry: vi.fn(),
    deleteWaitlistEntry: vi.fn(),
    linkWaitlistEntry: vi.fn(),
  },
}));

const CONVERSION = {
  open: 4,
  playersWaiting: 14,
  conversionRate: 0,
  converted: 0,
  settled: 0,
  conversionRateOfAll: 0,
  revenue: 0,
  unlinked: 0,
  playersConverted: 0,
  notifiedConversionRate: 0,
  notified: 0,
};

const payload = (entries) => ({ entries, conversion: CONVERSION, demand: [], suggestions: [] });

const entry = (over) => ({
  waitlistId: `W-${over.requestedDate}-${over.guestEmail}`,
  guestName: '',
  guestEmail: 'tim@example.com',
  players: 2,
  priority: 1,
  status: 'Waiting',
  open: true,
  preferredTime: '',
  timeFlexibility: '',
  notificationSent: false,
  convertedBookingId: null,
  ...over,
});

// Tim will play any of three days; Maja is a different party on one of them.
const ENTRIES = [
  entry({ requestedDate: '2027-07-24' }),
  entry({ requestedDate: '2027-07-25', guestEmail: 'maja@example.com', players: 8 }),
  entry({ requestedDate: '2027-07-25' }),
  entry({ requestedDate: '2027-07-26' }),
];

function rows() {
  return screen.getAllByRole('row').slice(1);
}

describe('a party that would take several dates', () => {
  test('its entries are kept together and numbered, instead of reading as duplicates', async () => {
    api.waitlist.mockResolvedValue(payload(ENTRIES));
    render(<Waitlist />);
    await screen.findByText('tim@example.com');

    // Tim's three sit together, Maja's between them no longer.
    const dates = rows().map((row) => row.querySelectorAll('td')[1].textContent);
    expect(dates[0]).toContain('date 1 of 3');
    expect(dates[1]).toContain('date 2 of 3');
    expect(dates[2]).toContain('date 3 of 3');
    expect(dates[3]).not.toContain(' of ');

    // The name and address are said once, not three times.
    expect(screen.getAllByText('tim@example.com')).toHaveLength(1);
    expect(screen.getAllByText(/same party, another date/)).toHaveLength(2);
  });

  test('a party sits where its earliest date put it, not at the top for having three', async () => {
    api.waitlist.mockResolvedValue(payload(ENTRIES));
    render(<Waitlist />);
    await screen.findByText('maja@example.com');

    // Tim's earliest is the 24th, so Tim's party comes first; Maja's single
    // entry on the 25th follows, rather than being buried mid-party.
    const first = within(rows()[0]).getByText('tim@example.com');
    expect(first).toBeInTheDocument();
    expect(rows()[3].textContent).toContain('maja@example.com');
  });

  test('every date keeps its own row, because each converts to its own booking', async () => {
    api.waitlist.mockResolvedValue(payload(ENTRIES));
    render(<Waitlist />);
    await screen.findByText('tim@example.com');

    // Four entries in, four rows out: nothing is merged away.
    expect(rows()).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: 'Convert' })).toHaveLength(4);
  });
});
