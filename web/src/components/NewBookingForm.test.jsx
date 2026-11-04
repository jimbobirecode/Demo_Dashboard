/**
 * Taking a booking by hand.
 *
 * What these guard: the price per player is prefilled from the rate card for
 * the date and the kind of guest, and the total follows it; a price typed by
 * hand stands; what is sent is what a booking needs; and a refusal is said.
 */
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NewBookingForm from './NewBookingForm.jsx';

const operators = [
  { id: 3, name: 'Carr Golf', active: true },
  { id: 4, name: 'Retired Tours', active: false },
];

const mount = (onCreate = vi.fn().mockResolvedValue(undefined)) => {
  render(<NewBookingForm operators={operators} onCreate={onCreate} onClose={vi.fn()} />);
  return onCreate;
};

async function fillDate(value) {
  await userEvent.type(screen.getByLabelText('Date'), value);
}

describe('taking a booking', () => {
  test('a visitor in 2027 is prefilled at €385 a player, an account at €325', async () => {
    mount();
    await fillDate('2027-06-12');
    expect(screen.getByLabelText('Price per player (€)')).toHaveValue(385);
    expect(screen.getByText('€1,540')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Tour operator account'), '3');
    expect(screen.getByLabelText('Price per player (€)')).toHaveValue(325);
    expect(screen.getByText('€1,300')).toBeInTheDocument();
  });

  test('no price, no total -- not a total of nothing', () => {
    mount();
    expect(screen.queryByText('€0')).not.toBeInTheDocument();
    expect(screen.getByText(/Pick a date and the rate card fills in the price/)).toBeInTheDocument();
  });

  test('a retired account is not offered', () => {
    mount();
    expect(screen.queryByRole('option', { name: 'Retired Tours' })).not.toBeInTheDocument();
  });

  test('a price typed by hand stands, and the booking is sent as entered', async () => {
    const onCreate = mount();
    await fillDate('2027-06-12');
    const price = screen.getByLabelText('Price per player (€)');
    await userEvent.clear(price);
    await userEvent.type(price, '300');
    await userEvent.type(screen.getByLabelText('Lead guest'), 'Michael Byrne');
    await userEvent.type(screen.getByLabelText('Phone'), '087 123 4567');
    await userEvent.click(screen.getByRole('button', { name: 'Add booking' }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2027-06-12',
        players: 4,
        pricePerPlayer: 300,
        guestName: 'Michael Byrne',
        contactPhone: '087 123 4567',
        status: 'Booked',
        source: 'phone',
        operatorId: undefined,
      }),
    );
  });

  test('without an email it says no payment link can reach them', () => {
    mount();
    expect(screen.getByText(/no payment link or reminder can reach it/)).toBeInTheDocument();
  });

  test('a refusal from the server is said, and the form stays as typed', async () => {
    mount(vi.fn().mockRejectedValue(new Error('That date has already passed')));
    await fillDate('2027-06-12');
    await userEvent.type(screen.getByLabelText('Lead guest'), 'Michael Byrne');
    await userEvent.click(screen.getByRole('button', { name: 'Add booking' }));
    expect(await screen.findByText('That date has already passed')).toBeInTheDocument();
    expect(screen.getByLabelText('Lead guest')).toHaveValue('Michael Byrne');
  });
});
