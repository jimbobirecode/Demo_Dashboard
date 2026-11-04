/**
 * Editing a booking from the drawer.
 *
 * What these guard: the form is closed until asked for; a party that grows
 * shows its new total before it is saved, and the server is left to work it
 * out; a total typed by hand is sent as typed; only what changed is sent; and
 * what the server warns about is put in front of the person who saved.
 */
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingDetailsForm from './BookingDetailsForm.jsx';

const booking = {
  bookingId: 'BOOK-20261028-5527FBF6',
  date: '2027-08-26',
  teeTime: '10:20',
  players: 8,
  total: 2600,
  guestName: 'Harris Turer',
  guestEmail: 'timmy.kenna@carrgolf.com',
  contactPhone: '',
  specialRequests: '',
};

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Edit booking' }));
};

describe('editing a booking', () => {
  test('is closed until somebody asks for it', () => {
    render(<BookingDetailsForm booking={booking} onSave={vi.fn()} />);
    expect(screen.queryByLabelText('Players')).not.toBeInTheDocument();
  });

  test('a bigger party shows its new total first, and leaves the sum to the server', async () => {
    const onSave = vi.fn().mockResolvedValue({
      booking: { ...booking, players: 12, total: 3900 },
      repriced: { pricePerPlayer: 325, from: 2600, to: 3900 },
      warnings: [],
    });
    render(<BookingDetailsForm booking={booking} onSave={onSave} />);
    await open();

    const players = screen.getByLabelText('Players');
    await userEvent.clear(players);
    await userEvent.type(players, '12');
    expect(screen.getByLabelText('Total (€)')).toHaveValue(3900);
    expect(screen.getByText(/12 × €325, the price per player it was taken at/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    // Only the party: the total is the server's to work out.
    expect(onSave).toHaveBeenCalledWith({ players: 12 });
    expect(await screen.findByText(/Repriced at €325 a player: €2,600 → €3,900/)).toBeInTheDocument();
  });

  test('a total typed by hand is sent as typed', async () => {
    const onSave = vi.fn().mockResolvedValue({ warnings: [] });
    render(<BookingDetailsForm booking={booking} onSave={onSave} />);
    await open();

    const players = screen.getByLabelText('Players');
    await userEvent.clear(players);
    await userEvent.type(players, '12');
    const total = screen.getByLabelText('Total (€)');
    await userEvent.clear(total);
    await userEvent.type(total, '3600');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSave).toHaveBeenCalledWith({ players: 12, total: 3600 });
  });

  test('a moved date sends only the date, and the warning comes back to whoever saved', async () => {
    const onSave = vi.fn().mockResolvedValue({
      warnings: ['The reminder and arrival emails follow the new date. Any that have already gone are not sent again.'],
    });
    render(<BookingDetailsForm booking={booking} onSave={onSave} />);
    await open();

    const date = screen.getByLabelText('Date');
    await userEvent.clear(date);
    await userEvent.type(date, '2027-08-27');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSave).toHaveBeenCalledWith({ date: '2027-08-27' });
    expect(await screen.findByText(/follow the new date/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('warning');
  });

  test('nothing changed, nothing to save; a refusal is said', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Players must be a whole number from 1 to 200'));
    render(<BookingDetailsForm booking={booking} onSave={onSave} />);
    await open();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Lead guest'), ' Jr');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Players must be a whole number from 1 to 200')).toBeInTheDocument();
  });
});
