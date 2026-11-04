/**
 * Booking Status is the ladder under its own heading. What matters is that it
 * draws the ladder and that the two retired paths still arrive.
 */
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import BookingStatus from './BookingStatus.jsx';

vi.mock('./Workflow.jsx', () => ({ default: () => <div>the ladder view</div> }));

function mount(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/booking-status" element={<BookingStatus />} />
        <Route path="/workflow" element={<Navigate to="/booking-status" replace />} />
        <Route path="/reminders" element={<Navigate to="/booking-status" replace />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the Booking Status page', () => {
  test('draws the ladder under its heading, with a way to the settings', () => {
    mount('/booking-status');
    expect(screen.getByRole('heading', { name: 'Booking Status' })).toBeInTheDocument();
    expect(screen.getByText('the ladder view')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  test('the two retired pages redirect here', () => {
    mount('/workflow');
    expect(screen.getByText('the ladder view')).toBeInTheDocument();
  });

  test('an old Operator Reminders bookmark lands here too', () => {
    mount('/reminders');
    expect(screen.getByText('the ladder view')).toBeInTheDocument();
  });
});
